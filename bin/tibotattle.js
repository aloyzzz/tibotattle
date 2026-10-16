#!/usr/bin/env node
// TiboTattle CLI: serve, scan, report, doctor.
// Errors are reported as fixed codes only; paths, stack traces and session
// content are never printed (paths only with `doctor --show-paths`).

import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// node:sqlite is stable in behavior for our use but still flagged experimental
// in Node 22; hide only that one warning and keep every other warning visible.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener.call(process, warning);
});

const WEB_ROOT =fileURLToPath(new URL('../apps/web/', import.meta.url));
const INDEX_FILE = 'index.sqlite';
const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE = `Usage: tibotattle <command> [options]

Commands:
  serve     Index omp sessions and serve the dashboard on 127.0.0.1
  scan      Refresh the local index once and print counts
  report    Refresh, then print a usage, speed and allowance summary
  doctor    Check omp sources, Node.js, SQLite and the local index

Options:
  --agent-dir DIR   omp agent directory (overrides PI_CODING_AGENT_DIR)
  --state-dir DIR   TiboTattle state directory (overrides TIBOTATTLE_STATE_DIR)
  --port N          serve: loopback port (default 8787, 0 = any free port)
  --period P        report: 24h | 7d | 30d | all (default 7d)
  --json            report: print JSON instead of a table
  --show-paths      doctor: include local paths in the output
  -h, --help        Show this help
`;

class CliError extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const OPTIONS = {
  'agent-dir': { type: 'string' },
  'state-dir': { type: 'string' },
  port: { type: 'string' },
  period: { type: 'string' },
  json: { type: 'boolean' },
  'show-paths': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const COMMAND_OPTIONS = {
  serve: ['agent-dir', 'state-dir', 'port'],
  scan: ['agent-dir', 'state-dir', 'json'],
  report: ['agent-dir', 'state-dir', 'period', 'json'],
  doctor: ['agent-dir', 'state-dir', 'show-paths', 'json'],
};

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    throw new CliError('usage', 2);
  }
  const { values, positionals } = parsed;
  if (values.help && positionals.length === 0) return { command: 'help', values };
  if (positionals.length !== 1) throw new CliError('usage', 2);
  const command = positionals[0];
  if (command === 'help' || values.help) return { command: 'help', values };
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new CliError('usage', 2);
  for (const name of Object.keys(values)) {
    if (name !== 'help' && !allowed.includes(name)) throw new CliError('usage', 2);
  }
  return { command, values };
}

// ---------------------------------------------------------------------------
// Shared setup

async function loadCore() {
  try {
    const [paths, secret, store, monitor] = await Promise.all([
      import('../src/paths.js'),
      import('../src/secret.js'),
      import('../src/store.js'),
      import('../src/monitor.js'),
    ]);
    return { paths, secret, store, monitor };
  } catch (error) {
    throw mapError(error);
  }
}

function resolveSources(paths, values) {
  const agentDir = values['agent-dir'] ? path.resolve(values['agent-dir']) : undefined;
  return paths.resolveOmpSources({ agentDir });
}

function resolveState(paths, values) {
  return values['state-dir'] ? path.resolve(values['state-dir']) : paths.resolveStateDir();
}

async function openRuntime(values) {
  const core = await loadCore();
  const sources = resolveSources(core.paths, values);
  let stateDir;
  let key;
  try {
    stateDir = core.paths.ensureStateDir(resolveState(core.paths, values));
    key = core.secret.loadOrCreateKey(stateDir);
  } catch {
    throw new CliError('state_dir_unavailable');
  }
  const store = core.store.openStore(path.join(stateDir, INDEX_FILE));
  const monitor = core.monitor.createMonitor({ store, key, sources });
  return { core, sources, stateDir, key, store, monitor };
}

function mapError(error) {
  if (error instanceof CliError) return error;
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code === 'store_newer') return new CliError('store_newer');
  if (code === 'EADDRINUSE') return new CliError('port_in_use');
  if (code === 'EACCES' || code === 'EPERM') return new CliError('permission_denied');
  if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || code === 'ERR_NO_SQLITE') {
    return new CliError('sqlite_unavailable');
  }
  if (code === 'ERR_MODULE_NOT_FOUND') return new CliError('module_missing');
  if (error instanceof RangeError) return new CliError('usage', 2);
  return new CliError('internal_error');
}

function errorCodeOf(result) {
  return result && typeof result === 'object' && typeof result.lastError === 'string'
    ? result.lastError
    : null;
}

// ---------------------------------------------------------------------------
// Commands

async function commandServe(values) {
  const port = parsePort(values.port);
  const rt = await openRuntime(values);
  const { createServer } = await import('../src/server.js');

  await rt.monitor.refresh({ reason: 'startup' });
  Promise.resolve(rt.monitor.start()).catch(() => {});
  const server = createServer({ monitor: rt.monitor, store: rt.store, webRoot: WEB_ROOT, port });
  let address;
  try {
    address = await server.listen();
  } catch (error) {
    rt.monitor.stop();
    rt.store.close();
    throw mapError(error);
  }
  const counts = rt.store.counts();
  process.stdout.write(
    `TiboTattle is serving ${address.url}\n` +
      `Indexed ${counts.requests} requests and ${counts.snapshots} allowance snapshots. ` +
      'Press Ctrl+C to stop.\n',
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    try {
      rt.monitor.stop();
      await server.close();
    } finally {
      rt.store.close();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function parsePort(raw) {
  if (raw === undefined) return 8787;
  if (!/^\d{1,5}$/.test(raw)) throw new CliError('usage', 2);
  const port = Number(raw);
  if (port > 65535) throw new CliError('usage', 2);
  return port;
}

async function commandScan(values) {
  const rt = await openRuntime(values);
  try {
    const result = await rt.monitor.refresh({ reason: 'scan' });
    const status = rt.monitor.status();
    const sessions = result?.sessions ?? {};
    const quota = result?.quota ?? {};
    const summary = {
      filesSeen: sessions.filesSeen ?? 0,
      filesRead: sessions.filesRead ?? 0,
      requestsAdded: sessions.requestsAdded ?? 0,
      linesSkipped: sessions.linesSkipped ?? 0,
      quota: quota.status ?? status.sources?.agentDb ?? 'missing',
      snapshotsAdded: quota.added ?? 0,
      counts: rt.store.counts(),
      lastError: errorCodeOf(status),
    };
    if (values.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Session files: ${summary.filesSeen} seen, ${summary.filesRead} read\n` +
          `Requests added: ${summary.requestsAdded} (skipped lines: ${summary.linesSkipped})\n` +
          `Allowance source: ${summary.quota}, snapshots added: ${summary.snapshotsAdded}\n` +
          `Index: ${summary.counts.requests} requests, ${summary.counts.snapshots} snapshots, ` +
          `${summary.counts.files} files\n` +
          (summary.lastError ? `Last error: ${summary.lastError}\n` : ''),
      );
    }
  } finally {
    rt.store.close();
  }
}

async function commandReport(values) {
  const periodName = values.period ?? '7d';
  const [period, usage, performance, allowance] = await Promise.all([
    import('../src/analysis/period.js'),
    import('../src/analysis/usage.js'),
    import('../src/analysis/performance.js'),
    import('../src/analysis/allowance.js'),
  ]).catch((error) => {
    throw mapError(error);
  });
  if (!period.PERIODS.includes(periodName)) throw new CliError('usage', 2);

  const rt = await openRuntime(values);
  try {
    await rt.monitor.refresh({ reason: 'report' });
    const nowMs = Date.now();
    const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();
    const range = period.resolvePeriod(periodName, nowMs);
    const rows = Array.from(rt.store.queryRequests({ fromMs: range.fromMs, toMs: range.toMs }));
    const u = usage.summarizeUsage(rows, { tzOffsetMinutes, labels: rt.monitor.labels });
    const p = performance.summarizePerformance(rows, { tzOffsetMinutes });
    const snaps = Array.from(rt.store.querySnapshots({ fromMs: nowMs - 30 * DAY_MS, toMs: nowMs + 1 }));
    const series = allowance.summarizeAllowance(snaps, { nowMs });

    if (values.json) {
      const out = {
        period: range,
        totals: u.totals,
        byProvider: u.byProvider,
        byModel: u.byModel,
        performance: p.models.map(({ daily, ...rest }) => rest),
        allowance: series.map(({ history, ...rest }) => rest),
      };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    process.stdout.write(renderReport(periodName, u, p, series, nowMs));
  } finally {
    rt.store.close();
  }
}

async function commandDoctor(values) {
  const lines = [];
  const report = { node: process.versions.node, nodeSupported: nodeSupported(), sqlite: 'unavailable' };
  const show = Boolean(values['show-paths']);

  try {
    await import('node:sqlite');
    report.sqlite = 'available';
  } catch {
    report.sqlite = 'unavailable';
  }

  let paths;
  try {
    paths = await import('../src/paths.js');
  } catch (error) {
    throw mapError(error);
  }
  const sources = resolveSources(paths, values);
  report.sessionRoots = sources.sessionRoots.map((p) => ({ status: dirStatus(p), ...(show ? { path: p } : {}) }));
  report.agentDb = sources.agentDbPaths.map((p) => ({ status: fileStatus(p), ...(show ? { path: p } : {}) }));

  const stateDir = resolveState(paths, values);
  const indexFile = path.join(stateDir, INDEX_FILE);
  report.stateDir = { status: dirStatus(stateDir), ...(show ? { path: stateDir } : {}) };
  report.index = { status: existsSync(indexFile) ? 'present' : 'missing' };

  if (report.index.status === 'present' && report.sqlite === 'available') {
    try {
      const { openStore } = await import('../src/store.js');
      const store = openStore(indexFile);
      try {
        report.index.counts = store.counts();
        report.index.status = 'ok';
      } finally {
        store.close();
      }
    } catch (error) {
      report.index.status = mapError(error).code;
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  lines.push(`Node.js        ${report.node} (${report.nodeSupported ? 'supported' : 'requires 22.13 or newer'})`);
  lines.push(`node:sqlite    ${report.sqlite}`);
  report.sessionRoots.forEach((r, i) => lines.push(`sessions[${i}]    ${r.status}${r.path ? `  ${r.path}` : ''}`));
  report.agentDb.forEach((r, i) => lines.push(`agent.db[${i}]    ${r.status}${r.path ? `  ${r.path}` : ''}`));
  lines.push(`state dir      ${report.stateDir.status}${report.stateDir.path ? `  ${report.stateDir.path}` : ''}`);
  const c = report.index.counts;
  lines.push(
    `index          ${report.index.status}` +
      (c ? `  (${c.requests} requests, ${c.snapshots} snapshots, ${c.files} files)` : ''),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

function nodeSupported() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function dirStatus(p) {
  try {
    if (!statSync(p).isDirectory()) return 'not_a_directory';
    accessSync(p, fsConstants.R_OK | fsConstants.X_OK);
    return 'readable';
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

function fileStatus(p) {
  try {
    if (!statSync(p).isFile()) return 'not_a_file';
    accessSync(p, fsConstants.R_OK);
    return 'readable';
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// Text rendering

function fmtInt(n) {
  return n == null ? '-' : Math.round(n).toLocaleString('en-US');
}

function fmtTokens(n) {
  if (n == null) return '-';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return fmtInt(n);
}

function fmtCost(t) {
  if (!t || t.pricedRequests === 0) return 'unpriced';
  const cost = `$${(t.costUsd ?? 0).toFixed(2)}`;
  return t.unpricedRequests > 0 ? `${cost}+` : cost;
}

function fmtPct(f) {
  return f == null ? '-' : `${Math.round(f * 100)}%`;
}

function fmtNum(n, digits = 1) {
  return n == null ? '-' : n.toFixed(digits);
}

function fmtWhen(ms, nowMs) {
  if (ms == null) return '-';
  const diff = ms - nowMs;
  const abs = Math.abs(diff);
  const h = abs / 3_600_000;
  const text = h >= 48 ? `${Math.round(h / 24)}d` : h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(abs / 60_000)}m`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) =>
    cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function renderReport(periodName, u, p, series, nowMs) {
  const t = u.totals;
  const out = [];
  out.push(`TiboTattle report: ${periodName}`);
  out.push('');
  out.push(
    `Requests ${fmtInt(t.requests)}  sessions ${fmtInt(t.sessions)}  tokens ${fmtTokens(t.totalTokens)}  ` +
      `cost ${fmtCost(t)}  cache hit ${fmtPct(t.cacheHitRate)}  errors ${fmtInt(t.errorRequests)}`,
  );
  if (t.unpricedRequests > 0) out.push(`(${fmtInt(t.unpricedRequests)} requests unpriced; cost excludes them)`);

  if (u.byProvider.length) {
    out.push('', 'By provider');
    out.push(
      table(
        ['provider', 'requests', 'input', 'output', 'cache read', 'total', 'cost'],
        u.byProvider.map((r) => [
          r.provider,
          fmtInt(r.requests),
          fmtTokens(r.input),
          fmtTokens(r.output),
          fmtTokens(r.cacheRead),
          fmtTokens(r.totalTokens),
          fmtCost(r),
        ]),
      ),
    );
  }

  if (u.byModel.length) {
    const perf = new Map(p.models.map((m) => [`${m.provider}\0${m.model}`, m]));
    out.push('', 'By model');
    out.push(
      table(
        ['provider/model', 'requests', 'total', 'cost', 'decode tok/s', 'TTFT ms'],
        u.byModel.map((r) => {
          const m = perf.get(`${r.provider}\0${r.model}`);
          return [
            `${r.provider}/${r.model}`,
            fmtInt(r.requests),
            fmtTokens(r.totalTokens),
            fmtCost(r),
            fmtNum(m?.decodeTps?.median),
            fmtNum(m?.ttftMs?.median, 0),
          ];
        }),
      ),
    );
  }

  out.push('', 'Allowance');
  if (!series.length) {
    out.push('No allowance snapshots. omp records them only for subscription providers it checks.');
  } else {
    out.push(
      table(
        ['account', 'limit', 'remaining', 'resets', 'updated', 'pace'],
        series.map((s) => [
          s.accountLabel,
          s.windowLabel ? `${s.label} (${s.windowLabel})` : s.label,
          fmtPct(s.remainingFraction),
          fmtWhen(s.resetsAt, nowMs),
          `${fmtWhen(s.recordedAt, nowMs)}${s.stale ? ' (stale)' : ''}`,
          !s.pace
            ? '-'
            : s.pace.exhaustsBeforeReset
              ? `runs out ${fmtWhen(s.pace.projectedExhaustAt, nowMs)}`
              : 'lasts to reset',
        ]),
      ),
    );
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const { command, values } = parseCli(argv);
  switch (command) {
    case 'help':
      process.stdout.write(USAGE);
      return;
    case 'serve':
      return commandServe(values);
    case 'scan':
      return commandScan(values);
    case 'report':
      return commandReport(values);
    case 'doctor':
      return commandDoctor(values);
    default:
      throw new CliError('usage', 2);
  }
}

main(process.argv.slice(2)).catch((error) => {
  const mapped = mapError(error);
  if (mapped.code === 'usage') process.stderr.write(USAGE);
  else process.stderr.write(`tibotattle: error ${mapped.code}\n`);
  process.exitCode = mapped.exitCode;
});
