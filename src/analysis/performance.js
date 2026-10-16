// TPS and TTFT statistics over RequestRecord-shaped rows. Pure.
//
// Eligible rows: purpose 'turn', stopReason stop|toolUse|length, output > 0,
// durationMs > 0. Missing duration/TTFT never counts as zero: rows without
// them are ineligible (duration) or excluded from TTFT/decode stats (ttft).
// `timedRequests` counts eligible rows with a known ttftMs.
// `tiers` counts eligible rows per service tier before the tier filter so a
// client can list the available tiers.

import { dayKey } from './period.js';

export const TIER_FILTERS = Object.freeze([
  'all', 'unreported', 'auto', 'default', 'flex', 'scale', 'priority', 'ultrafast',
]);

const ELIGIBLE_STOPS = new Set(['stop', 'toolUse', 'length']);

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isEligible(row) {
  return (
    row.purpose === 'turn' &&
    ELIGIBLE_STOPS.has(row.stopReason) &&
    isNum(row.output) && row.output > 0 &&
    isNum(row.durationMs) && row.durationMs > 0
  );
}

function tierMatches(row, serviceTier) {
  if (serviceTier === 'all') return true;
  if (serviceTier === 'unreported') return row.serviceTier == null;
  return row.serviceTier === serviceTier;
}

/** Linear-interpolation percentile (R-7) of an ascending-sorted array. */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stats(values) {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0, median: null, p25: null, p75: null, mean: null };
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    mean: sum / n,
  };
}

function rowSpeeds(row) {
  const requestTps = row.output / (row.durationMs / 1000);
  let decodeTps = null;
  const ttft = isNum(row.ttftMs) ? row.ttftMs : null;
  if (ttft != null && row.durationMs - ttft >= 100) {
    decodeTps = row.output / ((row.durationMs - ttft) / 1000);
  }
  return { requestTps, decodeTps, ttft };
}

function cmpStr(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function summarizePerformance(rows, { tzOffsetMinutes = 0, serviceTier = 'all' } = {}) {
  if (!TIER_FILTERS.includes(serviceTier)) throw new RangeError('unknown service tier filter');
  const list = Array.isArray(rows) ? rows : Array.from(rows ?? []);

  const tierCounts = new Map();
  const models = new Map();

  for (const row of list) {
    if (!isEligible(row)) continue;
    const tier = row.serviceTier ?? null;
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    if (!tierMatches(row, serviceTier)) continue;

    const id = JSON.stringify([row.provider ?? null, row.model ?? null]);
    let m = models.get(id);
    if (!m) {
      m = {
        provider: row.provider ?? null,
        model: row.model ?? null,
        requests: 0,
        timedRequests: 0,
        decode: [],
        request: [],
        ttft: [],
        days: new Map(),
      };
      models.set(id, m);
    }
    const s = rowSpeeds(row);
    m.requests += 1;
    m.request.push(s.requestTps);
    if (s.ttft != null) {
      m.timedRequests += 1;
      m.ttft.push(s.ttft);
    }
    if (s.decodeTps != null) m.decode.push(s.decodeTps);

    if (isNum(row.ts)) {
      const day = dayKey(row.ts, tzOffsetMinutes);
      let d = m.days.get(day);
      if (!d) {
        d = { n: 0, decode: [], ttft: [] };
        m.days.set(day, d);
      }
      d.n += 1;
      if (s.decodeTps != null) d.decode.push(s.decodeTps);
      if (s.ttft != null) d.ttft.push(s.ttft);
    }
  }

  const outModels = [...models.values()].map((m) => ({
    provider: m.provider,
    model: m.model,
    requests: m.requests,
    timedRequests: m.timedRequests,
    decodeTps: stats(m.decode),
    requestTps: stats(m.request),
    ttftMs: stats(m.ttft),
    daily: [...m.days.keys()].sort().map((day) => {
      const d = m.days.get(day);
      return {
        day,
        decodeTpsMedian: stats(d.decode).median,
        ttftMedian: stats(d.ttft).median,
        n: d.n,
      };
    }),
  }));
  outModels.sort(
    (a, b) => b.requests - a.requests || cmpStr(a.provider, b.provider) || cmpStr(a.model, b.model),
  );

  const tiers = [...tierCounts.entries()]
    .map(([tier, requests]) => ({ serviceTier: tier, requests }))
    .sort((a, b) => {
      if (b.requests !== a.requests) return b.requests - a.requests;
      if (a.serviceTier == null) return 1;
      if (b.serviceTier == null) return -1;
      return cmpStr(a.serviceTier, b.serviceTier);
    });

  return { models: outModels, tiers };
}
