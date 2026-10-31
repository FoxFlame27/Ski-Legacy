// Checks the Legacy Express's Meshy double seat (src/world/expressinterior.js: seatGeometry / seatPairs) on the real
// GLB, without a browser (user Oct 31 2026: "TWO seats side by side on one shared base ... wire it into
// expressinterior.js as the coach seat pair"): node tools/check-express-seat.mjs
//  -> two backrests side by side (not one behind the other), backs on -z (facing +z like the seats), sized to the
//     procedural pair, the cushion at the seats' surface height; placed on every pair, clear of the aisle and walls,
//     each facing the way its seats face, never into the tables.
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { seatGeometry, seatPairs, SEAT_FIT } from '../src/world/expressinterior.js';
import { buildCar, CAR, CABIN } from '../src/world/train.js';
import { COACH_SEAT } from '../src/world/coachseat.js';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(new URL('../public/models/train/train_double_seat.glb', import.meta.url).pathname);
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
geo.computeBoundingBox();
const raw = geo.boundingBox.getSize(new THREE.Vector3());
console.log('raw size', raw.toArray().map((v) => v.toFixed(3)).join(' x '));
seatGeometry(geo);
const bb = geo.boundingBox, size = bb.getSize(new THREE.Vector3()), fails = [];
const ok = (c, msg) => { if (!c) fails.push(msg); };
console.log('fitted: x', bb.min.x.toFixed(3), bb.max.x.toFixed(3), 'y', bb.min.y.toFixed(3), bb.max.y.toFixed(3), 'z', bb.min.z.toFixed(3), bb.max.z.toFixed(3));
ok(Math.abs(size.x - SEAT_FIT.width) < 1e-3 && Math.abs(size.y - SEAT_FIT.height) < 1e-3 && Math.abs(bb.min.z - SEAT_FIT.z0) < 1e-3 && Math.abs(bb.max.z - SEAT_FIT.z1) < 1e-3, 'fitted size');
ok(Math.max(raw.x, raw.z) / Math.min(raw.x, raw.z) > 1.35, 'wider than deep (a side-by-side pair)');
// the backrests: the upper third, along x: two clusters with a gap at the middle; their z towards -z
const pos = geo.attributes.position, B = 20, hist = new Array(B).fill(0);
let zHi = 0, nHi = 0;
for (let i = 0; i < pos.count; i++) {
  const y = pos.getY(i);
  if (y < 0.7 * size.y) continue;
  hist[Math.min(B - 1, Math.floor((pos.getX(i) - bb.min.x) / size.x * B))]++; zHi += pos.getZ(i); nHi++;
}
console.log('backrests across x:', hist.map((c) => (c ? (c > 30 ? '#' : '+') : '.')).join(''));
const mid = hist.slice(8, 12).reduce((a, b) => a + b, 0), left = hist.slice(0, 8).reduce((a, b) => a + b, 0), right = hist.slice(12).reduce((a, b) => a + b, 0);
ok(left > 4 * mid && right > 4 * mid, 'two backrests side by side (a gap between them)');
console.log('backrests mean z', (zHi / nHi).toFixed(3), '(the seat faces +z: the backs negative)');
ok(zHi / nHi < (bb.min.z + bb.max.z) / 2, 'backs on -z');
// the cushion height: the highest geometry over the front of each seat's middle (no backrest, no armrest there)
let cush = 0;
for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > 0.0 && pos.getZ(i) < 0.18 && Math.abs(Math.abs(pos.getX(i)) - 0.235) < 0.07) cush = Math.max(cush, pos.getY(i));
console.log('cushion top', cush.toFixed(3), 'procedural surface', COACH_SEAT.surface);
ok(cush > COACH_SEAT.surface - 0.12 && cush < COACH_SEAT.surface + 0.2, 'cushion height');
// placed on every pair of a real cabin
const car = buildCar({ express: true }), pairs = seatPairs(car.seats);
ok(pairs.length * 2 === car.seats.length, `${pairs.length} pairs for ${car.seats.length} seats`);
const o = new THREE.Object3D(), box = new THREE.Box3();
const tables = [];
for (let b = 0; b < CABIN.BAYS_N; b++) for (const s of [1, -1]) tables.push({ x: s * (CABIN.W - 0.24), z: CABIN.BAYS_Z0 + b * CABIN.BAY + CABIN.BAY / 2 });
for (const p of pairs) {
  o.position.set(p.x, p.y, p.z); o.rotation.set(0, p.yaw, 0); o.updateMatrixWorld();
  box.copy(bb).applyMatrix4(o.matrixWorld);
  const tag = `pair at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`;
  ok(Math.min(Math.abs(box.min.x), Math.abs(box.max.x)) >= CAR.aisle - 0.01, `${tag} in the aisle`);
  ok(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) <= CABIN.HW - 0.02, `${tag} through the car's side`);
  ok(Math.abs(box.min.y - CAR.floor) < 1e-3, `${tag} on the floor`);
  const seatsHere = car.seats.filter((st) => Math.abs(st.pos.z - p.z) < 1e-3 && Math.sign(st.pos.x) === Math.sign(p.x));
  ok(seatsHere.length === 2 && seatsHere.every((st) => st.yaw === p.yaw), `${tag} faces its seats`);
  for (const t of tables) if (Math.sign(t.x) === Math.sign(p.x)) ok(box.max.z <= t.z - 0.28 + 0.02 || box.min.z >= t.z + 0.28 - 0.02, `${tag} into a table`);
}
console.log(`${pairs.length} Meshy seat pairs per car`);
if (fails.length) { console.log('FAIL\n ' + fails.join('\n ')); process.exit(1); }
console.log('OK');
