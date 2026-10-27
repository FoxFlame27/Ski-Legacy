// Procedurally animated skier built on a Meshy-rigged character.
// Feet are IK-locked to the skis and hands grip the poles. Carving inclines the whole body into the
// turn with hip angulation and upper-body counter-rotation; pole plants are timed with turn
// initiation; hockey stops turn skis and legs across the slope; landings are absorbed and jumps are
// crouch-charged. Tricks rotate the whole skier (skis and poles included) about the center of mass,
// grabs bring a hand to a ski, and crashes tumble over the snow (a ground solver keeps the body on
// the surface) before the skier gets back up. Walking, running, idling and sitting are animated
// procedurally as well (foot-planted IK gait), so no canned clips are needed. Standing idle is a
// relaxed stance: arms hanging by the thighs, weight shifting from leg to leg, breathing.
// In first person (player only) the body stays visible below the eye (head collapsed, arms folded away)
// and a view model of gloved hands holding their poles rides on the camera (updateFpView).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from '../world/world.js';
import { fitModel, dequantize } from '../core/assets.js';
import { clamp, lerp } from '../core/noise.js';
import { FootGait } from './gait.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
// scratch objects for the trick / fall body transforms (never shared with the IK helpers above)
const _rp = new THREE.Vector3(), _rc = new THREE.Vector3(), _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
const _gp = new THREE.Vector3(), _gu = new THREE.Vector3(), _gf = new THREE.Vector3(), _gl = new THREE.Vector3();
const _rq = new THREE.Quaternion(), _rqa = new THREE.Quaternion(), _rqb = new THREE.Quaternion(), _rqc = new THREE.Quaternion();

// Grabs: which hand reaches which ski (0 left, 1 right), where along it (m in front of the boot),
// outer (+1) or inner (-1) edge, how far the knees pull up, extra hip flex, skis pulled back (m),
// ski pitch (+ tips up) and the shoulder twist toward the grab.
const GRAB_POSES = {
  mute: { hand: 1, ski: 0, along: 0.14, out: 1, lift: 0.42, flex: 0.42, feetF: 0, pitch: 0.06, twist: 0.3 },
  safety: { hand: 1, ski: 1, along: -0.02, out: 1, lift: 0.38, flex: 0.36, feetF: 0, pitch: 0.12, twist: -0.12 },
  japan: { hand: 0, ski: 1, along: 0.12, out: 1, lift: 0.45, flex: 0.48, feetF: -0.14, pitch: -0.28, twist: -0.32 },
};

// Crash poses in the skier's upright frame (relative to the feet; the fall rotation lays them on
// the snow): hips height/forward, pelvis flex, spine curl, feet height/forward/half-width, knees out,
// neck (+ lifts the head) and the two hand targets relative to the shoulders [fwd, up, side] for
// the arm on the side the body falls toward (g) and the other one (t).
const FALL_POSES = {
  lie: { hipH: 0.8, hipF: -0.04, flex: 0.42, curl: 0.12, footH: 0.06, footF: 0.24, footW: 0.13, knee: 0.18, neck: -0.05, g: [0.12, 0.32, 0.36], t: [0.3, -0.48, 0.02] },
  ball: { hipH: 0.6, hipF: -0.05, flex: 1.05, curl: 0.45, footH: 0.26, footF: 0.2, footW: 0.12, knee: 0.42, neck: -0.35, g: [0.36, -0.44, -0.02], t: [0.36, -0.44, -0.02] },
  crouch: { hipH: 0.5, hipF: -0.1, flex: 0.95, curl: 0.18, footH: 0, footF: 0.05, footW: 0.15, knee: 0.3, neck: 0.25, g: [0.32, -0.62, 0.3], t: [0.32, -0.46, 0.12] },
  stand: { hipH: 0, hipF: -0.03, flex: 0.36, curl: 0, footH: 0, footF: 0, footW: 0.13, knee: 0.15, neck: 0.25, g: [0.3, -0.36, 0.07], t: [0.3, -0.36, 0.07] },
};
const FALL_KEYS = ['hipH', 'hipF', 'flex', 'curl', 'footH', 'footF', 'footW', 'knee', 'neck'];
function mixPose(out, a, b, t) {
  for (const k of FALL_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  for (const k of ['g', 't']) { out[k] ??= [0, 0, 0]; for (let i = 0; i < 3; i++) out[k][i] = a[k][i] + (b[k][i] - a[k][i]) * t; }
  return out;
}

const BONES = {
  hips: 'Hips', spine0: 'Spine02', spine1: 'Spine01', spine2: 'Spine', neck: 'neck', head: 'Head',
  lSh: 'LeftShoulder', rSh: 'RightShoulder',
  lArm: 'LeftArm', lFore: 'LeftForeArm', lHand: 'LeftHand', rArm: 'RightArm', rFore: 'RightForeArm', rHand: 'RightHand',
  lUp: 'LeftUpLeg', lLeg: 'LeftLeg', lFoot: 'LeftFoot', rUp: 'RightUpLeg', rLeg: 'RightLeg', rFoot: 'RightFoot',
};

function worldPos(o, out) { return out.setFromMatrixPosition(o.matrixWorld); }
function worldQuat(o, out) { o.matrixWorld.decompose(_v4, out, _v3); return out; }

function setWorldQuat(bone, q) {
  worldQuat(bone.parent, _q3);
  bone.quaternion.copy(_q3.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
function rotateWorld(bone, axis, angle) {
  worldQuat(bone, _q2);
  _q1.setFromAxisAngle(axis, angle).multiply(_q2);
  setWorldQuat(bone, _q1);
}

// Exact two-bone IK: place the middle joint on the circle of valid positions toward `pole`,
// then aim the upper bone at it and the lower bone at the target (minimal-twist rotations).
const _ik = { pa: new THREE.Vector3(), pb: new THREE.Vector3(), pc: new THREE.Vector3(), d: new THREE.Vector3(), p: new THREE.Vector3(), k: new THREE.Vector3(), u: new THREE.Vector3(), w: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
  pb2: new THREE.Vector3(), pc2: new THREE.Vector3(), end: new THREE.Vector3() };
// scratch for the skiing pose / gear (poseSki, updateGear, aimHand, relaxShoulders): no per-frame allocations
const _s = Array.from({ length: 14 }, () => new THREE.Vector3());
const _sq = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
const _ah = { q: new THREE.Quaternion(), d: new THREE.Vector3(), c: new THREE.Vector3(), n: new THREE.Vector3(), t: new THREE.Vector3(), x: new THREE.Vector3(), s: new THREE.Quaternion() };
const _sk = { up: new THREE.Vector3(), f: new THREE.Vector3(), r: new THREE.Vector3(), q: new THREE.Quaternion() };
const _bq = new THREE.Quaternion(), _bp = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
function aimBone(bone, from, to, pivot) {
  const u = _ik.u.subVectors(from, pivot).normalize();
  const w = _ik.w.subVectors(to, pivot).normalize();
  if (u.lengthSq() < 1e-8 || w.lengthSq() < 1e-8) return;
  _ik.q.setFromUnitVectors(u, w);
  worldQuat(bone, _ik.q2);
  setWorldQuat(bone, _ik.q.multiply(_ik.q2));
}
function solveTwoBone(a, b, c, target, pole) {
  const pa = worldPos(a, _ik.pa), pb = worldPos(b, _ik.pb), pc = worldPos(c, _ik.pc);
  const lab = pa.distanceTo(pb), lcb = pb.distanceTo(pc);
  const dir = _ik.d.subVectors(target, pa);
  const dist = clamp(dir.length(), Math.abs(lab - lcb) + 1e-3, (lab + lcb) * 0.9995);
  dir.normalize();
  const cosA = clamp((lab * lab + dist * dist - lcb * lcb) / (2 * lab * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pp = _ik.p.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (pp.lengthSq() < 1e-8) pp.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pp.normalize();
  const knee = _ik.k.copy(pa).addScaledVector(dir, lab * cosA).addScaledVector(pp, lab * sinA);
  aimBone(a, pb, knee, pa);
  const pb2 = worldPos(b, _ik.pb2), pc2 = worldPos(c, _ik.pc2);
  const end = _ik.end.copy(pa).addScaledVector(dir, dist);
  aimBone(b, pc2, end, pb2);
}

// Symmetric 3x3 eigen-decomposition (Jacobi). Returns eigenvectors sorted by eigenvalue (desc).
function eigen3(m) {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1;
    if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
    if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
    if (Math.abs(a[p][q]) < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return idx.map((i) => new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize());
}

// Ski frames. The Meshy skis are modelled with their length along the file's X axis and +Y up (binding on
// top), so the file axes are used as they are; guessing the frame from the shape flipped several of them
// upside down or onto an edge. A model can note its tip end (or an up axis other than +Y); without a note
// the tip is the end that curls up more (+X when both curl alike).
const SKI_FRAMES = {
  ski_park: { tip: '-x' }, // the long yellow shovel
};
const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

// Orient a ski model: tip forward along +Z, binding up (+Y), the base of the ski on y = 0.
const skiCache = new Map();
function orientedSkiTemplate(gltf) {
  if (skiCache.has(gltf)) return skiCache.get(gltf);
  let mesh = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  const geo = dequantize(mesh.geometry);
  geo.applyMatrix4(mesh.matrixWorld);
  const tpl = gltf.modelName ? fileFrameSki(geo, SKI_FRAMES[gltf.modelName] || {}) : guessedFrameSki(geo);
  tpl.mat = mesh.material;
  skiCache.set(gltf, tpl);
  return tpl;
}

function fileFrameSki(geo, frame) {
  const up = new THREE.Vector3(...AXES[frame.up || '+y']);
  const len = new THREE.Vector3(...AXES[frame.tip || '+x']);
  const wid = new THREE.Vector3().crossVectors(up, len).normalize();
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(wid, up, len).transpose()); // file -> ski frame
  geo.computeBoundingBox();
  let bb = geo.boundingBox;
  const s = SKI_LENGTH / (bb.max.z - bb.min.z);
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  bb = geo.boundingBox;
  geo.translate(-(bb.max.x + bb.min.x) / 2, 0, -(bb.max.z + bb.min.z) / 2);
  // real skis are 7-11 cm wide; several generated models are twice that (a pair on your back read as a slab)
  const wide = bb.max.x - bb.min.x;
  if (wide > SKI_MAX_WIDTH) geo.scale(SKI_MAX_WIDTH / wide, 1, 1);
  // the base: the underside of the flat sections between binding and shovels (a binding plate or brake
  // hanging below the middle must not lift the whole ski off the snow)
  const p = geo.attributes.position, h = SKI_LENGTH / 2;
  let base = Infinity, tipUp = -Infinity, tailUp = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const az = Math.abs(p.getZ(i)) / h;
    if (az > 0.2 && az < 0.6) base = Math.min(base, p.getY(i));
  }
  if (!Number.isFinite(base)) base = bb.min.y;
  geo.translate(0, -base, 0);
  if (!frame.tip) {
    // no note: the tip is the end that curls up more (the long shovel); +X when both curl alike
    for (let i = 0; i < p.count; i++) {
      const u = p.getZ(i) / h, y = p.getY(i);
      if (u > 0.93) tipUp = Math.max(tipUp, y); else if (u < -0.93) tailUp = Math.max(tailUp, y);
    }
    if (tailUp > tipUp * 1.15 + 0.004) geo.rotateY(Math.PI);
  }
  geo.computeBoundingBox();
  return { geo };
}

// Fallback for a ski model of unknown origin: longest axis -> +Z, thinnest -> +Y (binding up).
function guessedFrameSki(geo) {
  const p = geo.attributes.position;
  const n = p.count, c = new THREE.Vector3();
  for (let i = 0; i < n; i++) { c.x += p.getX(i); c.y += p.getY(i); c.z += p.getZ(i); }
  c.divideScalar(n);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const t = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    t.set(p.getX(i) - c.x, p.getY(i) - c.y, p.getZ(i) - c.z);
    const arr = [t.x, t.y, t.z];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) cov[r][k] += arr[r] * arr[k];
  }
  const [len, , thk] = eigen3(cov);
  let minL = Infinity, maxL = -Infinity;
  const L = new Float32Array(n), T = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t.set(p.getX(i) - c.x, p.getY(i) - c.y, p.getZ(i) - c.z);
    L[i] = t.dot(len); T[i] = t.dot(thk);
    minL = Math.min(minL, L[i]); maxL = Math.max(maxL, L[i]);
  }
  const span = maxL - minL;
  // the binding sticks out on the top side near the middle
  let midMax = -Infinity, midMin = Infinity;
  for (let i = 0; i < n; i++) {
    if (Math.abs(L[i] - (minL + span / 2)) < span * 0.12) { midMax = Math.max(midMax, T[i]); midMin = Math.min(midMin, T[i]); }
  }
  const sT = midMax >= -midMin ? 1 : -1;
  if (sT < 0) thk.negate();
  // tip = the end that curls up the most
  let upA = -Infinity, upB = -Infinity;
  for (let i = 0; i < n; i++) {
    if (L[i] > maxL - span * 0.06) upA = Math.max(upA, T[i] * sT);
    if (L[i] < minL + span * 0.06) upB = Math.max(upB, T[i] * sT);
  }
  if (upB > upA) len.negate();
  const wid = new THREE.Vector3().crossVectors(thk, len).normalize();
  const rot = new THREE.Matrix4().makeBasis(wid, thk, len).transpose(); // source -> oriented
  geo.translate(-c.x, -c.y, -c.z);
  geo.applyMatrix4(rot);
  geo.computeBoundingBox();
  const s = SKI_LENGTH / (geo.boundingBox.max.z - geo.boundingBox.min.z);
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);
  return { geo };
}

export const SKI_LENGTH = 1.68;
const SKI_MAX_WIDTH = 0.11; // m, binding included
const POLE_LEN = 1.25;

export function makeSki(gltf) {
  const { geo, mat } = orientedSkiTemplate(gltf);
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return g;
}

// lod: also carry a light stand-in (aiPoleGeometry), shown instead of the model while setPoleDetail(false)
export function makePole(gltf, lod = false) {
  const g = new THREE.Group();
  const m = fitModel(gltf, { size: POLE_LEN, axis: 'y' });
  m.position.y = -POLE_LEN + 0.08; // origin at the grip, shaft hangs down -Y
  g.add(m);
  if (lod) {
    const P = aiPoleGeometry(), lo = new THREE.Mesh(P.geo, P.mat);
    lo.castShadow = false; lo.receiveShadow = false; lo.visible = false;
    g.add(lo);
    g.userData.hi = m; g.userData.lo = lo;
  }
  return g;
}

// The pole model's light stand-in for AI skiers away from the camera (a few pixels wide there): the model's
// proportions (fitModel puts its shaft 3 cm off the grip's origin; the T-grip and the cup-shaped basket stick out
// to the sides) and colours (dark grip with a yellow cap, alloy shaft with a dark band, black basket) in one mesh
// with vertex colours, ~170 triangles, shared by every rig.
let aiPoleParts = null;
function aiPoleGeometry() {
  if (aiPoleParts) return aiPoleParts;
  const parts = [];
  const add = (g, color, x = 0, y = 0, z = 0, sx = 1, sz = 1) => {
    g.scale(sx, 1, sz); g.translate(x, y, z);
    const ng = g.index ? g.toNonIndexed() : g;
    ng.deleteAttribute('uv');
    const c = new THREE.Color(color), n = ng.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(ng);
  };
  const X = -0.033; // the shaft's axis
  add(new THREE.CylinderGeometry(0.0085, 0.008, 0.57, 8, 1, true), 0xb4bcc6, X, -0.555); // alloy shaft
  add(new THREE.CylinderGeometry(0.0095, 0.0095, 0.1, 8, 1, true), 0x1b1c20, X, -0.45); // dark band
  add(new THREE.CylinderGeometry(0.008, 0.0068, 0.31, 8, 1, true), 0x5d636b, X, -0.995); // lower shaft
  add(new THREE.ConeGeometry(0.0065, 0.04, 8).rotateX(Math.PI), 0x8d949c, X, -1.15); // steel tip, pointing down
  add(new THREE.CylinderGeometry(0.024, 0.02, 0.27, 8), 0x1b1c20, -0.058, -0.135, 0, 1, 0.8); // grip
  add(new THREE.BoxGeometry(0.2, 0.06, 0.048), 0x1b1c20, -0.045, 0.04); // T-handle
  add(new THREE.BoxGeometry(0.2, 0.012, 0.05), 0xe2b21e, -0.045, 0.074); // its yellow cap
  add(new THREE.CylinderGeometry(0.095, 0.075, 0.12, 10, 1, true), 0x141518, 0.052, -0.785, 0, 1, 0.82); // basket cup
  add(new THREE.CircleGeometry(0.075, 10).rotateX(Math.PI / 2), 0x141518, 0.052, -0.845, 0, 1, 0.82); // its bottom
  const geo = mergeGeometries(parts, false);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  aiPoleParts = { geo, mat };
  return aiPoleParts;
}

// Per character model: hand shape, hip width, back / seat depth (see measureHips, measureCarry).
const BODY_CACHE = new WeakMap();

// First-person hand (view model): a ski glove closed round the pole grip. Built in the grip's frame for a LEFT
// hand: +Y up the pole, +Z the way the knuckles face, +X the back of the hand (outward); the right hand is the
// mirror image. Padded fingers curl round the grip (index on top), a knuckle guard, the thumb over the top. The
// gauntlet cuff is a separate piece hinged at the wrist (fpCuffGeometry). Geometry and materials are shared.
let fpHandParts = null;
const FP_WRIST = new THREE.Vector3(0.024, -0.012, -0.068); // wrist joint in the fist's frame
function fpHandGeometry() {
  if (fpHandParts) return fpHandParts;
  const shell = [], guard = [], trim = [];
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1);
  const put = (list, g, x, y, z, rx = 0, ry = 0, rz = 0) => { list.push(g.applyMatrix4(M.compose(P.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), ONE))); };
  // a capsule between two points
  const limb = (list, a, b, r) => {
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len), 5, 12);
    Q.setFromUnitVectors(UP, d.normalize());
    list.push(g.applyMatrix4(M.compose(P.copy(a).lerp(b, 0.5), Q, ONE)));
  };
  // fingers: padded rolls round the grip from the knuckles (front-outer corner) over the front and the inner side
  // to the palm, index on top; rounded tips
  const R = 0.03, A0 = 0.42, ARC = 4.75;
  for (const [y, r] of [[0.031, 0.0128], [0.0085, 0.0134], [-0.0145, 0.0128], [-0.0355, 0.0112]]) {
    const g = new THREE.TorusGeometry(R, r, 10, 26, ARC);
    g.rotateX(Math.PI / 2); // the ring round +Y, the arc running from +X toward +Z
    g.rotateY(-A0);
    g.translate(0, y, 0);
    shell.push(g);
    const a = A0 + ARC, tip = new THREE.SphereGeometry(r, 12, 8);
    put(shell, tip, Math.cos(a) * R, y, Math.sin(a) * R);
  }
  // back of the hand, from the knuckles to the wrist (knuckles a little higher than the wrist)
  put(shell, new RoundedBoxGeometry(0.034, 0.092, 0.088, 3, 0.015), 0.033, -0.003, -0.02, -0.18, 0, 0);
  // knuckle guard: a firmer padded panel over the front-outer corner of the fist
  put(guard, new RoundedBoxGeometry(0.014, 0.078, 0.03, 3, 0.0068), 0.037, 0.0, 0.017, -0.12, -0.55, 0);
  // thumb: the thenar pad by the wrist, then over the top of the grip to rest on the index finger
  const t0 = new THREE.Vector3(0.024, 0.028, -0.05), t1 = new THREE.Vector3(0.006, 0.047, -0.016), t2 = new THREE.Vector3(-0.021, 0.05, 0.012);
  limb(shell, t0, t1, 0.0165);
  limb(shell, t1, t2, 0.0128);
  // the wrist: a rounded joint the cuff turns on
  put(shell, new THREE.SphereGeometry(0.036, 18, 12), FP_WRIST.x, FP_WRIST.y, FP_WRIST.z);
  const merge = (list) => { const g = mergeGeometries(list.map((x) => (x.index ? x.toNonIndexed() : x)).map((x) => { x.deleteAttribute('uv'); return x; }), false); g.computeBoundingSphere(); return g; };
  // gauntlet cuff, from the wrist (origin) up the forearm along +Y: soft and widening, an elastic band at the
  // wrist, a cinch strap, a rolled rim
  const cuffLen = 0.21, cuff = new THREE.CylinderGeometry(0.051, 0.0375, cuffLen, 22, 3, false);
  cuff.translate(0, cuffLen / 2, 0);
  const ring = (list, y, rad, tube) => { const g = new THREE.TorusGeometry(rad, tube, 8, 28); g.rotateX(Math.PI / 2); g.translate(0, y, 0); list.push(g); };
  const cShell = [cuff], cGuard = [], cTrim = [];
  ring(cTrim, 0.012, 0.0385, 0.0072); // elastic wrist band
  ring(cGuard, 0.125, 0.0465, 0.0045); // cinch strap
  ring(cTrim, cuffLen, 0.0512, 0.0062); // rolled rim
  fpHandParts = {
    shell: merge(shell), guard: merge(guard), cuffShell: merge(cShell), cuffGuard: merge(cGuard), cuffTrim: merge(cTrim),
    mShell: fpMaterial({ color: 0x33363c, roughness: 0.84, metalness: 0 }),
    mGuard: fpMaterial({ color: 0x626973, roughness: 0.48, metalness: 0 }),
    mTrim: fpMaterial({ color: 0x17191d, roughness: 0.62, metalness: 0 }),
  };
  return fpHandParts;
}

// View-model materials: the helmet lamp (a spot light a few cm above the eye, falling off with the square of the
// distance) would light hands half a metre away ~40x brighter than the snow it is meant for and turn dark gloves
// white at night, so spot lights reach the view model at a few percent (about what the snow ahead gets).
function fpMaterial(params) {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
      'getSpotLightInfo( spotLight, geometryPosition, directLight );', 'getSpotLightInfo( spotLight, geometryPosition, directLight );\n\t\tdirectLight.color *= 0.05;'));
  };
  m.customProgramCacheKey = () => 'fp-view-model';
  return m;
}

// First-person ski pole, seen up close in the fist: a moulded grip with finger ridges and a rounded knob with an
// accent ring (the third-person pole's T-handle reads as a hammer head from above), a slim alloy shaft with dark
// bands, a small basket and a steel tip. Origin in the middle of the grip (where the fist closes), shaft down -Y.
let fpPoleParts = null;
function fpPoleGeometry() {
  if (fpPoleParts) return fpPoleParts;
  const V2 = (r, y) => new THREE.Vector2(r, y);
  const grip = new THREE.LatheGeometry([
    V2(0.0001, -0.142), V2(0.0089, -0.142), V2(0.0175, -0.12), V2(0.0212, -0.103), V2(0.0196, -0.088), V2(0.0168, -0.062),
    V2(0.0178, -0.042), V2(0.0168, -0.021), V2(0.0178, 0.0), V2(0.0168, 0.021), V2(0.018, 0.04), V2(0.0192, 0.055),
    V2(0.0228, 0.066), V2(0.0238, 0.076), V2(0.0222, 0.087), V2(0.0165, 0.094), V2(0.008, 0.0975), V2(0.0001, 0.098),
  ], 28);
  const ring = new THREE.TorusGeometry(0.0232, 0.0033, 8, 32); ring.rotateX(Math.PI / 2); ring.translate(0, 0.0705, 0);
  const shaft = new THREE.CylinderGeometry(0.0088, 0.0066, 1.0, 14, 1, true); shaft.translate(0, -0.642, 0);
  const band = (y, len, r) => { const g = new THREE.CylinderGeometry(r, r, len, 14, 1, true); g.translate(0, y, 0); return g; };
  const basket = new THREE.CylinderGeometry(0.048, 0.044, 0.007, 24, 1, false); basket.translate(0, -1.065, 0);
  const rim = new THREE.TorusGeometry(0.048, 0.0035, 6, 28); rim.rotateX(Math.PI / 2); rim.translate(0, -1.062, 0);
  const tip = new THREE.ConeGeometry(0.0062, 0.05, 10); tip.rotateX(Math.PI); tip.translate(0, -1.167, 0);
  const merge = (list) => { const g = mergeGeometries(list.map((x) => (x.index ? x.toNonIndexed() : x)).map((x) => { x.deleteAttribute('uv'); return x; }), false); g.computeBoundingSphere(); return g; };
  fpPoleParts = {
    dark: merge([grip, band(-0.3, 0.13, 0.0094), band(-1.02, 0.06, 0.0078), basket, rim]), accent: merge([ring]), shaft: merge([shaft]), tip: merge([tip]),
    mDark: fpMaterial({ color: 0x1c1e23, roughness: 0.72, metalness: 0 }),
    mAccent: fpMaterial({ color: 0xe2b21e, roughness: 0.42, metalness: 0 }),
    mShaft: fpMaterial({ color: 0xd6dde5, roughness: 0.3, metalness: 0.55 }),
    mTip: fpMaterial({ color: 0x8d949c, roughness: 0.28, metalness: 0.85 }),
  };
  return fpPoleParts;
}

// One hand of the view model: the fist and its pole are one rigid piece (the pole can't leave the glove); the cuff
// hangs from the wrist. Returns { root, glove, pole, cuff }: root's origin is the middle of the grip (mirrored
// for the right hand); the cuff's origin is the wrist, its +Y up the forearm.
function makeFpHand(right) {
  const P = fpHandGeometry(), Q = fpPoleGeometry();
  const root = new THREE.Group();
  const glove = new THREE.Group();
  glove.add(new THREE.Mesh(P.shell, P.mShell), new THREE.Mesh(P.guard, P.mGuard));
  const pole = new THREE.Group();
  pole.add(new THREE.Mesh(Q.dark, Q.mDark), new THREE.Mesh(Q.accent, Q.mAccent), new THREE.Mesh(Q.shaft, Q.mShaft), new THREE.Mesh(Q.tip, Q.mTip));
  root.add(glove, pole);
  if (right) root.scale.x = -1;
  const cuff = new THREE.Group();
  cuff.add(new THREE.Mesh(P.cuffShell, P.mShell), new THREE.Mesh(P.cuffGuard, P.mGuard), new THREE.Mesh(P.cuffTrim, P.mTrim));
  for (const g of [root, cuff]) g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
  return { root, glove, pole, cuff };
}

// The view model's arm: Meshy's gloved hand and forearm (driving_hand_c: a left fist closed round a bar, thumb on top,
// the jacket sleeve over the forearm; the right arm is its mirror image), one rigid piece with the pole through the
// fist. Read into the fist's frame (makeFpHand: +Y up the pole, +Z knuckles, +X back of the hand; the forearm leaves
// back along -Z and a little down the pole, a natural wrist), the grip hole at the origin, 0.42 m from the knuckles to
// the sleeve's end (closed: it never shows hollow). Glove and sleeve are recoloured (your character's gloves, your
// jacket) over the model's own shading: the texture's luminance against its median keeps every seam, fold and
// stitch, the normal map stays. Until it has loaded (or if it can't), the procedural fists above stand in.
let fpArmTpl = null, fpArmReq = false;
const FP_ARM_CUT = 0.5; // glove -> sleeve along the arm, as a share of its length from the knuckles (the sleeve's cuff)
function fpArmTemplate() {
  if (!fpArmReq) {
    fpArmReq = true;
    import('../core/assets.js').then((m) => m.loadGLB('driving_hand_c')).then((gltf) => {
      try { fpArmTpl = gltf ? buildFpArm(gltf) : null; } catch (e) { console.warn('first-person arm', e); fpArmTpl = null; }
    }).catch(() => { fpArmTpl = null; });
  }
  return fpArmTpl;
}
const srgbLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function buildFpArm(gltf) {
  let src = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  if (!src) return null;
  const geo = dequantize(src.geometry);
  geo.applyMatrix4(src.matrixWorld);
  // grip axis (toward the thumb) and forearm (fist -> sleeve) in the model, as game/drive.js measured them
  const Gm = new THREE.Vector3(-1, 0, 0), Fm = new THREE.Vector3(0.65, 0.42, -0.63).normalize();
  const P = geo.attributes.position, UV = geo.attributes.uv, n = P.count, v = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const d = v.fromBufferAttribute(P, i).dot(Fm); if (d < lo) lo = d; if (d > hi) hi = d; }
  geo.computeBoundingBox();
  const cc = geo.boundingBox.getCenter(new THREE.Vector3()), L = hi - lo;
  const hole = cc.clone().addScaledVector(Fm, lo + L * 0.16 - cc.dot(Fm));
  // per vertex its share of the length from the knuckles (glove | sleeve: split per pixel at FP_ARM_CUT, a crisp seam);
  // the sleeve's open end (its last 3 %) for the cap
  const sl = new Float32Array(n), end = new THREE.Vector3();
  let ne = 0, capUv = null;
  for (let i = 0; i < n; i++) {
    const t = (v.fromBufferAttribute(P, i).dot(Fm) - lo) / L;
    sl[i] = t;
    if (t > 0.97) { end.add(v); ne++; }
    if (!capUv && t > 0.74 && t < 0.76) capUv = [UV.getX(i), UV.getY(i)];
  }
  geo.setAttribute('aSleeve', new THREE.BufferAttribute(sl, 1));
  let full = geo;
  if (ne > 8) {
    end.multiplyScalar(1 / ne);
    let r = 0;
    for (let i = 0; i < n; i++) if ((v.fromBufferAttribute(P, i).dot(Fm) - lo) / L > 0.97) r += v.distanceTo(end);
    const cap = new THREE.CircleGeometry((r / ne) * 1.08, 20);
    cap.applyMatrix4(new THREE.Matrix4().compose(end.clone().addScaledVector(Fm, -L * 0.012), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), Fm), new THREE.Vector3(1, 1, 1)));
    const cu = cap.attributes.uv;
    for (let i = 0; i < cu.count; i++) cu.setXY(i, capUv ? capUv[0] : 0.5, capUv ? capUv[1] : 0.5);
    cap.setAttribute('aSleeve', new THREE.BufferAttribute(new Float32Array(cu.count).fill(1), 1));
    full = mergeGeometries([geo, cap], false) || geo;
  }
  const zm = Fm.clone().addScaledVector(Gm, -Fm.dot(Gm)).normalize().negate(), xm = new THREE.Vector3().crossVectors(Gm, zm);
  const k = 0.42 / L;
  full.applyMatrix4(new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeBasis(xm, Gm, zm).transpose())
    .multiply(new THREE.Matrix4().makeTranslation(-hole.x, -hole.y, -hole.z)));
  full.computeBoundingSphere();
  // the texture's median luminance under the glove and under the sleeve (the shading reference)
  const m0 = Array.isArray(src.material) ? src.material[0] : src.material, img = m0?.map?.image;
  const ref = [0.01, 0.01];
  try {
    if (img?.width) {
      const S = 256, cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, S, S);
      const px = g.getImageData(0, 0, S, S).data, lists = [[], []];
      for (let i = 0; i < n; i++) {
        const x = clamp(Math.floor(UV.getX(i) * S), 0, S - 1), y = clamp(Math.floor((m0.map.flipY === false ? UV.getY(i) : 1 - UV.getY(i)) * S), 0, S - 1), o = (y * S + x) * 4;
        if (Math.abs(sl[i] - FP_ARM_CUT) > 0.02) lists[sl[i] > FP_ARM_CUT ? 1 : 0].push(0.2126 * srgbLin(px[o]) + 0.7152 * srgbLin(px[o + 1]) + 0.0722 * srgbLin(px[o + 2]));
      }
      lists.forEach((l, j) => { if (l.length > 50) { l.sort((a, b) => a - b); ref[j] = Math.max(1e-3, l[l.length >> 1]); } });
    }
  } catch { /* (default references) */ }
  return { geo: full, map: m0?.map || null, normalMap: m0?.normalMap || null, normalScale: m0?.normalScale?.clone() || null, roughnessMap: m0?.roughnessMap || null, ref };
}
function fpArmMaterial(T) {
  const m = new THREE.MeshStandardMaterial({ map: T.map, normalMap: T.normalMap, roughnessMap: T.roughnessMap, roughness: T.roughnessMap ? 1 : 0.78, metalness: 0, side: THREE.DoubleSide });
  if (T.normalScale) m.normalScale.copy(T.normalScale);
  const U = { uGlove: { value: new THREE.Color(0x2a2d33) }, uSleeve: { value: new THREE.Color(0x1f6fd1) }, uRef: { value: new THREE.Vector2(T.ref[0], T.ref[1]) } };
  m.userData.fpArm = U;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'attribute float aSleeve;\nvarying float vSleeve;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvSleeve = aSleeve;');
    sh.fragmentShader = 'uniform vec3 uGlove;\nuniform vec3 uSleeve;\nuniform vec2 uRef;\nvarying float vSleeve;\n' + sh.fragmentShader
      .replace('#include <map_fragment>', [
        '#ifdef USE_MAP',
        '\tvec4 fpTexel = texture2D( map, vMapUv );',
        `\tfloat fpS = smoothstep( ${(FP_ARM_CUT - 0.004).toFixed(3)}, ${(FP_ARM_CUT + 0.004).toFixed(3)}, vSleeve );`,
        '\tfloat fpRel = dot( fpTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( mix( uRef.x, uRef.y, fpS ), 1e-4 );',
        '\tfloat fpTrim = smoothstep( 6.0, 14.0, fpRel ); // reflective piping, the press stud: their own colours',
        '\tdiffuseColor.rgb = mix( mix( uGlove, uSleeve, fpS ) * clamp( pow( fpRel, mix( 0.6, 0.85, fpS ) ), 0.35, 1.9 ), fpTexel.rgb, fpTrim );',
        '#endif',
      ].join('\n'))
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
        'getSpotLightInfo( spotLight, geometryPosition, directLight );', 'getSpotLightInfo( spotLight, geometryPosition, directLight );\n\t\tdirectLight.color *= 0.05;'));
  };
  m.customProgramCacheKey = () => 'fp-arm';
  return m;
}
// the main colour of the character's own texture where one bone carries the skin (the gloves: the hand; the sleeve:
// the forearm): the commonest colour, so a two-tone sleeve gives its main colour, not a muddy mix
const FP_RIG_COLOURS = new Map();
function fpRigColour(rig, key) {
  const mesh = rig.skinned, bone = rig.b[key];
  if (!mesh?.isSkinnedMesh || !bone) return null;
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material, img = mat?.map?.image;
  if (!img?.width) return null;
  const id = `${mesh.geometry.uuid}|${key}`;
  if (FP_RIG_COLOURS.has(id)) return FP_RIG_COLOURS.get(id);
  let out = null;
  try {
    const S = 256, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, S, S);
    const px = g.getImageData(0, 0, S, S).data;
    const bi = mesh.skeleton.bones.indexOf(bone), SI = mesh.geometry.attributes.skinIndex, SW = mesh.geometry.attributes.skinWeight, UV = mesh.geometry.attributes.uv;
    const bins = new Map();
    for (let i = 0; i < SI.count; i++) {
      let w = 0;
      for (let j = 0; j < 4; j++) if (SI.getComponent(i, j) === bi) w += SW.getComponent(i, j);
      if (w < 0.6) continue;
      const x = clamp(Math.floor(UV.getX(i) * S), 0, S - 1), y = clamp(Math.floor((mat.map.flipY === false ? UV.getY(i) : 1 - UV.getY(i)) * S), 0, S - 1), o = (y * S + x) * 4;
      const kb = ((px[o] >> 5) << 6) | ((px[o + 1] >> 5) << 3) | (px[o + 2] >> 5);
      const B = bins.get(kb) || { n: 0, r: 0, g: 0, b: 0 };
      B.n++; B.r += srgbLin(px[o]); B.g += srgbLin(px[o + 1]); B.b += srgbLin(px[o + 2]);
      bins.set(kb, B);
    }
    let best = null;
    for (const B of bins.values()) if (!best || B.n > best.n) best = B;
    if (best && best.n > 8) out = new THREE.Color(best.r / best.n, best.g / best.n, best.b / best.n);
  } catch { out = null; }
  FP_RIG_COLOURS.set(id, out);
  return out;
}
// OKLab (the outfit shader's jacket target) -> linear sRGB
function fpLabColour(L, a, b, out) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return out.setRGB(Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}

export class SkierRig {
  // fallback only: true plays the Meshy walk / run clips while moving on foot instead of the procedural gait
  static walkClips = true; // the user asked for the previous walk / run back (2026-10-26); the procedural gait stays for standing

  // poleLod (AI skiers): the poles carry a light stand-in too, swapped in by setPoleDetail(false)
  constructor(gltf, { ski, pole, clips = null, poleLod = false } = {}) {
    this.root = new THREE.Group();
    this.body = SkeletonUtils.clone(gltf.scene);
    this.root.add(this.body);
    this.body.traverse((o) => {
      if (o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; this.skinned = o; }
    });
    this.b = {};
    this.body.traverse((o) => {
      for (const [k, n] of Object.entries(BONES)) if (o.name === n && o.isBone) this.b[k] = o;
    });
    this.allBones = [];
    this.body.traverse((o) => { if (o.isBone) this.allBones.push(o); });
    this.rest = this.allBones.map((bn) => ({ q: bn.quaternion.clone(), p: bn.position.clone(), s: bn.scale.clone() }));

    this.root.updateMatrixWorld(true);
    const b = this.b;
    this.hipRest = worldPos(b.hips, new THREE.Vector3());
    this.ankleH = worldPos(b.lFoot, new THREE.Vector3()).y;
    // the hip joints sit below and beside the pelvis bone: leg reach is measured from the joints
    const lUp0 = worldPos(b.lUp, new THREE.Vector3());
    this.hipDrop = this.hipRest.y - lUp0.y; this.hipHalfW = Math.abs(lUp0.x - this.hipRest.x);
    this._joint = new THREE.Vector3();
    this.legLen = worldPos(b.lUp, _v1).distanceTo(worldPos(b.lLeg, _v2)) + worldPos(b.lLeg, _v1).distanceTo(worldPos(b.lFoot, _v2));
    this.footRest = { l: worldQuat(b.lFoot, new THREE.Quaternion()), r: worldQuat(b.rFoot, new THREE.Quaternion()) };
    this.shoulderW = worldPos(b.lArm, _v1).distanceTo(worldPos(b.rArm, _v2));
    this.eyeOffset = new THREE.Vector3(0, 0.08, 0.07); // just in front of the head bone: looking down shows your own body
    this.armLen = worldPos(b.lArm, _v1).distanceTo(worldPos(b.lFore, _v2)) + worldPos(b.lFore, _v1).distanceTo(worldPos(b.lHand, _v2));
    this.hipWidth = Math.abs(worldPos(b.lUp, _v1).x - worldPos(b.rUp, _v2).x);
    this.gait = { phase: Math.random(), move: 0, run: 0, t: Math.random() * 100 };
    // Hand shape from the skinned mesh: direction from wrist to fingers and the palm normal, stored in
    // hand-bone space. Meshy A-poses have bent wrists, so every pose re-aims the hand explicitly.
    // (Measured once per character model: NPCs and racers share them.)
    this.measured = BODY_CACHE.get(gltf) || null;
    this.bindB = !this.measured && this.skinned ? this.skinned.skeleton.bones.map((bn, i) => new THREE.Matrix4()
      .multiplyMatrices(bn.matrixWorld, this.skinned.skeleton.boneInverses[i]).multiply(this.skinned.bindMatrix)) : null;
    this.handGeo = this.measured ? this.measured.handGeo : [this.measureHand(b.lHand), this.measureHand(b.rHand)];
    this.setupClips(clips);
    // vertical drop from the hips joint to the hip sockets (thigh roots)
    this.upLegDrop = this.hipRest.y - worldPos(b.lUp, _v1).y;
    // where each rig puts its ankle joint relative to the hip socket (some sit at the heel)
    this.footFwd = worldPos(b.lFoot, _v1).z - worldPos(b.lUp, _v2).z;
    // how far above horizontal-ish the bind arms are: lowering them is shared with the collarbone
    const sh = worldPos(b.lArm, new THREE.Vector3()), el = worldPos(b.lFore, new THREE.Vector3());
    this.armRaise = Math.atan2(el.y - sh.y + (sh.distanceTo(el)), sh.distanceTo(el)); // ~0.8 for T-pose, less for A-pose
    // Meshy bind poses lean back a little; measure it so every pose can stand the spine up straight
    const s0 = worldPos(b.spine0, new THREE.Vector3()), nk = worldPos(b.neck, new THREE.Vector3());
    this.postureFix = Math.atan2(s0.z - nk.z, nk.y - s0.y) + 0.06; // radians to tip forward (facing +Z at bind)

    // skis + poles
    this.skis = ski ? [makeSki(ski), makeSki(ski)] : [];
    this.poles = pole ? [makePole(pole, poleLod), makePole(pole, poleLod)] : [];
    this.poleGltf = pole; // first person: the view model's poles (updateFpView)
    this.polesHidden = false; // (walkers: no poles, not even strapped to the carried skis)
    // AI skiers' seeded style (player/aistate.js makeStyle): stance width, arm carriage, pole plant reach and
    // length, balance sway. null = the player's own stance, exactly as tuned.
    this.aiStyle = null;
    this.fpView = null; this.fpViewT = 0; this.fpViewYaw = null; this.fpViewLag = 0;
    this.gear = new THREE.Group();
    for (const s of this.skis) this.gear.add(s);
    for (const p of this.poles) this.gear.add(p);

    this.mode = 'foot';
    this.prevMode = 'foot';
    this.blend = 1;
    this.snapshot = this.allBones.map(() => ({ q: new THREE.Quaternion(), p: new THREE.Vector3() }));
    this.plant = [{ t: 1, tip: new THREE.Vector3(), rel: false }, { t: 1, tip: new THREE.Vector3(), rel: false }];
    this.headHidden = false;
    this.carry = false;
    this.fallT = 0;
    this.skiOffsets = [0, 0];
    this.time = 0;
    this.fx = []; // one-shot effects for skierFX: { type: 'land'|'pole'|'impact'|'crash'|'slide', x, y, z, amount }
    this.skiQ = [new THREE.Quaternion(), new THREE.Quaternion()]; // posed ski orientations (feet + gear)
    this._skiPos = [new THREE.Vector3(), new THREE.Vector3()];
    this.eyeStable = new THREE.Vector3(); // eye position before whole-body trick / crash rotations
    this.hipsIndex = this.allBones.indexOf(b.hips);
    this.hipsBase = { q: new THREE.Quaternion(), p: new THREE.Vector3(), valid: false };
    this.footRestInv = [this.footRest.l.clone().invert(), this.footRest.r.clone().invert()];
    this.fallLift = 0; this.fallLiftV = 0;
    this.airW = 0; // 0 on the snow .. 1 in the air (eased pose blend)
    this._fp1 = {}; this._fp2 = {};
    // body points (joint, radius) that may touch the snow while lying or tumbling
    this.fallProbe = [[b.head, 0.13], [b.neck, 0.1], [b.spine2, 0.16], [b.spine0, 0.15], [b.hips, 0.14], [b.lUp, 0.1], [b.rUp, 0.1],
      [b.lLeg, 0.07], [b.rLeg, 0.07], [b.lFoot, 0.07], [b.rFoot, 0.07], [b.lFore, 0.06], [b.rFore, 0.06], [b.lHand, 0.05], [b.rHand, 0.05]]
      .filter(([bn]) => bn);
    this.fp = false; this.fpGearHidden = false; this.snapNext = false;
    this.fpGrip = [new THREE.Vector3(), new THREE.Vector3()]; this.fpPlant = [0, 0];
    this.armS = [{ F: 0.26, U: -0.36, O: 0.2, vF: 0, vU: 0, vO: 0 }, { F: 0.26, U: -0.36, O: 0.2, vF: 0, vU: 0, vO: 0 }]; // sprung hand offsets (skiing)
    this.idle = { w: 0, side: 1, t: 4 + Math.random() * 5 }; // standing weight shift (-1 left .. 1 right leg)
    this._fwd = new THREE.Vector3(0, 0, 1); this._right = new THREE.Vector3(-1, 0, 0);
    // skiing dynamics (poseSki): smoothed inputs, edge-change spring, body inertia over the legs (terrain and
    // landing absorption), jump phases (load, pop, air, landing prep), balance noise
    this.sk = { inc: 0, incV: 0, trans: 0, cr: 0.2, tk: 0, plow: 0, skid: 0, twist: 0, y: null, vy: 0, o: 0, ov: 0,
      chg: 0, popT: 9, popS: 0, airT: 0, wasAir: false, prep: 0, t: Math.random() * 60, init: false };
    this.torsoF = new THREE.Vector3(0, 0, 1); this.torsoR = new THREE.Vector3(-1, 0, 0); // posed chest frame (arms, poles)
    this.poleDir = [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1, 0)]; this.poleDirOk = false;
    this.frame = 0;
    this._legs = [[b.lUp, b.lLeg, b.lFoot, this.footRest.l], [b.rUp, b.rLeg, b.rFoot, this.footRest.r]];
    this._arms = [[b.lArm, b.lFore, b.lHand], [b.rArm, b.rFore, b.rHand]];
    if (this.measured) {
      this.hipHalfW = this.measured.hipHalfW; this.backDepth = this.measured.backDepth; this.seatDepth = this.measured.seatDepth;
    } else {
      this.measureHips();
      this.bindB = null; // (only needed for the measurements)
      this.measureCarry();
      BODY_CACHE.set(gltf, { handGeo: this.handGeo, hipHalfW: this.hipHalfW, backDepth: this.backDepth, seatDepth: this.seatDepth });
    }
  }

  // The jacket's back where the carried skis rest, measured on the relaxed standing pose: lowering the
  // arms from the bind A-pose pushes the back of the jacket out near the armpits.
  measureCarry() {
    const mesh = this.skinned, b = this.b;
    if (!mesh) return;
    const fwd = new THREE.Vector3(0, 0, 1), right = new THREE.Vector3(-1, 0, 0);
    this.resetPose();
    this.root.updateMatrixWorld(true);
    this.poseFoot(0, { mode: 'idle', heading: 0, speed: 0, normal: UP }, fwd, right);
    this.root.updateMatrixWorld(true);
    const bones = mesh.skeleton.bones, inv = mesh.skeleton.boneInverses;
    const B = bones.map((bn, i) => new THREE.Matrix4().multiplyMatrices(bn.matrixWorld, inv[i]).multiply(mesh.bindMatrix));
    const chest = worldPos(b.spine2, new THREE.Vector3()), hips = worldPos(b.hips, new THREE.Vector3());
    const neckP = worldPos(b.neck, new THREE.Vector3()), lowP = worldPos(b.spine0, new THREE.Vector3());
    const up = neckP.clone().sub(lowP).normalize();
    const bk = fwd.clone().negate().addScaledVector(up, fwd.dot(up)).normalize();
    const side = new THREE.Vector3().crossVectors(up, bk).normalize();
    const uLow = lowP.clone().sub(chest).dot(up) - 0.05, uTop = neckP.clone().sub(chest).dot(up) + 0.05;
    const upper = new Set([b.spine0, b.spine1, b.spine2, b.neck, b.lSh, b.rSh, b.lArm, b.rArm, b.head].filter(Boolean).map((x) => bones.indexOf(x)));
    const pelvis = new Set([b.hips, b.lUp, b.rUp, b.spine0].filter(Boolean).map((x) => bones.indexOf(x)));
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    const v = new THREE.Vector3(), t = new THREE.Vector3(), acc = new THREE.Vector3();
    let back = 0, seat = 0;
    for (let i = 0; i < pos.count; i++) {
      let wu = 0, wp = 0;
      for (let k = 0; k < 4; k++) {
        const bi = si.getComponent(i, k), w = sw.getComponent(i, k);
        if (upper.has(bi)) wu += w;
        if (pelvis.has(bi)) wp += w;
      }
      if (wu < 0.3 && wp < 0.5) continue;
      v.fromBufferAttribute(pos, i); acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w) acc.addScaledVector(t.copy(v).applyMatrix4(B[si.getComponent(i, k)]), w); }
      if (wu >= 0.3) {
        t.subVectors(acc, chest);
        const u = t.dot(up);
        if (u > uLow && u < uTop && Math.abs(t.dot(side)) < 0.14) back = Math.max(back, t.dot(bk));
      }
      if (wp >= 0.5 && acc.y > hips.y - 0.3 && acc.y < hips.y + 0.08) {
        t.subVectors(acc, hips);
        if (Math.abs(t.dot(side)) < 0.14) seat = Math.max(seat, t.dot(bk));
      }
    }
    if (back > 0.05) this.backDepth = Math.min(0.42, back);
    if (seat > 0.05) this.seatDepth = Math.min(0.42, seat);
    this.resetPose();
  }

  // World position of skinned vertex `i` at the bind pose. Meshy armatures carry their 0.01 scale in
  // the bind matrix, so the raw position times mesh.matrixWorld is not where the vertex renders.
  bindVertex(i, out) {
    const mesh = this.skinned, pos = mesh.geometry.attributes.position;
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    _v1.fromBufferAttribute(pos, i);
    out.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w) out.addScaledVector(_v2.copy(_v1).applyMatrix4(this.bindB[si.getComponent(i, k)]), w);
    }
    return out;
  }

  // Hip / jacket half-width from the skinned mesh at bind pose: hands hang just outside it.
  measureHips() {
    const b = this.b, mesh = this.skinned;
    this.hipHalfW = 0.17; this.backDepth = 0.2; this.seatDepth = 0.2;
    if (!mesh || !this.bindB) return;
    const hips = worldPos(b.hips, new THREE.Vector3());
    const bones = mesh.skeleton.bones;
    const pelvis = new Set([b.hips, b.lUp, b.rUp, b.spine0].filter(Boolean).map((x) => bones.indexOf(x)));
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    const v = new THREE.Vector3();
    let wide = 0;
    for (let i = 0; i < pos.count; i++) {
      let wp = 0;
      for (let k = 0; k < 4; k++) if (pelvis.has(si.getComponent(i, k))) wp += sw.getComponent(i, k);
      if (wp < 0.5) continue;
      this.bindVertex(i, v);
      if (v.y > hips.y - 0.28 && v.y < hips.y + 0.08) wide = Math.max(wide, Math.abs(v.x - hips.x));
    }
    if (wide > 0.08) this.hipHalfW = Math.min(0.3, wide);
  }

  // First person (player): your own body stays visible (look down: legs and boots on the bindings);
  // only the head is collapsed (setHeadHidden) so the eye never sees the inside of it. The rig's poles hide:
  // the view model's gloved hands hold their own (updateFpView). Only changes on a switch (bots and NPCs never
  // call this).
  setFirstPerson(on) {
    if (on === this.fp) return;
    this.fp = on;
    this.body.visible = true;
  }

  // The next update starts from the new pose with no blend (teleports, respawns, getting up elsewhere).
  snapPose() {
    this.snapNext = true;
    this.walkSnap = true; // (on foot: the feet start again under the body)
    this.fallLift = 0; this.fallLiftV = 0;
    this.airW = 0;
    for (const p of this.plant) p.t = 1;
    this.sk.init = false; this.poleDirOk = false;
  }

  // Motion-capture clips for standing / walking / running (idle, walk, run). Horizontal root motion is
  // stripped (the controller moves the character) and each clip's natural speed is measured so playback
  // can be matched to the real movement speed (no foot sliding).
  setupClips(clips) {
    this.clips = null;
    if (!clips?.idle || !clips?.walk) return;
    this.mixer = new THREE.AnimationMixer(this.body);
    this.clips = {};
    for (const [k, clip] of Object.entries(clips)) {
      if (!clip) continue;
      const c = clip.clone();
      let speed = 0;
      for (const t of c.tracks) {
        if (!t.name.endsWith('Hips.position')) continue;
        const v = t.values, n = v.length / 3;
        // armature is scaled 0.01: track units are centimeters
        speed = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 2] - v[2]) * 0.01 / c.duration;
        const x0 = v[0], z0 = v[2];
        for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
      }
      const a = this.mixer.clipAction(c);
      a.play();
      a.setEffectiveWeight(k === 'idle' ? 1 : 0);
      // Meshy's walk/run clips play in place (the hips barely move): then use the speed the cycle is made
      // for, or the time scale (ground speed / clip speed) shoots to its cap and the legs go frantic
      if (speed < 0.3) speed = k === 'run' ? 3.6 : 1.3;
      this.clips[k] = { action: a, speed, w: k === 'walk' ? 1 : 0 };
    }
  }

  poseFootClips(dt, st) {
    const v = Math.max(0, st.speed || 0);
    // walking is the run cycle played slower (the walk clip looked stiff): its time scale follows the
    // speed, so the feet still match the ground at a walk
    // slow walkers (villagers ~1.3 m/s) use the walk clip; from a brisk walk up (you, 1.7 m/s) the run cycle
    const r = this.clips.run ? THREE.MathUtils.smoothstep(v, 1.45, 1.65) : 0;
    const target = { idle: 0, walk: 1 - r, run: r };
    let sum = 0;
    const k = 1 - Math.exp(-dt * 8);
    for (const [name, c] of Object.entries(this.clips)) {
      c.w += ((target[name] || 0) - c.w) * k;
      sum += c.w;
    }
    for (const [name, c] of Object.entries(this.clips)) {
      c.action.setEffectiveWeight(c.w / (sum || 1));
      if (name === 'walk' || name === 'run') c.action.setEffectiveTimeScale(THREE.MathUtils.clamp(v / c.speed, name === 'run' ? 0.3 : 0.5, name === 'run' ? 2.6 : 1.8)); // (the run cycle keeps up with the faster pace on foot)
    }
    this.mixer.update(dt);
    // keep the feet on uneven ground: offset the whole body by the ground under it (decks included)
    const rp = this.root.position;
    rp.y = world.groundHeight(rp.x, rp.z, rp.y - (st.airY || 0) + 0.4) + (st.airY || 0);
    this.skiPos = null;
  }

  measureHand(handBone) {
    const mesh = this.skinned;
    if (!mesh || !handBone || !this.bindB) return null;
    const bi = mesh.skeleton.bones.indexOf(handBone);
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    const pts = [], v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
      if (w > 0.6) pts.push(this.bindVertex(i, v).clone());
    }
    if (pts.length < 20) return null;
    const joint = worldPos(handBone, new THREE.Vector3());
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of pts) {
      const d = [p.x - c.x, p.y - c.y, p.z - c.z];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) cov[r][k] += d[r] * d[k];
    }
    const [, , normal] = eigen3(cov); // thinnest axis of the hand = palm normal
    if (normal.z < 0) normal.negate(); // Meshy bind poses hold the palms facing forward (+Z): out of the palm
    const dir = c.clone().sub(joint).normalize();
    const inv = worldQuat(handBone, new THREE.Quaternion()).invert();
    return { dir: dir.applyQuaternion(inv), normal: normal.applyQuaternion(inv) };
  }

  // Rotate the hand so its fingers point along `dir` and its palm faces `palm` (world vectors).
  aimHand(i, dir, palm) {
    const hg = this.handGeo[i];
    const hand = i === 0 ? this.b.lHand : this.b.rHand;
    if (!hg) return;
    const q = worldQuat(hand, _ah.q);
    const d = _ah.d.copy(dir).normalize();
    const curDir = _ah.c.copy(hg.dir).applyQuaternion(q);
    q.premultiply(_ah.s.setFromUnitVectors(curDir, d));
    // twist around the finger direction so the palm (its normal points out of the palm) faces `palm`
    const n = _ah.n.copy(hg.normal).applyQuaternion(q);
    const pn = n.addScaledVector(d, -n.dot(d)).normalize();
    const pt = _ah.t.copy(palm).addScaledVector(d, -palm.dot(d)).normalize();
    if (pn.lengthSq() > 1e-6 && pt.lengthSq() > 1e-6) {
      const ang = Math.atan2(_ah.x.crossVectors(pn, pt).dot(d), pn.dot(pt));
      q.premultiply(_ah.s.setFromAxisAngle(d, ang));
    }
    setWorldQuat(hand, q);
  }

  // Hand continuing the forearm (slight natural curl), palm toward `palm`.
  relaxHand(i, palm, curl = 0.12) {
    const fore = i === 0 ? this.b.lFore : this.b.rFore, hand = i === 0 ? this.b.lHand : this.b.rHand;
    const dir = worldPos(hand, new THREE.Vector3()).sub(worldPos(fore, new THREE.Vector3())).normalize();
    dir.addScaledVector(palm, curl).normalize();
    this.aimHand(i, dir, palm);
  }

  setSkiModel(gltf) {
    const vis = this.skis[0]?.visible ?? true;
    for (const s of this.skis) this.gear.remove(s);
    this.skis = [makeSki(gltf), makeSki(gltf)];
    for (const s of this.skis) { s.visible = vis; this.gear.add(s); }
  }

  // Queue a one-shot snow effect for skierFX (bounded: rigs far from the camera are not drained).
  pushFx(e) { if (this.fx.length < 24) this.fx.push(e); }

  // carried = skis + poles strapped to the back (walking), otherwise on the feet / in hands
  setCarry(c) { this.carry = c; }

  setSkisVisible(v) { for (const s of this.skis) s.visible = v; for (const p of this.poles) p.visible = v && !this.polesHidden; }

  // AI skiers: the full pole model near the camera, the light stand-in beyond (rigs made with poleLod)
  setPoleDetail(hi) {
    for (const p of this.poles) {
      const u = p.userData;
      if (u.lo) { u.hi.visible = hi; u.lo.visible = !hi; }
    }
  }

  setHeadHidden(h) {
    this.headHidden = h;
  }

  addTo(scene) { scene.add(this.root); scene.add(this.gear); }
  removeFrom(scene) { scene.remove(this.root); scene.remove(this.gear); }

  resetPose() {
    for (let i = 0; i < this.allBones.length; i++) {
      const bn = this.allBones[i], r = this.rest[i];
      bn.quaternion.copy(r.q); bn.position.copy(r.p); bn.scale.copy(r.s);
    }
  }

  startPolePlant(side, fwd, right) {
    if (!this.poles.length) return; // a skier without poles keeps the hands in the ski stance
    const p = this.plant[side];
    if (p.t < 0.6) return;
    p.t = 0; p.rel = false;
    const s = side === 0 ? 1 : -1; // left pole on the left (+right is to the character's right... left is -right)
    // the basket meets the snow ~0.14 s later, just ahead of the boot: lead it by the distance travelled
    // (first person: planted further out to the side, so the pole stays at the edge of the view)
    const lead = this.fp ? 0.5 : Math.min(2.6, 0.5 + (this.sk.spd || 0) * 0.14);
    p.tip.copy(this.root.position).addScaledVector(fwd, lead).addScaledVector(right, -s * (this.fp ? 0.74 : 0.46));
    p.tip.y = world.groundHeight(p.tip.x, p.tip.z, this.root.position.y + 0.5);
  }

  // state: { mode, heading, crouch, lean, edge, tuck, plow, skid, speed, normal, air, flip, flipHeading,
  //          grab, grabType, spinVel, charge, fall, fallSide, fallHeading, fallAir, lookYaw, lookPitch,
  //          seat, carry, airY } — everything past `normal` is optional (NPCs and bots skip it)
  update(dt, st) {
    this.time += dt;
    this.frame++;
    // on foot: the procedural walk / run / stand (poseFoot). Fallback only (SkierRig.walkClips): the Meshy clips
    // while moving, in their own mode so the 0.3s pose blend covers the switch
    const moving = (st.speed || 0) > 0.35 || (this.mode === 'move' && (st.speed || 0) > 0.15);
    const onFoot = st.mode === 'walk' || st.mode === 'idle';
    const mode = onFoot ? (SkierRig.walkClips && this.clips && moving ? 'move' : 'foot') : st.mode;
    if (mode !== this.mode) {
      this.prevMode = this.mode;
      this.mode = mode;
      for (let i = 0; i < this.allBones.length; i++) {
        this.snapshot[i].q.copy(this.allBones[i].quaternion);
        this.snapshot[i].p.copy(this.allBones[i].position);
      }
      // the hips carry the whole-body trick / tumble rotation: blend from the un-rotated pose
      if (this.hipsBase.valid && this.hipsIndex >= 0) {
        this.snapshot[this.hipsIndex].q.copy(this.hipsBase.q);
        this.snapshot[this.hipsIndex].p.copy(this.hipsBase.p);
      }
      if (mode === 'fall') { this.fallLift = 0; this.fallLiftV = 0; }
      this.airW = st.air ? 1 : 0;
      this.blend = 0;
    }
    if (this.snapNext) { this.blend = 1; this.snapNext = false; }
    // first person (player only): hidden body, gloves on the grips; skis and poles hide while flips
    // and tumbles would sweep them through the eye
    if (st.fp !== undefined) this.setFirstPerson(!!st.fp);
    // (the body too: a tumble would sweep it through the first-person eye down on the snow. Flips keep it: the
    // helmet cam goes round with the body, so it stays where it always is, below the eye)
    const hideGear = this.fp && st.mode === 'fall';
    if (hideGear !== this.fpGearHidden) { this.fpGearHidden = hideGear; this.gear.visible = !hideGear; this.body.visible = !hideGear; }

    const fwd = this._fwd.set(Math.sin(st.heading), 0, Math.cos(st.heading));
    const right = this._right.crossVectors(fwd, UP).normalize(); // character's right

    this.root.rotation.set(0, st.heading, 0);
    this.root.updateMatrixWorld(true);

    // all poses are built procedurally from the bind (A-)pose every frame
    this.resetPose();
    this.root.updateMatrixWorld(true);
    if (mode === 'move') this.poseFootClips(dt, st);
    else if (mode === 'foot') this.poseFoot(dt, st, fwd, right);
    else if (mode === 'sit') this.poseSit(dt, st, fwd, right);
    else if (mode === 'ski') this.poseSki(dt, st, fwd, right);
    else if (mode === 'fall') this.poseFall(dt, st, fwd, right);

    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 0.3);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      for (let i = 0; i < this.allBones.length; i++) {
        const bn = this.allBones[i];
        _bq.copy(bn.quaternion); _bp.copy(bn.position);
        bn.quaternion.slerpQuaternions(this.snapshot[i].q, _bq, t);
        bn.position.lerpVectors(this.snapshot[i].p, _bp, t);
      }
    }
    if (this.headHidden && this.b.head) this.b.head.scale.setScalar(0.001);
    else if (this.b.head) this.b.head.scale.setScalar(1);
    // first person with the pole view model: the body's own arms fold away (one pair of hands, and nothing to glitch);
    // on foot too (the walk / run clips pump the forearms right in front of the eye)
    const armsAway = this.fp && (!!this.fpView?.visible || this.mode === 'move' || this.mode === 'foot');
    for (const a of [this.b.lArm, this.b.rArm]) if (a) a.scale.setScalar(armsAway ? 0.001 : 1);
    this.hipsBase.q.copy(this.b.hips.quaternion);
    this.hipsBase.p.copy(this.b.hips.position);
    this.hipsBase.valid = true;
    this.root.updateMatrixWorld(true);
    // eye before any whole-body rotation: a steady first-person view through flips and crashes
    this.eyeStable.copy(this.eyeWorld);
    // ...and the point a flip turns the body about (flipBody): the first-person eye goes round it too
    if (this.fp) worldPos(this.b.hips, this.fpFlipC ??= new THREE.Vector3()).addScaledVector(UP, 0.08);
    if (mode === 'fall') this.placeFallen(dt, st);
    this.updateGear(dt, st, fwd, right);
    // first person: the rig's poles hide (the view model's hands hold their own poles)
    const polesOn = !this.fp && this.skis[0]?.visible !== false && !this.polesHidden;
    for (const p of this.poles) p.visible = polesOn;
    if (mode === 'ski' && st.flip) this.flipBody(st);
  }

  // Lower both collarbones a little so the shoulder joint doesn't have to rotate the full way down
  // (Meshy auto-skinning bunches the jacket into a hump when the upper arm alone turns ~90 deg).
  relaxShoulders(amount = 1) {
    for (const [shBone, arm, fore] of [[this.b.lSh, this.b.lArm, this.b.lFore], [this.b.rSh, this.b.rArm, this.b.rFore]]) {
      if (!shBone) continue;
      const a = worldPos(arm, _s[12]), e = worldPos(fore, _s[13]);
      const dir = e.sub(a).normalize();
      const axis = _s[11].crossVectors(dir, DOWN);
      if (axis.lengthSq() < 1e-6) continue;
      rotateWorld(shBone, axis.normalize(), 0.3 * this.armRaise * amount);
    }
  }

  // Stand the spine up from the bind pose's backward lean (negative about `right` tips forward).
  fixPosture(right) {
    rotateWorld(this.b.spine0, right, -this.postureFix * 0.7);
    rotateWorld(this.b.spine2, right, -this.postureFix * 0.3);
  }

  // ---------------------------------------------------------------- on foot (procedural gait)
  // Walking, running and standing: src/player/gait.js (feet planted on the snow, a ski-boot heel-to-toe roll,
  // pelvis and arm swing, starts / stops / turns on the spot, a style per person: the player athletic, the
  // villagers each strolling their own way). The Meshy clips are only a fallback (SkierRig.walkClips).
  poseFoot(dt, st, fwd, right) {
    if (SkierRig.walkClips) return this.poseFootClassic(dt, st, fwd, right);
    (this.walk ??= new FootGait(this)).pose(dt, st, fwd, right);
    this.skiPos = null;
  }

  // the previous hand-tuned standing pose, used with the Meshy walk / run clips (SkierRig.walkClips)
  poseFootClassic(dt, st, fwd, right) {
    const b = this.b, g = this.gait;
    const v = Math.max(0, st.speed || 0);
    g.t += dt;
    g.move += (THREE.MathUtils.smoothstep(v, 0.05, 0.7) - g.move) * Math.min(1, dt * 8);
    g.run += (THREE.MathUtils.smoothstep(v, 2.3, 3.6) - g.run) * Math.min(1, dt * 5);
    const move = g.move, run = g.run;
    const stride = THREE.MathUtils.clamp(0.55 + 0.38 * v, 0.9, 2.6); // length of a full cycle (two steps)
    if (move > 0.01) g.phase = (g.phase + (v * dt) / stride) % 1;
    const phase = g.phase;
    const stanceFrac = lerp(0.62, 0.38, run);
    const lift = lerp(0.11, 0.26, run);
    const root = this.root.position;
    // standing still: a relaxed stance with the weight on one leg, shifting over every few seconds
    const stand = 1 - move;
    const I = this.idle;
    I.t -= dt;
    if (I.t <= 0) { I.side = -I.side; I.t = 5 + Math.random() * 6; }
    I.w += (I.side - I.w) * (1 - Math.exp(-dt * 1.3));
    const w = I.w * stand; // + = weight on the right leg

    // feet
    const footPos = [];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1; // 0 = left (-right)
      const p = (phase + (i === 0 ? 0 : 0.5)) % 1;
      let along, up = 0, pitch = 0;
      const half = (stanceFrac * stride) / 2;
      if (p < stanceFrac) {
        along = half - (p / stanceFrac) * 2 * half;
        // heel-strike -> flat -> push off on the toes
        pitch = -0.25 * THREE.MathUtils.smoothstep(p / stanceFrac, 0.7, 1.0);
      } else {
        const q = (p - stanceFrac) / (1 - stanceFrac);
        const e = q * q * (3 - 2 * q);
        along = -half + e * 2 * half;
        up = Math.sin(q * Math.PI) * lift;
        pitch = 0.3 * Math.sin(q * Math.PI) - 0.15 * (1 - q);
      }
      along *= move; up *= move; pitch *= move;
      const free = Math.max(0, -side * w); // this leg carries no weight
      along += 0.07 * free; pitch -= 0.06 * free;
      const lateral = side * lerp(0.1, 0.085, run) + side * (0.015 + 0.02 * free) * (1 - move);
      const fp = root.clone().addScaledVector(fwd, along).addScaledVector(right, lateral);
      const ground = world.groundHeight(fp.x, fp.z, root.y - (st.airY || 0) + 0.4) + (st.airY || 0); // airborne when jumping
      fp.y = ground + up;
      footPos.push({ fp, pitch, ground });
    }

    // hips: bob + sway over the stance leg + forward lean for running
    // walking: hips highest at mid-stance; running: lowest at mid-stance (absorbing the landing)
    const mid = Math.cos((phase - stanceFrac / 2) * Math.PI * 4);
    // inverted pendulum: legs ~straight as the body passes over the foot, hips dip at double support
    const bob = move * lerp(mid * this.legLen * 0.04, -mid * 0.03, run);
    const breathe = Math.sin(g.t * 1.6) * 0.004 * (1 - move);
    const sway = Math.sin(phase * Math.PI * 2) * 0.022 * move * (1 - run) + Math.sin(g.t * 0.35) * 0.012 * (1 - move);
    const groundY = Math.min(footPos[0].ground, footPos[1].ground);
    const hip = root.clone();
    // hip height from the real leg length: nearly straight standing, a bit of flex walking, more running
    const ext = lerp(0.996 - 0.006 * Math.abs(w), lerp(0.93, 0.87, run), move);
    hip.y = groundY + this.ankleH + this.legLen * ext + this.upLegDrop + bob + breathe;
    hip.addScaledVector(right, sway + 0.03 * w).addScaledVector(fwd, run * 0.04);
    b.hips.position.copy(b.hips.parent.worldToLocal(hip.clone()));
    b.hips.updateMatrixWorld(true);
    const pelvisYaw = Math.sin(phase * Math.PI * 2) * lerp(0.1, 0.16, run) * move;
    rotateWorld(b.hips, UP, pelvisYaw);
    rotateWorld(b.hips, fwd, -sway * 1.5 - 0.05 * w); // the free leg's hip drops
    rotateWorld(b.hips, UP, 0.04 * w);
    rotateWorld(b.hips, right, -lerp(0.03, 0.2, run) * move); // lean into the motion
    this.fixPosture(right);
    // spine: counter-rotate shoulders, breathe; standing, the shoulders tilt against the pelvis
    rotateWorld(b.spine1, UP, -pelvisYaw * 1.6 - 0.03 * w);
    rotateWorld(b.spine2, right, Math.sin(g.t * 1.6) * 0.012 * stand);
    rotateWorld(b.spine1, fwd, sway * 1.2 + 0.035 * w);

    // legs: IK onto the foot targets, knees forward
    for (let i = 0; i < 2; i++) {
      const [up, leg, foot, fr] = i === 0 ? [b.lUp, b.lLeg, b.lFoot, this.footRest.l] : [b.rUp, b.rLeg, b.rFoot, this.footRest.r];
      const side = i === 0 ? -1 : 1;
      const { fp, pitch } = footPos[i];
      const ankle = fp.clone().addScaledVector(UP, this.ankleH).addScaledVector(fwd, this.footFwd);
      solveTwoBone(up, leg, foot, ankle, fwd.clone().addScaledVector(right, side * 0.08).normalize());
      const fq = new THREE.Quaternion().setFromAxisAngle(UP, st.heading + side * 0.08).multiply(_q1.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch));
      setWorldQuat(foot, fq.multiply(fr));
    }

    // arms: hanging relaxed by the thighs when standing, a loose swing walking, pumping when running
    this.relaxShoulders(1 + 0.25 * stand);
    const hc = worldPos(b.hips, new THREE.Vector3());
    for (let i = 0; i < 2; i++) {
      const [arm, fore, hand] = i === 0 ? [b.lArm, b.lFore, b.lHand] : [b.rArm, b.rFore, b.rHand];
      const side = i === 0 ? -1 : 1;
      // left arm swings with the right leg
      const swing = Math.sin((phase + (i === 0 ? 0.5 : 0)) * Math.PI * 2) * move;
      const sh = worldPos(arm, new THREE.Vector3());
      const L = this.armLen;
      // standing: the arm hangs almost straight (soft elbow), the hand just outside the hip / jacket,
      // a little in front of the thigh's side, swaying with the breath
      const out = this.hipHalfW + 0.045 - side * 0.012 * w;
      const hx = hc.x + right.x * side * out + fwd.x * 0.03, hz = hc.z + right.z * side * out + fwd.z * 0.03;
      const dxz = Math.hypot(hx - sh.x, hz - sh.z), reach = L * 0.965;
      const standT = new THREE.Vector3(hx, sh.y - Math.sqrt(Math.max(0.01, reach * reach - dxz * dxz)), hz);
      standT.addScaledVector(fwd, Math.sin(g.t * 0.8 + i * 1.3) * 0.006);
      // walking: hands swing beside the thighs, elbows softly bent
      const walkT = sh.clone().addScaledVector(UP, -L * 0.93).addScaledVector(right, side * 0.035)
        .addScaledVector(fwd, 0.04 + swing * 0.22 * (st.carry ? 0.4 : 1));
      // running: elbows bent ~90 deg, hands pumping between hip and chest height close to the body
      const runT = sh.clone().addScaledVector(UP, -L * (0.62 - 0.08 * Math.max(0, swing))).addScaledVector(right, side * 0.07)
        .addScaledVector(fwd, 0.05 + swing * 0.15);
      const tgt = walkT.lerp(runT, run).lerp(standT, stand);
      tgt.addScaledVector(UP, Math.sin(g.t * 1.6) * 0.004);
      // elbows point back (the crook faces forward), a little out
      const elbow = fwd.clone().negate().addScaledVector(right, side * lerp(0.12, 0.3, stand)).addScaledVector(UP, -0.2 * (1 - stand)).normalize();
      solveTwoBone(arm, fore, hand, tgt, elbow);
      // palm toward the thigh (turned a little back when standing), fingers loosely curled in
      this.relaxHand(i, right.clone().multiplyScalar(-side).addScaledVector(fwd, -0.3 * stand).normalize(), 0.1 + 0.06 * stand);
    }

    // head: steady gaze, looking around a little when standing
    const look = (1 - move) * (Math.sin(g.t * 0.23) * 0.35 + Math.sin(g.t * 0.61) * 0.12);
    rotateWorld(b.head, UP, look - pelvisYaw * 0.5 + (st.lookYaw || 0) * 0.7);
    rotateWorld(b.neck, fwd, -0.025 * w);
    if (run > 0) rotateWorld(b.neck, right, run * 0.12 * move);
    this.skiPos = null;
  }

  // ---------------------------------------------------------------- seated on a lift
  poseSit(dt, st, fwd, right) {
    const b = this.b;
    if (!st.seat) return;
    this.gait.t += dt;
    const seat = st.seat; // world position of the seat surface (center)
    const hip = seat.clone().addScaledVector(UP, 0.1);
    b.hips.position.copy(b.hips.parent.worldToLocal(hip.clone()));
    b.hips.updateMatrixWorld(true);
    this.fixPosture(right);
    rotateWorld(b.spine1, right, 0.06); // lean back against the backrest a touch
    for (let i = 0; i < 2; i++) {
      const [up, leg, foot, fr] = i === 0 ? [b.lUp, b.lLeg, b.lFoot, this.footRest.l] : [b.rUp, b.rLeg, b.rFoot, this.footRest.r];
      const side = i === 0 ? -1 : 1;
      const dangle = Math.sin(this.gait.t * 0.9 + i * 1.7) * 0.03;
      const ankle = seat.clone().addScaledVector(fwd, 0.46 + dangle).addScaledVector(UP, -0.36).addScaledVector(right, side * 0.12);
      solveTwoBone(up, leg, foot, ankle, fwd);
      setWorldQuat(foot, new THREE.Quaternion().setFromAxisAngle(UP, st.heading).multiply(_q1.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3)).multiply(fr));
    }
    for (let i = 0; i < 2; i++) {
      const [arm, fore, hand] = i === 0 ? [b.lArm, b.lFore, b.lHand] : [b.rArm, b.rFore, b.rHand];
      const side = i === 0 ? -1 : 1;
      if (i === 0) this.relaxShoulders();
      // hands resting on the thighs
      const tgt = hip.clone().addScaledVector(fwd, 0.32).addScaledVector(UP, 0.12).addScaledVector(right, side * 0.17);
      solveTwoBone(arm, fore, hand, tgt, right.clone().multiplyScalar(side).addScaledVector(UP, -1).addScaledVector(fwd, -0.4).normalize());
      this.aimHand(i, fwd.clone().addScaledVector(UP, -0.25), UP.clone().negate()); // palms resting on the thighs
    }
    rotateWorld(b.head, UP, Math.sin(this.gait.t * 0.2) * 0.4 + (st.lookYaw || 0) * 0.7);
  }

  // Skiing. Built every frame from a few smoothed signals so nothing pops, and driven by the motion of
  // the feet (the root) as well as the controller's state:
  //  - stance: ankles flexed, knees over the toes, hips just behind the boots, back flat and hinged forward;
  //    taller and looser at walking pace, perpendicular to a steep slope (not leaning back off it)
  //  - turns: the legs incline into the turn (knees driven into the slope, hips low and inside, the outside
  //    leg long and the inside leg folded, inside ski a little ahead) while the upper body stays quieter and
  //    turns toward the fall line (angulation + counter-rotation); edge changes run through a spring and
  //    the body rises a touch as it crosses over the skis
  //  - inertia: the body rides on the legs like a mass on a spring, so compressions, rollers and landings
  //    fold the knees and hips and the hands bob, then the legs extend again
  //  - jumps: load (deep crouch, arms back) -> pop (explosive extension, arms swing up) -> air (knees
  //    tucked up, arms out balancing) -> landing prep (legs reach for the snow, arms forward) -> absorb
  //  - tuck: chest on the thighs, hands together in front of the chin, poles under the arms
  //  - snowplough: wedge, knees in, arms wide; hockey stop: skis across, upper body down the hill, hips back
  poseSki(dt, st, fwd, right) {
    const b = this.b, K = this.sk;
    const root = this.root.position;
    const h = clamp(dt, 0, 0.1);
    K.t += h;
    let air = !!st.air;
    // some callers flag "air" just to keep the skis at body height on decks and ramps: with snow or a
    // deck right under the boots this is a grounded skier
    if (air && !st.flip && !st.grab && Math.abs(root.y - world.groundHeight(root.x, root.z, root.y + 0.3)) < 0.06) air = false;
    const spd = st.speed || 0;
    K.spd = spd;
    const tuckIn = !air && !!st.tuck;
    const inclT = clamp(st.edge !== undefined ? st.edge : (st.lean || 0) * 0.6, -1, 1);
    // (re)start after a teleport or after any other mode (walking, lift, crash): no stale velocities
    if (!K.init || K.frame !== this.frame - 1 || Math.abs(root.y - K.y) > 1.5) {
      K.init = true; K.y = root.y; K.vy = 0; K.o = 0; K.ov = 0; K.cr = st.crouch || 0; K.tk = tuckIn ? 1 : 0; K.armInit = false;
      K.plow = st.plow || 0; K.skid = st.skid || 0; K.inc = inclT; K.incV = 0; K.trans = 0; K.twist = 0;
      K.wasAir = air; K.popT = 9; K.airT = air ? 1 : 0; K.prep = 0; K.chg = 0;
    }
    // vertical velocity of the boots (filtered: bots update at reduced rates)
    const vyPrev = K.vy;
    if (h > 1e-4) K.vy += (clamp((root.y - K.y) / h, -40, 40) - K.vy) * (1 - Math.exp(-h * 22));
    K.y = root.y;
    K.frame = this.frame;

    // ---- jump phases
    const charge = air ? 0 : st.charge || 0;
    if (!air && K.chg > 0.12 && charge < 0.02) { K.popT = 0; K.popS = clamp(0.45 + K.chg * 0.6, 0, 1); } // charge released: pop
    K.chg = charge;
    if (air && !K.wasAir) { K.airT = 0; K.prep = 0; if (K.popT > 0.3) { K.popT = 0; K.popS = 0.3; } } // rolled off a lip: a small spring
    K.wasAir = air;
    K.popT += h;
    if (air) K.airT += h;
    const popEnv = K.popT < 0.24 ? K.popS * Math.sin((K.popT / 0.24) * Math.PI) : 0;

    // ---- smoothed inputs (bots switch tuck / plow / crouch in steps)
    K.cr += ((st.crouch || 0) - K.cr) * ek(h, 14);
    K.tk += ((tuckIn ? 1 : 0) - K.tk) * ek(h, 6);
    K.plow += ((st.plow || 0) - K.plow) * ek(h, 8);
    K.skid += ((st.skid || 0) - K.skid) * ek(h, 14);
    // edge changes through a critically damped spring; the body mass lags the feet vertically
    if (!air) K.ov -= (K.vy - vyPrev) * 0.5;
    const nSub = Math.max(1, Math.ceil(h * 120)), hs = h / nSub;
    for (let k = 0; k < nSub; k++) {
      K.incV += ((inclT - K.inc) * 256 - 32 * K.incV) * hs;
      K.inc += K.incV * hs;
      K.ov += (-90 * K.o - 15 * K.ov) * hs;
      K.o += K.ov * hs;
    }
    if (K.o < -0.2) { K.o = -0.2; if (K.ov < 0) K.ov = 0; } else if (K.o > 0.05) { K.o = 0.05; if (K.ov > 0) K.ov = 0; }
    K.trans += (clamp(Math.abs(K.incV) / 2.2, 0, 1) - K.trans) * ek(h, 8);

    // take-off / touch-down blend: the legs tuck up over ~0.15 s, the skis reach for the snow faster
    this.airW = air ? Math.min(1, this.airW + dt * 7) : Math.max(0, this.airW - dt * 14);
    const aw = this.airW * this.airW * (3 - 2 * this.airW), gw = 1 - aw;
    const grab = smoothT(st.grab || 0, 0, 1); // eased: the hand accelerates to the ski and settles on it
    const gp = grab > 0.001 ? GRAB_POSES[st.grabType] || GRAB_POSES.mute : null;
    const tk = K.tk * gw;
    const crouch = clamp(K.cr, -0.2, 1.2);
    const cr01 = clamp(crouch, 0, 1);
    // inclination into the turn (+ leans right): the body's lean eases off toward high edge angles (the
    // skis still tip all the way, the rest is angulation at the knees and hips)
    const incl = 0.82 * Math.tanh(clamp(K.inc, -1.2, 1.2) / 0.82) * gw;
    const edgeIn = clamp(K.inc, -1.05, 1.05) * gw;
    const lean = clamp(incl / 0.8, -1, 1), al = Math.abs(lean);
    const skid = K.skid * gw, askid = Math.min(1, Math.abs(skid)); // hockey stop: skis + legs across the travel
    const plow = K.plow * gw;
    const n = st.normal || UP;
    const spin = clamp((st.spinVel || 0) / 7, -1, 1) * aw;
    const relax = (1 - smoothT(spd, 1.5, 8)) * (1 - 0.6 * plow) * gw; // slow: taller, looser
    // in the air: knees come up after the take-off extension; the legs reach down again just before touchdown
    let tl = 9;
    if (air) {
      const hgt = Math.max(0, root.y - world.groundHeight(root.x, root.z, root.y));
      tl = (K.vy + Math.sqrt(K.vy * K.vy + 19.62 * hgt)) / 9.81;
    }
    K.prep += ((air && K.airT > 0.2 ? 1 - smoothT(tl, 0.12, 0.42) : 0) - K.prep) * ek(h, air ? 12 : 20);
    const prep = K.prep * aw;
    const tuckA = (air ? smoothT(K.airT, 0.06, 0.3) : 0) * (1 - prep);
    // small balance corrections, livelier over rough snow
    const rough = Math.min(1, Math.abs(K.ov) * 1.5);
    const Y = this.aiStyle; // (AI skiers' seeded style; null for the player)
    const bal = (Math.sin(K.t * 1.7) * 0.6 + Math.sin(K.t * 2.9 + 1.3) * 0.4) * (0.01 + 0.025 * rough) * gw * (Y ? Y.sway : 1);

    // the skis' frame (turned by a hockey-stop skid)
    const sf = _s[0].copy(fwd);
    if (skid) sf.applyAxisAngle(UP, skid);
    const sr = _s[1].crossVectors(sf, UP).normalize();

    // ---- skis: on the snow (edge angle, snowplow wedge) blended with the air orientation (level, tips
    // up a little, flattening to meet the snow before touchdown, pitched for some grabs)
    const edge = clamp(edgeIn * 1.15, -1.15, 1.15); // skis tip a little further than the body
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1; // 0 = left ski (-right)
      // snowplow: tips together (each ski turned inward), standing on the inside edges
      const f = _gf.copy(sf).applyAxisAngle(UP, s * 0.3 * plow);
      const q = this.skiQ[i].copy(this.skiQuat(f, n, edge - s * 0.25 * plow));
      if (aw > 0) {
        const qa = _rqb.copy(this.skiQuat(fwd, UP, 0)).multiply(_rq.setFromAxisAngle(X_AXIS, -(0.1 * (1 - prep) + (gp ? gp.pitch * grab : 0))));
        q.slerp(qa, aw);
      }
    }
    const stance = 0.115 + plow * 0.13 + askid * 0.05 + 0.03 * al + 0.02 * smoothT(spd, 8, 20) * (1 - plow) - 0.015 * tk + (Y ? Y.stance : 0);
    const liftBase = 0.05 + 0.2 * tuckA + 0.06 * cr01 * (1 - prep);
    const lift = liftBase + (gp ? Math.max(0, gp.lift + 0.11 - liftBase) * grab : 0); // knees pulled up in the air
    const skiPos = (this.skiPos = this._skiPos);
    // a ski may sit below the body only as far as the slope under it explains (not off a lip or cliff)
    const tanS = Math.min(1.5, Math.hypot(n.x, n.z) / Math.max(0.2, n.y));
    const drop = Math.min(0.3, (stance + 0.1) * tanS + 0.05);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const p = skiPos[i].copy(root).addScaledVector(sr, s * stance);
      // inside ski a little ahead in a turn (lead change)
      p.addScaledVector(sf, (s === Math.sign(incl) ? 0.12 : -0.04) * al);
      let y = root.y + lift;
      if (gw > 0) {
        const g = world.groundHeight(p.x, p.z, root.y + 0.3);
        // an edged ski rests on its edge: lift the ski center by half its width x sin(edge)
        y = lerp(clamp(g, root.y - drop, root.y + 0.35) + 0.035 * Math.abs(Math.sin(edge)), y, aw);
      }
      p.y = y;
      if (gp) p.addScaledVector(fwd, gp.feetF * grab * aw);
    }

    // ---- hips: height from the crouch (tuck much lower), dropping and moving inside as the body inclines,
    // rising a little through edge changes and on the pop, riding the inertia spring; just behind the
    // boots, and forward with the slope's normal when facing down a steep pitch
    const nf = clamp(n.x * sf.x + n.z * sf.z, -0.6, 0.6); // + facing downhill
    let hf = 1.01 - 0.2 * cr01 - 0.08 * Math.max(0, crouch - 1) + 0.025 * relax + 0.06 * al + 0.03 * K.trans * (1 - al) + 0.05 * popEnv;
    hf = lerp(hf, 0.91, tk); // holding W: the normal stance, just a little lower (never a folded egg)
    const hipH = this.hipRest.y * hf;
    const hip = _s[2].copy(root);
    const airY = root.y + this.hipRest.y * (0.9 - 0.1 * tuckA + 0.04 * popEnv) - grab * 0.04;
    if (gw > 0) {
      const lowY = Math.min(skiPos[0].y, skiPos[1].y), highY = Math.max(skiPos[0].y, skiPos[1].y);
      hip.y = lowY + (highY - lowY) * 0.5;
      hip.addScaledVector(UP, hipH * Math.cos(incl)).addScaledVector(sr, hipH * Math.sin(incl) * 0.85);
      const back = -0.02 + 0.03 * cr01 + 0.02 * tk + 0.03 * plow + 0.03 * askid - 0.02 * relax;
      // facing down a steep pitch the body stays close to square to the slope (not upright = sitting back)
      hip.addScaledVector(sf, -back + hipH * nf * 0.72);
      hip.y += K.o;
      hip.y = lerp(hip.y, airY, aw);
    } else hip.y = airY;
    // keep hips reachable from both ankles (measured from the hip joint, not the pelvis bone above it)
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const up = _gu.set(0, 1, 0).applyQuaternion(this.skiQ[i]);
      const ankle = _gp.copy(skiPos[i]).addScaledVector(up, this.ankleH + 0.05);
      const joint = this._joint.copy(hip).addScaledVector(UP, -this.hipDrop).addScaledVector(sr, s * this.hipHalfW);
      const d = joint.distanceTo(ankle);
      if (d > this.legLen * 0.97) hip.y -= d - this.legLen * 0.97;
    }
    b.hips.position.copy(b.hips.parent.worldToLocal(_s[3].copy(hip)));
    b.hips.updateMatrixWorld(true);

    // ---- torso: hinge forward at the hips with a flat back; the pelvis inclines with the legs, the
    // chest stays quieter (angulation) and turns toward the fall line (counter-rotation)
    const flex = 0.3 + 0.22 * cr01 + 0.08 * tk + (gp ? gp.flex * grab : 0) + 0.06 * aw + 0.12 * tuckA + 0.08 * prep + charge * 0.22
      - 0.1 * relax - 0.1 * al - K.o * 1.4 + Math.asin(nf) * 0.5 * gw - 0.12 * popEnv + 0.06 * askid;
    let twT = incl * 0.18;
    const sl = Math.hypot(n.x, n.z);
    if (sl > 0.03) {
      let rel = Math.atan2(n.x, n.z) - st.heading;
      rel -= Math.round(rel / (Math.PI * 2)) * Math.PI * 2;
      twT += clamp(rel, -1.4, 1.4) * 0.3 * smoothT(sl, 0.04, 0.22) * (1 - smoothT(Math.abs(rel), 1.6, 2.4));
    }
    twT *= gw * (1 - 0.6 * tk) * (1 - askid);
    K.twist += (twT - K.twist) * ek(h, 5);
    if (skid) rotateWorld(b.hips, UP, skid * 0.8);
    if (K.twist) rotateWorld(b.hips, UP, K.twist * 0.25);
    rotateWorld(b.hips, sr, -flex); // negative about `right` = forward lean
    this.fixPosture(sr);
    rotateWorld(b.hips, sf, incl * 0.8);
    rotateWorld(b.spine1, sf, -incl * 0.42 + bal);
    rotateWorld(b.spine2, sf, -incl * 0.1);
    rotateWorld(b.spine1, UP, K.twist * 0.45 - skid * 0.65 + spin * 0.25 + (gp ? gp.twist * grab : 0));
    if (K.twist) rotateWorld(b.spine2, UP, K.twist * 0.3);
    rotateWorld(b.spine1, right, -flex * 0.1 - 0.025 * tk + bal * 0.5);

    // ---- legs: IK ankles onto the bindings; knees forward over the toes and driven into the turn (knees
    // in for the snowplough), apart when tucked up in the air
    for (let i = 0; i < 2; i++) {
      const [up, leg, foot, fr] = this._legs[i];
      const s = i === 0 ? -1 : 1;
      const q = this.skiQ[i];
      const skiUp = _gu.set(0, 1, 0).applyQuaternion(q), skiF = _gf.set(0, 0, 1).applyQuaternion(q);
      const ankle = _s[3].copy(skiPos[i]).addScaledVector(skiUp, this.ankleH + 0.05).addScaledVector(skiF, this.footFwd - 0.03);
      const pole = _s[4].copy(sf).addScaledVector(sr, s * (0.12 + grab * 0.45 + 0.1 * aw * (1 - prep)) + lean * 0.75 - s * plow * 0.6)
        .addScaledVector(UP, grab * 0.25 + 0.2 * tuckA * aw).normalize();
      solveTwoBone(up, leg, foot, ankle, pole);
      setWorldQuat(foot, _sq[0].copy(q).multiply(fr));
    }

    this.relaxShoulders(0.7);
    // ---- grab: the hand goes to the edge of the ski just in front of the boot; the upper spine bends
    // as far as needed for the arm to reach it
    let grabOn = null;
    if (gp) {
      const k = gp.ski, ss = k === 0 ? -1 : 1, q = this.skiQ[k];
      grabOn = _s[5].copy(skiPos[k]).addScaledVector(_gf.set(0, 0, 1).applyQuaternion(q), gp.along + this.footFwd)
        .addScaledVector(_gl.set(1, 0, 0).applyQuaternion(q), -ss * gp.out * 0.055).addScaledVector(_gu.set(0, 1, 0).applyQuaternion(q), 0.07);
      const arm = gp.hand === 0 ? b.lArm : b.rArm;
      for (let it = 0; it < 3; it++) {
        const sh = worldPos(arm, _rp), sp = worldPos(b.spine1, _rc);
        const short = sh.distanceTo(grabOn) - this.armLen * 0.95;
        if (short <= 0.005) break;
        const a = _ra.subVectors(sh, sp), t = _rb.subVectors(grabOn, sp);
        const axis = _s[6].crossVectors(a, t);
        if (axis.lengthSq() < 1e-8) break;
        rotateWorld(b.spine1, axis.normalize(), Math.min(0.35, short / a.length()) * grab);
      }
    }
    // chest frame (after twist / skid / spin): the arms and poles work in it
    const tr = this.torsoR.subVectors(worldPos(b.rArm, _s[7]), worldPos(b.lArm, _s[8]));
    tr.y = 0;
    if (tr.lengthSq() < 1e-6) tr.copy(right); else tr.normalize();
    const tf = this.torsoF.crossVectors(UP, tr);
    // ---- arms: hands in front at waist height, wider than the hips, elbows soft and out; the inside hand
    // leads through a turn and reaches for the pole plant at turn initiation; hands bob with the body over
    // bumps; arms swing back while loading a jump and up on the pop. In the air they balance out to the
    // sides (wider in spins) and come forward for the landing; a grab sends one hand to the ski and opens
    // the other out to the side.
    const armBob = clamp(-K.ov * 0.035, -0.05, 0.05) * gw;
    for (let i = 0; i < 2; i++) {
      const [arm, fore, hand] = this._arms[i];
      const s = i === 0 ? -1 : 1;
      const pl = this.plant[i];
      const t0 = pl.t;
      pl.t = Math.min(1, pl.t + dt / (0.55 * (Y ? Y.plantDur : 1)));
      // the basket bites into the snow: a small puff
      if (t0 < 0.25 && pl.t >= 0.25 && !pl.rel && !air) this.pushFx({ type: 'pole', x: pl.tip.x, y: pl.tip.y, z: pl.tip.z, amount: clamp(spd / 14, 0.25, 1) });
      const plantEnv = pl.t < 1 ? Math.sin(Math.min(1, pl.t / 0.25) * Math.PI * 0.5) * (1 - smoothT(pl.t, 0.4, 1)) : 0;
      const sh = worldPos(arm, _s[9]);
      const grabbing = gp && i === gp.hand && !this.fp;
      const tgt = _s[10].copy(sh);
      if (this.fp && !this.body.visible) {
        // (hidden-body first person) hands low and wide by the hips, so gloves and poles only show at the lower
        // corners of the view. The (hidden) body leans and twists, so the grips are placed in the
        // skier's frame directly (updateGear), not where the arms happen to reach.
        tgt.copy(root).addScaledVector(UP, this.hipRest.y * (0.88 - 0.12 * cr01) + plantEnv * 0.03)
          .addScaledVector(fwd, plantEnv * 0.07 + (st.tuck ? 0.05 : 0)).addScaledVector(right, s * (0.46 + plantEnv * 0.02));
        this.fpGrip[i].copy(tgt);
        this.fpPlant[i] = plantEnv;
      } else {
        // no poles: hands forward of the hips and wide, elbows soft and bent (never locked straight).
        // The inside hand leads through a turn while the outside arm opens for balance; the hands ride on
        // a spring, so they trail the body over bumps and edge changes, with a slow balancing sway
        const inside = s === Math.sign(incl) ? al : 0, outside = s === -Math.sign(incl) ? al : 0;
        const L = this.armLen, poled = this.poles.length > 0 && !this.fp, fpw = this.fp ? 1 : 0; // first person: no poles, hands low at the edges
        // with poles the hands sit a little further forward on the grips and reach forward for each plant
        let F = L * ((poled ? 0.5 : 0.42) + 0.06 * smoothT(spd, 4, 14) - 0.08 * relax) + plantEnv * (poled ? 0.16 * (Y ? Y.plantReach : 1) : 0) + inside * 0.08 - outside * 0.05
          - charge * 0.3 + 0.22 * popEnv + Math.sin(K.t * 0.9 + i * 2.6) * 0.025 * gw;
        let U = -L * ((poled ? 0.56 : 0.6) + 0.08 * fpw + 0.06 * relax) + plantEnv * (poled ? 0.06 * (Y ? Y.plantReach : 1) : 0) + inside * 0.07 - outside * 0.02 - charge * 0.04 + 0.3 * popEnv + armBob
          + Math.sin(K.t * 1.3 + i * 2.1) * 0.022 * gw;
        let O = (poled ? 0.19 : 0.16) + 0.1 * fpw + plow * 0.1 + askid * 0.12 + charge * 0.1 + 0.03 * relax + outside * 0.12 - inside * 0.03;
        if (Y) { F += Y.armF; U += Y.armU; O += Y.armO; } // the skier's own arm carriage
        const A = this.armS[i];
        if (!K.armInit) { A.F = F; A.U = U; A.O = O; A.vF = A.vU = A.vO = 0; }
        for (const k of ['F', 'U', 'O']) { // critically damped-ish spring toward the pose
          const tv = k === 'F' ? F : k === 'U' ? U : O, vk = 'v' + k;
          A[vk] += ((tv - A[k]) * 110 - A[vk] * 17) * Math.min(dt, 0.05);
          A[k] += A[vk] * Math.min(dt, 0.05);
        }
        F = A.F; U = A.U; O = A.O;
        // tuck: hands together in front of the chin, forearms over the knees
        // holding W: the same arms as the normal stance, just a bit further forward and closer in
        F += 0.03 * tk; U += 0.02 * tk; O -= 0.02 * tk;
        tgt.addScaledVector(tf, F).addScaledVector(UP, U).addScaledVector(tr, s * O);
        if (aw > 0) {
          const sw = Math.abs(spin), free = gp && !grabbing ? grab : 0;
          const wob = Math.sin(K.t * 4.2 + i * 1.7) * 0.05 * (1 - prep) * (1 - sw);
          const ta = _s[11].copy(sh).addScaledVector(tf, 0.14 - sw * 0.08 - free * 0.24 + 0.24 * prep + 0.22 * popEnv)
            .addScaledVector(UP, -0.12 + sw * 0.1 + free * 0.14 - 0.16 * prep + wob + 0.25 * popEnv)
            .addScaledVector(tr, s * (0.42 + sw * 0.12 + free * 0.16 - 0.22 * prep));
          tgt.lerp(ta, aw);
        }
      }
      if (grabbing) tgt.lerp(grabOn, grab);
      const elbow = _s[12].copy(tr).multiplyScalar(s * (0.55 - 0.1 * tk)).addScaledVector(UP, -0.75).addScaledVector(tf, -0.4 + 0.15 * tk).normalize();
      solveTwoBone(arm, fore, hand, tgt, elbow);
      if (grabbing && grab > 0.5) {
        // fingers down over the edge, palm against the side of the ski
        const k = gp.ski, ss = k === 0 ? -1 : 1, q = this.skiQ[k];
        const skiL = _gl.set(1, 0, 0).applyQuaternion(q), skiUp = _gu.set(0, 1, 0).applyQuaternion(q);
        this.aimHand(i, _s[11].copy(skiUp).negate().addScaledVector(fwd, 0.25), skiL.multiplyScalar(ss * gp.out));
      } else {
        if (this.poles.length && !this.fp) {
          // fist around the pole grip: knuckles forward, fingers forward-and-in, palm facing inward
          this.aimHand(i, _s[11].copy(tf).addScaledVector(tr, -s * 0.35).addScaledVector(UP, -0.15), _s[13].copy(tr).multiplyScalar(-s));
        } else if (this.fp) {
          // first person, seen from above: hands hang relaxed (fingers down, palms in), never raised claws
          this.aimHand(i, _s[11].copy(tf).multiplyScalar(0.25).addScaledVector(UP, -1).addScaledVector(tr, s * 0.08), _s[13].copy(tr).multiplyScalar(-s));
        } else {
          // relaxed hand: fingers forward and a little down, palm facing down and slightly in
          this.aimHand(i, _s[11].copy(tf).addScaledVector(UP, -0.45).addScaledVector(tr, s * 0.12), _s[13].copy(UP).multiplyScalar(-1).addScaledVector(tr, -s * 0.5));
        }
      }
    }

    K.armInit = true;

    // Head stays level and looks where the player looks (chin up in the tuck); in a spin it leads the rotation
    rotateWorld(b.neck, right, flex * 0.7 + grab * 0.3); // lift the head so the eyes stay on the slope ahead
    if (tk > 0.01) { rotateWorld(b.neck, right, 0.2 * tk); rotateWorld(b.head, right, 0.3 * tk); }
    if (spin) rotateWorld(b.head, UP, spin * 0.45);
    if (st.lookYaw) rotateWorld(b.head, UP, clamp(st.lookYaw, -1.2, 1.2) * 0.7);
    if (st.lookPitch) rotateWorld(b.head, right, -st.lookPitch * 0.5);
  }

  // Crash poses in the upright frame: a tucked ball while tumbling, sprawled on the side once it
  // stops, then pushing up through a crouch back into the stance. placeFallen() lays it on the snow.
  poseFall(dt, st, fwd, right) {
    const b = this.b;
    const root = this.root.position;
    const F = st.fall;
    const side = st.fallSide || 1;
    const ball = F ? clamp(F.ball || 0, 0, 1) : 0;
    const g = F ? clamp(F.getUp || 0, 0, 1) : 0;
    const P = mixPose(this._fp1, FALL_POSES.lie, FALL_POSES.ball, ball);
    if (g > 0) {
      mixPose(this._fp2, P, FALL_POSES.crouch, smoothT(g, 0, 0.62));
      const stand = FALL_POSES.stand;
      stand.hipH = this.hipRest.y * 0.81;
      mixPose(P, this._fp2, stand, smoothT(g, 0.55, 1));
    }
    // hips
    const hip = root.clone().addScaledVector(UP, P.hipH).addScaledVector(fwd, P.hipF);
    b.hips.position.copy(b.hips.parent.worldToLocal(hip.clone()));
    b.hips.updateMatrixWorld(true);
    rotateWorld(b.hips, right, -P.flex);
    this.fixPosture(right);
    rotateWorld(b.spine1, right, -P.curl * 0.6);
    rotateWorld(b.spine2, right, -P.curl * 0.4);
    // legs: feet tucked up under the body (ball) or forward with bent knees (lying), planted on the
    // snow (skis along the slope) when getting up
    const n = st.normal || UP;
    const footQ = this.skiQuat(fwd, n, 0).multiply(_rqa.setFromAxisAngle(X_AXIS, ball * 0.35));
    for (let i = 0; i < 2; i++) {
      const [up, leg, foot, fr] = i === 0 ? [b.lUp, b.lLeg, b.lFoot, this.footRest.l] : [b.rUp, b.rLeg, b.rFoot, this.footRest.r];
      const s = i === 0 ? -1 : 1;
      const ankle = root.clone().addScaledVector(fwd, P.footF + this.footFwd).addScaledVector(right, s * P.footW);
      ankle.y = world.groundHeight(ankle.x, ankle.z, root.y + 0.5);
      ankle.addScaledVector(n, P.footH + this.ankleH + 0.03);
      const pole = fwd.clone().addScaledVector(right, s * P.knee).addScaledVector(UP, ball * 0.3).normalize();
      solveTwoBone(up, leg, foot, ankle, pole);
      setWorldQuat(foot, footQ.clone().multiply(fr));
    }
    this.relaxShoulders();
    // arms: hugging the shins in a ball; sprawled (the arm toward the snow reaching out) when lying;
    // pushing on the snow / knees while getting up
    for (let i = 0; i < 2; i++) {
      const [arm, fore, hand] = i === 0 ? [b.lArm, b.lFore, b.lHand] : [b.rArm, b.rFore, b.rHand];
      const s = i === 0 ? -1 : 1;
      const a = s === side ? P.g : P.t;
      const sh = worldPos(arm, new THREE.Vector3());
      const tgt = sh.clone().addScaledVector(fwd, a[0]).addScaledVector(UP, a[1]).addScaledVector(right, s * a[2]);
      const elbow = right.clone().multiplyScalar(s).addScaledVector(UP, -0.6).addScaledVector(fwd, -0.4).normalize();
      solveTwoBone(arm, fore, hand, tgt, elbow);
      this.relaxHand(i, UP.clone().negate().addScaledVector(right, -s * 0.5).normalize(), 0.1);
    }
    rotateWorld(b.neck, right, P.neck);
    this.skiPos = null;
  }

  // Lay the posed body onto the snow: tumble/roll rotation about the center of mass, then the lowest
  // point (head, limbs, ski tips...) rests on the surface. The body drops under gravity and is pushed
  // up by the snow, so a tumble bounces naturally.
  placeFallen(dt, st) {
    const b = this.b, root = this.root.position;
    const F = st.fall;
    const pitch = F ? F.pitch || 0 : 0;
    const roll = F ? F.roll || 0 : (st.fallSide || 1) * Math.PI / 2 * smoothT(st.fallT || 0, 0, 1);
    const h = st.fallHeading ?? st.heading;
    const fwdT = _ra.set(Math.sin(h), 0, Math.cos(h)), rightT = _rb.set(-Math.cos(h), 0, Math.sin(h));
    _rqa.setFromAxisAngle(rightT, -pitch);
    _rqb.setFromAxisAngle(fwdT, roll);
    _rqc.multiplyQuaternions(_rqb, _rqa);
    const C = worldPos(b.hips, _rc).addScaledVector(UP, 0.05);
    this.rotateBody(_rqc, C, false);

    // lowest point over the snow
    const yHint = root.y + 0.6;
    let minC = Infinity, low = null;
    for (const [bone, r] of this.fallProbe) {
      worldPos(bone, _gp);
      const c = _gp.y - r - world.groundHeight(_gp.x, _gp.z, yHint);
      if (c < minC) { minC = c; low = bone; }
    }
    if (b.head && b.neck) {
      // top of the head (the head joint sits at the base of the skull)
      _gl.subVectors(worldPos(b.head, _gp), worldPos(b.neck, _gu)).normalize();
      _gp.addScaledVector(_gl, 0.17);
      const c = _gp.y - 0.08 - world.groundHeight(_gp.x, _gp.z, yHint);
      if (c < minC) { minC = c; low = b.head; }
    }
    for (let i = 0; i < 2; i++) {
      if (!this.skis[i]?.visible) continue;
      const foot = i === 0 ? b.lFoot : b.rFoot;
      const q = worldQuat(foot, _rq).multiply(this.footRestInv[i]);
      const up = _gu.set(0, 1, 0).applyQuaternion(q), f = _gf.set(0, 0, 1).applyQuaternion(q);
      worldPos(foot, _rp).addScaledVector(up, -this.ankleH - 0.03);
      for (const e of [-SKI_LENGTH / 2, SKI_LENGTH / 2]) {
        _gp.copy(_rp).addScaledVector(f, e);
        const c = _gp.y - 0.02 - world.groundHeight(_gp.x, _gp.z, yHint);
        if (c < minC) { minC = c; low = null; }
      }
    }
    const D = -minC - 0.02; // settle a little into the snow
    if (st.fallAir) {
      this.fallLift = Math.max(0, D); this.fallLiftV = 0;
    } else if (D >= this.fallLift) {
      // the snow pushes the body up; a hard contact throws up a puff of snow
      if (this.fallLiftV < -2 && low) {
        worldPos(low, _gp);
        this.pushFx({ type: 'impact', x: _gp.x, y: _gp.y + D, z: _gp.z, amount: clamp(-this.fallLiftV / 6, 0.2, 1) });
      }
      this.fallLift += (D - this.fallLift) * (1 - Math.exp(-dt * 30));
      this.fallLiftV = 0;
    } else {
      this.fallLiftV -= 9.81 * dt;
      this.fallLift = Math.max(D, this.fallLift + this.fallLiftV * dt);
    }
    worldPos(b.hips, _rp).y += this.fallLift;
    b.hips.position.copy(b.hips.parent.worldToLocal(_rp));
    b.hips.updateMatrixWorld(true);
  }

  // Flips: the whole skier, skis and poles included, rotates about the center of mass around the
  // sideways axis of the take-off direction (+ = forward somersault).
  flipBody(st) {
    const h = st.flipHeading ?? st.heading;
    _rqc.setFromAxisAngle(_ra.set(-Math.cos(h), 0, Math.sin(h)), -st.flip);
    const C = worldPos(this.b.hips, _rc).addScaledVector(UP, 0.08);
    this.rotateBody(_rqc, C, true);
  }

  // Rigidly rotate the skeleton (through the hips, which parent everything) about world point C.
  rotateBody(q, C, gear) {
    const hips = this.b.hips;
    const hp = worldPos(hips, _rp).sub(C).applyQuaternion(q).add(C);
    const hq = worldQuat(hips, _rqa).premultiply(q);
    hips.position.copy(hips.parent.worldToLocal(hp));
    setWorldQuat(hips, hq);
    if (gear) {
      for (const o of this.gear.children) {
        o.position.sub(C).applyQuaternion(q).add(C);
        o.quaternion.premultiply(q);
      }
    }
  }

  // (returns a shared scratch quaternion: copy it before the next call)
  // Ski orientation on snow with normal `n`: pointing along `fwd`'s compass direction (tilted onto
  // the snow, as the physics does), rolled onto its edge by `edge`.
  skiQuat(fwd, n, edge) {
    const up = _sk.up.copy(n).normalize();
    const f = _sk.f.set(fwd.x, -(up.x * fwd.x + up.z * fwd.z) / Math.max(0.05, up.y), fwd.z).normalize();
    const r = _sk.r.crossVectors(up, f).normalize(); // = left
    _m.makeBasis(r, up, f); // local X = left, Y = up, Z = forward (matches model)
    const q = _sk.q.setFromRotationMatrix(_m);
    if (edge) q.premultiply(_q2.setFromAxisAngle(f, edge));
    return q;
  }

  // Skis in an A-frame on the back (tips together above the head, tails apart), bases resting on the
  // jacket: the line from the seat to the shoulder blades, each measured from this character's mesh
  // (measureBody) plus clearance, so puffy jackets and hoods never poke through. Poles ride on top.
  // Follows the torso's sway.
  placeOnBack(fwd) {
    const b = this.b, P = this._carry ??= { chest: new THREE.Vector3(), low: new THREE.Vector3(), hips: new THREE.Vector3(),
      up: new THREE.Vector3(), back: new THREE.Vector3(), side: new THREE.Vector3(), top: new THREE.Vector3(), bot: new THREE.Vector3(),
      axis: new THREE.Vector3(), tip: new THREE.Vector3(), x: new THREE.Vector3(), m: new THREE.Matrix4() };
    worldPos(b.spine2, P.chest); worldPos(b.spine0, P.low); worldPos(b.hips, P.hips);
    const up = worldPos(b.neck, P.up).sub(P.low).normalize();
    const back = P.back.copy(fwd).negate().addScaledVector(up, fwd.dot(up)).normalize();
    const side = P.side.crossVectors(up, back).normalize();
    // contact points: behind the shoulder blades and behind the seat (the lower one a bit further out,
    // so swinging legs stay clear of the tails)
    // walking, the skis ride a little further out (arms swing past), running the tails bounce out
    // away from the kicking heels (pivoting about the tips, clear of the head)
    const moveW = this.mode === 'move' ? 1 - (this.clips?.idle?.w ?? 0) : this.gait.move;
    const runW = this.mode === 'move' ? this.clips?.run?.w || 0 : this.gait.run;
    // (bindings face the jacket like a real backpack strap carry, so the contact line sits right on it)
    P.top.copy(P.chest).addScaledVector(back, this.backDepth * 0.82 + 0.035 + 0.012 * moveW);
    P.bot.copy(P.hips).addScaledVector(back, this.seatDepth * 0.82 + 0.04 + 0.012 * moveW);
    const axis = P.axis.subVectors(P.top, P.bot).normalize();
    if (axis.dot(up) < 0.8) axis.copy(up); // (degenerate measurements)
    const tipEnd = P.bot.copy(P.top).addScaledVector(axis, 0.94);
    if (runW > 0.01) axis.applyAxisAngle(side, -0.04 * runW); // (on foot you always run now: the skis stay strapped close to the back)
    const face = P.up.crossVectors(side, axis).normalize(); // the back direction, square to the skis
    const m = P.m;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      const tip = P.tip.copy(axis).applyAxisAngle(face, -s * 0.04); // tips lean in, tails a little apart
      // bases out, bindings toward the back (top sheet faces the jacket)
      const x = P.x.crossVectors(face, tip).normalize().negate();
      m.makeBasis(x, _v3.copy(face).negate(), tip);
      this.skis[i].quaternion.setFromRotationMatrix(m);
      // side by side, the tips just above the head, bases on the contact line
      this.skis[i].position.copy(tipEnd).addScaledVector(axis, -SKI_LENGTH / 2).addScaledVector(side, s * 0.05);
    }
    for (let i = 0; i < this.poles.length; i++) {
      const s = i === 0 ? 1 : -1;
      const pole = this.poles[i];
      // origin is the grip; shaft hangs along -Y toward the ground, riding on top of the skis
      pole.position.copy(tipEnd).addScaledVector(face, 0.03).addScaledVector(side, s * 0.025).addScaledVector(axis, -0.58);
      pole.quaternion.setFromUnitVectors(_v2.set(0, -1, 0), _v1.copy(axis).negate().applyAxisAngle(face, s * 0.05));
    }
  }

  updateGear(dt, st, fwd, right) {
    if (!this.skis.length) return;
    if (this.carry && st.mode !== 'sit') { this.placeOnBack(fwd); this.poleDirOk = false; return; }
    const b = this.b;
    const n = st.normal || UP;
    // skis under the boots
    for (let i = 0; i < 2; i++) {
      const ski = this.skis[i];
      const foot = i === 0 ? b.lFoot : b.rFoot;
      const ankle = worldPos(foot, _s[0]);
      let q;
      if (st.mode === 'sit') {
        q = this.skiQuat(fwd, UP, 0).multiply(_q1.setFromAxisAngle(X_AXIS, -0.35));
        ski.position.copy(ankle).addScaledVector(UP, -this.ankleH - 0.03);
      } else if (st.mode === 'fall') {
        q = worldQuat(foot, _sq[1]).multiply(this.footRestInv[i]);
        ski.position.copy(ankle).addScaledVector(_s[1].set(0, 1, 0).applyQuaternion(q), -this.ankleH - 0.03);
      } else if (this.mode === 'ski') {
        // as posed: edge angle, snowplow wedge, hockey-stop skid, pitch in the air
        q = this.skiQ[i];
        const up = _gu.set(0, 1, 0).applyQuaternion(q), f = _gf.set(0, 0, 1).applyQuaternion(q);
        ski.position.copy(ankle).addScaledVector(up, -this.ankleH - 0.04).addScaledVector(f, 0.03);
      } else {
        const plowYaw = (st.plow || 0) * 0.3 * (i === 0 ? -1 : 1);
        const f = _s[2].copy(fwd).applyAxisAngle(UP, plowYaw);
        q = this.skiQuat(f, n, (st.lean || 0) * 0.45);
        ski.position.copy(ankle).addScaledVector(n, -this.ankleH - 0.04).addScaledVector(f, 0.03);
      }
      ski.quaternion.copy(q);
    }
    // poles: grip in the fist, shaft angled back or planted in the snow
    const K = this.sk, tf = this.torsoF, tr = this.torsoR;
    const skiing = st.mode === 'ski' && !this.fp && this.mode === 'ski';
    for (let i = 0; i < this.poles.length; i++) {
      const pole = this.poles[i];
      const hand = i === 0 ? b.lHand : b.rHand;
      const fore = i === 0 ? b.lFore : b.rFore;
      const hp = worldPos(hand, _s[0]);
      const hd = _s[1].subVectors(hp, worldPos(fore, _s[2])).normalize();
      // the grip sits in the palm: a little along the fingers and just off the palm
      const grip = _s[2].copy(hp).addScaledVector(hd, 0.075);
      const hg = this.handGeo[i];
      if (hg) {
        const hq = worldQuat(hand, _rqb);
        grip.copy(hp).addScaledVector(_v3.copy(hg.dir).applyQuaternion(hq), 0.07).addScaledVector(_v4.copy(hg.normal).applyQuaternion(hq), 0.035);
      }
      const s = i === 0 ? -1 : 1;
      let dir = _s[3];
      const pl = this.plant[i];
      if (st.mode === 'sit') {
        dir.copy(DOWN).addScaledVector(fwd, 0.2).normalize();
      } else if (st.mode === 'fall') {
        // held loosely, trailing along the forearm, never through the snow
        dir.copy(hd).addScaledVector(fwd, -0.4).addScaledVector(right, s * 0.2).normalize();
        const tip = _s[4].copy(grip).addScaledVector(dir, POLE_LEN - 0.08);
        const gy = world.groundHeight(tip.x, tip.z, this.root.position.y + 0.6) + 0.03;
        if (tip.y < gy) { tip.y = gy; dir.copy(tip.sub(grip)).normalize(); }
      } else if (st.mode === 'ski' && this.fp) {
        // first person: shafts angled back and out from the low grips (lower screen corners only);
        // a pole plant is a short tap of the basket down beside the skis, never across the view
        grip.copy(this.fpGrip[i]);
        dir.copy(fwd).multiplyScalar(-0.45).addScaledVector(UP, -0.75).addScaledVector(right, s * 0.5).normalize();
        // (angled out so the basket meets the snow beside the skis instead of going through it)
        const tap = this.fpPlant[i] * (1 - this.airW);
        if (tap > 0) dir.lerp(_v3.copy(fwd).multiplyScalar(0.35).addScaledVector(UP, -0.73).addScaledVector(right, s * 0.6).normalize(), tap).normalize();
      } else if (skiing) {
        // carried angled back and a little out (baskets trailing behind the boots), tucked under the arms
        // in the tuck; at turn initiation the basket swings forward to the snow beside the boot, stays
        // there while the body skis past, then the pole swings back
        dir.copy(tf).multiplyScalar(-0.72).addScaledVector(UP, -0.68).addScaledVector(tr, s * (0.22 + Math.min(1, Math.abs(K.skid)) * 0.2 + K.plow * 0.12)).normalize();
        if (K.tk > 0.001) dir.lerp(_s[4].copy(tf).negate().addScaledVector(UP, -0.45).addScaledVector(tr, s * 0.16).normalize(), K.tk * 0.25).normalize(); // a touch more swept back
        let snap = false;
        if (pl.t < 0.55 && !pl.rel && this.airW < 0.5) {
          const td = _s[4].subVectors(pl.tip, grip);
          if (pl.t > 0.25 && td.dot(fwd) < -0.3) pl.rel = true; // the body has skied past the basket: let go
          else {
            const r = smoothT(pl.t, 0, 0.25);
            dir.lerp(td.normalize(), r).normalize();
            snap = r > 0.999;
          }
        }
        if (this.airW > 0) {
          // in the air: swept back, a little out to the sides; a grabbing hand lays its pole back
          // along the outside of the grabbed ski
          const da = _s[5].copy(tf).multiplyScalar(-0.72).addScaledVector(UP, -0.55).addScaledVector(tr, s * 0.3).normalize();
          const gp = GRAB_POSES[st.grabType];
          if (gp && gp.hand === i && st.grab > 0.01) {
            const q = this.skiQ[gp.ski], ss = gp.ski === 0 ? -1 : 1;
            const along = _gf.set(0, 0, 1).applyQuaternion(q).multiplyScalar(-0.85);
            along.addScaledVector(_gl.set(1, 0, 0).applyQuaternion(q), -ss * 0.3).addScaledVector(_gu.set(0, 1, 0).applyQuaternion(q), -0.2).normalize();
            da.lerp(along, clamp(st.grab, 0, 1)).normalize();
          }
          const w = this.airW * this.airW * (3 - 2 * this.airW);
          dir.lerp(da, w).normalize();
        }
        // the poles hang from the wrist straps: they swing after the hands with a little lag; a planted
        // pole stays put
        const pd = this.poleDir[i];
        if (!this.poleDirOk || snap) pd.copy(dir);
        else pd.lerp(dir, 1 - Math.exp(-dt * 16)).normalize();
        dir = _s[8].copy(pd);
        // baskets never through the snow (uphill behind, or the inside hand low in a carve): swing the pole
        // back toward trailing flat behind the hand, just as far as needed
        if (!snap && this.airW < 0.5 && this.poleUnder(grip, dir)) {
          const back = _s[7].copy(tf).multiplyScalar(-0.96).addScaledVector(UP, 0.06).addScaledVector(tr, s * 0.25).normalize();
          const from = _s[9].copy(dir);
          if (this.poleUnder(grip, back)) dir.copy(back);
          else {
            let lo = 0, hi = 1;
            for (let it = 0; it < 4; it++) {
              const mid = (lo + hi) / 2;
              if (this.poleUnder(grip, dir.copy(from).lerp(back, mid).normalize())) lo = mid; else hi = mid;
            }
            dir.copy(from).lerp(back, hi).normalize();
          }
        }
      } else if (st.tuck) {
        dir.copy(fwd).negate().addScaledVector(UP, -0.18).addScaledVector(right, s * 0.08).normalize();
      } else {
        dir.copy(fwd).multiplyScalar(-0.62).addScaledVector(UP, -0.72).addScaledVector(right, s * 0.16).normalize();
      }
      pole.position.copy(grip);
      if (st.mode === 'ski' && this.fp) {
        // first person: roll the pole so its wrist strap (local -X) hangs outward, never into the view
        const y = _v2.copy(dir).negate(), x = _v3.copy(right).multiplyScalar(-s);
        x.addScaledVector(y, -x.dot(y)).normalize();
        _m.makeBasis(x, y, _v4.crossVectors(x, y));
        pole.quaternion.setFromRotationMatrix(_m);
      } else pole.quaternion.setFromUnitVectors(_v2.set(0, -1, 0), dir);
    }
    this.poleDirOk = skiing;
  }

  poleUnder(grip, dir) {
    const tip = _s[10].copy(grip).addScaledVector(dir, POLE_LEN - 0.08);
    return tip.y < world.groundHeight(tip.x, tip.z, tip.y + 0.6) + 0.05;
  }

  // ---------------------------------------------------------------- first-person hands + poles (view model)
  // Skiing in first person you see your gloved hands holding the poles. Each glove and its pole are one rigid
  // piece (no IK: nothing can come apart or glitch), carried in the camera's frame low at the sides of the
  // picture with the shafts angled back. They move with the skiing: the inside hand leads through a turn, a
  // pole plant swings the basket forward to the snow at each turn, double-pole strokes when skating off or
  // leaving a start gate, hands a little closer in for the tuck, out for balance in the air, down with a
  // landing; and they have weight: they trail the head a little through turns, bumps and landings.
  buildFpView() {
    const g = new THREE.Group();
    g.name = 'fp-hands';
    this.fpHands = [];
    for (let i = 0; i < 2; i++) {
      const H = makeFpHand(i === 1);
      g.add(H.root, H.cuff);
      this.fpHands.push({ ...H, p: new THREE.Vector3(), v: new THREE.Vector3(), d: new THREE.Vector3(), dv: new THREE.Vector3() });
    }
    this.gear.add(g);
    this.fpView = g;
    this.fpS = { t: 0, raise: 0, init: false, air: 0, q: new THREE.Quaternion(), e: new THREE.Vector3(), ev: new THREE.Vector3(),
      acc: new THREE.Vector3(), lag: new THREE.Vector3(), lagV: new THREE.Vector3(), w: new THREE.Vector3() };
  }

  // The Meshy arms (fpArmTemplate) on the fists once loaded, in your colours: the sleeve your jacket (the outfit
  // shader's jacket colour, else the character's own sleeve), the gloves the character's own; follows the shop.
  // false while loading (or if it can't load): the procedural fists stay.
  syncFpArms() {
    const T = fpArmTemplate();
    if (!T || !this.fpHands) return false;
    if (!this.fpArmMat) {
      this.fpArmMat = fpArmMaterial(T);
      for (const H of this.fpHands) {
        const m = new THREE.Mesh(T.geo, this.fpArmMat);
        m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
        H.root.add(m); H.arm = m;
      }
    }
    const mesh = this.skinned, mat = mesh && (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
    const J = mat?.userData?.outfit?.uOfTgt?.value?.[0] || null, K = (this.fpArmKey ||= { mat: undefined, x: 0, y: 0, z: 0, w: 0 });
    if (K.mat !== mat || (J && (K.x !== J.x || K.y !== J.y || K.z !== J.z || K.w !== J.w))) {
      K.mat = mat;
      if (J) { K.x = J.x; K.y = J.y; K.z = J.z; K.w = J.w; }
      const U = this.fpArmMat.userData.fpArm, glove = fpRigColour(this, 'lHand');
      if (glove) U.uGlove.value.copy(glove);
      if (J && J.w > 0) fpLabColour(J.x, J.y, J.z, U.uSleeve.value);
      else { const c = fpRigColour(this, 'lFore'); if (c) U.uSleeve.value.copy(c); }
    }
    return true;
  }

  /**
   * Per frame, after the camera (player.js): show and pose the first-person hands.
   * @param {object} st  { skiing, speed, tuck, edge (-1..1, + leaning right), air, absorb, charge, pop, brake,
   *                       grab, grabType, spin } — everything but `skiing` optional
   */
  updateFpView(dt, camera, st) {
    const show = this.fp && !!this.poleGltf && st.skiing && !this.fpGearHidden && this.skis[0]?.visible !== false;
    if (!show) { if (this.fpView) { this.fpView.visible = false; this.fpS.raise = 0; this.fpS.init = false; } return; }
    if (!this.fpView) this.buildFpView();
    const V = this.fpView, S = this.fpS, h = clamp(dt, 0, 0.05);
    V.visible = true;
    // the Meshy arms once loaded, else the procedural fists (a failure here never takes the hands away)
    let arms = false;
    try { arms = this.syncFpArms(); } catch (e) { if (!this.fpArmErr) { this.fpArmErr = String(e?.message || e); console.warn('first-person arms', e); } }
    for (const H of this.fpHands) {
      // (the procedural fist is taken off, not hidden: the car's stand-in fists are clones of it)
      if (arms && H.glove.parent) H.root.remove(H.glove); else if (!arms && !H.glove.parent) H.root.add(H.glove);
      H.cuff.visible = !arms; if (H.arm) H.arm.visible = arms;
    }
    V.position.copy(camera.position);
    V.quaternion.copy(camera.quaternion);
    S.t += h;
    if (!S.init) {
      S.init = true; S.q.copy(camera.quaternion); S.e.copy(camera.position); S.ev.set(0, 0, 0); S.acc.set(0, 0, 0);
      S.lag.set(0, 0, 0); S.lagV.set(0, 0, 0); S.w.set(0, 0, 0);
      for (const H of this.fpHands) H.init = false;
    }
    // the hands come up into the picture when they appear (clicking into the skis, getting up after a fall)
    S.raise = Math.min(1, S.raise + h / 0.4);
    const rise = 1 - S.raise * S.raise * (3 - 2 * S.raise);
    // ---- inertia: the head's turn rate and acceleration in its own frame; the hands trail it a little
    if (h > 1e-4) {
      const dq = _q2.copy(S.q).invert().multiply(camera.quaternion);
      if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
      const k = 2 / h;
      S.w.lerp(_v1.set(clamp(dq.x * k, -6, 6), clamp(dq.y * k, -6, 6), clamp(dq.z * k, -6, 6)), ek(h, 14));
      const vel = _v1.subVectors(camera.position, S.e).divideScalar(h);
      const acc = _v2.subVectors(vel, S.ev).divideScalar(h);
      if (vel.lengthSq() > 2500 || S.ev.lengthSq() > 2500) acc.set(0, 0, 0); // a teleport, not a motion
      S.ev.copy(vel);
      acc.applyQuaternion(_q3.copy(camera.quaternion).invert()).clampLength(0, 60);
      S.acc.lerp(acc, ek(h, 25)); // (frame-to-frame noise off)
      // spring-damper on the shared hand offset, driven by the head's acceleration (bumps, landings, edge sets):
      // ~3 cm for a hard landing, a few mm over bumps
      const W = 12, Z = 0.55, g = 0.08, a = S.acc;
      S.lagV.x += (-W * W * S.lag.x - 2 * Z * W * S.lagV.x - a.x * g) * h;
      S.lagV.y += (-W * W * S.lag.y - 2 * Z * W * S.lagV.y - a.y * g) * h;
      S.lagV.z += (-W * W * S.lag.z - 2 * Z * W * S.lagV.z - a.z * g) * h;
      S.lag.addScaledVector(S.lagV, h).clampLength(0, 0.07);
    }
    S.q.copy(camera.quaternion); S.e.copy(camera.position);
    const tk = clamp(st.tuck || 0, 0, 1), spd = st.speed || 0, lean = clamp(st.edge || 0, -1, 1);
    S.air += ((st.air ? 1 : 0) - S.air) * ek(h, st.air ? 6 : 12);
    const airW = S.air * S.air * (3 - 2 * S.air), spin = clamp(Math.abs(st.spin || 0) / 7, 0, 1) * airW;
    const absorb = clamp(st.absorb || 0, 0, 1), charge = clamp(st.charge || 0, 0, 1), pop = clamp(st.pop || 0, 0, 1);
    const brake = clamp(st.brake || 0, 0, 1), grab = clamp(st.grab || 0, 0, 1), grabHand = GRAB_POSES[st.grabType]?.hand ?? 1;
    // both poles planted together: a double-pole stroke (skating off, a start gate, pushing on in the tuck)
    const dbl = this.plant[0].t < 1 && Math.abs(this.plant[0].t - this.plant[1].t) < 0.03;
    // turning the view: the hands trail it up and down with the pitch rate, never sideways (Oct 27, the user: the hands
    // "go inside, they should just go backward": every motion of the hands is now along the arms, back and forth,
    // never in toward the middle of the picture)
    const turnY = clamp(-S.w.x * 0.018, -0.04, 0.04);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1, H = this.fpHands[i], pl = this.plant[i];
      // ---- where the hand wants to be (camera frame: x right, y up, -z ahead; FP_POSE)
      const P = FP_POSE;
      const T = _v3.set(s * (P.x - 0.05 * tk), P.y + 0.012 * tk, P.z - 0.04 * tk);
      const ins = Math.max(0, s * lean), out = Math.max(0, -s * lean); // inside / outside hand of the turn
      T.y += 0.015 * ins - 0.008 * out; T.z += 0.03 * out - 0.02 * ins;
      T.x += s * (0.03 + 0.03 * spin) * airW; T.y += 0.035 * airW; T.z += 0.02 * airW; // balance in the air (out, never in)
      T.y -= 0.11 * absorb; T.z -= 0.03 * absorb;                                     // landing: down with the legs
      T.y += 0.05 * pop - 0.045 * charge; T.z += 0.07 * charge - 0.07 * pop;          // load a jump: back; pop: up
      T.z -= 0.04 * brake;                                                            // hockey stop: braced
      // ---- the pole (direction of the shaft from the grip): angled back, swept back further in the tuck,
      // out a little in the air
      const D = _v4.set(s * 0.2, -0.95, 0.24).lerp(_s[0].set(s * 0.1, -0.7, 0.7), tk);
      D.lerp(_s[0].set(s * 0.45, -0.84, 0.28), airW).lerp(_s[0].set(s * 0.32, -0.94, 0.06), brake);
      // ---- pole plants (the rig's plant timer: 0..1 over 0.55 s)
      const pt = pl.t;
      if (pt < 1) {
        if (dbl) {
          // double-pole stroke: both hands push straight back and down past the hips, then come forward again
          const push = smoothT(pt, 0, 0.35) * (1 - smoothT(pt, 0.45, 1));
          T.z += 0.09 * push; T.y -= 0.07 * push;
          D.lerp(_s[0].set(s * 0.16, -0.55, 0.82), push);
        } else {
          // a pole plant: the hand gives a short push straight back (the basket behind the boot), then returns
          const push = smoothT(pt, 0, 0.25) * (1 - smoothT(pt, 0.35, 0.85));
          T.z += 0.06 * push; T.y -= 0.035 * push;
          D.lerp(_s[0].set(s * 0.18, -0.7, 0.69), push);
        }
      }
      // ---- grabs: the grabbing hand drops to the ski (out of the picture), the other opens out
      if (grab > 0) {
        const mine = grabHand === i;
        if (mine) { T.lerp(_s[0].set(s * 0.16, -0.78, -0.3), grab); D.lerp(_s[0].set(s * 0.1, -0.4, 0.91), grab); }
        else { T.y += 0.06 * grab; }
      }
      D.normalize();
      // ---- springs toward the pose (the plant swing is quicker than the hands' drift)
      if (!H.init) { H.init = true; H.p.copy(T); H.v.set(0, 0, 0); H.d.copy(D); H.dv.set(0, 0, 0); }
      springTo(H.p, H.v, T, 15, h);
      springTo(H.d, H.dv, D, 24, h);
      H.d.normalize();
      // ---- place the rigid fist + pole: grip at the hand, pole along the shaft direction, knuckles forward and a
      // little in; the cuff turns at the wrist toward the elbow (below the picture, so the forearm leaves it
      // through the bottom corner)
      const p = H.root.position.copy(H.p).add(S.lag);
      const sway = 0.5 + smoothT(spd, 3, 15); // (a little livelier at speed)
      p.x += -S.lag.x * 0.7 + Math.sin(S.t * 1.7 + i * 2.3) * 0.002 * sway; p.y += turnY + Math.sin(S.t * 2.3 + i * 1.1) * 0.003 * sway - 0.32 * rise; p.z += 0.06 * rise;
      const Y = _s[1].copy(H.d).negate();
      // (the Meshy arm: the fist turned about the pole so the forearm runs off toward the elbow, low and outside: the
      // sleeve leaves the picture through the bottom corner)
      const Zb = arms ? _s[3].set(s * P.ex, P.ey - 0.05 * absorb, P.ez).sub(p).negate() : _s[3].set(-s * 0.28, -0.2, -1);
      Zb.addScaledVector(Y, -Zb.dot(Y)).normalize();
      const X = _s[4].crossVectors(Y, Zb);
      _m.makeBasis(X, Y, Zb);
      H.root.quaternion.setFromRotationMatrix(_m);
      const wrist = H.cuff.position.copy(FP_WRIST);
      wrist.x *= -s; // (the right fist is mirrored)
      wrist.applyQuaternion(H.root.quaternion).add(p);
      const elbow = _s[2].set(s * P.ex, P.ey - 0.05 * absorb, P.ez).sub(wrist).normalize(); // wrist -> elbow
      H.cuff.quaternion.setFromUnitVectors(UP, elbow);
    }
  }

  get eyeWorld() {
    const p = worldPos(this.b.head, new THREE.Vector3());
    return p.add(this.eyeOffset.clone().applyQuaternion(this.root.quaternion));
  }
}

// First-person view model's rest pose (camera frame, m; the left hand mirrored): the fist (x, y, z) and the elbow its
// forearm runs off toward (ex, ey, ez). The elbow sits low and back by your side, so the sleeves leave the picture
// through its bottom corners and the fists show knuckles forward round the grips. (Oct 27, the user: the hands were
// hard to see at the picture's bottom edge; then, with the elbow moved forward too, the sleeves ran in sideways like
// tubes and the gloves turned into claws.) Exported for tuning from the dev console.
export const FP_POSE = { x: 0.26, y: -0.29, z: -0.6, ex: 0.3, ey: -0.72, ez: -0.1 };
function ek(h, r) { return 1 - Math.exp(-h * r); } // exponential smoothing factor for step h at rate r
// exact critically damped spring step of vector x (velocity v) toward t at angular frequency w (stable at any h)
function springTo(x, v, t, w, h) {
  const e = Math.exp(-w * h);
  for (const k of AXES3) {
    const d = x[k] - t[k], c = v[k] + w * d;
    x[k] = t[k] + (d + c * h) * e;
    v[k] = (v[k] - c * w * h) * e;
  }
}
const AXES3 = ['x', 'y', 'z'];
function smoothT(x, a, b) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
