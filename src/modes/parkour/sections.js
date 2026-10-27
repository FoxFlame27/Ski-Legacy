// Section helpers for the World Racing course designs (courses.js, newcourses.js): jumps and rollers as
// runs of track sections.
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ section helpers
// A jump: in-run, a planar table carrying the ramp (lip at the end of the table), a landing hill that
// steepens with distance (so short and long flights both land on a slope that matches their descent),
// a transition and an out-run. Profiles were tuned with ballistic simulations (see the Node tests):
//  - 'downhill' jumps (alpine): small lip on a steep table -> low, fast flights that land softly
//    at any race speed (12-36 m/s)
//  - 'freeride' jumps (big air): bigger ramps and a slightly more open takeoff, same principle
//   land: [[grade, length], ...] knuckle -> faces -> transition
export const LAND_SMOOTH = [8, 14, 20, 24, 30, 36];
export const DOWNHILL_LAND = [[0.6, 4], [0.6, 35], [0.8, 50], [0.5, 30], [0.35, 40]];
export const FREERIDE_LAND = [[0.58, 4], [0.55, 32], [0.75, 50], [0.45, 25], [0.32, 35]];
// big air: a longer main face so fast straight-line approaches (35-42 m/s) still land on the slope
export const BIG_LAND = [[0.58, 4], [0.55, 32], [0.74, 80], [0.45, 25], [0.3, 35]];
export function kicker({ h = 2, lip = 12, tableG = 0.32, w = 10, inrun = 32, inG = 0.24, land = FREERIDE_LAND, out = 60, outG = 0.12, side = 'valley', barrier = 'bnet', forest, anet, type = 'kicker', deck = 0 }) {
  const lr = lip * DEG;
  const R = h / (1 - Math.cos(lr)), up = R * Math.sin(lr);
  const total = type === 'tabletop' ? up + deck + h * 5 : up;
  const base = 5;
  const o = { w, side, barrier, forest, anet };
  return [
    { tag: 'kickIn', len: inrun, grade: inG, smooth: 30, ...o },
    { tag: 'kickTable', len: Math.ceil(total + base + (type === 'tabletop' ? 1 : 0)), grade: tableG, smooth: 8, ...o, ramp: { type, h, lip, base, deck } },
    ...land.map(([grade, len], k) => ({ tag: k === land.length - 1 ? 'kickTrans' : 'kickLand', len, grade, smooth: LAND_SMOOTH[k], ...o })),
    { tag: 'kickOut', len: out, grade: outG, smooth: 40, ...o },
  ];
}

// A set of rollers on a constant-grade stretch.
export function rollers({ n = 4, h = 1.1, gap = 15, grade = 0.2, w = 14, side = 'valley', barrier = 'bnet' }) {
  const len = h * 9;
  return [{ tag: 'rollers', len: Math.ceil(n * (len + gap) + gap), grade, smooth: 30, w, side, barrier, rollers: { n, h, len, gap } }];
}

