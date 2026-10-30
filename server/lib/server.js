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
export const MAX_PLAYERS = 50;
export const TICK_HZ = 15;                 // presence batches per second
export const DAY_MS = 16 * 60 * 1000;      // one game day (sky.js DAY_SECONDS)
export const HELI_COPY_MS = 5 * 60 * 1000; // a rental out this long: a new copy waits at the pad
export const RACE_WAIT_MS = 45 * 1000;     // queue countdown once 2 are in (Oct 30, the user: 45 s, never at once)
export const BUS_RACE_WAIT_MS = RACE_WAIT_MS; // a bus race (catalog races[id].bus: free entry): the same 45 s countdown (Oct 30, the user: "keep the countdown from 45 sec not 20")
export const RACE_MAX = 21;                 // racers in one race at most (Oct 30, the user: "every race can have max 21 players"): a full field starts at once
export const RACE_LEAD_MS = 4000;          // the start is broadcast this far ahead (everyone counts down together)
export const RACE_MAX_MS = 10 * 60 * 1000; // a race is closed this long after its start at the latest
export const RACE_AFTER_FIRST_MS = 60 * 1000; // ...or this long after its first finisher (nobody waits for a racer who left)
export const RACE_BOARD_MS = 500;          // the live race board (raceBoard) goes out this often while a race runs
export const DEBT_FLOOR = -100000;        // the lowest the game's own charges (fees, fines) may take you
export const IMPOUND_MS = 3 * 60 * 1000;     // the tow yard holds a towed car this long (impound.js RELEASE_S)
export const GRACE_MS = 60 * 1000;         // a dropped connection keeps its player (world slot, seat, chalet plot, car,
                                           // helicopter, race entry) this long for a reconnect, measured from the last
                                           // message; then the player leaves for real
export const PERM_TIMEOUT_MS = 30 * 1000;
export const GRANT_UNUSED_MS = 60 * 1000; // a yes (car ride, chalet visit) not used this long lapses
// the in-game day: 1 on DAY_EPOCH, +1 at every world midnight (one game day = DAY_MS). Global, so a day pass
// bought in one world is the same day in another
export const DAY_EPOCH = Date.UTC(2026, 9, 1);
export const dayFor = (now = Date.now()) => 1 + Math.floor((now - DAY_EPOCH) / DAY_MS);
const HEARTBEAT_MS = 15000;   // WebSocket-level ping (answered by the browser itself, not the game's main thread)
const HEARTBEAT_MISSES = 3;   // nothing (no pong, no message) for 45 s: the connection is dead (terminated, then the grace period)
const FLOOD_WINDOW_MS = 10000, FLOOD_KICK = 400; // refused (over the rate limit) messages in 10 s before a kick
const NAME_RE = /^[A-Za-z0-9_ -]{3,16}$/;
// seats per vehicle kind at most; the client sends its vehicle's real seat count as n (Oct 30: every seat of every
// coupled car of a train: Wolkenspitzbahn and Legacy Express 4 cars x 48 = 192, a ski bus 36, a gondola cabin 6, a
// chair up to 6) and that is the vehicle's capacity: the lowest free one is assigned, one more is refused ('full')
// The ski buses' shared hold-ups (game/bus/bus.js, net/transit.js): a bus held up by something in its lane runs
// behind its timetable (a delay, s) and may be out in the other lane overtaking (sh 0..1) or pushing through (ram).
// The client driving it (the one that sees the block: busHold) reports that state a few times a second; the server
// keeps one record per bus, stamps it with its clock and broadcasts it, and everyone places that bus from it. A record
// whose reports stopped ages out the same way on every client and here (busHoldAt): the delay caught up at CATCH s/s,
// the lane offset eased back at SHIFT /s. Another client takes a fresh record over only with a longer delay (it sees
// something the reporter doesn't), a stale one (STALE_MS) freely. Mirror of bus.js holdAt (keep the two the same).
export const BUS_IDS = new Set(['bus:1', 'bus:2', 'bus:3', 'bus:4', 'bus:5', 'bus:6', 'bus:7']); // (bus.js FLEET_N 8: bus:0 is never shared)
export const BUS_HOLD = { FRESH: 1, CATCH: 0.2, SHIFT: 0.35, MAX: 60, STALE_MS: 2000, TAKE: 0.5 };
export function busHoldAt(rec, now, out = {}) {
  const el = Math.max(0, (now - rec.at) / 1000), f = Math.min(el, BUS_HOLD.FRESH), late = el - f;
  out.fresh = el < BUS_HOLD.FRESH;
  out.d = clamp(rec.d + (rec.dd || 0) * f - BUS_HOLD.CATCH * late, 0, BUS_HOLD.MAX);
  out.sh = clamp((rec.sh || 0) + (rec.sv || 0) * f - BUS_HOLD.SHIFT * late, 0, 1);
  out.ram = !!rec.ram && out.fresh;
  out.bt = (rec.bt || 0) + (out.fresh ? el : 0);
  out.done = !out.fresh && out.d <= 0 && out.sh <= 0;
  return out;
}
export const SEAT_CAPS = { bus: 48, train: 256, express: 256, gondola: 8, chair: 6, heli: 4, car: 5, sled: 2 };
// a player's car: its seats in all (the driver's too) per model, as in real life (src/net/vehicles.js carSeats); not
// listed: 5. Oct 30, the user: "the Mercedes GLS is a 5 seater not a 7 seater"
export const CAR_SEATS = { car_mercedes_sls: 2, car_lamborghini_huracan: 2 };
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
// max per payout; and EARN_HOURLY over the last hour, all sources, per account. sell: furniture sold back from your
// chalet (build mode: half its price; the dearest piece is $3,600)
const EARN_RULES = { job: 6000, secret: 10000, sell: 2000 };
const EARN_HOURLY = 60000;
// the in-game admin panel (src/ui/admin.js isAdmin): these accounts (name keys) may send 'admin' requests
export const ADMIN_KEYS = new Set(['rafael']);
const ADMIN_MONEY_MAX = 99999999; // (the panel's "set to" limit)
const ADMIN_WEATHER_HOLD_MS = 5 * 60 * 1000; // (single player holds a picked weather 300 s too)

export const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
export const nameKey = (s) => normName(s).toLowerCase();
export const validName = (s) => NAME_RE.test(s) && /[A-Za-z0-9]/.test(s);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const JAIL_MAX_S = 300, JAIL_SLACK = 3000; // (the longest sentence; the client's clock estimate may run a little ahead)
// riding in a wanted driver's car when the police arrest them (Oct 30, the user: "if a passenger is with a wanted person in
// a car they both go in prison if caught"): every passenger the seat registry has in the driver's car is jailed for the
// driver's sentence and fined the accomplice fine (half the police's base $3,000 arrest fine: game/police.js arrestFine);
// one such arrest per driver per ARREST_COOLDOWN_MS
export const ACCOMPLICE_FINE = 1500, ACCOMPLICE_JAIL_S = 45, /* (Oct 30, the user: "make jail time 45 sec") */ ARREST_COOLDOWN_MS = 60 * 1000;
// (Oct 30 2026, the user: "even if the passenger steps out and the person driving gets caught the passenger goes free,
// fix that, he/she should also go to prison"): anyone in a wanted driver's car at any point of the chase stays an
// accomplice (c.accomplices: their name keys, accompliceStep) until the chase is over, out of the car or not, and is
// jailed with the driver wherever they are (offline: in their profile, the cell at their next login). The chase as the
// server sees it: the driver's presence flags carry the stars (protocol.js F.wanted, while driving) or their profile
// has 'wanted' (police.js keeps it while wanted, also on foot). Over for ACCOMPLICE_KEEP_MS: forgotten (the grace: the
// driver's client forgets the chase just before its 'policeArrest'). Riding only before the chase: free.
const WANTED_BITS = 7 << 26, PRES_FLAGS = 12, ACCOMPLICE_KEEP_MS = 10 * 1000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
// the vehicle kinds 'veh' accepts (setVeh); /health lists them, so a redeploy can be checked from outside
const VEH_KINDS = ['car', 'heli', 'tow', 'police', 'rescue', 'sled'];
const validAt = (a) => Array.isArray(a) && a.length === 4 && a.every(isNum); // [x, y, z, yaw]
const str = (v, max = 64) => (typeof v === 'string' && v.length <= max ? v : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const _bh = {}; // (busHoldAt's scratch: World.tick)
// THE WERKSTATT's prices (game/carrental.js repairCost / wreckFee: the same sums): a repair, the flat repairFee ($500)
// for any car and any damage (none: $0); a wreck, the tow (wreckFee) and the repair ($2,000 for every car)
export const repairPrice = (id, frac) => (frac > 0 ? (CATALOG.repairFee ?? 500) : 0);
// THE AUTOHAUS CLERK (game/carrental.js clerkDialog): "Repair my car" at his desk, a flat fee for any damage, wherever
// the car is parked (the client's CLERK_REPAIR mirrors it; the price is never taken from the client)
export const CLERK_REPAIR = 500;
// Knocked poles / signs and broken guardrail sections (client world/breakables.js): relayed to the rest of the world
// and remembered this long (they stand again after 90 s), so a player joining meanwhile gets them already down
export const BRK_MS = 90 * 1000;
export const BRK_HZ = 10;              // knocks a player may send a second
const BRK_MAX = 400;                   // remembered per world at most (the oldest dropped)
const BRK_ID_RE = /^-?\d{1,7},-?\d{1,7}$/; // a spot rounded to 10 cm: "x*10,z*10"
export const wreckBill = (id) => (CATALOG.wreckFee ?? 1500) + repairPrice(id, 1);
// race queues: how many racers start a race (always at least 2; alone: a practice race, raceSolo) and its countdown once they are in
const raceNeed = (race) => Math.max(2, CATALOG.races[race]?.need ?? 2); // (Oct 30, the user: "you can't race with less than 2 people", bus races too)
const raceWait = (race) => (CATALOG.races[race]?.bus ? BUS_RACE_WAIT_MS : RACE_WAIT_MS);
// a bus race's prize (src/modes/race/busracedefs.js busRacePrize): the podium shares while someone is behind you,
// else every finisher is paid by the time against par (ms)
export function busPrize(def, i, n, time) {
  const sh = def.shares || [1, 0.7, 0.5];
  const share = i < sh.length && i < n - 1 ? sh[i] : isNum(time) && time <= (def.par || 0) ? def.parShare ?? 0.4 : def.rest ?? 0.3;
  return Math.round((def.reward || 0) * share);
}
const CANTONS = ['VS', 'GR', 'BE', 'UR', 'OW', 'TI', 'ZH', 'LU'];
export const cleanPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 \-]/g, '').replace(/\s+/g, ' ').replace(/^[ -]+/, '').slice(0, 8).trim();
const plateKey = (s) => cleanPlate(s).replace(/[ -]/g, '');
// A car's crash damage (client game/cardamage.js, carrental.js carDamage): damage 0..1, dents at most DENTS_MAX of
// [x, y, z, r, depth, seed] (the car's own frame, m; seed 0..100), kept on the car until it is repaired
export const DENTS_MAX = 12;
const validDents = (a) => Array.isArray(a) && a.length <= DENTS_MAX && a.every((d) => Array.isArray(d) && d.length === 6 && d.every((x) => isNum(x) && Math.abs(x) <= 100));
/** The look of a car everyone sees ('veh' cfg): model, paint, trim, rims, plate; its dents while it has any. */
const carLook = (car) => ({ id: car.id, paint: car.paint, interior: car.interior, rims: car.rims, plate: car.plate, ...(car.dents?.length ? { dents: car.dents } : {}) });

function newProfile(name) {
  return {
    name, money: 500, owned: [], skis: null, character: null,
    outfits: { owned: [], equipped: {} },
    chalet: null, cars: [],
    stats: { races: 0, wins: 0, earned: 0, topSpeed: 0, distance: 0, longestJump: 0, bestAir: 0 },
    records: {}, secrets: [], dayPass: -1, tickets: 0, created: Date.now(),
  };
}

// A token bucket. A refused message costs nothing (no debt: a burst after a network stall or a main-thread hitch
// is throttled for a moment, never for good).
class Bucket {
  constructor(cap, rate) { this.cap = cap; this.rate = rate; this.v = cap; this.t = Date.now(); }
  take(n = 1) {
    const now = Date.now();
    this.v = Math.min(this.cap, this.v + ((now - this.t) / 1000) * this.rate);
    this.t = now;
    if (this.v < n) return false;
    this.v -= n;
    return true;
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
    this.clock = { hour: 9.5, at: now, day: dayFor(now), weather: 'clear', next: now + 75000 };
    this.seats = new Map();   // vkey 'kind|id' -> Map(seat -> pid)
    this.holds = new Map();   // vkey -> Set(pid) holding the skip key
    this.vmeta = new Map();   // vkey -> { line, rate }
    this.warps = new Map();   // wkey 'kind|line' -> { off, rate, since }
    this.busHolds = new Map(); // bus id -> its hold-up record (busHold): { bus, d, dd, sh, sv, ram, bt, own, at }
    this.heli = { copies: [], padAt: 0, next: 1 };
    this.queues = new Map();  // race id -> { members: [pid], startAt: 0, timer }
    this.races = new Map();   // rid -> race
    this.nextRid = 1;
    this.dirty = new Map();   // pid -> presence row, sent with the next tick
    this.brk = new Map();     // 'k|id' -> { k, id, v, at }: knocked poles / broken guardrails of the last BRK_MS
  }

  get size() { return this.players.size; }

  hourAt(now = Date.now()) { return (((this.clock.hour + ((now - this.clock.at) / DAY_MS) * 24) % 24) + 24) % 24; }
  /** The in-game day at `now`: the clock's day, +1 at every midnight since (client: session.dayNow mirrors this). */
  dayAt(now = Date.now()) { return this.clock.day + Math.floor((this.clock.hour + ((now - this.clock.at) / DAY_MS) * 24) / 24); }
  clockMsg(now = Date.now()) { return { hour: this.hourAt(now), day: this.dayAt(now), at: now, dayMs: DAY_MS, weather: this.clock.weather }; }

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
      busHolds: [...this.busHolds.values()],
      heli: this.heliMsg(),
      queues: [...this.queues.keys()].map((r) => this.queueMsg(r)),
      races: [...this.races.values()].filter((r) => !r.done).map((r) => this.raceStartMsg(r)),
      brk: this.brkList(now),
    };
  }

  // ---------------------------------------------------------------- knocked poles, broken guardrails
  /** 'brk' { k: 'pole' | 'rail', id: 'x,z' (10 cm), v: [vx, vy, vz] }: relayed to everyone else, kept BRK_MS. */
  knock(c, d) {
    const k = d.k, id = str(d.id, 20), v = d.v;
    if ((k !== 'pole' && k !== 'rail') || !id || !BRK_ID_RE.test(id)) return { err: 'bad_brk' };
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => isNum(x) && Math.abs(x) <= 60)) return { err: 'bad_brk' };
    if (!c.brkBucket.take()) return { err: 'rate' };
    const now = Date.now(), key = `${k}|${id}`;
    this.brkPrune(now);
    if (this.brk.has(key)) return { err: 'down' }; // (already down: someone knocked it first)
    const e = { k, id, v: v.map((x) => Math.round(x * 100) / 100), at: now };
    this.brk.set(key, e);
    if (this.brk.size > BRK_MAX) this.brk.delete(this.brk.keys().next().value);
    this.broadcast('brk', { k, id, v: e.v, pid: c.pid }, c);
    return {};
  }
  brkPrune(now = Date.now()) {
    for (const [key, e] of this.brk) if (now - e.at >= BRK_MS) this.brk.delete(key); else break; // (in time order)
  }
  /** The knocks still down: [{ k, id, v, age }] (age: ms since). */
  brkList(now = Date.now()) {
    this.brkPrune(now);
    return [...this.brk.values()].map((e) => ({ k: e.k, id: e.id, v: e.v, age: now - e.at }));
  }

  tick(now) {
    if (now >= this.clock.next) {
      const opts = WEATHER_NEXT[this.clock.weather] || WEATHER_NEXT.clear;
      const h = this.hourAt(now), day = this.dayAt(now);
      this.clock = { hour: h, at: now, day, weather: opts[Math.floor(Math.random() * opts.length)], next: now + 80000 + Math.random() * 100000 };
      this.broadcast('clock', this.clockMsg(now));
    }
    for (const r of this.races.values()) if (!r.done && now >= r.at) this.raceBoard(r);
    if (this.busHolds.size) for (const [id, rec] of this.busHolds) if (busHoldAt(rec, now, _bh).done) { this.busHolds.delete(id); this.broadcast('busHold', { bus: id, clear: true, at: now }); } // (aged out: on time again)
    if (this.dirty.size) {
      const rows = [...this.dirty.values()];
      this.dirty.clear();
      this.broadcast('P', rows);
    }
  }

  // ---------------------------------------------------------------- seats
  seatsMsg(vk, m = this.seats.get(vk)) {
    const [k, v] = vk.split('|');
    return { k, v, occ: m ? [...m.entries()] : [], n: m?.cap || SEAT_CAPS[k] || 0 };
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
    // a passenger out of someone's car: that ride is used up (next time: ask again)
    if (s.k === 'car' && nameKey(s.v) !== c.key) this.server.endGrant('carRide', nameKey(s.v), c.key);
    // a car's driver gets out: the passengers stay seated (the car stays where it is); the owner leaving the world
    // empties it (see removePlayer)
    this.updateSkip(vk);
  }
  claimSeat(c, { k, v, n, seat }) {
    if (!SEAT_CAPS[k]) return { err: 'bad_vehicle' };
    v = str(v, 48);
    if (!v) return { err: 'bad_vehicle' };
    let cap = clamp(isInt(n) ? n : SEAT_CAPS[k], 1, SEAT_CAPS[k]);
    let first = 0;
    if (k === 'car') {
      // a player's car: vehicle id = the owner's name. Seat 0 (driver) is the owner's; anyone else needs the
      // owner's carRide permission and gets the lowest free passenger seat (1 = front, 2.. = back)
      const owner = this.server.onlineByKey(nameKey(v));
      if (!owner || owner.world !== this) return { err: 'owner_away' };
      v = owner.name;
      // no more seats than the owner's car has (its model: the car shown, else the profile's): a full car refuses
      const model = owner.vehs?.car?.cfg?.id || owner.profile?.cars?.[0]?.id;
      if (model) cap = Math.min(cap, CAR_SEATS[model] || SEAT_CAPS.car);
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
    if (pick < 0) return { err: 'full', d: { n: cap, taken: m ? m.size : 0 } };
    if (m && m.has(pick)) {
      // the car's owner takes the wheel back from nobody: seat 0 can only be the owner's anyway
      return { err: 'full', d: { n: cap, taken: m.size } };
    }
    this.releaseSeat(c);
    if (!m) { m = new Map(); this.seats.set(vk, m); }
    m.set(pick, c.pid);
    c.seat = { k, v, seat: pick };
    m.cap = cap; // (the 'seats' broadcast carries it: everyone sees how full the vehicle is)
    if (k === 'car' && first === 1) this.server.useGrant('carRide', nameKey(v), c.key); // (aboard: the yes is in use)
    this.broadcast('seats', this.seatsMsg(vk, m));
    this.updateSkip(vk);
    return { d: { seat: pick, v, n: cap, taken: m.size } };
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

  // ---------------------------------------------------------------- the ski buses' hold-ups (BUS_HOLD)
  // busHold { bus, d (s behind its timetable), dd (how fast that grows, s/s), sh (0..1 out in the other lane), sv
  // (its rate), ram (pushing through), bt (s held up so far) }; d 0, sh 0, no ram: back on its timetable (cleared)
  busHold(c, d) {
    const id = str(d.bus, 8);
    if (!id || !BUS_IDS.has(id)) return { err: 'bad_bus' };
    if (!isNum(d.d) || d.d < 0 || d.d > BUS_HOLD.MAX) return { err: 'bad_value' };
    if (d.sh !== undefined && (!isNum(d.sh) || d.sh < 0 || d.sh > 1)) return { err: 'bad_value' };
    c.busBucket ||= new Bucket(20, 10); // (a client reports at most ~4 a second per bus it drives)
    if (!c.busBucket.take()) return { err: 'rate_limited' };
    const now = Date.now();
    let rec = this.busHolds.get(id);
    const aged = rec ? busHoldAt(rec, now, {}) : null;
    if (aged?.done) { this.busHolds.delete(id); rec = null; }
    // someone else's fresh record: only a longer delay takes it over (that client sees something holding it up)
    if (rec && rec.own !== c.pid && now - rec.at < BUS_HOLD.STALE_MS && !(d.d > aged.d + BUS_HOLD.TAKE)) return { err: 'held', d: { own: rec.own, d: aged.d } };
    const sh = isNum(d.sh) ? d.sh : 0, ram = d.ram === true;
    if (d.d === 0 && sh === 0 && !ram) { // (on time again)
      if (rec) { this.busHolds.delete(id); this.broadcast('busHold', { bus: id, clear: true, at: now }); }
      return { d: { clear: true } };
    }
    const num = (v, a, b) => (isNum(v) ? clamp(v, a, b) : 0);
    rec = { bus: id, d: d.d, dd: num(d.dd, -4, 32), sh, sv: num(d.sv, -1, 1), ram, bt: num(d.bt, 0, 600), own: c.pid, at: now };
    this.busHolds.set(id, rec);
    this.broadcast('busHold', rec);
    return { d: { own: true } };
  }

  // ---------------------------------------------------------------- helicopter copies at the pad
  /** The old in-game admin panel's free helicopters (Oct 30, the user: "remove all admin spawned cars"; the 'heli'
   *  admin op is gone): any still out go, a 'heli' update tells everyone (and the vehicle shown with it). */
  purgeAdminHelis() {
    const gone = this.heli.copies.filter((h) => h.admin);
    if (!gone.length) return 0;
    this.heli.copies = this.heli.copies.filter((h) => !h.admin);
    for (const h of gone) { const o = [...this.players.values()].find((p) => p.key === h.key); if (o?.vehs?.heli) this.server.setVeh(o, { k: 'heli', off: true }); }
    this.broadcast('heli', this.heliMsg());
    return gone.length;
  }
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
    const [h] = this.heli.copies.splice(i, 1);
    if (!h.admin) this.heli.padAt = Math.min(this.heli.padAt, Date.now()); // (it lands back on the pad; an admin's free one never took the pad's)
    if (c.vehs.heli) this.server.setVeh(c, { k: 'heli', off: true });
    this.broadcast('heli', this.heliMsg());
    return {};
  }

  // ---------------------------------------------------------------- race queues and races
  queueMsg(race) {
    const q = this.queues.get(race);
    return { race, n: q ? q.members.length : 0, names: q ? q.members.map((pid) => this.players.get(pid)?.name).filter(Boolean) : [], startAt: q?.startAt || 0, need: raceNeed(race), waitMs: raceWait(race), max: RACE_MAX };
  }
  inRace(c) { for (const r of this.races.values()) if (!r.done && r.entrants.some((e) => e.key === c.key && !e.done)) return r; return null; }
  raceJoin(c, { race }) {
    if (!CATALOG.races[race]) return { err: 'bad_race' };
    if (this.inRace(c)) return { err: 'in_race' };
    // (already queued for it, e.g. a retry after a lost answer: unchanged; leaving and joining again would cancel and
    // restart a running countdown)
    if (c.queue === race && this.queues.get(race)?.members.includes(c.pid)) return { d: this.queueMsg(race) };
    // a full field (RACE_MAX): refused, wait for the next race (the client offers that, or a practice race)
    if ((this.queues.get(race)?.members.length || 0) >= RACE_MAX) return { err: 'race_full', d: this.queueMsg(race) };
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
    if (n < raceNeed(race)) { if (q.startAt) { q.startAt = 0; clearTimeout(q.timer); } }
    else if (n >= RACE_MAX) { clearTimeout(q.timer); this.startRace(race); return; } // (only a full field, RACE_MAX racers, starts at once; everyone in the world queued still waits the 45 s)
    else if (!q.startAt) { const wait = raceWait(race); q.startAt = now + wait; q.timer = setTimeout(() => { try { this.startRace(race); } catch (e) { this.server.log(`[err] startRace ${race}: ${e.stack || e}`); } }, wait); }
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
      // prog: the furthest the racer got (gate index passed, metres along the course, race ms at that point)
      entrants.push({ pid, key: c.key, name: c.name, slot: entrants.length, time: null, done: false, dnf: false, left: false, fin: 0, prog: { gate: 0, s: -Infinity, at: 0 } });
    }
    if (entrants.length < raceNeed(race)) { // (someone could not pay the entry: back to the queue for those left)
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
    r.timer = setTimeout(() => this.safeFinish(r), RACE_LEAD_MS + RACE_MAX_MS);
    this.races.set(r.rid, r);
    this.broadcast('raceQueue', { race, n: 0, names: [], startAt: 0, need: raceNeed(race), waitMs: raceWait(race), max: RACE_MAX });
    this.broadcast('raceStart', this.raceStartMsg(r));
  }
  /** A practice race (Oct 30, the user: "you can race alone but you don't earn any money", "call it a practise race"):
   *  any race, just you, started at once (the usual RACE_LEAD_MS countdown), out of a queue you were in. No entry fee,
   *  no prize money, no race / win counted (finishRace), so it can never be used to earn anything. */
  raceSolo(c, { race }) {
    if (!CATALOG.races[race]) return { err: 'bad_race' };
    if (this.inRace(c)) return { err: 'in_race' };
    this.raceLeave(c, true);
    const now = Date.now();
    const r = { rid: this.nextRid++, race, at: now + RACE_LEAD_MS, practice: true, done: false,
      entrants: [{ pid: c.pid, key: c.key, name: c.name, slot: 0, time: null, done: false, dnf: false, left: false, fin: 0, prog: { gate: 0, s: -Infinity, at: 0 } }] };
    r.timer = setTimeout(() => this.safeFinish(r), RACE_LEAD_MS + RACE_MAX_MS);
    this.races.set(r.rid, r);
    const msg = this.raceStartMsg(r);
    this.broadcast('raceStart', msg);
    return { d: msg };
  }
  raceStartMsg(r) { return { rid: r.rid, race: r.race, practice: !!r.practice, at: r.at, endAt: r.at + RACE_MAX_MS, closeAt: r.closeAt || 0, grid: r.entrants.map((e) => ({ pid: e.pid, name: e.name, slot: e.slot })) }; } // (endAt / closeAt: when it closes: the clients count the last 30 s down)
  // A finish. The server's own clock decides: the client's race time (raw: without gate penalties, pen: the
  // penalties) is trusted only within 3 s of the time the server measured since the shared GO, else the server's
  // time counts. Old clients send `time` (penalties included) instead.
  raceFinish(c, { rid, time, raw, pen, dnf }) {
    const r = this.races.get(rid);
    if (!r || r.done) return { err: 'bad_race' };
    const e = r.entrants.find((x) => x.key === c.key);
    if (!e) return { err: 'not_entered' };
    if (e.done) return { err: 'already_done', d: { time: e.time } };
    const now = Date.now(), elapsed = now - r.at;
    e.done = true;
    if (dnf || elapsed < 0) { e.dnf = true; }
    else {
      const plausible = (t) => isNum(t) && t > 0 && Math.abs(t - elapsed) <= 3000;
      if (isNum(raw)) e.time = Math.round((plausible(raw) ? raw : elapsed) + clamp(isNum(pen) ? pen : 0, 0, 10 * 60 * 1000));
      else e.time = Math.round(plausible(time) ? time : elapsed);
      e.fin = now;
      e.prog = { gate: Math.max(e.prog.gate, 9999), s: Infinity, at: e.time };
      // the first one home: the rest have RACE_AFTER_FIRST_MS to finish (the race never waits for someone who left)
      if (!r.closeT) { r.closeAt = now + RACE_AFTER_FIRST_MS; r.closeT = setTimeout(() => this.safeFinish(r), RACE_AFTER_FIRST_MS); }
    }
    this.broadcast('raceProgress', { rid, pid: e.pid, name: e.name, time: e.time, dnf: e.dnf, closeAt: r.closeAt || 0 });
    this.raceBoard(r, true);
    if (r.entrants.every((x) => x.done)) this.finishRace(r);
    return { d: { time: e.time } };
  }
  /** Live progress of a racer: { rid, gate (gates passed), s (metres along the course) }, a couple of times a second. */
  raceProgress(c, { rid, gate, s }) {
    const r = this.races.get(rid);
    if (!r || r.done) return { err: 'bad_race' };
    const e = r.entrants.find((x) => x.key === c.key);
    if (!e || e.done) return {};
    if (!isInt(gate) || gate < 0 || gate > 999 || !isNum(s) || s < -1000 || s > 1e6) return { err: 'bad_value' };
    // (only forward: a respawn a few metres back keeps the racer's best)
    if (gate > e.prog.gate || (gate === e.prog.gate && s > e.prog.s)) e.prog = { gate, s, at: Date.now() - r.at };
    return {};
  }
  // Race order: finishers by time (then by who was home first), then everyone else by how far they got (gate, metres),
  // racers still out there before those who gave up or left.
  rankEntrants(r) {
    const by = (a, b) => (b.prog.gate - a.prog.gate) || ((b.prog.s === a.prog.s) ? 0 : (b.prog.s > a.prog.s ? 1 : -1));
    const fin = r.entrants.filter((e) => e.done && !e.dnf).sort((a, b) => (a.time - b.time) || (a.fin - b.fin));
    const racing = r.entrants.filter((e) => !e.done).sort(by);
    const out = r.entrants.filter((e) => e.done && e.dnf).sort(by);
    return [...fin, ...racing, ...out];
  }
  boardRow(e, place) {
    const c = this.server.onlineByKey(e.key);
    return {
      pid: e.pid, name: e.name, place, time: e.done && !e.dnf ? e.time : null, dnf: e.dnf, left: e.left,
      gate: e.prog.gate >= 9999 ? null : e.prog.gate, s: Number.isFinite(e.prog.s) ? Math.round(e.prog.s) : null,
      off: !c || !!c.dropped, // (connection dropped: held for a reconnect)
    };
  }
  /** The live race board to everyone in the world: raceBoard { rid, race, rows: [{ pid, name, place, time, dnf, gate, s, off }] }. */
  raceBoard(r, force = false) {
    const now = Date.now();
    if (!force && now - (r.boardAt || 0) < RACE_BOARD_MS) return;
    r.boardAt = now;
    this.broadcast('raceBoard', { rid: r.rid, race: r.race, rows: this.rankEntrants(r).map((e, i) => this.boardRow(e, i + 1)) });
  }
  safeFinish(r) { try { this.finishRace(r); } catch (e) { this.server.log(`[err] finishRace ${r.rid}: ${e.stack || e}`); } }
  /** A racer who left the world for good (no reconnect within the grace period, or LEAVE MULTIPLAYER): DNF, placed
   *  by how far they got. They may come back while the race runs (addPlayer) and carry on. */
  dropFromRace(c) {
    const r = this.inRace(c);
    if (!r) return;
    const e = r.entrants.find((x) => x.key === c.key);
    e.done = true; e.dnf = true; e.left = true;
    this.broadcast('raceProgress', { rid: r.rid, pid: e.pid, name: e.name, time: null, dnf: true });
    this.raceBoard(r, true);
    if (r.entrants.every((x) => x.done)) this.finishRace(r);
  }
  /** The race is over: everyone placed (finishers by time, then the rest by progress), prize money paid ONCE per
   *  racer by place (reward x [1, 0.4, 0.15]; a racer who did not finish wins nothing), raceResult to the world. */
  finishRace(r) {
    if (r.done) return;
    r.done = true;
    clearTimeout(r.timer); clearTimeout(r.closeT);
    for (const e of r.entrants) if (!e.done) { e.done = true; e.dnf = true; }
    const def = CATALOG.races[r.race] || { reward: 0 }, share = CATALOG.prizeShare || [1, 0.4, 0.15];
    const n = r.entrants.length;
    const order = this.rankEntrants(r).map((e, i) => {
      const place = i + 1, prize = !e.dnf && !e.paid && !r.practice ? (def.bus ? busPrize(def, i, n, e.time) : Math.round((def.reward || 0) * (share[i] ?? 0))) : 0;
      const row = { ...this.boardRow(e, place), prize };
      const prof = this.server.profileOf(e.key);
      if (prof && !e.paid && r.practice) e.paid = true; // (a practice race: nothing paid, nothing counted)
      else if (prof && !e.paid) {
        e.paid = true; // (once per racer, whatever happens)
        prof.stats.races = (prof.stats.races || 0) + 1;
        if (place === 1 && !e.dnf) prof.stats.wins = (prof.stats.wins || 0) + 1;
        if (prize) { prof.money += prize; prof.stats.earned = (prof.stats.earned || 0) + prize; }
        const c = this.server.onlineByKey(e.key);
        if (c && prize) c.send('money', { v: prof.money, why: 'race', delta: prize });
      }
      return row;
    });
    this.server.store.profiles.save();
    r.result = { rid: r.rid, race: r.race, practice: !!r.practice, order, keys: r.entrants.map((e) => e.key) };
    r.endedAt = Date.now();
    this.broadcast('raceResult', { rid: r.rid, race: r.race, practice: !!r.practice, order });
    setTimeout(() => this.races.delete(r.rid), 60000);
  }
  /** The result of a race this player was in that ended in the last minute (for a reconnect that missed it). */
  lastRaceFor(key) {
    let best = null;
    for (const r of this.races.values()) if (r.done && r.result?.keys.includes(key) && (!best || r.endedAt > best.endedAt)) best = r;
    return best ? { rid: best.rid, race: best.race, practice: !!best.practice, order: best.result.order } : null;
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
    this.purgeAdminHelis();
    // back in a race you dropped out of (gone longer than the grace period, the race still on): carry on from where
    // you were (your client still runs the race; the server forgets the DNF)
    for (const r of this.races.values()) {
      const e = !r.done && r.entrants.find((x) => x.key === c.key && x.left && x.time === null);
      if (e) { e.done = false; e.dnf = false; e.left = false; e.pid = c.pid; this.raceBoard(r, true); }
    }
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
    this.vehs = { car: null, heli: null, tow: null, police: null, rescue: null, sled: null }; // the vehicles you show: { k: 'car', cfg, at? }, { k: 'heli', id, at? }, { k: 'tow', at, v, car } (setVeh)
    this.queue = null;     // race id queued for
    this.plot = null;      // the chalet plot your chalet stands on while you are online (null: none / waiting for one)
    this.chaletWaiting = false; // you own a chalet but every plot is taken: it is placed when one frees up
    this.bucket = new Bucket(240, 80);   // requests and events
    this.pBucket = new Bucket(60, 30);   // presence rows (the client sends 12 a second)
    this.brkBucket = new Bucket(BRK_HZ, BRK_HZ); // knocked poles / broken guardrails (World.knock)
    this.refused = 0; this.refusedT = 0; // messages refused by the rate limit in the current FLOOD_WINDOW_MS
    this.dropped = 0;      // the connection dropped at (ms; 0 = connected): the player is held for a reconnect
    this.graceT = null;
  }
  sendRaw(s) { if (this.ws && this.ws.readyState === 1) this.ws.send(s); }
  send(t, d) { this.sendRaw(JSON.stringify({ t, d })); }
  res(id, ok, d, err) { if (id == null) return; this.sendRaw(JSON.stringify(ok ? { t: 'res', id, ok: true, d } : { t: 'res', id, ok: false, err, d })); }
  publicInfo() { return { pid: this.pid, name: this.name, look: this.look, pres: this.pres, interior: this.interior, chalet: this.plot, vehs: this.vehs, tt: this.tt || null }; }
}

// ------------------------------------------------------------------ the server
export class GameServer {
  constructor({ dataDir, log = console.log, regPerHour = 5, graceMs = GRACE_MS, heartbeatMs = HEARTBEAT_MS } = {}) {
    this.store = new Store(dataDir);
    this.graceMs = graceMs;
    this.heartbeatMs = heartbeatMs;
    this.regPerHour = regPerHour; // new names from one address an hour
    this.log = log;
    this.worlds = new Map();
    this.nextWorld = 1;
    this.online = new Map(); // nameKey -> Client
    this.lastWorld = new Map(); // nameKey -> { id, t }: a reconnect lands in the same world if it has room
    // `${kind}|${ownerKey}|${guestKey}` -> { used, timer }: SINGLE USE. A yes lets the guest in once (one boarding
    // of the car, one entry into the chalet); it is gone when they get out / leave, or after GRANT_UNUSED_MS unused.
    // The next time they ask again and the owner is asked again.
    this.grants = new Map();
    this.grantMs = GRANT_UNUSED_MS;
    this.pending = new Map(); // rid -> permission request
    this.nextPerm = 1;
    this.regByIp = new Map(); // ip -> [t]: at most 5 new names an hour from one address
    this.earnedBy = new Map(); // nameKey -> [[t, amount]] over the last hour (per account: a new login does not reset it)
    // global registries, rebuilt from the profiles
    this.plates = new Map(); // plateKey -> nameKey
    for (const [k, p] of Object.entries(this.store.profiles.data)) {
      for (const car of p.cars || []) if (car.plate) this.plates.set(plateKey(car.plate), k);
    }
    // chalets: OWNING one is for good (profile.chalet: its furniture and layout, and profile.chalet.id, the plot it
    // last stood on); the PLOT (1 of the village's 18) is held only while its owner is online. Offline, the plot is
    // free (anyone may buy a chalet there); back online, the owner gets the old plot if it is free, else another free
    // one (the furniture is the owner's, so it moves along), else waits for one (chaletWait, first come first served)
    this.chalets = new Map(); // plot id -> nameKey of the ONLINE owner whose chalet stands there
    this.chaletWait = [];     // nameKeys of online owners without a plot
    this.plotIds = Array.isArray(CATALOG.chalet?.plots) ? CATALOG.chalet.plots.slice() : null; // the village's house plots (else: from a login, plotsHint)
  }

  // ---------------------------------------------------------------- lifecycle
  listen(port = 8787, host = '127.0.0.1') {
    this.http = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ws/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, proto: PROTO, worlds: this.worlds.size, players: this.online.size, veh: VEH_KINDS }));
        return;
      }
      if (req.url.startsWith('/admin/')) {
        try { this.admin(req, res); } catch (e) { this.log(`[err] admin ${req.url}: ${e.stack || e}`); if (!res.headersSent) { res.writeHead(500); res.end(); } }
        return;
      }
      res.writeHead(404); res.end();
    });
    // (256 KB: a big chalet layout fits; an oversized frame would close the socket with 1009)
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 256 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.tickT = setInterval(() => {
      const now = Date.now();
      for (const w of this.worlds.values()) { try { w.tick(now); } catch (e) { this.log(`[err] tick world ${w.id}: ${e.stack || e}`); } }
    }, 1000 / TICK_HZ);
    this.beatT = setInterval(() => this.heartbeat(), this.heartbeatMs);
    return new Promise((resolve) => this.http.listen(port, host, () => resolve(this.http.address().port)));
  }

  async close(reason = 'shutdown') {
    clearInterval(this.tickT); clearInterval(this.beatT);
    for (const c of this.online.values()) { clearTimeout(c.graceT); c.send('bye', { reason }); }
    for (const ws of this.wss?.clients || []) ws.close(1012, reason); // (1012: service restart, the clients reconnect)
    this.store.flush();
    await new Promise((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  // WebSocket-level pings: the browser answers them itself, so a game busy loading terrain for a few seconds still
  // counts as alive. Only HEARTBEAT_MISSES pings in a row without a pong or any message end the connection (which
  // then gets the grace period like any other drop).
  heartbeat() {
    const now = Date.now();
    for (const ws of this.wss.clients) {
      const quiet = now - (ws.lastSeen || 0);
      if (quiet > this.heartbeatMs * HEARTBEAT_MISSES) {
        this.log(`[drop] ${ws.conn?.c?.name || ws.conn?.c?.ip || '?'}: no heartbeat for ${Math.round(quiet / 1000)} s`);
        ws.terminate();
        continue;
      }
      try { ws.ping(); } catch { /* closing */ }
    }
  }

  /** Close a connection on purpose (logged; no grace period). */
  kick(c, reason, code = 1008) {
    this.log(`kick ${c.name || c.ip}: ${reason}`);
    c.kicked = true;
    try { c.ws?.close(code, reason); } catch { /* closed */ }
  }

  onConnection(ws, req) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    // conn.c: the player this socket speaks for (a login that resumes a held player points it at that one)
    const conn = { c: new Client(this, ws, ip) };
    ws.conn = conn;
    ws.lastSeen = Date.now();
    ws.on('pong', () => { ws.lastSeen = Date.now(); });
    ws.on('message', (buf, isBinary) => {
      ws.lastSeen = Date.now();
      const c = conn.c;
      if (isBinary || c.ws !== ws) return; // (a socket replaced by a newer login: ignored)
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'p') {
        if (c.pBucket.take()) { try { this.onPresence(c, m.d); } catch (e) { this.log(`[err] presence ${c.name}: ${e.stack || e}`); } }
        return;
      }
      if (!c.bucket.take()) {
        // over the limit: refused (the client may retry). Only a sustained flood is kicked
        const now = Date.now();
        if (now - c.refusedT > FLOOD_WINDOW_MS) { c.refusedT = now; c.refused = 0; }
        if (++c.refused > FLOOD_KICK) { this.kick(c, `rate limit (${c.refused} messages refused in ${FLOOD_WINDOW_MS / 1000} s, last '${String(m.t).slice(0, 20)}')`); return; }
        c.res(m.id, false, null, 'rate');
        return;
      }
      try { this.onMessage(c, m, conn); } catch (e) { this.log(`[err] ${m.t}: ${e.stack || e}`); c.res(m.id, false, null, 'server'); }
    });
    ws.on('close', (code, why) => {
      try { this.onSocketClose(conn.c, ws, code, String(why || '')); } catch (e) { this.log(`[err] close: ${e.stack || e}`); }
    });
    ws.on('error', (e) => this.log(`[ws error] ${conn.c.name || ip}: ${e.message || e}`));
  }

  // A socket closed. A deliberate close (LEAVE MULTIPLAYER: 1000, the tab closing: 1001, a close frame without a
  // code: 1005) or a kick removes the player at once; anything else (1006: the network dropped, a heartbeat timeout,
  // a proxy restart) holds the player for the grace period: a reconnect within it carries on as if nothing happened.
  onSocketClose(c, ws, code, why) {
    if (c.ws !== ws) return; // (replaced by a newer connection: that one is the player now)
    if (!c.key || this.online.get(c.key) !== c) return;
    const deliberate = code === 1000 || code === 1001 || code === 1005;
    if (deliberate || c.kicked || !this.graceMs || !c.world) {
      if (!deliberate && !c.kicked) this.log(`[drop] ${c.name}: closed ${code}${why ? ` (${why})` : ''}`);
      this.onClose(c);
      return;
    }
    c.ws = null;
    c.dropped = Date.now();
    const left = Math.max(Math.min(5000, this.graceMs), (ws.lastSeen || c.dropped) + this.graceMs - c.dropped);
    this.log(`[drop] ${c.name}: closed ${code}${why ? ` (${why})` : ''}, held ${Math.round(left / 1000)} s for a reconnect`);
    clearTimeout(c.graceT);
    c.graceT = setTimeout(() => {
      c.graceT = null;
      if (c.ws || !c.dropped) return;
      this.log(`[-] ${c.name}: no reconnect within the grace period`);
      try { this.onClose(c); } catch (e) { this.log(`[err] grace: ${e.stack || e}`); }
    }, left);
  }

  onClose(c) {
    if (!c.key || this.online.get(c.key) !== c) return;
    clearTimeout(c.graceT); c.graceT = null;
    this.online.delete(c.key);
    this.settleCar(c); // (gone mid-tow: the car's record ends in the impound bay / its own bay)
    const w = c.world;
    if (w) {
      this.lastWorld.set(c.key, { id: w.id, t: Date.now() });
      w.removePlayer(c);
      if (!w.size) { this.worlds.delete(w.id); clearTimeout(w.heli.timer); }
    }
    this.unplaceChalet(c);
    this.dropGrants(c.key);
    this.store.profiles.save();
    this.log(`[-] ${c.name} (${this.online.size} online)`);
  }

  onlineByKey(k) { return this.online.get(k) || null; }
  profileOf(k) { return this.store.profiles.data[k] || null; }

  // Admin, from the server machine only (curl on 127.0.0.1; nginx passes only /ws and /health, never /admin):
  //   /admin/give?name=Sammy&amount=100     money to a player (negative takes it away); online, they see it at once
  //   /admin/giveall?amount=200               money to every player
  //   /admin/tp?name=Sammy&to=Rafael          Sammy next to Rafael (both online, same world)
  //   /admin/kick?name=Sammy                  Sammy off the server (back to his menu; he can join again)
  //   /admin/players                         every account: name, money, online
  admin(req, res) {
    const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o) + '\n'); };
    const ip = req.socket.remoteAddress || '';
    if (req.headers['x-forwarded-for'] || !/^(127\.|::1$|::ffff:127\.)/.test(ip)) return out(403, { ok: false, error: 'local only' });
    const u = new URL(req.url, 'http://local');
    if (u.pathname === '/admin/players') {
      const list = Object.entries(this.store.profiles.data).map(([k, p]) => ({ name: p.name || this.store.accounts?.data?.[k]?.name || k, money: p.money, online: this.online.has(k) }));
      return out(200, { ok: true, players: list });
    }
    if (u.pathname === '/admin/give') {
      const name = u.searchParams.get('name') || '', amount = Math.round(Number(u.searchParams.get('amount')));
      if (!name || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e7) return out(400, { ok: false, error: 'use ?name=<player>&amount=<number>' });
      const k = nameKey(name), prof = this.profileOf(k);
      if (!prof) return out(404, { ok: false, error: `no player called ${name}` });
      const c = this.online.get(k);
      if (c?.profile && c.profile !== prof) c.profile.money += amount;
      prof.money += amount;
      this.store.profiles.save();
      if (c) c.send('money', { v: c.profile?.money ?? prof.money, why: 'gift', delta: amount });
      this.log(`[admin] ${amount >= 0 ? 'gave' : 'took'} ${Math.abs(amount)} ${amount >= 0 ? 'to' : 'from'} ${name} -> ${prof.money}`);
      return out(200, { ok: true, name, money: prof.money, online: !!c });
    }
    if (u.pathname === '/admin/tp') { // /admin/tp?name=Sammy&to=Rafael: Sammy (online) next to Rafael (online, same world)
      const a = this.online.get(nameKey(u.searchParams.get('name') || '')), b = this.online.get(nameKey(u.searchParams.get('to') || ''));
      if (!a || !b) return out(404, { ok: false, error: `${!a ? u.searchParams.get('name') : u.searchParams.get('to')} is not online` });
      if (a === b) return out(400, { ok: false, error: 'same player' });
      if (a.world !== b.world) return out(409, { ok: false, error: `${a.name} is in world ${a.world?.id}, ${b.name} in world ${b.world?.id}` });
      const r = b.pres;
      if (!r) return out(409, { ok: false, error: `${b.name} has not moved yet` });
      if (r[14]) return out(409, { ok: false, error: `${b.name} is inside (${r[14]})` });
      a.send('adminTp', { x: r[2], y: r[3], z: r[4], yaw: r[5], to: b.name });
      this.log(`[admin] teleport ${a.name} -> ${b.name}`);
      return out(200, { ok: true, moved: a.name, to: b.name, at: [r[2], r[3], r[4]] });
    }
    if (u.pathname === '/admin/kick') { // /admin/kick?name=Sammy: off the server now (no automatic reconnect; they can rejoin)
      const c = this.online.get(nameKey(u.searchParams.get('name') || ''));
      if (!c) return out(404, { ok: false, error: `${u.searchParams.get('name')} is not online` });
      c.kicked = true;
      try { c.send('bye', { reason: 'kicked' }); } catch { /* closed */ }
      try { c.ws?.close(4001, 'kicked'); } catch { /* closed */ }
      try { clearTimeout(c.graceT); this.onClose(c); } catch (e) { this.log(`[err] kick ${c.name}: ${e.stack || e}`); }
      this.log(`[admin] kicked ${c.name}`);
      return out(200, { ok: true, kicked: c.name });
    }
    if (u.pathname === '/admin/giveall') { // (every account, online or not)
      const amount = Math.round(Number(u.searchParams.get('amount')));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e7) return out(400, { ok: false, error: 'use ?amount=<number>' });
      const done = [];
      for (const [k, prof] of Object.entries(this.store.profiles.data)) {
        const c = this.online.get(k);
        if (c?.profile && c.profile !== prof) c.profile.money += amount;
        prof.money += amount;
        if (c) c.send('money', { v: c.profile?.money ?? prof.money, why: 'gift', delta: amount });
        done.push({ name: prof.name || this.store.accounts?.data?.[k]?.name || k, money: prof.money, online: !!c });
      }
      this.store.profiles.save();
      this.log(`[admin] ${amount >= 0 ? 'gave' : 'took'} ${Math.abs(amount)} ${amount >= 0 ? 'to' : 'from'} all ${done.length} players`);
      return out(200, { ok: true, amount, players: done });
    }
    return out(404, { ok: false, error: 'unknown admin command' });
  }

  // ---------------------------------------------------------------- the in-game admin panel (src/ui/admin.js)
  // Oct 30, the user: "the admin panel doesn't work on multiplayer, it reverts immediately". The panel is for the
  // account named Rafael only; in multiplayer its server-owned actions come here: 'admin' { op, ... }, accepted only
  // from a connection LOGGED IN as an admin account (c.key: this server's own login, never a client flag).
  //   money { add } | { set }   your balance (a 'money' update follows, so the client's money guard takes it)
  //   unlock { what: 'skis' | 'outfits' }   every pair of skis / every outfit piece and kit in the catalog
  //   pass { on }               today's day pass (the world's day) | off: no pass, no tickets
  //   time { hour }             the clock of your world (everyone in it shares the sky)
  //   weather { w }             your world's weather, held 5 min before it moves on by itself
  //   (heli, the panel's free helicopter: gone, Oct 30 "remove all admin spawned cars"; refused as bad_op)
  //   tp { x, z, label } | spawn { kind }   nothing to change here (the client moves / spawns): logged only
  adminOp(c, d) {
    const op = str(d.op, 16);
    if (!c.key || !ADMIN_KEYS.has(c.key)) { this.log(`[admin] refused ${op || '?'} from ${c.name || c.ip}`); return { err: 'forbidden' }; }
    const P = c.profile, w = c.world, now = Date.now();
    switch (op) {
      case 'money': {
        let v;
        if (d.add != null) {
          if (!isInt(d.add) || d.add === 0 || Math.abs(d.add) > 1e7) return { err: 'bad_amount', d: { money: P.money } };
          v = Math.max(Math.min(P.money, 0), Math.min(ADMIN_MONEY_MAX, P.money + d.add)); // (never below where you were, nor below 0 by it)
        } else if (d.set != null) {
          if (!isInt(d.set) || d.set < 0 || d.set > ADMIN_MONEY_MAX) return { err: 'bad_amount', d: { money: P.money } };
          v = d.set;
        } else return { err: 'bad_amount', d: { money: P.money } };
        const delta = v - P.money;
        P.money = v;
        this.store.profiles.save();
        c.send('money', { v, why: 'admin', delta });
        this.log(`[admin] ${c.name}: money ${d.add != null ? `${d.add >= 0 ? '+' : ''}${d.add}` : `set ${d.set}`} -> ${v}`);
        return { d: { money: v, delta } };
      }
      case 'unlock': {
        if (d.what === 'skis') {
          for (const id of Object.keys(CATALOG.skis)) if (!P.owned.includes(id)) P.owned.push(id);
          this.store.profiles.save();
          this.log(`[admin] ${c.name}: unlocked all skis`);
          return { d: { owned: P.owned } };
        }
        if (d.what === 'outfits') {
          P.outfits = P.outfits && Array.isArray(P.outfits.owned) ? P.outfits : { owned: [], equipped: P.outfits?.equipped || {} };
          for (const id of Object.keys(CATALOG.outfits)) if (!P.outfits.owned.includes(id)) P.outfits.owned.push(id);
          this.store.profiles.save();
          this.log(`[admin] ${c.name}: unlocked all outfits`);
          return { d: { outfits: P.outfits } };
        }
        return { err: 'bad_value' };
      }
      case 'pass': {
        if (d.on === false) { P.dayPass = -1; P.tickets = 0; } else P.dayPass = w.dayAt(now);
        this.store.profiles.save();
        this.log(`[admin] ${c.name}: day pass ${d.on === false ? 'and tickets reset' : `for day ${P.dayPass}`}`);
        return { d: { dayPass: P.dayPass, tickets: P.tickets } };
      }
      case 'time': {
        if (!isNum(d.hour) || d.hour < 0 || d.hour > 24) return { err: 'bad_value' };
        const day = w.dayAt(now); // (the same day, at the new hour: the day pass and the jobs count on)
        w.clock = { ...w.clock, hour: d.hour % 24, at: now, day };
        w.broadcast('clock', w.clockMsg(now));
        this.log(`[admin] ${c.name}: world ${w.id} time ${d.hour.toFixed(2)}`);
        return { d: { clock: w.clockMsg(now) } };
      }
      case 'weather': {
        if (typeof d.w !== 'string' || !Object.hasOwn(WEATHER_NEXT, d.w)) return { err: 'bad_value' };
        w.clock = { ...w.clock, weather: d.w, next: now + ADMIN_WEATHER_HOLD_MS };
        w.broadcast('clock', w.clockMsg(now));
        this.log(`[admin] ${c.name}: world ${w.id} weather ${d.w}`);
        return { d: { clock: w.clockMsg(now) } };
      }
      case 'tp': {
        if (!isNum(d.x) || !isNum(d.z)) return { err: 'bad_value' };
        this.log(`[admin] ${c.name}: teleport ${str(d.label, 60) || ''} (${Math.round(d.x)}, ${Math.round(d.z)})`);
        return {};
      }
      case 'spawn': {
        const kind = str(d.kind, 16);
        if (!kind) return { err: 'bad_value' };
        this.log(`[admin] ${c.name}: spawn ${kind}`);
        return {};
      }
      default: return { err: 'bad_op' };
    }
  }

  // ---------------------------------------------------------------- money (server-authoritative)
  debit(c, amount, why, floor = 0) {
    amount = Math.round(amount);
    if (!(amount >= 0) || c.profile.money - amount < floor) return false;
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
  /** The owner said yes: one use, lapsing after grantMs unused. */
  addGrant(kind, ownerKey, guestKey) {
    const k = `${kind}|${ownerKey}|${guestKey}`;
    clearTimeout(this.grants.get(k)?.timer);
    const e = { used: false, timer: null };
    e.timer = setTimeout(() => { if (this.grants.get(k) === e && !e.used) this.endGrant(kind, ownerKey, guestKey); }, this.grantMs);
    this.grants.set(k, e);
  }
  /** The guest is in (seated in the car, inside the chalet): the grant no longer lapses; it ends when they get out. */
  useGrant(kind, ownerKey, guestKey) {
    const e = this.grants.get(`${kind}|${ownerKey}|${guestKey}`);
    if (e && !e.used) { e.used = true; clearTimeout(e.timer); e.timer = null; }
  }
  /** Used up (out of the car, out of the chalet), lapsed or revoked. */
  endGrant(kind, ownerKey, guestKey) {
    const k = `${kind}|${ownerKey}|${guestKey}`, e = this.grants.get(k);
    if (!e) return false;
    clearTimeout(e.timer);
    this.grants.delete(k);
    if (kind === 'chaletVisit') this.sendGuests(ownerKey);
    return true;
  }
  dropGrants(k) {
    const owners = new Set();
    for (const g of [...this.grants.keys()]) { const [kind, o, gu] = g.split('|'); if (o === k || gu === k) { clearTimeout(this.grants.get(g).timer); this.grants.delete(g); if (kind === 'chaletVisit' && o !== k) owners.add(o); } }
    for (const [rid, p] of [...this.pending]) if (p.from.key === k || p.to.key === k) this.answerPerm(rid, false, 'gone');
    for (const o of owners) this.sendGuests(o);
  }
  /** The owner's guest list (chalet visitors allowed in): 'guests' { kind, names } to the owner. */
  sendGuests(ownerKey, kind = 'chaletVisit') {
    const o = this.online.get(ownerKey);
    if (!o) return;
    o.send('guests', { kind, names: this.guestNames(ownerKey, kind) });
  }
  guestNames(ownerKey, kind = 'chaletVisit') {
    const pre = `${kind}|${ownerKey}|`, names = [];
    for (const g of this.grants.keys()) if (g.startsWith(pre)) names.push(this.store.accounts.data[g.slice(pre.length)]?.name || '?');
    return names;
  }
  answerPerm(rid, allow, reason = null) {
    const p = this.pending.get(rid);
    if (!p) return false;
    this.pending.delete(rid);
    clearTimeout(p.timer);
    if (allow) { this.addGrant(p.kind, p.to.key, p.from.key); if (p.kind === 'chaletVisit') this.sendGuests(p.to.key); }
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
    // the sender's own clock (its estimate of ours) keeps the rows' spacing smooth, but a sender whose estimate is off
    // (a slow machine answering pings late, an asymmetric connection) made everyone see that one player hundreds of ms
    // behind, all the time (Oct 29, the user: "why is it always the same person lagging behind"): each player's clock
    // error is measured on arrival (smoothed) and taken out, so every row is on the server's own clock
    let ts = d[0];
    const dev = now - ts;
    if (!Number.isFinite(c.tsBias) || Math.abs(dev - c.tsBias) > 1500) c.tsBias = dev;
    else c.tsBias += (dev - c.tsBias) * 0.05;
    ts += c.tsBias;
    if (Math.abs(ts - now) > 2000) ts = now; // (still way off: stamped on arrival)
    const row = [c.pid, Math.round(ts)];
    for (let i = 1; i <= 11; i++) row.push(isNum(d[i]) ? Math.round(d[i] * 100) / 100 : 0);
    row[9] = clamp(row[9] | 0, 0, 15); // state
    // the vehicle and the interior are the server's own records (seat registry, approved interior)
    row.push(c.seat ? `${c.seat.k}:${c.seat.v}:${c.seat.seat}` : 0);
    row.push(c.interior || 0);
    c.pres = row;
    c.world.dirty.set(c.pid, row);
    this.accompliceStep(c, now);
  }
  // a wanted driver's passengers, kept as accomplices for the whole chase (ACCOMPLICE_KEEP_MS above; policeArrest)
  accompliceStep(c, now = Date.now()) {
    const w = c.world;
    if (!w || !c.name) return;
    const on = !!c.profile?.wanted || ((c.pres?.[PRES_FLAGS] | 0) & WANTED_BITS) !== 0;
    if (!on) {
      if (!c.accomplices) return;
      c.chaseOff ||= now;
      if (now - c.chaseOff > ACCOMPLICE_KEEP_MS) { c.accomplices = null; c.chaseOff = 0; }
      return;
    }
    c.chaseOff = 0;
    const m = w.seats.get(`car|${c.name}`);
    if (!m) return;
    for (const [s, pid] of m) {
      const g = s === 0 ? null : w.players.get(pid);
      if (g && g !== c && g.key) (c.accomplices ||= new Set()).add(g.key);
    }
  }

  // ---------------------------------------------------------------- messages
  onMessage(c, m, conn = null) {
    const d = m.d && typeof m.d === 'object' ? m.d : {};
    const id = isInt(m.id) ? m.id : null;
    const reply = (r) => (r?.err ? c.res(id, false, r.d, r.err) : c.res(id, true, r?.d ?? {}));
    if (m.t === 'ping') { c.send('pong', { c: d.c, s: Date.now() }); return; }
    if (m.t === 'register') return reply(this.register(c, d));
    if (m.t === 'login') return reply(this.login(c, d, conn));
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
      case 'brk': return reply(w.knock(c, d));
      case 'jail': return reply(this.jail(c, d));
      case 'policeArrest': return reply(this.policeArrest(c, d));
      case 'seatClaim': return reply(w.claimSeat(c, d));
      case 'seatRelease': w.releaseSeat(c); return reply({});
      case 'skip': return reply(w.skip(c, d));
      case 'busHold': return reply(w.busHold(c, d));
      case 'busHolds': return reply({ d: { holds: [...w.busHolds.values()], now: Date.now() } });
      case 'heliRent': return reply(w.heliRent(c));
      case 'heliReturn': return reply(w.heliReturn(c));
      case 'veh': return reply(this.setVeh(c, d));
      case 'tow': return reply(this.tow(c, d));
      case 'towDone': return reply(this.towDone(c));
      case 'carRepair': return reply(this.carRepair(c, d));
      case 'carDamage': return reply(this.carDamage(c, d));
      case 'raceJoin': return reply(w.raceJoin(c, d));
      case 'raceLeave': return reply(w.raceLeave(c));
      case 'raceSolo': return reply(w.raceSolo(c, d));
      case 'raceFinish': return reply(w.raceFinish(c, d));
      case 'raceProgress': return reply(w.raceProgress(c, d));
      case 'perm': return this.permRequest(c, d, id);
      case 'permAnswer': {
        const p = this.pending.get(d.rid);
        if (!p || p.to !== c) return reply({ err: 'bad_request' });
        this.answerPerm(d.rid, !!d.allow);
        return reply({});
      }
      case 'permRevoke': return reply(this.permRevoke(c, d));
      case 'chaletFurniture': return reply(this.chaletFurniture(c, d));
      case 'spend': return reply(this.spend(c, d));
      case 'earn': return reply(this.earn(c, d));
      case 'buy': return reply(this.buy(c, d));
      case 'carReturn': return reply(this.carReturn(c, d));
      case 'carSwitch': return reply(this.carSwitch(c, d));
      case 'carSell': return reply(this.carSell(c, d));
      case 'plateCheck': {
        const p = cleanPlate(d.plate), k = plateKey(p);
        if (!k) return reply({ err: 'bad_plate' });
        const o = this.plates.get(k);
        return reply({ d: { plate: p, free: !o || o === c.key, mine: o === c.key } });
      }
      case 'plateIssue': return reply({ d: { plate: this.freePlate() } });
      case 'profileSet': return reply(this.profileSet(c, d));
      case 'profile': return reply({ d: { profile: c.profile } });
      case 'admin': return reply(this.adminOp(c, d));
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

  login(c, d, conn = null) {
    if (c.key) return { err: 'already_logged_in' };
    if (d.v !== PROTO) return { err: 'proto', d: { proto: PROTO } };
    const k = nameKey(d.name), a = this.store.accounts.data[k];
    if (!a || typeof d.token !== 'string') return { err: 'bad_login' };
    const h1 = Buffer.from(sha(d.token), 'hex'), h2 = Buffer.from(a.hash, 'hex');
    if (h1.length !== h2.length || !crypto.timingSafeEqual(h1, h2)) return { err: 'bad_login' };
    const old = this.online.get(k);
    if (old && old.world && conn) return this.resume(old, c, d, conn);
    if (old) { old.send('bye', { reason: 'replaced' }); old.ws?.close(4001, 'replaced'); old.replacing = true; this.onClose(old); }
    c.name = a.name; c.key = k;
    c.profile = this.store.profiles.data[k] ||= newProfile(a.name);
    if (c.profile.jailUntil && c.profile.jailUntil <= Date.now()) { delete c.profile.jailUntil; delete c.profile.jailReason; this.store.profiles.save(); } // (served)
    if (d.look && typeof d.look === 'object') c.look = { c: str(d.look.c, 32), o: d.look.o && JSON.stringify(d.look.o).length < 400 ? d.look.o : null, s: str(d.look.s, 32) };
    c.tt = str(d.tt, 32); // the client's timetable fingerprint (net/transit.js): another game version runs other times
    this.online.set(k, c);
    this.plotsHint(d.plots);
    this.placeChalet(c); // (your chalet back on its plot, or another free one; before 'join' carries it)
    const w = this.pickWorld(k);
    w.addPlayer(c);
    this.settleCar(c); // (a tow left unfinished by a restart; an impound past its day)
    this.log(`[+] ${c.name} -> world ${w.id} (${w.size}/${MAX_PLAYERS}, ${this.online.size} online)`);
    return { d: this.loginMsg(c, false) };
  }
  loginMsg(c, resumed) {
    const w = c.world;
    return {
      proto: PROTO, name: c.name, pid: c.pid, now: Date.now(), profile: c.profile, world: w.snapshot(),
      chalets: this.chaletsMsg(), chaletPlot: { id: c.plot, waiting: c.chaletWaiting, moved: !!c.plotMoved },
      catalog: CATALOG,
      jailBoard: this.jailTop(), // (the prison notice board's top 3: jailVisit below)
      resumed, // true: the same player carried on (same world, pid, seat, chalet plot, vehicles, race entry)
      guests: this.guestNames(c.key), // your chalet's guest list (a resumed player's grants are still there)
      lastRace: w.lastRaceFor(c.key), // the result of a race you were in that ended in the last minute (missed while away?)
    };
  }
  /** A login while this name is still online (a reconnect after a drop, or the same account on another device): the
   *  held player carries on on the new socket: same world, pid, seat, chalet plot, vehicles, grants and race entry.
   *  An old socket that is still open is told 'replaced' and closed. */
  resume(old, c, d, conn) {
    const ows = old.ws;
    clearTimeout(old.graceT); old.graceT = null;
    old.dropped = 0; old.kicked = false; old.replacing = false;
    old.ws = c.ws; old.ip = c.ip;
    old.bucket = c.bucket; old.pBucket = c.pBucket; old.refused = 0;
    conn.c = old;
    if (ows && ows !== old.ws) { // (still open from the server's side: another device, or a socket not yet seen dead)
      try { ows.send(JSON.stringify({ t: 'bye', d: { reason: 'replaced' } })); ows.close(4001, 'replaced'); } catch { /* closed */ }
    }
    if (d.look && typeof d.look === 'object') {
      old.look = { c: str(d.look.c, 32), o: d.look.o && JSON.stringify(d.look.o).length < 400 ? d.look.o : null, s: str(d.look.s, 32) };
      old.world.broadcast('look', { pid: old.pid, look: old.look }, old);
    }
    if (str(d.tt, 32)) old.tt = str(d.tt, 32); // (the same device or another: its game version's timetable)
    this.log(`[+] ${old.name} reconnected -> world ${old.world.id} (resumed${ows ? ', replaced an open socket' : ''})`);
    return { d: this.loginMsg(old, true) };
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

  // ---------------------------------------------------------------- the vehicles you show (your car, a helicopter copy)
  // { k: 'car' }: your rental, its look from your profile (model, paint, trim, rims, the plate the server issued);
  // { k: 'heli' }: the copy you rented; { k, off: true }: gone. at: [x, y, z, yaw] where it stands while you are not in
  // it (driving or flying, your presence row is its pose). A car's parked spot is kept in the profile (cars[0].at: it
  // is put back there when you come back). Broadcast as 'veh' { pid, k, veh | null }; publicInfo.vehs for joiners.
  // Leaving the world takes them out of everyone's view (the 'leave' broadcast) until you are back.
  setVeh(c, d) {
    const k = d?.k;
    if (!VEH_KINDS.includes(k)) return { err: 'bad_vehicle' };
    let v = null;
    if (k === 'tow' && !d.off) {
      // your tow truck out on a job for your car (towtruck.js: only the owner's client drives it): its pose, speed and
      // whether your car rides on its bed. Streamed a few times a second; never stored
      if (!c.profile.cars?.[0]) return { err: 'no_car' };
      if (!validAt(d.at) || (d.v != null && !isNum(d.v))) return { err: 'bad_value' };
      v = { k, at: d.at.map((x) => Math.round(x * 100) / 100), v: Math.round(clamp(d.v || 0, -30, 30) * 100) / 100, car: !!d.car };
    } else if (k === 'police' && !d.off) {
      // the patrol cars chasing you (game/police.js: local to you, the offender): up to eight poses [x, y, z, yaw, v]
      // (the chasers and a roadblock's two at five stars), streamed a few times a second while you are wanted; never stored
      if (!Array.isArray(d.cars) || !d.cars.length || d.cars.length > 8) return { err: 'bad_value' };
      if (!d.cars.every((a) => Array.isArray(a) && a.length === 5 && a.every(isNum))) return { err: 'bad_value' };
      const r2 = (x) => Math.round(x * 100) / 100;
      v = { k, cars: d.cars.map((a) => [r2(a[0]), r2(a[1]), r2(a[2]), r2(a[3]), r2(clamp(a[4], -75, 75))]) };
    } else if (k === 'rescue' && !d.off) {
      // the rescue coming for you after a bad wipeout (game/heli/rescue.js, net/rescue.js: local to you, the casualty):
      // the helicopter [x, y, z, yaw, pitch, roll, rpm], the ambulance [x, y, z, yaw, v] (either may be null, not both),
      // where you are (s: 0 in the snow, 1 on the winch, 2 in the cabin, 3 in the ambulance), the winch rope's length,
      // the ambulance's lights (l). Streamed a few times a second while it runs; never stored
      const nums = (a, n) => Array.isArray(a) && a.length === n && a.every(isNum);
      if ((d.h != null && !nums(d.h, 7)) || (d.a != null && !nums(d.a, 5)) || (d.h == null && d.a == null)) return { err: 'bad_value' };
      if ((d.s != null && !isInt(d.s)) || (d.rope != null && !isNum(d.rope))) return { err: 'bad_value' };
      const r2 = (x) => Math.round(x * 100) / 100;
      v = { k, h: d.h ? d.h.map((x, i) => r2(i === 6 ? clamp(x, 0, 1) : x)) : null, a: d.a ? d.a.map((x, i) => r2(i === 4 ? clamp(x, -40, 40) : x)) : null,
        s: clamp(d.s | 0, 0, 3), rope: r2(clamp(d.rope || 0, 0, 80)), l: !!d.l };
    } else if (k === 'sled' && !d.off) {
      // the snowmobile you drive (game/snowmobile.js, net/sled.js): { k: 'sled' } while you drive it (your presence row
      // is then its pose, flag F.sled), { k: 'sled', at } where you left it. Never stored (the sleds are your own client's)
      v = { k };
      if (d.at != null) {
        if (!validAt(d.at)) return { err: 'bad_value' };
        v.at = d.at.map((x) => Math.round(x * 100) / 100);
      }
    } else if (!d.off) {
      if (k === 'car') {
        const car = c.profile.cars?.[0];
        if (!car) return { err: 'no_car' };
        v = { k, cfg: carLook(car) };
      } else {
        const h = c.world?.heli.copies.find((x) => x.key === c.key);
        if (!h) return { err: 'not_renting' };
        v = { k, id: h.id };
      }
      if (d.at != null) {
        if (!validAt(d.at)) return { err: 'bad_value' };
        v.at = d.at.map((x) => Math.round(x * 100) / 100);
        // (while the truck has it, the spot kept is where the tow ends: the impound bay or its own bay)
        if (k === 'car' && !c.profile.cars[0].tow) { c.profile.cars[0].at = v.at; this.store.profiles.save(); }
      }
      // a car lying wrecked (drive.js wreckOut: on its side, on its roof): tilt [pitch, roll] and wreck (hazards, smoke,
      // dents) so everyone sees it as it lies; never stored (the tow takes it home repaired)
      if (k === 'car' && d.tilt != null) {
        if (!Array.isArray(d.tilt) || d.tilt.length !== 2 || !d.tilt.every(isNum)) return { err: 'bad_value' };
        v.tilt = d.tilt.map((x) => Math.round(clamp(x, -3.15, 3.15) * 100) / 100);
      }
      if (k === 'car' && d.wreck) v.wreck = true;
    }
    c.vehs[k] = v;
    c.world?.broadcast('veh', { pid: c.pid, k, veh: v }, c);
    return { d: { veh: v } };
  }

  // ---------------------------------------------------------------- the tow truck (game/towtruck.js, impound.js)
  // { kind: 'wreck' }: you wrecked your car; { kind: 'tow' }: you left it blocking a road. The server charges its own
  // fee (CATALOG.wreckFee, once per tow; like a fine it may take the balance below zero, down to DEBT_FLOOR: the
  // truck fetches the car either way) and records the tow on the car: home [x, y, z, yaw] is where it ends (a wreck: its
  // own bay, repaired; a tow: impound bay `bay`, locked until the next world day). The parked spot becomes home at
  // once, so a player who drops out mid-tow finds the car there (settleCar ends the record on leaving / login).
  tow(c, d) {
    const P = c.profile, car = P.cars?.[0];
    if (!car) return { err: 'no_car', d: { money: P.money } };
    if (d.kind !== 'wreck' && d.kind !== 'tow') return { err: 'bad_kind' };
    if (!validAt(d.home)) return { err: 'bad_value' };
    if (car.tow) return { err: 'busy', d: { money: P.money, impound: car.impound || null } };
    // (a wreck: the tow and the full repair, wreckBill; a tow: the flat wreckFee)
    const now = Date.now(), home = d.home.map((x) => Math.round(x * 100) / 100);
    const fee = d.kind === 'wreck' ? wreckBill(car.id) : CATALOG.wreckFee ?? 1500;
    // (as the game's other charges: into debt down to DEBT_FLOOR; deeper than that the truck still comes, unpaid)
    const paid = this.debit(c, fee, 'tow', DEBT_FLOOR) ? fee : 0;
    car.tow = { kind: d.kind, since: now, home };
    car.at = home;
    if (d.kind === 'wreck') this.clearDamage(c, car); // (a wreck comes home repaired)
    if (d.kind === 'tow') car.impound = { day: (c.world ? c.world.dayAt(now) : dayFor(now)), until: now + IMPOUND_MS, bay: isInt(d.bay) ? clamp(d.bay, 0, 31) : 0 }; // (the tow yard: 3 min)
    this.store.profiles.save();
    return { d: { money: P.money, fee: paid, impound: car.impound || null, at: home } };
  }
  /** THE WERKSTATT (game/werkstatt.js: the repair garage beside the Autohaus): { damage (0..1, the client's), plate? }
   *  repairs your car that is out (or the one with that plate): the price is the server's own (repairPrice: the
   *  flat CATALOG.repairFee for any car and any damage > 0). A purchase: it
   *  needs the money (no debt). Not while the tow truck has the car; nothing to repair: no charge.
   *  { flat: 'clerk' }: the Autohaus clerk's repair, the flat CLERK_REPAIR for any damage (> 0), the car wherever it
   *  is parked (not in the tow yard). */
  carRepair(c, d) {
    const P = c.profile, k = d.plate != null ? plateKey(d.plate) : null;
    const car = k ? (P.cars || []).find((x) => plateKey(x.plate) === k) : P.cars?.[0];
    if (!car) return { err: 'no_car', d: { money: P.money } };
    if (!isNum(d.damage) || (d.flat != null && d.flat !== 'clerk')) return { err: 'bad_value', d: { money: P.money } };
    if (car.tow || (d.flat && car.impound && Number.isFinite(car.impound.until) && Date.now() < car.impound.until)) return { err: 'busy', d: { money: P.money } };
    const frac = clamp(d.damage, 0, 1);
    const fee = d.flat ? (frac > 0 ? CLERK_REPAIR : 0) : repairPrice(car.id, frac);
    if (fee <= 0) return { err: 'no_damage', d: { money: P.money } };
    if (!this.debit(c, fee, 'repair')) return { err: 'money', d: { money: P.money, fee } };
    this.clearDamage(c, car);
    this.store.profiles.save();
    return { d: { money: P.money, fee } };
  }
  /** Your car's crash damage, kept on it (game/carrental.js carDamage): { plate?, damage (0..1), dents } (the car out
   *  when no plate). It stays until the car is repaired (carRepair, a wreck's tow), so leaving the car, switching cars,
   *  logging out or a reload finds it as it was; the car out shows its dents to the others too ('veh' cfg). Not while
   *  the tow truck has a wreck (it comes home repaired). */
  carDamage(c, d) {
    const P = c.profile, k = d.plate != null ? plateKey(d.plate) : null;
    const car = k ? (P.cars || []).find((x) => plateKey(x.plate) === k) : P.cars?.[0];
    if (!car) return { err: 'no_car' };
    if (!isNum(d.damage) || (d.dents != null && !validDents(d.dents))) return { err: 'bad_value' };
    if (car.tow?.kind === 'wreck') return { err: 'busy' };
    const frac = Math.round(clamp(d.damage, 0, 1) * 1000) / 1000, dents = (d.dents || []).map((a) => a.map((x) => Math.round(x * 100) / 100));
    if (frac <= 0 && !dents.length) this.clearDamage(c, car);
    else {
      car.damage = frac;
      if (dents.length) car.dents = dents; else delete car.dents;
      this.showLook(c, car);
    }
    this.store.profiles.save();
    return { d: { damage: car.damage || 0, dents: car.dents || [] } };
  }
  clearDamage(c, car) {
    if (!car || (car.damage == null && car.dents == null)) return;
    delete car.damage; delete car.dents;
    this.showLook(c, car);
  }
  // (the car out: its 'veh' record's look again, with or without dents, to everyone else)
  showLook(c, car) {
    const v = c.vehs?.car;
    if (!v || car !== c.profile.cars?.[0] || !v.cfg || v.cfg.plate !== car.plate) return;
    c.vehs.car = { ...v, cfg: carLook(car) };
    c.world?.broadcast('veh', { pid: c.pid, k: 'car', veh: c.vehs.car }, c);
  }
  /** The truck has unloaded your car (in its bay / the impound): the tow record ends. */
  towDone(c) {
    this.settleCar(c);
    if (c.vehs.tow) this.setVeh(c, { k: 'tow', off: true });
    return { d: { at: c.profile.cars?.[0]?.at || null } };
  }
  /** A tow that never finished (the owner left mid-tow, the server restarted) ends where it was going; an impound
   *  whose day has passed is lifted. */
  settleCar(c, now = Date.now()) {
    let dirty = false;
    for (const car of c.profile?.cars || []) { // (AUTOHAUS: every car you own; one towed may no longer be the one out)
      if (car.tow) { if (Array.isArray(car.tow.home)) car.at = car.tow.home; delete car.tow; dirty = true; }
      if (car.impound && (Number.isFinite(car.impound.until) ? now >= car.impound.until : c.world && c.world.dayAt(now) > car.impound.day)) { delete car.impound; dirty = true; } // (the tow yard's 3 min; old records: the world's next day)
    }
    if (dirty) this.store.profiles.save();
  }

  // ---------------------------------------------------------------- interiors (chalets need the owner's ok)
  enter(c, d) {
    const id = d.interior == null ? null : str(d.interior, 40);
    if (d.interior != null && !id) return { err: 'bad_interior' };
    // in prison: the cell until the time is served (3 s of slack: the client releases you by its estimate of our clock)
    if (id !== 'prison' && (c.profile?.jailUntil || 0) - Date.now() > JAIL_SLACK) return { err: 'jailed', d: { jailUntil: c.profile.jailUntil } };
    if (id && id.startsWith('chalet:')) {
      const n = Number(id.slice(7));
      if (!isInt(n)) return { err: 'bad_interior' };
      const owner = this.chalets.get(n);
      // unowned: open for viewing; yours; or the owner let you in (while you both are online)
      if (owner && owner !== c.key && c.interior !== id && !this.hasGrant('chaletVisit', owner, c.key)) return { err: 'no_permission' };
      if (owner && owner !== c.key) this.useGrant('chaletVisit', owner, c.key);
    }
    // out of a chalet you were let into: that visit is used up (next time: ask again)
    if (c.interior && c.interior !== id && c.interior.startsWith('chalet:')) {
      const owner = this.chalets.get(Number(c.interior.slice(7)));
      if (owner && owner !== c.key) this.endGrant('chaletVisit', owner, c.key);
    }
    c.interior = id;
    if (c.pres) { c.pres[14] = id || 0; c.world.dirty.set(c.pid, c.pres); }
    return { d: { interior: id } };
  }

  // ---------------------------------------------------------------- prison (game/prison.js): served in the 'prison' interior
  /** { seconds (1-300), reason }: you are jailed until now + seconds (in the profile: a login before then starts
   *  you in the cell for the rest). A new sentence never shortens the one you are serving. */
  jail(c, d) {
    const s = d.seconds;
    if (!isNum(s) || s < 1 || s > JAIL_MAX_S) return { err: 'bad_value' };
    const reason = (str(d.reason, 80) ?? '').trim() || 'Arrested';
    const now = Date.now(), P = c.profile;
    const visit = this.jailVisit(P, now);
    P.jailUntil = Math.min(now + JAIL_MAX_S * 1000, Math.max(P.jailUntil || 0, now + Math.round(s * 1000)));
    P.jailReason = reason;
    this.store.profiles.save();
    if (visit) this.jailBoardSend();
    this.log(`[jail] ${c.name}: ${Math.round((P.jailUntil - now) / 1000)} s, ${reason}`);
    return { d: { jailUntil: P.jailUntil, reason, now } };
  }

  /** The police arrested you (police.js arrest(), after your own 'jail'): your passengers go to prison too.
   *  The players the server's own seat registry has in your car's passenger seats now (not when you were caught on
   *  foot: d.foot), and every accomplice of this chase (c.accomplices: in your car at any point of it, wherever they
   *  are now; Oct 30 2026); you must be serving a sentence yourself; once per ARREST_COOLDOWN_MS. Each one: out of a
   *  car seat, jailed (as long as you, at most), charged ACCOMPLICE_FINE (a game charge: into debt down to
   *  DEBT_FLOOR), told 'arrested' (offline: the sentence and the fine in their profile). */
  policeArrest(c, d) {
    const w = c.world, now = Date.now(), P = c.profile;
    let visits = 0; // (new prison stays: the jail board)
    if (now - (c.arrestAt || 0) < ARREST_COOLDOWN_MS) return { err: 'cooldown' };
    if (!(P.jailUntil > now)) return { err: 'not_jailed' };
    c.arrestAt = now;
    const left = Math.max(1, Math.round((P.jailUntil - now) / 1000));
    const seconds = Math.min(left, clamp(isNum(d?.seconds) ? Math.round(d.seconds) : ACCOMPLICE_JAIL_S, 1, JAIL_MAX_S));
    const reason = `Arrested with ${c.name}`;
    if (w) this.accompliceStep(c, now); // (whoever is aboard right now counts too, if the chase is still on)
    const m = w?.seats.get(`car|${c.name}`), names = [], keys = new Set();
    if (!d?.foot) for (const [s, pid] of m ? [...m.entries()] : []) {
      const g = w.players.get(pid);
      if (s === 0 || !g || g === c || g.seat?.k !== 'car' || g.seat.v !== c.name || !g.key) continue;
      keys.add(g.key);
    }
    for (const k of c.accomplices || []) if (k !== c.key) keys.add(k); // (stepped out since: still in it, Oct 30 2026)
    c.accomplices = null; c.chaseOff = 0;
    for (const k of keys) {
      const g = this.online.get(k) || null, G = g?.profile || this.profileOf(k);
      if (!G) continue;
      if (g?.seat?.k === 'car') g.world?.releaseSeat(g); // (out of whatever car they are in now)
      if (this.jailVisit(G, now)) visits++; // (the prison board: an accomplice's stay counts too)
      G.jailUntil = Math.min(now + JAIL_MAX_S * 1000, Math.max(G.jailUntil || 0, now + seconds * 1000));
      G.jailReason = reason;
      const fine = Math.max(0, Math.min(ACCOMPLICE_FINE, Math.floor(G.money - DEBT_FLOOR)));
      if (fine) this.debit({ profile: G }, fine, 'accomplice', DEBT_FLOOR);
      this.store.profiles.save();
      if (g) {
        g.send('money', { v: G.money, why: 'accomplice', delta: -fine });
        g.send('arrested', { by: c.name, seconds, fine, jailUntil: G.jailUntil, reason, now });
      }
      const nm = g?.name || G.name || k;
      names.push(nm);
      this.log(`[jail] ${nm}: ${seconds} s, ${reason}, -$${fine}${g ? '' : ' (offline)'}`);
    }
    if (visits) this.jailBoardSend();
    return { d: { passengers: names } };
  }

  // (Oct 30 2026, the user: "turn this into a leaderboard of the top 3 amount of visits at the jail"): the prison
  // lobby's three GESUCHT posters (game/prison.js) show who has been jailed most. profile.jailVisits: +1 for every
  // sentence that starts (an arrest's 'jail', or jailed as an accomplice: policeArrest), not for time added to one
  // being served. The top 3 ({ name, n }, most first, ties by name) go out with the login and as 'jailBoard'
  // { top } to everyone online whenever they change.
  jailVisit(P, now = Date.now()) {
    if (!P || P.jailUntil > now) return false;
    P.jailVisits = (P.jailVisits | 0) + 1;
    return true;
  }
  jailTop() {
    const list = [];
    for (const [k, p] of Object.entries(this.store.profiles.data)) {
      const n = p?.jailVisits | 0;
      if (n > 0) list.push({ name: p.name || this.store.accounts?.data?.[k]?.name || k, n });
    }
    list.sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return list.slice(0, 3);
  }
  jailBoardSend() {
    const top = this.jailTop(), s = JSON.stringify(top);
    if (s === this.jailBoardLast) return;
    this.jailBoardLast = s;
    this.broadcastAll('jailBoard', { top });
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
    if (!g || !this.endGrant(d.kind, c.key, g.key)) return { err: 'no_grant' };
    g.send('permRevoked', { kind: d.kind, owner: c.name });
    if (d.kind === 'carRide' && g.world) g.world.kickFromCar(c.name, g.pid);
    if (d.kind === 'chaletVisit') {
      if (c.plot != null && g.interior === `chalet:${c.plot}`) { g.interior = null; g.send('kickInterior', { interior: `chalet:${c.plot}` }); }
      this.sendGuests(c.key);
    }
    return {};
  }

  // ---------------------------------------------------------------- the economy
  spend(c, d) {
    const amount = d.amount;
    if (!isInt(amount) || amount <= 0 || amount > 1e7) return { err: 'bad_amount', d: { money: c.profile.money } };
    // the game's own charges (a wreck or tow fee, a fine, the hospital) may take you into debt, as in single player
    // (Oct 29, the user: going into minus in multiplayer showed a server refusal and nothing was taken); purchases go
    // through buy() and still need the money
    if (!this.debit(c, amount, d.reason, d.reason === 'game' ? DEBT_FLOOR : 0)) return { err: 'money', d: { money: c.profile.money } };
    return { d: { money: c.profile.money } };
  }

  earn(c, d) {
    const max = EARN_RULES[d.source], amount = d.amount, now = Date.now();
    if (!max || !isInt(amount) || amount <= 0 || amount > max) return { err: 'rejected', d: { money: c.profile.money } };
    const log = (this.earnedBy.get(c.key) || []).filter(([t]) => now - t < 3600000);
    this.earnedBy.set(c.key, log);
    const hour = log.reduce((s, [, a]) => s + a, 0);
    if (hour + amount > EARN_HOURLY) return { err: 'cap', d: { money: c.profile.money } };
    log.push([now, amount]);
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
      if (!isInt(id) || id < 0 || id > 63 || (this.plotIds && !this.plotIds.includes(id))) return { err: 'bad_item' };
      const owner = this.chalets.get(id);
      if (owner) return { err: 'taken', d: { owner: this.store.accounts.data[owner]?.name } };
      if (P.chalet) return { err: 'one_each', d: { id: P.chalet.id } };
      if (!this.debit(c, CATALOG.chalet.price, 'chalet')) return { err: 'money', d: { money: P.money } };
      const meta = d.meta && typeof d.meta === 'object' && JSON.stringify(d.meta).length < 400 ? d.meta : {};
      P.chalet = { ...meta, id, name: str(d.name, 40) || `Chalet ${id}`, owned: true, rented: true, furniture: [], since: Date.now() };
      this.chalets.set(id, c.key);
      c.plot = id;
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
      // AUTOHAUS (Oct 29): bought for good; as many as the garage holds (CATALOG.garageMax), the same model more than
      // once too (a red and a black Golf): every car you own is told apart by its plate (cars: your garage, cars[0]
      // the one out: the new car, in your bay)
      P.cars = Array.isArray(P.cars) ? P.cars : [];
      if (P.cars.length >= (CATALOG.garageMax ?? 10)) return { err: 'garage_full', d: { money: P.money, max: CATALOG.garageMax ?? 10 } };
      if (P.cars.some((x) => plateKey(x.plate) === plateKey(plate))) { // (a plate already on another of your cars)
        if (custom) return { err: 'plate_taken', d: { plate } };
        plate = this.freePlate();
      }
      if (!plate) return { err: 'bad_plate' };
      const price = base + CATALOG.paints[paint] + CATALOG.interiors[interior] + CATALOG.rims[rims] + (custom ? CATALOG.plateCost : 0);
      if (!this.debit(c, price, 'car')) return { err: 'money', d: { money: P.money } };
      const car = { id: cfg.id, paint, interior, rims, plate, custom, price, since: Date.now() };
      if (P.cars[0]) delete P.cars[0].at; // (the one out before goes home to your garage)
      P.cars.unshift(car);
      this.plates.set(plateKey(plate), c.key);
      if (c.vehs.car) this.setVeh(c, { k: 'car' }); // (the car everyone sees is the new one)
      this.store.profiles.save();
      return { d: { money: P.money, car, price, cars: P.cars } };
    }
    return { err: 'bad_kind' };
  }

  /** A car of yours gone for good (wrecked by a police ram: not repaired; carrental.js): out of your garage, its
   *  plate free again. The next car of yours (if any) is the one out. */
  carReturn(c, d) {
    const P = c.profile, k = plateKey(d.plate);
    const i = (P.cars || []).findIndex((car) => plateKey(car.plate) === k);
    if (i < 0) return { err: 'no_car' };
    P.cars.splice(i, 1);
    if (this.plates.get(k) === c.key) this.plates.delete(k);
    if (i === 0 && c.vehs.car) this.setVeh(c, { k: 'car', off: true });
    this.store.profiles.save();
    return { d: { cars: P.cars } };
  }
  /** AUTOHAUS: another car of yours out (free): it moves to cars[0] and starts in your bay (no parked spot). */
  carSwitch(c, d) {
    const P = c.profile, k = plateKey(d.plate);
    const i = (P.cars || []).findIndex((car) => plateKey(car.plate) === k);
    if (!k || i < 0) return { err: 'no_car' };
    if (i > 0) {
      const [car] = P.cars.splice(i, 1);
      delete P.cars[0].at; delete car.at;
      P.cars.unshift(car);
      if (c.vehs.car) this.setVeh(c, { k: 'car', off: true }); // (the client shows the new one in its bay: veh again)
      this.store.profiles.save();
    }
    return { d: { cars: P.cars } };
  }
  /** AUTOHAUS: sell a car of yours back for CATALOG.carSell of what you paid (a car from before cars were bought,
   *  never priced: of its list price). Out of your garage, its plate free; not while the tow truck has it. */
  carSell(c, d) {
    const P = c.profile, k = plateKey(d.plate);
    const i = (P.cars || []).findIndex((car) => plateKey(car.plate) === k);
    if (!k || i < 0) return { err: 'no_car', d: { money: P.money } };
    const car = P.cars[i];
    if (car.tow) return { err: 'busy', d: { money: P.money } };
    const paid = isInt(car.price) && car.price >= 0 ? car.price : (CATALOG.cars[car.id] || 0);
    const refund = Math.round((paid * (CATALOG.carSell ?? 0.5)) / 50) * 50;
    P.cars.splice(i, 1);
    if (this.plates.get(k) === c.key) this.plates.delete(k);
    if (i === 0 && c.vehs.car) this.setVeh(c, { k: 'car', off: true });
    if (refund > 0) this.credit(c, refund, 'carSell');
    this.store.profiles.save();
    return { d: { money: P.money, refund, cars: P.cars } };
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
      case 'pos': { // where you were (outdoors, on foot / skis): back there at your next login (Oct 30)
        if (v === null) { delete P.pos; break; }
        if (!v || typeof v !== 'object' || ![v.x, v.z, v.y, v.h].every((n) => isNum(n) && Math.abs(n) < 40000)) return { err: 'bad_value' };
        // (lying in a hospital bed: hospital { until } (ms): you come round in it again at your next login, Oct 30)
        if (v.hospital != null && !(isNum(v.hospital?.until) && v.hospital.until > 0)) return { err: 'bad_value' };
        P.pos = { x: v.x, z: v.z, y: v.y, h: v.h, skis: !!v.skis };
        if (v.hospital != null) P.pos.hospital = { until: Math.min(Math.round(v.hospital.until), Date.now() + 600000) }; // (10 min ahead at most)
        break;
      }
      case 'wanted': { // a police chase under way (game/police.js persist): it carries on at your next login (Oct 30)
        if (v === null) { delete P.wanted; break; }
        if (!v || typeof v !== 'object' || !isNum(v.h) || v.h < 1 || v.h >= 6 || !isNum(v.e) || v.e < 0 || v.e > 600 || !isNum(v.t) || v.t < 0 || v.t > 86400) return { err: 'bad_value' };
        P.wanted = { h: Math.round(v.h * 100) / 100, e: Math.round(v.e), t: Math.round(v.t), f: !!v.f, why: (str(v.why, 16) ?? '').replace(/[^\w-]/g, '') || 'resume' };
        break;
      }
      default: return { err: 'bad_key' };
    }
    this.store.profiles.save();
    return {};
  }

  // ---------------------------------------------------------------- chalet plots (held while the owner is online)
  chaletsMsg() { return Object.fromEntries([...this.chalets].map(([id, k]) => [id, this.store.accounts.data[k]?.name || '?'])); }
  /** A login's list of the village's house plots (the client knows the village; the catalog may not): adopted
   *  when it is a plausible list (distinct ids 0-63, as many as the catalog's chalet count). */
  plotsHint(list) {
    if (CATALOG.chalet?.plots || !Array.isArray(list)) return;
    const n = CATALOG.chalet?.count || 18;
    if (list.length !== n || !list.every((x) => isInt(x) && x >= 0 && x <= 63) || new Set(list).size !== n) return;
    this.plotIds = list.slice().sort((a, b) => a - b);
  }
  /** The free plot nearest (by id) to `near`, or null. */
  freePlot(near = 0) {
    let best = null;
    for (const id of this.plotIds || []) if (!this.chalets.has(id) && (best === null || Math.abs(id - near) < Math.abs(best - near))) best = id;
    return best;
  }
  /** An owner comes online: their chalet onto its old plot if free, else another free plot, else they wait. */
  placeChalet(c) {
    const ch = c.profile?.chalet;
    if (!ch || !isInt(ch.id)) return null;
    if (c.plot != null && this.chalets.get(c.plot) === c.key) return c.plot;
    const id = !this.chalets.has(ch.id) ? ch.id : this.freePlot(ch.id);
    if (id === null) {
      c.plot = null; c.chaletWaiting = true;
      if (!this.chaletWait.includes(c.key)) this.chaletWait.push(c.key);
      return null;
    }
    this.chaletWait = this.chaletWait.filter((k) => k !== c.key);
    c.chaletWaiting = false;
    c.plotMoved = ch.id !== id;
    if (ch.id !== id) { ch.id = id; this.store.profiles.save(); }
    c.plot = id;
    this.chalets.set(id, c.key);
    this.broadcastAll('chalet', { id, owner: c.name });
    return id;
  }
  /** An owner goes offline: the plot is free (for sale); guests inside are shown out; a waiting owner gets it. */
  unplaceChalet(c) {
    this.chaletWait = this.chaletWait.filter((k) => k !== c.key);
    const id = c.plot;
    c.plot = null;
    if (id == null || this.chalets.get(id) !== c.key) return;
    this.chalets.delete(id);
    if (c.replacing) return; // (the same player logging in again: the new connection takes the plot straight back)
    const room = `chalet:${id}`;
    for (const g of this.online.values()) if (g !== c && g.interior === room) { g.interior = null; g.send('kickInterior', { interior: room }); }
    this.broadcastAll('chalet', { id, owner: null });
    while (this.chaletWait.length) {
      const w = this.online.get(this.chaletWait.shift());
      if (!w || !w.profile?.chalet || w === c) continue;
      w.profile.chalet.id = id;
      if (this.placeChalet(w) === id) { w.send('chaletPlaced', { id }); break; }
    }
  }
  /** The furniture of the chalet on plot `id` (its owner, or a guest the owner let in): { id, owner, chalet }. */
  chaletFurniture(c, d) {
    const id = d.id;
    if (!isInt(id)) return { err: 'bad_item' };
    const k = this.chalets.get(id);
    if (!k) return { err: 'no_owner' };
    if (k !== c.key && !this.hasGrant('chaletVisit', k, c.key)) return { err: 'no_permission' };
    const ch = this.profileOf(k)?.chalet || {};
    return { d: { id, owner: this.store.accounts.data[k]?.name || '?', chalet: { furniture: ch.furniture || [], plan: ch.plan, layout: ch.layout } } };
  }

  broadcastAll(t, d) { const s = JSON.stringify({ t, d }); for (const c of this.online.values()) c.sendRaw(s); }
}
