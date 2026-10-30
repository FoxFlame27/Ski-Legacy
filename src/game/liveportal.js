// LIVE WINDOWS for an interior scene (its own THREE.Scene, shown through post.setView): the window planes show the
// REAL game world, rendered live from where the room stands outdoors, the way the chalets (chaletroom.js), the ski
// shop (interior.js) and the Autohaus (carrentalroom.js) do it. The room's camera is carried into the world through
// `frame` (an Object3D in the outdoor scene whose local frame IS the room's frame), the world is drawn from there
// (the building itself hidden) into a render target, and every window plane samples it by its screen position
// (gl_FragCoord): a hole in the wall onto the world, parallax and all, whatever is in front of it (bars, mullions)
// drawn over it by the room.
//
// Performance guards (as the chalets'): drawn only while a window is in view, every third frame once it has a view,
// at most ~768 px on the long side, the world's shadow map refreshed every few seconds; over ~45 ms again and again
// switches the live view off for the session (a soft day / night sky instead).
//
// Only ONE live window view runs at a time: claimPortal(owner) frees the previous owner's render target (you are
// only ever in one interior); every room's renderPortal claims it before drawing.
import * as THREE from 'three';
import { quality } from '../engine/quality.js';

let owner = null;
/** Live window views allowed by the graphics preset (Super Performance: the soft day / night sky instead). */
export function portalsOn() { return quality.portals !== false; }
/** The interior about to draw its live window view: the one before it (if another) lets go of its render target. */
export function claimPortal(o) {
  if (owner && owner !== o) { try { owner.releasePortal?.(); } catch (e) { console.warn('live window release', e); } }
  owner = o;
}
/** An interior that let go of its view (left): no longer the owner. */
export function dropPortal(o) { if (owner === o) owner = null; }

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = `
  uniform sampler2D tView;
  uniform float uHas;
  uniform float uDay;
  uniform vec4 uVP;
  uniform vec3 uTint;
  varying vec2 vUv;
  void main() {
    vec2 suv = (gl_FragCoord.xy - uVP.xy) / uVP.zw;
    vec3 view = texture2D(tView, suv).rgb;
    vec3 sky = mix(vec3(1.5, 1.6, 1.75), vec3(0.3, 0.5, 0.95), smoothstep(0.3, 1.0, suv.y));
    sky *= mix(vec3(0.03, 0.04, 0.08), vec3(1.0), uDay); // (no world yet / switched off: a soft day / night sky)
    gl_FragColor = vec4(mix(sky, view, uHas) * uTint, 1.0);
  }`;
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _size = new THREE.Vector2(), _box = new THREE.Box3(), _frustum = new THREE.Frustum();

export class LivePortal {
  constructor({ name = 'Interior', tint = 0xf2f5f7 } = {}) {
    this.name = name;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tView: { value: null }, uHas: { value: 0 }, uDay: { value: 1 }, uVP: { value: new THREE.Vector4(0, 0, 1, 1) }, uTint: { value: new THREE.Color(tint) } },
      vertexShader: VERT, fragmentShader: FRAG,
    });
    this.meshes = [];
    this.vp = (r) => r.getCurrentViewport(this.material.uniforms.uVP.value);
    this.cam = new THREE.PerspectiveCamera(70, 1, 0.1, 30000);
    this.rt = null; this.world = null; this.tick = 0; this.slow = 0; this.off = false; this.lastShadow = 0; this.lastFrame = null;
  }
  /** A window plane (its material becomes the live view). */
  add(mesh) { mesh.material = this.material; mesh.onBeforeRender = this.vp; this.meshes.push(mesh); return mesh; }
  /** { scene, hide: () => Object3D[] (the building seen from outside, you) }; the frame is passed to render(). */
  setWorld(o) { this.world = o && o.scene ? o : null; }
  /** The soft sky's brightness when there is no live view (0 night .. 1 day). */
  setDay(d) { this.material.uniforms.uDay.value = d; }
  releasePortal() {
    if (this.rt) { this.rt.dispose(); this.rt = null; }
    this.material.uniforms.tView.value = null;
    this.material.uniforms.uHas.value = 0;
    this.lastFrame = null;
    dropPortal(this);
  }
  /** Draw the world from where `camera` would be with the room standing at `frame` (only while a window is in view). */
  render(r, camera, frame) {
    const o = this.world, U = this.material.uniforms;
    if (this.off || !o || !frame || !r?.render) return;
    if (!portalsOn()) { if (this.rt) this.releasePortal(); return; }
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if (!this.meshes.some((m) => m.visible && _frustum.intersectsBox(_box.setFromObject(m)))) return; // (no window in view)
    this.tick++;
    if (U.uHas.value && frame === this.lastFrame && this.tick % 3) return; // (every third frame: a view out of a window needs no more)
    this.lastFrame = frame;
    claimPortal(this);
    const size = r.getDrawingBufferSize(_size);
    const k = Math.min(0.4, 768 / Math.max(1, size.x, size.y));
    const w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
      U.tView.value = this.rt.texture;
      this.lastShadow = performance.now(); // (the world's shadow map is fresh from the last frame outside)
    } else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const pc = this.cam;
    frame.updateMatrixWorld();
    _m.multiplyMatrices(frame.matrixWorld, camera.matrixWorld).decompose(pc.position, pc.quaternion, _s);
    pc.fov = camera.fov; pc.aspect = camera.aspect; pc.near = 0.1; pc.far = 30000;
    pc.updateProjectionMatrix();
    const hidden = (o.hide?.() || []).filter(Boolean), was = hidden.map((x) => x.visible);
    for (const x of hidden) x.visible = false;
    const prev = r.getRenderTarget(), auto = r.shadowMap.autoUpdate, now = performance.now();
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = now - this.lastShadow > 6000; // (the world's shadows: refreshed every few seconds)
    if (r.shadowMap.needsUpdate) this.lastShadow = now;
    try {
      const t0 = performance.now();
      r.setRenderTarget(this.rt);
      r.clear();
      r.render(o.scene, pc);
      U.uHas.value = 1;
      // a slow machine: the view out costing over ~45 ms again and again switches it off (the soft sky instead)
      const ms = performance.now() - t0;
      this.slow = ms > 45 ? this.slow + 1 : Math.max(0, this.slow - 1);
      if (this.slow > 6) { this.off = true; console.warn(`${this.name} windows: live view off (slow)`); }
    } catch (e) {
      console.warn(`${this.name} window view failed`, e);
      this.world = null;
      U.uHas.value = 0;
    } finally {
      r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = auto;
      r.shadowMap.needsUpdate = false;
      hidden.forEach((x, i) => { x.visible = was[i]; });
    }
    if (this.off) this.releasePortal();
  }
}
