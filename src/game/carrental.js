// CAR RENTAL: cars are no longer free to take. The rental hall stands on the road through Legacy Village (its site:
// game/bus/roads.js planRental: a flat lot right on the road's edge): an alpine car hall (carrentalshell.js: the one
// shell both outside and in: a wide larch gable to the road under a deep snowy roof, a full-height glass front with
// thin dark mullions between stone piers, the five display cars on their turntables behind it, warm light inside),
// the CAR RENTAL board on the gable (village sign style, lit at night), lanterns, flags, potted spruces, and a compact
// ploughed yard in front (kerbs, painted bays, the TOW bay) fading into the snow. No loading screen: the sliding doors
// open as you walk up and you walk straight in. The showroom is in the world, in the hall's own frame
// (carrentalroom.js: built the first time you come within ~60 m, shown only up close; further off, cheap self-lit
// stand-ins): walls and the glass front are colliders, the floor, the stair and the mezzanine walkable surfaces, the
// furniture colliders for the floor you are on. E by a car: the configurator for that car (ui/carrental.js; the game
// camera swings round it); E at the desk: the clerk sends you to a random one. The rented car waits in the yard, nose to the
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
import { PAINTS, normConfig, extrasCost, dressCar, paintOf, randomPlate, setPlates } from './carconfig.js';
import { LAYOUT, buildShell, setDoors, stairY } from './carrentalshell.js';
import { makeSign } from '../world/village.js';
import { fitModel } from '../core/assets.js';

export const RENTALS = [
  { id: 'car_vw_golf_gti', label: 'VW Golf GTI', kind: 'Hot hatch', price: 150, length: 4.3 },
  { id: 'car_dacia_duster', label: 'Dacia Duster', kind: 'Compact SUV', price: 150, length: 4.34 },
  { id: 'car_tesla_m3', label: 'Tesla Model 3', kind: 'Electric saloon', price: 250, length: 4.7 },
  { id: 'car_bmw_x3', label: 'BMW X3', kind: 'Premium SUV', price: 300, length: 4.7 },
  { id: 'car_audi_rs6', label: 'Audi RS6 Avant', kind: 'Performance estate', price: 450, length: 5.0 },
  // upstairs, the supercar floor (UPPER: on the mezzanine, rented the same way: walk up, E at it, or pick it here)
  { id: 'car_porsche_taycan', label: 'Porsche Taycan Turbo S', kind: 'Electric super saloon', price: 800, length: 4.96 },
  { id: 'car_mercedes_sls', label: 'Mercedes SLS AMG', kind: 'Gull-wing supercar', price: 900, length: 4.64 },
];
export { PAINTS }; // (the configurator's: carconfig.js)
// the five cars on display downstairs (one of each, each its own colour; LAYOUT.spots: where)
const DISPLAY = [['car_audi_rs6', 'graphite'], ['car_tesla_m3', 'white'], ['car_bmw_x3', 'blue'], ['car_vw_golf_gti', 'red'], ['car_dacia_duster', 'orange']];
// upstairs on the mezzanine, the supercars (LAYOUT.upSpots; for rent like the rest, at their own rates)
const UPPER = [['car_mercedes_sls', 'silver'], ['car_porsche_taycan', 'red']];
export const WRECK_FEE = 1000;
// the lot (frame: +z to the road, its edge at z 13; +x along it): the hall's middle (z), the yard's half width and
// its road end, the rental bays (lines at x, from / to z), your car's spot, the TOW bay (middle, half length / width)
const YARD = { hall: -7.6, hw: 14.6, z1: 13.2, bayLines: [-12.4, -9.4, -6.4, -3.4], bayZ: [2.6, 8.4], carX: -7.9, carZ: 5.6,
  tow: { x: 7.6, z: 6.6, hl: 4.6, hw: 1.9 } };
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
    this.room = null; // the showroom inside (carrentalroom.js): built the first time you come near (showroom())
    this.buildOutside();
    // the tow truck: in its TOW bay along the road, nose to the yard's right end; out: on round to the right onto the
    // road; back: in from the road at the left of the bay, round into it (so it ends nose first, square in the bay)
    const P = YARD.tow, park = this.w(P.x, P.z);
    try {
      this.truck = new TowTruck({ scene: o.scene, models: o.models, colliders: o.colliders, camera: o.camera, traffic: o.traffic, audio: o.audio,
        park: { ...park, yaw: this.yaw0 + Math.PI / 2 },
        yardOut: [park, this.w(12.6, 8.4), this.w(14.2, 11.6), this.w(14.6, 15.8)],
        yardIn: [this.w(-1.2, 15.8), this.w(0.6, 11.2), this.w(3.4, P.z + 0.3)] });
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
    const L = this.L, g = new THREE.Group(), { W, D, H, T } = LAYOUT, BZ = YARD.hall;
    g.name = 'car-rental';
    g.position.set(L.x, L.y, L.z); g.rotation.y = this.yaw0;
    const canvas = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
    const mk = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; parent.add(m); return m; };
    // the hall (building frame: the room's), its glass clear enough to show the lit showroom (a light sheen only)
    const hall = this.hall = new THREE.Group(); hall.position.set(0, 0, BZ); g.add(hall);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xd4e4ee, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.12, envMapIntensity: 0.5, depthWrite: false, side: THREE.DoubleSide });
    const sh = buildShell(hall, 'out', glass);
    this.stripMat = sh.strips; this.doors = sh.doors; this.litMats = sh.lit; this.doorT = 0;
    // inside, seen through the glass from afar (the stand-ins: the showroom replaces them up close): the pale polished
    // floor (self-lit: the hall's lights), the backlit sign over the mezzanine, the cars on their turntables, two upstairs
    const far = this.far = new THREE.Group(); hall.add(far);
    const inFloor = mk(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x8c8782, emissive: 0x4a4540, roughness: 0.25, metalness: 0.1 }), 0, 0.02, 0, far);
    inFloor.rotation.x = -Math.PI / 2; inFloor.receiveShadow = inFloor.castShadow = false;
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, emissive: 0xffcf98, emissiveIntensity: 0.6, roughness: 0.9 });
    mk(new THREE.PlaneGeometry(9, 1.8), this.glowMat, -4.4, 6.1, -D / 2 + 0.05, far).receiveShadow = false; // (the backlit CAR RENTAL sign inside)
    const ttTop = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.55, metalness: 0.2 }), ttRim = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const showCar = (id, paint, x, y, z, yaw) => {
      const spec = RENTALS.find((c) => c.id === id), gl = this.models[id];
      if (!gl || !spec) return;
      const t = carTemplate(gl, spec.length, id), inst = setPlates(carInstance(t, { paint: paintHex(paint) }), t);
      inst.group.position.set(x, y, z); inst.group.rotation.y = yaw;
      inst.group.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = false; } });
      far.add(inst.group);
    };
    DISPLAY.forEach(([id, paint], k) => {
      const at = LAYOUT.spots[k];
      if (!at) return;
      mk(new THREE.CylinderGeometry(LAYOUT.R, LAYOUT.R, 0.16, 48), ttTop, at[0], 0.08, at[1], far).receiveShadow = false;
      mk(new THREE.TorusGeometry(LAYOUT.R, 0.06, 8, 64), ttRim, at[0], 0.13, at[1], far).rotation.x = Math.PI / 2;
      showCar(id, paint, at[0], 0.16, at[1], at[2]);
    });
    UPPER.forEach(([id, paint], k) => { const at = LAYOUT.upSpots[k]; if (at) showCar(id, paint, at[0], LAYOUT.FL, at[1], at[2]); });
    // the CAR RENTAL board on the gable (the village's sign style: a lettered board with a wooden back), lit at night
    const sign = makeSign('CAR RENTAL\nLEGACY VILLAGE', { w: 8.4, h: 2.0, font: 'bold 104px Georgia' });
    sign.position.set(0, H + 1.55, D / 2 + 0.1); hall.add(sign);
    this.signMat = sign.userData.faceMaterial;
    // lanterns on the stone piers (either side of the glass), each a dark steel box with a warm glass
    const steel = new THREE.MeshStandardMaterial({ color: 0x1f2124, roughness: 0.4, metalness: 0.7 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffc77a, emissiveIntensity: 0.2 });
    for (const sx of [-1, 1]) {
      const x = sx * (W / 2 - LAYOUT.PIER / 2 + T / 2), zf = D / 2 + 0.05 + (T + 0.5) / 2; // (the pier's front face)
      mk(new THREE.BoxGeometry(0.1, 0.24, 0.16), steel, x, 2.75, zf + 0.08, hall);
      mk(new THREE.BoxGeometry(0.26, 0.42, 0.26), steel, x, 2.6, zf + 0.29, hall);
      mk(new THREE.BoxGeometry(0.2, 0.32, 0.2), this.lampMat, x, 2.6, zf + 0.29, hall).castShadow = false;
    }
    // the yard: a compact ploughed apron of packed snow over asphalt from the glass to the road, fading into the
    // snow at its sides, painted bays (three for rentals, the TOW bay), kerbs along its sides
    const X0 = -YARD.hw, X1 = YARD.hw, Z0 = BZ + D / 2 + T, Z1 = YARD.z1, YW = X1 - X0, YD = Z1 - Z0;
    const yardT = canvas(1024, 512, (c, w, h) => {
      let s = 3; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const X = (lx) => ((lx - X0) / YW) * w, Z = (lz) => ((lz - Z0) / YD) * h;
      c.fillStyle = '#7b7975'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const v = 100 + r() * 40; c.fillStyle = `rgba(${v + 6},${v + 3},${v},0.4)`; c.fillRect(r() * w, r() * h, 2, 2); }
      for (let i = 0; i < 60; i++) { const x = r() * w, y = r() * h, R = 20 + r() * 80, gr = c.createRadialGradient(x, y, 0, x, y, R); gr.addColorStop(0, 'rgba(236,238,240,0.4)'); gr.addColorStop(1, 'rgba(236,238,240,0)'); c.fillStyle = gr; c.fillRect(x - R, y - R, 2 * R, 2 * R); }
      c.strokeStyle = 'rgba(246,246,240,0.92)'; c.lineWidth = 5;
      for (const lx of YARD.bayLines) { c.beginPath(); c.moveTo(X(lx), Z(YARD.bayZ[0])); c.lineTo(X(lx), Z(YARD.bayZ[1])); c.stroke(); }
      c.beginPath(); c.moveTo(X(YARD.bayLines[0]), Z(YARD.bayZ[0])); c.lineTo(X(YARD.bayLines.at(-1)), Z(YARD.bayZ[0])); c.stroke();
      const t = YARD.tow; c.strokeStyle = 'rgba(232,172,30,0.95)'; c.lineWidth = 6;
      c.strokeRect(X(t.x - t.hl), Z(t.z - t.hw), X(t.x + t.hl) - X(t.x - t.hl), Z(t.z + t.hw) - Z(t.z - t.hw));
      c.fillStyle = 'rgba(232,172,30,0.95)'; c.font = 'italic 700 44px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.save(); c.translate(X(t.x + t.hl) - 40, Z(t.z)); c.rotate(-Math.PI / 2); c.fillText('TOW', 0, 0); c.restore();
      // (the sides fade into the snow: alpha)
      c.globalCompositeOperation = 'destination-in';
      const fx = c.createLinearGradient(0, 0, w, 0); fx.addColorStop(0, 'rgba(0,0,0,0)'); fx.addColorStop(0.035, '#000'); fx.addColorStop(0.965, '#000'); fx.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = fx; c.fillRect(0, 0, w, h);
    });
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(YW, YD, 28, 14), new THREE.MeshStandardMaterial({ map: yardT, roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    yard.receiveShadow = true;
    // (each vertex on the ground: the plane laid flat in the lot frame, then at the terrain's height)
    const pa = yard.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) { const lx = (X0 + X1) / 2 + pa.getX(i), lz = (Z0 + Z1) / 2 - pa.getY(i), p = this.w(lx, lz); pa.setXYZ(i, lx, world.height(p.x, p.z) - L.y + 0.04, lz); }
    pa.needsUpdate = true; yard.geometry.computeVertexNormals();
    yard.renderOrder = 1;
    g.add(yard);
    // kerbs along the yard's sides (granite, low), on the ground
    const kerb = new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.85 });
    for (const sx of [-1, 1]) for (let z = Z0 + 0.6; z < Z1 - 1.5; z += 2) { const p = this.w(sx * (YARD.hw - 0.5), z + 1); mk(new THREE.BoxGeometry(0.22, 0.16, 1.96), kerb, sx * (YARD.hw - 0.5), world.height(p.x, p.z) - L.y + 0.06, z + 1); }
    // flags at the yard's front corners (blue banners on steel poles), potted spruces either side of the door
    const banner = canvas(128, 512, (c, w, h) => { c.fillStyle = '#16346e'; c.fillRect(0, 0, w, h); c.fillStyle = '#f2c88c'; c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
      c.save(); c.translate(w / 2, h / 2); c.rotate(-Math.PI / 2); c.fillStyle = '#fff'; c.font = 'italic 700 64px "Barlow Condensed", "Arial Narrow", Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('CAR RENTAL', 0, 4); c.restore(); });
    const bannerMat = new THREE.MeshStandardMaterial({ map: banner, roughness: 0.8, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) {
      const lx = sx * (YARD.hw - 0.6), lz = Z1 - 1.0, p = this.w(lx, lz), y = world.height(p.x, p.z) - L.y;
      mk(new THREE.CylinderGeometry(0.05, 0.06, 7, 10), steel, lx, y + 3.5 - 0.3, lz);
      mk(new THREE.BoxGeometry(1.0, 0.04, 0.04), steel, lx - sx * 0.48, y + 6.4, lz);
      mk(new THREE.PlaneGeometry(0.9, 3.4), bannerMat, lx - sx * 0.48, y + 4.68, lz).castShadow = false;
      this.colliders.push({ x: p.x, z: p.z, r: 0.15 });
    }
    const potMat = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.7 });
    for (const dx of [-2.4, 2.4]) { // (clear of the sliding doors' bay)
      const lx = LAYOUT.door.x + dx, lz = BZ + D / 2 + 0.9;
      mk(new THREE.CylinderGeometry(0.42, 0.34, 0.7, 20), potMat, lx, 0.35, lz);
      if (this.models.pine_tree) { const t = fitModel(this.models.pine_tree, { size: 2.3, axis: 'y' }); t.position.set(lx, 0.62, lz); t.traverse((m) => { if (m.isMesh) m.castShadow = true; }); g.add(t); }
      const p = this.w(lx, lz); this.colliders.push({ x: p.x, z: p.z, r: 0.45 });
    }
    this.scene.add(g);
    this.group = g;
    g.updateMatrixWorld(true);
    this.hallC = this.w(0, BZ);
    this.buildHallPhysics();
    this.door = this.w(LAYOUT.door.x, BZ + D / 2 + 1.3);
    this.carSpot = { ...this.w(YARD.carX, YARD.carZ), yaw: this.yaw0 }; // (in the middle bay, nose to the road)
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

  // ------------------------------------------------------------------ the hall in the world: walls, floors, the stair
  /** World x, z -> the hall's frame (origin on its floor in the middle, +z out of the glass). */
  toHall(x, z, out = {}) {
    const L = this.L, dx = x - L.x, dz = z - L.z;
    out.x = L.dirz * dx - L.dirx * dz; out.z = L.dirx * dx + L.dirz * dz - YARD.hall;
    return out;
  }
  /** The hall's frame -> world { x, z }. */
  fromHall(hx, hz) { return this.w(hx, hz + YARD.hall); }
  // Its walls and glass front (the door's bay open: the sliding pair opens as you come), the stair's open side as
  // colliders; the floor, the stair and the mezzanine as walkable surfaces (world.groundHeight: the mezzanine is only
  // taken from the stair's top, never from the floor under it); invisible boxes the 3rd-person camera stops at
  // (on only while you are inside).
  buildHallPhysics() {
    const { W, D, T, PIER, FL, MZ, H } = LAYOUT, S = LAYOUT.stair, Y = this.L.y, rot = -this.yaw0;
    const box = (hx, hz, hw, hd) => { const p = this.fromHall(hx, hz); return { x: p.x, z: p.z, hw, hd, rot }; };
    const gx0 = -W / 2 + PIER, gx1 = W / 2 - PIER, dl = LAYOUT.door.x - LAYOUT.bayW / 2, dr = LAYOUT.door.x + LAYOUT.bayW / 2;
    this.walls = [
      box(-(W / 2 + T / 2), 0, T / 2, D / 2 + T), box(W / 2 + T / 2, 0, T / 2, D / 2 + T), box(0, -D / 2 - T / 2, W / 2 + T, T / 2),
      ...[-1, 1].map((sx) => box(sx * (W / 2 - PIER / 2 + T / 2), D / 2 + 0.05, (PIER + T) / 2, (T + 0.5) / 2)),
      box((gx0 + dl) / 2, D / 2, (dl - gx0) / 2, 0.12), box((dr + gx1) / 2, D / 2, (gx1 - dr) / 2, 0.12),
      box(S.x1 + 0.03, (S.z0 + S.z1 - 0.9) / 2, 0.06, (S.z1 - 0.9 - S.z0) / 2), // (the stair's glass side: only its foot is open)
    ];
    this.colliders.push(...this.walls);
    // (upstairs only: the mezzanine's balustrade)
    this.upWalls = [box((S.x1 + W / 2) / 2, MZ - 0.06, (W / 2 - S.x1) / 2, 0.08)];
    const cs = [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]].map(([a, b]) => this.fromHall(a, b));
    const bounds = { minx: Math.min(...cs.map((c) => c.x)) - 1, maxx: Math.max(...cs.map((c) => c.x)) + 1, minz: Math.min(...cs.map((c) => c.z)) - 1, maxz: Math.max(...cs.map((c) => c.z)) + 1 };
    const h = {}, inside = (x, z) => { this.toHall(x, z, h); return Math.abs(h.x) <= W / 2 && Math.abs(h.z) <= D / 2; };
    this.surfaces = [
      world.addSurface({ bounds, height: (x, z) => (inside(x, z) ? Y + 0.03 : null) }),
      world.addSurface({ bounds, height: (x, z) => (inside(x, z) && h.x >= S.x0 && h.x <= S.x1 + 0.02 && h.z >= S.z0 - 0.05 && h.z <= S.z1 ? Y + 0.03 + stairY(h.z) : null) }),
      world.addSurface({ bounds, height: (x, z) => (inside(x, z) && h.z < MZ ? Y + FL : null) }),
    ];
    // the camera's stops: the side and back walls and the ceiling (tie beams' height)
    const inv = new THREE.MeshBasicMaterial();
    const blk = (w, hh, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), inv); m.position.set(x, y, z); m.visible = false; this.hall.add(m); return m; };
    this.blockers = [blk(T, H, D, -W / 2 - T / 2, H / 2, 0), blk(T, H, D, W / 2 + T / 2, H / 2, 0), blk(W, H, T, 0, H / 2, -D / 2 - T / 2), blk(W, 0.2, D, 0, H - 0.3, 0)];
    this.hall.updateMatrixWorld(true);
    this.blockersOn = false;
    this.level = null; // the room's obstacles in the world: 'down' (the ground floor's), 'up' (the mezzanine's)
  }
  // the furniture of the floor you are on as colliders (the ground floor's turntables, desk, sofa; upstairs the cars,
  // the office, the balustrade)
  setLevel(level) {
    if (level === this.level) return;
    const drop = (arr) => { for (const c of arr || []) { const i = this.colliders.indexOf(c); if (i >= 0) this.colliders.splice(i, 1); } };
    drop(this.downCols); drop(this.upCols);
    this.level = level;
    if (level === 'down') this.colliders.push(...this.downCols);
    else if (level === 'up') this.colliders.push(...this.upCols);
    if (this.drive) this.drive._cc = null;
  }
  // the showroom (carrentalroom.js), the first time you come near
  showroom() {
    const hex = (list) => list.map(([id, paint]) => ({ id, paint: paintHex(paint) }));
    this.room = new CarRentalRoom({ frame: this.hall, models: this.models, makeRig: this.makeRig, cars: RENTALS, display: hex(DISPLAY), upper: hex(UPPER) });
    const circ = (o) => { const p = this.fromHall(o.x, o.z); return { x: p.x, z: p.z, r: o.r }; };
    this.downCols = this.room.obstacles.map(circ);
    this.upCols = [...this.room.obstaclesUp.map(circ), ...this.upWalls];
  }

  // ------------------------------------------------------------------ inside: what E does (main.js findInteraction)
  interaction(p) {
    if (!this.L || !this.room || !this.inside || this.ui.isOpen) return null;
    const t = this.room.pick(this.toHall(p.x, p.z, this._ph ||= {}), this.level === 'up');
    if (!t) return null;
    const key = t.kind + ':' + (t.id || '');
    this._prompts ||= {};
    return this._prompts[key] ||= { label: t.label, act: () => (t.kind === 'clerk' ? this.recommend() : this.openCard(t.id, t.paint)) };
  }
  /** Close the configurator (main.js: back to the menu, the bus home). */
  leave() {
    if (this.ui.isOpen) this.ui.close('leave');
    this.room?.endConfigure(this.camera);
    this.player.frozen = false;
  }

  // the configurator, for the car you pressed E at (its display paint to start; your current rental's config when it's
  // that model). The model itself is fixed in there: paint, wheels, plate only.
  openCard(pick, paintHexWant) {
    if (!RENTALS.some((c) => c.id === pick)) return;
    this.room.guide(null); // (found it)
    this.player.frozen = true;
    const cur = this.save.rental ? normConfig(this.save.rental) : null;
    const base = cur && pick === cur.id ? cur : normConfig({ id: pick, paint: PAINTS.find((p) => p.hex === paintHexWant)?.id || 'white', plate: randomPlate() });
    this.ui.open({ cars: RENTALS, cfg: base, current: cur, money: this.save.money, cost: (c) => this.cost(c),
      preview: (c, step) => this.room.configure(c, step), drag: (dx, dy) => this.room.orbit(dx, dy),
      rent: (c) => { this.rent(c); }, close: () => { this.room.endConfigure(this.camera); this.player.frozen = false; this.input?.lock?.(); } });
  }

  // the clerk: a car of the day, picked at random from the floor (never the same twice in a row); a marker over it
  // shows you the way (carrentalroom.js guide) until you press E at it
  recommend() {
    const on = this.room.tables.map((t) => t.id).filter((id) => RENTALS.some((c) => c.id === id));
    if (!on.length) return;
    const pool = on.length > 1 ? on.filter((id) => id !== this.lastTip) : on, id = pool[Math.floor(Math.random() * pool.length)];
    this.lastTip = id;
    const spec = RENTALS.find((c) => c.id === id), up = this.room.tables.find((t) => t.id === id)?.up;
    const lines = [`Grüezi! Take a look at the ${spec.label}${up ? ' upstairs' : ''}!`, `Have you seen the ${spec.label}${up ? ' upstairs' : ''}? Lovely in the snow.`, `Today I'd go for the ${spec.label}${up ? ', up the stairs' : ''}. Have a look!`];
    this.hud?.flash(lines[Math.floor(Math.random() * lines.length)], 'good', 3600);
    this.room.guide(id);
  }

  /** Per frame, outside too: the tow truck, the sign and lamps at night. */
  update(dt) {
    if (!this.L) return;
    this.truck?.update(dt);
    const n = nightUniform?.value ?? 0;
    if (this.signMat) this.signMat.emissiveIntensity = 0.05 + 0.75 * n;
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.2 + 2.4 * n;
    if (this.glowMat) this.glowMat.emissiveIntensity = 0.3 + 0.9 * n;
    if (this.stripMat) this.stripMat.emissiveIntensity = 1.6 + 2.0 * n; // (the hall's light strips, seen through the glass)
    if (this.litMats) for (const m of this.litMats) m.emissiveIntensity = 0.45 + 0.35 * n;
    // the showroom: built the first time you come within ~70 m, shown within 60 m (further off: the stand-ins)
    const cam = this.camera.position, dc = Math.hypot(cam.x - this.hallC.x, cam.z - this.hallC.z);
    if (!this.room && dc < 70) { try { this.showroom(); } catch (e) { console.warn('car rental showroom', e); this.room = false; } }
    const show = !!this.room && dc < 60;
    if (this.room) this.room.visible = show;
    this.far.visible = !show;
    // you: in the hall (on foot), on which floor
    const p = this.player?.pos, driving = !!this.drive?.active, { W, D } = LAYOUT;
    const h = p ? this.toHall(p.x, p.z, this._h ||= {}) : null;
    this.inside = !!h && !driving && Math.abs(h.x) < W / 2 + 0.2 && Math.abs(h.z) < D / 2 + 0.2;
    if (this.room) this.setLevel(this.inside && p.y - this.L.y > 1.2 ? 'up' : 'down');
    if (this.inside !== this.blockersOn) {
      this.blockersOn = this.inside;
      for (const b of this.blockers) { const i = this.cameraBlockers?.indexOf(b) ?? -1; if (this.inside && i < 0) this.cameraBlockers?.push(b); else if (!this.inside && i >= 0) this.cameraBlockers.splice(i, 1); }
    }
    if (show) this.room.update(dt, this.inside ? { x: h.x, y: p.y - this.L.y, z: h.z } : null);
    // the configurator: the game camera round the car (after the player's camera)
    if (this.ui.isOpen && this.room?.cfg) this.room.cfgCamera(dt, this.camera);
    // the sliding doors: open as you walk up to them, from either side (not while driving)
    const dd = p && !driving ? Math.hypot(h.x - LAYOUT.door.x, h.z - D / 2) : Infinity;
    const was = this.doorT;
    this.doorT += ((dd < 4.2 ? 1 : 0) - this.doorT) * (1 - Math.exp(-dt * 5));
    if (Math.abs(this.doorT - was) > 1e-4) setDoors(this.doors, this.doorT * this.doorT * (3 - 2 * this.doorT));
  }
}
