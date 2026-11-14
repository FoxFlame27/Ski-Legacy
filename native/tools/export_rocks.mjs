// Ski Legacy native port: reference rocks for `ski_legacy --verify-heights`.
//
// The mountains' rocks are placed by the C++ itself (native/src/world/scenery.cpp genCell / rockSpot / placeRock, a
// port of world/vegetation.js), from the same grid points, hashes and world data as the trees. This script runs the
// game's own placement (the world planned as main.js does, then Vegetation.genCell) on a spread of 64 m cells and
// writes what it puts in them to data/rocks_ref.json; the C++ check places the same cells and compares every rock
// (model, position, size, height). Cells near the railways are left out (the check runs without the transport data).
//
// Usage (from the repo root):  node native/tools/export_rocks.mjs   (export_world.mjs runs it at its end)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeData } from './datafile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const OUT = path.resolve(HERE, '../data');
const imp = (p) => import(pathToFileURL(path.join(SRC, p)).href);
const t0 = Date.now();
const log = (...a) => console.log(`[export rocks ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
// (main.js's planning before the terrain is built, in its order: as export_world.mjs)
const L = await imp('world/layout.js');
const S = await imp('world/secrets.js');
const { world } = await imp('world/world.js');
L.initLayout();
try { S.initSecrets(); } catch (e) { log('secrets skipped:', e.message); }
try { L.planPisteFences(); } catch (e) { log('piste fences skipped:', e.message); }
try { (await imp('game/bus/roads.js')).planBusRoads(L.layout.busStops); } catch (e) { log('bus roads skipped:', e.message); }
const FREE = await imp('modes/parkour/freeworld.js');
try { await FREE.registerFreeWorldCourses(); } catch (e) { log('courses skipped:', e.message); }
try { (await imp('world/expressscenery.js')).planExpressScenery(FREE.freeCourses()); } catch (e) { log('express scenery skipped:', e.message); }
try { (await imp('world/expressground.js')).buildExpressGround(FREE.freeCourses()); } catch (e) { log('express ground skipped:', e.message); }
const { Vegetation } = await imp('world/vegetation.js');
const { EXPRESS, expressNearest } = await imp('world/expressroute.js');
const { railNearest } = await imp('world/railroute.js');

// genCell needs no renderer: a bare instance with the kit's flag
const veg = Object.create(Vegetation.prototype);
veg.rockKit = { hi: [], lo: [] };
const nearRail = (x, z) => {
  for (const [dx, dz] of [[0, 0], [64, 0], [0, 64], [64, 64], [32, 32]]) {
    const n = (EXPRESS.ready && expressNearest(x + dx, z + dz, {})) || null, m = railNearest(x + dx, z + dz, {});
    if ((n && n.d < 100) || (m && m.d < 100)) return true;
  }
  return false;
};
// candidate cells: a fixed pseudo-random spread over the mountains and the resort's face, kept when they hold rocks
let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const cells = [];
let tried = 0;
while (cells.length < 160 && tried < 4000) {
  tried++;
  const x = tried % 2 ? (rnd() - 0.5) * 4000 : (rnd() - 0.5) * 11000, z = tried % 2 ? -1500 + (rnd() - 0.5) * 4000 : (rnd() - 0.5) * 11000;
  const cx = Math.floor(x / 64), cz = Math.floor(z / 64);
  if (nearRail(cx * 64, cz * 64) || cells.some((c) => c[0] === cx && c[1] === cz)) continue;
  world.ensureFeatures(cx * 64, cz * 64, (cx + 1) * 64, (cz + 1) * 64);
  const rocks = veg.genCell(cx, cz).rocks;
  if (!rocks.length) continue;
  // x, z, model (-1: an elongated rock's extra collider), collision size, collider top (y + 0.75 s), radius
  cells.push([cx, cz, rocks.map((r) => [r4(r.x), r4(r.z), r.v, r4(r.s), r4(r.y + 0.75 * r.s), r4(r.r)])]);
}
const n = cells.reduce((s, c) => s + c[2].length, 0);
log(`${cells.length} cells (${tried} tried), ${n} rocks ->`, path.join(OUT, 'rocks_ref.json.zst'), (writeData(OUT, 'rocks_ref.json', JSON.stringify({ version: 1, cells })) / 1024).toFixed(0) + ' KB');
