// The Legacy Express: the high-speed line to every race. A double-track ring from the village's station (above
// ground, north-west of the ski shop) out through the valleys to a stop beside each World Racing course's start and
// back. Pure data + math (no THREE, runs in Node), like railroute.js for the Wolkenspitzbahn:
//   - the plan: the control polygon (expressdata.js, planned by tools/express-route.mjs) smoothed into the centre
//     line, sampled every STEP m; the platforms are straight
//   - the profile (fitExpressProfile, once the courses' regions are registered: it reads the final ground): it
//     follows the smoothed ground at up to MAX_GRADE, level through the stations; where the ground stands well
//     above it the line is in a tunnel, where it falls well below it runs on a viaduct
//   - lookups by arc length (expressAt) and by position (expressNearest), the roadbed shaper (shapeExpressBed),
//     the speed profile (EXPRESS_PROFILE: limit, ride times)
// The ring's arc length s runs from the village hall's middle (0) east, round through the courses and back in from
// the west (LENGTH = back at the hall); every lookup wraps.
import { smoothstep, clamp, Simplex } from '../core/noise.js';
import { EXPRESS_CTRL, EXPRESS_STOP_AT, EXPRESS_COURSE_STOPS } from './expressdata.js';

export const EXPRESS_NAME = 'Legacy Express';
export const STEP = 2;            // m between centre-line samples
export const TRACK_OFF = 2.3;     // m from the centre line to each track's centre (double track)
export const MAX_GRADE = 0.25;    // (steep: a rack line like the Wolkenspitzbahn, whose spiral climbs at 24 %)
export const PLATFORM = 240;      // m of straight, level platform at every stop
// the village's station: above ground (Oct 27, the user: "not underground, put it above ground, no tunnel there"),
// its platforms east-west on the open ground north-west of the ski shop, between the village and the Panorama piste
// (the line runs west into the mountain; east it crosses the pistes' run-out at grade and dives under the village)
export const VILLAGE_STATION = { x: -190, z: -160, len: PLATFORM };
/** @deprecated (the underground village hall's entrance; kept until every user is gone) */
export const VILLAGE_ENTRANCE = { x: -190, z: -140, heading: Math.PI };

// ------------------------------------------------------------------ the plan
const SMOOTH_D = 20, SMOOTH_IT = 3000;
function buildPlan() {
  const C = EXPRESS_CTRL.slice();
  C.push(C[0]); // close the ring back at the hall
  const stopIdx = new Map(Object.entries(EXPRESS_STOP_AT).map(([id, i]) => [i, id]));
  const courseStopAt = Object.fromEntries(EXPRESS_COURSE_STOPS.map((c) => [c.id, c]));
  // resample the polygon every ~20 m, remembering where the stops fall
  let X = [], Z = [];
  const at = {};
  for (let i = 0; i < C.length - 1; i++) {
    if (stopIdx.has(i)) at[stopIdx.get(i)] = X.length;
    const [ax, az] = C[i], [bx, bz] = C[i + 1], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.round(L / SMOOTH_D));
    for (let k = 0; k < m; k++) { X.push(ax + ((bx - ax) * k) / m); Z.push(az + ((bz - az) * k) / m); }
  }
  const n = X.length;
  // straight platforms (+ a run-in either side), pinned: the village hall due east-west, the others along the chord
  const half = Math.ceil(PLATFORM / 2 / SMOOTH_D) + 3;
  const pin = new Uint8Array(n);
  for (const [id, s] of Object.entries(at)) {
    let dx, dz;
    if (id === 'village') { dx = 1; dz = 0; X[s] = VILLAGE_STATION.x; Z[s] = VILLAGE_STATION.z; }
    else {
      const a = (s - half - 6 + n) % n, b = (s + half + 6) % n; dx = X[b] - X[a]; dz = Z[b] - Z[a];
      // a race's station lies across from its start: the platform runs square to the way over to the start, so the
      // straight never passes under or near the start (Oct 27: the start stood on top of the tunnel at Floodlight)
      // (only where the straight along the chord would pass within 60 m of the start: elsewhere turning it would make
      // the line double back on itself)
      const c = courseStopAt[id], cl = Math.hypot(dx, dz) || 1;
      let near = Infinity;
      if (c && c.sx !== undefined) for (let k = -half; k <= half; k++) near = Math.min(near, Math.hypot(X[s] + (dx / cl) * k * SMOOTH_D - c.sx, Z[s] + (dz / cl) * k * SMOOTH_D - c.sz));
      if (near < 60) {
        let tx = -(c.sz - Z[s]), tz = c.sx - X[s];
        if (tx * dx + tz * dz < 0) { tx = -tx; tz = -tz; }
        dx = tx; dz = tz;
      }
    }
    const l = Math.hypot(dx, dz) || 1;
    for (let k = -half; k <= half; k++) {
      const i = (s + k + n) % n;
      X[i] = X[s] + (dx / l) * k * SMOOTH_D; Z[i] = Z[s] + (dz / l) * k * SMOOTH_D; pin[i] = 1;
    }
  }
  // relax the rest (a closed ring): long, easy curves
  let nx = new Float64Array(n), nz = new Float64Array(n);
  for (let it = 0; it < SMOOTH_IT; it++) {
    for (let i = 0; i < n; i++) {
      if (pin[i]) { nx[i] = X[i]; nz[i] = Z[i]; continue; }
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      nx[i] = (X[a] + X[i] * 2 + X[b]) / 4; nz[i] = (Z[a] + Z[i] * 2 + Z[b]) / 4;
    }
    [X, nx] = [nx, X]; [Z, nz] = [nz, Z];
  }
  // centre line every STEP m (Catmull-Rom through the relaxed points, resampled by arc length)
  const P = [];
  for (let i = 0; i < n; i++) {
    const p0 = (i - 1 + n) % n, p1 = i, p2 = (i + 1) % n, p3 = (i + 2) % n;
    for (let k = 0; k < 10; k++) {
      const t = k / 10, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      P.push([f(X[p0], X[p1], X[p2], X[p3]), f(Z[p0], Z[p1], Z[p2], Z[p3]), i + t]);
    }
  }
  P.push([P[0][0], P[0][1], n]);
  const out = [[P[0][0], P[0][1], 0]];
  let carry = 0;
  for (let i = 1; i < P.length; i++) {
    const [ax, az, au] = P[i - 1], [bx, bz, bu] = P[i], l = Math.hypot(bx - ax, bz - az);
    let t = STEP - carry;
    while (t <= l) { const f = t / l; out.push([ax + (bx - ax) * f, az + (bz - az) * f, au + (bu - au) * f]); t += STEP; }
    carry = l - (t - STEP);
  }
  const m = out.length;
  const L = {
    X: new Float64Array(m), Z: new Float64Array(m), Y: new Float64Array(m), S: new Float64Array(m), n: m,
    length: m * STEP, // (the last sample is STEP short of the first: the ring closes on itself)
    stations: [], tunnels: [], bridges: [], ready: false,
  };
  for (let i = 0; i < m; i++) { L.X[i] = out[i][0]; L.Z[i] = out[i][1]; L.S[i] = i * STEP; }
  // the stations by their sample (u of the relaxed point)
  const sOfU = (u) => { let b = 0, bd = Infinity; for (let i = 0; i < m; i++) { const d = Math.abs(out[i][2] - u); if (d < bd) { bd = d; b = i; } } return b * STEP; };
  const courseStop = Object.fromEntries(EXPRESS_COURSE_STOPS.map((c) => [c.id, c]));
  const order = Object.entries(at).sort((a, b) => a[1] - b[1]);
  for (const [id, u] of order) {
    const s = id === 'village' ? 0 : sOfU(u);
    const c = courseStop[id];
    L.stations.push({
      id, name: id === 'village' ? 'Legacy Village' : c.name, course: id === 'village' ? null : id,
      s, s0: s - PLATFORM / 2, s1: s + PLATFORM / 2, underground: false,
    });
  }
  return L;
}

export const EXPRESS = buildPlan();
export const LENGTH = EXPRESS.length;
/** Arc length wrapped onto the ring (0..LENGTH). */
export const wrapS = (s) => ((s % LENGTH) + LENGTH) % LENGTH;
/** Signed shortest distance along the ring from a to b (-LENGTH/2..LENGTH/2). */
export const ringDelta = (a, b) => { let d = wrapS(b - a); if (d > LENGTH / 2) d -= LENGTH; return d; };

// ------------------------------------------------------------------ lookups
const _p = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
/** Point on the centre line at arc length s (wraps): { x, y (top of rail), z, dx, dz (unit heading, +s), grade }. */
export function expressAt(s, out = _p) {
  const L = EXPRESS, n = L.n;
  const f = wrapS(s) / STEP, i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
  out.x = L.X[i] + (L.X[j] - L.X[i]) * t;
  out.z = L.Z[i] + (L.Z[j] - L.Z[i]) * t;
  out.y = L.Y[i] + (L.Y[j] - L.Y[i]) * t;
  const dx = L.X[j] - L.X[i], dz = L.Z[j] - L.Z[i], l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l; out.dz = dz / l;
  out.grade = (L.Y[j] - L.Y[i]) / l;
  out.i = i;
  return out;
}
/** Position on track `side` (+1 = right of the centre line looking along +s, -1 = left) at arc length s. */
export function trackAt(s, side, out = {}) {
  expressAt(s, _p);
  out.x = _p.x - _p.dz * TRACK_OFF * side; out.z = _p.z + _p.dx * TRACK_OFF * side; out.y = _p.y;
  out.dx = _p.dx; out.dz = _p.dz; out.grade = _p.grade;
  return out;
}
// (right of the heading (dx, dz) is (-dz, dx): x' = x - dz * off, z' = z + dx * off)

/** Is s inside span t ({ s0, s1 }; s0 < 0 for the span over the seam) by more than `margin` m? */
export const inSpanOf = (t, s, margin = 0) => { const w = wrapS(s); return (w > t.s0 + margin && w < t.s1 - margin) || (w - LENGTH > t.s0 + margin && w - LENGTH < t.s1 - margin); };
const inSpan = (list, s, margin = 0) => list.some((t) => inSpanOf(t, s, margin));
export const inExpressTunnel = (s, margin = 0) => inSpan(EXPRESS.tunnels, s, margin);
export const onExpressBridge = (s, margin = 0) => inSpan(EXPRESS.bridges, s, margin);

// spatial index: 64 m cells -> coarse chords (every 8 samples = 16 m) within the roadbed's reach
const CELL = 64, COARSE = 8, REACH = 80;
const grid = new Map();
const key = (cx, cz) => cx * 65536 + cz;
for (let i0 = 0; i0 < EXPRESS.n; i0 += COARSE) {
  const L = EXPRESS, i1 = Math.min(L.n, i0 + COARSE) % L.n;
  const minx = Math.min(L.X[i0], L.X[i1]) - REACH, maxx = Math.max(L.X[i0], L.X[i1]) + REACH;
  const minz = Math.min(L.Z[i0], L.Z[i1]) - REACH, maxz = Math.max(L.Z[i0], L.Z[i1]) + REACH;
  for (let cx = Math.floor(minx / CELL); cx <= Math.floor(maxx / CELL); cx++) {
    for (let cz = Math.floor(minz / CELL); cz <= Math.floor(maxz / CELL); cz++) {
      const k = key(cx, cz);
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(i0);
    }
  }
}
export const expressBounds = (() => {
  const L = EXPRESS;
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (let i = 0; i < L.n; i++) { minx = Math.min(minx, L.X[i]); maxx = Math.max(maxx, L.X[i]); minz = Math.min(minz, L.Z[i]); maxz = Math.max(maxz, L.Z[i]); }
  return { minx: minx - REACH, minz: minz - REACH, maxx: maxx + REACH, maxz: maxz + REACH };
})();
function segDist2(x, z, i) {
  const L = EXPRESS, j = (i + 1) % L.n, ax = L.X[i], az = L.Z[i], ex = L.X[j] - ax, ez = L.Z[j] - az;
  const l2 = ex * ex + ez * ez || 1;
  const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
  const px = ax + ex * t - x, pz = az + ez * t - z;
  return [px * px + pz * pz, t];
}
const _n = { d: 1e9, s: 0, side: 0, i: 0 };
/** Nearest point of the centre line to (x, z) within ~80 m: { d (m), s, side (+1 = right of the line), i } or null. */
export function expressNearest(x, z, out = _n) {
  const a = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!a) return null;
  const L = EXPRESS, n = L.n;
  let bc = -1, bd = Infinity;
  for (let k = 0; k < a.length; k++) {
    const i0 = a[k], i1 = (i0 + COARSE) % n;
    const ax = L.X[i0], az = L.Z[i0], ex = L.X[i1] - ax, ez = L.Z[i1] - az, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
    const px = ax + ex * t - x, pz = az + ez * t - z, d = px * px + pz * pz;
    if (d < bd) { bd = d; bc = i0; }
  }
  if (bd > REACH * REACH) return null;
  let best = Infinity, bi = bc, bt = 0;
  for (let k = -2; k < COARSE + 2; k++) {
    const i = (bc + k + n) % n;
    const [d, t] = segDist2(x, z, i);
    if (d < best) { best = d; bi = i; bt = t; }
  }
  const j = (bi + 1) % n, ex = L.X[j] - L.X[bi], ez = L.Z[j] - L.Z[bi];
  out.d = Math.sqrt(best); out.s = wrapS((bi + bt) * STEP); out.i = bi;
  out.side = ex * (z - L.Z[bi]) - ez * (x - L.X[bi]) > 0 ? -1 : 1;
  return out;
}

// ------------------------------------------------------------------ the profile
// Fitted on the final natural ground (the courses' regions shape it: call after registerFreeWorldCourses, before the
// shaper is registered). Tunnels where the ground stands more than TUNNEL_COVER m over the rail, viaducts where it
// falls more than BRIDGE_OVER m below; in between the roadbed's cuttings and embankments.
const TUNNEL_COVER = 15, BRIDGE_OVER = 12, SMOOTH_W = 150, UNDER_R = 620, STATION_FREE = 250;
const VILLAGE_C = { x: 30, z: 40 }; // (the village's middle: round it the line runs deep underground)
// `under(x, z)`: true where the line must pass deep underground (the race courses' lines, the lift lines: a tunnel
// under them, never a cutting through a race track)
export function fitExpressProfile(groundAt, { under: keepUnder = null } = {}) {
  const L = EXPRESS;
  if (L.ready) return L;
  const n = L.n, k4 = 2; // (work on every 2nd sample: 4 m)
  const m = Math.floor(n / k4);
  const g = new Float64Array(m);
  for (let i = 0; i < m; i++) g[i] = groundAt(L.X[i * k4], L.Z[i * k4]);
  // smoothed ground (a ring: the window wraps)
  const w = Math.round(SMOOTH_W / (STEP * k4));
  const Y = new Float64Array(m);
  let acc = 0;
  for (let k = -w; k <= w; k++) acc += g[(k + m) % m];
  for (let i = 0; i < m; i++) { Y[i] = acc / (2 * w + 1); acc += g[(i + w + 1) % m] - g[(i - w + m) % m]; }
  // the stations: level platforms on their ground
  const pin = new Uint8Array(m);
  for (const st of L.stations) {
    const a = Math.round(st.s0 / (STEP * k4)), b = Math.round(st.s1 / (STEP * k4));
    let sum = 0, c = 0;
    for (let i = a; i <= b; i++) { sum += g[(i + m) % m]; c++; }
    const y = sum / c;
    st.y = y;
    for (let i = a - 6; i <= b + 6; i++) { const j = (i + m) % m; Y[j] = y; pin[j] = 1; }
  }
  // under the village and round it (UNDER_R) the line stays deep in the ground: it never surfaces among the houses,
  // the lifts' bases or the Wolkenspitzbahn's valley station
  const cap = new Float64Array(m).fill(Infinity), under = new Uint8Array(m);
  for (let i = 0; i < m; i++) {
    const x = L.X[i * k4], z = L.Z[i * k4];
    // (the village's own station and its approaches stay above ground: STATION_FREE m round it)
    if (Math.hypot(x - VILLAGE_STATION.x, z - VILLAGE_STATION.z) < STATION_FREE) continue;
    if (Math.hypot(x - VILLAGE_C.x, z - VILLAGE_C.z) > UNDER_R && !keepUnder?.(x, z)) continue;
    cap[i] = g[i] - TUNNEL_COVER - 9; under[i] = 1;
  }
  // grade limit per sample: MAX_GRADE, or steeper where the climb between two stations needs it (the stops beside
  // the starts sit high on the mountains: a leg may have to gain more than MAX_GRADE allows over its length)
  const dl = new Float64Array(m).fill(STEP * k4 * MAX_GRADE);
  const S4 = L.stations.map((st) => ({ i0: Math.round(st.s1 / (STEP * k4)) + 6, i1: Math.round(st.s0 / (STEP * k4)) - 6, y: st.y }));
  for (let k = 0; k < S4.length; k++) {
    const a = S4[k], b = S4[(k + 1) % S4.length];
    const i0 = a.i0, i1 = b.i1 + (b.i1 <= a.i0 ? m : 0), need = Math.abs(b.y - a.y) / Math.max(1, (i1 - i0) * STEP * k4);
    const g = Math.max(MAX_GRADE, need * 1.12);
    for (let i = i0; i <= i1; i++) dl[(i + m) % m] = STEP * k4 * g;
  }
  // (each round: the cap, then the grade both ways round; the grade has the last word, so right beside a station the
  // line may not get as deep as the cap wants in time, but it never steps)
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < m; i++) if (!pin[i]) Y[i] = Math.min(Y[i], cap[i]);
    for (let i = 1; i <= m; i++) { const j = i % m, p = (i - 1) % m, d = dl[j]; if (!pin[j]) Y[j] = clamp(Y[j], Y[p] - d, Y[p] + d); }
    for (let i = m - 1; i >= 0; i--) { const j = i, q = (i + 1) % m, d = dl[j]; if (!pin[j]) Y[j] = clamp(Y[j], Y[q] - d, Y[q] + d); }
  }
  // vertical curves
  for (let it = 0; it < 40; it++) for (let i = 0; i < m; i++) if (!pin[i]) Y[i] = (Y[(i - 1 + m) % m] + Y[i] * 2 + Y[(i + 1) % m]) / 4;
  for (let i = 0; i < n; i++) {
    const f = i / k4, a = Math.floor(f) % m, b = (a + 1) % m, t = f - Math.floor(f);
    L.Y[i] = Y[a] + (Y[b] - Y[a]) * t;
  }
  // tunnels and viaducts: classify every 4 m, close short gaps, drop slivers
  const kind = new Int8Array(m);
  for (let i = 0; i < m; i++) { const c = g[i] - Y[i]; kind[i] = c > TUNNEL_COVER ? 1 : c < -BRIDGE_OVER ? -1 : 0; }
  for (let i = 0; i < m; i++) if (under[i]) kind[i] = 1;
  const spans = (want, gap, min) => {
    const out = [];
    let open = -1;
    for (let i = 0; i <= m; i++) {
      const on = i < m && kind[i] === want;
      if (on && open < 0) open = i;
      if (!on && open >= 0) { out.push([open * 4, i * 4]); open = -1; }
    }
    for (let k = out.length - 1; k > 0; k--) if (out[k][0] - out[k - 1][1] < gap) { out[k - 1][1] = out[k][1]; out.splice(k, 1); }
    // a span over the ring's seam (s = 0, the village hall) is one span from s0 < 0
    if (out.length > 1 && out[0][0] === 0 && out.at(-1)[1] >= m * 4) { out[0][0] = out.at(-1)[0] - L.length; out.pop(); }
    return out.filter(([a, b]) => b - a >= min).map(([s0, s1]) => ({ s0, s1 }));
  };
  L.tunnels = spans(1, 60, 80);
  L.bridges = spans(-1, 30, 24).map((b) => ({ s0: b.s0 - 8, s1: b.s1 + 8 }));
  // (no viaduct inside a tunnel's span)
  L.bridges = L.bridges.filter((b) => !L.tunnels.some((t) => b.s0 < t.s1 && b.s1 > t.s0));
  L.tunnels.forEach((t, k) => { t.name = `${EXPRESS_NAME} Tunnel ${k + 1}`; });
  L.ground = g; // (natural ground every 4 m: piers, portals)
  L.ready = true;
  buildSpeedProfile();
  return L;
}

// ------------------------------------------------------------------ roadbed shaper (world.height)
// Along the open line the ground becomes the double track's formation (7.5 m either side of the centre), then
// cuttings at ~42 deg or embankments at ~32 deg; at the portals the cut steepens into rock; inside a tunnel the
// ground keeps at least 3 m over the tube; under a viaduct the ground stays as it is.
export const BED_DROP = 0.72;   // top of rail -> formation
export const TUBE_H = 7.0;      // tunnel crown over the rail (double-track tube)
export const TUBE_W = 6.4;      // half-width of the tube's walls
export const PORTAL_IN = 3.2;
const W_BED = 7.5, CUT = 0.9, FILL = 0.62, CUT_PORTAL = 2.0, W_PORTAL = 3.0;
const CUT_NOISE = new Simplex(9133);
const _q = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
// `spacing`: the terrain mesh's vertex spacing there (world.height's; 0 = exact). A coarse far node can't show a cutting
// narrower than its grid, so there the formation widens by most of a cell: from afar the line runs in a trench you can
// see, never inside the hillside (Oct 27, the user: "some places where the train goes through a mountain").
export function shapeExpressBed(x, z, h, spacing = 0) {
  const L = EXPRESS;
  if (!L.ready) return h;
  const nn = expressNearest(x, z);
  if (!nn || nn.d > 78) return h;
  const s = nn.s;
  for (const t of L.tunnels) {
    if (inSpanOf(t, s, PORTAL_IN)) {
      const p = expressAt(s, _q);
      if (nn.d < TUBE_W + 4) return Math.max(h, p.y + TUBE_H + 3 - (nn.d > TUBE_W ? (nn.d - TUBE_W) * 1.5 : 0));
      return h;
    }
  }
  const p = expressAt(s, _q);
  const bed = p.y - BED_DROP;
  let portal = 0;
  for (const t of L.tunnels) {
    const dA = ringDelta(s, t.s0), dB = ringDelta(t.s1, s);
    if (dA >= -PORTAL_IN - 0.5 && dA < 30) portal = Math.max(portal, Math.min(1, 1 - dA / 30));
    if (dB >= -PORTAL_IN - 0.5 && dB < 30) portal = Math.max(portal, Math.min(1, 1 - dB / 30));
  }
  if (onExpressBridge(s) && h < bed - 2) return h;
  const cut = CUT + (CUT_PORTAL - CUT) * portal * portal, wb = W_BED + W_PORTAL * portal + (spacing > 3 ? spacing * 0.8 : 0);
  const w = Math.max(0, nn.d - wb);
  let top = bed + w * cut;
  if (portal > 0 && w > 0) top += CUT_NOISE.fbm(x * 0.09, z * 0.09, 3) * 3.0 * portal * Math.min(1, w / 5);
  const bottom = bed - w * FILL;
  let r = h > top ? top : h < bottom ? bottom : h;
  if (nn.d < wb) r = bed;
  return h + (r - h) * (1 - smoothstep(60, 78, nn.d));
}

// ------------------------------------------------------------------ speed profile
// The limit (m/s): 300 km/h on the open line, less through curves (tilting train: a generous lateral limit), a
// stop at every station. Ride times run round the ring in +s from the village (the other way the profile is the
// same, run backwards). EXPRESS_PROFILE: { V (per sample), T (s into a +s trip from the village, dwells
// included), loop (one full round) }.
export const VMAX = 83;          // m/s (300 km/h)
export const ACC = 1.1;          // m/s^2
export const DWELL = 30;         // s at every stop
export const EXPRESS_PROFILE = { V: null, T: null, loop: 0 };
function buildSpeedProfile() {
  const L = EXPRESS, n = L.n;
  const V = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const a = (i - 15 + n) % n, b = i % n, c = (i + 15) % n;
    const ax = L.X[a], az = L.Z[a], bx = L.X[b], bz = L.Z[b], cx = L.X[c], cz = L.Z[c];
    const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
    const cr = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
    const r = cr < 1e-6 ? 1e9 : (ab * bc * ca) / (2 * cr);
    V[i] = Math.min(VMAX, Math.sqrt(4.5 * r));
  }
  const stopI = L.stations.map((st) => Math.round(st.s / STEP));
  for (const i of stopI) V[i] = 0;
  V[n] = 0; // (back at the village)
  for (let i = 1; i <= n; i++) V[i] = Math.min(V[i], Math.sqrt(V[i - 1] * V[i - 1] + 2 * ACC * STEP));
  for (let i = n - 1; i >= 0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] * V[i + 1] + 2 * ACC * STEP));
  const T = new Float64Array(n + 1);
  const dwellAt = new Set(stopI.filter((i) => i > 0));
  for (let i = 1; i <= n; i++) T[i] = T[i - 1] + STEP / Math.max((V[i] + V[i - 1]) / 2, 0.3) + (dwellAt.has(i - 1) ? DWELL : 0);
  EXPRESS_PROFILE.V = V; EXPRESS_PROFILE.T = T; EXPRESS_PROFILE.loop = T[n] + DWELL;
}
/** Speed limit (m/s) at arc length s. */
export function expressSpeedAt(s) { const V = EXPRESS_PROFILE.V; return V ? V[Math.round(wrapS(s) / STEP)] : 0; }
/** Ride time (s, the dwells on the way included) from station a to station b going `dir` (+1 / -1) round the ring. */
export function rideTime(a, b, dir) {
  const T = EXPRESS_PROFILE.T, n = EXPRESS.n;
  const ia = Math.round(a.s / STEP), ib = Math.round(b.s / STEP);
  const fwd = (from, to) => (to >= from ? T[to] - T[from] : T[n] - T[from] + T[to] + DWELL);
  return dir > 0 ? fwd(ia, ib === 0 ? n : ib) - DWELL : fwd(ib, ia === 0 ? n : ia) - DWELL;
}
