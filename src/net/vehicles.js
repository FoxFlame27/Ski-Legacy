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
import { seatsFor } from '../game/carpeople.js';
import { lampsOn } from '../game/carlights.js';
import { HeliModel, ANCHORS } from '../game/heli/model.js';
import { nightUniform } from '../world/village.js';

const LEN = Object.fromEntries(CAR_MODELS);
const VEH_FAR = 1800;   // m: vehicles beyond are not drawn
const TAG_FAR = 130;    // m: owner tags hidden beyond
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _d = new THREE.Vector3();
const SEATS = new WeakMap();

/** The seat points of a car template in the car's frame (+x the driver's side, +z forward): 0 the driver, 1 the front
 *  passenger, 2.. the back (outboard behind the driver, behind the passenger, the middle; a third row: then those).
 *  A seat point is where a seated rig's seat goes (its hip 0.1 m above), as drive.js seats you (carpeople.js SEATS). */
export function carSeats(t) {
  if (!t) return null;
  let out = SEATS.get(t);
  if (out) return out;
  out = [];
  const S = seatsFor(t);
  // (carpeople.js hipAt for a hip 0.1 m over the seat point, minus that 0.1 m)
  const pt = (x, s) => new THREE.Vector3(x, s[0] - 0.01, s[1] + s[2] * (0.1 - 0.15) + 0.13);
  if (S) {
    const front = S.d.slice(1);
    out.push(pt(S.d[0], front), pt(-S.d[0], S.p || front));
    if (S.r) {
      const r = S.r.slice(1);
      out.push(pt(S.r[0], r), pt(-S.r[0], r), pt(0, r));
      if (S.r3) { const r3 = S.r3.slice(1); out.push(pt(S.r3[0], r3), pt(-S.r3[0], r3)); }
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
    this.remotes = null;
    this.time = 0;
  }

  /** Every frame, before the avatars (RemotePlayers.update). */
  update(dt, remotes, v) {
    this.remotes = remotes;
    this.time += dt;
    const cam = v.camera.position, outdoors = !v.interior;
    for (const r of remotes.players.values()) {
      if (!r.ok) continue;
      this.updateCar(r, dt, cam, outdoors);
      this.updateHeli(r, dt, cam, outdoors);
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
    const c = { pid: r.pid, key, t, inst, group, tag, x: 0, y: 0, z: 0, yaw: 0, steer: 0, u: 0, lit: -1, posed: false, driven: false, atRef: null };
    this.cars.set(r.pid, c);
    return c;
  }
  dropCar(pid) {
    const c = this.cars.get(pid);
    if (!c) return;
    c.group.removeFromParent();
    c.tag.material.map.dispose(); c.tag.material.dispose();
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
    }
    const driving = r.state === ST.drive && !!(r.flags & F.car);
    c.driven = driving;
    if (driving) {
      c.x = r.pos.x; c.y = r.pos.y; c.z = r.pos.z; c.yaw = r.yaw; c.steer = r.crouch;
      c.u = r.vel.x * Math.sin(r.yaw) + r.vel.z * Math.cos(r.yaw);
      c.posed = true;
    } else {
      c.u = 0; c.steer *= Math.exp(-dt * 3);
      if (vc.at && c.atRef !== vc.at) { c.atRef = vc.at; c.x = vc.at[0]; c.y = vc.at[1]; c.z = vc.at[2]; c.yaw = vc.at[3]; c.posed = true; }
    }
    const g = c.group;
    const d = c.posed ? _d.set(c.x, c.y, c.z).sub(cam).length() : Infinity;
    const show = outdoors && c.posed && d < VEH_FAR;
    if (g.visible !== show) g.visible = show;
    if (!c.posed) return;
    g.position.set(c.x, c.y, c.z);
    g.rotation.set(0, c.yaw, 0);
    g.updateMatrixWorld(true); // (the seats are read from it this frame)
    if (!show) return;
    for (const w of c.inst.wheels) {
      if (w.front) w.steer.rotation.y = c.steer;
      if (c.u) w.roll.rotation.x = (w.roll.rotation.x + (c.u * dt) / (w.r || 0.34)) % (Math.PI * 2);
    }
    if (c.inst.steering) c.inst.steering.col.quaternion.setFromAxisAngle(c.inst.steering.axis, -c.steer * 3);
    const lit = driving ? ((r.flags & F.lights) || nightUniform.value > 0.2 ? 2 : 1) : 0;
    if (lit !== c.lit) { c.lit = lit; try { lampsOn(c.inst, lit === 2 ? 1 : 0, lit === 2 ? 1 : 0, 0, { drl: lit === 1 ? 1 : 0 }); } catch { /* (no lamps) */ } }
    // the owner's name over it while nobody drives it (Oct 29, the user: "everything you own has your name above if
    // you are not in it")
    if (driving) { if (c.tag.visible) c.tag.visible = false; } else tagScale(c.tag, d);
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
    if (!show) { if (h.shown) this.hideHeli(h); return; }
    if (!h.shown) { h.shown = true; root.visible = true; }
    const want = flying ? ((r.flags & F.lights) ? 1 : 0.6) : 0;
    h.rpm += (want - h.rpm) * (1 - Math.exp(-dt * 1.5));
    h.model.update(dt, { rpm: h.rpm, night: nightUniform.value, time: this.time, lamp: false, camera: this.o.camera?.() || null, ground: null, snow: 0 });
    if (flying) { if (h.tag.visible) h.tag.visible = false; } else tagScale(h.tag, d);
  }
  hideHeli(h) { h.shown = false; h.model.root.visible = false; h.model.pool.mesh.visible = false; h.model.beam.visible = false; }
  dropHeli(pid) {
    const h = this.helis.get(pid);
    if (!h) return;
    h.model.root.removeFromParent(); h.model.pool.mesh.removeFromParent();
    h.tag.material.map.dispose(); h.tag.material.dispose();
    this.helis.delete(pid);
  }

  // ---------------------------------------------------------------- the seat an avatar sits in
  /** Remote r seated in a vehicle drawn here (or in your car): its seat point into out, r.seatYaw; else false. */
  seatFor(r, out) {
    r.inLocal = false;
    parseVeh(r);
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
      return seatWorld(L.group, L.t, seat, out);
    }
    const o = owner === r.name ? r : this.remotes?.byName(owner);
    const c = o && this.cars.get(o.pid);
    if (!c?.posed) return false;
    r.seatYaw = c.yaw;
    return seatWorld(c.group, c.t, seat, out);
  }

  /** A remote player's car as drawn (for the ride prompt and the passenger's seat), or null. */
  carOf(pid) { const c = this.cars.get(pid); return c?.posed ? c : null; }

  remove(pid) { this.dropCar(pid); this.dropHeli(pid); }
  dispose() { for (const pid of [...this.cars.keys()]) this.dropCar(pid); for (const pid of [...this.helis.keys()]) this.dropHeli(pid); }
}
