import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createMonitor } from '../src/monitor.js';

const fakeStore = { counts: () => ({ requests: 1, snapshots: 2, files: 3 }) };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function scanResult(requestsAdded = 0, labels = new Map()) {
  return { filesSeen: 1, filesRead: 1, requestsAdded, linesSkipped: 0, labels };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('refresh is single-flight with exactly one queued follow-up', async () => {
  let calls = 0;
  const gates = [];
  const scan = () => {
    calls += 1;
    const d = deferred();
    gates.push(d);
    return d.promise;
  };
  const importQuota = async () => ({ status: 'ok', added: 0 });
  const m = createMonitor({ store: fakeStore, key: Buffer.alloc(32), sources: {}, scan, importQuota });

  const p1 = m.refresh({ reason: 'a' });
  const p2 = m.refresh({ reason: 'b' });
  const p3 = m.refresh({ reason: 'c' });
  assert.notEqual(p1, p2);
  assert.equal(p2, p3);
  assert.equal(m.status().refreshing, true);
  await wait(0);
  assert.equal(calls, 1);
  gates[0].resolve(scanResult(0));
  await p1;
  await wait(0);
  assert.equal(calls, 2);
  gates[1].resolve(scanResult(2));
  const r = await p2;
  assert.equal(calls, 2);
  assert.equal(r.generation, 1);
  assert.equal(m.status().refreshing, false);
});

test('change emitted only when rows were added; labels merged in memory', async () => {
  const results = [
    [scanResult(0, new Map([['pk1', 'alpha']])), { status: 'ok', added: 0 }],
    [scanResult(0), { status: 'ok', added: 3 }],
    [scanResult(4), { status: 'missing', added: 0 }],
  ];
  let i = 0;
  let current;
  const scan = async () => {
    current = results[i++];
    return current[0];
  };
  const importQuota = async () => current[1];
  const m = createMonitor({ store: fakeStore, key: Buffer.alloc(32), sources: {}, scan, importQuota });
  const events = [];
  m.on('change', (e) => events.push(e));

  const r1 = await m.refresh();
  assert.equal(r1.generation, 0);
  assert.deepEqual(events, []);
  assert.equal(m.labels.get('pk1'), 'alpha');
  assert.deepEqual(r1.sessions, { filesSeen: 1, filesRead: 1, requestsAdded: 0, linesSkipped: 0 });
  assert.deepEqual(r1.quota, { status: 'ok', added: 0 });

  await m.refresh();
  await m.refresh();
  assert.deepEqual(events, [{ generation: 1 }, { generation: 2 }]);
  assert.equal(m.status().sources.agentDb, 'missing');
});

test('status shape and fixed error codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mon-'));
  try {
    const scan = async () => {
      throw new Error('secret /private/path detail');
    };
    const importQuota = async () => {
      throw new Error('another secret');
    };
    const m = createMonitor({
      store: fakeStore,
      key: Buffer.alloc(32),
      sources: { sessionRoots: [dir, path.join(dir, 'nope')], agentDbPaths: [path.join(dir, 'agent.db')] },
      scan,
      importQuota,
    });
    const before = m.status();
    assert.equal(before.agentDb, undefined);
    assert.equal(before.sources.agentDb, null);
    assert.equal(before.lastRefreshAt, null);
    const r = await m.refresh();
    assert.equal(r.sessions, null);
    assert.equal(r.quota, null);
    const s = m.status();
    assert.deepEqual(Object.keys(s).sort(), ['counts', 'generation', 'lastError', 'lastRefreshAt', 'refreshing', 'sources']);
    assert.equal(s.lastError, 'scan_failed');
    assert.deepEqual(s.sources.sessionRoots, [{ status: 'readable' }, { status: 'missing' }]);
    assert.equal(s.sources.agentDb, 'unavailable');
    assert.deepEqual(s.counts, { requests: 1, snapshots: 2, files: 3 });
    assert.equal(JSON.stringify(s).includes('secret'), false);
    assert.equal(JSON.stringify(s).includes(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch events are debounced into one refresh; stop clears everything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mon-'));
  try {
    const watchers = [];
    const watch = (target, options, listener) => {
      const w = new EventEmitter();
      w.closed = false;
      w.close = () => {
        w.closed = true;
      };
      w.fire = () => listener('change', 'x.jsonl');
      watchers.push(w);
      return w;
    };
    let calls = 0;
    const scan = async () => {
      calls += 1;
      return scanResult(0);
    };
    const importQuota = async () => ({ status: 'missing', added: 0 });
    const m = createMonitor({
      store: fakeStore,
      key: Buffer.alloc(32),
      sources: { sessionRoots: [dir], agentDbPaths: [path.join(dir, 'agent.db')] },
      pollMs: 60 * 60 * 1000,
      debounceMs: 30,
      scan,
      importQuota,
      watch,
    });
    await m.start();
    assert.equal(calls, 1);
    assert.equal(watchers.length, 2);
    for (let i = 0; i < 5; i += 1) watchers[0].fire();
    await wait(80);
    assert.equal(calls, 2);

    watchers[0].fire();
    m.stop();
    await wait(80);
    assert.equal(calls, 2);
    assert.ok(watchers.every((w) => w.closed));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch failures fall back silently to polling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mon-'));
  try {
    const watch = () => {
      throw Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' });
    };
    let calls = 0;
    const m = createMonitor({
      store: fakeStore,
      key: Buffer.alloc(32),
      sources: { sessionRoots: [dir], agentDbPaths: [] },
      pollMs: 20,
      scan: async () => {
        calls += 1;
        return scanResult(0);
      },
      importQuota: async () => ({ status: 'missing', added: 0 }),
      watch,
    });
    await m.start();
    await wait(90);
    m.stop();
    const after = calls;
    assert.ok(after >= 3, `expected polling refreshes, got ${after}`);
    await wait(60);
    assert.equal(calls, after);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher error events are swallowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mon-'));
  try {
    let w;
    const watch = () => {
      w = new EventEmitter();
      w.close = () => {};
      return w;
    };
    const m = createMonitor({
      store: fakeStore,
      key: Buffer.alloc(32),
      sources: { sessionRoots: [dir] },
      pollMs: 60 * 60 * 1000,
      scan: async () => scanResult(0),
      importQuota: async () => ({ status: 'missing', added: 0 }),
      watch,
    });
    await m.start();
    w.emit('error', new Error('boom'));
    m.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
