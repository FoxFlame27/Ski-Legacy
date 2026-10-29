// Ski Legacy multiplayer server entry point.
//   PORT      (default 8787)          the WebSocket / health port
//   HOST      (default 127.0.0.1)     Caddy proxies wss://<host>/ws to it; use 0.0.0.0 only for LAN tests
//   DATA_DIR  (default ./data)        accounts.json, profiles.json (gitignored)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameServer } from './lib/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));

const server = new GameServer({ dataDir, log: (s) => console.log(new Date().toISOString(), s) });
const bound = await server.listen(port, host);
console.log(`Ski Legacy server on ws://${host}:${bound} (data: ${dataDir})`);

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`${sig}: closing`);
  const force = setTimeout(() => process.exit(0), 5000);
  try { await server.close('restart'); } catch (e) { console.error(e); }
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error('uncaught', e); server.store.flush(); });
