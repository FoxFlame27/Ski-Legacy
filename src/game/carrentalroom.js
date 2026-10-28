// Inside the CAR RENTAL (its own scene, like the ski shop's: main.js renders it through post.setView while you're in).
// A bright modern showroom in an alpine chalet: a polished dark stone floor that mirrors the cars (a Reflector under a
// glossy tile layer), warm oak slat walls, a timber ceiling with light strips, spotlights on five cars, one of every
// model you can rent, each on a slowly turning display turntable (aluminium rim, LED ring) with a price stand; the
// curved white reception desk with an oak top, the clerk behind it, the backlit CAR RENTAL sign; a lounge corner
// (leather sofa, coffee table, plants), a red mechanic's tool cabinet and a winter-tyre rack, the front glazed onto the
// snowy yard. Walk with WASD + mouse; look at a car or the clerk and press E (carrental.js opens the rental card).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { fitModel, loadGLB } from '../core/assets.js';
import { carTemplate, carInstance, driverEye } from './cars.js';
import { dressCar } from './carconfig.js';
// the full-detail models (their interiors) for the configurator's cockpit view (as drive.js)
const FULL = { car_audi_rs6: 'car_audi_rs6_full', car_vw_golf_gti: 'car_vw_golf_gti_full', car_tesla_m3: 'car_tesla_m3_full' };
// where the configurator's camera looks from, per step (round the car from its nose: 0 front, pi the back), how far
const SHOT = { car: [0.75, 0.2, 5.6], paint: [1.05, 0.24, 5.4], rims: [1.45, 0.06, 4.6], plate: [Math.PI - 0.3, 0.12, 4.8], sum: [0.6, 0.22, 5.8] };

export const ROOM = { W: 26, D: 16, H: 5.4 };
const EYE = 1.62, UP = new THREE.Vector3(0, 1, 0);
const HITBOX = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const DOOR = { x: -3.2, w: 1.8, h: 2.5 };
const DESK = { x: 8, z: -5.2, r: 2.6 }; // the curved desk: its centre (the clerk stands there), radius
const _v = new THREE.Vector3();

function tex(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
const box = (w, h, d, mat, x, y, z, parent) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; parent?.add(m); return m; };

export class CarRentalRoom {
  /** @param {{ renderer, models, makeRig: () => object, cars: {id,label,price,length}[], display: {id, paint}[] }} o */
  constructor({ renderer, models, makeRig, cars, display }) {
    this.active = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2a2420);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 120);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.yaw = Math.PI; this.pitch = -0.08;
    this.obstacles = []; this.aimables = []; this.tables = [];
    this.cfg = null; // the configurator: { table, step, yaw, pitch, dist } (carrental.js configure())
    this.models = models; this.cars = cars;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.55;
    this.buildShell(renderer);
    this.buildLights();
    this.buildCars(models, cars, display);
    this.buildDesk(models, makeRig);
    this.buildLounge(models);
    this.buildWorkshop();
  }

  // ------------------------------------------------------------------ the room
  buildShell() {
    const { W, D, H } = ROOM, S = this.scene;
    // polished floor: large dark stone tiles over a mirror (the cars and lights reflect, softly)
    const floorTex = tex(1024, 1024, (g, w, h) => {
      const r = rng(7);
      g.fillStyle = '#3a3836'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { // 4 tiles per texture, each a little different
        const v = 52 + r() * 12; g.fillStyle = `rgb(${v},${v - 2},${v - 4})`; g.fillRect(i * 512 + 2, j * 512 + 2, 508, 508);
        for (let k = 0; k < 40; k++) { g.strokeStyle = `rgba(${r() < 0.5 ? '255,250,240' : '20,18,16'},${0.03 + r() * 0.05})`; g.lineWidth = 0.5 + r() * 2; g.beginPath(); const x0 = i * 512 + r() * 512, y0 = j * 512 + r() * 512; g.moveTo(x0, y0); g.bezierCurveTo(x0 + r() * 120 - 60, y0 + r() * 120 - 60, x0 + r() * 200 - 100, y0 + r() * 200 - 100, x0 + r() * 260 - 130, y0 + r() * 260 - 130); g.stroke(); }
      }
      g.fillStyle = '#1d1c1b'; for (let k = 0; k <= 2; k++) { g.fillRect(k * 512 - 2, 0, 4, h); g.fillRect(0, k * 512 - 2, w, 4); }
    }, { repeat: [W / 3.2, D / 3.2] });
    try {
      const mirror = new Reflector(new THREE.PlaneGeometry(W, D), { textureWidth: 1024, textureHeight: 1024, color: 0x8a8a8a });
      mirror.rotation.x = -Math.PI / 2; mirror.position.y = -0.002;
      S.add(mirror);
      this.mirror = mirror;
    } catch { this.mirror = null; }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshPhysicalMaterial({ map: floorTex, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, transparent: !!this.mirror, opacity: this.mirror ? 0.8 : 1 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    S.add(floor);
    // walls: warm white plaster, the back wall oak slats (the sign hangs on it)
    const plaster = new THREE.MeshStandardMaterial({ color: 0xf1e9dc, roughness: 0.92 });
    const oakTex = tex(512, 512, (g, w, h) => {
      const r = rng(3); g.fillStyle = '#6b4526'; g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 32) { const v = (r() - 0.5) * 24; g.fillStyle = `rgb(${176 + v},${124 + v * 0.8},${78 + v * 0.6})`; g.fillRect(x + 3, 0, 26, h);
        for (let k = 0; k < 10; k++) { g.strokeStyle = `rgba(70,40,15,${0.08 + r() * 0.1})`; g.lineWidth = 1; g.beginPath(); const gx = x + 5 + r() * 22; g.moveTo(gx, 0); g.lineTo(gx + r() * 4 - 2, h); g.stroke(); } }
    }, { repeat: [W / 4, 1] });
    const oak = new THREE.MeshStandardMaterial({ map: oakTex, roughness: 0.55 });
    const wall = (w, h, mat, x, y, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.y = ry; m.receiveShadow = true; S.add(m); return m; };
    wall(W, H, oak, 0, H / 2, -D / 2, 0);
    wall(D, H, plaster, -W / 2, H / 2, 0, Math.PI / 2);
    wall(D, H, plaster, W / 2, H / 2, 0, -Math.PI / 2);
    // the front: a glazed wall onto the yard (a bright snowy view), the glass door, dark steel mullions
    const view = tex(1024, 256, (g, w, h) => {
      const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#9fc3e6'); sky.addColorStop(0.55, '#dfeaf3'); sky.addColorStop(0.6, '#f4f7fa'); sky.addColorStop(1, '#e6ebf0');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      const r = rng(11); g.fillStyle = '#c9d5e0';
      g.beginPath(); g.moveTo(0, h * 0.5); for (let x = 0; x <= w; x += 32) g.lineTo(x, h * (0.3 + r() * 0.22)); g.lineTo(w, h * 0.6); g.lineTo(0, h * 0.6); g.fill();
      for (let i = 0; i < 40; i++) { const x = r() * w, y = h * 0.6, s = 14 + r() * 26; g.fillStyle = `rgba(40,62,48,${0.55 + r() * 0.3})`; g.beginPath(); g.moveTo(x, y - s * 1.8); g.lineTo(x - s * 0.5, y); g.lineTo(x + s * 0.5, y); g.fill(); }
    });
    const outside = new THREE.MeshBasicMaterial({ map: view, toneMapped: false, color: 0xd8d8d8 });
    wall(W, H, outside, 0, H / 2, D / 2 + 0.6, Math.PI);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xdfeff7, roughness: 0.05, metalness: 0, transmission: 0, transparent: true, opacity: 0.12 });
    wall(W, H, glass, 0, H / 2, D / 2, Math.PI);
    const steel = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.4, metalness: 0.7 });
    for (let x = -W / 2; x <= W / 2 + 0.01; x += W / 8) box(0.12, H, 0.14, steel, x, H / 2, D / 2, S);
    box(W, 0.14, 0.16, steel, 0, 2.9, D / 2, S); box(W, 0.3, 0.2, steel, 0, 0.15, D / 2, S);
    // the door: a frame and its push bar (E here: leave)
    box(0.1, DOOR.h, 0.18, steel, DOOR.x - DOOR.w / 2, DOOR.h / 2, D / 2 - 0.02, S); box(0.1, DOOR.h, 0.18, steel, DOOR.x + DOOR.w / 2, DOOR.h / 2, D / 2 - 0.02, S);
    box(DOOR.w, 0.1, 0.18, steel, DOOR.x, DOOR.h, D / 2 - 0.02, S);
    box(DOOR.w * 0.7, 0.05, 0.06, new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 1, roughness: 0.2 }), DOOR.x, 1.05, D / 2 - 0.12, S);
    this.doorHit = new THREE.Mesh(new THREE.BoxGeometry(DOOR.w, DOOR.h, 0.4), HITBOX);
    this.doorHit.position.set(DOOR.x, DOOR.h / 2, D / 2 - 0.1); this.doorHit.userData.kind = 'door';
    S.add(this.doorHit); this.aimables.push(this.doorHit);
    // ceiling: dark timber with long warm light strips
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 0.8 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = H; S.add(ceil);
    const strip = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe6c4, emissiveIntensity: 2.2 });
    for (const z of [-5, 0, 5]) box(W - 2, 0.04, 0.16, strip, 0, H - 0.03, z, S).castShadow = false;
    for (let x = -W / 2 + 1; x < W / 2; x += 1.6) box(0.12, 0.18, D, new THREE.MeshStandardMaterial({ color: 0x5a3d26, roughness: 0.7 }), x, H - 0.09, 0, S).castShadow = false;
    // skirting
    box(W, 0.12, 0.03, steel, 0, 0.06, -D / 2 + 0.015, S);
    // the backlit sign on the oak wall: CAR RENTAL · LEGACY VILLAGE
    const sign = tex(2048, 400, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = 'italic 700 220px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillStyle = '#fff';
      if ('letterSpacing' in g) g.letterSpacing = '24px';
      g.shadowColor = 'rgba(255,214,150,0.9)'; g.shadowBlur = 30;
      g.fillText('CAR RENTAL', w / 2, h * 0.42);
      g.font = '600 64px "Inter Variable", Arial, sans-serif'; if ('letterSpacing' in g) g.letterSpacing = '20px'; g.fillStyle = '#f2c88c';
      g.fillText('LEGACY VILLAGE · SINCE 1967', w / 2, h * 0.86);
    });
    const sm = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.75), new THREE.MeshBasicMaterial({ map: sign, transparent: true, toneMapped: false }));
    sm.position.set(-2, 3.75, -D / 2 + 0.03); S.add(sm);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 2.4), new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false }));
    halo.position.set(-2, 3.75, -D / 2 + 0.02); S.add(halo);
  }

  buildLights() {
    const S = this.scene, { H } = ROOM;
    S.add(new THREE.HemisphereLight(0xfff1de, 0x4a3a2c, 0.9));
    const key = new THREE.DirectionalLight(0xffe8cc, 1.2);
    key.position.set(4, H + 6, 6); key.target.position.set(0, 0, 0);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -14, right: 14, top: 10, bottom: -10, near: 1, far: 30 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    S.add(key, key.target);
    this.spots = [];
  }

  // ------------------------------------------------------------------ the cars on their turntables
  buildCars(models, cars, display) {
    const S = this.scene, spots = [[-9, -4.1], [-2.2, -4.3], [-9, 3.4], [2.6, 3.4], [9.3, 3.5]];
    const rim = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const top = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.55, metalness: 0.2 });
    const led = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e4, emissiveIntensity: 2.4 });
    display.forEach((d, k) => {
      const spec = cars.find((c) => c.id === d.id), gltf = models[d.id], at = spots[k % spots.length];
      if (!spec || !gltf) return;
      const R = 2.75, tt = new THREE.Group();
      tt.position.set(at[0], 0, at[1]);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.16, 64), top); disc.position.y = 0.08; disc.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.06, 10, 96), rim); ring.rotation.x = Math.PI / 2; ring.position.y = 0.13;
      const glow = new THREE.Mesh(new THREE.TorusGeometry(R + 0.07, 0.018, 6, 96), led); glow.rotation.x = Math.PI / 2; glow.position.y = 0.035;
      tt.add(disc, ring, glow);
      const spin = new THREE.Group(); spin.position.y = 0.16; tt.add(spin);
      const inst = carInstance(carTemplate(gltf, spec.length, d.id), { paint: d.paint });
      inst.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      spin.add(inst.group);
      spin.rotation.y = k * 1.3 + 0.6;
      const hit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.7, spec.length + 0.2), HITBOX);
      hit.position.y = 0.85; hit.userData = { kind: 'car', id: d.id, paint: d.paint, label: spec.label };
      spin.add(hit); this.aimables.push(hit);
      S.add(tt);
      this.tables.push({ spin, speed: 0.1 + 0.03 * (k % 2), id: d.id, inst, t: carTemplate(gltf, spec.length, d.id), spec, x: at[0], z: at[1] });
      this.obstacles.push({ x: at[0], z: at[1], r: R + 0.1 });
      // a spotlight on it from the ceiling (no shadow: the key light casts them)
      const sp = new THREE.SpotLight(0xffe2bd, 60, 12, 0.5, 0.6, 1.6);
      sp.position.set(at[0], ROOM.H - 0.2, at[1] + 1.2); sp.target.position.set(at[0], 0.5, at[1]);
      S.add(sp, sp.target);
      // its price stand: a brushed steel post with a card (model, price)
      const card = tex(512, 320, (g, w, h) => {
        g.fillStyle = '#fbf8f2'; g.fillRect(0, 0, w, h); g.fillStyle = '#1546c8'; g.fillRect(0, 0, w, 14);
        g.textAlign = 'left'; g.fillStyle = '#8a2a1c'; g.font = '700 30px "Inter Variable", Arial, sans-serif'; g.fillText(spec.kind.toUpperCase(), 34, 72);
        g.fillStyle = '#1546c8'; g.font = 'italic 700 72px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillText(spec.label, 34, 152);
        g.fillStyle = '#8f1d14'; g.font = 'italic 700 96px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillText(`$${spec.price}`, 34, 270);
        g.fillStyle = 'rgba(30,40,70,0.65)'; g.font = '500 26px "Inter Variable", Arial, sans-serif'; g.fillText('per rental · E to rent', 250, 262);
      });
      const stand = new THREE.Group();
      box(0.05, 1.05, 0.05, rim, 0, 0.52, 0, stand);
      box(0.36, 0.02, 0.36, rim, 0, 0.01, 0, stand);
      const c = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.39), new THREE.MeshStandardMaterial({ map: card, roughness: 0.6 }));
      c.position.set(0, 1.18, 0.03); c.rotation.x = -0.35; stand.add(c);
      box(0.66, 0.43, 0.02, rim, 0, 1.18, 0.0, stand).rotation.x = -0.35;
      const toEntry = Math.atan2(-3 - at[0], 6 - at[1]);
      stand.position.set(at[0] + Math.sin(toEntry) * (R + 0.55), 0, at[1] + Math.cos(toEntry) * (R + 0.55));
      stand.rotation.y = toEntry;
      S.add(stand);
      this.obstacles.push({ x: stand.position.x, z: stand.position.z, r: 0.25 });
    });
  }

  // ------------------------------------------------------------------ the reception desk and the clerk
  buildDesk(models, makeRig) {
    const S = this.scene, g = new THREE.Group(), { x, z, r } = DESK;
    const gloss = new THREE.MeshPhysicalMaterial({ color: 0xf6f4f0, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    const oakTop = new THREE.MeshStandardMaterial({ color: 0xb98552, roughness: 0.45 });
    const front = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.0, 48, 1, true, -Math.PI * 0.42, Math.PI * 0.84), gloss);
    front.position.y = 0.55; front.material.side = THREE.DoubleSide;
    const topM = new THREE.Mesh(new THREE.RingGeometry(r - 0.62, r + 0.06, 48, 1, Math.PI / 2 - Math.PI * 0.42, Math.PI * 0.84), oakTop);
    topM.rotation.x = -Math.PI / 2; topM.position.y = 1.07;
    const topEdge = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.06, r + 0.06, 0.05, 48, 1, true, -Math.PI * 0.42, Math.PI * 0.84), oakTop); topEdge.position.y = 1.05;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.04, r - 0.04, 0.08, 48, 1, true, -Math.PI * 0.42, Math.PI * 0.84), oakTop); base.position.y = 0.04;
    const ledStrip = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.01, r + 0.01, 0.02, 48, 1, true, -Math.PI * 0.42, Math.PI * 0.84), new THREE.MeshBasicMaterial({ color: 0xffe2b8, toneMapped: false }));
    ledStrip.position.y = 0.1;
    g.add(front, topM, topEdge, base, ledStrip);
    for (const o of [front, topM, topEdge, base]) { o.castShadow = o.receiveShadow = true; o.material.side = THREE.DoubleSide; }
    // on it (the clerk's side, ~0.3 m in from the front): a monitor, keyboard, card terminal, a tray of keys, a vase
    const black = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.35, metalness: 0.4 });
    const ang = (a, d) => [Math.sin(a) * d, Math.cos(a) * d];
    const [mx, mz] = ang(-0.25, r - 0.38);
    const mon = new THREE.Group(); box(0.62, 0.38, 0.03, black, 0, 0.3, 0, mon); box(0.05, 0.22, 0.05, black, 0, 0.1, -0.03, mon); box(0.22, 0.015, 0.16, black, 0, 0.007, -0.03, mon);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.34), new THREE.MeshBasicMaterial({ color: 0x9fc0ee, toneMapped: false })); scr.position.set(0, 0.3, -0.017); scr.rotation.y = Math.PI; mon.add(scr);
    mon.position.set(mx, 1.08, mz); mon.rotation.y = -0.25 + Math.PI; g.add(mon);
    const kb = box(0.44, 0.02, 0.14, black, 0, 1.09, 0, g); const [kx, kz] = ang(-0.25, r - 0.62); kb.position.set(kx, 1.09, kz); kb.rotation.y = -0.25;
    const term = box(0.08, 0.04, 0.16, black, 0, 1.1, 0, g); const [tx, tz] = ang(0.25, r - 0.3); term.position.set(tx, 1.1, tz); term.rotation.set(0.3, 0.25, 0);
    const tray = box(0.3, 0.025, 0.2, new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.25 }), 0, 1.09, 0, g); const [ox, oz] = ang(0.6, r - 0.3); tray.position.set(ox, 1.09, oz);
    for (let k = 0; k < 4; k++) box(0.035, 0.012, 0.07, black, ox - 0.1 + k * 0.065, 1.11, oz, g);
    const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.22, 16), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.1, clearcoat: 1 }));
    const [vx, vz] = ang(-0.9, r - 0.25); vase.position.set(vx, 1.19, vz); g.add(vase);
    for (let k = 0; k < 5; k++) { const f = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshStandardMaterial({ color: k % 2 ? 0xe23a3a : 0xffffff, roughness: 0.6 })); f.position.set(vx + Math.sin(k * 1.3) * 0.06, 1.38 + (k % 3) * 0.03, vz + Math.cos(k * 1.3) * 0.06); g.add(f); }
    g.position.set(x, 0, z);
    g.rotation.y = -0.35; // (turned a little toward the door)
    S.add(g);
    this.deskYaw = -0.35;
    // the clerk behind it, facing the room
    try {
      this.clerk = makeRig();
      this.clerk.setSkisVisible?.(false);
      this.clerk.addTo(this.scene);
      this.clerk.root.position.set(x - Math.sin(this.deskYaw) * 0.25, 0, z - Math.cos(this.deskYaw) * 0.25);
    } catch (e) { console.warn('car rental clerk', e); this.clerk = null; }
    this.clerkYaw = this.deskYaw;
    this.clerkHit = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.9, 1.2), HITBOX);
    this.clerkHit.position.set(x, 0.95, z); this.clerkHit.userData.kind = 'clerk';
    S.add(this.clerkHit); this.aimables.push(this.clerkHit);
    // the desk keeps you on the customer side: a ring of circles along its front
    for (let a = -Math.PI * 0.42; a <= Math.PI * 0.42 + 1e-3; a += Math.PI * 0.12) this.obstacles.push({ x: x + Math.sin(a + this.deskYaw) * r, z: z + Math.cos(a + this.deskYaw) * r, r: 0.35 });
    this.obstacles.push({ x, z, r: r - 0.2 });
    // a key cabinet on the wall behind the desk
    const kc = new THREE.Group(); box(1.4, 0.9, 0.08, new THREE.MeshStandardMaterial({ color: 0xb98552, roughness: 0.5 }), 0, 0, 0, kc);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) box(0.03, 0.08, 0.02, black, -0.55 + i * 0.22, 0.25 - j * 0.25, 0.06, kc);
    kc.position.set(x + 0.3, 1.9, -ROOM.D / 2 + 0.06); S.add(kc);
    if (models.potted_plant) for (const [px, pz] of [[11.9, -7.1], [5.2, -7.1]]) { const p = fitModel(models.potted_plant, { size: 1.5, axis: 'y' }); p.position.set(px, 0, pz); p.traverse((o) => { if (o.isMesh) o.castShadow = true; }); S.add(p); this.obstacles.push({ x: px, z: pz, r: 0.45 }); }
  }

  // ------------------------------------------------------------------ the lounge: a leather sofa, a coffee table, plants
  buildLounge(models) {
    const S = this.scene, g = new THREE.Group();
    const leather = new THREE.MeshPhysicalMaterial({ color: 0x8a4a22, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4 });
    const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.4, metalness: 0.6 });
    box(2.2, 0.38, 0.9, leather, 0, 0.42, 0, g); box(2.2, 0.48, 0.2, leather, 0, 0.82, -0.36, g);
    for (const sx of [-1.05, 1.05]) box(0.2, 0.62, 0.9, leather, sx, 0.5, 0, g);
    for (const sx of [-0.52, 0.52]) box(1.0, 0.14, 0.72, leather, sx, 0.66, 0.06, g);
    for (const sx of [-1.0, 1.0]) for (const sz of [-0.38, 0.38]) box(0.04, 0.24, 0.04, black, sx, 0.12, sz, g);
    g.position.set(-9.2, 0, 6.95); g.rotation.y = Math.PI; S.add(g);
    const table = new THREE.Group();
    const tTop = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 32), new THREE.MeshPhysicalMaterial({ color: 0x2b2b2b, roughness: 0.1, clearcoat: 1 })); tTop.position.y = 0.42; tTop.castShadow = true;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.2, 0.42, 16), black); leg.position.y = 0.21;
    table.add(tTop, leg);
    for (let k = 0; k < 3; k++) box(0.24, 0.012, 0.32, new THREE.MeshStandardMaterial({ color: [0x1546c8, 0xd0342c, 0xf2f2f0][k], roughness: 0.7 }), -0.1 + k * 0.08, 0.45 + k * 0.012, 0, table).rotation.y = k * 0.4;
    table.position.set(-9.2, 0, 5.6); S.add(table);
    this.obstacles.push({ x: -9.7, z: 6.95, r: 0.7 }, { x: -8.7, z: 6.95, r: 0.7 }, { x: -9.2, z: 5.6, r: 0.6 });
    if (models.potted_plant) for (const [px, pz] of [[-12, 7.1], [-6.6, 7.2], [-12, -7.1]]) { const p = fitModel(models.potted_plant, { size: 1.6, axis: 'y' }); p.position.set(px, 0, pz); p.traverse((o) => { if (o.isMesh) o.castShadow = true; }); S.add(p); this.obstacles.push({ x: px, z: pz, r: 0.45 }); }
  }

  // ------------------------------------------------------------------ the workshop wall: tool cabinet, tyre rack
  buildWorkshop() {
    const S = this.scene;
    const red = new THREE.MeshPhysicalMaterial({ color: 0xb3171b, roughness: 0.3, clearcoat: 0.8 });
    const alu = new THREE.MeshStandardMaterial({ color: 0xd0d4d8, metalness: 1, roughness: 0.25 });
    const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.7 });
    // the tool cabinet against the left wall: drawers with aluminium handles, a pegboard with tools above
    const tc = new THREE.Group();
    box(1.6, 1.0, 0.6, red, 0, 0.58, 0, tc); box(1.62, 0.04, 0.62, black, 0, 1.1, 0, tc);
    for (let i = 0; i < 6; i++) { box(1.5, 0.008, 0.01, black, 0, 0.2 + i * 0.15, 0.302, tc); box(0.5, 0.025, 0.03, alu, 0, 0.26 + i * 0.15, 0.31, tc); }
    for (const sx of [-0.7, 0.7]) for (const sz of [-0.25, 0.25]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 12), black); w.rotation.z = Math.PI / 2; w.position.set(sx, 0.04, sz); tc.add(w); }
    box(1.6, 1.0, 0.03, new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.8 }), 0, 1.75, -0.29, tc);
    for (let i = 0; i < 7; i++) box(0.04, 0.22 + (i % 3) * 0.06, 0.02, alu, -0.6 + i * 0.2, 1.75, -0.26, tc);
    tc.position.set(-12.62, 0, -0.1); tc.rotation.y = Math.PI / 2; S.add(tc);
    this.obstacles.push({ x: -12.6, z: -0.6, r: 0.5 }, { x: -12.6, z: 0.4, r: 0.5 });
    // the tyre rack against the right wall: two shelves of winter tyres standing upright (alloys on half of them)
    const tr = new THREE.Group(), rack = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.5 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
    for (const sx of [-1.1, 1.1]) for (const sz of [-0.25, 0.25]) box(0.05, 1.7, 0.05, rack, sx, 0.85, sz, tr);
    for (const y of [0.1, 0.92]) { box(2.25, 0.04, 0.55, rack, 0, y, 0, tr);
      for (let i = 0; i < 4; i++) {
        const t = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.11, 12, 28), tyre); t.position.set(-0.8 + i * 0.53, y + 0.4, 0); t.castShadow = true; tr.add(t);
        if ((i + (y > 0.5 ? 1 : 0)) % 2 === 0) { const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 20), alu); rim.rotation.x = Math.PI / 2; rim.position.copy(t.position); tr.add(rim); }
      } }
    tr.position.set(12.62, 0, -1.6); tr.rotation.y = -Math.PI / 2; S.add(tr);
    this.obstacles.push({ x: 12.6, z: -2.4, r: 0.6 }, { x: 12.6, z: -0.8, r: 0.6 });
  }

  // ------------------------------------------------------------------ the configurator (ui/carrental.js): your car, live
  /** Show cfg on that model's turntable (stopped), the camera on it for this step (interior: from the driver's seat). */
  configure(cfg, step) {
    const T = this.tables.find((o) => o.id === cfg.id);
    if (!T) return;
    if (this.cfg && this.cfg.table !== T) this.restore(this.cfg.table);
    const prev = this.cfg;
    const want = step === 'interior' && FULL[cfg.id] ? 'full' : 'simple';
    // (a car of its own for the preview: wheels as their own parts, so the rims take their colour)
    if (!T.cfgInst || T.cfgKind !== want) {
      const t = want === 'full' && T.fullT ? T.fullT : T.t;
      if (want === 'full' && !T.fullT) {
        loadGLB(FULL[cfg.id]).then((g) => { if (!g) return; T.fullT = carTemplate(g, T.spec.length, FULL[cfg.id]); if (this.cfg?.table === T && this.cfg.step === 'interior') this.configure(this.cfg.cfg, 'interior'); }).catch(() => {});
      }
      const inst = carInstance(t, { wheels: true });
      inst.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      if (T.cfgInst) T.spin.remove(T.cfgInst.group); else T.spin.remove(T.inst.group);
      T.spin.add(inst.group);
      T.cfgInst = inst; T.cfgT = t; T.cfgKind = t === T.t ? 'simple' : 'full';
    }
    dressCar(T.cfgInst, T.cfgT, cfg);
    for (const g of T.cfgInst.glass) g.visible = step !== 'interior'; // (from inside: the cabin in clear view)
    const shot = SHOT[step];
    this.cfg = { table: T, cfg, step, yaw: shot ? shot[0] : prev?.yaw ?? 0.8, pitch: shot ? shot[1] : 0.2, dist: shot ? shot[2] : 5.5, look: 0, lookP: 0, snap: !prev };
  }
  /** Drag: turn round the car (or look round the cabin). */
  orbit(dx, dy) {
    const c = this.cfg;
    if (!c) return;
    if (c.step === 'interior') { c.look = Math.max(-1.2, Math.min(1.2, c.look - dx)); c.lookP = Math.max(-0.5, Math.min(0.4, c.lookP - dy)); }
    else { c.yaw -= dx; c.pitch = Math.max(0.02, Math.min(0.75, c.pitch + dy)); c.dragged = true; }
  }
  restore(T) {
    if (!T?.cfgInst) return;
    T.spin.remove(T.cfgInst.group); T.spin.add(T.inst.group);
    T.cfgInst = null; T.cfgKind = null;
  }
  endConfigure() {
    if (!this.cfg) return;
    this.restore(this.cfg.table);
    this.cfg = null;
    this.camera.clearViewOffset();
  }
  // the configurator's camera: round the stopped turntable, or in the driver's seat; the car framed right of the panel
  cfgCamera(dt) {
    const c = this.cfg, T = c.table, cam = this.camera;
    const W = innerWidth, H = innerHeight;
    cam.setViewOffset(W, H, -W * 0.2, 0, W, H);
    const pos = _v, look = new THREE.Vector3();
    T.spin.updateMatrixWorld(true);
    const heading = T.spin.rotation.y;
    if (c.step === 'interior') {
      const t = T.cfgT, eye = driverEye(t);
      eye.y += 0.04; eye.z -= 0.05;
      pos.copy(eye); T.spin.localToWorld(pos);
      const a = c.look, p = -0.22 + c.lookP;
      look.set(eye.x + Math.sin(a) * Math.cos(p), eye.y + Math.sin(p), eye.z + Math.cos(a) * Math.cos(p)); T.spin.localToWorld(look);
      cam.fov = 72;
    } else {
      if (!c.dragged) c.yaw += dt * 0.06; // (a slow drift round it)
      const a = heading + c.yaw;
      pos.set(T.x + Math.sin(a) * c.dist * Math.cos(c.pitch), 0.16 + 0.7 + Math.sin(c.pitch) * c.dist, T.z + Math.cos(a) * c.dist * Math.cos(c.pitch));
      pos.x = Math.max(-ROOM.W / 2 + 0.4, Math.min(ROOM.W / 2 - 0.4, pos.x)); pos.z = Math.max(-ROOM.D / 2 + 0.4, Math.min(ROOM.D / 2 - 0.4, pos.z));
      look.set(T.x, c.step === 'rims' ? 0.5 : 0.75, T.z);
      cam.fov = 45;
    }
    // (eased there; at once the first time and between inside / outside)
    const inside = c.step === 'interior';
    if (c.snap || c.wasInside !== inside) { cam.position.copy(pos); c.at = look.clone(); c.snap = false; }
    else { const k = 1 - Math.exp(-dt * 5); cam.position.lerp(pos, k); c.at.lerp(look, k); }
    c.wasInside = inside;
    cam.lookAt(c.at);
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ per frame
  enter() {
    this.active = true;
    this.pos.set(DOOR.x, 0, ROOM.D / 2 - 1.3);
    this.yaw = Math.PI - 0.15; this.pitch = -0.06; this.vel.set(0, 0, 0);
  }

  /** Walk / look (input null: a panel is open); returns what the crosshair is on: { kind, id, paint, label } or null. */
  update(dt, input, sensitivity = 1, talking = false) {
    for (const t of this.tables) if (this.cfg?.table !== t) t.spin.rotation.y += t.speed * dt;
    if (this.cfg) { this.cfgCamera(dt); return null; } // (configuring: the camera is on your car)
    if (this.camera.fov !== 70) { this.camera.fov = 70; this.camera.updateProjectionMatrix(); }
    // the clerk: idle behind the desk, turning to you when you come close or while you talk
    if (this.clerk) {
      const c = this.clerk.root.position, near = talking || Math.hypot(this.pos.x - c.x, this.pos.z - c.z) < 6;
      const want = near ? Math.atan2(this.pos.x - c.x, this.pos.z - c.z) : this.deskYaw;
      this.clerkYaw += Math.atan2(Math.sin(want - this.clerkYaw), Math.cos(want - this.clerkYaw)) * (1 - Math.exp(-dt * 4));
      this.clerk.update(dt, { mode: 'idle', heading: this.clerkYaw, speed: 0, crouch: 0, lean: 0, plow: 0, normal: UP });
    }
    if (input) {
      const sens = 0.0022 * sensitivity;
      this.yaw -= input.mdx * sens;
      this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - input.mdy * sens));
      const fw = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0), st = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
      const f = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), want = new THREE.Vector3(-f.z * st + f.x * fw, 0, f.x * st + f.z * fw);
      if (want.lengthSq()) want.normalize().multiplyScalar(2.4);
      this.vel.lerp(want, 1 - Math.exp(-dt * 10));
    } else this.vel.multiplyScalar(Math.exp(-dt * 10));
    this.pos.addScaledVector(this.vel, dt);
    for (const o of this.obstacles) {
      const dx = this.pos.x - o.x, dz = this.pos.z - o.z, d = Math.hypot(dx, dz), rr = o.r + 0.3;
      if (d < rr && d > 1e-4) { this.pos.x = o.x + (dx / d) * rr; this.pos.z = o.z + (dz / d) * rr; }
    }
    this.pos.x = Math.max(-ROOM.W / 2 + 0.45, Math.min(ROOM.W / 2 - 0.45, this.pos.x));
    this.pos.z = Math.max(-ROOM.D / 2 + 0.45, Math.min(ROOM.D / 2 - 0.45, this.pos.z));
    this.camera.position.set(this.pos.x, EYE, this.pos.z);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(_v.copy(this.camera.position).add(dir));
    if (!input) return null;
    const hits = new THREE.Raycaster(this.camera.position, dir, 0, 7).intersectObjects(this.aimables, false);
    const u = hits[0]?.object.userData;
    if (!u?.kind) return null;
    if (u.kind === 'door') return { kind: 'door', label: 'Leave Car Rental' };
    if (u.kind === 'clerk') return { kind: 'clerk', label: 'Talk to the rental clerk' };
    return { kind: 'car', id: u.id, paint: u.paint, label: `Rent ${u.label}` };
  }
}
