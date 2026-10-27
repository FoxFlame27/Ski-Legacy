// Keep only the biggest connected part of a GLB (drops stray floating bits Meshy sometimes adds).
//   node tools/keep-largest.mjs in.glb out.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, prune } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';

const [src, dst] = process.argv.slice(2, 4);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
const p = [0, 0, 0];
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute('POSITION'), ind = prim.getIndices(), idx = ind.getArray();
  // weld by position so UV seams don't split a part, then union-find over triangles
  const n = pos.getCount(), key = new Map(), canon = new Int32Array(n);
  for (let i = 0; i < n; i++) { pos.getElement(i, p); const k = p.map((v) => Math.round(v * 1e4)).join(','); if (!key.has(k)) key.set(k, i); canon[i] = key.get(k); }
  const par = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < idx.length; t += 3) { const a = find(canon[idx[t]]); par[find(canon[idx[t + 1]])] = a; par[find(canon[idx[t + 2]])] = a; }
  const count = new Map();
  for (let t = 0; t < idx.length; t += 3) { const r = find(canon[idx[t]]); count.set(r, (count.get(r) || 0) + 1); }
  const best = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const out = [];
  for (let t = 0; t < idx.length; t += 3) if (find(canon[idx[t]]) === best) out.push(idx[t], idx[t + 1], idx[t + 2]);
  console.log(`${mesh.getName() || 'mesh'}: ${idx.length / 3} -> ${out.length / 3} triangles (${count.size} parts)`);
  ind.setArray(new Uint32Array(out));
  compactPrimitive(prim);
}
await doc.transform(prune());
await io.write(dst, doc);
