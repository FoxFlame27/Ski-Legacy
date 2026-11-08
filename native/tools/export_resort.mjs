// Ski Legacy native port: resort + transport exporter (Phases 2-3).
//
// Builds the resort exactly as the web game does (world/village.js, decor.js, resortdressing.js, lifts.js on the
// layout of layout.js, with secrets and piste fences planned first like main.js), in Node with real THREE but no
// renderer, then walks the built scene and writes what the C++ build needs to show the same resort:
//   data/resort.json  props: every GLB the scene places (model + model-space -> world matrix per instance, the
//                     night glow it wears), meshes: the procedural geometry nobody needs to rebuild at runtime
//                     (signs' boards and posts, the bullwheels, tower padding, haul ropes, nets, markers...) grouped
//                     per material and 256 m cell, their materials (colours, roughness, emissive, night response,
//                     canvas textures as recorded drawing commands), the lift lines (supports, cars, exits), the gondola
//                     stations' parameters (built by native/src/world/gondola_station.cpp), the colliders and the
//                     walkable surfaces (decks, stairs) sampled on a 0.25 m grid
//   data/resort.bin   the meshes' vertices / indices and the surfaces' samples
//   data/fonts/barlow-condensed-700.ttf   the signs' font (from @fontsource/barlow-condensed, WOFF -> TTF)
//
//   data/transport.json + .bin (Phase 3): the roads, car parks, road tunnels, railway and Legacy Express track and
//                     stations as built by their own modules (same capture), plus `net` (export_net.mjs): the data the
//                     C++ vehicles run on (road centre lines and speed profiles, stops, bays, timetables, vehicle fits)
//
// Usage (from the repo root):  node native/tools/export_resort.mjs      (also run by export_world.mjs)
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

register('./resort_hooks.mjs', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(HERE, '../data');
const t0 = Date.now();
const log = (...a) => console.log(`[resort ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const _warn = console.warn, _info = console.info;
console.info = () => {};
console.warn = (...a) => { if (!String(a[0]).startsWith('LOD')) _warn('[js warn]', ...a.map((x) => (x instanceof Error ? x.message : x))); };

// ---------------------------------------------------------------- the signs' font: WOFF -> TTF
function woffToTtf(w) {
  const num = w.readUInt16BE(12), flavor = w.readUInt32BE(4);
  const tables = [];
  for (let i = 0; i < num; i++) {
    const o = 44 + i * 20;
    tables.push({ tag: w.readUInt32BE(o), off: w.readUInt32BE(o + 4), comp: w.readUInt32BE(o + 8), orig: w.readUInt32BE(o + 12), sum: w.readUInt32BE(o + 16) });
  }
  const datas = tables.map((t) => { const d = w.subarray(t.off, t.off + t.comp); return t.comp < t.orig ? zlib.inflateSync(d) : Buffer.from(d); });
  let sr = 1, es = 0; while (sr * 2 <= num) { sr *= 2; es++; }
  const head = Buffer.alloc(12 + 16 * num);
  head.writeUInt32BE(flavor, 0); head.writeUInt16BE(num, 4); head.writeUInt16BE(sr * 16, 6); head.writeUInt16BE(es, 8); head.writeUInt16BE(num * 16 - sr * 16, 10);
  let at = head.length;
  const body = [];
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    head.writeUInt32BE(t.tag, o); head.writeUInt32BE(t.sum, o + 4); head.writeUInt32BE(at, o + 8); head.writeUInt32BE(datas[i].length, o + 12);
    const pad = (4 - (datas[i].length % 4)) % 4;
    body.push(datas[i], Buffer.alloc(pad)); at += datas[i].length + pad;
  });
  return Buffer.concat([head, ...body]);
}
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
// advance widths for measureText (the C++ canvas draws with the same font, so text fitted here fits there)
function ttfMetrics(t) {
  const n = t.readUInt16BE(4), tab = {};
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; tab[t.toString('latin1', o, o + 4)] = t.readUInt32BE(o + 8); }
  const upem = t.readUInt16BE(tab.head + 18), nh = t.readUInt16BE(tab.hhea + 34);
  const adv = (g) => t.readUInt16BE(tab.hmtx + 4 * Math.min(g, nh - 1));
  const cm = tab.cmap, ns = t.readUInt16BE(cm + 2);
  let sub = -1;
  for (let i = 0; i < ns; i++) { const pid = t.readUInt16BE(cm + 4 + i * 8), eid = t.readUInt16BE(cm + 6 + i * 8); if (pid === 3 && eid === 1) sub = cm + t.readUInt32BE(cm + 8 + i * 8); }
  const glyph = (c) => {
    if (sub < 0 || t.readUInt16BE(sub) !== 4) return 0;
    const seg = t.readUInt16BE(sub + 6) / 2, ends = sub + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
    for (let i = 0; i < seg; i++) {
      if (t.readUInt16BE(ends + i * 2) < c) continue;
      const st = t.readUInt16BE(starts + i * 2);
      if (st > c) return 0;
      const d = t.readInt16BE(deltas + i * 2), ro = t.readUInt16BE(ranges + i * 2);
      if (!ro) return (c + d) & 0xffff;
      const g = t.readUInt16BE(ranges + i * 2 + ro + (c - st) * 2);
      return g ? (g + d) & 0xffff : 0;
    }
    return 0;
  };
  return (str, px) => { let w = 0; for (const ch of str) w += adv(glyph(ch.codePointAt(0))); return (w / upem) * px; };
}
const measure = {};
for (const wgt of [500, 700]) {
  const f = path.join(ROOT, `node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-${wgt}-normal.woff`);
  if (!fs.existsSync(f)) continue;
  const ttf = woffToTtf(fs.readFileSync(f));
  fs.writeFileSync(path.join(OUT, `fonts/barlow-condensed-${wgt}.ttf`), ttf);
  measure[wgt] = ttfMetrics(ttf);
}


// ---------------------------------------------------------------- canvas stub: records the drawing commands
let canvasId = 0;
const canvases = new Map();
class RecGradient { constructor(kind, args) { this.kind = kind; this.args = args; this.stops = []; } addColorStop(o, c) { this.stops.push([o, c]); } }
const fontPx = (f) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(f)?.[1] || '10');
class RecCtx {
  constructor(cv) {
    this.canvas = cv; this.ops = cv.ops;
    this._s = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter', globalCompositeOperation: 'source-over', shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)', imageSmoothingEnabled: true, letterSpacing: '0px', filter: 'none', miterLimit: 10, shadowOffsetX: 0, shadowOffsetY: 0, direction: 'ltr' };
    for (const k of Object.keys(this._s)) {
      Object.defineProperty(this, k, {
        get: () => this._s[k],
        set: (v) => {
          this._s[k] = v;
          if (typeof v === 'string') v = v.replace(/(\d+\.\d{3})\d+/g, '$1');
          else if (typeof v === 'number') v = Math.round(v * 1000) / 1000;
          this.ops.push(['set', k, v instanceof RecGradient ? { g: v.kind, a: v.args, s: v.stops } : (typeof v === 'object' ? String(v) : v)]);
        },
      });
    }
  }
  measureText(t) {
    const px = fontPx(this._s.font), bold = /bold|[6-9]00/.test(this._s.font), m = measure[bold ? 700 : 500] || measure[700];
    return { width: m ? m(String(t), px) : String(t).length * px * 0.5, actualBoundingBoxAscent: px * 0.72, actualBoundingBoxDescent: px * 0.2 };
  }
  createLinearGradient(...a) { return new RecGradient('linear', a); }
  createRadialGradient(...a) { return new RecGradient('radial', a); }
  createPattern() { return '#808080'; }
  getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, _rec: [x, y] }; }
  createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData(img, x, y) {
    // (the game only writes the alpha channel this way: cobble strip edges): keep that plane
    const n = img.width * img.height, a = Buffer.alloc(n);
    for (let i = 0; i < n; i++) a[i] = img.data[i * 4 + 3];
    this.ops.push(['putAlpha', x, y, img.width, img.height, zlib.deflateSync(a).toString('base64')]);
  }
  drawImage(img, ...a) { this.ops.push(['drawImage', img?._id ?? -1, ...a]); }
  setLineDash(d) { this.ops.push(['setLineDash', d]); }
  getLineDash() { return []; }
  isPointInPath() { return false; }
}
for (const m of ['fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'resetTransform', 'transform']) {
  // (numbers kept to 1/100 px / rad: the tile textures draw tens of thousands of specks)
  RecCtx.prototype[m] = function (...a) { this.ops.push([m, ...a.map((x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : typeof x === 'object' && x !== null ? (Array.isArray(x) ? x : String(x)) : x))]); };
}
class RecCanvas {
  constructor() { this._id = canvasId++; this.ops = []; this.width = 300; this.height = 150; this.style = {}; canvases.set(this._id, this); }
  getContext() { return (this._ctx ??= new RecCtx(this)); }
  toDataURL() { return 'data:,'; }
  addEventListener() {}
}
// (a DOM stand-in: the transport's modules import UI helpers that touch the page at load)
const fakeEl = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, children: [], childNodes: [] }, {
  get: (o, k) => (k in o ? o[k] : k === 'getBoundingClientRect' ? () => ({ left: 0, top: 0, width: 0, height: 0 }) : typeof k === 'string' && /^(query|getElement)/.test(k) ? () => null : typeof k === 'string' && /^[a-z]/.test(k) ? () => fakeEl() : undefined),
  set: (o, k, v) => { o[k] = v; return true; },
});
globalThis.document = { createElement: (t) => (t === 'canvas' ? new RecCanvas() : fakeEl()), createElementNS: () => fakeEl(), body: fakeEl(), head: fakeEl(), documentElement: fakeEl(),
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createTextNode: () => fakeEl() };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.performance ??= { now: () => Date.now() };
globalThis.window ??= globalThis;
globalThis.OffscreenCanvas = class extends RecCanvas { constructor(w, h) { super(); this.width = w; this.height = h; } };
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.width = 0; this.height = 0; } set src(v) { this._src = v; } get src() { return this._src; } addEventListener() {} decode() { return Promise.resolve(); } };
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node', hardwareConcurrency: 4 };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1280; globalThis.innerHeight = 720;

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
await MeshoptDecoder.ready;

// ---------------------------------------------------------------- GLB loading (geometry + material slots only)
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
function stripTextures(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  delete json.textures; delete json.images; delete json.samplers;
  for (const m of json.materials || []) {
    const pbr = m.pbrMetallicRoughness || {};
    delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture;
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.extensions) for (const k of Object.keys(m.extensions)) delete m.extensions[k];
  }
  for (const k of ['extensionsUsed', 'extensionsRequired']) if (json[k]) json[k] = json[k].filter((e) => e !== 'EXT_texture_webp' && e !== 'KHR_texture_transform');
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (js.length % 4)) % 4;
  js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
  const rest = buf.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + js.length + rest.length, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, js, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
const glbCache = new Map();
const loadedModels = new Set();
function loadGLB(name) {
  if (!glbCache.has(name)) {
    glbCache.set(name, (async () => {
      const file = path.join(ROOT, 'public/models', name + '.glb');
      if (!fs.existsSync(file)) return null;
      try {
        const g = await new Promise((res, rej) => loader.parse(stripTextures(fs.readFileSync(file)), '', res, rej));
        g.modelName = name;
        for (const [obj, a] of g.parser.associations) if (obj?.isMaterial && a.materials !== undefined) obj.userData.slMat = { model: name, index: a.materials };
        g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        loadedModels.add(name);
        return g;
      } catch (e) { _warn('GLB', name, e.message); return null; }
    })());
  }
  return glbCache.get(name);
}
globalThis.__slLoadGLB = loadGLB;

// baked geometry: model + fit; transforms applied later keep the tag up to date
globalThis.__slTagBake = (gltf, opts, r) => {
  if (!gltf || !r.geometry) return;
  const { fitModel } = assetsMod;
  const g = fitModel(gltf, { ...opts, decimate: undefined });
  r.geometry.userData = { ...r.geometry.userData, sl: { model: gltf.modelName, fit: g.userData.slFit.fit } };
};
const _apply = THREE.BufferGeometry.prototype.applyMatrix4;
THREE.BufferGeometry.prototype.applyMatrix4 = function (m) {
  const sl = this.userData?.sl;
  if (sl) {
    const f = new THREE.Matrix4().fromArray(sl.fit).premultiply(m);
    this.userData = { ...this.userData, sl: { ...sl, fit: f.toArray() } };
  }
  return _apply.call(this, m);
};

// gondola stations: the parameters (the C++ builder makes the meshes), their own meshes left out of the capture
const stations = [];
globalThis.__slStation = (kind, o, r) => {
  const { world } = worldMod;
  r.group.userData.slSkip = true;
  const s = { kind, x: o.x, y: o.y, z: o.z, yaw: o.yaw, side: o.side, ropeY: o.ropeY, carH: o.carH, name: o.name || '', place: o.place || '' };
  if (kind === 'end') {
    s.top = !!o.top;
    // (gondolastation.js: the entrance side whose ground is nearest the station's, and free)
    const ZB = o.top ? -10.8 : -11.4, zd = ZB + 0.5 + 1.1, W2 = 6.5, cy = Math.cos(o.yaw), sy = Math.sin(o.yaw);
    const toW = (mx, x, z) => { const X = x * mx; return { x: o.x + X * cy + z * sy, z: o.z - X * sy + z * cy }; };
    const score = (mx) => { const q = toW(mx, -W2 - 1.4, zd); return Math.abs(world.height(q.x, q.z) - o.y) + (o.blocked?.(q.x, q.z) ? 20 : 0); };
    s.mx = score(1) <= score(-1) ? 1 : -1;
    s.rope = []; for (let z = 0; z <= 9; z += 0.5) s.rope.push(o.ropeAt(z).map((v) => +v.toFixed(4)));
  } else {
    s.mx = o.mx < 0 ? -1 : 1; s.up = o.up || ''; s.down = o.down || '';
    s.rope = []; for (let z = -13; z <= 13.001; z += 0.5) s.rope.push(o.ropeAt(z).map((v) => (Number.isFinite(v) ? +v.toFixed(4) : null)));
  }
  s.back = r.back ?? null; s.shaftScale = r.shaftScale ?? null;
  stations.push(s);
};


const assetsMod = await import(pathToFileURL(path.join(SRC, 'core/assets.js')));
const worldMod = await import(pathToFileURL(path.join(SRC, 'world/world.js')));
const L = await import(pathToFileURL(path.join(SRC, 'world/layout.js')));
const S = await import(pathToFileURL(path.join(SRC, 'world/secrets.js')));
const { world } = worldMod;

L.initLayout();
try { S.initSecrets(); } catch (e) { log('secrets skipped:', e.message); }
try { L.planPisteFences(); } catch (e) { log('piste fences skipped:', e.message); }
log('layout ready');
// (Phase 3) the rest of main.js's planning, in its order, before anything is built: the bus roads (their cuts, car
// parks, tunnels), the World Racing courses' regions, the Legacy Express's lakes and ground (the line fitted on the
// final ground). export_world.mjs plans the same, so the terrain data agrees.
const roadsMod = await import(pathToFileURL(path.join(SRC, 'game/bus/roads.js')));
const freeMod = await import(pathToFileURL(path.join(SRC, 'modes/parkour/freeworld.js')));
const { busRoads } = roadsMod;
try { roadsMod.planBusRoads(L.layout.busStops); log('bus roads planned:', busRoads.roads.length); } catch (e) { log('bus roads skipped:', e.message); }
try { await freeMod.registerFreeWorldCourses(); log('world racing courses registered:', world.regions.length); } catch (e) { log('courses skipped:', e.message); }
try { (await import(pathToFileURL(path.join(SRC, 'world/expressscenery.js')))).planExpressScenery(freeMod.freeCourses()); } catch (e) { log('express scenery skipped:', e.message); }
try { (await import(pathToFileURL(path.join(SRC, 'world/expressground.js')))).buildExpressGround(freeMod.freeCourses()); log('express ground built:', L.layout.express?.stations?.length, 'stations'); } catch (e) { log('express ground skipped:', e.message); }

const CAR_NAMES = ['car_bmw_x3', 'car_audi_rs6', 'car_vw_golf_gti', 'car_tesla_m3', 'car_mercedes_sls', 'car_porsche_taycan', 'car_lamborghini_huracan', 'car_toyota_gr_yaris', 'car_audi_etron_gt', 'car_mercedes_gls'];
const MODELS = ['rental_shop', 'gondola_cabin', 'chairlift_chair', 'lift_tower', 'chair_terminal', 'chair_bullwheel', 'hotel_chalet', 'mountain_hut', 'race_arch',
  'ticket_booth', 'snow_cannon', 'lamp_post', 'wooden_bench', 'outdoor_ski_rack', 'snowman', 'firewood_pile', 'wooden_fence', 'christmas_tree', 'picnic_table',
  'wooden_sled', 'deck_chair', 'map_board', 'sign_pole', 'truss_pylon', 'snowmobile', 'wooden_barrel', 'trash_bin', 'market_stall', 'fire_pit',
  'grandstand', 'timing_board', 'start_house', 'patrol_hut', 'piste/bnet_panel', 'piste/flag_pole', 'piste/rope_pole',
  // (Phase 3) the transport's own
  'rail_car2', 'floodlight_head_b', 'floodlight_head_c', 'floodlight_mast', 'parking_pay_machine', 'parking_sign', 'bus_stop_sign', 'ski_bus_micruss', ...CAR_NAMES];
const models = {};
await Promise.all(MODELS.map(async (n) => { models[n] = await loadGLB(n); }));
log('models loaded', Object.values(models).filter(Boolean).length, '/', MODELS.length);

const { Village } = await import(pathToFileURL(path.join(SRC, 'world/village.js')));
const { Lifts } = await import(pathToFileURL(path.join(SRC, 'world/lifts.js')));
const { Decor } = await import(pathToFileURL(path.join(SRC, 'world/decor.js')));
const { buildResortDressing } = await import(pathToFileURL(path.join(SRC, 'world/resortdressing.js')));

const surfAll = () => { const s = new Set(); for (const arr of world.surfaceGrid.values()) for (const q of arr) s.add(q); return s; };
// (the surfaces the secrets / layout / express ground registered before the resort is built are not the resort's)
const surfBefore = surfAll();
const scene = new THREE.Scene();
const colliders = [];
const village = new Village(scene, models, colliders, L.layout);
log('village built');
const lifts = new Lifts(scene, models, colliders, L.layout);
log('lifts built:', lifts.lines.length);
const decor = new Decor(scene, models, colliders, village);
log('decor built');
const dressing = buildResortDressing(scene, models);
colliders.push(...(dressing.userData.colliders || []));
log('resort dressing built');
void decor;

const railBuilt = new Set(); // surfaces the rail build added that are not the stations' paving
const surfBeforeRail = surfAll();
// the Wolkenspitzbahn's station buildings (stationbuildings.js: the valley station in Legacy Village, the halts, the
// glacier terminal) where railstations.js stands them: the buildings, their colliders and paving go with the resort;
// the rest of the stations (platforms, signs, lamps) with the transport
const railScene = new THREE.Group();
const railCols = [], railSurfs = new Set();
let railStations = null;
globalThis.__slRailCols = railCols;
globalThis.__slRegStation = (fn) => {
  const before = surfAll();
  const r = fn();
  for (const arr of world.surfaceGrid.values()) for (const q of arr) if (!before.has(q)) railSurfs.add(q);
  return r;
};
const railColsAll = [];
try {
  const { buildStations } = await import(pathToFileURL(path.join(SRC, 'world/railstations.js')));
  railStations = buildStations(railScene, railColsAll, models);
  log('rail stations built:', railCols.length, 'colliders');
} catch (e) { log('rail stations skipped:', e.message); }
globalThis.__slRegStation = null;
colliders.push(...railCols);
for (const arr of world.surfaceGrid.values()) for (const q of arr) if (!surfBeforeRail.has(q)) railBuilt.add(q);
railScene.updateMatrixWorld(true);
const railKeep = [];
railScene.traverse((o) => { if (o.userData?.slRail) railKeep.push(o); });
for (const o of railKeep) { const w = o.matrixWorld.clone(); o.parent?.remove(o); o.matrixAutoUpdate = false; o.matrix.copy(w); scene.add(o); }
log('rail station buildings / canopies kept:', railKeep.length);

// snow cannons: the near / far split is made per frame from the player's position: all near for the capture
{
  const C = village.cannonLod;
  if (C) { C.mats.forEach((m, i) => C.near.setMatrixAt(i, m)); C.near.count = C.mats.length; C.far.count = 0; }
}
// lift cars are animated by the C++ lifts: their (empty) instanced meshes are skipped
for (const l of lifts.lines) for (const k of ['carNear', 'carMid', 'carFar']) if (l[k]) l[k].userData.slSkip = true;

// ---------------------------------------------------------------- capture: a scene -> one data pack (json + bin)
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const m34 = (m) => { const e = m.elements; return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]].map(r4); };
const lin = (c) => (c ? [r4(c.r), r4(c.g), r4(c.b)] : [1, 1, 1]);
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();
// (a tiling canvas texture's repeat / offset baked into the uv: the C++ materials have no uv transform)
const uvXf = (mat) => { const t = mat?.map; return t && t.repeat && (t.repeat.x !== 1 || t.repeat.y !== 1 || t.offset.x || t.offset.y) ? [t.repeat.x, t.repeat.y, t.offset.x, t.offset.y] : null; };
function geoArrays(geo, M, ox, oy, oz, uvx = null) {
  const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv, C = geo.attributes.color;
  const n = P.count, pos = new Array(n * 3), nor = new Array(n * 3), uv = new Array(n * 2), col = C ? new Array(n * 3) : null;
  if (M) _nm.getNormalMatrix(M);
  for (let i = 0; i < n; i++) {
    _v.fromBufferAttribute(P, i); if (M) _v.applyMatrix4(M);
    pos[i * 3] = _v.x - ox; pos[i * 3 + 1] = _v.y - oy; pos[i * 3 + 2] = _v.z - oz;
    if (N) { _n.fromBufferAttribute(N, i); if (M) _n.applyMatrix3(_nm).normalize(); } else _n.set(0, 1, 0);
    nor[i * 3] = _n.x; nor[i * 3 + 1] = _n.y; nor[i * 3 + 2] = _n.z;
    uv[i * 2] = U ? U.getX(i) : 0; uv[i * 2 + 1] = U ? U.getY(i) : 0;
    if (uvx) { uv[i * 2] = uv[i * 2] * uvx[0] + uvx[2]; uv[i * 2 + 1] = uv[i * 2 + 1] * uvx[1] + uvx[3]; }
    if (col) { col[i * 3] = C.getX(i); col[i * 3 + 1] = C.getY(i); col[i * 3 + 2] = C.getZ(i); }
  }
  let idx;
  if (geo.index) idx = Array.from(geo.index.array);
  else { idx = new Array(n); for (let i = 0; i < n; i++) idx[i] = i; }
  // (a mirrored transform flips the winding)
  if (M && M.determinant() < 0) for (let t = 0; t + 2 < idx.length; t += 3) { const a = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = a; }
  return { pos, nor, uv, col, idx };
}

function makePack(name) {
  const props = new Map();      // key model|glow -> { model, glow, inst: [] }
  const mats = [], matIndex = new Map();
  const usedCanvas = new Set();
  const CELL = 256;
  const chunks = new Map(); // key -> { mat, ox, oy, oz, pos[], nor[], uv[], col[], idx[] }
  const instanced = [];     // { mat, geo: {pos, nor, uv, col, idx}, inst: [] }
  const shared = new Map(); // geometry|material -> instanced entry
  const imIndex = new Map(); // InstancedMesh -> its instanced entry index (breakables)
  let skipped = 0;
  function addProp(model, glow, M) {
    if (!model) return;
    const k = model + '|' + (glow || 0);
    if (!props.has(k)) props.set(k, { model, glow: glow || 0, inst: [] });
    props.get(k).inst.push(m34(M));
  }
  function texRef(t) {
    if (!t) return null;
    const img = t.image;
    if (img && img._id !== undefined) { usedCanvas.add(img._id); return { canvas: img._id, wrapS: t.wrapS === THREE.RepeatWrapping, wrapT: t.wrapT === THREE.RepeatWrapping, flipY: t.flipY !== false }; }
    return null;
  }
  function matKey(m) {
    const g = m.userData?.slMat;
    const d = {
      color: lin(m.color), opacity: r4(m.opacity ?? 1), transparent: !!m.transparent, double: m.side === THREE.DoubleSide,
      rough: r4(m.roughness ?? 0.8), metal: r4(m.metalness ?? 0), vc: !!m.vertexColors,
      emissive: m.emissive ? lin(m.emissive).map((v) => r4(v * (m.emissiveIntensity ?? 1))) : [0, 0, 0],
      map: texRef(m.map), emissiveMap: texRef(m.emissiveMap), alphaTest: r4(m.alphaTest || 0),
      glow: m.userData?.slGlow || 0, glb: g ? { model: g.model, index: g.index } : null,
      // a sign's face lights faintly at night (village.js / resortdressing.js setNight: emissive x night x 0.25)
      nightEmissive: m.emissiveMap && (m.emissiveIntensity ?? 1) === 0 ? 0.25 : 0,
      // emissive x (day + (night - day) x night): stationbuildings.js nightScaled; other shader-patched glows: night only
      night: m.userData?.slNight || (m.onBeforeCompile && !m.userData?.slGlow && m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0 && String(m.onBeforeCompile).includes('uNight') ? [0, 0.45] : null),
      basic: !!m.isMeshBasicMaterial,
    };
    const k = JSON.stringify(d);
    if (!matIndex.has(k)) { matIndex.set(k, mats.length); mats.push(d); }
    return matIndex.get(k);
  }
  // raw meshes: per material and 256 m cell, vertices baked to world space relative to the cell's origin
  function addRaw(geo, material, M) {
    if (!geo?.attributes?.position || !material) return;
    const mats_ = [].concat(material);
    const groups = Array.isArray(material) && geo.groups.length ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
    geo.computeBoundingSphere();
    const c = geo.boundingSphere.center.clone().applyMatrix4(M);
    const cx = Math.floor(c.x / CELL), cz = Math.floor(c.z / CELL);
    for (const gr of groups) {
      const mat = mats_[gr.materialIndex ?? 0];
      if (!mat || mat.visible === false) continue;
      const mi = matKey(mat);
      const key = mi + '|' + cx + '|' + cz;
      if (!chunks.has(key)) chunks.set(key, { mat: mi, ox: (cx + 0.5) * CELL, oy: Math.round(c.y), oz: (cz + 0.5) * CELL, pos: [], nor: [], uv: [], col: [], idx: [], hasCol: false });
      const ch = chunks.get(key);
      const a = geoArrays(geo, M, ch.ox, ch.oy, ch.oz, uvXf(mat));
      const base = ch.pos.length / 3;
      const vs = a.pos.length / 3;
      for (let i = 0; i < a.pos.length; i++) ch.pos.push(a.pos[i]);
      for (let i = 0; i < a.nor.length; i++) ch.nor.push(a.nor[i]);
      for (let i = 0; i < a.uv.length; i++) ch.uv.push(a.uv[i]);
      if (a.col) { ch.hasCol = true; for (let i = 0; i < a.col.length; i++) ch.col.push(a.col[i]); } else for (let i = 0; i < vs * 3; i++) ch.col.push(1);
      const idx = a.idx.slice(gr.start, gr.start + gr.count);
      for (const i of idx) ch.idx.push(base + i);
    }
  }
  let geoUse = new Map();
  function visit(o) {
    if (o.visible === false) return;
    if (o.userData.slSkip) { skipped++; return; }
    // (the cars on show (the Autohaus, the medical centre's ambulance...): vehicles are the C++ build's own)
    if (o.isMesh && /^(car_|car1$|ski_bus|ambulance|tow_truck)/.test([].concat(o.material)[0]?.userData?.slMat?.model || '')) { skipped++; return; }
    // (additive light pools on the snow / platforms: the C++ renderer has no additive pass yet; drawn as plain glass
    // they were bright slabs)
    if (o.isMesh && [].concat(o.material)[0]?.blending === THREE.AdditiveBlending) { skipped++; return; }
    // (the guardrails' sections are bent along their lines in the vertex shader (bus.js bendMaterial, per-instance
    // Hermite attributes): the C++ build sweeps them from busRoads.rails instead, rail_sweep.cpp)
    if (o.isMesh && String([].concat(o.material)[0]?.customProgramCacheKey?.() || '').startsWith('busrail-')) { skipped++; return; }
    if (o.userData.slFit) {
      const f = new THREE.Matrix4().fromArray(o.userData.slFit.fit);
      let glow = 0;
      o.traverse((q) => { if (q.isMesh && q.material?.userData?.slGlow) glow = q.material.userData.slGlow; });
      addProp(o.userData.slFit.model, glow, o.matrixWorld.clone().multiply(f));
      return;
    }
    if (o.isLOD && o.levels?.length) { visit(o.levels[0].object); return; }
    if (o.isMesh && !o.isSkinnedMesh) {
      const sl = o.geometry?.userData?.sl;
      const glow = o.material?.userData?.slGlow || 0;
      if (o.isInstancedMesh) {
        const im = new THREE.Matrix4();
        const n = o.count;
        if (sl) {
          const f = new THREE.Matrix4().fromArray(sl.fit);
          for (let i = 0; i < n; i++) { o.getMatrixAt(i, im); addProp(sl.model, glow, o.matrixWorld.clone().multiply(im).multiply(f)); }
        } else if ((n >= 8 || o.geometry.attributes.position.count > 200) && !Array.isArray(o.material)) {
          // (instanced meshes sharing a geometry and material, a chunk's sleepers or poles each: one set)
          const mi = matKey(o.material), k = o.geometry.uuid + '|' + mi;
          if (!shared.has(k)) { shared.set(k, { mat: mi, geo: geoArrays(o.geometry, null, 0, 0, 0, uvXf(o.material)), inst: [] }); instanced.push(shared.get(k)); }
          const e = shared.get(k);
          imIndex.set(o, { set: instanced.indexOf(e), base: e.inst.length });
          for (let i = 0; i < n; i++) { o.getMatrixAt(i, im); e.inst.push(m34(o.matrixWorld.clone().multiply(im))); }
        } else for (let i = 0; i < n; i++) { o.getMatrixAt(i, im); addRaw(o.geometry, o.material, o.matrixWorld.clone().multiply(im)); }
      } else if (sl) addProp(sl.model, glow, o.matrixWorld.clone().multiply(new THREE.Matrix4().fromArray(sl.fit)));
      else if ((geoUse.get(o.geometry) || 0) >= 3 && o.geometry.attributes.position.count > 200) {
        const mi = matKey(o.material), k = o.geometry.uuid + '|' + mi;
        if (!shared.has(k)) { const e = { mat: mi, geo: geoArrays(o.geometry, null, 0, 0, 0, uvXf(o.material)), inst: [] }; shared.set(k, e); instanced.push(e); }
        shared.get(k).inst.push(m34(o.matrixWorld));
      } else addRaw(o.geometry, o.material, o.matrixWorld);
    }
    for (const c of o.children) visit(c);
  }
  function capture(sc) {
    sc.updateMatrixWorld(true);
    geoUse = new Map();
    sc.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && !o.geometry?.userData?.sl && !Array.isArray(o.material)) geoUse.set(o.geometry, (geoUse.get(o.geometry) || 0) + 1); });
    visit(sc);
    log(`${name}: captured props`, [...props.values()].reduce((a, p) => a + p.inst.length, 0), 'in', props.size, 'batches;', chunks.size, 'mesh chunks;', instanced.length, 'instanced meshes;', skipped, 'skipped');
  }

  // ---- binary blob
  const parts = [];
  let off = 0;
  function blob(typed) {
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (b.length % 4)) % 4;
    const at = off;
    parts.push(b); if (pad) parts.push(Buffer.alloc(pad));
    off += b.length + pad;
    return at;
  }
  // 28 bytes a vertex: position f32 x3, normal i8 x3 (+pad), uv f32 x2, colour u8 x3 (+pad)
  function packGeo(a, hasCol) {
    const n = a.pos.length / 3, buf = Buffer.alloc(n * 28);
    const q = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));
    for (let i = 0; i < n; i++) {
      const o = i * 28;
      buf.writeFloatLE(a.pos[i * 3], o); buf.writeFloatLE(a.pos[i * 3 + 1], o + 4); buf.writeFloatLE(a.pos[i * 3 + 2], o + 8);
      buf.writeInt8(q(a.nor[i * 3]), o + 12); buf.writeInt8(q(a.nor[i * 3 + 1]), o + 13); buf.writeInt8(q(a.nor[i * 3 + 2]), o + 14);
      buf.writeFloatLE(a.uv[i * 2], o + 16); buf.writeFloatLE(a.uv[i * 2 + 1], o + 20);
      for (let k = 0; k < 3; k++) buf.writeUInt8(hasCol && a.col ? Math.max(0, Math.min(255, Math.round(Math.sqrt(Math.max(0, a.col[i * 3 + k])) * 255))) : 255, o + 24 + k);
    }
    const idx = n < 65536 ? Uint16Array.from(a.idx) : Uint32Array.from(a.idx);
    return { verts: n, vOff: blob(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), tris: a.idx.length / 3, iOff: blob(idx), i16: n < 65536 };
  }
  // long instance lists go to the bin (float32 x 12 each: world space, mm precision 13 km out)
  const instOut = (inst) => (inst.length > 64 ? { instOff: blob(Float32Array.from(inst.flat())), instN: inst.length } : { inst });

  // A group's meshes in its own frame (a vehicle's procedural parts), merged per material: [{ mat, verts, ... }]
  function localModel(root) {
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert(), per = new Map();
    root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || o.userData.slSkip) return;
      for (let p = o; p && p !== root; p = p.parent) if (p.visible === false && p !== o) return;
      const mats_ = [].concat(o.material);
      const groups = Array.isArray(o.material) && o.geometry.groups.length ? o.geometry.groups : [{ start: 0, count: o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count, materialIndex: 0 }];
      const Ms = [];
      if (o.isInstancedMesh) { const im = new THREE.Matrix4(); for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, im); Ms.push(inv.clone().multiply(o.matrixWorld).multiply(im)); } }
      else Ms.push(inv.clone().multiply(o.matrixWorld));
      for (const M of Ms) for (const gr of groups) {
        const mat = mats_[gr.materialIndex ?? 0];
        if (!mat || mat.visible === false) continue;
        const mi = matKey(mat);
        if (!per.has(mi)) per.set(mi, { pos: [], nor: [], uv: [], col: [], idx: [], hasCol: false });
        const ch = per.get(mi), a = geoArrays(o.geometry, M, 0, 0, 0, uvXf(mat)), base = ch.pos.length / 3, vs = a.pos.length / 3;
        for (const v of a.pos) ch.pos.push(v);
        for (const v of a.nor) ch.nor.push(v);
        for (const v of a.uv) ch.uv.push(v);
        if (a.col) { ch.hasCol = true; for (const v of a.col) ch.col.push(v); } else for (let i = 0; i < vs * 3; i++) ch.col.push(1);
        for (const i of a.idx.slice(gr.start, gr.start + gr.count)) ch.idx.push(base + i);
      }
    });
    return [...per.entries()].filter(([, c]) => c.idx.length).map(([mi, c]) => ({ mat: mi, ...packGeo(c, c.hasCol) }));
  }

  function sampleSurfaces(set) {
    const out = [];
    const STEP = 0.25;
    for (const s of set) {
      const b = s.bounds;
      const nx = Math.floor((b.maxx - b.minx) / STEP) + 2, nz = Math.floor((b.maxz - b.minz) / STEP) + 2;
      if (nx * nz > 4e6) { log('surface too large, skipped', JSON.stringify(b)); continue; }
      const h = new Float32Array(nx * nz);
      let any = false, lo = Infinity;
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const v = s.height(b.minx + i * STEP, b.minz + j * STEP);
        h[j * nx + i] = v === null || v === undefined || !Number.isFinite(v) ? NaN : v;
        if (Number.isFinite(h[j * nx + i])) { any = true; lo = Math.min(lo, v); }
      }
      if (!any) continue;
      // int16 centimetres over the lowest sample (-32768 = not over it)
      const q = new Int16Array(nx * nz);
      for (let k = 0; k < q.length; k++) q[k] = Number.isFinite(h[k]) ? Math.min(32767, Math.round((h[k] - lo) * 100)) : -32768;
      out.push({ x0: b.minx, z0: b.minz, step: STEP, nx, nz, base: lo, off: blob(q) });
    }
    return out;
  }

  function colliderOut(cs) {
    return cs.filter((c) => c && !c.carOnly && !c.car && !c.bus && !c.mp && !c.police && Number.isFinite(c.x) && Math.abs(c.x) < 1e8).map((c) => {
      const o = { x: r4(c.x), z: r4(c.z) };
      if (c.r !== undefined) o.r = r4(c.r); else { o.hw = r4(c.hw); o.hd = r4(c.hd); o.rot = r4(c.rot || 0); }
      if (c.top !== undefined && Number.isFinite(c.top)) o.top = r4(c.top);
      if (c.soft || c.net) o.soft = 1;
      if (c.rail) o.rail = 1;
      if (c.breakable) { o.brk = r4(c.breakable.minV || 0); if (c.breakable.lamp) o.lamp = 1; }
      return o;
    });
  }

  function finish(extra) {
    const meshes = [...chunks.values()].filter((c) => c.idx.length).map((c) => ({ mat: c.mat, origin: [c.ox, c.oy, c.oz], ...packGeo(c, c.hasCol) }));
    const inst = instanced.map((m) => ({ mat: m.mat, ...packGeo(m.geo, !!m.geo.col), ...instOut(m.inst) }));
    const propsOut = [...props.values()].map((p) => ({ model: p.model, glow: p.glow, ...instOut(p.inst) }));
    const ex = typeof extra === 'function' ? extra() : extra;
    // (a canvas drawn into another: its commands go along)
    for (const id of usedCanvas) { const c = canvases.get(id); for (const op of c.ops) if (op[0] === 'drawImage' && op[1] >= 0) usedCanvas.add(op[1]); }
    const canvasOut = {};
    for (const id of usedCanvas) { const c = canvases.get(id); canvasOut[id] = { w: c.width, h: c.height, ops: c.ops }; }
    const out = { version: 3, generated: new Date().toISOString(), bin: `${name}.bin`, props: propsOut, materials: mats, meshes, instanced: inst, canvases: canvasOut, ...ex };
    fs.writeFileSync(path.join(OUT, `${name}.bin`), Buffer.concat(parts));
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(out));
    log(`wrote ${name}.json`, (fs.statSync(path.join(OUT, `${name}.json`)).size / 1024).toFixed(0), `KB, ${name}.bin`, (off / 1048576).toFixed(1), 'MB;',
      mats.length, 'materials,', Object.keys(canvasOut).length, 'canvases; models used:', [...new Set(propsOut.map((p) => p.model))].join(' '));
  }
  return { capture, localModel, sampleSurfaces, colliderOut, finish, blob, matKey, imIndex, packGeo };
}

// ================================================================ pack 1: the resort (Phase 2)
const resort = makePack('resort');
resort.capture(scene);
{
  const surfSet = new Set();
  for (const arr of world.surfaceGrid.values()) for (const s of arr) if (!surfBefore.has(s) && (!railBuilt.has(s) || railSurfs.has(s))) surfSet.add(s);
  const surfaces = resort.sampleSurfaces(surfSet);
  log('resort surfaces', surfaces.length);
  // ---- lift lines
  const lines = lifts.lines.map((l) => {
    const sp = l.spec;
    const ride = (up) => {
      const end = up ? sp.top : sp.bottom, dir = l.dir.clone().multiplyScalar(up ? 1 : -1);
      const out = Math.max(l.cfg.stationSize * 0.5 + 9, (l.stationBack?.[up ? 'top' : 'bottom'] ?? 0) + 5);
      const ex = end.x + dir.x * out + l.sideV.x * 4, ez = end.z + dir.z * out + l.sideV.z * 4;
      const [gx, gz] = world.gradient(ex, ez);
      return { x: r4(ex), z: r4(ez), heading: r4(Math.hypot(gx, gz) > 0.03 ? Math.atan2(-gx, -gz) : Math.atan2(dir.x, dir.z)) };
    };
    return {
      id: sp.id ?? null, name: sp.name, type: sp.type, main: !!sp.main, price: sp.price ?? 0, village: !!sp.village,
      bottomName: sp.bottomName || null, topName: sp.topName || null,
      bottom: [sp.bottom.x, sp.bottom.y, sp.bottom.z], top: [sp.top.x, sp.top.y, sp.top.z],
      B: [l.B.x, l.B.y, l.B.z], T: [l.T.x, l.T.y, l.T.z], L: l.L, dir: [l.dir.x, l.dir.z], yaw: l.yaw,
      cfg: l.cfg, mid: l.mid ? { u: l.mid.u, x: l.mid.x, y: l.mid.y, z: l.mid.z, name: l.mid.name, side: l.mid.side || 1 } : null,
      supports: l.supports.map((s) => [r4(s.u), r4(s.y)]),
      towers: l.towers.map((t) => [r4(t.x), r4(t.z), r4(t.g), r4(t.top)]),
      cars: l.cars.map((c) => r4(c.s)),
      carSize: l.carSize ? [r4(l.carSize.x), r4(l.carSize.z)] : null,
      exitUp: ride(true), exitDown: ride(false), midExit: l.mid ? (({ x, z, heading }) => ({ x: r4(x), z: r4(z), heading: r4(heading) }))(l.midExit()) : null,
    };
  });
  resort.finish({ lifts: lines, stations, colliders: resort.colliderOut(colliders), surfaces });
}

// ================================================================ pack 2: the transport (Phase 3)
// Built as main.js builds it after the resort: the ski bus's stops, roads (strips, guardrails, snow poles, reflector
// posts, road signs, scenic props, the depot) and buses; the car parks and their parked cars; the road tunnels; the
// Wolkenspitzbahn's track, tunnels, viaducts and platforms; the Legacy Express's line (every chunk, viaduct, portal and
// station built at once); its frozen lakes; the Autohaus's hall. The moving things (buses, cars, trains) are left out
// of the capture: their models, fits and the data they run on (roads, lanes, stops, timetables) go to `net`.
const tScene = new THREE.Scene();
const tCols = [];
const surfBeforeT = surfAll();
const tryStep = async (label, fn) => { try { const r = await fn(); log(label, 'built'); return r; } catch (e) { log(label, 'skipped:', e.stack?.split('\n').slice(0, 3).join(' | ') || e.message); return null; } };
const { SkiBus } = await import(pathToFileURL(path.join(SRC, 'game/skibus.js')));
const skibus = await tryStep('ski bus stops + roads', () => new SkiBus({ scene: tScene, models, layout: L.layout, colliders: tCols }));
if (skibus?.line) {
  skibus.line.bus.group.userData.slSkip = true;
  for (const b of skibus.line.fleet || []) if (b.group) b.group.userData.slSkip = true;
}
const parking = await tryStep('car parks', async () => new (await import(pathToFileURL(path.join(SRC, 'game/parking.js')))).ParkingLots({ scene: tScene, models, colliders: tCols }));
for (const e of parking?.cars || []) e.car.userData.slSkip = true;
const roadTunnels = await tryStep('road tunnels', async () => {
  const { RoadTunnels } = await import(pathToFileURL(path.join(SRC, 'game/bus/tunnelview.js')));
  const rt = new RoadTunnels({ scene: tScene, terrain: null, colliders: tCols });
  for (const t of rt.tunnels) { rt.job = null; rt.buildNear(t.samples?.[0]?.[0] ?? 0, t.samples?.[0]?.[1] ?? 0, 1e9); }
  if (rt.warm) rt.warm.userData.slSkip = true;
  for (const b of rt.built.values()) { for (const lid of b.lids || []) { const o = lid?.mesh || lid; if (o?.userData) o.userData.slSkip = true; } if (b.darkDecal?.userData) b.darkDecal.userData.slSkip = true; for (const p of b.plugs || []) if (p?.isObject3D) p.userData.slSkip = true; }
  return rt;
});
const railTrack = await tryStep('Wolkenspitzbahn track', async () => {
  const { buildRailway, setTunnelLampModel } = await import(pathToFileURL(path.join(SRC, 'world/railtrack.js')));
  try { const { meshyHead, HEADS } = await import(pathToFileURL(path.join(SRC, 'world/pistelights.js'))); if (models.floodlight_head_c) setTunnelLampModel(meshyHead(models.floodlight_head_c, HEADS.floodlight_head_c)); } catch (e) { log('rail tunnel lamps', e.message); }
  const t = buildRailway(tScene);
  tCols.push(...(t.colliders || []));
  // (the ballast bed, sleepers, rails and rack are swept by the C++ build: rail_sweep.cpp; the tunnels' linings and
  // lamps, the portals and the viaducts are captured)
  const M = t.materials || {};
  t.group.traverse((o) => { if (o.isMesh && (o.material === M.ballast || o.material === M.concrete || o.material === M.steel)) o.userData.slSkip = true; });
  return t;
});
// the rail stations' platforms, signs and lamps (the buildings went with the resort)
tScene.add(railScene);
tCols.push(...railColsAll.filter((c) => !railCols.includes(c)));
const xtrack = await tryStep('Legacy Express line', async () => {
  const { buildExpressTrack } = await import(pathToFileURL(path.join(SRC, 'world/expresstrack.js')));
  const t = buildExpressTrack(tScene, { models, colliders: tCols, courses: freeMod.freeCourses() });
  // (the line's bed, rails, sleepers and tube linings, 65 km of them, are swept by the C++ build from the line's data:
  // native/src/world/rail_sweep.cpp; captured here they were ~150 MB. The viaducts, portals and stations are captured)
  for (const e of t.ents || []) {
    if (e.kind === 'bed' || e.kind === 'detail') continue;
    try { e.obj = e.build(); } catch (err) { log('express', e.kind, 'failed', err.message); continue; }
    for (const c of e.obj.userData.colliders || []) tCols.push(c);
    e.obj.visible = true;
    if (e.kind === 'station') e.obj.userData.view?.({ x: e.x, y: 1e4, z: e.z }, false);
    t.group.add(e.obj);
  }
  return t;
});
await tryStep('Legacy Express lakes', async () => (await import(pathToFileURL(path.join(SRC, 'world/expressscenery.js')))).buildExpressScenery(tScene));
await tryStep('Autohaus hall', async () => {
  const { CarRental } = await import(pathToFileURL(path.join(SRC, 'game/carrental.js')));
  const o = Object.create(CarRental.prototype);
  Object.assign(o, { scene: tScene, models, colliders: tCols, L: busRoads.rental });
  if (!o.L) throw new Error('no Autohaus site');
  o.yaw0 = Math.atan2(o.L.dirx, o.L.dirz);
  o.buildOutside();
});
await tryStep('medical centre', async () => new (await import(pathToFileURL(path.join(SRC, 'game/hospital.js')))).Hospital({ scene: tScene, models, colliders: tCols }));

if (process.env.SL_STATS) {
  tScene.updateMatrixWorld(true);
  const tri = (root) => { let n = 0; root.traverse((o) => { if (o.isMesh && o.visible !== false && !o.userData.slSkip) { const g = o.geometry, t = g.index ? g.index.count / 3 : g.attributes.position.count / 3; n += t * (o.isInstancedMesh ? o.count : 1); } }); return n; };
  for (const c of tScene.children) log('stats', c.name || c.type, (tri(c) / 1e6).toFixed(2), 'M tris', c.children.length, 'children');
  if (xtrack) { const by = {}; for (const e of xtrack.ents) if (e.obj) by[e.kind] = (by[e.kind] || 0) + tri(e.obj); log('stats express', JSON.stringify(by)); }
}
const transport = makePack('transport');
transport.capture(tScene);
{
  const surfSet = new Set();
  for (const arr of world.surfaceGrid.values()) for (const s of arr) if (!surfBeforeT.has(s) && !s.roadTunnel) surfSet.add(s);
  const surfaces = transport.sampleSurfaces(surfSet);
  log('transport surfaces', surfaces.length);
  const net = await (await import('./export_net.mjs')).exportNet({ THREE, SRC, world, L, busRoads, skibus, parking, roadTunnels, railStations, xtrack, models, freeMod, loadGLB, pack: transport, log, r4 });
  transport.finish({ colliders: transport.colliderOut(tCols), surfaces, net });
}
console.warn = _warn; console.info = _info;
