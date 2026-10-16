// TiboTattle dashboard for oh-my-pi. Single ES module, no build step, no
// external assets. Every data value reaches the DOM through textContent or
// SVG text nodes; nothing is parsed as HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';
const DASH = '—';
const PERIODS = ['24h', '7d', '30d', 'all'];
const PERIOD_TEXT = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all recorded time' };
const BASE_TIERS = ['all', 'unreported', 'default', 'priority', 'ultrafast', 'flex'];
const KNOWN_TIERS = ['all', 'unreported', 'auto', 'default', 'flex', 'scale', 'priority', 'ultrafast'];
const AGENT_TYPES = { main: 'Main agent', subagent: 'Subagent', advisor: 'Advisor' };
const TOKEN_SERIES = [
  { key: 'input', label: 'Input', cls: 's1' },
  { key: 'output', label: 'Output', cls: 's2' },
  { key: 'cacheRead', label: 'Cache read', cls: 's3' },
  { key: 'cacheWrite', label: 'Cache write', cls: 's4' },
];

// ---------------------------------------------------------------------------
// Preferences (per-viewer conveniences only)

const prefs = {
  get(name, allowed, fallback) {
    try {
      const value = window.localStorage.getItem(`tibotattle.${name}`);
      return allowed.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  },
  set(name, value) {
    try {
      window.localStorage.setItem(`tibotattle.${name}`, value);
    } catch {
      // Storage unavailable (private mode, blocked site data); keep in memory only.
    }
  },
};

const state = {
  period: prefs.get('period', PERIODS, '7d'),
  tier: prefs.get('tier', KNOWN_TIERS, 'all'),
  modelKey: null,
  seq: 0,
  controller: null,
  shownRoute: null,
};

// ---------------------------------------------------------------------------
// DOM helpers

function applyProps(el, props) {
  if (!props) return;
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === 'text') el.textContent = String(value);
    else if (name === 'dataset') Object.assign(el.dataset, value);
    else if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

const $ = (selector, root = document) => root.querySelector(selector);
const arr = (value) => (Array.isArray(value) ? value : []);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

// ---------------------------------------------------------------------------
// Formatting. Missing evidence renders as an em dash or "unpriced", never 0.

function trimZero(text) {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

function fmtInt(n) {
  return isNum(n) ? Math.round(n).toLocaleString('en-US') : DASH;
}

function fmtCompact(n) {
  if (!isNum(n)) return DASH;
  const abs = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (let i = 0; i < units.length; i += 1) {
    const [div, unit] = units[i];
    if (abs >= div * 0.9995) {
      const v = n / div;
      if (Math.abs(v) >= 999.5 && i > 0) return `${trimZero((n / units[i - 1][0]).toFixed(1))}${units[i - 1][1]}`;
      return `${Math.abs(v) >= 100 ? Math.round(v) : trimZero(v.toFixed(1))}${unit}`;
    }
  }
  return String(Math.round(n));
}

function fmtUsd(v) {
  if (!isNum(v)) return 'unpriced';
  if (v === 0) return '$0.00';
  const abs = Math.abs(v);
  if (abs < 0.0001) return '<$0.0001';
  const max = abs >= 1 ? 2 : abs >= 0.1 ? 3 : 4;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })}`;
}

function fmtPct(fraction, { digits } = {}) {
  if (!isNum(fraction)) return DASH;
  const pct = fraction * 100;
  const d = digits ?? (Math.abs(pct) < 10 && pct !== 0 ? 1 : 0);
  return `${trimZero(pct.toFixed(d))}%`;
}

function fmtMs(ms) {
  if (!isNum(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${trimZero((ms / 1000).toFixed(ms < 10000 ? 2 : 1))} s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
}

function fmtTps(v) {
  if (!isNum(v)) return DASH;
  return v >= 100 ? String(Math.round(v)) : trimZero(v.toFixed(1));
}

function fmtDuration(ms) {
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ${min % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function fmtCountdown(atMs, now = Date.now()) {
  if (!isNum(atMs)) return 'Reset time not reported';
  const diff = atMs - now;
  if (diff <= 0) return 'Reset due now';
  return `Resets in ${fmtDuration(diff)}`;
}

function fmtAgo(atMs, now = Date.now()) {
  if (!isNum(atMs)) return DASH;
  const diff = now - atMs;
  if (diff < 60000) return 'just now';
  return `${fmtDuration(diff)} ago`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekdayTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLongFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function fmtWhen(ms, now = Date.now()) {
  if (!isNum(ms)) return DASH;
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  if (sameDay) return `${timeFmt.format(ms)} today`;
  if (Math.abs(ms - now) < 6 * 86400000) return weekdayTimeFmt.format(ms);
  return dateTimeFmt.format(ms);
}

function periodText(period) {
  const name = period && typeof period === 'object' ? period.name : period;
  const base = PERIOD_TEXT[name] ?? PERIOD_TEXT[state.period];
  if (!period || typeof period !== 'object' || !isNum(period.toMs)) return base;
  if (!isNum(period.fromMs) || period.fromMs <= 0) return `${base} (through ${fmtWhen(period.toMs)})`;
  return `${base} (${dateTimeFmt.format(period.fromMs)} – ${dateTimeFmt.format(period.toMs)})`;
}

function unknownTokensNote(t) {
  return t && isNum(t.unknownTokenRequests) && t.unknownTokenRequests > 0
    ? `${fmtInt(t.unknownTokenRequests)} requests without token counts`
    : null;
}

function parseDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function dayLabel(day) {
  const t = parseDay(day);
  return t == null ? String(day) : dayFmt.format(t);
}
function dayLabelLong(day) {
  const t = parseDay(day);
  return t == null ? String(day) : dayLongFmt.format(t);
}

function tzOffset() {
  return -new Date().getTimezoneOffset();
}

function costText(t) {
  if (!t || !isNum(t.requests) || t.requests === 0) return DASH;
  if (!isNum(t.pricedRequests) || t.pricedRequests === 0 || !isNum(t.costUsd)) return 'unpriced';
  return fmtUsd(t.costUsd);
}

function unpricedNote(t) {
  if (!t || !isNum(t.unpricedRequests) || t.unpricedRequests <= 0) return null;
  if (!isNum(t.pricedRequests) || t.pricedRequests === 0) return `${fmtInt(t.unpricedRequests)} requests without a price`;
  return `+${fmtInt(t.unpricedRequests)} unpriced`;
}

function costCell(t) {
  const text = costText(t);
  const note = unpricedNote(t);
  return h('span', null,
    h('span', { class: text === 'unpriced' ? 'unpriced' : null, text }),
    note && text !== 'unpriced' ? h('span', { class: 'sub', text: note }) : null);
}

function tokenCell(n) {
  return h('span', { title: isNum(n) ? fmtInt(n) : null, text: fmtCompact(n) });
}

function tierLabel(tier) {
  if (tier == null) return 'Unreported';
  return String(tier).charAt(0).toUpperCase() + String(tier).slice(1);
}

function credentialLabel(row) {
  const provider = row.provider ?? 'unknown provider';
  return row.credentialId == null ? `${provider} · Unattributed` : `${provider} · credential #${row.credentialId}`;
}

function projectLabel(row) {
  return row.label == null || row.label === '' ? 'Unknown project' : String(row.label);
}

// ---------------------------------------------------------------------------
// API

class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function api(path, params = {}, { signal, method = 'GET' } = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  url.searchParams.set('tz', String(tzOffset()));
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-TiboTattle'] = '1';
  let res;
  try {
    res = await fetch(url, { method, headers, signal, cache: 'no-store', credentials: 'same-origin' });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('unreachable', 0);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const code = body && typeof body.error === 'string' ? body.error : `http_${res.status}`;
    throw new ApiError(code, res.status);
  }
  if (!body || typeof body !== 'object') throw new ApiError('bad_response', res.status);
  return body;
}

// ---------------------------------------------------------------------------
// Tooltip shared by all charts

const tooltip = {
  el: null,
  show(head, rows, clientX, clientY) {
    const el = this.el;
    if (!el) return;
    el.replaceChildren(
      h('div', { class: 'tt-head', text: head }),
      ...rows.map((row) => h('div', { class: 'tt-row' },
        h('span', { class: 'k' }, row.cls ? h('span', { class: `swatch ${row.cls}`, 'aria-hidden': 'true' }) : null, row.label),
        h('span', { class: 'v', text: row.value }))),
    );
    el.hidden = false;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = clientX + 14;
    if (left + rect.width > window.innerWidth - pad) left = clientX - rect.width - 14;
    left = Math.max(pad, Math.min(left, window.innerWidth - rect.width - pad));
    let top = clientY - rect.height - 14;
    if (top < pad) top = clientY + 18;
    top = Math.min(top, window.innerHeight - rect.height - pad);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(pad, top))}px`;
  },
  hide() {
    if (this.el) this.el.hidden = true;
  },
};

function announce(text) {
  const live = $('#sr-live');
  if (live) live.textContent = text;
}

// ---------------------------------------------------------------------------
// Charts: inline SVG drawn to the container width, redrawn on resize.

const chartDrawers = new WeakMap();
const chartWidths = new WeakMap();
const chartObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const box = entry.target;
    const draw = chartDrawers.get(box);
    const width = Math.floor(entry.contentRect.width);
    if (!draw || width <= 0 || chartWidths.get(box) === width) continue;
    chartWidths.set(box, width);
    box.replaceChildren(draw(width));
  }
});

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

function niceTicks(maxValue, count = 4) {
  const max = maxValue > 0 ? maxValue : 1;
  const step = niceStep(max / count);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { max: top, ticks };
}

function plotFrame(width, height, { yMax, fmtY, ariaLabel, xTicks }) {
  const m = { t: 10, r: 18, b: 26, l: 50 };
  const pw = Math.max(20, width - m.l - m.r);
  const ph = Math.max(20, height - m.t - m.b);
  const scale = niceTicks(yMax);
  const y = (v) => m.t + ph - (Math.max(0, v) / scale.max) * ph;
  const svg = s('svg', {
    class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}`,
    role: 'img', 'aria-label': ariaLabel, tabindex: '0', focusable: 'true',
  });
  const axes = s('g', { 'aria-hidden': 'true' });
  for (const t of scale.ticks) {
    const yy = Math.round(y(t)) + 0.5;
    axes.append(
      s('line', { class: t === 0 ? 'baseline' : 'grid-line', x1: m.l, x2: m.l + pw, y1: yy, y2: yy }),
      s('text', { class: 'tick', x: m.l - 8, y: yy + 4, 'text-anchor': 'end', text: fmtY(t) }),
    );
  }
  for (const xt of xTicks(m, pw)) {
    axes.append(s('text', { class: 'tick', x: xt.x, y: m.t + ph + 17, 'text-anchor': xt.anchor ?? 'middle', text: xt.text }));
  }
  svg.append(axes);
  return { svg, m, pw, ph, y, scale };
}

// points: [{ x, head, rows: [{label, value, cls?}], onActive?(bool) }]
function attachInteraction(f, points) {
  const { svg, m, ph } = f;
  if (!points.length) return;
  const guide = s('line', { class: 'guide', x1: 0, x2: 0, y1: m.t, y2: m.t + ph, visibility: 'hidden', 'aria-hidden': 'true' });
  svg.append(guide);
  let active = -1;
  const setActive = (i, clientX, clientY, viaKeyboard) => {
    if (active >= 0 && points[active].onActive) points[active].onActive(false);
    active = i;
    const p = points[i];
    guide.setAttribute('x1', p.x);
    guide.setAttribute('x2', p.x);
    guide.setAttribute('visibility', 'visible');
    if (p.onActive) p.onActive(true);
    let cx = clientX;
    let cy = clientY;
    if (cx == null) {
      const rect = svg.getBoundingClientRect();
      cx = rect.left + p.x;
      cy = rect.top + m.t + 24;
    }
    tooltip.show(p.head, p.rows, cx, cy);
    if (viaKeyboard) announce(`${p.head}: ${p.rows.map((r) => `${r.label} ${r.value}`).join(', ')}`);
  };
  const clear = () => {
    if (active >= 0 && points[active].onActive) points[active].onActive(false);
    guide.setAttribute('visibility', 'hidden');
    tooltip.hide();
  };
  const nearest = (x) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const d = Math.abs(points[i].x - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  svg.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width > 0 ? Number(svg.getAttribute('width')) / rect.width : 1;
    setActive(nearest((event.clientX - rect.left) * scaleX), event.clientX, event.clientY, false);
  });
  svg.addEventListener('pointerleave', clear);
  svg.addEventListener('focus', () => setActive(active >= 0 ? active : points.length - 1, null, null, true));
  svg.addEventListener('blur', clear);
  svg.addEventListener('keydown', (event) => {
    let next = active < 0 ? points.length - 1 : active;
    if (event.key === 'ArrowLeft') next = Math.max(0, next - 1);
    else if (event.key === 'ArrowRight') next = Math.min(points.length - 1, next + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = points.length - 1;
    else if (event.key === 'Escape') { clear(); return; }
    else return;
    event.preventDefault();
    setActive(next, null, null, true);
  });
}

function chartFigure({ title, description, height = 220, draw, table, legend }) {
  const canvas = h('div', { class: 'chart-canvas' });
  canvas.style.minHeight = `${height}px`;
  chartDrawers.set(canvas, (width) => draw(width, height));
  chartObserver.observe(canvas);
  return h('figure', { class: 'chart' },
    h('figcaption', null,
      h('span', { class: 'chart-title', text: title }),
      description ? h('span', { class: 'chart-desc', text: description }) : null),
    legend ? h('ul', { class: 'legend', 'aria-label': 'Legend' },
      legend.map((item) => h('li', null, h('span', { class: `swatch ${item.cls}`, 'aria-hidden': 'true' }), item.label))) : null,
    canvas,
    table ? h('details', { class: 'chart-table' },
      h('summary', { text: 'Show data table' }),
      dataTable({ caption: `${title} data`, columns: table.columns, rows: table.rows, captionHidden: true })) : null);
}

// Fill calendar gaps between the first and last reported day so the x-axis is
// continuous. Gap days carry row = null and draw nothing (no invented zeros).
function fillDays(daily) {
  const rows = arr(daily).filter((d) => parseDay(d.day) != null);
  if (rows.length < 2) return rows.map((row) => ({ day: row.day, row }));
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const start = parseDay(rows[0].day);
  const end = parseDay(rows[rows.length - 1].day);
  const span = Math.round((end - start) / 86400000);
  if (span < 0 || span > 800) return rows.map((row) => ({ day: row.day, row }));
  const out = [];
  for (let i = 0; i <= span; i += 1) {
    const day = new Date(start + i * 86400000).toISOString().slice(0, 10);
    out.push({ day, row: byDay.get(day) ?? null });
  }
  return out;
}

function dayTicks(days) {
  return (m, pw) => {
    const n = days.length;
    if (!n) return [];
    const band = pw / n;
    const maxLabels = Math.max(1, Math.floor(pw / 64));
    const step = Math.max(1, Math.ceil(n / maxLabels));
    const ticks = [];
    for (let i = 0; i < n; i += step) ticks.push({ x: m.l + band * (i + 0.5), text: dayLabel(days[i].day) });
    return ticks;
  };
}

function stackedDailyBars(days, { ariaLabel }) {
  return (width, height) => {
    const totals = days.map((d) => (d.row ? TOKEN_SERIES.reduce((sum, ser) => sum + (isNum(d.row[ser.key]) ? d.row[ser.key] : 0), 0) : 0));
    const f = plotFrame(width, height, { yMax: Math.max(0, ...totals), fmtY: fmtCompact, ariaLabel, xTicks: dayTicks(days) });
    const band = f.pw / Math.max(1, days.length);
    const bw = Math.max(1, Math.min(34, band * 0.72));
    const gapped = bw >= 6;
    const points = [];
    days.forEach((d, i) => {
      const cx = f.m.l + band * (i + 0.5);
      const col = s('g', { class: 'bar-col' });
      const rows = TOKEN_SERIES.map((ser) => ({ label: ser.label, value: d.row ? fmtCompact(d.row[ser.key]) : DASH, cls: ser.cls }));
      if (d.row) {
        let acc = 0;
        for (const ser of TOKEN_SERIES) {
          const v = d.row[ser.key];
          if (!isNum(v) || v <= 0) continue;
          const y0 = f.y(acc);
          const y1 = f.y(acc + v);
          col.append(s('rect', { class: `bar ${ser.cls}${gapped ? ' gapped' : ''}`, x: cx - bw / 2, y: y1, width: bw, height: Math.max(0.5, y0 - y1) }));
          acc += v;
        }
        rows.push({ label: 'Total', value: fmtCompact(d.row.totalTokens) });
      } else {
        rows.length = 0;
        rows.push({ label: 'Requests', value: 'none recorded' });
      }
      const head = dayLabelLong(d.day);
      col.append(s('rect', { class: 'hit', x: f.m.l + band * i, y: f.m.t, width: band, height: f.ph },
        s('title', { text: `${head}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}` })));
      f.svg.append(col);
      points.push({ x: cx, head, rows, onActive: (on) => col.classList.toggle('active', on) });
    });
    attachInteraction(f, points);
    return f.svg;
  };
}

// items: [{ key(day), value|null, head, rows }]; x positions are day bands.
function dailyLine(days, { value, fmtY, fmtV, label, cls = '', ariaLabel }) {
  return (width, height) => {
    const values = days.map((d) => (d.row ? value(d.row) : null));
    const finite = values.filter(isNum);
    const f = plotFrame(width, height, { yMax: Math.max(0, ...finite), fmtY, ariaLabel, xTicks: dayTicks(days) });
    const band = f.pw / Math.max(1, days.length);
    const xs = days.map((_, i) => f.m.l + band * (i + 0.5));
    let path = '';
    let open = false;
    values.forEach((v, i) => {
      if (isNum(v)) {
        path += `${open ? 'L' : 'M'}${xs[i].toFixed(1)},${f.y(v).toFixed(1)}`;
        open = true;
      } else open = false;
    });
    if (path) f.svg.append(s('path', { class: `line ${cls}`, d: path }));
    const showAllDots = days.length <= 62;
    const points = [];
    values.forEach((v, i) => {
      const d = days[i];
      const head = dayLabelLong(d.day);
      const rows = d.row ? [{ label, value: fmtV(v, d.row) }] : [{ label, value: 'no data' }];
      if (d.row && d.row.n != null) rows.push({ label: 'Timed requests', value: fmtInt(d.row.n) });
      let dot = null;
      if (isNum(v)) {
        const isolated = !isNum(values[i - 1]) && !isNum(values[i + 1]);
        dot = s('circle', { class: `dot ${cls}`, cx: xs[i], cy: f.y(v), r: showAllDots || isolated ? 3.5 : 0 },
          s('title', { text: `${head}: ${label} ${fmtV(v, d.row)}` }));
        f.svg.append(dot);
      }
      points.push({
        x: xs[i], head, rows,
        onActive: dot ? (on) => { dot.classList.toggle('active', on); if (!showAllDots) dot.setAttribute('r', on ? 4.5 : 0); } : null,
      });
    });
    attachInteraction(f, points);
    return f.svg;
  };
}

function historyArea(history, { ariaLabel }) {
  return (width, height) => {
    const pts = arr(history).filter((p) => isNum(p.t)).sort((a, b) => a.t - b.t);
    const used = pts.map((p) => p.used).filter(isNum);
    const yMax = Math.max(1, ...used);
    let tMin = pts.length ? pts[0].t : Date.now();
    let tMax = pts.length ? pts[pts.length - 1].t : tMin + 3600000;
    if (tMax - tMin < 60000) { tMin -= 1800000; tMax += 1800000; }
    const spanDays = (tMax - tMin) / 86400000;
    const tickFmt = spanDays > 2 ? shortDateFmt : spanDays > 0.9 ? weekdayTimeFmt : timeFmt;
    const xTicks = (m, pw) => {
      const count = Math.max(2, Math.min(5, Math.floor(pw / 110)));
      const out = [];
      for (let i = 0; i < count; i += 1) {
        const t = tMin + ((tMax - tMin) * i) / (count - 1);
        out.push({ x: m.l + (pw * i) / (count - 1), text: tickFmt.format(t), anchor: i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle' });
      }
      return out;
    };
    const f = plotFrame(width, height, { yMax, fmtY: (v) => fmtPct(v, { digits: 0 }), ariaLabel, xTicks });
    const x = (t) => f.m.l + ((t - tMin) / (tMax - tMin)) * f.pw;
    if (f.scale.max > 1) {
      const yy = f.y(1);
      f.svg.append(s('line', { class: 'ref-line', x1: f.m.l, x2: f.m.l + f.pw, y1: yy, y2: yy, 'aria-hidden': 'true' }));
    }
    // Break the area at null readings; never draw them as zero.
    const segments = [];
    let cur = [];
    for (const p of pts) {
      if (isNum(p.used)) cur.push(p);
      else if (cur.length) { segments.push(cur); cur = []; }
    }
    if (cur.length) segments.push(cur);
    for (const seg of segments) {
      const line = seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${f.y(p.used).toFixed(1)}`).join('');
      const base = f.y(0).toFixed(1);
      if (seg.length > 1) {
        f.svg.append(s('path', { class: 'area', d: `${line}L${x(seg[seg.length - 1].t).toFixed(1)},${base}L${x(seg[0].t).toFixed(1)},${base}Z` }));
        f.svg.append(s('path', { class: 'line', d: line }));
      } else {
        f.svg.append(s('circle', { class: 'dot', cx: x(seg[0].t), cy: f.y(seg[0].used), r: 3.5 }));
      }
    }
    const marker = s('circle', { class: 'dot', r: 0, cx: 0, cy: 0, 'aria-hidden': 'true' });
    f.svg.append(marker);
    const points = pts.map((p) => {
      const head = fullFmt.format(p.t);
      return {
        x: x(p.t), head,
        rows: [{ label: 'Used', value: fmtPct(p.used) }, { label: 'Remaining', value: isNum(p.used) ? fmtPct(Math.max(0, 1 - p.used)) : DASH }],
        onActive: (on) => {
          if (!isNum(p.used)) { marker.setAttribute('r', 0); return; }
          marker.setAttribute('cx', x(p.t));
          marker.setAttribute('cy', f.y(p.used));
          marker.setAttribute('r', on ? 4.5 : 0);
        },
      };
    });
    if (pts.length <= 60) {
      const titles = s('g', { 'aria-hidden': 'true' });
      for (const p of pts) {
        if (!isNum(p.used)) continue;
        titles.append(s('circle', { class: 'hit', cx: x(p.t), cy: f.y(p.used), r: 6 }, s('title', { text: `${fullFmt.format(p.t)}: ${fmtPct(p.used)} used` })));
      }
      f.svg.insertBefore(titles, marker);
    }
    attachInteraction(f, points);
    return f.svg;
  };
}

// ---------------------------------------------------------------------------
// Building blocks

function dataTable({ caption, columns, rows, captionHidden = false }) {
  return h('div', { class: 'table-wrap' },
    h('table', null,
      caption ? h('caption', { class: captionHidden ? 'visually-hidden' : null, text: caption }) : null,
      h('thead', null, h('tr', null, columns.map((col, i) => h('th', { scope: 'col', class: col.num ? 'num' : null, text: col.label, 'data-col': i })))),
      h('tbody', null, rows.map((row) => h('tr', null, columns.map((col, i) => {
        const value = col.value(row);
        const cell = i === 0 ? h('th', { scope: 'row' }) : h('td', { class: [col.num ? 'num' : '', col.cls ?? ''].join(' ').trim() || null });
        cell.append(value instanceof Node ? value : document.createTextNode(String(value ?? DASH)));
        return cell;
      }))))));
}

function pageShell(title, sub) {
  return h('section', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h2', { tabindex: '-1', text: title }),
      sub ? h('p', { class: 'page-sub', text: sub }) : null));
}

function section(title, hint, ...children) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', { text: title }), hint ? (hint instanceof Node ? hint : h('p', { class: 'hint', text: hint })) : null),
    children);
}

function emptyState(title, ...lines) {
  return h('div', { class: 'state' }, h('h3', { text: title }), lines.filter(Boolean).map((line) => h('p', { text: line })));
}

function kpi(label, value, note, { muted = false, title } = {}) {
  return h('div', { class: 'card kpi' },
    h('div', { class: 'kpi-label', text: label }),
    h('div', { class: `kpi-value${muted ? ' muted' : ''}`, text: value, title }),
    note ? h('div', { class: 'kpi-note', text: note }) : null);
}

function kpiGrid(t) {
  const cost = costText(t);
  const errors = isNum(t.errorRequests) && t.errorRequests > 0 ? `${fmtInt(t.errorRequests)} ended in error` : null;
  const tokensNote = [
    isNum(t.input) || isNum(t.output) ? `${fmtCompact(t.input)} in · ${fmtCompact(t.output)} out` : null,
    unknownTokensNote(t),
  ].filter(Boolean).join(' · ') || null;
  return h('div', { class: 'grid kpis' },
    kpi('Requests', fmtInt(t.requests), errors),
    kpi('Total tokens', fmtCompact(t.totalTokens), tokensNote, { title: isNum(t.totalTokens) ? `${fmtInt(t.totalTokens)} tokens` : null }),
    kpi('Cost', cost, unpricedNote(t), { muted: cost === 'unpriced' || cost === DASH }),
    kpi('Cache hit rate', fmtPct(t.cacheHitRate), isNum(t.cacheRead) ? `${fmtCompact(t.cacheRead)} cache-read tokens` : null, { muted: !isNum(t.cacheHitRate) }),
    kpi('Sessions', fmtInt(t.sessions), null));
}

function meterTone(series) {
  if (!isNum(series.usedFraction)) return 'unknown';
  const remaining = isNum(series.remainingFraction) ? series.remainingFraction : Math.max(0, 1 - series.usedFraction);
  if (series.usedFraction >= 1 || remaining < 0.1) return 'critical';
  if (remaining < 0.25 || (series.pace && series.pace.exhaustsBeforeReset === true)) return 'warn';
  return 'ok';
}

function meter(series) {
  const remaining = isNum(series.remainingFraction) ? series.remainingFraction : null;
  const tone = meterTone(series);
  const fill = h('div', { class: 'meter-fill' });
  if (remaining != null) fill.style.width = `${Math.max(0, Math.min(1, remaining)) * 100}%`;
  return h('div', {
    class: 'meter', role: 'meter', 'data-tone': tone,
    'aria-label': `${seriesTitle(series)} remaining`,
    'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': remaining != null ? String(Math.round(remaining * 100)) : null,
    'aria-valuetext': remaining != null ? `${fmtPct(remaining)} remaining` : 'No reading',
  }, fill);
}

function seriesTitle(series) {
  const label = series.label ?? series.limitId ?? 'Limit';
  if (series.windowLabel && series.windowLabel !== label) return `${label} · ${series.windowLabel}`;
  return String(label);
}

function countdownEl(resetsAt) {
  const el = h('span', { text: fmtCountdown(resetsAt), title: isNum(resetsAt) ? fullFmt.format(resetsAt) : null });
  if (isNum(resetsAt)) el.dataset.countdown = String(resetsAt);
  return el;
}

function agoEl(at) {
  const el = h('span', { text: fmtAgo(at), title: isNum(at) ? fullFmt.format(at) : null });
  if (isNum(at)) el.dataset.ago = String(at);
  return el;
}

function paceText(series) {
  const p = series.pace;
  if (!p) return null;
  if (p.exhaustsBeforeReset === true && isNum(p.projectedExhaustAt)) {
    return { text: `On pace to run out at ${fmtWhen(p.projectedExhaustAt)}, before reset.`, warn: true };
  }
  if (p.exhaustsBeforeReset == null && isNum(p.projectedExhaustAt)) {
    return { text: `On pace to run out at ${fmtWhen(p.projectedExhaustAt)}.`, warn: true };
  }
  return { text: 'On pace to last until reset.', warn: false };
}

function fmtRate(ratePerHour) {
  return isNum(ratePerHour) ? `${fmtPct(ratePerHour, { digits: ratePerHour < 0.1 ? 1 : 0 })} per hour` : DASH;
}

function allowanceCard(series, { detailed = false } = {}) {
  const remaining = series.remainingFraction;
  const pace = paceText(series);
  const badges = [];
  if (series.stale) badges.push(h('span', { class: 'badge stale', text: 'Stale' }));
  if (series.status) badges.push(h('span', { class: `badge${meterTone(series) === 'critical' ? ' critical' : ''}`, text: String(series.status) }));
  const card = h('article', { class: 'card allowance' },
    h('div', { class: 'allow-head' },
      h('div', null,
        h('div', { class: 'allow-title', text: seriesTitle(series) }),
        detailed ? null : h('div', { class: 'allow-account', text: series.accountLabel ?? series.provider ?? '' })),
      badges.length ? h('div', { class: 'badges' }, badges) : null),
    h('div', { class: 'allow-big' },
      h('span', { class: 'value', text: isNum(remaining) ? fmtPct(remaining, { digits: 0 }) : DASH }),
      h('span', { class: 'unit', text: isNum(remaining) ? 'remaining' : 'no reading' })),
    meter(series),
    h('div', { class: 'allow-meta' },
      countdownEl(series.resetsAt),
      series.stale ? h('span', { class: 'note-strong' }, 'Last reading ', agoEl(series.recordedAt)) : null),
    pace ? h('div', { class: `allow-pace${pace.warn ? ' warn' : ''}`, text: pace.text }) : null);
  if (!detailed) return card;

  const p = series.pace;
  card.append(h('dl', { class: 'dl' },
    h('dt', { text: 'Used' }), h('dd', { text: fmtPct(series.usedFraction) }),
    h('dt', { text: 'Status' }), h('dd', { text: series.status ?? 'Not reported' }),
    h('dt', { text: 'Resets' }), h('dd', { text: isNum(series.resetsAt) ? fullFmt.format(series.resetsAt) : 'Not reported' }),
    h('dt', { text: 'Updated' }), h('dd', null, agoEl(series.recordedAt), series.stale ? ' (stale)' : null),
    h('dt', { text: 'Pace' }), h('dd', { text: p ? fmtRate(p.ratePerHour) : series.stale ? 'Not estimated (stale reading)' : 'Not enough readings since the last reset' }),
    p ? [
      h('dt', { text: 'Projected empty' }), h('dd', { text: isNum(p.projectedExhaustAt) ? fullFmt.format(p.projectedExhaustAt) : DASH }),
      h('dt', { text: 'Before reset' }), h('dd', { text: p.exhaustsBeforeReset == null ? 'Unknown' : p.exhaustsBeforeReset ? 'Yes' : 'No' }),
      h('dt', { text: 'Basis' }), h('dd', { text: `${fmtInt(p.basisPoints)} readings since ${isNum(p.basisStartAt) ? fmtWhen(p.basisStartAt) : DASH}` }),
    ] : null));
  const history = arr(series.history);
  card.append(h('div', { class: 'section' },
    history.length
      ? chartFigure({
        title: 'Used over time',
        description: 'Share of this window used, from omp readings over the last 30 days.',
        height: 150,
        draw: historyArea(history, { ariaLabel: `${seriesTitle(series)}: used fraction over time, ${history.length} readings. Latest ${fmtPct(series.usedFraction)} used.` }),
        table: {
          columns: [
            { label: 'Recorded', value: (r) => fullFmt.format(r.t) },
            { label: 'Used', num: true, value: (r) => fmtPct(r.used) },
          ],
          rows: history.slice().reverse(),
        },
      })
      : h('p', { class: 'note', text: 'No history recorded for this window.' })));
  return card;
}

// ---------------------------------------------------------------------------
// Pages

const DIM_COLUMNS = [
  { label: 'Requests', num: true, value: (r) => fmtInt(r.requests) },
  { label: 'Sessions', num: true, value: (r) => fmtInt(r.sessions) },
  { label: 'Input', num: true, value: (r) => tokenCell(r.input) },
  { label: 'Output', num: true, value: (r) => tokenCell(r.output) },
  { label: 'Cache read', num: true, value: (r) => tokenCell(r.cacheRead) },
  { label: 'Cache write', num: true, value: (r) => tokenCell(r.cacheWrite) },
  { label: 'Total tokens', num: true, value: (r) => h('span', null, tokenCell(r.totalTokens), unknownTokensNote(r) ? h('span', { class: 'sub', text: `+${fmtInt(r.unknownTokenRequests)} uncounted` }) : null) },
  { label: 'Cost', num: true, value: (r) => costCell(r) },
  { label: 'Cache hit', num: true, value: (r) => fmtPct(r.cacheHitRate) },
];

function dimTable(caption, nameLabel, name, rows) {
  if (!rows.length) return h('div', { class: 'card' }, h('h4', { text: caption }), h('p', { class: 'note', text: 'No rows for this period.' }));
  return dataTable({ caption, columns: [{ label: nameLabel, value: name }, ...DIM_COLUMNS], rows });
}

function noRequestsState() {
  return emptyState(`No omp requests in ${PERIOD_TEXT[state.period]}.`,
    'TiboTattle reads the session logs omp writes on this machine. Try a longer period, or run omp and refresh.');
}

async function renderOverview(signal) {
  const d = await api('/api/overview', { period: state.period }, { signal });
  const t = d.totals ?? {};
  const allowance = arr(d.allowance);
  const providers = arr(d.byProvider);
  const models = arr(d.topModels);
  const page = pageShell('Overview', `Activity for ${periodText(d.period)}.`);
  const hasRequests = isNum(t.requests) && t.requests > 0;

  if (!hasRequests && !allowance.length) {
    page.append(noRequestsState());
    return page;
  }

  page.append(section('Allowance', h('a', { href: '#/allowance', text: 'Details' }),
    allowance.length
      ? h('div', { class: 'grid' }, allowance.map((series) => allowanceCard(series)))
      : h('p', { class: 'state compact', text: 'No subscription usage recorded by omp yet.' })));

  if (!hasRequests) {
    page.append(section('Usage', null, noRequestsState()));
    return page;
  }

  page.append(section('Totals', null, kpiGrid(t)));

  const priced = providers.filter((p) => isNum(p.costUsd) && p.pricedRequests > 0);
  const totalCost = priced.reduce((sum, p) => sum + p.costUsd, 0);
  const providerList = h('ul', { class: 'bar-list' }, providers.map((p) => {
    const fill = h('span', { class: 'share-fill' });
    const share = totalCost > 0 && isNum(p.costUsd) && p.pricedRequests > 0 ? p.costUsd / totalCost : 0;
    fill.style.width = `${share * 100}%`;
    const cost = costText(p);
    const note = unpricedNote(p);
    return h('li', null,
      h('div', { class: 'bar-row' },
        h('span', { class: 'name', text: p.provider ?? 'unknown provider' }),
        h('span', { class: 'val' }, h('span', { class: cost === 'unpriced' ? 'unpriced' : null, text: cost }),
          note && cost !== 'unpriced' ? h('span', { class: 'note', text: ` ${note}` }) : null)),
      h('div', { class: 'share', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'note', text: `${fmtInt(p.requests)} requests · ${fmtCompact(p.totalTokens)} tokens` }));
  }));

  const modelTable = models.length
    ? dataTable({
      caption: 'Top models by requests',
      captionHidden: true,
      columns: [
        { label: 'Model', value: (m) => h('span', null, String(m.model ?? DASH), h('span', { class: 'sub', text: m.provider ?? '' })) },
        { label: 'Requests', num: true, value: (m) => fmtInt(m.requests) },
        { label: 'Decode tok/s', num: true, value: (m) => fmtTps(m.decodeTps?.median) },
        { label: 'TTFT', num: true, value: (m) => fmtMs(m.ttftMs?.median) },
      ],
      rows: models,
    })
    : h('p', { class: 'note', text: 'No timed requests in this period.' });

  page.append(h('div', { class: 'grid two section' },
    h('div', { class: 'card' }, h('div', { class: 'section-head' }, h('h3', { text: 'Cost by provider' }), h('a', { href: '#/usage', text: 'Usage & cost' })),
      providers.length ? providerList : h('p', { class: 'note', text: 'No providers in this period.' })),
    h('div', { class: 'card' }, h('div', { class: 'section-head' }, h('h3', { text: 'Top models' }), h('a', { href: '#/performance', text: 'Performance' })),
      h('p', { class: 'note', text: 'Median output speed (decode) and time to first token.' }), modelTable)));
  return page;
}

async function renderUsage(signal) {
  const d = await api('/api/usage', { period: state.period }, { signal });
  const t = d.totals ?? {};
  const page = pageShell('Usage & cost', `Tokens and cost for ${periodText(d.period)}.`);
  if (!isNum(t.requests) || t.requests === 0) {
    page.append(noRequestsState());
    return page;
  }
  page.append(section('Totals', null, kpiGrid(t)));

  const days = fillDays(d.daily);
  const tokenTable = {
    columns: [
      { label: 'Day', value: (r) => dayLabelLong(r.day) },
      ...TOKEN_SERIES.map((ser) => ({ label: ser.label, num: true, value: (r) => fmtInt(r[ser.key]) })),
      { label: 'Total', num: true, value: (r) => fmtInt(r.totalTokens) },
      { label: 'Cost', num: true, value: (r) => costCell(r) },
    ],
    rows: arr(d.daily),
  };
  const anyPriced = arr(d.daily).some((r) => r.pricedRequests > 0);
  page.append(section('By day', null,
    days.length
      ? h('div', { class: 'grid two' },
        h('div', { class: 'card' }, chartFigure({
          title: 'Tokens per day',
          legend: TOKEN_SERIES,
          height: 240,
          draw: stackedDailyBars(days, { ariaLabel: `Stacked bar chart of daily tokens by input, output, cache read and cache write over ${days.length} days.` }),
          table: tokenTable,
        })),
        h('div', { class: 'card' }, chartFigure({
          title: 'Cost per day',
          description: anyPriced ? 'Priced requests only; days with no priced requests are left blank.' : 'No priced requests in this period.',
          height: 240 + 22,
          draw: dailyLine(days, {
            value: (r) => (r.pricedRequests > 0 && isNum(r.costUsd) ? r.costUsd : null),
            fmtY: (v) => (v === 0 ? '$0' : fmtUsd(v)),
            fmtV: (v, r) => (isNum(v) ? `${fmtUsd(v)}${r.unpricedRequests > 0 ? ` (+${r.unpricedRequests} unpriced)` : ''}` : 'unpriced'),
            label: 'Cost',
            ariaLabel: `Line chart of daily cost in US dollars over ${days.length} days.`,
          }),
        })))
      : h('p', { class: 'note', text: 'No daily data.' })));

  page.append(section('Breakdown', null, h('div', { class: 'tables' },
    dimTable('By provider', 'Provider', (r) => String(r.provider ?? DASH), arr(d.byProvider)),
    dimTable('By model', 'Model', (r) => h('span', null, String(r.model ?? DASH), h('span', { class: 'sub', text: r.provider ?? '' })), arr(d.byModel)),
    dimTable('By credential', 'Credential', (r) => credentialLabel(r), arr(d.byCredential)),
    dimTable('By agent type', 'Agent type', (r) => AGENT_TYPES[r.agentType] ?? String(r.agentType ?? DASH), arr(d.byAgentType)),
    dimTable('By service tier', 'Service tier', (r) => tierLabel(r.serviceTier), arr(d.byServiceTier)))));
  return page;
}

function modelKey(m) {
  return `${m.provider ?? ''}\u0000${m.model ?? ''}`;
}

function perfCard(m) {
  const dec = m.decodeTps ?? {};
  const req = m.requestTps ?? {};
  const ttft = m.ttftMs ?? {};
  return h('article', { class: 'card' },
    h('div', { class: 'perf-title', text: String(m.model ?? DASH) }),
    h('div', { class: 'perf-provider', text: m.provider ?? '' }),
    h('div', { class: 'perf-main' },
      h('span', { class: 'value', text: fmtTps(dec.median) }),
      h('span', { class: 'unit', text: 'tok/s decode (median)' })),
    h('div', { class: 'perf-range', text: isNum(dec.p25) ? `p25–p75: ${fmtTps(dec.p25)}–${fmtTps(dec.p75)} tok/s` : 'No decode timing for this model' }),
    h('dl', { class: 'dl' },
      h('dt', { text: 'Request speed' }), h('dd', { text: isNum(req.median) ? `${fmtTps(req.median)} tok/s median` : DASH }),
      h('dt', { text: 'Time to first token' }), h('dd', { text: isNum(ttft.median) ? `${fmtMs(ttft.median)} median` : DASH }),
      h('dt', { text: 'TTFT p25–p75' }), h('dd', { text: isNum(ttft.p25) ? `${fmtMs(ttft.p25)}–${fmtMs(ttft.p75)}` : DASH }),
      h('dt', { text: 'Requests' }), h('dd', { text: `${fmtInt(m.requests)} (${fmtInt(m.timedRequests)} with TTFT)` })));
}

function modelCharts(m) {
  const days = fillDays(m.daily);
  if (!days.length) return h('p', { class: 'note', text: 'No daily timing data for this model.' });
  const name = String(m.model ?? 'model');
  return h('div', { class: 'grid two' },
    h('div', { class: 'card' }, chartFigure({
      title: 'Median decode speed per day',
      description: 'Output tokens per second after the first token.',
      height: 220,
      draw: dailyLine(days, {
        value: (r) => r.decodeTpsMedian, fmtY: fmtTps, fmtV: (v) => (isNum(v) ? `${fmtTps(v)} tok/s` : DASH),
        label: 'Decode', ariaLabel: `Line chart of daily median decode speed for ${name}.`,
      }),
      table: {
        columns: [
          { label: 'Day', value: (r) => dayLabelLong(r.day) },
          { label: 'Decode tok/s', num: true, value: (r) => fmtTps(r.decodeTpsMedian) },
          { label: 'TTFT', num: true, value: (r) => fmtMs(r.ttftMedian) },
          { label: 'Timed requests', num: true, value: (r) => fmtInt(r.n) },
        ],
        rows: arr(m.daily),
      },
    })),
    h('div', { class: 'card' }, chartFigure({
      title: 'Median time to first token per day',
      description: 'Lower is better.',
      height: 220,
      draw: dailyLine(days, {
        value: (r) => r.ttftMedian, fmtY: (v) => (v === 0 ? '0' : fmtMs(v)), fmtV: (v) => fmtMs(v),
        label: 'TTFT', cls: 's2', ariaLabel: `Line chart of daily median time to first token for ${name}.`,
      }),
    })));
}

async function renderPerformance(signal) {
  const d = await api('/api/performance', { period: state.period, tier: state.tier }, { signal });
  const models = arr(d.models);
  const tiers = arr(d.tiers);
  const counts = new Map(tiers.map((t) => [t.serviceTier == null ? 'unreported' : String(t.serviceTier), t.requests]));
  const options = [...BASE_TIERS];
  for (const key of counts.keys()) if (KNOWN_TIERS.includes(key) && !options.includes(key)) options.push(key);
  if (!options.includes(state.tier)) options.push(state.tier);
  const allCount = tiers.reduce((sum, t) => sum + (isNum(t.requests) ? t.requests : 0), 0);

  const page = pageShell('Model performance', `Speed for ${periodText(d.period)}.`);
  page.append(h('p', { class: 'explain', text: 'Decode speed = output tokens ÷ (duration − time to first token). Measured by omp on this machine.' }));
  page.append(h('div', { class: 'toolbar' },
    h('span', { class: 'toolbar-label', id: 'tier-label', text: 'Service tier' }),
    h('div', { class: 'segmented', role: 'group', 'aria-labelledby': 'tier-label' }, options.map((tier) => {
      const n = tier === 'all' ? (tiers.length ? allCount : null) : counts.get(tier) ?? (tiers.length ? 0 : null);
      return h('button', {
        type: 'button', 'aria-pressed': String(tier === state.tier),
        onclick: () => {
          if (tier === state.tier) return;
          state.tier = tier;
          prefs.set('tier', tier);
          render();
        },
      }, tierLabel(tier === 'unreported' ? null : tier), n != null ? h('span', { class: 'count', text: fmtCompact(n) }) : null);
    }))));

  if (!models.length) {
    page.append(emptyState(state.tier === 'all' ? `No timed omp requests in ${PERIOD_TEXT[state.period]}.` : `No timed requests for the ${tierLabel(state.tier === 'unreported' ? null : state.tier)} tier.`,
      'Speed needs completed turns with output tokens and a recorded duration.'));
    return page;
  }

  page.append(section('Models', 'Sorted by requests', h('div', { class: 'grid' }, models.map(perfCard))));

  if (!models.some((m) => modelKey(m) === state.modelKey)) state.modelKey = modelKey(models[0]);
  const chartsBox = h('div', null);
  const selected = () => models.find((m) => modelKey(m) === state.modelKey) ?? models[0];
  const select = h('select', {
    class: 'select', id: 'model-picker',
    onchange: (event) => {
      state.modelKey = event.target.value;
      chartsBox.replaceChildren(modelCharts(selected()));
    },
  }, models.map((m) => {
    const opt = h('option', { value: modelKey(m), text: `${m.model ?? DASH} (${m.provider ?? DASH})` });
    if (modelKey(m) === state.modelKey) opt.selected = true;
    return opt;
  }));
  chartsBox.append(modelCharts(selected()));
  page.append(section('Daily trend', null,
    h('div', { class: 'toolbar' }, h('label', { class: 'toolbar-label', for: 'model-picker', text: 'Model' }), select),
    chartsBox));
  return page;
}

async function renderAllowance(signal) {
  const d = await api('/api/allowance', {}, { signal });
  const series = arr(d.series);
  const page = pageShell('Allowance', 'Latest subscription readings recorded by omp. The reporting period does not apply here.');
  if (!series.length) {
    page.append(emptyState('No subscription usage recorded by omp yet.', 'omp records this when it checks provider usage limits.'));
    return page;
  }
  const accounts = new Map();
  for (const ser of series) {
    const key = `${ser.provider ?? ''}\u0000${ser.accountKey ?? ''}`;
    if (!accounts.has(key)) accounts.set(key, { label: ser.accountLabel ?? ser.provider ?? 'Account', items: [] });
    accounts.get(key).items.push(ser);
  }
  if (series.some((ser) => ser.stale)) {
    page.append(h('p', { class: 'banner', text: 'Some readings are stale: omp has not checked these limits recently, so the values may be out of date.' }));
  }
  for (const account of accounts.values()) {
    page.append(h('section', { class: 'account' },
      h('h3', { text: account.label }),
      h('div', { class: 'grid wide' }, account.items.map((ser) => allowanceCard(ser, { detailed: true })))));
  }
  return page;
}

async function renderProjects(signal) {
  const d = await api('/api/usage', { period: state.period }, { signal });
  const projects = arr(d.byProject);
  const total = d.totals?.totalTokens;
  const page = pageShell('Projects', `Usage by project for ${periodText(d.period)}.`);
  if (!projects.length) {
    page.append(noRequestsState());
    return page;
  }
  page.append(h('p', { class: 'note', text: 'Project names come from session folders and are kept in memory only, so a project may show as unknown until its session is read again.' }));
  page.append(h('div', { class: 'section' }, dataTable({
    caption: 'Projects by total tokens',
    captionHidden: true,
    columns: [
      { label: 'Project', value: projectLabel },
      { label: 'Tokens', num: true, value: (r) => tokenCell(r.totalTokens) },
      { label: 'Cost', num: true, value: (r) => costCell(r) },
      { label: 'Requests', num: true, value: (r) => fmtInt(r.requests) },
      { label: 'Sessions', num: true, value: (r) => fmtInt(r.sessions) },
      {
        label: 'Share of tokens', cls: 'share-cell',
        value: (r) => {
          if (!isNum(r.totalTokens) || !isNum(total) || total <= 0) return DASH;
          const share = r.totalTokens / total;
          const fill = h('span', { class: 'share-fill' });
          fill.style.width = `${Math.min(1, share) * 100}%`;
          return h('span', null, h('span', { class: 'share', 'aria-hidden': 'true' }, fill), fmtPct(share));
        },
      },
    ],
    rows: projects,
  })));
  return page;
}

const ROUTES = {
  overview: { title: 'Overview', render: renderOverview },
  usage: { title: 'Usage & cost', render: renderUsage },
  performance: { title: 'Model performance', render: renderPerformance },
  allowance: { title: 'Allowance', render: renderAllowance },
  projects: { title: 'Projects', render: renderProjects },
};

function currentRoute() {
  const m = /^#\/([a-z]+)/.exec(window.location.hash);
  return m && Object.hasOwn(ROUTES, m[1]) ? m[1] : 'overview';
}

// ---------------------------------------------------------------------------
// Rendering loop

function errorView(title, err) {
  const code = err instanceof ApiError ? err.code : 'unexpected';
  const message = code === 'unreachable'
    ? 'The local TiboTattle server is not responding. Check that it is still running.'
    : `The server answered with an error (${code}).`;
  return h('section', { class: 'page' },
    h('div', { class: 'page-head' }, h('h2', { tabindex: '-1', text: title })),
    h('div', { class: 'state error', role: 'alert' },
      h('h3', { text: `Couldn't load ${title.toLowerCase()}.` }),
      h('p', { text: message }),
      h('button', { type: 'button', class: 'button secondary', text: 'Try again', onclick: () => render() })));
}

function loadingView(title) {
  return h('section', { class: 'page' },
    h('div', { class: 'page-head' }, h('h2', { tabindex: '-1', text: title })),
    h('p', { class: 'state state-loading', text: 'Loading…' }));
}

function updateChrome(route) {
  for (const link of document.querySelectorAll('.site-nav a[data-route]')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const btn of document.querySelectorAll('#period-control button[data-period]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.period === state.period));
  }
  document.title = `${ROUTES[route].title} · TiboTattle`;
}

async function render({ quiet = false, focus = false } = {}) {
  const route = currentRoute();
  const seq = ++state.seq;
  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;
  updateChrome(route);
  const main = $('#main');
  if (!quiet || state.shownRoute !== route) {
    tooltip.hide();
    chartObserver.disconnect();
    main.replaceChildren(loadingView(ROUTES[route].title));
  }
  main.setAttribute('aria-busy', 'true');
  let view;
  try {
    view = await ROUTES[route].render(controller.signal);
  } catch (err) {
    if (seq !== state.seq || (err && err.name === 'AbortError')) return;
    if (!(err instanceof ApiError)) console.warn('render failed', err && err.name);
    view = errorView(ROUTES[route].title, err);
  }
  if (seq !== state.seq) return;
  tooltip.hide();
  // Disconnect after the new view's charts registered, then re-observe them.
  const pending = view.querySelectorAll('.chart-canvas');
  chartObserver.disconnect();
  for (const canvas of pending) chartObserver.observe(canvas);
  const scrollY = window.scrollY;
  main.replaceChildren(view);
  if (quiet && state.shownRoute === route) window.scrollTo(0, scrollY);
  main.removeAttribute('aria-busy');
  state.shownRoute = route;
  if (focus) {
    const heading = $('h2', main);
    if (heading) heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

// ---------------------------------------------------------------------------
// Status, live updates and refresh

function renderStatus(st) {
  const line = $('#status-line');
  if (!line) return;
  const parts = [];
  const warnings = [];
  const counts = st.counts ?? {};
  if (isNum(counts.requests)) parts.push(`${fmtInt(counts.requests)} requests indexed`);
  const last = isNum(st.lastRefreshAt) ? st.lastRefreshAt : Date.parse(st.lastRefreshAt);
  if (st.refreshing) parts.push('refreshing…');
  else if (isNum(last)) parts.push(h('span', null, 'last refresh ', agoEl(last)));
  const roots = arr(st.sources?.sessionRoots);
  if (roots.length && roots.every((r) => r.status !== 'readable')) warnings.push('omp session folder not found');
  const db = st.sources?.agentDb;
  if (db === 'missing') warnings.push('omp agent.db not found, so no allowance data');
  else if (db === 'unavailable') warnings.push('omp agent.db could not be read');
  if (st.lastError) warnings.push(`last refresh failed (${st.lastError})`);
  const nodes = [];
  [...parts, ...warnings.map((w) => h('span', { class: 'warn', text: w }))].forEach((part, i) => {
    if (i) nodes.push(' · ');
    nodes.push(part);
  });
  line.replaceChildren(...nodes);
}

async function loadStatus() {
  try {
    renderStatus(await api('/api/status'));
  } catch {
    const line = $('#status-line');
    if (line) line.textContent = 'Status unavailable.';
  }
}

let refetchTimer = null;
function scheduleRefetch() {
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(() => {
    render({ quiet: true });
    loadStatus();
  }, 250);
}

function setLive(stateName, label) {
  const el = $('#live-status');
  if (!el) return;
  el.dataset.state = stateName;
  const text = $('.live-label', el);
  if (text) text.textContent = label;
}

let events = null;
let reconnectTimer = null;
function connectEvents() {
  if (typeof window.EventSource !== 'function') {
    setLive('offline', 'No live updates');
    return;
  }
  if (events) events.close();
  setLive('connecting', 'Connecting');
  const es = new EventSource('/api/events');
  events = es;
  es.addEventListener('open', () => setLive('live', 'Live'));
  es.addEventListener('change', () => scheduleRefetch());
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) {
      setLive('offline', 'Offline');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectEvents, 10000);
    } else {
      setLive('connecting', 'Reconnecting');
    }
  });
}

async function onRefresh(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    await api('/api/refresh', {}, { method: 'POST' });
    await render({ quiet: true });
    announce('Data refreshed.');
  } catch (err) {
    announce(`Refresh failed${err instanceof ApiError ? ` (${err.code})` : ''}.`);
    const line = $('#status-line');
    if (line) line.replaceChildren(h('span', { class: 'warn', text: `Refresh failed (${err instanceof ApiError ? err.code : 'unexpected'}).` }));
    btn.disabled = false;
    btn.textContent = 'Refresh';
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Refresh';
  loadStatus();
}

function tickClocks() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-countdown]')) el.textContent = fmtCountdown(Number(el.dataset.countdown), now);
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = fmtAgo(Number(el.dataset.ago), now);
}

function init() {
  tooltip.el = $('#tooltip');
  for (const btn of document.querySelectorAll('#period-control button[data-period]')) {
    btn.addEventListener('click', () => {
      const period = btn.dataset.period;
      if (!PERIODS.includes(period) || period === state.period) return;
      state.period = period;
      prefs.set('period', period);
      render();
    });
  }
  $('#refresh-button')?.addEventListener('click', onRefresh);
  $('#skip-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    $('#main')?.focus();
  });
  window.addEventListener('hashchange', () => {
    if (!window.location.hash.startsWith('#/')) return;
    render({ focus: true });
  });
  window.addEventListener('scroll', () => tooltip.hide(), { passive: true });
  if (!window.location.hash.startsWith('#/')) window.history.replaceState(null, '', '#/overview');
  render();
  loadStatus();
  connectEvents();
  setInterval(tickClocks, 30000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
