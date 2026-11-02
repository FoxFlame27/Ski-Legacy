// STEAM (Nov 2 2026): optional Steamworks for the desktop app, through the steamworks.js package (prebuilt native
// binaries for Windows x64, macOS x64/arm64 and Linux x64). Everything here is guarded: no App ID, the package
// missing, Steam not running, an unsupported platform -> Steam is simply "not available" and the game runs as before.
//
// Where the App ID comes from (the first one found):
//   1. the STEAM_APP_ID environment variable (dev: STEAM_APP_ID=480 npm run app; 480 = Valve's Spacewar test app)
//   2. a steam_appid.txt in the working directory, next to the executable or at the project root (dev only: it is
//      gitignored and never packaged; Steam itself launches release builds with the App ID set)
//   3. package.json "steam": { "appId": ... } (or the SteamAppId variable Steam sets when it launches a game), read ONLY in a Steam build (npm run steam:*, which sets
//      "steamBuild": true in the packaged package.json); the GitHub .exe / .dmg builds never touch Steam that way
//
// In a packaged Steam build started outside Steam (double-clicking the exe) restartAppIfNecessary() asks Steam to
// start the game, and this copy quits, like every Steam game. Not with a steam_appid.txt present (that is the dev
// override, as in the Steamworks docs), with STEAM_APP_ID set, or with STEAM_NO_RESTART=1.
const fs = require('node:fs');
const path = require('node:path');

const state = { available: false, appId: 0, playerName: '', onDeck: false, reason: 'not configured' };
let client = null;

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function validId(v) { const n = Number(String(v ?? '').trim()); return Number.isInteger(n) && n > 0 ? n : 0; }

function appIdFile(app) {
  const dirs = [process.cwd(), path.dirname(process.execPath), path.join(__dirname, '..')];
  if (process.platform === 'darwin') dirs.push(path.join(path.dirname(process.execPath), '..', '..', '..')); // (next to the .app)
  for (const d of dirs) {
    const f = path.join(d, 'steam_appid.txt');
    try { if (fs.existsSync(f)) { const id = validId(fs.readFileSync(f, 'utf8')); if (id) return { id, file: f }; } } catch { /* unreadable */ }
  }
  return null;
}

/**
 * Call before app 'ready' (the overlay needs two Chromium switches set early).
 * @returns {boolean} false when this process must quit because Steam is relaunching the game
 */
function initSteam(app) {
  const pkg = readJSON(path.join(__dirname, '..', 'package.json')) || {};
  const steamBuild = !!pkg.steamBuild;
  const file = appIdFile(app);
  const appId = validId(process.env.STEAM_APP_ID) || file?.id || (steamBuild ? validId(pkg.steam?.appId) || validId(process.env.SteamAppId) : 0);
  if (!appId) return true; // not a Steam copy: skip silently

  let steamworks;
  try { steamworks = require('steamworks.js'); } catch (e) { state.reason = 'steamworks.js not installed'; console.warn('[steam]', state.reason); return true; }

  try {
    if (app.isPackaged && steamBuild && !file && !process.env.STEAM_APP_ID && process.env.STEAM_NO_RESTART !== '1' && steamworks.restartAppIfNecessary(appId)) {
      return false; // Steam starts the game itself
    }
  } catch (e) { console.warn('[steam] restartAppIfNecessary', e?.message || e); }

  try {
    client = steamworks.init(appId);
    state.available = true;
    state.appId = appId;
    state.reason = '';
    try { state.playerName = client.localplayer.getName() || ''; } catch { /* (no name) */ }
    try { state.onDeck = !!client.utils.isSteamRunningOnSteamDeck(); } catch { /* (older Steam) */ }
    // the Shift+Tab overlay in an Electron window (in-process GPU, a repaint each frame)
    try { steamworks.electronEnableSteamOverlay(); } catch (e) { console.warn('[steam] overlay', e?.message || e); }
    console.log(`[steam] ready · app ${appId}${state.onDeck ? ' · Steam Deck' : ''}`);
  } catch (e) {
    client = null;
    state.reason = 'Steam not running or the app is not owned';
    console.warn('[steam] init failed:', e?.message || e);
  }
  return true;
}

// the page's calls (preload.cjs -> ipcMain); every one is safe without Steam
function registerIpc(ipcMain) {
  ipcMain.on('steam:info', (ev) => { ev.returnValue = { available: state.available, playerName: state.playerName, onDeck: state.onDeck, appId: state.appId }; });
  ipcMain.handle('steam:unlock', (_ev, id) => {
    if (!client || typeof id !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(id)) return false;
    try { return client.achievement.isActivated(id) || !!client.achievement.activate(id); } catch { return false; }
  });
  ipcMain.handle('steam:setStat', (_ev, name, value) => {
    if (!client || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(name) || !Number.isFinite(value)) return false;
    try { return !!client.stats.setInt(name, Math.round(value)) && !!client.stats.store(); } catch { return false; }
  });
  ipcMain.handle('steam:richPresence', (_ev, key, val) => {
    if (!client || typeof key !== 'string' || key.length > 64) return false;
    try { client.localplayer.setRichPresence(key, val == null ? null : String(val).slice(0, 255)); return true; } catch { return false; }
  });
  // steamworks.js 0.4 has no GameOverlayActivated callback: the page cannot tell when the overlay is open, so this
  // stays false (the game pauses on its own when the window loses focus / the pointer lock is released)
  ipcMain.on('steam:overlayActive', (ev) => { ev.returnValue = false; });
}

module.exports = { initSteam, registerIpc, steamState: state };
