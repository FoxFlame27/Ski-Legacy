// The Wolkenspitzbahn's trains: two-car rack railcars in the line's red, with big panoramic windows (tall side
// windows plus a glazed roof edge, so you look up at the peaks), built procedurally so the inside is as finished
// as the outside: a panorama lounge behind each driver's cab (forward-facing rows looking out through the
// windshield), seat bays with tables, wooden sills, grab rails, LED light strips, destination displays.
// One car = one Group in its own frame: +z forward (toward its cab), +x right, +y up, y = 0 on the top of the
// rails, origin in the car's middle. Materials are shared between all cars. The interior has its own warm
// "cabin light" (baked per vertex from the light strips, scaled at night and in tunnels): no real lights needed.
import * as THREE from 'three';
import { bakeGeometry } from '../core/assets.js';
import { coachSeats, coachSeatMaterials, COACH_SEAT } from './coachseat.js';

export const CAR = {
  len: 17.2, half: 8.6, hw: 1.32, floor: 1.04, winLo: 1.8, winHi: 3.08, roofTop: 3.64,
  bogie: 5.9, gap: 1.0, // bogie centres from the middle; gap between the two cars' end walls
  aisle: 0.31,          // half-width of the aisle
  cabZ: 7.32,           // the cab partition (the cab is beyond it)
};
export const SET_LEN = 2 * CAR.len + CAR.gap;

// livery + interior palette
const RED = '#b0121a', WHITE = '#f2f0eb', BLACK = '#141618', GREY = '#3b3f45', GREY_L = '#8e9399', ROOF = '#a3a8ae';
const STEEL = '#c0c5cb', DARK = '#25282c', RUBBER = '#1b1c1e';
const FAB = '#3e4f68', FAB_D = '#33435a', HEAD = '#d8dce2', SHELL = '#6d737b', FLOOR = '#4a4d52', AISLE = '#62666c';
const PANEL = '#dedcd6', SILL = '#8b5a33', CEIL = '#f3f2ee', TABLE = '#7a4f2c';

// ------------------------------------------------------------------ geometry builder
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Color();
// parsed vertex colours ('#rrggbb' -> linear rgb), cached: a car has tens of thousands of vertices
const COLS = new Map();
function rgb(col) {
  let c = COLS.get(col);
  if (!c) { _c.set(col); c = [_c.r, _c.g, _c.b]; COLS.set(col, c); }
  return c;
}
class GB {
  constructor({ light = false } = {}) {
    this.P = []; this.N = []; this.C = []; this.L = light ? [] : null; this.X = light ? [] : null; this.I = [];
    this.m = new THREE.Matrix4(); this.nm = new THREE.Matrix3(); this.lightFn = null;
    this.tx = 0; // the cabin's surface texture for the next vertices (TX: laminate, fabric, floor, ceiling, metal)
  }
  get count() { return this.P.length / 3; }
  at(x = 0, y = 0, z = 0, yaw = 0, pitch = 0, roll = 0) {
    this.m.compose(_v.set(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')), new THREE.Vector3(1, 1, 1));
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  reset() { this.m.identity(); this.nm.identity(); return this; }
  v(x, y, z, nx, ny, nz, col) {
    _v.set(x, y, z).applyMatrix4(this.m);
    this.P.push(_v.x, _v.y, _v.z);
    _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.N.push(_n.x, _n.y, _n.z);
    const c = rgb(col);
    this.C.push(c[0], c[1], c[2]);
    if (this.L) this.L.push(this.lightFn ? this.lightFn(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z) : 0);
    if (this.X) this.X.push(this.tx);
    return this.P.length / 3 - 1;
  }
  quad(a, b, c, d) { this.I.push(a, b, c, a, c, d); }
  tri(a, b, c) { this.I.push(a, b, c); }
  face(p0, p1, p2, p3, col) {
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const a = this.v(...p0, nx, ny, nz, col), b = this.v(...p1, nx, ny, nz, col), c = this.v(...p2, nx, ny, nz, col), d = this.v(...p3, nx, ny, nz, col);
    this.quad(a, b, c, d);
    return this;
  }
  box(cx, cy, cz, sx, sy, sz, col, colTop = col) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col);
    this.face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col);
    this.face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], colTop);
    this.face([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col);
    this.face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col);
    this.face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col);
    return this;
  }
  // grid surface: rows of points [[x, y, z]...] (all rows the same length), smooth normals
  grid(rows, col, { flip = false, colFn = null } = {}) {
    const R = rows.length, C = rows[0].length, base = this.count;
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
      const p = rows[i][j];
      const pu = rows[i][Math.min(C - 1, j + 1)], pd = rows[i][Math.max(0, j - 1)];
      const pr = rows[Math.min(R - 1, i + 1)][j], pl = rows[Math.max(0, i - 1)][j];
      const a = [pu[0] - pd[0], pu[1] - pd[1], pu[2] - pd[2]], b = [pr[0] - pl[0], pr[1] - pl[1], pr[2] - pl[2]];
      let nx = a[1] * b[2] - a[2] * b[1], ny = a[2] * b[0] - a[0] * b[2], nz = a[0] * b[1] - a[1] * b[0];
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      this.v(p[0], p[1], p[2], nx, ny, nz, colFn ? colFn(i, j, p) : col);
    }
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < C - 1; j++) {
      const a = base + i * C + j, b = a + 1, c = a + C + 1, d = a + C;
      if (flip) this.quad(a, d, c, b); else this.quad(a, b, c, d);
    }
    return this;
  }
  cyl(x, y, z, r, len, seg, col, axis = 'x', caps = true) {
    const base = this.count;
    const pt = (a, t) => { const ca = Math.cos(a) * r, sa = Math.sin(a) * r; return axis === 'x' ? [x + t, y + ca, z + sa] : axis === 'y' ? [x + ca, y + t, z + sa] : [x + ca, y + sa, z + t]; };
    const nn = (a) => { const ca = Math.cos(a), sa = Math.sin(a); return axis === 'x' ? [0, ca, sa] : axis === 'y' ? [ca, 0, sa] : [ca, sa, 0]; };
    for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2, n = nn(a); this.v(...pt(a, -len / 2), ...n, col); this.v(...pt(a, len / 2), ...n, col); }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; if (axis === 'x') this.quad(a, a + 2, a + 3, a + 1); else this.quad(a, a + 1, a + 3, a + 2); }
    if (caps) for (const sgn of [-1, 1]) {
      const n = axis === 'x' ? [sgn, 0, 0] : axis === 'y' ? [0, sgn, 0] : [0, 0, sgn];
      const cc = axis === 'x' ? [x + (sgn * len) / 2, y, z] : axis === 'y' ? [x, y + (sgn * len) / 2, z] : [x, y, z + (sgn * len) / 2];
      const c0 = this.v(...cc, ...n, col), ring = [];
      for (let i = 0; i <= seg; i++) ring.push(this.v(...pt((i / seg) * Math.PI * 2, (sgn * len) / 2), ...n, col));
      for (let i = 0; i < seg; i++) { if ((sgn > 0) === (axis !== 'y')) this.tri(c0, ring[i], ring[i + 1]); else this.tri(c0, ring[i + 1], ring[i]); }
    }
    return this;
  }
  bar(a, b, r, col, seg = 6) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
    if (len < 1e-4) return this;
    const save = this.m.clone(), nsave = this.nm.clone();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    this.m.multiply(new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1)));
    this.nm.getNormalMatrix(this.m);
    this.cyl(0, 0, 0, r, len, seg, col, 'y', false);
    this.m.copy(save); this.nm.copy(nsave);
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (this.L) g.setAttribute('aCabin', new THREE.Float32BufferAttribute(this.L, 1));
    if (this.X) g.setAttribute('aTex', new THREE.Float32BufferAttribute(this.X, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ materials (shared)
// uniforms the railway drives every frame: cabin light (0.3 day .. 1.2 night / tunnel), headlights (0..1)
export const trainUniforms = { uCabin: { value: 0.3 }, uHead: { value: 0 } };
let MATS = null;
function canvasTex(w, h, draw) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
// crisp Meshy textures: anisotropic filtering on every map of a material (the renderer caps it at what the GPU can)
export function crisp(mat) {
  for (const m of [].concat(mat || [])) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
      const t = m?.[k];
      if (t && t.anisotropy !== 16) { t.anisotropy = 16; t.needsUpdate = true; }
    }
  }
  return mat;
}

// thin a geometry by vertex clustering: cells of `cell` m and 1/uvq of the texture (a cell never spans a uv seam,
// so the texture mapping stays exact); degenerate triangles dropped, normals recomputed
export function clusterUV(geo, cell, uvq = 64) {
  const pos = geo.attributes.position, uv = geo.attributes.uv, n = pos.count;
  const remap = new Int32Array(n), cells = new Map(), outP = [], outU = [];
  for (let i = 0; i < n; i++) {
    const key = Math.round(pos.getX(i) / cell) + ',' + Math.round(pos.getY(i) / cell) + ',' + Math.round(pos.getZ(i) / cell)
      + (uv ? ',' + Math.round(uv.getX(i) * uvq) + ',' + Math.round(uv.getY(i) * uvq) : '');
    let j = cells.get(key);
    if (j === undefined) { j = outP.length / 3; cells.set(key, j); outP.push(pos.getX(i), pos.getY(i), pos.getZ(i)); if (uv) outU.push(uv.getX(i), uv.getY(i)); }
    remap[i] = j;
  }
  const idx = geo.index, tri = [], count = idx ? idx.count : n;
  for (let t = 0; t < count; t += 3) {
    const a = remap[idx ? idx.getX(t) : t], b = remap[idx ? idx.getX(t + 1) : t + 1], c = remap[idx ? idx.getX(t + 2) : t + 2];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(outU, 2));
  out.setIndex(tri);
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

// ------------------------------------------------------------------ the Meshy seats (rail_seat_pair)
// The model is a pair of seats with a console between them, facing +z. We keep one seat (the left one: every
// triangle left of the console), squeezed to fit the cabin's narrow 2+2 rows, and instance it on every place.
let SEAT = null;
export const SEAT_CFG = { height: 1.27, squeeze: 0.8 };
export function setSeatModel(gltf) {
  if (!gltf || SEAT) return SEAT;
  const b = bakeGeometry(gltf, { size: SEAT_CFG.height, axis: 'y' });
  if (!b?.geometry) return null;
  let g = b.geometry.index ? b.geometry.toNonIndexed() : b.geometry.clone();
  g.computeBoundingBox();
  const bb = g.boundingBox, W = bb.max.x - bb.min.x, cx0 = (bb.min.x + bb.max.x) / 2, cut = cx0 - W * 0.09;
  const pos = g.attributes.position, keep = [];
  for (let t = 0; t < pos.count; t += 3) {
    const xc = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    if (xc < cut) keep.push(t);
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const isz = attr.itemSize, arr = new Float32Array(keep.length * 3 * isz);
    let o = 0;
    for (const t of keep) for (let v = 0; v < 3; v++) for (let k = 0; k < isz; k++) arr[o++] = attr.getComponent(t + v, k);
    out.setAttribute(name, new THREE.BufferAttribute(arr, isz, attr.normalized));
  }
  out.computeBoundingBox();
  const ob = out.boundingBox;
  // centred on its own footprint, squeezed across, the cushion's top 0.49 m over the floor (the model stands at y 0)
  out.translate(-(ob.min.x + ob.max.x) / 2, 0, -(ob.min.z + ob.max.z) / 2);
  out.scale(SEAT_CFG.squeeze, 1, 1);
  const thin = clusterUV(out, 0.011, 96);
  const mat = crisp(b.material.clone());
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCabin = trainUniforms.uCabin;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uCabin;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.68) * 0.55 * uCabin;`);
  };
  mat.customProgramCacheKey = () => 'rail-seat';
  SEAT = { geo: thin, mat, width: (ob.max.x - ob.min.x) * SEAT_CFG.squeeze, depth: ob.max.z - ob.min.z };
  return SEAT;
}

// the coach seats' materials (coachseat.js) with the cabin's warm self-light, shared by every car
let SEAT_MATS = null;
function seatMaterials() {
  if (SEAT_MATS) return SEAT_MATS;
  SEAT_MATS = coachSeatMaterials();
  for (const [k, mat] of Object.entries(SEAT_MATS)) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uCabin = trainUniforms.uCabin;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uCabin;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.68) * 0.55 * uCabin;`);
    };
    mat.customProgramCacheKey = () => `rail-coach-seat-${k}`;
  }
  return SEAT_MATS;
}

// ------------------------------------------------------------------ the Meshy railcar (rail_car2), outside views
// The model (cab at its -x end) is stretched to our car's body: 17.2 m long, 2.64 m wide, its roof equipment
// included about 3.4 m tall, standing on our bogies; everything under its skirt (its own bogie blobs) is trimmed.
let BODY = null;
export const BODY_CFG = { trim: 0.075, height: 3.42, base: 0.48 };
export function setCarModel(gltf) {
  if (!gltf || BODY) return BODY;
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  gltf.scene.updateMatrixWorld(true);
  let g = mesh.geometry.clone();
  // (meshopt-quantized positions: three dequantizes through the attribute accessors below)
  g.applyMatrix4(mesh.matrixWorld);
  if (g.index) g = g.toNonIndexed();
  g.computeBoundingBox();
  const bb = g.boundingBox, Hm = bb.max.y - bb.min.y, cut = bb.min.y + Hm * BODY_CFG.trim;
  const pos = g.attributes.position, keep = [];
  for (let t = 0; t < pos.count; t += 3) {
    const yc = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    if (yc > cut) keep.push(t);
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const isz = attr.itemSize, arr = new Float32Array(keep.length * 3 * isz);
    let o = 0;
    for (const t of keep) for (let v = 0; v < 3; v++) for (let k = 0; k < isz; k++) arr[o++] = attr.getComponent(t + v, k);
    out.setAttribute(name, new THREE.BufferAttribute(arr, isz, name === 'position' || name === 'normal' ? false : attr.normalized));
  }
  out.computeBoundingBox();
  const ob = out.boundingBox;
  const L = ob.max.x - ob.min.x, Wd = ob.max.z - ob.min.z, Ht = ob.max.y - ob.min.y;
  // centre, then: length along +z with the cab at +z (model -x -> +z), width 2.64, height BODY_CFG.height
  out.translate(-(ob.min.x + ob.max.x) / 2, -ob.min.y, -(ob.min.z + ob.max.z) / 2);
  out.scale(CAR.len / L, BODY_CFG.height / Ht, (2 * CAR.hw) / Wd);
  out.rotateY(Math.PI / 2);
  out.translate(0, BODY_CFG.base, 0);
  // (the model's own normals, carried through the stretch by applyMatrix4's normal matrix: smooth paint, no facets)
  if (!out.attributes.normal) out.computeVertexNormals();
  out.computeBoundingSphere();
  const mat = crisp((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).clone());
  BODY = { geo: out, mat };
  return BODY;
}

// The cabin's surface textures (no uvs on the built geometry: mapped triplanar in the car's frame), one tile of
// 256 px: r fine grain (laminate), g perforation (ceiling panels: 0 in a hole), b brushed streaks (metal), a a
// woven pattern (fabric) mottled by grain (the floor's rubber uses r and a).
export const TX = { laminate: 0, fabric: 1, floor: 2, ceiling: 3, metal: 4 };
let DETAIL = null;
function detailTexture() {
  if (DETAIL || typeof document === 'undefined') return DETAIL;
  const S = 256, data = new Uint8Array(S * S * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const noise = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) noise[i] = rnd();
  const blur = (src, r) => { const out = new Float32Array(S * S); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { let t = 0, n = 0; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { t += src[((y + dy + S) % S) * S + ((x + dx + S) % S)]; n++; } out[y * S + x] = t / n; } return out; };
  const fine = blur(noise, 1), coarse = blur(blur(noise, 3), 3);
  const norm = (a) => { let lo = 1, hi = 0; for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return (v) => (v - lo) / Math.max(1e-6, hi - lo); };
  const nf = norm(fine), nc = norm(coarse);
  const streak = new Float32Array(S);
  for (let y = 0; y < S; y++) streak[y] = rnd();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, o = i * 4;
    data[o] = Math.round(255 * (0.55 * nf(fine[i]) + 0.45 * nc(coarse[i])));
    // perforation: a hole every 16 px (diameter ~6 px), staggered rows
    const cx = (x + (Math.floor(y / 16) % 2) * 8) % 16 - 8, cy = (y % 16) - 8;
    data[o + 1] = Math.round(255 * Math.min(1, Math.max(0, (Math.hypot(cx, cy) - 2.6) / 1.2)));
    data[o + 2] = Math.round(255 * (0.6 * streak[y] + 0.25 * streak[(y + 1) % S] + 0.15 * nf(fine[i])));
    // weave: over-under threads every 4 px, with grain
    const wv = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) ? 0.35 + 0.65 * ((x % 4) / 3) : 0.35 + 0.65 * ((y % 4) / 3);
    data[o + 3] = Math.round(255 * (0.65 * wv + 0.35 * nf(fine[i])));
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  DETAIL = t;
  return t;
}
function cabinPatch(mat, key) {
  const detail = detailTexture();
  mat.onBeforeCompile = (s) => {
    s.uniforms.uCabin = trainUniforms.uCabin;
    s.uniforms.uDetail = { value: detail };
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCabin;\nattribute float aTex;\nvarying float vCabin;\nvarying float vTex;\nvarying vec3 vOP;\nvarying vec3 vON;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCabin = aCabin; vTex = aTex; vOP = position; vON = normal;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uCabin;\nuniform sampler2D uDetail;\nvarying float vCabin;\nvarying float vTex;\nvarying vec3 vOP;\nvarying vec3 vON;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${detail ? `{
          // the surface's texture, triplanar in the car's frame (tiles per m by kind)
          vec3 an = abs(normalize(vON)); an = an * an; an /= an.x + an.y + an.z;
          float k = vTex < 0.5 ? 2.5 : vTex < 1.5 ? 7.0 : vTex < 2.5 ? 1.6 : vTex < 3.5 ? 5.5 : 3.0;
          vec4 tx = texture2D(uDetail, vOP.zy * k) * an.x + texture2D(uDetail, vOP.xz * k) * an.y + texture2D(uDetail, vOP.xy * k) * an.z;
          float d = vTex < 0.5 ? mix(0.86, 1.05, tx.r)
            : vTex < 1.5 ? mix(0.8, 1.1, tx.a)
            : vTex < 2.5 ? mix(0.78, 1.12, tx.r) * mix(0.94, 1.03, tx.a)
            : vTex < 3.5 ? mix(0.55, 1.0, tx.g) * mix(0.97, 1.02, tx.r)
            : mix(0.86, 1.08, tx.b);
          diffuseColor.rgb *= d;
        }` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.85, 0.66) * vCabin * uCabin;`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}
function materials() {
  if (MATS) return MATS;
  const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.18, envMapIntensity: 1.15 });
  const under = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.35 });
  const inside = cabinPatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 }), 'rail-cabin');
  const insideMetal = cabinPatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.85 }), 'rail-cabin-metal');
  // glass: from outside a tinted, reflective pane; from inside nearly clear (two single-sided layers)
  const glassOut = new THREE.MeshStandardMaterial({ color: 0x5f7a92, roughness: 0.05, metalness: 0.25, transparent: true, opacity: 0.42, envMapIntensity: 1.8, depthWrite: false, side: THREE.FrontSide });
  const glassIn = new THREE.MeshStandardMaterial({ color: 0xb4c8d6, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.13, envMapIntensity: 1.0, depthWrite: false, side: THREE.FrontSide });
  const glassFar = new THREE.MeshStandardMaterial({ color: 0x1e2731, roughness: 0.12, metalness: 0.5, envMapIntensity: 1.4 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff1da, emissiveIntensity: 1, roughness: 0.4 });
  lamp.onBeforeCompile = (s) => {
    s.uniforms.uCabin = trainUniforms.uCabin;
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uCabin;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 0.8 + 3.2 * uCabin;');
  };
  lamp.customProgramCacheKey = () => 'rail-lamp';
  const head = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xfff6e8, emissiveIntensity: 1, roughness: 0.3 });
  head.onBeforeCompile = (s) => {
    s.uniforms.uHead = trainUniforms.uHead;
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uHead;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 0.3 + 9.0 * uHead;');
  };
  head.customProgramCacheKey = () => 'rail-head';
  const tail = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2010, emissiveIntensity: 2.2, roughness: 0.4 });
  const letter = canvasTex(1024, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#ffffff'; g.font = `italic 700 96px ${FONT}`; g.textBaseline = 'middle';
    g.fillText('WOLKENSPITZBAHN', 16, h / 2 + 4);
  });
  const letterMat = new THREE.MeshStandardMaterial({ map: letter, transparent: true, roughness: 0.35, metalness: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const dest = (text) => canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#0a0a0b'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffb02a'; g.font = `700 62px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillText(text, w / 2, h / 2 + 3);
  });
  const destMat = (t) => new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.5, color: 0x666666 });
  const destUp = destMat(dest('WOLKENPLATT')), destDown = destMat(dest('LEGACY VILLAGE'));
  // the info screen inside: the line with its stops
  const info = canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = '#0f1520'; g.fillRect(0, 0, w, h);
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#9fb3c8'; g.font = `600 19px ${FONT}`; g.textAlign = 'left'; g.fillText('WOLKENSPITZBAHN', 30, 26);
    g.textAlign = 'right'; g.fillText('1,248 m  \u2192  2,611 m', w - 30, 26);
    const y = 74, x0 = 38, x1 = w - 38;
    g.strokeStyle = '#b0121a'; g.lineWidth = 6; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    // the stops at their places along the line: names alternate above / below so they never collide
    const stops = [[0, 'Legacy Village', 'below', 'left'], [0.226, 'Wolkensee', 'above', 'center'], [1, 'Wolkenplatt', 'below', 'right']];
    for (const [u, name, where, align] of stops) {
      const x = x0 + (x1 - x0) * u;
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill();
      g.fillStyle = '#0f1520'; g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill();
      g.fillStyle = '#ffffff'; g.font = `600 25px ${FONT}`; g.textAlign = align;
      g.fillText(name, align === 'left' ? x - 8 : align === 'right' ? x + 8 : x, where === 'above' ? y - 16 : y + 36);
    }
  });
  const infoMat = new THREE.MeshStandardMaterial({ map: info, emissiveMap: info, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4, color: info ? 0xffffff : 0x0f1520 });
  MATS = { paint, under, inside, insideMetal, glassOut, glassIn, glassFar, lamp, head, tail, letterMat, destUp, destDown, infoMat };
  return MATS;
}

// ------------------------------------------------------------------ the body shape
// Outer section (right half, bottom -> top) of the body: skirt, lower side, window band, glazed roof edge, roof.
const H = CAR.half, HW = CAR.hw;
const LOWER = [[1.17, 0.52], [1.27, 0.6], [1.315, 0.74], [1.32, 0.95], [1.32, CAR.winLo - 0.04]];
const EDGE = (() => { // the glazed roof edge: from the window band's top to the roof
  const out = [];
  for (let i = 0; i <= 7; i++) { const t = i / 7, a = t * Math.PI * 0.5; out.push([0.86 + (HW - 0.02 - 0.86) * Math.cos(a), CAR.winHi + (CAR.roofTop - 0.06 - CAR.winHi) * Math.sin(a)]); }
  return out;
})();
const ROOFC = (() => { const out = []; for (let i = 0; i <= 6; i++) { const x = 0.86 * (1 - i / 6); out.push([x, CAR.roofTop - 0.06 * (x / 0.86) ** 2]); } return out; })();
// plan of the cab nose at height y: x half-width -> z offset back from the front (rounded corners, raked top)
const NOSE = { depth: 1.15, cornerR: 0.62 };
function noseZ(x, y) {
  // the front face bulges slightly; the corners round off; above the sill the windshield rakes back
  const ax = Math.abs(x);
  const corner = ax > HW - NOSE.cornerR ? NOSE.cornerR - Math.sqrt(Math.max(0, NOSE.cornerR ** 2 - (ax - (HW - NOSE.cornerR)) ** 2)) : 0;
  const bulge = 0.08 * (1 - (ax / HW) ** 2);
  const rake = y > 1.86 ? (y - 1.86) * 0.42 : 0;
  const lowRound = y < 0.75 ? (0.75 - y) * 0.5 : 0;
  return H - corner + bulge - rake - lowRound;
}

/**
 * Build one car (cab at its +z end). Returns { group, lo (far LOD group), seats: [{ pos (car frame, seat
 * surface), yaw (0 = facing +z), window, side, face, front (panorama row) }], bogies: [Mesh, Mesh] }.
 */
export function buildCar({ number = 1, express = false } = {}) {
  const M = materials();
  const F = CAR.floor;
  const group = new THREE.Group();
  group.name = 'rail-car';
  const zRear = -H, zNose = H - NOSE.depth; // the plain body runs from the rear wall to where the nose begins

  // ---------------- body shell (paint): lower sides, roof, pillars, frames, the nose
  const sh = new GB();
  const rowsAlong = (sec, z0, z1, n = 2) => { const rows = []; for (let i = 0; i < n; i++) { const z = z0 + ((z1 - z0) * i) / (n - 1); rows.push(sec.map(([x, y]) => [x, y, z])); } return rows; };
  for (const s of [1, -1]) {
    const lower = LOWER.map(([x, y]) => [x * s, y]);
    sh.grid(rowsAlong(lower, zRear, zNose, 2), RED, { flip: s < 0 });
    // white coach line + the black window belt rubber under and over the glazing
    sh.box(s * 1.322, 1.6, (zRear + zNose) / 2, 0.012, 0.04, zNose - zRear - 0.1, WHITE);
    sh.box(s * 1.318, CAR.winLo - 0.02, (zRear + zNose) / 2, 0.03, 0.06, zNose - zRear, BLACK);
    sh.box(s * 1.31, CAR.winHi + 0.02, (zRear + zNose) / 2, 0.04, 0.06, zNose - zRear, BLACK);
  }
  sh.grid(rowsAlong(ROOFC, zRear, H - 0.75, 2), ROOF);
  sh.grid(rowsAlong(ROOFC.map(([x, y]) => [-x, y]), zRear, H - 0.75, 2), ROOF, { flip: true });
  for (const s of [1, -1]) sh.box(s * 0.86, CAR.roofTop - 0.08, (zRear + H - 0.75) / 2, 0.06, 0.07, H - 0.75 - zRear, GREY); // gutters
  // window pillars (side and roof edge) between the window panes
  const pillars = pillarZs();
  for (const z of pillars) for (const s of [1, -1]) {
    sh.box(s * 1.305, (CAR.winLo + CAR.winHi) / 2, z, 0.05, CAR.winHi - CAR.winLo, 0.13, BLACK);
    for (let i = 0; i < EDGE.length - 1; i++) sh.bar([s * EDGE[i][0], EDGE[i][1], z], [s * EDGE[i + 1][0], EDGE[i + 1][1], z], 0.03, '#2a2d31', 5);
  }
  // doors: outlines, steps, handles (their glazing is in the glass)
  for (const dz of doorZs()) for (const s of [1, -1]) {
    sh.box(s * 1.326, 1.92, dz, 0.012, 2.0, 0.035, BLACK);
    sh.box(s * 1.326, 2.95, dz, 0.012, 0.035, 1.34, BLACK);
    for (const e of [-0.67, 0.67]) sh.box(s * 1.326, 1.92, dz + e, 0.012, 2.0, 0.035, BLACK);
    sh.box(s * 1.34, 1.42, dz - 0.14, 0.03, 0.05, 0.16, STEEL); sh.box(s * 1.34, 1.42, dz + 0.14, 0.03, 0.05, 0.16, STEEL);
    sh.box(s * 1.2, 0.48, dz, 0.26, 0.05, 1.1, GREY_L); // the step
  }
  // rear wall with the gangway bellows
  const endSec = [...LOWER, [HW - 0.01, CAR.winHi], ...EDGE.slice(1), ...ROOFC.slice(1)];
  const endPoly = [...endSec, ...endSec.slice().reverse().map(([x, y]) => [-x, y])];
  { const c = sh.v(0, 2.1, zRear, 0, 0, -1, WHITE); const r = endPoly.map(([x, y]) => sh.v(x, y, zRear, 0, 0, -1, WHITE)); for (let i = 0; i < r.length - 1; i++) sh.tri(c, r[i + 1], r[i]); }
  for (let i = 0; i < 4; i++) sh.box(0, 2.15, zRear - 0.07 - i * 0.12, 1.36, 2.4, 0.1, i % 2 ? RUBBER : DARK);
  // roof equipment: air conditioning, resistors, the pantograph
  sh.box(0, CAR.roofTop + 0.17, -3.2, 1.25, 0.34, 3.0, GREY_L, ROOF);
  sh.box(0, CAR.roofTop + 0.1, 2.0, 0.9, 0.2, 1.6, GREY_L, ROOF);
  pantograph(sh, -6.2);
  // the cab nose
  buildNose(sh);
  const shell = new THREE.Mesh(sh.build(), M.paint);
  shell.castShadow = true; shell.receiveShadow = true;
  group.add(shell);

  // ---------------- underframe + bogies
  const un = new GB();
  un.box(0, 0.6, -0.55, 2.2, 0.14, CAR.len - 1.7, DARK); // (ends under the nose's start: never sticks out in front)
  for (const z of [-2.6, -0.2, 2.4]) un.box(0, 0.42, z, 1.95, 0.34, 1.7, GREY);
  const underM = new THREE.Mesh(un.build(), M.under);
  underM.castShadow = true;
  group.add(underM);
  const bogies = [];
  for (const bz of [-CAR.bogie, CAR.bogie]) {
    const b = new GB();
    b.box(0, 0.44, 0, 1.6, 0.2, 2.5, DARK);
    for (const s of [1, -1]) { b.box(s * 0.79, 0.36, 0, 0.12, 0.36, 2.9, GREY); b.box(s * 0.82, 0.62, 0, 0.1, 0.12, 1.2, '#2a2d31'); }
    for (const az of [-0.95, 0.95]) {
      for (const s of [1, -1]) { b.cyl(s * 0.5, 0.36, az, 0.36, 0.1, 16, DARK, 'x'); b.cyl(s * 0.56, 0.36, az, 0.12, 0.06, 10, STEEL, 'x'); }
      b.cyl(0, 0.36, az, 0.07, 1.0, 8, GREY, 'x');
      b.cyl(0, 0.32, az, 0.3, 0.12, 18, GREY_L, 'x'); // the rack pinion between the wheels
    }
    b.box(0, 0.66, 0, 0.9, 0.16, 0.9, GREY);
    const m = new THREE.Mesh(b.build(), M.under);
    m.position.set(0, 0, bz);
    m.castShadow = true;
    group.add(m);
    bogies.push(m);
  }

  // ---------------- glass (two single-sided layers: tinted outside, nearly clear inside)
  const go = new GB(), gi = new GB();
  const zA = zRear + 0.1, zB = zNose + 0.02;
  for (const s of [1, -1]) {
    const x = s * (HW - 0.025);
    const side = [[x, CAR.winLo, zA], [x, CAR.winLo, zB], [x, CAR.winHi, zB], [x, CAR.winHi, zA]];
    if (s > 0) { go.face(side[1], side[0], side[3], side[2], WHITE); gi.face(side[0], side[1], side[2], side[3], WHITE); }
    else { go.face(side[0], side[1], side[2], side[3], WHITE); gi.face(side[1], side[0], side[3], side[2], WHITE); }
    const rows = [EDGE.map(([ex, ey]) => [s * (ex - 0.02), ey, zA]), EDGE.map(([ex, ey]) => [s * (ex - 0.02), ey, H - 0.78])];
    go.grid(rows, WHITE, { flip: s > 0 }); gi.grid(rows, WHITE, { flip: s < 0 });
  }
  windshield(go, gi);
  const glassO = new THREE.Mesh(go.build(), M.glassOut); glassO.renderOrder = 3;
  const glassI = new THREE.Mesh(gi.build(), M.glassIn); glassI.renderOrder = 3;
  group.add(glassO, glassI);

  // ---------------- interior (cabin-lit)
  const inn = new GB({ light: true }), met = new GB({ light: true });
  // warm light from the two ceiling strips: strong on the floor, seats and lower walls, softer at the ends
  const light = (x, y, z, nx, ny) => {
    const along = 1 - Math.min(1, Math.max(0, (Math.abs(z) - (H - 1.2)) / 1.6));
    const up = 0.62 + 0.38 * Math.max(0, ny);
    const toward = 0.75 + 0.25 * (1 - Math.min(1, Math.abs(x) / 1.4));
    return 0.78 * along * up * toward;
  };
  inn.lightFn = light; met.lightFn = light;
  const seats = buildInterior(inn, met, { express });
  const interior = new THREE.Mesh(inn.build(), M.inside);
  interior.receiveShadow = true;
  const metal = new THREE.Mesh(met.build(), M.insideMetal);
  metal.receiveShadow = true;
  group.add(interior, metal);
  // the coach seats (the post bus's), instanced: five meshes per car
  const seatMeshes = coachSeats(seats.inst, seatMaterials());
  for (const sm of seatMeshes) { sm.receiveShadow = true; group.add(sm); }
  const seatMesh = seatMeshes[0];
  // the bulkhead's glazing (windows either side of the cab door, the door's window): nearly clear, from both sides
  {
    const BK = seats.bulkhead, bg = new GB();
    const pane = (x0, x1, y0, y1, z) => { bg.face([x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], WHITE); bg.face([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], WHITE); };
    for (const s of [1, -1]) pane(s * (BK.door + 0.1), s * (HW - 0.11), BK.sill + 0.04, BK.head - 0.04, BK.z - 0.01);
    pane(-(BK.door - 0.08), BK.door - 0.08, BK.sill, BK.head - 0.12, BK.z - 0.012);
    const bgm = new THREE.Mesh(bg.build(), M.glassIn); bgm.renderOrder = 3;
    group.add(bgm);
  }

  // ---------------- lamps (ceiling strips), headlights, tail lights, displays
  const lp = new GB();
  for (const s of [1, -1]) lp.box(s * (CEIL_X + 0.1), CEIL_Y - 0.045, (zRear + CAR.cabZ) / 2 + 0.1, 0.07, 0.012, CAR.cabZ - zRear - 0.6, WHITE);
  group.add(new THREE.Mesh(lp.build(), M.lamp));
  const hl = new GB();
  for (const s of [1, -1]) { hl.cyl(s * 0.84, 1.24, noseZ(0.84, 1.24) + 0.015, 0.11, 0.05, 16, WHITE, 'z'); hl.cyl(s * 0.6, 1.24, noseZ(0.6, 1.24) + 0.015, 0.07, 0.05, 12, WHITE, 'z'); }
  group.add(new THREE.Mesh(hl.build(), M.head));
  const tl = new GB();
  for (const s of [1, -1]) tl.box(s * 0.99, 0.92, noseZ(0.99, 0.92) + 0.02, 0.2, 0.08, 0.04, WHITE);
  group.add(new THREE.Mesh(tl.build(), M.tail));
  const dest = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.2), M.destUp);
  dest.position.set(0, 3.36, noseZ(0, 3.36) + 0.06);
  dest.rotation.x = -0.4;
  group.add(dest);
  {
    const BK = seats.bulkhead;
    const front = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), M.infoMat);
    front.position.set(0, (BK.head + CEIL_Y) / 2 + 0.02, BK.z - 0.03); front.rotation.y = Math.PI;
    const rear = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.21), M.infoMat);
    rear.position.set(0, CAR.floor + 2.25, zRear + 0.16);
    group.add(front, rear);
  }
  // lettering on both sides
  const letter = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 0.6), M.letterMat);
  for (const s of [1, -1]) {
    const l = letter.clone();
    l.position.set(s * 1.335, 1.18, -1.6);
    l.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    group.add(l);
  }
  group.userData = { bogies, seats, number, dest, seatMesh, seatMeshes };
  // outside views: the Meshy body instead of our shell, glass and cabin (the bogies and the underframe stay)
  let proc = null, body = null;
  if (BODY) {
    proc = new THREE.Group(); proc.name = 'rail-car-proc';
    for (const ch of [...group.children]) if (!bogies.includes(ch) && ch.material !== M.under) proc.add(ch);
    group.add(proc);
    body = new THREE.Mesh(BODY.geo, BODY.mat);
    body.castShadow = true; body.receiveShadow = true;
    body.name = 'rail-car-meshy';
    group.add(body);
    proc.visible = false;
  }
  const setInside = (inside) => { if (!body) return; proc.visible = inside; body.visible = !inside; };

  // ---------------- far version: opaque body, dark windows, no interior
  const lo = new THREE.Group();
  const lb = new GB();
  for (const s of [1, -1]) lb.grid(rowsAlong(LOWER.map(([x, y]) => [x * s, y]), -H, H - 0.6, 2), RED, { flip: s < 0 });
  for (const s of [1, -1]) {
    lb.grid([[[s * 1.31, CAR.winLo - 0.05, -H], [s * 1.31, CAR.winHi, -H], ...EDGE.slice(1).map(([x, y]) => [s * x, y, -H])], [[s * 1.31, CAR.winLo - 0.05, H - 0.9], [s * 1.31, CAR.winHi, H - 0.9], ...EDGE.slice(1).map(([x, y]) => [s * x, y, H - 0.9])]], '#1f2935', { flip: s < 0 });
  }
  lb.box(0, CAR.roofTop - 0.06, -0.3, 1.75, 0.14, CAR.len - 1.2, ROOF);
  lb.box(0, 0.45, 0, 2.0, 0.4, CAR.len - 0.8, DARK);
  lb.box(0, 1.2, H - 0.45, 2.5, 1.3, 0.9, RED);
  lb.box(0, 2.5, H - 0.75, 2.4, 1.3, 0.5, '#1f2935');
  lo.add(new THREE.Mesh(lb.build(), M.paint));
  return { group, lo, seats, bogies, setInside, hasBody: !!body };
}

// z of the window pillars along the body (bay boundaries in the compartments, the panorama lounge, the doors)
const BAY = 1.9;
const BAYS_Z0 = -6.15, BAYS_N = 5;              // vis-a-vis bays from the rear door to the front door
const DOOR_F = 4.1, DOOR_R = -7.05;            // door centres
const LOUNGE = [5.4, 6.38];                     // the panorama rows (seat backs), facing forward
function doorZs() { return [DOOR_F, DOOR_R]; }
function pillarZs() {
  const out = [];
  for (let i = 0; i <= BAYS_N; i++) out.push(BAYS_Z0 + i * BAY);
  out.push(DOOR_F - 0.72, DOOR_F + 0.72, DOOR_R - 0.72, DOOR_R + 0.72);
  out.push((DOOR_F + 0.72 + CAR.cabZ) / 2);
  out.push(-H + 0.12);
  return out;
}

// the cab end: rounded nose (lower body), the raked windshield frame, the cab roof, buffer beam, wipers
function buildNose(sh) {
  const zN = H - NOSE.depth;
  // lower nose: rows of the lower section swept around the rounded plan from one side over the front to the other
  const ys = [0.52, 0.6, 0.74, 0.95, 1.3, 1.575, 1.58, 1.625, 1.63, 1.76];
  const halfX = (y) => { const k = LOWER.findIndex((p) => p[1] >= y); if (k <= 0) return LOWER[0][0]; const a = LOWER[k - 1], b = LOWER[k]; return a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]); };
  const cols = 24;
  const rows = ys.map((y) => {
    const hx = halfX(y), row = [];
    for (let j = 0; j <= cols; j++) {
      const t = j / cols, x = hx * Math.cos(Math.PI * t); // right side -> front -> left side
      const zf = noseZ(x, y);
      // along the side (|x| near hx) start at the nose's beginning, then follow the rounded front
      const z = t < 0.02 || t > 0.98 ? zN : Math.max(zN, zf - (1 - Math.sin(Math.PI * t)) * 0.0);
      row.push([x, y, z]);
    }
    return row;
  });
  // the side parts of the nose (from zN to the start of the rounding) are covered by extending the body grid:
  // rows here run around the front; flip so normals face outward
  sh.grid(rows, RED, { flip: true, colFn: (i, j, p) => (p[1] > 1.578 && p[1] < 1.627 ? WHITE : RED) });
  // fill the sides between the body and the rounded front (straight stretch of the nose)
  for (const s of [1, -1]) {
    const lower = LOWER.map(([x, y]) => [x * s, y]);
    const r2 = [lower.map(([x, y]) => [x, y, zN]), lower.map(([x, y]) => [x, y, noseZ(x, y) - 0.01])];
    sh.grid(r2, RED, { flip: s < 0 });
  }
  // buffer beam, coupler, the black band with the headlights
  sh.box(0, 0.6, H + 0.03, 2.1, 0.2, 0.14, DARK);
  sh.box(0, 0.62, H + 0.18, 0.32, 0.22, 0.24, GREY);
  sh.box(0, 1.24, noseZ(0, 1.24) + 0.0, 2.2, 0.36, 0.04, BLACK);
  // windshield frame (black): sill, pillars at the corners, top
  sh.box(0, 1.83, noseZ(0, 1.83) - 0.02, 2.4, 0.07, 0.12, BLACK);
  for (const s of [1, -1]) sh.bar([s * 1.24, 1.84, noseZ(1.24, 1.84) - 0.06], [s * 1.12, 3.16, noseZ(1.12, 3.16) - 0.08], 0.05, BLACK, 6);
  // cab side window frames
  for (const s of [1, -1]) {
    sh.box(s * 1.305, (CAR.winLo + CAR.winHi) / 2, zN - 0.02, 0.05, CAR.winHi - CAR.winLo, 0.12, BLACK);
  }
  // cab roof: from the roof section forward, curving down onto the windshield's top
  const roofRows = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const z0 = H - 0.75 + t * 0.0;
    void z0;
    roofRows.push(null);
  }
  const capRows = [];
  const sec = [[HW - 0.04, CAR.winHi + 0.05], ...EDGE.slice(2), ...ROOFC.slice(1)];
  const full = [...sec.slice().reverse().map(([x, y]) => [-x, y]), ...sec.slice(1)];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    capRows.push(full.map(([x, y]) => {
      const zTop = noseZ(x * 0.97, 3.2) - 0.05;
      const z = (H - 0.8) + (zTop - (H - 0.8)) * t;
      const yy = y - (y - 3.24) * t * t * 0.6;
      return [x * (1 - 0.06 * t * t), yy, z];
    }));
  }
  sh.grid(capRows, WHITE, { flip: true });
  // destination display housing
  sh.box(0, 3.36, noseZ(0, 3.36) - 0.02, 1.3, 0.28, 0.1, BLACK);
  // wipers
  for (const s of [1, -1]) sh.bar([s * 0.55, 1.93, noseZ(0.55, 1.93) + 0.02], [s * 0.2, 2.65, noseZ(0.2, 2.65) + 0.03], 0.012, BLACK, 4);
}
function windshield(go, gi) {
  // a curved pane following the nose's plan between the sill and the top frame
  const rows = [];
  for (const y of [1.86, 2.3, 2.75, 3.16]) {
    const hx = 1.24 - (y - 1.86) * 0.09, row = [];
    for (let j = 0; j <= 16; j++) { const x = hx * Math.cos(Math.PI * (j / 16)); row.push([x, y, noseZ(x, y) - 0.04]); }
    rows.push(row);
  }
  go.grid(rows, WHITE, { flip: true });
  gi.grid(rows, WHITE, { flip: false });
  // cab side windows
  for (const s of [1, -1]) {
    const x = s * (HW - 0.025), z0 = H - NOSE.depth, z1 = H - NOSE.depth + 0.0;
    void z1;
    const p = [[x, CAR.winLo, z0 - 0.0], [x, CAR.winLo, noseZ(1.25, CAR.winLo) - 0.1], [x, CAR.winHi, noseZ(1.25, CAR.winHi) - 0.1], [x, CAR.winHi, z0]];
    if (s > 0) { go.face(p[1], p[0], p[3], p[2], WHITE); gi.face(p[0], p[1], p[2], p[3], WHITE); }
    else { go.face(p[0], p[1], p[2], p[3], WHITE); gi.face(p[1], p[0], p[3], p[2], WHITE); }
  }
}
function pantograph(sh, z) {
  const y = CAR.roofTop + 0.06;
  sh.box(0, y + 0.06, z, 0.9, 0.12, 1.1, GREY);
  for (const s of [1, -1]) {
    sh.bar([s * 0.3, y + 0.12, z - 0.4], [s * 0.18, y + 0.72, z + 0.1], 0.025, '#6e747b', 5);
    sh.bar([s * 0.18, y + 0.72, z + 0.1], [s * 0.25, y + 1.3, z - 0.15], 0.02, '#6e747b', 5);
  }
  sh.box(0, y + 1.32, z - 0.15, 1.5, 0.05, 0.14, '#4b5056');
}

// ------------------------------------------------------------------ interior
// A panoramic railcar's cabin: the coach seats (coachseat.js) in the panorama lounge behind the cab and in the
// vis-a-vis bays (a table at the window), a vaulted ceiling of perforated panels between the glazed roof edges with
// the LED light coves along both sides and an air grille down the middle, luggage racks over the side windows, grab
// rails with hanging handholds along the aisle, the front bulkhead (windows either side of the cab door, the route
// display over it) and the cab beyond, the rear wall with the gangway door. Every surface carries one of the cabin
// textures (TX).
const CEIL_Y = CAR.roofTop - 0.2, CEIL_RISE = 0.085, CEIL_X = 0.82; // the vault: its edge height, rise, half width
const vaultY = (x) => CEIL_Y + CEIL_RISE * (1 - Math.min(1, (x / CEIL_X) ** 2));
// the cabin layout, for the Legacy Express's own furnishing (expressinterior.js)
export const CABIN = { BAY, BAYS_Z0, BAYS_N, LOUNGE, CEIL_Y, CEIL_X, H, HW, W: HW - 0.07 };
function buildInterior(g, m, { express = false } = {}) {
  const F = CAR.floor, W = HW - 0.07;
  const zA = -H + 0.12, zB = CAR.cabZ;
  // (Legacy Express, Oct 31 2026: "the interior of the train is very ugly, make it realistic": a grey-blue floor,
  // cooler light grey wall panels; its tables and luggage racks are expressinterior.js's, not drawn here)
  const PANEL_ = express ? '#d5d9de' : PANEL;
  // floor: speckled rubber, the lighter aisle strip, tread lines at the doors
  g.tx = TX.floor;
  g.box(0, F - 0.03, (zA + zB) / 2, W * 2, 0.06, zB - zA, express ? '#4a5664' : FLOOR);
  g.box(0, F + 0.002, (zA + zB) / 2, CAR.aisle * 2 - 0.06, 0.004, zB - zA - 0.3, express ? '#5f6d7e' : AISLE);
  for (const dz of doorZs()) for (let k = -3; k <= 3; k++) g.box(0, F + 0.004, dz + k * 0.16, W * 2 - 0.1, 0.004, 0.03, '#2f3236');
  // side walls under the windows (laminate), heater ducts, wooden sills
  g.tx = TX.laminate;
  for (const s of [1, -1]) {
    g.box(s * (W - 0.02), (F + CAR.winLo) / 2, (zA + zB) / 2, 0.04, CAR.winLo - F, zB - zA, PANEL_);
    g.box(s * (W - 0.11), F + 0.1, (zA + zB) / 2, 0.14, 0.2, zB - zA - 0.3, '#bdbdb8');
    g.box(s * (W - 0.06), CAR.winLo - 0.01, (zA + zB) / 2, 0.15, 0.035, zB - zA, express ? '#8f969e' : SILL);
  }
  // ---- ceiling: perforated vault panels (a seam at every bay), the light coves, the air grille
  const zc0 = zA, zc1 = zB, xs = [];
  for (let i = 0; i <= 12; i++) xs.push(-CEIL_X + (2 * CEIL_X * i) / 12);
  g.tx = TX.ceiling;
  g.grid([xs.map((x) => [x, vaultY(x), zc0]), xs.map((x) => [x, vaultY(x), zc1])], CEIL);
  g.tx = TX.laminate;
  for (const z of [...pillarZs(), zB]) {
    if (z < zc0 || z > zc1) continue;
    // a panel seam: a dark groove following the vault
    g.grid([xs.map((x) => [x, vaultY(x) - 0.004, z - 0.008]), xs.map((x) => [x, vaultY(x) - 0.004, z + 0.008])], '#9c9a94');
  }
  for (const s of [1, -1]) {
    // the cove: a profiled housing along the vault's edge (the LED strip in it is in buildCar's lamps)
    const x0 = s * CEIL_X, y0 = CEIL_Y;
    g.grid([[[x0, y0, zc0], [x0 + s * 0.06, y0 - 0.05, zc0], [x0 + s * 0.15, y0 - 0.06, zc0], [x0 + s * 0.2, y0 - 0.01, zc0]],
      [[x0, y0, zc1], [x0 + s * 0.06, y0 - 0.05, zc1], [x0 + s * 0.15, y0 - 0.06, zc1], [x0 + s * 0.2, y0 - 0.01, zc1]]], '#e9e8e3', { flip: s < 0 });
  }
  // the air grille down the middle: a dark channel with slats
  g.box(0, vaultY(0) - 0.006, (zc0 + zc1) / 2, 0.16, 0.012, zc1 - zc0 - 0.4, '#6f747b');
  g.tx = TX.metal;
  for (let z = zc0 + 0.3; z < zc1 - 0.2; z += 0.07) g.box(0, vaultY(0) - 0.014, z, 0.15, 0.006, 0.035, '#c3c7cc');
  // ---- luggage racks over the side windows: brackets at the pillars, a perforated shelf, a round front rail
  for (const s of (express ? [] : [1, -1])) {
    const yR = CAR.winHi - 0.04, x0 = s * (HW - 0.06), x1 = s * (HW - 0.4), rz0 = BAYS_Z0, rz1 = BAYS_Z0 + BAYS_N * BAY;
    g.tx = TX.ceiling;
    g.box((x0 + x1) / 2, yR, (rz0 + rz1) / 2, Math.abs(x1 - x0), 0.012, rz1 - rz0, '#b9bec4');
    m.tx = TX.metal;
    m.bar([x1, yR + 0.02, rz0], [x1, yR + 0.02, rz1], 0.014, STEEL, 6);
    m.bar([x1, yR + 0.1, rz0], [x1, yR + 0.1, rz1], 0.01, STEEL, 6);
    for (let z = rz0; z <= rz1 + 0.01; z += BAY) {
      m.bar([x0, yR - 0.12, z], [x1, yR + 0.02, z], 0.011, STEEL, 5);
      m.bar([x1, yR + 0.02, z], [x1, yR + 0.1, z], 0.009, STEEL, 5);
    }
  }
  // ---- grab rails along the aisle, with hanging handholds
  for (const s of [1, -1]) {
    const yG = CEIL_Y - 0.36;
    m.bar([s * 0.42, yG, zA + 0.7], [s * 0.42, yG, zB - 0.5], 0.014, STEEL, 6);
    for (let z = zA + 1.1; z < zB - 0.5; z += 1.5) m.bar([s * 0.42, yG, z], [s * 0.42, vaultY(0.42), z], 0.008, STEEL, 4);
    for (let z = zA + 1.45; z < zB - 0.6; z += 0.75) {
      // a strap and its handle (a flat loop)
      g.tx = TX.fabric;
      g.box(s * 0.42, yG - 0.11, z, 0.025, 0.2, 0.004, '#2b3442');
      g.tx = TX.laminate;
      g.box(s * 0.42, yG - 0.22, z, 0.03, 0.022, 0.13, '#e8e6e0');
      g.box(s * 0.42, yG - 0.27, z, 0.03, 0.022, 0.13, '#e8e6e0');
      g.box(s * 0.42, yG - 0.245, z - 0.065, 0.03, 0.07, 0.02, '#e8e6e0');
      g.box(s * 0.42, yG - 0.245, z + 0.065, 0.03, 0.07, 0.02, '#e8e6e0');
    }
  }
  // ---- seats: pairs of coach seats on a pedestal (the seats themselves: instanced in buildCar)
  const seats = [], seatInst = [];
  const seatPair = (xc, zBack, face, row) => {
    const wS = 0.98, dz = face, zc = zBack + dz * 0.3;
    for (let k = 0; k < 2; k++) {
      const x = xc - wS / 4 + (k * wS) / 2;
      seatInst.push({ x, y: F, z: zc, yaw: dz > 0 ? 0 : Math.PI });
      const win = Math.abs(x) > Math.abs(xc);
      seats.push({ pos: new THREE.Vector3(x, F + COACH_SEAT.surface, zc), yaw: dz > 0 ? 0 : Math.PI, window: win, side: Math.sign(xc), face: dz, front: !!row, row });
    }
    g.tx = TX.metal;
    g.box(xc, F + 0.2, zc - dz * 0.02, 0.86, 0.04, 0.3, '#3a3e44');
    g.box(xc, F + 0.1, zc - dz * 0.02, 0.12, 0.2, 0.24, '#2c2f34');
  };
  const xL = -(CAR.aisle + 0.51), xR = CAR.aisle + 0.51;
  // the panorama lounge behind the cab: rows facing forward
  LOUNGE.forEach((zb, i) => { for (const xc of [xL, xR]) seatPair(xc, zb - 0.32, 1, i === LOUNGE.length - 1 ? 1 : 2); });
  // vis-a-vis bays with a table at the window
  for (let b = 0; b < BAYS_N; b++) {
    const zb = BAYS_Z0 + b * BAY;
    for (const xc of [xL, xR]) {
      seatPair(xc, zb + 0.14, 1, 0);
      seatPair(xc, zb + BAY - 0.14, -1, 0);
      const s = Math.sign(xc);
      if (express) continue; // (rounded tables: expressinterior.js)
      g.tx = TX.laminate;
      g.box(s * (W - 0.23), F + 0.74, zb + BAY / 2, 0.42, 0.035, 0.52, TABLE);
      m.tx = TX.metal;
      m.bar([s * (W - 0.32), F + 0.12, zb + BAY / 2], [s * (W - 0.32), F + 0.72, zb + BAY / 2], 0.02, '#8e939a', 6);
    }
  }
  // ---- vestibules: grab poles, glass screens to the seats (with a rail), the ski rack at the front door
  for (const dz of doorZs()) {
    for (const s of [1, -1]) m.bar([s * 0.5, F, dz], [s * 0.5, vaultY(0.5), dz], 0.02, STEEL, 8);
    for (const s of [1, -1]) {
      const zs = dz + (dz > 0 ? -0.75 : 0.75);
      g.tx = TX.laminate;
      g.box(s * (W - 0.3), F + 0.55, zs, 0.6, 1.1, 0.04, '#b8bcc2');
      m.bar([s * (W - 0.6), F + 1.1, zs], [s * (W - 0.02), F + 1.1, zs], 0.016, STEEL, 5);
    }
  }
  g.tx = TX.metal;
  for (let k = 0; k < 6; k++) g.box(-(W - 0.08), F + 0.45, DOOR_F + 0.95 + k * 0.1, 0.12, 0.9, 0.03, '#3a3e44');
  // ---- rear wall with the gangway door (and its window), a display over it
  g.tx = TX.laminate;
  g.box(0, (F + CEIL_Y) / 2, zA + 0.01, W * 2, CEIL_Y - F, 0.04, PANEL);
  g.box(0, F + 1.02, zA + 0.035, 0.94, 2.06, 0.02, '#8f949b');
  g.box(0, F + 1.02, zA + 0.045, 0.84, 1.98, 0.02, '#a9adb3');
  g.box(0, F + 1.5, zA + 0.056, 0.5, 0.7, 0.004, '#1c232b');
  m.tx = TX.metal;
  m.bar([0.32, F + 1.0, zA + 0.08], [0.32, F + 1.22, zA + 0.08], 0.012, STEEL, 5);
  // ---- the front bulkhead: kick plate and lower panel, windows either side of the cab door, a header with the
  // route display (glass, door window and display in buildCar)
  const BK = { z: zB, sill: F + 0.92, head: F + 2.06, door: 0.38 };
  g.tx = TX.laminate;
  g.box(0, (F + BK.sill) / 2, BK.z, W * 2, BK.sill - F, 0.05, PANEL);
  g.box(0, F + 0.08, BK.z - 0.03, W * 2, 0.16, 0.012, '#5b5f66');
  g.box(0, (BK.head + CEIL_Y) / 2 + 0.01, BK.z, W * 2, CEIL_Y - BK.head + 0.06, 0.05, PANEL);
  for (const s of [1, -1]) {
    // window frames (dark trim) and the posts between the windows and the door
    const xo = s * (W - 0.04), xi = s * (BK.door + 0.05);
    g.box((xo + xi) / 2, BK.sill + 0.02, BK.z - 0.03, Math.abs(xo - xi), 0.04, 0.03, '#2a2d31');
    g.box((xo + xi) / 2, BK.head - 0.02, BK.z - 0.03, Math.abs(xo - xi), 0.04, 0.03, '#2a2d31');
    g.box(xo, (BK.sill + BK.head) / 2, BK.z, 0.08, BK.head - BK.sill, 0.05, PANEL);
    g.box(xi, (F + BK.head) / 2, BK.z, 0.1, BK.head - F, 0.06, '#2a2d31');
  }
  m.tx = TX.metal;
  for (const s of [1, -1]) m.bar([s * (BK.door + 0.16), F + 0.84, BK.z - 0.09], [s * (W - 0.14), F + 0.84, BK.z - 0.09], 0.016, STEEL, 6);
  g.tx = TX.laminate;
  for (const x of [-0.95, 0.95]) g.box(x, (BK.head + CEIL_Y) / 2, BK.z - 0.027, 0.008, CEIL_Y - BK.head, 0.004, '#a19f99');
  // the cab door: a leaf with a tall window, its handle
  g.box(0, F + 0.46, BK.z - 0.005, BK.door * 2, 0.92, 0.035, '#9aa0a8');
  g.box(0, BK.head - 0.06, BK.z - 0.005, BK.door * 2, 0.12, 0.035, '#9aa0a8');
  for (const s of [1, -1]) g.box(s * (BK.door - 0.04), (BK.sill + BK.head) / 2, BK.z - 0.005, 0.08, BK.head - BK.sill, 0.035, '#9aa0a8');
  m.tx = TX.metal;
  m.bar([BK.door - 0.12, F + 1.0, BK.z - 0.05], [BK.door - 0.12, F + 1.18, BK.z - 0.05], 0.012, STEEL, 5);
  // ---- the cab: the driver's desk (a raked console with screens and levers), the cab's own ceiling
  g.tx = TX.laminate;
  g.box(0, F + 0.45, H - 0.6, 2.2, 0.9, 0.5, '#2b2e33');
  g.at(0, F + 0.96, H - 0.66, 0, -0.5, 0); g.box(0, 0, 0, 2.16, 0.05, 0.5, '#3a3e45'); g.reset();
  for (const x of [-0.78, -0.38]) { g.at(x, F + 0.99, H - 0.66, 0, -0.5, 0); g.box(0, 0.03, 0, 0.32, 0.01, 0.2, '#0c0f13'); g.reset(); }
  m.tx = TX.metal;
  for (const x of [0.1, 0.24]) m.bar([x, F + 0.98, H - 0.72], [x, F + 1.12, H - 0.8], 0.012, '#2a2d31', 5);
  g.tx = TX.ceiling;
  g.grid([xs.map((x) => [x * 1.25, vaultY(x) - 0.02, zB]), xs.map((x) => [x * 1.2, vaultY(x) - 0.05, H - 0.6])], '#d6d4ce');
  g.tx = TX.laminate;
  seats.inst = seatInst;
  seats.bulkhead = BK;
  return seats;
}
