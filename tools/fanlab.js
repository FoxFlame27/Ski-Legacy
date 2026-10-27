// Dev-only lookdev for the race spectators (src/world/fans.js): /tools/fanlab.html?mode=poses|lod|crowd&cheer=0..1
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadFanKits, FanCrowd, FAN_KEYS } from '../src/world/fans.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'poses';
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc3e8);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8899aa, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e8, 2.6);
sun.position.set(6, 12, 9); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 0.5, far: 60 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0xf3f6fb, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 500);

let rs = 7;
const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
const kits = await loadFanKits();
document.getElementById('l').textContent = `${mode} kits ${kits.map((k) => k.name).join(' ')}`;
const crowds = [];
const keyNames = Object.keys(FAN_KEYS);
if (mode === 'poses') {
  // rows: characters, columns: keyframes (?keys=CLAP_O,CLAP_S,...)
  const keys = (q.get('keys') || 'STAND_L,HOLD,CLAP_O,CLAP_S,CLAPHI_S,VUP_A,VUP_B,WAVE_A,PUMP_HI,FLAG_A,BELL_A,CROUCH').split(',');
  const only = q.get('kit');
  const ks = only ? kits.filter((k) => k.name === only) : kits;
  const spots = [], force = [];
  ks.forEach((kit, r) => keys.forEach((kn, c) => {
    spots.push({ x: (c - (keys.length - 1) / 2) * 1.25, y: 0, z: -r * 2.4, yaw: +(q.get('yaw') || 0), kit: kits.indexOf(kit), key: FAN_KEYS[kn], prop: kn.startsWith('FLAG') ? 1 : kn.startsWith('BELL') ? 2 : 0 });
  }));
  const crowd = new FanCrowd(kits, spots, rnd, { parent: scene, shadows: true });
  crowd.force = new Int16Array(spots.map((s) => s.key));
  crowds.push(crowd);
  const span = keys.length * 1.25, depth = ks.length * 2.4;
  const view = q.get('view') || 'front';
  if (view === 'front') { cam.position.set(0, 1.4 + depth * 0.25, span * 1.25 + 3); cam.lookAt(0, 0.9, -depth / 2 + 1); }
  else if (view === 'side') { cam.position.set(span * 1.1, 1.6, -depth / 2 + 1); cam.lookAt(0, 1, -depth / 2 + 1); }
  else if (view === 'close') { cam.fov = 22; cam.updateProjectionMatrix(); cam.position.set(+(q.get('cx') || 0), 1.5, 4.5); cam.lookAt(+(q.get('cx') || 0), 1.1, 0); }
} else if (mode === 'lod') {
  // the same fans at LOD 0 / 1 / 2 side by side
  for (let l = 0; l < 3; l++) {
    const spots = kits.map((k, i) => ({ x: (l - 1) * 6.5 + (i - 2) * 1.2, y: 0, z: 0, yaw: 0, kit: i, key: FAN_KEYS.CLAP_O }));
    const crowd = new FanCrowd(kits, spots, rnd, { parent: scene, shadows: true });
    crowd.force = new Int16Array(spots.map((s) => s.key));
    crowd.forceLod = l;
    crowds.push(crowd);
  }
  cam.fov = 24; cam.updateProjectionMatrix();
  cam.position.set(0, 1.6, +(q.get('d') || 26)); cam.lookAt(0, 0.95, 0);
} else {
  // a crowd behind a board, cheering (?cheer=0..1)
  const spots = [];
  for (let row = 0; row < 3; row++) for (let x = -9; x < 9; x += 0.78) {
    if (rnd() < 0.2) continue;
    spots.push({ x: x + (row % 2) * 0.39 + (rnd() - 0.5) * 0.2, y: row * 0.0, z: -row * 0.85, yaw: (rnd() - 0.5) * 0.4, free: rnd() * 0.5 + 0.6 });
  }
  crowds.push(new FanCrowd(kits, spots, rnd, { parent: scene, shadows: true }));
  const d = +(q.get('d') || 9);
  cam.position.set(+(q.get('cx') || 0), 1.7 + d * 0.06, d); cam.lookAt(+(q.get('cx') || 0), 1.2, -1);
}
window.__crowds = crowds; window.__scene = scene;
const cheer = +(q.get('cheer') ?? 0.8);
const racer = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1), new THREE.MeshStandardMaterial({ color: 0xd9221c }));
racer.visible = false; scene.add(racer);
const t0 = performance.now();
let last = t0, frames = 0, upd = 0;
const T = +(q.get('t') || 0);
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const time = T || (now - t0) / 1000;
  const a = performance.now();
  // ?racer=x0: a racer passing in front of the crowd at 16 m/s (x = x0 + 16 t)
  const player = q.get('racer') !== null ? { x: +q.get('racer') + 16 * time, y: 0, z: 4, speed: 16 } : null;
  if (player) { racer.position.set(player.x, 0.9, player.z); racer.visible = true; }
  for (const c of crowds) c.update(dt, { cam: cam.position, frustum: null, view: 400, lod: [16, 45], cheer, player, time, shadows: true, forceLod: c.forceLod ?? (q.get('lod') !== null ? +q.get('lod') : undefined) });
  upd += performance.now() - a; frames++;
  renderer.render(scene, cam);
  if (frames === 30) { window.__updMs = upd / 30; window.__done = true; }
  requestAnimationFrame(frame);
}
frame();
