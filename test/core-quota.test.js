import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { importQuotaSnapshots } from '../src/omp/quota-reader.js';
import { keyed } from '../src/secret.js';
import { openStore } from '../src/store.js';

const key = Buffer.alloc(32, 5);
const EMAIL = 'EMAILSENTINEL@example.invalid';
const ACCOUNT_ID = 'ACCOUNTIDSENTINEL';
const ACCOUNT_KEY = 'ACCOUNTKEYSENTINEL';

let tmp;
let agentDb;
let store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-quota-'));
  agentDb = path.join(tmp, 'agent.db');
  store = openStore(path.join(tmp, 'index.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function createAgentDb() {
  const db = new DatabaseSync(agentDb);
  db.exec(`
    CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL, provider TEXT NOT NULL,
      account_key TEXT NOT NULL, email TEXT, account_id TEXT, limit_id TEXT NOT NULL, label TEXT NOT NULL,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER
    );
    CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, secret TEXT);
    INSERT INTO auth_credentials (secret) VALUES ('CREDSENTINEL');
  `);
  return db;
}

const insertSql = `INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id,
  label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function addRows(db, rows) {
  const stmt = db.prepare(insertSql);
  for (const [recordedAt, used, extra = {}] of rows) {
    stmt.run(recordedAt, extra.provider ?? 'prov', ACCOUNT_KEY, EMAIL, ACCOUNT_ID, extra.limitId ?? 'five_hour',
      'Five hour', 'windowLabel' in extra ? extra.windowLabel : '5h', used, extra.status ?? null, extra.resetsAt ?? 9_000_000);
  }
}

function runImport() {
  return importQuotaSnapshots({ store, key, agentDbPaths: [path.join(tmp, 'absent.db'), agentDb] });
}

test('missing database -> missing', () => {
  assert.deepEqual(importQuotaSnapshots({ store, key, agentDbPaths: [path.join(tmp, 'none.db')] }), {
    status: 'missing',
    added: 0,
  });
});

test('database without usage_history -> unavailable', () => {
  const db = new DatabaseSync(agentDb);
  db.exec('CREATE TABLE other (x)');
  db.close();
  assert.deepEqual(runImport(), { status: 'unavailable', added: 0 });
});

test('database missing a column -> unavailable', () => {
  const db = new DatabaseSync(agentDb);
  db.exec('CREATE TABLE usage_history (id INTEGER PRIMARY KEY, recorded_at INTEGER)');
  db.close();
  assert.equal(runImport().status, 'unavailable');
});

test('non-database file -> unavailable without surfacing error text', () => {
  fs.writeFileSync(agentDb, 'not a database at all, just synthetic bytes'.repeat(20));
  assert.deepEqual(runImport(), { status: 'unavailable', added: 0 });
});

test('imports allowlisted fields, digests accounts and is incremental', () => {
  const db = createAgentDb();
  addRows(db, [[1000, 0.1], [2000, 0.2, { status: 'ok' }], [3000, null, { windowLabel: null, provider: 'bad\nname' }]]);
  let out = runImport();
  assert.deepEqual(out, { status: 'ok', added: 3 });

  const snaps = store.querySnapshots({ fromMs: 0, toMs: 10_000 });
  assert.equal(snaps.length, 3);
  assert.deepEqual(snaps[0], {
    snapshotKey: keyed(key, 'snapshot', [1000, 'prov', ACCOUNT_KEY, 'five_hour'].join('\0')),
    recordedAt: 1000,
    provider: 'prov',
    accountKey: keyed(key, 'account', `prov\0${ACCOUNT_KEY}`),
    limitId: 'five_hour',
    label: 'Five hour',
    windowLabel: '5h',
    usedFraction: 0.1,
    status: null,
    resetsAt: 9_000_000,
  });
  assert.equal(snaps[1].status, 'ok');
  assert.equal(snaps[2].usedFraction, null);
  assert.equal(snaps[2].windowLabel, null);
  assert.equal(snaps[2].provider, 'unrecognized');

  out = runImport();
  assert.deepEqual(out, { status: 'ok', added: 0 });

  addRows(db, [[4000, 1.25]]);
  out = runImport();
  assert.deepEqual(out, { status: 'ok', added: 1 });
  assert.equal(store.querySnapshots({ fromMs: 4000, toMs: 4001 })[0].usedFraction, 1.25);
  db.close();
});

test('in-place update of the latest row is picked up', () => {
  const db = createAgentDb();
  addRows(db, [[1000, 0.1], [2000, 0.2]]);
  assert.equal(runImport().added, 2);
  db.prepare('UPDATE usage_history SET recorded_at = 2500, used_fraction = 0.3 WHERE id = 2').run();
  assert.deepEqual(runImport(), { status: 'ok', added: 1 });
  assert.equal(runImport().added, 0);
  db.close();
});

test('cursor resets when max(id) drops below it', () => {
  let db = createAgentDb();
  addRows(db, [[1000, 0.1], [2000, 0.2], [3000, 0.3]]);
  assert.equal(runImport().added, 3);
  db.close();
  fs.rmSync(agentDb);

  db = createAgentDb();
  addRows(db, [[5000, 0.5]]);
  assert.deepEqual(runImport(), { status: 'ok', added: 1 });
  assert.equal(store.counts().snapshots, 4);
  db.close();
});

test('imports in batches beyond 5000 rows', () => {
  const db = createAgentDb();
  db.exec('BEGIN');
  addRows(db, Array.from({ length: 5003 }, (_, i) => [10_000 + i, i / 10_000]));
  db.exec('COMMIT');
  assert.deepEqual(runImport(), { status: 'ok', added: 5003 });
  assert.equal(runImport().added, 0);
  db.close();
});

test('email, account id, account key and other tables never reach the index', () => {
  const db = createAgentDb();
  addRows(db, [[1000, 0.1], [2000, 0.2]]);
  db.close();
  runImport();
  store.close();
  const dbFile = path.join(tmp, 'index.db');
  const bytes = Buffer.concat(
    [dbFile, `${dbFile}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)),
  );
  for (const needle of [EMAIL, ACCOUNT_ID, ACCOUNT_KEY, 'CREDSENTINEL', agentDb, tmp]) {
    assert.equal(bytes.includes(Buffer.from(needle)), false, 'raw value found in index');
  }
  store = openStore(dbFile);
  assert.equal(store.counts().snapshots, 2);
});

test('agent.db is opened read-only and left unchanged', () => {
  const db = createAgentDb();
  addRows(db, [[1000, 0.1]]);
  db.close();
  const before = fs.readFileSync(agentDb);
  runImport();
  assert.deepEqual(fs.readFileSync(agentDb), before);
});
