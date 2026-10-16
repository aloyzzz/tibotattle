// Pure normalization of one parsed omp session JSONL entry into an allowlisted,
// content-free request record. No I/O; message content is never inspected.

import { keyed } from '../secret.js';

const VOCAB_RE = /^[A-Za-z0-9._:/@+ -]{1,128}$/;
const SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'scale', 'priority', 'ultrafast']);
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
const AGENT_TYPES = new Set(['main', 'subagent', 'advisor']);

/** 'main' for <project>/<file>.jsonl, 'subagent' deeper, 'advisor' by name. */
export function classifyAgentType(relativePathSegments) {
  const segments = Array.isArray(relativePathSegments) ? relativePathSegments : [];
  const base = segments.length > 0 ? String(segments[segments.length - 1]) : '';
  if (base === '__advisor.jsonl' || (base.startsWith('__advisor.') && base.endsWith('.jsonl'))) return 'advisor';
  return segments.length <= 2 ? 'main' : 'subagent';
}

/** Keeps vocabulary-shaped strings; anything else becomes 'unrecognized'. */
export function vocab(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && VOCAB_RE.test(value) ? value : 'unrecognized';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveTimestamp(msgTimestamp, entryTimestamp) {
  if (typeof msgTimestamp === 'number' && Number.isFinite(msgTimestamp) && msgTimestamp > 0) return msgTimestamp;
  if (typeof entryTimestamp === 'string') {
    const parsed = Date.parse(entryTimestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveStopReason(stopReason, errorMessage) {
  if (stopReason === null || stopReason === undefined) {
    return typeof errorMessage === 'string' && errorMessage !== '' ? 'error' : 'aborted';
  }
  return STOP_REASONS.has(stopReason) ? stopReason : 'unrecognized';
}

function resolveTotal(usage, buckets) {
  const provided = tokenCount(usage.totalTokens);
  if (provided !== null) return provided;
  const known = buckets.filter((value) => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/**
 * Returns null, a header (raw session id and cwd for the caller to digest), or
 * a request record with every RequestRecord key present.
 */
export function normalizeEntry(entry, { key, sessionKey = null, projectKey = null, agentType = 'main' } = {}) {
  if (!isObject(entry) || typeof entry.id !== 'string' || entry.id === '') return null;

  if (entry.type === 'session') {
    return { kind: 'header', sessionId: entry.id, cwd: typeof entry.cwd === 'string' ? entry.cwd : null };
  }

  let source;
  let purpose;
  if (entry.type === 'message') {
    if (!isObject(entry.message) || entry.message.role !== 'assistant') return null;
    source = entry.message;
    purpose = 'turn';
  } else if (entry.type === 'model_usage') {
    source = entry;
    purpose = vocab(entry.purpose) ?? 'auxiliary';
  } else {
    return null;
  }

  const { provider, model, api, usage } = source;
  if (typeof provider !== 'string' || typeof model !== 'string' || typeof api !== 'string') return null;
  if (!isObject(usage)) return null;

  const ts = resolveTimestamp(source.timestamp, entry.timestamp);
  if (ts === null) return null;

  const input = tokenCount(usage.input);
  const output = tokenCount(usage.output);
  const cacheRead = tokenCount(usage.cacheRead);
  const cacheWrite = tokenCount(usage.cacheWrite);
  const durationMs = nonNegative(source.duration);
  let ttftMs = nonNegative(source.ttft);
  if (ttftMs !== null && durationMs !== null && ttftMs > durationMs) ttftMs = null;

  const responseId = typeof source.responseId === 'string' ? source.responseId : '';
  // No session id in the key, so branch copies of the same turn dedupe.
  const requestKey = keyed(key, 'request', [responseId, entry.id, ts, provider, model].join('\0'));

  return {
    kind: 'request',
    record: {
      requestKey,
      ts,
      provider: vocab(provider),
      api: vocab(api),
      model: vocab(model),
      upstreamProvider: vocab(source.upstreamProvider),
      serviceTier: SERVICE_TIERS.has(source.serviceTier) ? source.serviceTier : null,
      credentialId:
        Number.isSafeInteger(source.credentialId) && source.credentialId >= 0 ? source.credentialId : null,
      agentType: AGENT_TYPES.has(agentType) ? agentType : 'unrecognized',
      purpose,
      sessionKey: sessionKey ?? null,
      projectKey: projectKey ?? null,
      stopReason: resolveStopReason(source.stopReason, source.errorMessage),
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: resolveTotal(usage, [input, output, cacheRead, cacheWrite]),
      costUsd: isObject(usage.cost) ? nonNegative(usage.cost.total) : null,
      durationMs,
      ttftMs,
    },
  };
}
