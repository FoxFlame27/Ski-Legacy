// Drive the parked cars: E beside one ("Drive BMW X3"), a fade and you are in the driver's seat (your skis on your
// back); E again at a standstill and you step out by the driver's door, the car stays where you left it.
//   W throttle · S brake, then reverse · A/D steer · SPACE handbrake · R first person / chase · C look back
//   H horn · L headlights (on by themselves at night) · E get out (stopped) · U unstuck (slow, every 10 s)
// A car game on snow: an engine with an automatic gearbox (D/R; the Tesla one gear, instant torque), top speed and
// pull per car; grip from the surface (ploughed roads and car parks hold, loose snow less, groomed pistes and ice are
// slippery): under- and oversteer, handbrake slides; a spring per wheel (body roll, pitch under braking and
// acceleration, each wheel following the snow); off-road by grip and slope. Soft bumps off trees, buildings, cars,
// nets and people: no damage, no wipeout. First person from the driver's seat (the car's full-detail model with its
// interior, the steering wheel turning), the mouse looks round; or a chase camera that lags in turns and pulls back
// with speed. Engine / tyre / horn sounds (audio.setCar), headlights with a pool on the road at night.
import * as THREE from 'three';
import { world as WORLD } from '../world/world.js';
import { nightUniform } from '../world/village.js';
import { loadGLB } from '../core/assets.js';
import { carTemplate, carInstance, driverEye, REAL } from './cars.js';
import { keysHTML } from '../ui/hud.js';
import { SEAT_EYE, seatHip, seatsFor, leanBack, twoBone, setWQ, wquat, wpos } from './carpeople.js';
import { lampsOn, LightPool, Smoke, hazardPhase, headlampSpot, cabinFill, cabinLight } from './carlights.js';
import { knockPerson, peopleNear } from './peoplehits.js';
import { busRoads, laneDistance, roadAt, ROAD_HALF } from './bus/roads.js';
import { speedLimitAt } from './bus/speedlimits.js';
import { TyreTracks } from './tyretracks.js';
import { addDent, applyDents, repairInstance } from './cardamage.js';
import { setPlates } from './carconfig.js';
import { weatherFx } from '../world/sky.js'; // (icy roads after bad weather)
import { breakables, BREAK_V } from '../world/breakables.js'; // (little poles and signs: knocked flying, back after 90 s)
const COCKPIT_RAISE = 0.1; // m: the cockpit camera over your eyes (the seated rig's)

// per car: name, pull (m/s^2 at low speed), top speed (m/s), electric (one gear)
export const CAR_SPECS = {
  car_bmw_x3: { label: 'BMW X3', accel: 4.6, top: 58, sound: 'i6' },
  car_audi_rs6: { label: 'Audi RS6 Avant', accel: 7.4, top: 78, sound: 'v8' },
  car_vw_golf_gti: { label: 'VW Golf GTI', accel: 5.8, top: 68, sound: 'gti' },
  car_tesla_m3: { label: 'Tesla Model 3', accel: 7.0, top: 62, electric: true },
  // the supercars upstairs at the rental: the SLS's 6.2 V8 (420 kW, 0-100 in 3.8 s, 317 km/h), the Taycan Turbo S
  // (2 motors, 2.8 s, 260 km/h)
  car_mercedes_sls: { label: 'Mercedes SLS AMG', accel: 8.2, top: 88, sound: 'v8' },
  car_porsche_taycan: { label: 'Porsche Taycan Turbo S', accel: 9.6, top: 72, electric: true },
  // Oct 29: the Huracán EVO (5.2 V10, 470 kW, 0-100 in 2.9 s, 325 km/h: revs to 8,500, rev: the engine's speed over
  // the others'), the GR Yaris (1.6 turbo three, 192 kW, 5.5 s, 230 km/h), the e-tron GT concept (2 motors, 440 kW,
  // 3.5 s, 240 km/h), the GLS 580 (4.0 V8 biturbo + EQ boost, ~270 kW, 5.3 s, 250 km/h)
  car_lamborghini_huracan: { label: 'Lamborghini Huracán EVO', accel: 9.4, top: 90, sound: 'v10', rev: 1.3 },
  car_toyota_gr_yaris: { label: 'Toyota GR Yaris', accel: 6.6, top: 64, sound: 'i3t', rev: 1.08 },
  car_audi_etron_gt: { label: 'Audi e-tron GT', accel: 8.4, top: 67, electric: true },
  car_mercedes_gls: { label: 'Mercedes-Benz GLS', accel: 6.0, top: 69, sound: 'v8s' },
};
const FULL = { car_audi_rs6: 'car_audi_rs6_full', car_vw_golf_gti: 'car_vw_golf_gti_full', car_tesla_m3: 'car_tesla_m3_full' };
const RATIOS = [3.6, 2.2, 1.5, 1.15, 0.92, 0.76], FINAL = 3.7, IDLE = 820, REDLINE = 6400;
const G = 9.81;
// surfaces (grip()): mu, rolling drag, bumpiness; road: the tarmac (firm grip, tyre noise, full stability assist)
const SURF = {
  road: { mu: 1.0, roll: 0.015, rough: 0.1, road: true },
  shoulder: { mu: 0.72, roll: 0.03, rough: 0.5 },
  snow: { mu: 0.58, roll: 0.05, rough: 1 },
  piste: { mu: 0.4, roll: 0.02, rough: 0.4 },
  // (Oct 30 2026, the user: icy roads for a few minutes after heavy snow / blizzard / sleet / freezing fog, "only
  // slightly reduce grip": the road's mu down to 0.88 at the iciest, sky.js weatherFx.icy; set in grip())
  icyRoad: { mu: 1.0, roll: 0.015, rough: 0.1, road: true },
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const CRASH_V = 70 / 3.6; // m/s: into something solid (or head-on into a car) this fast or faster: a crash (damage)
const EXTREME_V = 150 / 3.6; // ...and this fast: the car's wrecked at once
const KNOCK_V = 30 / 3.6; // ...a knock (below a crash): a few % of damage and a small dent, you drive on
// U, unstuck (Oct 30 2026, the user: "sometimes when your car is stuck it moves forward or backward automatically to
// unstick itself", chose: no moving by itself, an unstuck key instead; R was taken: the camera): under this speed, every
// UNSTUCK_CD ms, to a clear lane / bay within UNSTUCK_R m; the hint once slow with the pedal down UNSTUCK_HINT s
const UNSTUCK_V = 5 / 3.6, UNSTUCK_CD = 10000, UNSTUCK_R = 60, UNSTUCK_HINT = 3;
// at rest off the pedals the collisions may shift the car at most this far (m) from where it settled (step())
const REST_SLACK = 0.15;
const RAIL_BREAK_V = 100 / 3.6, RAIL_BREAK_SIN = Math.sin(15 * Math.PI / 180); // (Oct 30, the user: "why can i still not break thru the guard rails when i am going faster than 100kph": 80 km/h straight into the rail meant hitting it at over 50 deg at 100 km/h, hardly ever; now over 100 km/h and at 15 deg or more into it: a real hit, not a scrape along it) // (railBreak)
// what you hit, by its collider: nets, people / traffic, poles and lift towers (thin), rocks (round), buildings (boxes)
const kindOf = (c) => (c.net ? 'net' : c.soft ? 'soft' : c.r !== undefined ? (c.r < 0.7 && !c.rock ? 'metal' : 'rock') : 'building');
const vegKind = (t) => ('s' in t && !('trunk' in t) ? 'rock' : 'tree');
// kerb weights (kg), for the knocks between cars
const MASS = { car_bmw_x3: 1900, car_audi_rs6: 2100, car_vw_golf_gti: 1450, car_tesla_m3: 1850, car_mercedes_sls: 1620, car_porsche_taycan: 2300,
  car_lamborghini_huracan: 1420, car_toyota_gr_yaris: 1280, car_audi_etron_gt: 2300, car_mercedes_gls: 2500 };
// driven wheels (the rest all-wheel drive)
const DRIVE = { car_vw_golf_gti: 'fwd', car_mercedes_sls: 'rwd' };
// two cars' boxes (x, z, yaw, half width hw, half length hd) overlapping? -> { nx, nz (from B to A), depth, px, pz
// (a contact point: the corners of one inside the other) } or null
function obb(A, B) {
  const axes = [[Math.sin(A.yaw), Math.cos(A.yaw)], [Math.cos(A.yaw), -Math.sin(A.yaw)], [Math.sin(B.yaw), Math.cos(B.yaw)], [Math.cos(B.yaw), -Math.sin(B.yaw)]];
  const dx = A.x - B.x, dz = A.z - B.z;
  const rad = (o, ax, az) => o.hd * Math.abs(Math.sin(o.yaw) * ax + Math.cos(o.yaw) * az) + o.hw * Math.abs(Math.cos(o.yaw) * ax - Math.sin(o.yaw) * az);
  let best = Infinity, nx = 0, nz = 0;
  for (const [ax, az] of axes) {
    const dist = dx * ax + dz * az, ov = rad(A, ax, az) + rad(B, ax, az) - Math.abs(dist);
    if (ov <= 0) return null;
    if (ov < best) { best = ov; const sg = dist >= 0 ? 1 : -1; nx = ax * sg; nz = az * sg; }
  }
  const corners = (o) => { const f = [Math.sin(o.yaw), Math.cos(o.yaw)], r = [Math.cos(o.yaw), -Math.sin(o.yaw)], out = []; for (const a of [-1, 1]) for (const b of [-1, 1]) out.push([o.x + f[0] * o.hd * a + r[0] * o.hw * b, o.z + f[1] * o.hd * a + r[1] * o.hw * b]); return out; };
  const inside = (o, x, z) => { const lx = x - o.x, lz = z - o.z; return Math.abs(lx * Math.sin(o.yaw) + lz * Math.cos(o.yaw)) <= o.hd && Math.abs(lx * Math.cos(o.yaw) - lz * Math.sin(o.yaw)) <= o.hw; };
  let px = 0, pz = 0, n = 0;
  for (const [x, z] of corners(A)) if (inside(B, x, z)) { px += x; pz += z; n++; }
  if (!n) for (const [x, z] of corners(B)) if (inside(A, x, z)) { px += x; pz += z; n++; }
  if (!n) { px = (A.x + B.x) / 2; pz = (A.z + B.z) / 2; n = 1; }
  return { nx, nz, depth: best, px: px / n, pz: pz / n };
}
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _ray = new THREE.Raycaster();

const CSS = `
#drive-hud .ch-card { position: absolute; left: 22px; bottom: 92px; transition: opacity 0.6s ease, translate 0.6s ease; }
#drive-hud .ch-card.out { opacity: 0; translate: calc(var(--u, 1px) * -24) 0; }`;

export class Drive {
  constructor({ scene, player, camera, hud, audio, colliders, vegetation, parking, transition, world = WORLD, cameraBlockers = null, input = null, traffic = null, freeRide = null, trails = null }) {
    Object.assign(this, { scene, player, camera, hud, audio, colliders, vegetation, parking, transition, world, cameraBlockers, input, traffic, freeRide });
    this.tyres = trails ? new TyreTracks(trails) : null; // the tyres' tracks in the snow (tyretracks.js)
    this.pool = null; // the headlights' pool of light on the road (carlights.js)
    // the cabin's light (one for every car you sit in, carlights.js cabinFill: made now with intensity 0, so switching
    // it on later recompiles nothing)
    this.dome = cabinFill(scene);
    this.wrecks = []; // crashed cars waiting to be towed (out of sight)
    this.shake = 0;
    this.sliding = []; // parked cars you shoved, sliding to a stop
    if (traffic) { traffic.parking = parking; traffic.you = this; } // (the traffic keeps clear of parked cars, wrecks, you)
    this.d = null;
    this.view = 'chase';
    this.look = { yaw: 0, pitch: -0.05 };
    this.cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0, ready: false };
    this.seat = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1) };
    this.prompt = { label: '', act: null };
  }

  get active() { return !!this.d; }
  get speed() { return this.d ? Math.hypot(this.d.vx, this.d.vz) : 0; }
  get label() {
    const d = this.d; if (!d) return ''; const dm = Math.round(d.e.damage || 0);
    // (the speed limit of the road you're on: the signs', bus/speedlimits.js)
    let lim = '';
    try { const L = speedLimitAt(d.x, d.z, ROAD_HALF + 0.5); if (L) lim = ` · limit ${L.kmh} km/h`; } catch { /* (no roads) */ }
    return `${d.spec.label} · ${d.gear}${lim}` + (dm > 0 ? ` · car damage ${dm}%` : '');
  }

  // ------------------------------------------------------------------ getting in
  /** E beside a parked car (within ~1.6 m of its body): { label: 'Drive BMW X3', act } or null. */
  interaction(pos) {
    if (this.d || this.entering || !this.parking?.cars?.length) return null;
    const p = this.player;
    if (p.mode === 'fall' || p.mode === 'sit') return null;
    let best = null, bd = Infinity;
    for (const e of this.parking.cars) {
      if (!CAR_SPECS[e.name] || e.driving || e.slide) continue;
      const g = e.car.position, yaw = e.car.rotation.y, dx = pos.x - g.x, dz = pos.z - g.z;
      if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
      const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const d = Math.hypot(Math.max(0, Math.abs(lx) - 0.95), Math.max(0, Math.abs(lz) - e.length / 2));
      if (d < 2.2 && d < bd) { bd = d; best = e; }
    }
    if (!best) return null;
    if (best.wrecked) { this.prompt.label = `${CAR_SPECS[best.name].label} · wrecked`; this.prompt.act = () => this.hud?.flash('Wrecked · it will be towed away', 'bad', 2000); return this.prompt; }
    // only a car you rented lets you in (carrental.js sets locked): any other just says where to rent one
    const hint = this.locked?.(best);
    if (hint) { this.prompt.label = hint; this.prompt.act = () => this.hud?.flash(hint, 'bad', 2400); return this.prompt; }
    this.prompt.label = `Drive ${CAR_SPECS[best.name].label}`;
    this.prompt.act = () => this.enter(best);
    return this.prompt;
  }

  enter(e) {
    if (this.d || this.entering || e.driving || e.wrecked) return;
    this.entering = true; // (one E: a second press while it fades does nothing)
    const p = this.player;
    this.transition.fade(async () => {
      try {
        if (this.d || p.mode === 'sit' || p.mode === 'fall') return;
        const spec = CAR_SPECS[e.name];
        e.home ||= { x: e.car.position.x, z: e.car.position.z, yaw: e.car.rotation.y };
        e.astray = null;
        e.driving = true;
        e.collider.x = 1e9; e.collider.z = 1e9;
        const bi = this.cameraBlockers?.indexOf(e.block);
        if (bi >= 0) this.cameraBlockers.splice(bi, 1);
        // the car you drive: its wheels and steering wheel as moving parts
        const inst = this.dressed(e, carInstance(e.t, { paint: e.dress ? null : e.paint, wheels: true }), e.t);
        this.swapVisual(e, inst);
        const g = e.car;
        this.d = {
          e, spec, inst, t: e.t, x: g.position.x, z: g.position.z, y: g.position.y, yaw: g.rotation.y, vx: 0, vz: 0, vy: 0, yawRate: 0,
          steer: 0, gear: 'P', rpm: IDLE, gi: 0, shiftT: 0, air: false, pitch: 0, roll: 0, pitchV: 0, rollV: 0, la: 0, lat: 0,
          lights: false, horn: false, squeal: 0, offT: 0.6, wheelBase: Math.max(2.4, e.length * 0.6), half: e.length / 2, w: e.t.size.x,
          start: 0, load: 0, crank: 0, firing: 0,
        };
        try { this.audio?.carStart?.(!!spec.electric); } catch { /* (no chime) */ }
        p.setSkisOn(false); // (skis on your back)
        p.viewBeforeRide = p.view; p.view = 'third';
        this.updateSeat();
        p.sitOn(this.seat);
        p.rig.snapPose?.(); // (straight into the seated pose: no blend from standing through the roof)
        this.d.rigFrames = 0; // (and hidden until it has been posed seated: placeCamera)
        p.rig.root.visible = false; p.rig.gear.visible = false;
        this.cam.ready = false; this.look.yaw = 0; this.look.pitch = -0.05;
        this.showCard(true);
        this.audio?.play('board');
        // the full-detail model (its interior) for the car you drive, when there is one
        const full = FULL[e.name];
        if (full) loadGLB(full).then((gltf) => {
          if (!this.d || this.d.e !== e || !gltf) return;
          const t = carTemplate(gltf, e.length, full);
          const fi = this.dressed(e, carInstance(t, { paint: e.dress ? null : e.paint, wheels: true }), t);
          this.swapVisual(e, fi);
          this.d.inst = fi; this.d.t = t; this.d.glassIn = undefined;
        }).catch(() => {});
      } catch (err) { console.warn('drive: getting in failed', err); this.rollbackEnter(e); }
      finally { this.entering = false; }
    }).catch(() => { this.entering = false; });
  }
  // getting in went wrong halfway: the car parked as it was, you standing beside it (never in it)
  rollbackEnter(e) {
    const p = this.player, g = e.car;
    try {
      if (e.parkedVisual) { for (const o of g.children.slice()) if (o !== e.block) g.remove(o); for (const o of e.parkedVisual) g.add(o); }
      e.collider.x = g.position.x; e.collider.z = g.position.z; e.collider.rot = -g.rotation.y;
      if (this.cameraBlockers && !this.cameraBlockers.includes(e.block)) this.cameraBlockers.push(e.block);
    } catch { /* (as it is) */ }
    e.driving = false; this.d = null;
    try {
      if (p.seat === this.seat) p.seat = null;
      const sp = this.exitSpot({ x: g.position.x, z: g.position.z, yaw: g.rotation.y, w: 1.9, half: e.length / 2, e });
      if (p.mode === 'sit') { p.standUp(sp.x, sp.z, sp.heading); p.rig.snapPose?.(); }
      if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
      p.rig.root.visible = true; p.rig.gear.visible = true; p.rig.setSkisVisible?.(p.hasSkis);
      this.showCard(false);
    } catch { /* (nothing more to undo) */ }
  }
  // where you step out: beside the driver's door if that's clear, else the other side, behind, in front; on clear
  // ground (no car, building, tree or net there)
  exitSpot(d) {
    const yaw = d.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
    const side = (s, k, out) => ({ x: d.x + lx * s * (d.w / 2 + out) + fx * k, z: d.z + lz * s * (d.w / 2 + out) + fz * k, heading: yaw + s * (Math.PI / 2) });
    const cands = [side(1, 0.3, 0.75), side(-1, 0.3, 0.75), side(1, -0.8, 0.75), side(-1, -0.8, 0.75),
      { x: d.x - fx * (d.half + 1.0), z: d.z - fz * (d.half + 1.0), heading: yaw + Math.PI }, { x: d.x + fx * (d.half + 1.0), z: d.z + fz * (d.half + 1.0), heading: yaw },
      side(1, 0.3, 2.2), side(-1, 0.3, 2.2)];
    for (const c of cands) if (this.clearAt(c.x, c.z, 0.45, d.e)) return c;
    return cands[0];
  }
  clearAt(x, z, r, own = null) {
    const inBox = (cx, cz, yaw, hw, hd) => { const dx = x - cx, dz = z - cz, a = dx * Math.cos(yaw) - dz * Math.sin(yaw), b = dx * Math.sin(yaw) + dz * Math.cos(yaw); return Math.abs(a) < hw + r && Math.abs(b) < hd + r; };
    for (const e of this.parking?.cars || []) if (e !== own && Math.abs(e.car.position.x - x) < 8 && Math.abs(e.car.position.z - z) < 8 && inBox(e.car.position.x, e.car.position.z, e.car.rotation.y, 0.97, e.length / 2)) return false;
    for (const c of this.traffic?.cars || []) if (c.mode !== 'gone' && Math.abs(c.x - x) < 8 && Math.abs(c.z - z) < 8 && inBox(c.x, c.z, c.yaw, c.w / 2, c.l / 2)) return false;
    const cars = this.carColliders();
    for (const c of this.colliders) {
      if (cars.has(c) || c === own?.collider) continue;
      const size = c.r ?? Math.max(c.hw, c.hd);
      if (Math.abs(c.x - x) > size + r + 0.5 || Math.abs(c.z - z) > size + r + 0.5) continue;
      if (c.r !== undefined) { if (Math.hypot(x - c.x, z - c.z) < c.r + r) return false; }
      else if (inBox(c.x, c.z, -c.rot, c.hw, c.hd)) return false;
    }
    if (this.vegetation?.collide?.(x, z, r, 0.6)) return false;
    return true;
  }
  // a car instance as this car looks: a rental's own config (carrental.js e.dress: paint, interior, rims, plates) and
  // its dents (cardamage.js)
  dressed(e, inst, t) { // (not "look": that is the cockpit mouse-look { yaw, pitch } field, which would shadow it)
    try {
      if (e.dress) e.dress(inst, t);
      else setPlates(inst, t, e.inst?.plateText || e.plateText); // (the same plates as it had parked)
      if (inst.plateText) e.plateText = inst.plateText;
      applyDents(inst, e);
    } catch (err) { console.warn('drive: car look', err); }
    return inst;
  }
  // show a car instance in place of the parked car's (the parked one is kept to put back)
  swapVisual(e, inst) {
    const g = e.car;
    if (!e.parkedVisual) e.parkedVisual = g.children.filter((o) => o !== e.block);
    for (const o of g.children.slice()) if (o !== e.block) g.remove(o);
    g.add(inst.group);
  }
  // ------------------------------------------------------------------ getting out
  exit() {
    const d = this.d, p = this.player;
    if (!d) return;
    if (this.speed > 1) { this.hud?.flash('Stop the car to get out', 'bad', 1500); return; }
    const yaw = d.yaw;
    // by the driver's door (left side) on clear ground; else the other side, behind, in front
    const sp = this.exitSpot(d);
    this.park();
    p.seat = null;
    p.standUp(sp.x, sp.z, sp.heading);
    p.rig.snapPose?.(); // (standing at once, outside: no blend from the seat)
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    p.rig.root.visible = true; p.rig.gear.visible = true;
    p.rig.setSkisVisible(p.hasSkis);
    p.camYaw = sp.heading + Math.PI;
    void yaw;
  }
  // the car stays where it stopped: the parked look, its collider and camera blocker back
  park() {
    const d = this.d;
    if (!d) return;
    this.tyres?.end();
    const e = d.e, g = e.car;
    for (const o of g.children.slice()) if (o !== e.block) g.remove(o);
    for (const o of e.parkedVisual || []) g.add(o);
    if (e.dents?.length) applyDents(e.inst, e); // (parked as it is: its dents too)
    g.position.set(d.x, (this.world.meshHeight || this.world.height).call(this.world, d.x, d.z) + 0.03, d.z);
    g.rotation.set(0, d.yaw, 0);
    g.updateMatrixWorld(true);
    e.collider.x = d.x; e.collider.z = d.z; e.collider.rot = -d.yaw;
    // the car park bays: the one(s) it now stands in are taken (no other car parks on it), the one it left is free
    try {
      for (const b of e.held || []) b.taken = false;
      e.held = [];
      for (const L of busRoads.lots) for (const b of L.bays || []) if (Math.abs(d.x - b.x) < 3 && Math.abs(d.z - b.z) < 3 && Math.hypot(d.x - b.x, d.z - b.z) < 3) { b.taken = true; e.held.push(b); }
    } catch { /* (bookkeeping only) */ }
    if (this.cameraBlockers && !this.cameraBlockers.includes(e.block)) this.cameraBlockers.push(e.block);
    e.driving = false;
    if (!d.crash) e.smokeFx?.clear();
    cabinLight(d.inst, d.t, { on: false });
    if (this.dome) this.dome.intensity = 0;
    this.tailPool?.update(0, 0, 0, 0, this.world, 0);
    this.d = null;
    this.pool?.update(0, 0, 0, 0, this.world, 0);
    this.showCard(false);
    this.audio?.setCar?.({ on: false });
  }
  /** End a drive at once (main.js: teleports, menus): the car parks where it is. */
  abort() {
    if (!this.d) return;
    const p = this.player;
    let sp = null;
    try { sp = this.exitSpot(this.d); } catch { sp = null; }
    this.park();
    if (p.seat === this.seat) p.seat = null;
    if (p.mode === 'sit' && sp) { p.standUp(sp.x, sp.z, sp.heading); p.rig.snapPose?.(); } // (never left sitting / standing in the car)
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    p.rig.root.visible = true; p.rig.gear.visible = true;
    p.rig.setSkisVisible(p.hasSkis);
  }

  // ------------------------------------------------------------------ per frame
  update(dt, input) {
    if (this.sliding.length && dt > 0) this.slideParked(dt);
    if (this.wrecks.length && dt > 0) this.updateWrecks(dt);
    if (!this.d) { this.unstick(); if (this.audio?.railScr?.on) this.audio.setRailScrape(0); return; }
    if (dt <= 0) { this.audio?.setCar?.({ on: true, paused: true }); this.audio?.setRailScrape?.(0); this.holdCamera(); return; }
    try {
      const d = this.d;
      d.offT = Math.max(0, d.offT - dt);
      const key = (a, b) => !!input && (input.down(a) || (b && input.down(b)));
      // the engine starts as you get in: the starter turns it over, it catches, flares and settles to idle
      d.start += dt;
      const cranking = !d.spec.electric && d.start < 0.85, live = !d.crash;
      // held (police.js: being arrested): no throttle, no steering, the brakes and the handbrake on, no getting out
      const held = !!this.held || !!this.servicing; // (servicing: in the Werkstatt's repair box while it is repaired, werkstatt.js)
      const thr = live && !held && !cranking && key('KeyW', 'ArrowUp') ? 1 : 0, brk = held || (live && key('KeyS', 'ArrowDown')) ? 1 : 0;
      const steerIn = live && !held ? (key('KeyA', 'ArrowLeft') ? 1 : 0) - (key('KeyD', 'ArrowRight') ? 1 : 0) : 0;
      const hb = held || (live && key('Space')), lookBack = key('KeyC');
      d.horn = key('KeyH');
      if (input?.hit?.('KeyL')) d.lights = !d.lights;
      if (input?.hit?.('KeyR')) { this.view = this.view === 'chase' ? 'cockpit' : 'chase'; this.cam.ready = false; }
      if (input?.hit?.('KeyE') && d.offT <= 0 && !d.crash && !held && !this.eTaken?.()) { this.exit(); if (!this.d) return; } // (eTaken: E is the Werkstatt's Repair this frame, werkstatt.js)
      // the pedals: pressed progressively, not switched (Oct 29, "make driving more realistic"): the throttle opens over
      // ~0.3 s and closes over ~0.15 s, the brake bites over ~0.2 s and lets go over ~0.1 s, so pulling away, lifting
      // off and braking shift the car's weight smoothly instead of in a jolt. (Steering is untouched: its own rack)
      const pd = (v, want, up, down) => (want > v ? Math.min(want, v + up * dt) : Math.max(want, v - down * dt));
      d.thrP = pd(d.thrP || 0, thr, 3.4, 7), d.brkP = pd(d.brkP || 0, brk, 5, 10);
      const thrE = thr ? Math.max(0.05, d.thrP) : d.thrP > 0.02 ? d.thrP : 0, brkE = brk ? Math.max(0.08, d.brkP) : d.brkP > 0.02 ? d.brkP : 0;
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      if (d.crash) this.crashStep(dt);
      else for (let i = 0; i < n; i++) { this.step(dt / n, thrE, brkE, steerIn, hb, thr, brk); if (d.crash) break; }
      if (!d.spec.electric && d.start < 2.4) {
        if (cranking) { d.crank = 1; d.firing = d.start > 0.62 ? 0.5 : 0; d.rpm = 210 + 70 * Math.abs(Math.sin(d.start * 26)); }
        else { const k = d.start - 0.85; d.crank = 0; d.firing = 1; d.rpm = Math.max(d.rpm, IDLE + 900 * Math.exp(-k * 2.4) * Math.min(1, k * 10)); }
      } else { d.crank = 0; d.firing = 1; }
      d.load += (thr - d.load) * (1 - Math.exp(-dt * 9));
      // the guardrail scrape: while touching one (railHit), by the speed along it
      d.railT = Math.max(0, (d.railT || 0) - dt);
      try { this.audio?.setRailScrape?.(d.railT > 0 ? d.railSlide || 0 : 0); } catch { /* (silent) */ }
      if (d.railT <= 0) d.railSlide = 0;
      this.pose(dt);
      this.poseT = performance.now(); // (net/carride.js: the presence row is taken next frame, before this update)
      this.updateSeat();
      const p = this.player;
      p.pos.copy(this.seat.pos);
      this.placeRig();
      this.placeCamera(dt, input, lookBack);
      this.holdCamera(true);
      this.effects(dt, thr);
      this.tyres?.update(d); // (tyre tracks in the snow: tyretracks.js)
      // on its side or its roof (more than ~70 degrees for a second, slow): F flips it back onto its wheels
      const upY = _w.set(0, 1, 0).applyQuaternion(d.e.car.quaternion).y;
      d.flipT = !d.crash && upY < 0.34 && this.speed < 2 ? (d.flipT || 0) + dt : 0;
      if (d.flipT > 1) {
        if (performance.now() - (this.flipMsgT || 0) > 2000) { this.flipMsgT = performance.now(); this.hud?.flash('F · Flip car back', 'good', 1900); }
        if (input?.hit?.('KeyF')) this.unflip();
      }
      // U: unstuck (Oct 30 2026, the user: "add an unstuck key"; R is the camera, so U). The hint only once you've
      // been slow with the pedal down for ~3 s (stuck); the key works whenever you're slow (unstuck())
      const slow = this.speed < UNSTUCK_V;
      const pushing = thr || (d.gear === 'R' && brk); // (the throttle, or S reversing)
      d.stuckT = d.crash || held || !slow ? 0 : pushing ? (d.stuckT || 0) + dt : Math.max(0, (d.stuckT || 0) - dt * 0.5);
      if (pushing && d.stuckT > UNSTUCK_HINT && d.flipT <= 1 && performance.now() - (this.stuckMsgT || 0) > 2600) { this.stuckMsgT = performance.now(); this.hud?.flash('U · Unstuck', 'good', 2400); }
      if (input?.hit?.('KeyU') && !d.crash && !held) this.unstuck();
      // after a crash: the car comes to rest, then you're out beside it
      if (d.crash) { d.crash.t += dt; if (d.crash.t > 1.9 && this.speed < 1.2 && Math.abs(d.crash.rollTo - d.crash.roll) < 0.05) this.wreckOut(); }
    } catch (err) { console.warn('drive', err); try { this.abort(); } catch { this.d = null; } }
  }

  // Paused (ESC, photo mode: dt 0): the car's camera stays exactly where the last driven frame put it. (Oct 30, the
  // user: "when you press esc during driving the car glitches forward and backwards": player.update still runs at
  // dt 0 and put the camera on the player's own seated chase camera, 8 m back at another angle, until you resumed)
  holdCamera(save = false) {
    const cam = this.camera, H = this.camHold ||= { pos: new THREE.Vector3(), q: new THREE.Quaternion(), fov: 60, near: 0.1, d: null };
    if (save) { H.pos.copy(cam.position); H.q.copy(cam.quaternion); H.fov = cam.fov; H.near = cam.near; H.d = this.d; return; }
    if (H.d !== this.d) return; // (paused before this drive's first frame: nothing to hold)
    cam.position.copy(H.pos); cam.quaternion.copy(H.q); cam.fov = H.fov; cam.near = H.near;
    cam.updateProjectionMatrix();
  }

  // surface grip: the ploughed tarmac (a road's plowed width + its packed strip, car parks, junctions, lay-bys: the
  // bus roads' own shapes) holds firm (winter tyres); the snowy shoulder / berm bench a little less; off the road
  // the snow is clearly slipperier (it drags too, and it's bumpy) but predictable; groomed pistes slippier still
  grip(x, z) {
    if (this.onTarmac(x, z)) { const icy = weatherFx.icy; if (icy < 0.02) return SURF.road; SURF.icyRoad.mu = 1 - 0.12 * icy; return SURF.icyRoad; }
    const c = this.world.corridorAt(x, z, this._corr || (this._corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }));
    if (c.kind === 'lift' && c.d < 0) return busRoads.roads.length ? SURF.shoulder : SURF.road; // (no bus roads planned: the old corridor test)
    if (c.groomed && c.d < 0) return SURF.piste;
    return SURF.snow;
  }
  onTarmac(x, z) {
    const R = busRoads;
    if (!R.roads.length) return false;
    if (laneDistance(x, z) < ROAD_HALF + 0.9) return true;
    for (const L of R.lots) { const dx = x - L.x, dz = z - L.z; if (Math.abs(dx * L.ux + dz * L.uz) < L.hw + 0.5 && Math.abs(dx * L.vx + dz * L.vz) < L.hd + 0.5) return true; if (L.ex !== undefined && Math.hypot(x - L.ex, z - L.ez) < 8) return true; }
    for (const j of R.junctions) if (Math.abs(j.x - x) < 10 && Math.abs(j.z - z) < 10) return true;
    for (const lb of R.laybys || []) { const fx = Math.sin(lb.yaw), fz = Math.cos(lb.yaw), dx = x - lb.x, dz = z - lb.z; if (Math.abs(dx * fx + dz * fz) < 10 && Math.abs(dx * fz - dz * fx) < 3) return true; }
    return false;
  }

  // A bicycle model: the front and rear axles each with a tyre that grips by its slip angle (rising to a peak, then a
  // gentle fall into a slide), the load on each axle shifting with braking and acceleration, the drive and the brakes
  // per axle within each tyre's grip (a friction circle: wheelspin or a locked axle has less grip sideways), ABS-like
  // brakes biased to the front (it stays straight under braking), the handbrake locking the rear (a slide you hold
  // with the steering). Yaw comes from the tyre forces. The steering: a rack with less lock at speed, rate-limited,
  // centring itself. The engine: a torque curve through the automatic gears (one gear and a power limit for the
  // Tesla), engine braking off the throttle, air drag setting the top speed.
  step(dt, thr, brk, steerIn, hb, thrKey = thr, brkKey = brk) {
    const d = this.d, spec = d.spec, W = this.world;
    const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), lx = fz, lz = -fx; // forward, left
    let u = d.vx * fx + d.vz * fz, v = d.vx * lx + d.vz * lz, r = d.yawRate;
    const s = this.grip(d.x, d.z);
    this.roughness = s.rough;
    const e = 1.4, h0 = W.groundHeight(d.x, d.z, d.y + 1);
    const gx = (W.groundHeight(d.x + e, d.z, d.y + 1) - W.groundHeight(d.x - e, d.z, d.y + 1)) / (2 * e);
    const gz = (W.groundHeight(d.x, d.z + e, d.y + 1) - W.groundHeight(d.x, d.z - e, d.y + 1)) / (2 * e);
    const cosT = 1 / Math.sqrt(1 + gx * gx + gz * gz);
    // gearbox (automatic): S at a standstill engages reverse, W drive
    if (Math.abs(u) < 0.4) {
      if (brkKey && !thrKey && d.gear !== 'R') { d.holdR = (d.holdR || 0) + dt; if (d.holdR > 0.25) d.gear = 'R'; }
      else d.holdR = 0;
      if (thrKey && d.gear !== 'D') d.gear = 'D';
    }
    const m = MASS[d.e.name] || 1700, L = d.wheelBase, fwd = DRIVE[d.e.name] === 'fwd', rwd = DRIVE[d.e.name] === 'rwd';
    const a = L * (fwd ? 0.4 : rwd ? 0.47 : 0.46), b = L - a, hcg = 0.55, Iz = m * a * b * 1.15;
    const au = Math.abs(u), sgn = u >= 0 ? 1 : -1;
    // the steering rack: full lock at parking speed; at speed the lock a full key press gives is what the surface's
    // grip can turn (~75 % of it, plus a little for the tyres' slip): holding A/D on the road never slides, on snow
    // only gently. It moves at a limited rate and centres itself. (Steering works whatever the pedals do: A/D are
    // read on their own, and the tyres always keep most of their grip for turning: traction control / ABS below.)
    // (latOk: the cornering the grip leaves while braking / accelerating, la: the friction circle)
    // (Oct 29: the whole grip asked for, was 78 %, and the wheel turned in 1.6x as fast: steering felt dull, wide
    // turns at speed. The self-centring rate is as before)
    const latOk = Math.sqrt(Math.max((0.3 * s.mu * G) ** 2, (s.mu * G) ** 2 - d.la * d.la));
    const lock = clamp((L * latOk) / Math.max(1, au * au) + 0.015, 0.03, 0.6);
    // (the rate: ~0.2 s to the lock whatever the speed, so a tap at speed is a quick correction, not a swerve)
    const rate = Math.min((steerIn ? 4.2 : 3.6) / (1 + au / 18), Math.max(lock * (steerIn ? 5.1 : 5), steerIn ? 0.32 : 0.35));
    d.steer += clamp(steerIn * lock - d.steer, -rate * dt, rate * dt);
    const delta = d.steer;
    let held0 = false; // (the car held still this step: hill hold / the brakes at a standstill; the rest anchor below)
    if (!d.air) {
      // loads on the axles: static, plus the weight moving with the acceleration (nose down braking, squat pulling)
      const Wt = m * G * cosT;
      const Fzf = Math.max(Wt * 0.15, (Wt * b) / L - (m * d.la * hcg) / L), Fzr = Math.max(Wt * 0.15, (Wt * a) / L + (m * d.la * hcg) / L);
      // (the tyres' load sensitivity: cornering hard, the weight moving onto the outside wheels costs a little grip;
      // tw: track width)
      const tw = Math.max(1.4, d.w - 0.3), ltK = 1 - 0.06 * Math.min(1, (Math.abs(d.lat || 0) * hcg) / (tw * 0.5 * G));
      const mu = s.mu * ltK * (d.gripK ?? 1), capF = mu * Fzf, capR = mu * Fzr; // (gripK: police.js, spiked tyres / a PIT)
      // the engine (through the gears) and the brakes
      let Fdrive = 0, Fbrake = 0;
      if (!s.road) thr *= 0.6; // (a gentler throttle on snow: less wheelspin)
      const x = clamp((d.rpm - 800) / 5600, 0, 1), curve = 0.62 + 0.38 * Math.sin(Math.PI * x);
      const gearK = spec.electric ? 1 : Math.pow(RATIOS[d.gi] / RATIOS[0], 0.85);
      const Fmax = m * spec.accel;
      if (d.gear === 'D') {
        if (thr) Fdrive = spec.electric ? Math.min(Fmax, (Fmax * 0.42 * spec.top) / Math.max(1, au)) * thr : Fmax * gearK * curve * thr * (d.shiftT > 0 ? 0.3 : 1);
        if (brk) Fbrake = m * 10 * brk;
        // (engine braking / regen off the throttle: stronger the higher the revs and the lower the gear, as the throttle
        // closes; downhill the gearbox holds a lower gear for it, below)
        else if (thr < 0.3 && u > 1) Fbrake = (1 - thr / 0.3) * m * (spec.electric ? 1.1 : Math.min(1.6, (0.25 + 0.85 * (d.rpm / (REDLINE * (spec.rev || 1)))) * clamp(Math.sqrt(RATIOS[d.gi] / RATIOS[3]), 0.75, 1.5)));
      } else if (d.gear === 'R') {
        if (brk) Fdrive = u > -5.5 ? -m * 3.4 * (s.road ? 1 : 0.7) : 0;
        if (thr) Fbrake = m * 10;
      }
      // per axle: drive split (AWD 40/60, FWD all front), brakes 65/35 front; traction control and ABS hold each
      // tyre's drive / braking under its grip, and with the wheel turned well under it, so the friction circle always
      // leaves most of the grip for steering (the old 95 % left under a third sideways: no steering under throttle
      // or brakes, a spinning rear on snow); the handbrake locks the rear
      const split = fwd ? 1 : rwd ? 0 : 0.4; // (rear-wheel drive: all of it at the back)
      let Fxf = Fdrive * split - Fbrake * 0.65 * sgn, Fxr = Fdrive * (1 - split) - Fbrake * 0.35 * sgn;
      const kx = 0.9 - 0.3 * Math.min(1, Math.abs(steerIn) + Math.abs(d.steer) * 4); // (0.6 turning: 80 % kept sideways)
      Fxf = clamp(Fxf, -kx * capF, kx * capF);
      Fxr = clamp(Fxr, -kx * capR, kx * capR);
      let latR = 1;
      if (hb && au > 0.5) { Fxr = -sgn * 0.75 * capR; latR = 0.32; }
      // sideways: slip angles of the axles, a tyre curve (peak near 9 degrees, then a gentle fall), what grip the
      // drive / brakes leave (friction circle)
      const uu = Math.max(au, 1.5); // (a floor: the slip maths stays stable crawling; below ~1 m/s the tyres just roll)
      const af = Math.atan2(v + a * r, uu) - delta * sgn, ar = Math.atan2(v - b * r, uu);
      const tyre = (al) => Math.sin(1.2 * Math.atan(14 * al)); // (past the peak only a gentle fall: slides stay catchable)
      const kf = Math.min(1, Math.abs(Fxf) / Math.max(1, capF)), kr = Math.min(1, Math.abs(Fxr) / Math.max(1, capR));
      // (crawling, the wheels just roll where they point: the turn comes from the walking-pace blend below, so the
      // slip maths' sideways force fades out; else a wheel turned at a standstill reads as a full slide and its drag
      // all but stops the car pulling away / reversing with the wheel already turned)
      const kLow = clamp((au - 1) / 3, 0, 1);
      const Fyf = -capF * Math.sqrt(Math.max(0, 1 - kf * kf)) * tyre(af) * kLow;
      const Fyr = -capR * Math.sqrt(Math.max(0, 1 - kr * kr)) * latR * tyre(ar) * kLow;
      // resistances: rolling (snow drags more), air (sets the top speed), slope
      const topF = spec.electric ? Fmax * 0.42 : Fmax * Math.pow(RATIOS[RATIOS.length - 1] / RATIOS[0], 0.85) * 0.66;
      const drag = (topF / (spec.top * spec.top)) * u * au * (d.dragK ?? 1); // (dragK: police.js, flat tyres: a lower top speed)
      const roll = s.roll * Wt * sgn * Math.min(1, au / 0.5);
      const gF = -G * (gx * fx + gz * fz) * cosT * m, gL = -G * (gx * lx + gz * lz) * cosT * m;
      d.downhill = gF / (m * G) * Math.sign(u || 1); // (the slope's pull along the way you go: + downhill)
      const cs = Math.cos(delta), sn = Math.sin(delta);
      const FF = Fxf * cs - Fyf * sn + Fxr - drag - roll + gF;
      const FL = Fxf * sn + Fyf * cs + Fyr + gL;
      const u0 = u;
      u += (FF / m + r * v) * dt;
      v += (FL / m - r * u0) * dt;
      r += ((a * (Fxf * sn + Fyf * cs) - b * Fyr) / Iz) * dt;
      // stability assist (ESC): a yaw rate beyond what the wheels ask (u tan(delta) / L, no more than the grip can
      // carry) or against it is pulled back (oversteer, a spin: caught; too little: helped round on the road, only
      // nudged on snow),
      // and the rear's sideways slide (v - b r: the rear axle drifting out) is damped; firm on the road (no sliding at
      // normal driving, no creep), softer on snow (a gentle, recoverable slide, never a spin on its own); the
      // handbrake mostly overrides it
      {
        const rMax = (latOk * (s.road ? 1.3 : 1.2)) / Math.max(Math.abs(u), 2);
        const rT = clamp((u / L) * Math.tan(delta), -rMax, rMax);
        const over = r * rT < 0 || Math.abs(r) > Math.abs(rT);
        const hbK = (hb && au > 0.5 ? 0.15 : 1) * (d.escK ?? 1); // (escK: police.js, a PIT spinning you out)
        r += (rT - r) * (1 - Math.exp(-dt * (s.road ? 7 : 3.5) * (over ? 1 : s.road ? 0.8 : 0.25) * hbK));
        v = b * r + (v - b * r) * Math.exp(-dt * (s.road ? 6 : 2) * hbK);
      }
      // braking to a stop doesn't roll it backwards; parked stays put; and at a standstill off the pedals it holds
      // (hill hold: no creep down a gentle slope, unless the slope is beyond what the tyres can hold)
      if (Fbrake > 0 && Math.sign(u) !== Math.sign(u0) && u0 !== 0) u = 0;
      if (d.gear === 'P' || (d.gear === 'D' && !thr && brk && Math.abs(u) < 0.3)) { u = 0; v *= 0.5; held0 = true; }
      if (!thr && !(d.gear === 'R' && brk) && Math.abs(u) < 0.5 && Math.abs(gF) < 0.6 * mu * Wt) { u = 0; v = 0; r = 0; held0 = true; }
      // at walking pace the tyres just roll where they point (no slip maths at ~0 speed): turning about the rear
      // axle (the middle swings out b r), forwards or back
      const kd = clamp((Math.abs(u) - 1) / 3, 0, 1);
      if (kd < 1) { const rk = (u / L) * Math.tan(delta); r = rk + (r - rk) * kd; v = v * kd + rk * b * (1 - kd); }
      d.la += ((u - u0) / dt - d.la) * Math.min(1, dt * 12);
      d.lat = FL / m;
      // tyre noise: only on cleared roads (snow hushes it): a slide, wheelspin, a locked axle
      const slide = Math.max(Math.abs(af), Math.abs(ar));
      d.squeal = s.road ? clamp((slide - 0.12) * 5 + (hb && au > 4 ? 0.4 : 0) + (kr > 0.94 && thr ? 0.3 : 0), 0, 1) : 0;
    } else {
      r *= Math.exp(-dt * 1.2);
    }
    d.vx = fx * u + lx * v; d.vz = fz * u + lz * v; d.yawRate = r;
    d.yaw = wrapPi(d.yaw + r * dt);
    d.x += d.vx * dt; d.z += d.vz * dt;
    // vertical: on the snow it follows the ground; over a crest at speed it leaves it (a small jump)
    // (a step in the ground: a kerb, a car park's edge, a deck, is settled onto, never turned into upward speed; a
    // jump is never more than a hop)
    const g1 = this.world.groundHeight(d.x, d.z, d.y + 1);
    if (!d.air) {
      const step = g1 - h0;
      const vyG = clamp(Math.abs(step) > 0.3 ? d.vy * 0.5 : step / dt, -9, 5);
      if (vyG < d.vy - G * dt - 3.2 && Math.abs(u) > 10 && step > -1.5) { d.air = true; d.vy = clamp(d.vy, -9, 4) - G * dt; d.y += d.vy * dt; } // (the springs keep it down over ordinary crests)
      else { d.y = g1; d.vy += (vyG - d.vy) * 0.5; }
    } else {
      d.vy = Math.min(d.vy, 6) - G * dt; d.y += d.vy * dt;
      if (d.y <= g1) { d.pitchV += Math.min(1.5, -d.vy * 0.08); d.y = g1; d.vy = 0; d.air = false; }
    }
    // engine revs and gears
    const wr = 0.34, speedAbs = Math.abs(u);
    if (spec.electric) d.rpm = IDLE + speedAbs * 220;
    else {
      d.shiftT = Math.max(0, d.shiftT - dt);
      const rev = spec.rev || 1; // (a high-revving engine: the same gears, every rpm that much higher)
      const rpmAt = (gi) => (speedAbs / wr) * RATIOS[gi] * FINAL * 60 / (2 * Math.PI) * rev;
      if (d.gear === 'D') {
        // (coasting or braking down a steep road it holds a lower gear: the engine brakes, as a driver would shift down)
        const hold = thr < 0.1 && (d.downhill || 0) > 0.05, up = hold ? 6200 : 5800, down = hold ? 3300 : thr > 0.85 ? 2800 : 2200;
        if (rpmAt(d.gi) > up * rev && d.gi < RATIOS.length - 1) { d.gi++; d.shiftT = 0.25; }
        else if (d.gi > 0 && rpmAt(d.gi) < down * rev && rpmAt(d.gi - 1) < 6000 * rev) d.gi--;
      } else d.gi = 0;
      d.rpm = clamp(Math.max(IDLE + thr * 600, rpmAt(d.gi)), IDLE, REDLINE * rev);
    }
    // (Oct 30 2026, the user: "sometimes when your car is stuck it moves forward or backward automatically to unstick
    // itself"): wedged (a tree and a rail, two parked cars, a bank and a wall), the push out of each overlap shoved the
    // car into the next one; the sideways shares cancelled, the share along its length didn't, and at 120 steps a
    // second that crept the car out forwards or backwards on its own. Now at rest off the pedals (no throttle in D,
    // no S in R, held still by the hill hold / the brakes this step) the collisions may move it at most REST_SLACK
    // from where it settled: a stuck car just sits there until you drive it out (or U, unstuck). Driving (or sliding
    // down a slope too steep for the tyres) the collisions are as before: no driving through things, the bounces kept
    const pedal = (d.gear === 'D' && thrKey) || (d.gear === 'R' && brkKey);
    const rest = held0 && !pedal && !d.air && !d.crash;
    if (!rest) d.restAt = null;
    else if (!d.restAt) d.restAt = { x: d.x, z: d.z };
    this.terrainHit(g1);
    this.collide();
    this.bash(dt);
    const A = this.d === d && rest && !d.crash ? d.restAt : null;
    if (A) {
      const ox = d.x - A.x, oz = d.z - A.z, o = Math.hypot(ox, oz);
      if (o > REST_SLACK) { d.x = A.x + (ox / o) * REST_SLACK; d.z = A.z + (oz / o) * REST_SLACK; d.vx = 0; d.vz = 0; d.yawRate = 0; }
    }
  }

  // into the mountain: the ground ahead rising steeper than ~40 degrees (a rock face, a steep bank; never a road, a
  // berm or a ramp) is a wall: the speed into it is a knock or a crash like any solid hit (Oct 29, the user: "make it
  // so you can damage the car by crashing into mountains"), and it bounces the car back off the slope
  terrainHit(g1) {
    const d = this.d;
    if (!d || d.air || d.crash) return;
    const sp = Math.hypot(d.vx, d.vz);
    if (sp < KNOCK_V) return;
    const dx = d.vx / sp, dz = d.vz / sp, ahead = d.half + 0.6;
    const gA = (this.world.groundHeight(d.x + dx * ahead, d.z + dz * ahead, d.y + 4) - g1) / ahead;
    if (gA < 0.85) return;
    const vin = sp * gA / Math.sqrt(1 + gA * gA); // (the speed into the face)
    if (vin < KNOCK_V) return;
    const nx = -dx, nz = -dz;
    d.vx += nx * vin * 1.25; d.vz += nz * vin * 1.25; // (off the face, a little bounce back)
    d.vx *= 0.6; d.vz *= 0.6;
    if (vin > CRASH_V && this.canCrash()) { this.crash(vin, nx, nz, 'rock'); return; }
    this.knock(vin, nx, nz);
    if (performance.now() - (this.bangT || 0) > 300) { this.bangT = performance.now(); try { this.audio?.impact?.('rock', Math.min(0.7, vin / 16)); } catch { /* (silent) */ } }
  }

  // soft bumps: trees, rocks, colliders (buildings, nets, other cars), people; no damage
  collide() {
    const d = this.d, fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);
    let px = 0, pz = 0, n = 0, solid = false, kind = 'snow';
    let rpx = 0, rpz = 0, rn = 0, rBest = 0, rK = -1; // (guardrails: their own push, a glancing collision below; the line hit hardest)
    let mpCar = null, copCar = null, poles = 0;
    const R = d.w / 2, sp = Math.hypot(d.vx, d.vz);
    for (const k of [d.half - R, 0, -(d.half - R)]) {
      const cx = d.x + fx * k, cz = d.z + fz * k;
      const t = this.vegetation?.collide?.(cx, cz, R, 0.6, 'crown'); // (the whole tree: its branches too)
      if (t) { const dx = cx - t.x, dz = cz - t.z, l = Math.hypot(dx, dz) || 1; const o = R + (t.crown ?? t.r) - l; if (o > 0) { px += (dx / l) * o; pz += (dz / l) * o; n++; solid = true; kind = vegKind(t); } }
      // guardrails: a line you slide along (a scrape, never a crash)
      const RG = busRoads.railGrid;
      if (RG?.size) {
        const stamp = (this.railStamp = (this.railStamp || 0) + 1);
        for (let gx = Math.floor((cx - 1.4) / 16); gx <= Math.floor((cx + 1.4) / 16); gx++) for (let gz = Math.floor((cz - 1.4) / 16); gz <= Math.floor((cz + 1.4) / 16); gz++) {
        const cell = RG.get(gx * 100003 + gz);
        if (cell) for (const k of cell) {
          const g = busRoads.rails[k];
          if (g.stamp === stamp || g.off) continue; // (off: broken through, world/breakables.js)
          g.stamp = stamp;
          const ex = g.bx - g.ax, ez = g.bz - g.az, l2 = ex * ex + ez * ez || 1;
          const t2 = clamp(((cx - g.ax) * ex + (cz - g.az) * ez) / l2, 0, 1), qx = g.ax + ex * t2, qz = g.az + ez * t2;
          const dx = cx - qx, dz = cz - qz, l = Math.hypot(dx, dz), o = R + 0.12 - l;
          if (o > 0 && l > 1e-4) { rpx += (dx / l) * o; rpz += (dz / l) * o; rn++; if (o > rBest) { rBest = o; rK = k; } }
        }
        }
      }
      const cars = this.carColliders();
      for (const c of this.colliders) {
        if (c === d.e.collider || cars.has(c) || c.rail || c.police === 'local' || (c.bus && !d.crash)) continue; // (other cars: bash(); guardrails: their line colliders; your patrol cars: police.js; the ski buses: bash() too, a heavy box you crash into (Oct 30 2026, "also make it so you can crash into a bus"), only a soft bump while your wreck slides)
        const size = c.r ?? Math.max(c.hw, c.hd);
        if (c.breakable && sp > BREAK_V) { // (a little pole, a sign, a bollard: knocked flying, the car drives on: world/breakables.js)
          const reach = size + R, dx = c.x - cx, dz = c.z - cz;
          if (dx * dx + dz * dz < reach * reach && breakables.knock(c.breakable, d.vx, d.vz)) poles++;
          continue;
        }
        if (Math.abs(c.x - cx) > size + R + 0.5 || Math.abs(c.z - cz) > size + R + 0.5) continue;
        // (a small box some collision audit put round a breakable pole (world/solidify.js): ignored, else it stops the
        // car short of the pole, a "Knock" with car damage and the pole left standing)
        if (c.solidified && size < 0.7 && (c.brkShadow ??= !!breakables.at(c.x, c.z, 0.6))) continue;
        if (c.r !== undefined) {
          const dx = cx - c.x, dz = cz - c.z, l = Math.hypot(dx, dz);
          if (l < c.r + R) { px += (l > 1e-3 ? dx / l : 1) * (c.r + R - l); pz += (l > 1e-3 ? dz / l : 0) * (c.r + R - l); n++; if (!c.soft && !c.net) solid = true; kind = kindOf(c); }
        } else {
          const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), lx = (cx - c.x) * cs - (cz - c.z) * sn, lz = (cx - c.x) * sn + (cz - c.z) * cs;
          const ox = c.hw + R - Math.abs(lx), oz = c.hd + R - Math.abs(lz);
          if (ox > 0 && oz > 0) {
            let nlx = 0, nlz = 0;
            if (ox < oz) nlx = Math.sign(lx) || 1; else nlz = Math.sign(lz) || 1;
            const c2 = Math.cos(c.rot), s2 = Math.sin(c.rot), o = Math.min(ox, oz);
            px += (nlx * c2 - nlz * s2) * o; pz += (nlx * s2 + nlz * c2) * o; n++;
            if (!c.soft && !c.net) solid = true;
            kind = kindOf(c);
            if (c.mp && c.car) mpCar = c; // (another player's car: police.js onHit)
            if (c.police === 'remote') copCar = c; // (another player's patrol car (net/vehicles.js): police.js onHit 'police', you're wanted: Oct 30 2026)
          }
        }
      }
    }
    if (poles) { const f = Math.max(0.8, 1 - 0.05 * poles); d.vx *= f; d.vz *= f; d.pitchV -= 0.05; d.rollV += (Math.random() - 0.5) * 0.08; } // (a clack, a little speed lost)
    if (rn) this.railHit(rpx, rpz, rK);
    if (!n) return;
    const l = Math.hypot(px, pz) || 1, nx = px / l, nz = pz / l;
    d.x += px; d.z += pz;
    const vn = d.vx * nx + d.vz * nz;
    if (mpCar && vn < 0) this.hitReport('player-car', -vn);
    if (copCar && vn < 0) this.hitReport('police', -vn); // (Oct 30 2026, the user: "if you crash into a police car even when you're not wanted you should be wanted")
    // into something solid (a trunk, a building, a rock, a lift tower) at 40 km/h or more: a crash
    if (solid && -vn > CRASH_V && this.canCrash()) { this.crash(-vn, nx, nz, kind); return; }
    if (solid && -vn > KNOCK_V) this.knock(-vn, nx, nz);
    if (vn < 0) {
      d.vx -= nx * vn * 1.2; d.vz -= nz * vn * 1.2; // (a soft bounce back)
      d.vx *= 0.85; d.vz *= 0.85;
      d.yawRate *= 0.6;
      if (-vn > 2 && performance.now() - (this.bangT || 0) > 300) { this.bangT = performance.now(); this.audio?.impact ? this.audio.impact(kind === 'soft' ? 'snow' : kind, Math.min(0.7, -vn / 16)) : this.audio?.play('land', Math.min(1, -vn / 10)); d.pitchV -= Math.min(0.6, -vn * 0.04); }
    }
  }

  // A guardrail: a glancing collision, never a dead stop. Out of the rail by the overlap; the speed into it bounces
  // back with a little restitution (0.3), the speed along it is kept less a Coulomb friction loss (bigger the steeper
  // the angle); the nose is turned toward the rail's direction (the car glances off and runs along it) and given a
  // little yaw away from it. A head-on hit loses most of its speed but rolls back a bit. The sound: a thud by the
  // speed into the rail (audio.railHit) and a scrape loop while it slides along it (audio.setRailScrape, update()).
  railHit(px, pz, rk = -1) {
    const d = this.d, l = Math.hypot(px, pz);
    if (l < 1e-6) return;
    const nx = px / l, nz = pz / l;
    // (Oct 30, the user: "if you go faster than 100 km/h and then collide into the safety barriers you break through
    // them"): over 100 km/h and into it at 15 deg or more, the section breaks (world/breakables.js) and the car goes
    // through with a big hit
    // (Oct 30 2026: the angle also against the line hit itself, its own normal: at a joint the circle touched the next
    // section's end point too, and that push (radial from the point) tilted the summed normal by ~4 deg: 18 deg into a
    // straight rail measured 13.7, a scrape. Whichever of the two is steeper counts)
    const g = rk >= 0 ? busRoads.rails[rk] : null, gl = g ? Math.hypot(g.bx - g.ax, g.bz - g.az) : 0;
    const gs = gl > 1e-3 && (g.az - g.bz) * nx + (g.bx - g.ax) * nz < 0 ? -1 : 1;
    const into0 = Math.max(-(d.vx * nx + d.vz * nz), gl > 1e-3 ? -gs * (d.vx * (g.az - g.bz) + d.vz * (g.bx - g.ax)) / gl : -Infinity), sp0 = Math.hypot(d.vx, d.vz);
    // (Oct 30 2026, the user: "make sure the breaking guardrails above 100 kph works for all cars, everywhere, always,
    // because right now I don't think it does": it broke, but a car hitting at an angle sweeps W / sin(angle) of rail
    // with its body (7 m at 15 deg), more than the two sections that broke; the next one along still stood and the
    // car, slowed to ~65 % by the break (under 100 km/h), bounced off it back onto the road: 1 hit in 4 in a Node
    // check. Now, once through (d.thru: where it broke), every section the car touches within 12 m of there in the
    // next 1.5 s (d.start: the drive's clock), still faster than 30 km/h, breaks too at no extra cost: the car carries
    // on through the gap. A wreck sliding into one at 100+ km/h breaks it too (railBreak: it just slows))
    if (rk >= 0 && d.thru && sp0 > KNOCK_V && d.start - d.thru.t < 1.5 && Math.hypot(d.x - d.thru.x, d.z - d.thru.z) < 12 && breakables.breakRail(busRoads.rails, rk, d.x, d.z, d.vx, d.vz)) return;
    if (rk >= 0 && sp0 > RAIL_BREAK_V && into0 > sp0 * RAIL_BREAK_SIN && breakables.breakRail(busRoads.rails, rk, d.x, d.z, d.vx, d.vz)) { d.thru = { x: d.x, z: d.z, t: d.start }; this.railBreak(into0, nx, nz); return; }
    d.x += px; d.z += pz;
    const vn = d.vx * nx + d.vz * nz;
    let tx = -nz, tz = nx, vt = d.vx * tx + d.vz * tz;
    if (vt < 0) { tx = -tx; tz = -tz; vt = -vt; }
    if (vn < -0.05) {
      const e = 0.3, mu = 0.22, into = -vn;
      const vt2 = Math.max(vt * 0.35, vt - mu * (1 + e) * into); // (friction: never more than 65 % of the speed along it)
      const vn2 = e * into + 0.4;                                   // (out of it: a bounce, plus a nudge clear of the rail)
      d.vx = tx * vt2 + nx * vn2; d.vz = tz * vt2 + nz * vn2;
      // the heading: turned part of the way to the new direction of travel (forwards or reversing, whichever is nearer)
      const sp = Math.hypot(d.vx, d.vz);
      if (sp > 1) {
        const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), back = d.vx * fx + d.vz * fz < 0;
        const travel = Math.atan2(back ? -d.vx : d.vx, back ? -d.vz : d.vz), err = wrapPi(travel - d.yaw);
        const turn = clamp(err * 0.55, -0.35, 0.35);
        d.yaw = wrapPi(d.yaw + turn);
        d.yawRate = d.yawRate * 0.3 + clamp(err, -1, 1) * 0.6; // (a little yaw away from the rail)
      } else d.yawRate *= 0.5;
      if (into > KNOCK_V * 1.4) this.knock(into, nx, nz); // (a hard hit dents it: no crash, you drive on)
      d.rollV += (Math.random() - 0.5) * Math.min(0.5, into * 0.05);
      d.pitchV -= Math.min(0.3, into * 0.02);
      const now = performance.now();
      if (into > 1.2 && now - (this.railBangT || 0) > 220) { this.railBangT = now; try { this.audio?.railHit ? this.audio.railHit(Math.min(1, into / 14), vt2) : this.audio?.impact?.('metal', Math.min(0.7, into / 16)); } catch { /* (silent) */ } }
    }
    d.railSlide = Math.max(d.railSlide || 0, vt); // (the scrape loop's speed: update())
    d.railT = 0.12;
  }

  // through a guardrail (railHit): a big hit, ~35 % of the speed gone, damage and a dent, the crash sound; wrecked
  // only by the usual rules (the damage reaching 100 %, or into it at 150 km/h+)
  railBreak(into, nx, nz) {
    const d = this.d, e = d.e, add = 6 + into * 0.6;
    if (d.crash) { d.vx *= 0.64; d.vz *= 0.64; try { this.audio?.impact?.('metal', 0.95); } catch { /* (silent) */ } return; } // (a wreck sliding through: slowed, no more damage)
    if ((into >= EXTREME_V || (e.damage || 0) + add >= 100) && this.canCrash()) { this.crash(Math.max(into, CRASH_V), nx, nz, 'metal'); return; }
    e.damage = Math.min(99, (e.damage || 0) + add);
    this.knockT = performance.now();
    try { this.dent(nx, nz, Math.min(0.8, 0.4 + into / 40)); } catch (err) { console.warn('drive: dent', err); }
    d.vx *= 0.64; d.vz *= 0.64;
    const side = Math.random() < 0.5 ? -1 : 1;
    d.yawRate = clamp(d.yawRate + side * 0.5, -2, 2);
    d.pitchV -= 0.7; d.rollV += side * 0.4;
    this.shake = Math.max(this.shake || 0, 0.7);
    try { this.audio?.impact?.('metal', 0.95); this.audio?.carCrash?.(0.45); } catch { /* (silent) */ }
    this.hud?.flash(`Through the guardrail · car damage ${Math.round(e.damage)}%`, 'bad', 2200);
  }

  // on foot (or skis) inside a parked car's footprint (never meant to happen): out to the nearer side of it
  unstick() {
    const p = this.player;
    if (!p || this.entering || (p.mode !== 'walk' && p.mode !== 'ski')) return;
    this.unstickT = (this.unstickT || 0) + 1;
    if (this.unstickT % 6) return;
    for (const e of this.parking?.cars || []) {
      const g = e.car.position, yaw = e.car.rotation.y, dx = p.pos.x - g.x, dz = p.pos.z - g.z;
      if (Math.abs(dx) > 4 || Math.abs(dz) > 4) continue;
      const a = dx * Math.cos(yaw) - dz * Math.sin(yaw), b = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      if (Math.abs(a) > 0.9 || Math.abs(b) > e.length / 2 - 0.15) continue;
      const sp = this.exitSpot({ x: g.x, z: g.z, yaw, w: 1.9, half: e.length / 2, e });
      p.pos.x = sp.x; p.pos.z = sp.z; p.pos.y = this.world.height(sp.x, sp.z);
      p.vel?.set?.(0, 0, 0);
      break;
    }
  }

  // ------------------------------------------------------------------ bashing into cars and people
  // the colliders of the other cars (traffic, parked): handled by bash(), not by the soft bumps
  carColliders() {
    const n = (this.traffic?.cars?.length || 0) + (this.parking?.cars?.length || 0);
    if (this._cc && this._ccN === n) return this._cc;
    this._ccN = n;
    this._cc = new Set([...(this.traffic?.cars || []).map((c) => c.collider), ...(this.parking?.cars || []).map((e) => e.collider)]);
    return this._cc;
  }
  // the ski buses near (x, z) as bash() obstacles (Oct 30 2026, the user: "also make it so you can crash into a bus"):
  // their colliders (bus.js: bus:0's and the fleet's, bus: true; away at 1e9 while not drawn or while you ride it), the
  // box the bus model's own footprint (its shell's size, else the collider's), 12 t, its velocity the fleet bus's own
  // (the timetable's speed along its heading: in multiplayer the shared timeline the client draws, net/transit.js);
  // bus:0 stands whenever it's solid (at the village stop or in its depot bay)
  busesNear(x, z, out) {
    const line = globalThis.__game?.skibus?.line || null, fl = line?.fleet || [];
    if (!this._busC || this._busN !== this.colliders.length || this._busF !== fl.length) {
      this._busN = this.colliders.length; this._busF = fl.length;
      this._busC = this.colliders.filter((c) => c.bus);
      this._busO = new Map(fl.map((b) => [b.collider, b]));
      const sz = line?.bus?.shell?.userData?.size;
      this._busFoot = sz && sz.x > 0 && sz.z > 0 ? { hw: clamp(Math.min(sz.x, sz.z) / 2, 1.0, 1.5), hd: clamp(Math.max(sz.x, sz.z) / 2, 4, 8) } : null; // (the length the long side, whichever axis the model has it on)
    }
    for (const c of this._busC) {
      if (Math.abs(c.x - x) > 13 || Math.abs(c.z - z) > 13) continue;
      const b = this._busO.get(c), yaw = -c.rot, v = b && !b.taken && !b.at ? b.v || 0 : 0;
      out.push({ kind: 'bus', o: b || line, c, x: c.x, z: c.z, yaw, hw: this._busFoot?.hw ?? c.hw, hd: this._busFoot?.hd ?? c.hd, m: 12000, vx: Math.sin(yaw) * v, vz: Math.cos(yaw) * v });
    }
  }
  // Your car against the others (boxes, separating axes): a real knock above a walking pace, both cars get the impulse
  // of the closing speed by their masses (a bounce), the other one a spin from where it was hit: a traffic car slides
  // aside and comes to rest crooked on its road (traffic.js 'knocked' / 'wreck': never beyond the plowed edge + 1 m or
  // through a guardrail / tree; the 5-minute watchdog parks it in a car park), a parked one is shoved out of its bay.
  // Yours just bounces (no damage, no wipeout). People in the way are knocked over (peoplehits.js: they fall, fined).
  bash(dt) {
    const d = this.d;
    if (!d) return;
    const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);
    const A = { x: d.x, z: d.z, yaw: d.yaw, hw: d.w / 2 - 0.08, hd: d.half };
    const m1 = MASS[d.e.name] || 1700, I1 = (m1 * (4 * d.half * d.half + d.w * d.w)) / 12;
    const others = [];
    for (const c of this.traffic?.cars || []) if (c.mode !== 'gone' && c.g.visible && Math.abs(c.x - d.x) < 9 && Math.abs(c.z - d.z) < 9) others.push({ kind: 'traffic', o: c, x: c.x, z: c.z, yaw: c.yaw, hw: c.w / 2 - 0.08, hd: c.l / 2, m: MASS[c.name] || 1700, vx: Math.sin(c.yaw) * (c.mode === 'knocked' ? 0 : c.v) * (c.rev ? -1 : 1) + (c.kvx || 0), vz: Math.cos(c.yaw) * (c.mode === 'knocked' ? 0 : c.v) * (c.rev ? -1 : 1) + (c.kvz || 0) });
    for (const e of this.parking?.cars || []) if (e !== d.e && !e.driving && !this.aboard?.(e) && Math.abs(e.car.position.x - d.x) < 9 && Math.abs(e.car.position.z - d.z) < 9) others.push({ kind: 'parked', o: e, x: e.car.position.x, z: e.car.position.z, yaw: e.car.rotation.y, hw: 0.9, hd: e.length / 2, m: MASS[e.name] || 1700, vx: e.slide?.vx || 0, vz: e.slide?.vz || 0 }); // (not your car on a tow truck's bed: Oct 30 2026)
    try { this.busesNear(d.x, d.z, others); } catch (err) { if (!this.busWarn) { this.busWarn = true; console.warn('drive: buses', err); } } // (Oct 30 2026, "also make it so you can crash into a bus": 12 t boxes, see busesNear)
    for (const B of others) {
      const hit = obb(A, B);
      if (!hit) continue;
      const { nx, nz, depth, px, pz } = hit; // (normal from B to A; contact point)
      const m2 = B.m, I2 = (m2 * (4 * B.hd * B.hd + 4 * B.hw * B.hw)) / 12;
      // closing speed along the normal (with the turning of both at the contact)
      const r1x = px - d.x, r1z = pz - d.z, r2x = px - B.x, r2z = pz - B.z;
      const bus = B.kind === 'bus', w2 = bus ? 0 : B.kind === 'traffic' ? B.o.kw || 0 : B.o.slide?.w || 0; // (a bus never spins)
      const v1x = d.vx + d.yawRate * r1z, v1z = d.vz - d.yawRate * r1x, v2x = B.vx + w2 * r2z, v2z = B.vz - w2 * r2x;
      const vn = (v1x - v2x) * nx + (v1z - v2z) * nz;
      const bash = -vn > 1.3 || (B.kind === 'traffic' && B.o.mode !== 'road' && B.o.mode !== 'lot' && B.o.mode !== 'parked' && -vn > 0.2);
      // push apart (by mass when it's a knock; a nudge only moves you), then the impulse when they close
      const share = bash && !bus ? m2 / (m1 + m2) : 1; // (a bus stays where it is: you take the whole overlap)
      d.x += nx * depth * share; d.z += nz * depth * share;
      if (vn >= 0) continue;
      const e = 0.28;
      const rn1 = r1z * nx - r1x * nz, rn2 = r2z * nx - r2x * nz; // (r x n, about y)
      const J = (-(1 + e) * vn) / (1 / m1 + (bash ? 1 / m2 + (rn2 * rn2) / I2 : 0) + (rn1 * rn1) / I1);
      d.vx += (J / m1) * nx; d.vz += (J / m1) * nz;
      d.yawRate += clamp(((r1z * nx - r1x * nz) * J) / I1, -1.5, 1.5) * 0.5;
      if (!bash) continue; // (a nudge at parking speed: only you bounce)
      this.hitReport(B.kind, -vn); // (police.js: a hit calls the police)
      if (bus) { // (Oct 30 2026, "also make it so you can crash into a bus": the bus barely notices, never knocked off its route; you bounce, and the car rules for the damage on the closing speed, its own speed in it, so a head-on with a moving bus hurts: a knock above KNOCK_V, a crash above CRASH_V at any angle (a 12 t wall), wrecked above EXTREME_V (crash()))
        const hard = Math.min(1, -vn / 12);
        if (-vn > CRASH_V && this.canCrash()) { this.crash(-vn, nx, nz, 'car'); return; }
        if (-vn > KNOCK_V) this.knock(Math.max(KNOCK_V + 0.1, -vn * (Math.abs(nx * fx + nz * fz) > 0.6 ? 1 : 0.8)), nx, nz); // (a glancing scrape a little softer)
        if (performance.now() - (this.bangT || 0) > 250) { this.bangT = performance.now(); if (this.audio?.impact) this.audio.impact('car', 0.35 + 0.45 * hard); else this.audio?.play('land', 0.5 + 0.5 * hard); d.pitchV -= 0.3 * hard; d.rollV += (Math.random() - 0.5) * 0.7 * hard; this.shake = Math.max(this.shake || 0, 0.25 + 0.4 * hard); }
        continue;
      }
      const dvx = (-J / m2) * nx, dvz = (-J / m2) * nz, dw = clamp((-(r2z * nx - r2x * nz) * J) / I2, -2.5, 2.5);
      if (B.kind === 'traffic') this.traffic?.knock?.(B.o, B.vx + dvx, B.vz + dvz, w2 + dw);
      else this.shove(B.o, B.vx + dvx, B.vz + dvz, w2 + dw);
      // and the other car pushed its share out of the overlap
      const o = B.kind === 'traffic' ? B.o : null;
      if (o) { o.x -= nx * depth * (1 - share); o.z -= nz * depth * (1 - share); }
      else { B.o.car.position.x -= nx * depth * (1 - share); B.o.car.position.z -= nz * depth * (1 - share); }
      const hard = Math.min(1, -vn / 12);
      // head-on into another car at 40 km/h or more (closing): a crash
      if (-vn > CRASH_V && Math.abs(nx * fx + nz * fz) > 0.6 && this.canCrash()) { this.crash(-vn, nx, nz, 'car'); return; }
      if (-vn > KNOCK_V) this.knock(-vn * (Math.abs(nx * fx + nz * fz) > 0.6 ? 1 : 0.7), nx, nz);
      if (performance.now() - (this.bangT || 0) > 250) { this.bangT = performance.now(); if (this.audio?.impact) this.audio.impact('car', 0.25 + 0.4 * hard); else this.audio?.play('land', 0.4 + 0.6 * hard); d.pitchV -= 0.25 * hard; d.rollV += (Math.random() - 0.5) * 0.6 * hard; }
    }
    // people: knocked over (and a fine) when the car's body touches them; the car only bumps softly
    try {
      const sp = Math.hypot(d.vx, d.vz);
      if (sp > 0.6) {
        for (const p of peopleNear(d.x, d.z, d.half + 1.2, this._ppl || (this._ppl = []))) {
          const dx = p.x - d.x, dz = p.z - d.z, lz = dx * fx + dz * fz, lx = dx * fz - dz * fx;
          if (Math.abs(lz) > d.half + 0.3 || Math.abs(lx) > d.w / 2 + 0.3) continue;
          const l = Math.hypot(dx, dz) || 1, closing = Math.max(sp * 0.5, (d.vx * dx + d.vz * dz) / l);
          const r = knockPerson(p, closing, 'car', d.vx / sp, d.vz / sp, d.e.collider); // (the car's box: the body is kept out of it, Oct 31 2026)
          if (r?.fell) { d.vx *= 0.9; d.vz *= 0.9; this.audio?.play('land', 0.5); this.hitReport('person', closing); }
          else if (!r) { // (people hits off: the car just bumps softly off them)
            const nx = -dx / l, nz = -dz / l, vn = d.vx * nx + d.vz * nz;
            if (vn < 0) { d.vx -= nx * vn * 1.1; d.vz -= nz * vn * 1.1; d.vx *= 0.9; d.vz *= 0.9; }
          }
        }
        this._ppl.length = 0;
      }
    } catch { /* (people are optional) */ }
  }
  // a parked car shoved: it slides (and turns) to a stop on the snow, where it stays
  shove(e, vx, vz, w) {
    e.home ||= { x: e.car.position.x, z: e.car.position.z, yaw: e.car.rotation.y };
    e.slide = { vx, vz, w };
    if (!this.sliding.includes(e)) this.sliding.push(e);
  }
  slideParked(dt) {
    for (let i = this.sliding.length - 1; i >= 0; i--) {
      const e = this.sliding[i], s = e.slide, g = e.car;
      try {
        const sp = Math.hypot(s.vx, s.vz), dec = 0.6 * G * dt;
        if (sp > dec) { s.vx -= (s.vx / sp) * dec; s.vz -= (s.vz / sp) * dec; } else { s.vx = 0; s.vz = 0; }
        s.w *= Math.exp(-dt * 2.6);
        if (Math.abs(s.w) < 0.04 && !s.vx && !s.vz) s.w = 0;
        g.position.x += s.vx * dt; g.position.z += s.vz * dt;
        g.rotation.y = wrapPi(g.rotation.y + s.w * dt);
        g.position.y = (this.world.meshHeight || this.world.height).call(this.world, g.position.x, g.position.z) + 0.03;
        g.updateMatrixWorld(true);
        e.collider.x = g.position.x; e.collider.z = g.position.z; e.collider.rot = -g.rotation.y;
        if (!s.vx && !s.vz && !s.w) {
          e.slide = null; this.sliding.splice(i, 1);
          // left crooked out of its bay: back into it soon (out of sight, or a while later from afar)
          const h = e.home;
          if (h && !e.driving && (Math.hypot(g.position.x - h.x, g.position.z - h.z) > 0.4 || Math.abs(wrapPi(g.rotation.y - h.yaw)) > 0.08)) { e.astray = { t: 0, unseen: 0 }; if (!this.wrecks.includes(e)) this.wrecks.push(e); }
        }
      } catch { e.slide = null; this.sliding.splice(i, 1); }
    }
  }

  // the body on its springs (roll in bends, pitch under acceleration and braking), the wheels on the snow
  pose(dt) {
    const d = this.d, g = d.e.car, fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), lx = fz, lz = -fx; // (+x local: left)
    const W = this.world, wb = d.wheelBase / 2, tr = d.w / 2 - 0.15;
    const hFL = W.groundHeight(d.x + fx * wb + lx * tr, d.z + fz * wb + lz * tr, d.y + 1);
    const hFR = W.groundHeight(d.x + fx * wb - lx * tr, d.z + fz * wb - lz * tr, d.y + 1);
    const hRL = W.groundHeight(d.x - fx * wb + lx * tr, d.z - fz * wb + lz * tr, d.y + 1);
    const hRR = W.groundHeight(d.x - fx * wb - lx * tr, d.z - fz * wb - lz * tr, d.y + 1);
    const ground = (hFL + hFR + hRL + hRR) / 4;
    const pitchG = Math.atan2((hRL + hRR) / 2 - (hFL + hFR) / 2, wb * 2), rollG = Math.atan2((hFL + hRL) / 2 - (hFR + hRR) / 2, tr * 2);
    // springs: the ground's tilt, plus the load moving (nose up when pulling away, down when braking; out in bends)
    const pitchT = clamp(d.air ? d.pitch : pitchG - clamp(d.la * 0.007, -0.06, 0.05), -0.6, 0.6); // (nose down braking, squat pulling)
    const yawAccel = d.yawRate * Math.hypot(d.vx, d.vz);
    const rollT = clamp(d.air ? d.roll : rollG + clamp(yawAccel * 0.011, -0.07, 0.07), -0.6, 0.6); // (leans out of the bend)
    // springs damped near critically: it settles at once, no bobbing
    d.pitchV += ((pitchT - d.pitch) * 110 - d.pitchV * 18) * dt; d.pitch += d.pitchV * dt;
    d.rollV += ((rollT - d.roll) * 95 - d.rollV * 16.5) * dt; d.roll += d.rollV * dt;
    const y = d.air ? d.y : ground;
    g.position.set(d.x, y + 0.02, d.z);
    _e.set(d.pitch, d.yaw, d.roll + (d.crash?.roll || 0), 'YXZ');
    g.quaternion.setFromEuler(_e);
    if (d.crash?.roll) {
      // rolling over: round its own middle, resting on whichever side is down
      const cr = d.crash.roll, h2 = d.t.size.y / 2, rest = Math.abs(Math.cos(cr)) * h2 + Math.abs(Math.sin(cr)) * (d.w / 2);
      const off = _w.set(0, h2, 0).applyQuaternion(g.quaternion);
      g.position.set(d.x - off.x, ground + rest - off.y, d.z - off.z);
    }
    g.updateMatrixWorld(true);
    // wheels: spin with the ground speed, the front ones steer, each one dropped / lifted to its own patch of snow
    const u = d.vx * fx + d.vz * fz, hs = [hRL, hRR, hFL, hFR];
    for (const [i, wh] of (d.inst.wheels || []).entries()) {
      wh.roll.rotation.x += (u * dt) / wh.r; // (rolling: a turn per 2 pi r driven)
      if (wh.front) wh.steer.rotation.y = d.steer;
      const k = (wh.front ? 2 : 0) + (wh.steer.position.x < 0 ? 1 : 0);
      wh.steer.position.y = (wh.baseY ??= wh.steer.position.y) + clamp((hs[k] ?? ground) - ground, -0.1, 0.1);
      void i;
    }
    // the steering wheel: ~100 deg either way at full lock at parking speed (less at speed, as the lock is less).
    // (Oct 27, the user: "the steering wheel moves way too much by just a turn": it was x7, two thirds of a turn either
    // way, and a key tap goes to full lock; now a turn reads as hands turning the wheel, not spinning it)
    if (d.inst.steering) d.inst.steering.col.quaternion.setFromAxisAngle(d.inst.steering.axis, -d.steer * 3);
  }

  updateSeat() {
    const d = this.d;
    // the driver's eye: left front seat, behind the steering wheel (cars.js driverEye, from where the wheel is)
    if (d.eyeT !== d.t) { d.eyeT = d.t; d.eyeLocal = driverEye(d.t); }
    const eye = d.eyeLocal;
    // you sit on the seat's cushion against its backrest (carpeople.js seatHip, the model's own seat; the rig's hip is
    // 0.1 m above its seat point), inside and out, the seat slid forward where the wheel would be out of reach; a car
    // without seat hints: so your eyes are at its driver's eye
    const hip = seatHip(d.t, 0.1, 0.42);
    if (hip) this.seat.pos.set(hip.x, hip.y - 0.1, hip.z);
    else this.seat.pos.set(eye.x, eye.y - SEAT_EYE.y, eye.z - SEAT_EYE.z);
    d.e.car.localToWorld(this.seat.pos);
    this.seat.fwd.set(Math.sin(d.yaw), 0, Math.cos(d.yaw));
  }

  // first person from the driver's seat (the mouse looks round, about 120 degrees either way; the head moving a
  // little with the car), or a chase camera: the mouse orbits it round the car (it swings back behind the car after
  // 1.5 s without the mouse), it lags a little in turns, looks into them and pulls back with speed (C: look back)
  placeCamera(dt, input, lookBack) {
    const d = this.d, cam = this.camera, C = this.cam, g = d.e.car, sp = this.speed, p = this.player;
    const sens = 0.0022 * (p.sensitivity || 1);
    const mdx = input?.mdx || 0, mdy = input?.mdy || 0;
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const rough = d.crash ? 0 : this.roughness || 0;
    if (this.view === 'cockpit') {
      this.look.yaw = clamp(this.look.yaw - mdx * sens, -2.09, 2.09);
      this.look.pitch = clamp(this.look.pitch - mdy * sens, -1.05, 0.5);
      const ly = lookBack ? Math.PI : this.look.yaw;
      const eye = _v.copy(d.eyeRig || d.eyeLocal).add(_w.set(clamp(-d.lat * 0.002, -0.03, 0.03), 0, clamp(-d.la * 0.003, -0.03, 0.03))); // (your own eyes: placeRig)
      // a little over your eyes (sitting up tall: more road over the bonnet; Oct 27, the user: "move the camera a bit
      // higher so you can see more out the window in front of you"), never into the headlining
      eye.y = Math.min(eye.y + COCKPIT_RAISE, d.t.size.y - 0.17);
      g.localToWorld(eye);
      const dir = _w.set(Math.sin(ly) * Math.cos(this.look.pitch), Math.sin(this.look.pitch), Math.cos(ly) * Math.cos(this.look.pitch)).transformDirection(g.matrixWorld);
      cam.position.copy(eye);
      cam.up.set(0, 1, 0);
      cam.lookAt(eye.add(dir));
      cam.near = 0.05;
      cam.fov += (72 + sp * 0.08 - cam.fov) * (1 - Math.exp(-dt * 4));
      d.inst.full.visible = true;
      this.cabinGlass(true);
      this.cabinLight(true);
      // you: your own character in the seat, hands on the wheel (placeRig), the head left out (player.js: first person)
      p.view = 'first';
      p.rig.root.visible = (d.rigFrames = (d.rigFrames || 0) + 1) > 3; p.rig.gear.visible = false;
    } else {
      const travel = sp > 2 ? Math.atan2(d.vx, d.vz) : d.yaw;
      const now = performance.now();
      if (!C.ready) { C.oyaw = d.yaw + Math.PI; C.pitch = 0.17; C.lastMouse = 0; }
      if (mdx || mdy) { C.lastMouse = now; C.oyaw -= mdx * sens; C.pitch = clamp(C.pitch + mdy * sens, -0.08, 1.0); }
      // eases back behind the car (or ahead of it, looking back) when the mouse rests
      if (lookBack || now - C.lastMouse > 1500) {
        const target = (lookBack ? travel : travel + Math.PI) - d.yawRate * 0.12; // (a little into the turn)
        C.oyaw += wrapPi(target - C.oyaw) * (1 - Math.exp(-dt * (lookBack ? 10 : 3)));
        C.pitch += (0.17 - C.pitch) * (1 - Math.exp(-dt * 2));
      }
      const dist = 5.6 + sp * 0.05, cp = Math.cos(C.pitch);
      const focus = _v.set(d.x, g.position.y + 1.25, d.z);
      const want = _w.set(focus.x + Math.sin(C.oyaw) * cp * dist, focus.y + 0.25 + Math.sin(C.pitch) * dist, focus.z + Math.cos(C.oyaw) * cp * dist);
      const gy = this.world.height(want.x, want.z) + 0.8;
      if (want.y < gy) want.y = gy;
      const bl = this.cameraBlockers;
      if (bl?.length) {
        const dv = want.clone().sub(focus), len = dv.length();
        _ray.set(focus, dv.divideScalar(len)); _ray.far = len;
        const hit = _ray.intersectObjects(bl, true)[0];
        if (hit) want.copy(focus).addScaledVector(_ray.ray.direction, Math.max(1.5, hit.distance - 0.4));
      }
      if (!C.ready || lookBack !== C.lb) { C.pos.copy(want); C.ready = true; C.lb = lookBack; }
      C.pos.lerp(want, 1 - Math.exp(-dt * 9));
      cam.position.copy(C.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(focus);
      cam.near = 0.1;
      cam.fov += (62 + sp * 0.2 - cam.fov) * (1 - Math.exp(-dt * 3));
      this.cabinGlass(false);
      this.cabinLight(false);
      p.view = 'third';
      p.rig.root.visible = (d.rigFrames = (d.rigFrames || 0) + 1) > 3; p.rig.gear.visible = false; // (you in the driver's seat, skis stowed; shown once seated)
    }
    // shake: a crash (strong, dying away), rough snow at speed (subtle)
    // (a crash: a hard random jolt dying away; rough snow: a smooth wobble that grows with speed, never jitter)
    const k = this.shake * this.shake * 0.16, kr = rough * Math.min(1, sp / 25) * 0.01, tt = performance.now() / 1000;
    if (k > 1e-4) cam.position.add(_w.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k));
    if (kr > 1e-4) cam.position.add(_w.set(Math.sin(tt * 19.3) * kr * 0.6, (Math.sin(tt * 27.1) + Math.sin(tt * 41.7 + 1.3) * 0.5) * kr, Math.sin(tt * 23.9 + 0.7) * kr * 0.4));
    cam.updateProjectionMatrix();
  }

  // Inside: the materials keep their own look; a soft warm fill lights the cabin, the cluster and the screens glow
  // (carlights.js cabinLight: gentle by day, brighter at night, a brief dome light getting in at night), in first
  // person and in the chase view (the cabin seen through the windows); off when you get out.
  cabinLight(inside) {
    const d = this.d;
    if (!d?.inst?.full) return;
    const was = d.cabinInst && d.cabinInst !== d.inst ? d.cabinInst : null, t0 = was?.cabin?.t0;
    if (was) cabinLight(was, d.cabinT, { on: false }); // (swapped for the full-detail model: the dome light carries on)
    d.cabinInst = d.inst; d.cabinT = d.t;
    cabinLight(d.inst, d.t, { on: true, inside });
    if (t0 && d.inst.cabin) d.inst.cabin.t0 = t0;
  }

  // from inside, the windows nearly clear (the tinted glass seen from outside would darken the whole view)
  cabinGlass(inside) {
    const g = this.d?.inst?.glass;
    if (!g || this.d.glassIn === inside) return;
    this.d.glassIn = inside;
    for (const m of g) {
      m.userData.outMat ||= m.material;
      if (inside) m.material = m.userData.inMat ||= Object.assign(m.userData.outMat.clone(), { opacity: 0.1 });
      else m.material = m.userData.outMat;
    }
  }

  effects(dt, thr) {
    const d = this.d, night = nightUniform?.value ?? 0;
    const on = d.lights || night > 0.2 ? 1 : 0;
    const braking = !d.crash && (d.gear === 'R' ? d.la > 2 : d.la < -2); // (slowing, either way; not pulling away in R)
    // the car's own lamps glow (head and tail at night, the brake lights whenever it brakes); crashed, they stay on
    // (the tails dim) and the hazards flash
    lampsOn(d.inst, on, on, braking ? 1 : 0, { drl: !on && !d.crash ? 1 : 0, reverse: !d.crash && d.gear === 'R', hazard: d.crash ? hazardPhase() : null });
    // (the beams from the headlamps themselves: where they sit on this model, how far apart)
    const hs = headlampSpot(d.inst);
    (this.pool ||= new LightPool(this.scene)).update(d.x, d.z, d.yaw, hs ? hs.z : d.half, this.world, on, 1, hs ? hs.spread : 0);
    // the tail lights' red glow on the snow behind (brighter braking)
    (this.tailPool ||= new LightPool(this.scene, 0xff2a14)).update(d.x, d.z, d.yaw + Math.PI, d.half, this.world, on ? (braking ? 0.75 : 0.35) : braking && night > 0.05 ? 0.4 : 0, 0.28);
    const dmg = d.e.damage || 0;
    if (d.crash || dmg >= 40) {
      // steam from the bonnet: a wisp once it's badly knocked about, a plume when it's wrecked
      d.e.smokeFx ||= new Smoke(this.scene);
      d.e.smokeFx.rate = d.crash ? 6 : 0.8 + ((dmg - 40) / 60) * 3;
      const b = _v.set(0, d.t.size.y * 0.78, d.t.size.z / 2 - 0.8); d.e.car.localToWorld(b);
      d.e.smokeFx.update(dt, !d.crash || d.crash.t > 0.25 ? b : null, this.camera, night, _w.set(Math.sin(d.yaw), 0, Math.cos(d.yaw)), on);
    }
    try { this.audio?.setCar?.({ on: true, rpm: d.rpm, load: d.load, electric: !!d.spec.electric, squeal: d.squeal, horn: d.horn, speed: this.speed, profile: d.spec.sound || 'i4', shift: d.shiftT > 0, inside: this.view === 'cockpit', crank: d.crank, firing: d.crash ? 0 : d.firing }); } catch (e) { if (!this.audioErr) { this.audioErr = true; console.warn('car audio', e); } }
  }

  // back on its wheels, upright, on clear ground, a little lift (behind a fade)
  unflip() {
    const d = this.d;
    if (!d || this.flipping) return;
    this.flipping = true;
    this.transition.fade(async () => {
      try {
        if (!this.d) return;
        let x = d.x, z = d.z;
        if (!this.clearAt(x, z, d.w / 2, d.e)) for (const [ox, oz] of [[3, 0], [-3, 0], [0, 4], [0, -4], [5, 5], [-5, -5]]) if (this.clearAt(d.x + ox, d.z + oz, d.w / 2, d.e)) { x = d.x + ox; z = d.z + oz; break; }
        d.x = x; d.z = z; d.y = this.world.groundHeight(x, z, d.y + 3) + 0.25;
        d.vx = 0; d.vz = 0; d.vy = 0; d.yawRate = 0; d.air = true;
        d.pitch = 0; d.roll = 0; d.pitchV = 0; d.rollV = 0; d.flipT = 0;
      } finally { this.flipping = false; }
    }).catch(() => { this.flipping = false; });
  }

  // U: unstuck (Oct 30 2026, the user: "sometimes when your car is stuck it moves forward or backward automatically to
  // unstick itself", chose "no automatic moving", "an unstuck key" instead): slow (under 5 km/h), not wanted ("Not
  // while the police are after you": no escaping a chase by it), every 10 s. Behind a short fade: upright on the
  // nearest clear spot (unstuckSpot), facing along the road / bay, stopped. (Multiplayer: the car's pose goes out
  // as always, net/carride.js pose())
  unstuck() {
    const d = this.d;
    if (!d || d.crash || this.flipping || this.unsticking) return;
    const now = performance.now();
    if (this.isWanted?.()) { this.hud?.flash('Not while the police are after you', 'bad', 1900); return; }
    if (this.speed >= UNSTUCK_V) { this.hud?.flash('Unstuck: only when stuck (stopped)', 'bad', 1600); return; }
    const left = UNSTUCK_CD - (now - (this.unstuckT || -1e9));
    if (left > 0) { this.hud?.flash(`Unstuck again in ${Math.ceil(left / 1000)} s`, 'bad', 1500); return; }
    this.unsticking = true;
    this.transition.fade(async () => {
      try {
        if (this.d !== d || d.crash) return;
        const sp = this.unstuckSpot();
        if (!sp) { this.hud?.flash('No clear spot nearby', 'bad', 1800); return; }
        this.unstuckT = performance.now();
        d.x = sp.x; d.z = sp.z; d.yaw = sp.yaw;
        d.y = this.world.groundHeight(sp.x, sp.z, (sp.y ?? d.y) + 3) + 0.25;
        d.vx = 0; d.vz = 0; d.vy = 0; d.yawRate = 0; d.air = true; d.steer = 0;
        d.pitch = 0; d.roll = 0; d.pitchV = 0; d.rollV = 0; d.flipT = 0; d.stuckT = 0; d.restAt = null;
        d.la = 0; d.lat = 0; d.thrP = 0; d.brkP = 0; d.gear = 'D'; d.gi = 0; d.railT = 0; d.railSlide = 0;
        this.tyres?.end?.(); // (no tyre strip from where it was)
        this.cam.ready = false; // (the camera starts afresh behind it)
        this.hud?.flash('Unstuck', 'good', 1400);
      } finally { this.unsticking = false; }
    }).catch(() => { this.unsticking = false; });
  }
  // the nearest place the car fits (its box clear of cars, buildings, trees, rails: clearAt along its length): the
  // right-hand lane of a road (facing the way of the lane nearer the car's heading) or a car-park bay (nose out),
  // within UNSTUCK_R m; else the nearest flat (under ~11 degrees), clear ground within 30 m, as it faces; else null
  unstuckSpot() {
    const d = this.d, fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), R2 = UNSTUCK_R * UNSTUCK_R;
    const r = d.w / 2 + 0.15, k = Math.max(0, d.half - r);
    const fits = (x, z, yaw) => { const ax = Math.sin(yaw), az = Math.cos(yaw); for (const t of [k, 0, -k]) if (!this.clearAt(x + ax * t, z + az * t, r, d.e)) return false; return true; };
    const cands = [], q = {};
    for (const rd of busRoads.roads) for (let i = 0; i < rd.n; i++) {
      const dx = rd.X[i] - d.x, dz = rd.Z[i] - d.z, d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      roadAt(rd, rd.S[i], q);
      let hx = q.dx, hz = q.dz;
      if (hx * fx + hz * fz < 0) { hx = -hx; hz = -hz; }
      const x = q.x - hz * 1.6, z = q.z + hx * 1.6; // (the right-hand lane, as the traffic keeps: traffic.js LANE)
      cands.push({ x, z, y: q.y, yaw: Math.atan2(hx, hz), d2: (x - d.x) ** 2 + (z - d.z) ** 2 });
    }
    for (const L of busRoads.lots) {
      if (L.impound || L.building || !L.bays?.length || (L.x - d.x) ** 2 + (L.z - d.z) ** 2 > (UNSTUCK_R + 40) ** 2) continue; // (never into the impound's pound / the Autohaus's own bays)
      for (const b of L.bays) { const d2 = (b.x - d.x) ** 2 + (b.z - d.z) ** 2; if (d2 <= R2 && !b.taken) cands.push({ x: b.x, z: b.z, y: null, yaw: Math.atan2(b.hx, b.hz), d2 }); }
    }
    cands.sort((a, b) => a.d2 - b.d2);
    let tries = 0;
    for (const c of cands) { if (fits(c.x, c.z, c.yaw)) return c; if (++tries > 160) break; }
    // no road or car park near: flat, clear ground, rings out from the car
    const W = this.world, e = 1.4;
    for (let rr = 3; rr <= 30; rr += 3) for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2, x = d.x + Math.sin(a) * rr, z = d.z + Math.cos(a) * rr, h = W.groundHeight(x, z, d.y + 3);
      const gx = (W.groundHeight(x + e, z, h + 1) - W.groundHeight(x - e, z, h + 1)) / (2 * e), gz = (W.groundHeight(x, z + e, h + 1) - W.groundHeight(x, z - e, h + 1)) / (2 * e);
      if (Math.hypot(gx, gz) < 0.2 && fits(x, z, d.yaw)) return { x, z, y: h, yaw: d.yaw };
    }
    return null;
  }

  // ------------------------------------------------------------------ crashes
  // a dent where it hit (n: from what you hit toward the car, world): into the car's frame (cardamage.js)
  dent(nx, nz, hard) {
    const d = this.d, c = Math.cos(d.yaw), s = Math.sin(d.yaw);
    const ix = -nx, iz = -nz; // (the impact's direction from the car's middle)
    addDent(d.e, ix * c - iz * s, ix * s + iz * c, hard, d.t.size);
    applyDents(d.inst, d.e);
  }
  // a knock (30 km/h up to a crash): a few % of damage, a small dent, a jolt; once per hit (not every frame of it)
  knock(v, nx, nz) {
    const d = this.d;
    if (!d || d.crash || performance.now() - (this.knockT || 0) < 600) return;
    this.knockT = performance.now();
    const e = d.e, add = 1 + (v - KNOCK_V) * 0.35; // (the user: "make cars not break so easily": half the old damage)
    // the knock that takes it to 100 %: wrecked (before, knocks stopped at 99 % and the car never broke down)
    if ((e.damage || 0) + add >= 100 && this.canCrash()) { e.damage = 100; this.crash(CRASH_V, nx, nz, 'car'); return; }
    e.damage = Math.min(99, (e.damage || 0) + add);
    this.dent(nx, nz, Math.min(0.45, (v - KNOCK_V) / 22));
    this.shake = Math.max(this.shake, 0.35);
    this.hud?.flash(`Knock · car damage ${Math.round(e.damage)}%`, 'bad', 1500);
  }
  // what your car hit (kind: 'traffic' | 'parked' | 'person' | 'player-car', v: the closing speed, m/s) for whoever
  // listens (police.js: onHit)
  hitReport(kind, v) { try { this.onHit?.(kind, v); } catch (err) { console.warn('drive: onHit', err); } }
  canCrash() { return !!this.d && !this.d.crash && (this.freeRide ? !!this.freeRide() : true); }
  // a hard stop, a big jolt, the crash sound, steam from the bonnet; fast (or on a steep slope) it may roll over or
  // spin into the snow; then you're out beside the wreck (wreckOut) and it counts as a wipeout (main.js strikes)
  crash(v, nx, nz, kind = 'building') {
    const d = this.d;
    if (!d || d.crash) return;
    const hard = clamp((v - CRASH_V) / 14, 0, 1);
    // damage: a big crash ~7-15 %, an extreme one (150 km/h+) wrecks it at once; until then you drive on
    const e0 = d.e;
    e0.damage = Math.min(100, (e0.damage || 0) + (v >= EXTREME_V ? 100 : 7 + (v - CRASH_V) * 0.55));
    this.knockT = performance.now();
    try { this.dent(nx, nz, Math.min(1, 0.45 + hard * 0.55 + (e0.damage >= 100 ? 0.2 : 0))); } catch (err) { console.warn('drive: dent', err); }
    if (e0.damage < 100) {
      d.vx = d.vx * 0.22 + nx * v * 0.12; d.vz = d.vz * 0.22 + nz * v * 0.12;
      const side = Math.random() < 0.5 ? -1 : 1;
      d.yawRate = clamp(d.yawRate + side * (0.3 + hard * 0.8), -2, 2);
      d.pitchV -= 1.2 * (0.5 + hard); d.rollV += side * 0.6 * (0.4 + hard);
      this.shake = 0.75;
      try { this.audio?.impact ? this.audio.impact(kind, 0.6 + 0.4 * hard) : this.audio?.carCrash?.(0.5); } catch { /* (silent) */ }
      this.hud?.flash(`Crash · car damage ${Math.round(e0.damage)}%`, 'bad', 2200);
      return;
    }
    const e = 1.5, W = this.world;
    const gx = (W.groundHeight(d.x + e, d.z, d.y + 1) - W.groundHeight(d.x - e, d.z, d.y + 1)) / (2 * e);
    const gz = (W.groundHeight(d.x, d.z + e, d.y + 1) - W.groundHeight(d.x, d.z - e, d.y + 1)) / (2 * e);
    const steep = Math.hypot(gx, gz) > 0.42;
    const rolls = (v > 70 / 3.6 || steep) && Math.random() < 0.75;
    const side = Math.random() < 0.5 ? -1 : 1;
    d.crash = { t: 0, v, roll: 0, rollTo: rolls ? side * (Math.random() < 0.55 ? Math.PI / 2 : Math.PI) : 0, rate: 3.2 + Math.random() * 1.6 };
    const keep = rolls ? 0.35 : 0.1;
    d.vx = d.vx * keep + nx * v * 0.12; d.vz = d.vz * keep + nz * v * 0.12;
    d.yawRate = clamp(d.yawRate + side * (0.6 + hard * 1.8), -3.2, 3.2);
    d.pitchV -= 1.6 * (0.5 + hard); d.rollV += side * 0.8 * (0.4 + hard);
    d.horn = false; d.squeal = 0; d.load = 0;
    this.shake = 1;
    try { if (kind !== 'car') this.audio?.impact?.(kind, 1); this.audio?.carCrash?.(0.55 + 0.45 * hard); } catch { /* (silent) */ }
    this.hud?.flash('Crashed · the car is wrecked', 'bad', 2200);
  }
  crashStep(dt) {
    const d = this.d, c = d.crash, sp = Math.hypot(d.vx, d.vz), dec = 0.9 * G * dt;
    if (sp > dec) { d.vx -= (d.vx / sp) * dec; d.vz -= (d.vz / sp) * dec; } else { d.vx = 0; d.vz = 0; }
    d.yawRate *= Math.exp(-dt * 1.6);
    d.yaw = wrapPi(d.yaw + d.yawRate * dt);
    d.x += d.vx * dt; d.z += d.vz * dt;
    d.y = this.world.groundHeight(d.x, d.z, d.y + 1); d.air = false; d.vy = 0;
    d.rpm += (0 - d.rpm) * (1 - Math.exp(-dt * 3)); d.la = 0; d.steer *= Math.exp(-dt * 3);
    if (c.rollTo) { const diff = c.rollTo - c.roll; c.roll += Math.sign(diff) * Math.min(Math.abs(diff), c.rate * dt); }
    this.collide();
  }
  // out beside the wreck (the side that's up); the car stays as it lies until it's towed (out of your sight)
  wreckOut() {
    const d = this.d, p = this.player;
    if (!d) return;
    const e = d.e, g = e.car, yaw = d.yaw;
    const pos = g.position.clone(), quat = g.quaternion.clone();
    const sg = d.crash.rollTo > 0.1 ? -1 : 1; // (on its left side: out to the right)
    const sx = Math.cos(yaw) * sg, sz = -Math.sin(yaw) * sg;
    const x = d.x + sx * (d.w / 2 + 1.4), z = d.z + sz * (d.w / 2 + 1.4);
    this.park();
    g.position.copy(pos); g.quaternion.copy(quat); g.updateMatrixWorld(true);
    e.wrecked = { t: 0, unseen: 0 };
    if (!this.wrecks.includes(e)) this.wrecks.push(e);
    p.seat = null;
    p.standUp(x, z, yaw + (Math.PI / 2) * sg);
    p.rig.snapPose?.();
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    p.rig.root.visible = true; p.rig.gear.visible = true;
    p.rig.setSkisVisible(p.hasSkis);
    p.camYaw = yaw + (Math.PI / 2) * sg + Math.PI;
    p.events.push('crash'); // (free ride: a strike; the second one brings the rescue helicopter)
    this.hud?.flash('Wrecked · it will be towed away', 'bad', 2800);
    try { this.onWreck?.(e); } catch (err) { console.warn('drive: onWreck', err); } // (carrental.js: the fee, the tow truck)
  }
  updateWrecks(dt) {
    const cam = this.camera, night = nightUniform?.value ?? 0;
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const e = this.wrecks[i];
      try {
        // (Oct 30 2026, the user: "why are my cars being shown in the parking lot when the tow truck is towing": a car of
        // yours left astray went back to its first bay out of sight, also while the tow truck was fetching or carrying
        // it: one in the car park and the truck on with it. The truck has it: no going home on its own; carrental.js)
        if (e.astray && !e.wrecked && this.withTruck?.(e)) e.astray = null;
        if (e.wrecked || e.astray) {
          const W = e.wrecked || e.astray, g = e.car;
          W.t += dt;
          const dx = g.position.x - cam.position.x, dz = g.position.z - cam.position.z, dist = Math.hypot(dx, dz);
          const f = cam.getWorldDirection(_w), seen = dist < 30 || (dist < 450 && (dx * f.x + dz * f.z) / (dist || 1) > 0.2);
          W.unseen = seen ? 0 : W.unseen + dt;
          // gone once it has been out of sight 3 s (never sinking into the ground in view: Oct 29, the user); never
          // while you're beside it (6 m)
          const pp = this.player.pos, nearYou = Math.hypot(g.position.x - pp.x, g.position.z - pp.z) < 6;
          if (!W.tow && !nearYou && W.unseen > 3) { this.tow(e); continue; } // (W.tow: the tow truck fetches it)
          if (e.astray) continue;
          if (e.smokeFx) { const b = _v.set(0, e.t.size.y * 0.78, e.t.size.z / 2 - 0.8); g.localToWorld(b); e.smokeFx.update(dt, W.t < 60 ? b : null, cam, night, _w.set(0, 0, 1).applyQuaternion(g.quaternion)); }
          if (e.inst) lampsOn(e.inst, night > 0.2 ? 1 : 0, 0.55, 0, { hazard: hazardPhase() }); // (the wreck: hazards, dim tails, headlights on at night)
        }
        if (!e.wrecked && !e.astray) { e.smokeFx?.clear(); this.wrecks.splice(i, 1); }
      } catch { e.wrecked = null; this.wrecks.splice(i, 1); }
    }
  }
  /** Repaired (the Werkstatt, werkstatt.js): no damage, no dents, every look of it as new (parked and driven). */
  repair(e) {
    if (!e) return;
    e.damage = 0;
    e.dents = [];
    for (const inst of new Set([e.inst, this.d?.e === e ? this.d.inst : null])) if (inst) { try { repairInstance(inst); } catch (err) { console.warn('drive: repair', err); } }
    e.smokeFx?.clear();
  }
  // towed: back where it was parked, as good as new
  tow(e) {
    const h = e.home, g = e.car;
    if (h) { g.position.set(h.x, (this.world.meshHeight || this.world.height).call(this.world, h.x, h.z) + 0.03, h.z); g.rotation.set(0, h.yaw, 0); }
    else g.rotation.set(0, g.rotation.y, 0);
    g.updateMatrixWorld(true);
    e.collider.x = g.position.x; e.collider.z = g.position.z; e.collider.rot = -g.rotation.y;
    e.wrecked = null; e.astray = null; e.damage = 0;
    if (e.dents?.length) { e.dents = []; repairInstance(e.inst); } // (repaired)
    e.smokeFx?.clear();
    if (e.inst) lampsOn(e.inst, 0, 0, 0); // (towed: parked, lights off)
  }

  // you in the driver's seat: your own character (your outfit), fixed to the car (its pitch, roll, bounce: the same
  // frame), leant back into the backrest, both hands on the wheel at ten to two turning with it, feet to the pedals.
  // Inside, the camera is at your eyes (d.eyeRig) with your head folded away, so looking down shows your own chest,
  // arms, hands on the wheel and legs; the chase camera shows the same body.
  placeRig() {
    const d = this.d, rig = this.player.rig, g = d.e.car, b = rig?.b;
    if (!rig?.root || !b?.hips) return;
    const r = rig.root;
    r.position.copy(this.seat.pos); r.quaternion.copy(g.quaternion); r.updateMatrixWorld(true);
    const inside = this.view === 'cockpit';
    try {
      // your own arms (first person folds them away for the ski view model) and, inside, no head before the eye (also
      // on the frame you switch, before player.js hides it)
      for (const a of [b.lArm, b.rArm]) if (a && a.scale.x !== 1) a.scale.setScalar(1);
      if (b.head) b.head.scale.setScalar(inside ? 0.001 : 1);
      r.updateMatrixWorld(true);
      // leant back toward this car's backrest (carpeople.js seat hints): the torso (hips to neck) turned from how the
      // rig sits to ~60 % of the backrest's lean, the neck in line with it (the sit pose pokes the head forward), the
      // head level: your eyes at a natural driver's eye point, ~0.4 m behind the wheel
      const seat = seatsFor(d.t), tv = g.worldToLocal(wpos(b.neck || b.head)).sub(g.worldToLocal(wpos(b.hips)));
      const want = 0.6 * Math.atan(seat ? -seat.d[3] : 0.4), cur = Math.atan2(-tv.z, tv.y), rec = clamp(want - cur, 0, 0.6);
      leanBack(b, new THREE.Vector3(-1, 0, 0).applyQuaternion(g.quaternion), rec, 0.25, -(rec + 0.25) * 0.85);
      const S = d.t.steering, c = S ? S.c : new THREE.Vector3().copy(d.eyeLocal).add(new THREE.Vector3(0, -0.27, 0.6));
      const tilt = S?.tilt ?? 0.38, ca = Math.cos(tilt), sa = Math.sin(tilt), rr = (S?.rimR ?? 0.185) * 0.97;
      const turn = clamp(d.steer * 3, -1.75, 1.75); // (the wheel's own angle: updateBody)
      // the wheel's frame (car space): A along the column (away from you), U up its face, +x to your left
      const A = new THREE.Vector3(0, -sa, ca), U = new THREE.Vector3(0, ca, sa);
      for (const [i, arm, fore, hand] of [[0, b.lArm, b.lFore, b.lHand], [1, b.rArm, b.rFore, b.rHand]]) {
        const side = i === 0 ? 1 : -1, phi = side * 1.05 + turn;
        // the grip on the rim (ten to two, turning with it); the wrist a hand's length short of it, toward you
        const radial = new THREE.Vector3(Math.sin(phi), 0, 0).addScaledVector(U, Math.cos(phi));
        const grip = c.clone().addScaledVector(radial, rr);
        const wrist = grip.clone().addScaledVector(A, -0.075).addScaledVector(radial, 0.035);
        g.localToWorld(wrist);
        twoBone(arm, fore, hand, wrist, new THREE.Vector3(side * 0.7, -1, -0.3).normalize().applyQuaternion(g.quaternion));
        // fingers over the rim and round it (forward and in), the palm on the rim
        const fingers = A.clone().multiplyScalar(0.8).addScaledVector(radial, -0.45).normalize().applyQuaternion(g.quaternion);
        const palm = radial.clone().multiplyScalar(-0.75).addScaledVector(A, 0.35).normalize().applyQuaternion(g.quaternion);
        if (rig.aimHand) rig.aimHand(i, fingers, palm); else if (hand && fore) setWQ(hand, wquat(fore));
      }
      const hip = g.worldToLocal(wpos(b.hips));
      for (const [i, up, leg, foot] of [[0, b.lUp, b.lLeg, b.lFoot], [1, b.rUp, b.rLeg, b.rFoot]]) {
        const side = i === 0 ? 1 : -1;
        const tgt = g.localToWorld(new THREE.Vector3(hip.x + side * 0.14, hip.y - 0.26, hip.z + 0.74));
        twoBone(up, leg, foot, tgt, new THREE.Vector3(side * 0.15, 1, 0.5).normalize().applyQuaternion(g.quaternion));
      }
      // your eyes (the camera inside), in the car's frame: ahead of and above the head joint
      d.eyeRig = g.worldToLocal(wpos(b.head).add(new THREE.Vector3(0, 0.09, 0.085).applyQuaternion(g.quaternion)));
    } catch (e) { d.eyeRig = null; if (!this.rigErr) { this.rigErr = true; console.warn('drive seat', e); } } // (the pose stays as the rig made it)
  }

  // the controls card (bottom left), like the helicopter's and the snowmobile's
  showCard(on) {
    if (!this.cardEl) {
      if (!document.getElementById('drive-hud-css')) { const st = document.createElement('style'); st.id = 'drive-hud-css'; st.textContent = CSS; document.head.appendChild(st); }
      const el = document.createElement('div');
      el.id = 'drive-hud';
      el.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      const rows = [[['W'], 'Throttle'], [['S'], 'Brake · reverse'], [['A', 'D'], 'Steer'], [['SPACE'], 'Handbrake'], [['R'], 'Camera · inside / chase'], [['C'], 'Look back'], [['H'], 'Horn'], [['L'], 'Headlights'], [['E'], 'Get out (stopped)'], [['U'], 'Unstuck (stuck, slow)']];
      el.innerHTML = `<div class="ch-card paper"><div class="ch-head">CAR</div>${rows.map(([k, t]) => `<div class="ch-row"><span class="ch-keys">${keysHTML(k)}</span><span class="ch-do">${t}</span></div>`).join('')}</div>`;
      (document.getElementById('hud') || document.body).appendChild(el);
      this.cardEl = el;
    }
    const card = this.cardEl.firstElementChild;
    clearTimeout(this.cardT);
    this.cardEl.hidden = !on;
    card.classList.remove('out');
    if (on) this.cardT = setTimeout(() => card.classList.add('out'), 12000);
  }
}
void REAL;
