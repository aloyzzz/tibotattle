// Token, cost and request aggregates over RequestRecord-shaped rows. Pure.
//
// Missing evidence semantics:
// - `requests` counts every row, including rows whose token buckets are null.
// - A token bucket (input, output, cacheRead, cacheWrite, totalTokens) sums
//   only rows where that bucket is known. If no row in the group knows the
//   bucket, the sum is `null` (unknown), never 0. `unknownTokenRequests`
//   counts rows whose `totalTokens` is null so partial sums stay visible.
// - `costUsd` sums priced rows only (`costUsd` non-null) and is `null` when
//   the group has no priced row. `unpricedRequests` counts the rest.
// - `cacheHitRate` = cacheRead / (input + cacheRead) over rows where both
//   input and cacheRead are known; `null` when that denominator is 0 or absent.

import { dayKey } from './period.js';

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function newAcc() {
  return {
    requests: 0,
    sessionSet: new Set(),
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    totalTokens: null,
    costUsd: null,
    pricedRequests: 0,
    unpricedRequests: 0,
    errorRequests: 0,
    unknownTokenRequests: 0,
    hitNum: 0,
    hitDen: 0,
  };
}

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];

function add(acc, row) {
  acc.requests += 1;
  if (row.sessionKey != null) acc.sessionSet.add(row.sessionKey);
  for (const k of TOKEN_KEYS) {
    if (isNum(row[k])) acc[k] = (acc[k] ?? 0) + row[k];
  }
  if (!isNum(row.totalTokens)) acc.unknownTokenRequests += 1;
  if (isNum(row.costUsd)) {
    acc.costUsd = (acc.costUsd ?? 0) + row.costUsd;
    acc.pricedRequests += 1;
  } else {
    acc.unpricedRequests += 1;
  }
  if (row.stopReason === 'error') acc.errorRequests += 1;
  if (isNum(row.input) && isNum(row.cacheRead)) {
    acc.hitNum += row.cacheRead;
    acc.hitDen += row.input + row.cacheRead;
  }
}

function finish(acc) {
  return {
    requests: acc.requests,
    sessions: acc.sessionSet.size,
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    totalTokens: acc.totalTokens,
    costUsd: acc.costUsd,
    pricedRequests: acc.pricedRequests,
    unpricedRequests: acc.unpricedRequests,
    errorRequests: acc.errorRequests,
    unknownTokenRequests: acc.unknownTokenRequests,
    cacheHitRate: acc.hitDen > 0 ? acc.hitNum / acc.hitDen : null,
  };
}

// Null-safe ascending comparison; nulls sort last.
function cmpNullable(a, b) {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// totalTokens desc (null last), then requests desc, then dimension keys asc.
function byTotalsDesc(dimKeys) {
  return (a, b) => {
    if (a.totalTokens !== b.totalTokens) {
      if (a.totalTokens == null) return 1;
      if (b.totalTokens == null) return -1;
      return b.totalTokens - a.totalTokens;
    }
    if (a.requests !== b.requests) return b.requests - a.requests;
    for (const k of dimKeys) {
      const c = cmpNullable(a[k], b[k]);
      if (c !== 0) return c;
    }
    return 0;
  };
}

function groupBy(rows, dimKeys, decorate) {
  const groups = new Map();
  for (const row of rows) {
    const dims = dimKeys.map((k) => row[k] ?? null);
    const id = JSON.stringify(dims);
    let g = groups.get(id);
    if (!g) {
      g = { dims, acc: newAcc() };
      groups.set(id, g);
    }
    add(g.acc, row);
  }
  const out = [];
  for (const { dims, acc } of groups.values()) {
    const entry = {};
    dimKeys.forEach((k, i) => {
      entry[k] = dims[i];
    });
    if (decorate) decorate(entry);
    Object.assign(entry, finish(acc));
    out.push(entry);
  }
  return out.sort(byTotalsDesc(dimKeys));
}

export function summarizeUsage(rows, { tzOffsetMinutes = 0, labels = new Map() } = {}) {
  const list = Array.isArray(rows) ? rows : Array.from(rows ?? []);
  const total = newAcc();
  for (const row of list) add(total, row);

  const daily = new Map();
  for (const row of list) {
    if (!isNum(row.ts)) continue;
    const day = dayKey(row.ts, tzOffsetMinutes);
    let acc = daily.get(day);
    if (!acc) {
      acc = newAcc();
      daily.set(day, acc);
    }
    add(acc, row);
  }

  const labelOf = (projectKey) =>
    projectKey != null && labels && typeof labels.get === 'function'
      ? labels.get(projectKey) ?? null
      : null;

  return {
    totals: finish(total),
    byProvider: groupBy(list, ['provider']),
    byModel: groupBy(list, ['provider', 'model']),
    byCredential: groupBy(list, ['provider', 'credentialId']),
    byProject: groupBy(list, ['projectKey'], (e) => {
      e.label = labelOf(e.projectKey);
    }),
    byAgentType: groupBy(list, ['agentType']),
    byServiceTier: groupBy(list, ['serviceTier']),
    daily: [...daily.keys()].sort().map((day) => ({ day, ...finish(daily.get(day)) })),
  };
}
