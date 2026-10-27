import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const n = pos.getCount();
    let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
    const p = [0,0,0];
    const ys = [];
    for (let i = 0; i < n; i++) { pos.getElement(i, p); for (let k=0;k<3;k++){mn[k]=Math.min(mn[k],p[k]);mx[k]=Math.max(mx[k],p[k]);} ys.push(p[1]); }
    console.log(mesh.getName(), 'verts', n, 'tris', prim.getIndices()?.getCount()/3, 'min', mn.map(v=>v.toFixed(3)), 'max', mx.map(v=>v.toFixed(3)));
    // histogram of y
    const B = 30, h = new Array(B).fill(0);
    for (const y of ys) h[Math.min(B-1, Math.floor((y-mn[1])/(mx[1]-mn[1])*B))]++;
    h.forEach((c,i)=>console.log((mn[1]+(i+0.5)*(mx[1]-mn[1])/B).toFixed(3), c));
  }
}
for (const node of doc.getRoot().listNodes()) console.log('node', node.getName(), node.getTranslation(), node.getScale(), node.getRotation());
