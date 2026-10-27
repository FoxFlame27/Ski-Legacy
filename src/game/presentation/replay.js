// Race replays: a ring buffer of every racer's transform + pose (the last ~60 s at 30 Hz) and a TV
// director that plays the end of the run back with broadcast camera angles:
//   trackside  fixed cameras beside the piste, ahead of the skier, that pan (and zoom) to follow
//   heli       a high helicopter camera trailing off to one side
//   chase      a low tracking camera just behind and beside the skier
//   finish     a fixed camera at the finish line for the last seconds
// Hard cuts between angles; the finish and big airs play in slow motion. Real time only.
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { clamp, lerp, smoothstep } from '../../core/noise.js';
import { applyCamera, keepAbove, ground, frameFov, poseRig, showRig, damp, wrapAngle, UP } from './cinecam.js';

export const REPLAY_RATE = 30;
const SECONDS = 60;
// per-sample channels
const X = 0, Y = 1, Z = 2, HEAD = 3, CROUCH = 4, LEAN = 5, EDGE = 6, SKID = 7, PLOW = 8, SPEED = 9,
  FLIP = 10, FLIPH = 11, GRAB = 12, SPIN = 13, FALLT = 14, FALLSIDE = 15, FLAGS = 16;
const STRIDE = 17;
export const F_TUCK = 1, F_AIR = 2, F_FALL = 4, F_CUT = 8;

const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

// ------------------------------------------------------------------ recording
export class ReplayBuffer {
  /** @param {number} tracks  racers (0 = player) */
  constructor(tracks, seconds = SECONDS, rate = REPLAY_RATE) {
    this.rate = rate;
    this.tracks = tracks;
    this.cap = Math.ceil(seconds * rate) + 2;
    this.time = new Float64Array(this.cap);
    this.data = Array.from({ length: tracks }, () => new Float32Array(this.cap * STRIDE));
    this.cutNext = new Uint8Array(tracks);
    this.reset();
  }

  reset() {
    this.head = 0;
    this.count = 0;
    this.nextT = -Infinity;
    this.cutNext.fill(0);
  }

  get first() { return this.count ? this.time[this.phys(0)] : 0; }
  get last() { return this.count ? this.time[this.phys(this.count - 1)] : 0; }
  phys(i) { return (this.head - this.count + i + this.cap * 2) % this.cap; }

  /** The next sample of a track follows a teleport (respawn): playback snaps instead of sliding. */
  cut(track = 0) { this.cutNext[track] = 1; }

  /** Open a new sample at race time T when one is due; then write() each track. */
  due(T) {
    if (T < this.nextT) return false;
    const i = this.head;
    this.time[i] = T;
    this.slot = i;
    this.head = (i + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
    this.nextT = (this.nextT === -Infinity || T - this.nextT > 0.5 ? T : this.nextT) + 1 / this.rate;
    return true;
  }

  /**
   * @param {number} k  track
   * @param {{x,y,z}} pos
   * @param {object} st  rig state ({ heading, crouch, lean, edge, skid, plow, speed, tuck, air, flip, ... })
   * @param {boolean} [fall]
   */
  write(k, pos, st, fall = false) {
    const d = this.data[k], o = this.slot * STRIDE;
    d[o + X] = pos.x; d[o + Y] = pos.y; d[o + Z] = pos.z;
    d[o + HEAD] = st.heading || 0; d[o + CROUCH] = st.crouch || 0; d[o + LEAN] = st.lean || 0;
    d[o + EDGE] = st.edge || 0; d[o + SKID] = st.skid || 0; d[o + PLOW] = st.plow || 0; d[o + SPEED] = st.speed || 0;
    d[o + FLIP] = st.flip || 0; d[o + FLIPH] = st.flipHeading || 0; d[o + GRAB] = st.grab || 0; d[o + SPIN] = st.spinVel || 0;
    d[o + FALLT] = st.fallT || 0; d[o + FALLSIDE] = st.fallSide || 1;
    d[o + FLAGS] = (st.tuck ? F_TUCK : 0) | (st.air ? F_AIR : 0) | (fall ? F_FALL : 0) | (this.cutNext[k] ? F_CUT : 0);
    this.cutNext[k] = 0;
  }

  // logical index of the last sample at or before t
  find(t) {
    let lo = 0, hi = this.count - 1;
    if (hi < 0) return -1;
    if (t <= this.time[this.phys(0)]) return 0;
    if (t >= this.time[this.phys(hi)]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.time[this.phys(mid)] <= t) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Interpolated sample of track k at race time t into out (a rig state + x, y, z, down = wiped out). */
  sample(k, t, out) {
    const i = this.find(t);
    if (i < 0) return null;
    const j = Math.min(this.count - 1, i + 1);
    const pi = this.phys(i), pj = this.phys(j), d = this.data[k];
    const ti = this.time[pi], tj = this.time[pj];
    let a = tj > ti ? clamp((t - ti) / (tj - ti), 0, 1) : 0;
    const oi = pi * STRIDE, oj = pj * STRIDE;
    if (d[oj + FLAGS] & F_CUT) a = 0;
    const L = (c) => d[oi + c] + (d[oj + c] - d[oi + c]) * a;
    out.x = L(X); out.y = L(Y); out.z = L(Z);
    out.heading = lerpAngle(d[oi + HEAD], d[oj + HEAD], a);
    out.crouch = L(CROUCH); out.lean = L(LEAN); out.edge = L(EDGE); out.skid = L(SKID); out.plow = L(PLOW); out.speed = L(SPEED);
    out.flip = L(FLIP); out.flipHeading = lerpAngle(d[oi + FLIPH], d[oj + FLIPH], a);
    out.grab = L(GRAB); out.spinVel = L(SPIN); out.fallT = L(FALLT); out.fallSide = d[oi + FALLSIDE] || 1;
    const fl = a < 0.5 ? d[oi + FLAGS] : d[oj + FLAGS];
    out.tuck = !!(fl & F_TUCK); out.air = !!(fl & F_AIR); out.down = !!(fl & F_FALL);
    out.fall = null; // (the rig's live tumble state is not recorded: a replayed wipeout lies down)
    return out;
  }

  /** [t0, t1] spans of track k with a flag set, at least `min` s long. */
  spans(k, flag, t0, t1, min = 0) {
    const out = [], d = this.data[k];
    let start = null;
    for (let i = this.find(t0); i >= 0 && i < this.count; i++) {
      const p = this.phys(i), t = this.time[p];
      if (t > t1) break;
      const on = (d[p * STRIDE + FLAGS] & flag) !== 0;
      if (on && start === null) start = t;
      if (!on && start !== null) { if (t - start >= min) out.push([start, t]); start = null; }
    }
    if (start !== null && t1 - start >= min) out.push([start, t1]);
    return out;
  }
}

// ------------------------------------------------------------------ playback
const SHOT_ORDER = ['trackside', 'heli', 'trackside', 'chase', 'trackside', 'heli'];
const FINISH_LEAD = 3.2;     // s before the line the finish camera takes over
const SLOW_FINISH = 0.32, SLOW_AIR = 0.42;

export class ReplayDirector {
  /**
   * @param {object} o
   * @param {ReplayBuffer} o.buffer
   * @param {object} o.track     race Track (frame(s), finishS)
   * @param {object} o.course    course contract (features)
   * @param {(x, z, hint) => {s:number}} o.project
   * @param {THREE.Camera} o.camera
   * @param {Array<{rig: object}>} o.racers  same order as the buffer tracks (0 = player)
   * @param {number} o.finishClock  race time the player crossed the line (NaN: none)
   * @param {number} [o.length=20]  s played back
   * @param {object} [o.ui]
   * @param {(t: number) => string} [o.clockText]  badge clock for race time t
   */
  constructor(o) {
    Object.assign(this, o);
    const B = this.buffer;
    const fc = Number.isFinite(this.finishClock) ? this.finishClock : B.last;
    this.t1 = Math.min(B.last, fc + 2.8);
    this.t0 = Math.max(B.first, this.t1 - (this.length || 20), 0);
    this.t = this.t0;
    this.done = this.t1 - this.t0 < 1;
    this.fc = fc;
    this.airs = B.spans(0, F_AIR, this.t0, this.t1, 0.9);
    this.st = Array.from({ length: B.tracks }, () => ({ normal: new THREE.Vector3(0, 1, 0), mode: 'ski' }));
    this.shot = null;
    this.shotN = 0;
    this.side = 1;
    this.ps = null;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.fov = 40;
    this.tunnels = (this.course.features || []).filter((f) => f.type === 'tunnel' || f.type === 'bridge');
  }

  get duration() { return this.t1 - this.t0; }

  /** Playback speed at race time t: slow motion through the finish and big airs. */
  rate(t) {
    let r = 1;
    if (Number.isFinite(this.finishClock)) {
      const k = smoothstep(this.fc - 1.2, this.fc - 0.6, t) * (1 - smoothstep(this.fc + 0.5, this.fc + 1.0, t));
      r = Math.min(r, lerp(1, SLOW_FINISH, k));
    }
    for (const [a, b] of this.airs) {
      const k = smoothstep(a, a + 0.3, t) * (1 - smoothstep(b - 0.25, b + 0.05, t));
      r = Math.min(r, lerp(1, SLOW_AIR, k));
    }
    return r;
  }

  /** Per frame (real dt): advance, pose every rig, frame the shot. Returns false at the end. */
  update(dt) {
    if (this.done) return false;
    const rate = this.rate(this.t);
    this.t = Math.min(this.t1, this.t + dt * rate);
    const B = this.buffer, t = this.t;
    // racers
    const cam = this.camera.position;
    for (let k = 0; k < B.tracks; k++) {
      const r = this.racers[k], st = this.st[k];
      if (!r?.rig || !B.sample(k, t, st)) continue;
      const near = Math.hypot(st.x - cam.x, st.z - cam.z) < 650;
      showRig(r.rig, near);
      if (!near) continue;
      st.mode = st.down ? 'fall' : 'ski';
      st.fp = false;
      st.carry = false;
      if (st.air) st.normal.set(0, 1, 0); else world.groundNormal(st.x, st.z, st.y + 0.5, st.normal);
      poseRig(r.rig, st.x, st.y, st.z, dt * rate, st);
    }
    // camera
    const me = this.st[0];
    if (this.racers[0]?.rig && B.sample(0, t, me)) {
      const p = this.project(me.x, me.z, this.ps ?? undefined);
      if (p && Number.isFinite(p.s) && (this.ps === null || Math.abs(p.s - this.ps) < 200)) this.ps = p.s;
      this.frame(dt, me);
    }
    this.ui?.badgeTime(this.clockText ? this.clockText(t) : '', rate < 0.8);
    if (t >= this.t1) { this.done = true; return false; }
    return true;
  }

  // ------------------------------------------------------------------ shots
  frame(dt, me) {
    const t = this.t;
    const nearFinish = Number.isFinite(this.finishClock) && this.fc - t < FINISH_LEAD;
    let sh = this.shot;
    if (nearFinish && sh?.kind !== 'finish') sh = this.shot = this.makeFinish();
    if (!sh || (sh.kind !== 'finish' && this.shotOver(sh, me))) {
      // no new angle for the last moments before the finish camera
      const soon = Number.isFinite(this.finishClock) && this.fc - t < FINISH_LEAD + 1.4;
      sh = this.shot = soon && sh ? this.makeFinish() : this.makeShot(me);
    }
    const focus = this._focus || (this._focus = new THREE.Vector3());
    focus.set(me.x, me.y + (me.down ? 0.5 : 1.0), me.z);
    const fx = Math.sin(me.heading), fz = Math.cos(me.heading), rx = -fz, rz = fx;
    const first = sh.frames++ === 0;
    if (sh.kind === 'trackside' || sh.kind === 'finish') {
      this.camPos.copy(sh.pos);
      if (first) this.camLook.copy(focus); else this.camLook.lerp(focus, damp(22, dt));
      const d = this.camPos.distanceTo(focus);
      const fov = frameFov(sh.kind === 'finish' ? 2.6 : 2.6, d, 13, 55);
      this.fov = first ? fov : lerp(this.fov, fov, damp(4, dt));
    } else if (sh.kind === 'heli') {
      sh.yaw = first ? Math.atan2(fx, fz) : sh.yaw + wrapAngle(Math.atan2(fx, fz) - sh.yaw) * damp(1.2, dt);
      const hx = Math.sin(sh.yaw), hz = Math.cos(sh.yaw);
      const want = this._w || (this._w = new THREE.Vector3());
      want.set(me.x - hx * 26 - hz * sh.side * 30, me.y + 24, me.z - hz * 26 + hx * sh.side * 30);
      keepAbove(want, 18);
      if (first) this.camPos.copy(want); else this.camPos.lerp(want, damp(2.2, dt));
      if (first) this.camLook.copy(focus); else this.camLook.lerp(focus, damp(10, dt));
      const fov = frameFov(3.2, this.camPos.distanceTo(focus), 12, 42);
      this.fov = first ? fov : lerp(this.fov, fov, damp(3, dt));
    } else { // chase
      const want = this._w || (this._w = new THREE.Vector3());
      want.set(me.x - fx * 6 + rx * sh.side * 1.9, me.y + 1.5, me.z - fz * 6 + rz * sh.side * 1.9);
      keepAbove(want, 0.9);
      if (first) this.camPos.copy(want); else this.camPos.lerp(want, damp(6, dt));
      const look = this._l || (this._l = new THREE.Vector3());
      look.set(me.x + fx * 3, me.y + 0.9, me.z + fz * 3);
      if (first) this.camLook.copy(look); else this.camLook.lerp(look, damp(9, dt));
      this.fov = 56;
    }
    applyCamera(this.camera, this.camPos, this.camLook, this.fov);
  }

  shotOver(sh, me) {
    const age = this.t - sh.t0;
    if (sh.kind === 'trackside') return age > sh.max || (this.ps !== null && this.ps > sh.s + 14) || age > 1.2 && this.camPos.distanceTo(this._focus) > 140;
    return age > sh.max;
  }

  makeShot(me) {
    const kind = SHOT_ORDER[this.shotN++ % SHOT_ORDER.length];
    this.side = -this.side;
    const base = { kind, t0: this.t, frames: 0, side: this.side };
    if (kind === 'heli') return { ...base, max: 4.2 };
    if (kind === 'chase') return { ...base, max: 3.2 };
    // trackside: a camera ahead along the piste, beside the nets (inside them in tunnels / on bridges)
    const v = Math.max(8, me.speed || 0);
    const s = (this.ps ?? 0) + clamp(v * 2.3, 30, 85);
    const fr = this.track.frame(s, {});
    const enclosed = this.tunnels.some((f) => s > f.s0 - 15 && s < f.s1 + 15);
    const lat = this.side * (enclosed ? fr.w - 1.2 : fr.w + 2.5);
    const pos = new THREE.Vector3(fr.x + fr.nx * lat, 0, fr.z + fr.nz * lat);
    // high enough to see over the crest the skier comes over (the piste falls away below the camera)
    pos.y = enclosed ? fr.y + 2.2 : Math.max(Math.max(fr.y, ground(pos.x, pos.z, fr.y + 6)) + 3.2, (me.y || fr.y) + 2.4);
    return { ...base, pos, s, max: 4.6 };
  }

  makeFinish() {
    const tr = this.track;
    const fr = tr.frame(tr.finishS + 7, {});
    const side = this.finishSide ?? 1;
    const lat = side * Math.max(2, fr.w - 2.5);
    const pos = new THREE.Vector3(fr.x + fr.nx * lat, 0, fr.z + fr.nz * lat);
    pos.y = ground(pos.x, pos.z, fr.y + 6) + 1.7;
    return { kind: 'finish', pos, t0: this.t, frames: 0, max: Infinity };
  }
}

export { UP };
