// Inside the CAR RENTAL (its own scene, like the ski shop's: main.js renders it through post.setView while you're in).
// The very hall you see from the road (carrentalshell.js builds both sides from one LAYOUT): larch walls, the glass
// front with its mullions and sliding doors, the vaulted timber ceiling on glulam trusses, the five cars on their
// turntables where they stand behind the glass outside; two storeys (the stair along the left wall up to the
// mezzanine: two more cars, the office). A polished dark stone floor that mirrors the cars, a reception desk (the
// clerk behind it), a lounge corner. Through the glass: the REAL world, rendered live the ski shop's way
// (interior.js): a second camera, your camera carried to where the hall stands in the village (setWorld), renders
// the world (the hall itself hidden) into a target the window planes show by screen position (gl_FragCoord).
// Walk with WASD + mouse; look at a car or the clerk and press E (carrental.js).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { fitModel, loadGLB } from '../core/assets.js';
import { carTemplate, carInstance, driverEye } from './cars.js';
import { dressCar, setPlates } from './carconfig.js';
import { LAYOUT, buildShell, stairY, setDoors, ceilingAt } from './carrentalshell.js';
// the full-detail models (their interiors) for the configurator's cockpit view (as drive.js)
const FULL = { car_audi_rs6: 'car_audi_rs6_full', car_vw_golf_gti: 'car_vw_golf_gti_full', car_tesla_m3: 'car_tesla_m3_full' };
// where the configurator's camera looks from, per step (round the car from its nose: 0 front, pi the back), how far
const SHOT = { paint: [1.05, 0.24, 5.4], rims: [1.45, 0.06, 4.6], plate: [Math.PI - 0.3, 0.12, 4.8], sum: [0.6, 0.22, 5.8] };

export const ROOM = { W: LAYOUT.W, D: LAYOUT.D, H: LAYOUT.H };
const EYE = 1.62, UP = new THREE.Vector3(0, 1, 0);
const HITBOX = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const DOOR = LAYOUT.door, DESK = LAYOUT.desk;
const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _size = new THREE.Vector2(), _frustum = new THREE.Frustum(), _box = new THREE.Box3();
// the window view: the world render, indexed by where the fragment is on screen (as interior.js); a faint cool tint
// and a soft sheen toward the top read as clean glass; no world yet: a pale winter sky
const PORTAL_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PORTAL_FRAG = `
  uniform sampler2D tView;
  uniform float uHas;
  uniform vec4 uVP;
  varying vec2 vUv;
  void main() {
    vec2 suv = (gl_FragCoord.xy - uVP.xy) / uVP.zw;
    vec3 view = texture2D(tView, suv).rgb;
    vec3 sky = mix(vec3(1.5, 1.6, 1.75), vec3(0.3, 0.5, 0.95), smoothstep(0.3, 1.0, suv.y));
    vec3 c = mix(sky, view, uHas) * vec3(0.94, 0.96, 0.97);
    c += vec3(0.025, 0.03, 0.035) * smoothstep(0.4, 1.0, vUv.y);
    gl_FragColor = vec4(c, 1.0);
  }`;

function tex(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
const box = (w, h, d, mat, x, y, z, parent) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; parent?.add(m); return m; };

export class CarRentalRoom {
  /** @param {{ renderer, models, makeRig: () => object, cars: {id,label,price,length}[], display: {id, paint}[] }} o */
  constructor({ renderer, models, makeRig, cars, display, upper = [] }) {
    this.active = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2a2420);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 1500);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
    this.pos = new THREE.Vector3(); this.level = 'ground'; this.eyeY = EYE; this.doorT = 0; this.vel = new THREE.Vector3(); this.yaw = Math.PI; this.pitch = -0.08;
    this.obstacles = []; this.aimables = []; this.tables = [];
    this.cfg = null; // the configurator: { table, step, yaw, pitch, dist } (carrental.js configure())
    this.models = models; this.cars = cars; this.renderer = renderer;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.55;
    this.buildShell(renderer);
    this.buildLights();
    this.buildCars(models, cars, display);
    this.buildUpper(models, cars, upper);
    this.buildDesk(models, makeRig);
    this.buildLounge(models);
    this.portalMeshes();
  }
  // ------------------------------------------------------------------ the view out (live, as the ski shop's)
  // One plane just outside the glazing covers the whole front (every pane, the door bay: open or shut it shows the
  // world); the upper side windows take the same material (buildShell). The panes themselves draw nothing.
  buildPortal() {
    const { W, D, H, PIER } = LAYOUT, top = H - 0.5;
    this.portalMat = new THREE.ShaderMaterial({
      uniforms: { tView: { value: null }, uHas: { value: 0 }, uVP: { value: new THREE.Vector4(0, 0, 1, 1) } },
      vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG,
    });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W - 2 * PIER + 0.2, top + 0.1), this.portalMat);
    front.position.set(0, (top + 0.1) / 2 - 0.05, D / 2 + 0.22); front.rotation.y = Math.PI; // (beyond the mullions, the door's header, the sill)
    this.scene.add(front);
    this.portalFront = front;
    // (every window plane reports the viewport it is drawn into; the first draw of the frame sets it for all)
    const vp = (r) => r.getCurrentViewport(this.portalMat.uniforms.uVP.value);
    front.onBeforeRender = vp;
    // the floor's mirror would sample the view at the wrong place: in its reflection the windows are a plain pale sky
    if (this.mirror) {
      const flat = new THREE.MeshBasicMaterial({ color: 0xc8d6e2 }), orig = this.mirror.onBeforeRender, self = this;
      this.mirror.onBeforeRender = function (...a) {
        const list = self.portalMeshes();
        for (const m of list) m.material = flat;
        try { orig.apply(this, a); } finally { for (const m of list) m.material = self.portalMat; }
      };
    }
    this.portalCam = new THREE.PerspectiveCamera(70, 1, 0.1, 30000);
    this.lastShadow = 0;
  }
  portalMeshes() {
    if (this._portalMeshes) return this._portalMeshes;
    const list = [];
    this.scene.traverse((o) => { if (o.isMesh && o.material === this.portalMat) { list.push(o); o.onBeforeRender = this.portalFront.onBeforeRender; } });
    return (this._portalMeshes = list);
  }
  /**
   * Where the hall stands in the world: { scene, frame: Object3D in the hall's frame (floor middle, +z out of the
   * glass), hide: () => Object3D[] (the hall seen from outside, you) }.
   */
  setWorld(o) { this.world = o && o.scene && o.frame ? o : null; }
  releasePortal() {
    if (this.portalRT) { this.portalRT.dispose(); this.portalRT = null; }
    this.portalMat.uniforms.tView.value = null;
    this.portalMat.uniforms.uHas.value = 0;
  }
  // Render the world from where your camera would be if the hall were the real one (only while a window is in view);
  // the world's shadows are refreshed every few seconds, not every frame.
  renderPortal() {
    const o = this.world, r = this.renderer;
    if (!o || !r) return;
    const cam = this.camera, meshes = this.portalMeshes();
    cam.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    if (!meshes.some((m) => _frustum.intersectsBox(_box.setFromObject(m)))) return;
    const size = r.getDrawingBufferSize(_size);
    const k = Math.min(1, 1800 / Math.max(1, size.x));
    const w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
    if (!this.portalRT) {
      this.portalRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
      this.portalMat.uniforms.tView.value = this.portalRT.texture;
      this.lastShadow = 0;
    } else if (this.portalRT.width !== w || this.portalRT.height !== h) this.portalRT.setSize(w, h);
    const pc = this.portalCam;
    o.frame.updateMatrixWorld();
    _m.multiplyMatrices(o.frame.matrixWorld, cam.matrixWorld).decompose(pc.position, pc.quaternion, _s);
    pc.fov = cam.fov; pc.aspect = cam.aspect; pc.near = 0.1; pc.far = 30000;
    const v = cam.view; // (the configurator frames the car off-centre: the same offset)
    if (v?.enabled) pc.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height); else pc.clearViewOffset();
    pc.updateProjectionMatrix();
    const hidden = (o.hide?.() || []).filter(Boolean), was = hidden.map((x) => x.visible);
    for (const x of hidden) x.visible = false;
    const prev = r.getRenderTarget(), auto = r.shadowMap.autoUpdate, now = performance.now();
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = now - this.lastShadow > 3000;
    if (r.shadowMap.needsUpdate) this.lastShadow = now;
    try {
      r.setRenderTarget(this.portalRT);
      r.clear();
      r.render(o.scene, pc);
      this.portalMat.uniforms.uHas.value = 1;
    } catch (e) {
      console.warn('Car rental window view failed', e);
      this.world = null;
      this.portalMat.uniforms.uHas.value = 0;
    } finally {
      r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = auto;
      r.shadowMap.needsUpdate = false;
      hidden.forEach((x, i) => { x.visible = was[i]; });
    }
  }

  // ------------------------------------------------------------------ the room
  buildShell() {
    const { W, D } = ROOM, S = this.scene;
    // polished floor: large dark stone tiles over a mirror (the cars and lights reflect, softly)
    const floorTex = tex(1024, 1024, (g, w, h) => {
      const r = rng(7);
      g.fillStyle = '#3a3836'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { // 4 tiles per texture, each a little different
        const v = 52 + r() * 12; g.fillStyle = `rgb(${v},${v - 2},${v - 4})`; g.fillRect(i * 512 + 2, j * 512 + 2, 508, 508);
        for (let k = 0; k < 40; k++) { g.strokeStyle = `rgba(${r() < 0.5 ? '255,250,240' : '20,18,16'},${0.03 + r() * 0.05})`; g.lineWidth = 0.5 + r() * 2; g.beginPath(); const x0 = i * 512 + r() * 512, y0 = j * 512 + r() * 512; g.moveTo(x0, y0); g.bezierCurveTo(x0 + r() * 120 - 60, y0 + r() * 120 - 60, x0 + r() * 200 - 100, y0 + r() * 200 - 100, x0 + r() * 260 - 130, y0 + r() * 260 - 130); g.stroke(); }
      }
      g.fillStyle = '#1d1c1b'; for (let k = 0; k <= 2; k++) { g.fillRect(k * 512 - 2, 0, 4, h); g.fillRect(0, k * 512 - 2, w, 4); }
    }, { repeat: [W / 3.2, D / 3.2] });
    try {
      const mirror = new Reflector(new THREE.PlaneGeometry(W, D), { textureWidth: 1024, textureHeight: 1024, color: 0x8a8a8a });
      mirror.rotation.x = -Math.PI / 2; mirror.position.y = -0.002;
      S.add(mirror);
      this.mirror = mirror;
    } catch { this.mirror = null; }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshPhysicalMaterial({ map: floorTex, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, transparent: !!this.mirror, opacity: this.mirror ? 0.8 : 1 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    S.add(floor);
    // the hall: the shared shell (walls, the glass front and door, the trusses and ceiling), the glass nearly clear
    // the glass itself draws nothing (no second layer, no sheen to fight with): what you see through every pane is
    // the live view (buildPortal: the front's one plane behind the glazing, the upper side windows)
    const glass = new THREE.MeshBasicMaterial({ visible: false });
    this.buildPortal();
    this.doors = buildShell(S, 'in', glass, { view: this.portalMat }).doors;
    this.doorHit = new THREE.Mesh(new THREE.BoxGeometry(DOOR.w, DOOR.h, 0.4), HITBOX);
    this.doorHit.position.set(DOOR.x, DOOR.h / 2, D / 2 - 0.1); this.doorHit.userData.kind = 'door';
    S.add(this.doorHit); this.aimables.push(this.doorHit);
    const steel = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.4, metalness: 0.7 });
    box(W, 0.1, 0.03, steel, 0, 0.05, -D / 2 + 0.015, S); // (skirting)
    // the backlit sign on the oak wall: CAR RENTAL · LEGACY VILLAGE
    const sign = tex(2048, 400, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = 'italic 700 220px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillStyle = '#fff';
      if ('letterSpacing' in g) g.letterSpacing = '24px';
      g.shadowColor = 'rgba(255,214,150,0.9)'; g.shadowBlur = 30;
      g.fillText('CAR RENTAL', w / 2, h * 0.42);
      g.font = '600 64px "Inter Variable", Arial, sans-serif'; if ('letterSpacing' in g) g.letterSpacing = '20px'; g.fillStyle = '#f2c88c';
      g.fillText('LEGACY VILLAGE · SINCE 1967', w / 2, h * 0.86);
    });
    const sm = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.75), new THREE.MeshBasicMaterial({ map: sign, transparent: true, toneMapped: false }));
    sm.position.set(-4.4, 6.1, -D / 2 + 0.03); S.add(sm); // (over the mezzanine, seen from the door)
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 2.4), new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false }));
    halo.position.set(-4.4, 6.1, -D / 2 + 0.02); S.add(halo);
  }

  buildLights() {
    const S = this.scene, { H } = ROOM;
    S.add(new THREE.HemisphereLight(0xfff1de, 0x4a3a2c, 0.9));
    const key = new THREE.DirectionalLight(0xffe8cc, 1.2);
    key.position.set(4, H + 6, 6); key.target.position.set(0, 0, 0);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -14, right: 14, top: 10, bottom: -10, near: 1, far: 30 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    S.add(key, key.target);
    this.spots = [];
  }

  // ------------------------------------------------------------------ the cars on their turntables
  buildCars(models, cars, display) {
    const S = this.scene, spots = LAYOUT.spots; // (where they stand seen from outside too)
    const rim = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const top = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.55, metalness: 0.2 });
    const led = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e4, emissiveIntensity: 2.4 });
    display.forEach((d, k) => {
      const spec = cars.find((c) => c.id === d.id), gltf = models[d.id], at = spots[k % spots.length];
      if (!spec || !gltf) return;
      const R = LAYOUT.R, tt = new THREE.Group();
      tt.position.set(at[0], 0, at[1]);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.16, 64), top); disc.position.y = 0.08; disc.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.06, 10, 96), rim); ring.rotation.x = Math.PI / 2; ring.position.y = 0.13;
      const glow = new THREE.Mesh(new THREE.TorusGeometry(R + 0.07, 0.018, 6, 96), led); glow.rotation.x = Math.PI / 2; glow.position.y = 0.035;
      tt.add(disc, ring, glow);
      const spin = new THREE.Group(); spin.position.y = 0.16; tt.add(spin);
      const t0 = carTemplate(gltf, spec.length, d.id), inst = setPlates(carInstance(t0, { paint: d.paint }), t0);
      inst.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      spin.add(inst.group);
      spin.rotation.y = at[2];
      const hit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.7, spec.length + 0.2), HITBOX);
      hit.position.y = 0.85; hit.userData = { kind: 'car', id: d.id, paint: d.paint, label: spec.label };
      spin.add(hit); this.aimables.push(hit);
      S.add(tt);
      this.tables.push({ spin, speed: 0.1 + 0.03 * (k % 2), id: d.id, inst, t: t0, spec, x: at[0], z: at[1] });
      this.obstacles.push({ x: at[0], z: at[1], r: R + 0.1 });
      // a spotlight on it from the ceiling (no shadow: the key light casts them)
      const under = at[1] < LAYOUT.MZ + 1, sp = new THREE.SpotLight(0xffe2bd, under ? 30 : 70, under ? 8 : 14, under ? 0.8 : 0.5, 0.6, 1.6);
      sp.position.set(at[0], under ? LAYOUT.FL - 0.4 : ROOM.H - 0.4, at[1] + (under ? 1.6 : 1.2)); sp.target.position.set(at[0], 0.5, at[1]);
      S.add(sp, sp.target);
      // its price stand: a brushed steel post with a card (model, price)
      const card = tex(512, 320, (g, w, h) => {
        g.fillStyle = '#fbf8f2'; g.fillRect(0, 0, w, h); g.fillStyle = '#1546c8'; g.fillRect(0, 0, w, 14);
        g.textAlign = 'left'; g.fillStyle = '#8a2a1c'; g.font = '700 30px "Inter Variable", Arial, sans-serif'; g.fillText(spec.kind.toUpperCase(), 34, 72);
        g.fillStyle = '#1546c8'; g.font = 'italic 700 72px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillText(spec.label, 34, 152);
        g.fillStyle = '#8f1d14'; g.font = 'italic 700 96px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillText(`$${spec.price.toLocaleString("en-US")}`, 34, 270);
        g.fillStyle = 'rgba(30,40,70,0.65)'; g.font = '500 26px "Inter Variable", Arial, sans-serif'; g.fillText('per rental · E to rent', 250, 262);
      });
      const stand = new THREE.Group();
      box(0.05, 1.05, 0.05, rim, 0, 0.52, 0, stand);
      box(0.36, 0.02, 0.36, rim, 0, 0.01, 0, stand);
      const c = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.39), new THREE.MeshStandardMaterial({ map: card, roughness: 0.6 }));
      c.position.set(0, 1.18, 0.03); c.rotation.x = -0.35; stand.add(c);
      box(0.66, 0.43, 0.02, rim, 0, 1.18, 0.0, stand).rotation.x = -0.35;
      const toEntry = at[1] > 0 ? Math.atan2(DOOR.x - at[0], ROOM.D / 2 - at[1]) * 0.35 : Math.PI / 2; // (the front row's cards in front, turned a little to the door; the back row's beside, in the gap between the turntables)
      stand.position.set(at[0] + Math.sin(toEntry) * (R + 0.55), 0, at[1] + Math.cos(toEntry) * (R + 0.55));
      stand.rotation.y = toEntry;
      S.add(stand);
      this.obstacles.push({ x: stand.position.x, z: stand.position.z, r: 0.25 });
    });
  }

  // ------------------------------------------------------------------ upstairs: the supercars on the mezzanine
  // (for rent like the ones downstairs: E at one, the same configurator; on the floor itself, no turntable: a table
  // entry of their own that never turns, its floor at FL)
  buildUpper(models, cars, upper) {
    const S = this.scene, FL = LAYOUT.FL;
    this.obstaclesUp = [];
    const rim = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    upper.forEach((d, k) => {
      const at = LAYOUT.upSpots[k], spec = cars.find((c) => c.id === d.id), gltf = models[d.id];
      if (!at || !spec || !gltf) return;
      const t = carTemplate(gltf, spec.length, d.id), inst = setPlates(carInstance(t, { paint: d.paint }), t);
      inst.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      const spin = new THREE.Group(); spin.position.set(at[0], FL, at[1]); spin.rotation.y = at[2];
      spin.add(inst.group); S.add(spin);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.5, spec.length + 0.2), HITBOX);
      hit.position.y = 0.75; hit.userData = { kind: 'car', id: d.id, paint: d.paint, label: spec.label, up: true };
      spin.add(hit); this.aimables.push(hit);
      this.tables.push({ spin, speed: 0, id: d.id, inst, t, spec, x: at[0], z: at[1], y: FL, up: true });
      // its price card on a steel stand, at the balustrade in front of it
      const card = tex(512, 320, (g, w, h) => {
        g.fillStyle = '#16181c'; g.fillRect(0, 0, w, h); g.fillStyle = '#e2b81c'; g.fillRect(0, 0, w, 14);
        g.textAlign = 'left'; g.fillStyle = '#e2b81c'; g.font = '700 30px "Inter Variable", Arial, sans-serif'; g.fillText(spec.kind.toUpperCase(), 34, 72);
        g.fillStyle = '#f4f2ee'; g.font = `italic 700 ${spec.label.length > 18 ? 56 : 72}px "Barlow Condensed", "Arial Narrow", sans-serif`; g.fillText(spec.label, 34, 152);
        g.fillStyle = '#e2b81c'; g.font = 'italic 700 96px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillText(`$${spec.price.toLocaleString("en-US")}`, 34, 270);
        g.fillStyle = 'rgba(244,242,238,0.7)'; g.font = '500 26px "Inter Variable", Arial, sans-serif'; g.fillText('per rental · E to rent', 250, 262);
      });
      const stand = new THREE.Group();
      box(0.05, 1.05, 0.05, rim, 0, 0.52, 0, stand);
      box(0.36, 0.02, 0.36, rim, 0, 0.01, 0, stand);
      const c = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.39), new THREE.MeshStandardMaterial({ map: card, roughness: 0.6 }));
      c.position.set(0, 1.18, 0.03); c.rotation.x = -0.35; stand.add(c);
      box(0.66, 0.43, 0.02, rim, 0, 1.18, 0.0, stand).rotation.x = -0.35;
      stand.position.set(at[0] + 1.6, FL, LAYOUT.MZ - 0.55);
      S.add(stand);
      this.obstaclesUp.push({ x: stand.position.x, z: stand.position.z, r: 0.25 });
      const sp = new THREE.SpotLight(0xffe2bd, 45, 10, 0.6, 0.6, 1.6);
      sp.position.set(at[0], ROOM.H - 0.4, at[1] + 1.5); sp.target.position.set(at[0], FL + 0.5, at[1]);
      S.add(sp, sp.target);
      // (its footprint along its heading: three circles)
      for (const f of [-0.32, 0, 0.32]) this.obstaclesUp.push({ x: at[0] + Math.sin(at[2]) * f * spec.length, z: at[1] + Math.cos(at[2]) * f * spec.length, r: 1.05 });
    });
    // the office: its desk and shelf, the glass partition (a line of circles, the way in at its front end)
    const O = LAYOUT.office;
    this.obstaclesUp.push({ x: 9.6, z: -5.2, r: 0.75 }, { x: 8.9, z: -5.2, r: 0.5 }, { x: 10.3, z: -5.2, r: 0.5 }, { x: 10.6, z: -ROOM.D / 2 + 0.2, r: 0.4 }, { x: 9.6, z: -6.0, r: 0.3 });
    for (let z = -ROOM.D / 2 + 0.2; z <= O.gap; z += 0.3) this.obstaclesUp.push({ x: O.x0, z, r: 0.05 });
    // the ground floor: the posts under the mezzanine's edge, the stair's side (only its foot is open)
    for (const px of LAYOUT.posts) this.obstacles.push({ x: px, z: LAYOUT.MZ - 0.14, r: 0.16 });
  }

  // ------------------------------------------------------------------ the reception desk and the clerk
  buildDesk(models, makeRig) {
    const S = this.scene, g = new THREE.Group(), { x, z, r } = DESK;
    // a solid curved counter standing on the floor: a white gloss body (an annular sector, 0.62 m deep, 1.04 m
    // high), an oak top proud of it all round, a recessed dark plinth with an LED line; open toward the back wall
    const gloss = new THREE.MeshPhysicalMaterial({ color: 0xf6f4f0, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    const oakTop = new THREE.MeshStandardMaterial({ color: 0xb98552, roughness: 0.45 });
    const A = Math.PI * 0.4; // (half the arc)
    const sector = (r0, r1, a0 = -A, a1 = A) => { const sh = new THREE.Shape(); sh.absarc(0, 0, r1, Math.PI / 2 - a1, Math.PI / 2 - a0, false); sh.absarc(0, 0, r0, Math.PI / 2 - a0, Math.PI / 2 - a1, true); sh.closePath(); return sh; };
    // (drawn in x / y, laid flat: rotation.x -90 deg takes the shape's y to -z, so it is mirrored (scale.y -1) to
    // put the arc's front toward +z, the room)
    const slab = (shape, y0, h, mat) => { const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 40 }), mat); m.rotation.x = -Math.PI / 2; m.scale.y = -1; m.position.y = y0; mat.side = THREE.DoubleSide; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    slab(sector(r - 0.56, r - 0.06), 0, 0.1, new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.6 }));
    slab(sector(r - 0.62, r), 0.1, 0.94, gloss);
    slab(sector(r - 0.66, r + 0.05, -A - 0.02, A + 0.02), 1.04, 0.05, oakTop);
    const ledStrip = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.055, r - 0.055, 0.015, 48, 1, true, -A, 2 * A), new THREE.MeshBasicMaterial({ color: 0xffe2b8, toneMapped: false }));
    ledStrip.position.y = 0.095; g.add(ledStrip);
    // on it (the clerk's side, ~0.3 m in from the front): a monitor, keyboard, card terminal, a tray of keys, a vase
    const black = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.35, metalness: 0.4 });
    const ang = (a, d) => [Math.sin(a) * d, Math.cos(a) * d];
    const [mx, mz] = ang(-0.25, r - 0.38);
    const mon = new THREE.Group(); box(0.62, 0.38, 0.03, black, 0, 0.3, 0, mon); box(0.05, 0.22, 0.05, black, 0, 0.1, -0.03, mon); box(0.22, 0.015, 0.16, black, 0, 0.007, -0.03, mon);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.34), new THREE.MeshBasicMaterial({ color: 0x9fc0ee, toneMapped: false })); scr.position.set(0, 0.3, -0.017); scr.rotation.y = Math.PI; mon.add(scr);
    mon.position.set(mx, 1.09, mz); mon.rotation.y = -0.25 + Math.PI; g.add(mon);
    const kb = box(0.44, 0.02, 0.14, black, 0, 1.09, 0, g); const [kx, kz] = ang(-0.25, r - 0.62); kb.position.set(kx, 1.09, kz); kb.rotation.y = -0.25;
    const term = box(0.08, 0.04, 0.16, black, 0, 1.1, 0, g); const [tx, tz] = ang(0.25, r - 0.3); term.position.set(tx, 1.1, tz); term.rotation.set(0.3, 0.25, 0);
    const tray = box(0.3, 0.025, 0.2, new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.25 }), 0, 1.09, 0, g); const [ox, oz] = ang(0.6, r - 0.3); tray.position.set(ox, 1.09, oz);
    for (let k = 0; k < 4; k++) box(0.035, 0.012, 0.07, black, ox - 0.1 + k * 0.065, 1.11, oz, g);
    const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.22, 16), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.1, clearcoat: 1 }));
    const [vx, vz] = ang(-0.9, r - 0.25); vase.position.set(vx, 1.19, vz); g.add(vase);
    for (let k = 0; k < 5; k++) { const f = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshStandardMaterial({ color: k % 2 ? 0xe23a3a : 0xffffff, roughness: 0.6 })); f.position.set(vx + Math.sin(k * 1.3) * 0.06, 1.38 + (k % 3) * 0.03, vz + Math.cos(k * 1.3) * 0.06); g.add(f); }
    g.position.set(x, 0, z);
    S.add(g);
    this.deskYaw = 0; // (square to the back wall, facing the room)
    // the clerk behind it, facing the room
    try {
      this.clerk = makeRig();
      this.clerk.setSkisVisible?.(false);
      this.clerk.addTo(this.scene);
      this.clerk.root.position.set(x, 0, z + r - 1.05); // (behind the counter, at it)
    } catch (e) { console.warn('car rental clerk', e); this.clerk = null; }
    this.clerkYaw = this.deskYaw;
    this.clerkHit = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.9, 1.2), HITBOX);
    this.clerkHit.position.set(x, 0.95, z + r - 1.05); this.clerkHit.userData.kind = 'clerk';
    S.add(this.clerkHit); this.aimables.push(this.clerkHit);
    // the desk keeps you on the customer side: a ring of circles along its front
    for (let a = -A; a <= A + 1e-3; a += A / 6) this.obstacles.push({ x: x + Math.sin(a) * (r - 0.3), z: z + Math.cos(a) * (r - 0.3), r: 0.38 });
    this.obstacles.push({ x, z, r: r - 0.4 });
    // a key cabinet on the wall behind the desk
    const kc = new THREE.Group(); box(1.4, 0.9, 0.08, new THREE.MeshStandardMaterial({ color: 0xb98552, roughness: 0.5 }), 0, 0, 0, kc);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) box(0.03, 0.08, 0.02, black, -0.55 + i * 0.22, 0.25 - j * 0.25, 0.06, kc);
    kc.position.set(x, 1.9, -ROOM.D / 2 + 0.04); S.add(kc); // (flush on the wall: its back on the boards)
    if (models.potted_plant) for (const [px, pz] of [[x + r + 0.9, -ROOM.D / 2 + 0.6], [x - r - 0.9, -ROOM.D / 2 + 0.6]]) { const p = fitModel(models.potted_plant, { size: 1.5, axis: 'y' }); p.position.set(px, 0, pz); p.traverse((o) => { if (o.isMesh) o.castShadow = true; }); S.add(p); this.obstacles.push({ x: px, z: pz, r: 0.45 }); }
  }

  // ------------------------------------------------------------------ the lounge: a leather sofa, a coffee table, plants
  buildLounge(models) {
    const S = this.scene, g = new THREE.Group();
    const leather = new THREE.MeshPhysicalMaterial({ color: 0x8a4a22, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4 });
    const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.4, metalness: 0.6 });
    box(2.2, 0.38, 0.9, leather, 0, 0.42, 0, g); box(2.2, 0.48, 0.2, leather, 0, 0.82, -0.36, g);
    for (const sx of [-1.05, 1.05]) box(0.2, 0.62, 0.9, leather, sx, 0.5, 0, g);
    for (const sx of [-0.52, 0.52]) box(1.0, 0.14, 0.72, leather, sx, 0.66, 0.06, g);
    for (const sx of [-1.0, 1.0]) for (const sz of [-0.38, 0.38]) box(0.04, 0.24, 0.04, black, sx, 0.12, sz, g);
    const { z: lz } = LAYOUT.lounge, wx = ROOM.W / 2 - 0.5; // (the sofa's back to the right wall, facing the room)
    g.position.set(wx, 0, lz); g.rotation.y = -Math.PI / 2; S.add(g);
    const table = new THREE.Group();
    const tTop = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 32), new THREE.MeshPhysicalMaterial({ color: 0x2b2b2b, roughness: 0.1, clearcoat: 1 })); tTop.position.y = 0.42; tTop.castShadow = true;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.2, 0.4, 16), black); leg.position.y = 0.2;
    table.add(tTop, leg);
    for (let k = 0; k < 3; k++) box(0.24, 0.012, 0.32, new THREE.MeshStandardMaterial({ color: [0x1546c8, 0xd0342c, 0xf2f2f0][k], roughness: 0.7 }), -0.1 + k * 0.08, 0.446 + k * 0.012, 0, table).rotation.y = k * 0.4;
    table.position.set(wx - 1.45, 0, lz); S.add(table);
    this.obstacles.push({ x: wx, z: lz - 0.55, r: 0.7 }, { x: wx, z: lz + 0.55, r: 0.7 }, { x: wx - 1.45, z: lz, r: 0.6 });
    if (models.potted_plant) for (const [px, pz] of [[ROOM.W / 2 - 0.55, lz - 1.75], [ROOM.W / 2 - 0.55, ROOM.D / 2 - 0.7]]) { const p = fitModel(models.potted_plant, { size: 1.5, axis: 'y' }); p.position.set(px, 0, pz); p.traverse((o) => { if (o.isMesh) o.castShadow = true; }); S.add(p); this.obstacles.push({ x: px, z: pz, r: 0.45 }); }
  }

  // ------------------------------------------------------------------ the clerk's tip: a marker over that car
  /** Show the way to car `id` (null: off): a gold arrow bobbing over it and a glowing ring round it. */
  guide(id) {
    if (!this.marker) {
      const g = new THREE.Group(), gold = new THREE.MeshBasicMaterial({ color: 0xffc83a, toneMapped: false });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.6, 24), gold); cone.rotation.x = Math.PI; cone.position.y = 0.3;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.45, 16), gold); stem.position.y = 0.82;
      const arrow = new THREE.Group(); arrow.add(cone, stem); g.add(arrow);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.05, 8, 96), new THREE.MeshBasicMaterial({ color: 0xffc83a, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }));
      ring.rotation.x = Math.PI / 2; g.add(ring);
      g.visible = false; this.scene.add(g);
      this.marker = { g, arrow, ring, t: 0 };
    }
    const T = id ? this.tables.find((o) => o.id === id) : null, M = this.marker;
    M.table = T; M.t = 0; M.g.visible = !!T;
    if (T) { M.h = T.up ? 1.9 : T.z < LAYOUT.MZ + 1 ? 1.75 : 2.2; M.g.position.set(T.x, (T.y || 0) + 0.2, T.z); M.ring.scale.setScalar(T.up ? 1.05 : 1.12); M.arrow.position.y = M.h; } // (under the mezzanine: lower)
  }
  updateGuide(dt) {
    const M = this.marker;
    if (!M?.table) return;
    M.t += dt;
    if (M.t > 45) { this.guide(null); return; } // (it gives up after a while)
    M.arrow.position.y = M.h + Math.sin(M.t * 3) * 0.12;
    M.arrow.rotation.y += dt * 1.6;
    M.ring.material.opacity = 0.55 + 0.35 * Math.sin(M.t * 4);
  }

  // ------------------------------------------------------------------ the configurator (ui/carrental.js): your car, live
  /** Show cfg on that model's turntable (stopped), the camera on it for this step (interior: from the driver's seat). */
  configure(cfg, step) {
    const T = this.tables.find((o) => o.id === cfg.id);
    if (!T) return;
    this.cfgUp = !!T.up; // (upstairs: the camera stays up there)
    if (this.cfg && this.cfg.table !== T) this.restore(this.cfg.table);
    const prev = this.cfg;
    const want = step === 'interior' && FULL[cfg.id] ? 'full' : 'simple';
    // (a car of its own for the preview: wheels as their own parts, so the rims take their colour)
    if (!T.cfgInst || T.cfgKind !== want) {
      const t = want === 'full' && T.fullT ? T.fullT : T.t;
      if (want === 'full' && !T.fullT) {
        loadGLB(FULL[cfg.id]).then((g) => { if (!g) return; T.fullT = carTemplate(g, T.spec.length, FULL[cfg.id]); if (this.cfg?.table === T && this.cfg.step === 'interior') this.configure(this.cfg.cfg, 'interior'); }).catch(() => {});
      }
      const inst = carInstance(t, { wheels: true });
      inst.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      if (T.cfgInst) T.spin.remove(T.cfgInst.group); else T.spin.remove(T.inst.group);
      T.spin.add(inst.group);
      T.cfgInst = inst; T.cfgT = t; T.cfgKind = t === T.t ? 'simple' : 'full';
    }
    dressCar(T.cfgInst, T.cfgT, cfg);
    for (const g of T.cfgInst.glass) g.visible = step !== 'interior'; // (from inside: the cabin in clear view)
    const shot = SHOT[step];
    this.cfg = { table: T, cfg, step, yaw: shot ? shot[0] : prev?.yaw ?? 0.8, pitch: shot ? shot[1] : 0.2, dist: shot ? shot[2] : 5.5, look: 0, lookP: 0, snap: !prev };
  }
  /** Drag: turn round the car (or look round the cabin). */
  orbit(dx, dy) {
    const c = this.cfg;
    if (!c) return;
    if (c.step === 'interior') { c.look = Math.max(-1.2, Math.min(1.2, c.look - dx)); c.lookP = Math.max(-0.5, Math.min(0.4, c.lookP - dy)); }
    else { c.yaw -= dx; c.pitch = Math.max(0.02, Math.min(0.75, c.pitch + dy)); c.dragged = true; }
  }
  restore(T) {
    if (!T?.cfgInst) return;
    T.spin.remove(T.cfgInst.group); T.spin.add(T.inst.group);
    T.cfgInst = null; T.cfgKind = null;
  }
  endConfigure() {
    if (!this.cfg) return;
    this.restore(this.cfg.table);
    this.cfg = null;
    this.camera.clearViewOffset();
  }
  // the configurator's camera: round the stopped turntable, or in the driver's seat; the car framed right of the panel
  cfgCamera(dt) {
    const c = this.cfg, T = c.table, cam = this.camera;
    const W = innerWidth, H = innerHeight;
    cam.setViewOffset(W, H, -W * 0.2, 0, W, H);
    const pos = _v, look = new THREE.Vector3();
    T.spin.updateMatrixWorld(true);
    const heading = T.spin.rotation.y;
    if (c.step === 'interior') {
      const t = T.cfgT, eye = driverEye(t);
      eye.y += 0.04; eye.z -= 0.05;
      pos.copy(eye); T.spin.localToWorld(pos);
      const a = c.look, p = -0.22 + c.lookP;
      look.set(eye.x + Math.sin(a) * Math.cos(p), eye.y + Math.sin(p), eye.z + Math.cos(a) * Math.cos(p)); T.spin.localToWorld(look);
      cam.fov = 72;
    } else {
      if (!c.dragged) c.yaw += dt * 0.06; // (a slow drift round it)
      const a = heading + c.yaw;
      const y0 = T.y || 0; // (upstairs: from the mezzanine's floor)
      pos.set(T.x + Math.sin(a) * c.dist * Math.cos(c.pitch), y0 + (T.up ? 0 : 0.16) + 0.7 + Math.sin(c.pitch) * c.dist, T.z + Math.cos(a) * c.dist * Math.cos(c.pitch));
      pos.x = Math.max(-ROOM.W / 2 + 0.4, Math.min(ROOM.W / 2 - 0.4, pos.x)); pos.z = Math.max(-ROOM.D / 2 + 0.4, Math.min(ROOM.D / 2 - 0.4, pos.z));
      if (T.up) pos.y = Math.max(y0 + 0.4, Math.min(pos.y, ceilingAt(pos.x) - 0.5)); // (under the roof)
      else if (pos.z < LAYOUT.MZ + 0.3) pos.y = Math.min(pos.y, LAYOUT.FL - 0.5); // (under the mezzanine: below its floor)
      look.set(T.x, y0 + (c.step === 'rims' ? 0.5 : 0.75), T.z);
      cam.fov = 45;
    }
    // (eased there; at once the first time and between inside / outside)
    const inside = c.step === 'interior';
    if (c.snap || c.wasInside !== inside) { cam.position.copy(pos); c.at = look.clone(); c.snap = false; }
    else { const k = 1 - Math.exp(-dt * 5); cam.position.lerp(pos, k); c.at.lerp(look, k); }
    c.wasInside = inside;
    cam.lookAt(c.at);
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ walking: the ground floor, the stair, the mezzanine
  walk(dt) {
    const p = this.pos, S = LAYOUT.stair, W2 = ROOM.W / 2, D2 = ROOM.D / 2, MZ = LAYOUT.MZ, pz = p.z, R0 = 0.3;
    p.addScaledVector(this.vel, dt);
    const push = (list) => { for (const o of list) { const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), rr = o.r + R0; if (d < rr && d > 1e-4) { p.x = o.x + (dx / d) * rr; p.z = o.z + (dz / d) * rr; } } };
    if (this.level === 'ground') {
      push(this.obstacles);
      // the stair's block: in at its foot (from the front, between the wall and the rail), else kept out
      const inX = p.x < S.x1 + R0, inZ = p.z < S.z1 && p.z > S.z0 - R0;
      if (inX && inZ) {
        if (pz >= S.z1 - 0.02 && p.x < S.x1 - 0.2) { this.level = 'stair'; }
        else if (pz >= S.z1) p.z = S.z1;
        else if (pz <= S.z0 - R0) p.z = S.z0 - R0;
        else p.x = S.x1 + R0;
      }
    }
    if (this.level === 'stair') {
      p.x = Math.max(S.x0 + R0, Math.min(S.x1 - R0, p.x));
      if (p.z > S.z1) this.level = 'ground';
      else if (p.z < S.z0) this.level = 'up';
    }
    if (this.level === 'up') {
      push(this.obstaclesUp);
      if (p.z > MZ - R0 && p.x >= S.x1 - 0.2) p.z = MZ - R0; // (the balustrade)
      else if (p.z > MZ) this.level = 'stair'; // (down the stair, at its head)
    }
    p.x = Math.max(-W2 + 0.45, Math.min(W2 - 0.45, p.x));
    p.z = Math.max(-D2 + 0.45, Math.min(D2 - 0.45, p.z));
    p.y = this.level === 'up' ? LAYOUT.FL : this.level === 'stair' ? stairY(p.z) : 0;
  }

  // ------------------------------------------------------------------ per frame
  enter() {
    this.active = true;
    this.pos.set(DOOR.x, 0, ROOM.D / 2 - 1.3); this.level = 'ground'; this.eyeY = EYE; this.doorT = 1;
    this.yaw = Math.PI - 0.15; this.pitch = -0.06; this.vel.set(0, 0, 0);
  }

  /** Walk / look (input null: a panel is open); returns what the crosshair is on: { kind, id, paint, label } or null. */
  update(dt, input, sensitivity = 1, talking = false) {
    for (const t of this.tables) if (this.cfg?.table !== t) t.spin.rotation.y += t.speed * dt;
    this.updateGuide(dt);
    if (this.cfg) { this.cfgCamera(dt); this.renderPortal(); return null; } // (configuring: the camera is on your car)
    if (this.camera.fov !== 70) { this.camera.fov = 70; this.camera.updateProjectionMatrix(); }
    // the clerk: idle behind the desk, turning to you when you come close or while you talk
    if (this.clerk) {
      const c = this.clerk.root.position, near = talking || Math.hypot(this.pos.x - c.x, this.pos.z - c.z) < 6;
      const want = near ? Math.atan2(this.pos.x - c.x, this.pos.z - c.z) : this.deskYaw;
      this.clerkYaw += Math.atan2(Math.sin(want - this.clerkYaw), Math.cos(want - this.clerkYaw)) * (1 - Math.exp(-dt * 4));
      this.clerk.update(dt, { mode: 'idle', heading: this.clerkYaw, speed: 0, crouch: 0, lean: 0, plow: 0, normal: UP });
    }
    if (input) {
      const sens = 0.0022 * sensitivity;
      this.yaw -= input.mdx * sens;
      this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - input.mdy * sens));
      const fw = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0), st = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
      const f = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), want = new THREE.Vector3(-f.z * st + f.x * fw, 0, f.x * st + f.z * fw);
      if (want.lengthSq()) want.normalize().multiplyScalar(2.4);
      this.vel.lerp(want, 1 - Math.exp(-dt * 10));
    } else this.vel.multiplyScalar(Math.exp(-dt * 10));
    this.walk(dt);
    // the sliding doors: open as you come near them (and on the way in)
    const nearDoor = this.level === 'ground' && Math.abs(this.pos.x - DOOR.x) < 2.6 && this.pos.z > ROOM.D / 2 - 3.2;
    this.doorT += ((nearDoor ? 1 : 0) - this.doorT) * (1 - Math.exp(-dt * 5));
    setDoors(this.doors, this.doorT * this.doorT * (3 - 2 * this.doorT));
    this.eyeY += (this.pos.y + EYE - this.eyeY) * (1 - Math.exp(-dt * 14));
    this.camera.position.set(this.pos.x, this.eyeY, this.pos.z);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(_v.copy(this.camera.position).add(dir));
    this.renderPortal();
    if (!input) return null;
    const hits = new THREE.Raycaster(this.camera.position, dir, 0, 7).intersectObjects(this.aimables, false);
    const u = hits[0]?.object.userData;
    if (!u?.kind || (u.up && this.level !== 'up')) return null; // (the cars upstairs: from up there)
    if (u.kind === 'door') return { kind: 'door', label: 'Leave Car Rental' };
    if (u.kind === 'clerk') return { kind: 'clerk', label: 'Talk to the rental clerk' };
    return { kind: 'car', id: u.id, paint: u.paint, label: `Rent ${u.label}` };
  }
}
