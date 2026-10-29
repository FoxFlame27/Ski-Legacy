// The ski bus at runtime: the plowed roads (a packed-snow strip, snow banks from the plough, orange snow poles),
// the yellow post bus (Meshy shell, models.ski_bus) with our own simple interior (seats, poles, glass, a driver's
// cab) and the ride itself: you sit by a window, the bus drives the road to your stop in real time; mouse to look
// around, R for an outside view, hold Space to fast-forward. Modelled on the Wolkenspitzbahn ride (railway.js).
//
// SkiBus (skibus.js) owns one BusLine: busLine.board(from, to) -> seat; per frame update / updateRide /
// applyCamera; main.js does the fades, the player's seat and the HUD line.
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { coachSeats } from '../../world/coachseat.js';
import { fitModel } from '../../core/assets.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { busRoads, roadAt, ROAD_HALF, roadsideBlocked, laneDistance } from './roads.js';
import { transition } from '../../ui/transition.js';
import { trafficBlockers } from '../traffic.js';
import { buildScenicProps } from './scenicprops.js'; // benches, view boards, walls, give-way signs, the roundabouts' islands

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const BUS = { len: 12, width: 2.55, floor: 0.95, lane: 1.55, cruise: 26, acc: 1.7, brake: 2.0, lat: 2.6 };
const CLEAR_DEC = 1.8, CLEAR_GAP = 4; // braking for something in the lane (m/s^2, within its 2.6 limit); the gap it stops at (m)
const BAY = 7; // the bus stops this far before the end of the road (its middle)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
const _p = {}, _q = {};

// ------------------------------------------------------------------ road meshes
// The road surface, 6.8 m across x 13.5 m along: worn asphalt, white edge lines and a dashed centre line, grit; the
// snow over it (tracks, edges, patches) is drawn by the shader (snowCover).
function roadTexture() {
  const W = 512, H = 1024, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // worn asphalt with a fine grain (light: under the blue snow light a dark grey reads as navy)
  g.fillStyle = '#6a6b6d'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) { const v = 84 + rnd() * 44; g.fillStyle = `rgba(${v + 4},${v + 2},${v},0.5)`; g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2); }
  // markings (white, worn)
  g.fillStyle = 'rgba(236,238,240,0.85)';
  g.fillRect(W * 0.045, 0, W * 0.022, H); g.fillRect(W * 0.933, 0, W * 0.022, H);
  g.fillRect(W * 0.492, H * 0.08, W * 0.016, H * 0.3); g.fillRect(W * 0.492, H * 0.58, W * 0.016, H * 0.3);
  // (the snow on it: shader noise in world space, snowCover below; no painted bands or flecks to repeat)
  for (let i = 0; i < 1800; i++) { const v = 80 + rnd() * 50; g.fillStyle = `rgba(${v + 18},${v + 8},${v},0.5)`; g.fillRect(rnd() * W, rnd() * H, 1.5, 1.5); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Draw the road a hair toward the camera (a share of its distance): it stays on top of the terrain it lies on at
// every terrain LOD and quality preset, without lifting it visibly or z-fighting up close.
function decal(mat, k = 0.0012) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      mvPosition.xyz *= ${(1 - k).toFixed(5)};
      gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.customProgramCacheKey = () => `busdecal${k}`;
  return mat;
}

// The snow on the roads, in the shader: wheel tracks that wander across the lane and vary in width along the road
// and fade out (stretches fully snowed over), ragged snow along both edges, and large patches (world position noise,
// no repeating tile) of packed snow, slush and bare asphalt. uv: u across the strip (0..1), v = metres / 13.5.
const SNOW_GLSL = `
varying vec3 vRoadW;
float rdH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rdN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rdH(i), rdH(i + vec2(1.0, 0.0)), f.x), mix(rdH(i + vec2(0.0, 1.0)), rdH(i + vec2(1.0, 1.0)), f.x), f.y); }
float rdF(vec2 p) { return rdN(p) * 0.5 + rdN(p * 2.03 + 7.1) * 0.25 + rdN(p * 4.01 + 3.3) * 0.125 + rdN(p * 8.1 + 1.7) * 0.0625; }
`;
const SNOW_FRAG = `
  {
    vec2 Wp = vRoadW.xz;
    float u = vMapUv.x, sv = vMapUv.y * 13.5;
    float wob = (rdN(vec2(sv * 0.021, 3.7)) - 0.5) * 0.10 + (rdN(vec2(sv * 0.09, 9.1)) - 0.5) * 0.035;
    float wid = 0.04 + 0.035 * rdN(vec2(sv * 0.03, 1.3));
    float tr = 0.0;
    tr = max(tr, 1.0 - smoothstep(wid * 0.5, wid * 1.5, abs(u - 0.2 - wob)));
    tr = max(tr, 1.0 - smoothstep(wid * 0.5, wid * 1.5, abs(u - 0.36 - wob * 0.8)));
    tr = max(tr, 1.0 - smoothstep(wid * 0.5, wid * 1.5, abs(u - 0.64 + wob * 0.7)));
    tr = max(tr, 1.0 - smoothstep(wid * 0.5, wid * 1.5, abs(u - 0.8 + wob)));
    float fine = rdF(Wp * 0.9), P = rdF(Wp * 0.03 + 4.0);
    float clearT = smoothstep(0.3, 0.7, rdN(vec2(sv * 0.012, 5.5))) * (0.6 + 0.4 * fine);
    float eN = rdN(vec2(sv * 0.15, 2.2)) * 0.07 + (fine - 0.5) * 0.06;
    float edge = 1.0 - smoothstep(0.06 + eN, 0.16 + eN, u) + smoothstep(0.84 - eN, 0.94 - eN, u);
    float snow = clamp(1.0 - tr * clearT, 0.0, 1.0) * smoothstep(0.22, 0.55, P + 0.3 * fine - 0.1);
    float bare = smoothstep(0.6, 0.78, P);
    snow = max(snow * (1.0 - bare * 0.9), clamp(edge, 0.0, 1.0));
    float slush = (1.0 - snow) * smoothstep(0.35, 0.7, rdF(Wp * 0.06 + 11.0)) * (1.0 - bare);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.29, 0.28) * (0.85 + 0.3 * fine), slush * 0.75);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.84, 0.89) * (0.88 + 0.16 * fine), snow * (0.7 + 0.3 * fine));
    rdWet = slush;
  }
`;
function snowCover(mat, key) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoadW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoadW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${SNOW_GLSL}\nfloat rdWet = 0.0;`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${SNOW_FRAG}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= 1.0 - 0.4 * rdWet;');
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}-roadsnow-${key}`;
  return mat;
}

const ACROSS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];

// An access road's centre line up to just inside (0.3 m) the bus road it joins: { X, Z, S, n } (its own arrays up to
// there, the last point exactly on the edge). Inside = across a bus road's strip, between its ends (a road carrying
// on from another's end is never cut).
function trimAccess(r) {
  const mains = busRoads.roads.filter((o) => !o.access);
  const ex = r.X[r.n - 1], ez = r.Z[r.n - 1];
  const segs = [];
  for (const m of mains) for (let i = 0; i < m.n - 1; i++) if (Math.abs(m.X[i] - ex) < 40 && Math.abs(m.Z[i] - ez) < 40) segs.push([m.X[i], m.Z[i], m.X[i + 1], m.Z[i + 1]]);
  const inside = (x, z) => {
    for (const [ax, az, bx, bz] of segs) {
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = ((x - ax) * dx + (z - az) * dz) / l2;
      if (t < 0 || t > 1) continue;
      if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < ROAD_HALF - 0.3) return true;
    }
    return false;
  };
  if (!segs.length || !inside(ex, ez)) return r;
  let k = r.n - 1;
  while (k > 1 && inside(r.X[k], r.Z[k])) k--;
  if (k >= r.n - 1) return r;
  // the edge between sample k (outside) and k + 1 (inside)
  let a = 0, b = 1;
  for (let it = 0; it < 14; it++) { const t = (a + b) / 2; if (inside(r.X[k] + (r.X[k + 1] - r.X[k]) * t, r.Z[k] + (r.Z[k + 1] - r.Z[k]) * t)) b = t; else a = t; }
  const t = b, X = Array.from(r.X.slice(0, k + 2)), Z = Array.from(r.Z.slice(0, k + 2)), S = Array.from(r.S.slice(0, k + 2));
  X[k + 1] = r.X[k] + (r.X[k + 1] - r.X[k]) * t; Z[k + 1] = r.Z[k] + (r.Z[k + 1] - r.Z[k]) * t; S[k + 1] = r.S[k] + (r.S[k + 1] - r.S[k]) * t;
  return { X, Z, S, n: k + 2 };
}                                      // road strip vertices across (x half width)

// ------------------------------------------------------------------ guardrails
// Galvanised W-beam guardrails (the double-wave steel profile on C-posts every 2 m, a spacer block between them, an
// amber reflector in the beam's valley): on the valley side of every road outside the village for most of its
// length, on both sides along ridges, bends (radius under ~80 m) and steep stretches, and wherever the ground falls
// away beside the road. Gaps only where they must be: junctions, the bus stops, the lay-by, the car parks and their
// entrances, the medical centre's drive, the village. Runs of 28 m or more (no stubs), small gaps closed, each end
// flared out and buried in the snow (a 12 m terminal).
// One 4 m segment of geometry, instanced and bent along the road in the vertex shader (a Catmull-Rom curve through the
// rail points: no gaps or overlaps at the joints), an LOD per ~200 m stretch (none drawn beyond ~400 m). The same
// points make the colliders: thin boxes for people on foot and on skis, sleds and the helicopter (soft: you slide
// off, never wipe out) and the car's line colliders (busRoads.rails).
const SEG = 4;                       // m of rail per instance (posts at 1 and 3 m)
const RAIL_OFF = ROAD_HALF + 0.55;   // the back of the beam from the centre line (its waves reach 8 cm toward the road)
const BEAM_LO = 0.38, BEAM_TOP = 0.68, WAVE = 0.083; // (the beam's centre ~0.53 m, its top ~0.68 m over the road edge)
const RAIL_FAR = 400;                // m: a stretch further than this from the camera is not drawn
const VILLAGE_R = 175;               // no guardrails in the village
const MIN_RUN = 8;                   // road samples (~28 m)

const roadDir = (r, i) => {
  const a = Math.max(0, i - 1), b = Math.min(r.n - 1, i + 1), dx = r.X[b] - r.X[a], dz = r.Z[b] - r.Z[a], l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
};

// Where road r (index ri) gets a guardrail: [right side, left side] per road sample (1 = rail).
function planRails(r, ri, H) {
  const n = r.n, L = r.length, out = [new Uint8Array(n), new Uint8Array(n)];
  if (n < MIN_RUN + 4 || r.ringRoad) return out; // (the roundabout's ring: its island kerb, no rails)
  const head = (i) => { const [dx, dz] = roadDir(r, i); return Math.atan2(dx, dz); };
  const lean = new Float32Array(n), drop = [new Uint8Array(n), new Uint8Array(n)], both = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [dx, dz] = roadDir(r, i), nx = dz, nz = -dx, y = r.Y[i]; // (+n: the road's left)
    const hs = [0, 0];
    for (let sd = 0; sd < 2; sd++) {
      const sg = sd ? 1 : -1;
      const h1 = H(r.X[i] + nx * sg * (ROAD_HALF + 9), r.Z[i] + nz * sg * (ROAD_HALF + 9)); // (just past the flat bench)
      const h2 = H(r.X[i] + nx * sg * (ROAD_HALF + 16), r.Z[i] + nz * sg * (ROAD_HALF + 16));
      hs[sd] = (h1 + h2) / 2;
      drop[sd][i] = h1 < y - 1.2 || h2 < y - 3 ? 1 : 0;
    }
    lean[i] = hs[0] - hs[1]; // > 0: the left lies lower
    const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2), ds = Math.max(1, r.S[i1] - r.S[i0]);
    const curv = Math.abs(Math.atan2(Math.sin(head(i1) - head(i0)), Math.cos(head(i1) - head(i0)))) / ds;
    const g0 = Math.max(0, i - 3), g1 = Math.min(n - 1, i + 3);
    const grade = Math.abs(r.Y[g1] - r.Y[g0]) / Math.max(1, r.S[g1] - r.S[g0]);
    // both sides: a ridge (the ground falls away either side), a bend tighter than ~80 m, a steep stretch
    both[i] = (drop[0][i] && drop[1][i]) || curv > 1 / 80 || grade > 0.08 ? 1 : 0;
  }
  // the valley side: the lower one over ~50 m, switching sides only where the other is clearly lower
  let cur = -1;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++) { s += lean[k]; c++; }
    const m = s / c;
    if (cur < 0) cur = m >= 0 ? 1 : 0;
    else if (m > 0.6) cur = 1;
    else if (m < -0.6) cur = 0;
    for (let sd = 0; sd < 2; sd++) out[sd][i] = sd === cur || drop[sd][i] || both[i] ? 1 : 0;
  }
  // the gaps: the village, the stops at the road's ends (an access road: its car park, its junction), junctions and
  // other roads (1.6 m clear of their lanes), car parks and their entrances, the lay-by, the medical centre's drive
  const ban = [new Uint8Array(n), new Uint8Array(n)];
  const Hs = busRoads.hospital;
  let hospS = null;
  if (Hs) { let bd = 60; for (let i = 0; i < n; i++) { const d = Math.hypot(r.X[i] - Hs.ex, r.Z[i] - Hs.ez); if (d < bd) { bd = d; hospS = r.S[i]; } } }
  const end0 = r.access ? 26 : 30, end1 = r.access ? 18 : 30;
  for (let i = 0; i < n; i++) {
    const s = r.S[i], [dx, dz] = roadDir(r, i), nx = dz, nz = -dx;
    for (let sd = 0; sd < 2; sd++) {
      const sg = sd ? 1 : -1, x = r.X[i] + nx * sg * RAIL_OFF, z = r.Z[i] + nz * sg * RAIL_OFF;
      let b = s < end0 || s > L - end1 || Math.hypot(x, z) < VILLAGE_R || (hospS !== null && Math.abs(s - hospS) < 20);
      if (!b) for (const lb of busRoads.laybys || []) if (busRoads.roads[lb.ri] === r && (lb.side ?? 1) === (sd ? -1 : 1) && Math.abs(lb.s - s) < 20) b = true;
      if (!b && roadsideBlocked(x, z, 1.6, ri, s)) b = true;
      ban[sd][i] = b ? 1 : 0;
    }
  }
  for (let sd = 0; sd < 2; sd++) {
    const m = out[sd], bn = ban[sd];
    for (let i = 0; i < n; i++) if (bn[i]) m[i] = 0;
    // close little gaps (up to 3 samples) nothing asks for
    for (let i = 1; i < n - 1; i++) {
      if (m[i] || !m[i - 1]) continue;
      let j = i;
      while (j < n && !m[j] && j - i < 4) j++;
      if (j < n && m[j] && j - i <= 3) {
        let ok = true;
        for (let k = i; k < j; k++) if (bn[k]) ok = false;
        if (ok) for (let k = i; k < j; k++) m[k] = 1;
      }
    }
    // no stubs
    for (let i = 0; i < n;) {
      if (!m[i]) { i++; continue; }
      let j = i;
      while (j < n && m[j]) j++;
      if (j - i < MIN_RUN) for (let k = i; k < j; k++) m[k] = 0;
      i = j;
    }
  }
  return out;
}

// The runs of road r as point lists [x, y, z, sink] in their own direction, the road on their left (the right side
// runs along the road, the left side against it); the last three points at each end flare out and sink (the buried
// terminal).
function railRuns(r, mask, H) {
  const runs = [];
  for (let sd = 0; sd < 2; sd++) {
    const m = mask[sd], sg = sd ? 1 : -1;
    // each rail point checked: at the road edge's height (a point off the flat shoulder, on another road's lane or
    // on this road's own other leg, or where the offset line folds at a tight corner breaks the run); runs shorter
    // than ~22 m are dropped (no orphan stubs)
    const pt = new Array(r.n).fill(null);
    for (let k = 0; k < r.n; k++) {
      if (!m[k]) continue;
      const [dx, dz] = roadDir(r, k), ox = dz * sg, oz = -dx * sg;
      const x = r.X[k] + ox * RAIL_OFF, z = r.Z[k] + oz * RAIL_OFF;
      const ex = r.X[k] + ox * ROAD_HALF, ez = r.Z[k] + oz * ROAD_HALF, ye = H(ex, ez), yg = H(x, z);
      if (Math.abs(yg - ye) > 0.5 || Math.abs(ye - r.Y[k]) > 1.2) continue;
      // (standing on the snow where its posts are, never above the road edge: a little lower where the bank falls away)
      const y = Math.max(ye - 0.2, Math.min(ye, yg));
      if (laneDistance(x, z) < RAIL_OFF - 0.35) continue;
      pt[k] = { k, x, z, y, ox, oz };
    }
    const pieces = [];
    let cur = [];
    for (let k = 0; k < r.n; k++) {
      const p = pt[k], q = cur[cur.length - 1];
      let ok = !!p;
      if (ok && q) {
        const ddx = p.x - q.x, ddz = p.z - q.z, l = Math.hypot(ddx, ddz), [dx, dz] = roadDir(r, k);
        if (p.k !== q.k + 1 || l < 0.8 || l > 7 || (ddx * dx + ddz * dz) / (l || 1) < 0.6) ok = false; // (a fold or a jump)
        if (!ok && p) { if (cur.length) pieces.push(cur); cur = [p]; continue; }
      }
      if (ok) cur.push(p);
      else { if (cur.length) pieces.push(cur); cur = []; }
    }
    if (cur.length) pieces.push(cur);
    for (const piece of pieces) {
      if (piece.length < 6) continue;
      if (sd === 1) piece.reverse();
      const last = piece.length - 1;
      runs.push(piece.map((p, q) => {
        const e = Math.min(q, last - q), flare = e < 3 ? [1.1, 0.42, 0.1][e] : 0, sink = e < 3 ? [0.98, 0.5, 0.13][e] : 0;
        const x = p.x + p.ox * flare, z = p.z + p.oz * flare;
        return [x, p.y, z, sink];
      }));
    }
  }
  return runs;
}

// One 4 m segment in its own frame: x along (0..SEG), y up from the snow, z outward (away from the road). The
// beam: a single sheet with the W profile (two waves toward the road, its valley on the spacers); C-posts at 1 and
// 3 m (0.45 m in the ground), spacer blocks; the amber reflector (its own geometry) in the valley at the first post.
function railGeometry() {
  const NP = 16, NX = 4, pos = [], uv = [], idx = [];
  for (let ix = 0; ix <= NX; ix++) {
    for (let k = 0; k <= NP; k++) {
      const t = k / NP, x = (ix / NX) * SEG;
      pos.push(x, BEAM_LO + (BEAM_TOP - BEAM_LO) * t, -WAVE * (0.5 - 0.5 * Math.cos(4 * Math.PI * t)));
      uv.push(x / SEG, t);
    }
  }
  for (let ix = 0; ix < NX; ix++) for (let k = 0; k < NP; k++) { const a = ix * (NP + 1) + k, b = a + NP + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  const beam = new THREE.BufferGeometry();
  beam.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  beam.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  beam.setIndex(idx);
  beam.computeVertexNormals();
  const box = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    const u = g.attributes.uv; // (a clean patch of the galvanised texture: no bolt heads)
    for (let i = 0; i < u.count; i++) u.setXY(i, 0.42 + u.getX(i) * 0.16, 0.8 + u.getY(i) * 0.14);
    return g;
  };
  const parts = [beam];
  const mid = (BEAM_LO + BEAM_TOP) / 2;
  for (const px of [1, 3]) {
    parts.push(box(0.1, 1.09, 0.008, px, 0.095, 0.205));            // post web (toward the road)
    parts.push(box(0.008, 1.09, 0.055, px - 0.046, 0.095, 0.235));  // flanges
    parts.push(box(0.008, 1.09, 0.055, px + 0.046, 0.095, 0.235));
    parts.push(box(0.075, 0.19, 0.2, px, mid, 0.1));                // spacer block
  }
  return { galv: mergeGeometries(parts, false), refl: box(0.065, 0.07, 0.014, 1, mid, -0.006) };
}

// galvanised steel: a fine spangle, faint streaks along the beam, road grime low down, bolt heads in the valley at
// the posts and the splice bolts at the joint
function galvTexture() {
  const W = 256, Hh = 128, c = document.createElement('canvas');
  c.width = W; c.height = Hh;
  const g = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#c3c8cd'; g.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 1400; i++) {
    const v = 176 + rnd() * 52, s = 2 + rnd() * 6;
    g.fillStyle = `rgba(${v},${v + 3},${v + 7},0.32)`;
    g.fillRect(rnd() * W, rnd() * Hh, s, s * (0.5 + rnd()));
  }
  for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(112,116,121,${0.03 + rnd() * 0.06})`; g.fillRect(0, rnd() * Hh, W, 1 + rnd() * 2); }
  const gr = g.createLinearGradient(0, Hh, 0, Hh * 0.62);
  gr.addColorStop(0, 'rgba(92,88,82,0.38)'); gr.addColorStop(1, 'rgba(92,88,82,0)');
  g.fillStyle = gr; g.fillRect(0, Hh * 0.62, W, Hh * 0.38);
  const bolt = (u, v, r) => {
    const x = u * W, y = (1 - v) * Hh;
    g.fillStyle = 'rgba(70,74,78,0.9)'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.fillStyle = 'rgba(228,232,236,0.7)'; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, 7); g.fill();
  };
  bolt(0.25, 0.5, 2.6); bolt(0.75, 0.5, 2.6);
  for (const u of [0.012, 0.035]) for (const v of [0.36, 0.64]) bolt(u, v, 1.8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  return t;
}

// the vertex shader bends each instance along its stretch of rail: a cubic Hermite curve from aRailA to aRailB (xz,
// with the tangents aRailT), heights linear (minus the terminal's sink, .w); local z turns outward
const BEND_GLSL = `
attribute vec4 aRailA;
attribute vec4 aRailB;
attribute vec4 aRailT;
vec3 railBend(vec3 p, out vec2 D) {
  float t = clamp(p.x / ${SEG.toFixed(1)}, 0.0, 1.0), t2 = t * t, t3 = t2 * t;
  vec2 P = (2.0 * t3 - 3.0 * t2 + 1.0) * aRailA.xz + (t3 - 2.0 * t2 + t) * aRailT.xy + (3.0 * t2 - 2.0 * t3) * aRailB.xz + (t3 - t2) * aRailT.zw;
  vec2 d = (6.0 * t2 - 6.0 * t) * aRailA.xz + (3.0 * t2 - 4.0 * t + 1.0) * aRailT.xy + (6.0 * t - 6.0 * t2) * aRailB.xz + (3.0 * t2 - 2.0 * t) * aRailT.zw;
  D = d / max(length(d), 1e-4);
  float y = mix(aRailA.y - aRailA.w, aRailB.y - aRailB.w, t);
  return vec3(P.x - D.y * p.z, y + p.y, P.y + D.x * p.z);
}
`;
function bendMaterial(mat, key) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${BEND_GLSL}`)
      .replace('#include <beginnormal_vertex>', `vec2 railN; railBend(position, railN);
        vec3 objectNormal = vec3(railN.x * normal.x - railN.y * normal.z, normal.y, railN.y * normal.x + railN.x * normal.z);
        #ifdef USE_TANGENT
        vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', 'vec2 railD; vec3 transformed = railBend(position, railD);');
  };
  mat.customProgramCacheKey = () => `busrail-${key}`;
  return mat;
}

class Guardrails {
  constructor(colliders, addRail) { this.segs = []; this.colliders = colliders; this.addRail = addRail; this.boxes = 0; }

  // one run: points [x, y, z, sink], the road on its left
  addRun(pts) {
    const m = pts.length;
    if (m < 2) return;
    const tan = (k) => { const a = pts[Math.max(0, k - 1)], b = pts[Math.min(m - 1, k + 1)], f = k === 0 || k === m - 1 ? 1 : 0.5; return [(b[0] - a[0]) * f, (b[2] - a[2]) * f]; };
    for (let k = 0; k < m - 1; k++) this.segs.push({ a: pts[k], b: pts[k + 1], ta: tan(k), tb: tan(k + 1) });
    // colliders along the standing stretch (not the buried ends): the car's lines, and thin boxes (merged along
    // straight bits, up to 12 m) for everything else
    let k0 = 0, k1 = m - 1;
    while (k0 < m && pts[k0][3] > 0.35) k0++;
    while (k1 >= 0 && pts[k1][3] > 0.35) k1--;
    for (let k = k0; k < k1; k++) this.addRail(pts[k][0], pts[k][2], pts[k + 1][0], pts[k + 1][2]);
    if (!this.colliders) return;
    for (let a = k0; a < k1;) {
      let b = a + 1;
      while (b < k1) {
        const nb = b + 1, ax = pts[a][0], az = pts[a][2], ex = pts[nb][0] - ax, ez = pts[nb][2] - az, l = Math.hypot(ex, ez) || 1;
        if (l > 12) break;
        let ok = true;
        for (let q = a + 1; q < nb && ok; q++) if (Math.abs((pts[q][0] - ax) * ez - (pts[q][2] - az) * ex) / l > 0.06) ok = false;
        if (!ok) break;
        b = nb;
      }
      const ax = pts[a][0], az = pts[a][2], bx = pts[b][0], bz = pts[b][2], l = Math.hypot(bx - ax, bz - az) || 1;
      let top = -Infinity;
      for (let q = a; q <= b; q++) top = Math.max(top, pts[q][1] - pts[q][3]);
      this.colliders.push({ x: (ax + bx) / 2, z: (az + bz) / 2, hw: 0.075, hd: l / 2 + 0.06, rot: -Math.atan2(bx - ax, bz - az), h: BEAM_TOP + 0.05, top: top + BEAM_TOP, soft: true, rail: true });
      this.boxes++;
      a = b;
    }
  }

  // the instanced meshes: per ~200 m stretch an LOD (drawn within RAIL_FAR), attributes relative to its centre
  build(group) {
    if (!this.segs.length) return;
    const geo = railGeometry();
    const galv = bendMaterial(new THREE.MeshStandardMaterial({ map: galvTexture(), color: 0xe4e8ec, metalness: 0.7, roughness: 0.42, side: THREE.DoubleSide }), 'galv');
    const refl = bendMaterial(new THREE.MeshStandardMaterial({ color: 0xffa21a, emissive: 0xff8a00, emissiveIntensity: 0.45, roughness: 0.3 }), 'refl');
    const depth = bendMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide }), 'depth');
    const cells = new Map();
    for (const s of this.segs) {
      const key = Math.floor((s.a[0] + s.b[0]) / 400) * 100003 + Math.floor((s.a[2] + s.b[2]) / 400);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(s);
    }
    for (const list of cells.values()) {
      let cx = 0, cy = 0, cz = 0;
      for (const s of list) { cx += s.a[0] + s.b[0]; cy += s.a[1] + s.b[1]; cz += s.a[2] + s.b[2]; }
      cx /= list.length * 2; cy /= list.length * 2; cz /= list.length * 2;
      let R = 0;
      const A = new Float32Array(list.length * 4), B = new Float32Array(list.length * 4), T = new Float32Array(list.length * 4);
      list.forEach((s, k) => {
        A.set([s.a[0] - cx, s.a[1] - cy, s.a[2] - cz, s.a[3]], k * 4);
        B.set([s.b[0] - cx, s.b[1] - cy, s.b[2] - cz, s.b[3]], k * 4);
        T.set([s.ta[0], s.ta[1], s.tb[0], s.tb[1]], k * 4);
        R = Math.max(R, Math.hypot(s.a[0] - cx, s.a[1] - cy, s.a[2] - cz), Math.hypot(s.b[0] - cx, s.b[1] - cy, s.b[2] - cz));
      });
      const aA = new THREE.InstancedBufferAttribute(A, 4), aB = new THREE.InstancedBufferAttribute(B, 4), aT = new THREE.InstancedBufferAttribute(T, 4);
      const holder = new THREE.Group();
      for (const [g, mat] of [[geo.galv, galv], [geo.refl, refl]]) {
        const ig = new THREE.BufferGeometry();
        for (const k of ['position', 'normal', 'uv']) ig.setAttribute(k, g.getAttribute(k));
        ig.setIndex(g.getIndex());
        ig.setAttribute('aRailA', aA); ig.setAttribute('aRailB', aB); ig.setAttribute('aRailT', aT);
        const im = new THREE.InstancedMesh(ig, mat, list.length);
        im.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R + 3);
        im.castShadow = mat === galv; im.receiveShadow = true;
        im.customDepthMaterial = depth;
        im.name = mat === galv ? 'guardrail' : 'guardrail-reflectors';
        im.userData.guardrail = true;
        holder.add(im);
      }
      const lod = new THREE.LOD();
      lod.name = 'guardrail-stretch';
      lod.position.set(cx, cy, cz);
      lod.addLevel(holder, 0);
      lod.addLevel(new THREE.Object3D(), RAIL_FAR);
      group.add(lod);
    }
  }
}

function buildRoadMeshes(group, colliders = null) {
  // draw order where strips overlap: a bus road over an access road (junctions), an access road over the car park's
  // surface and paint (entrances); each a clear step apart (no z-fighting at any distance)
  const roadMat = snowCover(decal(new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.72, metalness: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -14 }), 0.0017), 'main');
  const accessMat = snowCover(decal(new THREE.MeshStandardMaterial({ map: roadMat.map, roughness: 0.72, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -10 }), 0.00145), 'access');
  const poles = [], posts = [];
  // the rails' line colliders, in a grid (drive.js keeps your car off them, sliding along)
  busRoads.rails = []; busRoads.railGrid = new Map();
  const addRail = (ax, az, bx, bz) => {
    const k = busRoads.rails.push({ ax, az, bx, bz }) - 1, C = 16;
    for (let gx = Math.floor(Math.min(ax, bx) / C); gx <= Math.floor(Math.max(ax, bx) / C); gx++) for (let gz = Math.floor(Math.min(az, bz) / C); gz <= Math.floor(Math.max(az, bz) / C); gz++) {
      const key = gx * 100003 + gz;
      if (!busRoads.railGrid.has(key)) busRoads.railGrid.set(key, []);
      busRoads.railGrid.get(key).push(k);
    }
  };
  const rails = new Guardrails(colliders, addRail);
  const CH = 60; // samples per chunk (~240 m)
  const H = (x, z) => world.height(x, z);
  const MH = (x, z) => (world.meshHeight ? world.meshHeight(x, z) : world.height(x, z)); // (the drawn terrain)
  busRoads.roads.forEach((r, ri) => {
    // guardrails (planned on the whole road; an access road's are kept off the road it joins)
    let mask = [new Uint8Array(r.n), new Uint8Array(r.n)];
    try {
      mask = planRails(r, ri, H);
      for (const run of railRuns(r, mask, MH)) rails.addRun(run); // (posts on the drawn ground)
    } catch (e) { console.warn('guardrails', e); mask = [new Uint8Array(r.n), new Uint8Array(r.n)]; }
    // an access road ends just inside the road it joins, cut exactly there (that one is drawn over it): a T-junction
    // with no gap; one that carries on from a road's end is left whole (no gap there either)
    const R = r.access ? trimAccess(r) : r;
    const nEnd = R.n - 1;
    // a stop on the way (one road ends where the next one starts): both strips end on the same cross-section (the
    // bisector of their headings) and the texture runs on (v carries on from the road before), so they meet edge to
    // edge; before, the two strips overlapped in a wedge at the stop and z-fought (crossed light / dark bands)
    const prev = r.access ? null : busRoads.roads.find((o) => !o.access && o.to === r.from);
    const nexts = r.access ? [] : busRoads.roads.filter((o) => !o.access && o.from === r.to);
    const next = nexts.length === 1 ? nexts[0] : null;
    let v0 = 0;
    for (let q = prev, g = 0; q && g < 20; g++) { v0 += q.length; q = busRoads.roads.find((o) => !o.access && o.to === q.from); }
    const jointDir = (a, b) => { // (unit) bisector of road a's last heading and road b's first
      const d0 = roadDir(a, a.n - 1), d1 = roadDir(b, 0), x = d0[0] + d1[0], z = d0[1] + d1[1], l = Math.hypot(x, z);
      return l > 0.2 ? [x / l, z / l] : null;
    };
    const dirStart = prev ? jointDir(prev, r) : null, dirEnd = next ? jointDir(r, next) : null;
    for (let c0 = 0; c0 < nEnd; c0 += CH) {
      const c1 = Math.min(nEnd, c0 + CH), m = c1 - c0 + 1, na = ACROSS.length, mr = 2 * m - 1;
      const rp = new Float32Array(mr * na * 3), ruv = new Float32Array(mr * na * 2), ri2 = [];
      const dirAt = (i) => {
        const a = Math.max(0, i - 1), b = Math.min(R.n - 1, i + 1);
        let dx = R.X[b] - R.X[a], dz = R.Z[b] - R.Z[a];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        if (i === 0 && dirStart) [dx, dz] = dirStart;
        else if (i === R.n - 1 && dirEnd) [dx, dz] = dirEnd;
        return [dx, dz];
      };
      // (two rows per road sample, ~2 m apart, ~1.1 m across, each on the drawn terrain's own surface (its 2 m
      // triangles, world.meshHeight): the strip neither floats over nor sinks into the ground between its vertices)
      for (let kr = 0; kr < mr; kr++) {
        const k0 = kr >> 1, i0 = c0 + k0, half = kr & 1, i1 = Math.min(R.n - 1, i0 + half);
        let [dx, dz] = dirAt(i0);
        if (half) { const d1 = dirAt(i1), l = Math.hypot(dx + d1[0], dz + d1[1]) || 1; dx = (dx + d1[0]) / l; dz = (dz + d1[1]) / l; }
        const cx = half ? (R.X[i0] + R.X[i1]) / 2 : R.X[i0], cz = half ? (R.Z[i0] + R.Z[i1]) / 2 : R.Z[i0], cs = half ? (R.S[i0] + R.S[i1]) / 2 : R.S[i0];
        const nx = dz, nz = -dx; // across the road
        for (let q = 0; q < na; q++) {
          const o = ACROSS[q] * ROAD_HALF, x = cx + nx * o, z = cz + nz * o;
          rp.set([x, MH(x, z) + 0.035, z], (kr * na + q) * 3);
          ruv.set([(ACROSS[q] + 1) / 2, (v0 + cs) / 13.5], (kr * na + q) * 2);
        }
        if (kr < mr - 1) {
          for (let q = 0; q < na - 1; q++) { const A = kr * na + q, B = (kr + 1) * na + q; ri2.push(A, B, A + 1, A + 1, B, B + 1); }
        }
      }
      for (let k = 0; k < m; k++) {
        const i = c0 + k;
        const [dx, dz] = dirAt(i), nx = dz, nz = -dx;
        // (the plough berms are shaped into the terrain itself: roads.js)
        // orange snow poles every ~48 m and white reflector posts every ~24 m, both sides, staggered: where there is
        // no guardrail, and never on another road's lane, in a junction's mouth, a car park or the lay-by
        if (i % 6 === 0 && R.S[i] > 12 && R.S[R.n - 1] - R.S[i] > 12) {
          for (let sd = 0; sd < 2; sd++) {
            if (((i / 6) + sd) % 2) continue;
            if (mask[sd][i]) continue; // (the rail does the job there)
            const sg = sd ? 1 : -1, o = ROAD_HALF + 1.05;
            const x = R.X[i] + nx * o * sg, z = R.Z[i] + nz * o * sg;
            if (roadsideBlocked(x, z, 0.25, ri, R.S[i])) continue;
            const ry = Math.atan2(nx * sg, nz * sg); // reflector toward the road
            ((i / 6) % 4 < 2 ? posts : poles).push([x, MH(x, z), z, ry + Math.PI]);
          }
        }
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
      rg.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
      rg.setIndex(ri2); rg.computeVertexNormals();
      const road = new THREE.Mesh(rg, r.access && !r.ringRoad ? accessMat : roadMat); // (the ring over its arms' ends)
      road.receiveShadow = true;
      road.renderOrder = r.access && !r.ringRoad ? 2 : 1; // (an access road lies over the car park's surface at the entrance)
      group.add(road);
    }
  });
  try {
    rails.build(group);
    busRoads.guardrails = { segments: rails.segs.length, km: +((rails.segs.length * SEG) / 1000).toFixed(2), boxes: rails.boxes, lines: busRoads.rails.length };
  } catch (e) { console.warn('guardrails', e); }
  const o = new THREE.Object3D();
  const instanced = (geo, mat, list, y0 = 0) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, y, z, ry], k) => { o.position.set(x, y + y0, z); o.rotation.set(0, ry || 0, 0); o.updateMatrix(); im.setMatrixAt(k, o.matrix); });
    im.castShadow = true;
    group.add(im);
  };
  // (Oct 28, the user: "make sure the light reflectors and snow pole measurers on the side of the road are
  // collidable"): thin round colliders, soft like the guardrails (you bump and slide off; never a crash)
  if (colliders) {
    for (const [x, y, z] of poles) colliders.push({ x, z, r: 0.06, h: 2.2, top: y + 2.2, soft: true, pole: true });
    for (const [x, y, z] of posts) colliders.push({ x, z, r: 0.09, h: 1.05, top: y + 1.05, soft: true, pole: true });
  }
  // orange snow poles with a black tip (2.2 m)
  const pole = new THREE.CylinderGeometry(0.03, 0.035, 2.2, 6); pole.translate(0, 1.0, 0);
  const tip = new THREE.CylinderGeometry(0.032, 0.032, 0.4, 6); tip.translate(0, 1.95, 0);
  instanced(pole, new THREE.MeshStandardMaterial({ color: 0xff6418, roughness: 0.55 }), poles);
  instanced(tip, new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 }), poles);
  // white reflector posts (1.05 m, black band, an amber reflector facing the road)
  const post = new THREE.BoxGeometry(0.12, 1.05, 0.12); post.translate(0, 0.5, 0);
  const band = new THREE.BoxGeometry(0.125, 0.2, 0.125); band.translate(0, 0.87, 0);
  const refl = new THREE.BoxGeometry(0.05, 0.12, 0.02); refl.translate(0, 0.87, 0.07);
  instanced(post, new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 }), posts);
  instanced(band, new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.5 }), posts);
  instanced(refl, new THREE.MeshStandardMaterial({ color: 0xffa21a, emissive: 0xff8a00, emissiveIntensity: 0.35, roughness: 0.3 }), posts);
}

// ------------------------------------------------------------------ the bus
// The Meshy shell (front +z, wheels on y = 0, 12 m long) + our interior. Local frame: x left, y up, z forward.
export function buildBus(models, makeRig) {
  const group = new THREE.Group();
  group.name = 'ski-bus';
  // (the Meshy coach is modelled along x with its cab at -x: turned so the cab leads, toward +z)
  const shell = models.ski_bus ? fitModel(models.ski_bus, { size: BUS.len, axis: 'z', rotateY: Math.PI / 2 }) : fallbackShell();
  // (the coach's paint is metallic: mirroring the bright snow it read pale cream; a satin finish keeps it yellow)
  const satin = new Map();
  shell.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    if (models.ski_bus && o.material?.isMeshStandardMaterial) {
      if (!satin.has(o.material)) { const m = o.material.clone(); m.metalness = Math.min(m.metalness, 0.3); postBusPaint(m); satin.set(o.material, m); }
      o.material = satin.get(o.material);
    }
  });
  group.add(shell);
  const inside = buildInterior(makeRig);
  inside.visible = false;
  group.add(inside);
  return { group, shell, inside, seats: inside.userData.seats };
}

// PostBus yellow: the coach's own paint is a pale cream. Only that paint is re-coloured (bright, unsaturated
// texels, keeping their own shading); the dark glass and tyres, the coloured lights and the darker silver trim fall
// outside the mask and stay as they are. Satin, so the body never mirrors the white snow.
function postBusPaint(m) {
  m.roughness = Math.max(m.roughness, 0.42);
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec3 pc = diffuseColor.rgb;
        float pl = dot(pc, vec3(0.2126, 0.7152, 0.0722));
        float pmx = max(pc.r, max(pc.g, pc.b)), pmn = min(pc.r, min(pc.g, pc.b));
        float psat = (pmx - pmn) / max(pmx, 1e-4);
        float paint = smoothstep(0.30, 0.44, pl) * (1.0 - smoothstep(0.16, 0.26, psat));
        // (linear sRGB of #F7C412, scaled by the paint's own brightness: its shading and panel lines stay)
        vec3 yellow = vec3(0.93, 0.55, 0.006) * clamp(pl / 0.62, 0.55, 1.15);
        diffuseColor.rgb = mix(pc, yellow, paint);
      }`);
  };
  m.customProgramCacheKey = () => 'postbus-paint';
  m.needsUpdate = true;
}

function fallbackShell() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(BUS.width, 2.6, BUS.len), new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.4 }));
  body.position.y = 1.7;
  g.add(body);
  return g;
}

function buildInterior(makeRig) {
  const g = new THREE.Group();
  g.name = 'bus-interior';
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...o });
  const floorMat = M(0x3a3f46), aisleMat = M(0x55595f), wallMat = M(0xb9bdc3), roofMat = M(0xe6e6e0), frameMat = M(0x1b1e22, { roughness: 0.5 });
  const fabric = M(0x2e3a52, { roughness: 0.95 }), shellMat = M(0x5d636b, { roughness: 0.55 }), headMat = M(0xd9d4c7, { roughness: 0.9 });
  const metal = M(0xc9ccd1, { roughness: 0.3, metalness: 0.7 }), poleMat = M(0xf2c200, { roughness: 0.35, metalness: 0.3 }), dashMat = M(0x23262b, { roughness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6e6, emissive: 0xfff3dc, emissiveIntensity: 0.55, roughness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb8c8, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide });
  const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); return m; };
  const F = BUS.floor, L = BUS.len / 2 - 0.35, IW = 1.18; // floor height, half inner length, half inner width
  const WIN0 = F + 0.7, WIN1 = F + 1.78, ROOF = F + 2.08;
  box(IW * 2, 0.06, L * 2, floorMat, 0, F - 0.03, 0);
  box(0.62, 0.065, L * 2 - 2.4, aisleMat, 0, F - 0.02, -1.0);
  box(IW * 2, 0.06, L * 2, roofMat, 0, ROOF, 0);
  for (const sx of [-1, 1]) {
    box(0.06, WIN0 - F, L * 2, wallMat, sx * IW, (F + WIN0) / 2, 0);
    box(0.06, ROOF - WIN1, L * 2, roofMat, sx * IW, (WIN1 + ROOF) / 2, 0);
    box(0.09, 0.05, L * 2, frameMat, sx * (IW - 0.02), WIN0, 0);
    box(0.09, 0.05, L * 2, frameMat, sx * (IW - 0.02), WIN1, 0);
    // luggage rack (a metal rail and a glass shelf) and the light strip under it
    box(0.4, 0.025, L * 2 - 1.8, glass, sx * (IW - 0.22), WIN1 + 0.12, -0.5);
    box(0.03, 0.03, L * 2 - 1.8, metal, sx * (IW - 0.42), WIN1 + 0.12, -0.5);
    box(0.12, 0.02, L * 2 - 2.0, lampMat, sx * (IW - 0.55), ROOF - 0.035, -0.5);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(L * 2, WIN1 - WIN0), glass);
    pane.rotation.y = sx * Math.PI / 2; pane.position.set(sx * (IW + 0.01), (WIN0 + WIN1) / 2, 0);
    g.add(pane);
    for (let z = -L; z <= L + 0.01; z += 1.84) box(0.08, WIN1 - WIN0, 0.1, frameMat, sx * IW, (WIN0 + WIN1) / 2, z);
  }
  box(IW * 2, ROOF - F, 0.06, wallMat, 0, (F + ROOF) / 2, -L);
  // the cab: dashboard, windscreen, the driver's seat and wheel
  box(IW * 2, 0.5, 0.75, dashMat, 0, F + 0.55, L - 0.38);
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(IW * 2, ROOF - F - 0.8), glass);
  ws.position.set(0, (F + 0.8 + ROOF) / 2, L + 0.02); g.add(ws);
  box(IW * 2, 0.08, 0.08, frameMat, 0, F + 0.8, L);
  box(0.08, ROOF - F - 0.8, 0.08, frameMat, 0, (F + 0.8 + ROOF) / 2, L);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.022, 8, 24), dashMat);
  wheel.position.set(0.62, F + 0.95, L - 0.8); wheel.rotation.x = -1.05; g.add(wheel);
  // passenger seats, instanced: fabric cushion and back, grey shell, cream headrest cover, a grab handle (the coach
  // seat of world/coachseat.js, shared with the Wolkenspitzbahn's railcars)
  const seats = [], place = [];
  for (let k = 0, z = L - 2.6; z > -L + 0.7; k++, z -= 0.92) {
    for (const sx of [-1, 1]) for (const col of [0, 1]) {
      const x = sx * (IW - 0.3 - col * 0.47);
      place.push([x, z]);
      seats.push({ pos: new THREE.Vector3(x, F + 0.5, z), yaw: 0, window: col === 0, side: sx, row: k });
    }
  }
  for (const m of coachSeats(place.map(([x, z]) => ({ x, y: F, z, yaw: 0 })), { fabric, shell: shellMat, head: headMat, metal })) g.add(m);
  // grab poles at the doors and by the cab
  for (const [x, z] of [[-0.5, L - 1.95], [-0.5, -0.45], [0.25, L - 1.95]]) {
    const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, ROOF - F, 8), poleMat);
    pl.position.set(x, (F + ROOF) / 2, z); g.add(pl);
  }
  g.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
  // the driver (a skier from the village in a driver's jacket would do: one of the game's own people, seated)
  if (makeRig) {
    try {
      const rig = makeRig('skier_green', 'rental');
      if (rig?.root) {
        rig.gear.visible = false;
        const seat = new THREE.Vector3(0.62, F + 0.5, L - 1.35);
        rig.root.position.copy(seat);
        for (let k = 0; k < 2; k++) { rig.snapNext = true; rig.update(0.016, { mode: 'sit', seat, heading: 0, speed: 0, lookYaw: 0 }); }
        rig.root.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
        g.add(rig.root);
      }
    } catch (e) { console.warn('bus driver', e); }
  }
  g.userData.seats = seats;
  return g;
}

// ------------------------------------------------------------------ the line
export class BusLine {
  constructor({ scene, models, makeRig = null, colliders = null, cameraBlockers = null }) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'bus-roads';
    if (busRoads.roads.length) buildRoadMeshes(this.group, colliders); // (+ the guardrails' colliders)
    if (busRoads.roads.length) { try { buildScenicProps(this.group, { colliders, models }); } catch (e) { console.warn('scenic props', e); } }
    scene.add(this.group);
    this.bus = buildBus(models, makeRig);
    scene.add(this.bus.group);
    // solid while it waits (you bump off it softly, never wipe out on it) and the 3rd-person camera stays out of it
    this.collider = { x: 1e9, z: 1e9, hw: BUS.width / 2 + 0.05, hd: BUS.len / 2, rot: 0, soft: true, h: 3.4, bus: true };
    colliders?.push(this.collider);
    const blocker = new THREE.Mesh(new THREE.BoxGeometry(BUS.width, 3.1, BUS.len), new THREE.MeshBasicMaterial());
    blocker.position.y = 1.65; blocker.visible = false; // (raycasts still hit it)
    this.bus.group.add(blocker);
    cameraBlockers?.push(blocker);
    this.at = null; // the stop where the bus is waiting (null while it rides, or stopped half way)
    this.ride = null;
    this.view = 'seat';
    this.look = { yaw: 0, pitch: -0.05 };
    this.chase = { yaw: 0, pitch: 0.1, dist: 18, off: null };
    this.fov = null;
    this.timeScale = 1;
    this.parkAtVillage();
  }

  get riding() { return !!this.ride; }
  get speed() { return this.ride ? this.ride.v : 0; }

  // the stop's end of the network: the road whose end is at this stop
  parent(stop) { return busRoads.busLegs?.find((r) => r.to === stop) || busRoads.roads.find((r) => r.to === stop) || null; } // (the legs through Almdorf first: chaletroad.js)
  // roads from a stop up to the village (the network is a tree rooted at the village)
  toRoot(stop) {
    const out = [];
    for (let s = stop, g = 0; g < 20; g++) { const r = this.parent(s); if (!r) break; out.push(r); s = r.from; }
    return out;
  }
  /**
   * The ride between two stops: its legs, one road each (null when the network does not connect them). Where the
   * route passes another stop the roads meet end to end (the next one leaves the way the last one came in), so
   * the bus stops there and turns for the next leg.
   */
  legs(from, to) {
    if (!busRoads.roads.length || from === to) return null;
    const up = this.toRoot(from), down = this.toRoot(to);
    // drop the common part (both reach the village through it)
    while (up.length && down.length && up[up.length - 1] === down[down.length - 1]) { up.pop(); down.pop(); }
    const reach = (s, list) => (list.length ? list[list.length - 1].from : s);
    if (reach(from, up) !== reach(to, down)) return null;
    const out = [];
    for (const r of up) out.push(this.leg(r, true));
    for (let k = down.length - 1; k >= 0; k--) out.push(this.leg(down[k], false));
    return out.every(Boolean) && out.length ? out : null;
  }

  // one road driven forward (or in reverse) as a trip: points, arc lengths, the speed profile, start / stop marks
  leg(r, rev) {
    const n = r.n;
    if (n < 4) return null;
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), S = new Float32Array(n);
    for (let k = 0; k < n; k++) { const i = rev ? n - 1 - k : k; X[k] = r.X[i]; Y[k] = r.Y[i]; Z[k] = r.Z[i]; if (k) S[k] = S[k - 1] + Math.hypot(X[k] - X[k - 1], Z[k] - Z[k - 1]); }
    const t = { n, X, Y, Z, S, length: S[n - 1], to: rev ? r.from : r.to };
    // speed limit along it: slower in the bends (lateral acceleration), from and to a standstill at the stops
    const V = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 4), b = Math.min(n - 1, i + 4);
      const h0 = Math.atan2(X[Math.min(n - 1, a + 1)] - X[a], Z[Math.min(n - 1, a + 1)] - Z[a]);
      const h1 = Math.atan2(X[b] - X[Math.max(0, b - 1)], Z[b] - Z[Math.max(0, b - 1)]);
      const dh = Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)));
      const k = dh / Math.max(1, S[b] - S[a]);
      V[i] = Math.min(BUS.cruise, Math.sqrt(BUS.lat / Math.max(1e-4, k)));
    }
    V[0] = 0; V[n - 1] = 0;
    const end = Math.max(0, S[n - 1] - BAY), start = Math.min(BAY, S[n - 1] / 2);
    for (let i = 0; i < n; i++) if (S[i] >= end) V[i] = 0;
    for (let i = n - 2; i >= 0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] ** 2 + 2 * BUS.brake * (S[i + 1] - S[i])));
    for (let i = 1; i < n; i++) if (S[i] > start) V[i] = Math.min(V[i], Math.sqrt(V[i - 1] ** 2 + 2 * BUS.acc * (S[i] - S[i - 1])));
    t.V = V; t.s0 = start; t.s1 = end;
    return t;
  }

  // place the bus with its middle at arc length s of trip t (front and rear axles on the road, in the right lane)
  place(t, s, shift = this.ride?.shift || 0) {
    const half = 3.0;
    roadAt(t, s + half, _p); roadAt(t, s - half, _q);
    const lane = BUS.lane * (1 - 2 * shift); // (overtaking: out into the other lane)
    // (the right-hand lane: right of the heading (dx, dz) is (-dz, dx))
    _a.set(_p.x - _p.dz * lane, _p.y, _p.z + _p.dx * lane);
    _b.set(_q.x - _q.dz * lane, _q.y, _q.z + _q.dx * lane);
    const g = this.bus.group;
    g.position.addVectors(_a, _b).multiplyScalar(0.5);
    _m.lookAt(_b, _a, _up);
    g.quaternion.setFromRotationMatrix(_m);
    g.rotateY(Math.PI);
    g.updateMatrixWorld(true);
    // the collider follows (off while you ride inside)
    const c = this.collider;
    if (c) {
      const yaw = Math.atan2(_a.x - _b.x, _a.z - _b.z);
      c.x = this.ride ? 1e9 : g.position.x; c.z = this.ride ? 1e9 : g.position.z; c.rot = -yaw; this.yaw = yaw;
    }
  }

  /** The stop the bus waits at when p is within `m` metres of its body (null otherwise). */
  waitingAt(p, m = 7) {
    if (this.ride || !this.at || !this.bus.group.visible) return null;
    const g = this.bus.group.position, yaw = this.yaw || 0;
    const dx = p.x - g.x, dz = p.z - g.z;
    const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const ex = Math.max(0, Math.abs(lx) - BUS.width / 2), ez = Math.max(0, Math.abs(lz) - BUS.len / 2);
    return Math.hypot(ex, ez) < m ? this.at : null;
  }

  // between rides the bus waits at the village stop
  parkAtVillage() {
    const v = busRoads.stops[0], r = busRoads.roads.find((x) => x.from === v);
    if (!r) { this.bus.group.visible = false; return; }
    const t = { n: r.n, X: r.X, Y: r.Y, Z: r.Z, S: r.S };
    this.place(t, Math.min(BAY, r.length / 2));
    this.bus.group.visible = true;
    this.at = v;
  }

  /** Can the bus take you from stop a to stop b? */
  canRide(a, b) { return !!this.legs(a, b); }

  /** Board at `from` for `to`: the bus stands at the stop with you in a window seat. Returns the seat or null. */
  board(from, to) {
    const legs = this.legs(from, to);
    if (!legs) return null;
    const t = legs[0];
    const seat = this.bus.seats.find((s) => s.window && s.side < 0 && s.row === 2) || this.bus.seats[0];
    this.ride = { legs, li: 0, t, s: t.s0, v: 0, from, to, seat, wait: 2.2, done: false, exitSent: false, turning: false };
    this.at = null;
    this.look.yaw = -0.35; this.look.pitch = -0.05;
    this.view = 'seat'; this.fov = null; this.chase.off = null;
    this.bus.group.visible = true;
    this.place(t, t.s0);
    this.setInside(true);
    return this.seatPose();
  }

  setInside(on) { this.bus.inside.visible = on; this.bus.shell.visible = !on; }

  seatPose() {
    const r = this.ride, g = this.bus.group;
    g.updateMatrixWorld(true);
    const pos = r.seat.pos.clone();
    g.localToWorld(pos);
    const fwd = new THREE.Vector3(0, 0, 1).transformDirection(g.matrixWorld);
    fwd.y = 0; fwd.normalize();
    return { pos, fwd };
  }

  /** Per frame while riding: { seat, hint } or { exit } once you are there (main.js fades out, then abort()). */
  updateRide(dt, fast = false) {
    const r = this.ride;
    if (!r) return null;
    this.timeScale = fast ? 8 : 1;
    let t = r.t;
    // at a stop on the way: the bus turns there for the next leg (behind a short fade)
    if (r.done && r.li < r.legs.length - 1) {
      r.arrive -= dt;
      if (r.arrive <= 0 && !r.turning) {
        r.turning = true;
        const next = () => { r.li++; r.t = r.legs[r.li]; r.s = r.t.s0; r.v = 0; r.done = false; r.wait = 1.4; r.turning = false; r.passing = false; r.shift = 0; this.place(r.t, r.s); };
        transition.fade(async () => { if (this.ride === r) next(); }).catch(() => { if (this.ride === r) next(); });
      }
      this.place(t, r.s);
      return { seat: this.seatPose(), hint: `${t.to.name} · the bus turns here for ${r.to.name}` };
    }
    if (r.wait > 0) r.wait -= dt;
    else if (!r.done) {
      const h = dt * this.timeScale;
      roadAt(t, r.s, _p);
      const i = _p.i, k = (r.s - t.S[i]) / Math.max(1e-3, t.S[Math.min(t.n - 1, i + 1)] - t.S[i]);
      let vt = Math.max(r.s < t.s1 - 0.5 ? 1.2 : 0, lerp(t.V[i], t.V[Math.min(t.n - 1, i + 1)], clamp(k, 0, 1)));
      // anything in its lane ahead, along the road it drives (round the bends too): the traffic (it follows a car at
      // a safe gap, brakes for one stopped, crashed or turning), parked / shoved cars and the car you left on the
      // road, a train or a helicopter in the way (traffic.js trafficBlockers). It never drives through one: it
      // brakes in time and waits. A traffic car that has held it at a standstill for 3 s is taken off the road
      // (traffic.js despawn); a shoved parked car goes back to its bay by itself (drive.js)
      try { vt = Math.min(vt, this.clearAhead(t, r, dt, vt)); } catch (e) { if (!this.clearWarn) { this.clearWarn = true; console.warn('bus clearance', e); } }
      r.shift = (r.shift || 0) + clamp((r.passing ? 1 : 0) - (r.shift || 0), -0.45 * h, 0.45 * h); // (~2 s to change lanes)
      r.v += clamp(vt - r.v, -BUS.brake * 2 * h, BUS.acc * 1.5 * h);
      r.s = Math.min(t.s1, r.s + r.v * h);
      if (r.s >= t.s1 - 0.05) { r.done = true; r.v = 0; r.arrive = 1.2; }
    } else r.arrive -= dt;
    this.place(t, r.s);
    const seat = this.seatPose();
    if (r.done && r.arrive <= 0 && !r.exitSent) {
      r.exitSent = true;
      // out through the front door (right side), clear of the bus, facing the way it points (the camera behind
      // you then looks along the bus's side, not into it)
      const g = this.bus.group;
      const door = g.localToWorld(_c.set(-(BUS.width / 2 + 1.8), 0, BUS.len / 2 - 2.0));
      const fw = new THREE.Vector3(0, 0, 1).transformDirection(g.matrixWorld);
      return { seat, exit: { x: door.x, z: door.z, heading: Math.atan2(fw.x, fw.z), name: r.to.name }, hint: `${r.to.name} · arrived` };
    }
    let left = Math.max(0, t.s1 - r.s);
    for (let k = r.li + 1; k < r.legs.length; k++) left += r.legs[k].s1 - r.legs[k].s0;
    const hint = r.done ? `${r.to.name} · arrived` : r.wait > 0 ? `Ski bus to ${r.to.name} · doors closing` : `Ski bus to ${r.to.name} · ${(left / 1000).toFixed(1)} km · ${Math.round(r.v * 3.6)} km/h`;
    return { seat, hint };
  }

  // the speed (m/s) the bus may drive at so it stops short of whatever stands in its lane ahead (trip t, ride r).
  // (Oct 28, the user: "the bus should overtake"): held up behind something stopped or crawling in its lane, with the
  // other lane clear far enough ahead (oncoming traffic included) and the road going on long enough, it pulls out,
  // passes and pulls back in once its lane is clear beside and just ahead of it
  clearAhead(t, r, dt, want = BUS.cruise) {
    const obs = this.obstacles(), g = this.bus.group.position;
    const sh = r.shift || 0;
    if (!obs.length) { r.heldT = 0; r.slowT = 0; r.passing = false; return Infinity; }
    const look = 30 + (r.v * r.v) / (2 * CLEAR_DEC), far = Math.max(look, 150);
    const i0 = roadAt(t, r.s - BUS.len, _p).i, i1 = roadAt(t, r.s + far, _p).i + 1;
    let lim = Infinity, blocker = null, own = null, otherNear = false, otherAhead = Infinity, ownBeside = false;
    for (const o of obs) {
      if (Math.abs(o.x - g.x) > far + 12 || Math.abs(o.z - g.z) > far + 12) continue;
      if (o.y !== undefined && Math.abs(o.y - g.y) > 5) continue; // (a train in a tunnel under the road)
      // the nearest point of the road: how far along, how far to the side of the centre line
      let bj = -1, bd = Infinity;
      for (let j = i0; j <= Math.min(t.n - 2, i1); j++) { const d = (t.X[j] - o.x) ** 2 + (t.Z[j] - o.z) ** 2; if (d < bd) { bd = d; bj = j; } }
      if (bj < 0) continue;
      const hx = t.X[bj + 1] - t.X[bj], hz = t.Z[bj + 1] - t.Z[bj], hl = Math.hypot(hx, hz) || 1, ux = hx / hl, uz = hz / hl;
      const dx = o.x - t.X[bj], dz = o.z - t.Z[bj], s = t.S[bj] + dx * ux + dz * uz;
      const latC = -dx * uz + dz * ux; // (right of the heading (ux, uz) is (-uz, ux))
      const ca = Math.abs(Math.sin(o.yaw) * ux + Math.cos(o.yaw) * uz), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
      const across = o.hw * ca + o.hd * sa, along = o.hw * sa + o.hd * ca, W = BUS.width / 2 + across + 0.35;
      const inOwn = Math.abs(latC - BUS.lane) < W, inOther = Math.abs(latC + BUS.lane) < W;
      const ds = s - r.s, vAlong = (o.v || 0) * (Math.sin(o.yaw) * ux + Math.cos(o.yaw) * uz);
      // the other lane: anything near the bus or ahead of it there (something coming the other way: further ahead,
      // by how far it closes in while the bus passes)
      if (inOther) {
        const reach = ds - Math.max(0, -vAlong) * 9;
        if (ds > -BUS.len / 2 - along - 3 && ds < BUS.len / 2 + along + 6) otherNear = true;
        if (ds > 0) otherAhead = Math.min(otherAhead, reach - BUS.len / 2 - along);
      }
      if (inOwn && ds > -(BUS.len / 2 + along + 8) && ds < BUS.len / 2 + along + 30) ownBeside = true; // (beside it, still ahead in its lane, or not yet 8 m behind)
      // the lanes the bus is in now: its own until well out, the other one from part way across
      const counts = (inOwn && sh < 0.85 && !(r.passing && sh > 0.15)) || (inOther && sh > 0.15);
      if (!counts) continue;
      const gap = ds - BUS.len / 2 - along;
      if (ds < 0 || gap > look) continue;
      // going the bus's way: follow at its speed; anything else: stop short of it
      const vo = Math.max(0, vAlong);
      const room = gap - CLEAR_GAP, v = room > 0 ? Math.sqrt(vo * vo + 2 * CLEAR_DEC * room) : 0;
      if (v < lim) { lim = v; blocker = o; }
      if (inOwn && (!own || gap < own.gap)) own = { gap, vo, along };
    }
    // overtaking: held up for 1.5 s behind something in its own lane going clearly slower than the bus wants to
    // (Oct 29, the user: "the bus still doesn't overtake, it just drives behind the car super slow": a moving car
    // counts too, not only a stopped one). The road it needs: the bus closes the gap, its own length, the car's and
    // a margin at the speed difference, at its own speed; the other lane must be clear that far (oncoming
    // traffic's approach included) and the road must go on that far
    const vWant = Math.max(8, Math.min(want, BUS.cruise));
    const slowed = own && own.gap < 45 && own.vo < vWant * 0.8 && r.v < vWant * 0.85;
    r.slowT = slowed ? (r.slowT || 0) + dt : 0;
    if (!r.passing && r.slowT > 1.5) {
      const rel = Math.max(3, vWant - own.vo), past = own.gap + 2 * own.along + BUS.len + 12;
      const need = Math.min(450, (past / rel) * vWant + 20);
      if (!otherNear && otherAhead > need && t.s1 - r.s > need + 10) { r.passing = true; r.slowT = 0; }
    }
    // back in once its own lane is clear beside it and just ahead (or the other lane gets busy ahead: back in as
    // soon as there is room)
    if (r.passing && !ownBeside) r.passing = false;
    // still behind it and something now comes in the other lane: give up, back in behind it
    if (r.passing && own && own.gap > 0 && otherAhead < own.gap + 2 * own.along + BUS.len + 10) r.passing = false;
    r.heldT = blocker && r.v < 0.5 ? (r.heldT || 0) + dt : 0;
    if (r.heldT > 3 && blocker?.car && this.traffic?.despawn) { this.traffic.despawn(blocker.car); r.heldT = 0; }
    return lim;
  }
  // everything the bus must not drive through, as boxes { x, y, z, yaw, hw, hd, v, car (a traffic car) }
  obstacles() {
    const out = (this._obs ||= []), pool = (this._obsPool ||= []);
    out.length = 0;
    let n = 0;
    const add = (x, y, z, yaw, hw, hd, v = 0, car = null) => { const o = (pool[n++] ||= {}); o.x = x; o.y = y; o.z = z; o.yaw = yaw; o.hw = hw; o.hd = hd; o.v = v; o.car = car; out.push(o); };
    const tr = this.traffic;
    for (const c of tr?.cars || []) if (c.mode !== 'gone' && c.sinkT === undefined) add(c.x, c.y, c.z, c.yaw, c.w / 2, c.l / 2, c.mode === 'road' ? c.v : 0, c);
    for (const e of tr?.parking?.cars || []) if (!e.driving) { const p = e.car.position; add(p.x, p.y, p.z, e.car.rotation.y, 0.97, (e.length || 4.6) / 2); }
    const d = tr?.you?.d;
    if (d) add(d.x, d.y, d.z, d.yaw, d.w / 2, d.half);
    for (const b of trafficBlockers()) add(b.x, b.y, b.z, b.yaw, b.hw, b.hd);
    return out;
  }

  abort() {
    if (!this.ride) return;
    const r = this.ride;
    this.ride = null;
    // there: it waits at that stop (stopped half way by a teleport: it is not at a stop)
    this.at = r.exitSent ? r.to : null;
    this.place(r.t, r.s);
    this.setInside(false);
    this.timeScale = 1;
  }

  /** Seat or outside camera while riding (after player.update). R switches; the mouse looks around. */
  applyCamera(camera, input, dt) {
    const r = this.ride;
    if (!r) return false;
    if (input?.hit?.('KeyR')) { this.view = this.view === 'seat' ? 'outside' : 'seat'; this.chase.off = null; this.setInside(this.view === 'seat'); }
    const sens = 0.0022 * (input?.sensitivity || 1);
    const g = this.bus.group;
    g.updateMatrixWorld(true);
    const k6 = 1 - Math.exp(-dt * 6);
    if (this.view === 'seat') {
      // (Oct 29, the user: "you can't really look and turn the camera"): all the way round from the seat, and well
      // up and down
      this.look.yaw = wrapPi(this.look.yaw - (input?.mdx || 0) * sens);
      this.look.pitch = clamp(this.look.pitch - (input?.mdy || 0) * sens, -1.2, 1.2);
      const eye = _a.copy(r.seat.pos).add(_b.set(0, 0.84, 0.04));
      g.localToWorld(eye);
      const yaw = this.look.yaw;
      const dir = _c.set(Math.sin(yaw) * Math.cos(this.look.pitch), Math.sin(this.look.pitch), Math.cos(yaw) * Math.cos(this.look.pitch)).transformDirection(g.matrixWorld);
      camera.position.copy(eye);
      camera.up.copy(_up);
      camera.lookAt(eye.add(dir));
      camera.near = 0.05;
      this.fov = this.fov == null ? 70 : lerp(this.fov, 70, k6);
    } else {
      this.chase.yaw -= (input?.mdx || 0) * sens;
      this.chase.pitch = clamp(this.chase.pitch - (input?.mdy || 0) * sens, -0.25, 1.1); // (down to eye level, not only from above)
      this.chase.dist = clamp(this.chase.dist + (input?.wheel || 0) * 2, 10, 60);
      const target = _a.copy(g.position).add(_b.set(0, 2.2, 0));
      const fwd = _c.set(0, 0, 1).transformDirection(g.matrixWorld);
      const heading = Math.atan2(fwd.x, fwd.z) + Math.PI + this.chase.yaw, d = this.chase.dist, cp = Math.cos(this.chase.pitch);
      const want = new THREE.Vector3(Math.sin(heading) * cp * d, Math.sin(this.chase.pitch) * d + 0.8, Math.cos(heading) * cp * d);
      const gy = world.height(target.x + want.x, target.z + want.z) + 2;
      if (target.y + want.y < gy) want.y = gy - target.y;
      if (!this.chase.off) this.chase.off = want.clone(); else this.chase.off.lerp(want, 1 - Math.exp(-dt * 4));
      camera.position.copy(target).add(this.chase.off);
      camera.up.copy(_up);
      camera.lookAt(target);
      camera.near = 0.1;
      this.fov = this.fov == null ? 60 : lerp(this.fov, 60, k6);
    }
    camera.fov = this.fov;
    camera.updateProjectionMatrix();
    return true;
  }
}
export const railsForTest = { planRails, railRuns }; // (Node checks)
