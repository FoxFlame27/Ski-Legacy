// Race spectators built from real character models (Meshy rigs: public/models/fan_*.glb, made by
// tools/meshy-fans.mjs + tools/build-fans.mjs): eight people in winter clothes, drawn as InstancedMeshes with a
// per-instance skeleton. Every fan has its own row of bone matrices in a float texture (one texture per crowd),
// the vertex shader skins the instance with it - so hundreds of fans cost a handful of draw calls and no
// SkinnedMesh objects.
//
// Motion is procedural (no canned clips): at load every character is posed with two-bone IK into keyframes
// (relaxed stance with the weight on either leg, hands held, clapping open / shut, both arms up, waving,
// fist pumps, flag waving, cowbell shaking, a crouch for jumps). Each frame a fan's pose is a quaternion blend of
// a few keyframes driven by its own rhythm, phase and excitement, plus a head that follows the racer; the
// skeleton is composed on the CPU (20 bones) into the texture. Far fans are posed less often.
//
// Three LODs share the skeleton (textured ~16.6k triangles near, vertex-coloured ~3.6k / ~1k further out). LOD
// switches cross-fade with a screen-door dither (no popping), the crowd's far edge fades the same way; fans off
// screen are neither drawn nor posed. A soft contact shade under every fan ties the boots to the snow.
// Variety: eight characters, jacket recolouring (chroma-keyed, keeps the texture's folds), scale, props (country
// flags, cowbells) and personalities (energy, style, jumpers).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB } from '../core/assets.js';

export const FAN_MODELS = ['fan_man', 'fan_woman', 'fan_elder', 'fan_girl', 'fan_kid', 'fan_lady', 'fan_teen', 'fan_skier'];
// per character: share of the crowd, body scale range, chance to keep the original jacket colour
const FAN_CFG = {
  fan_man: { share: 1.1, scale: [0.96, 1.04], keep: 0.3 },
  fan_woman: { share: 1.0, scale: [0.97, 1.04], keep: 0.3 },
  fan_elder: { share: 0.7, scale: [0.97, 1.03], keep: 0.35 },
  fan_girl: { share: 0.85, scale: [0.97, 1.04], keep: 1 },
  fan_kid: { share: 0.35, scale: [0.9, 1.06], keep: 0.5 },
  fan_lady: { share: 0.6, scale: [0.97, 1.03], keep: 0.35 },
  fan_teen: { share: 0.75, scale: [0.97, 1.04], keep: 0.4 },
  fan_skier: { share: 0.85, scale: [0.97, 1.03], keep: 0.3 },
};

const BONE_NAMES = ['Hips', 'Spine02', 'Spine01', 'Spine', 'neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const NBA = BONE_NAMES.length; // animated bones
const PROP = NBA;              // + one bone for the hand-held prop
const NB = NBA + 1;
const ROW = NB * 3 + 2;        // texels per fan: 3 per bone matrix, 2 per-fan constants
const BI = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
const UPPER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const LOWER = [0, 14, 15, 16, 17, 18, 19];

// keyframes
// (WALK0.. WALK0 + NWALK - 1: phases of a walking cycle; TALK_* / PHONE / POINT / SHRUG / WATCH: people waiting and
// chatting (FanCrowd.dynamic); CARRY: skis over the right shoulder)
export const NWALK = 12;
export const WALK_STRIDE = 1.16; // m covered by one walking cycle (two steps)
const K = { STAND_L: 0, STAND_R: 1, HOLD: 2, CLAP_O: 3, CLAP_S: 4, CLAPHI_O: 5, CLAPHI_S: 6, VUP_A: 7, VUP_B: 8,
  WAVE_A: 9, WAVE_B: 10, PUMP_LO: 11, PUMP_HI: 12, FLAG_REST: 13, FLAG_A: 14, FLAG_B: 15, BELL_REST: 16, BELL_A: 17, BELL_B: 18, CROUCH: 19, POCKET: 20,
  WALK0: 21, TALK_A: 21 + NWALK, TALK_B: 22 + NWALK, TALK_C: 23 + NWALK, PHONE: 24 + NWALK, POINT: 25 + NWALK, SHRUG: 26 + NWALK, WATCH: 27 + NWALK,
  CARRY: 28 + NWALK };
const NK = 29 + NWALK;
const CARRY_DIR = new THREE.Vector3(0.07, -Math.tan(0.42), 1).normalize(); // the carried skis' tips: ahead, down, a little inward
const CARRY_MARK = new Float32Array(4); // (composeRow: the skis follow the chest)
const CARRY_REST = new THREE.Vector3(0, -0.045, -0.2); // the skis' resting point on the shoulder in their own frame
for (let j = 1; j < NWALK; j++) K[`WALK${j}`] = K.WALK0 + j; // (names for the lookdev page)
export { K as FAN_KEYS };
// cheer styles: [keyframe A, keyframe B, rhythm (Hz), oscillator shape]
export const STYLE = { CLAP: 0, CLAPHI: 1, VUP: 2, WAVE: 3, PUMP: 4, FLAG: 5, BELL: 6 };
const STYLES = [
  [K.CLAP_O, K.CLAP_S, 2.3, 'clap'],
  [K.CLAPHI_O, K.CLAPHI_S, 2.0, 'clap'],
  [K.VUP_A, K.VUP_B, 1.5, 'sin'],
  [K.WAVE_A, K.WAVE_B, 1.3, 'sin'],
  [K.PUMP_LO, K.PUMP_HI, 1.7, 'pump'],
  [K.FLAG_A, K.FLAG_B, 0.85, 'sin'],
  [K.BELL_A, K.BELL_B, 4.2, 'sin'],
];

// realistic jacket colours (sRGB)
const JACKETS = ['#b3201b', '#1c2a4a', '#2050b8', '#4f8fcf', '#d9a91d', '#d8601a', '#2c6e45',
  '#5a3384', '#c73a6e', '#6b1d28', '#1f7a80', '#c8261d', '#0f3d91'];
// flags: Austria, Italy, France, Germany, Switzerland, Norway, Sweden (shader fanFlag)
const NFLAGS = 7;

// ------------------------------------------------------------------ IK helpers (three.js bones, load time only)
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const wpos = (o, out) => out.setFromMatrixPosition(o.matrixWorld);
const wquat = (o, out) => { o.matrixWorld.decompose(_v4, out, _v3); return out.normalize(); };
function setWorldQuat(bone, q) {
  wquat(bone.parent, _q3);
  bone.quaternion.copy(_q3.invert().multiply(q)).normalize();
  bone.updateMatrixWorld(true);
}
function rotateWorld(bone, axis, angle) {
  wquat(bone, _q2);
  _q1.setFromAxisAngle(axis, angle).multiply(_q2);
  setWorldQuat(bone, _q1);
}
function aimBone(bone, from, to, pivot) {
  const u = _v1.subVectors(from, pivot).normalize(), w = _v2.subVectors(to, pivot).normalize();
  if (u.lengthSq() < 1e-8 || w.lengthSq() < 1e-8) return;
  const q = new THREE.Quaternion().setFromUnitVectors(u, w);
  setWorldQuat(bone, q.multiply(wquat(bone, new THREE.Quaternion())));
}
// two-bone IK: the middle joint toward `pole`, then aim both bones (minimal rotations)
function solveTwoBone(a, b, c, target, pole, maxReach = Infinity) {
  const pa = wpos(a, new THREE.Vector3()), pb = wpos(b, new THREE.Vector3()), pc = wpos(c, new THREE.Vector3());
  const lab = pa.distanceTo(pb), lcb = pb.distanceTo(pc);
  const dir = target.clone().sub(pa);
  const dist = THREE.MathUtils.clamp(dir.length(), Math.abs(lab - lcb) + 1e-3, Math.min(maxReach, (lab + lcb) * 0.999));
  dir.normalize();
  const cosA = THREE.MathUtils.clamp((lab * lab + dist * dist - lcb * lcb) / (2 * lab * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pp = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (pp.lengthSq() < 1e-8) pp.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pp.normalize();
  const knee = pa.clone().addScaledVector(dir, lab * cosA).addScaledVector(pp, lab * sinA);
  aimBone(a, pb, knee, pa);
  const pb2 = wpos(b, new THREE.Vector3()), pc2 = wpos(c, new THREE.Vector3());
  aimBone(b, pc2, pa.clone().addScaledVector(dir, dist), pb2);
}

// ------------------------------------------------------------------ the character kit
class FanKit {
  constructor(name, gltf) {
    const t0 = performance.now();
    this.name = name;
    this.cfg = FAN_CFG[name] || { share: 1, scale: [0.97, 1.03], keep: 0.3 };
    const root = SkeletonUtils.clone(gltf.scene);
    root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1);
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    if (!meshes.length) throw new Error(`${name}: no skinned mesh`);
    const named = {};
    root.traverse((o) => { if (o.isBone) named[o.name] = o; });
    const bones = BONE_NAMES.map((n) => named[n]);
    if (bones.some((b) => !b)) throw new Error(`${name}: missing bones`);
    this.root = root; this.bones = bones;
    this.allBones = []; root.traverse((o) => { if (o.isBone) this.allBones.push(o); });
    this.restLocal = this.allBones.map((b) => ({ q: b.quaternion.clone(), p: b.position.clone() }));
    const pal = (b) => { while (b && !(b.isBone && b.name in BI)) b = b.parent; return b ? BI[b.name] : 0; };
    this.parent = new Int8Array(NBA);
    bones.forEach((b, i) => { this.parent[i] = i === 0 ? -1 : pal(b.parent); });
    for (let i = 1; i < NBA; i++) if (this.parent[i] >= i) throw new Error(`${name}: bone order`);

    // rest skeleton (model space: metres, feet at y = 0, facing +z, character's left = +x)
    this.P0 = new Float32Array(NBA * 3); this.Q0 = new Float32Array(NBA * 4); this.Q0i = new Float32Array(NBA * 4);
    this.O = new Float32Array(NBA * 3);
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    bones.forEach((b, i) => {
      wpos(b, p); wquat(b, q);
      p.toArray(this.P0, i * 3); q.toArray(this.Q0, i * 4); q.clone().invert().toArray(this.Q0i, i * 4);
    });
    for (let i = 1; i < NBA; i++) {
      const pi = this.parent[i];
      p.fromArray(this.P0, i * 3).sub(_v1.fromArray(this.P0, pi * 3)).applyQuaternion(q.fromArray(this.Q0i, pi * 4));
      p.toArray(this.O, i * 3);
    }

    // bake the LOD geometries (rest positions in model space, palette bone indices)
    const lods = meshes.map((m) => ({ m, tex: !!m.geometry.attributes.uv, n: m.geometry.index ? m.geometry.index.count : 0 }));
    const tex = lods.filter((l) => l.tex).sort((a, b) => b.n - a.n);
    const vc = lods.filter((l) => !l.tex).sort((a, b) => b.n - a.n);
    const order = [tex[0], vc[0] || tex[0], vc[1] || vc[0] || tex[0]];
    this.measureHands(meshes[0]);
    this.measureBody();
    this.measureLegs();
    const propGeo = this.buildProps();
    this.geos = order.map((l) => this.bakeGeometry(l.m, propGeo));
    const bp = this.geos[0].attributes.position, nBody = bp.count - propGeo.count;
    let top = 0;
    for (let i = 0; i < nBody; i++) top = Math.max(top, bp.getY(i));
    this.height = top;
    this.materials = [order[0].m.material, order[1].m.material, order[2].m.material];
    this.base = this.jacketBase(this.geos[1]);
    this.bakeKeyframes();
    this.resetPose();
    this.bakeMs = performance.now() - t0;
  }

  // world (model space) transform of every vertex at the bind pose, skin indices remapped to the palette
  bakeGeometry(mesh, propGeo) {
    const g = mesh.geometry, skel = mesh.skeleton;
    mesh.updateMatrixWorld(true);
    const C = skel.bones.map((b, j) => new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse)
      .multiply(_m4.multiplyMatrices(b.matrixWorld, skel.boneInverses[j])).multiply(mesh.bindMatrix));
    const map = skel.bones.map((b) => { let o = b; while (o && !(o.isBone && o.name in BI)) o = o.parent; return o ? BI[o.name] : 0; });
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const n = pos.count, np = propGeo.count;
    const P = new Float32Array((n + np) * 3), N = new Float32Array((n + np) * 3);
    const U = uv ? new Float32Array((n + np) * 2) : null, Cc = col ? new Float32Array((n + np) * 3) : null;
    const Bn = new Float32Array((n + np) * 4), Wt = new Float32Array((n + np) * 4), Info = new Float32Array((n + np) * 3);
    const v = new THREE.Vector3(), nv = new THREE.Vector3(), acc = new THREE.Vector3(), accN = new THREE.Vector3(), t = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    const EXCL = new Set([BI.Head, BI.neck, BI.LeftHand, BI.RightHand, BI.LeftFoot, BI.RightFoot]);
    const WB = new Array(n);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i); nv.fromBufferAttribute(nor, i);
      acc.set(0, 0, 0); accN.set(0, 0, 0);
      const wb = (WB[i] = new Map());
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const j = si.getComponent(i, k);
        acc.addScaledVector(t.copy(v).applyMatrix4(C[j]), w);
        accN.addScaledVector(t.copy(nv).applyMatrix3(nm.setFromMatrix4(C[j])), w);
        wb.set(map[j], (wb.get(map[j]) || 0) + w);
      }
      acc.toArray(P, i * 3); accN.normalize().toArray(N, i * 3);
      if (U) { U[i * 2] = uv.getX(i); U[i * 2 + 1] = uv.getY(i); }
      if (Cc) { Cc[i * 3] = col.getX(i); Cc[i * 3 + 1] = col.getY(i); Cc[i * 3 + 2] = col.getZ(i); }
    }
    separateArms(P, n, g.index.array, WB);
    for (let i = 0; i < n; i++) {
      const wb = WB[i];
      cleanWeights(wb);
      const ent = [...wb.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = ent.reduce((s, e) => s + e[1], 0) || 1;
      let excl = 0;
      ent.forEach(([b, w], k) => { Bn[i * 4 + k] = b; Wt[i * 4 + k] = w / sum; if (EXCL.has(b)) excl += w / sum; });
      Info[i * 3 + 1] = Math.max(0, 1 - excl * 1.6); // recolour mask: jacket / trousers, never face, hands, boots
    }
    // the hand-held props (rigid on the prop bone)
    P.set(propGeo.P, n * 3); N.set(propGeo.N, n * 3); Info.set(propGeo.I, n * 3);
    for (let i = n; i < n + np; i++) { Bn[i * 4] = PROP; Wt[i * 4] = 1; if (Cc) Cc.fill(0.5, i * 3, i * 3 + 3); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    if (U) geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    if (Cc) geo.setAttribute('color', new THREE.BufferAttribute(Cc, 3));
    geo.setAttribute('aBones', new THREE.BufferAttribute(Bn, 4));
    geo.setAttribute('aWeights', new THREE.BufferAttribute(Wt, 4));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(Info, 3));
    const idx = Array.from(g.index.array);
    for (const k of propGeo.idx) idx.push(k + n);
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2);
    return geo;
  }

  // hand axes (finger direction, palm normal) in hand-bone space + the grip point, from the rest mesh
  measureHands(mesh) {
    this.hand = [];
    for (const [side, name] of [[1, 'LeftHand'], [-1, 'RightHand']]) {
      const bone = this.bones[BI[name]];
      const wrist = wpos(bone, new THREE.Vector3());
      const pts = this.boneVerts(mesh, bone, 0.5);
      if (pts.length < 8) { this.hand.push(null); continue; }
      const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      const d = pts.map((p) => p.distanceTo(wrist)).sort((a, b) => a - b), far = d[Math.floor(d.length * 0.6)];
      const tip = new THREE.Vector3(); let nt = 0;
      for (const p of pts) if (p.distanceTo(wrist) >= far) { tip.add(p); nt++; }
      tip.multiplyScalar(1 / nt);
      const F = tip.clone().sub(wrist).normalize();
      // palm normal: the hand's thinnest axis (covariance), facing the body at rest
      const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const p of pts) { const e = [p.x - c.x, p.y - c.y, p.z - c.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += e[i] * e[j]; }
      let Nn = smallestEigen(cov);
      Nn.addScaledVector(F, -Nn.dot(F)).normalize();
      if (Nn.x * side > 0) Nn.negate(); // left hand (+x side): palm faces -x (inward)
      const Q = wquat(bone, new THREE.Quaternion()).invert();
      const grip = c.clone().addScaledVector(F, 0.01).addScaledVector(Nn, 0.035);
      this.hand.push({ f: F.clone().applyQuaternion(Q), n: Nn.clone().applyQuaternion(Q), grip: grip.clone().sub(wrist).applyQuaternion(Q), gripRest: grip, len: tip.distanceTo(wrist) });
    }
    const r = this.hand[1];
    this.G = r ? r.gripRest.clone() : wpos(this.bones[BI.RightHand], new THREE.Vector3());
    this.gripLocal = r ? r.grip.clone() : new THREE.Vector3();
  }
  boneVerts(mesh, bone, minW) {
    const g = mesh.geometry, skel = mesh.skeleton, j = skel.bones.indexOf(bone);
    const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const C = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse)
      .multiply(_m4.multiplyMatrices(bone.matrixWorld, skel.boneInverses[j])).multiply(mesh.bindMatrix);
    const out = [];
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === j) w += sw.getComponent(i, k);
      if (w >= minW) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(C));
    }
    return out;
  }
  // Meshy rigs put the knee joint behind the leg's line (man, elder, kid) or in front of it (woman, lady): the
  // mesh looks straight-legged at that bind angle. A leg is never stretched straighter than its bind look; one
  // whose knee sits behind the line is solved with the knee behind it while it is about that straight (both
  // solutions meet at full stretch, so the switch to bending forward is seamless).
  measureLegs() {
    this.legInfo = [[BI.LeftUpLeg, BI.LeftLeg, BI.LeftFoot], [BI.RightUpLeg, BI.RightLeg, BI.RightFoot]].map(([u, l, f]) => {
      const h = wpos(this.bones[u], new THREE.Vector3()), k = wpos(this.bones[l], new THREE.Vector3()), a = wpos(this.bones[f], new THREE.Vector3());
      const L = h.distanceTo(k) + k.distanceTo(a), d = h.distanceTo(a);
      const ax = a.clone().sub(h).normalize(), off = k.clone().sub(h);
      off.addScaledVector(ax, -off.dot(ax));
      return { L, d, back: off.z < -0.008 };
    });
  }
  // two-bone IK for leg k (0 left, 1 right) to the ankle target t, side s (+1 left)
  solveLeg(k, t, s) {
    const b = this.bones, info = this.legInfo[k], [u, l, f] = k === 0 ? [BI.LeftUpLeg, BI.LeftLeg, BI.LeftFoot] : [BI.RightUpLeg, BI.RightLeg, BI.RightFoot];
    const d = wpos(b[u], new THREE.Vector3()).distanceTo(t);
    if (info.back && d > info.d - 0.012) solveTwoBone(b[u], b[l], b[f], t, new THREE.Vector3(s * 0.12, 0, -1));
    else solveTwoBone(b[u], b[l], b[f], t, new THREE.Vector3(s * 0.12, 0, 1), info.back ? Infinity : info.d);
  }
  measureBody() {
    const b = this.bones, P = (n) => wpos(b[BI[n]], new THREE.Vector3());
    this.shL = P('LeftArm'); this.shR = P('RightArm');
    this.armLen = this.shL.distanceTo(P('LeftForeArm')) + P('LeftForeArm').distanceTo(P('LeftHand'));
    this.hipY = P('Hips').y; this.headY = P('Head').y; this.neckY = P('neck').y;
    this.chestY = P('Spine').y;
    const s0 = P('Spine02'), nk = P('neck');
    this.postureFix = Math.atan2(s0.z - nk.z, nk.y - s0.y) + 0.03;
    this.footL = P('LeftFoot'); this.footR = P('RightFoot');
  }

  // flag (stick + cloth) and cowbell (strap + bell), modelled around the rest grip point, cloth along +z
  buildProps() {
    const G = this.G, P = [], N = [], I = [], idx = [];
    const vtx = (x, y, z, nx, ny, nz, kind, a = 0, b = 0) => { P.push(G.x + x, G.y + y, G.z + z); N.push(nx, ny, nz); I.push(kind, a, b); return P.length / 3 - 1; };
    // a box from y0 to y1 with half sizes (tapered: bottom w0/d0, top w1/d1)
    // (aInfo.y = height within the box 0..1: the bell's dark mouth, the strap's stitching)
    const box = (y0, y1, w0, d0, w1, d1, kind) => {
      const c = [[-w0, y0, -d0], [w0, y0, -d0], [w0, y0, d0], [-w0, y0, d0], [-w1, y1, -d1], [w1, y1, -d1], [w1, y1, d1], [-w1, y1, d1]];
      const faces = [[0, 1, 5, 4, [0, 0, -1]], [1, 2, 6, 5, [1, 0, 0]], [2, 3, 7, 6, [0, 0, 1]], [3, 0, 4, 7, [-1, 0, 0]], [4, 5, 6, 7, [0, 1, 0]], [3, 2, 1, 0, [0, -1, 0]]];
      for (const [a, b, c2, d, n] of faces) {
        const v = (k) => vtx(...c[k], ...n, kind, (c[k][1] - y0) / (y1 - y0), 0);
        const i0 = v(a), i1 = v(b), i2 = v(c2), i3 = v(d);
        idx.push(i0, i1, i2, i0, i2, i3);
      }
    };
    box(-0.24, 0.8, 0.012, 0.012, 0.011, 0.011, 2);            // flag stick
    const CW = 0.6, CH = 0.4, NU = 8, NV = 3;                  // cloth 60 x 40 cm on the stick's top
    const base = P.length / 3;
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) vtx(0, 0.78 - CH + (j / NV) * CH, 0.012 + (i / NU) * CW, 1, 0, 0, 1, i / NU, j / NV);
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const a = base + j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    box(-0.16, 0.03, 0.03, 0.007, 0.03, 0.007, 4);             // embroidered leather strap, from the fist to the bell
    // Swiss cowbell, mouth down: a lathe of rings (height, half width, half depth) - narrow crown, bulging body,
    // flared mouth; aInfo.y 0 at the mouth (dark inside) .. 1 at the crown
    const R = [[-0.4, 0.088, 0.066], [-0.385, 0.084, 0.063], [-0.33, 0.082, 0.06], [-0.26, 0.074, 0.054], [-0.2, 0.058, 0.042], [-0.165, 0.035, 0.026]];
    const SEG = 10, y0 = R[0][0], y1 = R[R.length - 1][0];
    const ring0 = P.length / 3;
    R.forEach(([y, rx, rz], j) => {
      const [yp, rxp] = R[Math.max(0, j - 1)], [yn, rxn] = R[Math.min(R.length - 1, j + 1)];
      const slope = (rxp - rxn) / ((yn - yp) || 1); // outward lean of the profile -> normal's y
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), nl = Math.hypot(ca, sa, slope);
        vtx(ca * rx, y, sa * rz, ca / nl, slope / nl, sa / nl, 3, (y - y0) / (y1 - y0), 0);
      }
    });
    for (let j = 0; j < R.length - 1; j++) for (let i = 0; i < SEG; i++) {
      const a = ring0 + j * (SEG + 1) + i, b = a + SEG + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const crown = vtx(0, y1 + 0.012, 0, 0, 1, 0, 3, 1, 0), inner = vtx(0, y0 + 0.05, 0, 0, -1, 0, 3, 0, 0);
    const top0 = ring0 + (R.length - 1) * (SEG + 1);
    for (let i = 0; i < SEG; i++) { idx.push(crown, top0 + i + 1, top0 + i); idx.push(inner, ring0 + i, ring0 + i + 1); }
    // a pair of skis held together base to base, carried on edge over the right shoulder: modelled along +z
    // from the hand's grip (tips 0.66 m ahead, tails 1.0 m behind; the carry pose's measured direction turns them
    // into place, see measureCarry), each ski 8.4 cm wide, the tips curving away from the other ski
    const ZS = [-1.0, -0.93, -0.6, -0.2, 0.0, 0.2, 0.42, 0.52, 0.6, 0.66];
    for (const sx of [1, -1]) {
      const ring = [];
      ZS.forEach((z) => {
        const tip = Math.max(0, (z - 0.44) / 0.22), tail = Math.max(0, (-0.9 - z) / 0.1);
        const ox = sx * (0.004 + 0.06 * tip * tip + 0.012 * tail), w = 0.042 * (1 - 0.25 * tip * tip), th = 0.012;
        const along = (z + 1.0) / 1.66;
        // 4 corners: inner bottom/top (base side), outer bottom/top (top sheet); x outward = sx
        const c = [[ox, -w], [ox, w], [ox + sx * th * 2, w], [ox + sx * th * 2, -w]];
        ring.push(c.map(([x, y], k) => vtx(x, y, z, k < 2 ? -sx : sx, 0, 0, 5, k < 2 ? 0 : 1, along)));
      });
      for (let j = 0; j < ZS.length - 1; j++) for (let k = 0; k < 4; k++) {
        const a = ring[j][k], b = ring[j][(k + 1) % 4], c2 = ring[j + 1][(k + 1) % 4], d = ring[j + 1][k];
        if (sx > 0) idx.push(a, d, c2, a, c2, b); else idx.push(a, b, c2, a, c2, d);
      }
      // the bindings: toe and heel pieces on the outer faces
      for (const [z0, z1, h] of [[-0.42, -0.3, 0.05], [-0.1, 0.03, 0.045]]) {
        const x0 = sx * 0.028, x1 = sx * (0.028 + h);
        const q = [[x0, -0.03, z0], [x1, -0.03, z0], [x1, 0.03, z0], [x0, 0.03, z0], [x0, -0.03, z1], [x1, -0.03, z1], [x1, 0.03, z1], [x0, 0.03, z1]];
        const F = [[0, 1, 2, 3], [5, 4, 7, 6], [1, 5, 6, 2], [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0]];
        for (const f of F) {
          const v = f.map((k) => vtx(q[k][0], q[k][1], q[k][2], sx, 0, 0, 6, 0, 0));
          if (sx > 0) idx.push(v[0], v[1], v[2], v[0], v[2], v[3]); else idx.push(v[0], v[2], v[1], v[0], v[3], v[2]);
        }
      }
    }
    return { P: new Float32Array(P), N: new Float32Array(N), I: new Float32Array(I), idx, count: P.length / 3 };
  }

  // dominant jacket colour (linear, from the torso of the vertex-coloured LOD): the recolour key
  jacketBase(geo) {
    const col = geo.attributes.color, bn = geo.attributes.aBones, wt = geo.attributes.aWeights;
    const S = [];
    if (col) for (let i = 0; i < col.count; i++) {
      const b = bn.getX(i);
      if (wt.getX(i) < 0.6 || !(b === BI.Spine02 || b === BI.Spine01 || b === BI.LeftArm || b === BI.RightArm || b === BI.LeftForeArm || b === BI.RightForeArm)) continue;
      const r = col.getX(i), g = col.getY(i), bl = col.getZ(i);
      const Y = 0.299 * r + 0.587 * g + 0.114 * bl, I = 0.596 * r - 0.274 * g - 0.322 * bl, Q = 0.211 * r - 0.523 * g + 0.312 * bl;
      S.push({ Y, I, Q, ch: Math.hypot(I, Q), h: Math.atan2(Q, I) });
    }
    if (S.length < 10) return null;
    // dominant hue: the 40-degree window covering the most of the torso (by area, not by saturation: a bright
    // scarf must not win over the jacket)
    const top = S.filter((o) => o.ch > 0.008);
    if (top.length < 10) return null;
    let best = 0, bh = 0;
    for (const s of top) { let w = 0; for (const o of top) if (Math.abs(angDiff(o.h, s.h)) < 0.35) w++; if (w > best) { best = w; bh = s.h; } }
    if (best < S.length * 0.3) return null; // no clear jacket colour
    const sel = top.filter((o) => Math.abs(angDiff(o.h, bh)) < 0.35);
    const med = (k) => sel.map((o) => o[k]).sort((a, b) => a - b)[Math.floor(sel.length / 2)];
    const ch = med('ch'), Y = med('Y');
    if (ch < 0.012) return null; // grey / white jacket: nothing to key on
    return new THREE.Vector4(Math.cos(bh) * ch, Math.sin(bh) * ch, Math.max(0.01, Y), 0.87);
  }

  // ---------------------------------------------------------------- posing (load time)
  resetPose() {
    this.allBones.forEach((b, i) => { b.quaternion.copy(this.restLocal[i].q); b.position.copy(this.restLocal[i].p); });
    this.root.updateMatrixWorld(true);
  }
  // hand: world target of the wrist; pole: elbow direction; f / n: finger direction, palm normal (model space)
  poseArm(side, hand, pole, f, n, shrug = 0) {
    const s = side > 0 ? 0 : 1, b = this.bones;
    const [sh, arm, fore, hb] = side > 0 ? [b[BI.LeftShoulder], b[BI.LeftArm], b[BI.LeftForeArm], b[BI.LeftHand]] : [b[BI.RightShoulder], b[BI.RightArm], b[BI.RightForeArm], b[BI.RightHand]];
    if (shrug) rotateWorld(sh, Z_AXIS, side * shrug);
    solveTwoBone(arm, fore, hb, hand, pole);
    const H = this.hand[s];
    if (!H || !f) return;
    // hand orientation: rotate the current finger / palm frame onto the target
    const Hq = wquat(hb, new THREE.Quaternion());
    const cf = H.f.clone().applyQuaternion(Hq), cn = H.n.clone().applyQuaternion(Hq);
    const F = f.clone().normalize(), Nt = n.clone().addScaledVector(F, -n.dot(F)).normalize();
    const A = new THREE.Matrix4().makeBasis(cf, cn, cf.clone().cross(cn)), B = new THREE.Matrix4().makeBasis(F, Nt, F.clone().cross(Nt));
    const R = new THREE.Quaternion().setFromRotationMatrix(B.multiply(A.transpose()));
    const target = R.multiply(Hq);
    // share the wrist twist with the forearm (no candy-wrapped wrists)
    const Wf = wquat(fore, new THREE.Quaternion());
    const rel = Wf.clone().invert().multiply(target);
    const ax = hb.position.clone().normalize();
    const tw = 2 * Math.atan2(rel.x * ax.x + rel.y * ax.y + rel.z * ax.z, rel.w);
    const ang = Math.atan2(Math.sin(tw), Math.cos(tw));
    const axisW = wpos(hb, new THREE.Vector3()).sub(wpos(fore, new THREE.Vector3())).normalize();
    rotateWorld(fore, axisW, ang * 0.6);
    setWorldQuat(hb, target);
  }
  // relaxed arm hanging beside the thigh
  sh(side) { return wpos(this.bones[side > 0 ? BI.LeftArm : BI.RightArm], new THREE.Vector3()); }
  hang(side, out = 0.0, fwd = 0.04, bend = 0.04) {
    const sh = this.sh(side);
    const t = new THREE.Vector3(sh.x + side * (0.05 + out), sh.y - this.armLen * (0.965 - bend), sh.z + fwd);
    this.poseArm(side, t, new THREE.Vector3(side * 0.35, 0, -1), new THREE.Vector3(0, -1, 0.12), new THREE.Vector3(-side, 0, 0.1));
  }
  spine(lean = 0, side = 0, twist = 0) {
    const b = this.bones, L = lean + this.postureFix;
    [[BI.Spine02, 0.4], [BI.Spine01, 0.3], [BI.Spine, 0.3]].forEach(([i, k]) => {
      rotateWorld(b[i], X_AXIS, L * k);
      if (side) rotateWorld(b[i], Z_AXIS, -side * k);
      if (twist) rotateWorld(b[i], Y_AXIS, twist * k);
    });
  }
  head(pitch = 0, yaw = 0) {
    const b = this.bones;
    // stand the neck up after the posture fix, then the look
    rotateWorld(b[BI.neck], X_AXIS, -this.postureFix * 0.5 + pitch * 0.4);
    rotateWorld(b[BI.Head], X_AXIS, pitch * 0.6);
    if (yaw) { rotateWorld(b[BI.neck], Y_AXIS, yaw * 0.4); rotateWorld(b[BI.Head], Y_AXIS, yaw * 0.6); }
  }
  // hips offset (model space) + pelvis roll / pitch, feet planted at rest
  legs(dx = 0, dy = 0, dz = 0, roll = 0, pitch = 0) {
    const b = this.bones, hips = b[BI.Hips];
    // (knees behind the leg line at bind: standing, the hips stay at bind height so the legs keep their straight look)
    if (dy > -0.03 && this.legInfo[0].back && this.legInfo[1].back) dy = 0;
    const feet = [wpos(b[BI.LeftFoot], new THREE.Vector3()), wpos(b[BI.RightFoot], new THREE.Vector3())];
    // a natural stance: some binds stand with the feet far apart
    feet[0].x = Math.min(feet[0].x, 0.13); feet[1].x = Math.max(feet[1].x, -0.13);
    const fq = [wquat(b[BI.LeftFoot], new THREE.Quaternion()), wquat(b[BI.RightFoot], new THREE.Quaternion())];
    if (dx || dy || dz) {
      const w = wpos(hips, new THREE.Vector3()).add(new THREE.Vector3(dx, dy, dz));
      hips.position.copy(hips.parent.worldToLocal(w));
      hips.updateMatrixWorld(true);
    }
    if (roll) rotateWorld(hips, Z_AXIS, roll);
    if (pitch) rotateWorld(hips, X_AXIS, pitch);
    // keep the chest upright over a rolled pelvis
    if (roll) rotateWorld(b[BI.Spine02], Z_AXIS, -roll * 0.9);
    [[BI.LeftFoot, 1], [BI.RightFoot, -1]].forEach(([f, s], k) => {
      this.solveLeg(k, feet[k], s);
      setWorldQuat(b[f], fq[k]);
    });
  }
  // One phase p (0..1) of a walking cycle, WALK_STRIDE m per cycle: the left heel strikes at 0, the right at 0.5.
  // A foot is planted for 62 % of the cycle (sliding back under the body exactly as fast as the body moves on:
  // heel strike with the toes up, rolling flat, the heel rising before toe-off), then swings forward with the
  // knee bent. The hips are lowest at double support, sway over the standing leg, turn with the swinging leg and
  // drop on its side; the shoulders counter-rotate and the arms swing against the legs. (The lower body only:
  // the arms / head are set by walkUpper, so carrying people can keep their own arms.)
  walkLegs(p) {
    const b = this.bones, hips = b[BI.Hips], TAU = Math.PI * 2, S = WALK_STRIDE, duty = 0.62;
    const rest = [wpos(b[BI.LeftFoot], new THREE.Vector3()), wpos(b[BI.RightFoot], new THREE.Vector3())];
    rest[0].x = THREE.MathUtils.clamp(rest[0].x, 0.075, 0.105); rest[1].x = THREE.MathUtils.clamp(rest[1].x, -0.105, -0.075);
    const fq = [wquat(b[BI.LeftFoot], new THREE.Quaternion()), wquat(b[BI.RightFoot], new THREE.Quaternion())];
    // a foot's [forward offset, ankle lift, pitch (+ = toes down)] at phase q of its own cycle
    const foot = (q) => {
      q = ((q % 1) + 1) % 1;
      if (q < duty) {
        const u = q / duty;
        const pitch = u < 0.16 ? -0.24 * (1 - u / 0.16) : u > 0.68 ? 0.62 * ((u - 0.68) / 0.32) ** 1.6 : 0;
        const lift = pitch > 0 ? 0.12 * Math.sin(pitch) : 0.05 * Math.sin(-pitch); // the ankle rises with the heel / sits on the heel
        return [S * duty * (0.5 - u), lift, pitch];
      }
      const u = (q - duty) / (1 - duty), e = u * u * (3 - 2 * u);
      const lift = 0.07 * (1 - u) + 0.012 * u + Math.sin(u * Math.PI) * 0.065;
      return [S * duty * (e - 0.5), lift, 0.62 * (1 - e) ** 2 - 0.24 * e * e];
    };
    // (Meshy ankle joints sit at the heel, some way behind the hip joints: the stride is centred under the hips,
    // the foot planted 4.5 cm behind the hip joint at mid-stance)
    const zc = wpos(b[BI.LeftUpLeg], new THREE.Vector3()).z + 0.03 - 0.045;
    rest[0].z = rest[1].z = zc;
    const ds = 0.5 + 0.5 * Math.cos(2 * TAU * (p - 0.06)); // 1 at double support
    // (at mid-stance the standing leg is as straight as it looks in the bind pose: the hips at that height over
    // the planted foot; ~5 cm lower at double support)
    const info = this.legInfo[0], reach = info.back ? info.L * 0.995 : info.d;
    const up = Math.sqrt(reach * reach - 0.045 * 0.045) + rest[0].y - wpos(b[BI.LeftUpLeg], new THREE.Vector3()).y - 0.004;
    const w = wpos(hips, new THREE.Vector3()).add(new THREE.Vector3(0.02 * Math.sin(TAU * (p - 0.06)), up - 0.051 * ds, 0.03));
    hips.position.copy(hips.parent.worldToLocal(w));
    hips.updateMatrixWorld(true);
    const yaw = -0.085 * Math.cos(TAU * p), roll = 0.032 * Math.sin(TAU * (p - 0.06));
    rotateWorld(hips, Y_AXIS, yaw);
    rotateWorld(hips, Z_AXIS, roll);
    [[BI.LeftFoot, 1, p], [BI.RightFoot, -1, p + 0.5]].forEach(([f, s, q], k) => {
      const [z, lift, pitch] = foot(q);
      this.solveLeg(k, rest[k].clone().add(new THREE.Vector3(0, lift, z)), s);
      setWorldQuat(b[f], new THREE.Quaternion().setFromAxisAngle(X_AXIS, pitch).multiply(fq[k]));
    });
    rotateWorld(b[BI.Spine02], Z_AXIS, -roll * 0.9);
    this.spine(0.03, 0, 0.15 * Math.cos(TAU * p));
    return Math.cos(TAU * p);
  }
  walk(p) {
    const sw = this.walkLegs(p), A = 0.16;
    // arms against the legs (the left arm back while the left leg is forward), the elbow bending on the forward swing
    for (const s of [1, -1]) {
      const fwd = -s * A * sw;
      this.hang(s, 0.025, 0.03 + fwd, 0.045 + 0.085 * Math.max(0, fwd / A));
    }
    this.head(0.04, -0.06 * sw);
  }

  // the skis' orientation in the carry pose: from the top of the right shoulder through the hand's grip (tips
  // ahead and down), on edge (their width as upright as the line allows)
  // The carried skis are fixed to the chest: their lower edge rests on top of the right shoulder (over the joint,
  // clear of the head) at the bindings, tips 24 degrees down and a little inward, tails out and up behind.
  // Stored relative to the Spine (chest) bone of the carry pose; composeRow places them from the posed chest.
  carryLine(sh) {
    const d = CARRY_DIR.clone();
    return { anchor: sh.clone().add(new THREE.Vector3(-0.015, 0.085 + this.height * 0.004, -0.035)), d };
  }
  measureCarry() {
    const { anchor, d } = this.carryLine(wpos(this.bones[BI.RightArm], new THREE.Vector3()));
    const Y = new THREE.Vector3(0, 1, 0).addScaledVector(d, -d.y).normalize(), X = new THREE.Vector3().crossVectors(Y, d);
    const R = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, d));
    const chest = this.bones[BI.Spine], cq = wquat(chest, new THREE.Quaternion()), cqi = cq.clone().invert();
    this.carryRel = cqi.clone().multiply(R).toArray(new Float32Array(4));
    this.carryAnchor = anchor.sub(wpos(chest, new THREE.Vector3())).applyQuaternion(cqi);
    this.carryArr = CARRY_MARK;
  }

  bakeKeyframes() {
    const kq = new Float32Array(NK * NBA * 4), kh = new Float32Array(NK * 3);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const A = this.armLen, top = this.height;
    // shoulders where they are after the pose's legs / spine (targets are evaluated after those calls)
    const sh = (s) => this.sh(s);
    const upDir = (s, out, fwd, k = 0.97) => sh(s).clone().add(V(s * out, 1, fwd).normalize().multiplyScalar(A * k));
    const inward = (s) => V(-s, 0, 0);
    const poses = {
      [K.STAND_L]: () => { this.legs(0.035, -0.012, 0, 0.05); this.spine(0.02, -0.01); this.hang(1, 0.0, 0.03); this.hang(-1, 0.01, 0.05, 0.06); this.head(0.06, 0.05); },
      [K.STAND_R]: () => { this.legs(-0.035, -0.012, 0, -0.05); this.spine(0.02, 0.01); this.hang(1, 0.01, 0.05, 0.06); this.hang(-1, 0.0, 0.03); this.head(0.06, -0.05); },
      [K.HOLD]: () => { // hands loosely together in front of the belly
        this.legs(0, -0.01); this.spine(0.03);
        for (const s of [1, -1]) this.poseArm(s, V(s * 0.045, this.hipY + 0.08, 0.2), V(s * 0.6, -0.4, -1), V(-s * 0.7, -0.5, 0.3), V(-s * 0.2, 0.3, -1));
        this.head(0.08);
      },
      [K.POCKET]: () => { // hands on the hips
        this.legs(0, -0.01); this.spine(-0.01);
        for (const s of [1, -1]) this.poseArm(s, V(sh(s).x + s * 0.02, this.hipY + 0.06, 0.05), V(s, -0.2, -0.5), null, null);
        this.head(0.02);
      },
      [K.CLAP_O]: () => {
        this.legs(0, -0.012); this.spine(0.05);
        for (const s of [1, -1]) this.poseArm(s, V(s * 0.16, sh(s).y - 0.14, 0.32), V(s * 0.6, -1, -0.3), V(-s * 0.15, 0.75, 0.6), inward(s));
        this.head(-0.02);
      },
      [K.CLAP_S]: () => {
        this.legs(0, -0.012); this.spine(0.06);
        for (const s of [1, -1]) this.poseArm(s, V(s * 0.04, sh(s).y - 0.12, 0.35), V(s * 0.6, -1, -0.3), V(-s * 0.05, 0.75, 0.6), inward(s));
        this.head(-0.02);
      },
      [K.CLAPHI_O]: () => {
        this.legs(0, -0.005); this.spine(-0.03);
        for (const s of [1, -1]) this.poseArm(s, V(s * 0.17, top + 0.1, 0.16), V(s, -0.3, -0.4), null, null, 0.16);
        this.head(-0.12);
      },
      [K.CLAPHI_S]: () => {
        this.legs(0, -0.005); this.spine(-0.03);
        for (const s of [1, -1]) this.poseArm(s, V(s * 0.04, top + 0.13, 0.16), V(s, -0.3, -0.4), null, null, 0.18);
        this.head(-0.12);
      },
      [K.VUP_A]: () => {
        this.legs(0, -0.005); this.spine(-0.04);
        for (const s of [1, -1]) { const t = upDir(s, 0.55, 0.12, 0.9); this.poseArm(s, t, V(s, -0.2, -0.5), null, null, 0.2); }
        this.head(-0.18);
      },
      [K.VUP_B]: () => {
        this.legs(0, 0); this.spine(-0.06);
        for (const s of [1, -1]) { const t = upDir(s, 0.38, 0.18, 0.98); this.poseArm(s, t, V(s, -0.2, -0.5), null, null, 0.26); }
        this.head(-0.22);
      },
      [K.WAVE_A]: () => {
        this.legs(0.02, -0.01, 0, 0.03); this.spine(0, 0.02);
        this.hang(1, 0.01, 0.04);
        this.poseArm(-1, sh(-1).add(V(-0.1, 0.44, 0.14)), V(-1, -0.6, -0.2), null, null, 0.12);
        this.head(-0.04);
      },
      [K.WAVE_B]: () => {
        this.legs(0.02, -0.01, 0, 0.03); this.spine(0, 0.03);
        this.hang(1, 0.01, 0.04);
        this.poseArm(-1, sh(-1).add(V(-0.34, 0.38, 0.12)), V(-1, -0.6, -0.2), null, null, 0.14);
        this.head(-0.04);
      },
      [K.PUMP_LO]: () => {
        this.legs(0, -0.03); this.spine(0.06);
        this.hang(1, 0.02, 0.06, 0.08);
        this.poseArm(-1, sh(-1).add(V(-0.06, 0.06, 0.24)), V(-0.6, -1, 0), null, null, 0.05);
        this.head(0.0);
      },
      [K.PUMP_HI]: () => {
        this.legs(0, 0); this.spine(-0.05);
        this.hang(1, 0.02, 0.05, 0.08);
        this.poseArm(-1, upDir(-1, 0.12, 0.2, 0.98), V(-1, -0.3, -0.4), null, null, 0.28);
        this.head(-0.18);
      },
      [K.FLAG_REST]: () => { // the flag held upright at the side, hand at the hip
        this.legs(-0.02, -0.01, 0, -0.03); this.spine(0.02);
        this.hang(1, 0.0, 0.04);
        this.poseArm(-1, V(sh(-1).x - 0.08, this.hipY + 0.12, 0.12), V(-1, -0.3, -1), null, null);
        this.head(0.04);
      },
      [K.FLAG_A]: () => {
        this.legs(0, -0.005); this.spine(-0.03, 0.03);
        this.hang(1, 0.02, 0.05);
        this.poseArm(-1, sh(-1).add(V(-0.12, A * 0.9, 0.14)), V(-1, -0.3, -0.3), null, null, 0.24);
        this.head(-0.16);
      },
      [K.FLAG_B]: () => {
        this.legs(0, -0.005); this.spine(-0.03, -0.02);
        this.hang(1, 0.02, 0.05);
        this.poseArm(-1, sh(-1).add(V(0.2, A * 0.86, 0.16)), V(-1, -0.3, -0.3), null, null, 0.24);
        this.head(-0.16);
      },
      [K.BELL_REST]: () => {
        this.legs(-0.02, -0.01, 0, -0.03); this.spine(0.02);
        this.hang(1, 0.0, 0.04);
        this.poseArm(-1, V(sh(-1).x - 0.02, this.hipY + 0.06, 0.16), V(-1, -0.2, -1), null, null);
        this.head(0.05);
      },
      [K.BELL_A]: () => {
        this.legs(0, -0.01); this.spine(0.0);
        this.hang(1, 0.02, 0.05);
        this.poseArm(-1, sh(-1).add(V(-0.06, 0.3, 0.3)), V(-1, -1, -0.3), null, null, 0.1);
        this.head(-0.08);
      },
      [K.BELL_B]: () => {
        this.legs(0, -0.01); this.spine(0.0);
        this.hang(1, 0.02, 0.05);
        this.poseArm(-1, sh(-1).add(V(-0.06, 0.18, 0.34)), V(-1, -1, -0.3), null, null, 0.06);
        this.head(-0.08);
      },
      [K.CROUCH]: () => { this.legs(0, -0.15, -0.02, 0, 0.2); this.spine(0.05); this.hang(1); this.hang(-1); this.head(-0.1); },
      // ---- people waiting / chatting
      [K.TALK_A]: () => { // explaining with the right hand: forearm up in front of the belly, palm up
        this.legs(0.025, -0.012, 0, 0.04); this.spine(0.045, 0, 0.06);
        this.hang(1, 0.01, 0.04, 0.05);
        this.poseArm(-1, V(sh(-1).x + 0.04, sh(-1).y - 0.29, 0.22), V(-0.7, -1, -0.5), V(0.25, 0.25, 1), V(0.3, 1, 0), 0.02);
        this.head(0.0, -0.04);
      },
      [K.TALK_B]: () => { // both hands open in front, palms up
        this.legs(0, -0.012); this.spine(0.05);
        for (const s of [1, -1]) this.poseArm(s, V(sh(s).x - s * 0.01, sh(s).y - 0.31, 0.21), V(s * 0.7, -1, -0.5), V(-s * 0.3, 0.15, 1), V(-s * 0.35, 1, 0));
        this.head(0.02);
      },
      [K.TALK_C]: () => { // the left hand
        this.legs(-0.025, -0.012, 0, -0.04); this.spine(0.045, 0, -0.06);
        this.hang(-1, 0.01, 0.04, 0.05);
        this.poseArm(1, V(sh(1).x - 0.04, sh(1).y - 0.29, 0.22), V(0.7, -1, -0.5), V(-0.25, 0.25, 1), V(-0.3, 1, 0), 0.02);
        this.head(0.0, 0.04);
      },
      [K.PHONE]: () => { // looking at a phone held in both hands in front of the chest
        this.legs(0.02, -0.012, 0, 0.03); this.spine(0.08);
        for (const s of [1, -1]) this.poseArm(s, V(s * 0.055, sh(s).y - 0.33, 0.25), V(s, -0.8, -0.4), V(-s * 0.55, 0.35, 0.75), V(-s * 0.2, 0.65, -0.5));
        this.head(0.45);
      },
      [K.POINT]: () => { // showing the way / the mountain with the right arm
        this.legs(-0.02, -0.01, 0, -0.03); this.spine(-0.01, 0, 0.1);
        this.hang(1, 0.01, 0.05);
        this.poseArm(-1, sh(-1).add(V(-0.12, 0.16, 0.5)), V(-1, -0.4, -0.3), V(-0.15, 0.3, 1), V(0.45, 0, 0.15), 0.08);
        this.head(-0.08, -0.08);
      },
      [K.SHRUG]: () => { // hands out at the sides, palms up, shoulders up
        this.legs(0, -0.008); this.spine(0.0);
        for (const s of [1, -1]) this.poseArm(s, V(sh(s).x + s * 0.2, this.hipY + 0.14, 0.2), V(s, -0.5, -0.5), V(s * 0.5, 0.1, 1), V(0, 1, 0), 0.12);
        this.head(-0.04);
      },
      [K.WATCH]: () => { // a glance at the watch on the left wrist
        this.legs(0.02, -0.012, 0, 0.03); this.spine(0.06);
        this.hang(-1, 0.01, 0.04, 0.05);
        this.poseArm(1, V(0.02, sh(1).y - 0.28, 0.3), V(1, -0.8, -0.2), V(-1, 0.1, 0.15), V(0, 1, 0.2));
        this.head(0.38, 0.12);
      },
      [K.CARRY]: () => { // skis over the right shoulder, the hand holding them from below ~0.3 m ahead of it
        this.legs(0, -0.01); this.spine(0.03, -0.02);
        this.hang(1, 0.02, 0.04, 0.05);
        const { anchor, d } = this.carryLine(sh(-1));
        const at = anchor.clone().addScaledVector(d, 0.42).add(V(0, -0.07, 0));
        this.poseArm(-1, at, V(-1, -1, -0.2), V(0.25, 1, 0.1), V(0.4, 0.1, -1), 0.03);
        this.head(0.04, 0.08);
      },
    };
    for (let j = 0; j < NWALK; j++) poses[K.WALK0 + j] = () => this.walk(j / NWALK);
    const q = new THREE.Quaternion(), qp = new THREE.Quaternion(), p = new THREE.Vector3();
    const restL = new Float32Array(NBA * 4);
    for (let k = -1; k < NK; k++) {
      this.resetPose();
      if (k >= 0) poses[k]();
      this.root.updateMatrixWorld(true);
      this.bones.forEach((b, i) => {
        wquat(b, q);
        if (i > 0) q.premultiply(wquat(this.bones[this.parent[i]], qp).invert());
        if (k < 0) { q.toArray(restL, i * 4); return; }
        // same hemisphere as the rest pose (blends are plain normalized sums)
        const o = i * 4, d = q.x * restL[o] + q.y * restL[o + 1] + q.z * restL[o + 2] + q.w * restL[o + 3];
        if (d < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        q.toArray(kq, (k * NBA + i) * 4);
      });
      if (k >= 0) wpos(this.bones[0], p).toArray(kh, k * 3);
      if (k === K.CARRY) this.measureCarry();
    }
    this.kq = kq; this.kh = kh;
  }
}

// Meshy's auto-rig weights the jacket's sides under the armpits (and scarf ends on the chest) to the upper arms:
// in the A-pose they touch the sleeves. Raising the arms then drags them up into a cape-like flap. Over the
// surface they are far from the arm, though: the way from the ribs to the forearm runs up through the armpit and
// down the sleeve. Geodesic distances (Dijkstra over the welded mesh) from the forearms / hands and from the
// trunk give every vertex an "armness"; an upper-arm weight is kept only on the arm's own side of the armpit seam,
// the rest goes to the vertex's main trunk bone.
const TRUNK = [BI.Hips, BI.Spine02, BI.Spine01, BI.Spine];
function separateArms(P, n, index, WB) {
  // weld split vertices (UV seams) by position
  const key = new Map(), wid = new Int32Array(n), rep = [];
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
    let id = key.get(k);
    if (id === undefined) { id = rep.length; key.set(k, id); rep.push(i); }
    wid[i] = id;
  }
  const m = rep.length, deg = new Int32Array(m + 1), E = [];
  for (let t = 0; t < index.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = wid[index[t + e]], b = wid[index[t + ((e + 1) % 3)]];
    if (a !== b) { E.push(a, b); deg[a]++; deg[b]++; }
  }
  const off = new Int32Array(m + 1);
  for (let i = 0; i < m; i++) off[i + 1] = off[i] + deg[i];
  const nb = new Int32Array(off[m]), len = new Float64Array(off[m]), fill = off.slice(0, m);
  for (let k = 0; k < E.length; k += 2) {
    const a = E[k], b = E[k + 1], ra = rep[a] * 3, rb = rep[b] * 3;
    const d = Math.hypot(P[ra] - P[rb], P[ra + 1] - P[rb + 1], P[ra + 2] - P[rb + 2]);
    nb[fill[a]] = b; len[fill[a]++] = d; nb[fill[b]] = a; len[fill[b]++] = d;
  }
  // per welded vertex: the summed weights of its copies (they share one weighting)
  const W = (id, bones) => { let s = 0; const wb = WB[rep[id]]; for (const b of bones) s += wb.get(b) || 0; return s; };
  const dist = (isSeed) => {
    const d = new Float64Array(m).fill(Infinity), heap = new Heap(); // (64-bit: float32 rounding would relax forever)
    for (let i = 0; i < m; i++) if (isSeed(i)) { d[i] = 0; heap.push(0, i); }
    while (heap.size) {
      const [du, u] = heap.pop();
      if (du > d[u]) continue;
      for (let k = off[u]; k < off[u + 1]; k++) {
        const v = nb[k], dv = du + len[k];
        if (dv < d[v]) { d[v] = dv; heap.push(dv, v); }
      }
    }
    return d;
  };
  const dT = dist((i) => W(i, TRUNK) >= 0.9);
  for (const [up, far] of [[BI.LeftArm, [BI.LeftForeArm, BI.LeftHand]], [BI.RightArm, [BI.RightForeArm, BI.RightHand]]]) {
    const dA = dist((i) => W(i, far) >= 0.5);
    for (let i = 0; i < n; i++) {
      const wb = WB[i], w = wb.get(up);
      if (!w) continue;
      const a = dA[wid[i]], b = dT[wid[i]];
      if (!Number.isFinite(b)) continue;                    // no trunk on this piece: leave it
      const armness = Number.isFinite(a) ? b / (a + b + 1e-6) : 0;
      const keep = smoothstep(0.3, 0.55, armness);
      if (keep >= 1) continue;
      let to = BI.Spine, best = -1;
      for (const tb of TRUNK) { const tw = wb.get(tb) || 0; if (tw > best) { best = tw; to = tb; } }
      if (best <= 0) to = BI.Spine;
      wb.set(up, w * keep);
      wb.set(to, (wb.get(to) || 0) + w * (1 - keep));
      if (!wb.get(up)) wb.delete(up);
    }
  }
}
class Heap { // binary min-heap of (key, value)
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = [k[0], v[0]], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        if (l >= k.length) break;
        const c = r < k.length && k[r] < k[l] ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// Meshy rigs sometimes bind coat / jacket vertices to a forearm or hand that rested near them in the bind pose:
// raising the arm then tears them off the body. A vertex is either on the body or on the arm: whichever side
// carries more weight takes the other side's share (upper arms + shoulders blend with the torso as usual).
const TORSO = new Set([BI.Hips, BI.Spine02, BI.Spine01, BI.Spine, BI.neck, BI.LeftUpLeg, BI.RightUpLeg]);
const FAR_ARM = new Set([BI.LeftForeArm, BI.LeftHand, BI.RightForeArm, BI.RightHand]);
function cleanWeights(wb) {
  let wt = 0, wa = 0, bt = -1, ba = -1, mt = 0, ma = 0;
  for (const [b, w] of wb) {
    if (TORSO.has(b)) { wt += w; if (w > mt) { mt = w; bt = b; } } else if (FAR_ARM.has(b)) { wa += w; if (w > ma) { ma = w; ba = b; } }
  }
  if (!wt || !wa) return;
  const [drop, to] = wt >= wa ? [FAR_ARM, bt] : [TORSO, ba];
  let moved = 0;
  for (const [b, w] of wb) if (drop.has(b)) { moved += w; wb.delete(b); }
  wb.set(to, (wb.get(to) || 0) + moved);
}

function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function smallestEigen(m) {
  // power iteration on (trace*I - M) gives the smallest-eigenvalue direction of a 3x3 covariance
  const t = m[0][0] + m[1][1] + m[2][2];
  let v = new THREE.Vector3(0.3, 0.5, 0.8);
  for (let it = 0; it < 60; it++) {
    const x = (t - m[0][0]) * v.x - m[0][1] * v.y - m[0][2] * v.z;
    const y = -m[1][0] * v.x + (t - m[1][1]) * v.y - m[1][2] * v.z;
    const z = -m[2][0] * v.x - m[2][1] * v.y + (t - m[2][2]) * v.z;
    v.set(x, y, z).normalize();
  }
  return v;
}

let kitsPromise = null;
/** Loads + bakes the spectator characters once (resolves to [] when the models are missing). */
export function loadFanKits() {
  return (kitsPromise ??= Promise.all(FAN_MODELS.map(async (n) => {
    const g = await loadGLB(n);
    if (!g) return null;
    try { return new FanKit(n, g); } catch (e) { console.warn('fan kit', n, e.message); return null; }
  })).then((a) => a.filter(Boolean)));
}

// ------------------------------------------------------------------ shaders
const FAN_VERT_PARS = /* glsl */`
uniform highp sampler2D uFanPal;
uniform float uFanTime;
uniform vec3 uFanGrip;
attribute vec4 aBones;
attribute vec4 aWeights;
attribute vec3 aInfo;
attribute vec2 aSlot;
varying float vFanKind;
varying vec2 vFanUv;
varying vec3 vFanCol;
varying float vFanFlag;
varying float vFanSki;
varying float vFanFade;
`;
const FAN_SKIN = /* glsl */`
  int fanRow = int(aSlot.x + 0.5);
  vec4 fanC0 = texelFetch(uFanPal, ivec2(${NB * 3}, fanRow), 0);
  vec4 fanC1 = texelFetch(uFanPal, ivec2(${NB * 3 + 1}, fanRow), 0);
  vec3 fanP = position;
  float fanKind = aInfo.x;
  if (fanKind > 0.5) {
    bool show = fanKind < 2.5 ? (fanC0.w > 0.5 && fanC0.w < 1.5) : fanKind < 4.5 ? (fanC0.w > 1.5 && fanC0.w < 2.5) : (fanC0.w > 2.5);
    if (!show) fanP = uFanGrip;
    else if (fanKind < 1.5) {
      // cloth: flutters in the air when waved; calm, it hangs limp in folds along the stick
      float u = aInfo.y, amp = fanC1.z, limp = 1.0 - amp;
      fanP.x += (sin(uFanTime * 8.5 - u * 6.5 + fanC1.y) * 0.07 + sin(uFanTime * 14.0 - u * 12.0 + fanC1.y * 2.3) * 0.022) * u * (0.2 + 0.8 * amp);
      fanP.x += sin(u * 17.0 + fanC1.y) * 0.04 * u * limp;
      fanP.z = uFanGrip.z + (fanP.z - uFanGrip.z) * (1.0 - 0.72 * limp);
      fanP.y -= u * u * 0.26 * limp;
    }
  }
  vec3 fanPos = vec3(0.0), fanNrm = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    float w = aWeights[k];
    if (w > 0.0) {
      int x = int(aBones[k] + 0.5) * 3;
      vec4 r0 = texelFetch(uFanPal, ivec2(x, fanRow), 0);
      vec4 r1 = texelFetch(uFanPal, ivec2(x + 1, fanRow), 0);
      vec4 r2 = texelFetch(uFanPal, ivec2(x + 2, fanRow), 0);
      fanPos += w * vec3(dot(r0.xyz, fanP) + r0.w, dot(r1.xyz, fanP) + r1.w, dot(r2.xyz, fanP) + r2.w);
      fanNrm += w * vec3(dot(r0.xyz, normal), dot(r1.xyz, normal), dot(r2.xyz, normal));
    }
  }
  vFanKind = fanKind; vFanUv = aInfo.yz; vFanCol = fanC0.rgb; vFanFlag = fanC1.x; vFanFade = aSlot.y; vFanSki = fanC1.w;
`;
const FAN_FRAG_PARS = /* glsl */`
uniform vec4 uFanBase;
uniform float uFanGlow;
varying float vFanKind;
varying vec2 vFanUv;
varying vec3 vFanCol;
varying float vFanFlag;
varying float vFanSki;
varying float vFanFade;
vec3 fanFlag(float id, vec2 uv) {
  int f = int(id + 0.5);
  float u = uv.x, v = uv.y;
  vec3 W = vec3(0.86);
  if (f == 0) return abs(v - 0.5) < 0.167 ? W : vec3(0.58, 0.005, 0.027);                                         // Austria
  if (f == 1) return u < 0.333 ? vec3(0.0, 0.29, 0.062) : (u < 0.667 ? W : vec3(0.62, 0.024, 0.038));            // Italy
  if (f == 2) return u < 0.333 ? vec3(0.0, 0.09, 0.37) : (u < 0.667 ? W : vec3(0.86, 0.052, 0.036));             // France
  if (f == 3) return v > 0.667 ? vec3(0.012) : (v > 0.333 ? vec3(0.72, 0.0, 0.0) : vec3(1.0, 0.62, 0.0));        // Germany
  if (f == 4) { vec2 d = abs(vec2((u - 0.5) * 1.5, v - 0.5));                                                   // Switzerland
    return ((d.x < 0.085 && d.y < 0.28) || (d.y < 0.085 && d.x < 0.28)) ? W : vec3(0.7, 0.022, 0.011); }
  if (f == 5) { float du = abs(u - 0.37) * 1.5, dv = abs(v - 0.5);                                               // Norway
    if (du < 0.0625 || dv < 0.0625) return vec3(0.0, 0.015, 0.104);
    return (du < 0.125 || dv < 0.125) ? W : vec3(0.49, 0.004, 0.028); }
  float du = abs(u - 0.37) * 1.5, dv = abs(v - 0.5);                                                             // Sweden
  return (du < 0.1 || dv < 0.1) ? vec3(0.99, 0.6, 0.001) : vec3(0.0, 0.145, 0.386);
}
`;

function patchFan(shader, U, depth) {
  Object.assign(shader.uniforms, { uFanPal: U.pal, uFanTime: U.time, uFanGrip: U.grip, uFanBase: U.base, uFanGlow: U.glow || { value: 0 } });
  let v = shader.vertexShader.replace('#include <common>', '#include <common>\n' + FAN_VERT_PARS);
  if (depth) {
    v = v.replace('#include <begin_vertex>', FAN_SKIN + '\n vec3 transformed = fanPos;');
  } else {
    v = v.replace('#include <beginnormal_vertex>', FAN_SKIN + '\n vec3 objectNormal = normalize(fanNrm);')
      .replace('#include <begin_vertex>', 'vec3 transformed = fanPos;');
  }
  shader.vertexShader = v;
  let f = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + FAN_FRAG_PARS);
  // screen-door cross-fade (LOD switches, the crowd's far edge): complementary patterns for the two LODs
  f = f.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
    {
      float dth = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (vFanFade < -1.5) { if (dth < -vFanFade - 2.0) discard; } else if (dth >= vFanFade) discard;
    }`);
  if (!depth) {
    f = f.replace('#include <color_fragment>', `#include <color_fragment>
      if (vFanKind < 0.5) {
        // jacket recolour: texels near the jacket's own hue take the fan's colour, folds / shading kept
        if (vFanCol.r >= 0.0 && uFanBase.z > 0.0) {
          vec3 c = diffuseColor.rgb;
          float Y = dot(c, vec3(0.299, 0.587, 0.114));
          vec2 iq = vec2(dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
          float bc = length(uFanBase.xy), ch = length(iq);
          float cs = dot(iq, uFanBase.xy) / max(ch * bc, 1e-6);
          // saturation (chroma / luma) against the jacket's: shaded folds and seams key like the lit cloth
          float sat = (ch / max(Y, 0.004)) / (bc / uFanBase.z);
          float k = vFanUv.x * smoothstep(uFanBase.w - 0.2, uFanBase.w - 0.04, cs) * smoothstep(0.28, 0.5, sat) * smoothstep(0.004, 0.012, ch);
          diffuseColor.rgb = mix(c, vFanCol * clamp(Y / uFanBase.z, 0.0, 2.2), k);
        }
      } else if (vFanKind < 1.5) diffuseColor.rgb = fanFlag(vFanFlag, vFanUv);
      else if (vFanKind < 2.5) diffuseColor.rgb = vec3(0.32, 0.17, 0.07);
      else if (vFanKind < 3.5) diffuseColor.rgb = mix(vec3(0.015, 0.011, 0.006), vec3(0.42, 0.25, 0.06), smoothstep(0.03, 0.09, vFanUv.x)); // bronze, dark mouth
      else if (vFanKind < 4.5) diffuseColor.rgb = mix(vec3(0.36, 0.025, 0.02), vec3(0.8, 0.78, 0.72), step(0.86, fract(vFanUv.x * 4.0))); // red strap, white stitching
      else if (vFanKind < 5.5) { // skis: dark base and edges, a coloured top sheet with a band across it
        int f = int(vFanSki + 0.5);
        vec3 a = f == 0 ? vec3(0.015) : f == 1 ? vec3(0.5, 0.02, 0.02) : f == 2 ? vec3(0.78) : f == 3 ? vec3(0.015, 0.08, 0.36) : f == 4 ? vec3(0.7, 0.45, 0.0) : vec3(0.02, 0.22, 0.08);
        vec3 b = f == 0 ? vec3(0.55, 0.02, 0.02) : f == 1 ? vec3(0.8) : f == 2 ? vec3(0.015, 0.08, 0.36) : f == 3 ? vec3(0.8) : f == 4 ? vec3(0.015) : vec3(0.8);
        float band = step(0.4, vFanUv.y) * step(vFanUv.y, 0.6);
        diffuseColor.rgb = mix(vec3(0.02), mix(a, b, band), vFanUv.x);
      } else diffuseColor.rgb = vec3(0.05, 0.05, 0.055); // bindings`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += diffuseColor.rgb * uFanGlow;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
      if (vFanKind > 2.5 && vFanKind < 3.5) { metalnessFactor = 0.6; roughnessFactor = 0.32; }
      if (vFanKind > 4.5) { metalnessFactor = vFanKind > 5.5 ? 0.5 : 0.1; roughnessFactor = 0.35; }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      if (vFanKind > 0.5) normal = nonPerturbedNormal;`);
  }
  shader.fragmentShader = f;
}

// ------------------------------------------------------------------ a crowd of fans (one per arena / course)
const LOD_FADE = 0.4; // s

export class FanCrowd {
  /**
   * @param {FanKit[]} kits
   * @param {{x,y,z,yaw,stand?,free?,matrix?}[]} spots  y = ground under the feet
   * @param {() => number} rnd
   * @param {object} o  parent, name, shadows
   */
  constructor(kits, spots, rnd, { parent, name = 'fans', shadows = false, dynamic = false, bounds = null, lively = false, glow = 0 } = {}) {
    this.kits = kits;
    // lively spectators: between the cheering they chat with a neighbour (hands going), check a phone or the
    // time, clap to keep warm, look round more (crowds.js opts in for the resort arenas)
    this.lively = lively;
    const n = spots.length;
    this.n = n;
    this.scl = new Float32Array(n * 2); // body scale (width, height): setPlace keeps it
    // people who move (FanCrowd.dynamic): a simulation (railpeople.js, townsfolk.js) sets each one's place
    // (setPlace) and activity every frame; their pose comes from poseDyn instead of the cheering rhythm
    this.dyn = dynamic ? {
      alpha: new Float32Array(n).fill(1),  // 0 hidden (off stage) .. 1 shown (screen-door fade in between)
      walk: new Float32Array(n),           // 0 standing .. 1 walking (pose blend)
      wph: new Float32Array(n),            // walking cycle phase 0..1 (advance by speed / WALK_STRIDE)
      talk: new Float32Array(n),           // 0..1 talking with gestures
      hold: new Uint8Array(n),             // a held upper-body pose (FAN_KEYS.PHONE / WATCH / POINT / HOLD / POCKET / CARRY), 0 none
      holdW: new Float32Array(n),          // its weight 0..1
      lookY: new Float32Array(n),          // wanted head turn (rad, + = to the person's left), lookP pitch (+ = down)
      lookP: new Float32Array(n),
      carry: new Uint8Array(n),            // 1: skis over the right shoulder (the right arm holds them)
    } : null;
    this.boundsOverride = bounds;
    this.glowU = { value: glow }; // self-light (people in the dim rock hall: lit like its walls)
    // per fan: kit, transform, personality
    const shares = kits.map((k) => k.cfg.share), tot = shares.reduce((a, b) => a + b, 0);
    this.kit = new Uint8Array(n);
    this.mat = new Float32Array(n * 16);
    this.pos = new Float32Array(n * 3);
    this.yaw = new Float32Array(n);
    this.style = new Uint8Array(n); this.calm = new Uint8Array(n);
    this.energy = new Float32Array(n); this.phase = new Float32Array(n); this.rate = new Float32Array(n);
    this.thresh = new Float32Array(n); this.jumper = new Uint8Array(n); this.onStand = new Uint8Array(n);
    this.e = new Float32Array(n); this.lookY = new Float32Array(n); this.lookP = new Float32Array(n);
    this.lod = new Int8Array(n).fill(-1); this.next = new Int8Array(n).fill(-1); this.fade = new Float32Array(n).fill(1);
    this.dist = new Float32Array(n).fill(1e9); this.inView = new Uint8Array(n);
    const pal = new Float32Array(n * ROW * 4);
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), s = new THREE.Vector3(), col = new THREE.Color();
    let flags = 0, bells = 0;
    const box = new THREE.Box3();
    spots.forEach((sp, i) => {
      // a character, preferably not the same as a neighbour's (spots come roughly in order along the rows)
      let k = 0;
      for (let tries = 0; tries < 4; tries++) {
        let r = rnd() * tot;
        k = 0;
        while (k < kits.length - 1 && r > shares[k]) { r -= shares[k]; k++; }
        let twin = false;
        for (let j = Math.max(0, i - 8); j < i && !twin; j++) {
          if (this.kit[j] === k && (spots[j].x - sp.x) ** 2 + (spots[j].z - sp.z) ** 2 < 2.6) twin = true;
        }
        if (!twin) break;
      }
      if (sp.kit !== undefined) k = sp.kit;
      this.kit[i] = k;
      const kit = kits[k];
      const sc = kit.cfg.scale[0] + rnd() * (kit.cfg.scale[1] - kit.cfg.scale[0]);
      qq.setFromAxisAngle(Y_AXIS, sp.yaw);
      m.compose(new THREE.Vector3(sp.x, sp.y, sp.z), qq, s.set(sc, sc * (0.98 + rnd() * 0.04), sc));
      this.scl[i * 2] = s.x; this.scl[i * 2 + 1] = s.y;
      m.toArray(this.mat, i * 16);
      this.pos[i * 3] = sp.x; this.pos[i * 3 + 1] = sp.y + 1; this.pos[i * 3 + 2] = sp.z;
      this.yaw[i] = sp.yaw;
      this.onStand[i] = sp.stand ? 1 : 0;
      box.expandByPoint(new THREE.Vector3(sp.x, sp.y, sp.z));
      // personality
      this.energy[i] = 0.35 + rnd() * 0.65;
      this.phase[i] = rnd() * Math.PI * 2;
      this.rate[i] = 0.88 + rnd() * 0.26;
      this.thresh[i] = 0.03 + rnd() * 0.42;
      this.jumper[i] = !sp.stand && kit.name !== 'fan_elder' && rnd() < (kit.name === 'fan_kid' ? 0.5 : 0.16) ? 1 : 0;
      const free = sp.free ?? 1;
      // props: flags among the standing rows (room above the neighbours' heads), cowbells anywhere
      let prop = 0;
      const pr = rnd();
      if (!sp.stand && free > 0.8 && pr < 0.13) { prop = 1; flags++; } else if (pr > 0.9 && kit.name !== 'fan_kid') { prop = 2; bells++; }
      if (sp.prop !== undefined) prop = sp.prop;
      let st;
      if (prop === 1) st = STYLE.FLAG;
      else if (prop === 2) st = STYLE.BELL;
      else {
        const opts = [STYLE.CLAP, STYLE.CLAP, STYLE.CLAP, STYLE.CLAPHI, STYLE.PUMP, STYLE.WAVE, STYLE.VUP, STYLE.VUP];
        st = opts[Math.floor(rnd() * opts.length)];
        if (st === STYLE.VUP && free < 0.85) st = STYLE.CLAPHI; // arms out wide only with room beside
      }
      this.style[i] = st;
      this.calm[i] = prop === 1 ? K.FLAG_REST : prop === 2 ? K.BELL_REST : rnd() < 0.25 ? K.HOLD : rnd() < 0.15 ? K.POCKET : 0;
      // colours: jacket (or keep the model's own), flag
      const o = (i * ROW + NB * 3) * 4;
      if (!kit.base || rnd() < kit.cfg.keep) { pal[o] = -1; pal[o + 1] = 0; pal[o + 2] = 0; } else {
        col.set(JACKETS[Math.floor(rnd() * JACKETS.length)]).convertSRGBToLinear();
        pal[o] = col.r; pal[o + 1] = col.g; pal[o + 2] = col.b;
      }
      pal[o + 3] = prop;
      pal[o + 4] = Math.floor(rnd() * NFLAGS); pal[o + 5] = rnd() * 6.28; pal[o + 6] = 0; pal[o + 7] = Math.floor(rnd() * 6); // (ski colours)
      this.lookY[i] = (rnd() - 0.5) * 0.4;
    });
    this.flags = flags; this.bells = bells;
    this.center = box.getCenter(new THREE.Vector3());
    this.radius = box.getSize(new THREE.Vector3()).length() / 2 + 3;
    if (bounds) { this.center.copy(bounds.center); this.radius = bounds.radius; } // (people who walk about: their whole area)
    this.sphere = new THREE.Sphere(this.center.clone().add(new THREE.Vector3(0, 1, 0)), this.radius);
    this.pal = pal;
    this.tex = new THREE.DataTexture(pal, ROW, n, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    this.time = { value: 0 };
    // meshes: per kit x LOD
    this.group = new THREE.Group();
    this.group.name = name;
    this.meshes = kits.map((kit, k) => {
      const count = this.kit.reduce((a, v) => a + (v === k ? 1 : 0), 0);
      const U = { pal: { value: this.tex }, time: this.time, grip: { value: kit.G }, base: { value: kit.base || new THREE.Vector4(0, 0, 0, 1) }, glow: this.glowU };
      return [0, 1, 2].map((l) => {
        const src = kit.geos[l];
        const geo = new THREE.BufferGeometry();
        for (const [nm, a] of Object.entries(src.attributes)) geo.setAttribute(nm, a);
        geo.setIndex(src.index);
        geo.boundingSphere = src.boundingSphere;
        const slot = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 2), 2);
        slot.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aSlot', slot);
        const mat = kit.materials[l].clone();
        mat.vertexColors = l > 0;
        if (l > 0) { mat.map = null; mat.normalMap = null; }
        mat.onBeforeCompile = (sh) => patchFan(sh, U, false);
        mat.customProgramCacheKey = () => `fan-v1-${l > 0 ? 'vc' : 'tex'}`;
        const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        if (shadows && l < 2) {
          const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
          dm.onBeforeCompile = (sh) => patchFan(sh, U, true);
          dm.customProgramCacheKey = () => 'fan-depth-v1';
          mesh.customDepthMaterial = dm;
        }
        mesh.castShadow = false;
        mesh.name = `${name}-${kit.name}-lod${l}`;
        mesh.userData.slot = slot;
        this.group.add(mesh);
        return mesh;
      });
    });
    // contact shadows: a soft ellipse on the snow under every fan (ties the boots to the ground on every preset;
    // on high / ultra the fans also cast real shadows)
    {
      const bm = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
      // a soft ellipse that multiplies the snow under it toward the blue of a sky-lit shadow. Sunlit snow is several
      // times brighter than white before tone mapping, so the core goes down to ~20 % (like real shade) to read at
      // all; no depth writes, the boots stay on top
      const blobs = new THREE.InstancedMesh(blobGeometry(), blobMaterial(shadows ? 0.6 : 0.9), n);
      spots.forEach((sp, i) => {
        const c = Math.cos(sp.yaw), sn = Math.sin(sp.yaw), sx = sp.gsx || 0, sz = sp.gsz || 0;
        // fan frame -> world: local +x = (c, 0, -sn), local +z = (sn, 0, c); tilted along the snow's slope
        X.set(c, sx, -sn).normalize(); Z.set(sn, sz, c).normalize(); Y.crossVectors(Z, X).normalize();
        const k = Math.hypot(this.mat[i * 16], this.mat[i * 16 + 2]) || 1; // the fan's scale (|column 0| of a yaw-only matrix)
        bm.makeBasis(X.multiplyScalar(1.3 * k), Y, Z.multiplyScalar(1.0 * k));
        bm.setPosition(sp.x, (sp.gy ?? sp.y) + 0.025, sp.z);
        blobs.setMatrixAt(i, bm);
      });
      blobs.instanceMatrix.needsUpdate = true;
      blobs.frustumCulled = false;
      blobs.renderOrder = 2;
      blobs.name = `${name}-contact`;
      this.group.add(blobs);
      this.blobs = blobs;
    }
    this.shadows = shadows;
    parent.add(this.group);
    this.frame = 0;
    // (performance pass: hidden until its first update in range: a crowd whose sim never runs (a station far off) drew
    // ~20 empty instanced meshes and its contact shadows every frame, frustum culling off)
    this.group.visible = false;
    this.visible = false;
    // scratch for the pose composer
    this.L = new Float32Array(NB * 4); this.W = new Float32Array(NB * 4); this.Pw = new Float32Array(NB * 3);
    this.tmp = new Float32Array(4);
    this.stale = new Uint8Array(n).fill(1);
    this.rag = new Uint8Array(n); // 1: the skeleton comes from a SkierRig (poseFromRig: knocked over by a car), not poseDyn
    this.lists = this.meshes.flatMap((row) => row.map((mesh) => new Float32Array(mesh.instanceMatrix.count * 2)));
    this.cnt = new Int32Array(this.lists.length);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.blobs.material.dispose(); this.blobs.dispose(); // (the geometry is shared)
    for (const row of this.meshes) for (const mesh of row) {
      // only the per-crowd parts: the kit's vertex buffers are shared with the other crowds
      const g = mesh.geometry;
      for (const nm of Object.keys(g.attributes)) if (nm !== 'aSlot') g.deleteAttribute(nm);
      g.setIndex(null);
      g.dispose();
      mesh.material.dispose();
      mesh.customDepthMaterial?.dispose();
      mesh.dispose();
    }
    this.tex.dispose();
  }

  /**
   * @param {number} dt
   * @param {object} c  cam (Vector3), frustum (THREE.Frustum|null), view (fade-out distance), lod [near, mid],
   *                    cheer (0..1 crowd level), player {x, y, z, speed}|null, time, shadows
   * @returns {number} 0 out of range, 1 in range but off screen, 2 drawn
   */
  update(dt, c) {
    const near = c.cam.distanceTo(this.sphere.center) < c.view + this.radius;
    if (!near || (c.frustum && !c.frustum.intersectsSphere(this.sphere))) {
      if (this.visible) { this.group.visible = false; this.visible = false; }
      return near ? 1 : 0;
    }
    if (!this.visible) { this.group.visible = true; this.visible = true; this.stale.fill(1); this.lastSum = NaN; }
    this.time.value = c.time;
    this.frame++;
    const n = this.n, cam = c.cam, [d0, d1] = c.lod, view = c.view;
    const pl = c.player;
    // LODs + fades -> per kit x LOD lists of (fan, fade); a checksum skips the buffer upload when nothing changed
    const lists = this.lists, cnt = this.cnt, fr = c.frustum, sph = this._sph || (this._sph = new THREE.Sphere(new THREE.Vector3(), 1.5));
    sph.radius = this.shadows && c.shadows ? 4 : 1.5; // (with shadow maps: fans just off screen still cast into view)
    cnt.fill(0);
    let sum = 2166136261;
    const D = this.dyn;
    for (let i = 0; i < n; i++) {
      const dx = this.pos[i * 3] - cam.x, dy = this.pos[i * 3 + 1] - cam.y, dz = this.pos[i * 3 + 2] - cam.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.dist[i] = d;
      const a = D ? D.alpha[i] : 1; // (people off stage are not drawn; walking on / off they fade in and out)
      const edge = (1 - smoothstep(view * 0.86, view, d)) * a;
      if (edge <= 0.002) { this.lod[i] = -1; this.next[i] = -1; this.fade[i] = 1; this.inView[i] = 0; continue; }
      const cur = this.lod[i];
      const want = c.forceLod !== undefined ? c.forceLod : cur < 0 ? (d < d0 ? 0 : d < d1 ? 1 : 2)
        : (d < d0 - (cur === 0 ? -2 : 2) ? 0 : d < d1 - (cur <= 1 ? -3 : 3) ? 1 : 2);
      if (cur < 0) { this.lod[i] = want; this.fade[i] = 1; }
      else if (this.fade[i] >= 1 && want !== cur) { this.next[i] = want; this.fade[i] = 0; }
      if (this.fade[i] < 1) {
        this.fade[i] += dt / LOD_FADE;
        if (this.fade[i] >= 1) { this.lod[i] = this.next[i]; this.next[i] = -1; this.fade[i] = 1; }
      }
      // off screen: keeps its LOD state, not drawn (nor posed: re-posed when it comes into view)
      if (fr) {
        sph.center.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
        if (!fr.intersectsSphere(sph)) { this.inView[i] = 0; continue; }
      }
      this.inView[i] = 1;
      const k3 = this.kit[i] * 3;
      if (this.fade[i] < 1 && a >= 1) {
        const f = this.fade[i];
        push(lists, cnt, k3 + this.lod[i], i, -f - 2); // outgoing LOD: where the dither is >= f
        push(lists, cnt, k3 + this.next[i], i, f);      // incoming LOD: where it is < f
        sum = Math.imul(sum ^ (i * 64 + 16 + this.lod[i] * 4 + this.next[i]), 16777619) ^ Math.round(f * 255);
      } else {
        push(lists, cnt, k3 + this.lod[i], i, edge >= 1 ? 1 : edge);
        sum = Math.imul(sum ^ (i * 64 + this.lod[i]), 16777619) ^ (edge >= 1 ? 0 : 256 + Math.round(edge * 255));
      }
    }
    // excitement + poses: far fans less often, calm fans (slow weight shifts) a third as often, fans off screen not
    // at all (re-posed as soon as they come into view)
    const cheer = c.cheer;
    if (D) { this.updateDyn(dt, c); return 2; }
    for (let i = 0; i < n; i++) {
      if (this.lod[i] < 0) continue;
      // each fan either cheers or not (a half-raised arm held for seconds looks like pointing); the crowd level
      // decides how many join in, the excitement eases the arms up and down
      let target = cheer > this.thresh[i] ? 1 : 0;
      // the racer going past: the fans nearby go wild
      if (pl && pl.speed > 5) {
        const px = pl.x - this.pos[i * 3], pz = pl.z - this.pos[i * 3 + 2];
        if (px * px + pz * pz < (16 + 18 * this.energy[i]) ** 2) target = 1;
      }
      // calm crowds: now and then somebody claps or waves for a few seconds
      const ph = this.phase[i];
      if (this.energy[i] > 0.45 && Math.sin(c.time * 0.11 * this.rate[i] + ph * 3.1) > 0.95) target = 1;
      const e = this.e[i];
      this.e[i] = e + (target - e) * Math.min(1, dt * (target > e ? 2.6 + this.energy[i] * 2 : 1.1));
      if (!this.inView[i]) { this.stale[i] = 1; continue; }
      const l = this.lod[i];
      const every = (l === 0 ? 1 : l === 1 ? 2 : this.dist[i] > 120 ? 6 : 3) * (this.e[i] < 0.02 && target === 0 ? (this.lively ? 2 : 3) : 1);
      if (this.stale[i] || (this.frame + i) % every === 0) { this.poseFan(i, c.time, dt * every, pl); this.stale[i] = 0; }
    }
    this.tex.needsUpdate = true;
    // instance buffers (only when a fan changed LOD / fade, or the crowd's shadow setting changed)
    const shadowsOn = this.shadows && c.shadows;
    if (sum === this.lastSum && shadowsOn === this.lastShadows) return 2;
    this.lastSum = sum; this.lastShadows = shadowsOn;
    for (let k = 0; k < this.kits.length; k++) for (let l = 0; l < 3; l++) {
      const mesh = this.meshes[k][l], L = lists[k * 3 + l], m = cnt[k * 3 + l];
      mesh.count = m;
      mesh.visible = m > 0;
      mesh.castShadow = shadowsOn && l < 2;
      if (!m) continue;
      const im = mesh.instanceMatrix.array, sl = mesh.userData.slot.array;
      for (let j = 0; j < m; j++) {
        const i = L[j * 2];
        im.set(this.mat.subarray(i * 16, i * 16 + 16), j * 16);
        sl[j * 2] = i; sl[j * 2 + 1] = L[j * 2 + 1];
      }
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, m * 16); mesh.instanceMatrix.needsUpdate = true;
      const sa = mesh.userData.slot; sa.clearUpdateRanges(); sa.addUpdateRange(0, m * 2); sa.needsUpdate = true;
    }
    return 2;
  }

  // one fan's skeleton -> its palette row
  poseFan(i, t, dt, pl) {
    const kit = this.kits[this.kit[i]], kq = kit.kq, kh = kit.kh;
    if (this.force && this.force[i] >= 0) { // lookdev: hold one keyframe
      const k = this.force[i], L = this.L, calm = k === K.FLAG_REST || k === K.BELL_REST ? 0 : 1;
      for (let bn = 0; bn < NBA; bn++) blend4(kq, bn, k, 1, 0, 0, 0, 0, 0, 0, L, bn * 4);
      const pq = this.propQuat(i, calm, k === K.FLAG_B || k === K.BELL_B ? 1 : 0, 0, t);
      composeRow(kit, L, kh[k * 3], kh[k * 3 + 1], kh[k * 3 + 2], 0, 0, pq, this.pal, i * ROW * 4, this.W, this.Pw);
      return;
    }
    const e = this.e[i], en = this.energy[i], ph = this.phase[i], rate = this.rate[i];
    const st = STYLES[this.style[i]];
    // rhythms
    const tt = t * rate;
    const ws = 0.5 + 0.5 * Math.sin(tt * (this.lively ? 0.8 : 0.55) + ph); // weight shift
    const wsS = ws * ws * (3 - 2 * ws);
    const th = tt * st[2] * Math.PI * 2 + ph;
    let osc;
    if (st[3] === 'clap') osc = Math.pow(0.5 + 0.5 * Math.cos(th), 3.5);  // hands meet briefly
    else if (st[3] === 'pump') osc = Math.pow(0.5 + 0.5 * Math.sin(th), 1.6);
    else osc = 0.5 + 0.5 * Math.sin(th);
    const calmK = this.calm[i];
    // bounce with the rhythm, jumpers hop when they are really excited
    let crouch = e * e * en * 0.22 * (0.5 + 0.5 * Math.sin(th * (st[3] === 'clap' ? 0.5 : 1) - 0.6));
    let lift = 0;
    if (this.jumper[i] && e > 0.65) {
      const hop = (tt * 1.35 + ph / 6.283) % 1, on = Math.sin(tt * 0.6 + ph * 2) > -0.3 ? 1 : 0;
      const a = smoothstep(0.65, 0.9, e) * on;
      if (hop < 0.45) lift = Math.sin((hop / 0.45) * Math.PI) * 0.13 * a;
      else crouch = Math.max(crouch, Math.sin(((hop - 0.45) / 0.55) * Math.PI) * 0.75 * a);
    }
    crouch = Math.min(1, crouch);
    // weights: upper = calm (stance / held pose) .. cheer (style A..B); lower = stance L..R + crouch
    const L = this.L;
    const wcalmA = (1 - e) * (calmK ? 1 : 1 - wsS), wcalmB = (1 - e) * (calmK ? 0 : wsS);
    const kcA = calmK || K.STAND_L, kcB = K.STAND_R;
    const wA = e * (1 - osc), wB = e * osc;
    // lively: what this fan does between the cheering, ~10-16 s at a time (eased in and out)
    let act = 0, actW = 0, side = 1;
    if (this.lively) {
      const span = 7 + (ph * 7.3) % 5, u = tt / span + ph * 3.7, slot = Math.floor(u), fr = u - slot;
      const h = Math.abs(Math.sin(slot * 12.9898 + ph * 78.233) * 43758.5453) % 1;
      act = h < 0.32 ? 1 : h < 0.46 ? 2 : h < 0.54 ? 3 : h < 0.68 ? 4 : 0; // 1 chat, 2 phone, 3 watch, 4 clap to keep warm
      side = (h * 97) % 1 < 0.5 ? 1 : -1;
      actW = act ? smoothstep(0, 0.12, fr) * (1 - smoothstep(0.85, 1, fr)) * (1 - e) : 0;
    }
    if (actW > 0.001) {
      let nk = 0;
      const add = (k, w) => { if (w > 0.001) { _ks[nk] = k; _ws[nk] = w; nk++; } };
      const calm = 1 - actW;
      add(kcA, wcalmA * calm); add(kcB, wcalmB * calm); add(st[0], wA); add(st[1], wB);
      if (act === 1) {
        const g1 = Math.max(0, Math.sin(tt * 0.83 + ph * 3.1)) ** 2, g2 = Math.max(0, Math.sin(tt * 0.61 + ph * 5.3 + 2)) ** 2, g3 = Math.max(0, Math.sin(tt * 1.07 + ph * 7.7 + 4)) ** 2;
        const talking = Math.sin(tt * 0.4 + ph * 2) > -0.2 ? 0.85 : 0.2, gs = g1 + g2 + g3 + 0.6, k = actW * talking / gs;
        add(K.TALK_A, g1 * k); add(K.TALK_B, g2 * k); add(K.TALK_C, g3 * k); add(kcA, (0.6 * k) + actW * (1 - talking));
      } else if (act === 2) add(K.PHONE, actW);
      else if (act === 3) add(K.WATCH, actW * smoothstep(0.2, 0.3, (tt * 0.31 + ph) % 1));
      else if (act === 4) { const c = Math.pow(0.5 + 0.5 * Math.cos(tt * 2 * Math.PI * 1.6 + ph), 3); add(K.CLAP_O, actW * (1 - c)); add(K.CLAP_S, actW * c); }
      if (nk === 0) add(K.STAND_L, 1);
      for (let u = 0; u < UPPER.length; u++) blendN(kq, UPPER[u], _ks, _ws, nk, L, UPPER[u] * 4);
    } else for (let u = 0; u < UPPER.length; u++) {
      const b = UPPER[u];
      blend4(kq, b, kcA, wcalmA, kcB, wcalmB, st[0], wA, st[1], wB, L, b * 4);
    }
    const wl = (1 - crouch) * (1 - wsS), wr = (1 - crouch) * wsS;
    for (let u = 0; u < LOWER.length; u++) {
      const b = LOWER[u];
      blend4(kq, b, K.STAND_L, wl, K.STAND_R, wr, K.CROUCH, crouch, 0, 0, L, b * 4);
    }
    const hx = kh[K.STAND_L * 3] * wl + kh[K.STAND_R * 3] * wr + kh[K.CROUCH * 3] * crouch;
    const hy = kh[K.STAND_L * 3 + 1] * wl + kh[K.STAND_R * 3 + 1] * wr + kh[K.CROUCH * 3 + 1] * crouch + lift;
    const hz = kh[K.STAND_L * 3 + 2] * wl + kh[K.STAND_R * 3 + 2] * wr + kh[K.CROUCH * 3 + 2] * crouch;
    // head: follow the racer (inside the fan's own frame), else glance around now and then
    let ly = Math.sin(tt * 0.23 + ph * 1.7) * 0.35 * (1 - e * 0.6), lp = -0.04 * e;
    if (this.lively) {
      ly = (Math.sin(tt * 0.41 + ph * 1.7) * 0.42 + Math.sin(tt * 0.17 + ph * 4.3) * 0.3) * (1 - e * 0.6);
      if (act === 1) { ly = ly * (1 - actW) + side * 0.95 * actW; lp += 0.1 * Math.max(0, Math.sin(tt * 2.3 + ph * 3)) ** 8 * actW; }
      else if (act === 2 || act === 3) ly *= 1 - actW;
    }
    if (pl) {
      const px = pl.x - this.pos[i * 3], pz = pl.z - this.pos[i * 3 + 2], py = pl.y + 1.2 - this.pos[i * 3 + 1] - 0.6;
      const d = Math.sqrt(px * px + pz * pz);
      if (d < 70) {
        const cy = Math.cos(-this.yaw[i]), sy = Math.sin(-this.yaw[i]);
        const lx = px * cy + pz * sy, lz = -px * sy + pz * cy; // fan frame: +z forward, +x left
        const ty = Math.atan2(lx, lz);
        if (Math.abs(ty) < 2.1) {
          const k = smoothstep(70, 40, d);
          ly = ly + (Math.max(-1.1, Math.min(1.1, ty)) - ly) * k;
          lp = lp + (Math.max(-0.35, Math.min(0.4, -Math.atan2(py, d))) - lp) * k;
        }
      }
    }
    const kL = Math.min(1, dt * 4);
    this.lookY[i] += (ly - this.lookY[i]) * kL; this.lookP[i] += (lp - this.lookP[i]) * kL;
    const pq = this.propQuat(i, e, osc, th, tt);
    composeRow(kit, L, hx, hy, hz, this.lookY[i], this.lookP[i], pq, this.pal, i * ROW * 4, this.W, this.Pw);
  }
}

// (FanCrowd.prototype) the hand-held prop's orientation in the fan's model space, or null without a prop
FanCrowd.prototype.propQuat = function (i, e, osc, th, tt) {
  const o = (i * ROW + NB * 3) * 4, prop = this.pal[o + 3], ph = this.phase[i];
  if (prop === 1) {
    // calm: stick upright, the limp cloth to the outside and back (never in front of a face); cheering: waved
    // overhead from side to side, the cloth trailing
    const sway = (osc - 0.5) * e, k = e * e * (3 - 2 * e);
    this.pal[o + 6] = e; // flag flutter (vertex shader)
    return quatEuler(0.06 + 0.06 * k, -2.1 + 1.6 * k + sway * 1.6, -sway * 0.75 - 0.05, this.tmp);
  }
  if (prop === 2) { // the bell swings with the shaking hand (and a little when calm)
    const ring = Math.sin(th - 1.3) * e;
    return quatEuler(ring * 0.65 + 0.05 * Math.sin(tt * 1.3 + ph), 0.2, ring * 0.25, this.tmp);
  }
  return null;
};

// ------------------------------------------------------------------ people who move (FanCrowd.dynamic)
/** Moves person i: feet at (x, y, z), facing yaw (atan2 of the forward direction's x / z). */
FanCrowd.prototype.setPlace = function (i, x, y, z, yaw) {
  const m = this.mat, o = i * 16, sx = this.scl[i * 2], sy = this.scl[i * 2 + 1], c = Math.cos(yaw), s = Math.sin(yaw);
  m[o] = c * sx; m[o + 1] = 0; m[o + 2] = -s * sx; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = s * sx; m[o + 9] = 0; m[o + 10] = c * sx; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
  this.pos[i * 3] = x; this.pos[i * 3 + 1] = y + 1; this.pos[i * 3 + 2] = z;
  this.yaw[i] = yaw;
};

// poses (more often than the spectators': people walking or talking every frame near, every 2nd / 3rd further
// out), instance buffers every frame (they move), contact shadows under them
FanCrowd.prototype.updateDyn = function (dt, c) {
  const n = this.n, D = this.dyn, t = c.time;
  for (let i = 0; i < n; i++) {
    if (this.lod[i] < 0) continue;
    if (this.rag[i]) continue; // (knocked over: the rig's fall poses it, poseFromRig)
    if (!this.inView[i]) { this.stale[i] = 1; continue; }
    const l = this.lod[i];
    const busy = D.walk[i] > 0.02 || D.talk[i] > 0.04 || (D.holdW[i] > 0.02 && D.holdW[i] < 0.98);
    const every = (l === 0 ? 1 : l === 1 ? 2 : this.dist[i] > 110 ? 4 : 3) * (busy ? 1 : 2);
    if (this.stale[i] || (this.frame + i) % every === 0) { this.poseDyn(i, t, dt * every); this.stale[i] = 0; }
  }
  this.tex.needsUpdate = true;
  const lists = this.lists, cnt = this.cnt, shadowsOn = this.shadows && c.shadows;
  for (let k = 0; k < this.kits.length; k++) for (let l = 0; l < 3; l++) {
    const mesh = this.meshes[k][l], L = lists[k * 3 + l], m = cnt[k * 3 + l];
    mesh.count = m;
    mesh.visible = m > 0;
    mesh.castShadow = shadowsOn && l < 2;
    if (!m) continue;
    const im = mesh.instanceMatrix.array, sl = mesh.userData.slot.array;
    for (let j = 0; j < m; j++) {
      const i = L[j * 2];
      im.set(this.mat.subarray(i * 16, i * 16 + 16), j * 16);
      sl[j * 2] = i; sl[j * 2 + 1] = L[j * 2 + 1];
    }
    mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, m * 16); mesh.instanceMatrix.needsUpdate = true;
    const sa = mesh.userData.slot; sa.clearUpdateRanges(); sa.addUpdateRange(0, m * 2); sa.needsUpdate = true;
  }
  {
    // contact shadows follow the people (shrinking as they fade out; none under the ones off stage)
    const bm = this.blobs.instanceMatrix.array;
    for (let i = 0; i < n; i++) {
      const o = i * 16, a = this.lod[i] < 0 ? 0 : D.alpha[i], k = this.scl[i * 2] * a, m = this.mat;
      const cs = m[o] / (this.scl[i * 2] || 1), sn = m[o + 8] / (this.scl[i * 2] || 1);
      bm[o] = 1.3 * k * cs; bm[o + 1] = 0; bm[o + 2] = -1.3 * k * sn; bm[o + 3] = 0;
      bm[o + 4] = 0; bm[o + 5] = a; bm[o + 6] = 0; bm[o + 7] = 0;
      bm[o + 8] = k * sn; bm[o + 9] = 0; bm[o + 10] = k * cs; bm[o + 11] = 0;
      bm[o + 12] = m[o + 12]; bm[o + 13] = m[o + 13] + 0.025; bm[o + 14] = m[o + 14]; bm[o + 15] = 1;
    }
    this.blobs.instanceMatrix.needsUpdate = true;
  }
};

// (Oct 31 2026, the user: "on single player the bot getting hit just falls over, that's a very bad animation. Use the
// same animation as in multiplayer on real people") Somebody knocked over by a car is posed by a SkierRig built on
// the same character model (game/peoplehits.js crowdFall): the player's own wipeout poses (poseFall, placeFallen:
// thrown, tumbling, sprawled on the snow, rolling over and pushing up), as a remote player's avatar shows them. Its
// bones, taken in the rig's root frame (the model space here: metres, feet at 0, facing +z), become person i's row of
// skinning matrices; the instance matrix is the rig root's place (setPlace). The prop hides meanwhile.
// rig: a SkierRig made from kitOf(i).root, posed this frame; off: true hands the person back to poseDyn.
const _rgM = new THREE.Matrix4(), _rgI = new THREE.Matrix4(), _rgP = new THREE.Vector3(), _rgQ = new THREE.Quaternion(), _rgS = new THREE.Vector3();
FanCrowd.prototype.kitOf = function (i) { return this.kits[this.kit[i]]; };
FanCrowd.prototype.poseFromRig = function (i, rig, off = false) {
  if (off) { this.rag[i] = 0; this.stale[i] = 1; return; }
  const kit = this.kits[this.kit[i]], Q0i = kit.Q0i, P0 = kit.P0, pal = this.pal, o = i * ROW * 4;
  const bones = (rig._fanBones ??= (() => { const m = {}; rig.body.traverse((b) => { if (b.isBone && b.name in BI) m[b.name] = b; }); /* (the last of a name, as the rig's own) */ return BONE_NAMES.map((n) => m[n]); })());
  if (bones.some((b) => !b)) return;
  rig.root.updateMatrixWorld(true);
  _rgI.copy(rig.root.matrixWorld).invert();
  for (let b = 0; b < NBA; b++) {
    _rgM.multiplyMatrices(_rgI, bones[b].matrixWorld).decompose(_rgP, _rgQ, _rgS);
    const x = _rgQ.x, y = _rgQ.y, z = _rgQ.z, w = _rgQ.w, bo = b * 4, bx = Q0i[bo], by = Q0i[bo + 1], bz = Q0i[bo + 2], bw = Q0i[bo + 3];
    writeSkin(pal, o + b * 12, w * bx + x * bw + y * bz - z * by, w * by - x * bz + y * bw + z * bx, w * bz + x * by - y * bx + z * bw, w * bw - x * bx - y * by - z * bz,
      _rgP.x, _rgP.y, _rgP.z, P0[b * 3], P0[b * 3 + 1], P0[b * 3 + 2]);
    if (b === BI.RightHand && kit.G) writeSkin(pal, o + PROP * 12, 0, 0, 0, 1, _rgP.x, _rgP.y, _rgP.z, kit.G.x, kit.G.y, kit.G.z);
  }
  pal[(i * ROW + NB * 3) * 4 + 3] = 0; // (no prop: poseDyn puts the carried skis back)
  this.rag[i] = 1;
  this.tex.needsUpdate = true;
};

const _ks = new Int32Array(12), _ws = new Float32Array(12);
// one moving person's skeleton: legs walking (two neighbouring baked phases of the cycle) or standing (weight
// shifting from leg to leg), arms swinging / at rest / gesturing while talking / holding something, the head
// turned where the simulation wants it (with small glances and nods of its own)
FanCrowd.prototype.poseDyn = function (i, t, dt) {
  const kit = this.kits[this.kit[i]], kq = kit.kq, kh = kit.kh, D = this.dyn, L = this.L;
  const ph = this.phase[i], tt = t * this.rate[i];
  const walk = D.walk[i], stand = 1 - walk;
  const wp = (((D.wph[i] % 1) + 1) % 1) * NWALK, j0 = Math.floor(wp) % NWALK, j1 = (j0 + 1) % NWALK, f = wp - Math.floor(wp);
  const ws = 0.5 + 0.5 * Math.sin(tt * 0.52 + ph), wsS = ws * ws * (3 - 2 * ws);
  let nk = 0;
  const add = (k, w) => { if (w > 0.001) { _ks[nk] = k; _ws[nk] = w; nk++; } };
  // lower body
  add(K.WALK0 + j0, walk * (1 - f)); add(K.WALK0 + j1, walk * f);
  add(K.STAND_L, stand * (1 - wsS)); add(K.STAND_R, stand * wsS);
  for (let u = 0; u < LOWER.length; u++) blendN(kq, LOWER[u], _ks, _ws, nk, L, LOWER[u] * 4);
  let hx = 0, hy = 0, hz = 0, sw = 0;
  for (let k = 0; k < nk; k++) { const o = _ks[k] * 3, w = _ws[k]; hx += kh[o] * w; hy += kh[o + 1] * w; hz += kh[o + 2] * w; sw += w; }
  hx /= sw; hy /= sw; hz /= sw;
  // upper body
  const hold = D.hold[i], holdW = hold ? D.holdW[i] : 0, free = 1 - holdW;
  const talk = D.talk[i] * stand;
  nk = 0;
  add(K.WALK0 + j0, walk * (1 - f) * free); add(K.WALK0 + j1, walk * f * free);
  const calmK = this.calm[i], calm = stand * free * (1 - talk * 0.85);
  add(calmK || K.STAND_L, calm * (calmK ? 1 : 1 - wsS)); if (!calmK) add(K.STAND_R, calm * wsS);
  if (talk > 0.001) {
    // gestures come and go in their own rhythm (a speaker's hands are seldom still, a listener's seldom move)
    const g1 = Math.max(0, Math.sin(tt * 0.83 + ph * 3.1)) ** 2, g2 = Math.max(0, Math.sin(tt * 0.61 + ph * 5.3 + 2)) ** 2;
    const g3 = Math.max(0, Math.sin(tt * 1.07 + ph * 7.7 + 4)) ** 2, g4 = Math.max(0, Math.sin(tt * 0.37 + ph * 2.3 + 1)) ** 6 * 0.7;
    const gs = g1 + g2 + g3 + g4 + 0.5, k = talk * stand * free * 0.85 / gs;
    add(K.TALK_A, g1 * k); add(K.TALK_B, g2 * k); add(K.TALK_C, g3 * k); add(K.SHRUG, g4 * k);
    _ws[nk] = 0.5 * k; _ks[nk] = calmK || K.STAND_L; nk++;
  }
  if (holdW > 0.001) add(hold, holdW);
  if (nk === 0) add(K.STAND_L, 1);
  const carry = D.carry[i];
  for (let u = 0; u < UPPER.length; u++) {
    const b = UPPER[u];
    if (carry && (b === BI.RightShoulder || b === BI.RightArm || b === BI.RightForeArm || b === BI.RightHand)) blend4(kq, b, K.CARRY, 1, 0, 0, 0, 0, 0, 0, L, b * 4);
    else blendN(kq, b, _ks, _ws, nk, L, b * 4);
  }
  // head: where the simulation looks, small glances while standing, nods while in a conversation
  let ly = D.lookY[i] + stand * (Math.sin(tt * 0.31 + ph * 1.7) * 0.22 + Math.sin(tt * 0.13 + ph * 4.1) * 0.18) * (1 - D.talk[i] * 0.7);
  let lp = D.lookP[i];
  if (D.talk[i] > 0.02) lp += 0.16 * Math.max(0, Math.sin(tt * 2.3 + ph * 3)) ** 8 * (1.2 - talk);
  const kL = Math.min(1, dt * 4);
  this.lookY[i] += (ly - this.lookY[i]) * kL; this.lookP[i] += (lp - this.lookP[i]) * kL;
  this.pal[(i * ROW + NB * 3) * 4 + 3] = carry ? 3 : 0; // (the skis show with the carry)
  composeRow(kit, L, hx, hy, hz, this.lookY[i], this.lookP[i], carry ? kit.carryArr : null, this.pal, i * ROW * 4, this.W, this.Pw);
};

// normalized weighted sum of nk keyframe quaternions of bone b
function blendN(kq, b, ks, ws, nk, out, o) {
  let x = 0, y = 0, z = 0, w = 0;
  for (let k = 0; k < nk; k++) { const j = (ks[k] * NBA + b) * 4, wk = ws[k]; x += kq[j] * wk; y += kq[j + 1] * wk; z += kq[j + 2] * wk; w += kq[j + 3] * wk; }
  const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; out[o + 3] = w / l;
}

// normalized weighted sum of up to four keyframe quaternions of bone b (all in one hemisphere)
function blend4(kq, b, k0, w0, k1, w1, k2, w2, k3, w3, out, o) {
  let x = 0, y = 0, z = 0, w = 0;
  if (w0 > 0) { const j = (k0 * NBA + b) * 4; x += kq[j] * w0; y += kq[j + 1] * w0; z += kq[j + 2] * w0; w += kq[j + 3] * w0; }
  if (w1 > 0) { const j = (k1 * NBA + b) * 4; x += kq[j] * w1; y += kq[j + 1] * w1; z += kq[j + 2] * w1; w += kq[j + 3] * w1; }
  if (w2 > 0) { const j = (k2 * NBA + b) * 4; x += kq[j] * w2; y += kq[j + 1] * w2; z += kq[j + 2] * w2; w += kq[j + 3] * w2; }
  if (w3 > 0) { const j = (k3 * NBA + b) * 4; x += kq[j] * w3; y += kq[j + 1] * w3; z += kq[j + 2] * w3; w += kq[j + 3] * w3; }
  const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; out[o + 3] = w / l;
}

function quatEuler(ax, ay, az, out) { // rotation Y * X * Z (yaw, then pitch, then roll)
  const cx = Math.cos(ax / 2), sx = Math.sin(ax / 2), cy = Math.cos(ay / 2), sy = Math.sin(ay / 2), cz = Math.cos(az / 2), sz = Math.sin(az / 2);
  // qy * qx
  const x1 = cy * sx, y1 = sy * cx, z1 = -sy * sx, w1 = cy * cx;
  // * qz
  out[0] = x1 * cz + y1 * sz; out[1] = y1 * cz - x1 * sz; out[2] = w1 * sz + z1 * cz; out[3] = w1 * cz - z1 * sz;
  return out;
}

// chain the local rotations into model-space bones and write the skinning matrices (3 texels each)
const LOOK_SPLIT = { 3: 0.15, 4: 0.4, 5: 0.5 }; // Spine (chest), neck, Head share of the head turn
function composeRow(kit, L, hx, hy, hz, lookY, lookP, pq, pal, o, W, Pw) {
  const par = kit.parent, O = kit.O, P0 = kit.P0, Q0i = kit.Q0i;
  for (let b = 0; b < NBA; b++) {
    const bo = b * 4;
    let lx = L[bo], ly = L[bo + 1], lz = L[bo + 2], lw = L[bo + 3];
    let wx, wy, wz, ww, px, py, pz;
    if (b === 0) { wx = lx; wy = ly; wz = lz; ww = lw; px = hx; py = hy; pz = hz; } else {
      const p = par[b] * 4, ax = W[p], ay = W[p + 1], az = W[p + 2], aw = W[p + 3];
      wx = aw * lx + ax * lw + ay * lz - az * ly;
      wy = aw * ly - ax * lz + ay * lw + az * lx;
      wz = aw * lz + ax * ly - ay * lx + az * lw;
      ww = aw * lw - ax * lx - ay * ly - az * lz;
      // position: parent + parent rotation * offset
      const oo = b * 3, vx = O[oo], vy = O[oo + 1], vz = O[oo + 2];
      const tx = 2 * (ay * vz - az * vy), ty = 2 * (az * vx - ax * vz), tz = 2 * (ax * vy - ay * vx);
      const pp = par[b] * 3;
      px = Pw[pp] + vx + aw * tx + (ay * tz - az * ty);
      py = Pw[pp + 1] + vy + aw * ty + (az * tx - ax * tz);
      pz = Pw[pp + 2] + vz + aw * tz + (ax * ty - ay * tx);
      const share = LOOK_SPLIT[b];
      if (share) { // pre-rotate about the model's up (yaw) and right (pitch) axes, around this joint
        const a = lookY * share * 0.5, c = lookP * share * 0.5;
        const sy = Math.sin(a), cy = Math.cos(a), sp = Math.sin(c), cp = Math.cos(c);
        const qx = cy * sp, qy = sy * cp, qz = -sy * sp, qw = cy * cp; // Ry * Rx
        const nx = qw * wx + qx * ww + qy * wz - qz * wy;
        const ny = qw * wy - qx * wz + qy * ww + qz * wx;
        const nz = qw * wz + qx * wy - qy * wx + qz * ww;
        const nw = qw * ww - qx * wx - qy * wy - qz * wz;
        wx = nx; wy = ny; wz = nz; ww = nw;
      }
    }
    W[bo] = wx; W[bo + 1] = wy; W[bo + 2] = wz; W[bo + 3] = ww;
    Pw[b * 3] = px; Pw[b * 3 + 1] = py; Pw[b * 3 + 2] = pz;
    // skin: R = W * Q0^-1, t = P - R * P0
    const bx = Q0i[bo], by = Q0i[bo + 1], bz = Q0i[bo + 2], bw = Q0i[bo + 3];
    writeSkin(pal, o + b * 12,
      ww * bx + wx * bw + wy * bz - wz * by, ww * by - wx * bz + wy * bw + wz * bx, ww * bz + wx * by - wy * bx + wz * bw, ww * bw - wx * bx - wy * by - wz * bz,
      px, py, pz, P0[b * 3], P0[b * 3 + 1], P0[b * 3 + 2]);
  }
  // the prop: at the right hand's grip, its own orientation
  const h = BI.RightHand * 4, ax = W[h], ay = W[h + 1], az = W[h + 2], aw = W[h + 3];
  const g = kit.gripLocal, tx = 2 * (ay * g.z - az * g.y), ty = 2 * (az * g.x - ax * g.z), tz = 2 * (ax * g.y - ay * g.x);
  const gx = Pw[BI.RightHand * 3] + g.x + aw * tx + (ay * tz - az * ty);
  const gy = Pw[BI.RightHand * 3 + 1] + g.y + aw * ty + (az * tx - ax * tz);
  const gz = Pw[BI.RightHand * 3 + 2] + g.z + aw * tz + (ax * ty - ay * tx);
  if (pq === CARRY_MARK && kit.carryRel) {
    // carried skis: rigid on the posed chest (rotation = chest * carryRel, resting point on the shoulder)
    const c = BI.Spine * 4, cx = W[c], cy = W[c + 1], cz = W[c + 2], cw = W[c + 3], r = kit.carryRel;
    const qx = cw * r[0] + cx * r[3] + cy * r[2] - cz * r[1], qy = cw * r[1] - cx * r[2] + cy * r[3] + cz * r[0];
    const qz = cw * r[2] + cx * r[1] - cy * r[0] + cz * r[3], qw = cw * r[3] - cx * r[0] - cy * r[1] - cz * r[2];
    const A = kit.carryAnchor, rot = (qx2, qy2, qz2, qw2, v, k) => { // component k of quaternion * v
      const ux = 2 * (qy2 * v.z - qz2 * v.y), uy = 2 * (qz2 * v.x - qx2 * v.z), uz = 2 * (qx2 * v.y - qy2 * v.x);
      return k === 0 ? v.x + qw2 * ux + (qy2 * uz - qz2 * uy) : k === 1 ? v.y + qw2 * uy + (qz2 * ux - qx2 * uz) : v.z + qw2 * uz + (qx2 * uy - qy2 * ux);
    };
    const S = BI.Spine * 3;
    const ax2 = Pw[S] + rot(cx, cy, cz, cw, A, 0), ay2 = Pw[S + 1] + rot(cx, cy, cz, cw, A, 1), az2 = Pw[S + 2] + rot(cx, cy, cz, cw, A, 2);
    const tx2 = ax2 - rot(qx, qy, qz, qw, CARRY_REST, 0), ty2 = ay2 - rot(qx, qy, qz, qw, CARRY_REST, 1), tz2 = az2 - rot(qx, qy, qz, qw, CARRY_REST, 2);
    writeSkin(pal, o + PROP * 12, qx, qy, qz, qw, tx2, ty2, tz2, kit.G.x, kit.G.y, kit.G.z);
  } else if (pq) writeSkin(pal, o + PROP * 12, pq[0], pq[1], pq[2], pq[3], gx, gy, gz, kit.G.x, kit.G.y, kit.G.z);
  else writeSkin(pal, o + PROP * 12, 0, 0, 0, 1, gx, gy, gz, kit.G.x, kit.G.y, kit.G.z);
}
function writeSkin(pal, o, x, y, z, w, px, py, pz, rx, ry, rz) {
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const m00 = 1 - 2 * (yy + zz), m01 = 2 * (xy - wz), m02 = 2 * (xz + wy);
  const m10 = 2 * (xy + wz), m11 = 1 - 2 * (xx + zz), m12 = 2 * (yz - wx);
  const m20 = 2 * (xz - wy), m21 = 2 * (yz + wx), m22 = 1 - 2 * (xx + yy);
  pal[o] = m00; pal[o + 1] = m01; pal[o + 2] = m02; pal[o + 3] = px - (m00 * rx + m01 * ry + m02 * rz);
  pal[o + 4] = m10; pal[o + 5] = m11; pal[o + 6] = m12; pal[o + 7] = py - (m10 * rx + m11 * ry + m12 * rz);
  pal[o + 8] = m20; pal[o + 9] = m21; pal[o + 10] = m22; pal[o + 11] = pz - (m20 * rx + m21 * ry + m22 * rz);
}

let blobGeo = null;
function blobGeometry() {
  if (!blobGeo) { blobGeo = new THREE.PlaneGeometry(1, 1); blobGeo.rotateX(-Math.PI / 2); }
  return blobGeo;
}
function blobMaterial(strength) {
  return new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: strength }, uTint: { value: new THREE.Color(0.1, 0.13, 0.22) } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying float vDist;
      void main() {
        vUv = uv;
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        vec4 mv = modelViewMatrix * p;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uStrength;
      uniform vec3 uTint;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        float r = min(1.0, length(vUv * 2.0 - 1.0));
        float a = pow(1.0 - r * r, 2.2) * (0.45 + 0.55 * (1.0 - smoothstep(0.0, 0.4, r))); // dark core under the boots
        a *= uStrength * (1.0 - smoothstep(45.0, 90.0, vDist));
        gl_FragColor = vec4(mix(vec3(1.0), uTint, a), 1.0);
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,       // snow x tint
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
}

function push(lists, cnt, li, i, f) { const L = lists[li], j = cnt[li]++ * 2; L[j] = i; L[j + 1] = f; }
function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
