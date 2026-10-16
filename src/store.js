// Local SQLite index: content-free request records, quota snapshots, per-file
// read cursors and small metadata. Schema evolution is forward-only.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

export class StoreVersionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StoreVersionError';
    this.code = code;
  }
}

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS files (
    file_key TEXT PRIMARY KEY, dev TEXT, ino TEXT, size INTEGER, mtime_ms REAL,
    offset INTEGER, session_key TEXT, project_key TEXT, agent_type TEXT, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS requests (
    request_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT, api TEXT, model TEXT,
    upstream_provider TEXT, service_tier TEXT, credential_id INTEGER, agent_type TEXT, purpose TEXT,
    session_key TEXT, project_key TEXT, stop_reason TEXT, input INTEGER, output INTEGER,
    cache_read INTEGER, cache_write INTEGER, total_tokens INTEGER, cost_usd REAL,
    duration_ms REAL, ttft_ms REAL
  );
  CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
  CREATE TABLE IF NOT EXISTS snapshots (
    snapshot_key TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL, provider TEXT, account_key TEXT,
    limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS snapshots_series ON snapshots(provider, account_key, limit_id, recorded_at);
`;

// camelCase RequestRecord key -> column, in record order.
const REQUEST_COLUMNS = [
  ['requestKey', 'request_key'],
  ['ts', 'ts'],
  ['provider', 'provider'],
  ['api', 'api'],
  ['model', 'model'],
  ['upstreamProvider', 'upstream_provider'],
  ['serviceTier', 'service_tier'],
  ['credentialId', 'credential_id'],
  ['agentType', 'agent_type'],
  ['purpose', 'purpose'],
  ['sessionKey', 'session_key'],
  ['projectKey', 'project_key'],
  ['stopReason', 'stop_reason'],
  ['input', 'input'],
  ['output', 'output'],
  ['cacheRead', 'cache_read'],
  ['cacheWrite', 'cache_write'],
  ['totalTokens', 'total_tokens'],
  ['costUsd', 'cost_usd'],
  ['durationMs', 'duration_ms'],
  ['ttftMs', 'ttft_ms'],
];
const REQUEST_COLUMN_MAP = new Map(REQUEST_COLUMNS);

const SNAPSHOT_COLUMNS = [
  ['snapshotKey', 'snapshot_key'],
  ['recordedAt', 'recorded_at'],
  ['provider', 'provider'],
  ['accountKey', 'account_key'],
  ['limitId', 'limit_id'],
  ['label', 'label'],
  ['windowLabel', 'window_label'],
  ['usedFraction', 'used_fraction'],
  ['status', 'status'],
  ['resetsAt', 'resets_at'],
];

function selectList(columns) {
  return columns.map(([camel, column]) => `${column} AS ${camel}`).join(', ');
}

function insertSql(table, columns) {
  const names = columns.map(([, column]) => column).join(', ');
  const marks = columns.map(() => '?').join(', ');
  return `INSERT OR IGNORE INTO ${table} (${names}) VALUES (${marks})`;
}

function nullable(value) {
  return value === undefined ? null : value;
}

function plain(row) {
  return row ? { ...row } : row;
}

function prepareFile(file) {
  if (file === ':memory:') return;
  // Create owner-only before SQLite opens it; tighten an existing file too.
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function readSchemaVersion(db) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) return null;
  const version = Number(row.value);
  // Unparseable versions are treated as newer: fail closed, never rewrite.
  return Number.isSafeInteger(version) && version > 0 ? version : Infinity;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failure leaves SQLite's own recovery in charge.
    }
    throw error;
  }
}

/** Opens (creating if needed) the index. Refuses a newer schema. */
export function openStore(file) {
  prepareFile(file);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const version = readSchemaVersion(db);
    if (version !== null && version > SCHEMA_VERSION) throw new StoreVersionError('store_newer');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    transaction(db, () => {
      db.exec(SCHEMA_V1);
      if (version === null) {
        db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      }
    });
  } catch (error) {
    db.close();
    if (error instanceof StoreVersionError) throw error;
    const failure = new Error('store_unavailable');
    failure.code = 'store_unavailable';
    throw failure;
  }
  return createStore(db);
}

function createStore(db) {
  const stmt = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    getCursor: db.prepare(
      `SELECT dev, ino, size, mtime_ms AS mtimeMs, offset, session_key AS sessionKey,
              project_key AS projectKey, agent_type AS agentType FROM files WHERE file_key = ?`,
    ),
    putCursor: db.prepare(
      `INSERT INTO files (file_key, dev, ino, size, mtime_ms, offset, session_key, project_key, agent_type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_key) DO UPDATE SET dev = excluded.dev, ino = excluded.ino, size = excluded.size,
         mtime_ms = excluded.mtime_ms, offset = excluded.offset, session_key = excluded.session_key,
         project_key = excluded.project_key, agent_type = excluded.agent_type, updated_at = excluded.updated_at`,
    ),
    insertRequest: db.prepare(insertSql('requests', REQUEST_COLUMNS)),
    insertSnapshot: db.prepare(insertSql('snapshots', SNAPSHOT_COLUMNS)),
    querySnapshots: db.prepare(
      `SELECT ${selectList(SNAPSHOT_COLUMNS)} FROM snapshots
       WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at, snapshot_key`,
    ),
    countRequests: db.prepare('SELECT count(*) AS n FROM requests'),
    countSnapshots: db.prepare('SELECT count(*) AS n FROM snapshots'),
    countFiles: db.prepare('SELECT count(*) AS n FROM files'),
  };
  const requestQueries = new Map();

  function setMeta(k, v) {
    stmt.setMeta.run(String(k), v === null || v === undefined ? null : String(v));
  }

  return {
    getMeta(k) {
      const row = stmt.getMeta.get(String(k));
      return row ? row.value : null;
    },

    setMeta,

    getCursor(fileKey) {
      return plain(stmt.getCursor.get(fileKey)) ?? null;
    },

    /** Inserts records and moves the file cursor atomically; returns inserted count. */
    commitFile(fileKey, cursor, records = []) {
      return transaction(db, () => {
        let inserted = 0;
        for (const record of records) {
          const values = REQUEST_COLUMNS.map(([camel]) => nullable(record[camel]));
          inserted += Number(stmt.insertRequest.run(...values).changes);
        }
        stmt.putCursor.run(
          fileKey,
          String(cursor.dev),
          String(cursor.ino),
          cursor.size,
          cursor.mtimeMs,
          cursor.offset,
          nullable(cursor.sessionKey),
          nullable(cursor.projectKey),
          nullable(cursor.agentType),
          Date.now(),
        );
        return inserted;
      });
    },

    /** Inserts snapshots and stores the import cursor atomically; returns inserted count. */
    commitSnapshots(metaKey, cursorValue, snaps = []) {
      return transaction(db, () => {
        let inserted = 0;
        for (const snap of snaps) {
          const values = SNAPSHOT_COLUMNS.map(([camel]) => nullable(snap[camel]));
          inserted += Number(stmt.insertSnapshot.run(...values).changes);
        }
        setMeta(metaKey, cursorValue);
        return inserted;
      });
    },

    /** Request rows with ts in [fromMs, toMs), camelCase keys, ordered by ts. */
    queryRequests({ fromMs = 0, toMs = Number.MAX_SAFE_INTEGER, columns } = {}) {
      const wanted = columns === undefined ? REQUEST_COLUMNS.map(([camel]) => camel) : columns;
      const picked = [];
      for (const name of wanted) {
        const column = REQUEST_COLUMN_MAP.get(name);
        if (!column) throw new RangeError('unknown_column');
        picked.push([name, column]);
      }
      if (picked.length === 0) throw new RangeError('unknown_column');
      const sqlKey = picked.map(([name]) => name).join(',');
      let query = requestQueries.get(sqlKey);
      if (!query) {
        query = db.prepare(
          `SELECT ${selectList(picked)} FROM requests WHERE ts >= ? AND ts < ? ORDER BY ts, request_key`,
        );
        requestQueries.set(sqlKey, query);
      }
      return query.all(fromMs, toMs).map(plain);
    },

    /** Snapshots with recordedAt in [fromMs, toMs), ordered by recordedAt. */
    querySnapshots({ fromMs = 0, toMs = Number.MAX_SAFE_INTEGER } = {}) {
      return stmt.querySnapshots.all(fromMs, toMs).map(plain);
    },

    counts() {
      return {
        requests: stmt.countRequests.get().n,
        snapshots: stmt.countSnapshots.get().n,
        files: stmt.countFiles.get().n,
      };
    },

    close() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}
