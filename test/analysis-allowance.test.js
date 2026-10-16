import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeAllowance, HISTORY_MAX_POINTS } from '../src/analysis/allowance.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 16, 12, 0);
const RESET = NOW + 3 * HOUR;

let seq = 0;
function snap(over = {}) {
  seq += 1;
  return {
    snapshotKey: 'k' + String(seq).padStart(6, '0'),
    recordedAt: NOW - 5 * MIN,
    provider: 'anthropic',
    accountKey: 'acctdigest0001',
    limitId: 'five_hour',
    label: '5h',
    windowLabel: '5 hours',
    usedFraction: 0.5,
    status: 'allowed',
    resetsAt: RESET,
    ...over,
  };
}

test('latest snapshot per series, remaining and labels', () => {
  const series = summarizeAllowance(
    [
      snap({ recordedAt: NOW - 10 * MIN, usedFraction: 0.2 }),
      snap({ recordedAt: NOW - 5 * MIN, usedFraction: 1.2 }),
      snap({ limitId: 'weekly', label: 'week', usedFraction: null }),
    ],
    { nowMs: NOW },
  );
  assert.equal(series.length, 2);
  const [five, week] = series;
  assert.equal(five.label, '5h');
  assert.equal(five.accountLabel, 'anthropic account acctdi');
  assert.equal(five.usedFraction, 1.2);
  assert.equal(five.remainingFraction, 0);
  assert.equal(five.ageMs, 5 * MIN);
  assert.equal(five.stale, false);
  assert.equal(week.usedFraction, null);
  assert.equal(week.remainingFraction, null);
  assert.equal(week.pace, null);
});

test('stale series have no pace', () => {
  const [s] = summarizeAllowance(
    [snap({ recordedAt: NOW - 3 * HOUR, usedFraction: 0.1 }), snap({ recordedAt: NOW - 2 * HOUR, usedFraction: 0.3 })],
    { nowMs: NOW },
  );
  assert.equal(s.stale, true);
  assert.equal(s.pace, null);
});

test('pace projection and exhaustsBeforeReset', () => {
  const [s] = summarizeAllowance(
    [
      snap({ recordedAt: NOW - 60 * MIN, usedFraction: 0.2 }),
      snap({ recordedAt: NOW - 30 * MIN, usedFraction: 0.3 }),
      snap({ recordedAt: NOW, usedFraction: 0.4 }),
    ],
    { nowMs: NOW },
  );
  assert.ok(Math.abs(s.pace.ratePerHour - 0.2) < 1e-12);
  assert.equal(s.pace.projectedExhaustAt, NOW + 3 * HOUR);
  assert.equal(s.pace.basisPoints, 3);
  assert.equal(s.pace.basisStartAt, NOW - 60 * MIN);
  assert.equal(s.pace.exhaustsBeforeReset, false);

  const [fast] = summarizeAllowance(
    [snap({ recordedAt: NOW - 30 * MIN, usedFraction: 0.2 }), snap({ recordedAt: NOW, usedFraction: 0.6 })],
    { nowMs: NOW },
  );
  assert.equal(fast.pace.exhaustsBeforeReset, true);

  const [noReset] = summarizeAllowance(
    [snap({ recordedAt: NOW - 30 * MIN, usedFraction: 0.2, resetsAt: null }), snap({ recordedAt: NOW, usedFraction: 0.6, resetsAt: null })],
    { nowMs: NOW },
  );
  assert.equal(noReset.pace.exhaustsBeforeReset, null);
});

test('null pace with insufficient span, single point or no increase', () => {
  const short = summarizeAllowance(
    [snap({ recordedAt: NOW - 10 * MIN, usedFraction: 0.2 }), snap({ recordedAt: NOW, usedFraction: 0.4 })],
    { nowMs: NOW },
  );
  assert.equal(short[0].pace, null);
  const single = summarizeAllowance([snap({ recordedAt: NOW })], { nowMs: NOW });
  assert.equal(single[0].pace, null);
  const flat = summarizeAllowance(
    [snap({ recordedAt: NOW - 60 * MIN, usedFraction: 0.4 }), snap({ recordedAt: NOW, usedFraction: 0.4 })],
    { nowMs: NOW },
  );
  assert.equal(flat[0].pace, null);
});

test('reset detected by usedFraction drop', () => {
  const [s] = summarizeAllowance(
    [
      snap({ recordedAt: NOW - 120 * MIN, usedFraction: 0.1 }),
      snap({ recordedAt: NOW - 90 * MIN, usedFraction: 0.9 }),
      snap({ recordedAt: NOW - 60 * MIN, usedFraction: 0.1 }),
      snap({ recordedAt: NOW, usedFraction: 0.3 }),
    ],
    { nowMs: NOW },
  );
  assert.equal(s.pace.basisStartAt, NOW - 60 * MIN);
  assert.equal(s.pace.basisPoints, 2);
  assert.ok(Math.abs(s.pace.ratePerHour - 0.2) < 1e-12);
});

test('reset detected by resetsAt change; small drops are not resets', () => {
  const [s] = summarizeAllowance(
    [
      snap({ recordedAt: NOW - 120 * MIN, usedFraction: 0.1, resetsAt: NOW - HOUR }),
      snap({ recordedAt: NOW - 60 * MIN, usedFraction: 0.12, resetsAt: RESET }),
      snap({ recordedAt: NOW - 30 * MIN, usedFraction: 0.1, resetsAt: RESET + 1000 }),
      snap({ recordedAt: NOW, usedFraction: 0.32, resetsAt: RESET }),
    ],
    { nowMs: NOW },
  );
  assert.equal(s.pace.basisStartAt, NOW - 60 * MIN);
  assert.equal(s.pace.basisPoints, 3);
});

test('history limited to 30 days and downsampled with max per bucket', () => {
  const snaps = [snap({ recordedAt: NOW - 31 * 24 * HOUR, usedFraction: 0.9 })];
  for (let i = 0; i < 1000; i += 1) {
    snaps.push(snap({ recordedAt: NOW - 29 * 24 * HOUR + i * 30 * MIN, usedFraction: i === 500 ? 0.99 : 0.1 }));
  }
  const [s] = summarizeAllowance(snaps, { nowMs: NOW });
  assert.ok(s.history.length <= HISTORY_MAX_POINTS);
  assert.ok(s.history.length > 300);
  assert.ok(s.history.every((p) => p.t >= NOW - 30 * 24 * HOUR));
  assert.ok(s.history.some((p) => p.used === 0.99));
  for (let i = 1; i < s.history.length; i += 1) assert.ok(s.history[i].t > s.history[i - 1].t);

  const small = summarizeAllowance([snap(), snap({ recordedAt: NOW - MIN, usedFraction: null })], { nowMs: NOW });
  assert.deepEqual(small[0].history, [{ t: NOW - 5 * MIN, used: 0.5 }]);
});

test('series sorted by provider, accountLabel, label', () => {
  const series = summarizeAllowance(
    [
      snap({ provider: 'openai', limitId: 'a', label: 'a' }),
      snap({ accountKey: 'zzz', limitId: 'b', label: 'b' }),
      snap({ limitId: 'c', label: 'week' }),
      snap({ limitId: 'd', label: '5h' }),
    ],
    { nowMs: NOW },
  );
  assert.deepEqual(series.map((s) => [s.provider, s.accountKey.slice(0, 3), s.label]), [
    ['anthropic', 'acc', '5h'],
    ['anthropic', 'acc', 'week'],
    ['anthropic', 'zzz', 'b'],
    ['openai', 'acc', 'a'],
  ]);
});
