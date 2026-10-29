// Resort + procedural world layout: lifts (gondolas with mid-stations), pistes, races, mountain huts, the
// terrain park, ski-bus stops and where the safety nets go. Everything is deterministic from the seed, so
// the infinite world always regenerates identically.
import { world, MAIN_SUMMIT, MASSIFS, valleyCenter } from './world.js';
import { mulberry32, hash2, clamp } from '../core/noise.js';
import { buildTransport } from './transport.js';
import { buildSectors } from './sectors.js';

export const DIFFICULTY = [
  { key: 'easy', label: 'Easy', color: '#2fbf5b', maxSlope: 0.30, length: 520, gates: 34, reward: 600, botSkill: 0.78, entry: 0 },
  { key: 'medium', label: 'Medium', color: '#2f7bff', maxSlope: 0.45, length: 800, gates: 30, reward: 1250, botSkill: 0.9, entry: 50 },
  { key: 'hard', label: 'Hard', color: '#e23b3b', maxSlope: 0.62, length: 1050, gates: 30, reward: 3200, botSkill: 0.95, entry: 150 },
  { key: 'expert', label: 'Expert', color: '#141414', maxSlope: 0.85, length: 1350, gates: 32, reward: 4700, botSkill: 0.99, entry: 300 },
];
// groomed half-width of a piste by difficulty (also used by the snow cannons and piste markers)
export const PISTE_WIDTH = [24, 20, 16, 14];

const ADJ = ['Glacier', 'Eagle', 'Black Pine', 'Thunder', 'Crystal', 'Wolf', 'Edelweiss', 'Avalanche', 'Silver', 'Frost', 'Summit', 'Storm', 'Alpenglow', 'Ibex', 'Powder', 'Granite', 'North Face', 'Kandahar'];
const NOUN = ['Run', 'Couloir', 'Descent', 'Cup', 'Challenge', 'Slalom', 'Derby', 'Trophy', 'Classic', 'Dash', 'Chute', 'Line'];

export const layout = {
  lifts: [],     // { type, name, bottom, top, dir, length, towers: [{ u, x, z }], mid?: { u, x, z, y, name, side } }
  races: [],
  pistes: [],    // { name, diff, pts: [[x, z]...], number, peak, lane? }
  lanes: [],     // ski lanes: pistes (lane: true) lined with nets on both sides, see buildLane
  huts: [],      // mountain restaurants { x, z, name, label, yaw } (the village builds them)
  peaks: [],     // ski mountains: { id, name, lift, hut, patrol: {x, z}, pistes, summit }
  bowls: [],     // open freeride bowls { name, pts, w } (sectors.js): shaped and crag-free, not groomed
  park: null,    // Legacy Park: frame, features, corridor line, Park Lift (park.js builds the meshes)
  nets: [],      // safety-net runs (resortdressing.js builds them), see planNets
  busStops: [],  // ski-bus stops { x, z, heading, name }: the village plaza + every gondola base
  cells: new Map(),
  listeners: [],
  onAdd(fn) { this.listeners.push(fn); },
  emit(kind, obj) { for (const fn of this.listeners) fn(kind, obj); },
};

// ---------- path tracing on the base heightfield ----------
export function tracePath(sx, sz, opts) {
  const { step = 6, maxLen = 1500, maxSlope = 0.6, goal = null, goalWeight = 0, wiggle = 0, phase = 0, initDir = null, stopFlat = true } = opts;
  const pts = [[sx, sz]];
  let x = sx, z = sz, len = 0, flat = 0;
  let [gx, gz] = world.gradient(x, z, true, 3);
  let dx = initDir ? initDir[0] : -gx, dz = initDir ? initDir[1] : -gz;
  let dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
  const maxTurn = 0.2;
  while (len < maxLen) {
    [gx, gz] = world.gradient(x, z, true, 3);
    const slope = Math.hypot(gx, gz);
    let fx = -gx / (slope || 1), fz = -gz / (slope || 1);
    // desired: inertia + fall line + goal attraction + gentle meander
    let tx = dx * 1.4 + fx * (slope > 0.02 ? 1 : 0.1);
    let tz = dz * 1.4 + fz * (slope > 0.02 ? 1 : 0.1);
    if (goal) {
      const gl = Math.hypot(goal[0] - x, goal[1] - z) || 1;
      tx += ((goal[0] - x) / gl) * goalWeight; tz += ((goal[1] - z) / gl) * goalWeight;
    }
    if (wiggle) {
      const w = Math.sin(len / 90 + phase) * wiggle;
      tx += -dz * w; tz += dx * w;
    }
    let tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    // Too steep along desired direction -> traverse across the fall line
    const sAlong = tx * fx + tz * fz;
    if (slope * sAlong > maxSlope && slope > 0) {
      const c = clamp(maxSlope / slope, 0, 1);
      const sn = Math.sqrt(1 - c * c);
      // rotate the fall line by +-acos(c), toward the side we're already heading
      const side = (fx * dz - fz * dx) >= 0 ? 1 : -1;
      const s = side * sn;
      tx = fx * c - fz * s;
      tz = fx * s + fz * c;
    }
    // limit turn rate
    const cross = dx * tz - dz * tx, dot = dx * tx + dz * tz;
    let ang = Math.atan2(cross, dot);
    ang = clamp(ang, -maxTurn, maxTurn);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ndx = dx * ca - dz * sa, ndz = dx * sa + dz * ca;
    dx = ndx; dz = ndz;
    x += dx * step; z += dz * step; len += step;
    pts.push([x, z]);
    if (goal && Math.hypot(goal[0] - x, goal[1] - z) < 30) break;
    if (stopFlat) {
      if (slope < 0.035) flat++; else flat = 0;
      if (flat > 10) break;
    }
  }
  return { pts, len };
}

function smoothPts(pts, iters = 3) {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const q = [p[0]];
    for (let i = 1; i < p.length - 1; i++) {
      q.push([(p[i - 1][0] + p[i][0] * 2 + p[i + 1][0]) / 4, (p[i - 1][1] + p[i][1] * 2 + p[i + 1][1]) / 4]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

function resample(pts, spacing) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const l = Math.hypot(bx - ax, bz - az);
    let t = spacing - carry;
    while (t <= l) {
      out.push([ax + ((bx - ax) * t) / l, az + ((bz - az) * t) / l]);
      t += spacing;
    }
    carry = l - (t - spacing);
  }
  return out;
}

function pathLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}
function arcLengths(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return acc;
}
// position + unit direction at arc length s
function sampleAt(pts, acc, s) {
  let i = 1;
  while (i < pts.length - 1 && acc[i] < s) i++;
  const a = pts[i - 1], b = pts[i], l = acc[i] - acc[i - 1] || 1, t = clamp((s - acc[i - 1]) / l, 0, 1);
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / l, dz: (b[1] - a[1]) / l };
}
// distance from (x, z) to segment a-b
function segDist(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
  const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
  return Math.hypot(ax + ex * t - x, az + ez * t - z);
}

// how far a course strays to either side of the straight line from a to b: [toward +n, toward -n] with
// n = (-(bz - az), bx - ax) / |b - a| (its lift runs beside it, clear of the widest wiggle)
function lateralReach(pts, ax, az, bx, bz) {
  const l = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / l, nz = (bx - ax) / l;
  let pos = 0, neg = 0;
  for (const [x, z] of pts) { const d = (x - ax) * nx + (z - az) * nz; if (d > pos) pos = d; if (-d > neg) neg = -d; }
  return [pos, neg];
}

// ---------- piste router (main mountain + resort peaks) ----------
// A piste designer's line: the cheapest path over a coarse height grid of the mountain's face (A*), where
// cost grows with grades outside the piste's band, any climbing, cliffs, side-hills, leaving the ski
// bowl, running on top of pistes already laid out, and turning (so it keeps long, clean traverses).
// The grid path is then smoothed (keeping its switchbacks and length) and resampled every 8 m.
// A face: { top: {x, z}, fx, fz (unit, down the face), faceLen, bowl, halfW? }; u = metres down the face
// from the top station, v = metres across it (+ = right, looking down the face).
const GRID = 12; // m
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const DLEN = DIRS.map(([a, b]) => Math.hypot(a, b) * GRID);
// angle between every pair of step directions (radians), for the turning cost
const DANG = new Float64Array(DIRS.length * DIRS.length);
DIRS.forEach(([a, b], i) => DIRS.forEach(([c, d], j) => { DANG[i * DIRS.length + j] = Math.acos(clamp((a * c + b * d) / (Math.hypot(a, b) * Math.hypot(c, d)), -1, 1)); }));

function faceGrid(m) {
  if (m.grid) return m.grid;
  const halfW = m.halfW ?? 960;
  const u0 = -120, v0 = -halfW;
  const NU = Math.ceil((m.faceLen + 200) / GRID), NV = Math.ceil((2 * halfW) / GRID);
  const H = new Float32Array(NU * NV), S = new Float32Array(NU * NV);
  const X = (u, v) => m.top.x + m.fx * u - m.fz * v, Z = (u, v) => m.top.z + m.fz * u + m.fx * v;
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const u = u0 + i * GRID, v = v0 + j * GRID;
    H[i * NV + j] = world.baseHeight(X(u, v), Z(u, v));
  }
  for (let i = 1; i < NU - 1; i++) for (let j = 1; j < NV - 1; j++) {
    const k = i * NV + j;
    S[k] = Math.hypot(H[k + NV] - H[k - NV], H[k + 1] - H[k - 1]) / (2 * GRID);
  }
  m.grid = { u0, v0, NU, NV, H, S, X, Z };
  return m.grid;
}

// opts: gMin / gMax grade band, side (-1 | 1 preferred half of the face, 0 = centre), avoid = pistes,
// blocked = [[x, z, r]...] places the line must keep away from (buildings), turnCost (m of travel per
// radian of turning), sideHill (weight of the side-hill penalty: low for a cat track cut into the slope),
// steepCost (weight of grades above the band: high = rather a long way round than a steep pitch),
// via = [u, v] a point the line passes on its way (e.g. a mid-station), occupy = [{ pts, w }...] runs a
// ski lane keeps off (selfW: its own half-width, occCost: the price per metre on one of them)
function routePiste(m, startUV, endUV, opts) {
  if (opts.via) {
    const a = routePiste(m, startUV, opts.via, { ...opts, via: null }), b = routePiste(m, opts.via, endUV, { ...opts, via: null });
    return removeLoops(smoothPts(resample([...a, ...b.slice(1)], 8), 3));
  }
  const { gMin, gMax, side = 0, avoid = [], blocked = [], turnCost = 8, sideHill = 3, steepCost = 40 } = opts;
  const G = faceGrid(m), { u0, v0, NU, NV, H, S } = G;
  const node = ([u, v]) => clamp(Math.round((u - u0) / GRID), 1, NU - 2) * NV + clamp(Math.round((v - v0) / GRID), 1, NV - 2);
  const start = node(startUV), goal = node(endUV);
  const gi = Math.floor(goal / NV), gj = goal % NV;
  const toIJ = (x, z) => { const dx = x - m.top.x, dz = z - m.top.z; return [Math.round((dx * m.fx + dz * m.fz - u0) / GRID), Math.round((dz * m.fx - dx * m.fz - v0) / GRID)]; };
  // other pistes on this face (in grid units) to keep a little distance from
  const near = new Uint8Array(NU * NV);
  for (const p of avoid) for (const [x, z] of p.pts) {
    const [i, j] = toIJ(x, z);
    for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) {
      const ii = i + a, jj = j + b;
      if (ii > 0 && jj > 0 && ii < NU && jj < NV) near[ii * NV + jj] = 1;
    }
  }
  // cells where a ski lane would run on another run (it crosses one square, where it has to)
  const occ = opts.occupy ? new Uint8Array(NU * NV) : null;
  if (occ) for (const r of opts.occupy) {
    const reach = r.w + (opts.selfW || 0) + 6, n = Math.ceil(reach / GRID);
    for (const [x, z] of r.pts) {
      const [i, j] = toIJ(x, z);
      if (i < -n || j < -n || i > NU + n || j > NV + n) continue;
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
        const ii = i + a, jj = j + b;
        if (ii > 0 && jj > 0 && ii < NU && jj < NV && Math.hypot(a, b) * GRID <= reach) occ[ii * NV + jj] = 1;
      }
    }
  }
  const block = new Uint8Array(NU * NV);
  for (const [x, z, r] of blocked) {
    const [i, j] = toIJ(x, z), n = Math.ceil(r / GRID);
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
      const ii = i + a, jj = j + b;
      if (ii > 0 && jj > 0 && ii < NU && jj < NV && Math.hypot(a, b) * GRID <= r) block[ii * NV + jj] = 1;
    }
  }
  const N = NU * NV, gScore = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const arrive = new Int8Array(N).fill(-1); // step direction each node was reached by
  const TURN = DANG.map((a) => a * GRID * turnCost);
  const heap = new MinHeap(N * 4);
  gScore[start] = 0;
  heap.push(0, start);
  while (heap.size) {
    const a = heap.pop();
    if (a === goal) break;
    if (closed[a]) continue;
    closed[a] = 1;
    const ai = Math.floor(a / NV), aj = a % NV;
    // direction we arrived from: turning costs a little, so the line keeps long, clean legs
    const pk = arrive[a];
    for (let k = 0; k < DIRS.length; k++) {
      const bi = ai + DIRS[k][0], bj = aj + DIRS[k][1];
      if (bi < 1 || bj < 1 || bi >= NU - 1 || bj >= NV - 1) continue;
      const b = bi * NV + bj;
      if (closed[b]) continue;
      const d = DLEN[k];
      const g = (H[a] - H[b]) / d; // + = downhill
      const s = Math.max(S[a], S[b]);
      const u = u0 + bi * GRID, v = v0 + bj * GRID;
      let pen = 0;
      if (g > gMax) pen += steepCost * (g - gMax) / gMax;             // too steep for this piste
      if (g < gMin) pen += 6 * (gMin - g) / 0.05;                       // too flat to glide
      if (g < 0) pen += 80 * -g / 0.05;                                  // climbing
      if (s > 0.95) pen += 40;                                           // cliffs and rock bands
      pen += sideHill * Math.max(0, Math.sqrt(Math.max(0, s * s - g * g)) - 0.35); // side-hill traverses
      if (Math.abs(v) - u * 0.2 > m.bowl + 120) pen += 2;               // off the ski bowl
      if (side && v * side < 60) pen += 0.6;                             // the piste's own side of the face
      if (near[b] && u > 140 && u < m.faceLen - 160) pen += 1.2;         // don't run on top of another piste
      if (block[b]) pen += 200;                                          // buildings
      if (occ && occ[b]) pen += opts.occCost ?? 12;                      // (ski lanes) on another run
      // turning costs ~100 m of travel per radian (taken from the parent's direction: cheap, near-optimal)
      const turn = pk < 0 ? 0 : TURN[pk * DIRS.length + k];
      const t = gScore[a] + d * (1 + pen) + turn;
      if (t < gScore[b]) {
        gScore[b] = t; from[b] = a; arrive[b] = k;
        heap.push(t + Math.hypot(bi - gi, bj - gj) * GRID, b);
      }
    }
  }
  // walk back, then smooth away the grid's staircase (keeping the switchbacks and the path length)
  const cells = [];
  for (let n = goal; n !== -1; n = from[n]) cells.push(n);
  cells.reverse();
  const uv = cells.map((n) => [u0 + Math.floor(n / NV) * GRID, v0 + (n % NV) * GRID]);
  uv[0] = startUV; uv[uv.length - 1] = endUV;
  const pts = smoothPts(resample(uv.map(([u, v]) => [G.X(u, v), G.Z(u, v)]), 4), 8);
  return removeLoops(smoothPts(resample(removeLoops(pts), 8), 2));
}

// Cut out any small loop a tight turn leaves after smoothing (the line jumps across at the crossing).
function crosses(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function removeLoops(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let cut = -1;
    for (let j = Math.min(pts.length - 1, i + 60); j > i + 1; j--) {
      if (crosses(pts[i - 1], pts[i], pts[j - 1], pts[j])) { cut = j; break; }
    }
    if (cut > 0) { out.push(pts[cut]); i = cut; } else out.push(pts[i]);
  }
  return out;
}

// binary min-heap on typed arrays (A* open list)
class MinHeap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.size = 0; }
  push(key, val) {
    if (this.size === this.k.length) { const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2); k.set(this.k); v.set(this.v); this.k = k; this.v = v; }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[--this.size], val = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

// village buildings (rental shop, ticket booth, hotels): runs keep well clear of them
export const VILLAGE_BUILDINGS = [[-40, -18], [15, -50], [62, 34], [-74, 44], [100, -34], [-108, -60], [22, 92], [-36, 108], [118, 70], [-128, 22]];

// ---------- builders ----------
// A station's or race start's flattened pad is packed, groomed snow, embankment included, so a pad cut into
// a slope blends in as smooth snow instead of showing a rim of bare rock.
function groomedPad(pad, dir = [0, 1]) {
  world.addCorridor([[pad.x - dir[0], pad.z - dir[1]], [pad.x + dir[0], pad.z + dir[1]]], pad.r + pad.blend + 4, 'piste');
  return pad;
}

// tower spots along a lift line (lifts.js raises them over the terrain); a gondola with a mid-station
// has two sections, each with its own evenly spaced towers
function liftTowers(lift) {
  const spacing = lift.type === 'gondola' ? 240 : 115;
  const cuts = [0, ...(lift.mid ? [lift.mid.u] : []), lift.length], out = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k], b = cuts[k + 1], n = Math.max(0, Math.round((b - a) / spacing) - 1);
    for (let i = 1; i <= n; i++) {
      const u = a + ((b - a) * i) / (n + 1);
      out.push({ u, x: lift.bottom.x + lift.dir[0] * u, z: lift.bottom.z + lift.dir[1] * u });
    }
  }
  return out;
}

function addLift(spec) {
  const lift = { id: layout.lifts.length, ...spec };
  // stations get flat pads
  const dx = lift.top.x - lift.bottom.x, dz = lift.top.z - lift.bottom.z;
  const l = Math.hypot(dx, dz);
  lift.dir = [dx / l, dz / l];
  lift.length = l;
  const gondola = lift.type === 'gondola';
  // (bottomPadDrop: the base sits a little below the slope it stands on, so the way in stays level)
  if (!lift.noBottomPad) groomedPad(world.addPad({ x: lift.bottom.x, z: lift.bottom.z, r: gondola ? 30 : 16, blend: 30, h: lift.bottomPadDrop ? world.height(lift.bottom.x, lift.bottom.z) - lift.bottomPadDrop : undefined }), lift.dir);
  groomedPad(world.addPad({ x: lift.top.x, z: lift.top.z, r: gondola ? 34 : 16, blend: 34 }), lift.dir);
  lift.bottom.y = world.height(lift.bottom.x, lift.bottom.z);
  lift.top.y = world.height(lift.top.x, lift.top.z);
  world.addCorridor([[lift.bottom.x, lift.bottom.z], [lift.top.x, lift.top.z]], gondola ? 9 : 7, 'lift');
  lift.towers = liftTowers(lift);
  layout.lifts.push(lift);
  layout.emit('lift', lift);
  return lift;
}

function addPiste(name, diff, pts, extra = {}) {
  const piste = { name, diff, pts, ...extra };
  world.addCorridor(pts, PISTE_WIDTH[diff], 'piste', piste);
  layout.pistes.push(piste);
  layout.emit('piste', piste);
  return piste;
}

// index of the gentlest spot in the first ~80 m of a course: the start platform goes there, so it sits
// naturally in the slope instead of being cut deep into a steep pitch
function gentlestStart(path, window = 20) {
  let best = 0, bestS = Infinity;
  for (let i = 0; i < Math.min(window, path.length - 30); i++) {
    const [gx, gz] = world.gradient(path[i][0], path[i][1], false, 5);
    const s = Math.hypot(gx, gz) + i * 0.004; // the earliest of equally gentle spots
    if (s < bestS) { bestS = s; best = i; }
  }
  return best;
}

// (extra.startWindow: how far down, in 4 m steps, the start may move to a gentler spot; a race by a gondola
// stop keeps its start close to the stop)
function buildRace(name, diffIdx, pts, seed, { startWindow = 20, ...extra } = {}) {
  if (!RESORT_RACES) return null; // (the open world's races are the World Racing courses now: modes/parkour/freeworld.js)
  const D = DIFFICULTY[diffIdx];
  const rnd = mulberry32(seed);
  let path = resample(smoothPts(pts, 4), 4);
  path = path.slice(gentlestStart(path, startWindow));
  const total = pathLength(path);
  // gates (race team, Oct 26-27 'races way too hard / way too messy'): a few wide gates, every 85-100 m (World
  // Cup downhills every 150 m), at most 10 per race, the turning pole almost on the line (straight down the middle
  // passes every gate), 9 m openings with a green bar between the flags (races.js), none on a sharp bend
  const GATE_GAP = extra.arena ? [150, 150, 150, 150] : [100, 90, 85, 85]; // (a World Cup downhill: a few wide speed gates)
  const gateCount = clamp(Math.round(total / GATE_GAP[diffIdx]) - 1, 4, 10);
  const spacing = total / (gateCount + 1);
  const gates = [];
  const amp = [0.4, 1.0, 1.6, 2.2][diffIdx];
  const halfWidth = extra.halfWidth ?? [3.5, 5.5, 7, 8.5][diffIdx] + 9; // groomed course width (World Cup courses are wider)
  const bendAt = (i) => {
    const a = path[Math.max(0, i - 3)], b = path[i], c = path[Math.min(path.length - 1, i + 3)];
    const h0 = Math.atan2(b[0] - a[0], b[1] - a[1]), h1 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    return Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)));
  };
  let side = rnd() < 0.5 ? 1 : -1;
  for (let g = 1; g <= gateCount; g++) {
    let idx = Math.min(path.length - 2, Math.round(((g * spacing) / total) * (path.length - 1)));
    if (bendAt(idx) > 0.38) {
      const alt = [2, -2, 4, -4].map((d) => clamp(idx + d, 4, path.length - 6)).find((i) => bendAt(i) <= 0.38);
      if (alt === undefined) continue; // a tight spot: no gate here
      idx = alt;
    }
    const [ax, az] = path[idx], [bx, bz] = path[idx + 1];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    const nx = -(bz - az) / l, nz = (bx - ax) / l;
    const off = side * amp * (0.75 + rnd() * 0.5);
    gates.push({ x: ax + nx * off, z: az + nz * off, nx, nz, side, color: gates.length % 2 ? 'blue' : 'red' });
    side = -side;
  }
  const start = { x: path[0][0], z: path[0][1] };
  const end = path[path.length - 1];
  const finish = { x: end[0], z: end[1] };
  const race = {
    id: layout.races.length,
    name, diff: diffIdx, D, path, gates, start, finish, length: total,
    reward: Math.round((D.reward * (0.8 + total / D.length * 0.3)) / 10) * 10,
    seed, ...extra, halfWidth,
  };
  race.drop = world.baseHeight(start.x, start.z) - world.baseHeight(finish.x, finish.z);
  world.addCorridor(path.map((p) => [p[0], p[1]]), race.halfWidth, 'race', race);
  // a flat start platform you can stop on and line up for the countdown, groomed into the slope
  const sdx = path[3][0] - path[0][0], sdz = path[3][1] - path[0][1], sdl = Math.hypot(sdx, sdz) || 1;
  groomedPad(world.addPad({ x: start.x, z: start.z, r: 6, blend: 26 }), [sdx / sdl, sdz / sdl]);
  layout.races.push(race);
  layout.emit('race', race);
  return race;
}

const cut = (pts, a, b) => pts.slice(Math.floor(pts.length * a), Math.floor(pts.length * b));
// the stretch of a line from `from` metres below its start to `to` metres before its end
function span(pts, from, to) {
  const acc = arcLengths(pts), L = acc.at(-1);
  const i0 = acc.findIndex((s) => s >= from), i1 = acc.findIndex((s) => s >= L - to);
  return pts.slice(Math.max(0, i0), i1 < 0 ? pts.length : i1 + 1);
}
const stretch = (pts, r) => (r.span ? span(pts, r.span[0], r.span[1]) : cut(pts, r.frac[0], r.frac[1]));

// Where riders step out at a gondola's top station / mid-station: as lifts.js lets them off (beyond the top
// station, 4 m to the side of the line; at the foot of the mid-station's stair).
export function stopExit(lift, stop) {
  const [dx, dz] = lift.dir, sx = -dz, sz = dx;
  if (stop === 'mid') { const sd = lift.mid.side || 1; return { x: lift.mid.x + sx * sd * 10.6 - dx * 1.8, z: lift.mid.z + sz * sd * 10.6 - dz * 1.8 }; }
  const off = (lift.type === 'gondola' ? 14 : 8) * 0.5 + 9;
  return { x: lift.top.x + dx * off + sx * 4, z: lift.top.z + dz * off + sz * 4 };
}

// The stretch of a piste for a race by a gondola stop: from the piste's nearest pass by the stop, its first
// point at least `near` m from where riders step out and below them, down to `endFrac` of the piste (or
// `endBack` m before its end). It keeps off the other courses: the start moves on past a ski lane the piste
// crosses close to the stop (staying a short walk from it), and the race ends before it first runs onto
// another race course or lane (courses that leave the stop with it, within its first 350 m, excepted).
const RACE_HW = [12.5, 14.5, 16, 17.5]; // a course's groomed half-width by difficulty (buildRace)
function fromStop(pts, exit, { near = 55, endFrac = 0.9, endBack = null, hw = 14.5 } = {}) {
  const he = world.baseHeight(exit.x, exit.z), d = (i) => Math.hypot(pts[i][0] - exit.x, pts[i][1] - exit.z);
  let i0 = 0;
  for (let i = 1; i < pts.length; i++) if (d(i) < d(i0)) i0 = i;
  while (i0 < pts.length - 1 && (d(i0) < near || world.baseHeight(pts[i0][0], pts[i0][1]) > he - 2)) i0++;
  const acc = arcLengths(pts), sEnd = endBack !== null ? acc.at(-1) - endBack : acc.at(-1) * endFrac, k1 = acc.findIndex((s) => s >= sEnd);
  let i1 = Math.min(pts.length - 1, Math.max(i0 + 2, k1 < 0 ? pts.length - 1 : k1));
  const courses = [
    ...layout.races.map((r) => ({ pts: r.path, w: r.halfWidth })),
    ...layout.lanes.map((l) => ({ pts: l.pts, w: PISTE_WIDTH[l.diff], lane: true })),
  ].map((c) => ({ ...c, box: bounds(c.pts, c.w + hw) }));
  const on = (i, c) => onCourse(pts[i][0], pts[i][1], c, hw + c.w); // their groomed widths meet
  for (let i = i0; i < i1 && d(i) < 115; i++) if (courses.some((c) => c.lane && on(i, c))) i0 = i + 1;
  const beside = courses.filter((c) => !c.lane && pts.slice(i0, i1 + 1).some((_, k) => acc[i0 + k] - acc[i0] < 350 && on(i0 + k, c)));
  for (let i = i0 + 1; i <= i1; i++) if (courses.some((c) => !beside.includes(c) && on(i, c))) { i1 = i - 1; break; }
  return pts.slice(i0, i1 + 1);
}
// [minx, minz, maxx, maxz] of a line, grown by r; is (x, z) within r of the line (inside its box)?
function bounds(pts, r) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, z] of pts) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
  return [a - r, b - r, c + r, d + r];
}
function onCourse(x, z, c, r) {
  if (x < c.box[0] || z < c.box[1] || x > c.box[2] || z > c.box[3]) return false;
  for (let k = 1; k < c.pts.length; k++) {
    const a = c.pts[k - 1], b = c.pts[k];
    if ((a[0] - x > r && b[0] - x > r) || (x - a[0] > r && x - b[0] > r) || (a[1] - z > r && b[1] - z > r) || (z - a[1] > r && z - b[1] > r)) continue;
    if (segDist(x, z, a[0], a[1], b[0], b[1]) < r) return true;
  }
  return false;
}

// The run-out of a piste whose gondola base stands in the village, beyond the foot of its face: from the
// piste's end a smooth curve over the apron (falling gently toward the village) that arrives along the lift
// line, `back` m up the line from the station and `lat` m to its side (lifts.js sideV).
function runOut(pts, lift, lat, back = 50) {
  const [ux, uz] = lift.dir, sx = -uz, sz = ux;
  const [ax, az] = pts.at(-1), [px, pz] = pts[Math.max(0, pts.length - 4)];
  const tx = lift.bottom.x + ux * back + sx * lat, tz = lift.bottom.z + uz * back + sz * lat;
  const D = Math.hypot(tx - ax, tz - az), dl = Math.hypot(ax - px, az - pz) || 1;
  const c1 = [ax + ((ax - px) / dl) * D * 0.35, az + ((az - pz) / dl) * D * 0.35], c2 = [tx + ux * D * 0.35, tz + uz * D * 0.35];
  const curve = [];
  for (let k = 1; k <= 40; k++) {
    const t = k / 40, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, e = t ** 3;
    curve.push([a * ax + b * c1[0] + c * c2[0] + e * tx, a * az + b * c1[1] + c * c2[1] + e * tz]);
  }
  const out = resample([[ax, az], ...curve], 8).slice(1);
  if (Math.hypot(out.at(-1)[0] - tx, out.at(-1)[1] - tz) > 2) out.push([tx, tz]);
  return out;
}

// grade bands (min, max) a piste of each difficulty is laid out in
const BAND = [[0.05, 0.21], [0.07, 0.33], [0.1, 0.48], [0.12, 0.68]];
// Decluttered resort (Oct 27, the user: "1 to 3 main big courses per mountain, hardly any flags, races way less
// messy"): no net-lined ski lanes, no procedural races (and their Express chairs) out in the open world, a
// handful of races on the main runs. Runs marked `drop` are still routed (so their neighbours and the secrets
// keep exactly their lines) but never laid out: no corridor, markers, nets, signs or race.
const LANES_ON = false, PROCEDURAL_RACES = false;
// Oct 27 (the user: "replace all the races in free world with the races of the race game mode, on the mountains"):
// no gate races in the resort any more (no start platforms, arches, gates, signs, arenas or AI fields); the eight
// World Racing courses stand on the mountains around the resort instead (modes/parkour/freeworld.js). The runs
// the Bunny Chair and the Valley Chair serve stay as plain pistes (runPiste).
const RESORT_RACES = false;
// a former race line as a plain piste (smoothed and started on its gentlest spot like a race course was)
function runPiste(name, diff, pts, extra = {}) {
  let path = resample(smoothPts(pts, 4), 4);
  path = path.slice(gentlestStart(path, 20));
  const piste = addPiste(name, diff, path, extra);
  return { piste, path, start: { x: path[0][0], z: path[0][1] }, finish: { x: path.at(-1)[0], z: path.at(-1)[1] } };
}

// ---------- the main mountain + village lifts ----------
// The main face runs from the gondola top station down to the north edge of the village; its three pistes
// are laid out by the same router as the resort peaks, so they hold their grades all the way down.
const MAIN_FACE = (() => {
  const top = { x: MAIN_SUMMIT.x + 10, z: MAIN_SUMMIT.z + 230 }, end = { x: 0, z: -140 };
  const dx = end.x - top.x, dz = end.z - top.z, l = Math.hypot(dx, dz);
  return { id: 'legacy', top, fx: dx / l, fz: dz / l, faceLen: l, bowl: 1100, halfW: 1140 };
})();
// start / end in the face frame ([u, v]; end u is measured back from the face's foot); v > 0 = west.
// The summit is ringed by steep ground, so the green Panorama starts at the Legacy Mid-Station (start
// 'mid': beside its exit) and is a long cat track that prefers traverses cut into the slope to hairpins.
const MAIN_PISTES = [
  { name: 'Kandahar', number: 3, diff: 3, side: 0, start: [62, 0], end: [-14, 0] },
  { name: 'Edelweiss', number: 2, diff: 1, side: -1, start: [44, -70], end: [-20, -26], steepCost: 160 },
  { name: 'Panorama', number: 1, diff: 0, side: 1, start: 'mid', end: [-20, 26], turnCost: 30, sideHill: 0.8 },
];
// the beginner area's top station (the Bunny Hill Cup starts there): the main pistes keep clear of it
const BUNNY_TOP = [330, -720, 70];

function buildMainMountain() {
  // Village center at origin. Gondola runs from the village to just below the main summit.
  const top = { ...MAIN_FACE.top };
  const gondola = addLift({ type: 'gondola', name: 'Legacy Gondola', bottom: { x: 0, z: -70 }, top, price: 50, noBottomPad: true, main: true, topName: 'the summit', bottomName: 'Legacy Village' });
  placeMid(gondola, -1); // the Legacy Mid-Station; its stair and exit face west, where the Panorama starts

  // Summit restaurant
  const hut = { x: top.x + 70, z: top.z + 30, name: 'Gipfel Hütte', label: 'Summit · Gipfel Hütte', yaw: 0 };
  world.addPad({ x: hut.x, z: hut.z, r: 16, blend: 20 });
  layout.huts.push(hut);

  // Main pistes summit -> village (they finish on the plaza's north edge, by the gondola)
  const blocked = [...VILLAGE_BUILDINGS.map(([x, z]) => [x, z, 48]), BUNNY_TOP];
  const byName = {};
  const routed = [];
  const [mu, mv] = faceUV(MAIN_FACE, gondola.mid.x, gondola.mid.z);
  for (const d of MAIN_PISTES) {
    const [gMin, gMax] = BAND[d.diff];
    const start = d.start === 'mid' ? [mu + 14, mv + 36] : d.start;
    const pts = routePiste(MAIN_FACE, start, [MAIN_FACE.faceLen + d.end[0], d.end[1]], { gMin, gMax, side: d.side, avoid: routed.map((r) => ({ pts: r })), blocked, via: d.via, turnCost: d.turnCost, sideHill: d.sideHill, steepCost: d.steepCost });
    if (Math.hypot(pts.at(-1)[0], pts.at(-1)[1] + 120) > 8) pts.push([0, -120]);
    routed.push(pts);
    byName[d.name] = { d, pts };
  }
  for (const name of ['Panorama', 'Edelweiss', 'Kandahar']) {
    const { d, pts } = byName[name];
    byName[name].piste = addPiste(d.name, d.diff, pts, { peak: 'legacy', number: d.number });
  }
  const { Panorama: pan, Edelweiss: edel, Kandahar: kand } = byName;

  // Races on the main mountain: the Legacy Downhill runs the whole Kandahar as a World Cup course (it starts
  // by the top station); the Panorama Cup, by the Legacy Mid-Station, comes after the Legacy Lane below
  buildRace('Legacy Downhill', 3, span(kand.pts, 36, 150), 11, { main: true, arena: true, peak: 'legacy', halfWidth: PISTE_WIDTH[3] + 5 });
  // ski patrol hut on the shoulder beside the top station
  const patrol = { x: top.x - 34, z: top.z - 18 };
  world.addPad({ x: patrol.x, z: patrol.z, r: 6, blend: 10 });
  layout.peaks.push({ id: 'legacy', name: 'Legacy', lift: gondola, hut, pistes: layout.pistes.slice(0, 3), patrol });

  // Beginner area: a short chairlift up from the village edge with an easy race back down
  const bx = 330, bz = -200;
  const { pts } = tracePath(bx, bz - 520, { step: 6, maxLen: 600, maxSlope: 0.25, goal: [bx, bz], goalWeight: 1.1, stopFlat: false });
  const easy = RESORT_RACES ? buildRace('Bunny Hill Cup', 0, pts, 14, { main: true }) : runPiste('Bunny Hill', 0, pts, { peak: 'legacy', number: 7 });
  const ax = easy.finish.x, az = easy.finish.z, sx = easy.start.x, sz = easy.start.z;
  const ex = sx - ax, ez = sz - az, el = Math.hypot(ex, ez);
  const px = -ez / el * 35, pz = ex / el * 35;
  const lift = addLift({ type: 'chair', name: 'Bunny Chair', bottom: { x: ax + px, z: az + pz }, top: { x: sx + px, z: sz + pz }, price: 20 });
  easy.lift = lift.id;
  world.addCorridor([[0, -120], [ax + px, az + pz]], 10, 'piste');

  // Legacy Valley Run: starts right below the village plaza and runs down the endless valley,
  // with a chairlift back up from the finish
  {
    const sz = 330, sx = valleyCenter(sz);
    const { pts } = tracePath(sx, sz, { step: 6, maxLen: 1300, maxSlope: 0.4, wiggle: 0.35, phase: 1.7, stopFlat: false,
      initDir: [0, 1], goal: [valleyCenter(1650), 1650], goalWeight: 0.6 });
    const vr = RESORT_RACES ? buildRace('Legacy Valley Run', 1, pts, 15, { main: true }) : runPiste('Legacy Valley Run', 1, pts, { number: 8 });
    const ex = vr.start.x - vr.finish.x, ez = vr.start.z - vr.finish.z, el = Math.hypot(ex, ez) || 1;
    const lift = addLift({ type: 'chair', name: 'Valley Chair', price: 20,
      bottom: { x: vr.finish.x - (ez / el) * 32, z: vr.finish.z + (ex / el) * 32 },
      top: { x: vr.start.x - (ez / el) * 32 - (ex / el) * 10, z: vr.start.z + (ex / el) * 32 - (ez / el) * 10 } });
    vr.lift = lift.id;
  }
  // the Legacy Lane, from the mid-station down to the village (laid out last: it keeps off every run above),
  // then the Panorama Cup from beside the mid-station, clear of the lane
  if (LANES_ON) layout.peaks.find((pk) => pk.id === 'legacy').pistes.push(buildLane(MAIN_FACE, LANES.legacy, gondola));
  MAIN_FACE.grid = null;
  return gondola;
}

// face frame coordinates [u, v] of a world point
const faceUV = (m, x, z) => [(x - m.top.x) * m.fx + (z - m.top.z) * m.fz, (z - m.top.z) * m.fx - (x - m.top.x) * m.fz];

// ---------- the resort peaks (Adlerhorn, Silberhorn, Sonnenkopf) ----------
// Positions are designed in each peak's face frame: u = metres down the face from the top station,
// v = metres across it (+ = right, looking down the face). Huts sit on the south side of their station
// (sun terraces face south). Each piste has a grade band (gMin..gMax), a preferred side of the face and
// ends just above the gondola base station (end = [metres before the base, across]).
// Races: `span` = [metres below the piste's start, metres before its end], or `frac` = share of its length,
// or `stop` = 'top' | 'mid': it starts a short walk (`near` m or more) from where riders get off at that
// gondola stop and runs down to `endFrac` of the piste or `endBack` m before its end (see fromStop).
// viaMid: the piste passes the gondola's mid-station (45 m to its side), so riders can ski from there.
// base: the gondola's bottom station stands in Legacy Village, a short walk from the plaza, instead of at the
// foot of the face; the line runs on to the same top station and the pistes run out over the apron to it.
const PEAKS = {
  adlerhorn: {
    number: 11, lift: 'Adlerhorn Gondola', price: 40, hut: { name: 'Adlerhorn Hütte', u: 30, v: -100 }, patrol: { u: -18, v: 58 },
    base: { x: 100, z: 0 },
    pistes: [
      { name: 'Adlerflug', diff: 2, side: 0, start: [46, 4], end: [-58, 4] },
      { name: 'Sonnenhang', diff: 1, side: 1, start: [42, 34], end: [-52, 16], viaMid: true },
      { name: 'Fuchsweg', diff: 0, side: -1, start: [42, -36], end: [-50, -18], drop: true },
    ],
    races: [
      { piste: 'Adlerflug', name: 'Adlerhorn Super-G', diff: 2, stop: 'top', endBack: 130, seed: 21, arena: true },
    ],
  },
  silberhorn: {
    number: 21, lift: 'Silberhorn Gondola', price: 40, hut: { name: 'Silberhorn Hütte', u: 30, v: 100 }, patrol: { u: -18, v: -58 },
    base: { x: -75, z: 84 },
    pistes: [
      { name: 'Silberpfeil', diff: 3, side: 0, start: [46, -4], end: [-58, -4] },
      { name: 'Gamsweg', diff: 1, side: 1, start: [42, 32], end: [-52, 16], viaMid: true },
      { name: 'Gratweg', diff: 2, side: -1, start: [42, -38], end: [-50, -18] },
    ],
    races: [
      { piste: 'Silberpfeil', name: 'Silberhorn Downhill', diff: 3, span: [36, 130], seed: 24, arena: true },
    ],
  },
  sonnenkopf: {
    number: 31, lift: 'Sonnenkopf Gondola', price: 40, hut: { name: 'Sonnenkopf Hütte', u: 30, v: -100 }, patrol: { u: -18, v: 58 },
    pistes: [
      { name: 'Wolfsschlucht', diff: 2, side: 0, start: [46, -4], end: [-58, -4], drop: true },
      { name: 'Lärchenweg', diff: 1, side: 1, start: [42, 32], end: [-52, 16], viaMid: true },
      { name: 'Hasenweg', diff: 0, side: -1, start: [42, -36], end: [-50, -18] },
    ],
    races: [
      { piste: 'Hasenweg', name: 'Hasenweg Family Cup', diff: 0, frac: [0.5, 0.9], seed: 27 },
    ],
  },
};

function buildPeaks() {
  for (const m of MASSIFS) {
    const def = PEAKS[m.id];
    if (!def) continue;
    // face frame -> world
    const P = (u, v) => [m.top.x + m.fx * u - m.fz * v, m.top.z + m.fz * u + m.fx * v];
    const lift = addLift({ type: 'gondola', name: def.lift, price: def.price, peak: m.id, topName: `${m.name} summit`, bottomName: def.base ? 'Legacy Village' : `${m.name} base`,
      bottom: def.base ? { ...def.base } : { x: m.base.x, z: m.base.z }, top: { x: m.top.x, z: m.top.z }, bottomPadDrop: m.apron && !def.base ? 1.5 : 0, village: !!def.base });
    // the mid-station first; the piste that serves it is routed past its exit (v > 0: the stair side is -sideV).
    // It keeps its place on the face when the base stands in the village (placed on the line from the face's
    // foot, then set on the lift's own line)
    const viaSide = def.pistes.find((d) => d.viaMid)?.side || 1;
    if (def.base) {
      const ref = { bottom: m.base, top: m.top, dir: [-m.fx, -m.fz], length: m.faceLen };
      const at = midSpot(ref);
      const u = (at.x - lift.bottom.x) * lift.dir[0] + (at.z - lift.bottom.z) * lift.dir[1];
      setMid(lift, { u, x: lift.bottom.x + lift.dir[0] * u, z: lift.bottom.z + lift.dir[1] * u }, -viaSide);
    } else placeMid(lift, -viaSide);
    const [mu] = faceUV(m, lift.mid.x, lift.mid.z);

    // summit restaurant beside the top station, its sun terrace facing south
    const [hx, hz] = P(def.hut.u, def.hut.v);
    const hut = { x: hx, z: hz, name: def.hut.name, label: `${m.name} · ${def.hut.name}`, yaw: 0, peak: m.id };
    world.addPad({ x: hx, z: hz, r: 20, blend: 24 });
    layout.huts.push(hut);
    // ski patrol hut on the other side of the station
    const [px, pz] = P(def.patrol.u, def.patrol.v);
    world.addPad({ x: px, z: pz, r: 6, blend: 10 });

    const pistes = [], routed = new Map(), avoid = [];
    for (const [i, d] of def.pistes.entries()) {
      const [gMin, gMax] = BAND[d.diff];
      const via = d.viaMid ? [mu, d.side * 45] : null;
      let pts = routePiste(m, d.start, [m.faceLen + d.end[0], d.end[1]], { gMin, gMax, side: d.side, avoid, via });
      routed.set(d.name, pts);
      avoid.push({ pts });
      if (d.drop) continue; // (routed so the others keep their lines; never laid out)
      if (def.base) pts = [...pts, ...runOut(pts, lift, villageLat(pts, lift))];
      pistes.push(addPiste(d.name, d.diff, pts, { peak: m.id, number: def.number + i }));
    }
    // the races along the pistes (measured on them as routed on the face, without the run-out to a village
    // base), the ski lane, then the races by the gondola stops (they keep clear of the lane and the others)
    const race = (r) => {
      if (!RESORT_RACES) return;
      const piste = pistes.find((p) => p.name === r.piste), hw = r.arena ? PISTE_WIDTH[piste.diff] + 5 : RACE_HW[r.diff];
      const pts = r.stop ? fromStop(routed.get(r.piste), stopExit(lift, r.stop), { ...r, hw }) : stretch(routed.get(r.piste), r);
      if (pathLength(pts) < 300) { console.warn(`${r.name}: no room for the course`); return; }
      buildRace(r.name, r.diff, pts, r.seed, {
        main: true, peak: m.id, arena: !!r.arena, ...(r.arena ? { halfWidth: hw } : {}), ...(r.stop ? { stop: r.stop, startWindow: 4 } : {}),
      });
    };
    for (const r of def.races) if (!r.stop) race(r);
    if (LANES_ON && LANES[m.id]) pistes.push(buildLane(m, LANES[m.id], lift));
    for (const r of def.races) if (r.stop) race(r);
    layout.peaks.push({ id: m.id, name: m.name, lift, hut, pistes, patrol: { x: px, z: pz }, summit: { x: m.hx, z: m.hz } });
    m.grid = null; // the routing grid is only needed while laying out
  }
  // a groomed connection from the Sonnenkopf base across the valley floor to the Valley Chair
  const valleyChair = layout.lifts.find((l) => l.name === 'Valley Chair');
  if (valleyChair) world.addCorridor([[MASSIFS[2].base.x - 40, MASSIFS[2].base.z + 10], [valleyChair.bottom.x + 20, valleyChair.bottom.z]], 10, 'piste');
}

// where a piste's run-out to a village base arrives beside the station: half its end's offset from the line
function villageLat(pts, lift) {
  const [ux, uz] = lift.dir, [x, z] = pts.at(-1);
  return clamp(((x - lift.bottom.x) * -uz + (z - lift.bottom.z) * ux) * 0.5, -14, 14);
}

// ---------- ski lanes ----------
// A ski lane is a wide groomed run (a red: 32 m) lined with safety nets on both sides over its whole length,
// like a World Cup downhill without gates or timing: it leaves a gondola stop and runs down to the village
// edge or a base station, always descending. The piste router lays it out in its grade band with long,
// flowing turns, keeping off every other run and lift line (it crosses one square where it has to, and its
// nets open there). It is a piste (lane: true: groomed, tree-free, on the maps, skied by the locals) and is
// listed in layout.lanes; planNets fences it, resortdressing.js puts up the SKI LANE banner over its entry.
const LANE_DIFF = 2;
// start / end in the face frame: the entry beside the riders' exit at the stop it leaves (from), the end
// above the village / the face's foot (a lane to a village base then runs out over the apron to it)
const LANES = {
  legacy: { name: 'Legacy Lane', number: 4, from: 'mid', start: [1010, 40], end: [1935, 45] },
  silberhorn: { name: 'Silberhorn Lane', number: 24, from: 'mid', start: [1300, 50], end: [2045, 70] },
};

// Open up any turn tighter than rMin (radius through points 16 m either side): the line is smoothed locally
// there until it flows (a 32 m wide lane between nets has no hairpins).
function easeTurns(pts, rMin) {
  let p = resample(pts, 8);
  p.push(pts.at(-1));
  const radius = (a, b, c) => {
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cr = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    return cr < 1e-6 ? Infinity : (ab * bc * ca) / (2 * cr);
  };
  for (let it = 0; it < 80; it++) {
    const tight = new Uint8Array(p.length);
    let any = false;
    for (let i = 2; i < p.length - 2; i++) if (radius(p[i - 2], p[i], p[i + 2]) < rMin) { any = true; for (let k = Math.max(1, i - 3); k <= Math.min(p.length - 2, i + 3); k++) tight[k] = 1; }
    if (!any) break;
    p = p.map((v, i) => (tight[i] ? [(p[i - 1][0] + v[0] * 2 + p[i + 1][0]) / 4, (p[i - 1][1] + v[1] * 2 + p[i + 1][1]) / 4] : v));
  }
  return p;
}

function buildLane(m, def, lift) {
  const [gMin, gMax] = BAND[LANE_DIFF], w = PISTE_WIDTH[LANE_DIFF];
  const line = (l) => { const n = Math.ceil(l.length / 10); return Array.from({ length: n + 1 }, (_, i) => [l.bottom.x + (l.top.x - l.bottom.x) * i / n, l.bottom.z + (l.top.z - l.bottom.z) * i / n]); };
  const runs = [
    ...layout.pistes.map((p) => ({ pts: p.pts, w: PISTE_WIDTH[p.diff] })),
    ...layout.races.map((r) => ({ pts: r.path, w: r.halfWidth })),
  ];
  const lines = layout.lifts.map((l) => ({ pts: line(l), w: 6 }));
  // it keeps away from the buildings, stations and flattened pads (race starts, station terraces)
  const blocked = [
    ...VILLAGE_BUILDINGS.map(([x, z]) => [x, z, 48]), ...layout.huts.map((h) => [h.x, h.z, 36]),
    ...layout.lifts.flatMap((l) => [[l.bottom.x, l.bottom.z, 40], [l.top.x, l.top.z, 40], ...(l.mid ? [[l.mid.x, l.mid.z, 26]] : [])]),
    ...world.pads.map((pd) => [pd.x, pd.z, pd.r + 12]),
  ];
  let pts = easeTurns(routePiste(m, def.start, def.end, { gMin, gMax, avoid: runs, occupy: [...runs, ...lines], selfW: w, occCost: 12, turnCost: 16, steepCost: 60, blocked }), 45);
  if (cutAtClimb(pts, 1.5).length < pts.length) console.warn(`${def.name} climbs on its way down`); // (the router keeps it falling)
  let runOutAt = Infinity;
  if (lift.village) { runOutAt = pathLength(pts); pts = [...pts, ...runOut(pts, lift, villageLat(pts, lift))]; }
  const lane = addPiste(def.name, LANE_DIFF, pts, { peak: m.id, number: def.number, lane: true, from: def.from, lift: lift.id, runOutAt });
  layout.lanes.push(lane);
  return lane;
}

// ---------- the Legacy Valley Classic: a long valley downhill with a gondola back up ----------
function buildValleyRaces() {
  const sz = 1830, sx = valleyCenter(sz);
  const goalZ = 4300;
  const { pts } = tracePath(sx, sz, { step: 6, maxLen: 2700, maxSlope: 0.5, wiggle: 0.28, phase: 0.4, stopFlat: false,
    initDir: [0, 1], goal: [valleyCenter(goalZ), goalZ], goalWeight: 0.55 });
  // (a plain blue piste now, no race: the open world keeps a handful of races on the main runs)
  const path = resample(smoothPts(pts, 4), 4), w = PISTE_WIDTH[1];
  const race = { path, start: { x: path[0][0], z: path[0][1] }, finish: { x: path.at(-1)[0], z: path.at(-1)[1] }, halfWidth: w };
  addPiste('Valley Classic', 1, path, { number: 6, valley: true });
  // the Valley Gondola runs beside the run, from below its end back up to its start
  const ex = race.start.x - race.finish.x, ez = race.start.z - race.finish.z, el = Math.hypot(ex, ez) || 1;
  const [rp, rn] = lateralReach(race.path, race.finish.x, race.finish.z, race.start.x, race.start.z);
  const side = rp <= rn ? 1 : -1, off = Math.min(rp, rn) + race.halfWidth + 26;
  const ox = (-ez / el) * off * side, oz = (ex / el) * off * side; // to the side of the course
  const lift = addLift({ type: 'gondola', name: 'Valley Gondola', price: 30, valley: true, topName: 'the upper valley', bottomName: 'the lower valley',
    bottom: { x: race.finish.x + ox + (ex / el) * 10, z: race.finish.z + oz + (ez / el) * 10 },
    top: { x: race.start.x + ox - (ex / el) * 20, z: race.start.z + oz - (ez / el) * 20 } });
}

// ---------- gondola mid-stations ----------
// A gondola longer than 1.5 km stops at a mid-station 40-55% of the way up, on the gentlest ground there.
// The resort's mountains get theirs before their pistes are laid out (a piste is then routed past its
// exit); later gondolas pick a spot beside a run that passes the line. The station sits on its own groomed
// terrace; lifts.js builds it, slows the cabins through it and lets riders get off / on there.
// side: which side of the line (+1 = lifts.js sideV) the station's stair and exit face.
const MID_NAMES = { 'Legacy Gondola': 'Legacy Mid-Station', 'Adlerhorn Gondola': 'Adlerhorn Mid-Station', 'Silberhorn Gondola': 'Silberhorn Mid-Station', 'Sonnenkopf Gondola': 'Sonnenkopf Mid-Station', 'Valley Gondola': 'Valley Mid-Station' };

function midSpot(lift) {
  const L = lift.length, [fx, fz] = lift.dir;
  let best = null;
  for (let u = 0.4 * L; u <= 0.55 * L; u += 8) {
    const x = lift.bottom.x + fx * u, z = lift.bottom.z + fz * u;
    const [gx, gz] = world.gradient(x, z, true, 10);
    const cost = Math.hypot(gx, gz) * 70 + Math.abs(u / L - 0.47) * 40;
    if (!best || cost < best.cost) best = { u, x, z, cost };
  }
  return best;
}
function placeMid(lift, side) { setMid(lift, midSpot(lift), side); }
function setMid(lift, at, side) {
  const pad = world.addPad({ x: at.x, z: at.z, r: 15, blend: 22 });
  groomedPad(pad, lift.dir);
  lift.mid = { u: at.u, x: at.x, z: at.z, y: pad.h, name: MID_NAMES[lift.name] || `${lift.name.replace(/ Gondola$/, '')} Mid-Station`, side };
  lift.towers = liftTowers(lift);
}

function planMidStations() {
  const runs = [
    ...layout.pistes.map((p) => ({ pts: p.pts, w: PISTE_WIDTH[p.diff] })),
    ...layout.races.map((r) => ({ pts: r.path, w: r.halfWidth })),
  ];
  for (const lift of layout.lifts) {
    if (lift.type !== 'gondola' || lift.length < 1500 || lift.mid) continue;
    const L = lift.length, [fx, fz] = lift.dir;
    // run segments near the middle part of the line
    const cx = lift.bottom.x + fx * L * 0.47, cz = lift.bottom.z + fz * L * 0.47, reach = L * 0.1 + 260;
    const segs = [];
    for (const r of runs) for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      if (Math.abs(a[0] - cx) < reach && Math.abs(a[1] - cz) < reach) segs.push(a[0], a[1], b[0], b[1], r.w);
    }
    let best = null;
    for (let u = 0.4 * L; u <= 0.55 * L; u += 8) {
      const x = lift.bottom.x + fx * u, z = lift.bottom.z + fz * u;
      // the nearest run: its edge must pass close by (a short walk), but not through the station
      let edge = Infinity, side = 1;
      for (let k = 0; k < segs.length; k += 5) {
        const d = segDist(x, z, segs[k], segs[k + 1], segs[k + 2], segs[k + 3]) - segs[k + 4];
        if (d < edge) { edge = d; side = (segs[k] - x) * -fz + (segs[k + 1] - z) * fx >= 0 ? 1 : -1; }
      }
      if (edge < 14) continue;
      const [gx, gz] = world.gradient(x, z, false, 10);
      const cost = Math.hypot(gx, gz) * 70 + Math.max(0, edge - 30) * 0.8 + Math.abs(u / L - 0.47) * 40;
      if (!best || cost < best.cost) best = { u, x, z, side, cost };
    }
    if (best) setMid(lift, best, best.side);
  }
}

// Lift towers keep out of the runs: a tower that would stand on (or within 9 m of) a run moves along its
// section of the line to the nearest clear spot (never closer than 60 m to another tower of a gondola, 30 m
// of a chairlift: towers don't bunch up); one that can't, or stands within 6 m of a run's edge, gets crash
// padding (lifts.js builds it).
function placeTowers() {
  const runs = [
    ...layout.pistes.map((p) => ({ pts: p.pts, w: PISTE_WIDTH[p.diff] })),
    ...layout.races.map((r) => ({ pts: r.path, w: r.halfWidth })),
  ];
  const clearance = (x, z) => {
    let c = Infinity;
    for (const r of runs) for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      if (Math.abs(a[0] - x) > r.w + 60 || Math.abs(a[1] - z) > r.w + 60) continue;
      c = Math.min(c, segDist(x, z, a[0], a[1], b[0], b[1]) - r.w);
    }
    return c;
  };
  for (const l of layout.lifts) {
    const cuts = [0, ...(l.mid ? [l.mid.u] : []), l.length], gap = l.type === 'gondola' ? 60 : 30;
    for (const t of l.towers) {
      if (clearance(t.x, t.z) >= 9) continue;
      const k = cuts.findIndex((c) => c > t.u), lo = cuts[k - 1] + 40, hi = cuts[k] - 40;
      const free = (uu) => uu > lo && uu < hi && l.towers.every((o) => o === t || Math.abs(o.u - uu) >= gap) && clearance(l.bottom.x + l.dir[0] * uu, l.bottom.z + l.dir[1] * uu) >= 9;
      // (at most ~40% of a span away, so the towers stay spread along the line: one that can't move stays, padded)
      for (let d = 6; d <= Math.min(hi - lo, l.type === 'gondola' ? 96 : 46); d += 6) {
        const u = [t.u + d, t.u - d].find(free);
        if (u !== undefined) { t.u = u; t.x = l.bottom.x + l.dir[0] * u; t.z = l.bottom.z + l.dir[1] * u; break; }
      }
    }
    for (const t of l.towers) t.pad = clearance(t.x, t.z) < 6;
  }
}

// ---------- the Valley Gondola's mid-station race ----------
// Every gondola stop has a race starting a short walk from where riders step out: the mountains lay theirs
// out with their pistes (stop races), the Valley Gondola's mid-station is only placed with the other late
// mid-stations, so its race comes here: the Valley Sprint, on the far side of the line from the Valley
// Classic, from just below the station down the valley floor (traced down the fall line, kept clear of the
// line, cut before any climb).
function buildValleyMidRace() {
  return; // (no race from the Valley Mid-Station: riders ski the Valley Classic from there)
  const lift = layout.lifts.find((l) => l.valley && l.mid);
  if (!lift) return;
  const [ux, uz] = lift.dir, sx = -uz, sz = ux, away = -(lift.mid.side || 1);
  const at = (u, lat) => [lift.bottom.x + ux * u + sx * lat * away, lift.bottom.z + uz * u + sz * lat * away];
  const [x0, z0] = at(lift.mid.u - 45, 55), goal = at(140, 130);
  let { pts } = tracePath(x0, z0, { step: 6, maxLen: 1150, maxSlope: 0.3, wiggle: 0.3, phase: 2.2, stopFlat: false, initDir: [-ux, -uz], goal, goalWeight: 1.2 });
  // the course stays on its side of the line (its edge 10 m clear of the lift corridor), above the bottom station
  const off = (x, z) => ((x - lift.bottom.x) * sx + (z - lift.bottom.z) * sz) * away, along = (x, z) => (x - lift.bottom.x) * ux + (z - lift.bottom.z) * uz;
  const bad = pts.findIndex(([x, z]) => off(x, z) < 9 + 12.5 + 10 || along(x, z) < 110);
  if (bad > 0) pts = pts.slice(0, bad);
  pts = cutAtClimb(pts, 1.5);
  if (pathLength(pts) < 450) return;
  buildRace('Valley Sprint', 0, pts, 34, { main: true, stop: 'mid', startWindow: 4 });
}

// ---------- World Cup finish areas ----------
// Every arena course gets a grandstand on a flat, groomed terrace beside its finish (on whichever side has
// room), facing the finish line; resortdressing.js builds the arches, stand, timing board and boards.
function planArenas() {
  for (const r of layout.races) {
    if (!r.arena) continue;
    const n = r.path.length, [fx, fz] = r.path[n - 1], [px, pz] = r.path[Math.max(0, n - 6)];
    const dl = Math.hypot(fx - px, fz - pz) || 1, dx = (fx - px) / dl, dz = (fz - pz) / dl, rx = -dz, rz = dx;
    let best = null;
    for (const side of [1, -1]) for (const back of [10, 24, -6]) {
      const off = r.halfWidth + 17;
      const x = fx + rx * off * side - dx * back, z = fz + rz * off * side - dz * back;
      // room for a 22 m stand: clear of other runs, lifts, stations and the village
      let clear = Infinity;
      for (let k = -2; k <= 2; k++) {
        const qx = x + dx * k * 5.5, qz = z + dz * k * 5.5;
        const c = world.corridorAt(qx, qz);
        clear = Math.min(clear, c.d);
        for (const [bx, bz] of VILLAGE_BUILDINGS) clear = Math.min(clear, Math.hypot(qx - bx, qz - bz) - 30);
      }
      const [gx, gz] = world.gradient(x, z, false, 8);
      const cost = Math.hypot(gx, gz) * 40 - Math.min(clear, 20);
      if (clear > 6 && (!best || cost < best.cost)) best = { x, z, side, cost };
    }
    if (!best) continue;
    const pad = world.addPad({ x: best.x, z: best.z, r: 13, blend: 16 });
    groomedPad(pad, [dx, dz]);
    // the stand faces the course: toward the finish line, across the run
    r.arenaPlan = { stand: { x: best.x, z: best.z, yaw: Math.atan2(-rx * best.side, -rz * best.side) }, side: best.side };
  }
}

// ---------- no rock bands on or near the resort's runs ----------
// Distance from every node of an 8 m grid to the nearest piste / race course edge, handed to the terrain
// once, before any terrain is built (the runs themselves were laid out on the full terrain). Pads already
// placed follow the change under them.
function setCragMask() {
  const runs = [
    ...layout.pistes.map((p) => ({ pts: p.pts, w: PISTE_WIDTH[p.diff] })),
    ...layout.races.map((r) => ({ pts: r.path.filter((_, i) => i % 2 === 0 || i === r.path.length - 1), w: r.halfWidth })),
    ...(layout.bowls || []).map((b) => ({ pts: b.pts, w: b.w })), // the freeride bowls (sectors.js)
  ];
  const R = 56, cell = 10;
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const r of runs) for (const [x, z] of r.pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
  minx -= R + 40; minz -= R + 40; maxx += R + 40; maxz += R + 40;
  const nx = Math.ceil((maxx - minx) / cell) + 1, nz = Math.ceil((maxz - minz) / cell) + 1;
  const d = new Float32Array(nx * nz).fill(R);
  for (const r of runs) {
    for (let k = 1; k < r.pts.length; k++) {
      const ax = r.pts[k - 1][0], az = r.pts[k - 1][1], bx = r.pts[k][0], bz = r.pts[k][1], reach = r.w + R;
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - minx) / cell)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + reach - minx) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - minz) / cell)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + reach - minz) / cell));
      for (let j = j0; j <= j1; j++) {
        const pz = minz + j * cell - az;
        for (let i = i0; i <= i1; i++) {
          const px = minx + i * cell - ax;
          let t = (px * ex + pz * ez) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = px - ex * t, qz = pz - ez * t;
          const v = Math.sqrt(qx * qx + qz * qz) - r.w, q = j * nx + i;
          if (v < d[q]) d[q] = v < 0 ? 0 : v;
        }
      }
    }
  }
  const before = world.pads.map((p) => world.baseHeight(p.x, p.z));
  world.setCragMask({ x0: minx, z0: minz, cell, nx, nz, d });
  world.pads.forEach((p, i) => { const dh = world.baseHeight(p.x, p.z) - before[i]; if (Math.abs(dh) > 0.005) p.h += dh; });
}

// ---------- Legacy Park (terrain park on the upper Legacy Valley; meshes in park.js) ----------
// The park runs straight down the valley's fall line from its drop-in at PARK_P0.
const PARK_P0 = { x: -265, z: 340 };
const PARK_LENGTH = 520;   // m from the drop-in to the outrun
const PARK_HALF_W = 17;    // groomed half-width; the fences stand just outside

// Features: s = distance below the drop-in (m), lat = offset across the park (+ = right, looking downhill).
// Kickers sit where the valley steepens (~15 deg) so their landings fall away under the skier.
const PARK_FEATURES = [
  // jump line: S / M / L kickers, then a tabletop
  { line: 'jump', type: 'kicker', s: 62, lat: -5, height: 1.0, lip: 24, width: 4.5, size: 'S' },
  { line: 'jump', type: 'kicker', s: 135, lat: -5, height: 1.5, lip: 27, width: 5.5, size: 'M' },
  { line: 'jump', type: 'kicker', s: 218, lat: -5, height: 2.2, lip: 30, width: 6.5, size: 'L' },
  { line: 'jump', type: 'tabletop', s: 305, lat: -5, height: 1.6, lip: 26, width: 7, deckLength: 8 },
  // roller line: small rollers, a mini tabletop, bigger rollers
  { line: 'roll', type: 'roller', s: 48, lat: 10, height: 0.75, width: 5 },
  { line: 'roll', type: 'roller', s: 70, lat: 10, height: 0.8, width: 5 },
  { line: 'roll', type: 'roller', s: 92, lat: 10, height: 0.85, width: 5 },
  { line: 'roll', type: 'roller', s: 114, lat: 10, height: 0.9, width: 5 },
  { line: 'roll', type: 'tabletop', s: 160, lat: 10, height: 1.0, lip: 24, width: 6, deckLength: 5 },
  { line: 'roll', type: 'roller', s: 215, lat: 10, height: 1.0, width: 5.5 },
  { line: 'roll', type: 'roller', s: 241, lat: 10, height: 1.05, width: 5.5 },
  { line: 'roll', type: 'roller', s: 267, lat: 10, height: 1.1, width: 5.5 },
  // both lines meet for a final wave of big rollers above the outrun
  { line: 'finish', type: 'roller', s: 372, lat: 0, height: 1.2, width: 9, length: 12 },
  { line: 'finish', type: 'roller', s: 402, lat: 0, height: 1.25, width: 9, length: 12 },
  { line: 'finish', type: 'roller', s: 432, lat: 0, height: 1.3, width: 9, length: 12 },
];

// Lay out the park: its frame down the fall line, feature positions, groomed corridor, drop-in
// platform and the Park Lift beside it (registered in initLayout, before terrain near it is built).
function planPark() {
  // straight down the average fall line of the valley floor
  let gx = 0, gz = 0;
  for (let s = 0; s <= PARK_LENGTH; s += 20) {
    const g = world.gradient(PARK_P0.x, PARK_P0.z + s, true, 6);
    gx += g[0]; gz += g[1];
  }
  const heading = Math.atan2(-gx, -gz);
  const fx = Math.sin(heading), fz = Math.cos(heading); // downhill
  const rx = -fz, rz = fx;                              // right, looking downhill
  const at = (s, lat) => ({ x: PARK_P0.x + fx * s + rx * lat, z: PARK_P0.z + fz * s + rz * lat });

  const line = [];
  for (let s = -24; s <= PARK_LENGTH + 10; s += 16) { const p = at(s, 0); line.push([p.x, p.z]); }
  world.addCorridor(line, PARK_HALF_W, 'piste', { name: 'Legacy Park', park: true });
  // tree-free strips just outside the fences (park.js stands them 1.2 m beyond the groomed edge)
  for (const side of [-1, 1]) {
    const strip = [];
    for (let s = 4; s <= PARK_LENGTH - 12; s += 16) { const p = at(s, side * (PARK_HALF_W + 2.8)); strip.push([p.x, p.z]); }
    world.addCorridor(strip, 1.6, 'lift');
  }
  // drop-in platform: flat snow to stop, strap in and pick a line
  const drop = at(-14, 0);
  world.addPad({ x: drop.x, z: drop.z, r: 9, blend: 12 });

  const features = PARK_FEATURES.map((f) => ({ ...f, ...at(f.s, f.lat), heading }));
  const bottom = at(PARK_LENGTH + 6, PARK_HALF_W + 21), top = at(-18, PARK_HALF_W + 21);
  return {
    name: 'Legacy Park', heading, fx, fz, rx, rz, at, length: PARK_LENGTH, halfWidth: PARK_HALF_W, line, features,
    drop: { ...drop, r: 9 },
    lift: { type: 'chair', name: 'Park Lift', price: 15, bottom: { x: bottom.x, z: bottom.z }, top: { x: top.x, z: top.z } },
  };
}

// registered at layout time, before any terrain near the park is generated; park.js builds the meshes
function buildPark() {
  const park = planPark();
  park.liftRef = addLift({ ...park.lift, park: true });
  // a groomed way down from the village's south-west edge to the drop-in
  world.addCorridor([[-150, 165], [-215, 245], [park.drop.x + 4, park.drop.z - 10]], 7, 'piste');
  layout.park = park;
}

// ---------- snow cannons (village.js builds them beside the pistes; others keep clear of them) ----------
export function cannonSpots() {
  const spots = [];
  for (const piste of layout.pistes) {
    if (piste.lane) continue; // a lane is lined with nets
    for (let i = 20; i < piste.pts.length - 10; i += 28) {
      const [ax, az] = piste.pts[i], [bx, bz] = piste.pts[i + 1];
      const l = Math.hypot(bx - ax, bz - az) || 1, w = PISTE_WIDTH[piste.diff] + 3;
      spots.push([ax - ((bz - az) / l) * w, az + ((bx - ax) / l) * w]);
    }
  }
  return spots;
}

// ---------- safety nets ----------
// Where a run borders a real hazard, a run of net stands just outside its groomed edge (1.2 m beyond it)
// on the hazard side: an orange B-net (posts every ~3.5 m) along drops steeper than ~32 deg, gullies and
// the outside of fast bends; a tall red A-net (posts every ~5 m) along cliffs and very steep drop-offs.
// The World Cup courses (race.arena) and the ski lanes are fenced with B-nets on both sides over their whole
// length, with a second row of A-nets further out wherever they have a hazard. Every run gets 16 m of run-in
// and run-out, gaps under 15 m are closed, runs under 25 m dropped, and runs break before lift lines, other
// runs and paths, stations, pads, snow cannons and the village (a lane's nets pass under lift lines, clear of
// the towers, and end where it runs out into the village). Each run gets a narrow tree-free strip.
// layout.nets: [{ type: 'B' | 'A', line: [[x, z, nx, nz]...] (every 2 m; n = unit vector toward the run),
//   owner: name of the piste / race / lane, arena, lane, row, side (+1 = right of the run, looking down) }]
const NET_STEP = 2;     // m between net line samples
const NET_OFF = 1.2;    // m beyond the groomed edge
function planNets() {
  const corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
  const cannons = cannonSpots();
  const stations = [];
  for (const l of layout.lifts) {
    stations.push([l.bottom.x, l.bottom.z, 70], [l.top.x, l.top.z, 75]);
    if (l.mid) stations.push([l.mid.x, l.mid.z, 50]);
  }
  for (const h of layout.huts) stations.push([h.x, h.z, 50]);
  const H = (x, z) => world.height(x, z);
  const towers = layout.lifts.flatMap((l) => l.towers);
  // is a net point off-limits (another run or path, a lift line, a station, a pad, a cannon, the village)?
  const blockedAt = (x, z, ownW) => {
    if (Math.hypot(x, z) < 300) return true;
    world.corridorAt(x, z, corr);
    if (corr.d < ownW) return true; // inside / at the edge of some other corridor (the own run is NET_OFF away)
    for (const [sx, sz, r] of stations) if (Math.abs(sx - x) < r && Math.abs(sz - z) < r && Math.hypot(sx - x, sz - z) < r) return true;
    for (const [cx, cz] of cannons) if (Math.abs(cx - x) < 4 && Math.abs(cz - z) < 4 && Math.hypot(cx - x, cz - z) < 4) return true;
    return world.padInfluence(x, z) > 0.05;
  };
  // the same for a ski lane's nets: lift lines don't count (the nets pass under them, clear of the towers),
  // nor does the lane itself; they keep a tighter berth to stations (just their access), stand on the outer
  // slope of a pad's embankment, and end at the village plateau. (A pad's groomed apron is a short, wide
  // corridor without a run: its pad decides.)
  const laneStations = [];
  for (const l of layout.lifts) {
    const g = l.type === 'gondola';
    laneStations.push([l.bottom.x, l.bottom.z, g ? 55 : 28], [l.top.x, l.top.z, g ? 60 : 28]);
    if (l.mid) laneStations.push([l.mid.x, l.mid.z, 40]);
  }
  for (const h of layout.huts) laneStations.push([h.x, h.z, 40]);
  const laneBlockedAt = (x, z, lane) => {
    if (Math.hypot(x, z) < 175) return true;
    const segs = world.corridorGrid.get(Math.floor(x / 64) + ',' + Math.floor(z / 64)) || [];
    for (const s of segs) {
      if (s.meta === lane || s.kind === 'lift' || (!s.meta && Math.hypot(s.bx - s.ax, s.bz - s.az) < 2.5)) continue;
      if (segDist(x, z, s.ax, s.az, s.bx, s.bz) - s.w < 0.6) return true;
    }
    for (const t of towers) if (Math.abs(t.x - x) < 7 && Math.abs(t.z - z) < 7 && Math.hypot(t.x - x, t.z - z) < 7) return true;
    for (const [sx, sz, r] of laneStations) if (Math.abs(sx - x) < r && Math.abs(sz - z) < r && Math.hypot(sx - x, sz - z) < r) return true;
    for (const [cx, cz] of cannons) if (Math.abs(cx - x) < 4 && Math.abs(cz - z) < 4 && Math.hypot(cx - x, cz - z) < 4) return true;
    return world.padInfluence(x, z) > 0.3;
  };
  // hazard class beyond the edge point (x, z), looking outward along (ox, oz): 0 none, 1 B-net, 2 A-net
  const hazard = (x, z, ox, oz) => {
    const h1 = H(x + ox, z + oz);
    let steep = 0, low = h1, lowK = 1;
    const ks = [3, 7, 13, 22], hk = [];
    for (const k of ks) {
      const h = H(x + ox * k, z + oz * k);
      hk.push(h);
      steep = Math.max(steep, (h1 - h) / (k - 1));
      if (h < low) { low = h; lowK = k; }
    }
    const drop = h1 - low;
    // another run right beyond the edge: no drop to guard there
    world.corridorAt(x + ox * 8, z + oz * 8, corr);
    if (corr.groomed && corr.d < 0) return 0;
    if ((steep > 1.0 && drop > 9) || drop > 16) return 2;              // cliff / very steep drop-off
    if (steep > 0.62 && drop > 4) return 1;                           // steep drop (> ~32 deg)
    if (drop > 3 && lowK < 22 && hk[3] > low + 2 && drop / (lowK - 1) > 0.4) return 1; // gully
    return 0;
  };
  // samples along a run's centre line: position, direction, per side hazard + blocked flags. (smooth: the
  // direction is taken over +-smooth m, so a wide run's nets follow a smooth offset of its line instead of
  // jumping at every corner of the polyline)
  const sampleRun = (pts, w, smooth = 0) => {
    const acc = arcLengths(pts), L = acc.at(-1), out = [], hs = [];
    const back = Math.round(80 / NET_STEP);
    for (let s = 0; s <= L; s += NET_STEP) {
      const q = sampleAt(pts, acc, s);
      if (smooth) {
        const a = sampleAt(pts, acc, Math.max(0, s - smooth)), b = sampleAt(pts, acc, Math.min(L, s + smooth)), l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        q.dx = (b.x - a.x) / l; q.dz = (b.z - a.z) / l;
      }
      const rx = -q.dz, rz = q.dx; // right, looking down the run
      // fast bends: the heading change over +-24 m (> 0: turning toward the right) and the grade feeding it
      const a = sampleAt(pts, acc, Math.max(0, s - 24)), b = sampleAt(pts, acc, Math.min(L, s + 24));
      const turn = Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz);
      const hq = H(q.x, q.z), k0 = Math.max(0, hs.length - back);
      hs.push(hq);
      const grade = s > 20 ? (hs[k0] - hq) / (s - k0 * NET_STEP) : 0;
      const probe = out.length % 3 === 0; // hazards are probed every 6 m
      const sides = {};
      for (const side of [1, -1]) {
        const ox = rx * side, oz = rz * side;
        const hz = probe ? hazard(q.x + ox * w, q.z + oz * w, ox, oz) : -1;
        // the outside of a fast bend (radius under ~110 m): the side away from the turn's centre
        const bend = Math.abs(turn) > 0.45 && grade > 0.25 && Math.sign(turn) === -side;
        sides[side] = { hz, bend, x: q.x + ox * (w + NET_OFF), z: q.z + oz * (w + NET_OFF), nx: -ox, nz: -oz };
      }
      out.push({ s, q, sides });
    }
    // the samples between two probes are hazardous where both probes are
    for (let i = 0; i < out.length; i++) {
      if (i % 3 === 0) continue;
      const i0 = i - (i % 3), i1 = i0 + 3;
      for (const side of [1, -1]) out[i].sides[side].hz = Math.min(out[i0].sides[side].hz, out[i1]?.sides[side].hz ?? 0);
    }
    return out;
  };
  // intervals [i0, i1] (sample indices) where flag(i) holds, padded, merged and cut where blocked
  const intervals = (n, flag, blocked, pad, minLen) => {
    const on = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (flag(i)) for (let k = Math.max(0, i - pad); k <= Math.min(n - 1, i + pad); k++) on[k] = 1;
    // close gaps shorter than 15 m
    const gap = Math.round(15 / NET_STEP);
    for (let i = 0; i < n; i++) {
      if (on[i] || !i) continue;
      let j = i; while (j < n && !on[j]) j++;
      if (j < n && j - i < gap) for (let k = i; k < j; k++) on[k] = 1;
      i = j;
    }
    const res = [];
    for (let i = 0; i < n; i++) {
      if (!on[i] || blocked(i)) continue;
      let j = i; while (j + 1 < n && on[j + 1] && !blocked(j + 1)) j++;
      if ((j - i) * NET_STEP >= minLen) res.push([i, j]);
      i = j;
    }
    return res;
  };
  const emit = (samples, side, [i0, i1], type, owner, arena, row, extra = 0, lane = false) => {
    const line = [];
    for (let i = i0; i <= i1; i++) {
      const c = samples[i].sides[side];
      line.push([c.x - c.nx * extra, c.z - c.nz * extra, c.nx, c.nz]);
    }
    // a run folds back on itself on the inside of a very tight bend: keep its longest straight-going part
    // (a lane keeps every straight-going part of 20 m or more)
    const parts = [];
    let best = [0, 0], a = 0;
    for (let i = 1; i < line.length; i++) {
      const [px, pz] = line[i - 1], [x, z] = line[i];
      const qx = samples[i0 + i].q.x - samples[i0 + i - 1].q.x, qz = samples[i0 + i].q.z - samples[i0 + i - 1].q.z;
      if ((x - px) * qx + (z - pz) * qz < 0.25 * NET_STEP * Math.hypot(qx, qz)) { parts.push([a, i - 1]); a = i; }
      if (i - a > best[1] - best[0]) best = [a, i];
    }
    parts.push([a, line.length - 1]);
    for (const [p0, p1] of lane ? parts : [best]) {
      const part = line.slice(p0, p1 + 1);
      if ((part.length - 1) * NET_STEP >= 20) layout.nets.push({ type, line: part, owner, arena, lane, row, side });
    }
  };

  // hazard nets along every piste (the arena races' pistes too: their courses get fenced below; the lanes
  // are fenced whole below)
  for (const p of layout.pistes) {
    if (p.lane) continue;
    const w = PISTE_WIDTH[p.diff];
    const S = sampleRun(p.pts, w), n = S.length, pad = Math.round(16 / NET_STEP);
    for (const side of [1, -1]) {
      const blocked = (i) => S[i].s < 30 || S[i].s > S[n - 1].s - 30 || blockedAt(S[i].sides[side].x, S[i].sides[side].z, NET_OFF - 0.6);
      const A = intervals(n, (i) => S[i].sides[side].hz === 2, blocked, Math.round(10 / NET_STEP), 20);
      const inA = (i) => A.some(([a, b]) => i >= a && i <= b);
      const B = intervals(n, (i) => S[i].sides[side].hz >= 1 || S[i].sides[side].bend, (i) => blocked(i) || inA(i), pad, 25);
      for (const iv of A) emit(S, side, iv, 'A', p.name, false, 0);
      for (const iv of B) emit(S, side, iv, 'B', p.name, false, 0);
    }
  }
  // World Cup courses: B-nets both sides, all the way down; A-nets as a second row at the hazards
  for (const r of layout.races) {
    if (!r.arena) continue;
    const w = r.halfWidth;
    const S = sampleRun(r.path, w), n = S.length;
    for (const side of [1, -1]) {
      const blocked = (i) => S[i].s < 24 || S[i].s > S[n - 1].s - 20 || blockedAt(S[i].sides[side].x, S[i].sides[side].z, NET_OFF - 0.6);
      for (const iv of intervals(n, () => true, blocked, 0, 25)) emit(S, side, iv, 'B', r.name, true, 0);
      const blocked2 = (i) => blocked(i) || blockedAt(S[i].sides[side].x - S[i].sides[side].nx * 3.5, S[i].sides[side].z - S[i].sides[side].nz * 3.5, 0.6);
      for (const iv of intervals(n, (i) => S[i].sides[side].hz >= 1 || S[i].sides[side].bend, blocked2, Math.round(16 / NET_STEP), 25)) emit(S, side, iv, 'A', r.name, true, 1, 3.5);
    }
  }
  // ski lanes: B-nets both sides from 20 m below the entry to where the lane runs out into the village / onto
  // the apron, A-nets as a second row at the hazards
  for (const lane of layout.lanes) {
    const w = PISTE_WIDTH[lane.diff];
    const S = sampleRun(lane.pts, w, 6), n = S.length, end = Math.min(lane.runOutAt, S[n - 1].s);
    for (const side of [1, -1]) {
      const blocked = (i) => S[i].s < 20 || S[i].s > end - 12 || laneBlockedAt(S[i].sides[side].x, S[i].sides[side].z, lane);
      for (const iv of intervals(n, () => true, blocked, 0, 25)) emit(S, side, iv, 'B', lane.name, false, 0, 0, true);
      const blocked2 = (i) => blocked(i) || laneBlockedAt(S[i].sides[side].x - S[i].sides[side].nx * 3.5, S[i].sides[side].z - S[i].sides[side].nz * 3.5, lane);
      for (const iv of intervals(n, (i) => S[i].sides[side].hz >= 1 || S[i].sides[side].bend, blocked2, Math.round(16 / NET_STEP), 25)) emit(S, side, iv, 'A', lane.name, false, 1, 3.5, true);
    }
  }
  // drop any piste hazard run that duplicates an arena or lane fence (that course / lane runs over the piste)
  const fences = layout.nets.filter((n) => n.arena || n.lane);
  layout.nets = layout.nets.filter((n) => n.arena || n.lane || !fences.some((a) => nearLine(n.line, a.line, 6)));
  // a narrow tree-free strip just outside every net (so no trunk or branch stands in it)
  for (const net of layout.nets) {
    const strip = net.line.filter((_, i) => i % 3 === 0 || i === net.line.length - 1).map(([x, z, nx, nz]) => [x - nx * 1.6, z - nz * 1.6]);
    world.addCorridor(strip, 1.6, 'lift');
  }
}
// does most of line `a` lie within `r` metres of line `b`?
function nearLine(a, b, r) {
  let hits = 0;
  for (let i = 0; i < a.length; i += 5) {
    const [x, z] = a[i];
    let best = Infinity;
    for (let j = 1; j < b.length; j++) {
      if (Math.abs(b[j][0] - x) > r + 4 || Math.abs(b[j][1] - z) > r + 4) continue;
      best = Math.min(best, segDist(x, z, b[j - 1][0], b[j - 1][1], b[j][0], b[j][1]));
    }
    if (best < r) hits++;
  }
  return hits > Math.ceil(a.length / 5) * 0.5;
}

// ---------- ski bus stops: the village plaza + beside every gondola base out of the village ----------
function planBusStops() {
  layout.busStops.push({ x: -16, z: 46, heading: Math.PI / 2, name: 'Legacy Village' });
  for (const l of layout.lifts) {
    if (l.type !== 'gondola' || l.main || l.village || l.procedural) continue;
    // on the station's flat pad, 19 m to the side of the line (the gondola sign stands on the other side),
    // facing the station: you step off the bus looking at the gondola
    const [ux, uz] = l.dir, sx = uz, sz = -ux;
    const x = l.bottom.x + sx * 19 - ux * 6, z = l.bottom.z + sz * 19 - uz * 6;
    layout.busStops.push({ x, z, heading: Math.atan2(-sx, -sz), name: l.name, lift: l.id });
  }
}

// ---------- procedural races (the open world beyond the resort) ----------
// Two layers, deterministic and generated lazily as the world streams in:
//  - gate courses (0.4-1.1 km) in 650 m cells, each kept inside its own cell so neighbouring courses never
//    overlap, with a chairlift beside it;
//  - long downhills (2-4 km, from a summit down to the valley) in 3 km cells, each with a gondola back up.
//    The gate courses keep clear of them.
const RCELL = 650, DCELL = 3000;
// resort areas the procedural races stay away from (segment + radius)
const KEEP_OUT = [];
function keepOut(ax, az, bx, bz, r) {
  KEEP_OUT.push({ ax, az, bx, bz, r, minx: Math.min(ax, bx) - r, maxx: Math.max(ax, bx) + r, minz: Math.min(az, bz) - r, maxz: Math.max(az, bz) + r });
}
function inResortArea(x, z, margin) {
  for (const k of KEEP_OUT) {
    if (x < k.minx - margin || x > k.maxx + margin || z < k.minz - margin || z > k.maxz + margin) continue;
    if (segDist(x, z, k.ax, k.az, k.bx, k.bz) < k.r + margin) return true;
  }
  return false;
}
const inResortZone = (x, z) => Math.hypot(x / 1100, (z + 1250) / 1900) < 1.0 || Math.hypot(x, z) < 900;

// a course is acceptable: skiable all the way (no cliffs) and clear of the resort
// Cut a course before its first real climb: on skis you can't skate uphill, so every race keeps descending.
function cutAtClimb(pts, tol = 1.5, height = (x, z) => world.baseHeight(x, z)) {
  let low = Infinity, lowI = 0;
  for (let i = 0; i < pts.length; i++) {
    const h = height(pts[i][0], pts[i][1]);
    if (h < low) { low = h; lowI = i; } else if (h - low > tol) return pts.slice(0, lowI + 1);
  }
  return pts;
}

// After everything around a race is placed (its lift pads can raise the snow near the finish), move the
// finish line in front of any climb so the race never ends uphill.
function trimRaceAtClimb(race, tol = 2.5) {
  const cut = cutAtClimb(race.path, tol, (x, z) => world.height(x, z));
  if (cut.length >= race.path.length || cut.length < 40) return;
  const last = cut.length - 1;
  race.gates = race.gates.filter((g) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < race.path.length; i += 2) { const d = (race.path[i][0] - g.x) ** 2 + (race.path[i][1] - g.z) ** 2; if (d < bd) { bd = d; bi = i; } }
    return bi < last - 3;
  });
  race.path = cut;
  race.finish = { x: cut[last][0], z: cut[last][1] };
  race.length = pathLength(cut);
  race.drop = world.baseHeight(race.start.x, race.start.z) - world.baseHeight(race.finish.x, race.finish.z);
}

function courseOk(pts, margin) {
  for (let i = 5; i < pts.length; i += 5) {
    const dh = world.baseHeight(pts[i - 5][0], pts[i - 5][1]) - world.baseHeight(pts[i][0], pts[i][1]);
    if (Math.abs(dh) / 30 > 1.0) return false;
    if (inResortZone(pts[i][0], pts[i][1]) || inResortArea(pts[i][0], pts[i][1], margin)) return false;
  }
  return true;
}

// long downhill candidate of a 3 km cell (pure: the same for every caller, cached)
const downhills = new Map();
function downhillCandidate(di, dj) {
  const key = di + ',' + dj;
  if (downhills.has(key)) return downhills.get(key);
  let res = null;
  const x0 = di * DCELL, z0 = dj * DCELL, cx = x0 + DCELL / 2, cz = z0 + DCELL / 2;
  const seed = Math.floor(hash2(di, dj, 313) * 1e9), rnd = mulberry32(seed);
  if (rnd() < 0.75 && !world.regionAt(cx, cz, DCELL)) {
    // the summit: the highest of 24 spots in the cell's central part
    let best = null;
    for (let k = 0; k < 24; k++) {
      const x = x0 + DCELL * (0.18 + rnd() * 0.64), z = z0 + DCELL * (0.18 + rnd() * 0.64);
      if (inResortZone(x, z) || inResortArea(x, z, 300)) continue;
      const h = world.baseHeight(x, z);
      if (!best || h > best.h) best = { x, z, h };
    }
    const near = Math.hypot(cx, cz) < 6000;
    const diff = near ? (rnd() < 0.55 ? 1 : 2) : (rnd() < 0.5 ? 3 : 2);
    const phase = rnd() * 6;
    if (best) {
      let { pts } = tracePath(best.x, best.z, { step: 6, maxLen: 4000, maxSlope: [0.3, 0.45, 0.6, 0.78][diff], wiggle: 0.22, phase });
      const m = 140, inBox = ([x, z]) => x > x0 + m && x < x0 + DCELL - m && z > z0 + m && z < z0 + DCELL - m;
      const out = pts.findIndex((p) => !inBox(p));
      if (out > 0) pts = pts.slice(0, out);
      pts = cutAtClimb(pts, 2);
      // drop the first steep metres off the summit ridge until the line settles into its slope
      const len = pathLength(pts), end = pts.at(-1);
      const drop = best.h - world.baseHeight(end[0], end[1]);
      if (len >= 2000 && drop >= 380 && courseOk(pts, 150)) {
        const name = `${ADJ[Math.floor(rnd() * ADJ.length)]} ${diff === 3 ? 'Downhill' : diff === 2 ? 'Super-G' : 'Classic'}`;
        // the gondola back up, 45 m to the side of the course
        const ex = best.x - end[0], ez = best.z - end[1], el = Math.hypot(ex, ez) || 1;
        const [rp, rn] = lateralReach(pts, end[0], end[1], best.x, best.z), side = rp <= rn ? 1 : -1, off = Math.min(rp, rn) + 17.5 + 28;
        const ox = (-ez / el) * off * side, oz = (ex / el) * off * side;
        const lift = { bottom: { x: end[0] + ox, z: end[1] + oz }, top: { x: best.x + ox - (ex / el) * 25, z: best.z + oz - (ez / el) * 25 } };
        res = { pts, diff, name, seed, lift };
      }
    }
  }
  downhills.set(key, res);
  return res;
}
function genDownhill(di, dj) {
  const key = 'D' + di + ',' + dj;
  if (layout.cells.has(key)) return;
  layout.cells.set(key, true);
  const c = downhillCandidate(di, dj);
  if (!c) return;
  const race = buildRace(c.name, c.diff, c.pts, c.seed, { procedural: true, downhill: true });
  const lift = addLift({ type: 'gondola', name: `${c.name.split(' ')[0]} Gondola`, price: 30 + c.diff * 10, procedural: true, bottom: { ...c.lift.bottom }, top: { ...c.lift.top } });
  race.lift = lift.id;
  trimRaceAtClimb(race, 3);
}
// does a course (or its lift) come near a long downhill of the cells around it?
function nearDownhill(pts, x0, z0, x1, z1) {
  for (let di = Math.floor((x0 - 150) / DCELL); di <= Math.floor((x1 + 150) / DCELL); di++) {
    for (let dj = Math.floor((z0 - 150) / DCELL); dj <= Math.floor((z1 + 150) / DCELL); dj++) {
      const c = downhillCandidate(di, dj);
      if (!c) continue;
      const lines = [c.pts, [[c.lift.bottom.x, c.lift.bottom.z], [c.lift.top.x, c.lift.top.z]]];
      for (const [x, z] of pts) for (const l of lines) for (let i = 1; i < l.length; i += l.length > 2 ? 3 : 1) {
        if (Math.abs(l[i][0] - x) > 400 && Math.abs(l[i - 1][0] - x) > 400) continue;
        if (segDist(x, z, l[i - 1][0], l[i - 1][1], l[i][0], l[i][1]) < 150) return true;
      }
    }
  }
  return false;
}

function genCell(ci, cj) {
  const key = ci + ',' + cj;
  if (layout.cells.has(key)) return;
  layout.cells.set(key, true);
  const x0 = ci * RCELL, z0 = cj * RCELL, cx = x0 + RCELL / 2, cz = z0 + RCELL / 2;
  if (world.regionAt(cx, cz, RCELL)) return; // purpose-built maps get no procedural races
  // skip the resort zone, the village and the resort's runs and lifts
  if (inResortZone(cx, cz) || inResortArea(cx, cz, 120)) return;
  const seed = Math.floor(hash2(ci, cj, 99) * 1e9);
  const rnd = mulberry32(seed);
  if (rnd() > 0.8) return;
  // the course and its lift stay inside this cell (35 m margin)
  const m = 35, inBox = (x, z) => x > x0 + m && x < x0 + RCELL - m && z > z0 + m && z < z0 + RCELL - m;
  // starter-friendly near the village: mostly easy and medium courses, the hard ones further out
  const near = Math.hypot(cx, cz) < 5000, pick = rnd();
  const target = DIFFICULTY[near ? (pick < 0.42 ? 0 : pick < 0.82 ? 1 : pick < 0.96 ? 2 : 3) : Math.min(3, Math.floor(pick * 4.2))];
  const gentle = target.key === 'easy' || target.key === 'medium';
  // pick a high-ish start point with a skiable slope; a course that would climb gets another try
  let best = null, pts = null, len = 0, end = null, drop = 0;
  for (let attempt = 0; attempt < 3 && !pts; attempt++) {
    best = null;
    for (let k = 0; k < 10; k++) {
      const x = x0 + m + rnd() * (RCELL - 2 * m), z = z0 + m + rnd() * (RCELL - 2 * m);
      const h = world.baseHeight(x, z);
      const [gx, gz] = world.gradient(x, z, true, 4);
      const s = Math.hypot(gx, gz);
      if (s < 0.12 || s > (gentle ? 0.4 : 0.75)) continue;
      if (!best || h > best.h) best = { x, z, h };
    }
    if (!best) continue;
    let p = tracePath(best.x, best.z, { step: 6, maxLen: Math.min(1100, target.length), maxSlope: target.maxSlope, wiggle: 0.3, phase: rnd() * 6 }).pts;
    const out = p.findIndex(([x, z]) => !inBox(x, z));
    if (out > 0) p = p.slice(0, out);
    p = cutAtClimb(p, 2.5, (x, z) => world.height(x, z)); // real snow surface (pads included); a 2.5 m bump is carried over with speed
    const l = pathLength(p), e = p[p.length - 1];
    const d = best.h - world.baseHeight(e[0], e[1]);
    if (l < Math.max(380, target.length * 0.45) || d < 50 || !courseOk(p, 100)) continue;
    pts = p; len = l; end = e; drop = d;
  }
  if (!pts) return;
  // its chairlift from the finish back up to the start, beside the course (clear of its widest wiggle), on
  // whichever side stays in the cell
  const ex = best.x - end[0], ez = best.z - end[1], el = Math.hypot(ex, ez) || 1;
  const reach = lateralReach(pts, end[0], end[1], best.x, best.z), hw = [3.5, 5.5, 7, 8.5][3] + 9;
  let lift = null;
  for (const side of rnd() < 0.5 ? [1, -1] : [-1, 1]) {
    const off = Math.max(30, reach[side > 0 ? 0 : 1] + hw + 10);
    const px = (-ez / el) * off * side, pz = (ex / el) * off * side;
    const b = { x: end[0] + px, z: end[1] + pz }, t = { x: best.x + px - (ex / el) * 15, z: best.z + pz - (ez / el) * 15 };
    if (inBox(b.x, b.z) && inBox(t.x, t.z)) { lift = { bottom: b, top: t }; break; }
  }
  if (!lift) return;
  if (nearDownhill([...pts, [lift.bottom.x, lift.bottom.z], [lift.top.x, lift.top.z]], x0, z0, x0 + RCELL, z0 + RCELL)) return;
  // difficulty is graded from what the course actually is
  const grade = drop / len;
  const gradeDiff = grade < 0.14 ? 0 : grade < 0.24 ? 1 : grade < 0.36 ? 2 : 3;
  // near the village the course keeps its gentle target (slow rivals, wide gates), at most one level easier
  const targetDiff = DIFFICULTY.indexOf(target);
  const diff = near ? Math.max(targetDiff, gradeDiff - 1) : gradeDiff;
  const name = `${ADJ[Math.floor(rnd() * ADJ.length)]} ${NOUN[Math.floor(rnd() * NOUN.length)]}`;
  const race = buildRace(name, diff, pts, seed, { procedural: true });
  const l = addLift({ type: 'chair', name: `${name.split(' ')[0]} Express`, bottom: lift.bottom, top: lift.top, price: 20 + diff * 10, procedural: true });
  race.lift = l.id;
  trimRaceAtClimb(race);
}

/** Lay out the procedural races + lifts of an area (the world calls this as terrain streams in). */
export function ensureRaceCells(minx, minz, maxx, maxz) {
  if (!PROCEDURAL_RACES) return;
  // long downhills first (each stays inside its 3 km cell), then the gate courses that keep clear of them
  for (let i = Math.floor(minx / DCELL); i <= Math.floor(maxx / DCELL); i++) {
    for (let j = Math.floor(minz / DCELL); j <= Math.floor(maxz / DCELL); j++) genDownhill(i, j);
  }
  for (let i = Math.floor(minx / RCELL); i <= Math.floor(maxx / RCELL); i++) {
    for (let j = Math.floor(minz / RCELL); j <= Math.floor(maxz / RCELL); j++) genCell(i, j);
  }
}

export function initLayout() {
  if (layout.lifts.length) return; // already laid out
  const t = layout.timings = {};
  const step = (name, fn) => { const t0 = performance.now(); fn(); t[name] = Math.round(performance.now() - t0); };
  step('mainMountain', buildMainMountain);
  step('peaks', buildPeaks);
  step('park', buildPark);
  // the Wolkenspitzbahn, the Wolkenspitze's lifts and the new gondolas / chairlifts (transport.js)
  const kit = { layout, addLift, addPiste, keepOut, routePiste, tracePath, faceUV, placeMid, BAND, PISTE_WIDTH, VILLAGE_BUILDINGS };
  step('transport', () => buildTransport(kit));
  step('sectors', () => buildSectors(kit)); // the Hirschalm + Ostkar sectors and their freeride bowls (sectors.js)
  step('cragMask', setCragMask);          // after the resort's runs exist, before any terrain is built
  step('valley', buildValleyRaces);
  step('midStations', planMidStations);
  step('valleyMidRace', buildValleyMidRace);
  step('towers', placeTowers);
  step('arenas', planArenas);
  step('nets', planNets);
  planBusStops();
  // keep procedural races off the resort: peaks (whole massif footprint), park, valley courses, every
  // piste and resort lift
  for (const m of MASSIFS) keepOut(m.hx, m.hz, m.base.x, m.base.z, 950);
  const pk = layout.park;
  keepOut(pk.line[0][0], pk.line[0][1], pk.line.at(-1)[0], pk.line.at(-1)[1], 150);
  for (const p of layout.pistes) for (let i = 10; i < p.pts.length; i += 10) keepOut(p.pts[i - 10][0], p.pts[i - 10][1], p.pts[i][0], p.pts[i][1], PISTE_WIDTH[p.diff] + 90);
  for (const r of layout.races) for (let i = 20; i < r.path.length; i += 20) keepOut(r.path[i - 20][0], r.path[i - 20][1], r.path[i][0], r.path[i][1], r.halfWidth + 90);
  for (const l of layout.lifts) keepOut(l.bottom.x, l.bottom.z, l.top.x, l.top.z, 90);
  world.featureProviders.push((minx, minz, maxx, maxz) => {
    if (maxx - minx > 1100) return; // only the near terrain lays out races + lifts (more appear as you travel)
    ensureRaceCells(minx - 400, minz - 400, maxx + 400, maxz + 400);
  });
  step('raceCells', () => ensureRaceCells(-3000, -3000, 3000, 3000));
}
