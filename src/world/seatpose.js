// Relaxed seated poses for the Wolkenspitzbahn's passengers (railway.js bakes them). The skier rig's own 'sit' is a
// chairlift pose (legs dangling, arms forward); on top of it, with the rig's bone map (skier.js BONES):
//  - a slight slouch into the backrest, the hips a little forward
//  - feet flat on the floor, knees a little apart
//  - the arms by kind: 'thighs' (hands resting on them), 'lap' (hands together in the lap), 'crossed' (arms folded),
//    'phone' (both hands holding a phone at chest height, the head bowed over it)
//  - the head turned by `look` (radians, + = to the passenger's left) and bowed a little
// The rig must stand at the origin facing +z (heading 0) with its seat at the origin. Returns, for 'phone', the
// phone's world matrix (in that frame), else null.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, 1), RIGHT = new THREE.Vector3(-1, 0, 0);
const _v = new THREE.Vector3(), _s = new THREE.Vector3();
const wpos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
const wquat = (o) => { const q = new THREE.Quaternion(); o.matrixWorld.decompose(_v, q, _s); return q; };
function setWQ(bone, q) {
  bone.quaternion.copy(wquat(bone.parent).invert().multiply(q));
  bone.updateMatrixWorld(true);
}
function rotW(bone, axis, angle) {
  if (!bone || !angle) return;
  setWQ(bone, new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(wquat(bone)));
}
// rotate `bone` (about its own origin) so that the direction pivot->from points along pivot->to
function aim(bone, from, to, pivot) {
  const u = from.clone().sub(pivot).normalize(), w = to.clone().sub(pivot).normalize();
  if (u.lengthSq() < 1e-8 || w.lengthSq() < 1e-8) return;
  setWQ(bone, new THREE.Quaternion().setFromUnitVectors(u, w).multiply(wquat(bone)));
}
// two-bone IK: the middle joint on its circle toward `pole`, then the lower bone at the target
function twoBone(a, b, c, target, pole) {
  if (!a || !b || !c) return;
  const pa = wpos(a), pb = wpos(b), pc = wpos(c);
  const lab = pa.distanceTo(pb), lbc = pb.distanceTo(pc);
  const dir = target.clone().sub(pa);
  const d = Math.min(Math.max(dir.length(), Math.abs(lab - lbc) + 1e-3), lab + lbc - 1e-3);
  dir.normalize();
  const cosA = (lab * lab + d * d - lbc * lbc) / (2 * lab * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const pd = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  const mid = pa.clone().addScaledVector(dir, lab * cosA).addScaledVector(pd, lab * sinA);
  aim(a, pb, mid, pa);
  const pb2 = wpos(b), pc2 = wpos(c);
  aim(b, pc2, pa.clone().addScaledVector(dir, d), pb2);
}

/** Pose a seated rig (after its 'sit' update). kind: thighs | lap | crossed | phone; look: head yaw; rnd: 0..1 jitter. */
export function poseSeated(rig, kind, look = 0, rnd = 0.5) {
  const b = rig?.b;
  if (!b?.hips) return null;
  rig.root.updateMatrixWorld(true);
  // slouch: the pelvis a touch forward, the back leaning into the backrest, the neck bringing the eyes level again
  const hip = wpos(b.hips).addScaledVector(FWD, 0.035).addScaledVector(UP, -0.012);
  b.hips.position.copy(b.hips.parent.worldToLocal(hip.clone()));
  b.hips.updateMatrixWorld(true);
  const slouch = 0.07 + rnd * 0.06;
  rotW(b.spine0, RIGHT, slouch * 0.55);
  rotW(b.spine1, RIGHT, slouch * 0.45);
  rotW(b.neck, RIGHT, -slouch * 0.6);
  // legs: feet flat on the floor in front of the seat, knees a little apart
  const seatY = hip.y - 0.1 + 0.012;
  for (const [i, up, leg, foot] of [[0, b.lUp, b.lLeg, b.lFoot], [1, b.rUp, b.rLeg, b.rFoot]]) {
    const side = i === 0 ? -1 : 1;
    const ankle = new THREE.Vector3(0, seatY - 0.41, 0).addScaledVector(FWD, 0.39 + (rnd - 0.5) * 0.08 + (i ? 0.03 : -0.02))
      .addScaledVector(RIGHT, side * (0.11 + rnd * 0.05));
    twoBone(up, leg, foot, ankle, FWD.clone().addScaledVector(RIGHT, side * 0.25).addScaledVector(UP, 0.3));
    const fr = rig.footRest?.[i === 0 ? 'l' : 'r'];
    if (foot && fr) setWQ(foot, new THREE.Quaternion().setFromAxisAngle(RIGHT, -0.04).multiply(fr.clone()));
  }
  // arms
  const sh = (i) => wpos(i === 0 ? b.lArm : b.rArm);
  const chest = sh(0).add(sh(1)).multiplyScalar(0.5);
  const hipNow = wpos(b.hips);
  // a point on the top of a thigh, `t` of the way from the hip joint to the knee (the legs are posed above)
  const thigh = (i, t) => { const up = wpos(i === 0 ? b.lUp : b.rUp), kn = wpos(i === 0 ? b.lLeg : b.rLeg); return up.lerp(kn, t).addScaledVector(UP, 0.085); };
  const target = (i) => {
    const side = i === 0 ? -1 : 1;
    if (kind === 'lap') return thigh(0, 0.42).lerp(thigh(1, 0.42), 0.5).addScaledVector(RIGHT, side * 0.04).addScaledVector(UP, 0.01);
    if (kind === 'crossed') return chest.clone().addScaledVector(UP, -0.26 + (i ? 0.025 : 0)).addScaledVector(FWD, 0.19 + (i ? 0.03 : 0)).addScaledVector(RIGHT, -side * 0.12);
    if (kind === 'phone') return chest.clone().addScaledVector(UP, -0.2).addScaledVector(FWD, 0.3).addScaledVector(RIGHT, side * 0.035);
    return thigh(i, 0.55 + rnd * 0.15).addScaledVector(RIGHT, side * 0.015);
  };
  const pole = (i) => {
    const side = i === 0 ? -1 : 1;
    if (kind === 'crossed') return RIGHT.clone().multiplyScalar(side).addScaledVector(UP, -0.4).addScaledVector(FWD, 0.1).normalize();
    if (kind === 'phone') return RIGHT.clone().multiplyScalar(side * 0.6).addScaledVector(UP, -1).addScaledVector(FWD, -0.15).normalize();
    return RIGHT.clone().multiplyScalar(side * 0.7).addScaledVector(UP, -1).addScaledVector(FWD, -0.5).normalize();
  };
  rig.relaxShoulders?.();
  for (const i of [0, 1]) {
    const [arm, fore, hand] = i === 0 ? [b.lArm, b.lFore, b.lHand] : [b.rArm, b.rFore, b.rHand];
    twoBone(arm, fore, hand, target(i), pole(i));
    if (hand && fore) setWQ(hand, wquat(fore)); // a straight, relaxed wrist
  }
  // the head: turned, bowed a little (over the phone: more)
  const bow = kind === 'phone' ? 0.42 : 0.08 + rnd * 0.08;
  rotW(b.neck, UP, look * 0.35);
  rotW(b.head, UP, look * 0.65);
  const yawRight = RIGHT.clone().applyAxisAngle(UP, look);
  rotW(b.head, yawRight, -bow);
  rig.root.updateMatrixWorld(true);
  if (kind !== 'phone' || !b.rHand || !b.lHand) return null;
  // the phone between the hands, its screen toward the eyes
  const hl = wpos(b.lHand), hr = wpos(b.rHand);
  const c = hl.add(hr).multiplyScalar(0.5).addScaledVector(FWD, 0.05).addScaledVector(UP, 0.03);
  const eye = wpos(b.head).addScaledVector(UP, 0.08).addScaledVector(FWD, 0.08);
  const m = new THREE.Matrix4().lookAt(eye, c, FWD); // (+z toward the eye: the screen's side)
  m.setPosition(c);
  return m;
}
