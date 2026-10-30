// Static mesh merging (performance pass, Oct 30): the hand-built houses (the police station, the medical centre, the
// Autohaus, the village props) are made of hundreds of small boxes, each its own draw call (and its own shadow-pass
// draw). mergeStatic(root) welds every group of plain meshes that share a material (and shadow flags, render order,
// layers) into one mesh per material, in root's frame. Only what is safe to weld is taken:
//  - plain THREE.Mesh leaves (no children, not instanced / skinned / morphed), visible, with one material
//  - geometry with Float32 attributes only (no quantized Meshy data, no interleaved buffers), all indexed or none
//  - no custom onBeforeRender, not marked userData.noMerge / dynamic, every ancestor up to root plain and visible
//  - the `keep` set (meshes the module still moves, hides or recolours later) is left alone, and so is everything
//    under a `skip` group (a group hidden as a whole later, e.g. the house a window view hides: merge it on its own)
// Returns { before, after } draw counts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const BASE_OBR = THREE.Object3D.prototype.onBeforeRender, BASE_OAR = THREE.Object3D.prototype.onAfterRender;

function signature(g) {
  const a = g.attributes, keys = Object.keys(a).sort();
  for (const k of keys) {
    const at = a[k];
    if (at.isInterleavedBufferAttribute || !(at.array instanceof Float32Array) || at.normalized) return null;
  }
  if (Object.keys(g.morphAttributes || {}).length) return null;
  if (!a.position) return null;
  return keys.map((k) => `${k}${a[k].itemSize}`).join(',') + (g.index ? '|i' : '|n');
}

function plainChain(o, root, skip) {
  for (let p = o.parent; p && p !== root; p = p.parent) {
    if (!p.visible || p.isLOD || p.isSkinnedMesh || p.isInstancedMesh || p.userData.noMerge || p.userData.dynamic || skip?.has(p)) return false;
  }
  return true;
}

export function mergeStatic(root, { keep = null, skip = null, minCount = 2, maxVerts = 400000 } = {}) {
  if (Array.isArray(skip)) skip = new Set(skip.filter(Boolean));
  if (!root) return { before: 0, after: 0 };
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const buckets = new Map();
  let total = 0;
  root.traverse((o) => {
    if (!o.isMesh || o === root) return;
    total++;
    if (o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh || o.children.length || !o.visible) return;
    if (Array.isArray(o.material) || !o.material || o.morphTargetInfluences) return;
    if (o.onBeforeRender !== BASE_OBR || o.onAfterRender !== BASE_OAR) return;
    if (o.userData.noMerge || o.userData.dynamic || keep?.has(o)) return;
    if (!plainChain(o, root, skip)) return;
    const sig = signature(o.geometry);
    if (!sig) return;
    const m = o.material;
    const key = `${m.uuid}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${o.renderOrder}|${o.layers.mask}|${o.frustumCulled ? 1 : 0}|${o.customDepthMaterial?.uuid || ''}|${sig}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(o);
  });
  let removed = 0, added = 0;
  for (const list of buckets.values()) {
    if (list.length < minCount) continue;
    // in chunks of at most maxVerts vertices (one huge buffer culls badly and may need 32-bit indices anyway)
    let chunk = [], verts = 0;
    const flush = () => {
      if (chunk.length >= minCount) {
        const geos = chunk.map((o) => {
          const g = o.geometry.clone();
          for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uv1', 'uv2', 'color', 'tangent'].includes(k)) g.deleteAttribute(k);
          _m.multiplyMatrices(_inv, o.matrixWorld);
          g.applyMatrix4(_m);
          return g;
        });
        // (the attribute sets must agree after the trim)
        const sig0 = Object.keys(geos[0].attributes).sort().join();
        if (geos.every((g) => Object.keys(g.attributes).sort().join() === sig0)) {
          const merged = mergeGeometries(geos, false);
          if (merged) {
            merged.computeBoundingSphere(); merged.computeBoundingBox();
            const o0 = chunk[0];
            const mesh = new THREE.Mesh(merged, o0.material);
            mesh.name = `${root.name || 'static'}-merged`;
            mesh.castShadow = o0.castShadow; mesh.receiveShadow = o0.receiveShadow;
            mesh.renderOrder = o0.renderOrder; mesh.layers.mask = o0.layers.mask; mesh.frustumCulled = o0.frustumCulled;
            if (o0.customDepthMaterial) mesh.customDepthMaterial = o0.customDepthMaterial;
            mesh.matrixAutoUpdate = false; mesh.updateMatrix();
            root.add(mesh);
            for (const o of chunk) { o.parent?.remove(o); }
            removed += chunk.length; added++;
          }
        }
        for (const g of geos) g.dispose();
      }
      chunk = []; verts = 0;
    };
    for (const o of list) {
      const n = o.geometry.attributes.position.count;
      if (verts + n > maxVerts && chunk.length) flush();
      chunk.push(o); verts += n;
    }
    flush();
  }
  // the source geometries no longer drawn anywhere are freed by the caller's GC (they may be shared: not disposed here)
  return { before: total, after: total - removed + added };
}

// Repeated props (benches, lanterns, bins, fences: the same Meshy mesh placed many times) -> one InstancedMesh per
// geometry + material pair under root, in root's frame. Same safety rules as mergeStatic, but any geometry is fine
// (quantized Meshy data included: nothing is baked, every copy keeps its transform as an instance matrix).
export function instanceStatic(root, { keep = null, skip = null, minCount = 3 } = {}) {
  if (!root) return { before: 0, after: 0 };
  if (Array.isArray(skip)) skip = new Set(skip.filter(Boolean));
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const buckets = new Map();
  let total = 0;
  root.traverse((o) => {
    if (!o.isMesh || o === root) return;
    total++;
    if (o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh || o.children.length || !o.visible) return;
    if (Array.isArray(o.material) || !o.material || o.morphTargetInfluences) return;
    if (o.onBeforeRender !== BASE_OBR || o.onAfterRender !== BASE_OAR) return;
    if (o.userData.noMerge || o.userData.dynamic || keep?.has(o)) return;
    if (!plainChain(o, root, skip)) return;
    const key = `${o.geometry.uuid}|${o.material.uuid}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${o.renderOrder}|${o.layers.mask}|${o.customDepthMaterial?.uuid || ''}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(o);
  });
  let removed = 0, added = 0;
  for (const list of buckets.values()) {
    if (list.length < minCount) continue;
    const o0 = list[0];
    const im = new THREE.InstancedMesh(o0.geometry, o0.material, list.length);
    list.forEach((o, i) => { _m.multiplyMatrices(_inv, o.matrixWorld); im.setMatrixAt(i, _m); });
    im.instanceMatrix.needsUpdate = true;
    im.name = `${root.name || 'static'}-instanced`;
    im.castShadow = o0.castShadow; im.receiveShadow = o0.receiveShadow; im.renderOrder = o0.renderOrder; im.layers.mask = o0.layers.mask;
    if (o0.customDepthMaterial) im.customDepthMaterial = o0.customDepthMaterial;
    im.computeBoundingSphere(); im.computeBoundingBox?.();
    im.matrixAutoUpdate = false; im.updateMatrix();
    root.add(im);
    for (const o of list) o.parent?.remove(o);
    removed += list.length; added++;
  }
  return { before: total, after: total - removed + added };
}
