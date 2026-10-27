// Boulder lab (dev only): the procedural boulders of src/world/boulders.js on a flat snowfield under the game's
// sky and sun, for fast look-dev without loading the whole game.
//   /tools/boulderlab.html   window.__lab = { ready, view(name), setHour(h), scene, camera }
import * as THREE from 'three';
import { installHeightFog } from '../src/engine/fog.js';
import { Environment } from '../src/world/sky.js';
import { boulderKit, withGround, BOULDER_VARIANTS } from '../src/world/boulders.js';

installHeightFog();
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 32000);
const env = new Environment(renderer, scene);
env.hour = 11; env.timeScale = 0; env.weatherTimer = 1e9;

const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.83, 0.86, 0.9), roughness: 0.9 }));
ground.receiveShadow = true;
scene.add(ground);

const kit = boulderKit();
const rows = [];
const add = (geos, z, sizes) => {
  geos.forEach((geo, v) => {
    const m = new THREE.InstancedMesh(withGround(geo, 4), kit.material, sizes.length);
    sizes.forEach((s, k) => {
      const big = s >= 2.6, H = kit.height[v] * s;
      const sink = big ? 0.2 : 0.5;
      const mat = new THREE.Matrix4().compose(new THREE.Vector3((v - (BOULDER_VARIANTS - 1) / 2) * 7, -sink * H, z + k * 9), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), v * 1.3 + k), new THREE.Vector3(s, s, s * 0.95));
      m.setMatrixAt(k, mat);
      m.geometry.attributes.aGround.setXYZ(k, 0, 0, 0.0001);
    });
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;
    scene.add(m);
    rows.push(m);
  });
};
add(kit.hi, 0, [3.2, 1.6]);
add(kit.lo, 40, [3.2]);

const VIEWS = {
  row: [[0, 4, -16], [0, 1, 4]],
  close: [[-6, 2.2, -5.5], [-3.5, 0.9, 0]],
  close2: [[4, 1.6, -4.5], [3.5, 0.9, 0]],
  side: [[-22, 3, 4], [0, 0.5, 4]],
  far: [[0, 6, -60], [0, 0, 10]],
  lo: [[0, 4, 26], [0, 1, 40]],
  top: [[0, 14, -6], [0, 0, 4]],
};
const lab = window.__lab = {
  ready: false, scene, camera, env,
  view(name) { const v = VIEWS[name] || VIEWS.row; camera.position.fromArray(v[0]); camera.lookAt(new THREE.Vector3().fromArray(v[1])); camera.updateMatrixWorld(); },
  setHour(h) { env.hour = h; },
};
lab.view('row');
let last = performance.now();
function loop() {
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
  env.update(dt, camera, camera.position);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
env.update(0.016, camera, camera.position);
requestAnimationFrame(loop);
setTimeout(() => { lab.ready = true; }, 1500);
