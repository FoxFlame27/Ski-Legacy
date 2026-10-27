// Dev-only lab for moving people (src/world/fans.js dynamic crowds + src/world/peoplesim.js): renders a fixed-step
// frame sequence of people walking / carrying skis / talking into one contact sheet (window.__done when finished).
// /tools/peoplelab.html?mode=walk|carry|talk|mix&view=side|front|close&frames=12&step=4&kits=fan_man,fan_woman
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadFanKits, FanCrowd, FAN_KEYS as K } from '../src/world/fans.js';
import { PeopleSim } from '../src/world/peoplesim.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'walk', view = q.get('view') || 'side';
const FR = +(q.get('frames') || 12), STEP = +(q.get('step') || 4), COLS = +(q.get('cols') || 4);
const W = +(q.get('w') || 640), H = +(q.get('h') || 400);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc3e8);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8899aa, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e8, 2.6);
sun.position.set(6, 12, 9);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({ color: 0xf3f6fb, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2; scene.add(ground);
// stripes every metre along x (foot sliding shows against them)
for (let x = -20; x <= 20; x++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 40), new THREE.MeshBasicMaterial({ color: 0xc8d2de }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, 0.002, 0); scene.add(m);
}
const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 500);

let rs = 11;
const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
const all = await loadFanKits();
const want = (q.get('kits') || '').split(',').filter(Boolean);
const kits = all;
const pick = want.length ? want.map((n) => all.findIndex((k) => k.name === n)).filter((i) => i >= 0) : all.map((_, i) => i);
const n = pick.length;
const spots = pick.map((k, j) => ({ x: 0, y: 0, z: j * 1.6, yaw: Math.PI / 2, kit: k, prop: 0, free: 0.5 }));
const crowd = new FanCrowd(kits, spots, rnd, { parent: scene, dynamic: true, bounds: { center: new THREE.Vector3(0, 0, 0), radius: 60 } });
const sim = new PeopleSim(crowd, { groundY: () => 0 });
const speed = +(q.get('speed') || 1.3);
sim.people.forEach((p, j) => {
  const lane = (j - (n - 1) / 2) * 1.5;
  if (mode === 'talk') {
    // a circle of people facing its middle, one talking at a time
    const a = (j / n) * Math.PI * 2;
    sim.spawn(p, Math.sin(a) * 0.75, Math.cos(a) * 0.75, a + Math.PI, { shown: true });
    p.face = a + Math.PI;
    p.talkTo = j === 0 ? 1 : 0.22;
    return;
  }
  // one file along +x, 2.2 m apart (the side camera sees them in a row)
  sim.spawn(p, -6 - j * 2.2, 0, Math.PI / 2, { shown: true, vmax: speed });
  p.carry = mode === 'carry' || (mode === 'mix' && j % 2 === 0) ? 1 : 0;
  sim.setPath(p, [{ x: 80, z: 0 }]);
  void lane;
  p.v = speed;
});
if (mode !== 'talk') for (const p of sim.people) { crowd.dyn.walk[p.i] = 1; }

const span = n * 1.5;
if (view === 'side') { cam.position.set(0, 1.2, n * 2.6 + 2.5); cam.lookAt(0, 0.9, 0); }
else if (view === 'front') { cam.position.set(14, 1.5, 0); cam.lookAt(0, 0.9, 0); }
else if (view === 'close') { cam.fov = 22; cam.updateProjectionMatrix(); cam.position.set(0, 1.5, 6); cam.lookAt(0, 1.05, 0); }
else if (view === 'talk') { cam.position.set(0, 2.2, 6.5); cam.lookAt(0, 1.0, 0); }
cam.updateMatrixWorld();
const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));

// fixed-step simulation, the camera following the walkers (side view), every STEP-th frame into the sheet
const sheet = document.createElement('canvas');
sheet.width = COLS * W; sheet.height = Math.ceil(FR / COLS) * H;
const g = sheet.getContext('2d');
const dt = 1 / 30;
let t = 0, frame = 0, ms = 0;
const total = FR * STEP + 30;
for (let f = 0; f < total; f++) {
  t += dt;
  sim.update(dt);
  if (mode === 'talk') {
    const sp = Math.floor(t / 3) % n;
    sim.people.forEach((p, j) => { p.talkTo = j === sp ? 1 : 0.22; p.look = j === sp ? { x: 0, z: 0 } : { x: sim.people[sp].x, z: sim.people[sp].z }; });
  }
  if (mode !== 'talk' && view !== 'talk') {
    const p0 = sim.people[0], cx = p0.x - (n - 1) * 1.1;
    if (view === 'front') { cam.position.set(p0.x + 8, 1.45, 1.2); cam.lookAt(p0.x - 1, 0.95, 0); } else { cam.position.x = cx; cam.lookAt(cx, view === 'close' ? 1.05 : 0.9, 0); }
    cam.updateMatrixWorld();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  }
  const t0 = performance.now();
  crowd.update(dt, { cam: cam.position, frustum, view: 200, lod: [16, 45], cheer: 0, player: null, time: t, shadows: false, forceLod: q.get('lod') !== null ? +q.get('lod') : undefined });
  ms += performance.now() - t0;
  if (f >= 30 && (f - 30) % STEP === 0 && frame < FR) {
    renderer.render(scene, cam);
    g.drawImage(renderer.domElement, (frame % COLS) * W, Math.floor(frame / COLS) * H);
    g.fillStyle = '#123'; g.font = '14px sans-serif'; g.fillText(`${frame + 1}  t=${t.toFixed(2)}s`, (frame % COLS) * W + 6, Math.floor(frame / COLS) * H + 18);
    frame++;
  }
}
renderer.domElement.style.display = 'none';
sheet.id = 'c';
document.body.appendChild(sheet);
window.__metrics = { updMs: +(ms / total).toFixed(3), people: n };
window.__done = true;
