// List connected components (welded by position) of a GLB: node tools/glb-components.mjs file.glb [limit]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const limit = +(process.argv[3] || 40);
export function components(prim) {
  const pos = prim.getAttribute('POSITION'), idx = prim.getIndices().getArray();
  const n = pos.getCount(), p = [0, 0, 0];
  const key = new Map(), canon = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    pos.getElement(i, p);
    const k = p.map((v) => Math.round(v * 1e4)).join(',');
    if (!key.has(k)) key.set(k, i);
    canon[i] = key.get(k);
  }
  const par = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(canon[idx[t]]), b = find(canon[idx[t + 1]]), c = find(canon[idx[t + 2]]);
    par[b] = a; par[find(c)] = a;
  }
  const comps = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(canon[idx[t]]);
    let c = comps.get(r);
    if (!c) comps.set(r, (c = { tris: [], min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] }));
    c.tris.push(t);
    for (let k = 0; k < 3; k++) { pos.getElement(idx[t + k], p); for (let j = 0; j < 3; j++) { c.min[j] = Math.min(c.min[j], p[j]); c.max[j] = Math.max(c.max[j], p[j]); } }
  }
  return [...comps.values()].sort((a, b) => b.tris.length - a.tris.length);
}
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const comps = components(prim);
  console.log('components', comps.length);
  comps.slice(0, limit).forEach((c, i) => console.log(i, c.tris.length, 'min', c.min.map((v) => v.toFixed(2)).join(','), 'max', c.max.map((v) => v.toFixed(2)).join(',')));
}
