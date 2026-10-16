import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAgentType, normalizeEntry, vocab } from '../src/omp/session-record.js';
import { keyed } from '../src/secret.js';

const key = Buffer.alloc(32, 1);
const ctx = { key, sessionKey: 'S', projectKey: 'P', agentType: 'main' };

const RECORD_KEYS = [
  'requestKey', 'ts', 'provider', 'api', 'model', 'upstreamProvider', 'serviceTier', 'credentialId',
  'agentType', 'purpose', 'sessionKey', 'projectKey', 'stopReason', 'input', 'output', 'cacheRead',
  'cacheWrite', 'totalTokens', 'costUsd', 'durationMs', 'ttftMs',
].sort();

function assistant(overrides = {}, usage = {}) {
  return {
    type: 'message',
    id: 'e1',
    timestamp: '2026-01-02T03:04:05.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'SENTINEL' }],
      api: 'test-api',
      provider: 'prov',
      model: 'model-a',
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { total: 0.5 }, ...usage },
      stopReason: 'stop',
      timestamp: 1767323045000,
      duration: 2000,
      ttft: 500,
      serviceTier: 'priority',
      credentialId: 3,
      responseId: 'r1',
      upstreamProvider: 'Up',
      ...overrides,
    },
  };
}

test('classifyAgentType', () => {
  assert.equal(classifyAgentType(['proj', 'x.jsonl']), 'main');
  assert.equal(classifyAgentType(['x.jsonl']), 'main');
  assert.equal(classifyAgentType(['proj', 'sess', 'task.jsonl']), 'subagent');
  assert.equal(classifyAgentType(['proj', 'sess', '__advisor.jsonl']), 'advisor');
  assert.equal(classifyAgentType(['proj', 'sess', 'a', '__advisor.slug.jsonl']), 'advisor');
  assert.equal(classifyAgentType(['proj', '__advisor.jsonl']), 'advisor');
});

test('vocab keeps vocabulary and rejects everything else', () => {
  assert.equal(vocab(null), null);
  assert.equal(vocab(undefined), null);
  assert.equal(vocab('claude-x/y:1.5@v+2 z'), 'claude-x/y:1.5@v+2 z');
  assert.equal(vocab(''), 'unrecognized');
  assert.equal(vocab('a'.repeat(129)), 'unrecognized');
  assert.equal(vocab('bad\nvalue'), 'unrecognized');
  assert.equal(vocab('{"x":1}'), 'unrecognized');
  assert.equal(vocab(42), 'unrecognized');
});

test('valid assistant message becomes a complete request record', () => {
  const out = normalizeEntry(assistant(), ctx);
  assert.equal(out.kind, 'request');
  const r = out.record;
  assert.deepEqual(Object.keys(r).sort(), RECORD_KEYS);
  assert.equal(r.requestKey, keyed(key, 'request', ['r1', 'e1', 1767323045000, 'prov', 'model-a'].join('\0')));
  assert.equal(r.ts, 1767323045000);
  assert.equal(r.provider, 'prov');
  assert.equal(r.api, 'test-api');
  assert.equal(r.model, 'model-a');
  assert.equal(r.upstreamProvider, 'Up');
  assert.equal(r.serviceTier, 'priority');
  assert.equal(r.credentialId, 3);
  assert.equal(r.agentType, 'main');
  assert.equal(r.purpose, 'turn');
  assert.equal(r.sessionKey, 'S');
  assert.equal(r.projectKey, 'P');
  assert.equal(r.stopReason, 'stop');
  assert.deepEqual([r.input, r.output, r.cacheRead, r.cacheWrite, r.totalTokens], [10, 20, 30, 40, 100]);
  assert.equal(r.costUsd, 0.5);
  assert.equal(r.durationMs, 2000);
  assert.equal(r.ttftMs, 500);
  assert.ok(!JSON.stringify(r).includes('SENTINEL'));
});

test('message timestamp falls back to entry timestamp; neither -> skipped', () => {
  const r = normalizeEntry(assistant({ timestamp: 0 }), ctx).record;
  assert.equal(r.ts, Date.parse('2026-01-02T03:04:05.000Z'));
  const none = assistant({ timestamp: undefined });
  delete none.timestamp;
  assert.equal(normalizeEntry(none, ctx), null);
});

test('model_usage entries are auxiliary requests', () => {
  const entry = {
    type: 'model_usage',
    id: 'm1',
    timestamp: '2026-01-02T03:04:05.000Z',
    purpose: 'title',
    api: 'test-api',
    provider: 'prov',
    model: 'model-b',
    usage: { input: 5, output: 1 },
    stopReason: 'stop',
  };
  const r = normalizeEntry(entry, { ...ctx, agentType: 'subagent' }).record;
  assert.equal(r.purpose, 'title');
  assert.equal(r.agentType, 'subagent');
  assert.equal(r.totalTokens, 6);
  assert.equal(r.costUsd, null);
  assert.equal(r.durationMs, null);
  assert.equal(r.ttftMs, null);
  assert.equal(normalizeEntry({ ...entry, purpose: undefined }, ctx).record.purpose, 'auxiliary');
  assert.equal(normalizeEntry({ ...entry, purpose: 'x\ny' }, ctx).record.purpose, 'unrecognized');
});

test('header returns raw values for the caller to digest', () => {
  assert.deepEqual(normalizeEntry({ type: 'session', id: 'sid', timestamp: 'x', cwd: '/w/p' }, ctx), {
    kind: 'header',
    sessionId: 'sid',
    cwd: '/w/p',
  });
  assert.equal(normalizeEntry({ type: 'session', cwd: '/w/p' }, ctx), null);
});

test('malformed usage, missing fields and missing ids are skipped', () => {
  assert.equal(normalizeEntry(assistant({ usage: null }), ctx), null);
  assert.equal(normalizeEntry(assistant({ usage: [1, 2] }), ctx), null);
  assert.equal(normalizeEntry(assistant({ provider: 7 }), ctx), null);
  assert.equal(normalizeEntry(assistant({ model: undefined }), ctx), null);
  assert.equal(normalizeEntry(assistant({ api: undefined }), ctx), null);
  assert.equal(normalizeEntry(assistant({ role: 'user' }), ctx), null);
  assert.equal(normalizeEntry({ ...assistant(), id: '' }, ctx), null);
  const noId = assistant();
  delete noId.id;
  assert.equal(normalizeEntry(noId, ctx), null);
  assert.equal(normalizeEntry(null, ctx), null);
  assert.equal(normalizeEntry({ type: 'tool_result', id: 'x' }, ctx), null);
});

test('invalid token buckets become null, never zero', () => {
  const r = normalizeEntry(
    assistant({}, { input: -1, output: 'x', cacheRead: Number.NaN, cacheWrite: 2.6, totalTokens: undefined, cost: {} }),
    ctx,
  ).record;
  assert.deepEqual([r.input, r.output, r.cacheRead, r.cacheWrite], [null, null, null, 3]);
  assert.equal(r.totalTokens, 3);
  assert.equal(r.costUsd, null);
  const empty = normalizeEntry(assistant({ usage: {} }), ctx).record;
  assert.equal(empty.totalTokens, null);
  assert.equal(empty.costUsd, null);
});

test('vocabulary sanitization and enumerations', () => {
  const r = normalizeEntry(
    assistant({ provider: 'p\u0000x', model: '/home/someone/secret file?', serviceTier: 'turbo', upstreamProvider: undefined,
      credentialId: -1, stopReason: 'weird' }),
    ctx,
  ).record;
  assert.equal(r.provider, 'unrecognized');
  assert.equal(r.model, 'unrecognized');
  assert.equal(r.serviceTier, null);
  assert.equal(r.upstreamProvider, null);
  assert.equal(r.credentialId, null);
  assert.equal(r.stopReason, 'unrecognized');
  assert.equal(normalizeEntry(assistant({ stopReason: undefined }), ctx).record.stopReason, 'aborted');
  assert.equal(
    normalizeEntry(assistant({ stopReason: undefined, errorMessage: 'boom' }), ctx).record.stopReason,
    'error',
  );
});

test('ttft greater than duration is dropped; negative timings are null', () => {
  const r = normalizeEntry(assistant({ duration: 100, ttft: 500 }), ctx).record;
  assert.equal(r.durationMs, 100);
  assert.equal(r.ttftMs, null);
  const n = normalizeEntry(assistant({ duration: -1, ttft: 'x' }), ctx).record;
  assert.equal(n.durationMs, null);
  assert.equal(n.ttftMs, null);
});

test('request key ignores session context so branch copies dedupe', () => {
  const a = normalizeEntry(assistant(), ctx).record.requestKey;
  const b = normalizeEntry(assistant(), { ...ctx, sessionKey: 'other', projectKey: 'other' }).record.requestKey;
  assert.equal(a, b);
  const c = normalizeEntry(assistant({ responseId: undefined }), ctx).record.requestKey;
  assert.equal(c, keyed(key, 'request', ['', 'e1', 1767323045000, 'prov', 'model-a'].join('\0')));
});
