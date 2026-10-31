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
  { name: 'car_bmw_x3', traffic: true, size: [4.70, 1.68], wheel: [1.065, 0.307], d: [0.373, 0.632, -0.238, -0.44], r: [0.38, 0.631, -1.079, -0.37], floor: [0.40, 0.39], roof: [1.60, 1.59] },
  // (the RS6's driver's seat sits 10 cm further forward than the passenger's; the full model has the same seats)
  { name: 'car_audi_rs6', traffic: true, size: [5.00, 1.50], wheel: [0.916, 0.469], d: [0.381, 0.432, 0.0, -0.57], p: [0.407, -0.10, -0.43], r: [0.38, 0.455, -0.986, -0.37], floor: [0.295, 0.23], roof: [1.377, 1.38] },
  // (a glass roof: the height under it)
  { name: 'car_tesla_m3', traffic: true, size: [4.70, 1.46], wheel: [0.811, 0.607], d: [0.47, 0.395, -0.105, -0.17], r: [0.38, 0.394, -0.97, -0.17], floor: [0.28, 0.27], roof: [1.37, 1.37] },
  { name: 'car_tesla_m3_full', size: [4.70, 1.46], wheel: [0.914, 0.668], d: [0.47, 0.395, -0.105, -0.17], r: [0.38, 0.394, -0.97, -0.17], floor: [0.28, 0.27], roof: [1.37, 1.37] },
  // (the SLS: a two-seater, no rear seats; low, its cushions 0.29 m off the ground. The Taycan: the rear seats' feet
  // in the battery's "foot garages")
  { name: 'car_mercedes_sls', traffic: true, size: [4.64, 1.26], wheel: [0.768, -0.095], d: [0.43, 0.29, -0.675, -0.32], r: null, floor: [0.20, 0.20], roof: [1.17, 1.15] },
  { name: 'car_porsche_taycan', traffic: true, size: [4.96, 1.36], wheel: [0.834, 0.352], d: [0.37, 0.37, -0.255, -0.27], r: [0.38, 0.47, -1.08, -0.4], floor: [0.25, 0.24], roof: [1.28, 1.22] },
  // (Oct 29: the Huracán, a two-seater, low; the GR Yaris; the e-tron GT; the GLS. Oct 30, the user: "the Mercedes
  // GLS is a 5 seater not a 7 seater": no third row, the driver, the front passenger and three in the back)
  { name: 'car_lamborghini_huracan', traffic: true, size: [4.52, 1.18], wheel: [0.779, 0.359], d: [0.37, 0.27, -0.24, -0.5], r: null, floor: [0.18, 0.18], roof: [1.15, 1.10] },
  { name: 'car_toyota_gr_yaris', traffic: true, size: [3.99, 1.44], wheel: [0.918, 0.277], d: [0.35, 0.47, -0.26, -0.47], r: [0.38, 0.54, -1.085, -0.35], floor: [0.25, 0.23], roof: [1.40, 1.37] },
  { name: 'car_audi_etron_gt', traffic: true, size: [4.96, 1.38], wheel: [0.918, 0.402], d: [0.37, 0.36, -0.255, -0.37], r: [0.38, 0.475, -0.995, -0.5], floor: [0.26, 0.25], roof: [1.30, 1.28] },
  // (Oct 31 2026, the user: "you still don't sit properly on a chair": the floors in front of the seats measured again
  // in the footwells (the Taycan's was 5 cm too high, the SLS's 4 cm, the X3's rear 6 cm too low): seatLegs puts the
  // heels on them)
  { name: 'car_mercedes_gls', traffic: true, size: [5.20, 1.86], wheel: [1.156, 0.625], d: [0.42, 0.79, -0.01, -0.4], r: [0.42, 0.73, -1.16, -0.33], floor: [0.50, 0.49], roof: [1.66, 1.77] },
];
const DEPTH = 0.13, DEPTH_U = 0.11; // hip joint / shoulder joints to the backrest (pelvis, shoulder blades, jacket)
/** (m) How much higher a rig sits in a car seat than its plain 'sit' pose puts it (the pelvis 0.1 m over the seat point,
 *  so the hip joints were level with the cushion's surface: the seat of the trousers sunk 8 cm into it, the thighs
 *  through its raised front edge and the legs stiff and straight out, the boots under the floor; Oct 31 2026, the user:
 *  "you still don't sit properly on a chair"): the hip joints ~6 cm over the cushion, as a body sits on one. Every
 *  seat point (drive.js seatHip, net/vehicles.js and taxi.js carSeats, the traffic's figures) is lifted by it. */
export const SEAT_LIFT = 0.06;
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
function hipAt(x, s, hipY) { return new THREE.Vector3(x, s[0] - 0.01 + SEAT_LIFT + hipY, s[1] + s[2] * (hipY - 0.15) + DEPTH); }
// where a baked figure's seat point goes (car frame) on a seat s ([cushion y, backrest z, lean]) at x: on the cushion,
// its back against the backrest where it touches first (the hips in a seat that leans back further than the figure,
// the shoulders in a more upright one)
function originAt(x, s, hip, chest) {
  const back = (h) => s[1] + s[2] * (h - 0.15);
  const oz = Math.max(back(hip.y) + DEPTH - hip.z, chest ? back(chest.y) + DEPTH_U - chest.z : -Infinity);
  return new THREE.Vector3(x - hip.x, s[0] - 0.01 + SEAT_LIFT, oz);
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

// THE HEAD UNDER THE ROOF (Oct 31 2026: with the seats SEAT_LIFT higher, after the user's "you still don't sit properly
// on a chair", a seated rig's head top went 3-24 cm over the roof lining in the low cars and most back seats, so it
// came through the roof in the chase view): as the traffic's people are kept under it (fill: put, leant back by the
// seat and lowered at most 5 cm), a live rig (the passengers, the other players, the taxi's fare, you at the wheel in
// the chase view) is brought down just as far as it takes to have its head top ROOF_GAP under that car's roof (SEATS
// roof: the same per-car table and cabin raycasts as the floors). A passenger: leant back first (the pelvis rolling
// back about the hip joints, so the hips stay on the cushion, and the spine with it; the neck and head turned forward
// again, the eyes level) up to LEAN (~34 degrees all told, as people sit in a back seat), then the hips let down into
// the cushion up to SEAT_LIFT (where they sat before the seats went up), then leant back further (LEAN_HARD: the
// Taycan's, e-tron GT's and GR Yaris's back seats, the SLS, the Huracan) and let down the rest. You at the wheel
// (o.wheel): let down first, then leant back with the hips slid forward on the cushion as far as the shoulders go
// back (a slouch, as in a low sports car), so the hands stay on the wheel. Never lower than keeps the heels on the
// floor where seatLegs puts them (posed after it, unchanged). It measures the head every pose (its crown found once
// per rig on its mesh), so it does nothing where the head fits (the GLS's back seats) and never adds up from frame to
// frame (other players are posed only now and then: it only ever moves a head that is over the line).
const ROOF_GAP = 0.02, SINK_MAX = 0.12; // (m: under the lining; the hips let down at most)
const LEAN = 0.6, LEAN_HARD = 0.9; // (rad of extra lean for a passenger; at most, before the last let-down)
const _headTop = new WeakMap(), _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _rR = new THREE.Vector3();
const _rU = new THREE.Vector3(), _rv = new THREE.Vector3(), _rC = new THREE.Vector3(), _rP = new THREE.Vector3();
// the rig's head top: the vertices of its seated mesh within 6 cm of the highest one (the crown), as points in its head bone's
// frame (a few dozen: whichever is highest as the head turns; once per rig, not while the head is folded away for the
// cockpit camera)
function headTopOf(rig) {
  if (_headTop.has(rig)) return _headTop.get(rig);
  const b = rig.b;
  let m = rig.skinned;
  if (!m) rig.root.traverse((o) => { if (!m && o.isSkinnedMesh) m = o; });
  const P = m?.geometry?.attributes?.position;
  if (!P || !b.head || b.head.scale.x < 0.5) return null;
  rig.root.updateMatrixWorld(true);
  _rq.copy(wquat(rig.root)).invert();
  const W = [], Y = [];
  let best = -Infinity;
  for (let i = 0; i < P.count; i++) {
    m.getVertexPosition(i, _rv).applyMatrix4(m.matrixWorld);
    const y = _rP.copy(_rv).applyQuaternion(_rq).y;
    W.push(_rv.x, _rv.y, _rv.z); Y.push(y); best = Math.max(best, y);
  }
  let pts = [];
  for (let i = 0; i < Y.length; i++) if (Y[i] > best - 0.06) pts.push(i);
  const step = Math.max(1, Math.floor(pts.length / 48));
  pts = pts.filter((_, k) => k % step === 0).map((i) => b.head.worldToLocal(new THREE.Vector3(W[i * 3], W[i * 3 + 1], W[i * 3 + 2])));
  _headTop.set(rig, pts);
  return pts;
}
/** Keeps a seated rig's head top under its car's roof (see above): g the car (its frame), t its template, seat 0 the
 *  driver, 1 the front passenger, 2.. the back; o.wheel (drive.js: you, your hands then going to the wheel): the hips
 *  slid forward on the cushion by as much as the lean takes the shoulders back, so the wheel stays in reach. Before
 *  the legs and arms are posed. Returns how far (m) the head top is still over the line (0: under it). */
export function underRoof(rig, g, t, seat = 0, o = {}) {
  const b = rig?.b;
  if (!b?.head || !b.hips || !b.spine0 || !b.lUp || !b.rUp || !t) return 0;
  const S = seatsFor(t), front = seat < 2;
  const roof = S?.roof ? (front ? S.roof[0] : S.roof[1] ?? S.roof[0]) : t.size?.y ? t.size.y - 0.05 : null;
  const p = roof == null ? null : headTopOf(rig);
  if (!p) return 0;
  rig.root.updateMatrixWorld(true);
  if (g) { g.updateMatrixWorld(true); g.getWorldQuaternion(_rq2); } else _rq2.identity();
  const R = _rR.set(-1, 0, 0).applyQuaternion(_rq2), U = _rU.set(0, 1, 0).applyQuaternion(_rq2); // (lean back: about the figure's right)
  const loc = (v) => (g ? g.worldToLocal(v) : v);
  let top = p[0]; // (the highest of the head's points, found by over())
  const over = () => {
    let y = -Infinity;
    for (const q of p) { const h = loc(b.head.localToWorld(_rv.copy(q))).y; if (h > y) { y = h; top = q; } }
    return y - (roof - ROOF_GAP);
  };
  const hipMid = (v) => v.setFromMatrixPosition(b.lUp.matrixWorld).add(_rP.setFromMatrixPosition(b.rUp.matrixWorld)).multiplyScalar(0.5);
  let ex = over(), leant = 0, sunk = 0;
  if (ex <= 0) return 0;
  // (let down no further than keeps the heels on the floor as seatLegs puts them: its hip-to-ankle drop not clamped)
  const fl = S?.floor ? (front ? S.floor[0] : S.floor[1] ?? S.floor[0]) : null;
  const sinkMax = Math.min(SINK_MAX, fl == null ? SEAT_LIFT : Math.max(0, loc(hipMid(_rC)).y - (fl + SOLE - 0.045)));
  const shoulders = () => (b.lArm && b.rArm ? loc(_rC.setFromMatrixPosition(b.lArm.matrixWorld).add(_rP.setFromMatrixPosition(b.rArm.matrixWorld)).multiplyScalar(0.5)).z : 0);
  const sh0 = o.wheel ? shoulders() : 0;
  const leanTo = (max) => {
    for (let k = 0; k < 8 && ex > 0.002 && leant < max - 1e-3; k++) {
      // the angle that would bring the top down by ex were the body stiff about the hip joints (the neck and head
      // turning forward again take back about a third of it: 1.5 times that)
      const T = loc(b.head.localToWorld(_rv.copy(top))).sub(loc(hipMid(_rC))), r = Math.hypot(T.y, T.z), a0 = Math.atan2(-T.z, T.y);
      const a = Math.min(max - leant, Math.max(0.01, 1.5 * (Math.acos(Math.max(-1, Math.min(1, (T.y - ex) / r))) - a0)));
      leant += a;
      // the pelvis rolled back about the hip joints' line (they stay put), then the spine, the head level again
      const hc = hipMid(_rC), q = _rq.setFromAxisAngle(R, a * 0.4);
      const hp = _rP.setFromMatrixPosition(b.hips.matrixWorld).sub(hc).applyQuaternion(q).add(hc);
      setWQ(b.hips, q.multiply(wquat(b.hips)));
      b.hips.position.copy(b.hips.parent.worldToLocal(hp));
      b.hips.updateMatrixWorld(true);
      leanBack(b, R, a * 0.6, -a * 0.65, -a * 0.35);
      ex = over();
    }
  };
  // the hips (and all of the body) let down into the cushion, at most to max all told
  const sinkTo = (max) => {
    const s = Math.min(max - sunk, ex);
    if (s <= 0) return;
    sunk += s;
    b.hips.position.copy(b.hips.parent.worldToLocal(_rP.setFromMatrixPosition(b.hips.matrixWorld).addScaledVector(U, -s)));
    b.hips.updateMatrixWorld(true);
    ex = over();
  };
  leanTo(o.wheel ? 0 : LEAN);
  // (a passenger no lower than before the seats went up, as the traffic's, then leant back further; you at the wheel
  // as low as your heels allow first, the slouch after, so your feet stay nearer the pedals)
  sinkTo(o.wheel ? sinkMax : Math.min(SEAT_LIFT, sinkMax));
  leanTo(LEAN_HARD);
  sinkTo(sinkMax);
  if (o.wheel) {
    // (the slouch: the hips slid forward along the car as far as the shoulders went back; the head's height as it is)
    const dz = sh0 - shoulders();
    if (dz > 0) {
      b.hips.position.copy(b.hips.parent.worldToLocal(_rP.setFromMatrixPosition(b.hips.matrixWorld).addScaledVector(_rC.set(0, 0, 1).applyQuaternion(_rq2), dz)));
      b.hips.updateMatrixWorld(true);
    }
  }
  return Math.max(0, ex);
}

// A seated rig's legs in a car seat, the same for you at the wheel (drive.js placeRig), you riding with someone
// (net/carride.js), the other players in their cars (net/remote.js carLegs), the taxi's passenger and the traffic's
// baked people (Oct 31 2026, the user: "you still don't sit properly on a chair, please fix it"): the thighs out of the
// seat rising a little to the knees, the shins down and forward into the footwell, the heels on that car's floor (SEATS
// floor), the boots nearly flat (the driver's right on the throttle, toes up). Before: a fixed point 0.74 m ahead and
// 0.26 m below the pelvis, as far as the legs reach, so they went out dead straight from the hips; the ski boots are
// skinned mostly to the shins, so they turned with them and stood straight up, toes to the roof: from the driver's eyes
// two stiff legs with the boots raised toward the windscreen. Now the shin's slope is chosen (~34 degrees from upright in
// the front, ~20 in the back, the boots follow it about half) and the thigh takes up the rest of the drop from the hip
// to the heel; where that would lift the knee into the steering wheel (a low sports car: the Taycan, the Huracan, the
// hips hardly above the heels) or more than 0.2 m over the hip, the shins slope out further instead.
// g: the car (an Object3D: its frame, +z forward, +x the driver's left); null: the rig's own world is that frame (the
// bake). t: its template (the floor from seatsFor, the wheel) or o.floor (the frame's y). seat: 0 the driver, 1 the
// front passenger, 2.. the back. o.driver: the feet on the pedals, the knees under the wheel; o.hands: the hands back on
// the thighs (the 'sit' pose rested them where its own thighs were); o.roof false: the head not fitted under the roof
// here (underRoof, called before).
const _lq = new THREE.Quaternion(), _lq2 = new THREE.Quaternion(), _lq3 = new THREE.Quaternion(), _lJ = new THREE.Vector3(), _lK = new THREE.Vector3();
const _lT = new THREE.Vector3(), _lP = new THREE.Vector3(), _lU = new THREE.Vector3(), _lA = new THREE.Vector3(), _lB = new THREE.Vector3(), _lE = new THREE.Euler();
const SOLE = 0.2; // (m) the ankle joint over the floor with the boot's heel on it (the heel is skinned to the shin and swings down behind as it slopes; measured on the rigs in each car)
export function seatLegs(rig, g, t, seat = 0, o = {}) {
  const b = rig?.b;
  if (!b?.hips || !b.lUp || !b.rUp || !b.lLeg || !b.rLeg || !b.lFoot || !b.rFoot) return;
  // (the head under this car's roof first, leant back as far as that takes: underRoof; o.roof false: done already,
  // drive.js before the hands go to the wheel. Oct 31 2026, the head through the roof after the seats went up)
  if (t && o.roof !== false) underRoof(rig, g, t, seat);
  rig.root.updateMatrixWorld(true);
  if (g) { g.updateMatrixWorld(true); g.getWorldQuaternion(_lq); } else _lq.identity();
  const S = t ? seatsFor(t) : null, front = seat < 2;
  const floor = o.floor ?? (S?.floor ? (front ? S.floor[0] : S.floor[1] ?? S.floor[0]) : null);
  const Lt = wpos(b.lUp).distanceTo(wpos(b.lLeg)), Ls = wpos(b.lLeg).distanceTo(wpos(b.lFoot));
  // (the steering wheel rim's lowest point, the driver's knees a hand under it)
  const W = o.driver && t?.steering?.c ? t.steering.c.y - (t.steering.rimR ?? 0.185) * Math.cos(t.steering.tilt ?? 0.38) : null;
  for (const [i, up, leg, foot] of [[0, b.lUp, b.lLeg, b.lFoot], [1, b.rUp, b.rLeg, b.rFoot]]) {
    const side = i === 0 ? 1 : -1; // (+x: the figure's left)
    const J = _lJ.setFromMatrixPosition(up.matrixWorld);
    if (g) g.worldToLocal(J);
    // the drop from the hip joint to the ankle, the heel on the floor (no floor known: an average car's)
    const dy = Math.min(0.5, Math.max(-0.05, floor != null ? J.y - floor - SOLE : 0.15));
    const rise = Math.max(0.06, Math.min(0.2, W != null ? W - 0.07 - J.y : 0.2)); // (the knee joint over the hip joint, at most)
    let phi = front ? 0.6 : 0.35; // (the shin from upright, rad)
    phi = Math.max(phi, Math.acos(Math.min(1, (rise + dy) / Ls)));
    phi = Math.min(phi, 1.25);
    const th = Math.asin(Math.min(0.6, Math.max(-0.8, (dy - Ls * Math.cos(phi)) / Lt))); // (the thigh's pitch, down > 0)
    const K = _lK.set(J.x + side * 0.02, J.y - Lt * Math.sin(th), J.z + Lt * Math.cos(th));
    _lT.set(K.x + side * 0.01, K.y - Ls * Math.cos(phi), K.z + Ls * Math.sin(phi));
    // the pole: the knee exactly there (from the middle of the hip-to-ankle line)
    _lP.addVectors(J, _lT).multiplyScalar(0.5).sub(K).negate();
    if (g) { g.localToWorld(_lT); _lP.applyQuaternion(_lq); }
    try { twoBone(up, leg, foot, _lT, _lP); } catch { continue; } // (the pose stays as the rig made it)
    // the boot: ahead along the car, toes up about half the shin's slope (skinned half to the shin: never bent double)
    const fr = rig.footRest?.[i === 0 ? 'l' : 'r'];
    if (fr && foot.parent) {
      const pitch = -phi * 0.5 + 0.08 - (o.driver && i === 1 ? 0.12 : 0);
      setWQ(foot, _lq2.copy(_lq).multiply(_lq3.setFromEuler(_lE.set(pitch, -side * 0.07, 0, 'YXZ'))).multiply(fr));
    }
  }
  if (!o.hands || !b.lArm || !b.rArm) return;
  // the hands resting on the thighs as they are now, the elbows out and back, palms down (as skier.js poseSit)
  _lU.set(0, 1, 0).applyQuaternion(_lq);
  for (const [i, arm, fore, hand, up, leg] of [[0, b.lArm, b.lFore, b.lHand, b.lUp, b.lLeg], [1, b.rArm, b.rFore, b.rHand, b.rUp, b.rLeg]]) {
    if (!fore || !hand) continue;
    const side = i === 0 ? 1 : -1, Jw = wpos(up), Kw = wpos(leg);
    const tgt = _lA.copy(Jw).lerp(Kw, 0.55).addScaledVector(_lU, 0.1);
    try { twoBone(arm, fore, hand, tgt, _lB.set(side, -1, -0.4).normalize().applyQuaternion(_lq)); } catch { continue; }
    if (rig.aimHand) rig.aimHand(i, Kw.sub(Jw).normalize().addScaledVector(_lU, -0.2), _lU.clone().negate());
  }
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
    const O = S ? originAt(S.d[0], S.d.slice(1), hip, chest) : null;
    // legs to the floor ahead (seatLegs: knees bent, heels on that model's floor, feet flat; a passenger, baked for any
    // car, and the plain driver: an average car's floor, ~0.2 m under the cushion), so no boot pokes out under the car
    seatLegs(rig, null, null, driver ? 0 : 1, { driver, floor: S ? S.floor[0] - O.y : -0.19 - SEAT_LIFT });
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
