// First-time intro: a ~26 s cinematic before your very first free ride. A green summer valley far below the
// resort (no snow there, only on the far peaks): you wait at a wooden bus shelter by a country road, the yellow
// ski bus pulls in, opens its doors, you walk over (skis on your back) and board, the doors close and the bus
// drives off up the valley. The branded card ("LEGACY VILLAGE") covers the trip, then you step out of the real
// ski bus at the Legacy Village stop into the waiting area and the free ride starts.
//
//   main.js startFromMenu: if (wantsBusIntro(save)) runBusIntro(ctx) else startGame()
//
// The valley is its own THREE.Scene (rendered through the game's post chain with post.setView, as the shop
// interior is) and is disposed once the card covers the screen. Everything in it is procedural (terrain, road,
// trees, grass, the farmhouse, the shelter, fences, rocks) apart from the Meshy bus, stop sign and your skier.
// Skippable with Esc / Enter / Space (the valley goes straight to the card; the arrival straight to free ride).
// Real time only (never slowed by the presentation time scale). save.introBus marks it as seen.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Simplex, mulberry32, smoothstep, clamp, lerp } from '../../core/noise.js';
import { fitModel } from '../../core/assets.js';
import { world } from '../../world/world.js';
import { buildBus, BUS } from '../bus/bus.js';
import { busRoads, stopWaitArea } from '../bus/roads.js';
import { applyOutfit, getEquipped } from '../outfits.js';
import { presentationUI } from '../../ui/presentation.js';
import { applyCamera, ease, lockRig, unlockRig, poseRig, showRig } from './cinecam.js';

const Q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

/** Play it? A brand-new save only (?busintro forces it, ?nobusintro never). Old saves without the flag that
 *  already played count as seen. */
export function wantsBusIntro(save) {
  if (Q.has('nobusintro')) return false;
  if (Q.has('busintro')) return true;
  if (save.introBus) return false;
  const st = save.stats || {};
  const played = (st.distance || 0) > 1 || (st.races || 0) > 0 || (st.earned || 0) > 0 || !!save.skis || (save.owned || []).length > 0;
  if (played) { save.introBus = true; return false; }
  return true;
}

// ------------------------------------------------------------------ the valley's shape
const N = new Simplex(4127);
const RX = (z) => 22 * (Math.sin((z + 60) / 260) - Math.sin(60 / 260)); // road centre line x(z): a lazy S
const RXd = (z) => (22 / 260) * Math.cos((z + 60) / 260);
const BASE = (z) => 0.02 * z;                                          // the valley floor rises 2 % up the valley
const FARM = { x: 34, z: 26 }, SHED = { x: -7.6, z: 0 };               // farmhouse (across the road), shelter
function H(x, z) {
  const d = Math.abs(x - RX(z));
  let h = BASE(z);
  // meadows: gentle swells away from the road, flat round the farm
  const farm = smoothstep(16, 34, Math.hypot(x - FARM.x, z - FARM.z));
  h += (1.4 * N.fbm(x / 70, z / 70, 3) + 0.5) * smoothstep(9, 40, d) * farm;
  // the valley sides: forest slopes, then rock (a ridge noise breaks the skyline)
  const W = 260 + 90 * N.noise(z / 600, 3.1);
  const u = Math.max(0, d - W);
  const rid = 1 - Math.abs(N.fbm(x / 900, z / 900, 4));
  const ramp = smoothstep(0, 2600, u);
  h += 1700 * Math.pow(ramp, 1.25) * (0.6 + 0.5 * rid) + 160 * smoothstep(0, 900, u) + 90 * N.fbm(x / 260, z / 260, 3) * smoothstep(0, 400, u);
  // the valley head (snow-capped) and the hills closing it behind
  h += 1900 * smoothstep(1500, 3800, z) * (0.7 + 0.35 * rid) + 650 * smoothstep(-700, -2600, z) * (0.7 + 0.3 * rid);
  return h;
}
const _gn = new THREE.Vector3();
function normalAt(x, z, out = _gn) {
  const e = 2;
  return out.set(H(x - e, z) - H(x + e, z), 2 * e, H(x, z - e) - H(x, z + e)).normalize();
}

// ------------------------------------------------------------------ timeline (s)
const T = { busIn: 2, busStop: 11, doorsOpen: 11.3, walk0: 12.1, step: 15.0, gone: 15.9, doorsShut: 16.4, depart: 17.4, end: 26.5 };
const SHOTS = [6, 12, 17.2, T.end]; // shot ends: A establishing, B arrival, C boarding, D departure
const ZSTOP = 0;                    // bus centre at the stop
const DOOR_Z = BUS.len / 2 - 2.0;   // front door (bus local z), on the bus's right (-x)
const LANE = BUS.lane;

function canvasTex(w, h, draw, rep = null) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
  return t;
}

/** Sliding plug doors laid over the coach's painted ones (the Meshy shell is one solid mesh): two glazed leaves
 *  per door that push out and slide apart, a dark doorway with a lit step behind. set(k): 0 shut .. 1 open. */
export function attachBusDoors(group, shell) {
  // the shell's right flank at door height (measured: mirrors and bumpers stick out further)
  let side = BUS.width / 2;
  try {
    const v = new THREE.Vector3();
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    let minX = 0;
    shell.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position, m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      for (let i = 0; i < p.count; i += 7) {
        v.fromBufferAttribute(p, i).applyMatrix4(m);
        if (v.y > 1.2 && v.y < 2.2 && Math.abs(v.z - DOOR_Z) < 1.6 && v.x < minX) minX = v.x;
      }
    });
    if (minX < -0.8) side = -minX;
  } catch (e) { /* the nominal width */ }
  const g = new THREE.Group(); g.name = 'bus-doors';
  const frame = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.45, metalness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.08, metalness: 0.6, envMapIntensity: 1.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.9 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffe2a8, emissiveIntensity: 1.6 });
  const leaves = [];
  const W = 0.62, H0 = 0.32, H1 = 2.62;
  for (const zc of [DOOR_Z, -0.45]) {
    const hole = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, H1 - H0), dark);
    hole.rotation.y = -Math.PI / 2; hole.position.set(-side - 0.012, (H0 + H1) / 2, zc);
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, W * 2 - 0.1), lamp);
    step.position.set(-side - 0.02, H0 + 0.05, zc);
    g.add(hole, step);
    for (const sz of [-1, 1]) {
      const leaf = new THREE.Group();
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.05, H1 - H0, W), frame);
      const gl = new THREE.Mesh(new THREE.BoxGeometry(0.02, H1 - H0 - 0.22, W - 0.12), glass);
      gl.position.x = -0.02; gl.position.y = 0.04;
      leaf.add(f, gl);
      leaf.position.set(-side - 0.035, (H0 + H1) / 2, zc + sz * W / 2);
      leaf.userData = { z0: zc + sz * W / 2, sz };
      g.add(leaf); leaves.push(leaf);
    }
    hole.visible = false; hole.userData.hole = true;
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(g);
  const api = {
    group: g, side, k: 0,
    set(k) {
      api.k = k;
      const out = smoothstep(0, 0.35, k), slide = smoothstep(0.25, 1, k);
      for (const l of leaves) { l.position.x = -side - 0.035 - out * 0.12; l.position.z = l.userData.z0 + l.userData.sz * slide * (W - 0.14); }
      g.traverse((o) => { if (o.userData.hole) o.visible = k > 0.02; });
    },
    dispose() { group.remove(g); g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); [frame, glass, dark, lamp].forEach((m) => m.dispose()); },
  };
  api.set(0);
  return api;
}

// ground override while a rig is posed in the valley (the rig's foot IK asks world.groundHeight)
function withGround(y, fn) {
  const own = Object.prototype.hasOwnProperty.call(world, 'groundHeight'), g0 = world.groundHeight;
  world.groundHeight = () => y;
  try { fn(); } finally { if (own) world.groundHeight = g0; else delete world.groundHeight; }
}

// ------------------------------------------------------------------ the valley scene
export class BusIntro {
  /**
   * @param {object} o  { renderer, models, makeRig, save, audio, onDone }
   */
  constructor(o) {
    Object.assign(this, o);
    this.t = 0; this.done = false; this.shot = -1;
    this.own = []; // geometries / materials / textures this scene made (the Meshy models' own are shared)
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 14000);
    this.build();
    this.onKey = (e) => { if (['Escape', 'Enter', 'Space', 'NumpadEnter'].includes(e.code)) { e.preventDefault(); e.stopPropagation(); this.skip(); } };
    addEventListener('keydown', this.onKey, true);
    this.onResize = () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); };
    addEventListener('resize', this.onResize);
    presentationUI.cinematic(true);
    presentationUI.skipHint('SKIP');
    this.sound = new IntroSound(this.audio);
  }

  keep(x) { this.own.push(x); return x; }
  mat(o) { return this.keep(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o })); }

  build() {
    const sc = this.scene;
    // warm late-afternoon light, soft valley haze (fog.js height fog: near = density, far = falloff 1/m)
    this.sunDir = new THREE.Vector3(-0.55, 0.42, 0.72).normalize();
    sc.fog = new THREE.Fog(0xcfd9e2, 0.00011, 0.00055);
    sc.background = new THREE.Color(0x9fc0e0);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
    sc.environment = this.envTex; sc.environmentIntensity = 0.35;
    sc.add(new THREE.HemisphereLight(0xbcd6f2, 0x4d5a2c, 1.15));
    const sun = (this.sun = new THREE.DirectionalLight(0xffe6c4, 3.4));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera; c.left = -34; c.right = 34; c.top = 34; c.bottom = -34; c.near = 1; c.far = 260;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    sc.add(sun, sun.target);
    this.aimSun(0, 0);
    this.buildSky();
    this.buildTerrain();
    this.buildRoad();
    this.buildTrees();
    this.buildGrass();
    this.buildRocksAndFences();
    this.buildFarm();
    this.buildShelter();
    this.buildBus();
    this.buildSkier();
  }

  aimSun(x, z) { // the shadow box follows the action
    this.sun.target.position.set(x, BASE(z), z);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 140);
  }

  buildSky() {
    const m = this.keep(new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: this.sunDir } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }',
      fragmentShader: `uniform vec3 uSun; varying vec3 vD;
        void main(){
          float h = max(vD.y, 0.0), s = max(dot(normalize(vD), uSun), 0.0);
          vec3 zen = vec3(0.16, 0.36, 0.78), hor = vec3(1.05, 0.92, 0.78);
          vec3 c = mix(hor, zen, pow(h, 0.45));
          c += vec3(1.0, 0.72, 0.42) * (pow(s, 6.0) * 0.55 + pow(s, 64.0) * 1.2) + vec3(40.0, 32.0, 22.0) * smoothstep(0.9993, 0.9997, s);
          c = mix(c, vec3(0.72, 0.74, 0.70), smoothstep(0.0, -0.2, vD.y));
          gl_FragColor = vec4(c * 1.15, 1.0);
        }`,
    }));
    const sky = new THREE.Mesh(this.keep(new THREE.SphereGeometry(12000, 32, 16)), m);
    sky.frustumCulled = false; sky.renderOrder = -1;
    this.scene.add(sky);
  }

  buildTerrain() {
    // one grid, finer near the stop: x = f(u) over [-1, 1] (cells ~3 m at the road, ~60 m at the far ridges)
    const NX = 400, NZ = 400;
    const fx = (u) => Math.sign(u) * (Math.abs(u) * 0.12 + Math.pow(Math.abs(u), 2.3) * 0.88) * 4200;
    const fz = (u) => (u < 0 ? -1 : 1) * (Math.abs(u) * 0.12 + Math.pow(Math.abs(u), 2.3) * 0.88) * (u < 0 ? 3200 : 5200);
    const pos = new Float32Array((NX + 1) * (NZ + 1) * 3), col = new Float32Array(pos.length), uv = new Float32Array((NX + 1) * (NZ + 1) * 2);
    const grass = new THREE.Color(0x5d8a2e), grass2 = new THREE.Color(0x8aa63e), forest = new THREE.Color(0x2f4a1f), rock = new THREE.Color(0x77736c), rock2 = new THREE.Color(0x5b5852), snow = new THREE.Color(0xf4f6fa), cc = new THREE.Color(), n = new THREE.Vector3();
    let k = 0;
    for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++, k++) {
      const z = fz(j / NZ * 2 - 1), xr = fx(i / NX * 2 - 1), x = xr + RX(z) * (1 - smoothstep(400, 1500, Math.abs(xr)));
      const y = H(x, z);
      pos.set([x, y, z], k * 3); uv.set([x / 9, z / 9], k * 2);
      normalAt(x, z, n);
      const d = Math.abs(x - RX(z)), slope = 1 - n.y, rel = y - BASE(z);
      const m1 = N.noise(x / 40, z / 40) * 0.5 + 0.5, m2 = N.noise(x / 300 + 7, z / 300) * 0.5 + 0.5;
      cc.copy(grass).lerp(grass2, m1 * 0.6 * (1 - smoothstep(30, 200, rel)));
      cc.lerp(forest, smoothstep(20, 90, rel) * (1 - smoothstep(480, 700, rel + m2 * 160)) * 0.8);
      cc.lerp(m2 > 0.5 ? rock : rock2, clamp(smoothstep(620, 900, rel + m2 * 200) + smoothstep(0.32, 0.6, slope) * smoothstep(80, 260, rel), 0, 1));
      cc.lerp(snow, smoothstep(1350, 1600, y + m1 * 160) * smoothstep(0.42, 0.25, slope));
      if (d < 5.5) cc.multiplyScalar(0.82); // the verge, worn
      col.set([cc.r, cc.g, cc.b], k * 3);
    }
    const idx = [];
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = this.keep(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    // detail: a near-white mottled tile (the colour comes from the vertices)
    const r = mulberry32(9);
    const map = this.keep(canvasTex(512, 512, (x, w, h) => {
      x.fillStyle = '#e6e6e6'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const v = 170 + r() * 85 | 0; x.fillStyle = `rgba(${v},${v},${v * 0.92 | 0},0.5)`; x.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 5); }
    }, [1, 1]));
    const t = new THREE.Mesh(g, this.mat({ vertexColors: true, map, roughness: 0.95 }));
    t.receiveShadow = true;
    this.scene.add(t);
  }

  buildRoad() {
    // a ribbon along the centre line: tarmac, white edge lines, dashed centre (texture runs along v)
    const tex = this.keep(canvasTex(256, 512, (x, w, h) => {
      x.fillStyle = '#4a4b4d'; x.fillRect(0, 0, w, h);
      const r = mulberry32(3);
      for (let i = 0; i < 5000; i++) { const v = 50 + r() * 60 | 0; x.fillStyle = `rgba(${v},${v},${v + 2},0.6)`; x.fillRect(r() * w, r() * h, 1.5, 1.5); }
      x.fillStyle = '#e8e6df'; x.fillRect(10, 0, 7, h); x.fillRect(w - 17, 0, 7, h);
      x.fillRect(w / 2 - 3, 0, 6, h * 0.45);
    }));
    tex.wrapT = THREE.RepeatWrapping;
    const pos = [], uv = [], idx = [], HW = 3.6;
    let v = 0, n = 0;
    for (let z = -900; z <= 1400; z += 3, n++) {
      const x = RX(z), dx = RXd(z), l = Math.hypot(dx, 1), nx = 1 / l, nz = -dx / l;
      if (n) v += 3 / 12;
      for (const s of [-1, 1]) { pos.push(x + nx * HW * s, BASE(z) + 0.04, z + nz * HW * s); uv.push(s < 0 ? 0 : 1, v); }
      if (n) { const a = (n - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = this.keep(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const road = new THREE.Mesh(g, this.mat({ map: tex, roughness: 0.82 }));
    road.receiveShadow = true;
    this.scene.add(road);
    // the bus bay: a gravel apron on the stop's side
    const bay = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(5, 22)), this.mat({ color: 0x8d877a, roughness: 1 }));
    bay.rotation.x = -Math.PI / 2; bay.position.set(RX(0) - 6.2, 0.03, 0); bay.rotation.z = Math.atan(RXd(0));
    bay.receiveShadow = true;
    this.scene.add(bay);
  }

  buildTrees() {
    const r = mulberry32(77);
    // broadleaf: trunk + a lumpy crown of displaced blobs (vertex colours: darker inside, sunlit top)
    const crown = (seed) => {
      const rr = mulberry32(seed), parts = [];
      const trunk = new THREE.CylinderGeometry(0.16, 0.26, 3.2, 7).translate(0, 1.6, 0).toNonIndexed();
      paint(trunk, 0x5b4632, 0);
      parts.push(trunk);
      for (let i = 0; i < 6; i++) {
        const b = new THREE.IcosahedronGeometry(1.5 + rr() * 0.9, 2).toNonIndexed();
        const p = b.attributes.position, s = 0.8 + rr() * 0.2;
        for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k), z = p.getZ(k); const f = 1 + 0.16 * N.noise(x * 1.7 + seed, z * 1.7 + y); p.setXYZ(k, x * f, y * f * s, z * f); }
        b.translate((rr() - 0.5) * 2.4, 4.4 + rr() * 2.4, (rr() - 0.5) * 2.4);
        paint(b, 0x4f7a26, 1);
        parts.push(b);
      }
      const g = mergeGeometries(parts); g.computeVertexNormals();
      return this.keep(g);
    };
    function paint(g, hex, leafy) {
      const c = new THREE.Color(hex), p = g.attributes.position, a = new Float32Array(p.count * 3), t = new THREE.Color();
      for (let k = 0; k < p.count; k++) { t.copy(c); if (leafy) t.multiplyScalar(0.72 + 0.5 * smoothstep(3.5, 7.5, p.getY(k)) + 0.12 * N.noise(p.getX(k) * 2, p.getZ(k) * 2)); a.set([t.r, t.g, t.b], k * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    // conifer (summer: no snow): trunk + stacked drooping cones
    const fir = (() => {
      const parts = [new THREE.CylinderGeometry(0.12, 0.22, 2.5, 6).translate(0, 1.25, 0).toNonIndexed()];
      paint(parts[0], 0x4a3826, 0);
      for (let i = 0; i < 5; i++) {
        const R = 2.3 - i * 0.4, h = 2.6 - i * 0.25;
        const c = new THREE.ConeGeometry(R, h, 9, 1, true).translate(0, 1.6 + i * 1.45 + h / 2, 0).toNonIndexed();
        paint(c, 0x2c4a22, 0);
        parts.push(c);
      }
      const g = mergeGeometries(parts); g.computeVertexNormals();
      return this.keep(g);
    })();
    const leafMat = this.mat({ vertexColors: true, roughness: 0.9 });
    const placeNear = [], placeFar = [];
    const ok = (x, z) => Math.abs(x - RX(z)) > 9 && Math.hypot(x - FARM.x, z - FARM.z) > 20 && Math.hypot(x - SHED.x, z - SHED.z) > 9;
    // groves and single trees in the meadows round the stop
    for (let i = 0; i < 260; i++) {
      const z = -320 + r() * 900, x = RX(z) + (r() < 0.5 ? -1 : 1) * (12 + Math.pow(r(), 1.4) * 150);
      if (ok(x, z)) placeNear.push([x, z, 0.75 + r() * 0.55, r() * 6.28]);
    }
    // the forest on the lower slopes (thinning out where the rock starts)
    for (let i = 0; i < 14000 && placeFar.length < 3800; i++) {
      const z = -1500 + r() * 3600, x = RX(z) + (r() < 0.5 ? -1 : 1) * (200 + r() * 1300);
      const y = H(x, z), rel = y - BASE(z);
      if (rel < 10 || rel > 560 + 120 * N.noise(x / 200, z / 200) || normalAt(x, z).y < 0.7) continue;
      if (N.noise(x / 180, z / 180) < -0.25) continue; // clearings
      placeFar.push([x, z, 0.9 + r() * 0.8, r() * 6.28]);
    }
    const inst = (geo, list, cast, tint) => {
      const m = new THREE.InstancedMesh(geo, leafMat, list.length), M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
      list.forEach(([x, z, k, a], i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a); s.set(k, k * (0.9 + (i % 7) * 0.04), k); p.set(x, H(x, z) - (Math.abs(x - RX(z)) > 200 ? 0.8 : 0.15), z);
        m.setMatrixAt(i, M.compose(p, q, s));
        c.setHSL(tint[0] + ((i * 37) % 11) / 300, tint[1], tint[2] + ((i * 53) % 13) / 120); m.setColorAt(i, c);
      });
      m.castShadow = cast; m.receiveShadow = true;
      this.scene.add(m);
    };
    const broad = [crown(11), crown(23), crown(41)];
    broad.forEach((g, k) => inst(g, placeNear.filter((_, i) => i % 4 === k), true, [0.0, 0, 0.92]));
    inst(fir, placeNear.filter((_, i) => i % 4 === 3), true, [0, 0, 0.9]);
    inst(fir, placeFar.filter((_, i) => i % 3), false, [0, 0, 0.82]);
    inst(broad[1], placeFar.filter((_, i) => !(i % 3)), false, [0, 0, 0.8]);
  }

  buildGrass() {
    // tufts of three crossed blades, swaying in the breeze; wild flowers among them
    const blade = (a) => {
      const g = new THREE.BufferGeometry(), b = 0.022, tip = 0.02 * Math.sin(a * 3);
      g.setAttribute('position', new THREE.Float32BufferAttribute([-b, 0, 0, b, 0, 0, -b * 0.6, 0.25, 0.01, b * 0.6, 0.25, 0.01, tip, 0.5, 0.05], 3));
      g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]); g.computeVertexNormals();
      return g.rotateY(a);
    };
    const parts = [0, 1.05, 2.1, 0.5, 2.6].map((a) => { const b = blade(a); b.translate(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05); return b; });
    const geo = this.keep(mergeGeometries(parts));
    const p = geo.attributes.position, col = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) { const t = p.getY(k) / 0.5; col.set([0.22 + 0.35 * t, 0.36 + 0.3 * t, 0.1 + 0.08 * t], k * 3); }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = this.mat({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
    this.wind = { value: 0 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = this.wind;
      sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 wp = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
          float sw = sin(uWind * 1.7 + wp.x * 0.35 + wp.y * 0.21) * 0.6 + sin(uWind * 3.1 + wp.x * 0.9) * 0.25;
          transformed.x += sw * 0.09 * position.y * position.y * 4.0;
          transformed.z += sw * 0.05 * position.y * position.y * 4.0;
        #endif`);
    };
    const r = mulberry32(5), list = [];
    for (let i = 0; i < 90000 && list.length < 34000; i++) {
      // dense near the shelter and along the stretch the cameras see
      const z = -70 + Math.pow(r(), 1.2) * 150 * (r() < 0.5 ? -0.6 : 1), x = RX(z) + (r() < 0.55 ? -1 : 1) * (4.4 + Math.pow(r(), 1.6) * 55);
      if (Math.abs(x - RX(z)) < 4.4 || Math.abs(x - (RX(0) - 6.2)) < 2.8 && Math.abs(z) < 11) continue;
      if (Math.hypot(x - SHED.x, z - SHED.z) < 2.6) continue;
      list.push([x, z]);
    }
    const m = new THREE.InstancedMesh(geo, mat, list.length), M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color();
    list.forEach(([x, z], i) => {
      const k = 0.7 + r() * 0.9;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28); s.set(k, k * (0.7 + r() * 0.7), k);
      m.setMatrixAt(i, M.compose(v.set(x, H(x, z) - 0.02, z), q, s));
      c.setRGB(0.85 + r() * 0.3, 0.9 + r() * 0.25, 0.75 + r() * 0.2); m.setColorAt(i, c);
    });
    m.receiveShadow = true; m.frustumCulled = false;
    this.scene.add(m);
    // flowers: tiny heads in white, yellow, violet
    const fl = new THREE.InstancedMesh(this.keep(new THREE.OctahedronGeometry(0.05, 0)), this.mat({ roughness: 0.6 }), 2600);
    const pal = [0xffffff, 0xf7d23e, 0xb68ce0, 0xf2f0e8, 0xe8553f];
    for (let i = 0; i < 2600; i++) {
      const [x, z] = list[(r() * list.length) | 0];
      const ox = x + (r() - 0.5) * 0.6, oz = z + (r() - 0.5) * 0.6;
      fl.setMatrixAt(i, M.compose(v.set(ox, H(ox, oz) + 0.3 + r() * 0.25, oz), q.identity(), s.setScalar(0.7 + r() * 0.8)));
      fl.setColorAt(i, c.setHex(pal[(r() * pal.length) | 0]));
    }
    this.scene.add(fl);
  }

  buildRocksAndFences() {
    const r = mulberry32(31);
    const rg = mergeVertices(new THREE.IcosahedronGeometry(1, 4).deleteAttribute('normal').deleteAttribute('uv'));
    const p = rg.attributes.position;
    for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k), z = p.getZ(k), f = 1 + 0.28 * N.fbm(x * 1.3 + 9, z * 1.3 + y, 3); p.setXYZ(k, x * f, y * f * 0.62, z * f); }
    rg.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(this.keep(rg), this.mat({ color: 0x8b877f, roughness: 0.95 }), 70);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color();
    for (let i = 0; i < 70; i++) {
      let x, z;
      do { z = -200 + r() * 500; x = RX(z) + (r() < 0.5 ? -1 : 1) * (8 + r() * 110); } while (Math.hypot(x - FARM.x, z - FARM.z) < 22 || Math.hypot(x - SHED.x, z - SHED.z) < 7);
      const k = i < 6 ? 1.4 + r() * 1.2 : 0.3 + r() * 0.9;
      q.setFromEuler(new THREE.Euler(r() * 0.4, r() * 6.28, r() * 0.4));
      rocks.setMatrixAt(i, M.compose(v.set(x, H(x, z) + k * 0.12, z), q, s.set(k, k, k * (0.8 + r() * 0.4))));
      rocks.setColorAt(i, c.setHSL(0.1, 0.05, 0.42 + r() * 0.18));
    }
    rocks.castShadow = rocks.receiveShadow = true;
    // two big boulders by the shelter (foreground for the low shot)
    for (const [x, z, k] of [[-11.5, -9, 1.1], [-14, 6, 0.8]]) {
      const b = new THREE.Mesh(rocks.geometry, rocks.material);
      b.position.set(x, H(x, z) + 0.1, z); b.scale.set(k * 1.3, k, k); b.rotation.y = x;
      b.castShadow = b.receiveShadow = true; this.scene.add(b);
    }
    this.scene.add(rocks);
    // split-rail fences: along the road on the farm side, round the farm's pasture, behind the shelter
    const wood = this.mat({ color: 0x7a5f45, roughness: 0.9 });
    const post = this.keep(new THREE.BoxGeometry(0.13, 1.25, 0.13).translate(0, 0.62, 0)), rail = this.keep(new THREE.BoxGeometry(0.07, 0.11, 1));
    const posts = [], rails = [];
    const run = (pts) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 2.6));
        for (let k = 0; k <= n; k++) {
          const u = k / n, x = lerp(x0, x1, u), z = lerp(z0, z1, u);
          if (k < n || i === pts.length - 2) posts.push([x, H(x, z), z]);
          if (k < n) {
            const u2 = (k + 1) / n, xb = lerp(x0, x1, u2), zb = lerp(z0, z1, u2), ya = H(x, z), yb = H(xb, zb);
            for (const hh of [0.5, 1.0]) rails.push([(x + xb) / 2, (ya + yb) / 2 + hh, (z + zb) / 2, Math.atan2(xb - x, zb - z), Math.hypot(xb - x, zb - z), Math.atan2(yb - ya, Math.hypot(xb - x, zb - z))]);
          }
        }
      }
    };
    const side = [];
    for (let z = -150; z <= 260; z += 10) side.push([RX(z) + 6.5, z]);
    run(side.filter(([, z]) => z < 14 || z > 38));
    run([[FARM.x + 16, 10], [FARM.x + 60, 4], [FARM.x + 70, 70], [FARM.x - 4, 76], [RX(76) + 6.5, 76]]);
    run([[-13, -14], [-15, 20], [-40, 60]]);
    const pm = new THREE.InstancedMesh(post, wood, posts.length), rm = new THREE.InstancedMesh(rail, wood, rails.length);
    posts.forEach(([x, y, z], i) => pm.setMatrixAt(i, M.compose(v.set(x, y - 0.05, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.7), s.set(1, 0.9 + (i % 5) * 0.04, 1))));
    rails.forEach(([x, y, z, yaw, L, pitch], i) => rm.setMatrixAt(i, M.compose(v.set(x, y, z), q.setFromEuler(new THREE.Euler(-pitch, yaw, 0, 'YXZ')), s.set(1, 1, L + 0.2))));
    pm.castShadow = rm.castShadow = pm.receiveShadow = rm.receiveShadow = true;
    this.scene.add(pm, rm);
  }

  // a traditional farmhouse: white rendered stone below, dark timber above with a geranium balcony, a wide low
  // slate roof with deep eaves; a barn beside it and a woodpile
  buildFarm() {
    const g = new THREE.Group(), r = mulberry32(12);
    const plaster = this.keep(canvasTex(512, 256, (x, w, h) => {
      x.fillStyle = '#ece6d8'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 4000; i++) { const v = 205 + r() * 40 | 0; x.fillStyle = `rgba(${v},${v - 4},${v - 14},0.35)`; x.fillRect(r() * w, r() * h, 2 + r() * 4, 2 + r() * 4); }
      const gr = x.createLinearGradient(0, h * 0.8, 0, h); gr.addColorStop(0, 'rgba(90,80,60,0)'); gr.addColorStop(1, 'rgba(90,80,60,0.35)'); x.fillStyle = gr; x.fillRect(0, 0, w, h);
    }, [2, 1]));
    const boards = (base, n = 16) => this.keep(canvasTex(512, 512, (x, w, h) => {
      for (let i = 0; i < n; i++) { const v = (r() - 0.5) * 18; x.fillStyle = `rgb(${base[0] + v},${base[1] + v * 0.8},${base[2] + v * 0.6})`; x.fillRect(0, i * h / n, w, h / n - 2); x.fillStyle = 'rgba(20,10,4,0.55)'; x.fillRect(0, (i + 1) * h / n - 2, w, 2); }
      for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(30,16,6,${0.05 + r() * 0.08})`; x.fillRect(r() * w, r() * h, 20 + r() * 80, 1); }
    }, [2, 1]));
    const slate = this.keep(canvasTex(512, 512, (x, w, h) => {
      x.fillStyle = '#4b4e53'; x.fillRect(0, 0, w, h);
      for (let row = 0; row < 16; row++) for (let i = 0; i < 9; i++) {
        const v = 62 + r() * 30 | 0; x.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
        x.fillRect(i * 58 + (row % 2) * 29 - 2, row * 32, 54, 30);
      }
    }, [5, 3]));
    const W = 13, D = 10, G = 3.1, U = 2.9;
    const wallM = this.mat({ map: plaster, roughness: 0.95 }), woodM = this.mat({ map: boards([92, 62, 40]), roughness: 0.85 });
    const darkWood = this.mat({ color: 0x4a3322, roughness: 0.8 }), roofM = this.mat({ map: slate, roughness: 0.75 });
    const glass = this.mat({ color: 0x223038, roughness: 0.1, metalness: 0.4 }), shutter = this.mat({ color: 0x2f6a3a, roughness: 0.7 });
    const box = (w, h, d, m, x, y, z, parent = g) => { const b = new THREE.Mesh(this.keep(new THREE.BoxGeometry(w, h, d)), m); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; parent.add(b); return b; };
    box(W, G, D, wallM, 0, G / 2, 0);
    box(W + 0.1, U, D + 0.1, woodM, 0, G + U / 2, 0);
    // gables + roof (pitch ~22 deg, 1.4 m eaves all round)
    const pitch = 0.38, hw = D / 2 + 1.4, rise = Math.tan(pitch) * (D / 2);
    const gable = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(0, rise)]);
    for (const sx of [-1, 1]) {
      const gm = new THREE.Mesh(this.keep(new THREE.ShapeGeometry(gable)), woodM);
      gm.rotation.y = sx * Math.PI / 2; gm.position.set(sx * (W / 2 + 0.06), G + U, 0); gm.castShadow = true; g.add(gm);
    }
    const slab = Math.hypot(hw, Math.tan(pitch) * hw);
    for (const sz of [-1, 1]) {
      const p = box(W + 3, 0.22, slab, roofM, 0, G + U + rise - Math.tan(pitch) * hw / 2 + 0.25, sz * hw / 2);
      p.rotation.x = sz * pitch;
      box(W + 3.05, 0.3, 0.24, darkWood, 0, G + U + rise - Math.tan(pitch) * hw + 0.22, sz * hw, g); // fascia
    }
    box(W + 3.1, 0.3, 0.4, darkWood, 0, G + U + rise + 0.32, 0); // ridge
    box(0.9, 2.4, 0.9, wallM, W * 0.28, G + U + rise + 0.4, -1.4); // chimney
    // windows with green shutters: both floors on the long sides, the ground floor on the gable ends
    const win = (x, y, z, ry, w = 0.95, h = 1.15) => {
      const o = new THREE.Group(); o.position.set(x, y, z); o.rotation.y = ry; g.add(o);
      box(w + 0.16, h + 0.16, 0.08, this.mat({ color: 0xf2efe6 }), 0, 0, 0.02, o);
      box(w, h, 0.06, glass, 0, 0, 0.05, o);
      box(0.05, h, 0.08, darkWood, 0, 0, 0.08, o); box(w, 0.05, 0.08, darkWood, 0, 0.1, 0.08, o);
      for (const s of [-1, 1]) { const sh = box(w * 0.52, h + 0.05, 0.05, shutter, s * (w * 0.78), 0, 0.12, o); sh.rotation.y = s * 0.25; }
    };
    for (const sz of [-1, 1]) for (let i = 0; i < 4; i++) {
      const x = -W / 2 + 1.8 + i * ((W - 3.6) / 3);
      if (!(sz < 0 && i === 1)) win(x, 1.6, sz * (D / 2 + 0.02), sz < 0 ? Math.PI : 0);
      win(x, G + 1.45, sz * (D / 2 + 0.07), sz < 0 ? Math.PI : 0, 0.9, 1.05);
    }
    for (const sx of [-1, 1]) for (const z of [-2.2, 2.2]) win(sx * (W / 2 + 0.02), 1.6, z, sx * Math.PI / 2);
    // the front door (road side = -z after rotation) and its step
    box(1.2, 2.2, 0.12, darkWood, -W / 2 + 1.8 + (W - 3.6) / 3, 1.1, -D / 2 - 0.04);
    box(1.8, 0.2, 1, this.mat({ color: 0x9a948a }), -W / 2 + 1.8 + (W - 3.6) / 3, 0.1, -D / 2 - 0.5);
    // the balcony with geraniums along the front of the upper floor
    const bz = -D / 2 - 0.75;
    box(W + 1, 0.15, 1.5, darkWood, 0, G + 0.05, -D / 2 - 0.7);
    box(W + 1, 0.95, 0.06, woodM, 0, G + 0.6, bz - 0.7);
    for (const sx of [-1, 1]) box(0.06, 0.95, 1.5, woodM, sx * (W / 2 + 0.5), G + 0.6, -D / 2 - 0.7);
    box(W + 0.8, 0.22, 0.28, this.mat({ color: 0x6b4a2e }), 0, G + 1.15, bz - 0.78);
    const petals = new THREE.InstancedMesh(this.keep(new THREE.IcosahedronGeometry(0.11, 0)), this.mat({ color: 0xd8232a, roughness: 0.6 }), 170);
    const leaves = new THREE.InstancedMesh(this.keep(new THREE.IcosahedronGeometry(0.14, 0)), this.mat({ color: 0x2f5a1f, roughness: 0.8 }), 120);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3(), c = new THREE.Color();
    for (let i = 0; i < 170; i++) { petals.setMatrixAt(i, M.compose(v.set((r() - 0.5) * (W + 0.6), G + 1.3 + r() * 0.3, bz - 0.78 + (r() - 0.5) * 0.4), q, s.setScalar(0.7 + r() * 0.7))); petals.setColorAt(i, c.setHSL(0.99 + r() * 0.02, 0.8, 0.42 + r() * 0.12)); }
    for (let i = 0; i < 120; i++) leaves.setMatrixAt(i, M.compose(v.set((r() - 0.5) * (W + 0.6), G + 1.26 + r() * 0.12, bz - 0.78 + (r() - 0.5) * 0.4), q, s.setScalar(0.8 + r() * 0.6)));
    petals.castShadow = leaves.castShadow = true;
    g.add(petals, leaves);
    // woodpile against the gable end
    const logs = new THREE.InstancedMesh(this.keep(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 7).rotateX(Math.PI / 2)), this.mat({ color: 0x9c7a52 }), 140);
    for (let i = 0; i < 140; i++) { const row = (i / 20) | 0, col = i % 20; logs.setMatrixAt(i, M.compose(v.set(W / 2 + 0.45, 0.13 + row * 0.22, -3.8 + col * 0.24 + (row % 2) * 0.11), q, s.setScalar(1))); logs.setColorAt(i, c.setHSL(0.08, 0.35, 0.36 + r() * 0.15)); }
    logs.castShadow = true; g.add(logs);
    // the barn
    const barn = new THREE.Group(); barn.position.set(-W / 2 - 9, 0, 6); g.add(barn);
    box(10, 4.2, 8, this.mat({ map: boards([110, 72, 44], 10), roughness: 0.9 }), 0, 2.1, 0, barn);
    box(10.2, 0.6, 8.2, wallM, 0, 0.3, 0, barn);
    for (const sz of [-1, 1]) { const rf = box(11.5, 0.18, 5.4, roofM, 0, 5.05, sz * 2.35, barn); rf.rotation.x = sz * 0.42; }
    box(3, 3, 0.1, darkWood, 0, 1.6, -4.02, barn);
    g.position.set(FARM.x, H(FARM.x, FARM.z) - 0.05, FARM.z);
    g.rotation.y = Math.PI / 2 - 0.12; // the balcony (local -z) faces the road (-x)
    this.scene.add(g);
  }

  // the stop: a small wooden shelter (board walls, a shingled pitched roof, a bench inside, a timetable),
  // the Meshy stop sign beside it
  buildShelter() {
    const g = new THREE.Group(), r = mulberry32(21);
    const plank = this.keep(canvasTex(256, 256, (x, w, h) => {
      for (let i = 0; i < 8; i++) { const v = (r() - 0.5) * 22; x.fillStyle = `rgb(${120 + v},${84 + v * 0.8},${54 + v * 0.6})`; x.fillRect(i * w / 8, 0, w / 8 - 2, h); x.fillStyle = 'rgba(25,14,6,0.6)'; x.fillRect((i + 1) * w / 8 - 2, 0, 2, h); }
      for (let i = 0; i < 400; i++) { x.fillStyle = `rgba(30,16,6,${0.06 + r() * 0.08})`; x.fillRect(r() * w, r() * h, 1, 10 + r() * 50); }
    }, [1, 1]));
    const shingles = this.keep(canvasTex(256, 256, (x, w, h) => {
      x.fillStyle = '#5a4030'; x.fillRect(0, 0, w, h);
      for (let row = 0; row < 10; row++) for (let i = 0; i < 9; i++) { const v = (r() - 0.5) * 30; x.fillStyle = `rgb(${96 + v},${70 + v},${52 + v})`; x.fillRect(i * 30 + (row % 2) * 15, row * 26, 27, 24); }
    }, [2, 1]));
    const wood = this.mat({ map: plank, roughness: 0.85 }), dark = this.mat({ color: 0x4a3322, roughness: 0.8 }), roofM = this.mat({ map: shingles, roughness: 0.9 });
    const box = (w, h, d, m, x, y, z) => { const b = new THREE.Mesh(this.keep(new THREE.BoxGeometry(w, h, d)), m); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; g.add(b); return b; };
    // local frame: open front toward +x (the road), 3.6 m long along z, 1.7 m deep
    box(0.1, 2.3, 3.6, wood, -0.85, 1.15, 0);
    for (const s of [-1, 1]) box(1.7, 2.3, 0.1, wood, 0, 1.15, s * 1.8);
    for (const [x, z] of [[0.85, -1.8], [0.85, 1.8]]) box(0.14, 2.4, 0.14, dark, x, 1.2, z);
    box(0.14, 0.18, 3.75, dark, 0.85, 2.34, 0);
    for (const s of [-1, 1]) { const rf = box(1.5, 0.1, 4.3, roofM, s * 0.62, 2.62, 0); rf.rotation.z = -s * 0.5; }
    box(0.12, 0.12, 4.3, dark, 0, 2.95, 0);
    box(0.45, 0.06, 3.0, wood, -0.55, 0.48, 0); box(0.06, 0.45, 3.0, wood, -0.78, 0.75, 0); // bench
    for (const z of [-1.3, 1.3]) box(0.4, 0.46, 0.06, dark, -0.55, 0.23, z);
    const poster = this.keep(canvasTex(256, 360, (x, w, h) => {
      x.fillStyle = '#f6f2e6'; x.fillRect(0, 0, w, h); x.fillStyle = '#f2c200'; x.fillRect(0, 0, w, 70);
      x.fillStyle = '#0f5235'; x.font = 'bold 40px Arial'; x.fillText('SKI BUS', 40, 50);
      x.font = 'bold 18px Arial'; x.fillText('Wiesental  >  Legacy Village', 16, 104);
      x.fillStyle = '#333'; x.font = '15px Arial';
      for (let i = 0; i < 9; i++) x.fillText(`${(7 + i).toString().padStart(2, '0')}:1${i % 6}   ${(7 + i).toString().padStart(2, '0')}:4${(i + 3) % 6}`, 30, 140 + i * 24);
    }));
    const pm = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(0.55, 0.78)), this.mat({ map: poster, roughness: 0.6 }));
    pm.rotation.y = Math.PI / 2; pm.position.set(-0.79, 1.45, 0.9); g.add(pm);
    const flat = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(2.6, 4.6)), this.mat({ color: 0x8d877a, roughness: 1 }));
    flat.rotation.x = -Math.PI / 2; flat.position.y = 0.025; flat.receiveShadow = true; g.add(flat);
    const x = RX(SHED.z) + SHED.x;
    g.position.set(x, BASE(SHED.z), SHED.z);
    g.rotation.y = -Math.atan(RXd(SHED.z));
    this.scene.add(g);
    this.shelter = g;
    if (this.models.bus_stop_sign) {
      const sign = fitModel(this.models.bus_stop_sign, { size: 2.6, axis: 'y' });
      const k = sign.userData.size.y / 2;
      const face = this.mat({ map: this.keep(canvasTex(512, 816, (c, w, h) => {
        c.fillStyle = '#f2c200'; c.fillRect(0, 0, w, h); c.fillStyle = '#0f5235'; c.textAlign = 'center';
        c.font = 'bold 168px Arial'; c.fillText('SKI', 256, 250); c.fillText('BUS', 256, 430); c.fillRect(56, 500, 400, 10);
        c.font = 'bold 64px Arial'; c.fillText('WIESENTAL', 256, 620);
      })), roughness: 0.45 });
      for (const sd of [1, -1]) {
        const f = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(0.74 * k, 1.18 * k)), face);
        f.position.set(0.07 * k, 1.26 * k, sd * (0.09 * k + 0.008)); if (sd < 0) f.rotation.y = Math.PI;
        sign.add(f);
      }
      sign.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
      sign.position.set(RX(7.5) - 5.4, BASE(7.5) - 0.04, 7.5);
      sign.rotation.y = Math.PI / 2;
      this.scene.add(sign);
    }
  }

  buildBus() {
    this.bus = buildBus(this.models, null);
    this.scene.add(this.bus.group);
    this.doors = attachBusDoors(this.bus.group, this.bus.shell);
    this.busZ = ZSTOP - 90 - 20 * T.busIn;
    this.placeBus(this.busZ);
  }

  // bus centre at road arc ~z, in the right-hand lane (right of heading +z is -x), nose up the valley
  placeBus(z) {
    const g = this.bus.group, zf = z + 3, zb = z - 3;
    const a = new THREE.Vector3(RX(zf) - LANE, BASE(zf), zf), b = new THREE.Vector3(RX(zb) - LANE, BASE(zb), zb);
    g.position.addVectors(a, b).multiplyScalar(0.5);
    g.lookAt(g.position.clone().add(a.sub(b)));
    g.updateMatrixWorld(true);
  }

  buildSkier() {
    const id = this.save.character;
    const rig = (this.rig = this.makeRig(id, this.save.skis || 'rental'));
    try { applyOutfit(rig, id, getEquipped(this.save, id)); } catch (e) { /* stock look */ }
    rig.addTo(this.scene);
    rig.setCarry?.(true); rig.setSkisVisible?.(true);
    rig.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    rig.gear.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.normal = new THREE.Vector3(0, 1, 0);
  }

  skierPose(t) {
    // waiting in the shelter's mouth, then across the apron to the front door, then up its step
    const sx = RX(SHED.z) + SHED.x + 1.5, sz = SHED.z - 0.4;
    const door = new THREE.Vector3(-(this.doors.side + 0.55), 0, DOOR_Z);
    this.bus.group.localToWorld(door);
    const inn = new THREE.Vector3(-(this.doors.side - 0.7), 0, DOOR_Z); this.bus.group.localToWorld(inn);
    if (t < T.walk0) return { x: sx, z: sz, y: BASE(sz), h: Math.PI / 2 - 0.5 + 0.12 * Math.sin(t * 0.4), v: 0, vis: true };
    if (t < T.step) {
      const k = (t - T.walk0) / (T.step - T.walk0), e = k * k * (3 - 2 * k) * 0.3 + k * 0.7;
      const x = lerp(sx, door.x, e), z = lerp(sz, door.z, e);
      return { x, z, y: BASE(z), h: Math.atan2(door.x - sx, door.z - sz), v: 1.45, vis: true };
    }
    const k = clamp((t - T.step) / (T.gone - T.step), 0, 1);
    return { x: lerp(door.x, inn.x, k), z: lerp(door.z, inn.z, k), y: BASE(door.z) + 0.45 * smoothstep(0, 0.6, k) + 0.4 * smoothstep(0.5, 1, k), h: Math.atan2(inn.x - door.x, inn.z - door.z), v: 1.2, vis: t < T.gone };
  }

  skip() {
    if (this.done) return;
    this.done = true;
    this.sound?.stop();
    presentationUI.skipHint(null); presentationUI.hideLowerThird?.();
    this.onDone?.();
  }

  /** Per frame, real dt. Poses the camera, bus and skier. */
  update(dt) {
    if (this.done || !(dt >= 0)) return;
    if (this.hold) dt = 0; // (the transition still covers the screen)
    this.t += dt;
    const t = this.t;
    this.wind.value += dt;
    // the bus: in at 20 m/s, braking to the stop; doors; away up the valley
    let z, v;
    if (t < T.busIn) { z = ZSTOP - 90 - 20 * (T.busIn - t); v = 20; }
    else if (t < T.busStop) { const e = (t - T.busIn) / (T.busStop - T.busIn); z = ZSTOP - 90 * (1 - e) * (1 - e); v = 20 * (1 - e); }
    else if (t < T.depart) { z = ZSTOP; v = 0; }
    else { const s = t - T.depart; z = ZSTOP + 1.1 * s * s; v = 2.2 * s; }
    this.placeBus(z);
    this.doors.set(t < T.doorsOpen ? 0 : t < T.doorsShut ? clamp((t - T.doorsOpen) / 1.0, 0, 1) : clamp(1 - (t - T.doorsShut) / 0.9, 0, 1));
    this.sound?.update(dt, { v, t });
    // the skier
    const p = this.skierPose(t);
    showRig(this.rig, p.vis);
    if (p.vis) withGround(p.y, () => poseRig(this.rig, p.x, p.y, p.z, dt || 1e-4, { mode: 'walk', heading: p.h, speed: p.v, crouch: 0, lean: 0, plow: 0, normal: this.normal, carry: true }));
    // the shots
    const s = SHOTS.findIndex((e) => t < e);
    if (s !== this.shot) { this.shot = s; if (s === 3) presentationUI.lowerThird({ kicker: 'SKI BUS', title: 'Next stop · Legacy Village' }); }
    if (s === 3 && t > T.end - 2.6) presentationUI.hideLowerThird?.();
    this.pose(s < 0 ? 3 : s, t, z);
    if (t >= T.end) this.skip();
  }

  pose(s, t, busZ) {
    const cam = this.camera, P = new THREE.Vector3(), L = new THREE.Vector3();
    const bx = RX(busZ) - LANE;
    if (s === 0) {
      // A: high over the meadows, drifting down toward the shelter; the valley and its far peaks beyond
      const k = ease(t / SHOTS[0]);
      P.set(lerp(-70, -34, k), lerp(52, 15, k), lerp(-150, -46, k));
      L.set(lerp(-10, -6, k), lerp(140, 1.5, Math.pow(k, 0.8)), lerp(1200, 0, Math.pow(k, 0.7)));
      this.aimSun(-8, 0);
      applyCamera(cam, P, L, lerp(52, 40, k));
    } else if (s === 1) {
      // B: low in the grass behind the boulder, the bus pulls in and stops; the doors fold open
      const k = (t - SHOTS[0]) / (SHOTS[1] - SHOTS[0]);
      P.set(-5.4 + k * 0.3, 0.8 + k * 0.2, -17 + k * 1.5);
      L.set(lerp(bx, -3.2, smoothstep(0.55, 1, k)), 1.5, lerp(busZ + 2, 3, smoothstep(0.55, 1, k)));
      this.aimSun(-6, -4);
      applyCamera(cam, P, L, 38);
    } else if (s === 2) {
      // C: over the shoulder from the shelter, tracking you across to the door and in
      const k = (t - SHOTS[1]) / (SHOTS[2] - SHOTS[1]);
      const pz = this.skierPose(Math.min(t, T.gone - 0.05));
      P.set(lerp(-4.9, -5.6, k), lerp(1.65, 1.75, k), lerp(-7.5, -4.2, ease(k)));
      L.set(lerp(pz.x, -2.8, 0.3), 1.3, lerp(pz.z, DOOR_Z, 0.35));
      this.aimSun(-5, 2);
      applyCamera(cam, P, L, lerp(42, 36, k));
    } else {
      // D: the bus pulls away up the valley; the camera cranes up behind the shelter toward the snowy peaks
      const k = ease((t - SHOTS[2]) / (SHOTS[3] - SHOTS[2]));
      P.set(lerp(-9, -16, k), lerp(2.4, 16, k), lerp(-8, -26, k));
      L.set(lerp(bx, RX(busZ + 300), k * 0.6), lerp(1.8, 60, k * k), lerp(busZ, busZ + 600, k * 0.8));
      this.aimSun(bx, Math.max(0, busZ - 10));
      applyCamera(cam, P, L, lerp(44, 50, k));
    }
    cam.far = 14000; cam.updateProjectionMatrix();
  }

  dispose() {
    removeEventListener('keydown', this.onKey, true);
    removeEventListener('resize', this.onResize);
    this.sound?.stop();
    this.doors?.dispose();
    for (const x of this.own) x.dispose?.();
    this.envTex?.dispose();
    this.sun.shadow.map?.dispose();
    this.scene.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    this.scene.clear();
  }
}

// ------------------------------------------------------------------ sound: a gentle pad, birds, the bus
class IntroSound {
  constructor(audio) {
    this.audio = audio;
    const ctx = audio?.ctx;
    if (!ctx || !audio.musicBus) return;
    this.ctx = ctx;
    const t0 = ctx.currentTime;
    // pad: slow major-seventh chords through a soft low-pass (I - vi - IV - V in D), music bus
    this.pad = ctx.createGain(); this.pad.gain.setValueAtTime(0, t0); this.pad.gain.linearRampToValueAtTime(0.16, t0 + 3);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.4;
    this.pad.connect(lp).connect(audio.musicBus);
    const chords = [[146.8, 185, 220, 277.2], [123.5, 146.8, 185, 220], [98, 146.8, 196, 246.9], [110, 138.6, 164.8, 220]];
    this.oscs = [];
    for (let v = 0; v < 4; v++) for (const det of [-4, 4]) {
      const o = ctx.createOscillator(); o.type = v === 0 ? 'sine' : 'triangle'; o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = v === 0 ? 0.5 : 0.22;
      for (let k = 0; k < 8; k++) o.frequency.setTargetAtTime(chords[k % 4][v], t0 + k * 4, k ? 0.6 : 0.001);
      o.connect(g).connect(this.pad); o.start(t0); this.oscs.push(o);
    }
    // a music-box melody over it
    const notes = [587.3, 740, 880, 740, 659.3, 587.3, 493.9, 587.3, 659.3, 740, 587.3, 554.4, 587.3, 659.3, 740, 880];
    notes.forEach((f, i) => {
      const at = t0 + 2 + i * 1.5, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.07, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0005, at + 1.4);
      o.connect(g).connect(this.pad); o.start(at); o.stop(at + 1.5);
    });
    // the bus: a diesel rumble (sfx bus), louder with speed
    this.eng = ctx.createGain(); this.eng.gain.value = 0;
    const ef = ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 260;
    this.engO = ctx.createOscillator(); this.engO.type = 'sawtooth'; this.engO.frequency.value = 38;
    this.engO.connect(ef).connect(this.eng).connect(audio.sfx); this.engO.start(t0);
    this.birdT = 0.8; this.flags = {};
  }
  update(dt, { v, t }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // the engine: distance-ish loudness from the timeline (closest while it waits at the stop)
    const near = t < 11 ? smoothstep(2, 10, t) : t < 17.4 ? 1 : 1 - smoothstep(18, 26, t);
    this.eng.gain.setTargetAtTime(0.05 + 0.13 * near * (0.5 + v / 20), now, 0.2);
    this.engO.frequency.setTargetAtTime(34 + v * 2.2, now, 0.3);
    const once = (k, at, fn) => { if (t >= at && !this.flags[k]) { this.flags[k] = true; fn(); } };
    once('brake', 10.2, () => this.hiss(0.6, 0.12, 3000));
    once('open', 11.3, () => { this.hiss(0.9, 0.18, 1800); this.audio.shot?.('car_door', { sprite: [0], vol: 0.25, rate: 0.7 }); });
    once('shut', 16.4, () => { this.hiss(0.8, 0.16, 1800); this.audio.shot?.('car_door', { sprite: [1], vol: 0.3, rate: 0.7 }); });
    once('horn', 17.2, () => this.audio.play?.('horn', 0.5));
    // birdsong
    this.birdT -= dt;
    if (this.birdT < 0) { this.birdT = 0.6 + Math.random() * 2.2; this.chirp(); }
  }
  hiss(dur, vol, f) {
    const ctx = this.ctx, n = ctx.createBufferSource(), len = ctx.sampleRate * dur, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    n.buffer = b; const g = ctx.createGain(), bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; g.gain.value = vol;
    n.connect(bp).connect(g).connect(this.audio.sfx); n.start();
  }
  chirp() {
    const ctx = this.ctx, at = ctx.currentTime, f = 2600 + Math.random() * 1800, k = 2 + (Math.random() * 4 | 0);
    for (let i = 0; i < k; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain(), s = at + i * 0.11;
      o.frequency.setValueAtTime(f, s); o.frequency.exponentialRampToValueAtTime(f * (1.3 + Math.random() * 0.3), s + 0.07);
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.025, s + 0.01); g.gain.exponentialRampToValueAtTime(0.0003, s + 0.09);
      o.connect(g).connect(this.audio.sfx); o.start(s); o.stop(s + 0.1);
    }
  }
  stop() {
    if (!this.ctx || this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    this.pad.gain.cancelScheduledValues(now); this.pad.gain.setTargetAtTime(0, now, 0.4);
    this.eng.gain.setTargetAtTime(0, now, 0.3);
    setTimeout(() => { for (const o of [...this.oscs, this.engO]) try { o.stop(); } catch (e) { /* stopped */ } }, 2500);
  }
}

// ------------------------------------------------------------------ arrival in Legacy Village
/** ~3.6 s: the real ski bus waits at the village stop, its doors open, you step down and walk to the waiting
 *  area; the camera settles into the chase camera and the free ride starts. */
export class BusArrival {
  constructor({ player, skibus, camera, onDone }) {
    Object.assign(this, { player, camera, onDone });
    this.t = 0; this.done = false;
    const line = skibus?.line, stop = busRoads.stops[0];
    const wa = stop ? stopWaitArea(stop) : null;
    const v = { x: -16, z: 46, heading: Math.PI / 2 };
    this.end = wa ? { x: wa.x, z: wa.z, h: wa.face + Math.PI } : { x: v.x + 2.5, z: v.z, h: v.heading };
    this.bus = null;
    if (line && !line.riding) {
      line.parkAtVillage();
      if (line.bus.group.visible) {
        this.bus = line.bus.group;
        this.doors = attachBusDoors(this.bus, line.bus.shell);
        const d = new THREE.Vector3(-(this.doors.side - 0.4), 0, DOOR_Z), o = new THREE.Vector3(-(this.doors.side + 1.0), 0, DOOR_Z);
        this.bus.localToWorld(d); this.bus.localToWorld(o);
        this.start = { x: d.x, z: d.z }; this.out = { x: o.x, z: o.z };
      }
    }
    player.teleport(this.end.x, this.end.z, this.end.h);
    this.rig = player.rig;
    if (this.bus) { lockRig(this.rig); showRig(this.rig, false); }
    else this.done = true;
    this.normal = new THREE.Vector3(0, 1, 0);
    this.onKey = (e) => { if (['Enter', 'Space'].includes(e.code)) this.skip(); }; // (Esc: the pause menu, which holds it)
    if (!this.done) addEventListener('keydown', this.onKey, true);
  }
  get duration() { return 3.8; }
  skip() { if (!this.done) this.finish(); }
  finish() {
    this.done = true;
    removeEventListener('keydown', this.onKey, true);
    unlockRig(this.rig); showRig(this.rig, true);
    this.player.teleport(this.end.x, this.end.z, this.end.h);
    this.doors?.set(0);
    const d = this.doors; setTimeout(() => d?.dispose(), 50);
    presentationUI.cinematic(false); presentationUI.skipHint(null);
    this.onDone?.();
  }
  update(dt) {
    if (this.done) return;
    this.t += dt;
    const t = this.t, p = this.player;
    this.doors.set(t < 2.6 ? clamp(t / 0.8, 0, 1) : clamp(1 - (t - 2.6) / 0.8, 0, 1));
    // down the step (0.6..1.1), then out to the waiting area
    let x, z, y, h, v;
    if (t < 1.1) {
      const k = clamp((t - 0.5) / 0.6, 0, 1);
      x = lerp(this.start.x, this.out.x, k); z = lerp(this.start.z, this.out.z, k); h = Math.atan2(this.out.x - this.start.x, this.out.z - this.start.z);
      y = world.groundHeight(x, z) + 0.45 * (1 - smoothstep(0, 1, k)); v = 1.1;
    } else {
      const k = clamp((t - 1.1) / 2.2, 0, 1), e = k * (2 - k);
      x = lerp(this.out.x, this.end.x, e); z = lerp(this.out.z, this.end.z, e); y = world.groundHeight(x, z);
      const hw = Math.atan2(this.end.x - this.out.x, this.end.z - this.out.z);
      h = hw + Math.atan2(Math.sin(this.end.h - hw), Math.cos(this.end.h - hw)) * smoothstep(0.6, 1, k); v = 1.45 * (1 - smoothstep(0.85, 1, k));
    }
    showRig(this.rig, t > 0.5);
    poseRig(this.rig, x, y, z, dt || 1e-4, { mode: 'walk', heading: h, speed: v, crouch: 0, lean: 0, plow: 0, normal: this.normal, carry: p.hasSkis && !p.skisOn });
    // camera: a 3/4 view from the plaza side of the waiting area, blending into the chase camera at the end
    const ex = this.end.x, ez = this.end.z, fx = Math.sin(this.end.h), fz = Math.cos(this.end.h);
    const P = new THREE.Vector3(ex + fx * 6.5 + fz * 3.5, world.groundHeight(ex, ez) + 2.2, ez + fz * 6.5 - fx * 3.5);
    const L = new THREE.Vector3(lerp(this.start.x, x, 0.55), y + 1.3, lerp(this.start.z, z, 0.55));
    applyCamera(this.camera, P, L, 46, smoothstep(this.duration - 1.1, this.duration, t));
    if (t >= this.duration) this.finish();
  }
}

/**
 * The whole first-time flow, driven from main.js startFromMenu.
 * ctx: { renderer, post, scene, camera, models, makeRig, save, writeSave, audio, transition, player, skibus,
 *        streamAround, startGame, swapCharacter, menu, showcase, setActive(obj|null) }
 */
export async function runBusIntro(ctx) {
  const { player, save } = ctx;
  if (player.rig && save.character !== player.rigChar) ctx.swapCharacter(save.character);
  ctx.audio.init();
  ctx.audio.music(null); // the menu track fades out under the intro's own pad
  let intro = null;
  const finished = new Promise((res) => {
    ctx.transition.fade(async () => {
      ctx.menu.hide();
      if (ctx.showcase?.active) ctx.showcase.hide();
      try {
        intro = new BusIntro({ renderer: ctx.renderer, models: ctx.models, makeRig: ctx.makeRig, save, audio: ctx.audio, onDone: res });
      } catch (e) { console.warn('bus intro', e); intro = null; res(); return; }
      intro.update(0);
      ctx.renderer.compile(intro.scene, intro.camera);
      ctx.post.setView(intro.scene, intro.camera);
      ctx.setActive(intro);
    });
  });
  await finished;
  save.introBus = true; ctx.writeSave();
  let arrival = null;
  await ctx.transition.teleport('Legacy Village', async () => {
    ctx.post.setView(ctx.scene, ctx.camera);
    ctx.setActive(null);
    try { intro?.dispose(); } catch (e) { console.warn('bus intro dispose', e); }
    if (player.mode === 'sit') { player.seat = null; player.mode = 'walk'; }
    player.setSkisOn?.(false);
    try { arrival = new BusArrival({ player, skibus: ctx.skibus, camera: ctx.camera, onDone: null }); } catch (e) { console.warn('bus arrival', e); arrival = null; }
    await ctx.streamAround(player.pos.x, player.pos.z);
    if (arrival && !arrival.done) ctx.setActive(arrival);
  }, { kicker: 'SKI BUS · NEXT STOP', minMs: 900 });
  const h = player.heading;
  ctx.startGame();
  player.camYaw = h + Math.PI; player.camPitch = -0.12;
  if (!arrival || arrival.done) { presentationUI.cinematic(false); presentationUI.skipHint(null); ctx.setActive(null); return; }
  presentationUI.skipHint('SKIP');
  arrival.onDone = () => ctx.setActive(null);
}
