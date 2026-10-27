// Snow-park features built on the terrain: kickers (jumps), rollers and tabletops.
// Each feature is a mesh plus a walkable surface (world.addSurface) so physics rides over it,
// launches off the lip and lands on whatever is below.
//
// The look of a machine-shaped park feature: a groomed top with fine corduroy along the line of travel,
// shoulders rounded off into steep shovel-cut side walls that run out in a soft toe on the slope, a crisp
// lip with a blue dye line sprayed across it (tabletops also mark the knuckle), and a kicker's steep back
// wall behind the lip. Shaded snow takes the same cold sky tint as the terrain, so the walls in shade read
// as the slope's own blue snow instead of bright plastic.
import * as THREE from 'three';
import { world } from './world.js';

// Shaped snow: a fine wind-packed grain (normal map) so features read as solid snow, not smooth plastic or
// glass; double-sided so no wall is ever see-through from the wrong side.
function snowGrain() {
  if (typeof document === 'undefined') return null;
  const N = 256, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N);
  // tileable value noise (two octaves) -> height -> normals
  const hgt = new Float32Array(N * N), rnd = (x, y, s) => { const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); };
  const oct = (cell, s, amp) => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gx = (x / cell) | 0, gy = (y / cell) | 0, fx = (x % cell) / cell, fy = (y % cell) / cell, m = N / cell;
      const a = rnd(gx % m, gy % m, s), b = rnd((gx + 1) % m, gy % m, s), cc = rnd(gx % m, (gy + 1) % m, s), d = rnd((gx + 1) % m, (gy + 1) % m, s);
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      hgt[y * N + x] += amp * (a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy);
    }
  };
  oct(32, 1, 1); oct(8, 2, 0.45); oct(4, 3, 0.2);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = hgt[y * N + (x + 1) % N] - hgt[y * N + (x + N - 1) % N], dy = hgt[((y + 1) % N) * N + x] - hgt[((y + N - 1) % N) * N + x];
    const nx = -dx * 2.2, ny = -dy * 2.2, l = Math.hypot(nx, ny, 1), i = (y * N + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

// The shared snow material. Per vertex: colour (tint x baked occlusion), uv = metres (across, along) / 2 for
// the grain, aRamp = (groomed top 0..1, metres to the lip, metres to the knuckle).
function shapedSnow() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, normalMap: snowGrain(), normalScale: new THREE.Vector2(0.4, 0.4) });
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aRamp;
        varying vec3 vRamp;
        varying vec2 vRampM;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRamp = aRamp;
        vRampM = uv * 2.0;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRamp;
        varying vec2 vRampM;
        float rpHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float rpNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(rpHash(i), rpHash(i + vec2(1.0, 0.0)), f.x), mix(rpHash(i + vec2(0.0, 1.0)), rpHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float top = vRamp.x;
          // shovel-cut walls: the grain shows stronger on the sides than on the groomed top
          normal = normalize(mix(nonPerturbedNormal, normal, mix(1.5, 0.8, top)));
          // corduroy along the line of travel (band-limited: gone before it could shimmer)
          float across = vRampM.x;
          float fw = fwidth(across) / 0.12;
          float cordK = (1.0 - smoothstep(0.15, 0.35, fw)) * top;
          // riders' tracks: a few soft grooves that wander along the feature (mostly through the middle)
          float trkK = (1.0 - smoothstep(0.025, 0.06, fwidth(across))) * top * smoothstep(0.0, 3.0, vRampM.y);
          float trk = 0.0;
          if (trkK > 0.0) {
            for (int i = 0; i < 6; i++) {
              float fi = float(i);
              float c = (rpHash(vec2(fi, 3.1)) - 0.5) * 2.6 + 0.35 * sin(vRampM.y * (0.21 + 0.05 * fi) + fi * 1.7);
              trk = max(trk, 1.0 - smoothstep(0.03, 0.075, abs(across - c)));
            }
          }
          // bump (metres), its derivatives taken in uniform control flow
          float hgt = cos(across * 52.36) * 0.0018 * cordK * (1.0 - trk) - trk * 0.012 * trkK;
          vec3 rpPos = -vViewPosition;
          vec3 dpx = dFdx(rpPos), dpy = dFdy(rpPos);
          vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
          float det = dot(dpx, r1);
          vec3 grad = sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2);
          if (abs(det) > 1e-14) normal = normalize(abs(det) * normal - grad);
          // dye lines sprayed across the lip (and a tabletop's knuckle): fuzzy-edged, a little patchy
          float fz = rpNoise(vRampM * vec2(9.0, 23.0)) - 0.5;
          float dLip = vRamp.y + 0.2 + fz * 0.05, dKn = vRamp.z - 0.22 + fz * 0.05;
          float dye = max(1.0 - smoothstep(0.12, 0.16, abs(dLip)), 1.0 - smoothstep(0.12, 0.16, abs(dKn)));
          dye *= smoothstep(0.15, 0.5, top) * (0.8 + 0.2 * rpNoise(vRampM * 31.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.006, 0.07, 0.55), dye);
          roughnessFactor = mix(roughnessFactor, 0.9, dye);
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // the terrain's cold sky light (terrain.js): shaded walls read as the slope's own blue snow
          float sunK = 0.0;
          #if NUM_DIR_LIGHTS > 0
            sunK = smoothstep(0.4, 2.8, dot(directionalLights[0].color, vec3(0.3333)));
          #endif
          reflectedLight.indirectDiffuse *= mix(vec3(0.9, 0.96, 1.05), vec3(0.66, 0.8, 0.98), sunK);
        }`);
  };
  mat.customProgramCacheKey = () => 'park-snow-5';
  return mat;
}
const SNOW = shapedSnow();
// Only the faces turned away from the sun cast: the feature is one sheet over the slope, so its shadow keeps the
// right outline, while the sunlit walls (which meet the light at a grazing angle) never shadow themselves (acne).
SNOW.shadowSide = THREE.BackSide;

// Height profile along the feature, u in [0, L] from the base (in the travel direction).
function profile(type, u, p) {
  if (type === 'kicker') {
    // circular transition: flat at the base, `lip` degrees steep at the end
    const th = (u / p.length) * p.lip;
    return p.R * (1 - Math.cos(th));
  }
  if (type === 'roller') {
    const t = u / p.length;
    return p.height * Math.sin(Math.PI * t) ** 2;
  }
  // tabletop: kicker up, flat deck, smooth knuckle down to the landing
  const up = p.upLen, deck = p.deckLen, down = p.length - up - deck;
  if (u < up) return p.R * (1 - Math.cos((u / up) * p.lip));
  if (u < up + deck) return p.height;
  const t = (u - up - deck) / down;
  return p.height * (1 - t * t * (3 - 2 * t));
}

// Side walls: rounded shoulder, steep wall, soft toe (1 at the top edge, 0 where it meets the slope).
// (1 - t)^3 (1 + 3t): a short rounded shoulder, the wall steepest a third of the way out, a long concave toe
const sideCurve = (t) => { t = Math.min(1, Math.max(0, t)); return (1 - t) ** 3 * (1 + 3 * t); };

/**
 * Build a park feature.
 * @param {object} o
 * @param {number} o.x, o.z      base center (start of the ramp)
 * @param {number} o.heading     travel direction (radians, 0 = +Z)
 * @param {'kicker'|'roller'|'tabletop'} [o.type='kicker']
 * @param {number} [o.height=1.6] lip height above the terrain (m)
 * @param {number} [o.lip=28]     takeoff angle at the lip relative to the terrain (degrees)
 * @param {number} [o.width=5]
 * @param {number} [o.length]     roller/tabletop length (kickers derive it from height + lip)
 * @param {boolean} [o.shaped=false] wide shaped side walls that run out on the slope (free-standing park
 *                                features); otherwise the sides stay within 0.6 m (course ramps fill the track)
 * @param {boolean} [o.register=true] add the walkable surface to the world
 * @returns {{ mesh: THREE.Mesh, surface: object, lip: THREE.Vector3, takeoffDir: THREE.Vector3, params: object }}
 */
export function makeRamp(o) {
  const type = o.type || 'kicker';
  const height = o.height ?? 1.6, width = o.width ?? 5;
  const lip = THREE.MathUtils.degToRad(o.lip ?? 28);
  const p = { height, lip, width };
  if (type === 'kicker') {
    p.R = height / (1 - Math.cos(lip));
    p.length = p.R * Math.sin(lip);
  } else if (type === 'roller') {
    p.length = o.length ?? height * 9;
  } else {
    p.R = height / (1 - Math.cos(lip));
    p.upLen = p.R * Math.sin(lip);
    p.deckLen = o.deckLength ?? 6;
    p.length = o.length ?? p.upLen + p.deckLen + height * 5;
  }
  const fx = Math.sin(o.heading), fz = Math.cos(o.heading); // along travel
  const rx = fz, rz = -fx;                                  // to the right of travel
  const toLocal = (x, z) => {
    const dx = x - o.x, dz = z - o.z;
    return [dx * fx + dz * fz, dx * rx + dz * rz]; // [u along, v across]
  };
  const L = p.length, hw = width / 2;
  // side wall width at a local feature height h (the walls of a free-standing feature are ~50 deg)
  const sideW = o.shaped ? (h) => 0.5 + 1.0 * h : () => 0.6;
  const maxSide = sideW(height);
  const surface = {
    bounds: (() => {
      const pts = [[0, -hw - maxSide], [0, hw + maxSide], [L, -hw - maxSide], [L, hw + maxSide]].map(([u, v]) => [o.x + fx * u + rx * v, o.z + fz * u + rz * v]);
      return { minx: Math.min(...pts.map((q) => q[0])), maxx: Math.max(...pts.map((q) => q[0])), minz: Math.min(...pts.map((q) => q[1])), maxz: Math.max(...pts.map((q) => q[1])) };
    })(),
    height(x, z) {
      const [u, v] = toLocal(x, z);
      if (u < 0 || u > L) return null;
      let h = profile(type, u, p);
      const av = Math.abs(v);
      if (av > hw) {
        const sw = sideW(h);
        if (av > hw + sw) return null;
        h *= sideCurve((av - hw) / sw); // side wall
      }
      return world.height(x, z) + h;
    },
    feature: type,
  };
  if (o.register !== false) world.addSurface(surface);

  // ---- mesh: rows along the feature (a kicker continues past its lip down its back wall), each row a
  // cross-section: side wall, groomed top, side wall; every vertex follows the terrain underneath
  const lipU = type === 'kicker' ? L : type === 'tabletop' ? p.upLen : 1e4;
  const kneeU = type === 'tabletop' ? p.upLen + p.deckLen : 1e4;
  const rows = [];
  const NU = Math.max(12, Math.ceil(L / 0.4));
  for (let i = 0; i <= NU; i++) { const u = (i / NU) * L; rows.push([u, profile(type, u, p), 1]); }
  if (type === 'kicker') {
    const back = Math.max(0.5, height * 0.6), NB = 6;
    for (let k = 1; k <= NB; k++) { const t = k / NB; rows.push([L + back * t, height * Math.pow(1 - t, 1.4), 0]); }
  }
  const NT = Math.max(4, Math.ceil(width / 0.75)), NS = 7; // top segments, side segments
  const cols = []; // [lateral 0..1 within the side (negative = left), or null for the top] per column
  for (let k = NS; k >= 1; k--) cols.push(-k / NS);
  for (let k = 0; k <= NT; k++) cols.push({ top: k / NT });
  for (let k = 1; k <= NS; k++) cols.push(k / NS);
  const W = cols.length;
  const pos = [], col = [], uvs = [], ramp = [], idx = [];
  const topC = new THREE.Color(0.87, 0.895, 0.93), wallC = new THREE.Color(0.82, 0.85, 0.89), c = new THREE.Color();
  for (const [u, h, onTop] of rows) {
    const sw = sideW(h);
    for (const cc of cols) {
      let v, hh, top, ao = 1;
      if (typeof cc === 'object') { v = -hw + cc.top * width; hh = h; top = onTop; }
      else {
        const t = Math.abs(cc);
        v = Math.sign(cc) * (hw + t * sw);
        hh = h * sideCurve(t);
        top = onTop * (1 - Math.min(1, t * 5)); // the corduroy runs over the shoulder, not down the wall
        ao = 1 - 0.1 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.5) / 0.5))) * Math.min(1, h); // crease at the toe
        // the shoulder: snow packed hard and polished by riders, a touch greyer than the groomed top
        ao *= 1 - 0.06 * Math.max(0, 1 - Math.abs(t - 0.12) / 0.12) * Math.min(1, h * 2);
      }
      const x = o.x + fx * u + rx * v, z = o.z + fz * u + rz * v;
      pos.push(x, world.height(x, z) + hh + 0.02, z);
      c.copy(wallC).lerp(topC, top).multiplyScalar(ao);
      col.push(c.r, c.g, c.b);
      uvs.push(v * 0.5, u * 0.5);
      ramp.push(top, u - lipU, u - kneeU);
    }
  }
  for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < W - 1; j++) {
    const a = i * W + j, b = a + 1, cI = a + W, d = cI + 1;
    idx.push(a, b, cI, b, d, cI);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aRamp', new THREE.Float32BufferAttribute(ramp, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, SNOW);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.surface = surface;
  const lx = o.x + fx * (type === 'tabletop' ? p.upLen : L), lz = o.z + fz * (type === 'tabletop' ? p.upLen : L);
  const lipPos = new THREE.Vector3(lx, world.height(lx, lz) + p.height, lz);
  const takeoffDir = new THREE.Vector3(fx * Math.cos(lip), Math.sin(lip), fz * Math.cos(lip)).normalize();
  return { mesh, surface, lip: lipPos, takeoffDir, params: { type, ...p, heading: o.heading } };
}

// Remove a feature built with makeRamp (mesh from its parent + surface from the world).
export function disposeRamp(r) {
  world.removeSurface(r.surface);
  r.mesh.parent?.remove(r.mesh);
  r.mesh.geometry.dispose();
}
