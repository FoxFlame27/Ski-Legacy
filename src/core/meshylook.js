// Crisper Meshy materials on Balanced and up (Nov 1 2026, the user: "why are so many models so blurry and weird from the
// outside, not very realistic — fix ALL those"). A Meshy model carries one baked texture set stretched over the whole
// object (a 10 m building gets the same 2048 px as a chair), so up close every surface goes soft and plastic. Applied
// once per loaded GLB (core/assets.js loadGLB), only to Meshy's own materials (unnamed / "Material_N", textured; the
// hand-made car models keep theirs) and only when quality.fx >= 1: Performance / Super Performance are untouched.
//  - texture filtering: trilinear mipmaps on every map, the GPU's maximum anisotropy from High (fx >= 2) up
//  - a detail layer: a small procedural tiling map (made once, 256 px) projected triplanar in the model's own
//    space at a fixed real-world size (half a metre per repeat, whatever the model's scale or instancing), so its
//    texel density stays high when you walk right up to a wall. It adds a fine surface grain to the normal and a
//    little roughness variation, fading out with distance (nothing changes from afar, no shimmer)
//  - Meshy's metalness maps put 10-40 % "metal" noise on wood, plaster and snow (surfaces go dark and dirty under the
//    sky's reflections): partial values are pushed to dielectric / metal (smoothstep 0.2..0.8); its roughness
//    sits at 0.9-1.0 almost everywhere (chalky, no sheen): scaled by 0.92 so scene.environment (the sky's IBL,
//    world/sky.js) shows a little
// Skinned meshes (characters) are left alone. Everything shader-side is uniform-driven (one program per material
// kind): switching the preset while playing turns the layer and the tweaks off / on at once (dtlOn / dtlStr).
import * as THREE from 'three';
import { quality, gpuCaps, onQualityChange } from '../engine/quality.js';

const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
const STR = [0, 0.35, 0.45, 0.5, 0.5];   // detail normal strength by quality.fx
const FAR = [0, 16, 22, 28, 34];         // metres where the detail has faded out

let detailTex = null;
const U = {
  dtlMap: { value: null },
  dtlStr: { value: 0 },
  dtlFar: { value: 20 },
  dtlOn: { value: 0 },
  dtlTile: { value: 0.5 }, // metres per repeat
};
function setUniforms(q) {
  const fx = Math.max(0, Math.min(4, q.fx | 0));
  U.dtlStr.value = STR[fx];
  U.dtlFar.value = FAR[fx] || 1;
  U.dtlOn.value = fx >= 1 ? 1 : 0;
}
setUniforms(quality);
onQualityChange(setUniforms);

// Tileable grain: value noise over a few periodic lattices (blotches, grain, fine speckle). RG = the height's slope
// (normal offset, 0.5 = flat), B = roughness variation, A = 1.
function makeDetailTexture(N = 256) {
  let seed = 0x9e3779b9;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const octave = (out, period, amp) => {
    const lat = new Float32Array(period * period);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const cell = N / period;
    for (let y = 0; y < N; y++) {
      const fy = y / cell, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % period) * period, r1 = ((y0 + 1) % period) * period;
      for (let x = 0; x < N; x++) {
        const fx = x / cell, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % period, c1 = (x0 + 1) % period;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[y * N + x] += (a + (b - a) * sy) * amp;
      }
    }
  };
  const h = new Float32Array(N * N), r = new Float32Array(N * N);
  octave(h, 4, 0.35); octave(h, 16, 0.3); octave(h, 64, 0.22); octave(h, 128, 0.13);
  octave(r, 8, 0.5); octave(r, 32, 0.3); octave(r, 128, 0.2);
  const gx = new Float32Array(N * N), gy = new Float32Array(N * N);
  let rms = 0, rMin = 1e9, rMax = -1e9;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    gx[i] = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
    gy[i] = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    rms += gx[i] * gx[i] + gy[i] * gy[i];
    rMin = Math.min(rMin, r[i]); rMax = Math.max(rMax, r[i]);
  }
  const k = 0.35 / Math.sqrt(rms / (2 * N * N) || 1);
  const d = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    d[i * 4] = Math.round(THREE.MathUtils.clamp(0.5 + 0.5 * gx[i] * k, 0, 1) * 255);
    d[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(0.5 + 0.5 * gy[i] * k, 0, 1) * 255);
    d[i * 4 + 2] = Math.round(((r[i] - rMin) / (rMax - rMin || 1)) * 255);
    d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// (one shared function: its source is the program cache key, so every Meshy material of a kind shares a program;
// code that later replaces onBeforeCompile on a material simply gets the plain one back)
function detailCompile(shader) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
uniform float dtlTile;
varying vec4 vDtlP; varying vec4 vDtlX; varying vec4 vDtlY;`)
    .replace('#include <project_vertex>', `#include <project_vertex>
{
#ifdef USE_INSTANCING
  mat3 dIm = mat3(instanceMatrix);
#else
  mat3 dIm = mat3(1.0);
#endif
  float dS = length(modelMatrix[0].xyz) * length(dIm[0]);
  mat3 dMv = mat3(modelViewMatrix) * dIm;
  // (three varyings: position in detail repeats + the object-space normal in the w's, two view-space axes)
  vDtlP = vec4(transformed * (dS / dtlTile), objectNormal.x);
  vDtlX = vec4(dMv[0], objectNormal.y);
  vDtlY = vec4(dMv[1], objectNormal.z);
}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform sampler2D dtlMap; uniform float dtlStr; uniform float dtlFar; uniform float dtlOn;
varying vec4 vDtlP; varying vec4 vDtlX; varying vec4 vDtlY;`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float dF = dtlStr * (1.0 - smoothstep(dtlFar * 0.3, dtlFar, length(vViewPosition)));
  {
    vec3 dW = abs(normalize(vec3(vDtlP.w, vDtlX.w, vDtlY.w))); dW *= dW; dW *= dW; dW /= dot(dW, vec3(1.0));
    vec4 dA = texture2D(dtlMap, vDtlP.yz), dB = texture2D(dtlMap, vDtlP.zx), dC = texture2D(dtlMap, vDtlP.xy);
    vec2 gA = dA.rg * 2.0 - 1.0, gB = dB.rg * 2.0 - 1.0, gC = dC.rg * 2.0 - 1.0;
    vec3 dO = dW.x * vec3(0.0, gA.x, gA.y) + dW.y * vec3(gB.y, 0.0, gB.x) + dW.z * vec3(gC.x, gC.y, 0.0);
    vec3 dX = normalize(vDtlX.xyz), dY = normalize(vDtlY.xyz);
    vec3 dV = dX * dO.x + dY * dO.y + cross(dX, dY) * dO.z; // (a mirrored model only flips the grain)
    dV -= normal * dot(dV, normal);
    normal = normalize(normal + dV * dF);
    float dR = (dW.x * dA.b + dW.y * dB.b + dW.z * dC.b - 0.5) * dF;
    roughnessFactor += dR * 0.25 * dtlOn;
  }
#ifdef USE_METALNESSMAP
  metalnessFactor = mix(metalnessFactor, smoothstep(0.2, 0.8, metalnessFactor), dtlOn);
#endif
  roughnessFactor = clamp(mix(roughnessFactor, roughnessFactor * 0.92, dtlOn), 0.04, 1.0);
}`);
}

const isMeshyMaterial = (m) => m && m.isMeshStandardMaterial && m.map && !m.transparent && (m.name === '' || /^Material_\d+$/.test(m.name));
const done = new WeakSet();

/** Applies the Balanced+ look to a freshly loaded GLB's Meshy materials (no-op on fx 0). */
export function enhanceMeshy(gltf) {
  const fx = quality.fx | 0;
  if (fx < 1 || !gltf?.scene) return;
  const skinned = new Set();
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) for (const m of [].concat(o.material)) skinned.add(m); });
  const aniso = fx >= 2 ? Math.max(1, gpuCaps.maxAniso || 16) : 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    // (a mesh exported without normals renders faceted / black: smooth ones from its triangles)
    if (o.geometry && !o.geometry.attributes.normal && o.geometry.attributes.position) o.geometry.computeVertexNormals();
    for (const m of [].concat(o.material)) {
      if (!isMeshyMaterial(m) || done.has(m)) continue;
      done.add(m);
      for (const k of MAPS) {
        const t = m[k];
        if (!t) continue;
        t.colorSpace = k === 'map' || k === 'emissiveMap' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        if (aniso > t.anisotropy) t.anisotropy = aniso;
        t.needsUpdate = true;
      }
      if (skinned.has(m) || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) continue;
      if (!detailTex) U.dtlMap.value = detailTex = makeDetailTexture();
      m.onBeforeCompile = detailCompile;
      m.needsUpdate = true;
    }
  });
}
