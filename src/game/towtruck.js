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
import { busRoads } from './bus/roads.js';
import { addTrafficBlocker } from './traffic.js';

const RAW = { cx: 0.926, cz: -3.236, bed0: -4.45, bed1: 0.05, deck: 1.07 }; // model: centre, bed z range, deck height
const BED_FIT = 5.25;                                // m of bed wanted (the RS6 plus a little)
export const TRUCK_SCALE = BED_FIT / (RAW.bed1 - RAW.bed0); // ~1.17: 7.7 m long, 2.7 m wide, 2.85 m tall
const S = TRUCK_SCALE;
// in the truck's frame (+z its nose, y up from the road): the bed's middle and the deck's height, half length / width
const BED = { z: (RAW.cz - (RAW.bed0 + RAW.bed1) / 2) * S, y: RAW.deck * S + 0.02 };
const HALF_L = 3.3 * S, HALF_W = 1.17 * S;
const LANE = 1.6, V_ROAD = 13, V_SLOW = 3.5, LOOK = 7, WHEELBASE = 4.2 * S;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
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
    this.g = new THREE.Group();
    this.g.name = 'tow-truck';
    const gltf = models.tow_truck;
    if (gltf) {
      const m = gltf.scene.clone(true);
      m.rotation.y = Math.PI; // (nose to +z)
      m.position.set(RAW.cx, 0, RAW.cz); // (re-centred: the model runs nose -z from its origin at the bed's tail; turned, its centre (-cx, -cz) back to 0)
      const s = new THREE.Group(); s.scale.setScalar(S); s.add(m);
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.g.add(s);
    } else { // (no model: a plain flatbed so the job still runs)
      const mat = new THREE.MeshStandardMaterial({ color: 0xd8a21a, roughness: 0.5 });
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.2), mat); cab.position.set(0, 1.5, HALF_L - 1.2);
      const bed = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.25, 5.4), new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7 })); bed.position.set(0, BED.y - 0.12, BED.z);
      this.g.add(cab, bed);
    }
    // amber beacons on the cab roof (a pair) and their glow
    this.beaconMat = new THREE.MeshStandardMaterial({ color: 0xffa21a, emissive: 0xff8a00, emissiveIntensity: 0, roughness: 0.3, transparent: true, opacity: 0.92 });
    this.beacons = [];
    // (Oct 28, the user: "the lights on the towing machine are floating": the roof was a guessed constant; now it is
    // found on the model itself: rays straight down onto the cab, the roof's highest flat stretch, each lamp sat on it)
    const roof = gltf ? findRoof(this.g) : null;
    const roofZ = roof ? roof.z : HALF_L - 1.55 * S;
    const roofY = roof ? roof.y : 2.44 * S;
    for (const sx of [-0.62, 0.62]) {
      const y = (roof && roof.at(sx)) ?? roofY;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.05, 14), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }));
      base.position.set(sx, y + 0.02, roofZ);
      const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.16, 14), this.beaconMat);
      dome.position.set(sx, y + 0.12, roofZ);
      this.g.add(base, dome);
      this.beacons.push(dome);
    }
    this.beaconLight = new THREE.PointLight(0xffa020, 0, 14, 2);
    this.beaconLight.position.set(0, roofY + 0.4, roofZ);
    this.g.add(this.beaconLight);
    // the winch cable (a thin line from the bed's tail to the car while it pulls)
    this.cable = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 5), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.6 }));
    this.cable.visible = false;
    scene.add(this.cable);
    scene.add(this.g);
    // pose: x, z, yaw; solid (a moving box collider), and the traffic brakes for it
    this.x = park.x; this.z = park.z; this.yaw = park.yaw; this.v = 0;
    this.collider = { x: this.x, z: this.z, hw: HALF_W, hd: HALF_L, rot: -this.yaw, h: 2.8 };
    colliders.push(this.collider);
    this.box = { hw: HALF_W, hd: HALF_L };
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
      const on = !!j;
      for (let k = 0; k < this.beacons.length; k++) {
        const ph = Math.sin(this.t * 7.5 + k * Math.PI);
        this.beacons[k].scale.setScalar(1);
        if (k === 0) this.beaconMat.emissiveIntensity = on ? 1.5 + 2.5 * Math.max(0, ph) : 0;
      }
      this.beaconLight.intensity = on ? 6 * Math.max(0, Math.sin(this.t * 7.5)) ** 2 : 0;
    } catch (err) { console.warn('tow truck', err); this.job = null; }
  }

  start(j) {
    this.job = j;
    const e = j.e, c = e.car.position;
    const from = nearestNode(this.yardOut[this.yardOut.length - 1].x, this.yardOut[this.yardOut.length - 1].z);
    const to = nearestNode(c.x, c.z);
    const road = pts(extend((from.i >= 0 && to.i >= 0 && shortest(from.i, to.i)) || [], HALF_L + 4));
    // out of its bay: backwards to the first yard point (it parks nose in), then forward round to the road
    j.path = [...this.yardOut.slice(1), ...keepRight(road)];
    j.k = 0; j.phase = 'backout';
    this.state = 'out';
  }

  // follow j.path (pure pursuit, limited steering, slower in bends and near the end); true once at its end
  follow(j, dt, vmax) {
    const P = j.path;
    while (j.k < P.length - 1 && Math.hypot(P[j.k].x - this.x, P[j.k].z - this.z) < LOOK) j.k++;
    const end = P[P.length - 1];
    let tgt = P[j.k];
    const left = Math.hypot(end.x - this.x, end.z - this.z) + 0;
    // overtaking (Oct 28, the user: "the towing truck gets stuck when there's too many cars because of the crash": the
    // queue behind a wreck waited for the truck and the truck for the queue): held up 2 s, it pulls out into the other
    // lane, beacons on, and goes past (oncoming traffic brakes for it: it's a traffic blocker), then back in
    j.held = j.held || 0; j.pass = Math.max(0, (j.pass || 0) - dt);
    if (j.pass > 0 && j.k < P.length - 2) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      tgt = { x: tgt.x + fz * LANE * 2, z: tgt.z - fx * LANE * 2 };
    }
    const want = Math.atan2(tgt.x - this.x, tgt.z - this.z), err = wrapPi(want - this.yaw);
    let v = Math.min(vmax, j.k >= P.length - 1 ? Math.max(1.2, left * 0.9) : vmax);
    v *= clamp(1.15 - Math.abs(err) * 1.1, 0.25, 1);
    // traffic just ahead in its lane: wait (not while overtaking)
    let blocked = false;
    if (j.pass <= 0) for (const c of this.traffic?.cars || []) {
      if (c.mode === 'gone' || !c.g?.visible) continue;
      const dx = c.x - this.x, dz = c.z - this.z, f = dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw), s = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
      if (f > 0 && f < HALF_L + 7 && Math.abs(s) < 2.3) { const cap = Math.max(0, (f - HALF_L - 3) * 0.8); if (cap < v) { v = cap; blocked = cap < 1; } }
    }
    j.held = blocked ? j.held + dt : Math.max(0, j.held - dt * 2);
    if (j.held > 2) { j.held = 0; j.pass = 7; }
    this.v += clamp(v - this.v, -6 * dt, 2.2 * dt);
    const rate = Math.max(0.25, Math.abs(this.v)) / (WHEELBASE / Math.tan(0.6)); // (max steering ~34 degrees)
    this.yaw = wrapPi(this.yaw + clamp(err, -rate * dt * 3, rate * dt * 3) * Math.min(1, Math.abs(this.v) / 1.5 + 0.35));
    this.x += Math.sin(this.yaw) * this.v * dt; this.z += Math.cos(this.yaw) * this.v * dt;
    return j.k >= P.length - 1 && left < 1.2;
  }

  step(j, dt) {
    const e = j.e, g = e.car;
    if (!g.parent) { this.finish(j); return; } // (the car was taken away meanwhile)
    if (j.phase === 'backout') {
      const b = this.yardOut[0], f = (b.x - this.x) * Math.sin(this.yaw) + (b.z - this.z) * Math.cos(this.yaw);
      this.v += clamp((f < -0.6 ? -2.4 : 0) - this.v, -2.5 * dt, 2.5 * dt);
      this.x += Math.sin(this.yaw) * this.v * dt; this.z += Math.cos(this.yaw) * this.v * dt;
      if (f >= -0.6 && Math.abs(this.v) < 0.1) { this.v = 0; j.phase = 'out'; }
    } else if (j.phase === 'out') {
      if (this.follow(j, dt, V_ROAD)) { j.phase = 'reach'; this.v = 0; }
    } else if (j.phase === 'reach') {
      // the car at the bed's tail: winch it there over the snow (it slides, turning in line), unless it's close already
      const tail = this.local(0, BED.z - BED_FIT / 2 - 2.6);
      const dx = tail.x - g.position.x, dz = tail.z - g.position.z, d = Math.hypot(dx, dz);
      const seen = this.inView(g.position);
      if (d > 30 && !seen) { g.position.x = tail.x - dx / d * 6; g.position.z = tail.z - dz / d * 6; } // (far off the road and unseen: brought close)
      if (d > 1.5) {
        const step = Math.min(d - 1.4, 2.2 * dt);
        g.position.x += dx / d * step; g.position.z += dz / d * step;
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
        j.k = 0;
      }
    } else if (j.phase === 'back') {
      if (this.follow(j, dt, V_ROAD)) { j.phase = 'unload'; j.ut = 0; this.v = 0; }
    } else if (j.phase === 'unload') {
      // parked in the yard: turn straight into its spot, then the wreck is taken off (out of sight, or after a while)
      this.yaw += wrapPi(this.park.yaw - this.yaw) * Math.min(1, dt * 1.2);
      this.x += (this.park.x - this.x) * Math.min(1, dt * 1.2); this.z += (this.park.z - this.z) * Math.min(1, dt * 1.2);
      j.ut += dt;
      if ((j.ut > 2 && !this.inView(g.position)) || j.ut > 14) this.finish(j);
    }
  }

  finish(j) {
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
    const p = new THREE.Vector3(0, BED.y, BED.z + Math.max(0, (BED_FIT - e.length) / 2 - 0.15)).applyMatrix4(this.g.matrixWorld);
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
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw), h = (lx, lz) => world.height(this.x + s * lz + c * lx, this.z + c * lz - s * lx);
    const f = h(0, HALF_L - 1.2), b = h(0, -HALF_L + 1.6), l = h(1, 0), r = h(-1, 0);
    const y = (f + b) / 2;
    const pitch = -Math.atan2(f - b, HALF_L * 2 - 2.8), roll = Math.atan2(l - r, 2);
    this.g.position.set(this.x, y + 0.02, this.z);
    _e.set(pitch, this.yaw, roll * 0.5);
    this.g.quaternion.setFromEuler(_e);
    this.g.updateMatrixWorld(true);
    this.collider.x = this.x; this.collider.z = this.z; this.collider.rot = -this.yaw;
    void _m; void _q;
  }
}
