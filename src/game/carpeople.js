// People in the traffic: a driver in every car that drives (left front seat, hands on the wheel at ten to two), now
// and then a front passenger, sometimes one or two in the back. The game's own skiers, baked once into static seated
// figures (the rig's 'sit' pose, relaxed by world/seatpose.js and leant back into a car seat's backrest; the driver's
// arms then reach for the wheel, the feet go to the floor / pedals), a few looks; each car gets plain meshes of them
// in its detailed model (traffic.js shows that within 60 m only, so the people go with it).
// Seated by each model's own seats (SEATS: measured from the models' interiors): the hips on the cushion, the back
// against the backrest, under the roof; the drivers are baked per car model so their hands are on that car's wheel.
// A car without seat hints: placed by its driver's eye (cars.js driverEye) and kept under its roof, as before.
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { poseSeated } from '../world/seatpose.js';
import { driverEye } from './cars.js';

const LOOKS = ['skier_blue', 'skier_red', 'skier_black', 'skier_green'];
/** A seated skier's eye above (y) and ahead of (z) the seat point it sits on (measured by the bake; drive.js seats you by it). */
export const SEAT_EYE = { y: 0.78, z: 0.04 };
const FWD = new THREE.Vector3(0, 0, 1), UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _s = new THREE.Vector3();
export const wpos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
export const wquat = (o) => { const q = new THREE.Quaternion(); o.matrixWorld.decompose(_v, q, _s); return q; };
export function setWQ(bone, q) { bone.quaternion.copy(wquat(bone.parent).invert().multiply(q)); bone.updateMatrixWorld(true); }
function aim(bone, from, to, pivot) {
  const u = from.clone().sub(pivot).normalize(), w = to.clone().sub(pivot).normalize();
  if (u.lengthSq() < 1e-8 || w.lengthSq() < 1e-8) return;
  setWQ(bone, new THREE.Quaternion().setFromUnitVectors(u, w).multiply(wquat(bone)));
}
// two-bone IK (as seatpose.js): the elbow toward `pole`, the hand at `target`
export function twoBone(a, b, c, target, pole) {
  if (!a || !b || !c) return;
  const pa = wpos(a), pb = wpos(b), pc = wpos(c);
  const lab = pa.distanceTo(pb), lbc = pb.distanceTo(pc);
  const dir = target.clone().sub(pa);
  const d = Math.min(Math.max(dir.length(), Math.abs(lab - lbc) + 1e-3), lab + lbc - 1e-3);
  dir.normalize();
  const cosA = (lab * lab + d * d - lbc * lbc) / (2 * lab * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const pd = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  const mid = pa.clone().addScaledVector(dir, lab * cosA).addScaledVector(pd, lab * sinA);
  aim(a, pb, mid, pa);
  aim(b, wpos(c), pa.clone().addScaledVector(dir, d), wpos(b));
}
// a skinned mesh in its pose as a static geometry (root space), simplified to about `tris` triangles
function bake(mesh, tris) {
  const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv, n = pos.count;
  const v = new THREE.Vector3(), P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
  let idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
  if (idx.length / 3 > tris) { const [res] = MeshoptSimplifier.simplify(idx, P, 3, tris * 3, 0.05, ['LockBorder']); if (res?.length) idx = res; }
  const map = new Int32Array(n).fill(-1), outP = [], outU = [], outI = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (map[i] < 0) { map[i] = outP.length / 3; outP.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); if (uv) outU.push(uv.getX(i), uv.getY(i)); }
    outI[k] = map[i];
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(outU, 2));
  out.setIndex(new THREE.BufferAttribute(outI, 1));
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

// Seats per car model, measured from the fitted templates the game uses (car frame: +x the driver's side (left), +z
// forward, y up from the ground; tools: cross-sections of each cabin): d the driver's seat [centre x, cushion top y
// under the hips, the backrest's front z 0.15 m above the cushion, its lean back (z per metre up)], p the front
// passenger's [y, z, lean] when it differs from the driver's (x mirrored), r the rear outboard seats [x, y, z, lean];
// floor (in front of the front / rear seats), roof (inside, above them), wheel: the steering wheel's centre [y, z].
// A template is matched by its size [length, height] and steering wheel. traffic: drivers are baked for it.
const SEATS = [
  { name: 'car_vw_golf_gti', traffic: true, size: [4.30, 1.47], wheel: [0.919, 0.297], d: [0.35, 0.436, -0.209, -0.44], r: [0.37, 0.461, -1.085, -0.5], floor: [0.21, 0.22], roof: [1.40, 1.37] },
  { name: 'car_vw_golf_gti_full', size: [4.30, 1.49], wheel: [0.922, 0.306], d: [0.35, 0.45, -0.21, -0.44], r: [0.37, 0.473, -1.08, -0.5], floor: [0.277, 0.24], roof: [1.40, 1.39] },
  { name: 'car_bmw_x3', traffic: true, size: [4.70, 1.68], wheel: [1.065, 0.307], d: [0.373, 0.632, -0.238, -0.44], r: [0.38, 0.631, -1.079, -0.37], floor: [0.40, 0.33], roof: [1.60, 1.59] },
  // (the RS6's driver's seat sits 10 cm further forward than the passenger's; the full model has the same seats)
  { name: 'car_audi_rs6', traffic: true, size: [5.00, 1.50], wheel: [0.916, 0.469], d: [0.381, 0.432, 0.0, -0.57], p: [0.407, -0.10, -0.43], r: [0.38, 0.455, -0.986, -0.37], floor: [0.295, 0.23], roof: [1.377, 1.38] },
  // (a glass roof: the height under it)
  { name: 'car_tesla_m3', traffic: true, size: [4.70, 1.46], wheel: [0.811, 0.607], d: [0.47, 0.395, -0.105, -0.17], r: [0.38, 0.394, -0.97, -0.17], floor: [0.28, 0.27], roof: [1.37, 1.37] },
  { name: 'car_tesla_m3_full', size: [4.70, 1.46], wheel: [0.914, 0.668], d: [0.47, 0.395, -0.105, -0.17], r: [0.38, 0.394, -0.97, -0.17], floor: [0.28, 0.27], roof: [1.37, 1.37] },
  // (the SLS: a two-seater, no rear seats; low, its cushions 0.29 m off the ground. The Taycan: the rear seats' feet
  // in the battery's "foot garages")
  { name: 'car_mercedes_sls', traffic: true, size: [4.64, 1.26], wheel: [0.768, -0.095], d: [0.43, 0.29, -0.675, -0.32], r: null, floor: [0.24, 0.24], roof: [1.17, 1.15] },
  { name: 'car_porsche_taycan', traffic: true, size: [4.96, 1.36], wheel: [0.834, 0.352], d: [0.37, 0.37, -0.255, -0.27], r: [0.38, 0.47, -1.08, -0.4], floor: [0.30, 0.30], roof: [1.28, 1.22] },
  // (Oct 29: the Huracán, a two-seater, low; the GR Yaris; the e-tron GT; the GLS. Oct 30, the user: "the Mercedes
  // GLS is a 5 seater not a 7 seater": no third row, the driver, the front passenger and three in the back)
  { name: 'car_lamborghini_huracan', traffic: true, size: [4.52, 1.18], wheel: [0.779, 0.359], d: [0.37, 0.27, -0.24, -0.5], r: null, floor: [0.15, 0.15], roof: [1.15, 1.10] },
  { name: 'car_toyota_gr_yaris', traffic: true, size: [3.99, 1.44], wheel: [0.918, 0.277], d: [0.35, 0.47, -0.26, -0.47], r: [0.38, 0.54, -1.085, -0.35], floor: [0.21, 0.23], roof: [1.40, 1.37] },
  { name: 'car_audi_etron_gt', traffic: true, size: [4.96, 1.38], wheel: [0.918, 0.402], d: [0.37, 0.36, -0.255, -0.37], r: [0.38, 0.475, -0.995, -0.5], floor: [0.24, 0.24], roof: [1.30, 1.28] },
  { name: 'car_mercedes_gls', traffic: true, size: [5.20, 1.86], wheel: [1.156, 0.625], d: [0.42, 0.79, -0.01, -0.4], r: [0.42, 0.73, -1.16, -0.33], floor: [0.50, 0.49], roof: [1.66, 1.77] },
];
const DEPTH = 0.13, DEPTH_U = 0.11; // hip joint / shoulder joints to the backrest (pelvis, shoulder blades, jacket)
const RECLINE = 0.2; // (rad) a passenger's back leant into a car seat (they recline ~10-30 degrees), the head levelled
const RIGHT = new THREE.Vector3(-1, 0, 0);
const _seat = new WeakMap();
/** The seat hints for a car template (SEATS), or null. */
export function seatsFor(t) {
  if (!t?.size) return null;
  if (_seat.has(t)) return _seat.get(t);
  let best = null, bd = 0.12;
  for (const s of SEATS) {
    let d = Math.abs(t.size.z - s.size[0]) + Math.abs(t.size.y - s.size[1]);
    if (t.steering?.c) d += Math.abs(t.steering.c.y - s.wheel[0]) + Math.abs(t.steering.c.z - s.wheel[1]);
    if (d < bd) { bd = d; best = s; }
  }
  _seat.set(t, best);
  return best;
}
// a seat's hip joint (car frame) for someone whose hip joint is hipY above the seat surface: on the cushion (pressed
// in a little), DEPTH in front of the backrest at that height
function hipAt(x, s, hipY) { return new THREE.Vector3(x, s[0] - 0.01 + hipY, s[1] + s[2] * (hipY - 0.15) + DEPTH); }
// where a baked figure's seat point goes (car frame) on a seat s ([cushion y, backrest z, lean]) at x: on the cushion,
// its back against the backrest where it touches first (the hips in a seat that leans back further than the figure,
// the shoulders in a more upright one)
function originAt(x, s, hip, chest) {
  const back = (h) => s[1] + s[2] * (h - 0.15);
  const oz = Math.max(back(hip.y) + DEPTH - hip.z, chest ? back(chest.y) + DEPTH_U - chest.z : -Infinity);
  return new THREE.Vector3(x - hip.x, s[0] - 0.01, oz);
}
/** The driver's hip joint in a car template's frame for a rig whose hip is hipY above its seat point (drive.js: you),
 *  or null without seat hints. reach: the seat slid forward so the wheel's centre is no further ahead than that. */
export function seatHip(t, hipY = 0.1, reach = 0) {
  const S = seatsFor(t);
  if (!S) return null;
  const h = hipAt(S.d[0], S.d.slice(1), hipY);
  if (reach && t.steering?.c) h.z = Math.max(h.z, t.steering.c.z - reach);
  return h;
}
function rotW(bone, axis, angle) {
  if (bone && angle) setWQ(bone, new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(wquat(bone)));
}
/** A seated rig leant back into a backrest by rec (rad) about R (world: the way the figure's right points): the spine
 *  back, the neck and head bringing the eyes level again (or as given). (Drive: your own rig, every frame.) */
export function leanBack(b, R, rec, neck = -rec * 0.6, head = -rec * 0.3) {
  if (!b) return;
  rotW(b.spine0, R, rec * 0.55); rotW(b.spine1, R, rec * 0.45); rotW(b.neck, R, neck); rotW(b.head, R, head);
}

export class CarPeople {
  constructor(makeRig) {
    // figures: { parts: [{ geo, mat }], eye, hip (from the seat point), top: head top y }; drivers per car model
    this.figs = { driver: [], passenger: [] };
    this.drivers = new Map(); // SEATS name -> figures (hands on that model's wheel)
    this.ready = makeRig ? this.bakeAll(makeRig).catch((e) => { console.warn('car people', e); }) : Promise.resolve();
  }

  async bakeAll(makeRig) {
    await MeshoptSimplifier.ready;
    const frame = () => new Promise((r) => setTimeout(r, 0));
    const models = SEATS.filter((s) => s.traffic);
    for (const [n, id] of LOOKS.entries()) {
      let rig;
      try { rig = makeRig(id, 'rental'); } catch { continue; }
      if (!rig?.root || !rig.b?.hips) continue;
      if (rig.gear) rig.gear.visible = false;
      // a passenger; drivers for half the models (two looks each); the plain driver (cars without seat hints)
      const jobs = [{ role: 'passenger' }];
      models.forEach((S, k) => { if ((k + n) % 2 === 0) jobs.push({ role: 'driver', S }); });
      if (n < 2) jobs.push({ role: 'driver', S: null });
      for (const job of jobs) {
        try {
          const fig = this.bakeOne(rig, n, job.role, job.S);
          if (!fig) continue;
          if (job.role === 'passenger') this.figs.passenger.push(fig);
          else if (job.S) { if (!this.drivers.has(job.S.name)) this.drivers.set(job.S.name, []); this.drivers.get(job.S.name).push(fig); }
          else {
            this.figs.driver.push(fig);
            if (n === 0) { SEAT_EYE.y = fig.eye.y; SEAT_EYE.z = fig.eye.z; }
          }
        } catch (e) { console.warn('car person', id, job.role, e); }
        await frame();
      }
    }
  }

  /** A plain driver (placed by the car's driver eye, see fillByEye) baked from any rig: police.js, the officer at
   *  the patrol car's wheel. The rig is posed for it (pass a spare one). */
  async bakeDriver(rig) {
    await MeshoptSimplifier.ready;
    if (!rig?.root || !rig.b?.hips) return null;
    if (rig.gear) rig.gear.visible = false;
    return this.bakeOne(rig, 0, 'driver', null);
  }

  // one seated figure: S (seat hints) for a driver baked for that model; S null and a driver: the plain one (as before)
  bakeOne(rig, n, role, S) {
    const b = rig.b, driver = role === 'driver', fitted = !driver || !!S;
    const seat = new THREE.Vector3();
    for (let k = 0; k < 2; k++) { rig.snapNext = true; rig.update(0.016, { mode: 'sit', seat, heading: 0, speed: 0, lookYaw: 0 }); }
    rig.root.updateMatrixWorld(true);
    // leant back into the backrest (a driver as far as that car's seat leans), the neck and head level the eyes again
    const rec = !fitted ? 0 : S ? Math.min(0.3, Math.max(0.02, Math.atan(-S.d[3]) - 0.15)) : RECLINE;
    if (rec) { leanBack(b, RIGHT, rec); rig.root.updateMatrixWorld(true); }
    poseSeated(rig, driver ? 'thighs' : n % 2 ? 'lap' : 'thighs', driver ? 0 : n % 2 ? 0.35 : -0.25, 0.35);
    const hip = wpos(b.hips), chest = b.lArm && b.rArm ? wpos(b.lArm).add(wpos(b.rArm)).multiplyScalar(0.5) : null;
    // (a driver: where this figure sits in its car)
    const O = S ? originAt(S.d[0], S.d.slice(1), hip, chest) : null, hipCar = O ? hip.clone().add(O) : null;
    // legs stretched out to the pedals / the floor ahead (feet flat on it, knees up), so no boot pokes out under the car
    const drop = S ? Math.min(0.26, Math.max(0.13, hipCar.y - S.floor[0] - 0.09)) : fitted ? 0.2 : 0.24;
    const ahead = S ? 0.7 : fitted ? 0.62 : 0.72;
    for (const [i, up, leg, foot] of [[0, b.lUp, b.lLeg, b.lFoot], [1, b.rUp, b.rLeg, b.rFoot]]) {
      const side = i === 0 ? 1 : -1;
      twoBone(up, leg, foot, hip.clone().add(new THREE.Vector3(side * 0.13, -drop, ahead)), new THREE.Vector3(side * 0.15, 1, 0.5).normalize());
    }
    rig.root.updateMatrixWorld(true);
    const eye = wpos(b.head).add(new THREE.Vector3(0, 0.09, 0.08));
    if (driver) {
      // hands on the wheel at ten to two: this model's wheel where it is from the seat (S), else 0.27 m below and
      // 0.6 m ahead of the eye (as cars.js driverEye)
      const tilt = 0.38, wc = S ? new THREE.Vector3(S.d[0], S.wheel[0], S.wheel[1]).sub(O) : eye.clone().add(new THREE.Vector3(0, -0.27, 0.6));
      const wUp = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
      rig.relaxShoulders?.();
      for (const [i, arm, fore, hand] of [[0, b.lArm, b.lFore, b.lHand], [1, b.rArm, b.rFore, b.rHand]]) {
        const side = i === 0 ? 1 : -1; // (+x: the driver's left)
        const tgt = wc.clone().addScaledVector(new THREE.Vector3(1, 0, 0), side * 0.15).addScaledVector(wUp, 0.07).addScaledVector(FWD, -0.03);
        twoBone(arm, fore, hand, tgt, new THREE.Vector3(side * 0.7, -1, -0.25).normalize());
        if (hand && fore) setWQ(hand, wquat(fore));
      }
      rig.root.updateMatrixWorld(true);
    }
    const parts = [];
    let top = -Infinity;
    rig.root.traverse((o) => {
      if (!o.isSkinnedMesh || !o.visible || !o.geometry?.attributes?.position) return;
      const geo = bake(o, 1400);
      geo.computeBoundingBox();
      top = Math.max(top, geo.boundingBox.max.y);
      parts.push({ geo, mat: Array.isArray(o.material) ? o.material[0] : o.material });
    });
    return parts.length ? { parts, eye, hip, chest, top } : null;
  }

  /** People for a traffic car (a Group in the car's frame), or null before the bake. rnd: () => 0..1 */
  fill(t, rnd = Math.random) {
    const S = seatsFor(t);
    if (!S) return this.fillByEye(t, rnd);
    const D = this.drivers.get(S.name), P = this.figs.passenger;
    if (!D?.length && !P.length) return null;
    const g = new THREE.Group();
    g.name = 'car-people';
    // a figure on the seat s ([y, z, lean]) at x, its head under the roof
    const put = (fig, x, s, roof) => {
      const o = new THREE.Group();
      o.position.copy(originAt(x, s, fig.hip, fig.chest));
      o.position.y -= Math.min(0.05, Math.max(0, o.position.y + fig.top - (roof - 0.03)));
      for (const p of fig.parts) { const m = new THREE.Mesh(p.geo, p.mat); m.castShadow = false; m.receiveShadow = false; o.add(m); }
      g.add(o);
    };
    const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];
    const front = S.d.slice(1), pass = S.p || front, rear = S.r?.slice(1);
    put(pick(D?.length ? D : P), S.d[0], front, S.roof[0]); // (no driver baked for it: a passenger at the wheel)
    if (P.length) {
      if (rnd() < 0.45) put(pick(P), -S.d[0], pass, S.roof[0]);
      const back = S.r ? rnd() : 1; // (a two-seater: nobody in the back)
      if (back < 0.22) put(pick(P), (rnd() < 0.5 ? 1 : -1) * S.r[0], rear, S.roof[1]);
      else if (back < 0.3) { put(pick(P), S.r[0], rear, S.roof[1]); put(pick(P), -S.r[0], rear, S.roof[1]); }
    }
    return g;
  }

  // a car without seat hints: the figures placed by the driver's eye (cars.js driverEye), kept under the roof
  fillByEye(t, rnd) {
    if (!this.figs.driver.length) return null;
    const g = new THREE.Group();
    g.name = 'car-people';
    const E = driverEye(t), roof = t.size.y - 0.05;
    const put = (fig, x, y, z) => {
      // the figure's eye at (x, y, z); lower if its head would go through the roof
      const sink = Math.max(0, y + (fig.top - fig.eye.y) - roof);
      const o = new THREE.Group();
      o.position.set(x - fig.eye.x, y - fig.eye.y - sink, z - fig.eye.z);
      for (const p of fig.parts) { const m = new THREE.Mesh(p.geo, p.mat); m.castShadow = false; m.receiveShadow = false; o.add(m); }
      g.add(o);
    };
    const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];
    put(pick(this.figs.driver), E.x, E.y, E.z);
    const P = this.figs.passenger.length ? this.figs.passenger : this.figs.driver;
    if (rnd() < 0.45) put(pick(P), -E.x, E.y - 0.02, E.z + 0.02);
    const back = rnd();
    if (back < 0.22) put(pick(P), (rnd() < 0.5 ? 1 : -1) * E.x, E.y - 0.04, E.z - 0.86);
    else if (back < 0.3) { put(pick(P), E.x, E.y - 0.04, E.z - 0.86); put(pick(P), -E.x, E.y - 0.04, E.z - 0.86); }
    return g;
  }
}
