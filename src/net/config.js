// The multiplayer server's address: the one place it is set. Caddy on the Hetzner VPS terminates TLS (the game runs
// on the secure app:// origin, so it must be wss://) and proxies /ws to the Node server (server/README.md).
// Local testing: open the game with ?mp=ws://localhost:8787/ws (e.g. http://localhost:5173/?mp=ws://localhost:8787/ws).
export const DEFAULT_SERVER_URL = 'wss://138-199-163-183.sslip.io/ws';

export function serverUrl() {
  try {
    const q = new URLSearchParams(location.search).get('mp');
    if (q && /^wss?:\/\//.test(q)) return q;
  } catch { /* no location (tests) */ }
  return DEFAULT_SERVER_URL;
}
