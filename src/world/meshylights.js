// Meshy light fixtures for the spots that used to build their own lamps out of boxes: the lantern of the village
// lamp post (lamp_post.glb) on its scroll bracket, for walls and timber posts (the tunnels and their portals), the
// whole lamp post scaled down (the secret huts), and a piste floodlight bank (the models pistelights.js uses) for
// the race tunnels and the helipad mast. Geometry is cut from the loaded models once and shared (instanced where a
// lamp repeats); no new textures: the materials are the models' own, their glass made to glow.
import * as THREE from 'three';
import { dequantize } from '../core/assets.js';
import { meshyHead, HEADS, bakedLow } from './pistelights.js';

// ------------------------------------------------------------------ the lamp post's lantern
// lamp_post.glb in its own coordinates (y -1..1; the post at -z, the lantern on its bracket at +z), measured on
// the model: where the bracket arm leaves the post (z, y), the post's axis, the lantern's glass and its flame.
const LP = { cutZ: -0.2365, armY: -0.02, postZ: -0.345, glassMin: [-0.21, -0.2, 0.01], glassMax: [0.21, 0.45, 0.43], flame: [0, 0.13, 0.215] };
const src = new WeakMap();
function lampSource(gltf) {
  if (!gltf) return null;
  let s = src.get(gltf);
  if (s !== undefined) return s;
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  s = null;
  if (mesh) {
    const geo = dequantize(mesh.geometry);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.computeBoundingBox();
    const bb = geo.boundingBox, k = (bb.max.y - bb.min.y) / 2, c = bb.getCenter(new THREE.Vector3());
    // model units (y -1..1) -> the geometry's own
    const U = (x, y, z) => new THREE.Vector3(c.x + x * k, c.y + y * k, c.z + z * k);
    s = { geo, material: mesh.material, U, k, bb, cache: new Map() };
  }
  src.set(gltf, s);
  return s;
}
// the triangles `keep(a, b, c)` accepts (vertex indices), with only the vertices they use
function subset(geo, keep) {
  const idx = geo.index ? geo.index.array : Array.from({ length: geo.attributes.position.count }, (_, i) => i);
  const remap = new Int32Array(geo.attributes.position.count).fill(-1), used = [], out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (!keep(a, b, c)) continue;
    for (const v of [a, b, c]) { if (remap[v] < 0) { remap[v] = used.length; used.push(v); } out.push(remap[v]); }
  }
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const n = attr.itemSize, arr = new Float32Array(used.length * n);
    used.forEach((v, i) => { for (let q = 0; q < n; q++) arr[i * n + q] = attr.array[v * n + q]; });
    g.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  g.setIndex(out);
  return g;
}

/**
 * The lantern on its bracket, cut off the lamp post where the arm leaves it: origin = the arm's end (fixed to a wall
 * or a post there), +z out of the wall, +y up; `size` = metres per model unit (0.8: a lantern ~0.33 m wide, its glass
 * ~0.55 m tall, the flame 0.36 m out from the wall). Returns { geometry, flame, glassMin, glassMax } (local) or null.
 */
export function lanternOnBracket(gltf, size = 0.8) {
  const s = lampSource(gltf);
  if (!s) return null;
  const key = 'bracket' + size;
  if (s.cache.has(key)) return s.cache.get(key);
  const P = s.geo.attributes.position, cut = s.U(0, LP.armY, LP.cutZ), lo = s.U(0, -0.6, 0).y, near = s.U(0, 0, -0.2).z, arm = 0.03 * s.k;
  // past the post's surface and above its foot; close to the post only the thin arm (no slivers of its collars)
  const g = subset(s.geo, (a, b, c) => {
    const z = Math.min(P.getZ(a), P.getZ(b), P.getZ(c));
    return z >= cut.z && Math.min(P.getY(a), P.getY(b), P.getY(c)) > lo && (z >= near || Math.max(Math.abs(P.getX(a)), Math.abs(P.getX(b)), Math.abs(P.getX(c))) <= arm);
  });
  const k = size / s.k;
  g.translate(-cut.x, -cut.y, -cut.z);
  g.scale(k, k, k);
  g.computeBoundingBox(); g.computeBoundingSphere();
  const L = (v) => v.sub(cut).multiplyScalar(k);
  const r = { geometry: g, flame: L(s.U(...LP.flame)), glassMin: L(s.U(...LP.glassMin)), glassMax: L(s.U(...LP.glassMax)), size: g.boundingBox.getSize(new THREE.Vector3()) };
  s.cache.set(key, r);
  return r;
}

/** The whole lamp post `height` m tall: origin at the foot of the post, the lantern's bracket toward +z. */
export function lampPost(gltf, height = 2.5) {
  const s = lampSource(gltf);
  if (!s) return null;
  const key = 'post' + height;
  if (s.cache.has(key)) return s.cache.get(key);
  const g = s.geo.clone(), foot = new THREE.Vector3(s.U(0, 0, LP.postZ).x, s.bb.min.y, s.U(0, 0, LP.postZ).z);
  const k = height / (s.bb.max.y - s.bb.min.y);
  g.translate(-foot.x, -foot.y, -foot.z);
  g.scale(k, k, k);
  g.computeBoundingBox(); g.computeBoundingSphere();
  const L = (v) => v.sub(foot).multiplyScalar(k);
  const r = { geometry: g, flame: L(s.U(...LP.flame)), glassMin: L(s.U(...LP.glassMin)), glassMax: L(s.U(...LP.glassMax)), size: g.boundingBox.getSize(new THREE.Vector3()) };
  s.cache.set(key, r);
  return r;
}

/**
 * The lamp post's own material with its glass lit: the sides of the lantern's glass box (its panes full, the thin
 * dark iron between them dimmer; the texture has no clean pane mask) and Meshy's emissive strips glow `color` x
 * emissiveIntensity (so a runtime can flicker it).
 * deSnow: the snow on the roof turns to dark iron (indoors). interior: lit like the tunnel walls (aLight per
 * vertex or per instance = (lamp, daylight): the sun and the sky only reach in near the portals).
 */
export function lanternMaterial(gltf, fixture, { color = [1.0, 0.62, 0.3], intensity = 3, deSnow = false, interior = false } = {}) {
  const s = lampSource(gltf);
  const m = s.material.clone();
  m.emissive = new THREE.Color(...color);
  m.emissiveIntensity = intensity;
  const gMin = fixture.glassMin.clone(), gMax = fixture.glassMax.clone();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlassMin = { value: gMin };
    sh.uniforms.uGlassMax = { value: gMax };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
varying vec3 vLP; varying vec3 vLN;${interior ? '\nattribute vec2 aLight; varying vec2 vLight;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vLP = position; vLN = normal;${interior ? ' vLight = aLight;' : ''}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform vec3 uGlassMin; uniform vec3 uGlassMax; varying vec3 vLP; varying vec3 vLN;${interior ? '\nvarying vec2 vLight;' : ''}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
${deSnow ? `{
  float sn = smoothstep(0.55, 0.75, min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b))) * smoothstep(0.2, 0.55, normalize(vLN).y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.04, 0.045), sn);
}` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 q = step(uGlassMin, vLP) * step(vLP, uGlassMax);
  float side = 1.0 - smoothstep(0.45, 0.75, abs(normalize(vLN).y)); // (panes, not the plates above / below)
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  totalEmissiveRadiance = emissive * (q.x * q.y * q.z * side * (0.55 + 0.85 * smoothstep(0.012, 0.2, lum))) + totalEmissiveRadiance * 0.7;
  ${interior ? `totalEmissiveRadiance += diffuseColor.rgb * emissive * 0.25 * vLight.x;` : ''}
}`);
    if (interior) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.directDiffuse *= vLight.y;
reflectedLight.directSpecular *= vLight.y;
reflectedLight.indirectDiffuse *= mix(vec3(0.03), vec3(1.0), vLight.y);
reflectedLight.indirectSpecular *= mix(0.05, 1.0, vLight.y);`);
    }
  };
  m.customProgramCacheKey = () => `meshy-lantern-${deSnow ? 1 : 0}${interior ? 1 : 0}`;
  return m;
}

/**
 * Lanterns on brackets, one draw: `frames` = [{ position: Vector3 (the arm's end, on the wall), out: Vector3 (the
 * wall's outward normal, horizontal), light?: [lamp, daylight] }]. Returns { mesh, flames: Vector3[] } (flames in
 * world space) or null without the model.
 */
export function bracketLanterns(gltf, frames, { size = 0.8, ...matOpts } = {}) {
  const fx = lanternOnBracket(gltf, size);
  if (!fx || !frames.length) return null;
  const mat = lanternMaterial(gltf, fx, matOpts);
  // (interior: a geometry of its own sharing the lantern's buffers, carrying the per-lantern light)
  let geo = fx.geometry;
  if (matOpts.interior) {
    geo = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(fx.geometry.attributes)) geo.setAttribute(name, a);
    geo.setIndex(fx.geometry.index);
    geo.boundingBox = fx.geometry.boundingBox; geo.boundingSphere = fx.geometry.boundingSphere;
  }
  const mesh = new THREE.InstancedMesh(geo, mat, frames.length);
  mesh.userData.sharedGeometry = true; // (the buffers are the cached lantern's: never dispose them)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0), flames = [];
  const light = matOpts.interior ? new Float32Array(frames.length * 2) : null;
  frames.forEach((f, i) => {
    q.setFromAxisAngle(Y, Math.atan2(f.out.x, f.out.z));
    m4.compose(f.position, q, one);
    mesh.setMatrixAt(i, m4);
    flames.push(fx.flame.clone().applyMatrix4(m4));
    if (light) { light[i * 2] = f.light?.[0] ?? 0.9; light[i * 2 + 1] = f.light?.[1] ?? 0; }
  });
  if (light) geo.setAttribute('aLight', new THREE.InstancedBufferAttribute(light, 2));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true; mesh.receiveShadow = true;
  return { mesh, flames, fixture: fx };
}

// ------------------------------------------------------------------ floodlight banks
/** A piste floodlight bank (HEADS in pistelights.js) `width` m wide: lamps facing +z, the tube cut at the origin. */
export function floodBank(models, name = 'floodlight_head_c', width) {
  const gltf = models?.[name], spec = HEADS[name];
  if (!gltf || !spec) return null;
  return meshyHead(gltf, width ? { ...spec, width } : spec);
}

/**
 * The bank's own material with its lamps' glass lit `color` x on.value (uniform; 0 = off): an LED / COB array,
 * the bright chips brightest. deSnow: the snow on its top turns to the dark frame (indoors). baked: for the bank's
 * vertex-coloured low copy (floodBankLow), no textures. interior: lit like a tunnel's lining (aLight per instance =
 * (own light, daylight): the sun and the sky only reach in near the portals; ice: through the ice, a blue glow).
 */
export function floodMaterial(head, { color = [1.0, 0.86, 0.68], on = { value: 1 }, gain = 1, deSnow = false, baked = false, interior = null } = {}) {
  const mat = head.material.clone();
  mat.emissive = new THREE.Color(1, 1, 1);
  mat.emissiveIntensity = 1;
  if (baked) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) mat[k] = null;
    mat.vertexColors = true; mat.roughness = 0.45; mat.metalness = 0.5;
  }
  const rects = new Float32Array(8 * 4);
  head.rects.forEach((r, k) => rects.set(r, k * 4));
  const n = head.rects.length, col = new THREE.Color(...color);
  mat.onBeforeCompile = (s) => {
    s.uniforms.uFloodOn = on;
    s.uniforms.uFloodCol = { value: col };
    s.uniforms.uLampRect = { value: rects };
    s.uniforms.uFront = { value: head.front };
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>
varying vec3 vHP; varying vec3 vHN;${interior ? '\nattribute vec2 aLight; varying vec2 vLight;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vHP = position; vHN = normal;${interior ? ' vLight = aLight;' : ''}`);
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
uniform float uFloodOn; uniform vec3 uFloodCol; uniform vec4 uLampRect[ 8 ]; uniform float uFront;
varying vec3 vHP; varying vec3 vHN;${interior ? '\nvarying vec2 vLight;' : ''}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
${deSnow ? `{
  float sn = smoothstep(0.62, 0.8, min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b))) * smoothstep(0.35, 0.7, normalize(vHN).y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.052, 0.058), sn);
}` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float glass = 0.0;
  for (int i = 0; i < ${n}; i++) {
    vec4 r = uLampRect[i];
    vec2 d = abs(vHP.xy - r.xy) - r.zw;
    glass = max(glass, 1.0 - smoothstep(-0.03, 0.01, max(d.x, d.y)));
  }
  glass *= smoothstep(0.55, 0.85, normalize(vHN).z) * smoothstep(uFront - 0.2, uFront - 0.09, vHP.z);
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float led = smoothstep(0.35, 0.9, lum);
  totalEmissiveRadiance = uFloodCol * uFloodOn * ${gain.toFixed(3)} * (glass * (2.5 + 18.0 * led)${baked ? '' : ' + totalEmissiveRadiance * 8.0'});
  ${interior ? 'totalEmissiveRadiance += diffuseColor.rgb * uFloodCol * uFloodOn * 0.12 * vLight.x; // (its own spill on the frame)' : ''}
}`);
    if (interior) {
      s.fragmentShader = s.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.directDiffuse *= vLight.y;
reflectedLight.directSpecular *= vLight.y;
reflectedLight.indirectDiffuse *= mix(${interior === 'ice' ? 'vec3(0.2, 0.42, 0.75)' : 'vec3(0.035)'}, vec3(1.0), vLight.y);
reflectedLight.indirectSpecular *= mix(${interior === 'ice' ? '0.4' : '0.06'}, 1.0, vLight.y);`);
    }
  };
  mat.customProgramCacheKey = () => `meshy-flood-${n}-${deSnow ? 1 : 0}-${baked ? 1 : 0}-${interior || 0}-${gain}`;
  return mat;
}

/** The bank's low copy: its texture baked into vertex colours, clustered to `cell` m (for floodMaterial baked). */
export function floodBankLow(head, cell = 0.02) {
  return bakedLow(head.geometry, head.material.map, cell);
}

/** Centre of the bank's glass (head-local) and the way it faces (+z). */
export function floodCenter(head) {
  const R = head.rects;
  return new THREE.Vector3(R.reduce((a, r) => a + r[0], 0) / R.length, R.reduce((a, r) => a + r[1], 0) / R.length, head.front);
}
