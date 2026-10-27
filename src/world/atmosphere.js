// Snowfall (soft irregular specks, the nearest ones tumbling in 3D), valley mist and the cloud scenery:
//  - cumulus impostors: volumetric clouds ray-marched ONCE at load into a six-way-lit atlas, drawn as
//    camera-facing cards (one instanced draw). Banks wrap the lower flanks of the peaks and fill distant
//    valleys (a sea of clouds below the summits), a few orographic wisps cling to ridges, a ring of billowy
//    banks dresses the cloud sea the distant peaks stand in (world/backdrop.js), and on cloudy days cumulus
//    build above the peaks. (High cirrus wisps are painted by the sky dome, world/sky.js.)
//  - an overcast deck (bad weather): layered noise planes with a whiteout when you ride through it.
// Every cloud fades out where it meets the terrain (sampled from a small height map that follows the camera),
// so there are never hard billboard/plane intersection lines.
import * as THREE from 'three';
import { world } from './world.js';
import { hash2, smoothstep, lerp, clamp, mulberry32 } from '../core/noise.js';
import { quality } from '../engine/quality.js';

// ---------------- cloud scenery tuning ----------------
const ATLAS = 1024;                       // impostor atlas: 2 x 4 cells of 512 x 256 (two RGBA8 textures)
const CELL_MX = 16 / 512, CELL_MY = 12 / 256; // empty margin inside each cell (no mip bleeding between cells)
const TMAP_N = 128, TMAP_CELL = 300;      // terrain height map around the camera: 128 x 300 m = 38 km
const BANK_CELL = 1500, BANK_R = 16500;   // anchored clouds: placement grid + reach
const RING_CELL = 2500, RING_R = 16500;  // cloud sea around the backdrop's peaks (world/backdrop.js)
const DRIFT_CELL = 3200, DRIFT_R = 17000; // free-drifting cumulus above the peaks
const MAX_RECORDS = 900, MAX_CARDS = 420;
const RESORT = { x: 0, z: -1150, r: 2300 }; // the village + pistes stay clear of cloud banks
const K_SEA = 0, K_BANK = 1, K_WISP = 2, K_HIGH = 3, K_RING = 4;
const SUN_GAIN = 0.46;                    // lit cloud tops ~2.4 linear at noon (just under the bloom threshold)

// terrain height under a world position (toroidal map, see makeTerrainMap)
const TERRAIN_GLSL = `
  uniform sampler2D uTerrain;
  float terrainH(vec2 xz){ return texture2D(uTerrain, (xz / ${TMAP_CELL.toFixed(1)} + 0.5) / ${TMAP_N.toFixed(1)}).r; }`;

// ---------------- impostor bake (runs once on the GPU) ----------------
// Volume of one cell: x in [-1, 1], y in [0, 1] (flat base at 0), z in [-0.5, 0.5] (viewer at +z).
// Shape = union of spheres grown like a cauliflower + billowy noise erosion. For every texel we march the
// view ray and, at each sample, the light rays toward +-X, +-Y, +-Z ("six-way lighting"), so at runtime a
// card can be relit for any sun direction with two texture fetches.
const BAKE_VS = `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BAKE_FS = `
  precision highp float;
  uniform vec4 uSph[48]; uniform int uCount; uniform int uKind; uniform float uFlat; uniform float uSeed;
  uniform vec2 uOrigin; uniform vec2 uSize; uniform vec2 uMargin; uniform vec3 uBox; // x min, x max, y max
  layout(location = 0) out highp vec4 oA;   // light from +X, -X, +Y, -Y   (sqrt, premultiplied)
  layout(location = 1) out highp vec4 oB;   // light from +Z, -Z, alpha, front depth
  const float SIG = 34.0;
  vec3 hash33(vec3 p3){
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx) * 2.0 - 1.0;
  }
  float gnoise(vec3 p){
    vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dot(hash33(i), f), dot(hash33(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                   mix(dot(hash33(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(hash33(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
               mix(mix(dot(hash33(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(hash33(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                   mix(dot(hash33(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(hash33(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
  }
  // sum of |noise|: round bulges separated by creases (cauliflower detail)
  float billow(vec3 p, int oct){
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++){ if (i >= oct) break; s += a * abs(gnoise(p)); a *= 0.5; p = p * 2.03 + vec3(3.1, 0.0, 1.7); }
    return s;
  }
  float density(vec3 p, int oct){
    float d;
    if (uKind == 2){ // wisp: one long soft ellipsoid shredded by streaky noise
      float env = 1.0 - length((p - vec3(0.0, 0.36, 0.0)) / vec3(0.86, 0.2, 0.36));
      if (env < -0.9) return 0.0;
      float n = billow(vec3(p.x * 1.3 + 7.0, p.y * 11.0, p.z * 3.5) + uSeed, oct);
      d = (env * 0.9 + (n - 0.24) * 1.4) * 0.2;
    } else {
      float e = -1.0;
      for (int i = 0; i < 48; i++){
        if (i >= uCount) break;
        vec3 q = p - uSph[i].xyz; q.y /= uFlat;
        e = max(e, 1.0 - length(q) / uSph[i].w);
      }
      if (e < -0.6) return 0.0;
      d = e - 0.3 + billow(p * 5.5 + uSeed, oct) * 0.9;
    }
    // soft flat base, empty cell borders
    d *= clamp(p.y / 0.07, 0.0, 1.0);
    d *= clamp(min(min(1.0 - (abs(p.x) - 0.9) / 0.08, 1.0 - (p.y - 0.9) / 0.08), 1.0 - (abs(p.z) - 0.42) / 0.07), 0.0, 1.0);
    return clamp(d / 0.12, 0.0, 1.0);
  }
  float lightT(vec3 p, vec3 dir){
    float od = 0.0, t = 0.0, st = 0.04;
    for (int m = 0; m < 5; m++){ t += st; od += density(p + dir * t, 1) * st; st *= 1.65; }
    return max(exp(-SIG * od), 0.16 * exp(-SIG * 0.15 * od)); // + cheap multiple scattering
  }
  void main(){
    vec2 q = ((gl_FragCoord.xy - uOrigin) / uSize - uMargin) / (1.0 - 2.0 * uMargin);
    oA = vec4(0.0); oB = vec4(0.0);
    float px = q.x * 2.0 - 1.0;
    if (q.x <= 0.0 || q.x >= 1.0 || q.y <= 0.0 || q.y >= 1.0 || px < uBox.x || px > uBox.y || q.y > uBox.z) return;
    const int STEPS = 36;
    const float DZ = 1.0 / float(STEPS);
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float T = 1.0, depth = 1.0;
    vec3 sp = vec3(0.0), sn = vec3(0.0), lp = vec3(1.0), ln = vec3(1.0);
    bool relight = true;
    for (int s = 0; s < STEPS; s++){
      float z = 0.5 - (float(s) + jit) * DZ;
      vec3 p = vec3(px, q.y, z);
      float d = density(p, 4);
      if (d <= 0.0) continue;
      float a = 1.0 - exp(-SIG * d * DZ);
      // light toward the six axes; it changes slowly along the ray, so every other sample reuses it
      if (relight){
        lp = vec3(lightT(p, vec3(1,0,0)), lightT(p, vec3(0,1,0)), lightT(p, vec3(0,0,1)));
        ln = vec3(lightT(p, vec3(-1,0,0)), lightT(p, vec3(0,-1,0)), lightT(p, vec3(0,0,-1)));
      }
      relight = !relight;
      sp += T * a * lp; sn += T * a * ln;
      if (T > 0.5 && T * (1.0 - a) <= 0.5) depth = 0.5 - z;
      T *= 1.0 - a;
      if (T < 0.008) break;
    }
    float alpha = 1.0 - T;
    oA = sqrt(vec4(sp.x, sn.x, sp.y, sn.y));
    oB = sqrt(vec4(sp.z, sn.z, alpha, depth * alpha));
  }`;

// Tileable 2-channel fbm (256^2) for the overcast deck and the mist (cheaper than per-pixel noise).
const NOISE_FS = `
  precision highp float;
  uniform vec2 uRes;
  float h2(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vn(vec2 p, float per, float seed){
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    float a = h2(mod(i, per) + seed), b = h2(mod(i + vec2(1,0), per) + seed);
    float c = h2(mod(i + vec2(0,1), per) + seed), d = h2(mod(i + vec2(1,1), per) + seed);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 uv, float seed){
    float s = 0.0, a = 0.5, per = 8.0;
    for (int i = 0; i < 6; i++){ s += a * vn(uv * per, per, seed + float(i) * 17.0); per *= 2.0; a *= 0.5; }
    return s / 0.984;
  }
  void main(){
    vec2 uv = gl_FragCoord.xy / uRes;
    gl_FragColor = vec4(fbm(uv, 3.0), fbm(uv, 71.0), 0.0, 1.0);
  }`;

// ---------------- sphere clusters for the atlas cells ----------------
// Grow a cauliflower: every sphere spawns smaller ones on its upper surface.
function grow(rnd, S, levels, shrinkMin, shrinkMax, upBias) {
  let a = 0, b = S.length;
  for (let l = 0; l < levels; l++) {
    const start = S.length;
    for (let i = a; i < b; i++) {
      const [px, py, pz, pr] = S[i];
      const kids = 1 + Math.floor(rnd() * 2.4);
      for (let k = 0; k < kids; k++) {
        let dx = (rnd() - 0.5) * 2, dy = upBias + rnd() * (1 - upBias), dz = (rnd() - 0.5) * 1.6;
        const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        const r = pr * (shrinkMin + rnd() * (shrinkMax - shrinkMin)), off = pr * (0.62 + rnd() * 0.25);
        const x = px + dx * off, y = py + dy * off, z = pz + dz * off;
        if (Math.abs(x) + r > 0.94 || y + r > 0.93 || Math.abs(z) + r > 0.46) continue;
        S.push([x, y, z, r]);
      }
    }
    a = start; b = S.length;
  }
  return S;
}
// cumulus bank: a row of big puffs (bigger toward the middle) + 2-3 generations of smaller ones
function cumulus(seed, n0, rMin, rMax, spread, levels, mound, upBias) {
  const rnd = mulberry32(seed), S = [];
  for (let i = 0; i < n0; i++) {
    const x = (((i + 0.5) / n0) * 2 - 1) * spread + (rnd() - 0.5) * 0.1;
    const r = (rMin + rnd() * (rMax - rMin)) * (1 - mound * Math.min(1, (x * x) / (spread * spread)));
    S.push([x, r * 0.72, (rnd() - 0.5) * 0.16, r]);
  }
  return grow(rnd, S, levels, 0.48, 0.7, upBias);
}
// stratocumulus "sea" patch: a wide, low, lumpy layer that tiles into a continuous cloud sea
function seaPatch(seed, n0) {
  const rnd = mulberry32(seed), S = [];
  for (let i = 0; i < n0; i++) {
    const x = (((i + 0.5) / n0) * 2 - 1) * 0.78 + (rnd() - 0.5) * 0.08;
    const r = (0.15 + rnd() * 0.08) * (1 - 0.5 * Math.pow(Math.abs(x) / 0.8, 3));
    S.push([x, r * 0.5, (rnd() - 0.5) * 0.34, r]);
  }
  return grow(rnd, S, 1, 0.45, 0.62, 0.6);
}
// atlas cells: 0-4 cumulus banks/heaps, 5-6 cloud-sea patches, 7 wisp
const CELLS = [
  { S: cumulus(11, 6, 0.24, 0.34, 0.62, 2, 0.55, 0.25), kind: 0, flat: 1 },
  { S: cumulus(23, 5, 0.26, 0.36, 0.55, 2, 0.6, 0.25), kind: 0, flat: 1 },
  { S: cumulus(37, 7, 0.2, 0.3, 0.7, 2, 0.35, 0.25), kind: 0, flat: 1 },
  { S: cumulus(41, 4, 0.28, 0.36, 0.45, 3, 0.7, 0.4), kind: 0, flat: 1 },
  { S: cumulus(53, 3, 0.26, 0.32, 0.28, 3, 0.4, 0.6), kind: 0, flat: 1 },
  { S: seaPatch(61, 14), kind: 1, flat: 0.6 },
  { S: seaPatch(71, 16), kind: 1, flat: 0.6 },
  { S: [], kind: 2, flat: 1, top: 0.56, trim: 0.8 },
];
// visible cloud top of each cell as a fraction of the card height (cards are sized so tops land where wanted);
// trim: the card quad stops just above it (sea patches leave most of their cell empty: no wasted fill)
for (const c of CELLS) {
  if (c.top === undefined) c.top = Math.min(0.93, c.S.reduce((m, s) => Math.max(m, s[1] + s[3] * c.flat), 0) + 0.02);
  if (c.trim === undefined) c.trim = Math.min(1, c.top * 1.1 + 0.05);
  if (c.S.length > 48) c.S.length = 48;
}

/** The wind at the snow (m/s, x / z), set every frame by Atmosphere.update: snowfall drift, wreck steam. */
export const windUniform = { value: new THREE.Vector2(1.5, 0.6) };

export class Atmosphere {
  constructor(scene, { renderer, crystal } = {}) {
    this.scene = scene;
    this.uniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uSnow: { value: 0 },
      uWind: windUniform, // (shared: the wreck steam drifts with it, carlights.js)
      uLight: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.6, 0.65, 0.75) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFogColor: { value: new THREE.Color() },
      uMist: { value: 0.5 },
      uCloudH: { value: 620 },
      uCloudCover: { value: 0.5 },
      uDrift: { value: new THREE.Vector2() },
      uDeckAbove: { value: 1 },
      uNoise: { value: null },
      // cloud lighting (see updateCloudLight)
      uSunCol: { value: new THREE.Color() },
      uSkyCol: { value: new THREE.Color() },
      uGndCol: { value: new THREE.Color() },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    };
    this.renderer = renderer;
    this.drift = new THREE.Vector2(); // wind drift of the free clouds (m)
    this.banksDirty = true;
    this.makeTerrainMap();
    this.uniforms.uTerrain = { value: this.tmapTex };
    this.uniforms.uNoise.value = this.bakeNoise();
    this.makeSnow();
    this.makeCrystals();
    this.makeMist();
    this.makeImpostors();
    this.makeClouds();
    this.lastMist = new THREE.Vector2(1e9, 1e9);
    this.mistCache = new Map();
    this.cloudInside = 0;
    this.regional = null; // smoothed regional terrain level around the camera
    this.cloudSeaLevel = 380; // = Backdrop.cloudLevel: the sea of clouds the distant peaks stand in
    this.tmpGrey = new THREE.Color();
  }

  // The flakes closest to the camera tumble through the air in 3D: small irregular clumps of wet snow (a
  // jittered, flattened blob, unit diameter), never crystal or star shapes, which read as icons this close.
  makeCrystals() {
    const geo = new THREE.IcosahedronGeometry(0.5, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 0.78 + 0.32 * (Math.sin(x * 9.1 + y * 5.3) * 0.5 + 0.5) * (Math.cos(z * 7.7 - x * 3.1) * 0.5 + 0.5);
      p.setXYZ(i, x * k, y * k * 0.55, z * k);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.9, depthWrite: false, emissive: 0x9fb6cc, emissiveIntensity: 0.25 });
    this.crystalMax = 520;
    this.crystalMesh = new THREE.InstancedMesh(geo, mat, this.crystalMax);
    this.crystalMesh.frustumCulled = false;
    this.crystalMesh.renderOrder = 6;
    this.crystalMesh.count = 0;
    this.crystalMesh.visible = false;
    this.scene.add(this.crystalMesh);
    this.crystalData = Array.from({ length: this.crystalMax }, (_, i) => ({
      p: new THREE.Vector3(Math.random(), Math.random(), Math.random()),
      spin: new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3),
      size: 0.035 + Math.random() * 0.045, fall: 0.7 + Math.random() * 0.6, rank: i / this.crystalMax, phase: Math.random() * 6.28,
    }));
    this.tmpObj = new THREE.Object3D();
  }

  updateCrystals(camera, snow) {
    if (!this.crystalMesh) return;
    const t = this.uniforms.uTime.value, B = 7, cam = camera.position, wind = this.uniforms.uWind.value;
    const d = this.tmpObj, crystalCap = Math.min(this.crystalMax, quality.crystals);
    let n = 0;
    // no snowfall -> no crystals at all (rank 0 used to slip through at snow == 0)
    if (snow > 0.004) {
      for (const f of this.crystalData) {
        if (f.rank >= snow || n >= crystalCap) continue;
        const x = f.p.x * B + wind.x * t + Math.sin(t * 0.9 + f.phase) * 0.35;
        const y = f.p.y * B - f.fall * t;
        const z = f.p.z * B + wind.y * t + Math.cos(t * 0.7 + f.phase) * 0.35;
        d.position.set(wrapAround(x, cam.x, B), wrapAround(y, cam.y, B), wrapAround(z, cam.z, B));
        d.rotation.set(f.spin.x * t + f.phase, f.spin.y * t, f.spin.z * t);
        d.scale.setScalar(f.size);
        d.updateMatrix();
        this.crystalMesh.setMatrixAt(n++, d.matrix);
      }
    }
    this.crystalMesh.count = n;
    this.crystalMesh.visible = n > 0;
    if (n) this.crystalMesh.instanceMatrix.needsUpdate = true;
  }

  makeSnow() {
    const N = 26000;
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(N * 3), r = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      p[i * 3] = Math.random(); p[i * 3 + 1] = Math.random(); p[i * 3 + 2] = Math.random();
      r[i] = i / N;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('aRank', new THREE.BufferAttribute(r, 1));
    // (no sprite texture: every flake is drawn as an irregular soft speck in the shader)
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      vertexShader: `
        uniform float uTime; uniform vec3 uCam; uniform float uSnow; uniform vec2 uWind; uniform float uFlakeK;
        attribute float aRank; varying float vAlpha; varying float vRot; varying vec2 vTile; varying float vBlur; varying float vSmall;
        void main(){
          const float B = 46.0;
          float seed = fract(aRank * 97.13);
          float fall = 0.7 + seed * 0.7;                       // heavier flakes fall faster
          vec3 drift = vec3(uWind.x, -fall, uWind.y) * uTime;
          drift.x += sin(uTime * (0.6 + seed) + position.y * 40.0) * 0.8;   // flutter
          drift.z += cos(uTime * (0.5 + seed * 0.7) + position.x * 40.0) * 0.8;
          vec3 wp = mod(position * B + drift - uCam + B * 0.5, B) + uCam - B * 0.5;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          float size = 0.026 + seed * 0.034;                   // flake diameter, meters (big wet flakes)
          size *= 0.8 + 0.45 * uSnow;                         // heavy snow falls in bigger, wetter flakes
          gl_PointSize = clamp(size * projectionMatrix[1][1] * 1500.0 / d, 2.0, 96.0);
          vSmall = 1.0 - smoothstep(5.0, 12.0, gl_PointSize); // too few pixels for arms: draw a soft dot
          vBlur = 1.0 - smoothstep(0.25, 1.6, d);              // out-of-focus right in front of the lens
          // strictly aRank < uSnow, so nothing at all falls when uSnow == 0 (uFlakeK: the preset's share is drawn)
          vAlpha = step(aRank * uFlakeK + 1e-4, uSnow) * smoothstep(0.12, 0.5, d) * (1.0 - smoothstep(18.0, 23.0, d));
          vRot = uTime * (seed - 0.5) * 3.0 + seed * 40.0;     // tumbling
          float t = floor(seed * 4.0);
          vTile = vec2(mod(t, 2.0), floor(t / 2.0)) * 0.5;
        }`,
      fragmentShader: `
        uniform vec3 uLight; uniform vec3 uAmbient;
        varying float vAlpha; varying float vRot; varying vec2 vTile; varying float vBlur; varying float vSmall;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float cs = cos(vRot), sn = sin(vRot);
          vec2 q = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) + 0.5;
          // an irregular soft speck (a wet clump, never a star or crystal shape: up close that read as an icon),
          // its outline wobbling with the flake's own spin
          float ang = atan(q.y - 0.5, q.x - 0.5);
          float rr = length(c) * (1.0 + 0.16 * sin(ang * 3.0 + vRot) + 0.09 * sin(ang * 5.0 - vRot * 1.7));
          float shape = 1.0 - smoothstep(0.24, 0.5, rr);
          float disc = 1.0 - smoothstep(0.0, 0.5, length(c));        // soft bokeh disc for very close flakes
          float a = mix(mix(shape, disc, vSmall), disc * 0.55, vBlur) * vAlpha;
          if (a < 0.02) discard;
          vec3 col = uAmbient * 1.25 + uLight * 0.55;
          // a flake is lit on its face and shaded toward its rim: against dark trees it reads white, against the
          // bright snow and an overcast sky its greyer rim still shows it (white-on-white flakes vanished)
          col *= mix(1.08, 0.6, smoothstep(0.12, 0.48, length(c)) * (1.0 - vBlur));
          gl_FragColor = vec4(col, a * 0.95);
        }`,
    });
    this.uniforms.uFlakeK = { value: 1 };
    this.flakeMax = N;
    this.snow = new THREE.Points(geo, mat);
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 5;
    this.snow.visible = false;
    this.scene.add(this.snow);
  }

  makeMist() {
    const MAX = 500;
    const plane = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.attributes.position = plane.attributes.position;
    geo.attributes.uv = plane.attributes.uv;
    this.mistData = new Float32Array(MAX * 4);
    const attr = new THREE.InstancedBufferAttribute(this.mistData, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOffset', attr);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      vertexShader: `
        attribute vec4 aOffset; varying vec2 vUv; varying float vFade; varying float vSeed;
        uniform vec3 uCam;
        void main(){
          vUv = uv; vSeed = fract(aOffset.x*0.013 + aOffset.z*0.007);
          vec3 toCam = normalize(uCam - aOffset.xyz);
          vec3 right = normalize(cross(vec3(0,1,0), toCam));
          vec3 up = vec3(0,1,0);
          vec3 wp = aOffset.xyz + right * position.x * aOffset.w + up * position.y * aOffset.w * 0.35;
          float d = distance(uCam, aOffset.xyz);
          vFade = smoothstep(aOffset.w*0.9, aOffset.w*2.2, d) * (1.0 - smoothstep(2500.0, 3200.0, d));
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime; uniform float uMist; uniform vec3 uFogColor; uniform vec3 uLight; uniform vec3 uAmbient;
        uniform sampler2D uNoise;
        varying vec2 vUv; varying float vFade; varying float vSeed;
        void main(){
          vec2 p = vUv - 0.5;
          float r = length(p * vec2(1.0, 1.6));
          vec2 q = vUv * 0.36 + vec2(uTime * 0.0012 + vSeed * 3.0, vSeed * 5.0);
          float n = texture2D(uNoise, q).r * 0.7 + texture2D(uNoise, q * 2.7 + 0.31).g * 0.3;
          float a = (1.0 - smoothstep(0.05, 0.5, r)) * smoothstep(0.35, 0.75, n) * vFade * uMist * 0.3;
          if (a < 0.003) discard;
          vec3 col = mix(uFogColor, uAmbient + uLight * 0.5, 0.45);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mist = new THREE.Mesh(geo, mat);
    this.mist.frustumCulled = false;
    this.mist.renderOrder = 3;
    this.scene.add(this.mist);
    this.mistMax = MAX;
  }

  placeMist(px, pz) {
    const C = 220, R = 12;
    let k = 0;
    const cx0 = Math.floor(px / C), cz0 = Math.floor(pz / C);
    if (this.mistCache.size > 6000) this.mistCache.clear();
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
      if (k >= this.mistMax) break;
      if (i * i + j * j > R * R) continue;
      const cx = cx0 + i, cz = cz0 + j;
      if (hash2(cx, cz, 77) > 0.45) continue;
      // valley test is cached per cell (terrain never changes): 5 height samples once, not on every move
      const key = cx * 100003 + cz;
      let m = this.mistCache.get(key);
      if (m === undefined) {
        m = null;
        const x = (cx + hash2(cx, cz, 78)) * C, z = (cz + hash2(cx, cz, 79)) * C;
        if (Math.hypot(x, z) >= 650) { // keep the village itself clear
          const h = world.height(x, z);
          // valleys: lower than the surrounding terrain
          const around = (world.height(x + 300, z) + world.height(x - 300, z) + world.height(x, z + 300) + world.height(x, z - 300)) / 4;
          if (around - h >= 15) m = [x, h + 12 + hash2(cx, cz, 81) * 30, z, 140 + hash2(cx, cz, 80) * 200];
        }
        this.mistCache.set(key, m);
      }
      if (!m) continue;
      this.mistData[k * 4] = m[0]; this.mistData[k * 4 + 1] = m[1]; this.mistData[k * 4 + 2] = m[2]; this.mistData[k * 4 + 3] = m[3];
      k++;
    }
    this.mist.geometry.instanceCount = k;
    this.mist.geometry.attributes.aOffset.needsUpdate = true;
  }

  // ---------------- terrain height map ----------------
  // 128 x 128 cells of 300 m around the camera. World cell (I, J) lives at texel (I mod N, J mod N), so when
  // the camera moves on only the new rows/columns are sampled (a few per frame) and the GPU reads it with
  // repeat wrapping. Clouds use it to fade out softly where they meet the ground.
  makeTerrainMap() {
    const N = TMAP_N;
    this.tmap = new Float32Array(N * N);
    this.tmapKey = new Int32Array(N * N * 2).fill(-0x7fffffff);
    this.tmapHalf = new Uint16Array(N * N);
    const tex = new THREE.DataTexture(this.tmapHalf, N, N, THREE.RedFormat, THREE.HalfFloatType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.tmapTex = tex;
    this.tmapCX = -1e9; this.tmapCZ = -1e9; // window center cell
    this.tmapScan = N * N;                  // scan position (N*N = idle)
  }

  updateTerrainMap(px, pz) {
    const N = TMAP_N, ci = Math.floor(px / TMAP_CELL), cj = Math.floor(pz / TMAP_CELL);
    const moved = Math.max(Math.abs(ci - this.tmapCX), Math.abs(cj - this.tmapCZ));
    if (moved >= 8) { // re-center every 2.4 km
      this.tmapCX = ci; this.tmapCZ = cj; this.tmapScan = 0;
      if (moved >= N / 4) { this.fillTerrainMap(N * N); this.regional = null; return; } // first frame / teleport: all at once
    }
    if (this.tmapScan < N * N) this.fillTerrainMap(64, 0.2); // <= ~0.2 ms a frame while catching up
  }

  fillTerrainMap(budget, ms = Infinity) {
    const N = TMAP_N, x0 = this.tmapCX - N / 2, z0 = this.tmapCZ - N / 2, key = this.tmapKey;
    const t0 = ms < Infinity ? performance.now() : 0;
    let done = 0;
    while (this.tmapScan < N * N && done < budget) {
      if ((done & 7) === 7 && ms < Infinity && performance.now() - t0 > ms) break;
      const t = this.tmapScan++;
      const ti = t % N, tj = (t - ti) / N;
      const I = x0 + ((((ti - x0) % N) + N) % N), J = z0 + ((((tj - z0) % N) + N) % N);
      if (key[t * 2] === I && key[t * 2 + 1] === J) continue;
      const h = world.height(I * TMAP_CELL, J * TMAP_CELL, TMAP_CELL);
      this.tmap[t] = h;
      this.tmapHalf[t] = THREE.DataUtils.toHalfFloat(h);
      key[t * 2] = I; key[t * 2 + 1] = J;
      done++;
    }
    if (done) this.tmapTex.needsUpdate = true;
    if (this.tmapScan >= N * N) this.banksDirty = true; // fresh terrain data -> re-place the clouds
  }

  // bilinear terrain height from the map (NaN where the map has no data yet)
  heightAt(x, z) {
    const fx = x / TMAP_CELL, fz = z / TMAP_CELL, I = Math.floor(fx), J = Math.floor(fz), tx = fx - I, tz = fz - J;
    const a = this.tmapGet(I, J), b = this.tmapGet(I + 1, J), c = this.tmapGet(I, J + 1), d = this.tmapGet(I + 1, J + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  tmapGet(I, J) {
    const N = TMAP_N, t = (((J % N) + N) % N) * N + (((I % N) + N) % N);
    return this.tmapKey[t * 2] === I && this.tmapKey[t * 2 + 1] === J ? this.tmap[t] : NaN;
  }

  // ---------------- GPU bakes ----------------
  bakePass(fs, rt, uniforms, rects) {
    const r = this.renderer;
    const mat = new THREE.ShaderMaterial({ vertexShader: BAKE_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    if (rt.textures.length > 1) mat.glslVersion = THREE.GLSL3;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prev = r.getRenderTarget(), prevAlpha = r.getClearAlpha(), prevColor = r.getClearColor(new THREE.Color());
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setClearColor(0x000000, 0);
    rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height);
    r.setRenderTarget(rt); r.clear(true, false, false);
    for (const rc of rects) {
      rc.before?.();
      rt.viewport.set(rc.x, rc.y, rc.w, rc.h); rt.scissor.set(rc.x, rc.y, rc.w, rc.h); rt.scissorTest = true;
      r.setRenderTarget(rt);
      r.render(sc, cam);
    }
    rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height);
    r.setRenderTarget(prev);
    r.setClearColor(prevColor, prevAlpha);
    r.autoClear = prevAuto;
    quad.geometry.dispose(); mat.dispose();
  }

  bakeNoise() {
    if (!this.renderer) return null;
    const rt = new THREE.WebGLRenderTarget(256, 256, {
      depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    this.bakePass(NOISE_FS, rt, { uRes: { value: new THREE.Vector2(256, 256) } }, [{ x: 0, y: 0, w: 256, h: 256 }]);
    return rt.texture;
  }

  // Ray-march the eight cloud shapes into the six-way-lit atlas (two RGBA8 textures, mipmapped).
  bakeAtlas() {
    const rt = new THREE.WebGLRenderTarget(ATLAS, ATLAS, {
      count: 2, depthBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    const sph = Array.from({ length: 48 }, () => new THREE.Vector4());
    const u = {
      uSph: { value: sph }, uCount: { value: 0 }, uKind: { value: 0 }, uFlat: { value: 1 }, uSeed: { value: 0 },
      uOrigin: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2(ATLAS / 2, ATLAS / 4) },
      uMargin: { value: new THREE.Vector2(CELL_MX, CELL_MY) }, uBox: { value: new THREE.Vector3() },
    };
    const rects = CELLS.map((c, i) => {
      const x = (i % 2) * (ATLAS / 2), y = Math.floor(i / 2) * (ATLAS / 4);
      return {
        x, y, w: ATLAS / 2, h: ATLAS / 4,
        before: () => {
          c.S.forEach((s, k) => sph[k].set(s[0], s[1], s[2], s[3]));
          u.uCount.value = c.S.length; u.uKind.value = c.kind === 2 ? 2 : 0; u.uFlat.value = c.flat;
          u.uSeed.value = i * 7.31; u.uOrigin.value.set(x, y);
          // bounding box of the shape (+ room for the noise bulges): texels outside are left empty at once
          if (c.kind === 2) u.uBox.value.set(-0.98, 0.98, 0.82);
          else u.uBox.value.set(
            Math.max(-1, Math.min(...c.S.map((s) => s[0] - s[3] * 1.4))), Math.min(1, Math.max(...c.S.map((s) => s[0] + s[3] * 1.4))),
            Math.min(1, Math.max(...c.S.map((s) => s[1] + s[3] * c.flat * 1.4))));
        },
      };
    });
    this.bakePass(BAKE_FS, rt, u, rects);
    this.atlasRT = rt;
    return rt.textures;
  }

  // ---------------- cumulus impostors ----------------
  makeImpostors() {
    if (!this.renderer) return;
    const [ta, tb] = this.bakeAtlas();
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0); // anchored at the cloud base
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    const mk = (name) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARDS * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.cardA = mk('iA'); this.cardB = mk('iB'); this.cardC = mk('iC');
    geo.instanceCount = 0;
    const u = this.uniforms;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...u, uAtlasA: { value: ta }, uAtlasB: { value: tb },
        uMargin: { value: new THREE.Vector2(CELL_MX, CELL_MY) },
      },
      transparent: true, depthWrite: false, premultipliedAlpha: true, fog: true,
      vertexShader: `
        attribute vec4 iA; // base center xyz, mirror (+1/-1)
        attribute vec4 iB; // width, height, atlas cell, opacity
        attribute vec4 iC; // terrain-contact softness (m), storm darkening, quad trim (top of the cloud), -
        uniform vec3 uSunDir; uniform vec2 uMargin;
        varying vec2 vUv; varying vec3 vL; varying vec3 vWorld; varying float vOpacity; varying vec2 vStorm;
        #include <fog_pars_vertex>
        void main(){
          vec3 toCam = cameraPosition - iA.xyz;
          vec2 h = normalize(toCam.xz + vec2(1e-3, 0.0));
          vec3 right = vec3(h.y, 0.0, -h.x), fwd = vec3(h.x, 0.0, h.y);
          vec3 wp = iA.xyz + right * (position.x * iB.x) + vec3(0.0, position.y * iB.y * iC.z, 0.0);
          vec2 cell = vec2(mod(iB.z, 2.0), floor(iB.z / 2.0));
          vec2 q = vec2(iA.w > 0.0 ? uv.x : 1.0 - uv.x, uv.y * iC.z);
          vUv = (cell + uMargin + q * (1.0 - 2.0 * uMargin)) * vec2(0.5, 0.25);
          // sun direction in card space (x right, y up, z toward the camera); mirrored cards swap left/right
          vL = vec3(dot(uSunDir, right) * iA.w, uSunDir.y, dot(uSunDir, fwd));
          // a vertical card seen from far above/below degenerates: fade it out
          float elev = abs(toCam.y - iB.y * 0.4) / max(length(toCam), 1.0);
          vOpacity = iB.w * (1.0 - smoothstep(0.42, 0.7, elev));
          vStorm = iC.xy;
          vWorld = wp;
          vec3 transformed = wp;
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: TERRAIN_GLSL + `
        #include <fog_pars_fragment>
        uniform sampler2D uAtlasA, uAtlasB; uniform vec3 uSunCol, uSkyCol, uGndCol, uSunDir;
        varying vec2 vUv; varying vec3 vL; varying vec3 vWorld; varying float vOpacity; varying vec2 vStorm;
        void main(){
          // clamp the mip level so tiny far cards never blend in a neighbouring atlas cell
          vec2 tx = vUv * ${ATLAS.toFixed(1)};
          float lod = min(0.5 * log2(max(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 3.5);
          vec4 A = textureLod(uAtlasA, vUv, lod), B = textureLod(uAtlasB, vUv, lod);
          A *= A; B *= B;                                   // stored as sqrt for 8-bit precision
          float alpha = B.b;
          if (alpha * vOpacity < 0.004) discard;
          // six-way relighting: blend the light-from-axis maps by the squared sun direction
          vec3 w = vL * vL;
          float sun = w.x * (vL.x > 0.0 ? A.r : A.g) + w.y * (vL.y > 0.0 ? A.b : A.a) + w.z * (vL.z > 0.0 ? B.r : B.g);
          vec3 vd = normalize(vWorld - cameraPosition);
          float fwdScatter = max(dot(vd, uSunDir), 0.0);
          sun *= 1.0 + 2.6 * pow(fwdScatter, 8.0) + 0.5 * pow(fwdScatter, 2.0); // silver lining toward the sun
          float sky = 0.55 * A.b + 0.1125 * (A.r + A.g + B.r + B.g);          // sky-dome visibility
          vec3 col = uSunCol * sun * (1.0 - vStorm.y * 0.75) + uSkyCol * sky * (1.0 - vStorm.y * 0.35) + uGndCol * A.a;
          // soft contact: thin out toward the ground so cards never cut hard lines into slopes
          float contact = smoothstep(0.0, vStorm.x, vWorld.y - terrainH(vWorld.xz));
          // nearly fogged out: fade away rather than leave a flat fog-coloured silhouette on the sky
          // (main term of the scene's height fog; the full fog incl. valley haze is applied below)
          float fade = 1.0;
          #ifdef USE_FOG
            vec3 rd = vWorld - cameraPosition;
            float fx = rd.y * fogFar, fk = abs(fx) > 1e-4 ? (1.0 - exp(-fx)) / fx : 1.0;
            fade = 1.0 - smoothstep(0.62, 0.93, 1.0 - exp(-fogNear * exp(-max(cameraPosition.y, 0.0) * fogFar) * length(rd) * fk));
          #endif
          // the scene's own height fog / aerial perspective (engine/fog.js) on the straight colour,
          // then premultiply for the blend
          gl_FragColor = vec4(col / max(alpha, 1e-3), alpha * vOpacity * contact * fade);
          #include <fog_fragment>
          gl_FragColor.rgb *= gl_FragColor.a;
          gl_FragColor *= 1.0 + (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.02;
        }`,
    });
    this.cards = new THREE.Mesh(geo, mat);
    this.cards.frustumCulled = false;
    this.cards.renderOrder = 1;
    this.scene.add(this.cards);

    // CPU side: cloud records (static per placement) kept in a far-to-near order that is re-sorted every
    // frame (insertion sort on an almost sorted list: allocation free and O(n))
    this.rec = new Float32Array(MAX_RECORDS * 12);
    this.recCount = 0;
    this.recAnchored = 0;
    this.recKey = new Float32Array(MAX_RECORDS);
    this.recOrder = new Int16Array(MAX_RECORDS);
    this.bucket = new Int32Array(130);
    this.bucketTmp = new Int16Array(MAX_RECORDS);
    this.bankCache = new Map(); // grid cell -> analysed cloud record (the terrain never changes)
    this.sortTick = 0;
    this.banksAt = new THREE.Vector2(1e9, 1e9);
    this.driftAt = new THREE.Vector2(1e9, 1e9);
    this.cardAttrs = [this.cardA, this.cardB, this.cardC];
  }

  // What cloud lives in grid cell (ci, cj)? A cloud-sea patch on a valley floor, a cumulus bank leaning
  // on a flank, or an orographic wisp clinging to a ridge. Returns null while the terrain map has no data.
  // record: x, z, kind, atlas cell, mirror, width, rank, floor, height here, top of the area, seed, drifts
  analyseCell(ci, cj, x, z) {
    const hc = this.heightAt(x, z);
    if (hc !== hc) return null;
    let lo = hc, hi = hc, aLo = 0;
    const a0 = hash2(ci, cj, 503) * 6.28;
    for (let k = 0; k < 6; k++) {
      const a = a0 + k * 1.047, h = this.heightAt(x + Math.cos(a) * 1400, z + Math.sin(a) * 1400);
      if (h !== h) return null;
      if (h < lo) { lo = h; aLo = a; }
      if (h > hi) hi = h;
    }
    const rel = (hc - lo) / Math.max(60, hi - lo); // 0 valley floor .. 1 ridge top
    const r1 = hash2(ci, cj, 504), r3 = hash2(ci, cj, 506);
    let kind, cell, w, shift;
    if (rel < 0.38) { kind = K_SEA; cell = r3 < 0.42 ? 5 : r3 < 0.84 ? 6 : 2; w = 2600 + r1 * 1400; shift = 0.3; }
    else if (rel < 0.72) { kind = K_BANK; cell = Math.floor(r3 * 4.99); w = 1900 + r1 * 1300; shift = 0.62; }
    else { kind = K_WISP; cell = 7; w = 1500 + r1 * 1100; shift = 0.45; }
    // stand the card over lower ground toward the valley: it fills the valley and leans on the flank
    // instead of being swallowed by the slope it was seeded on
    const px = x + Math.cos(aLo) * 1400 * shift, pz = z + Math.sin(aLo) * 1400 * shift;
    let hp = this.heightAt(px, pz);
    if (hp !== hp) hp = hc;
    // wisps hang in front of the face, between the valley and the crest
    const y = kind === K_WISP ? lerp(hp, hc, 0.55) : lo;
    return Float32Array.of(px, pz, kind, cell, hash2(ci, cj, 508) < 0.5 ? 1 : -1, w, hash2(ci, cj, 507), y, hp, hi, r1, 0);
  }

  placeBanks(cx, cz) {
    const G = BANK_CELL, R = Math.ceil(BANK_R / G), ci0 = Math.floor(cx / G), cj0 = Math.floor(cz / G);
    const R2 = BANK_R * BANK_R, cache = this.bankCache;
    if (cache.size > 5000) cache.clear();
    let n = 0;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (n >= MAX_RECORDS - 140) break;
      const ci = ci0 + i, cj = cj0 + j, key = ci * 262144 + cj;
      let c = cache.get(key);
      if (c === undefined) {
        const x = (ci + 0.15 + 0.7 * hash2(ci, cj, 501)) * G, z = (cj + 0.15 + 0.7 * hash2(ci, cj, 502)) * G;
        if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > R2) continue;
        c = this.analyseCell(ci, cj, x, z);
        if (!c) continue; // no terrain data there yet: retried on the next placement
        cache.set(key, c);
      } else if ((c[0] - cx) * (c[0] - cx) + (c[1] - cz) * (c[1] - cz) > R2) continue;
      this.rec.set(c, n * 12);
      n++;
    }
    // the cloud sea at the backdrop's level: billowy relief on its flat sea, hiding the peaks' feet
    const RG = RING_CELL, RR = Math.ceil(RING_R / RG), ri0 = Math.floor(cx / RG), rj0 = Math.floor(cz / RG), rec = this.rec;
    for (let j = -RR; j <= RR; j++) for (let i = -RR; i <= RR; i++) {
      if (n >= MAX_RECORDS - 140) break;
      const ci = ri0 + i, cj = rj0 + j;
      const x = (ci + 0.1 + 0.8 * hash2(ci, cj, 521)) * RG, z = (cj + 0.1 + 0.8 * hash2(ci, cj, 522)) * RG;
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 > RING_R * RING_R || d2 < 5000 * 5000) continue;
      const r1 = hash2(ci, cj, 523), r3 = hash2(ci, cj, 526), o = n * 12;
      rec[o] = x; rec[o + 1] = z; rec[o + 2] = K_RING; rec[o + 3] = r3 < 0.62 ? (r3 < 0.31 ? 5 : 6) : Math.floor(r1 * 4);
      rec[o + 4] = hash2(ci, cj, 525) < 0.5 ? 1 : -1; rec[o + 5] = 3200 + r1 * 1800; rec[o + 6] = hash2(ci, cj, 524);
      rec[o + 7] = 0; rec[o + 8] = 0; rec[o + 9] = 0; rec[o + 10] = hash2(ci, cj, 527); rec[o + 11] = 0;
      n++;
    }
    this.recAnchored = n;
    this.placeDrifters(cx, cz);
  }

  // High cumulus (cloudy weather) and cirrus wisps: not tied to terrain, they drift with the wind.
  // Cells are picked around (camera - drift) so a cloud never jumps when the drift grows.
  placeDrifters(camX, camZ) {
    const cx = camX - this.drift.x, cz = camZ - this.drift.y;
    this.driftAt.set(cx, cz);
    this.recCount = this.driftLayer(this.recAnchored, cx, cz, DRIFT_CELL, DRIFT_R, K_HIGH, 600);
    this.sortRecords(camX, camZ);
  }

  driftLayer(n, cx, cz, G, Rm, kind, seed) {
    const rec = this.rec, R = Math.ceil(Rm / G), ci0 = Math.floor(cx / G), cj0 = Math.floor(cz / G);
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (n >= MAX_RECORDS) return n;
      const ci = ci0 + i, cj = cj0 + j;
      if (hash2(ci, cj, seed) > 0.7) continue;
      const x = (ci + 0.1 + 0.8 * hash2(ci, cj, seed + 1)) * G, z = (cj + 0.1 + 0.8 * hash2(ci, cj, seed + 2)) * G;
      if ((x - cx) ** 2 + (z - cz) ** 2 > Rm * Rm) continue;
      const r1 = hash2(ci, cj, seed + 3), o = n * 12;
      rec[o] = x; rec[o + 1] = z; rec[o + 2] = kind;
      rec[o + 3] = Math.floor(hash2(ci, cj, seed + 4) * 4.99);
      rec[o + 4] = hash2(ci, cj, seed + 5) < 0.5 ? 1 : -1;
      rec[o + 5] = 2200 + r1 * 1600;
      rec[o + 6] = hash2(ci, cj, seed + 6); rec[o + 7] = 0; rec[o + 8] = 0; rec[o + 9] = 0;
      rec[o + 10] = r1; rec[o + 11] = 1; // drifts with the wind
      n++;
    }
    return n;
  }

  // Fresh records: bucket sort far -> near by distance (the per-frame insertion sort keeps it exact).
  sortRecords(camX, camZ) {
    const n = this.recCount, rec = this.rec, cnt = this.bucket, tmp = this.bucketTmp;
    cnt.fill(0);
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt((rec[i * 12] - camX) ** 2 + (rec[i * 12 + 1] - camZ) ** 2);
      const b = 128 - Math.min(128, Math.floor(d / 220)); // far first
      tmp[i] = b; cnt[b + 1]++;
    }
    for (let b = 1; b < 130; b++) cnt[b] += cnt[b - 1];
    for (let i = 0; i < n; i++) this.recOrder[cnt[tmp[i]]++] = i;
    this.sortTick = 7; // exact insertion sort on the next update
  }

  // Per frame: weather -> coverage, heights and fades for every record; visible cards written far to near.
  updateImpostors(dt, camera, env) {
    if (!this.cards) return;
    const cam = camera.position;
    // slow steady drift for the free clouds
    const wa = 0.7 + Math.sin(this.uniforms.uTime.value * 0.0007) * 0.5;
    this.drift.x += Math.cos(wa) * 3.2 * dt; this.drift.y += Math.sin(wa) * 3.2 * dt;
    if (this.banksDirty || Math.hypot(cam.x - this.banksAt.x, cam.z - this.banksAt.y) > 450) {
      this.banksDirty = false;
      this.banksAt.set(cam.x, cam.z);
      this.placeBanks(cam.x, cam.z);
    } else if (Math.hypot(cam.x - this.drift.x - this.driftAt.x, cam.z - this.drift.y - this.driftAt.y) > 450) {
      this.placeDrifters(cam.x, cam.z); // the wind carried the free clouds on: refill upwind
    }

    const cl = env.cloud, sn = env.snow, mi = env.mist;
    const fogBank = Math.max(0, mi - 0.2); // real mist (not the morning haze every clear day has)
    const covSea = clamp(0.47 + cl * 0.18 + fogBank * 0.5, 0, 0.97);
    const covBank = clamp(0.24 + cl * 0.36 - fogBank * 0.3, 0, 0.9);
    const covWisp = clamp(0.2 + cl * 0.2 + fogBank * 0.4, 0, 0.8);
    const covRing = clamp(0.56 + cl * 0.2 + fogBank * 0.4, 0, 0.97);
    // cumulus above the peaks: cloudy days only, and kept far out (9 km+) so they stand on the horizon like the
    // banks in the logo art; brought close they hung overhead as flat cut-outs
    const covHigh = clamp(Math.max(0, cl - 0.2) * 0.7 - sn * 0.6, 0, 0.45);
    const highNear = 9000;
    // clear weather keeps the player's surroundings open; bad weather brings the banks in
    const nearR = lerp(lerp(4000, 2400, smoothstep(0.15, 0.7, cl)), 1800, sn);
    // the backdrop's cloud-sea level (mirrors Backdrop.update: valley baseline + level, kept below the eye)
    const bz = cam.z - 200, baseY = bz > 0 ? -0.17 * bz * smoothstep(0, 450, bz) : 0;
    const seaY = baseY + Math.min(this.cloudSeaLevel + cl * 420 + mi * 220 + sn * 200, cam.y - baseY - 260);
    const seaNear = lerp(nearR, 1400, mi);
    const lift = cl * 260 - mi * 140;                  // cloudy: higher tops, mist: hugging the floors
    const storm = clamp(sn * 0.7 + cl * 0.2, 0, 0.85); // darker, flatter clouds in bad weather
    const reg = this.regional ?? cam.y;
    // anchored banks wander slowly (~1 m/s) around their valleys; free clouds drift on with the wind
    const time = this.uniforms.uTime.value, D = this.drift;
    const ax = Math.sin(time * 0.0021) * 420, az = Math.cos(time * 0.0017) * 420;
    // height fog seen from the camera (engine/fog.js): cards that would be fully fogged are skipped
    const fog = this.scene.fog, fogB = fog ? fog.far : 0, fogK = fog ? fog.near * Math.exp(-Math.max(cam.y, 0) * fogB) : 0;
    const rec = this.rec, keyA = this.recKey, ord = this.recOrder, nRec = this.recCount;

    // keep the records ordered far -> near (the order changes slowly: refresh it every few frames)
    if ((this.sortTick = (this.sortTick + 1) & 7) === 0) {
      for (let i = 0; i < nRec; i++) {
        const o = i * 12, f = rec[o + 11] > 0;
        const x = rec[o] + (f ? D.x : ax), z = rec[o + 1] + (f ? D.y : az);
        keyA[i] = (x - cam.x) * (x - cam.x) + (z - cam.z) * (z - cam.z);
      }
      for (let i = 1; i < nRec; i++) {
        const v = ord[i], kv = keyA[v];
        let j = i - 1;
        while (j >= 0 && keyA[ord[j]] < kv) { ord[j + 1] = ord[j]; j--; }
        ord[j + 1] = v;
      }
    }

    const A = this.cardA.array, Bv = this.cardB.array, C = this.cardC.array;
    let n = 0;
    for (let k = 0; k < nRec && n < MAX_CARDS; k++) {
      const i = ord[k], o = i * 12, kind = rec[o + 2], rank = rec[o + 6], r1 = rec[o + 10];
      const cov = kind === K_SEA ? covSea : kind === K_BANK ? covBank : kind === K_WISP ? covWisp : kind === K_HIGH ? covHigh : covRing;
      let op = clamp((cov - rank) * 12, 0, 1); // more cover -> more clouds fade in, ranked
      if (op <= 0.002) continue;
      const f = rec[o + 11] > 0, x = rec[o] + (f ? D.x : ax), z = rec[o + 1] + (f ? D.y : az);
      const dist = Math.sqrt((x - cam.x) * (x - cam.x) + (z - cam.z) * (z - cam.z));
      const w = rec[o + 5], cell = rec[o + 3], lo = rec[o + 7], hp = rec[o + 8], hi = rec[o + 9];
      const topF = CELLS[cell].top;
      let base, top, soft;
      if (kind === K_SEA) { // valley fill: tops at a few hundred metres over the floor, ridges poke out
        base = hp - 70;
        top = Math.min(Math.max(hp + 260, lo + 300 + r1 * 260 + lift), Math.max(hi - 60, hp + 200));
        soft = 140;
        op *= smoothstep(nearR - 1400, nearR, dist);
      } else if (kind === K_BANK) { // cumulus leaning on a flank
        base = hp - 70;
        top = Math.min(hp + w * (0.17 + 0.09 * r1) + lift * 1.2, hi + 220);
        soft = 170;
        op *= smoothstep(nearR - 1400, nearR, dist);
      } else if (kind === K_WISP) { // thin veil in front of a face
        const y = lo + lift * 0.5;
        base = y - 0.36 * 620; top = base + topF * 620; soft = 110;
        // only at a distance: within a few km a wisp card reads as a straight white band painted on the face
        const wispNear = Math.max(nearR, 5200);
        op *= smoothstep(wispNear - 1400, wispNear + 600, dist) * 0.6;
      } else if (kind === K_RING) { // relief on the backdrop's cloud sea
        base = seaY - 150 - 90 * r1;
        top = seaY + 80 + 300 * rec[o + 10] + lift * 0.4;
        soft = 160;
        op *= smoothstep(6500, 8800, dist);
      } else { // K_HIGH: fair-weather / cloudy cumulus above the peaks
        base = reg + lerp(950, 1250, cl) + r1 * 600 - sn * 300; top = base + w * 0.32; soft = 1;
        op *= smoothstep(highNear - 1200, highNear, dist);
      }
      const reach = kind === K_HIGH ? DRIFT_R : BANK_R;
      op *= 1 - smoothstep(reach - 3500, reach - 300, dist);
      // big cards never come close (a flat card at arm's length would show) ...
      op *= smoothstep(w * 0.5, w * 0.95, dist);
      // ... and the village + pistes stay clear (the overcast deck covers them in bad weather)
      if (kind !== K_HIGH) op *= smoothstep(RESORT.r, RESORT.r + 900, Math.sqrt((x - RESORT.x) ** 2 + (z - RESORT.z) ** 2));
      if (op <= 0.002) continue;
      const H = clamp((top - base) / topF, 0.18 * w, 0.62 * w);
      // fogged out (thick snow / mist; the shader fades cards by 93% fog)? skip it (checked at its upper
      // part, the least fogged)
      const dy = base + H * 0.8 - cam.y, by = dy * fogB;
      if (fogK * Math.sqrt(dist * dist + dy * dy) * (Math.abs(by) > 1e-4 ? (1 - Math.exp(-by)) / by : 1) > 2.7) continue;
      const d = n * 4;
      A[d] = x; A[d + 1] = base; A[d + 2] = z; A[d + 3] = rec[o + 4];
      Bv[d] = w; Bv[d + 1] = H; Bv[d + 2] = cell; Bv[d + 3] = op;
      C[d] = soft; C[d + 1] = storm; C[d + 2] = CELLS[cell].trim; C[d + 3] = kind === K_RING ? 1 : 0;
      n++;
    }
    // graphics preset cap: the cards run far -> near, so the farthest (smallest, most hazed) ones give way --
    // except the ring on the distant cloud sea: it hides the line where the real terrain ends and the painted
    // ranges begin (world/backdrop.js), so the far valley banks go first
    const cap = Math.min(MAX_CARDS, quality.clouds);
    if (n > cap) {
      let drop = n - cap, w = 0;
      for (let r = 0; r < n; r++) {
        if (drop > 0 && C[r * 4 + 3] !== 1) { drop--; continue; }
        if (w !== r) { A.copyWithin(w * 4, r * 4, r * 4 + 4); Bv.copyWithin(w * 4, r * 4, r * 4 + 4); C.copyWithin(w * 4, r * 4, r * 4 + 4); }
        w++;
      }
      n = w;
    }
    if (n > cap) {
      const s0 = (n - cap) * 4;
      A.copyWithin(0, s0, n * 4); Bv.copyWithin(0, s0, n * 4); C.copyWithin(0, s0, n * 4);
      n = cap;
    }
    this.cards.geometry.instanceCount = n;
    this.cards.visible = n > 0;
    if (n) {
      for (const a of this.cardAttrs) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
    }
  }

  // Overcast deck: stacked noise layers (bad weather). Seen from above it is a sea of clouds, from below a
  // grey ceiling; riding through it gives a whiteout (cloudInside). Fades softly where it meets the slopes.
  makeClouds() {
    this.clouds = new THREE.Group();
    const geo = new THREE.PlaneGeometry(30000, 30000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uLayer: { value: i } },
        transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
        vertexShader: `varying vec3 vW;
          #include <fog_pars_vertex>
          void main(){
            vec3 transformed = position;
            vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
            vec4 mvPosition = viewMatrix * w;
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: TERRAIN_GLSL + `
          #include <fog_pars_fragment>
          uniform float uTime; uniform vec3 uCam; uniform float uCloudCover; uniform float uLayer; uniform vec2 uDrift; uniform float uDeckAbove;
          uniform vec3 uSunCol; uniform vec3 uSkyCol; uniform vec3 uGndCol; uniform vec3 uSunDir; uniform sampler2D uNoise;
          varying vec3 vW;
          void main(){
            vec2 p = (vW.xz - uDrift) * 0.000135;
            float n = texture2D(uNoise, p).r * 0.72 + texture2D(uNoise, p * 3.1 + 0.43).g * 0.28;
            float thick = 1.0 - abs(uLayer - 1.5) / 2.2;
            // seen at a grazing angle the noise compresses into hard rims: widen the edge with the angle
            float graze = 1.0 - abs(normalize(vW - cameraPosition).y);
            float a = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.22 + 0.4 * graze * graze, n * (0.78 + 0.22 * thick));
            float d = distance(vW.xz, uCam.xz);
            a *= 1.0 - smoothstep(9000.0, 14000.0, d);
            a *= smoothstep(4.0, 60.0, abs(vW.y - uCam.y)); // don't pop when flying through a layer
            a *= smoothstep(0.0, 90.0, vW.y - terrainH(vW.xz)); // hug the slopes softly
            a *= 0.46 * uDeckAbove;
            if (a < 0.004) discard;
            float top = uLayer / 3.0;
            // lit tops, blue-grey bellies (darker where the layer is thick)
            vec3 col = uSkyCol * (0.42 + 0.3 * top) + uGndCol * (1.0 - top) * 0.6
                     + uSunCol * (0.18 + 0.62 * top) * smoothstep(-0.05, 0.4, uSunDir.y) * (1.0 - 0.5 * smoothstep(0.5, 0.9, n) * (1.0 - top));
            gl_FragColor = vec4(col, a);
            #include <fog_fragment>
            gl_FragColor.rgb *= gl_FragColor.a;
          }`,
      });
      mat.premultipliedAlpha = true;
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 2;
      m.userData.offset = i * 26;
      this.clouds.add(m);
    }
    this.clouds.visible = false;
    this.scene.add(this.clouds);
  }

  // cloud lighting from the environment (sun or moon key light + sky ambient + snow bounce)
  updateCloudLight(env) {
    const u = this.uniforms, day = env.dayFactor, over = Math.max(env.snow, env.cloud * 0.85);
    u.uSunCol.value.copy(env.sun.color).multiplyScalar(env.sun.intensity * SUN_GAIN);
    // sky ambient: saturated blue on clear days (blue-grey undersides like the art), grey under overcast
    const hc = env.hemi.color, k = lerp(0.07, 1.0, day);
    u.uSkyCol.value.setRGB(hc.r * hc.r * 1.35, hc.g * hc.g * 1.45, hc.b * hc.b * 1.6).multiplyScalar(k);
    u.uSkyCol.value.lerp(this.tmpGrey.setRGB(0.95, 1.0, 1.08).multiplyScalar(k * 0.9), over * 0.7);
    u.uGndCol.value.setRGB(0.05, 0.07, 0.11).multiplyScalar(k * lerp(1, 3, over));
  }

  update(dt, camera, env) {
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(camera.position);
    u.uSnow.value = env.snow;
    this.snow.visible = env.snow > 0.002;
    const flakes = Math.min(this.flakeMax, quality.flakes); // graphics preset: fewer flakes, same spread of sizes
    this.snow.geometry.setDrawRange(0, flakes);
    this.uniforms.uFlakeK.value = this.flakeMax / flakes;
    this.updateCrystals(camera, env.snow);
    u.uSunDir.value.copy(env.lightDir);
    u.uLight.value.copy(env.sun.color).multiplyScalar(env.sun.intensity / 3.4);
    u.uAmbient.value.copy(env.hemi.color).multiplyScalar(lerp(0.12, 0.9, env.dayFactor));
    u.uFogColor.value.copy(env.fogColor);
    const wt = u.uTime.value * 0.05;
    u.uWind.value.set(1.5 + Math.sin(wt) * 2.5 * env.snow + 1, 0.6 + Math.cos(wt * 0.7) * 1.5);
    this.updateCloudLight(env);

    // terrain map + regional ground level (the overcast deck and high clouds follow the land, which keeps
    // descending forever down the Legacy Valley)
    this.updateTerrainMap(camera.position.x, camera.position.z);
    if (this.regional === null || (this.sortTick & 3) === 0) {
      let s = 0, c = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const h = this.heightAt(camera.position.x + i * 1800, camera.position.z + j * 1800);
        if (h === h) { s += h; c++; }
      }
      if (c) this.regional = this.regional === null ? s / c : lerp(this.regional, s / c, Math.min(1, dt * 1.2));
    }

    // morning mist burns off by midday; storms bring more
    const h = env.hour;
    const morning = 1 - smoothstep(9, 13, h) + smoothstep(18, 22, h) * 0.6;
    u.uMist.value = Math.min(1, 0.15 + morning * 0.45 + env.mist * 0.9);

    // overcast deck: only in real cloud; low ceiling in snow, higher when merely cloudy
    const cover = clamp(env.cloud * 0.95 + env.snow * 0.1 - 0.06 + Math.sin(u.uTime.value * 0.002) * 0.05, 0, 0.92);
    u.uCloudCover.value = cover;
    const cloudH = (this.regional ?? 0) + 400 + env.cloud * 160 - env.snow * 230 + Math.sin(u.uTime.value * 0.0015) * 60;
    u.uCloudH.value = cloudH;
    u.uDrift.value.copy(this.drift);
    this.clouds.visible = cover > 0.03;
    const lean = quality.clouds < 200; // graphics preset: the two middle layers of the deck only
    for (const m of this.clouds.children) {
      m.position.set(camera.position.x, cloudH + m.userData.offset, camera.position.z);
      m.visible = !lean || m.userData.offset === 26 || m.userData.offset === 52;
    }
    // the deck sorts after the cumulus cards when seen from below (it is in front of them) and before when above
    for (const m of this.clouds.children) m.renderOrder = camera.position.y < cloudH + 39 ? 2 : 0;
    // from above, a flat deck reads as a white sheet: let it thin out and the billowy cards take over
    u.uDeckAbove.value = 1 - 0.8 * smoothstep(cloudH + 110, cloudH + 500, camera.position.y);

    // inside the deck -> thick whiteout fog (applied by caller)
    const inside = 1 - smoothstep(15, 70, Math.abs(camera.position.y - (cloudH + 39)));
    this.cloudInside = inside * cover * THREE.MathUtils.smoothstep(env.cloud, 0.3, 0.8); // whiteout only in real cloud

    this.updateImpostors(dt, camera, env);

    if (Math.hypot(camera.position.x - this.lastMist.x, camera.position.z - this.lastMist.y) > 150) {
      this.lastMist.set(camera.position.x, camera.position.z);
      this.placeMist(camera.position.x, camera.position.z);
    }
  }
}

// wrap v into the box of size B centered on c
function wrapAround(v, c, B) { return ((((v - c + B / 2) % B) + B) % B) + c - B / 2; }
