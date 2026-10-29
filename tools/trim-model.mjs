// Cut unwanted parts out of a Meshy GLB (stray flags, ground discs) by deleting triangles.
//   node tools/trim-model.mjs in.glb out.glb [--above Y] [--below Y --keep minx,maxx,minz,maxz]
//   --above Y        delete triangles with any vertex higher than Y (model units)
//   --below Y        delete triangles lying entirely below Y ...
//   --keep rect      ... unless their centroid is inside this XZ rectangle (the building footprint)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [src, dst] = process.argv.slice(2, 4);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const above = arg('--above') !== null ? +arg('--above') : Infinity;
const below = arg('--below') !== null ? +arg('--below') : -Infinity;
const keep = arg('--keep') ? arg('--keep').split(',').map(Number) : null;

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(src);
const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute('POSITION'), ind = prim.getIndices();
  const src = ind.getArray(), out = [];
  for (let t = 0; t < src.length; t += 3) {
    pos.getElement(src[t], a); pos.getElement(src[t + 1], b); pos.getElement(src[t + 2], c);
    const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    if (Math.max(a[1], b[1], c[1]) > above) continue;
    const low = Math.max(a[1], b[1], c[1]) < below;
    const inKeep = keep && cx >= keep[0] && cx <= keep[1] && cz >= keep[2] && cz <= keep[3];
    if (low && !inKeep) continue;
    out.push(src[t], src[t + 1], src[t + 2]);
  }
  console.log(`${mesh.getName() || 'mesh'}: ${src.length / 3} -> ${out.length / 3} triangles`);
  ind.setArray(new Uint32Array(out));
  compactPrimitive(prim);
}
await doc.transform(prune());
await io.write(dst, doc);
