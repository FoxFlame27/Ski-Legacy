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
//  - Freeride bowls (Hirschkar, Ostkar-Mulde, Kammhang): open, unmarked slopes between the runs.
//  - The ground: the raw range out here is pinnacles and 50-100 m walls, so each sector's whole area (AREAS) is
//    reshaped first (areaShaper: blurred, then grade-limited to ~32 degrees, with gentle shoulders round the
//    stations and huts, feathered into the untouched range), and then every run is graded like a built piste
//    (pisteBench). The areas and bowls go into the crag mask (layout.bowls), so no rock bands form on them.
//    The Murmelhütte stands on the Ostkar's floor.
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

// the reshaped areas (see areaShaper): capsules (centre line + half-width) round each sector's lifts, runs and bowls
export const AREAS = [
  { name: 'Hirschalm face', pts: [[2960, 90], [3070, 960]], w: 400 },
  { name: 'Ostkar face', pts: [[3880, 90], [3740, 1040]], w: 330 },
  { name: 'Kamm traverse', pts: [[3070, 930], [3880, 150]], w: 230 },
  { name: 'Höhen traverse', pts: [[3740, 1010], [2960, 150]], w: 230 },
  { name: 'Hirschalm basin', pts: [[2600, 150], [3880, 150]], w: 160 },
  { name: 'Adlerblick', pts: [[2850, 30], [2430, -470]], w: 200 },
  { name: 'Hirschweg', pts: [[2400, -520], [2870, -20]], w: 170 },
];
// the box the reshaping stays inside: east of the Adlerhorn's summit runs, west of Big Air (x 4294), south of
// the Panoramastrasse's mountain (scenic.js: its switchbacks climb to x ~2050, z ~1050)
const CLIP = { minx: 2380, maxx: 4200, minz: -640, maxz: 1150 };
// the stations (the chairs' ends) and huts below: the shaper eases the ground round them into level shoulders
const FLATS = [[2960, 150], [3070, 930], [2830, 10], [2430, -455], [3880, 150], [3740, 1010], [2700, 190], [3770, 200]];

export function buildSectors(kit) {
  const { layout, addLift, addPiste, routePiste, faceUV, BAND, PISTE_WIDTH } = kit;
  const adler = layout.peaks.find((pk) => pk.id === 'adlerhorn');
  // the area shaper first: everything below (stations, routes, pads) is laid out on the reshaped ground. What must
  // keep its ground pins it: the other resorts' runs, lifts and pads (the Adlerhorn's top station and hut nearby)
  const keep = [
    ...layout.pistes.map((p) => ({ pts: p.pts, w: PISTE_WIDTH[p.diff] + 40 })),
    ...layout.lifts.map((l) => ({ pts: [[l.bottom.x, l.bottom.z], [l.top.x, l.top.z]], w: 40 })),
    ...world.pads.map((pd) => ({ pts: [[pd.x, pd.z]], w: pd.r + pd.blend + 10 })),
  ];
  world.addCut(areaShaper(AREAS, keep, CLIP, FLATS));
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
  const kamm = route(FA, [50, 20], uv(FA, hChair.bottom, -26, 34), 2, { side: 1 });
  const stein = route(FA, [50, -4], uv(FA, hChair.bottom, -30, -6), 3, { side: 0, steepCost: 20 });
  const alm = route(FA, [50, -30], uv(FA, hChair.bottom, -24, -40), 1, { side: -1, steepCost: 120 });
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
  // the Murmelhütte: a small hut on the Ostkar's floor, beside the chair's base (west of it, off the runs' ends)
  const ohut = { x: 3770, z: 200, name: 'Murmelhütte', label: 'Ostkar · Murmelhütte', yaw: -0.2, peak: 'ostkar' };
  world.addPad({ x: ohut.x, z: ohut.z, r: 16, blend: 20 });
  layout.huts.push(ohut);
  blocked.push([ohut.x, ohut.z, 36]);
  const opatrol = { x: oChair.top.x + 38, z: oChair.top.z + 22 };
  world.addPad({ x: opatrol.x, z: opatrol.z, r: 6, blend: 10 });
  const FO = face('ostkar', oChair.top, oChair.bottom, 380, 320);
  const murmel = route(FO, [50, 28], uv(FO, oChair.bottom, -26, 30), 1, { side: 1, steepCost: 120 });
  const ost = route(FO, [50, 2], uv(FO, oChair.bottom, -30, 4), 2, { side: 0 });
  const kamin = route(FO, [50, -26], uv(FO, oChair.bottom, -26, -30), 3, { side: -1, steepCost: 20 });
  // links: the Kammweg from the Hirschalm Chair's top east to the Ostkar Chair, the Höhenweg from the Ostkar
  // Chair's top back west to the Hirschalm Chair
  const FK = face('kammweg', hChair.top, oChair.bottom, 420, 360);
  const kweg = route(FK, [50, -36], uv(FK, oChair.bottom, -30, -40), 1, { turnCost: 20, sideHill: 1.2, steepCost: 120 });
  const FW = face('hoehenweg', oChair.top, hChair.bottom, 420, 360);
  const hoehe = route(FW, [50, 36], uv(FW, hChair.bottom, -30, 40), 1, { turnCost: 20, sideHill: 1.2, steepCost: 120 });
  const pistesB = [
    addPiste('Murmeltier', 1, murmel, { peak: 'ostkar', number: 61 }),
    addPiste('Ostkar', 2, ost, { peak: 'ostkar', number: 62 }),
    addPiste('Kamin', 3, kamin, { peak: 'ostkar', number: 63 }),
    addPiste('Kammweg', 1, kweg, { peak: 'ostkar', number: 64 }),
    addPiste('Höhenweg', 1, hoehe, { peak: 'hirschalm', number: 56 }),
  ];
  pistesA.push(pistesB.pop());
  layout.peaks.push({ id: 'ostkar', name: 'Ostkar', lift: oChair, hut: ohut, pistes: pistesB, patrol: opatrol });

  // ---------------------------------------------------------------- bowls
  // (the bowls and the reshaped areas go into the crag mask: no rock bands on them or within 40 m of them)
  layout.bowls = [...BOWLS, ...AREAS.map((a) => ({ ...a, area: true }))];
  if (globalThis.process?.env?.NOBENCH) return;
  // then the runs themselves: each one graded like a built piste (see pisteBench)
  // (the gentlest first: where a steeper run crosses an easier one it takes the easier one's level, never the reverse)
  const order = ['Talweg', 'Hirschweg', 'Kammweg', 'Höhenweg', 'Almrausch', 'Murmeltier', 'Kammabfahrt', 'Ostkar', 'Steinbock', 'Kamin'];
  world.addCut(pisteBench([...pistesA, ...pistesB].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).map((p) => ({ pts: p.pts, w: PISTE_WIDTH[p.diff] + 4, gMax: GRADE_CAP[p.diff] }))));
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
const BANK = 26, BANK_MAX = 100, DEV = +(globalThis.process?.env?.DEV || 24); // m of snow bank beyond a run's bench (at least / at most)
const BC = 64;   // m: spatial grid cell
// the steepest grade a run's bench may hold, by colour: green ~14, blue ~21, red ~26.5, black ~37 degrees
const GRADE_CAP = [0.25, 0.38, 0.5, 0.75];
// the run's nearest bench point to (x, z): { w: its weight there (1 on the bench, falling off over the snow bank,
// whose width grows with the height of the bench over / under the natural ground h0), y: the bench's level }
const _b = { w: 0, y: 0 }, _d = new Float64Array(4096), _y = new Float64Array(4096), SOFT = 9; // (m: the soft minimum's scale)
function benchAt(run, x, z, h0) {
  _b.w = 0;
  const arr = run.G.get(Math.floor(x / BC) + ',' + Math.floor(z / BC));
  if (!arr) return _b;
  // (the level: a soft minimum over the run's segments, so where two legs of a winding run pass close by at
  // different levels the bench ramps between them instead of stepping where the nearest leg switches)
  let bestD = Infinity, n = 0;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i], ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / l2));
    const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z);
    _d[n] = d; _y[n++] = s.ya + (s.yb - s.ya) * t;
    if (d < bestD) bestD = d;
  }
  let sw = 0, sy = 0;
  for (let i = 0; i < n; i++) { const d = _d[i] - bestD; if (d < 60) { const k = Math.exp(-d / SOFT); sw += k; sy += k * _y[i]; } }
  const bestY = sy / sw;
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
    // (where benches overlap, each counts with its weight cubed: a run's groomed core outweighs another run's snow
    // bank, so two runs side by side or crossing don't leave a bank step on either one's piste)
    let sw = 0, sy = 0, wm = 0;
    for (let k = 0; k < upto; k++) { const b = benchAt(out[k], x, z, h); if (b.w > 0) { const w3 = b.w * b.w * b.w; sw += w3; sy += w3 * b.y; if (b.w > wm) wm = b.w; } }
    if (!sw) return h;
    const y = h + (sy / sw - h) * wm;
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
      for (const o of out) lk = Math.max(lk, smoothstep(0.85, 1, benchAt(o, P[i][0], P[i][1], h0[i]).w)); // (on its groomed core, not its banks)
      lock[i] = lk;
    }
    let Y = Float32Array.from(raw);
    for (let it = 0; it < 80; it++) {
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0, w = 0; for (let k = -8; k <= 8; k++) { const j = Math.max(0, Math.min(n - 1, i + k)), wt = 9 - Math.abs(k); s += Y[j] * wt; w += wt; } o[i] = s / w + (raw[i] - s / w) * lock[i]; }
      Y = o;
    }
    // grade cap: the colour's steepest grade (GRADE_CAP; or a little over the line's mean grade, where that is steeper): going
    // down, the profile never falls faster than that (it stays filled above a steep pitch and catches up below)
    // and never climbs; where it ends above the ground, the difference is spread evenly over the whole run
    const L = S[n - 1] || 1, g = Math.max(r.gMax, ((raw[0] - raw[n - 1]) / L) * 1.05);
    for (let k = 0; k < 3; k++) {
      for (let i = 1; i < n; i++) Y[i] = Math.min(Y[i - 1], Math.max(Y[i], Y[i - 1] - g * (S[i] - S[i - 1])));
      const e = Y[n - 1] - raw[n - 1];
      if (e > 0) for (let i = 0; i < n; i++) Y[i] -= (e * S[i]) / L;
    }
    // (a bench is cut or filled at most DEV m: no towering embankments; where the line is steeper than that allows,
    // the run keeps the ground's own, smoothed grade)
    for (let i = 0; i < n; i++) { Y[i] = Math.max(raw[i] - DEV, Math.min(raw[i] + DEV, Y[i])); Y[i] += (raw[i] - Y[i]) * lock[i]; }
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

// ---------------------------------------------------------------- the area shaper
// The ground out here is the raw range (ridged peaks, pinnacles, 50-100 m walls), far too wild for a narrow strip
// shaper: a run 40 m wide beside a 100 m wall stays beside it. So each sector's whole area (AREAS: capsules round
// its lift lines, runs and bowls) is reshaped as one: the natural ground on a 10 m grid, blurred (~50 m), then
// grade-limited (Lipschitz envelopes, below) so no slope inside the area is steeper than MAX_G (~32 degrees).
// Only the cells inside the area move, at full weight deeper than FE inside it and fading to nothing at its edge,
// round the other resorts' runs, lifts and pads (keep) and at the clip box. h' = h + M (T - R) (R the natural
// ground on the grid, T the grade-limited one, M the weight), faded under pads.
// Built at once, before the sectors' lifts and runs are laid out (their stations and routes see the final
// ground); R is sampled without rock bands (the crag mask keeps the areas and 40 m beyond them band-free).
const SH_CELL = 10, MAX_G = 0.62, BLUR = 3, FE = 110, FLAT_G = 0.2, KMIX = +(globalThis.process?.env?.KMIX || 0.15); // m grid, grade limit, blur (cells), feather (m), fill share
function areaShaper(areas, keep, clip, flats = []) {
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const a of areas) for (const [x, z] of a.pts) {
    minx = Math.min(minx, x - a.w); maxx = Math.max(maxx, x + a.w); minz = Math.min(minz, z - a.w); maxz = Math.max(maxz, z + a.w);
  }
  minx = Math.max(minx, clip.minx); maxx = Math.min(maxx, clip.maxx); minz = Math.max(minz, clip.minz); maxz = Math.min(maxz, clip.maxz);
  const x0 = Math.floor(minx / SH_CELL) * SH_CELL - SH_CELL * 4, z0 = Math.floor(minz / SH_CELL) * SH_CELL - SH_CELL * 4;
  const nx = Math.ceil((maxx - x0) / SH_CELL) + 5, nz = Math.ceil((maxz - z0) / SH_CELL) + 5, N = nx * nz;
  // the natural ground, without rock bands (a mask that allows none over the grid)
  const R = new Float32Array(N), cm = world.cragMask;
  world.cragMask = { x0: x0 - 100, z0: z0 - 100, cell: 1e5, nx: 3, nz: 3, d: new Float32Array(9) };
  try { for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) R[j * nx + i] = world.baseHeight(x0 + i * SH_CELL, z0 + j * SH_CELL); }
  finally { world.cragMask = cm; }
  // free cells: inside an area capsule and the clip box, clear of everything that must keep its ground
  const free = new Uint8Array(N), segD = (px, pz, ax, az, bx, bz) => {
    const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1)));
    return Math.hypot(ax + ex * t - px, az + ez * t - pz);
  };
  // (as segments with their boxes, only those that reach the grid: a cell tests the few round it)
  const segs = (list) => list.flatMap((a) => (a.pts.length === 1 ? [[a.pts[0], a.pts[0]]] : a.pts.slice(1).map((b, k) => [a.pts[k], b])).map(([[ax, az], [bx, bz]]) => ({ ax, az, bx, bz, w: a.w,
    x0: Math.min(ax, bx) - a.w, x1: Math.max(ax, bx) + a.w, z0: Math.min(az, bz) - a.w, z1: Math.max(az, bz) + a.w })))
    .filter((g) => g.x1 > x0 && g.x0 < x0 + nx * SH_CELL && g.z1 > z0 && g.z0 < z0 + nz * SH_CELL);
  const areaSegs = segs(areas), keepSegs = segs(keep);
  // the weight: 1 deeper than FE inside an area, falling to 0 at its edge, at FE from anything kept and at the clip box
  const depth = (G, x, z, inside) => { let best = inside ? -1e9 : 1e9; for (const g of G) { if (x < g.x0 - FE || x > g.x1 + FE || z < g.z0 - FE || z > g.z1 + FE) continue; const d = segD(x, z, g.ax, g.az, g.bx, g.bz) - g.w; best = inside ? Math.max(best, -d) : Math.min(best, d); } return best; };
  const M = new Float32Array(N);
  for (let j = 2; j < nz - 2; j++) for (let i = 2; i < nx - 2; i++) {
    const x = x0 + i * SH_CELL, z = z0 + j * SH_CELL;
    const dc = Math.min(x - clip.minx, clip.maxx - x, z - clip.minz, clip.maxz - z);
    if (dc <= 0) continue;
    const w = smoothstep(0, FE, depth(areaSegs, x, z, true)) * smoothstep(0, FE, depth(keepSegs, x, z, false)) * smoothstep(0, FE, dc);
    if (w > 0) { M[j * nx + i] = w; free[j * nx + i] = 1; }
  }
  // blur (3 separable box passes)
  let S = Float32Array.from(R);
  const Tm = new Float32Array(N);
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { let s = 0, c = 0; for (let k = -BLUR; k <= BLUR; k++) { const ii = i + k; if (ii >= 0 && ii < nx) { s += S[j * nx + ii]; c++; } } Tm[j * nx + i] = s / c; }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { let s = 0, c = 0; for (let k = -BLUR; k <= BLUR; k++) { const jj = j + k; if (jj >= 0 && jj < nz) { s += Tm[jj * nx + i]; c++; } } S[j * nx + i] = s / c; }
  }
  // the grade limit: the lower envelope (every cell no higher than any other cell + MAX_G * distance: peaks and
  // walls shaved to cones) and the upper one (no lower than any other - MAX_G * distance: pits and gullies filled),
  // each by chamfer sweeps over the 8 neighbours from the blurred ground on the area's cells; both are within the
  // limit everywhere, so any blend of them is too. Mostly shaved (KMIX of the fill): filling a wall's foot would
  // lift a whole basin floor.
  const F = new Float32Array(N);
  for (let q = 0; q < N; q++) F[q] = free[q] ? S[q] : R[q];
  // the grade limit per cell: MAX_G, eased to FLAT_G round the stations and huts (flats), so their level pads sit on
  // a gentle shoulder instead of a 32-degree cone (a pad's embankment on that would be far steeper)
  const Lm = new Float32Array(N).fill(MAX_G);
  for (const [fx, fz] of flats) for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const d = Math.hypot(x0 + i * SH_CELL - fx, z0 + j * SH_CELL - fz);
    if (d < 170) Lm[j * nx + i] = Math.min(Lm[j * nx + i], FLAT_G + (MAX_G - FLAT_G) * smoothstep(50, 170, d));
  }
  const envelope = (sg) => { // sg = 1: lower envelope (min of f + L d), -1: upper (max of f - L d)
    const E = Float32Array.from(F, (v, q) => (free[q] ? v * sg : 1e6));
    const back = [[-1, 0, SH_CELL], [-1, -1, SH_CELL * Math.SQRT2], [0, -1, SH_CELL], [1, -1, SH_CELL * Math.SQRT2]], fwd = back.map(([a, b, l]) => [-a, -b, l]);
    for (let round = 0; round < 6; round++) {
      let changed = 0;
      for (const [dirs, rev] of [[back, false], [fwd, true]]) for (let jj = 0; jj < nz; jj++) {
        const j = rev ? nz - 1 - jj : jj;
        for (let ii = 0; ii < nx; ii++) {
          const i = rev ? nx - 1 - ii : ii, q = j * nx + i;
          let v = E[q];
          for (const [di, dj, l] of dirs) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < nx && b < nz) { const n = b * nx + a, w = E[n] + l * (Lm[q] + Lm[n]) * 0.5; if (w < v) v = w; } }
          if (v < E[q] - 1e-3) { E[q] = v; changed++; }
        }
      }
      if (!changed) break;
    }
    for (let q = 0; q < N; q++) E[q] *= sg;
    return E;
  };
  const Lo = envelope(1), Hi = envelope(-1);
  const T = new Float32Array(N);
  for (let q = 0; q < N; q++) T[q] = free[q] ? Lo[q] + (Hi[q] - Lo[q]) * KMIX : R[q];
  const D = new Float32Array(N);
  for (let q = 0; q < N; q++) D[q] = free[q] ? (T[q] - R[q]) * M[q] : 0;
  return {
    bounds: { minx: x0, minz: z0, maxx: x0 + (nx - 1) * SH_CELL, maxz: z0 + (nz - 1) * SH_CELL }, shaper: true, id: 'sectors-area',
    apply(x, z, h) {
      const fx = (x - x0) / SH_CELL, fz = (z - z0) / SH_CELL, i = Math.floor(fx), j = Math.floor(fz);
      if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return h;
      const tx = fx - i, tz = fz - j, k = j * nx + i;
      const d = (D[k] * (1 - tx) + D[k + 1] * tx) * (1 - tz) + (D[k + nx] * (1 - tx) + D[k + nx + 1] * tx) * tz;
      if (d === 0) return h;
      return h + d * (1 - world.padInfluence(x, z));
    },
  };
}
