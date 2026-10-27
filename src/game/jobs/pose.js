// Bone-level helpers for job people and the parcel on your back. The game's skier rig poses everyone
// procedurally; the few static poses it has no mode for (a skier sitting hurt in the snow) are finished
// here with the same tools: world-space bone rotations and an exact two-bone IK. The skinned mesh is
// sampled where the GPU really draws it, so contact with the snow and the jacket's back are measured
// on the character's own mesh instead of guessed from its bones.
import * as THREE from 'three';
import { world } from '../../world/world.js';

const _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _k = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3(), _e = new THREE.Vector3(), _end = new THREE.Vector3();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function worldPos(o, out) { return out.setFromMatrixPosition(o.matrixWorld); }
export function worldQuat(o, out) { o.matrixWorld.decompose(_p, out, _s); return out; }
export function setWorldQuat(bone, q) {
  worldQuat(bone.parent, _q3);
  bone.quaternion.copy(_q3.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
export function rotateWorld(bone, axis, angle) {
  worldQuat(bone, _q2);
  _q1.setFromAxisAngle(axis, angle).multiply(_q2);
  setWorldQuat(bone, _q1);
}
// turn `bone` (pivoting at `pivot`) so the point `from` moves onto the ray toward `to`
export function aimBone(bone, from, to, pivot) {
  const u = _u.subVectors(from, pivot), w = _w.subVectors(to, pivot);
  if (u.lengthSq() < 1e-10 || w.lengthSq() < 1e-10) return;
  u.normalize(); w.normalize();
  _q1.setFromUnitVectors(u, w);
  worldQuat(bone, _q2);
  setWorldQuat(bone, _q1.multiply(_q2));
}
// Exact two-bone IK (upper a, middle b, end c): the middle joint bends toward `pole`.
export function solveTwoBone(a, b, c, target, pole) {
  const pa = worldPos(a, _a), pb = worldPos(b, _b), pc = worldPos(c, _c);
  const lab = pa.distanceTo(pb), lbc = pb.distanceTo(pc);
  const dir = _d.subVectors(target, pa);
  const dist = clamp(dir.length(), Math.abs(lab - lbc) + 1e-3, (lab + lbc) * 0.9995);
  dir.normalize();
  const cosA = clamp((lab * lab + dist * dist - lbc * lbc) / (2 * lab * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const pp = _e.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (pp.lengthSq() < 1e-8) pp.set(0, 1, 0).addScaledVector(dir, -dir.y);
  pp.normalize();
  const knee = _k.copy(pa).addScaledVector(dir, lab * cosA).addScaledVector(pp, lab * sinA);
  aimBone(a, pb, knee, pa);
  worldPos(b, pb); worldPos(c, pc);
  aimBone(b, pc, _end.copy(pa).addScaledVector(dir, dist), pb);
}

// ------------------------------------------------------------------ the rendered snow surface
// Height of the terrain mesh as drawn near the player (2 m triangles). The grid heights around one spot
// are sampled once (a body or a pack checks thousands of skin points against a handful of them).
const STEP = 2, WIN = 5;
export class SnowPatch {
  /** @param {number} x, z  centre of the patch (heights within ~4 m come from a small table) */
  constructor(x = 0, z = 0) {
    this.gx0 = Math.floor(x / STEP) - 2; this.gz0 = Math.floor(z / STEP) - 2;
    this.H = new Float64Array(WIN * WIN).fill(NaN);
    this.far = new Map();
  }
  h(gx, gz) {
    const i = gx - this.gx0, j = gz - this.gz0;
    if (i >= 0 && j >= 0 && i < WIN && j < WIN) {
      const k = j * WIN + i;
      let v = this.H[k];
      if (v !== v) v = this.H[k] = world.height(gx * STEP, gz * STEP);
      return v;
    }
    const k = gx * 100003 + gz;
    let v = this.far.get(k);
    if (v === undefined) { v = world.height(gx * STEP, gz * STEP); this.far.set(k, v); }
    return v;
  }
  at(x, z) {
    const fx = x / STEP, fz = z / STEP, gx = Math.floor(fx), gz = Math.floor(fz);
    const u = fx - gx, v = fz - gz;
    const a = this.h(gx, gz), b = this.h(gx + 1, gz), c = this.h(gx, gz + 1);
    if (u + v < 1) return a + (b - a) * u + (c - a) * v;
    const d = this.h(gx + 1, gz + 1);
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
}

// ------------------------------------------------------------------ skinned mesh sampling
// Plain readers for (possibly quantized, possibly interleaved) vertex attributes: element (i, c) is
// a[i * n + o + c] * s.
function reader(attr) {
  if (!attr) return null;
  const inter = !!attr.isInterleavedBufferAttribute;
  const a = inter ? attr.data?.array : attr.array;
  if (!a) return null;
  let s = 1;
  if (attr.normalized) {
    if (a instanceof Int8Array) s = 1 / 127; else if (a instanceof Uint8Array) s = 1 / 255;
    else if (a instanceof Int16Array) s = 1 / 32767; else if (a instanceof Uint16Array) s = 1 / 65535;
  }
  return { a, n: inter ? attr.data.stride : attr.itemSize, o: inter ? attr.offset : 0, s };
}
const comp = (r, i, c) => r.a[i * r.n + r.o + c] * r.s;

// Vertex lists of a body region (vertices mostly skinned to the given bones), cached per geometry:
// one pass over the mesh the first time a character is measured, never again.
const regionCache = new WeakMap();
export function regionVerts(mesh, bones, key, stride = 1, minW = 0.5) {
  const g = mesh.geometry;
  let m = regionCache.get(g);
  if (!m) regionCache.set(g, (m = new Map()));
  const k = `${key}/${stride}/${minW}`;
  let list = m.get(k);
  if (list) return list;
  const all = mesh.skeleton.bones, ids = new Uint8Array(Math.max(256, all.length));
  for (const b of bones) { const i = all.indexOf(b); if (b && i >= 0) ids[i] = 1; }
  const si = reader(g.attributes.skinIndex), sw = reader(g.attributes.skinWeight);
  const n = g.attributes.position.count, out = [];
  if (si && sw) {
    for (let i = 0; i < n; i += stride) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (ids[comp(si, i, c)]) w += comp(sw, i, c);
      if (w >= minW) out.push(i);
    }
  }
  list = Int32Array.from(out);
  m.set(k, list);
  return list;
}

// World positions of skinned vertices exactly as three.js skins them on the GPU.
export class SkinSampler {
  constructor(mesh) {
    this.mesh = mesh;
    const g = mesh.geometry;
    this.pos = reader(g.attributes.position);
    this.si = reader(g.attributes.skinIndex);
    this.sw = reader(g.attributes.skinWeight);
    this.B = mesh.skeleton.bones.map(() => new THREE.Matrix4());
    this.ok = !!(this.pos && this.si && this.sw);
    this.v = new THREE.Vector3(); this.t = new THREE.Vector3();
  }
  // bone matrices for the pose the rig has right now (call after posing, once per batch)
  refresh() {
    const m = this.mesh, sk = m.skeleton;
    const detached = m.bindMode === 'detached';
    for (let i = 0; i < sk.bones.length; i++) {
      const B = this.B[i].multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]).multiply(m.bindMatrix);
      if (detached) B.premultiply(_mDet.multiplyMatrices(m.matrixWorld, m.bindMatrixInverse));
    }
  }
  vertex(i, out) {
    const P = this.pos, SI = this.si, SW = this.sw, B = this.B;
    const po = i * P.n + P.o, x = P.a[po] * P.s, y = P.a[po + 1] * P.s, z = P.a[po + 2] * P.s;
    const io = i * SI.n + SI.o, wo = i * SW.n + SW.o, wa = SW.a, ws = SW.s, ia = SI.a;
    let ox = 0, oy = 0, oz = 0;
    for (let c = 0; c < 4; c++) {
      const w = wa[wo + c] * ws;
      if (!(w > 0)) continue;
      const e = B[ia[io + c]].elements; // bone matrices are affine
      ox += w * (e[0] * x + e[4] * y + e[8] * z + e[12]);
      oy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]);
      oz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
    out.x = ox; out.y = oy; out.z = oz;
    return out;
  }
  // lowest point of a vertex list over the snow (m)
  lowest(list, snow, out = this.t) {
    let m = Infinity;
    for (let k = 0; k < list.length; k++) { this.vertex(list[k], out); const d = out.y - snow.at(out.x, out.z); if (d < m) m = d; }
    return m;
  }
}
const _mDet = new THREE.Matrix4();

// ------------------------------------------------------------------ the jacket's back (parcel on your back)
// Fits a pack of half-width `hw`, height `h` (centred `yc` m along the spine from the chest bone) onto the
// back of the posed mesh: the back surface is sampled over the pack's footprint, a few hundred vertices a
// frame, and the pack gets the tilt that hugs it best with its inner face just clear of the jacket
// (a puffy jacket, a hood or a backpack the model already wears are all simply part of the surface).
// Frame (as the rig's own ski carry): up = spine base -> neck, back = -heading across the spine.
export class BackFit {
  constructor(rig, { hw = 0.155, h = 0.4, yc = -0.17, gap = 0.012 } = {}) {
    this.rig = rig; this.hw = hw; this.h = h; this.yc = yc; this.gap = gap;
    const b = rig.b, mesh = rig.skinned;
    this.list = mesh?.skeleton && mesh.geometry?.attributes?.skinIndex
      ? regionVerts(mesh, [b.hips, b.spine0, b.spine1, b.spine2, b.neck, b.lSh, b.rSh], 'back', 2, 0.4) : new Int32Array(0);
    this.S = mesh?.skeleton ? new SkinSampler(mesh) : null;
    this.k = 0;
    const N = this.list.length;
    this.U = new Float32Array(N); this.K = new Float32Array(N); this.X = new Float32Array(N); this.I = new Int32Array(N); this.n = 0;
    this.f = { c: new THREE.Vector3(), up: new THREE.Vector3(), back: new THREE.Vector3(), side: new THREE.Vector3() };
  }
  // the chest frame of the current pose
  frame() {
    const b = this.rig.b, f = this.f, h = this.rig.root.rotation.y;
    this.rig.root.updateMatrixWorld(true);
    worldPos(b.spine2 || b.spine1, f.c);
    f.up.subVectors(worldPos(b.neck, _a), worldPos(b.spine0, _b)).normalize();
    f.back.set(-Math.sin(h), 0, -Math.cos(h)).addScaledVector(f.up, Math.sin(h) * f.up.x + Math.cos(h) * f.up.z).normalize();
    f.side.crossVectors(f.up, f.back).normalize();
    return f;
  }
  // sample up to `budget` vertices; true once the whole back is in
  step(budget = 1500) {
    if (!this.S?.ok) return true;
    this.S.refresh();
    const f = this.frame(), v = _c, L = this.list, end = Math.min(L.length, this.k + budget);
    for (; this.k < end; this.k++) {
      this.S.vertex(L[this.k], v).sub(f.c);
      const x = v.dot(f.side);
      if (Math.abs(x) > this.hw + 0.015) continue;
      const u = v.dot(f.up);
      if (u < this.yc - this.h / 2 - 0.08 || u > this.yc + this.h / 2 + 0.08) continue;
      this.U[this.n] = u; this.K[this.n] = v.dot(f.back); this.X[this.n] = x; this.I[this.n] = L[this.k]; this.n++;
    }
    return this.k >= L.length;
  }
  // { tilt, z0, y } in the chest frame: the pack's up = up cos(t) + back sin(t), out = back cos(t) - up sin(t);
  // inner face centre = y * packUp + z0 * packOut. Null when nothing was measured.
  result() {
    if (this.n < 20) return null;
    const BANDS = 6;
    const top = new Float64Array(BANDS);
    let best = null;
    for (let t = -0.3; t <= 0.3001; t += 0.05) {
      const c = Math.cos(t), s = Math.sin(t);
      const y0 = this.yc * c + 0.22 * s; // the pack's centre stays at about the same height on the back
      top.fill(-Infinity);
      let z0 = -Infinity;
      for (let i = 0; i < this.n; i++) {
        const u = this.U[i], k = this.K[i], y = u * c + k * s, z = k * c - u * s;
        const bi = Math.floor(((y - (y0 - this.h / 2)) / this.h) * BANDS);
        if (bi < 0 || bi >= BANDS) continue;
        if (z > top[bi]) top[bi] = z;
        if (z > z0) z0 = z;
      }
      if (!(z0 > -Infinity)) continue;
      let gap = 0, nb = 0;
      for (let bi = 0; bi < BANDS; bi++) if (top[bi] > -Infinity) { gap += z0 - top[bi]; nb++; }
      const score = (nb ? gap / nb : 1) + Math.abs(t) * 0.04;
      if (!best || score < best.score) best = { score, tilt: t, z0: z0 + this.gap, y: y0 };
    }
    if (best) { best.anchors = this.anchors(best); best.guards = this.guards(best); }
    return best;
  }
  // The outermost point of the jacket in each cell of a grid over the pack's footprint: the pack is
  // pushed out whenever one of them bulges through its inner face (shoulder blades in a tuck).
  guards(fit) {
    const c = Math.cos(fit.tilt), s = Math.sin(fit.tilt), NX = 6, NY = 8, X0 = -0.14, Y0 = -0.2, CW = 0.28 / NX, CH = 0.4 / NY;
    const bz = new Float64Array(NX * NY).fill(-Infinity), bi = new Int32Array(NX * NY).fill(-1);
    for (let i = 0; i < this.n; i++) {
      const y = this.U[i] * c + this.K[i] * s - fit.y, z = this.K[i] * c - this.U[i] * s - fit.z0;
      const gx = Math.floor((this.X[i] - X0) / CW), gy = Math.floor((y - Y0) / CH);
      if (gx < 0 || gy < 0 || gx >= NX || gy >= NY) continue;
      const k = gy * NX + gx;
      if (z > bz[k]) { bz[k] = z; bi[k] = this.I[i]; }
    }
    return Int32Array.from([...bi].filter((v) => v >= 0));
  }
  // Five points of the jacket under the pack (its corners and centre, on the surface), in the pack's
  // frame: the pack follows them, wherever the rig's skinning carries that part of the back.
  anchors(fit) {
    const c = Math.cos(fit.tilt), s = Math.sin(fit.tilt), out = [];
    for (const [tx, ty] of [[-0.09, 0.12], [0.09, 0.12], [-0.09, -0.12], [0.09, -0.12], [0, 0]]) {
      let best = -1, bz = -Infinity;
      for (const r of [0.035, 0.06, 0.1]) {
        for (let i = 0; i < this.n; i++) {
          const y = this.U[i] * c + this.K[i] * s - fit.y, z = this.K[i] * c - this.U[i] * s - fit.z0;
          if (Math.abs(this.X[i] - tx) > r || Math.abs(y - ty) > r) continue;
          if (z > bz) { bz = z; best = i; }
        }
        if (best >= 0) break;
      }
      if (best < 0) return null;
      out.push({ i: this.I[best], x: this.X[best], y: this.U[best] * c + this.K[best] * s - fit.y, z: bz });
    }
    return out;
  }
  // world matrix of the pack (origin: inner face centre; x across the back, y up the pack, z out of it)
  matrix(fit, out) {
    const f = this.frame(), c = Math.cos(fit.tilt), s = Math.sin(fit.tilt);
    const Y = _a.copy(f.up).multiplyScalar(c).addScaledVector(f.back, s);
    const Z = _b.copy(f.back).multiplyScalar(c).addScaledVector(f.up, -s);
    out.makeBasis(f.side, Y, Z);
    out.setPosition(_c.copy(f.c).addScaledVector(Y, fit.y).addScaledVector(Z, fit.z0));
    return out;
  }
}

// The pack riding on the jacket: each frame its anchor vertices are skinned (a handful of points) and the
// pack's frame is rebuilt from them, in the rig root's space (the pack is a child of the root, so it is
// drawn with the root wherever the player has moved it since the rig was posed).
export class PackFollow {
  /** @param {{anchors: object[], guards: Int32Array}} fit */
  constructor(rig, fit) {
    const anchors = fit.anchors;
    this.rig = rig;
    this.a = anchors;
    this.g = fit.guards || new Int32Array(0);
    this.S = new SkinSampler(rig.skinned);
    this.P = anchors.map(() => new THREE.Vector3());
    this.q = new THREE.Vector3();
    this.inv = new THREE.Matrix4();
    this.cur = new THREE.Matrix4();
    // the anchors' own frame in the pack's frame (the same construction as below, on their offsets)
    const O = anchors.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    this.ref = new THREE.Matrix4();
    this.refInv = new THREE.Matrix4();
    this.ok = anchorFrame(O, this.ref);
    if (this.ok) this.refInv.copy(this.ref).invert();
  }
  // the pack's matrix relative to the rig root (false if the anchors collapsed)
  update(out) {
    if (!this.ok) return false;
    const P = this.P, a = this.a, S = this.S;
    S.refresh();
    this.inv.copy(this.rig.root.matrixWorld).invert();
    for (let i = 0; i < a.length; i++) S.vertex(a[i].i, P[i]).applyMatrix4(this.inv);
    if (!anchorFrame(P, this.cur)) return false;
    // pack = (anchors now) * (anchors in the pack's frame)^-1
    out.multiplyMatrices(this.cur, this.refInv);
    // pushed out over any part of the jacket bulging through its inner face
    const e = out.elements, zx = e[8], zy = e[9], zz = e[10], ox = e[12], oy = e[13], oz = e[14];
    let lift = -Infinity;
    for (let k = 0; k < this.g.length; k++) {
      const q = S.vertex(this.g[k], this.q).applyMatrix4(this.inv);
      const z = (q.x - ox) * zx + (q.y - oy) * zy + (q.z - oz) * zz;
      if (z > lift) lift = z;
    }
    if (lift > -0.004) { const d = lift + 0.004; e[12] += zx * d; e[13] += zy * d; e[14] += zz * d; }
    return true;
  }
}
// An orthonormal frame on five anchor points (0..3 = top-left, top-right, bottom-left, bottom-right,
// 4 = centre): x across, y up, z out of the back, origin at their centroid.
function anchorFrame(P, out) {
  const X = _a.subVectors(P[1], P[0]).add(P[3]).sub(P[2]);
  const Y = _b.subVectors(P[0], P[2]).add(P[1]).sub(P[3]);
  if (X.lengthSq() < 1e-6 || Y.lengthSq() < 1e-6) return false;
  X.normalize();
  const Z = _c.crossVectors(X, Y);
  if (Z.lengthSq() < 1e-8) return false;
  Z.normalize();
  Y.crossVectors(Z, X);
  out.makeBasis(X, Y, Z);
  out.setPosition((P[0].x + P[1].x + P[2].x + P[3].x + P[4].x) / 5, (P[0].y + P[1].y + P[2].y + P[3].y + P[4].y) / 5, (P[0].z + P[1].z + P[2].z + P[3].z + P[4].z) / 5);
  return true;
}
