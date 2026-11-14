// Node module loader hooks for export_resort.mjs: small source patches applied while the game's own modules load, so
// the exporter can tell which GLB (and which fit) every mesh in the built scene came from, and which materials glow
// at night. Nothing here changes what the game builds; it only tags it.
const PATCHES = [
  {
    // (the full-detail models, their interiors, of the car you drive: which cars have one, for export_net.mjs)
    file: '/src/game/drive.js',
    edits: [['const FULL = { car_audi_rs6', 'export const FULL = { car_audi_rs6']],
  },
  {
    // (the showroom's cars: which stand where, for export_rooms.mjs)
    file: '/src/game/carrental.js',
    edits: [['const DISPLAY = [[', 'export const DISPLAY = [['], ['const UPPER = [[', 'export const UPPER = [[']],
  },
  {
    // (the rooms' soft reflections are a PMREM render: none in Node; export_rooms.mjs)
    file: '/src/engine/roomenv.js',
    edits: [['export function roomEnvironment(renderer, sigma) {', 'export function roomEnvironment(renderer, sigma) { if (!renderer) return null;']],
  },
  {
    file: '/src/core/assets.js',
    edits: [
      // models come from the exporter's Node GLB loader (geometry + material slots, no textures)
      ['export function loadGLB(name, onProgress) {', 'export function loadGLB(name, onProgress) { if (globalThis.__slLoadGLB) return globalThis.__slLoadGLB(name);'],
      // fitModel: tag the group with its model and fit matrix (model space -> group space)
      ['  g.userData.size = box.getSize(new THREE.Vector3());\n  return g;\n}',
        '  g.userData.size = box.getSize(new THREE.Vector3());\n  m.updateMatrix();\n  g.userData.slFit = { model: gltf.modelName, fit: m.matrix.toArray() };\n  return g;\n}'],
      // bakeGeometry: tag the baked geometry with its model and fit (model space -> geometry space)
      ['export function bakeGeometry(gltf, opts) {', 'export function bakeGeometry(gltf, opts) { const r = __bake0(gltf, opts); globalThis.__slTagBake?.(gltf, opts, r); return r; }\nfunction __bake0(gltf, opts) {'],
    ],
  },
  {
    file: '/src/world/village.js',
    edits: [
      ['    const m = o.material.clone();\n    m.onBeforeCompile', '    const m = o.material.clone();\n    m.userData.slGlow = strength;\n    m.onBeforeCompile'],
      // the trail map on the notice board: its canvas replayed exactly (the relief's pixels, dashes, caps, its fonts),
      // and its face (a child of the fitted board) captured with it
      ["    const W = 2048, H = 1270; // (the panel's 1.61 : 1)\n    const c = document.createElement('canvas');\n    c.width = W; c.height = H;",
        "    const W = 2048, H = 1270; // (the panel's 1.61 : 1)\n    const c = document.createElement('canvas');\n    c.width = W; c.height = H; c.slExact = true;"],
      ['    board.add(face);', '    face.userData.slInFit = true;\n    board.add(face);'],
    ],
  },
  {
    file: '/src/world/gondolastation.js',
    edits: [
      ['export function buildGondolaStation(o) {', 'export function buildGondolaStation(o) { const r = __gst0(o); globalThis.__slStation?.("end", o, r); return r; }\nfunction __gst0(o) {'],
      ['export function buildGondolaMidStation(o) {', 'export function buildGondolaMidStation(o) { const r = __gmid0(o); globalThis.__slStation?.("mid", o, r); return r; }\nfunction __gmid0(o) {'],
    ],
  },
  {
    file: '/src/world/stationbuildings.js',
    edits: [
      // the day / night factors of the lit materials (windows, lamps, signs)
      ['function nightScaled(m, day, night, key) {', 'function nightScaled(m, day, night, key) {\n  m.userData.slNight = [day, night];'],
      // the buildings and canopies are captured (railway platforms and track are a later phase)
      ['export function stationBuilding(kind, { plinth = 5, apron = -1.2, departures = null, name = null } = {}) {',
        'export function stationBuilding(kind, o = {}) { const g = __sb0(kind, o); g.userData.slRail = true; return g; }\nfunction __sb0(kind, { plinth = 5, apron = -1.2, departures = null, name = null } = {}) {'],
      ['export function stationCanopy(len, width, { platform = 1 } = {}) {',
        'export function stationCanopy(len, width, o = {}) { const g = __sc0(len, width, o); g.userData.slRail = true; return g; }\nfunction __sc0(len, width, { platform = 1 } = {}) {'],
      // its colliders and walkable paving go to the exporter
      ['export function registerStation(plan, origin, az, colliders, { zOff = 0 } = {}) {',
        'export function registerStation(plan, origin, az, colliders, o = {}) { return globalThis.__slRegStation ? globalThis.__slRegStation(() => __rs0(plan, origin, az, globalThis.__slRailCols, o)) : __rs0(plan, origin, az, colliders, o); }\nfunction __rs0(plan, origin, az, colliders, { zOff = 0 } = {}) {'],
    ],
  },
  {
    // the helipad's deck (heli/pad.js padTexture) paints its concrete and the snow blown onto its rim pixel by pixel
    // (a noise canvas scaled up, getImageData / putImageData): the recorder has no pixels, so the same picture in
    // drawing commands: the concrete's mean grey under the grain it speckles on, the snow as rings thickening to the rim
    file: '/src/game/heli/pad.js',
    edits: [
      ['  g.imageSmoothingEnabled = true;\n  g.drawImage(n, 0, 0, S, S);', "  g.imageSmoothingEnabled = true;\n  g.fillStyle = 'rgb(112,117,123)'; g.fillRect(0, 0, S, S);"],
      ['  g.putImageData(snow, 0, 0);\n', "  for (let k = 0; k < 16; k++) { const rr = 0.83 + ((k + 0.5) * 0.17) / 16, cv = ((rr - 0.83) / 0.17) * 0.85; g.strokeStyle = 'rgba(240,245,252,' + (cv * cv * 0.87).toFixed(3) + ')'; g.lineWidth = (h * 0.17) / 16 + 1; g.beginPath(); g.arc(h, h, rr * h, 0, Math.PI * 2); g.stroke(); }\n"],
    ],
  },
  {
    // the ward's BESUCHSZEIT board (hospitalroom.js board): its cream paper is a gradient fill, which the recorded
    // canvas has no pixels for: the gradient's middle as a plain fill
    file: '/src/game/hospitalroom.js',
    edits: [
      ["      const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#f8f6f0'); bg.addColorStop(1, '#ece8de');\n      g.fillStyle = bg; g.fillRect(0, 0, w, h);",
        "      g.fillStyle = '#f2efe7'; g.fillRect(0, 0, w, h);"],
    ],
  },
];

export async function load(url, context, nextLoad) {
  // (stylesheets the UI modules import: nothing in Node)
  if (/\.(css|svg|png|jpe?g|webp)(\?.*)?$/.test(url)) return { format: 'module', source: 'export default "";', shortCircuit: true };
  const r = await nextLoad(url, context);
  const p = PATCHES.find((q) => url.endsWith(q.file));
  if (!p) return r;
  let src = String(r.source).replace(/\r\n/g, "\n"); // (a Windows checkout has CRLF line endings: the anchors are written with \n)
  for (const [a, b] of p.edits) {
    if (!src.includes(a)) throw new Error(`resort_hooks: patch anchor not found in ${p.file}: ${a.slice(0, 60)}`);
    src = src.replace(a, b);
  }
  return { ...r, source: src, shortCircuit: true };
}
