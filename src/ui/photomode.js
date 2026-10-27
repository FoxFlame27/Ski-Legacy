// Photo mode (P, free ride): the world freezes, the HUD steps aside and the camera is yours, orbiting
// your skier. Mouse = orbit, wheel = closer / further, Q / E = lower / higher, H = hide the hint bar,
// P or Esc = back to the game. The camera is set right before every render (scene.onBeforeRender), so
// nothing else has to know photo mode exists; main.js only freezes the frame time while `active`.
import * as THREE from 'three';
import { world } from '../world/world.js';

const _focus = new THREE.Vector3(), _off = new THREE.Vector3();

export class PhotoMode {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {object} o.player       (pos, view, rig)
   * @param {{el: HTMLElement}} o.hud
   * @param {() => boolean} o.canEnter  free ride, nothing else open
   * @param {() => void} [o.onExit]     e.g. lock the pointer again
   */
  constructor({ scene, camera, player, hud, canEnter, onExit }) {
    Object.assign(this, { scene, camera, player, hud, canEnter, onExit });
    this.active = false;
    this.orbit = { yaw: 0, pitch: 0.2, dist: 6, lift: 0 };
    this.el = document.createElement('div');
    this.el.id = 'photomode';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="pm-bar paper">
        <span class="pm-kick">PHOTO MODE</span>
        <span class="hint"><i class="kc kc-word">MOUSE</i><em>Orbit</em></span>
        <span class="hint"><i class="kc kc-word">SCROLL</i><em>Zoom</em></span>
        <span class="hint"><i class="kc">Q</i><i class="kc">E</i><em>Height</em></span>
        <span class="hint"><i class="kc">H</i><em>Hide this</em></span>
        <span class="hint"><i class="kc">P</i><em>Back to the game</em></span>
      </div>`;
    document.body.appendChild(this.el);
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyP') {
        if (this.active) { e.stopImmediatePropagation(); this.exit(); } else if (this.canEnter?.()) { e.stopImmediatePropagation(); this.enter(); }
        return;
      }
      if (!this.active) return;
      if (e.code === 'KeyH') { this.el.classList.toggle('pm-hidden'); e.stopImmediatePropagation(); }
      if (e.code === 'Escape') this.exit(true); // (the pause menu takes over)
    }, true);
    this.keys = new Set();
    addEventListener('keydown', (e) => { if (this.active) this.keys.add(e.code); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('mousemove', (e) => {
      if (!this.active) return;
      const locked = !!document.pointerLockElement, dx = locked ? e.movementX : (e.buttons ? e.movementX : 0), dy = locked ? e.movementY : (e.buttons ? e.movementY : 0);
      this.orbit.yaw -= dx * 0.004;
      this.orbit.pitch = Math.min(1.35, Math.max(-0.35, this.orbit.pitch + dy * 0.003));
    });
    addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.orbit.dist = Math.min(45, Math.max(1.6, this.orbit.dist * Math.pow(1.0015, e.deltaY)));
    }, { passive: true });
    // losing the pointer (Esc) ends photo mode; the pause menu then opens as usual
    document.addEventListener('pointerlockchange', () => { if (this.active && !document.pointerLockElement && this.wasLocked) this.exit(true); });
  }

  focus(out) {
    const p = this.player.pos;
    return out.set(p.x, p.y + 1.1 + this.orbit.lift, p.z);
  }

  enter() {
    this.active = true;
    this.wasLocked = !!document.pointerLockElement;
    // start from where the game camera is
    const f = this.focus(_focus), c = this.camera.position;
    _off.copy(c).sub(f);
    this.orbit.dist = Math.min(45, Math.max(2.5, _off.length()));
    this.orbit.yaw = Math.atan2(_off.x, _off.z);
    this.orbit.pitch = Math.asin(Math.min(1, Math.max(-1, _off.y / this.orbit.dist)));
    this.orbit.lift = 0;
    this.viewBefore = this.player.view;
    this.player.view = 'third';
    this.hudHidden = this.hud.el.hidden;
    this.hud.el.hidden = true;
    document.body.classList.add('photo-mode');
    this.el.hidden = false;
    this.el.classList.remove('pm-hidden');
    this.last = performance.now();
    this.prevHook = this.scene.onBeforeRender;
    this.scene.onBeforeRender = (renderer, scene, camera) => { this.prevHook?.(renderer, scene, camera); if (camera === this.camera) this.place(); };
  }

  exit(silent = false) {
    if (!this.active) return;
    this.active = false;
    this.scene.onBeforeRender = this.prevHook || (() => {});
    this.player.view = this.viewBefore || this.player.view;
    this.hud.el.hidden = this.hudHidden;
    document.body.classList.remove('photo-mode');
    this.el.hidden = true;
    this.keys.clear();
    if (!silent) this.onExit?.();
  }

  // the camera for this frame: orbit around the skier, kept above the snow
  place() {
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.keys.has('KeyQ')) this.orbit.lift = Math.max(-0.9, this.orbit.lift - dt * 1.5);
    if (this.keys.has('KeyE')) this.orbit.lift = Math.min(6, this.orbit.lift + dt * 1.5);
    const o = this.orbit, f = this.focus(_focus), cam = this.camera;
    cam.position.set(f.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist, f.y + Math.sin(o.pitch) * o.dist, f.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist);
    const g = world.groundHeight(cam.position.x, cam.position.z, cam.position.y + 2) + 0.35;
    if (cam.position.y < g) cam.position.y = g;
    cam.up.set(0, 1, 0);
    cam.lookAt(f);
    cam.updateMatrixWorld();
  }
}
