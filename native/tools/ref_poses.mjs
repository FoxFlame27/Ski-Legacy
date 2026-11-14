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
//
// Usage (from the repo root):  node native/tools/ref_poses.mjs [out.json]   (default native/data/poses_ref.json)
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
const CHAR = process.env.SL_POSE_CHAR || 'skier_red';
const body = await glb(`${CHAR}_rigged`), anims = await glb(`${CHAR}_anims`), ski = await glb('ski_rental'), pole = await glb('ski_pole');
const find = (re) => anims.animations.find((c) => re.test(c.name));
const clips = { idle: find(/^Idle/i), walk: find(/Walk/i), run: find(/Run/i) };

// ---------------------------------------------------------------- timelines
const DT = 1 / 60;
const smooth = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function timeline(name, secs, fn, { x0 = 3, z0 = -2, heading = 0.6, carry = false, snap = true } = {}) {
  const frames = [];
  const pos = { x: x0, z: z0, y: 0 };
  let hd = heading;
  const n = Math.round(secs / DT);
  for (let f = 0; f < n; f++) {
    const t = f * DT;
    const r = fn(t, f) || {};
    const st = { heading: hd, speed: 0, crouch: 0, lean: 0, edge: 0, tuck: false, plow: 0, skid: 0, normal: [NRM.x, NRM.y, NRM.z], air: false, ...r.st };
    if (r.turn) hd += r.turn * DT;
    st.heading = r.st?.heading ?? hd;
    const v = st.speed || 0;
    if (!r.hold) { pos.x += Math.sin(hd) * v * DT; pos.z += Math.cos(hd) * v * DT; }
    pos.y = ground(pos.x, pos.z) + (r.dy || 0);
    frames.push({ dt: DT, pos: [pos.x, pos.y, pos.z], st, plant: r.plant || null, sample: f % 15 === 14 || f === n - 1 });
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

// ---------------------------------------------------------------- replay through the JS rig
const v3 = (a) => (a ? new THREE.Vector3(a[0], a[1], a[2]) : undefined);
const r6 = (x) => +x.toFixed(6);
const out = { char: CHAR, ground: GROUND, bones: null, timelines: [] };
for (const tl of tls) {
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
    const s = { ...F.st, normal: v3(F.st.normal), seat: v3(F.st.seat) };
    if (F.plant) {
      const fw = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading)), r = new THREE.Vector3().crossVectors(fw, new THREE.Vector3(0, 1, 0));
      for (const side of F.plant) rig.startPolePlant(side, fw, r);
    }
    rig.update(F.dt, s);
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
    });
  });
  // (inputs written with full precision: the replay must see the very same numbers)
  out.timelines.push({ name: tl.name, carry: tl.carry, frames: tl.frames.map((F) => ({ dt: F.dt, pos: F.pos, st: F.st, plant: F.plant })), samples });
  console.log(`${tl.name}: ${tl.frames.length} frames, ${samples.length} samples`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(1), 'MB');
