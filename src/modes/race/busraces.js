// The ski bus's FREE races (data: busracedefs.js). Three races laid on existing pistes: the start right below a ski-bus
// stop, the finish near the bottom of the run by another stop. No terrain is shaped and nothing is fenced: the course
// line follows the piste (smoothed), dressed like a World Racing course (start house, START arch, checkpoint arches,
// slalom gates, FINISH portal: parkour/props.js buildPisteRaceMeshes) and raced with the same session as the courses on
// the mountains (game/modes.js startFree -> modes/race/session.js: the AI field, gates, checkpoints, results; in
// multiplayer the server's queue, start and prizes).
//
// Beside each stop stands a race board (the job board's notice board with a FREE RACE header and the race's poster):
// E there opens the race card and takes you to the start gate (a short fade: it is 100-400 m down the piste); E at
// the start gate itself does the same. After the race you stay where you are (one OK, no teleport: Oct 30 2026, the user).
//
//   const bus = new BusRaces({ scene, models, colliders, stops: skibus.stops, sites: jobs.sites });
//   bus.update(dt, player, modes);   // meshes built / dropped by distance (twice a second)
//   bus.near(p)                      // { e, at: 'board' | 'start' } where E races, or null
//   busRaceEntries()                 // [{ id, name, course, D, reward, length, drop, start, finish, pts, stop, ... }]
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { layout, PISTE_WIDTH } from '../../world/layout.js';
import { fitModel } from '../../core/assets.js';
import { buildPisteRaceMeshes } from '../parkour/props.js';
import { laneDistance, ROAD_HALF } from '../../game/bus/roads.js';
import { BUS_RACE_DEFS, BUS_PRIZE, busRacePrize } from './busracedefs.js';

export { BUS_RACE_DEFS, BUS_PRIZE, busRacePrize };

const DS = 2;            // m between course samples
const LEAD = 12;         // m of piste above the start line (the start house stands there)
const RUNOUT = 45;       // m of piste below the finish line
const EDGE = 3;          // the course keeps this far inside the groomed edge (the piste fences stand 1.2 m beyond it)
const GATE_EVERY = 75;   // m between slalom gates
const CP_EVERY = 450;    // m between checkpoints
const BUILD_D = 1300, DROP_D = 2000; // m from the course or its board: build / drop the meshes
const START_R = 24;      // m around the start line: E races
const READ_R = 2.3;      // m in front of the race board
export const BUS_RACE_COLOR = '#e8a000'; // (post-bus gold: the trail map's race tape and the card)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ the course on the piste
// A track over 2 m samples from s = 0 with the parkour Track's conventions (heading = atan2(dx, dz), lateral +
// toward (-cos h, sin h)), its height the terrain's own.
class PisteTrack {
  constructor(X, Z, W) {
    const n = (this.n = X.length);
    this.X = X; this.Z = Z; this.W = W;
    this.Y = new Float64Array(n); this.H = new Float64Array(n); this.K = new Float64Array(n); this.B = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.Y[i] = world.height(X[i], Z[i]);
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      this.H[i] = Math.atan2(X[b] - X[a], Z[b] - Z[a]);
    }
    // unwrap the heading so it interpolates smoothly
    for (let i = 1; i < n; i++) this.H[i] = this.H[i - 1] + wrap(this.H[i] - this.H[i - 1]);
    for (let i = 5; i < n - 5; i++) this.K[i] = (this.H[i + 5] - this.H[i - 5]) / (10 * DS);
    this.length = (n - 1) * DS;
  }
  sAt(arr, s) {
    const f = clamp(s / DS, 0, this.n - 1.0001), i = Math.floor(f);
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  }
  surfaceY(s, v = 0) { const p = this.pointAt(s, v, {}, true); return world.height(p.x, p.z); }
  pointAt(s, lateral = 0, out = {}, flat = false) {
    const f = clamp(s / DS, 0, this.n - 1.0001), i = Math.floor(f), t = f - i;
    const x = this.X[i] + (this.X[i + 1] - this.X[i]) * t, z = this.Z[i] + (this.Z[i + 1] - this.Z[i]) * t;
    const h = this.H[i] + (this.H[i + 1] - this.H[i]) * t;
    out.x = x - Math.cos(h) * lateral; out.z = z + Math.sin(h) * lateral;
    out.heading = h;
    out.y = flat ? 0 : world.height(out.x, out.z);
    return out;
  }
}

// the piste's polyline between arc lengths a and b, smoothed (moving average over ~±20 m, ends kept) and
// resampled every DS m
function pisteLine(pts, a, b) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  b = Math.min(b, cum[cum.length - 1]);
  const at = (s) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = clamp((s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1), 0, 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
  };
  // 1 m samples, then a moving average twice (the traced piste zig-zags a little)
  let P = [];
  for (let s = a; s <= b; s += 1) P.push(at(s));
  for (let pass = 0; pass < 2; pass++) {
    const R = 18, Q = P.map((p) => p.slice());
    for (let i = 1; i < P.length - 1; i++) {
      const r = Math.min(R, i, P.length - 1 - i);
      let sx = 0, sz = 0;
      for (let k = -r; k <= r; k++) { sx += P[i + k][0]; sz += P[i + k][1]; }
      Q[i] = [sx / (2 * r + 1), sz / (2 * r + 1)];
    }
    P = Q;
  }
  // resample by arc length every DS m
  const X = [P[0][0]], Z = [P[0][1]];
  let acc = 0;
  for (let i = 1; i < P.length; i++) {
    let px = P[i - 1][0], pz = P[i - 1][1];
    let seg = Math.hypot(P[i][0] - px, P[i][1] - pz);
    while (acc + seg >= DS) {
      const f = (DS - acc) / seg;
      px += (P[i][0] - px) * f; pz += (P[i][1] - pz) * f;
      X.push(px); Z.push(pz);
      seg = Math.hypot(P[i][0] - px, P[i][1] - pz);
      acc = 0;
    }
    acc += seg;
  }
  return { X: Float64Array.from(X), Z: Float64Array.from(Z) };
}

/** A course on an existing piste (the race session's course contract, see parkour/courses.js). */
export class PisteCourse {
  constructor(def) {
    this.def = def;
    this.id = def.id; this.name = def.name; this.tagline = def.tagline;
    this.boardTitle = 'FREE RACE · SKI BUS';
    const p = layout.pistes.find((q) => q.name === def.piste);
    if (!p) throw new Error(`Bus race ${def.id}: no piste ${def.piste}`);
    this.piste = p;
    const { X, Z } = pisteLine(p.pts, def.from || 0, Number.isFinite(def.to) ? def.to : Infinity);
    const w = Math.max(8, (PISTE_WIDTH[p.diff] ?? 18) - EDGE);
    const T = (this.track = new PisteTrack(X, Z, new Float64Array(X.length).fill(w)));
    this.difficulty = p.diff <= 0 ? 'Easy' : p.diff === 1 ? 'Medium' : 'Hard';
    this.features = [];
    // start line LEAD m down the piste (the start house behind it), finish line RUNOUT m above the end
    const s0 = LEAD, fs = Math.max(s0 + 200, T.length - RUNOUT);
    this.finishS = fs;
    this.length = fs;
    const st = T.pointAt(s0, 0), fi = T.pointAt(fs, 0);
    this.start = { s: s0, x: st.x, z: st.z, y: st.y, heading: st.heading };
    this.finish = { s: fs, x: fi.x, z: fi.z, y: fi.y, heading: fi.heading };
    this.drop = Math.round(st.y - fi.y);
    const hs = s0 - 2.1 - 2.2, hp = T.pointAt(Math.max(0, hs), 0);
    this.startHouse = { x: hp.x, z: hp.z, y: hp.y, heading: st.heading, s: hs, front: s0 - 2.1 };
    this.line = { s: [], x: [], z: [], y: [], w: [], bank: [] };
    for (let i = 0; i < T.n; i++) { this.line.s.push(i * DS); this.line.x.push(T.X[i]); this.line.z.push(T.Z[i]); this.line.y.push(T.Y[i]); this.line.w.push(T.W[i]); this.line.bank.push(0); }
    // checkpoints (index 0 = the start), every ~CP_EVERY m and clear of the finish
    this.checkpoints = [{ index: 0, ...this.start, name: 'START' }];
    for (let s = s0 + CP_EVERY, k = 1; s < fs - 250; s += CP_EVERY, k++) {
      const q = T.pointAt(s, 0);
      this.checkpoints.push({ index: k, s, x: q.x, z: q.z, y: q.y, heading: q.heading, name: `CHECKPOINT ${k}` });
    }
    // slalom gates (giant-slalom style: the inside pole 2.5 m off the centre, 8 m openings, alternating), not in the
    // bends, around the checkpoints or near the start and finish
    this.gates = [];
    let side = 1, n = 0;
    for (let s = s0 + 70; s < fs - 70; s += GATE_EVERY) {
      if (Math.abs(T.sAt(T.K, s)) > 1 / 160 || this.checkpoints.some((c) => Math.abs(c.s - s) < 28)) continue;
      const q = T.pointAt(s, side * 2.5), h = q.heading;
      this.gates.push({ s, x: q.x, z: q.z, y: q.y, side, color: n % 2 ? 'blue' : 'red', nx: -Math.cos(h), nz: Math.sin(h), width: 8 });
      side = -side; n++;
    }
    this.par = def.par;
    this.medals = { gold: Math.round(def.par * 0.8), silver: Math.round(def.par * 0.9), bronze: def.par };
    this.group = null;
    this._noHit = { hit: false, side: 0, impact: 0, s: 0 };
  }
  pointAt(s, lateral = 0, out = {}) { return this.track.pointAt(s, lateral, out); }
  frictionAt() { return 1; }
  // no barriers: the piste's own fences and the snow around it (the session respawns you when you stray far off)
  constrain() { return this._noHit; }

  build(scene, models = {}) {
    if (!this.group) this.group = buildPisteRaceMeshes(this, models);
    if (scene && !this.group.parent) scene.add(this.group);
    return this.group;
  }
  dispose() {
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    const seen = new Set();
    this.group.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); if (!o.userData.keepGeometry) o.geometry.dispose(); }
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (seen.has(m) || m.userData?.shared) continue;
        seen.add(m);
        for (const key of ['map', 'alphaMap', 'emissiveMap']) if (m[key] && !m[key].userData?.shared) m[key].dispose();
        m.dispose();
      }
    });
    this.group = null;
  }
}

let entries = null;
/** The bus races (built once, after the terrain is final): { id, name, course, D, reward, rewardMax, length, drop,
 *  start, finish, pts (every ~30 m), stop, end, def, bus: true }. */
export function busRaceEntries() {
  if (entries) return entries;
  entries = [];
  for (const def of BUS_RACE_DEFS) {
    let course;
    try { course = new PisteCourse(def); } catch (e) { console.warn('Bus race', def.id, e); continue; }
    const T = course.track, pts = [];
    for (let i = 0; i < T.n; i += 15) pts.push([T.X[i], T.Z[i]]);
    pts.push([T.X[T.n - 1], T.Z[T.n - 1]]);
    entries.push({
      id: def.id, name: def.name, course, def, bus: true, stop: def.stop, end: def.end,
      D: { label: 'Free race', color: BUS_RACE_COLOR, entry: 0, ai: 'easy' },
      reward: def.reward, rewardMax: def.reward, par: def.par, length: course.length - course.start.s, drop: course.drop,
      start: course.start, finish: course.finish, pts,
    });
  }
  return entries;
}
/** The bus race with this id, or null. */
export const busRaceById = (id) => busRaceEntries().find((e) => e.id === id) || null;

// ------------------------------------------------------------------ the race board beside the stop
function signTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function headerTex() {
  return signTex(1024, 314, (g, W, H) => {
    g.fillStyle = '#0f5235'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#f2c200'; g.fillRect(0, H - 58, W, 58);
    g.strokeStyle = '#f2c200'; g.lineWidth = 10; g.strokeRect(14, 14, W - 28, H - 28);
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'italic bold 146px "Arial Narrow", Arial, sans-serif';
    g.fillText('FREE RACE', W / 2, 122);
    g.fillStyle = '#0f5235'; g.font = 'bold 36px Arial, sans-serif';
    g.fillText('FREE ENTRY · EVERY FINISHER IS PAID', W / 2, H - 29);
  });
}
function posterTex(e) {
  return signTex(768, 512, (g, W, H) => {
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0b3593'); sky.addColorStop(0.55, '#3a74db'); sky.addColorStop(1, '#eaf1fc');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(0, H * 0.56); g.bezierCurveTo(W * 0.4, H * 0.52, W * 0.7, H * 0.74, W, H * 0.66); g.lineTo(W, H); g.lineTo(0, H); g.fill();
    for (const [x, y, c] of [[120, 330, '#d8231a'], [270, 360, '#1f55e0'], [430, 405, '#d8231a'], [600, 450, '#1f55e0']]) {
      g.fillStyle = c; g.fillRect(x - 3, y - 60, 6, 60);
      g.beginPath(); g.moveTo(x + 3, y - 60); g.lineTo(x + 42, y - 48); g.lineTo(x + 3, y - 34); g.fill();
    }
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = 84;
    const name = e.name.toUpperCase();
    do { g.font = `italic bold ${fs}px "Arial Narrow", Arial, sans-serif`; fs -= 4; } while (g.measureText(name).width > W - 60 && fs > 36);
    g.fillText(name, W / 2, 84);
    g.font = 'bold 32px Arial, sans-serif';
    g.fillText(`${(e.length / 1000).toFixed(1)} KM · ${e.drop} M DROP · 1ST $${e.reward.toLocaleString('en-US')}`, W / 2, 158);
    g.fillStyle = '#13348f'; g.font = 'italic bold 34px Arial, sans-serif';
    g.fillText('Press E · we take you to the start', W / 2, H - 40);
  });
}
function gateFlag(color) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.9, 8), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
  pole.position.y = 0.95;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.46), new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide }));
  flag.position.set(0.32, 1.6, 0);
  for (const m of [pole, flag]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
  return g;
}
const BOARD_HW = 0.99; // (the job board's half width, game/jobs/props.js BOARD.halfW)

export class BusRaces {
  /**
   * @param {object} o { scene, models, colliders, stops (the ski bus's stops: their signs), sites (job sites: boardOk) }
   */
  constructor({ scene, models, colliders = [], stops = [], sites = null }) {
    this.scene = scene;
    this.models = models;
    this.t = 0;
    this.warned = false;
    this.list = busRaceEntries();
    for (const e of this.list) {
      const stop = stops.find((s) => s.name === e.stop);
      if (!stop) continue;
      e.stopAt = { x: stop.x, z: stop.z };
      try {
        e.board = this.place(stop, sites);
        if (!e.board) continue;
        colliders.push(e.board.collider);
        sites?.obst?.add?.(e.board.collider);
        const g = this.buildBoard(e);
        const { x, z, yaw } = e.board;
        const fx = Math.cos(yaw) * 0.72, fz = -Math.sin(yaw) * 0.72;
        const gh = (a, b) => Math.min(world.height(a, b), world.meshHeight?.(a, b) ?? world.height(a, b));
        g.position.set(x, Math.min(gh(x + fx, z + fz), gh(x - fx, z - fz), gh(x, z)) - 0.03, z);
        g.rotation.y = yaw;
        scene.add(g);
        e.boardGroup = g;
      } catch (err) { console.warn('Bus race board', e.id, err); }
    }
  }

  // beside the stop's sign, on the side away from its bench, facing the road like the sign: off the road, on level
  // ground, clear of the colliders (the job sites' obstacle map: the sign, the bench, the shelters, the car park's
  // props); the reading spot keeps clear of the bus prompt (3.5 m round the sign)
  place(stop, sites) {
    const h = stop.heading, fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h);
    const O = sites?.obst?.clearance ? sites.obst : null;
    const cands = [];
    for (const back of [1.2, 2.4, 0.4, 3.6]) for (const lat of [-4.8, -6.2, 5.6, 7, -7.8, 8.6]) cands.push([lat, back]);
    let first = null;
    for (const [lat, back] of cands) {
      const x = stop.x + lx * lat - fx * back, z = stop.z + lz * lat - fz * back;
      const front = { x: x + fx * 1.1, z: z + fz * 1.1 };
      if (Math.hypot(front.x - stop.x, front.z - stop.z) < 4) continue;
      const spot = { x, z, yaw: h, front, collider: { x, z, hw: BOARD_HW, hd: 0.2, rot: -h } };
      if (laneDistance(x, z) < ROAD_HALF + 1.6 || laneDistance(front.x, front.z) < ROAD_HALF + 0.6) continue;
      first ??= spot;
      const hs = [[0, 0], [lx * 1.5, lz * 1.5], [-lx * 1.5, -lz * 1.5], [fx * 1.2, fz * 1.2]].map(([a, b]) => world.height(x + a, z + b));
      if (Math.max(...hs) - Math.min(...hs) > 0.45) continue;
      if (O && (O.clearance(x, z, 2) < 0.5 || O.clearance(x + lx * BOARD_HW, z + lz * BOARD_HW, 2) < 0.4 || O.clearance(x - lx * BOARD_HW, z - lz * BOARD_HW, 2) < 0.4 || O.clearance(front.x, front.z, 2) < 0.6)) continue;
      return spot;
    }
    return first;
  }

  buildBoard(e) {
    const g = new THREE.Group();
    g.name = 'bus-race-board';
    const gltf = this.models?.job_board;
    let faceZ = 0.05, beamZ = 0.05;
    if (gltf?.scene) {
      const m = fitModel(gltf, { size: 2.6, axis: 'y' });
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.add(m);
      m.updateMatrixWorld(true);
      const hit = (y) => new THREE.Raycaster(new THREE.Vector3(0, y, 3), new THREE.Vector3(0, 0, -1), 0, 6).intersectObject(m, true)[0];
      const hb = hit(2.0), hf = hit(1.45);
      beamZ = hb ? hb.point.z + 0.015 : 0.2;
      faceZ = hf ? hf.point.z + 0.02 : 0.2;
    } else {
      const wood = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 });
      for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.3, 0.1), wood); p.position.set(s * 0.8, 1.15, 0); g.add(p); }
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.62, 1.2, 0.06), wood);
      panel.position.set(0, 1.5, 0); g.add(panel);
    }
    const sign = (tex, w, h, y, z) => {
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.08 });
      mat.userData.isSign = true;
      const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      s.position.set(0, y, z);
      s.receiveShadow = true;
      g.add(s);
    };
    sign(headerTex(), 0.98, 0.3, 2.0, beamZ);
    sign(posterTex(e), 1.26, 0.84, 1.45, faceZ);
    const red = gateFlag(0xd8231a), blue = gateFlag(0x1f55e0);
    red.position.set(-1.45, 0, 0.3); red.rotation.y = 0.5;
    blue.position.set(1.45, 0, 0.3); blue.rotation.y = Math.PI - 0.5;
    g.add(red, blue);
    return g;
  }

  /** Build / drop the course meshes by distance (twice a second). The course of a running race stays. */
  update(dt, player, modes = null) {
    try {
      this.t -= dt;
      if (this.t > 0) return;
      this.t = 0.5;
      if (!player) return;
      const p = player.pos, racing = modes?.course || null;
      let built = false;
      for (const e of this.list) {
        let d = Infinity;
        for (const q of e.pts) d = Math.min(d, Math.hypot(q[0] - p.x, q[1] - p.z));
        if (e.board) d = Math.min(d, Math.hypot(e.board.x - p.x, e.board.z - p.z));
        e.d = d;
        if (e.course === racing) continue;
        if (d > DROP_D && e.course.group) e.course.dispose();
        else if (!built && d < BUILD_D && !e.course.group) { e.course.build(this.scene, this.models); built = true; } // (one a tick)
      }
    } catch (err) {
      if (!this.warned) { this.warned = true; console.warn('Bus races: update failed', err); }
    }
  }

  /** Where E races: in front of a race board ({ e, at: 'board' }) or at a start gate ({ e, at: 'start' }), or null. */
  near(p) {
    for (const e of this.list) {
      const f = e.board?.front;
      if (f && Math.hypot(p.x - f.x, p.z - f.z) < READ_R) return { e, at: 'board' };
      const s = e.start;
      if (Math.abs(p.x - s.x) < START_R && Math.abs(p.z - s.z) < START_R && Math.hypot(p.x - s.x, p.z - s.z) < START_R && Math.abs((p.y ?? s.y) - s.y) < 12) return { e, at: 'start' };
    }
    return null;
  }

  /** In front of the race board, facing it (else the start); no longer used after a race (Oct 30 2026: you stay put). */
  homeOf(e) {
    const b = e.board;
    if (!b) return { x: e.start.x, z: e.start.z, heading: e.start.heading };
    return { x: b.x + Math.sin(b.yaw) * 2.2, z: b.z + Math.cos(b.yaw) * 2.2, heading: b.yaw + Math.PI };
  }

  /** The bus race starting at this stop (by name), or null. */
  atStop(name) { return this.list.find((e) => e.stop === name) || null; }
  /** Prize money for a finish (see busracedefs.js). */
  prize(e, r, field = 15) { return busRacePrize(e.def, { ...r, field }); }
}
