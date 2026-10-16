// Static checks for the browser dashboard (apps/web). No browser is started:
// these guard the CSP contract (no inline code or styles, no external assets)
// and the XSS rule (no HTML string injection) by reading the source files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const read = (name) => readFileSync(path.join(webRoot, name), 'utf8');

const html = read('index.html');
const js = read('app.js');
const css = read('styles.css');
const favicon = read('favicon.svg');

// Strip comments so prose cannot satisfy or trip the checks.
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('index.html loads app.js as a module and styles.css', () => {
  assert.match(html, /<script\s+type="module"\s+src="app\.js"><\/script>/);
  assert.match(html, /<link\s+rel="stylesheet"\s+href="styles\.css">/);
  assert.match(html, /<link\s+rel="icon"\s+href="favicon\.svg"/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
});

test('index.html has no inline scripts, styles or event handlers', () => {
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scripts.length, 1);
  for (const tag of scripts) {
    assert.match(tag, /\bsrc="[^"]+"/, 'every script must be external');
    assert.match(tag, /><\/script>$/, 'script tags must be empty');
  }
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test('index.html references no external URLs', () => {
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i, `external reference: ${ref}`);
  }
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('index.html CSP meta stays strict', () => {
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, 'CSP meta present');
  const csp = m[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /style-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
});

test('index.html provides navigation for every dashboard route', () => {
  for (const route of ['overview', 'usage', 'performance', 'allowance', 'projects']) {
    assert.match(html, new RegExp(`href="#/${route}"`));
    assert.match(js, new RegExp(`\\b${route}: \\{ title:`));
  }
  for (const period of ['24h', '7d', '30d', 'all']) assert.match(html, new RegExp(`data-period="${period}"`));
  assert.match(html, /id="refresh-button"/);
  assert.match(html, /id="live-status"/);
});

test('app.js parses as an ES module', () => {
  const result = spawnSync(process.execPath, ['--check', path.join(webRoot, 'app.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('app.js never injects HTML strings or evaluates code', () => {
  for (const banned of [
    /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /createContextualFragment/,
    /DOMParser/, /\beval\s*\(/, /new\s+Function\s*\(/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/,
  ]) {
    assert.doesNotMatch(jsCode, banned, `banned pattern ${banned}`);
  }
});

test('app.js does not set inline style attributes (CSP style-src self)', () => {
  assert.doesNotMatch(jsCode, /setAttribute\(\s*['"`]style['"`]/);
  assert.doesNotMatch(jsCode, /\.style\.cssText\b/);
  assert.doesNotMatch(jsCode, /['"`]style['"`]\s*:/);
  assert.doesNotMatch(jsCode, /\sstyle=/);
});

test('app.js makes no external requests', () => {
  const urls = jsCode.match(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi) ?? [];
  assert.deepEqual(urls.filter((u) => u !== 'http://www.w3.org/2000/svg'), []);
  assert.doesNotMatch(jsCode, /\bimport\s*\(/);
  assert.doesNotMatch(jsCode, /^\s*import\s/m);
  for (const m of jsCode.matchAll(/api\(\s*'([^']+)'/g)) assert.match(m[1], /^\/api\/[a-z]+$/);
  assert.match(jsCode, /new EventSource\('\/api\/events'\)/);
});

test('app.js follows the API contract', () => {
  assert.match(jsCode, /-new Date\(\)\.getTimezoneOffset\(\)/, 'sends tz as minutes east of UTC');
  assert.match(jsCode, /searchParams\.set\('tz'/);
  assert.match(jsCode, /\['X-TiboTattle'\] = '1'/, 'mutating requests carry the header');
  assert.match(jsCode, /api\('\/api\/refresh', \{\}, \{ method: 'POST' \}\)/);
  assert.match(jsCode, /addEventListener\('change'/);
});

test('app.js guards localStorage access', () => {
  const uses = [...jsCode.matchAll(/localStorage\.(getItem|setItem|removeItem)/g)];
  assert.ok(uses.length >= 2);
  for (const use of uses) {
    const before = jsCode.slice(Math.max(0, use.index - 120), use.index);
    assert.match(before, /try\s*\{/, 'storage access must be inside try');
  }
});

test('styles.css is self-contained and theme/motion aware', () => {
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /url\(/i);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
});

test('favicon.svg is static', () => {
  assert.match(favicon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(favicon, /<script|<style|<foreignObject|\son[a-z]+=|href=|xlink:/i);
});
