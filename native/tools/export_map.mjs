// Ski Legacy native port: the trail map's extra data (data/map.json), what src/ui/trailmap.js reads live from the
// game's modules and the other packs don't carry: the road network as the map draws it (names, kinds, label spots,
// tunnels with their portals, roundabouts, car parks with their sizes), the summits, the village's buildings, the
// terrain park, the heli-ski pad and drop zones, the chalet village's spot, the landmarks.
//
// Runs on its own (a few seconds; node native/tools/export_map.mjs) and at the end of export_world.mjs.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeData } from './datafile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const OUT = path.resolve(HERE, '../data');
const imp = (p) => import(pathToFileURL(path.join(SRC, p)).href);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const t0 = Date.now();
const log = (...a) => console.log(`[map ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const L = await imp('world/layout.js');
const { world, MAIN_SUMMIT } = await imp('world/world.js');
L.initLayout();
const { layout } = L;
let secrets = [];
try {
  const S = await imp('world/secrets.js');
  S.initSecrets();
  secrets = (S.SECRETS || S.secretDefs?.() || []).map((d) => ({ id: d.id ?? d.name, x: r2(d.center.x), z: r2(d.center.z), label: d.name })).filter((d) => Number.isFinite(d.x));
} catch (e) { log('secrets skipped:', e.message); }
try { L.planPisteFences(); } catch (e) { log('piste fences skipped:', e.message); }
const RD = await imp('game/bus/roads.js');
try { RD.planBusRoads(layout.busStops); } catch (e) { log('bus roads skipped:', e.message); }
const { busRoads, roadAt } = RD;

const out = { version: 1 };
// ---------------------------------------------------------------- roads (trailmap.js roadCache)
const R = busRoads.roads || [];
const box = [Infinity, Infinity, -Infinity, -Infinity];
const named = [];
out.roads = [];
for (const r of R) {
  if (!r?.n || !r.X) continue;
  const isRing = !!r.ringRoad, sc = !!r.scenic && !r.chalet, spur = /spur$/i.test(r.name || '');
  const kind = isRing ? 4 : sc ? (spur ? 3 : 1) : r.access || r.chalet ? 2 : 0; // main, scenic, minor, scenic minor, ring
  const pts = [];
  for (let i = 0; i < r.n; i += 2) {
    const x = r.X[i], z = r.Z[i];
    pts.push(r2(x), r2(z));
    if (x < box[0]) box[0] = x; if (z < box[1]) box[1] = z; if (x > box[2]) box[2] = x; if (z > box[3]) box[3] = z;
  }
  if ((r.n - 1) % 2) pts.push(r2(r.X[r.n - 1]), r2(r.Z[r.n - 1]));
  out.roads.push({ name: r.name || '', kind, length: r2(r.length ?? 0), what: r.scenic && !r.chalet ? 'Scenic road' : r.access ? 'Car park access' : r.chalet ? 'Chalet road' : 'Valley road', pts });
  if (r.name && !isRing) {
    const lp = [], k = Math.max(4, Math.round(50 / Math.max(1, r.length / r.n)));
    for (let i = k; i < r.n - k; i += k) lp.push([r2(r.X[i]), r2(r.Z[i]), r4(Math.atan2(r.Z[i + k] - r.Z[i - k], r.X[i + k] - r.X[i - k]))]);
    if (lp.length) named.push({ name: r.name, length: r2(r.length), scenic: sc, minor: spur || (!sc && !!(r.access || r.chalet)), pts: lp });
  }
}
named.sort((a, b) => b.length - a.length);
const seen = new Set();
out.roadLabels = named.filter((n) => { const k = n.name.replace(/\s*\(.*\)$/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
out.roadBox = box.map(r2);
out.tunnels = [];
const TQ = {};
for (const t of busRoads.tunnels || []) {
  const r = t.road;
  if (!r?.n || !r.X || !(t.sF1 > t.sF0)) continue;
  const pts = [], k = Math.max(2, Math.ceil((t.sF1 - t.sF0) / 6));
  for (let j = 0; j <= k; j++) { roadAt(r, t.sF0 + ((t.sF1 - t.sF0) * j) / k, TQ); pts.push(r2(TQ.x), r2(TQ.z)); }
  const ends = [t.sF0, t.sF1].map((sv) => { roadAt(r, sv, TQ); return [r2(TQ.x), r2(TQ.z), r4(TQ.dx), r4(TQ.dz)]; });
  out.tunnels.push({ name: t.name || 'Tunnel', length: r2(t.length || t.sF1 - t.sF0), road: (r.name || 'Road').replace(/\s*\(.*\)$/, ''), pts, ends });
}
out.rings = (busRoads.roundabouts || []).map((q) => ({ x: r2(q.x), z: r2(q.z), R: q.R || 15, name: q.name || '' }));
out.lots = (busRoads.lots || []).filter((q) => (!q.building || q.depot) && Number.isFinite(q.x)).map((q) => ({ x: r2(q.x), z: r2(q.z), hw: q.hw, hd: q.hd, ux: r4(q.ux ?? 1), uz: r4(q.uz ?? 0), vx: r4(q.vx ?? 0), vz: r4(q.vz ?? 1), name: q.name || '', size: q.size || '', depot: !!q.depot }));
if (busRoads.hospital) out.hospital = { x: r2(busRoads.hospital.ex ?? busRoads.hospital.x), z: r2(busRoads.hospital.ez ?? busRoads.hospital.z) };
if (busRoads.rental) out.rental = { x: r2(busRoads.rental.ex ?? busRoads.rental.x), z: r2(busRoads.rental.ez ?? busRoads.rental.z) };
{
  let P = busRoads.chalets?.place;
  if (!P) { try { P = (await imp('game/bus/chaletroad.js')).CHALET_PLACE; } catch { P = null; } }
  if (P) out.chaletVillage = { x: r2(P.x), z: r2(P.z), n: busRoads.chalets?.plots?.filter((q) => !q.playground).length || 18,
    road: busRoads.chalets?.road?.X ? Array.from({ length: Math.ceil(busRoads.chalets.road.n / 2) }, (_, i) => [r2(busRoads.chalets.road.X[i * 2]), r2(busRoads.chalets.road.Z[i * 2])]).flat() : [] };
}
// ---------------------------------------------------------------- the mountain
out.peaks = [];
for (const p of layout.peaks) {
  const sm = p.summit || (p.id === 'legacy' ? MAIN_SUMMIT : null);
  if (sm) out.peaks.push({ id: p.id, name: p.name, x: r2(sm.x), z: r2(sm.z), h: Math.round(world.height(sm.x, sm.z)) });
}
out.village = L.VILLAGE_BUILDINGS;
out.huts = layout.huts.map((h) => ({ name: h.name, label: h.label || '', x: r2(h.x), z: r2(h.z) }));
out.mids = layout.lifts.filter((l) => l.mid).map((l) => ({ lift: l.name, name: l.mid.name || '', x: r2(l.mid.x), z: r2(l.mid.z) }));
if (layout.park?.line) {
  const p = layout.park;
  out.park = { name: p.name || 'Legacy Park', halfWidth: p.halfWidth || 17, line: p.line.map((q) => [r2(q[0] ?? q.x), r2(q[1] ?? q.z)]).flat(),
    features: (p.features || []).map((f) => [r2(f.x), r2(f.z)]).flat(), drop: p.drop ? { x: r2(p.drop.x), z: r2(p.drop.z) } : null };
}
// ---------------------------------------------------------------- heli-ski: the drop zones
out.drops = [];
try {
  const Z = await imp('game/heli/zones.js');
  for (const z of Z.dropZones()) out.drops.push({ x: r2(z.x), z: r2(z.z), label: `${z.name} · ${z.vertical} m` });
} catch (e) { log('drop zones skipped:', e.message); }
out.secrets = secrets;

const bytes = writeData(OUT, 'map.json', JSON.stringify(out));
log(`wrote map.json: ${out.roads.length} roads, ${out.roadLabels.length} road names, ${out.tunnels.length} tunnels, ${out.rings.length} roundabouts, ${out.lots.length} car parks, ${out.peaks.length} summits, ${out.drops.length} drop zones, ${out.secrets.length} landmarks (${(bytes / 1024).toFixed(0)} KB)`);
