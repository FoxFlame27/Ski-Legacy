// Helicopter flight model: arcade, but it reads like a real helicopter and is easy to fly.
// Pure math (three.js vectors only): src/game/heli.js drives it from the keys or the autopilot.
//
// Controls (ctl, each -1..1): fwd (W/S), turn (A/D, + = left), lift (Space/Shift).
//  - W builds forward airspeed along the heading (up to 95 m/s), S brakes and backs up slowly;
//    with nothing held it slows to a hover and holds its height.
//  - A/D yaw: a quick pedal turn in the hover, a wide banked turn at speed. The path follows the
//    nose with a little drift.
//  - Space / Shift climb and sink. Near the snow the rotor's ground cushion softens any descent to a
//    gentle touchdown; a look-out ahead climbs (and if needed brakes) early enough that the skids
//    never meet a slope at speed.
// The visual attitude (nose down to accelerate, banked turns, flare to brake) is derived from the
// motion and smoothed with springs; on the ground the skids settle onto the slope.
import * as THREE from 'three';

export const FLIGHT = {
  MAX_FWD: 95, MAX_BACK: 10,      // m/s (buffed from 60: ~340 km/h flat out)
  ACC: 13, BRAKE: 16, BACK_ACC: 3.4, COAST: 2.4, DRAG: 0.0008,
  DRIFT: 1.7,                     // how fast the path catches up with the nose (1/s)
  TURN: 1.15, TURN_FAST: 0.5, TURN_TAU: 0.28, // yaw rates (rad/s) at a hover / at full speed
  CLIMB: 16, SINK: 10, V_ACC: 9, V_STOP: 16, // vertical speeds (m/s), their response and how hard they stop (m/s^2)
  AGL_MAX: 420,                   // soft ceiling above the ground (m)
  LAND_SLOPE: 0.30,               // steepest ground the skids settle on (~17 deg)
  POWER: 0.92,                    // rotor speed needed to lift off
};
const F = FLIGHT;
const G = 9.81;
const LOOK = [0.5, 1.0, 1.8, 3.0]; // look-out times ahead (s)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// critically damped spring toward `to` (returns [x, v])
function spring(x, v, to, w, dt) {
  const d = x - to, e = Math.exp(-w * dt), c = v + w * d;
  return [to + (d + c * dt) * e, (v - c * w * dt) * e];
}

export class Flight {
  /**
   * @param {object} o
   * @param {number} o.cgH       height of the centre of mass above the skid bottoms (m)
   * @param {number} o.skidL     skid length (m), o.skidW: track between the skids (m)
   * @param {number} [o.skidZ]   skid centre ahead of the centre of mass (m)
   * @param {object} [o.hull]    lowest points of the rest of the airframe, [ahead of the centre of mass, height
   *   above the skid bottoms]: nose, tail; stab: [ahead, half span, height]; rotor: [radius, tip height]
   */
  constructor({ cgH = 1.6, skidL = 3.8, skidW = 2.7, skidZ = 0.4, hull = {} } = {}) {
    this.cgH = cgH; this.skidL = skidL; this.skidW = skidW; this.skidZ = skidZ;
    this.hull = { nose: [3.0, 0.7], tail: [-6.1, 1.2], stab: [-4.2, 1.7, 1.6], rotor: [5.1, 3.3], ...hull };
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.yawRate = 0;
    this.u = 0;                   // commanded forward airspeed along the heading
    this.accel = 0;               // smoothed forward acceleration (for the pitch attitude)
    this.landed = true;
    this.steep = false;           // hovering over ground too steep to settle on
    this.agl = 0;                 // skids above the ground (m)
    this.groundY = 0;
    this.pitch = 0; this.pitchV = 0; // + = nose down
    this.roll = 0; this.rollV = 0;   // + = right side down
    this.t = 0;
    this.climbAssist = 0;         // how hard the look-out is pushing up (0..1, for sound / HUD)
    this.hold = 0;                // > 0: no touchdown here (trees, buildings, a lift line): hover at least this high (m)
    this.quat = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  /** Put the helicopter down on the ground at (x, z), facing `yaw`. */
  place(x, z, yaw, ground) {
    this.yaw = yaw; this.yawRate = 0; this.u = 0; this.accel = 0;
    this.vel.set(0, 0, 0);
    this.landed = true; this.steep = false;
    this.pos.set(x, 0, z);
    this.settle(ground, 1);
    this.pitch = this.landPitch; this.roll = this.landRoll; this.pitchV = this.rollV = 0;
    this.updateQuat();
  }

  // ground under the skids: heights at the four skid ends -> resting height + attitude
  settle(ground, k) {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), lx = fz, lz = -fx; // forward, left
    const p = this.pos, hl = this.skidL / 2, hw = this.skidW / 2, z0 = this.skidZ;
    const h = (a, b) => ground(p.x + fx * a + lx * b, p.z + fz * a + lz * b);
    const fl = h(z0 + hl, hw), fr = h(z0 + hl, -hw), bl = h(z0 - hl, hw), br = h(z0 - hl, -hw);
    const front = (fl + fr) / 2, back = (bl + br) / 2, left = (fl + bl) / 2, right = (fr + br) / 2;
    this.landPitch = clamp(Math.atan2(back - front, this.skidL), -0.3, 0.3);   // nose down when the ground falls ahead
    this.landRoll = clamp(Math.atan2(left - right, this.skidW), -0.3, 0.3);    // right side down when it falls to the right
    const rest = Math.max(fl, fr, bl, br) - 0.04 * Math.abs(this.landPitch + this.landRoll);
    const y = Math.max((front + back) / 2, rest - 0.12) + this.cgH;
    this.pos.y += (y - this.pos.y) * k;
    this.groundY = (front + back) / 2;
    return Math.max(Math.abs(back - front) / this.skidL, Math.abs(left - right) / this.skidW);
  }

  /**
   * Advance the model.
   * @param {number} dt
   * @param {{fwd: number, turn: number, lift: number}} ctl
   * @param {(x: number, z: number) => number} ground  height of whatever the skids would stand on
   * @param {number} power   rotor speed 0..1 (lift-off needs FLIGHT.POWER)
   */
  step(dt, ctl, ground, power = 1) {
    this.groundFn = ground; // (the autopilot's terrain look-ahead samples it)
    const n = Math.max(1, Math.ceil(dt / (1 / 60)));
    for (let i = 0; i < n; i++) this.sub(dt / n, ctl, ground, power);
    this.updateQuat();
  }

  sub(dt, ctl, ground, power) {
    this.t += dt;
    const p = this.pos, v = this.vel;
    const sp = Math.hypot(v.x, v.z);
    const lift = power >= F.POWER ? ctl.lift : Math.min(0, ctl.lift);

    if (this.landed) {
      // on the skids: nothing turns or slides; Space with the rotor up to speed lifts off
      this.yawRate *= Math.exp(-dt * 10); this.u = 0;
      v.x *= Math.exp(-dt * 8); v.z *= Math.exp(-dt * 8); v.y = 0;
      const steep = this.settle(ground, 1 - Math.exp(-dt * 12));
      this.agl = 0;
      this.springAttitude(dt, this.landPitch, this.landRoll, 9);
      if (lift > 0.05) { this.landed = false; v.y = 1.2; p.y += 0.05; }
      else if (steep > F.LAND_SLOPE * 1.25) { this.landed = false; this.steep = true; v.y = 0.8; }
      return;
    }

    // ---- yaw: pedal turns in the hover, wide banked turns at speed
    const rate = F.TURN + (F.TURN_FAST - F.TURN) * smooth(4, 50, sp);
    this.yawRate += (ctl.turn * rate - this.yawRate) * (1 - Math.exp(-dt / F.TURN_TAU));
    this.yaw = wrapPi(this.yaw + this.yawRate * dt);

    // ---- forward airspeed
    const u0 = this.u;
    let u = this.u;
    if (ctl.fwd > 0) u += F.ACC * ctl.fwd * (1 - 0.65 * (Math.max(0, u) / F.MAX_FWD) ** 2) * dt;
    else if (ctl.fwd < 0) u += (u > 0 ? -F.BRAKE : -F.BACK_ACC) * -ctl.fwd * dt;
    else u -= Math.sign(u) * Math.min(Math.abs(u), (F.COAST + F.DRAG * u * u) * dt);
    u = clamp(u, -F.MAX_BACK, F.MAX_FWD);

    // ---- vertical: commanded climb / sink, the ceiling and the ground cushion
    const g0 = ground(p.x, p.z);
    this.groundY = g0;
    const agl = p.y - this.cgH - g0;
    let vyT = lift > 0 ? F.CLIMB * lift : lift < 0 ? F.SINK * lift : 0; // (the autopilot may sink a little faster than -1)
    if (agl > F.AGL_MAX - 80) vyT = Math.min(vyT, (F.AGL_MAX - agl) * 0.12);
    if (vyT < 0 && agl < 9) vyT = Math.max(vyT, -(0.45 + agl * 0.7)); // ground cushion: touch down gently

    // ---- look-out: climb over what's ahead of the nose (and brake when it rises faster than we can
    // climb). Slow, the clearance shrinks to nothing so you can still set down anywhere.
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let need = -Infinity, needT = 1;
    const clear = clamp((sp - 4) * 0.25, 0, 12), nose = this.hull.nose;
    for (let i = 0; i < LOOK.length; i++) {
      const t = LOOK[i];
      if (sp * t < 3) continue;
      const y = ground(p.x + v.x * t + fx * nose[0], p.z + v.z * t + fz * nose[0]) + this.cgH - nose[1] + clear * Math.min(1, t);
      const vy = (y - p.y) / t;
      if (vy > need) { need = vy; needT = t; }
    }
    // near field: a slope rising right in front of the nose or under the rotor ahead -> stop and climb
    if (u > 0 || sp > 0.5) {
      const R = this.hull.rotor;
      const yN = ground(p.x + fx * (nose[0] + 2.5), p.z + fz * (nose[0] + 2.5)) + this.cgH - nose[1] + 0.8;
      const yR = ground(p.x + fx * (R[0] + 1.5), p.z + fz * (R[0] + 1.5)) + this.cgH - R[1] + 1.2;
      const y = Math.max(yN, yR);
      if (y > p.y - 0.5) {
        const vy = Math.min(7, (y - p.y + 0.5) * 2.5 + 1.5);
        if (vy > need) { need = vy; needT = 0.5; }
        if (u > 0) u = Math.max(0, u - F.BRAKE * 1.6 * dt);
      }
    }
    this.climbAssist = 0;
    let vAcc = Math.abs(vyT) < Math.abs(v.y) && vyT * v.y >= 0 ? F.V_STOP : F.V_ACC;
    if (need > vyT) {
      this.climbAssist = clamp(need / 10, 0, 1);
      vyT = Math.min(need, 18);
      vAcc = 16 + 10 / needT;
      if (need > 14) u -= F.BRAKE * clamp((need - 14) / 8, 0, 1.6) * dt * Math.sign(u);
    }
    // a slope too steep to settle on: hold a low hover over it instead
    const steep = agl < 3 && sp < 4 ? this.slopeAt(ground) > F.LAND_SLOPE : false;
    this.steep = steep;
    if (steep) vyT = Math.max(vyT, (1.1 - agl) * 2);
    // somewhere the skids may not go (heli.js sets hold over trees, buildings, nets, lift lines): stay above it
    if (this.hold > 0 && agl < this.hold + 2) vyT = Math.max(vyT, (this.hold - agl) * 1.2);
    v.y += clamp(vyT - v.y, -vAcc * dt, vAcc * dt);

    // ---- horizontal: the path follows the nose with a little drift
    this.u = u;
    const k = 1 - Math.exp(-dt * F.DRIFT);
    v.x += (fx * u - v.x) * k; v.z += (fz * u - v.z) * k;
    this.accel += ((u - u0) / dt - this.accel) * (1 - Math.exp(-dt * 6));

    p.addScaledVector(v, dt);

    // ---- contact: no part of the airframe (skids, nose, tail, rotor tips) goes into the snow, at any height and
    // speed (Oct 29, the user: the rescue helicopter "just went through a mountain": only the centre was kept above
    // the snow up high, so flying fast into a steep face the cabin and rotor slid up through the hillside)
    const g1 = ground(p.x, p.z), skids = g1 + this.cgH;
    const floor = Math.max(skids, this.hullFloor(ground));
    if (p.y <= floor) {
      // ran into a face (not a touchdown): the speed into it goes, so it stops against the slope and climbs
      if (floor - p.y > 0.25 && sp > 3) {
        const kk = Math.exp(-dt * 8);
        v.x *= kk; v.z *= kk; if (this.u > 0) this.u *= kk;
      }
      p.y = floor;
      if (v.y < 0) v.y = 0;
      // settle onto the skids when slow and not climbing (never on a steep slope, nor while the nose,
      // tail or rotor would touch the hillside first)
      if (lift <= 0.05 && sp < 5 && !this.steep && !(this.hold > 0) && floor - skids < 0.5) { // (settled, the frame tilts with the slope: the tail clears)
        this.landed = true; this.u = 0; this.yawRate = 0;
        this.settle(ground, 0);
      }
    }
    this.agl = Math.max(0, p.y - this.cgH - g1);

    // ---- attitude: nose down to speed up, flare to brake, bank into turns, a slight hover wobble
    const t = this.t, sp2 = Math.hypot(v.x, v.z);
    let pitchT = 0.0022 * u + 0.022 * this.accel;
    let rollT = -Math.atan(clamp(sp2 * this.yawRate / G, -0.6, 0.6));
    const lat = v.x * fz - v.z * fx; // drift to the left (+)
    rollT -= clamp(lat * 0.025, -0.12, 0.12);
    const air = smooth(0.2, 3, this.agl);
    pitchT = clamp(pitchT, -0.3, 0.34) + (0.006 * Math.sin(t * 1.3) + 0.004 * Math.sin(t * 2.9 + 1)) * air;
    rollT = clamp(rollT, -0.55, 0.55) + (0.008 * Math.sin(t * 1.1 + 2) + 0.004 * Math.sin(t * 3.3)) * air;
    // just above the snow the skids level with it
    if (this.agl < 1.2) { this.settle(ground, 0); pitchT += (this.landPitch - pitchT) * (1 - this.agl / 1.2); rollT += (this.landRoll - rollT) * (1 - this.agl / 1.2); }
    this.springAttitude(dt, pitchT, rollT, 4.2);
  }

  /** Hard floor after anything else moved it (the soft obstacle push): nothing of the airframe below the snow. */
  clampTerrain(ground) {
    if (this.landed) return;
    const floor = Math.max(ground(this.pos.x, this.pos.z) + this.cgH, this.hullFloor(ground));
    if (this.pos.y < floor) { this.pos.y = floor; if (this.vel.y < 0) this.vel.y = 0; }
  }

  springAttitude(dt, pitchT, rollT, w) {
    [this.pitch, this.pitchV] = spring(this.pitch, this.pitchV, pitchT, w, dt);
    [this.roll, this.rollV] = spring(this.roll, this.rollV, rollT, w, dt);
  }

  // lowest centre-of-mass height at which nose, tail, stabilizer and rotor tips all clear the snow
  hullFloor(ground) {
    const p = this.pos, H = this.hull, c = this.cgH;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const at = (a, b, up) => ground(p.x + fx * a + fz * b, p.z + fz * a - fx * b) + c - up;
    let y = Math.max(at(H.nose[0], 0, H.nose[1]), at(H.tail[0], 0, H.tail[1]), at(H.stab[0], H.stab[1], H.stab[2]), at(H.stab[0], -H.stab[1], H.stab[2]));
    const r = H.rotor[0];
    for (let k = 0; k < 6; k++) {
      const a = this.yaw + (k * Math.PI) / 3;
      y = Math.max(y, ground(p.x + Math.sin(a) * r, p.z + Math.cos(a) * r) + c - H.rotor[1]);
    }
    return y;
  }

  slopeAt(ground) {
    const p = this.pos, e = 2.5;
    const gx = (ground(p.x + e, p.z) - ground(p.x - e, p.z)) / (2 * e), gz = (ground(p.x, p.z + e) - ground(p.x, p.z - e)) / (2 * e);
    return Math.hypot(gx, gz);
  }

  updateQuat() {
    this._e.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.quat.setFromEuler(this._e);
  }
}

/**
 * The pilot who flies the helicopter home after you jump out: climb away, cruise on a glide path that
 * ends over the pad, hover, turn to the parking heading and set down. update() returns the controls.
 */
export class HomePilot {
  constructor(flight) {
    this.f = flight;
    this.phase = 'idle';
    this.t = 0;
    this.out = { fwd: 0, turn: 0, lift: 0 };
    this.goal = { x: 0, z: 0, y: 0, agl: 30, speed: 80, stop: 0.7, yaw: undefined, decel: 3.3 };
  }

  /** pad: { x, z, y (deck height), yaw } */
  home(pad, wait = 1.2) { this.pad = pad; this.phase = 'depart'; this.t = -wait; }

  update(dt) {
    const f = this.f, pad = this.pad, o = this.out, g = this.goal;
    this.t += dt;
    const d = Math.hypot(pad.x - f.pos.x, pad.z - f.pos.z);
    const padY = pad.y + f.cgH;
    g.x = pad.x; g.z = pad.z; g.yaw = undefined; g.y = undefined; g.agl = undefined; g.decel = 2.2;
    if (this.phase === 'depart') {
      // the skier is still right below: hover a moment, then lift straight up, turning for home
      o.fwd = -f.u * 0.4;
      o.turn = this.t < 0 ? 0 : clamp(wrapPi(Math.atan2(pad.x - f.pos.x, pad.z - f.pos.z) - f.yaw) * 2, -1, 1);
      o.lift = this.t < 0 ? 0 : 1;
      if (this.t > 0 && f.agl > 16) this.phase = 'transit';
      return o;
    }
    if (this.phase === 'transit') {
      // a glide path down to the pad (1:5.5), never below 35 m over whatever is underneath
      g.y = Math.max(f.groundY + f.cgH + 35, padY + 20 + Math.max(0, d - 150) / 5.5);
      // high above the path (a ridge pushed us up): slow down so the descent still ends over the pad
      const high = f.pos.y - g.y;
      g.speed = high > 25 ? clamp((12 * Math.max(0, d - 120)) / high, 18, 80) : 80; g.stop = 0.7; g.decel = 4.5;
      autopilot(f, g, o);
      if (d < 0.9 && f.speed < 0.6) this.phase = 'align';
      return o;
    }
    if (this.phase === 'align') {
      g.agl = 18; g.yaw = pad.yaw; g.stop = 4;
      autopilot(f, g, o);
      if (Math.abs(wrapPi(pad.yaw - f.yaw)) < 0.04) this.phase = 'down';
      return o;
    }
    if (this.phase === 'down') {
      g.y = padY - 1; g.yaw = pad.yaw; g.stop = 4;
      autopilot(f, g, o);
      o.lift = clamp((padY - 1 - f.pos.y) * 0.05, -1.3, 0); // a brisk descent, the ground cushion sets it down
      if (f.landed) this.phase = 'landed';
      return o;
    }
    o.fwd = 0; o.turn = 0; o.lift = 0;
    return o;
  }
}

/**
 * Autopilot: controls that fly toward a point. Returns ctl ({ fwd, turn, lift }) written into `out`.
 * @param {Flight} f
 * @param {{x: number, z: number, y?: number, agl?: number, speed?: number, yaw?: number, stop?: number}} goal
 *   y: absolute height of the centre of mass to hold (or agl: height above the ground), speed: cruise speed,
 *   stop: distance at which to be stopped (then turn to goal.yaw)
 */
export function autopilot(f, goal, out = { fwd: 0, turn: 0, lift: 0 }) {
  const p = f.pos, dx = goal.x - p.x, dz = goal.z - p.z, d = Math.hypot(dx, dz);
  const stop = goal.stop ?? 1.2;
  let yD = goal.y !== undefined ? goal.y : f.groundY + f.cgH + (goal.agl ?? 30);
  // terrain look-ahead: never below the hills ahead (and the trees on them) on the way to the goal
  const T = terrainAhead(f, goal.x, goal.z, d);
  yD = Math.max(yD, T.y);
  // speed: cruise, slowing down so we can stop at the goal (v^2 = 2 a s, gently: 2.2 m/s^2 unless told otherwise)
  // (the path lags the nose a little: start braking that much earlier); slower still when a ridge ahead needs
  // more climb than there is room for at this speed
  const lead = Math.hypot(f.vel.x, f.vel.z) * 0.6;
  const uD = d < stop ? 0 : Math.min(goal.speed ?? 70, T.u, Math.sqrt(2 * (goal.decel ?? 3.3) * Math.max(0, d - stop - lead)) + 0.4);
  // there: hold the spot and turn to the parking heading
  const want = d < stop && goal.yaw !== undefined ? goal.yaw : Math.atan2(dx, dz);
  const err = wrapPi(want - f.yaw);
  out.turn = clamp(err * 2.4, -1, 1);
  // only push forward when roughly facing the goal
  const facing = Math.cos(err);
  out.fwd = clamp((uD * Math.max(0, facing) - f.u) * 0.6, -1, 1);
  out.lift = clamp((yD - p.y) * 0.18, -1, 1);
  return out;
}

// The autopilot's look-out (Oct 29, the user: the rescue helicopter flew home "through a mountain"): samples the
// ground every 20 m along the track to the goal (and along where it is actually heading) out to 250..600 m, and
// returns the height to hold so it passes ~90 m over every ridge (trees and buildings included), the clearance
// tapering to 35 m over the last stretch so the descent to a landing spot stays above the terrain too; inside 30 m
// of the goal the goal's own height rules (the vertical let-down over the pad / the pick-up spot). u: the most
// airspeed that still leaves time to climb over the highest point ahead (~13 m/s up).
const _T = { y: -Infinity, u: Infinity };
const CLIMB_RATE = 13, STEP = 20;
export function terrainAhead(f, gx, gz, d) {
  _T.y = -Infinity; _T.u = Infinity;
  const gr = f.groundFn;
  if (!gr) return _T;
  const p = f.pos, sp = Math.hypot(f.vel.x, f.vel.z);
  const range = clamp(sp * 7, 250, 600);
  const need = (x, z, s, left) => {
    const y = gr(x, z) + f.cgH + 35 + Math.min(55, Math.max(0, left - 30) * 0.3);
    if (y > _T.y) _T.y = y;
    const rise = y - p.y;
    if (rise > 0) _T.u = Math.min(_T.u, Math.max(9, (CLIMB_RATE * s) / rise));
  };
  if (d > 30) {
    const ux = (gx - p.x) / d, uz = (gz - p.z) / d;
    for (let s = STEP; s <= range && d - s > 30; s += STEP) need(p.x + ux * s, p.z + uz * s, s, d - s);
  }
  // where it is heading now (turning toward the goal, the path is not yet on the track)
  if (sp > 4 && d > 60) {
    const vx = f.vel.x / sp, vz = f.vel.z / sp, r = Math.min(range, sp * 4, d - 30);
    for (let s = STEP; s <= r; s += STEP) {
      const x = p.x + vx * s, z = p.z + vz * s;
      need(x, z, s, Math.hypot(gx - x, gz - z));
    }
  }
  return _T;
}
