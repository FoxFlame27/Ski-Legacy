// Furniture objects: the Meshy GLB (public/models/furniture/<id>.glb) scaled to the catalog's real-world
// size, with a procedural wooden box fallback when a model is missing. Plus cached menu thumbnails.
import * as THREE from 'three';
import { loadGLB } from '../../core/assets.js';
import { FURNITURE } from './catalog.js';
import { fitScales } from './placement.js';

export const loadFurniture = (id) => loadGLB(`furniture/${id}`);

const fallbackMat = new THREE.MeshStandardMaterial({ color: 0x9a6a3c, roughness: 0.8 });

/**
 * Build a placeable Group for a catalog item. Local frame: +z is the front, origin at the centre of the
 * footprint; floor items stand on y=0, wall items have their back on z=0, ceiling items hang below y=0.
 * userData.dims = actual scaled size {x,y,z}.
 */
export function makeFurnitureObject(item, gltf) {
  const g = new THREE.Group();
  const [sx, sy, sz] = item.size;
  let m;
  if (gltf) {
    const model = gltf.scene.clone(true);
    model.updateMatrixWorld(true);
    const d = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const fit = fitScales(item, [d.x, d.y, d.z]); // height exact, footprint toward the catalog (placement.js)
    const turned = new THREE.Group();
    if (fit.layFlat) model.rotation.x = -Math.PI / 2; // a rug modelled standing up
    turned.add(model);
    if (fit.turn) turned.rotation.y = Math.PI / 2;
    m = new THREE.Group();
    m.add(turned);
    m.scale.set(...fit.scale);
    m.updateMatrixWorld(true);
    m.traverse((o) => { if (o.isMesh) { o.castShadow = !item.flat; o.receiveShadow = true; } });
  } else {
    m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), fallbackMat);
    m.castShadow = !item.flat; m.receiveShadow = true;
  }
  const box = new THREE.Box3().setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const y = item.place === 'ceiling' ? box.max.y : box.min.y;
  const z = item.place === 'wall' ? box.min.z : c.z;
  m.position.sub(new THREE.Vector3(c.x, y, z));
  g.add(m);
  const dims = box.getSize(new THREE.Vector3());
  g.userData.dims = dims;
  if (item.light != null) { // a warm glowing bulb (no real light: keeps shader variants stable)
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
    bulb.position.y = item.place === 'ceiling' ? -dims.y * 0.6 : item.place === 'wall' ? dims.y * 0.6 : item.light;
    if (item.place === 'wall') bulb.position.z = dims.z * 0.6;
    g.add(bulb);
  }
  return g;
}

// ---------------------------------------------------------------- thumbnails
const THUMB_KEY = 'sl-furniture-thumbs-v2';
const thumbs = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(THUMB_KEY) || '{}'))) thumbs.set(k, v); } catch { /* no storage */ }
const persist = () => { try { localStorage.setItem(THUMB_KEY, JSON.stringify(Object.fromEntries(thumbs))); } catch { /* full or blocked */ } };

export const getThumb = (id) => thumbs.get(id) || null;

let running = null;
/** Render every catalog model once to a small offscreen canvas (one shared WebGL context, freed after). */
export function renderThumbs(onThumb) {
  if (running) return running;
  const todo = FURNITURE.filter((f) => !thumbs.has(f.id));
  if (!todo.length) return (running = Promise.resolve());
  running = (async () => {
    const W = 160, H = 120;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setSize(W, H, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e6, 0x5a4a3a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const cam = new THREE.PerspectiveCamera(30, W / H, 0.01, 100);
    for (const item of todo) {
      const gltf = await loadFurniture(item.id);
      const obj = makeFurnitureObject(item, gltf);
      scene.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const sph = box.getBoundingSphere(new THREE.Sphere());
      const dist = sph.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 0.95;
      const dir = item.flat ? new THREE.Vector3(0.3, 1.4, 1).normalize() : new THREE.Vector3(0.75, 0.45, 1).normalize();
      cam.position.copy(sph.center).addScaledVector(dir, dist);
      cam.lookAt(sph.center);
      r.render(scene, cam);
      let url;
      try { url = canvas.toDataURL('image/webp', 0.8); } catch { url = null; }
      scene.remove(obj);
      if (url) { thumbs.set(item.id, url); onThumb?.(item.id, url); }
      await new Promise((res) => setTimeout(res, 0)); // let the game breathe between renders
    }
    persist();
    r.dispose();
    r.forceContextLoss();
  })();
  return running;
}
