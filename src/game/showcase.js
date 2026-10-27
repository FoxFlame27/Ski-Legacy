// Character showcase for the menu: the selected skier stands in the village plaza in front of the
// camera (gondola station and the main mountain behind), so character select shows the real 3D model.
import * as THREE from 'three';
import { world } from '../world/world.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Showcase {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {(charId: string) => import('../player/skier.js').SkierRig} o.makeRig
   * @param {{x:number, z:number}} [o.spot]      where the character stands
   * @param {{x:number, z:number}} [o.lookAt]    what the camera looks toward (the backdrop)
   * @param {'left'|'right'} [o.side]           screen side for the character (the menu panel is on the other side)
   */
  constructor({ scene, camera, makeRig, spot = { x: 6, z: 8 }, lookAt = { x: 0, z: -2350 }, side = 'left' }) {
    this.scene = scene;
    this.camera = camera;
    this.makeRig = makeRig;
    this.rigs = new Map();
    this.rig = null;
    this.charId = null;
    this.active = false;
    this.time = 0;
    this.spin = 0; // extra yaw from dragging / arrow keys
    this.pose = 'ski'; // athletic ski stance with planted poles reads best on the showcase
    this.focus = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.place(spot, lookAt, side);
  }

  place(spot, lookAt, side = 'left') {
    const dir = new THREE.Vector3(lookAt.x - spot.x, 0, lookAt.z - spot.z).normalize();
    const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
    // camera shifts sideways -> the character sits beside the menu panel; narrower windows need less shift
    const off = (side === 'left' ? 1 : -1) * Math.min(1, this.camera.aspect / 1.6);
    const y = world.height(spot.x, spot.z);
    this.focus.set(spot.x, y, spot.z);
    const cx = spot.x - dir.x * 4.3 + right.x * 0.95 * off, cz = spot.z - dir.z * 4.3 + right.z * 0.95 * off;
    this.camPos.set(cx, Math.max(world.height(cx, cz), y) + 1.32, cz);
    this.camLook.copy(this.camPos).addScaledVector(dir, 10).add(new THREE.Vector3(0, -0.55, 0));
    // the skier faces the camera, turned a little so the outfit reads in 3/4 view
    this.heading = Math.atan2(cx - spot.x, cz - spot.z) - 0.42 * off;
  }

  /** Show a character (null hides the showcase). Rigs are created once per character and kept. */
  show(charId) {
    if (!charId) return this.hide();
    if (this.rig && this.charId !== charId) this.rig.root.visible = this.rig.gear.visible = false;
    let rig = this.rigs.get(charId);
    if (!rig) {
      rig = this.makeRig(charId);
      rig.addTo(this.scene);
      this.rigs.set(charId, rig);
    }
    rig.root.visible = rig.gear.visible = true;
    rig.setSkisVisible(true);
    rig.setCarry?.(false);
    rig.root.position.copy(this.focus);
    if (this.charId !== charId) this.spin = 0;
    this.rig = rig;
    this.charId = charId;
    this.active = true;
  }

  hide() {
    for (const rig of this.rigs.values()) rig.removeFrom(this.scene);
    this.rigs.clear();
    this.rig = null;
    this.charId = null;
    this.active = false;
  }

  /** Per frame while active: animate the skier and frame it with the camera. */
  update(dt) {
    if (!this.active || !this.rig) return;
    this.time += dt;
    this.rig.update(dt, {
      mode: this.pose, heading: this.heading + this.spin, speed: 0, crouch: this.pose === 'ski' ? 0.15 : 0, lean: 0, plow: 0, normal: UP, air: false,
      lookYaw: Math.sin(this.time * 0.35) * 0.25, lookPitch: 0,
    });
    // slow cinematic drift so the shot feels alive
    const s = Math.sin(this.time * 0.18) * 0.12;
    this.camera.position.copy(this.camPos).add(new THREE.Vector3(s, Math.sin(this.time * 0.23) * 0.04, 0));
    this.camera.lookAt(this.camLook);
    this.camera.fov = 40;
    this.camera.updateProjectionMatrix();
  }
}
