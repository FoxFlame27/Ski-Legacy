// The native game's own village (Nov 2026: "change the entire layout of Ski Legacy village... like in real life, some
// parts higher, not just the same houses"). The JS game is left as it is: this C++-only layout is applied ON TOP of the
// exported world (native/data/resort|transport|play.json), so a later export from the JS does not wipe it.
//
//   node native/tools/village/village_layout.mjs        -> native/data/village.json.zst + village.bin.zst
//
// (It lives in a folder of its own: native/tools/*.mjs are the world exporter's dependencies, and editing this file
// must not re-run the 3-minute export. CMake runs it after the export: it reads the exported data.)
//
// What it writes (world/village.h reads it):
//   relief    the village's terrain levels: a 2 m grid of height deltas (int16 cm, in village.bin) added to the terrain
//             (World::height): the Oberdorf terraces climbing north-west from the square to the Legacy Express station's
//             bench (9.43 m), the church's knoll, the Oberdorfstrasse climbing through them. Zero within reach of every
//             exported thing that stays (roads, lifts and their towers, stations, piste corridors, signs, the square's
//             furniture...), so nothing exported floats or sinks; --verify-heights compares the JS terrain without it.
//   clear     what of the exported resort pack goes: the eight identical hotel_chalet, the plaza's lamp ring, the old
//             cobble paths, the snowmen and firewood by the old hotels (and their colliders)
//   props     the new buildings (Meshy models under public/models/village/), retaining walls, stairs, lamps, trees,
//             fountain, benches, shelters, snow banks: model, place, turn, size, how they sit on the ground, collider
//   paths     the new paving (the exported cobble material), drawn on the terrain
//   places    for the gameplay and the people: the hotels' doors, the map's buildings, the walking network, the spawn
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const native = path.resolve(here, '..', '..'), root = path.resolve(native, '..');
const DATA = path.join(native, 'data');
const { world } = await import(pathToFileURL(path.join(root, 'src', 'world', 'world.js')).href);
const { writeData } = await import(pathToFileURL(path.join(native, 'tools', 'datafile.mjs')).href);
const readJ = (n) => {
  const p = path.join(DATA, n);
  const b = fs.existsSync(p + '.zst') ? zlib.zstdDecompressSync(fs.readFileSync(p + '.zst')) : fs.readFileSync(p);
  return JSON.parse(b.toString('utf8'));
};
const readB = (n) => { const p = path.join(DATA, n); return fs.existsSync(p + '.zst') ? zlib.zstdDecompressSync(fs.readFileSync(p + '.zst')) : fs.readFileSync(p); };
const W = readJ('world.json'), R = readJ('resort.json'), T = readJ('transport.json'), P = readJ('play.json');
const RB = readB('resort.bin'), TB = readB('transport.bin'), PB = readB('play.bin');
const log = (...a) => console.log('[village]', ...a);
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const PI = Math.PI;

// ---------------------------------------------------------------- the ground as exported (base terrain + pads)
const pads = W.pads.map(([x, z, r, blend, h]) => ({ x, z, r, blend, h }));
function h0(x, z) {
  let h = world.baseHeight(x, z);
  for (const p of pads) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r + p.blend) h = lerp(p.h, h, sstep(p.r, p.r + p.blend, d));
  }
  return h;
}

// ---------------------------------------------------------------- the models (public/models/village, Meshy)
// size: the GLB's bounds (x wide, y tall, z deep, front +z), measured; w: the real width the building is set to
const MODELS = {
  hotel_grand: [1.899, 1.409, 1.341], hotel_lodge: [1.891, 0.938, 1.650], hotel_tyrol: [1.899, 1.351, 1.638],
  hotel_modern: [1.899, 1.360, 1.592], hotel_valais: [1.611, 1.898, 1.353], shop_townhouse: [0.961, 1.900, 1.286],
  shop_pastel: [1.898, 1.107, 0.818], shop_timber: [1.898, 1.367, 1.445], cafe: [1.898, 1.643, 1.778],
  bakery: [1.898, 1.435, 1.387], sports_shop: [1.898, 1.332, 1.575], restaurant_stube: [1.899, 1.611, 1.627],
  church: [1.897, 1.785, 1.160], lift_hall: [1.898, 0.867, 1.618], bus_terminal: [1.898, 1.029, 1.239],
  town_hall: [1.898, 1.790, 1.601], apartment_lodge: [1.594, 1.899, 1.226], apartment_modern: [1.899, 1.438, 1.451],
  chalet_classic: [1.899, 1.379, 1.897], chalet_modern: [1.899, 1.094, 1.897], chalet_stone: [1.782, 1.583, 1.893],
  chalet_small: [1.485, 1.240, 1.896], garages: [1.898, 0.717, 1.183], fountain: [1.612, 1.898, 1.612],
  retaining_wall: [1.899, 0.666, 0.615], stone_stairs: [1.730, 1.735, 1.899], bus_shelter: [1.898, 1.549, 0.833],
};
const OTHER = { lamp_post: [0.475, 1.899, 0.887], pine_tree: [1.060, 1.866, 1.015], pine_tree2: [0.801, 1.892, 0.857], wooden_bench: [1.9, 1.085, 1.201],
  'snow/drift_long': [1.898, 0.162, 0.5], 'snow/snow_heap': [1.783, 0.602, 1.898], picket_fence: [1.899, 1.187, 0.252],
  'decor/planter_spruce': null, 'decor/litter_bin': null, outdoor_ski_rack: null };

const props = [];      // { m, x, z, yaw, s: [sx, sy, sz] (model units -> m), ground, sink, glow, col, top, shadow }
const buildings = [];  // footprints (for the checks, the map, the doors)
const places = { hotels: [], buildings: [], shops: [] };
const front = (yaw) => [Math.sin(yaw), Math.cos(yaw)];

/** A building: model id, centre, yaw (its front faces (sin yaw, cos yaw)), real width w (along its own x). Declared
 *  first (PENDING), then settled clear of everything (settleBuildings) and placed (emitBuilding). */
const PENDING = [];
function building(id, x, z, yaw, w, o = {}) {
  // (on the Oberdorf's terraces: moved up or down the hill onto the middle of its terrace, clear of the walls)
  if (o.snap !== false && typeof U === 'function' && inPoly(x, z, OBERDORF)) {
    const u = U(x, z);
    for (let k = 0; k < BANDS.length - 1; k++) if (u >= BANDS[k] - 6 && u < BANDS[k + 1] - 6) { const du = (BANDS[k] + BANDS[k + 1]) / 2 - u; x += -0.6 * du; z += -0.8 * du; break; }
  }
  const S = MODELS[id], k = w / S[0];
  PENDING.push({ id, x, z, yaw, w, d: S[2] * k, o, x0: x, z0: z });
}
function emitBuilding(id, x, z, yaw, w, o = {}) {
  const S = MODELS[id];
  const k = w / S[0];
  const d = S[2] * k, h = S[1] * k;
  props.push({ m: `village/${id}`, x: r3(x), z: r3(z), yaw: r3(yaw), s: [r3(k), r3(k), r3(k)], ground: o.ground || 'min', sink: o.sink ?? 0.35,
    glow: o.glow ?? 3.0, col: o.col === false ? null : { k: o.colK ?? 0.42 } });
  const b = { id, name: o.name || id, x, z, yaw, w, d, h, kind: o.kind || 'house' };
  buildings.push(b);
  const [fx, fz] = front(yaw);
  const door = { in: [r3(x + fx * (d * 0.5 * 0.84 - 0.6)), r3(z + fz * (d * 0.5 * 0.84 - 0.6))], out: [r3(x + fx * Math.max(d * 0.5 * 0.84 + 2.6, d * 0.5 + 1.8)), r3(z + fz * Math.max(d * 0.5 * 0.84 + 2.6, d * 0.5 + 1.8))] };
  b.door = door;
  if (b.kind === 'hotel') places.hotels.push({ name: b.name, x: r3(x), z: r3(z), ...door, w: o.weight ?? 1 });
  if (b.kind === 'shop') places.shops.push({ name: b.name, x: r3(x), z: r3(z), ...door });
  places.buildings.push([r3(x), r3(z), b.name, b.kind]);
  return b;
}
/** Any other prop: model path, centre, yaw, uniform scale from a size along an axis (x / y) or explicit scales. */
function prop(m, x, z, yaw, o = {}) {
  const S = MODELS[m.replace('village/', '')] || OTHER[m];
  let s = o.s;
  if (!s) { const k = o.h ? o.h / S[1] : o.w / S[0]; s = [k, k, k]; }
  props.push({ m, x: r3(x), z: r3(z), yaw: r3(yaw), s: s.map(r3), ground: o.ground || 'min', sink: o.sink ?? 0.05, glow: o.glow ?? 0,
    col: o.col || null, shadow: o.shadow ?? true, ...(o.lamp ? { lamp: 1 } : {}) });
}

// ---------------------------------------------------------------- what stays (exported) and must not move
// every placed thing of the three packs that is kept: the relief is zero within reach of it
const keptPts = [];   // [x, z, r]
const BOX = { x0: -290, z0: -250, x1: 240, z1: 180 };
// ---------------------------------------------------------------- moved sites (round 2)
// A site of the exported world carried elsewhere (world/village.cpp applyMoves): everything within r of `from` in every
// pack (props, colliders, baked triangles, the play data's places) goes to `to`, turned by rot, raised by dy; the relief
// at `to` copies the old site's ground (so it all sits as it sat), fading out over FADE m beyond r.
const MOVES = [];
const MOVE_FADE = 12;
// clip (round 3): [dx, dz, max]: only what lies short of max m along (dx, dz) from `from` goes (a roadside site's lot and
// buildings, not the road in front of it)
function moveSite(name, from, r, to, rot = 0, clip = null) { const m = { name, from, r, to, rot, clip }; MOVES.push(m); return m; }
const moveOf = (x, z) => MOVES.find((m) => Math.hypot(x - m.from[0], z - m.from[1]) < m.r && (!m.clip || (x - m.from[0]) * m.clip[0] + (z - m.from[1]) * m.clip[1] < m.clip[2]));
const movePt = (m, x, z) => { const dx = x - m.from[0], dz = z - m.from[1], c = Math.cos(m.rot), s = Math.sin(m.rot); return [m.to[0] + dx * c + dz * s, m.to[1] - dx * s + dz * c]; };
const unmovePt = (m, x, z) => { const dx = x - m.to[0], dz = z - m.to[1], c = Math.cos(m.rot), s = Math.sin(m.rot); return [m.from[0] + dx * c - dz * s, m.from[1] + dx * s + dz * c]; };
// The heliport (the pad, the rental hut, the windsock, the ambulance's bay): from the Bergbahnstrasse's end, hemmed in
// by chalets with its way out over the village, to the open meadow at the village's east edge between the Mountain
// Lodge and the medical centre: 68 m from the Adlerhorn Gondola's line, no building within 37 m of the pad, the
// medical centre 65 m away, a footpath from the Adlerhornweg.
const HELI = moveSite('Heliport', [92, -128], 26, [170, 52], 0);
HELI.dy = r3(h0(HELI.to[0], HELI.to[1]) - h0(HELI.from[0], HELI.from[1]));

// ---------------------------------------------------------------- the village's own roads (round 3)
// The Dorfstrasse: the valley road ended at the Legacy Village stop (the bus terminus); now a road runs on from there
// through the village: along the depot road's bend, west between the Hotel Tirolerhof and the Hotel Silberhorn
// (where the Silberhornweg was), then straight west along the foot of the Oberdorf (z 50) to a turning place at its end.
// Along its north side the Autohaus, the police station / prison and the Werkstatt, moved in from the valley road
// (each turned so that its yard faces the Dorfstrasse as it faced the valley road, at the same distance from it).
// world/village.cpp addRoads puts it on the transport network (traffic runs on into it from the valley road's end at
// the stop) and draws it with the exported road's ribbon.
const DORF_Z = 50;
const DORF_CTRL = [[4, 46], [-2, 45], [-8, 47], [-11.5, 51], [-20, 53.5], [-34, 54.5], [-46, 55], [-58, 52.5], [-68, DORF_Z], [-172, DORF_Z]];
const chaikin = (pts, it) => { let p = pts; for (let k = 0; k < it; k++) { const o = [p[0]]; for (let i = 0; i + 1 < p.length; i++) { const [ax, az] = p[i], [bx, bz] = p[i + 1]; o.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]); } o.push(p[p.length - 1]); p = o; } return p; };
const resample = (pts, step) => { const o = [pts[0]]; let carry = 0; for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az); let t = step - carry; while (t <= L) { o.push([ax + (bx - ax) * t / L, az + (bz - az) * t / L]); t += step; } carry = L - (t - step); } const e = pts[pts.length - 1], l = o[o.length - 1]; if (Math.hypot(e[0] - l[0], e[1] - l[1]) > 0.5) o.push(e); else o[o.length - 1] = e; return o; };
const DORF = resample(chaikin(DORF_CTRL, 3), 4).map(([x, z]) => [r3(x), r3(z)]);
const VROADS = [{ name: 'Dorfstrasse', pts: DORF, kmh: 30, half: 3.4 }];
// the sites moved onto it: from the valley road (road 0), the same distance from the Dorfstrasse's middle, turned so
// their front (dir: toward the road) faces +z (the Dorfstrasse runs along z = DORF_Z south of them)
{
  const fa0 = (o) => new Float32Array(TB.buffer.slice(TB.byteOffset + o.off, TB.byteOffset + o.off + o.n * 4));
  const r0 = T.net.roads[0], X0 = fa0(r0.X), Z0 = fa0(r0.Z);
  const toRoad0 = (x, z) => { let d = 1e9; for (let i = 1; i < X0.length; i++) { const ex = X0[i] - X0[i - 1], ez = Z0[i] - Z0[i - 1], t = clamp(((x - X0[i - 1]) * ex + (z - Z0[i - 1]) * ez) / (ex * ex + ez * ez), 0, 1); d = Math.min(d, Math.hypot(X0[i - 1] + ex * t - x, Z0[i - 1] + ez * t - z)); } return d; };
  const W = P.play.rooms.werkstatt.site;
  const SITES = [
    // name, the site (centre, dir to the road), r, clip (short of the road's ribbon), where along the Dorfstrasse
    ['Autohaus', P.play.rental, 25, 13.3, -90],
    ['Police / Prison', P.play.prison, 24, 12.3, -124],
    ['Werkstatt', { x: W.x, y: W.y, z: W.z, dirx: W.fx, dirz: W.fz }, 14, 11, -152],
  ];
  for (const [name, s, r, clipMax, x] of SITES) {
    const d0 = toRoad0(s.x, s.z), rot = -Math.atan2(s.dirx, s.dirz);
    const m = moveSite(name, [r3(s.x), r3(s.z)], r, [x, r3(DORF_Z - d0)], r3(rot), [r3(s.dirx), r3(s.dirz), clipMax]);
    // (the yards stand in the exported road's cuts, below the base ground: their floor `y` is the level carried; the
    // ground copied under them is held down to it)
    m.floor = s.y;
    m.dy = r3(h0(m.to[0], m.to[1]) - s.y);
    log(`${name}: (${s.x.toFixed(1)}, ${s.z.toFixed(1)}) -> (${m.to[0]}, ${m.to[1]}), ${d0.toFixed(1)} m from the road, turned ${(rot * 180 / PI).toFixed(0)} deg, dy ${m.dy}`);
  }
}
const inBox = (x, z, m = 0) => x > BOX.x0 - m && x < BOX.x1 + m && z > BOX.z0 - m && z < BOX.z1 + m;
const CLEAR_MODELS = ['hotel_chalet', 'lamp_post', 'snowman', 'firewood_pile'];
// the old village's things that go (the eight hotels, the lamp ring, the snowmen and firewood by the hotels); the shop's
// firewood beside its door stays (KEEP zones)
const VILLAGE_ZONE = [[-170, -130], [150, -130], [150, 150], [-170, 150]];
const KEEP_ZONES = [
  [[-50, -30], [-28, -30], [-28, -6], [-50, -6]],      // the ski shop, its signs, rack, sled and firewood
];
const inPoly = (x, z, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const cleared = (model, x, z) => CLEAR_MODELS.includes(model) && inPoly(x, z, VILLAGE_ZONE) && !KEEP_ZONES.some((k) => inPoly(x, z, k));
const instOf = (p, bin) => {
  if (p.inst) return p.inst;
  const out = [];
  if (!p.instN) return out;
  const f = new Float32Array(bin.buffer.slice(bin.byteOffset + p.instOff, bin.byteOffset + p.instOff + p.instN * 48));
  for (let i = 0; i < p.instN; i++) out.push(Array.from(f.subarray(i * 12, i * 12 + 12)));
  return out;
};
const clearedAt = [];   // (their colliders go with them)
const PATH_MAT = R.materials.findIndex((m) => m.transparent && m.map && m.map.wrapT && !m.map.wrapS && m.double);
log('the exported cobble material:', PATH_MAT);
for (const [J, bin, pk] of [[R, RB, 'resort'], [T, TB, 'transport'], [P, PB, 'play']]) {
  for (const p of [...J.props, ...J.instanced]) {
    for (const m of instOf(p, bin)) {
      const x = m[3], z = m[11];
      if (!inBox(x, z, 40) || moveOf(x, z)) continue;
      if (pk === 'resort' && p.model && cleared(p.model, x, z)) { clearedAt.push([x, z]); continue; }
      const sc = Math.cbrt(Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8])));
      keptPts.push([x, z, Math.max(4, Math.min(20, sc * 1.2 + 3))]);
    }
  }
  for (const c of J.colliders) {
    if (!inBox(c.x, c.z, 40) || moveOf(c.x, c.z)) continue;
    if (pk === 'resort' && clearedAt.some(([x, z]) => Math.hypot(x - c.x, z - c.z) < 0.6)) continue;
    keptPts.push([c.x, c.z, (c.r >= 0 ? c.r : Math.hypot(c.hw, c.hd)) + 4]);
  }
  for (const m of J.meshes) {
    if (pk === 'resort' && m.mat === PATH_MAT) continue;   // (the old cobble: cleared)
    const o = m.origin;
    if (!inBox(o[0], o[2], 400)) continue;
    const f = new Float32Array(bin.buffer.slice(bin.byteOffset + m.vOff, bin.byteOffset + m.vOff + m.verts * 28));
    for (let i = 0; i < m.verts; i += 1) {
      const x = f[i * 7] + o[0], z = f[i * 7 + 2] + o[2];
      if (inBox(x, z, 20) && !moveOf(x, z)) keptPts.push([x, z, 5]);
    }
  }
}
// the roads (their plough width and shoulders) and the lifts' lines and the corridors (pistes, races, lift lines)
const fa = (o) => new Float32Array(TB.buffer.slice(TB.byteOffset + o.off, TB.byteOffset + o.off + o.n * 4));
const roads = T.net.roads.map((r) => { const X = fa(r.X), Z = fa(r.Z); return Array.from(X, (x, i) => [x, Z[i]]); });
const exportedRoads = roads.length;
for (const pts of roads) for (const [x, z] of pts) if (inBox(x, z, 30)) keptPts.push([x, z, 14]);
// (Nov 2026 audit: the railways' beds too, every 2 m: the terraces' fade raised the Legacy Express's station track by up
// to 1.2 m at (-55, -158))
for (const k of ['rail', 'express']) {
  const r = T.net[k], X = fa(r.X), Z = fa(r.Z), off = k === 'express' ? r.trackOff : 0;
  for (let i = 0; i < X.length; i++) if (inBox(X[i], Z[i], 30) && !r.tunnels.some((t) => i * r.step > t.s0 + 25 && i * r.step < t.s1 - 25)) keptPts.push([X[i], Z[i], off + 6]);
}
for (const R of VROADS) roads.push(R.pts);   // (the checks below: buildings / trees clear of our roads too)
for (const L of T.net.lots) if (inBox(L.x, L.z, 60)) keptPts.push([L.x, L.z, Math.hypot(L.hw, L.hd) + 10]);
for (const c of W.corridors) {
  const [ax, az, bx, bz, w, kind] = c;
  // (a lift's corridor, and the 2 m stubs that clear a station's surroundings of forest: their towers and stations are
  // kept things of their own)
  if (kind === 2 || Math.hypot(bx - ax, bz - az) < 5) continue;
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 4);
  for (let i = 0; i <= n; i++) { const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n; if (inBox(x, z, 20)) keptPts.push([x, z, w / 2 + 6]); }
}
log(`${keptPts.length} kept points in the village box`);

// ---------------------------------------------------------------- the levels: Oberdorf terraces, church knoll
// u: the way up the hill, north-west (the main mountain's foot and the Legacy Express station's bench at 9.43 m)
const U = (x, z) => -0.6 * x - 0.8 * z;
const BENCH = 9.43;
// terrace bands 32 m of u wide from u = 70 (the square's north-west corner) up to the bench
const BANDS = [78, 110, 142, 174, 206];
const bandLevel = (u) => {
  if (u < BANDS[0]) return 0;
  for (let k = 0; k < BANDS.length - 1; k++) if (u < BANDS[k + 1]) return ((BANDS[k] + BANDS[k + 1]) / 2 - BANDS[0]) / (BANDS[BANDS.length - 1] - BANDS[0] + 16) * BENCH;
  return BENCH;
};
// the Oberdorf: where the terraces are (beyond it they fade into the hillside), the church's knoll
const OBERDORF = [[-24, -84], [-24, -150], [-200, -150], [-200, 46], [-56, 46], [-56, -84]];
const KNOLL = { poly: [[42, -32], [69, -32], [69, 12], [42, 12]], level: 3.0 };
const distPoly = (x, z, poly) => {   // distance to the polygon's boundary (0 inside)
  if (inPoly(x, z, poly)) return 0;
  let d = 1e9;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i], ex = bx - ax, ez = bz - az;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
    d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return d;
};

// ---------------------------------------------------------------- streets (paving, the walking network, the relief)
// pts: [x, z, y?] (y: the street's own level where given, else the ground's), w: paved width
const streets = [];
function street(name, pts, w, o = {}) { const s = { name, pts, w, pave: o.pave ?? true, relief: o.relief ?? false, walk: o.walk ?? true, lamps: o.lamps ?? 0 }; streets.push(s); return s; }

// The square (Dorfplatz): the Christmas tree in the middle (0, -4), its path ring, the market, the fire pit, the map,
// the job board and the racing stand stay where the JS game has them. Around it now: the ski shop and a row of
// shops on the west side, the church on its knoll in the east, the lift hall and the sports shop on the north side
// towards the Legacy Gondola, the bus terminus and the hotels to the south.
const ring = [];
for (let i = 0; i <= 24; i++) { const a = (i / 24) * PI * 2; ring.push([Math.cos(a) * 15, -4 + Math.sin(a) * 15]); }
street('ring', ring, 3, { lamps: 0 });
// Dorfstrasse: from the bus terminus (the stop at (4, 46)) up through the square to the Legacy Gondola
street('Dorfstrasse south', [[4, 38], [2, 25], [0, 11]], 6, { lamps: 18 });
street('Dorfstrasse north', [[0, -19], [1, -32], [2, -44], [2, -55]], 6, { lamps: 18 });
// the square's west side (the shops' fronts) and east side (the market, the church stair)
street('Westzeile', [[-26, 30], [-26, 18], [-25, 4], [-28, -10], [-26, -26], [-25, -40], [-14, -48], [2, -55]], 4.5, { lamps: 22 });
street('Marktgasse', [[14, 1], [24, -2], [36, -8]], 4, { lamps: 0 });
// the Adlerhorn way: square -> the Adlerhorn Gondola base, past the hotels
street('Adlerhornweg', [[12, 12], [30, 22], [48, 21], [70, 19], [85, 14], [88, 9]], 4.5, { lamps: 22 });
// the Silberhorn way: the bus terminus -> the Silberhorn Gondola base, past the hotels in the south-west
// (round 3: its first stretch is the Dorfstrasse now; the people walk along the road's edge, the paving starts where
// it leaves the road for the gondola)
street('Silberhornweg', [[-6, 36], [-11.5, 51]], 4, { lamps: 0, pave: false });
street('Silberhornweg', [[-46, 59], [-52, 72], [-56, 82]], 4, { lamps: 22 });
// the Dorfstrasse for the walkers (its edge: the people's way along it; not paved, the road's ribbon is drawn)
street('Dorfstrasse', DORF_CTRL.slice(3).map(([x, z]) => [x, z + 4.4]), 2, { lamps: 0, pave: false });
// the Bergbahnstrasse: square's north-east corner -> the hotels and chalets of the north-east quarter. (Nov 2026 audit:
// it ran north-east across the Legacy Express's open cutting just short of its tunnel portal (47, -74), with four
// houses on the track; now it keeps north of the church's knoll and crosses over the tunnel 30 m past the portal, the
// quarter east of the line)
street('Bergbahnstrasse', [[14, -40], [30, -41], [46, -43], [64, -47], [80, -60], [92, -82], [100, -106]], 4, { lamps: 24 });
// the Oberdorfstrasse: from the square's west side up through the terraces to the Legacy Express station (9.43 m)
const OBS = [[-28, -10, 0], [-56, -10, 0], [-80, -16, null], [-104, -32, null], [-122, -56, null], [-136, -84, null], [-150, -108, null], [-166, -128, null], [-184, -140, BENCH], [-190, -143.8, BENCH]];
// its levels: rising with the hill (the terraces' mid levels where it crosses them)
{
  let acc = 0; const L = [0];
  for (let i = 1; i < OBS.length; i++) { acc += Math.hypot(OBS[i][0] - OBS[i - 1][0], OBS[i][1] - OBS[i - 1][1]); L.push(acc); }
  const i0 = 1, i1 = OBS.length - 2;
  for (let i = i0 + 1; i < i1; i++) OBS[i][2] = r3(lerp(0.0, BENCH, (L[i] - L[i0]) / (L[i1] - L[i0])));
}
street('Oberdorfstrasse', OBS, 5.5, { relief: true, lamps: 24 });
// lanes along the terraces (level: the terrace's), to the chalets' doors
street('Sonnenhang', [[-104, -32], [-86, -50], [-66, -64], [-46, -80], [-34, -92]], 3.5, { lamps: 28 });
street('Hangweg', [[-122, -56], [-104, -72], [-86, -92], [-68, -108], [-52, -124]], 3.5, { lamps: 28 });
// (the Kapellenweg and the Bahnhofweg cross a terrace edge: ramps through it, at each terrace's level, as the
// Bahnhofstiege; they start on the Oberdorfstrasse at its level there)
street('Kapellenweg', [[-80, -16, OBS[2][2]], [-98, -4], [-120, 8], [-146, 14], [-170, 18]].map(([x, z, y]) => [x, z, y ?? r3(bandLevel(U(x, z)))]), 3.5, { lamps: 28, relief: true });
street('Bahnhofweg', [[-150, -108, OBS[6][2]], [-128, -122], [-104, -136], [-86, -140]].map(([x, z, y]) => [x, z, y ?? r3(bandLevel(U(x, z)))]), 3.5, { lamps: 28, relief: true });
// the way to the heliport (moved, see MOVES): from the Adlerhornweg's end past the Gasthof to the rental hut's door
// and the pad's edge
street('Heliweg', [[85, 14], [118, 20], [140, 40], [153.6, 51.5], [159.5, 53]], 3, { lamps: 22 });
// (round 3) more footpaths: from the Dorfstrasse's sites up to the Kapellenweg, and the Bahnhofstiege: from the
// square's north-west corner straight up the terraces (ramps through the terrace walls, at each terrace's level) to
// the Legacy Express station's exit
street('Postgasse', [[-70, 45.5], [-64, 20], [-58, -6]], 2.6, { lamps: 26 });
// (Nov 2026 audit: the houses south of the Dorfstrasse had no way to their doors but across the bus road) the
// Lärchenweg west of the bus road (Hotel Silberhorn, Lärchenhof, the garages), the Rathausweg east of it (the
// Busbahnhof's back, the Gemeindeamt, the Residenz Edelweiss)
street('Lärchenweg', [[-12, 57], [-14, 90], [-15, 120], [-16, 146]], 2.6, { lamps: 26 });
street('Rathausweg', [[8, 59], [5, 90], [34, 91], [34, 118]], 2.6, { lamps: 26 });
street('Werkstattgasse', [[-139, 45.5], [-142, 30], [-146, 14]], 2.6, { lamps: 26 });
{
  const lv = (x, z) => r3(bandLevel(U(x, z)));
  const pts = [[-14, -48], [-19, -68], [-32, -93], [-52, -124], [-86, -140], [-130, -146], [-172, -146], [-186, -144]].map(([x, z]) => [x, z, lv(x, z)]);
  pts[0][2] = 0;
  pts[pts.length - 1][2] = BENCH;
  street('Bahnhofstiege', pts, 3, { relief: true, lamps: 26 });
}
// the chapel way down from the knoll: stairs from the square up to the church (relief: the stair's ramp)
const STAIR_W = 5;
street('Kirchstiege', [[36, -8, 0], [46, -8, KNOLL.level]], STAIR_W, { relief: true, pave: false, lamps: 0 });

// ---------------------------------------------------------------- the buildings
const N = PI, S = 0, E = PI / 2, Wt = -PI / 2;
const facing = (dx, dz) => Math.atan2(dx, dz);
// west side of the square (fronts to the east), north to south: bakery, [ski shop], café, town house, Hotel Tirolerhof
building('bakery', -35, -35.5, E, 13, { name: 'Bäckerei Moser', kind: 'shop' });
building('cafe', -38, 3, E, 14, { name: 'Café Alpenrose', kind: 'shop' });
building('shop_townhouse', -34.5, 15.5, E, 7.5, { name: 'Sport Hofer', kind: 'shop' });
building('hotel_tyrol', -38, 33, E, 24, { name: 'Hotel Tirolerhof', kind: 'hotel', weight: 1.4 });
// the street from the bus terminus into the square, lined with shops on both sides
building('shop_pastel', -15, 29, E, 17, { name: 'Boutique Kristall', kind: 'shop' });
building('shop_timber', 20, 30, Wt, 15, { name: 'Bergsport Rainer', kind: 'shop' });
// north side: the lift hall (tickets, ski school, lockers) beside the Legacy Gondola; the sports shop at the corner
building('lift_hall', -41, -63, facing(1, 0.35), 23, { name: 'Bergbahnen · Skischule', kind: 'lift' });
building('sports_shop', 34, -54, facing(-0.75, 0.66), 20, { name: 'Intersport Legacy', kind: 'shop' });
// the church on its knoll east of the square, its stair from the market
building('church', 56, -10, Wt, 30, { name: 'Pfarrkirche St. Georg', kind: 'church', colK: 0.4, ground: 'center', sink: 0.5, settle: false });
// the hotels south-east along the Adlerhornweg, the après-ski inn at the Adlerhorn Gondola
building('hotel_grand', 68, 42, N, 34, { name: 'Grand Hotel Legacy', kind: 'hotel', weight: 2 });
building('restaurant_stube', 106, 34, N, 17, { name: 'Gasthof Adlerhorn', kind: 'shop' });
building('hotel_lodge', 118, 74, Wt, 34, { name: 'Mountain Lodge', kind: 'hotel', weight: 1.6 });
// inside the road's loop: the bus terminus (Postauto station), the town hall and post office, apartments
building('bus_terminal', 20, 77.5, N, 22, { name: 'Busbahnhof', kind: 'station' });
building('town_hall', 22, 104, Wt, 18, { name: 'Gemeindeamt · Post', kind: 'civic' });
building('apartment_lodge', 40, 102, facing(-0.5, -0.86), 14, { name: 'Residenz Edelweiss', kind: 'hotel', weight: 0.8 });
// south-west, toward the Silberhorn Gondola
building('hotel_modern', -33, 76, E, 24, { name: 'Hotel Silberhorn', kind: 'hotel', weight: 1.2 });
building('apartment_modern', -32, 112, E, 20, { name: 'Appartements Lärchenhof', kind: 'house' });
building('garages', -28, 140, E, 18, { name: 'Garagen', kind: 'house' });
// north-east by the Bergbahnstrasse, east of the Legacy Express (over its tunnel): an old Valais hotel, the ski
// service and chalets (Nov 2026 audit: they stood on the open track by the portal)
building('hotel_valais', 97, -62, facing(-1, -0.1), 13, { name: 'Hotel Walliserhof', kind: 'hotel', weight: 0.8 });
building('chalet_classic', 108, -88, facing(-1, 0.1), 13, { name: 'Chalet Bergkristall' });
building('shop_timber', 72, -78, facing(1, 0.3), 16, { name: 'Ski Service Pro', kind: 'shop' });
building('chalet_stone', 82, -104, facing(1, 0.3), 11, { name: 'Haus Enzian' });
// the Oberdorf terraces: apartment houses low down, chalets higher up, facing south-east over the village
const SE = facing(0.6, 0.8);
building('apartment_lodge', -62, -32, facing(0.8, 0.6), 16, { name: 'Haus Alpenblick', kind: 'hotel', weight: 0.6, snap: false });
building('shop_pastel', -78, 0, facing(0.2, -1), 19, { name: 'Boutiquen Oberdorf', kind: 'shop' });
building('chalet_modern', -62, -82, SE, 13, { name: 'Chalet Nova' });
building('chalet_classic', -88, -66, SE, 13, { name: 'Chalet Heidi' });
building('hotel_valais', -110, -18, facing(1, -0.2), 13, { name: 'Pension Arvenstube', kind: 'hotel', weight: 0.6 });
// (round 3: across the Dorfstrasse, facing the road; Nov 2026 audit: further east, out of the piste that comes down
// to the Silberhorn Gondola south of the road west of x -110)
building('chalet_small', -76, 62, N, 8, { name: 'Stadel' });
building('chalet_stone', -62, 63, N, 11, { name: 'Haus Bergfrieden' });
building('apartment_modern', -136, -40, SE, 20, { name: 'Residenz Panorama', kind: 'hotel', weight: 0.6 });
building('chalet_small', -104, -96, SE, 8, { name: 'Heustadel' });
building('chalet_modern', -124, -86, facing(0.8, 0.6), 13, { name: 'Chalet Lumière' });
building('chalet_stone', -172, -96, facing(1, 0.3), 11, { name: 'Haus Edelweiss' });
building('chalet_classic', -158, -66, facing(1, 0.2), 13, { name: 'Chalet Gemsblick' });
building('hotel_tyrol', -166.9, 5.8, SE, 22, { name: 'Alpengasthof Post', kind: 'hotel', weight: 0.8, snap: false });
building('restaurant_stube', -190.5, -130, N, 15, { name: 'Bahnhofbeizli', kind: 'shop', snap: false });

// ---------------------------------------------------------------- clearances (Nov 2026 audit)
// What every village piece keeps clear of (game/villagecheck.h checks the result in the game): the railways' open
// stretches (not deep in a tunnel), the pistes and race corridors, the roads with their shoulders and the bus legs, the
// car parks, the lifts' stations and low cables, the footpaths, the moved sites; on the Oberdorf the terrace it stands
// on (no house across a terrace wall).
const sDist = (x, z, pts) => { let d = 1e9; for (let q = 1; q < pts.length; q++) { const [ax, az] = pts[q - 1], [bx, bz] = pts[q], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1, t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1); d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z)); } return d; };
const RAILS = [];
for (const k of ['rail', 'express']) {
  const r = T.net[k], X = fa(r.X), Z = fa(r.Z), pts = [];
  for (let i = 0; i < X.length; i++) if (inBox(X[i], Z[i], 60) && !r.tunnels.some((t) => i * r.step > t.s0 + 25 && i * r.step < t.s1 - 25)) pts.push([X[i], Z[i]]);
  RAILS.push({ k, pts, off: k === 'express' ? r.trackOff : 0 });
}
const railDist = (x, z) => { let d = 1e9; for (const L of RAILS) for (const [a, b] of L.pts) if (Math.abs(a - x) < 30 && Math.abs(b - z) < 30) d = Math.min(d, Math.hypot(a - x, b - z) - L.off); return d; };
const PISTES = W.corridors.filter((c) => c[5] !== 2 && Math.hypot(c[2] - c[0], c[3] - c[1]) >= 5 && inBox(c[0], c[1], 300));
const pisteDist = (x, z) => { let d = 1e9; for (const c of PISTES) d = Math.min(d, sDist(x, z, [[c[0], c[1]], [c[2], c[3]]]) - c[4]); return d; };
const LEGS = (T.net.busLegs || []).map((r) => { const X = fa(r.X), Z = fa(r.Z); return Array.from(X, (x, i) => [x, Z[i]]); });
const ALLROADS = [...roads, ...LEGS];
const roadDist = (x, z) => { let d = 1e9; for (const pts of ALLROADS) if (pts.length && pts.some(([a, b]) => Math.abs(a - x) < 80 && Math.abs(b - z) < 80)) d = Math.min(d, sDist(x, z, pts)); return d; };
const LOTS = T.net.lots.map((L) => { const m = moveOf(L.x, L.z); if (!m) return L; const [x, z] = movePt(m, L.x, L.z), c = Math.cos(m.rot), sn = Math.sin(m.rot); return { ...L, x, z, ux: L.ux * c + L.uz * sn, uz: -L.ux * sn + L.uz * c, vx: L.vx * c + L.vz * sn, vz: -L.vx * sn + L.vz * c }; });
const inLot = (x, z, m) => LOTS.some((L) => { const dx = x - L.x, dz = z - L.z; return Math.abs(dx * L.ux + dz * L.uz) < L.hw + m && Math.abs(dx * L.vx + dz * L.vz) < L.hd + m; });
const LIFTS = R.lifts.filter((L) => inBox(L.bottom[0], L.bottom[2], 60) || inBox(L.top[0], L.top[2], 60));
const liftClear = (x, z, m) => {
  for (const L of LIFTS) for (const [e, u0] of [[L.bottom, 0], [L.top, L.L]]) {
    const dx = x - L.bottom[0], dz = z - L.bottom[2], u = dx * L.dir[0] + dz * L.dir[1], lat = -dx * L.dir[1] + dz * L.dir[0];
    if (Math.abs(u - u0) < L.cfg.stationSize / 2 + 8 + m && Math.abs(lat) < L.cfg.stationSize / 2 + 4 + m) return false;
    // (the cables low over the village: the first 250 m)
    if (u > 0 && u < 250 && Math.abs(lat) < L.cfg.side + 4 + m) return false;
    void e;
  }
  return true;
};
const fpSamples = (x, z, yaw, hw, hd) => { const o = [], c = Math.cos(yaw), s = Math.sin(yaw), nu = Math.max(1, Math.ceil(hw)), nv = Math.max(1, Math.ceil(hd)); for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const lx = -hw + 2 * hw * i / nu, lz = -hd + 2 * hd * j / nv; o.push([x + lx * c + lz * s, z - lx * s + lz * c]); } return o; };
const inRect = (b, x, z, m) => { const c = Math.cos(b.yaw), sn = Math.sin(b.yaw), dx = x - b.x, dz = z - b.z; return Math.abs(dx * c - dz * sn) < b.w / 2 + m && Math.abs(dx * sn + dz * c) < b.d / 2 + m; };
/** why a building's footprint at (x, z) is not clear ('' when it is) */
function buildingBlocked(p, x, z) {
  const pts = fpSamples(x, z, p.yaw, p.w / 2, p.d / 2), church = p.id === 'church';
  for (const [a, b] of pts) {
    if (railDist(a, b) < 1.42 + 4.5 + 0.3) return 'rail';
    if (pisteDist(a, b) < 0.5) return 'piste';
    if (roadDist(a, b) < 3.4 + 3.5 + 0.3) return 'road';
    if (inLot(a, b, 2.3)) return 'car park';
    if (!liftClear(a, b, 1)) return 'lift';
    for (const st of streets) if (st.walk && sDist(a, b, st.pts) < st.w / 2 + 1.0) return `street ${st.name}`;
    for (const o of buildings) if (inRect(o, a, b, 1.5)) return `building ${o.name}`;
    for (const m of MOVES) if (Math.hypot(a - m.to[0], b - m.to[1]) < m.r + 1.5) return `site ${m.name}`;
    if (!church && distPoly(a, b, KNOLL.poly) < 3) return 'knoll';
  }
  // a terrace each: every corner on the same band, 2.5 m clear of its walls
  if (inPoly(x, z, OBERDORF) || pts.some(([a, b]) => inPoly(a, b, OBERDORF))) {
    const us = pts.map(([a, b]) => U(a, b)), lo = Math.min(...us), hi = Math.max(...us);
    const edges = [-1e9, ...BANDS, 1e9];
    if (!edges.some((e, k) => k + 1 < edges.length && lo >= e + 2.5 && hi <= edges[k + 1] - 2.5)) return 'terrace wall';
  }
  return '';
}
let nSettled = 0;
for (const p of PENDING) {
  let best = null;
  const why0 = p.o.settle === false ? '' : buildingBlocked(p, p.x, p.z);
  if (!why0) best = [p.x, p.z];
  for (let r = 1; r <= 16 && !best; r += 1) for (let a = 0; a < 24 && !best; a++) {
    const x = p.x + Math.cos(a * PI / 12) * r, z = p.z + Math.sin(a * PI / 12) * r;
    if (!buildingBlocked(p, x, z)) best = [x, z];
  }
  if (!best) { log(`SETTLE ${p.o.name || p.id} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}): ${why0}, no clear spot within 16 m: left`); best = [p.x, p.z]; }
  else if (why0) { log(`SETTLE ${p.o.name || p.id}: ${why0} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) -> (${best[0].toFixed(1)}, ${best[1].toFixed(1)})`); nSettled++; }
  emitBuilding(p.id, best[0], best[1], p.yaw, p.w, p.o);
}
log(`buildings settled: ${nSettled} moved clear`);

// ---------------------------------------------------------------- the relief grid
const STEP = 2;
const G = { x0: BOX.x0, z0: BOX.z0, nx: Math.round((BOX.x1 - BOX.x0) / STEP) + 1, nz: Math.round((BOX.z1 - BOX.z0) / STEP) + 1 };
const NC = G.nx * G.nz;
const target = new Float32Array(NC), base = new Float32Array(NC), fade = new Float32Array(NC), dist = new Float32Array(NC).fill(1e9);
for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nx; i++) {
  const x = G.x0 + i * STEP, z = G.z0 + j * STEP, k = j * G.nx + i;
  const g = h0(x, z);
  base[k] = g;
  // the Oberdorf's terraces; beyond its outline they fade into the hillside over 50 m (its east and south edges are
  // walls: the square and the Silberhorn side stay level)
  const dOb = distPoly(x, z, OBERDORF);
  const lv = bandLevel(U(x, z));
  let t = g, f = 0;
  if (lv > 0) { f = 1 - sstep(0, 50, dOb); t = Math.max(g, lv); }   // (raised onto the hill, never cut into it)
  if (inPoly(x, z, KNOLL.poly)) { t = Math.max(g, KNOLL.level); f = 1; }
  target[k] = t; fade[k] = f;
}
// the kept things: distance from each grid point to the nearest kept thing's reach (chamfer from the marked cells)
for (const [x, z, r] of keptPts) {
  const i0 = Math.floor((x - r - G.x0) / STEP), i1 = Math.ceil((x + r - G.x0) / STEP), j0 = Math.floor((z - r - G.z0) / STEP), j1 = Math.ceil((z + r - G.z0) / STEP);
  for (let j = Math.max(0, j0); j <= Math.min(G.nz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(G.nx - 1, i1); i++) {
    const d = Math.hypot(G.x0 + i * STEP - x, G.z0 + j * STEP - z) - r;
    const k = j * G.nx + i;
    if (d < dist[k]) dist[k] = Math.max(0, d);
  }
}
{ // chamfer the rest
  const D = dist, nx = G.nx, nz = G.nz, a = STEP, b = STEP * Math.SQRT2;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; let v = D[k];
    if (i) v = Math.min(v, D[k - 1] + a);
    if (j) { v = Math.min(v, D[k - nx] + a); if (i) v = Math.min(v, D[k - nx - 1] + b); if (i < nx - 1) v = Math.min(v, D[k - nx + 1] + b); }
    D[k] = v;
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; let v = D[k];
    if (i < nx - 1) v = Math.min(v, D[k + 1] + a);
    if (j < nz - 1) { v = Math.min(v, D[k + nx] + a); if (i < nx - 1) v = Math.min(v, D[k + nx + 1] + b); if (i) v = Math.min(v, D[k + nx - 1] + b); }
    D[k] = v;
  }
}
const relief = new Float32Array(NC);
for (let k = 0; k < NC; k++) relief[k] = (target[k] - base[k]) * fade[k] * sstep(0, 8, dist[k]);
// The terraces are sharp (a 2 m step under a retaining wall) only where the village is: round its buildings and
// streets. Away from them the steps soften into snow-covered banks (the relief blurred over ~16 m): a hillside, not a
// staircase of walls across empty fields.
const nearVillage = (x, z) => {
  let d = 1e9;
  for (const b of buildings) d = Math.min(d, Math.hypot(x - b.x, z - b.z) - Math.max(b.w, b.d) * 0.5);
  for (const st of streets) for (let q = 1; q < st.pts.length; q++) {
    const [ax, az] = st.pts[q - 1], [bx, bz] = st.pts[q], ex = bx - ax, ez = bz - az;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
    d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z) - st.w * 0.5);
  }
  return 1 - sstep(12, 24, d);
};
{
  const blur = (src) => {   // separable box blur, radius 4 cells, twice
    let a = Float32Array.from(src), b = new Float32Array(NC);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nx; i++) { let sum = 0, n = 0; for (let o = -4; o <= 4; o++) { const ii = i + o; if (ii >= 0 && ii < G.nx) { sum += a[j * G.nx + ii]; n++; } } b[j * G.nx + i] = sum / n; }
      for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nx; i++) { let sum = 0, n = 0; for (let o = -4; o <= 4; o++) { const jj = j + o; if (jj >= 0 && jj < G.nz) { sum += b[jj * G.nx + i]; n++; } } a[j * G.nx + i] = sum / n; }
    }
    return a;
  };
  const soft = blur(relief);
  for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nx; i++) {
    const k = j * G.nx + i, w = nearVillage(G.x0 + i * STEP, G.z0 + j * STEP);
    relief[k] = lerp(soft[k], relief[k], w) * sstep(0, 8, dist[k]);
  }
}
// the streets with their own levels: the street's profile within its width, blended into the terraces over 4 m
const ground = (k) => base[k] + relief[k];
for (const s of streets) {
  if (!s.relief) continue;
  const pts = s.pts;
  const hw = s.w / 2 + 0.5, sh = s.name === 'Kirchstiege' ? 1.5 : 4;
  const i0 = Math.floor((Math.min(...pts.map((p) => p[0])) - hw - sh - G.x0) / STEP), i1 = Math.ceil((Math.max(...pts.map((p) => p[0])) + hw + sh - G.x0) / STEP);
  const j0 = Math.floor((Math.min(...pts.map((p) => p[1])) - hw - sh - G.z0) / STEP), j1 = Math.ceil((Math.max(...pts.map((p) => p[1])) + hw + sh - G.z0) / STEP);
  for (let j = Math.max(0, j0); j <= Math.min(G.nz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(G.nx - 1, i1); i++) {
    const x = G.x0 + i * STEP, z = G.z0 + j * STEP, k = j * G.nx + i;
    let best = 1e9, y = 0;
    for (let q = 1; q < pts.length; q++) {
      const [ax, az, ay] = pts[q - 1], [bx, bz, by] = pts[q], ex = bx - ax, ez = bz - az;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
      const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
      if (d < best) { best = d; y = lerp(ay, by, t); }
    }
    if (best > hw + sh) continue;
    const w = 1 - sstep(hw, hw + sh, best);
    const want = lerp(ground(k), y, w);
    relief[k] = want - base[k];
  }
}
// the moved sites: their old ground copied under them (raised by dy), fading into the ground round them
for (const m of MOVES) {
  const R = m.r + MOVE_FADE;
  for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nx; i++) {
    const x = G.x0 + i * STEP, z = G.z0 + j * STEP, d = Math.hypot(x - m.to[0], z - m.to[1]);
    if (d > R) continue;
    const k = j * G.nx + i, [sx, sz] = unmovePt(m, x, z);
    const g0 = h0(sx, sz), want = (m.floor != null ? Math.min(g0, m.floor - 0.06) : g0) + m.dy, w = 1 - sstep(m.r, R, d);
    relief[k] = lerp(relief[k], want - base[k], w);
  }
}
// (the kept things win over the streets too)
for (let k = 0; k < NC; k++) relief[k] *= sstep(0, 8, dist[k]);
// our roads: level across (the ground's level along the middle, smoothed), blended into the ground over 4 m beyond
// the shoulders (after the moved sites: the road in front of them is the road)
for (const R of VROADS) {
  const pts = R.pts, n = pts.length, gy = (x, z) => { const fi = (x - G.x0) / STEP, fj = (z - G.z0) / STEP, i = clamp(Math.floor(fi), 0, G.nx - 2), j = clamp(Math.floor(fj), 0, G.nz - 2), tx = fi - i, tz = fj - j, v = (a, b) => base[b * G.nx + a] + relief[b * G.nx + a]; return lerp(lerp(v(i, j), v(i + 1, j), tx), lerp(v(i, j + 1), v(i + 1, j + 1), tx), tz); };
  const y0 = pts.map(([x, z]) => gy(x, z)), ys = y0.map((_, i) => { let a = 0, c = 0; for (let k = -4; k <= 4; k++) { a += y0[clamp(i + k, 0, n - 1)]; c++; } return a / c; });
  const hw = R.half + 1.6, sh = 4;
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const i0 = Math.floor((Math.min(...xs) - hw - sh - G.x0) / STEP), i1 = Math.ceil((Math.max(...xs) + hw + sh - G.x0) / STEP);
  const j0 = Math.floor((Math.min(...zs) - hw - sh - G.z0) / STEP), j1 = Math.ceil((Math.max(...zs) + hw + sh - G.z0) / STEP);
  for (let j = Math.max(0, j0); j <= Math.min(G.nz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(G.nx - 1, i1); i++) {
    const x = G.x0 + i * STEP, z = G.z0 + j * STEP, k = j * G.nx + i;
    let best = 1e9, y = 0;
    for (let q = 1; q < n; q++) {
      const [ax, az] = pts[q - 1], [bx, bz] = pts[q], ex = bx - ax, ez = bz - az;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
      const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
      if (d < best) { best = d; y = lerp(ys[q - 1], ys[q], t); }
    }
    if (best > hw + sh) continue;
    // (12 cm under the road's level within its ribbon: world/village.cpp draws it over the highest of the drawn ground)
    const w = (1 - sstep(hw, hw + sh, best)) * sstep(0, 8, dist[k]);
    relief[k] = lerp(relief[k], y - 0.12 * (1 - sstep(R.half, hw, best)) - base[k], w);
  }
}
const groundAt = (x, z) => {
  const fi = (x - G.x0) / STEP, fj = (z - G.z0) / STEP;
  const i = clamp(Math.floor(fi), 0, G.nx - 2), j = clamp(Math.floor(fj), 0, G.nz - 2), tx = fi - i, tz = fj - j;
  const v = (a, b) => base[b * G.nx + a] + relief[b * G.nx + a];
  return lerp(lerp(v(i, j), v(i + 1, j), tx), lerp(v(i, j + 1), v(i + 1, j + 1), tx), tz);
};

// ---------------------------------------------------------------- retaining walls along the terrace edges, the stair
const nearStreet = (x, z, m) => streets.some((s) => s.relief && s.pts.some((p, q) => {
  if (!q) return false;
  const [ax, az] = s.pts[q - 1], [bx, bz] = p, ex = bx - ax, ez = bz - az;
  const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
  return Math.hypot(ax + ex * t - x, az + ez * t - z) < s.w / 2 + m;
}));
const insideBuilding = (x, z, m) => buildings.some((b) => {
  const c = Math.cos(b.yaw), sn = Math.sin(b.yaw), dx = x - b.x, dz = z - b.z;
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  return Math.abs(lx) < b.w / 2 + m && Math.abs(lz) < b.d / 2 + m;
});
let nWalls = 0;
const WALL_LEN = 7.2;
const WALLS = [];   // (their footprints, for the lamps, trees and door paths)
const inWall = (x, z, m) => WALLS.some((w) => inRect(w, x, z, m));
const stepAt = (x, z, r) => { let lo = 1e9, hi = -1e9; for (const [a, b] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) { const g = groundAt(x + a, z + b); lo = Math.min(lo, g); hi = Math.max(hi, g); } return hi - lo; };
function wallsAlong(ax, az, bx, bz, nx, nz) {   // n: toward the upper side
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / WALL_LEN));
  const len = L / n, yaw = facing(-nx, -nz);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const lo = groundAt(x - nx * 3, z - nz * 3), hi = groundAt(x + nx * 3, z + nz * 3), dh = hi - lo;
    if (dh < 0.9 || nearStreet(x, z, 2.5) || insideBuilding(x, z, 1) || nearVillage(x, z) < 0.85) continue;
    // (Nov 2026 audit: its ends too, against every footpath and house: a wall poked into the lanes and paths)
    const ends = [[x - (bx - ax) / L * len * 0.5, z - (bz - az) / L * len * 0.5], [x + (bx - ax) / L * len * 0.5, z + (bz - az) / L * len * 0.5], [x, z]];
    if (ends.some(([ex, ez]) => insideBuilding(ex, ez, 1.5) || streets.some((st) => st.walk && sDist(ex, ez, st.pts) < st.w / 2 + 2.0))) continue;
    WALLS.push({ x, z, yaw, w: len, d: 2.6 });
    // the wall stands over the 2 m slope between the levels: 2.6 m thick, its top 0.35 m over the upper level
    const H = dh + 0.35 + 0.4;
    props.push({ m: 'village/retaining_wall', x: r3(x), z: r3(z), yaw: r3(yaw), s: [r3(len / 1.899 * 1.04), r3(H / 0.666), r3(2.6 / 0.615)],
      ground: 'min', sink: 0.4, glow: 0, col: { k: 0.5, top: 'max', topAdd: 0.35 }, shadow: true });
    // its snow cap (the Meshy drift along its top: from above a white edge, not a dark band)
    props.push({ m: 'snow/drift_long', x: r3(x), z: r3(z), yaw: r3(yaw), s: [r3(len * 1.03 / 1.898), r3(0.42 / 0.162), r3(2.9 / 0.5)],
      ground: 'max', sink: -0.22, glow: 0, col: null, shadow: true });
    nWalls++;
  }
}
// the bands' edges (u = const lines) within the Oberdorf, and the knoll's west face
{
  const dir = [0.8, -0.6], nrm = [-0.6, -0.8];   // along the contour / up the hill
  for (const u of BANDS) {
    // the line u = const: points p = p0 + dir * t with p0 = nrm * u
    const p0 = [nrm[0] * u, nrm[1] * u];
    let run = null;
    for (let t = -260; t <= 260; t += 2) {
      const x = p0[0] + dir[0] * t, z = p0[1] + dir[1] * t;
      const ok = inPoly(x, z, OBERDORF) && distPoly(x, z, OBERDORF) === 0;
      if (ok && !run) run = [x, z];
      if ((!ok || t >= 260) && run) { const ex = x - dir[0] * 2, ez = z - dir[1] * 2; if (Math.hypot(ex - run[0], ez - run[1]) > 4) wallsAlong(run[0], run[1], ex, ez, nrm[0], nrm[1]); run = null; }
    }
  }
  const K = KNOLL.poly;
  wallsAlong(K[3][0] - 2, K[3][1], K[0][0] - 2, K[0][1], 1, 0);   // west face (the square side)
  wallsAlong(K[0][0], K[0][1] - 2, K[1][0], K[1][1] - 2, 0, 1);   // north face
  wallsAlong(K[2][0], K[2][1] + 2, K[3][0], K[3][1] + 2, 0, -1);  // south face
  wallsAlong(K[1][0] + 2, K[1][1], K[2][0] + 2, K[2][1], -1, 0);  // east face
}
// the church stair: the Meshy stone stair set into the knoll's west wall (it climbs toward its own -z)
prop('village/stone_stairs', 41, -8, facing(-1, 0), { s: [STAIR_W / 1.730, (KNOLL.level + 0.3) / 1.735, 8 / 1.899], sink: 0.15, ground: 'min', col: null });
log(`${nWalls} retaining wall sections`);

// ---------------------------------------------------------------- street furniture
// lamp posts along the streets (alternating sides, at the paving's edge), trees in the gaps, benches, the fountain
let nLamps = 0;
// (Nov 2026 audit: not in a house or a wall, not on another footpath, not on a step, not on a piste, a road or a
// railway; false: left out)
const lampOk = (x, z) => !insideBuilding(x, z, 0.8) && !inWall(x, z, 0.6) && stepAt(x, z, 0.8) < 0.5 && pisteDist(x, z) > 0.5 &&
  roadDist(x, z) > 3.4 + 1.8 && railDist(x, z) > 1.42 + 2.2 && !inLot(x, z, 0.3) && !streets.some((st) => st.walk && sDist(x, z, st.pts) < st.w / 2 + 0.95);
const lampAt = (x, z, yaw) => { if (!lampOk(x, z)) return; prop('lamp_post', x, z, yaw, { h: 3.6, sink: 0.05, glow: 6, col: { r: 0.25, brk: 27.7778, lamp: 1 }, lamp: true }); nLamps++; };
for (const s of streets) {
  if (!s.lamps) continue;
  let acc = s.lamps * 0.5, side = 1;
  for (let q = 1; q < s.pts.length; q++) {
    const [ax, az] = s.pts[q - 1], [bx, bz] = s.pts[q], L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let t = acc; t < L; t += s.lamps) {
      const off = s.w / 2 + 1.0, x = ax + dx * t - dz * off * side, z = az + dz * t + dx * off * side;
      side = -side;
      if (insideBuilding(x, z, 0.8)) continue;
      lampAt(x, z, facing(dz * side, -dx * side));
    }
    acc = (acc - L) % s.lamps; if (acc < 0) acc += s.lamps;
  }
}
// our roads: lamps on both sides by turns every 26 m, 1.3 m beyond the ribbon (not in front of a moved site's yard,
// not where an exported road lies: its own lamps); the plough's snow banks along the edges (the kerbs)
const nearOldRoad = (x, z, d) => { for (let r = 0; r < exportedRoads; r++) for (const [a, b] of roads[r]) if (Math.hypot(a - x, b - z) < d) return true; return false; };
const inYard = (x, z) => MOVES.some((m) => m.clip && Math.hypot(x - m.to[0], z - m.to[1]) < m.r - 4);
let nRoadLamps = 0, nRoadBanks = 0;
for (const R of VROADS) {
  const pts = R.pts;
  let acc = 13, side = 1, bankAcc = 5, bankN = 0;
  for (let q = 1; q < pts.length; q++) {
    const [ax, az] = pts[q - 1], [bx, bz] = pts[q], L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let t = acc; t < L; t += 26) {
      const off = R.half + 2.4, x = ax + dx * t - dz * off * side, z = az + dz * t + dx * off * side;
      side = -side;
      if (insideBuilding(x, z, 0.8) || nearOldRoad(x, z, R.half + 4) || inYard(x, z)) continue;
      lampAt(x, z, facing(dz * side, -dx * side)); nRoadLamps++;
    }
    acc = (acc - L) % 26; if (acc < 0) acc += 26;
    for (let t = bankAcc; t < L; t += 9) {
      for (const sd of [1, -1]) {
        const off = R.half + 3.2, x = ax + dx * t - dz * off * sd, z = az + dz * t + dx * off * sd;
        if (insideBuilding(x, z, 1.2) || nearOldRoad(x, z, R.half + 5) || inYard(x, z) || (++bankN % 3 === 0)) continue;
        prop('snow/drift_long', x, z, facing(dx, dz) + PI / 2, { s: [3.2 / 1.898, 0.45 / 0.162, 1.0 / 0.5], sink: 0.12, ground: 'center', col: null, shadow: false });
        nRoadBanks++;
      }
    }
    bankAcc = (bankAcc - L) % 9; if (bankAcc < 0) bankAcc += 9;
  }
}
log(`our roads: ${nRoadLamps} lamps, ${nRoadBanks} snow banks`);
// the square's corners and the bus terminus get their lamps too
for (const [x, z] of [[-21, 21], [22, 22], [-20, -34], [24, -34], [10, 40]]) lampAt(x, z, 0);
log(`${nLamps} lamp posts`);
const spot = (x, z, r) => { const ok = (a, b) => !insideBuilding(a, b, r + 0.8) && !inWall(a, b, r + 0.5) && stepAt(a, b, r) < 0.5 && roadDist(a, b) > 3.4 + r + 0.8 && !streets.some((st) => st.walk && sDist(a, b, st.pts) < st.w / 2 + r + 0.3); if (ok(x, z)) return [x, z]; for (let rr = 1; rr <= 12; rr++) for (let a = 0; a < 16; a++) { const tx = x + Math.cos(a * PI / 8) * rr, tz = z + Math.sin(a * PI / 8) * rr; if (ok(tx, tz)) { log(`spot (${x}, ${z}) -> (${tx.toFixed(1)}, ${tz.toFixed(1)})`); return [tx, tz]; } } log(`spot (${x}, ${z}): none clear`); return [x, z]; };
prop('village/fountain', -14, 14, 0.3, { w: 4.2, sink: 0.1, col: { r: 2.1 } });
prop('village/fountain', ...spot(-147, -89, 1.8), 0.8, { w: 3.2, sink: 0.1, col: { r: 1.6 } });
prop('village/bus_shelter', -54, 92, facing(1, 0), { w: 5, col: { k: 0.45 } });
prop('village/bus_shelter', 30, 50, facing(0, 1), { w: 5, col: { k: 0.45 } });
// trees between the buildings (the game's own pine), benches by the fountain
const TREES = [[-48, 22], [-50, -6], [-48, 56], [-12, 60], [36, 64], [86, 46], [90, 28], [96, 62], [-20, 96], [6, 92], [36, 88], [60, 120],
  [-60, -60], [-96, -46], [-74, -100], [-112, -60], [-138, -64], [-120, -110], [-150, -84], [-96, -126], [-48, -106], [-160, 6], [-136, 6],
  [110, -60], [88, -120], [118, -104], [-48, 100], [-46, 128], [-12, 120], [78, -36]];
// (round 3) no tree on a road, a car park, a yard or a footpath: each checked against all of them and moved off to the
// nearest clear spot within 14 m (else left out)
const segDist = (x, z, pts) => { let d = 1e9; for (let q = 1; q < pts.length; q++) { const [ax, az] = pts[q - 1], [bx, bz] = pts[q], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1, t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1); d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z)); } return d; };
const lotsNow = T.net.lots.map((L) => { const m = moveOf(L.x, L.z); if (!m) return L; const [x, z] = movePt(m, L.x, L.z), c = Math.cos(m.rot), sn = Math.sin(m.rot); return { ...L, x, z, ux: L.ux * c + L.uz * sn, uz: -L.ux * sn + L.uz * c, vx: L.vx * c + L.vz * sn, vz: -L.vx * sn + L.vz * c }; });
const treeClear = (x, z, trunk = 1.2) => {
  if (insideBuilding(x, z, 3)) return false;
  for (const pts of roads) if (pts.length && Math.abs(pts[0][0] - x) + Math.abs(pts[0][1] - z) < 6000 && segDist(x, z, pts) < 3.4 + 2.5 + trunk) return false;
  for (const L of lotsNow) { const dx = x - L.x, dz = z - L.z; if (Math.abs(dx * L.ux + dz * L.uz) < L.hw + trunk + 1 && Math.abs(dx * L.vx + dz * L.vz) < L.hd + trunk + 1) return false; }
  for (const m of MOVES) if (Math.hypot(x - m.to[0], z - m.to[1]) < m.r) return false;
  for (const st of streets) if (st.walk && segDist(x, z, st.pts) < st.w / 2 + trunk + 0.6) return false;
  // (Nov 2026 audit: the bus legs, the railways (the crown clear of the trains), the pistes, the lifts, the walls, steps)
  for (const pts of LEGS) if (pts.length && segDist(x, z, pts) < 3.4 + 2.5 + trunk) return false;
  if (railDist(x, z) < 1.42 + 3.5 + 0.6 || pisteDist(x, z) < 0.5 || !liftClear(x, z, 0) || inWall(x, z, 1.5) || stepAt(x, z, 1.2) > 0.6) return false;
  return true;
};
let treesMoved = 0, treesOut = 0;
for (let [x, z] of TREES) {
  if (!treeClear(x, z)) {
    let found = null;
    for (let rr = 2; rr <= 14 && !found; rr += 2) for (let a = 0; a < 16 && !found; a++) { const tx = x + Math.cos(a * PI / 8) * rr, tz = z + Math.sin(a * PI / 8) * rr; if (treeClear(tx, tz)) found = [tx, tz]; }
    if (!found) { log(`tree at ${x}, ${z}: on a road / path / yard, no clear spot near: left out`); treesOut++; continue; }
    log(`tree at ${x}, ${z}: on a road / path / yard: moved to ${found[0].toFixed(1)}, ${found[1].toFixed(1)}`);
    [x, z] = found; treesMoved++;
  }
  const k = (Math.abs(Math.sin(x * 12.9898 + z * 78.233)) * 43758.5453) % 1;
  prop(k < 0.5 ? 'pine_tree' : 'pine_tree2', x, z, k * 6.28, { h: 9 + k * 6, sink: 0.3, col: { r: 0.45 } });
}
log(`trees: ${TREES.length}, ${treesMoved} moved off a road / path / yard, ${treesOut} left out`);
for (const [x, z, yaw] of [[-18.5, 12, E], [-9.5, 16, Wt], [-30.3, -2, E], [-80, -24, SE], [-140, -100, SE], [50, 25.5, N], [-30, 60, E]])
  prop('wooden_bench', ...spot(x, z, 1.1), yaw, { w: 1.9, sink: 0.02, col: { k: 0.4 } });
// snow banks: the plough's heaps at the streets' corners and along the Adlerhornweg / Silberhornweg
let nSnow = 0;
for (const s of streets) {
  if (!s.pave || s.name === 'ring') continue;
  for (let q = 1; q < s.pts.length; q++) {
    const [ax, az] = s.pts[q - 1], [bx, bz] = s.pts[q], L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let t = 3; t < L - 3; t += 11) {
      const side = ((q + Math.round(t)) % 2) ? 1 : -1, off = s.w / 2 + 1.3;
      const x = ax + dx * t - dz * off * side, z = az + dz * t + dx * off * side;
      if (insideBuilding(x, z, 1.2) || inPoly(x, z, [[-24, -38], [40, -38], [40, 24], [-24, 24]])) continue;
      prop('snow/drift_long', x, z, facing(dx, dz) + PI / 2, { s: [3.6 / 1.898, 0.55 / 0.162, 1.1 / 0.5], sink: 0.12, ground: 'center', col: null, shadow: false });
      nSnow++;
    }
  }
}
log(`${nSnow} snow banks`);

// ---------------------------------------------------------------- checks: overlaps, roads, lifts, kept things
let bad = 0;
const corners = (b, m = 0) => {
  const c = Math.cos(b.yaw), sn = Math.sin(b.yaw), out = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const lx = u * (b.w / 2 + m), lz = v * (b.d / 2 + m);
    out.push([b.x + lx * c + lz * sn, b.z - lx * sn + lz * c]);
  }
  return out;
};
for (const b of buildings) {
  for (const o of buildings) if (o !== b && corners(b).some(([x, z]) => insideBuilding.call(null, x, z, 0) && (() => { const c = Math.cos(o.yaw), s = Math.sin(o.yaw), dx = x - o.x, dz = z - o.z; return Math.abs(dx * c - dz * s) < o.w / 2 && Math.abs(dx * s + dz * c) < o.d / 2; })())) { log(`OVERLAP ${b.name} / ${o.name}`); bad++; }
  let dRoad = 1e9;
  for (const pts of roads) for (const [x, z] of pts) for (const [cx, cz] of corners(b)) dRoad = Math.min(dRoad, Math.hypot(x - cx, z - cz));
  if (dRoad < 7) { log(`NEAR ROAD ${b.name}: ${dRoad.toFixed(1)} m`); bad++; }
  const hs = corners(b).map(([x, z]) => groundAt(x, z)), dh = Math.max(...hs) - Math.min(...hs);
  if (dh > 1.2) { log(`UNEVEN ${b.name} at (${b.x.toFixed(0)}, ${b.z.toFixed(0)}) u ${U(b.x, b.z).toFixed(0)}: ${dh.toFixed(2)} m across its footprint: ${hs.map((v) => v.toFixed(1)).join(' ')}`); }
  b.y = Math.min(...hs);
  let kept = 1e9;
  for (const [x, z, r] of keptPts) if (r < 13) for (const [cx, cz] of corners(b)) kept = Math.min(kept, Math.hypot(x - cx, z - cz) - (r - 3));
  if (kept < 0.5) log(`(near a kept thing: ${b.name}, ${kept.toFixed(1)} m)`);
}
log(`${buildings.length} buildings, ${bad} problems`);

// ---------------------------------------------------------------- the walking network
const nodes = [], edges = [];
const nodeAt = (x, z) => {
  for (let i = 0; i < nodes.length; i++) if (Math.hypot(nodes[i][0] - x, nodes[i][1] - z) < 2.5) return i;
  nodes.push([r3(x), r3(z)]); return nodes.length - 1;
};
for (const s of streets) {
  if (!s.walk) continue;
  let prev = -1;
  for (let q = 0; q < s.pts.length; q++) {
    if (q) {   // in-between nodes every ~14 m
      const [ax, az] = s.pts[q - 1], [bx, bz] = s.pts[q], L = Math.hypot(bx - ax, bz - az), n = Math.floor(L / 14);
      for (let k = 1; k <= n; k++) { const t = k / (n + 1), id = nodeAt(ax + (bx - ax) * t, az + (bz - az) * t); if (prev >= 0 && prev !== id) edges.push([prev, id]); prev = id; }
    }
    const id = nodeAt(s.pts[q][0], s.pts[q][1]);
    if (prev >= 0 && prev !== id) edges.push([prev, id]);
    prev = id;
  }
}
// the ring's joins with the streets that end on the square: nearest ring node
const ringIds = ring.map(([x, z]) => nodeAt(x, z));
const joinNearest = (x, z, ids) => { const a = nodeAt(x, z); let best = -1, bd = 1e9; for (const i of ids) { const d = Math.hypot(nodes[i][0] - x, nodes[i][1] - z); if (i !== a && d < bd) { bd = d; best = i; } } if (best >= 0) edges.push([a, best]); };
for (const [x, z] of [[0, 11], [0, -19], [14, 1], [12, 12], [-28, -10], [-25, 4], [-26, -26], [14, -40]]) joinNearest(x, z, ringIds);
// every door: to its nearest street node
const streetIds = nodes.map((_, i) => i);
// (Nov 2026 audit: the nearest node, but by a way that does not cut through a house or a wall; and that way paved, from
// the step in front of the door: a path to every door)
const doorPaths = [];
const clearWay = (ax, az, bx, bz, self) => { const L = Math.hypot(bx - ax, bz - az); for (let t = 0; t <= L; t += 0.5) { const x = ax + (bx - ax) * t / L, z = az + (bz - az) * t / L; if (buildings.some((o) => inRect(o, x, z, 1.0)) || inWall(x, z, 1.0) || roadDist(x, z) < 3.4 + 1.2 || stepAt(x, z, 0.5) > 0.6 || SMALL.some((p) => Math.hypot(p.x - x, p.z - z) < 1.8)) return false; } return true; };
const SMALL = props.filter((p) => /lamp|pine|bench|fountain|shelter/.test(p.m));
for (const b of buildings) {
  const [x, z] = b.door.out, [fx, fz] = front(b.yaw), sx = b.x + fx * (b.d / 2 + 0.6), sz = b.z + fz * (b.d / 2 + 0.6);
  const a = nodeAt(x, z);
  const order = streetIds.filter((i) => i !== a).sort((i, k) => Math.hypot(nodes[i][0] - x, nodes[i][1] - z) - Math.hypot(nodes[k][0] - x, nodes[k][1] - z));
  const found = order.slice(0, 40).find((i) => Math.hypot(nodes[i][0] - x, nodes[i][1] - z) < 30 && clearWay(x, z, nodes[i][0], nodes[i][1], b));
  if (found === undefined) log(`DOOR ${b.name}: no clear way to a street within 30 m`);
  const loose = (i) => { const [bx, bz] = nodes[i], L = Math.hypot(bx - x, bz - z); for (let t = 0; t <= L; t += 0.5) { const px = x + (bx - x) * t / L, pz = z + (bz - z) * t / L; if (buildings.some((o) => inRect(o, px, pz, 0.6)) || inWall(px, pz, 0.6)) return false; } return true; };
  const to = found ?? order.find(loose) ?? order[0];
  edges.push([a, to]);
  const [tx, tz] = nodes[to];
  if (found === undefined && roadDist(x, z) < 9) doorPaths.push({ name: `door ${b.name}`, w: 2, pts: [[r3(sx), r3(sz)], [r3(x), r3(z)]] });
  if (found !== undefined && Math.hypot(tx - sx, tz - sz) > 2) doorPaths.push({ name: `door ${b.name}`, w: 2, pts: [[r3(sx), r3(sz)], [r3(x), r3(z)], [r3(tx), r3(tz)]] });
}
// the places the people use that stay (the shop's door, the gondolas' exits, the bus stop's waiting area)
for (const [x, z] of [[-33.3, -16.7], [0, -53], [85.5, 7.8], [-58.6, 82.2], [9.6, 57.1], [13.3, -22.5], [8, -21.6], movePt(HELI, 75.64, -132.48)]) joinNearest(x, z, streetIds);
log(`walking network: ${nodes.length} nodes, ${edges.length} edges`);

// ---------------------------------------------------------------- a quick audit (the full one: the game's
// SKI_LEGACY_DEBUG=villagecheck, game/villagecheck.h): the railways' open stretches, the pistes, the lifts' stations and
// towers and the exported roads / car parks against every piece's footprint
{
  const RS = R, lines = [];
  for (const k of ['rail', 'express']) {
    const r = T.net[k], X = fa(r.X), Z = fa(r.Z), pts = [];
    for (let i = 0; i < X.length; i++) if (inBox(X[i], Z[i], 60) && !r.tunnels.some((t) => i * r.step > t.s0 + 25 && i * r.step < t.s1 - 25)) pts.push([X[i], Z[i]]);
    lines.push({ k, pts, off: k === 'express' ? r.trackOff : 0 });
  }
  const segs = W.corridors.filter((c) => c[5] !== 2 && Math.hypot(c[2] - c[0], c[3] - c[1]) >= 5 && inBox(c[0], c[1], 300));
  const stations = [];
  for (const L of RS.lifts) for (const e of [L.bottom, L.top]) if (inBox(e[0], e[2], 50)) stations.push([e[0], e[2], L.cfg.stationSize / 2 + 4, L.name]);
  const items = [];
  for (const b of buildings) items.push({ kind: 'building', name: b.name, x: b.x, z: b.z, yaw: b.yaw, hw: b.w / 2, hd: b.d / 2 });
  for (const p of props) {
    const id = p.m.replace('village/', ''), S = MODELS[id] || OTHER[p.m];
    if (!S || /drift|heap/.test(p.m) || MODELS[id] && !/retaining|fountain|shelter|stairs/.test(id)) continue;
    items.push({ kind: /retaining/.test(id) ? 'wall' : /lamp/.test(id) ? 'lamp' : /pine/.test(id) ? 'tree' : 'furniture', name: `${id} @${p.x.toFixed(0)},${p.z.toFixed(0)}`, x: p.x, z: p.z, yaw: p.yaw, hw: /pine/.test(id) ? 0.6 : S[0] * p.s[0] / 2, hd: /pine/.test(id) ? 0.6 : S[2] * p.s[2] / 2 });
  }
  const samp = (it) => { const o = [], c = Math.cos(it.yaw), s = Math.sin(it.yaw), nu = Math.max(1, Math.ceil(it.hw * 2)), nv = Math.max(1, Math.ceil(it.hd * 2)); for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const lx = -it.hw + 2 * it.hw * i / nu, lz = -it.hd + 2 * it.hd * j / nv; o.push([it.x + lx * c + lz * s, it.z - lx * s + lz * c]); } return o; };
  const cnt = {};
  const flag = (cat, it, why) => { cnt[cat] = (cnt[cat] || 0) + 1; log(`AUDIT ${cat} ${it.kind} ${it.name} (${it.x.toFixed(1)}, ${it.z.toFixed(1)}): ${why}`); };
  for (const it of items) {
    const S = samp(it), big = it.kind === 'building';
    for (const L of lines) {
      const need = 1.42 + L.off + (big ? 4.5 : it.kind === 'tree' ? 3.5 : 2.0);
      let d = 1e9; for (const [x, z] of S) for (const [a, b] of L.pts) if (Math.abs(a - x) < 30 && Math.abs(b - z) < 30) d = Math.min(d, Math.hypot(a - x, b - z));
      if (d < need) flag('rail', it, `${L.k} ${d.toFixed(1)} m from its middle (needs ${need.toFixed(1)})`);
    }
    let pd = 1e9; for (const [x, z] of S) pd = Math.min(pd, segDist(x, z, []) , ...segs.map((c) => segDist(x, z, [[c[0], c[1]], [c[2], c[3]]]) - c[4]));
    if (pd < -1) flag('piste', it, `${(-pd).toFixed(1)} m inside`);
    for (const [x, z, r, n] of stations) if (S.some(([a, b]) => Math.hypot(a - x, b - z) < r)) flag('lift', it, `at ${n}'s station`);
    const need = 3.4 + (big ? 3.5 : it.kind === 'tree' ? 2.5 : 0.8);
    let rd = 1e9; for (const [x, z] of S) for (const pts of roads) if (pts.length && Math.abs(pts[0][0] - x) + Math.abs(pts[0][1] - z) < 6000) rd = Math.min(rd, segDist(x, z, pts));
    if (rd < need) flag('road', it, `${rd.toFixed(1)} m from a road's middle`);
  }
  for (let i = 0; i < buildings.length; i++) for (let k = i + 1; k < buildings.length; k++) {
    const a = items[i], b = items[k];
    const inside = (o, x, z) => { const c = Math.cos(o.yaw), s = Math.sin(o.yaw), dx = x - o.x, dz = z - o.z; return Math.abs(dx * c - dz * s) < o.hw - 0.3 && Math.abs(dx * s + dz * c) < o.hd - 0.3; };
    if (samp(a).some(([x, z]) => inside(b, x, z)) || samp(b).some(([x, z]) => inside(a, x, z))) flag('overlap', a, `overlaps ${b.name}`);
  }
  log('AUDIT totals', JSON.stringify(cnt));
}

// ---------------------------------------------------------------- write
const bin = Buffer.alloc(NC * 2);
let maxR = 0, nz = 0;
for (let k = 0; k < NC; k++) { const v = Math.round(relief[k] * 100); bin.writeInt16LE(clamp(v, -32767, 32767), k * 2); if (v) nz++; maxR = Math.max(maxR, Math.abs(relief[k])); }
log(`relief: ${G.nx} x ${G.nz} at ${STEP} m, ${nz} cells raised / cut, max ${maxR.toFixed(2)} m`);
const out = {
  version: 1,
  generated: 'native/tools/village/village_layout.mjs',
  relief: { x0: G.x0, z0: G.z0, step: STEP, nx: G.nx, nz: G.nz, off: 0 },
  clear: { zone: VILLAGE_ZONE, keep: KEEP_ZONES, models: CLEAR_MODELS, meshMats: PATH_MAT >= 0 ? [PATH_MAT] : [], pack: 'resort' },
  pathMat: PATH_MAT,
  props,
  paths: streets.filter((s) => s.pave).map((s) => ({ name: s.name, w: s.w, pts: s.pts.map((p) => [r3(p[0]), r3(p[1])]) })).concat(doorPaths),
  places: {
    ...places,
    spawn: [4, 34, PI],
    autotestHotel: [68, 42],
    square: [0, -4, 15],
  },
  walk: { nodes, edges },
  moves: MOVES.map((m) => ({ name: m.name, from: m.from, r: m.r, to: m.to, rot: m.rot, dy: m.dy, ...(m.clip ? { clip: m.clip } : {}) })),
  roads: VROADS.map((R) => ({ name: R.name, pts: R.pts, kmh: R.kmh, half: R.half })),
  buildings: buildings.map((b) => ({ id: b.id, name: b.name, kind: b.kind, x: r3(b.x), z: r3(b.z), yaw: r3(b.yaw), w: r3(b.w), d: r3(b.d), h: r3(b.h) })),
  // (the buildings' pads: world/village.cpp levels the drawn ground under each footprint, 0.8 m round it, at the level
  // in front of its door, easing back over `fade` m: no house half buried on a slope)
  pads: buildings.map((b) => ({ x: r3(b.x), z: r3(b.z), yaw: r3(b.yaw), hw: r3(b.w / 2 + 0.8), hd: r3(b.d / 2 + 0.8), fade: 5 })),
};
if (process.argv.includes('--plan')) fs.writeFileSync(process.argv[process.argv.indexOf('--plan') + 1], JSON.stringify(out));
if (process.argv.includes("--dry")) process.exit(0);
const nj = writeData(DATA, 'village.json', JSON.stringify(out)), nb = writeData(DATA, 'village.bin', bin);
log(`wrote village.json (${(nj / 1024).toFixed(0)} KB packed), village.bin (${(nb / 1024).toFixed(0)} KB packed): ${props.length} props`);
