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
// - Pick-up: an impounded car is locked until the next in-game day (save.day: main.js counts a day each midnight):
//   E at it says "Impounded · available tomorrow"; from then on it is yours to drive again.
// Kept in save.impound = { day, bay, plate } (the rental's plate: it ties the impound to that car).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { busRoads, laneDistance, ROAD_HALF } from './bus/roads.js';
import { lotMaterial } from './bus/bus.js';
import { railNearest } from '../world/railroute.js';
import { layout } from '../world/layout.js';
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
/** "back in 2:41" for a tow yard record (or "back soon"). */
export function backIn(rec) {
  if (!Number.isFinite(rec?.until)) return 'back soon';
  const s = Math.max(0, Math.ceil((rec.until - nowMs()) / 1000));
  return `back in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function untilTomorrow(rec) { return backIn(rec); } // (the old name, still imported)
export const STRAY_BACK = 180; // s left off the road and outside any car park / lay-by (with you away) before it goes back to its bay
export const TOW_AFTER = 30; // (Oct 29, the user: a second warning after 15 s, towed after 30 s)
export const WARN2_AFTER = 15;    // s left blocking a road with you away before the truck is called
export const AWAY_R = 40;       // m: "away" from your car
const LOT = { hw: 18, hd: 9 };  // the car park's half length (along the road) and half depth (two rows of bays)
const IMPOUND_BAYS = 4;         // bays kept free for towed cars (the back row's far end)

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
  // Beside the rental's lot along its road (either side), its front on the road's edge, else a little further in;
  // clear of the lanes, other car parks, the railway, runs and lifts, colliders and forest, on the flattest ground.
  plan() {
    const R = this.R, RL = R.L;
    if (!RL) return null;
    const fx = RL.dirx, fz = RL.dirz, ux = fz, uz = -fx; // (v: toward the road; u: along it)
    const { hw, hd } = LOT;
    const corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
    const nearLift = (x, z) => (layout.lifts || []).some((l) => {
      const ax = l.bottom.x, az = l.bottom.z, ex = l.top.x - ax, ez = l.top.z - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
      return Math.hypot(ax + ex * t - x, az + ez * t - z) < 8;
    });
    let best = null;
    const tryAt = (cu, cv, fallback = false) => {
      const cx = RL.x + ux * cu + fx * cv, cz = RL.z + uz * cu + fz * cv;
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0, bad = 0;
      for (let u = -hw - 1; u <= hw + 1; u += 3) for (let v = -hd - 1; v <= hd + 1; v += 3) {
        const x = cx + ux * u + fx * v, z = cz + uz * u + fz * v;
        if (busRoads.roads.length && laneDistance(x, z) < ROAD_HALF + 0.8) return;
        const rn = railNearest(x, z);
        if (rn && rn.d < 12) return;
        world.corridorAt(x, z, corr);
        if (corr.kind && corr.kind !== 'lift' && corr.d < 3) return; // (runs, lanes; a lift's wide corridor covers the rental too:)
        if (nearLift(x, z)) return; // (its line itself)
        const h = world.height(x, z);
        lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h; n++;
        const sl = Math.hypot(world.height(x + 1, z) - h, world.height(x, z + 1) - h);
        try { if (world.forest(x, z, h, sl) > 0.25) bad++; } catch { /* (no forest map) */ }
      }
      if (hi - lo > (fallback ? 6 : 3.5)) return;
      for (const L of busRoads.lots) {
        if (L === RL || !Number.isFinite(L.x)) continue;
        if (Math.hypot(L.x - cx, L.z - cz) < Math.hypot(L.hw || 0, L.hd || 0) + Math.hypot(hw, hd) + 4) return;
      }
      // colliders standing in it (buildings, lamps, signs): each one counts against the spot
      const ex = hw + 1, ez = hd + 1;
      for (const c of R.colliders) {
        if (!c || c.car || !Number.isFinite(c.x) || c.x > 1e8) continue;
        const r = c.r ?? Math.hypot(c.hw || 0, c.hd || 0), dx = c.x - cx, dz = c.z - cz;
        if (Math.abs(dx) > ex + hd + r + 20 || Math.abs(dz) > ex + hd + r + 20) continue;
        if (Math.abs(dx * ux + dz * uz) < ex + r && Math.abs(dx * fx + dz * fz) < ez + r) bad += 3;
      }
      const mean = sum / n;
      // the front's middle (the mouth) should reach the road
      const mx = cx + fx * (hd + 2), mz = cz + fz * (hd + 2), md = busRoads.roads.length ? laneDistance(mx, mz) : 0;
      const score = (hi - lo) + Math.abs(mean - RL.y) * 0.4 + bad * 2 + Math.max(0, md - ROAD_HALF - 3) * 0.6 + Math.abs(cu) * 0.02 + (fallback ? 20 : 0);
      if (!best || score < best.score) best = { cx, cz, y: mean, score, bad };
    };
    for (const side of [1, -1]) for (const du of [36, 39, 43, 48]) for (const dv of [3.4, 1, -1.5, -4]) tryAt(side * du, dv);
    if (!best || best.bad > 6) for (const du of [-12, 0, 12]) tryAt(du, -30, true); // (else behind the hall)
    if (!best) return null;
    const { cx, cz } = best;
    return {
      name: 'Autohaus car park', size: 'big', impound: true, x: cx, z: cz, y: best.y, yaw: Math.atan2(ux, uz), hw, hd, ux, uz, vx: fx, vz: fz,
      ex: cx + fx * (hd + 2), ez: cz + fz * (hd + 2), dirx: fx, dirz: fz,
    };
  }

  // the car park itself (parking.js builds it like the others), the own bay, the impound bays, other people's cars
  build() {
    const R = this.R, L = this.lot, P = R.parking;
    if (!P?.build) return;
    const paint = new THREE.MeshStandardMaterial({ color: 0xeeefea, roughness: 0.92, metalness: 0, envMapIntensity: 0.15, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
    P.build(L, lotMaterial(), paint, R.models, R.colliders);
    if (!P.group.parent) R.scene.add(P.group);
    const bays = L.bays || [];
    if (!bays.length) return;
    const door = R.door || { x: R.L.x, z: R.L.z };
    const pose = (b) => ({ x: b.x, z: b.z, yaw: Math.atan2(b.hx, b.hz) }); // (backed in: nose out to the aisle)
    // your bay: the one nearest the hall's door; the impound: the far end of the back row (away from the road)
    const byDoor = bays.slice().sort((a, b) => Math.hypot(a.x - door.x, a.z - door.z) - Math.hypot(b.x - door.x, b.z - door.z));
    this.own = byDoor[0];
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

  // properly parked: in a car park, the rental's yard / lot or a lay-by
  parked(e) {
    const g = e.car, x = g.position.x, z = g.position.z;
    if (this.inLot(x, z)) return true;
    for (const L of busRoads.lots) {
      if (L.hw === undefined || L.ux === undefined) continue;
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx * L.ux + dz * L.uz) < L.hw + 0.8 && Math.abs(dx * L.vx + dz * L.vz) < L.hd + 0.8) return true; // (a car park, the rental's lot)
    }
    for (const lb of busRoads.laybys || []) { const lx = Math.sin(lb.yaw), lz = Math.cos(lb.yaw), dx = x - lb.x, dz = z - lb.z; if (Math.abs(dx * lx + dz * lz) < 11 && Math.abs(dx * lz - dz * lx) < 3.5) return true; }
    return false;
  }
  // is the car standing on a road (a lane or a junction), not in a car park, the rental's yard or a lay-by?
  blocking(e) {
    if (!busRoads.roads.length || this.parked(e)) return false;
    const g = e.car, x = g.position.x, z = g.position.z, yaw = g.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw), h = (e.length || 4.6) / 2 - 0.4;
    for (const k of [0, 1, -1]) if (laneDistance(x + fx * h * k, z + fz * h * k) < ROAD_HALF + 0.2) return true;
    return false;
  }

  // ------------------------------------------------------------------ per frame (carrental.js update)
  update(dt) {
    if (!(dt > 0)) return;
    const R = this.R, e = R.current;
    if (!e) return;
    if (e.impound && this.released(e.impound)) { // (its 3 minutes are up: back in your bay)
      e.impound = null;
      if (this.save.impound) { this.save.impound = null; R.writeSave?.(); }
      if (!e.driving && !e.towing) { this.place(e, this.own); if (R.drive) R.drive._cc = null; }
      R.hud?.flash(`Your ${R.label?.(e.cfg?.id) || 'car'} is back in your bay by the Autohaus`, 'good', 4000);
    }
    if (e.driving || e.wrecked || e.towing || e.impound || !R.truck || !R.player) { e.abandonT = 0; return; }
    this.t -= dt;
    if (this.t > 0) return;
    const step = 0.5 - this.t; // (s since the last check)
    this.t = 0.5;
    const p = R.player.pos, d = Math.hypot(p.x - e.car.position.x, p.z - e.car.position.z);
    const block = this.blocking(e);
    // left off the road and outside any car park (in the snow, on a verge): back in its bay after 3 minutes, no fee
    // (Oct 29, the user: "if you leave your car behind not on the road or a parking lot it should go back to a parking
    // lot after 3 min")
    if (!block) {
      e.abandonT = 0; e.warned = false; e.warned2 = false;
      if (d < AWAY_R || !busRoads.roads.length || this.parked(e)) { e.strayT = 0; return; }
      e.strayT = (e.strayT || 0) + step;
      if (e.strayT >= STRAY_BACK) {
        e.strayT = 0;
        this.place(e, this.own);
        if (R.drive) R.drive._cc = null;
        R.hud?.flash(`Your car was left out in the snow · it's back in your bay at the Autohaus`, 'good', 4200);
      }
      return;
    }
    e.strayT = 0;
    if (d < 15) { e.abandonT = 0; e.warned2 = false; return; } // (you came back)
    if (d > 25 && !e.warned) { e.warned = true; R.hud?.flash('Your car is blocking the road · it will be towed if you leave it there', 'bad', 3600); }
    if (d >= AWAY_R) e.abandonT = (e.abandonT || 0) + step;
    if (e.abandonT >= WARN2_AFTER && !e.warned2) { e.warned2 = true; R.hud?.flash(`Last warning · your car is still blocking the road · the tow truck comes in ${Math.round(TOW_AFTER - WARN2_AFTER)} s`, 'bad', 4200); R.audio?.play?.('error'); }
    if (e.abandonT >= TOW_AFTER) { e.warned2 = false; this.tow(e); }
  }

  // the truck fetches it (the wreck fee, now); it ends in an impound bay, locked until tomorrow
  // Multiplayer (R.mp, net/session.js): the server charges the fee and keeps the impound (its day: the world's) in your
  // profile, so it holds across reconnects; the bay is one no other player's car stands in.
  tow(e) {
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
    R.hud?.flash(`Your car was left on the road · towed · -$${fee.toLocaleString('en-US')} · to the tow yard by the Autohaus · ${backIn(this.save.impound)}`, 'bad', 6500);
    const done = (car) => {
      car.towing = false;
      if (mp && R.mp === mp) mp.towDone?.(); // (multiplayer: the server's tow record ends; the impound stays)
      if (R.current !== car) return; // (returned meanwhile: a new rental)
      car.impound = { day: this.save.impound?.day ?? this.day, until: this.save.impound?.until };
      this.place(car, this.pound?.[bi] || this.own);
      if (R.drive) R.drive._cc = null;
    };
    if (R.truck) R.truck.fetch(e, done); else done(e);
  }
}
