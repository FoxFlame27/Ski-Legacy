// Spectators at the race finish arenas: standing rows behind the boards along the finish straight (denser
// toward the line) and fans on the grandstand steps. The fans are real people (world/fans.js: eight rigged
// characters in winter clothes, instanced with a per-fan skeleton, procedural cheering, three LODs): they
// cheer when a racer comes down the finish straight, go wild when one crosses the line or crowds.cheer() is
// called, and the ones near the racer turn their heads and cheer as it passes. Until the character models
// have loaded (or if they are missing) the low-poly instanced figures below stand in.
//
// Resort arenas (layout.races with arena: true) are populated once at boot (addResortArenas); the World
// Racing courses are adopted as they are built (update(..., { course, courseGroup })): their static crowd
// is replaced by animated figures in the same spots and their grandstands are filled.
import * as THREE from 'three';
import { world } from './world.js';
import { layout, PISTE_WIDTH } from './layout.js';
import { save } from '../game/economy.js';
import { quality } from '../engine/quality.js';
import { loadFanKits, FanCrowd } from './fans.js';
import { meshGround } from '../modes/parkour/kit.js';

// ------------------------------------------------------------------ shared helpers (snowcats / flags use them)
// Graphics preset -> 0 (performance) .. 4 (ultra). engine/quality.js holds the live preset (it may drop a level
// while playing); older preset names still map.
const QUALITY_LEVEL = { performance: 0, low: 1, balanced: 2, medium: 2, high: 3, ultra: 4 };
export function qualityLevel(q = quality.name || save.quality) { return QUALITY_LEVEL[q] ?? 3; }

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segDist(px, pz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
  let t = ((px - ax) * ex + (pz - az) * ez) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + ex * t - px, dz = az + ez * t - pz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Static index of the resort's runs, lift lines and safety nets (built from the layout once), for placing
 * props beside the snow the skiers use. clearance(x, z) = metres outside the nearest piste / race corridor
 * (negative = on the run); `skip` ignores one owner (a race's own course).
 */
export class RunIndex {
  constructor() {
    this.runs = []; this.races = []; this.lifts = []; this.nets = [];
    const chunk = (pts, w, owner, out, get = (p) => p) => {
      for (let i = 0; i < pts.length - 1; i += 12) {
        const part = pts.slice(i, Math.min(pts.length, i + 13)).map(get);
        let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
        for (const [x, z] of part) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
        out.push({ part, w, owner, minx: minx - w, maxx: maxx + w, minz: minz - w, maxz: maxz + w });
      }
    };
    for (const p of layout.pistes) chunk(p.pts, PISTE_WIDTH[p.diff], p, this.runs);
    for (const r of layout.races) { chunk(r.path, r.halfWidth, r, this.runs); chunk(r.path, r.halfWidth, r, this.races); }
    for (const l of layout.lifts) this.lifts.push({ l, ax: l.bottom.x, az: l.bottom.z, bx: l.top.x, bz: l.top.z, w: l.type === 'gondola' ? 7 : 5 });
    for (const n of layout.nets || []) chunk(n.line, 0, n, this.nets, (p) => [p[0], p[1]]);
  }
  _near(list, x, z, reach, skip) {
    let best = Infinity, who = null;
    for (const c of list) {
      if (c.owner === skip || x < c.minx - reach || x > c.maxx + reach || z < c.minz - reach || z > c.maxz + reach) continue;
      const P = c.part;
      for (let k = 1; k < P.length; k++) {
        const d = segDist(x, z, P[k - 1][0], P[k - 1][1], P[k][0], P[k][1]) - c.w;
        if (d < best) { best = d; who = c.owner; }
      }
    }
    this.nearest = who;
    return best;
  }
  clearance(x, z, skip = null, reach = 40) { return this._near(this.runs, x, z, reach, skip); }
  raceClearance(x, z, reach = 40) { return this._near(this.races, x, z, reach, null); }
  netDist(x, z, reach = 10) { return this._near(this.nets, x, z, reach, null); }
  liftDist(x, z) {
    let best = Infinity;
    for (const s of this.lifts) best = Math.min(best, segDist(x, z, s.ax, s.az, s.bx, s.bz) - s.w);
    return best;
  }
}
let runIndex = null;
export function getRunIndex() { return (runIndex ??= new RunIndex()); }

/** Is (x, z) within `margin` of a collider ({x, z, r} | oriented box {x, z, hw, hd, rot})? */
export function hitsCollider(colliders, x, z, margin = 0.3) {
  for (const c of colliders) {
    const reach = (c.r ?? Math.max(c.hw, c.hd)) + margin;
    if (Math.abs(x - c.x) > reach || Math.abs(z - c.z) > reach) continue;
    if (c.r !== undefined) { if (Math.hypot(x - c.x, z - c.z) < c.r + margin) return true; continue; }
    const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
    const lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
    if (Math.abs(lx) < c.hw + margin && Math.abs(lz) < c.hd + margin) return true;
  }
  return false;
}

// level enough to stand on (max height step over +-r)
function levelAt(x, z, r = 0.6, tol = 0.38) {
  const y = world.height(x, z);
  return Math.abs(world.height(x + r, z) - y) < tol && Math.abs(world.height(x, z + r) - y) < tol
    && Math.abs(world.height(x - r, z) - y) < tol && Math.abs(world.height(x, z - r) - y) < tol;
}

// ------------------------------------------------------------------ the figure
// Local frame: feet at y = 0, facing +z. aPart.x: 0 body, 1 left arm, 2 right arm (rotate about the
// shoulder); aPart.y: colour source 0 vertex colour, 1 jacket (instance colour), 2 accent (beanie),
// 3 trousers, 4 hand-flag cloth (accent), 5 flag stick (both hidden unless the fan holds a flag).
class FigureBuilder {
  constructor() { this.P = []; this.N = []; this.C = []; this.A = []; this.I = []; }
  v(x, y, z, nx, ny, nz, c, part) {
    this.P.push(x, y, z); this.N.push(nx, ny, nz); this.C.push(c.r, c.g, c.b); this.A.push(part[0], part[1]);
    return this.P.length / 3 - 1;
  }
  box(cx, cy, cz, sx, sy, sz, col, part) {
    const c = new THREE.Color(col), hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const F = [
      [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
      [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
      [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    ];
    for (const [n, q] of F) {
      const i = q.map((p) => this.v(cx + p[0], cy + p[1], cz + p[2], n[0], n[1], n[2], c, part));
      this.I.push(i[0], i[1], i[2], i[0], i[2], i[3]);
    }
  }
  // tapered cylinder along +y (smooth sides, top cap)
  cyl(x, y0, z, r0, r1, h, seg, col, part) {
    const c = new THREE.Color(col), base = this.P.length / 3, sl = (r0 - r1) / h, nl = Math.hypot(1, sl);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      this.v(x + ca * r0, y0, z + sa * r0, ca / nl, sl / nl, sa / nl, c, part);
      this.v(x + ca * r1, y0 + h, z + sa * r1, ca / nl, sl / nl, sa / nl, c, part);
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.I.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    if (r1 > 0.001) {
      const c0 = this.v(x, y0 + h, z, 0, 1, 0, c, part), ring = [];
      for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; ring.push(this.v(x + Math.cos(a) * r1, y0 + h, z + Math.sin(a) * r1, 0, 1, 0, c, part)); }
      for (let i = 0; i < seg; i++) this.I.push(c0, ring[i + 1], ring[i]);
    }
  }
  // two-sided quad in the x-y plane at depth z
  card(x0, y0, x1, y1, z, col, part) {
    const c = new THREE.Color(col);
    for (const s of [1, -1]) {
      const a = this.v(x0, y0, z, 0, 0, s, c, part), b = this.v(x1, y0, z, 0, 0, s, c, part);
      const d = this.v(x1, y1, z, 0, 0, s, c, part), e = this.v(x0, y1, z, 0, 0, s, c, part);
      if (s > 0) this.I.push(a, b, d, a, d, e); else this.I.push(a, d, b, a, e, d);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.A, 2));
    g.setIndex(this.I);
    g.computeBoundingSphere();
    return g;
  }
}

const SHOULDER_X = 0.285, SHOULDER_Y = 1.4;
let figureGeo = null;
function figureGeometry() {
  if (figureGeo) return figureGeo;
  const b = new FigureBuilder();
  const W = '#ffffff', boot = '#25272b', skin = '#dfb08c', glove = '#1c1e22';
  for (const sx of [-1, 1]) {
    b.box(sx * 0.1, 0.065, 0.03, 0.13, 0.13, 0.28, boot, [0, 0]);
    b.box(sx * 0.1, 0.5, 0, 0.16, 0.76, 0.2, W, [0, 3]);
  }
  b.box(0, 1.1, 0, 0.45, 0.64, 0.28, W, [0, 1]);          // jacket
  b.box(0, 1.43, 0, 0.24, 0.06, 0.2, W, [0, 1]);          // collar
  b.cyl(0, 1.44, 0, 0.098, 0.1, 0.22, 8, skin, [0, 0]);   // head
  b.box(0, 1.575, 0.082, 0.17, 0.055, 0.05, '#17191d', [0, 0]); // goggles: the face reads at a distance
  b.cyl(0, 1.6, 0, 0.11, 0.065, 0.13, 8, W, [0, 2]);      // beanie
  b.cyl(0, 1.725, 0, 0.045, 0.0, 0.06, 5, W, [0, 2]);
  for (const [sx, part] of [[-1, 1], [1, 2]]) {
    b.box(sx * SHOULDER_X, 1.12, 0, 0.12, 0.57, 0.14, W, [part, 1]);
    b.box(sx * SHOULDER_X, 0.8, 0.01, 0.105, 0.1, 0.12, glove, [part, 0]);
  }
  // a small flag in the right hand (stick hangs below the glove while the arm is down, up when raised)
  b.box(SHOULDER_X, 0.5, 0.03, 0.022, 0.62, 0.022, '#d9d9d9', [2, 5]);
  b.card(SHOULDER_X + 0.01, 0.2, SHOULDER_X + 0.47, 0.5, 0.03, W, [2, 4]);
  figureGeo = b.build();
  return figureGeo;
}

// sRGB palette -> linear colours (instance colours are linear)
const JACKETS = ['#d9221c', '#1546c8', '#f4f6fa', '#1d2533', '#ff8a1c', '#2c9b5a', '#f2c230', '#7b2fbf', '#e8467c', '#3fa9f5', '#c8261d', '#0f3d91', '#4a4f57', '#ffffff'];
const ACCENTS = ['#d9221c', '#ffffff', '#1546c8', '#f2c230', '#ff8a1c', '#1d2533', '#2c9b5a', '#e8467c'];

const VERT_HEAD = /* glsl */`
uniform float uTime;
uniform float uCheer;
attribute vec2 aPart;
attribute vec3 aAccent;
attribute vec4 aAnim; // phase, liveliness, holds a flag, trouser shade
vec3 crowdRot(vec3 v, float aL, float aR, float tL, float tR) {
  if (aPart.x > 0.5) {
    float side = aPart.x < 1.5 ? -1.0 : 1.0;
    float a = aPart.x < 1.5 ? -aL : aR, t = aPart.x < 1.5 ? tL : tR;
    float c = cos(a), s = sin(a);
    v = vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
    c = cos(t); s = sin(t);
    v = vec3(v.x, v.y * c - v.z * s, v.z * c + v.y * s);
  }
  return v;
}
`;
const VERT_ANGLES = /* glsl */`
  float ph = aAnim.x * 6.2832;
  float hasFlag = aAnim.z;
  float th = 0.06 + 0.5 * fract(aAnim.x * 7.31);           // this fan joins the cheer above this level
  float cheerI = smoothstep(th, th + 0.1, uCheer);
  float idleWave = aAnim.y * smoothstep(0.86, 0.96, sin(uTime * 0.31 + ph * 3.0));
  float upR = max(max(cheerI, idleWave), hasFlag);
  float upL = cheerI * step(0.3, fract(aAnim.x * 3.7));
  float wob = sin(uTime * (6.0 + aAnim.y * 3.0) + ph);
  float aR = mix(0.07 + 0.04 * sin(uTime * 0.9 + ph), 2.7 + 0.28 * wob, upR);
  float aL = mix(0.06 + 0.03 * sin(uTime * 0.8 + ph * 1.3), 2.7 - 0.28 * wob, upL);
  float tR = 0.3 * upR, tL = 0.3 * upL;
  float sway = sin(uTime * 0.55 + ph) * 0.14 * (1.0 - cheerI * 0.6);
  float cs = cos(sway), sn = sin(sway);
  float jump = cheerI * max(0.0, sin(uTime * 7.5 + ph)) * 0.1 * step(0.45, fract(aAnim.x * 5.3));
  vec3 pivot = vec3(aPart.x < 1.5 ? -${SHOULDER_X} : ${SHOULDER_X}, ${SHOULDER_Y}, 0.0);
`;

function patchCrowdShader(s, uniforms, depth) {
  s.uniforms.uTime = uniforms.uTime;
  s.uniforms.uCheer = uniforms.uCheer;
  // the arm / sway / jump deformation of the local position (angles from VERT_ANGLES)
  const deform = `
    {
      if (aPart.y > 3.5 && hasFlag < 0.5) transformed = pivot; // no flag in this hand: collapse it
      if (aPart.y > 3.5 && aPart.y < 4.5) transformed.z += sin(uTime * 9.0 + transformed.x * 13.0 + ph) * 0.05 * (transformed.x - ${SHOULDER_X});
      if (aPart.x > 0.5) transformed = pivot + crowdRot(transformed - pivot, aL, aR, tL, tR);
      transformed = vec3(transformed.x * cs + transformed.z * sn, transformed.y + jump, transformed.z * cs - transformed.x * sn);
    }`;
  let v = s.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_HEAD);
  if (depth) {
    v = v.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_ANGLES + deform);
  } else {
    v = v
      .replace('#include <color_vertex>', `#include <color_vertex>
        {
          float tc = aPart.y;
          vec3 trousers = aAnim.w > 0.86 ? vec3(0.55, 0.57, 0.6) : mix(vec3(0.012, 0.014, 0.02), vec3(0.05, 0.06, 0.09), aAnim.w);
          vColor.rgb = tc < 0.5 || tc > 4.5 ? color.rgb : tc < 1.5 ? instanceColor.rgb : tc < 2.5 || tc > 3.5 ? aAccent : trousers;
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        ${VERT_ANGLES}
        objectNormal = crowdRot(objectNormal, aL, aR, tL, tR);
        objectNormal = vec3(objectNormal.x * cs + objectNormal.z * sn, objectNormal.y, objectNormal.z * cs - objectNormal.x * sn);`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + deform);
  }
  s.vertexShader = v;
}

function crowdMaterials(shadows) {
  const uniforms = { uTime: CROWD_TIME, uCheer: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  mat.onBeforeCompile = (s) => patchCrowdShader(s, uniforms, false);
  mat.customProgramCacheKey = () => 'crowd-figure-v1';
  let depth = null;
  if (shadows) {
    depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (s) => patchCrowdShader(s, uniforms, true);
    depth.customProgramCacheKey = () => 'crowd-figure-depth-v1';
  }
  return { mat, depth, uniforms };
}
const CROWD_TIME = { value: 0 };

// ------------------------------------------------------------------ grandstand analysis
// Standing surfaces of a grandstand model: the treads of its steps, found from its up-facing triangles
// (in the model's own space), cached per model. Front = the low side.
const standCache = new WeakMap();
function analyseStand(gltf) {
  if (standCache.has(gltf)) return standCache.get(gltf);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const faces = []; // [x, y, z] centroids of up-facing triangles
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      box.expandByPoint(a);
      e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2);
      const l = e1.length();
      if (l < 1e-9 || e1.y / l < 0.86) continue;
      faces.push((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
    }
  });
  const W = box.max.x - box.min.x, D = box.max.z - box.min.z, H = box.max.y - box.min.y;
  // top surface per depth bin over the central half of the width
  const NB = 120, top = new Float32Array(NB).fill(-Infinity);
  const xc = (box.min.x + box.max.x) / 2;
  for (let i = 0; i < faces.length; i += 3) {
    if (Math.abs(faces[i] - xc) > W * 0.3) continue;
    const k = Math.min(NB - 1, Math.floor(((faces[i + 2] - box.min.z) / D) * NB));
    if (faces[i + 1] > top[k]) top[k] = faces[i + 1];
  }
  // front (low) side
  let lo = 0, hi = 0;
  for (let k = 0; k < NB / 3; k++) { if (top[k] > -Infinity) lo += top[k]; if (top[NB - 1 - k] > -Infinity) hi += top[NB - 1 - k]; }
  const frontSign = lo < hi ? -1 : 1; // the front faces -z when the -z end is the low one
  // plateaus: runs of bins at one height
  const tol = H * 0.03, plateaus = [];
  let run = null;
  for (let k = 0; k <= NB; k++) {
    const y = k < NB ? top[k] : NaN;
    if (run && Number.isFinite(y) && Math.abs(y - run.y) < tol) { run.k1 = k; continue; }
    if (run) plateaus.push(run);
    run = Number.isFinite(y) ? { k0: k, k1: k, y } : null;
  }
  const treads = plateaus.filter((p) => p.y > box.min.y + H * 0.04 && p.y < box.max.y - H * 0.06).map((p) => {
    const z0 = box.min.z + (p.k0 / NB) * D, z1 = box.min.z + ((p.k1 + 1) / NB) * D;
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < faces.length; i += 3) {
      if (faces[i + 2] < z0 || faces[i + 2] > z1 || Math.abs(faces[i + 1] - p.y) > tol) continue;
      x0 = Math.min(x0, faces[i]); x1 = Math.max(x1, faces[i]);
    }
    return { y: p.y, z0, z1, x0, x1 };
  });
  const out = { treads, frontSign, box };
  standCache.set(gltf, out);
  return out;
}

// Every placed copy of a model under `root`: world matrix of the model's own space (shares geometry).
function findModelInstances(root, gltf) {
  if (!gltf || !root) return [];
  const src = new Map();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh) src.set(o.geometry, o.matrixWorld); });
  const out = [], seen = [];
  const inv = new THREE.Matrix4();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !src.has(o.geometry)) return;
    const m = new THREE.Matrix4().multiplyMatrices(o.matrixWorld, inv.copy(src.get(o.geometry)).invert());
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    if (seen.some((q) => q.distanceToSquared(p) < 1)) return;
    seen.push(p);
    out.push(m);
  });
  return out;
}

// Fans standing on the treads of every copy of the grandstand under `root`.
function standSpots(root, gltf, rnd, density, spots) {
  if (!gltf) return;
  const A = analyseStand(gltf);
  if (!A.treads.length) return;
  const p = new THREE.Vector3(), f = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
  for (const M of findModelInstances(root, gltf)) {
    M.decompose(p, q, s);
    const scale = s.x;
    f.set(0, 0, A.frontSign).applyQuaternion(q);
    const yaw = Math.atan2(f.x, f.z);
    for (const t of A.treads) {
      if ((t.z1 - t.z0) * scale < 0.38) continue; // too shallow to stand on
      // stand on the front half of the tread
      const zl = A.frontSign < 0 ? t.z0 + (t.z1 - t.z0) * 0.42 : t.z1 - (t.z1 - t.z0) * 0.42;
      const step = 0.6 / scale;
      for (let xl = t.x0 + 0.35 / scale; xl < t.x1 - 0.3 / scale; xl += step) {
        if (rnd() > 0.82 * density) continue;
        p.set(xl + (rnd() - 0.5) * 0.15 / scale, t.y, zl + (rnd() - 0.5) * 0.1 / scale).applyMatrix4(M);
        spots.push({ x: p.x, y: p.y, z: p.z, yaw: yaw + (rnd() - 0.5) * 0.3, stand: true });
      }
    }
  }
}

// ------------------------------------------------------------------ crowd sets
class CrowdSet {
  constructor(spots, rnd, { shadows, finish, parent, name }) {
    const n = spots.length;
    const geo = figureGeometry();
    const { mat, depth, uniforms } = crowdMaterials(shadows);
    this.uniforms = uniforms;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = name;
    if (depth) mesh.customDepthMaterial = depth;
    const accent = new Float32Array(n * 3), anim = new Float32Array(n * 4);
    const d = new THREE.Object3D(), col = new THREE.Color();
    let cx = 0, cz = 0, cy = 0;
    spots.forEach((sp, k) => {
      if (sp.matrix) mesh.setMatrixAt(k, sp.matrix);
      else {
        d.position.set(sp.x, sp.y - 0.03, sp.z);
        d.rotation.set(0, sp.yaw, 0);
        const sc = 0.9 + rnd() * 0.17;
        d.scale.set(sc, sc * (0.96 + rnd() * 0.08), sc);
        d.updateMatrix();
        mesh.setMatrixAt(k, d.matrix);
      }
      mesh.setColorAt(k, sp.color ? col.copy(sp.color) : col.set(JACKETS[Math.floor(rnd() * JACKETS.length)]));
      col.set(ACCENTS[Math.floor(rnd() * ACCENTS.length)]);
      accent[k * 3] = col.r; accent[k * 3 + 1] = col.g; accent[k * 3 + 2] = col.b;
      anim[k * 4] = rnd();
      anim[k * 4 + 1] = rnd() < 0.35 ? 0.4 + rnd() * 0.6 : rnd() * 0.25;
      anim[k * 4 + 2] = !sp.stand && rnd() < 0.09 ? 1 : 0; // a few flag wavers along the boards
      anim[k * 4 + 3] = rnd();
      cx += sp.x; cy += sp.y; cz += sp.z;
    });
    mesh.geometry = geo.clone(); // per-set instanced attributes (the base buffers are small)
    mesh.geometry.setAttribute('aAccent', new THREE.InstancedBufferAttribute(accent, 3));
    mesh.geometry.setAttribute('aAnim', new THREE.InstancedBufferAttribute(anim, 4));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = !!shadows; mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    this.mesh = mesh;
    this.center = new THREE.Vector3(cx / n, cy / n, cz / n);
    this.finish = finish; // { x, z, dx, dz, hw } or null
    this.prevAlong = NaN;
    this.cheer = 0; this.burst = 0;
    parent.add(mesh);
    this.parent = parent;
  }
  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.customDepthMaterial?.dispose();
    this.mesh.dispose?.();
  }
}

// ------------------------------------------------------------------ real fans
// Spots for real people: no two closer than 0.62 m (0.52 m side by side on a grandstand), feet on the snow and
// how much room each one has beside it (`free`, m to the nearest neighbour: arms out wide / flags only with room).
// `ground` is the visible snow: the 2 m grid triangulation the near terrain LOD draws (meshGround), not the
// smooth heightfield, which leaves a person floating above convex snow. Boots stand on the low side of the
// ground under them; spots on banks steeper than ~30 degrees are skipped.
function fanSpots(spots, ground, clear = null) {
  const out = [], cell = new Map(), R = 0.62;
  const key = (x, z) => `${Math.floor(x / R)},${Math.floor(z / R)}`;
  for (const sp of spots) {
    const x = sp.x, z = sp.z;
    let clash = false;
    for (let i = -1; i <= 1 && !clash; i++) for (let j = -1; j <= 1 && !clash; j++) {
      for (const o of cell.get(`${Math.floor(x / R) + i},${Math.floor(z / R) + j}`) || []) {
        const r = sp.stand && o.stand ? 0.52 : R; // shoulder to shoulder on the grandstand steps
        if ((o.x - x) ** 2 + (o.z - z) ** 2 < r * r) { clash = true; break; }
      }
    }
    if (clash || (clear && !clear(x, z))) continue;
    const q = { ...sp };
    if (!sp.stand && ground) { // both boots on the snow: the lowest ground under them, never on a steep bank
      const c = Math.cos(sp.yaw), s = Math.sin(sp.yaw);
      let y = Infinity, top = -Infinity;
      const H = [[0.13, 0.15], [-0.13, 0.15], [0.13, -0.13], [-0.13, -0.13], [0, 0]].map(([lx, lz]) => {
        const h = ground(x + lx * c + lz * s, z - lx * s + lz * c);
        y = Math.min(y, h); top = Math.max(top, h);
        return h;
      });
      if (top - y > 0.16) continue;
      q.y = y + (top - y) * 0.25 - 0.02; // on a slope the uphill toes press into the snow, the heels stay on it
      // the snow under the fan for its contact shadow: height + slope along the fan's own x / z
      q.gy = H[4];
      q.gsx = (H[0] + H[2] - H[1] - H[3]) / 0.52;
      q.gsz = (H[0] + H[1] - H[2] - H[3]) / 0.56;
    }
    out.push(q);
    const k = key(x, z);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(q);
  }
  for (const q of out) {
    let nn = 9;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      for (const o of cell.get(`${Math.floor(q.x / R) + i},${Math.floor(q.z / R) + j}`) || []) if (o !== q) nn = Math.min(nn, Math.hypot(o.x - q.x, o.z - q.z));
    }
    q.free = nn;
  }
  return out;
}

class FanSet {
  constructor(kits, spots, seed, { parent, name, finish, shadows, lively = false }) {
    this.crowd = new FanCrowd(kits, spots, mulberry(seed), { parent, name, shadows, lively });
    this.center = this.crowd.center;
    this.finish = finish;
    this.prevAlong = NaN;
    this.cheer = 0; this.burst = 0;
    this.fans = true;
    this.count = spots.length;
  }
  dispose() { this.crowd.dispose(); }
}
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4();
const LOD_DIST = [[14, 40], [16, 48], [20, 60], [24, 70], [28, 80]];

export class Crowds {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [o]
   * @param {string} [o.quality]  preset name (default: the live engine/quality.js preset)
   */
  constructor(scene, o = {}) {
    this.scene = scene;
    this.level = qualityLevel(o.quality);
    this.density = [0.6, 0.7, 0.85, 1, 1][this.level];
    this.shadows = this.level >= 3;
    this.sets = [];
    this.group = new THREE.Group();
    this.group.name = 'crowds';
    scene.add(this.group);
    this.course = null;
    this.courseSets = [];
    this.count = 0;
    this.arenaDefs = [];  // spot lists, rebuilt with real fans once the characters have loaded
    this.courseDef = null;
    this.kits = null;
    this.viewCamera = null; // tests: LOD / culling from this camera instead of the game camera
    this.vegetation = null; // (from the player: keeps fans out of the pine trees)
    this.treeCells = new Map();
    this.treeClear = (x, z) => this.clearOfTrees(x, z);
    this.player = { x: 0, y: 0, z: 0, speed: 0 };
    const t0 = performance.now();
    loadFanKits().then((kits) => {
      if (!kits.length) return;
      this.kits = kits;
      this.kitsMs = performance.now() - t0; // download + bake (tests)
      this.rebuildWithFans();
    }).catch((e) => console.warn('crowd fans', e));
  }

  // swap the stand-in figures for real fans
  rebuildWithFans() {
    for (const s of this.sets) s.dispose();
    this.sets = [];
    this.count = 0;
    for (const d of this.arenaDefs) this.makeArenaSet(d);
    if (this.courseDef) {
      for (const s of this.courseSets) s.dispose();
      this.courseSets.length = 0;
      this.makeCourseSet(this.courseDef);
    }
  }
  // Not under a pine: the forest is deterministic per vegetation cell (64 m), so the cells around a spot can be
  // generated here before the player ever gets near (the lowest branches reach ~0.32 x the tree's height).
  clearOfTrees(x, z) {
    const veg = this.vegetation;
    if (!veg?.genCell) return true;
    const C = 64, cx = Math.floor(x / C), cz = Math.floor(z / C);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const key = `${cx + i},${cz + j}`;
      let trees = this.treeCells.get(key);
      if (!trees) { trees = veg.genCell(cx + i, cz + j).trees; this.treeCells.set(key, trees); }
      for (const t of trees) {
        const r = t.s * 0.32 + 0.4;
        if ((t.x - x) ** 2 + (t.z - z) ** 2 < r * r) return false;
      }
    }
    return true;
  }
  makeArenaSet(d) {
    const set = this.kits
      ? new FanSet(this.kits, fanSpots(d.spots, meshGround, this.treeClear), d.seed, { parent: this.group, name: d.name, finish: d.finish, shadows: this.shadows, lively: true })
      : new CrowdSet(d.spots, mulberry(d.seed), { shadows: this.shadows, parent: this.group, name: d.name, finish: d.finish });
    this.sets.push(set);
    this.count += set.fans ? set.count : d.spots.length;
  }
  makeCourseSet(d) {
    const set = this.kits
      ? new FanSet(this.kits, fanSpots(d.spots, meshGround, this.treeClear), d.seed, { parent: d.parent, name: 'crowd-course', finish: d.finish, shadows: this.shadows })
      : new CrowdSet(d.spots, mulberry(d.seed), { shadows: this.shadows, parent: d.parent, name: 'crowd-course', finish: d.finish });
    this.courseSets.push(set);
  }

  /** Spectators at every resort World Cup arena (call once after buildResortDressing). */
  addResortArenas({ dressing = null, models = {}, colliders = [] } = {}) {
    const index = getRunIndex();
    for (const r of layout.races) {
      if (!r.arena) continue;
      const rnd = mulberry(9001 + r.seed * 31);
      const spots = [];
      const path = r.path, n = path.length;
      const acc = [0];
      for (let i = 1; i < n; i++) acc.push(acc[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
      const L = acc[n - 1];
      const [fx, fz] = path[n - 1], [px, pz] = path[Math.max(0, n - 4)];
      const fl = Math.hypot(fx - px, fz - pz) || 1, fdx = (fx - px) / fl, fdz = (fz - pz) / fl;
      const near = colliders.filter((c) => Math.abs(c.x - fx) < 160 && Math.abs(c.z - fz) < 160);
      let j = Math.max(1, n - 24);
      const hw = r.halfWidth;
      for (let s = L - 78; s < L + 16; s += 0.72) {
        // point + direction on the course (extended straight on past the finish line)
        let x, z, dx, dz;
        if (s <= L) {
          while (j < n - 1 && acc[j] < s) j++;
          const t = (s - acc[j - 1]) / ((acc[j] - acc[j - 1]) || 1);
          x = path[j - 1][0] + (path[j][0] - path[j - 1][0]) * t; z = path[j - 1][1] + (path[j][1] - path[j - 1][1]) * t;
          const l = Math.hypot(path[j][0] - path[j - 1][0], path[j][1] - path[j - 1][1]) || 1;
          dx = (path[j][0] - path[j - 1][0]) / l; dz = (path[j][1] - path[j - 1][1]) / l;
        } else { x = fx + fdx * (s - L); z = fz + fdz * (s - L); dx = fdx; dz = fdz; }
        if (Math.abs(s - L) < 1.8) continue; // the arch pylons
        const k = smooth01((s - (L - 78)) / 70); // denser toward the line
        for (const side of [1, -1]) {
          const rx = -dz * side, rz = dx * side;
          for (let row = 0; row < 3; row++) {
            const p = [0.32 + 0.62 * k, 0.12 + 0.68 * k, 0.45 * k][row] * (s > L ? 0.75 : 1) * this.density;
            if (rnd() > p) continue;
            const lat = hw + 2.0 + row * 0.78 + (rnd() - 0.5) * 0.28, along = (rnd() - 0.5) * 0.3;
            const x2 = x + rx * lat + dx * along, z2 = z + rz * lat + dz * along;
            if (index.clearance(x2, z2) < 0.8 || index.netDist(x2, z2) < 0.9 || index.liftDist(x2, z2) < 1) continue;
            if (hitsCollider(near, x2, z2, 0.45) || !levelAt(x2, z2)) continue;
            // face the course, looking a little up toward the finish line
            const yaw = Math.atan2(-rx, -rz) + (rnd() - 0.5) * 0.5;
            spots.push({ x: x2, y: world.height(x2, z2), z: z2, yaw });
          }
        }
      }
      // fans on the grandstand (the stand model the dressing placed beside the finish)
      if (dressing && r.arenaPlan) {
        // only this arena's stand: the dressing's copies of the model near it
        const st = r.arenaPlan.stand, tmp = [];
        standSpots(dressing, models.grandstand, rnd, this.density, tmp);
        for (const sp of tmp) if (Math.hypot(sp.x - st.x, sp.z - st.z) < 16) spots.push(sp);
      }
      if (!spots.length) continue;
      const d = { spots, seed: 9001 + r.seed * 31 + 7, name: `crowd-${r.name}`, finish: { x: fx, z: fz, dx: fdx, dz: fdz, hw: hw + 2 } };
      this.arenaDefs.push(d);
      this.makeArenaSet(d);
    }
    return this;
  }

  /**
   * A World Racing course (built by modes.load): its static spectators become animated figures in the same
   * spots, its grandstands get fans. Called by update() whenever the course changes.
   */
  addCourse(course, group, models = {}) {
    this.removeCourse();
    if (!course || !group) return;
    this.course = course; this.courseGroup = group;
    const props = group.getObjectByName('props') || group;
    const crowd = props.userData.crowd || 0;
    const rnd = mulberry(4242 + (course.def?.seed ?? 1));
    const spots = [];
    if (crowd) {
      const old = props.children.filter((o) => o.isInstancedMesh && o.count === crowd);
      const src = old.find((o) => o.instanceColor) || old[0];
      if (src) {
        // every fan faces the course: across the finish straight, toward the centre line
        const f = course.finish, hx = Math.sin(f?.heading ?? 0), hz = Math.cos(f?.heading ?? 0);
        const flip = new THREE.Matrix4().makeRotationY(Math.PI);
        for (let k = 0; k < crowd; k++) {
          if (rnd() > this.density) continue;
          const m = new THREE.Matrix4();
          src.getMatrixAt(k, m);
          if (f) {
            const ox = m.elements[12] - f.x, oz = m.elements[14] - f.z;
            const lat = ox * hz - oz * hx; // + = right of the line (looking down the course)
            const fz0 = m.elements[8], fz2 = m.elements[10]; // the figure's +z (its face)
            if ((fz0 * hz - fz2 * hx) * lat > 0) m.multiply(flip);
          }
          const c = new THREE.Color();
          if (src.instanceColor) src.getColorAt(k, c); else c.set(JACKETS[k % JACKETS.length]);
          spots.push({ matrix: m, color: c, x: m.elements[12], y: m.elements[13], z: m.elements[14], yaw: Math.atan2(m.elements[8], m.elements[10]) });
        }
        for (const o of old) o.visible = false;
      }
    }
    standSpots(group, models.grandstand, rnd, this.density, spots);
    if (!spots.length) return;
    const f = course.finish;
    this.courseDef = {
      spots, seed: 4242 + (course.def?.seed ?? 1) + 13, parent: props,
      finish: f ? { x: f.x, z: f.z, dx: Math.sin(f.heading), dz: Math.cos(f.heading), hw: (course.track?.sAt?.(course.track.W, f.s) ?? 12) + 2 } : null,
    };
    this.makeCourseSet(this.courseDef);
  }

  removeCourse() {
    for (const s of this.courseSets) s.dispose();
    this.courseSets.length = 0;
    this.course = this.courseGroup = null;
    this.courseDef = null;
  }

  /** Make the crowd nearest to (x, z) (or every crowd within 400 m of it; all when no point) cheer. */
  cheer(x, z, strength = 1) {
    for (const s of this.sets.concat(this.courseSets)) {
      if (x !== undefined && Math.hypot(s.center.x - x, s.center.z - z) > 400) continue;
      s.burst = Math.max(s.burst, 4 + strength * 2);
    }
  }

  /**
   * @param {number} dt
   * @param {object} o
   * @param {THREE.Camera} o.camera
   * @param {object} [o.player]  { pos, speed } (cheers when it crosses a finish line, waves as it passes)
   * @param {object} [o.course]  the World Racing course on screen (modes.course) and its group (modes.group)
   * @param {THREE.Object3D} [o.courseGroup]
   * @param {object} [o.models]
   */
  update(dt, o = {}) {
    const t0 = performance.now();
    this.updateCrowds(dt, o);
    this.ms = (this.ms || 0) * 0.95 + (performance.now() - t0) * 0.05; // smoothed CPU cost (dev overlay / tests)
  }
  updateCrowds(dt, { camera, player = null, course = null, courseGroup = null, models = {} } = {}) {
    if (!this.vegetation && player?.vegetation) { // place the fans again, now clear of the trees
      this.vegetation = player.vegetation;
      if (this.kits) this.rebuildWithFans();
    }
    if (courseGroup !== (this.courseGroup ?? null)) {
      if (courseGroup && course) this.addCourse(course, courseGroup, models); else this.removeCourse();
    }
    CROWD_TIME.value = (CROWD_TIME.value + dt) % 3600;
    const lv = qualityLevel(); // the preset may drop while playing
    const shadows = this.shadows && lv >= 3, viewDist = [220, 300, 380, 450, 520][lv];
    const vc = this.viewCamera || camera, cam = vc.position;
    const pp = player?.pos, speed = player?.speed ?? 0;
    vc.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(vc.projectionMatrix, vc.matrixWorldInverse));
    const P = pp ? Object.assign(this.player, { x: pp.x, y: pp.y, z: pp.z, speed }) : null;
    for (let i = 0; i < this.sets.length + this.courseSets.length; i++) {
      const s = i < this.sets.length ? this.sets[i] : this.courseSets[i - this.sets.length];
      if (s.fans) {
        // (off screen but in range the crowd keeps its mood: turn round after the finish and they are still cheering)
        if (!s.crowd.update(dt, { cam, frustum: _frustum, view: viewDist, lod: LOD_DIST[lv], cheer: s.cheer, player: P, time: CROWD_TIME.value, shadows })) { s.cheer = 0; s.burst = 0; continue; }
      } else {
        const d = Math.hypot(cam.x - s.center.x, cam.z - s.center.z);
        s.mesh.visible = d < viewDist;
        s.mesh.castShadow = shadows;
        if (!s.mesh.visible) { s.cheer = 0; s.burst = 0; continue; }
      }
      let target = 0;
      const f = s.finish;
      if (f && pp) {
        const ox = pp.x - f.x, oz = pp.z - f.z;
        const along = ox * f.dx + oz * f.dz, lat = Math.abs(ox * f.dz - oz * f.dx);
        if (Math.abs(along) < 90 && lat < f.hw + 6) {
          if (s.prevAlong < 0 && along >= 0 && speed > 2) s.burst = 6; // crossed the line (NaN: just arrived)
          // racers coming down the finish straight get a wave
          if (along < 0 && along > -80 && speed > 8) target = 0.4 * (1 + along / 80);
          s.prevAlong = along;
        } else s.prevAlong = NaN;
      }
      if (s.burst > 0) { s.burst -= dt; target = 1; }
      s.cheer += (target - s.cheer) * Math.min(1, dt * (target > s.cheer ? 3 : 0.6));
      if (!s.fans) s.uniforms.uCheer.value = s.cheer;
    }
  }
}

function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
