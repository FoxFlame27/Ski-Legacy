// People that exist only while a job needs them: the chef or lift operator waiting for a parcel,
// a skier sitting hurt in the snow, a guest following you down the mountain. They use the game's own
// skier rigs (procedurally posed, same as the player) with a plain stand-in figure if a model is missing.
// Rigs come from a small pool built while the game loads (a rig takes tens of milliseconds to build,
// far too long for the frame that closes the job dialog) and go back to it afterwards.
// Posing is level-of-detail'd: full rate up close, 10 Hz further out, frozen beyond 160 m, hidden
// beyond 450 m; a skier sitting in the snow is posed once (while still out of sight) and then costs nothing.
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { makeFallbackFigure } from './props.js';
import { worldPos, rotateWorld, setWorldQuat, solveTwoBone, SkinSampler, regionVerts, SnowPatch } from './pose.js';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C = new THREE.Vector3(), _D = new THREE.Vector3(), _E = new THREE.Vector3();
const _F = new THREE.Vector3(), _G = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const SHOW_R2 = 450 * 450, POSE_R2 = 160 * 160, FULL_R2 = 45 * 45;
const SIT_SINK = 0.015;   // a seated body settles this far into the snow
const DOWN_STEPS = ['pose', 'seat', 'pose', 'feet', 'pose', 'seat', 'pose', 'feet', 'pose', 'hands', 'pose'];

// Body regions measured against the snow (vertex lists cached per character mesh).
export function bodyRegions(rig) {
  const mesh = rig?.skinned, b = rig?.b;
  if (!mesh?.skeleton || !mesh.geometry?.attributes?.skinIndex || !b) return null;
  const toes = mesh.skeleton.bones.filter((x) => /toe/i.test(x.name));
  return {
    seat: regionVerts(mesh, [b.hips, b.lUp, b.rUp, b.spine0], 'seat', 4),
    feet: regionVerts(mesh, [b.lFoot, b.rFoot, ...toes], 'feet', 2),
    shins: regionVerts(mesh, [b.lLeg, b.rLeg], 'shins', 4),
    hands: regionVerts(mesh, [b.lHand, b.rHand], 'hands', 3),
  };
}

// ------------------------------------------------------------------ rig pool
export class RigPool {
  /** @param {(charId: string, skiId: string) => object} makeRig */
  constructor(makeRig) {
    this.makeRig = typeof makeRig === 'function' ? makeRig : null;
    this.free = [];       // { char, rig }
    this.all = [];
    this.bad = new Set(); // characters that could not be built (never retried)
    this.failed = false;
  }
  // one rig per character up front (while loading), with the body regions it gets measured by
  prebuild(chars) {
    for (const c of chars) {
      const e = this.build(c);
      if (!e) continue;
      this.free.push(e);
      try { bodyRegions(e.rig); } catch { /* measured lazily instead */ }
    }
  }
  build(char) {
    if (!this.makeRig || this.bad.has(char)) return null;
    try {
      const rig = this.makeRig(char, 'rental');
      if (rig && rig.root && typeof rig.update === 'function') { const e = { char, rig }; this.all.push(e); return e; }
    } catch (err) { console.warn('Jobs: character unavailable', char, err?.message || err); }
    this.bad.add(char);
    this.failed = true;
    return null;
  }
  get size() { return this.all.length; }
  // that character if one is free, else any free one that doesn't look like you, else a new one
  take(char, avoid) {
    let i = this.free.findIndex((e) => e.char === char);
    if (i < 0) i = this.free.findIndex((e) => e.char !== avoid);
    const e = i >= 0 ? this.free.splice(i, 1)[0] : this.build(char);
    if (e) resetRig(e.rig);
    return e;
  }
  give(e) { if (!e) return; resetRig(e.rig); if (!this.free.includes(e)) this.free.push(e); }
  dispose() {
    for (const { rig } of this.all) {
      resetRig(rig);
      try {
        rig.mixer?.stopAllAction?.();
        rig.root.traverse((o) => { if (o.isSkinnedMesh) o.skeleton?.dispose?.(); });
      } catch { /* best effort */ }
    }
    this.all.length = 0; this.free.length = 0;
  }
}
export function resetRig(r) {
  r.root.parent?.remove(r.root);
  r.gear?.parent?.remove(r.gear);
  r.root.position.set(0, 0, 0); r.root.rotation.set(0, 0, 0); r.root.visible = true;
  if (r.gear) { r.gear.position.set(0, 0, 0); r.gear.visible = true; }
  r.setSkisVisible?.(false);
  r.setCarry?.(false);
  r.snapPose?.();
  if (Array.isArray(r.fx)) r.fx.length = 0;
}

// ------------------------------------------------------------------ a person on one spot
export class Actor {
  /**
   * @param {object} o
   * @param {RigPool} [o.pool]
   * @param {THREE.Object3D} o.group      parent with an identity transform
   * @param {string|null} o.char           character id (null -> stand-in figure)
   * @param {string} [o.avoid]             a character not to use as a substitute (the player's)
   * @param {'stand'|'down'|'ski'} o.pose  on foot (no skis) | sitting hurt or stuck in the snow | on skis
   * @param {'injured'|'stuck'} [o.variant]
   * @param {number} o.x, o.z, o.heading
   * @param {number} [o.side]              the hurt leg (+1 right, -1 left)
   */
  constructor(o) {
    this.group = o.group;
    this.pose = o.pose;
    this.variant = o.variant || 'injured';
    this.heading = o.heading || 0;
    this.side = o.side || 1;
    this.pos = new THREE.Vector3(o.x, world.groundHeight(o.x, o.z), o.z);
    this.pool = o.pool || null;
    this.slot = o.char && this.pool ? this.pool.take(o.char, o.avoid) : null;
    this.rig = this.slot?.rig || null;
    this.rigFailed = !!o.char && !this.rig && !!this.pool?.failed; // asked for but could not be built
    this.n = world.normal(o.x, o.z, new THREE.Vector3());
    // rig state, reused every frame (edge left undefined: the rig derives it from lean)
    this.st = { mode: 'idle', heading: this.heading, speed: 0, crouch: 0, lean: 0, plow: 0, tuck: false, normal: this.n, air: false, carry: false, seat: null };
    if (o.pose === 'down') {
      // sitting in the snow facing down the fall line, the way you end up after a fall
      const [gx, gz] = world.gradient(o.x, o.z);
      if (Math.hypot(gx, gz) > 0.02) this.heading = Math.atan2(-gx, -gz);
      this.slope = Math.atan(Math.hypot(gx, gz));
      this.st.heading = this.heading;
    } else if (o.pose === 'ski') {
      Object.assign(this.st, { mode: 'ski', crouch: 0.25 });
    }
    if (this.rig) {
      this.root = this.rig.root;
      this.group.add(this.rig.root);
      if (this.rig.gear) this.group.add(this.rig.gear);
      this.rig.setSkisVisible?.(o.pose === 'ski');
      this.rig.setCarry?.(false);
      this.rig.root.position.copy(this.pos);
      this.rig.root.rotation.y = this.heading;
    } else {
      this.fig = makeFallbackFigure(o.pose === 'down' ? 'sit' : 'stand', o.jacket);
      this.fig.position.copy(this.pos);
      this.fig.rotation.y = this.heading;
      this.group.add(this.fig);
      this.root = this.fig;
    }
    // posed a few times while still hidden; a seated casualty is measured against the snow on its own mesh
    this.prep = this.rig ? (o.pose === 'down' ? DOWN_STEPS.length : 2) : 0;
    this.seatLift = 0.1; this.footLift = 0; this.handLift = 0; this.reach = 0.2; this.lean = 0.16; this.onKnees = false;
    this.contact = null; // measured: { seat, feet, hands, low } heights over the snow (m)
    this.acc = 0;
    this.getUpT = -1;
    this.visible = true;
    this.setVisible(false);
    // a collider (Jobs puts it in the player's colliders only at walking pace)
    const c = this.center({ x: 0, z: 0 });
    this.collider = { x: c.x, z: c.z, r: o.pose === 'down' ? 0.55 : 0.35 };
  }

  // ground point at the middle of the body (a seated skier's legs reach ~0.7 m down the slope)
  center(out = { x: 0, z: 0 }) {
    const k = this.pose === 'down' && this.getUpT < 0 ? 0.3 : 0;
    out.x = this.pos.x + Math.sin(this.heading) * k; out.z = this.pos.z + Math.cos(this.heading) * k;
    return out;
  }

  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    if (this.rig) { this.rig.root.visible = v; if (this.rig.gear) this.rig.gear.visible = v; } else this.fig.visible = v;
  }

  // re-pose a person who stays on one spot (the ground under them was sampled once)
  pose_(dt) {
    const st = this.st;
    st.heading = this.heading;
    this.rig.root.position.copy(this.pos);
    this.rig.update(dt, st);
    if (this.rig.fx) this.rig.fx.length = 0; // nobody drains a job person's snow puffs
  }

  // One step of the posing done while still hidden: a frame each, none over ~0.6 ms. A seated casualty
  // alternates posing and measuring the posed mesh against the snow (seat and hands, then the boots),
  // correcting twice over; the last step poses the final body.
  prepStep() {
    if (!this.rig) { this.prep = 0; return; }
    if (this.pose !== 'down') { this.pose_(1 / 30); this.prep--; return; }
    const step = DOWN_STEPS[DOWN_STEPS.length - this.prep];
    if (step === 'pose') this.poseDown();
    else if (step === 'hands') {
      // last check: hands that still don't rest on the snow go onto the knees
      const c = this.variant === 'stuck' && !this.onKnees ? this.measure('hands') : null;
      if (c && c.hands > 0.02) this.onKnees = true;
    } else {
      const c = this.measure(step);
      if (c && step === 'seat') {
        if (Number.isFinite(c.seat)) this.seatLift += clamp(-SIT_SINK - c.seat, -0.25, 0.25);
        if (this.variant === 'stuck' && Number.isFinite(c.hands) && !this.onKnees) {
          // hands resting on the snow; arms too short for that lean back further with the hands closer
          // in, and if they still don't reach, rest them on the knees instead
          if (c.hands > (this.reach < 0.2 ? 0.02 : 0.03)) {
            if (this.reach < 0.2) this.onKnees = true;
            else { this.reach = 0.08; this.lean = 0.3; }
          }
          this.handLift += clamp(-0.006 - c.hands, -0.15, 0.2);
        }
      } else if (c && Number.isFinite(c.feet)) this.footLift += clamp(-0.008 - c.feet, -0.15, 0.15);
    }
    this.prep--;
    if (this.prep === 0) {
      const c = this.collider, p = this.center(_C);
      c.x = p.x; c.z = p.z;
    }
  }

  // Sitting in the snow: the rig's seated pose (as on a chairlift) with the seat on the snow, then
  // finished here: knees up and heels on the snow in front (the hurt leg stretched out), the torso
  // bent over the hurt knee with both hands holding it; a stuck beginner leans back on both hands.
  poseDown() {
    const r = this.rig, b = r.b, h = this.heading, s = this.side, stuck = this.variant === 'stuck';
    if (!b?.hips || !b.lUp || !b.rUp) { this.pose_(1 / 30); return; }
    const P = this.pos, snow = (this.snow ??= new SnowPatch(this.pos.x, this.pos.z));
    const fwd = _fw.set(Math.sin(h), 0, Math.cos(h)), right = _rt.set(-Math.cos(h), 0, Math.sin(h));
    const st = this.st;
    st.mode = 'sit'; st.heading = h; st.speed = 0; st.fall = null;
    st.seat = (this.seatP ??= new THREE.Vector3()).set(P.x, P.y + this.seatLift, P.z);
    r.root.position.copy(P);
    r.update(0, st);
    r.root.updateMatrixWorld(true);
    // torso: bent forward over the knee (twisted toward it) or leaning back on the hands
    if (b.spine0 && b.spine1) {
      if (stuck) rotateWorld(b.spine0, right, this.onKnees ? -0.12 : this.lean);
      else { rotateWorld(b.spine0, right, -0.3); rotateWorld(b.spine1, right, -0.16); rotateWorld(b.spine1, _up, -s * 0.18); }
    }
    // legs
    const legLen = r.legLen || 0.76, ankleH = r.ankleH || 0.12;
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? -1 : 1, hurt = !stuck && sd === s;
      const up = i === 0 ? b.lUp : b.rUp, leg = i === 0 ? b.lLeg : b.rLeg, foot = i === 0 ? b.lFoot : b.rFoot;
      if (!leg || !foot) continue;
      const H = worldPos(up, _A);
      // hip to ankle distance: knee bent up, or nearly straight for the hurt leg; the heel on the snow
      const want = legLen * (hurt ? 0.93 : stuck ? 0.68 : 0.62);
      const out = sd * (hurt ? 0.17 : 0.14);
      const A = _B;
      let D = want;
      for (let k = 0; k < 4; k++) {
        A.copy(P).addScaledVector(fwd, D).addScaledVector(right, out);
        A.y = snow.at(A.x, A.z) + ankleH * 0.92 + this.footLift;
        const dy = A.y - H.y, dx = Math.hypot(A.x - H.x, A.z - H.z);
        D = Math.max(0.15, D + (Math.sqrt(Math.max(0.01, want * want - dy * dy)) - dx));
      }
      const pole = _C.copy(_up).addScaledVector(fwd, 0.35).addScaledVector(right, sd * (hurt ? 0.12 : 0.3)).normalize();
      solveTwoBone(up, leg, foot, A, pole);
      // boot resting on its heel, toes up (more so on the stretched leg)
      const rest = i === 0 ? r.footRest?.l : r.footRest?.r;
      if (rest) {
        world.normal(A.x, A.z, _n);
        const f = _D.copy(fwd).addScaledVector(_n, -fwd.dot(_n)).normalize();
        const toes = hurt ? 0.5 : 0.22;
        const fu = _E.copy(f).multiplyScalar(Math.cos(toes)).addScaledVector(_n, Math.sin(toes)).normalize();
        const nu = _F.copy(_n).multiplyScalar(Math.cos(toes)).addScaledVector(f, -Math.sin(toes)).normalize();
        const left = _G.crossVectors(nu, fu).normalize();
        _m.makeBasis(left, nu, fu);
        setWorldQuat(foot, _q.setFromRotationMatrix(_m).multiply(rest));
      }
    }
    // arms
    for (let i = 0; i < 2; i++) {
      const sa = i === 0 ? -1 : 1;
      const arm = i === 0 ? b.lArm : b.rArm, fore = i === 0 ? b.lFore : b.rFore, hand = i === 0 ? b.lHand : b.rHand;
      if (!arm || !fore || !hand) continue;
      const T = _B;
      let palm;
      if (stuck && this.onKnees) {
        // forearms resting on the knees
        const kneeB = i === 0 ? b.lLeg : b.rLeg, hipB = i === 0 ? b.lUp : b.rUp, footB = i === 0 ? b.lFoot : b.rFoot;
        const K = worldPos(kneeB, _A), th = worldPos(hipB, _D).sub(K).normalize(), sh = worldPos(footB, _E).sub(K).normalize();
        const front = _F.copy(th).add(sh).negate();
        if (front.lengthSq() < 1e-4 || front.dot(_up) < 0) front.copy(_up); else front.normalize();
        T.copy(K).addScaledVector(front, 0.08).addScaledVector(sh, 0.04).addScaledVector(right, sa * 0.02);
        solveTwoBone(arm, fore, hand, T, _C.copy(right).multiplyScalar(sa).addScaledVector(_up, -0.8).addScaledVector(fwd, -0.2).normalize());
        palm = _G.copy(front).negate();
        if (typeof r.relaxHand === 'function') r.relaxHand(i, palm, 0.2);
      } else if (stuck) {
        // hands planted on the snow behind and beside the hips, fingers pointing back
        T.copy(P).addScaledVector(right, sa * ((r.hipHalfW || 0.2) + 0.13)).addScaledVector(fwd, -this.reach);
        T.y = snow.at(T.x, T.z) + 0.045 + this.handLift;
        solveTwoBone(arm, fore, hand, T, _C.copy(fwd).negate().addScaledVector(right, sa * 0.5).addScaledVector(_up, 0.2).normalize());
        world.normal(T.x, T.z, _n);
        const fing = _D.copy(fwd).negate().addScaledVector(right, sa * 0.6);
        fing.addScaledVector(_n, -fing.dot(_n)).normalize(); // fingers flat on the snow, pointing back and out
        palm = _E.copy(_n).negate();
        if (typeof r.aimHand === 'function') r.aimHand(i, fing, palm);
      } else {
        // both hands on the hurt knee
        const kneeB = s > 0 ? b.rLeg : b.lLeg, hipB = s > 0 ? b.rUp : b.lUp, footB = s > 0 ? b.rFoot : b.lFoot;
        const K = worldPos(kneeB, _A), th = worldPos(hipB, _D).sub(K).normalize(), sh = worldPos(footB, _E).sub(K).normalize();
        const front = _F.copy(th).add(sh).negate();
        if (front.lengthSq() < 1e-4 || front.dot(_up) < 0) front.copy(_up); else front.normalize();
        const near = sa === s;
        T.copy(K).addScaledVector(front, 0.075).addScaledVector(right, s * (near ? 0.07 : -0.065)).addScaledVector(near ? th : sh, near ? 0.03 : 0.07);
        solveTwoBone(arm, fore, hand, T, _C.copy(right).multiplyScalar(sa).addScaledVector(_up, -0.7).addScaledVector(fwd, -0.3).normalize());
        palm = _G.copy(front).negate().addScaledVector(right, sa * (near ? -0.5 : 0.5)).normalize();
        if (typeof r.relaxHand === 'function') r.relaxHand(i, palm, 0.18);
      }
    }
    // head: looking down at the knee, or up the slope at whoever comes
    if (b.head) {
      if (stuck) rotateWorld(b.head, right, 0.12);
      else { rotateWorld(b.head, right, -0.32); rotateWorld(b.head, _up, -s * 0.2); }
    }
    r.root.updateMatrixWorld(true);
  }

  // Lowest skin point of the seat and hands ('seat'), the boots ('feet': feet and shins, boot shafts are
  // skinned to the shin) or everything incl. the whole body ('all', for tests) over the snow (m), measured
  // on the posed mesh (~0.4 ms for 'seat' or 'feet').
  measure(what = 'all') {
    const R = bodyRegions(this.rig);
    if (!R) return null;
    const S = (this.sampler ??= new SkinSampler(this.rig.skinned));
    if (!S.ok) return null;
    S.refresh();
    const snow = (this.snow ??= new SnowPatch(this.pos.x, this.pos.z));
    const c = (this.contact ??= { seat: NaN, feet: NaN, hands: NaN, low: NaN });
    if (what === 'hands') { c.hands = S.lowest(R.hands, snow); return c; }
    if (what !== 'feet') { c.seat = S.lowest(R.seat, snow); c.hands = S.lowest(R.hands, snow); }
    if (what !== 'seat') c.feet = Math.min(S.lowest(R.feet, snow), S.lowest(R.shins, snow));
    if (what === 'all') c.low = S.lowest(regionVerts(this.rig.skinned, this.rig.skinned.skeleton.bones, 'all', 5), snow);
    return c;
  }

  // help a stuck skier up: the same get-up the player does after a crash
  getUp() {
    if (this.pose !== 'down' || this.getUpT >= 0) return;
    this.getUpT = 0;
  }

  update(dt, viewer) {
    const dx = viewer.x - this.pos.x, dz = viewer.z - this.pos.z, d2 = dx * dx + dz * dz;
    if (d2 > SHOW_R2) { this.setVisible(false); return; }
    if (this.prep > 0) {
      this.prepStep();
      if (this.prep === 0) this.setVisible(true);
      return;
    }
    this.setVisible(true);
    if (!this.rig) return;
    if (this.getUpT >= 0 && this.pose === 'down') {
      // push up through a crouch onto the feet (the crash get-up), from the seated pose
      const first = this.getUpT === 0;
      this.getUpT += dt;
      const g = clamp(this.getUpT / 1.6, 0, 1);
      const F = (this.fall ??= { ball: 0, getUp: 0, pitch: 0, roll: 0 });
      F.getUp = g; F.pitch = -(1.0 - this.slope) * (1 - smooth(0, 0.62, g)); F.roll = 0;
      // (the rig eases every bone over from the seated pose when its mode changes)
      if (first) Object.assign(this.st, { mode: 'fall', fall: F, fallSide: this.side, fallHeading: this.heading, fallAir: false, fallT: 1, seat: null });
      this.pose_(dt);
      if (g >= 1) {
        // up on their feet beside their skis
        this.pose = 'stand';
        const st = this.st;
        st.mode = 'idle'; st.fall = null; st.speed = 0;
        this.collider.r = 0.35;
        const k = this.center(_C); this.collider.x = k.x; this.collider.z = k.z;
      }
      return;
    }
    if (this.pose === 'down') return; // a still body needs no re-posing
    // people waiting for you turn to face you as you arrive
    if (this.pose === 'stand' && d2 < 14 * 14 && d2 > 0.25) this.heading += wrap(Math.atan2(dx, dz) - this.heading) * Math.min(1, dt * 2.5);
    if (d2 > POSE_R2) return;
    this.acc += dt;
    if (d2 > FULL_R2 && this.acc < 0.1) return;
    this.pose_(this.acc);
    this.acc = 0;
  }

  dispose() {
    if (this.rig) {
      this.group.remove(this.rig.root);
      if (this.rig.gear) this.group.remove(this.rig.gear);
      if (this.pool && this.slot) this.pool.give(this.slot);
    } else if (this.fig) {
      this.group.remove(this.fig);
      this.fig.userData.ownGeometry?.dispose();
    }
    this.slot = null;
    this.rig = null;
    this.sampler = null;
  }
}

// ------------------------------------------------------------------ escort guest
// The guest skis your own track: positions are sampled every 1.5 m into a ring buffer and the guest
// moves along that polyline at their own pace, keeping ~7 m behind you, never faster than their skill
// allows (beginners in a snowplough). Walking stretches are walked (skis on the back). A lift ride is
// a jump in the track: the guest takes the next cabin and steps out of the top station a few seconds
// after you.
// Options for a skier you bring down (a rescue): `want` (how far behind along your track), `minGap`
// (never closer than that: down to half a metre, i.e. level with you), `side` (ski up to that many
// metres beside your line where `clear(x, z)` says the snow is free of trees, nets and props, so they
// ski with you rather than in your tracks), `catchUp` + `camera` (left far behind, they rejoin your
// track a little behind you while neither spot is in view).
const CAP = 4096, WALK = 1, JUMP = 2;
const CATCH_GAP = 45, CATCH_BACK = 16, CATCH_T = 1.2, VIEW_R2 = 230 * 230;
const LINE_BACK = 7.5;   // m behind you while in your line (the chase camera is ~5 m back)
const SIDE_HOLD = 2;     // s their side must stay blocked before they cross over behind you
const _ndc = new THREE.Vector3();

export class Follower {
  constructor(actor, { vmax = 13, plow = false, want = null, minGap = 1.5, side = 0, clear = null, catchUp = false, camera = null } = {}) {
    this.actor = actor;
    this.vmax = vmax;
    this.plow = plow;
    this.want = want;
    this.minGap = minGap;
    this.side = side; this.clear = clear; this.sideOff = 0; this.sideGoal = 0; this.sideSign = 1; this.sideT = 0;
    this.dirX = 0; this.dirZ = 0;
    this.catchUp = catchUp; this.camera = camera; this.farT = 0; this.jumped = false;
    this.X = new Float64Array(CAP); this.Y = new Float64Array(CAP); this.Z = new Float64Array(CAP);
    this.D = new Float64Array(CAP); this.F = new Uint8Array(CAP);
    this.first = 0; this.last = -1;
    this.gi = 0; this.gs = 0; this.v = 0;
    this.lean = 0; this.lastTurn = 0;
    this.riding = 0; this.pendingJump = false; this.jumpAt = -1;
    this.boarded = false; this.wasSitting = false;
    this.gap = 0;
    this.walking = true;
    this.acc = 0;
    this.nT = 0;
    const p = actor.pos;
    this.push(p.x, p.y, p.z, WALK);
    actor.rig?.setSkisVisible?.(true);
    actor.rig?.setCarry?.(true);
  }

  push(x, y, z, flags) {
    const k = this.last + 1, s = k % CAP;
    let d = 0;
    if (this.last >= 0) {
      const p = this.last % CAP;
      d = this.D[p] + (flags & JUMP ? 0 : Math.hypot(x - this.X[p], z - this.Z[p]));
    }
    this.X[s] = x; this.Y[s] = y; this.Z[s] = z; this.D[s] = d; this.F[s] = flags;
    this.last = k;
    if (this.last - this.first >= CAP) this.first = this.last - CAP + 1;
    if (this.gi < this.first) { this.gi = this.first; this.gs = this.D[this.first % CAP]; }
  }

  get hidden() { return this.riding > 0; }

  /** Per frame. Returns the gap to the player along the track (m). `boarded` turns true the frame you sit down on a lift. */
  update(dt, player) {
    const p = player.pos, sitting = player.mode === 'sit';
    this.boarded = sitting && !this.wasSitting;
    this.wasSitting = sitting;
    // 1) record the player's track (a lift ride is a jump in it)
    if (sitting) this.pendingJump = true;
    else {
      const walk = player.mode === 'walk' ? WALK : 0, L = this.last % CAP;
      if (this.pendingJump) {
        // you stepped off a lift: the guest will step out 2.5 m behind you (toward the station), so
        // they arrive even if you wait right at the exit
        const bx = this.X[L] - p.x, bz = this.Z[L] - p.z, bl = Math.hypot(bx, bz) || 1;
        const jx = p.x + (bx / bl) * 2.5, jz = p.z + (bz / bl) * 2.5;
        this.push(jx, world.groundHeight(jx, jz, p.y + 0.5), jz, JUMP | walk);
        this.jumpAt = this.last;
        this.pendingJump = false;
      } else {
        const dx = p.x - this.X[L], dz = p.z - this.Z[L], d2 = dx * dx + dz * dz;
        if (d2 > 150 * 150) {
          // whisked away (the ski bus): the guest comes along and steps off 2.5 m behind you
          const h = player.heading || 0, jx = p.x - Math.sin(h) * 2.5, jz = p.z - Math.cos(h) * 2.5;
          this.push(jx, world.groundHeight(jx, jz, p.y + 0.5), jz, JUMP | walk);
          this.jumpAt = this.last;
        } else if (d2 >= 2.25) this.push(p.x, p.y, p.z, walk);
      }
    }
    const a = this.actor;
    // you came back for your guest: they skip the detour and simply join you
    if (!sitting && this.riding <= 0 && this.gi < this.last) {
      const ex = p.x - a.pos.x, ez = p.z - a.pos.z, Lc = this.last % CAP;
      const ahead = this.D[Lc] - this.gs, near = this.catchUp ? 7 : 20;
      if (ahead > (this.catchUp ? 10 : 60) && ex * ex + ez * ez < near * near) {
        const walk = this.F[(this.gi + 1) % CAP] & WALK;
        this.last = this.gi;
        this.push(a.pos.x, a.pos.y, a.pos.z, walk);
        this.gi = this.last; this.gs = this.D[this.last % CAP];
        this.push(p.x, p.y, p.z, player.mode === 'walk' ? WALK : 0);
        this.jumpAt = -1;
      }
    }
    const L = this.last % CAP;
    const sp = this.D[L] + (sitting ? 0 : Math.hypot(p.x - this.X[L], p.z - this.Z[L]));

    // 2) riding a lift behind you: hidden until the next cabin arrives
    if (this.riding > 0) {
      this.riding -= dt;
      if (this.riding > 0) { a.setVisible(false); this.gap = sp - this.gs; return this.gap; }
      this.gi = Math.min(this.gi + 1, this.last);
      const j = this.gi % CAP;
      this.gs = this.D[j];
      a.pos.set(this.X[j], world.groundHeight(this.X[j], this.Z[j], this.Y[j] + 0.5), this.Z[j]);
      a.rig?.snapPose?.(); // steps out of the cabin in the pose they ride in, no blend across the jump
    }

    // 3) pace: close the gap to ~7 m (9 m for beginners), never faster than the guest's skill
    let gap = sp - this.gs;
    // Beside you they may ski level with you. In your line, or on their way into it or across it to your
    // other side, they keep back behind the camera (never through you, never filling the screen); they
    // only move in toward your line once that far back.
    const crossing = this.side && Math.sign(this.sideGoal) !== Math.sign(this.sideOff) && Math.abs(this.sideOff) > 0.05;
    const inward = this.side && (crossing || Math.abs(this.sideGoal) < Math.abs(this.sideOff) - 0.05);
    const inLine = this.side && (inward || Math.abs(this.sideOff) < 1.6);
    const want = inLine ? Math.max(LINE_BACK, this.want ?? 0) : (this.want ?? (this.plow ? 9 : 7));
    const nxt = this.gi < this.last ? (this.gi + 1) % CAP : this.gi % CAP;
    const walking = (this.F[nxt] & WALK) !== 0;
    const pv = sitting ? 0 : Math.hypot(player.vel.x, player.vel.z);
    let target = clamp(pv + (gap - want) * 0.9, 0, walking ? 4.2 : this.vmax);
    if (gap < Math.min(3, want)) target = 0;
    // you are already up the lift: the guest walks on to board the next cabin or chair
    if (this.jumpAt > this.gi && !sitting) target = Math.max(target, walking ? 1.6 : 3);
    const accel = target > this.v ? (this.plow ? 2.5 : 4) : 7;
    this.v += clamp(target - this.v, -accel * dt, accel * dt);
    this.gs = Math.max(this.gs, Math.min(this.gs + this.v * dt, sp - (inLine ? LINE_BACK - 1.5 : this.minGap)));
    // left far behind: rejoin your track a little behind you while neither spot is on screen
    this.jumped = false;
    if (this.catchUp && !sitting && gap > CATCH_GAP) {
      this.farT += dt;
      const s = sp - CATCH_BACK;
      if (this.farT > CATCH_T && s > this.gs + 20 && !this.inView(a.pos) && !this.inView(this.pointAt(s, _A))) {
        this.gs = s;
        while (this.gi < this.last && this.D[(this.gi + 1) % CAP] <= s) this.gi++;
        this.v = Math.min(this.vmax, pv);
        this.farT = 0; this.jumped = true; this.catchUps = (this.catchUps || 0) + 1;
        gap = sp - this.gs;
        a.rig?.snapPose?.();
      }
    } else this.farT = 0;
    while (this.gi < this.last) {
      const n = (this.gi + 1) % CAP;
      if (this.D[n] > this.gs) break;
      if (this.F[n] & JUMP) { this.riding = 4.5; this.gs = this.D[n]; this.v = 0; a.setVisible(false); this.gap = sp - this.gs; return this.gap; }
      this.gi++;
    }

    // 4) place on the track, heading along it, leaning into turns (past your last recorded point, on
    //    the stretch between it and where you are now)
    const ia = this.gi % CAP;
    let ax = this.X[ia], az = this.Z[ia], ay = this.Y[ia], bx = ax, bz = az, by = ay, d0 = this.D[ia], d1 = d0;
    if (this.gi < this.last) {
      const ib = (this.gi + 1) % CAP;
      bx = this.X[ib]; bz = this.Z[ib]; by = this.Y[ib]; d1 = this.D[ib];
    } else if (!sitting && sp > d0 + 1e-3) {
      bx = p.x; bz = p.z; by = p.y; d1 = sp;
    }
    const segL = d1 - d0, t = segL > 1e-6 ? clamp((this.gs - d0) / segL, 0, 1) : 0;
    let x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const yh = ay + (by - ay) * t;
    const hl = Math.hypot(bx - ax, bz - az);
    if (this.side) {
      // beside your line (smoothed direction, so the offset never jumps between track samples)
      if (hl > 0.05) {
        const k = this.dirX || this.dirZ ? Math.min(1, dt * 4) : 1;
        this.dirX += ((bx - ax) / hl - this.dirX) * k;
        this.dirZ += ((bz - az) / hl - this.dirZ) * k;
      }
      const dl = Math.hypot(this.dirX, this.dirZ);
      if (dl > 1e-3) {
        const ux = this.dirX / dl, uz = this.dirZ / dl, rx = -uz, rz = ux;
        this.sideT -= dt;
        if (this.sideT <= 0 || this.jumped) {
          // Their side sticks: blocked for a moment (a tree, a net post) they tuck in behind you, and
          // only when it stays blocked do they cross over to your other side (behind you).
          const step = 0.25 - this.sideT;
          this.sideT = 0.25;
          const ok = (o) => this.sideClear(x + rx * o, z + rz * o, yh, o) && this.sideClear(x + rx * o + ux * 5, z + rz * o + uz * 5, yh, o);
          const amt = walking ? 0.6 : this.side, cur = this.sideSign;
          const okC = ok(cur * amt), okO = ok(-cur * amt);
          const cam = this.camera?.position;
          if (cam && okC && okO && Math.abs(this.sideOff) < 0.3) {
            // first pick (or back from your line): the side away from the camera
            const d2 = (o) => (x + rx * o - cam.x) ** 2 + (z + rz * o - cam.z) ** 2;
            if (d2(-cur * amt) > d2(cur * amt) + 1) this.sideSign = -cur;
          }
          if (this.sideSign === cur ? okC : okO) { this.sideGoal = this.sideSign * amt; this.blockT = 0; } else {
            this.blockT = (this.blockT || 0) + step;
            const other = this.sideSign === cur ? okO : okC;
            if (other && (this.blockT > SIDE_HOLD || Math.abs(this.sideOff) < 0.3)) {
              this.sideSign = -this.sideSign; this.sideGoal = this.sideSign * amt; this.blockT = 0;
            } else this.sideGoal = 0;
          }
        }
        if (this.jumped) this.sideOff = this.sideGoal;
        // in toward your line (or across it) only once far enough back
        const goal = inward && gap < LINE_BACK - 1.5 ? this.sideOff : this.sideGoal;
        this.sideOff += (goal - this.sideOff) * Math.min(1, dt * 1.4);
        x += rx * this.sideOff; z += rz * this.sideOff;
      }
    }
    a.pos.set(x, world.groundHeight(x, z, yh + 0.5), z);
    const prevH = a.heading;
    if (hl > 0.05 && (this.v > 0.05 || this.jumped)) a.heading += wrap(Math.atan2(bx - ax, bz - az) - a.heading) * (this.jumped ? 1 : Math.min(1, dt * 6));
    const turn = wrap(a.heading - prevH) / Math.max(dt, 1e-3);
    this.lean += (clamp(-turn * this.v * 0.07, -1, 1) - this.lean) * Math.min(1, dt * 4);
    if (this.walking !== walking) {
      this.walking = walking;
      a.rig?.setCarry?.(walking);
    }
    this.gap = gap;
    this.pose(dt, p);
    return gap;
  }

  // snow beside the track a person can ski on: clear of obstacles, no drop or wall beside the track
  // (`o` m out to the side: across a slope the snow there is that much higher or lower anyway)
  sideClear(x, z, y, o = 0) {
    if (this.clear && !this.clear(x, z)) return false;
    const g = world.groundHeight(x, z, y + 0.5 + Math.abs(o));
    return Number.isFinite(g) && Math.abs(g - y) < 0.6 + 0.55 * Math.abs(o);
  }

  // point on the recorded track at distance s (null past its ends)
  pointAt(s, out) {
    if (this.last < this.first) return null;
    let i = Math.max(this.gi, this.first);
    while (i < this.last && this.D[(i + 1) % CAP] < s) i++;
    const a = i % CAP, b = i < this.last ? (i + 1) % CAP : a;
    const L = this.D[b] - this.D[a], t = L > 1e-6 ? clamp((s - this.D[a]) / L, 0, 1) : 0;
    return out.set(this.X[a] + (this.X[b] - this.X[a]) * t, this.Y[a] + (this.Y[b] - this.Y[a]) * t, this.Z[a] + (this.Z[b] - this.Z[a]) * t);
  }

  // on screen (a person's height around p, not too far away to make out)
  inView(p) {
    const cam = this.camera;
    if (!cam || !p) return false;
    const dx = p.x - cam.position.x, dz = p.z - cam.position.z;
    if (dx * dx + dz * dz > VIEW_R2) return false;
    for (const h of [0.3, 1.5]) {
      _ndc.set(p.x, p.y + h, p.z).project(cam);
      if (_ndc.z < 1 && _ndc.z > -1 && Math.abs(_ndc.x) < 1.15 && Math.abs(_ndc.y) < 1.15) return true;
    }
    return false;
  }

  pose(dt, viewer) {
    const a = this.actor;
    if (!a.rig) { a.fig.position.copy(a.pos); a.fig.rotation.y = a.heading; a.setVisible(true); return; }
    // (someone skiing with you is never drawn right against the lens)
    const cam = this.camera?.position;
    if (cam) {
      const cx = a.pos.x - cam.x, cy = a.pos.y + 0.9 - cam.y, cz = a.pos.z - cam.z, c2 = cx * cx + cy * cy + cz * cz;
      this.atLens = c2 < (this.atLens ? 1.5 * 1.5 : 1.1 * 1.1);
    }
    a.setVisible(!this.atLens);
    const dx = viewer.x - a.pos.x, dz = viewer.z - a.pos.z, d2 = dx * dx + dz * dz;
    this.acc += dt;
    if (d2 > POSE_R2 || (d2 > 60 * 60 && this.acc < 0.066)) return;
    const st = a.st;
    st.heading = a.heading;
    st.speed = this.v;
    st.fall = null;
    if (this.walking) {
      st.mode = this.v > 0.1 ? 'walk' : 'idle'; st.lean = 0; st.crouch = 0; st.plow = 0; st.carry = true;
    } else {
      st.mode = 'ski'; st.lean = this.lean; st.crouch = 0.28 + Math.abs(this.lean) * 0.25; st.carry = false;
      st.plow = this.plow && this.v < 9 ? 0.55 : 0;
      // the snow's slope under the skis changes slowly: re-sampled at ~15 Hz
      this.nT -= this.acc;
      if (this.nT <= 0) { this.nT = 0.066; world.normal(a.pos.x, a.pos.z, a.n); }
      // a pole plant as each turn begins
      const side = Math.sign(Math.round(this.lean * 2));
      if (side !== 0 && side !== this.lastTurn && this.v > 4 && a.rig.startPolePlant) {
        _fw.set(Math.sin(a.heading), 0, Math.cos(a.heading));
        _rt.set(-_fw.z, 0, _fw.x); // the character's right = fwd x up (as in skier.js)
        a.rig.startPolePlant(side < 0 ? 0 : 1, _fw, _rt);
      }
      this.lastTurn = side;
    }
    a.rig.root.position.copy(a.pos);
    a.rig.update(this.acc, st);
    if (a.rig.fx) a.rig.fx.length = 0;
    this.acc = 0;
  }
}
