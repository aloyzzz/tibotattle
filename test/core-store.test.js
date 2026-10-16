import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { openStore, StoreVersionError } from '../src/store.js';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-store-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function record(n, extra = {}) {
  return {
    requestKey: `rk${n}`, ts: 1000 + n, provider: 'p', api: 'a', model: 'm', upstreamProvider: null,
    serviceTier: null, credentialId: null, agentType: 'main', purpose: 'turn', sessionKey: 's',
    projectKey: null, stopReason: 'stop', input: 1, output: 2, cacheRead: null, cacheWrite: null,
    totalTokens: 3, costUsd: null, durationMs: 10, ttftMs: null, ...extra,
  };
}

const cursor = { dev: '1', ino: '2', size: 10, mtimeMs: 5.5, offset: 10, sessionKey: 's', projectKey: null, agentType: 'main' };

test('fresh store, file mode, commit and query round trip', () => {
  const file = path.join(tmp, 'index.db');
  const store = openStore(file);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.getMeta('schema_version'), '1');
  assert.equal(store.getCursor('f'), null);
  assert.equal(store.commitFile('f', cursor, [record(1), record(2)]), 2);
  assert.equal(store.commitFile('f', cursor, [record(1), record(3)]), 1);
  assert.deepEqual(store.getCursor('f'), cursor);
  const rows = store.queryRequests({ fromMs: 1002, toMs: 1003 });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], record(2));
  assert.deepEqual(store.queryRequests({ fromMs: 0, toMs: 2000, columns: ['ts', 'output'] })[0], { ts: 1001, output: 2 });
  assert.throws(() => store.queryRequests({ columns: ['nope'] }), RangeError);
  assert.deepEqual(store.counts(), { requests: 3, snapshots: 0, files: 1 });
  store.close();
  store.close();
});

test('snapshots commit with their cursor and dedupe', () => {
  const store = openStore(':memory:');
  const snap = (k, t) => ({ snapshotKey: k, recordedAt: t, provider: 'p', accountKey: 'a', limitId: 'l',
    label: 'L', windowLabel: null, usedFraction: 0.5, status: null, resetsAt: null });
  assert.equal(store.commitSnapshots('qc', '7', [snap('b', 20), snap('a', 10)]), 2);
  assert.equal(store.commitSnapshots('qc', '8', [snap('a', 10)]), 0);
  assert.equal(store.getMeta('qc'), '8');
  assert.deepEqual(store.querySnapshots({ fromMs: 0, toMs: 100 }).map((s) => s.recordedAt), [10, 20]);
  assert.deepEqual(store.querySnapshots({ fromMs: 15, toMs: 100 })[0], snap('b', 20));
  store.close();
});

test('failed commit leaves neither records nor cursor', () => {
  const store = openStore(':memory:');
  assert.throws(() => store.commitFile('f', cursor, [record(1), record(2, { ts: {} })]));
  assert.equal(store.getCursor('f'), null);
  assert.equal(store.counts().requests, 0);
  store.close();
});

test('reopen keeps data; newer schema is refused without modification', () => {
  const file = path.join(tmp, 'reopen.db');
  const store = openStore(file);
  store.commitFile('f', cursor, [record(1)]);
  store.close();
  const again = openStore(file);
  assert.equal(again.counts().requests, 1);
  again.close();

  const raw = new DatabaseSync(file);
  raw.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  raw.close();
  assert.throws(() => openStore(file), (error) => error instanceof StoreVersionError && error.code === 'store_newer');
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
  assert.equal(check.prepare('SELECT count(*) AS n FROM requests').get().n, 1);
  check.close();
});
