// Snowmobiles you can drive: a few parked around the resort (the village, a couple of gondola bases, the huts);
// E beside one to drive it, E again (stopped) to get off wherever it is safe. Your skis ride on your back.
//   W throttle · S brake / reverse · A/D steer · SHIFT boost · SPACE handbrake · E get off (when stopped)
// Arcade but grounded: traction-limited climbing (it slows on steep climbs and slides back off faces it can't
// grip), side slopes and ice (groomed pistes) let it skid, it follows the snow with a little suspension bounce and
// small jumps over crests; it bumps softly off trees, rocks, buildings, towers and nets, and a hard hit at speed
// throws you off (a wipeout like on skis: main.js's two-strike rule, then the rescue helicopter).
//
// main.js glue: sleds = new Snowmobiles({...}); findInteraction: sleds.interaction(pos); after player.update:
// sleds.update(dt, input|null); HUD speed: sleds.active ? sleds.speed; headlamp off while sleds.active.
import * as THREE from 'three';
import { world as WORLD } from '../world/world.js';
import { fitModel } from '../core/assets.js';
import { nightUniform } from '../world/village.js';
import { knockPerson, people } from './peoplehits.js';
import { freeCourses } from '../modes/parkour/freeworld.js';
import { VILLAGE_BUILDINGS } from '../world/layout.js';
import { RAIL, railAt, railNearest } from '../world/railroute.js';
import { busRoads, laneDistance, ROAD_HALF } from './bus/roads.js';

// Off until verified in the game (the browser queue ran out before the check): with it off nothing is placed, no
// light or sound is created and every main.js hook is inert. Dev override: ?flags=sleds (or localStorage 'sl.flags').
const devFlag = (name) => { try { return `,${new URLSearchParams(location.search).get('flags') || localStorage.getItem('sl.flags') || ''},`.includes(`,${name},`); } catch { return false; } };
export const SLEDS_ON = true || devFlag('sleds');

export const SLED = {
  len: 2.9,
  vmax: 35,        // m/s on the flat (~126 km/h; buffed from 23.5)
  vboost: 40,      // with SHIFT
  vback: 4.5,
  acc: 14, brake: 13, drag: 0.0028, roll: 0.35,
  mu: 1.3, muIce: 0.62,       // traction (drive / brake force limit = mu * g * cos): climbs ~50 deg in fresh snow
  grip: 8, gripIce: 2.4,      // how fast sideways sliding dies away (1/s)
  turn: 1.7,                  // yaw rate at low speed (rad/s)
  crash: 12.5,                // m/s straight into something: thrown off
};
const G = 9.81;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _ray = new THREE.Raycaster();
const _p = new THREE.Vector3(), _dir = new THREE.Vector3();
// marks it leaves in the snow (fx/snowfx.js trails): [id, metres ahead of the centre, metres to the right, width]
const MAX_SLEDS = 15; // parked sleds round the resort, placed at random each session (each drawn only within 380 m of the camera)
const VILLAGE_SLEDS = 5; // ...of them in Legacy Village
const SLED_MARKS = [['sled-ski-l', 0.95, -0.5, 0.12], ['sled-ski-r', 0.95, 0.5, 0.12], ['sled-track', -0.9, 0, 0.42]];
export const SEAT = new THREE.Vector3(0, 0.74, -0.32);   // the rider's seat (sled frame: +z forward, y up from the snow)
const TRACK = new THREE.Vector3(0, 0.2, -1.35);   // where the track throws snow
const LAMP = new THREE.Vector3(0, 0.78, 1.1);     // headlight

export class Snowmobiles {
  /**
   * @param {object} o  { scene, models, player, camera, hud, audio, spray, layout, colliders, vegetation, cameraBlockers, world }
   */
  constructor({ scene, models, player, camera, hud, audio, spray = null, trails = null, layout, colliders, vegetation = null, world = WORLD }) {
    Object.assign(this, { scene, models, player, camera, hud, audio, spray, trails, layout, colliders, vegetation, world });
    this.ground = (x, z, y = Infinity) => world.groundHeight(x, z, y);
    this.list = [];
    this.d = null;        // the one you drive: state
    this.cam = { yaw: 0, pitch: 0.24, dist: 6.6, lastMouse: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), ready: false };
    this.seat = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1) };
    this.prompt = { label: 'Drive snowmobile', act: null };
    this.hint = '';
    this.lamp = { intensity: 0, position: new THREE.Vector3() }; // (stand-in while switched off)
    if (!SLEDS_ON) return;
    // the headlight (always in the scene, dark by day: adding lights later would recompile every material)
    this.lamp = new THREE.SpotLight(0xfff2dd, 0, 60, 0.55, 0.45, 1.4);
    this.lamp.castShadow = false;
    this.lampTarget = new THREE.Object3D();
    this.lamp.target = this.lampTarget;
    scene.add(this.lamp, this.lampTarget);
    // (placed on the first frame: the chalet village, car parks and stations are all planned by then)
    this.spawnPending = !!models.snowmobile;
  }
  spawnParked() {
    this.spawnPending = false;
    try { for (const spot of this.pickSpots()) this.add(spot.x, spot.z, spot.heading); } catch (e) { console.warn('snowmobiles: spots', e); }
  }

  get active() { return !!this.d; }
  get speed() { return this.d ? Math.hypot(this.d.vx, this.d.vz) : 0; }

  // ------------------------------------------------------------------ parked sleds
  // MAX_SLEDS at random each session (Oct 29, the user: "make snowscooters spawn randomly ... 15 snow scooters around
  // the map"): VILLAGE_SLEDS round Legacy Village, the rest drawn from the huts, the car parks, the rail and Express
  // stations, the chalet village and the lifts' bottom stations; on clear, gentle snow off the roads, runs, lift lines
  // and tracks, clear of every collider, never two within 40 m.
  pickSpots() {
    const out = [], L = this.layout, rnd = Math.random;
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const village = [{ x: 20, z: -60 }, { x: 46, z: 74 }, { x: -120, z: -20 }, { x: 140, z: 40 }];
    for (const [bx, bz] of VILLAGE_BUILDINGS) { const d = Math.hypot(bx, bz) || 1; village.push({ x: bx + (bx / d) * 16, z: bz + (bz / d) * 16 }); }
    const other = [];
    for (const h of L.huts || []) other.push({ x: h.x + 14, z: h.z + 10 });
    for (const lot of busRoads.lots || []) {
      if (lot.building || !Number.isFinite(lot.x)) continue;
      const ux = lot.ux ?? 1, uz = lot.uz ?? 0;
      other.push({ x: lot.x + ux * ((lot.hw || 10) + 7), z: lot.z + uz * ((lot.hw || 10) + 7) }); // (beside the car park)
    }
    for (const st of RAIL.stations || []) {
      if (st.underground) continue;
      const p = railAt(st.s), side = st.side || 1;
      other.push({ x: p.x - p.dz * side * 16, z: p.z + p.dx * side * 16 });
    }
    for (const st of L.express?.stations || []) { const b = st.exit || st.board; if (b) other.push({ x: b.x, z: b.z }); }
    const cv = L.chaletVillage;
    if (cv?.center) { other.push({ x: cv.center.x, z: cv.center.z }); if (cv.houses?.length) { const h = cv.houses[Math.floor(rnd() * cv.houses.length)]; other.push({ x: h.x + 10, z: h.z + 10 }); } }
    for (const l of L.lifts || []) { const [ux, uz] = l.dir || [0, 1]; other.push({ x: l.bottom.x - uz * 30 - ux * 10, z: l.bottom.z + ux * 30 - uz * 10 }); }
    const take = (list, n) => { let k = 0; for (const t of shuffle(list)) { if (k >= n || out.length >= MAX_SLEDS) break; const sp = this.clearSpot(t.x, t.z, 26, out); if (sp) { out.push({ ...sp, heading: rnd() * Math.PI * 2 }); k++; } } };
    take(village, VILLAGE_SLEDS);
    take(other, MAX_SLEDS - out.length);
    if (out.length < MAX_SLEDS) take(village, MAX_SLEDS - out.length); // (short of places: more in the village)
    return out;
  }
  clearSpot(x0, z0, R, taken = []) {
    const W = this.world;
    const ok = (x, z) => {
      const e = 2, g = Math.hypot(W.height(x + e, z) - W.height(x - e, z), W.height(x, z + e) - W.height(x, z - e)) / (2 * e);
      if (g > 0.18) return false;
      const c = W.corridorAt(x, z);
      if (c.kind && c.d < 6) return false; // off the runs, lifts, roads
      if (busRoads.roads.length && laneDistance(x, z) < ROAD_HALF + 4) return false; // (and off the bus roads)
      for (const lot of busRoads.lots || []) { const dx = x - lot.x, dz = z - lot.z; if (Math.abs(dx * (lot.ux ?? 1) + dz * (lot.uz ?? 0)) < (lot.hw || 0) + 3 && Math.abs(dx * (lot.vx ?? 0) + dz * (lot.vz ?? 1)) < (lot.hd || 0) + 3) return false; } // (not in a car park's bays)
      const rn = railNearest(x, z);
      if (rn && rn.d < 9) return false; // (off the railway)
      for (const k of this.colliders) { const r = (k.r ?? Math.hypot(k.hw, k.hd)) + 3; if (Math.abs(k.x - x) < r && Math.abs(k.z - z) < r && Math.hypot(k.x - x, k.z - z) < r) return false; }
      if (this.vegetation?.collide?.(x, z, 3)) return false;
      for (const t of taken) if (Math.hypot(t.x - x, t.z - z) < 40) return false;
      return true;
    };
    for (let r = 0; r <= R; r += 3) {
      const n = r ? Math.round(r * 1.2) : 1;
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2, x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r; if (ok(x, z)) return { x, z }; }
    }
    return null;
  }

  add(x, z, heading) {
    const g = new THREE.Group();
    g.name = 'snowmobile';
    // (the Meshy sled is modelled along x with its skis at -x: turned so they lead, toward +z)
    const m = fitModel(this.models.snowmobile, { size: SLED.len, axis: 'z', rotateY: Math.PI / 2 });
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.add(m);
    this.scene.add(g);
    const s = { g, x, z, y: this.ground(x, z), heading, collider: { x, z, r: 1.15, soft: true, h: 1.4, sled: true } };
    this.colliders.push(s.collider);
    this.list.push(s);
    this.pose(s);
    return s;
  }

  /** Admin: a snowmobile right beside you, facing the way you look. */
  spawnNear(p = this.player) {
    if (!SLEDS_ON || !this.models.snowmobile) return null;
    const h = p.heading || 0;
    const x = p.pos.x + Math.sin(h) * 3 + Math.cos(h) * 1.5, z = p.pos.z + Math.cos(h) * 3 - Math.sin(h) * 1.5;
    this.hud?.flash('Snowmobile · E to drive', 'good', 2200);
    return this.add(x, z, h);
  }

  // place a sled's model: on the snow, tilted to it (pitch / roll from the ground), with an optional bounce
  pose(s, pitch = null, roll = null, lift = 0) {
    const x = s.x, z = s.z, h = s.heading, fx = Math.sin(h), fz = Math.cos(h);
    if (pitch === null || roll === null) {
      const f = this.ground(x + fx * 1.2, z + fz * 1.2), b = this.ground(x - fx * 1.2, z - fz * 1.2);
      const l = this.ground(x + fz * 0.55, z - fx * 0.55), r = this.ground(x - fz * 0.55, z + fx * 0.55);
      pitch = Math.atan2(b - f, 2.4); roll = Math.atan2(l - r, 1.1);
      s.y = Math.max(f, b, l, r) - 0.04;
    }
    s.g.position.set(x, s.y + lift, z);
    _e.set(pitch, h, roll, 'YXZ');
    s.g.quaternion.setFromEuler(_e);
    s.g.updateMatrixWorld(true);
    if (s.collider) { s.collider.x = s === this.d?.s ? 1e9 : x; s.collider.z = s === this.d?.s ? 1e9 : z; }
  }

  // ------------------------------------------------------------------ getting on / off
  /** The E prompt beside a parked snowmobile (or null). */
  interaction(pos) {
    if (this.d) return null;
    const p = this.player;
    if (p.mode === 'fall' || p.mode === 'sit') return null;
    let best = null, bd = 3.2;
    for (const s of this.list) { const d = Math.hypot(pos.x - s.x, pos.z - s.z); if (d < bd) { bd = d; best = s; } }
    if (!best) return null;
    this.prompt.act = () => this.mount(best);
    return this.prompt;
  }

  mount(s) {
    const p = this.player;
    if (this.d || p.mode === 'fall' || p.mode === 'sit') return;
    p.setSkisOn(false); // (skis on your back while you drive)
    p.viewBeforeRide = p.view; p.view = 'third';
    this.d = {
      s, x: s.x, z: s.z, y: s.y, vx: 0, vy: 0, vz: 0, heading: s.heading, yawRate: 0, air: false, airT: 0,
      pitch: 0, roll: 0, pitchV: 0, rollV: 0, susp: 0, suspV: 0, rpm: 0, steer: 0, offT: 0.5, bumpT: 0, sprayT: 0,
    };
    s.collider.x = 1e9; s.collider.z = 1e9;
    this.updateSeat();
    p.sitOn(this.seat);
    p.pos.copy(this.seat.pos);
    const c = this.cam;
    c.yaw = s.heading + Math.PI; c.pitch = 0.24; c.ready = false; c.lastMouse = 0;
    this.audio?.play('board');
    this.hud?.flash('W throttle · S brake · A/D steer · SHIFT boost · E get off when stopped', 'good', 4800);
  }

  // off at a standstill: beside the seat (left, else right, else behind) on clear snow; the sled stays parked
  dismount(force = false) {
    const d = this.d, p = this.player;
    if (!d) return false;
    if (!force && (this.speed > 2.5 || d.air)) { this.hud?.flash('Slow down to get off', 'bad', 1600); return false; }
    const h = d.heading, fx = Math.sin(h), fz = Math.cos(h);
    const spots = [[fz * 1.6, -fx * 1.6], [-fz * 1.6, fx * 1.6], [-fx * 2.6, -fz * 2.6], [fx * 2.6, fz * 2.6]];
    let at = null;
    for (const [ox, oz] of spots) { const x = d.x + ox, z = d.z + oz; if (!this.blocked(x, z, 0.5)) { at = { x, z }; break; } }
    if (!at) at = { x: d.x + spots[0][0], z: d.z + spots[0][1] };
    this.park();
    p.seat = null;
    p.standUp(at.x, at.z, h);
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    p.rig.root.visible = true;
    p.rig.setSkisVisible(p.hasSkis);
    p.camYaw = h + Math.PI;
    return true;
  }

  // the sled you drove stays where it stopped
  park() {
    const d = this.d;
    if (!d) return;
    const s = d.s;
    s.x = d.x; s.z = d.z; s.heading = d.heading;
    this.d = null;
    this.pose(s);
    this.lamp.intensity = 0;
    this.audio?.setSled?.({ on: false });
  }

  /** End a drive at once (main.js: teleports, menus): the sled parks where it is. */
  abort() {
    if (!this.d) return;
    const p = this.player;
    this.park();
    if (p.seat === this.seat) p.seat = null;
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    p.rig.setSkisVisible(p.hasSkis);
  }

  // thrown off in a hard crash: you tumble on in the snow (a wipeout), the sled slides to a stop
  throwOff(side) {
    const d = this.d, p = this.player;
    const vx = d.vx, vz = d.vz, h = d.heading;
    const x = d.x + Math.cos(h) * side * 0.8, z = d.z - Math.sin(h) * side * 0.8;
    this.park();
    p.seat = null;
    p.standUp(x, z, h);
    if (p.viewBeforeRide) { p.view = p.viewBeforeRide; p.viewBeforeRide = null; }
    p.rig.setSkisVisible(p.hasSkis);
    p.vel.set(vx * 0.7, 0, vz * 0.7);
    p.crash?.(side, { kind: 'tumble' });
  }

  // something solid at (x, z) within r? (trees, rocks, colliders: for getting off)
  blocked(x, z, r) {
    if (this.vegetation?.collide?.(x, z, r)) return true;
    for (const c of this.colliders) {
      if (c.sled) continue;
      const size = c.r ?? Math.max(c.hw, c.hd);
      if (Math.abs(c.x - x) > size + r + 1 || Math.abs(c.z - z) > size + r + 1) continue;
      if (c.r !== undefined) { if (Math.hypot(c.x - x, c.z - z) < c.r + r) return true; }
      else {
        const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
        if (Math.abs(lx) < c.hw + r && Math.abs(lz) < c.hd + r) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ per frame
  /** @param {object|null} input  the Input while you may drive (null in menus) */
  update(dt, input) {
    if (this.spawnPending && dt > 0) this.spawnParked();
    const d = this.d;
    // parked sleds far from the camera are not drawn (~40k triangles each)
    this.cullT = (this.cullT || 0) - dt;
    if (this.cullT <= 0) {
      this.cullT = 0.5;
      const c = this.camera.position;
      for (const s of this.list) s.g.visible = s === d?.s || Math.hypot(s.x - c.x, s.z - c.z) < 380;
    }
    if (!d) { this.lamp.intensity = 0; this.marks(null); return; }
    if (dt <= 0) { this.audio?.setSled?.({ on: true, paused: true }); this.holdCamera(); return; } // (paused: the camera stays put)
    d.offT = Math.max(0, d.offT - dt);
    const key = (a, b) => !!input && (input.down(a) || (b && input.down(b)));
    const throttle = (key('KeyW', 'ArrowUp') ? 1 : 0) - (key('KeyS', 'ArrowDown') ? 1 : 0);
    const steerIn = (key('KeyA', 'ArrowLeft') ? 1 : 0) - (key('KeyD', 'ArrowRight') ? 1 : 0);
    const boost = key('ShiftLeft', 'ShiftRight'), handbrake = key('Space');
    d.steer += (steerIn - d.steer) * (1 - Math.exp(-dt * 7));
    if (input?.hit?.('KeyE') && d.offT <= 0) { if (this.dismount()) return; }
    const n = Math.max(1, Math.ceil(dt / (1 / 90)));
    for (let i = 0; i < n && this.d; i++) this.step(dt / n, throttle, boost, handbrake);
    if (!this.d) return; // (thrown off)
    this.place(dt);
    this.poseT = performance.now(); // (net/sled.js: the presence row is taken next frame, before this update)
    this.updateSeat();
    const p = this.player;
    p.pos.copy(this.seat.pos);
    p.rig.root.position.copy(this.seat.pos);
    p.rig.root.quaternion.copy(d.s.g.quaternion);
    p.rig.root.updateMatrixWorld(true);
    this.placeCamera(dt, input);
    this.holdCamera(true);
    this.effects(dt, throttle, boost);
  }

  // paused (dt 0): player.update still runs and would put the camera on the player's own seated camera; the sled's
  // last camera is kept instead (as drive.js holdCamera)
  holdCamera(save = false) {
    const cam = this.camera, H = this.camHold ||= { pos: new THREE.Vector3(), q: new THREE.Quaternion(), fov: 60, near: 0.1, d: null };
    if (save) { H.pos.copy(cam.position); H.q.copy(cam.quaternion); H.fov = cam.fov; H.near = cam.near; H.d = this.d; return; }
    if (H.d !== this.d) return;
    cam.position.copy(H.pos); cam.quaternion.copy(H.q); cam.fov = H.fov; cam.near = H.near;
    cam.updateProjectionMatrix();
  }

  step(dt, throttle, boost, handbrake) {
    const d = this.d, S = SLED, W = this.world;
    const fx = Math.sin(d.heading), fz = Math.cos(d.heading);
    // the snow here: slope (gradient), and whether it is hard-packed (groomed pistes: icy, less grip)
    const e = 1.2, h0 = this.ground(d.x, d.z, d.y + 1);
    const gx = (this.ground(d.x + e, d.z, d.y + 1) - this.ground(d.x - e, d.z, d.y + 1)) / (2 * e);
    const gz = (this.ground(d.x, d.z + e, d.y + 1) - this.ground(d.x, d.z - e, d.y + 1)) / (2 * e);
    const grad = Math.hypot(gx, gz), cosT = 1 / Math.sqrt(1 + grad * grad);
    const corr = W.corridorAt(d.x, d.z, this._corr || (this._corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }));
    const ice = corr.groomed && corr.d < 0 && corr.kind !== 'lift' ? 1 : 0;
    const mu = ice ? S.muIce : S.mu;
    let u = d.vx * fx + d.vz * fz;          // forward speed
    let w = d.vx * fz - d.vz * fx;          // sideways (+ = to the left)
    if (!d.air) {
      // drive / brake, limited by traction (less on a steep climb: the track spins and you slow down)
      const trac = mu * G * cosT;
      const vtop = boost ? S.vboost : S.vmax;
      let F = 0;
      if (throttle > 0) F = Math.min(trac, S.acc * throttle * Math.max(0, 1 - Math.max(0, u) / vtop) + (u < 0 ? S.brake : 0));
      else if (throttle < 0) F = u > 0.4 ? -Math.min(trac * 1.2, S.brake) : (u > -S.vback ? -Math.min(trac, 3.2) : 0);
      if (handbrake) F = -Math.sign(u) * Math.min(Math.abs(u) / dt, trac * 0.9);
      // gravity along the heading and across it
      const along = gx * fx + gz * fz, across = gx * fz - gz * fx;
      const gAlong = -G * along * cosT, gAcross = -G * across * cosT;
      // too steep to grip (a face it can't climb): the track loses hold and it slides back down
      const hold = 1 - smooth(1.3, 1.8, grad); // (from ~52 deg the track starts to lose its hold, ~61 deg it slides)
      F *= hold;
      const resist = Math.sign(u) * Math.min(Math.abs(u) / dt, S.roll + S.drag * u * u);
      u += (F + gAlong - resist) * dt;
      w += gAcross * dt;
      // grip: sideways sliding dies away (less on ice, at speed, and with the handbrake: a skid)
      const grip = (ice ? S.gripIce : S.grip) * (handbrake ? 0.25 : 1) * (0.6 + 0.4 * hold) / (1 + Math.abs(u) * 0.025);
      w *= Math.exp(-grip * dt);
      // steering: a quick turn at low speed, wide at full speed; reversing turns the other way
      const turnRate = S.turn * smooth(0, 3, Math.abs(u)) / (1 + Math.abs(u) * 0.045) * (handbrake ? 1.6 : 1);
      d.yawRate += (d.steer * turnRate * Math.sign(u || 1) - d.yawRate) * (1 - Math.exp(-dt * 9));
    } else {
      d.yawRate *= Math.exp(-dt * 2);
    }
    d.heading = wrapPi(d.heading + d.yawRate * dt);
    const nfx = Math.sin(d.heading), nfz = Math.cos(d.heading);
    // when airborne the velocity stays as it was; on the snow it is rebuilt from forward + sideways
    if (!d.air) { d.vx = nfx * u + nfz * w; d.vz = nfz * u - nfx * w; }
    d.x += d.vx * dt; d.z += d.vz * dt;
    // vertical: on the snow it follows the ground, unless the ground falls away faster than gravity can pull it
    // down (a crest at speed: a small jump); in the air gravity, then a landing the suspension soaks up
    const prevY = d.y, g1 = this.ground(d.x, d.z, prevY + 1);
    if (!d.air) {
      // (a step in the ground is settled onto, never turned into upward speed: no launches)
      const step = g1 - h0, vyG = clamp(Math.abs(step) > 0.3 ? d.vy * 0.5 : step / dt, -9, 6);
      if (vyG < d.vy - G * dt - 1.2 && Math.hypot(d.vx, d.vz) > 6 && step > -1.5) { d.air = true; d.airT = 0; d.vy = clamp(d.vy, -9, 6) - G * dt; d.y = prevY + d.vy * dt; }
      else { d.y = g1; d.suspV += clamp(vyG - d.vy, -3, 3) * 0.08; d.vy += (vyG - d.vy) * 0.5; }
    } else {
      d.vy = Math.min(d.vy, 7) - G * dt; d.y += d.vy * dt; d.airT += dt;
      if (d.y <= g1) {
        const impact = -d.vy;
        if (impact > 3) { d.suspV -= impact * 0.9; this.audio?.play('land', Math.min(1, impact / 12)); }
        d.y = g1; d.vy = 0; d.air = false; d.airT = 0;
      }
    }
    // suspension: a spring the bumps excite
    d.suspV += (-d.susp * 60 - d.suspV * 9) * dt;
    d.susp += d.suspV * dt;
    d.susp = clamp(d.susp, -0.3, 0.2);
    this.collide(dt);
  }

  // soft bumps off trees, rocks, buildings, towers, nets and parked sleds; a hard hit at speed throws you off
  collide(dt) {
    const d = this.d;
    if (!d) return;
    const fx = Math.sin(d.heading), fz = Math.cos(d.heading);
    let px = 0, pz = 0, n = 0, hard = 0, soft = false, kind = 'snow';
    const hit = (nx, nz, over, isSoft, k = 'snow') => {
      px += nx * over; pz += nz * over; n++;
      const vn = d.vx * nx + d.vz * nz;
      if (vn < 0) { if (!isSoft && -vn >= hard) { hard = -vn; kind = k; } soft = soft || isSoft; }
    };
    const kindOf = (c) => (c.net ? 'net' : c.soft ? 'snow' : c.r !== undefined ? (c.r < 0.7 && !c.rock ? 'metal' : 'rock') : 'building');
    for (const k of [0.95, -0.85]) {
      const cx = d.x + fx * k, cz = d.z + fz * k, R = 0.72;
      const t = this.vegetation?.collide?.(cx, cz, R, 0.6, 'crown'); // (the whole tree: its branches too)
      if (t) {
        const dx = cx - t.x, dz = cz - t.z, l = Math.hypot(dx, dz) || 1;
        hit(dx / l, dz / l, R + (t.crown ?? t.r) - l, false, 's' in t && !('trunk' in t) ? 'rock' : 'tree');
      }
      for (const c of this.colliders) {
        if (c === d.s.collider) continue;
        const size = c.r ?? Math.max(c.hw, c.hd);
        if (Math.abs(c.x - cx) > size + R + 0.5 || Math.abs(c.z - cz) > size + R + 0.5) continue;
        if (c.h !== undefined && c.h < 0.4) continue;
        if (c.r !== undefined) {
          const dx = cx - c.x, dz = cz - c.z, l = Math.hypot(dx, dz);
          if (l < c.r + R) hit(l > 1e-3 ? dx / l : 1, l > 1e-3 ? dz / l : 0, c.r + R - l, !!(c.net || c.soft), kindOf(c));
        } else {
          const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), lx = (cx - c.x) * cs - (cz - c.z) * sn, lz = (cx - c.x) * sn + (cz - c.z) * cs;
          const ox = c.hw + R - Math.abs(lx), oz = c.hd + R - Math.abs(lz);
          if (ox > 0 && oz > 0) {
            let nlx = 0, nlz = 0;
            if (ox < oz) nlx = Math.sign(lx) || 1; else nlz = Math.sign(lz) || 1;
            const c2 = Math.cos(c.rot), s2 = Math.sin(c.rot);
            hit(nlx * c2 - nlz * s2, nlx * s2 + nlz * c2, Math.min(ox, oz), !!(c.net || c.soft), kindOf(c));
          }
        }
      }
    }
    // people (skiers, villagers): the sled just bumps off them; in free ride a hit knocks them over and costs a
    // fine (game/peoplehits.js; races keep the plain bump)
    try {
      const folk = people();
      for (let i = 0; i < folk.length; i++) {
        const c = folk[i];
        if (Math.abs(c.x - d.x) > 3 || Math.abs(c.z - d.z) > 3 || Math.abs(c.y - d.y) > 2.5) continue;
        for (const k of [0.95, -0.85]) {
          const cx = d.x + fx * k, cz = d.z + fz * k, dx = cx - c.x, dz = cz - c.z, l = Math.hypot(dx, dz), rr = 0.72 + 0.4;
          if (l >= rr || l < 1e-3) continue;
          const nx = dx / l, nz = dz / l, closing = -(d.vx * nx + d.vz * nz);
          const sp = Math.hypot(d.vx, d.vz);
          if (closing > 0.5) knockPerson(c, closing, 'snowmobile', sp > 1 ? d.vx / sp : -nx, sp > 1 ? d.vz / sp : -nz);
          hit(nx, nz, rr - l, true);
          break;
        }
      }
    } catch (e) { console.warn('sled people', e); }
    if (!n) return;
    const l = Math.hypot(px, pz) || 1, nx = px / l, nz = pz / l;
    d.x += px; d.z += pz;
    const vn = d.vx * nx + d.vz * nz;
    if (hard > SLED.crash && !soft && this.player.crash) { try { this.audio?.impact?.(kind, Math.min(1, hard / 16)); } catch { /* (silent) */ } this.throwOff(Math.sign(d.vx * Math.cos(d.heading) - d.vz * Math.sin(d.heading)) || 1); return; }
    if (vn < 0) {
      d.vx -= nx * vn * 1.3; d.vz -= nz * vn * 1.3; // a soft bounce back
      const loss = Math.max(0.5, 1 - (-vn) * 0.04);
      d.vx *= loss; d.vz *= loss;
      d.suspV -= Math.min(2, -vn * 0.15);
      if (-vn > 2.5 && d.bumpT <= 0) { if (this.audio?.impact) this.audio.impact(soft && !hard ? 'snow' : kind, Math.min(0.8, -vn / 14)); else this.audio?.play('land', Math.min(1, -vn / 10)); d.bumpT = 0.4; }
    }
  }

  // the model on the snow: pitch and roll follow the ground (springs), in the air the nose follows the flight
  place(dt) {
    const d = this.d, s = d.s, h = d.heading, fx = Math.sin(h), fz = Math.cos(h);
    d.bumpT = Math.max(0, d.bumpT - dt);
    let pt, rt;
    if (!d.air) {
      const f = this.ground(d.x + fx * 1.2, d.z + fz * 1.2, d.y + 1), b = this.ground(d.x - fx * 1.2, d.z - fz * 1.2, d.y + 1);
      const l = this.ground(d.x + fz * 0.55, d.z - fx * 0.55, d.y + 1), r = this.ground(d.x - fz * 0.55, d.z + fx * 0.55, d.y + 1);
      pt = Math.atan2(b - f, 2.4); rt = Math.atan2(l - r, 1.1);
      // lean into a fast turn a little
      rt += clamp(-d.yawRate * this.speed * 0.012, -0.12, 0.12);
    } else {
      const sp = Math.hypot(d.vx, d.vz);
      pt = clamp(-Math.atan2(d.vy, Math.max(4, sp)) * 0.6, -0.35, 0.35); rt = d.roll * 0.98;
    }
    const k = 1 - Math.exp(-dt * (d.air ? 3 : 12));
    d.pitch += (pt - d.pitch) * k; d.roll += (rt - d.roll) * k;
    s.x = d.x; s.z = d.z; s.y = d.y; s.heading = h;
    this.pose(s, d.pitch, d.roll, d.susp * 0.6);
  }

  updateSeat() {
    const s = this.d?.s;
    if (!s) return;
    s.g.updateMatrixWorld(true);
    this.seat.pos.copy(SEAT);
    s.g.localToWorld(this.seat.pos);
    this.seat.fwd.set(Math.sin(this.d.heading), 0, Math.cos(this.d.heading));
  }

  // chase camera: behind and a little above, the mouse looks around (it swings back behind after a moment);
  // never under the snow, nor inside a building
  placeCamera(dt, input) {
    const d = this.d, C = this.cam, cam = this.camera, now = performance.now();
    if (input) {
      const sens = 0.0022 * (this.player.sensitivity || 1);
      if (input.mdx || input.mdy) C.lastMouse = now;
      C.yaw -= (input.mdx || 0) * sens;
      C.pitch = clamp(C.pitch + (input.mdy || 0) * sens, -0.1, 1.0);
      if (input.wheel) C.dist = clamp(C.dist + input.wheel * 0.8, 4, 14);
    }
    const sp = this.speed;
    if (now - C.lastMouse > 1400) {
      const travel = sp > 2 ? Math.atan2(d.vx, d.vz) : d.heading;
      C.yaw += wrapPi(travel + Math.PI - C.yaw) * (1 - Math.exp(-dt * 2.6));
      C.pitch += (0.24 - C.pitch) * (1 - Math.exp(-dt * 1.5));
    }
    const focus = _v.set(d.x, d.y + 1.25, d.z);
    const dist = C.dist + sp * 0.06, cp = Math.cos(C.pitch);
    const want = _w.set(focus.x + Math.sin(C.yaw) * cp * dist, focus.y + Math.sin(C.pitch) * dist, focus.z + Math.cos(C.yaw) * cp * dist);
    const gy = this.ground(want.x, want.z) + 0.9;
    if (want.y < gy) want.y = gy;
    // walls between the sled and the camera: come in front of them
    const blockers = this.player.cameraBlockers;
    if (blockers?.length) {
      const dir = want.clone().sub(focus), len = dir.length();
      _ray.set(focus, dir.divideScalar(len)); _ray.far = len;
      const hitB = _ray.intersectObjects(blockers, true)[0];
      if (hitB) want.copy(focus).addScaledVector(_ray.ray.direction, Math.max(1.2, hitB.distance - 0.4));
    }
    if (!C.ready) { C.pos.copy(want); C.look.copy(focus); C.ready = true; }
    C.pos.lerp(want, 1 - Math.exp(-dt * 8));
    C.look.lerp(focus, 1 - Math.exp(-dt * 14));
    cam.position.copy(C.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(C.look);
    cam.near = 0.1;
    cam.fov += (64 + sp * 0.25 - cam.fov) * (1 - Math.exp(-dt * 3));
    cam.updateProjectionMatrix();
  }

  // engine sound, snow thrown by the track, the headlight at night
  effects(dt, throttle, boost) {
    const d = this.d, s = d.s, sp = this.speed;
    const load = clamp(Math.abs(throttle) * (d.air ? 0.4 : 1) + (boost ? 0.3 : 0), 0, 1);
    const target = clamp(0.18 + sp / SLED.vboost * 0.65 + load * 0.25 + (d.air && throttle > 0 ? 0.25 : 0), 0, 1.1);
    d.rpm += (target - d.rpm) * (1 - Math.exp(-dt * (target > d.rpm ? 5 : 2.5)));
    this.audio?.setSled?.({ on: true, rpm: d.rpm, load, speed: sp });
    // snow spray from the track
    if (this.spray && !d.air && (sp > 2 || (throttle && sp < 6))) {
      d.sprayT += dt * (6 + sp * 1.4 + load * 10);
      while (d.sprayT > 1) {
        d.sprayT -= 1;
        s.g.localToWorld(_v.copy(TRACK).add(_w.set((Math.random() - 0.5) * 0.7, 0, 0)));
        const back = -(4 + sp * 0.35 + load * 3);
        const vx = Math.sin(d.heading) * (back * 0.6) + d.vx * 0.4 + (Math.random() - 0.5) * 2.5;
        const vz = Math.cos(d.heading) * (back * 0.6) + d.vz * 0.4 + (Math.random() - 0.5) * 2.5;
        this.spray.emit(_v, _w.set(vx, 1.5 + Math.random() * 2.5 + load * 1.5, vz), 1, 1, 0.16 + Math.random() * 0.2, 0.5 + Math.random() * 0.5);
      }
    }
    this.marks(d);
    // headlight: on at dusk and night
    const night = nightUniform?.value ?? 0;
    this.lamp.intensity = night > 0.15 ? 60 * Math.min(1, night * 1.5) : 0;
    if (this.lamp.intensity > 0) {
      s.g.localToWorld(this.lamp.position.copy(LAMP));
      s.g.localToWorld(this.lampTarget.position.set(0, -0.6, 14));
      this.lampTarget.updateMatrixWorld();
    }
  }

  // two ski grooves up front and the wide track behind, pressed into the snow while it runs on it
  marks(d) {
    if (!this.trails) return;
    try {
      const on = !!d && !d.air && this.speed > 0.6;
      if (!on && !this.marking) return;
      this.marking = on;
      const h = d?.heading || 0, fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
      const slip = d ? clamp(Math.abs(d.vx * rx + d.vz * rz) / Math.max(2, this.speed), 0, 1) : 0;
      _dir.set(fx, 0, fz);
      for (const [id, a, b, w] of SLED_MARKS) {
        if (on) _p.set(d.x + fx * a + rx * b, d.y, d.z + fz * a + rz * b);
        this.trails.emit(id, on ? _p : null, _dir, w, on, slip);
      }
    } catch (e) { this.trails = null; console.warn('sled marks: ' + e); } // never let the marks break the ride
  }

  /** Objective line while you drive. */
  hudLine() {
    return this.d ? 'W throttle · S brake · A/D steer · SHIFT boost · SPACE handbrake · E get off' : '';
  }
}
