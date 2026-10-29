// The scenic network's tools (scenic.js plans the roads with them). Pure layout (no THREE): runs in Node too.
// (roads.js imports scenic.js imports this module: nothing from roads.js is used at the top level here)
import { world } from '../../world/world.js';
import { CLEAR } from './roads.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const CELL = 20;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]];
const DIRN = DIRS.map(([x, z]) => { const l = Math.hypot(x, z); return [x / l, z / l]; });
const DANG = DIRN.map(([x, z]) => Math.atan2(x, z));

class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

/**
 * A* on a 20 m grid whose states carry the heading (16 directions): no turn sharper than `maxTurn` per step, so a
 * climb up a step too steep for `maxGrade` comes out as proper switchbacks (hairpins of ~25 m radius, legs well apart)
 * instead of the plain grid A*'s sawtooth of 20 m zigzags (which the smoothing folds into ~6 m kinks).
 * a, b: { x, z }; opts: { obstacles, bad(x, z), margin, maxGrade, maxTurn (rad), dirA, dirB (start / end heading, rad) }
 * -> [[x, z]...] (a first, b last) or null
 */
export function routeH(a, b, opts = {}) {
  const margin = opts.margin ?? 400, maxGrade = opts.maxGrade ?? 0.1, maxTurn = opts.maxTurn ?? 0.8;
  const minx = Math.min(a.x, b.x) - margin, minz = Math.min(a.z, b.z) - margin;
  const W = Math.ceil((Math.max(a.x, b.x) + margin - minx) / CELL) + 1, H = Math.ceil((Math.max(a.z, b.z) + margin - minz) / CELL) + 1;
  const N = W * H, ND = DIRS.length;
  const hgt = new Float32Array(N).fill(NaN), pen = new Float32Array(N).fill(NaN);
  const g = new Float32Array(N * ND).fill(Infinity), len = new Float32Array(N * ND), yr = new Float32Array(N * ND), from = new Int32Array(N * ND).fill(-1), closed = new Uint8Array(N * ND);
  const corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }, qo = {};
  const X = (i) => minx + (i % W) * CELL, Z = (i) => minz + Math.floor(i / W) * CELL;
  // (the ground's broad shape: local crags averaged out, the road's cut and fill deal with those)
  const sm = opts.smooth ?? 16;
  const height = (i) => {
    if (Number.isNaN(hgt[i])) { const x = X(i), z = Z(i); hgt[i] = (world.height(x, z, 8) * 2 + world.height(x + sm, z, 8) + world.height(x - sm, z, 8) + world.height(x, z + sm, 8) + world.height(x, z - sm, 8)) / 6; }
    return hgt[i];
  };
  const penalty = (i) => {
    if (!Number.isNaN(pen[i])) return pen[i];
    const x = X(i), z = Z(i), e = 8;
    const gx = (world.height(x + e, z, 8) - world.height(x - e, z, 8)) / (2 * e), gz = (world.height(x, z + e, 8) - world.height(x, z - e, 8)) / (2 * e);
    const s = Math.hypot(gx, gz);
    let p = 1 + Math.max(0, s - 0.18) * 6 + (s > 0.8 ? (opts.steepPen ?? 30) : 0);
    const q = opts.obstacles?.query(x, z, qo);
    if (q && (q.ski < CLEAR.ski || q.net < CLEAR.net || q.block < CLEAR.block || q.rail < CLEAR.rail)) return (pen[i] = Infinity);
    if (opts.bad && opts.bad(x, z)) return (pen[i] = Infinity);
    if (q && q.lift < 4) p += 800;
    world.corridorAt(x, z, corr);
    if (corr.kind === 'lift' && corr.d < 2 && !(q && q.lift < 6)) return (pen[i] = Infinity);
    if ((corr.kind === 'piste' || corr.kind === 'race') && corr.d < CLEAR.ski) return (pen[i] = Infinity);
    return (pen[i] = p);
  };
  const cell = (p) => clamp(Math.round((p.x - minx) / CELL), 0, W - 1) + clamp(Math.round((p.z - minz) / CELL), 0, H - 1) * W;
  const s0 = cell(a), s1 = cell(b), bx = X(s1), bz = Z(s1);
  const angDiff = (p, q) => Math.abs(Math.atan2(Math.sin(p - q), Math.cos(p - q)));
  const open = new Heap();
  for (let q = 0; q < ND; q++) {
    if (opts.dirA !== undefined && angDiff(DANG[q], opts.dirA) > 0.5) continue;
    g[s0 * ND + q] = 0; yr[s0 * ND + q] = opts.y0 ?? 0; open.push(Math.hypot(X(s0) - bx, Z(s0) - bz), s0 * ND + q);
  }
  let iter = 0, end = -1;
  while (open.size && iter++ < 1500000) {
    const st = open.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const i = (st / ND) | 0, qi = st % ND;
    if (i === s1 && (opts.dirB === undefined || angDiff(DANG[qi], opts.dirB) < 0.7)) { end = st; break; }
    const ix = i % W, iz = (i - ix) / W, hi = height(i);
    for (let q = 0; q < ND; q++) {
      const turn = angDiff(DANG[q], DANG[qi]);
      if (turn > maxTurn + 1e-3) continue;
      const [dx, dz] = DIRS[q], jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= W || jz >= H) continue;
      const j = jx + jz * W, sj = j * ND + q;
      if (closed[sj]) continue;
      const d = Math.hypot(dx, dz) * CELL, gr = Math.abs(height(j) - hi) / d;
      if (gr > maxGrade && !opts.soft) continue;
      const pj = penalty(j);
      if (pj === Infinity) continue;
      const gc = 1 + (gr / 0.1) ** 4 * 0.4;
      // (the profile: with y0 / y1 given, ground the road could not reach from either end at maxGrade (this far along
      // from a, at least this far from b) is a cut or a fill: it costs by the metre)
      // (the road's own height along the way: it follows the ground within maxGrade from where it was; where it
      // can't, the difference is a cut or a fill: by the metre. And it must still be able to reach y1 at b)
      const L = len[st] + d, hj = height(j);
      let ex = 0, yn = hj;
      if (opts.y0 !== undefined) { yn = clamp(hj, yr[st] - maxGrade * d, yr[st] + maxGrade * d); ex += Math.abs(hj - yn) * (d / CELL); }
      if (opts.y1 !== undefined) ex += Math.max(0, Math.abs(yn - opts.y1) - maxGrade * Math.hypot(X(j) - bx, Z(j) - bz)) * (d / CELL);
      const c = g[st] + d * gc * pj + (opts.turnW ?? 300) * turn * turn + (turn > 0.01 ? (opts.bendC ?? 30) : 0) + (gr > maxGrade ? (opts.grK ?? 1) * 3000 * (gr - maxGrade) / 0.01 : 0) + ex * (opts.exK ?? 40);
      if (c < g[sj]) { g[sj] = c; len[sj] = L; yr[sj] = yn; from[sj] = st; open.push(c + Math.hypot(X(j) - bx, Z(j) - bz), sj); }
    }
  }
  if (end < 0) return null;
  const out = [];
  for (let st = end; st >= 0; st = from[st]) out.push([X((st / ND) | 0), Z((st / ND) | 0)]);
  out.reverse();
  out[0] = [a.x, a.z]; out[out.length - 1] = [b.x, b.z];
  return out;
}

// the tightest bend of a path ([[x, z]...] every ~4 m), over ~24 m windows (m)
export function minRadius(p, k = 3) {
  let m = Infinity;
  for (let i = k; i < p.length - k; i++) {
    const ax = p[i][0] - p[i - k][0], az = p[i][1] - p[i - k][1], bx = p[i + k][0] - p[i][0], bz = p[i + k][1] - p[i][1];
    const t = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (t > 1e-3) m = Math.min(m, (Math.hypot(ax, az) + Math.hypot(bx, bz)) / t);
  }
  return m;
}

// the closest two stretches of a path come (more than `gap` m apart along it): the switchbacks' legs must not touch
export function selfClearance(p, gap = 80, step = 2) {
  let m = Infinity;
  const ds = 4, skip = Math.ceil(gap / ds);
  for (let i = 0; i < p.length; i += step) for (let j = i + skip; j < p.length; j += step) m = Math.min(m, Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]));
  return m;
}

// Douglas-Peucker
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a], [bx, bz] = pts[b], ex = bx - ax, ez = bz - az, l = Math.hypot(ex, ez) || 1;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * ez - (pts[i][1] - az) * ex) / l; if (d > bd) { bd = d; best = i; } }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const resample = (p, step) => {
  const out = [p[0]];
  let carry = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], L = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= L) { out.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); t += step; }
    carry = L - (t - step);
  }
  const last = p[p.length - 1], ol = out[out.length - 1];
  if (Math.hypot(last[0] - ol[0], last[1] - ol[1]) > 1) out.push(last);
  return out;
};
/**
 * A routed line made a road: the grid's wiggles straightened (Douglas-Peucker, wide), corners rounded (Chaikin), then
 * every bend opened up to `minR` (default 60 m) except the hairpins (a half turn within ~70 m: those keep their
 * radius, the switchbacks' legs must not move), resampled every 4 m. `fixed`: points at either end kept as they are.
 */
export function smoothRoute(pts, { eps = 12, minR = 60, step = 4, fixedA = 0, fixedB = 0 } = {}) {
  const A = pts.slice(0, fixedA), B = fixedB ? pts.slice(pts.length - fixedB) : [];
  let p = simplify(pts.slice(Math.max(0, fixedA - 1), pts.length - Math.max(0, fixedB - 1)), eps);
  for (let k = 0; k < 5; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) { const [ax, az] = p[i], [bx, bz] = p[i + 1]; q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]); }
    q.push(p[p.length - 1]);
    p = q;
  }
  p = resample(p, step);
  const n = p.length, maxTurn = step / minR, head = (i) => Math.atan2(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  const W = Math.ceil(36 / step);
  for (let it = 0; it < 300; it++) {
    let moved = false;
    for (let i = 2; i < n - 2; i++) {
      const t = Math.abs(Math.atan2(Math.sin(head(i) - head(i - 1)), Math.cos(head(i) - head(i - 1))));
      if (t <= maxTurn) continue;
      const a = Math.max(0, i - W), b = Math.min(n - 2, i + W);
      if (Math.abs(Math.atan2(Math.sin(head(b) - head(a)), Math.cos(head(b) - head(a)))) > 2.2) continue; // (a hairpin)
      const mx = (p[i - 1][0] + p[i + 1][0]) / 2, mz = (p[i - 1][1] + p[i + 1][1]) / 2;
      p[i] = [p[i][0] + (mx - p[i][0]) * 0.5, p[i][1] + (mz - p[i][1]) * 0.5];
      moved = true;
    }
    if (!moved) break;
  }
  p = resample(p, step);
  return [...A.slice(0, -1), ...p, ...B.slice(1)];
}
