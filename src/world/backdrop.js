// "The thing behind": a ring of dramatic alpine ranges on the horizon in every direction, like the peaks
// behind the skier in the Ski Legacy logo. Three depth layers (~11, ~15 and ~21 km) of faceted Matterhorn-
// like pyramids, serrated ridgelines and spires, standing in a sea of clouds that hides their bases.
//
// How it lives with the real world:
// - The ring is anchored to the camera (x/z) every frame, like the sky dome, so it is always on the horizon
//   of the endless world. Its heights are absolute (they follow the Legacy Valley's descent), so it sinks
//   as you climb: from the village the heroes rise ~6-7 deg, from the summit 3-4 deg over a sea of clouds.
// - The real terrain always reaches 16-33 km (3x3 quadtree roots of 16 km) and the far plane is 32 km, so
//   the peaks cannot stand "beyond" the terrain with ordinary depth testing. They are drawn at the far
//   plane instead (z = w, like the sky) in the transparent queue, right after the stars and moon: the
//   depth test only passes where nothing has been drawn yet (the sky), so every bit of real terrain,
//   forest and village covers them, while they hide the moon/stars and clouds, mist and snow drawn later
//   stay in front. Early-z also throws away all the pixels behind the terrain before shading.
// - With no depth buffer of their own the peaks are painted back to front: the three layer meshes draw
//   far -> near, and inside each mesh the index buffer runs from the outermost ring of quads inward. Seen
//   from the ring's axis - where the camera always is - that order is exact for a heightfield.
// - The cloud sea is part of the same heightfield (max(mountain, cloud level)), evaluated in the vertex
//   shader so it can rise with the weather. It always stays below the eye, an inner skirt closes the ring
//   and the outermost row rises to eye level and fades out, so the sky never shows through below the
//   horizon from any altitude.
import * as THREE from 'three';
import { Simplex, mulberry32, smoothstep, lerp } from '../core/noise.js';
import { BACKDROP_HAZE } from '../engine/fog.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const FLOOR = -700; // mountain height outside the ranges (always under the cloud sea)

const N1 = new Simplex(9071);
const N2 = new Simplex(9173);
const N3 = new Simplex(9277);

// Depth layers, drawn far -> near. rows = ring radii of the vertex rows (m), dense across the ranges and
// sparse over the cloud sea; band = where mountains may stand; seg = vertices around the ring.
const LAYERS = [
  {
    name: 'far', order: -7.6, seg: 1792, seed: 11,
    rows: [17800, 18600, 19200, 19600, 20000, 20400, 20800, 21200, 21600, 22000, 22400, 22800, 23300, 23900, 24700,
      26200, 29000, 34000],
    band: [18900, 24700],
    ridge: { h: [950, 1650], scale: 3400 },
    peaks: { count: 62, r: [19800, 23500], h: [950, 2050], base: [1500, 2700] },
    rim: true, // outermost row climbs to eye level and fades into the sky
  },
  {
    name: 'mid', order: -7.4, seg: 1344, seed: 23,
    rows: [12700, 13500, 14000, 14400, 14800, 15200, 15600, 16000, 16400, 16800, 17300, 17900, 18700],
    band: [13700, 17700],
    ridge: { h: [700, 1250], scale: 2600 },
    peaks: { count: 56, r: [14300, 17000], h: [720, 1550], base: [1050, 1850] },
  },
  {
    name: 'near', order: -7.2, seg: 1024, seed: 37,
    rows: [3000, 4600, 6200, 7600, 8600, 9300, 9800, 10200, 10600, 11000, 11400, 11800, 12200, 12700, 13500],
    band: [9200, 12900],
    ridge: { h: [450, 850], scale: 2000 },
    peaks: { count: 46, r: [9900, 12200], h: [600, 1250], base: [800, 1350] },
    skirt: true, // inner wall dropping far below the eye: closes the ring
  },
];

// Hand-placed hero pyramids. az = degrees from -Z toward +X (the sun crosses 270 -> 180 -> 90 over the
// day, so the southern half is where the light is); r must be one of the layer's row radii so the apex
// lands exactly on a vertex. faces = [direction relative to the view (180 = facing the viewer), reach (m)]:
// like the Matterhorn, an arete points at the viewer between two steep faces, so a low sun from either
// side splits the peak into a sunlit and a shadowed face. spires = [az offset (deg), r offset (m), height
// fraction] of the secondary summits either side.
// Sizes give a clear hierarchy like the art (angular heights from mid-mountain, eye ~600 m): the Horn ~11 deg,
// the other far heroes ~7-8 deg, the mid needles ~6 deg, the crowd of lesser peaks 2-4 deg.
const HEROES = [
  // the Horn: dominates the view down the Legacy Valley from the village, the slopes and the summit; a massif
  // with shoulders and lesser summits either side, like the peak in the logo
  // (its two front faces turn well to the sides, so the morning sun lights the right one and the afternoon sun
  // the left one while the other stays in deep blue shade: the art's split lighting from the skiing direction)
  { layer: 'far', az: 186, r: 22400, h: 4950, faces: [[118, 2900], [242, 3150], [318, 4050], [42, 3900]], gamma: 1.75,
    spires: [[-6.4, -500, 0.6], [5.6, 400, 0.52], [10.4, -300, 0.4], [-11, 300, 0.38], [-3.2, 600, 0.74]] },
  // golden-hour side (the evening sun sets past it)
  { layer: 'far', az: 113, r: 21200, h: 3400, faces: [[130, 2150], [235, 2500], [0, 3100]], gamma: 1.7,
    spires: [[-4.8, 200, 0.6], [5.6, -300, 0.5]] },
  // morning side
  { layer: 'far', az: 241, r: 22000, h: 3500, faces: [[135, 2250], [222, 2250], [320, 3200], [50, 3000]], gamma: 1.75,
    spires: [[5.4, -300, 0.58], [-6.2, 400, 0.46]] },
  { layer: 'far', az: 24, r: 21600, h: 3450, faces: [[145, 2150], [230, 2500], [0, 3200]], gamma: 1.8,
    spires: [[-5.4, 200, 0.6], [4.8, -200, 0.52]] },
  { layer: 'far', az: 303, r: 20800, h: 3150, faces: [[140, 2150], [228, 2400], [320, 3100], [45, 2900]], gamma: 1.7,
    spires: [[5.4, 300, 0.54]] },
  { layer: 'far', az: 66, r: 22400, h: 3050, faces: [[150, 2250], [240, 2750], [10, 3000]], gamma: 1.65,
    spires: [[-4.4, 0, 0.58]] },
  // mid-layer needles flanking the Horn
  { layer: 'mid', az: 160, r: 15200, h: 2250, faces: [[140, 1450], [225, 1550], [0, 2100]], gamma: 1.85,
    spires: [[-6, 200, 0.56], [5, -200, 0.5]] },
  { layer: 'mid', az: 214, r: 15600, h: 2180, faces: [[135, 1500], [228, 1450], [320, 2100], [40, 2000]], gamma: 1.8,
    spires: [[6, 0, 0.55]] },
  { layer: 'mid', az: 345, r: 15200, h: 2100, faces: [[140, 1450], [230, 1550], [0, 2100]], gamma: 1.8, spires: [] },
  // sharp needles in the near range
  { layer: 'near', az: 141, r: 11400, h: 1500, faces: [[135, 1000], [230, 1050], [0, 1400]], gamma: 1.95,
    spires: [[-7, 100, 0.6]] },
  { layer: 'near', az: 232, r: 11000, h: 1400, faces: [[140, 950], [225, 1000], [0, 1350]], gamma: 1.9, spires: [] },
];

// Low-frequency domain warp (~5 km features, -1..1): ridgelines wander like real ones instead of
// following the noise lattice.
const warpX = (x, z) => N2.fbm(x * 0.00021, z * 0.00021, 2);
const warpZ = (x, z) => N2.fbm(x * 0.00021 + 19.3, z * 0.00021 - 7.7, 2);

// polynomial smooth maximum (k = blend width, m)
function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

// A faceted pyramid: apex (x, z, h); each face has an outward direction and a reach (base radius).
// Height = h * (1 - D)^gamma with D = max over faces of the projected distance / reach: planar faces
// meeting in sharp aretes, concave so the summit is steepest - the Matterhorn silhouette.
function makePeak(x, z, h, faces, gamma) {
  const f = new Float32Array(faces.length * 2);
  let reach = 0;
  faces.forEach(([dirDeg, rch], i) => {
    const a = dirDeg * DEG; // direction in the ring frame (same convention as az)
    f[i * 2] = Math.sin(a) / rch;
    f[i * 2 + 1] = -Math.cos(a) / rch;
    reach = Math.max(reach, rch);
  });
  const R = reach * 2.2; // corners between faces reach further than the faces themselves
  // domain warp at the apex: the aretes bend with the warp around it, the summit itself stays put
  return { x, z, h, gamma, f, R, R2: R * R, qx: warpX(x, z), qz: warpZ(x, z) };
}

function peakHeight(P, dx, dz) {
  const f = P.f;
  let D = 0;
  for (let k = 0; k < f.length; k += 2) D = Math.max(D, dx * f[k] + dz * f[k + 1]);
  return D < 1 ? P.h * Math.pow(1 - D, P.gamma) : 0;
}

const polar = (azDeg, r) => [Math.sin(azDeg * DEG) * r, -Math.cos(azDeg * DEG) * r];

// Peaks of one layer: the heroes (+ their secondary spires) and a procedural crowd along the ring.
function layerPeaks(L) {
  const rng = mulberry32(L.seed * 7919);
  const peaks = [];
  const step = 360 / L.seg;
  for (const H of HEROES) {
    if (H.layer !== L.name) continue;
    const az = Math.round(H.az / step) * step; // apex exactly on a vertex column
    const [x, z] = polar(az, H.r);
    peaks.push(makePeak(x, z, H.h, H.faces.map(([d, r]) => [d + az, r]), H.gamma));
    // secondary spires either side: [azimuth offset (deg), radial offset (m), height fraction]
    for (const [da, dr, hf] of H.spires) {
      const [sx, sz] = polar(az + da, H.r + dr);
      const rot = rng() * 360, n = rng() < 0.5 ? 3 : 4;
      const faces = Array.from({ length: n }, (_, k) => [rot + (k * 360) / n + (rng() - 0.5) * 30, H.faces[0][1] * (0.45 + rng() * 0.3)]);
      peaks.push(makePeak(sx, sz, H.h * hf, faces, H.gamma + 0.1));
    }
  }
  const P = L.peaks;
  const inBand = L.rows.filter((r) => r >= P.r[0] && r <= P.r[1]);
  for (let i = 0; i < P.count; i++) {
    // apex exactly on a vertex (row radius + column): coarse rows would otherwise shave the summits off
    const az = Math.round((((i + 0.15 + rng() * 0.7) / P.count) * 360) / step) * step;
    const r = inBand[Math.floor(rng() * inBand.length)];
    // height varies slowly around the ring (high massifs and lower cols), plus per-peak spread
    const massif = 0.5 + 0.5 * N3.noise(Math.cos(az * DEG) * 1.7 + L.seed, Math.sin(az * DEG) * 1.7 - L.seed);
    let h = lerp(P.h[0], P.h[1], Math.min(1, massif * 0.7 + rng() * rng() * 0.6));
    let base = lerp(P.base[0], P.base[1], rng()) * (0.75 + 0.35 * (h - P.h[0]) / (P.h[1] - P.h[0]));
    let gamma = 1.55 + rng() * 0.45;
    const rot = rng() * 360, kind = rng();
    let faces;
    if (kind < 0.3) {
      // long ridge with a summit: two steep flanks, two long aretes running off along the crest
      faces = [[rot, base * 0.55], [rot + 90 + (rng() - 0.5) * 20, base * 1.6], [rot + 180 + (rng() - 0.5) * 16, base * 0.6],
        [rot + 270 + (rng() - 0.5) * 20, base * 1.4]];
      gamma = 1.6 + rng() * 0.3;
    } else if (kind < 0.5) {
      // needle: tall, narrow, very concave
      h *= 0.9; base *= 0.62; gamma = 2.0 + rng() * 0.4;
      faces = Array.from({ length: 3 }, (_, k) => [rot + k * 120 + (rng() - 0.5) * 30, base * (0.8 + rng() * 0.4)]);
    } else {
      const n = rng() < 0.55 ? 3 : 4;
      faces = Array.from({ length: n }, (_, k) => [rot + (k * 360) / n + (rng() - 0.5) * 34, base * (0.7 + rng() * 0.6)]);
    }
    const [x, z] = polar(az, r);
    peaks.push(makePeak(x, z, h, faces, gamma));
  }
  // azimuth buckets (2 deg) so each vertex only tests the peaks that can reach it
  const B = 180, buckets = Array.from({ length: B }, () => []);
  for (const p of peaks) {
    const r = Math.hypot(p.x, p.z), a = Math.atan2(p.x, -p.z);
    const half = Math.asin(Math.min(1, p.R / r)) + TAU / B;
    const b0 = Math.floor(((a - half) / TAU) * B), b1 = Math.floor(((a + half) / TAU) * B);
    for (let b = b0; b <= b1; b++) buckets[((b % B) + B) % B].push(p);
  }
  return { peaks, buckets, B };
}

// Crest height of the connecting ranges for azimuth az (rad): high massifs and lower cols around the ring.
const crestHeight = (L, az) => lerp(L.ridge.h[0], L.ridge.h[1], 0.5 + 0.5 * N3.noise(Math.cos(az) * 2.3 + L.seed * 0.1, Math.sin(az) * 2.3));

// Mountain height (m, before the cloud sea) of one layer at ring-frame position (x, z); crest = crestHeight
// for this azimuth (precomputed per column).
function mountainHeight(L, field, x, z, crest) {
  const r = Math.hypot(x, z);
  const [b0, b1] = L.band;
  const env = smoothstep(b0 - 300, b0 + 800, r) * (1 - smoothstep(b1 - 800, b1 + 300, r));
  if (env <= 0) return FLOOR;
  const qx = warpX(x, z), qz = warpZ(x, z);
  const wx = x + qx * 1000, wz = z + qz * 1000;
  // connecting ranges: ridged multifractal crests (4 octaves: finer ones fall between the 400 m rows)
  const s = 1 / L.ridge.scale, az = Math.atan2(x, -z);
  const rid = N1.ridged(wx * s + L.seed, wz * s - L.seed, 4, 2.1, 0.5);
  let h = crest * Math.pow(rid, 1.3);
  // pyramids, warped relative to their apex: the aretes bend, the summit stays on its vertex
  const bucket = field.buckets[((Math.floor((az / TAU) * field.B) % field.B) + field.B) % field.B];
  for (let i = 0; i < bucket.length; i++) {
    const P = bucket[i], dx = x - P.x + (qx - P.qx) * 340, dz = z - P.z + (qz - P.qz) * 340;
    if (dx * dx + dz * dz > P.R2) continue;
    const ph = peakHeight(P, dx, dz);
    if (ph > 0) h = smax(h, ph, 170);
  }
  // serrations: fine ridged teeth along the crests and upper faces
  if (h > 300) {
    const ser = N3.ridged(wx * 0.0036, wz * 0.0036, 3, 2.2, 0.6);
    h += (ser * ser - 0.25) * 300 * smoothstep(300, 1500, h);
  }
  return lerp(FLOOR, h, env);
}

// Relief of the cloud-sea surface (m): broad swells and banks (the billows are shaded in the fragment shader).
function cloudRelief(x, z) {
  return N2.fbm(x / 5200 + 3.1, z / 5200, 2) * 190 + N3.noise(x / 1500, z / 1500 + 7.3) * 60;
}

// Tileable noise texture for the surface detail: R = fbm, GB = its gradient, A = an independent fbm.
function makeNoiseTexture() {
  const S = 256, U = 8, OCT = 4;
  const rnd = mulberry32(4242);
  // value-noise fbm of one lattice set into out[] (smoothstep-interpolated, tileable)
  const fbmInto = (out) => {
    let norm = 0;
    for (let o = 0, amp = 0.5; o < OCT; o++, amp *= 0.5) {
      const n = U << o, g = new Float32Array(n * n), cell = S / n;
      for (let i = 0; i < g.length; i++) g[i] = rnd();
      for (let j = 0; j < S; j++) {
        const fy = j / cell, yi = Math.floor(fy), ty = fy - yi, uy = ty * ty * (3 - 2 * ty);
        const r0 = yi * n, r1 = ((yi + 1) % n) * n;
        for (let i = 0; i < S; i++) {
          const fx = i / cell, xi = Math.floor(fx), tx = fx - xi, ux = tx * tx * (3 - 2 * tx), x1 = (xi + 1) % n;
          const a = g[r0 + xi], b = g[r0 + x1], c = g[r1 + xi], d = g[r1 + x1];
          out[j * S + i] += amp * (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy);
        }
      }
      norm += amp;
    }
    for (let i = 0; i < out.length; i++) out[i] /= norm;
  };
  const A = new Float32Array(S * S), B = new Float32Array(S * S), data = new Uint8Array(S * S * 4);
  fbmInto(A);
  fbmInto(B);
  const k = S / U; // texels per noise unit
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const dx = (A[j * S + ((i + 1) % S)] - A[j * S + ((i - 1 + S) % S)]) * k * 0.5;
    const dy = (A[((j + 1) % S) * S + i] - A[((j - 1 + S) % S) * S + i]) * k * 0.5;
    const o = (j * S + i) * 4;
    // stretch the fbm's narrow value range so the shader gets full contrast
    data[o] = Math.round(Math.min(1, Math.max(0, (A[j * S + i] - 0.5) * 1.9 + 0.5)) * 255);
    data[o + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + dx / 5)) * 255);
    data[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + dy / 5)) * 255);
    data[o + 3] = Math.round(B[j * S + i] * 255);
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// One layer as an indexed polar grid. Index order = painter's order (outer rows first).
function buildLayer(L) {
  const field = layerPeaks(L);
  const A = L.seg, rows = L.rows, R = rows.length;
  const nGrid = A * R, nV = nGrid + (L.skirt ? A : 0);
  const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), aux = new Float32Array(nV * 2);
  const H = new Float32Array(nGrid), cloud = new Float32Array(nGrid);
  const sinT = new Float32Array(A), cosT = new Float32Array(A), crest = new Float32Array(A);
  for (let j = 0; j < A; j++) {
    sinT[j] = Math.sin((j / A) * TAU); cosT[j] = Math.cos((j / A) * TAU);
    crest[j] = crestHeight(L, Math.atan2(sinT[j], cosT[j]));
  }
  for (let i = 0; i < R; i++) {
    const r = rows[i];
    for (let j = 0; j < A; j++) {
      const k = i * A + j, x = sinT[j] * r, z = -cosT[j] * r;
      H[k] = mountainHeight(L, field, x, z, crest[j]);
      cloud[k] = cloudRelief(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = H[k]; pos[k * 3 + 2] = z;
      aux[k * 2] = cloud[k];
      aux[k * 2 + 1] = L.rim && i === R - 1 ? 2 : 0;
    }
  }
  // normals from the grid (central differences: azimuth neighbours ~40-70 m apart, rows 400 m)
  const t = new THREE.Vector3(), q = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < R; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(R - 1, i + 1);
    for (let j = 0; j < A; j++) {
      const k = i * A + j, jl = i * A + ((j - 1 + A) % A), jr = i * A + ((j + 1) % A);
      const kd = i0 * A + j, ku = i1 * A + j;
      t.set(pos[jr * 3] - pos[jl * 3], H[jr] - H[jl], pos[jr * 3 + 2] - pos[jl * 3 + 2]);
      q.set(pos[ku * 3] - pos[kd * 3], H[ku] - H[kd], pos[ku * 3 + 2] - pos[kd * 3 + 2]);
      n.crossVectors(t, q).normalize();
      nor[k * 3] = n.x; nor[k * 3 + 1] = n.y; nor[k * 3 + 2] = n.z;
    }
  }
  // inner skirt: a wall from the first row down to far below the eye (vertex shader places the foot)
  if (L.skirt) {
    for (let j = 0; j < A; j++) {
      const k = nGrid + j;
      pos[k * 3] = pos[j * 3]; pos[k * 3 + 1] = FLOOR; pos[k * 3 + 2] = pos[j * 3 + 2];
      nor[k * 3 + 1] = 1;
      aux[k * 2] = cloud[j]; aux[k * 2 + 1] = 1;
    }
  }
  const idx = new (nV > 65535 ? Uint32Array : Uint16Array)(((R - 1) + (L.skirt ? 1 : 0)) * A * 6);
  let o = 0;
  for (let i = R - 2; i >= 0; i--) {
    for (let j = 0; j < A; j++) {
      const j1 = (j + 1) % A;
      const a = i * A + j, b = i * A + j1, c = (i + 1) * A + j, d = (i + 1) * A + j1;
      idx[o++] = a; idx[o++] = b; idx[o++] = c; // counter-clockwise seen from above / from the ring's axis
      idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
  }
  if (L.skirt) {
    for (let j = 0; j < A; j++) {
      const j1 = (j + 1) % A, s0 = nGrid + j, s1 = nGrid + j1;
      idx[o++] = j; idx[o++] = s0; idx[o++] = j1; // faces inward, drawn last (nearest)
      idx[o++] = j1; idx[o++] = s0; idx[o++] = s1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aAux', new THREE.BufferAttribute(aux, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rows[R - 1] + 4000);
  return { geo, H, cloud, rows, seg: A };
}

const VERT = /* glsl */ `
  attribute vec2 aAux;      // x: cloud-sea relief (m); y: 0 surface, 1 inner skirt foot, 2 horizon rim
  uniform float uCamY;      // camera height in the ring frame
  uniform float uCloudTop;  // cloud-sea level in the ring frame (always below the eye)
  varying vec3 vPos;
  varying vec3 vNrm;
  varying float vCloud;
  varying vec2 vEdge;
  void main() {
    float cloudY = uCloudTop + aAux.x;
    float y = max(position.y, cloudY);
    vEdge = vec2(0.0);
    if (aAux.y > 1.5) { y = max(cloudY, uCamY - 1.0); vEdge.y = 1.0; }   // rim: up to the horizon line
    else if (aAux.y > 0.5) { y = min(cloudY, uCamY) - 8000.0; vEdge.x = 1.0; } // skirt foot
    vPos = vec3(position.x, y, position.z);
    vNrm = normal;
    vCloud = cloudY - position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos, 1.0);
    gl_Position.z = gl_Position.w; // far plane: anything real drawn earlier covers it
  }`;

const FRAG = /* glsl */ `
  uniform sampler2D uNoise;
  uniform vec3 uLightDir;   // key light: sun by day, moon by night
  uniform vec3 uLightCol;   // key light irradiance / PI
  uniform vec3 uSunDir;     // the sun itself (haze glow, alpenglow)
  uniform vec3 uSkyAmb;     // sky light on an upward face
  uniform vec3 uBounce;     // light bounced up from the snow and the cloud sea
  uniform vec3 uHazeCol;    // aerial perspective colour (the scene's fog colour)
  uniform vec3 uHalo;       // forward-scattered sunlight around the sun (sky aureole)
  uniform vec3 uGlowTint;   // extra haze colour toward the sun's azimuth (warm at golden hour, like the sky)
  uniform vec3 uAlpen;      // alpenglow on the high faces around sunset
  uniform float uCamY, uCloudTop, uTime;
  uniform float uFogScale, uFogB, uHazeMul; // scene height fog: density at the eye, falloff; our strength
  varying vec3 vPos;
  varying vec3 vNrm;
  varying float vCloud;
  varying vec2 vEdge;

  // noise lookups with explicit gradients: they sit in branches, where implicit derivatives are undefined
  vec4 nz(vec2 p, vec2 gx, vec2 gy) { return textureGrad(uNoise, p * 0.125, gx * 0.125, gy * 0.125); }
  float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

  void main() {
    vec3 eye = vec3(0.0, uCamY, 0.0);
    vec3 V = normalize(eye - vPos);
    // the inner skirt stands in for the cloud sea between the viewer and the ring: shade it as the point
    // where this view ray meets the cloud-sea plane, so the sea seems to roll on toward the real valleys
    vec3 P = vPos;
    if (vEdge.x > 0.0) P = eye + (vPos - eye) * clamp((uCamY - uCloudTop) / max(uCamY - vPos.y, 1.0), 0.0, 1.0);
    float rr = length(P.xz);
    float ang = length(-V - uSunDir); // ~angle to the sun
    float toSun = max(dot(-V, uSunDir), 0.0);
    vec3 dpx = dFdx(vPos), dpy = dFdy(vPos), dPx = dFdx(P), dPy = dFdy(P);

    // ---------------- cloud sea (and the wisps it lifts up the lower flanks) ----------------
    float cl = vEdge.x, wrap = 0.0;
    vec3 cloud = vec3(0.0);
    if (vCloud > -650.0 || vEdge.x > 0.0) {
      // lumpy stratocumulus tops (billows ~1.5 km and ~450 m): lit on their sun side, blue-grey in the hollows
      vec2 cp = P.xz / 1500.0 + vec2(uTime * 0.0035, uTime * 0.0012);
      vec2 cgx = dPx.xz / 1500.0, cgy = dPy.xz / 1500.0;
      vec4 c1 = nz(cp, cgx, cgy), c2 = nz(cp * 3.3 + vec2(0.31, 0.77), cgx * 3.3, cgy * 3.3);
      vec4 c3 = nz(cp * 11.0 + vec2(0.57, 0.13), cgx * 11.0, cgy * 11.0); // cauliflower detail up close
      float puff = c1.r * 0.55 + c2.r * 0.3 + c3.r * 0.15;
      vec2 cg = (c1.gb - 0.5) * 3.9 + (c2.gb - 0.5) * 2.9 + (c3.gb - 0.5) * 1.8;
      vec3 Nc = normalize(vec3(-cg.x, 1.0, -cg.y));
      // bright sunlit tops, blue-grey hollows like the art's cloud banks (kept below white so the billows
      // survive tone mapping)
      float lit = clamp(dot(Nc, uLightDir) * 0.95 + 0.12, 0.0, 1.0) * mix(0.22, 1.0, smoothstep(0.3, 0.78, puff));
      cloud = uLightCol * lit * 0.86 + uSkyAmb * (0.34 + 0.62 * puff);
      cloud += uHalo * 0.3 * pow(toSun, 10.0) * smoothstep(0.4, 0.8, puff); // silver lining toward the sun
      cl = max(cl, smoothstep(-70.0, 50.0, vCloud + (puff - 0.5) * 260.0));
      wrap = exp(-max(-vCloud, 0.0) / 240.0) * (1.0 - cl) * smoothstep(0.25, 0.75, puff) * 0.75;
    }

    // ---------------- rock and snow ----------------
    vec3 surf = cloud;
    if (cl < 0.999) {
      vec3 N = normalize(vNrm);
      float steep = 1.0 - N.y; // 0 flat .. ~0.45 on the 55 deg summit faces
      // face-projected patterns (planar projection on the wall the face looks along, blended across aretes),
      // sized to read at 10-25 km: couloirs ~260 m apart and streaks down the fall line, strata every ~150 m
      vec3 an = abs(N);
      float wx = smoothstep(0.3, 0.7, an.x / (an.x + an.z + 1e-4));
      vec2 kc = vec2(1.0 / 260.0, 1.0 / 1100.0), ks = vec2(1.0 / 90.0, 1.0 / 420.0);
      vec4 cx = nz(vPos.zy * kc, dpx.zy * kc, dpy.zy * kc);
      vec4 cz = nz(vPos.xy * kc + 0.43, dpx.xy * kc, dpy.xy * kc);
      // fine streaks: one projection along the face (the blend seam is invisible at this scale)
      vec3 pu = mix(vec3(vPos.x, dpx.x, dpy.x), vec3(vPos.z, dpx.z, dpy.z), wx);
      vec4 st = nz(vec2(pu.x, vPos.y) * ks + 0.21, vec2(pu.y, dpx.y) * ks, vec2(pu.z, dpy.y) * ks);
      vec4 co = mix(cz, cx, wx);
      vec2 kt = vec2(1.0 / 3200.0, 1.0 / 150.0);
      float strata = nz(vec2(vPos.x - vPos.z, vPos.y) * kt + 0.5, vec2(dpx.x - dpx.z, dpx.y) * kt, vec2(dpy.x - dpy.z, dpy.y) * kt).a;
      // snowfields and glaciers on the gentler slopes, dark rock on the steep faces...
      float sl = steep + (co.r - 0.5) * 0.2 + (st.r - 0.5) * 0.1;
      float snow = 1.0 - smoothstep(0.13, 0.23, sl);
      // ...streaked white by snow-filled couloirs and ledges
      float gully = smoothstep(0.58, 0.7, co.r * 0.65 + st.a * 0.35) * (1.0 - smoothstep(0.55, 0.75, steep));
      float ledge = smoothstep(0.63, 0.74, strata) * (1.0 - smoothstep(0.34, 0.52, steep));
      snow = max(snow, max(gully, ledge * 0.85));
      // dark slate-blue rock, as on the real mountains (world/terrain.js), a touch lighter for the averaged detail
      vec3 rock = mix(vec3(0.022, 0.03, 0.05), vec3(0.075, 0.088, 0.12), st.a) * (0.8 + 0.4 * co.a);
      vec3 alb = mix(rock, vec3(0.9, 0.93, 0.98), snow);
      // relief: gullies and buttresses bend the normal across the face, ledges tilt it up
      vec2 gco = co.gb - 0.5, gst = st.gb - 0.5;
      vec3 side = normalize(vec3(-N.z, 0.0, N.x) + 1e-5);
      N = normalize(N + side * (gco.x * 0.8 + gst.x * 0.35) * (1.0 - 0.5 * snow) + vec3(0.0, ledge * 0.25, 0.0));

      float ndl = dot(N, uLightDir);
      float direct = clamp(ndl * 1.1 + 0.03, 0.0, 1.0); // crisp terminator along the aretes
      vec3 amb = mix(uBounce, uSkyAmb, N.y * 0.5 + 0.5);
      vec3 col = alb * (uLightCol * direct + amb);
      // sun-facing crests catch a rim of light, strongest when the range is backlit
      float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0) * smoothstep(0.0, 0.35, ndl);
      col += uLightCol * rim * (0.12 + 1.2 * toSun * toSun) * mix(0.25, 1.0, snow);
      // alpenglow: the high faces turned to the low sun keep a pink light around sunset
      vec3 sunFlat = normalize(vec3(uSunDir.x, 0.22, uSunDir.z));
      float hiFace = smoothstep(uCloudTop + 300.0, uCloudTop + 2300.0, vPos.y);
      col += uAlpen * alb * max(dot(N, sunFlat), 0.0) * hiFace;
      surf = mix(col, cloud, max(cl, wrap));
    }

    // ---------------- aerial perspective ----------------
    // the scene's own height fog, at an effective distance beyond the real terrain the peaks stand behind
    float dEff = 7000.0 + rr * 1.05;
    float dy = P.y - uCamY;
    float kk = abs(dy * uFogB) > 1e-4 ? (1.0 - exp(-dy * uFogB)) / (dy * uFogB) : 1.0;
    float haze = 1.0 - exp(-uFogScale * dEff * kk * uHazeMul);
    vec2 vh = normalize(-V.xz + 1e-5), shz = normalize(uSunDir.xz + 1e-5);
    float sunAz = max(dot(vh, shz), 0.0);
    vec3 hazeCol = uHazeCol + uGlowTint * (sunAz * sunAz * sunAz) + uHalo * (exp(-ang * 12.0) * 0.45 + exp(-ang * 3.5) * 0.12);
    vec3 outc = mix(surf, hazeCol, haze);
    // thick weather: fade out entirely so the real sky behind shows (no ghost silhouettes)
    float alpha = (1.0 - smoothstep(0.8, 0.985, haze)) * (1.0 - vEdge.y);
    outc *= 1.0 + (hash12(gl_FragCoord.xy) - 0.5) * 0.012; // dither: no banding in the smooth haze
    gl_FragColor = vec4(outc, alpha);
  }`;

export class Backdrop {
  // (the { renderer } in the shared API is not needed: everything is built on the CPU)
  constructor(scene, { env } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'backdrop';
    this.uniforms = {
      uNoise: { value: makeNoiseTexture() },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightCol: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSkyAmb: { value: new THREE.Color() },
      uBounce: { value: new THREE.Color() },
      uHazeCol: { value: new THREE.Color() },
      uHalo: { value: new THREE.Color() },
      uGlowTint: { value: new THREE.Color() },
      uAlpen: { value: new THREE.Color() },
      uCamY: { value: 0 },
      uCloudTop: { value: 300 },
      uTime: { value: 0 },
      uFogScale: { value: 0.00003 },
      uFogB: { value: 0.00045 },
      uHazeMul: { value: BACKDROP_HAZE }, // crisper than the physical haze (the logo's peaks); the real terrain's far field matches it (engine/fog.js)
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true, fog: false, side: THREE.FrontSide,
    });
    this.layers = LAYERS.map((L) => {
      const data = buildLayer(L);
      const mesh = new THREE.Mesh(data.geo, this.material);
      mesh.name = `backdrop-${L.name}`;
      mesh.renderOrder = L.order; // after the stars (-9) and moon (-8), before clouds/mist/snow (2+)
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      return { ...data, mesh };
    });
    scene.add(this.group);

    // tunables (the lead can tweak these at runtime)
    this.cloudLevel = 380; // cloud-sea level above the valley floor in clear weather (m)
    this.sunVisibility = 1; // 0..1: how much of the sun the peaks leave visible (multiplied into env.sunVisible)
    this.tmpC = new THREE.Color();
    if (env) this.update(0, { position: new THREE.Vector3() }, env);
  }

  get triangles() { return this.layers.reduce((s, l) => s + l.geo.index.count / 3, 0); }

  // Height of the regional valley floor under the camera: the world tilts down the Legacy Valley south of
  // the village (mirrors world.js descent()), so the ranges stay on the horizon however far you ski.
  baseline(z) {
    const t = z - 200;
    return t > 0 ? -0.17 * t * smoothstep(0, 450, t) : 0;
  }

  update(dt, camera, env) {
    const cam = camera.position, u = this.uniforms;
    const base = this.baseline(cam.z);
    this.group.position.set(cam.x, base, cam.z);
    const camY = cam.y - base;
    u.uCamY.value = camY;
    u.uTime.value += dt;

    // cloud sea: higher when the weather closes in, always a few hundred metres below the eye
    const level = this.cloudLevel + env.cloud * 420 + env.mist * 220 + env.snow * 200;
    u.uCloudTop.value = Math.min(level, camY - 260);

    // light
    u.uLightDir.value.copy(env.lightDir);
    // (moonlight is lifted a little so the snowy peaks still read on a clear night)
    u.uLightCol.value.copy(env.sun.color).multiplyScalar((env.sun.intensity / Math.PI) * (1 + 1.3 * env.nightFactor));
    u.uSunDir.value.copy(env.sunDir);
    const su = env.skyUniforms;
    // sky light: the cerulean mid-sky, a little desaturated (as the IBL the terrain is lit by)
    const amb = u.uSkyAmb.value.copy(su.uZenith.value).lerp(su.uMid ? su.uMid.value : su.uHorizon.value, 0.8);
    const l = amb.r * 0.2126 + amb.g * 0.7152 + amb.b * 0.0722;
    amb.setRGB(l + (amb.r - l) * 0.7, l + (amb.g - l) * 0.7, l + (amb.b - l) * 0.7).multiplyScalar(1.25 * (this.scene.environmentIntensity ?? 1));
    const bounce = env.sun.intensity * Math.max(env.lightDir.y, 0) * 0.85 / Math.PI;
    u.uBounce.value.copy(env.sun.color).multiplyScalar(bounce * 0.3).add(this.tmpC.copy(amb).multiplyScalar(0.3));
    // haze: the scene's fog colour and density (so weather, mist and whiteouts swallow the peaks too)
    u.uHazeCol.value.copy(env.fogColor);
    if (su.uHalo) u.uHalo.value.copy(su.uHalo.value);
    else u.uHalo.value.setRGB(0, 0, 0);
    // the sky's horizon glow toward the sun (warm at golden hour): the haze on that side takes a share
    const gt = u.uGlowTint.value;
    if (su.uGlow) gt.copy(su.uGlow.value).sub(su.uHorizon.value).multiplyScalar(0.22);
    else gt.setRGB(0, 0, 0);
    gt.setRGB(Math.max(gt.r, 0), Math.max(gt.g, 0), Math.max(gt.b, 0));
    const fog = this.scene.fog;
    if (fog) {
      u.uFogB.value = fog.far;
      u.uFogScale.value = fog.near * Math.exp(-Math.max(cam.y, 0) * fog.far);
    }
    // alpenglow: pink light on the high faces from just before sunset until the sun is ~4 deg down
    const sh = env.sunDir.y;
    const alpen = smoothstep(-0.075, -0.012, sh) * (1 - smoothstep(0.02, 0.11, sh)) * (1 - (env.overcast ?? Math.max(env.snow, env.cloud * 0.85)));
    u.uAlpen.value.setRGB(1.0, 0.42, 0.36).multiplyScalar(alpen * 1.8);

    this.updateSunVisibility(env, camY);
  }

  // How much of the sun disc is above the peaks' silhouette (cheap: one column of each layer).
  updateSunVisibility(env, camY) {
    const s = env.sunDir;
    const sunEl = Math.asin(Math.max(-1, Math.min(1, s.y)));
    const az = Math.atan2(s.x, -s.z);
    const cloudTop = this.uniforms.uCloudTop.value;
    let horizon = -Math.PI / 2;
    for (const L of this.layers) {
      const A = L.seg;
      for (let o = -1; o <= 1; o++) {
        const j = ((Math.round(((az + o * 0.5 * DEG) / TAU) * A) % A) + A) % A;
        for (let i = 0; i < L.rows.length; i++) {
          const k = i * A + j;
          const h = Math.max(L.H[k], cloudTop + L.cloud[k]);
          horizon = Math.max(horizon, Math.atan2(h - camY, L.rows[i]));
        }
      }
    }
    // fully hidden once the disc (r ~0.5 deg) is 0.6 deg below the silhouette; fades with the haze
    const vis = smoothstep(-0.6 * DEG, 0.6 * DEG, sunEl - horizon);
    const opacity = 1 - smoothstep(0.8, 0.985, 1 - Math.exp(-this.uniforms.uFogScale.value * 30000 * this.uniforms.uHazeMul.value));
    this.sunVisibility = 1 - (1 - vis) * opacity;
    if (typeof env.sunVisible === 'number') env.sunVisible *= this.sunVisibility;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const L of this.layers) L.geo.dispose();
    this.material.dispose();
    this.uniforms.uNoise.value.dispose();
  }
}
