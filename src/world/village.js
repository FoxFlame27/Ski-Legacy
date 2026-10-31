// The base village (rental shop, ticket office, hotels, lamps, signs) + summit hut + snow cannons.
import * as THREE from 'three';
import { world } from './world.js';
import { fitModel, bakeGeometry, makeLOD, clusterDecimate } from '../core/assets.js';
import { Snowmaking } from './snowmaking.js';
import { drawnHeight } from './settle.js';
import { addStreetLamps } from './pistelights.js';
import { cannonSpotsFull } from './layout.js';
import { breakables } from './breakables.js'; // (the street lamps: snapped off by a car over 100 km/h)

export const nightUniform = { value: 0 };

// Bright texels (lit windows, lanterns) glow at night.
export function addNightGlow(root, strength = 2.5) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material?.map) return;
    const m = o.material.clone();
    m.onBeforeCompile = (s) => {
      s.uniforms.uNight = nightUniform;
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec3 tc = texture2D(map, vMapUv).rgb;
            float warm = smoothstep(0.35, 0.8, tc.r - tc.b * 0.8) * smoothstep(0.25, 0.6, tc.r);
            totalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * warm * uNight * ${strength.toFixed(2)};
          }`);
    };
    o.material = m;
  });
}

// the Meshy square larch pole (models/sign_pole.glb) at unit height: every posted sign's posts
let poleKit = null;
function signPost(pole, thick) {
  if (poleKit?.gltf !== pole) { const b = bakeGeometry(pole, { size: 1, axis: 'y' }); poleKit = { gltf: pole, geo: b.geometry, mat: b.material, k: 1 / Math.max(b.size.x, b.size.z) }; }
  const m = new THREE.Mesh(poleKit.geo, poleKit.mat);
  m.scale.set(poleKit.k * thick, 1, poleKit.k * thick);
  return m;
}

// A real sign: printed face on a wooden board with thickness. With `posts` (and `pole`, the sign_pole model),
// the group origin is at the ground and the board stands on two Meshy larch posts (`postH` = height of the
// board's bottom edge); standSign() sets it down with each post in its own snow.
export function makeSign(text, { w = 4, h = 1, bg = '#3b2414', fg = '#f5e6c8', font = 'bold 110px Georgia', border = '#c9a36a', posts = false, postH = 1.6, pole = null } = {}) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = Math.round((1024 * h) / w);
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = border; g.lineWidth = 14; g.strokeRect(16, 16, c.width - 32, c.height - 32);
  g.fillStyle = fg; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  const lines = text.split('\n');
  // each line shrunk to fit inside the border (Oct 30, the user: "fix this board so the text fits on it")
  const maxW = c.width - 90, maxH = (c.height - 60) / lines.length;
  lines.forEach((ln, i) => {
    let px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 100;
    px = Math.min(px, maxH * 0.86);
    const set = () => { g.font = font.replace(/\d+(?:\.\d+)?px/, `${Math.round(px)}px`); };
    set();
    while (px > 14 && g.measureText(ln).width > maxW) { px *= 0.94; set(); }
    g.fillText(ln, c.width / 2, c.height / 2 + (i - (lines.length - 1) / 2) * c.height / (lines.length + 0.3));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.0 });
  mat.userData.isSign = true;
  const wood = new THREE.MeshStandardMaterial({ color: 0x3a2716, roughness: 0.85 });
  const group = new THREE.Group();
  const board = new THREE.Group();
  const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, h + 0.1, 0.07), wood);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  face.position.z = 0.036;
  board.add(back, face);
  group.add(board);
  if (posts && pole) {
    board.position.y = postH + h / 2;
    const thick = w > 4 ? 0.2 : 0.13, top = postH + h - 0.02;
    group.userData.postTop = top;
    group.userData.posts = [-1, 1].map((sx) => {
      const post = signPost(pole, thick);
      post.position.set(sx * (w / 2 - 0.15), -0.25, -0.04 - thick / 2);
      post.scale.y = top + 0.25;
      post.castShadow = true; post.receiveShadow = true;
      group.add(post);
      return post;
    });
  }
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.userData.faceMaterial = mat;
  return group;
}

// Mount a sign flush on a building's facade: raycast from in front of the model toward it.
function mountOnFacade(model, sign, front, yFrac) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const y = box.min.y + (box.max.y - box.min.y) * yFrac;
  const origin = center.clone().setY(y).addScaledVector(front, 40);
  const hit = new THREE.Raycaster(origin, front.clone().negate(), 0, 80).intersectObject(model, true)[0];
  const p = hit ? hit.point : center.clone().setY(y).addScaledVector(front, (box.max.z - box.min.z) / 2);
  sign.position.copy(p).addScaledVector(front, 0.05);
  sign.rotation.y = Math.atan2(front.x, front.z);
  sign.userData.mountedOn = model; // (world/settle.js moves it with the building)
  return p;
}

// Point on the ground just in front of a building's facade (raycast at knee height).
function frontOf(model, front, dist) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const origin = center.clone().setY(box.min.y + 0.8).addScaledVector(front, 40);
  const hit = new THREE.Raycaster(origin, front.clone().negate(), 0, 80).intersectObject(model, true)[0];
  const p = hit ? hit.point : center.clone().addScaledVector(front, (box.max.z - box.min.z) / 2);
  return p.addScaledVector(front, dist).setY(0);
}

function placeOnGround(obj, x, z, yaw, sink = 0.2) {
  obj.position.set(x, world.height(x, z) - sink, z);
  obj.rotation.y = yaw;
  return obj;
}

const faceTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);
const CANNON_NEAR = 90; // m: snow cannons in full detail (with shadows) within this, a light copy beyond

/** Set a posted sign down at (x, z) facing `yaw`: the board level over the higher post's snow, each post reaching down into its own (no post hanging over a slope). */
export function standSign(sign, x, z, yaw) {
  const posts = sign.userData.posts || [], c = Math.cos(yaw), s = Math.sin(yaw);
  const gs = posts.map((p) => drawnHeight(x + p.position.x * c + p.position.z * s, z - p.position.x * s + p.position.z * c));
  const y0 = (gs.length ? Math.max(...gs) : drawnHeight(x, z)) - 0.05;
  sign.position.set(x, y0, z);
  sign.rotation.y = yaw;
  posts.forEach((p, i) => { const bottom = gs[i] - 0.25 - y0; p.position.y = bottom; p.scale.y = sign.userData.postTop - bottom; });
  return sign;
}

export class Village {
  constructor(scene, models, colliders, layout) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.interactables = [];
    this.lights = [];
    this.lampMats = [];
    this.signs = [];
    this.cannons = [];
    const add = (o) => { this.group.add(o); return o; };
    const box = (x, z, size, yaw, k = 0.42) => colliders.push({ x, z, hw: size.x * k, hd: size.z * k, rot: -yaw });
    this.cameraBlockers = []; // building meshes the 3rd-person camera must not pass through

    // --- rental shop (real-world size: ~11 m wide log chalet) ---
    const shopPos = { x: -40, z: -18 };
    const shopYaw = faceTo(shopPos.x, shopPos.z, 0, -10);
    const shopFront = new THREE.Vector3(Math.sin(shopYaw), 0, Math.cos(shopYaw));
    const shop = makeLOD(models.rental_shop, { size: 11, axis: 'x' }, 140, 0.015);
    addNightGlow(shop);
    add(placeOnGround(shop, shopPos.x, shopPos.z, shopYaw));
    this.cameraBlockers.push(shop);
    box(shopPos.x, shopPos.z, shop.userData.size, shopYaw);
    this.shopDoor = frontOf(shop, shopFront, 1.6);
    // freestanding signboard beside the entrance, angled toward the plaza
    const shopSide = new THREE.Vector3(-shopFront.z, 0, shopFront.x);
    const sp = this.shopDoor.clone().addScaledVector(shopSide, 3.6).addScaledVector(shopFront, 1.2);
    const sign = makeSign('SKI RENTAL\nSHOP', { w: 1.9, h: 1.0, font: 'bold 150px Georgia', posts: true, postH: 1.1, pole: models.sign_pole });
    add(standSign(sign, sp.x, sp.z, shopYaw + 0.35)); this.signs.push(sign);
    colliders.push({ x: sp.x, z: sp.z, r: 0.9 });
    // a clean nameboard over the door (the model's own lettering there is garbled)
    const plate = makeSign('SKI SHOP', { w: 3.2, h: 0.8, font: 'bold 150px Georgia' });
    mountOnFacade(shop, plate, shopFront, 0.33);
    add(plate); this.signs.push(plate);
    this.shopFront = shopFront;
    this.interactables.push({ id: 'shop', x: this.shopDoor.x, z: this.shopDoor.z, r: 3.2 });

    // --- ticket booth next to the gondola (a seller works the window) ---
    const tk = { x: 15, z: -50 };
    const tkYaw = faceTo(tk.x, tk.z, 0, -10);
    const tkFront = new THREE.Vector3(Math.sin(tkYaw), 0, Math.cos(tkYaw));
    // 4.8 m wide -> 3.4 m tall with a 2.1 m door (at 3.2 m the door was shorter than a person)
    const booth = makeLOD(models.ticket_booth, { size: 4.8, axis: 'x' }, 90, 0.03);
    add(placeOnGround(booth, tk.x, tk.z, tkYaw));
    this.cameraBlockers.push(booth);
    box(tk.x, tk.z, booth.userData.size, tkYaw, 0.48);
    const tsign = makeSign('LIFT TICKETS', { w: 3.2, h: 0.62, bg: '#123a6b', fg: '#ffffff', border: '#e8eef7', font: 'bold 130px Arial' });
    mountOnFacade(booth, tsign, tkFront, 0.8);
    tsign.position.addScaledVector(tkFront, 0.1); // (clear of the window awning's snow lip, which poked through)
    add(tsign); this.signs.push(tsign);
    this.booth = { model: booth, front: tkFront, yaw: tkYaw, pos: new THREE.Vector3(tk.x, world.height(tk.x, tk.z), tk.z) };
    const counter = frontOf(booth, tkFront, 1.2);
    this.booth.counter = counter;
    this.interactables.push({ id: 'tickets', x: counter.x, z: counter.z, r: 2.6 });

    // gondola sign on two posts
    const gsign = makeSign('LEGACY GONDOLA\nSummit 2,350 m', { w: 2.6, h: 0.9, bg: '#7a1010', fg: '#fff', border: '#fff', font: 'bold 110px Arial', posts: true, postH: 1.3, pole: models.sign_pole });
    add(standSign(gsign, -10, -46, faceTo(-10, -46, 0, 0))); this.signs.push(gsign);
    colliders.push({ x: -10, z: -46, r: 1.2 });

    // trail map board (faces the plaza), standing on its lower post
    const map = models.map_board ? this.makeTrailMapBoard(layout, models.map_board) : null;
    if (map) {
      const hw = map.userData.size.x / 2 - 0.2;
      map.position.set(8, Math.min(world.height(8 - hw, -24), world.height(8 + hw, -24), world.height(8, -24)) - 0.06, -24);
      add(map);
      colliders.push({ x: 8, z: -24, hw: map.userData.size.x / 2, hd: 0.4, rot: 0 });
    }

    // --- hotels around the plaza ---
    const hotels = [[62, 34], [-74, 44], [100, -34], [-108, -60], [22, 92], [-36, 108], [118, 70], [-128, 22]];
    for (const [x, z] of hotels) {
      const yaw = faceTo(x, z, 0, 0) + Math.sin(x * 12.9 + z) * 0.1;
      const h = makeLOD(models.hotel_chalet, { size: 17 + ((x * 7 + z * 13) % 5 + 5) % 5 * 0.8, axis: 'x' }, 140, 0.012); // (0.025 melted the facade)
      addNightGlow(h, 3.2);
      add(placeOnGround(h, x, z, yaw, 0.5));
      this.cameraBlockers.push(h);
      box(x, z, h.userData.size, yaw, 0.4);
    }

    // --- lamp posts along the plaza ---
    const lampSpots = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      lampSpots.push([Math.cos(a) * 34, Math.sin(a) * 34 - 6]);
    }
    lampSpots.push([-6, -36], [12, -36], [-26, -6], [-30, -30]);
    const lampBrk = []; // (Oct 31 2026, the user: "make sure you break these lamps after 100 kph, and they respawn after 90 sec": world/breakables.js)
    for (const [x, z] of lampSpots) {
      let lamp;
      if (models.lamp_post) {
        lamp = fitModel(models.lamp_post, { size: 3.6, axis: 'y' });
        addNightGlow(lamp, 6);
      } else {
        lamp = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 4), new THREE.MeshStandardMaterial({ color: 0x1b1b1b, metalness: 0.6, roughness: 0.5 }));
        pole.position.y = 2;
        const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffb860, emissiveIntensity: 0 });
        this.lampMats.push(bulbMat);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), bulbMat);
        bulb.position.y = 3.75;
        lamp.add(pole, bulb);
      }
      add(placeOnGround(lamp, x, z, faceTo(x, z, 0, -6), 0.05));
      const lc = { x, z, r: 0.25 };
      colliders.push(lc);
      lampBrk.push(breakables.add(lc, [lamp], { h: 3.6, loud: 0.7, lamp: true }));
    }
    // every lamp lights a warm pool on the snow, the people and the hotels round it at night: the floodlights'
    // light pools (world/pistelights.js), no THREE lights (they were six PointLights, every material paying for them)
    addStreetLamps(lampSpots.map(([x, z]) => ({ x, z, y: world.height(x, z) + 3.1 }))).forEach((l, i) => { if (lampBrk[i]) lampBrk[i].light = l; }); // (its pool off while it is down)

    // --- summit restaurant ---
    for (const hut of layout.huts) {
      const yaw = hut.yaw ?? faceTo(hut.x, hut.z, hut.x, hut.z + 50);
      const m = makeLOD(models.mountain_hut, { size: 10, axis: 'x' }, 140, 0.015);
      addNightGlow(m, 3);
      add(placeOnGround(m, hut.x, hut.z, yaw, 0.4));
      this.cameraBlockers.push(m);
      box(hut.x, hut.z, m.userData.size, yaw, 0.42);
      const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const door = frontOf(m, f, 1.6);
      const side = new THREE.Vector3(-f.z, 0, f.x);
      const p = door.clone().addScaledVector(side, 3.2).addScaledVector(f, 1.5);
      // each summit has its own hut (Gipfel, Adlerhorn, Silberhorn, Sonnenkopf); long names get a wider board
      const s = makeSign(`${(hut.name || 'Gipfel Hütte').toUpperCase()}\nHot chocolate`, { w: 2.4, h: 0.95, font: 'bold 115px Georgia', posts: true, postH: 1.0, pole: models.sign_pole });
      add(standSign(s, p.x, p.z, yaw + 0.3)); this.signs.push(s);
      colliders.push({ x: p.x, z: p.z, r: 0.9 });
      this.interactables.push({ id: 'hut', x: door.x, z: door.z, r: 3.5 });
      const L = new THREE.PointLight(0xffa850, 0, 22, 2);
      L.position.set(p.x, world.height(p.x, p.z) + 3, p.z);
      add(L); this.lights.push(L);
    }

    // --- snow cannons along the main pistes ---
    if (models.snow_cannon) {
      const c = bakeGeometry(models.snow_cannon, { size: 2.6, axis: 'y', decimate: 0.03 });
      c.geometry.computeBoundingBox();
      const bb = c.geometry.boundingBox;
      // the snow as drawn under a cannon's wheels and frame at (x, z) turned to yaw: [lowest, highest]
      const under = (x, z, yaw) => {
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        let lo = Infinity, hi = -Infinity;
        for (const fx of [0, 0.5, 1]) for (const fz of [0, 0.5, 1]) {
          const lx = bb.min.x + (bb.max.x - bb.min.x) * fx, lz = bb.min.z + (bb.max.z - bb.min.z) * fz;
          const h = drawnHeight(x + lx * cy + lz * sy, z - lx * sy + lz * cy);
          lo = Math.min(lo, h); hi = Math.max(hi, h);
        }
        return [lo, hi];
      };
      // (where they go is planned with the layout, outside the groomed width and off every other run: layout.js
      // cannonSpotsFull; here each stands on its lowest wheel as the snow is drawn)
      const spots = [];
      for (const q of cannonSpotsFull()) {
        const [lo, hi] = under(q.x, q.z, q.yaw);
        if (hi - lo > 1.3) continue; // (nowhere level enough here: no cannon)
        spots.push({ x: q.x, z: q.z, y: lo - 0.06, yaw: q.yaw });
      }
      const inst = new THREE.InstancedMesh(c.geometry, c.material, spots.length);
      const d = new THREE.Object3D();
      spots.forEach((s, i) => {
        d.position.set(s.x, s.y, s.z);
        d.rotation.set(0, s.yaw, 0);
        d.updateMatrix();
        inst.setMatrixAt(i, d.matrix);
        colliders.push({ x: s.x, z: s.z, r: 1.1 });
        this.cannons.push({ pos: new THREE.Vector3(s.x, s.y + 2.2, s.z), dir: new THREE.Vector3(Math.sin(s.yaw), 0.35, Math.cos(s.yaw)) });
      });
      inst.castShadow = true; inst.receiveShadow = true;
      add(inst);
      // (performance pass: ~175 cannons x 12.7k triangles were 2.2M triangles, shadows too, whenever any piste was in
      // view: only those within CANNON_NEAR m keep the full one; the rest a light copy without a shadow, re-sorted as
      // you move, see update)
      inst.computeBoundingSphere();
      const far = new THREE.InstancedMesh(clusterDecimate(c.geometry, 2.6 * 0.09), c.material, spots.length);
      far.count = 0; far.receiveShadow = true; far.boundingSphere = inst.boundingSphere.clone();
      add(far);
      this.cannonLod = { near: inst, far, mats: spots.map((_, i) => { const m = new THREE.Matrix4(); inst.getMatrixAt(i, m); return m; }), pos: spots.map((q) => [q.x, q.z]), at: null };
      this.snowmaking = new Snowmaking(this.group, this.cannons); // the plumes they blow at dusk / night
    }
  }

  // The trail map on the Meshy notice board (map_board: a roofed frame on two posts). The map is drawn at the
  // aspect of the board's panel and covers it; the panel, measured on the model, takes 70.5 % of its width and 50.5 %
  // of its height, centred 48.1 % up, its face 15.3 % of the depth in front of the middle.
  makeTrailMapBoard(layout, gltf) {
    const W = 2048, H = 1270; // (the panel's 1.61 : 1)
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#9cc3ee'); grd.addColorStop(1, '#f4f8ff');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    // shaded relief of the resort (the whole z range; x as wide as the panel's aspect allows)
    const minz = -2700, maxz = 2400, halfX = ((maxz - minz) * W) / H / 2, minx = -halfX, maxx = halfX;
    const img = g.getImageData(0, 0, W, H);
    for (let j = 0; j < H; j += 4) for (let i = 0; i < W; i += 4) {
      const x = minx + (i / W) * (maxx - minx), z = minz + (j / H) * (maxz - minz);
      const h = world.baseHeight(x, z), hx = world.baseHeight(x + 15, z) - h, hz = world.baseHeight(x, z + 15) - h;
      const shade = Math.max(0, Math.min(1, 0.75 - hx * 0.03 + hz * 0.02));
      const v = Math.floor(170 + shade * 85);
      for (let a = 0; a < 4 && j + a < H; a++) for (let b = 0; b < 4; b++) {
        const k = ((j + a) * W + i + b) * 4;
        img.data[k] = v - 10; img.data[k + 1] = v - 4; img.data[k + 2] = 255; img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const toC = (x, z) => [((x - minx) / (maxx - minx)) * W, ((z - minz) / (maxz - minz)) * H];
    const colors = ['#1f9d4a', '#1f5fd6', '#d42525', '#111'];
    g.lineJoin = g.lineCap = 'round';
    for (const p of layout.pistes) {
      if (p.lane) { // a ski lane: its nets drawn as an orange band along both sides
        g.strokeStyle = '#ff6a12'; g.lineWidth = 22; g.beginPath();
        p.pts.forEach(([x, z], i) => { const [cx, cy] = toC(x, z); i ? g.lineTo(cx, cy) : g.moveTo(cx, cy); });
        g.stroke();
      }
      g.strokeStyle = colors[p.diff]; g.lineWidth = 11; g.beginPath();
      p.pts.forEach(([x, z], i) => { const [cx, cy] = toC(x, z); i ? g.lineTo(cx, cy) : g.moveTo(cx, cy); });
      g.stroke();
    }
    g.strokeStyle = '#222'; g.lineWidth = 6; g.setLineDash([22, 13]);
    for (const l of layout.lifts) {
      const [ax, ay] = toC(l.bottom.x, l.bottom.z), [bx, by] = toC(l.top.x, l.top.z);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = '#123'; g.font = 'bold 92px Georgia'; g.fillText('SKI LEGACY · Trail Map', 56, 120);
    g.font = 'bold 44px Arial';
    for (const p of layout.pistes) { const [x, y] = toC(...p.pts[Math.floor(p.pts.length * 0.4)]); g.fillStyle = colors[p.diff]; g.fillText(p.name, x + 16, y); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    const board = fitModel(gltf, { size: 5, axis: 'x' }); // 5 m wide, ~4.3 m to the roof ridge
    board.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const sz = board.userData.size;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(sz.x * 0.705, sz.y * 0.505), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    face.position.set(0, sz.y * 0.481, sz.z * 0.153 + 0.012);
    face.receiveShadow = true;
    board.add(face);
    return board;
  }

  update(dt, env, spray, playerPos) {
    const night = env.nightFactor;
    nightUniform.value = Math.max(night, (1 - env.dayFactor) * 0.6);
    const on = nightUniform.value;
    for (const L of this.lights) {
      L.intensity = on * 40;
      // toggling visibility recompiles shaders, so only flip at clear thresholds
      const want = on > 0.08 && L.position.distanceToSquared(playerPos) < 700 * 700;
      if (want !== L.visible) L.visible = want;
    }
    for (const m of this.lampMats) m.emissiveIntensity = on * 6;
    for (const s of this.signs) s.userData.faceMaterial.emissiveIntensity = on * 0.25;
    // snow cannons run at night / dusk (world/snowmaking.js)
    this.snowmaking?.update(dt, playerPos, on);
    const C = this.cannonLod; // near / far cannons, re-sorted every 20 m you move
    if (C && playerPos && (!C.at || Math.hypot(playerPos.x - C.at[0], playerPos.z - C.at[1]) > 20)) {
      C.at = [playerPos.x, playerPos.z];
      let n = 0, f = 0;
      for (let i = 0; i < C.mats.length; i++) {
        const [x, z] = C.pos[i];
        if ((x - playerPos.x) ** 2 + (z - playerPos.z) ** 2 < CANNON_NEAR * CANNON_NEAR) C.near.setMatrixAt(n++, C.mats[i]); else C.far.setMatrixAt(f++, C.mats[i]);
      }
      C.near.count = n; C.far.count = f;
      C.near.instanceMatrix.needsUpdate = true; C.far.instanceMatrix.needsUpdate = true;
    }
  }
}
