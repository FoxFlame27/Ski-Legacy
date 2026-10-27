// Dev-only: close-up inspection of a floodlight model (/tools/flood-view.html?m=floodlight_mast&top=0.25)
// view 1: whole model; views 2-4: the top `top` share of its height (the lamp head) from front-below, side, back
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const qs = new URLSearchParams(location.search);
const name = qs.get('m'), top = Number(qs.get('top') || 0.25), yaw = Number(qs.get('yaw') || 0);
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.setScissorTest(true);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb4d8);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8899aa, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
scene.add(sun);
new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(`/models/${name}.glb`, (g) => {
  const root = g.scene;
  root.rotation.y = yaw;
  root.updateMatrixWorld(true);
  let tris = 0; const tex = [];
  root.traverse((o) => { if (o.isMesh) { tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) if (o.material[k]) tex.push(`${k}:${o.material[k].image?.width}`); } });
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const R = Math.max(size.x, size.y, size.z);
  scene.add(root);
  sun.position.set(c.x + R, c.y + R * 2, c.z + R * 1.5);
  sun.target.position.copy(c); scene.add(sun.target);
  const hb = new THREE.Box3(new THREE.Vector3(box.min.x, box.max.y - size.y * top, box.min.z), box.max.clone());
  const hc = hb.getCenter(new THREE.Vector3()), hs = hb.getSize(new THREE.Vector3()), hR = Math.max(hs.x, hs.y, hs.z);
  const views = [[c, R, 0.15, 0], [hc, hR, -0.35, 0.35], [hc, hR, 0.1, Math.PI / 2], [hc, hR, 0.25, Math.PI * 0.85]];
  const cam = new THREE.PerspectiveCamera(35, W / 2 / (H / 2), 0.005, R * 20);
  views.forEach(([cc, r, el, az], i) => {
    const d = r * 2.0;
    cam.position.set(cc.x + Math.sin(az) * Math.cos(el) * d, cc.y + Math.sin(el) * d, cc.z + Math.cos(az) * Math.cos(el) * d);
    cam.lookAt(cc);
    const x = (i % 2) * W / 2, y = (i < 2 ? 1 : 0) * H / 2;
    renderer.setViewport(x, y, W / 2, H / 2); renderer.setScissor(x, y, W / 2, H / 2);
    renderer.render(scene, cam);
  });
  document.getElementById('l').textContent = `${name} ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)} tris ${tris} ${tex.join(' ')}`;
  document.title = document.getElementById('l').textContent;
  window.__done = true;
}, undefined, (e) => { document.title = 'ERR ' + e.message; window.__done = true; });
