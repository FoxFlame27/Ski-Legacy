// The Wolkenspitze: the biggest mountain of the game, north-east of Legacy Village (like the Zugspitze
// over Garmisch). Sculpted like a real massif:
//  - a broad body whose upper part breaks into ridges, aretes and towers (warped ridged noise, like the
//    ranges around it, only bigger);
//  - the summit horn (2,520 m above the village), a four-sided pyramid on the east side of the plateau;
//  - the Wolkenplatt: a glacier plateau (~1,500-1,800 m) held in a cirque, ending at its south-west lip in a
//    rock step over the Wolkental;
//  - the Wolkental: a glacial trough climbing from the forested corridor north-east of the village up to
//    the foot of the step. The Wolkenspitzbahn (railway.js) climbs it and spirals up through the step.
// world.js blends it into the base terrain: it owns the ground under its core, a smooth max toward its foot.
import { Simplex, smoothstep, lerp, clamp } from '../core/noise.js';
import { RAIL, BED_DROP } from './railroute.js';

const N = new Simplex(4417), N2 = new Simplex(4423);

export const SUMMIT = { x: 4120, z: -3260, h: 2520 };
const FOOT = 300;
const BODY = { x: 3450, z: -3450, a: 2150, b: 1800, rot: -0.25, h: 1420 };
const BC = Math.cos(BODY.rot), BS = Math.sin(BODY.rot);
// the glacier plateau: an ellipse, its surface rising from the south-west lip to the north-east
const PLAT = { x: 3500, z: -3800, a: 900, b: 560, rot: -0.75, hLip: 1360, hBack: 1680 };
const PC = Math.cos(PLAT.rot), PS = Math.sin(PLAT.rot);
// the trough: its floor follows the railway (railroute.js) from Wolkensee up to the spiral tunnel's portal,
// a little below the formation, so the line runs on the valley floor
const TROUGH = (() => {
  const see = RAIL.stations.find((st) => st.id === 'see'), spiral = RAIL.tunnels[1];
  const out = [];
  for (let s = see.s1 - 120; s <= spiral.sCp + 12; s += 60) {
    const i = Math.min(RAIL.n - 1, Math.round(s / 2));
    out.push([RAIL.X[i], RAIL.Z[i], RAIL.Y[i] - BED_DROP - 1.2]);
  }
  return out;
})();
const T_FLOOR = 70;   // half-width of the flat floor
const T_WALL = 1.25;  // wall steepness above the floor

export const WOLKENSPITZE = {
  id: 'wolkenspitze', name: 'Wolkenspitze', summit: SUMMIT, plateau: PLAT, trough: TROUGH,
  box: [BODY.x - 4300, BODY.z - 4300, BODY.x + 4300, BODY.z + 4300],
};

export function glacierSurface(x, z) {
  const u = (x - PLAT.x) * PC + (z - PLAT.z) * PS, v = -(x - PLAT.x) * PS + (z - PLAT.z) * PC;
  // u runs along the plateau's long axis; the lip is at its south-west end (u < 0 side after rotation)
  const t = clamp((u + PLAT.a) / (2 * PLAT.a), -0.15, 1.15);
  return lerp(PLAT.hLip, PLAT.hBack, t) + Math.abs(v) * 0.08;
}

// fractional octave count a sample spacing can carry (band-limited LOD sampling, like world.js)
const oct = (lambda, full, spacing) => spacing > 0 ? Math.min(full, Math.max(0, Math.log2(lambda / (4 * spacing)) + 1)) : full;
const smax = (a, b, k) => { const d = Math.abs(a - b); return Math.max(a, b) + (d < k ? (k - d) * (k - d) / (4 * k) : 0); };
const smin = (a, b, k) => -smax(-a, -b, k);

// The resort next door stays exactly as it is. The resort's runs were laid out by a router working on a grid of
// the base terrain around each face (layout.js faceGrid: 1,140 m either side of the Legacy face, 960 m of the
// Adlerhorn's), so the massif is exactly zero over those grids (and fades in beyond them): every existing run,
// race and lift keeps its line.
const KEEP = [
  { ax: 10, az: -2240, bx: 0, bz: 60, r0: 1185, r1: 1450 },      // Legacy main face (top station -> village)
  { ax: 2406, az: -590, bx: 30, bz: 34, r0: 1000, r1: 1250 },    // Adlerhorn face (behind the top station -> past the base)
];
function protect(x, z) {
  let k = 1;
  for (const s of KEEP) {
    const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez;
    const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
    const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z);
    k = Math.min(k, smoothstep(s.r0, s.r1, d));
  }
  return k;
}

// nearest point on the trough's centre line: { d (m), s (m along), y (floor height) }; segments are bucketed
// in 256 m cells (each holds the segments within the carve's reach)
const T_REACH = 760, TCELL = 256;
const tSeg = [];
{
  let acc = 0;
  for (let i = 1; i < TROUGH.length; i++) {
    const [ax, az, ay] = TROUGH[i - 1], [bx, bz, by] = TROUGH[i], l = Math.hypot(bx - ax, bz - az);
    tSeg.push({ ax, az, ay, bx, bz, by, l, s0: acc });
    acc += l;
  }
}
const tGrid = new Map();
for (const g of tSeg) {
  const r = T_REACH + g.l;
  for (let cx = Math.floor((Math.min(g.ax, g.bx) - r) / TCELL); cx <= Math.floor((Math.max(g.ax, g.bx) + r) / TCELL); cx++) {
    for (let cz = Math.floor((Math.min(g.az, g.bz) - r) / TCELL); cz <= Math.floor((Math.max(g.az, g.bz) + r) / TCELL); cz++) {
      const k = cx * 4096 + cz;
      let a = tGrid.get(k);
      if (!a) tGrid.set(k, (a = []));
      a.push(g);
    }
  }
}
const _tr = { d: 0, s: 0, y: 0 };
function troughAt(x, z) {
  const a = tGrid.get(Math.floor(x / TCELL) * 4096 + Math.floor(z / TCELL));
  if (!a) return null;
  let best = Infinity, bs = 0, by = 0;
  for (const g of a) {
    const ex = g.bx - g.ax, ez = g.bz - g.az;
    const t = clamp(((x - g.ax) * ex + (z - g.az) * ez) / (g.l * g.l), 0, 1);
    const d = Math.hypot(g.ax + ex * t - x, g.az + ez * t - z);
    if (d < best) { best = d; bs = g.s0 + t * g.l; by = g.ay + (g.by - g.ay) * t; }
  }
  _tr.d = best; _tr.s = bs; _tr.y = by;
  return _tr;
}

const out0 = { h: 0, calm: 0, glacier: 0, keep: 1 };
/**
 * Height of the massif at (x, z) (absolute metres, like baseHeight) and how much it owns the spot:
 * out.calm 0..1 (1 = the massif replaces the base terrain), out.glacier 0..1 (on the glacier plateau),
 * out.keep 0..1 (0 near the existing resort: no influence). out.h = -Infinity outside its footprint.
 */
export function wolkenspitze(x, z, spacing = 0, out = out0) {
  out.h = -Infinity; out.calm = 0; out.glacier = 0; out.keep = 1;
  const Bx = WOLKENSPITZE.box;
  if (x < Bx[0] || z < Bx[1] || x > Bx[2] || z > Bx[3]) return out;
  const u = (x - BODY.x) * BC + (z - BODY.z) * BS, v = -(x - BODY.x) * BS + (z - BODY.z) * BC;
  let q = (u * u) / (BODY.a * BODY.a) + (v * v) / (BODY.b * BODY.b);
  if (q > 4.4) return out; // (the outline noise below scales q by 0.73..1.27)
  out.keep = protect(x, z);
  if (out.keep <= 0) return out;
  q *= 1 + 0.2 * N.noise(x * 0.0006 + 1.1, z * 0.0006 - 4.4) + 0.07 * N.noise(x * 0.0019 - 3.3, z * 0.0019 + 0.6);
  if (q > 3.2) return out;
  // body: a broad dome (wide shoulders, steepening toward the crown)
  const dome = Math.exp(-q * 1.15);
  // ridges and valleys like the ranges around it, only bigger: domain-warped ridged noise
  const wx = x + N2.fbm(x * 0.0007, z * 0.0007, 3) * 380, wz = z + N2.fbm(x * 0.0007 + 31.7, z * 0.0007 - 12.3, 3) * 380;
  const rid = N.ridged(wx * 0.00055 + 5.3, wz * 0.00055 - 3.7, Math.max(1, oct(1800, 4, spacing)), 2.0, 0.4, 4);
  const M = Math.pow(rid, 1.4);
  let h = FOOT + dome * (BODY.h - FOOT - 380 + M * 1050) + (1 - dome) * M * 160;
  // summit horn: a four-sided pyramid with sharp aretes (one points at the village, so morning and evening
  // light split it into a lit and a shaded face), concave faces, rough rock; a local feature that sinks into
  // the massif within ~1.6 km
  {
    const hx = x - SUMMIT.x, hz = z - SUMMIT.z, r = Math.hypot(hx, hz);
    if (r < 1700) {
      const ex = hx + N.noise(x * 0.002, z * 0.002) * 60, ez = hz + N.noise(x * 0.002 + 9.1, z * 0.002 - 3.3) * 60;
      const fd = Math.max(-ex * 0.105 + ez * 0.995, -ex * 0.995 - ez * 0.105 * 1.1, ex * 0.105 - ez * 0.995, ex * 0.995 * 0.92 + ez * 0.105);
      const hd = Math.max(0, fd);
      const rough = N2.ridged(x * 0.006 + 2.2, z * 0.006 - 7.7, Math.max(1, oct(170, 3, spacing)), 2.0, 0.5, 3);
      let horn = SUMMIT.h - hd * (1.45 - 0.5 * smoothstep(0, 1100, hd)) - (rough - 0.4) * 60 * smoothstep(40, 300, hd);
      horn -= smoothstep(700, 1650, r) * 900;
      h = smax(h, horn, 90);
    }
  }
  // the glacier plateau, held in a cirque: the walls round it stand 150-450 m over the ice, except at the
  // south-west lip, where it ends over the step
  const pu = (x - PLAT.x) * PC + (z - PLAT.z) * PS, pv = -(x - PLAT.x) * PS + (z - PLAT.z) * PC;
  const pr = Math.hypot(pu, pv) || 1;
  let pd = Math.hypot(pu / PLAT.a, pv / PLAT.b);
  pd *= 1 + 0.08 * N.noise(pu / pr * 1.8 + 5.5, pv / pr * 1.8 - 1.1) + 0.04 * N.noise(x * 0.003, z * 0.003);
  const surf = glacierSurface(x, z) + N2.fbm(x * 0.0019 + 3.3, z * 0.0019 - 1.9, Math.max(1, oct(520, 3, spacing))) * 12;
  if (pd < 1.9) {
    const lip = smoothstep(0.55, 0.92, -pu / pr); // the open south-west end
    // the cirque wall rises straight from the ice (never a moat between the ice and the wall) to its crest,
    // and falls back to the massif's body beyond it
    const crest = surf + smoothstep(0.84, 1.12, pd) * (150 + M * 420);
    const ring = (1 - smoothstep(1.35, 1.85, pd)) * (1 - lip);
    h = Math.max(h, lerp(h, crest, ring));
    const inside = 1 - smoothstep(0.84, 1.0, pd);
    h = lerp(h, surf, inside);
    if (lip > 0 && pd > 0.95) { // the lip breaks off over the step
      const beyond = Math.max(0, (pd - 1) * Math.hypot(PLAT.a * pu / pr, PLAT.b * pv / pr));
      h = lerp(h, Math.min(h, surf - beyond * 1.7), lip * (1 - smoothstep(1.45, 1.9, pd)));
    }
    out.glacier = inside;
  }
  // the trough: a U-shaped valley carved into the massif, its floor rising toward the step (level across the
  // line itself, a little wavy toward its sides)
  {
    const t = troughAt(x, z);
    if (t && t.d < T_REACH) {
      const floor = t.y + N2.noise(t.s * 0.004 + 2.2, 1.7) * 6 * smoothstep(20, 70, t.d);
      const out = Math.max(0, t.d - T_FLOOR);
      const wall = floor + out * T_WALL * (1 + 0.25 * N.noise(x * 0.004, z * 0.004)) + out * out * 0.0004;
      const k = 1 - smoothstep(T_REACH - 220, T_REACH, t.d); // the carve fades out far from the valley
      h = lerp(h, smin(h, wall, 40), k);
      if (t.d < T_FLOOR + 30) h = lerp(h, floor + out * T_WALL, 1 - smoothstep(T_FLOOR - 10, T_FLOOR + 30, t.d)); // the floor fills hollows too
    }
  }
  // rolls on the lower slopes, fine snow surface variation
  const upper = smoothstep(0.15, 0.7, dome);
  h += N2.fbm(x * 0.0035 + 2.1, z * 0.0035 - 9.4, oct(285, 3, spacing), 2, 0.5, 3) * 14 * (1 - upper) * (1 - out.glacier);
  if (spacing < 10) h += (N2.noise(x * 0.025, z * 0.025) * 0.9 + N2.noise(x * 0.09, z * 0.09) * 0.18) * (1 - 0.7 * out.glacier);
  out.h = h;
  out.calm = smoothstep(0.06, 0.3, dome);
  return out;
}

/**
 * The world's height with the Wolkenspitze blended in (world.js calls this from baseHeight with its own
 * height h): under its core the massif replaces the ground, toward its foot the higher of the two wins (a
 * smooth max), and near the resort next door nothing changes.
 */
export function wolkenspitzeHeight(x, z, h, spacing = 0) {
  const ws = wolkenspitze(x, z, spacing, out0);
  if (!(ws.h > -1e9) || ws.keep <= 0) return h;
  const kw = 160, dw = Math.abs(h - ws.h);
  const top = Math.max(h, ws.h) + (dw < kw ? (kw - dw) * (kw - dw) / (4 * kw) : 0);
  return lerp(h, lerp(top, ws.h, ws.calm), ws.keep);
}
