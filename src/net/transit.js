// Shared transport in multiplayer: the Wolkenspitzbahn (world/railway.js), the Legacy Express (world/express.js), the
// gondolas and chairlifts (world/lifts.js) and the ski buses (game/bus/bus.js fleet). Everyone in a world sees the same vehicle in
// the same place:
//  - every system is driven off its line's shared timeline (session.lineTime: the server clock plus the line's
//    speed-up offset) through its `mp` hook instead of its own clock; nobody brings, holds or shifts a vehicle;
//  - boarding waits for the real vehicle (the train standing at the platform, the next cabin coming round) and claims
//    a seat in the server's seat registry (seatClaim): everyone gets a different seat, a full vehicle says
//    "Full · wait for the next one"; you sit in the seat you got;
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
    this.mine = null; this.wait = null; this.busWait = null; this.liftWait = null; this.ready = null; this.pending = false; this.fullId = null;
  }

  // ---------------------------------------------------------------- boarding gates (main.js)
  /** boardRail: true = board now (railway.mpPick is set); false = waiting for the train / a seat (retry() boards). */
  railGate(st, up, dest, retry) {
    const key = `rail|${st.id}|${up}|${dest}`;
    if (this.ready?.key === key) { this.sys.railway.mpPick = { train: this.ready.train, seat: this.ready.seat }; this.ready = null; return true; }
    this.liftWait = null;
    this.wait = { key, st, up, dest, retry };
    this.waitSec = -1;
    const n = this.sys.railway.nextAt(st.id, up);
    if (!this.railTry() && n) this.flash(`Wolkenspitzbahn · the next train ${up ? 'up' : 'down'} is in ${Math.max(1, Math.ceil(n.wait))} s · wait on the platform`, 'good', 3200);
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
    this.claim('train', tr.id, { n: tr.seatCount, seat: R.preferredSeat(tr, w.up) }, (seat) => {
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
    if (!n || n.wait > 0 || n.left < BOARD_MIN || this.pending || this.fullId === n.train.id) return false;
    const tr = n.train;
    this.claim('express', tr.id, { n: X.seatCount, seat: X.preferredSeat() }, (seat) => {
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
    this.wait = null; this.liftWait = null;
    const nf = SB.netStop(from), nt = SB.netStop(to);
    const n = L.mpNextBus(nf, nt);
    if (!n) { this.busWait = null; this.flash(`No bus goes from ${from.name} to ${to.name}`, 'bad', 2600); return false; }
    this.busWait = { key, from, to, nf, nt, retry };
    this.waitSec = -1;
    if (!this.busTry()) this.flash(`Ski bus to ${to.name} · next bus in ${fmtWait(n.wait)} · wait at the stop`, 'good', 3200);
    return false;
  }
  busTry() {
    const w = this.busWait, L = this.sys.skibus?.line;
    if (!w || !L) return false;
    const n = L.mpNextBus(w.nf, w.nt);
    if (!n || n.wait > 0) { this.fullId = null; return false; }
    if (n.left < BOARD_MIN || this.fullId === n.bus.id) return false;
    if (this.pending) return true;
    const b = n.bus, key = w.key, retry = w.retry;
    this.claim('bus', b.id, { n: L.seatCount, seat: L.preferredSeat() }, (seat) => {
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
    const near = { x: st.stop && line.mid ? line.mid.x : st.up ? line.spec.bottom.x : line.spec.top.x, z: st.stop && line.mid ? line.mid.z : st.up ? line.spec.bottom.z : line.spec.top.z };
    this.claim(liftKind(line), `L${line.mpId}-${nc.idx}`, { n: line.seatCount, seat: line.preferredSeat }, (seat) => {
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

  claim(k, v, { n, seat }, ok) {
    this.pending = true;
    net.request('seatClaim', { k, v, n, seat }).then((d) => {
      this.pending = false;
      if (!MP.active) return;
      this.mine = { k, v, seat: d.seat, n, t: performance.now(), rode: false };
      this.fullId = null;
      ok(d.seat);
    }, (e) => {
      this.pending = false;
      if (e.code === 'full') { this.fullId = v; this.flash('Full · wait for the next one', 'bad', 2600); }
      else this.flash(ERR_TEXT[e.code] || e.message || 'No seat', 'bad', 2400);
    });
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
        line = this.skipLineFor(m);
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
  // waiting: when the train / the cabin is due (rebuilt once a second)
  waitLine() {
    let sec = -1, what = '';
    if (this.wait) { const n = this.sys.railway?.nextAt(this.wait.st.id, this.wait.up); if (n) { sec = Math.ceil(n.wait); what = 'rail'; } }
    else if (this.busWait) { const n = this.sys.skibus?.line?.mpNextBus(this.busWait.nf, this.busWait.nt); if (n) { sec = Math.ceil(n.wait); what = 'bus'; } }
    else if (this.liftWait) { const w = this.liftWait; sec = Math.ceil(Math.max(0, w.line.travelTime(w.line.cars[w.idx].s, (((w.target - w.line.cars[w.idx].s) % (2 * w.line.L)) + 2 * w.line.L) % (2 * w.line.L)))); what = 'lift'; }
    else return '';
    if (sec === this.waitSec && what === this.waitWhat) return this.waitText;
    this.waitSec = sec; this.waitWhat = what;
    this.waitText = what === 'bus' ? (sec > 0 ? `Ski bus to ${this.busWait.to.name} · next bus in ${fmtWait(sec)}` : `Ski bus to ${this.busWait.to.name} · boarding`)
      : what === 'rail' ? (sec > 0 ? `Wolkenspitzbahn · next train in ${sec} s` : 'Wolkenspitzbahn · boarding') : sec > 1 ? `Your ${this.liftWait.line.spec.type === 'chair' ? 'chair' : 'cabin'} comes in ${sec} s` : 'Boarding';
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

function fmtWait(s) { s = Math.max(1, Math.ceil(s)); return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`; }
function liftKind(l) { return l.spec.type === 'chair' ? 'chair' : 'gondola'; }
