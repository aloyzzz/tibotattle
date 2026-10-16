import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { discoverSessionFiles, scanSessions } from '../src/omp/session-scanner.js';
import { keyed } from '../src/secret.js';
import { openStore } from '../src/store.js';

const key = Buffer.alloc(32, 9);
const SESSION_ID = 'SESSIONSENTINEL0001';
const CWD = '/synthetic/CWDSENTINEL/project-alpha';
const PROMPT = 'PROMPTSENTINELTEXT';
const PROJECT_DIR = 'PROJDIRSENTINEL';

let tmp;
let root;
let store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-scan-'));
  root = path.join(tmp, 'sessions');
  fs.mkdirSync(path.join(root, PROJECT_DIR), { recursive: true });
  store = openStore(path.join(tmp, 'index.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function header(id = SESSION_ID, cwd = CWD) {
  return `${JSON.stringify({ type: 'session', id, timestamp: '2026-01-01T00:00:00.000Z', cwd })}\n`;
}

function user(n) {
  return `${JSON.stringify({ type: 'message', id: `u${n}`, timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text: `${PROMPT} ${CWD}` }] } })}\n`;
}

function turn(n) {
  return `${JSON.stringify({
    type: 'message',
    id: `a${n}`,
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: PROMPT }],
      api: 'test-api',
      provider: 'prov',
      model: 'model-a',
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
      stopReason: 'stop',
      timestamp: 1767225600000 + n,
      duration: 1000,
      ttft: 100,
    },
  })}\n`;
}

function sessionFile(...parts) {
  const file = path.join(root, PROJECT_DIR, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function scan(extra = {}) {
  return scanSessions({ store, key, sessionRoots: [root], ...extra });
}

test('incremental append counts only new lines', async () => {
  const file = sessionFile('s1.jsonl');
  fs.writeFileSync(file, header() + user(1) + turn(1) + turn(2));
  let out = await scan();
  assert.equal(out.filesSeen, 1);
  assert.equal(out.filesRead, 1);
  assert.equal(out.requestsAdded, 2);

  fs.appendFileSync(file, user(2) + turn(3));
  out = await scan();
  assert.equal(out.requestsAdded, 1);

  out = await scan();
  assert.equal(out.filesRead, 0);
  assert.equal(out.requestsAdded, 0);

  const rows = store.queryRequests({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.sessionKey === keyed(key, 'session', SESSION_ID)));
  assert.ok(rows.every((r) => r.projectKey === keyed(key, 'project', CWD)));
  assert.ok(rows.every((r) => r.agentType === 'main'));
});

test('partial trailing line is not committed until completed', async () => {
  const file = sessionFile('s1.jsonl');
  const line = turn(2);
  fs.writeFileSync(file, header() + turn(1) + line.slice(0, 40));
  let out = await scan();
  assert.equal(out.requestsAdded, 1);
  const cursor = store.getCursor(keyed(key, 'file', file));
  assert.equal(cursor.offset, Buffer.byteLength(header() + turn(1)));

  out = await scan();
  assert.equal(out.requestsAdded, 0);

  fs.appendFileSync(file, line.slice(40));
  out = await scan();
  assert.equal(out.requestsAdded, 1);
  assert.equal(store.counts().requests, 2);
});

test('truncation and replacement re-read without double counting', async () => {
  const file = sessionFile('s1.jsonl');
  fs.writeFileSync(file, header() + turn(1) + turn(2) + turn(3));
  await scan();
  assert.equal(store.counts().requests, 3);

  fs.truncateSync(file, Buffer.byteLength(header() + turn(1)));
  let out = await scan();
  assert.equal(out.filesRead, 1);
  assert.equal(out.requestsAdded, 0);

  const replacement = `${file}.tmp`;
  fs.writeFileSync(replacement, header() + turn(1) + turn(2) + turn(3) + turn(4));
  fs.renameSync(replacement, file);
  out = await scan();
  assert.equal(out.requestsAdded, 1);
  assert.equal(store.counts().requests, 4);
  // Context survives the re-read.
  assert.ok(store.queryRequests({}).every((r) => r.sessionKey === keyed(key, 'session', SESSION_ID)));
});

test('branch copies of the same entry are counted once', async () => {
  fs.writeFileSync(sessionFile('s1.jsonl'), header() + turn(1) + turn(2));
  fs.writeFileSync(sessionFile('s2.jsonl'), header('SESSIONSENTINEL0002') + turn(1) + turn(2) + turn(5));
  const out = await scan();
  assert.equal(out.filesSeen, 2);
  assert.equal(out.requestsAdded, 3);
});

test('oversized lines are skipped without stopping the file', async () => {
  const file = sessionFile('s1.jsonl');
  const huge = `${JSON.stringify({ type: 'custom', id: 'x', data: 'z'.repeat(600 * 1024) })}\n`;
  fs.writeFileSync(file, header() + turn(1) + huge + turn(2) + '{not json\n' + turn(3));
  const out = await scan({ maxLineBytes: 64 * 1024 });
  assert.equal(out.linesSkipped, 1);
  assert.equal(out.requestsAdded, 3);
  assert.equal(store.getCursor(keyed(key, 'file', file)).offset, fs.statSync(file).size);
});

test('oversized unterminated tail is not committed or counted', async () => {
  const file = sessionFile('s1.jsonl');
  fs.writeFileSync(file, header() + turn(1) + 'y'.repeat(4096));
  let out = await scan({ maxLineBytes: 1024 });
  assert.equal(out.linesSkipped, 0);
  assert.equal(out.requestsAdded, 1);
  fs.appendFileSync(file, `\n${turn(2)}`);
  out = await scan({ maxLineBytes: 1024 });
  assert.equal(out.linesSkipped, 1);
  assert.equal(out.requestsAdded, 1);
});

test('agent type follows the file layout', async () => {
  fs.writeFileSync(sessionFile('s1.jsonl'), header() + turn(1));
  fs.writeFileSync(sessionFile('s1', 'task.jsonl'), header('SUB1') + turn(2));
  fs.writeFileSync(sessionFile('s1', '__advisor.jsonl'), header('ADV1') + turn(3));
  fs.writeFileSync(sessionFile('s1', 'task', '__advisor.review.jsonl'), header('ADV2') + turn(4));
  await scan();
  const byTs = new Map(store.queryRequests({}).map((r) => [r.ts - 1767225600000, r.agentType]));
  assert.deepEqual(Object.fromEntries(byTs), { 1: 'main', 2: 'subagent', 3: 'advisor', 4: 'advisor' });
});

test('labels are kept in memory and recovered on resume', async () => {
  const file = sessionFile('s1.jsonl');
  fs.writeFileSync(file, header() + turn(1));
  const projectKey = keyed(key, 'project', CWD);
  let out = await scan();
  assert.equal(out.labels.get(projectKey), 'project-alpha');

  fs.appendFileSync(file, turn(2));
  out = await scan();
  assert.equal(out.labels.get(projectKey), 'project-alpha');
  assert.equal(out.requestsAdded, 1);

  out = await scan();
  assert.equal(out.filesRead, 0);
  assert.equal(out.labels.get(projectKey), 'project-alpha');
});

test('discovery skips symlinks and non-jsonl files', { skip: process.platform === 'win32' }, async () => {
  const real = sessionFile('s1.jsonl');
  fs.writeFileSync(real, header() + turn(1));
  fs.writeFileSync(sessionFile('notes.txt'), 'x');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'o.jsonl'), header('OUT') + turn(9));
  fs.symlinkSync(real, sessionFile('link.jsonl'));
  fs.symlinkSync(outside, path.join(root, PROJECT_DIR, 'linkdir'));
  fs.mkdirSync(sessionFile('dir.jsonl'));

  const files = await discoverSessionFiles([root, root, path.join(tmp, 'missing')]);
  assert.deepEqual(files.map((f) => f.relativeSegments), [[PROJECT_DIR, 's1.jsonl']]);
  const out = await scan();
  assert.equal(out.requestsAdded, 1);
  assert.equal((await discoverSessionFiles([root], { maxFiles: 0 })).length, 0);
});

test('abort signal stops the scan with a fixed code', async () => {
  fs.writeFileSync(sessionFile('s1.jsonl'), header() + turn(1));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scan({ signal: controller.signal }), (error) => error.code === 'aborted');
});

test('no raw path, cwd, session id or content reaches the index file', async () => {
  const file = sessionFile('s1.jsonl');
  fs.writeFileSync(file, header() + user(1) + turn(1));
  fs.writeFileSync(sessionFile('s1', 'task.jsonl'), header() + turn(2));
  await scan();
  fs.appendFileSync(file, user(2) + turn(3));
  await scan();
  store.close();

  const dbFile = path.join(tmp, 'index.db');
  const bytes = Buffer.concat(
    [dbFile, `${dbFile}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)),
  );
  for (const needle of [SESSION_ID, CWD, 'CWDSENTINEL', 'project-alpha', PROMPT, PROJECT_DIR, file, tmp, root]) {
    assert.equal(bytes.includes(Buffer.from(needle)), false, 'raw value found in index');
  }
  store = openStore(dbFile);
  assert.equal(store.counts().requests, 3);
});
