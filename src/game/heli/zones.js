// Heli drop zones: untouched peaks a few kilometres out, away from every lift and piste. Each seed
// climbs to its real summit on the heightfield, then the friendliest big face below it is picked
// (steep enough to be a proper run, no cliff right at the start) and the drop point set just below
// the top. They are suggestions: you can jump out anywhere you can hover low over the snow.
import { world } from '../../world/world.js';

const SEEDS = [
  { name: 'Rabenspitz', x: -1720, z: -2200 },
  { name: 'Wolfzahn', x: -3640, z: 1040 },
  { name: 'Eiskrone', x: 3000, z: -3000 },
  { name: 'Sternenkamm', x: -2200, z: -3640 },
  { name: 'Weisse Wand', x: 3400, z: 2600 },
];

const H = (x, z) => world.height(x, z);

// walk down the fall line from (x, z): vertical drop over ~`len` metres, the mean and steepest grades
function descent(x, z, len) {
  let px = x, pz = z, sum = 0, n = 0, max = 0;
  const h0 = H(x, z);
  for (let s = 0; s < len; s += 12) {
    const e = 3, gx = (H(px + e, pz) - H(px - e, pz)) / (2 * e), gz = (H(px, pz + e) - H(px, pz - e)) / (2 * e);
    const g = Math.hypot(gx, gz);
    if (g < 0.03) break;
    sum += g; n++; max = Math.max(max, g);
    px -= (gx / g) * 12; pz -= (gz / g) * 12;
  }
  return { drop: h0 - H(px, pz), mean: n ? sum / n : 0, max };
}

let cache = null;

/** The drop zones: [{ name, x, z, y (drop point), summit: { x, z, y }, heading (downhill), vertical }] */
export function dropZones() {
  if (cache) return cache;
  cache = SEEDS.map((seed) => {
    // climb to the summit (coarse to fine)
    let x = seed.x, z = seed.z, h = H(x, z);
    for (let step = 96; step >= 6; step /= 2) {
      for (let guard = 0; guard < 24; guard++) {
        let bx = x, bz = z, bh = h;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2, qx = x + Math.cos(a) * step, qz = z + Math.sin(a) * step, qh = H(qx, qz);
          if (qh > bh) { bx = qx; bz = qz; bh = qh; }
        }
        if (bh <= h) break;
        x = bx; z = bz; h = bh;
      }
    }
    // the best face: out from the top until the snow is skiable (no spire or cliff to start on), then the
    // longest steep run below that without a cliff in its first 100 m
    let best = null;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (let r = 25; r <= 400; r += 15) {
        const sx = x + ca * r, sz = z + sa * r, e = 3;
        const g = Math.hypot(H(sx + e, sz) - H(sx - e, sz), H(sx, sz + e) - H(sx, sz - e)) / (2 * e);
        if (g > 0.85) continue;
        if (h - H(sx, sz) > 300) break;
        const top = descent(sx, sz, 100);
        if (top.max > 1.3 || top.mean < 0.14) continue;
        const run = descent(sx, sz, 420);
        const score = run.drop - r * 0.3;
        if (!best || score > best.score) best = { score, sx, sz, vertical: run.drop };
        break;
      }
    }
    const dx = best ? best.sx : x, dz = best ? best.sz : z;
    const e = 3, gx = (H(dx + e, dz) - H(dx - e, dz)) / (2 * e), gz = (H(dx, dz + e) - H(dx, dz - e)) / (2 * e);
    return {
      name: seed.name, x: dx, z: dz, y: H(dx, dz),
      summit: { x, z, y: h },
      heading: Math.atan2(-gx, -gz),
      vertical: Math.round(best?.vertical || 0),
    };
  });
  return cache;
}
