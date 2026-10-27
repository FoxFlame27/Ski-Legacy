// Ghost runs: record the player at a fixed rate, store the best run compactly, play it back as a
// translucent skier and compare progress (ghost delta).
//
// Storage format (binary, little-endian, base64 in localStorage 'ski-legacy-ghost-<courseId>'):
//   u16 magic 'SG' | u8 version | u8 rate (Hz) | u32 count | f32 finish time | i32 x0, y0, z0 (cm)
//   per sample: position delta in cm as 3 x i16 (or the escape i16 -32768 followed by an absolute
//   3 x i32 for jumps such as respawns), u16 heading, u8 crouch, i8 lean, u8 plow, u8 flags.
// A 2.5 minute run at 20 Hz is ~36 KB (~48 KB of base64).
import * as THREE from 'three';

export const GHOST_RATE = 20;
// (-at2: the courses moved onto the resort's mountains on Oct 27; ghosts store world positions, so the runs
// recorded on the old maps would replay in the wrong place)
export const GHOST_KEY = 'ski-legacy-ghost-at2-';
const MAGIC = 0x4753;
const VERSION = 1;
const ESC = -32768;
const TAU = Math.PI * 2;

// sample flags
export const FLAG_TUCK = 1, FLAG_AIR = 2, FLAG_FALL = 4, FLAG_CUT = 8; // CUT: teleported, don't interpolate into it

const wrapAngle = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

// ---------------------------------------------------------------- recording
export class GhostRecorder {
  constructor(rate = GHOST_RATE) {
    this.rate = rate;
    this.reset();
  }

  reset() {
    this.count = 0;
    this.cap = 0;
    this.data = null;
    this.prev = null; // last recorded frame state { t, x, y, z, heading, crouch, lean, plow, flags }
    this.cutPending = false;
    this.grow(2048);
  }

  grow(n) {
    const old = this.data;
    const d = {
      x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), heading: new Float32Array(n),
      crouch: new Float32Array(n), lean: new Float32Array(n), plow: new Float32Array(n), flags: new Uint8Array(n),
    };
    if (old) for (const k of Object.keys(d)) d[k].set(old[k].subarray(0, this.count));
    this.data = d;
    this.cap = n;
  }

  // The next sample follows a discontinuity (respawn): playback snaps instead of interpolating.
  cut() { this.cutPending = true; }

  push(st, flags) {
    if (this.count >= this.cap) this.grow(this.cap * 2);
    const d = this.data, i = this.count++;
    d.x[i] = st.x; d.y[i] = st.y; d.z[i] = st.z; d.heading[i] = st.heading;
    d.crouch[i] = st.crouch; d.lean[i] = st.lean; d.plow[i] = st.plow; d.flags[i] = flags;
  }

  /**
   * Call every frame from GO with the race time and the current skier state. Emits samples at exact
   * multiples of 1/rate, interpolated between the previous frame and this one.
   * @param {number} t   race time (s)
   * @param {object} st  { x, y, z, heading, crouch, lean, plow, tuck, air, fall }
   */
  record(t, st) {
    const flags = (st.tuck ? FLAG_TUCK : 0) | (st.air ? FLAG_AIR : 0) | (st.fall ? FLAG_FALL : 0);
    const cur = {
      t, x: st.x, y: st.y, z: st.z, heading: st.heading,
      crouch: st.crouch || 0, lean: st.lean || 0, plow: st.plow || 0, flags,
    };
    const step = 1 / this.rate;
    if (!this.prev) {
      // first frame: fill every tick up to now with this state
      while (this.count * step <= t + 1e-9) this.push(cur, flags);
      this.prev = cur;
      this.cutPending = false;
      return;
    }
    const p = this.prev;
    const span = cur.t - p.t;
    const snap = this.cutPending;
    while (this.count * step <= t + 1e-9) {
      const tk = this.count * step;
      if (snap || span <= 1e-6) {
        // after a teleport every tick of this frame is the new place; only the first one is flagged
        this.push(cur, flags | (this.cutPending ? FLAG_CUT : 0));
        this.cutPending = false;
        continue;
      }
      const a = Math.min(1, Math.max(0, (tk - p.t) / span));
      _rec.x = p.x + (cur.x - p.x) * a; _rec.y = p.y + (cur.y - p.y) * a; _rec.z = p.z + (cur.z - p.z) * a;
      _rec.heading = lerpAngle(p.heading, cur.heading, a);
      _rec.crouch = p.crouch + (cur.crouch - p.crouch) * a;
      _rec.lean = p.lean + (cur.lean - p.lean) * a;
      _rec.plow = p.plow + (cur.plow - p.plow) * a;
      this.push(_rec, a < 0.5 ? p.flags : flags);
    }
    this.prev = cur;
  }

  /** Finished run (trimmed copies), ready for encodeGhost / GhostPlayer. */
  finish(time) {
    const d = this.data, n = this.count;
    const out = { rate: this.rate, time, count: n };
    for (const k of Object.keys(d)) out[k] = d[k].slice(0, n);
    return out;
  }
}
const _rec = { x: 0, y: 0, z: 0, heading: 0, crouch: 0, lean: 0, plow: 0 };

// ---------------------------------------------------------------- binary encoding
const q8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
const qs8 = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));
const qHeading = (h) => Math.round(((h % TAU + TAU) % TAU) / TAU * 65536) & 0xffff;

export function encodeGhost(run) {
  const n = run.count;
  const X = new Int32Array(n), Y = new Int32Array(n), Z = new Int32Array(n);
  for (let i = 0; i < n; i++) { X[i] = Math.round(run.x[i] * 100); Y[i] = Math.round(run.y[i] * 100); Z[i] = Math.round(run.z[i] * 100); }
  // size pass: escapes need 2 + 12 bytes instead of 6
  const fits = (d) => d > ESC && d <= 32767;
  let size = 24;
  for (let i = 0; i < n; i++) {
    if (i > 0) size += fits(X[i] - X[i - 1]) && fits(Y[i] - Y[i - 1]) && fits(Z[i] - Z[i - 1]) ? 6 : 14;
    size += 6;
  }
  const buf = new ArrayBuffer(size), dv = new DataView(buf);
  dv.setUint16(0, MAGIC, true); dv.setUint8(2, VERSION); dv.setUint8(3, run.rate);
  dv.setUint32(4, n, true); dv.setFloat32(8, run.time, true);
  dv.setInt32(12, n ? X[0] : 0, true); dv.setInt32(16, n ? Y[0] : 0, true); dv.setInt32(20, n ? Z[0] : 0, true);
  let o = 24;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dx = X[i] - X[i - 1], dy = Y[i] - Y[i - 1], dz = Z[i] - Z[i - 1];
      if (fits(dx) && fits(dy) && fits(dz)) {
        dv.setInt16(o, dx, true); dv.setInt16(o + 2, dy, true); dv.setInt16(o + 4, dz, true); o += 6;
      } else {
        dv.setInt16(o, ESC, true);
        dv.setInt32(o + 2, X[i], true); dv.setInt32(o + 6, Y[i], true); dv.setInt32(o + 10, Z[i], true); o += 14;
      }
    }
    dv.setUint16(o, qHeading(run.heading[i]), true);
    dv.setUint8(o + 2, q8(run.crouch[i]));
    dv.setInt8(o + 3, qs8(run.lean[i]));
    dv.setUint8(o + 4, q8(run.plow[i]));
    dv.setUint8(o + 5, run.flags[i]);
    o += 6;
  }
  return bytesToBase64(new Uint8Array(buf));
}

export function decodeGhost(b64) {
  const bytes = base64ToBytes(b64);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 24 || dv.getUint16(0, true) !== MAGIC) throw new Error('not a ghost');
  const version = dv.getUint8(2);
  if (version !== VERSION) throw new Error('ghost version ' + version);
  const rate = dv.getUint8(3), n = dv.getUint32(4, true), time = dv.getFloat32(8, true);
  const run = {
    rate, time, count: n,
    x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), heading: new Float32Array(n),
    crouch: new Float32Array(n), lean: new Float32Array(n), plow: new Float32Array(n), flags: new Uint8Array(n),
  };
  let X = dv.getInt32(12, true), Y = dv.getInt32(16, true), Z = dv.getInt32(20, true);
  let o = 24;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dx = dv.getInt16(o, true);
      if (dx === ESC) {
        X = dv.getInt32(o + 2, true); Y = dv.getInt32(o + 6, true); Z = dv.getInt32(o + 10, true); o += 14;
      } else {
        X += dx; Y += dv.getInt16(o + 2, true); Z += dv.getInt16(o + 4, true); o += 6;
      }
    }
    run.x[i] = X / 100; run.y[i] = Y / 100; run.z[i] = Z / 100;
    run.heading[i] = wrapAngle(dv.getUint16(o, true) / 65536 * TAU);
    run.crouch[i] = dv.getUint8(o + 2) / 255;
    run.lean[i] = dv.getInt8(o + 3) / 127;
    run.plow[i] = dv.getUint8(o + 4) / 255;
    run.flags[i] = dv.getUint8(o + 5);
    o += 6;
  }
  return run;
}

function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ---------------------------------------------------------------- persistence
function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** Store a run as the course ghost. meta: { char, ski, splits } (anything JSON). Returns success. */
export function saveGhost(courseId, run, meta = {}) {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(GHOST_KEY + courseId, JSON.stringify({ v: VERSION, time: run.time, date: Date.now(), ...meta, data: encodeGhost(run) }));
    return true;
  } catch (e) {
    console.warn('Ghost not saved', e?.message || e);
    return false;
  }
}

/** -> { run, meta } or null when there is no (valid) ghost for the course. */
export function loadGhost(courseId) {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(GHOST_KEY + courseId);
    if (!raw) return null;
    const { data, ...meta } = JSON.parse(raw);
    const run = decodeGhost(data);
    return run.count > 1 ? { run, meta } : null;
  } catch (e) {
    console.warn('Ghost unreadable', e?.message || e);
    return null;
  }
}

export function clearGhost(courseId) {
  try { storage()?.removeItem(GHOST_KEY + courseId); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- playback
export class GhostPlayer {
  constructor(run) {
    this.run = run;
    this.duration = (run.count - 1) / run.rate;
    this.sMax = null;
  }

  /** Interpolated state at race time t into `out` ({ x, y, z, heading, crouch, lean, plow, tuck, air, fall, done }). */
  sample(t, out) {
    const r = this.run, n = r.count;
    const f = Math.max(0, t) * r.rate;
    let i = Math.floor(f), a = f - i;
    if (i >= n - 1) { i = n - 1; a = 0; }
    let j = Math.min(n - 1, i + 1);
    if (r.flags[j] & FLAG_CUT) { a = 0; j = i; } // never slide across a respawn
    out.x = r.x[i] + (r.x[j] - r.x[i]) * a;
    out.y = r.y[i] + (r.y[j] - r.y[i]) * a;
    out.z = r.z[i] + (r.z[j] - r.z[i]) * a;
    out.heading = lerpAngle(r.heading[i], r.heading[j], a);
    out.crouch = r.crouch[i] + (r.crouch[j] - r.crouch[i]) * a;
    out.lean = r.lean[i] + (r.lean[j] - r.lean[i]) * a;
    out.plow = r.plow[i] + (r.plow[j] - r.plow[i]) * a;
    const fl = a < 0.5 ? r.flags[i] : r.flags[j];
    out.tuck = !!(fl & FLAG_TUCK); out.air = !!(fl & FLAG_AIR); out.fall = !!(fl & FLAG_FALL);
    out.done = t >= this.duration;
    // speed from the neighbouring samples (for animation)
    const k = Math.min(n - 1, i + 1), k0 = Math.max(0, k - 1);
    out.speed = (r.flags[k] & FLAG_CUT) ? 0 : Math.hypot(r.x[k] - r.x[k0], r.y[k] - r.y[k0], r.z[k] - r.z[k0]) * r.rate;
    return out;
  }

  /**
   * Course progress of every sample, for the ghost delta. `project(x, z, hintS)` -> { s }.
   * Keeps the running maximum, so a respawned ghost never "un-reaches" a distance.
   */
  buildProgress(project) {
    const r = this.run, n = r.count;
    const sMax = new Float32Array(n);
    let hint = 0, m = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = project(r.x[i], r.z[i], hint);
      const s = p && Number.isFinite(p.s) ? p.s : hint;
      hint = s;
      m = Math.max(m, s);
      sMax[i] = m;
    }
    this.sMax = sMax;
    return sMax;
  }

  /** Race time at which the ghost first reached course distance s (interpolated), or null. */
  timeAt(s) {
    const a = this.sMax;
    if (!a || !a.length || s > a[a.length - 1]) return null;
    if (s <= a[0]) return 0;
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < s) lo = mid; else hi = mid;
    }
    const span = a[hi] - a[lo];
    const f = span > 1e-6 ? (s - a[lo]) / span : 0;
    return (lo + f) / this.run.rate;
  }
}

// ---------------------------------------------------------------- translucent ghost skier
const GHOST_TINT = new THREE.Color(0.72, 0.85, 1.0);

/**
 * Turn a SkierRig into a ghost: every material is cloned (the original rig/player keep theirs),
 * made transparent with depthWrite off, lightly tinted ice-blue; no shadows.
 * Returns the cloned materials so their opacity can be faded.
 */
export function makeGhostRig(rig, opacity = 0.35) {
  const mats = [];
  const clone = (m) => {
    const c = m.clone();
    c.transparent = true;
    c.opacity = opacity;
    c.depthWrite = false;
    if (c.color) c.color.lerp(GHOST_TINT, 0.35);
    if (c.emissive) { c.emissive.copy(GHOST_TINT).multiplyScalar(0.18); c.emissiveIntensity = 1; }
    c.userData.ghostBase = opacity;
    mats.push(c);
    return c;
  };
  for (const root of [rig.root, rig.gear]) {
    root?.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map(clone) : clone(o.material);
      o.castShadow = false;
      o.receiveShadow = false;
      o.renderOrder = 2;
    });
  }
  return mats;
}

// Proximity fades (m): the ghost is gone within CAM_NEAR of the camera lens and fully visible from
// CAM_FAR (a trailing ghost passes right through a chase camera ~5 m behind the player); overlapping
// the player's own skier it drops to PLAYER_MIN of its opacity so the player's silhouette stays clear.
const CAM_NEAR = 1.0, CAM_FAR = 4.5;
const PLAYER_NEAR = 0.8, PLAYER_FAR = 3, PLAYER_MIN = 0.35;
const smooth01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Plays a ghost run on a translucent rig. The rig is faded out close to the camera (so it never
 * veils the view), partly while it overlaps the player, and after the ghost has finished.
 */
export class GhostRunner {
  constructor({ scene, rig, run, opacity = 0.35 }) {
    this.scene = scene;
    this.rig = rig;
    this.player = new GhostPlayer(run);
    this.opacity = opacity;
    this.mats = rig ? makeGhostRig(rig, opacity) : [];
    this.state = { x: 0, y: 0, z: 0, heading: 0, crouch: 0, lean: 0, plow: 0, tuck: false, air: false, fall: false, done: false, speed: 0 };
    this.fade = 1;
    this.alpha = 1;
    this.fallT = 0;
    this.visible = true;
    this.normal = new THREE.Vector3(0, 1, 0);
    if (rig) {
      rig.setSkisVisible?.(true);
      rig.setCarry?.(false);
      rig.addTo(scene);
    }
  }

  /**
   * @param {number} t      race time (negative during the countdown: holds the start pose)
   * @param {number} dt     frame time
   * @param {THREE.Vector3} [camera]  camera position (proximity fade; the player's position if no camera)
   * @param {function} [groundNormal] (x, z, y, out) -> out
   * @param {THREE.Vector3} [player]  the player's position (overlap fade); defaults to `camera`
   */
  update(t, dt, camera, groundNormal, player = camera) {
    const st = this.player.sample(t, this.state);
    // fade out after the finish
    const target = st.done ? 0 : 1;
    this.fade += (target - this.fade) * Math.min(1, dt * (st.done ? 1.2 : 6));
    // distance from the camera to the ghost's body (feet to head), not just its feet
    let camK = 1, plK = 1;
    if (camera) {
      const cy = Math.min(st.y + 1.75, Math.max(st.y + 0.1, camera.y));
      camK = smooth01(CAM_NEAR, CAM_FAR, Math.hypot(st.x - camera.x, cy - camera.y, st.z - camera.z));
    }
    if (player) {
      const d = Math.hypot(st.x - player.x, st.y - player.y, st.z - player.z);
      plK = PLAYER_MIN + (1 - PLAYER_MIN) * smooth01(PLAYER_NEAR, PLAYER_FAR, d);
    }
    const a = this.fade * Math.min(camK, plK);
    // smoothed so a ghost swinging past the lens fades instead of popping
    this.alpha += (a - this.alpha) * Math.min(1, dt * 12);
    if (a < this.alpha) this.alpha = a; // ...but never lingers in front of the camera
    for (const m of this.mats) m.opacity = m.userData.ghostBase * this.alpha;
    this.fallT = st.fall ? this.fallT + dt : 0;
    const show = this.alpha > 0.01;
    if (!this.rig) return st;
    if (show !== this.visible) {
      this.visible = show;
      this.rig.root.visible = show;
      if (this.rig.gear) this.rig.gear.visible = show;
    }
    if (!show) return st;
    this.rig.root.position.set(st.x, st.y, st.z);
    if (groundNormal && !st.air) groundNormal(st.x, st.z, st.y, this.normal); else this.normal.set(0, 1, 0);
    this.rig.update(dt, {
      mode: st.fall ? 'fall' : 'ski', heading: st.heading, speed: t < 0 ? 0 : st.speed,
      crouch: st.crouch, lean: st.lean, edge: st.lean * 0.8, tuck: st.tuck, plow: st.plow, normal: this.normal,
      air: st.air, fallT: Math.min(1, this.fallT / 0.6), fallSide: 1,
    });
    return st;
  }

  dispose() {
    if (this.rig) this.rig.removeFrom(this.scene);
    for (const m of this.mats) m.dispose();
    this.mats.length = 0;
  }
}
