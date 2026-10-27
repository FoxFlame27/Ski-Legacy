// GLB asset loading (Meshy models, meshopt + webp compressed) with caching and real-world sizing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();
const BASE = './models/';

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
              // max anisotropic filtering on every PBR map keeps surfaces crisp at grazing angles
              for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
                if (o.material[k]) o.material[k].anisotropy = 16;
              }
            }
          }
        });
        g.modelName = name; // lets ski code apply per-model frames (player/skier.js)
        resolve(g);
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

// THREE.LOD: full Meshy detail within `near` meters, a decimated copy beyond.
export function makeLOD(gltf, opts, near = 140, frac = 0.025) {
  const hi = fitModel(gltf, opts);
  const lo = hi.clone(true);
  lo.traverse((o) => { if (o.isMesh) { o.geometry = lowGeometry(o.geometry, frac); o.castShadow = false; } });
  const lod = new THREE.LOD();
  lod.addLevel(hi, 0);
  lod.addLevel(lo, near);
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
