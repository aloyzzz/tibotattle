// Loopback HTTP server: static dashboard, JSON API and SSE change events.
//
// Security contract:
// - Binds 127.0.0.1 only; any other host option throws.
// - Host header must be exactly `127.0.0.1:<port>` or `localhost:<port>`
//   (DNS-rebinding defense), otherwise 403.
// - Static files come from a fixed allowlist; request paths are never joined
//   onto the filesystem.
// - The only mutating route is POST /api/refresh and it requires
//   `X-TiboTattle: 1`.
// - Error bodies are fixed codes; request input is never echoed.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PERIODS, resolvePeriod } from './analysis/period.js';
import { summarizeUsage } from './analysis/usage.js';
import { summarizePerformance, TIER_FILTERS } from './analysis/performance.js';
import { summarizeAllowance } from './analysis/allowance.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

// URL pathname -> [fixed file name inside webRoot, content type]
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const GET_ROUTES = new Set([
  '/api/status', '/api/usage', '/api/performance', '/api/allowance', '/api/overview', '/api/events',
]);

const ALLOWANCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SSE_PING_MS = 25 * 1000;
const MAX_SSE_CLIENTS = 32;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function single(params, name) {
  const all = params.getAll(name);
  if (all.length > 1) return { dup: true, value: null };
  return { dup: false, value: all.length ? all[0] : null };
}

export function parseQuery(params) {
  const p = single(params, 'period');
  if (p.dup || (p.value != null && !PERIODS.includes(p.value))) throw new HttpError(400, 'bad_period');
  const t = single(params, 'tz');
  let tz = 0;
  if (t.dup) throw new HttpError(400, 'bad_tz');
  if (t.value != null) {
    if (!/^-?\d{1,3}$/.test(t.value)) throw new HttpError(400, 'bad_tz');
    tz = Number(t.value);
    if (tz < -840 || tz > 840) throw new HttpError(400, 'bad_tz');
    if (Object.is(tz, -0)) tz = 0;
  }
  const r = single(params, 'tier');
  if (r.dup || (r.value != null && !TIER_FILTERS.includes(r.value))) throw new HttpError(400, 'bad_tier');
  return { period: p.value ?? '7d', tz, tier: r.value ?? 'all' };
}

export function createServer({ monitor, store, webRoot, host = '127.0.0.1', port = 8787, now = Date.now } = {}) {
  if (host !== '127.0.0.1') throw new Error('TiboTattle binds 127.0.0.1 only');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('invalid port');
  if (!monitor || !store) throw new TypeError('monitor and store are required');

  const sseClients = new Set();
  let boundPort = null;
  let allowedHosts = new Set();

  function send(res, status, body, extraHeaders = {}) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }

  function rows(fromMs, toMs) {
    return Array.from(store.queryRequests({ fromMs, toMs }) ?? []);
  }

  function usageFor(q) {
    const period = resolvePeriod(q.period, now());
    const data = rows(period.fromMs, period.toMs);
    return { period, data };
  }

  function allowanceSeries() {
    const nowMs = now();
    const snaps = Array.from(store.querySnapshots({ fromMs: nowMs - ALLOWANCE_WINDOW_MS, toMs: nowMs + 1 }) ?? []);
    return { nowMs, series: summarizeAllowance(snaps, { nowMs }) };
  }

  async function serveStatic(req, res, entry) {
    const [file, type] = entry;
    if (!webRoot) throw new HttpError(404, 'not_found');
    let body;
    try {
      body = await fs.readFile(path.join(webRoot, file));
    } catch {
      throw new HttpError(404, 'not_found');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function openEvents(req, res) {
    if (sseClients.size >= MAX_SSE_CLIENTS) throw new HttpError(503, 'too_many_clients');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 5000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    ping.unref?.();
    const client = { res, ping };
    sseClients.add(client);
    const cleanup = () => {
      clearInterval(ping);
      sseClients.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  function onChange(evt) {
    const generation = Number.isSafeInteger(evt?.generation) ? evt.generation : null;
    const frame = `event: change\ndata: ${JSON.stringify({ generation })}\n\n`;
    for (const c of sseClients) c.res.write(frame);
  }

  async function route(req, res) {
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || !allowedHosts.has(hostHeader)) {
      throw new HttpError(403, 'forbidden_host');
    }
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      throw new HttpError(400, 'bad_request');
    }
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/api/refresh') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      req.resume();
      if (req.headers['x-tibotattle'] !== '1') throw new HttpError(403, 'missing_header');
      const result = await monitor.refresh({ reason: 'api' });
      return send(res, 200, { generation: result?.generation ?? null });
    }

    const staticEntry = STATIC_FILES.get(pathname);
    if (!staticEntry && !GET_ROUTES.has(pathname)) throw new HttpError(404, 'not_found');
    if (method !== 'GET' && !(method === 'HEAD' && staticEntry)) {
      throw new HttpError(405, 'method_not_allowed');
    }
    if (staticEntry) return serveStatic(req, res, staticEntry);

    const q = parseQuery(url.searchParams);
    switch (pathname) {
      case '/api/status':
        return send(res, 200, monitor.status());
      case '/api/usage': {
        const { period, data } = usageFor(q);
        return send(res, 200, { period, ...summarizeUsage(data, { tzOffsetMinutes: q.tz, labels: monitor.labels }) });
      }
      case '/api/performance': {
        const { period, data } = usageFor(q);
        return send(res, 200, { period, ...summarizePerformance(data, { tzOffsetMinutes: q.tz, serviceTier: q.tier }) });
      }
      case '/api/allowance':
        return send(res, 200, allowanceSeries());
      case '/api/overview': {
        const { period, data } = usageFor(q);
        const usage = summarizeUsage(data, { tzOffsetMinutes: q.tz, labels: monitor.labels });
        const perf = summarizePerformance(data, { tzOffsetMinutes: q.tz });
        return send(res, 200, {
          period,
          totals: usage.totals,
          byProvider: usage.byProvider,
          allowance: allowanceSeries().series,
          topModels: perf.models.slice(0, 5),
        });
      }
      case '/api/events':
        return openEvents(req, res);
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof HttpError) {
        const extra = err.status === 405 ? { Allow: req.url?.startsWith('/api/refresh') ? 'POST' : 'GET, HEAD' } : {};
        send(res, err.status, { error: err.code }, extra);
      } else {
        send(res, 500, { error: 'internal' });
      }
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        boundPort = server.address().port;
        allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
        monitor.on('change', onChange);
        resolve({ port: boundPort, url: `http://127.0.0.1:${boundPort}/` });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  function close() {
    monitor.off?.('change', onChange);
    for (const c of sseClients) {
      clearInterval(c.ping);
      c.res.end();
    }
    sseClients.clear();
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { listen, close };
}
