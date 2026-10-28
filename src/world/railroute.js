// The Wolkenspitzbahn's alignment: a metre-gauge rack railway from Legacy Village up the Wolkenspitze.
// Pure data + math (no THREE, runs in Node): the centre line every STEP m with the top-of-rail height, the
// stations, tunnels and bridges, lookups by arc length or position, and the roadbed shaper world.js applies
// (cuttings and embankments along the open line, portal cuts at the tunnels).
//
// The line: Legacy Village (valley station, south-east corner of the village) -> Adlerhorn tunnel under the
// Adlerhorn's lower slopes -> the forest corridor north-east of the village -> Wolkensee (mid-station with
// the passing loop) -> up the Wolkental, the glacial trough on the Wolkenspitze's west side -> the spiral
// tunnel through the rock step under the glacier -> Wolkenplatt (top station on the glacier plateau).
import { smoothstep, clamp, Simplex } from '../core/noise.js';
const CUT_NOISE = new Simplex(4721); // breaks up the portal rock cuts (shapeRoadbed)

export const STEP = 2; // m between centre-line samples

// Control points of the centre line (x, z). The spiral is generated: from the trough head's portal the tunnel
// runs straight into the rock, winds up a helix under the plateau's west end and runs on into the top
// station's rock hall under the glacier. Everything joins tangentially (no kinks).
const SPIRAL = { portal: [2894, -3014], dir: [-0.1, -0.99], approach: 590, r: 175, turns: 1.3, leg: 560, hall: 200 };
function spiralPts() {
  const { portal, dir, approach, r, turns, leg, hall } = SPIRAL;
  const dl = Math.hypot(dir[0], dir[1]), dx = dir[0] / dl, dz = dir[1] / dl;
  const out = [];
  for (let d = 100; d <= approach; d += 100) out.push([portal[0] + dx * d, portal[1] + dz * d]);
  const ex = portal[0] + dx * approach, ez = portal[1] + dz * approach;
  // clockwise seen from above: tangent(a) = (-sin a, cos a)
  const a0 = Math.atan2(-dx, dz), cx = ex - Math.cos(a0) * r, cz = ez - Math.sin(a0) * r;
  const n = Math.ceil(turns * 24);
  for (let i = 1; i <= n; i++) { const a = a0 + (i / n) * turns * Math.PI * 2; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  const a1 = a0 + turns * Math.PI * 2, tx = -Math.sin(a1), tz = Math.cos(a1);
  const [lx, lz] = out[out.length - 1];
  for (let d = 140; d <= leg + hall; d += 140) out.push([lx + tx * d, lz + tz * d]);
  out.push([lx + tx * (leg + hall), lz + tz * (leg + hall)]);
  return { pts: out, hallFrom: out.length - Math.ceil(hall / 140) - 1 };
}
const SP = spiralPts();
const CTRL = [
  [212, 188], [262, 149], [312, 110],                              // 0-2   Legacy Village platform
  [392, 34], [460, -56],                                           // 3-4   approach cutting, Adlerhorn tunnel (south portal)
  [610, -280], [770, -500],                                        // 5-6
  [905, -662],                                                     // 7     north portal
  [1040, -815], [1170, -950],                                      // 8-9   rock cutting
  [1270, -1030], [1345, -1085], [1420, -1140],                     // 10-12 Wolkensee (passing loop)
  [1600, -1265], [1870, -1385], [2200, -1510], [2500, -1650], [2760, -1830], // 13-17 forest corridor
  [3020, -1990], [3250, -2220], [3280, -2480], [3110, -2680], [2950, -2810], // 18-22 Wolkental
  [2894, -3014],                                                   // 23    spiral tunnel portal
  ...SP.pts,                                                       // 24..  the spiral and the top station's hall
];
const LAST = CTRL.length - 1;
const HALL = 24 + SP.hallFrom; // first control point of the top station's hall

// The vertical profile (top of rail): key heights at control points, or a grade from the previous key; between
// keys linear, then smoothed into vertical curves (station platforms stay level).
const KEYS = [
  { c: 0, y: 3 }, { c: 2, y: 3 },
  { c: 4, y: 18 },
  { c: 7, y: 196 },
  { c: 9, y: 214 },
  { c: 10, y: 222 }, { c: 12, y: 222 },
  { c: 14, y: 290 }, { c: 17, y: 372 },
  { c: 23, grade: 0.238 },
  { c: HALL, y: 1366 }, { c: LAST, y: 1366 },
];
// tunnels by control point index (entry portal, exit portal)
const TUNNELS = [
  { name: 'Adlerhorn-Tunnel', a: 4, b: 7 },
  // (its portal stands `skip` m up the line from control point 23, where the step face is high enough to cover
  // the tube; the trough's carve still ends at the control point: wolkenspitze.js)
  { name: 'Wolkenspitz-Tunnel', a: 23, b: LAST, end: true, skip: 74 }, // ends in the top station's rock hall
];
// stations: platform between control points, side of the platform (+1 = right of the line looking uphill)
const STATIONS = [
  { id: 'tal', name: 'Legacy Village', a: 0, b: 2, side: -1 },
  { id: 'see', name: 'Wolkensee', a: 10, b: 12, side: 1, loop: true },
  { id: 'platt', name: 'Wolkenplatt', a: HALL, b: LAST, side: -1, underground: true },
];

// ------------------------------------------------------------------ build the line
function catmull(pts, step) {
  const P = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 1));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      P.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), i + t]);
    }
  }
  P.push([pts.at(-1)[0], pts.at(-1)[1], pts.length - 1]);
  // resample by arc length
  const out = [[P[0][0], P[0][1], P[0][2]]];
  let carry = 0;
  for (let i = 1; i < P.length; i++) {
    const [ax, az, au] = P[i - 1], [bx, bz, bu] = P[i], l = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= l) { const f = t / l; out.push([ax + (bx - ax) * f, az + (bz - az) * f, au + (bu - au) * f]); t += step; }
    carry = l - (t - step);
  }
  return out;
}

function buildLine() {
  const R = catmull(CTRL, STEP);
  const n = R.length;
  const X = new Float64Array(n), Z = new Float64Array(n), U = new Float64Array(n), Y = new Float64Array(n);
  R.forEach(([x, z, u], i) => { X[i] = x; Z[i] = z; U[i] = u; });
  const idxOf = (c) => { let b = 0; for (let i = 0; i < n; i++) if (Math.abs(U[i] - c) < Math.abs(U[b] - c)) b = i; return b; };
  const keys = [];
  for (const k of KEYS) {
    const i = idxOf(k.c);
    if (k.grade !== undefined) { const [pi, py] = keys[keys.length - 1]; keys.push([i, py + (i - pi) * STEP * k.grade]); } else keys.push([i, k.y]);
  }
  keys.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < n; i++) {
    let k = 1; while (k < keys.length - 1 && keys[k][0] < i) k++;
    const [i0, y0] = keys[k - 1], [i1, y1] = keys[k];
    Y[i] = y0 + (y1 - y0) * clamp((i - i0) / Math.max(1, i1 - i0), 0, 1);
  }
  // vertical curves: smooth the grade changes, but keep the key heights and level platforms
  const fixed = new Uint8Array(n);
  for (const st of STATIONS) for (let i = idxOf(st.a); i <= idxOf(st.b); i++) fixed[i] = 1;
  for (const [i] of keys) fixed[i] = 1;
  void fixed;
  const Y0 = Float64Array.from(Y);
  for (let it = 0; it < 60; it++) for (let i = 1; i < n - 1; i++) if (!fixed[i]) Y[i] = (Y[i - 1] + Y[i] * 2 + Y[i + 1]) / 4;
  void Y0;
  const S = Float64Array.from({ length: n }, (_, i) => i * STEP);
  const tunnels = TUNNELS.map((t) => ({ ...t, sCp: S[idxOf(t.a)], s0: S[idxOf(t.a)] + (t.skip || 0), s1: S[idxOf(t.b)] }));
  const stations = STATIONS.map((st) => ({ ...st, s0: S[idxOf(st.a)], s1: S[idxOf(st.b)] }));
  for (const st of stations) st.s = (st.s0 + st.s1) / 2;
  return { X, Z, Y, U, S, n, length: S[n - 1], tunnels, stations };
}

export const RAIL = buildLine();
export const RAIL_NAME = 'Wolkenspitzbahn';
export const GAUGE = 1.0;

// ------------------------------------------------------------------ lookups
const _p = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
/** Point on the line at arc length s: { x, y, z, dx, dz (unit heading), grade (rise / run) }. */
export function railAt(s, out = _p) {
  const L = RAIL;
  const f = clamp(s / STEP, 0, L.n - 1.0001), i = Math.floor(f), t = f - i;
  out.x = L.X[i] + (L.X[i + 1] - L.X[i]) * t;
  out.z = L.Z[i] + (L.Z[i + 1] - L.Z[i]) * t;
  out.y = L.Y[i] + (L.Y[i + 1] - L.Y[i]) * t;
  const j = Math.min(L.n - 2, Math.max(0, i)), dx = L.X[j + 1] - L.X[j], dz = L.Z[j + 1] - L.Z[j], l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l; out.dz = dz / l;
  out.grade = (L.Y[j + 1] - L.Y[j]) / l;
  out.i = i;
  return out;
}
export const inTunnel = (s, margin = 0) => RAIL.tunnels.some((t) => s > t.s0 + margin && s < t.s1 - margin);

// spatial index: 64 m cells -> coarse segments (every 8 samples = 16 m) within the roadbed's reach; a query
// finds the nearest coarse segment, then the exact point among its fine samples
const CELL = 64, COARSE = 8, REACH = 70;
const grid = new Map();
const key = (cx, cz) => cx * 65536 + cz;
for (let i0 = 0; i0 < RAIL.n - 1; i0 += COARSE) {
  const i1 = Math.min(RAIL.n - 1, i0 + COARSE);
  const minx = Math.min(RAIL.X[i0], RAIL.X[i1]) - REACH, maxx = Math.max(RAIL.X[i0], RAIL.X[i1]) + REACH;
  const minz = Math.min(RAIL.Z[i0], RAIL.Z[i1]) - REACH, maxz = Math.max(RAIL.Z[i0], RAIL.Z[i1]) + REACH;
  for (let cx = Math.floor(minx / CELL); cx <= Math.floor(maxx / CELL); cx++) {
    for (let cz = Math.floor(minz / CELL); cz <= Math.floor(maxz / CELL); cz++) {
      const k = key(cx, cz);
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(i0);
    }
  }
}
export const railBounds = (() => {
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (let i = 0; i < RAIL.n; i++) { minx = Math.min(minx, RAIL.X[i]); maxx = Math.max(maxx, RAIL.X[i]); minz = Math.min(minz, RAIL.Z[i]); maxz = Math.max(maxz, RAIL.Z[i]); }
  return { minx: minx - REACH, minz: minz - REACH, maxx: maxx + REACH, maxz: maxz + REACH };
})();
const _n = { d: 1e9, s: 0, side: 0, i: 0 };
function segDist2(x, z, i) {
  const L = RAIL, ax = L.X[i], az = L.Z[i], ex = L.X[i + 1] - ax, ez = L.Z[i + 1] - az;
  const l2 = ex * ex + ez * ez || 1;
  const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
  const px = ax + ex * t - x, pz = az + ez * t - z;
  return [px * px + pz * pz, t];
}
/** Nearest point of the line to (x, z) within ~70 m: { d (m), s, side (+1 = right of the line), i } or null. */
export function railNearest(x, z, out = _n) {
  const a = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!a) return null;
  const L = RAIL;
  // nearest coarse chord
  let bc = -1, bd = Infinity;
  for (let k = 0; k < a.length; k++) {
    const i0 = a[k], i1 = Math.min(L.n - 1, i0 + COARSE);
    const ax = L.X[i0], az = L.Z[i0], ex = L.X[i1] - ax, ez = L.Z[i1] - az, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
    const px = ax + ex * t - x, pz = az + ez * t - z, d = px * px + pz * pz;
    if (d < bd) { bd = d; bc = i0; }
  }
  if (bd > REACH * REACH) return null;
  // refine among its fine samples (and the neighbours' first ones)
  let best = Infinity, bi = bc, bt = 0;
  for (let i = Math.max(0, bc - 2); i < Math.min(L.n - 1, bc + COARSE + 2); i++) {
    const [d, t] = segDist2(x, z, i);
    if (d < best) { best = d; bi = i; bt = t; }
  }
  const ex = L.X[bi + 1] - L.X[bi], ez = L.Z[bi + 1] - L.Z[bi];
  out.d = Math.sqrt(best); out.s = (bi + bt) * STEP; out.i = bi;
  out.side = ex * (z - L.Z[bi]) - ez * (x - L.X[bi]) > 0 ? -1 : 1;
  return out;
}

// ------------------------------------------------------------------ bridges (where the line flies over a dip)
/**
 * Mark the spans where the line runs high over the natural ground (more than `over` m): viaducts. Needs the
 * natural ground height (call once at layout time, before the shaper is registered).
 */
export function planBridges(groundAt, over = 13) {
  const L = RAIL, spans = [];
  let open = -1;
  const high = new Uint8Array(L.n);
  for (let i = 0; i < L.n; i++) {
    const s = L.S[i];
    if (inTunnel(s, -2)) continue;
    high[i] = L.Y[i] - groundAt(L.X[i], L.Z[i]) > over ? 1 : 0;
  }
  // close short gaps, drop very short spans
  for (let i = 0; i < L.n; i++) {
    if (high[i] && open < 0) open = i;
    if ((!high[i] || i === L.n - 1) && open >= 0) {
      const end = high[i] ? i : i - 1;
      if ((end - open) * STEP >= 16) spans.push({ s0: L.S[Math.max(0, open - 4)], s1: L.S[Math.min(L.n - 1, end + 4)] });
      open = -1;
    }
  }
  for (let k = spans.length - 1; k > 0; k--) if (spans[k].s0 - spans[k - 1].s1 < 30) { spans[k - 1].s1 = spans[k].s1; spans.splice(k, 1); }
  L.bridges = spans;
  return spans;
}
export const onBridge = (s) => (RAIL.bridges || []).some((b) => s > b.s0 && s < b.s1);

// ------------------------------------------------------------------ roadbed shaper (world.height)
// Along the open line the ground becomes the railway's bed: a flat formation 4 m either side of the centre
// (the ballast sits on it), then a cutting rising at ~55 deg into higher ground or an embankment falling at
// ~34 deg to lower ground. Over a viaduct and inside a tunnel the ground stays as it is; at the portals the
// cutting steepens into a rock cut and runs right up to the portal face; above the first metres of a tunnel
// the ground is kept at least 3 m over the tube's crown.
export const BED_DROP = 0.72;  // top of rail -> formation
export const TUBE_H = 6.2;     // tunnel crown above the rail
export const PORTAL_IN = 3.2;  // m from a portal plane into the tunnel before the cover over the tube starts
const W_BED = 4.2, CUT = 0.9, FILL = 0.62, CUT_PORTAL = 2.0, W_PORTAL = 2.6; // (cuttings at ~42 deg: open, and the terrain texture is not smeared up a steep wall) // (at a portal the cut is wider: room for the facade)
export function shapeRoadbed(x, z, h) {
  const n = railNearest(x, z);
  if (!n || n.d > 68) return h;
  const s = n.s;
  const L = RAIL;
  // tunnels: inside, the ground stays (with a cover over the tube near the portals)
  // (the cover starts PORTAL_IN m behind the portal plane: on the terrain's 2 m mesh the rise from the cutting's floor
  // to the cover then lies wholly behind the portal, hidden from outside by the portal's dark mouth, never in front)
  for (const t of L.tunnels) {
    if (s > t.s0 + PORTAL_IN && s < t.s1 - (t.end ? -1e9 : PORTAL_IN)) {
      const p = railAt(s);
      // over the whole tube: at least 3 m of cover (the terrain never dips into the tunnel)
      if (n.d < 9) return Math.max(h, p.y + TUBE_H + 3 - (n.d > 5 ? (n.d - 5) * 1.5 : 0));
      return h;
    }
  }
  const p = railAt(s);
  const bed = p.y - BED_DROP;
  // portals: within 30 m of a portal the cutting is steep rock
  let portal = 0;
  for (const t of L.tunnels) {
    const dA = t.s0 - s, dB = t.end ? 1e9 : s - t.s1;
    if (dA >= -PORTAL_IN - 0.5 && dA < 30) portal = Math.max(portal, Math.min(1, 1 - dA / 30));
    if (dB >= -PORTAL_IN - 0.5 && dB < 30) portal = Math.max(portal, Math.min(1, 1 - dB / 30));
  }
  // (the rock cut steepens only over the last metres before the face: a steep wall on the terrain's 2 m mesh reads
  // as regular vertical ribs; its crest is broken by noise, ramping in from the bed's edge, so it looks blasted)
  const cut = CUT + (CUT_PORTAL - CUT) * portal * portal, wb = W_BED + W_PORTAL * portal;
  const w = Math.max(0, n.d - wb);
  // viaducts: the ground under them stays (their abutments sit where the embankment ends)
  if (onBridge(s) && h < bed - 2) return h;
  let top = bed + w * cut;
  if (portal > 0 && w > 0) top += CUT_NOISE.fbm(x * 0.09, z * 0.09, 3) * 3.0 * portal * Math.min(1, w / 5);
  const bottom = bed - w * FILL;
  let r = h > top ? top : h < bottom ? bottom : h;
  if (n.d < wb) r = bed;
  // fade the shaping out toward its reach so the edge never shows
  return h + (r - h) * (1 - smoothstep(52, 68, n.d));
}

// ------------------------------------------------------------------ running: speed profile, timetable, trains
// The speed limit along the line (m/s): the open corridor is quick, the rack sections slower, curves limit it
// (lateral acceleration), the trains stop at every station. The long tunnels' dark stretches go by about twice as
// fast: from each portal (and toward the top station's lit hall) the limit, the curves' lateral limit and the
// acceleration ease up over DARK_EASE m. The trip up is integrated once; the trip down runs the same profile
// backwards (same time). Two trains shuttle in opposite phase and cross on the passing loop (PASSING_LOOP): the
// dwells at the termini are set so that both meetings fall on the loop's middle (see DWELL_END).
export const DWELL_MID = 20; // s at Wolkensee
const DWELL_MIN = 40; // s at least at either terminus
// RAIL_BUFF: the whole profile sped up (limits, curve limits, acceleration / braking) for quicker trips; the trains
// still brake to a stop at every station (the profile's zeros there), the timetable and meetings follow from it
const RAIL_BUFF = 1.9;
const ACC = 0.9 * RAIL_BUFF; // m/s^2
const DARK_BOOST = 2.1, DARK_ACC = 3.4 * 1.5, DARK_EASE = 70, DARK_VMAX = 50 * 1.6; // (80 m/s: 288 km/h)
// the passing loop (railtrack.js lays its second track): between s0 and s1, `off` m to the right of the line
export const PASSING_LOOP = { s0: 3390, s1: 3690, off: 4.6, ease: 46 };
/** 0 outside .. 1 deep inside a long tunnel's dark stretch (portal to portal; the spiral's ends in the top hall). */
export function darkness(s) {
  let k = 0;
  for (const t of RAIL.tunnels) {
    const a = t.s0, b = t.end ? RAIL.stations[2].s0 - 10 : t.s1;
    if (s > a && s < b) k = Math.max(k, smoothstep(0, DARK_EASE, s - a) * smoothstep(0, DARK_EASE, b - s));
  }
  return k;
}
// the trip runs from the valley station's stop to the top station's stop (the line runs on to the buffers)
export const TRIP_S0 = RAIL.stations[0].s, TRIP_S1 = RAIL.stations[2].s;
export const PROFILE = (() => {
  const L = RAIL, n = L.n, ds = STEP;
  const rad = new Float64Array(n).fill(1e9);
  for (let i = 6; i < n - 6; i++) {
    const ax = L.X[i - 6], az = L.Z[i - 6], bx = L.X[i], bz = L.Z[i], cx = L.X[i + 6], cz = L.Z[i + 6];
    const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
    const cr = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
    rad[i] = cr < 1e-6 ? 1e9 : (ab * bc * ca) / (2 * cr);
  }
  const t2 = L.tunnels[1];
  const climb = L.stations[1].s1 + 1500; // the rack climb up the Wolkental starts here
  const V = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = L.S[i];
    let v = 30 * RAIL_BUFF;
    if (s > climb) v = 24 * RAIL_BUFF;
    if (s > t2.s0 - 30) v = 23 * RAIL_BUFF;
    const k = 1 + (DARK_BOOST - 1) * darkness(s);
    V[i] = Math.min(Math.min(v, Math.sqrt(3.2 * RAIL_BUFF * RAIL_BUFF * rad[i])) * k, DARK_VMAX);
  }
  const acc = (i) => ACC + (DARK_ACC - ACC) * darkness(L.S[i]);
  const i0 = Math.round(TRIP_S0 / ds), i1 = Math.round(TRIP_S1 / ds), iMid = Math.round(L.stations[1].s / ds);
  for (let i = 0; i <= i0; i++) V[i] = 0;
  for (let i = i1; i < n; i++) V[i] = 0;
  V[iMid] = 0;
  for (let i = 1; i < n; i++) V[i] = Math.min(V[i], Math.sqrt(V[i - 1] * V[i - 1] + 2 * acc(i) * ds));
  for (let i = n - 2; i >= 0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] * V[i + 1] + 2 * acc(i) * ds));
  // time along the trip up (s) from the valley stop, the mid-station dwell included
  const T = new Float64Array(n);
  for (let i = i0 + 1; i <= i1; i++) T[i] = T[i - 1] + ds / Math.max((V[i] + V[i - 1]) / 2, 0.25) + (i === iMid + 1 ? DWELL_MID : 0);
  for (let i = i1 + 1; i < n; i++) T[i] = T[i1];
  return { V, T, trip: T[i1], i0, i1, iMid };
})();

/** Arc length reached `t` seconds into the trip up (0..trip); the dwell at Wolkensee holds the train still. */
export function tripS(t) {
  const { T, i0, i1, iMid, V } = PROFILE;
  if (t <= 0) return i0 * STEP;
  if (t >= T[i1]) return i1 * STEP;
  let lo = i0, hi = i1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  const span = T[hi] - T[lo];
  if (lo === iMid) { // the step that holds the dwell: stand, then roll on
    const travel = STEP / Math.max((V[hi] + V[lo]) / 2, 0.25);
    return (lo + clamp((t - T[lo] - (span - travel)) / travel, 0, 1)) * STEP;
  }
  return (lo + (span > 0 ? (t - T[lo]) / span : 0)) * STEP;
}
/** Speed (m/s) at arc length s on the profile. */
export function speedAt(s) { const i = Math.round(clamp(s / STEP, 0, RAIL.n - 1)); return PROFILE.V[i]; }

// The timetable cycle: up trip, dwell at the top (DWELL_END), down trip, dwell at the bottom (DWELL_BOT). The two
// trains run half a cycle apart; they meet where the up train is at time (2T + DWELL_END - CYCLE / 2) / 2 and again
// at (CYCLE / 2 - DWELL_BOT) / 2 into its trip: both are the time it reaches the passing loop's middle (T_LOOP) when
// DWELL_BOT - DWELL_END = 2T - 4 T_LOOP (the longer dwell at the end whose half of the trip is the shorter).
const T_LOOP = PROFILE.T[Math.round((PASSING_LOOP.s0 + PASSING_LOOP.s1) / 2 / STEP)];
export const DWELL_END = DWELL_MIN + Math.max(0, 4 * T_LOOP - 2 * PROFILE.trip);
export const DWELL_BOT = DWELL_MIN + Math.max(0, 2 * PROFILE.trip - 4 * T_LOOP);
export const CYCLE = 2 * PROFILE.trip + DWELL_END + DWELL_BOT;
/**
 * State of a train at timetable time t (s), phase = 0 for the first train, 0.5 for the second:
 * { s, dir (+1 up / -1 down / 0 standing), speed, at: station id | null, doors: bool, leg, u (time into its cycle) }
 */
export function trainState(t, phase, out = {}) {
  const T = PROFILE.trip;
  const u = ((((t / CYCLE + phase) % 1) + 1) % 1) * CYCLE;
  out.u = u;
  if (u < T) { out.s = tripS(u); out.dir = 1; out.leg = 'up'; }
  else if (u < T + DWELL_END) { out.s = TRIP_S1; out.dir = 0; out.leg = 'top'; }
  else if (u < 2 * T + DWELL_END) { out.s = tripS(2 * T + DWELL_END - u); out.dir = -1; out.leg = 'down'; }
  else { out.s = TRIP_S0; out.dir = 0; out.leg = 'bottom'; }
  out.speed = out.dir ? speedAt(out.s) : 0;
  out.at = null;
  for (const st of RAIL.stations) if (Math.abs(out.s - st.s) < 1.5 && out.speed < 0.5) out.at = st.id;
  out.doors = !!out.at;
  return out;
}
/** Cycle time (0..CYCLE) at which a train stands at station `id` ready to leave heading `dir` (+1 up / -1 down). */
export function boardingU(id, dir) {
  const T = PROFILE.trip, tMid = PROFILE.T[PROFILE.iMid + 1] - DWELL_MID; // arrival at Wolkensee going up
  if (id === 'tal') return CYCLE - 20;          // waiting at the bottom, 20 s before it leaves
  if (id === 'platt') return T + DWELL_END - 20; // waiting at the top
  return dir > 0 ? tMid + DWELL_MID * 0.3 : 2 * T + DWELL_END - tMid - DWELL_MID * 0.7;
}

// ------------------------------------------------------------------ walkable track (world.addSurface: transport.js)
// The top of what railtrack.js / railstations.js build on the formation, as a height for the player's ground: the
// ballast bed (0.36 m over the formation's 0.72 m drop, the sleepers' tops 0.12 m higher), the slab in the tunnels, the
// viaducts' decks (railtrack.js buildViaduct) and the stations' platforms (railstations.js buildPlatform). Without it
// the player walked on the formation, sunk to the knees in the ballast and the platforms, and fell through the decks
// (Oct 28, the user: "you sink through the floor ... in the train tracks"). null off the structures.
const _w = { d: 1e9, s: 0, side: 0, i: 0 }, _wp = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
function trackTop(a, slab) {
  if (a <= 0.525) return -0.24;                       // the sleepers (1.05 m long)
  if (slab) return a <= 1.9 ? -0.42 : null;           // the tunnels' concrete slab
  if (a <= 1.55) return -0.36;                        // the ballast's crest
  return a <= 2.25 ? -0.36 - (a - 1.55) / 0.7 * 0.38 : null; // its shoulders down to the formation
}
function loopOff(s) { // (= railtrack.js loopOffset)
  const P = PASSING_LOOP;
  if (s <= P.s0 || s >= P.s1) return 0;
  return P.off * smoothstep(P.s0, P.s0 + P.ease, s) * (1 - smoothstep(P.s1 - P.ease, P.s1, s));
}
export function railDeckHeight(x, z) {
  const n = railNearest(x, z, _w);
  if (!n || n.d > 10) return null;
  const s = n.s, p = railAt(s, _wp);
  const lat = (x - p.x) * -p.dz + (z - p.z) * p.dx; // + right of the line (railtrack.js frame: rx = -dz, rz = dx)
  const slab = inTunnel(s);
  let top = trackTop(Math.abs(lat), slab);
  const off = loopOff(s);
  if (off) { const t2 = trackTop(Math.abs(lat - off), false); if (t2 !== null && (top === null || t2 > top)) top = t2; }
  if (!slab && onBridge(s) && Math.abs(lat) <= 2.7 && (top === null || top < -0.4)) top = -0.4; // the viaduct's deck
  for (const st of RAIL.stations) {
    if (st.underground || s < st.s0 + 4 || s > st.s1 - 4) continue;
    const l = lat * st.side;
    if (l >= 1.75 && l <= 5.95) top = 0.06; // the platform
  }
  return top === null ? null : p.y + top;
}
