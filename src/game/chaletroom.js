// Inside a chalet of the chalet village: ITS OWN SCENE, like the ski shop and the car rental (main.js renders
// it through post.setView while you are in; game/chalets.js fades you in at a chalet's front door and out again).
// Every chalet is the same house (game/chaletplan.js: the plan), so ONE interior serves them all; going in carries the
// view to that chalet: its windows show the real world from where it stands (a live portal render of the game's
// scene, as the ski shop's windows). Inside you walk in first person (WASD + mouse), the stair between the floors.
// Every inner doorway has a hinged door: E (or walking into it) opens / closes it, its leaf solid wherever it stands;
// E at the front door takes you back out. The fixed fittings: the two bathrooms' sanitary ware (Meshy,
// public/models/bathroom/) and the built-in lamps (Meshy, public/models/lamps/: an alpine pendant in every room, wall
// sconces), warm 2700 K pools of light (a pool of point lights IN THIS SCENE follows you to the nearest lamps, shared
// with the lamps you buy: setFurnitureLamps), cool daylight through the windows by day. Nothing of it is in the
// outdoor world: no lights, no meshes, no per-frame work while you are outside.
//
// ---------------------------------------------------------------------------------------------------------------
// INTERIOR API (for the build mode, src/game/build/*: chaletadapter.js finds `chaletInteriorAPI` here)
//   chaletInteriorAPI is a live object (getters onto the one interior):
//     active / isActive()  true while you are inside YOUR chalet (inside any chalet: `inside`)
//     chalet               the chalet you are in: { id, name, plot } (null outside)
//     scene                the interior's own scene (rendered instead of the world while you are inside)
//     house                the Group of the house in that scene (at its origin: its local frame = the house frame)
//     root                 the Group furniture goes in, a child of `house` with no transform of its own: its local
//                          coordinates ARE the house frame (positions, collider boxes, save.chalet.furniture)
//     camera               the first-person camera inside (a child of `house`: its position is in the house frame;
//                          getWorldPosition / getWorldDirection give the same, the house stands at the origin)
//     player               { pos (feet, house frame), yaw, pitch, level, eye }
//     storeys              [{ level: 'ground'|'up', floorY, ceilingY, rects: [{ x0, z0, x1, z1, room }] }]
//                          (rects: the walkable floor of each room; ceilingY: the lowest full-height ceiling; the
//                          real one upstairs slopes: ceilingAt(x, z, level))
//     walls                [{ ax, az, bx, bz, t, y0, y1, storey (0|1), exterior }] solid wall segments (door gaps
//                          left out; exterior walls: the line is their inner face, t their thickness outward)
//     sills                [{ x, z, y, len, depth, yaw, storey }] window ledges (yaw: the way into the room)
//     ceilingAt(x, z, level)
//     addObject(obj, col) -> handle   obj (already positioned in root space) is added to root; col (optional) =
//                          { x, z, hw, hd, rot, y0, y1 } an oriented box (rot = the object's yaw) or { x, z, r }:
//                          you walk against it on the storey its y0 falls on. Its materials get the interior's
//                          lighting (the daylight fill through the windows, the room's warm lamps).
//     removeObject(handle)
//     onFrame(cb) -> unsubscribe   cb(dt, input) every frame while inside (after walking and the camera, before the
//                          windows' portal render)
//   House frame: metres, +x the front (the entrance), z along the house, y up from the ground outside (the ground
//   floor at y G = 0.3, the upper floor at FL = 3.15: chaletplan.js). save.chalet.furniture = [{ id, x, y, z, rot }]
//   is in this frame; the build mode writes and loads it (this module does not touch it).
// ---------------------------------------------------------------------------------------------------------------
import * as THREE from 'three';
import { roomEnvironment } from '../engine/roomenv.js';
import { loadGLB } from '../core/assets.js';
import {
  HX, IX, IZ, T, G, GC, FL, COLLAR, DORMER, IT, STAIR, HOLE, DOOR, ROOMS, EXTERIOR, INTERIOR, RAILS,
  ceilingUp, ceilingAt, stairY, exteriorLine,
} from './chaletplan.js';
import { claimPortal, dropPortal, portalsOn } from './liveportal.js';

const EYE = 1.62, R0 = 0.28, WALL_OUT = T - 0.1; // (the exterior walls' outward depth: 10 cm inside the model's skin)
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _size = new THREE.Vector2(), _box = new THREE.Box3(), _frustum = new THREE.Frustum();
// the windows: a live view of the world (rendered from where you'd stand in the chalet out there), sampled in screen space
const PORTAL_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LIVE_PORTAL = true; // the windows' live view of the world (see renderPortal; the freeze it was blamed for was build mode's lamp raycast)
const PORTAL_FRAG = `
  uniform sampler2D tView;
  uniform float uHas;
  uniform float uDay;
  uniform vec4 uVP;
  varying vec2 vUv;
  void main() {
    vec2 suv = (gl_FragCoord.xy - uVP.xy) / uVP.zw;
    vec3 view = texture2D(tView, suv).rgb;
    vec3 sky = mix(vec3(1.5, 1.6, 1.75), vec3(0.3, 0.5, 0.95), smoothstep(0.3, 1.0, vUv.y));
    sky *= mix(vec3(0.03, 0.04, 0.08), vec3(1.0), uDay); // (night: a dark blue view out)
    gl_FragColor = vec4(mix(sky, view, uHas) * vec3(0.95, 0.97, 0.98), 1.0);
  }`;
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------ the interior's light (shared by its materials)
// The interior's materials get their own fill (uIntAmb: cool daylight by day, a dim warm glow at night, never pitch
// dark) and a damped environment; the room's lamps (the pool of point lights in this scene) light them warmly.
export const interiorLight = {
  amb: { value: new THREE.Color(0.5, 0.5, 0.5) }, // the fill (irradiance)
  hemi: { value: 0.08 },                          // how much of the world's sky light still gets in
  sun: { value: 0 },                              // the sun (through the walls: none)
  env: { value: 0.22 },                           // the sky's reflections
};
const LIT_BEGIN = THREE.ShaderChunk.lights_fragment_begin
  .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= uIntSun;')
  .replace('vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );', 'vec3 irradiance = uIntAmb + getAmbientLightIrradiance( ambientLightColor ) * uIntHemi;')
  .replace('irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * uIntHemi;');
const LIT_MAPS_END = `
#if defined( RE_IndirectDiffuse )
  iblIrradiance *= uIntEnv;
#endif
#if defined( RE_IndirectSpecular )
  radiance *= uIntEnv;
#endif`;
/** Give a material the interior's lighting (once; idempotent). */
export function interiorLit(mat) {
  if (!mat || mat.userData.chaletLit || !(mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial)) return mat;
  mat.userData.chaletLit = true;
  const prev = mat.onBeforeCompile, key = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (sh, r) {
    prev?.call(this, sh, r);
    sh.uniforms.uIntAmb = interiorLight.amb; sh.uniforms.uIntHemi = interiorLight.hemi; sh.uniforms.uIntSun = interiorLight.sun; sh.uniforms.uIntEnv = interiorLight.env;
    sh.fragmentShader = 'uniform vec3 uIntAmb;\nuniform float uIntHemi;\nuniform float uIntSun;\nuniform float uIntEnv;\n' + sh.fragmentShader
      .replace('#include <lights_fragment_begin>', LIT_BEGIN)
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>' + LIT_MAPS_END);
  };
  mat.customProgramCacheKey = function () { return (key ? key.call(this) : '') + '|chaletLit'; };
  mat.needsUpdate = true;
  return mat;
}
const litTree = (obj) => obj?.traverse?.((o) => { if (o.isMesh) for (const m of [].concat(o.material)) interiorLit(m); });

// ------------------------------------------------------------------ textures (canvas, metres: 1 uv = 1 m)
function tex(w, h, draw, rep = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep);
  return t;
}
// cream lime plaster (warm, slightly uneven)
const plasterTex = () => tex(256, 256, (g, w, h) => {
  const r = rng(5); g.fillStyle = '#efe4cf'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) { const v = 222 + r() * 24; g.fillStyle = `rgba(${v},${v - 8},${v - 24},0.35)`; g.fillRect(r() * w, r() * h, 2 + r() * 3, 2 + r() * 3); }
}, 0.5);
// boards: `n` per metre-ish, horizontal (walls) or along (floors); 2 m per texture
const boardsTex = (base, n, seed, vertical = false) => tex(512, 512, (g, w, h) => {
  const r = rng(seed), bw = h / n;
  for (let i = 0; i < n; i++) {
    const k = (r() - 0.5) * 26, [R, Gc, B] = base;
    g.fillStyle = `rgb(${R + k},${Gc + k * 0.8},${B + k * 0.6})`;
    if (vertical) g.fillRect(i * bw, 0, bw, h); else g.fillRect(0, i * bw, w, bw);
    for (let j = 0; j < 40; j++) { // grain
      g.strokeStyle = `rgba(${R - 40},${Gc - 40},${B - 30},${0.06 + r() * 0.08})`; g.lineWidth = 1;
      const o = i * bw + r() * bw; g.beginPath();
      if (vertical) { g.moveTo(o, 0); g.bezierCurveTo(o + (r() - 0.5) * 8, h / 3, o + (r() - 0.5) * 8, (2 * h) / 3, o, h); } else { g.moveTo(0, o); g.bezierCurveTo(w / 3, o + (r() - 0.5) * 8, (2 * w) / 3, o + (r() - 0.5) * 8, w, o); }
      g.stroke();
    }
    if (r() < 0.5) { g.fillStyle = `rgba(${R - 60},${Gc - 60},${B - 50},0.5)`; const kx = r() * w, ky = i * bw + bw * (0.3 + r() * 0.4); g.beginPath(); if (vertical) g.ellipse(ky, kx, 3, 5, 0, 0, 7); else g.ellipse(kx, ky, 5, 3, 0, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(40,24,12,0.55)'; if (vertical) g.fillRect(i * bw, 0, 2, h); else g.fillRect(0, i * bw, w, 2);
    if (!vertical) { const x = r() * w; g.fillRect(x, i * bw, 2, bw); } // (a butt joint)
  }
}, 0.5);
const tileTex = (col, grout, n) => tex(256, 256, (g, w, h) => {
  const r = rng(9), s = w / n; g.fillStyle = grout; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const k = (r() - 0.5) * 8; const c = new THREE.Color(col).offsetHSL(0, 0, k / 255); g.fillStyle = `#${c.getHexString()}`; g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4); }
}, 1);

// ------------------------------------------------------------------ a hinged door (front door and every doorway)
// hinge (house frame, on the floor), the closed leaf along +u (unit, the wall's direction), n: the wall's normal (+1
// side), w x h; angle: 0 shut, +-1.55 open to the +n / -n side. The leaf's walking segment follows it.
class Door {
  constructor(room, { hinge, u, n, w, h, y0, level, front = false, mat }) {
    Object.assign(this, { hinge, u, n, w, h, y0, level, front });
    this.angle = 0; this.target = 0;
    this.pivot = new THREE.Group();
    this.pivot.position.set(hinge[0], y0, hinge[1]);
    this.base = Math.atan2(-u[1], u[0]); // (rotation.y that turns local +x onto u)
    this.pivot.rotation.y = this.base;
    const t = front ? 0.07 : 0.045;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w - 0.02, h - 0.01, t), mat);
    leaf.position.set(w / 2, h / 2, 0);
    leaf.userData.door = this;
    this.pivot.add(leaf);
    // a lever handle each side, 1.0 m up, near the free edge
    const hm = room.M.iron;
    for (const s of [1, -1]) { const k = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.025, 0.025), hm); k.position.set(w - 0.16, 1.0, s * (t / 2 + 0.04)); this.pivot.add(k); const r = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.05), hm); r.position.set(w - 0.1, 1.0, s * (t / 2 + 0.02)); this.pivot.add(r); }
    if (front) { // the front door: raised panels and a small window
      for (const [py, ph] of [[0.55, 0.8], [1.45, 0.55]]) for (const s of [1, -1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, ph, 0.02), room.M.beam); p.position.set(w / 2, py, s * (t / 2 + 0.008)); this.pivot.add(p); }
    }
    this.leaf = leaf;
    this.seg = [0, 0, 0, 0, 0.035];
    room.solid[level].push(this.seg);
    room.house.add(this.pivot);
    this.update(0);
  }
  /** the leaf's free edge (house frame) */
  tip(out = [0, 0]) {
    const a = this.angle * Math.sign(this.dir || 1), c = Math.cos(a), s = Math.sin(a);
    out[0] = this.hinge[0] + (this.u[0] * c + this.n[0] * s) * this.w; out[1] = this.hinge[1] + (this.u[1] * c + this.n[1] * s) * this.w;
    return out;
  }
  get open() { return Math.abs(this.angle) > 0.6; }
  /** open away from (px, pz) / close */
  toggle(px, pz) {
    if (Math.abs(this.target) > 0.01) { this.target = 0; return false; }
    const side = (px - this.hinge[0]) * this.n[0] + (pz - this.hinge[1]) * this.n[1];
    this.target = side > 0 ? -1.55 : 1.55; // (away from you)
    if (this.front) this.target = this.inward; // (the front door: always into the hall)
    return true;
  }
  update(dt) {
    const d = this.target - this.angle, step = 2.6 * dt;
    this.angle += Math.abs(d) < step ? d : Math.sign(d) * step;
    // three.js rotation.y = +a turns local +x toward -z: our angle a turns u toward n when n = (u rotated by -90 deg)
    const nz = [-this.u[1], this.u[0]]; // (u rotated +90 deg in the x-z plane, three's sense: x' = z, z' = -x is -90)
    const k = (nz[0] * this.n[0] + nz[1] * this.n[1]) > 0 ? 1 : -1; // (does +a swing toward +n?)
    this.pivot.rotation.y = this.base + this.angle * -k;
    const a = this.angle, c = Math.cos(a), s = Math.sin(a);
    this.seg[0] = this.hinge[0]; this.seg[1] = this.hinge[1];
    this.seg[2] = this.hinge[0] + (this.u[0] * c + this.n[0] * s) * (this.w - 0.04); this.seg[3] = this.hinge[1] + (this.u[1] * c + this.n[1] * s) * (this.w - 0.04);
  }
}

export class ChaletRoom {
  constructor({ renderer }) {
    this.renderer = renderer;
    this.active = false;
    this.scene = new THREE.Scene(); this.scene.name = 'chalet-interior-scene';
    this.scene.background = new THREE.Color(0xcfdceb);
    try { // (a soft room environment for the reflections; damped by uIntEnv)
      this.scene.environment = roomEnvironment(renderer, 0.04); // (made once per blur, shared: engine/roomenv.js)
    } catch (e) { /* (no WebGL: headless checks) */ }
    this.house = new THREE.Group(); this.house.name = 'chalet-interior';
    this.scene.add(this.house);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 30000);
    this.house.add(this.camera);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.level = 'ground'; this.yaw = -Math.PI / 2; this.pitch = -0.05; this.eyeY = G + EYE;
    this.solid = { ground: [], up: [] };   // wall segments [ax, az, bx, bz, halfThickness]
    this.round = { ground: [], up: [] };   // fixtures { x, z, r }
    this.boxes = { ground: [], up: [] };   // fixtures: oriented boxes { x, z, hw, hd, rot }
    this.placed = new Set();               // build mode objects { obj, col, level }
    this.hooks = new Set();
    this.doors = [];
    this.lamps = [];                       // { x, y, z, level, power } the built-in lamps (the light pool's sources)
    this.wallList = [];                    // the API's walls
    this.sillList = [];                    // the API's sills
    this.root = new THREE.Group(); this.root.name = 'chalet-furniture';
    this.loads = [];                       // the Meshy fittings loading (warm() waits for them, then compiles)
    this.mats();
    this.buildPortal();
    this.buildFloors();
    this.buildWalls();
    this.buildStair();
    this.buildBathrooms();
    this.buildLamps();
    this.house.add(this.root);
    this.house.traverse((o) => { if (o.isMesh) { o.receiveShadow = false; o.castShadow = false; } });
    this.portalMeshes = [];
    this.house.traverse((o) => { if (o.isMesh && o.material === this.portalMat) { this.portalMeshes.push(o); o.onBeforeRender = this.vp; } });
    // the light pool: a fixed number of warm point lights in this scene (a light count that never changes: no shader
    // recompiles); each frame they go to the lamps nearest you (the built-in ones and the ones you bought)
    this.pool = [];
    const rig = new THREE.Group(); rig.name = 'chalet-lamp-pool';
    for (let i = 0; i < 6; i++) { const L = new THREE.PointLight(0xffb46b, 0, 7.5, 1.7); L.castShadow = false; rig.add(L); this.pool.push(L); }
    this.house.add(rig);
  }

  // ------------------------------------------------------------------ the view out (live portal, as the ski shop)
  buildPortal() {
    this.portalMat = new THREE.ShaderMaterial({
      uniforms: { tView: { value: null }, uHas: { value: 0 }, uDay: { value: 1 }, uVP: { value: new THREE.Vector4(0, 0, 1, 1) } },
      vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG,
    });
    this.vp = (r) => r.getCurrentViewport(this.portalMat.uniforms.uVP.value);
    this.portalCam = new THREE.PerspectiveCamera(70, 1, 0.1, 30000);
    this.lastShadow = 0;
  }
  /** Where the chalet you are in stands: { scene (the world), frame: Object3D (the house frame), hide: () => Object3D[] }. */
  setWorld(o) { this.world = o && o.scene && o.frame ? o : null; this.frame = this.world?.frame || null; }
  /** Get the room ready to show without a hitch (called while you walk up to a door, awaited during the fade in):
   *  the Meshy fittings loaded, then every material's shader compiled in the background (compileAsync: the
   *  driver's parallel compile; no shader compiles on the first frame inside). Resolves within ~4 s whatever. */
  warm(target = null) {
    if (this.warmed) return this.warmed;
    const r = this.renderer;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    this.warmed = (async () => {
      await Promise.race([Promise.allSettled(this.loads), wait(2500)]);
      if (!r?.compileAsync) return;
      // (compiled for the target the frame is drawn into, post's HDR buffer: a program depends on it)
      const prev = r.getRenderTarget(), tgt = typeof target === 'function' ? target() : target;
      let job = null;
      try { if (tgt) r.setRenderTarget(tgt); job = r.compileAsync(this.scene, this.camera); } catch (e) { console.warn('chalet warm-up', e); } finally { r.setRenderTarget(prev); }
      try { if (job) await Promise.race([job, wait(4000)]); } catch (e) { console.warn('chalet warm-up', e); }
    })();
    return this.warmed;
  }
  releasePortal() {
    if (this.portalRT) { this.portalRT.dispose(); this.portalRT = null; }
    this.portalMat.uniforms.tView.value = null;
    this.portalMat.uniforms.uHas.value = 0;
    dropPortal(this);
  }
  renderPortal() {
    // (off: drawing the whole world a second time through the windows froze the game on going in, on the user's Mac;
    // the windows show a soft day / night view instead. Oct 29, "the chalets broke again ... it froze as soon as i got in")
    if (!LIVE_PORTAL || this.portalOff || !portalsOn()) return; // (portalOff: switched off for this session after slow frames; Super Performance: never)
    const o = this.world, r = this.renderer;
    if (!o || !r?.render) return;
    const cam = this.camera;
    cam.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    if (!this.portalMeshes.some((m) => _frustum.intersectsBox(_box.setFromObject(m)))) return; // (no window in view)
    // (every other frame: the world drawn a second time is the biggest cost in here)
    this.portalTick = (this.portalTick || 0) + 1;
    if (this.portalMat.uniforms.uHas.value && this.portalTick % 3) return; // (every third frame: a view out of a window needs no more)
    claimPortal(this); // (one live window view at a time: game/liveportal.js)
    const size = r.getDrawingBufferSize(_size);
    // half resolution, at most 1024 px on the long side (a blurred view out of a window needs no more)
    const k = Math.min(0.4, 768 / Math.max(1, size.x, size.y));
    const w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
    if (!this.portalRT) {
      this.portalRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
      this.portalMat.uniforms.tView.value = this.portalRT.texture;
      this.lastShadow = performance.now(); // (the world's shadow map is fresh from the last frame outside)
    } else if (this.portalRT.width !== w || this.portalRT.height !== h) this.portalRT.setSize(w, h);
    const pc = this.portalCam;
    o.frame.updateMatrixWorld();
    _m.multiplyMatrices(o.frame.matrixWorld, cam.matrixWorld).decompose(pc.position, pc.quaternion, _s);
    pc.fov = cam.fov; pc.aspect = cam.aspect; pc.near = 0.1; pc.far = 30000;
    pc.updateProjectionMatrix();
    const hidden = (o.hide?.() || []).filter(Boolean), was = hidden.map((x) => x.visible);
    for (const x of hidden) x.visible = false;
    const prev = r.getRenderTarget(), auto = r.shadowMap.autoUpdate, now = performance.now();
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = now - this.lastShadow > 6000; // (the world's shadows: refreshed every few seconds)
    if (r.shadowMap.needsUpdate) this.lastShadow = now;
    try {
      const t0 = performance.now();
      r.setRenderTarget(this.portalRT);
      r.clear();
      r.render(o.scene, pc);
      this.portalMat.uniforms.uHas.value = 1;
      // a guard for a slow machine: the view out costing over ~45 ms again and again switches it off (the soft
      // day / night view instead), so the room itself always stays smooth
      const ms = performance.now() - t0;
      this.portalSlow = ms > 45 ? (this.portalSlow || 0) + 1 : Math.max(0, (this.portalSlow || 0) - 1);
      if (this.portalSlow > 6) { this.portalOff = true; this.portalMat.uniforms.uHas.value = 0; console.warn('chalet windows: live view off (slow)'); }
    } catch (e) {
      console.warn('Chalet window view failed', e);
      this.world = null;
      this.portalMat.uniforms.uHas.value = 0;
    } finally {
      r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = auto;
      r.shadowMap.needsUpdate = false;
      hidden.forEach((x, i) => { x.visible = was[i]; });
    }
  }

  mats() {
    const M = (o) => interiorLit(new THREE.MeshStandardMaterial(o));
    this.M = {
      plaster: M({ map: plasterTex(), roughness: 0.94 }),
      timber: M({ map: boardsTex([150, 92, 50], 8, 3), roughness: 0.8 }),           // rich warm larch
      ceiling: M({ map: boardsTex([160, 102, 58], 10, 7, true), roughness: 0.82, side: THREE.DoubleSide }),
      floor: M({ map: boardsTex([132, 82, 46], 7, 11, true), roughness: 0.62 }),     // oiled oak planks
      tile: M({ map: tileTex('#e9e6df', '#b9b4aa', 4), roughness: 0.3 }),
      floorTile: M({ map: tileTex('#8b857c', '#5e5a54', 3), roughness: 0.45 }),
      beam: M({ color: 0x5e381c, roughness: 0.8 }),
      frame: M({ color: 0xf2ece0, roughness: 0.5 }),        // window frames (white painted)
      door: M({ map: boardsTex([128, 78, 40], 6, 21, true), roughness: 0.7 }),
      ceramic: M({ color: 0xfbfbfb, roughness: 0.15 }),
      chrome: M({ color: 0xd8dde2, metalness: 1, roughness: 0.15 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xe6f1f6, roughness: 0.04, transparent: true, opacity: 0.12, depthWrite: false }),
      lamp: M({ color: 0xfff1d6, emissive: 0xffb76b, emissiveIntensity: 2.2 }),
      iron: M({ color: 0x2a2624, roughness: 0.5, metalness: 0.6 }),
    };
  }

  // ------------------------------------------------------------------ geometry helpers (all into the house group)
  box(w, h, d, mat, x, y, z, ry = 0, parent = this.house) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); return m;
  }
  plane(x0, z0, x1, z1, y, mat, down = false) {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    const uv = g.attributes.uv, p = g.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) + (x0 + x1) / 2), (p.getY(i) + (z0 + z1) / 2));
    const m = new THREE.Mesh(g, mat);
    m.rotation.x = down ? Math.PI / 2 : -Math.PI / 2; m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    this.house.add(m); return m;
  }
  /**
   * A wall slab along a -> b (plan points), from off0 to off1 along n = the left of a -> b, between y0 and the top
   * profile top(x, z); openings [{ u0, u1, y0, y1 }] (u along the wall from a): doors (y0 at the floor) notch the
   * outline, windows are holes.
   */
  slab(a, b, off0, off1, y0, top, openings, mat) {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const sh = new THREE.Shape(), notch = openings.filter((o) => o.y0 <= y0 + 0.02).sort((p, q) => p.u0 - q.u0);
    sh.moveTo(0, y0);
    for (const o of notch) { sh.lineTo(o.u0, y0); sh.lineTo(o.u0, o.y1); sh.lineTo(o.u1, o.y1); sh.lineTo(o.u1, y0); }
    sh.lineTo(L, y0);
    const pts = [];
    for (let i = Math.ceil(L / 0.02); i >= 0; i--) { const u = Math.min(L, i * 0.02); pts.push([u, top(a[0] + ux * u, a[1] + uz * u)]); }
    const keep = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = keep[keep.length - 1], q = pts[i], r = pts[i + 1];
      if (Math.abs((q[1] - p[1]) * (r[0] - q[0]) - (r[1] - q[1]) * (q[0] - p[0])) > 1e-6) keep.push(q);
    }
    keep.push(pts[pts.length - 1]);
    for (const [u, y] of keep) sh.lineTo(u, y);
    for (const o of openings) if (o.y0 > y0 + 0.02) { const h = new THREE.Path(); h.moveTo(o.u0, o.y0); h.lineTo(o.u0, o.y1); h.lineTo(o.u1, o.y1); h.lineTo(o.u1, o.y0); h.lineTo(o.u0, o.y0); sh.holes.push(h); }
    const geo = new THREE.ExtrudeGeometry(sh, { depth: off1 - off0, bevelEnabled: false, curveSegments: 1 });
    geo.translate(0, 0, off0);
    const nx = -uz, nz = ux;
    geo.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, 0, nz)).setPosition(a[0], 0, a[1]));
    const m = new THREE.Mesh(geo, mat); this.house.add(m); return m;
  }
  roomAt(x, z, level) {
    for (const r of ROOMS) if (r.level === level) for (const q of r.rects) if (x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) return r;
    return null;
  }
  addSolid(level, a, b, half, gaps, exterior, y0, y1) {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    let u = 0;
    const cuts = [...gaps].sort((p, q) => p[0] - q[0]);
    cuts.push([L, L]);
    for (const [g0, g1] of cuts) {
      if (g0 > u + 0.01) {
        const s = [a[0] + (dx * u) / L, a[1] + (dz * u) / L, a[0] + (dx * g0) / L, a[1] + (dz * g0) / L, half];
        this.solid[level].push(s);
        this.wallList.push({ ax: s[0], az: s[1], bx: s[2], bz: s[3], t: exterior ? T : 2 * half, y0, y1, storey: level === 'up' ? 1 : 0, exterior });
      }
      u = Math.max(u, g1);
    }
  }

  // ------------------------------------------------------------------ floors and ceilings
  buildFloors() {
    const M = this.M, H = HOLE;
    this.plane(-IX, -IZ, IX, IZ, G, M.floor);
    for (const r of ROOMS) if (r.bath) for (const q of r.rects) this.plane(q.x0, q.z0, q.x1, q.z1, (r.level === 'up' ? FL : G) + 0.006, M.floorTile);
    const around = [[-IX, -IZ, IX, H.z0], [-IX, H.z1, IX, IZ], [-IX, H.z0, H.x0, H.z1], [H.x1, H.z0, IX, H.z1]];
    for (const [x0, z0, x1, z1] of around) { this.plane(x0, z0, x1, z1, FL, M.floor); this.plane(x0, z0, x1, z1, GC, M.ceiling, true); }
    // the stairwell's fascia: a timber header beam round the whole opening, straddling its edge (the floor's edge,
    // the walls under / over it: 2 cm proud of each face), its bottom 15-16 cm under the ceiling, its top just under
    // the floor: no slit anywhere between the floor, the walls and the opening (the x0 side had none: you saw the
    // upstairs bathroom through the gap over the old closet). The long beams run past the short ones' ends; no two
    // faces in one plane.
    const fx = (z, z0, z1) => this.box(H.x1 - H.x0 + 0.13, FL - GC + 0.144, z1 - z0, M.beam, (H.x0 + H.x1) / 2 - 0.005, (GC - 0.15 + FL - 0.006) / 2, (z0 + z1) / 2);
    fx(H.z0, H.z0 - 0.07, H.z0 + 0.07); fx(H.z1, H.z1 - 0.08, H.z1 + 0.08);
    const fz = (x0, x1) => this.box(x1 - x0, FL - GC + 0.156, H.z1 - H.z0 + 0.17, M.beam, (x0 + x1) / 2, (GC - 0.16 + FL - 0.004) / 2, (H.z0 + H.z1) / 2 + 0.005);
    fz(H.x0 - 0.08, H.x0 + 0.08); fz(H.x1 - 0.08, H.x1 + 0.08);
    for (let z = -IZ + 0.9; z < IZ - 0.5; z += 1.5) {
      if (z > H.z0 - 0.2 && z < H.z1 + 0.2) { this.box(IX - H.x1, 0.18, 0.16, M.beam, (H.x1 + IX) / 2, GC - 0.09, z); this.box(H.x0 + IX, 0.18, 0.16, M.beam, (H.x0 - IX) / 2, GC - 0.09, z); } else this.box(2 * IX, 0.18, 0.16, M.beam, 0, GC - 0.09, z);
    }
    const band = (z0, z1) => {
      const zm = (z0 + z1) / 2, prof = [];
      for (let x = -IX; x <= IX + 1e-6; x += 0.02) prof.push([x, ceilingUp(x, zm)]);
      const keep = [prof[0]];
      for (let i = 1; i < prof.length - 1; i++) { const p = keep[keep.length - 1], q = prof[i], r = prof[i + 1]; if (Math.abs((q[1] - p[1]) * (r[0] - q[0]) - (r[1] - q[1]) * (q[0] - p[0])) > 1e-6) keep.push(q); }
      keep.push(prof[prof.length - 1]);
      const pos = [], uv = [];
      let s = 0;
      for (let i = 0; i < keep.length - 1; i++) {
        const [xa, ya] = keep[i], [xb, yb] = keep[i + 1], l = Math.hypot(xb - xa, yb - ya);
        pos.push(xa, ya, z0, xb, yb, z0, xb, yb, z1, xa, ya, z0, xb, yb, z1, xa, ya, z1);
        uv.push(s, z0, s + l, z0, s + l, z1, s, z0, s + l, z1, s, z1);
        s += l;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
      this.house.add(new THREE.Mesh(g, M.ceiling));
    };
    band(-IZ, DORMER.z0); band(DORMER.z0, DORMER.z1); band(DORMER.z1, IZ);
    const xc = IX - (COLLAR - 1.8) / 0.7; // (where the slope meets the collar: KNEE 1.8, PITCH 0.7)
    for (let z = -IZ + 0.5; z < IZ - 0.3; z += 1.1) {
      if (z > DORMER.z0 - 0.1 && z < DORMER.z1 + 0.1) continue;
      for (const sx of [-1, 1]) {
        const xa = sx * IX, xb = sx * xc, ya = ceilingUp(xa, z), yb = ceilingUp(xb, z), l = Math.hypot(xb - xa, yb - ya);
        const m = this.box(l, 0.14, 0.1, M.beam, (xa + xb) / 2, (ya + yb) / 2 - 0.08, z);
        m.rotation.z = Math.atan2(yb - ya, xb - xa);
      }
      this.box(2 * xc, 0.14, 0.1, M.beam, 0, FL + COLLAR - 0.08, z);
    }
    for (const sx of [-1, 1]) this.box(0.14, 0.16, 2 * IZ, M.beam, sx * xc, FL + COLLAR - 0.09, 0);
  }

  // ------------------------------------------------------------------ walls, windows, doors
  buildWalls() {
    const M = this.M;
    for (const W of EXTERIOR) {
      const L0 = exteriorLine(W.side), up = W.level === 'up';
      const long = L0.axis === 'z', a = long ? [L0.a[0], -IZ - WALL_OUT] : L0.a, b = long ? [L0.b[0], IZ + WALL_OUT] : L0.b;
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, nl = [-uz, ux];
      const outward = nl[0] * L0.n[0] + nl[1] * L0.n[1] > 0;
      const y0 = up ? FL : G;
      const top = up ? (x, z) => ceilingUp(Math.max(-IX, Math.min(IX, x)), Math.max(-IZ + 0.01, Math.min(IZ - 0.01, z))) : () => GC;
      const start = long ? a[1] : a[0];
      const ops = W.openings.map((o) => ({ ...o, u0: o.c - o.w / 2 - start, u1: o.c + o.w / 2 - start }));
      const mat = up ? M.timber : M.plaster;
      this.slab(a, b, outward ? 0 : -WALL_OUT, outward ? WALL_OUT : 0, y0, top, ops, mat);
      // (ground floor: a skirting board along the inner face)
      if (!up) this.box(L, 0.1, 0.02, M.beam, (a[0] + b[0]) / 2 - L0.n[0] * 0.01, G + 0.05, (a[1] + b[1]) / 2 - L0.n[1] * 0.01, Math.atan2(ux, uz) - Math.PI / 2);
      const gaps = [];
      for (const o of ops) {
        const uc = (o.u0 + o.u1) / 2, cx = a[0] + ux * uc, cz = a[1] + uz * uc, ry = Math.atan2(ux, uz) - Math.PI / 2;
        const nx = L0.n[0], nz = L0.n[1], w = o.u1 - o.u0, h = o.y1 - o.y0, ym = (o.y0 + o.y1) / 2;
        const at = (k) => [cx + nx * k, cz + nz * k];
        if (o.kind === 'front') {
          // the front door: a hinged leaf in the opening (swinging into the hall), a timber casing inside
          const [fx, fz] = at(-0.015);
          this.box(0.08, h + 0.08, 0.04, M.beam, fx - ux * (w / 2 + 0.04), ym + 0.04, fz - uz * (w / 2 + 0.04), ry);
          this.box(0.08, h + 0.08, 0.04, M.beam, fx + ux * (w / 2 + 0.04), ym + 0.04, fz + uz * (w / 2 + 0.04), ry);
          this.box(w + 0.16, 0.08, 0.04, M.beam, fx, o.y1 + 0.04, fz, ry);
          // (the reveal: the opening's sides and head through the wall's depth)
          for (const s of [-1, 1]) this.box(0.02, h, WALL_OUT, M.beam, cx + ux * s * (w / 2 - 0.01) + nx * WALL_OUT / 2, ym, cz + uz * s * (w / 2 - 0.01) + nz * WALL_OUT / 2, ry);
          this.box(w, 0.02, WALL_OUT, M.beam, cx + nx * WALL_OUT / 2, o.y1 - 0.01, cz + nz * WALL_OUT / 2, ry);
          const hx = cx - ux * (w / 2) + nx * 0.12, hz = cz - uz * (w / 2) + nz * 0.12;
          const d = new Door(this, { hinge: [hx, hz], u: [ux, uz], n: [-nx, -nz], w, h, y0: o.y0, level: W.level, front: true, mat: M.door });
          d.inward = 1.5; // (toward -n: into the hall)
          this.front = d; this.doors.push(d);
          this.doorAt = { x: cx - nx * 0.6, z: cz - nz * 0.6, nx, nz, z0: cz - w / 2, z1: cz + w / 2 };
          gaps.push([o.u0, o.u1]);
          continue;
        }
        // the frame (white, in the wall's depth), the cross bars, the view out behind them
        const [fx, fz] = at(WALL_OUT * 0.55), fd = 0.08, fw = 0.07;
        this.box(w, fw, fd, M.frame, fx, o.y1 - fw / 2, fz, ry);
        this.box(w, fw, fd, M.frame, fx, o.y0 + fw / 2, fz, ry);
        this.box(fw, h, fd, M.frame, fx - ux * (w / 2 - fw / 2), ym, fz - uz * (w / 2 - fw / 2), ry);
        this.box(fw, h, fd, M.frame, fx + ux * (w / 2 - fw / 2), ym, fz + uz * (w / 2 - fw / 2), ry);
        this.box(0.05, h, fd * 0.8, M.frame, fx, ym, fz, ry);
        this.box(w, 0.04, fd * 0.8, M.frame, fx, o.y0 + h * 0.62, fz, ry);
        const [gx, gz] = at(WALL_OUT * 0.55 + 0.03);
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.02, h - 0.02), this.portalMat); // (the live view out)
        pane.position.set(gx, ym, gz); pane.rotation.y = Math.atan2(-nx, -nz);
        this.house.add(pane);
        // the sill inside (0.9 m over the floor)
        const [sx, sz] = at(-0.06), sd = WALL_OUT * 0.5 + 0.14;
        this.box(w + 0.14, 0.04, sd, up ? M.beam : M.frame, sx + nx * (WALL_OUT * 0.25), o.y0 - 0.02, sz + nz * (WALL_OUT * 0.25), ry);
        this.sillList.push({ x: cx - nx * 0.07, z: cz - nz * 0.07, y: o.y0, len: w + 0.1, depth: sd, yaw: Math.atan2(-nx, -nz), storey: up ? 1 : 0 });
      }
      this.addSolid(W.level, a, b, 0, gaps, true, y0, up ? FL + COLLAR : GC);
    }
    // interior walls: both faces, each its room's finish (tiles in the bathrooms); a hinged door in each doorway
    for (const W of INTERIOR) {
      const up = W.level === 'up', a = W.a, b = W.b, alongX = a[1] === b[1];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, nl = [-uz, ux];
      const y0 = up ? FL : G;
      const top = up ? (x, z) => Math.max(ceilingUp(x, z - 0.07), ceilingUp(x, z + 0.07), ceilingUp(x - 0.07, z), ceilingUp(x + 0.07, z)) : () => GC;
      const start = alongX ? a[0] : a[1];
      const ops = (W.openings || []).map((o) => ({ ...o, u0: o.c - o.w / 2 - start, u1: o.c + o.w / 2 - start }));
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const fin = (s) => { const r = this.roomAt(mx + nl[0] * 0.3 * s, mz + nl[1] * 0.3 * s, W.level); return r?.bath ? this.M.tile : up ? this.M.timber : this.M.plaster; };
      this.slab(a, b, 0, IT / 2, y0, top, ops, fin(1));
      this.slab(a, b, -IT / 2, 0, y0, top, ops, fin(-1));
      for (const o of ops) {
        const h = o.y1 - o.y0, ry = Math.atan2(ux, uz) - Math.PI / 2;
        for (const e of [o.u0, o.u1]) this.box(0.07, h + 0.03, IT + 0.05, M.beam, a[0] + ux * e, o.y0 + h / 2, a[1] + uz * e, ry);
        this.box(o.u1 - o.u0 + 0.14, 0.07, IT + 0.05, M.beam, a[0] + ux * (o.u0 + o.u1) / 2, o.y1 + 0.035, a[1] + uz * (o.u0 + o.u1) / 2, ry);
        const hinge = [a[0] + ux * (o.u0 + 0.035), a[1] + uz * (o.u0 + 0.035)];
        this.doors.push(new Door(this, { hinge, u: [ux, uz], n: nl, w: o.u1 - o.u0 - 0.07, h: h - 0.01, y0: o.y0, level: W.level, mat: M.door }));
      }
      this.addSolid(W.level, a, b, IT / 2, ops.map((o) => [o.u0, o.u1]), false, y0, up ? FL + COLLAR : GC);
    }
    RAILS.forEach((R, i) => {
      const [ax, az] = R.a, [bx, bz] = R.b, L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, ry = Math.atan2(ux, uz) - Math.PI / 2;
      const dy = i * 0.004; // (the two rails cross at the corner: their tops / bottoms never in one plane)
      this.box(L + 0.06, 0.06, 0.08, M.beam, (ax + bx) / 2, FL + 1.0 + dy, (az + bz) / 2, ry);
      // (the bottom rail sits on the floor's edge, over the stairwell's fascia beam: no gap under the balustrade)
      this.box(L, 0.07, 0.06, M.beam, (ax + bx) / 2, FL + 0.033 + dy, (az + bz) / 2, ry);
      for (let u = 0; u <= L + 1e-6; u += 0.13) this.box(0.035, 0.92, 0.035, M.beam, ax + ux * u, FL + 0.51, az + uz * u);
      this.addSolid('up', R.a, R.b, 0.05, [], false, FL, FL + 1.04);
    });
  }

  // ------------------------------------------------------------------ the stair (along z, at the back of the hall)
  buildStair() {
    const S = STAIR, n = S.steps, run = (S.z1 - S.z0) / n, rise = (FL - G) / n;
    // No two faces in one plane anywhere (they z-fought: the plaster body's top was the tread's top, its front the
    // tread's front). Per step: the plaster body (riser) set back 2 cm, its top buried mid-way inside the wooden tread, its
    // sides 5 mm in; the tread 4 cm thick, 1 cm proud each side, its nosing 3 cm over the riser, its back tucked
    // inside the next step's body (the last one's in the stairwell's trim, short of the upper floor). The walk heights (the
    // treads' tops: stairY) are unchanged.
    const bx0 = S.x0 + 0.005, bx1 = S.x1 - 0.005, tx0 = S.x0 - 0.01, tx1 = S.x1 + 0.01;
    for (let k = 0; k < n; k++) {
      const y1 = G + (k + 1) * rise, z0 = S.z0 + k * run, z1 = z0 + run, last = k === n - 1;
      const by0 = G - 0.01, by1 = y1 - 0.02, bz0 = z0 + 0.02, bz1 = last ? S.z1 - 0.01 : z1 + 0.03; // (1 cm into the next body: no slit between them, seen from the open side)
      this.box(bx1 - bx0, by1 - by0, bz1 - bz0, this.M.plaster, (bx0 + bx1) / 2, (by0 + by1) / 2, (bz0 + bz1) / 2);
      const tz0 = z0 - 0.01, tz1 = last ? S.z1 - 0.01 : z1 + 0.03; // (the last: into the stairwell's trim, not under the floor)
      this.box(tx1 - tx0, 0.04, tz1 - tz0, this.M.beam, (tx0 + tx1) / 2, y1 - 0.02, (tz0 + tz1) / 2);
    }
    // The open stair (no closet behind it any more: the living room's nook): a timber stringer along each open side
    // over the steps' plaster bodies, a balustrade on it (newel at the foot, balusters, handrail); on the back (x0)
    // side the balusters run on up to the stairwell's header beam where the handrail meets it (a post up to the
    // beam), the handrail going on along the beam / the upstairs wall on brackets; on the hall side (x1) the
    // balustrade to the hall wall, then a handrail on the wall on brackets, up to the top.
    const M = this.M, yN = (z) => G + rise * (1 + (z - S.z0) / run); // (the pitch line: through the nosings)
    const FB = GC - 0.16;                       // (the header beam's bottom)
    const XO = S.x0 - 0.03, XI = S.x1 + 0.03;   // (the balustrade lines: on the stringers, the treads' ends buried in them)
    const zAt = (y) => S.z0 + run * ((y - G) / rise - 1); // (where the pitch line is at y)
    const along = (x, za, zb, dy, w, h) => { // (a straight member along the pitch, dy over the pitch line)
      const ya = yN(za) + dy, yb = yN(zb) + dy, L = Math.hypot(zb - za, yb - ya);
      const m = this.box(w, h, L, M.beam, x, (ya + yb) / 2, (za + zb) / 2); m.rotation.x = -Math.atan2(yb - ya, zb - za); return m;
    };
    const stringer = (xc) => { // a band 0.30 under to 0.06 over the pitch line, its foot cut level on the floor, its head under the upper floor
      const ft = 0.06, fb = 0.3, zA = S.z0 - 0.02, zD = S.z1 - 0.005;
      const sh = new THREE.Shape();
      sh.moveTo(zA, G - 0.005); sh.lineTo(zA, yN(zA) + ft); sh.lineTo(zAt(FL - 0.006 - ft), FL - 0.006); sh.lineTo(zD, FL - 0.006);
      sh.lineTo(zD, yN(zD) - fb); sh.lineTo(zAt(G - 0.005 + fb), G - 0.005); sh.lineTo(zA, G - 0.005);
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: false, curveSegments: 1 });
      geo.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)).setPosition(xc + 0.025, 0, 0));
      this.house.add(new THREE.Mesh(geo, M.beam));
    };
    stringer(XO); stringer(XI);
    const post = (x, z, y1, w = 0.09) => this.box(w, y1 - (G - 0.005), w, M.beam, x, (y1 + G - 0.005) / 2, z);
    const balusters = (x, za, zb, top) => {
      for (let z = za; z < zb; z += 0.135) {
        const y0 = yN(z) + 0.05, y1 = top(z);
        if (y1 - y0 > 0.05) this.box(0.035, y1 - y0, 0.035, M.beam, x, (y0 + y1) / 2, z);
      }
    };
    const brackets = (x0, x1, za, zb, dy) => {
      for (let z = za + 0.1; z < zb; z += 0.75) this.box(x1 - x0, 0.025, 0.03, M.beam, (x0 + x1) / 2, yN(z) + dy - 0.045, z);
    };
    const zF = S.z0 + 0.05;                      // the newels at the foot
    // the back side (x0): newel, handrail up to the post under the header beam, balusters up to the beam
    const zP = zAt(FB - 0.92);                   // (where the handrail's top meets the beam's bottom)
    post(XO, zF, yN(zF) + 0.98, 0.1);
    along(XO, zF, zP, 0.89, 0.07, 0.06);
    post(XO, zP, FB + 0.01);
    balusters(XO, zF + 0.12, zAt(FB - 0.06) + 0.05, (z) => Math.min(yN(z) + 0.87, FB + 0.01));
    along(-1.685, zP + 0.15, S.z1 - 0.06, 0.9, 0.05, 0.05);   // (on the beam's face (x -1.75), then the upstairs wall's (-1.77))
    brackets(-1.78, -1.69, zP + 0.15, S.z1 - 0.06, 0.9);
    // the hall side (x1): open to the living room up to the hall wall (its end at z -1.3), then a handrail on the wall
    const zW = -1.34;
    post(XI, zF, yN(zF) + 0.98, 0.1);
    along(XI, zF, zW, 0.89, 0.07, 0.06);
    post(XI, zW, yN(zW) + 0.95);
    balusters(XI, zF + 0.12, zW - 0.06, (z) => yN(z) + 0.87);
    along(-0.905, -1.22, S.z1 - 0.06, 0.9, 0.05, 0.05);       // (the hall wall's face: x -0.84; the beam's: -0.86)
    brackets(-0.93, -0.79, -1.22, S.z1 - 0.06, 0.9);
    // walked against from the living room (the nook) and the hall: the stair's sides, foot to top
    this.solidStair = [[S.x0, S.z0, S.x0, S.z1, 0.04], [S.x1, S.z0, S.x1, -1.2, 0.04]];
  }

  // ------------------------------------------------------------------ the bathrooms: the sanitary ware
  // Meshy models at real sizes (public/models/bathroom/: tools/meshy-bathroom.mjs), a simple stand-in until they load
  // (or if one is missing). Each: where it stands (house frame, its floor), the way it faces, its real size.
  buildBathrooms() {
    const M = this.M;
    const fixture = (id, x, y, z, face, size, axis, fallback) => {
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = face; this.house.add(g);
      const stand = fallback?.(g);
      this.loads.push(loadGLB(`bathroom/${id}`).then((gl) => {
        if (!gl) return;
        const m = gl.scene.clone(true);
        m.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); interiorLit(o.material); o.castShadow = o.receiveShadow = false; if (id === 'shower') { o.material.transparent = true; o.material.opacity = 0.5; o.material.depthWrite = false; o.renderOrder = 2; /* (its glass walls: Meshy bakes them opaque) */ } } });
        const b = new THREE.Box3().setFromObject(m), s = new THREE.Vector3(); b.getSize(s);
        const k = size / Math.max(1e-3, axis === 'h' ? s.y : axis === 'x' ? s.x : Math.max(s.x, s.z));
        m.scale.setScalar(k);
        m.updateMatrixWorld(true); b.setFromObject(m);
        m.position.set(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
        if (stand) g.remove(stand);
        g.add(m);
      }).catch(() => null));
      return g;
    };
    const toilet = (g) => {
      const s = new THREE.Group();
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.4, 20), M.ceramic); bowl.position.set(0, 0.2, 0.08); bowl.scale.z = 1.3; s.add(bowl);
      const tank = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.17), M.ceramic); tank.position.set(0, 0.62, -0.2); s.add(tank);
      g.add(s); return s;
    };
    const basin = (g) => {
      const s = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.45), M.ceramic); top.position.set(0, 0.8, 0); s.add(top);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.7, 0.42), M.door); cab.position.set(0, 0.36, 0); s.add(cab);
      g.add(s); return s;
    };
    // ground floor bathroom (x 1.5..IX, z 1.72..4.5): the toilet on its west wall, the shower in the far corner, the
    // vanity on the wall to the snug, the mirror over it
    fixture('toilet', 1.5 + IT / 2 + 0.36, G, 2.55, Math.PI / 2, 0.8, 'h', toilet);   // (0.8 m to the cistern's top)
    this.round.ground.push({ x: 1.5 + 0.4, z: 2.55, r: 0.3 });
    fixture('washbasin', 2.05, G, 4.5 - IT / 2 - 0.28, Math.PI, 0.65, 'x', basin);    // (a 65 cm vanity, ~0.9 m high)
    this.boxes.ground.push({ x: 2.05, z: 4.5 - 0.3, hw: 0.33, hd: 0.27, rot: 0 });
    fixture('bath_mirror', 2.05, G + 1.25, 4.5 - IT / 2 - 0.02, Math.PI, 0.6, 'x');
    { // the glass shower (2.0 m tall, ~1.15 x 1.33 m) in the corner by the front wall
      const x1 = IX, x0 = x1 - 1.15, z1 = 4.5 - IT / 2, z0 = z1 - 1.33;
      fixture('shower', (x0 + x1) / 2, G, (z0 + z1) / 2, -Math.PI / 2, 2.0, 'h', (g) => {
        const s = new THREE.Group();
        const tray = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 0.95), M.ceramic); tray.position.y = 0.03; s.add(tray);
        const gl1 = new THREE.Mesh(new THREE.BoxGeometry(0.012, 1.95, 0.5), M.glass); gl1.position.set(0.47, 1.0, 0.22); s.add(gl1);
        g.add(s); return s;
      });
      this.solid.ground.push([x0, z0, x0, z1 - 0.5, 0.02], [x0, z0, x1, z0, 0.02]);
    }
    // the upper bathroom (x -IX..-1.83, z -2.8..2.8, the dormer at its back): the bath along the back wall, the
    // toilet under the dormer window, the vanity on the stairwell's wall
    {
      const x0 = -IX, x1 = x0 + 0.8, z0 = -2.6, z1 = -0.9;
      fixture('bathtub', (x0 + x1) / 2, FL, (z0 + z1) / 2, Math.PI / 2, 1.7, 'xz', (g) => { // (the model's long side: its x)
        const s = new THREE.Group(); const t = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.56, 0.78), M.ceramic); t.position.y = 0.28; s.add(t); g.add(s); return s;
      });
      this.solid.up.push([x1, z0, x1, z1, 0.03], [x0, z1, x1, z1, 0.03]);
    }
    fixture('toilet', -IX + 0.36, FL, 0.7, Math.PI / 2, 0.8, 'h', toilet);
    this.round.up.push({ x: -IX + 0.42, z: 0.7, r: 0.3 });
    fixture('washbasin', -1.83 - IT / 2 - 0.25, FL, -0.2, -Math.PI / 2, 0.65, 'x', basin);
    this.boxes.up.push({ x: -1.83 - 0.3, z: -0.2, hw: 0.24, hd: 0.33, rot: 0 });
    fixture('bath_mirror', -1.83 - IT / 2 - 0.02, FL + 1.25, -0.2, -Math.PI / 2, 0.6, 'x');
  }

  // ------------------------------------------------------------------ the built-in lamps (Meshy) and their light
  buildLamps() {
    // the ceiling lamps (Oct 29, the user: "the lamps on the ceiling are super bad ... use Meshy lamps"): a rustic
    // alpine drum pendant (a canopy at the ceiling, a thin rod, a linen drum shade) in every room and a wrought-iron
    // candle chandelier over the living room's table; regenerated (tools/meshy-bathroom.mjs), the best of a few
    // picked by their geometry (canopy on top, the shade below it, upright, sensible width / height). Fitted by their
    // height, one uniform scale, their top (the canopy) on the ceiling. The light's source: in the shade / among the
    // candles (no stand-in mesh: the room is shown only once they're in, ChaletRoom.warm)
    const lamp = (id, x, y, z, face, size, level, power, glowAt) => {
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = face; this.house.add(g);
      this.loads.push(loadGLB(`lamps/${id}`).then((gl) => {
        if (!gl) return;
        const m = gl.scene.clone(true);
        m.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); if (o.material.emissive) { o.material.emissive.set(0xffb46b); o.material.emissiveIntensity = id === 'wall_lamp' ? 0.35 : 0.5; if (!o.material.emissiveMap && o.material.map) o.material.emissiveMap = o.material.map; } interiorLit(o.material); o.castShadow = o.receiveShadow = false; } });
        const b = new THREE.Box3().setFromObject(m), s = new THREE.Vector3(); b.getSize(s);
        m.scale.setScalar(size / Math.max(1e-3, s.y)); // (by height: uniform)
        m.updateMatrixWorld(true); b.setFromObject(m);
        // ceiling lamps hang from y (their canopy at it); sconces: their back on the wall (local -z), centred on y
        if (id === 'wall_lamp') m.position.set(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
        else m.position.set(-(b.min.x + b.max.x) / 2, -b.max.y, -(b.min.z + b.max.z) / 2);
        g.add(m);
      }).catch(() => null));
      g.updateMatrixWorld(true);
      const p = g.localToWorld(new THREE.Vector3(0, -size * glowAt, id === 'wall_lamp' ? 0.12 : 0)); // (house frame)
      this.lamps.push({ x: p.x, y: p.y, z: p.z, level, power });
    };
    // a pendant over the middle of each room (the chandelier over the living room's table end)
    for (const r of ROOMS) {
      const q = r.rects.reduce((a, b) => ((b.x1 - b.x0) * (b.z1 - b.z0) > (a.x1 - a.x0) * (a.z1 - a.z0) ? b : a));
      const x = (q.x0 + q.x1) / 2, z = (q.z0 + q.z1) / 2, up = r.level === 'up';
      const y = up ? Math.min(ceilingUp(x, z), FL + COLLAR) - 0.02 : GC - 0.02; // (hung from the ceiling, its bottom ~1.9 m over the floor)
      if (r.id === 'living') {
        lamp('chandelier', x - 1.6, y, z, 0, 0.85, 'ground', 1.0, 0.72);
        lamp('pendant_drum', x + 1.9, y, z, 0, 0.7, 'ground', 0.8, 0.85);
      } else lamp('pendant_drum', x, y, z, 0, r.bath ? 0.5 : 0.7, r.level, r.bath ? 0.6 : 0.8, 0.85);
    }
    // wall sconces: the living room's back wall, the hall, the snug, the landing; 1.75 m over the floor
    const sy = G + 1.75;
    lamp('wall_lamp', -IX + 0.02, sy, -3.6, Math.PI / 2, 0.36, 'ground', 0.45, 0);
    lamp('wall_lamp', -IX + 0.02, sy, -5.0 + 0.2, Math.PI / 2, 0.36, 'ground', 0.45, 0);
    lamp('wall_lamp', -0.78 + IT / 2 + 0.01, sy, 0.6, Math.PI / 2, 0.36, 'ground', 0.4, 0);
    lamp('wall_lamp', -IX + 0.02, sy, 4.2, Math.PI / 2, 0.36, 'ground', 0.4, 0);
    lamp('wall_lamp', 0.65 - IT / 2 - 0.01, FL + 1.75, -1.4, -Math.PI / 2, 0.36, 'up', 0.35, 0);
  }

  // ------------------------------------------------------------------ walking
  pushSegs(list, p) {
    for (const [ax, az, bx, bz, half] of list) {
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / l2));
      const qx = ax + ex * t, qz = az + ez * t, dx = p.x - qx, dz = p.z - qz, d = Math.hypot(dx, dz), rr = R0 + half;
      if (d < rr) { if (d > 1e-5) { p.x = qx + (dx / d) * rr; p.z = qz + (dz / d) * rr; } else { p.x += -ez / Math.sqrt(l2) * rr; p.z += ex / Math.sqrt(l2) * rr; } }
    }
  }
  pushBox(c, p) {
    const co = Math.cos(c.rot || 0), si = Math.sin(c.rot || 0), dx = p.x - c.x, dz = p.z - c.z;
    const lx = dx * co - dz * si, lz = dx * si + dz * co, ex = c.hw + R0, ez = c.hd + R0;
    if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) return;
    let nx = lx, nz = lz;
    if (ex - Math.abs(lx) < ez - Math.abs(lz)) nx = Math.sign(lx || 1) * ex; else nz = Math.sign(lz || 1) * ez;
    p.x = c.x + nx * co + nz * si; p.z = c.z - nx * si + nz * co;
  }
  pushObjects(level, p) {
    for (const o of this.round[level]) { const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), rr = o.r + R0; if (d < rr && d > 1e-5) { p.x = o.x + (dx / d) * rr; p.z = o.z + (dz / d) * rr; } }
    for (const c of this.boxes[level]) this.pushBox(c, p);
    for (const e of this.placed) {
      const c = e.col;
      if (!c || e.level !== level) continue;
      if (c.r != null) { const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), rr = c.r + R0; if (d < rr && d > 1e-5) { p.x = c.x + (dx / d) * rr; p.z = c.z + (dz / d) * rr; } continue; }
      this.pushBox(c, p);
    }
  }
  walk(dt) {
    const p = this.pos, q = this.prev.copy(p), S = STAIR, H = HOLE;
    p.addScaledVector(this.vel, dt);
    if (this.level === 'ground') {
      if (q.z <= S.z0 && p.z > S.z0 && p.x > S.x0 + 0.05 && p.x < S.x1 - 0.05) this.level = 'stair';
      else {
        for (let i = 0; i < 2; i++) { this.pushSegs(this.solid.ground, p); this.pushSegs(this.solidStair, p); this.pushObjects('ground', p); }
        if (p.x > S.x0 - R0 && p.x < S.x1 + R0 && p.z > S.z0 && p.z < S.z1) { // (the stair's footprint: the nook's side runs its whole length)
          if (q.z <= S.z0) p.z = S.z0; else p.x = p.x < (S.x0 + S.x1) / 2 ? S.x0 - R0 : S.x1 + R0;
        }
      }
    }
    if (this.level === 'stair') {
      p.x = Math.max(S.x0 + R0, Math.min(S.x1 - R0, p.x));
      if (p.z < S.z0) this.level = 'ground';
      else if (p.z > S.z1) this.level = 'up';
    }
    if (this.level === 'up') {
      if (q.z >= H.z1 && p.z < H.z1 && p.x > H.x0 + 0.05 && p.x < H.x1 - 0.05) this.level = 'stair';
      else {
        for (let i = 0; i < 2; i++) { this.pushSegs(this.solid.up, p); this.pushObjects('up', p); }
        if (p.x > H.x0 && p.x < H.x1 + R0 && p.z > H.z0 - R0 && p.z < H.z1) {
          if (q.x >= H.x1 + R0 - 0.01) p.x = H.x1 + R0; else if (q.z <= H.z0 - R0 + 0.01) p.z = H.z0 - R0; else p.z = H.z1;
        }
        const lim = p.z > DORMER.z0 && p.z < DORMER.z1 ? IX - R0 : 3.0;
        p.x = Math.max(-lim, Math.min(lim, p.x));
      }
    }
    // the house's inner faces
    p.x = Math.max(-IX + R0, Math.min(IX - R0, p.x));
    p.z = Math.max(-IZ + R0, Math.min(IZ - R0, p.z));
    p.y = this.level === 'up' ? FL : this.level === 'stair' ? stairY(p.z) : G;
  }

  // ------------------------------------------------------------------ in and out
  /** In through the front door: in the hall, facing in (every inner door shut, a fresh house). */
  enter() {
    this.active = true;
    const d = this.doorAt;
    this.level = 'ground';
    this.pos.set(d.x - d.nx * 0.5, G, (d.z0 + d.z1) / 2); this.eyeY = G + EYE;
    this.yaw = Math.atan2(-d.nx, -d.nz); this.pitch = -0.05; this.vel.set(0, 0, 0);
    for (const dr of this.doors) { dr.target = 0; dr.angle = 0; dr.update(0); }
    for (const L of this.pool) L.intensity = 0;
  }
  leave() { this.active = false; this.vel.set(0, 0, 0); this.releasePortal(); }
  roomName() { return (this.level === 'stair' ? 'Stairs' : this.roomAt(this.pos.x, this.pos.z, this.level)?.name) || 'Chalet'; }

  /** Per frame while inside: the doors swing, the light pool goes to the lamps nearest the eye (house frame). */
  tick(dt, eye, hour = 12) {
    for (const d of this.doors) if (d.angle !== d.target) d.update(dt);
    // the fill: cool daylight by day (through the windows), a warm glow at night (never pitch dark)
    const day = clamp((hour - 6.5) / 1.5, 0, 1) * clamp((19 - hour) / 1.5, 0, 1);
    interiorLight.amb.value.setRGB(0.15 + 0.43 * day, 0.13 + 0.49 * day, 0.11 + 0.6 * day);
    interiorLight.hemi.value = 0.06 + 0.06 * day;
    this.portalMat.uniforms.uDay.value = 0.15 + 0.85 * day;
    // the pool: the 4 lamps nearest the eye (house frame), 2700 K
    if (!this.pool) return;
    const on = this.active && eye;
    if (on) {
      const lv = eye.y > (G + FL) / 2 + 0.6 ? 'up' : 'ground';
      const all = furnitureLamps.length ? this.lamps.concat(furnitureLamps.map((f) => ({ ...f, level: f.y > (G + FL) / 2 + 0.6 ? 'up' : 'ground' }))) : this.lamps;
      const ranked = all.map((l) => ({ l, d: Math.hypot(l.x - eye.x, (l.y - eye.y) * 1.5, l.z - eye.z) + (l.level === lv ? 0 : 6) })).sort((a, b) => a.d - b.d);
      this.pool.forEach((L, i) => {
        const r = ranked[i];
        if (!r) { L.intensity = 0; return; }
        L.position.set(r.l.x, r.l.y - 0.08, r.l.z); // (the pool is in the house group: house frame)
        const want = 7.5 * r.l.power * (1 - 0.25 * day);
        L.intensity += (want - L.intensity) * Math.min(1, dt * 6);
      });
    } else for (const L of this.pool) L.intensity = 0;
  }

  /** Walk / look (input null: a panel is open). Returns what you can do: { kind: 'door', label, door } or null. */
  update(dt, input, sensitivity = 1) {
    if (input) {
      const sens = 0.0022 * sensitivity;
      this.yaw -= input.mdx * sens;
      this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - input.mdy * sens));
      const fw = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0), st = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), want = _v.set(-fz * st + fx * fw, 0, fx * st + fz * fw);
      if (want.lengthSq()) want.normalize().multiplyScalar(2.3);
      this.vel.lerp(want, 1 - Math.exp(-dt * 10));
    } else this.vel.multiplyScalar(Math.exp(-dt * 10));
    // walking into a shut door opens it (away from you; not the front door: E there takes you out)
    const lvl = this.level === 'stair' ? null : this.level;
    if (lvl && this.vel.lengthSq() > 0.3) {
      for (const d of this.doors) {
        if (d.front || d.level !== lvl || Math.abs(d.target) > 0.01 || Math.abs(d.angle) > 0.05) continue;
        const [ax, az, bx, bz] = d.seg, ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
        const t = clamp(((this.pos.x - ax) * ex + (this.pos.z - az) * ez) / l2, 0, 1), dx = this.pos.x - (ax + ex * t), dz = this.pos.z - (az + ez * t);
        if (Math.hypot(dx, dz) < R0 + 0.12 && t > 0.15 && t < 0.85 && (this.vel.x * dx + this.vel.z * dz) < 0) d.toggle(this.pos.x, this.pos.z);
      }
    }
    this.walk(dt);
    this.eyeY += (this.pos.y + EYE - this.eyeY) * (1 - Math.exp(-dt * 14));
    const cam = this.camera;
    _e.set(this.pitch, this.yaw + Math.PI, 0);
    cam.position.set(this.pos.x, this.eyeY, this.pos.z);
    cam.quaternion.setFromEuler(_e);
    cam.updateMatrixWorld(true);
    for (const cb of this.hooks) { try { cb(dt, input); } catch (e) { console.warn('chalet hook', e); } }
    this.renderPortal();
    if (!input) return null;
    // a door: looked at (within 2.5 m), or the nearest doorway you stand in
    cam.getWorldPosition(_v); cam.getWorldDirection(_w);
    const hit = new THREE.Raycaster(_v, _w, 0, 2.5).intersectObjects(this.doors.map((d) => d.leaf), false)[0];
    let door = hit?.object.userData.door || null;
    if (!door && lvl) {
      let best = 0.9;
      for (const d of this.doors) { if (d.level !== lvl) continue; const mx = d.hinge[0] + d.u[0] * d.w / 2, mz = d.hinge[1] + d.u[1] * d.w / 2, dd = Math.hypot(this.pos.x - mx, this.pos.z - mz) - (d.front ? 0.5 : 0); if (dd < best) { best = dd; door = d; } } // (the front door: from a step further in)
    }
    if (!door) return null;
    const shut = Math.abs(door.target) < 0.01;
    if (door === this.front) return { kind: 'exit', door, label: 'Leave the chalet' };
    return { kind: 'door', door, label: shut ? 'Open the door' : 'Close the door' };
  }
  /** E at an inner door (the prompt's target; the front door: game/chalets.js takes you out). */
  use(t) { if (t?.kind === 'door' && t.door) t.door.toggle(this.pos.x, this.pos.z); }

  // ------------------------------------------------------------------ the build mode's hooks (see the API above)
  addObject(obj, col) {
    if (obj && obj.parent !== this.root) this.root.add(obj);
    litTree(obj);
    const y0 = col?.y0 ?? obj?.position?.y ?? G;
    const e = { obj, col: col || null, level: y0 > (G + FL) / 2 ? 'up' : 'ground' };
    this.placed.add(e);
    return e;
  }
  removeObject(h) {
    if (!h) return;
    const e = h.obj ? h : [...this.placed].find((x) => x.obj === h);
    if (!e) { h.parent?.remove?.(h); return; }
    this.placed.delete(e);
    e.obj?.parent?.remove(e.obj);
  }
  onFrame(cb) { this.hooks.add(cb); return () => this.hooks.delete(cb); }
  storeys() {
    return ['ground', 'up'].map((level) => ({
      level, floorY: level === 'up' ? FL : G, ceilingY: level === 'up' ? FL + DORMER.h : GC,
      rects: ROOMS.filter((r) => r.level === level).flatMap((r) => r.rects.map((q) => ({ ...q, room: r.id }))),
    }));
  }
}

// ------------------------------------------------------------------ the API (live: game/chalets.js sets `room`)
const api = { room: null, owner: null };
// The lamps you've bought and switched on (build/lamps.js), house frame { x, y, z, power }: they share the room's
// light pool (one fixed set of point lights in the interior's own scene: none in the outdoor world)
let furnitureLamps = [];
export function setFurnitureLamps(list) { furnitureLamps = list || []; }
export function setChaletInterior(room, owner) { api.room = room; api.owner = owner; }
export const chaletInteriorAPI = {
  get inside() { return !!api.room?.active; },
  get active() { return !!(api.room?.active && api.owner?.insideOwn?.()); },
  isActive() { return this.active; },
  get chalet() { return api.room?.active ? api.owner?.current || null : null; },
  get scene() { return api.room?.scene || null; },
  get house() { return api.room?.house || null; },
  get root() { return api.room?.root || null; },
  get camera() { return api.room?.camera || null; },
  get player() { const r = api.room; return r ? { pos: r.pos, yaw: r.yaw, pitch: r.pitch, level: r.level, eye: r.eyeY } : null; },
  get storeys() { return api.room ? api.room.storeys() : []; },
  get walls() { return api.room ? api.room.wallList : []; },
  get sills() { return api.room ? api.room.sillList : []; },
  ceilingAt,
  addObject(obj, col) { return api.room?.addObject(obj, col) ?? null; },
  removeObject(h) { api.room?.removeObject(h); },
  onFrame(cb) {
    if (api.room) return api.room.onFrame(cb);
    const t = setInterval(() => { if (api.room) { clearInterval(t); api.room.onFrame(cb); } }, 500);
    return () => { clearInterval(t); api.room?.hooks.delete(cb); };
  },
};
if (typeof window !== 'undefined') window.chaletInteriorAPI = chaletInteriorAPI;
