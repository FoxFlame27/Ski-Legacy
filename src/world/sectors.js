// New ski sectors east of the Adlerhorn (Oct 28, the user: "make also more places to ski so not just cliffs where
// you fall"): layout.js calls buildSectors once from initLayout, right after buildTransport (before the crag mask,
// the mid-stations, the towers, the nets and the bus stops), so the crag mask, the signposts, the piste markers,
// the trail map and the snow cannons pick everything up like any other run. Pure layout (no THREE): runs in Node.
//
//  - Hirschalm: the sunny basin behind the Adlerhorn and the north face of the Kamm ridge above it. The green
//    Hirschweg drops into it from the Adlerhorn top station, the Hirschalm Chair climbs the face (red, black and
//    blue back down), the Adlerblick Chair brings you back up to the Adlerhorn, and the green Talweg runs home
//    west to the Adlerhorn's runs and the village. The Hirschalm Hütte stands by the chair's base.
//  - Ostkar: the wide bowl at the east end of the ridge. The Ostkar Chair (blue, red, black), the blue Kammweg
//    over from the Hirschalm Chair's top and the blue Höhenweg back across to the Hirschalm.
//  - Freeride bowls (Hirschkar, Ostkar-Mulde, Kammhang): open, unmarked slopes between the runs. A terrain shaper
//    (world cut) smooths every new run and bowl there: the mid-scale relief is blurred and the grade relaxed
//    to <= ~35 degrees (no cliff steps), fine snow texture and every pad (stations, huts) left exactly as they
//    were. The bowls also go into the crag mask (layout.bowls), so no rock bands form on them.
// Everything stays inside x 1400..4150, z -700..1150: well clear of the World Racing regions (the nearest, Big Air,
// starts at x 4294), the Legacy Express, the Wolkenspitzbahn, the roads and the village.
import { world } from './world.js';
import { smoothstep } from '../core/noise.js';

// a routing face (layout.js routePiste): top -> bottom, u down the face, v across it
function face(id, top, bottom, halfW = 420, bowl = 340) {
  const dx = bottom.x - top.x, dz = bottom.z - top.z, l = Math.hypot(dx, dz);
  return { id, top: { x: top.x, z: top.z }, fx: dx / l, fz: dz / l, faceLen: l, bowl, halfW };
}
const at = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });

// open freeride bowls: centre line + half-width (m); shaped and crag-free, no grooming, no markers
export const BOWLS = [
  { name: 'Hirschkar', pts: [[3300, 860], [3330, 600], [3260, 330]], w: 150 },
  { name: 'Ostkar-Mulde', pts: [[3960, 980], [4000, 700], [3990, 380]], w: 120 },
  { name: 'Kammhang', pts: [[2700, 820], [2680, 560], [2700, 330]], w: 130 },
];

export function buildSectors(kit) {
  const { layout, addLift, addPiste, routePiste, faceUV, BAND, PISTE_WIDTH } = kit;
  const adler = layout.peaks.find((pk) => pk.id === 'adlerhorn');
  const blocked = layout.huts.map((h) => [h.x, h.z, 36]);
  const routed = [];
  const route = (m, a, b, diff, o = {}) => {
    const [gMin, gMax] = BAND[diff];
    const pts = routePiste(m, a, b, { gMin, gMax, avoid: routed.map((r) => ({ pts: r })), blocked, ...o });
    routed.push(pts);
    return pts;
  };
  const uv = (F, p, du = 0, dv = 0) => { const [u, v] = faceUV(F, p.x, p.z); return [u + du, v + dv]; };

  // ---------------------------------------------------------------- Hirschalm
  const hChair = addLift({ type: 'chair', name: 'Hirschalm Chair', bottom: { x: 2960, z: 150 }, top: { x: 3070, z: 930 }, price: 10,
    topName: 'the Kamm', bottomName: 'the Hirschalm' });
  const aChair = addLift({ type: 'chair', name: 'Adlerblick Chair', bottom: { x: 2830, z: 10 }, top: { x: 2430, z: -455 }, price: 10,
    topName: 'the Adlerhorn summit', bottomName: 'the Hirschalm' });
  // the alm restaurant on the basin, west of the chairs' bases, its terrace facing south over the basin
  const hut = { x: 2700, z: 190, name: 'Hirschalm Hütte', label: 'Hirschalm · Hirschalm Hütte', yaw: 0.35, peak: 'hirschalm' };
  world.addPad({ x: hut.x, z: hut.z, r: 18, blend: 22 });
  layout.huts.push(hut);
  blocked.push([hut.x, hut.z, 36]);
  const patrol = { x: hChair.top.x - 40, z: hChair.top.z + 26 };
  world.addPad({ x: patrol.x, z: patrol.z, r: 6, blend: 10 });

  const FA = face('hirschalm', hChair.top, hChair.bottom, 420, 360);
  const kamm = route(FA, [36, 20], uv(FA, hChair.bottom, -26, 34), 2, { side: 1 });
  const stein = route(FA, [36, -4], uv(FA, hChair.bottom, -30, -6), 3, { side: 0, steepCost: 20 });
  const alm = route(FA, [36, -30], uv(FA, hChair.bottom, -24, -40), 1, { side: -1, steepCost: 120 });
  // the Hirschweg: from the Adlerhorn top station down into the basin (a long, easy cat track)
  const aTop = adler?.lift.top ?? { x: 2290, z: -560 };
  const FH = face('hirschweg', aTop, aChair.bottom, 420, 360);
  const hweg = route(FH, [70, -30], uv(FH, aChair.bottom, -10, -40), 0, { turnCost: 30, sideHill: 0.8, steepCost: 160 });
  // the Talweg: from the basin west, home to the Adlerhorn's runs (it ends on the nearest of them)
  const adPts = (adler?.pistes ?? []).flatMap((p) => p.pts);
  let join = { x: 950, z: -250 }, jd = Infinity;
  for (const [x, z] of adPts) { const d = Math.hypot(x - 950, z + 250); if (d < jd) { jd = d; join = { x, z }; } }
  const ts = { x: hut.x - 40, z: hut.z - 30 };
  const FT = face('talweg', ts, join, 380, 300);
  const tal = route(FT, [0, 0], [FT.faceLen, 0], 0, { turnCost: 24, sideHill: 1, steepCost: 160 });

  const pistesA = [
    addPiste('Hirschweg', 0, hweg, { peak: 'hirschalm', number: 51 }),
    addPiste('Kammabfahrt', 2, kamm, { peak: 'hirschalm', number: 52 }),
    addPiste('Steinbock', 3, stein, { peak: 'hirschalm', number: 53 }),
    addPiste('Almrausch', 1, alm, { peak: 'hirschalm', number: 54 }),
    addPiste('Talweg', 0, tal, { peak: 'hirschalm', number: 55 }),
  ];
  // groomed links on the basin floor: the chairs' bases, the hut and the Talweg's start
  world.addCorridor([[hChair.bottom.x, hChair.bottom.z], [aChair.bottom.x, aChair.bottom.z], [ts.x, ts.z]], 14, 'piste');
  layout.peaks.push({ id: 'hirschalm', name: 'Hirschalm', lift: hChair, hut, pistes: pistesA, patrol });

  // ---------------------------------------------------------------- Ostkar
  const oChair = addLift({ type: 'chair', name: 'Ostkar Chair', bottom: { x: 3880, z: 150 }, top: { x: 3740, z: 1010 }, price: 10,
    topName: 'the Ostkar ridge', bottomName: 'the Ostkar' });
  const opatrol = { x: oChair.top.x + 38, z: oChair.top.z + 22 };
  world.addPad({ x: opatrol.x, z: opatrol.z, r: 6, blend: 10 });
  const FO = face('ostkar', oChair.top, oChair.bottom, 380, 320);
  const murmel = route(FO, [36, 28], uv(FO, oChair.bottom, -26, 30), 1, { side: 1, steepCost: 120 });
  const ost = route(FO, [36, 2], uv(FO, oChair.bottom, -30, 4), 2, { side: 0 });
  const kamin = route(FO, [36, -26], uv(FO, oChair.bottom, -26, -30), 3, { side: -1, steepCost: 20 });
  // links: the Kammweg from the Hirschalm Chair's top east to the Ostkar Chair, the Höhenweg from the Ostkar
  // Chair's top back west to the Hirschalm Chair
  const FK = face('kammweg', hChair.top, oChair.bottom, 420, 360);
  const kweg = route(FK, [40, -36], uv(FK, oChair.bottom, -30, -40), 1, { turnCost: 20, sideHill: 1.2, steepCost: 120 });
  const FW = face('hoehenweg', oChair.top, hChair.bottom, 420, 360);
  const hoehe = route(FW, [40, 36], uv(FW, hChair.bottom, -30, 40), 1, { turnCost: 20, sideHill: 1.2, steepCost: 120 });
  const pistesB = [
    addPiste('Murmeltier', 1, murmel, { peak: 'ostkar', number: 61 }),
    addPiste('Ostkar', 2, ost, { peak: 'ostkar', number: 62 }),
    addPiste('Kamin', 3, kamin, { peak: 'ostkar', number: 63 }),
    addPiste('Kammweg', 1, kweg, { peak: 'ostkar', number: 64 }),
    addPiste('Höhenweg', 1, hoehe, { peak: 'hirschalm', number: 56 }),
  ];
  pistesA.push(pistesB.pop());
  layout.peaks.push({ id: 'ostkar', name: 'Ostkar', lift: oChair, pistes: pistesB, patrol: opatrol });

  // ---------------------------------------------------------------- bowls + the terrain shaper
  layout.bowls = BOWLS;
  const runs = [...pistesA, ...pistesB];
  world.addCut(skiShaper([
    ...BOWLS.map((b) => ({ pts: b.pts, w: b.w, g: MAX_G })),
    ...runs.map((p) => ({ pts: p.pts.filter((_, i) => i % 2 === 0 || i === p.pts.length - 1), w: PISTE_WIDTH[p.diff] + 6, g: Math.max(BAND[p.diff][1] * (+(globalThis.process?.env?.GF || 1.1)), 0.3) })),
  ]));
  if (globalThis.process?.env?.NOBENCH) return;
  // then the runs themselves: each one graded like a built piste (see pisteBench)
  // (the gentlest first: where a steeper run crosses an easier one it takes the easier one's level, never the reverse)
  const order = ['Talweg', 'Hirschweg', 'Kammweg', 'Höhenweg', 'Almrausch', 'Murmeltier', 'Kammabfahrt', 'Ostkar', 'Steinbock', 'Kamin'];
  world.addCut(pisteBench([...pistesA, ...pistesB].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).map((p) => ({ pts: p.pts, w: PISTE_WIDTH[p.diff] + 4, gMax: BAND[p.diff][1] }))));
}

// ---------------------------------------------------------------- the piste bench
// Every new run is built like a real piste: along its centre line the snow follows an even profile (the ground
// along the line smoothed over ~200 m and never climbing), level across its groomed width, with snow banks
// back to the natural slope beside it (wider where the bench is cut deeper or filled higher). So a run holds the
// mean grade of its line all the way down (no rolls, steps or lips) and the station pads at its ends stay as
// they are (the profile is pinned to the ground at its first and last metres). Where runs meet or cross, their
// profiles don't fight: runs are built in priority order (the gentlest first), each one's profile taken from the
// ground as the runs before it left it, and the earlier run wins on its own bench (the later one meets it at its
// level, over a snow bank).
const BANK = 26, BANK_MAX = 100; // m of snow bank beyond a run's bench (at least / at most)
const BC = 64;   // m: spatial grid cell
// the run's nearest bench point to (x, z): { w: its weight there (1 on the bench, falling off over the snow bank,
// whose width grows with the height of the bench over / under the natural ground h0), y: the bench's level }
const _b = { w: 0, y: 0 };
function benchAt(run, x, z, h0) {
  _b.w = 0;
  const arr = run.G.get(Math.floor(x / BC) + ',' + Math.floor(z / BC));
  if (!arr) return _b;
  let bestD = Infinity, bestY = 0;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i], ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / l2));
    const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z);
    if (d < bestD) { bestD = d; bestY = s.ya + (s.yb - s.ya) * t; }
  }
  _b.w = 1 - smoothstep(run.w, run.w + Math.min(BANK_MAX, Math.max(BANK, Math.abs(bestY - h0) * 1.7)), bestD);
  _b.y = bestY;
  return _b;
}
function pisteBench(runs) {
  const out = [];
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const r of runs) for (const [x, z] of r.pts) {
    const R = r.w + BANK_MAX + 8;
    minx = Math.min(minx, x - R); maxx = Math.max(maxx, x + R); minz = Math.min(minz, z - R); maxz = Math.max(maxz, z + R);
  }
  // a pad's flat core stays as it is; its embankment gives way to the bench
  const benched = (x, z, h, upto) => {
    if (!upto) return h;
    let y = h;
    for (let k = upto - 1; k >= 0; k--) { const b = benchAt(out[k], x, z, h); if (b.w > 0) y += (b.y - y) * b.w; }
    return h + (y - h) * (1 - smoothstep(0.8, 1, world.padInfluence(x, z)));
  };
  let state = 0; // 0: not built, 1: building (the ground it samples is the ground without it), 2: built
  const build = () => { state = 1; for (const r of runs) addRun(r); state = 2; };
  const addRun = (r) => {
    const P = r.pts, n = P.length, S = new Float32Array(n), raw = new Float32Array(n);
    const h0 = new Float32Array(n);
    for (let i = 0; i < n; i++) { h0[i] = world.height(P[i][0], P[i][1]); raw[i] = benched(P[i][0], P[i][1], h0[i], out.length); if (i) S[i] = S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); }
    // lock: how far a point lies on an earlier run's bench (there this run keeps that run's level) or at the run's
    // ends (pads, junctions); the profile is the ground smoothed (~200 m) between the locked points
    const lock = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lk = 1 - Math.min(smoothstep(0, 24, S[i]), smoothstep(0, 24, S[n - 1] - S[i]));
      for (const o of out) lk = Math.max(lk, benchAt(o, P[i][0], P[i][1], h0[i]).w);
      lock[i] = lk;
    }
    let Y = Float32Array.from(raw);
    for (let it = 0; it < 80; it++) {
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0, w = 0; for (let k = -8; k <= 8; k++) { const j = Math.max(0, Math.min(n - 1, i + k)), wt = 9 - Math.abs(k); s += Y[j] * wt; w += wt; } o[i] = s / w + (raw[i] - s / w) * lock[i]; }
      Y = o;
    }
    // grade cap: the band's steepest grade (or a little over the line's mean grade, where that is steeper): going
    // down, the profile never falls faster than that (it stays filled above a steep pitch and catches up below)
    // and never climbs; where it ends above the ground, the difference is spread evenly over the whole run
    const L = S[n - 1] || 1, g = Math.max(r.gMax * 1.1, ((raw[0] - raw[n - 1]) / L) * 1.15);
    for (let k = 0; k < 3; k++) {
      for (let i = 1; i < n; i++) Y[i] = Math.min(Y[i - 1], Math.max(Y[i], Y[i - 1] - g * (S[i] - S[i - 1])));
      const e = Y[n - 1] - raw[n - 1];
      if (e > 0) for (let i = 0; i < n; i++) Y[i] -= (e * S[i]) / L;
    }
    for (let i = 0; i < n; i++) Y[i] += (raw[i] - Y[i]) * lock[i];
    const run = { Y, w: r.w, pts: P, G: new Map() };
    for (let i = 1; i < n; i++) {
      const [ax, az] = P[i - 1], [bx, bz] = P[i], seg = { ax, az, bx, bz, ya: Y[i - 1], yb: Y[i] };
      const R = r.w + BANK_MAX + 8;
      for (let cx = Math.floor((Math.min(ax, bx) - R) / BC); cx <= Math.floor((Math.max(ax, bx) + R) / BC); cx++)
        for (let cz = Math.floor((Math.min(az, bz) - R) / BC); cz <= Math.floor((Math.max(az, bz) + R) / BC); cz++) {
          const key = cx + ',' + cz; let arr = run.G.get(key); if (!arr) run.G.set(key, (arr = [])); arr.push(seg);
        }
    }
    out.push(run);
  };
  // (built on first use once the crag mask is set: the profiles follow the final ground)
  return {
    bounds: { minx, minz, maxx, maxz }, shaper: true, runs: out,
    apply(x, z, h) {
      if (state !== 2) { if (state === 1 || !world.cragMask) return h; build(); }
      return benched(x, z, h, out.length);
    },
  };
}

// ---------------------------------------------------------------- the shaper
// A world cut over the strips (centre line + half-width): inside them the terrain's mid-scale relief is replaced by
// a smoothed, grade-limited version of itself; it fades out over FEATHER m beyond a strip and under every pad.
// h' = h + w * (S - R): R the natural ground on the shaper's grid, S the same grid blurred (~40 m) and relaxed so no
// step between neighbours is steeper than MAX_G. What the grid can't hold (fine snow texture, pads, earlier cuts)
// stays as it was. The grids are built on first use once the crag mask is set (the ground they see is the final one).
const SH_CELL = 8, FEATHER = 70, MAX_G = 0.68, ITERS = +(globalThis.process?.env?.SH_IT || 120);
function skiShaper(strips) {
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const s of strips) for (const [x, z] of s.pts) {
    minx = Math.min(minx, x - s.w - FEATHER); maxx = Math.max(maxx, x + s.w + FEATHER);
    minz = Math.min(minz, z - s.w - FEATHER); maxz = Math.max(maxz, z + s.w + FEATHER);
  }
  const x0 = Math.floor(minx / SH_CELL) * SH_CELL - SH_CELL * 8, z0 = Math.floor(minz / SH_CELL) * SH_CELL - SH_CELL * 8;
  const nx = Math.ceil((maxx - x0) / SH_CELL) + 9, nz = Math.ceil((maxz - z0) / SH_CELL) + 9;
  let R = null, D = null, M = null, building = false;
  const build = () => {
    R = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) R[j * nx + i] = world.baseHeight(x0 + i * SH_CELL, z0 + j * SH_CELL);
    // blur: 3 separable box passes of radius 2 cells (~ a 40 m gaussian)
    let S = Float32Array.from(R);
    const T = new Float32Array(nx * nz), r = 2;
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const ii = i + k; if (ii >= 0 && ii < nx) { s += S[j * nx + ii]; c++; } } T[j * nx + i] = s / c; }
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const jj = j + k; if (jj >= 0 && jj < nz) { s += T[jj * nx + i]; c++; } } S[j * nx + i] = s / c; }
    }
    // the strength mask (1 inside a strip, feathered out), then relax the grade inside it (talus: a step steeper
    // than MAX_G moves both cells toward each other; cells outside the mask stay put, so the edges blend)
    M = new Float32Array(nx * nz);
    const Lim = new Float32Array(nx * nz).fill(MAX_G * SH_CELL); // per cell: the gentlest strip's grade limit
    for (const s of strips) {
      for (let k = 1; k < s.pts.length; k++) {
        const [ax, az] = s.pts[k - 1], [bx, bz] = s.pts[k], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1, reach = s.w + FEATHER;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / SH_CELL)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / SH_CELL));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / SH_CELL)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + reach - z0) / SH_CELL));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = x0 + i * SH_CELL - ax, pz = z0 + j * SH_CELL - az;
          const t = Math.max(0, Math.min(1, (px * ex + pz * ez) / l2));
          const d = Math.hypot(px - ex * t, pz - ez * t) - s.w, w = 1 - smoothstep(0, FEATHER, d), q = j * nx + i;
          if (w > M[q]) M[q] = w;
          if (w >= 0.5 && s.g * SH_CELL < Lim[q]) Lim[q] = s.g * SH_CELL;
        }
      }
    }
    // (the grid's outer ring stays at weight 0: the shaper ends exactly where its bounds do)
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (i < 2 || j < 2 || i >= nx - 2 || j >= nz - 2) M[j * nx + i] = 0;
    for (let it = 0; it < ITERS; it++) {
      for (let j = 1; j < nz - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const q = j * nx + i;
        if (M[q] < 0.5) continue;
        for (const n of [q + 1, q + nx]) {
          const dh = S[q] - S[n], lim = Math.min(Lim[q], Lim[n]);
          if (Math.abs(dh) <= lim) continue;
          const e = (Math.abs(dh) - lim) * 0.25 * Math.sign(dh), wn = M[n] >= 0.5 ? 1 : 0;
          S[q] -= e * (wn ? 1 : 2); if (wn) S[n] += e;
        }
      }
    }
    D = new Float32Array(nx * nz);
    for (let q = 0; q < D.length; q++) D[q] = (S[q] - R[q]) * M[q];
  };
  const bounds = { minx: x0 + SH_CELL * 2, minz: z0 + SH_CELL * 2, maxx: x0 + (nx - 3) * SH_CELL, maxz: z0 + (nz - 3) * SH_CELL };
  return {
    bounds, shaper: true,
    apply(x, z, h) {
      if (!D) { if (building || !world.cragMask) return h; building = true; build(); building = false; }
      const fx = (x - x0) / SH_CELL, fz = (z - z0) / SH_CELL, i = Math.floor(fx), j = Math.floor(fz);
      if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return h;
      const tx = fx - i, tz = fz - j, k = j * nx + i;
      const d = (D[k] * (1 - tx) + D[k + 1] * tx) * (1 - tz) + (D[k + nx] * (1 - tx) + D[k + nx + 1] * tx) * tz;
      if (d === 0) return h;
      return h + d * (1 - world.padInfluence(x, z));
    },
  };
}
