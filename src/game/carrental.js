// CAR RENTAL: cars are no longer free to take. The rental hall stands on the road through Legacy Village (its site:
// game/bus/roads.js planRental: a flat lot right on the road's edge): an alpine car hall (carrentalshell.js: the one
// shell both outside and in: a wide larch gable to the road under a deep snowy roof, a full-height glass front with
// thin dark mullions between stone piers, the five display cars on their turntables behind it, warm light inside),
// the CAR RENTAL board on the gable (village sign style, lit at night), lanterns, flags, potted spruces, and a compact
// ploughed yard in front (kerbs, painted bays, the TOW bay) fading into the snow. E at the door: inside
// (carrentalroom.js, its own scene: two storeys; through its glass the real world, rendered live as in the ski shop);
// at a car on display: the configurator for that car (ui/carrental.js); the clerk sends you to a random one. The rented car waits in the yard, nose to the
// road; E beside it to drive (drive.js: every other car only says where to rent one). One rental at a time (renting
// another returns the old one); it is kept in the save (back in the yard next time). Wreck it: WRECK_FEE (once; the
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
import { LAYOUT, buildShell } from './carrentalshell.js';
import { makeSign } from '../world/village.js';
import { fitModel } from '../core/assets.js';
import { Impound, untilTomorrow } from './impound.js'; // the big car park beside the hall: your car's bay, the impound, towing cars left on a road
import { OwnerTags } from './ownertags.js'; // your name over your car, chalet, rented helicopter (and their map markers)

export const RENTALS = [
  { id: 'car_vw_golf_gti', label: 'VW Golf GTI', kind: 'Hot hatch', price: 1200, length: 4.3 },
  { id: 'car_tesla_m3', label: 'Tesla Model 3', kind: 'Electric saloon', price: 2000, length: 4.7 },
  { id: 'car_bmw_x3', label: 'BMW X3', kind: 'Premium SUV', price: 2500, length: 4.7 },
  { id: 'car_toyota_gr_yaris', label: 'Toyota GR Yaris', kind: 'Rally hot hatch', price: 3000, length: 3.99 },
  { id: 'car_audi_rs6', label: 'Audi RS6 Avant', kind: 'Performance estate', price: 4000, length: 5.0 },
  { id: 'car_mercedes_gls', label: 'Mercedes-Benz GLS', kind: 'Luxury SUV · 7 seats', price: 5000, length: 5.2 },
  { id: 'car_audi_etron_gt', label: 'Audi e-tron GT', kind: 'Electric grand tourer', price: 7000, length: 4.96 },
  // upstairs, the supercar floor (UPPER: on the mezzanine, rented the same way: walk up, E at it, or pick it here)
  { id: 'car_porsche_taycan', label: 'Porsche Taycan Turbo S', kind: 'Electric super saloon', price: 8000, length: 4.96 },
  { id: 'car_mercedes_sls', label: 'Mercedes SLS AMG', kind: 'Gull-wing supercar', price: 10000, length: 4.64 },
  { id: 'car_lamborghini_huracan', label: 'Lamborghini Huracán EVO', kind: 'V10 supercar', price: 12000, length: 4.52 },
];
// (saves from before the Dacia left the fleet, Oct 29: its rental comes back as the Golf)
const RETIRED = { car_dacia_duster: 'car_vw_golf_gti' };
export { PAINTS }; // (the configurator's: carconfig.js)
// the seven cars on display downstairs (one of each, each its own colour; LAYOUT.spots: where, in this order)
const DISPLAY = [['car_audi_rs6', 'graphite'], ['car_mercedes_gls', 'black'], ['car_audi_etron_gt', 'kingfisher'], ['car_tesla_m3', 'white'],
  ['car_bmw_x3', 'blue'], ['car_vw_golf_gti', 'red'], ['car_toyota_gr_yaris', 'white']];
// upstairs on the mezzanine, the supercars (LAYOUT.upSpots; for rent like the rest, at their own rates)
const UPPER = [['car_mercedes_sls', 'silver'], ['car_porsche_taycan', 'red'], ['car_lamborghini_huracan', 'orange']];
export const WRECK_FEE = 1500; // (Oct 29 rebalance: was $1,000; a couple of jobs, the cars now rent for $1,000-10,000)
// the lot (frame: +z to the road, its edge at z 13; +x along it): the hall's middle (z), the yard's half width and
// its road end, the rental bays (lines at x, from / to z), your car's spot, the TOW bay (middle, half length / width)
// (Oct 29: the bigger hall, 32 x 17.5 m: its glass front 0.6 m further from the road than before (the yard 12.3 m
// deep, the bays and the TOW bay as they were), its back 16.7 m in, its sides 16.3 m out: inside the cleared site)
const YARD = { hall: -7.9, hw: 16.0, z1: 13.2, bayLines: [-12.4, -9.4, -6.4, -3.4], bayZ: [2.6, 8.4], carX: -7.9, carZ: 5.6,
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
    this.towed = null;   // multiplayer: your wreck while the truck fetches it (the others still see it)
    this.ui = new CarRentalUI({ hud: o.hud, audio: o.audio });
    if (!this.L) return;
    const L = this.L;
    this.yaw0 = Math.atan2(L.dirx, L.dirz); // the lot's frame: local +z toward the road, +x along it
    this.buildOutside();
    this.room = new CarRentalRoom({ renderer: o.renderer, models: o.models, makeRig: o.makeRig, cars: RENTALS, display: DISPLAY.map(([id, paint]) => ({ id, paint: paintHex(paint) })), upper: UPPER.map(([id, paint]) => ({ id, paint: paintHex(paint) })) });
    // the showroom's windows look out on the real world from where the hall stands (its own outside hidden for that view)
    this.room.setWorld({ scene: o.scene, frame: this.hall, hide: () => [this.hall, this.player?.rig?.root, this.player?.rig?.gear] });
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
      o.drive.locked = (e) => (e.rental || e.free ? null : 'Rent a car at Car Rental in Legacy Village');
      o.drive.onWreck = (e) => this.wrecked(e);
    }
    try { this.impound = new Impound(this, { fee: WRECK_FEE }); } catch (e) { console.warn('rental car park', e); this.impound = null; }
    try { this.ownerTags = new OwnerTags({ scene: o.scene, camera: o.camera, rental: this }); } catch (e) { console.warn('owner tags', e); this.ownerTags = null; }
    // the save: your rental back in the yard
    const s = o.save.rental;
    if (s && RETIRED[s.id]) s.id = RETIRED[s.id];
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
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xd4e4ee, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.14, envMapIntensity: 0.5, depthWrite: false });
    const sh = buildShell(hall, 'out', glass);
    this.stripMat = sh.strips; this.litMats = sh.lit; // (the sliding doors stay shut: E at them goes in, through a fade)
    // inside, seen through the glass: the pale polished floor (self-lit: the hall's lights), the backlit sign over the
    // mezzanine, the cars on their turntables (no roof shadow on them), two more upstairs
    const inFloor = mk(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x8c8782, emissive: 0x4a4540, roughness: 0.25, metalness: 0.1 }), 0, 0.02, 0, hall);
    inFloor.rotation.x = -Math.PI / 2; inFloor.receiveShadow = inFloor.castShadow = false;
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, emissive: 0xffcf98, emissiveIntensity: 0.6, roughness: 0.9 });
    mk(new THREE.PlaneGeometry(9, 1.8), this.glowMat, -4.4, 6.1, -D / 2 + 0.05, hall).receiveShadow = false; // (the backlit CAR RENTAL sign inside)
    const ttTop = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.55, metalness: 0.2 }), ttRim = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const showCar = (id, paint, x, y, z, yaw) => {
      const spec = RENTALS.find((c) => c.id === id), gl = this.models[id];
      if (!gl || !spec) return;
      const t = carTemplate(gl, spec.length, id), inst = setPlates(carInstance(t, { paint: paintHex(paint) }), t);
      inst.group.position.set(x, y, z); inst.group.rotation.y = yaw;
      inst.group.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = false; } });
      hall.add(inst.group);
    };
    DISPLAY.forEach(([id, paint], k) => {
      const at = LAYOUT.spots[k];
      if (!at) return;
      mk(new THREE.CylinderGeometry(LAYOUT.R, LAYOUT.R, 0.16, 48), ttTop, at[0], 0.08, at[1], hall).receiveShadow = false;
      mk(new THREE.TorusGeometry(LAYOUT.R, 0.06, 8, 64), ttRim, at[0], 0.13, at[1], hall).rotation.x = Math.PI / 2;
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
    // solid: the hall (its box), a camera blocker the same size
    const c = this.w(0, BZ);
    this.colliders.push({ x: c.x, z: c.z, hw: W / 2 + T, hd: D / 2 + T + 0.25, rot: -this.yaw0 });
    const blk = new THREE.Mesh(new THREE.BoxGeometry(W + 2 * T, H + LAYOUT.RISE, D + 2 * T), new THREE.MeshBasicMaterial());
    blk.position.set(0, (H + LAYOUT.RISE) / 2, BZ); blk.visible = false; g.add(blk); g.updateMatrixWorld(true);
    this.cameraBlockers?.push(blk);
    this.door = this.w(LAYOUT.door.x, BZ + D / 2 + 1.3);
    this.carSpot = { ...this.w(YARD.carX, YARD.carZ), yaw: this.yaw0 }; // (in the middle bay, nose to the road)
  }

  // ------------------------------------------------------------------ rental cars (parking entries drive.js can drive)
  // cfg: carconfig.js normConfig() (the car, its paint, interior, rims, plate): the car in the yard is exactly that one,
  // and so is every look of it drive.js makes (e.dress: driving, the full-detail cockpit)
  spawn(cfg, p = this.carSpot, free = false) {
    const id = cfg.id, spec = RENTALS.find((c) => c.id === id), gltf = this.models[id];
    if (!spec || !gltf || !this.parking || !p) return null;
    const t = carTemplate(gltf, spec.length, id), inst = dressCar(carInstance(t, { wheels: true }), t, cfg), car = inst.group;
    car.name = free ? 'admin-car' : 'rental-car';
    car.position.set(p.x, world.height(p.x, p.z) + 0.03, p.z); car.rotation.y = p.yaw;
    (this.parking.group.parent ? this.parking.group : this.scene).add(car);
    const collider = { x: p.x, z: p.z, hw: 0.97, hd: spec.length / 2, rot: -p.yaw, h: 1.7, car: true };
    this.colliders.push(collider);
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, spec.length - 0.1), new THREE.MeshBasicMaterial());
    block.position.y = 0.8; block.visible = false; car.add(block); car.updateMatrixWorld(true);
    this.cameraBlockers?.push(block);
    const e = { car, inst, t, far: null, full: car.children[0], name: id, length: spec.length, paint: paintHex(cfg.paint), paintId: cfg.paint, cfg, collider, block, held: [], rental: !free, free, home: { x: p.x, z: p.z, yaw: p.yaw } };
    e.dress = (i, tt) => dressCar(i, tt, e.cfg);
    (this.parking.cars ||= []).push(e);
    if (this.drive) this.drive._cc = null; // (drive.js re-collects the cars' colliders)
    if (!free) this.impound?.adopt(e); // (towed: in its impound bay, locked until tomorrow)
    return e;
  }
  // admin panel (ui/admin.js): a free car of a random model from the fleet, parked at { x, z, yaw }; yours to drive
  // like a rental, no fee (a wreck of it: just towed away). One at a time: the last one goes when a new one comes.
  spawnFree(spot) {
    const kinds = RENTALS.filter((c) => this.models[c.id]);
    if (!kinds.length || !spot) return null;
    const spec = kinds[Math.floor(Math.random() * kinds.length)];
    const paint = PAINTS[Math.floor(Math.random() * PAINTS.length)]?.id;
    if (this.freeCar && !this.freeCar.driving && !this.freeCar.wrecked) this.remove(this.freeCar);
    const e = this.spawn(normConfig({ id: spec.id, paint }), spot, true);
    if (!e) return null;
    this.freeCar = e;
    if (Number.isFinite(spot.y)) { e.car.position.y = spot.y + 0.03; e.car.updateMatrixWorld(true); } // (the ground you stand on: a road, a bridge)
    e.label = spec.label;
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
    if (this.mp) return this.mp.rent(cfg); // multiplayer: the server rents it (price, a unique plate: net/session.js)
    const spec = RENTALS.find((c) => c.id === cfg.id);
    if (!spec || !this.spend(this.cost(cfg).total)) return;
    if (this.current && !this.current.driving) { this.remove(this.current); this.current = null; } // (one at a time: the old one is returned)
    this.current = this.spawn(cfg);
    this.save.rental = cfg;
    this.writeSave();
    this.hud?.flash(`${spec.label} rented · it waits in the ${this.impound?.own ? 'car park beside the hall' : 'yard out front'}`, 'gold', 3200);
  }

  /** The rental in the yard rebuilt from save.rental (switching between the single-player and multiplayer saves). */
  resync() {
    if (this.current && !this.current.driving) { try { this.remove(this.current); } catch (e) { console.warn('rental car', e); } this.current = null; }
    const s = this.save.rental;
    if (s && RENTALS.some((c) => c.id === s.id)) { try { this.save.rental = normConfig(s); this.current = this.spawn(this.save.rental); } catch (e) { console.warn('rental car', e); } }
  }
  /** Multiplayer: the server rented `cfg` (its plate checked): put it in the yard. */
  placeRented(cfg) {
    const spec = RENTALS.find((c) => c.id === cfg.id);
    if (this.current && !this.current.driving) { this.remove(this.current); this.current = null; }
    this.save.rental = normConfig(cfg);
    this.current = this.spawn(this.save.rental);
    this.writeSave();
    this.hud?.flash(`${spec?.label || 'Car'} rented · ${this.save.rental.plate} · it waits in the ${this.impound?.own ? 'car park beside the hall' : 'yard out front'}`, 'gold', 3200);
  }

  // drive.js: a car was wrecked (yours: the fee, once, and the rental ends); the truck fetches it
  // Your car isn't lost (Oct 29, the user: "once your car gets towed away it's repaired again, so it spawns at the
  // parking lot so you don't lose your car"): the fee, then once the truck has it back, it is repaired and waits in
  // its bay in the car park beside the hall (the same car: model, paint, plate)
  wrecked(e) {
    const mine = e.rental && this.save.rental ? this.save.rental : null;
    const mp = mine ? this.mp : null;
    if (mine) {
      e.rental = false;
      if (this.current === e) this.current = null;
      if (mp?.tow) { // multiplayer: the server charges the fee and records the tow (it ends in your bay: net/session.js)
        this.towed = e; // (still shown to the others: lying there, then on the truck: net/carride.js)
        const p = this.carSpot;
        mp.tow('wreck', p ? [p.x, world.height(p.x, p.z) + 0.03, p.z, p.yaw] : [e.car.position.x, e.car.position.y, e.car.position.z, 0]);
      } else {
        this.save.money -= WRECK_FEE;
        this.writeSave();
        this.hud?.setMoney?.(this.save.money, -WRECK_FEE);
      }
      this.audio?.play?.('cash');
      setTimeout(() => this.hud?.flash(`Car wrecked · -$${WRECK_FEE.toLocaleString('en-US')} · the tow truck takes it to the car rental · repaired and back in your bay as soon as the truck is home (a few minutes)`, 'bad', 6000), 2900); // (after drive.js's own "Wrecked" line)
    }
    const back = () => {
      if (!mine || this.save.rental !== mine || this.current) return; // (rented another meanwhile: that one stays)
      this.current = this.spawn(mine);
      if (this.current) this.hud?.flash(`Your ${RENTALS.find((c) => c.id === mine.id)?.label || 'car'} is repaired · it waits in the ${this.impound?.own ? 'car park beside the hall' : 'yard out front'}`, 'good', 3600);
    };
    const done = (car) => {
      if (this.towed === car) this.towed = null;
      this.remove(car); back();
      if (mp && this.mp === mp) mp.towDone?.(); // (multiplayer: the server's tow record ends)
    };
    if (this.truck) this.truck.fetch(e, done);
    else if (mine) setTimeout(() => done(e), 20000);
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
      this.inside = false; this.room.active = false; this.room.releasePortal();
      this.getPost().setView(this.scene, this.camera);
      document.getElementById('crosshair').hidden = true;
      this.player.frozen = false;
      if (now) return;
      const f = { x: this.L.dirx, z: this.L.dirz };
      this.player.teleport(this.door.x + f.x * 0.8, this.door.z + f.z * 0.8, Math.atan2(f.x, f.z));
      this.player.camYaw = Math.atan2(f.x, f.z) + Math.PI + 0.4;
      this.player.camPitch = -0.12;
      if (this.current) setTimeout(() => this.hud?.flash(this.current?.impound ? `Your car is impounded in the car park · free again ${untilTomorrow()}` : `Your rental car waits in the ${this.impound?.own ? 'car park beside the hall' : 'yard'} · E to drive`, 'good', 2800), 400);
    };
    if (now) out(); else { this.audio?.play?.('click'); this.transition.fade(out); }
  }

  // the configurator, for the car you pressed E at (its display paint to start; your current rental's config when it's
  // that model). The model itself is fixed in there: paint, wheels, plate only.
  openCard(pick, paintHexWant) {
    if (!RENTALS.some((c) => c.id === pick)) return;
    this.room.guide(null); // (found it)
    const cur = this.save.rental ? normConfig(this.save.rental) : null;
    const base = cur && pick === cur.id ? cur : normConfig({ id: pick, paint: PAINTS.find((p) => p.hex === paintHexWant)?.id || 'white', plate: randomPlate() });
    this.ui.open({ cars: RENTALS, cfg: base, current: cur, money: this.save.money, wreckFee: WRECK_FEE, cost: (c) => this.cost(c),
      preview: (c, step) => this.room.configure(c, step), drag: (dx, dy) => this.room.orbit(dx, dy),
      rent: (c) => { this.rent(c); this.input?.lock?.(); }, close: () => { this.room.endConfigure(); this.input?.lock?.(); },
      plateCheck: this.mp?.plateCheck, plateIssue: this.mp?.plateIssue }); // (multiplayer: plates unique across every player)
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

  /** Inside, per frame (main.js): walking, looking, E. Returns what to show as the prompt. */
  frame(dt, input, sensitivity) {
    const open = this.ui.isOpen;
    this.target = this.room.update(dt, open ? null : input, sensitivity, open);
    if (!open && this.target && input?.hit?.('KeyE')) {
      this.audio?.play?.('click');
      const t = this.target;
      if (t.kind === 'door') this.leave();
      else if (t.kind === 'clerk') this.recommend();
      else this.openCard(t.id, t.paint);
    }
    return this.target;
  }

  /** Per frame, outside too: the tow truck, the sign and lamps at night. */
  update(dt) {
    if (!this.L) return;
    this.truck?.update(dt);
    this.impound?.update(dt); // (your car left on a road: towed to the impound)
    try { this.ownerTags?.update(dt); } catch (e) { console.warn('owner tags', e); this.ownerTags = null; }
    const n = nightUniform?.value ?? 0;
    if (this.signMat) this.signMat.emissiveIntensity = 0.05 + 0.75 * n;
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.2 + 2.4 * n;
    if (this.glowMat) this.glowMat.emissiveIntensity = 0.3 + 0.9 * n;
    if (this.stripMat) this.stripMat.emissiveIntensity = 1.6 + 2.0 * n; // (the hall's light strips, seen through the glass)
    if (this.litMats) for (const m of this.litMats) m.emissiveIntensity = 0.45 + 0.35 * n;
  }
}
