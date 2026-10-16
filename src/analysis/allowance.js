// Current allowance per (provider, accountKey, limitId) series and a pace
// forecast. Pure.
//
// - The latest snapshot (by recordedAt, tie-broken by snapshotKey) is current.
// - A reset is a drop of usedFraction by more than RESET_DROP between
//   consecutive known values, or a change of a known resetsAt by more than
//   RESETS_AT_TOLERANCE_MS (absorbs sub-minute jitter in provider timestamps).
// - Pace uses known usedFraction points since the latest reset; it needs at
//   least 2 points spanning >= 20 minutes and a positive increase, and is null
//   for stale series. Unknown values are never treated as 0.
// - history covers the last 30 days before nowMs and is capped at
//   HISTORY_MAX_POINTS by equal-width time buckets, keeping the max per bucket.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const RESET_DROP = 0.05;
export const RESETS_AT_TOLERANCE_MS = 60 * 1000;
export const MIN_PACE_SPAN_MS = 20 * 60 * 1000;
export const HISTORY_WINDOW_MS = 30 * DAY_MS;
export const HISTORY_MAX_POINTS = 400;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function cmpStr(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function bySnapshotOrder(a, b) {
  return a.recordedAt - b.recordedAt || cmpStr(a.snapshotKey, b.snapshotKey);
}

function isReset(prev, cur) {
  if (isNum(prev.usedFraction) && isNum(cur.usedFraction) &&
      prev.usedFraction - cur.usedFraction > RESET_DROP) return true;
  if (isNum(prev.resetsAt) && isNum(cur.resetsAt) &&
      Math.abs(cur.resetsAt - prev.resetsAt) > RESETS_AT_TOLERANCE_MS) return true;
  return false;
}

function computePace(sorted, latest) {
  let start = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (isReset(sorted[i - 1], sorted[i])) start = i;
  }
  const basis = sorted.slice(start).filter((s) => isNum(s.usedFraction));
  if (basis.length < 2) return null;
  const first = basis[0];
  const last = basis[basis.length - 1];
  const spanMs = last.recordedAt - first.recordedAt;
  if (spanMs < MIN_PACE_SPAN_MS) return null;
  const increase = last.usedFraction - first.usedFraction;
  if (!(increase > 0)) return null;
  const ratePerHour = increase / (spanMs / HOUR_MS);
  const remaining = 1 - last.usedFraction;
  const projectedExhaustAt = remaining <= 0
    ? last.recordedAt
    : Math.round(last.recordedAt + (remaining / ratePerHour) * HOUR_MS);
  const resetsAt = isNum(latest.resetsAt) ? latest.resetsAt : null;
  return {
    ratePerHour,
    projectedExhaustAt,
    exhaustsBeforeReset: resetsAt == null ? null : projectedExhaustAt < resetsAt,
    basisStartAt: first.recordedAt,
    basisPoints: basis.length,
  };
}

function buildHistory(sorted, nowMs) {
  const from = nowMs - HISTORY_WINDOW_MS;
  const points = sorted
    .filter((s) => s.recordedAt >= from && s.recordedAt <= nowMs && isNum(s.usedFraction))
    .map((s) => ({ t: s.recordedAt, used: s.usedFraction }));
  if (points.length <= HISTORY_MAX_POINTS) return points;
  const t0 = points[0].t;
  const span = points[points.length - 1].t - t0 + 1;
  const buckets = new Array(HISTORY_MAX_POINTS).fill(null);
  for (const p of points) {
    const idx = Math.min(HISTORY_MAX_POINTS - 1, Math.floor(((p.t - t0) / span) * HISTORY_MAX_POINTS));
    const cur = buckets[idx];
    if (cur == null || p.used > cur.used) buckets[idx] = p;
  }
  return buckets.filter((b) => b != null);
}

export function summarizeAllowance(snapshots, { nowMs, staleAfterMs = 30 * 60 * 1000 } = {}) {
  if (!isNum(nowMs)) throw new RangeError('nowMs required');
  const list = Array.isArray(snapshots) ? snapshots : Array.from(snapshots ?? []);
  const groups = new Map();
  for (const s of list) {
    if (!s || !isNum(s.recordedAt)) continue;
    const id = JSON.stringify([s.provider ?? null, s.accountKey ?? null, s.limitId ?? null]);
    let g = groups.get(id);
    if (!g) {
      g = [];
      groups.set(id, g);
    }
    g.push(s);
  }

  const series = [];
  for (const group of groups.values()) {
    const sorted = group.slice().sort(bySnapshotOrder);
    const latest = sorted[sorted.length - 1];
    const used = isNum(latest.usedFraction) ? latest.usedFraction : null;
    const ageMs = nowMs - latest.recordedAt;
    const stale = ageMs > staleAfterMs;
    const accountKey = latest.accountKey ?? null;
    series.push({
      provider: latest.provider ?? null,
      accountKey,
      accountLabel: `${latest.provider ?? 'unknown'} account ${String(accountKey ?? '').slice(0, 6)}`,
      limitId: latest.limitId ?? null,
      label: latest.label ?? null,
      windowLabel: latest.windowLabel ?? null,
      usedFraction: used,
      remainingFraction: used == null ? null : Math.max(0, 1 - used),
      status: latest.status ?? null,
      resetsAt: isNum(latest.resetsAt) ? latest.resetsAt : null,
      recordedAt: latest.recordedAt,
      ageMs,
      stale,
      pace: stale ? null : computePace(sorted, latest),
      history: buildHistory(sorted, nowMs),
    });
  }

  series.sort(
    (a, b) =>
      cmpStr(a.provider, b.provider) ||
      cmpStr(a.accountLabel, b.accountLabel) ||
      cmpStr(a.label, b.label) ||
      cmpStr(a.limitId, b.limitId) ||
      cmpStr(a.accountKey, b.accountKey),
  );
  return series;
}
