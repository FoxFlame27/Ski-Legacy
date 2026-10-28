// The chalet's plan (pure data, no THREE): the Almdorf chalets (world/chalets.js outside, game/chaletroom.js inside)
// are all the same house, so one plan serves every one of them. House frame, metres: +x = the front (the entrance
// side, facing downhill to the road), z along the house (its long side, 12 m), y up from the ground (the pad).
// The outside model (chalet.glb, the user's Meshy chalet) is scaled so its body is HX*2 x HZ*2; the plan's walls,
// windows and front door sit where the model's are (measured from the model, roughly).
//
//   ground floor (floor G, ceiling GC, white plaster walls, plank floor, timber ceiling with beams)
//     entrance hall (the front door in the middle of the front), the open living room / kitchen (the -z end, full
//     width), the bathroom (front, +z of the hall), the snug (the +z end), the stair (along z, behind the hall)
//   upper floor (floor FL, timber walls and sloped timber ceiling under the roof, dormers in the middle band)
//     bedroom A (-z gable), bedroom B (front, middle, dormer), bedroom C (+z gable), the bathroom (back, middle,
//     dormer), the landing and a corridor along the stairwell
export const HX = 3.94, HZ = 6.0, T = 0.3;          // half depth / half length (outer faces), exterior wall thickness
export const IX = HX - T, IZ = HZ - T;               // inner faces
export const G = 0.35, GC = 2.95, FL = 3.3;          // ground floor, its ceiling, the upper floor
export const KNEE = 1.2, COLLAR = 3.2, PITCH = 0.94; // upstairs: knee wall height, the flat collar ceiling, roof rise per m
export const DORMER = { z0: -2.6, z1: 2.6, h: 2.5 };  // the dormers (both long sides, the middle band): their ceiling
export const IT = 0.12;                              // interior wall thickness
export const STAIR = { x0: -1.7, x1: -0.7, z0: -2.8, z1: 1.6, steps: 16 }; // foot (z0, floor G) to top (z1, floor FL)
export const HOLE = { x0: -1.7, x1: -0.7, z0: -2.2, z1: 1.6 };             // the stairwell in the upper floor
export const DOOR = { z: -0.25, w: 1.0, h: 2.15 };   // the front door (x = HX)
export const PRICE = 500;                            // a stay (renting the chalet)

/** Upstairs ceiling height (absolute y) at (x, z): the roof slope from the knee walls up to the collar; in the
 *  dormer band never below the dormer's flat ceiling. */
export function ceilingUp(x, z) {
  const slope = KNEE + (IX - Math.abs(x)) * PITCH;
  const dorm = z > DORMER.z0 && z < DORMER.z1 ? DORMER.h : 0;
  return FL + Math.min(COLLAR, Math.max(dorm, slope));
}
/** Ceiling height (absolute) on a level ('ground' | 'up'). */
export const ceilingAt = (x, z, level) => (level === 'up' ? ceilingUp(x, z) : GC);
/** The stair's walking height at z (its run between foot and top). */
export const stairY = (z) => G + Math.max(0, Math.min(1, (z - STAIR.z0) / (STAIR.z1 - STAIR.z0))) * (FL - G);

// the rooms (floor rects, for the build mode and the HUD's room name): x0 < x1, z0 < z1
export const ROOMS = [
  { id: 'living', name: 'Living room & kitchen', level: 'ground', rects: [[-IX, -IZ, IX, -1.2]] },
  { id: 'hall', name: 'Entrance hall', level: 'ground', rects: [[-0.7, -1.2, IX, 1.6]] },
  { id: 'bath0', name: 'Bathroom', level: 'ground', bath: true, rects: [[1.4, 1.6, IX, 4.2]] },
  { id: 'snug', name: 'Snug', level: 'ground', rects: [[-IX, 1.6, 1.4, IZ], [1.4, 4.2, IX, IZ]] },
  { id: 'bedA', name: 'Bedroom', level: 'up', rects: [[-IX, -IZ, IX, -2.6]] },
  { id: 'bedB', name: 'Bedroom', level: 'up', rects: [[0.6, -2.6, IX, 2.6]] },
  { id: 'bedC', name: 'Bedroom', level: 'up', rects: [[-IX, 2.6, IX, IZ]] },
  { id: 'bath1', name: 'Bathroom', level: 'up', bath: true, rects: [[-IX, -2.6, -1.7, 2.6]] },
  { id: 'landing', name: 'Landing', level: 'up', rects: [[-0.7, -2.6, 0.6, 2.6], [-1.7, 1.6, -0.7, 2.6], [-1.7, -2.6, -0.7, -2.2]] },
].map((r) => ({ ...r, rects: r.rects.filter((q) => q[2] > q[0] && q[3] > q[1]).map(([x0, z0, x1, z1]) => ({ x0, z0, x1, z1 })) }));

// the walls. Exterior: their inner face along the line (thickness T outward); a wall's openings: { c (along the wall:
// z for the long sides, x for the gables), w, y0, y1 (absolute), kind: 'window' | 'door' }.
// Interior: centre line a -> b, IT thick; `side` the material either side (+n = the left of a -> b seen from above:
// n = (-dz, dx)); doorways (kind 'door') are openings to walk through.
const gw = (c, w = 1.0) => ({ c, w, y0: G + 0.9, y1: G + 2.15, kind: 'window' });
const uw = (c, w = 0.9, y0 = FL + 0.85, y1 = FL + 2.0) => ({ c, w, y0, y1, kind: 'window' });
export const EXTERIOR = [
  // ground floor
  { level: 'ground', side: 'front', openings: [gw(3.1), gw(-2.9), { c: DOOR.z, w: DOOR.w, y0: G, y1: G + DOOR.h, kind: 'front' }] },
  { level: 'ground', side: 'back', openings: [gw(-3.0), gw(3.55)] },
  { level: 'ground', side: 'west', openings: [gw(1.4), gw(-1.6)] },   // the -z gable (the living room)
  { level: 'ground', side: 'east', openings: [gw(-2.0), gw(2.0), { c: 0, w: 1.3, y0: G + 0.12, y1: G + 2.2, kind: 'window' }] }, // +z gable: the terrace's glass door (fixed)
  // upper floor
  { level: 'up', side: 'front', openings: [uw(0.5), uw(-1.3)] },     // the dormer (bedroom B)
  { level: 'up', side: 'back', openings: [uw(-0.35, 0.8), uw(1.26, 0.8)] }, // the dormer (bathroom)
  { level: 'up', side: 'west', openings: [uw(0, 1.0, FL + 0.9, FL + 2.15)] },
  { level: 'up', side: 'east', openings: [uw(-1.3), uw(1.3)] },
];
const d = (c, w = 0.9, y0 = G, h = 2.05) => ({ c, w, y0, y1: y0 + h, kind: 'door' });
export const INTERIOR = [
  // ground
  { level: 'ground', a: [1.6, -1.2], b: [IX, -1.2], side: ['plaster', 'plaster'] },      // hall | living (the rest open)
  { level: 'ground', a: [-0.7, -1.2], b: [-0.7, 1.6], side: ['plaster', 'plaster'] },    // hall | stair
  { level: 'ground', a: [-1.7, -1.2], b: [-1.7, 1.6], side: ['plaster', 'plaster'] },    // stair | closet
  { level: 'ground', a: [-IX, -1.2], b: [-1.7, -1.2], side: ['plaster', 'plaster'] },    // closet | living
  { level: 'ground', a: [-IX, 1.6], b: [1.4, 1.6], side: ['plaster', 'plaster'], openings: [d(0.15)] },          // -> the snug
  { level: 'ground', a: [1.4, 1.6], b: [IX, 1.6], side: ['plaster', 'tile'], openings: [d(2.5)] },           // -> the bathroom
  { level: 'ground', a: [1.4, 1.6], b: [1.4, 4.2], side: ['tile', 'plaster'] },          // bathroom | snug
  { level: 'ground', a: [1.4, 4.2], b: [IX, 4.2], side: ['plaster', 'tile'] },           // bathroom | snug
  // upper
  { level: 'up', a: [-IX, -2.6], b: [IX, -2.6], side: ['timber', 'timber'], openings: [d(-0.05, 0.85, FL)] }, // bedroom A
  { level: 'up', a: [-IX, 2.6], b: [IX, 2.6], side: ['timber', 'timber'], openings: [d(-0.1, 0.85, FL)] },  // bedroom C
  { level: 'up', a: [0.6, -2.6], b: [0.6, 2.6], side: ['timber', 'timber'], openings: [d(0, 0.85, FL)] },     // bedroom B
  { level: 'up', a: [-1.7, -2.6], b: [-1.7, 2.6], side: ['timber', 'tile'], openings: [d(2.1, 0.8, FL)] },    // the bathroom
];
// (an interior opening's c: the x of it on a wall along x, its z on a wall along z)
// railings round the stairwell (upstairs): walked against, seen through
export const RAILS = [{ a: [-0.7, HOLE.z0], b: [-0.7, HOLE.z1] }, { a: [HOLE.x0, HOLE.z0], b: [HOLE.x1, HOLE.z0] }];

/** An exterior wall's inner-face line on a level: { a, b } (a -> b along the wall, its opening's c measured along
 *  the house axis: z for front/back, x for the gables) and the outward normal. */
export function exteriorLine(side) {
  if (side === 'front') return { a: [IX, -IZ], b: [IX, IZ], n: [1, 0], axis: 'z' };
  if (side === 'back') return { a: [-IX, -IZ], b: [-IX, IZ], n: [-1, 0], axis: 'z' };
  if (side === 'east') return { a: [-IX, IZ], b: [IX, IZ], n: [0, 1], axis: 'x' };
  return { a: [-IX, -IZ], b: [IX, -IZ], n: [0, -1], axis: 'x' };
}
