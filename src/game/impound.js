// The CAR RENTAL's car park and impound (Oct 29, the user: "if your car is blocking the road and not parked in a
// parking lot properly ... it will be towed away if there is no one inside ... it should cost the same as when it is
// crashed and then you can only pick it up the next day in the car rental so add a big parking lot where all the cars
// are parked that are bought and towed").
//
// - The lot: a big car park beside the rental's yard, along the same road (planned here from the rental's own site,
//   busRoads.rental: roads.js is not touched). It is built like every other car park (parking.js: the surface,
//   painted bays, lamps, the pay machine and P sign) and filled with other people's cars. Your rented car waits in
//   its bay nearest the hall (rental.carSpot); a few bays in its back row are the impound.
// - Towing: your car left empty ON a road (any lane, a junction), not in a car park or a lay-by, while you are
//   AWAY_R m or more from it for TOW_AFTER s, is fetched by the rental's tow truck (towtruck.js, as for a wreck). The
//   fee is the wreck fee (carrental.js WRECK_FEE), charged when the truck sets out; the car ends in an impound bay.
//   (Oct 30: also a car left in a car park but not properly in a bay, or across a car park's entrance; never one left
//   in a bay, a lay-by or anywhere off the roads: where(), and the parking card that says which it is)
// - Pick-up: an impounded car is locked until the next in-game day (save.day: main.js counts a day each midnight):
//   E at it says "Impounded · available tomorrow"; from then on it is yours to drive again.
// Kept in save.impound = { day, bay, plate } (the rental's plate: it ties the impound to that car).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { busRoads, laneDistance, ROAD_HALF } from './bus/roads.js';
import { inChaletSite } from './bus/chaletroad.js'; // (the chalet village: its drives and private bays count as parked)
import { planRentalPark } from './bus/autohaus.js'; // (the car park's site: planned with the roads)
import { lotMaterial } from './bus/bus.js';
import { groundDecal } from '../world/groundpatch.js';
import { CAR_MODELS, pickCar } from './cars.js';
import { mulberry32 } from '../core/noise.js';
import { net } from '../net/client.js';
import { isMP } from '../net/mode.js';

// how long until the impound lifts: the next in-game day starts at midnight (world/sky.js: 1 game hour = 40 real s)
// The tow yard (was "impounded"; Oct 30, the user: "when your car is impounded it comes back in 3 min, and change
// impounded to a different word"): a towed car is held RELEASE_S real seconds (record.until, ms: the server's clock in
// multiplayer), then it is back in your bay. Old records without `until` keep the next-day rule.
export const RELEASE_S = 180;
export const nowMs = () => (isMP() && net.serverNow ? net.serverNow() : Date.now());
/** "back in 2 min 41 sec" for a tow yard record (or "back soon"). (Oct 31 2026: clock()'s words, not "2:41", as the
 *  user's Oct 30 "it should say 30 sec") */
export function backIn(rec) {
  if (!Number.isFinite(rec?.until)) return 'back soon';
  return `back in ${clock((rec.until - nowMs()) / 1000)}`;
}
export function untilTomorrow(rec) { return backIn(rec); } // (the old name, still imported)
// (STRAY_BACK, the 3-minute return of a car left off the road, is gone: Oct 30, the user: a car "just on terrain" is
// fine where it is; only a road or a blocked car park gets it towed)
export const TOW_AFTER = 60; // (Oct 29, the user: towed after 30 s; Oct 31 2026: "make sure a car only gets towed after 1 min instead of 30 sec")
export const WARN2_AFTER = 45;    // s left blocking a road with you away before the truck is called
export const AWAY_R = 40;       // m: "away" from your car
const IMPOUND_BAYS = 4;         // bays kept free for towed cars (the back row's far end)
// properly in a bay (Oct 30, the user: "park properly within the slots, but give them a tiny bit of room for error"):
// the car's centre inside the bay's lines, its heading within BAY_YAW of the bay's (either way round: nose in or backed
// in), and its body at most BAY_TOL m over the lines
const BAY_YAW = 20 * Math.PI / 180, BAY_COS = Math.cos(BAY_YAW), BAY_TOL = 0.5, CAR_HW = 0.95;
const MOUTH = { out: 9, lat: ROAD_HALF + 2.5 }; // in front of a car park's entrance: up to 9 m out from its edge, the access road's width + 2.5 m
// (Oct 30, the user: "make sure the message doesn't say 0:30, it should say 30 sec": "30 sec", "1 min 30 sec")
const clock = (s) => { s = Math.max(0, Math.ceil(s)); const m = Math.floor(s / 60), r = s % 60; return m ? (r ? `${m} min ${r} sec` : `${m} min`) : `${r} sec`; };

const YARD_CSS = `
#tow-yard { position: absolute; left: 22px; bottom: 92px; min-width: calc(var(--u, 1px) * 300); padding: calc(var(--u, 1px) * 12) calc(var(--u, 1px) * 30) calc(var(--u, 1px) * 14) calc(var(--u, 1px) * 24);
  background: #fff; color: var(--blue, #1546c8); clip-path: var(--brush-a); filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)); pointer-events: none; }
#tow-yard[hidden] { display: none; }
body.wanted #tow-yard { bottom: auto; top: calc(var(--u, 1px) * 150); } /* (the WANTED box has the corner) */
#park-card { position: absolute; left: 22px; bottom: 92px; max-width: calc(var(--u, 1px) * 460); padding: calc(var(--u, 1px) * 11) calc(var(--u, 1px) * 30) calc(var(--u, 1px) * 13) calc(var(--u, 1px) * 24);
  background: #fff; color: var(--blue, #1546c8); clip-path: var(--brush-a); filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)); pointer-events: none; }
#park-card[hidden] { display: none; }
body.wanted #park-card { bottom: auto; top: calc(var(--u, 1px) * 150); }
#park-card .pk-head { font-family: var(--num); font-style: italic; font-weight: 700; font-size: calc(var(--u, 1px) * 24); letter-spacing: 0.04em; line-height: 1.1; }
#park-card.good .pk-head { color: #1f9d55; }
#park-card.bad .pk-head { color: #ff4d3d; }
#park-card .pk-sub { margin-top: calc(var(--u, 1px) * 4); font-size: calc(var(--u, 1px) * 15); font-weight: 700; color: var(--blue-dim, #4f72d4); }
#tow-yard .ty-head { font-family: var(--num); font-style: italic; font-weight: 700; font-size: calc(var(--u, 1px) * 20); letter-spacing: 0.08em; color: #ff4d3d; }
#tow-yard .ty-t { font-family: var(--num); font-style: italic; font-weight: 700; font-size: calc(var(--u, 1px) * 52); line-height: 1; font-variant-numeric: tabular-nums; }
#tow-yard .ty-sub { margin-top: calc(var(--u, 1px) * 4); font-size: calc(var(--u, 1px) * 15); font-weight: 700; color: var(--blue-dim, #4f72d4); }
#tow-yard .ty-more { margin-top: calc(var(--u, 1px) * 6); font-size: calc(var(--u, 1px) * 14); font-weight: 700; color: var(--blue, #1546c8); line-height: 1.3; white-space: pre-line; }
#tow-yard .ty-more:empty { display: none; }`;

export class Impound {
  /** @param {import('./carrental.js').CarRental} rental */
  constructor(rental, { fee = 1500 } = {}) {
    this.R = rental;
    this.fee = fee; // (carrental.js WRECK_FEE: the same as a wreck)
    this.lot = null;
    this.t = 0;
    try { this.lot = this.plan(); } catch (e) { console.warn('rental car park: plan', e); }
    if (this.lot) { try { this.build(); } catch (e) { console.warn('rental car park: build', e); } }
    // drive.js: a car on its way to (or in) the impound does not let you in
    const d = rental.drive;
    if (d) { const prev = d.locked; d.locked = (e) => this.lockReason(e) ?? (prev ? prev(e) : null); }
  }

  get save() { return this.R.save; }
  get day() { return this.save.day ?? 1; }

  // ------------------------------------------------------------------ the site
  // Planned with the roads (bus/autohaus.js planRentalPark, busRoads.rentalPark), before the terrain: the roads' cut
  // levels it like every other car park (its surface on the road's profile, flush with the road along its front, no
  // plough berm through its bays). (Before, it was planned here at run time, on the natural slope, with the road's berm
  // running through its front row: Oct 30, the user: "something that is higher so I can't park there".) Fallback (no
  // site planned): the same planning here, on the ground as it is.
  plan() {
    const RL = this.R.L;
    if (!RL) return null;
    if (busRoads.rentalPark) return busRoads.rentalPark;
    return planRentalPark(RL, { colliders: this.R.colliders });
  }

  // the car park itself (parking.js builds it like the others), the own bay, the impound bays, other people's cars
  build() {
    const R = this.R, L = this.lot, P = R.parking;
    if (!P?.build) return;
    // (drawn a hair nearer than the car park's asphalt, as parking.js's paint: before, the asphalt (lotMaterial, pulled
    // 0.15 % of the distance toward the camera) overtook the lines' 2 cm from ~15 m off: the bays flickered away)
    const paint = groundDecal(new THREE.MeshStandardMaterial({ color: 0xeeefea, roughness: 0.92, metalness: 0, envMapIntensity: 0.15, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), 0.0019);
    P.build(L, lotMaterial(), paint, R.models, R.colliders);
    if (!P.group.parent) R.scene.add(P.group);
    const bays = L.bays || [];
    if (!bays.length) return;
    const door = R.door || { x: R.L.x, z: R.L.z };
    const pose = (b) => ({ x: b.x, z: b.z, yaw: Math.atan2(b.hx, b.hz) }); // (backed in: nose out to the aisle)
    // your bay: the one nearest the hall's door; the impound: the far end of the back row (away from the road)
    const byDoor = bays.slice().sort((a, b) => Math.hypot(a.x - door.x, a.z - door.z) - Math.hypot(b.x - door.x, b.z - door.z));
    this.own = byDoor[0];
    this.byDoor = byDoor;
    const back = bays.filter((b) => b !== this.own && ((b.x - L.x) * L.vx + (b.z - L.z) * L.vz) < 0);
    this.pound = (back.length ? back : bays.filter((b) => b !== this.own)).sort((a, b) => Math.hypot(b.x - door.x, b.z - door.z) - Math.hypot(a.x - door.x, a.z - door.z)).slice(0, IMPOUND_BAYS);
    R.carSpot = pose(this.own); // (rented and bought cars wait here now, not in the yard)
    this.pose = pose;
    // the rest about half full of other people's cars (seeded: the same every time)
    try {
      const rnd = mulberry32(7303), kinds = CAR_MODELS.filter(([n]) => R.models[n]), names = kinds.map(([n]) => n), len = new Map(kinds);
      const colours = [null, 0xf2f2f0, 0x1b1d22, 0x9aa0a6, 0x24324e, 0x7a1d1d, 0x5d6166, 0xd8d2c4];
      for (const b of bays) {
        if (b === this.own || this.pound.includes(b) || !names.length || rnd() > 0.5) continue;
        const name = pickCar(names, rnd());
        P.parkCar(L, R.models[name], R.colliders, R.cameraBlockers, { length: len.get(name), bay: b, paint: colours[Math.floor(rnd() * colours.length)], name, noseIn: rnd() < 0.5 });
      }
    } catch (e) { console.warn('rental car park: cars', e); }
  }

  /** The pose of the free bay nearest the hall: your bay unless a car stands in it (another of yours, or in multiplayer
   *  another player's: every player's car used to wait in the very same bay, one over the other); else the next free
   *  one. other: never your own bay (your other cars, kept parked: carrental.js spawnKept). Null: none free. */
  freeBay(other = false) { const b = this.freeBayOf(other); return b ? this.pose(b) : null; }
  // (Oct 30, the user: "if you buy more than 2 cars only one of the cars is in the parking lot, fix it for any number of
  // cars"): a bay is free when no car stands in it, whatever its `taken` flag says (drive.js marks every bay within 3 m
  // of where a car stops, the neighbours too, and a bay stays marked while the car that left it is driven: those bays
  // were lost to your cars). Single player: no free bay left, an other people's car (the decorative ones) leaves the
  // bay nearest the hall for yours: the car park's 11 bays (the tow yard's 4 aside) hold a full garage (GARAGE_MAX).
  // Before, with the bays gone (half of them other people's cars) every car out went into your own bay, one inside the
  // other: only one of your cars to be seen.
  freeBayOf(other = false, evict = true) {
    const mp = isMP() ? this.R.mp || {} : null, cars = this.R.parking?.cars || []; // (isMP: carrental.mp follows the save swap a moment late)
    if (!this.byDoor || !this.pose) return null;
    const ok = (x) => !this.pound?.includes(x) && !(other && x === this.own);
    const at = (x) => cars.filter((e) => !e.driving && e.car?.parent && Math.hypot(e.car.position.x - x.x, e.car.position.z - x.z) < 2.5);
    const free = this.byDoor.find((x) => ok(x) && !at(x).length && !mp?.carNear?.(x.x, x.z, 2.5));
    if (free || !evict || mp) return free || null;
    // (only quiet ones: none shoved, wrecked or on its way back to its bay)
    const deco = (e) => e.deco && !e.rental && !e.kept && !e.slide && !e.wrecked && !e.astray;
    for (const x of this.byDoor) {
      if (!ok(x)) continue;
      const here = at(x);
      if (!here.length || !here.every(deco)) continue;
      for (const e of here) this.evict(e);
      return x;
    }
    return null;
  }
  /** An other people's car (parking.js parkCar) out of the world for good (this session): its bay for one of yours. */
  evict(e) {
    const P = this.R.parking, drop = (arr, o) => { const i = arr ? arr.indexOf(o) : -1; if (i >= 0) arr.splice(i, 1); };
    drop(P?.cars, e);
    e.car.removeFromParent();
    drop(e.deco?.cols || this.R.colliders, e.collider); drop(e.deco?.blockers || this.R.cameraBlockers, e.block);
    for (const b of e.held || (e.bay ? [e.bay] : [])) b.taken = false;
    if (this.R.drive) this.R.drive._cc = null;
  }
  /** carrental.js spawn: the bay a car of yours was put in is its own (taken: no other car parks on it). */
  claim(e) {
    const g = e?.car, bays = this.lot?.bays;
    if (!g || !bays) return;
    const b = bays.find((x) => Math.hypot(x.x - g.position.x, x.z - g.position.z) < 1);
    if (!b) return;
    for (const h of e.held || []) if (h !== b) h.taken = false;
    b.taken = true; e.held = [b];
  }
  /** In this car park (anywhere on it)? */
  inLot(x, z, pad = 0.5) {
    const L = this.lot;
    if (!L) return false;
    const dx = x - L.x, dz = z - L.z;
    return Math.abs(dx * L.ux + dz * L.uz) < L.hw + pad && Math.abs(dx * L.vx + dz * L.vz) < L.hd + pad;
  }

  // ------------------------------------------------------------------ your car
  /** carrental.js spawn(): a rental whose plate is impounded goes straight to its impound bay, locked. */
  adopt(e) {
    const s = this.save.impound;
    if (!e || !s || !e.cfg || s.plate !== e.cfg.plate) return;
    if (this.released(s)) { this.save.impound = null; return; } // (its time is up: free to go, in your bay)
    e.impound = { day: s.day, until: s.until };
    this.place(e, this.pound?.[s.bay] || this.own);
  }
  place(e, bay) {
    const p = bay ? (this.pose ? this.pose(bay) : { x: bay.x, z: bay.z, yaw: e.car.rotation.y }) : this.R.carSpot, g = e?.car; // (no car park: the yard)
    if (!p || !g) return;
    g.position.set(p.x, world.height(p.x, p.z) + 0.03, p.z);
    g.rotation.set(0, p.yaw, 0);
    g.updateMatrixWorld(true);
    if (e.collider) { e.collider.x = p.x; e.collider.z = p.z; e.collider.rot = -p.yaw; }
    for (const b of e.held || []) b.taken = false;
    if (bay) bay.taken = true;
    e.held = bay ? [bay] : [];
    e.home = { x: p.x, z: p.z, yaw: p.yaw };
  }
  lockReason(e) {
    if (e?.towing) return 'Your car · being towed to the tow yard by the Autohaus';
    if (e?.impound) return `Tow yard · ${backIn(e.impound)}`;
    return null;
  }
  // a tow yard record whose time is up (old records without `until`: the next day)
  released(rec) { return !rec || (Number.isFinite(rec.until) ? nowMs() >= rec.until : this.day > rec.day); }
  /** Where your car is for the map and the name tags: { x, z, impounded } or null. */
  status() {
    const e = this.R.current;
    if (!e?.car || e.driving) return null;
    return { x: e.car.position.x, y: e.car.position.y, z: e.car.position.z, impounded: !!(e.impound || e.towing), car: e };
  }

  // ------------------------------------------------------------------ where a car stands (Oct 30)
  // The tow rules (the user: "cars don't get towed if they are parked on a parking lot, and they also don't get towed if
  // they are just on terrain; they only get towed if they are on a road ... also if they park in front of a parking lot
  // blocking the parking lot"):
  //   'bay'   in a car park's bay, properly (BAY_YAW / BAY_TOL)             fine
  //   'lot'   in a car park but not properly in a bay (the aisle, across the lines, crooked)   towed
  //   'mouth' in front of a car park's entrance                              towed
  //   'road'  on a road (a lane, a junction, a roundabout)                   towed
  //   'layby' in a lay-by, 'yard' on a building's forecourt (the Autohaus yard, the medical centre, the police
  //           station), 'free' in the chalet village (its drives, its private bays)   fine
  //   'snow'  anywhere else off the roads and car parks: moved to a free bay of the Autohaus car park after TOW_AFTER s
  //           (no fee; snowSpot)
  // { kind, ok, lot, bay, n (the bay's number), why ('aisle' | 'angle' | 'lines') }
  /** The car parks with painted bays: the Autohaus car park and the others (parking.js lotBays). */
  bayLots() {
    const out = this._bl || (this._bl = []);
    out.length = 0;
    if (this.lot?.bays?.length) out.push(this.lot);
    for (const L of busRoads.lots) if (L !== this.lot && !L.building && L.bays?.length && L.ux !== undefined) out.push(L);
    return out;
  }
  /** Where a car of length len standing at (x, z) heading yaw is, for the tow rules. */
  where(x, z, yaw, len = 4.6) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw), hl = len / 2, lots = this.bayLots();
    for (const L of lots) {
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx * L.ux + dz * L.uz) > L.hw + 0.3 || Math.abs(dx * L.vx + dz * L.vz) > L.hd + 0.3) continue;
      // in this car park: the bay its centre is in (between the lines)
      let best = null, bd = Infinity;
      for (let i = 0; i < L.bays.length; i++) {
        const b = L.bays[i], bx = x - b.x, bz = z - b.z;
        if (Math.abs(bx) > 4 || Math.abs(bz) > 4) continue;
        const al = bx * b.hx + bz * b.hz, ac = bx * b.hz - bz * b.hx; // (along the bay, across it)
        if (Math.abs(al) > b.hd || Math.abs(ac) > b.hw) continue;
        const d = Math.hypot(al, ac);
        if (d < bd) { bd = d; best = { b, n: i + 1, al, ac }; }
      }
      if (!best) return { kind: 'lot', ok: false, lot: L, why: 'aisle' };
      const { b, n, al, ac } = best;
      const cl = fx * b.hx + fz * b.hz, cc = fx * b.hz - fz * b.hx; // (the car's heading along / across the bay)
      if (Math.abs(cl) < BAY_COS) return { kind: 'lot', ok: false, lot: L, bay: b, n, why: 'angle' };
      // how far its body reaches past the bay's lines (its box: half length along its heading, half width across)
      const overL = Math.abs(al) + Math.abs(cl) * hl + Math.abs(cc) * CAR_HW - b.hd;
      const overA = Math.abs(ac) + Math.abs(cc) * hl + Math.abs(cl) * CAR_HW - b.hw;
      if (overL > BAY_TOL || overA > BAY_TOL) return { kind: 'lot', ok: false, lot: L, bay: b, n, why: 'lines' };
      return { kind: 'bay', ok: true, lot: L, bay: b, n };
    }
    // in front of a car park's entrance (its centre or either end): blocking the way in
    for (const L of lots) {
      if (!Number.isFinite(L.ex) || !Number.isFinite(L.dirx)) continue;
      for (const k of [0, 0.8, -0.8]) {
        const px = x + fx * hl * k - L.ex, pz = z + fz * hl * k - L.ez;
        const out = px * L.dirx + pz * L.dirz + 2, lat = Math.abs(px * L.dirz - pz * L.dirx); // (out: from the car park's edge)
        if (out > -0.3 && out < MOUTH.out && lat < MOUTH.lat) return { kind: 'mouth', ok: false, lot: L };
      }
    }
    for (const lb of busRoads.laybys || []) { const lx = Math.sin(lb.yaw), lz = Math.cos(lb.yaw), dx = x - lb.x, dz = z - lb.z; if (Math.abs(dx * lx + dz * lz) < 11 && Math.abs(dx * lz - dz * lx) < 3.5) return { kind: 'layby', ok: true }; }
    // a building's forecourt (the Autohaus yard, the medical centre, the police station): fine unless its centre is on a lane
    const lane = busRoads.roads.length ? laneDistance(x, z) : Infinity;
    for (const L of busRoads.lots) {
      if (!L.building || L.ux === undefined || L.hold) continue;
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx * L.ux + dz * L.uz) < L.hw && Math.abs(dx * L.vx + dz * L.vz) < L.hd && lane > ROAD_HALF - 0.5) return { kind: 'yard', ok: true, lot: L };
    }
    if (busRoads.roads.length) {
      const h = hl - 0.4;
      for (const k of [0, 1, -1]) if ((k ? laneDistance(x + fx * h * k, z + fz * h * k) : lane) < ROAD_HALF + 0.2) return { kind: 'road', ok: false };
    }
    // (Oct 30, the user: "if you park it somewhere not on a road or parking lot, put a countdown that it will despawn in
    // 30 sec": out on the snow it is moved to the Autohaus car park (snowSpot); the chalet village's drives and private
    // bays still count)
    if (inChaletSite(x, z)) return { kind: 'free', ok: true };
    return { kind: 'snow', ok: false };
  }
  spotOf(e) { const g = e.car; return this.where(g.position.x, g.position.z, g.rotation.y, e.length || 4.6); }
  // (the old names: properly parked / left where it gets towed)
  parked(e) { return this.spotOf(e).ok; }
  blocking(e) { return !this.spotOf(e).ok; }

  // ------------------------------------------------------------------ per frame (carrental.js update)
  update(dt) {
    if (!(dt > 0)) return;
    const R = this.R, e = R.current;
    this.yardHud();
    for (const k of R.kept || []) if (k.impound && this.released(k.impound)) { // (another car of yours, left in the tow yard: free again, out of the tow yard's bay into a free one)
      k.impound = null;
      if (this.save.impound?.plate === (k.cfg?.plate || null)) { this.save.impound = null; R.writeSave?.(); }
      if (!k.driving && !k.towing) { const b = this.freeBayOf(true); if (b) { this.place(k, b); if (R.drive) R.drive._cc = null; } }
      if (!k.arrivedSaid) R.hud?.flash(`Your ${R.label?.(k.cfg?.id) || 'car'} is back in your bay by the Autohaus`, 'good', 4000); // (Oct 31 2026: as the car out says it; not again after the card's "has arrived")
      k.arrivedSaid = false;
    }
    if (!e) { this.parkHud(null); return; }
    if (e.impound && this.released(e.impound)) { // (its 3 minutes are up: back in your bay)
      e.impound = null;
      if (this.save.impound) { this.save.impound = null; R.writeSave?.(); }
      if (!e.driving && !e.towing) { const b = this.freeBayOf(); if (b) { this.place(e, b); if (R.drive) R.drive._cc = null; } } // (no bay free: it stays where it is, never into a bay a car stands in)
      if (!e.arrivedSaid) R.hud?.flash(`Your ${R.label?.(e.cfg?.id) || 'car'} is back in your bay by the Autohaus`, 'good', 4000);
      e.arrivedSaid = false;
    }
    if (e.wrecked || e.towing || e.impound || !R.player) { e.abandonT = 0; this.parkHud(null); return; }
    if (e.driving) { e.abandonT = 0; e.warned = false; e.warned2 = false; e.drove = true; e.spot = null; this.driveHint(e, dt); return; }
    this.clk = (this.clk || 0) + dt;
    // just got out (Oct 30, the user: "indicate to them if they are parked properly, and if it is not parked properly
    // also indicate it to them"): where it stands, at once
    if (e.drove) { e.drove = false; e.outAt = this.clk; this.t = 0; }
    this.t -= dt;
    if (this.t > 0) return;
    const step = Math.min(1, 0.5 - this.t); // (s since the last check)
    this.t = 0.5;
    const p = R.player.pos, d = Math.hypot(p.x - e.car.position.x, p.z - e.car.position.z);
    const sp = e.spot = this.spotOf(e);
    // out on the snow, off every road and car park: 30 s from getting out, then it's moved to a free bay of the Autohaus
    // car park (no truck, no fee). (Oct 30 2026, the user: "no, not return to bay, just return to parking lot or road",
    // then "if it is despawned because it is off-road, spawn it next to the dealership lot": any free bay there, not
    // only your own; snowSpot)
    if (sp.kind === 'snow') {
      e.abandonT = (e.abandonT || 0) + step;
      if (e.abandonT >= TOW_AFTER) {
        e.abandonT = 0; this.parkHud(null);
        const to = this.snowSpot(e);
        if (to) {
          this.place(e, to.b); // (upright, along the bay, nose out; multiplayer: net/carride.js sends the new parked spot, as for any place())
          if (R.drive) R.drive._cc = null;
          e.spot = null;
          // (Oct 30, the user: "indicate to the user why and where it is moved if it doesn't move to the dealership lot")
          const car = R.label?.(e.cfg?.id) || 'car';
          R.hud?.flash(to.full ? `The Autohaus car park is full · your ${car} was moved to the nearest car park: ${to.L?.name || 'car park'}` : `Your ${car} was moved to the Autohaus car park`, 'good', 5000);
        } else R.hud?.flash('Every car park is full · your car stays where it is', 'bad', 4000);
        return;
      }
      this.parkHud(this.parkText(e, sp, d));
      return;
    }
    // a lay-by, a forecourt, the chalet village or properly in a bay: fine, it stays where it is
    if (sp.ok || !R.truck || !busRoads.roads.length) {
      e.abandonT = 0; e.warned = false; e.warned2 = false;
      this.parkHud(e.outAt != null && this.clk - e.outAt < 7 ? this.parkText(e, sp, d) : null);
      return;
    }
    // on a road, or blocking a car park: the warnings, then the tow truck
    const what = sp.kind === 'road' ? 'blocking the road' : sp.kind === 'mouth' ? 'blocking the car park entrance' : 'not parked in a bay';
    // (Oct 30, the user: "make sure the countdown for the tow truck starts immediately once you get out of the car, not
    // once you are far enough": it runs from the moment you're out, near the car or not; only driving it again, or
    // parking it properly, stops it)
    // (Oct 30, the user: "don't show this message at the top in the middle, since you already have it in the bottom
    // left": no banner, the parking card says it; the last warning is only its sound)
    e.abandonT = (e.abandonT || 0) + step;
    if (e.abandonT >= WARN2_AFTER && !e.warned2) { e.warned2 = true; R.audio?.play?.('error'); }
    if (e.abandonT >= TOW_AFTER) { e.warned2 = false; this.parkHud(null); this.tow(e, what); return; }
    // the card: the countdown running, from the moment you're out
    this.parkHud(this.parkText(e, sp, d));
  }

  /** The bay a car left out on the snow is moved to (Oct 30 2026, the user: "if it is despawned because it is off-road,
   *  spawn it next to the dealership lot"): the first free bay of the Autohaus car park (nearest the hall's door, the
   *  tow yard's bays aside), one where() rates a proper 'bay' for this car, its whole length clear of cars (parked,
   *  yours, traffic: drive.js clearAt, as unstuckSpot; other players': their records, carNear). Full: freeBayOf(), then
   *  the nearest free bay in another car park. { b: the bay, L: its car park }, or null: none anywhere (it stays where it is). */
  snowSpot(e) {
    const R = this.R, g = e?.car, len = e?.length || 4.6, mp = isMP() ? R.mp || {} : null, D = R.drive;
    if (!g) return null;
    const r = CAR_HW + 0.1, k = Math.max(0, len / 2 - r), cars = R.parking?.cars || [];
    const yawOf = (b) => Math.atan2(b.hx, b.hz); // (as pose(): backed in, nose out to the aisle)
    const fits = (b) => {
      if (this.pound?.includes(b)) return false; // (never into the tow yard's bays)
      const yaw = yawOf(b);
      if (this.where(b.x, b.z, yaw, len).kind !== 'bay') return false;
      if (mp?.carNear?.(b.x, b.z, 2.5)) return false;
      if (cars.some((c) => c !== e && !c.driving && c.car?.parent && Math.hypot(c.car.position.x - b.x, c.car.position.z - b.z) < 2.5)) return false;
      if (!D?.clearAt) return true;
      const ax = Math.sin(yaw), az = Math.cos(yaw);
      for (const t of [k, 0, -k]) if (!D.clearAt(b.x + ax * t, b.z + az * t, r, e)) return false;
      return true;
    };
    // the Autohaus car park first (autohaus.js plans it beside the hall; build() sorted its bays by the door)
    const own = (this.byDoor || []).find(fits);
    if (own) return { b: own, L: this.lot };
    const fb = this.freeBayOf(); // (single player: an other people's car may leave its bay for yours)
    if (fb) return { b: fb, L: this.lot };
    // the Autohaus car park full: the free bay nearest the AUTOHAUS car park (Oct 30, the user: "it should go to the
    // nearest lot next to the car dealer lot, not to the person"), never nearest where the car or you stand
    const A = this.byDoor?.[0] || this.lot?.bays?.[0] || g.position, x = A.x, z = A.z, cands = [];
    for (const L of this.bayLots()) if (L !== this.lot) for (const b of L.bays) cands.push({ b, L, d2: (b.x - x) ** 2 + (b.z - z) ** 2, full: true });
    cands.sort((a, b) => a.d2 - b.d2);
    for (const c of cands) if (fits(c.b)) return c;
    return null;
  }

  // the card's words for where it stands: [good, head, sub]
  parkText(e, sp, d = 0) {
    // (Oct 30, the user: "don't say bay (number), in which bay, just say pull into bay": no bay numbers on the card)
    const name = sp.lot?.name || 'car park';
    const left = `it will be towed in ${clock(TOW_AFTER - (e.abandonT || 0))}`;
    switch (sp.kind) {
      case 'bay': return [true, '✓ Parked properly', name];
      case 'lot': return [false, sp.why === 'angle' ? '✗ Crooked in the bay' : sp.why === 'lines' ? '✗ Over the lines' : '✗ Not in a bay',
        `${sp.why === 'angle' ? 'Straighten up inside the lines' : 'Park inside the lines'} or ${left}`];
      case 'mouth': return [false, '✗ Blocking the car park entrance', `Park in a bay or ${left}`];
      case 'road': return [false, '✗ On the road', `It will be towed in ${clock(TOW_AFTER - (e.abandonT || 0))}`];
      case 'snow': return [false, '✗ Not on a road or in a car park', `It will be moved to the Autohaus car park in ${clock(TOW_AFTER - (e.abandonT || 0))}`];
      case 'layby': return [true, '✓ Parked in the lay-by', 'Fine here'];
      case 'yard': return [true, `✓ Parked · ${sp.lot?.name || 'forecourt'}`, 'Fine here'];
      default: return [true, '✓ Parked off the road', 'Fine here'];
    }
  }

  // While you drive slowly in a car park (or stop across its entrance): live, so you can correct it before you get out
  driveHint(e, dt) {
    this.hintT = (this.hintT || 0) - dt;
    if (this.hintT > 0) return;
    this.hintT = 0.15;
    const D = this.R.drive?.d;
    if (!D || D.e !== e) { this.parkHud(null); return; }
    const v = Math.hypot(D.vx || 0, D.vz || 0), sp = v < 4 ? this.where(D.x, D.z, D.yaw, e.length || 4.6) : null;
    let t = null;
    if (sp?.kind === 'bay') t = [true, 'In the bay ✓', `Parked properly · ${sp.lot?.name || 'car park'} · E to get out`];
    else if (sp?.kind === 'lot') {
      t = sp.why === 'angle' ? [false, 'Not in a bay — straighten up', 'Pull into the bay, straight inside the lines']
        : sp.why === 'lines' ? [false, 'Not in a bay — over the lines', 'Pull into the bay, inside the lines']
        : [false, 'Not in a bay', 'Pull into a free bay, inside the lines'];
    } else if (sp?.kind === 'mouth' && v < 1) t = [false, 'Blocking the entrance', 'Drive in and park in a bay'];
    else if (sp?.kind === 'snow' && v < 1) t = [false, 'Not a parking spot', 'Park in a car park']; // (Oct 30, the user: "and indicate it to the user"; Oct 31 2026: "only say park in a car park")
    this.parkHud(t, true);
  }

  // The parking card (bottom left, the tow yard card's place and style): green when it is fine, red when it gets towed
  parkHud(t, driving = false) {
    if (!t && !this.pkEl) return;
    if (!this.pkEl) {
      if (typeof document === 'undefined') return;
      if (!document.getElementById('tow-yard-css')) { const st = document.createElement('style'); st.id = 'tow-yard-css'; st.textContent = YARD_CSS; document.head.appendChild(st); }
      const el = document.createElement('div');
      el.id = 'park-card'; el.hidden = true;
      el.innerHTML = '<div class="pk-head"></div><div class="pk-sub"></div>';
      (document.getElementById('hud') || document.body).appendChild(el);
      this.pkEl = el; this.$pkHead = el.querySelector('.pk-head'); this.$pkSub = el.querySelector('.pk-sub'); this.pkC = {};
    }
    const C = this.pkC;
    if (!t) { if (!this.pkEl.hidden) this.pkEl.hidden = true; return; }
    const [good, head, sub] = t, cls = good ? 'good' : 'bad';
    if (C.cls !== cls) { this.pkEl.classList.remove('good', 'bad'); this.pkEl.classList.add(cls); C.cls = cls; }
    if (C.head !== head) this.$pkHead.textContent = C.head = head;
    if (C.sub !== sub) this.$pkSub.textContent = C.sub = sub;
    if (this.pkEl.hidden) {
      this.pkEl.hidden = false;
      if (driving) document.querySelector('#drive-hud .ch-card')?.classList.add('out'); // (the controls card shares the corner: it fades out)
    }
  }

  // The tow yard card (Oct 30, the user: "while your car is in the tow yard, show the whole time how long until you get
  // it back, bottom left; it only goes once you have your car back"): bottom left above the money (with the WANTED box
  // up: under the place name, top left), the brush style of the other HUD cards; built once, text changed only when it
  // changes.
  // (Oct 31 2026, the user: "If one of your other cars is in the tow yard, the countdown card isn't shown for it. It only
  // shows for the car you have out. Fix this.": every car of yours in the tow yard or on the truck's bed, the car out
  // and the kept ones, the one back soonest on top, a line per other one under it; "30 sec", "1 min 30 sec" (clock).
  // The parking card has the same corner: while it is up (the car out just left somewhere), this one waits.)
  yardList() {
    const R = this.R, s = this.save.impound, out = [];
    for (const e of [R.current, ...(R.kept || [])]) {
      if (!e || out.some((o) => o.e === e)) continue;
      const rec = e.impound || (e.towing && s?.plate === (e.cfg?.plate || null) ? s : null);
      if (!rec) continue;
      const left = Number.isFinite(rec.until) ? Math.max(0, Math.ceil((rec.until - nowMs()) / 1000)) : null;
      // (Oct 31 2026, the user: "once it is 0 sec, say it has arrived in the parking lot and then remove the thing on the
      // bottom left": at 0 the card lets it go, once, with that message; the release later says nothing more)
      if (left === 0) {
        if (!e.arrivedSaid) { e.arrivedSaid = true; R.hud?.flash(`Your ${R.label?.(e.cfg?.id) || 'car'} has arrived in your bay by the Autohaus`, 'good', 4500); }
        continue;
      }
      e.arrivedSaid = false;
      out.push({ e, rec, left, name: R.label?.(e.cfg?.id) || 'car' });
    }
    return out.sort((a, b) => (a.left ?? Infinity) - (b.left ?? Infinity));
  }
  yardHud() {
    const list = this.yardList();
    if (!list.length && !this.hudEl) return;
    if (!this.hudEl) {
      if (typeof document === 'undefined') return;
      if (!document.getElementById('tow-yard-css')) { const st = document.createElement('style'); st.id = 'tow-yard-css'; st.textContent = YARD_CSS; document.head.appendChild(st); }
      const el = document.createElement('div');
      el.id = 'tow-yard'; el.hidden = true;
      el.innerHTML = '<div class="ty-head">TOW YARD</div><div class="ty-t"></div><div class="ty-sub"></div><div class="ty-more"></div>';
      (document.getElementById('hud') || document.body).appendChild(el);
      this.hudEl = el; this.$t = el.querySelector('.ty-t'); this.$sub = el.querySelector('.ty-sub'); this.$head = el.querySelector('.ty-head'); this.$more = el.querySelector('.ty-more'); this.hudC = {};
    }
    const show = list.length > 0 && !(this.pkEl && !this.pkEl.hidden);
    if (this.hudEl.hidden === show) {
      this.hudEl.hidden = !show;
      if (show && this.R.current?.driving) document.querySelector('#drive-hud .ch-card')?.classList.add('out'); // (the controls card shares the corner: it fades out, as for the parking card)
    }
    if (!show) return;
    const C = this.hudC, [first, ...rest] = list, fmt = (o) => (o.left === null ? 'soon' : clock(o.left));
    const t = fmt(first);
    const head = first.e.towing ? 'BEING TOWED' : 'TOW YARD';
    const sub = `Your ${first.name} · back in your bay by the Autohaus`;
    const more = rest.map((o) => `+ ${o.name} · ${o.e.towing ? 'being towed' : fmt(o)}`).join('\n');
    if (C.t !== t) this.$t.textContent = C.t = t;
    if (C.head !== head) this.$head.textContent = C.head = head;
    if (C.sub !== sub) this.$sub.textContent = C.sub = sub;
    if (C.more !== more) this.$more.textContent = C.more = more;
  }

  // the truck fetches it (the wreck fee, now); it ends in an impound bay, locked until tomorrow
  // Multiplayer (R.mp, net/session.js): the server charges the fee and keeps the impound (its day: the world's) in your
  // profile, so it holds across reconnects; the bay is one no other player's car stands in.
  tow(e, what = 'blocking the road') {
    const R = this.R, fee = this.fee, mp = R.mp;
    e.towing = true; e.abandonT = 0;
    const free = (this.pound || []).findIndex((b) => !b.taken && !mp?.carNear?.(b.x, b.z, 2));
    const bi = Math.max(0, free);
    this.save.impound = { day: this.day, until: nowMs() + RELEASE_S * 1000, bay: bi, plate: e.cfg?.plate || null };
    if (mp?.tow) {
      const b = this.pound?.[bi], p = b && this.pose ? this.pose(b) : (R.carSpot || { x: e.car.position.x, z: e.car.position.z, yaw: 0 });
      mp.tow('tow', [p.x, world.height(p.x, p.z) + 0.03, p.z, p.yaw], bi).then((d) => {
        const day = d?.impound?.day, until = d?.impound?.until;
        if (!Number.isFinite(day)) return;
        const mine = this.save.impound?.plate === (e.cfg?.plate || null);
        if (mine) { this.save.impound.day = day; if (Number.isFinite(until)) this.save.impound.until = until; } // (the server's day / time)
        if (e.impound) { e.impound.day = day; if (Number.isFinite(until)) e.impound.until = until; }
      });
    } else {
      this.save.money -= fee;
      R.writeSave?.();
      R.hud?.setMoney?.(this.save.money, -fee);
    }
    R.audio?.play?.('cash');
    R.hud?.flash(`Your car was left ${what.replace('not parked in a bay', 'outside the bays')} · towed · -$${fee.toLocaleString('en-US')} · to the tow yard by the Autohaus · ${backIn(this.save.impound)}`, 'bad', 6500);
    const done = (car) => {
      car.towing = false;
      if (mp && R.mp === mp) mp.towDone?.(); // (multiplayer: the server's tow record ends; the impound stays)
      if (R.current !== car && !R.kept?.includes(car)) return; // (gone meanwhile: sold; another car of yours out meanwhile: this one still ends in the tow yard)
      car.impound = { day: this.save.impound?.day ?? this.day, until: this.save.impound?.until };
      this.place(car, this.pound?.[bi] || this.own);
      if (R.drive) R.drive._cc = null;
    };
    if (R.truck) R.truck.fetch(e, done); else done(e);
  }
}
