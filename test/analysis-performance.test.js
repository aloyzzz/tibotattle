import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizePerformance, percentile, stats } from '../src/analysis/performance.js';

const T0 = Date.UTC(2026, 9, 10, 12, 0);

function row(over = {}) {
  return {
    ts: T0,
    provider: 'anthropic',
    model: 'm-a',
    serviceTier: null,
    purpose: 'turn',
    stopReason: 'stop',
    output: 100,
    durationMs: 2000,
    ttftMs: 1000,
    ...over,
  };
}

test('percentile uses linear interpolation', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.25), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(percentile([1, 2, 3, 4], 0.75), 3.25);
  assert.deepEqual(stats([]), { n: 0, median: null, p25: null, p75: null, mean: null });
  assert.deepEqual(stats([4, 1, 3, 2]), { n: 4, median: 2.5, p25: 1.75, p75: 3.25, mean: 2.5 });
});

test('eligibility excludes non-turns, bad stops, zero output and missing duration', () => {
  const rows = [
    row(),
    row({ purpose: 'auxiliary' }),
    row({ stopReason: 'error' }),
    row({ stopReason: 'aborted' }),
    row({ output: 0 }),
    row({ output: null }),
    row({ durationMs: null }),
    row({ durationMs: 0 }),
    row({ stopReason: 'toolUse' }),
    row({ stopReason: 'length' }),
  ];
  const out = summarizePerformance(rows);
  assert.equal(out.models.length, 1);
  assert.equal(out.models[0].requests, 3);
});

test('decode vs request TPS and ttft stats', () => {
  const rows = [
    row({ output: 100, durationMs: 2000, ttftMs: 1000 }), // decode 100, request 50
    row({ output: 100, durationMs: 1000, ttftMs: null }), // decode null, request 100
    row({ output: 100, durationMs: 1000, ttftMs: 950 }), // gap 50ms < 100 -> no decode, request 100
  ];
  const [m] = summarizePerformance(rows).models;
  assert.equal(m.requests, 3);
  assert.equal(m.timedRequests, 2);
  assert.equal(m.decodeTps.n, 1);
  assert.equal(m.decodeTps.median, 100);
  assert.equal(m.requestTps.n, 3);
  assert.equal(m.requestTps.median, 100);
  assert.equal(m.requestTps.p25, 75);
  assert.equal(m.ttftMs.n, 2);
  assert.equal(m.ttftMs.mean, 975);
});

test('tier filter and tier counts', () => {
  const rows = [
    row({ serviceTier: 'priority' }),
    row({ serviceTier: 'priority' }),
    row({ serviceTier: 'flex' }),
    row({ serviceTier: null }),
  ];
  const all = summarizePerformance(rows);
  assert.equal(all.models[0].requests, 4);
  assert.deepEqual(all.tiers, [
    { serviceTier: 'priority', requests: 2 },
    { serviceTier: 'flex', requests: 1 },
    { serviceTier: null, requests: 1 },
  ]);
  assert.equal(summarizePerformance(rows, { serviceTier: 'priority' }).models[0].requests, 2);
  assert.equal(summarizePerformance(rows, { serviceTier: 'unreported' }).models[0].requests, 1);
  assert.deepEqual(summarizePerformance(rows, { serviceTier: 'scale' }).models, []);
  assert.deepEqual(summarizePerformance(rows, { serviceTier: 'scale' }).tiers, all.tiers);
  assert.throws(() => summarizePerformance(rows, { serviceTier: 'bogus' }), RangeError);
});

test('models sort by requests desc then provider/model; daily medians per day', () => {
  const rows = [
    row({ model: 'm-b' }),
    row({ model: 'm-a', ts: T0 }),
    row({ model: 'm-a', ts: T0 + 86400000, ttftMs: 500 }),
    row({ model: 'm-c' }),
  ];
  const out = summarizePerformance(rows);
  assert.deepEqual(out.models.map((m) => m.model), ['m-a', 'm-b', 'm-c']);
  assert.deepEqual(out.models[0].daily, [
    { day: '2026-10-10', decodeTpsMedian: 100, ttftMedian: 1000, n: 1 },
    { day: '2026-10-11', decodeTpsMedian: 100 / 1.5, ttftMedian: 500, n: 1 },
  ]);
});
