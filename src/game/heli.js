// Heli-skiing: a helipad in Legacy Village where, for a price, you take a helicopter and fly it yourself
// to untouched peaks far out in the ranges. You can set it down on any open snow that is flat enough
// (under ~17 degrees, clear of trees, buildings, nets and lift lines: the HUD says "Land here" / "Too steep
// to land" / "Trees below"); the skids settle, the rotor idles and E gets you out, on skis where there is a
// slope, on foot on the flat. The landed helicopter waits where you left it (E beside it to fly on, free);
// once you are ~650 m away (skied off, took a lift) its pilot flies it home to the pad, and from the pad
// you can call it back early. Over ground too steep to land you can still hover low and slow and jump out
// (E): it then flies itself home at once. While you fly, your skier sits in the pilot's seat (the player
// stays in 'sit' mode on a seat that moves with the cabin, so the terrain and trees stream around it).
//   src/game/heli/flight.js   flight model + the pilot who flies it home
//   src/game/heli/model.js    airframe (Meshy), spinning rotors + blur discs, lights, ski basket, landing light
//   src/game/heli/pad.js      the helipad, edge lights, windsock, the heli-ski hut and its sign
//   src/game/heli/hud.js      flight HUD      src/game/heli/zones.js  drop zones      src/game/heli/fx.js  effects
import * as THREE from 'three';
import { world as WORLD } from '../world/world.js';
import { transition as TRANSITION } from '../ui/transition.js';
import { nightUniform } from '../world/village.js';
import { terrainUniforms } from '../world/terrain.js'; // read-only: how hard it is snowing (the landing light beam)
import { save } from './economy.js';
import { Flight, HomePilot, wrapPi, FLIGHT } from './heli/flight.js';
import { HeliModel, ANCHORS, FRAME } from './heli/model.js';
import { Helipad, chooseSite, PAD_R } from './heli/pad.js';
import { HeliHud } from './heli/hud.js';
import { Downwash, SmokeFlare } from './heli/fx.js';
import { dropZones } from './heli/zones.js';
import { Rescue } from './heli/rescue.js';
import { collideHeli } from './heli/collide.js';
import { travelPicker, fmtMin } from '../ui/travel.js'; // the flight planner
import { freeCourses } from '../modes/parkour/freeworld.js'; // the World Racing courses on the mountains
import { CARD_DIALOG } from '../ui/hud.js';

export const HELI_PRICE = 150;
const JUMP_AGL = 6;          // jump out from at most this high (skids above the snow, m)...
const JUMP_SPEED = 6;        // ...and this slow (m/s)
const CAM_DIST = 17;
const IDLE_RPM = 0.6;        // rotor speed at ground idle (landed, nobody pulling up)
const IDLE_WAIT = 25;        // a helicopter parked out on the mountain idles this long (s), then shuts down
const AWAY_RETURN = 650;     // ...and flies itself home once you are this far from it (m)
const LAND_AGL = 45;         // landing advice below this height (m)...
const LAND_SPEED = 14;       // ...and this airspeed (m/s)
// Landing anywhere (getting out, the parked helicopter waiting for you): verified in the game 2026-10-26.
// false restores the old flow (only hover low and jump out; it flies home at once).
export const LAND_ANYWHERE = true;
// Soft collisions while you fly (trees, buildings, nets, lift towers and ropes) and the rescue helicopter instead
// of the wipeout fade (free ride): verified in the game 2026-10-26; false switches either back off.
export const HELI_COLLIDE = true;
export const HELI_RESCUE = true;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();
const _hub = new THREE.Vector3(), _light = new THREE.Color();

export class Heli {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.models        loaded GLTFs: heli_body (Meshy airframe), patrol_hut (the hut); both optional
   * @param {object} o.player        Player
   * @param {object} o.input         Input
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {object} o.hud           HUD (dialog, flash)
   * @param {object} o.audio         Audio (setHeli, play)
   * @param {object} [o.spray]       snow spray (src/fx/snowfx.js) for the rotor downwash
   * @param {object} [o.world]
   * @param {object} o.layout
   * @param {Array} o.colliders      shared collider list (the pad, hut, windsock and parked helicopter join it)
   * @param {(amount: number) => boolean} o.spend
   * @param {object} [o.transition]  screen transitions (fade while boarding)
   */
  constructor({ scene, models, player, input, camera, hud, audio, spray, world = WORLD, layout, colliders, spend, transition = TRANSITION, lifts = null }) {
    Object.assign(this, { scene, models, player, input, camera, hud, audio, spray, world, layout, colliders, spend, transition, lifts });
    this.ground = (x, z) => world.groundHeight(x, z);
    this.snow = (x, z) => world.height(x, z);
    const site = chooseSite(layout, colliders);
    this.pad = new Helipad({ scene, models, colliders, site, price: HELI_PRICE });
    this.home = { x: this.pad.x, z: this.pad.z, y: this.pad.y, yaw: this.pad.yaw };
    this.model = new HeliModel(models);
    this.model.addTo(scene);
    this.flight = new Flight(FRAME);
    this.flight.place(this.home.x, this.home.z, this.home.yaw, this.ground);
    this.pilot = new HomePilot(this.flight);
    this.hudUI = new HeliHud();
    this.smoke = new SmokeFlare(scene);
    this.washFx = new Downwash(scene);
    // the parked helicopter is solid (cabin + tail); flying, its colliders move out of the way
    this.cabinCol = { x: 1e9, z: 1e9, r: 2.1 };
    this.tailCol = { x: 1e9, z: 1e9, r: 0.7 };
    colliders.push(this.cabinCol, this.tailCol);

    this.state = 'parked';    // parked | boarding | flying | auto
    this.rpm = 0;
    this.time = 0;
    this.ctl = { fwd: 0, turn: 0, lift: 0 };
    this.seat = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1) };
    this.cam = { yaw: 0, pitch: 0.22, dist: CAM_DIST, lastMouse: 0, fov: 62, look: new THREE.Vector3() };
    this.handoff = 0;         // camera blend back to the skier after jumping out (s left)
    this.handPos = new THREE.Vector3(); this.handQuat = new THREE.Quaternion(); this.handFov = 62;
    this.camPose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 62 }; // the last heli camera shot
    this.parkSkier = false;
    this.flights = 0;
    this.jump = { ok: false, label: '', warn: false, onPad: false, landed: false };
    this.land = { ok: false, label: '', warn: false, pad: false, hold: 0, t: 0 }; // the spot below (landCheck)
    this.away = null;         // parked out on the mountain: { x, z } (null: on its pad or flying)
    this.awayT = 0;           // seconds since you got out there
    this.landedT = 0;         // seconds on the skids with nobody pulling up (the rotor drops to idle)
    this.spun = false;        // the turbine has come up to flight power since you boarded
    this._corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
    this.streamPos = new THREE.Vector3(this.home.x, 0, this.home.z);
    this.prompts = {
      book: { label: `Heli-ski · fly to the far peaks · $${HELI_PRICE}`, act: () => this.openDialog() },
      away: { label: 'Heli-ski · the helicopter is flying back', act: () => this.hud.flash('The helicopter is on its way back to the pad', 'good', 2200) },
      call: { label: 'Heli-ski · call the helicopter back to the pad', act: () => this.callHome() },
      again: { label: 'Fly the helicopter', act: () => this.board() },
    };
    this.wp = { label: '', ang: 0, dist: 0 };
    dropZones(); // (laid out once, while the game loads)
    this.rescue = new Rescue(this);
    this.colEnv = { vegetation: player.vegetation, colliders, skip: [this.cabinCol, this.tailCol], lifts, ground: this.ground };
    this.bump = 0;
    this.place();
  }

  /** The rescue helicopter is on its way / carrying you home. */
  get rescuing() { return this.state === 'rescue'; }

  /**
   * After a crash in free ride: the helicopter comes to pick you up and flies you to the village. false when it
   * can't (switched off, a flight under way, no way to reach you): main.js then uses the old fade.
   * @param {{fallback?: () => void}} [o]  called if the rescue has to give up half way
   */
  rescueMe(o = {}) {
    if (!HELI_RESCUE) return false;
    try { return this.rescue.start(o); } catch (e) { console.warn('rescue', e); this.rescue.cleanup(); if (this.state === 'rescue') this.abort(); return false; }
  }

  /** You are flying (seated in the cabin with the controls). */
  get active() { return this.state === 'flying'; }
  /** Airspeed (m/s). */
  get speed() { return this.flight.speed; }

  // ------------------------------------------------------------------ booking + boarding
  /** E prompt at the helipad (or null). */
  interaction(pos) {
    if (this.state === 'flying' || this.state === 'boarding' || this.state === 'rescue') return null;
    // parked out where you landed: climb back in (no charge, it is still your trip)
    const f = this.flight;
    if (this.state === 'parked' && this.away && Math.hypot(pos.x - f.pos.x, pos.z - f.pos.z) < 9) return this.prompts.again;
    if (!this.pad.near(pos)) return null;
    if (this.state === 'auto') return this.prompts.away;
    return this.away ? this.prompts.call : this.prompts.book;
  }

  /** Send a helicopter parked out on the mountain home to its pad (its pilot flies it). */
  callHome(quiet = false) {
    if (this.state !== 'parked' || !this.away) return;
    this.away = null;
    this.state = 'auto';
    this.pilot.home(this.home, 0.8);
    if (!quiet) this.hud.flash('The helicopter is on its way back to the pad', 'good', 2200);
  }

  // The heli-ski desk: a pilot's chart of the drop zones (ui/travel.js). Pick one as your flight plan (the compass
  // and the red smoke flare lead you there) or a free flight; either way you fly it yourself, same price.
  openDialog() {
    const lock = () => this.input.lock();
    if (!CARD_DIALOG) return this.openDialogClassic();
    if (!this.player.hasSkis) {
      this.hud.dialog('Heli-Ski', 'You will need skis up there. Rent a pair at the ski shop in the village, then come back.', [{ label: 'OK', act: lock }], { kicker: 'HELI-SKI BASE' });
      return;
    }
    const broke = save.money < HELI_PRICE, H = this.home;
    const eta = (km) => (40 + (km * 1000) / 42) / 60; // spool-up and climb, then ~150 km/h
    const fly = (zone) => { if (this.spend(HELI_PRICE)) { this.plan = zone; this.board(); } lock(); };
    const dests = dropZones().map((z) => ({ z, km: Math.hypot(z.x - H.x, z.z - H.z) / 1000 })).sort((a, b) => a.km - b.km)
      .map(({ z, km }) => ({ name: z.name, x: z.x, z: z.z, km, zone: z, dot: 'peak', meta: `${km.toFixed(1)} km · ${fmtMin(eta(km))} · ${z.vertical} m vertical`, act: () => fly(z) }));
    // the race courses on the mountains: the heli sets you down beside the start house (E there races the course)
    try {
      const courses = freeCourses().map((e) => ({ e, km: Math.hypot(e.heli.x - H.x, e.heli.z - H.z) / 1000 })).sort((a, b) => a.km - b.km);
      for (const { e, km } of courses) {
        dests.push({ name: e.name, x: e.heli.x, z: e.heli.z, km, zone: e.heli, dot: 'peak', tag: 'RACE', meta: `Race course · ${e.D.label} · ${km.toFixed(1)} km · ${fmtMin(eta(km))}`, act: () => fly(e.heli) });
      }
    } catch (err) { console.warn('heli: race courses', err); }
    dests.push({ name: 'Free flight', dot: 'free', meta: 'No flight plan · fly anywhere', act: () => fly(null) });
    const cell = (k, v, u) => `<div><span>${k}</span><b>${v}<small>${u}</small></b></div>`;
    travelPicker({ hud: this.hud, player: this.player, audio: this.audio }).open({
      mode: 'chart', title: 'Heli-Ski', kicker: 'FLIGHT PLANNER', listHead: 'DROP ZONES', go: 'FLY',
      sub: `Pick a drop zone: the compass and a red smoke flare lead the way · <b>you are the pilot</b>`,
      home: { x: H.x, z: H.z }, dests,
      goLabel: () => (broke ? `$${HELI_PRICE} · you have $${save.money}` : `Fly · $${HELI_PRICE}`),
      goDisabled: () => broke,
      plan: (d) => (d.zone
        ? `<div class="tp-grid">${cell('DISTANCE', d.km.toFixed(1), 'KM')}${cell('FLIGHT', Math.max(1, Math.round(eta(d.km))), 'MIN')}${cell('VERTICAL', d.zone.vertical, 'M')}</div>`
        : '') // (free flight: its row says it all)
        + (broke ? `<div class="tp-note bad">You need $${HELI_PRICE} · you have $${save.money}</div>` : ''),
    });
  }

  // the plain booking dialog (while CARD_DIALOG is off)
  openDialogClassic() {
    const lock = () => this.input.lock();
    if (!this.player.hasSkis) {
      this.hud.dialog('Heli-Ski', 'You will need skis up there. Rent a pair at the ski shop in the village, then come back.', [{ label: 'OK', act: lock }]);
      return;
    }
    const broke = save.money < HELI_PRICE;
    this.hud.dialog('Heli-Ski', 'Untouched powder on the far peaks. You take the controls: fly anywhere you like, hover low over fresh snow and jump out to ski.', [
      { label: 'Fly the helicopter', sub: broke ? `$${HELI_PRICE} · you have $${save.money}` : `$${HELI_PRICE} · you are the pilot`, disabled: broke,
        act: () => { if (this.spend(HELI_PRICE)) this.board(); lock(); } },
      { label: 'Not now', act: lock },
    ]);
  }

  board() {
    if (this.state !== 'parked') return;
    this.state = 'boarding';
    this.transition.fade(async () => {
      const p = this.player;
      if (!p.skisOn) p.setSkisOn(true);
      p.viewBeforeRide = p.view;
      p.view = 'third';
      p.rig.setSkisVisible(false);
      this.model.loadRack(p.rig);
      this.updateSeat();
      p.sitOn(this.seat);
      p.pos.copy(this.seat.pos);
      this.state = 'flying';
      this.away = null;
      this.landedT = 0;
      this.spun = this.rpm >= FLIGHT.POWER;
      this.flights++;
      // first shot: from behind the left shoulder, the rotor starting up
      const f = this.flight;
      this.cam.yaw = f.yaw + Math.PI - 0.55; this.cam.pitch = 0.16; this.cam.dist = CAM_DIST - 3; this.cam.lastMouse = performance.now();
      this.handoff = 0;
      this.placeCamera(0, true);
      this.hudUI.show(true, this.flights === 1 ? 16000 : 9000);
      this.audio.play('board');
    }).catch(() => { if (this.state === 'boarding') this.state = 'parked'; });
  }

  // ------------------------------------------------------------------ getting out
  // Where you'd land: the snow below the right door. Is it somewhere to ski?
  checkJump() {
    const f = this.flight, J = this.jump;
    J.ok = false; J.warn = false; J.label = ''; J.landed = false;
    const door = this.model.world(ANCHORS.door, _v);
    const onPad = Math.hypot(f.pos.x - this.home.x, f.pos.z - this.home.z) < PAD_R - 2;
    J.onPad = onPad && f.landed;
    // set down anywhere else: step out beside the door
    if (LAND_ANYWHERE && f.landed && !J.onPad) { J.ok = true; J.landed = true; J.label = 'Get out'; return J; }
    if (f.speed > JUMP_SPEED) return J;
    if (f.agl > JUMP_AGL) {
      const nearPad = Math.hypot(f.pos.x - this.home.x, f.pos.z - this.home.z) < 60;
      if (f.agl < 40 && f.speed < 3 && !nearPad) { J.label = `Hover lower to jump out (below ${JUMP_AGL} m)`; J.warn = false; }
      return J;
    }
    if (J.onPad) { J.ok = true; J.label = 'Get out'; return J; }
    // flat enough to land: set it down (SHIFT) and get out instead of jumping
    if (this.land.ok) return J;
    const e = 2, g = Math.hypot(this.snow(door.x + e, door.z) - this.snow(door.x - e, door.z), this.snow(door.x, door.z + e) - this.snow(door.x, door.z - e)) / (2 * e);
    if (g > 0.95) { J.label = 'Too steep to jump out here'; J.warn = true; return J; }
    if (this.player.vegetation?.collide(door.x, door.z, 1.2)) { J.label = 'Trees below · find open snow'; J.warn = true; return J; }
    for (const c of this.colliders) {
      if (c === this.cabinCol || c === this.tailCol) continue;
      const reach = (c.r ?? Math.hypot(c.hw, c.hd)) + 1.2;
      if (Math.abs(door.x - c.x) < reach && Math.abs(door.z - c.z) < reach) { J.label = 'Too close to buildings'; J.warn = true; return J; }
    }
    J.ok = true; J.label = 'Jump out and ski';
    return J;
  }

  jumpOut() {
    const f = this.flight, p = this.player;
    const door = this.model.world(ANCHORS.door, _v).clone();
    this.saveHandoff();
    const onPad = this.jump.onPad;
    // face down the fall line (or the way the helicopter points on flat ground)
    const e = 3, gx = (this.snow(door.x + e, door.z) - this.snow(door.x - e, door.z)) / (2 * e), gz = (this.snow(door.x, door.z + e) - this.snow(door.x, door.z - e)) / (2 * e);
    const heading = Math.hypot(gx, gz) > 0.05 && !onPad ? Math.atan2(-gx, -gz) : f.yaw;
    p.seat = null;
    p.standUp(door.x, door.z, heading);
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    // the skier's camera starts on the side we were looking from, then swings behind once settled
    const cp = this.camPose.pos;
    p.camYaw = Math.atan2(cp.x - door.x, cp.z - door.z);
    p.camPitch = -0.28;
    p.lastMouse = performance.now() + 600;
    p.rig.setSkisVisible(p.hasSkis);
    this.model.clearRack();
    if (onPad) {
      // stepped out on the helipad: skis back on your shoulder, the rotor winds down
      p.setSkisOn(false);
      this.state = 'parked';
      this.hud.flash('Thanks for flying · see you on the next heli drop', 'good', 2400);
    } else {
      // a drop from the skid onto the snow, skis on, ready to go
      const gy = this.world.groundHeight(door.x, door.z, door.y + 1);
      const drop = Math.max(0, f.pos.y - FRAME.cgH - gy);
      if (drop > 0.35) {
        p.pos.y = gy + drop;
        p.vel.set(0, -0.5, 0);
        p.parked = false;
        p.takeoff?.('terrain');
        this.parkSkier = true; // stand still after the landing until you push off
      }
      this.audio.play('jump');
      this.plan = null; // (the trip is over: it flies home)
      this.state = 'auto';
      this.pilot.home(this.home, 1.6);
      this.hud.flash('Fresh powder · press W to go', 'gold', 2600);
    }
    this.hudUI.show(false);
  }

  // Landed out on the mountain: step out beside the right door, on skis where there is a slope to ski, on
  // foot on the flat. The helicopter stays where it is, its rotor idling, until you fly on or leave it.
  getOut() {
    const f = this.flight, p = this.player;
    const door = this.model.world(ANCHORS.door, _v);
    const x = door.x - Math.cos(f.yaw) * 1.6, z = door.z + Math.sin(f.yaw) * 1.6; // a step out to the right
    this.saveHandoff();
    const e = 3, gx = (this.snow(x + e, z) - this.snow(x - e, z)) / (2 * e), gz = (this.snow(x, z + e) - this.snow(x, z - e)) / (2 * e);
    const heading = Math.hypot(gx, gz) > 0.05 ? Math.atan2(-gx, -gz) : Math.atan2(-Math.cos(f.yaw), Math.sin(f.yaw));
    p.seat = null;
    p.standUp(x, z, heading);
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    const cp = this.camPose.pos;
    p.camYaw = Math.atan2(cp.x - x, cp.z - z);
    p.camPitch = -0.28;
    p.lastMouse = performance.now() + 600;
    p.rig.setSkisVisible(p.hasSkis);
    this.model.clearRack();
    const flat = p.isFlatHere();
    p.setSkisOn(!flat && p.hasSkis);
    if (!flat) { p.parked = true; p.vel.set(0, 0, 0); }
    this.state = 'parked';
    this.away = { x: f.pos.x, z: f.pos.z };
    this.awayT = 0;
    f.hold = 0;
    this.audio.play('board');
    this.hud.flash(flat ? 'Landed · the helicopter waits here' : 'Fresh powder · W to go · the helicopter waits here', 'gold', 2800);
    this.hudUI.show(false);
  }

  /**
   * End a flight at once (main.js: before teleporting to the village / main menu). The helicopter is
   * back on its pad, rotors stopped.
   */
  abort() {
    const p = this.player;
    if (this.rescue?.active) {
      const seated = this.rescue.owns(p.seat);
      this.rescue.cleanup();
      if (seated) {
        const a = this.home.yaw + Math.PI / 2, d = PAD_R + 3;
        const x = this.home.x + Math.sin(a) * d, z = this.home.z + Math.cos(a) * d;
        p.standUp(x, z, Math.atan2(this.home.x - x, this.home.z - z));
        p.rig.root.visible = true; p.rig.gear.visible = true;
      }
      if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
      p.rig.setSkisVisible(p.hasSkis);
    }
    if (this.state === 'flying' || this.state === 'boarding') {
      if (p.seat === this.seat) {
        // step out at the edge of the pad, clear of the rotor, facing the helicopter (the camera stays
        // outside its body); callers that move you on (back to the village, the menu) teleport after this
        const a = this.home.yaw + Math.PI / 2, d = PAD_R + 3;
        const x = this.home.x + Math.sin(a) * d, z = this.home.z + Math.cos(a) * d;
        p.standUp(x, z, Math.atan2(this.home.x - x, this.home.z - z));
      }
      if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
      p.rig.setSkisVisible(p.hasSkis);
      this.hudUI.show(false);
    }
    this.model.clearRack();
    this.state = 'parked';
    this.away = null;
    this.plan = null;
    this.flight.hold = 0;
    this.rpm = 0;
    this.handoff = 0;
    this.place();
  }

  // park on the pad, shut down
  place() {
    this.flight.place(this.home.x, this.home.z, this.home.yaw, this.ground);
    this.pilot.phase = 'idle';
    this.syncModel();
  }

  // ------------------------------------------------------------------ per frame
  /**
   * @param {number} dt     0 while the game is paused
   * @param {object|null} input  the Input while the player may fly (null in menus, panels, the map)
   */
  update(dt, input) {
    const f = this.flight;
    if (dt <= 0) { this.audio.setHeli?.({ rpm: this.rpm, paused: true }); return; }
    this.time += dt;
    const flying = this.state === 'flying';

    // ---- controls: your keys, the pilot flying home, or nothing (parked)
    const c = this.ctl;
    c.fwd = c.turn = c.lift = 0;
    if (flying && input) {
      const d = (k1, k2) => input.down(k1) || (k2 && input.down(k2));
      c.fwd = (d('KeyW', 'ArrowUp') ? 1 : 0) - (d('KeyS', 'ArrowDown') ? 1 : 0);
      c.turn = (d('KeyA', 'ArrowLeft') ? 1 : 0) - (d('KeyD', 'ArrowRight') ? 1 : 0);
      c.lift = (d('Space') ? 1 : 0) - (d('ShiftLeft', 'ShiftRight') ? 1 : 0);
    } else if (this.state === 'rescue') {
      Object.assign(c, this.rescue.controls(dt));
    } else if (this.state === 'auto') {
      Object.assign(c, this.pilot.update(dt));
      // somebody standing on the pad: wait above it
      if (this.pilot.phase === 'down' && f.agl < 14 && this.player.mode !== 'sit' && Math.hypot(this.player.pos.x - this.home.x, this.player.pos.z - this.home.z) < PAD_R + 2) c.lift = Math.max(c.lift, 0);
      if (this.pilot.phase === 'landed') this.state = 'parked';
      // out of sight far away: it has made it home
      const cam = this.camera.position;
      if (Math.hypot(f.pos.x - cam.x, f.pos.z - cam.z) > 1300 && Math.hypot(this.home.x - cam.x, this.home.z - cam.z) > 900) { this.state = 'parked'; this.rpm = 0; this.place(); }
    }

    // parked out on the mountain: it idles a while, then shuts down; once you are far away its pilot flies it home
    if (this.state === 'parked' && this.away) {
      this.awayT += dt;
      const p = this.player.pos;
      if (Math.hypot(p.x - f.pos.x, p.z - f.pos.z) > AWAY_RETURN) this.callHome(true);
    }

    // ---- turbine + rotor: spool up for a flight, idle on the skids, wind down when parked
    let want = this.state === 'auto' || (this.state === 'rescue' && !this.rescue.grounded) ? 1 : 0;
    if (flying) {
      if (!f.landed || c.lift > 0.05) this.landedT = 0; else this.landedT += dt;
      if (this.rpm >= FLIGHT.POWER) this.spun = true;
      want = LAND_ANYWHERE && this.spun && f.landed && this.landedT > 1.2 ? IDLE_RPM : 1;
    } else if (this.state === 'parked' && this.away && this.awayT < IDLE_WAIT) want = IDLE_RPM;
    const sdt = this.state === 'rescue' && this.rescue.fast ? dt * 4 : dt; // (SPACE speeds a rescue up)
    if (want > this.rpm) this.rpm = Math.min(1, this.rpm + sdt * (0.07 + 0.75 * this.rpm * (1.04 - this.rpm))); // ~5 s to lift-off power
    else if (want < this.rpm) this.rpm = Math.max(0, this.rpm - dt * (0.03 + 0.1 * this.rpm));

    if (this.state !== 'parked' || !f.landed || this.rpm > 0) {
      f.step(dt, c, this.ground, this.rpm);
      // hold SPACE during a rescue: it all runs four times as fast (the pilot steering every step)
      if (this.state === 'rescue' && this.rescue.fast) for (let k = 0; k < 3 && this.state === 'rescue'; k++) { Object.assign(c, this.rescue.controls(dt)); f.step(dt, c, this.ground, this.rpm); }
      // you fly into a tree, a roof, a net, a lift: it bumps off softly, nothing breaks
      this.bump = flying && HELI_COLLIDE ? collideHeli(f, this.colEnv, dt) : 0;
    }
    this.syncModel();

    // ---- you in the cabin
    if (flying) {
      this.updateSeat();
      const p = this.player;
      p.pos.copy(this.seat.pos);
      p.rig.root.position.copy(this.seat.pos);
      p.rig.root.quaternion.copy(f.quat);
      p.rig.root.updateMatrixWorld(true);
      // stream the world ahead of the helicopter
      const ahead = Math.min(2, 140 / Math.max(1, f.speed));
      this.streamPos.set(f.pos.x + f.vel.x * ahead, f.pos.y, f.pos.z + f.vel.z * ahead);
      // can it land here? (a few times a second; over trees, buildings, nets or a lift line it stays up)
      this.land.t -= dt;
      if (this.land.t <= 0) { this.land.t = 0.12; this.landCheck(); }
      f.hold = this.land.hold;
      // get out (landed) / jump out (hovering low over a slope too steep to land on)
      const J = this.checkJump();
      if (input?.hit('KeyE') && J.ok && (this.spun || f.landed)) { if (J.landed) this.getOut(); else this.jumpOut(); }
      else {
        this.placeCamera(dt, false, input);
        const L = this.land;
        let prompt = null, key = null, warn = false;
        if (!this.spun) prompt = `Starting the turbine · rotor ${Math.round(this.rpm * 100)}%`;
        else if (f.landed) { prompt = J.ok ? 'Get out · SPACE lift off' : 'Lift off'; key = J.ok ? 'E' : 'SPACE'; }
        else if (J.ok) { prompt = J.label; key = 'E'; }
        else if (L.label) { prompt = L.label; key = L.ok ? 'SHIFT' : null; warn = L.warn; }
        else if (J.label) { prompt = J.label; warn = J.warn; }
        this.hudUI.update({ speed: f.speed, agl: f.agl, vs: f.vel.y, rpm: this.rpm, prompt, key, warn });
      }
    } else if (this.state === 'rescue') { f.hold = 0; this.rescue.after(dt, input); }
    else { this.streamPos.copy(this.player.pos); f.hold = 0; }
    // after the drop from the skid: once on the snow, stand still until you push off
    if (this.parkSkier) {
      const p = this.player;
      if (p.mode !== 'ski') this.parkSkier = false;
      else if (!p.air) { p.parked = true; p.vel.set(0, 0, 0); this.parkSkier = false; }
    }

    // ---- camera blend back to the skier after jumping out
    if (this.handoff > 0) {
      this.handoff = Math.max(0, this.handoff - dt);
      const k = smooth(0, 1, 1 - this.handoff / 1.4), cam = this.camera;
      cam.position.lerpVectors(this.handPos, cam.position, k);
      _q.copy(cam.quaternion); // (slerpQuaternions writes its target first)
      cam.quaternion.slerpQuaternions(this.handQuat, _q, k);
      cam.fov += (this.handFov - cam.fov) * (1 - k);
      cam.updateProjectionMatrix();
    }

    this.updateFx(dt);
  }

  // ------------------------------------------------------------------ landing anywhere
  // The spot under the helicopter: flat enough for the skids and clear of trees, buildings, nets and lift lines?
  // Writes this.land { ok, label, warn, pad, hold (min hover height while it is not ok, 0 = may touch down) }.
  landCheck() {
    const f = this.flight, L = this.land;
    L.ok = false; L.warn = true; L.label = ''; L.hold = 0; L.pad = false;
    if (!LAND_ANYWHERE || f.landed || f.agl > LAND_AGL || f.speed > LAND_SPEED) { L.warn = false; return L; }
    const x = f.pos.x, z = f.pos.z, fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
    if (Math.hypot(x - this.home.x, z - this.home.z) < PAD_R + 3) { L.ok = true; L.pad = true; L.warn = false; L.label = 'Land on the helipad'; return L; }
    // trees (and big boulders) under the rotor disc or the tail: stay above the treetops
    const veg = this.player.vegetation;
    const t = veg && (veg.collide(x + fx * 1.2, z + fz * 1.2, FRAME.rotorR + 2.5, 1.2) || veg.collide(x - fx * 4.6, z - fz * 4.6, 3, 1.2));
    if (t) { const tree = t.type !== undefined; L.label = tree ? 'Trees below · find open snow' : 'Rocks below · find open snow'; L.hold = tree ? 20 : 4; return L; }
    // buildings, lift stations and towers, safety nets, signs (the shared colliders)
    for (const c of this.colliders) {
      if (c === this.cabinCol || c === this.tailCol) continue;
      const size = c.r ?? Math.hypot(c.hw, c.hd), reach = size + FRAME.rotorR + 1.5;
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > reach || Math.abs(dz) > reach || dx * dx + dz * dz > reach * reach) continue;
      L.label = c.net ? 'Safety nets below' : size > 1.5 ? 'Too close to buildings' : 'Obstacles below · find open snow';
      L.hold = c.net ? 5 : size > 1.5 ? 14 : 4;
      return L;
    }
    // a lift line (cables overhead) or a cleared lift strip
    const cor = this.world.corridorAt(x, z, this._corr);
    if (cor.kind === 'lift' && cor.d < 3) { L.label = 'Lift line below'; L.hold = 16; return L; }
    // the slope under the skids
    const slope = Math.max(f.slopeAt(this.ground), this.skidSlope());
    if (slope > FLIGHT.LAND_SLOPE) { L.label = f.agl > JUMP_AGL ? 'Too steep to land · hover low to jump out' : 'Too steep to land'; return L; }
    L.ok = true; L.warn = false; L.label = 'Land here';
    return L;
  }
  // steepest tilt the skids would take on the snow right below (front-back and side to side)
  skidSlope() {
    const f = this.flight, fx = Math.sin(f.yaw), fz = Math.cos(f.yaw), lx = fz, lz = -fx, p = f.pos;
    const hl = f.skidL / 2 + 0.6, hw = f.skidW / 2 + 0.4, z0 = f.skidZ;
    const h = (a, b) => this.ground(p.x + fx * a + lx * b, p.z + fz * a + lz * b);
    const fl = h(z0 + hl, hw), fr = h(z0 + hl, -hw), bl = h(z0 - hl, hw), br = h(z0 - hl, -hw);
    return Math.max(Math.abs((bl + br) - (fl + fr)) / 2 / (hl * 2), Math.abs((fl + bl) - (fr + br)) / 2 / (hw * 2));
  }

  // the cabin's seat (and where the skier's body goes) in the world
  updateSeat() {
    this.model.root.updateMatrixWorld(true);
    this.model.world(ANCHORS.seat, this.seat.pos);
    const y = this.flight.yaw;
    this.seat.fwd.set(Math.sin(y), 0, Math.cos(y));
  }

  syncModel() {
    const f = this.flight, root = this.model.root;
    root.position.copy(f.pos);
    root.quaternion.copy(f.quat);
    root.updateMatrixWorld(true);
    // solid only while it stands still somewhere
    const still = this.state === 'parked' && f.landed;
    const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
    this.cabinCol.x = still ? f.pos.x + fx * 0.9 : 1e9; this.cabinCol.z = still ? f.pos.z + fz * 0.9 : 1e9;
    this.tailCol.x = still ? f.pos.x - fx * 4.6 : 1e9; this.tailCol.z = still ? f.pos.z - fz * 4.6 : 1e9;
  }

  // chase camera: behind and above, mouse to look around (it drifts back behind when you let go)
  placeCamera(dt, snap, input) {
    const f = this.flight, C = this.cam, cam = this.camera, now = performance.now();
    if (input) {
      const sens = 0.0022 * (this.player.sensitivity || 1);
      if (input.mdx || input.mdy) C.lastMouse = now;
      C.yaw -= input.mdx * sens;
      C.pitch = clamp(C.pitch + input.mdy * sens, -0.15, 1.2);
      if (input.wheel) C.dist = clamp(C.dist + input.wheel * 1.5, 9, 45);
    }
    if (now - C.lastMouse > 1500 && !snap) {
      const behind = f.yaw + Math.PI;
      C.yaw += wrapPi(behind - C.yaw) * (1 - Math.exp(-dt * 1.6));
      C.pitch += (0.2 + Math.min(0.12, f.agl * 0.002) - C.pitch) * (1 - Math.exp(-dt * 1.2));
    }
    const dist = C.dist + f.speed * 0.07;
    const focus = _w.copy(f.pos).add(_u.set(f.vel.x * 0.12, 1.1, f.vel.z * 0.12));
    const cp = Math.cos(C.pitch);
    const pos = _v.set(focus.x + Math.sin(C.yaw) * cp * dist, focus.y + Math.sin(C.pitch) * dist, focus.z + Math.cos(C.yaw) * cp * dist);
    const gy = this.snow(pos.x, pos.z) + 1.6;
    if (pos.y < gy) pos.y = gy;
    // rotor buzz + a little turbulence at speed
    const t = this.time, vib = 0.008 * this.rpm + 0.012 * smooth(30, 60, f.speed);
    pos.x += Math.sin(t * 61) * vib; pos.y += Math.sin(t * 53 + 1) * vib; pos.z += Math.sin(t * 47 + 2) * vib;
    cam.position.copy(pos);
    cam.up.set(0, 1, 0);
    C.look.copy(focus).addScaledVector(_u.set(Math.sin(f.yaw), 0, Math.cos(f.yaw)), 3);
    cam.lookAt(C.look);
    cam.near = 0.1;
    const fov = 62 + f.speed * 0.12;
    C.fov = snap ? fov : C.fov + (fov - C.fov) * (1 - Math.exp(-dt * 3));
    cam.fov = C.fov;
    cam.updateProjectionMatrix();
    this.camPose.pos.copy(cam.position); this.camPose.quat.copy(cam.quaternion); this.camPose.fov = cam.fov;
  }

  // blend from the last helicopter shot (this frame the camera already follows the skier)
  saveHandoff() {
    this.handPos.copy(this.camPose.pos);
    this.handQuat.copy(this.camPose.quat);
    this.handFov = this.camPose.fov;
    this.handoff = 1.4;
  }

  updateFx(dt) {
    const f = this.flight, night = nightUniform.value, rpm = this.rpm;
    // lamps, rotors, landing light (on at night whenever it's flying)
    this.model.update(dt, { rpm, night, time: this.time, lamp: rpm > 0.6 && !f.landed, camera: this.camera, ground: this.ground, snow: terrainUniforms.uSnowCover.value });
    // rotor downwash: powder blown off the snow when the rotor is close above it
    _light.setRGB(1, 1, 1).multiplyScalar(1 - night * 0.82);
    this.model.world(ANCHORS.hub, _hub);
    _hub.y = this.ground(_hub.x, _hub.z);
    const k = rpm * rpm * (1 - smooth(1.5, 19, f.agl));
    const onPad = Math.hypot(_hub.x - this.home.x, _hub.z - this.home.z) < PAD_R ? 1 : 0;
    this.washFx.update(dt, _hub, k, f.vel, FRAME.rotorR, _light, onPad, this.spray);
    this.pad.update(dt, { camera: this.camera, washFrom: _hub, wash: rpm * (1 - smooth(4, 30, f.agl)) });
    // red smoke on the nearest drop zone (a beacon to find it, and to see the wind when you get there)
    const zone = this.active ? this.targetZone(0) : null;
    this.smoke.update(dt, zone && Math.hypot(zone.x - f.pos.x, zone.z - f.pos.z) < 4500 ? zone : null, this.pad.wind, _light, this.camera);
    // sound: inside while you fly it, otherwise heard from the camera (distance + doppler)
    const cam = this.camera.position;
    const dist = cam.distanceTo(f.pos);
    let doppler = 1;
    if (!this.active && dist > 1) {
      // closing speed along the line of sight (the camera is roughly still)
      const vr = (f.vel.x * (cam.x - f.pos.x) + f.vel.y * (cam.y - f.pos.y) + f.vel.z * (cam.z - f.pos.z)) / dist;
      doppler = clamp(343 / (343 - vr), 0.85, 1.18);
    }
    const load = clamp(Math.max(0, f.vel.y) / 9 + f.climbAssist * 0.5 + Math.abs(f.roll) * 0.6, 0, 1);
    const inside = this.active || this.rescue.aboard;
    this.audio.setHeli?.({ rpm, load, speed: f.speed, dist: inside ? 0 : dist, doppler: inside ? 1 : doppler, inside });
  }

  // ------------------------------------------------------------------ map, compass, HUD line
  // nearest drop zone at least `skip` metres away (the compass moves on to the next one once you are there)
  targetZone(skip = 250) {
    const p = this.flight.pos, pl = this.plan; // (the drop zone picked on the flight planner, until you get there)
    if (pl && (skip === 0 || Math.hypot(pl.x - p.x, pl.z - p.z) >= skip)) return pl;
    let best = null, bd = 1e9;
    for (const z of dropZones()) {
      const d = Math.hypot(z.x - p.x, z.z - p.z);
      if (d >= skip && d < bd) { bd = d; best = z; }
    }
    return best;
  }

  /** Compass target while flying: the nearest drop zone ({ label, ang, dist } like main.js's waypoint()). */
  waypoint(pos = this.flight.pos) {
    if (!this.active) return null;
    const z = this.targetZone();
    if (!z) return null;
    const w = this.wp;
    w.label = `Drop zone · ${z.name}`;
    w.ang = Math.atan2(z.x - pos.x, z.z - pos.z);
    w.dist = Math.hypot(z.x - pos.x, z.z - pos.z);
    return w;
  }

  /** Objective line for the top-left panel while flying. */
  hudLine() {
    if (this.state === 'rescue') return this.rescue.hudLine();
    if (!this.active) return '';
    return LAND_ANYWHERE ? 'Set down on flat open snow (SHIFT), or hover low over a steep slope and jump out (E)' : 'Hover low and slow over fresh snow, then E to jump out';
  }

  /** Map markers: the helipad, the drop zones and the helicopter itself while it's out. */
  mapMarkers() {
    const out = [{ x: this.home.x, z: this.home.z, kind: 'helipad', label: 'Heli-ski' }];
    for (const z of dropZones()) out.push({ x: z.x, z: z.z, kind: 'drop', label: `${z.name} · ${z.vertical} m`, heading: z.heading });
    if (this.state === 'auto' || this.state === 'rescue' || this.away) out.push({ x: this.flight.pos.x, z: this.flight.pos.z, kind: 'heli', label: 'Helicopter' });
    return out;
  }
}
