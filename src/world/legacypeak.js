// Legacy Peak: the highest mountain of the game (4,000 m: 2,755 m above the village, ALT0 1,245 m), standing right
// behind the main mountain, north of Legacy Village. Sculpted for one long run from its summit down to the village:
//  - the summit: a snow dome (the top station stands on it), its flanks steepening into rock faces all round;
//  - the Gipfelgrat: a broad ski spur (a ridge ~460 m across its crown) that leaves the summit south-eastward, swings
//    south round a cirque and comes down onto the main mountain's crown just north of the Legacy Gondola's top
//    station, at a steady grade. The Legacy Peak run follows it, then carries on down the main face to the village;
//  - the cirque between the spur and the summit's south face, which the Legacy Peak Gondola crosses.
// world.js blends it into the base terrain (legacyPeakHeight, after the Wolkenspitze): on the spur's crown and the
// summit dome it replaces the ground, elsewhere the higher of the two wins (a smooth max). It is exactly zero over the
// main face (the routing grid of its pistes starts 120 m behind the top station: they keep their lines), round the
// Schattenkar / Teufelsrinne and the Schmugglerstollen (secrets.js), and fades out before the World Racing regions
// next door (Eagle Peak to the west, Ice Canyon to the north). Pure math (no THREE): it runs in Node too.
import { Simplex, smoothstep, lerp, clamp } from '../core/noise.js';

const N = new Simplex(5113), N2 = new Simplex(5119);

export const LEGACY_PEAK_ALT = 4000;                  // m above sea level (signs: ALT0 1,245 + 2,755)
export const SUMMIT = { x: 200, z: -4600, h: 2755 };  // the summit (world units: metres above the village)
const H_J = 1160;                                     // the spur's foot, on the main mountain's crown
const W = 250;                                        // half-width of the spur's crown
const FLOOR = 500;                                    // the ground the massif's faces come down to
// the summit massif's profile by distance r from the summit: a round snow dome (R0: its top's radius of curvature)
// falling at the spur's own grade, then (the lower of the two) faces falling away like a broad bell (R_FACE, P_FACE)
const R0 = 110, R_FACE = 1000, P_FACE = 2.6;
// the spur's centre line: from the summit east, round the cirque, south-west down to the main mountain's crown (a long
// sweep: ~2.6 km at a steady ~60 % along its crown; the run zig-zags down it at a red's grade)
const SPINE_CTRL = [[200, -4600], [600, -4420], [800, -4000], [790, -3500], [620, -3060], [380, -2730], [130, -2450]];
function chaikin(p, it) {
  for (let k = 0; k < it; k++) {
    const o = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      o.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    o.push(p[p.length - 1]);
    p = o;
  }
  return p;
}
export const SPINE = chaikin(SPINE_CTRL, 2);
const SEG = [];
let SPINE_LEN = 0;
for (let i = 1; i < SPINE.length; i++) {
  const [ax, az] = SPINE[i - 1], [bx, bz] = SPINE[i], l = Math.hypot(bx - ax, bz - az);
  SEG.push({ ax, az, ex: bx - ax, ez: bz - az, l, s0: SPINE_LEN });
  SPINE_LEN += l;
}
export const SPINE_LENGTH = SPINE_LEN;
// the whole massif lies in this box (everything outside is untouched)
const BOX = { minx: -1300, maxx: 2000, minz: -6000, maxz: -2270 };

export const LEGACY_PEAK = {
  id: 'legacypeak', name: 'Legacy Peak', summit: SUMMIT, alt: LEGACY_PEAK_ALT, spine: SPINE, spineLength: SPINE_LEN, foot: SPINE[SPINE.length - 1], box: BOX,
};

const softplus = (x, k) => (x > 8 * k ? x : k * Math.log1p(Math.exp(x / k)));
const smin = (a, b, k) => { const d = Math.abs(a - b); return Math.min(a, b) - (d < k ? (k - d) * (k - d) / (4 * k) : 0); };
const smax = (a, b, k) => { if (k <= 0) return Math.max(a, b); const d = Math.abs(a - b); return Math.max(a, b) + (d < k ? (k - d) * (k - d) / (4 * k) : 0); };
// fractional octave count a sample spacing can carry (band-limited LOD sampling, like world.js)
const oct = (lambda, full, spacing) => spacing > 0 ? Math.min(full, Math.max(0, Math.log2(lambda / (4 * spacing)) + 1)) : full;

// how much the massif may change the ground here (0 = nothing: the main face, the secrets, the regions next door)
function keep(x, z) {
  let w = smoothstep(-2270, -2470, z) // (the main face: its routing grid ends 120 m behind the top station)
    * smoothstep(-1300, -950, x)       // Eagle Peak's region (minx -1023)
    * smoothstep(-6000, -5650, z)      // Ice Canyon's region (maxz -5700: its outer band blends into it)
    * (1 - smoothstep(1300, 2000, x)); // toward the Wolkenspitze
  if (w <= 0) return 0;
  w *= smoothstep(150, 320, Math.hypot(x + 460, z + 2290));  // Schattenkar / Teufelsrinne (secrets.js)
  w *= smoothstep(230, 600, Math.hypot(x - 1550, z + 3930)); // Schmugglerstollen (secrets.js: its portals, its old tracks in)
  return w;
}

const _o = { h: 0, d: 0, s: 0 }, _d2 = new Float64Array(SEG.length), _ss = new Float64Array(SEG.length);
const S_TAU = 40; // m: where two stretches of the spine are about as near, their arc lengths blend over a few of these
// nearest point of the spine: distance d, arc length s. s is blended between the segments about as near as the nearest
// (weights by how much further they are), so it never jumps where the nearest point flips from one stretch of the
// spine to another (round the cirque): the spur's height follows s, and a jump there was a 60 m step in the ground
function spineAt(x, z) {
  let bd = Infinity;
  for (let i = 0; i < SEG.length; i++) {
    const g = SEG[i];
    const t = clamp(((x - g.ax) * g.ex + (z - g.az) * g.ez) / (g.l * g.l), 0, 1);
    const dx = g.ax + g.ex * t - x, dz = g.az + g.ez * t - z, d = dx * dx + dz * dz;
    _d2[i] = d; _ss[i] = g.s0 + t * g.l;
    if (d < bd) bd = d;
  }
  const dmin = Math.sqrt(bd), cut = (dmin + 12 * S_TAU) ** 2;
  let sw = 0, ss = 0;
  for (let i = 0; i < SEG.length; i++) {
    if (_d2[i] > cut) continue;
    const wgt = Math.exp(-(Math.sqrt(_d2[i]) - dmin) / S_TAU);
    sw += wgt; ss += wgt * _ss[i];
  }
  _o.d = dmin; _o.s = ss / sw;
  return _o;
}

// the crown's fall from the summit: a round top (R0), then the steady grade (prof(s) ~ s - R0 far out)
const prof = (s) => Math.sqrt(s * s + R0 * R0) - R0;
const G = (SUMMIT.h - H_J) / prof(SPINE_LEN); // (the spur's steady grade along its crown, ~0.6)

/** The massif's own surface at (x, z) (absolute height) and how much it replaces the ground there (calm 0..1). */
export function legacyPeak(x, z, spacing = 0, out = { h: 0, calm: 0, w: 0 }) {
  out.w = 0;
  if (x < BOX.minx || x > BOX.maxx || z < BOX.minz || z > BOX.maxz) return out;
  const w = keep(x, z);
  out.w = w;
  if (w <= 0) return out;
  const r = Math.hypot(x - SUMMIT.x, z - SUMMIT.z);
  // the summit massif: a round snow dome on top falling at the spur's grade all round (you can ski off it any way),
  // steepening into faces beyond R1 (2,755 m exactly on the summit)
  let cone = smin(SUMMIT.h - G * prof(r), FLOOR + (SUMMIT.h - FLOOR) * Math.exp(-Math.pow(r / R_FACE, P_FACE)), 60);
  // aretes and couloirs on the faces round it (not on the dome, not on the spur)
  const sp = spineAt(x, z), d = sp.d, s = sp.s;
  const onSpur = 1 - smoothstep(W, W + 220, d);
  const rock = smoothstep(300, 650, r) * (1 - onSpur);
  if (rock > 0) cone += (N.ridged(x * 0.0016 + 3.1, z * 0.0016 - 7.3, Math.max(1, oct(620, 4, spacing)), 2.0, 0.45, 4) - 0.45) * 160 * rock;
  // the spur: its crown falls at a steady grade from the summit to its foot (the dome's own profile), a little toward
  // its edges, then its flanks drop away steeply
  const yS = SUMMIT.h - G * prof(s);
  const e = softplus(d - W, 80), spur = yS - 0.1 * Math.min(d, W) - (yS - FLOOR) * (1 - Math.exp(-Math.pow(e / 600, 1.6)));
  let h = smax(cone, spur, 50 * smoothstep(150, 400, r));
  // rolls on the spur and the lower slopes, fine snow; none right on the summit (it stays 2,755 m)
  const quiet = smoothstep(60, 220, r);
  h += N2.fbm(x * 0.004 + 1.3, z * 0.004 - 2.2, oct(250, 3, spacing), 2, 0.5, 3) * 7 * quiet;
  if (spacing < 10) h += (N2.noise(x * 0.025, z * 0.025) * 0.8 + N2.noise(x * 0.09, z * 0.09) * 0.15) * quiet;
  out.h = h;
  out.calm = Math.max(onSpur, 1 - smoothstep(300, 560, r));
  return out;
}

const out0 = { h: 0, calm: 0, w: 0 };
/**
 * The world's height with Legacy Peak blended in (world.js calls this from baseHeight with its own height h): on the
 * spur's crown and the summit dome the massif replaces the ground, elsewhere a smooth max; `keep` fades it out.
 */
export function legacyPeakHeight(x, z, h, spacing = 0) {
  const p = legacyPeak(x, z, spacing, out0);
  if (p.w <= 0) return h;
  const top = smax(h, p.h, 80);
  return lerp(h, lerp(top, p.h, p.calm), p.w);
}

/** A point on the spur's centre line `s` m below the summit: { x, z }. */
export function spinePoint(s) {
  s = clamp(s, 0, SPINE_LEN);
  for (const g of SEG) if (s <= g.s0 + g.l + 1e-6) { const t = (s - g.s0) / g.l; return { x: g.ax + g.ex * t, z: g.az + g.ez * t }; }
  const e = SPINE[SPINE.length - 1];
  return { x: e[0], z: e[1] };
}
