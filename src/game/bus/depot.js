// The BUS DEPOT (Oct 30, the user: at the Legacy Village stop "the buses drive through each other at the end"; a bus
// parking lot next to the stop): a paved lot with 8 drive-through bays, one per bus (bus:0, your own bus in single
// player, and bus:1..7 of the fleet), on open ground a little north of the village, reached by the DEPOTWEG, an access
// road that carries straight on from the village stop's end (the road no longer just stops there). A returning bus
// lets its riders off at the stop (the inbound lane, across from the sign), drives on round the bend and up the
// Depotweg into the depot, through its own bay to the middle, and waits there; for its next round it drives on out of
// the bay, round the depot's one-way loop, back down the Depotweg to the stop and boards at the sign (the outbound
// lane), then leaves. No bus ever turns on the spot (before: it teleported round at the stop) and every bus has a bay
// of its own; the timetable (bus.js buildFleet) gives each round a slot so no two buses use the stop's bays at once.
// Pure layout (no THREE): planned with the roads (roads.js planBusRoads), before the terrain is shaped.
//
// The lot's own frame: v into the depot (the way a bus drives in up the Depotweg), u to the right of v; the mouth on
// the low (v = -hd) side, its in lane aligned with the right aisle (u = +AU). In: up the right aisle,
// left into the bay (driven toward -u), out at the left aisle, down it, along the bottom and out through the mouth on
// the other lane. The in and out ways never cross (a one-way loop, right-hand traffic).
import { world } from '../../world/world.js';
import { busRoads, makeRoad, laneDistance, ROAD_HALF, MAX_GRADE } from './roads.js';

export const DEPOT = { R: 8.5, LANE: 1.55, W: 4.5, BAYS: 8, EXT: 5 }; // track turn radius, the bus's lane offset, bay spacing, bays, run-on past the bay's middle
DEPOT.AU = DEPOT.R + 7;                       // the aisles' tracks (u = +-AU): a parked bus (u -6..6) stays clear of a bus turning in
DEPOT.UM = DEPOT.AU - DEPOT.LANE;             // the Depotweg's centre line at the mouth
DEPOT.HW = DEPOT.AU + 3.5;
DEPOT.HD = (3 * DEPOT.R + 2.5 + 7.5 * DEPOT.W) / 2;
DEPOT.VB = -DEPOT.HD + DEPOT.R + 1;           // the out way's run along the bottom
DEPOT.V0 = DEPOT.VB + 2 * DEPOT.R;            // bay 0's middle line
export const bayV = (k) => DEPOT.V0 + k * DEPOT.W;
export const DEPOT_STOP = { name: 'Bus depot', depot: true }; // (the bays' timetable mark: not a stop anyone boards at)

// the village plaza's cobblestone spokes to the hotels (world/decor.js buildPaths): the Depotweg keeps off them
const HOTELS = [[62, 34], [-74, 44], [100, -34], [-108, -60], [22, 92], [-36, 108], [118, 70], [-128, 22]];
const SPOKES = HOTELS.map(([x, z]) => { const l = Math.hypot(x, z + 4), a = Math.atan2(z + 4, x); return [Math.cos(a) * 15, Math.sin(a) * 15 - 4, x - (x / l) * 12, z - ((z + 4) / l) * 12]; });
const segD = (x, z, ax, az, bx, bz) => { const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1))); return Math.hypot(ax + ex * t - x, az + ez * t - z); };

// the Depotweg from the stop's end P0 (heading h0, carrying on from the village road) round a left-hand bend of radius
// Rb until it heads along v, then straight t m to the mouth: [[x, z]...] every ~2 m, and the mouth point
function wayFrom(P0, h0, v, Rb, t) {
  const left = (h) => [h[1], -h[0]];
  const L0 = left(h0), cx = P0[0] + L0[0] * Rb, cz = P0[1] + L0[1] * Rb;
  let phi = Math.atan2(v[0] * L0[0] + v[1] * L0[1], v[0] * h0[0] + v[1] * h0[1]);
  if (phi < 0) phi += Math.PI * 2;
  if (phi < 0.7 || phi > 2.7) return null;
  const pts = [], n = Math.max(2, Math.ceil((phi * Rb) / 2));
  for (let i = 0; i <= n; i++) { // (rotating P0 - c about c by the turn: h' = h cos a + left(h) sin a)
    const a = (i / n) * phi, ca = Math.cos(a), sa = Math.sin(a);
    const hx = h0[0] * ca + L0[0] * sa, hz = h0[1] * ca + L0[1] * sa, lx = hz, lz = -hx; // (left of the heading then)
    pts.push([cx - lx * Rb, cz - lz * Rb]);
  }
  const E = pts[pts.length - 1], m = Math.ceil(t / 2);
  for (let i = 1; i <= m; i++) pts.push([E[0] + v[0] * (t * i) / m, E[1] + v[1] * (t * i) / m]);
  return pts;
}

/** Plan the depot and the Depotweg (roads.js planBusRoads, after every other road and lot). O: the obstacles. */
export function planDepot(O) {
  const v0 = busRoads.stops[0], R0 = busRoads.roads.find((r) => r.from === v0);
  if (!R0 || R0.n < 4) return;
  const P0 = [R0.X[0], R0.Z[0]], l = Math.hypot(R0.X[1] - R0.X[0], R0.Z[1] - R0.Z[0]) || 1;
  const h0 = [-(R0.X[1] - R0.X[0]) / l, -(R0.Z[1] - R0.Z[0]) / l]; // (on past the road's end)
  const { HW, HD, UM } = DEPOT, q = {}, pad = busRoads.helipad;
  const others = busRoads.lots.filter((L) => L.ux !== undefined);
  const lotOut = (L, x, z) => { const dx = x - L.x, dz = z - L.z; return Math.hypot(Math.max(0, Math.abs(dx * L.ux + dz * L.uz) - L.hw), Math.max(0, Math.abs(dx * L.vx + dz * L.vz) - L.hd)); };
  let best = null;
  for (let yd = -30; yd <= 30; yd += 7.5) {
    const ps = (yd * Math.PI) / 180, v = [Math.sin(ps), Math.cos(ps)], u = [-v[1], v[0]];
    for (const Rb of [10, 11, 13]) for (let t = 40; t <= 120; t += 10) {
      const way = wayFrom(P0, h0, v, Rb, t);
      if (!way) continue;
      const M = way[way.length - 1]; // (the mouth: 1 m inside the lot's low edge)
      const cx = M[0] + v[0] * (HD - 1) - u[0] * UM, cz = M[1] + v[1] * (HD - 1) - u[1] * UM;
      // the lot: clear ground (no runs, nets, railway, lift lines or buildings, no other road, lot or the helipad),
      // fairly flat, and far enough from the hotels that its levelled ground leaves theirs alone
      let ok = true, lo = Infinity, hi = -Infinity;
      for (let a = -HW - 4; a <= HW + 4 && ok; a += 4) for (let b = -HD - 4; b <= HD + 4 && ok; b += 4) {
        const x = cx + u[0] * a + v[0] * b, z = cz + u[1] * a + v[1] * b;
        O.query(x, z, q);
        if (q.ski < 8 || q.net < 6 || q.block < 2 || q.rail < 8 || q.lift < 4) ok = false;
        const c = world.corridorAt(x, z);
        if (c.kind && c.d < (c.kind === 'lift' ? 2 : 6)) ok = false;
        if (laneDistance(x, z) < ROAD_HALF + 6) ok = false;
        if (others.some((L) => lotOut(L, x, z) < 10)) ok = false;
        if (pad && Math.hypot(pad.x - x, pad.z - z) < 30) ok = false;
        if (SPOKES.some((s) => segD(x, z, ...s) < 3)) ok = false;
        if (Math.abs(a) <= HW && Math.abs(b) <= HD) { const h = world.height(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      }
      if (!ok || hi - lo > 3.5) continue;
      const y = (lo + hi) / 2;
      const L = { x: cx, z: cz, ux: u[0], uz: u[1], vx: v[0], vz: v[1], hw: HW, hd: HD };
      if (HOTELS.some(([x, z]) => lotOut(L, x, z) < 14 + 3.2 * Math.abs(world.height(x, z) - y))) continue;
      // the Depotweg: clear too, off the plaza, the spokes and every other road (but the village road it carries on from)
      let along = 0;
      for (let i = 0; i < way.length && ok; i++) {
        const [x, z] = way[i];
        if (i) along += Math.hypot(x - way[i - 1][0], z - way[i - 1][1]);
        O.query(x, z, q);
        if (q.ski < 10 || q.net < 8 || q.block < 2 || q.rail < 10 || q.lift < 4) ok = false;
        if (along > 35 && laneDistance(x, z) < 13) ok = false;
        if (Math.hypot(x, z + 6) < 40) ok = false;
        if (others.some((Lo) => lotOut(Lo, x, z) < 8)) ok = false;
        if (pad && Math.hypot(pad.x - x, pad.z - z) < 25) ok = false;
        if (SPOKES.some((s) => segD(x, z, ...s) < ROAD_HALF + 2.6)) ok = false; // (the path's edge 1.4 m off the road's)
      }
      if (!ok) continue;
      const score = (hi - lo) * 4 + t * 0.05 + Math.abs(yd) * 0.05 + Math.abs(Rb - 11) * 0.2;
      if (!best || score < best.score) best = { score, way, L, y, yaw: Math.atan2(u[0], u[1]) };
    }
  }
  if (!best) { console.warn('bus depot: no site'); return; }
  const { L, way, y } = best;
  // the road: from the mouth (inside the lot, like a car park's access road) to the stop's end, where it carries on
  // into the village road (the same heading there: one continuous road through the stop)
  const pts = way.slice().reverse();
  const road = makeRoad(pts, { name: 'Bus depot', x: pts[0][0], z: pts[0][1], depot: true }, { name: 'junction', x: P0[0], z: P0[1] }, { y0: y, y1: R0.Y[0] });
  let worst = 0;
  for (let i = 1; i < road.n; i++) worst = Math.max(worst, Math.abs(road.Y[i] - road.Y[i - 1]) / Math.max(0.01, road.S[i] - road.S[i - 1]));
  if (worst > MAX_GRADE + 0.01) { console.warn('bus depot: road too steep'); return; }
  road.access = true; road.depot = true; road.name = 'Depotweg';
  const lot = { ...L, name: 'Bus depot', depot: true, building: true, yaw: best.yaw, y, flat: 2.9,
    ex: L.x - L.vx * (HD + 2) + L.ux * UM, ez: L.z - L.vz * (HD + 2) + L.uz * UM, dirx: -L.vx, dirz: -L.vz };
  busRoads.roads.push(road);
  busRoads.lots.push(lot);
  busRoads.junctions.push({ x: P0[0], z: P0[1] });
  busRoads.depot = { lot, road, R0 };
}

// ------------------------------------------------------------------ the buses' ways in and out (bus.js buildFleet)
// A turtle in the lot's frame: [u, v] every ~1 m; ops ['S', m] straight, ['L' | 'R', rad] a turn of radius R
function track(u, v, du, dv, ops) {
  const out = [[u, v]], R = DEPOT.R;
  for (const [k, a] of ops) {
    if (k === 'S') { const n = Math.max(1, Math.ceil(a)); for (let i = 1; i <= n; i++) out.push([u + (du * a * i) / n, v + (dv * a * i) / n]); u += du * a; v += dv * a; continue; }
    const s = k === 'L' ? 1 : -1, nx = -dv * s, nv = du * s; // (left of (du, dv) is (-dv, du))
    const cu = u + nx * R, cv = v + nv * R, n = Math.max(2, Math.ceil(a * R));
    const ru = u - cu, rv = v - cv;
    for (let i = 1; i <= n; i++) { const b = (s * a * i) / n, c = Math.cos(b), sn = Math.sin(b); out.push([cu + ru * c - rv * sn, cv + ru * sn + rv * c]); }
    const b = s * a, c = Math.cos(b), sn = Math.sin(b);
    u = cu + ru * c - rv * sn; v = cv + ru * sn + rv * c;
    [du, dv] = [du * c - dv * sn, du * sn + dv * c];
  }
  return out;
}
// the track in world space, moved half a road to its left (the bus drives the right lane of the line it is given)
function toWorld(D, tr) {
  const L = D.lot, n = tr.length, out = [];
  const W = ([u, v]) => [L.x + L.ux * u + L.vx * v, L.z + L.uz * u + L.vz * v];
  for (let i = 0; i < n; i++) {
    const a = W(tr[Math.max(0, i - 1)]), b = W(tr[Math.min(n - 1, i + 1)]), p = W(tr[i]);
    const hx = b[0] - a[0], hz = b[1] - a[1], hl = Math.hypot(hx, hz) || 1;
    out.push([p[0] + (hz / hl) * DEPOT.LANE, p[1] + (-hx / hl) * DEPOT.LANE]);
  }
  return out;
}
function trip(pts, Y, to, s0, s1Of) {
  const n = pts.length, X = new Float32Array(n), Z = new Float32Array(n), YY = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) { X[i] = pts[i][0]; Z[i] = pts[i][1]; YY[i] = Y[i]; if (i) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]); }
  const t = { n, X, Y: YY, Z, S, length: S[n - 1], to, s0 };
  t.s1 = s1Of(t.length);
  return t;
}
/** Bay k's ways (bus.js fleetDir trips): in = from the stop's end (P0) to the bay's middle (its mark there), out = from
 *  the bay's middle (s0) to the stop's end, its mark (boarding at the sign) BAY m on along the village road. Null when
 *  there is no depot. */
export function depotTrips(k, bay = 7) {
  const D = busRoads.depot;
  if (!D) return null;
  const { AU, R, LANE, HD, VB, EXT } = DEPOT, vk = bayV(k), A = D.road, y = D.lot.y;
  // in: up the right aisle, left into the bay, to its middle and on a little
  const tin = toWorld(D, track(AU, -HD + 1, 0, 1, [['S', vk - R - (-HD + 1)], ['L', Math.PI / 2], ['S', AU - R + EXT]]));
  // out: from a little behind the bay's middle on out of it, down the left aisle, along the bottom, out at the mouth
  const tout = toWorld(D, track(EXT, vk, -1, 0, [['S', EXT + AU - R], ['L', Math.PI / 2], ['S', vk - R - (VB + R)], ['L', Math.PI / 2], ['S', 2 * AU - 2 * LANE - 2 * R], ['R', Math.PI / 2], ['S', Math.max(0, VB - R - (-HD + 1))]]));
  const road = [], roadY = [];
  for (let i = 0; i < A.n; i++) { road.push([A.X[i], A.Z[i]]); roadY.push(A.Y[i]); } // (mouth -> P0)
  // in: the Depotweg from P0 to the mouth, then the lot
  const inPts = road.slice().reverse().concat(tin.slice(1)), inY = roadY.slice().reverse().concat(tin.slice(1).map(() => y));
  const out = tout.concat(road.slice(1)), outY = tout.map(() => y).concat(roadY.slice(1));
  return {
    in: trip(inPts, inY, DEPOT_STOP, 0, (len) => len - EXT),
    out: trip(out, outY, busRoads.stops[0], EXT, (len) => len + bay),
  };
}
