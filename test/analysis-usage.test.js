import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeUsage } from '../src/analysis/usage.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 10, 22, 30);

function row(over = {}) {
  return {
    requestKey: 'r' + Math.random(),
    ts: T0,
    provider: 'anthropic',
    api: 'messages',
    model: 'm-a',
    upstreamProvider: null,
    serviceTier: null,
    credentialId: 1,
    agentType: 'main',
    purpose: 'turn',
    sessionKey: 's1',
    projectKey: 'p1',
    stopReason: 'stop',
    input: 100,
    output: 50,
    cacheRead: 300,
    cacheWrite: 0,
    totalTokens: 450,
    costUsd: 0.01,
    durationMs: 1000,
    ttftMs: 200,
    ...over,
  };
}

test('totals sum known values, keep cost unpriced, count sessions distinctly', () => {
  const rows = [
    row(),
    row({ sessionKey: 's2', costUsd: null, stopReason: 'error' }),
    row({ sessionKey: 's2', input: null, cacheRead: null, totalTokens: null, output: null, cacheWrite: null }),
    row({ sessionKey: null }),
  ];
  const { totals } = summarizeUsage(rows);
  assert.equal(totals.requests, 4);
  assert.equal(totals.sessions, 2);
  assert.equal(totals.input, 300);
  assert.equal(totals.output, 150);
  assert.equal(totals.cacheRead, 900);
  assert.equal(totals.totalTokens, 1350);
  assert.equal(totals.unknownTokenRequests, 1);
  assert.equal(totals.pricedRequests, 3);
  assert.equal(totals.unpricedRequests, 1);
  assert.ok(Math.abs(totals.costUsd - 0.03) < 1e-12);
  assert.equal(totals.errorRequests, 1);
  assert.equal(totals.cacheHitRate, 900 / 1200);
});

test('missing evidence stays null rather than zero', () => {
  const { totals } = summarizeUsage([
    row({ costUsd: null, input: null, cacheRead: null, output: null, cacheWrite: null, totalTokens: null }),
  ]);
  assert.equal(totals.costUsd, null);
  assert.equal(totals.input, null);
  assert.equal(totals.totalTokens, null);
  assert.equal(totals.cacheHitRate, null);
  assert.equal(totals.unpricedRequests, 1);
});

test('empty input yields zero counts and null sums', () => {
  const out = summarizeUsage([]);
  assert.equal(out.totals.requests, 0);
  assert.equal(out.totals.sessions, 0);
  assert.equal(out.totals.costUsd, null);
  assert.deepEqual(out.daily, []);
  assert.deepEqual(out.byModel, []);
});

test('groupings sort by totalTokens desc with deterministic tie-breakers', () => {
  const rows = [
    row({ model: 'm-b', totalTokens: 10, credentialId: null }),
    row({ model: 'm-a', totalTokens: 1000 }),
    row({ model: 'm-c', provider: 'openai', totalTokens: 10 }),
    row({ model: 'm-d', provider: 'openai', totalTokens: 10 }),
  ];
  const out = summarizeUsage(rows);
  assert.deepEqual(out.byModel.map((m) => m.model), ['m-a', 'm-b', 'm-c', 'm-d']);
  assert.deepEqual(out.byProvider.map((p) => p.provider), ['anthropic', 'openai']);
  const unattributed = out.byCredential.find((c) => c.credentialId === null);
  assert.equal(unattributed.requests, 1);
  assert.equal(unattributed.provider, 'anthropic');
});

test('byProject attaches in-memory labels, null when unknown', () => {
  const labels = new Map([['p1', 'alpha']]);
  const out = summarizeUsage([row(), row({ projectKey: 'p2' }), row({ projectKey: null })], { labels });
  const byKey = Object.fromEntries(out.byProject.map((p) => [String(p.projectKey), p.label]));
  assert.deepEqual(byKey, { p1: 'alpha', p2: null, null: null });
});

test('byAgentType and byServiceTier group rows', () => {
  const out = summarizeUsage([row(), row({ agentType: 'subagent', serviceTier: 'flex' })]);
  assert.deepEqual(out.byAgentType.map((a) => a.agentType).sort(), ['main', 'subagent']);
  assert.deepEqual(out.byServiceTier.map((a) => a.serviceTier).sort(), ['flex', null]);
});

test('daily buckets use the tz offset and are ascending', () => {
  const rows = [row({ ts: T0 + DAY }), row({ ts: T0 }), row({ ts: T0 + 60 * 60 * 1000 })];
  const utc = summarizeUsage(rows).daily;
  assert.deepEqual(utc.map((d) => [d.day, d.requests]), [['2026-10-10', 2], ['2026-10-11', 1]]);
  const plus2 = summarizeUsage(rows, { tzOffsetMinutes: 120 }).daily;
  assert.deepEqual(plus2.map((d) => [d.day, d.requests]), [['2026-10-11', 2], ['2026-10-12', 1]]);
});

test('accepts iterables', () => {
  function* gen() {
    yield row();
  }
  assert.equal(summarizeUsage(gen()).totals.requests, 1);
});
