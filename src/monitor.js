// Refresh orchestration, file watching and change events.
//
// - refresh() is single-flight: while a run is in progress, every further call
//   shares one queued follow-up run (at most one), so bursts collapse.
// - `generation` is a data version: it increments only when a refresh added
//   rows (requests or snapshots), and only then is 'change' emitted.
// - lastError is a fixed code string, never an error message.
// - Watching is best-effort: fs.watch failures (creation or 'error' events)
//   are swallowed and polling continues to cover the sources.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// Defaults load lazily (literal specifiers) so the monitor can be composed and
// tested with injected scanners independently of the omp readers.
async function defaultScan(options) {
  const { scanSessions } = await import('./omp/session-scanner.js');
  return scanSessions(options);
}

async function defaultImportQuota(options) {
  const { importQuotaSnapshots } = await import('./omp/quota-reader.js');
  return importQuotaSnapshots(options);
}

function errorCode(err, fallback) {
  if (err && err.name === 'AbortError') return 'aborted';
  if (err && err.code === 'store_newer') return 'store_newer';
  return fallback;
}

function rootStatus(root) {
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) return 'missing';
    fs.accessSync(root, fs.constants.R_OK);
    return 'readable';
  } catch {
    return 'missing';
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function createMonitor({
  store,
  key,
  sources = {},
  pollMs = 5000,
  debounceMs = 750,
  scan = defaultScan,
  importQuota = defaultImportQuota,
  watch = fs.watch,
} = {}) {
  const sessionRoots = Array.isArray(sources.sessionRoots) ? sources.sessionRoots.slice() : [];
  const agentDbPaths = Array.isArray(sources.agentDbPaths) ? sources.agentDbPaths.slice() : [];

  const emitter = new EventEmitter();
  const labels = new Map();

  let generation = 0;
  let lastRefreshAt = null;
  let lastError = null;
  let agentDbStatus = null; // unknown until the first quota import
  let lastResult = null;

  let inflight = null;
  let queued = null;
  let controller = null;

  let started = false;
  let pollTimer = null;
  let debounceTimer = null;
  let watchers = [];

  async function runOnce() {
    controller = new AbortController();
    const { signal } = controller;
    let errorCodeThisRun = null;

    let sessions = null;
    try {
      const res = await scan({ store, key, sessionRoots, signal });
      sessions = {
        filesSeen: res?.filesSeen ?? 0,
        filesRead: res?.filesRead ?? 0,
        requestsAdded: res?.requestsAdded ?? 0,
        linesSkipped: res?.linesSkipped ?? 0,
      };
      if (res?.labels && typeof res.labels.forEach === 'function') {
        res.labels.forEach((label, projectKey) => labels.set(projectKey, label));
      }
    } catch (err) {
      errorCodeThisRun = errorCode(err, 'scan_failed');
    }

    let quota = null;
    if (!signal.aborted) {
      try {
        const res = await importQuota({ store, key, agentDbPaths });
        const status = ['ok', 'missing', 'unavailable'].includes(res?.status) ? res.status : 'unavailable';
        quota = { status, added: res?.added ?? 0 };
        agentDbStatus = status;
      } catch (err) {
        agentDbStatus = 'unavailable';
        errorCodeThisRun ??= errorCode(err, 'quota_failed');
      }
    } else {
      errorCodeThisRun ??= 'aborted';
    }

    const added = (sessions?.requestsAdded ?? 0) + (quota?.added ?? 0);
    if (added > 0) generation += 1;
    lastRefreshAt = Date.now();
    lastError = errorCodeThisRun;
    lastResult = { generation, at: lastRefreshAt, sessions, quota };
    if (added > 0) emitter.emit('change', { generation });
    return lastResult;
  }

  function refresh({ reason } = {}) {
    void reason;
    if (!inflight) {
      inflight = runOnce().finally(() => {
        inflight = null;
        controller = null;
      });
      return inflight;
    }
    if (!queued) {
      queued = inflight
        .catch(() => {})
        .then(() => {
          queued = null;
          return refresh({ reason: 'queued' });
        });
    }
    return queued;
  }

  function background(reason) {
    refresh({ reason }).catch(() => {});
  }

  function onWatchEvent() {
    if (!started) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (started) background('watch');
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function addWatcher(target, options, filter) {
    try {
      const w = watch(target, options, (_event, filename) => {
        if (filter && !filter(filename)) return;
        onWatchEvent();
      });
      w.on?.('error', () => {
        try { w.close(); } catch { /* ignore */ }
        watchers = watchers.filter((x) => x !== w);
      });
      w.unref?.();
      watchers.push(w);
    } catch {
      // Watching is optional; polling covers this source.
    }
  }

  function start() {
    if (started) return refresh({ reason: 'start' });
    started = true;
    for (const root of sessionRoots) {
      if (rootStatus(root) === 'readable') addWatcher(root, { recursive: true, persistent: false });
    }
    const dbDirs = new Set();
    for (const dbPath of agentDbPaths) {
      const dir = path.dirname(dbPath);
      if (exists(dir)) dbDirs.add(dir);
    }
    const dbNames = new Set(agentDbPaths.map((p) => path.basename(p)));
    for (const dir of dbDirs) {
      addWatcher(dir, { persistent: false }, (filename) => {
        if (filename == null) return true;
        const name = String(filename);
        for (const base of dbNames) if (name.startsWith(base)) return true;
        return false;
      });
    }
    pollTimer = setInterval(() => background('poll'), pollMs);
    pollTimer.unref?.();
    return refresh({ reason: 'start' });
  }

  function stop() {
    started = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers = [];
    controller?.abort();
  }

  function status() {
    let counts = null;
    try {
      counts = store?.counts?.() ?? null;
    } catch {
      counts = null;
    }
    return {
      generation,
      lastRefreshAt,
      lastError,
      refreshing: inflight != null,
      sources: {
        sessionRoots: sessionRoots.map((root) => ({ status: rootStatus(root) })),
        agentDb: agentDbStatus,
      },
      counts,
    };
  }

  return Object.assign(emitter, {
    refresh,
    start,
    stop,
    status,
    labels,
  });
}
