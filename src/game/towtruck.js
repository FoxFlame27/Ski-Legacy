// The tow truck (the user's 1967 Mercedes-Benz 508 D recovery truck, public/models/tow_truck.glb). It waits in the
// CAR RENTAL's yard; when a rental car is wrecked it drives out over the real roads (the bus roads and access roads as
// one graph, shortest way, in the right-hand lane), amber beacons flashing, stops at the road point nearest the wreck,
// winches it to the road if it lies off it, lifts the EXACT car (the same object: model, paint, smoke) onto its bed,
// and drives back with it riding on the back; in the yard the wreck is taken off and the truck parks.
// The model: ~6.6 m long, its nose (the grille) at z -6.25 and its origin at the bed's tail; re-centred, turned nose to +z (the
// bed, the beacons on the cab roof and the car riding on the deck all in that frame) and scaled up so
// the bed (4.5 m in the model) takes the longest car (the RS6, 5.0 m) without touching the cab.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { busRoads, ROAD_HALF } from './bus/roads.js';
import { addTrafficBlocker, addTrafficZone, inZone } from './traffic.js';

const RAW = { cx: 0.926, cz: -3.236, bed0: -4.45, bed1: 0.05, deck: 1.07 }; // model: centre, bed z range, deck height
const BED_FIT = 5.25;                                // m of bed wanted (the RS6 plus a little)
export const TRUCK_SCALE = BED_FIT / (RAW.bed1 - RAW.bed0); // ~1.17: 7.7 m long, 2.7 m wide, 2.85 m tall
const S = TRUCK_SCALE;
// in the truck's frame (+z its nose, y up from the road): the bed's middle and the deck's height, half length / width
const BED = { z: (RAW.cz - (RAW.bed0 + RAW.bed1) / 2) * S, y: RAW.deck * S + 0.02 };
const HALF_L = 3.3 * S, HALF_W = 1.17 * S;
const LANE = 1.6, V_ROAD = 13, LOOK = 7, WHEELBASE = 4.2 * S;
const R_MIN = WHEELBASE / Math.tan(0.6); // (max steering ~34 degrees)
// (Oct 29, the user: "make sure cars keep enough distance when a car is wrecked, so the tow truck can pick up the car
// without passing through other cars"): the truck's box (7.7 x 2.7 m, the car on its bed inside it) is swept along
// the way it will actually drive (its own steering, predicted metre by metre) against every car (traffic, parked,
// wrecks, yours, the bus): it stops STOP_GAP m short of anything in its way; held up, it overtakes in the other lane
// only when that is clear all the way past the queue and 40 m on (and reserves it: oncoming cars wait); the job
// reserves the road round the wreck and its stopping spot (traffic.js addTrafficZone: both lanes, 25 m either side)
const STOP_GAP = 4, MW = 0.35, ML = 0.5, PASS_OFF = LANE * 2, ZONE_PAD = 25, LOOK_PASS = 3.5, V_PASS = 9;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// two boxes overlap? a: centre, yaw (+z its nose: forward (sin, cos)), half width / length; b: { x, z, yaw, hw, hd }
export function obb(ax, az, ay, ahw, ahd, b) {
  const dx = b.x - ax, dz = b.z - az, sa = Math.sin(ay), ca = Math.cos(ay), sb = Math.sin(b.yaw), cb = Math.cos(b.yaw);
  for (const [ux, uz] of [[sa, ca], [ca, -sa], [sb, cb], [cb, -sb]]) {
    const pa = ahd * Math.abs(sa * ux + ca * uz) + ahw * Math.abs(ca * ux - sa * uz);
    const pb = b.hd * Math.abs(sb * ux + cb * uz) + b.hw * Math.abs(cb * ux - sb * uz);
    if (Math.abs(dx * ux + dz * uz) > pa + pb) return false;
  }
  return true;
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

// ------------------------------------------------------------------ the road graph (built once)
// every road point a node; along each road its neighbours; points of different roads within 7 m joined (junctions,
// a stop where two roads meet). Shortest path: Dijkstra with a binary heap.
let G = null;
function graph() {
  if (G && G.n === busRoads.roads.length) return G;
  const X = [], Z = [], adj = [], at = [];
  busRoads.roads.forEach((r, ri) => {
    const base = X.length;
    for (let i = 0; i < r.n; i++) { X.push(r.X[i]); Z.push(r.Z[i]); adj.push([]); at.push([ri, i]); if (i) { adj[base + i].push(base + i - 1); adj[base + i - 1].push(base + i); } }
  });
  const N = X.length;
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) if (at[a][0] !== at[b][0] && Math.abs(X[a] - X[b]) < 7 && Math.abs(Z[a] - Z[b]) < 7 && Math.hypot(X[a] - X[b], Z[a] - Z[b]) < 7) { adj[a].push(b); adj[b].push(a); }
  G = { n: busRoads.roads.length, X, Z, adj, N };
  return G;
}
function nearestNode(x, z) {
  const g = graph();
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.N; i++) { const d = (g.X[i] - x) ** 2 + (g.Z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return { i: best, d: Math.sqrt(bd) };
}
function shortest(a, b) {
  const g = graph(), dist = new Float64Array(g.N).fill(Infinity), prev = new Int32Array(g.N).fill(-1), heap = [[0, a]];
  dist[a] = 0;
  while (heap.length) {
    // pop the smallest (a plain binary heap)
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } }
    const [d, u] = top;
    if (d > dist[u]) continue;
    if (u === b) break;
    for (const v of g.adj[u]) {
      const nd = d + Math.hypot(g.X[u] - g.X[v], g.Z[u] - g.Z[v]);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heap.push([nd, v]); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } }
    }
  }
  if (a !== b && prev[b] < 0) return null;
  const out = [];
  for (let u = b; u >= 0; u = prev[u]) { out.push(u); if (u === a) break; }
  return out.reverse();
}
const pts = (ids) => ids.map((i) => ({ x: G.X[i], z: G.Z[i], road: true }));
// carry on along the road past the last node (the way it was going) for `m` metres: the truck pulls up beyond the
// wreck, so it has the car behind it, at its bed's tail
function extend(ids, m) {
  const g = graph(), out = ids.slice();
  if (out.length < 2) return out;
  let acc = 0;
  for (let guard = 0; guard < 40 && acc < m; guard++) {
    const u = out[out.length - 1], p = out[out.length - 2], dx = g.X[u] - g.X[p], dz = g.Z[u] - g.Z[p], l = Math.hypot(dx, dz) || 1;
    let best = -1, bd = 0.5;
    for (const v of g.adj[u]) { if (out.includes(v)) continue; const ex = g.X[v] - g.X[u], ez = g.Z[v] - g.Z[u], el = Math.hypot(ex, ez) || 1, d = (ex * dx + ez * dz) / (el * l); if (d > bd) { bd = d; best = v; } }
    if (best < 0) break;
    acc += Math.hypot(g.X[best] - g.X[u], g.Z[best] - g.Z[u]);
    out.push(best);
  }
  return out;
}
// a road path in the right-hand lane: each point moved LANE m to the right of the way it runs (yard points stay)
function keepRight(path) {
  return path.map((p, k) => {
    if (!p.road) return p;
    const a = path[Math.max(0, k - 2)], b = path[Math.min(path.length - 1, k + 2)];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { x: p.x - (dz / l) * LANE, z: p.z + (dx / l) * LANE, road: true };
  });
}

// the cab roof in the truck's frame (g at the origin, unturned): down-rays along the middle over the front half find
// the highest part (the cab: the bed and the crane are lower), its middle is where the lamps go; at(x): the roof's
// height across it there (null off the model)
function findRoof(g) {
  g.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), o = new THREE.Vector3();
  const hitY = (x, z) => { ray.set(o.set(x, 20, z), down); const h = ray.intersectObject(g, true).find((i) => i.object.isMesh); return h ? h.point.y : null; };
  const zs = [];
  for (let z = BED.z + 2.9 * S; z <= HALF_L; z += 0.05) { const y = hitY(0, z); if (y !== null) zs.push([z, y]); }
  if (!zs.length) return null;
  const top = Math.max(...zs.map((p) => p[1]));
  // the roof's flat top: the samples within 6 cm of the highest (a run of them, not a single antenna / mirror)
  const flat = zs.filter((p) => p[1] > top - 0.06);
  if (flat.length < 4) { const sorted = zs.map((p) => p[1]).sort((a, b) => b - a); const y2 = sorted[Math.min(sorted.length - 1, 8)]; flat.splice(0, flat.length, ...zs.filter((p) => p[1] > y2 - 0.06)); }
  const z = (Math.min(...flat.map((p) => p[0])) + Math.max(...flat.map((p) => p[0]))) / 2;
  const y = hitY(0, z) ?? top;
  return { z, y, at: (x) => hitY(x, z) };
}

// ------------------------------------------------------------------ the model (shared with net/vehicles.js)
/** The truck's model (nose +z, origin on the road under its middle), its amber beacons on the cab roof and their glow:
 *  { g, beacons, beaconMat, beaconLight }. A plain flatbed when the glTF is missing. */
export function buildTowTruck(models) {
  const g = new THREE.Group();
  g.name = 'tow-truck';
  const gltf = models?.tow_truck;
  if (gltf) {
    const m = gltf.scene.clone(true);
    m.rotation.y = Math.PI; // (nose to +z)
    m.position.set(RAW.cx, 0, RAW.cz); // (re-centred: the model runs nose -z from its origin at the bed's tail; turned, its centre (-cx, -cz) back to 0)
    const s = new THREE.Group(); s.scale.setScalar(S); s.add(m);
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.add(s);
  } else { // (no model: a plain flatbed so the job still runs)
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8a21a, roughness: 0.5 });
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.2), mat); cab.position.set(0, 1.5, HALF_L - 1.2);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.25, 5.4), new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7 })); bed.position.set(0, BED.y - 0.12, BED.z);
    g.add(cab, bed);
  }
  // amber beacons on the cab roof (a pair) and their glow
  const beaconMat = new THREE.MeshStandardMaterial({ color: 0xffa21a, emissive: 0xff8a00, emissiveIntensity: 0, roughness: 0.3, transparent: true, opacity: 0.92 });
  const beacons = [];
  // (Oct 28, the user: "the lights on the towing machine are floating": the roof was a guessed constant; now it is
  // found on the model itself: rays straight down onto the cab, the roof's highest flat stretch, each lamp sat on it)
  const roof = gltf ? findRoof(g) : null;
  const roofZ = roof ? roof.z : HALF_L - 1.55 * S;
  const roofY = roof ? roof.y : 2.44 * S;
  for (const sx of [-0.62, 0.62]) {
    const y = (roof && roof.at(sx)) ?? roofY;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.05, 14), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }));
    base.position.set(sx, y + 0.02, roofZ);
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.16, 14), beaconMat);
    dome.position.set(sx, y + 0.12, roofZ);
    g.add(base, dome);
    beacons.push(dome);
  }
  const beaconLight = new THREE.PointLight(0xffa020, 0, 14, 2);
  beaconLight.position.set(0, roofY + 0.4, roofZ);
  g.add(beaconLight);
  return { g, beacons, beaconMat, beaconLight };
}
/** The beacons flashing (on a job) or dark: m from buildTowTruck, t a running time in s. */
export function beaconsOn(m, on, t) {
  m.beaconMat.emissiveIntensity = on ? 1.5 + 2.5 * Math.max(0, Math.sin(t * 7.5)) : 0;
  m.beaconLight.intensity = on ? 6 * Math.max(0, Math.sin(t * 7.5)) ** 2 : 0;
}
/** The truck's group on the road at (x, z) facing yaw: its height, pitch and roll from the ground under its wheels. */
export function groundPose(g, x, z, yaw) {
  const s = Math.sin(yaw), c = Math.cos(yaw), h = (lx, lz) => world.height(x + s * lz + c * lx, z + c * lz - s * lx);
  const f = h(0, HALF_L - 1.2), b = h(0, -HALF_L + 1.6), l = h(1, 0), r = h(-1, 0);
  const y = (f + b) / 2;
  const pitch = -Math.atan2(f - b, HALF_L * 2 - 2.8), roll = Math.atan2(l - r, 2);
  g.position.set(x, y + 0.02, z);
  _e.set(pitch, yaw, roll * 0.5);
  g.quaternion.setFromEuler(_e);
  g.updateMatrixWorld(true);
}
/** Where a car `len` m long rides on the bed, in the truck's frame (centred on the bed, its middle over the bed's). */
export function bedLocal(len, out) { return out.set(0, BED.y, BED.z + Math.max(0, (BED_FIT - (len || 4.6)) / 2 - 0.15)); }
export const TOW_HALF = { w: HALF_W, l: HALF_L };

export class TowTruck {
  /**
   * @param {object} o
   * @param {{x,z,yaw}} o.park   its spot in the yard (yaw: the way its nose points)
   * @param {{x,z}[]} o.yardOut  the way out of the yard to the road (from the spot, ending on the road's edge)
   * @param {{x,z}[]} [o.yardIn] the way back in (from the road's edge, ending short of the spot: it drives into its
   *   bay nose first, square, never turning round in it); else yardOut backwards
   */
  constructor({ scene, models, colliders, camera, park, yardOut, yardIn = null, traffic = null, audio = null }) {
    Object.assign(this, { scene, colliders, camera, park, yardOut, yardIn: yardIn || yardOut.slice().reverse(), traffic, audio });
    this.jobs = []; // wrecks waiting: { e (the parking entry), onDone }
    this.job = null;
    this.state = 'parked';
    this.mp = null; // multiplayer (net/tow.js): { others(add) }: the other players on foot in its way
    // the model, its beacons and their glow (buildTowTruck: also net/vehicles.js, the other players' trucks)
    Object.assign(this, buildTowTruck(models));
    // the winch cable (a thin line from the bed's tail to the car while it pulls)
    this.cable = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 5), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.6 }));
    this.cable.visible = false;
    scene.add(this.cable);
    scene.add(this.g);
    // pose: x, z, yaw; solid (a moving box collider), and the traffic brakes for it
    this.x = park.x; this.z = park.z; this.yaw = park.yaw; this.v = 0;
    this.collider = { x: this.x, z: this.z, hw: HALF_W, hd: HALF_L, rot: -this.yaw, h: 2.8 };
    colliders.push(this.collider);
    this.box = { hw: HALF_W + 0.1, hd: HALF_L + 0.2 }; // (the truck and the car on its bed: the bed lies within it)
    try { addTrafficBlocker((out) => { this.box.x = this.x; this.box.y = this.g.position.y; this.box.z = this.z; this.box.yaw = this.yaw; out.push(this.box); }); } catch { /* (no traffic) */ }
    this.place(0);
  }

  get busy() { return !!this.job || this.jobs.length > 0; }

  /** A wrecked car to fetch (drive.js parking entry); onDone() once it's off the truck in the yard. */
  fetch(e, onDone) {
    if (this.job?.e === e || this.jobs.some((j) => j.e === e)) return;
    e.wrecked && (e.wrecked.tow = true); // (drive.js: the truck fetches it, no vanishing)
    this.jobs.push({ e, onDone });
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    if (dt <= 0) return;
    try {
      this.t = (this.t || 0) + dt;
      if (!this.job && this.jobs.length) this.start(this.jobs.shift());
      const j = this.job;
      if (j) this.step(j, dt);
      this.place(dt);
      if (j && j.onBed) this.carToBed(j.e);
      // the beacons: two rotating lamps, out of step, while on a job
      beaconsOn(this, !!j, this.t);
    } catch (err) { console.warn('tow truck', err); if (this.job) this.free(this.job); this.job = null; }
  }

  start(j) {
    this.job = j;
    const e = j.e, c = e.car.position;
    const from = nearestNode(this.yardOut[this.yardOut.length - 1].x, this.yardOut[this.yardOut.length - 1].z);
    const to = nearestNode(c.x, c.z);
    const ids = (from.i >= 0 && to.i >= 0 && shortest(from.i, to.i)) || [];
    const road = pts(extend(ids, HALF_L + 4));
    // out of its bay: backwards to the first yard point (it parks nose in), then forward round to the road
    j.path = [...this.yardOut.slice(1), ...keepRight(road)];
    j.k = 0; j.phase = 'backout'; j.held = 0; j.stuck = 0; j.pass = null;
    this.state = 'out';
    // the road the job needs, reserved (both lanes and the shoulders): from 25 m before the wreck's road point to 25 m
    // beyond where the truck stops; traffic queues 12 m short of it, the cars in it are taken off
    try {
      const g = graph(), far = extend(ids, HALF_L + 4 + ZONE_PAD);
      let a = ids.length - 1;
      for (let acc = 0; a > 0 && acc < ZONE_PAD; a--) acc += Math.hypot(g.X[ids[a]] - g.X[ids[a - 1]], g.Z[ids[a]] - g.Z[ids[a - 1]]);
      const zp = far.slice(Math.max(0, a)).map((i) => ({ x: g.X[i], z: g.Z[i] }));
      if (!zp.length) zp.push({ x: c.x, z: c.z });
      j.zone = { pts: zp, hw: ROAD_HALF + 1.6, gap: 12, evict: true };
      j.unzone = addTrafficZone(j.zone);
    } catch (err) { console.warn('tow truck: zone', err); }
  }
  // the job's reserved road and the overtaking lane freed
  free(j) {
    try { j.unzone?.(); } catch { /* */ }
    j.unzone = null;
    this.endPass(j);
  }

  // the pursuit target at path point k, `off` m to the left of the way the path runs there (overtaking)
  target(P, k, off) {
    const p = P[k];
    if (!off) return p;
    const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dz / l) * off, z: p.z - (dx / l) * off };
  }
  // the pursuit target: the point of the path `look` m from (x, z) (from about point k on), `off` m left of it
  // (overtaking: a shorter look, so it pulls out within a few metres from standing behind a queue)
  aim(P, k, off, x, z, look) {
    if (off && P.length > 1) { // (measured from its place on the offset line: the path point beside it)
      const a = P[Math.max(0, k - 1)], b = P[Math.max(1, k)], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      x -= (dz / l) * off; z += (dx / l) * off;
    }
    for (let i = Math.max(1, k - 2); i < P.length; i++) {
      const a = P[i - 1], b = P[i];
      if (Math.hypot(b.x - x, b.z - z) < look) continue;
      const ex = b.x - a.x, ez = b.z - a.z, fx = a.x - x, fz = a.z - z, ee = ex * ex + ez * ez || 1e-9, fe = fx * ex + fz * ez;
      const t = clamp((-fe + Math.sqrt(Math.max(0, fe * fe - ee * (fx * fx + fz * fz - look * look)))) / ee, 0, 1), l = Math.sqrt(ee);
      return { x: a.x + ex * t + (ez / l) * off, z: a.z + ez * t - (ex / l) * off };
    }
    return this.target(P, P.length - 1, off);
  }
  // where it will drive: its own steering (as follow() does it) run on metre by metre from where it is, `off(s)` m
  // left of the path s m on; [{ x, z, yaw, s }]
  predict(j, off, dist) {
    const P = j.path, out = [{ x: this.x, z: this.z, yaw: this.yaw, s: 0 }];
    let x = this.x, z = this.z, yaw = this.yaw, k = j.k;
    const DS = 0.25; // (in quarter metres, as it moves frame by frame; a pose each metre)
    for (let s = 1; s <= dist; s++) {
      const o = off(s), e = this.target(P, P.length - 1, o);
      let there = false;
      for (let q = 0; q < 1 / DS && !there; q++) {
        while (k < P.length - 1 && Math.hypot(P[k].x - x, P[k].z - z) < LOOK) k++;
        const t = this.aim(P, k, o, x, z, o ? LOOK_PASS : LOOK);
        if (Math.hypot(t.x - x, t.z - z) > 2.5) yaw = wrapPi(yaw + clamp(wrapPi(Math.atan2(t.x - x, t.z - z) - yaw), -3 / R_MIN * DS, 3 / R_MIN * DS));
        x += Math.sin(yaw) * DS; z += Math.cos(yaw) * DS;
        there = k >= P.length - 1 && Math.hypot(e.x - x, e.z - z) < 1.2;
      }
      out.push({ x, z, yaw, s });
      if (there) break; // (there)
    }
    return out;
  }
  // everything it must not drive into: the traffic, the parked cars and wrecks (the one it fetches only on the way out:
  // it pulls up past it), the car you drive (or you on foot), the bus; { x, z, yaw, hw, hd, ref, kind }
  obstacles(j, R = 180) {
    const out = [], T = this.traffic, x0 = this.x, z0 = this.z;
    const add = (x, z, yaw, hw, hd, ref, kind) => { if (Math.abs(x - x0) < R && Math.abs(z - z0) < R) out.push({ x, z, yaw, hw, hd, ref, kind }); };
    for (const c of T?.cars || []) if (c.mode !== 'gone' && c.sinkT === undefined) add(c.x, c.z, c.yaw, c.w / 2, c.l / 2, c, 'traffic');
    for (const e of T?.parking?.cars || []) {
      if (e.driving || !e.car?.parent || (e === j?.e && j.phase !== 'out')) continue;
      _v.set(0, 0, 1).applyQuaternion(e.car.quaternion); // (its heading: a wreck may lie rolled, rotation.y is not its yaw then)
      add(e.car.position.x, e.car.position.z, Math.atan2(_v.x, _v.z), 1.0, (e.length || 4.6) / 2, e, 'parked');
    }
    const d = T?.you?.d, p = T?.player?.pos;
    if (d) add(d.x, d.z, d.yaw, (d.w || 1.9) / 2, d.half || 2.3, null, 'you');
    else if (p) add(p.x, p.z, 0, 0.45, 0.45, null, 'you');
    const line = T?.skibus?.line, bus = line?.bus?.group;
    if (bus?.visible) add(bus.position.x, bus.position.z, line.yaw || 0, 1.3, 6, null, 'bus');
    // multiplayer (traffic is off): the other players' cars (their box colliders in the shared list, mp: true; not
    // their tow trucks: each player's truck serves only its owner's car and ignores the others') and the players
    // themselves (net/tow.js hooks)
    for (const c of this.colliders) if (c.mp && !c.tow && c.x < 1e8) add(c.x, c.z, -(c.rot || 0), c.hw ?? c.r ?? 1, c.hd ?? c.r ?? 1, c, 'mp');
    try { this.mp?.others?.(add); } catch { /* */ }
    return out;
  }
  // the first pose (s) at which its box (plus margins) would overlap something: { s, o } or null
  firstHit(poses, obs, mw = MW, ml = ML) {
    if (!obs.length) return null;
    const last = poses[poses.length - 1], reach = (last?.s || 0) + HALF_L + 10;
    const near = obs.filter((o) => Math.abs(o.x - this.x) < reach + o.hd && Math.abs(o.z - this.z) < reach + o.hd);
    for (const p of poses) for (const o of near) if (obb(p.x, p.z, p.yaw, HALF_W + mw, HALF_L + ml, o)) return { s: p.s, o };
    return null;
  }
  // along poses: each thing it would overlap, from (sIn) and to (sOut) where
  ranges(poses, obs) {
    const out = new Map();
    for (const p of poses) for (const o of obs) if (obb(p.x, p.z, p.yaw, HALF_W + MW, HALF_L + ML, o)) { const r = out.get(o); if (r) r.sOut = p.s; else out.set(o, { sIn: p.s, sOut: p.s, ref: o.ref }); }
    return [...out.values()];
  }
  // held up behind a queue: out into the other lane, only when it is clear past the last car of the queue and 40 m on
  tryPass(j, obs) {
    const P = j.path;
    let rem = Math.hypot(P[j.k].x - this.x, P[j.k].z - this.z);
    for (let i = j.k + 1; i < P.length; i++) rem += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    if (rem < 8) return false; // (round the wreck it fetches, too, when that stands in its lane: it pulls up past it)
    const rg = this.ranges(this.predict(j, () => 0, Math.min(rem, 170)), obs).sort((a, b) => a.sIn - b.sIn);
    if (!rg.length || rg[0].sIn > STOP_GAP + 8) return false;
    let end = rg[0].sOut;
    for (const r of rg) { if (r.sIn > end + 20) break; end = Math.max(end, r.sOut); }
    const len = Math.min(rem, end + 6);
    // (the other lane's line; round the wreck it fetches, if that lies across the lane, a little wider: the shoulder)
    const offs = rg[0].ref === j.e ? [PASS_OFF, PASS_OFF + 0.8] : [PASS_OFF];
    const off = offs.find((o) => !this.firstHit(this.predict(j, () => o, Math.min(rem + 10, len + 40)), obs));
    if (off === undefined) return false;
    j.pass = { s: 0, len, off };
    this.reserve(j);
    return true;
  }
  // the other lane it overtakes in, reserved (traffic.js zone: oncoming cars stop short of it)
  reserve(j) {
    const ps = j.pass;
    if (!ps) return;
    try { ps.res?.(); } catch { /* */ }
    const poses = this.predict(j, () => ps.off, ps.len - ps.s + 15);
    const zp = poses.filter((p, i) => i % 3 === 0 || i === poses.length - 1).map((p) => ({ x: p.x, z: p.z }));
    ps.res = addTrafficZone({ pts: zp, hw: 2.0, gap: 5 });
  }
  endPass(j) {
    try { j.pass?.res?.(); } catch { /* */ }
    j.pass = null;
  }

  // follow j.path (pure pursuit, limited steering, slower in bends and near the end); true once at its end
  follow(j, dt, vmax) {
    const P = j.path;
    while (j.k < P.length - 1 && Math.hypot(P[j.k].x - this.x, P[j.k].z - this.z) < LOOK) j.k++;
    // overtaking (Oct 28, the user: "the towing truck gets stuck when there's too many cars because of the crash"): held
    // up 2 s on the road, it pulls out into the other lane if that is clear (tryPass), beacons on, and back in past them
    const ps = j.pass;
    const offAt = ps ? (s) => (ps.s + s < ps.len ? ps.off : 0) : () => 0;
    const off = offAt(0), tgt = this.aim(P, j.k, off, this.x, this.z, off ? LOOK_PASS : LOOK), endT = this.target(P, P.length - 1, off);
    const left = Math.hypot(endT.x - this.x, endT.z - this.z);
    const want = Math.atan2(tgt.x - this.x, tgt.z - this.z), err = wrapPi(want - this.yaw);
    let v = Math.min(ps ? Math.min(vmax, V_PASS) : vmax, j.k >= P.length - 1 ? Math.max(1.2, left * 0.9) : vmax);
    v *= clamp(1.15 - Math.abs(err) * 1.1, 0.25, 1);
    // anything in its way: its box swept along where it will drive; it stops STOP_GAP m short
    const obs = this.obstacles(j), look = Math.max(16, this.v * this.v / 5 + STOP_GAP + 8);
    let hit = this.firstHit(this.predict(j, offAt, look), obs);
    if (ps && hit && ps.s + look > ps.len) {
      // (still a car in its lane where it would pull back in: on in the other lane past it, if that is clear)
      const alt = this.firstHit(this.predict(j, () => ps.off, look), obs);
      if (!alt || alt.s > hit.s + 1) { ps.len = Math.max(ps.len, ps.s + hit.s + HALF_L * 2 + 8); this.reserve(j); hit = alt; }
    }
    let blocked = false;
    if (hit) { const cap = Math.sqrt(7 * Math.max(0, hit.s - STOP_GAP)); if (cap < v) { v = cap; blocked = cap < 1; } }
    j.held = blocked ? (j.held || 0) + dt : Math.max(0, (j.held || 0) - dt * 2);
    j.stuck = blocked && Math.abs(this.v) < 0.3 ? (j.stuck || 0) + dt : 0;
    if (!ps && j.held > 2 && P[j.k].road) { j.held = 1; this.tryPass(j, obs); } // (else: tries again in a second)
    // (boxed in for 25 s by a traffic car that won't move (a queue that can't clear): that car is taken off)
    if (j.stuck > 25 && hit?.o.kind === 'traffic') { this.traffic?.evict?.(hit.o.ref); j.stuck = 15; }
    // (the wreck it fetches lies across the whole road, no way past it: it winches it from where it stands)
    if (j.stuck > 10 && hit?.o.ref === j.e && j.phase === 'out') return true;
    if (ps) { ps.s += Math.max(0, this.v) * dt; if (ps.s > ps.len + 12) this.endPass(j); }
    this.v += clamp(v - this.v, -6 * dt, 2.2 * dt);
    // (it turns as it rolls, at most 3 / R_MIN per metre: the same as predict(), so it goes where it checked)
    const turn = Math.hypot(tgt.x - this.x, tgt.z - this.z) > 2.5 ? 3 / R_MIN * Math.abs(this.v) * dt : 0; // (pulling up on its spot: straight on)
    this.yaw = wrapPi(this.yaw + clamp(err, -turn, turn));
    this.x += Math.sin(this.yaw) * this.v * dt; this.z += Math.cos(this.yaw) * this.v * dt;
    return j.k >= P.length - 1 && left < 1.2;
  }

  step(j, dt) {
    const e = j.e, g = e.car;
    if (!g.parent) { this.finish(j); return; } // (the car was taken away meanwhile)
    if (j.phase === 'backout') {
      const b = this.yardOut[0], fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), f = (b.x - this.x) * fx + (b.z - this.z) * fz;
      // (nothing behind it: its box 1.5 m back clear)
      const clear = !this.firstHit([{ x: this.x - fx * 1.5, z: this.z - fz * 1.5, yaw: this.yaw, s: 0 }], this.obstacles(j, 30), 0.2, 0.3);
      this.v += clamp((f < -0.6 && clear ? -2.4 : 0) - this.v, -2.5 * dt, 2.5 * dt);
      this.x += Math.sin(this.yaw) * this.v * dt; this.z += Math.cos(this.yaw) * this.v * dt;
      if (f >= -0.6 && Math.abs(this.v) < 0.1) { this.v = 0; j.phase = 'out'; }
    } else if (j.phase === 'out') {
      if (j.zone) j.zone.urgent = inZone(j.zone, this.x, this.z, 120); // (close: the cars standing in it go at once)
      if (this.follow(j, dt, V_ROAD)) { j.phase = 'reach'; this.v = 0; this.endPass(j); }
    } else if (j.phase === 'reach') {
      // the car at the bed's tail: winch it there over the snow (it slides, turning in line), unless it's close already
      const tail = this.local(0, BED.z - BED_FIT / 2 - 2.6);
      const dx = tail.x - g.position.x, dz = tail.z - g.position.z, d = Math.hypot(dx, dz);
      const seen = this.inView(g.position);
      if (d > 30 && !seen) { g.position.x = tail.x - dx / d * 6; g.position.z = tail.z - dz / d * 6; } // (far off the road and unseen: brought close)
      // (never through the truck: a car beside or ahead of it goes round its side first, then back to the tail)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), rx = g.position.x - this.x, rz = g.position.z - this.z;
      const lx = rx * cy - rz * sy, lz = rx * sy + rz * cy, side = lx >= 0 ? 1 : -1, wide = HALF_W + (e.length || 4.6) / 2 + 0.4;
      let via = tail;
      if (lz > -HALF_L - 2) via = Math.abs(lx) < wide - 0.3 ? this.local(side * wide, lz) : this.local(side * wide, -HALF_L - 3);
      const vx = via.x - g.position.x, vz = via.z - g.position.z, vd = Math.hypot(vx, vz) || 1;
      if (d > 1.5) {
        const step = Math.min(via === tail ? d - 1.4 : vd, 2.2 * dt);
        g.position.x += vx / vd * step; g.position.z += vz / vd * step;
        g.position.y = world.height(g.position.x, g.position.z) + 0.03;
        g.updateMatrixWorld(true);
        this.drawCable(tail, g.position);
      } else { this.cable.visible = false; j.phase = 'load'; j.lt = 0; j.from = { p: g.position.clone(), q: g.quaternion.clone() }; }
      this.syncCollider(e);
    } else if (j.phase === 'load') {
      // lifted up and onto the bed (an arc), turned in line with the truck and set upright (its damage stays)
      j.lt += dt / 3.2;
      const k = THREE.MathUtils.smoothstep(j.lt, 0, 1);
      const bed = this.bedPose(e);
      g.position.lerpVectors(j.from.p, bed.p, k);
      g.position.y += Math.sin(k * Math.PI) * 1.4;
      g.quaternion.slerpQuaternions(j.from.q, bed.q, k);
      g.updateMatrixWorld(true);
      e.collider.x = 1e9; e.collider.z = 1e9; // (no collider while on the truck: it rides along)
      if (j.lt >= 1) {
        j.onBed = true; j.phase = 'back';
        const from = nearestNode(this.x, this.z), to = nearestNode(this.yardIn[0].x, this.yardIn[0].z);
        const road = pts((from.i >= 0 && to.i >= 0 && shortest(from.i, to.i)) || []);
        // (home: the road to the yard, in, and on to a point just past its spot: it pulls straight into the bay)
        const f = { x: Math.sin(this.park.yaw), z: Math.cos(this.park.yaw) };
        j.path = [{ x: this.x, z: this.z }, ...keepRight(road), ...this.yardIn, { x: this.park.x, z: this.park.z }, { x: this.park.x + f.x * 0.5, z: this.park.z + f.z * 0.5 }];
        j.k = 0; j.held = 0; j.stuck = 0;
      }
    } else if (j.phase === 'back') {
      // (the reserved road freed once it is well clear of it)
      if (j.unzone && !inZone(j.zone, this.x, this.z, HALF_L + 6)) { j.unzone(); j.unzone = null; }
      if (this.follow(j, dt, V_ROAD)) { j.phase = 'unload'; j.ut = 0; this.v = 0; this.free(j); }
    } else if (j.phase === 'unload') {
      // parked in the yard: turn straight into its spot, then the wreck is taken off (out of sight, or after a while)
      this.yaw += wrapPi(this.park.yaw - this.yaw) * Math.min(1, dt * 1.2);
      this.x += (this.park.x - this.x) * Math.min(1, dt * 1.2); this.z += (this.park.z - this.z) * Math.min(1, dt * 1.2);
      j.ut += dt;
      if ((j.ut > 2 && !this.inView(g.position)) || j.ut > 14) this.finish(j);
    }
  }

  finish(j) {
    this.free(j);
    this.cable.visible = false;
    this.job = null;
    this.state = 'parked';
    try { j.onDone?.(j.e); } catch (err) { console.warn('tow truck: done', err); }
  }

  // ------------------------------------------------------------------ helpers
  local(lx, lz) { const s = Math.sin(this.yaw), c = Math.cos(this.yaw); return { x: this.x + s * lz + c * lx, z: this.z + c * lz - s * lx }; }
  inView(p) {
    const cam = this.camera.position, dx = p.x - cam.x, dz = p.z - cam.z, d = Math.hypot(dx, dz);
    if (d < 45) return true;
    const f = this.camera.getWorldDirection(_v);
    return d < 500 && (dx * f.x + dz * f.z) / d > 0.3;
  }
  // the car's place on the bed: centred on it (its middle over the bed's), upright, nose forward
  bedPose(e) {
    this.g.updateMatrixWorld(true);
    const p = bedLocal(e.length, new THREE.Vector3()).applyMatrix4(this.g.matrixWorld);
    return { p, q: this.g.quaternion.clone() };
  }
  carToBed(e) {
    const b = this.bedPose(e), g = e.car;
    g.position.copy(b.p); g.quaternion.copy(b.q); g.updateMatrixWorld(true);
  }
  syncCollider(e) { const g = e.car; e.collider.x = g.position.x; e.collider.z = g.position.z; e.collider.rot = -g.rotation.y; }
  drawCable(a, b) {
    const ay = world.height(a.x, a.z) + BED.y - 0.2, by = b.y + 0.45;
    const A = _v.set(a.x, ay, a.z), B = new THREE.Vector3(b.x, by, b.z), len = A.distanceTo(B);
    this.cable.visible = true;
    this.cable.position.copy(A).add(B).multiplyScalar(0.5);
    this.cable.scale.set(1, len, 1);
    this.cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.sub(A).normalize());
  }
  // on the road: its height and its pitch / roll from the ground under its wheels
  place() {
    groundPose(this.g, this.x, this.z, this.yaw);
    this.collider.x = this.x; this.collider.z = this.z; this.collider.rot = -this.yaw;
    void _m; void _q;
  }
}
