// Session file discovery and bounded, incremental, replay-safe reading.
//
// Only complete newline-terminated lines are consumed; the cursor is the byte
// offset just past the last complete line. Oversized lines are discarded while
// streaming, never buffered. Raw paths, cwd and session ids are digested before
// they reach the store; the project label lives only in the returned Map.

import fs from 'node:fs';
import path from 'node:path';
import { keyed } from '../secret.js';
import { classifyAgentType, normalizeEntry } from './session-record.js';

const CHUNK_BYTES = 256 * 1024;
const HEADER_PROBE_BYTES = 1024 * 1024;
const COMMIT_BATCH = 5000;
const MAX_DEPTH = 16;
const NEWLINE = 0x0a;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

function abortError() {
  const error = new Error('scan_aborted');
  error.code = 'aborted';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** Regular *.jsonl files under each root, without following symlinks. */
export async function discoverSessionFiles(sessionRoots, { maxFiles = 200000 } = {}) {
  const found = [];
  const seen = new Set();
  for (const rawRoot of [...new Set(sessionRoots ?? [])]) {
    const root = path.resolve(rawRoot);
    try {
      if (!(await fs.promises.lstat(root)).isDirectory()) continue;
    } catch {
      continue;
    }
    const stack = [[root, 0]];
    while (stack.length > 0 && found.length < maxFiles) {
      const [dir, depth] = stack.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirs = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        // Dirent types come from lstat semantics: symlinks are neither.
        if (entry.isDirectory()) {
          if (depth + 1 < MAX_DEPTH) subdirs.push(full);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !seen.has(full)) {
          seen.add(full);
          found.push({ root, path: full, relativeSegments: path.relative(root, full).split(path.sep) });
          if (found.length >= maxFiles) break;
        }
      }
      for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push([subdirs[i], depth + 1]);
    }
    if (found.length >= maxFiles) break;
  }
  return found;
}

function cwdLabel(cwd) {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : cwd;
  return base.slice(0, 128) || null;
}

function parseLine(buffer) {
  if (buffer.length === 0) return undefined;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Reads the first line (bounded) to rebuild the in-memory project label. */
async function recoverLabel(handle, key, labels) {
  const buffer = Buffer.allocUnsafe(HEADER_PROBE_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, HEADER_PROBE_BYTES, 0);
  const end = buffer.subarray(0, bytesRead).indexOf(NEWLINE);
  if (end < 0) return;
  const header = normalizeEntry(parseLine(buffer.subarray(0, end)), { key });
  if (header?.kind !== 'header' || header.cwd === null) return;
  const label = cwdLabel(header.cwd);
  if (label) labels.set(keyed(key, 'project', header.cwd), label);
}

function fileIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    // Microsecond precision keeps the comparison exact across REAL storage.
    mtimeMs: Number(stat.mtimeNs / 1000n) / 1000,
  };
}

async function scanFile({ file, store, key, maxLineBytes, signal, labels, totals }) {
  const fileKey = keyed(key, 'file', file.path);
  const agentType = classifyAgentType(file.relativeSegments);

  let handle;
  try {
    handle = await fs.promises.open(file.path, OPEN_FLAGS);
  } catch {
    return; // Vanished, became a symlink, or unreadable: nothing to record.
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return;
    const identity = fileIdentity(stat);
    const cursor = store.getCursor(fileKey);

    let offset = 0;
    let context = { sessionKey: null, projectKey: null };
    const sameFile = cursor && cursor.dev === identity.dev && cursor.ino === identity.ino;
    if (sameFile && identity.size >= cursor.offset) {
      offset = cursor.offset;
      context = { sessionKey: cursor.sessionKey, projectKey: cursor.projectKey };
      const unchanged = identity.size === cursor.size && identity.mtimeMs === cursor.mtimeMs;
      if ((unchanged || offset > 0) && context.projectKey && !labels.has(context.projectKey)) {
        await recoverLabel(handle, key, labels);
      }
      if (unchanged) return;
    }
    totals.filesRead += 1;

    const cursorAt = (consumed, final) => ({
      dev: identity.dev,
      ino: identity.ino,
      // Intermediate commits record size = consumed so a restart never skips.
      size: final ? identity.size : consumed,
      mtimeMs: identity.mtimeMs,
      offset: consumed,
      sessionKey: context.sessionKey,
      projectKey: context.projectKey,
      agentType,
    });

    let records = [];
    let committed = offset; // byte offset after the last complete line
    let pending = [];
    let pendingBytes = 0;
    let discarding = false;

    const handleLine = (line) => {
      const normalized = normalizeEntry(parseLine(line), {
        key,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        agentType,
      });
      if (!normalized) return;
      if (normalized.kind === 'header') {
        context = {
          sessionKey: keyed(key, 'session', normalized.sessionId),
          projectKey: normalized.cwd === null ? null : keyed(key, 'project', normalized.cwd),
        };
        const label = normalized.cwd === null ? null : cwdLabel(normalized.cwd);
        if (context.projectKey && label) labels.set(context.projectKey, label);
      } else {
        records.push(normalized.record);
      }
    };

    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = offset;
    while (position < identity.size) {
      throwIfAborted(signal);
      const want = Math.min(CHUNK_BYTES, identity.size - position);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(NEWLINE, start);
        const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        const segment = end - start;
        if (!discarding && pendingBytes + segment > maxLineBytes) {
          discarding = true;
          pending = [];
          pendingBytes = 0;
        }
        if (!discarding && segment > 0) {
          // Copy: the read buffer is reused for the next chunk.
          pending.push(Buffer.from(buffer.subarray(start, end)));
          pendingBytes += segment;
        }
        if (end === bytesRead) break; // no newline in the rest of this chunk
        if (discarding) {
          totals.linesSkipped += 1;
        } else {
          handleLine(pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes));
        }
        pending = [];
        pendingBytes = 0;
        discarding = false;
        committed = position + newline + 1;
        start = newline + 1;
        if (records.length >= COMMIT_BATCH) {
          totals.requestsAdded += store.commitFile(fileKey, cursorAt(committed, false), records);
          records = [];
        }
      }
      position += bytesRead;
    }
    totals.requestsAdded += store.commitFile(fileKey, cursorAt(committed, true), records);
  } finally {
    await handle.close();
  }
}

/** Incrementally indexes every discovered session file. */
export async function scanSessions({
  store,
  key,
  sessionRoots,
  maxLineBytes = 32 * 1024 * 1024,
  signal,
  onProgress,
  labels = new Map(),
} = {}) {
  const totals = { filesSeen: 0, filesRead: 0, requestsAdded: 0, linesSkipped: 0 };
  throwIfAborted(signal);
  const files = await discoverSessionFiles(sessionRoots);
  totals.filesSeen = files.length;
  for (const file of files) {
    throwIfAborted(signal);
    await scanFile({ file, store, key, maxLineBytes, signal, labels, totals });
    if (typeof onProgress === 'function') onProgress({ ...totals, filesTotal: files.length });
  }
  return { ...totals, labels };
}
