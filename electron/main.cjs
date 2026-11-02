// Ski Legacy desktop app shell (macOS, Windows, Linux / Steam Deck): serves the built game over a custom app:// protocol
// (so ES modules + fetch of GLB assets work) in a fullscreen, GPU-accelerated window.
const { app, BrowserWindow, protocol, net, Menu, shell, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { initSteam, registerIpc: registerSteamIpc } = require('./steam.cjs'); // STEAM: optional Steamworks (no App ID / no Steam: skipped)

const isMac = process.platform === 'darwin';

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('force_high_performance_gpu'); // laptops with two GPUs: use the fast one (macOS + Windows)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const ROOT = path.join(__dirname, '..', 'dist');

// Content types for everything in dist/. Windows guesses a file's type from the registry, which other programs can
// break (a .js served as text/plain and the game's module scripts refuse to load), so the app sets them itself.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// One copy of the game at a time (double-clicking the .exe again just brings the running game back).
// Steam (electron/steam.cjs) starts before 'ready': a Steam build started outside Steam quits here while Steam
// relaunches it; without a Steam App ID nothing happens.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock || !initSteam(app)) {
  app.quit();
} else {
  registerSteamIpc(ipcMain);
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  if (process.platform === 'win32') app.setAppUserModelId('com.skilegacy.game'); // taskbar grouping / pinning

  app.whenReady().then(() => {
    protocol.handle('app', async (req) => {
      const { pathname } = new URL(req.url);
      const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
      const res = await net.fetch(pathToFileURL(file).toString());
      const type = MIME[path.extname(file).toLowerCase()];
      if (!type || !res.ok) return res;
      const headers = new Headers(res.headers);
      headers.set('content-type', type);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    });
    // macOS: the usual app menu (Cmd+Q, Ctrl+Cmd+F, Cmd+R ...). Windows: no menu bar at all. A menu bar would show
    // over the game, Alt (the build-mode cursor key) would jump into it, and Ctrl+R / Ctrl+W style accelerators would
    // fire while playing. Alt+F4 still closes the game; F11 and Ctrl+Shift+I are handled in createWindow().
    Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([
      { label: 'Ski Legacy', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
    ]) : null);
    createWindow();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Ski Legacy',
    backgroundColor: '#0b1626',
    show: false,
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') }, // (preload: window.steam)
  });
  if (!isMac) {
    win.removeMenu();
    // the keys the macOS menu gives: F11 toggles fullscreen (to get a normal window back), Ctrl+Shift+I the dev tools
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
      else if (input.control && input.shift && input.key.toLowerCase() === 'i') { event.preventDefault(); win.webContents.toggleDevTools(); }
    });
  }
  win.once('ready-to-show', () => { win.show(); win.setFullScreen(true); });
  win.loadURL('app://game/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Closing the window (Alt+F4, the X, or Quit in the game's menu) ends the game on every platform, macOS included
app.on('window-all-closed', () => app.quit());
