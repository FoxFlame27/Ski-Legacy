// The Legacy Express's scenery: frozen lakes in the valleys under its viaducts, placed where the train's windows look
// down on them (the ride's big views). Two halves, like expressground.js:
//   - planExpressScenery(courses): pure layout (no THREE, runs in Node). main.js calls it once in the boot, after
//     the World Racing courses are registered and BEFORE buildExpressGround: the lakes' basins are part of the ground
//     the line's profile is fitted on (a pier stands on the ice, never in mid-air over a basin dug after the fit).
//     Each lake: its ice level (fitted on the ground: the inside cut down, at most a low snowy moraine on its low
//     side), the basin carved in (world.addCut: flat ice, a snowy bank easing back into the slopes, no trees on the
//     ice or its beach, a few clumps of pines round the shore), small pads under the ice (no boulders on it) and
//     layout.expressLakes for the trail map.
//   - buildExpressScenery(scene): the meshes (the ice sheets), after the terrain shaping is final.
// The spots were picked offline (a search along the whole ring: flat basins 100-700 m off the line, outside the
// courses' regions, clear of the courses, lifts, pistes, roads, the Wolkenspitzbahn and the secrets, scored by how
// big and how long they show from the open line and the viaducts, looking down on them); the levels and shores are
// fitted here on the ground as it is. A lake whose spot no longer suits (a course or lift moved onto it) is skipped.
//
// layout.expressLakes = [{ id, name, x, z, r (mean radius, m), a, b (semi-axes), rot (major axis heading, rad from +x
//                          toward +z), level (ice), outline: [[x, z]...] (every 10 deg, closed by the first) }]
import * as THREE from 'three';
import { world } from './world.js';
import { layout } from './layout.js';
import { smoothstep, clamp, Simplex } from '../core/noise.js';
import { terrainUniforms } from './terrain.js';

// x, z centre; a, b semi-axes (m); rot: the major axis's heading (x = cos, z = sin); seed: the shoreline's wobble.
// `s`: where on the ring the train passes it (arc length, for reference; the view is from the viaduct there).
export const EXPRESS_LAKES = [
  { id: 'spiegelsee', name: 'Spiegelsee', x: -744, z: 2167, a: 125, b: 78, rot: 2.09, seed: 11, s: 66800 },  // under the great viaduct by the village
  { id: 'schwarzsee', name: 'Schwarzsee', x: 1866, z: 4897, a: 230, b: 95, rot: 2.09, seed: 23, s: 5640 },
  { id: 'silbersee', name: 'Silbersee', x: 5526, z: 6847, a: 300, b: 180, rot: 2.09, seed: 37, s: 11200 },
  { id: 'eissee', name: 'Eissee', x: 6186, z: -7913, a: 230, b: 138, rot: 0, seed: 41, s: 30040 },
  { id: 'kristallsee', name: 'Kristallsee', x: -6324, z: -4853, a: 300, b: 180, rot: 2.62, seed: 53, s: 45280 },
];

const BEACH = 7;       // m of flat snow round the ice before the bank rises (no trees)
const FADE0 = 70, FADE1 = 115; // the bank eases back into the natural slopes between these (m from the shore)
const ICE_IN = 0.6;    // the ice sheet stops this far inside the shoreline
const N = new Simplex(4421);

// ------------------------------------------------------------------ the lake's shape
function frame(L) {
  if (L.c !== undefined) return L;
  L.c = Math.cos(L.rot); L.s = Math.sin(L.rot);
  // the shoreline's wobble (fraction of the ellipse's radius): a few harmonics, seeded per lake (bays, headlands)
  let q = L.seed * 7919;
  const rnd = () => { q = (q * 16807) % 2147483647; return q / 2147483647; };
  L.wob = [[2, 0.06], [3, 0.055], [4, 0.04], [6, 0.025], [9, 0.014]].map(([k, amp]) => [k, amp * (0.6 + 0.8 * rnd()), rnd() * 6.283]);
  L.R = Math.max(L.a, L.b) * 1.2 + FADE1; // reach of the shaping
  L.bounds = { minx: L.x - L.R, maxx: L.x + L.R, minz: L.z - L.R, maxz: L.z + L.R };
  return L;
}
/** Signed distance (m, approximate: < 0 on the ice) from (x, z) to lake L's shoreline. */
export function lakeSdf(L, x, z) {
  const dx = x - L.x, dz = z - L.z;
  const u = dx * L.c + dz * L.s, v = -dx * L.s + dz * L.c;
  const th = Math.atan2(v / L.b, u / L.a), rho = Math.hypot(u / L.a, v / L.b);
  let w = 1;
  for (const [k, amp, ph] of L.wob) w += amp * Math.sin(k * th + ph);
  const r = Math.hypot(L.a * Math.cos(th), L.b * Math.sin(th)) * w; // the shore's distance from the centre this way
  return (rho / w - 1) * r;
}
// a point at parameter angle th and fraction f of the way to the shore
function lakePoint(L, th, f) {
  let w = 1;
  for (const [k, amp, ph] of L.wob) w += amp * Math.sin(k * th + ph);
  const u = Math.cos(th) * L.a * w * f, v = Math.sin(th) * L.b * w * f;
  return [L.x + u * L.c - v * L.s, L.z + u * L.s + v * L.c];
}

// ------------------------------------------------------------------ layout
// the nearest shore from a point on the ice (along 32 rays)
function shoreDist(L, x, z) {
  let best = Infinity;
  for (let k = 0; k < 32; k++) {
    const dx = Math.cos((k / 32) * 6.2832), dz = Math.sin((k / 32) * 6.2832);
    let lo = 0, hi = best === Infinity ? Math.max(L.a, L.b) * 1.5 : best;
    if (lakeSdf(L, x + dx * hi, z + dz * hi) < 0) continue;
    for (let it = 0; it < 20; it++) { const m = (lo + hi) / 2; if (lakeSdf(L, x + dx * m, z + dz * m) < 0) lo = m; else hi = m; }
    best = Math.min(best, lo);
  }
  return best === Infinity ? 0 : best;
}
// The ice level: the inside cut down to it, the shore never far below it (a moraine of at most ~3 m on the low side):
// the cheapest among the low shore heights.
function fitLevel(L) {
  const inner = [], shore = [];
  for (const f of [0, 0.3, 0.55, 0.8]) for (let k = 0; k < (f ? 24 : 1); k++) inner.push(world.height(...lakePoint(L, (k / 24) * 6.2832, f)));
  for (let k = 0; k < 48; k++) shore.push(world.height(...lakePoint(L, (k / 48) * 6.2832, 1)));
  const sorted = shore.slice().sort((p, q) => p - q);
  let best = null;
  for (let i = 0; i < 16; i++) {
    const lv = sorted[i];
    let cut = 0, cutMax = 0, dam = 0;
    for (const h of inner) { const c = Math.max(0, h - lv); cut += c; cutMax = Math.max(cutMax, c); }
    for (const h of shore) dam = Math.max(dam, lv - h);
    cut /= inner.length;
    const cost = cut + cutMax * 0.15 + dam * 0.6;
    if (!best || cost < best.cost) best = { lv, cost, cut, cutMax, dam };
  }
  L.fit = best;
  return best.lv - 0.2;
}

// would the lake (its ice + beach, `pad` m) touch a race course's line, a lift, the village or a course's region?
function blocked(L, courses) {
  const near = (x, z, pad = 60) => lakeSdf(L, x, z) < pad;
  if (Math.hypot(L.x, L.z) < 700 + Math.max(L.a, L.b)) return 'village';
  for (const r of world.regions) {
    const b = r.bounds;
    for (let k = 0; k < 48; k++) { const [x, z] = lakePoint(L, (k / 48) * 6.2832, 1.05); if (x > b.minx && x < b.maxx && z > b.minz && z < b.maxz) return 'region ' + r.id; }
  }
  for (const e of courses) {
    const T = e.course?.track;
    if (!T) continue;
    for (let i = 0; i < T.n; i += 4) if (Math.abs(T.X[i] - L.x) < L.R + 200 && Math.abs(T.Z[i] - L.z) < L.R + 200 && near(T.X[i], T.Z[i], 150)) return 'course ' + e.id;
  }
  for (const l of layout.lifts) {
    const len = Math.hypot(l.top.x - l.bottom.x, l.top.z - l.bottom.z);
    for (let t = 0; t <= len; t += 10) { const x = l.bottom.x + ((l.top.x - l.bottom.x) * t) / len, z = l.bottom.z + ((l.top.z - l.bottom.z) * t) / len; if (near(x, z)) return 'lift ' + l.name; }
  }
  return null;
}

const lakes = [];
/** Shape the lakes into the ground (once, before buildExpressGround and before any terrain is built). */
export function planExpressScenery(courses = []) {
  if (lakes.length) return layout.expressLakes;
  for (const def of EXPRESS_LAKES) {
    const L = frame({ ...def });
    const why = blocked(L, courses);
    if (why) { console.warn(`Legacy Express scenery: ${L.name} skipped (${why})`); continue; }
    L.level = fitLevel(L);
    // the bank: steeper and gentler stretches round the shore
    const bankK = (x, z) => 0.3 + 0.28 * (N.noise(x * 0.012 + L.seed, z * 0.012) * 0.5 + 0.5);
    world.addCut({
      bounds: L.bounds,
      apply: (x, z, h) => {
        const d = lakeSdf(L, x, z);
        if (d >= FADE1) return h;
        if (d <= 0) return L.level;
        // a flat beach, then the bank (cut into the slope above it), or a low snowy moraine where the ground falls away
        const e = Math.max(0, d - BEACH);
        const top = L.level + 0.25 * smoothstep(0, BEACH, d) + e * bankK(x, z);
        const bot = L.level + 0.25 * smoothstep(0, BEACH, d) - e * 0.22;
        const g = h > top ? top : h < bot ? bot : h;
        return g + (h - g) * smoothstep(FADE0, FADE1, d);
      },
      // no trees on the ice or its beach; a few clumps of pines along the shore (below the treeline)
      forest: (x, z, f) => {
        const d = lakeSdf(L, x, z);
        if (d < BEACH + 3) return 0;
        f *= smoothstep(BEACH + 3, BEACH + 14, d);
        if (d > 95 || L.level > 380) return f;
        const clump = smoothstep(0.15, 0.55, N.noise(x * 0.018 - L.seed, z * 0.018 + 3.1));
        return Math.max(f, 0.55 * clump * smoothstep(BEACH + 8, BEACH + 22, d) * (1 - smoothstep(55, 95, d)));
      },
    });
    // pads under the ice: no boulders on it (vegetation skips pads), circles strung along the major axis, each well
    // inside the shore (the flattened ground there is already at the ice level: they change nothing else)
    const nP = Math.max(1, Math.round(L.a / L.b) * 2 + 1);
    for (let i = 0; i < nP; i++) {
      const t = nP === 1 ? 0 : -0.7 + (1.4 * i) / (nP - 1), x = L.x + L.c * L.a * t, z = L.z + L.s * L.a * t;
      const r = shoreDist(L, x, z) - 8;
      if (r > 8) world.addPad({ x, z, r, blend: 2, h: L.level });
    }
    lakes.push(L);
  }
  layout.expressLakes = lakes.map((L) => {
    const outline = [];
    for (let k = 0; k < 36; k++) outline.push(lakePoint(L, (k / 36) * 6.2832, 1).map((v) => Math.round(v)));
    return { id: L.id, name: L.name, x: L.x, z: L.z, r: Math.round(Math.sqrt(L.a * L.b)), a: L.a, b: L.b, rot: L.rot, level: Math.round(L.level * 10) / 10, outline };
  });
  return layout.expressLakes;
}

// ------------------------------------------------------------------ meshes
/** The ice sheets (and later props). Returns the group; nothing to update per frame. */
export function buildExpressScenery(scene) {
  const group = new THREE.Group();
  group.name = 'express-scenery';
  if (!lakes.length) return group;
  const mat = iceMaterial();
  for (const L of lakes) group.add(iceSheet(L, mat));
  scene.add(group);
  return group;
}

// a radial fan from the centre to just inside the shoreline (found along each ray), rings packed toward the shore
function iceSheet(L, mat) {
  const NA = 192, NR = 16, y = L.level + 0.035;
  const P = [L.x, y, L.z], E = [0], I = [];
  const reach = Math.max(L.a, L.b) * 1.5;
  for (let k = 0; k < NA; k++) {
    const an = (k / NA) * Math.PI * 2, dx = Math.cos(an), dz = Math.sin(an);
    let lo = 0, hi = reach;
    for (let it = 0; it < 28; it++) { const m = (lo + hi) / 2; if (lakeSdf(L, L.x + dx * m, L.z + dz * m) < -ICE_IN) lo = m; else hi = m; }
    for (let r = 1; r <= NR; r++) {
      const t = Math.pow(r / NR, 0.7);
      P.push(L.x + dx * lo * t, y, L.z + dz * lo * t);
      E.push(t);
    }
  }
  const ring = (k, r) => 1 + (k % NA) * NR + (r - 1);
  // (counter-clockwise seen from above: a increases from +x toward +z, so (centre, k + 1, k) faces up)
  for (let k = 0; k < NA; k++) {
    I.push(0, ring(k + 1, 1), ring(k, 1));
    for (let r = 1; r < NR; r++) I.push(ring(k, r), ring(k + 1, r), ring(k, r + 1), ring(k, r + 1), ring(k + 1, r), ring(k + 1, r + 1));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(P.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(E, 1));
  geo.setIndex(I);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ice-' + L.id;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}

// Lake ice seen from the train (100-700 m off, from above): black-blue clear ice swept free by the wind in long
// fields, snow lying in drifts streaked along the wind and banked against the shore, white pressure cracks big
// enough to read from the viaducts (finer cracks, frost and bubbles close up). The sky's reflection comes from the
// scene's environment (so it follows the time of day: a dark mirror at night), its sun glint from the sun. Fresh
// snow (terrainUniforms.uSnowCover) whitens it while it snows.
function iceMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0, envMapIntensity: 1.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = terrainUniforms.uNoise;
    s.uniforms.uSnowCover = terrainUniforms.uSnowCover;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aEdge;\nvarying float vEdge;\nvarying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvEdge = aEdge;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D uNoise;
      uniform float uSnowCover;
      varying float vEdge;
      varying vec3 vWP;
      float iRough;
      vec4 iN(vec2 p) { return texture2D(uNoise, p * 0.125); }
      vec2 iHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
      // distance to the nearest Voronoi cell border (a crack network)
      float iCracks(vec2 p) {
        vec2 n = floor(p), f = fract(p);
        vec2 mg, mr; float md = 8.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j)); vec2 o = iHash(n + g); vec2 r = g + o - f; float d = dot(r, r);
          if (d < md) { md = d; mr = r; mg = g; }
        }
        md = 8.0;
        for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
          vec2 g = mg + vec2(float(i), float(j)); vec2 o = iHash(n + g); vec2 r = g + o - f;
          if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
        }
        return md;
      }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 V = normalize(cameraPosition - vWP);
        float dist = length(cameraPosition - vWP);
        vec2 p = vWP.xz;
        // the wind's frame: drifts streak along it
        vec2 q = vec2(dot(p, vec2(0.83, 0.56)), dot(p, vec2(-0.56, 0.83)));
        float n1 = iN(p * 0.05).r, n2 = iN(p * 0.006 + 3.0).a, n3 = iN(p * 0.3).r;
        // clear black-blue ice, lighter (thinner, milky) in places
        vec3 deep = vec3(0.018, 0.05, 0.08), clear = vec3(0.06, 0.16, 0.23), milky = vec3(0.3, 0.44, 0.55), frost = vec3(0.72, 0.82, 0.9);
        vec3 c = mix(deep, clear, smoothstep(0.3, 0.75, n2));
        c = mix(c, milky, smoothstep(0.6, 0.85, iN(p * 0.017 - 5.0).r) * 0.55);
        float frostK = smoothstep(0.58, 0.8, n1 * 0.6 + n2 * 0.45) * 0.6;
        // pressure cracks (~35 m cells): white ridges that still read from the viaducts
        float crB = iCracks(p / 34.0 + (iN(p * 0.004).gb - 0.5) * 0.8);
        float wB = fwidth(crB);
        float crackBig = (1.0 - smoothstep(0.0, 0.012 + wB * 1.2, crB)) * (1.0 - smoothstep(0.03, 0.12, wB));
        // fine cracks (~9 m cells) on the surface + a fainter copy deeper in the ice (parallax), close up
        float fade = 1.0 - smoothstep(60.0, 260.0, dist);
        float crack = 0.0, crackDeep = 0.0, bub = 0.0;
        if (fade > 0.0) {
          vec2 cp = p * 0.11;
          float cr = iCracks(cp + (iN(p * 0.02).gb - 0.5) * 0.6);
          crack = (1.0 - smoothstep(0.0, 0.035 + fwidth(cr) * 1.5, cr)) * fade;
          vec2 par = V.xz / max(V.y, 0.25) * 0.09;
          float cr2 = iCracks(cp * 1.7 + 7.3 - par);
          crackDeep = (1.0 - smoothstep(0.0, 0.05 + fwidth(cr2) * 1.5, cr2)) * fade * 0.55;
          vec2 bc = floor(p * 3.0); vec2 bh = iHash(bc);
          bub = step(0.93, bh.x) * (1.0 - smoothstep(0.05, 0.12, length(fract(p * 3.0) - bh))) * (1.0 - smoothstep(8.0, 30.0, dist));
        }
        c = mix(c, frost * 0.9, crackDeep);
        c = mix(c, frost, frostK);
        c = mix(c, vec3(0.9, 0.95, 1.0), clamp(crack * 0.85 + bub * 0.6 + crackBig * 0.75, 0.0, 1.0));
        // snow: long drifts streaked along the wind, the fields between swept clear; banked up against the shore
        float streak = iN(q * vec2(0.0035, 0.016) + 11.0).a * 0.75 + iN(q * vec2(0.01, 0.05) - 4.0).r * 0.35;
        float drift = smoothstep(0.62, 0.78, streak + uSnowCover * 0.4);
        drift = max(drift, smoothstep(0.8, 0.97, vEdge + (n3 - 0.5) * 0.18 + (iN(p * 0.02 + 7.0).r - 0.5) * 0.25));
        drift = clamp(drift + uSnowCover * 0.35, 0.0, 1.0);
        // thin powder dusting at the drifts' edges (the ice shows through)
        float dust = smoothstep(0.5, 0.66, streak) * (1.0 - drift) * 0.45;
        c = mix(c, vec3(0.8, 0.86, 0.93), dust);
        c = mix(c, vec3(0.93, 0.95, 0.99), drift);
        diffuseColor.rgb = c;
        iRough = mix(0.035, 0.28, frostK) + crack * 0.2 + crackBig * 0.25 + dust * 0.35;
        iRough = mix(iRough, 0.82, drift);
      }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = iRough;');
  };
  m.customProgramCacheKey = () => 'express-lake-ice';
  return m;
}
