// The snow ploughs' rounds (snowcats.js drives them): each machine has its own stretch of road (a "beat") that it
// works up and down for good, in the right-hand lane (PLOW_LANE right of the centre line, hugging the plowed edge),
// turning round at either end: once round a roundabout where the road ends at one, else in a tight U (a tracked
// machine turns on the spot) a little before the bus stop / junction / car park at the end. Beat 1: the valley road
// from the village (the main bus roads joined end to end), beats 2-3: the scenic roads nearest the village that share
// no roundabout. Each round is one closed line sampled every ~2 m with, per sample, the road and arc length it is
// on (for the parking spots), whether it is part of a turn, and the speed the machine may take there (bends, turns,
// grades, braked for in time).
// Also the parking-spot check: where a machine may pull over onto the shoulder (plowSpotOk). Pure layout (no THREE).
import { busRoads, roadAt, roadsideBlocked, laneDistance, ROAD_HALF } from '../game/bus/roads.js';

export const PLOW_LANE = 1.9;   // m right of the centre line (the machine's right side ~0.2 m past the plowed edge)
export const PARK_LAT = 3.1;    // m further right when parked: its centre 5 m off the centre line, on the shoulder
export const PULL_LEN = 22;     // m of road to pull over / back out
const LAT_A = 1.2, DEC = 0.6, V_TOP = 12; // (m/s^2 sideways in bends, braking; m/s top)
const END_KEEP = 95, END_KEEP_S = 28, RING_TRIM = 12;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _p = {}, _q = {};

/** Up to n beats [{ segs: [{ r, a, b }] (in driving order, a -> b) }] on different roads. */
export function pickBeats(n = 3, roads = busRoads.roads, stops = busRoads.stops) {
  const beats = [], used = new Set();
  const usable = (r) => r && !r.ringRoad && r.n > 4 && !used.has(r);
  // 1: the valley road from the village (main bus roads end to end, carrying on fairly straight)
  const main = roads.filter((r) => !r.scenic && !r.access && r.length > 300 && usable(r));
  if (main.length) {
    const v = stops?.[0];
    const first = main.find((r) => v && r.from === v) || [...main].sort((p, q) => q.length - p.length)[0];
    used.add(first);
    const segs = [{ r: first, a: 0, b: first.length }];
    for (let k = 0; k < 4; k++) {
      const last = segs[segs.length - 1], sg = last.b > last.a ? 1 : -1, e = roadAt(last.r, last.b, _p);
      const hx = e.dx * sg, hz = e.dz * sg;
      let next = null;
      for (const r of main) {
        if (used.has(r)) continue;
        const p0 = roadAt(r, 0, _q);
        if (Math.hypot(p0.x - e.x, p0.z - e.z) < 10 && p0.dx * hx + p0.dz * hz > 0.2) { next = { r, a: 0, b: r.length }; break; }
        const p1 = roadAt(r, r.length, _q);
        if (Math.hypot(p1.x - e.x, p1.z - e.z) < 10 && -(p1.dx * hx + p1.dz * hz) > 0.2) { next = { r, a: r.length, b: 0 }; break; }
      }
      if (!next) break;
      used.add(next.r);
      segs.push(next);
    }
    beats.push({ segs });
  }
  // 2, 3: the scenic roads nearest the village, no two ending at the same roundabout
  const vx = stops?.[0]?.x ?? 0, vz = stops?.[0]?.z ?? 0;
  const near = (r) => { let d = Infinity; for (let i = 0; i < r.n; i += 8) d = Math.min(d, Math.hypot(r.X[i] - vx, r.Z[i] - vz)); return d; };
  const scenic = roads.filter((r) => r.scenic && r.length > 1500 && usable(r)).map((r) => ({ r, d: near(r) })).sort((p, q) => p.d - q.d).map((o) => o.r);
  const rings = new Set();
  const ringsOf = (r) => [r.ringAt0, r.ringAtEnd].filter(Boolean);
  for (const pass of [0, 1]) {
    for (const r of scenic) {
      if (beats.length >= n) break;
      if (used.has(r) || (pass === 0 && ringsOf(r).some((g) => rings.has(g)))) continue;
      used.add(r);
      ringsOf(r).forEach((g) => rings.add(g));
      beats.push({ segs: [{ r, a: 0, b: r.length }] });
    }
  }
  // (too few: any other long road)
  for (const r of roads) {
    if (beats.length >= n) break;
    if (!usable(r) || r.length < 500) continue;
    used.add(r);
    beats.push({ segs: [{ r, a: 0, b: r.length }] });
  }
  return beats;
}

// how a beat ends at road r, arc length s (one of its ends): round the roundabout there, or a U short of the end
function endOf(r, s) {
  const atStart = s < r.length / 2, ring = atStart ? r.ringAt0 : r.ringAtEnd;
  if (ring) return { ring, trim: RING_TRIM };
  return { ring: null, trim: Math.min(r.scenic || r.access ? END_KEEP_S : END_KEEP, r.length * 0.2) };
}

/**
 * One beat's closed round: { X, Z, RI (road index, -1 in a turn), S (arc length on it), D (+1 / -1 along it),
 * K (1: a turn), VT (m/s the machine may take there), n, L (m), step, ends: [{ x, z }] }.
 */
export function buildRound(beat, roads = busRoads.roads, lane = PLOW_LANE) {
  const segs = beat.segs.map((g) => ({ ...g }));
  const f = segs[0], l = segs[segs.length - 1];
  const e0 = endOf(f.r, f.a), e1 = endOf(l.r, l.b);
  f.a += Math.sign(f.b - f.a) * e0.trim;
  l.b -= Math.sign(l.b - l.a) * e1.trim;
  const raw = []; // [x, z, ri, s, dir, turn]
  const push = (x, z, ri, s, d, k) => {
    const q = raw[raw.length - 1];
    if (q && Math.hypot(q[0] - x, q[1] - z) < 0.6) return;
    raw.push([x, z, ri, s, d, k]);
  };
  const along = (r, s0, s1) => {
    const d = s1 >= s0 ? 1 : -1, n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 4)), ri = roads.indexOf(r);
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      roadAt(r, s, _p);
      const tx = _p.dx * d, tz = _p.dz * d;
      push(_p.x - tz * lane, _p.z + tx * lane, ri, s, d, 0);
    }
  };
  const turn = (r, s, d, end) => {
    roadAt(r, s, _p);
    const tx = _p.dx * d, tz = _p.dz * d;
    if (end.ring) { // once round the roundabout (anticlockwise, as the traffic) and back out the same arm
      const g = end.ring, R = g.R || 15, a0 = Math.atan2(_p.x - g.x, _p.z - g.z), n = Math.ceil((Math.PI * 2 * R) / 2.5);
      for (let i = 1; i < n; i++) { const a = a0 + (Math.PI * 2 * i) / n; push(g.x + Math.sin(a) * R, g.z + Math.cos(a) * R, -1, 0, 0, 1); }
    } else { // a tight U into the other lane (a tracked machine: as good as on the spot)
      const cx = _p.x + tx * 3, cz = _p.z + tz * 3;
      for (let i = 1; i < 12; i++) { const a = (i / 12) * Math.PI; push(cx - tz * lane * Math.cos(a) + tx * lane * 1.5 * Math.sin(a), cz + tx * lane * Math.cos(a) + tz * lane * 1.5 * Math.sin(a), -1, 0, 0, 1); }
    }
  };
  for (const g of segs) along(g.r, g.a, g.b);
  turn(l.r, l.b, Math.sign(l.b - l.a), e1);
  for (let k = segs.length - 1; k >= 0; k--) along(segs[k].r, segs[k].b, segs[k].a);
  turn(f.r, f.a, -Math.sign(f.b - f.a), e0);
  // corners rounded (Chaikin, twice, closed), then evenly resampled (~2 m)
  let p = raw;
  for (let it = 0; it < 2; it++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], k = Math.max(a[5], b[5]);
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2], a[3], a[4], k], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, b[2], b[3], b[4], k]);
    }
    p = q;
  }
  const m = p.length, cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) { const a = p[i], b = p[(i + 1) % m]; cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]); }
  const L = cum[m], n = Math.max(8, Math.round(L / 2)), step = L / n;
  const X = new Float32Array(n), Z = new Float32Array(n), S = new Float32Array(n), RI = new Int16Array(n), D = new Int8Array(n), K = new Uint8Array(n), VT = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const u = i * step;
    while (j < m - 1 && cum[j + 1] <= u) j++;
    const a = p[j], b = p[(j + 1) % m], t = (u - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    X[i] = a[0] + (b[0] - a[0]) * t; Z[i] = a[1] + (b[1] - a[1]) * t;
    const c = t < 0.5 ? a : b;
    RI[i] = c[5] ? -1 : c[2]; S[i] = c[3]; D[i] = c[4]; K[i] = a[5] || b[5] ? 1 : 0;
  }
  // the speed it may take: the bend (over ~8 m), turns at a crawl, slower up the steep bits; braked for in time
  const hd = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = (i - 1 + n) % n, b = (i + 1) % n; hd[i] = Math.atan2(X[b] - X[a], Z[b] - Z[a]); }
  for (let i = 0; i < n; i++) {
    const k = Math.abs(wrapPi(hd[(i + 2) % n] - hd[(i - 2 + n) % n])) / (4 * step);
    let v = k > 1e-4 ? Math.min(V_TOP, Math.sqrt(LAT_A / k)) : V_TOP;
    if (K[i]) v = Math.min(v, 2.6);
    if (RI[i] >= 0 && roads[RI[i]]) { const g = roadAt(roads[RI[i]], S[i], _p).grade * D[i]; if (g > 0.07) v *= 0.85; }
    VT[i] = Math.max(1.2, v);
  }
  for (let pass = 0; pass < 2; pass++) for (let i = n - 1; i >= 0; i--) VT[i] = Math.min(VT[i], Math.sqrt(VT[(i + 1) % n] ** 2 + 2 * DEC * step));
  const ends = [e0, e1].map((e, k) => { const g = k ? l : f; roadAt(g.r, k ? g.b : g.a, _p); return { x: _p.x, z: _p.z }; });
  return { X, Z, S, RI, D, K, VT, n, L, step, ends, roads: segs.map((g) => g.r) };
}

/** Point on a round at distance u (wrapped): out { x, z, tx, tz (unit tangent), i (sample), t } */
export function roundAt(R, u, out = {}) {
  const n = R.n;
  u = ((u % R.L) + R.L) % R.L;
  const f = u / R.step, i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
  out.x = R.X[i] + (R.X[j] - R.X[i]) * t; out.z = R.Z[i] + (R.Z[j] - R.Z[i]) * t;
  const a = (i - 1 + n) % n, b = (j + 1) % n, dx = R.X[b] - R.X[a], dz = R.Z[b] - R.Z[a], l = Math.hypot(dx, dz) || 1;
  out.tx = dx / l; out.tz = dz / l; out.i = t < 0.5 ? i : j; out.t = t;
  return out;
}
/** Wrapped distance along a round from u0 forward to u1. */
export const ahead = (R, u0, u1) => (((u1 - u0) % R.L) + R.L) % R.L;
/** The extra sideways shift (0..PARK_LAT) at q m into a pull-over of length PULL_LEN (smooth both ends). */
export const pullShift = (q) => { const t = Math.min(1, Math.max(0, q / PULL_LEN)); return PARK_LAT * t * t * (3 - 2 * t); };

// places a machine never stops beside: junctions, stops, car parks, lay-bys, scenic tees, roundabouts
let keepAway = null;
function keepAwayPts() {
  if (keepAway && keepAway.n === busRoads.roads.length) return keepAway.pts;
  const pts = [];
  for (const j of busRoads.junctions || []) pts.push([j.x, j.z, 45]);
  for (const s of busRoads.stops || []) if (!s.noRoad) pts.push([s.x, s.z, 70]);
  for (const L of busRoads.lots || []) {
    if (L.ex !== undefined) pts.push([L.ex, L.ez, 35]);
    pts.push([L.x, L.z, Math.hypot(L.hw || 10, L.hd || 10) + 18]);
  }
  for (const lb of busRoads.laybys || []) pts.push([lb.x, lb.z, 35]);
  for (const t of busRoads.scenicTees || []) pts.push([t.x, t.z, 45]);
  for (const r of busRoads.roads) for (const g of [r.ringAt0, r.ringAtEnd]) if (g) pts.push([g.x, g.z, (g.R || 15) + 45]);
  keepAway = { n: busRoads.roads.length, pts };
  return pts;
}

/**
 * May a machine on round R stop with its centre at distance u (pulled over PARK_LAT to the right, coming in over the
 * PULL_LEN m before it)? A straight, level stretch of one road (no turn, no road end, junction, stop, car park,
 * lay-by, roundabout or tee near), nothing standing where it sweeps over the shoulder (no guardrail, pole, sign,
 * prop: `statics`, colliders near there), fairly flat ground under it (height(x, z) the ground). hw / hd: its half
 * width / length.
 */
export function plowSpotOk(R, u, { statics = [], height = null, hw = 1.95, hd = 3.4, avoid = [] } = {}) {
  const P = roundAt(R, u, {}), i = P.i, ri = R.RI[i];
  if (ri < 0 || R.K[i]) return false;
  const r = busRoads.roads[ri];
  if (!r) return false;
  const s = R.S[i];
  if (s < 60 || s > r.length - 60) return false;
  // the whole stretch (pull-over + the machine's length): on that road, no turn
  for (let q = -PULL_LEN - hd - 4; q <= hd + 6; q += R.step) {
    const k = roundAt(R, u + q, _q).i;
    if (R.RI[k] !== ri || R.K[k]) return false;
  }
  // straight and level
  const a = roadAt(r, Math.max(0, s - 22), {}), b = roadAt(r, Math.min(r.length, s + 12), {});
  if (Math.abs(wrapPi(Math.atan2(b.dx, b.dz) - Math.atan2(a.dx, a.dz))) > 0.35) return false;
  if (Math.abs(roadAt(r, s, _p).grade) > 0.135) return false;
  const nx = -P.tz, nz = P.tx; // (right of the way it drives)
  const cx = P.x + nx * PARK_LAT, cz = P.z + nz * PARK_LAT;
  for (const [x, z, rr] of keepAwayPts()) if (Math.abs(x - cx) < rr && Math.abs(z - cz) < rr && Math.hypot(x - cx, z - cz) < rr) return false;
  for (const o of avoid) if (Math.hypot(o.x - cx, o.z - cz) < (o.r ?? 30)) return false;
  // another road's lane, a junction's mouth, a car park, the lay-by (roads.js roadsideBlocked), at both ends too
  for (const q of [-hd, 0, hd]) {
    const x = cx + P.tx * q, z = cz + P.tz * q;
    if (roadsideBlocked(x, z, hw * 0.6, ri, s)) return false;
    if (laneDistance(x, z, ri, s, 60) < ROAD_HALF + hw + 1) return false;
  }
  // nothing where it sweeps across the shoulder: its body (three discs) all the way in
  const RG = busRoads.railGrid, rails = busRoads.rails, rad = hw + 0.25;
  for (let q = -PULL_LEN; q <= 0.01; q += 2) {
    const lat = pullShift(q + PULL_LEN);
    if (lat < 0.4) continue; // (still in its lane: it drives past the poles there anyway)
    const Q = roundAt(R, u + q, _q), mx = -Q.tz, mz = Q.tx;
    for (const k of [-hd + hw * 0.8, 0, hd - hw * 0.8]) {
      const x = Q.x + mx * lat + Q.tx * k, z = Q.z + mz * lat + Q.tz * k;
      for (const c of statics) {
        const reach = rad + (c.r ?? Math.hypot(c.hw || 0, c.hd || 0)) + 0.3;
        if (Math.abs(c.x - x) < reach && Math.abs(c.z - z) < reach) return false;
      }
      if (RG?.size && rails) {
        for (let gx = Math.floor((x - rad - 1) / 16); gx <= Math.floor((x + rad + 1) / 16); gx++) for (let gz = Math.floor((z - rad - 1) / 16); gz <= Math.floor((z + rad + 1) / 16); gz++) {
          const cell = RG.get(gx * 100003 + gz);
          if (!cell) continue;
          for (const ix of cell) {
            const g = rails[ix], ex = g.bx - g.ax, ez = g.bz - g.az, l2 = ex * ex + ez * ez || 1;
            const t = Math.min(1, Math.max(0, ((x - g.ax) * ex + (z - g.az) * ez) / l2));
            if (Math.hypot(g.ax + ex * t - x, g.az + ez * t - z) < rad + 0.6) return false;
          }
        }
      }
    }
  }
  // fairly flat under it: the shoulder within ~0.45 m of the road beside it (no berm crest, no drop)
  if (height) {
    const h0 = height(P.x + nx * (ROAD_HALF - 0.6), P.z + nz * (ROAD_HALF - 0.6));
    for (const q of [-hd, 0, hd]) for (const w of [PLOW_LANE + PARK_LAT - hw, PLOW_LANE + PARK_LAT, PLOW_LANE + PARK_LAT + hw]) {
      const h = height(P.x + nx * w + P.tx * q, P.z + nz * w + P.tz * q);
      if (!Number.isFinite(h) || Math.abs(h - h0) > 0.45) return false;
    }
  }
  return true;
}
