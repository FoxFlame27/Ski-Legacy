// Snow ploughs on the roads (the red tracked snow machines, the Meshy 'snowcat' with its blade in front): three of
// them, each working its own road for good (plowroutes.js: the valley road from the village, and the two scenic roads
// nearest the village that share no roundabout), in the right-hand lane at 27-37 km/h (slower in bends, at a crawl
// round a roundabout or turning on the spot at the end of their stretch), on the road's own surface, amber beacons
// turning. Every few minutes one pulls over onto the shoulder and parks for 30-90 s (hazards flashing), only where
// the shoulder is clear (no guardrail, snow pole, sign or prop where it sweeps in, no junction, stop, car park,
// lay-by, roundabout or tee near), on a straight-ish, level stretch with flat ground under it; it also lets a queue
// of cars stuck behind it go by (a short stop), and pulls back out when nothing comes from behind.
// They stop for you (on foot or in your car) and for cars / the bus / other machines in their way; the traffic and
// the ski bus see them (traffic.js addTrafficBlocker); each is solid (one moving collider: you hit it like a car).
// Only those near you are fully simulated; far away they just move along their round (and park) on timers.
// At dusk / night: headlights + the beacons (additive point sprites, one draw call for all) and a pool of light on
// the road ahead of each moving machine. No THREE lights. Multiplayer: setOff(true) (no AI).
import * as THREE from 'three';
import { world } from './world.js';
import { fitModel, makeLOD, loadGLB } from '../core/assets.js';
import { qualityLevel, mulberry } from './crowds.js';
import { addTrafficBlocker, trafficBlockers } from '../game/traffic.js';
import { pickBeats, buildRound, roundAt, ahead, pullShift, plowSpotOk, PULL_LEN, PARK_LAT } from './plowroutes.js';

const COUNT = 3;             // machines on the roads
const BODY_LEN = 6.6;        // m, blade to the back (the Meshy machine)
const HW = 1.95, HD = 3.4;   // collider half width / length
const BLK_HW = 1.7;          // half width as the traffic / the bus see it (the body: the blade's tips overhang)
const SIM_R = 600;           // obstacle checks (you, the cars, the bus) within this of the player
const SHOW_R = 1400;         // drawn within this of the camera
const ACC = 0.6, BRK = 2.5;  // m/s^2

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _size = new THREE.Vector2();
const _a = {}, _b = {};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hazardOn = () => (Math.floor(performance.now() / 380) % 2 ? 1 : 0);
// a box (yaw: its +z, hw / hd) seen from heading (fx, fz): its extent across and along
function extents(yaw, hw, hd, fx, fz, out) {
  const ca = Math.abs(Math.sin(yaw) * fx + Math.cos(yaw) * fz), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
  out.across = hw * ca + hd * sa; out.along = hw * sa + hd * ca;
  return out;
}
const _ext = {};

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
   * @param {Array}  [o.colliders]   the game's colliders (the roadside props a machine won't park on; the cars and
   *                                 the bus it stops for); each machine's own moving collider is in this.colliders
   *                                 (push them into the game's list once)
   * @param {string} [o.quality]     preset name (default: the live engine/quality.js preset)
   */
  constructor(scene, { models = {}, colliders = [], quality } = {}) {
    this.scene = scene;
    this.all = colliders;
    this.level = qualityLevel(quality);
    this.cats = [];
    this.colliders = [];
    this.group = new THREE.Group();
    this.group.name = 'snowcats';
    scene.add(this.group);
    this.rnd = mulberry(5150);
    this.light = 0;
    this.rounds = [];
    try { this.rounds = pickBeats(COUNT).map((b) => buildRound(b)).filter((R) => R.n > 20); } catch (e) { console.warn('snow ploughs: rounds', e); }
    const count = this.rounds.length;
    if (!count) return;
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
    // pools of headlight on the road (medium and up)
    this.poolTex = this.level >= 2 ? poolTexture() : null;
    for (let i = 0; i < count; i++) this.cats.push(this.makeCat(i, this.rounds[i]));
    if (models.snowcat) this.useModel(models.snowcat);
    else loadGLB('snowcat').then((g) => g && this.useModel(g));
    // the traffic and the ski bus brake for them (and queue / overtake)
    const pool = this.cats.map(() => ({ hw: BLK_HW, hd: HD, mine: true }));
    this.unblock = addTrafficBlocker((out) => {
      if (this.off) return;
      for (const c of this.cats) {
        const b = pool[c.i];
        b.x = c.x; b.z = c.z; b.y = c.shown ? c.y : undefined; b.yaw = c.heading; b.v = c.v;
        out.push(b);
      }
    });
  }

  makeCat(i, R) {
    const root = new THREE.Group();
    root.name = 'snowcat';
    const body = proceduralCat();
    root.add(body);
    this.shade(root);
    root.visible = false;
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
    const col = { x: 1e9, z: 1e9, hw: HW, hd: HD, rot: 0, plough: true };
    this.colliders.push(col);
    const rnd = this.rnd;
    const c = {
      i, R, root, body, pool, col, u: rnd() * R.L, v: 0, cruise: 7.6 + rnd() * 2.6, mode: 'drive', park: null,
      parkT: 40 + i * 50 + rnd() * 120, wait: 0, q: 0, queueT: 0, stuckT: 0, ignoreT: 0, outT: 0,
      heading: 0, x: 0, y: 0, z: 0, shown: false, poolAt: new THREE.Vector3(1e9, 0, 0), beacon: rnd() * 6,
    };
    this.pose(c);
    c.y = world.height(c.x, c.z);
    return c;
  }

  useModel(gltf) {
    const opts = { size: BODY_LEN, axis: 'z', rotateY: Math.PI / 2 }; // the blade (model -x) leads
    this.lamps = fitLamps(fitModel(gltf, opts));
    for (const c of this.cats) {
      // a decimated copy beyond 60-130 m
      const lod = makeLOD(gltf, opts, this.level ? 130 : 60, 0.03);
      c.root.remove(c.body);
      c.body = lod;
      c.root.add(lod);
      this.shade(c.root);
    }
  }

  // shadows from high up (the performance preset keeps its shadow map for the skier and the near props)
  shade(root) {
    const cast = this.level >= 2;
    root.traverse((o) => { if (o.isMesh) { o.castShadow = cast && o.castShadow !== false; o.receiveShadow = true; } });
  }

  hide(c) {
    c.root.visible = false;
    c.shown = false;
    if (c.pool) c.pool.visible = false;
    c.col.x = c.col.z = 1e9;
  }

  // ---------------------------------------------------------------- along the round
  // the extra shift to the right (pulling over / parked / pulling out) at d m from where it is now
  latAt(c, d) {
    if (c.mode === 'parked') return PARK_LAT;
    if (c.mode === 'in') { let k = ahead(c.R, c.u + d, c.park.u); if (k > c.R.L / 2) k = 0; return pullShift(PULL_LEN - k); }
    if (c.mode === 'out') return pullShift(PULL_LEN - (c.q + d));
    return 0;
  }
  // position + heading: the middle of its front and back on the round (smooth through the bends and the turns)
  pose(c) {
    const R = c.R, A = roundAt(R, c.u + 2.4, _a), la = this.latAt(c, 2.4);
    const ax = A.x - A.tz * la, az = A.z + A.tx * la;
    const B = roundAt(R, c.u - 2.4, _b), lb = this.latAt(c, -2.4);
    const bx = B.x - B.tz * lb, bz = B.z + B.tx * lb;
    c.x = (ax + bx) / 2; c.z = (az + bz) / 2;
    if (Math.abs(ax - bx) + Math.abs(az - bz) > 1e-4) c.heading = Math.atan2(ax - bx, az - bz);
  }

  // a parking spot from..to m ahead (the first that is clear); dur: how long it stays
  tryPark(c, from, to, dur) {
    const R = c.R;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let d = from - PULL_LEN - 10; d <= to + 10; d += 10) { roundAt(R, c.u + d, _a); x0 = Math.min(x0, _a.x); x1 = Math.max(x1, _a.x); z0 = Math.min(z0, _a.z); z1 = Math.max(z1, _a.z); }
    x0 -= 14; x1 += 14; z0 -= 14; z1 += 14;
    const mine = new Set(this.colliders), statics = [];
    for (const o of this.all) if (!o.traffic && !o.bus && !mine.has(o) && !o.rail && o.x > x0 && o.x < x1 && o.z > z0 && o.z < z1) statics.push(o);
    const avoid = this.cats.filter((o) => o !== c).map((o) => ({ x: o.x, z: o.z, r: 80 }));
    if (this.pp) avoid.push({ x: this.pp.x, z: this.pp.z, r: 12 });
    const height = (x, z) => world.groundHeight(x, z, c.y + 3);
    for (let d = from; d <= to; d += 6) {
      if (!plowSpotOk(R, c.u + d, { statics, height, hw: HW, hd: HD, avoid })) continue;
      c.park = { u: (c.u + d) % R.L, dur };
      c.mode = 'in';
      return true;
    }
    return false;
  }

  // nothing coming up behind it in the lane (to pull back out): cars, the bus, you
  clearBehind(c) {
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
    const near = (x, z) => { const dx = x - c.x, dz = z - c.z, al = dx * fx + dz * fz; return al > -55 && al < 6 && Math.abs(dx * fz - dz * fx) < 5.5; };
    for (const m of this.movers || []) if (m.x < 1e8 && near(m.x, m.z) && Math.cos(-m.rot - c.heading) > 0.3) return false;
    if (this.pp && near(this.pp.x, this.pp.z)) return false;
    return true;
  }

  // the speed it may go with what is in its way: you, the cars and the bus, the other machines, a train or a
  // helicopter on the road; and the queue behind it (it lets them by: a short stop)
  obstacles(c, pp, dt) {
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
    const look = 10 + (c.v * c.v) / (2 * 1.6) + HD;
    let lim = Infinity, byMover = false, queued = false;
    // you (on foot or in your car)
    {
      const ox = pp.x - c.x, oz = pp.z - c.z, al = ox * fx + oz * fz, sd = Math.abs(ox * fz - oz * fx);
      if (ox * ox + oz * oz < 22) lim = 0;
      else if (al > -2 && al < look + 5 && sd < BLK_HW + 1.6) lim = Math.min(lim, Math.max(0, (al - HD - 4) * 0.5));
    }
    const box = (x, z, yaw, hw, hd, mover) => {
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > look + 30 || Math.abs(dz) > look + 30) return;
      const al = dx * fx + dz * fz, sd = Math.abs(dx * fz - dz * fx), e = extents(yaw, hw, hd, fx, fz, _ext);
      if (al - e.along > -1 && al < look + e.along && sd < BLK_HW + e.across + 0.35) {
        const v = Math.max(0, (al - HD - e.along - 3) * 0.5);
        if (v < lim) { lim = v; byMover = mover; }
      } else if (mover && al < -HD && al > -HD - 32 && sd < 2.2 && Math.cos(yaw - c.heading) > 0.8) queued = true;
    };
    if (c.ignoreT > 0) c.ignoreT -= dt;
    else {
      for (const m of this.movers || []) if (m.x < 1e8) box(m.x, m.z, -m.rot, m.hw, m.hd, true);
      for (const o of this.cats) if (o !== c && !this.off) box(o.x, o.z, o.heading, BLK_HW, HD, true);
    }
    for (const b of this.blk || []) {
      if (b.mine || (b.y !== undefined && Math.abs(b.y - c.y) > 5)) continue;
      box(b.x, b.z, b.yaw, b.hw, b.hd, false);
    }
    // (stood facing a car that waits for it, e.g. turning round: after 8 s it goes on anyway)
    if (lim < 0.3 && byMover) { c.stuckT += dt; if (c.stuckT > 8) { c.stuckT = 0; c.ignoreT = 4; } } else c.stuckT = 0;
    c.queueT = queued ? c.queueT + dt : Math.max(0, c.queueT - dt * 0.5);
    return lim;
  }

  drive(c, dt, pp) {
    const R = c.R, rnd = this.rnd;
    if (c.mode === 'parked') {
      c.v = 0;
      c.wait -= dt;
      if (c.wait <= 0) {
        c.outT += dt;
        if (!pp || c.outT > 20 || this.clearBehind(c)) { c.mode = 'out'; c.q = 0; c.outT = 0; }
      }
      this.pose(c);
      return;
    }
    if (c.mode === 'drive') {
      // (Oct 30 2026, the user: after heavy snow or a blizzard the ploughs "go out more often": up to 3x longer on
      // the road between stops, and shorter stops; this.plough (sky.js) eases back over ~5 min)
      c.parkT -= dt / (1 + 2 * (this.plough || 0));
      if (c.parkT <= 0) { if (!this.tryPark(c, 40, 450, (30 + rnd() * 60) * (1 - 0.6 * (this.plough || 0)))) c.parkT = 25; }
      else if (c.queueT > 35) { c.queueT = 15; this.tryPark(c, 25, 260, 8 + rnd() * 8); } // (letting the queue by)
    }
    let vt = Math.min(c.cruise, R.VT[roundAt(R, c.u, _a).i]);
    if (c.mode === 'in') {
      let d = ahead(R, c.u, c.park.u);
      if (d > R.L - 6) d = 0; // (just past it)
      vt = Math.min(vt, Math.sqrt(2 * 0.7 * Math.max(0, d - 0.15)));
      if (d < PULL_LEN + 15) vt = Math.min(vt, 4.5);
      if (d < 0.35 && c.v < 0.5) { c.mode = 'parked'; c.u = c.park.u; c.v = 0; c.wait = c.park.dur; c.outT = 0; this.pose(c); return; }
    } else if (c.mode === 'out') vt = Math.min(vt, 3 + c.q * 0.25);
    if (pp) vt = Math.min(vt, this.obstacles(c, pp, dt));
    c.v += clamp(vt - c.v, -BRK * dt, ACC * dt);
    if (c.v < 0) c.v = 0;
    const du = c.v * dt;
    c.u = (c.u + du) % R.L;
    if (c.mode === 'out') { c.q += du; if (c.q >= PULL_LEN) { c.mode = 'drive'; c.parkT = 150 + rnd() * 210; } }
    this.pose(c);
  }

  // ---------------------------------------------------------------- per frame
  /** Multiplayer: no snow ploughs (true). They are hidden (lamps out, colliders moved away) and come back on false. */
  setOff(off) { this.off = !!off; this.offDone = false; }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {object} env          the sky Environment (nightFactor / dayFactor)
   * @param {object} player       the Player (pos)
   * @param {THREE.WebGLRenderer} [renderer]  (size of the light sprites)
   */
  update(dt, camera, env, player, renderer) {
    if (!this.cats.length || !(dt > 0)) return;
    if (this.off) {
      if (!this.offDone) {
        this.offDone = true;
        for (const c of this.cats) this.hide(c);
        if (this.glow) { this.glow.visible = false; this.updateLamps(camera, 0, renderer); }
      }
      return;
    }
    dt = Math.min(dt, 0.1);
    const pp = player.pos, cam = camera.position;
    this.pp = pp;
    // the moving colliders (the traffic's cars, the bus): looked up again when the list grows
    if (this.allN !== this.all.length) {
      this.allN = this.all.length;
      const mine = new Set(this.colliders);
      this.movers = this.all.filter((o) => (o.traffic || o.bus) && !mine.has(o));
    }
    const light = Math.max(env.nightFactor, (1 - env.dayFactor) * 0.6);
    this.light = light;
    this.plough = env.plough || 0; // (sky.js: after heavy snow / a blizzard)
    let any = false;
    this.blk = null;
    for (const c of this.cats) {
      const nearP = Math.hypot(c.x - pp.x, c.z - pp.z) < SIM_R;
      if (nearP && !this.blk) { try { this.blk = trafficBlockers(); } catch { this.blk = []; } }
      try { this.drive(c, dt, nearP ? pp : null); } catch (e) { if (!this.warned) { this.warned = true; console.warn('snow plough', e); } }
      const show = Math.hypot(c.x - cam.x, c.z - cam.z) < SHOW_R;
      if (show && !c.shown) c.y = world.height(c.x, c.z); // (its height hint, stale while it was out of sight)
      c.root.visible = show;
      c.shown = show;
      if (show) { any = true; this.dress(c, cam, light); } else if (c.pool) c.pool.visible = false;
      const solid = show || nearP;
      c.col.x = solid ? c.x : 1e9; c.col.z = solid ? c.z : 1e9; c.col.rot = -c.heading;
    }
    if (this.glow) {
      this.glow.visible = any;
      if (any) this.updateLamps(camera, light, renderer);
    }
  }

  dress(c, cam, light) {
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading), rx = fz, rz = -fx; // rx: the machine's local +x
    const a = 2.6, b = 1.6, yh = c.y + 2;
    const hF = world.groundHeight(c.x + fx * a, c.z + fz * a, yh), hB = world.groundHeight(c.x - fx * a, c.z - fz * a, yh);
    const hL = world.groundHeight(c.x + rx * b, c.z + rz * b, yh), hR = world.groundHeight(c.x - rx * b, c.z - rz * b, yh);
    const y = (hF + hB + hL + hR) / 4 - 0.02;
    c.y = y;
    c.root.position.set(c.x, y, c.z);
    _e.set(Math.atan2(hB - hF, 2 * a), c.heading, Math.atan2(hL - hR, 2 * b));
    c.root.rotation.copy(_e);
    // the beam on the road ahead (at night, moving, near the camera)
    if (c.pool) {
      const show = light > 0.06 && c.mode !== 'parked' && Math.hypot(c.x - cam.x, c.z - cam.z) < 380;
      c.pool.visible = show;
      if (show) {
        c.pool.material.color.setRGB(1, 0.86, 0.66).multiplyScalar(light * 0.55);
        if (Math.abs(c.poolAt.x - c.x) + Math.abs(c.poolAt.z - c.z) > 0.4) {
          c.poolAt.set(c.x, 0, c.z);
          const pos = c.pool.geometry.attributes.position;
          for (let k = 0; k < pos.count; k++) {
            // PlaneGeometry(1, 1, 3, 4): u across (-0.5..0.5), v along (-0.5 back .. 0.5 front)
            const u = (k % 4) / 3 - 0.5, v = 0.5 - Math.floor(k / 4) / 4;
            const lx = u * (6 + (v + 0.5) * 6), lz = 3.4 + (v + 0.5) * 18;
            const x = c.x + rx * lx + fx * lz, z = c.z + rz * lx + fz * lz;
            pos.setXYZ(k, x, world.groundHeight(x, z, y + 2) + 0.12, z);
          }
          pos.needsUpdate = true;
        }
      }
    }
  }

  updateLamps(camera, light, renderer) {
    const P = this.lampPos, C = this.lampCol, t = performance.now() / 1000, lamps = this.lamps || LAMPS, hz = hazardOn();
    for (let ci = 0; ci < this.cats.length; ci++) {
      const c = this.cats[ci];
      const vis = c.shown, parked = c.mode === 'parked';
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
        } else if (parked) {
          // parked: headlights off, the lower pair flashing amber (hazards)
          const k2 = k >= 2 ? hz * (0.5 + light) * 1.6 : 0;
          C[o] = 1.0 * k2; C[o + 1] = 0.55 * k2; C[o + 2] = 0.08 * k2;
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
