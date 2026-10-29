// Remote players: one avatar per other player in your world. The avatar is the game's own skier rig (the same model
// and outfit as theirs: SkierRig + applyOutfit), posed from their presence: ski / walk / sit (in a seat, on a lift,
// in a vehicle) with ~120 ms of buffered snapshot interpolation on the server's clock, a short extrapolation when
// packets are late, and a name tag above the head (hidden beyond ~150 m).
// Interiors: an avatar shows only while you are in the same interior as they are (null = outdoors), in that
// interior's scene and coordinates (getScene(interiorId) from main.js).
// Vehicles (net/vehicles.js, optional o.vehicles): other players' cars and helicopters, and the avatars seated in
// them (a driver at the wheel, passengers in their seats, a pilot in the cabin); the avatars in YOUR car are posed in
// late() once your own car has moved this frame.
// No allocations per frame: snapshot slots, vectors and the rig state objects are all reused.
import * as THREE from 'three';
import { R, ST, F } from './protocol.js';

const RING = 16;              // snapshots kept per player
const DELAY = 120;            // ms of interpolation buffer (at least; more when rows arrive later: Remote.delay)
const MAX_DELAY = 400;
const EXTRAPOLATE = 250;      // ms at most past the newest snapshot
const TAG_FAR = 150;          // m: name tags hidden beyond
const ANIM_NEAR = 60;         // m: full-rate animation within, lower rate beyond
const HIDE_FAR = 2500;        // m: avatars beyond are not drawn at all
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();

function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

export function makeTag(name, color = '#1f5fd1') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.font = 'italic 700 54px "Barlow Condensed", "Arial Narrow", sans-serif';
  const w = Math.min(500, g.measureText(name).width + 48);
  const x0 = (512 - w) / 2;
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.beginPath();
  g.roundRect ? g.roundRect(x0, 14, w, 68, 14) : g.rect(x0, 14, w, 68);
  g.fill();
  g.fillStyle = color;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name, 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true, sizeAttenuation: false });
  const s = new THREE.Sprite(mat);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  s.userData.base = 0.05; // fraction of the screen height
  s.scale.set(s.userData.base * (512 / 96), s.userData.base, 1);
  return s;
}

class Remote {
  constructor(info) {
    this.pid = info.pid;
    this.name = info.name;
    this.look = info.look || null;
    this.chalet = info.chalet ?? null;
    this.rig = null; this.rigKey = '';
    this.scene = null;               // the scene the rig is in now
    this.tag = null;
    this.slots = []; for (let i = 0; i < RING; i++) this.slots.push({ n: new Float64Array(13), veh: 0, int: 0 });
    this.count = 0; this.head = -1;  // ring: newest at head
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.state = ST.walk; this.flags = 0; this.crouch = 0; this.lean = 0;
    this.veh = 0; this.interior = null; this.seen = false;
    this.vcar = info.vehs?.car || null;   // the vehicles they show ('veh': { k: 'car', cfg, at? }, { k: 'heli', id, at? })
    this.vheli = info.vehs?.heli || null;
    this.ok = false; this.inLocal = false;
    this.vehStr = 0; this.vehK = ''; this.vehOwner = ''; this.vehSeat = -1; // the parsed `kind:id:seat` (vehicles.js)
    this.seatPos = new THREE.Vector3(); this.seatYaw = 0;
    this.animAcc = 0;
    this.st = { mode: 'idle', heading: 0, speed: 0, crouch: 0, lean: 0, edge: 0, tuck: false, plow: 0, skid: 0, normal: UP, air: false, flip: 0, grab: 0, spinVel: 0, charge: 0, lookYaw: 0, lookPitch: 0, seat: null, carry: false, airY: 0, fall: null };
    this.seat = new THREE.Vector3();
    this.fxInfo = { grounded: true, speed: 0, vel: this.vel, sideslip: 0, plow: 0, lean: 0 };
    this.lastTs = 0;
    this.lag = null;
  }
  get delay() { return Math.min(MAX_DELAY, Math.max(DELAY, (this.lag ?? 0) + 90)); }
  push(row, now) {
    if (row[R.ts] <= this.lastTs) return; // (out of order / duplicate)
    this.lastTs = row[R.ts];
    // how late rows arrive (send -> server batch -> here), smoothed: the interpolation delay follows it so there
    // is (nearly) always a newer snapshot to blend toward; ~120 ms on a good connection
    if (Number.isFinite(now)) { const lag = Math.max(0, now - row[R.ts]); this.lag = this.lag == null ? lag : this.lag * 0.92 + lag * 0.08; }
    this.head = (this.head + 1) % RING;
    const s = this.slots[this.head];
    for (let i = 0; i < 12; i++) s.n[i] = row[i + 1]; // ts, x, y, z, yaw, vx, vy, vz, st, crouch, lean, flags
    s.veh = row[R.veh] || 0;
    s.int = row[R.int] || 0;
    if (this.count < RING) this.count++;
  }
  slot(k) { return this.slots[(this.head - k + RING * 2) % RING]; } // k = 0 newest
}

export class RemotePlayers {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene         the world scene
   * @param {(charId, skiId) => SkierRig} o.makeRig
   * @param {(rig, charId, outfit) => void} [o.applyOutfit]
   * @param {(interiorId: string|null) => THREE.Scene|null} [o.getScene]   the scene of an interior (null: outdoors)
   * @param {(id, rig, info, dt) => void} [o.fx]   snow spray / tracks for skiing avatars
   * @param {() => number} o.now                    the server clock (ms)
   * @param {number} [o.selfPid]
   */
  constructor(o) {
    this.o = o;
    this.players = new Map();
    this.selfPid = o.selfPid || 0;
    this.visible = true;
  }

  get size() { return this.players.size; }

  clear() { for (const pid of [...this.players.keys()]) this.remove(pid); }

  add(info) {
    if (!info || info.pid === this.selfPid) return null;
    let r = this.players.get(info.pid);
    if (!r) { r = new Remote(info); this.players.set(info.pid, r); }
    else { r.name = info.name; if (info.look) r.look = info.look; if (info.vehs) { r.vcar = info.vehs.car || null; r.vheli = info.vehs.heli || null; } }
    if (info.pres) r.push(info.pres, this.o.now());
    if (info.interior !== undefined) r.interior = info.interior || null;
    return r;
  }

  remove(pid) {
    const r = this.players.get(pid);
    if (!r) return;
    this.o.vehicles?.remove(pid);
    this.detach(r);
    if (r.tag) { r.tag.material.map.dispose(); r.tag.material.dispose(); }
    this.players.delete(pid);
  }

  setLook(pid, look) {
    const r = this.players.get(pid);
    if (!r) return;
    r.look = look;
    r.rigKey = ''; // rebuilt on the next update
  }

  /** A vehicle a player shows changed ('veh' broadcast: k 'car' | 'heli', veh or null). */
  setVeh(pid, k, veh) { const r = this.players.get(pid); if (!r) return; if (k === 'car') r.vcar = veh || null; else if (k === 'heli') r.vheli = veh || null; }

  onRows(rows) {
    if (!Array.isArray(rows)) return;
    const now = this.o.now();
    for (const row of rows) {
      if (!Array.isArray(row) || row[R.pid] === this.selfPid) continue;
      const r = this.players.get(row[R.pid]);
      if (r) r.push(row, now);
    }
  }

  byName(name) { for (const r of this.players.values()) if (r.name === name) return r; return null; }

  detach(r) {
    if (r.rig && r.scene) { r.rig.removeFrom(r.scene); if (r.tag) r.tag.removeFromParent(); }
    r.scene = null;
  }

  ensureRig(r) {
    if (r.rig && r.rigKey) return r.rig; // (rigKey '' = the look changed: rebuild)
    const look = r.look || {};
    const key = `${look.c || 'skier_blue'}|${look.s || 'rental'}`;
    const scene = r.scene;
    this.detach(r);
    try {
      r.rig = this.o.makeRig(look.c || 'skier_blue', look.s || 'rental');
      if (look.o) this.o.applyOutfit?.(r.rig, look.c || 'skier_blue', look.o);
      r.rig.setCarry?.(false);
      r.rig.snapNext = true;
    } catch (e) { console.warn('[mp] avatar rig', e); r.rig = null; }
    r.rigKey = key;
    r.tag ||= makeTag(r.name);
    if (r.rig && scene) this.attach(r, scene);
    return r.rig;
  }

  attach(r, scene) {
    if (!r.rig || r.scene === scene) return;
    this.detach(r);
    r.rig.addTo(scene);
    r.rig.root.add(r.tag);
    r.tag.position.set(0, 2.15, 0);
    r.scene = scene;
  }

  /** Interpolated state at server time t (ms) into r.pos / r.yaw / ... */
  sample(r, t) {
    if (!r.count) return false;
    const newest = r.slot(0);
    let a = null, b = null;
    for (let k = 0; k < r.count - 1; k++) {
      const s1 = r.slot(k), s0 = r.slot(k + 1);
      if (s0.n[0] <= t && t <= s1.n[0]) { a = s0; b = s1; break; }
    }
    let src = newest;
    if (a && b) {
      const span = b.n[0] - a.n[0], f = span > 0 ? (t - a.n[0]) / span : 1;
      r.pos.set(a.n[1] + (b.n[1] - a.n[1]) * f, a.n[2] + (b.n[2] - a.n[2]) * f, a.n[3] + (b.n[3] - a.n[3]) * f);
      r.yaw = a.n[4] + wrapAngle(b.n[4] - a.n[4]) * f;
      r.vel.set(a.n[5] + (b.n[5] - a.n[5]) * f, a.n[6] + (b.n[6] - a.n[6]) * f, a.n[7] + (b.n[7] - a.n[7]) * f);
      r.crouch = a.n[9] + (b.n[9] - a.n[9]) * f; r.lean = a.n[10] + (b.n[10] - a.n[10]) * f;
      src = f < 0.5 ? a : b;
    } else if (t > newest.n[0]) {
      // late: carry on along the velocity for a moment (not while seated: seats move with their vehicle)
      const dt = Math.min(EXTRAPOLATE, t - newest.n[0]) / 1000;
      const seated = newest.n[8] === ST.sit || newest.n[8] === ST.ride;
      r.pos.set(newest.n[1], newest.n[2], newest.n[3]);
      if (!seated) r.pos.x += newest.n[5] * dt, r.pos.y += newest.n[6] * dt, r.pos.z += newest.n[7] * dt;
      r.yaw = newest.n[4];
      r.vel.set(newest.n[5], newest.n[6], newest.n[7]);
      r.crouch = newest.n[9]; r.lean = newest.n[10];
    } else {
      const o = r.slot(r.count - 1); // older than anything we have: the oldest
      r.pos.set(o.n[1], o.n[2], o.n[3]); r.yaw = o.n[4]; r.vel.set(o.n[5], o.n[6], o.n[7]);
      r.crouch = o.n[9]; r.lean = o.n[10];
      src = o;
    }
    r.state = src.n[8] | 0;
    r.flags = src.n[11] | 0;
    r.veh = src.veh;
    r.interior = src.int || null;
    return true;
  }

  /**
   * Once per frame.
   * @param {number} dt
   * @param {object} v   { interior: your interior id or null, scene: the scene being rendered, camera }
   */
  update(dt, v) {
    if (!this.players.size) return;
    const now = this.o.now();
    for (const r of this.players.values()) r.ok = this.sample(r, now - r.delay);
    this.o.vehicles?.update(dt, this, v); // (their cars and helicopters first: the avatars sit in them)
    for (const r of this.players.values()) if (r.ok) this.poseOne(r, dt, v, false);
  }

  /** After your own car moved this frame (main.js, after drive.update): the avatars riding in it. */
  late(dt, v) {
    if (!this.players.size || !this.o.vehicles) return;
    for (const r of this.players.values()) if (r.ok && r.inLocal) this.poseOne(r, dt, v, true);
  }

  poseOne(r, dt, v, late) {
    // seated in a vehicle (a car seat, the helicopter's cabin): the seat comes from the vehicle as drawn here
    const veh = this.o.vehicles;
    const inVeh = veh ? veh.seatFor(r, r.seatPos) : false; // (sets r.seatYaw, r.inLocal)
    if (r.inLocal && !late) return; // (in your car: posed in late())
    const pos = inVeh ? r.seatPos : r.pos;
    const cam = v.camera.position;
    const here = this.visible && (r.interior || null) === (v.interior || null);
    const d = here ? _a.copy(pos).sub(cam).length() : Infinity;
    if (!here || d > HIDE_FAR) { if (r.rig?.root.visible) { r.rig.root.visible = false; r.rig.gear.visible = false; } return; }
    const rig = this.ensureRig(r);
    if (!rig) return;
    const scene = (r.interior ? this.o.getScene?.(r.interior) : this.o.scene) || this.o.scene;
    if (r.scene !== scene) this.attach(r, scene);
    if (!rig.root.visible) { rig.root.visible = true; rig.gear.visible = true; rig.snapNext = true; }
    rig.root.position.copy(pos);
    // the rig's pose from the state
    const st = r.st, speed = Math.hypot(r.vel.x, r.vel.z);
    const seated = inVeh || r.state === ST.sit || r.state === ST.ride || r.state === ST.drive || r.state === ST.fly;
    if (seated) { st.mode = 'sit'; if (!inVeh) r.seatPos.copy(r.pos); st.seat = r.seatPos; }
    else if (r.state === ST.ski) { st.mode = 'ski'; st.seat = null; }
    else { st.mode = speed > 0.1 ? 'walk' : 'idle'; st.seat = null; }
    st.heading = inVeh ? r.seatYaw : r.yaw;
    st.speed = seated ? 0 : speed;
    st.crouch = seated ? 0 : r.crouch; st.lean = seated ? 0 : r.lean; st.edge = st.lean * 0.6;
    st.air = !seated && !!(r.flags & F.air); st.tuck = !seated && !!(r.flags & F.tuck);
    st.carry = !inVeh && !!(r.flags & F.carry);
    st.normal = UP;
    const skisVisible = !inVeh && (r.state === ST.ski || st.carry);
    if (r.skisShown !== skisVisible) { r.skisShown = skisVisible; rig.setSkisVisible(skisVisible); }
    // name tag: a little smaller far away, hidden past TAG_FAR
    const tagOn = d < TAG_FAR;
    if (r.tag.visible !== tagOn) r.tag.visible = tagOn;
    if (tagOn) { const k = r.tag.userData.base * Math.max(0.6, Math.min(1, 1.15 - d / 220)); r.tag.scale.set(k * (512 / 96), k, 1); }
    r.animAcc += dt;
    if (d < ANIM_NEAR || r.animAcc > (d < ANIM_NEAR * 3 ? 0.06 : 0.15)) {
      rig.update(r.animAcc, st);
      r.animAcc = 0;
    }
    if (r.state === ST.ski && d < 120 && this.o.fx) {
      const fi = r.fxInfo;
      fi.grounded = !st.air; fi.speed = speed; fi.sideslip = Math.abs(r.lean) * 0.15; fi.lean = r.lean;
      this.o.fx(9000 + r.pid * 4, rig, fi, dt);
    }
  }

  dispose() { this.clear(); this.o.vehicles?.dispose(); }
}
