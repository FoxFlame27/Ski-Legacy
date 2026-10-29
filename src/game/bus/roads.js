// Ski-bus roads: plowed snow roads between the bus stops (the village plaza and every gondola base), planned once
// while the game loads, BEFORE the terrain, the trees and the props are built (main.js calls planBusRoads right
// after initLayout / initSecrets): the road bench is carved into the terrain (a world cut: gentle grades, a flat
// road across the slope, snow embankments either side) and a corridor keeps trees and rocks off it.
// Pure layout (no THREE): it runs in Node too (tools: node -e "import('./src/game/bus/roads.js')...").
//
// Routing: A* on a 16 m grid (16 directions) whose cost favours gentle grades and gentle side slopes, keeps off the
// pistes (crossing one is allowed, running along it is not) and around the village buildings. The path is smoothed,
// resampled every 4 m and given a height profile (the terrain along it, smoothed, grades capped at ~11 %).
// The network is a tree: the village to each base, a base on the way reused as a junction (Sonnenkopf on the way
// down the valley), so roads never run twice over the same ground.
import { world } from '../../world/world.js';
import { layout, VILLAGE_BUILDINGS, PISTE_WIDTH, ensureRaceCells } from '../../world/layout.js';
import { RAIL } from '../../world/railroute.js';
import { planScenic, shapeScenic } from './scenic.js'; // the scenic mountain road (Panoramastrasse) + its roundabout
import { planScenicLoop } from './scenicloop.js'; // the Passstrasse and the loop round the back of the mountains
import { planChaletVillage, planAlmdorfStop } from './chaletroad.js'; // the Chaletweg up through the chalet village (Almdorf)
import { planScenicBus, planWestgratBus } from './scenicbus.js'; // the ski bus's stops up the scenic roads
import { planRentalRoad } from './rentalroad.js'; // the Westgratstrasse: across from the car rental, up the Westgrat
import { clearRouteCache } from './scenicnet.js'; // (the routing's ground samples: freed once the roads are planned)

const CELL = 20;
const MAX_GRADE = 0.135;     // (alpine post roads: up to ~13 % in places)
const TURN_W = 110;        // cost of turning (per rad^2): long sweeping bends, few hairpins
export const ROAD_HALF = 3.4;   // half the plowed width (m)
const BENCH = ROAD_HALF + 5.2;  // flat shoulder either side of the centre line (the plough berms sit on it)
// where the berm starts to rise (a strip of packed shoulder before it): 2.9 m past the plowed edge, so that every 2 m
// triangle of the drawn terrain touching the road (up to 2.83 m off it) is on the flat shoulder; before (0.8 m) the
// berm's foot lifted the drawn terrain under the road's edge up to ~0.4 m (the strip's edge, laid on that terrain,
// curled up off the road surface you drive and walk on)
const BERM_IN = ROAD_HALF + 2.9;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// 16 directions: the 8 neighbours and the knight moves (smoother angles than a plain 8-grid)
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
const DIRN = DIRS.map(([x, z]) => { const l = Math.hypot(x, z); return [x / l, z / l]; });

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

// ------------------------------------------------------------------ what the roads keep clear of
// Ski areas are hard obstacles: pistes, ski lanes, races (+ their start and finish arenas) and the park with a wide
// margin, safety nets, lift stations and towers, huts and village buildings, the railway. Crossing one is not
// allowed (a stop that can't be reached cleanly is moved or left to the travel card); only lift lines may be
// passed under, where unavoidable, at a high cost (a short crossing at a right angle).
// kinds: ski (piste / race / park), net, block (buildings, stations, towers, arenas), rail, lift (a lift line)
const CLEAR = { ski: 10, net: 10, block: 12, rail: 12 }; // metres from the road's centre line (bus + overhang ~4.4 m)
const KINDS = ['ski', 'net', 'block', 'rail', 'lift'];
class Obstacles {
  constructor() { this.G = 64; this.grid = new Map(); this.n = 0; }
  add(ax, az, bx, bz, w, kind, ref = null) {
    const sg = { ax, az, bx, bz, w, kind, ref }, R = w + 40, G = this.G;
    for (let cx = Math.floor((Math.min(ax, bx) - R) / G); cx <= Math.floor((Math.max(ax, bx) + R) / G); cx++) {
      for (let cz = Math.floor((Math.min(az, bz) - R) / G); cz <= Math.floor((Math.max(az, bz) + R) / G); cz++) {
        const key = cx * 100003 + cz;
        let arr = this.grid.get(key);
        if (!arr) this.grid.set(key, (arr = []));
        arr.push(sg);
      }
    }
    this.n++;
  }
  line(pts, w, kind, ref, get = (p) => p) {
    for (let i = 0; i < pts.length - 1; i++) { const a = get(pts[i]), b = get(pts[i + 1]); this.add(a[0], a[1], b[0], b[1], w, kind, ref); }
  }
  disc(x, z, r, kind, ref) { this.add(x, z, x, z, r, kind, ref); }
  /** Clearance from (x, z) to the nearest obstacle of each kind (distance minus its half width), and which. */
  query(x, z, out = {}) {
    for (const k of KINDS) { out[k] = Infinity; out[k + 'Ref'] = null; }
    const arr = this.grid.get(Math.floor(x / this.G) * 100003 + Math.floor(z / this.G));
    if (!arr) return out;
    for (const s of arr) {
      const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1) : 0;
      const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z) - s.w;
      if (d < out[s.kind]) { out[s.kind] = d; out[s.kind + 'Ref'] = s.ref; }
    }
    return out;
  }
}

export function buildObstacles(stops) {
  const O = new Obstacles();
  // the procedural races (and their chairlifts) of the area the roads cross are laid out now (deterministic)
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const s of stops) { minx = Math.min(minx, s.x); minz = Math.min(minz, s.z); maxx = Math.max(maxx, s.x); maxz = Math.max(maxz, s.z); }
  try { ensureRaceCells(minx - 900, minz - 900, maxx + 900, maxz + 900); } catch (e) { console.warn('bus roads: race cells', e); }
  const P = (p) => (Array.isArray(p) ? p : [p.x, p.z]);
  for (const p of layout.pistes) if (p.pts?.length > 1) O.line(p.pts, PISTE_WIDTH[p.diff] ?? 20, 'ski', p.name, P);
  for (const r of layout.races) {
    if (r.path?.length > 1) O.line(r.path, r.halfWidth ?? 16, 'ski', r.name, P);
    if (r.start) O.disc(r.start.x, r.start.z, 30, 'block', `${r.name} start`);
    if (r.finish) O.disc(r.finish.x, r.finish.z, 55, 'block', `${r.name} finish arena`);
  }
  if (layout.park?.line?.length > 1) O.line(layout.park.line, layout.park.halfWidth ?? 17, 'ski', 'Legacy Park', P);
  for (const n of layout.nets) if (n.line?.length > 1 && !n.fence) O.line(n.line, 0.6, 'net', `net ${n.type || ''}`, P); // (the piste fences hug the runs: the 'ski' clearance covers them)
  for (const l of layout.lifts) {
    if (l.offRoad) continue; // (the Hochalm Gondola: built at the end of the Hochalmstrasse, beside its car park)
    const gond = l.type === 'gondola';
    O.add(l.bottom.x, l.bottom.z, l.top.x, l.top.z, gond ? 9 : 7, 'lift', l.name);
    for (const t of l.towers || []) if (t.x !== undefined) O.disc(t.x, t.z, 2, 'block', `${l.name} tower`);
    for (const st of [l.bottom, l.top, l.mid]) if (st) O.disc(st.x, st.z, gond ? 26 : 16, 'block', `${l.name} station`);
  }
  for (const h of layout.huts) O.disc(h.x, h.z, 22, 'block', h.name);
  for (const [x, z] of VILLAGE_BUILDINGS) O.disc(x, z, 20, 'block', 'village building');
  for (let i = 0; i + 4 < RAIL.n; i += 4) O.add(RAIL.X[i], RAIL.Z[i], RAIL.X[i + 4], RAIL.Z[i + 4], 3, 'rail', 'Wolkenspitzbahn');
  return O;
}

// A* from a to b ({x, z}) -> [[x, z], ...] or null
export function route(a, b, opts = {}) {
  const margin = opts.margin ?? 700;
  const minx = Math.min(a.x, b.x) - margin, minz = Math.min(a.z, b.z) - margin;
  const W = Math.ceil((Math.max(a.x, b.x) + margin - minx) / CELL) + 1, H = Math.ceil((Math.max(a.z, b.z) + margin - minz) / CELL) + 1;
  const N = W * H;
  const hgt = new Float32Array(N).fill(NaN), pen = new Float32Array(N).fill(NaN);
  const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }, qo = {};
  const X = (i) => minx + (i % W) * CELL, Z = (i) => minz + Math.floor(i / W) * CELL;
  const height = (i) => { if (Number.isNaN(hgt[i])) hgt[i] = world.height(X(i), Z(i), 8); return hgt[i]; };
  // per-cell extra cost factor: side slope, pistes, lift lines, buildings
  const penalty = (i) => {
    if (!Number.isNaN(pen[i])) return pen[i];
    const x = X(i), z = Z(i), e = 8;
    const gx = (world.height(x + e, z, 8) - world.height(x - e, z, 8)) / (2 * e), gz = (world.height(x, z + e, 8) - world.height(x, z - e, 8)) / (2 * e);
    const s = Math.hypot(gx, gz);
    let p = 1 + Math.max(0, s - 0.18) * 9 + (s > 0.7 ? 60 : 0);
    const q = opts.obstacles?.query(x, z, qo);
    if (q && (q.ski < CLEAR.ski || q.net < CLEAR.net || q.block < CLEAR.block || q.rail < CLEAR.rail)) return (pen[i] = Infinity);
    if (opts.bad && opts.bad(x, z)) return (pen[i] = Infinity); // (a caller's own no-go ground: the scenic road's)
    if (q && q.lift < 4) p += 800; // under a lift line: only where there is no way round, and straight across
    // other cleared strips (secret passages, tunnels' approaches): keep off too
    world.corridorAt(x, z, corr);
    if (corr.kind === 'lift' && corr.d < 2 && !(q && q.lift < 6)) return (pen[i] = Infinity);
    if ((corr.kind === 'piste' || corr.kind === 'race') && corr.d < CLEAR.ski) return (pen[i] = Infinity);
    return (pen[i] = p);
  };
  const cell = (p) => clamp(Math.round((p.x - minx) / CELL), 0, W - 1) + clamp(Math.round((p.z - minz) / CELL), 0, H - 1) * W;
  const s0 = cell(a), s1 = cell(b), bx = X(s1), bz = Z(s1);
  const open = new Heap();
  g[s0] = 0; open.push(0, s0);
  let iter = 0;
  while (open.size && iter++ < 400000) {
    const i = open.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === s1) break;
    const ix = i % W, iz = (i - ix) / W, hi = height(i);
    // the way we came in (turning costs extra)
    let inx = 0, inz = 0;
    if (from[i] >= 0) { const f = from[i], fx = f % W, fz = (f - fx) / W, l = Math.hypot(ix - fx, iz - fz); inx = (ix - fx) / l; inz = (iz - fz) / l; }
    for (let q = 0; q < DIRS.length; q++) {
      const [dx, dz] = DIRS[q];
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= W || jz >= H) continue;
      const j = jx + jz * W;
      if (closed[j]) continue;
      const d = Math.hypot(dx, dz) * CELL, gr = Math.abs(height(j) - hi) / d;
      // grade: free up to ~6 %, then rising fast; beyond ~16 % only as a last resort
      const gc = 1 + (gr / 0.1) ** 4 * 0.6 + (gr > 0.17 ? 40 : 0);
      if (opts.maxGrade && gr > opts.maxGrade) continue; // (a hard cap: the scenic road zigzags up a step instead)
      const pj = penalty(j);
      if (pj === Infinity) continue;
      const turn = inx || inz ? Math.acos(clamp(inx * DIRN[q][0] + inz * DIRN[q][1], -1, 1)) : 0;
      const c = g[i] + d * gc * pj + TURN_W * turn * turn;
      if (c < g[j]) { g[j] = c; from[j] = i; open.push(c + Math.hypot(X(j) - bx, Z(j) - bz), j); }
    }
  }
  if (from[s1] < 0) return null;
  const out = [];
  for (let i = s1; i >= 0; i = from[i]) out.push([X(i), Z(i)]);
  out.reverse();
  out[0] = [a.x, a.z]; out[out.length - 1] = [b.x, b.z];
  return out;
}

// Douglas-Peucker: drop the grid's stair steps (longer straights -> wider bends after the corner cutting)
function simplify(pts, eps = 5) {
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

// Chaikin corner cutting (ends kept), then an even resampling every `step` metres
export function smoothPath(pts, iters = 4, step = 4) {
  let p = simplify(pts);
  for (let k = 0; k < iters; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  const out = [p[0]];
  let carry = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], L = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= L) { out.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); t += step; }
    carry = L - (t - step);
  }
  const last = p[p.length - 1], ol = out[out.length - 1];
  if (Math.hypot(last[0] - ol[0], last[1] - ol[1]) > 0.5) out.push(last);
  return relax(out, step);
}

// widen the tightest bends (a bus needs ~12 m; the road strip and its banks must not fold over themselves):
// points on a too-tight bend move toward their neighbours' midpoint until the turn per step is small enough
function relax(pts, step, minR = 13) {
  const n = pts.length, maxTurn = step / minR;
  for (let it = 0; it < 160; it++) {
    let worst = 0;
    for (let i = 1; i < n - 1; i++) {
      const ax = pts[i][0] - pts[i - 1][0], az = pts[i][1] - pts[i - 1][1], bx = pts[i + 1][0] - pts[i][0], bz = pts[i + 1][1] - pts[i][1];
      const t = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      if (t <= maxTurn) continue;
      worst = Math.max(worst, t);
      const mx = (pts[i - 1][0] + pts[i + 1][0]) / 2, mz = (pts[i - 1][1] + pts[i + 1][1]) / 2;
      pts[i] = [pts[i][0] + (mx - pts[i][0]) * 0.6, pts[i][1] + (mz - pts[i][1]) * 0.6];
    }
    if (worst <= maxTurn) break;
  }
  return pts;
}

// a road: centre line every ~4 m with heights, arc lengths and headings
export function makeRoad(pts, a, b, { y0 = null, y1 = null, maxGrade = MAX_GRADE, envelope = false } = {}) {
  const n = pts.length;
  const X = new Float32Array(n), Z = new Float32Array(n), Y = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) { X[i] = pts[i][0]; Z[i] = pts[i][1]; if (i) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]); }
  // height: the terrain along the line (a little wider than the road, so a ditch or a hump does not count),
  // smoothed over ~60 m, then the grade capped both ways; the ends sit on the stops' pads
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = world.height(X[i], Z[i]);
  let sm = raw;
  for (let pass = 0; pass < 3; pass++) {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, w = 0;
      for (let k = -7; k <= 7; k++) { const j = clamp(i + k, 0, n - 1), wt = 8 - Math.abs(k); s += sm[j] * wt; w += wt; }
      o[i] = s / w;
    }
    sm = o;
  }
  // ends: blend back to the real ground at the stops
  for (let i = 0; i < n; i++) {
    const k = Math.min(smoothstep(0, 40, S[i]), smoothstep(0, 40, S[n - 1] - S[i]));
    Y[i] = raw[i] + (sm[i] - raw[i]) * k;
  }
  // (an access road meets a lot and the road it joins at their own heights)
  if (y0 !== null) for (let i = 0; i < n; i++) Y[i] += (y0 - Y[0]) * (1 - smoothstep(0, 40, S[i]));
  if (y1 !== null) for (let i = 0; i < n; i++) Y[i] += (y1 - Y[n - 1]) * (1 - smoothstep(0, 40, S[n - 1] - S[i]));
  // (envelope: both ends fixed, every point within reach of both at maxGrade: never a step at an end; the scenic roads)
  if (envelope && y0 !== null && y1 !== null) for (let i = 0; i < n; i++) Y[i] = clamp(Y[i], Math.max(y0 - maxGrade * S[i], y1 - maxGrade * (S[n - 1] - S[i])), Math.min(y0 + maxGrade * S[i], y1 + maxGrade * (S[n - 1] - S[i])));
  for (let i = 1; i < n; i++) { const d = S[i] - S[i - 1]; Y[i] = clamp(Y[i], Y[i - 1] - maxGrade * d, Y[i - 1] + maxGrade * d); }
  for (let i = n - 2; i >= 0; i--) { const d = S[i + 1] - S[i]; Y[i] = clamp(Y[i], Y[i + 1] - maxGrade * d, Y[i + 1] + maxGrade * d); }
  if (y1 !== null) Y[n - 1] = y1;
  if (y0 !== null) Y[0] = y0;
  return { from: a, to: b, n, X, Z, Y, S, length: S[n - 1] };
}

/** Point on a road at arc length s: { x, y, z, dx, dz (unit heading), grade, i } */
export function roadAt(road, s, out = {}) {
  const { S, X, Y, Z, n } = road;
  s = clamp(s, 0, S[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const t = (s - S[lo]) / Math.max(1e-6, S[hi] - S[lo]);
  out.x = X[lo] + (X[hi] - X[lo]) * t; out.y = Y[lo] + (Y[hi] - Y[lo]) * t; out.z = Z[lo] + (Z[hi] - Z[lo]) * t;
  // heading: over ~10 m (smoother than one 4 m segment)
  const a = Math.max(0, lo - 1), b = Math.min(n - 1, hi + 1), dx = X[b] - X[a], dz = Z[b] - Z[a], l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l; out.dz = dz / l;
  out.grade = (Y[b] - Y[a]) / Math.max(1e-6, S[b] - S[a]);
  out.i = lo;
  return out;
}

// ------------------------------------------------------------------ what stands beside the roads
// Roadside things (snow poles, reflector posts, guardrails, car-park props) never stand on a lane, in a junction's
// mouth, on a car park or in its entrance, or where the car in a lay-by is parked. The lanes: road segments in a
// grid of 16 m cells (built once the network is planned).
let laneG = null;
function laneGrid() {
  if (laneG && laneG.n === busRoads.roads.length) return laneG;
  const C = 16, map = new Map(), PAD = 16;
  busRoads.roads.forEach((r, ri) => {
    for (let i = 0; i < r.n - 1; i++) {
      const sg = { ax: r.X[i], az: r.Z[i], bx: r.X[i + 1], bz: r.Z[i + 1], ri, s: r.S[i] };
      for (let gx = Math.floor((Math.min(sg.ax, sg.bx) - PAD) / C); gx <= Math.floor((Math.max(sg.ax, sg.bx) + PAD) / C); gx++) {
        for (let gz = Math.floor((Math.min(sg.az, sg.bz) - PAD) / C); gz <= Math.floor((Math.max(sg.az, sg.bz) + PAD) / C); gz++) {
          const key = gx * 100003 + gz;
          let arr = map.get(key);
          if (!arr) map.set(key, (arr = []));
          arr.push(sg);
        }
      }
    }
  });
  laneG = { C, map, n: busRoads.roads.length };
  return laneG;
}

/**
 * Distance from (x, z) to the nearest road centre line (up to ~16 m; Infinity beyond), leaving out road `own`
 * within `win` m of arc length `s` along it (where a prop stands beside its own road).
 */
export { BENCH, BERM_IN, MAX_GRADE, CLEAR, nearestRoadPoint };
// The ground on and beside a road for world.groundHeight: the road's smooth surface (the exact height + 3.5 cm, as
// bus.js draws it) across the plowed width, easing back to the drawn terrain over the next 1.5 m of shoulder;
// null away from the roads. (mesh: the drawn-terrain height there, already looked up)
world.roadSurface = (x, z, mesh) => {
  if (!busRoads.roads.length) return null;
  const d = laneDistance(x, z);
  if (d > ROAD_HALF + 2) return null;
  const r = world.height(x, z) + 0.035;
  if (d <= ROAD_HALF + 0.5) return r;
  return r + (mesh - r) * clamp((d - ROAD_HALF - 0.5) / 1.5, 0, 1);
};
// No snow marks on a plowed road (its width + a little) or a car park (snowfx.js noSnow); isRoadNear: beside one
// (the road's smooth surface stands a little off the drawn terrain there, which is not a deck)
world.isPaved = (x, z) => {
  if (!busRoads.roads.length) return false;
  if (laneDistance(x, z) <= ROAD_HALF + 0.3) return true;
  for (const L of busRoads.lots) {
    if (L.hw === undefined || L.ux === undefined) continue;
    const dx = x - L.x, dz = z - L.z;
    if (Math.abs(dx) > L.hw + L.hd + 2 || Math.abs(dz) > L.hw + L.hd + 2) continue;
    if (Math.abs(dx * L.ux + dz * L.uz) <= L.hw + 0.3 && Math.abs(dx * L.vx + dz * L.vz) <= L.hd + 0.3) return true;
  }
  return false;
};
world.isRoadNear = (x, z) => busRoads.roads.length > 0 && laneDistance(x, z) <= ROAD_HALF + 2.2;
export function laneDistance(x, z, own = -1, s = 0, win = 0) {
  const G = laneGrid(), arr = G.map.get(Math.floor(x / G.C) * 100003 + Math.floor(z / G.C));
  let d = Infinity;
  if (arr) {
    for (const g of arr) {
      if (g.ri === own && Math.abs(g.s - s) < win) continue;
      const ex = g.bx - g.ax, ez = g.bz - g.az, l2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - g.ax) * ex + (z - g.az) * ez) / l2, 0, 1);
      const q = Math.hypot(g.ax + ex * t - x, g.az + ez * t - z);
      if (q < d) d = q;
    }
  }
  return d;
}

/**
 * Why a roadside prop of radius r may not stand at (x, z), or null when it may: 'lane' (on a road: its half width
 * + 0.3 m), 'junction' (within 14 m of where an access road joins), 'car park' (on one, 1 m round it, or in its
 * entrance), 'lay-by' (where the car is parked). own / s: the prop's own road and where along it (that road
 * counts only away from there: a hairpin coming back past it). lots: false for the car parks' own props.
 */
export function roadsideBlocked(x, z, r = 0.3, own = -1, s = 0, { lots = true } = {}) {
  if (!busRoads.roads.length) return null;
  if (laneDistance(x, z, own, s, 40) < ROAD_HALF + 0.3 + r) return 'lane';
  for (const j of busRoads.junctions) if (Math.abs(j.x - x) < 14 + r && Math.abs(j.z - z) < 14 + r && Math.hypot(j.x - x, j.z - z) < 14 + r) return 'junction';
  if (lots) {
    for (const L of busRoads.lots) {
      const dx = x - L.x, dz = z - L.z, u = dx * L.ux + dz * L.uz, v = dx * L.vx + dz * L.vz;
      if (Math.abs(u) < L.hw + 1 + r && Math.abs(v) < L.hd + 1 + r) return 'car park';
      if (Math.hypot(x - L.ex, z - L.ez) < 10 + r) return 'car park';
    }
  }
  for (const lb of busRoads.laybys || []) {
    const fx = Math.sin(lb.yaw), fz = Math.cos(lb.yaw), dx = x - lb.x, dz = z - lb.z;
    if (Math.abs(dx * fx + dz * fz) < 9 + r && Math.abs(dx * fz - dz * fx) < 2.2 + r) return 'lay-by';
  }
  return null;
}

/**
 * Where people wait at a stop (the sign's side of the road, as skibus.js besideBay places the sign: the bus's right
 * where its front door stops, 7 m from the road's end): { face (toward the road), pick(rnd) -> { x, z } } or null
 * (no road). pick: a spot 2-6 m off the plowed edge, within ~5 m along of the sign, clear of the sign and bench
 * and of every road's lane (>= 1.5 m off its plowed edge).
 */
export function stopWaitArea(stop) {
  // (a stop part way along a road, as Almdorf at the chalet village's junction: its bus legs, as skibus.js besideBay)
  const legs = busRoads.busLegs || [];
  const r = legs.find((q) => q.to === stop) || busRoads.roads.find((q) => q.to === stop) || legs.find((q) => q.from === stop) || busRoads.roads.find((q) => q.from === stop);
  if (!r) return null;
  const arriving = r.to === stop, p = roadAt(r, arriving ? r.length - 4 : 10);
  const px = p.x, pz = p.z, ax = p.dx, az = p.dz, rx = -p.dz, rz = p.dx; // along the road; its right (the sign's side)
  const pick = (rnd = Math.random) => {
    let x = px + rx * (ROAD_HALF + 5), z = pz + rz * (ROAD_HALF + 5);
    for (let k = 0; k < 16; k++) {
      const u = (rnd() - 0.5) * 10, v = ROAD_HALF + 2 + rnd() * 4;
      if (Math.abs(u) < 3 && v < ROAD_HALF + 4.4) continue; // (the sign and the bench)
      const qx = px + ax * u + rx * v, qz = pz + az * u + rz * v;
      if (laneDistance(qx, qz) < ROAD_HALF + 1.6) continue;
      x = qx; z = qz; break;
    }
    return { x, z };
  };
  return { x: px + rx * (ROAD_HALF + 4), z: pz + rz * (ROAD_HALF + 4), face: Math.atan2(-rx, -rz), pick };
}

// ------------------------------------------------------------------ the network + terrain shaping
export const busRoads = { roads: [], stops: [], lots: [], junctions: [], ready: false, ms: 0 };

/**
 * Plan the roads between the stops ({ x, z, name }[], the village first) and shape them into the world.
 * Safe to call more than once (only the first call plans). Returns busRoads.
 */
export function planBusRoads(stops) {
  if (busRoads.ready) return busRoads;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  busRoads.stops = stops;
  if (stops.length < 2) { busRoads.ready = true; return busRoads; }
  const obstacles = buildObstacles(stops);
  busRoads.obstacles = obstacles;
  // each stop stands on clear ground: where it would sit in a ski area, by a station or a building, it moves to
  // the nearest clear spot (within ~200 m); a stop with none nearby gets no road (the travel card serves it)
  const usable = [];
  for (const s of stops) {
    const spot = clearSpot(s, obstacles);
    if (!spot) { s.noRoad = true; continue; }
    if (Math.hypot(spot.x - s.x, spot.z - s.z) > 0.5) { s.movedFrom = { x: s.x, z: s.z }; s.x = spot.x; s.z = spot.z; }
    usable.push(s);
  }
  if (!usable.includes(stops[0])) { busRoads.ready = true; return busRoads; }
  stops = usable;
  // attach every stop to the network, nearest the village first; a stop joins at the nearest stop already
  // connected when that is on its way (no more than ~35 % longer than going there directly from the village)
  const v = stops[0];
  const linked = [v];
  const rest = stops.slice(1).sort((p, q) => Math.hypot(p.x - v.x, p.z - v.z) - Math.hypot(q.x - v.x, q.z - v.z));
  for (const s of rest) {
    let from = v, best = Math.hypot(s.x - v.x, s.z - v.z);
    for (const l of linked) {
      if (l === v) continue;
      const via = Math.hypot(l.x - v.x, l.z - v.z) + Math.hypot(s.x - l.x, s.z - l.z);
      if (via < best * 1.35 && Math.hypot(s.x - l.x, s.z - l.z) < best) { from = l; best = Math.hypot(s.x - l.x, s.z - l.z); }
    }
    let pts = null;
    try { pts = route(from, s, { obstacles }); } catch (e) { console.warn('bus road', e); }
    if (!pts) { s.noRoad = true; continue; }
    // a road carrying on from a stop where another ends (a stop on the way) starts at that road's height: one
    // continuous bench through the stop (no step in the carved ground where the two roads meet)
    const prev = busRoads.roads.find((r) => r.to === from);
    const sp = smoothPath(pts), m = sp.length; // (no sliver of a last segment: the strip's end cross-section turns)
    if (m > 3 && Math.hypot(sp[m - 1][0] - sp[m - 2][0], sp[m - 1][1] - sp[m - 2][1]) < 2) sp.splice(m - 2, 1);
    busRoads.roads.push(makeRoad(sp, from, s, prev ? { y0: prev.Y[prev.n - 1] } : {}));
    linked.push(s);
  }
  // a stop left without a road goes back where it was (the travel card serves it from there)
  for (const s of busRoads.stops) if (s.noRoad && s.movedFrom) { s.x = s.movedFrom.x; s.z = s.movedFrom.z; delete s.movedFrom; }
  // car parks (big by the village, medium at a gondola base, small by a hut), each with an access road
  try { planLots(obstacles, stops); } catch (e) { console.warn('car parks', e); }
  try { planHospital(obstacles); } catch (e) { console.warn('hospital site', e); }
  try { planLayby(obstacles); } catch (e) { console.warn('lay-by', e); }
  try { planRental(obstacles); } catch (e) { console.warn('car rental site', e); } // (last: moves nothing planned above)
  try { planScenic(obstacles); } catch (e) { console.warn('scenic road', e); } // (after everything: its roads go last)
  try { planScenicLoop(obstacles); } catch (e) { console.warn('scenic loop', e); } // (more scenic roads off the Panorama roundabout)
  try { planChaletVillage(obstacles); } catch (e) { console.warn('chalet village', e); } // (its terraces' cut before the roads' cuts)
  try { planRentalRoad(obstacles); } catch (e) { console.warn('Westgratstrasse', e); } // (across from the car rental, up the Westgrat)
  try { planPrison(obstacles); } catch (e) { console.warn('prison site', e); } // (last of all: moves nothing planned above)
  clearRouteCache();
  try { levelIntoLots(); } catch (e) { console.warn('car park entrances', e); }
  try { levelIntoJunctions(); } catch (e) { console.warn('junction heights', e); }
  shapeRoads(busRoads.roads.filter((r) => !r.scenic)); // (the scenic roads, appended last, carve their own cut: same indices)
  try { shapeScenic(); } catch (e) { console.warn('scenic road cut', e); }
  try { planAlmdorfStop(); } catch (e) { console.warn('Almdorf bus stop', e); } // (the chalet village's stop: the valley road split at its junction for the bus)
  try { planScenicBus(); } catch (e) { console.warn('mountain bus stops', e); } // (the bus up the scenic roads: its stops and legs)
  try { planWestgratBus(); } catch (e) { console.warn('Westgrat bus stop', e); } // (and up the Westgratstrasse)
  busRoads.ready = true;
  busRoads.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return busRoads;
}

// The plough berm along road ri, on one side (+1 / -1), at arc length s: { H (crest height, m), W (width, m) }.
// Height wanders 0.3-0.9 m and width 3-4 m with layered noise (lumps, never a constant extrusion); it tapers away
// over 20 m at each road end (the bus bays and junctions are at the stops), and stays low in the village.
const fr = (i) => { const v = Math.sin(i * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
const _berm = { H: 0, W: 3.4 };
export function berm(ri, side, s, L, x, z) {
  const p = ri * 11 + (side > 0 ? 5 : 0), T = 6.2832;
  const n = 0.6 + 0.2 * Math.sin(s * 0.093 + fr(p) * T) + 0.12 * Math.sin(s * 0.231 + fr(p + 1) * T) + 0.08 * Math.sin(s * 0.517 + fr(p + 2) * T);
  let taper = smoothstep(14, 34, s) * smoothstep(14, 34, L - s);
  for (const j of busRoads.junctions) { const dj = Math.hypot(x - j.x, z - j.z); if (dj < 30) taper *= smoothstep(13, 30, dj); }
  // a lay-by (the car parked at the roadside): the plough left that stretch of shoulder clear
  for (const lb of busRoads.laybys || []) if (lb.ri === ri && side === lb.side) taper *= smoothstep(9, 17, Math.abs(s - lb.s));
  const village = 0.45 + 0.55 * smoothstep(140, 260, Math.hypot(x, z));
  _berm.H = clamp(n, 0.3, 0.92) * taper * village;
  _berm.W = 3.4 + 0.5 * Math.sin(s * 0.061 + fr(p + 3) * T) + 0.3 * Math.sin(s * 0.19 + fr(p + 4) * T);
  return _berm;
}

// One world cut for the whole network (a grid of road segments inside it): the road is flat across, at its own
// height; beyond the shoulder the ground eases back to the natural slope (wider where the cut or fill is deeper).
// Trees and rocks keep off through a corridor ('lift' kind: cleared, not groomed).
function shapeRoads(roads) {
  if (!roads.length) return;
  const G = 32, grid = new Map();
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  const segs = [];
  for (const r of roads) {
    const ri = roads.indexOf(r);
    for (let i = 0; i < r.n - 1; i++) {
      const sg = { ax: r.X[i], az: r.Z[i], bx: r.X[i + 1], bz: r.Z[i + 1], ay: r.Y[i], by: r.Y[i + 1], ri, sa: r.S[i], sb: r.S[i + 1] };
      segs.push(sg);
      const R = 66;
      const x0 = Math.min(sg.ax, sg.bx) - R, x1 = Math.max(sg.ax, sg.bx) + R, z0 = Math.min(sg.az, sg.bz) - R, z1 = Math.max(sg.az, sg.bz) + R;
      minx = Math.min(minx, x0); minz = Math.min(minz, z0); maxx = Math.max(maxx, x1); maxz = Math.max(maxz, z1);
      for (let cx = Math.floor(x0 / G); cx <= Math.floor(x1 / G); cx++) for (let cz = Math.floor(z0 / G); cz <= Math.floor(z1 / G); cz++) {
        const key = cx * 65536 + cz;
        let arr = grid.get(key);
        if (!arr) grid.set(key, (arr = []));
        arr.push(sg);
      }
    }
    // keep trees, boulders and scree off the road and its banks
    const line = [];
    for (let i = 0; i < r.n; i += 3) line.push([r.X[i], r.Z[i]]);
    line.push([r.X[r.n - 1], r.Z[r.n - 1]]);
    world.addCorridor(line, BENCH + 3, 'lift', { busRoad: true });
  }
  const near = { d: 0, y: 0, s: 0, ri: 0, side: 1 }, OTHER = new Map(), OTHY = new Map();
  const nearest = (x, z) => {
    const arr = grid.get(Math.floor(x / G) * 65536 + Math.floor(z / G));
    near.d = Infinity;
    if (!arr) return near;
    let best = null, bt = 0;
    for (const s of arr) {
      const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
      const px = s.ax + ex * t - x, pz = s.az + ez * t - z, d = px * px + pz * pz;
      if (d < near.d) { near.d = d; best = s; bt = t; }
    }
    near.d = Math.sqrt(near.d);
    near.y = best.ay + (best.by - best.ay) * bt;
    // (another road nearly as near, e.g. an access road running in beside the road it joins at another height:
    // the heights blended by nearness, so the ground does not step where the nearer one swaps)
    let wsum = 1, ysum = near.y;
    for (const s of arr) {
      if (s.ri === best.ri) continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
      const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z) - near.d;
      if (d > 6) continue;
      const w = Math.exp(-d / 1.2);
      if (w > (OTHER.get(s.ri) ?? -1)) OTHER.set(s.ri, w), OTHY.set(s.ri, s.ay + (s.by - s.ay) * t);
    }
    for (const [ri, w] of OTHER) { wsum += w; ysum += w * OTHY.get(ri); }
    OTHER.clear(); OTHY.clear();
    near.y = ysum / wsum;
    near.s = best.sa + (best.sb - best.sa) * bt;
    near.ri = best.ri;
    near.side = (best.bx - best.ax) * (z - best.az) - (best.bz - best.az) * (x - best.ax) >= 0 ? 1 : -1;
    return near;
  };
  // no trees or rocks on a car park (or the hospital's site) and 6 m round it: a cleared strip along its long axis
  // whose round ends reach past its short sides (the vegetation keeps off cleared strips, like the roads)
  for (const L of busRoads.lots) {
    world.addCorridor([[L.x - L.ux * L.hw, L.z - L.uz * L.hw], [L.x + L.ux * L.hw, L.z + L.uz * L.hw]], L.hd + 6, 'lift', { lot: true });
  }
  for (const L of busRoads.lots) {
    const R = Math.hypot(L.hw, L.hd) + 50;
    minx = Math.min(minx, L.x - R); minz = Math.min(minz, L.z - R); maxx = Math.max(maxx, L.x + R); maxz = Math.max(maxz, L.z + R);
  }
  // a car park: flat at its own height, eased back to the slope around it, the snow ploughed into a berm round its
  // edges (open at the entrance)
  // (every car park near the point in turn, each easing into the ground the ones before left: no step where two
  // car parks' surrounds meet, as there was beside the village car park; on a car park itself its own level)
  const LS = { y: 0, out: 0 };
  const lotShape = (x, z, h0, spacing) => {
    let h = h0, any = false, outMin = Infinity;
    for (const L of busRoads.lots) {
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx) > L.hw + L.hd + 60 || Math.abs(dz) > L.hw + L.hd + 60) continue;
      const u = dx * L.ux + dz * L.uz, v = dx * L.vx + dz * L.vz;
      const out = Math.hypot(Math.max(0, Math.abs(u) - L.hw), Math.max(0, Math.abs(v) - L.hd));
      const blend = Math.min(45, 6 + Math.abs(h - L.y) * 3.2);
      if (out > blend + 7.5 && !(L.piles && out < 13)) continue;
      let y = out <= 0 ? L.y : L.y + (h - L.y) * smoothstep(2.9, 2.9 + blend, out); // (flat 2.9 m past the edge: see the berm)
      // (the berm 2.9 m off the edge: the drawn terrain's 2 m triangles under the car park's edge stay flat)
      if (spacing <= 4 && !L.building && out > 2.9 && out < 6.9 && Math.hypot(x - L.ex, z - L.ez) > 10) {
        const t = (out - 2.9) / 4, open = smoothstep(10, 15, Math.hypot(x - L.ex, z - L.ez)); // (tapered at the entrance, no step)
        y += 0.65 * open * (t < 0.4 ? smoothstep(0, 0.4, t) : 1 - smoothstep(0.4, 1, t));
      }
      // ploughed snow piles: soft lumpy domes (the radius wanders with the angle, a few lumps on top)
      if (L.piles && spacing <= 8) {
        let pile = 0;
        for (const P of L.piles) {
          const px = x - P.x, pz = z - P.z, r = Math.hypot(px, pz);
          if (r > P.R * 1.35) continue;
          const a = Math.atan2(pz, px), R = P.R * (1 + 0.16 * Math.sin(3 * a + P.p1) + 0.09 * Math.sin(5 * a + P.p2));
          if (r >= R) continue;
          const q = 1 - (r / R) * (r / R);
          pile = Math.max(pile, P.H * q * Math.sqrt(q) * (1 + 0.08 * Math.sin(px * 1.7 + P.p1) * Math.sin(pz * 1.9 + P.p2)));
        }
        y += pile * smoothstep(2.9, 4.5, out); // (on the ground under it: before, a pile off the car park's edge stood on the car park's level, a step; never on the car park or its edge)
      }
      if (out <= 0) { LS.y = y; LS.out = out; return LS; }
      h = y; any = true; outMin = Math.min(outMin, out);
    }
    if (!any) return null;
    LS.y = h; LS.out = outMin;
    return LS;
  };
  world.addCut({
    bounds: { minx, minz, maxx, maxz },
    busRoads: true,
    apply(x, z, h, spacing = 0) {
      let lot = null;
      if (busRoads.lots.length) { try { lot = lotShape(x, z, h, spacing); } catch { lot = null; } }
      const nr = nearest(x, z);
      // (on the car park its own level; round it the road eases into the car park's shaped ground, not the slope's:
      // before, the two switched at the road's shoulder, a step where an access road met its car park)
      if (lot && lot.out <= 0) return lot.y;
      if (lot) h = lot.y;
      if (nr.d > 66) return h;
      const diff = Math.abs(h - nr.y);
      const blend = Math.min(60, 6 + diff * 3.4); // (gentle snow embankments, no dark walls)
      if (nr.d > BENCH + blend) return h;
      const k = smoothstep(BENCH, BENCH + blend, nr.d);
      let out = nr.y + (h - nr.y) * k;
      // the plough berm: part of the terrain itself (the same snow, light and sparkle by day and night), a soft
      // rounded ridge whose height and width wander along the road, gone at the bus bays and road ends; the
      // coarse far-off terrain leaves it out (it would only alias into bumps there)
      if (spacing <= 4 && nr.d > BERM_IN && nr.d < BERM_IN + 4.8) {
        const r = roads[nr.ri];
        const b = berm(nr.ri, nr.side, nr.s, r.length, x, z);
        const t = (nr.d - BERM_IN) / b.W;
        if (b.H > 0.01 && t > 0 && t < 1) out += b.H * (t < 0.38 ? smoothstep(0, 0.38, t) : 1 - smoothstep(0.38, 1, t));
      }
      return out;
    },
  });
}

// ------------------------------------------------------------------ car parks
// Off until checked in the game. Dev override: ?flags=lots (or localStorage 'sl.flags').
const devFlag = (name) => { try { return `,${new URLSearchParams(location.search).get('flags') || localStorage.getItem('sl.flags') || ''},`.includes(`,${name},`); } catch { return false; } };
export const LOTS_ON = true || devFlag('lots');
const LOTS = [
  { size: 'big', name: 'Legacy Village car park', hw: 32, hd: 19, near: () => [{ x: 190, z: 60 }, { x: -170, z: 120 }, { x: 120, z: -180 }], r0: 40, r1: 420 },
  { size: 'medium', name: 'Sonnenkopf car park', hw: 22, hd: 14, near: (stops) => stops.filter((s) => !s.noRoad && s !== stops[0]).map((s) => ({ x: s.x, z: s.z })), r0: 30, r1: 260 },
  { size: 'small', name: 'Trailhead car park', hw: 13, hd: 9, near: (stops) => [...layout.huts.map((h) => ({ x: h.x, z: h.z })), ...stops.filter((s) => !s.noRoad && s !== stops[0]).reverse().map((s) => ({ x: s.x, z: s.z }))], r0: 30, r1: 240 },
];
// nearest point of the network to (x, z): { r, i, x, z, d }
function nearestRoadPoint(x, z) {
  let best = null;
  for (const r of busRoads.roads) for (let i = 0; i < r.n; i += 2) { const d = Math.hypot(r.X[i] - x, r.Z[i] - z); if (!best || d < best.d) best = { r, i, x: r.X[i], z: r.Z[i], y: r.Y[i], d }; }
  return best;
}
function lotFits(cx, cz, yaw, hw, hd, O) {
  const ux = Math.sin(yaw), uz = Math.cos(yaw), vx = uz, vz = -ux, q = {};
  let lo = Infinity, hi = -Infinity;
  for (let a = -hw - 6; a <= hw + 6; a += 6) for (let b = -hd - 6; b <= hd + 6; b += 6) {
    const x = cx + ux * a + vx * b, z = cz + uz * a + vz * b;
    O.query(x, z, q);
    if (q.ski < 10 || q.net < 8 || q.block < 8 || q.rail < 8 || q.lift < 4) return null;
    const c = world.corridorAt(x, z);
    if (c.kind && c.d < (c.kind === 'lift' ? 3 : 10)) return null;
    for (const r of busRoads.roads) for (let i = 0; i < r.n; i += 3) if (Math.abs(r.X[i] - x) < 13 && Math.abs(r.Z[i] - z) < 13 && Math.hypot(r.X[i] - x, r.Z[i] - z) < 13) return null;
    for (const L of busRoads.lots) if (Math.hypot(L.x - x, L.z - z) < Math.hypot(L.hw, L.hd) + 15) return null;
    if (Math.abs(a) <= hw && Math.abs(b) <= hd) { const h = world.height(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  }
  if (hi - lo > 4) return null;
  return { y: (lo + hi) / 2 };
}
function planLots(O, stops) {
  if (!LOTS_ON || !busRoads.roads.length) return;
  for (const def of LOTS) {
    let found = null;
    const targets = def.near(stops).filter((t) => { const n = nearestRoadPoint(t.x, t.z); return n && n.d < 900; });
    for (const t of targets) {
      for (let r = def.r0; r <= def.r1 && !found; r += 15) {
        const n = Math.max(8, Math.round(r / 12));
        for (let k = 0; k < n && !found; k++) {
          const a = (k / n) * Math.PI * 2, cx = t.x + Math.cos(a) * r, cz = t.z + Math.sin(a) * r;
          // long side along the contour (least cut and fill), else a few other headings
          const e = 4, gx = world.height(cx + e, cz) - world.height(cx - e, cz), gz = world.height(cx, cz + e) - world.height(cx, cz - e);
          const contour = Math.atan2(-gz, gx);
          for (const yaw of [contour, contour + Math.PI / 4, contour - Math.PI / 4, contour + Math.PI / 2]) {
            const fit = lotFits(cx, cz, yaw, def.hw, def.hd, O);
            if (!fit) continue;
            // the entrance: the middle of the side nearest the network
            const ux = Math.sin(yaw), uz = Math.cos(yaw), vx = uz, vz = -ux, net = nearestRoadPoint(cx, cz);
            const sides = [[ux, uz, def.hw], [-ux, -uz, def.hw], [vx, vz, def.hd], [-vx, -vz, def.hd]];
            let ent = null;
            for (const [sx, sz, h] of sides) { const ex = cx + sx * (h + 2), ez = cz + sz * (h + 2), d = Math.hypot(net.x - ex, net.z - ez); if (!ent || d < ent.d) ent = { x: ex, z: ez, d, sx, sz }; }
            const pts = route({ x: ent.x + ent.sx * 6, z: ent.z + ent.sz * 6 }, { x: net.x, z: net.z }, { obstacles: O, margin: 300 });
            if (!pts) continue;
            const lot = { ...def, x: cx, z: cz, yaw, y: fit.y, ux, uz, vx, vz, ex: ent.x, ez: ent.z, dirx: ent.sx, dirz: ent.sz };
            // ploughed snow piles at the corners (just outside the bays and lanes), not by the entrance
            lot.piles = [];
            const big = def.size === 'big' ? 1 : def.size === 'medium' ? 0.8 : 0.6;
            let k = 0;
            for (const su of [-1, 1]) for (const sv of [-1, 1]) {
              const px = cx + ux * su * (def.hw + 3.6) + vx * sv * (def.hd + 3.6), pz = cz + uz * su * (def.hw + 3.6) + vz * sv * (def.hd + 3.6);
              if (Math.hypot(px - ent.x, pz - ent.z) < 16) continue;
              const fr2 = (q) => { const v = Math.sin((cx + k * 17.3 + q * 31.7) * 12.9898 + cz * 78.233) * 43758.5453; return v - Math.floor(v); };
              lot.piles.push({ x: px, z: pz, R: (3.2 + fr2(1) * 1.6) * (0.75 + 0.25 * big), H: (1.5 + fr2(2) * 1.5) * (0.7 + 0.3 * big), p1: fr2(3) * 6.28, p2: fr2(4) * 6.28 });
              k++;
            }
            const path = smoothPath([[ent.x - ent.sx * 7, ent.z - ent.sz * 7], [ent.x, ent.z], ...pts]); // (from inside the lot: no gap)
            const road = makeRoad(path, { name: def.name, x: ent.x, z: ent.z, lot: true }, { name: 'junction', x: net.x, z: net.z }, { y0: fit.y, y1: net.y });
            let worst = 0;
            for (let i = 1; i < road.n; i++) worst = Math.max(worst, Math.abs(road.Y[i] - road.Y[i - 1]) / Math.max(0.01, road.S[i] - road.S[i - 1]));
            if (worst > MAX_GRADE + 0.01 || road.length < 20) continue; // (too steep a ramp between them: another spot)
            road.access = true;
            busRoads.roads.push(road);
            busRoads.lots.push(lot);
            busRoads.junctions.push({ x: net.x, z: net.z });
            found = lot;
            break;
          }
        }
      }
      if (found) break;
    }
  }
}

// A road into a car park is level with it across the car park and 1.5 m past its edge, and only then starts down
// (or up) at the road's own grade: before, the centre line began 5 m inside the car park and was already ramping
// there, while the car park is flat, so the ground stepped by up to ~0.7 m at the entrance (the road's cut below
// the car park's level at its edge). Kept as it was when the road can't make it up at its own steepest grade.
function levelIntoLots() {
  const lots = busRoads.lots.filter((L) => !L.building && L.ux !== undefined);
  const outOf = (L, x, z) => { const dx = x - L.x, dz = z - L.z; return Math.max(Math.abs(dx * L.ux + dz * L.uz) - L.hw, Math.abs(dx * L.vx + dz * L.vz) - L.hd); };
  for (const r of busRoads.roads) {
    if (r.ringRoad || r.n < 4) continue;
    for (const e of [0, 1]) {
      const at = (k) => (e ? r.n - 1 - k : k); // (k: samples from this end)
      const L = lots.find((q) => outOf(q, r.X[at(0)], r.Z[at(0)]) < 2.5);
      if (!L) continue;
      let k = 0;
      while (k < r.n - 1 && outOf(L, r.X[at(k)], r.Z[at(k)]) <= 0) k++;
      const flat = Math.abs(r.S[at(k)] - r.S[at(0)]) + 1.5;
      let g0 = 0.02;
      for (let i = 1; i < r.n; i++) g0 = Math.max(g0, Math.abs(r.Y[i] - r.Y[i - 1]) / Math.max(0.01, r.S[i] - r.S[i - 1]));
      // (a steep short drive, e.g. 6 m down in 50 m: a little steeper ramp, else the car park itself a little lower /
      // higher, toward the road: up to 1.5 m more cut or fill)
      const sg = Math.sign(r.Y[at(r.n - 1)] - L.y) || 1;
      const level = (y0, g) => {
        const Y = r.Y.slice();
        for (let j = 0; j < r.n; j++) {
          const i = at(j), d = Math.abs(r.S[i] - r.S[at(0)]);
          if (d <= flat) { Y[i] = y0; continue; }
          const p = at(j - 1), lim = g * Math.abs(r.S[i] - r.S[p]), y = clamp(Y[i], Y[p] - lim, Y[p] + lim);
          if (Math.abs(y - Y[i]) < 0.001) return Y;
          Y[i] = y;
        }
        return null;
      };
      let done = false;
      for (let dy = 0; dy <= 1.5 && !done; dy += 0.25) for (const g of [g0, g0 * 1.15]) {
        const Y = level(L.y + sg * dy, g);
        if (!Y) continue;
        r.Y = Y; L.y += sg * dy; done = true;
        break;
      }
    }
  }
}

// A road ending on another road's lane (a T junction, a roundabout's arm) meets it at that road's own surface: across
// the other road's width (+ 1.5 m) its height follows that road's, then it eases to its own profile at no more than its own
// steepest grade. Before, e.g. the Chaletweg met the valley road 0.46 m above it (a ledge across the junction).
function levelIntoJunctions() {
  const roads = busRoads.roads;
  const onRoad = (B, x, z, pad = 0) => { // B's height under (x, z) when (x, z) is on B's lane (+ pad), else null
    let best = null;
    for (let i = 0; i < B.n - 1; i++) {
      const ax = B.X[i], az = B.Z[i];
      if (Math.abs(ax - x) > 12 || Math.abs(az - z) > 12) continue;
      const dx = B.X[i + 1] - ax, dz = B.Z[i + 1] - az, l2 = dx * dx + dz * dz || 1, t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < ROAD_HALF + pad && (!best || d < best.d)) best = { d, y: B.Y[i] + (B.Y[i + 1] - B.Y[i]) * t };
    }
    return best;
  };
  for (const r of roads) {
    if (r.ringRoad || r.n < 4) continue;
    for (const e of [0, 1]) {
      const at = (k) => (e ? r.n - 1 - k : k), x = r.X[at(0)], z = r.Z[at(0)];
      let host = null;
      for (const B of roads) {
        if (B === r || (!B.ringRoad && [0, B.n - 1].some((k) => Math.hypot(B.X[k] - x, B.Z[k] - z) < 1.5))) continue;
        const h = onRoad(B, x, z);
        if (h && h.d < ROAD_HALF - 0.05 && (!host || h.d < host.h.d)) host = { B, h };
      }
      if (!host) continue;
      let g0 = 0.02;
      for (let i = 1; i < r.n; i++) g0 = Math.max(g0, Math.abs(r.Y[i] - r.Y[i - 1]) / Math.max(0.01, r.S[i] - r.S[i - 1]));
      // (level across the other road's lane and 1.5 m past its edge: its edge never tilts up or down the side road)
      for (const g of [g0, g0 * 1.15, g0 * 1.3]) {
        const Y = r.Y.slice();
        let ok = false, inside = true;
        for (let j = 0; j < r.n; j++) {
          const i = at(j), h = inside ? onRoad(host.B, r.X[i], r.Z[i], 1.5) : null;
          if (h) { Y[i] = h.y; continue; }
          inside = false;
          const p = at(j - 1), lim = g * Math.abs(r.S[i] - r.S[p]), y = clamp(Y[i], Y[p] - lim, Y[p] + lim);
          if (Math.abs(y - Y[i]) < 0.001) { ok = true; break; }
          Y[i] = y;
        }
        if (ok) { r.Y = Y; break; }
      }
    }
  }
}

// A lay-by for the car parked at the roadside (game/parking.js): a straight, level stretch of a bus road near the
// village, its right-hand shoulder clear (no berm there), away from junctions and stops.
function planLayby(O) {
  const q = {};
  busRoads.laybys = [];
  for (let ri = 0; ri < busRoads.roads.length && busRoads.laybys.length < 2; ri++) {
    const r = busRoads.roads[ri];
    if (r.access) continue;
    let best = null;
    for (let s = 70; s < Math.min(r.length - 70, 900); s += 6) {
      const a = roadAt(r, s - 14), b = roadAt(r, s + 14), m = roadAt(r, s);
      const bend = Math.abs(Math.atan2(Math.sin(Math.atan2(b.dx, b.dz) - Math.atan2(a.dx, a.dz)), Math.cos(Math.atan2(b.dx, b.dz) - Math.atan2(a.dx, a.dz))));
      if (bend > 0.06 || Math.abs(m.grade) > 0.06) continue;
      const x = m.x - m.dz * 4.6, z = m.z + m.dx * 4.6; // (right of the way the road runs)
      if (busRoads.junctions.some((j) => Math.hypot(j.x - x, j.z - z) < 45)) continue;
      if (busRoads.lots.some((l) => Math.hypot(l.x - x, l.z - z) < Math.hypot(l.hw, l.hd) + 20)) continue;
      O.query(x, z, q);
      if (q.ski < 8 || q.net < 6 || q.block < 6 || q.rail < 6 || q.lift < 2) continue;
      const score = Math.hypot(x - 120, z - 90); // (near the village and the medical centre: where you see it)
      if (!best || score < best.score) best = { ri, s, side: 1, x, z, yaw: Math.atan2(m.dx, m.dz), score };
    }
    if (best) busRoads.laybys.push(best); // (one per road: the first two roads)
  }
  busRoads.layby = busRoads.laybys[0] || null;
}

// The small hospital (game/hospital.js): at the village edge, on clear level ground off the ski areas, a short walk
// from a road (13-45 m from its centre line) so the ambulance can drive there. Flattened like a car park (no berm).
function planHospital(O) {
  if (!busRoads.roads.length) return;
  const hw = 13, hd = 10;
  const targets = [{ x: 160, z: 130 }, { x: 260, z: -20 }, { x: -160, z: 150 }, { x: 60, z: 260 }];
  for (const t of targets) {
    for (let r = 0; r <= 260; r += 15) {
      const n = r ? Math.max(8, Math.round(r / 12)) : 1;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, cx = t.x + Math.cos(a) * r, cz = t.z + Math.sin(a) * r;
        const net = nearestRoadPoint(cx, cz);
        if (!net || net.d > 45 || net.d < 22) continue;
        const facing = Math.atan2(net.x - cx, net.z - cz); // the entrance toward the road
        const yaw = facing + Math.PI / 2;
        const fit = lotFits(cx, cz, yaw, hw, hd, O);
        if (!fit) continue;
        const ux = Math.sin(yaw), uz = Math.cos(yaw), vx = uz, vz = -ux;
        const fx = Math.sin(facing), fz = Math.cos(facing);
        const ex = cx + fx * (hd + 3), ez = cz + fz * (hd + 3);
        const H = { name: 'Medical centre', building: true, x: cx, z: cz, yaw, y: fit.y, hw, hd, ux, uz, vx, vz, ex, ez, dirx: fx, dirz: fz, facing };
        busRoads.lots.push(H);
        busRoads.hospital = H;
        return;
      }
    }
  }
}

// The PRISON (game/prison.js, the village police station): like the hospital, a flattened building lot in Legacy
// Village a short walk off the road (its door toward it), clear of the ski areas, lifts, buildings and the other lots.
function planPrison(O) {
  if (!busRoads.roads.length) return;
  const hw = 13, hd = 10;
  for (const t of [{ x: 40, z: 150 }, { x: 150, z: 240 }, { x: -60, z: 170 }, { x: 200, z: -60 }]) {
    for (let r = 0; r <= 200; r += 10) {
      const n = r ? Math.max(8, Math.round(r / 10)) : 1;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, cx = t.x + Math.cos(a) * r, cz = t.z + Math.sin(a) * r;
        const net = nearestRoadPoint(cx, cz);
        if (!net || net.d > 36 || net.d < 22) continue;
        const facing = Math.atan2(net.x - cx, net.z - cz), yaw = facing + Math.PI / 2; // (the door toward the road)
        const fit = lotFits(cx, cz, yaw, hw, hd, O);
        if (!fit) continue;
        const ux = Math.sin(yaw), uz = Math.cos(yaw), fx = Math.sin(facing), fz = Math.cos(facing);
        busRoads.prison = { name: 'Police / Prison', building: true, x: cx, z: cz, yaw, y: fit.y, hw, hd, ux, uz, vx: uz, vz: -ux,
          ex: cx + fx * (hd + 3), ez: cz + fz * (hd + 3), dirx: fx, dirz: fz, facing };
        busRoads.lots.push(busRoads.prison);
        return;
      }
    }
  }
}

// The CAR RENTAL (game/carrental.js): a building lot right on a bus road in Legacy Village, its yard / garage front
// on the road's edge (rented cars wait there, the tow truck drives straight out onto the road and parks there): a
// straight, gentle stretch near the village centre, the pad at the road's own height (flush with it), clear of the ski
// areas, nets, lifts, stations, buildings, the railway, other roads, car parks, junctions, stops and the lay-bys.
// busRoads.rental = { building lot (like the hospital's) + ri, s (the road and arc length in front), side }.
export const RENTAL_LOT = { hw: 15, hd: 13 }; // half length along the road, half depth (m)
function planRental(O) {
  const q = {}, { hw, hd } = RENTAL_LOT;
  let best = null;
  busRoads.roads.forEach((r, ri) => {
    if (r.access) return;
    for (let s = 40; s < r.length - 40; s += 4) {
      const m = roadAt(r, s), a = roadAt(r, s - 18), b = roadAt(r, s + 18);
      const score0 = Math.hypot(m.x + 10, m.z - 20); // (as near the village square as it fits)
      if (score0 > 330 || (best && score0 > best.score)) continue;
      const bend = Math.abs(Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz));
      if (bend > 0.12 || Math.abs(m.grade) > 0.05) continue;
      for (const side of [1, -1]) {
        const nx = -m.dz * side, nz = m.dx * side, off = ROAD_HALF + 0.6 + hd; // (side 1: right of the way it runs)
        const cx = m.x + nx * off, cz = m.z + nz * off;
        let ok = true, lo = Infinity, hi = -Infinity;
        for (let u = -hw - 4; u <= hw + 4 && ok; u += 4) for (let v = -hd - 4; v <= hd - 1 && ok; v += 4) { // (v toward the road)
          const x = cx + m.dx * u - nx * v, z = cz + m.dz * u - nz * v;
          O.query(x, z, q);
          if (q.ski < 8 || q.net < 6 || q.block < 4 || q.rail < 8 || q.lift < 4) ok = false;
          const c = world.corridorAt(x, z);
          if (c.kind && c.kind !== 'lift' && c.d < 8) ok = false;
          if (Math.abs(u) <= hw && Math.abs(v) <= hd) { const h = world.height(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
        }
        if (!ok || hi - lo > 4 || Math.abs((hi + lo) / 2 - m.y) > 2.2) continue;
        // no other road within reach (only the one in front), no car park, junction, stop or lay-by near it
        if (busRoads.roads.some((o, oi) => { for (let i = 0; i < o.n; i += 2) { const d = Math.hypot(o.X[i] - cx, o.Z[i] - cz); if (d < hw + hd + 8 && (oi !== ri || Math.abs(o.S[i] - s) > hw + 30)) return true; } return false; })) continue;
        if (busRoads.lots.some((L) => Math.hypot(L.x - cx, L.z - cz) < Math.hypot(L.hw, L.hd) + Math.hypot(hw, hd) + 12)) continue;
        if ([...busRoads.junctions, ...busRoads.stops, ...(busRoads.laybys || [])].some((j) => Math.hypot(j.x - cx, j.z - cz) < 50)) continue;
        if (Math.hypot(cx + 190, cz + 160) < 90) continue; // (the Legacy Express's village station)
        const yaw = Math.atan2(m.dx, m.dz), facing = Math.atan2(-nx, -nz); // (u along the road; the front to the road)
        best = { name: 'Autohaus', building: true, rental: true, x: cx, z: cz, yaw, y: m.y, hw, hd, ux: m.dx, uz: m.dz, vx: m.dz, vz: -m.dx,
          ex: m.x + nx * (ROAD_HALF + 0.6), ez: m.z + nz * (ROAD_HALF + 0.6), dirx: -nx, dirz: -nz, facing, ri, s, side, score: score0 };
      }
    }
  });
  if (!best) return;
  busRoads.lots.push(best);
  busRoads.rental = best;
}

/** Dev: the network as plain data (lengths, worst grade). */
export function describeRoads() {
  return busRoads.roads.map((r) => {
    let worst = 0;
    for (let i = 1; i < r.n; i++) worst = Math.max(worst, Math.abs(r.Y[i] - r.Y[i - 1]) / Math.max(0.01, r.S[i] - r.S[i - 1]));
    return { from: r.from.name, to: r.to.name, km: +(r.length / 1000).toFixed(2), drop: Math.round(r.Y[r.n - 1] - r.Y[0]), worstGrade: +worst.toFixed(3) };
  });
}

// the nearest spot to a stop (spiralling out to ~200 m) with room for the bus bay: clear of every obstacle by its
// margin plus 10 m, on gentle ground
function clearSpot(s, O) {
  const q = {};
  const ok = (x, z) => {
    O.query(x, z, q);
    if (q.ski < CLEAR.ski + 10 || q.net < CLEAR.net + 10 || q.block < CLEAR.block + 6 || q.rail < CLEAR.rail + 6 || q.lift < 8) return false;
    const c = world.corridorAt(x, z);
    if (c.kind && c.kind !== 'lift' && c.d < CLEAR.ski + 10) return false;
    if (c.kind === 'lift' && c.d < 4) return false;
    const e = 6, g = Math.hypot(world.height(x + e, z) - world.height(x - e, z), world.height(x, z + e) - world.height(x, z - e)) / (2 * e);
    return g < 0.16;
  };
  if (ok(s.x, s.z)) return { x: s.x, z: s.z };
  for (let r = 10; r <= 200; r += 10) {
    const n = Math.max(8, Math.round(r / 5));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      if (ok(x, z)) return { x, z };
    }
  }
  return null;
}

/**
 * Check every road against everything it must keep clear of: samples the bus's swept path every 2 m (the road
 * and the overhang in bends) against the ski areas, nets, stations / buildings, the railway, lift lines, and (in
 * the game) the shared colliders and the trees and rocks. Returns { total, counts: {kind: n}, spots: [...] }.
 * @param {{colliders?: Array, vegetation?: object}} [o]
 */
export function auditRoads({ colliders = null, vegetation = null } = {}) {
  const O = busRoads.obstacles, counts = {}, spots = [], q = {};
  const hit = (kind, x, z, what) => { counts[kind] = (counts[kind] || 0) + 1; if (spots.length < 40) spots.push({ kind, x: Math.round(x), z: Math.round(z), what }); };
  const cells = new Map();
  const vegCell = (cx, cz) => {
    const key = cx + ',' + cz;
    if (!cells.has(key)) { try { cells.set(key, vegetation.genCell(cx, cz)); } catch { cells.set(key, { trees: [], rocks: [] }); } }
    return cells.get(key);
  };
  const SWEPT = [-4.4, -2.8, -1.2, 0, 1.2, 2.8, 4.4]; // the bus in either lane (+ overhang in bends)
  for (const r of busRoads.roads) {
    let lastLift = -1e9;
    for (let s = 0; s <= r.length; s += 2) {
      const p = roadAt(r, s);
      for (const o of SWEPT) {
        const x = p.x - p.dz * o, z = p.z + p.dx * o;
        if (O) {
          O.query(x, z, q);
          if (q.ski < 0) hit('piste', x, z, q.skiRef);
          if (q.net < 1) hit('net', x, z, q.netRef);
          if (q.block < 0) hit('station/building', x, z, q.blockRef);
          if (q.rail < 0) hit('railway', x, z, q.railRef);
          if (q.lift < 0 && o === 0 && s - lastLift > 40) { lastLift = s; hit('lift line crossing (under the cable)', x, z, q.liftRef); }
        }
        if (colliders) {
          for (const c of colliders) {
            if (c.bus || c.rail) continue; // (the bus itself; the road's own guardrails beside the lane)
            const size = c.r ?? Math.max(c.hw, c.hd);
            if (Math.abs(c.x - x) > size + 1.5 || Math.abs(c.z - z) > size + 1.5) continue;
            let inside;
            if (c.r !== undefined) inside = Math.hypot(c.x - x, c.z - z) < c.r + 1.2;
            else { const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs; inside = Math.abs(lx) < c.hw + 1.2 && Math.abs(lz) < c.hd + 1.2; }
            if (inside) hit(c.net ? 'net (collider)' : 'collider', x, z, c.net ? 'net' : `r ${size.toFixed(1)}`);
          }
        }
        if (vegetation?.genCell) {
          const cell = vegCell(Math.floor(x / 64), Math.floor(z / 64));
          for (const t of cell.trees) if (Math.hypot(t.x - x, t.z - z) < t.r + Math.min(3.2, t.s * 0.21) * (o === 0 ? 1 : 0.6)) hit('tree', x, z, `${t.s.toFixed(0)} m tree`);
          for (const k of cell.rocks) if ((k.s ?? 1) > 0.8 && Math.hypot(k.x - x, k.z - z) < (k.r ?? 1) + 0.6) hit('rock', x, z, 'rock');
        }
      }
    }
  }
  // the car parks (and the hospital site) with 6 m round them: no trees, no rocks
  if (vegetation?.genCell) {
    for (const L of busRoads.lots) {
      for (let u = -L.hw - 6; u <= L.hw + 6; u += 2) for (let v = -L.hd - 6; v <= L.hd + 6; v += 2) {
        const x = L.x + L.ux * u + L.vx * v, z = L.z + L.uz * u + L.vz * v;
        const cell = vegCell(Math.floor(x / 64), Math.floor(z / 64));
        for (const t of cell.trees) if (Math.abs(t.x - x) < 1 && Math.abs(t.z - z) < 1) hit('tree on a car park', x, z, L.name);
        for (const k of cell.rocks) if (Math.abs(k.x - x) < 1 && Math.abs(k.z - z) < 1) hit('rock on a car park', x, z, L.name);
      }
    }
  }
  const total = Object.entries(counts).filter(([k]) => !k.startsWith('lift line')).reduce((a, [, v]) => a + v, 0);
  return { total, counts, spots, roads: busRoads.roads.length, stops: busRoads.stops.map((s) => ({ name: s.name, x: Math.round(s.x), z: Math.round(s.z), moved: s.movedFrom ? Math.round(Math.hypot(s.x - s.movedFrom.x, s.z - s.movedFrom.z)) : 0, road: !s.noRoad })) };
}
