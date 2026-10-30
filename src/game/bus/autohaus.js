// The AUTOHAUS's grounds beside the hall: its car park (game/impound.js: the bays your cars wait in, the tow yard) and
// the Werkstatt's site (game/werkstatt.js), planned with the roads (roads.js planAutohausGrounds, before the terrain is
// built) so the roads' world cut levels them like every other car park and forecourt (Oct 30, the user: "over here
// there is something that is higher so I can't park there ... make sure all parking lots are straight"; "parking lots
// and roads should always stay straight, no snow bump kind of things"). Before, both were planned at run time, after
// the terrain: the car park lay on the natural slope (up to ~1.4 m across it) with the road's plough berm running
// through its front row of bays (a lumpy snow ridge you could not drive into the bays over), and the berm crossed the
// Werkstatt's apron too.
// - The car park: beside the Autohaus's lot along its road (either side), square to the road where it stands, its
//   front edge FRONT m off the plowed edge (the plough berm's ground is inside it: no berm between the road and the
//   bays), clear of the lanes, other lots, the railway, runs and lifts, buildings and forest, on the flattest ground.
//   Its surface follows the road's own profile along the front (lot.toRoad: roads.js lotShape), so it meets the road
//   flush along its whole length: a gentle grade along it (the road's), level across it.
// - The Werkstatt: on the side of the hall away from the car park, else past the car park; its front square to the
//   road, the apron reaching the road's edge (as werkstatt.js planned it). A building lot under it and its apron.
// Pure layout (no THREE): runs in Node too. (roads.js imports this module and it imports roads.js: the bindings are
// only used inside functions.)
import { world } from '../../world/world.js';
import { layout } from '../../world/layout.js';
import { railNearest } from '../../world/railroute.js';
import { busRoads, laneDistance, roadsideBlocked, ROAD_HALF } from './roads.js';

export const PARK = { hw: 18, hd: 9 };           // the car park's half length (along the road) and half depth (two rows of bays)
const FRONT = [1.2, 2.2];                         // m from the plowed edge to the car park's front edge, tried in turn
const SHOP = { W: 14, D: 11 };                    // the Werkstatt's outer size (werkstatt.js SHOP: width along the road, depth)
const ROAD_GAP = [6, 8, 10];                      // the Werkstatt's apron depth (road edge to the bay), tried in turn

const nearLift = (x, z) => (layout.lifts || []).some((l) => {
  const ax = l.bottom.x, az = l.bottom.z, ex = l.top.x - ax, ez = l.top.z - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(ax + ex * t - x, az + ez * t - z) < 8;
});
// the nearest point of road r (or every road) to (x, z), its unit direction there
function nearestRoad(r, x, z) {
  let best = null;
  for (const q of r ? [r] : busRoads.roads) for (let i = 1; i < q.n - 1; i++) {
    const d = (q.X[i] - x) ** 2 + (q.Z[i] - z) ** 2;
    if (!best || d < best.d) best = { d, x: q.X[i], z: q.Z[i], y: q.Y[i], dx: q.X[i + 1] - q.X[i - 1], dz: q.Z[i + 1] - q.Z[i - 1] };
  }
  if (!best) return null;
  const l = Math.hypot(best.dx, best.dz) || 1; best.dx /= l; best.dz /= l;
  return best;
}
// colliders standing in a rect (run time: buildings, lamps, signs), the village buildings (planning: the obstacles)
function crowded(colliders, O, cx, cz, ux, uz, vx, vz, eu, ev0, ev1) {
  let n = 0;
  for (const c of colliders) {
    if (!c || c.car || !Number.isFinite(c.x) || c.x > 1e8) continue;
    const r = c.r ?? Math.hypot(c.hw || 0, c.hd || 0), dx = c.x - cx, dz = c.z - cz;
    if (Math.abs(dx) > eu + Math.max(-ev0, ev1) + r + 2 || Math.abs(dz) > eu + Math.max(-ev0, ev1) + r + 2) continue;
    const a = dx * ux + dz * uz, b = dx * vx + dz * vz;
    if (Math.abs(a) < eu + r && b < ev1 + r && b > ev0 - r) n++;
  }
  if (O) {
    const q = {};
    for (let a = -eu; a <= eu + 0.01; a += 4) for (let b = ev0; b <= ev1 + 0.01; b += 4) { O.query(cx + ux * a + vx * b, cz + uz * a + vz * b, q); if (q.block < 2) n++; }
  }
  return n;
}

// a lot's rect (centre, axes, half sizes, its own flat apron) far enough from every other lot's (but skip) that the two
// flat aprons never meet: each eases into the ground between them (no step where two levels would meet)
const lotOut = (L, x, z) => { const dx = x - L.x, dz = z - L.z; return Math.hypot(Math.max(0, Math.abs(dx * L.ux + dz * L.uz) - L.hw), Math.max(0, Math.abs(dx * L.vx + dz * L.vz) - L.hd)); };
function clearOfLots(cx, cz, ax, az, vx, vz, hw, hd, flat, skip = null) {
  for (const L of busRoads.lots) {
    if (L === skip || L.ux === undefined || !Number.isFinite(L.x)) continue;
    if (Math.hypot(L.x - cx, L.z - cz) > Math.hypot(L.hw, L.hd) + Math.hypot(hw, hd) + 60) continue;
    const need = Math.max(L.flat ?? 2.9, flat) + 4;
    for (let u = -hw; u <= hw + 0.01; u += 2) for (const v of [-hd, hd]) if (lotOut(L, cx + ax * u + vx * v, cz + az * u + vz * v) < need) return false;
    for (let v = -hd; v <= hd + 0.01; v += 2) for (const u of [-hw, hw]) if (lotOut(L, cx + ax * u + vx * v, cz + az * u + vz * v) < need) return false;
  }
  return true;
}

/** The Autohaus car park beside the rental's lot RL (busRoads.rental): a lot like parking.js's car parks, or null. */
export function planRentalPark(RL, { colliders = [], O = null } = {}) {
  if (!RL || !busRoads.roads.length) return null;
  const road = busRoads.roads[RL.ri] || null;
  const fx = RL.dirx, fz = RL.dirz, ux = fz, uz = -fx; // (the Autohaus lot: f toward the road, u along it)
  const { hw, hd } = PARK;
  const corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
  let best = null;
  const tryAt = (cu, front, fallback = false) => {
    // abreast of the candidate on the Autohaus's side of the road: the road there, the car park square to it
    const bx = RL.x + ux * cu + fx * RL.hd, bz = RL.z + uz * cu + fz * RL.hd;
    const rp = nearestRoad(road, bx, bz);
    if (!rp) return;
    let nx = -rp.dz, nz = rp.dx; // (away from the road, toward the Autohaus's side)
    if ((bx - rp.x) * nx + (bz - rp.z) * nz < 0) { nx = -nx; nz = -nz; }
    const off = ROAD_HALF + front + hd, cx = rp.x + nx * off, cz = rp.z + nz * off;
    const vx = -nx, vz = -nz, ax = vz, az = -vx; // (v toward the road, u along it)
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0, bad = 0;
    for (let u = -hw - 1; u <= hw + 1.01; u += 3) for (let v = -hd - 1; v <= hd - 0.5; v += 2.5) {
      const x = cx + ax * u + vx * v, z = cz + az * u + vz * v;
      if (laneDistance(x, z) < ROAD_HALF + 0.8) return;
      const rn = railNearest(x, z);
      if (rn && rn.d < 12) return;
      world.corridorAt(x, z, corr);
      if (corr.kind && corr.kind !== 'lift' && corr.d < 3) return; // (runs, lanes; a lift's wide corridor covers the rental too:)
      if (nearLift(x, z)) return; // (its line itself)
      const h = world.height(x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h; n++;
      const sl = Math.hypot(world.height(x + 1, z) - h, world.height(x, z + 1) - h);
      try { if (world.forest(x, z, h, sl) > 0.25) bad++; } catch { /* (no forest map) */ }
    }
    if (hi - lo > (fallback ? 6 : 3.5)) return;
    // (clear of every other lot, the Autohaus's own too: its flat apron reaches 6.8 m past its edge)
    if (!clearOfLots(cx, cz, ax, az, vx, vz, hw, hd, 2.9)) return;
    // a junction's mouth or a lay-by on its front: not there (the road there is not a straight edge to drive in from)
    // (only on this side of the road: one across it is no matter)
    const ours = (p) => (p.x - rp.x) * nx + (p.z - rp.z) * nz > 0;
    for (const j of busRoads.junctions) if (ours(j) && Math.hypot(j.x - cx, j.z - cz) < Math.hypot(hw, hd) + 16) return;
    for (const lb of busRoads.laybys || []) if (ours(lb) && Math.hypot(lb.x - cx, lb.z - cz) < Math.hypot(hw, hd) + 14) return;
    bad += 3 * crowded(colliders, O, cx, cz, ax, az, vx, vz, hw + 1, -hd - 1, hd + 1);
    const mean = sum / n, ry = rp.y;
    // (the ground's own lie, how far it is from the road's height, the forest and buildings in it, how far along)
    const score = (hi - lo) + Math.abs(mean - ry) * 0.4 + bad * 2 + Math.abs(cu) * 0.02 + front * 0.3 + (fallback ? 20 : 0);
    if (!best || score < best.score) best = { cx, cz, ax, az, vx, vz, y: ry, score, bad };
  };
  for (const side of [1, -1]) for (const du of [46, 48, 51, 55, 60]) for (const front of FRONT) tryAt(side * du, front);
  if (!best || best.bad > 6) for (const side of [1, -1]) for (const du of [60, 68, 78]) for (const front of FRONT) tryAt(side * du, front, true);
  if (!best) return null;
  const { cx, cz, ax, az, vx, vz } = best;
  return {
    name: 'Autohaus car park', size: 'big', impound: true, x: cx, z: cz, y: best.y, yaw: Math.atan2(ax, az), hw, hd, ux: ax, uz: az, vx, vz,
    ex: cx + vx * (hd + 2), ez: cz + vz * (hd + 2), dirx: vx, dirz: vz,
    toRoad: -Infinity, // (roads.js lotShape: its surface follows the road's profile along the front, all the way back)
  };
}

/** The Werkstatt's site beside the Autohaus: { x, z (the building's middle), ax, az (along the road), fx, fz (toward
 *  it), lo, hi, gap (the apron's depth), score, hits } or null. park: the Autohaus car park (to keep clear of). */
export function planWerkstattSite(RL, park, { colliders = [], O = null } = {}) {
  if (!RL || !busRoads.roads.length) return null;
  const road = busRoads.roads[RL.ri] || null;
  const fx = RL.dirx, fz = RL.dirz, ux = fz, uz = -fx; // (the Autohaus lot: f toward the road, u along it)
  const imp = park || null;
  const impU = imp ? (imp.x - RL.x) * ux + (imp.z - RL.z) * uz : 40;
  const away = impU >= 0 ? -1 : 1;
  const cands = [34, 36, 39, 43, 48].map((du) => ({ u: away * du, pen: 0 }));
  if (imp) for (const extra of [16, 19, 23]) cands.push({ u: Math.sign(impU || 1) * (Math.abs(impU) + imp.hw + extra), pen: 4 });
  const { W, D } = SHOP, DX0 = -5.9, DX1 = -1.1, corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
  let best = null;
  const tryAt = (cand, gap, rise = 2.2) => {
    // a point on the Autohaus's side of the road, abreast of the candidate; the road there; the garage square to it
    const bx = RL.x + ux * cand.u + fx * RL.hd, bz = RL.z + uz * cand.u + fz * RL.hd;
    const rp = nearestRoad(road, bx, bz);
    if (!rp) return;
    let nx = -rp.dz, nz = rp.dx; // (the road's normal toward the Autohaus's side)
    if ((bx - rp.x) * nx + (bz - rp.z) * nz < 0) { nx = -nx; nz = -nz; }
    const off = ROAD_HALF + gap + D / 2, cx = rp.x + nx * off, cz = rp.z + nz * off;
    const F = { x: -nx, z: -nz }, A = { x: F.z, z: -F.x }; // (garage +z: toward the road; +x along it)
    const at = (lx, lz) => [cx + A.x * lx + F.x * lz, cz + A.z * lx + F.z * lz];
    let lo = Infinity, hi = -Infinity, bad = 0;
    for (let lx = -W / 2 - 1; lx <= W / 2 + 1.01; lx += 2) for (let lz = -D / 2 - 1; lz <= D / 2 + 1.01; lz += 2) {
      const [x, z] = at(lx, lz);
      if (laneDistance(x, z) < ROAD_HALF + 1.2) return;
      if (roadsideBlocked(x, z, 0.4, -1, 0, { lots: true })) return; // (a junction, a car park, a lay-by)
      const rn = railNearest(x, z);
      if (rn && rn.d < 12) return;
      world.corridorAt(x, z, corr);
      if (corr.kind && corr.kind !== 'lift' && corr.d < 3) return;
      if (nearLift(x, z)) return;
      if (imp) { const dx = x - imp.x, dz = z - imp.z; if (Math.abs(dx * imp.ux + dz * imp.uz) < imp.hw + 2 && Math.abs(dx * imp.vx + dz * imp.vz) < imp.hd + 2) return; }
      const h = world.height(x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      const sl = Math.hypot(world.height(x + 1, z) - h, world.height(x, z + 1) - h);
      try { if (world.forest(x, z, h, sl) > 0.25) bad++; } catch { /* (no forest map) */ }
    }
    if (hi - lo > rise) return;
    // the apron: from the bay to the road's edge (no junction mouth on it)
    for (let lz = D / 2 + 1; lz < D / 2 + gap - 1.5; lz += 2) for (const lx of [DX0, (DX0 + DX1) / 2, DX1]) {
      const [x, z] = at(lx, lz);
      const why = roadsideBlocked(x, z, 0.4);
      if (why && why !== 'lane') bad += 4;
    }
    // (its lot, apron and all, clear of every other lot's flat ground: no step where two levels would meet)
    { const back = -D / 2 - 1, front = D / 2 + gap - 0.6, mid = (back + front) / 2; if (!clearOfLots(cx + F.x * mid, cz + F.z * mid, A.x, A.z, F.x, F.z, W / 2 + 1.5, (front - back) / 2, 2.9)) return; }
    const hits = crowded(colliders, O, cx, cz, A.x, A.z, F.x, F.z, W / 2 + 1, -D / 2 - 1, D / 2 + gap);
    const score = (hi - lo) * 2 + bad * 2 + hits * 12 + Math.abs(cand.u) * 0.03 + gap * 0.25 + cand.pen;
    if (!best || score < best.score) best = { x: cx, z: cz, ax: A.x, az: A.z, fx: F.x, fz: F.z, lo, hi, gap, score, hits, ry: rp.y };
  };
  for (const c of cands) for (const g of ROAD_GAP) tryAt(c, g);
  // (nothing flat enough: either side, further along, on steeper ground)
  if (!best) for (const du of [34, 38, 44, 52, 60, 70, 80]) for (const sd of [away, -away]) for (const g of ROAD_GAP) tryAt({ u: sd * du, pen: 6 }, g, 4);
  return best;
}

/** roads.js: the car park and the Werkstatt's lot into busRoads.lots (levelled by the roads' cut), after every other lot. */
export function planAutohausGrounds(O) {
  const RL = busRoads.rental;
  if (!RL) return;
  const park = planRentalPark(RL, { O });
  if (park) { busRoads.lots.push(park); busRoads.rentalPark = park; }
  const s = planWerkstattSite(RL, park, { O });
  if (!s) return;
  // its lot: the building (1 m round its back and sides) and the apron to 0.6 m short of the plowed edge, level at the
  // road's height under the building, easing to the road's own profile across the apron (toRoad: from the bay's sill)
  const back = -SHOP.D / 2 - 1, front = SHOP.D / 2 + s.gap - 0.6, mid = (back + front) / 2, hd = (front - back) / 2, hw = SHOP.W / 2 + 1.5;
  const x = s.x + s.fx * mid, z = s.z + s.fz * mid;
  const lot = { name: 'Werkstatt', building: true, werkstatt: true, x, z, y: s.ry, yaw: Math.atan2(s.ax, s.az), hw, hd, ux: s.ax, uz: s.az, vx: s.fx, vz: s.fz,
    ex: s.x + s.fx * (front + 0.6), ez: s.z + s.fz * (front + 0.6), dirx: s.fx, dirz: s.fz, flat: 2.9, toRoad: SHOP.D / 2 - mid, site: s };
  busRoads.lots.push(lot);
  busRoads.werkstatt = lot;
}
