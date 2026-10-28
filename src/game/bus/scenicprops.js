// The scenic roads' furniture (bus.js BusLine builds it once, after the roads and their guardrails):
//   - the lay-bys on the climbs and the viewpoint car parks: benches facing the view, a panorama board, a low dry-stone
//     wall (snow on its top) along the drop
//   - every roundabout arm: a give-way triangle under a blue roundabout disc on a grey post, on the right of the way in
//   - every roundabout island (the carved snow dome): a small spruce, a wooden fingerpost and a few boulders
// All of it merged by material into a handful of meshes (one draw call each), the walls also line colliders for your
// car (busRoads.rails, as the guardrails) and soft boxes for everything else.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from '../../world/world.js';
import { busRoads, roadAt, ROAD_HALF, laneDistance } from './roads.js';

const rnd = (i) => { const v = Math.sin(i * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

function canvasTex(w, h, draw) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const giveWayTex = () => canvasTex(128, 128, (g, w) => {
  g.clearRect(0, 0, w, w);
  const tri = (inset, col) => { g.beginPath(); g.moveTo(inset * 1.15, inset * 0.75 + 8); g.lineTo(w - inset * 1.15, inset * 0.75 + 8); g.lineTo(w / 2, w - 6 - inset * 1.3); g.closePath(); g.fillStyle = col; g.fill(); };
  g.lineJoin = 'round';
  tri(2, '#c8102e'); tri(17, '#ffffff');
});
const roundTex = () => canvasTex(128, 128, (g, w) => {
  g.clearRect(0, 0, w, w);
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1f4fa8'; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff'; g.lineWidth = 9;
  for (let k = 0; k < 3; k++) { // three arrows chasing each other anticlockwise
    const a0 = (k * 2 * Math.PI) / 3 + 0.35, a1 = a0 + 1.45;
    g.beginPath(); g.arc(64, 64, 32, -a1, -a0); g.stroke();
    const hx = 64 + Math.cos(-a1) * 32, hz = 64 + Math.sin(-a1) * 32, tx = Math.sin(-a1), tz = -Math.cos(-a1);
    g.beginPath(); g.moveTo(hx + tx * 13, hz + tz * 13); g.lineTo(hx - tz * 11 - tx * 2, hz + tx * 11 - tz * 2); g.lineTo(hx + tz * 11 - tx * 2, hz - tx * 11 - tz * 2); g.closePath(); g.fill();
  }
});
const boardTex = () => canvasTex(256, 128, (g, w, h) => {
  g.fillStyle = '#5a3a22'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#f3ead8'; g.fillRect(8, 8, w - 16, h - 16);
  const sky = g.createLinearGradient(0, 12, 0, 80); sky.addColorStop(0, '#7fb0dc'); sky.addColorStop(1, '#d9e8f3');
  g.fillStyle = sky; g.fillRect(12, 12, w - 24, 70);
  // a range of peaks with snowy tops
  const peaks = [[12, 82], [40, 52], [62, 66], [96, 26], [128, 58], [150, 44], [178, 62], [206, 34], [232, 60], [244, 82]];
  g.fillStyle = '#6d7684'; g.beginPath(); g.moveTo(12, 82); for (const [x, y] of peaks) g.lineTo(x, y); g.lineTo(244, 82); g.closePath(); g.fill();
  g.fillStyle = '#ffffff';
  for (const [x, y] of peaks) if (y < 60) { g.beginPath(); g.moveTo(x, y); g.lineTo(x - (66 - y) * 0.45, 66); g.lineTo(x + (66 - y) * 0.45, 66); g.closePath(); g.fill(); }
  g.fillStyle = '#3d2b1c'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('PANORAMA', w / 2, 102);
});

/** Build the scenic roads' props into `group`. colliders: the scene's soft colliders (optional). -> { meshes, walls } */
export function buildScenicProps(group, { colliders = null } = {}) {
  const scenicRoads = busRoads.roads.filter((r) => r.scenic);
  if (!scenicRoads.length) return { meshes: 0, walls: 0 };
  const parts = new Map(); // material key -> [geometry...]
  const o = new THREE.Object3D();
  const put = (key, geo, x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1) => {
    o.position.set(x, y, z); o.rotation.set(0, yaw, 0); o.scale.set(sx, sy, sz); o.updateMatrix();
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(o.matrix);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!parts.has(key)) parts.set(key, []);
    parts.get(key).push(g);
  };
  const H = (x, z) => world.height(x, z);
  const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const merge = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));
  // ---- pieces (local frame: +z = the way it faces)
  const benchWood = merge([box(1.8, 0.05, 0.14, 0, 0.45, 0.12), box(1.8, 0.05, 0.14, 0, 0.45, -0.04), box(1.8, 0.05, 0.14, 0, 0.45, -0.2),
    box(1.8, 0.12, 0.04, 0, 0.62, -0.3), box(1.8, 0.12, 0.04, 0, 0.8, -0.3)]);
  const benchLeg = merge([-0.75, 0.75].flatMap((x) => [box(0.06, 0.45, 0.06, x, 0.22, 0.12), box(0.06, 0.85, 0.06, x, 0.42, -0.28), box(0.06, 0.05, 0.5, x, 0.42, -0.06)]));
  const boardPosts = merge([box(0.12, 1.9, 0.12, -0.95, 0.95, -0.05), box(0.12, 1.9, 0.12, 0.95, 0.95, -0.05), box(2.1, 0.14, 0.24, 0, 1.97, -0.02)]);
  const boardBack = box(2.0, 1.0, 0.05, 0, 1.35, -0.06);
  const boardFace = new THREE.PlaneGeometry(1.94, 0.97).translate(0, 1.35, -0.03);
  const signPole = new THREE.CylinderGeometry(0.04, 0.04, 2.6, 8).translate(0, 1.3, -0.04);
  const triFace = new THREE.PlaneGeometry(0.9, 0.9).translate(0, 1.55, 0);
  const discFace = new THREE.PlaneGeometry(0.7, 0.7).translate(0, 2.3, 0);
  const wallSeg = box(2.0, 0.62, 0.5, 0, 0.31, 0);
  const wallCap = box(2.02, 0.12, 0.56, 0, 0.66, 0);
  const trunk = new THREE.CylinderGeometry(0.09, 0.14, 1.2, 7).translate(0, 0.6, 0);
  const spruce = merge([new THREE.ConeGeometry(1.25, 1.9, 9).translate(0, 1.6, 0), new THREE.ConeGeometry(0.95, 1.6, 9).translate(0, 2.5, 0), new THREE.ConeGeometry(0.6, 1.3, 9).translate(0, 3.3, 0)]);
  const spruceSnow = merge([new THREE.ConeGeometry(0.8, 0.5, 9).translate(0, 2.35, 0), new THREE.ConeGeometry(0.55, 0.45, 9).translate(0, 3.1, 0), new THREE.ConeGeometry(0.3, 0.4, 9).translate(0, 3.85, 0)]);
  const fingerPost = box(0.12, 2.4, 0.12, 0, 1.2, 0);
  const finger = box(1.0, 0.18, 0.04, 0.5, 0, 0);
  const boulder = new THREE.IcosahedronGeometry(0.6, 0);

  // ---- a viewpoint: two benches either side of a panorama board, facing (fx, fz), a wall in front along the drop
  let walls = 0;
  const wall = (ax, az, bx, bz) => { // a dry-stone wall from a to b (2 m stones, each on the ground)
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 2)), yaw = Math.atan2(bx - ax, bz - az) + Math.PI / 2;
    let top = -Infinity;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = H(x, z) - 0.08, s = 0.9 + rnd(walls * 31 + k) * 0.25;
      put('stone', wallSeg, x, y, z, yaw + (rnd(k + walls) - 0.5) * 0.04, (L / n) / 2, s, 1);
      put('snow', wallCap, x, y + (s - 1) * 0.62, z, yaw, (L / n) / 2, 1, 1);
      top = Math.max(top, y + 0.62 * s);
    }
    if (busRoads.rails && busRoads.railGrid) { // the car's line collider (as a guardrail's)
      const k = busRoads.rails.push({ ax, az, bx, bz }) - 1, C = 16;
      for (let gx = Math.floor(Math.min(ax, bx) / C); gx <= Math.floor(Math.max(ax, bx) / C); gx++) for (let gz = Math.floor(Math.min(az, bz) / C); gz <= Math.floor(Math.max(az, bz) / C); gz++) {
        const key = gx * 100003 + gz;
        if (!busRoads.railGrid.has(key)) busRoads.railGrid.set(key, []);
        busRoads.railGrid.get(key).push(k);
      }
    }
    colliders?.push({ x: (ax + bx) / 2, z: (az + bz) / 2, hw: 0.28, hd: L / 2, rot: -Math.atan2(bx - ax, bz - az), h: 0.75, top: top + 0.12, soft: true, wall: true });
    walls++;
  };
  const viewpoint = (cx, cz, fx, fz, wallLen, wallOff) => {
    if (laneDistance(cx, cz) < 7) return false; // (another road's lane there: a switchback's leg, a junction)
    const yaw = Math.atan2(fx, fz), lx = fz, lz = -fx; // (facing the view; l: along the edge)
    for (const sd of [-1, 1]) {
      const x = cx + lx * sd * 2.6, z = cz + lz * sd * 2.6;
      put('wood', benchWood, x, H(x, z), z, yaw);
      put('iron', benchLeg, x, H(x, z), z, yaw);
    }
    put('wood', boardPosts, cx, H(cx, cz), cz, yaw + Math.PI); // (the board faces the benches' way back: read it, then turn round)
    put('board', boardBack, cx, H(cx, cz), cz, yaw + Math.PI);
    put('boardFace', boardFace, cx, H(cx, cz), cz, yaw + Math.PI);
    if (wallLen > 0) {
      const wx = cx + fx * wallOff, wz = cz + fz * wallOff;
      const clear = [-0.5, 0, 0.5].every((t) => laneDistance(wx + lx * wallLen * t, wz + lz * wallLen * t) > ROAD_HALF + 2.5);
      if (clear) wall(wx - lx * wallLen / 2, wz - lz * wallLen / 2, wx + lx * wallLen / 2, wz + lz * wallLen / 2);
    }
  };
  // the lay-bys: the shoulder is ~12.6 m from the centre line there (scenic.js shapeScenic): benches at 9.6 m
  const P = {};
  let views = 0;
  for (const lb of busRoads.laybys || []) {
    if (!lb.scenic) continue;
    const r = busRoads.roads[lb.ri];
    if (!r) continue;
    roadAt(r, lb.s, P);
    const fx = -P.dz * lb.side, fz = P.dx * lb.side; // (toward the view)
    if (viewpoint(P.x + fx * 9.4, P.z + fz * 9.4, fx, fz, 18, 2.3) !== false) views++;
  }
  // the scenic car parks: on the short end (or the far side) whose ground falls away most
  for (const L of busRoads.lots) {
    if (!L.scenic) continue;
    const sides = [[L.ux, L.uz, L.hw, L.hd], [-L.ux, -L.uz, L.hw, L.hd], [-L.vx, -L.vz, L.hd, L.hw]]; // (not the entrance side: +v)
    let best = null;
    for (const [nx, nz, h, w] of sides) {
      const g = H(L.x + nx * (h + 25), L.z + nz * (h + 25));
      if (!best || g < best.g) best = { nx, nz, h, w, g };
    }
    const { nx, nz, h, w } = best;
    const far = nx === -L.vx && nz === -L.vz; // (the far long side has a row of bays: the benches stand beyond it)
    const off = far ? h + 1.0 : h + 1.1;
    if (viewpoint(L.x + nx * off, L.z + nz * off, nx, nz, 2 * w + 1, 1.0) !== false) views++;
  }
  // ---- the roundabouts
  let signs = 0;
  for (const ring of busRoads.roundabouts || []) {
    for (const a of ring.arms || []) {
      const ox = Math.sin(a.ang), oz = Math.cos(a.ang); // (outward along the arm)
      const hx = -ox, hz = -oz, rx = -hz, rz = hx;     // (the way in, its right)
      const d = ring.R + 11, off = ROAD_HALF + 1.4;
      const x = ring.x + ox * d + rx * off, z = ring.z + oz * d + rz * off, y = H(x, z), yaw = Math.atan2(ox, oz);
      if (laneDistance(x, z) < ROAD_HALF + 0.8) continue; // (on another arm's lane)
      put('pole', signPole, x, y, z, yaw);
      put('giveWay', triFace, x, y, z, yaw);
      put('giveWayBack', triFace, x, y, z, yaw + Math.PI);
      put('round', discFace, x, y, z, yaw);
      put('roundBack', discFace, x, y, z, yaw + Math.PI);
      signs++;
    }
    // the island: a spruce on the snow dome's crown, a fingerpost toward the arms, boulders round its foot
    const cy = H(ring.x, ring.z);
    put('bark', trunk, ring.x, cy - 0.1, ring.z);
    put('spruce', spruce, ring.x, cy - 0.1, ring.z);
    put('snow', spruceSnow, ring.x, cy - 0.1, ring.z);
    const px = ring.x + 2.2, pz = ring.z - 1.4, py = H(px, pz) - 0.1;
    put('wood', fingerPost, px, py, pz);
    (ring.arms || []).forEach((a, k) => put('fingerBoard', finger, px, py + 2.05 - k * 0.24, pz, a.ang - Math.PI / 2));
    const n = 7;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rnd(k + ring.x) * 0.5, rr = (ring.islandR || ring.R - 4.1) - 1.6;
      const x = ring.x + Math.sin(a) * rr, z = ring.z + Math.cos(a) * rr, s = 0.55 + rnd(k * 7 + ring.z) * 0.5;
      put('rock', boulder, x, H(x, z) - 0.15, z, a * 3, s * 1.2, s * 0.7, s);
    }
  }
  // ---- the materials, one mesh each
  const gw = giveWayTex(), rt = roundTex(), bt = boardTex();
  const M = {
    wood: new THREE.MeshStandardMaterial({ color: 0x7a5232, roughness: 0.85 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.4 }),
    board: new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.8 }),
    boardFace: new THREE.MeshStandardMaterial({ map: bt, color: bt ? 0xffffff : 0xe8dcc0, roughness: 0.7 }),
    pole: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.45, metalness: 0.6 }),
    giveWay: new THREE.MeshStandardMaterial({ map: gw, color: gw ? 0xffffff : 0xc8102e, transparent: false, alphaTest: 0.5, roughness: 0.5 }),
    giveWayBack: new THREE.MeshStandardMaterial({ map: gw, color: 0x5a5d62, alphaTest: 0.5, roughness: 0.6, metalness: 0.3 }),
    round: new THREE.MeshStandardMaterial({ map: rt, color: rt ? 0xffffff : 0x1f4fa8, alphaTest: 0.5, roughness: 0.5 }),
    roundBack: new THREE.MeshStandardMaterial({ map: rt, color: 0x5a5d62, alphaTest: 0.5, roughness: 0.6, metalness: 0.3 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.95, flatShading: true }),
    snow: new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.9 }),
    bark: new THREE.MeshStandardMaterial({ color: 0x4a3423, roughness: 0.9 }),
    spruce: new THREE.MeshStandardMaterial({ color: 0x1f4a2e, roughness: 0.85, flatShading: true }),
    fingerBoard: new THREE.MeshStandardMaterial({ color: 0xe9c46a, roughness: 0.7 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x6b6862, roughness: 0.95, flatShading: true }),
  };
  const root = new THREE.Group();
  root.name = 'scenic-props';
  let meshes = 0;
  for (const [key, list] of parts) {
    const geo = mergeGeometries(list);
    if (!geo) continue;
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, M[key]);
    mesh.castShadow = !['giveWayBack', 'roundBack', 'boardFace'].includes(key);
    mesh.receiveShadow = true;
    mesh.name = 'scenic-' + key;
    root.add(mesh);
    meshes++;
  }
  group.add(root);
  busRoads.scenicProps = { meshes, walls, views, signs };
  return busRoads.scenicProps;
}
