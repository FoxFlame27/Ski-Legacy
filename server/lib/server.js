// Ski Legacy multiplayer server. One process, many worlds (max 15 players each). See docs/multiplayer.md for the
// full protocol. Authoritative for: accounts (unique names), money, purchases, the global registries (number plates,
// chalet ownership), seats on shared transport, helicopter copies, permissions (car rides, chalet visits), the
// shared clock / weather, race queues, results and prize money. Relays presence at ~15 Hz within a world.
//
// Wire format: JSON text frames.
//   client -> server   { t: 'type', d: payload, id?: number }      (id present = a request: answered by 'res')
//   server -> client   { t: 'type', d: payload }  |  { t: 'res', id, ok: true, d } / { t: 'res', id, ok: false, err, d? }
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG = JSON.parse(fs.readFileSync(path.join(here, 'catalog.json'), 'utf8'));

export const PROTO = 1;
export const MAX_PLAYERS = 15;
export const TICK_HZ = 15;                 // presence batches per second
export const DAY_MS = 16 * 60 * 1000;      // one game day (sky.js DAY_SECONDS)
export const HELI_COPY_MS = 5 * 60 * 1000; // a rental out this long: a new copy waits at the pad
export const RACE_WAIT_MS = 30 * 1000;     // queue countdown once 2 are in
export const RACE_LEAD_MS = 4000;          // the start is broadcast this far ahead (everyone counts down together)
export const RACE_MAX_MS = 10 * 60 * 1000; // a race is closed this long after its start at the latest
export const PERM_TIMEOUT_MS = 30 * 1000;
const HEARTBEAT_MS = 10000;
const NAME_RE = /^[A-Za-z0-9_ -]{3,16}$/;
// seats per vehicle kind (a client may ask for fewer with n): the lowest free one is assigned
export const SEAT_CAPS = { bus: 48, train: 64, express: 128, gondola: 8, chair: 6, heli: 4, car: 7, sled: 2 };
// presence state enum (client src/net/protocol.js mirrors this)
export const STATE = { walk: 0, ski: 1, drive: 2, ride: 3, sit: 4, fly: 5, fall: 6 };
// weather (world/sky.js NEXT): the world's weather moves on every 80-180 s
const WEATHER_NEXT = {
  clear: ['clear', 'clear', 'flurries', 'cloudy', 'mist'],
  flurries: ['clear', 'clear', 'light', 'flurries', 'cloudy'],
  cloudy: ['light', 'clear', 'flurries', 'heavy', 'clear'],
  light: ['heavy', 'cloudy', 'flurries', 'light', 'cloudy'],
  heavy: ['light', 'cloudy'],
  mist: ['clear', 'flurries', 'cloudy'],
};
const EARN_RULES = { job: 6000, secret: 10000 }; // max per payout; and EARN_HOURLY over the last hour, all sources
const EARN_HOURLY = 60000;

export const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
export const nameKey = (s) => normName(s).toLowerCase();
export const validName = (s) => NAME_RE.test(s) && /[A-Za-z0-9]/.test(s);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const str = (v, max = 64) => (typeof v === 'string' && v.length <= max ? v : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CANTONS = ['VS', 'GR', 'BE', 'UR', 'OW', 'TI', 'ZH', 'LU'];
export const cleanPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 \-]/g, '').replace(/\s+/g, ' ').replace(/^[ -]+/, '').slice(0, 8).trim();
const plateKey = (s) => cleanPlate(s).replace(/[ -]/g, '');

function newProfile(name) {
  return {
    name, money: 500, owned: [], skis: null, character: null,
    outfits: { owned: [], equipped: {} },
    chalet: null, cars: [],
    stats: { races: 0, wins: 0, earned: 0, topSpeed: 0, distance: 0, longestJump: 0, bestAir: 0 },
    records: {}, secrets: [], dayPass: -1, tickets: 0, created: Date.now(),
  };
}

class Bucket {
  constructor(cap, rate) { this.cap = cap; this.rate = rate; this.v = cap; this.t = Date.now(); }
  take(n = 1) {
    const now = Date.now();
    this.v = Math.min(this.cap, this.v + ((now - this.t) / 1000) * this.rate);
    this.t = now;
    this.v -= n;
    return this.v >= 0;
  }
}

// ------------------------------------------------------------------ a world: up to 15 players sharing everything
class World {
  constructor(server, id) {
    this.server = server;
    this.id = id;
    this.players = new Map(); // pid -> Client
    this.nextPid = 1;
    const now = Date.now();
    // the clock: hour at `at` (server ms), advancing 24 h per DAY_MS; the weather and when it moves on
    this.clock = { hour: 9.5, at: now, weather: 'clear', next: now + 75000 };
    this.seats = new Map();   // vkey 'kind|id' -> Map(seat -> pid)
    this.holds = new Map();   // vkey -> Set(pid) holding the skip key
    this.vmeta = new Map();   // vkey -> { line, rate }
    this.warps = new Map();   // wkey 'kind|line' -> { off, rate, since }
    this.heli = { copies: [], padAt: 0, next: 1 };
    this.queues = new Map();  // race id -> { members: [pid], startAt: 0, timer }
    this.races = new Map();   // rid -> race
    this.nextRid = 1;
    this.dirty = new Map();   // pid -> presence row, sent with the next tick
  }

  get size() { return this.players.size; }

  hourAt(now = Date.now()) { return (((this.clock.hour + ((now - this.clock.at) / DAY_MS) * 24) % 24) + 24) % 24; }
  clockMsg(now = Date.now()) { return { hour: this.hourAt(now), at: now, dayMs: DAY_MS, weather: this.clock.weather }; }

  broadcast(t, d, except = null) {
    const s = JSON.stringify({ t, d });
    for (const c of this.players.values()) if (c !== except) c.sendRaw(s);
  }

  snapshot(now = Date.now()) {
    return {
      id: this.id, max: MAX_PLAYERS,
      players: [...this.players.values()].map((c) => c.publicInfo()),
      clock: this.clockMsg(now),
      seats: [...this.seats.entries()].map(([vk, m]) => this.seatsMsg(vk, m)),
      warps: [...this.warps.entries()].map(([k, w]) => ({ key: k, ...w })),
      heli: this.heliMsg(),
      queues: [...this.queues.keys()].map((r) => this.queueMsg(r)),
      races: [...this.races.values()].filter((r) => !r.done).map((r) => this.raceStartMsg(r)),
    };
  }

  tick(now) {
    if (now >= this.clock.next) {
      const opts = WEATHER_NEXT[this.clock.weather] || WEATHER_NEXT.clear;
      const h = this.hourAt(now);
      this.clock = { hour: h, at: now, weather: opts[Math.floor(Math.random() * opts.length)], next: now + 80000 + Math.random() * 100000 };
      this.broadcast('clock', this.clockMsg(now));
    }
    if (this.dirty.size) {
      const rows = [...this.dirty.values()];
      this.dirty.clear();
      this.broadcast('P', rows);
    }
  }

  // ---------------------------------------------------------------- seats
  seatsMsg(vk, m = this.seats.get(vk)) {
    const [k, v] = vk.split('|');
    return { k, v, occ: m ? [...m.entries()] : [] };
  }
  releaseSeat(c, notify = true) {
    const s = c.seat;
    if (!s) return;
    c.seat = null;
    const vk = `${s.k}|${s.v}`, m = this.seats.get(vk);
    if (m && m.get(s.seat) === c.pid) m.delete(s.seat);
    if (m && !m.size) this.seats.delete(vk);
    this.holds.get(vk)?.delete(c.pid);
    if (notify) this.broadcast('seats', this.seatsMsg(vk, m));
    // a car's driver gets out: the passengers stay seated (the car stays where it is); the owner leaving the world
    // empties it (see removePlayer)
    this.updateSkip(vk);
  }
  claimSeat(c, { k, v, n, seat }) {
    if (!SEAT_CAPS[k]) return { err: 'bad_vehicle' };
    v = str(v, 48);
    if (!v) return { err: 'bad_vehicle' };
    const cap = clamp(isInt(n) ? n : SEAT_CAPS[k], 1, SEAT_CAPS[k]);
    let first = 0;
    if (k === 'car') {
      // a player's car: vehicle id = the owner's name. Seat 0 (driver) is the owner's; anyone else needs the
      // owner's carRide permission and gets the lowest free passenger seat (1 = front, 2.. = back)
      const owner = this.server.onlineByKey(nameKey(v));
      if (!owner || owner.world !== this) return { err: 'owner_away' };
      v = owner.name;
      if (owner !== c) {
        if (!this.server.hasGrant('carRide', owner.key, c.key)) return { err: 'no_permission' };
        first = 1;
      }
    }
    const vk = `${k}|${v}`;
    if (c.seat && `${c.seat.k}|${c.seat.v}` === vk) return { d: { seat: c.seat.seat, v } }; // (already aboard)
    let m = this.seats.get(vk);
    let pick = -1;
    if (k === 'car' && first === 0) pick = 0;
    if (pick < 0 && isInt(seat) && seat >= first && seat < cap && !(m && m.has(seat))) pick = seat; // a free seat asked for
    if (pick < 0) for (let i = first; i < cap; i++) if (!m || !m.has(i)) { pick = i; break; }
    if (pick < 0) return { err: 'full' };
    if (m && m.has(pick)) {
      // the car's owner takes the wheel back from nobody: seat 0 can only be the owner's anyway
      return { err: 'full' };
    }
    this.releaseSeat(c);
    if (!m) { m = new Map(); this.seats.set(vk, m); }
    m.set(pick, c.pid);
    c.seat = { k, v, seat: pick };
    this.broadcast('seats', this.seatsMsg(vk, m));
    this.updateSkip(vk);
    return { d: { seat: pick, v } };
  }
  kickFromCar(ownerName, guestPid = null) {
    const vk = `car|${ownerName}`, m = this.seats.get(vk);
    if (!m) return;
    for (const [s, pid] of [...m.entries()]) {
      if (s === 0 || (guestPid != null && pid !== guestPid)) continue;
      const g = this.players.get(pid);
      if (g) { this.releaseSeat(g); g.send('seatLost', { k: 'car', v: ownerName }); }
    }
  }

  // ---------------------------------------------------------------- shared-transport speed-up (warp)
  // Each line has one timeline: vehicleTime = serverNow + off + (rate - 1) * (serverNow - since). A vehicle runs
  // fast (at the rate its riders' client asks: the single-player SPACE rate) while EVERY player aboard holds the
  // skip key (alone aboard: just you). The whole line's timeline moves with it, so every client places every
  // vehicle of that line from the same numbers.
  skip(c, { k, v, on, rate, line }) {
    if (!c.seat || c.seat.k !== k || c.seat.v !== v) return { err: 'not_aboard' };
    const vk = `${k}|${v}`;
    let h = this.holds.get(vk);
    if (!h) { h = new Set(); this.holds.set(vk, h); }
    if (on) h.add(c.pid); else h.delete(c.pid);
    const meta = this.vmeta.get(vk) || {};
    if (isNum(rate)) meta.rate = clamp(rate, 1, 32);
    if (str(line, 48)) meta.line = line;
    this.vmeta.set(vk, meta);
    this.updateSkip(vk);
    return {};
  }
  updateSkip(vk) {
    const m = this.seats.get(vk), h = this.holds.get(vk);
    const aboard = m ? [...m.values()] : [];
    if (h) for (const pid of [...h]) if (!aboard.includes(pid)) h.delete(pid);
    const holding = h ? h.size : 0;
    const meta = this.vmeta.get(vk) || {};
    const active = aboard.length > 0 && holding === aboard.length;
    if (meta.active === active && meta.holding === holding && meta.aboard === aboard.length) return;
    meta.active = active; meta.holding = holding; meta.aboard = aboard.length;
    this.vmeta.set(vk, meta);
    const [k, v] = vk.split('|');
    this.broadcast('skip', { k, v, holding, aboard: aboard.length, active });
    this.recomputeWarp(`${k}|${meta.line || v}`);
    if (!aboard.length) { this.vmeta.delete(vk); this.holds.delete(vk); }
  }
  recomputeWarp(wkey) {
    let rate = 1;
    for (const [vk, meta] of this.vmeta) {
      const [k, v] = vk.split('|');
      if (meta.active && `${k}|${meta.line || v}` === wkey) rate = Math.max(rate, meta.rate || 1);
    }
    const now = Date.now();
    const w = this.warps.get(wkey) || { off: 0, rate: 1, since: now };
    if (w.rate === rate) return;
    w.off += (w.rate - 1) * (now - w.since);
    w.since = now;
    w.rate = rate;
    this.warps.set(wkey, w);
    this.broadcast('warp', { key: wkey, ...w });
  }

  // ---------------------------------------------------------------- helicopter copies at the pad
  heliMsg() { return { copies: this.heli.copies.map((h) => ({ id: h.id, name: h.name, since: h.since })), padAt: this.heli.padAt, copyMs: HELI_COPY_MS }; }
  heliRent(c) {
    const now = Date.now();
    if (this.heli.copies.some((h) => h.key === c.key)) return { err: 'already_renting' };
    if (now < this.heli.padAt) return { err: 'not_yet', d: { waitMs: this.heli.padAt - now } };
    if (!this.server.debit(c, CATALOG.prices.heli, 'heli')) return { err: 'money' };
    const h = { id: this.heli.next++, key: c.key, name: c.name, since: now };
    this.heli.copies.push(h);
    this.heli.padAt = now + HELI_COPY_MS;
    clearTimeout(this.heli.timer);
    this.heli.timer = setTimeout(() => this.broadcast('heli', this.heliMsg()), HELI_COPY_MS + 50);
    this.broadcast('heli', this.heliMsg());
    return { d: { id: h.id, money: c.profile.money } };
  }
  heliReturn(c) {
    const i = this.heli.copies.findIndex((h) => h.key === c.key);
    if (i < 0) return { err: 'not_renting' };
    this.heli.copies.splice(i, 1);
    this.heli.padAt = Math.min(this.heli.padAt, Date.now()); // (it lands back on the pad)
    this.broadcast('heli', this.heliMsg());
    return {};
  }

  // ---------------------------------------------------------------- race queues and races
  queueMsg(race) {
    const q = this.queues.get(race);
    return { race, n: q ? q.members.length : 0, names: q ? q.members.map((pid) => this.players.get(pid)?.name).filter(Boolean) : [], startAt: q?.startAt || 0, need: 2, waitMs: RACE_WAIT_MS };
  }
  inRace(c) { for (const r of this.races.values()) if (!r.done && r.entrants.some((e) => e.key === c.key && !e.done)) return r; return null; }
  raceJoin(c, { race }) {
    if (!CATALOG.races[race]) return { err: 'bad_race' };
    if (this.inRace(c)) return { err: 'in_race' };
    this.raceLeave(c, true);
    let q = this.queues.get(race);
    if (!q) { q = { members: [], startAt: 0, timer: null }; this.queues.set(race, q); }
    q.members.push(c.pid);
    c.queue = race;
    this.updateQueue(race);
    return { d: this.queueMsg(race) };
  }
  raceLeave(c, quiet = false) {
    const race = c.queue;
    if (!race) return quiet ? {} : { err: 'not_queued' };
    c.queue = null;
    const q = this.queues.get(race);
    if (q) { q.members = q.members.filter((p) => p !== c.pid); this.updateQueue(race); }
    return {};
  }
  updateQueue(race) {
    const q = this.queues.get(race);
    if (!q) return;
    const n = q.members.length, now = Date.now();
    if (n < 2) { if (q.startAt) { q.startAt = 0; clearTimeout(q.timer); } }
    else if (n >= MAX_PLAYERS || n >= this.size) { clearTimeout(q.timer); this.startRace(race); return; }
    else if (!q.startAt) { q.startAt = now + RACE_WAIT_MS; q.timer = setTimeout(() => this.startRace(race), RACE_WAIT_MS); }
    if (!n) this.queues.delete(race);
    this.broadcast('raceQueue', this.queueMsg(race));
  }
  startRace(race) {
    const q = this.queues.get(race);
    if (!q) return;
    clearTimeout(q.timer);
    this.queues.delete(race);
    const def = CATALOG.races[race], now = Date.now();
    const entrants = [];
    for (const pid of q.members) {
      const c = this.players.get(pid);
      if (!c) continue;
      c.queue = null;
      const free = (c.profile.stats.races || 0) === 0; // the first race is on the house (as in single player)
      if (!free && def.entry) {
        if (!this.server.debit(c, def.entry, `race:${race}`)) { c.send('raceDropped', { race, reason: 'money' }); continue; }
        c.send('money', { v: c.profile.money, why: 'entry', delta: -def.entry });
      }
      entrants.push({ pid, key: c.key, name: c.name, slot: entrants.length, time: null, done: false, dnf: false });
    }
    if (entrants.length < 2) { // (someone could not pay the entry: back to the queue for those left)
      for (const e of entrants) {
        const c = this.players.get(e.pid);
        if (c) {
          if (!((c.profile.stats.races || 0) === 0) && def.entry) { this.server.credit(c, def.entry, 'refund'); c.send('money', { v: c.profile.money, why: 'refund', delta: def.entry }); }
          this.raceJoin(c, { race });
        }
      }
      this.broadcast('raceQueue', this.queueMsg(race));
      return;
    }
    const r = { rid: this.nextRid++, race, at: now + RACE_LEAD_MS, entrants, done: false };
    r.timer = setTimeout(() => this.finishRace(r), RACE_LEAD_MS + RACE_MAX_MS);
    this.races.set(r.rid, r);
    this.broadcast('raceQueue', { race, n: 0, names: [], startAt: 0, need: 2, waitMs: RACE_WAIT_MS });
    this.broadcast('raceStart', this.raceStartMsg(r));
  }
  raceStartMsg(r) { return { rid: r.rid, race: r.race, at: r.at, grid: r.entrants.map((e) => ({ pid: e.pid, name: e.name, slot: e.slot })) }; }
  raceFinish(c, { rid, time, dnf }) {
    const r = this.races.get(rid);
    if (!r || r.done) return { err: 'bad_race' };
    const e = r.entrants.find((x) => x.key === c.key);
    if (!e) return { err: 'not_entered' };
    if (e.done) return { err: 'already_done' };
    const now = Date.now(), elapsed = now - r.at;
    e.done = true;
    if (dnf || elapsed < 0) { e.dnf = true; }
    else {
      // the client's time (ms, its own timer) is trusted only within 3 s of what the server measured
      e.time = isNum(time) && Math.abs(time - elapsed) <= 3000 ? Math.round(time) : elapsed;
    }
    this.broadcast('raceProgress', { rid, pid: e.pid, name: e.name, time: e.time, dnf: e.dnf });
    if (r.entrants.every((x) => x.done)) this.finishRace(r);
    return { d: { time: e.time } };
  }
  dropFromRace(c) {
    const r = this.inRace(c);
    if (r) this.raceFinish(c, { rid: r.rid, dnf: true });
  }
  finishRace(r) {
    if (r.done) return;
    r.done = true;
    clearTimeout(r.timer);
    for (const e of r.entrants) if (!e.done) { e.done = true; e.dnf = true; }
    const def = CATALOG.races[r.race], share = CATALOG.prizeShare;
    const ranked = r.entrants.filter((e) => !e.dnf).sort((a, b) => a.time - b.time);
    const order = [];
    ranked.forEach((e, i) => {
      const place = i + 1, prize = Math.round(def.reward * (share[i] ?? 0));
      order.push({ pid: e.pid, name: e.name, place, time: e.time, prize });
      const prof = this.server.profileOf(e.key);
      if (prof) {
        prof.stats.races = (prof.stats.races || 0) + 1;
        if (place === 1) prof.stats.wins = (prof.stats.wins || 0) + 1;
        if (prize) { prof.money += prize; prof.stats.earned = (prof.stats.earned || 0) + prize; }
        this.server.store.profiles.save();
        const c = this.server.onlineByKey(e.key);
        if (c) c.send('money', { v: prof.money, why: 'race', delta: prize });
      }
    });
    for (const e of r.entrants) if (e.dnf) {
      order.push({ pid: e.pid, name: e.name, place: null, time: null, prize: 0, dnf: true });
      const prof = this.server.profileOf(e.key);
      if (prof) { prof.stats.races = (prof.stats.races || 0) + 1; this.server.store.profiles.save(); }
    }
    this.broadcast('raceResult', { rid: r.rid, race: r.race, order });
    setTimeout(() => this.races.delete(r.rid), 60000);
  }

  // ---------------------------------------------------------------- joining / leaving
  addPlayer(c) {
    let pid = this.nextPid;
    while (this.players.has(pid)) pid = (pid % 250) + 1;
    this.nextPid = (pid % 250) + 1;
    c.pid = pid;
    c.world = this;
    this.players.set(pid, c);
    this.broadcast('join', c.publicInfo(), c);
    for (const race of this.queues.keys()) this.updateQueue(race); // ("everyone in the world" grew)
  }
  removePlayer(c) {
    if (c.world !== this) return;
    this.releaseSeat(c);
    this.kickFromCar(c.name);
    this.raceLeave(c, true);
    this.dropFromRace(c);
    this.players.delete(c.pid);
    this.dirty.delete(c.pid);
    // a helicopter copy stays out (it is in the air somewhere): returned when its renter leaves
    if (this.heli.copies.some((h) => h.key === c.key)) this.heliReturn(c);
    c.world = null;
    this.broadcast('leave', { pid: c.pid, name: c.name });
    for (const race of [...this.queues.keys()]) this.updateQueue(race); // (everyone in the world may now be queued)
  }
}

// ------------------------------------------------------------------ one connection
class Client {
  constructor(server, ws, ip) {
    this.server = server;
    this.ws = ws;
    this.ip = ip;
    this.alive = true;
    this.name = null; this.key = null; this.profile = null;
    this.world = null; this.pid = 0;
    this.look = null;      // { c: character, o: outfit, s: skis }
    this.pres = null;      // the last presence row
    this.interior = null;  // server-approved interior id ('skishop', 'carrental', 'chalet:7', ...)
    this.seat = null;      // { k, v, seat }
    this.queue = null;     // race id queued for
    this.bucket = new Bucket(120, 60);
    this.pBucket = new Bucket(30, 25);
    this.earned = [];      // [t, amount] over the last hour
  }
  sendRaw(s) { if (this.ws.readyState === 1) this.ws.send(s); }
  send(t, d) { this.sendRaw(JSON.stringify({ t, d })); }
  res(id, ok, d, err) { if (id == null) return; this.sendRaw(JSON.stringify(ok ? { t: 'res', id, ok: true, d } : { t: 'res', id, ok: false, err, d })); }
  publicInfo() { return { pid: this.pid, name: this.name, look: this.look, pres: this.pres, interior: this.interior, chalet: this.profile?.chalet?.id ?? null }; }
}

// ------------------------------------------------------------------ the server
export class GameServer {
  constructor({ dataDir, log = console.log, regPerHour = 5 } = {}) {
    this.store = new Store(dataDir);
    this.regPerHour = regPerHour; // new names from one address an hour
    this.log = log;
    this.worlds = new Map();
    this.nextWorld = 1;
    this.online = new Map(); // nameKey -> Client
    this.lastWorld = new Map(); // nameKey -> { id, t }: a reconnect lands in the same world if it has room
    this.grants = new Set(); // `${kind}|${ownerKey}|${guestKey}` while both are online
    this.pending = new Map(); // rid -> permission request
    this.nextPerm = 1;
    this.regByIp = new Map(); // ip -> [t]: at most 5 new names an hour from one address
    // global registries, rebuilt from the profiles
    this.plates = new Map(); // plateKey -> nameKey
    this.chalets = new Map(); // chalet id -> nameKey
    for (const [k, p] of Object.entries(this.store.profiles.data)) {
      if (p.chalet && isInt(p.chalet.id)) this.chalets.set(p.chalet.id, k);
      for (const car of p.cars || []) if (car.plate) this.plates.set(plateKey(car.plate), k);
    }
  }

  // ---------------------------------------------------------------- lifecycle
  listen(port = 8787, host = '127.0.0.1') {
    this.http = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ws/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, proto: PROTO, worlds: this.worlds.size, players: this.online.size }));
        return;
      }
      res.writeHead(404); res.end();
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 64 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.tickT = setInterval(() => { const now = Date.now(); for (const w of this.worlds.values()) w.tick(now); }, 1000 / TICK_HZ);
    this.beatT = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    return new Promise((resolve) => this.http.listen(port, host, () => resolve(this.http.address().port)));
  }

  async close(reason = 'shutdown') {
    clearInterval(this.tickT); clearInterval(this.beatT);
    for (const c of this.online.values()) { c.send('bye', { reason }); }
    for (const ws of this.wss?.clients || []) ws.close(1001, reason);
    this.store.flush();
    await new Promise((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  heartbeat() {
    for (const ws of this.wss.clients) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }

  onConnection(ws, req) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const c = new Client(this, ws, ip);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (buf, isBinary) => {
      ws.alive = true;
      if (isBinary) return;
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'p') { if (c.pBucket.take()) this.onPresence(c, m.d); return; }
      if (!c.bucket.take()) {
        if (c.bucket.v < -60) { ws.close(1008, 'rate limit'); }
        else c.res(m.id, false, null, 'rate');
        return;
      }
      try { this.onMessage(c, m); } catch (e) { this.log(`[err] ${m.t}: ${e.stack || e}`); c.res(m.id, false, null, 'server'); }
    });
    ws.on('close', () => this.onClose(c));
    ws.on('error', () => {});
  }

  onClose(c) {
    if (!c.key || this.online.get(c.key) !== c) return;
    this.online.delete(c.key);
    const w = c.world;
    if (w) {
      this.lastWorld.set(c.key, { id: w.id, t: Date.now() });
      w.removePlayer(c);
      if (!w.size) { this.worlds.delete(w.id); clearTimeout(w.heli.timer); }
    }
    this.dropGrants(c.key);
    this.store.profiles.save();
    this.log(`[-] ${c.name} (${this.online.size} online)`);
  }

  onlineByKey(k) { return this.online.get(k) || null; }
  profileOf(k) { return this.store.profiles.data[k] || null; }

  // ---------------------------------------------------------------- money (server-authoritative)
  debit(c, amount, why) {
    amount = Math.round(amount);
    if (!(amount >= 0) || c.profile.money < amount) return false;
    c.profile.money -= amount;
    this.store.profiles.save();
    return true;
  }
  credit(c, amount, why) {
    c.profile.money += Math.round(amount);
    this.store.profiles.save();
  }

  // ---------------------------------------------------------------- permissions
  hasGrant(kind, ownerKey, guestKey) { return this.grants.has(`${kind}|${ownerKey}|${guestKey}`); }
  dropGrants(k) {
    for (const g of [...this.grants]) { const [, o, gu] = g.split('|'); if (o === k || gu === k) this.grants.delete(g); }
    for (const [rid, p] of [...this.pending]) if (p.from.key === k || p.to.key === k) this.answerPerm(rid, false, 'gone');
  }
  answerPerm(rid, allow, reason = null) {
    const p = this.pending.get(rid);
    if (!p) return false;
    this.pending.delete(rid);
    clearTimeout(p.timer);
    if (allow) this.grants.add(`${p.kind}|${p.to.key}|${p.from.key}`);
    p.from.res(p.reqId, true, { allow: !!allow, reason, kind: p.kind, owner: p.to.name, ref: p.ref });
    if (!allow && reason !== 'gone') p.to.send('permClosed', { rid, reason: reason || 'denied' });
    return true;
  }

  // ---------------------------------------------------------------- presence
  // row in:  [ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags, vehicle, interior]
  // row out: [pid, ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags, vehicle, interior]
  onPresence(c, d) {
    if (!c.world || !Array.isArray(d) || d.length < 9 || d.length > 16) return;
    for (let i = 0; i < 12 && i < d.length; i++) if (!isNum(d[i])) return;
    const now = Date.now();
    let ts = d[0];
    if (Math.abs(ts - now) > 2000) ts = now; // (a client clock way off: stamped on arrival)
    const row = [c.pid, Math.round(ts)];
    for (let i = 1; i <= 11; i++) row.push(isNum(d[i]) ? Math.round(d[i] * 100) / 100 : 0);
    row[9] = clamp(row[9] | 0, 0, 15); // state
    // the vehicle and the interior are the server's own records (seat registry, approved interior)
    row.push(c.seat ? `${c.seat.k}:${c.seat.v}:${c.seat.seat}` : 0);
    row.push(c.interior || 0);
    c.pres = row;
    c.world.dirty.set(c.pid, row);
  }

  // ---------------------------------------------------------------- messages
  onMessage(c, m) {
    const d = m.d && typeof m.d === 'object' ? m.d : {};
    const id = isInt(m.id) ? m.id : null;
    const reply = (r) => (r?.err ? c.res(id, false, r.d, r.err) : c.res(id, true, r?.d ?? {}));
    if (m.t === 'ping') { c.send('pong', { c: d.c, s: Date.now() }); return; }
    if (m.t === 'register') return reply(this.register(c, d));
    if (m.t === 'login') return reply(this.login(c, d));
    if (!c.world) return c.res(id, false, null, 'not_logged_in');
    const w = c.world;
    switch (m.t) {
      case 'look': {
        const look = { c: str(d.c, 32), o: d.o && typeof d.o === 'object' && JSON.stringify(d.o).length < 400 ? d.o : null, s: str(d.s, 32) };
        c.look = look;
        w.broadcast('look', { pid: c.pid, look }, c);
        return reply({});
      }
      case 'enter': return reply(this.enter(c, d));
      case 'seatClaim': return reply(w.claimSeat(c, d));
      case 'seatRelease': w.releaseSeat(c); return reply({});
      case 'skip': return reply(w.skip(c, d));
      case 'heliRent': return reply(w.heliRent(c));
      case 'heliReturn': return reply(w.heliReturn(c));
      case 'raceJoin': return reply(w.raceJoin(c, d));
      case 'raceLeave': return reply(w.raceLeave(c));
      case 'raceFinish': return reply(w.raceFinish(c, d));
      case 'perm': return this.permRequest(c, d, id);
      case 'permAnswer': {
        const p = this.pending.get(d.rid);
        if (!p || p.to !== c) return reply({ err: 'bad_request' });
        this.answerPerm(d.rid, !!d.allow);
        return reply({});
      }
      case 'permRevoke': return reply(this.permRevoke(c, d));
      case 'spend': return reply(this.spend(c, d));
      case 'earn': return reply(this.earn(c, d));
      case 'buy': return reply(this.buy(c, d));
      case 'carReturn': return reply(this.carReturn(c, d));
      case 'plateCheck': {
        const p = cleanPlate(d.plate), k = plateKey(p);
        if (!k) return reply({ err: 'bad_plate' });
        const o = this.plates.get(k);
        return reply({ d: { plate: p, free: !o || o === c.key, mine: o === c.key } });
      }
      case 'plateIssue': return reply({ d: { plate: this.freePlate() } });
      case 'profileSet': return reply(this.profileSet(c, d));
      case 'profile': return reply({ d: { profile: c.profile } });
      case 'chat': { // (short text: a wave-2 hook; relayed to the world)
        const text = str(d.text, 200);
        if (!text) return reply({ err: 'bad_text' });
        w.broadcast('chat', { pid: c.pid, name: c.name, text });
        return reply({});
      }
      default: return reply({ err: 'unknown_type' });
    }
  }

  // ---------------------------------------------------------------- accounts
  register(c, d) {
    const name = normName(d.name);
    if (!validName(name)) return { err: 'name_invalid' };
    const k = nameKey(name), acc = this.store.accounts.data;
    if (acc[k]) return { err: 'name_taken' };
    const now = Date.now(), list = (this.regByIp.get(c.ip) || []).filter((t) => now - t < 3600000);
    if (list.length >= this.regPerHour) return { err: 'rate' };
    list.push(now); this.regByIp.set(c.ip, list);
    const token = crypto.randomBytes(24).toString('base64url');
    acc[k] = { name, hash: sha(token), created: now };
    this.store.profiles.data[k] = newProfile(name);
    this.store.accounts.save(0); this.store.profiles.save(0);
    this.store.flush(); // (a new name is on disk before the client is told it has it)
    this.log(`[+name] ${name}`);
    return { d: { name, token } };
  }

  login(c, d) {
    if (c.key) return { err: 'already_logged_in' };
    if (d.v !== PROTO) return { err: 'proto', d: { proto: PROTO } };
    const k = nameKey(d.name), a = this.store.accounts.data[k];
    if (!a || typeof d.token !== 'string') return { err: 'bad_login' };
    const h1 = Buffer.from(sha(d.token), 'hex'), h2 = Buffer.from(a.hash, 'hex');
    if (h1.length !== h2.length || !crypto.timingSafeEqual(h1, h2)) return { err: 'bad_login' };
    const old = this.online.get(k);
    if (old) { old.send('bye', { reason: 'replaced' }); old.ws.close(4001, 'replaced'); this.onClose(old); }
    c.name = a.name; c.key = k;
    c.profile = this.store.profiles.data[k] ||= newProfile(a.name);
    if (d.look && typeof d.look === 'object') c.look = { c: str(d.look.c, 32), o: d.look.o && JSON.stringify(d.look.o).length < 400 ? d.look.o : null, s: str(d.look.s, 32) };
    this.online.set(k, c);
    const w = this.pickWorld(k);
    w.addPlayer(c);
    this.log(`[+] ${c.name} -> world ${w.id} (${w.size}/${MAX_PLAYERS}, ${this.online.size} online)`);
    return {
      d: {
        proto: PROTO, name: c.name, pid: c.pid, now: Date.now(), profile: c.profile, world: w.snapshot(),
        chalets: Object.fromEntries([...this.chalets].map(([id, ok]) => [id, this.store.accounts.data[ok]?.name || '?'])),
        catalog: CATALOG,
      },
    };
  }

  pickWorld(k) {
    const last = this.lastWorld.get(k);
    if (last && Date.now() - last.t < 120000) {
      const w = this.worlds.get(last.id);
      if (w && w.size < MAX_PLAYERS) return w;
    }
    let best = null;
    for (const w of this.worlds.values()) if (w.size < MAX_PLAYERS && (!best || w.size > best.size)) best = w;
    if (best) return best;
    const w = new World(this, this.nextWorld++);
    this.worlds.set(w.id, w);
    return w;
  }

  // ---------------------------------------------------------------- interiors (chalets need the owner's ok)
  enter(c, d) {
    const id = d.interior == null ? null : str(d.interior, 40);
    if (d.interior != null && !id) return { err: 'bad_interior' };
    if (id && id.startsWith('chalet:')) {
      const n = Number(id.slice(7));
      if (!isInt(n)) return { err: 'bad_interior' };
      const owner = this.chalets.get(n);
      // unowned: open for viewing; yours; or the owner let you in (while you both are online)
      if (owner && owner !== c.key && !this.hasGrant('chaletVisit', owner, c.key)) return { err: 'no_permission' };
    }
    c.interior = id;
    if (c.pres) { c.pres[14] = id || 0; c.world.dirty.set(c.pid, c.pres); }
    return { d: { interior: id } };
  }

  permRequest(c, d, reqId) {
    const kind = d.kind;
    if (kind !== 'carRide' && kind !== 'chaletVisit') return c.res(reqId, false, null, 'bad_kind');
    let to = null, ref = null;
    if (kind === 'chaletVisit') {
      ref = d.ref;
      const owner = isInt(ref) ? this.chalets.get(ref) : null;
      if (!owner) return c.res(reqId, false, null, 'no_owner');
      to = this.online.get(owner);
    } else to = this.online.get(nameKey(d.to));
    if (!to || to.world !== c.world) return c.res(reqId, false, null, 'owner_away');
    if (to === c) return c.res(reqId, true, { allow: true, kind, owner: c.name, ref });
    if (this.hasGrant(kind, to.key, c.key)) return c.res(reqId, true, { allow: true, kind, owner: to.name, ref, already: true });
    for (const p of this.pending.values()) if (p.from === c && p.to === to && p.kind === kind) return c.res(reqId, false, null, 'pending');
    const rid = this.nextPerm++;
    const p = { rid, kind, from: c, to, ref, reqId };
    p.timer = setTimeout(() => this.answerPerm(rid, false, 'timeout'), PERM_TIMEOUT_MS);
    this.pending.set(rid, p);
    to.send('permAsk', { rid, kind, from: c.name, pid: c.pid, ref, timeoutMs: PERM_TIMEOUT_MS });
  }

  permRevoke(c, d) {
    const g = this.online.get(nameKey(d.guest));
    if (!g || !this.grants.delete(`${d.kind}|${c.key}|${g.key}`)) return { err: 'no_grant' };
    g.send('permRevoked', { kind: d.kind, owner: c.name });
    if (d.kind === 'carRide' && g.world) g.world.kickFromCar(c.name, g.pid);
    if (d.kind === 'chaletVisit' && g.interior === `chalet:${c.profile.chalet?.id}`) { g.interior = null; g.send('kickInterior', { interior: `chalet:${c.profile.chalet?.id}` }); }
    return {};
  }

  // ---------------------------------------------------------------- the economy
  spend(c, d) {
    const amount = d.amount;
    if (!isInt(amount) || amount <= 0 || amount > 1e7) return { err: 'bad_amount', d: { money: c.profile.money } };
    if (!this.debit(c, amount, d.reason)) return { err: 'money', d: { money: c.profile.money } };
    return { d: { money: c.profile.money } };
  }

  earn(c, d) {
    const max = EARN_RULES[d.source], amount = d.amount, now = Date.now();
    if (!max || !isInt(amount) || amount <= 0 || amount > max) return { err: 'rejected', d: { money: c.profile.money } };
    c.earned = c.earned.filter(([t]) => now - t < 3600000);
    const hour = c.earned.reduce((s, [, a]) => s + a, 0);
    if (hour + amount > EARN_HOURLY) return { err: 'cap', d: { money: c.profile.money } };
    c.earned.push([now, amount]);
    this.credit(c, amount, d.source);
    c.profile.stats.earned = (c.profile.stats.earned || 0) + amount;
    return { d: { money: c.profile.money } };
  }

  freePlate() {
    for (let i = 0; i < 1000; i++) {
      const p = `${CANTONS[Math.floor(Math.random() * CANTONS.length)]} ${Math.floor(1000 + Math.random() * 899000)}`;
      if (!this.plates.has(plateKey(p))) return p;
    }
    return null;
  }

  buy(c, d) {
    const P = c.profile, kind = d.kind;
    if (kind === 'skis') {
      const s = CATALOG.skis[d.id];
      if (!s) return { err: 'bad_item' };
      if (P.owned.includes(d.id)) return { err: 'owned' };
      if (!this.debit(c, s.price, 'skis')) return { err: 'money', d: { money: P.money } };
      P.owned.push(d.id); P.skis = d.id;
      return { d: { money: P.money, owned: P.owned, skis: P.skis } };
    }
    if (kind === 'outfit') {
      const price = CATALOG.outfits[d.id];
      if (price == null) return { err: 'bad_item' };
      if (P.outfits.owned.includes(d.id)) return { err: 'owned' };
      if (!this.debit(c, price, 'outfit')) return { err: 'money', d: { money: P.money } };
      P.outfits.owned.push(d.id);
      return { d: { money: P.money, outfits: P.outfits } };
    }
    if (kind === 'chalet') {
      const id = d.id;
      if (!isInt(id) || id < 0 || id > 63) return { err: 'bad_item' };
      const owner = this.chalets.get(id);
      if (owner) return { err: 'taken', d: { owner: this.store.accounts.data[owner]?.name } };
      if (P.chalet) return { err: 'one_each', d: { id: P.chalet.id } };
      if (!this.debit(c, CATALOG.chalet.price, 'chalet')) return { err: 'money', d: { money: P.money } };
      const meta = d.meta && typeof d.meta === 'object' && JSON.stringify(d.meta).length < 400 ? d.meta : {};
      P.chalet = { ...meta, id, name: str(d.name, 40) || `Chalet ${id}`, owned: true, rented: true, furniture: [], since: Date.now() };
      this.chalets.set(id, c.key);
      this.broadcastAll('chalet', { id, owner: c.name });
      return { d: { money: P.money, chalet: P.chalet } };
    }
    if (kind === 'car') {
      const cfg = d.cfg || {};
      const base = CATALOG.cars[cfg.id];
      if (base == null) return { err: 'bad_item' };
      const paint = CATALOG.paints[cfg.paint] != null ? cfg.paint : 'white';
      const interior = CATALOG.interiors[cfg.interior] != null ? cfg.interior : 'orig';
      const rims = CATALOG.rims[cfg.rims] != null ? cfg.rims : 'orig';
      const custom = !!cfg.custom;
      let plate;
      if (custom) {
        plate = cleanPlate(cfg.plate);
        if (!plateKey(plate)) return { err: 'bad_plate' };
        const o = this.plates.get(plateKey(plate));
        if (o && o !== c.key) return { err: 'plate_taken', d: { plate } };
      } else {
        // a random plate: the one asked for if it is still free (the configurator showed it), else a new one
        const want = cleanPlate(cfg.plate), o = want ? this.plates.get(plateKey(want)) : null;
        plate = want && plateKey(want) && (!o || o === c.key) ? want : this.freePlate();
      }
      const price = base + CATALOG.paints[paint] + CATALOG.interiors[interior] + CATALOG.rims[rims] + (custom ? CATALOG.plateCost : 0);
      if (!this.debit(c, price, 'car')) return { err: 'money', d: { money: P.money } };
      // one car at a time (as the single-player rental): the old one goes back, its plate is free again
      for (const old of P.cars || []) if (old.plate && this.plates.get(plateKey(old.plate)) === c.key) this.plates.delete(plateKey(old.plate));
      const car = { id: cfg.id, paint, interior, rims, plate, custom, since: Date.now() };
      P.cars = [car];
      this.plates.set(plateKey(plate), c.key);
      return { d: { money: P.money, car, price } };
    }
    return { err: 'bad_kind' };
  }

  carReturn(c, d) {
    const P = c.profile, k = plateKey(d.plate);
    const i = (P.cars || []).findIndex((car) => plateKey(car.plate) === k);
    if (i < 0) return { err: 'no_car' };
    P.cars.splice(i, 1);
    if (this.plates.get(k) === c.key) this.plates.delete(k);
    this.store.profiles.save();
    return { d: { cars: P.cars } };
  }

  // the client-owned parts of the profile (no money, nothing bought): whitelisted and checked
  profileSet(c, d) {
    const P = c.profile, v = d.value;
    switch (d.key) {
      case 'character': if (!str(v, 32) || !/^skier_\w+$/.test(v)) return { err: 'bad_value' }; P.character = v; break;
      case 'skis': if (v !== null && !P.owned.includes(v)) return { err: 'not_owned' }; P.skis = v; break;
      case 'outfitsEquipped': {
        if (!v || typeof v !== 'object' || JSON.stringify(v).length > 2000) return { err: 'bad_value' };
        const owns = (id) => id == null || CATALOG.outfits[id] === 0 || P.outfits.owned.includes(id) || P.outfits.owned.includes(String(id).split('.')[0]);
        for (const e of Object.values(v)) for (const id of Object.values(e || {})) if (!owns(id)) return { err: 'not_owned' };
        P.outfits.equipped = v; break;
      }
      case 'chalet': { // furniture and layout of your own chalet
        if (!P.chalet) return { err: 'no_chalet' };
        if (!v || typeof v !== 'object' || JSON.stringify(v).length > 48000) return { err: 'bad_value' };
        for (const [k2, x] of Object.entries(v)) if (!['id', 'owned', 'rented', 'since', 'name'].includes(k2)) P.chalet[k2] = x;
        break;
      }
      case 'stats': {
        if (!v || typeof v !== 'object') return { err: 'bad_value' };
        for (const k2 of ['topSpeed', 'longestJump', 'bestAir']) if (isNum(v[k2]) && v[k2] >= 0 && v[k2] < 1e6) P.stats[k2] = Math.max(P.stats[k2] || 0, v[k2]);
        if (isNum(v.distance) && v.distance >= (P.stats.distance || 0) && v.distance < 1e9) P.stats.distance = v.distance;
        break;
      }
      case 'records': if (!v || typeof v !== 'object' || JSON.stringify(v).length > 8000) return { err: 'bad_value' }; P.records = v; break;
      case 'secrets': if (!Array.isArray(v) || v.length > 200 || !v.every((x) => str(x, 40))) return { err: 'bad_value' }; P.secrets = v; break;
      case 'dayPass': if (!isInt(v)) return { err: 'bad_value' }; P.dayPass = v; break;
      case 'tickets': if (!isInt(v) || v < 0 || v > 999) return { err: 'bad_value' }; P.tickets = v; break;
      default: return { err: 'bad_key' };
    }
    this.store.profiles.save();
    return {};
  }

  broadcastAll(t, d) { const s = JSON.stringify({ t, d }); for (const c of this.online.values()) c.sendRaw(s); }
}
