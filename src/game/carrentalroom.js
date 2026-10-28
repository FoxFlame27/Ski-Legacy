// Inside the CAR RENTAL (its own scene, like the ski shop's: main.js renders it through post.setView while you're in).
// The very hall you see from the road (carrentalshell.js builds both sides from one LAYOUT): larch walls, the glass
// front with its mullions and door, the vaulted timber ceiling on glulam trusses, the five cars on their turntables
// where they stand behind the glass outside. Through the glass: the real world, captured once as you come in
// (carrental.js: a cube camera just outside the door, set as this scene's background, turned with the building).
// A polished dark stone floor that mirrors the cars, a free-standing reception desk (the clerk behind it), a small
// lounge corner. Walk with WASD + mouse; look at a car or the clerk and press E (carrental.js opens the rental card).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { fitModel, loadGLB } from '../core/assets.js';
import { carTemplate, carInstance, driverEye } from './cars.js';
import { dressCar } from './carconfig.js';
import { LAYOUT, buildShell } from './carrentalshell.js';
// the full-detail models (their interiors) for the configurator's cockpit view (as drive.js)
const FULL = { car_audi_rs6: 'car_audi_rs6_full', car_vw_golf_gti: 'car_vw_golf_gti_full', car_tesla_m3: 'car_tesla_m3_full' };
// where the configurator's camera looks from, per step (round the car from its nose: 0 front, pi the back), how far
const SHOT = { car: [0.75, 0.2, 5.6], paint: [1.05, 0.24, 5.4], rims: [1.45, 0.06, 4.6], plate: [Math.PI - 0.3, 0.12, 4.8], sum: [0.6, 0.22, 5.8] };

export const ROOM = { W: LAYOUT.W, D: LAYOUT.D, H: LAYOUT.H };
const EYE = 1.62, UP = new THREE.Vector3(0, 1, 0);
const HITBOX = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const DOOR = LAYOUT.door, DESK = LAYOUT.desk;
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
  }
  /** The world outside the glass (a cube texture captured at the door; yaw: the building's heading in the world). */
  setOutside(cubeTex, yaw) {
    this.scene.background = cubeTex || new THREE.Color(0x2a2420);
    this.scene.backgroundRotation?.set(0, -yaw, 0);
    this.scene.backgroundIntensity = 1;
  }

  // ------------------------------------------------------------------ the room
  buildShell() {
    const { W, D } = ROOM, S = this.scene;
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
    // the hall: the shared shell (walls, the glass front and door, the trusses and ceiling), the glass nearly clear
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xe6f2f8, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.1, depthWrite: false });
    buildShell(S, 'in', glass);
    this.doorHit = new THREE.Mesh(new THREE.BoxGeometry(DOOR.w, DOOR.h, 0.4), HITBOX);
    this.doorHit.position.set(DOOR.x, DOOR.h / 2, D / 2 - 0.1); this.doorHit.userData.kind = 'door';
    S.add(this.doorHit); this.aimables.push(this.doorHit);
    const steel = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.4, metalness: 0.7 });
    box(W, 0.1, 0.03, steel, 0, 0.05, -D / 2 + 0.015, S); // (skirting)
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
    sm.position.set(-4.4, 3.6, -D / 2 + 0.03); S.add(sm);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 2.4), new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false }));
    halo.position.set(-4.4, 3.6, -D / 2 + 0.02); S.add(halo);
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
    const S = this.scene, spots = LAYOUT.spots; // (where they stand seen from outside too)
    const rim = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const top = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.55, metalness: 0.2 });
    const led = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e4, emissiveIntensity: 2.4 });
    display.forEach((d, k) => {
      const spec = cars.find((c) => c.id === d.id), gltf = models[d.id], at = spots[k % spots.length];
      if (!spec || !gltf) return;
      const R = LAYOUT.R, tt = new THREE.Group();
      tt.position.set(at[0], 0, at[1]);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.16, 64), top); disc.position.y = 0.08; disc.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.06, 10, 96), rim); ring.rotation.x = Math.PI / 2; ring.position.y = 0.13;
      const glow = new THREE.Mesh(new THREE.TorusGeometry(R + 0.07, 0.018, 6, 96), led); glow.rotation.x = Math.PI / 2; glow.position.y = 0.035;
      tt.add(disc, ring, glow);
      const spin = new THREE.Group(); spin.position.y = 0.16; tt.add(spin);
      const inst = carInstance(carTemplate(gltf, spec.length, d.id), { paint: d.paint });
      inst.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      spin.add(inst.group);
      spin.rotation.y = at[2];
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
      const toEntry = at[1] > 0 ? Math.atan2(DOOR.x - at[0], ROOM.D / 2 - at[1]) * 0.35 : Math.PI / 2; // (the front row's cards in front, turned a little to the door; the back row's beside, in the gap between the turntables)
      stand.position.set(at[0] + Math.sin(toEntry) * (R + 0.55), 0, at[1] + Math.cos(toEntry) * (R + 0.55));
      stand.rotation.y = toEntry;
      S.add(stand);
      this.obstacles.push({ x: stand.position.x, z: stand.position.z, r: 0.25 });
    });
  }

  // ------------------------------------------------------------------ the reception desk and the clerk
  buildDesk(models, makeRig) {
    const S = this.scene, g = new THREE.Group(), { x, z, r } = DESK;
    // a solid curved counter standing on the floor: a white gloss body (an annular sector, 0.62 m deep, 1.04 m
    // high), an oak top proud of it all round, a recessed dark plinth with an LED line; open toward the back wall
    const gloss = new THREE.MeshPhysicalMaterial({ color: 0xf6f4f0, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    const oakTop = new THREE.MeshStandardMaterial({ color: 0xb98552, roughness: 0.45 });
    const A = Math.PI * 0.4; // (half the arc)
    const sector = (r0, r1, a0 = -A, a1 = A) => { const sh = new THREE.Shape(); sh.absarc(0, 0, r1, Math.PI / 2 - a1, Math.PI / 2 - a0, false); sh.absarc(0, 0, r0, Math.PI / 2 - a0, Math.PI / 2 - a1, true); sh.closePath(); return sh; };
    // (drawn in x / y, laid flat: rotation.x -90 deg takes the shape's y to -z, so it is mirrored (scale.y -1) to
    // put the arc's front toward +z, the room)
    const slab = (shape, y0, h, mat) => { const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 40 }), mat); m.rotation.x = -Math.PI / 2; m.scale.y = -1; m.position.y = y0; mat.side = THREE.DoubleSide; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    slab(sector(r - 0.56, r - 0.06), 0, 0.1, new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.6 }));
    slab(sector(r - 0.62, r), 0.1, 0.94, gloss);
    slab(sector(r - 0.66, r + 0.05, -A - 0.02, A + 0.02), 1.04, 0.05, oakTop);
    const ledStrip = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.055, r - 0.055, 0.015, 48, 1, true, -A, 2 * A), new THREE.MeshBasicMaterial({ color: 0xffe2b8, toneMapped: false }));
    ledStrip.position.y = 0.095; g.add(ledStrip);
    // on it (the clerk's side, ~0.3 m in from the front): a monitor, keyboard, card terminal, a tray of keys, a vase
    const black = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.35, metalness: 0.4 });
    const ang = (a, d) => [Math.sin(a) * d, Math.cos(a) * d];
    const [mx, mz] = ang(-0.25, r - 0.38);
    const mon = new THREE.Group(); box(0.62, 0.38, 0.03, black, 0, 0.3, 0, mon); box(0.05, 0.22, 0.05, black, 0, 0.1, -0.03, mon); box(0.22, 0.015, 0.16, black, 0, 0.007, -0.03, mon);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.34), new THREE.MeshBasicMaterial({ color: 0x9fc0ee, toneMapped: false })); scr.position.set(0, 0.3, -0.017); scr.rotation.y = Math.PI; mon.add(scr);
    mon.position.set(mx, 1.09, mz); mon.rotation.y = -0.25 + Math.PI; g.add(mon);
    const kb = box(0.44, 0.02, 0.14, black, 0, 1.09, 0, g); const [kx, kz] = ang(-0.25, r - 0.62); kb.position.set(kx, 1.09, kz); kb.rotation.y = -0.25;
    const term = box(0.08, 0.04, 0.16, black, 0, 1.1, 0, g); const [tx, tz] = ang(0.25, r - 0.3); term.position.set(tx, 1.1, tz); term.rotation.set(0.3, 0.25, 0);
    const tray = box(0.3, 0.025, 0.2, new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.25 }), 0, 1.09, 0, g); const [ox, oz] = ang(0.6, r - 0.3); tray.position.set(ox, 1.09, oz);
    for (let k = 0; k < 4; k++) box(0.035, 0.012, 0.07, black, ox - 0.1 + k * 0.065, 1.11, oz, g);
    const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.22, 16), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.1, clearcoat: 1 }));
    const [vx, vz] = ang(-0.9, r - 0.25); vase.position.set(vx, 1.19, vz); g.add(vase);
    for (let k = 0; k < 5; k++) { const f = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshStandardMaterial({ color: k % 2 ? 0xe23a3a : 0xffffff, roughness: 0.6 })); f.position.set(vx + Math.sin(k * 1.3) * 0.06, 1.38 + (k % 3) * 0.03, vz + Math.cos(k * 1.3) * 0.06); g.add(f); }
    g.position.set(x, 0, z);
    S.add(g);
    this.deskYaw = 0; // (square to the back wall, facing the room)
    // the clerk behind it, facing the room
    try {
      this.clerk = makeRig();
      this.clerk.setSkisVisible?.(false);
      this.clerk.addTo(this.scene);
      this.clerk.root.position.set(x, 0, z + r - 1.05); // (behind the counter, at it)
    } catch (e) { console.warn('car rental clerk', e); this.clerk = null; }
    this.clerkYaw = this.deskYaw;
    this.clerkHit = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.9, 1.2), HITBOX);
    this.clerkHit.position.set(x, 0.95, z + r - 1.05); this.clerkHit.userData.kind = 'clerk';
    S.add(this.clerkHit); this.aimables.push(this.clerkHit);
    // the desk keeps you on the customer side: a ring of circles along its front
    for (let a = -A; a <= A + 1e-3; a += A / 6) this.obstacles.push({ x: x + Math.sin(a) * (r - 0.3), z: z + Math.cos(a) * (r - 0.3), r: 0.38 });
    this.obstacles.push({ x, z, r: r - 0.4 });
    // a key cabinet on the wall behind the desk
    const kc = new THREE.Group(); box(1.4, 0.9, 0.08, new THREE.MeshStandardMaterial({ color: 0xb98552, roughness: 0.5 }), 0, 0, 0, kc);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) box(0.03, 0.08, 0.02, black, -0.55 + i * 0.22, 0.25 - j * 0.25, 0.06, kc);
    kc.position.set(x, 1.9, -ROOM.D / 2 + 0.04); S.add(kc); // (flush on the wall: its back on the boards)
    if (models.potted_plant) for (const [px, pz] of [[x + r + 0.9, -ROOM.D / 2 + 0.6], [x - r - 0.9, -ROOM.D / 2 + 0.6]]) { const p = fitModel(models.potted_plant, { size: 1.5, axis: 'y' }); p.position.set(px, 0, pz); p.traverse((o) => { if (o.isMesh) o.castShadow = true; }); S.add(p); this.obstacles.push({ x: px, z: pz, r: 0.45 }); }
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
    const { z: lz } = LAYOUT.lounge, wx = ROOM.W / 2 - 0.5; // (the sofa's back to the right wall, facing the room)
    g.position.set(wx, 0, lz); g.rotation.y = -Math.PI / 2; S.add(g);
    const table = new THREE.Group();
    const tTop = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 32), new THREE.MeshPhysicalMaterial({ color: 0x2b2b2b, roughness: 0.1, clearcoat: 1 })); tTop.position.y = 0.42; tTop.castShadow = true;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.2, 0.4, 16), black); leg.position.y = 0.2;
    table.add(tTop, leg);
    for (let k = 0; k < 3; k++) box(0.24, 0.012, 0.32, new THREE.MeshStandardMaterial({ color: [0x1546c8, 0xd0342c, 0xf2f2f0][k], roughness: 0.7 }), -0.1 + k * 0.08, 0.446 + k * 0.012, 0, table).rotation.y = k * 0.4;
    table.position.set(wx - 1.45, 0, lz); S.add(table);
    this.obstacles.push({ x: wx, z: lz - 0.55, r: 0.7 }, { x: wx, z: lz + 0.55, r: 0.7 }, { x: wx - 1.45, z: lz, r: 0.6 });
    if (models.potted_plant) for (const [px, pz] of [[ROOM.W / 2 - 0.55, lz - 1.75], [ROOM.W / 2 - 0.55, ROOM.D / 2 - 0.7]]) { const p = fitModel(models.potted_plant, { size: 1.5, axis: 'y' }); p.position.set(px, 0, pz); p.traverse((o) => { if (o.isMesh) o.castShadow = true; }); S.add(p); this.obstacles.push({ x: px, z: pz, r: 0.45 }); }
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
