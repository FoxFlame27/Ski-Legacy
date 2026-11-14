// Forests + rocks: full Meshy meshes near the player, camera-facing impostors in the distance.
// Everything shares the logo's look: dark navy / blue-green pines with a dusting of fresh snow and slate-blue
// boulders. The impostors are baked with the very same tint code as the 3D trees and lit with baked normals, so
// near and far trees match in colour and brightness.
import * as THREE from 'three';
import { world } from './world.js';
import { hash2 } from '../core/noise.js';
import { bakeGeometry, fitModel, clusterDecimate } from '../core/assets.js';
import { terrainUniforms, fxLevel } from './terrain.js';
import { quality, onQualityChange } from '../engine/quality.js';
import { rockKit, withGround, ROCKS, ROCK } from './boulders.js';
import { EXPRESS, expressNearest, inExpressTunnel, PORTAL_IN } from './expressroute.js';
import { RAIL, railNearest } from './railroute.js';


const CELL = 64;
const SPACING = 6.5;
// Tree detail levels round the camera (reaches from the graphics preset, quality.veg, see treeTiers):
//   0 the full Meshy trees to closeR, 1 a light decimation (~45 % of the triangles) beyond, 2 a coarser one (~15 %)
//   to nearR, 3 camera-facing impostors (16 baked views) to farR.
// (Nov 1 2026, the user: "even on Ultra the trees ... don't render correctly — it's like some ugly thing before it gets
// rendered": every tree past closeR was one 9 % decimation with clusters 1.3 m wide, each swap was a hard pop, and the
// sets were rebuilt every 14 m round the streaming point, which runs 140 m ahead of the helicopter and up to 900 m ahead
// of the Express, so the trees right by you could be blobs or flat cards.) Now every swap is a screen-door cross-fade
// over a band of 8-28 m keyed to the camera's distance in the shaders, the sets are rebuilt round the camera itself
// (each NEAR_STEP m) and reach NEAR_PAD m past their bands, so no tree is ever missing from the level it should show.
const FAR_R = 1500; // cells within this of you (or farR, if more) are never evicted
const DEC_FINE = 0.032, DEC_COARSE = 0.08; // the cluster cells of levels 1 and 2 (share of the tree's height)
const NEAR_STEP = 4, NEAR_PAD = 8; // 3D levels: rebuilt each NEAR_STEP m the camera moves, built NEAR_PAD m beyond their bands
const FAR_STEP = 30, FAR_PAD = 70; // impostors: rebuilt (time-sliced) each FAR_STEP m, from FAR_PAD m inside nearR
// instances per tree type and level: [solid (no fade: the cheaper shader, early depth test), in a fade band]
const CAPS = [[2500, 1500], [4000, 3000], [9000, 4000]];
const MAX_FAR = 60000;
const MAX_ROCKS = 1500;
const MAX_CLOSE_ROCKS = 160; // rocks within the rocks' close reach use the detailed mesh (rockCloseR), per variant
const ROCK_STEP = 10;
const VILLAGE_CLEAR = 160; // no rocks around Legacy Village (centred on the origin): its paths, gardens and plaza
const BIG_ROCK = 2.6; // collision size from which a rock stops the player (player.js); lower ones are skied over
const LOW_ROCK = 0.55; // m above the snow: rocks lower than this are skied over (their collision size stays under BIG_ROCK)
const BIG_FAR = 4; // rocks this wide and up (crags, outcrops) are drawn out to twice the preset's rock reach
// no boulder on the Legacy Express's formation or at the toes of its cuttings (Oct 30, the user: "so many parts where
// you go through a mountain": the trains ran straight through granite blocks of up to 4.5 m lying on the tracks, ~430
// of them round the ring, most between Eagle Peak and Legacy World Downhill). Over a tunnel the rocks lie on its cover.
const _xn = { d: 1e9, s: 0, side: 0, i: 0 };
function onExpressBed(x, z, size) {
  if (!EXPRESS.ready) return false;
  const n = expressNearest(x, z, _xn);
  return !!n && n.d < 8.5 + size * 0.6 && !inExpressTunnel(n.s, PORTAL_IN + 3);
}
// ... nor on the Wolkenspitzbahn's (its roadbed and the toes of its cuttings; over its tunnels the rocks may lie)
function onRailBed(x, z, size) {
  const n = railNearest(x, z, _xn);
  if (!n || n.d >= 8.5 + size * 0.6) return false;
  for (const t of RAIL.tunnels) if (n.s > t.s0 + 20 && n.s < t.s1 - (t.end ? -1e9 : 20)) return false;
  return true;
}
const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _n = new THREE.Vector3();
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _id = new THREE.Quaternion();
const IMP_W = 256, IMP_H = 512; // one baked view
const IMP_COLS = 4, IMP_ROWS = 4, IMP_N = IMP_COLS * IMP_ROWS; // views round the tree (every 22.5°), in one atlas
const IMP_Y0 = -0.03, IMP_Y1 = 1.03; // the bake's vertical extent (tree heights): a margin so the mips don't bleed
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cellKey = (cx, cz) => cx * 100003 + cz;
// the furthest any tree's or boulder's collision radius reaches from its centre (crown: 0.4 x 26 m at most; rocks ~2 m)
const REACH_MAX = 11;

// Where each level hands over (metres from the camera) and how wide its cross-fade band is, from the preset.
function treeTiers(veg) {
  const r0 = veg.closeR, b0 = clamp(r0 * 0.4, 6, 20);
  const r2 = Math.max(veg.nearR, r0 + b0 + 16), b2 = clamp(r2 * 0.1, 12, 28);
  const b1 = clamp(r2 * 0.08, 8, 20);
  const r1 = Math.max(r0 + b0, Math.min(r2 - b1, r0 + b0 + (r2 - r0 - b0) * 0.28));
  return { r0, b0, r1, b1, r2, b2 };
}

// The 3D trees' matrix (cached on the tree the first time it is near).
function treeMatrix(t) {
  _q.setFromAxisAngle(_up, t.rot);
  _p.set(t.x, t.y, t.z);
  _s.setScalar(t.s);
  return Float32Array.from(_m.compose(_p, _q, _s).elements);
}

// The cross-fade between detail levels: a screen-door dissolve keyed to the camera's distance from each tree's foot
// (uVegEye, set every frame; uVegR / uVegB: where each hand-over starts and how wide its band is). A level keeps a
// pixel while its dither value lies in [vVegKeep.x, vVegKeep.y): the two levels on either side of a band take
// complementary pixels, so a tree neither doubles up nor shows holes. Instances wholly outside their level collapse in
// the vertex shader (no pixels). Only the instances inside a band use these shaders (VEG_FADE = level + 1).
const VEG_FADE_VERT = /* glsl */`
  uniform vec3 uVegEye;
  uniform vec4 uVegR;
  uniform vec4 uVegB;
  varying vec2 vVegKeep;
  float vegShare(float d, float r, float b) { return clamp((d - r) / b, 0.0, 1.0); }
  vec2 vegKeep(vec3 foot) {
    float d = distance(foot.xz, uVegEye.xz);
    #if VEG_FADE == 1
      return vec2(vegShare(d, uVegR.x, uVegB.x), 1.0);
    #elif VEG_FADE == 2
      return vec2(vegShare(d, uVegR.y, uVegB.y), vegShare(d, uVegR.x, uVegB.x));
    #else
      return vec2(vegShare(d, uVegR.z, uVegB.z), vegShare(d, uVegR.y, uVegB.y));
    #endif
  }`;
// interleaved gradient noise: an even, fine screen-door pattern (the same in every level's shader)
const VEG_DITHER = /* glsl */`
  float vegDither() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }`;
function addVegFade(s, u) {
  s.uniforms.uVegEye = u.eye;
  s.uniforms.uVegR = u.r;
  s.uniforms.uVegB = u.b;
  s.vertexShader = s.vertexShader
    .replace('#include <common>', `#include <common>
      ${VEG_FADE_VERT}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      vVegKeep = vegKeep(vec3(instanceMatrix[3]));`)
    .replace('#include <project_vertex>', `#include <project_vertex>
      if (vVegKeep.x >= 1.0 || vVegKeep.y <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec2 vVegKeep;
      ${VEG_DITHER}`)
    .replace('#include <clipping_planes_fragment>', `{ float vegN = vegDither(); if (vegN < vVegKeep.x || vegN >= vVegKeep.y) discard; }
      #include <clipping_planes_fragment>`);
}


// Mean needle brightness (linear) of each pine texture: both models are normalised to the same tint with it.
// Measured from the texture at load; these are the values of the current models, used if that fails.
const NEEDLE_LUM = { pine_tree: 0.077, pine_tree2: 0.23 };
// branch spread per tree type (radius / height), measured from the models (crownOf); a spruce-like default until then
const CROWN = [0.2, 0.2];
// the spread of a tree's lower third (radius from its axis / its height): most of the outermost tips (90th percentile,
// a stray needle tip doesn't count), times 0.85 (the tips give: you brush them)
function crownOf(geo) {
  const P = geo?.attributes?.position;
  if (!P) return 0;
  let y0 = Infinity, y1 = -Infinity, cx = 0, cz = 0;
  for (let i = 0; i < P.count; i++) { const y = P.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; cx += P.getX(i); cz += P.getZ(i); }
  cx /= P.count; cz /= P.count;
  const H = y1 - y0 || 1, d = [];
  for (let i = 0; i < P.count; i++) if ((P.getY(i) - y0) / H < 0.35) d.push(Math.hypot(P.getX(i) - cx, P.getZ(i) - cz));
  if (d.length < 8) return 0;
  d.sort((a, b) => a - b);
  return Math.min(0.4, (d[Math.floor(d.length * 0.9)] / H) * 0.85);
}

// Shared by the 3D trees and the impostors:
//  - snow on the branches (the model's own clumps + fresh dusting) shows fully up close, and fades toward the
//    distance so forests read as the logo's dark navy silhouettes instead of frosty grey
//  - the crown's self-shadowing: near the camera the sun's shadow map darkens the needles inside the crown; beyond
//    its range (~110 m) and on the impostors the same average amount is applied by hand, and the lower crown sees
//    less sky, so near and far trees keep one brightness
const PINE_SHARED_GLSL = /* glsl */`
  uniform float uSnowAmt; // 1 in fair weather, more while it snows
  const vec3 PINE_SNOW = vec3(0.78, 0.83, 0.9);
  const float PINE_DUST = 0.35;
  const float PINE_CROWN_SHADOW = 0.42;
  float pineSkyOcclusion(float h) { return mix(0.62, 1.0, clamp(h, 0.0, 1.0)); }
  float pineSnowShown(float mask, float dist) { return clamp(mask * uSnowAmt * (1.0 - 0.75 * smoothstep(40.0, 450.0, dist)), 0.0, 1.0); }`;
// The pine look, shared by the 3D trees and the impostor bake.
const PINE_GLSL = /* glsl */`
  uniform float uLumNorm; // 1 / mean needle luminance of this model's texture
  uniform sampler2D uNoise;
  ${PINE_SHARED_GLSL}
  // dark navy / blue-green needles; the texture's own detail survives as relative brightness
  vec3 pineNeedle(vec3 tex) {
    float k = clamp(dot(tex, vec3(0.2126, 0.7152, 0.0722)) * uLumNorm, 0.15, 2.2);
    return mix(vec3(0.011, 0.027, 0.040), vec3(0.028, 0.060, 0.072), smoothstep(0.5, 1.8, k)) * (0.6 + 0.4 * k);
  }
  // the texture's own snow clumps: bright and unsaturated, unlike the light needle tips
  float pineTexSnow(vec3 tex) {
    float hi = max(max(tex.r, tex.g), tex.b);
    return smoothstep(0.6, 0.82, min(min(tex.r, tex.g), tex.b) / max(hi, 1e-4)) * smoothstep(0.12, 0.3, hi);
  }
  // all the snow on a branch: its clumps plus fresh dusting where needles face the sky (op = tree-space position)
  float pineSnowMask(vec3 tex, vec3 wn, vec3 op) {
    float n = texture2D(uNoise, op.xz * 2.6 + vec2(op.y * 1.9, -op.y * 1.4)).r;
    return max(pineTexSnow(tex), smoothstep(0.45, 0.85, wn.y) * smoothstep(0.5, 0.66, n) * PINE_DUST);
  }
`;

// Impostor bake: albedo pass (needle colour) and normal pass (xy normal + snow mask), from IMP_N sides. vObj is the
// unturned tree's space (uUnrot), so the snow dusting is the same in every view and on the 3D trees.
const BAKE_VERT = /* glsl */`
  uniform mat4 uUnrot;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vObj;
  void main() {
    vUv = uv;
    vN = normalize(transpose(inverse(mat3(modelMatrix))) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vObj = (uUnrot * wp).xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const BAKE_ALBEDO = /* glsl */`
  uniform sampler2D map;
  ${PINE_GLSL}
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(pineNeedle(texture2D(map, vUv).rgb), 1.0); }`;
const BAKE_NORMAL = /* glsl */`
  uniform sampler2D map;
  ${PINE_GLSL}
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vObj;
  void main() {
    vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    gl_FragColor = vec4(n.xy * 0.5 + 0.5, pineSnowMask(texture2D(map, vUv).rgb, n, vObj), 1.0);
  }`;

// Mean linear luminance of a pine texture's needles (snow-white texels left out).
function needleLum(tex, fallback) {
  try {
    const img = tex?.image;
    if (!img?.width || typeof document === 'undefined') return fallback;
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S).data;
    const lin = (v) => (v <= 10 ? v / 3294.6 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = lin(d[i]), gg = lin(d[i + 1]), b = lin(d[i + 2]), hi = Math.max(r, gg, b);
      if (hi > 0.2 && Math.min(r, gg, b) > hi * 0.7) continue; // snow clump
      sum += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      n++;
    }
    return n > 1000 ? sum / n : fallback;
  } catch {
    return fallback;
  }
}

export class Vegetation {
  constructor(scene, renderer, models) {
    this.scene = scene;
    this.cells = new Map(); // 'cx,cz' -> cell (heli/collide.js reads it)
    this.cellsN = new Map(); // the same cells by numeric key (cellKey): the per-frame lookups make no strings
    this.windUniform = { value: 0 };
    this.snowUniform = { value: 1 };
    this.farRUniform = { value: quality.veg.farR }; // impostors dissolve toward this distance
    // the levels' hand-overs (treeTiers) and the camera, shared by every tree shader
    this.fadeU = { eye: { value: new THREE.Vector3(1e9, 0, 1e9) }, r: { value: new THREE.Vector4() }, b: { value: new THREE.Vector4() } };
    this.crownU = { value: new THREE.Vector2(85, 115) };
    this.tiers = treeTiers(quality.veg);
    this.rockCloseR = 45;
    // where each set was last built (the camera), the time-sliced impostor build, the cell scans
    this.nearEye = new THREE.Vector2(1e9, 1e9);
    this.farEye = new THREE.Vector2(1e9, 1e9);
    this.rockEye = new THREE.Vector2(1e9, 1e9);
    this.nearDirty = true;
    this.farDirty = true;
    this.farJob = null;
    this.farAge = 0;
    this.farJobState = { x: 0, z: 0, pcx: 0, pcz: 0, k: 0, offs: null };
    this.eyeScan = { key: NaN, done: false };
    this.streamScan = { key: NaN, done: false };
    this.genCount = 0;
    this.offsCache = new Map();

    const treeNames = ['pine_tree', 'pine_tree2'].filter((n) => models[n]);
    this.types = treeNames.map((n) => bakeGeometry(models[n], { size: 1, axis: 'y' }));
    const lumNorm = this.types.map((t, i) => 1 / needleLum(t.material.map, NEEDLE_LUM[treeNames[i]] ?? 0.1));
    // (Oct 28, the user: "make the whole tree collidable, not only the stem, also the branches"): each model's
    // branch spread in its lower part (where a skier, walker or car meets it), as a share of the tree's height
    this.types.forEach((t, i) => { const k = crownOf(t.geometry); if (k) CROWN[i] = k; });
    const makeInst = (geo, mat, max, shadow) => {
      const m = new THREE.InstancedMesh(geo, mat, max);
      m.count = 0;
      m.visible = false;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.pineMats = [];
    const solidMats = this.types.map((t, i) => this.pineMaterial(t.material, lumNorm[i], 0));
    this.depthMats = [1, 2, 3].map((f) => this.fadeDepthMaterial(f));
    // levels[type][level] = [solid, fading]: the instances well inside a level, and those in its fade bands
    this.levels = this.types.map((t, i) => [t.geometry, clusterDecimate(t.geometry, DEC_FINE), clusterDecimate(t.geometry, DEC_COARSE)].map((geo, tier) => {
      const solid = makeInst(geo, solidMats[i], CAPS[tier][0], true);
      const fade = makeInst(geo, this.pineMaterial(t.material, lumNorm[i], tier + 1), CAPS[tier][1], true);
      fade.customDepthMaterial = this.depthMats[tier]; // (its shadow dissolves with it)
      return [solid, fade];
    }));
    this.nearCnt = new Int32Array(this.types.length * 6);

    // rocks: the Meshy rock kit (boulders.js rockKit), each model at two detail levels; every instance also carries
    // the snow line under it (aGround) so snow banks against its foot. The placement never depends on the models
    // (a missing one is just not drawn: its rocks still collide)
    this.rockKit = rockKit(models);
    const makeRocks = (geo, max, mat) => {
      if (!geo) return null;
      const m = new THREE.InstancedMesh(withGround(geo, max), mat, max);
      m.count = 0;
      m.visible = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.rockFar = this.rockKit.lo.map((g, v) => makeRocks(g, MAX_ROCKS, this.rockKit.loMats[v]));
    this.rockNear = this.rockKit.hi.map((g, v) => makeRocks(g, MAX_CLOSE_ROCKS, this.rockKit.hiMats[v]));
    this.rockFarCnt = new Int32Array(ROCKS.length);
    this.rockNearCnt = new Int32Array(ROCKS.length);

    this.impostors = treeNames.map((n, i) => this.renderImpostor(renderer, models[n], lumNorm[i]));
    this.farMeshes = this.impostors.map((imp) => this.makeImpostorMesh(imp));
    this.farStage = this.farMeshes.map(() => new Float32Array(MAX_FAR * 4)); // the impostor set being built
    this.farCnt = new Int32Array(this.types.length);
    const applyQuality = (q) => {
      this.farRUniform.value = q.veg.farR;
      const T = this.tiers = treeTiers(q.veg);
      this.fadeU.r.value.set(T.r0, T.r1, T.r2, 0);
      this.fadeU.b.value.set(T.b0, T.b1, T.b2, 1);
      // the crown's averaged self-shadow (what the impostors carry) takes over where the trees stop casting into the
      // sun's shadow map: toward its range (~110 m) when every 3D tree casts, else across the full trees' fade band
      if (q.veg.nearShadow) this.crownU.value.set(Math.min(85, T.r2 - 30), Math.min(115, T.r2));
      else this.crownU.value.set(T.r0, T.r0 + T.b0);
      this.levels.forEach((lv) => lv.forEach((pair, tier) => { for (const m of pair) m.castShadow = tier === 0 || q.veg.nearShadow; }));
      this.rockCloseR = Math.max(45, T.r0 + 10);
      const fx = fxLevel(q); // (realism tier: the pine shading below, High and up)
      for (const m of this.pineMats) if (m.defines.PINE_FX !== fx) { m.defines.PINE_FX = fx; m.needsUpdate = true; }
      const blend = fx >= 1 ? 1 : 0; // impostors blend their two nearest baked views (Balanced and up)
      for (const { material: m } of this.farMeshes) if (m.defines.IMP_BLEND !== blend) { m.defines.IMP_BLEND = blend; m.needsUpdate = true; }
      this.nearEye.set(1e9, 1e9);
      this.farEye.set(1e9, 1e9);
      this.rockEye.set(1e9, 1e9);
      this.farJob = null;
      this.eyeScan.done = this.streamScan.done = false;
    };
    applyQuality(quality);
    onQualityChange(applyQuality);
  }

  // The 3D pine material: logo tint, fresh snow on needles facing the sky, gentle wind sway. fade: 0 for the
  // instances well inside their level, level + 1 for those in a cross-fade band (addVegFade).
  pineMaterial(src, lumNorm, fade = 0) {
    const mat = src.clone();
    // Meshy baked a glow map into the snow clumps (they lit up at night): snow is plain lit albedo now
    mat.emissive.setRGB(0, 0, 0);
    mat.emissiveMap = null;
    mat.metalness = 0;
    mat.defines = { ...(mat.defines || {}), PINE_FX: fxLevel(), VEG_FADE: fade };
    const wind = this.windUniform, snow = this.snowUniform, uLumNorm = { value: lumNorm }, crown = this.crownU, fadeU = this.fadeU;
    mat.onBeforeCompile = (s) => {
      s.uniforms.uWind = wind;
      s.uniforms.uLumNorm = uLumNorm;
      s.uniforms.uSnowAmt = snow;
      s.uniforms.uNoise = terrainUniforms.uNoise;
      s.uniforms.uPineCrown = crown;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uWind;
          varying vec3 vPineObj;
          varying vec3 vPineW;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vPineObj = position;
          float sway = position.y * position.y * 0.012;
          vec3 ip = vec3(instanceMatrix[3]);
          transformed.x += sin(uWind * 1.3 + ip.x * 0.1 + ip.z * 0.07) * sway;
          transformed.z += cos(uWind * 1.1 + ip.z * 0.1) * sway * 0.6;
          #if PINE_FX >= 2
            // branch flutter: the outer branch tips shiver a little on their own in the wind
            float rr = length(position.xz) * position.y;
            transformed.x += sin(uWind * 3.7 + dot(position, vec3(11.0, 7.0, 5.0)) * 9.0 + ip.x) * rr * 0.02;
            transformed.z += cos(uWind * 3.1 + dot(position, vec3(5.0, 9.0, 13.0)) * 9.0 + ip.z) * rr * 0.02;
          #endif
          vPineW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>
          ${PINE_GLSL}
          uniform vec2 uPineCrown;
          varying vec3 vPineObj;
          varying vec3 vPineW;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 pineTex = diffuseColor.rgb;
          diffuseColor.rgb = pineNeedle(pineTex);`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          {
            float m = pineSnowMask(pineTex, inverseTransformDirection(normal, viewMatrix), vPineObj);
            float snowA = pineSnowShown(m, distance(vPineW, cameraPosition));
            diffuseColor.rgb = mix(diffuseColor.rgb, PINE_SNOW, snowA);
            roughnessFactor = mix(max(roughnessFactor, 0.82), 0.7, snowA);
          }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            float crown = mix(1.0, PINE_CROWN_SHADOW, smoothstep(uPineCrown.x, uPineCrown.y, distance(vPineW, cameraPosition)));
            reflectedLight.directDiffuse *= crown;
            reflectedLight.directSpecular *= crown;
            reflectedLight.indirectDiffuse *= pineSkyOcclusion(vPineObj.y);
            #if PINE_FX >= 2 && NUM_DIR_LIGHTS > 0
            {
              // close trees only (the impostors carry the averaged look, so this fades before they take over)
              float pNear = 1.0 - smoothstep(60.0, 110.0, distance(vPineW, cameraPosition));
              // needles deep in the crown, near the trunk, see little sky (cone-shaped crown, the model is 1 high)
              float cr = 0.3 * (1.0 - clamp(vPineObj.y, 0.0, 1.0)) + 0.03;
              float inner = smoothstep(0.15, 0.9, length(vPineObj.xz) / cr);
              reflectedLight.indirectDiffuse *= mix(1.0, 0.55 + 0.45 * inner, pNear);
              // translucency: the thin outer needles glow green-gold when the sun is behind them (directLight = the
              // sun after its shadow map, so only needles the light really reaches); not the snow on them
              float pBack = saturate(dot(-geometryViewDir, directionalLights[0].direction));
              float pAlb = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
              float pTr = pow(pBack, 5.0) * (0.3 + 0.7 * inner) * pNear * (1.0 - smoothstep(0.12, 0.4, pAlb));
              #if PINE_FX >= 3
                pTr *= 1.25;
              #endif
              reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * vec3(0.9, 1.25, 0.65) * pTr * 0.45;
            }
            #endif
          }`);
      if (fade) addVegFade(s, fadeU);
    };
    this.pineMats.push(mat);
    return mat;
  }

  // The shadow-map material of the instances in a fade band: their shadow dissolves along with them.
  fadeDepthMaterial(fade) {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.defines = { VEG_FADE: fade };
    const u = this.fadeU;
    m.onBeforeCompile = (s) => addVegFade(s, u);
    return m;
  }

  // Bakes a tree seen from IMP_N sides (every 22.5° round it) into an atlas of two mipmapped textures: its needle
  // colour (same tint code as the 3D trees) and its normals + snow mask. Each view is rendered multisampled into a
  // small target, then copied into its tile. Both come out coverage-weighted (the MSAA resolve and the mips average
  // against a transparent black background), which the impostor shader divides back out. The impostor then shows the
  // view of the tree from where the camera really is (its turn included), so it keeps the 3D tree's silhouette.
  renderImpostor(renderer, gltf, lumNorm) {
    const tileOpts = { samples: 4, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    const atlasOpts = { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter };
    const AW = IMP_W * IMP_COLS, AH = IMP_H * IMP_ROWS;
    const tiles = [new THREE.WebGLRenderTarget(IMP_W, IMP_H, { ...tileOpts, colorSpace: THREE.SRGBColorSpace }), new THREE.WebGLRenderTarget(IMP_W, IMP_H, tileOpts)];
    const atlases = [new THREE.WebGLRenderTarget(AW, AH, { ...atlasOpts, colorSpace: THREE.SRGBColorSpace }), new THREE.WebGLRenderTarget(AW, AH, atlasOpts)];
    const scene = new THREE.Scene(), pivot = new THREE.Group();
    scene.add(pivot);
    const tree = fitModel(gltf, { size: 1, axis: 'y' });
    pivot.add(tree);
    pivot.updateMatrixWorld(true);
    // the widest the tree reaches from its axis, any way round
    let maxR = 0;
    tree.traverse((o) => {
      const P = o.isMesh && o.geometry.attributes.position;
      if (!P) return;
      for (let i = 0; i < P.count; i++) { _p.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); maxR = Math.max(maxR, Math.hypot(_p.x, _p.z)); }
    });
    const halfW = (maxR || 0.3) * 1.04;
    const unrot = { value: new THREE.Matrix4() };
    const uniforms = { uLumNorm: { value: lumNorm }, uSnowAmt: this.snowUniform, uNoise: terrainUniforms.uNoise, uUnrot: unrot };
    const passes = [BAKE_ALBEDO, BAKE_NORMAL].map((fragmentShader) => {
      const mats = [];
      tree.traverse((o) => {
        if (!o.isMesh) return;
        mats.push([o, new THREE.ShaderMaterial({
          uniforms: { ...uniforms, map: { value: o.material.map } },
          vertexShader: BAKE_VERT, fragmentShader, side: THREE.DoubleSide,
        })]);
      });
      return mats;
    });
    const cam = new THREE.OrthographicCamera(-halfW, halfW, IMP_Y1, IMP_Y0, -10, 10);
    cam.position.set(0, 0, 2);
    // the copy into the atlas: a full-screen quad, no blending
    const blit = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blit);
    quad.frustumCulled = false;
    const blitScene = new THREE.Scene();
    blitScene.add(quad);
    const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    const prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    for (const a of atlases) { a.scissorTest = false; renderer.setRenderTarget(a); renderer.clear(); }
    for (let k = 0; k < IMP_N; k++) {
      // view k: the tree as seen from the direction k * 22.5° round its own axis (turned the other way, camera fixed)
      const ang = (k / IMP_N) * Math.PI * 2;
      pivot.rotation.y = -ang;
      pivot.updateMatrixWorld(true);
      unrot.value.makeRotationY(ang);
      const col = k % IMP_COLS, row = Math.floor(k / IMP_COLS);
      for (let p = 0; p < 2; p++) {
        for (const [o, m] of passes[p]) o.material = m;
        renderer.setRenderTarget(tiles[p]);
        renderer.clear();
        renderer.render(scene, cam);
        const a = atlases[p];
        a.viewport.set(col * IMP_W, row * IMP_H, IMP_W, IMP_H);
        a.scissor.set(col * IMP_W, row * IMP_H, IMP_W, IMP_H);
        a.scissorTest = true;
        blit.uniforms.tSrc.value = tiles[p].texture;
        renderer.setRenderTarget(a);
        renderer.render(blitScene, cam);
      }
    }
    for (const a of atlases) { a.viewport.set(0, 0, AW, AH); a.scissor.set(0, 0, AW, AH); a.scissorTest = false; }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
    for (const mats of passes) for (const [, m] of mats) m.dispose();
    for (const t of tiles) t.dispose();
    blit.dispose();
    quad.geometry.dispose();
    return { albedo: atlases[0].texture, normal: atlases[1].texture, halfW };
  }

  makeImpostorMesh(imp) {
    const plane = new THREE.PlaneGeometry(imp.halfW * 2, IMP_Y1 - IMP_Y0);
    plane.translate(0, (IMP_Y0 + IMP_Y1) / 2, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.attributes.position = plane.attributes.position;
    geo.attributes.uv = plane.attributes.uv;
    geo.attributes.normal = plane.attributes.normal;
    // per tree: its foot (xyz) and w = round(height * 16) + its turn / 2π
    const data = new Float32Array(MAX_FAR * 4);
    const attr = new THREE.InstancedBufferAttribute(data, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOffset', attr);
    geo.instanceCount = 0;
    // alpha to coverage (the main render target is MSAA): soft, non-shimmering edges on the mipmapped bake
    const mat = new THREE.MeshStandardMaterial({ map: imp.albedo, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.4, alphaToCoverage: true });
    mat.defines = { IMP_BLEND: 1 };
    const nTex = { value: imp.normal }, snow = this.snowUniform, farR = this.farRUniform, fadeU = this.fadeU;
    const f = (v) => v.toFixed(4);
    mat.onBeforeCompile = (s) => {
      s.uniforms.uImpN = nTex;
      s.uniforms.uSnowAmt = snow;
      s.uniforms.uFarR = farR;
      s.uniforms.uVegEye = fadeU.eye;
      s.uniforms.uVegR = fadeU.r;
      s.uniforms.uVegB = fadeU.b;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aOffset;
          uniform float uFarR;
          uniform vec3 uVegEye;
          uniform vec4 uVegR;
          uniform vec4 uVegB;
          varying vec3 vImpR;
          varying vec3 vImpU;
          varying vec3 vImpF;
          varying vec4 vImpTile;
          varying float vImpW;
          varying float vImpFade;
          varying float vImpDist;
          varying float vImpIn;`)
        .replace('#include <beginnormal_vertex>', `
          float impS = floor(aOffset.w) / 16.0;
          float impTurn = fract(aOffset.w) * 6.2831853;
          vec3 toCam = cameraPosition - aOffset.xyz;
          float camH = toCam.y - impS * 0.5;
          toCam.y = 0.0;
          float camD = length(toCam);
          toCam /= max(camD, 1e-3);
          // seen from above, the card leans back toward the camera (a vertical card would shrink to a sliver; a
          // pine seen from above shows its crown as well as its height)
          float impTilt = min(max(atan(camH, max(camD, 1e-3)), 0.0) * 0.6, 0.42);
          vec3 impUp = vec3(0.0, cos(impTilt), 0.0) - toCam * sin(impTilt);
          vec3 impFw = toCam * cos(impTilt) + vec3(0.0, sin(impTilt), 0.0);
          vec3 objectNormal = impFw;`)
        .replace('#include <begin_vertex>', `
          vec3 right = vec3(toCam.z, 0.0, -toCam.x);
          vec3 transformed = aOffset.xyz + (right * position.x + impUp * position.y) * impS;
          vImpR = right;
          vImpU = impUp;
          vImpF = impFw;
          // which baked views: the camera's direction in the tree's own (turned) frame, between two of the IMP_N
          float impA = mod((atan(toCam.x, toCam.z) - impTurn) / 6.2831853 * ${IMP_N}.0, ${IMP_N}.0);
          float impK0 = min(floor(impA), ${IMP_N - 1}.0);
          float impK1 = mod(impK0 + 1.0, ${IMP_N}.0);
          vImpW = clamp(impA - impK0, 0.0, 1.0);
          vImpTile = vec4(mod(impK0, ${IMP_COLS}.0), floor(impK0 / ${IMP_COLS}.0), mod(impK1, ${IMP_COLS}.0), floor(impK1 / ${IMP_COLS}.0));
          vImpDist = distance(transformed, cameraPosition);
          vImpFade = 1.0 - smoothstep(uFarR * 0.86, uFarR, camD); // dissolve at the far edge of the forest
          // the hand-over from the 3D trees (the same screen-door as theirs: vegetation.js addVegFade)
          vImpIn = clamp((distance(aOffset.xz, uVegEye.xz) - uVegR.z) / uVegB.z, 0.0, 1.0);`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          if (vImpIn <= 0.0 || vImpFade <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uImpN;
          varying vec3 vImpR;
          varying vec3 vImpU;
          varying vec3 vImpF;
          varying vec4 vImpTile;
          varying float vImpW;
          varying float vImpFade;
          varying float vImpDist;
          varying float vImpIn;
          ${VEG_DITHER}
          ${PINE_SHARED_GLSL}`)
        .replace('#include <clipping_planes_fragment>', `if (vegDither() >= vImpIn) discard;
          #include <clipping_planes_fragment>`)
        .replace('#include <map_fragment>', `
          // un-weight the coverage-weighted bake so edges and small mips keep the true colour
          const vec2 impGrid = vec2(${IMP_COLS}.0, ${IMP_ROWS}.0);
          vec2 impUv0 = (vImpTile.xy + vMapUv) / impGrid;
          vec4 impA = texture2D(map, impUv0);
          vec4 impN = texture2D(uImpN, impUv0);
          #if IMP_BLEND == 1
            vec2 impUv1 = (vImpTile.zw + vMapUv) / impGrid;
            impA = mix(impA, texture2D(map, impUv1), vImpW);
            impN = mix(impN, texture2D(uImpN, impUv1), vImpW);
          #endif
          float impCov = max(impA.a, 1e-3);
          vec2 impXY = impN.rg / impCov * 2.0 - 1.0;
          vec3 impNb = vec3(impXY, sqrt(max(0.0, 1.0 - dot(impXY, impXY))));
          float impSnow = pineSnowShown(impN.b / impCov, vImpDist);
          diffuseColor.rgb = mix(impA.rgb / impCov, PINE_SNOW, impSnow);
          // thin distant crowns would erode away in the small mips: boost coverage with the mip level
          vec2 impTs = vec2(textureSize(map, 0)) / impGrid;
          float impMip = max(0.0, log2(max(length(dFdx(vMapUv * impTs)), length(dFdy(vMapUv * impTs)))));
          diffuseColor.a = impA.a * (1.0 + 0.22 * impMip) * vImpFade;
          // baked normal (x = right, y = up the card, z = toward the viewer) to world space
          vec3 impWN = normalize(vImpR * impNb.x + vImpU * impNb.y + vImpF * impNb.z);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.7, impSnow);`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(impWN, 0.0)).xyz);`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= PINE_CROWN_SHADOW;
          reflectedLight.directSpecular *= PINE_CROWN_SHADOW;
          reflectedLight.indirectDiffuse *= pineSkyOcclusion(vMapUv.y * ${f(IMP_Y1 - IMP_Y0)} + ${f(IMP_Y0)});`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  genCell(cx, cz) {
    const trees = [], rocks = [];
    const x0 = cx * CELL, z0 = cz * CELL;
    const c = { d: 1e9 };
    const gx0 = Math.floor(x0 / SPACING), gx1 = Math.floor((x0 + CELL) / SPACING);
    const gz0 = Math.floor(z0 / SPACING), gz1 = Math.floor((z0 + CELL) / SPACING);
    for (let gz = gz0; gz < gz1; gz++) for (let gx = gx0; gx < gx1; gx++) {
      const r1 = hash2(gx, gz, 1), r2 = hash2(gx, gz, 2), r3 = hash2(gx, gz, 3);
      const x = (gx + r1) * SPACING, z = (gz + r2) * SPACING;
      const h = world.height(x, z);
      const hx = world.height(x + 1, z) - h, hz = world.height(x, z + 1) - h;
      const slope = Math.hypot(hx, hz);
      const f = world.forest(x, z, h, slope);
      const rr = hash2(gx, gz, 5);
      if (r3 < f * 0.85) {
        world.corridorAt(x, z, c);
        if (c.d < 3 + r1 * 4) continue;
        if (this.nearPad(x, z)) continue;
        const s = 7 + r1 * 9 + f * 5;
        const type = rr < 0.6 ? 0 : 1;
        trees.push({ x, y: h - 0.3, z, s, rot: r2 * 6.283, type, r: s * 0.03 + 0.25, trunk: 0.15 + s * 0.012, crown: Math.max(0.6, s * (CROWN[type] ?? CROWN[0])) }); // trunk: the stem; crown: the branches
      } else if (rr < 0.055 && this.rockKit) {
        this.rockSpot(gx, gz, x, z, h, hx, hz, slope, f, rr, c, rocks);
      }
    }
    return { trees, rocks };
  }

  // The rocks at one grid point that holds no tree (rr: its hash). Sparse on purpose: open snowfields stay open, the
  // rock goes where real mountains show it (the C++ port, native/src/world/scenery.cpp rockSpot, is the same code):
  //  - crags: on the steep faces (slope > 0.9, where the terrain is rock already), a tall crag or a big slab of bedrock
  //  - outcrops: bedrock breaking out along the ridges and convex shoulders (the ground falls away on every side)
  //  - boulders: at the tree line and in the open forest (most), off the runs on the steeper slopes, rarely on gentle
  //    open ground; a flat slab now and then on the gentler ground
  //  - scree: a talus heap and a block or two at the foot of a rock wall (steep ground just above)
  // Nothing on or by the runs, race courses, lift lines and roads (their corridors), stations, huts and buildings (the
  // pads), the village, or the railways' formations.
  rockSpot(gx, gz, x, z, h, hx, hz, slope, f, rr, c, out) {
    const H = (k) => hash2(gx, gz, k);
    const clear = (px, pz, size) => {
      world.corridorAt(px, pz, c);
      return !(c.d < 3 + size * 0.6 || this.nearPad(px, pz) || px * px + pz * pz < VILLAGE_CLEAR * VILLAGE_CLEAR || onExpressBed(px, pz, size) || onRailBed(px, pz, size));
    };
    // the long side along the slope's contour (a strata's strike), a little off
    const contour = Math.atan2(-hx, -hz) + (H(9) - 0.5) * 0.6;
    if (slope > 0.9) {
      // the steep faces: a crag standing out of the rock, or a big slab of bedrock breaking out of it
      if (rr >= 0.012) return;
      const crag = H(7) < 0.6, s = crag ? 3 + H(8) * 2.5 : 5 + H(8) * 3;
      if (clear(x, z, s)) this.placeRock(out, crag ? ROCK.CRAG : ROCK.SLAB, x, z, h, hx, hz, s, crag ? H(9) * Math.PI * 2 : contour, 0.3, crag ? 0.25 : 0.4, gx, gz);
      return;
    }
    if (rr < 0.02 && slope > 0.3) {
      // ridges and convex shoulders (the ground falls away on every side): bedrock breaking out, a slab along the
      // contour or the top of a big boulder
      const k = 12, curv = h - (world.height(x + k, z) + world.height(x - k, z) + world.height(x, z + k) + world.height(x, z - k)) / 4;
      if (curv > 1.5) {
        const slab = H(7) < 0.6, s = slab ? 5 + H(8) * 3 : 3.5 + H(8) * 2;
        if (clear(x, z, s)) this.placeRock(out, slab ? ROCK.SLAB : ROCK.GRANITE, x, z, h, hx, hz, s, slab ? contour : H(9) * Math.PI * 2, 0.6, slab ? 0.35 : 0.4, gx, gz);
        return;
      }
    }
    if (rr < (f > 0.04 ? 0.01 : slope > 0.45 ? 0.006 : 0.002)) {
      const slab = slope < 0.35 && H(7) < 0.35;
      const v = slab ? ROCK.SLAB : H(7) < 0.68 ? ROCK.GRANITE : ROCK.LIMESTONE;
      const s = slab ? 2.5 + H(8) * 2.5 : 1 + H(8) * H(8) * 2.6;
      if (clear(x, z, s)) this.placeRock(out, v, x, z, h, hx, hz, s, slab ? contour : H(9) * Math.PI * 2, 0.65, 0.2 + H(12) * 0.15, gx, gz);
      return;
    }
    if (rr >= 0.04 && slope > 0.12 && slope < 0.8) {
      // scree: below a rock wall (15 m uphill the ground is steep), what broke off lies in a heap at its foot
      const ux = hx / slope, uz = hz / slope, ax = x + ux * 15, az = z + uz * 15;
      const cliff = Math.hypot(world.height(ax + 2, az) - world.height(ax - 2, az), world.height(ax, az + 2) - world.height(ax, az - 2)) / 4;
      if (cliff < 1.0) return;
      const s = 3 + H(8) * 2;
      if (!clear(x, z, s + 3)) return;
      this.placeRock(out, ROCK.SCREE, x, z, h, hx, hz, s, H(9) * Math.PI * 2, 0.85, 0.15, gx, gz);
      const n = 1 + Math.floor(H(13) * 2);
      for (let i = 0; i < n; i++) {
        const ox = x + (H(20 + i) - 0.5) * 9, oz = z + (H(30 + i) - 0.5) * 9;
        const oh = world.height(ox, oz), ohx = world.height(ox + 1, oz) - oh, ohz = world.height(ox, oz + 1) - oh;
        const os = 0.8 + H(40 + i) * 1.2;
        if (clear(ox, oz, os)) this.placeRock(out, H(50 + i) < 0.6 ? ROCK.GRANITE : ROCK.LIMESTONE, ox, oz, oh, ohx, ohz, os, H(60 + i) * Math.PI * 2, 0.65, 0.25, gx, gz, 70 + i * 4);
      }
    }
  }

  // One rock: model v, `s` m wide (its longest side), turned to `yaw`, its base following `follow` of the slope (crags
  // stand upright, boulders settle into the hillside), sunk `sink` of its height into the snow (and deeper on a slope,
  // so its downhill edge never floats). The instance matrix is baked here; `g` is the snow line under it for the shader.
  // Colliders: a circle as wide as its short side (two more along an elongated rock's long side, collider-only records
  // without a matrix); `s` of the record is its collision size: rocks showing less than LOW_ROCK above the snow are
  // skied over (s < BIG_ROCK), the rest stop you, and y is set so player.js's obstacle top (y + 0.75 s) is the real top.
  placeRock(out, v, x, z, h, hx, hz, s, yaw, follow, sink, gx, gz, k0 = 10) {
    const R = ROCKS[v];
    _n.set(-hx, 1, -hz).normalize();
    _q.setFromUnitVectors(_up, _n);
    _q.slerp(_id, 1 - follow);
    _qy.setFromAxisAngle(_up, yaw);
    _q.multiply(_qy);
    const sy = s * (0.85 + hash2(gx, gz, k0) * 0.3) * R.sy, sz = s * (0.9 + hash2(gx, gz, k0 + 1) * 0.2);
    const Hh = R.h * sy, slope = Math.hypot(hx, hz);
    const base = h - sink * Hh - slope * s * 0.45 * (1 - follow);
    _p.set(x, base, z);
    _s.set(s, sy, sz);
    _m.compose(_p, _q, _s);
    const top = base + Hh, above = top - h;
    const S = above < LOW_ROCK ? Math.min(s, 2) : Math.max(s, BIG_ROCK);
    const d = R.d * (sz / s), y = top - 0.75 * S, g = [hx, hz, h];
    const long = d < 0.6;
    out.push({ x, y, z, s: S, r: long ? 0.5 * s * d * 0.95 : 0.5 * s * Math.sqrt(d) * 0.9, v, m: Float32Array.from(_m.elements), g });
    if (long) {
      const e = _m.elements, l = Math.hypot(e[0], e[2]) || 1, ax = e[0] / l, az = e[2] / l, o = (0.5 - 0.5 * d) * s * 0.8;
      for (const k of [-1, 1]) out.push({ x: x + ax * o * k, y, z: z + az * o * k, s: S, r: 0.5 * s * d * 0.9, v: -1, m: null, g });
    }
  }

  nearPad(x, z) {
    const pads = world.padGrid.get(Math.floor(x / 256) + ',' + Math.floor(z / 256));
    if (!pads) return false;
    for (const p of pads) if (Math.hypot(x - p.x, z - p.z) < p.r + p.blend * 0.6) return true;
    return false;
  }

  getCell(cx, cz, create) {
    let cell = this.cellsN.get(cellKey(cx, cz));
    if (!cell && create) {
      world.ensureFeatures(cx * CELL, cz * CELL, (cx + 1) * CELL, (cz + 1) * CELL);
      cell = this.genCell(cx, cz);
      cell.cx = cx; cell.cz = cz;
      this.cells.set(cx + ',' + cz, cell);
      this.cellsN.set(cellKey(cx, cz), cell);
    }
    return cell;
  }


  // Cell offsets (i, j pairs) within `reach` metres of a cell, nearest first (cached per radius).
  cellOffsets(reach) {
    const R = Math.ceil(reach / CELL);
    let offs = this.offsCache.get(R);
    if (!offs) {
      const list = [];
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) if ((i * i + j * j) * CELL * CELL <= reach * reach) list.push([i, j, i * i + j * j]);
      list.sort((a, b) => a[2] - b[2]);
      offs = new Int16Array(list.length * 2);
      list.forEach(([i, j], k) => { offs[k * 2] = i; offs[k * 2 + 1] = j; });
      this.offsCache.set(R, offs);
    }
    return offs;
  }

  // Generate the missing cells within `reach` of (x, z), nearest first, while the frame's budget lasts.
  genAround(x, z, reach, t0, budgetMs, scan) {
    const pcx = Math.floor(x / CELL), pcz = Math.floor(z / CELL);
    // (performance pass: every cell in reach was there last frame and you are still in the same cell: no scan of the
    // ~2400 cell keys, which made that many strings a frame)
    const key = pcx * 100003 + pcz + reach * 7.1e9;
    if (scan.key === key && scan.done) return 0;
    scan.key = key;
    const offs = this.cellOffsets(reach);
    let missing = 0;
    for (let k = 0; k < offs.length; k += 2) {
      const cx = pcx + offs[k], cz = pcz + offs[k + 1];
      if (this.cellsN.has(cellKey(cx, cz))) continue;
      if (this.genCount > 0 && performance.now() - t0 > budgetMs) { missing++; continue; }
      this.getCell(cx, cz, true);
      this.genCount++;
    }
    scan.done = missing === 0;
    return missing;
  }

  // Generate cells round the camera and the streaming point (px, pz: ahead of a fast ride) within a time budget, and
  // keep the tree sets built round the camera. Returns the number of cells still missing.
  update(px, pz, dt, budgetMs = 4) {
    this.windUniform.value += dt;
    // fresh snow settles on the branches while it snows (shared by the 3D trees and the impostors)
    // (+ freezing fog's rime, Oct 30 2026, the user: "white frost look on trees ... a tint", kept gentle: sky.js frost)
    this.snowUniform.value = 1 + 0.8 * terrainUniforms.uSnowCover.value + 0.5 * (globalThis.__game?.env?.frost || 0);
    // the detail levels follow the camera (where you look from), not the streaming point
    const cam = globalThis.__game?.camera, cp = cam?.position;
    const ex = cp ? cp.x : px, ez = cp ? cp.z : pz;
    this.fadeU.eye.value.set(ex, cp ? cp.y : 0, ez);
    const t0 = performance.now(), T = this.tiers, farR = quality.veg.farR;
    // the cells under the 3D trees first, then everything to the impostors' reach round the streaming point
    this.genCount = 0;
    let missing = this.genAround(ex, ez, T.r2 + T.b2 + NEAR_PAD + CELL, t0, budgetMs, this.eyeScan);
    if (this.genCount) this.nearDirty = this.farDirty = true;
    const nearGen = this.genCount;
    missing += this.genAround(px, pz, farR + CELL, t0, budgetMs, this.streamScan);
    if (this.genCount > nearGen) this.farDirty = true;
    if (this.nearDirty || Math.hypot(ex - this.nearEye.x, ez - this.nearEye.y) > NEAR_STEP) {
      this.nearDirty = false;
      this.nearEye.set(ex, ez);
      this.rebuildNear(ex, ez);
    }
    if (Math.hypot(ex - this.rockEye.x, ez - this.rockEye.y) > ROCK_STEP || (nearGen && this.rockKit)) {
      this.rockEye.set(ex, ez);
      this.rebuildRocks(ex, ez);
    }
    // impostors: a fresh set each FAR_STEP m (or when cells came in), built over a few frames into a staging buffer;
    // finished at once when the shown set falls too far behind (a teleport, the loading screens: dt 0)
    const behind = Math.hypot(ex - this.farEye.x, ez - this.farEye.y);
    const job = this.farJob;
    if (job && Math.hypot(ex - job.x, ez - job.z) > FAR_STEP * 2) this.farJob = null; // (outrun: start over from here)
    this.farAge += dt;
    // (new cells keep arriving at the far edge as you move: they join at most every 0.5 s)
    if (!this.farJob && ((this.farDirty && (this.farAge > 0.5 || dt === 0)) || behind > FAR_STEP)) this.startFar(ex, ez);
    if (this.farJob) this.stepFar(dt === 0 || behind > FAR_PAD - 2 * NEAR_PAD ? Infinity : 1.2);
    // evict cells far from both the camera and the streaming point (only as you move on: it walks every key)
    const evictR = Math.max(farR + FAR_PAD, FAR_R) * 1.3 + CELL;
    if (!this.streamScan.done || !this.eyeScan.done) this.evict(px, pz, ex, ez, evictR);
    return missing;
  }

  evict(px, pz, ex, ez, evictR) {
    const R = Math.ceil(evictR / CELL);
    if (this.cellsN.size < Math.PI * R * R * 1.2) return;
    const pcx = px / CELL, pcz = pz / CELL, ecx = ex / CELL, ecz = ez / CELL;
    for (const [key, { cx, cz }] of this.cellsN) {
      if (Math.hypot(cx - pcx, cz - pcz) <= R || Math.hypot(cx - ecx, cz - ecz) <= R) continue;
      this.cellsN.delete(key);
      this.cells.delete(cx + ',' + cz);
    }
  }

  // The 3D trees round the camera at (ex, ez): every tree goes to each level whose reach (with its fade band and
  // NEAR_PAD of slack for the camera moving on before the next rebuild) it lies in; those safely inside a level take
  // the plain shader, those in or near a band the fading one. Nearest first, so the caps drop the furthest.
  rebuildNear(ex, ez) {
    const T = this.tiers, P = NEAR_PAD, cnt = this.nearCnt.fill(0), nT = this.types.length;
    const in0 = T.r0 + T.b0, in1 = T.r1 + T.b1, reach = T.r2 + T.b2 + P, reach2 = reach * reach;
    const offs = this.cellOffsets(reach + CELL);
    const pcx = Math.floor(ex / CELL), pcz = Math.floor(ez / CELL);
    for (let k = 0; k < offs.length; k += 2) {
      const cell = this.cellsN.get(cellKey(pcx + offs[k], pcz + offs[k + 1]));
      if (!cell) continue;
      for (const t of cell.trees) {
        const dx = t.x - ex, dz = t.z - ez, d2 = dx * dx + dz * dz;
        if (d2 >= reach2) continue;
        const d = Math.sqrt(d2), type = t.type < nT ? t.type : 0;
        let m = null;
        for (let tier = 0; tier < 3; tier++) {
          const lo = tier === 0 ? -1 : tier === 1 ? T.r0 - P : T.r1 - P; // (inside: the level before still shows)
          const hi = tier === 0 ? in0 + P : tier === 1 ? in1 + P : reach;
          if (d <= lo || d >= hi) continue;
          const solidLo = tier === 0 ? -1 : (tier === 1 ? in0 : in1) + P, solidHi = (tier === 0 ? T.r0 : tier === 1 ? T.r1 : T.r2) - P;
          const base = (type * 3 + tier) * 2;
          let fade = d < solidLo || d > solidHi ? 1 : 0;
          if (!fade && cnt[base] >= CAPS[tier][0]) fade = 1; // (the fading shader shows it whole there too)
          if (cnt[base + fade] >= CAPS[tier][fade]) continue;
          if (!m) m = t.m || (t.m = treeMatrix(t));
          this.levels[type][tier][fade].instanceMatrix.array.set(m, cnt[base + fade]++ * 16);
        }
      }
    }
    // (only the instances in use are uploaded)
    for (let type = 0; type < nT; type++) for (let tier = 0; tier < 3; tier++) for (let fade = 0; fade < 2; fade++) {
      this.upload(this.levels[type][tier][fade], cnt[(type * 3 + tier) * 2 + fade]);
    }
  }

  upload(m, n) {
    m.count = n;
    m.visible = n > 0;
    const a = m.instanceMatrix;
    a.clearUpdateRanges();
    a.addUpdateRange(0, n * 16);
    a.needsUpdate = true;
  }

  // Rocks within the preset's reach of the camera (the crags and outcrops, BIG_FAR wide and up, to twice that: they
  // shape the mountains' look from afar), the close ones with the detailed mesh, nearest cells first.
  rebuildRocks(ex, ez) {
    if (!this.rockKit) return;
    const rockFar = this.rockFarCnt.fill(0), rockClose = this.rockNearCnt.fill(0), closeR2 = this.rockCloseR ** 2;
    const rockR = quality.veg.rockR, bigR = Math.min(rockR * 2, quality.veg.farR), offs = this.cellOffsets(bigR);
    const rockR2 = rockR * rockR, bigR2 = bigR * bigR;
    const pcx = Math.floor(ex / CELL), pcz = Math.floor(ez / CELL);
    let rockTotal = 0;
    for (let k = 0; k < offs.length && rockTotal < MAX_ROCKS; k += 2) {
      const cell = this.cellsN.get(cellKey(pcx + offs[k], pcz + offs[k + 1]));
      if (!cell) continue;
      for (const r of cell.rocks) {
        if (r.v < 0) continue; // (an elongated rock's extra collider)
        if (rockTotal >= MAX_ROCKS) break;
        const dx = r.x - ex, dz = r.z - ez, d2 = dx * dx + dz * dz;
        if (d2 > (r.m[0] * r.m[0] + r.m[2] * r.m[2] >= BIG_FAR * BIG_FAR ? bigR2 : rockR2)) continue;
        const near = rockClose[r.v] < MAX_CLOSE_ROCKS && d2 < closeR2;
        const mesh = near ? this.rockNear[r.v] : this.rockFar[r.v];
        if (!mesh) continue;
        const i = near ? rockClose[r.v]++ : rockFar[r.v]++;
        mesh.instanceMatrix.array.set(r.m, i * 16);
        mesh.geometry.attributes.aGround.array.set(r.g, i * 3);
        rockTotal++;
      }
    }
    const uploadRocks = (meshes, counts) => meshes.forEach((m, v) => {
      if (!m) return;
      this.upload(m, counts[v]);
      const g = m.geometry.attributes.aGround;
      g.clearUpdateRanges(); g.addUpdateRange(0, counts[v] * 3); g.needsUpdate = true;
    });
    uploadRocks(this.rockFar, rockFar);
    uploadRocks(this.rockNear, rockClose);
  }

  startFar(ex, ez) {
    const j = this.farJob = this.farJobState;
    j.x = ex; j.z = ez;
    j.pcx = Math.floor(ex / CELL); j.pcz = Math.floor(ez / CELL);
    j.k = 0;
    j.offs = this.cellOffsets(quality.veg.farR + FAR_PAD + CELL);
    this.farCnt.fill(0);
    this.farDirty = false;
  }

  // Part of the impostor set: from FAR_PAD inside the 3D trees' reach (they cross-fade there) out past farR, nearest
  // first (so maxFar drops the furthest). When done the staging buffers are swapped in.
  stepFar(budgetMs) {
    const j = this.farJob, t0 = performance.now(), { farR } = quality.veg, maxFar = Math.min(MAX_FAR, quality.veg.maxFar);
    const lo = Math.max(0, this.tiers.r2 - FAR_PAD), lo2 = lo * lo, hi = farR + FAR_PAD, hi2 = hi * hi;
    const offs = j.offs, cnt = this.farCnt, nT = this.types.length, TURN = 1 / (Math.PI * 2);
    while (j.k < offs.length) {
      const cell = this.cellsN.get(cellKey(j.pcx + offs[j.k], j.pcz + offs[j.k + 1]));
      j.k += 2;
      if (cell) for (const t of cell.trees) {
        const dx = t.x - j.x, dz = t.z - j.z, d2 = dx * dx + dz * dz;
        if (d2 < lo2 || d2 >= hi2) continue;
        const type = t.type < nT ? t.type : 0, c = cnt[type];
        if (c >= maxFar) continue;
        const a = this.farStage[type], o = c * 4;
        a[o] = t.x; a[o + 1] = t.y; a[o + 2] = t.z; a[o + 3] = Math.round(t.s * 16) + Math.min(0.999, t.rot * TURN);
        cnt[type] = c + 1;
      }
      if ((j.k & 63) === 0 && performance.now() - t0 > budgetMs) return;
    }
    this.farMeshes.forEach((mesh, i) => {
      const attr = mesh.geometry.attributes.aOffset, shown = attr.array, n = cnt[i];
      attr.array = this.farStage[i];
      this.farStage[i] = shown;
      mesh.geometry.instanceCount = n;
      mesh.visible = n > 0;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(4, n * 4)); // upload only the impostors in use
      attr.needsUpdate = true;
    });
    this.farEye.set(j.x, j.z);
    this.farJob = null;
    this.farAge = 0;
  }

  // Returns the first obstacle hit within radius r of (x,z), or null.
  /** The tree or rock at (x, z) within r, or null. Rocks smaller than `minRock` (size) are skied over.
   *  `trunkOnly`: trees count only by their trunk, so a skier brushes through the branches. */
  /** The tree or rock at (x, z) within r: trunkOnly true = the stem only; 'crown' = the whole tree (its branches). */
  // (performance pass, Nov 1 2026: only the cells the circle can reach (a tree's crown is at most REACH_MAX across its
  // foot), usually one, by numeric key; it was all 3 x 3 cells with string keys, several times per car sub-step)
  collide(x, z, r, minRock = 0, trunkOnly = false) {
    const R = r + REACH_MAX;
    // (a cell's trees stand on its grid points, jittered up to SPACING before its west / north edge)
    const cx0 = Math.floor((x - R) / CELL), cx1 = Math.floor((x + R + SPACING) / CELL);
    const cz0 = Math.floor((z - R) / CELL), cz1 = Math.floor((z + R + SPACING) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const cell = this.cellsN.get(cellKey(cx, cz));
      if (!cell) continue;
      for (const t of cell.trees) {
        const dx = x - t.x, dz = z - t.z, tr = trunkOnly === 'crown' ? t.crown ?? t.r : trunkOnly ? t.trunk ?? t.r : t.r;
        if (dx * dx + dz * dz < (r + tr) ** 2) return t;
      }
      for (const t of cell.rocks) {
        if (t.s < minRock) continue;
        const dx = x - t.x, dz = z - t.z;
        if (dx * dx + dz * dz < (r + t.r) ** 2) return t;
      }
    }
    return null;
  }
}
