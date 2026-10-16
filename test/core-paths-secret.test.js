import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ensureStateDir, resolveOmpSources, resolveStateDir } from '../src/paths.js';
import { keyed, loadOrCreateKey } from '../src/secret.js';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-paths-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('default omp agent dir is ~/.omp/agent', () => {
  const home = path.join(tmp, 'home');
  const out = resolveOmpSources({ env: {}, home, platform: 'linux' });
  assert.deepEqual(out.agentDirs, [path.join(home, '.omp', 'agent')]);
  assert.deepEqual(out.sessionRoots, [path.join(home, '.omp', 'agent', 'sessions')]);
  assert.deepEqual(out.agentDbPaths, [path.join(home, '.omp', 'agent', 'agent.db')]);
});

test('PI_CONFIG_DIR renames the config root', () => {
  const home = path.join(tmp, 'home');
  const out = resolveOmpSources({ env: { PI_CONFIG_DIR: '.pi' }, home, platform: 'darwin' });
  assert.deepEqual(out.agentDirs, [path.join(home, '.pi', 'agent')]);
});

test('PI_CODING_AGENT_DIR and agentDir override everything', () => {
  const home = path.join(tmp, 'home');
  const xdg = path.join(tmp, 'xdg-data');
  fs.mkdirSync(path.join(xdg, 'omp'), { recursive: true });
  const env = { PI_CODING_AGENT_DIR: path.join(tmp, 'custom'), XDG_DATA_HOME: xdg };
  assert.deepEqual(resolveOmpSources({ env, home, platform: 'linux' }).agentDirs, [path.join(tmp, 'custom')]);
  const cli = resolveOmpSources({ env, home, platform: 'linux', agentDir: path.join(tmp, 'cli') });
  assert.deepEqual(cli.agentDirs, [path.join(tmp, 'cli')]);
  assert.deepEqual(cli.sessionRoots, [path.join(tmp, 'cli', 'sessions')]);
});

test('XDG data dir is checked on Linux only when it exists', () => {
  const home = path.join(tmp, 'home');
  const missing = path.join(tmp, 'xdg-missing');
  const none = resolveOmpSources({ env: { XDG_DATA_HOME: missing }, home, platform: 'linux' });
  assert.deepEqual(none.agentDirs, [path.join(home, '.omp', 'agent')]);

  const xdg = path.join(tmp, 'xdg-present');
  fs.mkdirSync(path.join(xdg, 'omp'), { recursive: true });
  const found = resolveOmpSources({ env: { XDG_DATA_HOME: xdg }, home, platform: 'linux' });
  assert.deepEqual(found.agentDirs, [path.join(xdg, 'omp'), path.join(home, '.omp', 'agent')]);
  assert.deepEqual(found.sessionRoots[0], path.join(xdg, 'omp', 'sessions'));
  assert.deepEqual(found.agentDbPaths[0], path.join(xdg, 'omp', 'agent.db'));

  const mac = resolveOmpSources({ env: { XDG_DATA_HOME: xdg }, home, platform: 'darwin' });
  assert.equal(mac.agentDirs.length, 1);
});

test('state dir per platform and override', () => {
  assert.equal(
    resolveStateDir({ env: { TIBOTATTLE_STATE_DIR: path.join(tmp, 's') }, home: '/h', platform: 'linux' }),
    path.join(tmp, 's'),
  );
  assert.equal(
    resolveStateDir({ env: {}, home: '/h', platform: 'darwin' }),
    '/h/Library/Application Support/TiboTattle',
  );
  assert.equal(
    resolveStateDir({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u', platform: 'win32' }),
    'C:\\Users\\u\\AppData\\Roaming\\TiboTattle',
  );
  assert.equal(resolveStateDir({ env: {}, home: '/h', platform: 'linux' }), '/h/.local/state/tibotattle');
  assert.equal(
    resolveStateDir({ env: { XDG_STATE_HOME: '/xs' }, home: '/h', platform: 'linux' }),
    '/xs/tibotattle',
  );
});

test('ensureStateDir creates an owner-only directory', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp, 'state', 'nested');
  assert.equal(ensureStateDir(dir), dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(ensureStateDir(dir), dir);
});

test('key is created with mode 0600 and reused', () => {
  const dir = ensureStateDir(path.join(tmp, 'keydir'));
  const first = loadOrCreateKey(dir);
  assert.equal(first.length, 32);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'identity.key')).mode & 0o777, 0o600);
  }
  const second = loadOrCreateKey(dir);
  assert.deepEqual(second, first);
});

test('malformed key fails with a fixed code', () => {
  const dir = ensureStateDir(path.join(tmp, 'badkey'));
  fs.writeFileSync(path.join(dir, 'identity.key'), 'short');
  assert.throws(() => loadOrCreateKey(dir), (error) => error.code === 'key_invalid' && error.message === 'key_invalid');
});

test('keyed digests are deterministic, domain-separated and 22 chars', () => {
  const key = Buffer.alloc(32, 7);
  const a = keyed(key, 'file', 'value');
  assert.equal(a, keyed(key, 'file', 'value'));
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, keyed(key, 'session', 'value'));
  assert.notEqual(a, keyed(Buffer.alloc(32, 8), 'file', 'value'));
});
