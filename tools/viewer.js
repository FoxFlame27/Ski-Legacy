// Dev-only model inspector: /tools/viewer.html?m=start_house  -> 2x2 views of /models/<m>.glb
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const name = new URLSearchParams(location.search).get('m');
document.getElementById('l').textContent = name;
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.setScissorTest(true);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc3e8);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8899aa, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
loader.load(`/models/${name}.glb`, (g) => {
  const root = g.scene;
  root.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const R = Math.max(size.x, size.y, size.z);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 3, 64), new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = box.min.y - 0.002 * R;
  ground.receiveShadow = true;
  scene.add(root, ground);
  sun.position.set(c.x + R * 2, c.y + R * 3, c.z + R * 1.5);
  sun.target.position.copy(c);
  scene.add(sun.target);
  Object.assign(sun.shadow.camera, { left: -R * 2, right: R * 2, top: R * 2, bottom: -R * 2, near: 0.01, far: R * 10 });
  sun.shadow.camera.updateProjectionMatrix();
  const views = [[0, 0.25], [Math.PI * 0.75, 0.3], [-Math.PI * 0.6, 0.15], [Math.PI, 0.9]];
  const cam = new THREE.PerspectiveCamera(35, W / 2 / (H / 2), R * 0.01, R * 20);
  views.forEach(([az, el], i) => {
    const d = R * 2.1;
    cam.position.set(c.x + Math.sin(az) * Math.cos(el) * d, c.y + Math.sin(el) * d, c.z + Math.cos(az) * Math.cos(el) * d);
    cam.lookAt(c);
    const x = (i % 2) * W / 2, y = (i < 2 ? 1 : 0) * H / 2;
    renderer.setViewport(x, y, W / 2, H / 2);
    renderer.setScissor(x, y, W / 2, H / 2);
    renderer.render(scene, cam);
  });
  document.title = `${name} ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`;
  window.__done = true;
}, undefined, (e) => { document.title = 'ERR ' + e.message; window.__done = true; });
