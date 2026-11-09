// Ski Legacy native port: world data exporter.
//
// Runs the game's own JavaScript world code in Node (no browser, no THREE rendering) and writes the data the C++
// build needs to rebuild the same world:
//   data/world.json  pads, corridors (pistes / lift lines), the Wolkenspitze trough, the resort layout (lifts,
//                    pistes, huts, peaks, bus stops), building placements, spawn points and reference heights
//                    (for `ski_legacy --verify-heights`)
//   data/crag.bin    the crag mask (distance from each 10 m grid node to the nearest groomed run, uint16 dm)
//   data/cuts.bin    the terrain cuts (piste grading, freeride bowls, secrets' trails, the railway's roadbed, the bus
//                    roads' benches and car parks, the Legacy Express's roadbed...) as sparse tiles of height deltas on
//                    the 2 m grid the physics mesh uses
//   data/regions.bin (Phase 3) the World Racing courses' regions (they own the terrain inside their bounds; the Legacy
//                    Express runs through them) as tiles of height deltas over the base terrain on an 8 m grid, with
//                    the regions' forest density
//   data/resort.*    (Phase 2, written by export_resort.mjs, run at the end in its own process): the village, the
//                    resort dressing, lifts and stations as built by the game's own modules
//
// The analytic base terrain (world.js baseHeight + wolkenspitze.js + legacypeak.js + noise.js) is ported to C++
// exactly; only data and the closures (cuts) that would be a large port for Phase 1 come from here.
//
// Usage (from the repo root):  node native/tools/export_world.mjs
// Re-run whenever src/world/* changes. Takes ~1-2 minutes.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeData, filterGrid } from './datafile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const OUT = path.resolve(HERE, '../data');
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[export ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const L = await import(pathToFileURL(path.join(SRC, 'world/layout.js')).href);
const S = await import(pathToFileURL(path.join(SRC, 'world/secrets.js')).href);
const { world, MASSIFS } = await import(pathToFileURL(path.join(SRC, 'world/world.js')).href);
const { WOLKENSPITZE } = await import(pathToFileURL(path.join(SRC, 'world/wolkenspitze.js')).href);

L.initLayout();
log('layout done');
try { S.initSecrets(); log('secrets done'); } catch (e) { log('secrets skipped:', e.message); }
const { layout } = L;
// (Phase 3) main.js's planning before the terrain is built, in its order: the piste fences, the bus roads (cuts, car
// parks, corridors), the World Racing courses' regions, the Legacy Express's lakes and ground
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
try { L.planPisteFences(); } catch (e) { log('piste fences skipped:', e.message); }
try { (await import(pathToFileURL(path.join(SRC, 'game/bus/roads.js')).href)).planBusRoads(layout.busStops); log('bus roads planned'); } catch (e) { log('bus roads skipped:', e.message); }
const FREE = await import(pathToFileURL(path.join(SRC, 'modes/parkour/freeworld.js')).href);
try { await FREE.registerFreeWorldCourses(); log('courses registered:', world.regions.length); } catch (e) { log('courses skipped:', e.message); }
try { (await import(pathToFileURL(path.join(SRC, 'world/expressscenery.js')).href)).planExpressScenery(FREE.freeCourses()); } catch (e) { log('express scenery skipped:', e.message); }
try { (await import(pathToFileURL(path.join(SRC, 'world/expressground.js')).href)).buildExpressGround(FREE.freeCourses()); log('express ground built'); } catch (e) { log('express ground skipped:', e.message); }

const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- pads + corridors
const pads = world.pads.map((p) => [r3(p.x), r3(p.z), r3(p.r), r3(p.blend), p.h]);
const segs = new Map(); // unique corridor segments (the grid stores each in many cells)
for (const arr of world.corridorGrid.values()) for (const s of arr) segs.set(s, s);
const KIND = { piste: 0, race: 1, lift: 2 };
const corridors = [...segs.values()].map((s) => [s.ax, s.az, s.bx, s.bz, s.w, KIND[s.kind] ?? 0]);
// corridor order matters only for ties; keep insertion order of the grid scan (stable enough for shading)

// ---------------------------------------------------------------- crag mask
const cm = world.cragMask;
{
  const buf = Buffer.alloc(cm.nx * cm.nz * 2);
  for (let i = 0; i < cm.nx * cm.nz; i++) buf.writeUInt16LE(Math.min(65535, Math.max(0, Math.round(cm.d[i] * 10))), i * 2);
  writeData(OUT, 'crag.bin', buf);
}
log('crag mask', cm.nx, 'x', cm.nz);

// ---------------------------------------------------------------- the courses' regions -> 8 m delta tiles
// regDelta(x, z) = height with the regions (no cuts) - height without them (base + pads); 256 m tiles of 32 x 32 cells.
// The C++ terrain adds it (bilinear) to base + pads; the 2 m cut tiles below are taken relative to that, so wherever a
// cut tile lies (roads, the railways' roadbeds, pistes) the C++ height matches the JS one exactly at the grid points.
const RCELL = 8, RTILE = 32, RTW = RCELL * RTILE, RS1 = RTILE + 1;
const regions = world.regions.slice(), cutsAll = world.cuts;
const hNo = (x, z) => { const rg = world.regions, c = world.cuts; world.regions = []; world.cuts = []; try { return world.height(x, z, 0); } finally { world.regions = rg; world.cuts = c; } };
const hReg = (x, z) => { const c = world.cuts; world.cuts = []; try { return world.height(x, z, 0); } finally { world.cuts = c; } };
const regTiles = new Map(); // key -> { tx, tz, d: Float64Array, f: Float32Array }
const rk = (tx, tz) => tx * 100000 + tz;
for (const R of regions) {
  const b = R.bounds;
  for (let tx = Math.floor(b.minx / RTW); tx <= Math.floor(b.maxx / RTW); tx++) for (let tz = Math.floor(b.minz / RTW); tz <= Math.floor(b.maxz / RTW); tz++) {
    if (regTiles.has(rk(tx, tz))) continue;
    const d = new Float64Array(RS1 * RS1), f = new Float32Array(RS1 * RS1);
    let mx = 0, inR = false;
    for (let j = 0; j < RS1; j++) for (let i = 0; i < RS1; i++) {
      const x = tx * RTW + i * RCELL, z = tz * RTW + j * RCELL;
      const v = hReg(x, z) - hNo(x, z);
      d[j * RS1 + i] = v; mx = Math.max(mx, Math.abs(v));
      const rg = world.regionAt(x, z);
      if (rg?.forest) {
        inR = true;
        const h = world.height(x, z, 0), slope = Math.hypot(world.height(x + 1, z) - h, world.height(x, z + 1) - h);
        f[j * RS1 + i] = world.forest(x, z, h, slope);
      } else f[j * RS1 + i] = -1; // (outside every region: the analytic forest)
    }
    if (mx < 0.003 && !inR) continue;
    regTiles.set(rk(tx, tz), { tx, tz, d, f });
  }
  log('region', R.id, 'tiles so far', regTiles.size);
}
const regAt = (x, z) => { // the C++ bilinear region delta
  const tx = Math.floor(x / RTW), tz = Math.floor(z / RTW), t = regTiles.get(rk(tx, tz));
  if (!t) return 0;
  const fx = (x - tx * RTW) / RCELL, fz = (z - tz * RTW) / RCELL, i = Math.min(RTILE - 1, Math.floor(fx)), j = Math.min(RTILE - 1, Math.floor(fz)), u = fx - i, v = fz - j, D = t.d;
  return (D[j * RS1 + i] * (1 - u) + D[j * RS1 + i + 1] * u) * (1 - v) + (D[(j + 1) * RS1 + i] * (1 - u) + D[(j + 1) * RS1 + i + 1] * u) * v;
};
{
  const chunksR = [];
  for (const t of regTiles.values()) {
    let mx = 0;
    for (const v of t.d) mx = Math.max(mx, Math.abs(v));
    // (8 m grid, already ~0.5 m off the JS inside the regions: a 5 mm step is plenty and compresses far better)
    const scale = Math.max(mx / 32767, 0.005);
    const N = RS1 * RS1, q = new Int16Array(N), f = Buffer.alloc(N);
    for (let k = 0; k < N; k++) q[k] = Math.round(t.d[k] / scale);
    for (let k = 0; k < N; k++) f[k] = t.f[k] < 0 ? 255 : Math.round(Math.min(1, t.f[k]) * 254);
    const fd = Buffer.alloc(N);
    for (let k = 0; k < N; k++) fd[k] = (f[k] - (k ? f[k - 1] : 0)) & 255;
    const h = Buffer.alloc(12);
    h.writeInt32LE(t.tx, 0); h.writeInt32LE(t.tz, 4); h.writeFloatLE(scale, 8);
    chunksR.push(h, filterGrid(q, RS1), fd);
    // (the deltas as the C++ reads them back: the cut tiles are taken against these)
    for (let k = 0; k < N; k++) t.d[k] = q[k] * scale;
  }
  // SLR2: per tile tx, tz (int32), scale (float), the filtered int16 grid (datafile.mjs filterGrid), the forest bytes
  // as differences (255 = outside every region)
  const head = Buffer.alloc(16);
  head.write('SLR2', 0); head.writeInt32LE(RCELL, 4); head.writeInt32LE(RTILE, 8); head.writeInt32LE(regTiles.size, 12);
  writeData(OUT, 'regions.bin', Buffer.concat([head, ...chunksR]));
  log('region tiles', regTiles.size);
}

// ---------------------------------------------------------------- terrain cuts -> sparse delta tiles
// delta(x, z) = the height as the terrain looks from outside (covered cuts, e.g. tunnel trenches under a lid, left out:
// the C++ terrain keeps the mountain whole over a tube) - (base + pads + the region delta as the C++ interpolates it)
const CELL = 2, TILE = 32, TW = TILE * CELL; // 64 m tiles of 32 x 32 cells (33 x 33 samples)
const cuts = cutsAll;
const delta = (x, z) => {
  world._outside = true;
  const h1 = world.height(x, z, 0);
  world._outside = false;
  return h1 - (hNo(x, z) + regAt(x, z));
};
const tiles = new Set();
const tk = (tx, tz) => tx * 100000 + tz;
for (const c of cuts) {
  if (c.covered) continue;
  const b = c.bounds;
  const tx0 = Math.floor(b.minx / TW), tx1 = Math.floor(b.maxx / TW), tz0 = Math.floor(b.minz / TW), tz1 = Math.floor(b.maxz / TW);
  const area = (b.maxx - b.minx) * (b.maxz - b.minz);
  if (area < 1.5e6) { for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) tiles.add(tk(tx, tz)); continue; }
  // big cut: coarse 8 m scan, a tile (and its neighbours) is kept where any sample moves
  const STEP = 8;
  for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) {
    if (tiles.has(tk(tx, tz))) continue;
    let hit = false;
    for (let j = 0; j < TW && !hit; j += STEP) for (let i = 0; i < TW && !hit; i += STEP) {
      const x = tx * TW + i + STEP / 2, z = tz * TW + j + STEP / 2;
      if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
      if (Math.abs(world.height(x, z, 0) - hReg(x, z)) > 0.003) hit = true; // (this cut moves the ground here)
    }
    if (hit) for (let a = -1; a <= 1; a++) for (let d = -1; d <= 1; d++) tiles.add(tk(tx + a, tz + d));
  }
  log('cut scanned', JSON.stringify(b).slice(0, 80), 'tiles so far', tiles.size);
}
const tileList = [...tiles].map((k) => [Math.round(k / 100000), k - Math.round(k / 100000) * 100000]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const S1 = TILE + 1;
const chunks = [];
let kept = 0;
for (const [tx, tz] of tileList) {
  const d = new Float64Array(S1 * S1);
  let mx = 0;
  for (let j = 0; j < S1; j++) for (let i = 0; i < S1; i++) {
    const v = delta(tx * TW + i * CELL, tz * TW + j * CELL);
    d[j * S1 + i] = v; mx = Math.max(mx, Math.abs(v));
  }
  if (mx < 0.003) continue;
  // (a 1 mm step at the finest: within the 2.5 mm the physics surface is checked to, and it compresses well)
  const scale = Math.max(mx / 32767, 0.001);
  const q = new Int16Array(S1 * S1);
  for (let k = 0; k < S1 * S1; k++) q[k] = Math.round(d[k] / scale);
  const h = Buffer.alloc(12);
  h.writeInt32LE(tx, 0); h.writeInt32LE(tz, 4); h.writeFloatLE(scale, 8);
  chunks.push(h, filterGrid(q, S1)); kept++;
}
{
  // SLC2: per tile tx, tz (int32), scale (float), the filtered int16 grid (datafile.mjs filterGrid)
  const head = Buffer.alloc(16);
  head.write('SLC2', 0); head.writeInt32LE(CELL, 4); head.writeInt32LE(TILE, 8); head.writeInt32LE(kept, 12);
  writeData(OUT, 'cuts.bin', Buffer.concat([head, ...chunks]));
}
log('cut tiles', kept, 'of', tileList.length, 'candidates');

// ---------------------------------------------------------------- placements (village.js)
const faceTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);
const placements = [];
placements.push({ model: 'rental_shop', x: -40, z: -18, yaw: faceTo(-40, -18, 0, -10), size: 11, axis: 'x', sink: 0.2, box: 0.42 });
placements.push({ model: 'ticket_booth', x: 15, z: -50, yaw: faceTo(15, -50, 0, -10), size: 4.8, axis: 'x', sink: 0.2, box: 0.48 });
for (const [x, z] of [[62, 34], [-74, 44], [100, -34], [-108, -60], [22, 92], [-36, 108], [118, 70], [-128, 22]]) {
  placements.push({ model: 'hotel_chalet', x, z, yaw: faceTo(x, z, 0, 0) + Math.sin(x * 12.9 + z) * 0.1, size: 17 + ((x * 7 + z * 13) % 5 + 5) % 5 * 0.8, axis: 'x', sink: 0.5, box: 0.4 });
}
const lampSpots = [];
for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; lampSpots.push([Math.cos(a) * 34, Math.sin(a) * 34 - 6]); }
lampSpots.push([-6, -36], [12, -36], [-26, -6], [-30, -30]);
for (const [x, z] of lampSpots) placements.push({ model: 'lamp_post', x, z, yaw: faceTo(x, z, 0, -6), size: 3.6, axis: 'y', sink: 0.05, radius: 0.25 });
for (const hut of layout.huts) placements.push({ model: 'mountain_hut', x: hut.x, z: hut.z, yaw: hut.yaw ?? 0, size: 10, axis: 'x', sink: 0.4, box: 0.42, name: hut.name });

// ---------------------------------------------------------------- layout (for later phases and the HUD)
const lifts = layout.lifts.map((l) => ({ id: l.id, type: l.type, name: l.name, bottom: [l.bottom.x, l.bottom.y, l.bottom.z], top: [l.top.x, l.top.y, l.top.z],
  towers: (l.towers || []).map((t) => [r3(t.x), r3(t.z)]), mid: l.mid ? [l.mid.x, l.mid.y ?? 0, l.mid.z] : null }));
const pistes = layout.pistes.map((p) => ({ name: p.name, diff: p.diff, peak: p.peak || null, number: p.number ?? null, lane: !!p.lane, pts: p.pts.map(([x, z]) => [r3(x), r3(z)]) }));
const huts = layout.huts.map((h) => ({ name: h.name, x: h.x, z: h.z, yaw: h.yaw ?? 0 }));
const peaks = layout.peaks.map((p) => ({ id: p.id, name: p.name, lift: p.lift?.id ?? null }));
const busStops = layout.busStops.map((b) => ({ name: b.name, x: b.x, z: b.z, heading: b.heading }));

// ---------------------------------------------------------------- reference samples (C++ height check)
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const refs = [];
const pts = [[0, 0], [10, -2120], [4120, -3260], [200, -4600], [3500, -3800], [2290, -560], [-2300, -215], [505, 1545], [300, 3000]];
for (let i = 0; i < 300; i++) pts.push([(rnd() - 0.5) * 12000, (rnd() - 0.5) * 12000]);
for (let i = 0; i < 100; i++) { const p = pistes[i % pistes.length].pts; const q = p[Math.floor(rnd() * p.length)]; pts.push([q[0] + (rnd() - 0.5) * 20, q[1] + (rnd() - 0.5) * 20]); }
for (const [x, z] of pts) {
  const h = world.height(x, z, 0);
  const slope = Math.hypot(world.height(x + 1, z) - h, world.height(x, z + 1) - h);
  refs.push([r3(x), r3(z), world.baseHeight(x, z, 0), world.baseHeight(x, z, 8), world.baseHeight(x, z, 64), h, world.meshHeight(x, z), world.forest(x, z, h, slope), world.regionAt(x, z) ? 1 : 0]);
}

const out = {
  version: 3,
  regions: { file: 'regions.bin', cell: RCELL, tile: RTILE, list: regions.map((r) => ({ id: r.id, bounds: r.bounds })) },
  generated: new Date().toISOString(),
  seed: 7331,
  massifs: MASSIFS.map((m) => m.id),
  crag: { x0: cm.x0, z0: cm.z0, cell: cm.cell, nx: cm.nx, nz: cm.nz, file: 'crag.bin' },
  cuts: { file: 'cuts.bin', cell: CELL, tile: TILE, tiles: kept },
  trough: WOLKENSPITZE.trough,
  pads, corridors,
  layout: { lifts, pistes, huts, peaks, busStops },
  placements,
  spawn: { village: { x: 4, z: 34, heading: Math.PI } },
  refs,
};
log('wrote', path.join(OUT, 'world.json.zst'), (writeData(OUT, 'world.json', JSON.stringify(out)) / 1024).toFixed(0) + ' KB');

// ---------------------------------------------------------------- Phase 2: the resort (its own process: loader hooks)
{
  const r = spawnSync(process.execPath, [path.join(HERE, 'export_resort.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('export_resort.mjs failed'); process.exitCode = 1; }
}
// ---------------------------------------------------------------- Phase 4: the UI fonts
{
  const r = spawnSync(process.execPath, [path.join(HERE, 'export_fonts.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('export_fonts.mjs failed'); process.exitCode = 1; }
}
