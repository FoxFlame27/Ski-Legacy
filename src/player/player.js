// Player controller: skiing physics (carving, skidding, jumps, landings), freestyle tricks,
// walking with the skis on the back, lift riding, crashes and the 1st/3rd person camera.
//
// Skiing model (1/120 s substeps, in the plane of the snow under the skis):
//  - gravity along the slope, glide friction and aerodynamic drag (a tuck halves the drag)
//  - steering: A/D turn the skis right away (0.1 s response) at a rate proportional to the input,
//    up to what a clean carve can hold at that speed (1.6 rad/s slow, ~0.9 rad/s at 25 m/s). Edge
//    grip pulls the velocity onto the skis' line, so on snow the path follows the skis (carve, speed
//    kept); braking + steering pivots harder and slides (skid turn, speed scrubbed). Ice lets go.
//  - the heading only ever changes from input, landings, collisions or crashes: nothing turns the
//    skier toward the fall line. A stopped skier is held by the edges unless the skis point down
//    the hill or W / Shift push; after a teleport, a lift, getting up or a braked stop the skier
//    stays parked until the player moves.
//  - the skier follows convex snow while gravity plus leg absorption can keep up (STICK), otherwise
//    takes off: kicker lips, rollers and crests at speed. Space charges a pop (ollie).
//  - landings are judged on impact into the snow and on the trick (src/player/tricks.js).
// On foot you can walk up ordinary slopes; it gets slower with the grade and stops at ~38 degrees
// (take a lift). All ground queries go through world.groundHeight / surfaces, so ramps and bridge
// decks are ridden.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { clamp, lerp, smoothstep } from '../core/noise.js';
import { Tricks, wrapPi, CRASH_IMPACT } from './tricks.js';

const G = 9.81;
const UP = new THREE.Vector3(0, 1, 0);
const SUBSTEP = 1 / 120;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const TRICK_KEYS = ['left', 'right', 'front', 'back', 'grab'];

// ---- ski physics tuning (SI units) ----
const MU = 0.04;                    // glide friction of waxed skis on groomed snow
const DRAG = (0.5 * 1.15) / 80;     // 0.5 * air density / skier mass (x CdA x v^2 = deceleration)
const CDA_STAND = 0.42, CDA_TUCK = 0.2, CDA_AIR = 0.38;
const TURN_MAX = 1.6;               // full-lock turn rate at low speed, pivots on the spot (rad/s)
const A_TURN = 23;                  // lateral acceleration of a full-lock turn at speed (m/s^2): 0.92 rad/s at 25 m/s
const STEER_TAU = 0.1;              // steering response time constant (s)
const STEER_TAU_OFF = 0.07;         // ...a little quicker to straighten out when released
const TUCK_TURN = 0.65;             // a tuck turns less
const SKID_TURN = 1.6;              // braking + steering pivots the skis harder (skid turn)
const A_GRIP = 30;                  // edge grip (m/s^2): holds every steered turn on snow; ice lets go
const CARVE_DRAG = 0.012;           // speed cost of edge load (m/s^2 per m/s^2 of lateral force)
const AIR_STEER_MAX = 20 * DEG;     // skis pre-turned in an air without a spin (kept on landing)
const V_HOLD = 0.5;                 // below this speed the edges hold a skier still...
const G_GO = 0.6;                   // ...unless the skis point down the hill with this much pull (m/s^2)
const COS_GO = Math.cos(55 * DEG);  //    and within 55 deg of the fall line
const PUSH_A = 2.6, PUSH_V = 9;     // skating (Shift): push up to 9 m/s
const W_PUSH_V = 5;                 // W pushes off while slow (above ~4 m/s, W tucks)
// race start (startPush): strong skating / double-pole pushes out of the gate, ~10 m/s within ~2 s
const LAUNCH_A = 6.6, LAUNCH_V = 12.5, LAUNCH_T = 2.2;
const PUSH_UP0 = Math.sin(7 * DEG), PUSH_UP1 = Math.sin(9 * DEG); // skating / herringbone dies out uphill
const BRAKE_LOW = 6, BRAKE_HIGH = 8; // braking deceleration: snowplow / hockey stop (m/s^2)
const BRAKE_HOLD_V = 0.6;           // braking below this speed stands still on the edges
const STICK = 10;                   // extra pull-down the legs absorb over crests (m/s^2)
const POP_MIN = 2.8, POP_MAX = 5.2; // ollie impulse along the snow normal: tap .. full charge (m/s)
const CHARGE_TIME = 0.55;           // seconds to a full crouch charge
const COYOTE = 0.16;                // a pop still works this long after rolling off a lip (s)
const STEER_HELD = 0.3;             // A/D held this long before Space is a turn, not a pre-wound spin (s)
const IMPACT_FRICTION = 0.3;        // speed lost per m/s of landing impact beyond what the legs soak up
const IMPACT_FREE = 3.5;            // m/s of impact absorbed by the legs without losing speed
const BODY_SLIDE = 8.5;             // deceleration of a tumbling body on snow after a crash (m/s^2)
const GETUP_TIME = 1.35;            // seconds to stand back up

// ---- on foot ----
const FOOT_SPEED = 4.2;     // on foot (m/s): the normal pace (run animation)
const SPRINT_K = 1.5; // Shift: 1.5x on foot
const WALK_FULL = Math.tan(22 * DEG);  // uphill walking slows above this...
const WALK_MAX = Math.tan(38 * DEG);   // ...and stops only on real steeps (cliffs, rock faces): take a lift

// ---- first-person camera: a helmet cam ----
// The eyes of your own (visible) body over the boots, looking a little down the run (further down a steep
// pitch, along the flight path in the air). The horizon stays steady: the head banks only a little into a
// carve and looks a little ahead into the turn; landings dip it, speed widens the view and adds a fine
// buzz. Spins turn it and flips roll it right round with you (the body and skis go round with the view, as
// on a real helmet cam); a crash knocks it down to the snow. Gloved hands hold the poles (rig.updateFpView).
const FP_PITCH = -15 * DEG;         // default look-down while skiing
const FP_SLOPE_PITCH = 0.55;        // share of the snow's pitch the view follows (looks down a steep run)
const FP_EYE_H = 1.26;              // eye over the snow in the athletic stance (m), until the rig has one
const FP_NEAR = 0.08;
const FP_FOV = 78;                  // vertical field of view at rest (deg)...
const FP_FOV_SPEED = 0.35;          // ...+ this per m/s over 10 m/s (up to +10.5 deg)
const FP_LEAD = 0.13;               // the head looks this many seconds of turning ahead into a turn...
const FP_LEAD_MAX = 0.2;            // ...at most this far (rad)
const FP_BANK = 0.12;               // head roll per radian of body inclination...
const FP_BANK_MAX = 6 * DEG;        // ...at most (a steady horizon)

const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _l = new THREE.Vector3(), _a = new THREE.Vector3();
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _fo = new THREE.Vector3(), _jit = new THREE.Vector3();
const _cf = new THREE.Vector3(), _cr = new THREE.Vector3(), _dir = new THREE.Vector3();
const _set = { x: 0, v: 0 };

const approach = (x, t, step) => (x < t ? Math.min(t, x + step) : Math.max(t, x - step));
const dampAngle = (a, b, k) => a + wrapPi(b - a) * (1 - Math.exp(-k));

// Exact critically damped spring step toward `target`; writes { x, v } into `o`.
function spring(o, x, v, target, w, dt) {
  const d = x - target, e = Math.exp(-w * dt), c = v + w * d;
  o.x = target + (d + c * dt) * e;
  o.v = (v - c * w * dt) * e;
  return o;
}

// Park feature (kicker, tabletop, roller) whose surface is right under (x, y, z), if any.
// (world's walkable surfaces are bucketed in 64 m cells)
function parkFeatureAt(x, z, y) {
  const arr = world.surfaceGrid?.get(Math.floor(x / 64) + ',' + Math.floor(z / 64));
  if (!arr) return null;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (!s.feature) continue;
    const hs = s.height(x, z);
    if (hs !== null && Math.abs(hs - y) < 0.3) return s;
  }
  return null;
}

// Top of a tree / rock from the vegetation (trees have a `type`, rocks sit half buried); NaN if unknown.
const PERSON_R = 0.4, PERSON = { soft: true }; // other skiers / villagers: a soft bump
const BIG_ROCK = 2.6;   // rock size (m) from which a boulder blocks you
const CRASH_HIT = 11;  // m/s straight into a tree / boulder / wall (~40 km/h) before it wipes you out
const obstacleTop = (t) => (t.type !== undefined ? t.y + t.s : t.y + 0.75 * t.s);

export class Player {
  constructor({ rig, input, camera, colliders, vegetation, audio }) {
    this.rig = rig;
    this.input = input;
    this.camera = camera;
    this.colliders = colliders; // [{x, z, r} | {x, z, hw, hd, rot}], optional `top` (world y) = can be jumped over
    this.vegetation = vegetation;
    this.audio = audio;
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.heading = Math.PI; // facing -Z (toward the mountain)
    this.mode = 'walk'; // walk | ski | sit | fall
    this.hasSkis = false;
    this.skisOn = false;
    this.ski = { speed: 1, grip: 1 };
    this.frictionScale = 1; // snow grip/glide multiplier, set externally each frame (ice ~0.35)
    this.autoSkisOff = false; // (stopping on flat ground used to take the skis off: now they stay on, you pole on)
    this.hold = false; // keep a grounded skier in place (countdowns)
    this.parked = false; // standing still until the player moves (after teleports, lifts, getting up, braked stops)
    this.launch = 0;     // s of race-start push left (startPush)
    this.brakeStopT = 0;
    this.grounded = true;
    this.air = false;          // airborne (gameplay: tricks, landing)
    this.ballistic = false;    // physics in free flight (includes brief separations over bumps)
    this.liftT = 0;
    this.airTime = 0;
    this.airEnd = 0;           // predicted flight time of the current air (s)
    this.normal = new THREE.Vector3(0, 1, 0);
    this.lastGroundNormal = new THREE.Vector3(0, 1, 0);
    this.steer = 0; this.lean = 0; this.edge = 0; this.crouch = 0.2; this.plow = 0; this.tuck = false;
    this.sideslip = 0;
    this.skidAmt = 0; this.skidYaw = 0; this.skidSide = 1;
    this.turnRate = 0; this.prevVelYaw = this.heading;
    // jumping & landing
    this.charging = false; this.charge = 0; this.popT = 1; this.popped = false;
    this.absorb = 0; this.absorbV = 0;
    this.airHeading = this.heading; this.airTravel = this.heading; this.airSteer = 0;
    this.heldT = { left: 0, right: 0 };   // how long A / D have been held (a held turn vs a spin)
    this.preHeld = { left: false, right: false, front: false, back: false, grab: false }; // keys down when a pop charge starts
    this._latch = { left: false, right: false, front: false, back: false, grab: false };
    // tricks: visual flip angle (rad, + = forward), visual yaw offset after landings (reverts)
    this.tricks = new Tricks();
    this.onTrick = null; // ({ name, points, total, landed, switch, ... }) => {}
    this.flip = 0; this.yawFx = 0; this.yawFxV = 0;
    this.lastLanding = null;
    // crashes
    this.fallT = 0; this.fallSide = 1; this.fallAir = false;
    this.fall = { t: 0, state: 'none', kind: 'slam', axisHeading: 0, pitch: 0, pitchVel: 0, roll: 0, rollVel: 0,
      pitchTarget: null, rollTarget: null, rollRest: 0, ball: 0, getUp: 0, lieT: 0, slideFx: 0 };
    this.lastTurnSide = 1;
    this.rotSnd = 0;
    this.grabVis = 0; this.spinVis = 0;
    this.skiSound = { edge: 0, skid: 0, air: false, tuck: false, ice: 0 };
    this.seat = null; // { pos: Vector3, fwd: Vector3 } while riding
    this.view = 'third'; // third | first
    this.camYaw = 0; this.camPitch = -0.12; this.camDist = 4.6;
    this.lookYaw = 0; this.lookPitch = 0;
    this.fpH = FP_EYE_H; this.fpBase = 0; // first person: smoothed eye height, base look-down
    this.fpSlope = 0; // smoothed pitch of the snow along the way you're going (first-person look-down)
    this.walkSlip = 0; this.steepT = 0; this.steepOkT = 0; this.steepWarned = false; // too steep to walk up
    this.lastMouse = 0;
    this.camPos = new THREE.Vector3(0, 3, 6);
    this.camLook = new THREE.Vector3();
    this.camFocusY = null;
    this.camDip = 0; this.camDipV = 0; this.fovKick = 0; this.airBlend = 0;
    this.travelYaw = this.heading;
    this.shake = 0;
    this.lastSteerSign = 0;
    this.skatePhase = 0;
    this.tuckPoleT = 0.5; // next double-pole push while holding W
    this.distance = 0;
    this.topSpeed = 0;
    this.frozen = false; // controls disabled (menus, countdown)
    this.events = [];
    this.fpFov = 78; this.tpFov = 65;
    this.keys = { left: false, right: false, front: false, back: false, grab: false };
    this.ctl = { steer: 0, steerIn: 0, tuck: false, brake: false, skate: false, go: false, move: false };
    this.rigState = {};
    this._corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
  }

  get speed() { return this.vel.length(); }
  get forward() { return _f.set(Math.sin(this.heading), 0, Math.cos(this.heading)); }
  // name of the trick in progress (live HUD preview), '' when nothing yet
  get trickName() { return this.air ? this.tricks.describe().name : ''; }

  /**
   * Race start (call at GO): leave the gate with a few strong skating / double-pole pushes, reaching
   * ~10 m/s within ~2 s on a start ramp, whatever keys are held. Also un-parks the skier.
   * @param {number} [dur]  seconds of pushing
   */
  startPush(dur = LAUNCH_T) {
    this.launch = dur;
    this.parked = false;
    this.hold = false;
    if (this.mode === 'ski') this.skatePhase = 0.95; // the first double-pole comes right away
  }

  // Place the player standing still on the ground at (x, z). `y` picks the level when surfaces overlap
  // (bridges). Ends any crash, jump or trick, and parks the skier: nothing moves until the player does.
  teleport(x, z, heading, y) {
    this.pos.set(x, y === undefined ? world.groundHeight(x, z) : world.groundHeight(x, z, y + 0.5), z);
    this.vel.set(0, 0, 0);
    if (heading !== undefined) { this.heading = heading; this.camYaw = heading + Math.PI; } // camera behind (callers may override)
    if (this.mode === 'fall') this.mode = this.skisOn ? 'ski' : 'walk';
    this.resetFall();
    this.camPos.copy(this.pos).add(_v.set(-Math.sin(this.heading) * 5, 3, -Math.cos(this.heading) * 5));
    this.camFocusY = null; this.camLook.set(0, 0, 0); this.travelYaw = this.heading; this.camDip = 0; this.camDipV = 0;
    this.shake = 0; this.fovKick = 0; this.airBlend = 0; this.fpSlope = 0;
    this.prevVelYaw = this.heading;
    this.resetAirState();
    this.crouch = 0.2; this.plow = 0; this.sideslip = 0; this.tuck = false;
    this.footAir = false; this.footJumpY = 0; this.footJumpV = 0; this.walkSlip = 0; this.steepT = 0;
    this.flatT = 0; this.brakeStopT = 0;
    this.parked = true;
    this.launch = 0;
    world.groundNormal(this.pos.x, this.pos.z, this.pos.y + 0.3, this.normal);
    this.rig.snapPose?.(); // no blend from the old pose (e.g. lying in the snow) at the new place
  }

  // Forget a crash completely (teleports, getting up).
  resetFall() {
    const F = this.fall;
    F.t = 0; F.state = 'none'; F.kind = 'slam'; F.pitch = 0; F.pitchVel = 0; F.roll = 0; F.rollVel = 0;
    F.pitchTarget = null; F.rollTarget = null; F.rollRest = 0; F.ball = 0; F.getUp = 0; F.lieT = 0; F.slideFx = 0;
    F.bump = false;
    this.fallT = 0; this.fallAir = false;
  }

  resetAirState() {
    this.air = false;
    this.ballistic = false;
    this.tricks.cancel();
    this.flip = 0; this.yawFx = 0; this.yawFxV = 0; this.airSteer = 0;
    this.charging = false; this.charge = 0; this.popT = 1;
    this.absorb = 0; this.absorbV = 0;
    this.steer = 0; this.edge = 0; this.lean = 0; this.skidAmt = 0; this.skidYaw = 0; this.turnRate = 0;
  }

  // Skis either on the feet (skiing) or strapped to the back (walking). Without skis: neither.
  setSkisOn(on) {
    if (on && !this.hasSkis) return;
    // clicking into the skis: stand still until you push off or steer
    if (on && !this.skisOn) { this.parked = true; this.vel.set(0, 0, 0); }
    this.skisOn = on;
    if (this.mode === 'walk' || this.mode === 'ski') this.mode = on ? 'ski' : 'walk';
    this.rig.setSkisVisible(this.hasSkis);
    this.rig.setCarry(this.hasSkis && !on);
  }

  update(dt) {
    const inp = this.input;
    if (inp.hit('KeyR') && !(this.mode === 'sit' && this.viewBeforeRide)) this.view = this.view === 'third' ? 'first' : 'third';
    if (inp.hit('KeyG') && this.hasSkis && (this.mode === 'walk' || (this.mode === 'ski' && !this.air && this.speed < 2))) {
      // skis go on anywhere (Oct 27, the user): on the flat you pole yourself off with W
      this.setSkisOn(!this.skisOn);
    }

    // mouse look
    const sens = 0.0022 * (this.sensitivity || 1);
    if (inp.mdx || inp.mdy) this.lastMouse = performance.now();
    if (this.view === 'first') {
      this.lookYaw -= inp.mdx * sens;
      this.lookPitch = clamp(this.lookPitch - inp.mdy * sens, -1.3, 1.2);
      if (this.mode === 'ski') this.lookYaw = clamp(this.lookYaw, -2.0, 2.0);
    } else {
      this.camYaw -= inp.mdx * sens;
      this.camPitch = clamp(this.camPitch - inp.mdy * sens, -1.2, 0.6);
      this.camDist = clamp(this.camDist + inp.wheel * 0.5, 2.2, 12);
    }

    if (this.mode === 'ski') this.updateSki(dt);
    else if (this.mode === 'walk') this.updateWalk(dt);
    else if (this.mode === 'fall') this.updateFall(dt);
    else if (this.mode === 'sit') this.updateSit(dt);
    this.grounded = !this.air && !(this.mode === 'fall' && this.fallAir);

    const sp = this.speed;
    if (this.mode === 'ski' && !this.air) this.distance += sp * dt;
    this.topSpeed = Math.max(this.topSpeed, this.mode === 'ski' ? sp : 0);

    this.rig.root.position.copy(this.pos);
    // first person: a wipeout pulls the camera out of your head to watch the tumble from behind (third-person
    // camera); you're back in your eyes when you're up again
    this.updateFpCrash();
    const fp = this.view === 'first' && !this.fpCrash;
    this.rig.setHeadHidden(fp);
    const st = this.rigState, F = this.fall;
    st.mode = this.mode === 'walk' ? (sp > 0.1 ? 'walk' : 'idle') : this.mode;
    st.heading = this.heading + (this.mode === 'ski' ? this.yawFx : 0);
    st.crouch = clamp(this.crouch + this.absorb, -0.2, 1.1);
    st.lean = this.lean; st.edge = this.edge; st.tuck = this.tuck; st.plow = this.plow; st.skid = this.skidYaw;
    st.speed = sp;
    st.normal = this.air ? UP : this.normal;
    st.air = this.air;
    st.flip = this.mode === 'ski' ? this.flip : 0;
    st.flipHeading = this.airTravel;
    // grabs and spin arms ease out after touchdown instead of snapping back
    this.grabVis = this.air ? this.tricks.grab : Math.max(0, this.grabVis - dt / 0.12);
    this.spinVis = this.air ? this.tricks.spinVel : this.spinVis * Math.exp(-dt * 12);
    st.grab = this.mode === 'ski' ? this.grabVis : 0;
    st.grabType = this.tricks.grabType;
    st.spinVel = this.mode === 'ski' ? this.spinVis : 0;
    st.charge = this.charging && !this.air ? this.charge : 0;
    st.lookYaw = fp ? this.lookYaw * 0.5 : 0;
    st.lookPitch = fp ? this.lookPitch * 0.4 : 0;
    st.seat = this.seat?.pos;
    st.carry = this.hasSkis && !this.skisOn;
    st.airY = this.mode === 'walk' ? this.footJumpY || 0 : 0;
    st.fallT = this.fallT / 0.6; st.fallSide = this.fallSide;
    st.fall = this.mode === 'fall' ? F : null;
    st.fallHeading = F.axisHeading;
    st.fallAir = this.mode === 'fall' && this.fallAir;
    // first person: the rig hides the body (gloves on the pole grips), holds the poles low and wide,
    // and hides the skis while they sweep past the eye in flips and crashes
    st.fp = fp;
    this.rig.update(dt, st);
    // body thuds while tumbling (the rig's ground contact reports them)
    if (this.mode === 'fall' && this.rig.fx) for (const e of this.rig.fx) if (e.type === 'impact' && !e.heard) { e.heard = true; this.audio?.play('thud', e.amount); }
    const snd = this.skiSound;
    snd.edge = Math.abs(this.edge); snd.skid = this.sideslip; snd.air = this.air; snd.tuck = this.tuck;
    snd.ice = 1 - Math.min(1, this.frictionScale);
    this.audio?.setSki?.(snd);
    this.updateCamera(dt);
  }

  // Flat ground = nowhere to ski: the village, valley floors. Lift exits and race starts are flat
  // loading areas where you're allowed to stand on skis.
  isFlatHere() {
    const p = this.pos, e = 4, y = p.y + 0.3;
    const gx = (world.groundHeight(p.x + e, p.z, y) - world.groundHeight(p.x - e, p.z, y)) / (2 * e);
    const gz = (world.groundHeight(p.x, p.z + e, y) - world.groundHeight(p.x, p.z - e, y)) / (2 * e);
    if (Math.hypot(gx, gz) > 0.045) return false;
    for (const z of this.skiZones || []) if (Math.hypot(p.x - z.x, p.z - z.z) < z.r) return false;
    return true;
  }

  // Snow normal under (x, z). Across a discontinuity (kicker lip, deck edge, terrain seam) the
  // one-sided slope that continues the snow we were on (the current normal) is kept: a lip still
  // launches you along its ramp, and a small seam never tilts the normal into a phantom impact.
  surfNormal(x, z, yHint, out, h0 = world.groundHeight(x, z, yHint)) {
    const e = 0.35;
    const hxp = world.groundHeight(x + e, z, yHint), hxm = world.groundHeight(x - e, z, yHint);
    const hzp = world.groundHeight(x, z + e, yHint), hzm = world.groundHeight(x, z - e, yHint);
    const ax = hxp - h0, bx = h0 - hxm, az = hzp - h0, bz = h0 - hzm;
    const pn = this.normal, ny = Math.max(0.05, pn.y);
    const px = (-pn.x / ny) * e, pz = (-pn.z / ny) * e; // current slope per sample step
    const dx = Math.abs(ax - bx) > 0.045 ? (Math.abs(ax - px) < Math.abs(bx - px) ? ax : bx) / e : (ax + bx) / (2 * e);
    const dz = Math.abs(az - bz) > 0.045 ? (Math.abs(az - pz) < Math.abs(bz - pz) ? az : bz) / e : (az + bz) / (2 * e);
    return out.set(-dx, 1, -dz).normalize();
  }

  // Full-lock turn rate (rad/s) at speed `sp`: pivots when slow, a carve the edges can hold at speed.
  turnRateAt(sp, tuck = false, brake = false) {
    let rate = Math.min(TURN_MAX, (A_TURN * (this.ski.grip || 1)) / Math.max(sp, 1));
    if (tuck) rate *= TUCK_TURN;
    if (brake && sp > 3) rate *= SKID_TURN;
    return rate;
  }

  // ------------------------------------------------------------------ skiing
  updateSki(dt) {
    const inp = this.input;
    const live = !this.frozen;
    const k = this.keys;
    k.left = live && (inp.down('KeyA') || inp.down('ArrowLeft'));
    k.right = live && (inp.down('KeyD') || inp.down('ArrowRight'));
    k.front = live && (inp.down('KeyW') || inp.down('ArrowUp'));
    k.back = live && (inp.down('KeyS') || inp.down('ArrowDown'));
    k.grab = live && (inp.down('ShiftLeft') || inp.down('ShiftRight'));
    this.heldT.left = k.left ? this.heldT.left + dt : 0;
    this.heldT.right = k.right ? this.heldT.right + dt : 0;
    const steerIn = (k.left ? 1 : 0) - (k.right ? 1 : 0);

    this.updatePop(dt, live);

    if (this.air) {
      // A/D spin and W/S flip after a deliberate jump (pop or park kicker), Shift grabs. Keys that
      // aren't a trick (a turn held into the jump, any air off a natural bump) keep steering the
      // skis a little, so the turn carries on after the landing.
      const T = this.tricks;
      T.update(dt, k, this.airEnd - this.airTime);
      const spinning = T.live.left || T.live.right;
      this.steerToward(spinning ? 0 : steerIn, dt);
      const vh = Math.hypot(this.vel.x, this.vel.z);
      this.airSteer = clamp(this.airSteer + this.steer * this.turnRateAt(vh) * dt, -AIR_STEER_MAX, AIR_STEER_MAX);
      this.heading = this.airHeading + T.spin + this.airSteer;
      this.flip = T.flip;
      // a whoosh for every half turn of rotation under way
      const turns = Math.floor((Math.abs(T.spin) + Math.abs(T.flip)) / Math.PI + 0.5);
      if (turns > this.rotSnd && Math.abs(T.spinVel) + Math.abs(T.flipVel) > 2.5) this.audio?.play('spin', clamp((Math.abs(T.spinVel) + Math.abs(T.flipVel)) / 8, 0.3, 1));
      this.rotSnd = Math.max(this.rotSnd, turns);
    } else {
      this.steerToward(steerIn, dt);
    }

    const ctl = this.ctl;
    ctl.steer = this.steer;
    ctl.steerIn = steerIn;
    ctl.brake = k.back;
    ctl.skate = false; // (Shift no longer skates you faster on the flat, Oct 27: it only grabs in the air)
    ctl.go = k.front && !k.back;   // W: double-pole off when slow, tuck at speed
    ctl.tuck = ctl.go;
    ctl.move = steerIn !== 0 || k.front; // anything that should get a parked skier going
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-9));
    const h = dt / steps;
    for (let s = 0; s < steps && this.mode === 'ski'; s++) this.skiStep(h, ctl);
    if (this.mode !== 'ski') return; // crashed during the step
    this.animateSki(dt, ctl);
  }

  // Steering responds right away (first order, no overshoot): no edge build-up, no wobble on release.
  steerToward(target, dt) {
    const tau = Math.abs(target) < Math.abs(this.steer) || target * this.steer < 0 ? STEER_TAU_OFF : STEER_TAU;
    this.steer += (target - this.steer) * (1 - Math.exp(-dt / tau));
    if (target === 0 && Math.abs(this.steer) < 1e-3) this.steer = 0;
  }

  // Hold Space to crouch-charge, release to pop (a quick tap gives a small hop). Releasing just after
  // rolling off a lip still pops (and makes the jump a deliberate one for trick input).
  updatePop(dt, live) {
    const inp = this.input;
    // controls off (frozen, menus): drop a charge without popping
    if (!live || inp.enabled === false) { this.charging = false; this.charge = 0; return; }
    const canPop = !this.air || (this.airTime < COYOTE && !this.popped);
    if (inp.hit('Space') && canPop) {
      this.charging = true; this.charge = 0;
      // keys already down when the charge starts are riding inputs (tuck, brake, skate, a turn held
      // for a while): after the pop they only count as trick keys once pressed again. A/D pressed just
      // before Space or during the charge pre-wind a spin.
      const k = this.keys, P = this.preHeld;
      P.front = k.front; P.back = k.back; P.grab = k.grab;
      P.left = k.left && this.heldT.left > STEER_HELD;
      P.right = k.right && this.heldT.right > STEER_HELD;
    }
    if (!this.charging) return;
    this.charge = Math.min(1, this.charge + dt / CHARGE_TIME);
    const down = inp.down('Space');
    const released = inp.up ? inp.up('Space') : !down;
    if (released) {
      if (canPop) this.pop(this.charge);
      this.charging = false; this.charge = 0;
    } else if (!down) {
      this.charging = false; this.charge = 0; // the key vanished without a release (focus lost): no jump
    } else if (this.air && this.airTime >= COYOTE) {
      this.charging = false; this.charge = 0; // too late: the charge is lost
    }
  }

  pop(charge) {
    const n = this.air ? this.lastGroundNormal : this.normal;
    const imp = POP_MIN + (POP_MAX - POP_MIN) * Math.pow(charge, 0.85);
    this.vel.addScaledVector(n, imp);
    this.parked = false;
    if (!this.air) { this.pos.addScaledVector(n, 0.03); this.takeoff('pop'); }
    else {
      // late pop just off a lip: a deliberate jump after all (keys held through the lip stay latched)
      this.tricks.arm();
      this.airEnd = this.airTime + this.predictAirLeft();
    }
    this.popped = true;
    this.popT = 0;
    this.fovKick = Math.max(this.fovKick, 0.4 + charge * 0.6);
    this.audio?.play('pop', 0.35 + 0.65 * charge);
  }

  // The snow fell away under the skis. Brief separations (bumps at speed) stay "grounded" while the
  // legs reach for the snow; a lip, a park feature or a growing gap make it a real air.
  liftOff(h) {
    this.ballistic = true;
    this.liftT = 0;
    this.lastGroundNormal.copy(this.normal);
    const p = this.pos, v = this.vel;
    // launched off a park feature (kicker, tabletop, roller)? check just behind the lip
    const bx = p.x - v.x * h * 2, bz = p.z - v.z * h * 2, by = p.y - v.y * h * 2;
    if (parkFeatureAt(bx, bz, by)) this.takeoff('feature');
    else if (p.y - world.groundHeight(p.x, p.z, p.y) > 0.18) this.takeoff('terrain');
  }

  // A real air: tricks are armed. kind: 'pop' (Space) | 'feature' (park jump) | 'terrain'.
  // Spins and flips need a deliberate jump (pop or park feature). Keys held into the jump are riding
  // inputs and only count as trick keys after a re-press (see updatePop for the pop's pre-wind).
  takeoff(kind) {
    const deliberate = kind !== 'terrain';
    this.air = true;
    this.ballistic = true;
    this.parked = false;
    this.airTime = kind === 'pop' ? 0 : this.liftT || 0;
    this.popped = kind === 'pop';
    if (kind === 'pop') this.lastGroundNormal.copy(this.normal);
    // a revert still in progress becomes the real heading in the air
    const sw = Math.abs(wrapPi(this.yawFx)) > Math.PI / 2;
    this.heading += this.yawFx; this.yawFx = 0; this.yawFxV = 0;
    this.flip = 0;
    this.airHeading = this.heading; this.airSteer = 0;
    const vh = Math.hypot(this.vel.x, this.vel.z);
    this.airTravel = vh > 0.7 ? Math.atan2(this.vel.x, this.vel.z) : this.heading;
    this.rotSnd = 0;
    const k = this.keys, P = this.preHeld, L = this._latch;
    for (const key of TRICK_KEYS) L[key] = kind === 'pop' ? P[key] && k[key] : k[key];
    this.tricks.takeoff({ latch: true, flips: deliberate, spins: deliberate, held: L, switch: sw });
    this.airEnd = this.airTime + this.predictAirLeft(); // flips only start with room to land them
  }

  // Remaining flight time if nothing changes (ballistic march over the snow ahead), once per jump.
  predictAirLeft() {
    const p = this.pos, v = this.vel;
    for (let t = 0.05; t <= 4; t += 0.05) {
      const y = p.y + v.y * t - 0.5 * G * t * t;
      if (y <= world.groundHeight(p.x + v.x * t, p.z + v.z * t, y + 0.5)) return t;
    }
    return 4;
  }

  skiStep(h, ctl) {
    if (this.ballistic) { this.airStep(h); return; }
    const p = this.pos, v = this.vel, n = this.normal;
    if (this.hold) { v.set(0, 0, 0); return; } // held at a start gate
    let sp = v.length();
    // parked (after a teleport, a lift, getting up or a braked stop): still until the player moves
    if (this.parked) {
      if (ctl.move || sp > V_HOLD) this.parked = false;
      else { v.set(0, 0, 0); return; }
    }
    const ice = clamp(this.frictionScale ?? 1, 0.05, 2);
    const brake = ctl.brake;
    const tuck = ctl.tuck && sp > W_PUSH_V - 1;

    // steering turns the skis: pivots at low speed, at speed the turn rate a carve can hold
    this.heading += ctl.steer * this.turnRateAt(sp, tuck, brake) * h;

    // ski frame on the snow: the skis point along the heading's compass direction, tilted onto the snow
    const sx = Math.sin(this.heading), sz = Math.cos(this.heading);
    const f = _f.set(sx, -(n.x * sx + n.z * sz) / Math.max(0.05, n.y), sz).normalize();
    const lat = _l.crossVectors(n, f); // to the skier's left
    const a = _a.set(0, -G, 0).addScaledVector(n, G * n.y); // gravity along the snow

    // pushing: skating (Shift) up to 9 m/s, W pushes off while slow; dies out uphill (no climbing)
    let push = 0;
    if (!brake && (ctl.skate || (ctl.go && sp < W_PUSH_V))) {
      const vmax = ctl.skate ? PUSH_V : W_PUSH_V;
      push = PUSH_A * Math.max(0, 1 - sp / vmax) * (1 - smoothstep(PUSH_UP0, PUSH_UP1, f.y));
    }
    // race start: the push out of the gate (braking cancels it)
    if (this.launch > 0) {
      this.launch = brake ? 0 : this.launch - h;
      push = Math.max(push, LAUNCH_A * Math.max(0, 1 - sp / LAUNCH_V));
    }

    // stopped: the edges hold the skier (no sliding sideways, backwards or creeping off) unless the
    // skis point down the hill or a push gets things going
    if (sp < V_HOLD) {
      const pull = a.dot(f), gl = a.length();
      const downhill = pull > G_GO && pull > COS_GO * gl;
      if (!downhill && !(push > 0.3 && pull + push > 0.1)) { v.set(0, 0, 0); this.brakeStop(h, brake); return; }
    }

    // glide friction, drag (a tuck halves it), and the cost of loading the edges in a turn
    if (sp > 1e-4) {
      const mult = this.ski.speed;
      const cda = (tuck ? CDA_TUCK : CDA_STAND + Math.abs(ctl.steer) * 0.06) / (mult * mult);
      const carve = CARVE_DRAG * sp * Math.abs(ctl.steer) * this.turnRateAt(sp, tuck, false);
      a.addScaledVector(v, -((MU / mult) * ice * G * n.y + DRAG * cda * sp * sp + carve) / sp);
    }
    if (push) a.addScaledVector(f, push);
    v.addScaledVector(a, h);

    // edge grip: pull the velocity onto the skis' line. Within the grip the path just bends (carve);
    // beyond it the skis slide sideways and the edge force scrubs speed (skid turns, ice)
    const grip = A_GRIP * (this.ski.grip || 1) * (0.3 + 0.7 * Math.min(1, ice));
    const vL = v.dot(lat);
    v.addScaledVector(lat, -Math.sign(vL) * Math.min(Math.abs(vL), grip * h));

    // braking: snowplow when slow, hockey-stop skid at speed (weaker on ice); stands still at a stop
    if (brake) {
      const s1 = v.length();
      if (s1 < BRAKE_HOLD_V) v.set(0, 0, 0);
      else {
        const dec = lerp(BRAKE_LOW, BRAKE_HIGH, smoothstep(5, 11, s1)) * (0.35 + 0.65 * Math.min(1, ice));
        v.multiplyScalar(Math.max(0, s1 - dec * h) / s1);
      }
    }
    v.addScaledVector(n, -v.dot(n));
    this.brakeStop(h, brake);
    p.addScaledVector(v, h);

    this.followGround(h);
    if (this.mode === 'ski' && !this.ballistic) this.collide(sp, p.y);
  }

  // Braked to a standstill: park (releasing S doesn't set you off again; W, A/D or Shift do).
  brakeStop(h, brake) {
    if (brake && this.vel.lengthSq() < 0.01) {
      this.brakeStopT += h;
      if (this.brakeStopT > 0.25) this.parked = true;
    } else this.brakeStopT = 0;
  }

  // Keep the skis on the snow after a move, or take off where it falls away too fast.
  followGround(h) {
    const p = this.pos, v = this.vel, n = this.normal;
    const gy = world.groundHeight(p.x, p.z, p.y + 0.05);
    const gap = p.y - gy;
    if (gap > 0 && 2 * gap > (G * n.y + STICK) * h * h && !(gap < 0.6 && this.onGroomedRun(p.x, p.z, p.y))) { this.liftOff(h); return; }
    p.y = gy;
    this.surfNormal(p.x, p.z, gy + 0.3, n, gy);
    const vn = v.dot(n);
    const s = v.length();
    v.addScaledVector(n, -vn);
    const t = v.length();
    if (vn < -3) {
      // an abrupt compression (base of a wall, step onto a deck) is absorbed like a landing
      if (t > 1e-6) v.multiplyScalar(Math.max(0, t - IMPACT_FRICTION * Math.max(0, -vn - IMPACT_FREE)) / t);
      this.absorbImpact(-vn);
      // (groomed runs are forgiving: their rock bands are skied like a piste)
      if (-vn > CRASH_IMPACT && !this.onGroomedRun(p.x, p.z, p.y)) this.crash(Math.random() < 0.5 ? -1 : 1, { kind: 'tumble' });
    } else if (t > 1e-6) {
      v.multiplyScalar(s / t); // smooth transitions keep their speed (the normal force does no work)
    }
  }

  // Groomed runs of the open world (not the purpose-built course regions) cross some steep rock
  // bands: skiers follow those pitches like a piste instead of flying off them. Park features keep
  // their real take-offs. (d < 3: the terrain shades grooming out to 3 m beyond the corridor.)
  onGroomedRun(x, z, y) {
    if (world.regionAt?.(x, z)) return false;
    const c = world.corridorAt?.(x, z, this._corr);
    return !!c && c.groomed && c.d < 3 && !parkFeatureAt(x, z, y);
  }

  airStep(h) {
    const p = this.pos, v = this.vel;
    if (this.air) this.airTime += h; else this.liftT += h;
    v.y -= G * h;
    if (!this.air) v.y -= STICK * h; // still "on" the snow: the legs reach down for it
    const sp = v.length();
    v.multiplyScalar(Math.max(0, 1 - DRAG * (CDA_AIR / (this.ski.speed * this.ski.speed)) * sp * h));
    p.addScaledVector(v, h);
    const gy = world.groundHeight(p.x, p.z, p.y);
    if (p.y <= gy) { if (this.air) this.land(gy); else this.reattach(gy); return; }
    if (!this.air && (p.y - gy > 0.18 || this.liftT > 0.35)) this.takeoff('terrain');
    this.collide(sp, p.y, p.y - gy); // obstacles lower than the skis are cleared
  }

  // Skis back on the snow after a brief separation: no landing, the speed along the snow carries on
  // and the legs soak up the rest (the extra pull-down over the crest never becomes speed).
  reattach(gy) {
    const p = this.pos, v = this.vel, n = this.normal;
    this.ballistic = false;
    p.y = gy;
    this.surfNormal(p.x, p.z, gy + 0.3, n, gy);
    const vn = v.dot(n), s = v.length();
    v.addScaledVector(n, -vn);
    const t = v.length();
    if (vn < -3) {
      if (t > 1e-6) v.multiplyScalar(Math.max(0, t - IMPACT_FRICTION * Math.max(0, -vn - IMPACT_FREE)) / t);
      this.absorbImpact(-vn);
    } else if (t > 1e-6 && vn > 0) v.multiplyScalar(s / t);
  }

  land(gy) {
    const p = this.pos, v = this.vel, n = this.normal;
    p.y = gy;
    this.surfNormal(p.x, p.z, gy + 0.3, n, gy);
    const impact = Math.max(0, -v.dot(n));
    v.addScaledVector(n, -v.dot(n));
    const vh = Math.hypot(v.x, v.z);
    const travel = vh > 0.7 ? Math.atan2(v.x, v.z) : this.heading;
    // the trick is judged on the spin (the skis' own steering in the air is not a trick error)
    const T = this.tricks;
    const yawErr = wrapPi(this.airHeading + T.spin - travel);
    const spinDir = Math.sign(T.spin) || 1;
    const flipVel = T.flipVel;
    const res = T.land({ yawErr, impact, speed: vh });
    this.air = false;
    this.ballistic = false;
    this.lastLanding = res;
    this.prevVelYaw = travel;

    if (res.landed === 'crash') {
      this.reportTrick(res);
      const kind = res.cause === 'flip' ? 'tumble' : res.cause === 'sideways' ? 'roll' : impact > 16 ? 'tumble' : 'roll';
      this.crash(Math.sign(yawErr) || (Math.random() < 0.5 ? -1 : 1), {
        kind, flip: res.cause === 'flip' ? this.flip : 0, pitchVel: res.cause === 'flip' ? flipVel : 0, impact,
      });
      return;
    }
    // the legs and the snow absorb the impact: hard flat landings lose speed, landings that match
    // the slope keep it; sloppy landings scrub a little more
    const s = v.length();
    let ns = Math.max(0, s - IMPACT_FRICTION * Math.max(0, impact - IMPACT_FREE));
    const off = res.switch ? Math.PI - Math.abs(yawErr) : Math.abs(yawErr);
    ns *= 1 - 0.5 * Math.sin(off) ** 2;
    if (res.landed === 'sketchy') ns *= 0.92;
    if (res.switch) ns *= 0.94; // the revert pivot
    if (s > 1e-6) v.multiplyScalar(ns / s);
    // skis line up with the travel direction (plus what the player steered in the air); the body
    // shows the landed angle and pivots out of it (a switch landing reverts all the way round,
    // continuing the spin's direction)
    this.heading = travel + this.airSteer;
    this.airSteer = 0;
    let fx = yawErr;
    if (res.switch) fx = spinDir > 0 ? (yawErr > 0 ? yawErr - TAU : yawErr) : (yawErr < 0 ? yawErr + TAU : yawErr);
    this.yawFx = fx; this.yawFxV = 0;
    this.flip = wrapPi(this.flip); // residual tilt eases out
    this.absorbImpact(impact);
    this.reportTrick(res);
  }

  // one-shot snow effect, drained each frame by skierFX (src/fx/snowfx.js)
  fx(e) { const q = this.rig.fx; if (q && q.length < 32) q.push(e); }

  reportTrick(res) {
    if (!res?.name) return;
    if (res.points > 0) this.audio?.play('trick', res.landed === 'clean' ? 1 : 0.6);
    this.onTrick?.(res);
  }

  absorbImpact(impact) {
    this.absorbV += Math.min(14, impact * 1.3);
    this.camDipV -= Math.min(5, impact * 0.32);
    this.shake = Math.max(this.shake, clamp((impact - 5) / 10, 0, 0.7));
    if (impact > 2.2) this.audio?.play('land', clamp(impact / 12, 0.12, 1));
    if (impact > 1.5) this.fx({ type: 'land', x: this.pos.x, y: this.pos.y, z: this.pos.z, amount: clamp(impact / 10, 0.1, 1) });
  }

  // Animation targets after the physics step: edge angle, crouch, braking pose, pole plants.
  animateSki(dt, ctl) {
    const v = this.vel, sp = v.length(), vh = Math.hypot(v.x, v.z);
    // stopped on flat ground for a moment -> take the skis off and walk
    if (!this.frozen && this.autoSkisOff && !this.air && sp < 0.6 && this.isFlatHere()) {
      this.flatT = (this.flatT || 0) + dt;
      if (this.flatT > 1.2) { this.flatT = 0; this.setSkisOn(false); this.events.push('skisOff'); return; }
    } else this.flatT = 0;

    // inclination from the real lateral acceleration (how fast the path curves) + a hint of input
    const velYaw = vh > 0.5 ? Math.atan2(v.x, v.z) : this.heading;
    const turn = !this.air && vh > 1 ? wrapPi(velYaw - this.prevVelYaw) / Math.max(dt, 1e-4) : 0;
    this.prevVelYaw = velYaw;
    this.turnRate = lerp(this.turnRate, clamp(turn, -4, 4), 1 - Math.exp(-dt * 12));
    const aLat = vh * this.turnRate; // + = curving left
    let inclT = this.air ? 0 : clamp(-Math.atan2(aLat, G) * 0.85 - this.steer * 0.1 * smoothstep(1, 6, vh), -0.95, 0.95);

    // braking: snowplow when slow, hockey stop at speed (skis across, body leaning back against it)
    const brake = ctl.brake && !this.air;
    const plowT = brake ? 1 - smoothstep(6, 9, sp) : 0;
    const skidT = brake ? smoothstep(4.5, 9, sp) : 0;
    this.plow = lerp(this.plow, plowT, 1 - Math.exp(-dt * 6));
    if (skidT > 0.05 && this.skidAmt < 0.05) this.skidSide = Math.abs(this.steer) > 0.2 ? Math.sign(this.steer) : this.lastTurnSide || 1;
    else if (brake && Math.abs(this.steer) > 0.3) this.skidSide = Math.sign(this.steer);
    this.skidAmt = lerp(this.skidAmt, skidT, 1 - Math.exp(-dt * (skidT > this.skidAmt ? 7 : 5)));
    this.skidYaw = lerp(this.skidYaw, this.skidSide * 1.05 * skidT, 1 - Math.exp(-dt * 7));
    if (this.skidAmt > 0.05) inclT = lerp(inclT, -Math.sign(this.skidYaw) * 0.45, this.skidAmt);
    this.edge = lerp(this.edge, inclT, 1 - Math.exp(-dt * 10));
    this.lean = clamp(this.edge / 0.8, -1, 1);

    // sideslip (spray, scrape sound): skidding skis, braking, reverts
    const slip = !this.air && vh > 1.5 ? Math.abs(Math.sin(wrapPi(velYaw - this.heading))) : 0;
    const revert = Math.abs(Math.sin(this.yawFx)) * 0.8;
    this.sideslip = lerp(this.sideslip, Math.max(slip * 1.3, this.skidAmt * 0.9, this.plow * 0.4, revert), 1 - Math.exp(-dt * 12));

    // crouch: athletic stance, deeper while charging a pop, legs snap straight on the pop,
    // compact in the air, absorbing landings (spring)
    this.tuck = ctl.tuck && sp > W_PUSH_V - 1 && !this.air;
    this.popT += dt;
    let crouchT = this.tuck ? 0.21 : brake ? 0.3 : 0.16 + Math.abs(this.steer) * 0.07 + Math.abs(this.edge) * 0.06; // turns only a little lower (no sitting back)
    if (this.charging && !this.air) crouchT = 0.3 + 0.62 * this.charge;
    if (this.air) crouchT = 0.32;
    const extend = this.popT < 0.16;
    if (extend) crouchT = -0.15;
    this.crouch = lerp(this.crouch, crouchT, 1 - Math.exp(-dt * (extend ? 26 : this.charging ? 9 : 7)));
    this.absorbV += (-60 * this.absorb - 15.5 * this.absorbV) * dt;
    this.absorb = clamp(this.absorb + this.absorbV * dt, 0, 0.8);
    if (this.absorb === 0 && this.absorbV < 0) this.absorbV = 0;

    // reverts and landing corrections pivot back to the skis' direction; residual flip tilt eases out
    if (this.yawFx !== 0 && !this.air) {
      spring(_set, this.yawFx, this.yawFxV, 0, 8.5, dt);
      this.yawFx = _set.x; this.yawFxV = _set.v;
      if (Math.abs(this.yawFx) < 0.002 && Math.abs(this.yawFxV) < 0.02) { this.yawFx = 0; this.yawFxV = 0; }
    }
    if (!this.air && this.flip !== 0) {
      this.flip *= Math.exp(-dt * 14);
      if (Math.abs(this.flip) < 1e-3) this.flip = 0;
    }

    // pole plants: at turn initiation, or rhythmic double-poling when skating / pushing off
    const sign = Math.sign(Math.round(this.steer * 1.5));
    if (sign !== 0 && sign !== this.lastSteerSign && sp > 3 && !this.air && !this.tuck && this.skidAmt < 0.3) {
      // inside pole: turning left (steer>0) -> left pole (0)
      const fw = _v.set(Math.sin(this.heading), 0, Math.cos(this.heading));
      this.rig.startPolePlant(sign > 0 ? 0 : 1, fw, _w.crossVectors(fw, UP));
    }
    this.lastSteerSign = sign;
    if (sign !== 0) this.lastTurnSide = sign;
    const launching = this.launch > 0 && sp < LAUNCH_V;
    const pushing = (ctl.skate && sp < PUSH_V) || (ctl.go && sp < W_PUSH_V - 1) || launching;
    if (pushing && !this.air && !ctl.brake && !this.parked) {
      this.skatePhase += dt * (launching ? 2.3 : 1.6);
      if (this.skatePhase > 1) {
        this.skatePhase = 0;
        const fw = _v.set(Math.sin(this.heading), 0, Math.cos(this.heading)), r = _w.crossVectors(fw, UP);
        this.rig.startPolePlant(0, fw, r); this.rig.startPolePlant(1, fw, r);
      }
    } else this.skatePhase = 0.7; // the first push comes right away
    // holding W at speed: now and then a double-pole push, the way skiers work their poles to keep going
    if (this.tuck && !this.air && sp < 14 && !this.parked && !ctl.brake) {
      this.tuckPoleT -= dt;
      if (this.tuckPoleT <= 0) {
        this.tuckPoleT = 1.7 + Math.random() * 1.1;
        const fw = _v.set(Math.sin(this.heading), 0, Math.cos(this.heading)), r = _w.crossVectors(fw, UP);
        this.rig.startPolePlant(0, fw, r); this.rig.startPolePlant(1, fw, r);
      }
    } else this.tuckPoleT = 0.5;
  }

  // ------------------------------------------------------------------ crashes
  // Wipeout: tumble (forward somersaults), roll (sideways) or slam (topple over), slide to a stop
  // on the snow, lie there a moment, then get back up. Emits one 'crash' event per wipeout.
  crash(side = 1, opts = {}) {
    if (this.mode === 'fall') return;
    const v = this.vel, sp = v.length(), vh = Math.hypot(v.x, v.z);
    this.mode = 'fall';
    this.fallT = 0;
    this.fallSide = side || (Math.random() < 0.5 ? -1 : 1);
    this.fallAir = this.air || this.ballistic;
    this.air = false;
    this.ballistic = false;
    this.parked = false;
    this.charging = false; this.charge = 0;
    this.tricks.cancel();
    const F = this.fall;
    const kind = opts.kind || (sp > 11 ? 'tumble' : sp > 6 ? 'roll' : 'slam');
    F.t = 0; F.state = 'tumble'; F.kind = kind;
    F.pitch = wrapPi(opts.flip || 0); F.pitchVel = 0; F.roll = 0; F.rollVel = 0;
    F.pitchTarget = null; F.rollTarget = null;
    F.getUp = 0; F.lieT = 0; F.slideFx = 0;
    F.bump = opts.event === 'bump'; // (knocked over running into somebody: not a wipeout, game/peoplehits.js)
    // the tumble axis follows the slide: rotating about the travel direction's sideways axis
    const travel = vh > 1 ? Math.atan2(v.x, v.z) : this.heading;
    F.axisHeading = travel;
    if (kind === 'tumble') {
      const dir = Math.sign(opts.pitchVel || 0) || 1;
      F.pitchVel = dir * Math.max(Math.abs(opts.pitchVel || 0), clamp(sp * 0.42, 4, 11));
    } else if (kind === 'roll') {
      F.rollVel = this.fallSide * clamp(sp * 0.4, 3, 9);
    }
    F.ball = kind === 'slam' ? 0.25 : 1;
    this.heading += this.yawFx;
    this.flip = 0; this.yawFx = 0; this.yawFxV = 0; this.airSteer = 0;
    this.absorb = 0; this.absorbV = 0;
    this.shake = 1;
    this.audio?.play('crash');
    this.fx({ type: 'crash', x: this.pos.x, y: this.pos.y, z: this.pos.z, amount: clamp(sp / 18, 0.3, 1), vx: v.x, vz: v.z });
    this.events.push(opts.event || 'crash'); // ('bump': ran into somebody, main.js counts no strike)
  }

  updateFall(dt) {
    const F = this.fall, v = this.vel, p = this.pos, n = this.normal;
    F.t += dt;
    this.fallT = F.t;
    if (this.fallAir) {
      // still airborne (crashed into something mid-air): fall onto the snow
      v.y -= G * dt;
      p.addScaledVector(v, dt);
      const gy = world.groundHeight(p.x, p.z, p.y);
      if (p.y <= gy) {
        p.y = gy;
        this.surfNormal(p.x, p.z, gy + 0.3, n, gy);
        const imp = Math.max(0, -v.dot(n));
        v.addScaledVector(n, -v.dot(n)).multiplyScalar(Math.max(0.2, 1 - imp * 0.05));
        this.fallAir = false;
        this.shake = Math.max(this.shake, 0.8);
        this.audio?.play('land', clamp(imp / 10, 0.3, 1));
        this.fx({ type: 'impact', x: p.x, y: p.y, z: p.z, amount: clamp(imp / 10, 0.3, 1) });
      }
    } else {
      // body sliding on the snow: gravity along the slope against heavy friction
      const a = _a.set(0, -G, 0).addScaledVector(n, G * n.y);
      v.addScaledVector(a, dt);
      const s = v.length();
      const stop = F.state === 'tumble' ? BODY_SLIDE : BODY_SLIDE * 1.3; // limbs dig in once it stops rolling
      if (s > 1e-4) v.multiplyScalar(Math.max(0, s - stop * dt) / s);
      if (F.state === 'getup' || (F.state === 'lie' && s < 1)) v.multiplyScalar(Math.exp(-dt * 6));
      v.addScaledVector(n, -v.dot(n));
      p.addScaledVector(v, dt);
      const gy = world.groundHeight(p.x, p.z, p.y + 0.3);
      p.y = gy;
      this.surfNormal(p.x, p.z, gy + 0.3, n, gy);
      v.addScaledVector(n, -v.dot(n));
      // snow sprays off the sliding body
      F.slideFx += dt * Math.min(1, s / 6);
      if (F.slideFx > 0.09 && s > 2) {
        F.slideFx = 0;
        this.fx({ type: 'slide', x: p.x, y: p.y, z: p.z, amount: clamp(s / 12, 0.2, 1), vx: v.x, vz: v.z });
      }
    }
    this.collide(0, p.y);
    const sp = v.length();
    const side = this.fallSide;

    if (F.state === 'tumble') {
      let settled = true;
      if (F.kind === 'tumble') {
        if (F.pitchTarget === null && (Math.abs(F.pitchVel) < 3.2 || (sp < 3 && F.t > 0.5))) {
          // slow enough: finish onto the nearest full turn, then topple onto the side
          const rest = F.pitch + (F.pitchVel * Math.abs(F.pitchVel)) / (2 * 7);
          F.pitchTarget = Math.round(rest / TAU) * TAU;
        }
        if (F.pitchTarget === null) {
          F.pitchVel *= Math.exp(-dt * (this.fallAir ? 0.2 : 0.9));
          F.pitch += F.pitchVel * dt;
          settled = false;
        } else {
          spring(_set, F.pitch, F.pitchVel, F.pitchTarget, 6, dt);
          F.pitch = _set.x; F.pitchVel = _set.v;
          if (F.rollTarget === null) F.rollTarget = side * Math.PI / 2;
          settled = Math.abs(F.pitch - F.pitchTarget) < 0.05 && Math.abs(F.pitchVel) < 0.4;
        }
      } else if (F.kind === 'roll') {
        if (F.rollTarget === null && (Math.abs(F.rollVel) < 3 || (sp < 3 && F.t > 0.5))) {
          const rest = F.roll + (F.rollVel * Math.abs(F.rollVel)) / (2 * 7);
          F.rollTarget = Math.round((rest - side * Math.PI / 2) / TAU) * TAU + side * Math.PI / 2;
        }
        if (F.rollTarget === null) {
          F.rollVel *= Math.exp(-dt * (this.fallAir ? 0.2 : 0.9));
          F.roll += F.rollVel * dt;
          settled = false;
        }
      } else if (F.rollTarget === null) {
        F.rollTarget = side * Math.PI / 2; // slam: topple over sideways
      }
      if (F.rollTarget !== null) {
        spring(_set, F.roll, F.rollVel, F.rollTarget, F.kind === 'slam' ? 5.5 : 5, dt);
        F.roll = _set.x; F.rollVel = _set.v;
        settled = settled && Math.abs(F.roll - F.rollTarget) < 0.06 && Math.abs(F.rollVel) < 0.5;
      }
      // tucked into a ball while rolling fast, relaxing as it slows
      const spinning = Math.abs(F.pitchVel) + Math.abs(F.rollVel) > 3 && F.kind !== 'slam';
      F.ball = lerp(F.ball, spinning ? 1 : 0, 1 - Math.exp(-dt * (spinning ? 8 : 3)));
      if ((settled && sp < 1.5 && F.t > 0.6 && !this.fallAir) || F.t > 6) {
        F.state = 'lie'; F.lieT = 0;
        F.pitch -= Math.round(F.pitch / TAU) * TAU; F.pitchVel = 0;
        F.roll = F.roll - Math.round((F.roll - side * Math.PI / 2) / TAU) * TAU; F.rollVel = 0;
        if (Math.abs(F.roll - side * Math.PI / 2) > 0.2) F.roll = side * Math.PI / 2;
        F.rollRest = F.roll;
      }
    } else if (F.state === 'lie') {
      F.lieT += dt;
      F.ball = lerp(F.ball, 0, 1 - Math.exp(-dt * 4));
      F.pitch *= Math.exp(-dt * 5);
      if ((F.lieT > 0.55 && sp < 0.6) || F.lieT > 2.5) { F.state = 'getup'; F.getUp = 0; }
    } else if (F.state === 'getup') {
      F.getUp = Math.min(1, F.getUp + dt / GETUP_TIME);
      F.ball = lerp(F.ball, 0, 1 - Math.exp(-dt * 6));
      F.pitch *= Math.exp(-dt * 6);
      F.roll = F.rollRest * (1 - smoothstep(0, 0.62, F.getUp));
      if (F.getUp >= 1) {
        this.mode = this.skisOn ? 'ski' : 'walk';
        this.vel.set(0, 0, 0);
        this.resetAirState();
        this.resetFall();
        this.crouch = 0.45;
        this.parked = true; // back on your feet: stand still until you move
      }
    }
  }

  // ------------------------------------------------------------------ walking
  // Ski boots on snow: normal on the flat, the village and gentle paths, slower uphill, and no
  // climbing up mountains (above ~38 degrees you stop and slip back: lifts and the bus go up).
  updateWalk(dt) {
    const inp = this.input;
    const live = !this.frozen;
    const fw = live ? (inp.down('KeyW') || inp.down('ArrowUp') ? 1 : 0) - (inp.down('KeyS') || inp.down('ArrowDown') ? 1 : 0) : 0;
    const sd = live ? (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0) - (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0) : 0;
    const yaw = this.view === 'first' ? this.heading + this.lookYaw : this.camYaw;
    const cf = _cf.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // camera forward
    if (this.view === 'first') cf.set(Math.sin(yaw), 0, Math.cos(yaw));
    const cr = _cr.crossVectors(cf, UP);
    const dir = _dir.copy(cf).multiplyScalar(fw).addScaledVector(cr, sd);
    const p = this.pos;
    const feetY = p.y - (this.footJumpY || 0);
    // terrain grade under the boots (decks, bridges and ramps are built to be walked on)
    const onTerrain = world.groundHeight(p.x, p.z, feetY + 0.3) < world.meshHeight(p.x, p.z) + 0.03;
    const gx = onTerrain ? (world.height(p.x + 1, p.z) - world.height(p.x - 1, p.z)) / 2 : 0;
    const gz = onTerrain ? (world.height(p.x, p.z + 1) - world.height(p.x, p.z - 1)) / 2 : 0;
    const slope = Math.hypot(gx, gz);
    const ux = slope > 1e-6 ? gx / slope : 0, uz = slope > 1e-6 ? gz / slope : 0; // uphill direction
    let blocked = false;
    // Shift sprints (Oct 28, the user): 1.5x for as long as you hold it (no limit, no cooldown)
    const sprinting = !this.frozen && dir.lengthSq() > 0 && (this.input.down('ShiftLeft') || this.input.down('ShiftRight'));
    if (dir.lengthSq() > 0) {
      dir.normalize();
      const want = Math.atan2(dir.x, dir.z);
      let target = FOOT_SPEED * (sprinting ? SPRINT_K : 1);
      const up = dir.x * ux + dir.z * uz; // > 0: some of the step goes uphill
      if (up > 0 && slope > WALK_FULL) {
        // the uphill part of the step fades out between 22 and 38 degrees of terrain; what's left is a
        // level traverse (so zig-zagging up a steep face doesn't work either), and it's slower going
        const k = smoothstep(WALK_FULL, WALK_MAX, slope);
        dir.x -= ux * up * k; dir.z -= uz * up * k;
        target *= 1 - 0.4 * k * up;
        blocked = k > 0.97 && up > 0.6; // walking straight into a slope that's too steep
      }
      if (this.view !== 'first') this.heading = dampAngle(this.heading, want, dt * 10);
      this.vel.lerp(dir.multiplyScalar(target), 1 - Math.exp(-dt * 8));
    } else {
      this.vel.multiplyScalar(Math.exp(-dt * 10));
    }
    // too steep: the boots slip back a little; main.js shows "too steep to walk up" once
    if (blocked) {
      if (this.steepT === 0) this.walkSlip = 0.55;
      this.steepT += dt; this.steepOkT = 0;
      if (this.steepT > 0.3 && !this.steepWarned) { this.steepWarned = true; this.events.push('tooSteep'); }
    } else {
      this.steepT = 0;
      this.steepOkT += dt;
      if (this.steepOkT > 4) this.steepWarned = false;
    }
    if (this.view === 'first') {
      // walking in first person: body yaw follows the camera
      this.heading += this.lookYaw;
      this.lookYaw = 0;
    }
    this.vel.y = 0;
    p.addScaledVector(this.vel, dt);
    if (this.walkSlip > 0.01) {
      // a short slip back down the slope (not part of the walking momentum)
      p.x -= ux * this.walkSlip * dt; p.z -= uz * this.walkSlip * dt;
      this.walkSlip *= Math.exp(-dt * 4);
    } else this.walkSlip = 0;
    // jumping on foot
    if (live && inp.hit('Space') && !this.footAir) { this.footJumpV = 4.4; this.footAir = true; this.audio?.play('jump'); }
    const ground = world.groundHeight(p.x, p.z, feetY + 0.3);
    if (this.footAir) {
      this.footJumpY = (this.footJumpY || 0) + this.footJumpV * dt;
      this.footJumpV -= 9.81 * dt;
      if (this.footJumpY <= 0) { this.footJumpY = 0; this.footAir = false; this.audio?.play('step'); this.shake = 0.15; }
    }
    p.y = ground + (this.footJumpY || 0);
    this.collide(0, p.y);
    this.footT = (this.footT || 0) + Math.hypot(this.vel.x, this.vel.z) * dt;
    if (this.footT > 1.3) { // a step every 1.3 m (you always move at the sprint pace on foot)
      this.footT = 0;
      this.audio?.play('step');
      this.stepSide = -(this.stepSide || 1);
      this.onStep?.(p.x, p.z, this.heading, this.stepSide);
    }
  }

  // ------------------------------------------------------------------ lifts
  sitOn(seat) { this.mode = 'sit'; this.seat = seat; this.vel.set(0, 0, 0); this.resetAirState(); }
  standUp(x, z, heading) {
    this.seat = null;
    this.mode = this.skisOn ? 'ski' : 'walk';
    this.teleport(x, z, heading);
  }
  updateSit(dt) {
    if (!this.seat) return;
    this.pos.copy(this.seat.pos);
    this.heading = Math.atan2(this.seat.fwd.x, this.seat.fwd.z);
  }

  // ------------------------------------------------------------------ collisions
  // `feetY`: height of the skis; obstacles with a known top below it are cleared (jumped over).
  // Colliders without a `top` count as ~2.5 m tall (`above`: height of the skis over the snow).
  collide(speed, feetY = -Infinity, above = 0) {
    const p = this.pos;
    const R = 0.35;
    for (const c of this.colliders) {
      if (c.top !== undefined ? feetY > c.top : above > 2.5) continue;
      // cheap reject first: most colliders (nets, signs, markers) are far away
      const reach = (c.r ?? Math.max(c.hw, c.hd)) + R;
      if (Math.abs(p.x - c.x) > reach || Math.abs(p.z - c.z) > reach) continue;
      if (c.r !== undefined) {
        const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz);
        if (d < c.r + R) {
          const nx = dx / (d || 1), nz = dz / (d || 1);
          p.x = c.x + nx * (c.r + R); p.z = c.z + nz * (c.r + R);
          this.bounce(nx, nz, speed, c);
        }
      } else {
        // oriented box
        const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
        const lx = (p.x - c.x) * cs - (p.z - c.z) * sn, lz = (p.x - c.x) * sn + (p.z - c.z) * cs;
        const ox = c.hw + R - Math.abs(lx), oz = c.hd + R - Math.abs(lz);
        if (ox > 0 && oz > 0) {
          let nlx = 0, nlz = 0;
          if (ox < oz) nlx = Math.sign(lx) || 1; else nlz = Math.sign(lz) || 1;
          const push = Math.min(ox, oz);
          const c2 = Math.cos(c.rot), s2 = Math.sin(c.rot);
          const nx = nlx * c2 - nlz * s2, nz = nlx * s2 + nlz * c2;
          p.x += nx * push; p.z += nz * push;
          this.bounce(nx, nz, speed, c);
        }
      }
    }
    // other people (skiers, villagers): you bump off them like off a net, never a wipeout. In free ride, skiing
    // into somebody at speed knocks you both over (onPersonHit: game/peoplehits.js, true = handled: you fell)
    const people = this.people?.();
    if (people) {
      for (const c of people) {
        const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), rr = PERSON_R + R;
        if (d < rr && d > 1e-4 && Math.abs(c.y - p.y) < 2) {
          const nx = dx / d, nz = dz / d;
          p.x = c.x + nx * rr; p.z = c.z + nz * rr;
          let hit = false;
          if (this.onPersonHit && (this.mode === 'ski' || this.mode === 'walk')) {
            try { hit = this.onPersonHit(c, nx, nz) === true; } catch (e) { hit = false; }
          }
          if (!hit) this.bounce(nx, nz, speed, PERSON);
          else break; // (knocked over: one person per incident)
        }
      }
    }
    // only big boulders stop you: smaller rocks are skied over (they sit half buried in the snow)
    // trees: only the trunk stops you, the branches are skied through
    const hit = this.vegetation?.collide(p.x, p.z, R, BIG_ROCK, true);
    const top = hit ? obstacleTop(hit) : 0;
    if (hit && !(Number.isFinite(top) ? feetY > top : above > 2.5)) {
      const dx = p.x - hit.x, dz = p.z - hit.z, d = Math.hypot(dx, dz) || 1, hr = hit.trunk ?? hit.r;
      p.x = hit.x + (dx / d) * (hr + R + 0.01); p.z = hit.z + (dz / d) * (hr + R + 0.01);
      this.bounce(dx / d, dz / d, speed);
    }
  }

  bounce(nx, nz, speed, c) {
    const vn = this.vel.x * nx + this.vel.z * nz;
    // safety nets (and other thin boards: fences, sign panels) catch the skier like a real B-net:
    // the hit is absorbed, you lose speed and roll back off it, but you never wipe out on them
    const soft = c && (c.net || c.soft || (c.r === undefined && Math.min(c.hw, c.hd) <= 0.35 && Math.max(c.hw, c.hd) >= 1.2));
    if (vn < 0 && soft) {
      const hard = -vn;
      this.vel.x -= nx * vn * 1.25; this.vel.z -= nz * vn * 1.25; // a soft 25 % bounce back off the net
      this.vel.multiplyScalar(Math.max(0.45, 1 - hard * 0.035));
      if (hard > 3) { this.audio?.play('land', Math.min(1, hard / 14)); this.shake = Math.max(this.shake || 0, Math.min(0.5, hard / 16)); }
      return;
    }
    if (vn < 0) {
      if (this.mode === 'ski' && -vn > CRASH_HIT) { // slow knocks just push you off; a fast head-on hit wipes you out
        const hard = -vn;
        this.vel.x -= nx * vn * 1.3; this.vel.z -= nz * vn * 1.3;
        this.vel.multiplyScalar(0.3);
        this.crash(Math.random() < 0.5 ? -1 : 1, { kind: hard > 12 ? 'roll' : 'slam' });
      } else {
        this.vel.x -= nx * vn; this.vel.z -= nz * vn;
      }
    }
  }

  // ------------------------------------------------------------------ camera
  updateCamera(dt) {
    const cam = this.camera;
    const sp = this.speed;
    const now = performance.now();
    // springs: landing dip, crash shake, FOV kicks, airborne pull-back
    this.camDipV += (-90 * this.camDip - 15 * this.camDipV) * dt;
    this.camDip = clamp(this.camDip + this.camDipV * dt, -0.9, 0.5);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.fovKick = Math.max(0, this.fovKick - dt * 2.5);
    const longAir = this.air && this.airTime > 0.25 ? 1 : 0;
    this.airBlend = lerp(this.airBlend, longAir, 1 - Math.exp(-dt * (longAir ? 2.5 : 4)));
    // high-speed buffeting: a few layered low-amplitude oscillations (no per-frame noise)
    const t = now * 0.001;
    const fast = this.mode === 'ski' && !this.air ? smoothstep(15, 36, sp) : 0;
    const vib = fast * 0.009 + this.shake * 0.05;
    const jitter = _jit.set(
      (Math.sin(t * 57) * 0.6 + Math.sin(t * 31.7 + 1) * 0.4) * vib,
      (Math.sin(t * 49 + 2) * 0.6 + Math.sin(t * 23.3) * 0.4) * vib,
      (Math.sin(t * 43 + 4) * 0.6 + Math.sin(t * 37.1 + 3) * 0.4) * vib,
    );

    if (this.view === 'first' && !this.fpCrash) this.updateFirstPerson(dt, cam, sp, now);
    else {
      cam.near = 0.1;
      const vh = Math.hypot(this.vel.x, this.vel.z);
      // direction of travel: the path, never the spinning or tumbling body
      if (vh > 1.5 && this.mode !== 'sit') this.travelYaw = dampAngle(this.travelYaw, Math.atan2(this.vel.x, this.vel.z), dt * (this.air ? 3 : 6));
      else if (this.mode !== 'fall') this.travelYaw = dampAngle(this.travelYaw, this.heading, dt * 4);
      // auto-follow behind the direction of travel when the mouse is idle
      if (this.mode !== 'walk' && now - this.lastMouse > 1200) {
        const d = wrapPi(this.travelYaw + Math.PI - this.camYaw);
        const rate = this.mode === 'sit' ? 2.2 : this.air ? 1.3 : this.mode === 'fall' ? 0.8 : 2.0 + fast * 1.5;
        this.camYaw += d * (1 - Math.exp(-dt * rate));
        this.camPitch = lerp(this.camPitch, -0.16 - this.airBlend * 0.1 - fast * 0.03, 1 - Math.exp(-dt * 1.5));
      }
      // focus: the skier's chest, a little ahead along the motion; vertical bumps are smoothed
      const skiing = this.mode === 'ski';
      const ahead = skiing ? Math.min(1.3, vh * 0.045) : 0;
      _a.set(this.vel.x, 0, this.vel.z);
      if (vh > 0.1) _a.multiplyScalar(ahead / vh);
      this.camLook.lerp(_a, 1 - Math.exp(-dt * 4));
      const focusH = this.mode === 'sit' ? 0.6 : this.mode === 'fall' ? 0.85 : 1.45 - (skiing ? clamp(this.crouch, 0, 1) * 0.25 : 0);
      const fy = this.pos.y + focusH;
      // a big jump in height (teleport) snaps; a long fall never does: the focus trails by at most 2.5 m
      // (snapping whenever it fell 4 m behind jerked the view up and down on big drops)
      if (this.camFocusY === null || Math.abs(this.camFocusY - fy) > 40) this.camFocusY = fy;
      this.camFocusY = lerp(this.camFocusY, fy, 1 - Math.exp(-dt * (this.mode === 'sit' ? 60 : this.air ? 9 : 14)));
      this.camFocusY = clamp(this.camFocusY, fy - 2.5, fy + 2.5);
      const focus = _fo.set(this.pos.x + this.camLook.x, this.camFocusY + this.camDip * 0.5, this.pos.z + this.camLook.z);
      const dist = (this.mode === 'sit' ? Math.max(this.camDist, 8) : this.camDist) + clamp(sp - 12, 0, 25) * 0.04
        + this.airBlend * 0.9 + (this.mode === 'fall' ? 0.6 : 0);
      // camYaw/camPitch describe where the camera sits around the player
      const desired = _w.set(
        focus.x + Math.sin(this.camYaw) * Math.cos(this.camPitch) * dist,
        focus.y - Math.sin(this.camPitch) * dist + 0.3,
        focus.z + Math.cos(this.camYaw) * Math.cos(this.camPitch) * dist,
      );
      // keep above the snow, also halfway so a bump between us doesn't swallow the view
      const gy = world.groundHeight(desired.x, desired.z, focus.y) + 0.5;
      if (desired.y < gy) desired.y = gy;
      const mx = (desired.x + focus.x) / 2, mz = (desired.z + focus.z) / 2, my = (desired.y + focus.y) / 2;
      const gm = world.groundHeight(mx, mz, focus.y) + 0.35;
      if (my < gm) desired.y += (gm - my) * 2;
      // keep the camera out of buildings: pull it in front of the first wall between it and the player
      if (this.cameraBlockers?.length) {
        const to = _l.copy(desired).sub(focus);
        const len = to.length();
        this._ray ??= new THREE.Raycaster();
        this._ray.set(focus, to.divideScalar(len));
        this._ray.far = len;
        const hit = this._ray.intersectObjects(this.cameraBlockers, true)[0];
        if (hit) desired.copy(focus).addScaledVector(this._ray.ray.direction, Math.max(0.6, hit.distance - 0.3));
      }
      // riding a lift (possibly fast-forwarded): follow tightly so the view never trails the cabin
      this.camPos.lerp(desired, 1 - Math.exp(-dt * (this.mode === 'sit' ? 60 : 12)));
      cam.position.copy(this.camPos).add(jitter);
      cam.position.y += this.camDip;
      cam.up.set(0, 1, 0);
      cam.lookAt(focus);
      const fov = this.tpFov + clamp(sp - 10, 0, 30) * 0.4 + this.fovKick * 2 + this.airBlend * 2;
      cam.fov = lerp(cam.fov, fov, 1 - Math.exp(-dt * 3));
    }
    cam.updateProjectionMatrix();
    // first person on skis: the gloves-and-poles view model rides on the camera (hidden otherwise)
    this.rig.updateFpView?.(dt, cam, this.fpViewState(sp));
  }

  // First person: a helmet cam (see FP_*). Skiing: the eyes of your own (visible) body over the boots, so
  // looking down shows your legs on the bindings. On foot and seated: the eyes of the walking / sitting body.
  // The eye is the posed head, smoothed relative to the feet (no lag at speed, no jitter from the pose).
  // (Wipeouts are watched from the third-person camera: updateFpCrash.)
  updateFirstPerson(dt, cam, sp, now) {
    const S = this.fpCam ??= {
      off: new THREE.Vector3(), offV: new THREE.Vector3(), init: false, lead: 0, leadV: 0, roll: 0, rollV: 0,
      mode: null, blend: 1, fromQ: new THREE.Quaternion(), fromP: new THREE.Vector3(),
      flipQ: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'YXZ'), q: new THREE.Quaternion(), tq: new THREE.Quaternion(), t: 0,
    };
    const h = clamp(dt, 0, 0.05);
    const skiing = this.mode === 'ski', sit = this.mode === 'sit';
    S.t += h;
    // a change of mode (back up after a wipeout, clicking into the skis, sitting down) would jump the view:
    // ease over from the last frame
    if (S.mode !== this.mode) {
      if (S.mode !== null) { S.fromQ.copy(cam.quaternion); S.fromP.copy(cam.position); S.blend = 0; }
      S.mode = this.mode;
    }

    // ---- the eye: your own head as posed this frame, relative to the feet, smoothed (springs)
    const tgt = _fo.copy(this.rig.eyeStable).sub(this.rig.root.position);
    if (tgt.lengthSq() > 9) tgt.set(0, FP_EYE_H, 0); // (no pose yet)
    if (!S.init || tgt.distanceToSquared(S.off) > 2.25) { S.off.copy(tgt); S.offV.set(0, 0, 0); S.init = true; }
    const wH = skiing ? 40 : sit ? 18 : 16, wV = skiing ? 32 : sit ? 18 : 13;
    spring(_set, S.off.x, S.offV.x, tgt.x, wH, h); S.off.x = _set.x; S.offV.x = _set.v;
    spring(_set, S.off.y, S.offV.y, tgt.y, wV, h); S.off.y = _set.x; S.offV.y = _set.v;
    spring(_set, S.off.z, S.offV.z, tgt.z, wH, h); S.off.z = _set.x; S.offV.z = _set.v;
    // never more than a couple of centimetres behind the head (a pop or a landing moves it fast): the eye has to
    // stay in front of where the (collapsed) head is
    const lag = _w.subVectors(S.off, tgt), maxLag = skiing ? 0.02 : 0.04;
    if (lag.lengthSq() > maxLag * maxLag) S.off.copy(tgt).addScaledVector(lag, maxLag / lag.length());
    const eye = _v.copy(this.pos).add(S.off);
    eye.y += this.camDip * 0.3;
    // the head goes with the hands: a pole push dips it a little forward and down (Oct 27, the user: "move the camera
    // too"), so the hands never look like they float on their own
    if (skiing && this.rig.plant) {
      let push = 0;
      for (const pl of this.rig.plant) if (pl.t < 1) push = Math.max(push, smoothstep(0, 0.25, pl.t) * (1 - smoothstep(0.35, 0.85, pl.t)));
      eye.y -= 0.03 * push;
      eye.x += Math.sin(this.heading) * 0.04 * push; eye.z += Math.cos(this.heading) * 0.04 * push;
    }

    // ---- where you look: the skis' heading, a little ahead into a turn, plus the mouse
    const yaw0 = this.heading + (skiing ? this.yawFx : 0);
    // looking down tips the head forward over the chest: the eyes come forward and down a little (and the
    // collar stays out of the picture)
    const nod = smoothstep(0.45, 1.4, -(this.fpBase + this.lookPitch));
    if (nod > 0) { const yl = yaw0 + this.lookYaw; eye.x += Math.sin(yl) * 0.085 * nod; eye.z += Math.cos(yl) * 0.085 * nod; eye.y -= 0.03 * nod; }
    const leadT = skiing && !this.air ? clamp(this.turnRate * FP_LEAD, -FP_LEAD_MAX, FP_LEAD_MAX) * smoothstep(3, 9, sp) : 0;
    spring(_set, S.lead, S.leadV, leadT, 6.5, h); S.lead = _set.x; S.leadV = _set.v;
    // the pitch of the snow along the way you're going (look down a steep run), in the air the flight path
    // (look up off the lip, down at the landing)
    let slope = 0;
    if (skiing) {
      const fx = Math.sin(yaw0), fz = Math.cos(yaw0), n = this.normal, v = this.vel;
      slope = this.air ? 0.7 * clamp(Math.atan2(v.y, Math.max(2, Math.hypot(v.x, v.z))), -0.75, 0.45) : Math.atan2(-(n.x * fx + n.z * fz), n.y);
    }
    this.fpSlope = lerp(this.fpSlope, slope, 1 - Math.exp(-h * (this.air ? 2.5 : 3)));
    // base look-down eases in when you click into the skis, out when you walk
    this.fpBase = lerp(this.fpBase, skiing ? FP_PITCH + FP_SLOPE_PITCH * this.fpSlope : 0, 1 - Math.exp(-h * 4));
    let pitch = this.fpBase + this.lookPitch - this.absorb * 0.2;
    if (skiing && this.popT < 0.25) pitch += 0.05 * Math.sin((this.popT / 0.25) * Math.PI); // the pop lifts the head
    // the head banks a little into the carve (never more than a few degrees: a steady horizon)
    const bankT = skiing && !this.air ? clamp(-this.edge * FP_BANK, -FP_BANK_MAX, FP_BANK_MAX) : 0;
    spring(_set, S.roll, S.rollV, bankT, 5.5, h); S.roll = _set.x; S.rollV = _set.v;
    const roll = S.roll;
    pitch = clamp(pitch, -1.5, 1.3);
    // speed: a fine buzz through the skis (more when skidding), and the shake of hard landings
    const fast = skiing && !this.air ? smoothstep(14, 34, sp) : 0;
    const chatter = skiing && !this.air ? clamp(this.sideslip, 0, 1) * smoothstep(5, 14, sp) : 0;
    const amp = fast * 0.0022 + chatter * 0.0035 + this.shake * 0.014;
    const t = S.t;
    const buzz = (a, b, c) => (Math.sin(t * a + c) * 0.6 + Math.sin(t * b + c * 1.7) * 0.4) * amp;
    S.e.set(pitch + buzz(71, 43.7, 0.3), yaw0 + S.lead + this.lookYaw + Math.PI + buzz(53, 31.3, 1.9) * 0.5, roll + buzz(59, 37.1, 4.1) * 0.7, 'YXZ');
    const q = S.q.setFromEuler(S.e);
    // flips: the helmet cam goes round with you, about the body's center (the rig turns the body the same way)
    const flip = skiing ? this.flip : 0;
    if (flip && this.rig.fpFlipC) {
      const hd = this.airTravel, C = this.rig.fpFlipC;
      S.flipQ.setFromAxisAngle(_w.set(-Math.cos(hd), 0, Math.sin(hd)), -flip);
      q.premultiply(S.flipQ);
      eye.sub(C).applyQuaternion(S.flipQ).add(C);
    }
    // ease over a mode change (rotations; positions only when they didn't jump: a teleport or the third-person
    // crash camera just cut back)
    if (S.blend < 1) {
      S.blend = Math.min(1, S.blend + h / 0.3);
      const k = smoothstep(0, 1, S.blend);
      q.slerpQuaternions(S.fromQ, S.tq.copy(q), k);
      if (S.fromP.distanceToSquared(eye) < 4) eye.lerpVectors(S.fromP, _w.copy(eye), k);
    }
    cam.position.copy(eye);
    cam.quaternion.copy(q);
    cam.near = FP_NEAR;
    const fov = (this.fpFov || FP_FOV) + clamp(sp - 10, 0, 30) * FP_FOV_SPEED + this.fovKick * 2.5;
    cam.fov = lerp(cam.fov, fov, 1 - Math.exp(-h * 3));
    // when not dragging the mouse, the view slowly re-centers on the skis while skiing
    if (skiing && now - this.lastMouse > 1500) {
      this.lookYaw *= Math.exp(-dt * 1.5);
      this.lookPitch *= Math.exp(-dt * 1.0);
    }
  }

  // First person, wiping out: the third-person camera takes over for the fall, starting just behind your head and
  // pulling out to watch the tumble; when you're up again the first-person view eases back in (updateFirstPerson).
  // (Picked up off the snow by the rescue helicopter's winch you stay in view too: its shots film you.)
  updateFpCrash() {
    const on = this.view === 'first' && (this.mode === 'fall' || (!!this.fpCrash && this.mode === 'sit'));
    if (on === !!this.fpCrash) return;
    this.fpCrash = on;
    if (on) {
      const c = this.camera.position, vh = Math.hypot(this.vel.x, this.vel.z);
      this.travelYaw = vh > 1.5 ? Math.atan2(this.vel.x, this.vel.z) : this.heading;
      this.camPos.set(c.x - Math.sin(this.travelYaw) * 0.8, c.y + 0.3, c.z - Math.cos(this.travelYaw) * 0.8);
      this.camYaw = this.travelYaw + Math.PI; this.camPitch = -0.22;
      this.camFocusY = null; this.camLook.set(0, 0, 0); this.lastMouse = 0;
    } else if (this.fpCam) this.fpCam.mode = 'crash'; // (a mode change: the view eases over)
  }

  // What the first-person hands react to (rig.updateFpView): reused object, filled once per frame.
  fpViewState(sp) {
    const o = this._fpv ??= {};
    o.skiing = this.view === 'first' && this.mode === 'ski';
    if (!o.skiing) return o;
    o.speed = sp; o.tuck = this.tuck ? 1 : 0; o.edge = this.edge; o.air = this.air; o.absorb = this.absorb;
    o.charge = this.charging && !this.air ? this.charge : 0;
    o.pop = this.popT < 0.25 ? Math.sin((this.popT / 0.25) * Math.PI) : 0;
    o.brake = this.skidAmt; o.grab = this.grabVis; o.grabType = this.tricks.grabType; o.spin = this.spinVis;
    return o;
  }
}
