// Other players' vehicles (multiplayer): their rental cars (model, paint, rims, plates from the server's 'veh'
// record; parked where they left them, or moving with their presence row while they drive: steering, lights) and
// their helicopter copies (flying with their presence row: pitch and roll, the rotor turning; parked out on the
// mountain where they set it down). A parked, empty one shows its owner's name above it ("Alice's car").
// The avatars seated in them: seatFor() gives RemotePlayers (remote.js) the seat a player sits in, from the vehicle as
// drawn here, or from YOUR car (localCar) for the players riding with you (posed late, after your car moved).
// Presence while driving / flying (net/carride.js, net/heli.js): x, y, z, yaw = the vehicle's pose; a car: crouch =
// steering, flags F.car (and F.lights); a helicopter: crouch = pitch, lean = roll, F.lights = rotor at flight power.
// No allocations per frame (meshes are built once per car / helicopter, poses go into reused objects).
import * as THREE from 'three';
import { ST, F } from './protocol.js';
import { makeTag } from './remote.js';
import { CAR_MODELS, carTemplate, carInstance, driverEye } from '../game/cars.js';
import { dressCar, normConfig } from '../game/carconfig.js';
import { seatsFor, SEAT_LIFT } from '../game/carpeople.js';
import { lampsOn, Smoke, hazardPhase } from '../game/carlights.js';
import { addDent, applyDents, repairInstance, unpackDents } from '../game/cardamage.js';
import { HeliModel, ANCHORS } from '../game/heli/model.js';
import { nightUniform } from '../world/village.js';
import { buildTowTruck, beaconsOn, groundPose, bedLocal, TOW_HALF } from '../game/towtruck.js';
import { buildPoliceCar, policeLights, policeGround, policeModelReady } from '../game/police.js';
import { Ambulance } from '../game/heli/ambulance.js';
import { SLED, SEAT as SLED_SEAT } from '../game/snowmobile.js';
import { fitModel } from '../core/assets.js';
import { world } from '../world/world.js';
import { busRoads } from '../game/bus/roads.js';

const LEN = Object.fromEntries(CAR_MODELS);
const VEH_FAR = 1800;   // m: vehicles beyond are not drawn
const POLICE_CALM_V = 3; // m/s: a patrol car slower than this only nudges you (w.calm: game/vehiclehits.js; police.js harmless)
const TAG_FAR = 130;    // m: owner tags hidden beyond
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _d = new THREE.Vector3();
const SEATS = new WeakMap();
const _b = new THREE.Vector3();
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
const TRANSIT = new Set(['train', 'express', 'gondola', 'chair', 'bus']); // (shared transport: net/transit.js)
const PASSENGER = new THREE.Vector3(-ANCHORS.seat.x, ANCHORS.seat.y, ANCHORS.seat.z); // (the rescue's cabin seat: rescue.js)
const _door = new THREE.Vector3();

/** The seat points of a car template in the car's frame (+x the driver's side, +z forward): 0 the driver, 1 the front
 *  passenger, 2.. the back (outboard behind the driver, behind the passenger, the middle): 5 in a five-seater, 2 in a two-seater.
 *  A seat point is where a seated rig's seat goes (its hip 0.1 m above), as drive.js seats you (carpeople.js SEATS). */
export function carSeats(t) {
  if (!t) return null;
  let out = SEATS.get(t);
  if (out) return out;
  out = [];
  const S = seatsFor(t);
  // (carpeople.js hipAt for a hip 0.1 m over the seat point, minus that 0.1 m; SEAT_LIFT: on the cushion, not sunk 8 cm
  // into it, Oct 31 2026, the user: "you still don't sit properly on a chair")
  const pt = (x, s) => new THREE.Vector3(x, s[0] - 0.01 + SEAT_LIFT, s[1] + s[2] * (0.1 - 0.15) + 0.13);
  if (S) {
    const front = S.d.slice(1);
    out.push(pt(S.d[0], front), pt(-S.d[0], S.p || front));
    if (S.r) {
      const r = S.r.slice(1);
      out.push(pt(S.r[0], r), pt(-S.r[0], r), pt(0, r));
    }
  } else { // (no seat hints: by the driver's eye, as carpeople.js fillByEye)
    const E = driverEye(t), y = E.y - 0.78, z = E.z - 0.04;
    out.push(new THREE.Vector3(E.x, y, z), new THREE.Vector3(-E.x, y, z), new THREE.Vector3(E.x, y - 0.04, z - 0.86), new THREE.Vector3(-E.x, y - 0.04, z - 0.86));
  }
  SEATS.set(t, out);
  return out;
}

/** A car template for a model id (cars.js caches it per glTF), or null while the model is missing. */
export function carTemplateFor(models, id) {
  const gltf = models?.[id];
  return gltf && LEN[id] ? carTemplate(gltf, LEN[id], id) : null;
}

/** Remote r's `kind:owner:seat` vehicle string parsed once into r.vehK / r.vehOwner / r.vehSeat. */
export function parseVeh(r) {
  if (r.vehStr === r.veh) return;
  r.vehStr = r.veh;
  if (typeof r.veh !== 'string') { r.vehK = ''; r.vehOwner = ''; r.vehSeat = -1; return; }
  const a = r.veh.indexOf(':'), b = r.veh.lastIndexOf(':');
  r.vehK = r.veh.slice(0, a); r.vehOwner = r.veh.slice(a + 1, b); r.vehSeat = Number(r.veh.slice(b + 1)) | 0;
}

/** The world point of seat `seat` of a car (its group, template): into out. */
export function seatWorld(group, t, seat, out) {
  const list = carSeats(t);
  if (!list?.length) return false;
  out.copy(list[Math.max(0, Math.min(seat, list.length - 1))]);
  group.localToWorld(out);
  return true;
}

function tagScale(tag, d) {
  const on = d < TAG_FAR;
  if (tag.visible !== on) tag.visible = on;
  if (on) { const k = tag.userData.base * 0.85 * Math.max(0.6, Math.min(1, 1.15 - d / 220)); tag.scale.set(k * (512 / 96), k, 1); }
}

export class RemoteVehicles {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {() => object} o.models               the loaded glTFs (cars, heli_body)
   * @param {() => {group, t, yaw}|null} [o.localCar]  your own car (driving or parked) for the players riding with you
   * @param {() => string} o.selfName
   */
  constructor(o) {
    this.o = o;
    this.cars = new Map();  // pid -> { key, t, inst, group, tag, x, y, z, yaw, steer, u, lit, posed, driven }
    this.helis = new Map(); // pid -> { model, tag, yaw, rpm, shown }
    this.tows = new Map();  // pid -> their tow truck out on a job: { g, beacons, beaconMat, beaconLight, col, x, z, yaw, posed, shown }
    this.police = new Map(); // pid -> the patrol cars chasing them: [{ m, col, x, z, yaw, tx, tz, tyaw, tv, age, posed, shown }]
    this.rescues = new Map(); // pid -> the rescue coming for them: { model, rope, amb, ...poses } (updateRescue)
    this.sleds = new Map();   // pid -> the snowmobile they drive / left parked: { g, tag, x, y, z, yaw, pitch, roll, posed, shown } (updateSled)
    this.remotes = null;
    this.time = 0;
  }

  // a moving collider of its own for a drawn vehicle (in the shared list; parked far away at 1e9 while not shown):
  // the other players' helicopters standing somewhere, their snowmobiles, the rescue's helicopter on the ground and
  // its ambulance (Oct 30, the user: "everything should be collidable also moving objects")
  solid(w, key, shape) {
    if (!w[key]) { w[key] = { x: 1e9, z: 1e9, rot: 0, mp: true, soft: true, ...shape }; this.o.colliders?.push(w[key]); }
    return w[key];
  }
  unsolid(w, key) {
    const c = w?.[key];
    if (!c) return;
    const L = this.o.colliders, i = L ? L.indexOf(c) : -1;
    if (i >= 0) L.splice(i, 1);
    w[key] = null;
  }
  static place(c, on, x, z, yaw = 0) { c.x = on ? x : 1e9; c.z = on ? z : 1e9; c.rot = -yaw; }

  /** Every frame, before the avatars (RemotePlayers.update). */
  update(dt, remotes, v) {
    this.remotes = remotes;
    this.time += dt;
    const cam = v.camera.position, outdoors = !v.interior;
    for (const r of remotes.players.values()) {
      if (!r.ok) continue;
      this.updateTow(r, dt, cam, outdoors); // (first: their car may ride on its bed)
      this.updatePolice(r, dt, cam, outdoors);
      this.updateRescue(r, dt, cam, outdoors);
      this.updateCar(r, dt, cam, outdoors);
      this.updateHeli(r, dt, cam, outdoors);
      this.updateSled(r, dt, cam, outdoors);
    }
  }

  // ---------------------------------------------------------------- cars
  makeCar(r, cfg, key) {
    const t = carTemplateFor(this.o.models(), cfg.id);
    if (!t) return null;
    let inst;
    try { inst = dressCar(carInstance(t, { wheels: true }), t, normConfig(cfg)); } catch (e) { console.warn('[mp] car', e); return null; }
    const group = inst.group;
    group.name = `mp-car-${r.name}`;
    group.visible = false;
    const tag = makeTag(`${r.name}'s car`, '#0f2f6b');
    tag.position.set(0, (t.size?.y || 1.5) + 0.55, 0);
    group.add(tag);
    this.o.scene.add(group);
    // solid like any parked or traffic car (a box collider in the shared list: you can't walk or drive through it); parked
    // far away while it isn't placed
    const col = { x: 1e9, z: 1e9, hw: (t.size?.x || 1.9) / 2, hd: (t.size?.z || 4.6) / 2, rot: 0, h: 1.7, car: true, mp: true };
    this.o.colliders?.push(col);
    const c = { pid: r.pid, key, t, inst, group, tag, col, x: 0, y: 0, z: 0, yaw: 0, steer: 0, u: 0, lit: -1, posed: false, driven: false, atRef: null };
    this.cars.set(r.pid, c);
    return c;
  }
  // a wrecked car (F.wreck while it crashes, veh wreck while it lies there and rides the tow truck): dented, steam
  // from the bonnet; repaired once the record says it is whole again
  wreckLook(c, dt, show) {
    if (c.wreck && !c.dented) {
      c.dented = true;
      try { repairInstance(c.inst); const e = { dents: [] }; addDent(e, 0, 1, 1, c.t.size); addDent(e, 0.8, 0.5, 0.7, c.t.size); applyDents(c.inst, e); } catch { /* (no dents on this model) */ }
    } else if (!c.wreck && c.dented) {
      c.dented = false;
      try { repairInstance(c.inst); } catch { /* (as it was) */ }
      c.dentSig = null; this.carDents(c); // (its own kept dents back, if any)
    }
    if (c.wreck && show) {
      try {
        c.smoke ||= new Smoke(this.o.scene);
        const b = _b.set(0, c.t.size.y * 0.78, c.t.size.z / 2 - 0.8); c.group.localToWorld(b);
        c.smoke.update(dt, b, this.o.camera?.() || null, nightUniform.value, _d.set(0, 0, 1).applyQuaternion(c.group.quaternion));
      } catch { c.smoke = c.smoke || null; }
    } else if (c.smoke) c.smoke.clear?.();
  }
  // the dents the owner's car keeps (cfg.dents: their crashes, kept until it is repaired: carrental.js carDamage), on
  // this copy of it; again only when the record's dents change (a repair takes them all out)
  carDents(c) {
    const L = c.cfg?.dents, sig = Array.isArray(L) && L.length ? `${L.length}|${L.map((a) => a?.[5]).join(',')}` : '';
    if (sig === c.dentSig) return;
    const had = !!c.dentSig;
    c.dentSig = sig;
    if (c.dented) return; // (a wreck: its wreck look until it is whole again: wreckLook)
    try {
      if (had) repairInstance(c.inst);
      if (sig) applyDents(c.inst, { dents: unpackDents(L) });
    } catch { /* (no dents on this model) */ }
  }
  dropCar(pid) {
    const c = this.cars.get(pid);
    if (!c) return;
    if (c.smoke) { c.smoke.clear?.(); c.smoke.mesh?.removeFromParent(); }
    c.group.removeFromParent();
    c.tag.material.map.dispose(); c.tag.material.dispose();
    const L = this.o.colliders, i = L ? L.indexOf(c.col) : -1;
    if (i >= 0) L.splice(i, 1);
    this.cars.delete(pid);
  }
  updateCar(r, dt, cam, outdoors) {
    const vc = r.vcar;
    let c = this.cars.get(r.pid);
    if (!vc?.cfg) { if (c) this.dropCar(r.pid); return; }
    const cfg = vc.cfg;
    if (!c || c.cfg !== cfg) {
      const key = `${cfg.id}|${cfg.paint}|${cfg.interior}|${cfg.rims}|${cfg.plate}`; // (only when the record changes)
      if (!c || c.key !== key) { const old = c; if (old) this.dropCar(r.pid); c = this.makeCar(r, cfg, key); if (!c) return; if (old?.posed) { c.x = old.x; c.y = old.y; c.z = old.z; c.yaw = old.yaw; c.posed = true; } }
      c.cfg = cfg;
      this.carDents(c);
    }
    const driving = r.state === ST.drive && !!(r.flags & F.car);
    c.driven = driving;
    if (driving) {
      // (crashing, F.wreck: rolling over, lean = its roll; x/y/z is the car's origin as it lies, so the same roll here
      // puts it where it is on their screen, not upright in the air with the driver floating in it)
      c.x = r.pos.x; c.y = r.pos.y; c.z = r.pos.z; c.yaw = r.yaw; c.steer = r.crouch; c.pitch = 0; c.roll = r.lean || 0;
      c.wreck = !!(r.flags & F.wreck);
      c.u = r.vel.x * Math.sin(r.yaw) + r.vel.z * Math.cos(r.yaw);
      c.posed = true;
    } else {
      c.u = 0; c.steer *= Math.exp(-dt * 3);
      if (vc.at && c.atRef !== vc.at) {
        c.atRef = vc.at; c.x = vc.at[0]; c.y = vc.at[1]; c.z = vc.at[2]; c.yaw = vc.at[3]; c.posed = true;
        c.pitch = vc.tilt?.[0] || 0; c.roll = vc.tilt?.[1] || 0; c.wreck = !!vc.wreck; // (a wreck as it lies: on its side, its roof)
        c.atT = this.time; c.bay = null; c.unT = 0; // (when it parked there: the later of two in one spot moves, unstack)
      }
    }
    // (on their tow truck's bed: it rides with the truck, not where it lay)
    const towing = !driving && !!r.vtow?.car;
    const bed = towing ? this.tows.get(r.pid) : null;
    if (bed?.posed) { bedLocal(LEN[cfg.id], _b).applyMatrix4(bed.g.matrixWorld); c.x = _b.x; c.y = _b.y; c.z = _b.z; c.yaw = bed.yaw; c.posed = true; }
    // (Oct 30 2026, the user: "why are my cars being shown in the parking lot when the tow truck is towing": with the
    // truck, the car is on its bed or nowhere: not left standing where it was parked (its 'at') while the truck's pose
    // is not in yet, and not standing where the bed was once the truck is done, until its new spot ('at') comes in;
    // never moved into a free bay meanwhile (unstack), nor holding one for another car)
    if (towing) c.bedAt = vc.at || null;
    else if (driving || (vc.at && vc.at !== c.bedAt)) c.bedAt = undefined;
    const away = !driving && (towing ? !bed?.posed : c.bedAt !== undefined);
    c.towed = towing || away;
    if (!driving && vc.at && !vc.wreck && !c.towed) this.unstack(c, vc.at, dt);
    const g = c.group;
    const d = c.posed ? _d.set(c.x, c.y, c.z).sub(cam).length() : Infinity;
    const show = outdoors && c.posed && d < VEH_FAR && !away;
    if (g.visible !== show) g.visible = show;
    // (not while you ride in it: you sit inside its box)
    // (nor while it stands where your own car is: every player's car starts in the same bay by the Autohaus, and their
    // car's box over yours walled yours in; it is solid again once yours has left it)
    // (latched: from overlapping (< 2 m apart) until the two are 5.5 m apart, so a car you drive up to stays solid)
    // (Oct 30 2026, the user: "make sure cars don't stack on the parking lot": a car parked in your car's spot is now
    // drawn in the nearest free bay of that lot (unstack) and solid there; the latch is left for a spot with no lot)
    const mp = !driving && c.posed ? this.o.localCar?.()?.group?.position : null, dm = mp ? Math.hypot(mp.x - c.x, mp.z - c.z) : Infinity;
    if (dm < 2) c.ghost = true; else if (dm > 5.5) c.ghost = false;
    // (Oct 30 2026, the user: "there are still some invisible things at the parking lot": solid only while it is drawn,
    // exactly where it is drawn (unstack's bay too); never a box where no car shows)
    const solid = show && this.o.ridingPid?.() !== r.pid && !bed?.posed && !c.ghost;
    c.col.x = solid ? c.x : 1e9; c.col.z = solid ? c.z : 1e9; c.col.rot = -c.yaw;
    if (!c.posed) return;
    if (bed?.posed) {
      g.position.set(c.x, c.y, c.z);
      g.quaternion.copy(bed.g.quaternion); // (pitched and rolled with the truck)
    } else {
      this.settleCar(c, dt, driving);
      g.position.set(c.x, c.dy, c.z);
      _e.set(c.dp, c.yaw, c.dr, 'YXZ');
      g.quaternion.setFromEuler(_e);
    }
    g.updateMatrixWorld(true); // (the seats are read from it this frame)
    if (!show) return;
    for (const w of c.inst.wheels) {
      if (w.front) w.steer.rotation.y = c.steer;
      if (c.u) w.roll.rotation.x = (w.roll.rotation.x + (c.u * dt) / (w.r || 0.34)) % (Math.PI * 2);
    }
    if (c.inst.steering) c.inst.steering.col.quaternion.setFromAxisAngle(c.inst.steering.axis, -c.steer * 3);
    this.wreckLook(c, dt, show);
    const lit = c.wreck ? -1 : driving ? ((r.flags & F.lights) || nightUniform.value > 0.2 ? 2 : 1) : 0;
    if (lit === -1) { c.lit = -1; try { lampsOn(c.inst, nightUniform.value > 0.2 ? 1 : 0, 0.55, 0, { hazard: hazardPhase() }); } catch { /* (no lamps) */ } } // (a wreck: hazards, dim tails)
    else if (lit !== c.lit) { c.lit = lit; try { lampsOn(c.inst, lit === 2 ? 1 : 0, lit === 2 ? 1 : 0, 0, { drl: lit === 1 ? 1 : 0 }); } catch { /* (no lamps) */ } }
    // the owner's name over it while nobody drives it (Oct 29, the user: "everything you own has your name above if
    // you are not in it")
    tagScale(c.tag, d); // (driven or parked: "<name>'s car" over it; their own name tag hides while they sit in it, remote.js)
  }

  // Two cars in one spot (Oct 30 2026, the user: "make sure cars don't stack on the parking lot"): every player's car
  // could come back in the same bay (the first Autohaus bay: each joined before the other's car was known), drawn one
  // inside the other. On this screen only: a parked car whose spot (< 2.5 m) is held by one there before it (your own
  // cars, the parked other people's cars, another player's car that parked there earlier: atT) is drawn in the nearest
  // free bay of that lot (parking.js lotBays: L.bays, the Autohaus car park's too; never the tow yard's), solid there;
  // back in its own spot once that is free. Checked twice a second. No lot there (a lay-by, the road): left as it is
  // (the ghost latch, updateCar). Only the drawing moves: the record, carNear / spotFree, are the owner's real spot.
  unstack(c, at, dt) {
    if ((c.unT -= dt) > 0) return;
    c.unT = 0.5;
    const R = window.__game?.carRental, pound = R?.impound?.pound || [], NEAR = 2.5;
    const mine = (R?.parking?.cars || []).filter((e) => !e.driving && e.car?.parent && !R.aboard?.(e)); // (not yours on a tow truck's bed: Oct 30 2026)
    const held = (x, z, earlier) => {
      for (const e of mine) if (Math.hypot(e.car.position.x - x, e.car.position.z - z) < NEAR) return true; // (yours, or a parked car here)
      for (const o of this.cars.values()) {
        if (o === c || !o.posed || o.driven || o.towed) continue; // (with their tow truck: in no bay)
        if (earlier && !(o.atT < c.atT || (o.atT === c.atT && o.pid < c.pid))) continue;
        if (Math.hypot(o.x - x, o.z - z) < NEAR) return true;
      }
      return false;
    };
    const home = () => { if (c.bay) { c.bay = null; c.x = at[0]; c.z = at[2]; c.yaw = at[3]; c.setT = 0; } };
    if (!held(at[0], at[2], true)) { home(); return; }
    if (c.bay && !held(c.bay.x, c.bay.z, false)) return; // (its bay still free: stays)
    // the lot it stands in (the nearest bay within 8 m), its bays nearest first
    let lot = null, bd = 8;
    for (const L of busRoads.lots || []) for (const b of L.bays || []) { const d = Math.hypot(b.x - at[0], b.z - at[2]); if (d < bd) { bd = d; lot = L; } }
    if (!lot) { home(); return; }
    const free = lot.bays.filter((b) => !pound.includes(b)).sort((a, b) => Math.hypot(a.x - at[0], a.z - at[2]) - Math.hypot(b.x - at[0], b.z - at[2]))
      .find((b) => !held(b.x, b.z, false));
    if (!free) { home(); return; } // (the lot full: as it is, the latch)
    c.bay = free; c.x = free.x; c.z = free.z; c.yaw = Math.atan2(free.hx || 0, free.hz || 1); c.setT = 0; // (settleCar: on the ground there now)
  }

  // On the ground as it is HERE (Oct 30, the user: "for other people, in some cars it looks like the car is floating in
  // the air ... super high"): the y that came in (the owner's car origin: their presence row while they drive, the
  // parked 'at') was drawn as it was, with no pitch while driving, so anything that made it disagree with this
  // screen's ground floated the car: an 'at' sent before the car settled (only a move of 0.5 m sends a new one), a lot
  // / deck / slab one client has and the other not, a slope (no pitch sent: one end in the air). Now an upright car
  // stands on this screen's ground (groundHeight, the received y as the hint: a bridge or deck at its level counts),
  // pitched and rolled by the ground under its four wheels; the received y only for a jump (well above the ground for
  // a moment, < 1.2 s) and for a wreck lying on its side or roof (its origin up off the ground, kept within reach of it).
  // Draws into c.dy / c.dp / c.dr (c.y / c.pitch / c.roll stay what came in).
  settleCar(c, dt, driving) {
    const t = c.t, S = t.size, len = S?.z || 4.6, wb = Math.max(2.4, len * 0.6) / 2, tr = Math.max(0.5, (S?.x || 1.9) / 2 - 0.15);
    const lying = c.wreck || Math.abs(c.pitch || 0) > 0.35 || Math.abs(c.roll || 0) > 0.35;
    const first = c.dy === undefined;
    // (parked: the ground there checked twice a second, not every frame)
    if (!driving && !first && c.setRef === c.atRef && (c.setT -= dt) > 0) return;
    c.setRef = c.atRef; c.setT = 0.5;
    const yaw = c.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx, hint = c.y + 1;
    const H = (f, l) => world.groundHeight(c.x + fx * f + lx * l, c.z + fz * f + lz * l, hint);
    const hFL = H(wb, tr), hFR = H(wb, -tr), hRL = H(-wb, tr), hRR = H(-wb, -tr);
    let ground = (hFL + hFR + hRL + hRR) / 4;
    if (!Number.isFinite(ground)) ground = c.y;
    const pitchG = Math.max(-0.6, Math.min(0.6, Math.atan2((hRL + hRR) / 2 - (hFL + hFR) / 2, wb * 2)));
    const rollG = Math.max(-0.6, Math.min(0.6, Math.atan2((hFL + hRL) / 2 - (hFR + hRR) / 2, tr * 2)));
    let y, p, r;
    if (lying) {
      // (a wreck: as it lies on their screen, its origin no higher above this ground than the car is big)
      y = Math.max(ground - 0.2, Math.min(ground + Math.max(S?.x || 1.9, S?.y || 1.5) + 0.3, c.y)); p = c.pitch || 0; r = c.roll || 0;
      c.airT = 0;
    } else {
      const off = c.y - ground;
      if (driving && off > 0.6) c.airT = (c.airT || 0) + dt; else c.airT = 0;
      const jump = c.airT > 0 && c.airT < 1.2;
      y = jump ? c.y : ground + (driving ? 0.02 : 0.03);
      // (driving: the roll that came in is the body's own, ground and bend lean; the pitch from the ground here)
      p = jump ? (c.dp ?? 0) : pitchG; r = driving ? (c.roll || 0) : rollG;
    }
    if (first || !driving) { c.dy = y; c.dp = p; c.dr = r; return; }
    // (driving: eased, so a jump's landing or a kerb is a quick settle, not a step)
    const k = 1 - Math.exp(-dt * 14), kr = 1 - Math.exp(-dt * 10);
    c.dy += (y - c.dy) * k;
    if (Math.abs(y - c.dy) > 3) c.dy = y;
    c.dp += (p - c.dp) * kr; c.dr += (r - c.dr) * kr;
  }

  // ---------------------------------------------------------------- tow trucks
  // Each player's tow truck fetches only their own car (net/tow.js: its pose ~6 times a second while it is out; off
  // once parked). Drawn with the same model, beacons flashing, eased toward the last pose run on at its speed. Solid
  // to you (a box collider, mp + tow: your own truck ignores it). In the TOW bay, while your own truck stands there,
  // theirs is not drawn over it (the same truck in the same spot; their car on its bed still shows).
  updateTow(r, dt, cam, outdoors) {
    const vt = r.vtow;
    let w = this.tows.get(r.pid);
    if (!vt?.at) { if (w?.shown) this.hideTow(w); if (w) w.posed = false; return; }
    if (!w) {
      let m;
      try { m = buildTowTruck(this.o.models()); } catch (e) { console.warn('[mp] tow truck', e); return; }
      m.g.name = `mp-tow-${r.name}`;
      this.o.scene.add(m.g);
      const col = { x: 1e9, z: 1e9, hw: TOW_HALF.w, hd: TOW_HALF.l, rot: 0, h: 2.8, mp: true, tow: true };
      this.o.colliders?.push(col);
      w = { ...m, col, x: 0, z: 0, yaw: 0, ref: null, age: 0, tx: 0, tz: 0, tyaw: 0, tv: 0, posed: false, shown: true, t: 0 };
      this.tows.set(r.pid, w);
    }
    if (w.ref !== vt) {
      w.ref = vt; w.age = 0;
      w.tx = vt.at[0]; w.tz = vt.at[2]; w.tyaw = vt.at[3]; w.tv = vt.v || 0;
      if (!w.posed || Math.hypot(w.tx - w.x, w.tz - w.z) > 25) { w.x = w.tx; w.z = w.tz; w.yaw = w.tyaw; w.posed = true; }
    }
    // the last pose run on at its speed (a third of a second at most), eased into
    w.age += dt;
    const ahead = Math.min(w.age, 0.35) * w.tv, gx = w.tx + Math.sin(w.tyaw) * ahead, gz = w.tz + Math.cos(w.tyaw) * ahead;
    const k = 1 - Math.exp(-dt * 7);
    w.x += (gx - w.x) * k; w.z += (gz - w.z) * k; w.yaw = wrapPi(w.yaw + wrapPi(w.tyaw - w.yaw) * k);
    groundPose(w.g, w.x, w.z, w.yaw);
    const mine = this.o.localTow?.();
    const overMine = !!(mine && (mine.trucks || [mine]).some((t) => !t.job && Math.hypot(t.x - w.x, t.z - w.z) < 2.5)); // (one of your trucks parked right there: its TOW bay)
    const show = outdoors && !overMine && _d.set(w.x, w.g.position.y, w.z).sub(cam).length() < VEH_FAR;
    w.col.x = show ? w.x : 1e9; w.col.z = show ? w.z : 1e9; w.col.rot = -w.yaw;
    if (!show) { if (w.shown) this.hideTow(w); return; }
    if (!w.shown) { w.shown = true; w.g.visible = true; }
    beaconsOn(w, true, (w.t += dt));
  }
  hideTow(w) { w.shown = false; w.g.visible = false; w.beaconLight.intensity = 0; w.col.x = 1e9; w.col.z = 1e9; }
  dropTow(pid) {
    const w = this.tows.get(pid);
    if (!w) return;
    w.g.removeFromParent();
    const L = this.o.colliders, i = L ? L.indexOf(w.col) : -1;
    if (i >= 0) L.splice(i, 1);
    this.tows.delete(pid);
  }

  // ---------------------------------------------------------------- patrol cars
  // The police chasing another player (game/police.js: local to them, their poses ~6 times a second): drawn with the
  // same model, blue lights flashing, eased toward the last pose run on at its speed; solid to you (a box collider,
  // police: 'remote'). Their officers on foot are only drawn on their own screen.
  updatePolice(r, dt, cam, outdoors) {
    const vp = r.vpolice;
    let list = this.police.get(r.pid);
    if (!vp?.cars?.length) { if (list) for (const w of list) this.hidePolice(w); return; }
    if (!policeModelReady()) return; // (the glTF still loading)
    if (!list) { list = []; this.police.set(r.pid, list); }
    const fresh = list.ref !== vp;
    list.ref = vp;
    for (let k = 0; k < Math.max(list.length, vp.cars.length); k++) {
      const a = vp.cars[k];
      let w = list[k];
      if (!a) { if (w) this.hidePolice(w); continue; }
      if (!w) {
        let m;
        try { m = buildPoliceCar(this.o.models()); } catch (e) { console.warn('[mp] police car', e); return; }
        m.g.name = `mp-police-${r.name}-${k}`;
        this.o.scene.add(m.g);
        const col = { x: 1e9, z: 1e9, hw: m.size.x / 2 - 0.05, hd: m.size.z / 2, rot: 0, h: 1.7, mp: true, police: 'remote' };
        this.o.colliders?.push(col);
        w = list[k] = { m, col, x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0, tv: 0, age: 0, posed: false, shown: true, t: k * 0.21 };
      }
      if (fresh) {
        w.tx = a[0]; w.ty = a[1]; w.tz = a[2]; w.tyaw = a[3]; w.tv = a[4]; w.age = 0;
        if (!w.posed || Math.hypot(w.tx - w.x, w.tz - w.z) > 25) { w.x = w.tx; w.y = w.ty; w.z = w.tz; w.yaw = w.tyaw; w.posed = true; }
      }
      w.age += dt;
      const ahead = Math.min(w.age, 0.35) * w.tv, gx = w.tx + Math.sin(w.tyaw) * ahead, gz = w.tz + Math.cos(w.tyaw) * ahead;
      const e = 1 - Math.exp(-dt * 7);
      w.x += (gx - w.x) * e; w.z += (gz - w.z) * e; w.yaw = wrapPi(w.yaw + wrapPi(w.tyaw - w.yaw) * e);
      const show = outdoors && _d.set(w.x, w.ty, w.z).sub(cam).length() < VEH_FAR;
      w.col.x = show ? w.x : 1e9; w.col.z = show ? w.z : 1e9; w.col.rot = -w.yaw;
      // (Oct 30 2026, the user: police cars hit you on foot as any car, "below 35 km/h the bump animation only, from 35
      // km/h a crash", but "don't break arrests"): it can't knock you over (game/vehiclehits.js reads w.calm) under ~3
      // m/s by its own speed, or pulling up for the player it's after (within 12 m of them under ~6 m/s: stopping, an
      // officer getting out; only ever a bump that slow anyway). Its hits are measured from its motion here as every
      // remote car's.
      const tvA = Math.abs(w.tv), rp = r.pos;
      w.calm = tvA < POLICE_CALM_V || (tvA < 6 && !!rp && Math.hypot(rp.x - w.x, rp.z - w.z) < 12);
      if (!show) { if (w.shown) this.hidePolice(w); continue; }
      if (!w.shown) { w.shown = true; w.m.g.visible = true; }
      w.y = policeGround(w.m.g, w.x, w.z, w.yaw, w.ty + 2); // (its height: vehiclehits.js, a bridge / jumped over it)
      policeLights(w.m, true, (w.t += dt));
    }
  }
  hidePolice(w) { w.shown = false; w.m.g.visible = false; w.col.x = 1e9; w.col.z = 1e9; }
  dropPolice(pid) {
    const list = this.police.get(pid);
    if (!list) return;
    for (const w of list) { w.m.g.removeFromParent(); const L = this.o.colliders, i = L ? L.indexOf(w.col) : -1; if (i >= 0) L.splice(i, 1); }
    this.police.delete(pid);
  }

  // ---------------------------------------------------------------- the rescue
  // The rescue helicopter and the ambulance coming for another player after a bad wipeout (game/heli/rescue.js: local
  // to them; net/rescue.js streams 'veh' { k: 'rescue', h: [x, y, z, yaw, pitch, roll, rpm], a: [x, y, z, yaw, v],
  // s, rope, l } ~6 times a second): drawn with the same models, eased toward the last pose run on at its velocity;
  // the winch rope hanging from the door; the ambulance's lights flashing. Where the player is (s: 1 on the winch,
  // 2 in the cabin, 3 in the ambulance) seats or hides their avatar (seatFor). Not drawn over your own helicopter
  // standing on the same pad (the same helicopter in the same spot).
  updateRescue(r, dt, cam, outdoors) {
    const vr = r.vrescue;
    let w = this.rescues.get(r.pid);
    if (!vr) { if (w) this.hideRescue(w); return; }
    if (!w) {
      w = { model: null, rope: null, amb: null, ref: null, age: 0, t: 0, rpm: 0, ambT: 0,
        h: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: 0, tyaw: 0, tp: 0, tr: 0, vx: 0, vy: 0, vz: 0, at: 0, posed: false, shown: false },
        a: { x: 0, z: 0, yaw: 0, tx: 0, tz: 0, tyaw: 0, tv: 0, posed: false, shown: false } };
      this.rescues.set(r.pid, w);
    }
    const fresh = w.ref !== vr;
    if (fresh) { w.ref = vr; w.age = 0; }
    w.age += dt; w.t += dt;
    // (Oct 30 2026, the user: "make sure the heli despawns straight after the other person went on the ambulance,
    // because before, my heli landed on another heli and went through": theirs stood on the pad all through their
    // ambulance ride.) Their client now sends h: null once it has lifted off and gone (net/rescue.js); and it never
    // lingers here anyway: nothing new from them for 10 s, it all goes; their helicopter 8 s after they got into the
    // ambulance (s 3), whatever the rows still say
    if (w.age > 10) { this.hideRescue(w); w.ref = vr; return; }
    w.ambT = vr.s === 3 ? w.ambT + dt : 0;
    const heliOn = !!vr.h && w.ambT < 8;
    const e = 1 - Math.exp(-dt * 7), ahead = Math.min(w.age, 0.35);
    // the helicopter
    const H = w.h;
    if (heliOn) {
      if (!w.model) {
        try { w.model = new HeliModel(this.o.models()); } catch (err) { console.warn('[mp] rescue helicopter', err); }
        if (w.model) {
          w.model.addTo(this.o.scene);
          w.model.root.visible = false; // (H.shown false until placed: shown below; it stood unposed over your own pad helicopter)
          w.rope = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 6), new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6 }));
          w.rope.frustumCulled = false; w.rope.visible = false;
          this.o.scene.add(w.rope);
        }
      }
      if (w.model) {
        const a = vr.h;
        if (fresh) {
          // its velocity from the last two poses (the rows come ~6 times a second)
          const now = this.time, gap = now - H.at;
          if (H.posed && gap > 0.05 && gap < 1) { H.vx = (a[0] - H.tx) / gap; H.vy = (a[1] - H.ty) / gap; H.vz = (a[2] - H.tz) / gap; } else { H.vx = H.vy = H.vz = 0; }
          H.at = now;
          H.tx = a[0]; H.ty = a[1]; H.tz = a[2]; H.tyaw = a[3]; H.tp = a[4]; H.tr = a[5];
          if (!H.posed || Math.hypot(H.tx - H.x, H.tz - H.z) > 60) { H.x = H.tx; H.y = H.ty; H.z = H.tz; H.yaw = H.tyaw; H.pitch = H.tp; H.roll = H.tr; H.posed = true; }
        }
        H.x += (H.tx + H.vx * ahead - H.x) * e; H.y += (H.ty + H.vy * ahead - H.y) * e; H.z += (H.tz + H.vz * ahead - H.z) * e;
        H.yaw = wrapPi(H.yaw + wrapPi(H.tyaw - H.yaw) * e); H.pitch += (H.tp - H.pitch) * e; H.roll += (H.tr - H.roll) * e;
        const root = w.model.root;
        root.position.set(H.x, H.y, H.z);
        _e.set(H.pitch, H.yaw, H.roll, 'YXZ');
        root.quaternion.setFromEuler(_e);
        root.updateMatrixWorld(true); // (the seats are read from it this frame)
        const mine = this.o.localHeli?.();
        const overMine = !!(mine && mine.state === 'parked' && !mine.away && mine.model?.root.visible && Math.hypot(mine.flight.pos.x - H.x, mine.flight.pos.z - H.z) < 4);
        const show = outdoors && !overMine && _d.set(H.x, H.y, H.z).sub(cam).length() < VEH_FAR;
        // (solid while it stands on the snow: the cabin and the tail, as your own helicopter's, game/heli.js)
        const down = show && H.y - world.groundHeight(H.x, H.z, H.y + 1) < 1.2, fx = Math.sin(H.yaw), fz = Math.cos(H.yaw);
        RemoteVehicles.place(this.solid(w, 'cabinCol', { r: 2.1, h: 3, heli: true }), down, H.x + fx * 0.9, H.z + fz * 0.9);
        RemoteVehicles.place(this.solid(w, 'tailCol', { r: 0.7, h: 2, heli: true }), down, H.x - fx * 4.6, H.z - fz * 4.6);
        if (!show) { if (H.shown) this.hideRescueHeli(w); }
        else {
          if (!H.shown) { H.shown = true; root.visible = true; }
          w.rpm += (clamp01(a[6]) - w.rpm) * (1 - Math.exp(-dt * 1.5));
          w.model.update(dt, { rpm: w.rpm, night: nightUniform.value, time: this.time, lamp: false, camera: this.o.camera?.() || null, ground: null, snow: 0 });
          // the winch rope from the door arm down to the hook (rescue.js winch)
          const len = vr.rope || 0;
          if (len > 0.1) {
            w.model.world(ANCHORS.door, _door); _door.y += 1.0;
            w.rope.position.set(_door.x, _door.y - len / 2, _door.z); w.rope.scale.set(1, len, 1);
            if (!w.rope.visible) w.rope.visible = true;
          } else if (w.rope.visible) w.rope.visible = false;
        }
      }
    } else if (H.shown) this.hideRescueHeli(w);
    if (!heliOn) { H.posed = false; if (w.cabinCol) { RemoteVehicles.place(w.cabinCol, false); RemoteVehicles.place(w.tailCol, false); } }
    // the ambulance
    const A = w.a;
    if (vr.a) {
      if (!w.amb) { try { w.amb = new Ambulance({ scene: this.o.scene, models: this.o.models() || {}, world, colliders: this.o.colliders }); } catch (err) { console.warn('[mp] ambulance', err); w.amb = { ok: false }; } }
      const amb = w.amb;
      if (amb.ok) {
        const a = vr.a;
        if (fresh) {
          A.tx = a[0]; A.tz = a[2]; A.tyaw = a[3]; A.tv = a[4];
          if (!A.posed || Math.hypot(A.tx - A.x, A.tz - A.z) > 25) { A.x = A.tx; A.z = A.tz; A.yaw = A.tyaw; A.posed = true; }
        }
        const gx = A.tx + Math.sin(A.tyaw) * ahead * A.tv, gz = A.tz + Math.cos(A.tyaw) * ahead * A.tv;
        A.x += (gx - A.x) * e; A.z += (gz - A.z) * e; A.yaw = wrapPi(A.yaw + wrapPi(A.tyaw - A.yaw) * e);
        const show = outdoors && _d.set(A.x, a[1], A.z).sub(cam).length() < VEH_FAR;
        if (!show) { if (A.shown) { A.shown = false; amb.group.visible = false; amb.syncCol(); } }
        else {
          amb.x = A.x; amb.z = A.z; amb.yaw = A.yaw;
          if (!A.shown) { A.shown = true; amb.group.visible = true; }
          amb.place(); // (+ its collider: game/heli/ambulance.js)
          if (vr.l) amb.flash(dt, nightUniform.value); else if (amb.lights) for (const m of amb.lights) m.emissiveIntensity = 0.15;
        }
      }
    } else { if (A.shown) { A.shown = false; w.amb.group.visible = false; w.amb.syncCol?.(); } A.posed = false; }
  }
  hideRescueHeli(w) { w.h.shown = false; if (w.model) { w.model.root.visible = false; w.model.pool.mesh.visible = false; w.model.beam.visible = false; } if (w.rope) w.rope.visible = false; }
  hideRescue(w) {
    if (w.h.shown) this.hideRescueHeli(w);
    for (const k of ['cabinCol', 'tailCol']) if (w[k]) RemoteVehicles.place(w[k], false);
    w.h.posed = false; w.a.posed = false; w.ref = null;
    if (w.a.shown) { w.a.shown = false; w.amb.group.visible = false; w.amb.syncCol?.(); }
  }
  dropRescue(pid) {
    const w = this.rescues.get(pid);
    if (!w) return;
    if (w.model) { w.model.root.removeFromParent(); w.model.pool.mesh.removeFromParent(); }
    if (w.rope) { w.rope.removeFromParent(); w.rope.geometry.dispose(); w.rope.material.dispose(); }
    w.amb?.group?.removeFromParent();
    if (w.amb?.col) { this.unsolid(w.amb, 'col'); Ambulance.all.delete(w.amb); }
    for (const k of ['cabinCol', 'tailCol']) this.unsolid(w, k);
    this.rescues.delete(pid);
  }
  /** Where the rescue holds remote r (seatFor): the winch hook, the cabin's front seat; hidden in the ambulance. */
  rescueSeat(r, out) {
    const vr = r.vrescue;
    if (!vr?.s) return false;
    if (vr.s === 3) { r.hideRig = true; return false; }
    const w = this.rescues.get(r.pid);
    if (!w?.model || !w.h.posed) return false;
    if (vr.s === 2) w.model.world(PASSENGER, out);
    else { w.model.world(ANCHORS.door, out); out.y += 1.0 - (vr.rope || 0) - 0.9; }
    r.seatYaw = w.h.yaw;
    return true;
  }

  // ---------------------------------------------------------------- helicopters
  updateHeli(r, dt, cam, outdoors) {
    const flying = r.state === ST.fly;
    const at = !flying ? r.vheli?.at || null : null;
    let h = this.helis.get(r.pid);
    if (!flying && !at) { if (h?.shown) this.hideHeli(h); return; }
    if (!h) {
      let model;
      try { model = new HeliModel(this.o.models()); } catch (e) { console.warn('[mp] helicopter', e); return; }
      model.addTo(this.o.scene);
      const tag = makeTag(`${r.name}'s helicopter`, '#0f2f6b');
      tag.position.set(0, 3.2, 0);
      model.root.add(tag);
      h = { model, tag, yaw: 0, rpm: 0, shown: true };
      this.helis.set(r.pid, h);
    }
    const root = h.model.root;
    if (flying) {
      root.position.copy(r.pos);
      _e.set(r.crouch, r.yaw, r.lean, 'YXZ');
      h.yaw = r.yaw;
    } else {
      root.position.set(at[0], at[1], at[2]);
      _e.set(0, at[3], 0, 'YXZ');
      h.yaw = at[3];
    }
    root.quaternion.setFromEuler(_e);
    root.updateMatrixWorld(true);
    const d = _d.copy(root.position).sub(cam).length();
    const show = outdoors && d < VEH_FAR;
    { // (solid while it stands parked somewhere, as your own: game/heli.js syncModel)
      const fx = Math.sin(h.yaw), fz = Math.cos(h.yaw), still = show && !flying;
      RemoteVehicles.place(this.solid(h, 'cabinCol', { r: 2.1, h: 3, heli: true }), still, root.position.x + fx * 0.9, root.position.z + fz * 0.9);
      RemoteVehicles.place(this.solid(h, 'tailCol', { r: 0.7, h: 2, heli: true }), still, root.position.x - fx * 4.6, root.position.z - fz * 4.6);
    }
    if (!show) { if (h.shown) this.hideHeli(h); return; }
    if (!h.shown) { h.shown = true; root.visible = true; }
    const want = flying ? ((r.flags & F.lights) ? 1 : 0.6) : 0;
    h.rpm += (want - h.rpm) * (1 - Math.exp(-dt * 1.5));
    h.model.update(dt, { rpm: h.rpm, night: nightUniform.value, time: this.time, lamp: false, camera: this.o.camera?.() || null, ground: null, snow: 0 });
    if (flying) { if (h.tag.visible) h.tag.visible = false; } else tagScale(h.tag, d);
  }
  hideHeli(h) { h.shown = false; if (h.cabinCol) { RemoteVehicles.place(h.cabinCol, false); RemoteVehicles.place(h.tailCol, false); } h.model.root.visible = false; h.model.pool.mesh.visible = false; h.model.beam.visible = false; }
  dropHeli(pid) {
    const h = this.helis.get(pid);
    if (!h) return;
    h.model.root.removeFromParent(); h.model.pool.mesh.removeFromParent();
    h.tag.material.map.dispose(); h.tag.material.dispose();
    this.unsolid(h, 'cabinCol'); this.unsolid(h, 'tailCol');
    this.helis.delete(pid);
  }

  // ---------------------------------------------------------------- snowmobiles
  // The snowmobile another player drives (net/sled.js): driving (state drive, flag F.sled) their presence row is its
  // pose on the snow (pitch, roll in crouch / lean: interpolated like everyone's rows); parked, where they left it
  // ('veh' { k: 'sled', at }), tilted to the snow here, their name over it. The parked ones round the resort are each
  // client's own (game/snowmobile.js).
  updateSled(r, dt, cam, outdoors) {
    const driving = r.state === ST.drive && !!(r.flags & F.sled);
    const at = !driving ? r.vsled?.at || null : null;
    let w = this.sleds.get(r.pid);
    if (!driving && !at) { if (w?.shown) { w.shown = false; w.g.visible = false; } if (w) { w.posed = false; if (w.col) RemoteVehicles.place(w.col, false); } return; }
    if (!w) {
      const models = this.o.models();
      if (!models?.snowmobile) return; // (the glTF still loading)
      const g = new THREE.Group();
      g.name = `mp-sled-${r.name}`;
      try { g.add(fitModel(models.snowmobile, { size: SLED.len, axis: 'z', rotateY: Math.PI / 2 })); } catch (e) { console.warn('[mp] snowmobile', e); return; }
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const tag = makeTag(`${r.name}'s snowmobile`, '#0f2f6b');
      tag.position.set(0, 1.9, 0);
      g.add(tag);
      g.visible = false;
      this.o.scene.add(g);
      w = { g, tag, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, atRef: null, posed: false, shown: false };
      this.sleds.set(r.pid, w);
    }
    if (driving) {
      w.x = r.pos.x; w.y = r.pos.y; w.z = r.pos.z; w.yaw = r.yaw; w.pitch = r.crouch; w.roll = r.lean; w.posed = true; w.atRef = null;
    } else if (w.atRef !== at) {
      // parked: on the snow here, tilted to it (as snowmobile.js pose())
      w.atRef = at; w.x = at[0]; w.z = at[2]; w.yaw = at[3];
      const fx = Math.sin(w.yaw), fz = Math.cos(w.yaw), gh = (x, z) => world.groundHeight(x, z, at[1] + 2);
      const f = gh(w.x + fx * 1.2, w.z + fz * 1.2), b = gh(w.x - fx * 1.2, w.z - fz * 1.2);
      const l = gh(w.x + fz * 0.55, w.z - fx * 0.55), rr = gh(w.x - fz * 0.55, w.z + fx * 0.55);
      const top = Math.max(f, b, l, rr);
      w.pitch = Math.atan2(b - f, 2.4); w.roll = Math.atan2(l - rr, 1.1);
      w.y = Number.isFinite(top) && Math.abs(top - at[1]) < 3 ? top - 0.04 : at[1];
      w.posed = true;
    }
    const g = w.g;
    g.position.set(w.x, w.y, w.z);
    _e.set(w.pitch, w.yaw, w.roll, 'YXZ');
    g.quaternion.setFromEuler(_e);
    g.updateMatrixWorld(true); // (the seat is read from it this frame)
    const d = _d.set(w.x, w.y, w.z).sub(cam).length();
    const show = outdoors && d < VEH_FAR;
    if (w.shown !== show) { w.shown = show; g.visible = show; }
    RemoteVehicles.place(this.solid(w, 'col', { r: 1.15, h: 1.4, sled: true }), show, w.x, w.z); // (as the parked ones: game/snowmobile.js)
    if (!show) return;
    if (w.tag.visible) w.tag.visible = false; // (no name over a snowmobile, parked or driven: nobody owns one; Oct 30, the user: "make sure you can't own a snowmobile so no name above it")
  }
  dropSled(pid) {
    const w = this.sleds.get(pid);
    if (!w) return;
    w.g.removeFromParent();
    w.tag.material.map.dispose(); w.tag.material.dispose();
    this.unsolid(w, 'col');
    this.sleds.delete(pid);
  }

  // ---------------------------------------------------------------- the seat an avatar sits in
  /** Remote r seated in a vehicle drawn here (or in your car): its seat point into out, r.seatYaw; else false. */
  seatFor(r, out) {
    r.inLocal = false;
    r.hideRig = false;
    r.onSled = false;
    r.inCar = false;
    parseVeh(r);
    if (r.vrescue && this.rescueSeat(r, out)) return true; // (on the winch, in the cabin; hidden in the ambulance)
    if (r.hideRig) return false;
    if (TRANSIT.has(r.vehK) && this.o.transitSeat) { // a shared train / express / cabin / chair / bus (net/transit.js)
      const yaw = this.o.transitSeat(r.vehK, r.vehOwner, r.vehSeat, out);
      if (yaw !== null && yaw !== undefined) { r.seatYaw = yaw; return true; }
      return false;
    }
    if (r.state === ST.drive && (r.flags & F.sled)) { // astride their snowmobile
      const w = this.sleds.get(r.pid);
      if (!w?.posed) return false;
      out.copy(SLED_SEAT); w.g.localToWorld(out);
      r.seatYaw = w.yaw; r.onSled = true;
      return true;
    }
    if (r.state === ST.fly) {
      const h = this.helis.get(r.pid);
      if (!h) return false;
      h.model.world(ANCHORS.seat, out);
      r.seatYaw = h.yaw;
      return true;
    }
    let owner = '', seat = 0;
    if (r.vehK === 'car') { owner = r.vehOwner; seat = r.vehSeat; }
    else if (r.state === ST.drive && (r.flags & F.car)) owner = r.name;
    else return false;
    if (owner === this.o.selfName()) {
      const L = this.o.localCar?.();
      if (!L) return false;
      r.inLocal = true;
      r.seatYaw = L.yaw;
      r.inCar = true; r.carG = L.group; r.carT = L.t; r.carSeat = seat; // (remote.js carLegs: the feet in this car's footwell)
      return seatWorld(L.group, L.t, seat, out);
    }
    const o = owner === r.name ? r : this.remotes?.byName(owner);
    const c = o && this.cars.get(o.pid);
    if (!c?.posed) return false;
    if (Math.abs(c.roll || 0) > 0.6) { r.hideRig = true; return false; } // (rolled over: inside the car, as on their screen)
    r.seatYaw = c.yaw;
    r.inCar = true; r.carG = c.group; r.carT = c.t; r.carSeat = seat; // (drivers too: remote.js carLegs)
    return seatWorld(c.group, c.t, seat, out);
  }

  /** A remote player's car as drawn (for the ride prompt and the passenger's seat), or null. */
  carOf(pid) { const c = this.cars.get(pid); return c?.posed ? c : null; }

  remove(pid) { this.dropCar(pid); this.dropHeli(pid); this.dropTow(pid); this.dropPolice(pid); this.dropRescue(pid); this.dropSled(pid); }
  dispose() { for (const pid of [...this.cars.keys()]) this.dropCar(pid); for (const pid of [...this.helis.keys()]) this.dropHeli(pid); for (const pid of [...this.tows.keys()]) this.dropTow(pid); for (const pid of [...this.police.keys()]) this.dropPolice(pid); for (const pid of [...this.rescues.keys()]) this.dropRescue(pid); for (const pid of [...this.sleds.keys()]) this.dropSled(pid); }
}
