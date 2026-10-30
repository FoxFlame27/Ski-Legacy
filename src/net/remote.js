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
import { R, ST, F, fallDecode } from './protocol.js';
import { twoBone, seatsFor } from '../game/carpeople.js';
import { seatAt } from '../game/seating.js';
import { world } from '../world/world.js';
import { bedArms, INTERIOR_ID as HOSPITAL } from '../game/hospitalroom.js';

const RING = 16;              // snapshots kept per player
const DELAY = 120;            // ms of interpolation buffer (at least; more when rows arrive later: Remote.delay)
const MAX_DELAY = 400;
const EXTRAPOLATE = 250;      // ms at most past the newest snapshot
const TAG_FAR = 150;          // m: name tags hidden beyond
const ANIM_NEAR = 60;         // m: full-rate animation within, lower rate beyond
const HIDE_FAR = 2500;        // m: avatars beyond are not drawn at all
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _fa = {}, _fb = {};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

// A floating name card in the HUD's style (Oct 30, the user: "make the name tag above look a bit better"): a slanted
// white card with a soft shadow and a coloured stripe on the left, the name in the HUD's bold italic, shrunk to fit.
// o.dark: a dark card with white text (the pause badge); o.pause: two pause bars drawn before the text.
export function makeTag(name, color = '#1f5fd1', o = {}) {
  const W = 1024, H = 192, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (px) => `italic 700 ${px}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  let px = 104;
  g.font = font(px);
  const icon = o.pause ? 60 : 0, pad = 56, maxText = W - 60 - 2 * pad - icon;
  while (px > 48 && g.measureText(name).width > maxText) g.font = font(px -= 4);
  const tw = g.measureText(name).width, w = Math.min(W - 60, tw + 2 * pad + icon), x0 = (W - w) / 2, y0 = 30, h = 128, sk = 14;
  const card = () => { g.beginPath(); g.moveTo(x0 + sk, y0); g.lineTo(x0 + w, y0); g.lineTo(x0 + w - sk, y0 + h); g.lineTo(x0, y0 + h); g.closePath(); };
  g.save(); g.shadowColor = 'rgba(8,20,48,0.35)'; g.shadowBlur = 18; g.shadowOffsetY = 6;
  g.fillStyle = o.dark ? 'rgba(22,30,46,0.9)' : 'rgba(255,255,255,0.95)';
  card(); g.fill(); g.restore();
  // the coloured stripe down the left edge (clipped to the card's slant)
  g.save(); card(); g.clip(); g.fillStyle = o.dark ? '#94a3b8' : color; g.fillRect(x0, y0, 20, h); g.restore();
  const cx = x0 + 20 + (w - 20) / 2, cy = y0 + h / 2 + 4;
  g.fillStyle = o.dark ? '#f1f5f9' : color;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (o.pause) {
    const ix = cx - (tw + icon) / 2, bh = 50;
    g.fillRect(ix + 6, cy - bh / 2 - 4, 13, bh); g.fillRect(ix + 28, cy - bh / 2 - 4, 13, bh);
    g.fillText(name, ix + icon + tw / 2, cy);
  } else g.fillText(name, cx, cy);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true, sizeAttenuation: false });
  const s = new THREE.Sprite(mat);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  s.userData.base = 0.05; // fraction of the screen height
  s.scale.set(s.userData.base * (512 / 96), s.userData.base, 1); // (the canvas keeps 512:96)
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
    this.vtow = info.vehs?.tow || null;   // their tow truck out on a job ({ k: 'tow', at, v, car }: net/tow.js)
    this.vpolice = info.vehs?.police || null; // the patrol cars chasing them ({ k: 'police', cars: [[x, y, z, yaw, v]] }: game/police.js)
    this.vrescue = info.vehs?.rescue || null; // the rescue helicopter / ambulance coming for them (net/rescue.js)
    this.vsled = info.vehs?.sled || null; // the snowmobile they drive / left parked ({ k: 'sled', at? }: net/sled.js)
    this.fa = 0; this.fb = 0; this.ff = 0;   // a wipeout: the flags either side of the sample and the blend (fallDecode)
    this.fallSt = { pitch: 0, roll: 0, ball: 0, getUp: 0 }; this.wasFall = false; this.wasAir = false; this.hideRig = false;
    this.ok = false; this.inLocal = false;
    this.vehStr = 0; this.vehK = ''; this.vehOwner = ''; this.vehSeat = -1; // the parsed `kind:id:seat` (vehicles.js)
    this.seatPos = new THREE.Vector3(); this.seatYaw = 0;
    this.mx = 0; this.mz = 0; this.mspd = 0; this.mHas = false; // (how fast they really move here: poseOne)
    this.inCar = false; this.carG = null; this.carT = null; this.carSeat = 0; // (the car seat they sit in: vehicles.js seatFor)
    this.animAcc = 0;
    this.st = { mode: 'idle', heading: 0, speed: 0, crouch: 0, lean: 0, edge: 0, tuck: false, plow: 0, skid: 0, normal: UP, air: false, flip: 0, grab: 0, spinVel: 0, charge: 0, lookYaw: 0, lookPitch: 0, seat: null, carry: false, airY: 0, fall: null };
    this.seat = new THREE.Vector3();
    this.fxInfo = { grounded: true, speed: 0, vel: this.vel, sideslip: 0, plow: 0, lean: 0 };
    this.lastTs = 0;
    this.lag = null;
    this.lagDev = 0; this.gap = 90; // (how much the lag jitters, ms; the spacing of their rows, ms: Remote.delay)
    this.dly = null;                 // the playout delay in use (eased toward delay: never jumps)
    this.sm = new THREE.Vector3(); this.smYaw = 0; this.smOk = false; // the drawn pose (RemotePlayers.smooth)
  }
  // The playout delay: their rows arrive ~10-12 a second (frame-quantised on their side, batched again at 15 Hz by the
  // server, now and then two in one batch: one dropped, a 170-200 ms gap), each late by the lag plus a jitter. With a
  // fixed 90 ms margin over the mean lag the drawn time ran past the newest row again and again: extrapolated, then
  // pulled back as the next row came (Oct 30, the user: "driving isn't smooth on multiplayer, especially if you're a
  // passenger"). The margin now covers their row spacing and the lag's jitter.
  get delay() { return Math.min(MAX_DELAY, Math.max(DELAY, (this.lag ?? 0) + Math.max(90, this.gap * 1.15 + this.lagDev * 2.5))); }
  /** The lead (s): all of the delay in use over the base, so a change of the delay never moves them (at a steady speed). */
  get lead() { return Math.min(0.3, Math.max(0, (this.dly ?? this.delay) - DELAY) / 1000); }
  push(row, now) {
    if (row[R.ts] <= this.lastTs) return; // (out of order / duplicate)
    if (this.lastTs) { const g = Math.min(400, row[R.ts] - this.lastTs); this.gap = g > this.gap ? this.gap * 0.7 + g * 0.3 : this.gap * 0.97 + g * 0.03; } // (rises fast, falls slowly)
    this.lastTs = row[R.ts];
    // how late rows arrive (send -> server batch -> here), smoothed: the interpolation delay follows it so there
    // is (nearly) always a newer snapshot to blend toward; ~120 ms on a good connection
    if (Number.isFinite(now)) { const lag = Math.max(0, now - row[R.ts]); if (this.lag == null) this.lag = lag; else { this.lagDev = this.lagDev * 0.92 + Math.abs(lag - this.lag) * 0.08; this.lag = this.lag * 0.92 + lag * 0.08; } }
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
    else { r.name = info.name; if (info.look) r.look = info.look; if (info.vehs) { r.vcar = info.vehs.car || null; r.vheli = info.vehs.heli || null; r.vtow = info.vehs.tow || null; r.vpolice = info.vehs.police || null; r.vrescue = info.vehs.rescue || null; r.vsled = info.vehs.sled || null; } }
    if (info.pres) r.push(info.pres, this.o.now());
    if (info.interior !== undefined) r.interior = info.interior || null;
    return r;
  }

  remove(pid) {
    const r = this.players.get(pid);
    if (!r) return;
    this.o.vehicles?.remove(pid);
    if (r.rig) this.o.applyOutfit?.(r.rig, r.look?.c || 'skier_blue', null); // (gives its baked look back: outfits.js)
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
  setVeh(pid, k, veh) { const r = this.players.get(pid); if (!r) return; if (k === 'car') r.vcar = veh || null; else if (k === 'heli') r.vheli = veh || null; else if (k === 'tow') r.vtow = veh || null; else if (k === 'police') r.vpolice = veh || null; else if (k === 'rescue') r.vrescue = veh || null; else if (k === 'sled') r.vsled = veh || null; }

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
  /** Bodies to bump into (player.js collide: the people list; Oct 30, the user: "we can go through each other while
   *  skiing, we should bump"): everyone on foot / on skis / tumbling in your interior (null: outdoors), not seated,
   *  riding or in a vehicle. Fills and returns `out` (its objects reused). */
  bodies(interior, out) {
    let n = 0;
    for (const r of this.players.values()) {
      if (!r.ok || r.veh || (r.interior || null) !== (interior || null)) continue;
      if (r.state !== ST.walk && r.state !== ST.ski && r.state !== ST.fall) continue;
      const b = out[n] || (out[n] = { x: 0, y: 0, z: 0, mp: true });
      b.x = r.pos.x; b.y = r.pos.y; b.z = r.pos.z; b.pid = r.pid; n++;
    }
    out.length = n;
    return out;
  }
  /** The trail map: everyone outdoors where they are now (inside a chalet / the Autohaus / the prison: not shown). */
  mapMarkers() {
    const out = [];
    for (const r of this.players.values()) if (r.ok && !r.interior) out.push({ x: r.pos.x, z: r.pos.z, yaw: r.yaw, label: r.name, kind: 'player' });
    return out;
  }

  detach(r) {
    if (r.rig && r.scene) { r.rig.removeFrom(r.scene); if (r.tag) r.tag.removeFromParent(); }
    r.scene = null;
  }

  ensureRig(r) {
    if (r.rig && r.rigKey) return r.rig; // (rigKey '' = the look changed: rebuild)
    const look = r.look || {};
    const key = `${look.c || 'skier_blue'}|${look.s || 'rental'}`;
    // only the outfit changed (same body, same skis): re-dressed, not rebuilt (the baked look is shared: outfits.js);
    // a rig that failed to build is not retried every frame (only on their next look)
    if (r.rigKey === '' && r.rig && r.rigBuilt === key) { this.o.applyOutfit?.(r.rig, look.c || 'skier_blue', look.o || null); r.rigKey = key; return r.rig; }
    if (!r.rig && r.rigBuilt === key && r.rigKey) return null;
    const scene = r.scene;
    if (r.rig) this.o.applyOutfit?.(r.rig, look.c || 'skier_blue', null); // (the old rig gives its baked look back)
    this.detach(r);
    r.rigBuilt = key;
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
      r.fa = a.n[11]; r.fb = b.n[11]; r.ff = f;
    } else if (t > newest.n[0]) {
      // late: carry on along the velocity for a moment (not while seated: seats move with their vehicle)
      const dt = Math.min(EXTRAPOLATE, t - newest.n[0]) / 1000;
      const seated = newest.n[8] === ST.sit || newest.n[8] === ST.ride;
      r.pos.set(newest.n[1], newest.n[2], newest.n[3]);
      if (!seated) r.pos.x += newest.n[5] * dt, r.pos.y += newest.n[6] * dt, r.pos.z += newest.n[7] * dt;
      r.yaw = newest.n[4];
      r.vel.set(newest.n[5], newest.n[6], newest.n[7]);
      // (no newer row for a while: a stalled window, a dropped connection: they stand there, not running on the spot
      // with the last row's speed; Oct 30, the user)
      if (t - newest.n[0] > EXTRAPOLATE) r.vel.set(0, 0, 0);
      r.crouch = newest.n[9]; r.lean = newest.n[10];
    } else {
      const o = r.slot(r.count - 1); // older than anything we have: the oldest
      r.pos.set(o.n[1], o.n[2], o.n[3]); r.yaw = o.n[4]; r.vel.set(o.n[5], o.n[6], o.n[7]);
      r.crouch = o.n[9]; r.lean = o.n[10];
      src = o;
    }
    r.state = src.n[8] | 0;
    r.flags = src.n[11] | 0;
    if (!(a && b)) { r.fa = r.fb = r.flags; r.ff = 0; }
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
    const ms = Math.min(100, dt * 1000);
    for (const r of this.players.values()) {
      // (the delay in use eases toward the wanted one at 5 % of real time: the drawn time never steps back or skips)
      const want = r.delay;
      r.dly = r.dly == null ? want : r.dly + clamp(want - r.dly, -ms * 0.05, ms * 0.05);
      r.ok = this.sample(r, now - r.dly);
      // a player on a slow connection is drawn further back in time (a longer buffer): led forward along their own
      // velocity by the extra, so they show where they are now, not where they were (never seated: seats ride their
      // vehicle)
      const extra = r.lead, free = !r.veh && r.state !== ST.sit && r.state !== ST.ride;
      if (r.ok && extra > 0 && free) r.pos.addScaledVector(r.vel, extra);
      if (r.ok && free) this.smooth(r, dt); else r.smOk = false;
    }
    this.o.vehicles?.update(dt, this, v); // (their cars and helicopters first: the avatars sit in them)
    for (const r of this.players.values()) if (r.ok) this.poseOne(r, dt, v, false);
  }

  // The drawn pose runs on along their velocity and is pulled onto the sampled one (a correction spreads over ~0.1 s
  // instead of a jump: a late row, extrapolation caught up, a turn the extrapolation missed). At a steady speed the
  // two agree and it adds no lag. Height follows the sample (cars send no vertical speed); a jump of 4 m (a teleport,
  // a respawn) snaps.
  smooth(r, dt) {
    if (!r.smOk || !(dt > 0) || r.sm.distanceToSquared(r.pos) > 16) { r.sm.copy(r.pos); r.smYaw = r.yaw; r.smOk = true; return; }
    const y = r.pos.y;
    r.sm.x += r.vel.x * dt; r.sm.z += r.vel.z * dt;
    const k = 1 - Math.exp(-dt * 14);
    r.sm.x += (r.pos.x - r.sm.x) * k; r.sm.z += (r.pos.z - r.sm.z) * k; r.sm.y = y;
    r.smYaw = wrapAngle(r.smYaw + wrapAngle(r.yaw - r.smYaw) * (1 - Math.exp(-dt * 25)));
    r.pos.copy(r.sm); r.yaw = r.smYaw;
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
    // carried in the rescue's ambulance (net/rescue.js): out of sight, as on their own screen
    if (r.hideRig) { if (r.rig?.root.visible) { r.rig.root.visible = false; r.rig.gear.visible = false; } return; }
    const pos = inVeh ? r.seatPos : r.pos;
    const cam = v.camera.position;
    const here = this.visible && (r.interior || null) === (v.interior || null);
    const d = here ? _a.copy(pos).sub(cam).length() : Infinity;
    if (!here || d > HIDE_FAR) { if (r.rig?.root.visible) { r.rig.root.visible = false; r.rig.gear.visible = false; } return; }
    const rig = this.ensureRig(r);
    if (!rig) return;
    const scene = (r.interior ? this.o.getScene?.(r.interior) : this.o.scene) || this.o.scene;
    if (r.scene !== scene) this.attach(r, scene);
    if (!rig.root.visible) { rig.root.visible = true; rig.gear.visible = true; rig.snapNext = true; r.mHas = false; }
    rig.root.position.copy(pos);
    // the gait's speed: the row's velocity, but never more than they really move here (smoothed): standing still
    // (paused with ESC mid-run, a stalled row) they stand idle, not running on the spot (Oct 30, the user)
    if (!late) {
      const step = r.mHas ? Math.hypot(pos.x - r.mx, pos.z - r.mz) : 0;
      r.mx = pos.x; r.mz = pos.z; r.mHas = true;
      if (dt > 0) r.mspd += (Math.min(60, step / dt) - r.mspd) * (1 - Math.exp(-dt * 6));
    }
    const st = r.st, speed = Math.min(Math.hypot(r.vel.x, r.vel.z), r.mspd * 1.25 + 0.1);
    st.airY = 0;
    const seated = inVeh || r.state === ST.sit || r.state === ST.ride || r.state === ST.drive || r.state === ST.fly;
    const fall = !seated && r.state === ST.fall;
    st.fall = null;
    if (seated) { st.mode = 'sit'; if (!inVeh) r.seatPos.copy(r.pos); st.seat = r.seatPos; }
    else if (r.state === ST.ski) { st.mode = 'ski'; st.seat = null; }
    else if (fall) { st.mode = 'fall'; st.seat = null; this.fallPose(r, st); }
    else { st.mode = speed > 0.1 ? 'walk' : 'idle'; st.seat = null; }
    st.bench = !inVeh && r.state === ST.sit ? benchFor(r, pos) : null; // (on a bench / a chair: the rig's seated pose on it, as they see it)
    st.heading = inVeh ? r.seatYaw : r.yaw;
    st.speed = seated ? 0 : speed;
    st.crouch = seated || fall ? 0 : r.crouch; st.lean = seated || fall ? 0 : r.lean; st.edge = st.lean * 0.6;
    st.air = !seated && !fall && !!(r.flags & F.air); st.tuck = !seated && !fall && !!(r.flags & F.tuck);
    st.carry = !inVeh && !fall && !!(r.flags & F.carry);
    st.normal = UP;
    const skisVisible = !inVeh && !st.bench && (r.state === ST.ski || st.carry || (fall && !!(r.flags & F.skisOn)));
    if (r.skisShown !== skisVisible) { r.skisShown = skisVisible; rig.setSkisVisible(skisVisible); }
    // walking with skis: on the back (the rig's carry pose), never on the feet
    const carry = st.carry && r.state !== ST.ski;
    if (r.carryShown !== carry) { r.carryShown = carry; rig.setCarry?.(carry); }
    // name tag: a little smaller far away, hidden past TAG_FAR
    const tagOn = d < TAG_FAR;
    if (r.tag.visible !== tagOn) r.tag.visible = tagOn;
    if (tagOn) { const k = r.tag.userData.base * Math.max(0.6, Math.min(1, 1.15 - d / 220)); r.tag.scale.set(k * (512 / 96), k, 1); }
    // in the pause menu (F.paused): a dark "In pause menu" badge over their name (Oct 30, the user)
    const paused = tagOn && !!(r.flags & F.paused);
    if (paused && !r.pauseTag) { r.pauseTag = makeTag('In pause menu', '#94a3b8', { dark: true, pause: true }); r.pauseTag.position.set(0, 2.55, 0); }
    if (r.pauseTag) {
      if (r.pauseTag.parent !== r.rig.root) r.rig.root.add(r.pauseTag);
      if (r.pauseTag.visible !== paused) r.pauseTag.visible = paused;
      if (paused) { const k = r.tag.scale.y * 0.85; r.pauseTag.scale.set(k * (512 / 96), k, 1); }
    }
    r.animAcc += dt;
    if (d < ANIM_NEAR || r.animAcc > (d < ANIM_NEAR * 3 ? 0.06 : 0.15)) {
      // inside (a chalet's stairs and upper floor, the Autohaus mezzanine, the ski shop, the prison): the floor is the
      // row's own height (their feet), not the world's terrain under the interior's coordinates, which the rig's feet
      // would stand on (Oct 30, the user: "he sinks through the floor", "it's like you go through the stairs")
      if (r.interior) onFloor(rig, r.animAcc, st, seated ? pos.y - 0.45 : pos.y);
      else rig.update(r.animAcc, st);
      if (fall && r.interior === HOSPITAL) bedArms(rig); // (a patient in a hospital bed: the arms by its side, as you see yourself)
      r.animAcc = 0;
      if (inVeh && r.inCar) carLegs(rig, r); // (drivers and passengers: the bench 'sit' pose hangs the legs straight down through the car floor)
      else if (inVeh && r.onSled) sledLegs(rig); // (astride the snowmobile: knees bent, feet on the running boards)
    }
    // the snow thrown up as they go down and land from a throw (the body's own puffs come from the rig: placeFallen)
    if (fall && !r.interior && d < 120 && rig.pushFx) { // (inside: a patient lying in a hospital bed, no snow)
      if (!r.wasFall) rig.pushFx({ type: 'crash', x: pos.x, y: pos.y, z: pos.z, amount: clamp(speed / 18, 0.3, 1), vx: r.vel.x, vz: r.vel.z });
      else if (r.wasAir && !st.fallAir) rig.pushFx({ type: 'impact', x: pos.x, y: pos.y, z: pos.z, amount: clamp(Math.abs(r.vel.y) / 10 + speed / 20, 0.3, 1) });
    }
    r.wasFall = fall; r.wasAir = fall && !!st.fallAir;
    if ((r.state === ST.ski || (fall && !r.interior)) && d < 120 && this.o.fx) {
      const fi = r.fxInfo;
      fi.grounded = !st.air && !fall; fi.speed = fall ? 0 : speed; fi.sideslip = fall ? 0 : Math.abs(r.lean) * 0.15; fi.lean = fall ? 0 : r.lean;
      this.o.fx(9000 + r.pid * 4, rig, fi, dt);
    } else if (rig.fx?.length) rig.fx.length = 0; // (nothing stale left for the next wipeout)
  }

  // a wipeout as they send it (main.js mpPose, protocol.js fallFlags): the tumble's pitch and roll (crouch, lean), the
  // tuck and the get-up blended between the two rows around the sample, the side, the tumble axis, still in the air
  fallPose(r, st) {
    const A = fallDecode(r.fa, _fa), B = fallDecode(r.fb, _fb), f = r.ff, N = f < 0.5 ? A : B;
    const Fs = r.fallSt;
    Fs.pitch = r.crouch; Fs.roll = r.lean;
    Fs.ball = A.ball + (B.ball - A.ball) * f; Fs.getUp = A.getUp + (B.getUp - A.getUp) * f;
    st.fall = Fs; st.fallSide = N.side; st.fallAir = N.air; st.fallHeading = r.yaw + N.axis; st.fallT = 1;
  }

  dispose() { this.clear(); this.o.vehicles?.dispose(); }
}

// sitting on a bench or a chair (ST.sit, not in a vehicle): the seat they sit on (game/seating.js registers the world's
// benches and deck chairs on every client, so it is found at their seat point; a chairlift's seat is none: its pose);
// inside (a chalet's sofa or chair, a hospital visitor's chair) a plain chair, its floor where onFloor puts it
const _chair = { back: -0.2, front: 0.25, floorY: 0, recline: 0, legs: null };
function benchFor(r, pos) {
  if (r.interior) { _chair.floorY = pos.y - 0.45; return _chair; }
  if (!r.benchSeat || Math.abs(r.benchSeat.x - pos.x) > 0.35 || Math.abs(r.benchSeat.z - pos.z) > 0.35 || Math.abs(r.benchSeat.y - pos.y) > 0.2) r.benchSeat = seatAt('world', pos.x, pos.y, pos.z);
  return r.benchSeat;
}

// a car seat, not a bench: the legs stretched forward to the footwell (knees up, feet flat on that car's floor ahead),
// as carpeople.js seats the traffic's drivers (per model: the floor height in front of the front / rear seats) and
// drive.js seats you (placeRig). In the car's own frame (pitched, rolled with it)
const _q = new THREE.Quaternion(), _hip = new THREE.Vector3(), _tgt = new THREE.Vector3(), _pole = new THREE.Vector3();
function carLegs(rig, r) {
  const b = rig.b, g = r.carG;
  if (!b?.hips || !b.lUp || !b.rUp || !g) return;
  rig.root.updateMatrixWorld(true);
  g.updateMatrixWorld(true);
  const hip = g.worldToLocal(_hip.setFromMatrixPosition(b.hips.matrixWorld));
  const S = seatsFor(r.carT), front = r.carSeat < 2;
  const floor = S?.floor ? (front ? S.floor[0] : S.floor[1] ?? S.floor[0]) : null;
  const drop = floor != null ? clamp(hip.y - floor - 0.09, 0.13, 0.3) : 0.26;
  // (a low sports car: the legs out nearly straight; an SUV's upright seat: the knees up, the feet nearer)
  const ahead = front ? clamp(0.95 - (floor != null ? hip.y - floor : 0.3) * 0.8, 0.55, 0.8) : 0.55;
  g.getWorldQuaternion(_q);
  for (const [side, up, leg, foot] of [[1, b.lUp, b.lLeg, b.lFoot], [-1, b.rUp, b.rLeg, b.rFoot]]) {
    g.localToWorld(_tgt.set(hip.x + side * 0.14, hip.y - drop, hip.z + ahead));
    _pole.set(side * 0.15, 1, 0.5).normalize().applyQuaternion(_q);
    try { twoBone(up, leg, foot, _tgt, _pole); } catch { /* (the pose stays as the rig made it) */ }
  }
}

// a rig posed inside an interior (its own scene and coordinates): the feet on the floor at y, not on the world's terrain
// under those coordinates (the rig's feet ask world.groundHeight: overridden for the call, as busintro.js withGround)
let _floorY = 0;
const floorAt = () => _floorY;
function onFloor(rig, dt, st, y) {
  const own = Object.prototype.hasOwnProperty.call(world, 'groundHeight'), g0 = world.groundHeight;
  _floorY = y; world.groundHeight = floorAt;
  try { rig.update(dt, st); } finally { if (own) world.groundHeight = g0; else delete world.groundHeight; }
}

// astride a snowmobile: the knees out and bent, the feet on the running boards either side, a little ahead of the hip
function sledLegs(rig) {
  const b = rig.b;
  if (!b?.hips || !b.lUp || !b.rUp) return;
  const q = rig.root.quaternion;
  rig.root.updateMatrixWorld(true);
  _hip.setFromMatrixPosition(b.hips.matrixWorld);
  for (const [side, up, leg, foot] of [[1, b.lUp, b.lLeg, b.lFoot], [-1, b.rUp, b.rLeg, b.rFoot]]) {
    _tgt.set(side * 0.27, -0.5, 0.3).applyQuaternion(q).add(_hip);
    _pole.set(side * 0.4, 0.6, 1).normalize().applyQuaternion(q);
    try { twoBone(up, leg, foot, _tgt, _pole); } catch { /* (the pose stays as the rig made it) */ }
  }
}
