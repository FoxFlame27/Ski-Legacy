// Region heightfield for a World Racing course: the terrain is designed around the track.
//  - near field (exact, per query): the groomed track surface (+ banking), snow berms, and the side
//    terrain of each section (gentle valley shoulders, rock walls, cliff drops, canyon walls)
//  - far field (precomputed rasters, bicubic): a valley that follows the course, valley walls rising
//    away from it, ridges and peaks, relaxing into the procedural world toward the region border
//  - features in world space: tunnel ridge + trench, gorge under the bridge, frozen-lake basin, flat
//    building pads
//  - an outer band blends everything back to world.baseHeight so the map sits seamlessly in the world.
import { Simplex, smoothstep, lerp, clamp } from '../../core/noise.js';
import { world, SEED, VILLAGE_R } from '../../world/world.js';
import { DS, BARRIER } from './track.js';

// default world forest (same formula/noise as world.forest) for the border blend
const WN = new Simplex(SEED), WN2 = new Simplex(SEED + 101);
function worldForest(x, z, h, slope) {
  const n = WN2.fbm(x * 0.0022 + 40, z * 0.0022 - 17, 3) * 0.5 + 0.5;
  const tl = 520 + WN.noise(x * 0.001, z * 0.001) * 90;
  const alt = 1 - smoothstep(tl - 120, tl, h);
  const steep = 1 - smoothstep(0.7, 1.1, slope);
  const nearVillage = smoothstep(VILLAGE_R * 0.9, VILLAGE_R * 1.6, Math.sqrt(x * x + z * z));
  return clamp((n - 0.38) * 2.6, 0, 1) * alt * steep * nearVillage;
}

// valley-wall rise past the track edge: gentle shoulders, steepening into real valley walls.
// Tabulated (1 m steps) because it's evaluated millions of times.
function softplus(x, k) { return x > 30 * k ? x : k * Math.log1p(Math.exp(x / k)); }
const RISE0 = 0.3 * softplus(-45, 25) + 0.22 * softplus(-260, 70);
const RISE_N = 12000;
const RISE_LUT = new Float32Array(RISE_N + 1);
for (let i = 0; i <= RISE_N; i++) RISE_LUT[i] = 0.05 * i + 0.3 * softplus(i - 45, 25) + 0.22 * softplus(i - 260, 70) - RISE0;
export function rise(u) {
  if (u <= 0) return 0;
  if (u >= RISE_N) return RISE_LUT[RISE_N] + 0.57 * (u - RISE_N);
  const i = u | 0, f = u - i;
  return RISE_LUT[i] + (RISE_LUT[i + 1] - RISE_LUT[i]) * f;
}

// side shape past the edge (u > 0) for one side's parameters (no berm)
function sideShape(u, riseK, stepH, stepU0, stepU1, tilt) {
  let h = riseK * rise(u);
  if (stepH !== 0) h += stepH * smoothstep(stepU0, stepU1, u);
  if (tilt !== 0 && u > stepU1) h += tilt * (u - stepU1);
  return h;
}

// Catmull-Rom bicubic sample of a raster (fx, fz in cell units)
function bicubic(a, w, h, fx, fz) {
  let ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const wx0 = ((-0.5 * tx + 1) * tx - 0.5) * tx, wx1 = (1.5 * tx - 2.5) * tx * tx + 1;
  const wx2 = ((-1.5 * tx + 2) * tx + 0.5) * tx, wx3 = (0.5 * tx - 0.5) * tx * tx;
  const wz0 = ((-0.5 * tz + 1) * tz - 0.5) * tz, wz1 = (1.5 * tz - 2.5) * tz * tz + 1;
  const wz2 = ((-1.5 * tz + 2) * tz + 0.5) * tz, wz3 = (0.5 * tz - 0.5) * tz * tz;
  ix -= 1; iz -= 1;
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const zz = iz + j < 0 ? 0 : iz + j >= h ? h - 1 : iz + j;
    const row = zz * w;
    const x0 = ix < 0 ? 0 : ix >= w ? w - 1 : ix, x1 = ix + 1 < 0 ? 0 : ix + 1 >= w ? w - 1 : ix + 1;
    const x2 = ix + 2 < 0 ? 0 : ix + 2 >= w ? w - 1 : ix + 2, x3 = ix + 3 < 0 ? 0 : ix + 3 >= w ? w - 1 : ix + 3;
    const r = a[row + x0] * wx0 + a[row + x1] * wx1 + a[row + x2] * wx2 + a[row + x3] * wx3;
    sum += r * (j === 0 ? wz0 : j === 1 ? wz1 : j === 2 ? wz2 : wz3);
  }
  return sum;
}
function bilinear(a, w, h, fx, fz) {
  fx = clamp(fx, 0, w - 1.001); fz = clamp(fz, 0, h - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const i = iz * w + ix;
  const a0 = a[i] + (a[i + 1] - a[i]) * tx, a1 = a[i + w] + (a[i + w + 1] - a[i + w]) * tx;
  return a0 + (a1 - a0) * tz;
}

// band-limit: how many octaves of a noise with base wavelength `lambda` a mesh with `spacing` can show
const octFor = (lambda, full, spacing) => (spacing > 0 ? Math.min(full, Math.max(0, Math.log2(lambda / (4 * spacing)) + 1)) : full);

// The map area a course owns: its track's bounding box plus a margin, within 3.5 km of its centre.
export function regionBounds(track, center, margin = 1300) {
  const tb = track.bbox, lim = 3500;
  return {
    minx: Math.max(center.x - lim, tb.minx - margin), maxx: Math.min(center.x + lim, tb.maxx + margin),
    minz: Math.max(center.z - lim, tb.minz - margin), maxz: Math.min(center.z + lim, tb.maxz + margin),
  };
}

export class CourseRegion {
  /**
   * @param {Track} track
   * @param {object} o { id, seed, center:{x,z}, margin, band, treeline, peaks, features }
   *   features: { tunnels:[], gorges:[], lakes:[], flats:[] } prepared by the course builder
   */
  constructor(track, o) {
    this.track = track;
    this.id = o.id;
    this.o = o;
    this.N = new Simplex(o.seed);
    this.N2 = new Simplex(o.seed + 17);
    this.bounds = regionBounds(track, o.center, o.margin);
    this.band = o.band ?? 650;
    this.treeline = o.treeline ?? 1e9;
    this.features = { tunnels: [], gorges: [], lakes: [], flats: [], ...(o.features || {}) };
    this._near = { h: 0, berm: 0, u: 0, side: 0, onTrack: false };
    this.buildRasters();
  }

  // ---------------------------------------------------------------- precomputation
  buildRasters() {
    const T = this.track, b = this.bounds;
    // --- far field kernel fields on a 32 m grid: valley floor height, side shape, distance, world base
    const C1 = 32;
    const w1 = Math.ceil((b.maxx - b.minx) / C1) + 1, h1 = Math.ceil((b.maxz - b.minz) / C1) + 1;
    const fT = new Float32Array(w1 * h1), fS = new Float32Array(w1 * h1), fD = new Float32Array(w1 * h1), fB = new Float32Array(w1 * h1);
    const step = 10; // every 20 m
    const idx = [];
    for (let i = 0; i < T.n; i += step) idx.push(i);
    if (idx[idx.length - 1] !== T.n - 1) idx.push(T.n - 1);
    const sx = idx.map((i) => T.X[i]), sz = idx.map((i) => T.Z[i]), sy = idx.map((i) => T.Y[i]);
    const sig2 = 70 * 70;
    // per-subsample side parameters (flattened for speed)
    const ns = idx.length;
    const P = new Float32Array(ns * 14);
    for (let k = 0; k < ns; k++) {
      const si = idx[k], o = k * 14;
      P[o] = -T.TZ[si]; P[o + 1] = T.TX[si]; P[o + 2] = T.W[si];
      for (let sd = 0; sd < 2; sd++) {
        const S = T.side[sd], q = o + 3 + sd * 5;
        P[q] = S.riseK[si]; P[q + 1] = S.stepH[si]; P[q + 2] = S.stepU0[si]; P[q + 3] = S.stepU1[si]; P[q + 4] = S.tilt[si];
      }
    }
    for (let j = 0; j < h1; j++) {
      const z = b.minz + j * C1;
      for (let i = 0; i < w1; i++) {
        const x = b.minx + i * C1;
        let dmin = Infinity;
        for (let k = 0; k < ns; k++) {
          const dx = x - sx[k], dz = z - sz[k];
          const d2 = dx * dx + dz * dz;
          if (d2 < dmin) dmin = d2;
        }
        // only samples within a radius that scales with the distance to the course contribute
        // (smooth cutoff keeps the field continuous)
        const dm = Math.sqrt(dmin), R = Math.max(700, dm * 3), R0 = R * 0.7;
        const R2 = R * R;
        let ws = 0, ty = 0, ts = 0;
        for (let k = 0; k < ns; k++) {
          const dx = x - sx[k], dz = z - sz[k];
          const d2 = dx * dx + dz * dz;
          if (d2 >= R2) continue;
          let wk = 1 / ((d2 + sig2) * (d2 + sig2));
          if (d2 > R0 * R0) wk *= 1 - smoothstep(R0, R, Math.sqrt(d2));
          const o = k * 14;
          const v = dx * P[o] + dz * P[o + 1];
          const u = (v < 0 ? -v : v) - P[o + 2];
          let sh = 0;
          if (u > 0) {
            const q = o + 3 + (v >= 0 ? 5 : 0);
            sh = sideShape(u, P[q], P[q + 1], P[q + 2], P[q + 3], P[q + 4]);
          }
          ws += wk; ty += wk * sy[k]; ts += wk * sh;
        }
        const c = j * w1 + i;
        fT[c] = ty / ws; fS[c] = ts / ws; fD[c] = dm;
        fB[c] = world.baseHeight(x, z, 32);
      }
    }
    this.far = { C: C1, w: w1, h: h1, T: fT, S: fS, D: fD, B: fB };

    // --- scenery raster (16 m): valley -> mountains -> world, plus ridges/peaks
    const C2 = 16;
    const w2 = Math.ceil((b.maxx - b.minx) / C2) + 1, h2 = Math.ceil((b.maxz - b.minz) / C2) + 1;
    const sc = new Float32Array(w2 * h2), fo = new Uint8Array(w2 * h2), dd = new Float32Array(w2 * h2);
    const N = this.N, N2 = this.N2;
    const peakAmp = (this.o.peaks ?? 420) * (this.o.peaksK ?? 1);
    // course character (looks.js): rugged > 1 = jagged rock ribs and aretes, < 1 = soft rolling hills
    const rug = this.o.rugged ?? 1, forestFar = this.o.forestFar ?? 1;
    for (let j = 0; j < h2; j++) {
      const z = b.minz + j * C2;
      for (let i = 0; i < w2; i++) {
        const x = b.minx + i * C2;
        const fx = (x - b.minx) / C1, fz = (z - b.minz) / C1;
        const tv = bicubic(fT, w1, h1, fx, fz), sv = bicubic(fS, w1, h1, fx, fz);
        const dv = Math.max(0, bicubic(fD, w1, h1, fx, fz)), bv = bicubic(fB, w1, h1, fx, fz);
        // mountains rising with distance from the course: soft ridges on the valley walls, broad
        // massifs and peaks further out (low frequencies only -> no knife-edge aliasing)
        const wx = x + N2.fbm(x * 0.0005, z * 0.0005, 2) * 300, wz = z + N2.fbm(x * 0.0005 + 7.7, z * 0.0005 - 3.1, 2) * 300;
        const ridNear = N2.ridged(wx * 0.0009 + 3.1, wz * 0.0009 - 1.7, 2, 2.0, 0.45);
        const ridFar = N.ridged(wx * 0.00042 - 5.3, wz * 0.00042 + 2.9, 3, 2.0, 0.45);
        const roll = N2.fbm(x * 0.0024 - 9.1, z * 0.0024 + 4.4, 3);
        const mMask = smoothstep(140, 900, dv);
        const near = tv + sv + (Math.pow(ridNear, 1.5) * 170 - 30) * mMask + roll * 18 * smoothstep(40, 300, dv);
        const farH = bv + Math.pow(ridFar, 1.5) * peakAmp + (Math.pow(ridNear, 1.5) * 170 - 30) * 0.5;
        const k = smoothstep(500, 1500, dv);
        const c = j * w2 + i;
        let hh = lerp(near, farH, k);
        // crisp mountain relief: ribs and couloirs on the valley walls, sharp aretes and buttresses on the
        // mountains beyond (squared ridged noise, ~340 m and ~870 m), growing away from the course. Without it
        // the scenery was smooth snow domes with no rock and no edges, which read as blurry from the track.
        const relNear = smoothstep(80, 450, dv), relFar = smoothstep(250, 1200, dv);
        if (relNear > 0) {
          const rb = N2.ridged(wx * 0.0029 - 4.7, wz * 0.0029 + 6.2, 2, 2.0, 0.5);
          hh += (rb * rb * 75 - 26) * relNear * rug;
          if (relFar > 0) {
            const ra = N.ridged(wx * 0.00115 + 8.3, wz * 0.00115 - 2.1, 3, 2.1, 0.5);
            hh += (ra * ra * 300 - 95) * relFar * rug;
          }
        }
        sc[c] = hh;
        dd[c] = dv;
        // forest: designed density near the course, treeline, natural patches
        const patch = clamp((N2.fbm(x * 0.0035 + 12, z * 0.0035 - 5, 3) + 0.32) * 2.2, 0, 1);
        const alt = 1 - smoothstep(this.treeline - 90, this.treeline + 30, sc[c]);
        const valleyTl = 1 - smoothstep(tv + 170, tv + 260, sc[c]); // no trees high on the walls
        fo[c] = Math.round(255 * clamp(patch * alt * valleyTl * forestFar, 0, 1));
      }
    }
    this.sc = { C: C2, w: w2, h: h2, H: sc, F: fo, D: dd };
  }

  // far-field scenery height at (x, z) incl. detail noise (band-limited by spacing)
  scenery(x, z, spacing) {
    const s = this.sc, b = this.bounds;
    const fx = (x - b.minx) / s.C, fz = (z - b.minz) / s.C;
    let h = bicubic(s.H, s.w, s.h, fx, fz);
    const d = bilinear(s.D, s.w, s.h, fx, fz);
    const amp = 2.5 + 7 * smoothstep(60, 500, d);
    h += this.N.fbm(x * 0.011 + 1.3, z * 0.011 - 2.9, octFor(91, 5, spacing), 2, 0.5, 5) * amp;
    // fine rock ribs (~120 m) on the mountains, band-limited to what the mesh can show
    const fr = smoothstep(300, 1000, d);
    if (fr > 0) {
      const r = this.N2.ridged(x * 0.0083 + 2.2, z * 0.0083 - 7.7, octFor(120, 2, spacing), 2, 0.5, 2);
      h += (r * r - 0.3) * 24 * fr * (this.o.rugged ?? 1);
    }
    return h;
  }

  // ---------------------------------------------------------------- near field
  // Height from the track cross-section at projection p (from track.locate). hFar = scenery height.
  // Writes this._near (berm amount, u, side) for features that need to re-apply the berm.
  nearField(p, hFar, x, z, spacing) {
    const T = this.track, nr = this._near;
    const i = p.i, t = p.t;
    const g0 = T.G[i], y = T.Y[i] - DS * t * (g0 + (T.G[i + 1] - g0) * t * 0.5); // = T.yAt(i, t), inlined
    const w = T.W[i] + (T.W[i + 1] - T.W[i]) * t;
    const bk = T.B[i] + (T.B[i + 1] - T.B[i]) * t;
    const v = p.v, av = v < 0 ? -v : v;
    // distance past the edge; beyond the ends of the line the true distance (not the lateral offset)
    // counts, so the start / finish plateaus fade out naturally behind the line
    const u = (p.t <= 0 && i === 0) || (p.t >= 1 && i === T.n - 2) ? p.d - w : av - w;
    const tb = Math.tan(bk);
    nr.u = u; nr.side = v >= 0 ? 1 : 0; nr.berm = 0;
    if (u <= 0) { nr.onTrack = true; return y - tb * v; }
    nr.onTrack = false;
    const sd = T.side[nr.side];
    const L = (a) => a[i] + (a[i + 1] - a[i]) * t;
    const yEdge = y - tb * (v >= 0 ? w : -w);
    const bermH = L(sd.bermH), bermU = L(sd.bermU), bermW = L(sd.bermW);
    let berm = 0;
    if (bermH > 0.01) {
      const q = (u - bermU) / bermW;
      if (q > -1 && q < 1) { const k = 1 - q * q; berm = bermH * k * k * (1 - smoothstep(2.5, 7, spacing)); }
    }
    let stepH = L(sd.stepH);
    const stepU0 = L(sd.stepU0), stepU1 = L(sd.stepU1);
    let h;
    if (stepH !== 0 && u > stepU0 - 2) {
      // rock walls / drops with character: the foot line wavers, the height varies along the wall and
      // the face breaks into ledges (soft terraces), like real canyon and cliff walls
      const lod = spacing < 6 ? 1 : 0;
      const uw = u + this.N.noise(x * 0.045 + 2.2, z * 0.045 - 7.9) * 1.3 * lod;
      stepH *= 1 + 0.22 * this.N2.noise(x * 0.011 + 1.7, z * 0.011 + 3.3);
      let hs = stepH * smoothstep(stepU0, stepU1, uw);
      const band = 5.5 + 2 * this.N2.noise(x * 0.02, z * 0.02);
      const q = Math.abs(hs) / band, fq = q - Math.floor(q);
      const ter = Math.sign(hs) * band * (Math.floor(q) + smoothstep(0.3, 0.92, fq));
      hs += (ter - hs) * 0.6 * lod * L(sd.rough);
      h = yEdge + L(sd.riseK) * rise(u) + hs + (L(sd.tilt) !== 0 && uw > stepU1 ? L(sd.tilt) * (uw - stepU1) : 0);
    } else {
      h = yEdge + sideShape(u, L(sd.riseK), stepH, stepU0, stepU1, L(sd.tilt));
    }
    // rocky / natural roughness on the sides (none on the groomed shoulder)
    const rough = L(sd.rough);
    const rm = smoothstep(1.5, 9, u);
    if (rm > 0) {
      const amp = (0.6 + rough * 2.4) * rm;
      h += this.N2.fbm(x * 0.07 + 5.1, z * 0.07 - 1.7, octFor(14, 3, spacing), 2, 0.5, 3) * amp;
      if (rough > 0.5 && stepH !== 0) h += Math.abs(this.N.noise(x * 0.19, z * 0.19)) * (rough - 0.5) * 3 * smoothstep(stepU0, stepU1, u) * (spacing < 6 ? 1 : 0);
    }
    const tB = smoothstep(L(sd.blend0), L(sd.blend1), u);
    nr.berm = berm * (1 - tB);
    return lerp(h, hFar, tB) + nr.berm;
  }

  // ---------------------------------------------------------------- full height
  height(x, z, spacing = 0) {
    const b = this.bounds;
    const dB = Math.min(x - b.minx, b.maxx - x, z - b.minz, b.maxz - z);
    if (dB <= 0) return world.baseHeight(x, z, spacing);
    let h = this.scenery(x, z, spacing);
    const T = this.track;
    const p = T.locate(x, z);
    const nr = this._near;
    nr.berm = 0; nr.onTrack = false; nr.u = 1e9;
    let s = 0, v = 0;
    if (!p.far) {
      s = p.s; v = p.v;
      h = this.nearField(p, h, x, z, spacing);
    }
    h = this.applyFeatures(x, z, h, s, v, p.far, spacing);
    if (dB < this.band) h = lerp(world.baseHeight(x, z, spacing), h, smoothstep(0, this.band, dB));
    return h;
  }

  // Height without the tunnel trench (the ridge as it would be) — used to build the tunnel cap mesh.
  uncutHeight(x, z) {
    this._noCut = true;
    const h = this.height(x, z, 0);
    this._noCut = false;
    return h;
  }

  applyFeatures(x, z, h, s, v, far, spacing) {
    const F = this.features, T = this.track, nr = this._near;
    // --- frozen lakes: flat basin at the lake level, shores easing into the terrain
    for (const L of F.lakes) {
      if (nr.onTrack) break; // the groomed track is the authority (it is flat across the ice anyway)
      if (x < L.box.minx || x > L.box.maxx || z < L.box.minz || z > L.box.maxz) continue;
      const dn = L.sdf(x, z);
      if (dn < L.shore * 3) {
        const base = h - nr.berm;
        // the shore slope eases over a width that grows with the bank height (no sharp rims)
        const wS = Math.max(L.shore, Math.abs(base - L.level) * 1.7);
        if (dn < wS) {
          const k = smoothstep(0, wS, dn);
          // inside the lake the terrain is the ice level; berms along the track stay on top
          h = (dn <= 0 ? L.level : lerp(L.level, base, k * k * (2 - k))) + nr.berm;
        }
      }
    }
    // --- tunnel ridges: a rock spur across the track, cut by the tunnel trench. At each portal a stone
    // facade (structures.js, tn.portal) stands in a notch of the mountain: right behind it the face leans
    // back at ~55 deg from just under its coping (a heightfield can't hold a vertical face: on the mesh grid
    // it smeared into a flat, blurry slab), beside it the spur's flanks come forward around the wall. Away
    // from the track the spur narrows, lowers and curves like a natural ridge running down from the valley wall.
    if (!far) {
      for (const tn of F.tunnels) {
        if (s < tn.s0 - 160 || s > tn.s1 + 160) continue;
        const av = v < 0 ? -v : v;
        if (av > tn.extent + 60) continue;
        const N = this.N, P = tn.portal;
        const wob = N.noise(v * 0.011 + 3.7, tn.s0 * 0.01) * 0.5 + N.noise(v * 0.031 - 1.3, 7.1) * 0.22;
        const away = smoothstep(tn.cutHalf + 4, tn.cutHalf + 60, av);
        // crest line bends away from the straight portal-to-portal line
        const bend = 26 * wob * away;
        const mid = (tn.s0 + tn.s1) / 2 + bend, half = (tn.s1 - tn.s0) / 2;
        const ds = Math.abs(s - mid);
        const e = ds - half; // > 0 out in front of a portal, < 0 over the tube
        // the face's toe: hidden inside the facade's thickness behind the wall (further back on coarse LOD
        // meshes, whose triangles reach further), swinging forward beside it
        const side = Math.max(0, av - P.halfW), sideK = smoothstep(P.halfW - 1, P.halfW + 6, av);
        const toe = lerp(-(P.depth - 0.4 + Math.max(0, spacing - 2) * 1.45), side * 0.7, sideK);
        const wallH = (P.wallTop - 1.0) * (1 - smoothstep(P.topW, P.halfW, av));
        const face = e < toe ? wallH + (toe - e) * (1.4 / (1 + side * 0.025)) : 0;
        // height: full over the tube, a rounded crest, tapering away from the track
        const lat = Math.pow(1 - smoothstep(tn.cutHalf + 10, tn.extent * (0.8 + 0.25 * wob), av), 1.35);
        const top = 1 + 0.18 * (1 - (ds / (half + 1)) ** 2) * away;
        const crest = Math.min(face, tn.height * lat * top);
        if (crest > 0.01) {
          const ys = T.surfaceY(s, v);
          const rock = N.fbm(x * 0.045 + 9.3, z * 0.045 + 1.1, octFor(22, 4, spacing), 2, 0.5, 4) * 4.5;
          // (calm right behind the coping, so the rock never pokes through it)
          const calm = 1 - (1 - sideK) * (1 - smoothstep(1, 7, toe - e));
          const hr = ys + crest + rock * smoothstep(0, 8, crest) * calm;
          if (hr > h) h = hr;
        }
        // the trench: a flat floor out past the tube's outer shell by more than a mesh cell (no terrain
        // triangle can reach through the tunnel walls), steep walls beyond; the cap mesh closes it on top
        if (!this._noCut && s > tn.s0 - 1.2 && s < tn.s1 + 1.2 && av < P.floorHalf + 1.4) {
          const ys = T.surfaceY(s, v);
          const wall = ys + Math.max(0, av - P.floorHalf) * 40;
          if (wall < h) h = wall;
        }
      }
    }
    // --- gorges (under bridges): a deep, meandering ravine carved across the course
    for (const g of F.gorges) {
      if (x < g.box.minx || x > g.box.maxx || z < g.box.minz || z > g.box.maxz) continue;
      const dx = x - g.mx, dz = z - g.mz;
      const a = dx * g.ax + dz * g.az; // along the gorge
      const across = dx * g.tx + dz * g.tz; // across the gorge (= along the track at the bridge)
      const aa = a < 0 ? -a : a;
      if (aa > g.len) continue;
      const r = Math.abs(across - g.meander(a));
      const wv = this.N2.noise(a * 0.012 + 4.1, 2.3); // width / steepness variation along the ravine
      const near = 1 - smoothstep(30, 90, aa); // at the bridge the shape is exactly as designed
      const floorHalf = g.floorHalf * (1 + 0.6 * (wv * 0.5 + 0.5) * (1 - near));
      const wallK = g.wallK * (1 + 0.28 * wv * (1 - near));
      // the floor descends along the ravine and rises out to nothing at its ends
      const ends = smoothstep(g.len * 0.55, g.len, aa);
      const floor = g.floorY - g.fall * a + ends * ends * (g.depth + 25);
      let wall = floor + (r < floorHalf ? 0 : (r - floorHalf) * wallK);
      // rocky, ledgy walls
      const rk = smoothstep(floorHalf, floorHalf + 6, r);
      wall += (this.N.fbm(x * 0.04 - 3.3, z * 0.04 + 8.1, octFor(25, 3, spacing), 2, 0.5, 3) * 4.5 + this.N2.noise(x * 0.11, z * 0.11) * 1.2 * (spacing < 6 ? 1 : 0)) * rk;
      const lodFade = 1 - smoothstep(18, 48, spacing);
      if (wall < h) h = lerp(h, wall, lodFade);
    }
    // --- flat pads for buildings (start house, grandstands, timing board)
    for (const f of F.flats) {
      if (nr.onTrack) break;
      const dx = x - f.x, dz = z - f.z;
      if (Math.abs(dx) > f.reach || Math.abs(dz) > f.reach) continue;
      const lx = Math.abs(dx * f.cos + dz * f.sin) - f.hw, lz = Math.abs(-dx * f.sin + dz * f.cos) - f.hd;
      const out = Math.sqrt(Math.max(lx, 0) ** 2 + Math.max(lz, 0) ** 2);
      if (out < f.blend) h = lerp(f.h, h, smoothstep(0, f.blend, out));
    }
    return h;
  }

  // ---------------------------------------------------------------- forest
  forest(x, z, h, slope) {
    const b = this.bounds;
    const dB = Math.min(x - b.minx, b.maxx - x, z - b.minz, b.maxz - z);
    if (dB <= 0) return worldForest(x, z, h, slope);
    const s = this.sc;
    let f = bilinear(s.F, s.w, s.h, (x - b.minx) / s.C, (z - b.minz) / s.C) / 255;
    const T = this.track;
    const p = T.locate(x, z);
    if (!p.far) {
      // designed density per section near the course (in the gap between barrier and valley walls)
      const sd = T.side[p.v >= 0 ? 1 : 0];
      const i = p.i, t = p.t;
      const w = T.W[i] + (T.W[i + 1] - T.W[i]) * t;
      const u = Math.abs(p.v) - w;
      const fs = sd.forest[i] + (sd.forest[i + 1] - sd.forest[i]) * t;
      const k = 1 - smoothstep(110, 260, u);
      const nearPatch = clamp((this.N.fbm(x * 0.012, z * 0.012, 2) + 0.55) * 1.4, 0, 1);
      f = lerp(f, Math.min(1, fs * (this.o.forestK ?? 1) * (0.65 + 0.35 * nearPatch)) * (1 - smoothstep(this.treeline - 60, this.treeline + 40, h)), k);
      // the barrier zone (B-nets, A-nets) stays clear, thinning back in over a few metres
      const C = T.CLR[p.v >= 0 ? 1 : 0], clr = C[i] + (C[i + 1] - C[i]) * t;
      f *= smoothstep(clr, clr + 5, u);
      const bar = T.BAR[p.v >= 0 ? 1 : 0][i];
      if (bar === BARRIER.arena && u < 70) f *= smoothstep(40, 70, u);
    }
    // features stay clear: lakes, tunnel ridges, flats
    for (const L of this.features.lakes) {
      if (x < L.box.minx || x > L.box.maxx || z < L.box.minz || z > L.box.maxz) continue;
      if (L.sdf(x, z) < 12) f = 0;
    }
    for (const fl of this.features.flats) {
      if (Math.abs(x - fl.x) < fl.reach + 6 && Math.abs(z - fl.z) < fl.reach + 6) f = 0;
    }
    f *= 1 - smoothstep(0.55, 0.95, slope);
    if (dB < this.band) f = lerp(worldForest(x, z, h, slope), f, smoothstep(0, this.band, dB));
    return f;
  }

  // Is (x, y, z) inside one of the tunnel tubes? (world/sunglare.js: the terrain march sees the trench the tube
  // sits in as open sky, so the sun's glare would shine through the mountain)
  insideTunnel(x, y, z) {
    const tns = this.features.tunnels;
    if (!tns.length) return false;
    const p = this.track.locate(x, z);
    if (p.far) return false;
    for (const tn of tns) {
      if (p.s > tn.s0 + 0.5 && p.s < tn.s1 - 0.5 && Math.abs(p.v) < tn.cutHalf && y < this.track.surfaceY(p.s, p.v) + 9) return true;
    }
    return false;
  }

  // the object handed to world.addRegion
  get spec() {
    return {
      id: this.id, bounds: this.bounds,
      height: (x, z, spacing) => this.height(x, z, spacing),
      forest: (x, z, h, slope) => this.forest(x, z, h, slope),
      course: this,
    };
  }
}

export { bicubic, bilinear, octFor, DS };
