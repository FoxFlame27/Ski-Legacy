// The Legacy Express's own cabin furnishing (user Oct 31 2026: "the interior of the train is very ugly, make it
// realistic, use Meshy models for the train interior"). buildCar({ express: true }) leaves out the Wolkenspitzbahn's
// box tables and wire racks; here: rounded laminate tables, aluminium luggage racks with a glass shelf over the
// windows, and, once their GLBs are in (public/models/train, tools/meshy-train-interior.mjs), the Meshy intercity
// double seat instanced on every seat pair (instead of the coach seats) and the Meshy rack once per bay. Missing
// models: the procedural version stays. Seat positions (cabin.seats) never change.
import * as THREE from 'three';
import { loadGLB, bakeGeometry } from '../core/assets.js';
import { CAR, CABIN, trainUniforms } from './train.js';

// the cabin's warm self-light (the same patch as train.js's seats), so the new pieces match the lit cabin
function cabinLit(mat, key) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCabin = trainUniforms.uCabin;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uCabin;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.68) * 0.55 * uCabin;`);
  };
  mat.customProgramCacheKey = () => `express-${key}`;
  return mat;
}

function roundedRect(w, d, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

const F = CAR.floor;
const RACK_Y = CAR.winHi - 0.04;
const bayZs = () => Array.from({ length: CABIN.BAYS_N }, (_, b) => CABIN.BAYS_Z0 + b * CABIN.BAY);

export function furnishExpress(cabin) {
  const seatMeshes = cabin.group.userData.seatMeshes || [];
  const parent = seatMeshes[0]?.parent || cabin.group;
  const root = new THREE.Group(); root.name = 'express-interior';
  parent.add(root);
  const { W, BAY } = CABIN;

  // ---- tables: rounded laminate tops with a dark edge band, one pedestal each (a table at every bay's window)
  const top = new THREE.ExtrudeGeometry(roundedRect(0.44, 0.56, 0.07), { depth: 0.022, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 3, curveSegments: 6 });
  top.rotateX(-Math.PI / 2);
  const leg = new THREE.CylinderGeometry(0.022, 0.03, 0.6, 10); leg.translate(0, -0.33, 0);
  const tableMat = cabinLit(new THREE.MeshStandardMaterial({ color: '#cfcac1', roughness: 0.45 }), 'table');
  const legMat = cabinLit(new THREE.MeshStandardMaterial({ color: '#8e939a', metalness: 0.7, roughness: 0.35 }), 'metal');
  const tablePos = [];
  for (const zb of bayZs()) for (const s of [1, -1]) tablePos.push([s * (W - 0.24), F + 0.73, zb + BAY / 2]);
  const tops = new THREE.InstancedMesh(top, tableMat, tablePos.length), legs = new THREE.InstancedMesh(leg, legMat, tablePos.length);
  const m4 = new THREE.Matrix4();
  tablePos.forEach((p, i) => { m4.makeTranslation(p[0], p[1], p[2]); tops.setMatrixAt(i, m4); legs.setMatrixAt(i, m4); });
  tops.receiveShadow = legs.receiveShadow = true;
  root.add(tops, legs);

  // ---- luggage racks over the side windows: wall brackets at every bay seam, two aluminium tubes, a glass shelf
  const rack = new THREE.Group(); rack.name = 'express-racks-proc';
  const z0 = CABIN.BAYS_Z0, z1 = CABIN.BAYS_Z0 + CABIN.BAYS_N * BAY, len = z1 - z0;
  const alu = cabinLit(new THREE.MeshStandardMaterial({ color: '#c4c9cf', metalness: 0.8, roughness: 0.3 }), 'alu');
  const glass = new THREE.MeshStandardMaterial({ color: '#9fb4c4', metalness: 0.1, roughness: 0.08, transparent: true, opacity: 0.35, depthWrite: false });
  const tube = new THREE.CylinderGeometry(0.014, 0.014, len, 8); tube.rotateX(Math.PI / 2);
  const shelf = new THREE.BoxGeometry(0.34, 0.01, len);
  const bracket = new THREE.BoxGeometry(0.36, 0.05, 0.025);
  for (const s of [1, -1]) {
    const xw = s * (CABIN.HW - 0.06), xf = s * (CABIN.HW - 0.42), zc = (z0 + z1) / 2;
    const sh = new THREE.Mesh(shelf, glass); sh.position.set((xw + xf) / 2, RACK_Y, zc); sh.renderOrder = 2; rack.add(sh);
    for (const [x, y] of [[xf, RACK_Y + 0.01], [xf, RACK_Y + 0.09], [xw - s * 0.02, RACK_Y + 0.01]]) { const t = new THREE.Mesh(tube, alu); t.position.set(x, y, zc); rack.add(t); }
    for (let z = z0; z <= z1 + 0.01; z += BAY) {
      const b = new THREE.Mesh(bracket, alu); b.position.set((xw + xf) / 2, RACK_Y - 0.025, z); b.rotation.z = s * 0.25; rack.add(b);
    }
  }
  root.add(rack);

  // ---- the Meshy pieces, when their GLBs are there
  loadGLB('train/train_double_seat').then((g) => { if (g) meshySeats(cabin, g, seatMeshes, root); }).catch(() => {});
  loadGLB('train/train_luggage_rack').then((g) => { if (g) meshyRacks(g, rack, root); }).catch(() => {});
}

// which way a seat model faces: away from its backrest (the side holding most of the geometry high up)
function facingSign(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox, pos = geo.attributes.position, yCut = bb.min.y + 0.7 * (bb.max.y - bb.min.y);
  let z = 0, n = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > yCut) { z += pos.getZ(i); n++; }
  return n && z / n > (bb.min.z + bb.max.z) / 2 ? -1 : 1; // backrest towards +z -> faces -z
}

// the double seat on every seat pair (seats.inst holds the pair's two places one after the other)
function meshySeats(cabin, gltf, seatMeshes, root) {
  const b = bakeGeometry(gltf, { size: 1.22, axis: 'y' });
  if (!b?.geometry) return;
  const geo = b.geometry.clone();
  geo.computeBoundingBox();
  let bb = geo.boundingBox;
  // its long side across the car (x), facing +z, centred on its footprint, standing on y 0
  if (bb.max.z - bb.min.z > bb.max.x - bb.min.x) geo.rotateY(Math.PI / 2);
  if (facingSign(geo) < 0) geo.rotateY(Math.PI);
  geo.computeBoundingBox(); bb = geo.boundingBox;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const sx = 0.96 / (bb.max.x - bb.min.x), sz = Math.min(1.2, 0.62 / (bb.max.z - bb.min.z));
  geo.scale(sx, 1, sz);
  const inst = cabin.seats.inst || [], pairs = [];
  for (let i = 0; i + 1 < inst.length; i += 2) pairs.push({ x: (inst[i].x + inst[i + 1].x) / 2, y: inst[i].y, z: inst[i].z, yaw: inst[i].yaw });
  if (!pairs.length) return;
  const mat = cabinLit(b.material.clone(), 'meshy-seat');
  const mesh = new THREE.InstancedMesh(geo, mat, pairs.length);
  const o = new THREE.Object3D();
  pairs.forEach((p, i) => { o.position.set(p.x, p.y, p.z - Math.cos(p.yaw) * 0.04); o.rotation.set(0, p.yaw, 0); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix); });
  mesh.receiveShadow = true; mesh.name = 'express-meshy-seats';
  root.add(mesh);
  for (const sm of seatMeshes) sm.visible = false;
}

// the Meshy rack once per bay on both sides (instead of the procedural tubes and glass)
function meshyRacks(gltf, procRack, root) {
  const b = bakeGeometry(gltf, { size: 1, axis: 'y' });
  if (!b?.geometry) return;
  const geo = b.geometry.clone();
  geo.computeBoundingBox();
  let bb = geo.boundingBox;
  if (bb.max.x - bb.min.x > bb.max.z - bb.min.z) geo.rotateY(Math.PI / 2); // (its length along the car)
  geo.computeBoundingBox(); bb = geo.boundingBox;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
  geo.scale(0.36 / (bb.max.x - bb.min.x), 0.14 / (bb.max.y - bb.min.y), (CABIN.BAY - 0.04) / (bb.max.z - bb.min.z));
  const mat = cabinLit(b.material.clone(), 'meshy-rack');
  const mesh = new THREE.InstancedMesh(geo, mat, CABIN.BAYS_N * 2);
  const o = new THREE.Object3D();
  let i = 0;
  for (const zb of bayZs()) for (const s of [1, -1]) {
    o.position.set(s * (CABIN.HW - 0.24), RACK_Y + 0.02, zb + CABIN.BAY / 2);
    o.rotation.set(0, s > 0 ? 0 : Math.PI, 0); o.updateMatrix(); mesh.setMatrixAt(i++, o.matrix);
  }
  mesh.name = 'express-meshy-racks';
  root.add(mesh);
  procRack.visible = false;
}
