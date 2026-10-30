// Mountain rescue instead of the wipeout fade (free ride): after a crash you stay down in the snow and the
// helicopter comes for you. It flies in from its pad (or from wherever it is: on its way home after your drop,
// parked where you landed it; from far away it is already on its way when the shot opens), then either lands on
// flat open snow beside you (a fade, and you are in the cabin) or, over trees or a slope too steep to land on,
// hovers above you and winches you up. Then it flies you home to the pad (a chase camera, the mouse looks
// around, hold SPACE to speed it all up), lands, and you step out: "Back in Legacy Village".
// The ambulance waiting at the pad then drives you all the way to the medical centre (a chase camera, SPACE speeds
// it up), where you are treated and released outside its door. (Oct 28, the user: "the ambulance doesn't work, you
// just get teleported into the village": the whole rescue had a 150 s limit, so a long flight home (from a far peak,
// slowed down to lose height on the glide path) ran out of time and fell back to the wipeout fade into the village;
// and the ambulance drove for 10 s, then the screen cut to the medical centre.) Now only the wait for the pick-up
// is timed; once you are aboard a watchdog only steps in when the helicopter or the ambulance stops getting closer,
// and even then you come round at the medical centre (never the village plaza).
//
// heli.js drives it: start() from heli.rescueMe(), controls(dt) for the flight, after(dt, input) for the player,
// the rope and the camera; cleanup() from heli.abort().
import * as THREE from 'three';
import { autopilot, wrapPi } from './flight.js';
import { ANCHORS, FRAME } from './model.js';
import { PAD_R } from './pad.js';
import { Ambulance } from './ambulance.js';
import { busRoads } from '../bus/roads.js';
import { save, writeSave } from '../economy.js';

// The rescue bill (the ambulance): $750, then $150 more for every rescue before it (counted in the save), never
// over $2,000 (~5 to 13 minutes of jobs: it hurts, it never ruins you); it is charged even into the red (shops,
// lifts and passes then refuse until you earn it back). (Oct 29 rebalance: was $500 + $125, uncapped.)
export const FEE_BASE = 750, FEE_STEP = 150, FEE_MAX = 2000;
export const rescueFee = () => Math.min(FEE_MAX, FEE_BASE + FEE_STEP * Math.max(0, save.rescues | 0));
// The ambulance ride after a rescue (false: the rescue ends the old way, out at the pad, no fee).
export const AMBULANCE_ON = true; // (checked in the game 2026-10-27)

const LIMIT = 150;         // game seconds to pick you up before giving up (straight to the medical centre instead)
const STUCK = 45;          // game seconds without getting any closer (helicopter home, ambulance) before giving up
const FAR = 1500;          // farther than this, the helicopter starts the shot already on its way...
const START_D = 800;       // ...this far out
const HOVER_AGL = 12, HOVER_TREES = 27; // winch hover heights above the snow (m)
const ROPE_DOWN = 2.6, ROPE_UP = 4.2;   // winch times (s)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _door = new THREE.Vector3();
// how dark it is (0 day .. 1 night) for the ambulance lights
const nightK = (h) => clamp((h.camera && globalThis.__game?.env?.nightFactor) || 0, 0, 1);
// the front passenger seat (left of the pilot's): you ride there, the rescue pilot flies
const PASSENGER = new THREE.Vector3(-ANCHORS.seat.x, ANCHORS.seat.y, ANCHORS.seat.z);

export class Rescue {
  constructor(heli) {
    this.h = heli;
    this.phase = null;        // inbound | settle | pickup | hover | home | arrive | out
    this.t = 0; this.pt = 0;  // total / phase time (game s)
    this.fast = false;
    this.goal = { x: 0, z: 0, y: undefined, agl: undefined, speed: 72, stop: 0.8, yaw: undefined, decel: 3.9 };
    this.out = { fwd: 0, turn: 0, lift: 0 };
    this.spot = null;         // { x, z, y, yaw, land: bool, hoverY }
    this.winchSeat = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1) };
    this.cabinSeat = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1) };
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), ready: false };
    this.rope = null;
    this.ropeLen = 0;
    this.amb = null;          // the ambulance at the pad (made on the first rescue)
    this.ambSeat = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1) };
  }
  /** The helicopter is back on its pad and you are in the ambulance (its rotor can wind down). */
  get grounded() { return this.phase === 'ambulance'; }

  get active() { return !!this.phase; }
  /** You are in the cabin (inside sound, chase camera). */
  get aboard() { return this.phase === 'home' || this.phase === 'arrive' || this.phase === 'out' || (this.phase === 'pickup' && this.inCabin); }

  /** Objective line while it runs. */
  hudLine() {
    switch (this.phase) {
      case 'inbound': return 'Rescue helicopter on its way · hold SPACE to speed up';
      case 'settle': case 'pickup': return 'The rescue helicopter is landing beside you';
      case 'hover': return this.attached ? 'Hold on · winching you up' : 'The rescue helicopter is lowering the winch';
      case 'home': case 'arrive': return 'Flying back to Legacy Village · hold SPACE to speed up';
      case 'ambulance': return `Ambulance to the medical centre · $${rescueFee()} · hold SPACE to speed up`;
      default: return '';
    }
  }

  /**
   * Start a rescue for the player lying where they crashed. false: not possible here (main.js uses the old fade).
   * @param {{fallback?: () => void}} o
   */
  start({ fallback, free = false } = {}) {
    const h = this.h, p = h.player, f = h.flight, W = h.world;
    if (this.phase && h.state !== 'rescue') { try { this.cleanup(); } catch { /* */ } this.phase = null; } // (a rescue left half-done: it never blocks the next one)
    if (this.phase || h.state === 'flying' || h.state === 'boarding') { console.warn('rescue: helicopter busy', this.phase, h.state); return false; }
    // under a tunnel lid or inside a cave: no way to reach you from the air
    if (Math.abs(W.outsideHeight(p.pos.x, p.pos.z) - W.height(p.pos.x, p.pos.z)) > 2.5) return false;
    this.fallback = fallback;
    this.free = free; // (knocked over by a vehicle: not your fault, no fee)
    this.t = 0; this.pt = 0; this.fast = false; this.spot = null; this.attached = false; this.inCabin = false; this.shot.ready = false;
    h.model.clearRack();
    h.away = null;
    // where the helicopter starts: its pad, or wherever it is now; from far away it is already on the way
    const d = Math.hypot(f.pos.x - p.pos.x, f.pos.z - p.pos.z);
    if (d > FAR) {
      const ux = (f.pos.x - p.pos.x) / d, uz = (f.pos.z - p.pos.z) / d;
      const x = p.pos.x + ux * START_D, z = p.pos.z + uz * START_D, yaw = Math.atan2(-ux, -uz);
      f.place(x, z, yaw, h.ground);
      let top = h.ground(x, z);
      for (let k = 1; k <= 8; k++) top = Math.max(top, h.ground(x - ux * START_D * k / 8, z - uz * START_D * k / 8));
      f.landed = false;
      f.pos.y = Math.max(h.ground(x, z) + f.cgH + 60, top + f.cgH + 45);
      f.u = 38; f.vel.set(Math.sin(yaw) * 38, 0, Math.cos(yaw) * 38);
      h.rpm = 1;
    }
    h.pilot.phase = 'idle';
    h.state = 'rescue';
    p.frozen = true;
    this.phase = 'inbound';
    // the ambulance waits beside the pad (side of the pad, facing out)
    if (AMBULANCE_ON) try {
      if (!this.amb) this.amb = new Ambulance({ scene: h.scene, models: h.models || {}, world: h.world, colliders: h.colliders });
      const a = h.home.yaw - Math.PI / 2, d = PAD_R + 9;
      this.amb.park(h.home.x + Math.sin(a) * d, h.home.z + Math.cos(a) * d, a);
    } catch (e) { console.warn('ambulance', e); this.amb = null; }
    h.hud.flash('Rescue helicopter on its way', 'good', 2600);
    return true;
  }

  // ------------------------------------------------------------------ the flight
  controls(dt) {
    const h = this.h, f = h.flight, p = h.player, o = this.out, g = this.goal;
    o.fwd = o.turn = o.lift = 0;
    g.y = undefined; g.agl = undefined; g.yaw = undefined; g.stop = 0.8; g.decel = 3.9; g.speed = 72;
    if (this.phase === 'inbound') {
      // toward you (once you have stopped sliding and it is close, toward the pick-up spot it picked)
      if (!this.spot && this.settled() && Math.hypot(f.pos.x - p.pos.x, f.pos.z - p.pos.z) < 320) this.spot = this.pickSpot();
      const tx = this.spot ? this.spot.x : p.pos.x, tz = this.spot ? this.spot.z : p.pos.z;
      const ty = this.spot ? this.spot.y : h.ground(tx, tz);
      const d = Math.hypot(tx - f.pos.x, tz - f.pos.z);
      g.x = tx; g.z = tz;
      // a glide path that ends 20 m above the spot, never below 35 m over what is underneath
      g.y = Math.max(f.groundY + f.cgH + 35, ty + f.cgH + 20 + Math.max(0, d - 150) / 5.5);
      if (this.spot && !this.spot.land) g.y = Math.max(g.y, this.spot.hoverY);
      const high = f.pos.y - g.y;
      g.speed = high > 25 ? clamp((12 * Math.max(0, d - 120)) / high, 15, 72) : 72;
      autopilot(f, g, o);
      if (this.spot && d < 1.2 && f.speed < 0.9) this.go(this.spot.land ? 'settle' : 'hover');
      return o;
    }
    const s = this.spot;
    if (this.phase === 'settle') {
      // turn to the parking heading at 16 m, then down (the ground cushion sets it on the snow)
      g.x = s.x; g.z = s.z; g.yaw = s.yaw; g.stop = 1.5; // (right over the spot it checked)
      const aligned = Math.abs(wrapPi(s.yaw - f.yaw)) < 0.06;
      if (!aligned && this.pt < 8) { g.agl = 16; autopilot(f, g, o); return o; }
      g.y = s.y + f.cgH - 1;
      autopilot(f, g, o);
      o.lift = clamp((s.y + f.cgH - 1 - f.pos.y) * 0.05, -1.3, 0);
      if (f.landed) this.go('pickup');
      // could not get down there after all: winch instead
      else if (this.pt > 16) { this.spot = this.pickWinch(); this.go('hover'); }
      return o;
    }
    if (this.phase === 'pickup') return o; // on the skids, waiting for you
    if (this.phase === 'hover') {
      g.x = s.hx; g.z = s.hz; g.y = s.hoverY; g.yaw = s.yaw; g.stop = 6;
      autopilot(f, g, o);
      return o;
    }
    if (this.phase === 'home' || this.phase === 'arrive' || this.phase === 'out') {
      Object.assign(o, h.pilot.update(dt));
      if (this.phase === 'home' && h.pilot.phase === 'landed') this.go('arrive');
      return o;
    }
    return o;
  }

  go(phase) { this.phase = phase; this.pt = 0; }

  settled() {
    const p = this.h.player;
    return p.mode !== 'fall' || (p.fall?.state !== 'tumble' && p.vel.length() < 1.5);
  }

  // Where to pick you up: lying in the trees or on a slope too steep to land on, the winch from above; otherwise
  // flat open snow within ~35 m (it lands, the door facing you), else the winch after all.
  pickSpot() {
    const h = this.h, p = h.player.pos, W = h.world;
    const veg = h.player.vegetation;
    const e0 = 3, here = Math.hypot(h.ground(p.x + e0, p.z) - h.ground(p.x - e0, p.z), h.ground(p.x, p.z + e0) - h.ground(p.x, p.z - e0)) / (2 * e0);
    if (veg?.collide(p.x, p.z, 7, 1.2) || here > 0.3) return this.pickWinch();
    const ok = (x, z) => {
      const e = 2.5, slope = Math.hypot(h.ground(x + e, z) - h.ground(x - e, z), h.ground(x, z + e) - h.ground(x, z - e)) / (2 * e);
      const e2 = 5.5, slope2 = Math.hypot(h.ground(x + e2, z) - h.ground(x - e2, z), h.ground(x, z + e2) - h.ground(x, z - e2)) / (2 * e2);
      if (slope > 0.24 || slope2 > 0.24) return false;
      if (veg?.collide(x, z, FRAME.rotorR + 3, 1.2)) return false;
      for (const c of h.colliders) {
        if (c === h.cabinCol || c === h.tailCol) continue;
        const reach = (c.r ?? Math.hypot(c.hw, c.hd)) + FRAME.rotorR + 2;
        if (Math.abs(x - c.x) < reach && Math.abs(z - c.z) < reach && Math.hypot(x - c.x, z - c.z) < reach) return false;
      }
      const cor = W.corridorAt(x, z, h._corr);
      if (cor.kind === 'lift' && cor.d < 4) return false;
      return true;
    };
    for (const r of [11, 15, 20, 26, 33]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + r * 0.37;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (!ok(x, z)) continue;
        // the right-hand door toward you: right of yaw is (-cos yaw, sin yaw)
        const dx = p.x - x, dz = p.z - z;
        return { land: true, x, z, y: h.ground(x, z), yaw: Math.atan2(dz, -dx) };
      }
    }
    return this.pickWinch();
  }

  // the winch: hover with the door above you, high enough to clear the trees around
  pickWinch() {
    const h = this.h, p = h.player.pos;
    const trees = h.player.vegetation?.collide(p.x, p.z, FRAME.rotorR + 4, 1.2);
    const yaw = h.flight.yaw;
    // the door is ~1.4 m right of the centre: put the centre that far to the left of you
    const hx = p.x + Math.cos(yaw) * 1.4, hz = p.z - Math.sin(yaw) * 1.4;
    let top = h.ground(p.x, p.z);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; top = Math.max(top, h.ground(hx + Math.cos(a) * FRAME.rotorR, hz + Math.sin(a) * FRAME.rotorR)); }
    const y = h.ground(p.x, p.z);
    return { land: false, x: hx, z: hz, hx, hz, y, yaw, hoverY: Math.max(y + (trees ? HOVER_TREES : HOVER_AGL), top + 6) + h.flight.cgH };
  }

  // ------------------------------------------------------------------ you, the rope, the camera
  after(dt, input) {
    const h = this.h, p = h.player, f = h.flight;
    this.fast = !!input?.down?.('Space');
    const sdt = dt * (this.fast ? 4 : 1); // (SPACE: the waits and the winch run faster too)
    this.t += sdt; this.pt += sdt;
    // aboard: a watchdog on the progress toward the pad / the medical centre (no clock on the ride itself)
    if (this.phase === 'home' || this.phase === 'ambulance') {
      const P = this.phase === 'home' ? h.flight.pos : this.amb.pos(_w);
      const tx = this.phase === 'home' ? h.home.x : this.amb.goal?.x ?? P.x, tz = this.phase === 'home' ? h.home.z : this.amb.goal?.z ?? P.z;
      const d = Math.hypot(P.x - tx, P.z - tz);
      if (this.watch?.phase !== this.phase || d < this.watch.best - 1) this.watch = { phase: this.phase, best: d, t: 0 };
      else if ((this.watch.t += sdt) > STUCK) { this.fail(); return; }
    }
    // the ambulance's lights and siren from the moment you land at the pad until the screen goes black
    if (this.amb?.ok && (this.phase === 'arrive' || this.phase === 'ambulance') && !this.sirenOff) {
      const amb = this.amb, cam = h.camera.position, a = amb.pos(_w);
      if (this.phase === 'arrive') amb.flash(sdt, nightK(h));
      const dist = cam.distanceTo(a);
      const vr = dist > 1 ? (amb.vx * (a.x - cam.x) + amb.vz * (a.z - cam.z)) / dist : 0; // moving away: +
      h.audio?.setSiren?.({ on: true, dist, doppler: clamp(343 / (343 + vr), 0.9, 1.1) });
    }
    // in the ambulance: it drives you all the way to the medical centre's door (a shot by the pad watches it set
    // off, then the camera follows it); there you are treated and released
    if (this.phase === 'ambulance') {
      const amb = this.amb;
      if (!this.leaving) amb.drive(sdt);
      amb.flash(0, nightK(h));
      amb.pos(this.ambSeat.pos); this.ambSeat.pos.y += 1.2;
      this.ambSeat.fwd.set(Math.sin(amb.yaw), 0, Math.cos(amb.yaw));
      p.pos.copy(this.ambSeat.pos);
      h.streamPos.copy(this.ambSeat.pos);
      if (this.pt < 4) this.ambShot(dt); else this.ambChase(dt);
      if (amb.arrived && !this.leaving) this.homeByAmbulance();
      return;
    }
    if (!this.inCabin && !this.attached && this.t > LIMIT) { this.fail(); return; }
    // stay down in the snow until you are picked up (the fall's own get-up waits)
    if (!this.attached && !this.inCabin) {
      p.frozen = true;
      if (p.mode === 'fall' && p.fall?.state === 'lie') p.fall.lieT = Math.min(p.fall.lieT, 0.3);
      if (p.mode === 'ski' || p.mode === 'walk') p.vel.set(0, 0, 0);
    }
    if (this.phase === 'pickup' && !this.boarding && this.pt > 0.8) {
      this.boarding = true;
      h.transition.fade(async () => { this.intoCabin(); }).catch(() => this.fail()).finally(() => { this.boarding = false; });
    }
    if (this.phase === 'hover') this.winch(sdt);
    if (this.phase === 'arrive' && this.pt > 0.6 && !this.leaving) this.finish();
    // you in the cabin: on the seat, moving with it
    if (this.inCabin) {
      this.seatNow();
      p.pos.copy(this.cabinSeat.pos);
      p.rig.root.position.copy(this.cabinSeat.pos);
      p.rig.root.quaternion.copy(f.quat);
      p.rig.root.updateMatrixWorld(true);
      const ahead = Math.min(2, 140 / Math.max(1, f.speed));
      h.streamPos.set(f.pos.x + f.vel.x * ahead, f.pos.y, f.pos.z + f.vel.z * ahead);
      h.placeCamera(dt, false, input);
    } else {
      h.streamPos.copy(p.pos);
      // while you are still tumbling the crash camera keeps you; then the shot from the snow
      if (this.settled()) this.groundShot(dt);
    }
  }

  // From the snow beside you, low, looking past you at the helicopter coming in (and up at it overhead).
  groundShot(dt) {
    const h = this.h, cam = h.camera, f = h.flight, S = this.shot, me = h.player.pos;
    // (on the winch the shot stays down where you lay, watching you go up)
    const p = this.attached && this.lieAt ? this.lieAt : me, back = this.attached ? 12 : 7;
    let dx = f.pos.x - p.x, dz = f.pos.z - p.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    if (!S.ready) { S.dx = dx; S.dz = dz; }
    // the side of the shot is fixed once it starts (no swinging round as the helicopter passes overhead)
    if (d > 40) { S.dx += (dx - S.dx) * (1 - Math.exp(-dt * 0.8)); S.dz += (dz - S.dz) * (1 - Math.exp(-dt * 0.8)); }
    const l = Math.hypot(S.dx, S.dz) || 1, ax = S.dx / l, az = S.dz / l;
    const want = _v.set(p.x - ax * back - az * 3.2, 0, p.z - az * back + ax * 3.2);
    want.y = Math.max(h.snow(want.x, want.z) + 1.7, p.y + 1.1);
    // look between you and the helicopter (both in the frame)
    const toP = _w.set(me.x, me.y + 0.6, me.z).sub(want).normalize();
    const hp = this.attached ? _door.copy(h.flight.pos) : f.pos;
    const toH = _u.copy(hp).sub(want).normalize();
    const look = toP.lerp(toH, d < 60 ? 0.62 : 0.45).normalize().add(want);
    if (!S.ready) { S.pos.copy(want); S.look.copy(look); S.ready = true; }
    S.pos.lerp(want, 1 - Math.exp(-dt * 2.5));
    S.look.lerp(look, 1 - Math.exp(-dt * 3));
    cam.position.copy(S.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(S.look);
    cam.near = 0.1;
    cam.fov += (58 - cam.fov) * (1 - Math.exp(-dt * 3));
    cam.updateProjectionMatrix();
  }

  // the winch: the rope comes down, you clip in, you go up into the cabin
  winch(dt) {
    const h = this.h, p = h.player;
    if (!this.rope) this.makeRope();
    h.model.world(ANCHORS.door, _door);
    _door.y += 1.0;
    const groundY = p.pos.y;
    const full = Math.max(0.5, _door.y - groundY - 0.9);
    if (!this.attached) {
      if (this.pt < 2.5) { this.rope.visible = false; return; } // settling into the hover
      this.ropeLen = Math.min(full, this.ropeLen + (full / ROPE_DOWN) * dt);
      if (this.ropeLen >= full - 0.05) {
        this.attached = true; this.liftT = 0;
        this.lieAt = p.pos.clone();
        p.frozen = true;
        this.winchSeat.pos.copy(p.pos);
        this.winchSeat.fwd.set(Math.sin(h.flight.yaw), 0, Math.cos(h.flight.yaw));
        p.sitOn(this.winchSeat);
        p.rig.setSkisVisible(false);
        h.model.loadRack(p.rig);
      }
    } else {
      this.liftT += dt;
      const k = smooth(0, ROPE_UP, this.liftT);
      this.ropeLen = Math.max(0.3, full * (1 - k));
      // you hang under the hook, swinging a little
      const sw = Math.sin(this.liftT * 2.1) * 0.12 * (1 - k);
      this.winchSeat.pos.set(_door.x + sw, _door.y - this.ropeLen - 0.9, _door.z + sw * 0.6);
      p.pos.copy(this.winchSeat.pos);
      if (this.liftT >= ROPE_UP) { this.rope.visible = false; this.intoCabin(); return; }
    }
    // the rope from the door arm down to the hook
    const r = this.rope;
    r.visible = true;
    r.position.set(_door.x, _door.y - this.ropeLen / 2, _door.z);
    r.scale.set(1, this.ropeLen, 1);
  }

  makeRope() {
    const g = new THREE.CylinderGeometry(0.02, 0.02, 1, 6);
    this.rope = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6 }));
    this.rope.frustumCulled = false;
    this.rope.visible = false;
    this.h.scene.add(this.rope);
  }

  // in the cabin, the pilot turns for home
  intoCabin() {
    const h = this.h, p = h.player, f = h.flight;
    if (!this.phase) return;
    p.viewBeforeRide = p.viewBeforeRide || p.view;
    p.view = 'third';
    p.rig.setSkisVisible(false);
    if (!h.model.rack.children.length) h.model.loadRack(p.rig);
    this.seatNow();
    p.sitOn(this.cabinSeat);
    p.pos.copy(this.cabinSeat.pos);
    p.frozen = false;
    this.attached = false;
    this.inCabin = true;
    // first shot of the ride: behind the left shoulder
    h.cam.yaw = f.yaw + Math.PI - 0.6; h.cam.pitch = 0.2; h.cam.dist = 19; h.cam.lastMouse = performance.now();
    h.placeCamera(0, true);
    h.pilot.home(h.home, 1.0);
    this.go('home');
    h.hud.flash('Picked up · flying you back to Legacy Village', 'good', 2600);
  }

  seatNow() {
    const h = this.h, y = h.flight.yaw;
    h.model.root.updateMatrixWorld(true);
    h.model.world(PASSENGER, this.cabinSeat.pos);
    this.cabinSeat.fwd.set(Math.sin(y), 0, Math.cos(y));
  }

  /** Is this one of the rescue's seats (the winch harness, the cabin)? */
  owns(seat) { return !!seat && (seat === this.cabinSeat || seat === this.winchSeat || seat === this.ambSeat); }

  // landed on the pad: step out at its edge
  finish() {
    const h = this.h, p = h.player;
    this.leaving = true;
    if (AMBULANCE_ON && this.amb?.ok) {
      // a short fade: you're carried into the ambulance waiting by the pad
      h.transition.fade(async () => {
        h.model.clearRack();
        this.inCabin = false;
        p.rig.root.visible = false; p.rig.gear.visible = false;
        this.amb.pos(this.ambSeat.pos); this.ambSeat.pos.y += 1.2;
        p.sitOn(this.ambSeat);
        this.amb.rider = true; this.amb.syncCol(); // (you're in it: its collider never pushes you off your seat)
        this.amb.plan();
        this.shotAt = null;
        this.go('ambulance');
        this.leaving = false;
      }).catch(() => this.fail());
      return;
    }
    h.transition.fade(async () => {
      const a = h.home.yaw + Math.PI / 2, d = PAD_R + 3;
      const x = h.home.x + Math.sin(a) * d, z = h.home.z + Math.cos(a) * d;
      p.seat = null;
      p.standUp(x, z, Math.atan2(h.home.x - x, h.home.z - z) + Math.PI);
      if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
      p.setSkisOn(false);
      p.rig.root.visible = true;
      p.rig.setSkisVisible(p.hasSkis);
      h.model.clearRack();
      this.cleanup();
      h.state = 'parked';
      if (AMBULANCE_ON) this.charge(); else h.hud.flash('Back in Legacy Village', 'good', 2600);
    }).catch(() => this.fail());
  }

  // a fixed shot by the pad, low, panning after the ambulance as it drives away
  ambShot(dt) {
    const h = this.h, cam = h.camera, a = this.amb.pos(_u);
    if (!this.shotAt) {
      const y = this.amb.yaw, sx = a.x + Math.cos(y) * 10 + Math.sin(y) * 7, sz = a.z - Math.sin(y) * 10 + Math.cos(y) * 7;
      this.shotAt = new THREE.Vector3(sx, h.snow(sx, sz) + 2.3, sz);
    }
    cam.position.copy(this.shotAt);
    cam.up.set(0, 1, 0);
    cam.lookAt(a.x, a.y + 1.4, a.z);
    cam.near = 0.1;
    cam.fov += (46 - cam.fov) * (1 - Math.exp(-dt * 2));
    cam.updateProjectionMatrix();
  }

  // the camera follows the ambulance, behind and above it, the mouse never fighting it
  ambChase(dt) {
    const h = this.h, cam = h.camera, a = this.amb.pos(_u), fx = Math.sin(this.amb.yaw), fz = Math.cos(this.amb.yaw);
    const want = _v.set(a.x - fx * 13, 0, a.z - fz * 13);
    want.y = Math.max(a.y + 4.8, h.snow(want.x, want.z) + 2);
    if (!this.chase) this.chase = this.shotAt ? this.shotAt.clone() : want.clone();
    this.chase.lerp(want, 1 - Math.exp(-dt * 2.2));
    cam.position.copy(this.chase);
    cam.up.set(0, 1, 0);
    cam.lookAt(a.x + fx * 5, a.y + 1.3, a.z + fz * 5);
    cam.near = 0.1;
    cam.fov += (55 - cam.fov) * (1 - Math.exp(-dt * 2));
    cam.updateProjectionMatrix();
  }

  // at the medical centre: carried in (a fade), treated, and released outside its door on foot, the bill paid
  homeByAmbulance() {
    const h = this.h;
    this.leaving = true;
    h.transition.fade(async () => { this.release(); }).catch(() => { this.release(); });
  }

  // out of the medical centre's door (else beside the pad, where the rescue ended; never the village plaza)
  release() {
    const h = this.h, p = h.player;
    this.sirenOff = true;
    h.audio?.setSiren?.({ on: false });
    p.seat = null;
    h.model.clearRack();
    const H = busRoads.hospital;
    if (H) { const x = H.ex + H.dirx * 2, z = H.ez + H.dirz * 2, hd = Math.atan2(-H.dirx, -H.dirz); p.standUp(x, z, hd); p.camYaw = hd + Math.PI; } // (facing the door)
    else { const a = h.home.yaw + Math.PI / 2, d = PAD_R + 3, x = h.home.x + Math.sin(a) * d, z = h.home.z + Math.cos(a) * d; p.standUp(x, z, Math.atan2(h.home.x - x, h.home.z - z)); }
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    p.setSkisOn(false);
    p.frozen = false;
    p.rig.root.visible = true; p.rig.gear.visible = true;
    p.rig.setSkisVisible(p.hasSkis);
    this.cleanup();
    h.state = 'parked';
    // (Oct 30, the user: "wake up in a hospital bed once you go to the hospital": game/hospitalroom.js, behind this fade)
    let inBed = false;
    if (H) { try { inBed = !!globalThis.__game?.hospitalWard?.admit?.(); } catch (e) { console.warn('hospital ward', e); } }
    this.charge(inBed ? 'Brought to the medical centre' : H ? 'Treated at the medical centre and released' : 'Rescue and ambulance');
  }

  // the ambulance fee, straight off your balance (it can go below zero: shops, lifts and passes then refuse)
  charge(what = 'Rescue and ambulance') {
    const h = this.h, fee = rescueFee();
    if (this.free) { this.free = false; h.hud.flash(`${what} · free: it was not your fault`, 'good', 4200); return; }
    save.money -= fee;
    save.rescues = (save.rescues | 0) + 1;
    writeSave();
    h.hud.setMoney?.(save.money, -fee);
    h.audio?.play('cash');
    h.hud.flash(`${what} · -$${fee} · the next one costs $${rescueFee()}`, 'bad', 4200);
  }

  /** Give up: a fade, and you come round at the medical centre (only the village fallback if even that fails). */
  fail() {
    const h = this.h, fb = this.fallback;
    this.fallback = null;
    if (this.failing) return;
    this.failing = true;
    const done = () => { this.failing = false; };
    h.transition.fade(async () => {
      try {
        h.abort(); // (ends the rescue too, puts the helicopter back on its pad)
        this.release();
      } catch (e) {
        console.warn('rescue fallback', e);
        try { fb?.(); } catch (e2) { console.warn('rescue fallback', e2); }
      }
    }).then(done, done);
  }

  /** End the rescue (heli.abort / finish). */
  cleanup() {
    const p = this.h.player;
    if (this.rope) this.rope.visible = false;
    this.amb?.hide();
    this.h.audio?.setSiren?.({ on: false });
    this.sirenOff = false;
    if (this.phase) p.frozen = false;
    this.phase = null; this.spot = null; this.attached = false; this.inCabin = false;
    this.boarding = false; this.leaving = false; this.ropeLen = 0; this.shot.ready = false; this.watch = null; this.chase = null;
  }
}
