// Soft collisions for the helicopter while you fly it: trees, buildings / lift stations / nets / posts (the shared
// colliders, each given a height), lift towers and their haul ropes. Nothing breaks and nobody crashes: the
// helicopter is pushed back out a little at a time, its speed into the obstacle is taken away (a small bounce)
// and the airspeed you asked for eases off while you keep pushing against it. (The terrain itself is the flight
// model's job: flight.js keeps the skids, nose, tail and rotor tips above the snow.)
//
//   collideHeli(flight, { vegetation, colliders, skip: [own colliders], lifts }, dt) -> 0..1 how hard it bumped

const ROTOR_R = 5.1, ROTOR_UP = 2.2;    // main rotor disc: radius, height above the centre of mass (m)
const BODY_R = 2.0, BODY_UP = 1.3;      // cabin: radius, top above the centre of mass
const TAIL_R = 1.0, TAIL_BACK = 4.6;    // tail boom / fin: radius, distance behind the centre of mass
const VEG_CELL = 64;                    // vegetation.js cell size

// the parts tested against each obstacle: [x, z, radius, y] (filled per frame)
const parts = [[0, 0, ROTOR_R, 0], [0, 0, BODY_R, 0], [0, 0, BODY_R, 0], [0, 0, TAIL_R, 0]];
const acc = { x: 0, y: 0, z: 0, n: 0 };

// a collider's height above the snow (they only carry a footprint): nets, posts and signs are low, lift towers tall
function colliderHeight(c, size) {
  if (c.h !== undefined) return c.h;
  if (c.net) return 3.4;
  if (size >= 4) return Math.min(18, 6 + size * 0.9); // buildings, station halls
  if (size >= 1.5) return 9;                          // huts, kiosks, big props
  if (size >= 0.95) return 22;                        // lift towers (r = 1)
  return 4.5;                                         // posts, lamps, signs
}

// push from a vertical obstacle at (ox, oz), from y0 (radius r0) up to y1 (radius r1)
function vertical(ox, oz, y0, y1, r0, r1) {
  for (const [cx, cz, R, y] of parts) {
    if (y < y0 || y > y1) continue;
    const r = r0 + ((r1 - r0) * (y - y0)) / Math.max(0.01, y1 - y0);
    const dx = cx - ox, dz = cz - oz;
    if (Math.abs(dx) > R + r || Math.abs(dz) > R + r) continue;
    const d = Math.hypot(dx, dz), over = R + r - d;
    if (over <= 0) continue;
    const nx = d > 1e-3 ? dx / d : 1, nz = d > 1e-3 ? dz / d : 0;
    acc.x += nx * over; acc.z += nz * over; acc.n++;
  }
}

// push from an oriented box (main.js collider convention: hw, hd, rot) from the snow up to its height; building
// colliders are drawn in from the walls (you walk under the eaves), so for the rotor they grow back out
function box(c, y0, y1) {
  const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
  const big = !c.net && Math.min(c.hw, c.hd) > 1.5, hw = big ? c.hw * 1.2 + 0.6 : c.hw, hd = big ? c.hd * 1.2 + 0.6 : c.hd;
  for (const [cx, cz, R, y] of parts) {
    if (y < y0 || y > y1) continue;
    const lx = (cx - c.x) * cs - (cz - c.z) * sn, lz = (cx - c.x) * sn + (cz - c.z) * cs;
    const ox = hw + R - Math.abs(lx), oz = hd + R - Math.abs(lz);
    if (ox <= 0 || oz <= 0) continue;
    let nlx = 0, nlz = 0;
    if (ox < oz) nlx = Math.sign(lx) || 1; else nlz = Math.sign(lz) || 1;
    const push = Math.min(ox, oz), c2 = Math.cos(c.rot), s2 = Math.sin(c.rot);
    acc.x += (nlx * c2 - nlz * s2) * push; acc.z += (nlx * s2 + nlz * c2) * push; acc.n++;
  }
}

/**
 * @param {import('./flight.js').Flight} f
 * @param {{vegetation?: object, colliders?: Array, skip?: Array, lifts?: object, ground: (x: number, z: number) => number}} env
 * @param {number} dt
 * @returns {number} 0 (clear) .. 1 (pushed hard this frame)
 */
export function collideHeli(f, env, dt) {
  if (f.landed || dt <= 0) return 0;
  const p = f.pos, fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
  const agl = f.agl;
  if (agl > 60) return 0; // nothing reaches that high (the terrain is the flight model's)
  parts[0][0] = p.x; parts[0][1] = p.z; parts[0][3] = p.y + ROTOR_UP;
  parts[1][0] = p.x; parts[1][1] = p.z; parts[1][3] = p.y + BODY_UP;
  parts[2][0] = p.x; parts[2][1] = p.z; parts[2][3] = p.y - f.cgH + 0.2;
  parts[3][0] = p.x - fx * TAIL_BACK; parts[3][1] = p.z - fz * TAIL_BACK; parts[3][3] = p.y + 0.6;
  acc.x = acc.y = acc.z = 0; acc.n = 0;

  // trees: a trunk, then a cone of branches up to the top (vegetation.js: t.s is the tree's height)
  const veg = env.vegetation;
  if (veg?.cells && agl < 40) {
    const cx = Math.floor(p.x / VEG_CELL), cz = Math.floor(p.z / VEG_CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = veg.cells.get((cx + i) + ',' + (cz + j));
      if (!cell) continue;
      for (const t of cell.trees) {
        if (Math.abs(t.x - p.x) > 16 || Math.abs(t.z - p.z) > 16) continue;
        const crown = t.y + t.s * 0.12;
        vertical(t.x, t.z, t.y, crown, t.r, t.r);
        vertical(t.x, t.z, crown, t.y + t.s, t.s * 0.21, 0.25);
      }
    }
  }
  // buildings, stations, nets, posts (skip the helicopter's own parked colliders)
  if (env.colliders && agl < 30) {
    for (const c of env.colliders) {
      if (env.skip && env.skip.includes(c)) continue;
      const size = c.r ?? Math.max(c.hw, c.hd), reach = size + ROTOR_R + 1;
      if (Math.abs(p.x - c.x) > reach || Math.abs(p.z - c.z) > reach) continue;
      // (cars and the bus: a little over their roofs too, the skids are below the lowest point tested)
      const g = env.ground(c.x, c.z), h = colliderHeight(c, size) + (c.traffic || c.car || c.bus ? 0.5 : 0);
      if (c.r !== undefined) vertical(c.x, c.z, g - 1, g + h, c.r, c.r);
      else box(c, g - 1, g + h);
    }
  }
  // lift towers and haul ropes (both directions)
  const lines = env.lifts?.lines;
  if (lines) {
    for (const l of lines) {
      const bx = p.x - l.B.x, bz = p.z - l.B.z;
      const u = bx * l.dir.x + bz * l.dir.z;
      if (u < -8 || u > l.L + 8) continue;
      const lat = bx * l.sideV.x + bz * l.sideV.z;
      const side = l.cfg?.side ?? 3;
      if (Math.abs(lat) > side + ROTOR_R + 2) continue;
      for (const tw of l.towers || []) vertical(tw.x, tw.z, tw.g - 1, tw.top + 1.5, 0.9, 0.9);
      if (u < 0 || u > l.L) continue;
      // the ropes: horizontal lines across the helicopter's path (pushed sideways, or up / down when that is less)
      for (const sd of [-1, 1]) {
        const cy = l.cableAt(u, sd).y, cl = sd * side;
        for (const [, , R, y] of parts) {
          const dl = lat - cl, over = R - Math.abs(dl), dy = y - cy, overY = (R === ROTOR_R ? 0.45 : 1.2) - Math.abs(dy);
          if (over <= 0 || overY <= 0) continue;
          if (overY < over) { acc.y += Math.sign(dy || 1) * overY; acc.n++; }
          else { const s = Math.sign(dl || 1); acc.x += l.sideV.x * s * over; acc.z += l.sideV.z * s * over; acc.n++; }
        }
      }
    }
  }
  if (!acc.n) return 0;

  // push out softly (part of the overlap each frame), take away the speed into the obstacle (+ a small bounce)
  let len = Math.hypot(acc.x, acc.y, acc.z);
  const k = Math.min(1, dt * 14), maxStep = 1.2;
  const step = Math.min(len * k, maxStep);
  const nx = acc.x / len, ny = acc.y / len, nz = acc.z / len;
  p.x += nx * step; p.y += ny * step; p.z += nz * step;
  const v = f.vel, vn = v.x * nx + v.y * ny + v.z * nz;
  if (vn < 0) { v.x -= nx * vn * 1.25; v.y -= ny * vn * 1.25; v.z -= nz * vn * 1.25; }
  // still pushing the nose into it: the commanded airspeed eases off (you stop against it rather than grind)
  const into = fx * nx + fz * nz;
  if (into < -0.2 && f.u > 0) f.u *= Math.exp(-dt * 7 * -into);
  if (into > 0.2 && f.u < 0) f.u *= Math.exp(-dt * 7 * into);
  len = Math.min(1, len);
  return len;
}
