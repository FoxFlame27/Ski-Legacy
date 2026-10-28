// Build-mode layout of the rented chalet, derived from the chalet agent's plan (src/game/chaletplan.js, house
// frame). Used when the chalet's runtime API doesn't hand over storeys / walls itself. Walls are split at
// their windows and doors into pieces with their own height range, so a picture can't hang over a window and
// a cabinet can stand under one.
import { HX, HZ, T, IX, IZ, G, GC, FL, KNEE, COLLAR, DORMER, IT, STAIR, ROOMS, EXTERIOR, INTERIOR, RAILS, exteriorLine, ceilingAt } from '../chaletplan.js';

/** Split the wall a->b (param s along `axis` coordinate) at openings into { ax, az, bx, bz, t, y0, y1 } pieces. */
function pieces(a, b, t, yb, yt, openings = [], axis) {
  const k = axis === 'x' ? 0 : 1;
  const lo = Math.min(a[k], b[k]), hi = Math.max(a[k], b[k]);
  const at = (c) => { const f = (c - a[k]) / (b[k] - a[k]); return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; };
  const seg = (c0, c1, y0, y1) => { const p = at(c0), q = at(c1); return { ax: p[0], az: p[1], bx: q[0], bz: q[1], t, y0, y1 }; };
  const out = [];
  const ops = openings.map((o) => ({ ...o, c0: Math.max(lo, o.c - o.w / 2), c1: Math.min(hi, o.c + o.w / 2) })).sort((p, q) => p.c0 - q.c0);
  let cur = lo;
  for (const o of ops) {
    if (o.c0 > cur + 0.01) out.push(seg(cur, o.c0, yb, yt));
    if (o.y0 > yb + 0.05) out.push(seg(o.c0, o.c1, yb, o.y0));
    if (o.y1 < yt - 0.05) out.push(seg(o.c0, o.c1, o.y1, yt));
    cur = Math.max(cur, o.c1);
  }
  if (hi > cur + 0.01) out.push(seg(cur, hi, yb, yt));
  return out;
}

export function planLayout() {
  const walls = { ground: [], up: [] };
  for (const e of EXTERIOR) {
    const L = exteriorLine(e.side);
    const off = [L.n[0] * T / 2, L.n[1] * T / 2]; // centre line, half a wall outward of the inner face
    const a = [L.a[0] + off[0], L.a[1] + off[1]], b = [L.b[0] + off[0], L.b[1] + off[1]];
    const yb = e.level === 'up' ? FL : G;
    if (e.level === 'ground') walls.ground.push(...pieces(a, b, T, yb, GC, e.openings, L.axis));
    else if (e.side === 'front' || e.side === 'back') { // knee walls, taller in the dormer band
      const ops = e.openings || [];
      const band = (z0, z1, top) => {
        const o = ops.filter((p) => p.c > z0 && p.c < z1);
        return pieces([a[0], z0], [b[0], z1], T, yb, top, o, 'z');
      };
      walls.up.push(...band(-HZ, DORMER.z0, FL + KNEE), ...band(DORMER.z0, DORMER.z1, FL + DORMER.h), ...band(DORMER.z1, HZ, FL + KNEE));
    } else walls.up.push(...pieces(a, b, T, yb, FL + COLLAR, e.openings, L.axis));
  }
  for (const w of INTERIOR) {
    const axis = Math.abs(w.b[0] - w.a[0]) > Math.abs(w.b[1] - w.a[1]) ? 'x' : 'z';
    const yb = w.level === 'up' ? FL : G, yt = w.level === 'up' ? FL + COLLAR : GC;
    walls[w.level].push(...pieces(w.a, w.b, IT, yb, yt, w.openings, axis));
  }
  for (const r of RAILS) walls.up.push({ ax: r.a[0], az: r.a[1], bx: r.b[0], bz: r.b[1], t: 0.06, y0: FL, y1: FL + 1.0 });

  const rects = (level) => ROOMS.filter((r) => r.level === level).flatMap((r) => r.rects);
  // the stair's run on the ground floor is in the open living room: keep it clear
  const stairBlock = { x: (STAIR.x0 + STAIR.x1) / 2, z: (STAIR.z0 + STAIR.z1) / 2, hw: (STAIR.x1 - STAIR.x0) / 2 + 0.05, hd: (STAIR.z1 - STAIR.z0) / 2, rot: 0, y0: G, y1: GC };
  // the front door's swing / the way in
  const doorBlock = { x: IX - 0.5, z: -0.25, hw: 0.5, hd: 0.55, rot: 0, y0: G, y1: G + 2.2 };
  return [
    { level: 'ground', floorY: G, ceilingY: GC, rects: rects('ground'), walls: walls.ground, blocks: [stairBlock, doorBlock], ceilingAt: () => GC },
    { level: 'up', floorY: FL, ceilingY: FL + COLLAR, rects: rects('up'), walls: walls.up, blocks: [], ceilingAt: (x, z) => ceilingAt(x, z, 'up') },
  ];
}

export const HOUSE = { HX, HZ, IX, IZ };

/**
 * Window sills from the plan (house frame), for small decor: [{ x, z, y, len, depth, yaw, storey, level }].
 * The ledge chaletroom.js builds under every window: its top at the window's y0 (0.9 m over the floor), from the
 * inner face ~0.13 m into the room to ~0.1 m into the reveal. yaw = the direction into the room. (Glazed doors,
 * whose bottom is near the floor, have none.)
 */
export function planSills() {
  const out = [];
  for (const e of EXTERIOR) {
    const floor = e.level === 'up' ? FL : G;
    const L = exteriorLine(e.side), k = L.axis === 'x' ? 0 : 1;
    for (const o of e.openings || []) {
      if (o.kind !== 'window' || o.y0 - floor < 0.5) continue;
      const p = [L.a[0], L.a[1]];
      p[k] = o.c;
      const cen = -0.02; // centre of the usable ledge, along the outward normal from the inner face
      out.push({
        x: p[0] + L.n[0] * cen, z: p[1] + L.n[1] * cen, y: o.y0, len: o.w + 0.1, depth: 0.22,
        yaw: Math.atan2(-L.n[0], -L.n[1]), storey: e.level === 'up' ? 1 : 0, level: e.level,
      });
    }
  }
  return out;
}
