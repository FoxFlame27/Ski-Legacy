// GLB asset loading (Meshy models, meshopt + webp compressed) with caching and real-world sizing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { quality } from '../engine/quality.js';
import { enhanceMeshy } from './meshylook.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();
const BASE = './models/';

// Texture budget per graphics preset (Oct 30, performance pass): the Meshy models come with 2048 px maps (2.4 GB of
// GPU memory if every model were drawn at full size: 8 GB Macs lost the WebGL context). Maps larger than the preset's
// texCap are downscaled once while loading (High / Ultra keep them as they are; base colour gets one step more than
// the normal / roughness maps, which read the same smaller). Anisotropic filtering likewise by preset.
const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
const shrunk = new WeakSet();
async function shrinkTexture(tex, cap) {
  const img = tex?.image;
  if (!img || shrunk.has(tex) || typeof createImageBitmap !== 'function') return;
  const w = img.width || 0, h = img.height || 0;
  if (Math.max(w, h) <= cap) return;
  shrunk.add(tex);
  const k = cap / Math.max(w, h);
  try {
    const small = await createImageBitmap(img, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
    tex.image = small;
    tex.needsUpdate = true;
    img.close?.(); // (the full-size decode freed at once)
  } catch { /* keeps the full map */ }
}
async function budgetTextures(g) {
  const cap = quality.texCap || 0, an = quality.aniso || 16, jobs = [];
  g.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of [].concat(o.material)) for (const k of MAPS) {
      const t = m[k];
      if (!t) continue;
      t.anisotropy = an;
      if (cap) jobs.push(shrinkTexture(t, k === 'map' || k === 'emissiveMap' ? cap : Math.max(256, cap / 2)));
    }
  });
  if (jobs.length) await Promise.all(jobs);
}

export function loadGLB(name, onProgress) {
  if (!cache.has(name)) {
    cache.set(name, new Promise((resolve) => {
      loader.load(BASE + name + '.glb', (g) => {
        g.scene.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            if (o.material) {
              o.material.envMapIntensity = 1;
              // anisotropic filtering on every PBR map keeps surfaces crisp at grazing angles (16x on High / Ultra)
              for (const k of MAPS) {
                if (o.material[k]) o.material[k].anisotropy = 16;
              }
            }
          }
        });
        g.modelName = name; // lets ski code apply per-model frames (player/skier.js)
        // (then the Balanced+ crispness pass on the Meshy materials: filtering, detail layer, metal / roughness fix-up;
        // nothing on Performance / Super Performance: core/meshylook.js)
        budgetTextures(g).catch(() => {}).then(() => { try { enhanceMeshy(g); } catch (e) { console.warn('meshylook', e); } resolve(g); });
      }, onProgress, (err) => {
        console.warn('Missing model', name, err?.message || err);
        resolve(null);
      });
    }));
  }
  return cache.get(name);
}

export async function loadAll(names, onEach) {
  const out = {};
  let done = 0;
  await Promise.all(names.map(async (n) => {
    out[n] = await loadGLB(n);
    onEach?.(++done, names.length, n);
  }));
  return out;
}

// Returns a Group containing a clone of the model, scaled so that `axis` spans `size` meters,
// re-centered on XZ and with its lowest point at y=0 (or centered if center=true).
export function fitModel(gltf, { size, axis = 'y', center = false, rotateY = 0 } = {}) {
  const g = new THREE.Group();
  if (!gltf) return g;
  const m = gltf.scene.clone(true);
  m.rotation.y = rotateY;
  m.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(m);
  const dim = box.getSize(new THREE.Vector3());
  // axis 'xz' = longest horizontal extent (for models whose long side may be along x or z)
  const s = size / (axis === 'xz' ? Math.max(dim.x, dim.z) : dim[axis]);
  m.scale.multiplyScalar(s);
  m.updateMatrixWorld(true);
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  m.position.sub(new THREE.Vector3(c.x, center ? c.y : box.min.y, c.z));
  g.add(m);
  g.userData.size = box.getSize(new THREE.Vector3());
  return g;
}

// Meshopt-quantized attributes are normalized ints; transforms need float data.
export function dequantize(geometry) {
  const geo = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const n = attr.count, sz = attr.itemSize;
    const arr = new Float32Array(n * sz);
    const get = [attr.getX, attr.getY, attr.getZ, attr.getW];
    for (let i = 0; i < n; i++) for (let k = 0; k < sz; k++) arr[i * sz + k] = get[k].call(attr, i);
    geo.setAttribute(name, new THREE.BufferAttribute(arr, sz));
  }
  if (geometry.index) geo.setIndex(geometry.index.clone());
  return geo;
}

// Vertex-clustering decimation for mid-distance tree LODs (Meshy trees are many separate branch
// pieces, which edge-collapse simplifiers refuse to reduce).
export function clusterDecimate(geo, cell) {
  const pos = geo.attributes.position, uv = geo.attributes.uv, nor = geo.attributes.normal;
  const index = geo.index ? geo.index.array : [...Array(pos.count).keys()];
  const map = new Map(), rep = [];
  const remap = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    // UV is part of the key so texture islands never get merged (keeps textures intact)
    const key = Math.floor(pos.getX(i) / cell) + ',' + Math.floor(pos.getY(i) / cell) + ',' + Math.floor(pos.getZ(i) / cell) +
      (uv ? ',' + Math.floor(uv.getX(i) * 24) + ',' + Math.floor(uv.getY(i) * 24) : '');
    let id = map.get(key);
    if (id === undefined) { id = rep.length; map.set(key, id); rep.push({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, n: 0, u: uv ? uv.getX(i) : 0, v: uv ? uv.getY(i) : 0 }); }
    const r = rep[id];
    r.x += pos.getX(i); r.y += pos.getY(i); r.z += pos.getZ(i); r.n++;
    if (nor) { r.nx += nor.getX(i); r.ny += nor.getY(i); r.nz += nor.getZ(i); }
    remap[i] = id;
  }
  const tris = [], seen = new Set();
  for (let t = 0; t < index.length; t += 3) {
    const a = remap[index[t]], b = remap[index[t + 1]], c = remap[index[t + 2]];
    if (a === b || b === c || a === c) continue;
    const k = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    tris.push(a, b, c);
  }
  const P = new Float32Array(rep.length * 3), N = new Float32Array(rep.length * 3), U = new Float32Array(rep.length * 2);
  rep.forEach((r, i) => {
    P[i * 3] = r.x / r.n; P[i * 3 + 1] = r.y / r.n; P[i * 3 + 2] = r.z / r.n;
    const l = Math.hypot(r.nx, r.ny, r.nz);
    if (l > 1e-4) { N[i * 3] = r.nx / l; N[i * 3 + 1] = r.ny / l; N[i * 3 + 2] = r.nz / l; } else N[i * 3 + 1] = 1;
    U[i * 2] = r.u; U[i * 2 + 1] = r.v;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  out.setIndex(tris);
  out.computeBoundingSphere();
  console.info(`LOD: ${index.length / 3} -> ${tris.length / 3} triangles`);
  return out;
}

// Decimated copy of a model for distance LOD (cell = fraction of each mesh's largest dimension).
const lodCache = new WeakMap();
function lowGeometry(geo, frac) {
  let byFrac = lodCache.get(geo);
  if (!byFrac) lodCache.set(geo, (byFrac = new Map()));
  if (!byFrac.has(frac)) {
    const g = dequantize(geo);
    g.computeBoundingBox();
    const sz = g.boundingBox.getSize(new THREE.Vector3());
    byFrac.set(frac, clusterDecimate(g, Math.max(sz.x, sz.y, sz.z) * frac));
  }
  return byFrac.get(frac);
}

/** A decimated copy of a (Meshy) geometry, cached: frac = cluster cell as a fraction of its largest dimension. */
export function decimatedGeometry(geo, frac) { return lowGeometry(geo, frac); }

// THREE.LOD: full Meshy detail within `near` meters, a decimated copy beyond, and (performance pass) a much coarser
// one from FAR_K x near on (the buildings seen across the valley: a station / hotel was still 30-60k triangles at
// 1 km; the far copy is a few thousand and nobody can tell at that size).
// (Nov 1 2026, the user: "even on Ultra ... it's like some ugly thing before it gets rendered": the decimated copies
// showed while they were still several pixels off. Only the props in the scene at boot had their distances scaled by
// the preset (engine/detail.js); everything built later (stations, snowcats, course props) swapped at the base
// distances, the coarse far copy a few hundred metres out, and the middle copy dropped its shadow.) Now every makeLOD
// picks its level itself (SmoothLOD): the switch distances grow with the decimation's cluster size (each copy
// stays within ~LOD_ERR_PX pixels of the full model at the reference screen), the preset's quality.props.lod, the
// screen (a narrower view / zoom or a taller screen keeps the detail further) and come back with some hysteresis
// (no flicker at the line). The middle copy keeps the full model's shadow (detail.js still drops it past shadowDist).
const FAR_K = 3, FAR_FRAC = 4;
const LOD_ERR_PX = 2; // a copy's cluster size on screen at the switch (x 1 / quality.props.lod: ~0.8 px on Ultra)
const PX_REF = (2 * Math.tan((65 / 2) * Math.PI / 180)) / 1080; // one pixel's angle: a 65° view, 1080 px tall
const TAN_REF = Math.tan((65 / 2) * Math.PI / 180);
const _lv1 = new THREE.Vector3(), _lv2 = new THREE.Vector3();
let _scrH = 0, _scrT = -1;
function screenK(camera) {
  // the screen's height (refreshed now and then: no layout read per LOD per frame), clamped so a Retina screen doesn't
  // double the full-detail reach
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (now - _scrT > 1000 || _scrT < 0) {
    _scrT = now;
    _scrH = typeof innerHeight !== 'undefined' ? innerHeight * Math.min(2, globalThis.devicePixelRatio || 1) : 1080;
  }
  const fovK = camera.isPerspectiveCamera ? TAN_REF / Math.tan((camera.fov / 2) * Math.PI / 180) : 1;
  return Math.min(1.35, Math.max(0.75, _scrH / 1080)) * fovK * (camera.zoom || 1);
}
// (a subclass, so clones of it keep picking their level this way)
class SmoothLOD extends THREE.LOD {
  update(camera) {
    const levels = this.levels;
    if (levels.length < 2) return;
    _lv1.setFromMatrixPosition(camera.matrixWorld);
    _lv2.setFromMatrixPosition(this.matrixWorld);
    const base = this.userData.lodBase;
    const k = Math.max(0.2, quality.props?.lod ?? 1) * screenK(camera);
    const d = _lv1.distanceTo(_lv2);
    levels[0].object.visible = true;
    let i = 1;
    for (; i < levels.length; i++) {
      let ld = (base ? base[i] : levels[i].distance) * k;
      if (levels[i].object.visible) ld *= 1 - levels[i].hysteresis; // (back to the finer copy a little nearer)
      if (d >= ld) { levels[i - 1].object.visible = false; levels[i].object.visible = true; } else break;
    }
    this._currentLevel = i - 1;
    for (; i < levels.length; i++) levels[i].object.visible = false;
  }
}

export function makeLOD(gltf, opts, near = 140, frac = 0.025) {
  const hi = fitModel(gltf, opts);
  const lo = hi.clone(true);
  lo.traverse((o) => { if (o.isMesh) o.geometry = lowGeometry(o.geometry, frac); }); // (keeps the model's castShadow)
  const farFrac = Math.min(0.12, Math.max(0.05, frac * FAR_FRAC));
  const far = hi.clone(true);
  far.traverse((o) => { if (o.isMesh) { o.geometry = lowGeometry(o.geometry, farFrac); o.castShadow = false; } });
  // each copy's switch: no nearer than its decimation's clusters (a share of the model's size) allow
  const sz = hi.userData.size || new THREE.Vector3(1, 1, 1), L = Math.max(sz.x, sz.y, sz.z);
  const nearD = Math.max(near, (frac * L) / (LOD_ERR_PX * PX_REF));
  const farD = Math.max(near * FAR_K, nearD * 1.5, (farFrac * L) / (LOD_ERR_PX * PX_REF));
  const lod = new SmoothLOD();
  lod.addLevel(hi, 0);
  lod.addLevel(lo, nearD, 0.08);
  lod.addLevel(far, farD, 0.08);
  lod.userData.lodBase = [0, nearD, farD]; // (scaled live by the preset: SmoothLOD.update; detail.js leaves it alone)
  lod.userData.lodSelf = true;
  lod.userData.solidLevel = 1; // (world/solidify.js takes its footprints from the middle copy)
  lod.userData.size = hi.userData.size;
  lod.autoUpdate = true;
  return lod;
}

// Extract the first mesh's geometry + material, baked to fit real-world size (for instancing).
export function bakeGeometry(gltf, opts) {
  const g = fitModel(gltf, opts);
  g.updateMatrixWorld(true);
  let geo = null, mat = null;
  g.traverse((o) => {
    if (o.isMesh && !geo) {
      geo = dequantize(o.geometry);
      geo.applyMatrix4(o.matrixWorld);
      mat = o.material;
    }
  });
  if (geo && opts.decimate) {
    geo.computeBoundingBox();
    const sz = geo.boundingBox.getSize(new THREE.Vector3());
    geo = clusterDecimate(geo, Math.max(sz.x, sz.y, sz.z) * opts.decimate);
  }
  if (geo) { geo.computeBoundingBox(); geo.computeBoundingSphere(); }
  return { geometry: geo, material: mat, size: g.userData.size };
}
