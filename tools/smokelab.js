// Dev-only lab for the car's wreck steam / smoke and lamp glow (carlights.js), no game boot.
//   ?tod=day|night|dusk  ?view=chase|front|side|close|back  ?rate=6 (Smoke.rate; 0: none)  ?speed=m/s (the car drives
//   along +z)  ?t=seconds simulated  ?sun=deg (sun azimuth)  ?lights=1 (headlights)  ?car=car_vw_golf_gti_full
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadGLB } from '../src/core/assets.js';
import { carTemplate, carInstance } from '../src/game/cars.js';
import { lampsOn, LightPool, Smoke } from '../src/game/carlights.js';
import { nightUniform } from '../src/world/village.js';
import { windUniform } from '../src/world/atmosphere.js';

const q = new URLSearchParams(location.search), num = (k, d) => (q.has(k) ? +q.get(k) : d);
const tod = q.get('tod') || 'day', night = tod === 'night' ? 1 : tod === 'dusk' ? 0.55 : 0;
nightUniform.value = night;
windUniform.value.set(num('wx', 2.5), num('wz', 0.6)); // (a clear day's wind, atmosphere.js)
const W = num('w', 960), H = num('h', 540);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.72;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const sky = { day: 0x8fb8e6, dusk: 0x4a5a88, night: 0x070c1a }[tod], fog = { day: 0xcfe0f5, dusk: 0x8a8cb0, night: 0x1a2440 }[tod];
scene.background = new THREE.Color(sky);
scene.fog = new THREE.Fog(fog, 1e5, 2e5);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = { day: 0.9, dusk: 0.35, night: 0.06 }[tod];
const sun = new THREE.DirectionalLight(0xffffff, 1); sun.castShadow = true;
if (tod === 'night') { sun.color.setRGB(0.5, 0.64, 1); sun.intensity = 0.55; } else if (tod === 'dusk') { sun.color.setRGB(1, 0.62, 0.38); sun.intensity = 1.6; } else { sun.color.setRGB(1, 0.97, 0.92); sun.intensity = 5.4; }
const az = THREE.MathUtils.degToRad(num('sun', 140)), el = THREE.MathUtils.degToRad(tod === 'day' ? 32 : tod === 'dusk' ? 6 : 40);
sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(100);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbfd6ff, 0xf2f4ff, tod === 'day' ? 0.12 : 0.04));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0xeef2f8, roughness: 0.85 }));
ground.rotation.x = -Math.PI / 2; scene.add(ground);
// a few dark trees for contrast behind the car
for (let i = 0; i < 14; i++) {
  const t = new THREE.Mesh(new THREE.ConeGeometry(1.6, 7, 7), new THREE.MeshStandardMaterial({ color: 0x1f3326, roughness: 1 }));
  t.position.set(-30 + i * 5 + Math.sin(i * 7) * 2, 3.5, 22 + Math.cos(i * 3) * 4); scene.add(t);
}
const name = q.get('car') || 'car_vw_golf_gti_full';
const gltf = await loadGLB(name);
const t = carTemplate(gltf, num('len', 4.3), name), inst = carInstance(t, { wheels: true });
const car = inst.group; scene.add(car);
const cam = new THREE.PerspectiveCamera(num('fov', 50), W / H, 0.05, 3000);
const lights = num('lights', night > 0.2 ? 1 : 0);
lampsOn(inst, lights, lights || num('tails', 0), 0, { hazard: q.has('hazard') ? 1 : null });
const pool = new LightPool(scene), world = { height: () => 0 };
const rate = num('rate', 6), speed = num('speed', 0), T = num('t', 4);
const smoke = rate > 0 ? new Smoke(scene) : null;
if (smoke) smoke.rate = rate;
const b = new THREE.Vector3(), fwd = new THREE.Vector3(0, 0, 1);
const view = q.get('view') || 'chase';
const place = () => {
  const p = car.position, L = t.size.z / 2;
  if (view === 'chase') cam.position.set(p.x, p.y + 2.4, p.z - 6.2), cam.lookAt(p.x, p.y + 0.9, p.z + 5);
  else if (view === 'front') cam.position.set(p.x + 2.2, p.y + 1.3, p.z + L + 5.5), cam.lookAt(p.x, p.y + 0.9, p.z + L * 0.4);
  else if (view === 'side') cam.position.set(p.x + 8, p.y + 1.8, p.z + 0.5), cam.lookAt(p.x, p.y + 1.8, p.z + (speed ? -3 : 0.8));
  else if (view === 'close') cam.position.set(p.x + 3.2, p.y + 1.6, p.z + L + 1.2), cam.lookAt(p.x, p.y + 1.6, p.z + L - 0.8);
  else if (view === 'back') cam.position.set(p.x - 1.5, p.y + 1.8, p.z - L - 6), cam.lookAt(p.x, p.y + 1.4, p.z);
  else if (view === 'macro') cam.position.set(p.x + 1.6, p.y + 2.1, p.z + L + 0.6), cam.lookAt(p.x, p.y + 2.0, p.z + L - 1.0);
  else if (view === 'far') cam.position.set(p.x + 18, p.y + 4, p.z - 10), cam.lookAt(p.x, p.y + 1.5, p.z + (speed ? -6 : 0));
  cam.updateMatrixWorld();
};
if (q.has('atlas') && smoke) { // the puff atlas: density over black (left), normals (right)
  const tex = smoke.uniforms.uMap.value, mk = (frag, x) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: { m: { value: tex } }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * vec2(0.98, 1.74) + vec2(' + x + ', 0.0), 0.0, 1.0); }', fragmentShader: 'uniform sampler2D m; varying vec2 vUv; void main(){ vec4 t = texture2D(m, vUv); ' + frag + ' }' })); m.frustumCulled = false; m.renderOrder = 99; scene.add(m); };
  mk('gl_FragColor = vec4(vec3(t.a), 1.0);', -0.5); mk('gl_FragColor = vec4(t.rgb * t.a, 1.0);', 0.5);
}
const dt = 1 / 60;
for (let s = 0; s < T / dt; s++) {
  car.position.z += speed * dt; car.updateMatrixWorld(true);
  place();
  b.set(0, t.size.y * 0.78, t.size.z / 2 - 0.8); car.localToWorld(b);
  smoke?.update(dt, b, cam, night, fwd, lights);
}
pool.update(car.position.x, car.position.z, 0, t.size.z / 2, world, lights);
renderer.render(scene, cam);
window.__info = { alive: smoke?.mesh.geometry.instanceCount, calls: renderer.info.render.calls };
window.__done = true;
