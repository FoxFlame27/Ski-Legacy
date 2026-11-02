// The page's window.steam (contextIsolation + sandbox friendly: only contextBridge and ipcRenderer). Without Steam
// it still exists with available: false, and every call resolves to false (src/core/steam.js checks `available`).
const { contextBridge, ipcRenderer } = require('electron');

let info = { available: false, playerName: '', onDeck: false };
try { info = ipcRenderer.sendSync('steam:info') || info; } catch { /* main process without the Steam bridge */ }

const call = (ch, ...args) => (info.available ? ipcRenderer.invoke(ch, ...args).catch(() => false) : Promise.resolve(false));

contextBridge.exposeInMainWorld('steam', {
  available: !!info.available,
  playerName: String(info.playerName || ''),
  onDeck: !!info.onDeck,
  unlock: (achId) => call('steam:unlock', String(achId)),
  setStat: (name, v) => call('steam:setStat', String(name), Number(v)),
  richPresence: (key, val) => call('steam:richPresence', String(key), val == null ? null : String(val)),
  overlayActive: () => { try { return info.available ? !!ipcRenderer.sendSync('steam:overlayActive') : false; } catch { return false; } },
});
