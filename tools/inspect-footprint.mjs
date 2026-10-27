// ASCII top-down occupancy of a GLB's vertices within a height band: node tools/inspect-footprint.mjs file.glb ymin ymax
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const y0 = +process.argv[3], y1 = +process.argv[4];
const N = 40, grid = Array.from({ length: N }, () => new Array(N).fill(0));
const p = [0, 0, 0];
for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute('POSITION');
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, p);
    if (p[1] < y0 || p[1] > y1) continue;
    const gx = Math.floor((p[0] + 1) / 2 * N), gz = Math.floor((p[2] + 1) / 2 * N);
    if (gx >= 0 && gx < N && gz >= 0 && gz < N) grid[gz][gx]++;
  }
}
for (const row of grid) console.log(row.map((c) => (c === 0 ? '.' : c < 5 ? ':' : c < 30 ? '+' : '#')).join(''));
