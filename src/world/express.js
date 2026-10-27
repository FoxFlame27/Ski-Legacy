// The Legacy Express at runtime: the high-speed trains round the ring (expressroute.js), from the village's
// underground hall to a station beside every World Racing course. Trains run both ways on a timetable (right-hand
// running on the double track), each a pair of the Wolkenspitzbahn's two-car railcars in multiple (train.js: the
// same railcar, its Meshy body, seats and seated passengers, in the line's Legacy blue). You board at the village
// entrance beside the ski shop, on any station's platform or at the "Legacy Express" stop sign beside every race's
// start; the route picker (ui/travel.js) lists every race and picks the shorter way round. You ride in the lead
// car's panorama row, looking out through the cab (R: outside view, mouse: look round, Space: fast-forward, Enter:
// skip to the arrival); at a race station a shuttle takes you up to the start (startSpot: on the flat start shoulder
// with room round you, E races).
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
  EXPRESS, EXPRESS_NAME, EXPRESS_PROFILE, LENGTH, STEP, DWELL, expressAt, trackAt, expressNearest, inExpressTunnel,
  onExpressBridge, inSpanOf, wrapS,
} from './expressroute.js';
import { buildCar, CAR, trainUniforms } from './train.js';
import { world } from './world.js';
import { layout } from './layout.js';
import { freeCourses } from '../modes/parkour/freeworld.js';
import { addTrainBlocker } from '../game/traffic.js';
import { smoothstep, clamp, lerp } from '../core/noise.js';

// the track agent's module (track, viaducts, tunnels, stations, the village entrance and hall): loaded lazily so
// the trains run (and the game boots) whether it is there or not
let TRACK_MODULE = {};
try { TRACK_MODULE = import.meta.glob('./expresstrack.js'); } catch { /* (Node tools: no glob imports) */ }

export const EXPRESS_PRICE = 40;   // any race, one way (free with the day pass)
export const EXPRESS_LIVERY = true; // the railcar in Legacy blue (false: the Wolkenspitzbahn's own red)
const CARS = 4;                     // two two-car units in multiple: cab, car, car, cab (the middle cabs meet)
const FLIP = [false, true, false, true]; // car k turned round (its cab facing back)
const PITCH = CAR.len + CAR.gap;    // m between car centres
const PER_DIR = 3;                  // trains each way round the ring (one every ~11 min)
export const FAST = 10;             // Space: the timetable runs this much faster while you ride
const NEAR = 420, FAR = 4500;       // m from the viewer: full cars / the far version / hidden
const STATION_R = 10, ENTRANCE_R = 7, SIGN_R = 5; // m: where E boards
const START_R = 24;
const VIEWS = ['seat', 'outside', 'trackside']; // R: the window seat, the chase camera, a camera beside the line                 // (freeworld.js: E at a course's start within this races it)
const G = 9.81;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0), _e = new THREE.Euler();
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

// ------------------------------------------------------------------ the stop sign at the race starts
let SIGN = null;
function signParts() {
  if (SIGN) return SIGN;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let tex = null;
  if (canvas) {
    canvas.width = 512; canvas.height = 640;
    const g = canvas.getContext('2d'), W = 512, H = 640;
    const F = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
    g.fillStyle = '#16245a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#e2231a'; g.fillRect(0, 0, W, 22);
    // the train pictogram: a raked high-speed nose on a rail
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(96, 250); g.lineTo(96, 140); g.quadraticCurveTo(96, 112, 124, 112); g.lineTo(300, 112);
    g.bezierCurveTo(372, 112, 420, 170, 432, 236); g.lineTo(432, 250); g.closePath(); g.fill();
    g.fillStyle = '#16245a';
    g.beginPath(); g.moveTo(312, 130); g.bezierCurveTo(360, 132, 396, 168, 410, 200); g.lineTo(312, 200); g.closePath(); g.fill();
    for (const x of [124, 184, 244]) g.fillRect(x, 136, 44, 52);
    g.fillStyle = '#ffffff'; g.fillRect(80, 268, 370, 8);
    g.fillStyle = '#e2231a'; g.fillRect(96, 226, 336, 10);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff'; g.font = `italic 700 104px ${F}`; g.fillText('LEGACY', W / 2, 400);
    g.font = `italic 700 104px ${F}`; g.fillText('EXPRESS', W / 2, 496);
    g.fillStyle = '#9fb3e8'; g.font = `600 40px ${F}`; g.fillText('TRAINS TO EVERY RACE', W / 2, 566);
    g.fillStyle = '#e2231a'; g.fillRect(0, H - 18, W, 18);
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  }
  const face = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x16245a, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.06, roughness: 0.5, metalness: 0.05 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.45, metalness: 0.6 });
  SIGN = { face, frame, faceGeo: new THREE.PlaneGeometry(1.0, 1.25), boxGeo: new THREE.BoxGeometry(1.08, 1.33, 0.08), postGeo: new THREE.CylinderGeometry(0.055, 0.065, 3.4, 10), footGeo: new THREE.CylinderGeometry(0.2, 0.24, 0.12, 12) };
  return SIGN;
}
function buildSign(x, y, z, yaw) {
  const P = signParts(), g = new THREE.Group();
  g.name = 'express-stop-sign';
  for (const s of [-0.38, 0.38]) {
    const post = new THREE.Mesh(P.postGeo, P.frame); post.position.set(s, 1.7, 0); post.castShadow = true; g.add(post);
    const foot = new THREE.Mesh(P.footGeo, P.frame); foot.position.set(s, 0.04, 0); g.add(foot);
  }
  const box = new THREE.Mesh(P.boxGeo, P.frame); box.position.set(0, 2.62, 0); box.castShadow = true; g.add(box);
  for (const side of [1, -1]) {
    const f = new THREE.Mesh(P.faceGeo, P.face);
    f.position.set(0, 2.62, side * 0.042); f.rotation.y = side > 0 ? 0 : Math.PI;
    g.add(f);
  }
  g.position.set(x, y - 0.05, z); g.rotation.y = yaw;
  return g;
}

// ------------------------------------------------------------------ trains
class TrainSet {
  constructor(ex, dir, phase, index) {
    this.dir = dir; this.phase = phase; this.index = index;
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
    this.signs = [];
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
    this.passengers = null; // (copied from the Wolkenspitzbahn's once it has seated its own: copyPassengers)
    try { this.buildSigns(); } catch (e) { console.warn('Legacy Express stop signs', e); }
    this.track = null;
    this.ready = this.loadTrack({ models, colliders, cameraBlockers });
    this.update(0, {});
  }

  get riding() { return !!this.ride; }
  way(dir) { return dir > 0 ? this.tt.up : this.tt.down; }
  u(tr) { const L = this.way(tr.dir).loop; return ((((this.t + tr.phase * L) % L) + L) % L); }

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
  update(dt, { viewer = null, fast = false } = {}) {
    if (!this.ok) return;
    // Space while riding: the timetable runs FAST times quicker (the streaming keeps up: main.js streams ahead)
    this.timeScale = this.ride && fast ? FAST : 1;
    this.t = (this.t + dt * this.timeScale) % (this.tt.up.loop * 1000);
    const cam = viewer || (this.ride ? this.seatWorld() : null);
    for (const tr of this.trains) {
      trainState(this.tt, this.way(tr.dir), this.u(tr), tr.state);
      this.place(tr, cam);
    }
    // the car you sit in shows its cabin; seen from outside the Meshy body (like every other car)
    const inside = !!this.ride && this.view === 'seat';
    if (this.cabin.inside !== inside) { this.cabin.inside = inside; this.cabin.setInside?.(inside); }
    this.cabin.group.visible = !!this.ride;
    this.copyPassengers();
    if (this.passengers) { const vis = !!this.ride; if (vis !== this.passengers.visible) this.passengers.visible = vis; }
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
  /** The prompt at the village entrance, a station's platform or a race's stop sign: { label, from } or null. */
  interaction(p, { hasPass = false } = {}) {
    if (this.ride || !this.ok) return null;
    const price = hasPass ? 'Day pass' : `$${EXPRESS_PRICE}`;
    for (const st of this.stations) {
      const b = st.board, r = st.underground ? ENTRANCE_R : STATION_R;
      if (!b || Math.abs(p.x - b.x) > r || Math.abs(p.z - b.z) > r || Math.hypot(p.x - b.x, p.z - b.z) > r) continue;
      if (!st.underground && p.y !== undefined && Math.abs(p.y - st.y) > 9) continue;
      return { from: st, label: st.underground ? `${EXPRESS_NAME} · trains to every race · ${price}` : `${EXPRESS_NAME} · ${st.name} station · ${price}` };
    }
    for (const sg of this.signs) {
      if (Math.abs(p.x - sg.x) > SIGN_R || Math.abs(p.z - sg.z) > SIGN_R || Math.hypot(p.x - sg.x, p.z - sg.z) > SIGN_R) continue;
      return { from: sg.station, sign: true, label: `${EXPRESS_NAME} · trains to every race · ${price}` };
    }
    return null;
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
   * Board at station `fromId` for `toId`: the timetable jumps so a train going the shorter way stands at the
   * platform with its doors open (main.js hides the jump behind a fade); you take the window seat in the
   * panorama row of its lead car, looking out through the cab. Returns the seat (for player.sitOn).
   */
  board(fromId, toId) {
    const a = this.stIndex(fromId), b = this.stIndex(toId);
    if (a < 0 || b < 0 || a === b) return null;
    const dir = this.bestDir(a, b), w = this.way(dir);
    const tr = this.trains.find((x) => x.dir === dir);
    const segI = w.segs.findIndex((g) => g.kind === 'dwell' && g.st === a);
    this.t += w.segs[segI].t0 + 6 - this.u(tr); // (24 s to departure; Space hurries it)
    const seat = this.cabin.seats.find((s) => s.row === 1 && s.window && s.side > 0) || this.cabin.seats.find((s) => s.front && s.window) || this.cabin.seats[0];
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

  // where you end up getting off at station k: { id, name, course (id | null), exit: { x, z, heading } }
  arrival(k) { const st = this.stations[k]; return { id: st.id, name: st.name, course: st.course, exit: st.exit }; }
  /**
   * While riding: { seat, hint, eta (s), stop?: { name } (standing at a stop on the way: E gets you off) } or,
   * once, { seat, arrive } when the train stands at your stop (main.js takes you off: a fade, or the shuttle up
   * to the race's start).
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
  /** Skip the rest of the ride: the arrival at your stop (main.js covers it with the travel card). */
  skip() {
    const r = this.ride;
    if (!r || r.exitSent) return null;
    r.exitSent = true;
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

  // ------------------------------------------------------------------ the race starts
  // E at the stop sign beside every race's start boards for anywhere (the shuttle down to the station is implied);
  // the signs stand 28-38 m from the start on its flat shoulder, away from the heli's landing spot
  buildSigns() {
    for (const e of freeCourses()) {
      const k = this.stIndex(e.id);
      if (k < 0) continue;
      const fr = this.startFrame(e);
      let best = null;
      for (const side of [fr.pref, -fr.pref]) {
        for (let a = -14; a <= 10; a += 4) for (let d = 12; d <= 34; d += 2.5) {
          const lat = side * (fr.w + d), x = fr.x + fr.fx * a + fr.rx * lat, z = fr.z + fr.fz * a + fr.rz * lat;
          const dist = Math.hypot(x - fr.x, z - fr.z);
          if (dist < 28 || dist > 38) continue;
          if (Math.hypot(x - e.heli.x, z - e.heli.z) < 14) continue;
          const q = this.probe(e, fr, x, z, { clear: 1.6, maxDy: 6, line: 5 });
          if (!q) continue;
          const score = q.slope * 25 + q.dy * 0.5 + Math.abs(dist - 31) * 0.15 + (side !== fr.pref ? 2 : 0);
          if (!best || score < best.score) best = { x, z, y: q.y, score };
        }
        if (best) break;
      }
      if (!best) continue;
      const yaw = Math.atan2(fr.x - best.x, fr.z - best.z); // (facing the start)
      const g = buildSign(best.x, best.y, best.z, yaw);
      this.scene.add(g);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      for (const o of [-0.38, 0.38]) this.colliders.push({ x: best.x + c * o, z: best.z - s * o, r: 0.12 });
      this.signs.push({ x: best.x, z: best.z, y: best.y, course: e.id, station: this.stations[k], group: g });
    }
  }
  // the start's frame: the line (x, z, y), down the course (fx, fz), its right (rx, rz), the half width, the side
  // away from the heli's landing spot (pref: +1 right)
  startFrame(e) {
    const T = e.course.track, s0 = e.start.s, h = e.start.heading;
    const fx = Math.sin(h), fz = Math.cos(h), rx = -Math.cos(h), rz = Math.sin(h);
    const w = T.sAt(T.W, s0);
    const pref = (e.heli.x - e.start.x) * rx + (e.heli.z - e.start.z) * rz > 0 ? -1 : 1;
    // (y: the snow at the start, which is the start's own level wherever its region shapes the ground)
    return { x: e.start.x, z: e.start.z, y: world.groundHeight(e.start.x, e.start.z, e.start.y + 1), fx, fz, rx, rz, w, pref, h };
  }
  // is (x, z) a place to stand? the ground level (<= maxDy from the start) and flat, no collider or course mesh
  // within `clear` m, off the course line (`line` m past its edge): { y, slope, dy } or null
  probe(e, fr, x, z, { clear = 1.4, maxDy = 3.5, line = 1.5, cells = null } = {}) {
    const y = world.groundHeight(x, z);
    const dy = Math.abs(y - fr.y);
    if (dy > maxDy) return null;
    const k = 1.2, hx = world.groundHeight(x + k, z) - world.groundHeight(x - k, z), hz = world.groundHeight(x, z + k) - world.groundHeight(x, z - k);
    const slope = Math.hypot(hx, hz) / (2 * k);
    if (slope > 0.3) return null;
    for (const c of this.colliders) {
      const reach = (c.r ?? Math.max(c.hw, c.hd)) + clear;
      if (Math.abs(x - c.x) > reach || Math.abs(z - c.z) > reach) continue;
      if (c.r !== undefined) { if (Math.hypot(x - c.x, z - c.z) < c.r + clear) return null; continue; }
      const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
      if (Math.abs(lx) < c.hw + clear && Math.abs(lz) < c.hd + clear) return null;
    }
    // off the course itself (its first 300 m: it may curve back past the start)
    const T = e.course.track;
    for (let i = 0; i < Math.min(T.n, 150); i += 2) if (Math.hypot(x - T.X[i], z - T.Z[i]) < T.W[i] + line) return null;
    if (cells) {
      const C = cells.size, r = Math.ceil(clear / C);
      const ci = Math.floor(x / C), cj = Math.floor(z / C);
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) if (cells.set.has((ci + i) * 100003 + (cj + j))) return null;
    }
    return { y, slope, dy };
  }
  // the course's meshes standing on the snow round its start (start house, wand, flags, boards): occupied 0.5 m
  // cells from their real triangles between 0.15 and 2.5 m over the ground (decals and roofs overhead don't count)
  startObstacles(e, R = 34) {
    const g = e.course.group, C = 0.5, set = new Set();
    if (!g) return { set, size: C };
    g.updateMatrixWorld(true);
    const sx = e.start.x, sz = e.start.z, v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const m = new THREE.Matrix4(), im = new THREE.Matrix4(), box = new THREE.Box3();
    g.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || !o.visible || !o.geometry?.attributes?.position) return;
      const geo = o.geometry, pos = geo.attributes.position, index = geo.index;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const n = o.isInstancedMesh ? o.count : 1;
      for (let k = 0; k < n; k++) {
        if (o.isInstancedMesh) { o.getMatrixAt(k, im); m.multiplyMatrices(o.matrixWorld, im); } else m.copy(o.matrixWorld);
        box.copy(geo.boundingBox).applyMatrix4(m);
        if (box.max.x < sx - R || box.min.x > sx + R || box.max.z < sz - R || box.min.z > sz + R) continue;
        const tris = index ? index.count / 3 : pos.count / 3;
        for (let t = 0; t < tris; t++) {
          for (let q = 0; q < 3; q++) v[q].fromBufferAttribute(pos, index ? index.getX(t * 3 + q) : t * 3 + q).applyMatrix4(m);
          const x0 = Math.min(v[0].x, v[1].x, v[2].x), x1 = Math.max(v[0].x, v[1].x, v[2].x), z0 = Math.min(v[0].z, v[1].z, v[2].z), z1 = Math.max(v[0].z, v[1].z, v[2].z);
          if (x1 < sx - R || x0 > sx + R || z1 < sz - R || z0 > sz + R || x1 - x0 > 40 || z1 - z0 > 40) continue;
          const base = world.height((x0 + x1) / 2, (z0 + z1) / 2);
          const lo = Math.min(v[0].y, v[1].y, v[2].y) - base, hi = Math.max(v[0].y, v[1].y, v[2].y) - base;
          if (hi < 0.15 || lo > 2.5) continue;
          for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) set.add(i * 100003 + j);
        }
      }
    });
    return { set, size: C };
  }
  /**
   * Where the shuttle sets you down at a race's start: on the flat start shoulder beside the start line (the side
   * away from the heli's landing spot first), clear of the start house, the wand, the flags and where the field
   * lines up, inside the start's E radius, facing down the course. Builds the course's meshes if they aren't up.
   * Returns { x, z, y, heading }.
   */
  startSpot(e) {
    try { if (!e.course.group) e.course.build(this.scene, this.models || {}); } catch (err) { console.warn('Legacy Express: course build', err); }
    const fr = this.startFrame(e);
    let cells = null;
    try { cells = this.startObstacles(e); } catch (err) { console.warn('Legacy Express: start obstacles', err); }
    const house = e.course.startHouse;
    const raised = Math.abs(e.start.y - fr.y); // (a start raised over its ground: the shoulder's higher parts)
    let best = null;
    for (const side of [fr.pref, -fr.pref]) {
      for (const a of [-2, 0, -4, 2, -6, 4, -8, 7, 10, 13]) for (const d of [3, 4.5, 6, 8, 10]) {
        const lat = side * (fr.w + d), x = fr.x + fr.fx * a + fr.rx * lat, z = fr.z + fr.fz * a + fr.rz * lat;
        if (Math.hypot(x - fr.x, z - fr.z) > START_R - 3.5) continue;
        if (Math.hypot(x - e.heli.x, z - e.heli.z) < 10) continue;
        if (house && Math.hypot(x - house.x, z - house.z) < 7) continue;
        const q = this.probe(e, fr, x, z, { clear: 1.5, maxDy: 3.5 + raised, line: 1.2, cells });
        if (!q) continue;
        // (+ how far below / above the start line's own level: freeworld's nearStart wants it within 12 m)
        const off = Math.abs(q.y - e.start.y), score = q.slope * 30 + q.dy * 0.8 + Math.max(0, off - 1.5) * 5 + (off > 10.5 ? 40 : 0) + Math.abs(a + 2) * 0.12 + d * 0.15 + (side !== fr.pref ? 2.5 : 0);
        if (!best || score < best.score) best = { x, z, y: q.y, score };
      }
    }
    // (nowhere on the shoulder: just past the start line on the course, the start wand behind you)
    if (!best) best = { x: fr.x + fr.fx * 4, z: fr.z + fr.fz * 4, y: world.groundHeight(fr.x + fr.fx * 4, fr.z + fr.fz * 4) };
    return { x: best.x, z: best.z, y: best.y, heading: fr.h };
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

  /** A place name for the HUD: riding, or standing at a station / the village entrance. */
  locName(p = null) {
    if (!this.ok) return null;
    const r = this.ride;
    if (!r) {
      if (!p) return null;
      for (const st of this.stations) {
        const b = st.board;
        if (!b) continue;
        if (st.underground ? Math.hypot(p.x - b.x, p.z - b.z) < 14 : Math.hypot(p.x - st.x, p.z - st.z) < 150 && Math.abs(p.y - st.y) < 20) return st.underground ? `${EXPRESS_NAME} · Legacy Village` : `${st.name} · ${EXPRESS_NAME}`;
      }
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
    if (SIGN) SIGN.face.emissiveIntensity = 0.06 + 0.5 * night;
    try { this.track?.setNight?.(night); } catch { /* (the track's own business) */ }
    if (this.ride) this.drawInfo();
  }
}

// ------------------------------------------------------------------ integration notes (main.js)
// openExpress(it): the route picker (travelPicker, mode 'route') with express.destinations(it.from.id); a pick ->
//   boardExpress(from, to): if (!hasPass() && !spend(EXPRESS_PRICE)) return; transition.fade(() => { const seat =
//   express.board(from.id, to.id); player.sitOn(seat); hide the rig; player.viewBeforeRide = player.view; })
// in the loop: if (express.riding) { const r = express.updateRide(); if (r?.seat) player.seat = r.seat;
//   if (r?.arrive) leaveExpress(r.arrive); E at r.stop: leaveExpress(express.leaveAtStop()); Enter:
//   leaveExpress(express.skip()) }  leaveExpress: the village -> a fade to the entrance (exit); a race -> the
//   travel card "shuttle up to the start", express.startSpot(course) (you stand at the start: E races)
