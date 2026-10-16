// TiboTattle desktop shell: runs the local monitor and loopback server
// in-process, shows the dashboard in a sandboxed window and the lowest
// remaining allowance in the tray. No updater, no network, no telemetry,
// no crash upload.

import { app, BrowserWindow, Menu, Tray, nativeImage, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureStateDir, resolveOmpSources } from '../../src/paths.js';
import { loadOrCreateKey } from '../../src/secret.js';
import { openStore } from '../../src/store.js';
import { createMonitor } from '../../src/monitor.js';
import { createServer } from '../../src/server.js';
import { summarizeAllowance } from '../../src/analysis/allowance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..', 'web');
const TRAY_ICON = path.join(HERE, 'assets', 'trayTemplate.png');
const DAY_MS = 24 * 60 * 60 * 1000;
const TRAY_INTERVAL_MS = 60 * 1000;
const IS_MAC = process.platform === 'darwin';
const LOGIN_ITEMS_SUPPORTED = IS_MAC || process.platform === 'win32';

// Hide only node:sqlite's experimental notice; keep every other warning.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener.call(process, warning);
});

app.setName('TiboTattle');
app.setPath('userData', path.join(app.getPath('appData'), 'TiboTattle'));

let runtime = null; // { store, monitor, server, origin }
let mainWindow = null;
let tray = null;
let trayTimer = null;
let quitting = false;
let cleanedUp = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start).catch(() => {
    process.stderr.write('tibotattle: error startup_failed\n');
    app.exit(1);
  });
}

async function start() {
  const stateDir = ensureStateDir(process.env.TIBOTATTLE_STATE_DIR || app.getPath('userData'));
  const key = loadOrCreateKey(stateDir);
  const store = openStore(path.join(stateDir, 'index.sqlite'));
  const monitor = createMonitor({ store, key, sources: resolveOmpSources() });
  const server = createServer({ monitor, store, webRoot: WEB_ROOT, port: 0 });
  const { url } = await server.listen();
  const origin = new URL(url).origin;
  runtime = { store, monitor, server, origin };

  lockDownSessions(origin);

  monitor.on('change', updateTray);
  await monitor.refresh({ reason: 'startup' }).catch(() => {});
  Promise.resolve(monitor.start()).catch(() => {});

  createTray();
  trayTimer = setInterval(updateTray, TRAY_INTERVAL_MS);
  showWindow();
}

// Every renderer may only talk to the loopback origin of our own server.
function lockDownSessions(origin) {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedUrl(details.url, origin) });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, target) => {
      if (!sameOrigin(target, origin)) event.preventDefault();
    });
    contents.on('will-redirect', (event, target) => {
      if (!sameOrigin(target, origin)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function sameOrigin(target, origin) {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

function isAllowedUrl(target, origin) {
  if (sameOrigin(target, origin)) return true;
  // DevTools and in-page data/blob URLs never leave the machine.
  return /^(devtools|data|blob|chrome-extension):/i.test(target);
}

function showWindow() {
  if (!runtime) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'TiboTattle',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (IS_MAC && !quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`${runtime.origin}/#/overview`).catch(() => {});
}

function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICON);
  if (IS_MAC) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.on('click', () => {
    if (!IS_MAC) showWindow();
  });
  updateTray();
}

function buildMenu() {
  const items = [
    { label: 'Open dashboard', click: () => showWindow() },
    {
      label: 'Refresh now',
      click: () => {
        runtime?.monitor.refresh({ reason: 'tray' }).then(updateTray, () => {});
      },
    },
  ];
  if (LOGIN_ITEMS_SUPPORTED) {
    items.push({
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    });
  }
  items.push({ type: 'separator' }, { label: 'Quit TiboTattle', role: 'quit' });
  return Menu.buildFromTemplate(items);
}

function lowestAllowance() {
  if (!runtime) return null;
  const nowMs = Date.now();
  let series;
  try {
    const snaps = Array.from(runtime.store.querySnapshots({ fromMs: nowMs - 30 * DAY_MS, toMs: nowMs + 1 }));
    series = summarizeAllowance(snaps, { nowMs });
  } catch {
    return null;
  }
  const known = series.filter((s) => s.remainingFraction != null);
  const fresh = known.filter((s) => !s.stale);
  const pool = fresh.length ? fresh : known;
  if (!pool.length) return null;
  const lowest = pool.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
  return { series: lowest, stale: fresh.length === 0 };
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const low = lowestAllowance();
  let title = '';
  let tooltip = 'TiboTattle: no allowance data';
  if (low) {
    const s = low.series;
    const pct = `${Math.round(s.remainingFraction * 100)}%`;
    const window = s.windowLabel || s.label || 'limit';
    title = `${window} ${pct}${low.stale ? '?' : ''}`;
    tooltip = `TiboTattle: ${s.accountLabel}, ${s.label || 'limit'} ${pct} remaining` + (low.stale ? ' (stale)' : '');
  }
  if (IS_MAC) tray.setTitle(title);
  tray.setToolTip(tooltip);
  tray.setContextMenu(buildMenu());
}

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('will-quit', (event) => {
  if (cleanedUp || !runtime) return;
  event.preventDefault();
  cleanedUp = true;
  const { monitor, server, store } = runtime;
  if (trayTimer) clearInterval(trayTimer);
  monitor.stop();
  server
    .close()
    .catch(() => {})
    .finally(() => {
      try {
        store.close();
      } catch {
        // already closed
      }
      tray?.destroy();
      // Cleanup is complete; exit without re-running the quit sequence.
      app.exit(0);
    });
});
