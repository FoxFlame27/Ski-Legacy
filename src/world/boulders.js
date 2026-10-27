// Natural granite boulders, built procedurally (no scanned model): every shape variant starts as a
// subdivided icosphere that is cut by a handful of fracture planes (blended with a smooth minimum, so the
// edges come out weathered and rounded instead of sharp), roughened with 3D noise, flattened at the base
// and given a pillow of settled snow on its top faces. Two detail levels share one granite shader:
// mottled grey stone with meltwater streaks, crystal speckle, hairline cracks (bump mapped), a few lichen
// crusts, snow on the upward faces and snow banked around the foot, where the boulder meets the slope.
//
// Instances carry their own snow line: the geometry's `aGround` instanced attribute holds the terrain
// plane under each boulder (gradient x, gradient z, height at the boulder's origin), so the shader knows
// how high above the snow every pixel is and can bank snow against the foot instead of a hard seam.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/noise.js';
import { terrainUniforms } from './terrain.js';

export const BOULDER_VARIANTS = 6;
const HI_DETAIL = 12;  // icosphere subdivisions of the close-up level (~3.4k triangles)
const LO_DETAIL = 3;   // and of the distant level (320 triangles)

// ---- seeded 3D value noise (shape generation only)
function hash3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440662683) ^ Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k, seed);
  const L = (a, b, t) => a + (b - a) * t;
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), ux), L(c(0, 1, 0), c(1, 1, 0), ux), uy),
    L(L(c(0, 0, 1), c(1, 0, 1), ux), L(c(0, 1, 1), c(1, 1, 1), ux), uy), uz);
}
function fbm3(x, y, z, seed, oct) {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let o = 0; o < oct; o++) { s += a * vnoise3(x * f + o * 3.7, y * f, z * f, seed + o * 17); n += a; a *= 0.5; f *= 2.07; }
  return s / n;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The recipe of one variant: fracture planes, chips, edge softness, proportions, lumpiness.
function recipe(v) {
  const rnd = mulberry32(9157 + v * 7919);
  const dir = () => { let x, y, z, l; do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; l = Math.hypot(x, y, z); } while (l > 1 || l < 0.25); return [x / l, y / l, z / l]; };
  const planes = [];
  const n = 11 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    let [x, y, z] = dir();
    if (y < -0.25) y = -y * 0.4; // (the underside is flattened separately)
    const l = Math.hypot(x, y, z);
    planes.push([x / l, y / l, z / l, 0.52 + rnd() * 0.26]);
  }
  // most boulders get a broad, gently tilted top face: that is where the snow settles
  if (rnd() < 0.8) {
    const a = rnd() * Math.PI * 2, t = 0.1 + rnd() * 0.32, l = Math.hypot(t, 1);
    planes.push([Math.sin(a) * t / l, 1 / l, Math.cos(a) * t / l, 0.46 + rnd() * 0.2]);
  }
  // chips: shallow scoops broken out of the faces and edges
  const chips = [];
  const nc = 2 + Math.floor(rnd() * 4);
  for (let i = 0; i < nc; i++) {
    const [x, y0, z] = dir(), y = Math.abs(y0) * 0.8 + 0.1, l = Math.hypot(x, y, z); // (on the upper half)
    chips.push([x / l, y / l, z / l, 0.25 + rnd() * 0.3, 0.05 + rnd() * 0.08]);
  }
  return {
    planes, chips,
    k: 18 + rnd() * 16,                                  // smooth-min sharpness: rounded .. crisp edges
    sy: 0.72 + rnd() * 0.3, sz: 0.68 + rnd() * 0.3,      // height and depth (width = 1)
    taper: 0.08 + rnd() * 0.2,                           // wider at the foot than at the top
    lean: (rnd() - 0.5) * 0.3,                           // the top leans a little to one side
    lump: 0.035 + rnd() * 0.04,
    seed: 31 + v * 101,
  };
}

// Builds one detail level of a variant: unit width (x), base at y = 0, centred on x/z. Returns the
// geometry (position, normal, aRock = [ambient occlusion, snow cap]) and its height.
function buildBoulder(v, detail) {
  const R = recipe(v), K = R.k;
  let geo = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-5);
  const pos = geo.attributes.position, n = pos.count;
  const P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let dx = pos.getX(i), dy = pos.getY(i), dz = pos.getZ(i);
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    // the convex block left by the fracture planes, its edges and corners rounded off (smooth minimum)
    let acc = Math.exp(-K * 1.15);
    for (const [nx, ny, nz, o] of R.planes) { const dn = dx * nx + dy * ny + dz * nz; if (dn > 0.02) acc += Math.exp(-K * o / dn); }
    let r = -Math.log(acc) / K;
    // chips broken out of the faces
    for (const [cx, cy, cz, w, d] of R.chips) {
      const ang = Math.acos(Math.min(1, dx * cx + dy * cy + dz * cz));
      if (ang < w) { const t = 1 - ang / w; r -= d * t * t * (3 - 2 * t); }
    }
    // broad lumps, then fine roughness (both continuous over the sphere of directions)
    r *= 1 + R.lump * (fbm3(dx * 1.5 + 5, dy * 1.5, dz * 1.5, R.seed, 3) - 0.5) * 2;
    r += 0.016 * (fbm3(dx * 4.5, dy * 4.5, dz * 4.5, R.seed + 7, 2) - 0.5) * 2;
    const y = dy * r * R.sy, w = 1 + R.taper * (0.2 - y / R.sy);
    P[i * 3] = dx * r * w + R.lean * Math.max(0, y); P[i * 3 + 1] = y; P[i * 3 + 2] = dz * r * R.sz * w;
  }
  // flatten the underside: the boulder rests on its base instead of balancing on a curve
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i++) { ymin = Math.min(ymin, P[i * 3 + 1]); ymax = Math.max(ymax, P[i * 3 + 1]); }
  const yb = ymin + (ymax - ymin) * 0.22;
  for (let i = 0; i < n; i++) { const y = P[i * 3 + 1]; if (y < yb) P[i * 3 + 1] = yb + (y - yb) * 0.2; }
  // unit width, base at y = 0, centred
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; ymin = Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]);
    z0 = Math.min(z0, P[i * 3 + 2]); z1 = Math.max(z1, P[i * 3 + 2]);
    ymin = Math.min(ymin, P[i * 3 + 1]);
  }
  const k = 1 / (x1 - x0), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  for (let i = 0; i < n; i++) { P[i * 3] = (P[i * 3] - cx) * k; P[i * 3 + 1] = (P[i * 3 + 1] - ymin) * k; P[i * 3 + 2] = (P[i * 3 + 2] - cz) * k; }
  pos.array.set(P);
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // neighbours (for smoothing and cavities)
  const idx = geo.index.array, nb = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  const nbs = nb.map((s) => [...s]);
  const lap = (src) => { // one Laplacian smoothing step of a 3-vector field
    const out = new Float32Array(src.length);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0;
      for (const j of nbs[i]) { sx += src[j * 3]; sy += src[j * 3 + 1]; sz += src[j * 3 + 2]; }
      const m = nbs[i].length || 1;
      out[i * 3] = sx / m; out[i * 3 + 1] = sy / m; out[i * 3 + 2] = sz / m;
    }
    return out;
  };
  let height = 0;
  for (let i = 0; i < n; i++) height = Math.max(height, P[i * 3 + 1]);
  const N = geo.attributes.normal;

  // snow pillow: on faces that look at the sky (higher up more so), patchy at its edge; under the snow the
  // stone's roughness is smoothed away and the surface rises by the snow's depth
  const snow = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const patch = fbm3(x * 3.1 + 11, y * 3.1, z * 3.1, R.seed + 23, 3);
    snow[i] = smooth(0.58, 0.88, N.getY(i) + (patch - 0.5) * 0.45) * smooth(0.35, 0.7, y / height);
  }
  let S = P;
  for (let it = 0; it < 3; it++) S = lap(S);
  const depth = 0.04;
  for (let i = 0; i < n; i++) {
    const m = snow[i];
    if (m <= 0) continue;
    for (let c = 0; c < 3; c++) P[i * 3 + c] += (S[i * 3 + c] - P[i * 3 + c]) * m * 0.75;
    P[i * 3 + 1] += depth * m;
    P[i * 3] += N.getX(i) * 0.012 * m; P[i * 3 + 2] += N.getZ(i) * 0.012 * m; // slight overhang
  }
  pos.array.set(P);
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // ambient occlusion: cavities (the vertex lies below its neighbours' mean), spread over the surface,
  // plus a little less sky light low down
  const M = lap(P);
  let edge = 0;
  for (let i = 0; i < n; i++) for (const j of nbs[i]) edge += Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
  edge /= nbs.reduce((s, a) => s + a.length, 0);
  let cav = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = ((M[i * 3] - P[i * 3]) * N.getX(i) + (M[i * 3 + 1] - P[i * 3 + 1]) * N.getY(i) + (M[i * 3 + 2] - P[i * 3 + 2]) * N.getZ(i)) / edge;
    cav[i] = c;
  }
  for (let it = 0; it < 2; it++) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = cav[i]; for (const j of nbs[i]) s += cav[j]; out[i] = s / (nbs[i].length + 1); }
    cav = out;
  }
  const rock = new Float32Array(n * 2);
  height = 0;
  for (let i = 0; i < n; i++) height = Math.max(height, P[i * 3 + 1]);
  for (let i = 0; i < n; i++) {
    const ao = Math.min(1, Math.max(0.35, 1 - cav[i] * 4)) * (0.8 + 0.2 * smooth(0, 0.45, P[i * 3 + 1] / height));
    rock[i * 2] = ao;
    rock[i * 2 + 1] = snow[i];
  }
  geo.setAttribute('aRock', new THREE.BufferAttribute(rock, 2));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geometry: geo, height };
}

// ---- the granite shader (MeshStandardMaterial + onBeforeCompile)
const ROCK_COMMON = /* glsl */`
  float rkHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float rkNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(rkHash(i), rkHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(rkHash(i + vec3(0.0, 1.0, 0.0)), rkHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(rkHash(i + vec3(0.0, 0.0, 1.0)), rkHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(rkHash(i + vec3(0.0, 1.0, 1.0)), rkHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  // value noise with the lattice turned off the axes (no grid-aligned streaks)
  const mat3 RK_ROT = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60);
  float rkN(vec3 p) { return rkNoise(RK_ROT * p); }`;

let shared = null;
/**
 * The boulder kit: BOULDER_VARIANTS shapes at two detail levels plus the shared granite material.
 * Geometries are templates: clone them per InstancedMesh (`withGround` adds the per-instance snow line).
 * @returns {{ hi: THREE.BufferGeometry[], lo: THREE.BufferGeometry[], height: number[], material: THREE.Material }}
 */
export function boulderKit() {
  if (shared) return shared;
  const hi = [], lo = [], height = [];
  for (let v = 0; v < BOULDER_VARIANTS; v++) {
    const a = buildBoulder(v, HI_DETAIL), b = buildBoulder(v, LO_DETAIL);
    hi.push(a.geometry); lo.push(b.geometry); height.push(a.height);
  }
  const material = boulderMaterial();
  material.userData.shared = true; // used by the forests and the race courses: never disposed with a course
  shared = { hi, lo, height, material };
  return shared;
}

/** A copy of `geo` with room for `max` instances' snow lines (aGround: gradient x, gradient z, height). */
export function withGround(geo, max) {
  const g = geo.clone();
  const a = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aGround', a);
  return g;
}

function boulderMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.uSnowCover = terrainUniforms.uSnowCover; // fresh snow (while it snows the boulders whiten too)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aRock;
        #ifdef USE_INSTANCING
          attribute vec3 aGround;
        #endif
        varying vec3 vRkP;
        varying vec2 vRk;
        varying float vRkHG;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vRk = aRock;
          float rkS = 1.0;
          vec4 rkW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            rkS = length(instanceMatrix[0].xyz);
            rkW = instanceMatrix * rkW;
          #endif
          rkW = modelMatrix * rkW;
          vRkP = position * rkS;
          vRkHG = 10.0;
          #ifdef USE_INSTANCING
            if (aGround.x != 0.0 || aGround.y != 0.0 || aGround.z != 0.0) {
              vec3 rkI = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
              vRkHG = rkW.y - (aGround.z + aGround.x * (rkW.x - rkI.x) + aGround.y * (rkW.z - rkI.z));
            }
          #endif
        }`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        ${ROCK_COMMON}
        uniform float uSnowCover;
        varying vec3 vRkP;
        varying vec2 vRk;
        varying float vRkHG;`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 p = vRkP;
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          float px = length(fwidth(p));                       // metres per pixel here
          float fine = 1.0 - smoothstep(0.004, 0.02, px);     // crystal grain only up close
          float mid = 1.0 - smoothstep(0.02, 0.12, px);       // cracks to mid range
          // domain-warped coordinates: veins and patches that wander instead of value-noise blobs
          vec3 q = p + (vec3(rkN(p * 0.9), rkN(p * 0.9 + 17.0), rkN(p * 0.9 + 33.0)) - 0.5) * 0.7;
          float n1 = rkN(q * 0.6 + 3.1), n2 = rkN(q * 2.2 + 11.7), n3 = rkN(p * 7.0 + 5.3);
          float tone = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;
          // weathered granite: dark grey, bleached lighter where it faces the sky, darker under overhangs
          vec3 stone = mix(vec3(0.04, 0.043, 0.05), vec3(0.2, 0.198, 0.192), smoothstep(0.32, 0.7, tone));
          stone *= mix(0.74, 1.12, smoothstep(-0.6, 0.8, wn.y));
          // iron stains
          stone *= mix(vec3(1.0), vec3(1.14, 0.98, 0.8), smoothstep(0.6, 0.85, rkN(q * 0.4 + 40.0)) * 0.7);
          // meltwater streaks down the steep faces
          float st = rkN(vec3(q.x * 4.0, p.y * 0.3, q.z * 4.0) + 21.0);
          stone *= 1.0 - 0.42 * smoothstep(0.55, 0.85, st) * smoothstep(0.85, 0.25, abs(wn.y));
          // fine crystal grain (fades out before it could shimmer)
          float sp = rkN(p * 70.0);
          stone *= 1.0 + fine * 0.3 * (sp - 0.5) * 2.0;
          // a few cracks, irregular and of varying width, only in places
          float cn = rkN(q * 1.1 + 5.0);
          float cw = 0.006 + 0.016 * rkN(p * 3.0 + 9.0);
          float crack = (1.0 - smoothstep(cw * 0.3, cw + px * 0.7, abs(cn - 0.5))) * smoothstep(0.45, 0.65, rkN(p * 0.7 + 50.0)) * mid;
          stone *= 1.0 - 0.65 * crack;
          // lichen: pale grey-green crusts on the faces open to the sky
          float li = rkN(q * 1.8 + 70.0) * 0.65 + n3 * 0.35;
          stone = mix(stone, vec3(0.19, 0.2, 0.16), smoothstep(0.66, 0.72, li) * 0.45 * smoothstep(-0.1, 0.5, wn.y));
          // damp, darker stone just above the snow line
          stone *= mix(0.6, 1.0, smoothstep(0.0, 0.35, vRkHG));
          // bump (metres): lumps, grain and the cracks' grooves
          float hgt = rkN(q * 1.1) * 0.07 + n2 * 0.03 + n3 * 0.01 * mid - crack * 0.015 + sp * 0.002 * fine;
          vec3 rkPos = -vViewPosition;
          vec3 dpx = dFdx(rkPos), dpy = dFdy(rkPos);
          vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
          float det = dot(dpx, r1);
          vec3 grad = sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2);
          vec3 bumped = abs(det) > 1e-14 ? normalize(abs(det) * normal - grad) : normal;
          // snow: the settled pillow on top, dusting on ledges, a drift banked against the foot (its line
          // wanders up and down around the boulder)
          float sn = rkN(p * 3.0 + 9.0) * 0.6 + rkN(p * 9.0) * 0.4;
          float cap = smoothstep(0.46, 0.53, vRk.y + (sn - 0.5) * 0.5 + uSnowCover * 0.25);
          float dust = smoothstep(0.8 - uSnowCover * 0.32, 0.87 - uSnowCover * 0.3, wn.y + (sn - 0.5) * 0.3) * 0.9;
          float driftH = 0.03 + 0.2 * rkN(vec3(p.x, 0.0, p.z) * 1.7 + 3.0) * rkN(vec3(p.x, 0.0, p.z) * 0.6 + 8.0) * 2.0;
          float drift = 1.0 - smoothstep(driftH - 0.012, driftH + 0.012, vRkHG + (sn - 0.5) * 0.06);
          float snowA = clamp(max(max(cap, dust), drift), 0.0, 1.0);
          diffuseColor.rgb = mix(stone, vec3(0.84, 0.87, 0.92), snowA);
          roughnessFactor = mix(0.92, 0.75, snowA);
          // snow is smooth, and the drift's surface slopes away from the stone
          vec3 vUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          normal = normalize(mix(mix(bumped, normal, snowA), vUp, drift * 0.55));
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // sunlight bounced off the snowfield onto the faces that look down and sideways (what keeps a
        // boulder's shadow side grey instead of a black hole in a sunny snowfield)
        #if NUM_DIR_LIGHTS > 0
        {
          vec3 rkUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float rkSunUp = max(dot(directionalLights[0].direction, rkUp), 0.0);
          float rkDown = 0.5 - 0.5 * dot(normal, rkUp);
          reflectedLight.indirectDiffuse += directionalLights[0].color * (0.8 * rkSunUp * rkDown) * BRDF_Lambert(material.diffuseColor);
        }
        #endif
        reflectedLight.indirectDiffuse *= vRk.x;
        reflectedLight.indirectSpecular *= vRk.x;
        reflectedLight.directDiffuse *= mix(1.0, vRk.x, 0.45);`);
  };
  mat.customProgramCacheKey = () => 'boulder-granite-8';
  return mat;
}
