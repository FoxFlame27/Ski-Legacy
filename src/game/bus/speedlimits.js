// Speed limits on the roads, and where the road signs stand (Swiss style: a red ring with the limit where it changes,
// red-bordered warning triangles before sharp bends, hairpins, winding stretches and steep grades). Pure layout (no
// THREE): runs in Node too. The traffic (traffic.js) drives to these limits: up to 120 km/h signed on the long, straight,
// gentle stretches of the valley roads (some drivers 25 % over: 150 km/h), slower through the bends (v = sqrt(a_lat R),
// braking in time before them), 50 in the village and by the bus stops, 60-80 on the pass and scenic roads, 30-40
// on the village streets, the car parks' access roads and the roundabouts.
// (roads.js imports chaletroad.js / scenic*.js, which may run before this module is evaluated: the roads.js bindings
// are only used inside functions here)
import { busRoads, ROAD_HALF, roadsideBlocked, laneDistance } from './roads.js';

export const A_LAT = 3.4;          // m/s^2: cornering on a ploughed snow road
export const A_BRAKE = 2.4;        // m/s^2: braking planned ahead (bends, a lower limit)
export const V_MAX = 150 / 3.6;    // m/s: the fastest any traffic drives
const STEPS = [30, 40, 50, 60, 80, 100, 120];
const VILLAGE_R = 260;             // m round the village centre (0, 0): 50
const STOP_R = 230;                // m round a bus stop on a valley road: 50
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const quantDown = (kmh, lo) => { let q = lo; for (const s of STEPS) if (s <= kmh && s >= lo) q = s; return q; };

/** A road's class: its highest limit (km/h), its lowest signed one, the shortest stretch one limit holds (m). */
export function roadClass(r) {
  if (r.ringRoad) return { kind: 'ring', cap: 30, min: 30, seg: 0 };
  if (r.length < 160 || (r.access && !r.scenic)) return { kind: 'access', cap: 30, min: 30, seg: 0 };
  if (r.chalet) return { kind: 'street', cap: 30, min: 30, seg: 0 };
  if (r.rentalRoad) return { kind: 'street', cap: 40, min: 40, seg: 0 };
  if (r.loop) return { kind: 'pass', cap: 80, min: 50, seg: 300 };
  if (r.scenic) return { kind: 'pass', cap: 60, min: 50, seg: 300 };
  return { kind: 'main', cap: 120, min: 50, seg: 350 };
}

/**
 * Per road sample (cached on the road): k (signed curvature, + = left going +s), grade, kmh (the signed limit), lim
 * (the same in m/s), vc (the safe cornering speed there, m/s), and braked envelopes for each way: limF / vcF (going
 * +s), limB / vcB (going -s): never more than can be braked down (A_BRAKE) to what comes next.
 */
export function roadProfile(r) {
  if (r._sp && r._sp.n === r.n) return r._sp;
  const n = r.n, X = r.X, Z = r.Z, Y = r.Y, S = r.S, cls = roadClass(r);
  const head = new Float32Array(n), k = new Float32Array(n), grade = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); head[i] = Math.atan2(X[b] - X[a], Z[b] - Z[a]); }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2), ds = Math.max(1, S[b] - S[a]);
    k[i] = r.ringRoad ? 1 / (r.ringRoad.R || 15) : wrapPi(head[b] - head[a]) / ds;
    grade[i] = (Y[b] - Y[a]) / ds;
  }
  // safe cornering speed (the tightest within ~8 m), a little less on the steep bits
  const vc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let kk = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) kk = Math.max(kk, Math.abs(k[j]));
    vc[i] = Math.min(V_MAX, Math.sqrt(A_LAT / Math.max(1e-5, kk)) * (1 - clamp((Math.abs(grade[i]) - 0.1) * 2.5, 0, 0.15)));
  }
  // the signed limit: the class's top, lower where the road winds (its bends over ~320 m at a comfortable 3.4 m/s^2)
  // or (the pass roads) climbs steeply; no stretch shorter than cls.seg (a short one takes its longer neighbour's
  // limit: the bends themselves have their warning signs, and the traffic always slows for a bend to what it allows);
  // then 50 in the village and by the bus stops
  const kmh = new Int16Array(n);
  const stops = busRoads.stops || [];
  for (let i = 0; i < n; i++) {
    if (cls.seg === 0) { kmh[i] = cls.cap; continue; }
    // (the road's character over ~320 m: the mean of the comfortable speed at each sample; one bend on a long straight
    // takes it down a step, a run of them several)
    let sum = 0, cnt = 0, gw = 0;
    for (let j = Math.max(0, i - 40); j <= Math.min(n - 1, i + 40); j++) { sum += Math.min(135, Math.sqrt(3.4 / Math.max(1e-5, Math.abs(k[j]))) * 3.6); cnt++; if (Math.abs(j - i) <= 15) gw = Math.max(gw, Math.abs(grade[j])); }
    let v = Math.min(cls.cap, quantDown(sum / cnt, cls.min));
    if (cls.kind === 'pass' && gw > 0.075) v = Math.min(v, cls.cap > 60 ? 60 : 50);
    kmh[i] = v;
  }
  if (cls.seg > 0) {
    for (let it = 0; it < 60; it++) {
      const seg = [];
      for (let i = 0; i < n;) { let j = i; while (j + 1 < n && kmh[j + 1] === kmh[i]) j++; seg.push([i, j]); i = j + 1; }
      if (seg.length < 2) break;
      let w = -1, wl = Infinity;
      seg.forEach(([a, b], q) => { const l = S[b] - S[a]; if (l < cls.seg && l < wl) { wl = l; w = q; } });
      if (w < 0) break;
      const [a, b] = seg[w], P0 = seg[w - 1], P1 = seg[w + 1];
      const nb = !P0 ? P1 : !P1 ? P0 : S[P0[1]] - S[P0[0]] >= S[P1[1]] - S[P1[0]] ? P0 : P1;
      for (let i = a; i <= b; i++) kmh[i] = kmh[nb[0]];
    }
    for (let i = 0; i < n; i++) {
      const x = X[i], z = Z[i];
      if (Math.hypot(x, z) < VILLAGE_R) kmh[i] = Math.min(kmh[i], 50);
      if (cls.kind === 'main') for (const st of stops) if (Math.abs(st.x - x) < STOP_R && Math.abs(st.z - z) < STOP_R && Math.hypot(st.x - x, st.z - z) < STOP_R) { kmh[i] = Math.min(kmh[i], 50); break; }
    }
    // (a short stretch left above both its neighbours, between two 50 zones: down to the higher of them)
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && kmh[j + 1] === kmh[i]) j++;
      if (i > 0 && j < n - 1 && S[j] - S[i] < cls.seg && kmh[i] > kmh[i - 1] && kmh[i] > kmh[j + 1]) { const v = Math.max(kmh[i - 1], kmh[j + 1]); for (let q = i; q <= j; q++) kmh[q] = v; i = 0; continue; }
      i = j + 1;
    }
  }
  const lim = new Float32Array(n);
  for (let i = 0; i < n; i++) lim[i] = kmh[i] / 3.6;
  const env = (src, dir) => {
    const o = Float32Array.from(src);
    if (dir > 0) for (let i = n - 2; i >= 0; i--) o[i] = Math.min(o[i], Math.sqrt(o[i + 1] * o[i + 1] + 2 * A_BRAKE * (S[i + 1] - S[i])));
    else for (let i = 1; i < n; i++) o[i] = Math.min(o[i], Math.sqrt(o[i - 1] * o[i - 1] + 2 * A_BRAKE * (S[i] - S[i - 1])));
    return o;
  };
  r._sp = { n, cls, k, grade, kmh, lim, vc, limF: env(lim, 1), limB: env(lim, -1), vcF: env(vc, 1), vcB: env(vc, -1) };
  return r._sp;
}

function indexAt(r, s) {
  const S = r.S;
  let lo = 0, hi = r.n - 1;
  if (s <= 0) return 0;
  if (s >= S[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  return lo;
}

/**
 * The speed a driver wants at arc length s going dir on road r: the limit (braked ahead of a lower one) times the
 * driver's own factor f, never faster than the bends ahead allow (braked in time), never over V_MAX. m/s.
 */
export function roadTarget(r, s, dir, f = 1) {
  const P = roadProfile(r), i = indexAt(r, s), j = dir > 0 ? i : Math.min(r.n - 1, i + 1);
  return Math.min(V_MAX, (dir > 0 ? P.limF : P.limB)[j] * f, (dir > 0 ? P.vcF : P.vcB)[j]);
}
/** The signed limit (km/h) at arc length s on road r. */
export function roadLimit(r, s) { return roadProfile(r).kmh[indexAt(r, s)]; }

// ------------------------------------------------------------------ the limit where you are (HUD, scenic cars)
let grid = null;
function limitGrid() {
  if (grid && grid.n === busRoads.roads.length) return grid;
  const C = 24, map = new Map();
  busRoads.roads.forEach((r) => {
    for (let i = 0; i < r.n; i++) {
      const key = Math.floor(r.X[i] / C) * 100003 + Math.floor(r.Z[i] / C);
      let a = map.get(key);
      if (!a) map.set(key, (a = []));
      a.push(r, i);
    }
  });
  grid = { C, map, n: busRoads.roads.length };
  return grid;
}
/** The signed limit at (x, z): { kmh, r, i, d } at the nearest road sample within maxD m, else null. */
export function speedLimitAt(x, z, maxD = ROAD_HALF + 2.5) {
  if (!busRoads.roads.length) return null;
  const G = limitGrid(), cx = Math.floor(x / G.C), cz = Math.floor(z / G.C);
  let best = null, bd = maxD + 2.2; // (samples every ~4 m: up to 2 m along)
  for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
    const a = G.map.get(gx * 100003 + gz);
    if (!a) continue;
    for (let q = 0; q < a.length; q += 2) {
      const r = a[q], i = a[q + 1], d = Math.hypot(r.X[i] - x, r.Z[i] - z);
      if (d < bd) { bd = d; best = { r, i }; }
    }
  }
  if (!best) return null;
  const P = roadProfile(best.r);
  return { kmh: P.kmh[best.i], r: best.r, i: best.i, d: bd };
}

// ------------------------------------------------------------------ the signs
// Each: { x, z, yaw (the face's normal: toward the traffic it is for), y0 (the road's height there), kind, val }.
// kind: 'limit' (val km/h), 'curveL' / 'curveR', 'hairpinL' / 'hairpinR', 'windL' / 'windR' (a double bend, the first
// to that side), 'steepDown' / 'steepUp' (val: %). On the traffic's right, 1.9 m outside the plowed edge (behind the
// guardrail's line, clear of the snow poles), never on another road, in a junction's mouth, a car park, a lay-by, by
// a bus stop, or on top of another sign (moved back along the road until it is clear, else left out).
const SIGN_OFF = ROAD_HALF + 1.9;
export function planRoadSigns() {
  const out = [];
  const stops = busRoads.stops || [];
  const taken = (x, z) => out.some((o) => Math.abs(o.x - x) < 4 && Math.abs(o.z - z) < 4);
  busRoads.roads.forEach((r, ri) => {
    const cls = roadClass(r);
    if (cls.kind === 'ring' || cls.kind === 'access' || r.n < 12) return;
    const P = roadProfile(r), n = r.n, S = r.S, L = r.length;
    const keepEnd = cls.kind === 'main' ? 105 : 30; // (a valley road's ends are bus stops)
    const place = (s0, dir, kind, val) => {
      for (let t = 0; t < 6; t++) {
        const s = s0 - dir * t * 7;
        if (s < keepEnd || s > L - keepEnd) return false;
        const i = indexAt(r, s), j = Math.min(n - 1, i + 1), u = (s - S[i]) / Math.max(1e-6, S[j] - S[i]);
        const px = r.X[i] + (r.X[j] - r.X[i]) * u, pz = r.Z[i] + (r.Z[j] - r.Z[i]) * u, py = r.Y[i] + (r.Y[j] - r.Y[i]) * u;
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 2), hx0 = r.X[b] - r.X[a], hz0 = r.Z[b] - r.Z[a], hl = Math.hypot(hx0, hz0) || 1;
        const tx = (hx0 / hl) * dir, tz = (hz0 / hl) * dir, x = px - tz * SIGN_OFF, z = pz + tx * SIGN_OFF; // (its right)
        if (Math.abs(P.k[i]) > 1 / 30) continue; // (not on the inside of a hairpin)
        if (roadsideBlocked(x, z, 0.6, ri, s)) continue;
        if (laneDistance(x, z) < SIGN_OFF - 0.4) continue; // (the road itself, a leg of it coming back, another road)
        if (stops.some((st) => Math.hypot(st.x - x, st.z - z) < 30)) continue;
        if (taken(x, z)) continue;
        out.push({ x, z, yaw: Math.atan2(-tx, -tz), y0: py, kind, val, ri, s, dir });
        return true;
      }
      return false;
    };
    for (const dir of [1, -1]) {
      const at = (q) => (dir > 0 ? q : n - 1 - q); // (q: samples in this way's order)
      const sOf = (q) => S[at(q)];
      // speed limits: where this way enters the road, at every change, repeated every ~1.5 km
      let last = null, lastS = -1e9;
      for (let q = 0; q < n; q++) {
        const i = at(q), v = P.kmh[i], s = S[i], d = Math.abs(s - lastS);
        if (s < keepEnd + 5 || s > L - keepEnd - 5) continue;
        if (v !== last || d > 1500) { if (place(s, dir, 'limit', v)) { last = v; lastS = s; } else if (v !== last) { last = v; lastS = s; } }
      }
      // bends: runs where the bend needs well under the limit (and tighter than ~260 m)
      const runs = [];
      for (let q = 0; q < n;) {
        const i = at(q);
        if (!(P.vc[i] < P.lim[i] * 0.8 && Math.abs(P.k[i]) > 1 / 260)) { q++; continue; }
        let e = q, turn = 0, kmax = 0;
        while (e < n && P.vc[at(e)] < P.lim[at(e)] * 0.8 && Math.abs(P.k[at(e)]) > 1 / 260) {
          const ii = at(e), ds = e + 1 < n ? Math.abs(S[at(e + 1)] - S[ii]) : 0;
          turn += P.k[ii] * dir * ds; kmax = Math.max(kmax, Math.abs(P.k[ii])); e++;
        }
        if (Math.abs(turn) > 0.35) runs.push({ q0: q, q1: e - 1, turn, kmax });
        q = e;
      }
      // grouped: bends less than 160 m apart are one winding stretch (one sign before its first bend)
      for (let g = 0; g < runs.length;) {
        let h = g;
        while (h + 1 < runs.length && Math.abs(sOf(runs[h + 1].q0) - sOf(runs[h].q1)) < 160) h++;
        const R0 = runs[g], side = R0.turn > 0 ? 'L' : 'R', lim = P.lim[at(R0.q0)];
        const hair = Math.abs(R0.turn) > 2.3 || R0.kmax > 1 / 28;
        const kind = hair ? `hairpin${side}` : h > g ? `wind${side}` : `curve${side}`;
        const lead = clamp(lim * 3.5, 45, 150);
        place(sOf(R0.q0) - dir * lead, dir, kind, 0);
        g = h + 1;
      }
      // steep grades: 8.5 % or more over 100 m
      for (let q = 0; q < n;) {
        const g0 = P.grade[at(q)] * dir;
        if (Math.abs(g0) < 0.085) { q++; continue; }
        const sg = Math.sign(g0);
        let e = q, gmax = 0;
        while (e < n && P.grade[at(e)] * dir * sg > 0.07) { gmax = Math.max(gmax, Math.abs(P.grade[at(e)])); e++; }
        if (Math.abs(sOf(e - 1) - sOf(q)) > 100) place(sOf(q) - dir * 70, dir, sg < 0 ? 'steepDown' : 'steepUp', gmax > 0.11 ? 12 : gmax > 0.095 ? 10 : 8);
        q = e;
      }
    }
  });
  return out;
}
