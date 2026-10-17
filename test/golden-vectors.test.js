// Shared golden vectors for the Node and Swift (apps/macos) implementations.
//
// Inputs are synthetic and content-free. Run with UPDATE_GOLDEN=1 to rewrite
// test/fixtures/golden/*.json from the current Node modules; otherwise every
// file must equal what the Node modules produce now, byte for byte.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { keyed } from '../src/secret.js';
import { classifyAgentType, normalizeEntry, vocab } from '../src/omp/session-record.js';
import { openStore } from '../src/store.js';
import { resolvePeriod, dayKey } from '../src/analysis/period.js';
import { summarizeUsage } from '../src/analysis/usage.js';
import { summarizePerformance } from '../src/analysis/performance.js';
import { summarizeAllowance } from '../src/analysis/allowance.js';

const GOLDEN_DIR = fileURLToPath(new URL('./fixtures/golden/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY = Buffer.from(KEY_HEX, 'hex');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // 1768478400000
const T0 = Date.UTC(2026, 0, 14, 23, 30, 0);

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function check(name, value) {
  const file = path.join(GOLDEN_DIR, name);
  const text = serialize(value);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `${name} missing; run UPDATE_GOLDEN=1 npm test`);
  assert.equal(fs.readFileSync(file, 'utf8'), text, `${name} is out of date; run UPDATE_GOLDEN=1`);
}

// ---------------------------------------------------------------------------
// keyed.json

test('golden: keyed digests', () => {
  const inputs = [
    ['file', '/synthetic/agent/sessions/proj/a.jsonl'],
    ['session', 'synthetic-session-0001'],
    ['project', '/synthetic/work/project-alpha'],
    ['request', ['resp-1', 'entry-1', '1767225600000', 'prov', 'model-a'].join('\0')],
    ['request', ['', 'entry-2', '1767225600000.5', 'prov', 'model-a'].join('\0')],
    ['snapshot', ['1768470000000', 'prov', 'acct-synthetic', 'five_hour'].join('\0')],
    ['account', 'prov\0acct-synthetic'],
    ['db', '/synthetic/agent/agent.db'],
    ['file', ''],
    ['project', '/synthetic/ünïcødé/プロジェクト/🙂'],
    ['session', 'x'.repeat(1000)],
  ];
  check('keyed.json', {
    keyHex: KEY_HEX,
    cases: inputs.map(([domain, value]) => ({ domain, value, expected: keyed(KEY, domain, value) })),
  });
});

// ---------------------------------------------------------------------------
// records.json

const CONTEXT = { sessionKey: 'sessKeySynthetic000001', projectKey: 'projKeySynthetic000001', agentType: 'main' };

function assistant(over = {}, msgOver = {}) {
  return {
    type: 'message',
    id: 'entry-a1',
    parentId: 'entry-u1',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'synthetic' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-synthetic-1',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 300,
        cacheWrite: 20,
        totalTokens: 470,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0001, total: 0.0034 },
      },
      stopReason: 'stop',
      timestamp: 1767225602000,
      duration: 1500,
      ttft: 250,
      ...msgOver,
    },
    ...over,
  };
}

function modelUsage(over = {}) {
  return {
    type: 'model_usage',
    id: 'entry-mu1',
    timestamp: '2026-01-01T00:00:05.000Z',
    purpose: 'title',
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-synthetic-mini',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    stopReason: 'stop',
    ...over,
  };
}

function usageWith(over) {
  return { input: 100, output: 50, cacheRead: 300, cacheWrite: 20, totalTokens: 470, ...over };
}

test('golden: session records', () => {
  const cases = [
    ['header', { type: 'session', version: 3, id: 'synthetic-session-0001', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/synthetic/work/project-alpha' }],
    ['header without cwd', { type: 'session', id: 'synthetic-session-0002', timestamp: '2026-01-01T00:00:00.000Z' }],
    ['header with numeric cwd', { type: 'session', id: 'synthetic-session-0003', cwd: 42 }],
    ['header without id', { type: 'session', cwd: '/synthetic' }],
    ['assistant full', assistant({}, { serviceTier: 'priority', credentialId: 3, responseId: 'resp-synthetic-1', upstreamProvider: 'openrouter' })],
    ['assistant fractional timestamp', assistant({ id: 'entry-a2' }, { timestamp: 1767225600000.5 })],
    ['assistant entry timestamp fallback', assistant({ id: 'entry-a3', timestamp: '2026-01-02T03:04:05.678Z' }, { timestamp: 0 })],
    ['assistant entry timestamp offset', assistant({ id: 'entry-a4', timestamp: '2026-01-02T03:04:05+05:30' }, { timestamp: -5 })],
    ['assistant entry timestamp no millis', assistant({ id: 'entry-a4b', timestamp: '2026-01-02T03:04:05Z' }, { timestamp: 'x' })],
    ['assistant entry timestamp long fraction', assistant({ id: 'entry-a4c', timestamp: '2026-01-02T03:04:05.1234567Z' }, { timestamp: null })],
    ['assistant entry date only', assistant({ id: 'entry-a4d', timestamp: '2026-01-02' }, { timestamp: undefined })],
    ['assistant no timestamp', assistant({ id: 'entry-a5', timestamp: 'not a date' }, { timestamp: undefined })],
    ['assistant ttft greater than duration', assistant({ id: 'entry-a6' }, { duration: 100, ttft: 250 })],
    ['assistant missing timing', assistant({ id: 'entry-a7' }, { duration: undefined, ttft: undefined })],
    ['assistant invalid timing', assistant({ id: 'entry-a8' }, { duration: -1, ttft: '10' })],
    ['assistant fractional timing', assistant({ id: 'entry-a8b' }, { duration: 1234.5, ttft: 12.25 })],
    ['assistant rounded tokens', assistant({ id: 'entry-a9' }, { usage: { input: 10.5, output: 2.4999, cacheRead: 0.5, cacheWrite: 7 } })],
    ['assistant invalid tokens', assistant({ id: 'entry-a10' }, { usage: { input: -1, output: true, cacheRead: '5', totalTokens: -3 } })],
    ['assistant empty usage', assistant({ id: 'entry-a11' }, { usage: {} })],
    ['assistant unpriced negative cost', assistant({ id: 'entry-a12' }, { usage: usageWith({ cost: { total: -0.5 } }) })],
    ['assistant cost not object', assistant({ id: 'entry-a13' }, { usage: usageWith({ cost: 0.5 }) })],
    ['assistant cost without total', assistant({ id: 'entry-a14' }, { usage: usageWith({ cost: { input: 0.1 } }) })],
    ['assistant zero cost', assistant({ id: 'entry-a15' }, { usage: usageWith({ cost: { total: 0 } }) })],
    ['assistant stop toolUse', assistant({ id: 'entry-a16' }, { stopReason: 'toolUse' })],
    ['assistant stop unknown', assistant({ id: 'entry-a17' }, { stopReason: 'weird' })],
    ['assistant stop numeric', assistant({ id: 'entry-a18' }, { stopReason: 5 })],
    ['assistant stop missing with error', assistant({ id: 'entry-a19' }, { stopReason: undefined, errorMessage: 'synthetic failure' })],
    ['assistant stop missing', assistant({ id: 'entry-a20' }, { stopReason: undefined })],
    ['assistant stop null with empty error', assistant({ id: 'entry-a21' }, { stopReason: null, errorMessage: '' })],
    ['assistant vocab unrecognized', assistant({ id: 'entry-a22' }, { model: 'model with ! bang', provider: 'prové', api: 'a'.repeat(129), upstreamProvider: 7 })],
    ['assistant vocab max length', assistant({ id: 'entry-a23' }, { model: 'm'.repeat(128), provider: 'p.r:o/v@i+d e-r_1' })],
    ['assistant tier variants', assistant({ id: 'entry-a24' }, { serviceTier: 'Priority', credentialId: -1 })],
    ['assistant tier numeric', assistant({ id: 'entry-a25' }, { serviceTier: 1, credentialId: 2.5 })],
    ['assistant credential unsafe', assistant({ id: 'entry-a26' }, { serviceTier: 'flex', credentialId: 9007199254740992 })],
    ['assistant credential boolean', assistant({ id: 'entry-a27' }, { serviceTier: 'ultrafast', credentialId: true })],
    ['assistant credential zero', assistant({ id: 'entry-a28' }, { serviceTier: 'auto', credentialId: 0 })],
    ['assistant large tokens', assistant({ id: 'entry-a29' }, { usage: { input: 123456789012, output: 1, totalTokens: 123456789013 } })],
    ['assistant subagent context', assistant({ id: 'entry-a30' }), { sessionKey: null, projectKey: null, agentType: 'subagent' }],
    ['assistant unknown agent type', assistant({ id: 'entry-a31' }), { sessionKey: 'sessKeySynthetic000002', projectKey: null, agentType: 'weird' }],
    ['assistant unicode ids', assistant({ id: 'entry-ü-🙂' }, { responseId: 'resp-あ' })],
    ['assistant missing provider', assistant({ id: 'entry-b1' }, { provider: undefined })],
    ['assistant numeric model', assistant({ id: 'entry-b2' }, { model: 12 })],
    ['assistant usage array', assistant({ id: 'entry-b3' }, { usage: [1, 2] })],
    ['assistant usage missing', assistant({ id: 'entry-b4' }, { usage: undefined })],
    ['user message', { type: 'message', id: 'entry-u1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'synthetic' } }],
    ['message without body', { type: 'message', id: 'entry-u2', timestamp: '2026-01-01T00:00:01.000Z' }],
    ['message body array', { type: 'message', id: 'entry-u3', message: [] }],
    ['empty id', assistant({ id: '' })],
    ['numeric id', assistant({ id: 7 })],
    ['unknown type', { type: 'compaction', id: 'entry-c1', timestamp: '2026-01-01T00:00:01.000Z' }],
    ['model_usage', modelUsage()],
    ['model_usage no purpose', modelUsage({ id: 'entry-mu2', purpose: undefined })],
    ['model_usage null purpose', modelUsage({ id: 'entry-mu3', purpose: null })],
    ['model_usage bad purpose', modelUsage({ id: 'entry-mu4', purpose: 'bad purpose!' })],
    ['model_usage numeric timestamp ignored', modelUsage({ id: 'entry-mu5', timestamp: 1767225600000 })],
    ['model_usage with timing', modelUsage({ id: 'entry-mu6', duration: 300, ttft: 30, responseId: 'resp-mu' })],
    ['array entry', [1, 2, 3]],
    ['null entry', null],
    ['string entry', 'synthetic'],
  ];

  const out = cases.map(([name, entry, context]) => {
    // Round-trip through JSON so `undefined` keys disappear like in a JSONL line.
    const parsed = JSON.parse(JSON.stringify(entry));
    const ctx = context ?? CONTEXT;
    const result = normalizeEntry(parsed, { key: KEY, ...ctx });
    const expected = result === null ? null : result.kind === 'header' ? result : result.record;
    return context ? { name, context, entry: parsed, expected } : { name, entry: parsed, expected };
  });

  const classify = [
    ['proj', 'a.jsonl'],
    ['a.jsonl'],
    ['proj', 'sub', 'b.jsonl'],
    ['proj', 'sub', 'deeper', 'c.jsonl'],
    ['proj', '__advisor.jsonl'],
    ['proj', 'sub', '__advisor.2.jsonl'],
    ['proj', '__advisor.json'],
    [],
  ].map((segments) => ({ segments, expected: classifyAgentType(segments) }));

  const vocabCases = [
    'anthropic', 'gpt-5.1-codex', 'a/b:c@d+e f_g', '', 'x'.repeat(128), 'x'.repeat(129), 'tab\tchar',
    'new\nline', 'trailing\n', 'é', null, 12, true,
  ].map((value) => ({ value, expected: vocab(value) }));

  check('records.json', { keyHex: KEY_HEX, context: CONTEXT, cases: out, classify, vocab: vocabCases });
});

// ---------------------------------------------------------------------------
// usage.json

function row(n, over = {}) {
  return {
    requestKey: `rk-${String(n).padStart(4, '0')}`,
    ts: T0 + n * 7 * MIN,
    provider: 'anthropic',
    api: 'anthropic-messages',
    model: 'claude-synthetic-1',
    upstreamProvider: null,
    serviceTier: null,
    credentialId: 1,
    agentType: 'main',
    purpose: 'turn',
    sessionKey: 'sess-a',
    projectKey: 'proj-a',
    stopReason: 'stop',
    input: 100,
    output: 50,
    cacheRead: 300,
    cacheWrite: 20,
    totalTokens: 470,
    costUsd: 0.0034,
    durationMs: 1500,
    ttftMs: 250,
    ...over,
  };
}

function usageRows() {
  return [
    row(1),
    row(2, { costUsd: 0.1 + 0.2, sessionKey: 'sess-b' }),
    row(3, { costUsd: null, stopReason: 'error', sessionKey: 'sess-b' }),
    row(4, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, costUsd: null, sessionKey: null }),
    row(5, { provider: 'openai', api: 'openai-responses', model: 'gpt-synthetic', credentialId: null, cacheRead: null, totalTokens: 170, projectKey: 'proj-b', serviceTier: 'priority' }),
    row(6, { provider: 'openai', api: 'openai-responses', model: 'gpt-synthetic', credentialId: 2, input: 0, cacheRead: 0, totalTokens: 70, projectKey: null, agentType: 'subagent', serviceTier: 'flex' }),
    row(7, { provider: 'openai', model: 'gpt-synthetic-mini', purpose: 'title', credentialId: 2, totalTokens: 470, agentType: 'advisor', costUsd: 0.0000001 }),
    row(8, { model: 'claude-synthetic-2', totalTokens: 470, projectKey: 'proj-c', costUsd: 1.25 }),
    row(9, { ts: T0 + DAY + 5 * MIN, credentialId: 0, projectKey: 'proj-c', costUsd: 0 }),
    row(10, { ts: T0 - 3 * DAY, model: 'claude-synthetic-2', input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: null }),
    row(11, { ts: T0 + 40 * MIN, provider: 'prov-zero', model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: null }),
    row(12, { ts: T0 + 41 * MIN, provider: 'prov-zero', model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: null, credentialId: 5 }),
  ];
}

test('golden: usage summary', () => {
  const rows = usageRows();
  const labels = { 'proj-a': 'project-alpha', 'proj-b': 'project-beta' };
  const build = (tzOffsetMinutes) => {
    const options = { tzOffsetMinutes, labels };
    return { options, rows, expected: summarizeUsage(rows, { tzOffsetMinutes, labels: new Map(Object.entries(labels)) }) };
  };
  const main = build(60);
  const extraCases = [build(0), build(-480), build(840)].map((c) => ({ options: c.options, expected: c.expected }));
  const periods = ['24h', '7d', '30d', 'all'].map((name) => ({ name, nowMs: NOW, expected: resolvePeriod(name, NOW) }));
  periods.push({ name: '24h', nowMs: 1000.75, expected: resolvePeriod('24h', 1000.75) });
  const days = [
    [0, 0], [-1, 0], [-0.5, 0], [NOW, 0], [NOW, 720], [NOW, -720], [Date.UTC(2026, 0, 1) - 1, 1],
    [253402300800000, 0], [-62198755200001, 0], [8.64e15, 0],
  ].map(([ts, tz]) => ({ ts, tzOffsetMinutes: tz, expected: dayKey(ts, tz) }));
  check('usage.json', { ...main, extraCases, periods, dayKeys: days });
});

// ---------------------------------------------------------------------------
// performance.json

function perfRows() {
  return [
    row(1, { durationMs: 2000, ttftMs: 500, output: 300 }),
    row(2, { durationMs: 1000, ttftMs: 100, output: 90 }),
    row(3, { durationMs: 3000, ttftMs: null, output: 600 }),
    row(4, { durationMs: 1000, ttftMs: 950, output: 40 }), // decode window < 100 ms
    row(5, { durationMs: 1000, ttftMs: 900, output: 40 }), // exactly 100 ms
    row(6, { durationMs: null, output: 40 }), // ineligible: no duration
    row(7, { durationMs: 0, output: 40 }), // ineligible
    row(8, { output: 0 }), // ineligible
    row(9, { output: null }), // ineligible
    row(10, { stopReason: 'error' }), // ineligible
    row(11, { stopReason: 'aborted' }),
    row(12, { stopReason: 'toolUse', ts: T0 + DAY, durationMs: 1234.5, ttftMs: 12.25, output: 77 }),
    row(13, { stopReason: 'length', ts: T0 + DAY + HOUR, serviceTier: 'priority', durationMs: 4000, ttftMs: 1000, output: 1000 }),
    row(14, { purpose: 'title' }), // ineligible: auxiliary
    row(15, { provider: 'openai', model: 'gpt-synthetic', serviceTier: 'priority', durationMs: 800, ttftMs: 200, output: 120 }),
    row(16, { provider: 'openai', model: 'gpt-synthetic', serviceTier: 'flex', durationMs: 900, ttftMs: 300, output: 60 }),
    row(17, { provider: 'openai', model: 'gpt-synthetic', serviceTier: 'flex', durationMs: 950, ttftMs: 310, output: 61 }),
    row(18, { provider: 'openai', model: 'gpt-synthetic', serviceTier: null, durationMs: 700, ttftMs: 100, output: 33 }),
    row(19, { provider: 'openai', model: 'a-model', serviceTier: 'auto', durationMs: 500, ttftMs: 0, output: 10 }),
    row(20, { provider: 'openai', model: 'a-model', serviceTier: 'auto', ts: T0 - 10 * DAY, durationMs: 600, ttftMs: 50, output: 11 }),
    row(21, { provider: 'anthropic', model: 'claude-synthetic-3', serviceTier: 'scale', durationMs: 1000, ttftMs: 200, output: 80 }),
    row(22, { provider: 'anthropic', model: 'claude-synthetic-3', serviceTier: 'scale', durationMs: 1000, ttftMs: 200, output: 80 }),
  ];
}

test('golden: performance summary', () => {
  const rows = perfRows();
  const cases = [
    { tzOffsetMinutes: 0, serviceTier: 'all' },
    { tzOffsetMinutes: 60, serviceTier: 'all' },
    { tzOffsetMinutes: -300, serviceTier: 'unreported' },
    { tzOffsetMinutes: 0, serviceTier: 'priority' },
    { tzOffsetMinutes: 0, serviceTier: 'flex' },
    { tzOffsetMinutes: 0, serviceTier: 'ultrafast' },
  ].map((options) => ({ options, rows, expected: summarizePerformance(rows, options) }));
  cases.push({ options: { tzOffsetMinutes: 0, serviceTier: 'all' }, rows: [], expected: summarizePerformance([], {}) });
  check('performance.json', { cases });
});

// ---------------------------------------------------------------------------
// allowance.json

function snap(series, n, over = {}) {
  return {
    snapshotKey: `snap-${series}-${String(n).padStart(4, '0')}`,
    recordedAt: NOW - HOUR,
    provider: 'anthropic',
    accountKey: 'acctKeyAAAAsynthetic01',
    limitId: 'five_hour',
    label: '5h',
    windowLabel: '5 hours',
    usedFraction: 0.1,
    status: 'allowed',
    resetsAt: NOW + 2 * HOUR,
    ...over,
  };
}

function allowanceSnapshots() {
  const out = [];
  // A: reset by drop, then steady climb (fresh, pace positive).
  const a = [0.5, 0.6, 0.7, 0.05, 0.1, 0.15, 0.2, 0.25];
  a.forEach((used, i) => out.push(snap('a', i, { recordedAt: NOW - (a.length - i) * 10 * MIN, usedFraction: used })));
  // B: weekly; resetsAt jitter (< 60 s) is not a reset, a real change is; null points skipped.
  const b = [
    [-6 * HOUR, 0.4, NOW + 3 * DAY],
    [-5 * HOUR, 0.42, NOW + 3 * DAY + 30 * 1000],
    [-4 * HOUR, 0.43, NOW + 7 * DAY],
    [-3 * HOUR, null, NOW + 7 * DAY],
    [-2 * HOUR, 0.44, NOW + 7 * DAY],
    [-1 * HOUR, 0.48, NOW + 7 * DAY + 20 * 1000],
    [-5 * MIN, null, NOW + 7 * DAY],
  ];
  b.forEach(([dt, used, resetsAt], i) => out.push(snap('b', i, {
    recordedAt: NOW + dt, usedFraction: used, resetsAt, limitId: 'seven_day', label: 'Weekly', windowLabel: '7 days',
  })));
  // C: stale (latest 2 h old).
  out.push(snap('c', 0, { recordedAt: NOW - 5 * HOUR, usedFraction: 0.2, limitId: 'opus', label: 'Opus', accountKey: 'acctKeyCCCCsynthetic03' }));
  out.push(snap('c', 1, { recordedAt: NOW - 2 * HOUR, usedFraction: 0.6, limitId: 'opus', label: 'Opus', accountKey: 'acctKeyCCCCsynthetic03' }));
  // D: overage (> 1); exhausted now, before reset.
  out.push(snap('d', 0, { recordedAt: NOW - 50 * MIN, usedFraction: 0.9, provider: 'openai', accountKey: 'acctKeyDDDDsynthetic04', limitId: 'primary', label: 'Primary', windowLabel: null, status: 'rejected' }));
  out.push(snap('d', 1, { recordedAt: NOW - 10 * MIN, usedFraction: 1.2, provider: 'openai', accountKey: 'acctKeyDDDDsynthetic04', limitId: 'primary', label: 'Primary', windowLabel: null, status: 'rejected' }));
  // E: span below 20 minutes -> no pace. Tie on recordedAt broken by snapshotKey.
  out.push(snap('e', 1, { recordedAt: NOW - 15 * MIN, usedFraction: 0.31, provider: 'openai', accountKey: 'acctKeyDDDDsynthetic04', limitId: 'secondary', label: 'Secondary' }));
  out.push(snap('e', 0, { recordedAt: NOW - 15 * MIN, usedFraction: 0.3, provider: 'openai', accountKey: 'acctKeyDDDDsynthetic04', limitId: 'secondary', label: 'Secondary' }));
  out.push(snap('e', 2, { recordedAt: NOW - 5 * MIN, usedFraction: 0.4, provider: 'openai', accountKey: 'acctKeyDDDDsynthetic04', limitId: 'secondary', label: 'Secondary' }));
  // F: no increase -> no pace; latest used unknown; no resetsAt.
  out.push(snap('f', 0, { recordedAt: NOW - 3 * HOUR, usedFraction: 0.5, provider: null, accountKey: null, limitId: 'x', label: null, windowLabel: null, status: null, resetsAt: null }));
  out.push(snap('f', 1, { recordedAt: NOW - 2 * HOUR, usedFraction: 0.5, provider: null, accountKey: null, limitId: 'x', label: null, windowLabel: null, status: null, resetsAt: null }));
  out.push(snap('f', 2, { recordedAt: NOW - 20 * MIN, usedFraction: null, provider: null, accountKey: null, limitId: 'x', label: null, windowLabel: null, status: null, resetsAt: null }));
  // G: long history (> 400 points in the window, plus older points) with pace and no resetsAt.
  for (let i = 0; i < 560; i += 1) {
    const recordedAt = NOW - 35 * DAY + i * 90 * MIN + (i % 7) * 1000;
    if (recordedAt > NOW) break;
    out.push(snap('g', i, {
      recordedAt,
      usedFraction: Math.round(((i % 97) / 100 + (i % 13) / 1000) * 1e6) / 1e6,
      provider: 'google', accountKey: 'acctKeyGGGGsynthetic07', limitId: 'daily', label: 'Daily', windowLabel: '1 day', resetsAt: null,
    }));
  }
  // H: single point -> no pace.
  out.push(snap('h', 0, { recordedAt: NOW - MIN, usedFraction: 0, provider: '', accountKey: 'acctKeyHHHHsynthetic08', limitId: 'h' }));
  // I: projected exhaustion after reset.
  out.push(snap('i', 0, { recordedAt: NOW - 60 * MIN, usedFraction: 0.1, accountKey: 'acctKeyIIIIsynthetic09', resetsAt: NOW + 30 * MIN }));
  out.push(snap('i', 1, { recordedAt: NOW - 30 * MIN, usedFraction: 0.12, accountKey: 'acctKeyIIIIsynthetic09', resetsAt: NOW + 30 * MIN + 59 * 1000 }));
  // Ignored: no recordedAt.
  out.push(snap('z', 0, { recordedAt: null }));
  return out;
}

test('golden: allowance summary', () => {
  const snapshots = allowanceSnapshots();
  const options = { nowMs: NOW, staleAfterMs: 30 * MIN };
  check('allowance.json', { options, snapshots, expected: summarizeAllowance(snapshots, options) });
});

// ---------------------------------------------------------------------------
// schema.json: table and index shape of a fresh index (cross-implementation).

test('golden: index schema', () => {
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-golden-'));
    try {
      const file = path.join(dir, 'index.sqlite');
      openStore(file).close();
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const tables = {};
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
          tables[name] = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({
            name: c.name, type: c.type, notnull: Number(c.notnull), pk: Number(c.pk),
          }));
        }
        const indexes = {};
        for (const { name, tbl_name: table } of db
          .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name")
          .all()) {
          indexes[name] = { table, columns: db.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name) };
        }
        const meta = db.prepare('SELECT key, value FROM meta ORDER BY key').all().map((r) => ({ ...r }));
        check('schema.json', { schemaVersion: 1, tables, indexes, meta });
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
