// The bus depot as drawn (its plan and the buses' ways: depot.js): the paving (the roads' and car parks' own asphalt
// and snow, bus.js lotMaterial, the Depotweg carrying straight on into it at the mouth), the eight drive-through bays
// painted on it (white bay lines, a yellow number at each bay's entry), lamp posts along both long sides (lit at night)
// and a BUS DEPOT sign by the mouth. Everything standing is solid (colliders).
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { fitModel } from '../../core/assets.js';
import { nightUniform } from '../../world/village.js';
import { groundPatch, groundPatchGeometry, frameRect } from '../../world/groundpatch.js';
import { busRoads, ROAD_HALF, roadsideBlocked } from './roads.js';
import { DEPOT, bayV } from './depot.js';

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1f4fa8'; g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#ffffff'; g.lineWidth = 10; g.strokeRect(12, 12, 488, 232);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 84px Arial'; g.fillText('BUS DEPOT', 256, 100);
  g.font = 'bold 40px Arial'; g.fillText('Ski buses only', 256, 184);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function numberTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 1024, 128);
  g.fillStyle = '#f2c200'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 104px Arial';
  for (let k = 0; k < 8; k++) g.fillText(String(k + 1), 64 + k * 128, 68); // (bays 1-8: bus:0 in bay 1, bus:k in bay k + 1)
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Draw the depot (busRoads.depot) into group. */
export function buildDepot(group, { models = {}, colliders = null, surf }) {
  const D = busRoads.depot;
  if (!D) return;
  const L = D.lot, { HW, HD, UM, W, AU, R, BAYS } = DEPOT;
  const at = (u, v) => [L.x + L.ux * u + L.vx * v, L.z + L.uz * u + L.vz * v];
  const MH = (x, z) => (world.meshHeight ? world.meshHeight(x, z) : world.height(x, z));
  const toUV = (x, z) => { const dx = x - L.x, dz = z - L.z; return [dx * L.ux + dz * L.uz, dx * L.vx + dz * L.vz]; };
  const g = new THREE.Group();
  g.name = 'bus-depot';
  group.add(g);
  // the paving: its edges fading into the snow, but across the mouth (the Depotweg's asphalt carries on)
  const sg = groundPatchGeometry(frameRect(L.x, L.z, L.ux, L.uz, L.vx, L.vz, -HW, HW, -HD, HD), {
    lift: 0.035,
    uv: (x, z) => { const [u, v] = toUV(x, z); return [u / 6.8, v / 13.5]; },
    color: (x, z) => {
      const [u, v] = toUV(x, z), e = Math.min(HW - Math.abs(u), HD - Math.abs(v));
      const mouth = v < -HD + 6 ? 1 - Math.min(1, Math.max(0, (Math.abs(u - UM) - (ROAD_HALF - 1)) / 1.6)) : 0;
      const a = Math.max(Math.min(1, Math.max(0, e / 1.8)), mouth);
      return [1, 1, 1, a * a * (3 - 2 * a)];
    },
  });
  const surface = new THREE.Mesh(sg, surf);
  surface.receiveShadow = true;
  g.add(surface);
  // the bay lines (white, on the drawn terrain's own triangles, 2 cm over the paving) and a stop bar at each bay's
  // middle line ahead of the bus (yellow); the bays run between the aisles (u -BL..BL)
  const BL = AU - R, lp = [], li = [], yp = [], yi = [];
  const strip = (P, I, u0, v0, u1, v1, w) => {
    const du = u1 - u0, dv = v1 - v0, l = Math.hypot(du, dv) || 1, tu = du / l, tv = dv / l;
    const [cx, cz] = at(u0, v0), ex = L.ux * tu + L.vx * tv, ez = L.uz * tu + L.vz * tv;
    const { pos, idx } = groundPatch(frameRect(cx, cz, ex, ez, -ez, ex, 0, l, -w / 2, w / 2), { lift: 0.055, height: MH });
    const base = P.length / 3;
    for (const q of pos) P.push(q);
    for (const q of idx) I.push(base + q);
  };
  for (let k = 0; k <= BAYS; k++) strip(lp, li, -BL, bayV(k) - W / 2, BL, bayV(k) - W / 2, 0.14);
  for (let k = 0; k < BAYS; k++) strip(yp, yi, -6.6, bayV(k) - 1.0, -6.6, bayV(k) + 1.0, 0.25); // (where the front stops)
  const paint = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
  for (const [P, I, col] of [[lp, li, 0xeeefea], [yp, yi, 0xf2c200]]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setIndex(I); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, paint(col));
    m.receiveShadow = true;
    g.add(m);
  }
  // the bay numbers, at the bay's entry (the right aisle side), read by a driver turning in
  const numTex = numberTexture(), nm = new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  for (let k = 0; k < BAYS; k++) {
    const [x, z] = at(BL - 1.6, bayV(k));
    const geo = new THREE.PlaneGeometry(1.6, 1.6);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (k + uv.getX(i)) / 8);
    const m = new THREE.Mesh(geo, nm);
    m.rotation.order = 'YXZ';
    m.rotation.set(-Math.PI / 2, Math.atan2(-L.ux, -L.uz), 0); // (upright for a bus coming in along -u)
    m.position.set(x, MH(x, z) + 0.07, z);
    g.add(m);
  }
  // lamp posts along both long sides, their bulbs glowing at night
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffd59a, emissiveIntensity: 0, roughness: 0.4 });
  const bulbGeo = new THREE.SphereGeometry(0.16, 10, 8);
  let first = true;
  for (let k = 0; k < 4; k++) {
    const v = -HD + 6 + (k / 3) * (2 * HD - 12);
    for (const side of [-1, 1]) {
      const [x, z] = at(side * (HW + 0.9), v);
      if (roadsideBlocked(x, z, 0.4, -1, 0, { lots: false })) continue;
      const y = world.height(x, z);
      if (models.lamp_post) {
        const m = fitModel(models.lamp_post, { size: 5.6, axis: 'y' });
        m.position.set(x, y - 0.02, z);
        m.rotation.y = Math.atan2(-L.ux * side, -L.uz * side);
        m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        g.add(m);
      } else {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 5.4, 8), new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6 }));
        pole.position.set(x, y + 2.7, z);
        g.add(pole);
      }
      const b = new THREE.Mesh(bulbGeo, bulbMat);
      b.position.set(x - L.ux * side * 0.35, y + 5.15, z - L.uz * side * 0.35);
      if (first) { first = false; b.onBeforeRender = () => { const n = nightUniform?.value ?? 0; bulbMat.emissiveIntensity = n > 0.15 ? 2.5 * Math.min(1, n * 1.4) : 0; }; }
      g.add(b);
      colliders?.push({ x, z, r: 0.3 });
    }
  }
  // the BUS DEPOT sign: a board on two posts beside the mouth, facing the Depotweg's traffic coming up
  const [sx, sz] = at(UM + ROAD_HALF + 3.2, -HD - 2.5);
  const sy = world.height(sx, sz), yaw = Math.atan2(-L.vx, -L.vz);
  const sign = new THREE.Group();
  const post = new THREE.MeshStandardMaterial({ color: 0x8c9096, metalness: 0.5, roughness: 0.45 });
  for (const o of [-0.85, 0.85]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8), post);
    p.position.set(o, 1.3, 0);
    p.castShadow = true;
    sign.add(p);
  }
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 0.06), [post, post, post, post, new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.5 }), post]);
  board.position.set(0, 2.15, 0.06);
  board.castShadow = true;
  sign.add(board);
  sign.position.set(sx, sy - 0.03, sz);
  sign.rotation.y = yaw;
  g.add(sign);
  colliders?.push({ x: sx, z: sz, hw: 1.15, hd: 0.15, rot: -yaw, soft: true });
}
