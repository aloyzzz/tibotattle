// Read-only, incremental import of omp's recorded subscription usage
// (`usage_history` in agent.db). Only allowlisted columns are selected; email,
// account_id and every other table are never read. Account keys are digested.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { keyed } from '../secret.js';
import { vocab } from './session-record.js';

const BATCH = 5000;
const COLUMNS = [
  'id',
  'recorded_at',
  'provider',
  'account_key',
  'limit_id',
  'label',
  'window_label',
  'used_fraction',
  'status',
  'resets_at',
];

function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function msInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

// Cursor: last imported id plus the newest recorded_at seen. omp rewrites the
// latest row of a series in place (bumping recorded_at), so rows at or below
// the id cursor with a newer recorded_at are re-read; snapshot keys dedupe.
function parseCursor(value) {
  if (value === null || value === undefined) return { id: 0, recordedAt: -1 };
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0) {
      return { id: parsed, recordedAt: -1 };
    }
    if (Number.isSafeInteger(parsed?.id) && parsed.id >= 0 && Number.isFinite(parsed?.recordedAt)) {
      return { id: parsed.id, recordedAt: parsed.recordedAt };
    }
  } catch {
    // Fall through to a full, replay-safe re-import.
  }
  return { id: 0, recordedAt: -1 };
}

function toSnapshot(key, row) {
  const recordedAt = msInteger(row.recorded_at);
  if (recordedAt === null) return null;
  if (typeof row.provider !== 'string' || typeof row.account_key !== 'string') return null;
  if (typeof row.limit_id !== 'string') return null;
  const used = row.used_fraction;
  return {
    snapshotKey: keyed(key, 'snapshot', [row.recorded_at, row.provider, row.account_key, row.limit_id].join('\0')),
    recordedAt,
    provider: vocab(row.provider),
    accountKey: keyed(key, 'account', `${row.provider}\0${row.account_key}`),
    limitId: vocab(row.limit_id),
    label: vocab(row.label),
    windowLabel: vocab(row.window_label),
    usedFraction: typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null,
    status: vocab(row.status),
    resetsAt: msInteger(row.resets_at),
  };
}

function hasRequiredColumns(db) {
  const present = new Set(db.prepare('PRAGMA table_info(usage_history)').all().map((c) => c.name));
  return COLUMNS.every((name) => present.has(name));
}

/** Imports new usage_history rows from the first existing agent.db. */
export function importQuotaSnapshots({ store, key, agentDbPaths }) {
  const dbPath = (agentDbPaths ?? []).find(isRegularFile);
  if (!dbPath) return { status: 'missing', added: 0 };

  const metaKey = `quota_cursor:${keyed(key, 'db', dbPath)}`;
  let db;
  let added = 0;
  let storeFailure = null;
  const commit = (value, snaps) => {
    try {
      return store.commitSnapshots(metaKey, value, snaps);
    } catch (error) {
      storeFailure = error;
      throw error;
    }
  };
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    if (!hasRequiredColumns(db)) return { status: 'unavailable', added: 0 };

    let cursor = parseCursor(store.getMeta(metaKey));
    const maxId = db.prepare('SELECT max(id) AS maxId FROM usage_history').get().maxId ?? 0;
    if (maxId < cursor.id) cursor = { id: 0, recordedAt: -1 };

    const select = db.prepare(
      `SELECT ${COLUMNS.join(', ')} FROM usage_history
       WHERE id > ? AND (id > ? OR recorded_at > ?) ORDER BY id LIMIT ${BATCH}`,
    );
    let after = cursor.id > 0 && cursor.recordedAt >= 0 ? 0 : cursor.id;
    let lastId = cursor.id;
    let newestRecordedAt = cursor.recordedAt;
    for (;;) {
      const rows = select.all(after, cursor.id, cursor.recordedAt);
      if (rows.length === 0) break;
      const snaps = [];
      for (const row of rows) {
        after = row.id;
        if (row.id > lastId) lastId = row.id;
        if (typeof row.recorded_at === 'number' && row.recorded_at > newestRecordedAt) {
          newestRecordedAt = row.recorded_at;
        }
        const snap = toSnapshot(key, row);
        if (snap) snaps.push(snap);
      }
      // Intermediate batches advance only the id; the recorded_at watermark
      // moves once the whole pass is done so no rewritten row is skipped.
      added += commit(JSON.stringify({ id: lastId, recordedAt: cursor.recordedAt }), snaps);
      if (rows.length < BATCH) break;
    }
    if (newestRecordedAt !== cursor.recordedAt || lastId !== cursor.id) {
      commit(JSON.stringify({ id: lastId, recordedAt: newestRecordedAt }), []);
    }
    return { status: 'ok', added };
  } catch (error) {
    // Index failures are the caller's concern; source errors are not surfaced.
    if (storeFailure) throw storeFailure;
    return { status: 'unavailable', added };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures on a read-only handle.
    }
  }
}
