// SETTINGS · Account (Oct 31 2026, the user: "also in settings add a delete account, or rename every 15 days"): the two
// account operations, on their own here so server.js only routes them ('accountRename' / 'accountDelete', accepted
// logged in or not, see GameServer.onMessage).
//   accountRename { name, token, newName }  -> { name, token, renamedAt, nextAt }: a NEW token (the old one is void)
//   accountDelete { name, token, confirm }   -> { deleted }: confirm = your name typed again (any case)
// Both check the token exactly as a login does (timing-safe against the stored sha256), and a connection that is
// logged in acts for its own account only (another name, even with its right token: not_yours). Rate-limited per
// address and per account (ACCT_OPS in ACCT_WINDOW_MS; a wrong token counts too, so guessing is slow). The special
// accounts (ADMIN_KEYS, Icey27) follow the same rules: only their owner (their token) renames or deletes them, and
// nobody else may take their names (RESERVED) by a rename.
// The player is signed out first wherever they are online (out of the world: everyone sees them leave; their chalet
// plot freed; car rides / visits allowed and asked for dropped; their cars, parked ones too, gone from the world), then
// the stored records move (rename) or go (delete). A rename's own client logs in again on a fresh connection under
// the new name (net/session.js renameAccount: everyone sees it join with that name, its chalet back on a plot); any
// other device of that account is told 'bye' { reason } and closed (4001).
import crypto from 'node:crypto';
import { ADMIN_KEYS, normName, nameKey, validName } from './server.js';

export const RENAME_DAYS = 15;                         // (the user: "rename every 15 days")
export const RENAME_MS = RENAME_DAYS * 24 * 3600 * 1000;
const ACCT_OPS = 5, ACCT_IP_OPS = 20, ACCT_WINDOW_MS = 10 * 60 * 1000;
// names a rename may not take: the admin accounts' (adminName: refused to a registration too while free, e.g. after a
// deletion; only the Icey27 account itself takes another case of it, a rename of its own key) and words that would
// pass for staff
const RESERVED = new Set(['admin', 'administrator', 'server', 'system', 'moderator', 'mod', 'staff', 'you']);
export const adminName = (k) => k === 'icey27' || ADMIN_KEYS.has(k);
export const reservedName = (k) => RESERVED.has(k) || adminName(k);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** srv.acctOps: 'ip|<addr>' / 'k|<nameKey>' -> [t] of the last ACCT_WINDOW_MS. false: over the limit. */
function rateOk(srv, key, max) {
  const map = (srv.acctOps ||= new Map()), now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < ACCT_WINDOW_MS);
  if (list.length >= max) { map.set(key, list); return false; }
  list.push(now); map.set(key, list);
  return true;
}

/** The account the request names, if its token is right and this connection may act for it: { k, a } | { err }. */
function authed(srv, c, d) {
  if (!rateOk(srv, `ip|${c.ip}`, ACCT_IP_OPS)) return { err: 'rate' };
  const k = nameKey(d.name), a = srv.store.accounts.data[k];
  if (!a || typeof d.token !== 'string' || !d.token) return { err: 'bad_login' };
  const h1 = Buffer.from(sha(d.token), 'hex'), h2 = Buffer.from(String(a.hash), 'hex');
  if (h1.length !== h2.length || !crypto.timingSafeEqual(h1, h2)) return { err: 'bad_login' };
  if (c.key && c.key !== k) return { err: 'not_yours' }; // (logged in as someone else: never their account)
  if (!rateOk(srv, `k|${k}`, ACCT_OPS)) return { err: 'rate' };
  return { k, a };
}

/** Signed out wherever the account is online: out of the world, chalet plot freed, grants dropped (GameServer.onClose).
 *  The asking connection stays open, logged out (its client closes it or logs in again); another device is closed. */
function signOut(srv, k, asker, why) {
  const o = srv.online.get(k);
  if (!o) return;
  o.kicked = true; // (no grace period)
  srv.onClose(o);
  o.key = null; o.name = null; o.profile = null; o.seat = null; o.plot = null;
  if (o === asker) { o.kicked = false; return; }
  try { o.send('bye', { reason: why }); o.ws?.close(4001, why); } catch { /* closed */ }
}

/** Every in-memory reference to an account key: moved to `nk` (a rename) or dropped (nk = null: a delete). */
function rekey(srv, k, nk, name) {
  for (const [p, owner] of [...srv.plates]) if (owner === k) { if (nk) srv.plates.set(p, nk); else srv.plates.delete(p); }
  for (const m of [srv.lastWorld, srv.earnedBy]) if (m?.has(k)) { const v = m.get(k); m.delete(k); if (nk) m.set(nk, v); }
  for (const [id, owner] of [...srv.chalets]) if (owner === k) { if (nk) srv.chalets.set(id, nk); else srv.chalets.delete(id); }
  srv.chaletWait = srv.chaletWait.filter((x) => x !== k);
  for (const w of srv.worlds.values()) {
    for (const r of w.races.values()) {
      for (const e of r.entrants) if (e.key === k) { e.key = nk; if (nk) e.name = name; }
      if (r.result) {
        r.result.keys = r.result.keys.map((x) => (x === k ? nk : x)).filter(Boolean);
        if (nk) for (const row of r.result.order) if (row.key === k) row.name = name;
      }
    }
    for (const h of w.heli.copies) if (h.key === k) { h.key = nk; if (nk) h.name = name; }
  }
}

export function accountRename(srv, c, d) {
  const me = authed(srv, c, d);
  if (me.err) return me;
  const { k, a } = me, acc = srv.store.accounts.data, profs = srv.store.profiles.data;
  const name = normName(d.newName), nk = nameKey(name), now = Date.now();
  if (!validName(name)) return { err: 'name_invalid' };
  if (name === a.name) return { err: 'same_name' }; // (another case of your own name is a rename: allowed)
  const left = (a.renamedAt || 0) + RENAME_MS - now;
  if (left > 0) return { err: 'rename_wait', d: { days: Math.ceil(left / (24 * 3600 * 1000)), until: a.renamedAt + RENAME_MS } };
  if (nk !== k && acc[nk]) return { err: 'name_taken' };
  if (nk !== k && reservedName(nk)) return { err: 'name_reserved' };
  const o = srv.online.get(k);
  if (o?.world && [...o.world.races.values()].some((r) => !r.done && r.entrants.some((e) => e.key === k && !e.done))) return { err: 'in_race' };
  signOut(srv, k, c, 'renamed');
  const token = crypto.randomBytes(24).toString('base64url');
  const entry = { ...a, name, hash: sha(token), renamedAt: now, was: [...(Array.isArray(a.was) ? a.was : []), a.name].slice(-10) };
  // on disk in a crash-safe order: the profile under both keys, then the account moved, then the old profile key gone
  // (a crash at any point leaves the account with its profile; at worst an orphan profile a new name overwrites)
  const P = profs[k];
  if (P) { P.name = name; profs[nk] = P; srv.store.profiles.save(0); srv.store.profiles.flush(); }
  delete acc[k]; acc[nk] = entry;
  srv.store.accounts.save(0); srv.store.accounts.flush();
  if (P && nk !== k) delete profs[k];
  srv.store.profiles.save(0); srv.store.profiles.flush();
  rekey(srv, k, nk, name);
  srv.jailBoardSend(); // (the prison board's names)
  srv.log(`[rename] ${a.name} -> ${name}`);
  return { d: { name, token, renamedAt: now, nextAt: now + RENAME_MS } };
}

export function accountDelete(srv, c, d) {
  const me = authed(srv, c, d);
  if (me.err) return me;
  const { k, a } = me;
  if (nameKey(d.confirm) !== k) return { err: 'confirm' }; // (your name typed again)
  signOut(srv, k, c, 'deleted'); // (its chalet plot freed, its cars and helicopter out of the world)
  delete srv.store.accounts.data[k];
  delete srv.store.profiles.data[k]; // (the chalet owned, the cars, the plates, the jail visits: all gone with it)
  srv.store.accounts.save(0); srv.store.profiles.save(0); srv.store.flush();
  rekey(srv, k, null);
  srv.dropGrants?.(k);
  srv.jailBoardSend();
  srv.log(`[-name] ${a.name}: account deleted by its owner`);
  return { d: { deleted: a.name } };
}

/** GameServer.onMessage: 'accountRename' | 'accountDelete'. */
export function accountOp(srv, c, t, d) {
  return t === 'accountRename' ? accountRename(srv, c, d) : accountDelete(srv, c, d);
}
