// The Autohausweg (Oct 29, the user: "make a road from the car dealership but the other side towards Legacy Village,
// to the right or left"): a second way between the car rental and Legacy Village. It leaves the valley road at a T
// junction right across from the car rental's forecourt, swings off to the left (west) over the open flat ground
// behind the village in one long sweep, round past the north side of the village buildings, and comes back onto the
// valley road at a second T junction just above the Legacy Village stop (on the other side from the car park's
// access road). A scenic road (scenic.js carves it, scenicdrive.js drives a few cars along it), both ends exits onto
// the valley road. Pure layout (no THREE): runs in Node too.
// Kept off: the village buildings, the Silberhorn Gondola's station and pad, pistes, the valley road (but at its two
// junctions), the car rental, the medical centre and the car park.
// (roads.js imports this module and it imports roads.js / chaletroad.js: their bindings are only used inside functions)
import { world } from '../../world/world.js';
import { busRoads, makeRoad, roadAt, laneDistance } from './roads.js';
import { filleted } from './chaletroad.js';

const SOUTH_NEAR = { x: 65, z: 110 }; // the T junction above the village stop (on the valley road)
// the sweep (corners rounded by filleted): off the valley road square to it, west along the flat behind the village,
// round to the south-east past the north side of the village buildings, square onto the valley road again
const WEST = [[40, 214], [-24, 200], [2, 140]];
const RADII = [35, 40, 40];
const LEAD = 26; // m straight out of each junction, square to the valley road (a clean T mouth)
const GRADE = 0.08;

/** Plan the Autohausweg (appended to busRoads.roads, its two T junctions to busRoads.junctions). */
export function planRentalRoad(O) {
  const R = busRoads.rental;
  if (!R) return;
  const r0 = busRoads.roads[R.ri];
  if (!r0 || r0.access || r0.from !== busRoads.stops[0]) { console.warn('Autohausweg: the car rental is not on the valley road'); return; }
  // the north junction: across from the car rental (its forecourt on side R.side: the new road leaves on the other)
  const out = (s, side) => { const p = roadAt(r0, s); return { x: p.x, z: p.z, y: p.y, s, nx: -p.dz * side, nz: p.dx * side }; };
  const N = out(R.s, -R.side);
  // the south junction: the valley road's nearest point to SOUTH_NEAR, the road leaving on the same side as N
  let sS = 0, bd = Infinity;
  for (let i = 0; i < r0.n; i++) { const d = Math.hypot(r0.X[i] - SOUTH_NEAR.x, r0.Z[i] - SOUTH_NEAR.z); if (d < bd) { bd = d; sS = r0.S[i]; } }
  if (bd > 30 || sS > N.s - 60) { console.warn('Autohausweg: no room for the south junction'); return; }
  const S = out(sS, -R.side);
  const corners = [[N.x, N.z], [N.x + N.nx * LEAD, N.z + N.nz * LEAD], ...WEST, [S.x + S.nx * LEAD, S.z + S.nz * LEAD], [S.x, S.z]];
  const pts = filleted(corners, [0, 40, ...RADII, 0, 0]);
  // (the two lead-in corners are straight joins: drop the duplicate-ish points filleted leaves at a zero radius)
  for (let i = pts.length - 2; i > 0; i--) if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < 1.5) pts.splice(i, 1);
  pts[0] = [N.x, N.z]; pts[pts.length - 1] = [S.x, S.z];
  // the clearances (warned, not fatal: the layout is fixed)
  const q = {};
  let worst = null;
  for (const [x, z] of pts) {
    O.query(x, z, q);
    const c = world.corridorAt(x, z), dEnd = Math.min(Math.hypot(x - N.x, z - N.z), Math.hypot(x - S.x, z - S.z));
    const why = q.ski < 10 ? 'piste' : q.lift < 6 ? 'lift' : q.block < 12 ? 'building' : (c.kind === 'piste' || c.kind === 'race') && c.d < 10 ? 'piste' : dEnd > 30 && laneDistance(x, z) < 20 ? 'road' : null;
    if (why && !worst) worst = { why, x: Math.round(x), z: Math.round(z) };
  }
  if (worst) console.warn('Autohausweg: the road runs close to', worst);
  const road = makeRoad(pts, { name: 'junction', x: N.x, z: N.z }, { name: 'junction', x: S.x, z: S.z }, { y0: N.y, y1: S.y, maxGrade: GRADE, envelope: true });
  road.name = 'Autohausweg'; road.access = true; road.scenic = true; road.rentalRoad = true;
  road.exitAt0 = { road: r0, s: N.s, x: N.x, z: N.z };
  road.exitAt1 = { road: r0, s: S.s, x: S.x, z: S.z };
  busRoads.roads.push(road);
  busRoads.junctions.push({ x: N.x, z: N.z, scenic: true, road: r0, s: N.s, arm: road }, { x: S.x, z: S.z, scenic: true, road: r0, s: S.s, arm: road });
  busRoads.rentalRoad = road;
}
