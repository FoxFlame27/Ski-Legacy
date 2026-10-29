// The Westgratstrasse (Oct 29, the user: "PLS fix this road it leads no where its supposed to be a long road like
// into the mountains"): it replaces the Autohausweg (a 240 m loop off the valley road behind the village that just
// came back). It leaves the valley road at the same T junction, right across from the car rental's forecourt, runs
// west out of the village over the open flat behind it (across the foot of the Legacy Village piste's run-out, where
// it is a narrow trail), north-west past the lift, and up the free mountain inside the Legacy Express's loop
// north-west of the village (the Westgrat, ~500 m above the village) in long flowing curves on the ground
// (scenic.js climb: the heading-aware A* routed, the road's height following the ground within ~11 %), to the
// Westgrat car park on top: a viewpoint over the valley. A scenic road (scenic.js carves it, the scenic traffic drives
// it: s = 0 at the car park, its end the T junction on the valley road), with a bus stop at the top (scenicbus.js).
// Pure layout (no THREE): runs in Node too.
// Kept off: pistes (but that one crossing), lifts, buildings, the Express, other roads (but at its junction), the car
// parks, the car rental.
// (roads.js imports this module and it imports roads.js / scenic.js: their bindings are only used inside functions)
import { world } from '../../world/world.js';
import { expressNearest } from '../../world/expressroute.js';
import { busRoads, makeRoad, roadAt, laneDistance, smoothPath, CLEAR } from './roads.js';
import { climb, lotAt, findLaybys } from './scenic.js';

const GRADE = 0.115;
const LEAD = 30;                                         // m straight out of the junction, square to the valley road
const TOP_AT = { x: -1250, z: 900 };                     // the Westgrat (the free mountain inside the Express's loop)
const BOX = { minx: -1900, maxx: 260, minz: 60, maxz: 1250 };
const PISTE_XING = { minx: -300, maxx: -100, minz: 140, maxz: 330 }; // (the run-out it crosses: a narrow trail there)
const DBG = (...a) => { if (globalThis.process?.env?.SCENIC_DEBUG) console.log(...a); };

// no-go ground for the road (the junction's mouth aside)
function badWest(O, J) {
  const q = {};
  return (x, z) => {
    if (x < BOX.minx || x > BOX.maxx || z < BOX.minz || z > BOX.maxz) return true;
    const dJ = Math.hypot(x - J.x, z - J.z);
    O.query(x, z, q);
    if (q.ski < CLEAR.ski + 8 || q.lift < 14 || q.block < CLEAR.block + 4 || q.rail < 20 || q.net < 12) return true;
    const c = world.corridorAt(x, z);
    const xing = x > PISTE_XING.minx && x < PISTE_XING.maxx && z > PISTE_XING.minz && z < PISTE_XING.maxz;
    if ((c.kind === 'piste' || c.kind === 'race') && c.d < (xing ? -12 : 24)) return true;
    const e = expressNearest(x, z);
    if (e && e.d < 55) return true;
    const R = busRoads.rental;
    if (R && dJ > 40 && Math.hypot(x - R.x, z - R.z) < 45) return true;
    for (const L of busRoads.lots) {
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx) > 80 || Math.abs(dz) > 80) continue;
      const u = Math.abs(dx * L.ux + dz * L.uz) - L.hw, v = Math.abs(dx * L.vx + dz * L.vz) - L.hd;
      if (Math.hypot(Math.max(0, u), Math.max(0, v)) < 20) return true;
    }
    if (dJ < 45) return false;
    return laneDistance(x, z) < 26;
  };
}

/** Plan the Westgratstrasse (appended to busRoads.roads, its T junction to busRoads.junctions, its car park to lots). */
export function planRentalRoad(O) {
  const R = busRoads.rental;
  if (!R) return;
  const r0 = busRoads.roads[R.ri];
  if (!r0 || r0.access || r0.from !== busRoads.stops[0]) { console.warn('Westgratstrasse: the car rental is not on the valley road'); return; }
  // the junction: across from the car rental (its forecourt on side R.side: the new road leaves on the other)
  const p = roadAt(r0, R.s), nx = p.dz * R.side, nz = -p.dx * R.side;
  const J = { x: p.x, z: p.z, y: p.y, s: R.s };
  const bad = badWest(O, J);
  const lead = [];
  for (let t = 0; t <= LEAD; t += 4) lead.push([J.x + nx * t, J.z + nz * t]);
  if (lead.some(([x, z], i) => i > 3 && bad(x, z))) { console.warn('Westgratstrasse: no room out of the junction'); return; }
  const B = { x: lead[lead.length - 1][0], z: lead[lead.length - 1][1] };
  // the top: the highest clear ground round the Westgrat
  let top = null;
  for (let dx = -400; dx <= 400; dx += 25) for (let dz = -300; dz <= 300; dz += 25) {
    const x = TOP_AT.x + dx, z = TOP_AT.z + dz;
    if (bad(x, z)) continue;
    const h = world.height(x, z, 8);
    if (!top || h > top.h) top = { x, z, h };
  }
  if (!top) { console.warn('Westgratstrasse: no top'); return; }
  const y0 = J.y + 0.03 * LEAD;
  // (as high as it goes on the ground: the Westgrat's top block is steep all round (a road up it would stand on 200 m
  // of fill), so the car park sits on its shoulder, as high as the long flowing climb up the open slope gets)
  let ZZ = null;
  for (const rise of [280, 240, 200]) {
    const topH = Math.min(top.h - 6, y0 + rise);
    const r = climb(B, Math.atan2(nx, nz), y0, O, null, { topH, bad, noComb: true, noFlow: true, target: top, margin: 600, routeVariants: [{ maxGrade: 0.09, grK: 1, maxTurn: 1.2 }, { maxGrade: 0.1, grK: 0.3, maxTurn: 1.0 }] });
    DBG('Westgrat climb', rise, r && r.dev.toFixed(1), r && r.pts.length * 4);
    if (r && r.dev < 12 && r.devBig < 0.35) { ZZ = r; break; }
    if (r && (!ZZ || r.dev < ZZ.dev)) ZZ = r;
  }
  if (!ZZ) { console.warn('Westgratstrasse: no way up'); return; }
  DBG('Westgrat climb', 'len', ZZ.pts.length * 4, 'dev', ZZ.dev?.toFixed(1), 'top', Math.round(top.x), Math.round(top.z), Math.round(top.h));
  // (the corner where the lead turns onto the climb rounded)
  const zz = ZZ.pts.slice(1), up = [...lead.slice(0, -4), ...smoothPath([...lead.slice(-4), ...zz.slice(0, 12)], 4, 4), ...zz.slice(12)];
  // the Westgrat car park where it ends (a viewpoint: no boards)
  const e = up.length, hx0 = up[e - 1][0] - up[e - 3][0], hz0 = up[e - 1][1] - up[e - 3][1], hl = Math.hypot(hx0, hz0) || 1;
  const lot = lotAt({ size: 'small', name: 'Westgrat car park', hw: 15, hd: 9 }, up[e - 1][0] + (hx0 / hl) * 4, up[e - 1][1] + (hz0 / hl) * 4, hx0 / hl, hz0 / hl);
  for (let a = -lot.hw - 3; a <= lot.hw + 3; a += 5) for (let b = -lot.hd - 3; b <= lot.hd + 3; b += 5) if (bad(lot.x + lot.ux * a + lot.vx * b, lot.z + lot.uz * a + lot.vz * b)) { console.warn('Westgratstrasse: no room for the car park'); return; }
  const yEnd = Math.min(ZZ.yEnd, world.height(up[e - 1][0], up[e - 1][1]));
  lot.y = Math.min(yEnd + Math.max(-2.5, Math.min(2.5, lot.y - yEnd)), J.y + 0.105 * 4 * up.length); // (never more than the road can climb)
  const pts = [[lot.ex - lot.dirx * 7, lot.ez - lot.dirz * 7], [lot.ex, lot.ez], ...up.slice().reverse()];
  pts[pts.length - 1] = [J.x, J.z];
  const road = makeRoad(pts, { name: lot.name, x: lot.ex, z: lot.ez, lot: true }, { name: 'junction', x: J.x, z: J.z }, { y0: lot.y, y1: J.y, maxGrade: GRADE, envelope: true });
  road.name = 'Westgratstrasse'; road.access = true; road.scenic = true; road.loop = true; road.westRoad = true;
  road.lot0 = lot;
  road.exitAt1 = { road: r0, s: J.s, x: J.x, z: J.z };
  busRoads.roads.push(road);
  busRoads.lots.push(lot);
  busRoads.junctions.push({ x: J.x, z: J.z, scenic: true, road: r0, s: J.s, arm: road });
  busRoads.rentalRoad = road;
  try { findLaybys(road, { max: 3, apart: 700 }); } catch (err) { console.warn('Westgratstrasse lay-bys', err); }
  DBG('Westgratstrasse', Math.round(road.length), 'm, from', Math.round(J.y), 'to', Math.round(lot.y));
}
