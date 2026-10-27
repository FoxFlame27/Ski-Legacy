// Walls for open cuts (couloirs between cliffs, the cuttings in front of the tunnel portals): a heightfield can't
// draw a steep wall that runs across its 2 m grid cleanly (it turns into a saw-tooth), so the cut's walls are
// explicit meshes ("skins") standing just in front of a steep heightfield wall: lumpy rock with ledges (the terrain
// shader's rock and snow, so they read as the mountain's own cliffs) or glacier ice, rising from under the snow
// floor to the rim, where a lip folds back under the snow.
// The heightfield wall behind (skinnedTrenchCut, or a tunnel's approach cut) sits `gap` m back from the skin's
// furthest bulge: skinWallOffset(half, gap) is its lateral offset from the line. That leaves a hidden hollow between
// the skin and the heightfield wall: the lip reaches out over all of it (from above you never see into it), and
// skinSurface() makes the skins' top walkable (the lip, the rim, the face), so you never fall through the snow you see.
import * as THREE from 'three';
import { Simplex, smoothstep, clamp } from '../../core/noise.js';
import { world } from '../world.js';
import { createTerrainMaterial } from '../terrain.js';
import { quality, onQualityChange } from '../../engine/quality.js';
import { late, sharedMaterial } from './slice.js';

const N = new Simplex(7707), N2 = new Simplex(7708);
const P = {};
export const SKIN_MIN = -1.8, SKIN_MAX = 0.6; // the skin's lateral relief (m) around its mean line
export const APRON = 1.6; // m: the snow apron at the wall's foot (45 degrees), hiding the heightfield's floor-to-wall chords
/** lateral offset of the heightfield wall behind a skin whose floor half-width is `half` */
export const skinWallOffset = (half, gap = 3.0) => half + SKIN_MAX + gap;
/** the skin's mean lateral offset (no relief) at height hh over the floor (floor half-width w, wall steepness kS) */
export const skinLateral = (w, hh, kS = 3.2) => (hh < APRON ? w - APRON + Math.max(0, hh) * 0.95 : w - APRON * 0.05 + (hh - APRON) / kS);

// the terrain shader for meshes that stand in for the mountain (rock skins, portal snow, the features' rock)
export function rockSkinMaterial() {
  return sharedMaterial('terrain-like', () => {
    const m = createTerrainMaterial();
    m.defines.TERRAIN_DETAIL = quality.terrain.detail;
    onQualityChange((q) => { if (m.defines.TERRAIN_DETAIL !== q.terrain.detail) { m.defines.TERRAIN_DETAIL = q.terrain.detail; m.needsUpdate = true; } });
    return m;
  });
}

// lateral relief of a rock skin at arc length s, height hh over the floor (side: -1 / 1 picks an independent
// pattern): lumps and buttresses, and broken ledges in patches (their tops catch snow) -- never regular bands
export function skinRelief(s, hh, side, seed = 0) {
  const o = side * 31.7 + seed * 13.1;
  let r = N.noise(s * 0.09 + o, hh * 0.11) * 0.75 + N2.noise(s * 0.3 - o, hh * 0.33 + 1.7) * 0.35
    + N.noise(s * 0.03 + o * 0.3, 4.4) * 0.6 // buttresses and bays along the wall
    - Math.abs(N2.noise(s * 0.55 + o, hh * 0.8)) * 0.3; // cracks
  // ledges: the wall steps back over a short height (a shelf), at irregular heights, only in patches
  const patch = smoothstep(0.05, 0.45, N2.noise(s * 0.045 - o, 2.9 + side));
  if (patch > 0) {
    const q = (hh + N.noise(s * 0.07 + o, 7.3) * 1.6) / (3.1 + 1.2 * N2.noise(s * 0.02, o)), f = q - Math.floor(q);
    r += (smoothstep(0.78, 0.97, f) - 0.5) * 1.1 * patch;
  }
  return clamp(r - 0.2, SKIN_MIN, SKIN_MAX);
}

// glacier ice: big smooth bulges and vertical flutes (meltwater runnels), no ledges
export function iceRelief(s, hh, side, seed = 0) {
  const o = side * 23.1 + seed * 7.7;
  const r = N.noise(s * 0.06 + o, hh * 0.05) * 0.75 // big smooth bulges
    + N2.noise(s * 0.42 + o, hh * 0.035 + 2.1) * 0.4 // vertical flutes
    + N.noise(s * 0.17 - o, hh * 0.19 + 5.2) * 0.15;
  return clamp(r - 0.1, SKIN_MIN, SKIN_MAX);
}

/**
 * A steep open cut whose walls are rock skins: floor(s), half(s, side) (floor half-width out to the wall on that side,
 * side -1 = left / 1 = right; or a number), kS (wall steepness: up per m
 * out), s0 / s1 (the floor meets the terrain there), gap (heightfield wall behind the skin). The returned cut has
 * `off` (skip it, to sample the terrain without it) like every secrets cut.
 */
export function skinnedTrenchCut(path, { floor, half, s0 = 0, s1 = path.length, kS = 3.2, gap = 3.0, ease = 6 }) {
  const halfFn = typeof half === 'function' ? half : () => half;
  return {
    bounds: { minx: path.bounds.minx - 50, minz: path.bounds.minz - 50, maxx: path.bounds.maxx + 50, maxz: path.bounds.maxz + 50 },
    apply(x, z, h) {
      if (this.off) return h;
      const p = path.project(x, z, P);
      if (p.dist === Infinity || p.s < s0 - ease || p.s > s1 + ease) return h;
      // (fading in / out beyond the ends, where the snow is already at about the floor: no bump)
      const k = smoothstep(s0 - ease, s0, p.s) * (1 - smoothstep(s1, s1 + ease, p.s));
      if (k <= 0) return h;
      const u = Math.abs(p.d) - skinWallOffset(halfFn(p.s, p.d < 0 ? -1 : 1), gap); // (half(s, side): the walls may differ)
      const t = floor(p.s) + (u > 0 ? u * kS : 0);
      return t < h ? h + (t - h) * k : h;
    },
  };
}

/**
 * The two rock skins of a skinnedTrenchCut. heightNoCut(x, z): the terrain without this cut (the rim is where the
 * skin meets it). Returns { mesh, colliders }.
 */
export function buildRockSkins(path, o) {
  const it = buildRockSkinsSteps(path, o);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
/**
 * The same as a generator (time-sliced building). Options beyond the cut's: heightNoCut(x, z); sides; seed; step
 * (m between columns); relief(s, hh, side, seed) (default skinRelief); material (default the terrain shader);
 * lipMaterial (a second material for the lip strip, e.g. snow on an ice wall); uvScale (m per texture tile: adds
 * uv = (s, height) / uvScale for mapped materials)
 */
export function* buildRockSkinsSteps(path, { floor, half, s0 = 0, s1 = path.length, kS = 3.2, heightNoCut, heightCut = (x, z) => world.height(x, z), sides = [-1, 1], seed = 0, step = 1.4, relief = skinRelief, material = null, lipMaterial = null, uvScale = 0, maxRim = 140 }) {
  const halfFn = typeof half === 'function' ? half : () => half;
  const pos = [], uv = [], idxWall = [], idxLip = [];
  const NR = 18; // rows from under the floor to the rim, + the lip
  const cols = Math.max(2, Math.ceil((s1 - s0) / step) + 1);
  const colliders = [];
  const fr = {};
  for (const side of sides) {
    const base = pos.length / 3;
    let prevRim = 0;
    for (let c = 0; c < cols; c++) {
      if (late()) yield;
      const s = s0 + ((s1 - s0) * c) / (cols - 1);
      path.at(s, fr);
      const y = floor(s), w = halfFn(s, side);
      // the wall: a snow apron at its foot, then lumpy rock / ice leaning back at kS
      const lateral = (hh) => skinLateral(w, hh, kS) + relief(s, Math.max(hh, APRON), side, seed) * (hh < APRON ? Math.max(0, hh) / APRON : 1);
      // the rim: first height at which the skin stands at / above the uncut terrain (searched from the last
      // column's rim: neighbouring columns are alike)
      const above = (hh) => { const L = lateral(hh), X = fr.x + fr.rx * side * L, Z = fr.z + fr.rz * side * L; return y + hh >= heightNoCut(X, Z); };
      let lo = 0, hi = -1;
      const g = Math.max(0.5, prevRim);
      if (above(g)) { hi = g; lo = g; while (lo > 0.5 && above(lo - 1.5)) lo -= 1.5; lo = Math.max(0, lo - 1.5); if (lo > 0 && above(lo)) lo = 0; }
      else { lo = g; for (let hh = g + 1.5; hh < maxRim; hh += 1.5) { if (above(hh)) { hi = hh; break; } lo = hh; } }
      if (hi < 0) hi = maxRim;
      for (let it = 0; it < 5; it++) { // refine
        const m = (lo + hi) / 2, L = lateral(m), X = fr.x + fr.rx * side * L, Z = fr.z + fr.rz * side * L;
        if (y + m >= heightNoCut(X, Z)) hi = m; else lo = m;
      }
      const hr = Math.max(0, hi);
      prevRim = hr;
      for (let r = 0; r < NR; r++) {
        const t = r / (NR - 1), hh = -1.5 + (hr + 0.25 + 1.5) * (t * (0.62 + 0.38 * t)); // denser low down
        const L = lateral(hh), X = fr.x + fr.rx * side * L, Z = fr.z + fr.rz * side * L;
        // a cut's wall never stands above the snow it was cut into (where the ground beside the floor falls away,
        // at a cutting's mouth or along a traverse, it sinks under the snow instead of sticking out as a fin)
        pos.push(X, Math.min(y + hh, heightNoCut(X, Z) - 0.12), Z);
        if (uvScale) uv.push((s * side) / uvScale, hh / uvScale);
      }
      // the lip folds back over the cut's rim and under the snow, out past the hidden hollow behind the skin (where
      // the cut's heightfield wall meets the snow again; at least 4.2 m)
      const L0 = lateral(hr);
      let reach = 4.2;
      for (let e = 0.5; e <= 10; e += 0.5) {
        const Xe = fr.x + fr.rx * side * (L0 + e), Ze = fr.z + fr.rz * side * (L0 + e);
        if (heightCut(Xe, Ze) >= heightNoCut(Xe, Ze) - 0.05) { reach = clamp(e + 1.2, 4.2, 11); break; }
        if (e === 10) reach = 11;
      }
      const Lr = L0 + reach, X = fr.x + fr.rx * side * Lr, Z = fr.z + fr.rz * side * Lr;
      pos.push(X, Math.min(y + hr, heightNoCut(X, Z)) - 0.45, Z);
      if (uvScale) uv.push((s * side) / uvScale, (hr + 2) / uvScale);
      // a soft collider along the wall's foot every few columns
      if (c % 3 === 0 && hr > 1.2) {
        const L0 = w - APRON * 0.6, b = path.at(Math.min(s1, s + step * 3), {});
        const ax = fr.x + fr.rx * side * L0, az = fr.z + fr.rz * side * L0, bx = b.x + b.rx * side * L0, bz = b.z + b.rz * side * L0;
        colliders.push({ x: (ax + bx) / 2, z: (az + bz) / 2, hw: Math.hypot(bx - ax, bz - az) / 2 + 0.3, hd: 0.3, rot: Math.atan2(bz - az, bx - ax), soft: true, secret: true });
      }
    }
    const R = NR + 1;
    for (let c = 0; c < cols - 1; c++) for (let r = 0; r < R - 1; r++) {
      const a = base + c * R + r, b = a + R, cc = a + 1, d = b + 1;
      const into = lipMaterial && r === R - 2 ? idxLip : idxWall; // (the last strip is the lip)
      if (side < 0) into.push(a, b, cc, b, d, cc); else into.push(a, cc, b, b, cc, d); // faces the gully
    }
  }
  yield;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uvScale) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex([...idxWall, ...idxLip]);
  if (lipMaterial) { geo.addGroup(0, idxWall.length, 0); geo.addGroup(idxWall.length, idxLip.length, 1); }
  geo.computeVertexNormals();
  geo.setAttribute('aData', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  geo.computeBoundingSphere();
  const mat = material || rockSkinMaterial();
  const mesh = new THREE.Mesh(geo, lipMaterial ? [mat, lipMaterial] : mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = 'secret-rock-skin';
  return { mesh, colliders };
}

/**
 * The walkable top of a skins mesh (rock / ice faces and their snow lips) as a world surface ({ bounds, height }:
 * world.addSurface): the highest upward-facing triangle over each `cell` m grid node, null off the skins. The
 * heightfield can't follow a skin (its wall stands hidden `gap` m behind it), so without this the lip and the rim
 * you see would not hold you: you would sink through them and drop behind the face into the rock. Over the floor
 * the skins' foot lies under the snow and the terrain wins (groundHeight takes the higher one).
 */
export function skinSurface(geo, { cell = 0.5 } = {}) {
  const Pa = geo.attributes.position.array, I = geo.index ? geo.index.array : null;
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (let i = 0; i < Pa.length; i += 3) {
    if (Pa[i] < minx) minx = Pa[i]; if (Pa[i] > maxx) maxx = Pa[i];
    if (Pa[i + 2] < minz) minz = Pa[i + 2]; if (Pa[i + 2] > maxz) maxz = Pa[i + 2];
  }
  const x0 = Math.floor(minx / cell) * cell - cell, z0 = Math.floor(minz / cell) * cell - cell;
  const W = Math.ceil((maxx - x0) / cell) + 3, D = Math.ceil((maxz - z0) / cell) + 3;
  const H = new Float32Array(W * D).fill(-Infinity);
  const n = I ? I.length : Pa.length / 3;
  for (let t = 0; t < n; t += 3) {
    const a = (I ? I[t] : t) * 3, b = (I ? I[t + 1] : t + 1) * 3, c = (I ? I[t + 2] : t + 2) * 3;
    const ax = Pa[a], ay = Pa[a + 1], az = Pa[a + 2], bx = Pa[b], by = Pa[b + 1], bz = Pa[b + 2], cx = Pa[c], cy = Pa[c + 1], cz = Pa[c + 2];
    // upward-facing only (the faces face the gully and lean back, the lips face up; overhangs' undersides face down)
    const ux = bx - ax, uz = bz - az, vx = cx - ax, vz = cz - az;
    const area = uz * vx - ux * vz; // = the normal's y (twice the triangle's area projected on the ground)
    if (!(area > 1e-6)) continue;
    // its grid nodes: barycentric in xz
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / cell)), i1 = Math.min(W - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - z0) / cell)), j1 = Math.min(D - 1, Math.floor((Math.max(az, bz, cz) - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = z0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell;
        const wx = x - ax, wz = z - az;
        const l1 = (wz * vx - wx * vz) / area, l2 = (uz * wx - ux * wz) / area; // weights of b, c
        if (l1 < -1e-4 || l2 < -1e-4 || l1 + l2 > 1 + 1e-4) continue;
        const h = ay + (by - ay) * l1 + (cy - ay) * l2;
        const k = j * W + i;
        if (h > H[k]) H[k] = h;
      }
    }
  }
  const NONE = -1e30;
  return {
    bounds: { minx: x0, minz: z0, maxx: x0 + (W - 1) * cell, maxz: z0 + (D - 1) * cell },
    height(x, z) {
      const fx = (x - x0) / cell, fz = (z - z0) / cell, i = Math.floor(fx), j = Math.floor(fz);
      if (i < 0 || j < 0 || i >= W - 1 || j >= D - 1) return null;
      const k = j * W + i, a = H[k], b = H[k + 1], c = H[k + W], d = H[k + W + 1], tx = fx - i, tz = fz - j;
      if (a > NONE && b > NONE && c > NONE && d > NONE) return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
      // at the skins' edge: the nearest node that has one
      let best = null, bd = Infinity;
      for (const [v, dx, dz] of [[a, tx, tz], [b, 1 - tx, tz], [c, tx, 1 - tz], [d, 1 - tx, 1 - tz]]) if (v > NONE && dx * dx + dz * dz < bd) { bd = dx * dx + dz * dz; best = v; }
      return best;
    },
  };
}
