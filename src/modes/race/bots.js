// Race AI: course model, racing line, skiing physics and race craft of the AI racers.
//
// Every bot rides a computed racing line (corners cut within the track width), with its speed set by
// the real snow under it: gravity from the actual height change (exact energy), snow friction (ice
// via course.frictionAt), air drag (tucked on fast straights), a cornering limit v <= sqrt(aLat * R)
// (banked turns allow more), look-ahead braking and ballistic flight off kickers and lips with a
// landing absorb. Each bot has its own abilities (cornering, gliding, start reaction, consistency);
// the field of a difficulty is calibrated against a reference run of an ideal player on the same
// course, so Easy / Medium / Hard feel the same on every course.
//
// Lateral offsets in this module are LEFT-positive (heading h: forward (sin h, cos h), left (cos h, -sin h)).
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { mulberry32, clamp, lerp } from '../../core/noise.js';
import { AISkierAnim, makeStyle } from '../../player/aistate.js';

const G = 9.81;
export const DS = 2;              // internal track sample spacing (m)
export const SIM_H = 1 / 120;     // fixed physics step of the bots (s)
const CAL_H = 1 / 60;             // step of the headless 1D simulations (calibration, fast-forward)
const AIR = 0.5 * 1.15 / 80;      // 0.5 * air density / mass: drag acceleration = AIR * CdA * v^2
const ABSORB_H = 0.25;            // drop below the ballistic path (m) the legs soak up without taking off
const LOOK_T = 0.1;               // take-off look-ahead (s): an edge launches, a gentle crest is absorbed
const SHARP = 30;                 // m/s^2: the snow must fall away at least this much faster than gravity
const EDGE = 0.9;                 // closest a skier's center gets to a barrier (m)
const V_MIN = 1.6;                // racers never stall below this (skating / herringbone)
const RUNOUT = 90;                // run-out modelled past the finish line (m)
const TAU = Math.PI * 2;
// rig level of detail by distance to the player (m): full-rate poses, 20 Hz poses, 8 Hz poses beyond
// LOD_MID (LOD_FAR s), no shadow casting beyond LOD_SHADOW, not drawn beyond LOD_HIDE
const LOD_NEAR = 120, LOD_MID = 400, LOD_FAR = 0.125, LOD_SHADOW = 170, LOD_HIDE = 700;

// Player-equivalent physics (src/player/player.js) for the reference run the difficulty is calibrated
// against. Keep in sync if the player's ski physics are retuned:
//   glide MU 0.04 / ski speed x ice, CdA 0.2 tucked / 0.42 (+0.06 steering) upright, edge grip A_GRIP
//   21 m/s^2 x ski grip x (0.3 + 0.7 ice), a tuck only holds turns asking < A_CARVE * LOCK_OVER * 0.55
//   (~13.5 m/s^2), skating push 2.6 m/s^2 below 9 m/s, hockey stop ~8 m/s^2.
// refScale: overall time factor of the reference (1 = physically consistent player). Measured with the
// real Player in Node: ~0.965 while Player.reattach() still turns the STICK pull-down into speed.
export const PLAYER_PHYS = { mu: 0.04, cdaTuck: 0.2, cdaUp: 0.48, aGrip: 21, tuckA: 13.5, push: 2.6, pushMax: 9, brake: 7, reaction: 0.15, refScale: 1 };

// Gear: the field is NOT calibrated on the player's own skis (upgrades would then be worthless in a
// race). It is calibrated on a ski between the player's and the 'sport' ski, so better skis keep
// GEAR_SHARE of their raw advantage (elite ~ +2.5% faster than sport, rental ~ -1.4% slower) while
// Easy / Medium / Hard keep their meaning on any pair. RACE_SKI ('pro') rates the medal standards.
export const REF_SKI = { speed: 1.03, grip: 1.08 };
export const RACE_SKI = { speed: 1.06, grip: 1.16 };
export const GEAR_SHARE = 0.5;
/** Ski the AI field is calibrated against for a player on `playerSki` ({ speed, grip }). */
export function calibrationSki(playerSki) {
  const sp = Number.isFinite(playerSki?.speed) ? playerSki.speed : 1, gr = Number.isFinite(playerSki?.grip) ? playerSki.grip : 1;
  return { speed: lerp(REF_SKI.speed, sp, GEAR_SHARE), grip: lerp(REF_SKI.grip, gr, GEAR_SHARE) };
}

export const BOT_NAMES = [
  'Lukas Brunner', 'Sofia Moretti', 'Henrik Lund', 'Chloé Martin', 'Matteo Rossi', 'Anna Keller',
  'Jonas Berg', 'Mia Novak', 'Kai Tanaka', 'Elsa Lindqvist', 'Tom Fischer', 'Nina Hofer',
  'Lena Vogt', 'Arno Kristiansen', 'Julia Sauer', 'Pierre Lambert',
];

// Difficulty: `pace` = clean-run target times of a full 14-racer field relative to the reference run
// (traffic, starts and mistakes add ~1-2% in a real race), fastest first; a smaller field spreads over the
// same range (fieldPaces). The reference is an ideal run; real players are much slower than the headless
// driver models suggest (wider lines, skids, net contacts, wipeouts): a great run is ~1.03-1.06 x
// reference, a casual one ~1.15-1.3, a beginner's ~1.35-1.5 with a wipeout or two. The fastest racer of
// each level is the same as in the old five-racer fields, so winning is as hard as before; the rest of the
// field fills in behind. Easy: a beginner wins. Medium: a fair fight for a casual player. Hard: needs a
// solid, clean run. `mistakes` = mistakes per second for an average-consistency racer.
export const DIFFICULTY = {
  easy: {
    label: 'Easy', pace: [1.16, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.36, 1.39, 1.42, 1.45, 1.48, 1.51, 1.55], aLat: 13.5, lineQ: [0.3, 0.6], tuckA: 5.5, tuckV: 15,
    reaction: [0.32, 0.62], push: [2.3, 2.8], brake: 5, mistakes: 1 / 30, severity: 1, skis: ['sport', 'rental', 'sport', 'pro', 'rental'],
  },
  medium: {
    label: 'Medium', pace: [1.04, 1.06, 1.08, 1.1, 1.12, 1.14, 1.16, 1.18, 1.2, 1.22, 1.24, 1.26, 1.28, 1.3], aLat: 17.5, lineQ: [0.6, 0.85], tuckA: 9, tuckV: 13,
    reaction: [0.18, 0.4], push: [2.7, 3.2], brake: 6, mistakes: 1 / 55, severity: 0.75, skis: ['pro', 'sport', 'pro', 'elite', 'sport'],
  },
  hard: {
    label: 'Hard', pace: [0.99, 1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1, 1.11, 1.13], aLat: 21, lineQ: [0.82, 1.0], tuckA: 12, tuckV: 11,
    reaction: [0.08, 0.22], push: [3.1, 3.6], brake: 7, mistakes: 1 / 110, severity: 0.55, skis: ['elite', 'pro', 'elite', 'pro', 'elite'],
  },
};

/** `count` target paces spread over a difficulty's range (fastest first). */
export function fieldPaces(D, count) {
  const P = D.pace, n = P.length;
  if (count === n) return P.slice();
  const out = [];
  for (let i = 0; i < count; i++) {
    const u = count > 1 ? (i / (count - 1)) * (n - 1) : 0, k = Math.min(n - 2, Math.floor(u));
    out.push(P[k] + (P[k + 1] - P[k]) * (u - k));
  }
  return out;
}

const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const lerpAngle = (a, b, t) => a + wrap(b - a) * t;

// ---------------------------------------------------------------- course line normalisation
// Accepts [{ s, x, z, y, w, heading, bank }], { s: Float32Array, x, z, y, w, bank } or a flat
// Float32Array with stride 7 [s, x, z, y, w, heading, bank].
function readLine(line) {
  const out = { n: 0, s: [], x: [], z: [], y: [], w: [], bank: [] };
  if (!line) return out;
  if (line instanceof Float32Array || line instanceof Float64Array) {
    for (let i = 0; i + 6 < line.length; i += 7) {
      out.s.push(line[i]); out.x.push(line[i + 1]); out.z.push(line[i + 2]); out.y.push(line[i + 3]);
      out.w.push(line[i + 4]); out.bank.push(line[i + 6]);
    }
  } else if (line.x && line.x.length !== undefined && !Array.isArray(line)) {
    const n = line.x.length;
    for (let i = 0; i < n; i++) {
      out.s.push(line.s ? line.s[i] : i * DS); out.x.push(line.x[i]); out.z.push(line.z[i]); out.y.push(line.y[i]);
      out.w.push(line.w ? line.w[i] : 8); out.bank.push(line.bank ? line.bank[i] : 0);
    }
  } else {
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      out.s.push(p.s ?? i * DS); out.x.push(p.x); out.z.push(p.z); out.y.push(p.y ?? 0); out.w.push(p.w ?? 8); out.bank.push(p.bank || 0);
    }
  }
  // drop duplicate / non-increasing samples
  const keep = [0];
  for (let i = 1; i < out.s.length; i++) if (out.s[i] > out.s[keep[keep.length - 1]] + 1e-3) keep.push(i);
  for (const k of ['s', 'x', 'z', 'y', 'w', 'bank']) out[k] = keep.map((i) => out[k][i]);
  out.n = keep.length;
  return out;
}

// Snow multiplier from course.frictionAt(s): 1 = groomed snow, < 1 = ice (e.g. 0.35 on a frozen lake).
// Like the player: glide friction x fr, edge grip and braking x (0.3 + 0.7 fr).
function normFriction(v) {
  return Number.isFinite(v) && v > 0 ? clamp(v, 0.05, 2) : 1;
}
const gripOf = (fr) => 0.3 + 0.7 * Math.min(1, fr);

// ---------------------------------------------------------------- track model
export class Track {
  constructor(course) {
    this.course = course;
    const src = readLine(course.line);
    if (src.n < 2) throw new Error('Race: course line has too few samples');
    this.s0 = src.s[0];
    const sEnd = src.s[src.n - 1];
    this.lineEnd = sEnd;
    this.finishS = Number.isFinite(course.finish?.s) ? course.finish.s : Number.isFinite(course.length) ? course.length : sEnd;
    const n = (this.n = Math.ceil((sEnd - this.s0) / DS) + 1);
    const X = (this.X = new Float64Array(n)), Z = (this.Z = new Float64Array(n)), Y = (this.Y = new Float64Array(n));
    const W = (this.W = new Float64Array(n)), B = (this.B = new Float64Array(n));
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = this.s0 + i * DS;
      while (j < src.n - 2 && src.s[j + 1] < s) j++;
      const sa = src.s[j], sb = src.s[j + 1];
      const f = (s - sa) / (sb - sa || 1), fc = clamp(f, 0, 1);
      X[i] = lerp(src.x[j], src.x[j + 1], f); Z[i] = lerp(src.z[j], src.z[j + 1], f); Y[i] = lerp(src.y[j], src.y[j + 1], f);
      W[i] = Math.max(1.2, lerp(src.w[j], src.w[j + 1], fc)); B[i] = lerp(src.bank[j], src.bank[j + 1], fc);
    }
    // heading + curvature from the geometry itself (independent of the course's own conventions)
    const H = (this.H = new Float64Array(n)), K = (this.K = new Float64Array(n));
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      H[i] = Math.atan2(X[b] - X[a], Z[b] - Z[a]);
    }
    for (let i = 1; i < n - 1; i++) K[i] = wrap(H[i + 1] - H[i - 1]) / (2 * DS);
    smooth(K, 2, 3);
    this.NX = new Float64Array(n); this.NZ = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.NX[i] = Math.cos(H[i]); this.NZ[i] = -Math.sin(H[i]); }
    this.gradeEnd = (Y[n - 1] - Y[n - 2]) / DS;
    this.gradeStart = (Y[1] - Y[0]) / DS;
    // snow friction along the course
    this.F = new Float32Array(n).fill(1);
    if (typeof course.frictionAt === 'function') for (let i = 0; i < n; i++) this.F[i] = normFriction(course.frictionAt(this.s0 + i * DS));
    this.latSign = this.detectLatSign();
    this.features = (course.features || []).filter((f) => f && Number.isFinite(f.s0));
    this._fr = {};
    this.buildBounds();
    this.raceLat = this.computeRacingLine();
    this.centerLat = new Float64Array(n);
    // ground profiles (1 m) for the 1D simulations: the snow is planar across the track (banked), so a
    // centerline profile and one 60% out to the left give any line's profile by linear interpolation
    this.profCenter = this.buildProfile(this.centerLat);
    this.sideLat = Float64Array.from(this.W, (w) => 0.6 * w);
    this.profSide = this.buildProfile(this.sideLat);
    this.profRace = this.profileFor(this.raceLat);
    this.jumps = this.findJumps(this.profRace);
  }

  // Sign of the course's own `lateral` (project / pointAt) relative to our left-positive offsets.
  detectLatSign() {
    const c = this.course;
    const fr = this.frame(this.s0 + (this.n - 1) * DS * 0.37, {});
    try {
      if (typeof c.pointAt === 'function') {
        const a = c.pointAt(fr.s, 0), b = c.pointAt(fr.s, 2);
        if (a && b) {
          const d = (b.x - a.x) * fr.nx + (b.z - a.z) * fr.nz;
          if (Math.abs(d) > 0.5) return Math.sign(d);
        }
      }
      if (typeof c.project === 'function') {
        const p = c.project(fr.x + fr.nx * 2, fr.z + fr.nz * 2, fr.s);
        if (p && Number.isFinite(p.lateral) && Math.abs(p.lateral) > 0.5) return Math.sign(p.lateral);
      }
    } catch (e) { console.warn('Race: lateral convention probe failed', e); }
    return 1;
  }

  /** Interpolated centerline frame at distance s (extrapolates straight beyond both ends). */
  frame(s, out = this._fr) {
    const n = this.n, u = (s - this.s0) / DS;
    let i, f, ext = 0;
    if (u < 0) { i = 0; f = 0; ext = u * DS; } else if (u >= n - 1) { i = n - 2; f = 1; ext = (u - (n - 1)) * DS; } else { i = Math.floor(u); f = u - i; }
    const k = i + 1;
    const h = lerpAngle(this.H[i], this.H[k], f);
    out.s = s; out.i = i; out.f = f; out.h = h;
    out.x = this.X[i] + (this.X[k] - this.X[i]) * f + Math.sin(h) * ext;
    out.z = this.Z[i] + (this.Z[k] - this.Z[i]) * f + Math.cos(h) * ext;
    out.y = this.Y[i] + (this.Y[k] - this.Y[i]) * f + ext * (ext > 0 ? this.gradeEnd : this.gradeStart);
    out.w = this.W[i] + (this.W[k] - this.W[i]) * f;
    out.bank = this.B[i] + (this.B[k] - this.B[i]) * f;
    out.k = ext ? 0 : this.K[i] + (this.K[k] - this.K[i]) * f;
    out.fr = this.F[i] + (this.F[k] - this.F[i]) * f;
    out.nx = Math.cos(h); out.nz = -Math.sin(h);
    return out;
  }

  /** Linear sample of a per-DS array at distance s (clamped). */
  sample(arr, s) {
    const u = clamp((s - this.s0) / DS, 0, this.n - 1.000001);
    const i = Math.floor(u), f = u - i;
    return arr[i] + (arr[Math.min(this.n - 1, i + 1)] - arr[i]) * f;
  }

  /** Linear sample of a 1 m profile at distance s (clamped). */
  prof(p, s) {
    const u = clamp(s - this.s0, 0, p.length - 1.000001);
    const i = Math.floor(u), f = u - i;
    return p[i] + (p[i + 1] - p[i]) * f;
  }

  halfWidth(s) { return this.sample(this.W, s); }

  /**
   * Lateral window [lo, hi] a skier must hold from s over the next `ahead` meters (gates, narrow
   * kickers). Stops at the first window that conflicts (alternating slalom gates): the nearest one counts.
   */
  window(s, ahead, out) {
    let lo = this.sample(this.lo, s) - 0.5, hi = this.sample(this.hi, s) + 0.5;
    for (let k = 1; k <= 6; k++) {
      const q = s + (ahead * k) / 6;
      const l = Math.max(lo, this.sample(this.lo, q) - 0.5), h = Math.min(hi, this.sample(this.hi, q) + 0.5);
      if (l > h) break;
      lo = l; hi = h;
    }
    out.lo = lo; out.hi = hi;
    return out;
  }

  /** Ground a skier rides at (x, z): terrain or walkable surfaces (kickers, bridge decks). */
  ground(x, z, yHint, lineY) {
    const g = world.groundHeight(x, z, yHint);
    // safety net against geometry overhead (e.g. a tunnel roof carved as terrain): stay on the track
    if (lineY !== undefined && g > lineY + 8 && yHint < g - 2) return lineY;
    return g;
  }

  // Lateral bounds of the racing line, narrowed over kickers that don't span the track and at gates.
  buildBounds() {
    const n = this.n, lo = (this.lo = new Float64Array(n)), hi = (this.hi = new Float64Array(n));
    const m = 1.4;
    for (let i = 0; i < n; i++) {
      lo[i] = -this.W[i] + m; hi[i] = this.W[i] - m;
      if (lo[i] > hi[i]) lo[i] = hi[i] = 0;
    }
    // C = where the line is constrained (gates, narrow kickers): every racer commits to the racing line there
    const C = (this.C = new Float64Array(n));
    const limit = (s0, s1, a, b) => {
      for (let i = Math.max(0, Math.floor((s0 - this.s0) / DS)); i <= Math.min(n - 1, Math.ceil((s1 - this.s0) / DS)); i++) {
        const l = Math.max(lo[i], a), h = Math.min(hi[i], b);
        if (l <= h) { lo[i] = l; hi[i] = h; } else { lo[i] = hi[i] = clamp((a + b) / 2, -this.W[i] + EDGE, this.W[i] - EDGE); }
        C[i] = 1;
      }
    };
    this.rampWindows = [];
    for (const f of this.features) {
      if (f.type !== 'kicker' && f.type !== 'tabletop' && f.type !== 'roller') continue;
      const ext = this.probeRamp(f);
      if (!ext) continue;
      this.rampWindows.push({ s0: f.s0, s1: f.s1 ?? f.s0 + 8, ...ext });
      // line up straight over the ramp (from well before it) instead of clipping its side wall
      limit(f.s0 - 26, (f.s1 ?? f.s0 + 8) + 2, ext.a + 1, ext.b - 1);
    }
    this.gates = [];
    for (const g of this.course.gates || []) {
      if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.z)) continue;
      let s = g.s;
      if (!Number.isFinite(s)) s = this.nearestS(g.x, g.z);
      const fr = this.frame(s, {});
      const latA = (g.x - fr.x) * fr.nx + (g.z - fr.z) * fr.nz;
      const side = g.side || 1;
      // the second pole sits `side` * width along the course's lateral axis (given as nx, nz when the
      // course provides it); without it, flip the offset if it would land off the track
      let latB;
      if (Number.isFinite(g.nx) && Number.isFinite(g.nz)) {
        const wd = g.width || 5, bx = g.x + g.nx * side * wd, bz = g.z + g.nz * side * wd;
        latB = (bx - fr.x) * fr.nx + (bz - fr.z) * fr.nz;
      } else {
        latB = latA + side * 5 * this.latSign;
        if (Math.abs(latB) > fr.w + 0.5) latB = latA - side * 5 * this.latSign;
      }
      // dir: which way the opening runs from the turning pole (left-positive), span: its width
      const gate = { s, latA, latB, dir: Math.sign(latB - latA) || 1, span: Math.abs(latB - latA), lo: Math.min(latA, latB), hi: Math.max(latA, latB), color: g.color };
      this.gates.push(gate);
      limit(s - 3, s + 3, gate.lo + 1.1, gate.hi - 1.1);
    }
    this.gates.sort((a, b) => a.s - b.s);
    // spread the commitment ~40 m around each constrained stretch
    for (let i = 0; i < n; i++) C[i] = C[i] > 0 ? 1 : 0;
    const peak = Float64Array.from(C);
    smooth(C, 10, 2);
    for (let i = 0; i < n; i++) C[i] = Math.max(peak[i], Math.min(1, C[i] * 2.5));
  }

  /**
   * Projection onto the centerline searched around hintS (fallback when a course has no project()).
   * -> { s, lat (left +), w, y, inside }
   */
  project(x, z, hintS = null, out = {}) {
    const n = this.n;
    let i0 = 0, i1 = n - 1;
    if (Number.isFinite(hintS)) {
      const c = Math.round((hintS - this.s0) / DS);
      i0 = clamp(c - 30, 0, n - 1); i1 = clamp(c + 30, 0, n - 1);
    }
    let best = i0, bd = Infinity;
    for (let i = i0; i <= i1; i++) {
      const d = (this.X[i] - x) ** 2 + (this.Z[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    // the hint was stale (teleport, respawn): search the whole course
    if (bd > (this.W[best] + 30) ** 2 && (i0 > 0 || i1 < n - 1)) {
      for (let i = 0; i < n; i++) {
        const d = (this.X[i] - x) ** 2 + (this.Z[i] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    // refine on the neighbouring segments
    let s = this.s0 + best * DS;
    for (const j of [best - 1, best]) {
      if (j < 0 || j >= n - 1) continue;
      const ex = this.X[j + 1] - this.X[j], ez = this.Z[j + 1] - this.Z[j];
      const t = clamp(((x - this.X[j]) * ex + (z - this.Z[j]) * ez) / (ex * ex + ez * ez || 1), 0, 1);
      const qx = this.X[j] + ex * t - x, qz = this.Z[j] + ez * t - z;
      if (qx * qx + qz * qz <= bd + 1e-9) { bd = qx * qx + qz * qz; s = this.s0 + (j + t) * DS; }
    }
    const fr = this.frame(s, {});
    out.s = s;
    out.lat = (x - fr.x) * fr.nx + (z - fr.z) * fr.nz;
    out.w = fr.w; out.y = fr.y; out.h = fr.h;
    out.inside = Math.abs(out.lat) <= fr.w + 0.5;
    return out;
  }

  nearestS(x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = (this.X[i] - x) ** 2 + (this.Z[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return this.s0 + best * DS;
  }

  // Lateral extent (left-positive) of a ramp surface across the track, or null if it spans the width.
  probeRamp(f) {
    const len = Number.isFinite(f.s1) ? f.s1 - f.s0 : 8;
    let a = Infinity, b = -Infinity, hits = 0;
    for (const u of [0.35, 0.6, 0.85]) {
      const fr = this.frame(f.s0 + len * u, {});
      const steps = Math.ceil(fr.w / 0.5);
      for (let k = -steps; k <= steps; k++) {
        const lat = k * 0.5, x = fr.x + fr.nx * lat, z = fr.z + fr.nz * lat;
        const raise = world.groundHeight(x, z, fr.y + 12) - world.height(x, z);
        if (raise > 0.12) { a = Math.min(a, lat); b = Math.max(b, lat); hits++; }
      }
    }
    if (!hits) return null;
    const w = this.halfWidth(f.s0 + len * 0.5);
    if (b - a > 2 * w - 2.5) return null;
    return { a, b };
  }

  // Minimum-curvature racing line inside [lo, hi] ("elastic band", coarse to fine): outside on the way
  // in, apex on the inside, outside on the way out; chicanes get straightened.
  computeRacingLine() {
    const n = this.n, lat = new Float64Array(n), { X, Z, NX, NZ, lo, hi } = this;
    for (const k of [32, 16, 8, 4, 2, 1]) {
      const iters = k >= 8 ? 24 : 36;
      if (n <= 2 * k) continue;
      for (let it = 0; it < iters; it++) {
        for (let i = k; i < n - k; i++) {
          const a = i - k, b = i + k;
          const mx = 0.5 * (X[a] + NX[a] * lat[a] + X[b] + NX[b] * lat[b]);
          const mz = 0.5 * (Z[a] + NZ[a] * lat[a] + Z[b] + NZ[b] * lat[b]);
          const t = (mx - X[i]) * NX[i] + (mz - Z[i]) * NZ[i];
          const v = lat[i] + 0.7 * (t - lat[i]);
          lat[i] = v < lo[i] ? lo[i] : v > hi[i] ? hi[i] : v;
        }
      }
    }
    smooth(lat, 2, 2);
    for (let i = 0; i < n; i++) lat[i] = clamp(lat[i], lo[i], hi[i]);
    return lat;
  }

  /**
   * Planned lateral offsets of one skier: blend of racing line and centerline plus a personal lane,
   * committed to the racing line through gates and over narrow kickers.
   */
  planFor(q, bias) {
    const n = this.n, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.C[i], qi = q + (1 - q) * c;
      out[i] = clamp(this.raceLat[i] * qi + bias * (1 - c), this.lo[i], this.hi[i]);
    }
    smooth(out, 1, 1);
    for (let i = 0; i < n; i++) out[i] = clamp(out[i], this.lo[i], this.hi[i]);
    return out;
  }

  /** Signed curvature (left +) and path factor (path length per meter of course) of a planned line. */
  pathOf(plan) {
    const n = this.n, PX = new Float64Array(n), PZ = new Float64Array(n);
    for (let i = 0; i < n; i++) { PX[i] = this.X[i] + this.NX[i] * plan[i]; PZ[i] = this.Z[i] + this.NZ[i] * plan[i]; }
    const k = new Float64Array(n), pf = new Float32Array(n);
    for (let i = 2; i < n - 2; i++) {
      const ax = PX[i] - PX[i - 2], az = PZ[i] - PZ[i - 2], bx = PX[i + 2] - PX[i], bz = PZ[i + 2] - PZ[i];
      const cross = ax * bz - az * bx;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(PX[i + 2] - PX[i - 2], PZ[i + 2] - PZ[i - 2]);
      k[i] = la * lb * lc > 1e-9 ? (-2 * cross) / (la * lb * lc) : 0;
    }
    smooth(k, 1, 2);
    for (let i = 0; i < n - 1; i++) pf[i] = Math.max(0.3, Math.hypot(PX[i + 1] - PX[i], PZ[i + 1] - PZ[i]) / DS);
    pf[n - 1] = pf[n - 2];
    return { k, pf };
  }

  /** Ground profile of a planned line (exact sampling when narrow ramps break the planar assumption). */
  profileFor(plan) {
    if (this.rampWindows.length) return this.buildProfile(plan);
    const a = this.profCenter, b = this.profSide, out = new Float32Array(a.length);
    for (let j = 0; j < a.length; j++) {
      const s = this.s0 + j;
      const k = this.sample(plan, s) / Math.max(0.5, this.sample(this.sideLat, s));
      out[j] = a[j] + (b[j] - a[j]) * k;
    }
    return out;
  }

  // Ground height every 1 m along a planned line (includes ramp surfaces and bridge decks).
  buildProfile(plan) {
    const m = Math.ceil(this.finishS + RUNOUT - this.s0) + 2;
    const p = new Float32Array(m);
    const fr = {};
    let hint = this.Y[0] + 1.5;
    for (let j = 0; j < m; j++) {
      const s = this.s0 + j;
      this.frame(s, fr);
      const lat = this.sample(plan, s);
      const g = this.ground(fr.x + fr.nx * lat, fr.z + fr.nz * lat, hint, fr.y);
      p[j] = g;
      hint = g + 1.0;
    }
    return p;
  }

  // Take-off points along the racing line (where the ground falls away from a fast skier) and the
  // fastest take-off speed that still lands softly (speed check before big kickers).
  findJumps(prof) {
    // where a fast skier really takes off: a reference run (ideal player, no speed checks yet)
    this.jumps = [];
    const jumps = [];
    const P = referenceParams(this, null);
    const pf = P.path.pf;
    let airT = 0, launchS = 0, was = false;
    simulateRun(this, P, null, (st) => {
      if (st.air && !was) { launchS = st.s; airT = 0; }
      if (st.air) airT += CAL_H;
      if (!st.air && was && airT > 0.3) jumps.push({ s: launchS, air: airT });
      was = st.air;
    });
    for (const j of jumps) {
      let cap = null, okSeen = false;
      for (let v = 8; v <= 46; v += 2) {
        const impact = landingImpact(this, prof, pf, j.s - 1.5, v);
        if (impact <= 9) { okSeen = true; cap = v; } else if (okSeen) break;
      }
      j.cap = okSeen && cap < 46 ? cap : null;
    }
    return jumps;
  }
}

// Box smoothing in place: `passes` passes of a (2r+1)-tap box filter.
function smooth(a, r, passes) {
  const n = a.length, tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < n) { s += a[j]; c++; } }
      tmp[i] = s / c;
    }
    a.set(tmp);
  }
}

// ---------------------------------------------------------------- 1D simulation (profile based)
// One step of a skier along a planned line using a ground profile: follows the snow, takes off where
// the ground falls away faster than gravity can follow (beyond what the legs absorb), flies
// ballistically and lands on the profile. Mutates st { s, v, y, vy, air, vh, tanA }; returns the
// landing impact (m/s) when it lands this step.
function flightStep(track, prof, pf, st, h, accel) {
  const f = track.sample(pf, st.s);
  if (!st.air) {
    const cosA = 1 / Math.sqrt(1 + st.tanA * st.tanA);
    const dh = st.v * cosA * h;
    const sN = st.s + dh / f;
    const gN = track.prof(prof, sN);
    const yb = st.y + st.vy * h - 0.5 * G * h * h;
    // the snow falls away from the ballistic path: take off at a real edge, absorb small changes
    if (gN < yb - 0.5 * SHARP * h * h && st.v > 6) {
      const gF = track.prof(prof, st.s + (st.v * cosA * LOOK_T) / f);
      if (gF < st.y + st.vy * LOOK_T - 0.5 * G * LOOK_T * LOOK_T - ABSORB_H) {
        st.air = true; st.vh = st.v * cosA; st.vy -= G * h; st.y = yb; st.s = sN;
        return 0;
      }
    }
    const dy = gN - st.y;
    st.tanA = dy / Math.max(1e-4, dh);
    const v2 = st.v * st.v - 2 * G * dy;
    st.v = v2 > 0 ? Math.sqrt(v2) : 0;
    if (accel) st.v = Math.max(V_MIN, st.v + accel(st, cosA) * h);
    st.vy = dy / h; st.y = gN; st.s = sN;
    return 0;
  }
  st.vy -= G * h;
  st.y += st.vy * h;
  st.s += (st.vh * h) / f;
  const gN = track.prof(prof, st.s);
  if (st.y > gN) return 0;
  const tanB = (track.prof(prof, st.s + 0.5) - track.prof(prof, st.s - 0.5)) / f;
  const cb = 1 / Math.sqrt(1 + tanB * tanB), sb = tanB * cb;
  const along = st.vh * cb + st.vy * sb, perp = -st.vh * sb + st.vy * cb;
  const impact = Math.max(0, -perp);
  st.v = Math.max(V_MIN, along) * (1 - landingLoss(impact));
  st.y = gN; st.vy = st.v * sb; st.tanA = tanB; st.air = false;
  return impact;
}

// Put a 1D skier state on the snow at st.s, moving with the local slope (no spurious take-off).
function settle(track, prof, pf, st) {
  st.y = track.prof(prof, st.s);
  st.tanA = (track.prof(prof, st.s + 0.5) - track.prof(prof, st.s - 0.5)) / track.sample(pf, st.s);
  st.vy = st.v * st.tanA / Math.sqrt(1 + st.tanA * st.tanA);
  st.air = false;
  return st;
}

// Fraction of speed lost absorbing a landing of the given impact speed (m/s).
function landingLoss(impact) { return clamp((impact - 2.5) * 0.012, 0, 0.18); }

// Landing impact for a take-off at speed v from just before a lip.
function landingImpact(track, prof, pf, s, v) {
  const st = settle(track, prof, pf, { s, v, y: 0, vy: 0, air: false, vh: 0, tanA: 0 });
  for (let k = 0; k < 900; k++) {
    const wasAir = st.air;
    const imp = flightStep(track, prof, pf, st, CAL_H, null);
    if (wasAir && !st.air) return imp;
    if (!st.air && k > 40) return 0; // rolled it
    st.v = Math.max(st.v, v * 0.5);
  }
  return 99;
}

// Longitudinal acceleration other than gravity (gravity comes exactly from height changes).
function longAccel(P, v, cosA, fr, tuck, vcap, pushing, dragMul) {
  const cda = tuck ? P.cdaTuck : P.cdaUp;
  let a = -P.mu * fr * G * cosA - AIR * cda * dragMul * v * v;
  if (pushing) a += P.push * Math.max(0, 1 - v / P.pushMax);
  if (v > vcap) a -= Math.min(P.brake * gripOf(fr), (v - vcap) * 3 + 0.4);
  return a;
}

/**
 * Speed limit profile of one skier: cornering limit sqrt(aLat * R) (bank and ice aware), jump speed
 * checks, then a backward pass so it brakes in time (braking is weaker on steep downhill pitches).
 */
export function speedProfile(track, path, P) {
  const n = track.n, vlim = new Float32Array(n), vmax = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(path.k[i]);
    let a = P.aLat * gripOf(track.F[i]);
    const bank = track.B[i];
    if (Math.abs(bank) > 0.01 && k > 1e-4) {
      const into = (bank > 0 && path.k[i] < 0) || (bank < 0 && path.k[i] > 0); // + bank leans right
      a += (into ? 0.9 : -0.4) * G * Math.tan(Math.min(0.6, Math.abs(bank)));
    }
    vlim[i] = k > 1e-5 ? Math.sqrt(Math.max(4, a) / k) : 80;
  }
  for (const j of track.jumps) {
    if (j.cap === null) continue;
    const i = Math.round((j.s - track.s0) / DS);
    for (let d = -1; d <= 0; d++) if (i + d >= 0 && i + d < n) vlim[i + d] = Math.min(vlim[i + d], j.cap);
  }
  vmax[n - 1] = vlim[n - 1];
  const prof = track.profCenter;
  for (let i = n - 2; i >= 0; i--) {
    const d = DS * path.pf[i];
    const s = track.s0 + i * DS;
    const drop = (track.prof(prof, s) - track.prof(prof, s + DS)) / d;
    const dec = Math.max(1.2, P.brake * gripOf(track.F[i]) - G * drop);
    vmax[i] = Math.min(vlim[i], Math.sqrt(vmax[i + 1] * vmax[i + 1] + 2 * dec * d));
  }
  return vmax;
}

/**
 * Headless run of a skier along its plan with the same physics as the live bots (no traffic, no
 * mistakes). Used to calibrate the field and to fast-forward unfinished bots for the results.
 * @returns {number} finish time (s from GO)
 */
export function simulateRun(track, P, from = null, trace = null) {
  const prof = P.prof, pf = P.path.pf;
  const st = settle(track, prof, pf, { s: from?.s ?? P.startS ?? track.s0, v: from?.v ?? 0, y: 0, vy: 0, air: false, vh: 0, tanA: 0 });
  let t = from?.t ?? 0;
  const t0 = t;
  let tuck = false;
  const accel = (s, cosA) => {
    const fr = track.sample(track.F, s.s);
    const vcap = track.sample(P.vmax, s.s);
    const k = Math.abs(track.sample(P.path.k, s.s));
    tuck = s.v > P.tuckV && s.v * s.v * k < P.tuckA && s.v <= vcap + 0.3;
    // skating / double-poling whenever slower than the push speed (start, flats), like the player
    return longAccel(P, s.v, cosA, fr, tuck, vcap, s.v < P.pushMax, P.dragMul);
  };
  if (!from) t += P.reaction;
  let prevS = st.s, guard = 0;
  const fin = track.finishS;
  while (st.s < fin && guard++ < 400000) {
    prevS = st.s;
    flightStep(track, prof, pf, st, CAL_H, accel);
    if (st.air) st.vh *= 1 - AIR * P.cdaUp * P.dragMul * st.vh * CAL_H;
    t += CAL_H;
    if (trace) trace(st, t, tuck);
  }
  // interpolate the crossing within the last step
  const over = st.s - fin, span = st.s - prevS;
  return guard >= 400000 ? t0 + 9999 : t - (span > 1e-6 ? (over / span) * CAL_H : 0);
}

// ---------------------------------------------------------------- the field
/**
 * Create the AI field for a race: names, outfits, abilities, racing lines and physics, calibrated so
 * each bot's clean run lands on its difficulty target relative to the reference (ideal player) run.
 * @param {Track} track
 * @param {object} o { difficulty, count=5, seed, playerSki: { speed, grip } (the player's skis; the
 *        reference skier rides calibrationSki(playerSki)) }
 * @returns {{ specs: object[], refTime: number }}
 */
export function createField(track, { difficulty = 'medium', count = 5, seed = 1, playerSki = null } = {}) {
  const D = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const rnd = mulberry32(seed >>> 0);
  const refTime = referenceTime(track, calibrationSki(playerSki));
  const names = [...BOT_NAMES];
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  const paces = fieldPaces(D, count);
  for (let i = paces.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [paces[i], paces[j]] = [paces[j], paces[i]]; }
  // personal lanes around the racing line: a big field spreads across the piste instead of queueing
  // single file on one line (the lanes close in through gates and over narrow kickers, see planFor)
  const spread = count > 6 ? 3.6 : 1.6;
  const specs = [];
  for (let i = 0; i < count; i++) {
    const ab = { cornering: rnd(), gliding: rnd(), start: rnd(), consistency: rnd() };
    if (difficulty === 'hard') ab.consistency = 0.35 + ab.consistency * 0.65; // pros don't fall apart
    const q = lerp(D.lineQ[0], D.lineQ[1], rnd());
    const bias = (rnd() - 0.5) * spread;
    const plan = track.planFor(q, bias);
    const path = track.pathOf(plan);
    const prof = track.profileFor(plan);
    const spec = {
      index: i, name: names[i % names.length], difficulty, abilities: ab, lineQ: q, bias, plan, path, prof,
      targetPace: paces[i % paces.length] * (0.995 + rnd() * 0.01), ski: D.skis[i % D.skis.length],
      mistakeRate: D.mistakes * lerp(1.5, 0.5, ab.consistency), severity: D.severity * lerp(1.25, 0.7, ab.consistency),
      seed: Math.floor(rnd() * 1e9),
    };
    const base = {
      cornerK: lerp(0.88, 1.12, ab.cornering), dragK: lerp(1.06, 0.94, ab.gliding), muK: lerp(1.04, 0.96, ab.gliding),
      reaction: lerp(D.reaction[1], D.reaction[0], ab.start), push: lerp(D.push[0], D.push[1], ab.start),
    };
    spec.paramsAt = (p) => {
      const P = {
        mu: (PLAYER_PHYS.mu / 1.06) * base.muK, cdaTuck: 0.2, cdaUp: 0.42, dragMul: base.dragK / (p * p),
        aLat: D.aLat * base.cornerK * p * p, brake: D.brake, push: base.push, pushMax: 9.5, reaction: base.reaction,
        tuckA: D.tuckA, tuckV: D.tuckV, prof, path, pace: p,
      };
      P.vmax = speedProfile(track, path, P);
      return P;
    };
    // calibrate the pace so the clean run hits the target time (12 halvings: ~0.02% of the pace, plenty;
    // a 14-racer field calibrates behind the loading card in about a second)
    const target = refTime * spec.targetPace;
    let lo = 0.3, hi = 1.07, P = null; // (an Easy field rides well below its full potential)
    for (let it = 0; it < 12; it++) {
      const p = (lo + hi) / 2;
      const t = simulateRun(track, spec.paramsAt(p));
      if (t > target) lo = p; else hi = p;
    }
    P = spec.paramsAt((lo + hi) / 2);
    spec.P = P;
    // the clean run's time at every ~4 m (cleanTab: s, t pairs): the results project unfinished bots from it
    const tab = [];
    spec.cleanTime = simulateRun(track, P, null, (st, t) => { if (tab.length < 2 || st.s - tab[tab.length - 2] >= 4) tab.push(st.s, t); });
    spec.cleanTab = Float64Array.from(tab);
    spec.targetTime = target;
    specs.push(spec);
  }
  return { specs, refTime };
}

// Physics of an ideal player run on the racing line: carving at the edge-grip limit, tucked whenever
// the turn allows it, player-equivalent snow and drag for the player's skis.
function referenceParams(track, playerSki) {
  const mult = playerSki?.speed || 1, grip = playerSki?.grip || 1;
  const path = track.pathOf(track.raceLat);
  const P = {
    mu: PLAYER_PHYS.mu / mult, cdaTuck: PLAYER_PHYS.cdaTuck, cdaUp: PLAYER_PHYS.cdaUp, dragMul: 1 / (mult * mult),
    aLat: PLAYER_PHYS.aGrip * grip, brake: PLAYER_PHYS.brake, push: PLAYER_PHYS.push, pushMax: PLAYER_PHYS.pushMax,
    reaction: PLAYER_PHYS.reaction, tuckA: PLAYER_PHYS.tuckA * grip, tuckV: 4, prof: track.profRace, path,
  };
  P.vmax = speedProfile(track, path, P);
  return P;
}

/** Clean run time of an ideal player (tucked where possible, racing line) on this course. */
export function referenceTime(track, playerSki = null) {
  return simulateRun(track, referenceParams(track, playerSki)) * PLAYER_PHYS.refScale;
}

// ---------------------------------------------------------------- live AI racer
const UP = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3(), _r = new THREE.Vector3();

export class BotRacer {
  /**
   * @param {object} spec  from createField
   * @param {Track} track
   * @param {object} [o]   { rig, fxId }
   */
  constructor(spec, track, { rig = null, fxId = 3000 } = {}) {
    this.spec = spec;
    this.P = spec.P;
    this.track = track;
    this.rig = rig;
    this.fxId = fxId;
    this.name = spec.name;
    this.rnd = mulberry32(spec.seed);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this._fr = {};
    this._fr2 = {};
    this._win = {};
    this.anim = { mode: 'ski', heading: 0, speed: 0, crouch: 0.3, lean: 0, edge: 0, skid: 0, tuck: false, plow: 0, normal: this.normal, air: false };
    this.fxInfo = { grounded: true, speed: 0, vel: this.vel, sideslip: 0, plow: 0, lean: 0 };
    // level of detail: where/at which heading the pose was last solved (the rig is carried from there)
    this.animPos = new THREE.Vector3();
    this.animHeading = 0;
    this.visible = true;
    this.shadow = true;
    this.shadowMeshes = [];
    rig?.root?.traverse((o) => { if (o.isMesh && o.castShadow) this.shadowMeshes.push(o); });
    this.reset(0, 0);
  }

  /** Put the bot on its grid slot (s, lateral left-positive) before the start. */
  reset(s, lat, attempt = 0) {
    const tr = this.track;
    this.rnd = mulberry32((this.spec.seed + attempt * 7919) >>> 0); // fresh mistakes on every attempt
    this.s = s; this.lat = lat; this.latVel = 0; this.v = 0; this.vh = 0; this.vy = 0; this.tanA = 0;
    this.t = 0; this.started = false; this.running = false;
    this.air = false; this.airT = 0; this.finished = false; this.finishTime = null; this.stopped = false;
    this.laneOff = lat - tr.sample(this.spec.plan, s);
    this.passLat = null; this.passTarget = null; this.passT = 0; this.repel = 0; this.followCap = Infinity; this.draft = 0;
    this.mistake = null; this.mistakeOff = 0; this.mistakes = 0; this.rb = 1; this.rbTarget = 1;
    this.tuck = false; this.tuckHold = 0; this.lean = 0; this.edge = 0; this.crouchImp = 0; this.wobble = 0; this.pushing = false; this.braking = false;
    this.skidYaw = 0; this.skid = 0; this.sRate = 0; this.prevTravel = null; this.aLat = 0;
    this.lastTurn = 0; this.plantT = 0; this.pushT = 0; this.acc = 0; this.animAcc = 0; this.fxAcc = 0; this.normalT = 0;
    this.parkLat = 0; this.minV = Infinity; this.maxLatOut = -Infinity;
    this.animator?.reset(); this.landPending = 0; this.wasAirF = false; // (animation: no stale springs or plants)
    const fr = tr.frame(s, this._fr);
    const x = fr.x + fr.nx * lat, z = fr.z + fr.nz * lat;
    this.y = tr.ground(x, z, fr.y + 2, fr.y);
    this.travel = fr.h;
    this.heading = fr.h;
    this.pos.set(x, this.y, z);
    this.vel.set(0, 0, 0);
    this.animPos.copy(this.pos);
    this.animHeading = this.heading;
    if (this.rig) {
      this.rig.root.position.copy(this.pos);
      this.rig.gear?.position.set(0, 0, 0);
      this.rig.gear?.rotation.set(0, 0, 0);
    }
  }

  /** Shift the racer by a world-space offset (contact resolution); converted into course coordinates. */
  nudge(dx, dz) {
    const fr = this.track.frame(this.s, this._fr2);
    this.s += dx * Math.sin(fr.h) + dz * Math.cos(fr.h);
    this.lat += dx * fr.nx + dz * fr.nz;
    const w = Math.max(0, this.track.halfWidth(this.s) - EDGE);
    this.lat = clamp(this.lat, -w, w);
    this.pos.x += dx; this.pos.z += dz;
  }

  /** Race clock started (GO). The bot reacts after its start reaction time. */
  go() { this.running = true; this.t = 0; }

  /**
   * Shoulder contact with another racer: shift sideways by `dlat` (left +, kept inside the track) and,
   * for the one behind, give up a little speed. The world position follows at once.
   */
  bump(dlat, dv = 0) {
    const fr = this.track.frame(this.s, this._fr2);
    const w = Math.max(0, fr.w - EDGE);
    const lat = clamp(this.lat + dlat, -w, w);
    this.pos.x += fr.nx * (lat - this.lat); this.pos.z += fr.nz * (lat - this.lat);
    this.lat = lat;
    if (dv > 0) this.v = Math.max(this.finished ? 0 : V_MIN, this.v - dv);
  }

  // ---- race craft, once per frame: traffic, overtaking, side-by-side spacing, mistakes, rubber band
  // racers: [{ self, s, lat, v }] for every racer on course (bots and the player)
  decide(dt, racers) {
    if (!this.running) { this.followCap = Infinity; this.repel = 0; return; }
    if (this.finished) { this.decideFinished(racers); return; }
    const tr = this.track;
    // grid lanes merge onto the racing lines over the first seconds (slower in a big field: it strings
    // out along the course before everyone converges on the line)
    if (this.started) this.laneOff *= Math.exp(-dt / (racers.length > 8 ? 6 : 3.5));
    // traffic ahead in my lane
    let block = null, bestDs = 14;
    this.draft = 0;
    for (const o of racers) {
      if (o.self === this) continue;
      const ds = o.s - this.s, dl = Math.abs(o.lat - this.lat);
      if (ds > 0.4 && ds < bestDs && dl < 1.5) { block = o; bestDs = ds; }
      if (ds > 1.5 && ds < 9 && dl < 1.0) this.draft = Math.max(this.draft, 1 - (ds - 1.5) / 7.5);
    }
    const w = Math.max(0, tr.halfWidth(this.s + bestDs) - EDGE);
    // no overtaking through slalom gates or over narrow kickers: hold the line and wait
    const committed = tr.sample(tr.C, this.s + this.v * 0.8) > 0.3;
    if (this.passLat !== null) {
      // keep the passing lane until clear ahead of the overtaken racer
      this.passT += dt;
      const o = this.passTarget;
      if (!o || committed || o.s < this.s - 3.5 || this.passT > 6 || Math.abs(o.lat - this.passLat) > 2.6) { this.passLat = null; this.passTarget = null; }
    }
    this.followCap = Infinity;
    const pace = Math.min(tr.sample(this.P.vmax, this.s) * this.rb, this.v + 2.5);
    if (block && this.passLat === null && pace > block.v + 0.3 && !this.air && !committed) {
      const plan = tr.sample(this.spec.plan, this.s + 10) + this.laneOff;
      const gap = 1.95;
      const win = tr.window(this.s, bestDs + this.v * 1.5, this._win);
      const sides = [block.lat + gap, block.lat - gap].filter((l) => Math.abs(l) <= w && l >= win.lo && l <= win.hi && laneFree(racers, this, block, l, bestDs));
      if (sides.length) {
        sides.sort((a, b) => Math.abs(a - plan) - Math.abs(b - plan));
        this.passLat = sides[0]; this.passTarget = block; this.passT = 0;
      } else if (bestDs < 6) {
        this.followCap = block.v + 0.15 + (bestDs - 3) * 0.3; // tuck in behind and wait for a gap
      }
    } else if (block && committed && bestDs < 6) {
      this.followCap = block.v + 0.15 + (bestDs - 3) * 0.3;
    }
    // never side-by-side closer than ~1.25 m
    let rep = 0;
    for (const o of racers) {
      if (o.self === this) continue;
      const ds = Math.abs(o.s - this.s), dl = this.lat - o.lat;
      if (ds < 2.8 && Math.abs(dl) < 1.25) rep += (dl >= 0 ? 1 : -1) * (1.25 - Math.abs(dl)) * 1.6;
    }
    this.repel = clamp(rep, -2, 2);
    // mistakes: small, rarer for consistent racers, never in the air or in the last stretch
    if (this.mistake) {
      this.mistake.t += dt;
      if (this.mistake.t > this.mistake.dur) this.mistake = null;
    } else if (this.started && this.t > 3 && !this.air && this.s < tr.finishS - 60 && this.rnd() < dt * this.spec.mistakeRate) {
      this.startMistake();
    }
    this.mistakeOff = 0;
    if (this.mistake?.type === 'wide') {
      const m = this.mistake, env = Math.sin(Math.min(1, m.t / m.dur) * Math.PI);
      const k = tr.sample(this.spec.path.k, this.s + 8);
      this.mistakeOff = -Math.sign(k || 1) * m.mag * env; // drift to the outside of the turn
    }
    // mild rubber band (race mode, set by the session): +-3% so races stay close
    this.rb += (clamp(this.rbTarget, 0.97, 1.03) - this.rb) * Math.min(1, dt / 2);
  }

  // After the line: no racing, but keep clear of everyone in the finish area (incl. the player).
  // Racers ahead in my lane push me aside early enough for a stopping skier to slide past them.
  decideFinished(racers) {
    this.followCap = Infinity;
    this.passLat = null; this.passTarget = null;
    let rep = 0;
    const reach = 2.8 + this.v * 0.6;
    for (const o of racers) {
      if (o.self === this) continue;
      const ds = o.s - this.s, dl = this.lat - o.lat;
      if (ds > -2.8 && ds < reach && Math.abs(dl) < 1.6) rep += (dl >= 0 ? 1 : -1) * (1.6 - Math.abs(dl)) * 1.8;
    }
    this.repel = clamp(rep, -2.5, 2.5);
  }

  startMistake() {
    const r = this.rnd(), sev = this.spec.severity;
    const k = Math.abs(this.track.sample(this.spec.path.k, this.s + 10));
    let type = r < 0.4 ? 'skid' : r < 0.7 ? 'upright' : 'wide';
    if (type === 'wide' && k < 1 / 400) type = 'upright';
    const k2 = 0.55 + 0.45 * Math.min(1, sev); // milder, shorter mistakes for the better racers
    const dur = (type === 'skid' ? 0.45 + this.rnd() * 0.5 : type === 'wide' ? 1.3 + this.rnd() : 1.2 + this.rnd() * 1.4) * k2;
    this.mistake = { type, t: 0, dur, mag: (type === 'wide' ? 1.3 + this.rnd() * 1.2 : 1) * sev, side: this.rnd() < 0.5 ? -1 : 1 };
    this.mistakes++;
  }

  /** Per frame: race craft, then fixed-step physics (call animate() afterwards). */
  update(dt, racers) {
    this.decide(dt, racers);
    this.acc += dt;
    let n = 0;
    while (this.acc >= SIM_H && n < 14) { this.step(SIM_H); this.acc -= SIM_H; n++; }
    if (n >= 14) this.acc = 0;
    // derived world state
    const fr = this.track.frame(this.s, this._fr);
    const nx = fr.x + fr.nx * this.lat, nz = fr.z + fr.nz * this.lat;
    if (dt > 0) this.vel.set((nx - this.pos.x) / dt, (this.y - this.pos.y) / dt, (nz - this.pos.z) / dt);
    if (this.vel.lengthSq() > 70 * 70) this.vel.set(0, 0, 0);
    this.pos.set(nx, this.y, nz);
    if (this.running && this.started && !this.finished) {
      if (this.t > 10) this.minV = Math.min(this.minV, this.v);
      this.maxLatOut = Math.max(this.maxLatOut, Math.abs(this.lat) - fr.w);
    }
  }

  // ---- one fixed physics step
  step(h) {
    const tr = this.track, P = this.P, sp = this.spec;
    if (!this.running) return;
    this.t += h;
    if (!this.started) {
      if (this.t < P.reaction) return;
      this.started = true;
    }
    const fr = tr.frame(this.s, this._fr);
    const wE = Math.max(0, fr.w - EDGE);
    const fin = this.finished;
    // ---- lateral: follow the plan (feed-forward + correction), passing lanes, spacing, mistakes
    if (!this.air) {
      let target, ff = 0;
      if (fin) target = this.parkLat;
      else if (this.passLat !== null) target = this.passLat;
      else {
        target = tr.sample(sp.plan, this.s) + this.laneOff + this.mistakeOff;
        const sa = this.s + this.v * 0.08; // a touch of anticipation for the steering lag
        ff = ((tr.sample(sp.plan, sa + 1) - tr.sample(sp.plan, sa - 1)) / 2) * this.sRate;
        target = tr.sample(sp.plan, sa) + this.laneOff + this.mistakeOff;
      }
      target += this.repel;
      if (!fin) {
        const win = tr.window(this.s, Math.max(6, this.v * 1.2), this._win);
        target = clamp(target, win.lo, win.hi);
      }
      target = clamp(target, -wE, wE);
      const want = ff + (target - this.lat) * (fin ? 0.8 : 1.7);
      // lateral agility: up to ~27 degrees off the fall line, as quick as the edges allow
      const maxV = fin ? Math.min(4, this.v * 0.45) : Math.min(12, 0.5 * this.v + 0.5);
      const aMax = Math.max(9, P.aLat * gripOf(fr.fr) * 1.15) * h;
      this.latVel = clamp(this.latVel + clamp(want - this.latVel, -aMax, aMax), -maxV, maxV);
    }
    const pfac = Math.max(0.3, 1 - fr.k * this.lat);
    if (!this.air) {
      // ---- on the snow
      const vF = Math.sqrt(Math.max(0.0001, this.v * this.v - this.latVel * this.latVel));
      const cosA = 1 / Math.sqrt(1 + this.tanA * this.tanA);
      let vcap = Math.min(tr.sample(P.vmax, this.s) * this.rb, this.followCap);
      let extra = 0;
      const m = this.mistake;
      if (m?.type === 'skid') extra = 2.6 * m.mag;
      else if (m?.type === 'wide') extra = 0.7 * m.mag;
      if (fin) {
        // hockey stop in the finish area; glide on while still far from the parking lane (turn out
        // first, then stop), hard stop right before the closing boards
        vcap = 0;
        const far = Math.abs(this.parkLat - this.lat) > 1.2 && this.s < tr.lineEnd - 45;
        extra = this.s > tr.lineEnd - 8 ? 12 : far ? 2.5 : this.v > 14 ? 6 : 8;
      }
      const k = Math.abs(tr.sample(sp.path.k, this.s));
      const tuckWant = !fin && this.v > P.tuckV && this.v * this.v * k < P.tuckA && this.v <= vcap + 0.3 && m?.type !== 'upright' && m?.type !== 'skid';
      this.tuckHold -= h;
      if (tuckWant !== this.tuck && this.tuckHold <= 0) { this.tuck = tuckWant; this.tuckHold = 0.7; }
      const pushing = !fin && this.v < P.pushMax; // skate / double-pole out of the start and across flats
      this.pushing = pushing;
      const dragMul = (P.dragMul / (this.rb * this.rb)) * (1 - 0.1 * this.draft);
      const a = (fin ? -P.mu * G : longAccel(P, this.v, cosA, fr.fr, this.tuck, vcap, pushing, dragMul)) - extra;
      this.braking = !fin && this.v > vcap + 0.2;
      const dh = vF * cosA * h;
      this.sRate = dh / h / pfac;
      this.s += dh / pfac;
      this.lat += this.latVel * h;
      if (Math.abs(this.lat) > wE) { this.lat = clamp(this.lat, -wE, wE); this.latVel *= 0.3; }
      tr.frame(this.s, fr);
      const x = fr.x + fr.nx * this.lat, z = fr.z + fr.nz * this.lat;
      const gN = tr.ground(x, z, this.y + 0.5, fr.y);
      const yb = this.y + this.vy * h - 0.5 * G * h * h;
      let launch = false;
      if (gN < yb - 0.5 * SHARP * h * h && this.v > 6) {
        // the snow falls away from the ballistic path: real edge (lip, cliff, big crest) or absorbable?
        // (look-ahead measured from where this step started, like the ballistic prediction)
        const look = vF * cosA * LOOK_T;
        const frL = tr.frame(this.s + (look - dh) / pfac, this._fr2);
        const latL = clamp(this.lat + this.latVel * (LOOK_T - h), -wE, wE);
        const gF = tr.ground(frL.x + frL.nx * latL, frL.z + frL.nz * latL, this.y + 0.5, frL.y);
        launch = gF < this.y + this.vy * LOOK_T - 0.5 * G * LOOK_T * LOOK_T - ABSORB_H;
        tr.frame(this.s, fr);
      }
      if (launch) {
        // take off
        this.air = true; this.airT = 0; this.vh = vF * cosA; this.vy -= G * h; this.y = yb;
        this.crouchImp = Math.max(this.crouchImp, -0.15); // extend (pop) at the lip
      } else {
        const dy = gN - this.y;
        this.tanA = dy / Math.max(1e-4, dh);
        const v2 = this.v * this.v - 2 * G * dy;
        this.v = v2 > 0 ? Math.sqrt(v2) : 0;
        this.v += a * h;
        this.v = fin ? Math.max(0, this.v) : Math.max(V_MIN, this.v);
        this.vy = dy / h;
        this.y = gN;
      }
    } else {
      // ---- in the air: ballistic with drag, lateral drift kept
      this.airT += h;
      const spd = Math.hypot(this.vh, this.vy);
      const drag = AIR * P.cdaUp * P.dragMul * spd;
      this.vh -= drag * this.vh * h;
      this.vy -= (G + drag * this.vy) * h;
      this.y += this.vy * h;
      const ds = (this.vh * h) / pfac;
      this.s += ds;
      this.sRate = ds / h;
      this.lat = clamp(this.lat + this.latVel * h, -wE, wE);
      tr.frame(this.s, fr);
      const x = fr.x + fr.nx * this.lat, z = fr.z + fr.nz * this.lat;
      const gN = tr.ground(x, z, this.y, fr.y);
      if (this.y <= gN) {
        // landing: keep the speed along the slope (measured along the flight path), absorb the rest
        const dl = this.latVel * (0.4 / Math.max(2, this.vh));
        const fa = tr.frame(this.s - 0.4 / pfac, this._fr2);
        const xa = fa.x + fa.nx * (this.lat - dl), za = fa.z + fa.nz * (this.lat - dl);
        const ga = tr.ground(xa, za, gN + 0.5, fa.y);
        const fb = tr.frame(this.s + 0.4 / pfac, this._fr2);
        const xb = fb.x + fb.nx * (this.lat + dl), zb = fb.z + fb.nz * (this.lat + dl);
        const gb = tr.ground(xb, zb, gN + 0.5, fb.y);
        const tanB = (gb - ga) / Math.max(0.2, Math.hypot(xb - xa, zb - za));
        tr.frame(this.s, fr);
        const cb = 1 / Math.sqrt(1 + tanB * tanB), sb = tanB * cb;
        const along = this.vh * cb + this.vy * sb, perp = -this.vh * sb + this.vy * cb;
        const impact = Math.max(0, -perp);
        this.v = Math.max(V_MIN, Math.hypot(Math.max(0, along), this.latVel)) * (1 - landingLoss(impact));
        this.y = gN; this.vy = this.v * sb; this.tanA = tanB; this.air = false;
        this.onLand(impact);
      }
    }
    // ---- finish line
    if (!fin && this.s >= tr.finishS) {
      const over = this.s - tr.finishS;
      this.finishTime = this.t - (this.sRate > 0.5 ? over / this.sRate : 0);
      this.finished = true;
      this.mistake = null;
    }
    if (fin && this.v < 0.05) { this.v = 0; this.stopped = true; }
  }

  onLand(impact) {
    this.landImpact = impact;
    this.crouchImp = Math.max(this.crouchImp, clamp(impact / 9, 0.12, 0.6));
    // sketchy landings for the less consistent racers
    const sev = this.spec.severity;
    if (impact > 4 && this.rnd() < clamp(0.08 + (impact - 4) * 0.04, 0, 0.5) * sev) {
      this.v *= 1 - 0.05 * sev;
      this.wobble = 0.8;
    }
  }

  /**
   * Lateral lane to stop in after the finish. Finishers spread out to the sides of the finish area,
   * clear of the middle (where later finishers ski out) and of every lane in `avoid` (the player's
   * ski-out lane, lanes of racers already parked), preferring a lane close to where they cross.
   * @param {number} rank   finishing order (1 = first home); alternates the preferred side
   * @param {number[]} [avoid]  lateral offsets (left +) to keep at least ~2.6 m away from
   * @param {number} [cross]  a lane not to cut across on the way (the player stopping in the finish area)
   */
  setParking(rank, avoid = [], cross = null) {
    const tr = this.track;
    const w = Math.max(0, Math.min(tr.halfWidth(tr.finishS + 30), tr.halfWidth(tr.finishS + 50)) - 1.5);
    const side = rank % 2 ? 1 : -1;
    let best = 0, bestScore = -Infinity;
    for (let k = 0; k < 6; k++) {
      const l = 3.6 + k * 2.4;
      if (l > w && k > 0) break;
      for (const sd of [side, -side]) {
        const lane = clamp(sd * l, -w, w);
        let dmin = 9;
        for (const a of avoid) if (Number.isFinite(a)) dmin = Math.min(dmin, Math.abs(lane - a));
        let score = 10 * Math.min(dmin, 2.6) + (Math.abs(lane) >= 5.5 ? 4 : 0) - 0.35 * Math.abs(lane - this.lat) + (sd === side ? 0.2 : 0);
        if (Number.isFinite(cross) && (this.lat - cross) * (lane - cross) < 0) score -= 12; // would cut across
        if (score > bestScore) { bestScore = score; best = lane; }
      }
    }
    this.parkLat = best;
  }

  // ---- animation: SkierRig + snow FX
  /**
   * @param {number} dt
   * @param {number} viewDist  distance to the camera/player (animation and FX level of detail)
   * @param {object} fx        { trails, spray, skierFX } or null
   * @param {boolean} countdown racers wait in the start gate (crouch at "1")
   * @param {{ show: boolean, step: number }} [lod]  the session's level of detail for this frame (big
   *        fields): draw the rig or not (off screen / shown as a far stand-in), seconds between pose
   *        solves. Without it the rig's own distance LOD applies.
   */
  animate(dt, viewDist, fx, countdown = 0, lod = null) {
    const rig = this.rig;
    // travel direction & lateral acceleration (lean)
    const fr = this._fr;
    const travel = fr.h + Math.atan2(this.latVel, Math.max(0.5, this.sRate * Math.max(0.3, 1 - fr.k * this.lat)));
    if (this.prevTravel === null || dt <= 0) this.prevTravel = travel;
    const rate = dt > 0 ? wrap(travel - this.prevTravel) / dt : 0;
    this.prevTravel = travel;
    const visAir = this.air && this.airT > 0.1;
    const aLatT = this.started && !visAir ? clamp(rate * this.v, -40, 40) : 0;
    this.aLat += (aLatT - this.aLat) * Math.min(1, dt * 9);
    // skid / hockey-stop yaw: skis and legs turned across the travel direction (the rig's `skid`)
    const m = this.mistake;
    let skidT = 0;
    if (m?.type === 'skid') skidT = 0.45 * m.side * Math.sin(Math.min(1, m.t / m.dur) * Math.PI);
    if (this.finished && this.v < 16) skidT = (this.parkLat >= 0 ? 1 : -1) * clamp((16 - this.v) / 9, 0, 1) * 1.05;
    if (this.braking) skidT += clamp(this.aLat / 30, -0.25, 0.25);
    this.skidYaw += (skidT - this.skidYaw) * Math.min(1, dt * 7);
    // inclination like the player: -atan(aLat / g) * 0.9, leaning back against a hockey stop
    this.wobble = Math.max(0, this.wobble - dt);
    const wob = (this.wob = this.wobble > 0 ? Math.sin(this.t * 19) * 0.25 * this.wobble : 0);
    let edgeT = visAir ? 0 : clamp(-Math.atan2(this.aLat, G) * 0.9 + wob, -0.95, 0.95);
    const hockey = clamp(Math.abs(this.skidYaw) / 1.05, 0, 1);
    if (hockey > 0.05) edgeT += (-Math.sign(this.skidYaw) * 0.45 - edgeT) * hockey;
    this.edge += (edgeT - this.edge) * Math.min(1, dt * 8);
    this.lean = clamp(this.edge / 0.8, -1, 1);
    this.heading = travel;
    this.travel = travel;
    this.skid = clamp(Math.abs(this.skidYaw) * 1.2 + (this.braking ? 0.35 : 0), 0, 1);
    this.crouchImp += (0 - this.crouchImp) * Math.min(1, dt * 3);
    // a landing since the last frame: the legs soak it up at the next pose solve
    if (this.wasAirF && !this.air) this.landPending = Math.max(this.landPending || 0, this.landImpact || 3);
    this.wasAirF = this.air;
    if (!rig) return;

    // far away racers are not drawn at all (skinned meshes are never frustum culled); the session also
    // hides racers off screen and swaps far ones for an instanced stand-in (lod.show)
    const vis = lod ? lod.show : viewDist < (this.visible ? LOD_HIDE + 30 : LOD_HIDE - 30);
    if (vis !== this.visible) {
      this.visible = vis;
      rig.root.visible = vis;
      if (rig.gear) rig.gear.visible = vis;
    }
    if (!vis) { this.animAcc = LOD_FAR; return; } // solve a fresh pose the moment it shows again
    // shadows only where the sun's shadow map reaches (~110 m around the player)
    const sh = viewDist < (this.shadow ? LOD_SHADOW + 20 : LOD_SHADOW - 20);
    if (sh !== this.shadow) {
      this.shadow = sh;
      for (const o of this.shadowMeshes) o.castShadow = sh;
    }

    // level of detail: the pose is solved at full rate nearby, 20 Hz mid-range, 8 Hz far away; in
    // between, the posed skier (body, skis and poles) is carried along rigidly every frame
    this.animAcc += dt;
    const step = lod ? lod.step : viewDist < LOD_NEAR ? 0 : viewDist < LOD_MID ? 1 / 20 : LOD_FAR;
    if (this.animAcc < step) { this.carryRig(); return; }
    const adt = this.animAcc;
    this.animAcc = 0;

    // the player's skiing animation from this racer's own motion (player/aistate.js): edges from the lateral
    // acceleration, crouch, the tuck, speed checks and the finish's hockey stop, airs and landings, pole plants at
    // the turn transitions, double-pole pushes out of the start; in the racer's own seeded style
    const tr = this.track;
    const A = this.animator || (this.animator = new AISkierAnim(rig, makeStyle(this.spec?.seed ?? 1, 'racer')));
    this.anim = A.st; // (the replay records its crouch / tuck)
    // compression before a kicker
    let pre = 0;
    for (const j of tr.jumps) {
      const tt = (j.s - this.s) / Math.max(4, this.v);
      if (tt > 0 && tt < 0.5) pre = Math.max(pre, 0.28 * (1 - tt / 0.5));
    }
    if (visAir) this.normal.set(0, 1, 0);
    else if (viewDist < 160 || (this.normalT -= adt) <= 0) {
      world.groundNormal(this.pos.x, this.pos.z, this.y + 0.5, this.normal);
      this.normalT = 0.4;
    }
    const mo = this.motion || (this.motion = {});
    mo.heading = this.heading; mo.speed = this.v; mo.normal = this.normal; mo.air = visAir;
    mo.aLat = this.started ? this.aLat : 0; mo.edgeAdd = this.wob || 0; mo.skidYaw = this.skidYaw; mo.plow = 0;
    mo.brake = this.braking || (this.finished && this.v > 1) ? 1 : 0;
    mo.tuck = this.tuck && this.started;
    mo.push = this.pushing && this.started && !this.finished;
    mo.pre = pre;
    mo.land = this.landPending || 0; this.landPending = 0;
    mo.waiting = !this.running || !this.started ? (countdown ? 2 : 1) : 0;
    mo.stopped = this.finished && this.stopped;
    mo.camDist = viewDist;
    rig.root.position.copy(this.pos);
    if (rig.gear) { rig.gear.position.set(0, 0, 0); rig.gear.rotation.set(0, 0, 0); } // gear is posed in world space
    rig.update(adt, A.update(adt, mo));
    this.animPos.copy(this.pos);
    this.animHeading = this.heading;

    // ski tracks + spray (throttled to ~30 Hz so the shared trail buffer isn't flooded)
    if (fx && viewDist < 140) {
      this.fxAcc += adt;
      if (this.fxAcc >= 1 / 30) {
        const info = this.fxInfo;
        info.grounded = !visAir && this.started;
        info.speed = this.v;
        info.sideslip = Math.max(0.04 + Math.abs(this.lean) * 0.08 + this.skid * 0.55, A.sideslip);
        info.plow = 0;
        info.lean = this.lean;
        fx.skierFX(fx.trails, fx.spray, this.fxId, rig, info, this.fxAcc);
        this.fxAcc = 0;
      }
    } else if (rig.fx) rig.fx.length = 0; // (no stale pole puffs bursting when it comes back into range)
  }

  // Between pose updates: move the last solved pose rigidly with the racer (carryPose).
  carryRig() { carryPose(this.rig, this.pos, this.heading, this.animPos, this.animHeading); }

  /** Projected finish time for the results if the bot is still racing (headless fast-forward). */
  projectFinish() {
    if (this.finished) return this.finishTime;
    // the clean run's time from here to the line (a table lookup: fast-forwarding all 14 bots through the
    // physics on the results screen cost ~0.1 s)
    const tab = this.spec?.cleanTab, T = this.spec?.cleanTime;
    if (tab && tab.length >= 4 && Number.isFinite(T)) {
      if (!this.started) return T;
      let lo = 0, hi = tab.length / 2 - 1;
      if (this.s <= tab[0]) return this.t + (T - tab[1]);
      if (this.s >= tab[hi * 2]) return this.t + Math.max(0, T - tab[hi * 2 + 1]);
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab[m * 2] <= this.s) lo = m; else hi = m; }
      const s0 = tab[lo * 2], s1 = tab[hi * 2], k = s1 > s0 ? (this.s - s0) / (s1 - s0) : 0;
      return this.t + Math.max(0, T - (tab[lo * 2 + 1] + (tab[hi * 2 + 1] - tab[lo * 2 + 1]) * k));
    }
    if (!this.started) return simulateRun(this.track, this.P);
    return simulateRun(this.track, this.P, { s: this.s, v: Math.max(this.v, V_MIN), t: this.t });
  }
}

/**
 * Between pose solves: move a skier rig's last solved pose rigidly to where the skier is now. The body
 * follows its root; skis and poles live in world space under rig.gear, so the gear group is rotated
 * about the skier by the heading change and shifted by the distance travelled since the pose was solved.
 * @param {object} rig  SkierRig
 * @param {{x,y,z}} p   position now          @param {number} heading  heading now
 * @param {{x,y,z}} a   position at the solve @param {number} aHeading heading at the solve
 */
export function carryPose(rig, p, heading, a, aHeading) {
  rig.root.position.set(p.x, p.y, p.z);
  rig.root.rotation.set(0, heading, 0);
  if (!rig.gear) return;
  const d = wrap(heading - aHeading), c = Math.cos(d), s = Math.sin(d);
  rig.gear.rotation.set(0, d, 0);
  rig.gear.position.set(p.x - (c * a.x + s * a.z), p.y - a.y, p.z - (-s * a.x + c * a.z));
}

// Is lateral lane `lat` free of racers (other than `except`) around the overtaking zone?
function laneFree(racers, self, except, lat, ahead) {
  for (const o of racers) {
    if (o.self === self || o === except) continue;
    const ds = o.s - self.s;
    if (ds > -2.5 && ds < ahead + 6 && Math.abs(o.lat - lat) < 1.35) return false;
  }
  return true;
}
