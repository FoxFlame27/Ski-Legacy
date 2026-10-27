// On-foot animation of the skier rig: a procedural walk, run and stand (SkierRig.poseFoot).
//
// Feet: each foot is either planted (fixed on the snow in world space, so it never slides: at any speed, on
// slopes, through turns, starts and stops) or swinging along an arc to where the body will be when it lands.
// A gait phase sets the rhythm (cadence and stance time follow the real ground speed, measured from how the
// body moves) and every step is placed by predicting the body's motion, so stride length always matches.
// The boot rolls heel -> flat -> toe with a stiff ski-boot ankle: the foot follows the leg's angle over it
// (toe up while the leg reaches forward, flat under the body, the heel peeling up once the hips have passed
// the boot), so heel strike and toe-off come out of the geometry, walking forward, backward or sideways.
// Body: the pelvis rides over the stance leg (a pendulum rise walking, a bounce running), sways over the
// supporting foot, turns with the swinging leg and drops on the free side; the chest counter-rotates; the
// arms swing from the shoulders with soft elbows (about 90 deg running), opposite to the legs and a little
// behind them; the head stays level and looks ahead. Slopes: shorter, quicker steps and a forward lean
// going up, bent knees and an upright body going down. Standing: weight shifts from leg to leg, breathing,
// looking around; after a stop or a turn on the spot the feet step back under the body.
// Styles: the player walks tall and athletic (long stride, chest up, a firm arm swing, a real sprint);
// villagers stroll, each with a pace, arm swing and posture of their own.
import * as THREE from 'three';
import { world } from '../world/world.js';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sst = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ek = (h, r) => 1 - Math.exp(-h * r);
const wrap = (a) => a - Math.round(a / TAU) * TAU;
const fract = (x) => x - Math.floor(x);

// ---------------------------------------------------------------- bone helpers (world space)
const _hp = new THREE.Vector3(), _hs = new THREE.Vector3(), _pq = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _aq = new THREE.Quaternion();
function wpos(o, out) { return out.setFromMatrixPosition(o.matrixWorld); }
function wquat(o, out) { o.matrixWorld.decompose(_hp, out, _hs); return out; }
function setWQ(bone, q) { wquat(bone.parent, _pq); bone.quaternion.copy(_pq.invert().multiply(q)); bone.updateMatrixWorld(true); }
function rotW(bone, axis, ang) {
  if (!bone || Math.abs(ang) < 1e-7) return;
  wquat(bone, _rq);
  _rq.premultiply(_aq.setFromAxisAngle(axis, ang));
  setWQ(bone, _rq);
}
function rotWQ(bone, q) { wquat(bone, _rq); _rq.premultiply(q); setWQ(bone, _rq); }

const _ia = new THREE.Vector3(), _ib = new THREE.Vector3(), _ic = new THREE.Vector3(), _id = new THREE.Vector3(), _ip = new THREE.Vector3();
const _ik = new THREE.Vector3(), _iu = new THREE.Vector3(), _iw = new THREE.Vector3(), _ie = new THREE.Vector3();
const _iq = new THREE.Quaternion(), _iq2 = new THREE.Quaternion();
function aim(bone, from, to, pivot) {
  _iu.subVectors(from, pivot); _iw.subVectors(to, pivot);
  if (_iu.lengthSq() < 1e-10 || _iw.lengthSq() < 1e-10) return;
  _iq.setFromUnitVectors(_iu.normalize(), _iw.normalize());
  wquat(bone, _iq2);
  setWQ(bone, _iq.multiply(_iq2));
}
// Two-bone IK (upper a, middle b, end c): the middle joint bends toward `pole`. `soft` (a fraction of the
// chain's length) eases the reach off before full extension, so a limb never snaps straight.
function ik2(a, b, c, target, pole, soft = 0) {
  const pa = wpos(a, _ia), pb = wpos(b, _ib), pc = wpos(c, _ic);
  const lab = pa.distanceTo(pb), lbc = pb.distanceTo(pc), L = lab + lbc;
  const dir = _id.subVectors(target, pa);
  let d = dir.length();
  if (soft > 0) { const ds = L * (1 - soft); if (d > ds) d = ds + L * soft * (1 - Math.exp(-(d - ds) / (L * soft))); }
  d = clamp(d, Math.abs(lab - lbc) + 1e-3, L * 0.9999);
  dir.normalize();
  const cosA = clamp((lab * lab + d * d - lbc * lbc) / (2 * lab * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const pp = _ip.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (pp.lengthSq() < 1e-8) pp.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pp.normalize();
  const knee = _ik.copy(pa).addScaledVector(dir, lab * cosA).addScaledVector(pp, lab * sinA);
  aim(a, pb, knee, pa);
  wpos(b, pb); wpos(c, pc);
  aim(b, pc, _ie.copy(pa).addScaledVector(dir, d), pb);
}

// snow under the boot: height and a normal from a few samples (a boot rests across small bumps)
function gnormal(x, z, yHint, out) {
  const e = 0.13;
  const hx = world.groundHeight(x + e, z, yHint) - world.groundHeight(x - e, z, yHint);
  const hz = world.groundHeight(x, z + e, yHint) - world.groundHeight(x, z - e, yHint);
  out.set(-hx, 2 * e, -hz).normalize();
  if (out.y < 0.8) out.lerp(UP, (0.8 - out.y) / 0.8).normalize(); // never stood on a ledge's face
  return out;
}

// ---------------------------------------------------------------- per-model measurements
// Boot (heel, ball, toe, sole) from the skinned mesh at the rest pose, in the boot's own forward frame;
// hip joints, arm segments and the head's facing axis from the skeleton. Shared by every rig of a model.
const MEASURED = new WeakMap();
function measure(R) {
  const key = R.skinned?.geometry || R.b.hips;
  let M = MEASURED.get(key);
  if (M) return M;
  const b = R.b, root = R.root;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const loc = (o) => wpos(o, new THREE.Vector3()).applyMatrix4(inv);
  M = { feet: [] };
  const mesh = R.skinned;
  for (let i = 0; i < 2; i++) {
    const foot = i === 0 ? b.lFoot : b.rFoot;
    const toe = foot.children.find((c) => c.isBone && /toe/i.test(c.name)) || null;
    const A = loc(foot);
    const T = toe ? loc(toe) : A.clone().add(new THREE.Vector3(0, -A.y * 0.6, 0.13));
    const dir = new THREE.Vector3(T.x - A.x, 0, T.z - A.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    let heel = 0.075, tip = 0.22, sole = 0;
    const ball = Math.max(0.07, (T.x - A.x) * dir.x + (T.z - A.z) * dir.z);
    if (mesh?.geometry?.attributes?.skinIndex && typeof mesh.applyBoneTransform === 'function') {
      const bones = mesh.skeleton.bones, ids = new Set([bones.indexOf(foot), toe ? bones.indexOf(toe) : -2]);
      const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
      const v = new THREE.Vector3(), ys = [];
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < pos.count; k++) {
        let w = 0;
        for (let j = 0; j < 4; j++) if (ids.has(si.getComponent(k, j))) w += sw.getComponent(k, j);
        if (w < 0.6) continue;
        v.fromBufferAttribute(pos, k);
        mesh.applyBoneTransform(k, v);
        v.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
        const along = (v.x - A.x) * dir.x + (v.z - A.z) * dir.z;
        lo = Math.min(lo, along); hi = Math.max(hi, along);
        ys.push(v.y);
      }
      if (ys.length > 30) {
        ys.sort((p, q) => p - q);
        sole = ys[Math.floor(ys.length * 0.01)];
        heel = clamp(-lo, 0.04, 0.2); tip = clamp(hi, 0.12, 0.4);
      }
    }
    M.feet.push({ yaw: Math.atan2(dir.x, dir.z), ankA: Math.max(0.03, A.y - sole), heel, ball: Math.min(ball, tip - 0.03), tip });
  }
  const lu = loc(b.lUp), ru = loc(b.rUp);
  M.jw = Math.max(0.06, Math.abs(lu.x - ru.x) / 2);
  M.U = loc(b.lArm).distanceTo(loc(b.lFore));
  M.F = loc(b.lFore).distanceTo(loc(b.lHand));
  // the head's facing direction in its own bone space (the rest pose faces the root's +Z)
  const hq = wquat(b.head, new THREE.Quaternion()), rq = wquat(root, new THREE.Quaternion());
  M.headFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rq).applyQuaternion(hq.invert());
  MEASURED.set(key, M);
  return M;
}

// ---------------------------------------------------------------- styles
// The player: tall, confident and athletic in ski boots: a long purposeful stride, chest up, a firm arm swing
// with the elbows bent, a steady head; a proper run when sprinting.
export const PLAYER_STYLE = {
  cadence: 1.08, armSwing: 1.0, elbow: 1.0, arm0: -0.07, lag: 0.045, lean: 0.05, chest: 0.015, slouch: 0,
  width: 0.014, toeOut: 0.07, bob: 1.0, sway: 0.85, hipRot: 1.0, lift: 1.0, gaze: -0.07, heel: 1.0,
  idleW: 0.115, look: 1.0, breathe: 1.0, reach: 1.0, runLean: 1.0,
};
// Villagers stroll: an easier rhythm and softer arms, each with a pace, swing and posture of their own.
export function npcStyle(seed) {
  let s = Math.floor(seed * 4294967296) >>> 0;
  const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    cadence: 1.0 + 0.13 * r(), armSwing: 0.5 + 0.45 * r(), elbow: 0.7 + 0.5 * r(), arm0: -0.11 + 0.06 * r(), lag: 0.04 + 0.06 * r(),
    lean: 0.015 + 0.035 * r(), chest: -0.01 + 0.025 * r(), slouch: 0.06 * r(), width: 0.004 + 0.018 * r(), toeOut: 0.07 + 0.11 * r(),
    bob: 0.85 + 0.35 * r(), sway: 0.95 + 0.55 * r(), hipRot: 0.75 + 0.55 * r(), lift: 0.8 + 0.25 * r(), gaze: -0.03 - 0.06 * r(), heel: 0.8 + 0.3 * r(),
    idleW: 0.1 + 0.035 * r(), look: 0.6 + 0.8 * r(), breathe: 0.8 + 0.4 * r(), reach: 0.95 + 0.1 * r(), runLean: 0.8,
  };
}

const V = Array.from({ length: 32 }, () => new THREE.Vector3());
const Qs = Array.from({ length: 6 }, () => new THREE.Quaternion());
const _bm = new THREE.Matrix4();

function mkFoot() {
  return {
    planted: true, swing: false, kind: '', s: 0, p: 0, dur: 0.4, tLand: 1, lift: 0.08,
    P: new THREE.Vector3(), yaw: 0, n: new THREE.Vector3(0, 1, 0), pitch: 0, pitchLand: 0,
    P0: new THREE.Vector3(), yaw0: 0, n0: new THREE.Vector3(0, 1, 0), pitch0: 0,
    T: new THREE.Vector3(), yawT: 0, nT: new THREE.Vector3(0, 1, 0), pitchT: 0, nAt: new THREE.Vector3(1e9, 0, 0),
    // this frame's contact frame and results
    C: new THREE.Vector3(), cy: 0, cn: new THREE.Vector3(0, 1, 0), up: 0, pivotW: 0, cyaw: 0,
    ankle: new THREE.Vector3(), f: new THREE.Vector3(), ax: new THREE.Vector3(), q: new THREE.Quaternion(),
  };
}

export class FootGait {
  constructor(rig) {
    this.rig = rig;
    this.M = null; this.S = null;
    this.seed = Math.random();
    this.ready = false; this.frame = -9;
    this.phase = 0; this.walking = false; this.f = 0.9; this.beta = 0.62;
    this.move = 0; this.run = 0; this.vx = 0; this.vz = 0; this.vPrev = 0; this.acc = 0;
    this.px = 0; this.pz = 0; this.heading = 0; this.yawRate = 0;
    this.gy = 0; this.grade = 0; this.t = Math.random() * 60;
    this.stepCD = 0; this.air = 0; this.land = 0; this.wasAir = false; this.turn = 0; this.airPrev = 0; this.jumpT = 9;
    this.feet = [mkFoot(), mkFoot()];
    this.toes = null;
  }

  // style: rig.walkStyle ('player' | 'npc' | a style object), else the player (the only rig with poles) or a villager
  style() {
    const R = this.rig, w = R.walkStyle;
    if (w && typeof w === 'object') return w;
    if (w === 'player' || (!w && R.poleGltf)) return PLAYER_STYLE;
    return npcStyle(this.seed);
  }

  restYaw(i, heading) { return heading - (i ? 1 : -1) * this.S.toeOut; }

  // feet under the body, standing (first frame, teleports, back from skis / a lift / a fall)
  reset(st, right, groundY) {
    const R = this.rig, root = R.root.position, S = this.S;
    this.px = root.x; this.pz = root.z; this.heading = st.heading || 0;
    this.vx = this.vz = 0; this.vPrev = 0; this.acc = 0; this.yawRate = 0;
    this.walking = false; this.move = 0; this.run = 0; this.phase = 0.06; this.turn = 0;
    this.gy = groundY; this.grade = 0; this.air = 0; this.land = 0; this.wasAir = false;
    for (let i = 0; i < 2; i++) {
      const F = this.feet[i], side = i ? 1 : -1;
      F.planted = true; F.swing = false; F.kind = ''; F.s = 0; F.pitch = 0; F.pitchLand = 0; F.tLand = 1;
      F.P.set(root.x + right.x * side * S.idleW, 0, root.z + right.z * side * S.idleW);
      F.P.y = world.groundHeight(F.P.x, F.P.z, groundY + 0.5);
      F.yaw = this.restYaw(i, this.heading);
      gnormal(F.P.x, F.P.z, groundY + 0.5, F.n);
    }
    this.ready = true;
  }

  liftFoot(F, kind) {
    F.planted = false; F.swing = true; F.kind = kind; F.s = 0;
    F.P0.copy(F.P); F.yaw0 = F.yaw; F.n0.copy(F.n); F.pitch0 = F.pitch;
    F.T.copy(F.P); F.yawT = F.yaw; F.nT.copy(F.n); F.pitchT = 0; F.nAt.set(1e9, 0, 0);
  }

  plantFoot(F) {
    F.planted = true; F.swing = false; F.kind = ''; F.s = 0; F.tLand = 0;
    F.P.copy(F.T); F.yaw = F.yawT; F.n.copy(F.nT); F.pitch = F.pitchLand = F.pitchT;
  }

  // landing spot of a swinging foot (x, z): kept clear of the other foot, on the snow
  setTarget(i, x, z, yaw, rx, rz, minSep, yHint) {
    const F = this.feet[i], O = this.feet[1 - i], side = i ? 1 : -1;
    const op = O.planted ? O.P : O.T;
    const sep = ((x - op.x) * rx + (z - op.z) * rz) * side;
    if (sep < minSep) { x += rx * side * (minSep - sep); z += rz * side * (minSep - sep); }
    F.T.set(x, world.groundHeight(x, z, yHint), z);
    if (F.nAt.distanceToSquared(F.T) > 0.003) { gnormal(x, z, yHint, F.nT); F.nAt.copy(F.T); }
    F.yawT = yaw;
  }

  pose(dt, st, fwd, right) {
    const R = this.rig, b = R.b;
    if (!this.M) this.M = measure(R); // (the first call comes right after a reset to the rest pose)
    if (!this.S || this.styleSrc !== R.walkStyle) { this.S = this.style(); this.styleSrc = R.walkStyle; }
    const M = this.M, S = this.S, Fs = this.feet;
    const h = clamp(dt || 0, 0, 0.12);
    const root = R.root.position;
    const heading = st.heading || 0;
    // airY: how far the floor is above the terrain under the body. Steady, it is a raised floor (the shop's
    // podium); changing, a jump on foot (the legs tuck). Boots stand on the terrain + airY either way.
    const airY = Math.max(0, st.airY || 0);
    const groundY = root.y - airY, yHint = groundY + 0.5;
    if (h > 0) { if (Math.abs(airY - this.airPrev) > 5e-4) this.jumpT = 0; else this.jumpT += h; }
    this.airPrev = airY;
    const L = R.legLen;
    if (h === 0 || !this.ready || R.walkSnap || R.frame !== this.frame + 1 || Math.hypot(root.x - this.px, root.z - this.pz) > 2.5) this.reset(st, right, groundY);
    R.walkSnap = false;
    this.frame = R.frame;
    this.toes ??= [b.lFoot, b.rFoot].map((ft) => ft.children.find((c) => c.isBone && /toe/i.test(c.name)) || null);
    this.t += h;

    // ---- how the body really moves (callers' speeds can disagree with their positions: walls, slips)
    if (h > 0) {
      const k = ek(h, 14);
      this.vx += ((root.x - this.px) / h - this.vx) * k;
      this.vz += ((root.z - this.pz) / h - this.vz) * k;
      this.yawRate += (clamp(wrap(heading - this.heading) / h, -10, 10) - this.yawRate) * ek(h, 12);
    }
    this.dhFrame = h > 0 ? wrap(heading - this.heading) : 0;
    this.px = root.x; this.pz = root.z; this.heading = heading;
    const v = Math.hypot(this.vx, this.vz);
    if (h > 0) this.acc += (clamp((v - this.vPrev) / h, -6, 6) - this.acc) * ek(h, 6);
    this.vPrev = v;
    const dx = v > 0.2 ? this.vx / v : fwd.x, dz = v > 0.2 ? this.vz / v : fwd.z;
    // grade along the way (+ uphill)
    if (h > 0) {
      const g1 = world.groundHeight(root.x + dx * 0.6, root.z + dz * 0.6, yHint), g0 = world.groundHeight(root.x - dx * 0.6, root.z - dz * 0.6, yHint);
      this.grade += (clamp((g1 - g0) / 1.2, -1, 1) - this.grade) * ek(h, 5);
    }
    const up = clamp(this.grade, 0, 0.8), down = clamp(-this.grade, 0, 0.8);
    this.gy += (groundY - this.gy) * (h > 0 ? ek(h, 18) : 1);
    if (Math.abs(groundY - this.gy) > 0.5) this.gy = groundY;

    // ---- rhythm: cadence from the speed (and the leg's length), shorter quicker steps on slopes
    this.run += (sst(2.2, 3.4, v) - this.run) * (h > 0 ? ek(h, 5) : 1);
    const run = this.run;
    const legK = Math.sqrt(0.9 / L);
    const fW = S.cadence * 0.8 * Math.sqrt(Math.max(0.05, v)) * legK;
    const fR = S.cadence * (1.12 + 0.065 * v) * legK;
    const f = Math.max(0.8, lerp(fW, fR, run) * (1 + 0.8 * up + 1.0 * down));
    const beta = lerp(clamp(0.665 - 0.03 * v, 0.585, 0.66), 0.34, run);
    this.f = f; this.beta = beta;

    // ---- walking / standing
    const gaitSwing = (Fs[0].swing && Fs[0].kind === 'gait') || (Fs[1].swing && Fs[1].kind === 'gait');
    const air = airY > 0.01 && this.jumpT < 0.25;
    if (!this.walking && v > 0.15 && !air) {
      this.walking = true;
      const k = Fs[0].swing ? 0 : Fs[1].swing ? 1 : -1;
      if (k >= 0) {
        // a step on the spot already under way carries on as the first stride
        this.phase = fract(beta + Fs[k].s * (1 - beta) - 0.5 * k);
        Fs[k].kind = 'gait';
      } else {
        // the foot further behind (else the one without the weight) steps first
        const d0 = (Fs[0].P.x - root.x) * dx + (Fs[0].P.z - root.z) * dz, d1 = (Fs[1].P.x - root.x) * dx + (Fs[1].P.z - root.z) * dz;
        const first = Math.abs(d0 - d1) > 0.06 ? (d0 < d1 ? 0 : 1) : (R.idle?.w > 0 ? 0 : 1);
        this.phase = fract(beta - 0.012 - 0.5 * first);
      }
      for (const F of Fs) F.p = fract(this.phase + (F === Fs[1] ? 0.5 : 0));
    } else if (this.walking && (v < 0.08 || air) && !gaitSwing) this.walking = false;
    if ((this.walking || gaitSwing) && !air) this.phase = fract(this.phase + f * h);

    const moveT = this.walking || gaitSwing ? Math.max(0.3, sst(0.05, 0.9, v)) : 0;
    this.move += (moveT - this.move) * (h > 0 ? ek(h, moveT > this.move ? 7 : 4) : 1);
    const move = this.move, stand = 1 - move;

    // ---- feet: lift-off, swing targets, touch-down
    const ht0 = heading;
    for (let i = 0; i < 2; i++) {
      const F = Fs[i], side = i ? 1 : -1, p = fract(this.phase + 0.5 * i);
      F.tLand += h;
      if (this.walking && !air && F.planted && p >= beta) { this.liftFoot(F, 'gait'); F.p = p; }
      if (F.swing && F.kind === 'gait') {
        let s = p < F.p - 0.5 ? 1 : Math.max(F.s, clamp((p - beta) / (1 - beta), 0, 1));
        if (air) s = F.s;
        F.s = s; F.p = p;
        const tRem = (1 - s) * (1 - beta) / f;
        const ht = ht0 + clamp(this.yawRate, -4, 4) * tRem;
        const fx = Math.sin(ht), fz = Math.cos(ht), rx = -fz, rz = fx;
        // where the body will be when it lands, a little ahead of it (half the stance's travel walking)
        const lead = lerp(0.25, 0.085, run) * S.reach / f;
        const halfW = lerp(M.jw + S.width, M.jw * 0.55, run);
        this.setTarget(i, root.x + this.vx * (tRem + lead) + rx * side * halfW, root.z + this.vz * (tRem + lead) + rz * side * halfW,
          this.restYaw(i, ht), rx, rz, lerp(0.15, 0.1, run), yHint);
        // the boot meets the snow heel first, toe up as much as the leg reaches out in front
        const ahead = ((F.T.x - root.x - this.vx * tRem) * fx + (F.T.z - root.z - this.vz * tRem) * fz);
        F.pitchT = S.heel * (1 - 0.75 * run) * 0.55 * Math.max(0, Math.atan2(ahead, L * 0.95) - 0.1);
        if (s >= 1) this.plantFoot(F);
      }
    }

    // ---- standing: weight shifts, and steps on the spot when the body turns or stopped with the feet apart
    const I = R.idle;
    if (I && h > 0) {
      I.t -= h;
      if (I.t <= 0) { I.side = -I.side; I.t = 5 + Math.random() * 6; }
      I.w += (I.side - I.w) * ek(h, 1.3);
    }
    const w = (I ? I.w : 0) * stand; // + = weight on the right leg
    if (!this.walking && !gaitSwing && !air) {
      const rx = right.x, rz = right.z;
      const spin = sst(2.5, 4.5, Math.abs(this.yawRate)) * this.dhFrame;
      if (Math.abs(spin) > 1e-5) {
        const c = Math.cos(spin), sn = Math.sin(spin);
        const rot = (P) => { const x = P.x - root.x, z = P.z - root.z; P.x = root.x + x * c + z * sn; P.z = root.z - x * sn + z * c; };
        for (const F of Fs) { rot(F.P); rot(F.P0); rot(F.T); F.yaw += spin; F.yaw0 += spin; F.yawT += spin; }
      }
      let stepping = false;
      for (let i = 0; i < 2; i++) {
        const F = Fs[i];
        if (!F.swing) continue;
        stepping = true;
        F.s = Math.min(1, F.s + h / F.dur);
        // keep aiming under the body as it turns
        const side = i ? 1 : -1, ht = heading + clamp(this.yawRate, -4, 4) * (1 - F.s) * F.dur;
        const ox = -Math.cos(ht), oz = Math.sin(ht);
        this.setTarget(i, root.x + ox * side * S.idleW, root.z + oz * side * S.idleW, this.restYaw(i, ht), ox, oz, 0.16, yHint);
        F.pitchT = 0;
        if (F.s >= 1) { this.plantFoot(F); this.stepCD = 0.12; }
      }
      if (!stepping && h > 0) {
        this.stepCD -= h;
        if (this.stepCD <= 0) {
          let worst = -1, err = 0;
          const sep = (Fs[1].P.x - Fs[0].P.x) * rx + (Fs[1].P.z - Fs[0].P.z) * rz;
          for (let i = 0; i < 2; i++) {
            const F = Fs[i], side = i ? 1 : -1;
            const ex = F.P.x - (root.x + rx * side * S.idleW), ez = F.P.z - (root.z + rz * side * S.idleW);
            const e = Math.hypot(ex, ez) / 0.14 + Math.abs(wrap(F.yaw - this.restYaw(i, heading))) / 0.45;
            if (e > err) { err = e; worst = i; }
          }
          if (err > 1 || sep < 0.12) {
            const F = Fs[worst];
            this.liftFoot(F, 'step');
            F.dur = S === PLAYER_STYLE ? 0.34 : 0.42;
            F.lift = 0.05;
          }
        }
      }
    }

    // ---- this frame's contact frames: planted feet on their spot, swinging feet along their arc
    for (let i = 0; i < 2; i++) {
      const F = Fs[i];
      if (F.swing) {
        const s = F.s, gaitK = F.kind === 'gait' ? 1 : 0;
        // horizontal: eased (no speed at lift-off and touch-down); vertical: an arc that peaks early
        const e = (1 - Math.cos(Math.PI * Math.pow(s, lerp(1, 1.15, run * gaitK)))) / 2;
        F.C.lerpVectors(F.P0, F.T, e);
        // clear the snow under the boot's toe as well as under the ankle (walking up a slope)
        const fyw = F.yaw0 + wrap(F.yawT - F.yaw0) * e, tipD = this.M.feet[i].tip;
        const gC = Math.max(world.groundHeight(F.C.x, F.C.z, yHint), world.groundHeight(F.C.x + Math.sin(fyw) * tipD, F.C.z + Math.cos(fyw) * tipD, yHint) - 0.02);
        const lineY = lerp(F.P0.y, F.T.y, e);
        const liftH = gaitK ? lerp(0.075 * S.lift * (1 + 1.2 * up), 0.34, run) * Math.min(1, 0.4 + 0.6 * move) + 0.02 * down : F.lift;
        const arc = Math.sin(Math.PI * Math.pow(s, lerp(0.78, 0.55, run * gaitK)));
        F.cy = Math.max(lineY, gC) + liftH * arc + airY;
        F.cn.lerpVectors(F.n0, F.nT, e).normalize();
        F.cyaw = F.yaw0 + wrap(F.yawT - F.yaw0) * e;
        F.pitch = lerp(F.pitch0, F.pitchT, sst(0.05, 0.92, s));
        // the toe swings forward through the middle of the step (a little toe-up clearance)
        F.pitch += Math.sin(Math.PI * s) * 0.12 * gaitK * (1 - run);
        F.pivotW = sst(0.1, 0.9, s);
        // a slight outward arc around the standing boot
        const side = i ? 1 : -1;
        F.C.x += right.x * side * 0.02 * arc; F.C.z += right.z * side * 0.02 * arc;
      } else {
        F.C.copy(F.P); F.cy = F.P.y + airY; F.cn.copy(F.n); F.cyaw = F.yaw; F.pivotW = F.pitch >= 0 ? 1 : 0;
      }
    }

    // ---- pelvis
    const ph = this.phase;
    // walking: legs long under the body at mid-stance, the pelvis dips as far as the stride needs at double
    // support; running: lowest at mid-stance (absorbing), highest in flight
    const half = Math.min(L * 0.8, v / (4 * f) * S.reach);
    const dip = Math.max(0, L * 0.978 - Math.sqrt((L * 0.99) ** 2 - Math.max(0, half - 0.03) ** 2)) * S.bob + 0.004;
    const c2 = Math.cos(2 * TAU * (ph - beta / 2));
    const bob = lerp(-dip * 0.5 * (1 - c2), -0.026 * S.bob * c2, run) * move;
    const sway = -Math.cos(TAU * (ph - beta / 2)) * lerp(0.024 * S.sway, 0.008, run) * move;
    const yawP = -Math.cos(TAU * ph) * lerp(0.075 + 0.015 * Math.min(v, 2), 0.13, run) * S.hipRot * move;
    const rollP = Math.cos(TAU * (ph - beta / 2)) * lerp(0.05, 0.055, run) * move;
    // lean: into the run, into the climb, back a touch going down, with the acceleration
    const lean = (S.lean + 0.15 * run * S.runLean) * (0.4 + 0.6 * move) + (Math.atan(up) * 0.5 - Math.atan(down) * 0.22) * (0.35 + 0.65 * move)
      + clamp(this.acc, -3, 3) * 0.022 * move + (st.carry ? 0.025 : 0);
    // after a stop with the feet apart the body balances over them; during a step on the spot it moves
    // over the standing foot
    const hip = V[0].set(root.x, 0, root.z).addScaledVector(right, sway + 0.03 * w);
    const midx = (Fs[0].C.x + Fs[1].C.x) / 2, midz = (Fs[0].C.z + Fs[1].C.z) / 2;
    hip.x += (midx - root.x) * 0.45 * stand; hip.z += (midz - root.z) * 0.45 * stand;
    for (let i = 0; i < 2; i++) {
      const F = Fs[i], O = Fs[1 - i];
      if (F.swing && F.kind === 'step') {
        const env = Math.sin(Math.PI * F.s) * 0.3;
        hip.x += (O.P.x - hip.x) * env; hip.z += (O.P.z - hip.z) * env;
      }
    }
    hip.addScaledVector(fwd, (run * 0.05 + up * 0.25) * move);
    // height: legs nearly straight standing, a little give walking, more running and going down hill
    let ext = lerp(0.993 - 0.006 * Math.abs(w), 0.978, move);
    ext = lerp(ext, 0.935, run) - 0.1 * down - 0.02 * up;
    // a landing from a jump on foot sinks in and comes back
    if (h > 0) this.land = Math.max(0, this.land - h * 5);
    this.air += ((air ? 1 : 0) - this.air) * (h > 0 ? ek(h, air ? 14 : 30) : 1);
    if (this.wasAir && !air) {
      // touch-down after a jump on foot: both boots land under the body (the gait carries on from there)
      this.land = 1;
      for (let i = 0; i < 2; i++) {
        const F = Fs[i], side = i ? 1 : -1;
        F.T.set(root.x + right.x * side * S.idleW, 0, root.z + right.z * side * S.idleW);
        F.T.y = world.groundHeight(F.T.x, F.T.z, yHint);
        gnormal(F.T.x, F.T.z, yHint, F.nT);
        F.yawT = this.restYaw(i, heading); F.pitchT = 0;
        this.plantFoot(F);
        F.C.copy(F.P); F.cy = F.P.y + airY; F.cn.copy(F.n); F.cyaw = F.yaw; F.pivotW = 1;
      }
    }
    hip.y = this.gy + airY + M.feet[0].ankA + L * ext + R.upLegDrop + bob - 0.06 * Math.sin(this.land * Math.PI) * (this.land > 0 ? 1 : 0)
      + Math.sin(this.t * 1.6) * 0.003 * S.breathe * stand;
    b.hips.position.copy(b.hips.parent.worldToLocal(V[1].copy(hip)));
    b.hips.updateMatrixWorld(true);
    // turning on the spot: the hips follow the feet part of the way, the chest and head lead
    const fy = wrap(((Fs[0].cyaw - this.restYaw(0, 0)) + wrap((Fs[1].cyaw - this.restYaw(1, 0)) - (Fs[0].cyaw - this.restYaw(0, 0))) / 2) - heading);
    this.turn += (clamp(fy, -0.7, 0.7) * 0.45 * stand - this.turn) * (h > 0 ? ek(h, 10) : 1);
    rotW(b.hips, UP, yawP + this.turn);
    rotW(b.hips, fwd, rollP - 0.05 * w);
    rotW(b.hips, right, -lean * 0.3);
    R.fixPosture(right);

    // ---- legs: boots on the snow (stance roll from the leg's angle over the boot), knees over the toes
    const J = [wpos(b.lUp, V[2]), wpos(b.rUp, V[3])];
    for (let i = 0; i < 2; i++) this.footTarget(i, J[i], st, w, airY, run, S);
    // lower the pelvis just as far as the legs on the snow need to reach their boots
    let drop = 0;
    for (let i = 0; i < 2; i++) {
      const F = Fs[i];
      const wgt = F.planted ? 1 : F.kind === 'gait' ? sst(0.75, 1, F.s) : 0;
      if (wgt <= 0 || this.air > 0.5) continue;
      const A = F.ankle, Jp = J[i];
      const dMax = L * 0.99;
      const dxz2 = (Jp.x - A.x) ** 2 + (Jp.z - A.z) ** 2;
      const yMax = A.y + Math.sqrt(Math.max(0, dMax * dMax - dxz2));
      drop = Math.max(drop, (Jp.y - yMax) * wgt);
    }
    if (drop > 0) {
      const k = 0.03, d = drop < 2 * k ? (drop * drop) / (4 * k) : drop - k;
      hip.y -= Math.min(d, 0.1);
      b.hips.position.copy(b.hips.parent.worldToLocal(V[1].copy(hip)));
      b.hips.updateMatrixWorld(true);
    }
    for (let i = 0; i < 2; i++) {
      const F = Fs[i], side = i ? 1 : -1;
      const [upB, legB, footB] = i === 0 ? [b.lUp, b.lLeg, b.lFoot] : [b.rUp, b.rLeg, b.rFoot];
      // knee: over the boot's toe, a little outward; running, driving forward
      const pole = V[4].copy(F.f).multiplyScalar(0.65).addScaledVector(fwd, 0.35 + 0.3 * run).addScaledVector(right, side * 0.08).normalize();
      ik2(upB, legB, footB, F.ankle, pole, 0.012);
      setWQ(footB, F.q);
      // the boot's toe stays on the snow as the heel peels up (a stiff shell: it bends only a little)
      const toe = this.toes?.[i];
      if (toe && F.pitch < 0) rotW(toe, F.ax, -F.pitch * 0.3 * (F.planted ? 1 : 1 - F.s));
    }
    this.wasAir = air;

    // ---- spine: lean, chest up, counter-rotation, level shoulders, breathing
    const chestTwist = -yawP * (1.25 + 0.4 * run) - this.turn * 0.85;
    rotW(b.spine0, right, -lean * 0.35);
    rotW(b.spine1, right, -lean * 0.35 - S.slouch * 0.35);
    rotW(b.spine2, right, S.chest - S.slouch * 0.65 + Math.sin(this.t * 1.6) * 0.012 * S.breathe * stand);
    rotW(b.spine0, UP, chestTwist * 0.25);
    rotW(b.spine1, UP, chestTwist * 0.4);
    rotW(b.spine2, UP, chestTwist * 0.35);
    rotW(b.spine1, fwd, -rollP * 0.75 + 0.035 * w);

    // ---- arms
    this.poseArms(st, fwd, right, move, run, stand, w, down, S, M);

    // ---- head: level, looking ahead (a little down walking), looking around when standing
    const look = stand * S.look * (Math.sin(this.t * 0.23) * 0.32 + Math.sin(this.t * 0.61) * 0.1) + clamp(st.lookYaw || 0, -1.2, 1.2) * 0.7;
    const pitchD = (S.gaze - 0.02 * run) * (0.3 + 0.7 * move) + up * 0.15 * move;
    this.aimHead(heading + look, pitchD, 0.88);
    rotW(b.neck, fwd, -0.025 * w);

    // the skis on the back follow the gait (SkierRig.placeOnBack)
    R.gait.move = move; R.gait.run = run;
    if (h === 0) this.ready = false; // a static pose (body measurements): the next real frame starts fresh
  }

  // Ankle target and boot orientation for foot i from its contact frame and roll.
  footTarget(i, J, st, w, airY, run, S) {
    const R = this.rig, M = this.M, F = this.feet[i], m = M.feet[i], side = i ? 1 : -1;
    const n = F.cn;
    const f = F.f.set(Math.sin(F.cyaw), 0, Math.cos(F.cyaw));
    f.addScaledVector(n, -f.dot(n)).normalize();
    const ax = F.ax.crossVectors(f, n).normalize(); // the boot's right: + rotation lifts the toe
    const O = V[6].set(F.C.x, F.cy, F.C.z);
    const A0 = V[7].copy(O).addScaledVector(n, m.ankA);
    if (F.planted) {
      // stance roll: toe up while the leg still reaches forward (eased flat right after the heel lands),
      // flat under the body, heel peeling up once the hips are past the boot (ski boot: early and firm)
      const along = (J.x - A0.x) * f.x + (J.y - A0.y) * f.y + (J.z - A0.z) * f.z;
      const vert = (J.x - A0.x) * n.x + (J.y - A0.y) * n.y + (J.z - A0.z) * n.z;
      const gam = Math.atan2(along, Math.max(0.2, vert));
      let p = S.heel * (1 - 0.75 * run) * 0.55 * Math.max(0, -gam - 0.1) * (1 - sst(0.03, 0.2, F.tLand));
      p -= Math.max(0, gam - lerp(0.1, 0.02, run)) * lerp(0.95, 1.2, run);
      // the leg without the weight standing: heel a little off the snow, knee soft
      p -= 0.07 * Math.max(0, -side * w);
      p = clamp(p, -0.6, 0.3);
      F.pitch = F.tLand < 0.07 ? lerp(F.pitchLand, p, sst(0, 0.07, F.tLand)) : p;
      F.pivotW = F.pitch >= 0 ? 1 : 0;
    }
    // pivot: the heel's edge when the toe is up, the ball of the boot when the heel is up (blended in the air)
    const pitch = F.pitch;
    const heelP = V[8].copy(O).addScaledVector(f, -m.heel), ballP = V[9].copy(O).addScaledVector(f, m.ball + 0.02);
    const piv = F.swing ? V[10].lerpVectors(ballP, heelP, F.pivotW) : pitch >= 0 ? heelP : ballP;
    F.ankle.subVectors(A0, piv).applyAxisAngle(ax, pitch).add(piv);
    // jumping on foot: the legs tuck under the body
    if (this.air > 0.001) {
      const tuck = V[11].copy(J).addScaledVector(UP, -R.legLen * 0.86).addScaledVector(V[12].set(Math.sin(this.heading), 0, Math.cos(this.heading)), 0.05);
      F.ankle.lerp(tuck, this.air);
    }
    // boot orientation: on the snow's slope, along its yaw, rolled by the pitch
    _bm.makeBasis(V[13].copy(ax).negate(), n, f);
    F.q.setFromRotationMatrix(_bm);
    F.q.premultiply(Qs[0].setFromAxisAngle(ax, pitch - (this.air > 0.001 ? 0.15 * this.air : 0)));
    F.q.multiply(Qs[1].setFromAxisAngle(UP, -m.yaw)).multiply(i === 0 ? R.footRest.l : R.footRest.r);
  }

  // Arms swing from the shoulders opposite to the legs (a little behind them): soft elbows walking, bent
  // about 90 deg and pumping running, hanging relaxed by the thighs standing; hands always clear the jacket.
  poseArms(st, fwd, right, move, run, stand, w, down, S, M) {
    const R = this.rig, b = R.b;
    R.relaxShoulders(1 + 0.25 * stand);
    const tr = V[14].subVectors(wpos(b.rArm, V[15]), wpos(b.lArm, V[16]));
    tr.y = 0;
    if (tr.lengthSq() < 1e-6) tr.copy(right); else tr.normalize();
    const tf = V[17].crossVectors(UP, tr);
    const hc = wpos(b.hips, V[18]);
    const carry = st.carry ? 0.85 : 1;
    const v = Math.hypot(this.vx, this.vz);
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      const [arm, fore, hand] = i === 0 ? [b.lArm, b.lFore, b.lHand] : [b.rArm, b.rFore, b.rHand];
      const out = V[19].copy(tr).multiplyScalar(side);
      const sh = wpos(arm, V[20]);
      // -1 back .. +1 forward: the left arm comes forward with the right leg
      const a = Math.cos(TAU * (this.phase - (i ? 0 : 0.5) - S.lag));
      const ampW = (0.18 + 0.06 * Math.min(v, 2.2)) * S.armSwing * carry;
      const ampR = 0.4 * carry;
      const amp = lerp(ampW, ampR, run) * move;
      const alpha = lerp(0.03, lerp(S.arm0, -0.28, run), move) + amp * a;
      // elbow: nearly straight at the back of the swing, softly bent in front; ~90-100 deg running
      const kW = (0.17 + 0.32 * (0.5 + 0.5 * a)) * S.elbow;
      const kR = 1.55 + 0.2 * a;
      const kappa = lerp(0.2 + 0.03 * Math.sin(this.t * 0.8 + i), lerp(kW, kR, run), move);
      const abd = 0.1 + 0.05 * down + 0.04 * run;
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      const u = V[21].set(0, -ca, 0).addScaledVector(tf, sa).multiplyScalar(Math.cos(abd)).addScaledVector(out, Math.sin(abd)).normalize();
      const elbow = V[22].copy(sh).addScaledVector(u, M.U);
      const ck = Math.cos(alpha + kappa), sk = Math.sin(alpha + kappa);
      // forearm: on from the elbow, a little in front of the body as it comes forward
      const fd = V[23].set(0, -ck, 0).addScaledVector(tf, sk).addScaledVector(out, Math.sin(abd) * 0.5 - (0.06 + 0.18 * run) * Math.max(0, a) * move).normalize();
      const tgt = V[24].copy(elbow).addScaledVector(fd, M.F);
      // standing: a slow breath sway
      tgt.addScaledVector(tf, Math.sin(this.t * 0.8 + i * 1.3) * 0.006 * stand);
      // clear of the hips / jacket beside the body
      const lat = (tgt.x - hc.x) * out.x + (tgt.z - hc.z) * out.z;
      const fwdOff = Math.abs((tgt.x - hc.x) * tf.x + (tgt.z - hc.z) * tf.z);
      const need = R.hipHalfW + 0.035 - lat;
      if (need > 0) tgt.addScaledVector(out, need * (1 - sst(0.12, 0.26, fwdOff)));
      const pole = V[25].subVectors(elbow, V[26].addVectors(sh, tgt).multiplyScalar(0.5));
      if (pole.lengthSq() < 1e-6) pole.copy(tf).negate().addScaledVector(out, 0.3);
      pole.normalize().addScaledVector(tf, -0.25).normalize();
      ik2(arm, fore, hand, tgt, pole);
      // hand: on from the forearm, fingers loosely curled, palm toward the thigh (a loose fist running)
      const palm = V[27].copy(out).negate().addScaledVector(tf, -0.3 * stand - 0.1 * move).addScaledVector(UP, -0.35 * run * move).normalize();
      const dir = V[28].subVectors(wpos(hand, V[29]), wpos(fore, V[30])).normalize().addScaledVector(UP, -0.4 * (1 - run) * move)
        .normalize().addScaledVector(palm, 0.1 + 0.06 * stand + 0.2 * run * move).normalize();
      R.aimHand(i, dir, palm);
    }
  }

  // Turn the neck and head so the face looks along (yaw, pitch), `k` of the way (a little life remains).
  aimHead(yaw, pitch, k) {
    const b = this.rig.b, M = this.M;
    if (!b.head) return;
    const cp = Math.cos(pitch);
    const want = V[31].set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    for (const [bone, part] of [[b.neck, 0.4], [b.head, 1]]) {
      if (!bone) continue;
      const cur = V[5].copy(M.headFwd).applyQuaternion(wquat(b.head, Qs[2]));
      const q = Qs[3].setFromUnitVectors(cur, want);
      const ang = 2 * Math.acos(clamp(q.w, -1, 1));
      if (ang > 0.9) q.slerp(Qs[4].identity(), 1 - 0.9 / ang);
      rotWQ(bone, Qs[5].identity().slerp(q, part * k));
    }
  }
}
