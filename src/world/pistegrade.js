// Piste grading: every run of the resort is built like a real, machine-groomed piste (the Hirschalm / Ostkar runs
// already are: sectors.js pisteBench; this does the same for all the others, the main mountain, the resort peaks,
// the Wolkenspitze, Legacy Peak, the valley runs).
// (Oct 30, the user: "fix all ski pistes, make sure they are way easier ... and more realistic like in real life".)
//  - along its centre line the snow follows an even profile: the ground smoothed over ~200 m, never climbing, and
//    never steeper than the colour allows (GRADE_CAP: green 18 %, blue 25 %, red 40 %, black 60 %; a line whose own
//    mean grade is steeper keeps that mean, evenly spread, instead of pitches and flats). No rolls, steps, lips or
//    blind drops onto flats; the noise of the open terrain (bumps, spikes) is gone on the groomed width;
//  - the last RUNOUT m flatten out (a gentle run-out to the lift base / village), the first metres ease in;
//  - level across the groomed width (a bench cut into a side hill like a real cat track), with snow banks back to the
//    natural ground beside it (wider where it is cut deeper or filled higher), at most DEV m of cut / fill;
//  - its ends are pinned to the ground (the stations' pads stay as they are) and where it runs onto a run graded
//    before it (the gentlest are graded first) or one graded elsewhere (`locks`), it takes that run's level.
// The grading is a terrain cut (world.addCut), built on first use: the layout registers it once its runs exist,
// before any terrain is built. Points inside a purpose-built region (the World Racing courses) are left alone.
import { world } from './world.js';
import { smoothstep } from '../core/noise.js';

export const GRADE_CAP = [0.18, 0.25, 0.40, 0.60];
const RUNOUT = 140, RUNOUT_G = 0.11; // m of run-out at a run's foot and its grade
const EASE_IN = 40, EASE_G = 0.16;   // m below a run's start that stay gentle (skiers set off from a standstill)
const STEP = 6;                      // m between profile samples
const BANK = 26, BANK_MAX = 80, DEV = 30, SOFT = 9;
const BC = 64;                       // m: spatial grid cell
const key = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

function resample(pts, spacing) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], l = Math.hypot(bx - ax, bz - az);
    let t = spacing - carry;
    while (t <= l) { out.push([ax + ((bx - ax) * t) / l, az + ((bz - az) * t) / l]); t += spacing; }
    carry = l - (t - spacing);
  }
  const e = pts.at(-1), o = out.at(-1);
  if (Math.hypot(e[0] - o[0], e[1] - o[1]) > 0.5) out.push([e[0], e[1]]);
  return out;
}
const segDist = (x, z, ax, az, bx, bz) => {
  const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(ax + ex * t - x, az + ez * t - z);
};

/**
 * runs: [{ pts, w (groomed half-width + margin), diff }] in priority order (gentlest first);
 * locks: [{ pts, w }] runs graded elsewhere: where a run crosses one, it keeps the ground's level there;
 * pinAt(x, z) -> 0..1: other places a run keeps the ground's level (railway crossings: their lines were fitted to it).
 * Returns the cut (register it with world.addCut).
 */
export function gradePistes(runs, locks = [], pinAt = null) {
  const G = new Map(); // cell -> [{ run, segs: [ax, az, bx, bz, ya, yb, ...] }]
  const graded = [];
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const r of runs) for (const [x, z] of r.pts) {
    const R = r.w + BANK_MAX + 8;
    minx = Math.min(minx, x - R); maxx = Math.max(maxx, x + R); minz = Math.min(minz, z - R); maxz = Math.max(maxz, z + R);
  }
  const _d = new Float64Array(4096), _y = new Float64Array(4096);
  // one run's bench at (x, z) from its segments in this cell: weight (1 on the bench, falling off over the bank) + level
  let bw = 0, by = 0, bd = 0;
  const benchAt = (run, S, x, z, h0) => {
    let bestD = Infinity, n = 0;
    for (let i = 0; i < S.length; i += 6) {
      const ax = S[i], az = S[i + 1], ex = S[i + 2] - ax, ez = S[i + 3] - az, l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      const dx = ax + ex * t - x, dz = az + ez * t - z, d = Math.sqrt(dx * dx + dz * dz);
      if (n < 4096) { _d[n] = d; _y[n++] = S[i + 4] + (S[i + 5] - S[i + 4]) * t; }
      if (d < bestD) bestD = d;
    }
    bw = 0; bd = bestD;
    if (bestD > run.w + BANK_MAX) return;
    // (the level: a soft minimum over the segments, so where two legs of a winding run pass close by at different
    // levels the bench ramps between them instead of stepping where the nearest leg switches)
    let sw = 0, sy = 0;
    for (let i = 0; i < n; i++) { const d = _d[i] - bestD; if (d < 60) { const k = Math.exp(-d / SOFT); sw += k; sy += k * _y[i]; } }
    by = sy / sw;
    bw = 1 - smoothstep(run.w, run.w + Math.min(BANK_MAX, Math.max(BANK, Math.abs(by - h0) * 1.7)), bestD);
  };
  // the graded ground: the runs graded so far, each weighted by its bench weight cubed (a run's groomed core outweighs
  // another run's snow bank), faded out under the pads' flat cores
  const graded_ = (x, z, h, upto) => {
    const arr = G.get(key(Math.floor(x / BC), Math.floor(z / BC)));
    if (!arr) return h;
    let sw = 0, sy = 0, wm = 0;
    for (let k = 0; k < arr.length; k++) {
      const e = arr[k];
      if (e.run.order >= upto) continue;
      // (cheap reject: beyond its banks' widest reach from the box round its segments here)
      const R = e.run.w + BANK_MAX;
      if (x < e.x0 - R || x > e.x1 + R || z < e.z0 - R || z > e.z1 + R) continue;
      benchAt(e.run, e.segs, x, z, h);
      // (and, where two groomed widths overlap, each counts most along its own centre line: a run crossing another
      // keeps its own even profile up to the other's middle, instead of the two averaging into a step at its edges)
      if (bw > 0) { const w3 = bw * bw * bw * (0.2 + 0.8 * (1 - smoothstep(0, e.run.w, bd))); sw += w3; sy += w3 * by; if (bw > wm) wm = bw; }
    }
    if (!sw) return h;
    const y = h + (sy / sw - h) * wm;
    const pad = world.padInfluence(x, z);
    return pad > 0.8 ? h + (y - h) * (1 - smoothstep(0.8, 1, pad)) : y;
  };
  const lockSegs = locks.flatMap((l) => l.pts.slice(1).map((b, i) => [l.pts[i][0], l.pts[i][1], b[0], b[1], l.w]));
  const onLocked = (x, z) => {
    let best = 0;
    for (const s of lockSegs) {
      if (Math.abs(s[0] - x) > s[4] + 400 && Math.abs(s[2] - x) > s[4] + 400) continue;
      best = Math.max(best, 1 - smoothstep(s[4] * 0.85, s[4] + 6, segDist(x, z, s[0], s[1], s[2], s[3])));
      if (best >= 1) break;
    }
    return best;
  };
  const inRegion = (x, z) => world.regions.length && world.regionAt(x, z);

  const addRun = (r, order) => {
    const P = resample(r.pts, STEP), n = P.length, S = new Float64Array(n), raw = new Float64Array(n), lock = new Float64Array(n);
    for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const L = S[n - 1] || 1;
    for (let i = 0; i < n; i++) {
      const [x, z] = P[i], h0 = world.height(x, z);
      raw[i] = graded_(x, z, h0, order);
      // pinned: the ends (station pads, junctions), the cores of runs graded before it or elsewhere, pads, regions
      let lk = 1 - Math.min(smoothstep(0, 24, S[i]), smoothstep(0, 24, L - S[i]));
      const arr = G.get(key(Math.floor(x / BC), Math.floor(z / BC)));
      // (an earlier run pins it over the middle of its groomed width only: across its outer metres the two blend, so
      // a steep run crossing the legs of an easier one's switchback at different levels drops between them over the
      // legs' edges too, not in one step between their cores)
      if (arr) for (const e of arr) { if (e.run.order < order) { benchAt(e.run, e.segs, x, z, h0); if (bw > 0) lk = Math.max(lk, 1 - smoothstep(e.run.w * 0.3, e.run.w, bd)); } }
      lk = Math.max(lk, onLocked(x, z), smoothstep(0.3, 0.8, world.padInfluence(x, z)), inRegion(x, z) ? 1 : 0, pinAt ? pinAt(x, z) : 0);
      lock[i] = lk;
    }
    // the ground smoothed (~200 m) between the pinned points
    let Y = Float64Array.from(raw);
    const K = Math.round(48 / STEP);
    for (let it = 0; it < 80; it++) {
      const o = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0, w = 0;
        for (let k = -K; k <= K; k++) { const j = Math.max(0, Math.min(n - 1, i + k)), wt = K + 1 - Math.abs(k); s += Y[j] * wt; w += wt; }
        o[i] = s / w + (raw[i] - s / w) * lock[i];
      }
      Y = o;
    }
    // grade cap (with a gentle start and run-out), stretch by stretch between the pinned points: going down, the
    // profile never falls faster than the cap there and never climbs, and meets each pinned point at its level (it
    // stays filled above a steep pitch and catches up below, or is cut in ahead of a pinned point it has to reach).
    // A line whose mean grade (run-out aside) is over the cap keeps its mean: an even pitch all the way down; so does a
    // stretch that has to drop further to its next pinned point than the cap allows.
    const drop = raw[0] - raw[n - 1], ro = Math.min(RUNOUT, L * 0.2), ei = Math.min(EASE_IN, L * 0.1);
    const g = Math.max(GRADE_CAP[r.diff], ((drop - RUNOUT_G * ro - EASE_G * ei) / Math.max(1, L - ro - ei)) * 1.04);
    const cap = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const toEnd = L - S[i];
      let c = g;
      if (toEnd < ro) c = Math.min(c, RUNOUT_G + (g - RUNOUT_G) * smoothstep(0, ro, toEnd) ** 2);
      if (S[i] < ei) c = Math.min(c, EASE_G + (g - EASE_G) * smoothstep(0, ei, S[i]));
      cap[i] = Math.max(0.02, c);
    }
    for (let i = 0; i < n; i++) if (lock[i] > 0.5) Y[i] = raw[i];
    for (let a = 1; a < n; a++) {
      if (lock[a] > 0.5) continue;
      let b = a;
      while (b < n - 1 && lock[b + 1] <= 0.5) b++;
      // free stretch a..b between the pinned points a - 1 and b + 1 (or the run's last point)
      const lo = a - 1, hi = Math.min(n - 1, b + 1), ya = Y[lo], yb = Y[hi];
      if (yb <= ya) {
        let avail = 0;
        for (let i = lo + 1; i <= hi; i++) avail += cap[i] * (S[i] - S[i - 1]);
        const k = ya - yb > avail ? ((ya - yb) / avail) * 1.01 : 1;
        // (two ways to meet the cap: filling above each steep pitch (down pass first) or cutting in ahead of it (up pass
        // first); the profile takes their mean, which meets it too: balanced cut and fill, like real earthworks)
        const down = (A) => { for (let i = lo + 1; i < hi; i++) A[i] = Math.min(A[i - 1], Math.max(A[i], A[i - 1] - cap[i] * k * (S[i] - S[i - 1]))); };
        const up = (A) => { for (let i = hi - 1; i > lo; i--) A[i] = Math.max(A[i + 1], Math.min(A[i], A[i + 1] + cap[i + 1] * k * (S[i + 1] - S[i]))); };
        const F = Y.slice(lo, hi + 1), B = Y.slice(lo, hi + 1), FY = new Float64Array(n), BY = new Float64Array(n);
        FY.set(F, lo); BY.set(B, lo);
        for (let it = 0; it < 6; it++) { down(FY); up(FY); up(BY); down(BY); }
        for (let i = lo + 1; i < hi; i++) Y[i] = (FY[i] + BY[i]) / 2;
      }
      a = b;
    }
    // at most DEV m of cut / fill; then a relaxation that eases the profile into the pinned points (a cut corner or a
    // pinned stretch blends over ~100 m instead of stepping) and rounds off the cap's corners
    for (let i = 0; i < n; i++) Y[i] = Math.max(raw[i] - DEV, Math.min(raw[i] + DEV, Y[i]));
    for (let it = 0; it < 60; it++) {
      const o = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0, w = 0;
        for (let k = -3; k <= 3; k++) { const j = Math.max(0, Math.min(n - 1, i + k)), wt = 4 - Math.abs(k); s += Y[j] * wt; w += wt; }
        o[i] = s / w + (raw[i] - s / w) * lock[i];
      }
      Y = o;
    }
    for (let i = 0; i < n; i++) Y[i] += (raw[i] - Y[i]) * lock[i];
    const run = { order, w: r.w, Y, pts: P, lock, raw };
    const R = r.w + BANK_MAX + 8;
    for (let i = 1; i < n; i++) {
      const [ax, az] = P[i - 1], [bx, bz] = P[i];
      for (let cx = Math.floor((Math.min(ax, bx) - R) / BC); cx <= Math.floor((Math.max(ax, bx) + R) / BC); cx++)
        for (let cz = Math.floor((Math.min(az, bz) - R) / BC); cz <= Math.floor((Math.max(az, bz) + R) / BC); cz++) {
          const k = key(cx, cz);
          let arr = G.get(k);
          if (!arr) G.set(k, (arr = []));
          let e = arr.length && arr[arr.length - 1].run === run ? arr[arr.length - 1] : null;
          if (!e) arr.push((e = { run, segs: [], x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }));
          e.segs.push(ax, az, bx, bz, Y[i - 1], Y[i]);
          e.x0 = Math.min(e.x0, ax, bx); e.x1 = Math.max(e.x1, ax, bx); e.z0 = Math.min(e.z0, az, bz); e.z1 = Math.max(e.z1, az, bz);
        }
    }
    graded.push(run);
  };
  let state = 0; // 0: not built, 1: building (the ground it samples is the ground without it), 2: built
  const build = () => { state = 1; runs.forEach((r, i) => addRun(r, i)); state = 2; };
  return {
    bounds: { minx, minz, maxx, maxz }, shaper: true, id: 'piste-grade', runs: graded,
    apply(x, z, h) {
      if (state !== 2) { if (state === 1) return h; build(); }
      if (!G.has(key(Math.floor(x / BC), Math.floor(z / BC))) || inRegion(x, z)) return h;
      return graded_(x, z, h, Infinity);
    },
  };
}
