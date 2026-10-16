// Reporting periods and day bucketing. Pure, no I/O.

export const PERIODS = Object.freeze(['24h', '7d', '30d', 'all']);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SPANS = Object.freeze({
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
});

/**
 * Resolve a named period relative to `nowMs`.
 * The range is half-open [fromMs, toMs); toMs is `nowMs + 1` so a row stamped
 * exactly at `nowMs` is included. 'all' starts at 0.
 */
export function resolvePeriod(name, nowMs) {
  if (!PERIODS.includes(name)) throw new RangeError('unknown period');
  if (!Number.isFinite(nowMs)) throw new RangeError('invalid nowMs');
  const toMs = Math.floor(nowMs) + 1;
  const fromMs = name === 'all' ? 0 : Math.max(0, Math.floor(nowMs) - SPANS[name]);
  return { name, fromMs, toMs };
}

/**
 * 'YYYY-MM-DD' for `ts` in a zone `tzOffsetMinutes` east of UTC
 * (i.e. pass `-new Date().getTimezoneOffset()`).
 */
export function dayKey(ts, tzOffsetMinutes = 0) {
  if (!Number.isFinite(ts)) throw new RangeError('invalid ts');
  const offset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  return new Date(ts + offset * 60 * 1000).toISOString().slice(0, 10);
}
