// The Legacy Express at runtime: the high-speed trains round the ring (expressroute.js), from Legacy Village's
// station to a station beside every World Racing course. Trains run both ways on a timetable (right-hand running on
// the double track), each a pair of the Wolkenspitzbahn's two-car railcars in multiple (train.js: the same railcar,
// its Meshy body, seats and seated passengers, in the line's Legacy blue), and stop at every station. You walk onto a
// station's platform (E: the route picker, ui/travel.js) and board the train standing there: while you are near a
// station (on foot) a train each way is brought in within ~40 s and waits at the platform for you; picked before it
// is in, you wait on the platform and board as it stops. You ride in the lead car's panorama row, looking out
// through the cab (R: outside view, mouse: look round, Space: fast-forward, Enter: skip to the arrival) and get off
// on the platform of your stop, beside your car: from there you walk (to the race's start, into the village).
//
// main.js glue (see the integration notes at the bottom of this file):
//   express = new Express({ scene, colliders, models, makeRig, railway, cameraBlockers }); await express.ready
//   findInteraction(): express.interaction(player.pos, { hasPass }) -> { label, from } | null
//   loop, after railway.update: express.update(dt, { viewer, fast })   (timetable, trains, the track's LOD)
//   while riding:               express.updateRide() -> { seat, hint, stop?, arrive? }
//   loop, after player.update:  express.applyCamera(camera, input, dt)
//   loop, after railway.lateUpdate: express.lateUpdate(camera, env, atmosphere, dt)  (tunnel light, cabin light)
import * as THREE from 'three';
import {
  EXPRESS, EXPRESS_NAME, EXPRESS_PROFILE, LENGTH, STEP, DWELL, PLATFORM, expressAt, trackAt, expressNearest, inExpressTunnel,
  onExpressBridge, inSpanOf, wrapS, ringDelta, TRACK_OFF,
} from './expressroute.js';
import { brakeFor, release, latOf, CarColliders } from './trainstop.js';
import { buildCar, CAR, trainUniforms } from './train.js';
import { world } from './world.js';
import { layout } from './layout.js';
import { freeCourses } from '../modes/parkour/freeworld.js';
import { addTrainBlocker } from '../game/traffic.js';
import { smoothstep, clamp, lerp } from '../core/noise.js';

// the track agent's module (track, viaducts, tunnels, stations): loaded lazily so
// the trains run (and the game boots) whether it is there or not
let TRACK_MODULE = {};
try { TRACK_MODULE = import.meta.glob('./expresstrack.js'); } catch { /* (Node tools: no glob imports) */ }

export const EXPRESS_PRICE = 75;   // any race, one way (free with the day pass)
export const EXPRESS_LIVERY = true; // the railcar in Legacy blue (false: the Wolkenspitzbahn's own red)
const CARS = 4;                     // two two-car units in multiple: cab, car, car, cab (the middle cabs meet)
const FLIP = [false, true, false, true]; // car k turned round (its cab facing back)
const PITCH = CAR.len + CAR.gap;    // m between car centres
const PER_DIR = 8;                  // trains each way round the ring (one every ~4 min; Oct 30, the user: 8 trains. Double track: they never meet)
export const FAST = 10;             // Space: the timetable runs this much faster while you ride
const NEAR = 420, FAR = 4500;       // m from the viewer: full cars / the far version / hidden
const STATION_R = 10;              // m round a station's board point where E boards (besides anywhere on its platforms)
const HOLD_R = 500;                 // m: on foot this near a station, a train each way comes in soon and waits there
const NUDGE_WAIT = 75, WANT = 40;   // s: a train due later than NUDGE_WAIT is brought in to arrive in WANT
const DEPART_MIN = 12;              // s: boarding, the train waits at least this long before it leaves
const EXIT_LAT = 6.3;               // m from the centre line: where you stand on the platform getting off
const VIEWS = ['seat', 'outside', 'trackside']; // R: the window seat, the chase camera, a camera beside the line
const G = 9.81;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0), _e = new THREE.Euler(), _mpf = new THREE.Vector3();
const MP_BOARD_MIN = 4; // s: multiplayer, a train still standing at least this long can be boarded (nobody holds it)
const _p = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0 }, _q = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0 };
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ timetable
// Both ways round the ring the same: a dwell at every stop, the run to the next (the speed profile's times; the
// limit is the same either way, so the runs take as long both ways). Segments [{ kind: 'dwell', st, t0, dur } |
// { kind: 'run', a, b, ia, ib (samples), t0, dur }], one loop each way (~33 min).
function buildTimetable(stations) {
  const V = EXPRESS_PROFILE.V, n = EXPRESS.n;
  const Tm = new Float64Array(n + 1); // pure running time from the hall at each sample (+s)
  for (let i = 1; i <= n; i++) Tm[i] = Tm[i - 1] + STEP / Math.max((V[i] + V[i - 1]) / 2, 0.3);
  const idx = stations.map((st) => Math.round(st.s / STEP));
  const way = (dir) => {
    const order = dir > 0 ? stations.map((_, k) => k) : [0, ...stations.map((_, k) => k).slice(1).reverse()];
    const segs = [];
    let t = 0;
    for (let j = 0; j < order.length; j++) {
      const a = order[j], b = order[(j + 1) % order.length];
      segs.push({ kind: 'dwell', st: a, t0: t, dur: DWELL }); t += DWELL;
      let ia = idx[a], ib = idx[b];
      if (dir > 0 && ib === 0) ib = n; // (back into the hall from the west)
      if (dir < 0 && ia === 0) ia = n; // (out of the hall going west)
      const dur = Math.abs(Tm[ib] - Tm[ia]);
      segs.push({ kind: 'run', a, b, ia, ib, t0: t, dur }); t += dur;
    }
    return { dir, segs, loop: t };
  };
  return { Tm, V, idx, up: way(1), down: way(-1) };
}
// where a train of timetable `tt` (one way) is at loop time u: { s, speed, at (station index | -1), seg, next }
function trainState(tt, way, u, out) {
  const L = way.loop, segs = way.segs;
  u = ((u % L) + L) % L;
  let k = 0;
  while (k < segs.length - 1 && segs[k + 1].t0 <= u) k++;
  const g = segs[k];
  out.seg = k; out.u = u;
  if (g.kind === 'dwell') {
    out.at = g.st; out.next = g.st; out.speed = 0; out.s = tt.stationS[g.st]; out.left = g.t0 + g.dur - u;
    return out;
  }
  const Tm = tt.Tm, fwd = g.ib > g.ia, tau = u - g.t0;
  const target = fwd ? Tm[g.ia] + tau : Tm[g.ia] - tau;
  let lo = Math.min(g.ia, g.ib), hi = Math.max(g.ia, g.ib);
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Tm[mid] <= target) lo = mid; else hi = mid; }
  const f = clamp((target - Tm[lo]) / Math.max(1e-6, Tm[hi] - Tm[lo]), 0, 1);
  out.s = wrapS((lo + f) * STEP);
  out.speed = tt.V[lo] + (tt.V[hi] - tt.V[lo]) * f;
  out.at = -1; out.next = g.b; out.left = 0;
  return out;
}

// ------------------------------------------------------------------ livery
// The railcar's red (its Meshy body's texture, the procedural shell's vertex colour) turned Legacy blue; the white,
// the black window bands and the grey stay.
function livery(mat, key) {
  const m = mat.clone();
  const prev = mat.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', `{
        vec3 c0 = diffuseColor.rgb;
        float red = smoothstep(0.06, 0.24, c0.r - max(c0.g, c0.b));
        vec3 blue = vec3(0.010, 0.050, 0.40) * clamp(c0.r * 2.0, 0.3, 1.7);
        diffuseColor.rgb = mix(c0, blue, red);
      }
      #include <alphamap_fragment>`);
  };
  m.customProgramCacheKey = () => `express-livery-${key}`;
  return m;
}

// ------------------------------------------------------------------ trains
class TrainSet {
  constructor(ex, dir, phase, index) {
    this.dir = dir; this.phase = phase; this.index = index;
    this.id = `express-${dir > 0 ? 'e' : 'w'}${index}`; // stable id (multiplayer seats: claimSeat('express', id))
    this.group = new THREE.Group();
    this.group.name = `express-train-${dir > 0 ? 'e' : 'w'}${index}`;
    this.cars = [];
    for (let k = 0; k < CARS; k++) {
      const c = ex.lightCar();
      this.group.add(c.group, c.lo);
      this.cars.push(c);
    }
    this.state = { s: 0, speed: 0, at: -1, seg: 0, next: 0, u: 0, left: 0 };
    this.lod = -1;
    ex.scene.add(this.group);
  }
  get way() { return this.dir > 0 ? 'up' : 'down'; }
}

export class Express {
  constructor({ scene, colliders = [], models = null, makeRig = null, railway = null, cameraBlockers = null } = {}) {
    this.scene = scene; this.colliders = colliders; this.models = models; this.makeRig = makeRig; this.railway = railway;
    this.ride = null;      // { train, from, dest, dir, segI, departed, exitSent, seat }
    this.view = 'seat';    // seat | outside
    this.look = { yaw: 0, pitch: -0.04 };
    this.chase = { yaw: 0, pitch: 0.16, dist: 46 };
    this.dark = 0;
    this.timeScale = 1;
    this.t = 0;
    this.off = { 1: 0, '-1': 0 }; // s: each direction's timetable shift (trains brought in / held at a station)
    this.wait = null;      // { from, dest, dir }: picked before the train was in (you wait on the platform)
    this.streamPos = new THREE.Vector3();
    this.ok = !!(layout.express?.stations?.length && EXPRESS_PROFILE.V);
    if (!this.ok) { console.warn('Legacy Express: no line (expressground.js did not run)'); this.ready = Promise.resolve(); return; }
    this.stations = layout.express.stations;
    this.tt = buildTimetable(this.stations);
    this.tt.stationS = this.stations.map((st) => st.s);
    this.courses = new Map(freeCourses().map((e) => [e.id, e]));
    // the cars: one full railcar (the cabin you ride in: interior, seats, passengers) and light ones for every
    // other place in every train (its Meshy body, underframe and bogies sharing the cabin's geometry)
    this.cabin = buildCar({ number: 1 });
    this.cabin.group.name = 'express-cabin';
    this.cabin.group.visible = false;
    this.paintSrc = this.cabin.lo.children[0]?.material || null;
    const body = this.cabin.group.getObjectByName('rail-car-meshy');
    this.bodyMat = body && EXPRESS_LIVERY ? livery(body.material, 'body') : body?.material || null;
    this.paintMat = this.paintSrc && EXPRESS_LIVERY ? livery(this.paintSrc, 'paint') : this.paintSrc;
    if (body) body.material = this.bodyMat;
    this.cabin.group.traverse((o) => { if (o.isMesh && o.material === this.paintSrc) o.material = this.paintMat; });
    scene.add(this.cabin.group);
    this.trains = [];
    for (const dir of [1, -1]) for (let k = 0; k < PER_DIR; k++) this.trains.push(new TrainSet(this, dir, k / PER_DIR + (dir > 0 ? 0 : 0.5 / PER_DIR), k));
    // traffic stops for (and is shoved off the line by) the near trains (game/traffic.js)
    addTrainBlocker(() => this.trains.flatMap((tr) => tr.lod === 2 ? [] : tr.cars.map((c, k) => (k === 0 && this.ride?.train === tr ? this.cabin : c).group)), { hw: CAR.hw, hd: CAR.half });
    this.solid = new CarColliders(colliders, 8, PITCH / 2); // the cars near you are solid (trainstop.js; PITCH: no gaps)
    this.rate = { 1: 1, '-1': 1 }; this.blocked = { 1: false, '-1': false }; // (you on a track: that direction's clock)
    this.passengers = null; // (copied from the Wolkenspitzbahn's once it has seated its own: copyPassengers)
    this.track = null;
    this.ready = this.loadTrack({ models, colliders, cameraBlockers });
    this.update(0, {});
  }

  get riding() { return !!this.ride; }
  way(dir) { return dir > 0 ? this.tt.up : this.tt.down; }
  u(tr) {
    const L = this.way(tr.dir).loop;
    if (this.mp) return ((((this.mp.time(tr.dir) + tr.phase * L) % L) + L) % L); // (multiplayer: the direction's shared timeline)
    return ((((this.t + this.off[tr.dir] + tr.phase * L) % L) + L) % L);
  }

  async loadTrack({ models, colliders, cameraBlockers }) {
    const load = TRACK_MODULE['./expresstrack.js'];
    if (!load) return;
    try {
      const mod = await load();
      if (typeof mod.buildExpressTrack !== 'function') return;
      this.track = mod.buildExpressTrack(this.scene, { models, colliders, cameraBlockers });
    } catch (e) { console.warn('Legacy Express track', e); this.track = null; }
  }

  // a car for the trains: the cabin's underframe, bogies and (Meshy) body, sharing its geometry; its far version
  lightCar() {
    const src = this.cabin, group = new THREE.Group(), bogies = [];
    group.name = 'express-car';
    for (const ch of src.group.children) {
      if (ch.name === 'rail-car-proc') continue;
      const c = ch.clone();
      if (ch.name === 'rail-car-meshy') { c.visible = true; c.material = this.bodyMat; }
      const bi = src.bogies.indexOf(ch);
      if (bi >= 0) bogies[bi] = c;
      group.add(c);
    }
    const lo = src.lo.clone();
    lo.traverse((o) => { if (o.isMesh && this.paintMat) o.material = this.paintMat; });
    lo.visible = false;
    return { group, lo, bogies };
  }

  // ------------------------------------------------------------------ timetable + trains
  update(dt, { viewer = null, fast = false, walker = null, player = null, audio = null } = {}) {
    if (!this.ok) return;
    // Space while riding: the timetable runs FAST times quicker (the streaming keeps up: main.js streams ahead)
    if (this.mp) { // multiplayer (net/transit.js): each direction on its shared timeline (u); nobody brings or holds a train
      this.timeScale = this.ride ? this.mp.rate(this.ride.dir) : 1;
      this.stopFor(null, dt, audio);
    } else {
      this.timeScale = this.ride && fast ? FAST : 1;
      this.t = (this.t + dt * this.timeScale) % (this.tt.up.loop * 1000);
      // you on a track (player: main.js, null while riding): a train coming brakes and waits short of you; that
      // direction's clock runs at its rate (its other trains keep their spacing)
      this.stopFor(this.ride ? null : player, dt, audio);
      for (const dir of [1, -1]) if (this.rate[dir] < 1) this.off[dir] -= dt * this.timeScale * (1 - this.rate[dir]);
      if (walker && !this.ride) this.serve(walker, dt);
    }
    const cam = viewer || (this.ride ? this.seatWorld() : null);
    for (const tr of this.trains) {
      trainState(this.tt, this.way(tr.dir), this.u(tr), tr.state);
      this.place(tr, cam);
    }
    this.solidCars(this.ride ? null : player);
    // the car you sit in shows its cabin; seen from outside the Meshy body (like every other car)
    const inside = !!this.ride && this.view === 'seat';
    if (this.cabin.inside !== inside) { this.cabin.inside = inside; this.cabin.setInside?.(inside); }
    this.cabin.group.visible = !!this.ride;
    this.copyPassengers();
    if (this.passengers) { const vis = !!this.ride && !this.noPassengers; if (vis !== this.passengers.visible) this.passengers.visible = vis; }
    // the line's own LOD (track, tunnels, stations) round the viewer
    if (viewer && this.track?.update) {
      try { this.track.update(viewer, { inTunnel: this.ride && this.view !== 'trackside' ? inExpressTunnel(this.camS ?? this.ride.train.state.s, -80) : null }); }
      catch (e) { if (!this.trackWarned) { this.trackWarned = true; console.warn('Legacy Express track update', e); } }
    }
    // stream the world ahead of a fast train (main.js: terrain + forests round streamPos while riding)
    if (this.ride) {
      const st = this.ride.train.state;
      trackAt(st.s + this.ride.dir * Math.min(900, st.speed * this.timeScale * 2.5), this.ride.dir, _p);
      this.streamPos.set(_p.x, _p.y, _p.z);
    }
  }

  // each direction's clock rate this frame (this.rate, 0..1) from its trains' brakes (trainstop.js), off the states
  // of the last frame; this.blocked[dir]: you are on that direction's track (serve brings no train in past you)
  stopFor(p, dt, audio) {
    let lat = null, sp = 0, LAT = 2.3;
    const n = p && expressNearest(p.x, p.z);
    if (n) {
      sp = n.s; lat = latOf(p, expressAt(sp, _q));
      // on a platform's length only between the rails (its edge is 1.6 m from the track's middle)
      if (this.stations.some((st) => Math.abs(ringDelta(st.s, sp)) < PLATFORM / 2 + 15)) LAT = 1.4;
    }
    const LEN = 3 * PITCH + CAR.len; // (nose to tail)
    for (const dir of [1, -1]) {
      const on = lat !== null && Math.abs(lat - TRACK_OFF * dir) < LAT && dt > 0;
      this.blocked[dir] = on;
      let rate = 1;
      for (const tr of this.trains) {
        if (tr.dir !== dir) continue;
        const st = tr.state, b = tr.stop || (tr.stop = {}), v = st.speed || 0;
        if (!on) { if (!p || !(dt > 0)) release(b, v); else rate = Math.min(rate, brakeFor(b, v, null, dt)); continue; } // (pulling away again)
        const D = ringDelta(st.s + dir * (1.5 * PITCH + CAR.half), sp) * dir; // (m from its nose to you, ahead)
        rate = Math.min(rate, brakeFor(b, v, D > -(LEN + 2) ? D : null, dt, audio));
      }
      for (const tr of this.trains) if (tr.dir === dir && tr.stop) tr.stop.ve = rate * (tr.state.speed || 0);
      this.rate[dir] = rate;
    }
  }
  // the cars within reach of you as box colliders (null: all parked)
  solidCars(p) {
    this.solid.begin();
    if (p) for (const tr of this.trains) {
      const st = tr.state, d = tr.dir;
      trackAt(st.s, d, _p);
      if (Math.abs(_p.x - p.x) > 110 || Math.abs(_p.z - p.z) > 110) continue;
      for (let k = 0; k < CARS; k++) {
        trackAt(st.s + d * (1.5 - k) * PITCH, d, _p);
        this.solid.add(_p.x, _p.y, _p.z, _p.dx, _p.dz, p);
      }
    }
    this.solid.end();
  }

  // place a train's cars on its track (each body between its bogies, leaning a little into the curves: a tilting
  // train), or its far version, or nothing
  place(tr, viewer) {
    const st = tr.state, d = tr.dir, riding = this.ride?.train === tr;
    trackAt(st.s, d, _p);
    const dist = viewer ? Math.hypot(viewer.x - _p.x, viewer.z - _p.z) : 0;
    const lod = riding || dist < NEAR ? 0 : dist < FAR ? 1 : 2;
    if (lod === 2) { if (tr.lod !== 2) { tr.group.visible = false; tr.lod = 2; } return; }
    if (tr.lod === 2 || tr.lod < 0) tr.group.visible = true;
    tr.lod = lod;
    // lean: the lateral acceleration (speed^2 x curvature) at the set's middle, as a tilting body
    const h0 = Math.atan2(expressAt(st.s - d * 12, _q).dx * d, _q.dz * d), h1 = Math.atan2(expressAt(st.s + d * 12, _q).dx * d, _q.dz * d);
    const kappa = wrapA(h1 - h0) / 24; // (+: turning left)
    const lean = clamp((st.speed * st.speed * kappa) / G * 0.32, -0.065, 0.065); // (+: leaning left)
    for (let k = 0; k < CARS; k++) {
      const useCabin = riding && k === 0;
      const c = useCabin ? this.cabin : tr.cars[k];
      if (riding && k === 0) { tr.cars[0].group.visible = false; tr.cars[0].lo.visible = false; }
      else { c.group.visible = lod === 0; c.lo.visible = lod === 1; }
      const sc = st.s + d * (1.5 - k) * PITCH;
      const fwd = FLIP[k] ? -d : d; // the way the car's cab (+z) faces, in s
      const sF = sc + fwd * CAR.bogie, sB = sc - fwd * CAR.bogie;
      trackAt(sF, d, _p); _a.set(_p.x, _p.y, _p.z);
      trackAt(sB, d, _p); _b.set(_p.x, _p.y, _p.z);
      const g = c.group;
      g.position.addVectors(_a, _b).multiplyScalar(0.5);
      _m.lookAt(_b, _a, _up);
      g.quaternion.setFromRotationMatrix(_m);
      g.rotateY(Math.PI);
      // (+z forward, +x is the car's left: rotateZ(+) leans it to the right)
      g.rotateZ(FLIP[k] ? lean : -lean);
      if (c.lo.visible) { c.lo.position.copy(g.position); c.lo.quaternion.copy(g.quaternion); }
      if (lod === 0 || useCabin) {
        const bodyYaw = _e.setFromQuaternion(g.quaternion, 'YXZ').y;
        for (let j = 0; j < 2; j++) {
          expressAt(j === 0 ? sB : sF, _q);
          c.bogies[j].rotation.set(0, wrapA(Math.atan2(_q.dx * fwd, _q.dz * fwd) - bodyYaw), FLIP[k] ? -lean : lean);
        }
      }
    }
  }

  // the Wolkenspitzbahn's seated passengers (railway.js bakes them once, in the same railcar's seat layout):
  // instanced into the cabin too, so the express runs busy (the rider's front-row seat stays free)
  copyPassengers() {
    if (this.passengers !== null) return;
    const src = this.railway?.trains?.[0]?.cars?.[0]?.passengers;
    if (!src?.length) return;
    const grp = new THREE.Group();
    grp.name = 'express-passengers';
    for (const im of src) {
      const c = new THREE.InstancedMesh(im.geometry, im.material, im.count);
      c.instanceMatrix.array.set(im.instanceMatrix.array);
      c.instanceMatrix.needsUpdate = true;
      c.receiveShadow = true;
      c.computeBoundingSphere();
      grp.add(c);
    }
    grp.visible = false;
    this.cabin.group.getObjectByName('rail-car-proc')?.add(grp) || this.cabin.group.add(grp);
    if (!grp.parent) this.cabin.group.add(grp);
    this.passengers = grp;
  }

  // ------------------------------------------------------------------ boarding
  stIndex(id) { return this.stations.findIndex((s) => s.id === id); }
  // is p on station st's platforms (or at its board point)? (pad: m of slack all round)
  onPlatform(st, p, pad = 0) {
    if (p.y !== undefined && Math.abs(p.y - st.y) > 6 + pad * 0.3) return false;
    const b = st.board;
    if (b && Math.hypot(p.x - b.x, p.z - b.z) < STATION_R + pad) return true;
    const dx = Math.sin(st.heading), dz = Math.cos(st.heading), x = p.x - st.x, z = p.z - st.z;
    const u = x * dx + z * dz, lat = Math.abs(-x * dz + z * dx);
    return Math.abs(u) <= PLATFORM / 2 + pad && lat >= 3.0 - pad && lat <= 9.6 + pad;
  }
  // the next train going dir at station a: { train, wait (s until it stands at the platform; 0: it does now),
  // left (s until it leaves) }
  nextAt(a, dir) {
    const w = this.way(dir), d = w.segs.find((g) => g.kind === 'dwell' && g.st === a);
    if (!d) return null;
    let best = null;
    for (const tr of this.trains) {
      if (tr.dir !== dir) continue;
      const into = ((((this.u(tr) - d.t0) % w.loop) + w.loop) % w.loop); // (s since its stop here began)
      const n = into < d.dur ? { train: tr, wait: 0, left: d.dur - into } : { train: tr, wait: w.loop - into, left: d.dur };
      if (!best || n.wait < best.wait || (n.wait === 0 && n.left > best.left)) best = n;
    }
    return best;
  }
  // On foot near a station (main.js passes the walker): a train each way is brought in soon (its direction's
  // timetable shifted while it is still far off) and held at the platform while you are about (that direction's
  // clock stands still with a few seconds of its stop left). Nobody is ever moved: the trains come to you.
  serve(p, dt) {
    let a = -1, bd = HOLD_R;
    for (let k = 0; k < this.stations.length; k++) {
      const st = this.stations[k], d = Math.hypot(p.x - st.x, p.z - st.z);
      if (d < bd && (p.y === undefined || Math.abs(p.y - st.y) < 90)) { bd = d; a = k; }
    }
    if (a < 0) return;
    for (const dir of [1, -1]) {
      const n = this.nextAt(a, dir);
      if (!n) continue;
      if (n.wait > NUDGE_WAIT) { if (!this.blocked[dir]) this.off[dir] += n.wait - WANT; } // (never jumped past you on its track)
      else if (n.wait === 0 && n.left < 4) this.off[dir] -= dt * this.timeScale * this.rate[dir]; // (what stopFor has not held already)
    }
  }
  /** The prompt on a station's platform: { label, from } (or, waiting for your train, { label, from, cancel }). */
  interaction(p, { hasPass = false } = {}) {
    if (this.ride || !this.ok) return null;
    const w = this.wait;
    if (w && this.onPlatform(this.stations[w.from], p, 25)) {
      const n = this.nextAt(w.from, w.dir);
      return { from: this.stations[w.from], cancel: true, label: `Waiting for the ${EXPRESS_NAME} to ${this.stations[w.dest].name} · ${n && n.wait > 0 ? `due in ${Math.ceil(n.wait)} s` : 'boarding'} · E to cancel` };
    }
    const price = hasPass ? 'Day pass' : `$${EXPRESS_PRICE}`;
    for (let k = 0; k < this.stations.length; k++) {
      const st = this.stations[k];
      if (!this.onPlatform(st, p)) continue;
      const wait = Math.min(this.nextAt(k, 1)?.wait ?? Infinity, this.nextAt(k, -1)?.wait ?? Infinity);
      const when = wait <= 0 ? 'train at the platform' : wait < Infinity ? `next train in ${Math.ceil(wait)} s` : '';
      return { from: st, label: `${EXPRESS_NAME} · ${st.name}${when ? ` · ${when}` : ''} · ${price}` };
    }
    return null;
  }
  /** Is the train from fromId to toId (the shorter way round) standing at fromId's platform now? */
  trainIn(fromId, toId) {
    const a = this.stIndex(fromId), b = this.stIndex(toId);
    if (a < 0 || b < 0 || a === b) return false;
    const n = this.nextAt(a, this.bestDir(a, b));
    return n?.wait === 0 && (!this.mp || n.left >= MP_BOARD_MIN);
  }
  /** Multiplayer: the train standing at fromId for toId now ({ train, wait, left }) or null. */
  trainFor(fromId, toId) {
    const a = this.stIndex(fromId), b = this.stIndex(toId);
    if (a < 0 || b < 0 || a === b) return null;
    return this.nextAt(a, this.bestDir(a, b));
  }
  /** The seat number single player gives you (the panorama row's window seat): the seat registry's index. */
  preferredSeat() { const c = this.cabin.seats; return Math.max(0, c.indexOf(c.find((s) => s.row === 1 && s.window && s.side > 0) || c.find((s) => s.front && s.window) || c[0])); }
  get seatCount() { return this.cabin?.seats?.length || 0; }
  /** Where seat n (in the lead car: the riders' car) of train tr is now: into out, its facing as a heading; null when
   *  the train is too far to be placed. */
  seatWorldAt(tr, n, out) {
    const st = this.cabin.seats[n];
    if (!st || tr.lod === 2 || tr.lod < 0) return null;
    const g = this.ride?.train === tr ? this.cabin.group : tr.cars[0].group;
    out.copy(st.pos).applyQuaternion(g.quaternion).add(g.position);
    _mpf.set(Math.sin(st.yaw), 0, Math.cos(st.yaw)).applyQuaternion(g.quaternion);
    return Math.atan2(_mpf.x, _mpf.z);
  }
  /** Picked before the train is in: you wait on the platform (main.js boards you as it stops: waiting()). */
  waitFor(fromId, toId) {
    const a = this.stIndex(fromId), b = this.stIndex(toId);
    if (a < 0 || b < 0 || a === b) return null;
    this.wait = { from: a, dest: b, dir: this.bestDir(a, b) };
    return this.nextAt(a, this.wait.dir)?.wait ?? null;
  }
  cancelWait() { this.wait = null; }
  /** While waiting: 'ready' (your train stands at the platform: board it), 'gone' (you left the platform) or null. */
  waiting(p) {
    const w = this.wait;
    if (!w || this.ride) return null;
    if (!this.onPlatform(this.stations[w.from], p, 25)) { this.wait = null; return 'gone'; }
    const n = this.nextAt(w.from, w.dir);
    return n?.wait === 0 && (!this.mp || n.left >= MP_BOARD_MIN) ? 'ready' : null;
  }

  // ride time (s) from station a to b going dir (from the departure at a to the arrival at b, the stops between)
  tripTime(a, b, dir) {
    const w = this.way(dir), segs = w.segs;
    const da = segs.find((g) => g.kind === 'dwell' && g.st === a), db = segs.find((g) => g.kind === 'dwell' && g.st === b);
    return ((((db.t0 - (da.t0 + da.dur)) % w.loop) + w.loop) % w.loop);
  }
  bestDir(a, b) { return this.tripTime(a, b, 1) <= this.tripTime(a, b, -1) ? 1 : -1; }
  ringKm(a, b, dir) { const sa = this.stations[a].s, sb = this.stations[b].s; return (dir > 0 ? wrapS(sb - sa) : wrapS(sa - sb)) / 1000; }
  // the line from a to b going dir, every ~60 m ([[x, z]...], for the route map)
  path(a, b, dir) {
    const sa = this.stations[a].s, len = this.ringKm(a, b, dir) * 1000, pts = [];
    for (let d = 0; d < len; d += 60) { expressAt(sa + dir * d, _q); pts.push([_q.x, _q.z]); }
    expressAt(this.stations[b].s, _q); pts.push([_q.x, _q.z]);
    return pts;
  }
  /**
   * For the route picker: every other stop from station `fromId`, the shorter way round: [{ st, course (the
   * freeCourses() entry | null), dir, min, km, stops (between), pts }].
   */
  destinations(fromId) {
    const a = this.stIndex(fromId);
    if (a < 0) return [];
    return this.stations.map((st, b) => {
      if (b === a) return null;
      const dir = this.bestDir(a, b), n = this.stations.length;
      const stops = (dir > 0 ? (b - a + n) % n : (a - b + n) % n) - 1;
      return { st, course: st.course ? this.courses.get(st.course) || null : null, dir, min: this.tripTime(a, b, dir) / 60, km: this.ringKm(a, b, dir), stops, pts: this.path(a, b, dir) };
    }).filter(Boolean);
  }

  /**
   * Board the train standing at station `fromId`'s platform going the shorter way to `toId` (null if none is in:
   * waitFor() then): it waits at least DEPART_MIN s more; you take the window seat in the panorama row of its lead
   * car, looking out through the cab. Returns the seat (for player.sitOn).
   */
  board(fromId, toId) {
    const a = this.stIndex(fromId), b = this.stIndex(toId);
    if (a < 0 || b < 0 || a === b) return null;
    const dir = this.bestDir(a, b), w = this.way(dir);
    const n = this.nextAt(a, dir);
    if (!n || n.wait > 0) return null;
    const pick = this.mp ? this.mpPick : null; // multiplayer: the seat the server gave you on this very train
    this.mpPick = null;
    if (this.mp && (!pick || pick.train !== n.train)) return null;
    if (!this.mp && n.left < DEPART_MIN) this.off[dir] -= DEPART_MIN - n.left;
    const tr = n.train;
    const segI = w.segs.findIndex((g) => g.kind === 'dwell' && g.st === a);
    const seat = (pick && this.cabin.seats[pick.seat]) || this.cabin.seats.find((s) => s.row === 1 && s.window && s.side > 0) || this.cabin.seats.find((s) => s.front && s.window) || this.cabin.seats[0];
    this.wait = null;
    this.ride = { train: tr, from: a, dest: b, dir, segI, departed: false, exitSent: false, seat };
    this.lastDest = b;
    this.look.yaw = 0; this.look.pitch = -0.04;
    this.view = 'seat';
    this.fov = null; this.chase.off = null; this.chase.yaw = 0;
    this.update(0, {});
    return this.seatPose();
  }

  // the rider's seat: { pos (world, seat surface), fwd (world, horizontal) } for player.sitOn / updateSit
  seatPose() {
    const r = this.ride, car = this.cabin.group;
    car.updateMatrixWorld(true);
    const pos = r.seat.pos.clone();
    car.localToWorld(pos);
    const fwd = new THREE.Vector3(Math.sin(r.seat.yaw), 0, Math.cos(r.seat.yaw)).transformDirection(car.matrixWorld);
    fwd.y = 0; fwd.normalize();
    return { pos, fwd };
  }
  seatWorld() { return this.ride ? this.seatPose().pos : null; }

  // where you get off at station k: on its platform (the station's side) beside the lead car of a train going dir,
  // facing away from the track: { id, name, course (id | null), exit: { x, z, heading } }
  arrival(k, dir = this.ride?.dir ?? 1) {
    const st = this.stations[k], side = st.side || 1;
    const dx = Math.sin(st.heading), dz = Math.cos(st.heading), u = dir * 1.5 * PITCH, lat = side * EXIT_LAT;
    const exit = { x: st.x + dx * u - dz * lat, z: st.z + dz * u + dx * lat, heading: Math.atan2(-dz * side, dx * side) };
    return { id: st.id, name: st.name, course: st.course, exit };
  }
  /**
   * While riding: { seat, hint, eta (s), stop?: { name } (standing at a stop on the way: E gets you off) } or,
   * once, { seat, arrive } when the train stands at your stop (main.js takes you off onto its platform).
   */
  updateRide() {
    const r = this.ride;
    if (!r) return null;
    const st = r.train.state, seat = this.seatPose(), w = this.way(r.dir);
    if (st.seg !== r.segI) r.departed = true;
    const dest = this.stations[r.dest];
    if (r.departed && st.at === r.dest) {
      if (!r.exitSent) { r.exitSent = true; return { seat, arrive: this.arrival(r.dest), hint: `${dest.name} · arrived` }; }
      return { seat, hint: `${dest.name} · arrived` };
    }
    const db = w.segs.find((g) => g.kind === 'dwell' && g.st === r.dest);
    const eta = ((((db.t0 - st.u) % w.loop) + w.loop) % w.loop);
    let stop = null;
    if (r.departed && st.at >= 0 && !r.exitSent) stop = { name: this.stations[st.at].name, id: this.stations[st.at].id };
    const next = this.stations[st.at >= 0 && !r.departed ? r.dest : st.next];
    const mins = Math.max(1, Math.round(eta / 60));
    const hint = !r.departed ? `${EXPRESS_NAME} to ${dest.name} · departs in ${Math.ceil(st.left)} s`
      : stop ? `${stop.name} · press E to get off here`
      : next === dest ? `${EXPRESS_NAME} · next stop ${dest.name} · ${mins} min`
      : `${EXPRESS_NAME} to ${dest.name} · next stop ${next.name} · ${mins} min`;
    return { seat, hint, stop, eta };
  }
  /** Get off at the stop the train stands at (on the way): the arrival there (main.js takes you off). */
  leaveAtStop() {
    const r = this.ride, st = r?.train.state;
    if (!r || !r.departed || st.at < 0 || r.exitSent) return null;
    r.exitSent = true;
    return this.arrival(st.at);
  }
  /**
   * Skip the rest of the ride: the timetable jumps on (this direction's) until your train stands at your stop, and
   * you get off there (main.js covers it with a fade). The arrival, or null.
   */
  skip() {
    const r = this.ride;
    if (!r || r.exitSent || this.mp) return null; // (multiplayer: the train is shared; hold Space instead)
    const w = this.way(r.dir), db = w.segs.find((g) => g.kind === 'dwell' && g.st === r.dest);
    this.off[r.dir] += ((((db.t0 + 1 - this.u(r.train)) % w.loop) + w.loop) % w.loop);
    this.update(0, {});
    r.departed = true; r.exitSent = true;
    return this.arrival(r.dest);
  }
  abort() { this.ride = null; this.camS = undefined; }
  /** While riding: the train's speed (m/s). */
  get speed() { return this.ride ? Math.abs(this.ride.train.state.speed || 0) : 0; }
  // dev: the timetable moved so train `i` stands at arc length s (approximately: its nearest time)
  debugAt(s, i = 0) {
    const tr = this.trains[i], w = this.way(tr.dir), st = {};
    let best = 0, bd = Infinity;
    for (let u = 0; u < w.loop; u += 1) { trainState(this.tt, w, u, st); const d = Math.abs(wrapS(st.s - s + LENGTH / 2) - LENGTH / 2); if (d < bd) { bd = d; best = u; } }
    this.t += best - this.u(tr);
    this.update(0, {});
    return { ...tr.state };
  }

  // ------------------------------------------------------------------ cameras
  /** Seat or outside camera while riding (call after player.update). R switches, the mouse looks around. */
  applyCamera(camera, input, dt) {
    const r = this.ride;
    if (!r) return false;
    if (input?.hit?.('KeyR')) { this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]; this.chase.off = null; this.spot = null; }
    const sens = 0.0022 * (input?.sensitivity || 1);
    const car = this.cabin.group, st = r.train.state;
    if (this.view === 'trackside' && this.trackside(camera, dt)) { camera.updateProjectionMatrix(); return true; }
    car.updateMatrixWorld(true);
    const k6 = 1 - Math.exp(-dt * 6);
    if (this.view === 'seat') {
      this.look.yaw = clamp(this.look.yaw - (input?.mdx || 0) * sens, -1.75, 1.75);
      this.look.pitch = clamp(this.look.pitch - (input?.mdy || 0) * sens, -0.9, 1.0);
      // a seated passenger's eye in the car's frame (it leans with the car); turning to the side, the head leans
      // a little forward and away from the pane
      const turn = Math.abs(Math.sin(this.look.yaw)), fz = Math.cos(r.seat.yaw);
      const eye = _a.copy(r.seat.pos).add(_b.set(-Math.sign(r.seat.pos.x) * turn * 0.1, 0.76, (0.06 + turn * 0.12) * fz));
      car.localToWorld(eye);
      const yaw = r.seat.yaw + this.look.yaw;
      const dir = _c.set(Math.sin(yaw) * Math.cos(this.look.pitch), Math.sin(this.look.pitch), Math.cos(yaw) * Math.cos(this.look.pitch)).transformDirection(car.matrixWorld);
      camera.position.copy(eye);
      camera.up.copy(_up).transformDirection(car.matrixWorld);
      camera.lookAt(eye.add(dir));
      camera.near = 0.05;
      this.camS = st.s + r.dir * 1.5 * PITCH;
      this.fov = this.fov == null ? 72 : lerp(this.fov, 72, k6);
    } else { // (outside; also the trackside view where it has no spot: in a tunnel)
      this.chase.yaw -= (input?.mdx || 0) * sens;
      this.chase.pitch = clamp(this.chase.pitch - (input?.mdy || 0) * sens, -0.15, 0.9);
      this.chase.dist = clamp(this.chase.dist + (input?.wheel || 0) * 2.5, 18, 110);
      const d = r.dir, s = st.s;
      trackAt(s, d, _p);
      const target = _t.set(_p.x, _p.y + 2.2, _p.z);
      // orbit behind the train (mouse to swing round, wheel to zoom)
      const heading = Math.atan2(_p.dx * d, _p.dz * d) + Math.PI + this.chase.yaw;
      const D = this.chase.dist, cp = Math.cos(this.chase.pitch);
      const want = _c.set(Math.sin(heading) * cp * D, Math.sin(this.chase.pitch) * D + 2, Math.cos(heading) * cp * D);
      // in a tunnel, a cutting or behind a shoulder the orbit would sit in the rock: follow the track instead
      const tunnelNear = inExpressTunnel(s, -70);
      let follow = tunnelNear;
      for (let i = 1; i <= 10 && !follow; i++) {
        const k = i / 10, x = target.x + want.x * k, y = target.y + want.y * k, z = target.z + want.z * k;
        if (world.height(x, z) > y - (i === 10 ? 3 : 2)) follow = true;
      }
      if (follow) this.chase.hold = 1.2; else if ((this.chase.hold || 0) > 0) { this.chase.hold -= dt; follow = true; }
      this.camS = s;
      let rigid = false;
      if (follow) {
        this.camS = s - d * (2 * PITCH + 12);
        trackAt(this.camS, d, _p);
        const inTube = inExpressTunnel(this.camS, -4) || inExpressTunnel(s, 0);
        want.set(_p.x - target.x, _p.y + (inTube || tunnelNear ? 4.6 : 8) - target.y, _p.z - target.z);
        rigid = inTube;
        this.chase.yaw *= 1 - k6;
      }
      if (!this.chase.off || rigid) this.chase.off = want.clone();
      else this.chase.off.lerp(want, 1 - Math.exp(-dt * 5));
      camera.position.copy(target).add(this.chase.off);
      camera.up.copy(_up);
      camera.lookAt(target);
      camera.near = 0.1;
      this.fov = this.fov == null ? 58 : lerp(this.fov, 58, k6);
    }
    camera.fov = this.fov;
    camera.updateProjectionMatrix();
    return true;
  }
  // A camera beside the line ahead of the train, as for a railway film: it waits on the embankment (on a viaduct
  // out beside the deck, a drone's view) and follows the train going by with a long lens, then moves on ahead.
  // false where there is no spot (the train in a tunnel): the chase camera then.
  trackside(camera, dt) {
    const r = this.ride, st = r.train.state, d = r.dir;
    if (inExpressTunnel(st.s, -40)) { this.spot = null; return false; }
    trackAt(st.s + d * 1.2 * PITCH, d, _p);
    const target = _t.set(_p.x, _p.y + 2.4, _p.z);
    const sp = this.spot;
    const passed = sp && (wrapS((sp.s - st.s) * d + LENGTH / 2) - LENGTH / 2) < -(2 * PITCH + 25);
    if (sp && !passed) {
      // (the view blocked for a moment: a new spot)
      let blocked = false;
      for (let i = 1; i < 8 && !blocked; i++) { const k = i / 8, x = sp.x + (target.x - sp.x) * k, z = sp.z + (target.z - sp.z) * k; if (world.height(x, z) > sp.y + (target.y - sp.y) * k - 0.5) blocked = true; }
      sp.blocked = blocked ? (sp.blocked || 0) + dt : 0;
    }
    if (!sp || passed || sp.blocked > 0.6 || Math.hypot(sp.x - target.x, sp.z - target.z) > 1100) this.spot = this.pickSpot(target);
    if (!this.spot) return false;
    const q = this.spot;
    camera.position.set(q.x, q.y, q.z);
    camera.up.copy(_up);
    camera.lookAt(target);
    camera.near = 0.2;
    // a long lens far off, wider as it passes (the set about a third of the frame)
    const dist = camera.position.distanceTo(target);
    const want = clamp((2 * Math.atan(30 / Math.max(1, dist)) * 180) / Math.PI, 16, 62);
    this.fov = q.fresh || this.fov == null ? want : lerp(this.fov, want, 1 - Math.exp(-dt * 4));
    q.fresh = false;
    camera.fov = this.fov;
    this.camS = q.s;
    return true;
  }
  pickSpot(target) {
    const r = this.ride, st = r.train.state, d = r.dir;
    this.spotN = (this.spotN || 0) + 1;
    const ahead0 = 170 + Math.min(4, this.timeScale) * 60;
    for (let k = 0; k < 10; k++) {
      const s = st.s + d * (ahead0 + k * 45);
      if (inExpressTunnel(s, -25)) continue;
      const bridge = onExpressBridge(s, 8);
      const side = (this.spotN + k) % 2 ? 1 : -1;
      trackAt(s, d, _q);
      const rx = -_q.dz * d * side, rz = _q.dx * d * side;
      const lat = bridge ? 34 + (k % 3) * 8 : 14 + ((this.spotN + k) % 3) * 7;
      const x = _q.x + rx * lat - _q.dx * d * 25, z = _q.z + rz * lat - _q.dz * d * 25; // (a little back toward the train)
      const g = world.height(x, z);
      const y = bridge ? Math.max(g + 3, _q.y - 4) : Math.max(g + 1.7 + (k % 2) * 3, _q.y + 0.8);
      // the train in view now and where it passes
      let clear = true;
      for (const tx of [target, { x: _q.x, y: _q.y + 2, z: _q.z }]) {
        for (let i = 1; i < 10 && clear; i++) { const f = i / 10, px = x + (tx.x - x) * f, pz = z + (tx.z - z) * f; if (world.height(px, pz) > y + (tx.y - y) * f - 0.6) clear = false; }
      }
      if (clear) return { x, y, z, s, fresh: true, blocked: 0 };
    }
    return null;
  }

  // the cabin's info screens: the trip (from, to, the stops between, where we are), the next stop, the speed
  drawInfo() {
    const r = this.ride;
    if (!r || typeof document === 'undefined') return;
    if (!this.info) {
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 128;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 });
      // (the railcar's two screens: over the cab door and on the rear wall)
      this.cabin.group.traverse((o) => { const p = o.geometry?.parameters; if (o.isMesh && p && o.geometry.type === 'PlaneGeometry' && ((p.width === 1.2 && p.height === 0.3) || (p.width === 0.84 && p.height === 0.21))) o.material = mat; });
      this.info = { canvas, tex, key: '' };
    }
    const st = r.train.state, n = this.stations.length;
    const nextK = !r.departed ? r.from : st.at >= 0 ? st.at : st.next;
    const kmh = Math.round((st.speed * 3.6) / 5) * 5;
    const stops = [];
    for (let k = r.from; ; k = (k + r.dir + n) % n) { stops.push(k); if (k === r.dest || stops.length > n) break; }
    const pos = stops.indexOf(nextK);
    const key = `${nextK}|${kmh}|${st.at}|${r.departed}`;
    if (key === this.info.key) return;
    this.info.key = key;
    const g = this.info.canvas.getContext('2d'), W = 512, H = 128;
    const F = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
    const short = (k) => this.stations[k].name.replace(/ (Giant Slalom|Slalom|Super-G|Downhill)$/, '');
    g.fillStyle = '#0f1729'; g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#9fb3e8'; g.font = `600 19px ${F}`; g.textAlign = 'left';
    g.fillText(`LEGACY EXPRESS  \u2192  ${short(r.dest).toUpperCase()}`, 22, 25);
    g.textAlign = 'right'; g.fillStyle = '#ffffff'; g.font = `italic 700 24px ${F}`;
    g.fillText(`${kmh} km/h`, W - 22, 27);
    g.textAlign = 'left'; g.fillStyle = '#ffb02a'; g.font = `600 17px ${F}`;
    g.fillText(st.at >= 0 ? (r.departed ? 'NOW' : 'DEPARTING') : 'NEXT STOP', 22, 54);
    g.fillStyle = '#ffffff'; g.font = `700 30px ${F}`;
    g.fillText(short(st.at >= 0 ? st.at : nextK), 110, 56);
    // the trip: a line with its stops, the part behind us dimmed
    const x0 = 34, x1 = W - 34, y = 92, m = Math.max(1, stops.length - 1);
    const done = st.at >= 0 ? pos : pos - 0.5;
    g.lineWidth = 5; g.strokeStyle = '#33405f'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.strokeStyle = '#e2231a'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + ((x1 - x0) * Math.max(0, done)) / m, y); g.stroke();
    stops.forEach((k, i) => {
      const x = x0 + ((x1 - x0) * i) / m;
      g.fillStyle = i <= done ? '#e2231a' : '#ffffff'; g.beginPath(); g.arc(x, y, i === 0 || i === m ? 7 : 5, 0, 7); g.fill();
      if (i === 0 || i === m) { g.fillStyle = '#c9d4ee'; g.font = `600 15px ${F}`; g.textAlign = i === 0 ? 'left' : 'right'; g.fillText(short(k), i === 0 ? x - 6 : x + 6, y + 26); }
    });
    this.info.tex.needsUpdate = true;
  }

  /** A place name for the HUD: riding, or standing near a station. */
  locName(p = null) {
    if (!this.ok) return null;
    const r = this.ride;
    if (!r) {
      if (!p) return null;
      for (const st of this.stations) if (Math.hypot(p.x - st.x, p.z - st.z) < 150 && Math.abs(p.y - st.y) < 20) return `${st.name} · ${EXPRESS_NAME}`;
      return null;
    }
    const st = r.train.state;
    if (st.at >= 0) return `${this.stations[st.at].name} · ${EXPRESS_NAME}`;
    if (inExpressTunnel(st.s, 0)) return `${EXPRESS_NAME} · tunnel`;
    if (onExpressBridge(st.s, 0)) return `${EXPRESS_NAME} · viaduct`;
    return EXPRESS_NAME;
  }

  // ------------------------------------------------------------------ light: tunnels, cabin
  /** After railway.lateUpdate, before rendering: darkness inside the line's tunnels, the cabin light. */
  lateUpdate(camera, env, atmosphere, dt = 0.016) {
    if (!this.ok) return;
    let deep = 0;
    const cp = camera.position;
    let s = null;
    if (this.ride) s = this.camS ?? this.ride.train.state.s;
    else {
      const n = expressNearest(cp.x, cp.z);
      if (n && n.d < 14 && cp.y < expressAt(n.s, _q).y + 8) s = n.s;
    }
    if (s !== null) {
      for (const t of EXPRESS.tunnels) {
        if (!inSpanOf(t, s)) continue;
        const w = wrapS(s), x = w > t.s1 ? w - LENGTH : w;
        deep = Math.max(deep, smoothstep(10, 70, Math.min(x - t.s0, t.s1 - x)));
      }
    }
    this.dark = lerp(this.dark, deep, 1 - Math.exp(-dt * 3));
    const k = 1 - this.dark * 0.94;
    if (env && this.dark > 0.003) {
      env.sun.intensity *= k;
      env.hemi.intensity *= k;
      if (this.scene.environmentIntensity !== undefined) this.scene.environmentIntensity *= 1 - this.dark * 0.9;
    }
    if (this.dark > 0.3) {
      if (atmosphere?.snow) atmosphere.snow.visible = false;
      if (atmosphere?.crystalMesh) atmosphere.crystalMesh.visible = false;
    }
    // the cars' cabin light and headlights are shared with the Wolkenspitzbahn (train.js): the darker of the two
    const night = env ? clamp(Math.max(env.nightFactor || 0, 1 - (env.dayFactor ?? 1)), 0, 1) : 0;
    const dark = Math.max(this.dark, this.railway?.dark || 0);
    trainUniforms.uCabin.value = 0.3 + 0.9 * Math.max(night, dark);
    trainUniforms.uHead.value = Math.max(night, dark);
    for (const m of this.railway?.passengerMats || []) m.emissiveIntensity = 0.05 + 0.4 * Math.max(night, dark);
    try { this.track?.setNight?.(night); } catch { /* (the track's own business) */ }
    if (this.ride) this.drawInfo();
  }
}

// ------------------------------------------------------------------ integration notes (main.js)
// findInteraction: express.interaction(p) on a platform -> openExpress (the picker: every other station, its race);
//   a pick -> boardExpress(from, to): express.trainIn(from, to) ? (pay; transition.fade -> express.board, sitOn) :
//   express.waitFor(from, to) (you wait on the platform; E cancels: ex.cancel -> express.cancelWait())
// loop: express.update(dt, { viewer, fast, walker: on foot ? player.pos : null }); not riding: express.waiting(pos)
//   'ready' -> boardExpress; riding: updateRide() -> arrive / stop (E) / Enter (skip) -> leaveExpress(arrival):
//   a fade, standUp on that station's platform beside your car (arrival.exit)
