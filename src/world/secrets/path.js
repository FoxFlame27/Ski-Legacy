// A smoothed centre line for the secrets' cuts, tunnels and trails: arc length, tangents, a fast nearest-point
// projection (signed lateral offset), and height profiles along it. Pure maths (runs in Node for the tools).
import * as THREE from 'three';
import { smoothstep, clamp } from '../../core/noise.js';

const _v = new THREE.Vector3();

export class Path {
  /**
   * @param {number[][]} pts   control points [[x, z], ...] (a centripetal Catmull-Rom runs through them)
   * @param {object} o  step: resample spacing (m); reach: how far from the line projections are answered (m)
   */
  constructor(pts, { step = 2, reach = 80, smooth = true } = {}) {
    let P;
    if (smooth && pts.length > 2) {
      const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
      const len = curve.getLength(), n = Math.max(2, Math.ceil(len / step));
      P = curve.getSpacedPoints(n).map((v) => [v.x, v.z]);
    } else {
      P = [];
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
        for (let k = i === 1 ? 0 : 1; k <= n; k++) P.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
      }
    }
    const n = (this.n = P.length);
    this.X = new Float64Array(n); this.Z = new Float64Array(n); this.S = new Float64Array(n);
    this.TX = new Float64Array(n); this.TZ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.X[i] = P[i][0]; this.Z[i] = P[i][1];
      if (i) this.S[i] = this.S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = this.X[b] - this.X[a], dz = this.Z[b] - this.Z[a], l = Math.hypot(dx, dz) || 1;
      this.TX[i] = dx / l; this.TZ[i] = dz / l;
    }
    this.length = this.S[n - 1];
    this.reach = reach;
    // segment grid for projections
    const C = (this.cell = reach > 40 ? 16 : 12);
    this.grid = new Map();
    let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n - 1; i++) {
      const x0 = Math.min(this.X[i], this.X[i + 1]) - reach, x1 = Math.max(this.X[i], this.X[i + 1]) + reach;
      const z0 = Math.min(this.Z[i], this.Z[i + 1]) - reach, z1 = Math.max(this.Z[i], this.Z[i + 1]) + reach;
      minx = Math.min(minx, x0); minz = Math.min(minz, z0); maxx = Math.max(maxx, x1); maxz = Math.max(maxz, z1);
      for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) {
        for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
          const key = cx * 100003 + cz;
          let arr = this.grid.get(key);
          if (!arr) this.grid.set(key, (arr = []));
          arr.push(i);
        }
      }
    }
    this.bounds = { minx, minz, maxx, maxz };
  }

  /**
   * Nearest point on the line: out.s (arc length), out.d (signed: + = right of the direction of travel),
   * out.dist (|d| from the line; beyond the ends the true distance), out.tx / tz (tangent there).
   * out.dist = Infinity when nothing lies within `reach`.
   */
  project(x, z, out = {}) {
    out.dist = Infinity;
    const arr = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!arr) return out;
    const X = this.X, Z = this.Z, S = this.S;
    let best = Infinity, bi = -1, bt = 0;
    for (let k = 0; k < arr.length; k++) {
      const i = arr[k];
      const ex = X[i + 1] - X[i], ez = Z[i + 1] - Z[i], l2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - X[i]) * ex + (z - Z[i]) * ez) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = X[i] + ex * t - x, pz = Z[i] + ez * t - z, d2 = px * px + pz * pz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    if (bi < 0 || best > this.reach * this.reach) return out;
    const i = bi, t = bt;
    const tx = this.TX[i] + (this.TX[i + 1] - this.TX[i]) * t, tz = this.TZ[i] + (this.TZ[i + 1] - this.TZ[i]) * t;
    const tl = Math.hypot(tx, tz) || 1;
    out.tx = tx / tl; out.tz = tz / tl;
    // signed offset from the segment's own direction (stable across the smoothed tangent)
    const ex = X[i + 1] - X[i], ez = Z[i + 1] - Z[i], el = Math.hypot(ex, ez) || 1;
    // beyond the line's ends s keeps counting (negative before the start, past the length after the end) along the
    // end segment's direction, so a cut that runs to an end stops there instead of reaching on along its axis
    let te = t;
    if (i === 0 || i === this.n - 2) {
      const raw = ((x - X[i]) * ex + (z - Z[i]) * ez) / (el * el);
      if ((i === 0 && raw < 0) || (i === this.n - 2 && raw > 1)) te = raw;
    }
    const qx = X[i] + ex * te, qz = Z[i] + ez * te;
    out.d = ((x - qx) * -ez + (z - qz) * ex) / el;
    out.s = S[i] + (S[i + 1] - S[i]) * te;
    out.dist = Math.sqrt(best);
    out.i = i; out.t = t;
    return out;
  }

  /** position + tangent at arc length s (clamped to the line); also the right vector (rx, rz) */
  at(s, out = {}) {
    const S = this.S, n = this.n;
    s = clamp(s, 0, this.length);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    const t = (s - S[lo]) / Math.max(1e-9, S[hi] - S[lo]);
    out.x = this.X[lo] + (this.X[hi] - this.X[lo]) * t;
    out.z = this.Z[lo] + (this.Z[hi] - this.Z[lo]) * t;
    const tx = this.TX[lo] + (this.TX[hi] - this.TX[lo]) * t, tz = this.TZ[lo] + (this.TZ[hi] - this.TZ[lo]) * t, l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l;
    out.rx = -out.tz; out.rz = out.tx;
    return out;
  }

  /** world point at arc length s, lateral offset d (+ = right) */
  point(s, d = 0, out = {}) {
    this.at(s, out);
    out.x += out.rx * d; out.z += out.rz * d;
    return out;
  }
}

// A height profile along a path from key points [[s, y], ...]: smooth (C1) between keys (eased ends where the
// grade changes), flat beyond the first / last key.
export function keyProfile(keys) {
  const K = keys.slice().sort((a, b) => a[0] - b[0]);
  // Fritsch-Carlson monotone cubic slopes
  const n = K.length, m = new Float64Array(n), d = new Float64Array(Math.max(1, n - 1));
  for (let i = 0; i < n - 1; i++) d[i] = (K[i + 1][1] - K[i][1]) / Math.max(1e-9, K[i + 1][0] - K[i][0]);
  for (let i = 0; i < n; i++) {
    if (i === 0) m[i] = n > 1 ? d[0] : 0;
    else if (i === n - 1) m[i] = d[n - 2];
    else m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (s) => {
    if (s <= K[0][0]) return K[0][1] + (n > 1 ? m[0] * (s - K[0][0]) : 0);
    if (s >= K[n - 1][0]) return K[n - 1][1] + m[n - 1] * (s - K[n - 1][0]);
    let i = 0;
    while (i < n - 2 && s > K[i + 1][0]) i++;
    const h = K[i + 1][0] - K[i][0], t = (s - K[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * K[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * K[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}

/**
 * A rideable floor along a path from the terrain under it: the terrain heights (heightAt(x, z)) every `step` m,
 * low-passed over `window` m, then forced to descend between minGrade and maxGrade (m per m) from the start
 * (when it would climb or drop too steeply, the floor cuts / fills). Returns a sampled profile function.
 */
export function terrainProfile(path, heightAt, { step = 4, window = 24, minGrade = 0.02, maxGrade = 0.4, start = null, end = null } = {}) {
  const N = Math.max(2, Math.ceil(path.length / step) + 1), ds = path.length / (N - 1);
  const raw = new Float64Array(N), p = {};
  for (let i = 0; i < N; i++) { path.at(i * ds, p); raw[i] = heightAt(p.x, p.z); }
  const w = Math.max(1, Math.round(window / ds / 2)), sm = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let k = -w; k <= w; k++) { const j = clamp(i + k, 0, N - 1), wt = 1 - Math.abs(k) / (w + 1); s += raw[j] * wt; c += wt; }
    sm[i] = s / c;
  }
  if (start !== null) sm[0] = start;
  if (end !== null) sm[N - 1] = end;
  const out = new Float64Array(N);
  out[0] = sm[0];
  for (let i = 1; i < N; i++) out[i] = clamp(sm[i], out[i - 1] - maxGrade * ds, out[i - 1] - minGrade * ds);
  // a backward pass keeps the end on its target without breaking the grade limits
  if (end !== null) { out[N - 1] = Math.min(out[N - 1], end); for (let i = N - 2; i >= 0; i--) out[i] = clamp(out[i], out[i + 1] + minGrade * ds, out[i + 1] + maxGrade * ds); }
  const f = (s) => { const u = clamp(s / ds, 0, N - 1), i = Math.min(N - 2, Math.floor(u)), t = u - i; return out[i] + (out[i + 1] - out[i]) * t; };
  f.samples = out; f.ds = ds; f.raw = raw;
  return f;
}

export { smoothstep, clamp };
