// Remove baked-in rotor blades from a helicopter model, keeping the hub, so the game can spin its own.
//   node tools/cut-rotor.mjs in.glb out.glb [bladeY] [hubRadius]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, prune } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';

const [src, dst] = process.argv.slice(2, 4);
const bladeY = +(process.argv[4] ?? 0.265), hubR = +(process.argv[5] ?? 0.07);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
const p = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute('POSITION'), ind = prim.getIndices(), idx = ind.getArray();
  // hub = centre of the blade layer (the blades are symmetric about it)
  let sx = 0, sz = 0, n = 0;
  for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, p); if (p[1] > bladeY + 0.02) { sx += p[0]; sz += p[2]; n++; } }
  const hx = sx / n, hz = sz / n;
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    pos.getElement(idx[t], a); pos.getElement(idx[t + 1], b); pos.getElement(idx[t + 2], c);
    const cy = (a[1] + b[1] + c[1]) / 3, cx = (a[0] + b[0] + c[0]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    if (cy > bladeY && Math.hypot(cx - hx, cz - hz) > hubR) continue;
    out.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  console.log(`hub at x ${hx.toFixed(3)} z ${hz.toFixed(3)} (y > ${bladeY}): ${idx.length / 3} -> ${out.length / 3} triangles`);
  ind.setArray(new Uint32Array(out));
  compactPrimitive(prim);
}
await doc.transform(prune());
await io.write(dst, doc);
