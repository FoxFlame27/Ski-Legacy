// Node module loader hooks for export_resort.mjs: small source patches applied while the game's own modules load, so
// the exporter can tell which GLB (and which fit) every mesh in the built scene came from, and which materials glow
// at night. Nothing here changes what the game builds; it only tags it.
const PATCHES = [
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
    edits: [['    const m = o.material.clone();\n    m.onBeforeCompile', '    const m = o.material.clone();\n    m.userData.slGlow = strength;\n    m.onBeforeCompile']],
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
