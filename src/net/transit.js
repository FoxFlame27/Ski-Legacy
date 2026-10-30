// Shared transport in multiplayer: the Wolkenspitzbahn (world/railway.js), the Legacy Express (world/express.js), the
// gondolas and chairlifts (world/lifts.js) and the ski buses (game/bus/bus.js fleet). Everyone in a world sees the same vehicle in
// the same place:
//  - every system is driven off its line's shared timeline (session.lineTime: the server clock plus the line's
//    speed-up offset) through its `mp` hook instead of its own clock; nobody brings, holds or shifts a vehicle;
//  - boarding waits for the real vehicle (the train standing at the platform, the next cabin coming round) and claims
//    a seat in the server's seat registry (seatClaim): everyone gets a different seat; a vehicle takes as many as
//    it has seats (every seat of every coupled car: Wolkenspitzbahn / Legacy Express 4 cars x 48 = 192, a ski bus
//    36, a gondola cabin 6, a chair its width), then "Bus full (36/36) · next bus in 2:10" and you are queued for
//    the next one by yourself; you sit in the seat you got ("Car 2 · seat 14 of 192" under the status pill);
//  - how full each one is: everyone has the registry ('seats' broadcasts), so the pickers and the waiting line say
//    "next train in 0:42 · 178 of 192 seats free" (railNext / expressNext / busNext, pickerText);
//  - the seat goes back (seatRelease) as soon as you are off (any way off: arriving, E at a stop, a teleport...);
//  - SPACE on a shared vehicle: holdSkip, so the line speeds up only while everyone aboard holds it (or you are
//    alone aboard); "Hold SPACE to speed up (2/3 holding)" under the status pill;
//  - the other players riding: seat(k, v, n, out) gives remote.js / vehicles.js their seat as drawn here, so their
//    avatars sit in the moving vehicle without lag.
// Vehicle ids (the registry's `v`): trains 'rail-0' / 'rail-1' (kind 'train', one timeline 'train|rail'), express
// 'express-e0..3' / 'express-w0..3' (kind 'express', timelines 'express|e' / 'express|w'), cabins and chairs
// 'L<line>-<car>' (kind 'gondola' / 'chair', timeline '<kind>|L<line>'), buses 'bus:1'..'bus:7' (kind 'bus', each
// round its own timeline 'bus|R<round>'; bus:0, single player's own bus, is not used). See docs/multiplayer.md.
import { MP } from './mode.js';
import { net } from './client.js';
import { ERR_TEXT } from './protocol.js';

const RAIL_RATE = 6;      // the single-player SPACE rates (railway.js, lifts: main.js)
const LIFT_RATE = 16;
const BUS_RATE = 8;       // (bus.js updateRide: fast ×8)
const STOP_R = 25;        // m: waiting for the bus within this of the stop
const BOARD_MIN = 4;      // s: a train still standing this long can be boarded (nobody holds it in multiplayer)
const PLATFORM_R = 14;    // m: waiting for the train within this of the station's boarding spot
const LIFT_R = 26;        // m: waiting for a cabin within this of the boarding point
const GRACE_MS = 15000;   // a claimed seat you never sat in goes back after this

export class MpTransit {
  /** @param session the Multiplayer session (net/session.js) */
  constructor(session) {
    this.s = session;
    this.sys = {};            // { railway, express, lifts, player, expressRate }
    this.mine = null;         // the seat you hold: { k, v, seat, t, rode, line?, idx?, train? }
    this.wait = null;         // waiting for the Wolkenspitzbahn: { key, st, up, dest, retry }
    this.busWait = null;      // waiting at a bus stop: { key, from, to, nf, nt, retry }
    this.liftWait = null;     // a claimed cabin on its way to the boarding point: { key, line, idx, seat, target, retry, near }
    this.liftQueue = null;    // the cabin was full: queued for the one after it { key, st, retry, line, target, v, near }
    this.ready = null;        // a seat claimed for this boarding: { key, ... } (the next gate call boards)
    this.pending = false;     // a seatClaim on its way
    this.fullId = null;       // the vehicle that was full (skipped until the next one)
    this.space = false;
    this.cache = new Map();   // kind -> Map(id -> { sys, tr | line, idx })
    this.skipObj = null; this.skipText = ''; this.waitSec = -1; this.waitText = '';
    this.hooks = null;
    if (typeof addEventListener === 'function') {
      addEventListener('keydown', (e) => { if (e.code === 'Space') this.space = true; });
      addEventListener('keyup', (e) => { if (e.code === 'Space') this.space = false; });
      addEventListener('blur', () => { this.space = false; });
    }
    net.on('relogin', () => this.relogin());
  }

  /** main.js: the transport systems. */
  attach(sys) { this.sys = { ...this.sys, ...sys }; this.cache.clear(); if (MP.active) this.start(); }

  // ---------------------------------------------------------------- the systems on the shared timelines
  start() {
    const S = this.sys, s = this.s;
    const rate = (key) => MP.warps?.get(key)?.rate || 1;
    this.hooks ||= {
      // (the railway's timetable time: railroute.js trainState places both trains off it, the stops at Wolkensee and
      // Adlerwald and the crossing on the passing loop included, so everyone sees the same train at the same halt)
      rail: { time: () => s.lineTime('train|rail') / 1000, rate: () => rate('train|rail') },
      express: { time: (dir) => s.lineTime(dir > 0 ? 'express|e' : 'express|w') / 1000, rate: (dir) => rate(dir > 0 ? 'express|e' : 'express|w') },
      lifts: { time: (l) => s.lineTime(l.mpKey ||= `${liftKind(l)}|L${l.mpId}`) / 1000 },
      bus: { time: (r) => s.lineTime(r.mpKey ||= `bus|${r.mpLine}`) / 1000, rate: (r) => rate(r.mpKey ||= `bus|${r.mpLine}`) },
    };
    S.skibus?.line?.setMp?.(this.hooks.bus);
    if (S.railway) S.railway.mp = this.hooks.rail;
    if (S.express) S.express.mp = this.hooks.express;
    if (S.lifts) S.lifts.mp = this.hooks.lifts;
  }
  stop() {
    const S = this.sys;
    if (S.railway) { S.railway.mp = null; S.railway.mpPick = null; }
    if (S.express) { S.express.mp = null; S.express.mpPick = null; }
    if (S.lifts) { S.lifts.mp = null; S.lifts.mpPick = null; }
    if (S.skibus?.line) { S.skibus.line.mpPick = null; S.skibus.line.setMp?.(null); }
    this.mine = null; this.wait = null; this.busWait = null; this.liftWait = null; this.liftQueue = null; this.ready = null; this.pending = false; this.fullId = null;
  }

  // ---------------------------------------------------------------- boarding gates (main.js)
  /** boardRail: true = board now (railway.mpPick is set); false = waiting for the train / a seat (retry() boards). */
  railGate(st, up, dest, retry) {
    const key = `rail|${st.id}|${up}|${dest}`;
    if (this.ready?.key === key) { this.sys.railway.mpPick = { train: this.ready.train, seat: this.ready.seat }; this.ready = null; return true; }
    this.liftWait = null; this.liftQueue = null;
    if (this.wait?.key !== key) this.fullId = null; // (a new wait: an old "full" no longer counts)
    this.wait = { key, st, up, dest, retry };
    this.waitSec = -1;
    const n = this.railNext(st.id, up), m = n && (n.full ? n.next : n);
    if (!this.railTry() && n) this.flash(`Wolkenspitzbahn · the next train ${up ? 'up' : 'down'}${m ? ` is in ${fmtWait(m.wait)} · ${seatsFree(m)}` : ` is full (${n.cap}/${n.cap})`} · wait on the platform`, 'good', 3200);
    return false;
  }
  // the train standing at your platform now: claim a seat in it (true while it is in / being claimed)
  railTry() {
    const w = this.wait, R = this.sys.railway;
    if (!w || !R) return false;
    const n = R.nextAt(w.st.id, w.up);
    if (!n || n.wait > 0) { this.fullId = null; return false; }
    if (n.left < BOARD_MIN || this.fullId === n.train.id) return false;
    if (this.pending) return true;
    const tr = n.train, key = w.key, retry = w.retry;
    this.claim('train', tr.id, { n: tr.seatCount, seat: this.spreadSeat('train', tr.id, R.preferredSeat(tr, w.up), tr.seatCount, R.carCount), what: 'Train', next: () => this.railNext(w.st.id, w.up) }, (seat) => {
      if (this.wait?.key !== key) { this.s.releaseSeat(); this.mine = null; return; } // (you gave up meanwhile)
      this.wait = null;
      this.mine.train = tr;
      this.ready = { key, train: tr, seat };
      retry();
    });
    return true;
  }

  /** boardExpress (its train is in): true = board now (express.mpPick set); false = claiming / full (retry() boards). */
  expressGate(from, to, retry) {
    const key = `express|${from.id}|${to.id}`, X = this.sys.express;
    if (this.ready?.key === key) { X.mpPick = { train: this.ready.train, seat: this.ready.seat }; this.ready = null; return true; }
    const n = X.trainFor(from.id, to.id);
    if (!X.wait) { X.waitFor(from.id, to.id); this.fullId = null; } // (queued on the platform until you are aboard: express.waiting brings you back here)
    if (!n || n.wait > 0 || n.left < BOARD_MIN || this.pending || this.fullId === n.train.id) return false;
    const tr = n.train;
    this.claim('express', tr.id, { n: X.seatCount, seat: this.spreadSeat('express', tr.id, X.preferredSeat(), X.seatCount, X.carCount), what: 'Train', next: () => this.expressNext(from.id, to.id) }, (seat) => {
      if (!X.wait || X.ride) { this.s.releaseSeat(); this.mine = null; return; } // (you left the platform meanwhile)
      this.mine.train = tr;
      this.ready = { key, train: tr, seat };
      retry();
    });
    return false;
  }

  /** boardBus: true = board now (the bus line's mpPick is set); false = waiting at the stop for a bus that goes your
   *  way / a seat in it (retry() boards). */
  busGate(from, to, retry) {
    const key = `bus|${from.name}|${to.name}`, SB = this.sys.skibus, L = SB?.line;
    if (!L) return false;
    if (this.ready?.key === key) { L.mpPick = { bus: this.ready.bus, seat: this.ready.seat }; this.ready = null; return true; }
    this.wait = null; this.liftWait = null; this.liftQueue = null;
    if (this.busWait?.key !== key) this.fullId = null;
    const nf = SB.netStop(from), nt = SB.netStop(to);
    const n = this.busNext(from, to);
    if (!n) { this.busWait = null; this.flash(`No bus goes from ${from.name} to ${to.name}`, 'bad', 2600); return false; }
    this.busWait = { key, from, to, nf, nt, retry };
    this.waitSec = -1;
    const m = n.full ? n.next : n;
    if (!this.busTry()) this.flash(`Ski bus to ${to.name} · ${m ? `next bus in ${fmtWait(m.wait)} · ${seatsFree(m)}` : `full (${n.cap}/${n.cap})`} · wait at the stop`, 'good', 3200);
    return false;
  }
  busTry() {
    const w = this.busWait, L = this.sys.skibus?.line;
    if (!w || !L) return false;
    // (every bus standing at the stop now that goes your way: two can stand there at once; the full one is skipped)
    const list = L.mpBuses ? L.mpBuses(w.nf, w.nt).filter((e) => e.wait <= 0) : [L.mpNextBus(w.nf, w.nt)].filter((e) => e && e.wait <= 0);
    if (!list.length) { this.fullId = null; return false; }
    const n = list.find((e) => e.left >= BOARD_MIN && e.bus.id !== this.fullId);
    if (!n) return false;
    if (this.pending) return true;
    const b = n.bus, key = w.key, retry = w.retry;
    this.claim('bus', b.id, { n: L.seatCount, seat: L.preferredSeat(), what: 'Bus', next: () => this.busNext(w.from, w.to) }, (seat) => {
      if (this.busWait?.key !== key) { this.s.releaseSeat(); this.mine = null; return; }
      this.busWait = null;
      this.mine.bus = b;
      this.ready = { key, bus: b, seat };
      retry();
    });
    return true;
  }

  /** boardLift: true = board now (lifts.mpPick set: the cabin is at the boarding point); false = a seat in the next
   *  cabin is being claimed / it is on its way (retry() boards it when it is there). */
  liftGate(st, retry) {
    const L = this.sys.lifts, line = st.line, stop = st.stop || null;
    const key = `lift|${line.mpId}|${st.up}|${!!stop}`;
    if (this.ready?.key === key) { L.mpPick = { idx: this.ready.idx, seat: this.ready.seat }; this.ready = null; return true; }
    if (this.pending || this.liftWait?.key === key) return false;
    this.wait = null;
    const target = L.boardTarget(line, st.up, stop);
    const nc = line.nextCar(target);
    if (!nc) return false;
    if (this.liftQueue?.key !== key) this.fullId = null;
    this.liftQueue = null;
    const near = { x: st.stop && line.mid ? line.mid.x : st.up ? line.spec.bottom.x : line.spec.top.x, z: st.stop && line.mid ? line.mid.z : st.up ? line.spec.bottom.z : line.spec.top.z };
    this.claim(liftKind(line), `L${line.mpId}-${nc.idx}`, { n: line.seatCount, seat: line.preferredSeat, what: line.spec.type === 'chair' ? 'Chair' : 'Cabin',
      // full: queued for the cabin after it (update() asks again once the full one has gone by the boarding point)
      full: () => { this.liftQueue = { key, st, retry, line, target, v: `L${line.mpId}-${nc.idx}`, near }; this.waitSec = -1; } }, (seat) => {
      this.mine.line = line; this.mine.idx = nc.idx;
      this.liftWait = { key, line, idx: nc.idx, seat, target, retry, near };
      this.waitSec = -1;
      this.liftTry();
    });
    return false;
  }
  liftTry() {
    const w = this.liftWait;
    if (!w) return;
    // the cabin as drawn here (lifts.js placeAt: it crawls through the station in multiplayer): you get in once it
    // has come round to the boarding point (on the side it leaves by, as single player brings it to you), or while it
    // is still crawling out of the station when the seat came late. Before that, the countdown runs.
    const L2 = 2 * w.line.L, s = w.line.cars[w.idx].s, v = w.line.speedAt(s);
    const ahead = (((s - w.target) % L2) + L2) % L2, behind = (((w.target - s) % L2) + L2) % L2;
    if (ahead < Math.max(1.2 * v, w.line.dwell?.half || 0)) { // (there, or just past: in you get)
      this.liftWait = null;
      this.ready = { key: w.key, idx: w.idx, seat: w.seat };
      w.retry();
    } else if (ahead < behind) { // (it went by while the seat was being claimed)
      this.liftWait = null; this.s.releaseSeat(); this.mine = null;
      this.flash('Missed it · E for the next one', 'bad', 2000);
    }
  }

  claim(k, v, { n, seat, what = 'Full', next = null, full = null }, ok) {
    this.pending = true;
    net.request('seatClaim', { k, v, n, seat }).then((d) => {
      this.pending = false;
      if (!MP.active) return;
      this.mine = { k, v, seat: d.seat, n: d.n || n, t: performance.now(), rode: false };
      this.fullId = null;
      ok(d.seat);
    }, (e) => {
      this.pending = false;
      if (e.code === 'full') {
        // full: everyone who fits is in; you stay queued for the next one (the gate keeps waiting, this one skipped)
        this.fullId = v; this.waitSec = -1;
        full?.();
        const cap = e.data?.n || n, x = next?.(), nx = x && (x.full ? x.next : x);
        this.flash(`${what} full (${cap}/${cap})${nx ? ` · next ${what === 'Bus' ? 'bus' : what === 'Train' ? 'train' : 'one'} in ${fmtWait(nx.wait)} · you're queued for it` : full ? " · you're queued for the next one" : ' · wait for the next one'}`, 'bad', 3200);
      } else this.flash(ERR_TEXT[e.code] || e.message || 'No seat', 'bad', 2400);
    });
  }

  // ---------------------------------------------------------------- the same timetable as everyone else?
  /** A short fingerprint of this game version's timetables (the Wolkenspitzbahn's cycle, the Express's rounds, the
   *  bus rounds, the lifts, the seats): sent with the login. Everyone places every vehicle from the same server
   *  clock, but a player on another game version (an older app) has other ride times built in, so their trains
   *  stand somewhere else: session.js warns when a player in the world has a different one. */
  fingerprint() {
    if (this.fp) return this.fp;
    const S = this.sys, r = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-'), parts = [];
    try {
      const R = S.railway;
      if (R) { const w = R.windowAt?.('tal', true); parts.push(`r${R.trains.length}:${R.seatCount}:${w ? r(w.u0) + '/' + r(w.dur) : '-'}`); }
      const X = S.express;
      if (X?.tt) parts.push(`x${X.trains.length}:${X.seatCount}:${r(X.tt.up.loop)}:${r(X.tt.down.loop)}`);
      const L = S.skibus?.line;
      if (L?.fleet) parts.push(`b${L.seatCount}:` + L.fleet.map((b) => `${r(b.route.cycle)}+${r(b.phase)}`).join(','));
      if (S.lifts?.lines) parts.push('l' + S.lifts.lines.map((l) => `${r(l.L)}:${l.cars.length}:${l.cfg?.speed}`).join(','));
    } catch (e) { parts.push('err'); }
    let h = 0x811c9dc5;
    const str = parts.join('|');
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const fp = h.toString(16).padStart(8, '0');
    if (S.railway && S.express?.tt && S.skibus?.line) this.fp = fp; // (kept once every system is there)
    return fp;
  }
  /** The players in the world whose game runs other timetables (their tt differs from ours): names, once each. */
  checkVersions(players) {
    const me = this.fingerprint(), odd = [];
    this.warned ||= new Set();
    for (const p of players || []) if (p && p.tt && p.tt !== me && p.name && !this.warned.has(p.name)) { this.warned.add(p.name); odd.push(p.name); }
    if (odd.length) this.flash(`${odd.join(', ')} ${odd.length > 1 ? 'run' : 'runs'} another version of the game · trains, buses and lifts won't come at the same times for you · update the game (everyone on the same version)`, 'bad', 7000);
  }

  // ---------------------------------------------------------------- capacity: seats free per vehicle run
  /** The seat to ask for in a train of `cars` coupled cars: the one `pref` stands for (the window seat single player
   *  gives you), but in the car with the fewest riders now (pref's own car on a tie), or the first free seat there.
   *  So the riders spread over every car of the train instead of all crowding the lead car (the server still gives
   *  the lowest free seat if that one went meanwhile). */
  spreadSeat(k, v, pref, cap, cars) {
    const per = cars > 1 ? Math.floor(cap / cars) : 0;
    if (!MP.active || !per) return pref;
    const taken = new Set((MP.seats.get(`${k}|${v}`) || []).map((e) => e[0])), cnt = new Array(cars).fill(0);
    for (const s of taken) if (s >= 0 && s < per * cars) cnt[Math.floor(s / per)]++;
    let best = Math.min(cars - 1, Math.floor(pref / per));
    for (let c = 0; c < cars; c++) if (cnt[c] < cnt[best]) best = c;
    const inCar = pref % per;
    for (let i = 0; i < per; i++) { const s = best * per + ((inCar + i) % per); if (!taken.has(s)) return s; }
    return pref;
  }
  /** The Legacy Express is not in yet (main.js boardExpress): "Legacy Express to X · next train in 0:42 · 190 of 192
   *  seats free in 4 cars · wait on the platform" (a full one: the next with a free seat). */
  expressWaitText(from, to) {
    const n = this.expressNext(from.id, to.id);
    if (!n) return '';
    const m = n.full ? n.next : n;
    return `Legacy Express to ${to.name} · ${n.full ? `train full (${n.cap}/${n.cap}) · ` : ''}${m ? `next train in ${fmtWait(m.wait)} · ${seatsFree(m)}` : 'wait for the next train'} · wait on the platform`;
  }
  /** Riders aboard vehicle v of kind k now (the server's seat registry; 0 in single player). */
  taken(k, v) { return MP.active ? (MP.seats.get(`${k}|${v}`)?.length || 0) : 0; }
  // the next departure (the list soonest first) with its seats: { ...entry, cap, free, cars, full, next (the first
  // later one with a free seat, when this one is full) }. A train already pulling out (multiplayer: less than
  // BOARD_MIN s left, nobody can get in any more) is not offered.
  seatInfo(k, list, cap, cars, idOf) {
    if (!list?.length || !cap) return null;
    if (MP.active) list = list.filter((e) => e.wait > 0 || e.left >= BOARD_MIN);
    const mk = (e) => {
      const id = idOf(e), free = Math.max(0, cap - this.taken(k, id));
      return { ...e, cap, cars, free, full: free <= 0 || (MP.active && this.fullId === id) };
    };
    if (!list.length) return null;
    const f = mk(list[0]);
    if (f.full) f.next = list.slice(1).map(mk).find((e) => !e.full) || null;
    return f;
  }
  /** Wolkenspitzbahn from station stId heading up / down (seatInfo). */
  railNext(stId, up) {
    const R = this.sys.railway;
    return R?.departures ? this.seatInfo('train', R.departures(stId, up), R.seatCount, R.carCount, (e) => e.train.id) : null;
  }
  /** Legacy Express fromId -> toId (seatInfo). */
  expressNext(fromId, toId) {
    const X = this.sys.express;
    return X?.departuresFor ? this.seatInfo('express', X.departuresFor(fromId, toId), X.seatCount, X.carCount, (e) => e.train.id) : null;
  }
  /** Ski bus stop from -> to (seatInfo; single player: your own bus comes for you, every seat free). */
  busNext(from, to) {
    const SB = this.sys.skibus, L = SB?.line;
    if (!L) return null;
    if (!MP.active) return { wait: NaN, cap: L.seatCount, free: L.seatCount, cars: 1, full: false };
    return this.seatInfo('bus', L.mpBuses(SB.netStop(from), SB.netStop(to)), L.seatCount, 1, (e) => e.bus.id);
  }
  /** The picker's line for a departure: " · next train in 0:42 · 178 of 192 seats free" / " · train in now, leaves in
   *  12 s · ..." / " · next bus in 0:42 · Full (36/36) · next one in 9:10". */
  pickerText(n, what) {
    if (!n) return '';
    let t = '';
    if (Number.isFinite(n.wait)) t = n.wait <= 0 ? ` · ${what} in now${Number.isFinite(n.left) ? `, leaves in ${Math.max(1, Math.ceil(n.left))} s` : ''}` : ` · next ${what} in ${clock(n.wait)}`;
    if (!n.full) return `${t} · ${seatsFree(n)}`;
    return `${t} · Full (${n.cap}/${n.cap})${n.next ? ` · next one in ${clock(n.next.wait)} (${n.next.free} free)` : ''}`;
  }
  /** For the boarding message: " · Car 2 of 4 · seat 14 (62 of 192)" (multiplayer: the seat the server gave you;
   *  single player: the seat you are given, every one free). k: 'train' | 'express' | 'bus'; up: the train's way. */
  boardTag(k, up = true) {
    const S = this.sys, m = MP.active ? this.mine : null;
    let seat = -1, cap = 0, cars = 1;
    try {
      if (k === 'train' && S.railway) { cap = S.railway.seatCount; cars = S.railway.carCount; seat = S.railway.preferredSeat(S.railway.trains[0], up); }
      else if (k === 'express' && S.express) { cap = S.express.seatCount; cars = S.express.carCount; seat = S.express.preferredSeat(); }
      else if (k === 'bus' && S.skibus?.line) { cap = S.skibus.line.seatCount; seat = S.skibus.line.preferredSeat(); }
    } catch { return ''; }
    if (m && m.k === k) { seat = m.seat; cap = m.n || cap; }
    return seat >= 0 && cap ? ` · ${seatText(seat, cap, cars)}` : '';
  }
  /** The seat you ride in, for the status line / the boarding message: "Car 2 · seat 14 of 192" ('' if none). */
  seatLabel() {
    const S = this.sys;
    let no = -1, cap = 0, cars = 1;
    if (S.railway?.ride) { const r = S.railway.ride; no = r.seatNo ?? -1; cap = S.railway.seatCount; cars = S.railway.carCount; }
    else if (S.express?.ride) { const r = S.express.ride; no = r.seatNo ?? -1; cap = S.express.seatCount; cars = S.express.carCount; }
    else if (S.skibus?.line?.ride) { const L = S.skibus.line, r = L.ride; no = r.seatNo ?? L.bus.seats.indexOf(r.seat); cap = L.seatCount; }
    else if (S.lifts?.ride) { const r = S.lifts.ride; no = Number.isInteger(r.seat) ? r.seat : -1; cap = r.line?.seatCount || 0; }
    return no < 0 || !cap ? '' : seatText(no, cap, cars);
  }

  // ---------------------------------------------------------------- every frame (session.update)
  update() {
    const S = this.sys, p = S.player?.pos;
    // waiting on the platform / for the cabin: still there?
    if (this.wait && p) {
      const b = this.wait.st.board || this.wait.st;
      if (S.railway?.riding || Math.hypot(p.x - b.x, p.z - b.z) > PLATFORM_R) { this.wait = null; if (!S.railway?.riding) this.flash('Wolkenspitzbahn · you left the platform', 'good', 1800); }
      else this.railTry();
    }
    if (this.busWait && p) {
      const f = this.busWait.from;
      if (S.skibus?.riding || Math.hypot(p.x - f.x, p.z - f.z) > STOP_R) { this.busWait = null; if (!S.skibus?.riding) this.flash('Ski bus · you left the stop', 'good', 1800); }
      else this.busTry();
    }
    if (this.liftQueue && p) { // (the cabin was full: once it has gone by, a seat in the next one)
      const q = this.liftQueue;
      if (Math.hypot(p.x - q.near.x, p.z - q.near.z) > LIFT_R || S.player.mode === 'sit' || this.liftWait) this.liftQueue = null;
      else if (!this.pending) { const nc = q.line.nextCar(q.target); if (nc && `L${q.line.mpId}-${nc.idx}` !== q.v) this.liftGate(q.st, q.retry); }
    }
    if (this.liftWait && p) {
      const w = this.liftWait;
      if (Math.hypot(p.x - w.near.x, p.z - w.near.z) > LIFT_R || S.player.mode === 'sit') { this.liftWait = null; this.s.releaseSeat(); this.mine = null; }
      else this.liftTry();
    }
    // the seat you hold: gone back once you are off
    const m = this.mine;
    let line = '';
    if (m) {
      const riding = this.riding(m);
      if (riding) {
        m.rode = true;
        this.s.holdSkip(m.k, m.v, this.space, this.skipOpts(m));
        line = this.rideLineFor(m);
      } else if (m.rode || (!this.liftWait && !this.ready && performance.now() - m.t > GRACE_MS)) {
        this.s.releaseSeat(); this.mine = null;
      }
    }
    if (!line) line = this.waitLine();
    this.s.ui?.setSkip(line);
  }

  riding(m) {
    const S = this.sys;
    if (m.k === 'train') return S.railway?.ride?.train === m.train;
    if (m.k === 'express') return S.express?.ride?.train === m.train;
    if (m.k === 'gondola' || m.k === 'chair') return S.lifts?.ride?.line === m.line && S.lifts.ride.idx === m.idx;
    if (m.k === 'bus') return !!m.bus && S.skibus?.line?.ride?.fleetBus === m.bus;
    return false;
  }
  skipOpts(m) {
    const o = (this._so ||= { rate: 1, line: '' });
    if (m.k === 'train') { o.rate = RAIL_RATE; o.line = 'rail'; }
    else if (m.k === 'express') { o.rate = this.sys.expressRate || 10; o.line = m.train?.dir > 0 ? 'e' : 'w'; }
    else if (m.k === 'bus') { o.rate = BUS_RATE; o.line = m.bus?.route?.mpLine; }
    else { o.rate = LIFT_RATE; o.line = m.line ? (m.line.mpLine ||= `L${m.line.mpId}`) : undefined; }
    return o;
  }
  // "Hold SPACE to speed up (2/3 holding)" (rebuilt only when the server's skip state for it changes)
  skipLineFor(m) {
    const o = MP.skip?.get(m.skipKey ||= `${m.k}|${m.v}`) || null;
    if (o !== this.skipObj) { this.skipObj = o; this.skipText = this.s.skipLine(m.k, m.v); }
    return this.skipText;
  }
  // riding: your seat ("Car 2 of 4 · seat 14 (62 of 192) · 37 aboard"), then the speed-up line when others ride too
  rideLineFor(m) {
    const skip = this.skipLineFor(m), aboard = (MP.seats.get(m.skipKey) || []).length;
    if (this.rideKey !== m.skipKey || this.rideSkip !== skip || this.rideAboard !== aboard) {
      this.rideKey = m.skipKey; this.rideSkip = skip; this.rideAboard = aboard;
      const seat = this.seatLabel();
      this.rideText = [seat && `${seat}${aboard > 1 ? ` · ${aboard} aboard` : ''}`, skip].filter(Boolean).join(' · ');
    }
    return this.rideText;
  }
  // waiting: when the train / the cabin is due (rebuilt once a second)
  waitLine() {
    // (the train / bus you can get into: a full one is skipped, you are queued for the next with a free seat)
    let sec = -1, what = '', n = null;
    const X = this.sys.express;
    if (this.wait) { n = this.railNext(this.wait.st.id, this.wait.up); what = 'rail'; }
    else if (this.busWait) { n = this.busNext(this.busWait.from, this.busWait.to); what = 'bus'; }
    else if (X?.wait && !X.ride && X.stations) { n = this.expressNext(X.stations[X.wait.from].id, X.stations[X.wait.dest].id); what = 'express'; } // (waiting on its platform)
    else if (this.liftQueue && !this.liftWait) { const q = this.liftQueue, c = q.line.spec.type === 'chair' ? 'Chair' : 'Cabin'; return `${c} full (${q.line.seatCount}/${q.line.seatCount}) · you're queued for the next one`; }
    else if (this.liftWait) { const w = this.liftWait; sec = Math.ceil(Math.max(0, w.line.travelTime(w.line.cars[w.idx].s, (((w.target - w.line.cars[w.idx].s) % (2 * w.line.L)) + 2 * w.line.L) % (2 * w.line.L)))); what = 'lift'; }
    else return '';
    const m = n && (n.full ? n.next : n);
    if (what !== 'lift') sec = m ? Math.ceil(m.wait) : -2;
    const free = m ? m.free : -1, full = !!n?.full;
    if (sec === this.waitSec && what === this.waitWhat && free === this.waitFree && full === this.waitFull) return this.waitText;
    this.waitSec = sec; this.waitWhat = what; this.waitFree = free; this.waitFull = full;
    const head = what === 'bus' ? `Ski bus to ${this.busWait.to.name}` : what === 'rail' ? 'Wolkenspitzbahn' : what === 'express' ? `Legacy Express to ${X.stations[X.wait.dest].name}` : '';
    const veh = what === 'bus' ? 'bus' : 'train';
    if (what === 'lift') this.waitText = sec > 1 ? `Your ${this.liftWait.line.spec.type === 'chair' ? 'chair' : 'cabin'} comes in ${sec} s` : 'Boarding';
    else if (!m) this.waitText = n ? `${head} · Full (${n.cap}/${n.cap}) · wait for the next ${veh}` : head;
    else this.waitText = `${head} · ${full ? `${veh === 'bus' ? 'Bus' : 'Train'} full (${n.cap}/${n.cap}) · next ${veh}` : m.wait > 0 ? `next ${veh}` : 'boarding'}${m.wait > 0 ? ` in ${fmtWait(m.wait)}` : ''} · ${seatsFree(m)}`;
    return this.waitText;
  }

  relogin() {
    // the seats went with the old connection: claim yours again (the same seat if it is still free)
    this.s.skipHeld = null;
    this.ready = null; this.pending = false; this.liftWait = null;
    const m = this.mine;
    if (!m || !this.riding(m)) { this.mine = null; return; }
    net.request('seatClaim', { k: m.k, v: m.v, n: m.n, seat: m.seat }).then((d) => { m.seat = d.seat; }, () => {});
  }

  // ---------------------------------------------------------------- the other players' seats (remote.js)
  /** Seat n of vehicle v (kind k) as drawn here: into out, returns its facing as a heading; null if unknown. */
  seat(k, v, n, out) {
    const S = this.sys;
    if (k === 'bus') return S.skibus?.line?.seatWorldAt(v, n, out) ?? null;
    const e = this.ref(k, v);
    if (!e) return null;
    if (e.sys === 'rail') return S.railway.seatWorldAt(e.tr, n, out);
    if (e.sys === 'express') return S.express.seatWorldAt(e.tr, n, out);
    if (e.sys === 'lift') return e.line.group?.visible === false ? null : e.line.seatInto(e.idx, n, out);
    return null;
  }
  ref(k, v) {
    let m = this.cache.get(k);
    if (!m) { m = new Map(); this.cache.set(k, m); }
    let e = m.get(v);
    if (e !== undefined) return e;
    e = null;
    const S = this.sys;
    if (k === 'train') { const tr = S.railway?.trains.find((t) => t.id === v); if (tr) e = { sys: 'rail', tr }; }
    else if (k === 'express') { const tr = S.express?.trains?.find((t) => t.id === v); if (tr) e = { sys: 'express', tr }; }
    else if (k === 'gondola' || k === 'chair') {
      const mm = /^L(\d+)-(\d+)$/.exec(v), line = mm && S.lifts?.lines[+mm[1]];
      if (line && line.cars[+mm[2]]) e = { sys: 'lift', line, idx: +mm[2] };
    }
    m.set(v, e);
    return e;
  }

  flash(text, kind, ms) { this.s.c.hud?.flash(text, kind, ms); }
}

function fmtWait(s) { s = Math.max(1, Math.ceil(s)); return s < 90 ? `${s} s` : clock(s); }
function clock(s) { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
// seat no (0-based, numbered through the cars) of cap: "Car 2 of 4 · seat 14 (62 of 192)" / "Seat 12 of 36"
function seatText(no, cap, cars = 1) {
  if (cars > 1) { const per = Math.round(cap / cars); return `Car ${Math.floor(no / per) + 1} of ${cars} · seat ${(no % per) + 1} (${no + 1} of ${cap})`; }
  return `Seat ${no + 1} of ${cap}`;
}
// "178 of 192 seats free in 4 cars" / "36 seats free" (nobody aboard)
function seatsFree(n) { return `${n.free === n.cap ? `${n.cap} seats free` : `${n.free} of ${n.cap} seats free`}${n.cars > 1 ? ` in ${n.cars} cars` : ''}`; }
function liftKind(l) { return l.spec.type === 'chair' ? 'chair' : 'gondola'; }
