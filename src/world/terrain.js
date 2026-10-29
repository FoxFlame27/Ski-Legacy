// Quadtree-LOD streamed terrain with a custom alpine snow/rock shader.
import * as THREE from 'three';
import { world } from './world.js';
import { quality, onQualityChange } from '../engine/quality.js';

const SEG = 64; // segments per node
const MIN_SIZE = 128;
const ROOT_SIZE = 16384;
// LOD: a node splits while the camera is closer than size x quality.terrain.lodK (2.5 on High)

export const terrainUniforms = {
  uTime: { value: 0 },
  uSparkle: { value: 1 },
  uSnowCover: { value: 0 }, // fresh snow amount (covers trails / rock edges)
};

// Tileable noise texture: R = fbm, GB = its gradient, A = a second independent fbm.
// Sampling this is far cheaper than procedural noise per pixel and mipmaps away distant aliasing.
function makeNoiseTexture() {
  const S = 256, U = 8; // 8 noise units per tile
  const data = new Uint8Array(S * S * 4);
  const lattice = (seed, period) => {
    const g = new Float32Array(period * period);
    let x = seed * 9301 + 49297;
    for (let i = 0; i < g.length; i++) { x = (x * 233280 + 49297) % 2147483647; g[i] = (x % 10000) / 10000; }
    return g;
  };
  const sample = (g, period, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const at = (i, j) => g[((j % period + period) % period) * period + ((i % period + period) % period)];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (seed, x, y) => {
    let s = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < 5; o++) {
      const per = U << o;
      s += amp * sample(lattice(seed + o, per), per, x * (1 << o), y * (1 << o));
      norm += amp; amp *= 0.5;
    }
    return s / norm;
  };
  // cache lattices
  const cacheA = [], cacheB = [];
  for (let o = 0; o < 5; o++) { cacheA.push(lattice(1 + o, U << o)); cacheB.push(lattice(50 + o, U << o)); }
  const fbmC = (cache, x, y) => {
    let s = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < 5; o++) { s += amp * sample(cache[o], U << o, x * (1 << o), y * (1 << o)); norm += amp; amp *= 0.5; }
    return s / norm;
  };
  void fbm;
  const A = new Float32Array(S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i / S) * U, y = (j / S) * U;
    A[j * S + i] = fbmC(cacheA, x, y);
    data[(j * S + i) * 4 + 3] = Math.round(fbmC(cacheB, x, y) * 255);
  }
  const k = S / U; // pixels per noise unit
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const dx = (A[j * S + ((i + 1) % S)] - A[j * S + ((i - 1 + S) % S)]) * k / 2;
    const dy = (A[((j + 1) % S) * S + i] - A[((j - 1 + S) % S) * S + i]) * k / 2;
    const o = (j * S + i) * 4;
    data[o] = Math.round(A[j * S + i] * 255);
    data[o + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + dx / 6)) * 255);
    data[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + dy / 6)) * 255);
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4; // (8 cost ~2.8 ms a frame at grazing angles for no visible gain on these soft patterns)
  tex.needsUpdate = true;
  return tex;
}
terrainUniforms.uNoise = { value: makeNoiseTexture() };

// Night skiing (world/pistelights.js fills these): the PL_MAX masts nearest the camera are lit per pixel, a
// baked pool map covers the rest. Off (uPLParams.x = 0) by day or without the module. The arrays are typed so
// pistelights.js can share them with every other lit material (characters, trees, props).
export const PL_MAX = 16;
export const PL_RANGE = 110; // m: a mast's light ends here
// forward-throw floodlight beam (shared with pistelights.js): ld = unit vector lamp -> point, a = aim; wide along
// the run, soft above the aim (toward the far side), sharp below it (no hot spot at the mast's foot).
// shape = (along, above, below, spill)
export const PL_BEAM_GLSL = `
  float plBeam(vec3 ld, vec3 a, vec4 shape) {
    float ca = dot(ld, a);
    if (ca <= 0.0) return 0.0;
    vec3 t = vec3(-a.z, 0.0, a.x) * inversesqrt(max(a.x * a.x + a.z * a.z, 1e-6));
    vec3 u = cross(t, a);
    float ic = 1.0 / ca;
    float x = dot(ld, t) * ic, v = dot(ld, u) * ic;
    return exp(-x * x * shape.x - v * v * (v > 0.0 ? shape.y : shape.z));
  }`;
{
  const blank = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
  blank.needsUpdate = true;
  Object.assign(terrainUniforms, {
    uPLPos: { value: new Float32Array(PL_MAX * 4) },   // xyz light centre, w intensity
    uPLAim: { value: new Float32Array(PL_MAX * 4) },   // xyz aim (unit), w 1 / range^4 (0: PL_RANGE; street lamps reach less far)
    uPLParams: { value: new Float32Array(4) },         // on, count, near radius (m), crossfade (m)
    uPLShape: { value: new Float32Array([0.12, 0.7, 4.5, 0.035]) },
    uPLColor: { value: new Float32Array([1, 0.83, 0.64]) },
    uPLMap: { value: blank },                          // baked far-field pools (sqrt-encoded irradiance)
    uPLMapRect: { value: new Float32Array(4) },        // origin xz, 1 / size xz
    uPLMapK: { value: 0 },                             // irradiance of a full texel (0 = off)
  });
}

// Clip volumes (world/railway.js fills them): no terrain inside a railway tunnel's tube just behind each portal, where
// the heightfield rises from the cutting to the cover over the tube (a cab would pass through that sliver), or inside
// the reveals of a gallery's windows. A volume is a box in a line's frame, its top optionally rounded like the tube's
// arch: origin o (top of rail), horizontal unit tangent t, grade (dy per m along), along [a0, a1], half width hw,
// height over the line [v0, v1], an elliptic crown over vS. Only the terrain nodes that touch a volume get the
// clipping variant of the shader and of its shadow depth (a discard costs the GPU's early depth / hidden-surface
// removal, so the rest of the terrain never pays for it).
export const TCLIP_MAX = 8;
// The volumes come in named sets (railway.js: the Wolkenspitzbahn's portals; expresstrack.js: the Legacy Express's
// portals and its village entrance's stairwell): more than TCLIP_MAX in all, so the TCLIP_MAX nearest the focus
// (terrainClipFocus, the camera; a portal only matters with the camera near it) are the ones installed.
const CLIP = { boxes: [], terrains: new Set(), sets: new Map(), pick: [], fx: 0, fz: 0 };
Object.assign(terrainUniforms, {
  uTClipN: { value: 0 },
  uTClipO: { value: new Float32Array(TCLIP_MAX * 4) }, // origin xyz, grade
  uTClipT: { value: new Float32Array(TCLIP_MAX * 4) }, // tangent xz, along a0, a1
  uTClipS: { value: new Float32Array(TCLIP_MAX * 4) }, // half width, v0, vS, v1
});
const TCLIP_GLSL = `
  uniform int uTClipN;
  uniform vec4 uTClipO[${TCLIP_MAX}];
  uniform vec4 uTClipT[${TCLIP_MAX}];
  uniform vec4 uTClipS[${TCLIP_MAX}];
  // (a plain loop: no continue / break / early return, which GPU shader translators handle least reliably)
  bool tClipped(vec3 p) {
    bool hit = false;
    for (int i = 0; i < ${TCLIP_MAX}; i++) {
      if (i < uTClipN) {
        vec4 o = uTClipO[i], t = uTClipT[i], s = uTClipS[i];
        vec3 d = p - o.xyz;
        float a = d.x * t.x + d.z * t.y;
        float x = d.x * t.y - d.z * t.x;
        float v = d.y - a * o.w;
        float ex = x / s.x, ey = max(v - s.z, 0.0) / max(s.w - s.z, 1e-3);
        if (a >= t.z && a <= t.w && v >= s.y && v <= s.w && ex * ex + ey * ey <= 1.0) hit = true;
      }
    }
    return hit;
  }`;
/** Replace the clip volumes of set `name` (the others stay). */
export function setTerrainClipSet(name, list) {
  CLIP.sets.set(name, list || []);
  installClips(true);
}
/** The Wolkenspitzbahn's volumes (railway.js; replaces its set, as it always did). */
export function setTerrainClips(list) { setTerrainClipSet('rail', list); }
/** Where the camera is: with more volumes than TCLIP_MAX the nearest are installed (re-picked every ~40 m). */
export function terrainClipFocus(x, z) {
  if (Math.abs(x - CLIP.fx) < 40 && Math.abs(z - CLIP.fz) < 40) return;
  CLIP.fx = x; CLIP.fz = z;
  installClips(false);
}
function installClips(force) {
  let list = [];
  for (const l of CLIP.sets.values()) list = list.concat(l);
  if (list.length > TCLIP_MAX) {
    const d2 = (b) => (b.x - CLIP.fx) ** 2 + (b.z - CLIP.fz) ** 2;
    list = list.map((b) => [d2(b), b]).sort((a, b) => a[0] - b[0]).slice(0, TCLIP_MAX).map((a) => a[1]);
  }
  if (!force && list.length === CLIP.pick.length && list.every((b) => CLIP.pick.includes(b))) return;
  CLIP.pick = list;
  const n = list.length;
  const O = terrainUniforms.uTClipO.value, T = terrainUniforms.uTClipT.value, S = terrainUniforms.uTClipS.value;
  CLIP.boxes = [];
  for (let i = 0; i < n; i++) {
    const b = list[i];
    O.set([b.x, b.y, b.z, b.grade || 0], i * 4);
    T.set([b.tx, b.tz, b.a0, b.a1], i * 4);
    S.set([b.hw, b.v0, b.vS ?? b.v1, b.v1], i * 4);
    const r = Math.max(Math.abs(b.a0), Math.abs(b.a1)) + b.hw + 1; // footprint, for picking the nodes
    CLIP.boxes.push({ x0: b.x - r, x1: b.x + r, z0: b.z - r, z1: b.z + r });
  }
  terrainUniforms.uTClipN.value = n;
  for (const t of CLIP.terrains) for (const a of t.active.values()) t.applyClip(a.mesh, a.node);
}
function clipDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    for (const k of ['uTClipN', 'uTClipO', 'uTClipT', 'uTClipS']) shader.uniforms[k] = terrainUniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTClipW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTClipW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTClipW;\n${TCLIP_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (tClipped(vTClipW)) discard;');
  };
  return m;
}

// The snow / rock look (tuned against the Ski Legacy logo):
//  - snow: crisp, faintly warm white in the sun; the sky light makes everything turned away from the sun clearly
//    blue (not grey); soft wind-packed variation, sastrugi, grain, corduroy on groomed pistes, HDR ice glints
//  - rock: dark slate-blue faces with irregular strata and snow settled on their relief; the ledges of the crags'
//    stacked cliff bands hold broken stretches of snow, so the bands never read as regular stripes
export function createTerrainMaterial({ clip = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0 });
  // shader detail (graphics preset): 0 = lean (Performance), 1 = full, 2 = cinematic snow micro detail + sparkle
  mat.defines = { TERRAIN_DETAIL: quality.terrain.detail };
  if (clip) mat.defines.TERRAIN_CLIP = 1; // the clip volumes' discard (setTerrainClips)
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, terrainUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aData;
        attribute float aMacro;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying vec4 vData;
        varying float vMacro;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);
        vData = aData;
        vMacro = aMacro;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uSparkle;
        uniform float uSnowCover;
        uniform sampler2D uNoise;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying vec4 vData;
        varying float vMacro; // large-scale slope without the cliff bands (see Terrain.buildNode)
        // integer hash, exact for any cell index (a float hash runs out of precision a few hundred metres from
        // the origin and repeats along whole rows of cells, which drew glint stripes across the snow)
        float tHash(ivec2 c) {
          uvec2 q = uvec2(c + ivec2(16777216)) * uvec2(1597334673u, 3812015801u);
          uint n = (q.x ^ q.y) * 1597334673u;
          return float(n >> 8u) * (1.0 / 16777216.0);
        }
        // p in "noise units" (1 unit = one base lattice cell)
        vec4 nTex(vec2 p) { return texture2D(uNoise, p * 0.125); }
        // the same at an explicit mip level: no anisotropic filtering (several taps at grazing angles) and safe in
        // branches; 32 texels per noise unit
        vec4 nTexL(vec2 p, float lod) { return textureLod(uNoise, p * 0.125, lod); }
        // ... and with explicit screen gradients (anisotropic, safe in branches); gx / gy = dp / dscreen
        vec4 nTexG(vec2 p, vec2 gx, vec2 gy) { return textureGrad(uNoise, p * 0.125, gx * 0.125, gy * 0.125); }
        vec3 tDx, tDy; // dFdx / dFdy of the world position (taken outside every branch)
        float fbm3(vec2 p) { return nTex(p).r; }
        float fbmB(vec2 p) { return nTex(p).a; }
        vec2 ngrad(vec2 p) { return (nTex(p).gb - 0.5) * 6.0; }
        // triplanar sampling: steep cliffs get texture from the side instead of a smeared top-down projection
        vec3 triW(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
        float triFbm(vec3 p, vec3 w, float s) { return fbm3(p.zy * s) * w.x + fbm3(p.xz * s) * w.y + fbm3(p.xy * s) * w.z; }
        float triFbmB(vec3 p, vec3 w, float s) { return fbmB(p.zy * s) * w.x + fbmB(p.xz * s) * w.y + fbmB(p.xy * s) * w.z; }
        vec4 triTex(vec3 p, vec3 w, float s) { return nTex(p.zy * s) * w.x + nTex(p.xz * s) * w.y + nTex(p.xy * s) * w.z; }
        vec3 triGrad(vec3 p, vec3 w, float s) {
          vec2 gx = ngrad(p.zy * s), gy = ngrad(p.xz * s), gz = ngrad(p.xy * s);
          return vec3(0.0, -gx.y, -gx.x) * w.x + vec3(-gy.x, 0.0, -gy.y) * w.y + vec3(-gz.x, -gz.y, 0.0) * w.z;
        }
        // the same at an explicit mip level (safe inside branches)
        vec2 ngradL(vec2 p, float lod) { return (textureLod(uNoise, p * 0.125, lod).gb - 0.5) * 6.0; }
        vec3 triGradL(vec3 p, vec3 w, float s, float lod) {
          vec2 gx = ngradL(p.zy * s, lod), gy = ngradL(p.xz * s, lod), gz = ngradL(p.xy * s, lod);
          return vec3(0.0, -gx.y, -gx.x) * w.x + vec3(-gy.x, 0.0, -gy.y) * w.y + vec3(-gz.x, -gz.y, 0.0) * w.z;
        }
        // One ice facet per cell (p in cells, px = cells per pixel): it only lights up when it mirrors the light into
        // the eye, drawn as a small round point at least ~1 px wide, and dropped once cells get smaller than ~3 px.
        // (Derivatives are taken by the caller, outside any branch.)
        float glint(vec2 p, float px, vec3 n, vec3 H) {
          if (px > 0.7) return 0.0; // cells under ~1.5 px are faded out anyway: skip the hashes
          ivec2 c = ivec2(floor(p));
          float h1 = tHash(c), h2 = tHash(c + ivec2(7, 113)), h3 = tHash(c + ivec2(151, 29)), h4 = tHash(c + ivec2(37, 211));
          vec3 facet = normalize(n + vec3(h1 - 0.5, 0.0, h2 - 0.5) * 1.0);
          float align = pow(max(dot(facet, H), 0.0), 700.0);
          float r = max(0.1, 0.75 * px);
          float pt = 1.0 - smoothstep(r * 0.4, r, length(fract(p) - 0.2 - 0.6 * vec2(h3, h4)));
          return align * pt * (0.12 + 2.4 * h3 * h3 * h4) * (1.0 - smoothstep(0.35, 0.7, px));
        }
        float tRock; float tGroomed; float tDist; vec3 tTriW; float tFw; vec3 tRockN;
        vec2 tRelG; float tRelV; float tRelK; float tRelA; // wind-sculpted snow relief at the pixel's scale (gradient, height, strength, grain)
        float tCav; // rock cavities / crevices (0) .. proud faces (1): the sky light reaches less into them
        vec3 tPN; // world-space shading normal (normal_fragment_maps)
        // floodlit pools (night skiing); the terrain lights itself, so it skips the lit-materials patch
        #define PL_SKIP_OBJECTS
        uniform vec4 uPLPos[${PL_MAX}];
        uniform vec4 uPLAim[${PL_MAX}];
        uniform vec4 uPLParams;
        uniform vec4 uPLShape;
        uniform vec3 uPLColor;
        uniform sampler2D uPLMap;
        uniform vec4 uPLMapRect;
        uniform float uPLMapK;
        ${PL_BEAM_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          tDist = length(vWPos - cameraPosition);
          tDx = dFdx(vWPos); tDy = dFdy(vWPos);
          tFw = length(abs(tDx) + abs(tDy)); // metres per pixel (derivatives stay outside branches)
          vec3 wn = normalize(vWNormal);
          float slope = 1.0 - clamp(wn.y, 0.0, 1.0);
          float n1 = fbm3(vWPos.xz * 0.045);
          float n2 = fbmB(vWPos.xz * 0.006 + 7.0);
          tTriW = triW(wn);
          // steep faces: the rock edge's noise from the face's own (side) projections, blended like the triplanar
          // maps (projected from above it stretched into long vertical stripes down the cliffs). Explicit
          // gradients: safe in the branch, and only steep pixels pay the two extra fetches
          if (slope > 0.4) {
            float sx = nTexG(vWPos.zy * 0.045, tDx.zy * 0.045, tDy.zy * 0.045).r, sz = nTexG(vWPos.xy * 0.045, tDx.xy * 0.045, tDy.xy * 0.045).r;
            n1 = mix(n1, n1 * tTriW.y + sx * tTriW.x + sz * tTriW.z, smoothstep(0.4, 0.55, slope));
          }
          // couloirs: broad snow gullies down the steep faces (side projections, so they follow the fall line)
          vec2 sw = abs(wn.xz) + 1e-3;
          sw /= sw.x + sw.y;
          // rock on steep faces. Distant LODs are smoother, so rock shows a bit earlier there; couloirs hold snow
          // on steeper ground.
          float farK = smoothstep(400.0, 6000.0, tDist);
          // cliff zones (steep on the large scale): rock shows earlier
          float cliff = smoothstep(0.24, 0.38, vMacro);
          float rockT = 0.28 - farK * 0.1 + (n2 - 0.5) * 0.16 + uSnowCover * 0.05 - cliff * 0.07;
          float edgeW = 0.05 + 0.12 * smoothstep(800.0, 4000.0, tDist); // softer where the mesh gets coarse
          // far away the coarse mesh aliases the cliff bands' ledges: judge those by the large-scale slope (the
          // layered look comes from the rock strata and the snow on its relief instead)
          float slopeR = max(slope, vMacro * smoothstep(900.0, 2200.0, tDist));
          // ledges of the stacked cliff bands (locally much flatter than the slope around them): their snow is broken
          // into irregular stretches of different length on every band, so the bands never read as regular stripes
          float bench = smoothstep(0.05, 0.14, vMacro - slope) * smoothstep(0.08, 0.14, vMacro);
          // The couloirs (side projections, so they follow the fall line) and the rock edge's fine noise only
          // matter near rock: most snow (pistes, gentle slopes) can't turn to rock whatever they say (the noise
          // terms below add at most 0.08 and the couloirs only raise the threshold), so it skips their 3 fetches.
          float streak = 0.0, edgeN = 0.5;
          if (slopeR + 0.085 > rockT || bench > 0.001) {
            const vec2 kS = vec2(0.028, 0.0075);
            streak = nTexG(vWPos.zy * kS, tDx.zy * kS, tDy.zy * kS).r * sw.x + nTexG(vWPos.xy * kS + vec2(3.7, 1.3), tDx.xy * kS, tDy.xy * kS).r * sw.y;
            edgeN = nTexG(vWPos.xz * 0.23, tDx.xz * 0.23, tDy.xz * 0.23).r;
            if (slope > 0.4) { // (the same on steep faces: side projections)
              float ex = nTexG(vWPos.zy * 0.23, tDx.zy * 0.23, tDy.zy * 0.23).r, ez = nTexG(vWPos.xy * 0.23, tDx.xy * 0.23, tDy.xy * 0.23).r;
              edgeN = mix(edgeN, edgeN * tTriW.y + ex * tTriW.x + ez * tTriW.z, smoothstep(0.4, 0.55, slope));
            }
          }
          // couloirs only on moderately steep ground: on very steep faces their fall-line stretch read as a brush
          // smear, so there they ease to a neutral value (0.45: no couloir snow, no water streak, no gully break)
          streak = mix(0.45, streak, 1.0 - smoothstep(0.45, 0.6, slope) * step(0.001, streak));
          rockT += smoothstep(0.62, 0.78, streak) * 0.1;
          tRock = smoothstep(rockT, rockT + edgeW, slopeR + (n1 - 0.5) * 0.1 + (edgeN - 0.5) * 0.06);
          // (only the bands' ledges need the break-up noise: most pixels skip its fetch)
          float dash = 1.0;
          if (bench > 0.001) dash = smoothstep(0.5, 0.6, nTexL(vec2(vWPos.x + vWPos.y * 0.7, vWPos.z - vWPos.y * 0.4) * 0.045, max(log2(32.0 * 0.045 * max(tFw, 1e-3)), 0.0)).a);
          tRock = max(tRock, bench * (1.0 - dash) * 0.92 * (1.0 - smoothstep(0.64, 0.8, streak)) * (1.0 - uSnowCover * 0.5));
          // snow-filled gullies run down the fall line through the cliff bands (the logo's streaked faces), so
          // the bands never read as stacked stripes
          tRock *= 1.0 - smoothstep(0.6, 0.72, streak) * cliff * 0.85;
          tGroomed = vData.y;
          tRock *= 1.0 - tGroomed; // pistes and pads are always snow-covered
          // Snow relief that holds up at every distance: two octaves of wind-drift noise picked by the pixel
          // footprint (features ~25-50 px across) and cross-faded, stretched across the prevailing wind. Each
          // octave is shaped like a drift (a gentle windward slope up to a sharp crest, a steep lee side) and the
          // relief calms as its features grow: bumps and wind lips close up, sculpted drifts further out, soft
          // swells on the far slopes, instead of flat white planes at every distance.
          tRelG = vec2(0.0); tRelV = 0.5; tRelK = 0.0; tRelA = 0.5;
          // (steep faces: the drifts below are projected from above and smeared into streaks down the face, and
          // wind drifts don't hold on such faces anyway: the relief calms out there, and the steepest skip it)
          float flatK = 1.0 - smoothstep(0.45, 0.62, slope);
          if (tRock < 0.98 && flatK > 0.0) { // (bare rock has its own relief: skip the fetches there)
            float lvl = clamp(log2(max(tFw, 1e-3) * 12.0), -1.0, 10.0);
            float l0 = floor(lvl), lf = lvl - l0;
            float e0 = exp2(-l0), f0 = 0.5 * e0;
            vec2 q = (mat2(0.8, 0.6, -0.6, 0.8) * vWPos.xz) * vec2(1.0, 1.8);
            // (explicit gradients: anisotropic filtering keeps the relief crisp on slopes seen at a grazing angle)
            mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
            vec2 qx = (R * tDx.xz) * vec2(1.0, 1.8), qy = (R * tDy.xz) * vec2(1.0, 1.8);
            // each level has its own offset, the same whichever pair it is fetched in: the cross-fade runs on
            // seamlessly from one pair of levels to the next (no ring where the pixel footprint doubles)
            vec2 o0 = fract(vec2(0.618, 0.382) * l0) * 8.0, o1 = fract(vec2(0.618, 0.382) * (l0 + 1.0)) * 8.0;
            // the two levels cross-fade over the middle 30 % of each octave: outside it only one is fetched
            // (neighbouring pixels share the footprint, so whole pixel groups skip the other fetch)
            lf = smoothstep(0.35, 0.65, lf);
            vec4 r0 = vec4(0.5), r1 = vec4(0.5);
            if (lf < 0.999) r0 = nTexG(q * f0 + o0, qx * f0, qy * f0);
            if (lf > 0.001) r1 = nTexG(q * (f0 * 0.5) + o1, qx * (f0 * 0.5), qy * (f0 * 0.5));
            // drift profile h = 0.4 R + 0.5 (1 - |2R - 1|): its slope is (0.4 -+ 1) x the noise's slope. The crest is
            // softened over about a pixel: the noise's change per pixel from its gradient and the screen gradients
            // of q (no implicit derivatives in this branch)
            vec2 g0 = (r0.gb - 0.5) * 6.0 * f0, g1 = (r1.gb - 0.5) * 3.0 * f0;
            float w0 = max(abs(dot(g0, qx)) + abs(dot(g0, qy)), 0.012), w1 = max(abs(dot(g1, qx)) + abs(dot(g1, qy)), 0.012);
            float k0 = 0.4 - clamp((r0.r - 0.5) / w0, -1.0, 1.0);
            float k1 = 0.4 - clamp((r1.r - 0.5) / w1, -1.0, 1.0);
            float a0 = exp2(-0.3 * (l0 + 1.0)), a1 = a0 * 0.812; // calmer as the features grow (x 2^-0.3 per octave)
            vec2 gr = ((r0.gb - 0.5) * (k0 * a0 * (1.0 - lf)) + (r1.gb - 0.5) * (k1 * a1 * lf)) * 6.0 * vec2(1.0, 1.8);
            tRelG = gr * mat2(0.8, 0.6, -0.6, 0.8);       // back to world x / z
            float h0 = 0.4 * r0.r + 0.5 * (1.0 - abs(2.0 * r0.r - 1.0)), h1 = 0.4 * r1.r + 0.5 * (1.0 - abs(2.0 * r1.r - 1.0));
            tRelV = mix(h0, h1, lf) * 1.1;                  // ~0 hollow .. ~1 crest
            tRelK = mix(a0, a1, lf);                        // 1 for the smallest features, less for big swells
            tRelA = mix(r0.a, r1.a, lf);                    // an independent noise at the same scale (surface grain)
            tRelG *= flatK; tRelK *= flatK; tRelV = mix(0.5, tRelV, flatK); tRelA = mix(0.5, tRelA, flatK);
          }
          // snow: crisp, faintly warm white with soft wind-packed variation (its blue comes from the sky light)
          // (a touch below fresh-powder white, so sunlit snow sits below the tone curve's shoulder and its relief reads)
          vec3 snow = vec3(0.83, 0.86, 0.9) * (0.955 + 0.045 * n1);
          // wind-packed crust in the hollows, brighter fresh snow on the crests, and a soft grain at the same scale:
          // in frontal sun, where no relief casts a shade, the snow still has a surface
          vec3 relA = mix(vec3(0.87, 0.925, 1.0), vec3(1.03), smoothstep(0.2, 0.8, tRelV));
          snow *= mix(vec3(1.0), relA, (0.45 + 0.55 * tRelK) * (1.0 - uSnowCover * 0.6));
          snow *= 0.955 + 0.09 * smoothstep(0.25, 0.75, tRelA);
          snow = mix(snow, vec3(0.85, 0.895, 0.955), smoothstep(0.55, 0.8, n2) * 0.35);
          snow = mix(snow, vec3(0.86, 0.89, 0.93), tGroomed * 0.45);
          vec3 alb = snow;
          tRockN = vec3(0.0);
          tCav = 1.0;
          if (tRock > 0.002) {
            // rock relief (it also lights the rock, see normal_fragment_maps): large buttresses that catch the light
            // from far away, then blocky facets
            // (detail that is sub-pixel at this distance is skipped, not just faded: these branches follow the
            // distance, so whole pixel groups skip them; their weights are ~0 at the cut)
            float buttress = 1.0 - smoothstep(1500.0, 5000.0, tDist), facets = 1.0 - smoothstep(200.0, 1500.0, tDist);
            if (buttress > 0.0) tRockN = triGrad(vWPos, tTriW, 0.028) * 0.4 * buttress;
            if (facets > 0.0) tRockN += triGrad(vWPos, tTriW, 0.12) * 0.6 * facets;
            vec4 faceN = triTex(vWPos, tTriW, 0.03); // r: broad faces, a: the snow patches (one set of fetches)
            float faces = faceN.r;
            float grain = 0.5;
            if (tDist < 900.0) grain = mix(triFbmB(vWPos, tTriW, 0.22), 0.5, smoothstep(500.0, 900.0, tDist));
            // strata: layers of irregular thickness following the altitude, warped so they never line up
            float sy = vWPos.y * 0.085 + (fbm3(vWPos.xz * 0.0035) - 0.5) * 10.0 + (faces - 0.5) * 1.6;
            float strata = fbmB(vec2(sy * 0.5, 0.37));
            float closeR = 1.0 - smoothstep(25.0, 90.0, tDist);
            float cracks = 0.0;
            #if TERRAIN_DETAIL >= 1
            if (closeR > 0.0) cracks = (1.0 - smoothstep(0.0, 0.035 + tFw * 0.25, abs(triFbm(vWPos, tTriW, 0.55) - 0.5))) * closeR;
            #endif
            // dark slate-blue rock: broad light/dark faces, layered bands, fine grain, cracks, darker water streaks
            vec3 rock = mix(vec3(0.016, 0.021, 0.033), vec3(0.064, 0.075, 0.102), smoothstep(0.34, 0.66, faces * 0.65 + strata * 0.35));
            rock *= (0.66 + 0.68 * grain) * (0.68 + 0.64 * smoothstep(0.32, 0.68, strata));
            tCav = smoothstep(0.25, 0.75, grain * 0.6 + faces * 0.4);
            rock *= 1.0 - cracks * 0.55;
            rock *= 1.0 - 0.25 * (1.0 - smoothstep(0.2, 0.36, streak));
            // snow caught on the rock wherever its relief faces the sky, so it sits on the same ledges, ribs and
            // shelves that catch the light (the mottled faces of the logo), plus soft patches on the less steep parts
            float upR = normalize(wn + tRockN).y;
            float onRelief = smoothstep(0.6, 0.78, upR + (grain - 0.5) * 0.12) * (1.0 - smoothstep(0.8, 0.97, slope));
            float patches = smoothstep(0.52, 0.72, faceN.a) * (1.0 - smoothstep(0.42, 0.78, slope)) * (1.0 - cliff * 0.6);
            // steep faces: snow caught on small ledges and in cracks, broken horizontal bands and flecks running
            // along the face (projected on the face itself), so cliffs read as crisp snow-dusted rock up close and
            // in the middle distance instead of smooth dark slabs
            float steepF = smoothstep(0.42, 0.7, slope) * (1.0 - smoothstep(220.0, 420.0, tDist));
            if (steepF > 0.0) {
              // (projected on the two vertical planes and blended like the triplanar maps: a coordinate taken
              // along the face itself follows the mesh's smoothed normals and smeared into streaks)
              float wx = smoothstep(0.32, 0.68, tTriW.x / max(tTriW.x + tTriW.z, 1e-3));
              vec2 pz = vec2(vWPos.x, vWPos.y), px = vec2(vWPos.z, vWPos.y);
              const vec2 kL = vec2(0.09, 0.5);
              // (faces turned mostly one way read only their own projection)
              vec4 lz = vec4(0.0), lx = vec4(0.0);
              if (wx < 0.999) lz = nTexG(pz * kL + 5.3, tDx.xy * kL, tDy.xy * kL);
              if (wx > 0.001) lx = nTexG(px * kL + 5.3, tDx.zy * kL, tDy.zy * kL);
              float ledge = mix(lz.r, lx.r, wx), flecks = mix(lz.a, lx.a, wx);
              float fresh = uSnowCover * 0.08; // fresh snow sticks to more of the face
              // crisp edges about a pixel wide, so they never alias (the noises' change per pixel from the
              // footprint: no derivatives inside this branch)
              float wl = tFw * 0.3 + 0.008, wf = tFw * 0.36 + 0.008;
              float stuck = max(smoothstep(0.63 - fresh - wl, 0.63 - fresh + wl, ledge), smoothstep(0.73 - fresh - wf, 0.73 - fresh + wf, flecks) * 0.75) * smoothstep(0.3, 0.6, grain + 0.1);
              patches = max(patches, stuck * steepF);
            }
            alb = mix(snow, rock, tRock * (1.0 - max(patches, onRelief) * 0.88));
          }
          // far faces: a few km out the rock's own detail is sub-pixel and steep faces would read as flat dark slabs.
          // Large buttresses and gullies (~125 m) shade them instead (added to the rock normal) and hold snow on their
          // sky-facing parts, dark rock on the ribs: the streaked big-mountain look of the logo and of the backdrop
          // peaks. Explicit mip level: no implicit derivatives inside the branch.
          float farF = smoothstep(1300.0, 3800.0, tDist) * tRock;
          if (farF > 0.001) {
            float lod = log2(max(tFw * 0.008 * 32.0, 1e-3));
            vec3 farN = triGradL(vWPos, tTriW, 0.008, lod) * 0.6 + triGradL(vWPos + 41.0, tTriW, 0.021, lod + 1.4) * 0.25;
            tRockN += farN * farF;
            float upF = normalize(wn + farN).y;
            float farSnow = smoothstep(0.5, 0.68, upF) * (1.0 - smoothstep(0.62, 0.9, slope));
            alb = mix(alb, snow, farF * farSnow);
          }
          // distant forests: dark navy conifer tint fading in where the real trees become impostors
          float forestFar = vData.x * smoothstep(160.0, 420.0, tDist);
          if (forestFar > 0.001) { // (most pixels have no forest: they skip the fetch)
            vec3 forestCol = mix(vec3(0.022, 0.040, 0.052), vec3(0.50, 0.56, 0.63), smoothstep(0.4, 0.9, nTexL(vWPos.xz * 0.12, max(log2(32.0 * 0.12 * max(tFw, 1e-3)), 0.0)).r));
            alb = mix(alb, forestCol, forestFar * 0.85);
          }
          diffuseColor.rgb = alb;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.58, 0.92, tRock);
        roughnessFactor = mix(roughnessFactor, 0.72, tGroomed);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // world-space detail normals: drifts, sastrugi, snow grain, corduroy on pistes
          vec3 wn = normalize(vWNormal);
          float fade = 1.0 - smoothstep(30.0, 140.0, tDist);
          float fadeMid = 1.0 - smoothstep(60.0, 320.0, tDist);
          float fadeFar = 1.0 - smoothstep(200.0, 1500.0, tDist);
          float onSnow = 1.0 - tRock;
          vec2 g = vec2(0.0);
          // wind-sculpted relief (color_fragment): calmer on groomed pistes and under fresh snow
          g = tRelG * 0.42 * onSnow * (1.0 - 0.72 * tGroomed) * (1.0 - 0.35 * uSnowCover);
          // (the old fixed 12 m drift layer is part of the adaptive relief now)
          // sastrugi: wind-carved ridges stretched along the prevailing wind, crisp in low sun
          #if TERRAIN_DETAIL >= 1
          if (fadeMid * onSnow > 0.0) {
            vec2 sq = ngrad((mat2(0.8, 0.6, -0.6, 0.8) * vWPos.xz) * vec2(0.04, 0.22)) * vec2(0.04, 0.22);
            g += (sq * mat2(0.8, 0.6, -0.6, 0.8)) * 0.4 * fadeMid * onSnow * (1.0 - tGroomed);
          }
          if (fade * onSnow > 0.0) g += ngrad(vWPos.xz * 3.5) * 0.04 * fade * onSnow;  // grain
          #endif
          #if TERRAIN_DETAIL >= 2
            // cinematic: wind-packed micro relief a few metres around the skier (band-limited, never moire)
            {
              vec2 mp = vWPos.xz * 11.0;
              float mfw = length(fwidth(mp));
              float micro = (1.0 - smoothstep(6.0, 26.0, tDist)) * (1.0 - smoothstep(0.35, 0.8, mfw)) * onSnow;
              if (micro > 0.0) g += (ngrad(mp) * 0.6 + ngrad(mp * 2.7 + 3.1) * 0.4) * 0.03 * micro * (1.0 - 0.6 * tGroomed);
            }
          #endif
          vec2 pd = normalize(vData.zw + 1e-4);
          float across = dot(vWPos.xz, vec2(-pd.y, pd.x));
          float cord = cos(across * 6.2831 / 0.12);
          // band-limit: fade the ridges out before they get smaller than ~3 pixels (no moire)
          float fw = fwidth(across) / 0.12;
          float cordFade = (1.0 - smoothstep(0.12, 0.3, fw)) * (1.0 - smoothstep(3.0, 14.0, tDist)) * tGroomed;
          g += vec2(-pd.y, pd.x) * cord * 0.09 * cordFade;
          // rock relief (from color_fragment) + sharp close-range detail, triplanar so cliffs aren't smeared
          vec3 rockN = tRockN;
          #if TERRAIN_DETAIL >= 1
          if (tRock > 0.002 && tDist < 120.0) rockN += triGrad(vWPos, tTriW, 0.6) * 0.3 * (1.0 - smoothstep(30.0, 120.0, tDist));
          #endif
          vec3 pn = normalize(wn + vec3(-g.x, 0.0, -g.y) + rockN * tRock);
          tPN = pn;
          normal = normalize((viewMatrix * vec4(pn, 0.0)).xyz);
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // Cold sky light, like the logo art: snow and rock turned away from the sun read a clear, saturated blue
          // (darker than the sky dome, so sunlit and shaded faces split crisply) while snow facing the sun stays a
          // crisp white. Strongest in clear sun, almost neutral under an overcast sky.
          float sunK = 0.0;
          #if NUM_DIR_LIGHTS > 0
            sunK = smoothstep(0.4, 2.8, dot(directionalLights[0].color, vec3(0.3333)));
          #endif
          reflectedLight.indirectDiffuse *= mix(vec3(0.9, 0.96, 1.05), vec3(0.66, 0.8, 0.98), sunK);
          // rock crevices see less of the sky than the faces between them, and facets turned up to the sky
          // more than those turned down: depth and relief in the shaded walls (they read as smooth slabs)
          // (tilt = how far the relief turns a facet up or down from the face around it: on a shaded cliff that is
          // what shows its buttresses and ledges)
          float tTilt = tPN.y - normalize(vWNormal).y;
          reflectedLight.indirectDiffuse *= mix(1.0, (0.5 + 0.65 * tCav) * clamp(0.72 + 0.4 * tPN.y + 1.4 * tTilt, 0.32, 1.3), tRock);
          // hollows of the wind-sculpted relief see less of the sky than its crests: the shaded snow keeps
          // its texture instead of reading as one flat blue
          reflectedLight.indirectDiffuse *= mix(1.0, mix(0.7, 1.06, smoothstep(0.15, 0.85, tRelV)), (1.0 - tRock) * (0.35 + 0.65 * tRelK));
          // snow keeps only a little specular sheen: looking toward the sun (the logo's backlit view) a broad sheen
          // washed the blue shaded snow out to grey; the glints below add the sparkle back
          float tSnowK = 1.0 - tRock;
          // ...and, as in the art, sunlight grazing the snow turns sky-blue: only snow squarely facing the sun stays
          // white, so the mid-tones read cyan-blue instead of a lavender grey
          #if NUM_DIR_LIGHTS > 0
            float tNdl = saturate(dot(normal, directionalLights[0].direction));
            vec3 tCool = mix(vec3(0.5, 0.82, 1.18), vec3(1.0), smoothstep(0.15, 1.0, tNdl));
            reflectedLight.directDiffuse *= mix(vec3(1.0), tCool, sunK * tSnowK);
          #endif
          reflectedLight.directSpecular *= 1.0 - 0.65 * tSnowK;
          reflectedLight.indirectSpecular *= 1.0 - 0.45 * tSnowK;
          // glints: sparse sun-facing ice facets, a few bright enough to bloom
          #if NUM_DIR_LIGHTS > 0
            vec2 gp1 = vWPos.xz * 16.0, gp2 = vWPos.xz * 4.5 + 0.5;
            float px1 = max(fwidth(gp1.x), fwidth(gp1.y)), px2 = max(fwidth(gp2.x), fwidth(gp2.y));
            #if TERRAIN_DETAIL >= 2
              vec2 gp3 = vWPos.xz * 34.0 + 0.25;
              float px3 = max(fwidth(gp3.x), fwidth(gp3.y));
            #endif
            float sFade = (1.0 - tRock) * uSparkle * (1.0 - smoothstep(70.0, 120.0, tDist));
            if (sFade > 0.0) {
              vec3 gn = normalize(vWNormal);
              vec3 Vw = normalize(cameraPosition - vWPos);
              vec3 Lw = normalize((vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz);
              vec3 H = normalize(Lw + Vw);
              #if TERRAIN_DETAIL >= 1
                float spark = glint(gp1, px1, gn, H) + glint(gp2, px2, gn, H) * 0.8;
              #else
                float spark = glint(gp2, px2, gn, H) * 1.3;
              #endif
              #if TERRAIN_DETAIL >= 2
                // cinematic: fine, strongly tilted ice facets that catch the sun when the snow is seen at a grazing
                // angle (looking down the slope toward the light), close to the camera only
                float graze = 1.0 - clamp(dot(gn, Vw), 0.0, 1.0);
                if (tDist < 28.0 && graze > 0.35) {
                  vec3 gt = normalize(gn + vec3(tHash(ivec2(floor(gp3)) + ivec2(91, 7)) - 0.5, 0.0, tHash(ivec2(floor(gp3)) + ivec2(13, 57)) - 0.5) * 1.6);
                  spark += glint(gp3, px3, gt, H) * 0.9 * smoothstep(0.35, 0.85, graze) * (1.0 - smoothstep(16.0, 28.0, tDist));
                }
              #endif
              vec3 sunLit = reflectedLight.directDiffuse / max(diffuseColor.rgb, vec3(0.05));
              reflectedLight.directSpecular += spark * sFade * 10.0 * sunLit;
            }
          #endif
          // night skiing: warm pools under the floodlight masts. The nearest masts light every pixel (beam,
          // inverse-square falloff, the snow's own relief, a soft sheen, lamp-lit ice glints); further out the
          // baked pool map keeps the lit runs glowing all the way down the mountain.
          if (uPLParams.x > 0.0) {
            float plNear = 1.0 - smoothstep(uPLParams.z - uPLParams.w, uPLParams.z, tDist);
            float plE = 0.0, plMax = 0.0;
            vec3 plL = vec3(0.0, 1.0, 0.0);
            vec3 plV = normalize(cameraPosition - vWPos);
            if (plNear > 0.0) {
              for (int i = 0; i < ${PL_MAX}; i++) {
                if (float(i) >= uPLParams.y) break;
                vec4 lp = uPLPos[i];
                vec3 l = vWPos - lp.xyz;
                float d2 = dot(l, l);
                if (d2 > ${(PL_RANGE * PL_RANGE).toFixed(1)}) continue;
                vec3 ld = l * inversesqrt(d2);
                float ndl = -dot(tPN, ld);
                if (ndl <= 0.0) continue;
                vec4 la = uPLAim[i];
                float win = clamp(1.0 - d2 * d2 * (la.w > 0.0 ? la.w : ${(1 / PL_RANGE ** 4).toExponential(4)}), 0.0, 1.0);
                float e = lp.w * (plBeam(ld, la.xyz, uPLShape) + uPLShape.w) * win * win / max(d2, 16.0) * ndl;
                plE += e;
                if (e > plMax) { plMax = e; plL = -ld; }
              }
            }
            float plM = texture2D(uPLMap, (vWPos.xz - uPLMapRect.xy) * uPLMapRect.zw).r;
            float plIrr = mix(plM * plM * uPLMapK, plE, plNear);
            // the eye adapts to the floodlight: in a lit pool the (strong, blue) moonlight and sky light fall back,
            // so the pool reads warm white while the snow beyond it stays moonlit blue
            float plDom = 0.85 * smoothstep(0.0, 1.0, plIrr / (plIrr + 0.35));
            reflectedLight.indirectDiffuse *= 1.0 - plDom;
            reflectedLight.directDiffuse *= 1.0 - plDom;
            reflectedLight.directDiffuse += uPLColor * plIrr * BRDF_Lambert(diffuseColor.rgb);
            // groomed snow keeps a soft sheen toward the brightest lamp, rock hardly any
            float plS = plMax * pow(max(dot(tPN, normalize(plV + plL)), 0.0), 24.0);
            reflectedLight.directSpecular += uPLColor * plS * plNear * (0.06 + 0.06 * tGroomed) * (1.0 - 0.7 * tRock);
            #if NUM_DIR_LIGHTS > 0
              float plG = (1.0 - tRock) * plNear * (1.0 - smoothstep(60.0, 110.0, tDist));
              if (plG > 0.0 && plMax > 0.0) {
                vec3 plH = normalize(plL + plV), plGn = normalize(vWNormal);
                float plSpark = glint(gp1, px1, plGn, plH) + glint(gp2, px2, plGn, plH) * 0.8;
                reflectedLight.directSpecular += uPLColor * plSpark * plG * plMax * RECIPROCAL_PI * 6.0;
              }
            #endif
          }
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>
        #ifdef TERRAIN_CLIP
        ${TCLIP_GLSL}
        #endif`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        #ifdef TERRAIN_CLIP
          if (tClipped(vWPos)) discard;
        #endif`);
  };
  return mat;
}

class TNode {
  constructor(x, z, size) { this.x = x; this.z = z; this.size = size; this.key = `${x},${z},${size}`; }
}

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.material = createTerrainMaterial();
    this.active = new Map(); // key -> { mesh, node }
    this.queue = [];
    this.desired = new Map();
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.indexCache = null;
    this.lastCenter = new THREE.Vector2(1e9, 1e9);
    this.tmpC = { d: 1e9 };
    this.clipMaterial = null; // the clipping variant (setTerrainClips), made with the first node that needs it
    CLIP.terrains.add(this);
    // graphics preset switched while playing: new LOD split, shadow casters and shader detail
    onQualityChange((q) => {
      this.lastCenter.set(1e9, 1e9);
      for (const a of this.active.values()) a.mesh.castShadow = a.node.size <= q.shadow.terrainCast;
      for (const m of [this.material, this.clipMaterial]) {
        if (m && m.defines.TERRAIN_DETAIL !== q.terrain.detail) {
          m.defines.TERRAIN_DETAIL = q.terrain.detail;
          m.needsUpdate = true;
        }
      }
    });
  }

  // the clipping variant on the nodes that touch a clip volume (fine nodes only: from further away a portal's mouth
  // or a gallery's window is a few pixels)
  applyClip(mesh, n) {
    const hit = n.size <= 512 && CLIP.boxes.some((b) => b.x0 < n.x + n.size && b.x1 > n.x && b.z0 < n.z + n.size && b.z1 > n.z);
    if (hit) {
      if (!this.clipMaterial) {
        this.clipMaterial = createTerrainMaterial({ clip: true });
        this.clipDepth = clipDepthMaterial();
      }
      mesh.material = this.clipMaterial;
      mesh.customDepthMaterial = this.clipDepth;
    } else if (mesh.material !== this.material) {
      mesh.material = this.material;
      mesh.customDepthMaterial = undefined;
    }
  }

  buildIndex() {
    if (this.indexCache) return this.indexCache;
    const V = SEG + 1;
    const idx = [];
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    // skirt: ring vertices appended after the grid, in border order
    const ring = [];
    for (let i = 0; i < SEG; i++) ring.push(i); // top edge (j=0)
    for (let j = 0; j < SEG; j++) ring.push(j * V + SEG); // right edge
    for (let i = SEG; i > 0; i--) ring.push(SEG * V + i); // bottom
    for (let j = SEG; j > 0; j--) ring.push(j * V); // left
    const base = V * V;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const sa = base + k, sb = base + ((k + 1) % ring.length);
      idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb); // both windings: skirts face either way
    }
    this.ring = ring;
    this.indexCache = new THREE.BufferAttribute(new Uint32Array(idx), 1);
    return this.indexCache;
  }

  buildNode(node) {
    const { x: x0, z: z0, size } = node;
    world.ensureFeatures(x0, z0, x0 + size, z0 + size);
    const V = SEG + 1, st = size / SEG;
    const H = new Float32Array((V + 2) * (V + 2));
    for (let j = -1; j <= V; j++) for (let i = -1; i <= V; i++) {
      H[(j + 1) * (V + 2) + (i + 1)] = world.height(x0 + i * st, z0 + j * st, st > 3 ? st : 0);
    }
    // Macro slope: the terrain's slope without the crags' cliff bands and small bumps (sampled 40 m band-limited,
    // which drops them), on a coarse grid every MS vertices. The shader uses it to tell cliff zones from open
    // slopes, so ledge snow there can break up instead of drawing regular stripes.
    const MS = 4, MV = SEG / MS + 1, mst = st * MS, mw = MV + 2;
    const M = new Float32Array(mw * mw);
    for (let j = -1; j <= MV; j++) for (let i = -1; i <= MV; i++) {
      M[(j + 1) * mw + (i + 1)] = world.height(x0 + i * mst, z0 + j * mst, Math.max(40, mst));
    }
    const macro = new Float32Array(MV * MV);
    for (let j = 0; j < MV; j++) for (let i = 0; i < MV; i++) {
      const mx = M[(j + 1) * mw + i] - M[(j + 1) * mw + i + 2], mz = M[j * mw + i + 1] - M[(j + 2) * mw + i + 1];
      macro[j * MV + i] = 1 - (2 * mst) / Math.hypot(mx, 2 * mst, mz);
    }
    const index = this.buildIndex();
    const ringLen = this.ring.length;
    const count = V * V + ringLen;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const dat = new Float32Array(count * 4);
    const mac = new Float32Array(count);
    const near = size <= 512;
    const c = this.tmpC;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const k = j * V + i;
      {
        const fi = i / MS, fj = j / MS;
        const i0 = Math.min(MV - 2, Math.floor(fi)), j0 = Math.min(MV - 2, Math.floor(fj)), ti = fi - i0, tj = fj - j0;
        const a = macro[j0 * MV + i0], b = macro[j0 * MV + i0 + 1], cc = macro[(j0 + 1) * MV + i0], dd = macro[(j0 + 1) * MV + i0 + 1];
        mac[k] = (a + (b - a) * ti) * (1 - tj) + (cc + (dd - cc) * ti) * tj;
      }
      const h = H[(j + 1) * (V + 2) + (i + 1)];
      const hl = H[(j + 1) * (V + 2) + i], hr = H[(j + 1) * (V + 2) + i + 2];
      const hd = H[j * (V + 2) + i + 1], hu = H[(j + 2) * (V + 2) + i + 1];
      let nx = hl - hr, ny = 2 * st, nz = hd - hu;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl; ny /= nl; nz /= nl;
      pos[k * 3] = i * st; pos[k * 3 + 1] = h; pos[k * 3 + 2] = j * st;
      nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
      const wx = x0 + i * st, wz = z0 + j * st;
      dat[k * 4] = world.forest(wx, wz, h, Math.sqrt(1 - ny * ny) / Math.max(ny, 0.05));
      if (near) {
        world.corridorAt(wx, wz, c);
        if (c.groomed) {
          const g = 1 - Math.min(1, Math.max(0, (c.d + 3) / 6));
          dat[k * 4 + 1] = g;
          dat[k * 4] *= 1 - g;
          dat[k * 4 + 2] = c.dx; dat[k * 4 + 3] = c.dz;
        } else if (c.d < 4) dat[k * 4] = 0;
        // pads (stations, huts, race starts) are packed, groomed snow too
        const pad = world.padInfluence(wx, wz);
        if (pad > 0.02 && pad > dat[k * 4 + 1]) {
          dat[k * 4 + 1] = Math.min(1, pad * 1.5);
          dat[k * 4] = 0;
          if (!dat[k * 4 + 2] && !dat[k * 4 + 3]) dat[k * 4 + 2] = 1;
        }
      }
    }
    // skirts hide LOD cracks; generous because coarse LODs drop the crags' cliff bands (up to ~14 m)
    const skirt = Math.max(2, size * 0.02);
    for (let k = 0; k < ringLen; k++) {
      const src = this.ring[k], d = V * V + k;
      pos[d * 3] = pos[src * 3]; pos[d * 3 + 1] = pos[src * 3 + 1] - skirt; pos[d * 3 + 2] = pos[src * 3 + 2];
      nor[d * 3] = nor[src * 3]; nor[d * 3 + 1] = nor[src * 3 + 1]; nor[d * 3 + 2] = nor[src * 3 + 2];
      for (let q = 0; q < 4; q++) dat[d * 4 + q] = dat[src * 4 + q];
      mac[d] = mac[src];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aData', new THREE.BufferAttribute(dat, 4));
    geo.setAttribute('aMacro', new THREE.BufferAttribute(mac, 1));
    geo.setIndex(index);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(x0, 0, z0);
    mesh.receiveShadow = true;
    mesh.castShadow = size <= quality.shadow.terrainCast;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (CLIP.boxes.length) this.applyClip(mesh, node);
    return mesh;
  }

  computeDesired(px, pz) {
    const desired = new Map();
    const rx = Math.floor(px / ROOT_SIZE), rz = Math.floor(pz / ROOT_SIZE), lodK = quality.terrain.lodK;
    const visit = (n) => {
      const cx = n.x + n.size / 2, cz = n.z + n.size / 2;
      const dx = Math.max(Math.abs(px - cx) - n.size / 2, 0), dz = Math.max(Math.abs(pz - cz) - n.size / 2, 0);
      const d = Math.hypot(dx, dz);
      if (n.size > MIN_SIZE && d < n.size * lodK) {
        const h = n.size / 2;
        visit(new TNode(n.x, n.z, h)); visit(new TNode(n.x + h, n.z, h));
        visit(new TNode(n.x, n.z + h, h)); visit(new TNode(n.x + h, n.z + h, h));
      } else {
        n.dist = d;
        desired.set(n.key, n);
      }
    };
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) visit(new TNode((rx + i) * ROOT_SIZE, (rz + j) * ROOT_SIZE, ROOT_SIZE));
    return desired;
  }

  update(px, pz, budgetMs = 6) {
    if (Math.hypot(px - this.lastCenter.x, pz - this.lastCenter.y) > 24) {
      this.lastCenter.set(px, pz);
      this.desired = this.computeDesired(px, pz);
      this.queue = [...this.desired.values()].filter((n) => !this.active.has(n.key)).sort((a, b) => a.dist - b.dist);
    }
    const t0 = performance.now();
    let built = 0;
    while (this.queue.length && (performance.now() - t0 < budgetMs || built === 0)) {
      const n = this.queue.shift();
      if (this.active.has(n.key) || !this.desired.has(n.key)) continue;
      const mesh = this.buildNode(n);
      this.group.add(mesh);
      this.active.set(n.key, { mesh, node: n });
      built++;
    }
    if (built || this.queue.length === 0) this.prune();
    return this.queue.length;
  }

  // Remove meshes no longer desired, but only once their area is covered by built replacements.
  prune() {
    for (const [key, a] of this.active) {
      if (this.desired.has(key)) continue;
      const n = a.node;
      let covered = true;
      for (const d of this.desired.values()) {
        if (this.active.has(d.key)) continue;
        if (d.x < n.x + n.size && d.x + d.size > n.x && d.z < n.z + n.size && d.z + d.size > n.z) { covered = false; break; }
      }
      if (covered) {
        this.group.remove(a.mesh);
        a.mesh.geometry.dispose();
        this.active.delete(key);
      }
    }
  }

  get pending() { return this.queue.length; }
}
