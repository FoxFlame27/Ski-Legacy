// Track centerline for the World Racing courses. A course is designed as a sequence of sections
// (length, turn, grade, half-width, banking, side terrain, barriers, friction); they are integrated
// into samples every 2 m with smoothed curvature / grade / width so the line flows without kinks.
// A coarse spatial grid gives fast projection of any world point onto the centerline (used by the
// region heightfield millions of times, and by gameplay for progress, barriers and respawns).
//
// Barrier layout (World Cup style), per side and sample:
//   BAR[side]   inner row right at the piste edge: red B-nets (default; also in front of the boulders of
//               'rock', the ice walls of 'ice' and the plowed banks of 'snowbank'), finish boards
//               ('arena'), bridge railing, tunnel walls
//   AN[side]    1 where a tall A-net stands further out (outside of fast turns, above drops)
//   AOFF[side]  distance of that A-net past the track edge (m)
//   CLR[side]   vegetation clearance past the edge (no trees / boulders inside the barrier zone)
import { smoothstep, clamp, lerp } from '../../core/noise.js';

export const DS = 2; // sample spacing (m)
const G = 9.81;

// Barrier codes (per side, per sample)
export const BARRIER = { none: 0, bnet: 1, fence: 2, rock: 3, ice: 4, snowbank: 5, railing: 6, tunnel: 7, arena: 8, anet: 9 };
// lateral offset of each inner barrier type past the track edge (m)
export const INNER_OFFSET = { [BARRIER.bnet]: 0.6, [BARRIER.fence]: 0.6, [BARRIER.rock]: 0.6, [BARRIER.ice]: 0.6, [BARRIER.snowbank]: 0.6, [BARRIER.arena]: 0.6, [BARRIER.railing]: 0.65 };
// inner barrier types whose front row is a B-net (one continuous net run across them)
export const NET_FRONT = new Set([BARRIER.bnet, BARRIER.rock, BARRIER.ice, BARRIER.snowbank]);

// Side terrain parameters (beyond the track edge, u = distance past the edge in meters):
//   berm*      snow berm along the edge (height, center, half-width); wide enough for the 2 m terrain mesh
//   step*      a wall (+) or a cliff drop (-) between u = stepU0 and stepU1
//   tilt       cross slope continuing past the step (+ rises away from the track)
//   riseK      amount of the default valley-wall rise
//   blend0/1   window where the precise near-track profile hands over to the far scenery
//   forest     tree density on this side (0..1), rough = rock roughness of the side terrain
//   anetU      where an A-net can stand (u, m); 0 = no room (rock walls, canyon walls)
export const SIDE_KEYS = ['bermH', 'bermU', 'bermW', 'stepH', 'stepU0', 'stepU1', 'tilt', 'riseK', 'blend0', 'blend1', 'forest', 'rough', 'anetU'];
const BASE_SIDE = { bermH: 0.5, bermU: 2.6, bermW: 2.6, stepH: 0, stepU0: 2, stepU1: 10, tilt: 0, riseK: 1, blend0: 14, blend1: 50, forest: 0.3, rough: 0.3, anetU: 7.5 };
export const SIDE_PRESETS = {
  valley: {},
  open: { riseK: 0.7, forest: 0.08, rough: 0.22, anetU: 8 },
  forest: { riseK: 0.8, forest: 1, bermH: 0.6, anetU: 6.5 },
  gentle: { riseK: 0.35, blend0: 18, blend1: 60, rough: 0.15 },
  flat: { bermH: 0.3, riseK: 0.12, blend0: 26, blend1: 80, forest: 0.15, rough: 0.06, anetU: 6 },
  snowbank: { bermH: 1.2, bermU: 2.9, bermW: 2.7, riseK: 0.6, anetU: 6.5 },
  wall: { stepH: 30, stepU0: 4.0, stepU1: 12, tilt: 0.42, riseK: 0.15, blend0: 70, blend1: 150, forest: 0, rough: 1, bermH: 0.25, anetU: 0 },
  drop: { stepH: -40, stepU0: 4.4, stepU1: 15, tilt: -0.42, riseK: 0, blend0: 70, blend1: 150, forest: 0, rough: 1, bermH: 0.3, bermU: 1.6, bermW: 1.8, anetU: 3.0 },
  canyon: { stepH: 26, stepU0: 3.6, stepU1: 10.5, tilt: 0.12, riseK: 0.35, blend0: 26, blend1: 75, forest: 0, rough: 1, bermH: 0.2, anetU: 0 },
  ridge: { stepH: 6, stepU0: 5, stepU1: 22, tilt: 0.25, riseK: 0.6, blend0: 30, blend1: 90, forest: 0, rough: 0.8, anetU: 3.4 },
  arena: { bermH: 0.25, riseK: 0.25, blend0: 30, blend1: 95, forest: 0.1, rough: 0.04, anetU: 5.5 },
};

// Variable-window moving average (window per sample, in samples) using prefix sums: O(n).
function smoothVar(src, halfWin) {
  const n = src.length, pre = new Float64Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  for (let i = 0; i < n; i++) {
    const h = Math.max(0, Math.round(halfWin[i]));
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}
function smoothFixed(src, half) {
  const hw = new Float32Array(src.length).fill(half);
  return smoothVar(src, hw);
}

function resolveSide(spec) {
  if (!spec) return { ...BASE_SIDE };
  const o = typeof spec === 'string' ? { kind: spec } : spec;
  return { ...BASE_SIDE, ...(SIDE_PRESETS[o.kind || 'valley'] || {}), ...o };
}
const pair = (v, def) => (v === undefined ? [def, def] : Array.isArray(v) ? v : [v, v]);

// Runs of 1s in a 0/1 array: fill gaps shorter than `gap` samples (where allowed), drop runs shorter
// than `min` samples, and grow every run by `grow` samples (where allowed). In place.
function cleanRuns(a, ok, gap, min, grow) {
  const n = a.length;
  // fill short gaps
  for (let i = 0; i < n;) {
    if (a[i]) { i++; continue; }
    let j = i;
    while (j < n && !a[j]) j++;
    if (i > 0 && j < n && j - i < gap) {
      let fine = true;
      for (let k = i; k < j; k++) if (!ok[k]) { fine = false; break; }
      if (fine) for (let k = i; k < j; k++) a[k] = 1;
    }
    i = j;
  }
  // grow
  if (grow > 0) {
    const src = Uint8Array.from(a);
    for (let i = 0; i < n; i++) {
      if (!src[i]) continue;
      if (i > 0 && !src[i - 1]) for (let k = i - 1; k >= Math.max(0, i - grow); k--) { if (!ok[k]) break; a[k] = 1; }
      if (i < n - 1 && !src[i + 1]) for (let k = i + 1; k <= Math.min(n - 1, i + grow); k++) { if (!ok[k]) break; a[k] = 1; }
    }
  }
  // drop short runs
  for (let i = 0; i < n;) {
    if (!a[i]) { i++; continue; }
    let j = i;
    while (j < n && a[j]) j++;
    if (j - i < min) for (let k = i; k < j; k++) a[k] = 0;
    i = j;
  }
}

export class Track {
  /**
   * @param {object} def { x0, z0, heading0, y0, vd (default design speed), sections: [...] }
   *   section: { len, turn (deg, + right), grade, smooth, w, bank (deg), side, barrier, anet, forest, fric, tag, vd }
   *   anet: 'auto' (default: outside of fast turns, above drops, finish arena), true / false, or [left, right]
   */
  constructor(def) {
    this.def = def;
    const secs = def.sections;
    let total = 0;
    this.sections = secs.map((sec) => { const o = { ...sec, s0: total }; total += sec.len; o.s1 = total; return o; });
    const n = Math.floor(total / DS) + 1;
    this.n = n;
    this.length = (n - 1) * DS;
    const raw = { k: new Float32Array(n), g: new Float32Array(n), w: new Float32Array(n), bank: new Float32Array(n), fric: new Float32Array(n), vd: new Float32Array(n), gWin: new Float32Array(n) };
    this.SEC = new Uint16Array(n);
    const sideRaw = [{}, {}];
    for (const k of SIDE_KEYS) { sideRaw[0][k] = new Float32Array(n); sideRaw[1][k] = new Float32Array(n); }
    this.BAR = [new Uint8Array(n), new Uint8Array(n)];
    const anWant = [new Int8Array(n), new Int8Array(n)]; // 1 forced on, -1 forced off, 0 auto
    let si = 0;
    for (let i = 0; i < n; i++) {
      const s = i * DS;
      while (si < this.sections.length - 1 && s >= this.sections[si].s1) si++;
      const sec = this.sections[si];
      this.SEC[i] = si;
      raw.k[i] = -((sec.turn || 0) * Math.PI / 180) / sec.len; // + right turn = heading decreases
      raw.g[i] = sec.grade ?? 0.2;
      raw.gWin[i] = (sec.smooth ?? 40) / 2 / DS;
      raw.w[i] = sec.w ?? 8;
      raw.bank[i] = THREE_DEG * (sec.bank || 0);
      raw.fric[i] = sec.fric ?? 1;
      raw.vd[i] = sec.vd ?? def.vd ?? 22;
      if (!sec._side) {
        const sp = sec.side && !Array.isArray(sec.side) ? [sec.side, sec.side] : (sec.side || ['valley', 'valley']);
        sec._side = [resolveSide(sp[0]), resolveSide(sp[1])];
        const f = pair(sec.forest, undefined);
        for (let k = 0; k < 2; k++) if (f[k] !== undefined) sec._side[k].forest = f[k];
        const b = pair(sec.barrier, 'bnet');
        sec._bar = b.map((x) => BARRIER[x] ?? 0);
        // snowbank barriers are big plowed berms
        for (let k = 0; k < 2; k++) if (sec._bar[k] === BARRIER.snowbank && sec._side[k].bermH < 1.1) Object.assign(sec._side[k], { bermH: 1.2, bermU: 2.9, bermW: 2.7 });
        // structures and ice walls leave no room for an A-net
        for (let k = 0; k < 2; k++) if ([BARRIER.tunnel, BARRIER.railing, BARRIER.ice, BARRIER.none].includes(sec._bar[k])) sec._side[k].anetU = 0;
        const a = pair(sec.anet, 'auto');
        sec._an = a.map((x) => (x === true ? 1 : x === false ? -1 : 0));
      }
      for (let k = 0; k < 2; k++) {
        for (const key of SIDE_KEYS) sideRaw[k][key][i] = sec._side[k][key];
        this.BAR[k][i] = sec._bar[k];
        anWant[k][i] = sec._an[k];
      }
    }
    // smoothing: curvature ~ clothoid transitions, grade per-section window, width / sides gently
    this.K = smoothFixed(smoothFixed(raw.k, 8), 6);
    this.G = smoothVar(smoothVar(raw.g, raw.gWin), raw.gWin.map((v) => v * 0.5));
    this.W = smoothFixed(smoothFixed(raw.w, 10), 6);
    this.FR = smoothFixed(raw.fric, 3);
    this.VD = raw.vd;
    // banking from the smoothed curvature for the section's design speed, limited per section
    const bank = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = this.K[i];
      const ideal = Math.atan((raw.vd[i] * raw.vd[i] * Math.abs(k)) / G);
      bank[i] = Math.sign(-k) * Math.min(raw.bank[i], ideal); // right turn (k<0) leans right (+)
    }
    this.B = smoothFixed(smoothFixed(bank, 10), 8);
    this.side = [{}, {}];
    for (let k = 0; k < 2; k++) for (const key of SIDE_KEYS) this.side[k][key] = smoothFixed(smoothFixed(sideRaw[k][key], 10), 6);

    // integrate the centerline
    this.X = new Float32Array(n); this.Z = new Float32Array(n); this.Y = new Float32Array(n); this.H = new Float32Array(n);
    this.TX = new Float32Array(n); this.TZ = new Float32Array(n);
    let x = def.x0, z = def.z0, y = def.y0, h = def.heading0;
    for (let i = 0; i < n; i++) {
      this.X[i] = x; this.Z[i] = z; this.Y[i] = y; this.H[i] = h;
      if (i < n - 1) {
        const hm = h + this.K[i] * DS * 0.5;
        x += Math.sin(hm) * DS; z += Math.cos(hm) * DS;
        y -= (this.G[i] + this.G[i + 1]) * 0.5 * DS;
        h += this.K[i] * DS;
      }
    }
    for (let i = 0; i < n; i++) { this.TX[i] = Math.sin(this.H[i]); this.TZ[i] = Math.cos(this.H[i]); }
    this.drop = this.Y[0] - this.Y[n - 1];

    // inside of tight turns: the near-track profile must hand over before the projection gets ambiguous
    for (let i = 0; i < n; i++) {
      const R = 1 / Math.max(1e-5, Math.abs(this.K[i]));
      const inside = this.K[i] < 0 ? 1 : 0; // right turn -> center of curvature on the right
      const lim = Math.max(8, 0.5 * R - this.W[i]);
      const sd = this.side[inside];
      if (sd.blend1[i] > lim) { sd.blend1[i] = lim; sd.blend0[i] = Math.min(sd.blend0[i], lim * 0.55); }
    }

    this.layoutBarriers(anWant, sideRaw);

    // bounding box + projection grid
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < n; i++) {
      mnx = Math.min(mnx, this.X[i]); mxx = Math.max(mxx, this.X[i]);
      mnz = Math.min(mnz, this.Z[i]); mxz = Math.max(mxz, this.Z[i]);
    }
    this.bbox = { minx: mnx, maxx: mxx, minz: mnz, maxz: mxz };
    this.grid = null; // built lazily on the first projection (menus only need length / drop)
    this._p = { s: 0, v: 0, i: 0, t: 0, d: 0, far: true };
  }

  // A-nets (outer row): above drops and on the outside of fast turns (lateral demand at the design
  // speed), in continuous runs; vegetation clearance for the whole barrier zone. A-nets only stand
  // where the section itself has room (raw, unsmoothed side value) and keep 10 m away from sections
  // without room (tunnel portals, bridge abutments, canyon walls) so they never hang over a gorge or
  // run into rock.
  layoutBarriers(want, sideRaw) {
    const n = this.n, M = 5;
    this.AN = [new Uint8Array(n), new Uint8Array(n)];
    this.AOFF = [new Float32Array(n), new Float32Array(n)];
    this.CLR = [new Float32Array(n), new Float32Array(n)];
    for (let side = 0; side < 2; side++) {
      const S = this.side[side], a = this.AN[side], ok = new Uint8Array(n);
      const raw = sideRaw[side].anetU;
      for (let i = 0; i < n; i++) {
        let room = 1;
        for (let k = Math.max(0, i - M); k <= Math.min(n - 1, i + M); k++) if (!(raw[k] > 1.2)) { room = 0; break; }
        ok[i] = room;
        if (!ok[i] || want[side][i] < 0) continue;
        if (want[side][i] > 0) { a[i] = 1; continue; }
        const drop = S.stepH[i] < -8;
        // outside of the turn: right turn (K < 0) -> outside is the left side (0)
        const outside = (this.K[i] < 0 ? 0 : 1) === side;
        const demand = this.VD[i] * this.VD[i] * Math.abs(this.K[i]);
        if (drop || (outside && demand > 2.4)) a[i] = 1;
      }
      // whole runs: fill gaps < 70 m, grow 24 m into the approach / exit, drop stubs < 60 m
      for (let i = 0; i < n; i++) if (want[side][i] < 0) ok[i] = 0;
      cleanRuns(a, ok, 35, 30, 12);
      for (let i = 0; i < n; i++) if (!ok[i]) a[i] = 0;
      cleanRuns(a, ok, 0, 30, 0);
      // offsets: the least room of the sections within +-24 m (so a run never strays onto the drop or
      // the wall of a neighbouring section), lightly smoothed so a run keeps a steady line
      const room = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let m = Infinity;
        for (let k = Math.max(0, i - 12); k <= Math.min(n - 1, i + 12); k++) if (raw[k] > 1.2 && raw[k] < m) m = raw[k];
        room[i] = m === Infinity ? 2.4 : m;
      }
      const off = smoothFixed(room, 4);
      for (let i = 0; i < n; i++) {
        this.AOFF[side][i] = Math.max(2.4, off[i]);
        const inner = INNER_OFFSET[this.BAR[side][i]] ?? 0.6;
        this.CLR[side][i] = Math.max(4.5, inner + 3.5, a[i] ? this.AOFF[side][i] + 4 : 0);
      }
      // clearance changes gently (no tree walls appearing at run ends)
      const c = smoothFixed(this.CLR[side], 10);
      for (let i = 0; i < n; i++) this.CLR[side][i] = Math.max(this.CLR[side][i], c[i]);
    }
  }

  // Grid of the nearest sample index for every cell within `band` meters of the line.
  buildGrid(band, cell) {
    const b = this.bbox;
    this.gc = cell; this.band = band;
    this.gx0 = b.minx - band; this.gz0 = b.minz - band;
    this.gw = Math.ceil((b.maxx - b.minx + 2 * band) / cell) + 1;
    this.gh = Math.ceil((b.maxz - b.minz + 2 * band) / cell) + 1;
    const N = this.gw * this.gh;
    const best = new Float32Array(N).fill(band * band);
    const idx = new Int32Array(N).fill(-1);
    const r = Math.ceil(band / cell);
    for (let i = 0; i < this.n; i++) {
      const cx = Math.round((this.X[i] - this.gx0) / cell), cz = Math.round((this.Z[i] - this.gz0) / cell);
      for (let j = Math.max(0, cz - r); j <= Math.min(this.gh - 1, cz + r); j++) {
        const pz = this.gz0 + j * cell - this.Z[i];
        for (let k = Math.max(0, cx - r); k <= Math.min(this.gw - 1, cx + r); k++) {
          const px = this.gx0 + k * cell - this.X[i];
          const d2 = px * px + pz * pz;
          const c = j * this.gw + k;
          if (d2 < best[c]) { best[c] = d2; idx[c] = i; }
        }
      }
    }
    this.grid = idx;
  }

  // Distance^2 from (x,z) to segment i..i+1, writes t into this._t
  segDist2(i, x, z) {
    const ax = this.X[i], az = this.Z[i];
    const ex = this.X[i + 1] - ax, ez = this.Z[i + 1] - az;
    let t = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    this._t = t;
    const dx = ax + ex * t - x, dz = az + ez * t - z;
    return dx * dx + dz * dz;
  }

  // Nearest point on the centerline. Returns a shared scratch object { s, v, i, t, d, far }.
  // v = signed lateral offset (+ right of travel). hintS (optional) searches locally around it.
  locate(x, z, hintS = -1) {
    const p = this._p;
    if (!this.grid) this.buildGrid(this.def.band ?? 330, this.def.cell ?? 8);
    let i0;
    if (hintS >= 0) {
      i0 = clamp(Math.round(hintS / DS), 0, this.n - 2);
    } else {
      const cx = Math.round((x - this.gx0) / this.gc), cz = Math.round((z - this.gz0) / this.gc);
      if (cx < 0 || cz < 0 || cx >= this.gw || cz >= this.gh) { p.far = true; return p; }
      i0 = this.grid[cz * this.gw + cx];
      if (i0 < 0) { p.far = true; return p; }
      if (i0 > this.n - 2) i0 = this.n - 2;
    }
    const span = hintS >= 0 ? 30 : 4;
    let bi = i0, bd = Infinity, bt = 0;
    for (let i = Math.max(0, i0 - span); i <= Math.min(this.n - 2, i0 + span); i++) {
      const d = this.segDist2(i, x, z);
      if (d < bd) { bd = d; bi = i; bt = this._t; }
    }
    // hill-climb past the search window if the minimum sits on its border
    for (let guard = 0; guard < 400; guard++) {
      let moved = false;
      if (bi > 0) { const d = this.segDist2(bi - 1, x, z); if (d < bd - 1e-9) { bd = d; bi--; bt = this._t; moved = true; } }
      if (!moved && bi < this.n - 2) { const d = this.segDist2(bi + 1, x, z); if (d < bd - 1e-9) { bd = d; bi++; bt = this._t; moved = true; } }
      if (!moved) break;
    }
    const ax = this.X[bi], az = this.Z[bi];
    const ex = this.X[bi + 1] - ax, ez = this.Z[bi + 1] - az;
    const el = Math.sqrt(ex * ex + ez * ez) || 1;
    // right of travel = (-tz, tx)
    p.v = ((x - ax) * (-ez) + (z - az) * ex) / el;
    p.s = (bi + bt) * DS;
    p.i = bi; p.t = bt; p.d = Math.sqrt(bd); p.far = false;
    return p;
  }

  // Linear interpolation of a per-sample array at fractional index (i, t)
  at(arr, i, t) { return arr[i] + (arr[i + 1] - arr[i]) * t; }
  sAt(arr, s) {
    const f = clamp(s / DS, 0, this.n - 1.0001), i = Math.floor(f);
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  }
  // per-sample value without interpolation (codes)
  codeAt(arr, s) { return arr[clamp(Math.round(s / DS), 0, this.n - 1)]; }

  // Centerline height between samples i and i+1 (t in 0..1): the exact integral of the linearly
  // interpolated grade, so the profile is smooth (C1) instead of kinking at every 2 m sample. Without
  // that, convex transitions would make skiers hop off each sample (the player has no snow glue on
  // the courses) and ramps built on the track would inherit the kinks.
  yAt(i, t) {
    const g0 = this.G[i];
    return this.Y[i] - DS * t * (g0 + (this.G[i + 1] - g0) * t * 0.5);
  }

  // Height of the designed track surface at arc length s and lateral offset v (bank applied,
  // lateral clamped to the edges).
  surfaceY(s, v) {
    const f = clamp(s / DS, 0, this.n - 1.0001), i = Math.floor(f), t = f - i;
    const y = this.yAt(i, t), w = this.at(this.W, i, t), b = this.at(this.B, i, t);
    return y - Math.tan(b) * clamp(v, -w, w);
  }

  // World point on the track: { x, z, y, heading }
  pointAt(s, lateral = 0, out = {}) {
    const f = clamp(s / DS, 0, this.n - 1.0001), i = Math.floor(f), t = f - i;
    const x = this.at(this.X, i, t), z = this.at(this.Z, i, t);
    const h = this.H[i] + (this.H[i + 1] - this.H[i]) * t;
    const rx = -Math.cos(h), rz = Math.sin(h);
    out.x = x + rx * lateral; out.z = z + rz * lateral;
    out.y = this.surfaceY(s, lateral);
    out.heading = h;
    return out;
  }

  // Grade (drop per meter) and its 3D extremes over a window: used by the tests
  gradeAt(s) { return this.sAt(this.G, s); }
}

const THREE_DEG = Math.PI / 180;
export { smoothFixed, smoothVar, lerp, smoothstep };
