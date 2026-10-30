// Village dressing: cobblestone paths across the plaza and Meshy decoration props
// (Christmas tree, benches, market stalls, fire pit, cars, fences...). Missing models are skipped.
import * as THREE from 'three';
import { world } from './world.js';
import { layout } from './layout.js';
import { fitModel } from '../core/assets.js';
import { meshHeight } from '../fx/snowfx.js';
import { propSeats } from '../game/seating.js';
import { busRoads, laneDistance, ROAD_HALF } from '../game/bus/roads.js';

// Cobblestones with snow packed into the joints; edges of the strip fade into the snow (alpha).
function cobbleTexture() {
  const W = 512, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#e9eef5';
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rowH = 46;
  for (let y = 0, r = 0; y < H; y += rowH, r++) {
    let x = r % 2 ? -rowH * 0.5 : 0;
    while (x < W) {
      const w = rowH * (0.8 + rnd() * 0.6);
      const v = 105 + rnd() * 55;
      g.fillStyle = `rgb(${v + 14},${v + 6},${v - 4})`;
      const pad = 4;
      const rx = x + pad, ry = y + pad, rw = w - pad * 2, rh = rowH - pad * 2, rr = 9;
      g.beginPath();
      g.moveTo(rx + rr, ry); g.arcTo(rx + rw, ry, rx + rw, ry + rh, rr); g.arcTo(rx + rw, ry + rh, rx, ry + rh, rr);
      g.arcTo(rx, ry + rh, rx, ry, rr); g.arcTo(rx, ry, rx + rw, ry, rr); g.closePath(); g.fill();
      // worn highlight + light snow dusting on some stones
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(rx + 3, ry + 3, rw - 6, rh * 0.35);
      if (rnd() < 0.35) { g.fillStyle = `rgba(240,245,252,${0.4 + rnd() * 0.4})`; g.beginPath(); g.ellipse(rx + rw * rnd(), ry + rh * rnd(), 6 + rnd() * 10, 4 + rnd() * 6, 0, 0, 7); g.fill(); }
      x += w;
    }
  }
  // fade the sides of the strip into snow (texture u = across the path)
  const img = g.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = Math.abs(x / W - 0.5) * 2;
    const a = 1 - Math.min(1, Math.max(0, (u - 0.72) / 0.28));
    img.data[(y * W + x) * 4 + 3] = Math.round(255 * a * a);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  return t;
}

// the Christmas market's stalls on the east side of the plaza (paths keep clear of them)
const MARKET = [0, 1, 2].map((i) => [30 + i * 0.5, 4 + i * 7.2]);
const segDist = (x, z, [ax, az], [bx, bz]) => {
  const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(ax + ex * t - x, az + ez * t - z);
};

export class Decor {
  constructor(scene, models, colliders, village) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.colliders = colliders;
    this.models = models;
    this.pathMat = new THREE.MeshStandardMaterial({
      map: cobbleTexture(), roughness: 0.85, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.buildPaths(village);
    this.placeProps(village);
  }

  // A path strip following a polyline of [x, z] points, hugging the terrain mesh.
  path(points, width = 3) {
    const pts = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i], [bx, bz] = points[i + 1];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 1.5));
      for (let k = 0; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    pts.push(points[points.length - 1]);
    // a path never runs over a road or a car park: it stops a little short of the plowed edge on each side
    const offRoad = ([x, z]) => {
      if (laneDistance(x, z) < ROAD_HALF + width / 2 + 0.4) return false;
      for (const L of busRoads.lots) {
        if (L.ux === undefined) continue;
        const dx = x - L.x, dz = z - L.z;
        if (Math.abs(dx * L.ux + dz * L.uz) < L.hw + width / 2 + 0.4 && Math.abs(dx * L.vx + dz * L.vz) < L.hd + width / 2 + 0.4) return false;
      }
      return true;
    };
    if (busRoads.roads.length && !pts.every(offRoad)) {
      let run = [];
      for (const q of pts) {
        if (offRoad(q)) { run.push(q); continue; }
        if (run.length > 1) this.path(run, width);
        run = [];
      }
      if (run.length > 1) this.path(run, width);
      return;
    }
    const pos = [], uv = [], idx = [];
    let v = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const [px, pz] = pts[Math.max(0, i - 1)], [nx, nz] = pts[Math.min(pts.length - 1, i + 1)];
      let dx = nx - px, dz = nz - pz;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const rx = -dz * width / 2, rz = dx * width / 2;
      if (i) v += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]) / width;
      for (const [sx, u] of [[-1, 0], [1, 1]]) {
        const X = x + rx * sx, Z = z + rz * sx;
        pos.push(X, meshHeight(X, Z) + 0.02, Z);
        uv.push(u, v);
      }
      if (i) { const o = (i - 1) * 2; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, this.pathMat);
    m.receiveShadow = true;
    m.renderOrder = 1;
    this.group.add(m);
  }

  buildPaths(village) {
    // ring around the Christmas tree + spokes to the shop, the gondolas, ticket booth and hotels
    const ring = [];
    for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; ring.push([Math.cos(a) * 15, Math.sin(a) * 15 - 4]); }
    this.path(ring, 3.2);
    const toRing = (x, z) => { const a = Math.atan2(z + 4, x); return [Math.cos(a) * 15, Math.sin(a) * 15 - 4]; };
    const spoke = (x, z, w = 2.8) => this.path([toRing(x, z), [x, z]], w);
    spoke(village.shopDoor.x, village.shopDoor.z);
    spoke(0, -54, 4);                       // gondola entrance
    spoke(village.booth.counter.x, village.booth.counter.z);
    for (const [x, z] of [[62, 34], [-74, 44], [100, -34], [-108, -60], [22, 92], [-36, 108], [118, 70], [-128, 22]]) {
      const l = Math.hypot(x, z + 4);
      spoke(x - (x / l) * 12, z - ((z + 4) / l) * 12, 2.4);
    }
    // the village gondolas (Adlerhorn, Silberhorn): a wide path from the ring out between two of the plaza
    // lamps (14 on a 34 m circle around (0, -6)) to the station entrance, 16 m down the line from the station;
    // of the lamp gaps around the station's bearing, the nearest one whose path keeps 7 m off the market
    const step = (Math.PI * 2) / 14;
    for (const l of layout.lifts) {
      if (!l.village) continue;
      const e = [l.bottom.x - l.dir[0] * 16, l.bottom.z - l.dir[1] * 16], bearing = Math.atan2(e[1] + 6, e[0]);
      const k = Math.floor(bearing / step);
      const ways = [k, k - 1, k + 1].map((i) => { const a = (i + 0.5) * step, gap = [Math.cos(a) * 34, Math.sin(a) * 34 - 6]; return [toRing(...gap), gap, e]; });
      const clear = (w) => Math.min(...MARKET.map(([x, z]) => Math.min(segDist(x, z, w[0], w[1]), segDist(x, z, w[1], w[2]))));
      this.path(ways.find((w) => clear(w) > 7) || ways[0], 4);
    }
  }

  put(name, x, z, yaw, size, axis = 'xz', collide = 0) {
    const gltf = this.models[name];
    if (!gltf) return null;
    const m = fitModel(gltf, { size, axis });
    m.position.set(x, world.height(x, z) - 0.05, z);
    m.rotation.y = yaw;
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(m);
    if (collide) this.colliders.push({ x, z, r: collide });
    propSeats(name, m, size); // (benches: you can sit on them)
    return m;
  }

  placeProps(village) {
    const face = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);
    const P = (n, x, z, yaw, size, axis, col) => this.put(n, x, z, yaw, size, axis, col);
    // plaza centerpiece + seating
    const tree = P('christmas_tree', 0, -4, 0.3, 8.5, 'y', 1.6);
    if (tree) {
      this.treeLight = new THREE.PointLight(0xffc477, 0, 22, 2);
      this.treeLight.position.set(0, world.height(0, -4) + 4, -4);
      this.group.add(this.treeLight);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4, x = Math.cos(a) * 8.5, z = Math.sin(a) * 8.5 - 4;
      P('wooden_bench', x, z, face(x, z, 0, -4), 1.8, 'xz', 0.7);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2, x = Math.cos(a) * 10.5, z = Math.sin(a) * 10.5 - 4;
      P(i % 2 ? 'trash_bin' : 'wooden_barrel', x, z, face(x, z, 0, -4), 1.0, 'y', 0.4);
    }
    // Christmas market on the east side with a fire pit and tables
    for (const [x, z] of MARKET) P('market_stall', x, z, face(x, z, 0, z), 3.9, 'xz', 2.2); // (3.9 m: the model's red ground disc is trimmed off)
    P('fire_pit', 22, 12, 0, 1.5, 'xz', 0.8);
    this.fire = { x: 22, z: 12 };
    P('picnic_table', 19.5, 16.5, 0.4, 2.0, 'xz', 1.0);
    P('picnic_table', 24.5, 7.5, -0.6, 2.0, 'xz', 1.0);
    // by the ski shop: ski racks, a sled, firewood
    const sf = village.shopFront, sd = village.shopDoor, side = new THREE.Vector3(-sf.z, 0, sf.x);
    const yawShop = Math.atan2(sf.x, sf.z);
    const at = (d, s) => [sd.x + sf.x * d + side.x * s, sd.z + sf.z * d + side.z * s];
    P('outdoor_ski_rack', ...at(1.2, -4.2), yawShop, 3.0, 'xz', 1.2);
    P('wooden_sled', ...at(1.5, 6.2), yawShop + 0.5, 1.2, 'xz', 0);
    P('firewood_pile', ...at(-1.0, -7.5), yawShop, 2.2, 'xz', 1.0);
    // gondola base: ski racks (the snowmobile there is a drivable one, game/snowmobile.js)
    P('outdoor_ski_rack', -8, -58, 0, 3.0, 'xz', 1.2);
    P('outdoor_ski_rack', 8, -58, 0, 3.0, 'xz', 1.2);
    // hotels: a snowman, firewood, fences
    P('snowman', 48, 22, face(48, 22, 0, 0), 1.7, 'y', 0.5);
    P('snowman', -60, 30, face(-60, 30, 0, 0), 1.5, 'y', 0.5);
    P('firewood_pile', 72, 22, 2.2, 2.2, 'xz', 1.0);
    P('firewood_pile', -96, -46, 0.9, 2.2, 'xz', 1.0);
    // fences along the village's edge, clear of the gondola lines and the runs coming in to their stations
    // (each 3 m section turned along its row, the model's length being its x: turned across it, the sections stood
    // apart like loose stubs)
    // (each a thin board collider along its row: soft, like a net, for skis; solid for the car and the sled)
    const fence = (x, z, yaw) => { if (P('wooden_fence', x, z, yaw, 3.0, 'xz', 0)) this.colliders.push({ x, z, hw: 1.6, hd: 0.15, rot: -yaw, soft: true }); };
    for (let i = 0; i < 6; i++) fence(-152 + i * 3.1, 122 + i * 0.4, -Math.atan2(0.4, 3.1));
    for (let i = 0; i < 6; i++) fence(128 + i * 3.1, 36 + i * 0.3, -Math.atan2(0.3, 3.1));
    // (no cars anywhere for now: the car parks are game/parking.js, still empty)
    // planters along the gondola approach
    for (const x of [-6, 6]) for (const z of [-30, -42]) P('wooden_barrel', x, z, 0, 1.0, 'y', 0.4);
  }

  update(dt, night) {
    if (this.treeLight) this.treeLight.intensity = night * 30;
  }
}
