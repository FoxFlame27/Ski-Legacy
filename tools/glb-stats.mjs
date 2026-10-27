// Percentiles of vertex height inside/outside an XZ rectangle: node tools/glb-stats.mjs file.glb minx maxx minz maxz
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const [minx, maxx, minz, maxz] = process.argv.slice(3, 7).map(Number);
const ins = [], out = [];
const p = [0, 0, 0];
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute('POSITION');
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, p);
    (p[0] >= minx && p[0] <= maxx && p[2] >= minz && p[2] <= maxz ? ins : out).push(p[1]);
  }
}
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]?.toFixed(3); };
for (const [name, a] of [['inside', ins], ['outside', out]]) console.log(name, a.length, [0, 0.05, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1].map((q) => `${q}:${pct(a, q)}`).join(' '));
