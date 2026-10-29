// Multiplayer mode flag. NO imports on purpose: any module (economy.js, traffic, menus...) may import this without
// creating an import cycle, and reading it at module level is safe (no TDZ).
//
//   import { isMP, MP } from '../net/mode.js';
//   if (isMP()) { ...multiplayer behaviour... }
//
// MP.active is true from the moment a multiplayer session starts (logged in, world joined, the server profile
// swapped into `save`) until LEAVE MULTIPLAYER / a lost connection takes you back to the menu.
export const MP = {
  active: false,
  name: null,       // your unique name
  pid: 0,           // your player id in this world (small int, presence rows)
  world: null,      // { id, max, players } (live: net/session.js keeps it current)
  profile: null,    // the server profile (money, owned, chalet, cars ...): the authoritative copy
  catalog: null,    // the server's price list (server/lib/catalog.json)
  chalets: {},      // chalet id -> owner name, every world (global registry)
  status: 'off',    // 'off' | 'connecting' | 'online' | 'reconnecting'
};

/** True while a multiplayer session runs. Every AI system, the admin panel and save writes check this. */
export function isMP() { return MP.active; }
