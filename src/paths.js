// omp source locations and the TiboTattle state directory.
//
// Resolution is pure apart from one existence probe (the XDG data directory),
// so callers can pass a synthetic env/home/platform in tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function expandHome(p, value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return p.join(home, value.slice(2));
  return value;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function unique(list) {
  return [...new Set(list)];
}

/**
 * Candidate omp agent directories plus the session roots and agent.db paths
 * inside them. Ordered by preference; existence is not required.
 */
export function resolveOmpSources({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  agentDir,
} = {}) {
  const p = pathApi(platform);
  const agentDirs = [];

  const override = nonEmpty(agentDir) ?? nonEmpty(env.PI_CODING_AGENT_DIR);
  if (override) {
    agentDirs.push(p.resolve(expandHome(p, override, home)));
  } else {
    // omp flattens `agent/` under $XDG_DATA_HOME/omp once migrated; it is only
    // trusted when the directory actually exists.
    const xdgData = nonEmpty(env.XDG_DATA_HOME);
    if (platform === 'linux' && xdgData && p.isAbsolute(xdgData)) {
      const xdgOmp = p.join(xdgData, 'omp');
      if (isDirectory(xdgOmp)) agentDirs.push(p.resolve(xdgOmp));
    }
    const configDir = nonEmpty(env.PI_CONFIG_DIR) ?? '.omp';
    agentDirs.push(p.resolve(home, configDir, 'agent'));
  }

  const dirs = unique(agentDirs);
  return {
    agentDirs: dirs,
    sessionRoots: unique(dirs.map((d) => p.join(d, 'sessions'))),
    agentDbPaths: unique(dirs.map((d) => p.join(d, 'agent.db'))),
  };
}

/** Per-platform directory for TiboTattle's own index and key. */
export function resolveStateDir({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const p = pathApi(platform);
  const override = nonEmpty(env.TIBOTATTLE_STATE_DIR);
  if (override) return p.resolve(expandHome(p, override, home));

  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'TiboTattle');
  if (platform === 'win32') {
    const appData = nonEmpty(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming');
    return p.join(appData, 'TiboTattle');
  }
  const xdgState = nonEmpty(env.XDG_STATE_HOME);
  const base = xdgState && p.isAbsolute(xdgState) ? xdgState : p.join(home, '.local', 'state');
  return p.join(base, 'tibotattle');
}

/** mkdir -p with owner-only permissions for newly created directories. */
export function ensureStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
