// AUTOHAUS (was the CAR RENTAL; Oct 29, the user: "make sure you buy the car instead of renting so change it autohaus
// and up the prices"): cars are bought, not rented, at dealership prices. The hall stands on the road through Legacy
// Village (its site: game/bus/roads.js planRental: a flat lot right on the road's edge): an alpine car hall
// (carrentalshell.js: the one shell both outside and in: a wide larch gable to the road under a deep snowy roof, a
// full-height glass front with thin dark mullions between stone piers, the display cars on their turntables behind it,
// warm light inside), the AUTOHAUS board on the gable (village sign style, lit at night), lanterns, flags, potted
// spruces, and a compact ploughed yard in front (kerbs, painted bays, the TOW bay) fading into the snow. E at the door:
// inside (carrentalroom.js, its own scene: two storeys; through its glass the real world, rendered live as in the ski
// shop); at a car on display: the configurator for that car (ui/carrental.js); the salesman sends you to a random one.
// Your garage (save.garage: every car you bought, its config, plate and what you paid; up to GARAGE_MAX cars, the same
// model more than once too: every car is told apart by its plate): one of them
// is out at a time (save.rental: it waits in your bay, nose to the road; E beside it to drive; drive.js: every other
// car only says where to buy one). The configurator's MY CARS list (E at a model you own opens on it) puts another of
// yours in the bay (free), or sells one back for half what you paid. Wreck it: the bill (wreckFee: the tow and the full
// repair: $2,000 for every car; once; the balance may go below zero, like a fine) and the tow truck (towtruck.js) fetches
// the very car from wherever it lies and brings it back to your bay, repaired. Wrecked by a police ram: not repaired,
// gone from your garage. Multiplayer: the server owns the garage (profile cars, cars[0] the one out; net/session.js).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { nightUniform } from '../world/village.js';
import { busRoads } from './bus/roads.js';
import { carTemplate, carInstance } from './cars.js';
import { CarRentalRoom } from './carrentalroom.js';
import { TowFleet } from './towtruck.js';
import { CarRentalUI } from '../ui/carrental.js';
import { PAINTS, normConfig, extrasCost, dressCar, paintOf, randomPlate, setPlates } from './carconfig.js';
import { LAYOUT, buildShell } from './carrentalshell.js';
import { makeSign } from '../world/village.js';
import { fitModel } from '../core/assets.js';
import { groundPatchGeometry, groundDecal } from '../world/groundpatch.js'; // (the yard on the drawn terrain's own triangles)
import { Impound, untilTomorrow } from './impound.js'; // the big car park beside the hall: your car's bay, the impound, towing cars left on a road
import { Werkstatt } from './werkstatt.js'; // the repair garage beside the Autohaus (its prices: repairCost below)
import { applyDents, packDents, unpackDents } from './cardamage.js'; // (your cars' dents and damage kept until repaired: carDamage)
import { OwnerTags } from './ownertags.js'; // your name over your car, chalet, rented helicopter (and their map markers)
import { mergeStatic } from '../engine/merge.js'; // (the hall's boxes welded per material)

// (Oct 29, AUTOHAUS: bought for good at dealership prices, set against ~$9,000 an hour of jobs (jobs/catalog.js) and the
// $50,000 chalet: the Golf after an hour or two of jobs, the supercars long-term goals)
export const RENTALS = [
  { id: 'car_vw_golf_gti', label: 'VW Golf GTI', kind: 'Hot hatch', price: 11250, length: 4.3 },
  { id: 'car_tesla_m3', label: 'Tesla Model 3', kind: 'Electric saloon', price: 18000, length: 4.7 },
  { id: 'car_bmw_x3', label: 'BMW X3', kind: 'Premium SUV', price: 22500, length: 4.7 },
  { id: 'car_toyota_gr_yaris', label: 'Toyota GR Yaris', kind: 'Rally hot hatch', price: 25500, length: 3.99 },
  { id: 'car_audi_rs6', label: 'Audi RS6 Avant', kind: 'Performance estate', price: 45000, length: 5.0 },
  { id: 'car_mercedes_gls', label: 'Mercedes-Benz GLS', kind: 'Luxury SUV · 5 seats', price: 56250, length: 5.2 },
  { id: 'car_audi_etron_gt', label: 'Audi e-tron GT', kind: 'Electric grand tourer', price: 67500, length: 4.96 },
  // upstairs, the supercar floor (UPPER: on the mezzanine, bought the same way: walk up, E at it, or pick it here)
  { id: 'car_porsche_taycan', label: 'Porsche Taycan Turbo S', kind: 'Electric super saloon', price: 97500, length: 4.96 },
  { id: 'car_mercedes_sls', label: 'Mercedes SLS AMG', kind: 'Gull-wing supercar', price: 127500, length: 4.64 },
  { id: 'car_lamborghini_huracan', label: 'Lamborghini Huracán EVO', kind: 'V10 supercar', price: 165000, length: 4.52 },
];
// (saves from before the Dacia left the fleet, Oct 29: its rental comes back as the Golf)
const RETIRED = { car_dacia_duster: 'car_vw_golf_gti' };
export { PAINTS }; // (the configurator's: carconfig.js)
// the seven cars on display downstairs (one of each, each its own colour; LAYOUT.spots: where, in this order)
const DISPLAY = [['car_audi_rs6', 'graphite'], ['car_mercedes_gls', 'black'], ['car_audi_etron_gt', 'kingfisher'], ['car_tesla_m3', 'white'],
  ['car_bmw_x3', 'blue'], ['car_vw_golf_gti', 'red'], ['car_toyota_gr_yaris', 'white']];
// upstairs on the mezzanine, the supercars (LAYOUT.upSpots; for sale like the rest)
const UPPER = [['car_mercedes_sls', 'silver'], ['car_porsche_taycan', 'red'], ['car_lamborghini_huracan', 'orange']];
// the tow truck's bills and the WERKSTATT's (Oct 30, the user: "make sure to repair your car is a fixed cost for all
// cars, the cost should be 500"): one flat price for every repair, whatever the car and the damage.
// - a repair at the Werkstatt (werkstatt.js): REPAIR_FEE ($500) for any damage (none: nothing to pay)
// - a car left on a road: towed and held in the tow yard, flat WRECK_FEE (impound.js; server CATALOG.wreckFee)
// - a wreck: the same tow plus the repair, WRECK_FEE + REPAIR_FEE ($2,000) for every car. Server: repairFee, wreckFee
//   (server.repairPrice / wreckBill: the same sums)
export const WRECK_FEE = 1500, REPAIR_FEE = 500;
// THE AUTOHAUS CLERK (Oct 30, the user: "make it so you can talk to the npc in autohaus and you can pay him 500 to
// repair your car"): E at the salesman opens a talk (clerkDialog): the car of the day, or "Repair my car", a flat fee
// for any damage, your car that is out fixed wherever it is parked (server: CLERK_REPAIR, carRepair { flat: 'clerk' })
export const CLERK_REPAIR = 500;
/** The Werkstatt's price for a car at damage share `frac` (0..1): the flat REPAIR_FEE for any car; 0: nothing to repair, $0. */
export const repairCost = (id, frac) => (frac > 0 ? REPAIR_FEE : 0);
/** A wreck's bill: the tow and the repair ($2,000, every car). */
export const wreckFee = (id) => WRECK_FEE + repairCost(id, 1);
export const SELL_SHARE = 0.5; // a car sold back: half what you paid
export const GARAGE_MAX = 10; // (Oct 29, the user: "you also can buy more than 1 car so you have multiple cars"): the cars you can own (server: catalog garageMax)
// the lot (frame: +z to the road, its edge at z 13; +x along it): the hall's middle (z), the yard's half width and
// its road end, the rental bays (lines at x, from / to z), your car's spot, the TOW bay (middle, half length / width)
// (Oct 29: the bigger hall, 32 x 17.5 m: its glass front 0.6 m further from the road than before (the yard 12.3 m
// deep, the bays and the TOW bay as they were), its back 16.7 m in, its sides 16.3 m out: inside the cleared site)
const YARD = { hall: -7.9, hw: 16.0, z1: 13.2, bayLines: [-12.4, -9.4, -6.4, -3.4], bayZ: [2.6, 8.4], carX: -7.9, carZ: 5.6,
  tow: { x: 7.6, zs: [3.4, 6.9, 10.4], hl: 4.6, hw: 1.75 } }; // (three TOW bays side by side, one per truck: towtruck.js TowFleet)
const paintHex = (id) => paintOf(id).hex;

export class CarRental {
  constructor(o) {
    // o: scene, camera, renderer, models, colliders, cameraBlockers, parking, drive, traffic, hud, audio, save, writeSave,
    //    spend, makeRig, transition, player, input, getPost
    Object.assign(this, o);
    this.L = busRoads.rental;
    this.inside = false;
    this.current = null; // your car that is out (a parking entry, rental: true)
    this.towed = null;   // multiplayer: your wreck while the truck fetches it (the others still see it)
    this.kept = [];      // your other cars standing in the world (Oct 30, the user: "your car gets replaced when you buy a new
                         // car"): bought another one, the one out before stays parked where it is, yours to drive; getting
                         // in makes it the one out (keepCurrent, makeCurrent)
    this.ui = new CarRentalUI({ hud: o.hud, audio: o.audio });
    if (!this.L) return;
    const L = this.L;
    this.yaw0 = Math.atan2(L.dirx, L.dirz); // the lot's frame: local +z toward the road, +x along it
    this.buildOutside();
    this.room = new CarRentalRoom({ renderer: o.renderer, models: o.models, makeRig: o.makeRig, cars: RENTALS, display: DISPLAY.map(([id, paint]) => ({ id, paint: paintHex(paint) })), upper: UPPER.map(([id, paint]) => ({ id, paint: paintHex(paint) })) });
    // the showroom's windows look out on the real world from where the hall stands (its own outside hidden for that view)
    this.room.setWorld({ scene: o.scene, frame: this.hall, hide: () => [this.hall, this.player?.rig?.root, this.player?.rig?.gear] });
    // the tow trucks (three: towtruck.js TowFleet), each in its own TOW bay along the road, nose to the yard's right end;
    // out: on round to the right onto the road (each bay its own line past the noses of the bays nearer the road);
    // back: in from the road at the left of the bays, round into its own (so it ends nose first, square in the bay).
    // this.truck: the fleet (fetch, busy, update, trucks; the API of the one truck it replaces)
    const P = YARD.tow, yaw = this.yaw0 + Math.PI / 2;
    const ways = [ // bay 0 (by the hall), 1, 2 (by the road): [out after the spot], [in before the spot]
      [[[12.4, 4.4], [14.2, 7.6], [14.6, 11.6], [14.6, 15.8]], [[-1.6, 15.8], [-1.4, 9.0], [-0.4, 5.6], [2.0, 3.8], [4.4, P.zs[0] + 0.1]]],
      [[[12.6, 8.4], [14.2, 11.6], [14.6, 15.8]], [[-1.2, 15.8], [0.6, 11.2], [3.4, P.zs[1] + 0.3]]],
      [[[12.4, 11.0], [14.0, 13.2], [14.4, 15.8]], [[-1.0, 15.8], [0.4, 12.6], [3.4, P.zs[2] + 0.3]]],
    ];
    try {
      this.truck = new TowFleet({ scene: o.scene, models: o.models, colliders: o.colliders, camera: o.camera, traffic: o.traffic, audio: o.audio },
        P.zs.map((z, k) => {
          const park = this.w(P.x, z), [out, inn] = ways[k];
          return { park: { ...park, yaw }, yardOut: [park, ...out.map(([x, zz]) => this.w(x, zz))], yardIn: inn.map(([x, zz]) => this.w(x, zz)) };
        }));
    } catch (e) { console.warn('tow trucks', e); this.truck = null; }
    // drive.js: only your own car lets you in; a wreck of it: the repair bill and the truck
    if (o.drive) {
      o.drive.locked = (e) => (e.rental || e.free ? null : 'Buy a car at the Autohaus in Legacy Village');
      o.drive.onWreck = (e) => this.wrecked(e);
      // getting into another of your cars parked in the world: it becomes the one out
      const enter = o.drive.enter.bind(o.drive);
      o.drive.enter = (e) => { if (e?.kept && !o.drive.d && !o.drive.entering && !this.makeCurrent(e)) return; return enter(e); };
    }
    try { this.impound = new Impound(this, { fee: WRECK_FEE }); } catch (e) { console.warn('rental car park', e); this.impound = null; }
    try { this.werkstatt = new Werkstatt(this); } catch (e) { console.warn('Werkstatt', e); this.werkstatt = null; } // (after the car park: it keeps clear of it)
    try { this.ownerTags = new OwnerTags({ scene: o.scene, camera: o.camera, rental: this }); } catch (e) { console.warn('owner tags', e); this.ownerTags = null; }
    // the save: your garage, the car that is out back in your bay
    this.migrate();
    if (o.save.rental) { try { this.current = this.spawn(o.save.rental); } catch (e) { console.warn('rental car', e); } }
    this.spawnKept();
  }

  // ------------------------------------------------------------------ your garage (save.garage; save.rental: the one out)
  /** Old saves: the rental becomes a car you own (free: it was paid for); the garage made whole (one car per plate,
   *  known models only), save.rental the garage's entry with its plate (or null). Multiplayer: the profile's cars. */
  migrate() {
    const S = this.save;
    const fix = (c) => { if (!c || typeof c !== 'object') return null; if (RETIRED[c.id]) c = { ...c, id: RETIRED[c.id] }; return RENTALS.some((r) => r.id === c.id) ? normConfig(c) : null; };
    const g = [];
    for (const c of [...(Array.isArray(S.garage) ? S.garage : []), S.rental]) { const n = fix(c); if (n && !g.some((x) => x.plate === n.plate)) g.push(n); }
    S.garage = g;
    const r = fix(S.rental);
    S.rental = r ? g.find((x) => x.plate === r.plate) || null : null;
  }
  get garage() { return Array.isArray(this.save.garage) ? this.save.garage : (this.save.garage = []); }
  /** Your cars of model `id` (by plate: you may own several of one model). */
  owns(id) { return this.garage.filter((c) => c.id === id); }
  label(id) { return RENTALS.find((c) => c.id === id)?.label || 'car'; }
  where() { return this.impound?.own ? 'car park beside the Autohaus' : 'yard out front'; }
  /** What a car of yours sells back for: half what you paid (an old rental, never priced: half today's price). */
  sellValue(cfg) { return Math.round(((Number.isFinite(cfg?.price) ? cfg.price : this.cost(cfg).total) * SELL_SHARE) / 50) * 50; }
  /** Can the car that is out be swapped / sold now? (not while you drive it; one the tow truck has goes home from
   *  the truck: wrecked() / impound.js only put it back while it is still the one out) */
  busy() {
    const c = this.current;
    if (c && (c.driving || this.drive?.d?.e === c)) return 'Park your car first';
    return null;
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
    const inFloor = mk(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x8c8782, emissive: 0x4a4540, roughness: 0.25, metalness: 0.1 }), 0, 0.04, 0, hall); // (4 cm: clear of the snow at the hall's front corners, past the lot's sides)
    inFloor.rotation.x = -Math.PI / 2; inFloor.receiveShadow = inFloor.castShadow = false;
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, emissive: 0xffcf98, emissiveIntensity: 0.6, roughness: 0.9 });
    mk(new THREE.PlaneGeometry(9, 1.8), this.glowMat, -4.4, 6.1, -D / 2 + 0.05, hall).receiveShadow = false; // (the backlit AUTOHAUS sign inside)
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
    // the AUTOHAUS board on the gable (the village's sign style: a lettered board with a wooden back), lit at night
    const sign = makeSign('AUTOHAUS\nLEGACY VILLAGE', { w: 8.4, h: 2.0, font: 'bold 104px Georgia' });
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
      // the three TOW bays side by side (one per truck), ABSCHLEPPDIENST painted along their left ends
      const t = YARD.tow; c.strokeStyle = 'rgba(232,172,30,0.95)'; c.lineWidth = 6;
      c.fillStyle = 'rgba(232,172,30,0.95)'; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const tz of t.zs) {
        c.strokeRect(X(t.x - t.hl), Z(tz - t.hw), X(t.x + t.hl) - X(t.x - t.hl), Z(tz + t.hw) - Z(tz - t.hw));
        c.font = 'italic 700 44px Arial';
        c.save(); c.translate(X(t.x + t.hl) - 40, Z(tz)); c.rotate(-Math.PI / 2); c.fillText('TOW', 0, 0); c.restore();
      }
      c.font = 'italic 700 26px Arial';
      c.save(); c.translate(X(t.x - t.hl) - 22, Z((t.zs[0] + t.zs.at(-1)) / 2)); c.rotate(-Math.PI / 2); c.fillText('ABSCHLEPPDIENST', 0, 0); c.restore();
      // (the sides fade into the snow: alpha)
      c.globalCompositeOperation = 'destination-in';
      const fx = c.createLinearGradient(0, 0, w, 0); fx.addColorStop(0, 'rgba(0,0,0,0)'); fx.addColorStop(0.035, '#000'); fx.addColorStop(0.965, '#000'); fx.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = fx; c.fillRect(0, 0, w, h);
    });
    // (the drawn terrain's own triangles under it, 4 cm up (world/groundpatch.js): before, a plane of its own laid on
    // world.height at its vertices, and at the yard's road end, where the ground eases from the flat lot to the road's
    // height (the road climbs along the frontage), the terrain's 2 m triangles poked up through it up to ~0.4 m)
    g.updateMatrixWorld(true);
    const fx = L.dirx, fz = L.dirz, lotXZ = (x, z) => { const dx = x - L.x, dz = z - L.z; return [dx * fz - dz * fx, dx * fx + dz * fz]; };
    const yardGeo = groundPatchGeometry([[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]].map(([lx, lz]) => { const p = this.w(lx, lz); return [p.x, p.z]; }), {
      lift: 0.04, toLocal: (v) => g.worldToLocal(v),
      uv: (x, z) => { const [lx, lz] = lotXZ(x, z); return [(lx - X0) / YW, 1 - (lz - Z0) / YD]; },
    });
    const yard = new THREE.Mesh(yardGeo, groundDecal(new THREE.MeshStandardMaterial({ map: yardT, roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }))); // (drawn a hair nearer, as the car parks: no far terrain LOD over it)
    yard.receiveShadow = true;
    yard.renderOrder = 1;
    g.add(yard);
    // kerbs along the yard's sides (granite, low), on the ground
    const kerb = new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.85 });
    for (const sx of [-1, 1]) for (let z = Z0 + 0.6; z < Z1 - 1.5; z += 2) {
      // (on the drawn snow, tilted with it along their length: the ground eases toward the road's height at the front)
      const a = this.w(sx * (YARD.hw - 0.5), z + 0.02), b = this.w(sx * (YARD.hw - 0.5), z + 1.98), ya = world.meshHeight(a.x, a.z), yb = world.meshHeight(b.x, b.z);
      mk(new THREE.BoxGeometry(0.22, 0.16, 1.96), kerb, sx * (YARD.hw - 0.5), (ya + yb) / 2 - L.y + 0.06, z + 1).rotation.x = -Math.asin(Math.max(-0.5, Math.min(0.5, (yb - ya) / 1.96)));
    }
    // flags at the yard's front corners (blue banners on steel poles), potted spruces either side of the door
    const banner = canvas(128, 512, (c, w, h) => { c.fillStyle = '#16346e'; c.fillRect(0, 0, w, h); c.fillStyle = '#f2c88c'; c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
      c.save(); c.translate(w / 2, h / 2); c.rotate(-Math.PI / 2); c.fillStyle = '#fff'; c.font = 'italic 700 64px "Barlow Condensed", "Arial Narrow", Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('AUTOHAUS', 0, 4); c.restore(); });
    const bannerMat = new THREE.MeshStandardMaterial({ map: banner, roughness: 0.8, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) {
      const lx = sx * (YARD.hw - 0.6), lz = Z1 - 1.0, p = this.w(lx, lz), y = world.meshHeight(p.x, p.z) - L.y;
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
    // (performance pass: the hall's boxes / show cars and the yard's props welded per material; the hall on its own,
    // the showroom's window view hides it as a whole)
    try { mergeStatic(hall); mergeStatic(g, { skip: [hall] }); } catch (e) { console.warn('Autohaus: merge', e); }
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
    if (p === this.carSpot && !free) p = this.impound?.freeBay?.() || this.yardSpot() || p; // (a bay no other car stands in: another of yours, another player's; none left: the yard's bays in front of the hall)
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
    if (!free) { this.impound?.claim?.(e); this.impound?.adopt(e); } // (its bay taken; towed: in its impound bay, locked until tomorrow)
    if (!free) this.restoreDamage(e); // (its dents and damage as you left them)
    return e;
  }
  /** A free bay in the yard in front of the hall (YARD.bayLines: three), when the car park has none left. */
  yardSpot() {
    const cars = this.parking?.cars || [], L = YARD.bayLines;
    for (let i = 0; i < L.length - 1; i++) {
      const p = { ...this.w((L[i] + L[i + 1]) / 2, YARD.carZ), yaw: this.yaw0 };
      if (!cars.some((e) => !e.driving && e.car?.parent && Math.hypot(e.car.position.x - p.x, e.car.position.z - p.z) < 2.5) && !this.mp?.carNear?.(p.x, p.z, 2.5)) return p;
    }
    return null;
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
  // ------------------------------------------------------------------ crash damage, kept (Oct 30, the user: "when you
  // leave your car, the damage should be saved"): each car of yours keeps its dents, smashed lamps and damage % when you
  // get out, walk away, switch cars, rejoin or reload, until it is repaired (the Werkstatt, the clerk, a wreck's tow).
  // save.carDamage { [plate]: { p: damage %, d: packed dents (cardamage.js packDents) } }; multiplayer: the server's car
  // record too (carDamage: damage 0..1, dents), built back into save.carDamage from the profile (net/session.js)
  damageMap() { const S = this.save; return S.carDamage && typeof S.carDamage === 'object' && !Array.isArray(S.carDamage) ? S.carDamage : (S.carDamage = {}); }
  dmgSig(e) { const L = e.dents || []; return `${Math.round((e.damage || 0) * 10)}|${L.length}|${L.length ? L[L.length - 1].seed : ''}`; }
  /** A car of yours just put in the world (spawn): its kept dents and damage on it. */
  restoreDamage(e) {
    const D = this.save.carDamage?.[e.cfg?.plate];
    if (D && typeof D === 'object') {
      e.damage = Math.max(0, Math.min(99, Number(D.p) || 0)); // (99 at most: 100 is a wreck)
      e.dents = unpackDents(D.d);
      if (e.dents.length) { try { applyDents(e.inst, e); } catch (err) { console.warn('car damage: dents', err); } }
    }
    e.dmgSig = this.dmgSig(e);
  }
  /** Twice a second: a car of yours whose damage changed (a knock, a crash, a repair) is written down (and told to the server). */
  trackDamage(dt) {
    if ((this.dmgT = (this.dmgT || 0) - dt) > 0) return;
    this.dmgT = 0.5;
    for (const e of [this.current, ...this.kept]) {
      if (!e || !e.rental || e.wrecked || !e.cfg?.plate) continue;
      const sig = this.dmgSig(e);
      if (sig === e.dmgSig) continue;
      e.dmgSig = sig;
      const plate = e.cfg.plate, map = this.damageMap(), pct = Math.max(0, Math.min(99, e.damage || 0)), dents = packDents(e);
      if (pct <= 0 && !dents.length) delete map[plate];
      else map[plate] = { p: Math.round(pct * 10) / 10, d: dents };
      for (const k of Object.keys(map)) if (!this.garage.some((c) => c.plate === k)) delete map[k]; // (sold cars: nothing kept)
      this.writeSave();
      this.mp?.damage?.(plate, pct / 100, dents);
    }
  }
  /** Nothing kept for that car (a wreck: it comes home repaired; or it is gone). */
  dropDamage(plate) {
    const map = this.save.carDamage;
    if (!plate || !map?.[plate]) return;
    delete map[plate];
    this.writeSave();
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
    const ki = this.kept.indexOf(e); if (ki >= 0) this.kept.splice(ki, 1);
    for (const b of e.held || []) b.taken = false;
    e.smokeFx?.clear?.();
    e.wrecked = null;
    if (this.drive) this.drive._cc = null;
  }

  /** The price of a config: the car's list price and the extras (finish, trim, rims, your own plate). */
  cost(cfg) { const spec = RENTALS.find((c) => c.id === cfg.id) || RENTALS[0], extras = extrasCost(cfg); return { base: spec.price, extras, total: spec.price + extras }; }
  /** Buy `cfg` (a model you own already too: another one, its own plate; up to GARAGE_MAX cars): it joins your garage
   *  and waits in your bay (the one out before goes home). */
  buy(cfg) {
    cfg = normConfig(cfg);
    const spec = RENTALS.find((c) => c.id === cfg.id);
    if (!spec) return;
    if (this.garage.length >= GARAGE_MAX) { this.hud?.flash(`Your garage is full (${GARAGE_MAX} cars) · sell one first (MY CARS)`, 'bad', 3200); this.audio?.play?.('error'); return; }
    if (!this.mp && this.garage.some((c) => c.plate === cfg.plate)) { // (a plate already on another of yours)
      if (cfg.custom) { this.hud?.flash(`The plate ${cfg.plate} is on another car of yours`, 'bad', 2600); this.audio?.play?.('error'); return; }
      do cfg.plate = randomPlate(); while (this.garage.some((c) => c.plate === cfg.plate));
    }
    const no = this.busy(); if (no) { this.hud?.flash(no, 'bad', 2600); this.audio?.play?.('error'); return; }
    if (this.mp) return this.mp.rent(cfg); // multiplayer: the server sells it (price, a unique plate: net/session.js)
    const total = this.cost(cfg).total;
    if (!this.spend(total)) return;
    cfg.price = total;
    this.garage.unshift(cfg);
    const prev = this.current && this.keepable(this.current) ? this.label(this.current.cfg?.id) : null;
    this.putOut(cfg, `${spec.label} bought · ${cfg.plate} · yours for good · it waits in the ${this.where()}${prev ? ` · your ${prev} stays where you parked it` : ''}`);
  }
  rent(cfg) { return this.buy(cfg); } // (the old name)
  /** One of your cars (by plate) into your bay, free; the one out before stays where it is parked (keepCurrent). */
  takeOut(plate) {
    const cfg = this.garage.find((c) => c.plate === plate);
    if (!cfg || this.save.rental?.plate === plate) return;
    const no = this.busy(); if (no) { this.hud?.flash(no, 'bad', 2600); this.audio?.play?.('error'); return; }
    if (this.mp) { this.moveNext = plate; this.mp.switchCar?.(plate); return; } // multiplayer: the server swaps it (placeOwned: into your bay)
    this.garage.splice(this.garage.indexOf(cfg), 1); this.garage.unshift(cfg);
    this.putOut(cfg, `Your ${this.label(cfg.id)} waits in the ${this.where()} · ${cfg.plate}`, true);
  }
  /** Sell one of your cars back (by plate) for sellValue(); the one out sold: the next of yours takes its bay. */
  sell(plate) {
    const cfg = this.garage.find((c) => c.plate === plate);
    if (!cfg) return;
    const out = this.save.rental?.plate === plate;
    if (out) { const no = this.busy(); if (no) { this.hud?.flash(no, 'bad', 2600); this.audio?.play?.('error'); return; } }
    if (this.mp) { this.mp.sellCar?.(plate); return; } // multiplayer: the server pays (placeOwned)
    const v = this.sellValue(cfg);
    this.garage.splice(this.garage.indexOf(cfg), 1);
    const k = this.kept.find((x) => x.cfg?.plate === plate); if (k && !k.driving) this.remove(k); // (sold where it stood)
    this.save.money += v;
    this.hud?.setMoney?.(this.save.money, v);
    this.audio?.play?.('cash');
    if (out) this.putOut(this.garage[0] || null, null);
    else this.writeSave();
    this.hud?.flash(`${this.label(cfg.id)} sold · +$${v.toLocaleString('en-US')}`, 'good', 3200);
  }
  /** `cfg` (a garage entry, or null: none) is the car out: in your bay (or a free bay beside it). The one out before
   *  stays parked where it is (keepCurrent; one being towed or held in the tow yard goes home to your garage). A car of
   *  yours already standing in the world becomes the one out where it stands, unless `move` (MY CARS: into your bay). */
  putOut(cfg, msg, move = false) {
    this.keepCurrent();
    this.save.rental = cfg || null;
    const k = cfg ? this.kept.find((x) => x.cfg?.plate === cfg.plate) : null;
    if (k && !move) { this.kept.splice(this.kept.indexOf(k), 1); k.kept = false; k.cfg = cfg; this.current = k; }
    else { if (k && !k.driving) this.remove(k); if (cfg) this.current = this.spawn(cfg); }
    this.writeSave();
    if (msg) this.hud?.flash(msg, 'gold', 3400);
  }
  /** Can your car out stay parked in the world as one of your other cars? (in your garage, parked, not wrecked, towed
   *  or held in the tow yard) */
  // (one in the tow yard stays there too: impound.js lets it go into a free bay when its time is up; one on the tow
  // truck's bed goes on to the tow yard: impound.js tow)
  keepable(e) { return !!(e && e.rental && !e.driving && !e.wrecked && this.garage.some((c) => c.plate === e.cfg?.plate)); }
  /** The car out: kept parked where it is (this.kept), or gone home to your garage. this.current is null after. */
  keepCurrent() {
    const e = this.current;
    if (!e) return;
    if (this.keepable(e)) {
      e.kept = true; if (!this.kept.includes(e)) this.kept.push(e); this.current = null;
      if (!e.towing) { const g = e.car.position; e.home = { x: g.x, z: g.z, yaw: e.car.rotation.y }; } // (shoved later: back here, not into the bay it first stood in, maybe another car's now)
    } else if (!e.driving) { this.remove(e); this.current = null; }
  }
  /** drive.js: you get into another car of yours parked in the world: it is the one out now (multiplayer: the server
   *  makes it cars[0]); the one out before stays where it is. False: not now (it says why). */
  makeCurrent(e) {
    const cur = this.current, cfg = this.garage.find((c) => c.plate === e.cfg?.plate);
    if (!cfg) { this.remove(e); return false; } // (no longer yours: sold)
    if (cur && (cur.towing || cur.driving)) { this.hud?.flash(`Your ${this.label(cur.cfg?.id)} is with the tow truck · wait until it is home`, 'bad', 2800); this.audio?.play?.('error'); return false; }
    if (this.towed) { this.hud?.flash('Your car is with the tow truck · wait until it is home', 'bad', 2800); this.audio?.play?.('error'); return false; }
    if (cur) { if (this.keepable(cur) || cur.impound) { cur.kept = true; this.kept.push(cur); } else this.remove(cur); }
    this.kept.splice(this.kept.indexOf(e), 1);
    e.kept = false; e.cfg = cfg;
    this.current = e;
    this.save.rental = cfg;
    if (this.mp) { this.quiet = cfg.plate; this.mp.switchCar?.(cfg.plate); }
    else { this.garage.splice(this.garage.indexOf(cfg), 1); this.garage.unshift(cfg); }
    this.writeSave();
    return true;
  }
  /** Your other cars (the garage, but the one out) parked in free bays of the Autohaus car park (a new session; no
   *  free bay: they wait in the garage, MY CARS). */
  spawnKept() {
    if (!this.impound?.freeBay) return;
    for (const cfg of this.garage) {
      if (cfg.plate === this.save.rental?.plate || this.kept.some((k) => k.cfg?.plate === cfg.plate)) continue;
      const p = this.impound.freeBay(true);
      if (!p) break;
      let e = null;
      try { e = this.spawn(cfg, p); } catch (err) { console.warn('rental car', err); }
      if (!e) continue;
      e.kept = true; this.kept.push(e);
    }
  }

  /** Your garage and the car out rebuilt from the save (switching between the single-player and multiplayer saves). */
  resync() {
    if (this.current && !this.current.driving) { try { this.remove(this.current); } catch (e) { console.warn('rental car', e); } this.current = null; }
    for (const k of this.kept.slice()) if (!k.driving) { try { this.remove(k); } catch (e) { console.warn('rental car', e); } }
    this.kept = this.kept.filter((k) => k.driving);
    this.migrate();
    if (this.save.rental) { try { this.current = this.spawn(this.save.rental); } catch (e) { console.warn('rental car', e); } }
    this.spawnKept();
  }
  /** Multiplayer: the server's garage (profile cars, cars[0] the one out; net/session.js): the save follows it and the
   *  car out is put in your bay when it changed (bought, switched, sold). */
  placeOwned(cars, msg) {
    const list = (cars || []).map((c) => normConfig(c)).filter((c) => RENTALS.some((r) => r.id === c.id));
    const first = list[0] || null, was = this.save.rental?.plate || null;
    this.save.garage = list;
    for (const k of this.kept.slice()) if (!k.driving && !list.some((c) => c.plate === k.cfg?.plate)) this.remove(k); // (sold, gone)
    if (this.quiet && this.quiet === first?.plate) msg = null; // (makeCurrent: you just got into it, nothing to say)
    const move = !!this.moveNext && this.moveNext === first?.plate;
    this.quiet = null; this.moveNext = null;
    if ((first?.plate || null) !== was || !this.current) this.putOut(first, msg, move);
    else { this.save.rental = first; this.writeSave(); if (msg) this.hud?.flash(msg, 'gold', 3400); }
  }
  /** Multiplayer: the server sold you `cfg` (its plate checked): put it in the yard. (old name; placeOwned) */
  placeRented(cfg, cars) {
    const prev = this.current && this.keepable(this.current) ? this.label(this.current.cfg?.id) : null;
    if (cars) return this.placeOwned(cars, `${this.label(cfg.id)} bought · ${cfg.plate} · yours for good · it waits in the ${this.where()}${prev ? ` · your ${prev} stays where you parked it` : ''}`);
    const c = normConfig(cfg);
    this.save.garage = [c, ...this.garage.filter((x) => x.plate !== c.plate)];
    this.putOut(c, `${this.label(c.id)} bought · ${c.plate} · it waits in the ${this.where()}`);
  }

  // drive.js: a car was wrecked (yours: the repair bill, once); the truck fetches it
  // Your car isn't lost (Oct 29, the user: "once your car gets towed away it's repaired again, so it spawns at the
  // parking lot so you don't lose your car"): the bill (wreckFee: the tow and the full repair), then once the
  // truck has it back, it is repaired and waits in its bay in the car park beside the hall (the same car: model,
  // paint, plate). It stays yours (AUTOHAUS: bought, in your garage)
  wrecked(e) {
    const mine = e.rental && this.save.rental ? this.save.rental : null;
    const mp = mine ? this.mp : null;
    // (Oct 29, the user: "if your car becomes wrecked from the car crashes from the police it wont get repaired"):
    // wrecked by a police ram (police.js sets e.policeWreck): no bill, no repair; the car is gone from your garage (the
    // next car of yours, if any, waits in your bay)
    const lost = !!(mine && e.policeWreck);
    if (mine) this.dropDamage(mine.plate); // (towed home repaired, or gone: nothing kept)
    if (lost) {
      e.rental = false;
      if (this.current === e) this.current = null;
      const g = this.garage, i = g.findIndex((c) => c.plate === mine.plate);
      if (i >= 0) g.splice(i, 1);
      this.save.rental = null;
      if (mp?.ended) mp.ended(mine); // (multiplayer: the server takes it out of your garage; the next one comes out)
      else if (g[0]) this.putOut(g[0], null);
      this.writeSave();
      setTimeout(() => this.hud?.flash(`Your ${this.label(mine.id)} is gone · wrecked by the police`, 'bad', 6000), 2900);
    } else if (mine) {
      const fee = wreckFee(mine.id);
      e.rental = false;
      if (this.current === e) this.current = null;
      if (mp?.tow) { // multiplayer: the server charges the bill and records the tow (it ends in your bay: net/session.js)
        this.towed = e; // (still shown to the others: lying there, then on the truck: net/carride.js)
        const p = this.carSpot;
        mp.tow('wreck', p ? [p.x, world.height(p.x, p.z) + 0.03, p.z, p.yaw] : [e.car.position.x, e.car.position.y, e.car.position.z, 0]);
      } else {
        this.save.money -= fee;
        this.writeSave();
        this.hud?.setMoney?.(this.save.money, -fee);
      }
      this.audio?.play?.('cash');
      setTimeout(() => this.hud?.flash(`Car wrecked · -$${fee.toLocaleString('en-US')} · back in your bay soon`, 'bad', 5000), 2900); // (short: Oct 30, the user) // (after drive.js's own "Wrecked" line)
    }
    const back = () => {
      if (!mine || lost) return;
      const k = this.kept.find((x) => x.cfg?.plate === mine.plate);
      if (this.save.rental?.plate !== mine.plate || this.current) { // (another of yours out meanwhile: that one stays; this one waits in a free bay, still yours)
        const cfg = this.garage.find((c) => c.plate === mine.plate), p = !k && cfg ? this.impound?.freeBay?.(true) : null;
        const e = p ? this.spawn(cfg, p) : null;
        if (e) { e.kept = true; this.kept.push(e); this.hud?.flash(`Your ${this.label(mine.id)} is repaired · it waits in the ${this.where()}`, 'good', 3600); }
        return;
      }
      if (k && !k.driving) this.remove(k);
      this.current = this.spawn(this.save.rental);
      if (this.current) this.hud?.flash(`Your ${this.label(mine.id)} is repaired · it waits in the ${this.where()}`, 'good', 3600);
    };
    const done = (car) => {
      if (this.towed === car) this.towed = null;
      this.remove(car); back();
      if (mp && this.mp === mp && !lost) mp.towDone?.(); // (multiplayer: the server's tow record ends)
    };
    if (this.truck) this.truck.fetch(e, done);
    else if (mine) setTimeout(() => done(e), 20000);
  }

  // ------------------------------------------------------------------ outside: the door
  interaction(p) {
    if (!this.L || this.inside || !this.room) return null;
    if (Math.hypot(p.x - this.door.x, p.z - this.door.z) < 2.6) return this._prompt ||= { label: 'Autohaus', act: () => this.enter() };
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
      if (this.current) setTimeout(() => this.hud?.flash(this.current?.impound ? `Your car is in the tow yard by the Autohaus · ${untilTomorrow(this.current.impound)}` : `Your ${this.label(this.current.cfg?.id)} waits in the ${this.where()} · E to drive`, 'good', 2800), 400);
    };
    if (now) out(); else { this.audio?.play?.('click'); this.transition.fade(out); }
  }

  // the configurator, for the car you pressed E at (its display paint to start): always a new one to buy (a model you
  // own already too: another one, its own plate); when you own that model it opens on the summary, where MY CARS lists
  // every car of yours (yours of this model first): click one to put it in your bay, SELL it. The model itself is
  // fixed in there: paint, wheels, plate only.
  openCard(pick, paintHexWant) {
    if (!RENTALS.some((c) => c.id === pick)) return;
    this.room.guide(null); // (found it)
    const own = this.owns(pick).length, cur = this.save.rental ? normConfig(this.save.rental) : null;
    let plate = randomPlate(); while (this.garage.some((c) => c.plate === plate)) plate = randomPlate();
    const base = normConfig({ id: pick, paint: PAINTS.find((p) => p.hex === paintHexWant)?.id || 'white', plate });
    const garage = this.garage.map((c) => ({ ...normConfig(c), label: this.label(c.id), value: this.sellValue(c), out: c.plate === cur?.plate }))
      .sort((a, b) => (b.id === pick) - (a.id === pick)); // (yours of this model first)
    this.ui.open({ cars: RENTALS, cfg: base, current: cur, garage, garageMax: GARAGE_MAX, step: own ? 3 : 0, owned: own,
      money: this.save.money, wreckFee: wreckFee(pick), repairFull: repairCost(pick, 1), towFee: WRECK_FEE, cost: (c) => this.cost(c),
      preview: (c, step) => this.room.configure(c, step), drag: (dx, dy) => this.room.orbit(dx, dy),
      rent: (c) => { this.buy(c); this.input?.lock?.(); }, close: () => { this.room.endConfigure(); this.input?.lock?.(); },
      takeOut: (plate) => { this.takeOut(plate); this.input?.lock?.(); }, sell: (plate) => { this.sell(plate); this.input?.lock?.(); },
      plateCheck: this.mp?.plateCheck, plateIssue: this.mp?.plateIssue }); // (multiplayer: plates unique across every player)
  }

  // the salesman: a car of the day, picked at random from the floor (never the same twice in a row); a marker over it
  // shows you the way (carrentalroom.js guide) until you press E at it
  recommend() {
    const on = this.room.tables.map((t) => t.id).filter((id) => RENTALS.some((c) => c.id === id));
    if (!on.length) return;
    const pool = on.length > 1 ? on.filter((id) => id !== this.lastTip) : on, id = pool[Math.floor(Math.random() * pool.length)];
    this.lastTip = id;
    const spec = RENTALS.find((c) => c.id === id), up = this.room.tables.find((t) => t.id === id)?.up;
    const price = `$${spec.price.toLocaleString('en-US')}`;
    const lines = [`Grüezi! Take a look at the ${spec.label}${up ? ' upstairs' : ''}, yours for ${price}!`, `Have you seen the ${spec.label}${up ? ' upstairs' : ''}? Lovely in the snow, and only ${price}.`, `Today I'd buy the ${spec.label}${up ? ', up the stairs' : ''}. ${price}, and it's yours for good!`];
    this.hud?.flash(lines[Math.floor(Math.random() * lines.length)], 'good', 3600);
    this.room.guide(id);
  }

  // the salesman, talked to (E at him): a greeting, the car of the day, or "Repair my car" (CLERK_REPAIR, flat, for
  // your car that is out wherever it is parked: the Werkstatt's own repair, behind the scenes); Bye / Esc walks away
  /** Your car that is out and what the clerk's repair of it says: { e, label, plate, frac, pct, why } (why: not now). */
  clerkQuote() {
    const e = this.current, cfg = e?.cfg || this.save.rental;
    const label = this.label(cfg?.id), plate = cfg?.plate || '';
    let frac = Math.max(0, Math.min(1, (e?.damage || 0) / 100));
    if (frac <= 0 && e?.dents?.length) frac = 0.01; // (dented, no damage on the clock: still a repair)
    const q = { e, label, plate, frac, pct: frac > 0 ? Math.max(1, Math.round(frac * 100)) : 0, why: '' };
    const W = this.werkstatt;
    if (!this.garage.length) q.why = "You don't own a car yet";
    else if (!e) q.why = this.save.rental ? `Your ${label} is with the tow truck` : 'None of your cars is out';
    else if (e.towing || e.wrecked || this.towed === e) q.why = `Your ${label} is with the tow truck · wait until it is home`;
    else if (e.impound) q.why = `Your ${label} is in the tow yard · ${untilTomorrow(e.impound)}`;
    else if (e.driving) q.why = `Your ${label} is out on the road`;
    else if (W && (W.job?.e === e || W.paying)) q.why = `Your ${label} is in the Werkstatt right now`;
    else if (frac <= 0) q.why = 'Not a scratch on it · nothing to repair';
    else if (this.clerkPaying) q.why = 'One moment…';
    else if ((this.save.money || 0) < CLERK_REPAIR) q.why = 'Not enough money';
    return q;
  }
  clerkDialog() {
    const hud = this.hud;
    if (!hud?.dialog) { this.recommend(); return; }
    const q = this.clerkQuote(), car = q.e || this.save.rental ? `${q.label}${q.plate ? ` · ${q.plate}` : ''}${q.e ? ` · damage ${q.pct}%` : ''}` : '';
    const hellos = ['Grüezi! Welcome to the Autohaus. How can I help you today?', 'Grüezi mitenand! Looking for a new car, or is yours giving you trouble?', 'Hello again! What can I do for you?'];
    const say = q.e && q.frac > 0 && !q.why ? `Grüezi! Your ${q.label} has seen some knocks, I see. Our mechanic can fix it up for a flat $${CLERK_REPAIR}, wherever it is parked.` : hellos[Math.floor(Math.random() * hellos.length)];
    hud.dialog('Autohaus · Salesman', say, [
      { label: 'Car of the day', sub: 'His tip from the showroom floor', act: () => this.recommend() },
      { label: 'Repair my car', sub: [car, q.why].filter(Boolean).join(' · ') || 'Your car that is out', price: CLERK_REPAIR, disabled: !!q.why, act: () => this.clerkRepair() },
      { label: 'Bye', secondary: true },
    ]);
    hud.onClose = () => this.input?.lock?.(); // (Bye, Esc, or a choice: back to walking)
  }
  async clerkRepair() {
    const q = this.clerkQuote(), e = q.e;
    if (q.why || !e) { if (q.why) this.hud?.flash(q.why, 'bad', 2600); this.audio?.play?.('error'); return; }
    if (this.mp?.repair) {
      this.clerkPaying = true;
      let r = null;
      try { r = await this.mp.repair(q.frac, e.cfg?.plate, 'clerk'); } finally { this.clerkPaying = false; }
      if (!r) return; // (net/session.js said why)
      this.audio?.play?.('cash');
    } else if (!this.spend?.(CLERK_REPAIR)) return; // (single player: spend() says when it's short)
    try { this.drive?.repair?.(e); } catch (err) { console.warn('clerk repair', err); e.damage = 0; e.dents = []; } // (the Werkstatt's repair: dents out, new lamps, damage 0)
    const lines = ['Our mechanic will fix it up right away!', 'Consider it done, our mechanic is on his way.', 'No problem, our mechanic will have it like new in no time.'];
    this.hud?.flash(`"${lines[Math.floor(Math.random() * lines.length)]}" · your ${q.label}${q.plate ? ` (${q.plate})` : ''} is repaired where it stands · paid $${CLERK_REPAIR}`, 'good', 4200);
  }

  /** Inside, per frame (main.js): walking, looking, E. Returns what to show as the prompt. */
  frame(dt, input, sensitivity) {
    const open = this.ui.isOpen || !!this.hud?.panelOpen; // (the configurator, or the salesman's talk)
    this.target = this.room.update(dt, open ? null : input, sensitivity, open);
    const n = this.target?.kind === 'car' ? this.owns(this.target.id).length : 0;
    if (n) this.target.label = `${this.label(this.target.id)} · yours: ${n} · buy another · take it out · sell`; // (a model you own)
    if (!open && this.target && input?.hit?.('KeyE')) {
      this.audio?.play?.('click');
      const t = this.target;
      if (t.kind === 'door') this.leave();
      else if (t.kind === 'clerk') this.clerkDialog();
      else this.openCard(t.id, t.paint);
    }
    return this.target;
  }

  /** Per frame, outside too: the tow truck, the sign and lamps at night. */
  update(dt) {
    if (!this.L) return;
    try { this.trackDamage(dt); } catch (e) { console.warn('car damage', e); }
    this.truck?.update(dt);
    this.impound?.update(dt); // (your car left on a road: towed to the impound)
    try { this.werkstatt?.update(dt); } catch (e) { console.warn('Werkstatt', e); this.werkstatt = null; } // (a repair under way, its card, its lights at night)
    try { this.ownerTags?.update(dt); } catch (e) { console.warn('owner tags', e); this.ownerTags = null; }
    const n = nightUniform?.value ?? 0;
    if (this.signMat) this.signMat.emissiveIntensity = 0.05 + 0.75 * n;
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.2 + 2.4 * n;
    if (this.glowMat) this.glowMat.emissiveIntensity = 0.3 + 0.9 * n;
    if (this.stripMat) this.stripMat.emissiveIntensity = 1.6 + 2.0 * n; // (the hall's light strips, seen through the glass)
    if (this.litMats) for (const m of this.litMats) m.emissiveIntensity = 0.45 + 0.35 * n;
  }
}
