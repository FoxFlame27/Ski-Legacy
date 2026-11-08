// Ski Legacy native port: resort exporter (Phase 2).
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
globalThis.document = { createElement: (t) => (t === 'canvas' ? new RecCanvas() : { style: {}, appendChild() {}, addEventListener() {} }), body: { appendChild() {} }, addEventListener() {} };
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

const MODELS = ['rental_shop', 'gondola_cabin', 'chairlift_chair', 'lift_tower', 'chair_terminal', 'chair_bullwheel', 'hotel_chalet', 'mountain_hut', 'race_arch',
  'ticket_booth', 'snow_cannon', 'lamp_post', 'wooden_bench', 'outdoor_ski_rack', 'snowman', 'firewood_pile', 'wooden_fence', 'christmas_tree', 'picnic_table',
  'wooden_sled', 'deck_chair', 'map_board', 'sign_pole', 'truss_pylon', 'snowmobile', 'wooden_barrel', 'trash_bin', 'market_stall', 'fire_pit',
  'grandstand', 'timing_board', 'start_house', 'patrol_hut', 'piste/bnet_panel', 'piste/flag_pole', 'piste/rope_pole'];
const models = {};
await Promise.all(MODELS.map(async (n) => { models[n] = await loadGLB(n); }));
log('models loaded', Object.values(models).filter(Boolean).length, '/', MODELS.length);

const { Village } = await import(pathToFileURL(path.join(SRC, 'world/village.js')));
const { Lifts } = await import(pathToFileURL(path.join(SRC, 'world/lifts.js')));
const { Decor } = await import(pathToFileURL(path.join(SRC, 'world/decor.js')));
const { buildResortDressing } = await import(pathToFileURL(path.join(SRC, 'world/resortdressing.js')));

// (the surfaces the secrets / layout registered before the resort is built are not the resort's: tunnels are later)
const surfBefore = new Set();
for (const arr of world.surfaceGrid.values()) for (const s of arr) surfBefore.add(s);
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
const surfBeforeRail = new Set();
for (const arr of world.surfaceGrid.values()) for (const q of arr) surfBeforeRail.add(q);
// the Wolkenspitzbahn's station buildings (stationbuildings.js: the valley station in Legacy Village, the halts, the
// glacier terminal) where railstations.js stands them; only the buildings, their colliders and their paving are
// kept (the platforms, track and trains are the railway's: a later phase)
const railScene = new THREE.Group();
const railCols = [], railSurfs = new Set();
globalThis.__slRailCols = railCols;
globalThis.__slRegStation = (fn) => {
  const before = new Set();
  for (const arr of world.surfaceGrid.values()) for (const q of arr) before.add(q);
  const r = fn();
  for (const arr of world.surfaceGrid.values()) for (const q of arr) if (!before.has(q)) railSurfs.add(q);
  return r;
};
try {
  const { buildStations } = await import(pathToFileURL(path.join(SRC, 'world/railstations.js')));
  buildStations(railScene, [], models);
  log('rail stations built:', railCols.length, 'colliders');
} catch (e) { log('rail stations skipped:', e.message); }
globalThis.__slRegStation = null;
colliders.push(...railCols);
for (const arr of world.surfaceGrid.values()) for (const q of arr) if (!surfBeforeRail.has(q)) railBuilt.add(q);
// (only the tagged buildings / canopies from the rail scene)
railScene.updateMatrixWorld(true);
const railKeep = [];
railScene.traverse((o) => { if (o.userData?.slRail) railKeep.push(o); });
for (const o of railKeep) { const w = o.matrixWorld.clone(); o.parent?.remove(o); o.matrixAutoUpdate = false; o.matrix.copy(w); scene.add(o); }
log('rail station buildings / canopies kept:', railKeep.map((o) => o.name + '@' + o.matrix.elements[12].toFixed(0) + ',' + o.matrix.elements[13].toFixed(0) + ',' + o.matrix.elements[14].toFixed(0)).join(' '));

// snow cannons: the near / far split is made per frame from the player's position: all near for the capture
{
  const C = village.cannonLod;
  if (C) { C.mats.forEach((m, i) => C.near.setMatrixAt(i, m)); C.near.count = C.mats.length; C.far.count = 0; }
}
// lift cars are animated by the C++ lifts: their (empty) instanced meshes are skipped
for (const l of lifts.lines) for (const k of ['carNear', 'carMid', 'carFar']) if (l[k]) l[k].userData.slSkip = true;

// ---------------------------------------------------------------- walk the scene
scene.updateMatrixWorld(true);
const props = new Map();      // key model|glow -> { model, glow, inst: [] }
const mats = [], matIndex = new Map();
const usedCanvas = new Set();
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const m34 = (m) => { const e = m.elements; return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]].map(r4); };
function addProp(model, glow, M) {
  if (!model) return;
  const k = model + '|' + (glow || 0);
  if (!props.has(k)) props.set(k, { model, glow: glow || 0, inst: [] });
  props.get(k).inst.push(m34(M));
}
const lin = (c) => (c ? [r4(c.r), r4(c.g), r4(c.b)] : [1, 1, 1]);
function texRef(t) {
  if (!t) return null;
  const img = t.image;
  if (img && img._id !== undefined) { usedCanvas.add(img._id); return { canvas: img._id, wrapS: t.wrapS === THREE.RepeatWrapping, wrapT: t.wrapT === THREE.RepeatWrapping, flipY: t.flipY !== false } };
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
const CELL = 256;
const chunks = new Map(); // key -> { mat, ox, oy, oz, pos[], nor[], uv[], col[], idx[] }
const instanced = [];     // { mat, geo: {pos, nor, uv, col, idx}, inst: [] }
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

// geometry shared by several plain meshes (a cached bullwheel, a sign post...): drawn instanced
const geoUse = new Map();
scene.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && !o.geometry?.userData?.sl && !Array.isArray(o.material)) geoUse.set(o.geometry, (geoUse.get(o.geometry) || 0) + 1); });
const shared = new Map(); // geometry|material -> instanced entry
let skipped = 0;
function visit(o) {
  if (o.visible === false) return;
  if (o.userData.slSkip) { skipped++; return; }
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
      } else if (n >= 8 && !Array.isArray(o.material)) {
        const a = geoArrays(o.geometry, null, 0, 0, 0, uvXf(o.material));
        const inst = [];
        for (let i = 0; i < n; i++) { o.getMatrixAt(i, im); inst.push(m34(o.matrixWorld.clone().multiply(im))); }
        instanced.push({ mat: matKey(o.material), geo: a, inst });
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
visit(scene);
log('captured: props', [...props.values()].reduce((a, p) => a + p.inst.length, 0), 'in', props.size, 'batches;', chunks.size, 'mesh chunks;', instanced.length, 'instanced meshes;', skipped, 'skipped');

// ---------------------------------------------------------------- binary blob
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
const meshes = [...chunks.values()].filter((c) => c.idx.length).map((c) => ({ mat: c.mat, origin: [c.ox, c.oy, c.oz], ...packGeo(c, c.hasCol) }));
const inst = instanced.map((m) => ({ mat: m.mat, ...packGeo(m.geo, !!m.geo.col), inst: m.inst }));

// ---------------------------------------------------------------- walkable surfaces (decks, stairs): sampled
const surfSet = new Set();
for (const arr of world.surfaceGrid.values()) for (const s of arr) if (!surfBefore.has(s) && (!railBuilt.has(s) || railSurfs.has(s))) surfSet.add(s);
const surfaces = [];
const STEP = 0.25;
for (const s of surfSet) {
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
  surfaces.push({ x0: b.minx, z0: b.minz, step: STEP, nx, nz, base: lo, off: blob(q) });
}
log('surfaces', surfaces.length);

// ---------------------------------------------------------------- lift lines
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

// ---------------------------------------------------------------- canvases
const canvasOut = {};
for (const id of usedCanvas) {
  const c = canvases.get(id);
  // (a canvas drawn into another: its commands go along)
  for (const op of c.ops) if (op[0] === 'drawImage' && op[1] >= 0) usedCanvas.add(op[1]);
}
for (const id of usedCanvas) { const c = canvases.get(id); canvasOut[id] = { w: c.width, h: c.height, ops: c.ops }; }

const colOut = colliders.filter((c) => !c.carOnly && Number.isFinite(c.x)).map((c) => {
  const o = { x: r4(c.x), z: r4(c.z) };
  if (c.r !== undefined) o.r = r4(c.r); else { o.hw = r4(c.hw); o.hd = r4(c.hd); o.rot = r4(c.rot || 0); }
  if (c.top !== undefined && Number.isFinite(c.top)) o.top = r4(c.top);
  if (c.soft) o.soft = 1;
  return o;
});

const out = {
  version: 2, generated: new Date().toISOString(), bin: 'resort.bin',
  props: [...props.values()], materials: mats, meshes, instanced: inst, canvases: canvasOut,
  lifts: lines, stations, colliders: colOut, surfaces,
};
fs.writeFileSync(path.join(OUT, 'resort.bin'), Buffer.concat(parts));
fs.writeFileSync(path.join(OUT, 'resort.json'), JSON.stringify(out));
log('wrote resort.json', (fs.statSync(path.join(OUT, 'resort.json')).size / 1024).toFixed(0), 'KB, resort.bin', (off / 1048576).toFixed(1), 'MB;',
  colOut.length, 'colliders,', mats.length, 'materials,', Object.keys(canvasOut).length, 'canvases; models used:', [...new Set([...props.values()].map((p) => p.model))].join(' '));
console.warn = _warn; console.info = _info;
