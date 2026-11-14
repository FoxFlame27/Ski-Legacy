// Ski Legacy native port: reference poses of the skier rig (src/player/skier.js) for `ski_legacy --verify-poses`.
//
// Builds the game's own SkierRig in Node with real THREE (the rigged GLB, its _anims clips, the rental skis and the
// poles, exactly as main.js makeRig does for you), on a test ground (a plane the C++ check uses too), and replays a
// list of timelines frame by frame: standing, walking and running (the Meshy clips through THREE's AnimationMixer),
// carrying the skis, skiing straight / carving with pole plants / tucking / snowploughing / a hockey stop, a charged
// jump with the air and the landing, a flip with a grab and a spin, a crash (tumble, lying, getting up), sitting on a
// chair, on a bench (a car / bus / train seat) and astride a snowmobile. Every frame's input (dt, root position, the
// rig state, pole plants) goes into the file with every bone's local quaternion / position and the skis' and poles'
// transforms every 0.25 s, so the C++ replays exactly the same inputs and compares bone by bone.
// First person: timelines with st.fp (skiing with pole plants, a jump and the landing, walking, a wipeout) also run the
// view model after each frame (rig.updateFpView with a camera path and player.js's fpViewState: the gloves' and poles'
// transforms in the camera's frame, the cuffs) and record the head / arms folded away and the body's visibility.
// In a car: carpeople.js seatLegs on a seated rig in a car's frame (pitched, rolled: the taxi's fare, another player at
// the wheel), drive.js placeRig (you at the wheel, its own source run on a stand-in for the Drive: the cockpit and the
// chase view, the head under a low roof) and the traffic's seated figures (CarPeople.bakeOne, then fill's placement on
// each seat of the car).
//
// Usage (from the repo root):  node native/tools/ref_poses.mjs [out.json]   (default native/data/poses_ref.json; the crowd
// people's fans_ref.json beside it, see the end; SL_POSE_ONLY=fans writes only that one)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(ROOT, 'src');
const OUT = process.argv[2] || path.resolve(HERE, '../data/poses_ref.json');

// ---- a minimal browser for the modules skier.js imports (no rendering)
const fakeEl = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, children: [] }, {
  get: (o, k) => (k in o ? o[k] : typeof k === 'string' && /^[a-z]/.test(k) ? () => fakeEl() : undefined),
  set: (o, k, v) => { o[k] = v; return true; },
});
globalThis.document ??= { createElement: () => fakeEl(), createElementNS: () => fakeEl(), body: fakeEl(), head: fakeEl(), documentElement: fakeEl(),
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node', hardwareConcurrency: 4 };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener ??= () => {};
globalThis.requestAnimationFrame ??= () => 0;
globalThis.MutationObserver ??= class { observe() {} disconnect() {} takeRecords() { return []; } };
console.info = () => {};

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
await MeshoptDecoder.ready;
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
function stripTextures(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  delete json.textures; delete json.images; delete json.samplers;
  for (const m of json.materials || []) {
    const p = m.pbrMetallicRoughness || {};
    delete p.baseColorTexture; delete p.metallicRoughnessTexture; delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.extensions) for (const k of Object.keys(m.extensions)) delete m.extensions[k];
  }
  for (const k of ['extensionsUsed', 'extensionsRequired']) if (json[k]) json[k] = json[k].filter((e) => e !== 'EXT_texture_webp' && e !== 'KHR_texture_transform');
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + jl), head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + js.length + rest.length, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, js, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
async function glb(name) {
  const g = await new Promise((res, rej) => loader.parse(stripTextures(fs.readFileSync(path.join(ROOT, 'public/models', name + '.glb'))), '', res, rej));
  g.modelName = name;
  return g;
}

// ---- the test ground (the C++ check uses the same plane: verify_poses.cpp)
export const GROUND = { a: 0.08, b: -0.3, c: 0 };
const ground = (x, z) => GROUND.a * x + GROUND.b * z + GROUND.c;
const NRM = new THREE.Vector3(-GROUND.a, 1, -GROUND.b).normalize();
const { world } = await import(pathToFileURL(path.join(SRC, 'world/world.js')).href);
world.groundHeight = (x, z) => ground(x, z);
world.height = (x, z) => ground(x, z);

// deterministic Math.random (mulberry32; the C++ check feeds the rig the same sequence)
let seed = 1;
Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const { SkierRig } = await import(pathToFileURL(path.join(SRC, 'player/skier.js')).href);
const CP = await import(pathToFileURL(path.join(SRC, 'game/carpeople.js')).href);
await (await import('meshoptimizer')).MeshoptSimplifier.ready;
// drive.js placeRig, the game's own code: its source taken out of drive.js (the module itself needs the browser) and run
// on a stand-in for the Drive ({ d: { e: { car }, t, steer, eyeLocal }, player: { rig }, seat: { pos }, view })
function methodBody(src, sig) {
  const i = src.indexOf(sig), j = src.indexOf('{', i);
  let d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) break; }
  return src.slice(j + 1, k);
}
const placeRig = new Function('THREE', 'seatsFor', 'leanBack', 'underRoof', 'twoBone', 'seatLegs', 'wpos', 'wquat', 'setWQ', 'clamp',
  methodBody(fs.readFileSync(path.join(SRC, 'game/drive.js'), 'utf8'), '  placeRig() {'));
const clampD = (v, a, b) => (v < a ? a : v > b ? b : v);
// a car template as carpeople.js seatsFor matches it (its size and steering wheel: the SEATS entry exactly)
const SEATS_OF = {
  car_vw_golf_gti: { size: [4.30, 1.47], wheel: [0.919, 0.297], x: 0.35 },
  car_mercedes_sls: { size: [4.64, 1.26], wheel: [0.768, -0.095], x: 0.43 },
  car_porsche_taycan: { size: [4.96, 1.36], wheel: [0.834, 0.352], x: 0.37 },
  car_lamborghini_huracan: { size: [4.52, 1.18], wheel: [0.779, 0.359], x: 0.37 },
  car_audi_rs6: { size: [5.00, 1.50], wheel: [0.916, 0.469], x: 0.381 },
};
const templ = (name) => { const s = SEATS_OF[name]; return { size: new THREE.Vector3(1.9, s.size[1], s.size[0]), steering: { c: new THREE.Vector3(s.x, s.wheel[0], s.wheel[1]), tilt: 0.38, rimR: 0.185 } }; };
const carG = (x, y, z, yaw, pitch, roll) => { const g = new THREE.Object3D(); g.position.set(x, y, z); g.rotation.set(pitch, yaw, roll, 'YXZ'); g.updateMatrixWorld(true); return g; };
const CHAR = process.env.SL_POSE_CHAR || 'skier_red';
const body = await glb(`${CHAR}_rigged`), anims = await glb(`${CHAR}_anims`), ski = await glb('ski_rental'), pole = await glb('ski_pole');
const find = (re) => anims.animations.find((c) => re.test(c.name));
const clips = { idle: find(/^Idle/i), walk: find(/Walk/i), run: find(/Run/i) };

// ---------------------------------------------------------------- timelines
const DT = 1 / 60;
const smooth = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function timeline(name, secs, fn, { x0 = 3, z0 = -2, heading = 0.6, carry = false, snap = true, dt = DT } = {}) {
  const frames = [];
  const pos = { x: x0, z: z0, y: 0 };
  let hd = heading;
  const n = Math.round(secs / dt);
  for (let f = 0; f < n; f++) {
    const t = f * dt;
    const r = fn(t, f) || {};
    const st = { heading: hd, speed: 0, crouch: 0, lean: 0, edge: 0, tuck: false, plow: 0, skid: 0, normal: [NRM.x, NRM.y, NRM.z], air: false, ...r.st };
    if (r.turn) hd += r.turn * dt;
    st.heading = r.st?.heading ?? hd;
    const v = st.speed || 0;
    if (!r.hold) { pos.x += Math.sin(hd) * v * dt; pos.z += Math.cos(hd) * v * dt; }
    pos.y = ground(pos.x, pos.z) + (r.dy || 0);
    frames.push({ dt, pos: [pos.x, pos.y, pos.z], st, plant: r.plant || null, sample: f % 15 === 14 || f === n - 1, fpv: r.fpv || null, car: r.car || null, snap: !!r.snap });
  }
  return { name, carry, snap, frames };
}
const tls = [];
tls.push(timeline('idle', 6, () => ({ st: { mode: 'idle', speed: 0 } })));
tls.push(timeline('walk', 3, (t) => ({ st: { mode: t < 0.5 ? 'idle' : 'walk', speed: t < 0.5 ? 0 : Math.min(1.4, (t - 0.5) * 3) } })));
tls.push(timeline('run', 3, (t) => ({ st: { mode: 'walk', speed: Math.min(4, 1 + t * 3) }, turn: t > 1.5 ? 0.6 : 0 })));
tls.push(timeline('walk_slow', 2.5, () => ({ st: { mode: 'walk', speed: 1.3 } })));
tls.push(timeline('walk_stop', 3, (t) => ({ st: { mode: t < 1.5 ? 'walk' : 'idle', speed: t < 1.5 ? 1.7 : 0 } })));
tls.push(timeline('carry', 2.5, (t) => ({ st: { mode: t < 0.4 ? 'idle' : 'walk', speed: t < 0.4 ? 0 : 1.6, carry: true } }), { carry: true }));
tls.push(timeline('ski_straight', 2, () => ({ st: { mode: 'ski', speed: 10, crouch: 0.2 } }), { heading: Math.PI }));
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
let lastS = 0;
tls.push(timeline('carve', 5, (t) => {
  const e = 0.8 * Math.sin(t * Math.PI), s = sgn(Math.round(e * 1.5));
  let plant = null;
  if (s !== 0 && s !== lastS) plant = [s > 0 ? 0 : 1];
  lastS = s;
  return { st: { mode: 'ski', speed: 15, crouch: 0.2 + Math.abs(e) * 0.08, edge: e, lean: Math.max(-1, Math.min(1, e / 0.8)) }, turn: -e * 0.8, plant };
}, { heading: Math.PI + 0.3 }));
tls.push(timeline('carve_right', 2, () => ({ st: { mode: 'ski', speed: 18, crouch: 0.25, edge: -0.75, lean: -0.94 }, turn: 0.7 }), { heading: Math.PI }));
tls.push(timeline('tuck', 2, (t) => ({ st: { mode: 'ski', speed: 22, crouch: 0.21, tuck: t > 0.3 } }), { heading: Math.PI }));
tls.push(timeline('plow', 2, (t) => ({ st: { mode: 'ski', speed: 4, crouch: 0.3, plow: Math.min(1, t) } }), { heading: Math.PI }));
tls.push(timeline('hockey', 2, (t) => ({ st: { mode: 'ski', speed: Math.max(0, 9 - t * 4), crouch: 0.3, skid: Math.min(1.05, t * 2), edge: -0.45 * Math.min(1, t * 2), lean: -0.56 * Math.min(1, t * 2) } }), { heading: Math.PI }));
// a charged jump: the charge builds 0.7 s, the pop, 0.9 s in the air over the slope, the landing absorbed
tls.push(timeline('jump', 3.2, (t) => {
  const st = { mode: 'ski', speed: 12, crouch: 0.2 };
  let dy = 0;
  if (t < 0.7) { st.charge = t / 0.7; st.crouch = 0.3 + 0.62 * st.charge; }
  else if (t < 0.75) st.crouch = -0.15;
  else if (t < 1.65) { const a = t - 0.75; dy = 4.2 * a - 4.905 * a * a + 0.3 * a * 12 * 0.3; st.air = true; st.crouch = 0.32; st.normal = [0, 1, 0]; }
  else { const a = t - 1.65; st.crouch = 0.2 + 0.6 * Math.exp(-a * 5) * Math.sin(Math.min(Math.PI, a * 9) + 0.4); }
  return { st, dy: Math.max(0, dy) };
}, { heading: Math.PI }));
tls.push(timeline('trick', 2.2, (t) => {
  const st = { mode: 'ski', speed: 12, crouch: 0.32, air: true, normal: [0, 1, 0] };
  const a = Math.min(t, 1.6);
  st.flip = smooth(a, 0.1, 1.4) * Math.PI * 2;
  st.flipHeading = Math.PI;
  st.grab = smooth(a, 0.2, 0.5) * (1 - smooth(a, 1.0, 1.3));
  st.grabType = t < 1.1 ? 'mute' : 'japan';
  st.spinVel = 6 * (1 - smooth(a, 1.2, 1.5));
  const dy = t < 1.6 ? 5.5 * t - 4.905 * t * t + 1.0 : 0;
  if (t >= 1.6) { st.air = false; st.normal = undefined; }
  return { st, dy: Math.max(0, dy), turn: st.spinVel };
}, { heading: Math.PI }));
tls.push(timeline('crash', 5, (t) => {
  const st = { mode: 'fall', speed: 0, fallSide: 1, fallHeading: Math.PI + 0.2 };
  const ball = 1 - smooth(t, 1.2, 2.0), getUp = smooth(t, 3.4, 4.8);
  st.fall = { ball, getUp, pitch: Math.min(t, 1.5) * 5.2 * (1 - smooth(t, 1.5, 2.2)) + (t > 1.5 ? 0 : 0), roll: 0.9 * smooth(t, 1.0, 2.2) * (1 - getUp) };
  st.fallT = t / 0.6;
  st.fallAir = t < 0.25;
  return { st, hold: true };
}, { heading: Math.PI }));
tls.push(timeline('crash_roll', 3, (t) => {
  const st = { mode: 'fall', speed: 0, fallSide: -1, fallHeading: 2.0 };
  st.fall = { ball: 0.6 * (1 - smooth(t, 0.8, 1.8)), getUp: 0, pitch: 0, roll: -t * 3.1 * (1 - smooth(t, 1.4, 2.4)) };
  st.fallT = t / 0.6;
  return { st, hold: true };
}, { heading: 2.0 }));
const seatAt = (x, z, h) => [x, ground(x, z) + h, z];
tls.push(timeline('sit_chair', 2, () => ({ st: { mode: 'sit', speed: 0, seat: seatAt(3, -2, 0.55), normal: [0, 1, 0] }, hold: true })));
tls.push(timeline('sit_chair_skis', 2, () => ({ st: { mode: 'sit', speed: 0, seat: seatAt(3, -2, 6), normal: [0, 1, 0] }, hold: true })));
tls.push(timeline('sit_bench', 2, () => ({ st: { mode: 'sit', speed: 0, seat: seatAt(3, -2, 0.48), normal: [0, 1, 0], bench: { back: -0.3, front: 0.26, floorY: ground(3, -2) + 0.02, recline: 0.15 } }, hold: true })));
tls.push(timeline('sit_car', 2, () => ({ st: { mode: 'sit', speed: 0, seat: seatAt(3, -2, 0.4), normal: [0, 1, 0], bench: { back: -0.22, front: 0.3, floorY: ground(3, -2) + 0.12, recline: 0.35 } }, hold: true })));
tls.push(timeline('sled', 2.5, (t) => ({ st: { mode: 'sit', speed: 0, seat: seatAt(3, -2, 0.75), normal: [0, 1, 0],
  sled: { grip: { x: 0.32, y: 0.3, z: 0.62 }, foot: { x: 0.24, y: -0.42, z: 0.22 }, pivot: 0.55, turn: 0.45, steer: Math.sin(t * 2) } }, hold: true }), { carry: true }));

// ---- first person: the view model rides on a camera (an eye over the feet, the skis' heading, a little look down)
const fpCam = (pos, hd, t, bump = 0) => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.26 + 0.05 * Math.sin(t * 1.3), hd + Math.PI, 0.04 * Math.sin(t * 0.9), 'YXZ'));
  return [pos.x + 0.04 * Math.sin(hd), pos.y + 1.52 + bump, pos.z + 0.04 * Math.cos(hd), q.x, q.y, q.z, q.w];
};
let lastF = 0;
{
  const P = { x: 3, z: -2, hd: Math.PI + 0.3 };
  tls.push(timeline('fp_ski', 5, (t) => {
    // carving with pole plants, then a pop, 0.7 s in the air and a hard landing (the head's bump spring, the absorb)
    const e = t < 2.6 ? 0.7 * Math.sin(t * Math.PI * 1.2) : 0, s = sgn(Math.round(e * 1.5));
    let plant = null;
    if (s !== 0 && s !== lastF) plant = [s > 0 ? 0 : 1];
    if (t > 0.3 && t < 0.32) plant = [0, 1];   // (a double-pole stroke)
    lastF = s;
    const air = t > 3 && t < 3.7, a = t - 3, land = t >= 3.7 ? Math.exp(-(t - 3.7) * 6) : 0;
    const dy = air ? Math.max(0, 3.4 * a - 4.905 * a * a) : 0;
    const st = { mode: 'ski', speed: 14, crouch: 0.2 + Math.abs(e) * 0.08 + 0.4 * land, edge: e, lean: Math.max(-1, Math.min(1, e / 0.8)), fp: true, air };
    if (air) st.normal = [0, 1, 0];
    P.hd += -e * 0.8 * DT;
    P.x += Math.sin(P.hd) * 14 * DT; P.z += Math.cos(P.hd) * 14 * DT;
    const y = ground(P.x, P.z) + dy;
    const fpv = { cam: fpCam({ x: P.x, y, z: P.z }, P.hd, t, -0.05 * land), skiing: true, speed: 14, air, absorb: 0.6 * land, brake: Math.max(0, Math.abs(e) - 0.5), rough: t < 2 ? 0.25 : 1 };
    return { st, turn: -e * 0.8, plant, fpv, dy };
  }, { heading: Math.PI + 0.3 }));
}
tls.push(timeline('fp_walk', 2.5, (t) => ({ st: { mode: t < 0.5 ? 'idle' : 'walk', speed: t < 0.5 ? 0 : 1.5, fp: true },
  fpv: { cam: fpCam({ x: 3, y: ground(3, -2), z: -2 }, 0.6, t), skiing: false } })));
tls.push(timeline('fp_fall', 3, (t) => {
  if (t < 1) return { st: { mode: 'ski', speed: 10, crouch: 0.2, fp: true }, fpv: { cam: fpCam({ x: 3, y: ground(3, -2), z: -2 }, Math.PI, t), skiing: true, speed: 10, rough: 0.25 } };
  const st = { mode: 'fall', speed: 0, fallSide: 1, fallHeading: Math.PI, fp: true, fall: { ball: 1, getUp: 0, pitch: (t - 1) * 3, roll: 0 }, fallT: (t - 1) / 0.6 };
  return { st, hold: true, fpv: { cam: fpCam({ x: 3, y: ground(3, -2), z: -2 }, Math.PI, t), skiing: false } };
}, { heading: Math.PI }));
// ---- in a car
const M16 = (g) => Array.from(g.matrixWorld.elements);
{
  // the taxi's fare (taxi.js posePax: the 'sit' pose at the seat point, then seatLegs with the hands on the thighs): a
  // low two-seater (beside you: its head under the roof), and the back seat of a hatchback; another player at the wheel
  // (remote.js carLegs: the driver's feet on the pedals)
  const cases = [['car_leg_pax', 'car_mercedes_sls', 1, false, carG(3, ground(3, -2) - 0.05, -2, 0.6, 0.06, -0.03)],
    ['car_leg_rear', 'car_vw_golf_gti', 3, false, carG(3, ground(3, -2), -2, 2.2, -0.08, 0.02)],
    ['car_leg_driver', 'car_porsche_taycan', 0, true, carG(3, ground(3, -2), -2, -1.0, 0.04, 0.05)]];
  for (const [name, model, seat, driver, g] of cases) {
    const T = templ(model), S = CP.seatsFor(T);
    // (taxi.js carSeats: the seat point on the cushion, DEPTH ahead of the backrest)
    const sx = seat === 0 || seat === 2 ? (seat < 2 ? S.d[0] : S.r[0]) : -(seat < 2 ? S.d[0] : S.r[0]), ss = seat < 2 ? (seat === 1 ? S.p || S.d.slice(1) : S.d.slice(1)) : S.r.slice(1);
    const sp = g.localToWorld(new THREE.Vector3(sx, ss[0] - 0.01 + CP.SEAT_LIFT, ss[1] + ss[2] * (0.1 - 0.15) + 0.13));
    tls.push(timeline(name, 1, () => ({ st: { mode: 'sit', speed: 0, seat: [sp.x, sp.y, sp.z], normal: [0, 1, 0], heading: g.rotation.y },
      hold: true, dy: sp.y - ground(sp.x, sp.z), car: { kind: 'legs', model, sizeY: T.size.y, g: M16(g), seat, driver, hands: true } }), { x0: sp.x, z0: sp.z, heading: g.rotation.y }));
  }
  // you at the wheel (drive.js placeRig): inside a hatchback turning the wheel, and in the chase view of a low sports car
  // (its roof: the head let down and the slouch, underRoof with the wheel)
  for (const [name, model, inside, steer, g] of [['car_driver_in', 'car_vw_golf_gti', true, 0.22, carG(3, ground(3, -2), -2, 0.6, 0.05, -0.04)],
    ['car_driver_out', 'car_lamborghini_huracan', false, -0.15, carG(3, ground(3, -2), -2, 1.4, -0.03, 0.03)]]) {
    const T = templ(model), hip = CP.seatHip(T, 0.1, 0.42), sp = g.localToWorld(new THREE.Vector3(hip.x, hip.y - 0.1, hip.z));
    tls.push(timeline(name, 1, () => ({ st: { mode: 'sit', speed: 0, seat: [sp.x, sp.y, sp.z], normal: [0, 1, 0], heading: g.rotation.y, fp: inside },
      hold: true, dy: sp.y - ground(sp.x, sp.z), car: { kind: 'driver', model, sizeY: T.size.y, g: M16(g), inside, steer } }), { x0: sp.x, z0: sp.z, heading: g.rotation.y }));
  }
  // the traffic's people (carpeople.js bakeOne at the origin, two 'sit' updates, then fill on the seats): a driver baked
  // for the Taycan, a passenger with the hands in the lap (look 1) in an RS6 (its own front passenger seat)
  const figSt = { mode: 'sit', speed: 0, seat: [0, 0, 0], heading: 0, lookYaw: 0, normal: undefined, crouch: undefined, lean: undefined, edge: undefined, tuck: undefined, plow: undefined, skid: undefined, air: undefined };
  tls.push(timeline('car_fig_driver', 2 * 0.016, () => ({ st: figSt, snap: true, hold: true,
    car: { kind: 'figure', model: 'car_porsche_taycan', sizeY: templ('car_porsche_taycan').size.y, driver: true, look: 0 } }), { x0: 0, z0: 0, heading: 0, dt: 0.016 }));
  tls.push(timeline('car_fig_pass', 2 * 0.016, () => ({ st: figSt, snap: true, hold: true,
    car: { kind: 'figure', model: 'car_audi_rs6', sizeY: templ('car_audi_rs6').size.y, driver: false, look: 1 } }), { x0: 0, z0: 0, heading: 0, dt: 0.016 }));
}

// ---------------------------------------------------------------- replay through the JS rig
const v3 = (a) => (a ? new THREE.Vector3(a[0], a[1], a[2]) : undefined);
const fpCamera = new THREE.PerspectiveCamera(78, 16 / 9, 0.08, 1000);
// CarPeople.bakeOne after its two 'sit' updates (the same source lines: the rest of the method run on this rig)
const bakeSrc = methodBody(fs.readFileSync(path.join(SRC, 'game/carpeople.js'), 'utf8'), '  bakeOne(rig, n, role, S) {')
  .replace(/for \(let k = 0; k < 2; k\+\+\) \{ rig\.snapNext = true; rig\.update\([^;]*;[^}]*\}/, '/* (the two updates: the timeline) */');
const bakeOneRest = new Function('THREE', 'leanBack', 'poseSeated', 'seatLegs', 'twoBone', 'setWQ', 'wquat', 'wpos', 'originAt', 'bake', 'RECLINE', 'RIGHT', 'FWD', 'SEAT_LIFT', 'rig', 'n', 'role', 'S', bakeSrc);
const { poseSeated } = await import(pathToFileURL(path.join(SRC, 'world/seatpose.js')).href);
// (carpeople.js internals the method uses: originAt, RECLINE, RIGHT, FWD, bake; taken from its source the same way)
const cpSrc = fs.readFileSync(path.join(SRC, 'game/carpeople.js'), 'utf8');
const originAtFn = new Function('THREE', 'DEPTH', 'DEPTH_U', 'SEAT_LIFT', 'x', 's', 'hip', 'chest', methodBody(cpSrc, 'function originAt(x, s, hip, chest) {'));
const num = (re) => +cpSrc.match(re)[1];
const DEPTH = num(/const DEPTH = ([0-9.]+)/), DEPTH_U = num(/DEPTH_U = ([0-9.]+)/), RECLINE = num(/const RECLINE = ([0-9.]+)/);
const { MeshoptSimplifier } = await import('meshoptimizer');
const bakeFn = new Function('THREE', 'MeshoptSimplifier', 'mesh', 'tris', methodBody(cpSrc, 'function bake(mesh, tris) {'));
function bakeRest(rig, n, role, S) {
  return bakeOneRest(THREE, CP.leanBack, poseSeated, CP.seatLegs, CP.twoBone, CP.setWQ, CP.wquat, CP.wpos,
    (x, s, hip, chest) => originAtFn(THREE, DEPTH, DEPTH_U, CP.SEAT_LIFT, x, s, hip, chest), (m, t) => bakeFn(THREE, MeshoptSimplifier, m, t),
    RECLINE, new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), CP.SEAT_LIFT, rig, n, role, S);
}
const r6 = (x) => +x.toFixed(6);
const out = { char: CHAR, ground: GROUND, bones: null, timelines: [] };
const ONLY_FANS = process.env.SL_POSE_ONLY === 'fans'; // (SL_POSE_ONLY=fans: just the crowd people's fans_ref.json)
for (const tl of ONLY_FANS ? [] : tls) {
  seed = 12345;
  const rig = new SkierRig(body, { ski, pole, clips });
  // (the constructor's random phases: fixed, the C++ sets the same)
  rig.gait.phase = 0.3; rig.gait.t = 10; rig.idle.t = 4.5; rig.sk.t = 7;
  seed = 777;
  rig.setSkisVisible(true);
  rig.setCarry(tl.carry);
  if (!out.bones) out.bones = rig.allBones.map((b) => b.name);
  const samples = [];
  tl.frames.forEach((F, fi) => {
    rig.root.position.set(F.pos[0], F.pos[1], F.pos[2]);
    if (F.car?.kind === 'figure') rig.root.position.set(0, 0, 0);
    if (F.snap) rig.snapNext = true;
    const s = { ...F.st, normal: v3(F.st.normal), seat: v3(F.st.seat) };
    if (F.plant) {
      const fw = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading)), r = new THREE.Vector3().crossVectors(fw, new THREE.Vector3(0, 1, 0));
      for (const side of F.plant) rig.startPolePlant(side, fw, r);
    }
    rig.update(F.dt, s);
    let extra = null;
    if (F.fpv) {
      // (the Meshy arms: syncFpArms reports them loaded, so the fists turn their forearms toward the elbow)
      rig.syncFpArms = () => true;
      fpCamera.position.set(F.fpv.cam[0], F.fpv.cam[1], F.fpv.cam[2]);
      fpCamera.quaternion.set(F.fpv.cam[3], F.fpv.cam[4], F.fpv.cam[5], F.fpv.cam[6]);
      rig.updateFpView(F.dt, fpCamera, F.fpv);
    }
    if (F.car) {
      const C = F.car, T = templ(C.model);
      const g = new THREE.Object3D();
      if (C.g) { g.matrix.fromArray(C.g); g.matrix.decompose(g.position, g.quaternion, g.scale); g.updateMatrixWorld(true); }
      if (C.kind === 'legs') CP.seatLegs(rig, g, T, C.seat, { driver: C.driver, hands: C.hands });
      else if (C.kind === 'driver') {
        const D = { d: { e: { car: g }, t: T, steer: C.steer, eyeLocal: null }, player: { rig }, seat: { pos: rig.root.position.clone() }, view: C.inside ? 'cockpit' : 'chase' };
        placeRig.call(D, THREE, CP.seatsFor, CP.leanBack, CP.underRoof, CP.twoBone, CP.seatLegs, CP.wpos, CP.wquat, CP.setWQ, clampD);
        extra = { eyeRig: D.d.eyeRig ? [D.d.eyeRig.x, D.d.eyeRig.y, D.d.eyeRig.z].map(r6) : null };
      } else if (C.kind === 'figure' && fi === tl.frames.length - 1) {
        // (bakeOne updates the rig itself: the two frames above are its two snapped 'sit' updates; here the rest of it)
        const S = CP.seatsFor(T), fig = bakeRest(rig, C.look, C.driver ? 'driver' : 'passenger', C.driver ? S : null);
        const fake = { drivers: new Map(C.driver ? [[S.name, [fig]]] : []), figs: { passenger: C.driver ? [] : [fig], driver: [] }, fillByEye: () => null };
        const seq = C.driver ? [0] : [0, 0.1, 0, 0.25, 0, 0];
        let k = 0;
        const grp = CP.CarPeople.prototype.fill.call(fake, T, () => (k < seq.length ? seq[k++] : 0.9));
        extra = { top: r6(fig.top), hip: [fig.hip.x, fig.hip.y, fig.hip.z].map(r6), O: grp.children.map((o) => [o.position.x, o.position.y, o.position.z].map(r6)) };
      }
    }
    if (!F.sample) return;
    const P = rig.root.position;
    const rel = (o) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); o.updateMatrixWorld(true); o.matrixWorld.decompose(p, q, sc); return [r6(p.x - P.x), r6(p.y - P.y), r6(p.z - P.z), r6(q.x), r6(q.y), r6(q.z), r6(q.w), o.visible && (o.parent?.visible ?? true) ? 1 : 0]; };
    samples.push({
      frame: fi, root: [r6(P.x), r6(P.y), r6(P.z)],
      q: rig.allBones.map((b) => [r6(b.quaternion.x), r6(b.quaternion.y), r6(b.quaternion.z), r6(b.quaternion.w)]),
      p: rig.allBones.map((b) => [r6(b.position.x), r6(b.position.y), r6(b.position.z)]),
      gear: [...rig.skis, ...rig.poles].map(rel),
      // the clips' playback (AnimationMixer action times: the walk / run cycle phase) and their blend weights
      clips: rig.clips ? ['idle', 'walk', 'run'].map((k) => (rig.clips[k] ? [r6(rig.clips[k].action.time), r6(rig.clips[k].w)] : null)) : null,
      mode: rig.mode, blend: r6(rig.blend),
      // the head and arms folded away (first person), the body shown, the root's rotation (a car seat)
      scale: ['head', 'lArm', 'rArm'].map((k) => r6(rig.b[k].scale.x)), body: rig.body.visible ? 1 : 0,
      rootQ: [rig.root.quaternion.x, rig.root.quaternion.y, rig.root.quaternion.z, rig.root.quaternion.w].map(r6),
      fpv: F.fpv ? { vis: rig.fpView?.visible ? 1 : 0, hands: (rig.fpHands || []).map((H) => [...H.root.position.toArray(), ...H.root.quaternion.toArray(), ...H.cuff.position.toArray(), ...H.cuff.quaternion.toArray()].map(r6)) } : null,
      extra,
    });
  });
  // (inputs written with full precision: the replay must see the very same numbers)
  out.timelines.push({ name: tl.name, carry: tl.carry, frames: tl.frames.map((F) => ({ dt: F.dt, pos: F.pos, st: F.st, plant: F.plant, fpv: F.fpv, car: F.car, snap: F.snap })), samples });
  console.log(`${tl.name}: ${tl.frames.length} frames, ${samples.length} samples`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
if (!ONLY_FANS) {
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(1), 'MB');
}

// ================================================================ the crowd people (world/fans.js)
// The eight fan_* characters as fans.js bakes them (FanKit: the rest skeleton, the hands' axes, the legs' bind look,
// every keyframe posed with its IK, the three LOD geometries with the reworked arm weights and the recolour mask, the
// jacket's recolour key, the carry), then two dynamic crowds as townsfolk.js makes them (the village's 56 people from
// mulberry32(6612): characters, sizes, personalities, colours) and one person of each character replaying a scripted
// timeline of pose inputs (standing, walking, stopping, talking, a phone, pointing, the watch, hands held / on the hips,
// walking with the skis on the shoulder): every 0.25 s each bone's model-space rotation / position and the prop's
// matrix. -> fans_ref.json next to the skier's reference (`ski_legacy --verify-poses` checks both).
{
  const os = await import('node:os');
  const FOUT = path.join(path.dirname(OUT), 'fans_ref.json');
  // fans.js keeps FanKit and its helpers to itself: a copy of the module that exports them (its imports resolved)
  let src = fs.readFileSync(path.join(SRC, 'world/fans.js'), 'utf8');
  src = src.replace("from 'three';", `from '${import.meta.resolve('three')}';`)
    .replace("from 'three/addons/utils/SkeletonUtils.js';", `from '${import.meta.resolve('three/addons/utils/SkeletonUtils.js')}';`)
    .replace("import { loadGLB } from '../core/assets.js';", 'const loadGLB = async () => null;');
  src += '\nexport { FanKit, BONE_NAMES, NK };\n';
  const tmp = path.join(os.tmpdir(), `sl_fans_ref_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  let F;
  try { F = await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
  const { FanKit, FanCrowd, FAN_MODELS, FAN_KEYS: K, NWALK, WALK_STRIDE, BONE_NAMES } = F;
  const mulberry = (s) => { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const arr = (a) => Array.from(a, (x) => x);
  const v3a = (v) => [v.x, v.y, v.z];
  const kits = [];
  for (const n of FAN_MODELS) kits.push(new FanKit(n, await glb(n)));
  const fout = { bones: BONE_NAMES, kits: [], village: null, crowd: null, timelines: [] };
  for (const kit of kits) {
    const lods = kit.geos.map((g) => {
      const bn = g.attributes.aBones.array, wt = g.attributes.aWeights.array, info = g.attributes.aInfo.array, P = g.attributes.position.array, N = g.attributes.normal.array;
      // per palette bone: the summed weights (the arm rework and the clean-up as a whole), the mask's sum, a sample of vertices
      const sum = new Array(21).fill(0);
      let mask = 0;
      for (let i = 0; i < bn.length / 4; i++) { for (let k = 0; k < 4; k++) sum[bn[i * 4 + k]] += wt[i * 4 + k]; mask += info[i * 3 + 1]; }
      const sample = [];
      for (let i = 0; i < bn.length / 4; i += 97) sample.push([i, arr(P.subarray(i * 3, i * 3 + 3)), arr(N.subarray(i * 3, i * 3 + 3)), arr(bn.subarray(i * 4, i * 4 + 4)), arr(wt.subarray(i * 4, i * 4 + 4)), arr(info.subarray(i * 3, i * 3 + 3))]);
      return { vertices: g.attributes.position.count, indices: g.index.count, sum, mask, sample };
    });
    fout.kits.push({
      name: kit.name, parent: arr(kit.parent), P0: arr(kit.P0), Q0: arr(kit.Q0), O: arr(kit.O),
      hand: kit.hand.map((h) => (h ? { f: v3a(h.f), n: v3a(h.n), grip: v3a(h.grip), len: h.len } : null)), G: v3a(kit.G), gripLocal: v3a(kit.gripLocal),
      armLen: kit.armLen, hipY: kit.hipY, headY: kit.headY, postureFix: kit.postureFix, height: kit.height,
      legInfo: kit.legInfo.map((l) => [l.L, l.d, l.back ? 1 : 0]), base: kit.base ? [kit.base.x, kit.base.y, kit.base.z, kit.base.w] : null,
      kq: arr(kit.kq), kh: arr(kit.kh), carryRel: kit.carryRel ? arr(kit.carryRel) : null, carryAnchor: kit.carryAnchor ? v3a(kit.carryAnchor) : null, lods,
    });
    console.log(`fans: ${kit.name} baked in ${kit.bakeMs.toFixed(0)} ms, jacket key ${kit.base ? 'yes' : 'none'}`);
  }
  // the village's crowd (townsfolk.js: 56 spots at the origin, mulberry32(6612))
  const parent = new THREE.Group();
  const crowdOf = (n, rnd, kitOf = null) => new FanCrowd(kits, Array.from({ length: n }, (_, i) => ({ x: 0, y: 0, z: 0, yaw: 0, free: 0.5, prop: 0, ...(kitOf ? { kit: kitOf[i] } : {}) })), rnd, { parent, dynamic: true });
  const pers = (c) => Array.from({ length: c.n }, (_, i) => { const o = (i * (21 * 3 + 2) + 21 * 3) * 4; return { kit: c.kit[i], scl: [c.scl[i * 2], c.scl[i * 2 + 1]], energy: c.energy[i], phase: c.phase[i], rate: c.rate[i], calm: c.calm[i], style: c.style[i], jumper: c.jumper[i], pal: arr(c.pal.subarray(o, o + 8)), lookY: c.lookY[i] }; });
  fout.village = pers(crowdOf(56, mulberry(6612)));
  // one person of each character (their own personalities: mulberry32(99)), scripted pose inputs
  const crowd = crowdOf(8, mulberry(99), [0, 1, 2, 3, 4, 5, 6, 7]);
  crowd.calm[2] = K.HOLD; crowd.calm[3] = K.POCKET; crowd.calm[4] = 0;
  fout.crowd = pers(crowd);
  const D = crowd.dyn, ROWF = 21 * 3 + 2;
  for (let i = 0; i < crowd.n; i++) {
    const frames = [], samples = [];
    let wph = (i * 0.137) % 1, walk = 0, talk = 0, holdW = 0, hold = 0, lookY = 0, lookP = 0.02, t = 0, carry = 0;
    const dt = 1 / 60, N = Math.round(20 / dt);
    crowd.lookY[i] = 0; crowd.lookP[i] = 0;
    for (let f = 0; f < N; f++) {
      t += dt;
      // the script: stand 0-2 s, walk 2-5.5 (1.3 m/s), stop, talk 6.5-10 (looking aside), a phone 10-12.5, point 12.5-14,
      // the watch 14-15.5, then off with the skis on the shoulder 15.5-20 (1.2 m/s)
      const v = t > 2 && t < 5.5 ? 1.3 : t > 15.8 ? 1.2 : 0;
      const wt = Math.min(1, v / 0.75);
      walk += (wt - walk) * Math.min(1, dt * 7);
      wph = (wph + (v * dt) / WALK_STRIDE) % 1;
      const talkTo = t > 6.5 && t < 10 ? (Math.sin(t * 0.35 + i * 1.7) > 0.2 ? 1 : 0.2) : 0;
      talk += (talkTo - talk) * Math.min(1, dt * 1.6);
      const want = t > 10 && t < 12.5 ? K.PHONE : t > 12.5 && t < 14 ? K.POINT : t > 14 && t < 15.5 ? K.WATCH : 0;
      if (want && hold !== want && holdW < 0.02) hold = want;
      holdW += ((want && hold === want ? 1 : 0) - holdW) * Math.min(1, dt * 2.2);
      carry = t > 15.5 ? 1 : 0;
      lookY = (t > 6.5 && t < 10 ? 0.7 : t > 12.5 && t < 14 ? -0.3 : 0) * (1 - walk * 0.6);
      lookP = t > 10 && t < 12.5 ? 0.25 : 0.02;
      D.walk[i] = walk; D.wph[i] = wph; D.talk[i] = talk; D.hold[i] = hold; D.holdW[i] = holdW; D.carry[i] = carry; D.lookY[i] = lookY; D.lookP[i] = lookP;
      const every = f % 3 === 2 ? 2 : 1; // (posed at an uneven rate, like the crowd's far people: dt * every)
      crowd.poseDyn(i, t, dt * every);
      frames.push([t, dt * every, D.walk[i], D.wph[i], D.talk[i], D.hold[i], D.holdW[i], D.carry[i], D.lookY[i], D.lookP[i]]);
      if (f % 15 === 14) {
        const o = i * ROWF * 4;
        samples.push({ frame: f, W: arr(crowd.W.subarray(0, 20 * 4)), P: arr(crowd.Pw.subarray(0, 20 * 3)), prop: arr(crowd.pal.subarray(o + 20 * 12, o + 21 * 12)), look: [crowd.lookY[i], crowd.lookP[i]] });
      }
    }
    fout.timelines.push({ person: i, kit: crowd.kit[i], frames, samples });
  }
  fs.writeFileSync(FOUT, JSON.stringify(fout));
  console.log('wrote', FOUT, (fs.statSync(FOUT).size / 1e6).toFixed(1), 'MB');
}
