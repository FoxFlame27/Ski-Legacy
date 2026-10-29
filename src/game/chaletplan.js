// The chalet's plan (pure data, no THREE): the Almdorf chalets (game/chalets.js outside, game/chaletroom.js inside)
// are all the same house, so one plan serves every one of them. House frame, metres: +x = the front (the entrance
// side, facing the road), z along the house (its long side), y up from the ground outside (the pad).
// The outside model (chalet.glb, the user's Meshy chalet, its ground clutter trimmed off) is scaled to a person by
// its front door (measured on the mesh, Oct 28: the door's opening 0.219 model units tall -> 2.15 m, scale 9.8):
// the door 2.15 x 1.4 m (sill 0.3 m up, two steps), the storeys ~2.9 m, sills ~0.9-1.0 m over the floor: the body
// is 2*HX x 2*HZ = 8.04 x 12.15 m (MODEL: how game/chalets.js fits it). The interior lives inside that hull, in the
// world (game/chaletroom.js: one shared instance, placed at the chalet you're at; no scene switch).
//
//   ground floor (floor G, ceiling GC, cream plaster walls, plank floor, timber ceiling with beams)
//     entrance hall (the front door in the middle of the front), the open living room / kitchen (the -z end, full
//     width), the bathroom (front, +z of the hall), the snug (the +z end), the stair (along z, behind the hall)
//   upper floor (floor FL, timber walls and sloped timber ceiling under the roof, dormers in the middle band)
//     bedroom A (-z gable), bedroom B (front, middle, dormer), bedroom C (+z gable), the bathroom (back, middle,
//     dormer), the landing and a corridor along the stairwell
export const MODEL = { scale: 9.8, x: 0.315, z: -0.295, y: -0.405 }; // chalet.glb: its body's centre / ground (model units), the scale
export const HX = 4.02, HZ = 6.08, T = 0.3;          // half depth / half length (outer faces), exterior wall thickness
export const IX = HX - T, IZ = HZ - T;               // inner faces
export const G = 0.3, GC = 2.95, FL = 3.15;          // ground floor (the door's sill), its ceiling (2.65 m clear), the upper floor
export const KNEE = 1.8, COLLAR = 3.2, PITCH = 0.7;  // upstairs: knee height at the inner face, the flat collar ceiling, roof rise per m
export const DORMER = { z0: -2.8, z1: 2.8, h: 2.6 };  // the dormers (both long sides, the middle band): their ceiling
export const IT = 0.12;                              // interior wall thickness
export const STAIR = { x0: -1.83, x1: -0.78, z0: -2.6, z1: 1.72, steps: 16 }; // foot (z0, floor G) to top (z1, floor FL): 0.178 risers, 0.27 treads
export const HOLE = { x0: -1.83, x1: -0.78, z0: -1.9, z1: 1.72 };            // the stairwell in the upper floor
export const DOOR = { z: -0.17, w: 1.3, h: 2.15 };   // the front door (x = HX), its sill at G (the model's opening: z -0.88..0.54)
export const DOOR_CUT = { z0: -0.88, z1: 0.54, x0: HX - 0.55, x1: HX + 0.3 };    // where the model's own (painted) door is cut away
// the model's footprint in the house frame, eaves and front steps included (the plots are laid out round it)
export const FOOT = { x0: -6.2, x1: 5.3, z0: -6.4, z1: 7.1 };
export const STEPS = { x0: HX, x1: HX + 1.3, z0: -1.0, z1: 0.7 };              // the front steps (up to G)
export const DOOR_H = 2.1, DOOR_W = 0.9;             // the doors inside

/** Upstairs ceiling height (absolute y) at (x, z): the roof slope from the knee walls up to the collar; in the
 *  dormer band never below the dormer's flat ceiling. */
export function ceilingUp(x, z) {
  const slope = KNEE + (IX - Math.abs(x)) * PITCH;
  const dorm = z > DORMER.z0 && z < DORMER.z1 ? DORMER.h : 0;
  return FL + Math.min(COLLAR, Math.max(dorm, slope));
}
/** Ceiling height (absolute) on a level ('ground' | 'up'). */
export const ceilingAt = (x, z, level) => (level === 'up' ? ceilingUp(x, z) : GC);
export const RISE = (FL - G) / STAIR.steps, RUN = (STAIR.z1 - STAIR.z0) / STAIR.steps;
/** Standing height on the stair at z: on the tread you are over (exactly the treads' tops; the eye eases between). */
export const stairY = (z) => G + RISE * Math.max(0, Math.min(STAIR.steps, Math.ceil((z - STAIR.z0) / RUN - 1e-6)));

// the rooms (floor rects, for the build mode and the HUD's room name): x0 < x1, z0 < z1
export const ROOMS = [
  { id: 'living', name: 'Living room & kitchen', level: 'ground', rects: [[-IX, -IZ, IX, -1.3]] },
  { id: 'hall', name: 'Entrance hall', level: 'ground', rects: [[-0.78, -1.3, IX, 1.72]] },
  { id: 'bath0', name: 'Bathroom', level: 'ground', bath: true, rects: [[1.5, 1.72, IX, 4.5]] },
  { id: 'snug', name: 'Snug', level: 'ground', rects: [[-IX, 1.72, 1.5, IZ], [1.5, 4.5, IX, IZ]] },
  { id: 'bedA', name: 'Bedroom', level: 'up', rects: [[-IX, -IZ, IX, -2.8]] },
  { id: 'bedB', name: 'Bedroom', level: 'up', rects: [[0.65, -2.8, IX, 2.8]] },
  { id: 'bedC', name: 'Bedroom', level: 'up', rects: [[-IX, 2.8, IX, IZ]] },
  { id: 'bath1', name: 'Bathroom', level: 'up', bath: true, rects: [[-IX, -2.8, -1.83, 2.8]] },
  { id: 'landing', name: 'Landing', level: 'up', rects: [[-0.78, -2.8, 0.65, 2.8], [-1.83, 1.72, -0.78, 2.8], [-1.83, -2.8, -0.78, -1.9]] },
].map((r) => ({ ...r, rects: r.rects.map(([x0, z0, x1, z1]) => ({ x0, z0, x1, z1 })) }));

// the walls. Exterior: their inner face along the line (thickness T outward); a wall's openings: { c (along the wall:
// z for the long sides, x for the gables), w, y0, y1 (absolute), kind: 'window' | 'front' }. Windows: sills 0.9 m
// over the floor. Interior: centre line a -> b, IT thick, doorways (kind 'door', c: the x of it on a wall along x,
// its z on a wall along z) with hinged doors in them.
const gw = (c, w = 1.0) => ({ c, w, y0: G + 0.9, y1: G + 2.25, kind: 'window' });
const uw = (c, w = 0.9, y1 = FL + 2.2) => ({ c, w, y0: FL + 0.9, y1, kind: 'window' });
export const EXTERIOR = [
  // ground floor
  { level: 'ground', side: 'front', openings: [gw(3.38), gw(-2.99), { c: DOOR.z, w: DOOR.w, y0: G, y1: G + DOOR.h, kind: 'front' }] },
  { level: 'ground', side: 'back', openings: [gw(-3.2), gw(3.8)] },
  { level: 'ground', side: 'west', openings: [gw(1.5), gw(-1.72)] },   // the -z gable (the living room)
  { level: 'ground', side: 'east', openings: [gw(-2.15), gw(2.15), { c: 0, w: 1.3, y0: G + 0.12, y1: G + 2.25, kind: 'window' }] }, // +z gable: the terrace's glass door (fixed)
  // upper floor
  { level: 'up', side: 'front', openings: [uw(1.21), uw(-0.75)] },     // the dormer (bedroom B)
  { level: 'up', side: 'back', openings: [uw(-0.38, 0.8), uw(1.35, 0.8)] }, // the dormer (bathroom)
  { level: 'up', side: 'west', openings: [uw(0, 1.0, FL + 2.3)] },
  { level: 'up', side: 'east', openings: [uw(-1.4), uw(1.4)] },
];
const d = (c, y0 = G, w = DOOR_W) => ({ c, w, y0, y1: y0 + DOOR_H, kind: 'door' });
export const INTERIOR = [
  // ground
  { level: 'ground', a: [1.7, -1.3], b: [IX, -1.3] },                // hall | living (the rest open)
  { level: 'ground', a: [-0.78, -1.3], b: [-0.78, 1.72] },           // hall | stair
  { level: 'ground', a: [-1.83, -1.3], b: [-1.83, 1.72] },           // stair | closet
  { level: 'ground', a: [-IX, -1.3], b: [-1.83, -1.3] },             // closet | living
  { level: 'ground', a: [-IX, 1.72], b: [1.5, 1.72], openings: [d(0.15)] },  // -> the snug
  { level: 'ground', a: [1.5, 1.72], b: [IX, 1.72], openings: [d(2.7)] },    // -> the bathroom
  { level: 'ground', a: [1.5, 1.72], b: [1.5, 4.5] },                // bathroom | snug
  { level: 'ground', a: [1.5, 4.5], b: [IX, 4.5] },                  // bathroom | snug
  // upper
  { level: 'up', a: [-IX, -2.8], b: [IX, -2.8], openings: [d(-0.07, FL)] },  // bedroom A
  { level: 'up', a: [-IX, 2.8], b: [IX, 2.8], openings: [d(-0.1, FL)] },     // bedroom C
  { level: 'up', a: [0.65, -2.8], b: [0.65, 2.8], openings: [d(0, FL)] },    // bedroom B
  { level: 'up', a: [-1.83, -2.8], b: [-1.83, 2.8], openings: [d(2.2, FL)] }, // the bathroom
];
// railings round the stairwell (upstairs): walked against, seen through
export const RAILS = [{ a: [HOLE.x1, HOLE.z0], b: [HOLE.x1, HOLE.z1] }, { a: [HOLE.x0, HOLE.z0], b: [HOLE.x1, HOLE.z0] }];

/** An exterior wall's inner-face line (a -> b), its outward normal n, and the axis its openings' c runs along. */
export function exteriorLine(side) {
  if (side === 'front') return { a: [IX, -IZ], b: [IX, IZ], n: [1, 0], axis: 'z' };
  if (side === 'back') return { a: [-IX, -IZ], b: [-IX, IZ], n: [-1, 0], axis: 'z' };
  if (side === 'east') return { a: [-IX, IZ], b: [IX, IZ], n: [0, 1], axis: 'x' };
  return { a: [-IX, -IZ], b: [IX, -IZ], n: [0, -1], axis: 'x' };
}
