// Checks the Legacy Express's Meshy rack placement (src/world/expressinterior.js) on the real GLB, without a browser:
// node tools/check-express-interior.mjs  -> its wall side on the car wall, inside the cabin, over the windows, one per bay.
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { rackGeometry, rackPlace, RACK_FIT } from '../src/world/expressinterior.js';
import { CAR, CABIN } from '../src/world/train.js';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(new URL('../public/models/train/train_luggage_rack.glb', import.meta.url).pathname);
const P = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const M = new THREE.Matrix4().fromArray(node.getWorldMatrix()), v = new THREE.Vector3(), p = [0, 0, 0];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), idx = prim.getIndices();
    for (let t = 0; t < idx.getCount(); t++) { pos.getElement(idx.getScalar(t), p); v.fromArray(p).applyMatrix4(M); P.push(v.x, v.y, v.z); }
  }
}
const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
rackGeometry(geo);
geo.computeBoundingBox();
const bb = geo.boundingBox, fails = [];
const ok = (c, msg) => { if (!c) fails.push(msg); };
const size = bb.getSize(new THREE.Vector3());
console.log('rack in its own frame: x', bb.min.x.toFixed(3), bb.max.x.toFixed(3), 'y', bb.min.y.toFixed(3), bb.max.y.toFixed(3), 'z', bb.min.z.toFixed(3), bb.max.z.toFixed(3));
ok(Math.abs(size.x - RACK_FIT.depth) < 1e-3 && Math.abs(size.z - (CABIN.BAY - 0.04)) < 1e-3, 'depth / length');
ok(Math.abs(bb.max.x) < 1e-4 && Math.abs(bb.min.y) < 1e-4, 'wall side at x 0, standing on y 0');
// the tall parts (wall plate, brackets) on the wall side, the shelf at the bottom reaching inwards
const pos = geo.attributes.position; let hi = 0, nHi = 0, lo = 0, nLo = 0;
for (let i = 0; i < pos.count; i++) {
  const y = pos.getY(i), x = pos.getX(i);
  if (y > 0.6 * size.y) { hi += x; nHi++; } else if (y < 0.25 * size.y) { lo += x; nLo++; }
}
console.log('mean x: upper part', (hi / nHi).toFixed(3), 'shelf', (lo / nLo).toFixed(3), '(wall at 0, inwards negative)');
ok(hi / nHi > -size.x / 2, 'upper part towards the wall');
// placed: every bay, both sides, inside the car, above the windows, under the ceiling coves
const o = new THREE.Object3D(), box = new THREE.Box3();
let n = 0;
for (let b = 0; b < CABIN.BAYS_N; b++) for (const s of [1, -1]) {
  const zb = CABIN.BAYS_Z0 + b * CABIN.BAY, p = rackPlace(s, zb);
  o.position.set(p.x, p.y, p.z); o.rotation.set(0, p.yaw, 0); o.updateMatrixWorld();
  box.copy(bb).applyMatrix4(o.matrixWorld); n++;
  const wallSide = s > 0 ? box.max.x : -box.min.x;
  ok(Math.abs(wallSide - (CABIN.HW - 0.06)) < 1e-3, `rack ${b}/${s} wall side ${wallSide.toFixed(3)}`);
  ok(Math.abs(s > 0 ? box.min.x : box.max.x) > CABIN.CEIL_X - 0.05, `rack ${b}/${s} clear of the aisle`);
  ok(box.min.y >= CAR.winHi - 0.06 && box.max.y < CABIN.CEIL_Y - 0.05, `rack ${b}/${s} height ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`);
  ok(box.min.z >= zb - 1e-3 && box.max.z <= zb + CABIN.BAY + 1e-3, `rack ${b}/${s} within its bay`);
  if (b === 0) console.log(`bay 0 side ${s}: x ${box.min.x.toFixed(3)}..${box.max.x.toFixed(3)} y ${box.min.y.toFixed(3)}..${box.max.y.toFixed(3)} z ${box.min.z.toFixed(3)}..${box.max.z.toFixed(3)}`);
}
console.log(`${n} racks per car (${CABIN.BAYS_N} bays x 2 sides)`);
if (fails.length) { console.log('FAIL\n ' + fails.join('\n ')); process.exit(1); }
console.log('OK');
