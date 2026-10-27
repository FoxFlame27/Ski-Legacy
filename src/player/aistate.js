// AI skiers' animation state. Race bots (modes/race/bots.js) and the resort's skiers
// (game/npcs.js) ski on the player's procedural rig (player/skier.js). The player's controller turns input and
// physics into the rig's state (player.js animateSki); an AI has no input, so this derives the same state from
// how the AI skier actually moves, in the player's ranges:
//  - inclination / edge from the lateral acceleration of its path (speed x turn rate): -atan(aLat / g) x 0.85
//  - crouch: the athletic stance, a little lower with the edge angle, speed and a steep pitch; the tuck on fast
//    straights; compressing before a kicker, extending at the lip, the legs soaking up landings (the player's spring)
//  - snowplough when braking slowly, a skidded speed check / hockey stop at speed
//  - pole plants at the turn transitions (inside pole of the new turn), double-pole pushes out of a start, across
//    flats and now and then in a tuck
//  - a seeded style per skier (makeStyle): stance width, crouch depth, lean, arm carriage, pole timing and firmness,
//    turn rhythm, from relaxed cruisers to aggressive racers, beginners in a snowplough to carving experts
import * as THREE from 'three';
import { clamp, lerp, mulberry32 } from '../core/noise.js';

const G = 9.81;
const UP = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3(), _r = new THREE.Vector3();
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
const ek = (h, r) => 1 - Math.exp(-h * r);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * A skier's look and habits, from a seed.
 * @param {number} seed
 * @param {'racer'|'beginner'|'intermediate'|'expert'} kind
 * @returns {object} style: `agg` 0 relaxed cruiser .. 1 aggressive racer; the rig reads stance / arm* / plant* /
 *   sway (SkierRig.aiStyle), the animator the rest; Tp / aPk / maxV / skidTurn are the resort skiers' turn rhythm,
 *   cruising speed and skidding (game/npcs.js).
 */
export function makeStyle(seed, kind = 'racer') {
  const r = mulberry32((seed >>> 0) || 1);
  const u = (a, b) => a + (b - a) * r();
  const beginner = kind === 'beginner';
  // relaxed cruiser (0) .. aggressive racer (1)
  const agg = kind === 'racer' ? u(0.35, 1) : kind === 'expert' ? u(0.45, 1) : kind === 'intermediate' ? u(0, 0.6) : u(0, 0.2);
  const S = {
    kind, agg, seed,
    // crouch depth added to the player's targets (aggressive: lower; beginners: upright)
    crouch: beginner ? u(-0.03, 0.01) : lerp(-0.03, 0.07, agg) + u(-0.02, 0.02),
    // inclination: share of the player's lean for the same turn
    lean: beginner ? u(0.45, 0.6) : lerp(0.8, 1.08, agg) * u(0.96, 1.04),
    edgeRate: beginner ? u(5, 7) : lerp(7, 12, agg),
    // stance width (m added to each foot's offset) and arm carriage (m: hands forward / up / out)
    stance: (beginner ? 0.035 : 0) + u(-0.006, 0.026),
    armF: (beginner ? 0.02 : lerp(-0.03, 0.055, agg)) + u(-0.015, 0.015),
    armU: (beginner ? 0.035 : lerp(-0.025, 0.035, agg)) + u(-0.015, 0.015),
    armO: (beginner ? 0.09 : (1 - agg) * 0.03) + u(-0.01, 0.04),
    // pole plants: lateral acceleration (m/s^2) of the new turn at which the plant fires (low = early) plus a
    // delay; how far the hand reaches and how long the basket stays in; how often a turn gets a plant at all
    plantThr: u(1.8, 4.5), plantDelay: u(0, 0.09),
    plantReach: (beginner ? 0.6 : lerp(0.75, 1.25, agg)) * u(0.9, 1.1),
    plantDur: lerp(1.15, 0.85, agg) * u(0.92, 1.08),
    plantProb: beginner ? 0.12 : lerp(0.6, 1, agg),
    pushEvery: u(0.5, 0.68), // double-pole cadence (s)
    tuckV: lerp(16, 11.5, agg) + u(-0.5, 0.5), // a visual tuck above this (where the caller doesn't decide)
    sway: beginner ? u(1.3, 1.8) : u(0.7, 1.4), // balance corrections
    look: u(0.08, 0.22), // head into the turn
    plow: beginner ? u(0.45, 0.8) : 0, // a beginner's standing snowplough
  };
  // resort skiers: turn rhythm, a turn pair every Tp seconds at the cruising speed maxV (m/s) with a peak lateral
  // acceleration aPk (m/s^2): short swings or long turns; beginners' slow traverses. skidTurn: how far the skis
  // come round past the path in a skidded turn (rad; experts carve)
  const expert = kind === 'expert';
  const short = r() < (expert ? 0.45 : kind === 'intermediate' ? 0.3 : 0);
  if (beginner) { S.Tp = u(9, 13); S.aPk = u(1.5, 2.5); S.maxV = u(4, 6); }
  else if (short) { S.Tp = expert ? u(1.5, 2.1) : u(1.8, 2.4); S.aPk = expert ? u(9, 13) : u(6, 9); S.maxV = expert ? u(8, 11) : u(6.5, 9); }
  else { S.Tp = expert ? u(3.2, 4.6) : u(3.6, 5.2); S.aPk = expert ? u(8, 13) : u(5, 8); S.maxV = expert ? u(12, 17) : u(8, 12); }
  S.short = short;
  S.skidTurn = kind === 'intermediate' ? u(0.1, 0.28) : expert ? u(0, 0.06) : 0;
  return S;
}

/**
 * Per-skier animator: feed it the skier's motion each pose solve, pass the result to rig.update(dt, st).
 * Also fires the rig's pole plants (call after rig.root is at the skier's position).
 */
export class AISkierAnim {
  constructor(rig, style) {
    this.rig = rig;
    this.style = style;
    if (rig) rig.aiStyle = style; // stance, arm carriage, pole plants, sway (SkierRig.poseSki)
    this.rnd = mulberry32(((style?.seed ?? 7) * 31 + 11) >>> 0);
    this.st = { mode: 'ski', heading: 0, speed: 0, crouch: 0.2, lean: 0, edge: 0, tuck: false, plow: 0, skid: 0, normal: UP, air: false, charge: 0, lookYaw: 0 };
    this.reset();
  }

  /** Teleports, a new run: no stale turn rates, springs or plants. */
  reset() {
    this.edge = 0; this.lean = 0; this.crouch = 0.2 + (this.style?.crouch || 0); this.plow = this.style?.plow || 0; this.skid = 0;
    this.absorb = 0; this.absorbV = 0; this.prevH = null; this.rate = 0; this.side = 0; this.pending = null;
    this.pushT = 0.1; this.pushAge = 9; this.tuckPoleT = 0.8 + this.rnd(); this.wasAir = false; this.popT = 9;
    this.t = this.rnd() * 50; this.look = 0; this.skidSide = 1; this.sideslip = 0; this.hiPoles = null; this.tuckT = 0; this.tuckOn = false;
  }

  /**
   * @param {number} dt  seconds since the last solve (reduced-rate LOD steps welcome)
   * @param {object} m   the skier's motion: heading (ski / travel direction), speed (m/s), normal (snow), air,
   *   and optionally: aLat (lateral acceleration, + curving left; else from the heading's turn rate), edgeAdd
   *   (edge wobble), brake (0..1 slowing intent), stop (braking to a standstill: a full hockey stop), skidYaw
   *   (an explicit, already smoothed skid yaw), plow (explicit wedge 0..1), tuck (the caller's tuck), push
   *   (skating / double-poling to get going), pre (compression before a kicker), impact (m/s of a landing seen
   *   as air -> snow) or land (the caller's own landing events: m/s this solve, 0 if none),
   *   waiting (1 in a start area, 2 set in the gate), stopped (standing still), lookYaw (head), camDist
   *   (camera distance: pole detail)
   */
  update(dt, m) {
    const S = this.style, st = this.st, rig = this.rig;
    const h = clamp(dt, 0, 0.25);
    this.t += h;
    const sp = Math.max(0, m.speed || 0);
    const air = !!m.air;
    // lateral acceleration: the caller's, or the heading's turn rate x speed
    let aLat = m.aLat;
    if (this.prevH === null || h <= 0) this.prevH = m.heading;
    const rate = h > 0 ? wrap(m.heading - this.prevH) / h : 0;
    this.prevH = m.heading;
    this.rate += (clamp(rate, -4, 4) - this.rate) * ek(h, 10);
    if (aLat === undefined) aLat = this.rate * sp;
    if (air) aLat = 0;
    const brake = air ? 0 : clamp(m.brake || 0, 0, 1);

    // ---- snowplough: a beginner's wedge (gone at speed), snowplough braking when slow
    const plowT = m.plow ?? Math.max(S.plow * (1 - smooth(7, 10, sp)), brake * (1 - smooth(6, 9, sp)));
    this.plow += (plowT - this.plow) * ek(h, 6);
    // ---- skid: the caller's (mistakes, finish stops), or a check at speed: a full hockey stop when stopping
    if (m.skidYaw !== undefined) this.skid = m.skidYaw;
    else {
      if (Math.abs(aLat) > 2) this.skidSide = Math.sign(aLat);
      const skidT = this.skidSide * brake * smooth(4.5, 9, sp) * (m.stop ? 1.05 : 0.45) * (1 - this.plow);
      this.skid += (skidT - this.skid) * ek(h, 7);
    }
    // ---- inclination like the player's, x the style's lean; leaning back against a hockey stop; flatter in a wedge
    let edgeT = air ? 0 : clamp(-Math.atan2(aLat, G) * 0.85 * S.lean + (m.edgeAdd || 0), -0.95, 0.95);
    const hockey = clamp(Math.abs(this.skid) / 1.05, 0, 1);
    if (hockey > 0.05) edgeT += (-Math.sign(this.skid) * 0.45 - edgeT) * hockey;
    edgeT *= 1 - 0.55 * this.plow;
    this.edge += (edgeT - this.edge) * ek(h, S.edgeRate);
    this.lean = clamp(this.edge / 0.8, -1, 1);

    // ---- crouch (the player's ranges, see player.js animateSki)
    const n = m.normal || UP;
    const pitch = Math.hypot(n.x, n.z) / Math.max(0.3, n.y);
    // the tuck: the caller's, or on fast straights (held a moment, and kept through small corrections, so turn
    // transitions never flicker it)
    if (m.tuck === undefined) {
      const want = sp > S.tuckV && Math.abs(aLat) < 2.5 && brake < 0.05 && this.plow < 0.2;
      this.tuckT = want ? this.tuckT + h : 0;
      if (!this.tuckOn && this.tuckT > 0.6) this.tuckOn = true;
      else if (this.tuckOn && (sp < S.tuckV - 1.5 || Math.abs(aLat) > 4.5 || brake > 0.05)) this.tuckOn = false;
    }
    const tuck = !air && !m.waiting && !m.stopped && (m.tuck ?? this.tuckOn);
    let crouchT = 0.16 + S.crouch + Math.abs(this.edge) * 0.13 + 0.035 * smooth(8, 20, sp) + 0.03 * smooth(0.2, 0.55, pitch);
    if (tuck) crouchT = 0.21 + S.crouch * 0.5;
    crouchT = lerp(crouchT, 0.3 + S.crouch * 0.5, brake);
    if (air && !this.wasAir) this.popT = 0; // the lip: legs extend
    this.popT += h;
    if (air) crouchT = 0.32;
    crouchT += m.pre || 0;
    const extend = this.popT < 0.16;
    if (extend) crouchT = -0.15;
    if (m.waiting) crouchT = m.waiting === 2 ? 0.46 + S.crouch * 0.5 : 0.24 + S.crouch * 0.5;
    else if (m.stopped) crouchT = 0.13 + S.crouch * 0.3;
    // a double-pole stroke folds the body a little as the arms push
    this.pushAge += h;
    const pushEnv = this.pushAge < 0.55 ? Math.sin((this.pushAge / 0.55) * Math.PI) : 0;
    crouchT += 0.09 * pushEnv * (S.agg * 0.6 + 0.4);
    this.crouch += (crouchT - this.crouch) * ek(h, extend ? 26 : 7);
    // landings: the legs soak up the impact (the player's spring, sub-stepped for reduced-rate solves)
    const land = m.land !== undefined ? m.land : !air && this.wasAir ? m.impact ?? 3 : 0; // (m.land: the caller's landings)
    if (land > 0) this.absorbV += Math.min(14, land * 1.3);
    for (let k = 0, nS = Math.max(1, Math.ceil(h * 90)), hs = h / nS; k < nS; k++) {
      this.absorbV += (-60 * this.absorb - 15.5 * this.absorbV) * hs;
      this.absorb = clamp(this.absorb + this.absorbV * hs, 0, 0.8);
      if (this.absorb === 0 && this.absorbV < 0) this.absorbV = 0;
    }

    // ---- poles
    if (rig?.poles?.length) {
      const f = _f.set(Math.sin(m.heading), 0, Math.cos(m.heading)), rt = _r.crossVectors(f, UP);
      // a plant at each new turn: the inside pole (turning left -> left pole), as the new turn's edges bite
      const thr = S.plantThr;
      const side = Math.abs(aLat) > thr ? Math.sign(aLat) : Math.abs(aLat) < thr * 0.45 ? 0 : this.side;
      if (side !== 0 && side !== this.side && sp > 3 && !air && !tuck && Math.abs(this.skid) < 0.3 && !m.waiting && this.rnd() < S.plantProb) {
        this.pending = { side, t: S.plantDelay };
      }
      this.side = side;
      if (this.pending && (this.pending.t -= h) <= 0) {
        if (!air) rig.startPolePlant(this.pending.side > 0 ? 0 : 1, f, rt);
        this.pending = null;
      }
      // double-pole pushes: getting going (start, flats, after a stop), and now and then in a slow tuck
      if (m.push && !air && !m.waiting && sp < 9.5) {
        this.pushT -= h;
        if (this.pushT <= 0) {
          this.pushT = S.pushEvery * (1 + 0.04 * sp);
          rig.startPolePlant(0, f, rt); rig.startPolePlant(1, f, rt);
          this.pushAge = 0;
        }
      } else this.pushT = Math.min(this.pushT, 0.12); // the first push comes right away
      if (tuck && !air && sp < 15 && brake < 0.05) {
        this.tuckPoleT -= h;
        if (this.tuckPoleT <= 0) {
          this.tuckPoleT = 1.6 + this.rnd() * 1.4;
          rig.startPolePlant(0, f, rt); rig.startPolePlant(1, f, rt);
          this.pushAge = 0;
        }
      } else this.tuckPoleT = 0.6 + this.rnd() * 0.8;
      // pole detail by camera distance (the full model near the camera, a light one beyond)
      if (m.camDist !== undefined && rig.setPoleDetail) {
        const hi = m.camDist < (this.hiPoles ? 30 : 24);
        if (hi !== this.hiPoles) { this.hiPoles = hi; rig.setPoleDetail(hi); }
      }
    }

    // ---- head: a little into the turn; waiting in a start area it looks about now and then
    let lookT = m.lookYaw ?? clamp((aLat / Math.max(sp, 4)) * S.look * 4, -0.3, 0.3);
    if (m.waiting === 1 && m.lookYaw === undefined) lookT = 0.35 * Math.sin(this.t * 0.37) * smooth(0.2, 0.7, Math.abs(Math.sin(this.t * 0.13)));
    this.look += (lookT - this.look) * ek(h, m.lookYaw !== undefined ? 4 : 3);

    this.wasAir = air;
    // snow FX: skidding, the wedge, carving
    this.sideslip = Math.max(Math.abs(this.skid) * 0.9, this.plow * 0.4, 0.04 + Math.abs(this.lean) * 0.08);

    st.heading = m.heading;
    st.speed = sp;
    st.crouch = clamp(this.crouch + this.absorb, -0.2, 1.1);
    st.edge = this.edge;
    st.lean = this.lean;
    st.tuck = tuck;
    st.plow = this.plow;
    st.skid = this.skid;
    st.normal = air ? UP : n;
    st.air = air;
    st.lookYaw = this.look;
    return st;
  }
}
