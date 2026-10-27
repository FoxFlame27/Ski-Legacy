// Piste groomers (snowcats) working the resort's pistes: a few red machines crawl up and down the groomed
// runs near the player at ~12 km/h, turning in a wide U at the end of their stretch. They keep off the race
// courses, the lift stations, the village and the ski lanes, stop for the player (and are solid: one
// moving collider each) and only exist within ~1.5 km of the player (re-placed out of sight as you travel).
// At dusk / night: headlights + a rotating amber beacon (additive point sprites, one draw call for all)
// and a pool of light on the snow ahead of each machine. No THREE lights.
//
// Model: the Meshy 'snowcat' (blade in front) + a procedural rear tiller; a procedural machine as fallback.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from './world.js';
import { layout, PISTE_WIDTH } from './layout.js';
import { fitModel, makeLOD, loadGLB } from '../core/assets.js';
import { qualityLevel, getRunIndex, hitsCollider, mulberry } from './crowds.js';

const STEP = 4;              // m between route samples
const SPEED = 3.3;           // m/s cruising (~12 km/h)
const BODY_LEN = 6.6;        // m, blade to rear deck (the tiller trails behind)
const HALF_W = 2.25, HALF_L = 4.6; // collider (blade + tiller)
const NEAR = 1500;           // machines only work within this distance of the player
const VILLAGE = { x: 0, z: -6, r: 200 };
const FLEET = [2, 2, 3, 4, 5]; // machines per preset level (performance .. ultra)

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _size = new THREE.Vector2();

// ------------------------------------------------------------------ routes
// Long stretches of piste the machines may work on: away from races, stations, huts, the village, lanes.
function buildRoutes(colliders) {
  const idx = getRunIndex();
  const routes = [];
  const stations = [];
  for (const l of layout.lifts) {
    stations.push([l.bottom.x, l.bottom.z, 60], [l.top.x, l.top.z, 60]);
    if (l.mid) stations.push([l.mid.x, l.mid.z, 45]);
  }
  for (const h of layout.huts) stations.push([h.x, h.z, 50]);
  for (const p of layout.pistes) {
    if (p.lane || p.pts.length < 8) continue;
    const pts = smoothLine(resample(p.pts, STEP), 3);
    const n = pts.length / 2, W = PISTE_WIDTH[p.diff];
    const lat = Math.min(W * 0.42, W - 4.5);
    if (lat < 3.5) continue;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) { minx = Math.min(minx, pts[i * 2]); maxx = Math.max(maxx, pts[i * 2]); minz = Math.min(minz, pts[i * 2 + 1]); maxz = Math.max(maxz, pts[i * 2 + 1]); }
    const near = colliders.filter((c) => c.x > minx - W - 10 && c.x < maxx + W + 10 && c.z > minz - W - 10 && c.z < maxz + W + 10);
    const nrm = normals(pts);
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      let good = Math.hypot(x - VILLAGE.x, z - VILLAGE.z) > VILLAGE.r;
      for (const [sx, sz, r] of stations) if (good && Math.hypot(x - sx, z - sz) < r) good = false;
      if (good && idx.raceClearance(x, z) < 12) good = false;
      if (good) {
        for (const sd of [1, -1]) {
          const lx = x + nrm[i * 2] * lat * sd, lz = z + nrm[i * 2 + 1] * lat * sd;
          if (hitsCollider(near, lx, lz, HALF_W + 1.5)) { good = false; break; }
        }
      }
      ok[i] = good ? 1 : 0;
    }
    // runs of good samples, at least 160 m long
    for (let i = 0; i < n;) {
      if (!ok[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && ok[j + 1]) j++;
      if ((j - i) * STEP >= 160) routes.push({ piste: p, pts, nrm, i0: i, i1: j, lat, W });
      i = j + 1;
    }
  }
  return routes;
}

function resample(src, step) {
  const out = [src[0][0], src[0][1]];
  let carry = 0;
  for (let k = 1; k < src.length; k++) {
    const [ax, az] = src[k - 1], [bx, bz] = src[k];
    const l = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= l) { out.push(ax + ((bx - ax) * t) / l, az + ((bz - az) * t) / l); t += step; }
    carry = l - (t - step);
  }
  return out;
}
function smoothLine(p, passes) {
  let a = Float64Array.from(p);
  const n = a.length / 2;
  for (let s = 0; s < passes; s++) {
    const b = Float64Array.from(a);
    for (let i = 1; i < n - 1; i++) for (let c = 0; c < 2; c++) b[i * 2 + c] = (a[(i - 1) * 2 + c] + a[i * 2 + c] * 2 + a[(i + 1) * 2 + c]) / 4;
    a = b;
  }
  return a;
}
// unit normals (to the right of increasing index, looking along the line: (-dz, dx))
function normals(p) {
  const n = p.length / 2, out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = p[b * 2] - p[a * 2], dz = p[b * 2 + 1] - p[a * 2 + 1], l = Math.hypot(dx, dz) || 1;
    out[i * 2] = -dz / l; out[i * 2 + 1] = dx / l;
  }
  return out;
}

// ------------------------------------------------------------------ meshes
const RED = 0xc8231b;
function proceduralCat() {
  const g = new THREE.Group();
  const m = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.1, ...o });
  const red = m(RED), dark = m(0x1d1f22, { roughness: 0.85 }), glass = m(0x1a2430, { roughness: 0.15, metalness: 0.4 }), white = m(0xeeeeee);
  const box = (w, h, d, x, y, z, mat) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); g.add(b); return b; };
  for (const sx of [-1, 1]) box(1.05, 1.0, 4.6, sx * 1.55, 0.5, 0, dark);   // tracks
  box(2.3, 1.0, 4.4, 0, 1.35, -0.1, red);                                 // hull
  box(2.2, 1.55, 1.9, 0, 2.6, 0.35, red);                                 // cab
  box(2.24, 0.85, 1.6, 0, 2.75, 0.4, glass);
  box(2.3, 0.08, 4.42, 0, 1.9, -0.1, white);                              // stripe
  box(4.4, 1.05, 0.25, 0, 0.75, 3.05, red);                               // blade
  box(1.6, 0.18, 0.18, 0, 3.45, 0.4, dark);                               // light bar
  return g;
}

// the rear tiller: arm, drum housing and the rubber finisher flap trailing on the snow (local -z = back);
// one vertex-coloured mesh, its geometry shared by the fleet
let tillerGeo = null;
const tillerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 });
function tiller(len) {
  if (!tillerGeo) {
    const z0 = -len / 2, c = new THREE.Color();
    const part = (w, h, d, x, y, z, rx, hex) => {
      const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
      g.applyMatrix4(new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z));
      c.set(hex);
      const n = g.attributes.position.count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return g;
    };
    const parts = [
      part(0.5, 0.35, 1.2, 0, 0.95, z0 - 0.3, -0.35, 0x3a3d42),   // arm
      part(4.3, 0.62, 0.95, 0, 0.55, z0 - 1.05, 0, RED),          // drum housing
      part(4.34, 0.08, 0.99, 0, 0.88, z0 - 1.05, 0, 0x3a3d42),    // its lid
      part(4.2, 0.04, 1.1, 0, 0.12, z0 - 1.95, -0.12, 0x141517),  // finisher flap
    ];
    tillerGeo = mergeGeometries(parts);
    for (const g of parts) g.dispose();
  }
  const m = new THREE.Mesh(tillerGeo, tillerMat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// light positions in the machine's frame: 4 headlights (roof bar + hood) and 2 beacons (fitted to the
// Meshy model's surfaces once it loads: fitLamps)
const LAMPS = [
  [-0.6, 3.45, 0.62, 0], [0.6, 3.45, 0.62, 0],
  [-0.9, 1.6, 2.28, 0], [0.9, 1.6, 2.28, 0],
  [-0.4, 3.52, 0.0, 1], [0.4, 3.52, 0.0, 1],
];

// Lamps on the model: rays from in front find the cab face (roof bar and the lamps below the windscreen,
// above the blade), rays from above find the roof for the beacons. Each glow sits a hand's width out.
function fitLamps(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj), H = box.max.y;
  const ray = new THREE.Raycaster();
  const hit = (ox, oy, oz, dx, dy, dz) => {
    ray.set(_v.set(ox, oy, oz), _w.set(dx, dy, dz));
    return ray.intersectObject(obj, true)[0]?.point || null;
  };
  const out = [];
  let roofZ = box.max.z;
  for (const [x, y] of [[-0.6, H * 0.9], [0.6, H * 0.9], [-0.95, H * 0.66], [0.95, H * 0.66]]) {
    const z = hit(x, y, box.max.z + 5, 0, 0, -1)?.z ?? box.max.z * 0.35;
    if (y > H * 0.8) roofZ = Math.min(roofZ, z);
    out.push([x, y, z + 0.18, 0]);
  }
  for (const x of [-0.4, 0.4]) {
    const y = hit(x, H + 5, roofZ - 0.5, 0, -1, 0)?.y ?? H;
    out.push([x, y + 0.16, roofZ - 0.5, 1]);
  }
  return out;
}

function glowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 500 } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      attribute float size;
      uniform float uScale;
      varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = max(2.0, size * uScale / max(d, 0.5));
        vC = color * smoothstep(1100.0, 500.0, d);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float r2 = dot(q, q) * 4.0;
        float a = exp(-r2 * 5.0) * 0.8 + exp(-r2 * 40.0) * 1.6;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vC * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
}

function poolTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.save(); g.translate(64, 40); g.scale(1, 2.6);
  const grd = g.createRadialGradient(0, 30, 2, 0, 30, 62);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(-64, -40, 128, 120);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ the fleet
export class Snowcats {
  /**
   * @param {THREE.Scene} scene
   * @param {object} o
   * @param {object} [o.models]      models.snowcat (loaded on demand when missing)
   * @param {Array}  [o.colliders]   static colliders (the machines keep clear of them); each machine's own
   *                                 moving collider is in this.colliders (push them into the game's list once)
   * @param {string} [o.quality]     preset name (default: the live engine/quality.js preset)
   */
  constructor(scene, { models = {}, colliders = [], quality } = {}) {
    this.scene = scene;
    this.level = qualityLevel(quality);
    const count = FLEET[this.level];
    this.cats = [];
    this.colliders = [];
    this.group = new THREE.Group();
    this.group.name = 'snowcats';
    scene.add(this.group);
    this.rnd = mulberry(5150);
    this.timer = 0;
    this.light = 0;
    this.routes = [];
    if (!count) return;
    this.routes = buildRoutes(colliders);
    if (!this.routes.length) return;
    // lights: one point cloud for every lamp of every machine
    const nL = count * LAMPS.length;
    this.lampPos = new Float32Array(nL * 3);
    this.lampCol = new Float32Array(nL * 3);
    const size = new Float32Array(nL);
    for (let k = 0; k < nL; k++) size[k] = LAMPS[k % LAMPS.length][3] ? 1.1 : 0.9;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.lampPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.lampCol, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.glow = new THREE.Points(geo, glowMaterial());
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    this.glow.visible = false;
    this.group.add(this.glow);
    // pools of headlight on the snow (medium and up)
    this.poolTex = this.level >= 2 ? poolTexture() : null;
    for (let i = 0; i < count; i++) this.cats.push(this.makeCat(i));
    if (models.snowcat) this.useModel(models.snowcat);
    else loadGLB('snowcat').then((g) => g && this.useModel(g));
  }

  makeCat(i) {
    const root = new THREE.Group();
    root.name = 'snowcat';
    const body = proceduralCat();
    const till = tiller(BODY_LEN); // (only on the built fallback body: the Meshy machine has its own)
    root.add(body, till);
    this.shade(root);
    root.visible = false;
    root.matrixAutoUpdate = true;
    this.group.add(root);
    let pool = null;
    if (this.poolTex) {
      const g = new THREE.PlaneGeometry(1, 1, 3, 4);
      g.attributes.position.setUsage(THREE.DynamicDrawUsage);
      pool = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        map: this.poolTex, color: 0x000000, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, fog: true, side: THREE.DoubleSide,
      }));
      pool.frustumCulled = false;
      pool.visible = false;
      pool.renderOrder = 2;
      pool.matrixAutoUpdate = false;
      this.group.add(pool);
    }
    const col = { x: 1e9, z: 1e9, hw: HALF_W, hd: HALF_L, rot: 0 };
    this.colliders.push(col);
    return {
      i, root, body, till, pool, col, route: null, s: 0, dir: 1, lat: 0, heading: 0, speed: 0, mode: 'hidden',
      turn: null, x: 0, y: 0, z: 0, wait: 0, poolAt: new THREE.Vector3(1e9, 0, 0), beacon: this.rnd() * 6,
    };
  }

  useModel(gltf) {
    const opts = { size: BODY_LEN, axis: 'z', rotateY: Math.PI / 2 }; // the blade (model -x) leads
    this.lamps = fitLamps(fitModel(gltf, opts));
    for (const c of this.cats) {
      // a decimated copy beyond 60-130 m
      const lod = makeLOD(gltf, opts, this.level ? 130 : 60, 0.03);
      c.root.remove(c.body);
      if (c.till) { c.root.remove(c.till); c.till = null; } // the model carries its own tiller (two read as a double tail)
      c.body = lod;
      c.col.hd = 3.7; // (the machine's length without the built tiller)
      c.root.add(lod);
      this.shade(c.root);
    }
  }

  // shadows from high up (the performance preset keeps its shadow map for the skier and the near props)
  shade(root) {
    const cast = this.level >= 2;
    root.traverse((o) => { if (o.isMesh) { o.castShadow = cast && o.castShadow !== false; o.receiveShadow = true; } });
  }

  // ---------------------------------------------------------------- placement
  // a route sample within NEAR of the player, out of sight, away from the other machines
  place(c, player, camera) {
    const rnd = this.rnd;
    camera.getWorldDirection(_v);
    for (let tries = 0; tries < 40; tries++) {
      const r = this.routes[Math.floor(rnd() * this.routes.length)];
      const span = r.i1 - r.i0;
      const i = r.i0 + 6 + Math.floor(rnd() * Math.max(1, span - 12));
      const x = r.pts[i * 2], z = r.pts[i * 2 + 1];
      const d = Math.hypot(x - player.x, z - player.z);
      if (d > NEAR - 100 || d < 220) continue;
      const cx = x - camera.position.x, cz = z - camera.position.z, cd = Math.hypot(cx, cz);
      if (cd < 600 && (cx * _v.x + cz * _v.z) / (cd || 1) > -0.2) continue; // in view: not here
      if (this.cats.some((o) => o !== c && o.mode !== 'hidden' && Math.hypot(o.x - x, o.z - z) < 150)) continue;
      c.route = r; c.s = i; c.dir = rnd() < 0.5 ? 1 : -1; c.lat = (rnd() < 0.5 ? 1 : -1) * r.lat;
      c.mode = 'drive'; c.turn = null; c.speed = 0; c.wait = 0;
      this.pose(c, true);
      c.root.visible = true;
      return true;
    }
    return false;
  }

  hide(c) {
    c.mode = 'hidden';
    c.root.visible = false;
    if (c.pool) c.pool.visible = false;
    c.col.x = c.col.z = 1e9;
  }

  // position + heading from the route (or the U-turn arc)
  pose(c, snap = false) {
    const r = c.route, P = r.pts, N = r.nrm, n = P.length / 2;
    let x, z, hx, hz;
    if (c.turn) {
      const T = c.turn, th = T.th;
      x = T.cx + T.nx * T.lat * Math.cos(th) + T.tx * Math.abs(T.lat) * Math.sin(th);
      z = T.cz + T.nz * T.lat * Math.cos(th) + T.tz * Math.abs(T.lat) * Math.sin(th);
      hx = -T.nx * T.lat * Math.sin(th) + T.tx * Math.abs(T.lat) * Math.cos(th);
      hz = -T.nz * T.lat * Math.sin(th) + T.tz * Math.abs(T.lat) * Math.cos(th);
    } else {
      const i = Math.min(n - 2, Math.max(0, Math.floor(c.s))), t = c.s - i;
      const nx = N[i * 2] + (N[i * 2 + 2] - N[i * 2]) * t, nz = N[i * 2 + 1] + (N[i * 2 + 3] - N[i * 2 + 1]) * t;
      x = P[i * 2] + (P[i * 2 + 2] - P[i * 2]) * t + nx * c.lat;
      z = P[i * 2 + 1] + (P[i * 2 + 3] - P[i * 2 + 1]) * t + nz * c.lat;
      // heading: the line a few samples ahead (smooth through bends)
      const a = Math.min(n - 1, Math.max(0, i - 1)), b = Math.min(n - 1, Math.max(0, i + 2));
      hx = (P[b * 2] - P[a * 2]) * c.dir; hz = (P[b * 2 + 1] - P[a * 2 + 1]) * c.dir;
    }
    const target = Math.atan2(hx, hz);
    if (snap) c.heading = target;
    else {
      let dh = target - c.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      c.heading += dh * Math.min(1, c.dtLast * 2.5);
    }
    c.x = x; c.z = z;
  }

  // ---------------------------------------------------------------- per frame
  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {object} env          the sky Environment (nightFactor / dayFactor)
   * @param {object} player       the Player (pos)
   * @param {THREE.WebGLRenderer} [renderer]  (size of the light sprites)
   */
  update(dt, camera, env, player, renderer) {
    if (!this.cats.length) return;
    const pp = player.pos;
    const active = FLEET[qualityLevel()]; // the preset may drop while playing
    this.timer -= dt;
    const check = this.timer <= 0;
    if (check) this.timer = 0.5;
    const light = Math.max(env.nightFactor, (1 - env.dayFactor) * 0.6);
    this.light = light;
    const cam = camera.position;
    let any = false;
    for (const c of this.cats) {
      c.dtLast = dt;
      if (c.i >= active) { if (c.mode !== 'hidden') this.hide(c); continue; }
      if (check) {
        const far = c.mode === 'hidden' || Math.hypot(c.x - pp.x, c.z - pp.z) > NEAR + 200;
        if (far) {
          // re-place only out of sight
          const cd = Math.hypot(c.x - cam.x, c.z - cam.z);
          if (c.mode === 'hidden' || cd > 700) { if (!this.place(c, pp, camera)) this.hide(c); }
        }
      }
      if (c.mode === 'hidden') continue;
      any = true;
      this.drive(c, dt, pp);
      this.dress(c, cam, light);
    }
    if (this.glow) {
      this.glow.visible = any;
      if (any) this.updateLamps(camera, light, renderer);
    }
  }

  drive(c, dt, pp) {
    const r = c.route;
    // stop for the player: anywhere close, or in the path ahead
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
    const ox = pp.x - c.x, oz = pp.z - c.z;
    const along = ox * fx + oz * fz, side = Math.abs(ox * fz - oz * fx);
    const blocked = (along > -5 && along < 18 && side < 4.2) || ox * ox + oz * oz < 49;
    // uphill crawls a little slower
    const target = blocked ? 0 : SPEED * (c.grade > 0.12 ? 0.8 : 1);
    c.speed += Math.max(-2.2 * dt, Math.min(0.7 * dt, target - c.speed));
    const ds = c.speed * dt;
    if (c.turn) {
      const T = c.turn;
      T.th += ds / (Math.PI * Math.abs(T.lat)) * Math.PI;
      if (T.th >= Math.PI) {
        c.turn = null; c.dir = -c.dir; c.lat = -c.lat; c.s = T.s;
      }
    } else {
      c.s += (ds / STEP) * c.dir;
      // the end of the stretch: a wide U-turn onto the other half of the piste
      const margin = Math.abs(c.lat) / STEP + 2;
      if ((c.dir > 0 && c.s >= r.i1 - margin) || (c.dir < 0 && c.s <= r.i0 + margin)) {
        const P = r.pts, N = r.nrm, i = Math.floor(c.s), t = c.s - i;
        const cx = P[i * 2] + (P[i * 2 + 2] - P[i * 2]) * t, cz = P[i * 2 + 1] + (P[i * 2 + 3] - P[i * 2 + 1]) * t;
        let nx = N[i * 2] + (N[i * 2 + 2] - N[i * 2]) * t, nz = N[i * 2 + 1] + (N[i * 2 + 3] - N[i * 2 + 1]) * t;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        c.turn = { th: 0, s: c.s, lat: c.lat, cx, cz, nx, nz, tx: nz * c.dir, tz: -nx * c.dir };
      }
    }
    this.pose(c);
  }

  dress(c, cam, light) {
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading), rx = fz, rz = -fx; // rx: the machine's local +x
    const a = 2.6, b = 1.6;
    const hF = world.height(c.x + fx * a, c.z + fz * a), hB = world.height(c.x - fx * a, c.z - fz * a);
    const hL = world.height(c.x + rx * b, c.z + rz * b), hR = world.height(c.x - rx * b, c.z - rz * b);
    c.grade = (hF - hB) / (2 * a);
    const y = (hF + hB + hL + hR) / 4 - 0.06;
    c.y = y;
    c.root.position.set(c.x, y, c.z);
    _e.set(Math.atan2(hB - hF, 2 * a), c.heading, Math.atan2(hL - hR, 2 * b));
    c.root.rotation.copy(_e);
    c.col.x = c.x; c.col.z = c.z; c.col.rot = -c.heading;
    // the beam on the snow ahead (at night, near the camera)
    if (c.pool) {
      const show = light > 0.06 && Math.hypot(c.x - cam.x, c.z - cam.z) < 380;
      c.pool.visible = show;
      if (show) {
        c.pool.material.color.setRGB(1, 0.86, 0.66).multiplyScalar(light * 0.55);
        if (Math.abs(c.poolAt.x - c.x) + Math.abs(c.poolAt.z - c.z) > 0.4) {
          c.poolAt.set(c.x, 0, c.z);
          const pos = c.pool.geometry.attributes.position;
          for (let k = 0; k < pos.count; k++) {
            // PlaneGeometry(1, 1, 3, 4): u across (-0.5..0.5), v along (-0.5 back .. 0.5 front)
            const u = (k % 4) / 3 - 0.5, v = 0.5 - Math.floor(k / 4) / 4;
            const lx = u * (7 + (v + 0.5) * 9), lz = 3.4 + (v + 0.5) * 18;
            const x = c.x + rx * lx + fx * lz, z = c.z + rz * lx + fz * lz;
            pos.setXYZ(k, x, world.height(x, z) + 0.12, z);
          }
          pos.needsUpdate = true;
        }
      }
    }
  }

  updateLamps(camera, light, renderer) {
    const P = this.lampPos, C = this.lampCol, t = performance.now() / 1000, lamps = this.lamps || LAMPS;
    for (let ci = 0; ci < this.cats.length; ci++) {
      const c = this.cats[ci];
      const vis = c.mode !== 'hidden';
      if (vis) c.root.updateMatrixWorld();
      for (let k = 0; k < LAMPS.length; k++) {
        const o = (ci * LAMPS.length + k) * 3, L = lamps[k];
        if (!vis) { P[o] = P[o + 1] = P[o + 2] = 0; C[o] = C[o + 1] = C[o + 2] = 0; continue; }
        _w.set(L[0], L[1], L[2]).applyMatrix4(c.root.matrixWorld);
        P[o] = _w.x; P[o + 1] = _w.y; P[o + 2] = _w.z;
        if (L[3]) {
          // rotating beacon: a sharp flash every ~0.8 s, the two lamps out of phase
          const f = Math.pow(Math.max(0, Math.sin(t * 7.8 + c.beacon + k * 1.7)), 6);
          const k2 = (0.25 + 0.75 * light) * f * 3.2;
          C[o] = 1.0 * k2; C[o + 1] = 0.48 * k2; C[o + 2] = 0.05 * k2;
        } else {
          const k2 = light * 2.4;
          C[o] = 1.0 * k2; C[o + 1] = 0.93 * k2; C[o + 2] = 0.8 * k2;
        }
      }
    }
    const g = this.glow.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    if (renderer) {
      renderer.getDrawingBufferSize(_size);
      this.glow.material.uniforms.uScale.value = _size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    }
  }
}
