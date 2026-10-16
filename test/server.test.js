import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { createServer } from '../src/server.js';

const NOW = Date.UTC(2026, 9, 16, 12, 0);
const MIN = 60 * 1000;

function requestRow(over = {}) {
  return {
    requestKey: 'rk',
    ts: NOW - 60 * MIN,
    provider: 'anthropic',
    api: 'messages',
    model: 'm-a',
    upstreamProvider: null,
    serviceTier: 'priority',
    credentialId: 1,
    agentType: 'main',
    purpose: 'turn',
    sessionKey: 's1',
    projectKey: 'pk1',
    stopReason: 'stop',
    input: 10,
    output: 100,
    cacheRead: 30,
    cacheWrite: 0,
    totalTokens: 140,
    costUsd: 0.5,
    durationMs: 2000,
    ttftMs: 1000,
    ...over,
  };
}

function makeFakes() {
  const calls = { queryRequests: [], querySnapshots: [] };
  const store = {
    queryRequests(opts) {
      calls.queryRequests.push(opts);
      return [requestRow(), requestRow({ ts: NOW - 10 * 24 * 60 * MIN })].filter(
        (r) => r.ts >= opts.fromMs && r.ts < opts.toMs,
      );
    },
    querySnapshots(opts) {
      calls.querySnapshots.push(opts);
      return [
        {
          snapshotKey: 'sk1', recordedAt: NOW - 5 * MIN, provider: 'anthropic', accountKey: 'abcdefgh',
          limitId: 'five_hour', label: '5h', windowLabel: null, usedFraction: 0.25, status: null, resetsAt: null,
        },
      ];
    },
    counts: () => ({ requests: 2, snapshots: 1, files: 1 }),
  };
  const monitor = new EventEmitter();
  monitor.labels = new Map([['pk1', 'alpha']]);
  monitor.generation = 0;
  monitor.refreshCalls = 0;
  monitor.status = () => ({
    generation: monitor.generation, lastRefreshAt: null, lastError: null, refreshing: false,
    sources: { sessionRoots: [], agentDb: null }, counts: store.counts(),
  });
  monitor.refresh = async () => {
    monitor.refreshCalls += 1;
    return { generation: monitor.generation, at: NOW, sessions: null, quota: null };
  };
  return { store, monitor, calls };
}

function req(port, { method = 'GET', pathname = '/', headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    r.on('error', reject);
    r.end();
  });
}

async function withServer(fn) {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'export {};');
  fs.writeFileSync(path.join(webRoot, 'styles.css'), 'body{}');
  fs.writeFileSync(path.join(webRoot, 'secret.txt'), 'nope');
  const fakes = makeFakes();
  const server = createServer({ ...fakes, webRoot, port: 0, now: () => NOW });
  const { port, url } = await server.listen();
  try {
    await fn({ port, url, ...fakes });
  } finally {
    await server.close();
    fs.rmSync(webRoot, { recursive: true, force: true });
  }
}

test('rejects non-loopback host option', () => {
  const fakes = makeFakes();
  assert.throws(() => createServer({ ...fakes, host: '0.0.0.0', port: 0 }));
  assert.throws(() => createServer({ ...fakes, host: '::', port: 0 }));
  assert.throws(() => createServer({ ...fakes, host: 'localhost', port: 0 }));
});

test('listen returns loopback url; Host header is validated', async () => {
  await withServer(async ({ port, url }) => {
    assert.equal(url, `http://127.0.0.1:${port}/`);
    assert.equal((await req(port, { pathname: '/api/status' })).status, 200);
    assert.equal((await req(port, { pathname: '/api/status', host: `localhost:${port}` })).status, 200);
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `LOCALHOST:${port}`]) {
      const res = await req(port, { pathname: '/api/status', host });
      assert.equal(res.status, 403, host);
      assert.deepEqual(res.json, { error: 'forbidden_host' });
      assert.ok(res.headers['content-security-policy']);
    }
  });
});

test('security headers on every response', async () => {
  await withServer(async ({ port }) => {
    for (const pathname of ['/', '/api/usage', '/nope']) {
      const res = await req(port, { pathname });
      assert.equal(
        res.headers['content-security-policy'],
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
    }
    assert.equal((await req(port, { pathname: '/api/usage' })).headers['cache-control'], 'no-store');
  });
});

test('static allowlist', async () => {
  await withServer(async ({ port }) => {
    const index = await req(port, { pathname: '/' });
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    assert.equal((await req(port, { pathname: '/app.js' })).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await req(port, { pathname: '/styles.css' })).status, 200);
    assert.equal((await req(port, { pathname: '/favicon.svg' })).status, 404);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/secret.txt', '/app.js/', '/..%2fpackage.json', '/package.json']) {
      const res = await req(port, { pathname: p });
      assert.equal(res.status, 404, p);
      assert.deepEqual(res.json, { error: 'not_found' });
    }
    assert.equal((await req(port, { method: 'POST', pathname: '/' })).status, 405);
  });
});

test('API shapes', async () => {
  await withServer(async ({ port }) => {
    const status = await req(port, { pathname: '/api/status' });
    assert.equal(status.json.generation, 0);

    const usage = await req(port, { pathname: '/api/usage?period=24h&tz=-420' });
    assert.equal(usage.status, 200);
    assert.equal(usage.json.period.name, '24h');
    assert.equal(usage.json.totals.requests, 1);
    assert.equal(usage.json.byProject[0].label, 'alpha');
    for (const k of ['byProvider', 'byModel', 'byCredential', 'byAgentType', 'byServiceTier', 'daily']) {
      assert.ok(Array.isArray(usage.json[k]), k);
    }
    const usage7 = await req(port, { pathname: '/api/usage' });
    assert.equal(usage7.json.period.name, '7d');
    assert.equal((await req(port, { pathname: '/api/usage?period=all' })).json.totals.requests, 2);

    const perf = await req(port, { pathname: '/api/performance?tier=priority' });
    assert.equal(perf.json.models[0].requests, 1);
    assert.equal(perf.json.models[0].decodeTps.median, 100);
    assert.deepEqual(perf.json.tiers, [{ serviceTier: 'priority', requests: 1 }]);
    assert.deepEqual((await req(port, { pathname: '/api/performance?tier=flex' })).json.models, []);

    const allowance = await req(port, { pathname: '/api/allowance' });
    assert.equal(allowance.json.nowMs, NOW);
    assert.equal(allowance.json.series.length, 1);
    assert.equal(allowance.json.series[0].remainingFraction, 0.75);

    const overview = await req(port, { pathname: '/api/overview?period=30d&tz=60' });
    assert.deepEqual(Object.keys(overview.json).sort(), ['allowance', 'byProvider', 'period', 'topModels', 'totals']);
    assert.equal(overview.json.totals.requests, 2);
    assert.equal(overview.json.allowance.length, 1);
    assert.equal(overview.json.topModels.length, 1);
  });
});

test('bad params return fixed error codes without echoing input', async () => {
  await withServer(async ({ port }) => {
    const cases = [
      ['/api/usage?period=1y', 'bad_period'],
      ['/api/usage?period=7d&period=24h', 'bad_period'],
      ['/api/usage?tz=abc', 'bad_tz'],
      ['/api/usage?tz=841', 'bad_tz'],
      ['/api/usage?tz=-841', 'bad_tz'],
      ['/api/usage?tz=1.5', 'bad_tz'],
      ['/api/usage?tz=', 'bad_tz'],
      ['/api/performance?tier=<script>', 'bad_tier'],
      ['/api/overview?period=%3Cx%3E', 'bad_period'],
    ];
    for (const [p, code] of cases) {
      const res = await req(port, { pathname: p });
      assert.equal(res.status, 400, p);
      assert.deepEqual(res.json, { error: code });
    }
    assert.equal((await req(port, { pathname: '/api/usage?tz=840' })).status, 200);
    assert.equal((await req(port, { pathname: '/api/usage?tz=-840' })).status, 200);
    assert.equal((await req(port, { pathname: '/api/nope' })).status, 404);
    assert.equal((await req(port, { method: 'POST', pathname: '/api/usage' })).status, 405);
    assert.equal((await req(port, { method: 'DELETE', pathname: '/api/status' })).status, 405);
  });
});

test('refresh requires POST and X-TiboTattle header', async () => {
  await withServer(async ({ port, monitor }) => {
    assert.equal((await req(port, { method: 'GET', pathname: '/api/refresh' })).status, 405);
    const denied = await req(port, { method: 'POST', pathname: '/api/refresh' });
    assert.equal(denied.status, 403);
    assert.equal((await req(port, { method: 'POST', pathname: '/api/refresh', headers: { 'X-TiboTattle': '0' } })).status, 403);
    assert.equal(monitor.refreshCalls, 0);
    monitor.generation = 7;
    const ok = await req(port, { method: 'POST', pathname: '/api/refresh', headers: { 'X-TiboTattle': '1' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { generation: 7 });
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(monitor.refreshCalls, 1);
  });
});

test('internal errors return a fixed code', async () => {
  await withServer(async ({ port, store }) => {
    store.queryRequests = () => {
      throw new Error('sensitive detail');
    };
    const res = await req(port, { pathname: '/api/usage' });
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'internal' });
  });
});

test('SSE receives change events and is closed by close()', async () => {
  const fakes = makeFakes();
  const server = createServer({ ...fakes, webRoot: null, port: 0, now: () => NOW });
  const { port } = await server.listen();
  const received = await new Promise((resolve, reject) => {
    const r = http.get(
      { host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^text\/event-stream/);
        assert.ok(res.headers['content-security-policy']);
        let buf = '';
        let emitted = false;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          if (!emitted) {
            emitted = true;
            fakes.monitor.emit('change', { generation: 3 });
          }
          if (buf.includes('event: change')) {
            res.on('end', () => resolve(buf));
            server.close();
          }
        });
      },
    );
    r.on('error', reject);
  });
  assert.match(received, /event: change\ndata: \{"generation":3\}\n\n/);
  assert.equal(fakes.monitor.listenerCount('change'), 0);
});
