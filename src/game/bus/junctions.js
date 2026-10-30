// Junction mouths: where a road ends on another road's lane (a T junction, each arm of a crossroads: the access roads
// of the car parks, the Rettungsweg, the scenic roads' tees, ...), the two plowed surfaces join into one, its corners
// rounded (a fillet of radius ~8 m on the village / mountain roads, ~6 m where a car park's or the depot's access road
// comes in), the plough berm following the curve round the corner (roads.js shapeRoads), the side road's give-way line
// 1 m back from the main road's edge (junctionview.js draws the asphalt and the paint).
// Pure layout (no THREE), planned once the network's ground plan is final (roads.js planBusRoads, before the cuts).
//
// Each mouth's surface is a signed distance field in the main road's half on the side road's side: the main road's
// band and the side road's band (their half widths round their centre lines) unioned with a round blend of radius R
// (exact for a right angle: the fillet is the circle tangent to both edges). sd < 0 on the asphalt.
import { busRoads, ROAD_HALF } from './roads.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const WIN = 50;          // m of each road's centre line kept round the mouth
const CELL = 32;         // lookup grid (m)
export const MOUTH_BERM = 0.55; // the berm's crest round a corner (m, before the village's lowering: roads.js berm)

// a stretch of a road's centre line as a polyline { X, Z, S, n } (S: arc length relative to s0, or from the end)
function stretch(r, i0, i1, s0, rev) {
  const X = [], Z = [], S = [];
  if (!rev) for (let i = i0; i <= i1; i++) { X.push(r.X[i]); Z.push(r.Z[i]); S.push(r.S[i] - s0); }
  else for (let i = i1; i >= i0; i--) { X.push(r.X[i]); Z.push(r.Z[i]); S.push(s0 - r.S[i]); }
  return { X, Z, S, n: X.length };
}
// nearest point of a polyline: out.d (distance), out.s (arc length), out.o (signed offset, + on the left)
function proj(p, x, z, out) {
  let bd = Infinity, bi = 0, bt = 0;
  for (let i = 0; i < p.n - 1; i++) {
    const ax = p.X[i], az = p.Z[i], ex = p.X[i + 1] - ax, ez = p.Z[i + 1] - az, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1), qx = ax + ex * t - x, qz = az + ez * t - z, d = qx * qx + qz * qz;
    if (d < bd) { bd = d; bi = i; bt = t; }
  }
  const ax = p.X[bi], az = p.Z[bi], ex = p.X[bi + 1] - ax, ez = p.Z[bi + 1] - az;
  out.d = Math.sqrt(bd);
  out.s = p.S[bi] + (p.S[bi + 1] - p.S[bi]) * bt;
  out.o = ex * (z - az) - ez * (x - ax) >= 0 ? out.d : -out.d;
  return out;
}
/** The point at arc length s on polyline p, off to its left by `off` m: [x, z, dx, dz] (dx dz: its heading). */
export function polyAt(p, s, off = 0) {
  let i = 0;
  while (i < p.n - 2 && p.S[i + 1] < s) i++;
  const l = p.S[i + 1] - p.S[i] || 1, t = (s - p.S[i]) / l;
  let dx = p.X[i + 1] - p.X[i], dz = p.Z[i + 1] - p.Z[i];
  const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
  return [p.X[i] + (p.X[i + 1] - p.X[i]) * t - dz * off, p.Z[i] + (p.Z[i + 1] - p.Z[i]) * t + dx * off, dx, dz];
}
// nearest point of road B's lane to (x, z): { d, i, t } or null (further than 12 m); open: not past its ends
function nearestOn(B, x, z, open = false) {
  let best = null;
  for (let i = 0; i < B.n - 1; i++) {
    const ax = B.X[i], az = B.Z[i];
    if (Math.abs(ax - x) > 12 || Math.abs(az - z) > 12) continue;
    const dx = B.X[i + 1] - ax, dz = B.Z[i + 1] - az, l2 = dx * dx + dz * dz || 1, t0 = ((x - ax) * dx + (z - az) * dz) / l2;
    if (open && ((i === 0 && t0 < 0) || (i === B.n - 2 && t0 > 1))) continue;
    const t = clamp(t0, 0, 1), d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (!best || d < best.d) best = { d, i, t };
  }
  return best;
}

const _h = { d: 0, s: 0, o: 0 }, _s = { d: 0, s: 0, o: 0 }, _f = { sd: 0, A: 0, B: 0, a: 0, c: 0, o: 0, wedge: false };
/**
 * The mouth's field at (x, z), or null (out of its reach, or on the main road's far half): sd (signed distance to the
 * joined surface's edge, < 0 on it), A / B (off the main / side road's edge), a (along the main road from the mouth),
 * c (along the side road from its end), o (across the side road, + its left), wedge (where the rounded corners are).
 */
export function mouthField(m, x, z, out = _f) {
  const dx = x - m.x, dz = z - m.z;
  if (dx * dx + dz * dz > m.rb * m.rb) return null;
  proj(m.host, x, z, _h);
  if (_h.o * m.sb < 0) return null;
  proj(m.side, x, z, _s);
  const R = m.R, A = _h.d - ROAD_HALF, B = _s.d - ROAD_HALF;
  out.sd = Math.max(R, Math.min(A, B)) - Math.hypot(Math.max(R - A, 0), Math.max(R - B, 0));
  out.A = A; out.B = B; out.a = _h.s; out.c = _s.s; out.o = _s.o; out.wedge = A < R && B < R;
  return out;
}

let grid = null;
const cellsNear = (x, z) => grid?.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL)) || null;

/** Plan the mouths (busRoads.mouths) and flag the junctions they replace (j.mouth: roads.js berm). */
export function planMouths() {
  const roads = busRoads.roads, mouths = [];
  busRoads.mouths = mouths; grid = new Map();
  const H = ROAD_HALF;
  const lots = busRoads.lots.filter((L) => L.ux !== undefined && L.hw !== undefined);
  const inLot = (L, x, z, pad) => { const dx = x - L.x, dz = z - L.z; return Math.abs(dx * L.ux + dz * L.uz) < L.hw + pad && Math.abs(dx * L.vx + dz * L.vz) < L.hd + pad; };
  const rank = (r) => (r.ringRoad ? 3 : r.access ? 1 : 2);
  for (const r of roads) {
    if (r.ringRoad || r.n < 4) continue;
    for (const e of [0, 1]) {
      const iE = e ? r.n - 1 : 0, x = r.X[iE], z = r.Z[iE];
      if (lots.some((L) => inLot(L, x, z, 2.5))) continue; // (into a car park: its own mouth)
      // the road it ends on (as bus.js endHosts: not one ending there too, a road carrying on from another)
      let best = null;
      for (const B of roads) {
        if (B === r || (!B.ringRoad && [0, B.n - 1].some((k) => Math.hypot(B.X[k] - x, B.Z[k] - z) < 1.5))) continue;
        const q = nearestOn(B, x, z);
        if (q && q.d < H - 0.05 && (!best || q.d < best.d)) best = { ...q, B };
      }
      if (!best || best.B.ringRoad) continue; // (a roundabout's arms: the ring's own islands and give-way signs)
      const B = best.B;
      if ([0, B.n - 1].some((k) => { const q = nearestOn(r, B.X[k], B.Z[k], true); return q && q.d < H; })
        && (rank(r) > rank(B) || (rank(r) === rank(B) && r.length > B.length))) continue; // (the two ending in each other: the other one is cut)
      const sP = B.S[best.i] + (B.S[best.i + 1] - B.S[best.i]) * best.t;
      const px = B.X[best.i] + (B.X[best.i + 1] - B.X[best.i]) * best.t, pz = B.Z[best.i] + (B.Z[best.i + 1] - B.Z[best.i]) * best.t;
      let h0 = best.i, h1 = best.i + 1;
      while (h0 > 0 && sP - B.S[h0] < WIN) h0--;
      while (h1 < B.n - 1 && B.S[h1] - sP < WIN) h1++;
      const host = stretch(B, h0, h1, sP, false);
      // the side road from its end inward (c), carried on 12 m past its end (across the main road)
      let k1 = 0;
      while (k1 < r.n - 1 && Math.abs(r.S[e ? r.n - 1 - k1 : k1] - r.S[iE]) < WIN) k1++;
      const side = e ? stretch(r, r.n - 1 - k1, r.n - 1, r.S[iE], true) : stretch(r, 0, k1, 0, false);
      if (side.n < 3) continue;
      const [, , ex, ez] = polyAt(side, 2);
      side.X.unshift(side.X[0] - ex * 12); side.Z.unshift(side.Z[0] - ez * 12); side.S.unshift(-12); side.n++;
      const far = polyAt(side, Math.min(H + 10, side.S[side.n - 1]));
      proj(host, far[0], far[1], _h);
      if (_h.d < H + 1) continue; // (runs along it: no mouth)
      const R = r.access && !r.scenic ? 6 : 8; // (a car park's / the depot's / the Rettungsweg's access road: tighter)
      const m = { r, e, B, x: px, z: pz, sP, sb: _h.o >= 0 ? 1 : -1, R, host, side, rb: 60, bus: !r.scenic && !B.scenic };
      // where the rounded corners meet the main road's edge (a: aMin < 0 < aMax) and the side road's (cMax)
      const solid = (q) => { const f = mouthField(m, q[0], q[1]); return f && f.sd < 0.02; };
      let aMax = 0, aMin = 0, cMax = 0;
      while (aMax < 30 && solid(polyAt(host, aMax + 0.25, m.sb * (H + 0.05)))) aMax += 0.25;
      while (aMin > -30 && solid(polyAt(host, aMin - 0.25, m.sb * (H + 0.05)))) aMin -= 0.25;
      for (const sg of [1, -1]) { let c = 0; while (c < 30 && solid(polyAt(side, c + 0.25, sg * (H + 0.05)))) c += 0.25; cMax = Math.max(cMax, c); }
      // the give-way line: across the lane coming in (the right of a car driving toward the main road: the side
      // road's right looking away from it), its near edge 1 m back from the main road's edge all across that lane
      let cEdge = 0;
      for (const o of [0, -H / 2, -(H - 0.3)]) {
        let c = 0;
        while (c < 20) { const q = polyAt(side, c, o); proj(host, q[0], q[1], _h); if (_h.d >= H) break; c += 0.1; }
        cEdge = Math.max(cEdge, c);
      }
      Object.assign(m, { aMax, aMin, cMax, cEdge, cLine: cEdge + 1.15 });
      // its reach: the farthest corner of the surface (+ 4 m)
      let rb = 0;
      for (const q of [polyAt(host, aMax + 2, m.sb * (H + 2)), polyAt(host, aMin - 2, m.sb * (H + 2)), polyAt(side, cMax + 2, H + 2), polyAt(side, cMax + 2, -H - 2)]) rb = Math.max(rb, Math.hypot(q[0] - px, q[1] - pz));
      m.rb = rb + 4;
      mouths.push(m);
      // (the junction it stands for: the berm follows its corners instead of stopping short of it)
      if (m.bus) for (const j of busRoads.junctions) if (!j.ring && !j.drive && (Math.hypot(j.x - px, j.z - pz) < 10 || Math.hypot(j.x - x, j.z - z) < 10)) j.mouth = true;
      const reach = m.rb + 18; // (+ the berm's blend: mouthNear)
      for (let cx = Math.floor((px - reach) / CELL); cx <= Math.floor((px + reach) / CELL); cx++) for (let cz = Math.floor((pz - reach) / CELL); cz <= Math.floor((pz + reach) / CELL); cz++) {
        const k = cx * 65536 + cz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(m);
      }
    }
  }
  return mouths;
}

/** The lane distance a mouth's rounded corners give (x, z) (ROAD_HALF + its sd there), or Infinity. */
export function mouthLane(x, z) {
  const arr = cellsNear(x, z);
  let d = Infinity;
  if (arr) for (const m of arr) { const f = mouthField(m, x, z); if (f && f.wedge) d = Math.min(d, ROAD_HALF + f.sd); }
  return d;
}

/** In a rounded corner of a mouth whose berm the bus roads' cut shapes: its sd there (> 0 off the asphalt), else null. */
export function mouthCorner(x, z) {
  const arr = cellsNear(x, z);
  let sd = null;
  if (arr) for (const m of arr) { if (!m.bus) continue; const f = mouthField(m, x, z); if (f && f.wedge && (sd === null || f.sd < sd)) sd = f.sd; }
  return sd;
}

/** 0..1: how near (x, z) is to a mouth whose berm follows its corners (1 within its reach, 0 18 m past it). */
export function mouthNear(x, z) {
  const arr = cellsNear(x, z);
  let w = 0;
  if (arr) for (const m of arr) if (m.bus) w = Math.max(w, 1 - smoothstep(m.rb, m.rb + 18, Math.hypot(x - m.x, z - m.z)));
  return w;
}
