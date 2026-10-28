// CAR RENTAL: cars are no longer free to take. The rental garage stands on the road through Legacy Village (its site:
// game/bus/roads.js planRental: a flat lot right on the road's edge): an alpine chalet showroom (stone base, larch
// boards, a snowy pitched roof, a big glazed showroom with a car inside, a sectional garage door, the CAR RENTAL sign
// lit at night) and its ploughed yard in front, on the road. E at the door: inside (carrentalroom.js, its own scene);
// at a car on display or the clerk: the rental card (ui/carrental.js). The rented car waits in the yard, nose to the
// road; E beside it to drive (drive.js: every other car only says where to rent one). One rental at a time (renting
// another returns the old one); it is kept in the save (back in the yard next time). Wreck it: $1000 (once; the
// balance may go below zero, like a fine), the rental ends and the tow truck (towtruck.js) fetches the very car from
// wherever it lies and brings it back to the yard on its bed.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { nightUniform } from '../world/village.js';
import { busRoads } from './bus/roads.js';
import { carTemplate, carInstance } from './cars.js';
import { CarRentalRoom } from './carrentalroom.js';
import { TowTruck } from './towtruck.js';
import { CarRentalUI } from '../ui/carrental.js';
import { PAINTS, normConfig, extrasCost, dressCar, paintOf, randomPlate } from './carconfig.js';

export const RENTALS = [
  { id: 'car_vw_golf_gti', label: 'VW Golf GTI', kind: 'Hot hatch', price: 150, length: 4.3 },
  { id: 'car_dacia_duster', label: 'Dacia Duster', kind: 'Compact SUV', price: 150, length: 4.34 },
  { id: 'car_tesla_m3', label: 'Tesla Model 3', kind: 'Electric saloon', price: 250, length: 4.7 },
  { id: 'car_bmw_x3', label: 'BMW X3', kind: 'Premium SUV', price: 300, length: 4.7 },
  { id: 'car_audi_rs6', label: 'Audi RS6 Avant', kind: 'Performance estate', price: 450, length: 5.0 },
];
export { PAINTS }; // (the configurator's: carconfig.js)
// the five cars on display inside (one of each, each its own colour)
const DISPLAY = [['car_audi_rs6', 'graphite'], ['car_tesla_m3', 'white'], ['car_bmw_x3', 'blue'], ['car_vw_golf_gti', 'red'], ['car_dacia_duster', 'orange']];
export const WRECK_FEE = 1000;
const paintHex = (id) => paintOf(id).hex;

export class CarRental {
  constructor(o) {
    // o: scene, camera, renderer, models, colliders, cameraBlockers, parking, drive, traffic, hud, audio, save, writeSave,
    //    spend, makeRig, transition, player, input, getPost
    Object.assign(this, o);
    this.L = busRoads.rental;
    this.inside = false;
    this.current = null; // the rented car (a parking entry, rental: true)
    this.ui = new CarRentalUI({ hud: o.hud, audio: o.audio });
    if (!this.L) return;
    const L = this.L;
    this.yaw0 = Math.atan2(L.dirx, L.dirz); // the lot's frame: local +z toward the road, +x along it
    this.buildOutside();
    this.room = new CarRentalRoom({ renderer: o.renderer, models: o.models, makeRig: o.makeRig, cars: RENTALS, display: DISPLAY.map(([id, paint]) => ({ id, paint: paintHex(paint) })) });
    // the tow truck: parked in the yard, nose toward the building's end; out: backs up, then round to the road
    const park = this.w(4.6, 4.2), back = this.w(11.6, 4.2);
    try {
      this.truck = new TowTruck({ scene: o.scene, models: o.models, colliders: o.colliders, camera: o.camera, traffic: o.traffic, audio: o.audio,
        park: { ...park, yaw: this.yaw0 - Math.PI / 2 }, yardOut: [back, this.w(12.6, 9), this.w(11.5, 15.6)] });
    } catch (e) { console.warn('tow truck', e); this.truck = null; }
    // drive.js: only your rental lets you in; a wreck of it: the fee and the truck
    if (o.drive) {
      o.drive.locked = (e) => (e.rental ? null : 'Rent a car at Car Rental in Legacy Village');
      o.drive.onWreck = (e) => this.wrecked(e);
    }
    // the save: your rental back in the yard
    const s = o.save.rental;
    if (s && RENTALS.some((c) => c.id === s.id)) { try { o.save.rental = normConfig(s); this.current = this.spawn(o.save.rental); } catch (e) { console.warn('rental car', e); } }
  }

  // lot frame -> world { x, z }
  w(lx, lz) { const L = this.L, fx = L.dirx, fz = L.dirz; return { x: L.x + fz * lx + fx * lz, z: L.z - fx * lx + fz * lz }; }

  // ------------------------------------------------------------------ the building and the yard
  buildOutside() {
    const L = this.L, g = new THREE.Group();
    g.name = 'car-rental';
    g.position.set(L.x, L.y, L.z); g.rotation.y = this.yaw0;
    const BW = 22, BD = 10, BZ = -8, WALL = 5.0; // building: width, depth, its middle (local z), wall height
    const front = BZ + BD / 2;
    const mk = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; parent.add(m); return m; };
    const B = (w, h, d, mat, x, y, z) => mk(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
    const canvas = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
    // larch boards (vertical) and the grey stone base
    const larch = canvas(512, 512, (c, w, h) => { let s = 9; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647); for (let x = 0; x < w; x += 32) { const v = (r() - 0.5) * 30; c.fillStyle = `rgb(${178 + v},${118 + v * 0.8},${66 + v * 0.6})`; c.fillRect(x, 0, 32, h); c.fillStyle = 'rgba(40,20,6,0.55)'; c.fillRect(x, 0, 2, h); for (let k = 0; k < 8; k++) { c.fillStyle = `rgba(80,40,12,${0.06 + r() * 0.08})`; c.fillRect(x + 4 + r() * 24, 0, 1 + r() * 2, h); } } });
    larch.wrapS = larch.wrapT = THREE.RepeatWrapping; larch.repeat.set(5, 1.2);
    const stoneT = canvas(512, 256, (c, w, h) => { let s = 5; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647); c.fillStyle = '#5d5b57'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 42) for (let x = -(y % 84 ? 30 : 0); x < w; x += 60 + r() * 30) { const v = 120 + r() * 50; c.fillStyle = `rgb(${v},${v - 3},${v - 8})`; c.beginPath(); c.roundRect(x + 3, y + 3, 54 + r() * 20, 36, 8); c.fill(); } });
    stoneT.wrapS = stoneT.wrapT = THREE.RepeatWrapping; stoneT.repeat.set(4, 1);
    const wood = new THREE.MeshStandardMaterial({ map: larch, roughness: 0.8 });
    const stone = new THREE.MeshStandardMaterial({ map: stoneT, roughness: 0.95 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.45, metalness: 0.7 });
    const snow = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.9 });
    // walls: sides and back in larch over a stone plinth; the front: stone pillars and fascia framing glass and garage
    B(BW, WALL - 1, 0.3, wood, 0, 1 + (WALL - 1) / 2, BZ - BD / 2);
    for (const sx of [-1, 1]) B(0.3, WALL - 1, BD, wood, sx * BW / 2, 1 + (WALL - 1) / 2, BZ);
    B(BW + 0.2, 1, BD + 0.2, stone, 0, 0.5 - 0.3, BZ);
    for (const px of [-BW / 2 + 0.4, -1.9, 1.9, BW / 2 - 0.4]) B(0.8, WALL, 0.5, stone, px, WALL / 2, front);
    B(BW, 1.1, 0.5, wood, 0, WALL - 0.55, front);
    // the showroom glass (left), mullions, and a car on display behind it under warm light
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xcfe4f0, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.28 });
    mk(new THREE.PlaneGeometry(8.6, WALL - 1.3), glass, -6.2, (WALL - 1.3) / 2 + 0.2, front + 0.02).castShadow = false;
    for (const mx of [-8.4, -6.2, -4.0]) B(0.1, WALL - 1.3, 0.12, steel, mx, (WALL - 1.3) / 2 + 0.2, front + 0.05);
    B(8.6, 0.12, 0.14, steel, -6.2, 0.2, front + 0.05);
    const glow = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, emissive: 0xffd9a8, emissiveIntensity: 0.25, roughness: 0.9 });
    mk(new THREE.PlaneGeometry(8.6, WALL - 1.2), glow, -6.2, (WALL - 1.2) / 2 + 0.1, BZ - BD / 2 + 0.2); // (the showroom's back wall)
    mk(new THREE.PlaneGeometry(8.6, 4.4), new THREE.MeshStandardMaterial({ color: 0x3c3a38, roughness: 0.2 }), -6.2, 0.05, front - 2.4).rotation.x = -Math.PI / 2;
    this.glowMat = glow;
    if (this.models.car_audi_rs6) {
      const inst = carInstance(carTemplate(this.models.car_audi_rs6, 5.0, 'car_audi_rs6'), { paint: paintHex('graphite') });
      inst.group.position.set(-6.2, 0.06, front - 2.6); inst.group.rotation.y = -Math.PI / 2 + 0.35;
      inst.group.traverse((m) => { if (m.isMesh) m.castShadow = true; });
      g.add(inst.group);
    }
    // the garage door (right): white sectional panels
    const panelT = canvas(256, 256, (c, w, h) => { c.fillStyle = '#eef0f2'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 64) { c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, y, w, 3); c.fillStyle = 'rgba(255,255,255,0.7)'; c.fillRect(0, y + 3, w, 2); for (let x = 16; x < w; x += 60) { c.fillStyle = 'rgba(0,0,0,0.06)'; c.fillRect(x, y + 14, 44, 36); } } });
    mk(new THREE.PlaneGeometry(7.8, 3.8), new THREE.MeshStandardMaterial({ map: panelT, roughness: 0.4, metalness: 0.3 }), 6.2, 1.9, front + 0.03);
    // the entrance door between them (glass, under a small canopy) and its warm lamp
    mk(new THREE.PlaneGeometry(1.6, 2.5), new THREE.MeshPhysicalMaterial({ color: 0xffe6c0, emissive: 0xffd49a, emissiveIntensity: 0.35, roughness: 0.1, transparent: true, opacity: 0.75 }), 0, 1.25, front + 0.03);
    B(1.8, 0.1, 0.1, steel, 0, 2.55, front + 0.06);
    B(3.4, 0.14, 1.6, steel, 0, 3.1, front + 0.8);
    // the sign over the front: CAR RENTAL, lit at night
    const signT = canvas(2048, 256, (c, w, h) => {
      c.fillStyle = '#1b2f5c'; c.fillRect(0, 0, w, h); c.fillStyle = '#f2c88c'; c.fillRect(0, h - 14, w, 6); c.fillRect(0, 8, w, 6);
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#ffffff'; c.font = 'italic 700 170px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
      if ('letterSpacing' in c) c.letterSpacing = '22px';
      c.fillText('CAR RENTAL', w / 2, h / 2 + 6);
    });
    this.signMat = new THREE.MeshStandardMaterial({ map: signT, emissiveMap: signT, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.5 });
    mk(new THREE.PlaneGeometry(9.5, 1.2), this.signMat, 0, WALL - 0.55, front + 0.27);
    // wall lamps
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffc77a, emissiveIntensity: 0.2 });
    for (const lx of [-10.6, -1.3, 1.3, 10.6]) { B(0.18, 0.3, 0.2, steel, lx, 2.9, front + 0.35); mk(new THREE.BoxGeometry(0.14, 0.12, 0.12), this.lampMat, lx, 2.75, front + 0.4); }
    // the roof: a wide pitched roof (ridge along the front), deep eaves, thick snow on it, a gable fascia
    const RW = BW + 2.4, RD = BD + 2.6, rise = 3.0, half = RD / 2, slope = Math.hypot(half, rise), ang = Math.atan2(rise, half);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x33302c, roughness: 0.7 });
    for (const sz of [-1, 1]) {
      const p = mk(new THREE.BoxGeometry(RW, 0.25, slope), roofMat, 0, WALL + rise / 2, BZ + sz * half / 2);
      p.rotation.x = sz * ang;
      const sn = mk(new THREE.BoxGeometry(RW - 0.1, 0.32, slope - 0.1), snow, 0, WALL + rise / 2 + 0.26, BZ + sz * half / 2 + sz * 0.02);
      sn.rotation.x = sz * ang;
    }
    const gable = new THREE.Shape(); gable.moveTo(-BD / 2, 0); gable.lineTo(BD / 2, 0); gable.lineTo(0, rise - 0.1); gable.closePath();
    for (const sx of [-1, 1]) { const m = mk(new THREE.ShapeGeometry(gable), wood, sx * (BW / 2 + 0.01), WALL, BZ); m.rotation.y = sx * Math.PI / 2; m.material.side = THREE.DoubleSide; }
    // the yard: ploughed, packed snow over asphalt, two painted bays and the TOW bay, snow piles at the back corners
    const yardT = canvas(1024, 1024, (c, w, h) => {
      let s = 3; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      c.fillStyle = '#86837e'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const v = 108 + r() * 40; c.fillStyle = `rgba(${v + 6},${v + 3},${v},0.4)`; c.fillRect(r() * w, r() * h, 2, 2); }
      for (let i = 0; i < 70; i++) { const x = r() * w, y = r() * h, R = 30 + r() * 120, gr = c.createRadialGradient(x, y, 0, x, y, R); gr.addColorStop(0, 'rgba(232,234,236,0.45)'); gr.addColorStop(1, 'rgba(232,234,236,0)'); c.fillStyle = gr; c.fillRect(x - R, y - R, 2 * R, 2 * R); }
      // (the canvas spans the lot: x -15..15 -> 0..w, z -3..13 -> 0..h: its top row is the building's side) painted lines
      const X = (lx) => ((lx + 15) / 30) * w, Z = (lz) => ((lz + 3) / 16) * h;
      c.strokeStyle = 'rgba(245,245,240,0.9)'; c.lineWidth = 5;
      for (const lx of [-9.4, -6.6, -3.8]) { c.beginPath(); c.moveTo(X(lx), Z(1.0)); c.lineTo(X(lx), Z(7.0)); c.stroke(); }
      c.strokeStyle = 'rgba(230,170,30,0.9)'; c.strokeRect(X(0.4), Z(2.5), X(9.0) - X(0.4), Z(5.9) - Z(2.5));
      c.fillStyle = 'rgba(230,170,30,0.9)'; c.font = 'italic 700 46px Arial'; c.textAlign = 'center'; c.fillText('TOW', X(4.6), Z(6.4));
    });
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(30, 16, 30, 16), new THREE.MeshStandardMaterial({ map: yardT, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    yard.rotation.x = -Math.PI / 2; yard.position.set(0, 0.03, 5); yard.receiveShadow = true;
    // (follow the ground: each vertex at the terrain's height)
    const pa = yard.geometry.attributes.position;
    yard.updateMatrixWorld(true); g.updateMatrixWorld(true);
    for (let i = 0; i < pa.count; i++) { const lx = pa.getX(i), lz = 5 - pa.getY(i), p = this.w(lx, lz); pa.setZ(i, world.height(p.x, p.z) - L.y + 0.03); }
    pa.needsUpdate = true; yard.geometry.computeVertexNormals();
    yard.position.y = 0;
    g.add(yard);
    this.scene.add(g);
    this.group = g;
    // solid: the building (a box a little inside the walls), a camera blocker the same size
    const c = this.w(0, BZ + 0.25);
    this.colliders.push({ x: c.x, z: c.z, hw: BW / 2, hd: BD / 2 + 0.25, rot: -this.yaw0 });
    const blk = new THREE.Mesh(new THREE.BoxGeometry(BW, WALL + 2, BD), new THREE.MeshBasicMaterial());
    blk.position.set(0, (WALL + 2) / 2, BZ); blk.visible = false; g.add(blk); g.updateMatrixWorld(true);
    this.cameraBlockers?.push(blk);
    this.door = this.w(0, front + 1.2);
    this.carSpot = { ...this.w(-5.2, 4.1), yaw: this.yaw0 }; // (nose to the road)
  }

  // ------------------------------------------------------------------ rental cars (parking entries drive.js can drive)
  // cfg: carconfig.js normConfig() (the car, its paint, interior, rims, plate): the car in the yard is exactly that one,
  // and so is every look of it drive.js makes (e.dress: driving, the full-detail cockpit)
  spawn(cfg) {
    const id = cfg.id, spec = RENTALS.find((c) => c.id === id), gltf = this.models[id];
    if (!spec || !gltf || !this.parking) return null;
    const t = carTemplate(gltf, spec.length, id), inst = dressCar(carInstance(t, { wheels: true }), t, cfg), car = inst.group, p = this.carSpot;
    car.name = 'rental-car';
    car.position.set(p.x, world.height(p.x, p.z) + 0.03, p.z); car.rotation.y = p.yaw;
    (this.parking.group.parent ? this.parking.group : this.scene).add(car);
    const collider = { x: p.x, z: p.z, hw: 0.97, hd: spec.length / 2, rot: -p.yaw, h: 1.7, car: true };
    this.colliders.push(collider);
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, spec.length - 0.1), new THREE.MeshBasicMaterial());
    block.position.y = 0.8; block.visible = false; car.add(block); car.updateMatrixWorld(true);
    this.cameraBlockers?.push(block);
    const e = { car, inst, t, far: null, full: car.children[0], name: id, length: spec.length, paint: paintHex(cfg.paint), paintId: cfg.paint, cfg, collider, block, held: [], rental: true, home: { x: p.x, z: p.z, yaw: p.yaw } };
    e.dress = (i, tt) => dressCar(i, tt, e.cfg);
    (this.parking.cars ||= []).push(e);
    if (this.drive) this.drive._cc = null; // (drive.js re-collects the cars' colliders)
    return e;
  }
  // a car gone from the world (returned, or the wreck off the truck)
  remove(e) {
    if (!e) return;
    const P = this.parking, i = P?.cars?.indexOf(e);
    if (i >= 0) P.cars.splice(i, 1);
    e.car.removeFromParent();
    const ci = this.colliders.indexOf(e.collider); if (ci >= 0) this.colliders.splice(ci, 1);
    const bi = this.cameraBlockers?.indexOf(e.block); if (bi >= 0) this.cameraBlockers.splice(bi, 1);
    const wi = this.drive?.wrecks?.indexOf(e); if (wi >= 0) this.drive.wrecks.splice(wi, 1);
    e.smokeFx?.clear?.();
    e.wrecked = null;
    if (this.drive) this.drive._cc = null;
  }

  /** The price of a config: the car's rate and the extras (finish, trim, rims, your own plate). */
  cost(cfg) { const spec = RENTALS.find((c) => c.id === cfg.id) || RENTALS[0], extras = extrasCost(cfg); return { base: spec.price, extras, total: spec.price + extras }; }
  rent(cfg) {
    cfg = normConfig(cfg);
    const spec = RENTALS.find((c) => c.id === cfg.id);
    if (!spec || !this.spend(this.cost(cfg).total)) return;
    if (this.current && !this.current.driving) { this.remove(this.current); this.current = null; } // (one at a time: the old one is returned)
    this.current = this.spawn(cfg);
    this.save.rental = cfg;
    this.writeSave();
    this.hud?.flash(`${spec.label} rented · it waits in the yard out front`, 'gold', 3200);
  }

  // drive.js: a car was wrecked (yours: the fee, once, and the rental ends); the truck fetches it
  wrecked(e) {
    if (e.rental) {
      e.rental = false;
      if (this.current === e) this.current = null;
      this.save.rental = null;
      this.save.money -= WRECK_FEE;
      this.writeSave();
      this.hud?.setMoney?.(this.save.money, -WRECK_FEE);
      this.audio?.play?.('cash');
      setTimeout(() => this.hud?.flash(`Rental car wrecked · -$${WRECK_FEE.toLocaleString('en-US')} · the tow truck is on its way`, 'bad', 3600), 2900); // (after drive.js's own "Wrecked" line)
    }
    if (this.truck) this.truck.fetch(e, (car) => this.remove(car));
  }

  // ------------------------------------------------------------------ outside: the door
  interaction(p) {
    if (!this.L || this.inside || !this.room) return null;
    if (Math.hypot(p.x - this.door.x, p.z - this.door.z) < 2.6) return this._prompt ||= { label: 'Car Rental', act: () => this.enter() };
    return null;
  }

  enter() {
    if (this.inside || this.transition.active) return;
    this.player.frozen = true;
    this.audio?.play?.('click');
    this.transition.fade(() => {
      this.inside = true;
      this.room.enter();
      this.getPost().setView(this.room.scene, this.room.camera);
      document.getElementById('crosshair').hidden = false;
    });
  }
  leave(now = false) {
    if (!this.inside) return;
    const out = () => {
      if (this.ui.isOpen) this.ui.close('leave');
      this.room.endConfigure();
      this.inside = false; this.room.active = false;
      this.getPost().setView(this.scene, this.camera);
      document.getElementById('crosshair').hidden = true;
      this.player.frozen = false;
      if (now) return;
      const f = { x: this.L.dirx, z: this.L.dirz };
      this.player.teleport(this.door.x + f.x * 0.8, this.door.z + f.z * 0.8, Math.atan2(f.x, f.z));
      this.player.camYaw = Math.atan2(f.x, f.z) + Math.PI + 0.4;
      this.player.camPitch = -0.12;
      if (this.current) setTimeout(() => this.hud?.flash('Your rental car waits in the yard · E to drive', 'good', 2800), 400);
    };
    if (now) out(); else { this.audio?.play?.('click'); this.transition.fade(out); }
  }

  // the configurator: from the car you looked at (its display paint), or your current rental's config (the clerk)
  openCard(pick, paintHexWant) {
    const cur = this.save.rental ? normConfig(this.save.rental) : null;
    const base = cur && (!pick || pick === cur.id) ? cur : normConfig({ id: pick || RENTALS[0].id, paint: PAINTS.find((p) => p.hex === paintHexWant)?.id || 'white', plate: randomPlate() });
    this.ui.open({ cars: RENTALS, cfg: base, current: cur, money: this.save.money, cost: (c) => this.cost(c),
      preview: (c, step) => this.room.configure(c, step), drag: (dx, dy) => this.room.orbit(dx, dy),
      rent: (c) => { this.rent(c); this.input?.lock?.(); }, close: () => { this.room.endConfigure(); this.input?.lock?.(); } });
  }

  /** Inside, per frame (main.js): walking, looking, E. Returns what to show as the prompt. */
  frame(dt, input, sensitivity) {
    const open = this.ui.isOpen;
    this.target = this.room.update(dt, open ? null : input, sensitivity, open);
    if (!open && this.target && input?.hit?.('KeyE')) {
      this.audio?.play?.('click');
      const t = this.target;
      if (t.kind === 'door') this.leave();
      else if (t.kind === 'clerk') { this.hud?.flash('Grüezi! Which car would you like today?', 'good', 2200); this.openCard(null, null); }
      else this.openCard(t.id, t.paint);
    }
    return this.target;
  }

  /** Per frame, outside too: the tow truck, the sign and lamps at night. */
  update(dt) {
    if (!this.L) return;
    this.truck?.update(dt);
    const n = nightUniform?.value ?? 0;
    if (this.signMat) this.signMat.emissiveIntensity = 0.15 + 1.1 * n;
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.2 + 2.4 * n;
    if (this.glowMat) this.glowMat.emissiveIntensity = 0.25 + 0.9 * n;
  }
}
