// Running into people in free ride (the player: src/player/player.js collide; game/snowmobile.js; game/drive.js):
//  - skiing into somebody at 15+ km/h knocks you both over: your own tumble and get-up (a 'bump' event, not a
//    wipeout: no strike, no rescue helicopter), they tumble, lie a moment, get up and carry on; you pay a fine
//    that grows with the speed. Slower than that: the old soft bump.
//  - running into somebody on foot: they stumble, a small fine
//  - a snowmobile / car hitting somebody: they fall, a bigger fine; the vehicle just bumps (its own code)
//  - (Oct 29, the user: "the people should also get hit realistic") a vehicle hit is a throw, scaled by the speed
//    (launchFor): lifted off the snow in a ballistic arc (~0.3 m up at 15 km/h, ~2 m and ~10 m along at 50, ~3.4 m
//    and ~20 m at 90), somersaulting backward (the legs taken out, the head toward the vehicle) with a twist, a
//    bounce where they land (a thud, a puff of snow: landed()), tumbling on along the snow to a stop; they lie a
//    while (several seconds; 60+ km/h: 8-12 s) and get up slowly. Below ~8 km/h it's the old fall / stumble.
//  - traffic, the ski buses, the ploughs, the tow truck running into somebody (game/vehiclehits.js): the same throw,
//    source 'traffic' (no fine: not your doing)
//  - (Oct 31 2026, the user: "on single player the NPC you crash into has a really bad getting-hit animation" and "the
//    bot getting hit just falls over, that's a very bad animation. Use the same animation as in multiplayer on real
//    people") the village's walking people (an instanced crowd: world/peoplesim.js) tipped over stiff as a plank. Near
//    you they are now posed by a real rig on the same character (crowdFall below): the player's own wipeout as a
//    remote player's avatar shows it (player/skier.js poseFall / placeFallen, driven by newFall / stepFall like the
//    NPC skiers and villagers): thrown along the car's line, the arms and legs flailing in the air (stepFall's fl, the
//    rig's st.flail), a bounce and a slide on the snow (world.groundHeight under every limb), a couple of seconds on
//    the snow (launchFor lie), rolled off the side and pushed up through a crouch, a shake of the head, on their way.
//    The car that hit them is a wall too (keepClear: never driven through), and so are the walls and lamps about.
// One fine per incident (a few seconds' cooldown); the balance may go below zero, like the rescue fee.
// Races and World Racing sessions keep the soft bump (enabled() is false there).
//
// People are the entries of npcs.near (game/npcs.js): an NPC skier's / villager's position vector (its record in
// `.who`) or an instanced crowd person (world/peoplesim.js, its simulation in `.sim`).
//
// For other code (cars: game/drive.js):
//   import { knockPerson, peopleNear } from './peoplehits.js';
//   for (const p of peopleNear(x, z, 3)) if (<the car touches p.x, p.z>) knockPerson(p, closingSpeed, 'car', dirX, dirZ);
import { save, writeSave } from './economy.js';
import { PeopleSim } from '../world/peoplesim.js';
import { burst } from '../fx/snowfx.js';
import * as THREE from 'three';
import { SkierRig } from '../player/skier.js';
import { world } from '../world/world.js';
import { away } from '../world/peoplesim.js';

const TAU = Math.PI * 2;
const G = 9.81;
export const SKI_KNOCK = 15 / 3.6;  // m/s: skiing into somebody faster than this knocks you both over
const VEHICLE_KNOCK = 2;            // m/s: a vehicle hitting somebody faster than this knocks them over (slower: a stumble)
const FOOT_RUN = 3;                 // m/s closing speed on foot (you move at 4.2): a stumble and a small fine
const COOLDOWN = 5000;              // ms: one fine per incident
// fines: $ per km/h of impact speed, rounded to $10, between min and max
const FINES = {
  ski: { perKmh: 5, min: 50, max: 400 },
  foot: { perKmh: 0, min: 20, max: 20 },
  snowmobile: { perKmh: 10, min: 150, max: 900 },
  car: { perKmh: 12, min: 200, max: 1500 },
  traffic: { perKmh: 0, min: 0, max: 0 }, // (somebody else's vehicle: no fine)
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const NONE = [];
const DOWN = { fell: false, fine: 0, down: true }; // (already on the snow / flying: the vehicle passes, no bump)

let ctx = null; // { player, npcs, hud, audio, spray, enabled: (source) => boolean }
let lastFine = -1e9;

/** main.js: wire it up once the player and the NPCs exist. */
export function initPeopleHits(o) {
  ctx = o;
  PeopleSim.onLand = landed; // (the instanced crowd's people landing from a throw)
  PeopleSim.ragdoll = crowdFall; // (and posed by a rig while they're down: crowdFall)
}

/**
 * A vehicle's throw at impact speed `speed` (m/s), into `out` (reused): vh the speed along the push (m/s), vy the
 * launch upward (m/s), spin the somersault (rad/s, - = backward: the head goes toward the vehicle), twist a roll
 * about the throw's line (rad/s), lie how long they stay down (s), up how long getting up takes (s).
 */
export function launchFor(speed, out = {}) {
  const kmh = speed * 3.6, R = Math.random();
  out.vy = Math.sqrt(2 * G * clamp((kmh - 8) * 0.045, 0, 3.4)); // apex: 0.3 m at 15 km/h, 1.9 at 50, 3.4 at 90+
  out.vh = Math.min(10, 1.2 + speed * 0.36);
  out.spin = -clamp(speed * 0.3, 2, 8) * (0.8 + Math.random() * 0.4);
  out.twist = (Math.random() - 0.5) * clamp(speed * 0.15, 0.5, 3);
  // (Oct 31 2026: "lie there for ~2-3 s, then get up": 1.6-2.4 s from a nudge, up to ~3.5 s from a hard hit)
  out.lie = kmh < 25 ? 1.6 + R * 0.8 : 2.2 + clamp((kmh - 25) / 50, 0, 1) * 0.8 + R * 0.6;
  out.up = kmh < 25 ? 1.35 : kmh < 60 ? 1.8 : 2.4;
  return out;
}
const _launch = {};

const _bv = { x: 0, z: 0 }, _be = { type: 'impact', x: 0, y: 0, z: 0, amount: 0 };
/**
 * Somebody thrown landed on the snow at (x, y, z) at `imp` m/s down (npcs.js, world/peoplesim.js): a puff of snow and
 * a thud (quieter further from you).
 */
export function landed(x, y, z, imp, vx = 0, vz = 0) {
  try {
    if (!ctx || !(imp > 1)) return;
    const p = ctx.player?.pos, d = p ? Math.hypot(x - p.x, z - p.z) : 0, att = clamp(1 - d / 60, 0, 1);
    const a = clamp(imp / 8, 0.25, 1);
    puff(x, y, z, a, vx, vz, d);
    if (att > 0.05) ctx.audio?.play?.('thud', a * att);
  } catch { /* (a missed puff is fine) */ }
}
// a puff of snow at (x, y, z), size a (0..1), drifting (vx, vz); d: how far from you (none past 120 m)
function puff(x, y, z, a, vx = 0, vz = 0, d = 0) {
  if (!ctx?.spray || d > 120) return;
  _be.x = x; _be.y = y; _be.z = z; _be.amount = a; _bv.x = vx; _bv.z = vz;
  burst(ctx.spray, _be, _bv);
}

/** The fine for an impact at `speed` (m/s) by `source` ('ski' | 'foot' | 'snowmobile' | 'car'). */
export function fineFor(source, speed) {
  const F = FINES[source] || FINES.car;
  return Math.round(clamp(speed * 3.6 * F.perKmh, F.min, F.max) / 10) * 10;
}

/** Everybody near the player who can be bumped into (positions: .x .y .z), the live list (don't keep it). */
export function people() {
  try { return ctx?.npcs?.near || NONE; } catch { return NONE; }
}
/** The people within r metres of (x, z) (a new array, or `out`). */
export function peopleNear(x, z, r, out = []) {
  for (const p of people()) if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r) out.push(p);
  return out;
}

// the person behind a near-list entry and whoever moves them (NPCs or a crowd simulation)
function target(c) {
  if (!c) return null;
  if (c.who && ctx?.npcs) return { o: c.who, by: ctx.npcs };
  if (c.sim) return { o: c, by: c.sim };
  return null;
}
function velOf(o) {
  if (o.vel) return o.vel; // NPC skier
  const h = o.heading ?? o.yaw ?? 0, v = o.speed ?? o.v ?? 0;
  return { x: Math.sin(h) * v, z: Math.cos(h) * v };
}

function charge(amount, what) {
  const now = performance.now();
  if (!amount || now - lastFine < COOLDOWN) return 0;
  lastFine = now;
  save.money -= amount;
  writeSave();
  ctx.hud?.setMoney?.(save.money, -amount);
  ctx.audio?.play?.('cash');
  ctx.hud?.flash?.(`${what} · fine -$${amount}`, 'bad', 3000);
  return amount;
}

/**
 * Knock a person over (or make them stumble when it's slow) and fine the player. For vehicles: the caller does its
 * own bump. Safe to call every frame of a contact: somebody already on the snow is ignored.
 * @param {object} person  an entry of npcs.near / peopleNear()
 * @param {number} impactSpeed  closing speed (m/s)
 * @param {'ski'|'foot'|'snowmobile'|'car'|'traffic'} source  ('traffic': somebody else's vehicle, no fine)
 * @param {number} [dirX] @param {number} [dirZ]  the push (default: away from the player)
 * @param {object} [col]  the vehicle's box collider ({x, z, hw, hd, rot}, kept up to date by its owner): the thrown body
 *   is kept out of it (keepClear) 
 * @returns {{fell: boolean, fine: number, down?: true}|null}  null: ignored (people hits off, not a person); down:
 *   they're already on the snow / in the air (no new hit, and no bump either)
 */
export function knockPerson(person, impactSpeed, source = 'car', dirX, dirZ, col = null) {
  try {
    if (!ctx || !ctx.enabled(source)) return null;
    const t = target(person);
    if (!t) return null;
    if (t.o.down) {
      const stumbling = t.o.down.stumble || t.o.down.fall === false;
      if (!stumbling) return DOWN;
      if (source === 'ski' || source === 'foot') return null; // (a stumble plays out; a vehicle knocks them over)
    }
    let dx = dirX, dz = dirZ;
    if (!Number.isFinite(dx) || !Number.isFinite(dz) || dx * dx + dz * dz < 1e-8) {
      const p = ctx.player.pos;
      dx = person.x - p.x; dz = person.z - p.z;
    }
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const sp = Math.max(0, +impactSpeed || 0);
    if (source === 'foot') {
      t.by.stumble(t.o, dx, dz);
      return { fell: false, fine: charge(fineFor('foot', sp), 'Bumped into someone') };
    }
    if (sp < (source === 'ski' ? SKI_KNOCK : VEHICLE_KNOCK)) { t.by.stumble(t.o, dx, dz); return { fell: false, fine: 0 }; }
    // a vehicle: thrown (launchFor), with the thud of the hit (quieter further from you: traffic hits anywhere near)
    const L = source === 'ski' ? null : launchFor(sp, _launch);
    t.by.knock(t.o, dx, dz, sp, L, L ? col : null);
    if (L) {
      const p = ctx.player?.pos, pd = p ? Math.hypot(person.x - p.x, person.z - p.z) : 0, att = clamp(1 - pd / 60, 0, 1);
      // (Oct 31 2026: "a short impact sound and snow puff": the snow kicked up off the boots where they're hit)
      puff(person.x, Number.isFinite(person.y) ? person.y : world.groundHeight(person.x, person.z), person.z, clamp(sp / 14, 0.3, 0.9), dx * sp * 0.4, dz * sp * 0.4, pd);
      if (att > 0.05) {
        ctx.audio?.play?.('thud', clamp(sp / 16, 0.35, 1) * att);
        if (sp > 11) ctx.audio?.impact?.('car', clamp((sp - 8) / 40, 0.12, 0.45) * att); // (a dent at 40+ km/h)
      }
    }
    const fine = source === 'traffic' ? 0 : charge(fineFor(source, sp), 'Collision');
    return { fell: true, fine };
  } catch (e) {
    console.warn('knockPerson', e);
    return null;
  }
}

/**
 * The player touched a person (player.collide; n = from the person to the player). true: handled here (you fell),
 * so no soft bump; false: the old soft bump.
 */
export function playerHitPerson(c, nx, nz) {
  try {
    if (!ctx || !ctx.enabled('ski')) return false;
    const pl = ctx.player, t = target(c);
    if (!t || t.o.down) return false;
    const ov = velOf(t.o);
    const rvx = pl.vel.x - ov.x, rvz = pl.vel.z - ov.z, rel = Math.hypot(rvx, rvz);
    const closing = -(rvx * nx + rvz * nz);
    if (pl.mode === 'ski') {
      if (rel < SKI_KNOCK || closing < 0.25 * rel) return false; // slow, or only brushing past
      // they go over, pushed along your line and away from you
      let px = (rvx / rel) * 0.7 - nx * 0.3, pz = (rvz / rel) * 0.7 - nz * 0.3;
      const pll = Math.hypot(px, pz) || 1;
      px /= pll; pz /= pll;
      t.by.knock(t.o, px, pz, rel);
      // ...and so do you: your own tumble and get-up, a 'bump' (main.js counts no strike for it)
      pl.vel.multiplyScalar(0.55);
      pl.crash(Math.random() < 0.5 ? -1 : 1, { kind: rel > 9 ? 'roll' : 'slam', event: 'bump' });
      charge(fineFor('ski', rel), 'Collision');
      return true;
    }
    if (pl.mode === 'walk' && closing > FOOT_RUN) {
      // running straight into somebody: they stumble, you're bounced back (the soft bump) with a jolt
      t.by.stumble(t.o, -nx, -nz);
      pl.shake = Math.max(pl.shake || 0, 0.35);
      charge(fineFor('foot', closing), 'Bumped into someone');
    }
  } catch (e) {
    console.warn('playerHitPerson', e);
  }
  return false;
}

// ------------------------------------------------------------------ a rig person's fall (NPC skiers, villagers)
// The same states as the player's crash (player.js updateFall), without the physics: topple / roll onto the side,
// lie a moment, get up through a crouch. The rig's 'fall' mode draws it (fall.ball / getUp / pitch / roll).
// Thrown by a vehicle (L: launchFor): first a flight (air: h the height over the snow, vy, the somersault and twist in
// the throw's frame: hd its heading, the rig's fallHeading), a bounce, then the tumble on the snow as above. thud: the
// hardest landing since the caller last looked (m/s down; the caller makes the puff and the sound, then zeroes it).
export function newFall(side, dx, dz, speed, L = null) {
  const kind = L && L.vy > 0 ? 'tumble' : speed > 8 ? 'roll' : 'slam', slide = L ? L.vh : Math.min(6, 1.2 + speed * 0.35);
  return {
    t: 0, gt: 0, state: 'tumble', kind, side, pitch: 0, pitchVel: L ? L.spin : 0, pitchTarget: null, roll: 0,
    rollVel: L ? L.twist : kind === 'roll' ? side * clamp(speed * 0.4, 3, 9) : 0,
    rollTarget: null, rollRest: 0, ball: kind === 'slam' ? 0.25 : L ? 0.3 : 1, getUp: 0, lieT: 0,
    lieDur: L ? L.lie : 1.1 + Math.random() * 1.2, upDur: L ? L.up : 1.35,
    vx: dx * slide, vz: dz * slide, stumble: false, dx, dz,
    air: !!(L && L.vy > 0), h: 0, vy: L ? L.vy : 0, thud: 0, hd: L ? Math.atan2(dx, dz) : null,
  };
}
// a stumble: the standing body tips with the push and recovers (0.85 s)
export function newStumble(dx, dz) {
  return { t: 0, dur: 0.85, stumble: true, state: 'getup', kind: 'slam', side: 1, pitch: 0, pitchVel: 0, roll: 0, rollVel: 0, ball: 0, getUp: 1, lieT: 0, vx: dx * 1.4, vz: dz * 1.4, dx, dz, air: false, h: 0, thud: 0 };
}

// a critically damped spring of F[k] (and F[k + 'Vel']) toward target, rate w
function spring(F, k, kv, target, w, dt) {
  const d = F[k] - target, e = Math.exp(-w * dt), c = F[kv] + w * d;
  F[k] = target + (d + c * dt) * e;
  F[kv] = (F[kv] - c * w * dt) * e;
}

/** Advance a fall; heading: the person's (the stumble tips relative to it). true when back on their feet. */
export function stepFall(F, dt, heading = 0) {
  F.t += dt;
  // (Oct 31 2026: "the arms flail, and the head and limbs follow through") fl: 0..1 flailing, up quickly in the air,
  // dying away over the tumble on the snow (the rig's st.flail: player/skier.js poseFall)
  F.fl = (F.fl || 0) + ((F.air ? 1 : 0) - (F.fl || 0)) * (1 - Math.exp(-dt * (F.air ? 8 : 2.5)));
  if (F.air) {
    // flying: gravity, the somersault and the twist carry on (no friction in the air); the snow takes the speed where
    // it lands, a hard landing bounces, then it tumbles on along the snow (a forward roll with the slide)
    F.vy -= G * dt; F.h += F.vy * dt;
    F.pitch += F.pitchVel * dt; F.roll += F.rollVel * dt;
    F.ball += (0.3 - F.ball) * (1 - Math.exp(-dt * 6)); // (limbs flung out, half tucked)
    if (F.h <= 0) {
      const imp = -F.vy, k = imp > 3 ? 0.6 : 0.8;
      F.h = 0;
      F.thud = Math.max(F.thud || 0, imp);
      F.vx *= k; F.vz *= k;
      F.pitchVel *= 0.5; F.rollVel *= 0.5;
      if (imp > 2.5) F.vy = imp * 0.3; // a bounce
      else {
        F.vy = 0; F.air = false; F.gt = 0;
        F.pitchVel = F.pitchVel * 0.6 + Math.min(9, Math.hypot(F.vx, F.vz) * 1.2);
        F.ball = Math.max(F.ball, 0.6);
      }
    }
    return false;
  }
  const s = Math.hypot(F.vx, F.vz);
  if (s > 1e-4) { const k = Math.max(0, s - (F.stumble ? 5 : 7.5) * dt) / s; F.vx *= k; F.vz *= k; }
  if (F.stumble) {
    const w = Math.sin(Math.PI * Math.min(1, F.t / F.dur));
    const fx = Math.sin(heading), fz = Math.cos(heading); // right = (-fz, 0, fx)
    F.pitch = 0.3 * w * (F.dx * fx + F.dz * fz);
    F.roll = 0.3 * w * (-F.dx * fz + F.dz * fx);
    return F.t >= F.dur;
  }
  const side = F.side;
  if (F.state === 'tumble') {
    F.gt += dt;
    let settled = true;
    // the somersault (thrown: tumbling on along the snow) finishes onto the nearest full turn
    if (F.pitchTarget === null) {
      if (Math.abs(F.pitchVel) < 3.2 || (s < 3 && F.gt > 0.5)) {
        const rest = F.pitch + (F.pitchVel * Math.abs(F.pitchVel)) / 14;
        F.pitchTarget = Math.round(rest / TAU) * TAU;
      } else { F.pitchVel *= Math.exp(-dt * (s < 1.5 ? 3 : 0.9)); F.pitch += F.pitchVel * dt; settled = false; }
    }
    if (F.pitchTarget !== null) {
      spring(F, 'pitch', 'pitchVel', F.pitchTarget, 6, dt);
      settled = Math.abs(F.pitch - F.pitchTarget) < 0.05 && Math.abs(F.pitchVel) < 0.4;
    }
    if (F.kind === 'roll' && F.rollTarget === null) {
      if (Math.abs(F.rollVel) < 3 || (s < 2 && F.gt > 0.5)) {
        const rest = F.roll + (F.rollVel * Math.abs(F.rollVel)) / 14;
        F.rollTarget = Math.round((rest - side * Math.PI / 2) / TAU) * TAU + side * Math.PI / 2;
      } else { F.rollVel *= Math.exp(-dt * 0.9); F.roll += F.rollVel * dt; settled = false; }
    } else if (F.rollTarget === null) {
      // over onto the side (thrown: once the somersault settles; the twist turns on till then)
      if (F.pitchTarget !== null) F.rollTarget = Math.round((F.roll - side * Math.PI / 2) / TAU) * TAU + side * Math.PI / 2;
      else { F.rollVel *= Math.exp(-dt * 2); F.roll += F.rollVel * dt; }
    }
    if (F.rollTarget !== null) {
      spring(F, 'roll', 'rollVel', F.rollTarget, F.kind === 'slam' ? 5.5 : 5, dt);
      settled = settled && Math.abs(F.roll - F.rollTarget) < 0.06 && Math.abs(F.rollVel) < 0.5;
    } else settled = false;
    const spinning = Math.abs(F.pitchVel) + Math.abs(F.rollVel) > 3 && F.kind !== 'slam';
    F.ball += ((spinning ? 1 : 0) - F.ball) * (1 - Math.exp(-dt * (spinning ? 8 : 3)));
    if ((settled && s < 1.5 && F.gt > 0.6) || F.gt > 4) {
      F.state = 'lie'; F.lieT = 0;
      F.pitch = 0; F.pitchVel = 0;
      F.roll -= Math.round((F.roll - side * Math.PI / 2) / TAU) * TAU; F.rollVel = 0;
      if (Math.abs(F.roll - side * Math.PI / 2) > 0.2) F.roll = side * Math.PI / 2;
      F.rollRest = F.roll;
    }
  } else if (F.state === 'lie') {
    F.lieT += dt;
    F.ball *= Math.exp(-dt * 4);
    if (F.lieT > F.lieDur) { F.state = 'getup'; F.getUp = 0; }
  } else {
    F.getUp = Math.min(1, F.getUp + dt / (F.upDur || 1.35));
    F.ball *= Math.exp(-dt * 6);
    const k = Math.min(1, F.getUp / 0.62);
    F.roll = F.rollRest * (1 - k * k * (3 - 2 * k));
    if (F.getUp >= 1) return true;
  }
  return false;
}

// a body thrown by a vehicle (F: newFall, with .col the vehicle's box collider, set by the knock) is never inside it:
// out through the nearest face (0.35 m: the body), carried at least as fast as the box comes on (the car that keeps
// going shoves them ahead instead of driving through; under them while they fly over its roof: no). p: {x, z}.
const BODY_R = 0.35;
export function keepClear(F, p, dt) {
  const c = F.col;
  if (!c || !(dt > 0)) return;
  if (F.cx === undefined) { F.cx = c.x; F.cz = c.z; }
  let cvx = (c.x - F.cx) / dt, cvz = (c.z - F.cz) / dt;
  F.cx = c.x; F.cz = c.z;
  if (cvx * cvx + cvz * cvz > 60 * 60) { cvx = 0; cvz = 0; } // (a jump: parked far away, respawned)
  if (F.t > 6 || (F.h || 0) > 1.7 || Math.abs(p.x - c.x) > 12 || Math.abs(p.z - c.z) > 12) return;
  const [ux, uz, d] = away(c, p.x, p.z);
  if (d >= BODY_R) return;
  p.x += ux * (BODY_R - d); p.z += uz * (BODY_R - d);
  const vn = F.vx * ux + F.vz * uz, cn = cvx * ux + cvz * uz;
  if (vn < cn) { F.vx += ux * (cn - vn); F.vz += uz * (cn - vn); }
}

// ------------------------------------------------------------------ the crowd's people knocked over (crowdFall)
// (Oct 31 2026, the user: "on single player the bot getting hit just falls over, that's a very bad animation. Use the
// same animation as in multiplayer on real people") Somebody of an instanced crowd (world/peoplesim.js) knocked over
// near you is posed by a SkierRig built on their own character model (world/fans.js FanKit.root, the same skeleton),
// through the player's wipeout (newFall / stepFall above, the rig's 'fall' mode: poseFall, placeFallen) exactly as a
// remote player's avatar or an NPC villager (game/npcs.js updateDown); the rig's bones become the person's skinning
// matrices (FanCrowd.poseFromRig), so they keep their jacket and size. The rig is never drawn itself. Back on their
// feet: a second on the rig's own stand (its blend out of the fall, a shake of the head), then the crowd's poses again.
// Cheap: only the people down use a rig (at most RAG_MAX at once, made once per character and kept), within RAG_NEAR
// of you; anybody else falls the old rigid way.
const RAG_MAX = 3, RAG_NEAR = 90, SHAKE_T = 1.0;
const _rigs = new Map(); // FanKit -> [SkierRig]
let ragUsed = 0;
const _rgN = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const _st = { mode: 'fall', heading: 0, speed: 0, crouch: 0, lean: 0, edge: 0, tuck: false, plow: 0, skid: 0, normal: UP, air: false,
  fall: null, fallSide: 1, fallHeading: 0, fallAir: false, fallT: 0, flail: 0, lookYaw: 0, lookPitch: 0 };
function takeRig(kit) {
  if (ragUsed >= RAG_MAX || !kit?.root) return null;
  let list = _rigs.get(kit);
  if (!list) _rigs.set(kit, (list = []));
  let r = list.find((x) => !x.ragBusy);
  if (!r) {
    kit.rigSrc ??= { scene: kit.root, animations: [] }; // (one source per character: the rig's measurements are cached on it)
    r = new SkierRig(kit.rigSrc, {});
    list.push(r);
  }
  r.ragBusy = true; ragUsed++;
  return r;
}
function stateFor(K, n, flail) {
  const F = K.F;
  _st.mode = 'fall'; _st.heading = K.h; _st.normal = n; _st.fall = F; _st.fallSide = F.side; _st.fallHeading = F.hd ?? K.h;
  _st.fallAir = !!F.air; _st.fallT = F.t / 0.6; _st.flail = flail; _st.lookYaw = 0;
  return _st;
}
function idleState(K, n, lookYaw) {
  _st.mode = 'idle'; _st.heading = K.h; _st.normal = n; _st.fall = null; _st.fallAir = false; _st.flail = 0; _st.lookYaw = lookYaw;
  return _st;
}
export const crowdFall = {
  begin(sim, p, dx, dz, speed, L, col) {
    const crowd = sim.crowd, pl = ctx?.player?.pos;
    if (!crowd?.poseFromRig || !crowd.dyn || !pl || Math.hypot(p.x - pl.x, p.z - pl.z) > RAG_NEAR) return null;
    let rig = null;
    try { rig = takeRig(crowd.kitOf(p.i)); } catch (e) { console.warn('crowd rig', e); }
    if (!rig) return null;
    // the side they go over to: the push toward their right (+) / left, as the villagers (npcs.js knock)
    const h = p.yaw || 0, dr = -dx * Math.cos(h) + dz * Math.sin(h);
    const side = Math.abs(dr) > 0.25 ? Math.sign(dr) : Math.random() < 0.5 ? -1 : 1;
    const F = newFall(side, dx, dz, speed, L);
    F.col = col;
    const K = { rig: true, fall: true, R: rig, F, h, up: false, ut: 0, t: 0 };
    // one frame standing first (snapped), so the rig's own 0.3 s blend carries them from upright into the fall
    try {
      const gy = world.groundHeight(p.x, p.z, p.y + 1);
      rig.root.position.set(p.x, gy, p.z);
      rig.snapNext = true;
      rig.update(1 / 60, idleState(K, UP, 0));
      rig.fx.length = 0;
    } catch (e) { console.warn('crowd rig', e); rig.ragBusy = false; ragUsed--; return null; }
    return K;
  },
  step(sim, p, K, dt) {
    const F = K.F, r = K.R, crowd = sim.crowd;
    if (!K.up && stepFall(F, dt, K.h)) { K.up = true; K.ut = 0; K.stumble = true; } // (up: a car can knock them over again)
    if (!K.up) {
      p.x += F.vx * dt; p.z += F.vz * dt;
      keepClear(F, p, dt);                                         // (the car that hit them)
      const th = sim.wallStop(p, F);                               // (the walls, lamps, stalls about)
      if (th > 2) F.thud = Math.max(F.thud || 0, th);
    }
    const gy = world.groundHeight(p.x, p.z, p.y + 1);
    if (F.thud) { landed(p.x, gy, p.z, F.thud, F.vx, F.vz); F.thud = 0; }
    const y = gy + (K.up ? 0 : Math.max(0, F.h || 0)); // (flying: over the snow below, never under it)
    r.root.position.set(p.x, y, p.z);
    const n = world.normal(p.x, p.z, _rgN) || UP;
    if (!K.up) r.update(dt, stateFor(K, n, F.fl || 0));
    else {
      // up: the rig blends out of the fall into its stand, a shake of the head (shaking it off), then off they go
      K.ut += dt;
      const u = K.ut / SHAKE_T, shake = u > 0.25 && u < 0.9 ? Math.sin((u - 0.25) * 30) * 0.4 * Math.sin(Math.PI * (u - 0.25) / 0.65) : 0;
      r.update(dt, idleState(K, UP, shake));
    }
    // the snow the body throws up where it lands on a limb (placeFallen's contacts)
    for (const e of r.fx) if (e.type === 'impact' || e.type === 'crash') puff(e.x, e.y, e.z, e.amount * 0.7, F.vx * 0.3, F.vz * 0.3);
    r.fx.length = 0;
    crowd.setPlace(p.i, p.x, y, p.z, K.h);
    crowd.poseFromRig(p.i, r);
    p.y = gy; p.gx = p.x; p.gz = p.z; p.yaw = K.h;
    return K.up && K.ut >= SHAKE_T;
  },
  end(sim, p, K) {
    sim.crowd?.poseFromRig?.(p.i, null, true);
    if (K.R?.ragBusy) { K.R.ragBusy = false; ragUsed = Math.max(0, ragUsed - 1); }
  },
};
