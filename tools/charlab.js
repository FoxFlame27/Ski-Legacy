// Dev-only character lab (no world): the six Meshy skiers side by side for close inspection, and outfit
// try-ons on any of them without loading the game. Driven from puppeteer (tools/charlab-shots.mjs):
//   await __lab.show([{ id: 'skier_red', look: { jacket: 'j_glacier' }, pose: 'ski', label: 'x' }, ...], { view: 'front', cols: 6 })
// views: front, side, back, 34, head, head34, headside, waist (see VIEWS)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadAll } from '../src/core/assets.js';
import { world } from '../src/world/world.js';
import { SkierRig } from '../src/player/skier.js';
import { applyOutfit, outfitZones, analyzeZones, labToHex } from '../src/game/outfits.js';

world.height = () => 0; // a flat studio floor (the lab never builds terrain)

const IDS = ['skier_blue', 'skier_red', 'skier_green', 'skier_orange', 'skier_black', 'skier_purple'];
const UP = new THREE.Vector3(0, 1, 0);
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c8ea);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xe4efff, 0x8a99ad, 0.85));
const sun = new THREE.DirectionalLight(0xfff3e4, 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xf2f5fa, roughness: 0.92 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
const label = document.getElementById('l');

const models = await loadAll([...IDS.map((id) => `${id}_rigged`), 'ski_rental', 'ski_pole']);
const rigs = new Map(); // key -> rig
const SPACING = 3;

// camera per view, relative to the character (it faces +Z): [offset from anchor], anchor, fov
const VIEWS = {
  front: { a: 'body', o: [0, 0.06, 4.6], fov: 28 },
  side: { a: 'body', o: [4.6, 0.06, 0], fov: 28 },
  back: { a: 'body', o: [0, 0.1, -4.6], fov: 28 },
  '34': { a: 'body', o: [3.0, 0.2, 3.4], fov: 28 },
  '34r': { a: 'body', o: [-3.0, 0.2, 3.4], fov: 28 },
  head: { a: 'head', o: [0, 0.01, 1.05], fov: 26 },
  head34: { a: 'head', o: [0.72, 0.03, 0.76], fov: 26 },
  headside: { a: 'head', o: [1.05, 0.01, 0], fov: 26 },
  waist: { a: 'chest', o: [0, 0.05, 2.3], fov: 28 },
  waistside: { a: 'chest', o: [2.3, 0.05, 0], fov: 28 },
  show: { a: 'body', o: [1.3, 0.42, 4.2], fov: 40 }, // like the menu showcase camera
  face: { a: 'head', o: [0.25, -0.02, 0.55], fov: 26 },
};

function rigFor(key, id, pose) {
  let r = rigs.get(key);
  if (r && r.charId === id && r.pose === pose) return r;
  if (r) { r.removeFrom(scene); rigs.delete(key); }
  const ski = pose === 'ski' ? models.ski_rental : null;
  r = new SkierRig(models[`${id}_rigged`], { ski, pole: pose === 'ski' ? models.ski_pole : null });
  r.charId = id; r.pose = pose;
  r.addTo(scene);
  rigs.set(key, r);
  return r;
}

function settle(r, pose, heading) {
  const st = pose === 'ski'
    ? { mode: 'ski', heading, speed: 0, crouch: 0.15, lean: 0, plow: 0, normal: UP, air: false, lookYaw: 0, lookPitch: 0 }
    : { mode: 'idle', heading, speed: 0, crouch: 0, lean: 0, plow: 0, normal: UP };
  r.snapPose();
  for (let i = 0; i < 45; i++) r.update(1 / 30, st);
  r.root.updateMatrixWorld(true);
}

const _v = new THREE.Vector3();
function anchor(r, a) {
  const b = r.b;
  if (a === 'head') return b.head.getWorldPosition(new THREE.Vector3()).add(_v.set(0, 0.06, 0));
  if (a === 'chest') return b.spine2.getWorldPosition(new THREE.Vector3()).add(_v.set(0, -0.12, 0));
  const p = r.root.position.clone();
  p.y += 0.9;
  return p;
}

/**
 * cells: [{ id, look?, pose?: 'idle'|'ski', heading?, label? }]; opt: { view, cols, views?: [view per row] }
 * Every cell gets its own rig (reused between calls by index).
 */
async function show(cells, opt = {}) {
  const cols = opt.cols || cells.length;
  const rows = Math.ceil(cells.length / cols);
  // hide rigs beyond this layout
  for (const [key, r] of rigs) { const i = +key; if (i >= cells.length) { r.root.visible = r.gear.visible = false; } }
  const placed = cells.map((c, i) => {
    const pose = c.pose || 'idle';
    const r = rigFor(String(i), c.id, pose);
    r.root.visible = r.gear.visible = true;
    r.root.position.set((i % 64) * SPACING, 0, 0);
    applyOutfit(r, c.id, c.look || null);
    settle(r, pose, c.heading || 0);
    return { c, r };
  });
  sun.position.set(cells.length * SPACING * 0.5 + 6, 14, 10);
  sun.target.position.set(cells.length * SPACING * 0.5, 0, 0);
  const span = cells.length * SPACING * 0.5 + 6;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 80 });
  sun.shadow.camera.updateProjectionMatrix();
  const cw = W / cols, ch = H / rows;
  renderer.setClearColor(scene.background);
  renderer.setScissor(0, 0, W, H); renderer.setViewport(0, 0, W, H); renderer.clear();
  const labels = [];
  placed.forEach(({ c, r }, i) => {
    const view = VIEWS[(opt.views && opt.views[Math.floor(i / cols)]) || c.view || opt.view || 'front'];
    const t = anchor(r, view.a);
    cam.fov = view.fov;
    cam.aspect = cw / ch;
    cam.position.copy(t).add(_v.set(...view.o));
    cam.lookAt(t);
    cam.updateProjectionMatrix();
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    placed.forEach((p, j) => { p.r.root.visible = p.r.gear.visible = j === i; }); // side views never see a neighbour
    renderer.render(scene, cam);
    labels.push(`<div style="position:fixed;left:${x + 6}px;top:${H - y - ch + 4}px;font:600 12px system-ui;color:#0b1d3a;background:rgba(255,255,255,.6);padding:1px 5px">${c.label ?? c.id}</div>`);
  });
  label.innerHTML = labels.join('');
  return true;
}

// garment colours of a model as the outfit analysis sees them (zone reference colours, OKLab -> hex)
function analyze(id, debug = false) {
  const r = new SkierRig(models[`${id}_rigged`], {});
  const mesh = r.skinned, img = mesh.material.map.image;
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 512, 512);
  const px = { data: g.getImageData(0, 0, 512, 512).data, width: 512, height: 512 };
  r.resetPose(); r.root.updateMatrixWorld(true);
  const inv = r.root.matrixWorld.clone().invert(), bones = mesh.skeleton.bones;
  const B = bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(inv, b.matrixWorld).multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix));
  const joints = {};
  for (const b of bones) joints[b.name] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv);
  const z = analyzeZones(mesh, px, B, joints, { debug });
  const out = { has: z.has };
  for (const [k, v] of Object.entries(z.ref)) out[k] = labToHex(v[0], v[1], v[2]);
  return out;
}

window.__lab = {
  analyze,
  ready: true, IDS, show, rigs, models,
  zones: (i) => { const r = rigs.get(String(i)); return r ? outfitZones(r) : null; },
};
window.__done = true;
