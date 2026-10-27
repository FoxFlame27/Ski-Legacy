// Small toolkit for the course meshes: a fast vertex-coloured mesh builder (primitives written straight
// into typed arrays, so thousands of posts / rails / blocks merge into one draw call), house-style
// banner textures (Node-safe: no canvas -> no texture), and ground-placement helpers.
import * as THREE from 'three';
import { world } from '../../world/world.js';

export const HAS_DOM = typeof document !== 'undefined';
export const BLUE = '#1546c8';
export const FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

const _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _c = new THREE.Color();

// ------------------------------------------------------------------ mesh builder
export class MeshBuilder {
  constructor({ uv = false } = {}) {
    this.P = []; this.N = []; this.C = []; this.U = uv ? [] : null; this.I = [];
    this.m = new THREE.Matrix4();
    this.nm = new THREE.Matrix3();
  }
  get count() { return this.P.length / 3; }
  // transform for the next primitives: position + yaw (+ optional pitch/roll / scale)
  at(x, y, z, yaw = 0, pitch = 0, roll = 0, sx = 1, sy = 1, sz = 1) {
    const e = new THREE.Euler(pitch, yaw, roll, 'YXZ');
    this.m.compose(_v.set(x, y, z), new THREE.Quaternion().setFromEuler(e), _w.set(sx, sy, sz));
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  setMatrix(m4) { this.m.copy(m4); this.nm.getNormalMatrix(m4); return this; }
  // raw vertex in local space
  v(x, y, z, nx, ny, nz, col, u = 0, w = 0) {
    _v.set(x, y, z).applyMatrix4(this.m);
    this.P.push(_v.x, _v.y, _v.z);
    _w.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.N.push(_w.x, _w.y, _w.z);
    this.C.push(col.r, col.g, col.b);
    if (this.U) this.U.push(u, w);
    return this.P.length / 3 - 1;
  }
  tri(a, b, c) { this.I.push(a, b, c); }
  quad(a, b, c, d) { this.I.push(a, b, c, a, c, d); }

  // axis-aligned box centred at (cx, cy, cz) in local space (flat shaded)
  box(cx, cy, cz, sx, sy, sz, col, colTop = col) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const F = [
      [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
      [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
      [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    ];
    for (const [n, q] of F) {
      const c = n[1] > 0 ? colTop : col;
      const i0 = this.v(cx + q[0][0], cy + q[0][1], cz + q[0][2], n[0], n[1], n[2], c, 0, 0);
      const i1 = this.v(cx + q[1][0], cy + q[1][1], cz + q[1][2], n[0], n[1], n[2], c, 1, 0);
      const i2 = this.v(cx + q[2][0], cy + q[2][1], cz + q[2][2], n[0], n[1], n[2], c, 1, 1);
      const i3 = this.v(cx + q[3][0], cy + q[3][1], cz + q[3][2], n[0], n[1], n[2], c, 0, 1);
      this.quad(i0, i1, i2, i3);
    }
    return this;
  }

  // cylinder / cone along local +Y from y0 to y0 + h (smooth sides, optional caps)
  cyl(x, y0, z, r0, r1, h, seg, col, { top = true, bottom = false, colTop = col } = {}) {
    const base = this.count;
    const slope = (r0 - r1) / h;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const nl = Math.hypot(1, slope);
      this.v(x + ca * r0, y0, z + sa * r0, ca / nl, slope / nl, sa / nl, col, i / seg, 0);
      this.v(x + ca * r1, y0 + h, z + sa * r1, ca / nl, slope / nl, sa / nl, col, i / seg, 1);
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.quad(a, a + 1, a + 3, a + 2); }
    if (top && r1 > 0.001) {
      const c0 = this.v(x, y0 + h, z, 0, 1, 0, colTop);
      const r = [];
      for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; r.push(this.v(x + Math.cos(a) * r1, y0 + h, z + Math.sin(a) * r1, 0, 1, 0, colTop)); }
      for (let i = 0; i < seg; i++) this.tri(c0, r[i + 1], r[i]);
    }
    if (bottom) {
      const c0 = this.v(x, y0, z, 0, -1, 0, col);
      const r = [];
      for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; r.push(this.v(x + Math.cos(a) * r0, y0, z + Math.sin(a) * r0, 0, -1, 0, col)); }
      for (let i = 0; i < seg; i++) this.tri(c0, r[i], r[i + 1]);
    }
    return this;
  }

  // cylinder between two local points (for rails, braces, ropes)
  rod(ax, ay, az, bx, by, bz, r, seg, col) {
    const d = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const len = d.length();
    if (len < 1e-5) return this;
    const save = this.m.clone();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const local = new THREE.Matrix4().compose(new THREE.Vector3(ax, ay, az), q, new THREE.Vector3(1, 1, 1));
    this.setMatrix(save.clone().multiply(local));
    this.cyl(0, 0, 0, r, r, len, seg, col, { top: false });
    this.setMatrix(save);
    return this;
  }

  // smooth-shaded blob: a unit icosphere displaced by radiusFn(nx, ny, nz), coloured by colFn
  blob(cx, cy, cz, radiusFn, detail, colFn) {
    const { V, I } = icoTopology(detail);
    const base = this.count;
    const nv = V.length / 3;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3);
    for (let k = 0; k < nv; k++) {
      const x = V[k * 3], y = V[k * 3 + 1], z = V[k * 3 + 2], r = radiusFn(x, y, z);
      P[k * 3] = x * r; P[k * 3 + 1] = y * r; P[k * 3 + 2] = z * r;
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
    }
    for (let k = 0; k < nv; k++) {
      const l = Math.hypot(N[k * 3], N[k * 3 + 1], N[k * 3 + 2]) || 1;
      const ny = N[k * 3 + 1] / l;
      this.v(cx + P[k * 3], cy + P[k * 3 + 1], cz + P[k * 3 + 2], N[k * 3] / l, ny, N[k * 3 + 2] / l, colFn(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], ny));
    }
    for (let t = 0; t < I.length; t += 3) this.tri(base + I[t], base + I[t + 1], base + I[t + 2]);
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (this.U) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// indexed unit icosphere (welded), cached per detail level
const icoCache = new Map();
function icoTopology(detail) {
  if (icoCache.has(detail)) return icoCache.get(detail);
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const map = new Map(), V = [], I = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let k = map.get(key);
    if (k === undefined) { k = V.length / 3; map.set(key, k); V.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    I.push(k);
  }
  geo.dispose();
  const t = { V: new Float32Array(V), I: new Uint32Array(I) };
  icoCache.set(detail, t);
  return t;
}

// colour with a little deterministic variation
export function tint(hex, amount = 0, seed = 0) {
  _c.set(hex);
  if (amount) {
    const r = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    const k = 1 + (r - Math.floor(r) - 0.5) * 2 * amount;
    _c.multiplyScalar(k);
  }
  return _c.clone();
}

// ------------------------------------------------------------------ materials
export function vcMaterial(o = {}) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, ...o });
}

// ------------------------------------------------------------------ canvas textures
const FONT_PROBE = `italic 700 48px ${FONT}`;
export function canvasTexture(w, h, draw, { wrap = false, anisotropy = 8 } = {}) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // the race font may still be loading: redraw once it's ready
  try {
    if (document.fonts && !document.fonts.check(FONT_PROBE)) {
      document.fonts.load(FONT_PROBE).then(() => { g.clearRect(0, 0, w, h); draw(g, w, h); t.needsUpdate = true; }).catch(() => {});
    }
  } catch { /* font API unavailable */ }
  return t;
}

// House-style banner: white field, blue italic condensed lettering, thin accent stripes.
export function bannerTexture(text, { w = 1024, h = 256, bg = '#ffffff', fg = BLUE, stripe = BLUE, stripe2 = '#e2231a', sub = '', size = 0.62, align = 'center' } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    const sh = Math.round(h * 0.07);
    g.fillStyle = stripe; g.fillRect(0, 0, w, sh); g.fillRect(0, h - sh, w, sh);
    if (stripe2) { g.fillStyle = stripe2; g.fillRect(0, sh, w, Math.round(sh * 0.45)); g.fillRect(0, h - sh - Math.round(sh * 0.45), w, Math.round(sh * 0.45)); }
    g.fillStyle = fg;
    g.textAlign = align; g.textBaseline = 'middle';
    let fs = Math.round(h * size * (sub ? 0.82 : 1));
    g.font = `italic 700 ${fs}px ${FONT}`;
    while (g.measureText(text).width > w * 0.9 && fs > 10) { fs -= 4; g.font = `italic 700 ${fs}px ${FONT}`; }
    const x = align === 'center' ? w / 2 : w * 0.05;
    g.fillText(text, x, h * (sub ? 0.43 : 0.52));
    if (sub) {
      g.font = `italic 600 ${Math.round(h * 0.17)}px ${FONT}`;
      g.globalAlpha = 0.85;
      g.fillText(sub, x, h * 0.76);
      g.globalAlpha = 1;
    }
  });
}

// ------------------------------------------------------------------ ground helpers
// The snow surface as it is RENDERED near the camera: terrain.js meshes world.height on a 2 m grid
// aligned to world multiples of 2 m, triangulated (a, c, b) / (b, c, d) per cell. Between the grid
// points the visible snow is that planar interpolation, which can sit ~0.1-0.3 m off the exact
// heightfield on snow berms. Posts, net panels and dye lines are placed on THIS surface so they meet
// the snow exactly where the player sees it. Grid heights are cached per build (cleared by the caller).
const MESH_STEP = 2;
const meshCache = new Map();
function gridH(i, j) {
  const key = i * 131072 + j;
  let h = meshCache.get(key);
  if (h === undefined) { h = world.height(i * MESH_STEP, j * MESH_STEP); meshCache.set(key, h); }
  return h;
}
export function meshGround(x, z) {
  const gx = x / MESH_STEP, gz = z / MESH_STEP;
  const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
  const h10 = gridH(i + 1, j), h01 = gridH(i, j + 1);
  if (fx + fz <= 1) { const h00 = gridH(i, j); return h00 + (h10 - h00) * fx + (h01 - h00) * fz; }
  const h11 = gridH(i + 1, j + 1);
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}
export function clearMeshGround() { meshCache.clear(); }

// lowest terrain height under a rotated rectangle footprint (so structures never float)
export function footprintMin(x, z, yaw, hw, hd, n = 3) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let m = Infinity;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const lx = (i / n) * hw, lz = (j / n) * hd;
    m = Math.min(m, world.height(x + lx * c + lz * s, z - lx * s + lz * c));
  }
  return m;
}
export function footprintMax(x, z, yaw, hw, hd, n = 3) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let m = -Infinity;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const lx = (i / n) * hw, lz = (j / n) * hd;
    m = Math.max(m, world.height(x + lx * c + lz * s, z - lx * s + lz * c));
  }
  return m;
}

export function shadowed(obj, cast = true, receive = true) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
}
