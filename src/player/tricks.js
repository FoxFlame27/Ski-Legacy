// Freestyle tricks: spins (A/D), flips (W/S) and grabs (Shift) while airborne. Spins and flips need a
// deliberate jump (a Space pop or a park kicker); keys held into the jump (tuck, brake, a held turn)
// only count once pressed again, so normal riding never turns into a trick by accident.
// Rotations ease in while a key is held; on release they settle onto the nearest clean 180 (spins)
// or full flip, so tricks are easy to learn but timing still matters. A landing is judged on the
// skis' direction against the travel direction (forward or switch), how upright the skier is and
// how hard the snow hits; the trick is then named ("Backflip 360 Mute") and scored.
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// rotation feel
const SPIN_MAX = 7.4;     // rad/s at full spin (~420 deg/s: a 360 in ~0.95 s)
const SPIN_ACC = 26;      // rad/s^2 spin-up
const FLIP_MAX = 5.9;     // rad/s at full flip
const FLIP_ACC = 15;      // rad/s^2
const SPIN_EASE = 16;     // deceleration used to predict where a released spin comes to rest
const FLIP_EASE = 9;
const SETTLE_W = 7.5;     // settle spring (critically damped) natural frequency
const MIN_FLIP_AIR = 1.05; // a flip is only started with the flight time it needs to land (s)

// landing windows
export const CLEAN_YAW = 15 * DEG, SKETCHY_YAW = 40 * DEG;
export const CLEAN_FLIP = 15 * DEG, SKETCHY_FLIP = 35 * DEG;
export const SKETCHY_IMPACT = 12, CRASH_IMPACT = 16; // m/s into the snow (~7 m and ~13 m flat drops)

const SPIN_POINTS = [0, 150, 300, 500, 750, 1050, 1400, 1800, 2250];
const FLIP_POINTS = [0, 600, 1500, 2700, 4200];
const FLIP_WORDS = ['', '', 'Double ', 'Triple ', 'Quad '];
export const GRAB_NAMES = { mute: 'Mute', safety: 'Safety', japan: 'Japan' };
const KEYS = ['left', 'right', 'front', 'back', 'grab'];

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (x, t, step) => (x < t ? Math.min(t, x + step) : Math.max(t, x - step));
const round10 = (x) => Math.round(x / 10) * 10;

// Exact critically damped spring step toward `target` (frame-rate independent); writes into `o`.
function settle(o, x, v, target, w, dt) {
  const d = x - target, e = Math.exp(-w * dt), c = v + w * d;
  o.x = target + (d + c * dt) * e;
  o.v = (v - c * w * dt) * e;
}

export class Tricks {
  constructor() {
    this.total = 0;       // running score (reset by the race session / mode)
    this.last = null;     // last judged landing
    this.active = false;  // airborne with the trick system armed
    this.latch = { left: false, right: false, front: false, back: false, grab: false };
    this._s = { x: 0, v: 0 };
    this.cancel();
  }

  // forget the current jump (teleports, lifts, crashes that are not landings)
  cancel() {
    this.active = false;
    this.spin = 0; this.spinVel = 0; this.spinTarget = null;
    this.flip = 0; this.flipVel = 0; this.flipTarget = null;
    this.grab = 0; this.grabTime = 0; this.grabType = null;
    this.airTime = 0; this.maxSpinVel = 0; this.switchTakeoff = false; this.allowFlip = true; this.allowSpin = true;
    // trick keys that count this frame (held, not latched, allowed): the player steers with the rest
    this.live = { left: false, right: false, front: false, back: false, grab: false };
  }

  resetScore() { this.total = 0; this.last = null; }

  /**
   * Leaving the snow.
   * @param {object} o
   * @param {boolean} o.latch   keys already held must be released and pressed again before they
   *                            count (false after a Space pop: lets you pre-wind a spin)
   * @param {boolean} o.flips   flips allowed (deliberate jumps: a pop or a park kicker)
   * @param {boolean} [o.spins] spins allowed (deliberate jumps; otherwise A/D keep steering the skis)
   * @param {object} o.held     { left, right, front, back, grab } keys to latch (riding inputs held
   *                            into the jump: tuck, brake, skate, a held turn)
   * @param {boolean} [o.switch] riding backwards at takeoff
   */
  takeoff({ latch = true, flips = true, spins = true, held = {}, switch: sw = false } = {}) {
    this.cancel();
    this.active = true;
    this.allowFlip = flips;
    this.allowSpin = spins;
    this.switchTakeoff = sw;
    for (const k of KEYS) this.latch[k] = latch && !!held[k];
  }

  // A pop shortly after rolling off a lip makes the jump deliberate after all. Keys held through the
  // lip stay latched (a tuck or a held turn never turns into a flip or a spin).
  arm() { this.allowFlip = true; this.allowSpin = true; }
  unlatch() { for (const k of KEYS) this.latch[k] = false; this.arm(); }

  /**
   * Integrate the rotations for one frame.
   * @param {number} dt
   * @param {object} keys     { left, right, front, back, grab } currently held
   * @param {number} airLeft  predicted remaining flight time (s); new flips need some room
   */
  update(dt, keys, airLeft = 1) {
    if (!this.active) return;
    this.airTime += dt;
    // a key held since an unintended takeoff only counts after it has been released once
    const on = this.live;
    for (const k of KEYS) {
      if (!keys[k]) this.latch[k] = false;
      on[k] = !!keys[k] && !this.latch[k];
    }
    if (!this.allowSpin) on.left = on.right = false;
    if (!this.allowFlip) on.front = on.back = false;
    const o = this._s;

    // ---- spin (yaw): A = +, D = -
    const si = (on.left ? 1 : 0) - (on.right ? 1 : 0);
    if (si) {
      this.spinVel = approach(this.spinVel, si * SPIN_MAX, SPIN_ACC * dt);
      this.spinTarget = null;
      this.spin += this.spinVel * dt;
    } else {
      if (this.spinTarget === null) {
        // where a comfortable spin-down would stop -> nearest clean 180
        const rest = this.spin + (this.spinVel * Math.abs(this.spinVel)) / (2 * SPIN_EASE);
        this.spinTarget = Math.round(rest / Math.PI) * Math.PI;
      }
      settle(o, this.spin, this.spinVel, this.spinTarget, SETTLE_W, dt);
      this.spin = o.x; this.spinVel = o.v;
    }
    this.maxSpinVel = Math.max(this.maxSpinVel, Math.abs(this.spinVel));

    // ---- flip (pitch about the travel axis): W = front (+), S = back (-)
    const fi = (on.front ? 1 : 0) - (on.back ? 1 : 0);
    const flipping = Math.abs(this.flip) > 0.05 || Math.abs(this.flipVel) > 0.3;
    if (fi && (flipping || airLeft > MIN_FLIP_AIR)) {
      this.flipVel = approach(this.flipVel, fi * FLIP_MAX, FLIP_ACC * dt);
      this.flipTarget = null;
      this.flip += this.flipVel * dt;
    } else if (flipping) {
      if (this.flipTarget === null) {
        // a released flip carries on (or opens up) to the nearest full rotation
        const rest = this.flip + (this.flipVel * Math.abs(this.flipVel)) / (2 * FLIP_EASE);
        this.flipTarget = Math.round(rest / TAU) * TAU;
      }
      settle(o, this.flip, this.flipVel, this.flipTarget, SETTLE_W * 0.8, dt);
      this.flip = o.x; this.flipVel = o.v;
    }

    // ---- grab (Shift): the grab is picked from what the body is doing when it starts
    if (on.grab) {
      if (!this.grabType) {
        this.grabType = Math.abs(this.flipVel) > 1.5 || Math.abs(this.flip) > 0.5 ? 'japan'
          : Math.abs(this.spinVel) > 1.5 ? 'mute' : 'safety';
      }
      this.grab = approach(this.grab, 1, dt / 0.22);
      if (this.grab > 0.7) this.grabTime += dt;
    } else {
      this.grab = approach(this.grab, 0, dt / 0.18);
    }
  }

  // Trick name for what has been done so far (live preview / landing).
  describe(spin = this.spin, flip = this.flip) {
    const halfTurns = Math.round(Math.abs(spin) / Math.PI);
    const flips = Math.round(Math.abs(flip) / TAU);
    const parts = [];
    if (flips) parts.push(FLIP_WORDS[Math.min(flips, 4)] + (flip > 0 ? 'Frontflip' : 'Backflip'));
    if (halfTurns) parts.push(String(halfTurns * 180));
    if (this.grabType && this.grabTime >= 0.25) parts.push(GRAB_NAMES[this.grabType]);
    let name = parts.join(' ');
    if (name && this.switchTakeoff) name = 'Switch ' + name;
    return { name, halfTurns, flips };
  }

  /**
   * Judge a landing.
   * @param {object} o
   * @param {number} o.yawErr  skis' heading minus travel heading (rad, any range)
   * @param {number} o.impact  speed into the snow along its normal (m/s)
   * @param {number} o.speed   speed along the snow after touchdown (m/s)
   * @returns {{ landed: 'clean'|'sketchy'|'crash', switch: boolean, name: string|null, points: number,
   *             total: number, airTime: number, spin: number, flips: number, grab: string|null,
   *             yawErr: number, flipErr: number, cause: string|null }}
   */
  land({ yawErr = 0, impact = 0, speed = 0 } = {}) {
    const air = this.airTime;
    const yaw = wrapPi(yawErr);
    const sw = Math.abs(yaw) > Math.PI / 2;
    const yawOff = sw ? Math.PI - Math.abs(yaw) : Math.abs(yaw);  // from forward or from switch
    const flipErr = Math.abs(wrapPi(this.flip));
    const { name: trick, halfTurns, flips } = this.describe();

    let landed = 'clean', cause = null;
    if (flipErr > SKETCHY_FLIP) { landed = 'crash'; cause = 'flip'; }
    else if (yawOff > SKETCHY_YAW && speed > 5) { landed = 'crash'; cause = 'sideways'; }
    else if (impact > CRASH_IMPACT) { landed = 'crash'; cause = 'impact'; }
    else if (flipErr > CLEAN_FLIP || yawOff > CLEAN_YAW || impact > SKETCHY_IMPACT || this.grab > 0.5) landed = 'sketchy';

    let name = trick || null;
    let points = 0;
    const grabbed = this.grabType && this.grabTime >= 0.25;
    const parts = (halfTurns > 0 ? 1 : 0) + (flips > 0 ? 1 : 0) + (grabbed ? 1 : 0);
    if (parts) {
      let base = SPIN_POINTS[Math.min(halfTurns, 8)] + FLIP_POINTS[Math.min(flips, 4)]
        + (grabbed ? 100 + 250 * Math.min(this.grabTime, 2) : 0) + 40 * air;
      if (this.switchTakeoff) base *= 1.2;
      points = base * (1 + 0.25 * (parts - 1));
    } else if (air >= 1.1) {
      name = 'Big Air';
      points = 60 * air;
    }
    if (name && sw && halfTurns % 2 === 1) name += ' · Switch';
    points = landed === 'crash' ? 0 : round10(points * (landed === 'sketchy' ? 0.6 : 1));
    if (!name) points = 0;
    this.total += points;
    const res = {
      landed, switch: sw, name, points, total: this.total, airTime: air,
      spin: halfTurns * 180, flips, grab: grabbed ? this.grabType : null,
      yawErr: yaw, flipErr, cause,
    };
    this.last = res;
    this.active = false;
    return res;
  }
}

export const TRICK_TUNING = { SPIN_MAX, FLIP_MAX, MIN_FLIP_AIR };
export { wrapPi };
