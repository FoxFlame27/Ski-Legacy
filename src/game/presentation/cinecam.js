// Shared helpers for the broadcast cameras (race intro, replay, podium): posing the game camera,
// keeping it above the snow, and driving a skier rig directly while a cinematic owns it.
import * as THREE from 'three';
import { world } from '../../world/world.js';

const _p = new THREE.Vector3(), _q = new THREE.Quaternion();
export const RAD = 180 / Math.PI;
export const UP = new THREE.Vector3(0, 1, 0);

/** Smoothest ease (C2): 0..1 -> 0..1. */
export const ease = (t) => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * x * (x * (x * 6 - 15) + 10); };
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const damp = (k, dt) => 1 - Math.exp(-k * dt);

/**
 * Pose the game camera: position, look-at point, vertical FOV (deg). `blend` (0..1) mixes toward the
 * pose the camera already has this frame (the gameplay chase camera, computed by player.update),
 * for seamless hand-overs.
 */
export function applyCamera(cam, pos, look, fov, blend = 0, roll = 0) {
  const f0 = cam.fov;
  if (blend > 0) { _p.copy(cam.position); _q.copy(cam.quaternion); }
  cam.position.copy(pos);
  cam.up.set(0, 1, 0);
  cam.lookAt(look);
  if (roll) cam.rotateZ(roll);
  cam.fov = fov;
  if (blend > 0) {
    cam.position.lerp(_p, blend);
    cam.quaternion.slerp(_q, blend);
    cam.fov = fov + (f0 - fov) * blend;
  }
  cam.near = 0.1;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

/** Keep a camera point at least `clear` m above the ground (bridge decks count below `p.y + 3`). */
export function keepAbove(p, clear = 1) {
  const g = world.groundHeight(p.x, p.z, p.y + 3);
  if (Number.isFinite(g) && p.y < g + clear) p.y = g + clear;
  return p;
}

export function ground(x, z, yHint = Infinity) {
  const g = world.groundHeight(x, z, yHint);
  return Number.isFinite(g) ? g : 0;
}

/** FOV (deg) that frames a subject `size` m tall at distance d, clamped. */
export const frameFov = (size, d, lo, hi) => Math.min(hi, Math.max(lo, 2 * Math.atan(size / Math.max(0.5, d)) * RAD));

// ------------------------------------------------------------------ rigs
// While a cinematic poses a rig, the owner's own per-frame rig.update (player.update) is muted so the
// two never fight over the pose; the cinematic calls the real update itself.
export function lockRig(rig) {
  if (!rig || rig.__cine) return;
  rig.__cine = { update: rig.update, own: Object.prototype.hasOwnProperty.call(rig, 'update') };
  rig.update = () => {};
}

export function unlockRig(rig) {
  const c = rig?.__cine;
  if (!c) return;
  if (c.own) rig.update = c.update; else delete rig.update;
  delete rig.__cine;
}

/** Pose a rig at (x, y, z) with a rig state (see SkierRig.update). Works on locked and free rigs. */
export function poseRig(rig, x, y, z, dt, st) {
  if (!rig) return;
  const fn = rig.__cine ? rig.__cine.update : rig.update;
  rig.root.position.set(x, y, z);
  if (rig.gear) { rig.gear.position.set(0, 0, 0); rig.gear.rotation.set(0, 0, 0); } // gear is posed in world space
  rig.setHeadHidden?.(false);
  fn.call(rig, Math.max(1e-4, dt), st);
}

export function showRig(rig, v) {
  if (!rig) return;
  rig.root.visible = v;
  if (rig.gear) rig.gear.visible = v;
}
