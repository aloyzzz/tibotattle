import test from 'node:test';
import assert from 'node:assert/strict';

import { PERIODS, resolvePeriod, dayKey } from '../src/analysis/period.js';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

test('PERIODS lists the supported names', () => {
  assert.deepEqual([...PERIODS], ['24h', '7d', '30d', 'all']);
});

test('resolvePeriod returns half-open ranges ending just after now', () => {
  assert.deepEqual(resolvePeriod('24h', NOW), { name: '24h', fromMs: NOW - 86400000, toMs: NOW + 1 });
  assert.equal(resolvePeriod('7d', NOW).fromMs, NOW - 7 * 86400000);
  assert.equal(resolvePeriod('30d', NOW).fromMs, NOW - 30 * 86400000);
  assert.deepEqual(resolvePeriod('all', NOW), { name: 'all', fromMs: 0, toMs: NOW + 1 });
});

test('resolvePeriod rejects unknown names', () => {
  assert.throws(() => resolvePeriod('1y', NOW), RangeError);
  assert.throws(() => resolvePeriod(undefined, NOW), RangeError);
});

test('dayKey buckets by client offset', () => {
  const ts = Date.UTC(2026, 9, 16, 23, 30);
  assert.equal(dayKey(ts, 0), '2026-10-16');
  assert.equal(dayKey(ts, 60), '2026-10-17');
  assert.equal(dayKey(Date.UTC(2026, 9, 16, 3, 0), -420), '2026-10-15');
});
