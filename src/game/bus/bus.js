// The ski bus at runtime: the plowed roads (a packed-snow strip, snow banks from the plough, orange snow poles),
// the yellow post bus (the Busscar Micruss, models.ski_bus_micruss: its own cabin behind tinted glass, wheels that
// roll and steer; without it the old Meshy shell, models.ski_bus, with our own simple interior: seats, poles, glass,
// a driver's cab) and the ride itself: you sit by a window, the bus drives the road to your stop in real time; mouse
// to look around, R for an outside view, hold Space to fast-forward. Modelled on the Wolkenspitzbahn ride (railway.js).
//
// SkiBus (skibus.js) owns one BusLine: busLine.board(from, to) -> seat; per frame update / updateRide /
// applyCamera; main.js does the fades, the player's seat and the HUD line.
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { coachSeats } from '../../world/coachseat.js';
import { fitModel } from '../../core/assets.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { conformGeometry } from '../../world/groundpatch.js'; // (the strips laid on the drawn terrain's own triangles where it bends)
import { busRoads, roadAt, ROAD_HALF, roadsideBlocked, laneDistance } from './roads.js';
import { transition } from '../../ui/transition.js';
import { trafficBlockers, addTrafficBlocker } from '../traffic.js';
import { buildRoadSigns } from './roadsigns.js'; // speed limit and warning signs along the roads
import { breakables } from '../../world/breakables.js'; // (the snow poles and reflector posts: knocked flying by a car)
import { buildScenicProps } from './scenicprops.js'; // benches, view boards, walls, give-way signs, the roundabouts' islands
import { depotTrips } from './depot.js'; // the bus depot off the village stop: each bus's own bay, its ways in and out
import { buildDepot } from './depotview.js'; // (its paving, bay lines, lamps and sign)
import { people } from '../peoplehits.js'; // (the people about: the bus stops for them in its lane)
import { isMP } from '../../net/mode.js';
import { ST } from '../../net/protocol.js'; // (a remote player's state: seated / riding ones are not in the road)
import { buildJunctionMouths } from './junctionview.js'; // (where a road joins another: one surface, rounded corners, give-way line)

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// (len: Oct 31 2026, the user: "The bus is a bit too stretched": 9.3 m, not 12; the Micruss is 8.44 m long at its
// 2.55 m width, so only ~1.1x stretched now; the colliders, the queues at a stop, the look-ahead and the door follow it)
export const BUS = { len: 9.3, width: 2.55, floor: 0.95, lane: 1.55, cruise: 26, acc: 1.7, brake: 2.0, lat: 2.6 };
const CLEAR_DEC = 1.8, CLEAR_GAP = 4; // braking for something in the lane (m/s^2, within its 2.6 limit); the gap it stops at (m)
const BAY = 7; // the bus stops this far before the end of the road (its middle)
// Something in its lane (Oct 30, the user: "make sure the bus stops for you and if the person doesn't move it
// overtakes nice, smoothly and realistically ... make sure the bus just drives through or rams through after 20 sec"):
// it brakes to a stop STOP_GAP short of something standing (CLEAR_GAP behind something moving), sounds its horn after
// HORN_T, pulls round it after PASS_WAIT if the other lane is clear (an eased S-curve at PASS_V, steering along its
// path), and after RAM_T held up in all it drives on through at RAM_V (people in the way are hit as by any vehicle,
// vehiclehits.js; cars are shoved aside). The delay is caught up before its next stop (CATCH, more when it must).
const STOP_GAP = 6, PASS_WAIT = 3, PASS_V = 5, HORN_T = 2, RAM_T = 20, RAM_V = 4.2;
const CATCH = 0.15, CATCH_MAX = 0.4; // extra speed over the timetable's while behind it (share), and at most
const LATE_HOLD = 4;                 // s a bus that got to a stop after its timetable left still stands there
// Multiplayer: one bus, one place for everyone (Oct 30, the user: "why do I see a bus but other people don't
// sometimes?"). A bus held up near you is driven by your client (clearAhead, fleetDrive) and reported to the server
// (busHold: how far behind its timetable it is, s, how fast that grows, how far out in the other lane, pushing through
// or not, how long held up) about 4 times a second; the server stamps the record with its clock and sends it to
// everyone, and every other client places that bus from it: the timetable `d` s ago, that lane offset (followStep,
// eased). A record whose reports stopped (its driver went away) ages out the same way everywhere, the server included
// (holdAt: the delay caught up at CATCH s/s, the lane offset eased back): everyone converges. A client following a
// record that sees the bus run into something there (its own player, its car, ... mustTake) drives it from then on
// (its report has the longer delay: the server hands it the record). Single player: no records, as before.
// Mirror of server/lib/server.js busHoldAt / BUS_HOLD (keep the two the same).
export const HOLD = { FRESH: 1, CATCH: 0.2, SHIFT: 0.35, MAX: 60 };
const REPORT_MS = 250;               // a bus you drive off its timetable: reported this often (and at once on a change)
export function holdAt(rec, now, out = {}) {
  const el = Math.max(0, (now - rec.at) / 1000), f = Math.min(el, HOLD.FRESH), late = el - f;
  out.fresh = el < HOLD.FRESH;
  out.d = clamp(rec.d + (rec.dd || 0) * f - HOLD.CATCH * late, 0, HOLD.MAX);
  out.sh = clamp((rec.sh || 0) + (rec.sv || 0) * f - HOLD.SHIFT * late, 0, 1);
  out.ram = !!rec.ram && out.fresh;
  out.bt = (rec.bt || 0) + (out.fresh ? el : 0);
  out.done = !out.fresh && out.d <= 0 && out.sh <= 0;
  out.own = rec.own;
  return out;
}
const game = () => { try { return globalThis.__game || null; } catch { return null; } }; // (main.js: the audio, multiplayer)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
const _p = {}, _q = {};
const _mpf = new THREE.Vector3(); // (multiplayer: a seat's facing)
const sameStop = (a, b) => !!a && !!b && (a === b || a.name === b.name);

// ------------------------------------------------------------------ road meshes
// The road surface, 6.8 m across x 13.5 m along: worn asphalt, white edge lines and a dashed centre line, grit; the
// snow over it (tracks, edges, patches) is drawn by the shader (snowCover).
function roadTexture(plain = false) {
  const W = 512, H = 1024, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // worn asphalt with a fine grain (light: under the blue snow light a dark grey reads as navy)
  g.fillStyle = '#6a6b6d'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) { const v = 84 + rnd() * 44; g.fillStyle = `rgba(${v + 4},${v + 2},${v},0.5)`; g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2); }
  // markings (white, worn; none on the plain asphalt: the car parks)
  g.fillStyle = 'rgba(236,238,240,0.85)';
  if (!plain) {
    g.fillRect(W * 0.045, 0, W * 0.022, H); g.fillRect(W * 0.933, 0, W * 0.022, H);
    g.fillRect(W * 0.492, H * 0.08, W * 0.016, H * 0.3); g.fillRect(W * 0.492, H * 0.58, W * 0.016, H * 0.3);
  }
  // (the snow on it: shader noise in world space, snowCover below; no painted bands or flecks to repeat)
  for (let i = 0; i < 1800; i++) { const v = 80 + rnd() * 50; g.fillStyle = `rgba(${v + 18},${v + 8},${v},0.5)`; g.fillRect(rnd() * W, rnd() * H, 1.5, 1.5); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = plain ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

const ROAD_DECAL = 0.0015; // (roads and car parks alike: they never overlap)
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
varying float vRoadEnd;
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
    tr *= vRoadEnd; // (fading out into a car park)
    float fine = rdF(Wp * 0.9), P = rdF(Wp * 0.03 + 4.0);
    float clearT = smoothstep(0.3, 0.7, rdN(vec2(sv * 0.012, 5.5))) * (0.6 + 0.4 * fine);
    float eN = rdN(vec2(sv * 0.15, 2.2)) * 0.07 + (fine - 0.5) * 0.06;
    float edge = 1.0 - smoothstep(0.06 + eN, 0.16 + eN, u) + smoothstep(0.84 - eN, 0.94 - eN, u);
    #ifdef ROAD_LOT
    edge = 0.0; // (a car park: its edges fade into the snow by their vertex alpha)
    #endif
    float snow = clamp(1.0 - tr * clearT, 0.0, 1.0) * smoothstep(0.22, 0.55, P + 0.3 * fine - 0.1);
    float bare = smoothstep(0.6, 0.78, P);
    snow = max(snow * (1.0 - bare * 0.9), clamp(edge, 0.0, 1.0));
    float slush = (1.0 - snow) * smoothstep(0.35, 0.7, rdF(Wp * 0.06 + 11.0)) * (1.0 - bare);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.29, 0.28) * (0.85 + 0.3 * fine), slush * 0.75);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.84, 0.89) * (0.88 + 0.16 * fine), snow * (0.7 + 0.3 * fine));
    rdWet = slush;
  }
`;
function snowCover(mat, key, lot = false) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  if (lot) mat.defines = { ...(mat.defines || {}), ROAD_LOT: '' };
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRoadW;\nvarying float vRoadEnd;${lot ? '' : '\nattribute float aEnd;'}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvRoadW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvRoadEnd = ${lot ? '0.0' : 'aEnd'};`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${SNOW_GLSL}\nfloat rdWet = 0.0;`)
      // (into a car park the markings fade out too: the plain asphalt beside them, the same v)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${lot ? '' : 'diffuseColor.rgb = mix(diffuse * texture2D(map, vec2(0.3, vMapUv.y)).rgb, diffuseColor.rgb, vRoadEnd);'}\n${SNOW_FRAG}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= 1.0 - 0.4 * rdWet;');
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}-roadsnow-${key}`;
  return mat;
}

// The roads' material, and the car parks' (parking.js): the same asphalt (without markings), the same snow, slush
// and bare patches in world space, so where an access road meets its car park the two surfaces carry on into each
// other (no tyre tracks or ploughed edges on the car park; its edges fade into the snow by vertex alpha)
let _roadMat = null, _lotMat = null;
export function roadMaterial() {
  return (_roadMat ||= snowCover(decal(new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.72, metalness: 0 }), ROAD_DECAL), 'road'));
}
export function lotMaterial() {
  return (_lotMat ||= snowCover(decal(new THREE.MeshStandardMaterial({ map: roadTexture(true), roughness: 0.72, metalness: 0, vertexColors: true, transparent: true, side: THREE.DoubleSide }), ROAD_DECAL), 'lot', true));
}
// a junction's mouth (junctionview.js): the car parks' plain asphalt and snow, laid over the two roads' edges where they
// join (drawn a hair nearer than the roads, its edges fading into the snow by vertex alpha)
let _mouthMat = null;
function junctionMaterial() {
  return (_mouthMat ||= snowCover(decal(new THREE.MeshStandardMaterial({ map: lotMaterial().map, roughness: 0.72, metalness: 0, vertexColors: true, transparent: true, depthWrite: false }), 0.0018), 'mouth', true));
}

const ACROSS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];

// Where a road's strip ends against something drawn on its own (the road it joins, a roundabout's ring, a car park),
// the strip is cut along that thing's edge: each of its long lines (ACROSS) stops exactly where it enters the other
// surface, so the two meet edge to edge, never one lying over the other (no coplanar double layer, no z-fighting, no
// draw-order or depth-offset tricks). endHosts(r) -> [at the start, at the end]: null, or { inside(x, z) }.
const lotsDrawn = () => busRoads.lots.filter((L) => (!L.building || L.depot) && L.ux !== undefined); // (the bus depot: depotview.js)
function lotInside(L, pad0 = 0) {
  return (x, z, pad = pad0) => { const dx = x - L.x, dz = z - L.z; return Math.abs(dx * L.ux + dz * L.uz) < L.hw + pad && Math.abs(dx * L.vx + dz * L.vz) < L.hd + pad; };
}
function roadInside(B) {
  const open = !B.ringRoad; // (an open road's strip ends square at its ends: no round cap past them)
  return (x, z, pad = 0) => {
    for (let i = 0; i < B.n - 1; i++) {
      const ax = B.X[i], az = B.Z[i];
      if (Math.abs(ax - x) > 12 || Math.abs(az - z) > 12) continue;
      const dx = B.X[i + 1] - ax, dz = B.Z[i + 1] - az, l2 = dx * dx + dz * dz || 1, t0 = ((x - ax) * dx + (z - az) * dz) / l2;
      if (open && ((i === 0 && t0 < 0) || (i === B.n - 2 && t0 > 1))) continue;
      const t = clamp(t0, 0, 1);
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < ROAD_HALF + pad) return true;
    }
    return false;
  };
}
// which of two roads ending in each other gives way (is cut): an access road to a bus road, a road to a ring, else
// the shorter one
const roadRank = (r) => (r.ringRoad ? 3 : r.access ? 1 : 2);
function endHosts(r) {
  return [0, r.n - 1].map((i) => {
    const x = r.X[i], z = r.Z[i];
    // a car park the road runs into (its end inside the car park or at its edge)
    for (const L of lotsDrawn()) if (lotInside(L, 2.5)(x, z)) return { lot: L, inside: lotInside(L) };
    // the road it joins (its end on that road's strip, not where that road ends too: a road carrying on from another)
    let best = null;
    busRoads.roads.forEach((B) => {
      if (B === r) return;
      if (!B.ringRoad && [0, B.n - 1].some((k) => Math.hypot(B.X[k] - x, B.Z[k] - z) < 1.5)) return;
      for (let k = 0; k < B.n - 1; k++) {
        const ax = B.X[k], az = B.Z[k];
        if (Math.abs(ax - x) > 12 || Math.abs(az - z) > 12) continue;
        const dx = B.X[k + 1] - ax, dz = B.Z[k + 1] - az, l2 = dx * dx + dz * dz || 1, t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < ROAD_HALF - 0.05 && (!best || d < best.d)) best = { d, B };
      }
    });
    if (best) { // (the two ending in each other, e.g. an access road joining at a bus road's last stop: only one is cut)
      const B = best.B, inR = roadInside(r);
      if ([0, B.n - 1].some((k) => inR(B.X[k], B.Z[k])) && (roadRank(r) > roadRank(B) || (roadRank(r) === roadRank(B) && r.length > B.length))) return null;
    }
    return best ? { road: best.B, inside: roadInside(best.B) } : null;
  });
}

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
    const s0 = this.segs.length;
    for (let k = 0; k < m - 1; k++) this.segs.push({ a: pts[k], b: pts[k + 1], ta: tan(k), tb: tan(k + 1) });
    // colliders along the standing stretch (not the buried ends): the car's lines, and thin boxes (merged along
    // straight bits, up to 12 m) for everything else
    let k0 = 0, k1 = m - 1;
    while (k0 < m && pts[k0][3] > 0.35) k0++;
    while (k1 >= 0 && pts[k1][3] > 0.35) k1--;
    for (let k = k0; k < k1; k++) {
      const rk = this.addRail(pts[k][0], pts[k][2], pts[k + 1][0], pts[k + 1][2]);
      if (busRoads.rails?.[rk]) busRoads.rails[rk].seg = this.segs[s0 + k]; // (its drawn section: broken through at 100 km/h+, world/breakables.js)
    }
    if (!this.colliders) return;
    // the boxes: exactly as high as the drawn beam (its top BEAM_TOP over the rail's foot, which the shader lays
    // along the run linearly between the points, less the terminal's sink). A box's top slopes with the beam: topA
    // at its start, topB at its end (local -z .. +z), each point between within RAIL_DY of that line (top: the
    // highest, for whatever reads only that); merged along straight bits up to 12 m. Not a step-up surface (noStep:
    // you don't walk along the top of a guardrail; you jump over it, or ski over it on a jump)
    const RAIL_DY = 0.03;
    const topAt = (k) => pts[k][1] - pts[k][3] + BEAM_TOP;
    for (let a = k0; a < k1;) {
      let b = a + 1;
      while (b < k1) {
        const nb = b + 1, ax = pts[a][0], az = pts[a][2], ex = pts[nb][0] - ax, ez = pts[nb][2] - az, l = Math.hypot(ex, ez) || 1;
        if (l > 12) break;
        let ok = true;
        for (let q = a + 1; q < nb && ok; q++) {
          if (Math.abs((pts[q][0] - ax) * ez - (pts[q][2] - az) * ex) / l > 0.06) ok = false;
          const f = ((pts[q][0] - ax) * ex + (pts[q][2] - az) * ez) / (l * l);
          if (Math.abs(topAt(q) - (topAt(a) + (topAt(nb) - topAt(a)) * f)) > RAIL_DY) ok = false;
        }
        if (!ok) break;
        b = nb;
      }
      const ax = pts[a][0], az = pts[a][2], bx = pts[b][0], bz = pts[b][2], l = Math.hypot(bx - ax, bz - az) || 1;
      const topA = topAt(a), topB = topAt(b);
      const box = { x: (ax + bx) / 2, z: (az + bz) / 2, hw: 0.075, hd: l / 2 + 0.06, rot: -Math.atan2(bx - ax, bz - az), h: BEAM_TOP, top: Math.max(topA, topB), topA, topB, soft: true, rail: true, noStep: true };
      this.colliders.push(box);
      for (let q = a; q < b; q++) (this.segs[s0 + q].boxes ||= []).push(box); // (parked away while that section is broken)
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
        list.forEach((s, k) => { (s.ims ||= []).push(im); s.k = k; }); // (hidden while broken through: world/breakables.js)
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

// The drawn strip of road r: rows of ACROSS.length vertices, two rows per road sample (~2 m apart, ~1.1 m across),
// each vertex on the drawn terrain's own surface (world.meshHeight, its 2 m triangles) + 3.5 cm; cut where it ends
// against another road or a car park (endHosts). end: per vertex 0..1, 0 over the last metres into a car park (the
// tyre tracks and the centre line fade out there: the car park's own surface carries on, the same asphalt and snow).
// { R (the centre line), dirAt(i), pos (rows x across x 3), uv, end, rows, hosts }
function roadStrip(r, MH) {
  const R = r;
  // a stop on the way (one road ends where the next one starts): both strips end on the same cross-section (the
  // bisector of their headings) and the texture runs on (v carries on from the road before), so they meet edge to
  // edge; before, the two strips overlapped in a wedge at the stop and z-fought (crossed light / dark bands)
  // (Oct 31 2026, the user, with a screenshot of the Legacy Village stop, 116 m from the gondola: "fix road stuff like
  // these": the Depotweg (an access road, depot.js) carries on from the village road's start at the stop, but the two
  // strips each ended square on their own heading (68.6 deg against 63.4 deg) with the texture starting afresh: one
  // lay over the other in a wedge with a straight seam across the asphalt, the edge lines crossed and the dashed centre
  // line stopped in the middle with the other's starting offset. Now it is one more stop on the way: the same bisector
  // cross-section for both, the Depotweg's v running on into the village road's (and on down the valley roads after it))
  const dep = busRoads.depot;
  const before = (q) => (dep && q === dep.R0 ? dep.road : busRoads.roads.find((o) => !o.access && o.to === q.from));
  const prev = dep && r === dep.R0 ? dep.road : r.access ? null : before(r);
  const nexts = dep && r === dep.road ? [dep.R0] : r.access ? [] : busRoads.roads.filter((o) => !o.access && o.from === r.to);
  const next = nexts.length === 1 ? nexts[0] : null;
  let v0 = 0;
  for (let q = prev, g = 0; q && g < 20; g++) { v0 += q.length; q = before(q); }
  const jointDir = (a, b) => { // (unit) bisector of road a's last heading and road b's first
    const d0 = roadDir(a, a.n - 1), d1 = roadDir(b, 0), x = d0[0] + d1[0], z = d0[1] + d1[1], l = Math.hypot(x, z);
    return l > 0.2 ? [x / l, z / l] : null;
  };
  // (a roundabout's ring is closed: its first and last cross-sections the same, no kink or overlap at the seam)
  const ring = r.ringRoad && Math.hypot(R.X[0] - R.X[R.n - 1], R.Z[0] - R.Z[R.n - 1]) < 0.01;
  const ringDir = ring ? (() => { const dx = R.X[1] - R.X[R.n - 2], dz = R.Z[1] - R.Z[R.n - 2], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; })() : null;
  const dirStart = ringDir || (prev ? jointDir(prev, r) : null), dirEnd = ringDir || (next ? jointDir(r, next) : null);
  const dirAt = (i) => {
    const a = Math.max(0, i - 1), b = Math.min(R.n - 1, i + 1);
    let dx = R.X[b] - R.X[a], dz = R.Z[b] - R.Z[a];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (i === 0 && dirStart) [dx, dz] = dirStart;
    else if (i === R.n - 1 && dirEnd) [dx, dz] = dirEnd;
    return [dx, dz];
  };
  const na = ACROSS.length, rows = 2 * R.n - 1;
  const pos = new Float32Array(rows * na * 3), uv = new Float32Array(rows * na * 2), end = new Float32Array(rows * na).fill(1);
  const rowS = new Float32Array(rows);
  for (let kr = 0; kr < rows; kr++) {
    const i0 = kr >> 1, half = kr & 1, i1 = Math.min(R.n - 1, i0 + half);
    let [dx, dz] = dirAt(i0);
    if (half) { const d1 = dirAt(i1), l = Math.hypot(dx + d1[0], dz + d1[1]) || 1; dx = (dx + d1[0]) / l; dz = (dz + d1[1]) / l; }
    const cx = half ? (R.X[i0] + R.X[i1]) / 2 : R.X[i0], cz = half ? (R.Z[i0] + R.Z[i1]) / 2 : R.Z[i0], cs = half ? (R.S[i0] + R.S[i1]) / 2 : R.S[i0];
    const nx = dz, nz = -dx; // across the road
    rowS[kr] = cs;
    for (let q = 0; q < na; q++) {
      const o = ACROSS[q] * ROAD_HALF, x = cx + nx * o, z = cz + nz * o;
      pos.set([x, MH(x, z) + 0.035, z], (kr * na + q) * 3);
      uv.set([(ACROSS[q] + 1) / 2, (v0 + cs) / 13.5], (kr * na + q) * 2);
    }
  }
  // the cuts: each long line from the end inward, up to where it leaves the other surface (to 1 cm), the vertices
  // before that all on that point (zero-area triangles: nothing drawn there)
  const hosts = ring ? [null, null] : endHosts(r);
  hosts.forEach((h, e) => {
    if (!h) return;
    const step = e ? -1 : 1, k0 = e ? rows - 1 : 0, lim = Math.min(rows - 1, 60);
    let sCut = -Infinity;
    const cutRow = new Array(na).fill(null); // (per line: the last row folded onto its cut)
    const mid = na >> 1, order = [mid];
    for (let o = 1; o <= mid; o++) order.push(mid - o, mid + o); // (from the centre line out)
    for (const q of order) {
      const P = (k) => (k * na + q) * 3;
      // how far the line runs inside from the end (rows; -1: its end is outside)
      let k = k0, n = 0;
      const in0 = h.inside(pos[P(k0)], pos[P(k0) + 2]);
      if (in0) while (n < lim && h.inside(pos[P(k + step)], pos[P(k + step) + 2])) { k += step; n++; }
      if (n >= lim) continue; // (runs along inside it: leave it)
      const depth = in0 ? n : -1;
      // an edge line running a hair outside the other surface (within 35 cm) while its inner neighbour is cut
      // deeper: folded at the neighbour's row, so no sliver of it lies along the other road's edge
      const nb = q === mid ? null : cutRow[q < mid ? q + 1 : q - 1];
      if (nb !== null && Math.abs(nb - k0) > depth + 1) {
        let near = true;
        for (let j = k0; j !== nb + step && near; j += step) if (!h.inside(pos[P(j)], pos[P(j) + 2], 0.35)) near = false;
        if (near) {
          const kk = nb + step, x = pos[P(kk)], y = pos[P(kk) + 1], z = pos[P(kk) + 2], vv = uv[(kk * na + q) * 2 + 1];
          for (let j = k0; j !== kk; j += step) { pos.set([x, y, z], P(j)); uv[(j * na + q) * 2 + 1] = vv; end[j * na + q] = 0; }
          cutRow[q] = nb;
          continue;
        }
      }
      if (!in0) continue;
      const a = P(k), b = P(k + step);
      let lo = 0, hi = 1; // (lo: inside)
      for (let it = 0; it < 18; it++) { const t = (lo + hi) / 2; if (h.inside(pos[a] + (pos[b] - pos[a]) * t, pos[a + 2] + (pos[b + 2] - pos[a + 2]) * t)) lo = t; else hi = t; }
      const x = pos[a] + (pos[b] - pos[a]) * hi, z = pos[a + 2] + (pos[b + 2] - pos[a + 2]) * hi, y = MH(x, z) + 0.035;
      const ua = (k * na + q) * 2, ub = ((k + step) * na + q) * 2, vv = uv[ua + 1] + (uv[ub + 1] - uv[ua + 1]) * hi;
      for (let j = k0; j !== k + step; j += step) { pos.set([x, y, z], (j * na + q) * 3); uv[(j * na + q) * 2 + 1] = vv; end[j * na + q] = 0; }
      cutRow[q] = k;
      const sc = rowS[k] + (rowS[k + step] - rowS[k]) * hi;
      sCut = e ? (sCut === -Infinity ? sc : Math.min(sCut, sc)) : Math.max(sCut, sc);
    }
    // into a car park: the tracks and the centre line fade out over the last 8 m
    if (h.lot && sCut !== -Infinity) for (let k = 0; k < rows; k++) {
      const d = e ? sCut - rowS[k] : rowS[k] - sCut;
      if (d > 8) continue;
      const f = clamp(d / 8, 0, 1);
      for (let q = 0; q < na; q++) end[k * na + q] = Math.min(end[k * na + q], f * f * (3 - 2 * f));
    }
  });
  return { R, dirAt, pos, uv, end, rows, hosts };
}

function buildRoadMeshes(group, colliders = null) {
  // one material for every road: the strips meet edge to edge (roadStrip cuts each where it ends against another
  // road or a car park), so nothing needs drawing over anything else
  const roadMat = roadMaterial();
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
    return k;
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
    const strip = roadStrip(r, MH), R = strip.R, nEnd = R.n - 1, dirAt = strip.dirAt, na = ACROSS.length;
    for (let c0 = 0; c0 < nEnd; c0 += CH) {
      const c1 = Math.min(nEnd, c0 + CH), m = c1 - c0 + 1, mr = 2 * m - 1, ri2 = [];
      const rp = strip.pos.slice(2 * c0 * na * 3, (2 * c1 + 1) * na * 3), ruv = strip.uv.slice(2 * c0 * na * 2, (2 * c1 + 1) * na * 2), rend = strip.end.slice(2 * c0 * na, (2 * c1 + 1) * na);
      for (let kr = 0; kr < mr - 1; kr++) for (let q = 0; q < na - 1; q++) { const A = kr * na + q, B = (kr + 1) * na + q; ri2.push(A, B, A + 1, A + 1, B, B + 1); }
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
      rg.setAttribute('aEnd', new THREE.BufferAttribute(rend, 1));
      rg.setIndex(ri2);
      // (the strip's points lie on the drawn terrain, the straight lines between them don't: over a crease of its 2 m
      // triangles (a berm's foot, a cutting's edge) the snow rose up to 8 cm through the asphalt (Oct 30, the user:
      // "snow floor mixing with brick floor"). Where the terrain bends up under a triangle by more than 1.5 cm, that
      // triangle is cut along the terrain's own triangles, 3.5 cm over them (world/groundpatch.js); ~3 % of them)
      const cg = conformGeometry(rg, { tol: 0.015 });
      const nrm = cg.attributes.normal; // (a vertex only on zero-area triangles: up)
      for (let k = 0; k < nrm.count; k++) if (!(Math.abs(nrm.getX(k)) + Math.abs(nrm.getY(k)) + Math.abs(nrm.getZ(k)) > 1e-6)) nrm.setXYZ(k, 0, 1, 0);
      const road = new THREE.Mesh(cg, roadMat);
      road.receiveShadow = true;
      group.add(road);
    }
  });
  try { buildJunctionMouths(group, junctionMaterial()); } catch (e) { console.warn('junction mouths', e); } // (the joined surfaces, rounded corners, give-way lines)
  try {
    rails.build(group);
    busRoads.guardrails = { segments: rails.segs.length, km: +((rails.segs.length * SEG) / 1000).toFixed(2), boxes: rails.boxes, lines: busRoads.rails.length };
  } catch (e) { console.warn('guardrails', e); }
  const o = new THREE.Object3D();
  const instanced = (geo, mat, list, y0 = 0) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, y, z, ry], k) => { o.position.set(x, y + y0, z); o.rotation.set(0, ry || 0, 0); o.updateMatrix(); im.setMatrixAt(k, o.matrix); });
    im.castShadow = true;
    im.userData.noCollide = true; // (their own thin colliders below; knocked flying by a car: world/breakables.js)
    group.add(im);
    return im;
  };
  // (Oct 28, the user: "make sure the light reflectors and snow pole measurers on the side of the road are
  // collidable"): thin round colliders, soft like the guardrails (you bump and slide off; never a crash)
  const poleCs = [], postCs = [];
  if (colliders) {
    for (const [x, y, z] of poles) colliders.push(poleCs[poleCs.length] = { x, z, r: 0.06, h: 2.2, top: y + 2.2, soft: true, pole: true });
    for (const [x, y, z] of posts) colliders.push(postCs[postCs.length] = { x, z, r: 0.09, h: 1.05, top: y + 1.05, soft: true, pole: true });
  }
  // orange snow poles with a black tip (2.2 m)
  const pole = new THREE.CylinderGeometry(0.03, 0.035, 2.2, 6); pole.translate(0, 1.0, 0);
  const tip = new THREE.CylinderGeometry(0.032, 0.032, 0.4, 6); tip.translate(0, 1.95, 0);
  const poleIm = instanced(pole, new THREE.MeshStandardMaterial({ color: 0xff6418, roughness: 0.55 }), poles);
  const tipIm = instanced(tip, new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 }), poles);
  // white reflector posts (1.05 m, black band, an amber reflector facing the road)
  const post = new THREE.BoxGeometry(0.12, 1.05, 0.12); post.translate(0, 0.5, 0);
  const band = new THREE.BoxGeometry(0.125, 0.2, 0.125); band.translate(0, 0.87, 0);
  const refl = new THREE.BoxGeometry(0.05, 0.12, 0.02); refl.translate(0, 0.87, 0.07);
  const postIm = instanced(post, new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 }), posts);
  const bandIm = instanced(band, new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.5 }), posts);
  const reflIm = instanced(refl, new THREE.MeshStandardMaterial({ color: 0xffa21a, emissive: 0xff8a00, emissiveIntensity: 0.35, roughness: 0.3 }), posts);
  // (Oct 30, the user: "if you crash into little poles they detach and fly away but respawn back after 90 sec")
  poleCs.forEach((c, k) => breakables.add(c, [[poleIm, k], [tipIm, k]], { h: 2.2, loud: 0.35 }));
  postCs.forEach((c, k) => breakables.add(c, [[postIm, k], [bandIm, k], [reflIm, k]], { h: 1.05, loud: 0.4 }));
}

// ------------------------------------------------------------------ the bus
// The shell (front +z, wheels on y = 0, BUS.len (9.3 m) long) + its interior. Local frame: x left, y up, z forward.
// (Oct 30 2026, the user: "I also have a new bus model, please use this one. Also make it so you can see the people
// inside through the windows, like the other cars"): the Busscar Micruss (models.ski_bus_micruss; the old Meshy coach,
// models.ski_bus, only if it is missing). Its own cabin is drawn: seats, racks, the driver's partition, behind tinted
// glass (transparent, low opacity, no depth write, drawn after the opaque parts, as the cars' glass), and the seats
// people sit in are its own seats (MIC_SEATS), inside and out: you, the other players and a few passengers.
export function buildBus(models, makeRig) {
  const group = new THREE.Group();
  group.name = 'ski-bus';
  if (models.ski_bus_micruss) return buildMicruss(models.ski_bus_micruss, group, makeRig);
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

// The Micruss as the model has it (its own units, the scene root's frame: x left, y up, z forward, the wheels' bottoms
// at y -2.95, 25 units long, the body 7.56 across): its seats, each [x, cushion top y, the cushion's back edge z] (the
// backrest just behind it), front to back, the right side (-x, the door side) and the left; the bench at the back;
// the driver's seat (left, +x). Measured from its seat meshes (tools/glb-components.mjs).
const MIC_SEATS = [
  ...[-0.01, -3.11, -6.72, -10.33].flatMap((z, k) => [[-2.65, 1.01, z, k, true], [-1.25, 1.01, z, k, false]]),
  ...[1.86, -1.75, -5.36, -8.97].flatMap((z, k) => [[2.66, 1.01, z, k, true], [1.26, 1.01, z, k, false]]),
  ...[-2.13, -0.73, 0.70, 2.10].map((x) => [x, 1.01, -12.58, 4, Math.abs(x) > 2]),
];
const MIC_DRIVER = [2.12, 1.37, 7.04];
const MIC_INNER = /^(Interior|InteriorRacks|InteriorWindow|Seats|SeatMetal|SeatPlastic)$/; // (its cabin: hidden far away, no shadows)
const MIC_GLASS = /^(Windows|InteriorWindow)$/;
// (Oct 31 2026, the user: "make sure the windows of the bus are tinted from the outside": dark privacy glass seen from
// outside; while the camera is inside a bus, the glass goes light so you see out (busGlass, per frame in updateFleet))
const MIC_GLASSES = new Set(), _glassV = new THREE.Vector3();
function busGlass(groups) {
  const cam = globalThis.__game?.camera?.position;
  let inBus = false;
  if (cam) for (const g of groups) {
    if (!g?.visible) continue;
    _glassV.copy(cam); g.worldToLocal(_glassV);
    if (Math.abs(_glassV.x) < BUS.width / 2 && Math.abs(_glassV.z) < BUS.len / 2 && _glassV.y > 0 && _glassV.y < 3.3) { inBus = true; break; }
  }
  for (const m of MIC_GLASSES) { m.opacity = inBus ? 0.16 : 0.82; m.color.setHex(inBus ? 0x6f8796 : 0x0e151b); }
}
const MIC_REAR_LAMP = { x: 2.9, y: 0.63, h: 1.46, z: -13.35 }; // (its tail lamp clusters: x, mid y, height, back z)
function buildMicruss(gltf, group, makeRig) {
  const shell = new THREE.Group();
  const m = gltf.scene.clone(true);
  m.updateMatrixWorld(true);
  const all = new THREE.Box3().setFromObject(m), body = m.getObjectByName('BusBody');
  const bb = body ? new THREE.Box3().setFromObject(body) : all;
  // (the bus's own footprint: 2.55 m across the body (the mirrors stick out), BUS.len long; the height as wide, so its
  // floor is at the bus's 0.95 m and its roof at ~3 m; its length only a little stretched (Oct 31 2026, the user: "The
  // bus is a bit too stretched": 8.44 m at that width, 9.3 m now, ~1.1x, was 12 m, 1.42x; the windows and wheels keep
  // their real look, the seats, lamps and driver measured from the model follow it, the colliders are BUS.len long))
  const sx = BUS.width / (bb.max.x - bb.min.x), sz = BUS.len / (all.max.z - all.min.z);
  m.scale.set(sx, sx, sz);
  m.position.set(-(all.min.x + all.max.x) / 2 * sx, -all.min.y * sx, -(all.min.z + all.max.z) / 2 * sz);
  m.updateMatrix();
  shell.add(m);
  // (the PostBus yellow over its white paint; satin, never mirroring the snow) and its glass and cabin
  const glass = new THREE.MeshStandardMaterial({ color: 0x0e151b, transparent: true, opacity: 0.82, roughness: 0.06, metalness: 0.3, depthWrite: false, side: THREE.DoubleSide });
  MIC_GLASSES.add(glass); // (tinted from outside, clear from inside: busGlass, per frame)
  const swap = new Map();
  m.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.material?.name || '';
    o.castShadow = !MIC_INNER.test(name) && !MIC_GLASS.test(name); o.receiveShadow = true;
    if (MIC_GLASS.test(name)) { o.material = glass; o.renderOrder = 2; return; }
    if (name === 'Body' && o.material?.isMeshStandardMaterial) {
      if (!swap.has(o.material)) { const p = o.material.clone(); p.metalness = Math.min(p.metalness, 0.3); micrussPaint(p); swap.set(o.material, p); }
      o.material = swap.get(o.material);
    }
  });
  // the wheels (Oct 30 2026, the user: "make the wheels move too for the bus"): each wheel node (Tire_low* front,
  // Tireback_low* rear: rim and tyre) under a pivot at its centre: `fix` undoes the length stretch (the wheel stays
  // round), `steer` turns the front ones about y, `spin` rolls them about the axle (x); turnWheels per frame
  const WHEEL_K = 1.22;
  const wheels = [];
  m.traverse((o) => { if (!o.isMesh && /^Tire(back)?_low/i.test(o.name)) wheels.push(o); });
  for (const w of wheels) {
    const front = !/back/i.test(w.name), P = w.parent;
    const fix = new THREE.Group(), steer = new THREE.Group(), spin = new THREE.Group();
    fix.name = 'bus-wheel'; steer.name = front ? 'bus-wheel-steer' : 'bus-wheel-rear'; spin.name = 'bus-wheel-spin';
    fix.position.copy(w.position); fix.scale.set(WHEEL_K, WHEEL_K, WHEEL_K * sx / sz); // (bigger wheels: WHEEL_K)
    P.add(fix); fix.add(steer); steer.add(spin); spin.add(w);
    w.position.set(0, 0, 0);
  }
  shell.updateMatrixWorld(true);
  // its wheel radius and wheelbase in metres (the shell's own frame)
  let r = 0.37, zf = 4.6, zr = -2.2;
  const tf = wheels.find((w) => !/back/i.test(w.name)), tr = wheels.find((w) => /back/i.test(w.name));
  if (tf) { const b = new THREE.Box3().setFromObject(tf); r = (b.max.y - b.min.y) / 2 || r; zf = (b.min.z + b.max.z) / 2; }
  if (tr) { const b = new THREE.Box3().setFromObject(tr); zr = (b.min.z + b.max.z) / 2; }
  // (Oct 31 2026, the user: "make the wheels bigger for the bus too": the wheels WHEEL_K the model's size; the body lifted
  // by what that adds under the axle, so the tyres still stand on the road)
  m.position.y += r * (1 - 1 / WHEEL_K);
  shell.updateMatrixWorld(true);
  const at = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m.matrix);
  const lampP = at(MIC_REAR_LAMP.x, MIC_REAR_LAMP.y, MIC_REAR_LAMP.z);
  shell.userData = { size: new THREE.Vector3(BUS.width, (all.max.y - all.min.y) * sx, BUS.len), wheelR: r, wheelBase: zf - zr, micruss: true,
    lamp: { x: Math.abs(lampP.x), y: lampP.y, h: MIC_REAR_LAMP.h * sx, z: lampP.z } };
  group.add(shell);
  // the seats you and the others sit in: its own (the seat point on the cushion, the hips a hand in front of the
  // backrest; facing forward, as the old cabin's: window, side (-x the door side), row)
  const seats = MIC_SEATS.map(([x, y, z, row, win]) => ({ pos: at(x, y, z + 0.45).add(_c.set(0, 0.03, 0)), yaw: 0, window: win, side: Math.sign(x), row }));
  const inside = new THREE.Group();
  inside.name = 'bus-interior';
  // the driver (bus:0: one of the game's own people, seated at its wheel; the others get a baked one, busPeople)
  if (makeRig) {
    try {
      const rig = makeRig('skier_green', 'rental');
      if (rig?.root) {
        rig.gear.visible = false;
        const seat = at(MIC_DRIVER[0], MIC_DRIVER[1], MIC_DRIVER[2] + 0.45);
        rig.root.position.copy(seat);
        for (let k = 0; k < 2; k++) { rig.snapNext = true; rig.update(0.016, { mode: 'sit', seat, heading: 0, speed: 0, lookYaw: 0 }); }
        rig.root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
        inside.add(rig.root);
        inside.userData.driver = true;
      }
    } catch (e) { console.warn('bus driver', e); }
  }
  inside.userData.seats = seats;
  group.add(inside);
  return { group, shell, inside, seats, micruss: true, driverSeat: at(MIC_DRIVER[0], MIC_DRIVER[1], MIC_DRIVER[2] + 0.45) };
}

// the Micruss's paint is white (a grey texture): its bright parts PostBus yellow, keeping their shading and panel lines;
// the black window frames, rubber and trim stay as they are
function micrussPaint(m) {
  m.roughness = Math.max(m.roughness, 0.42);
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec3 pc = diffuseColor.rgb;
        float pl = dot(pc, vec3(0.2126, 0.7152, 0.0722));
        float pmx = max(pc.r, max(pc.g, pc.b)), pmn = min(pc.r, min(pc.g, pc.b));
        float paint = smoothstep(0.12, 0.22, pl) * (1.0 - smoothstep(0.16, 0.26, (pmx - pmn) / max(pmx, 1e-4)));
        vec3 yellow = vec3(0.93, 0.55, 0.006) * clamp(pl / 0.33, 0.5, 1.15);
        diffuseColor.rgb = mix(pc, yellow, paint);
      }`);
  };
  m.customProgramCacheKey = () => 'micruss-paint';
  m.needsUpdate = true;
}

// Per frame for a bus drawn near you (within WHEEL_NEAR; its cabin and passengers within PEOPLE_NEAR): the wheels roll
// by the distance it moved along its heading / their radius, the front ones steer by how fast it turns per metre
// (atan(wheelbase x curvature), eased). Works for every bus alike (yours, the fleet, the multiplayer ones, the intro):
// it only needs where the bus is now.
const WHEEL_NEAR = 150, PEOPLE_NEAR = 60;
const _wheelSets = new WeakMap();
export function turnWheels(shell, pos, yaw) {
  if (!shell?.userData?.micruss) return;
  let W = _wheelSets.get(shell);
  if (!W) {
    W = { spin: [], steer: [], inner: [], x: pos.x, z: pos.z, yaw, a: 0, r: shell.userData.wheelR || 0.37, wb: shell.userData.wheelBase || 6.7, innerOn: true };
    shell.traverse((o) => {
      if (o.name === 'bus-wheel-spin') W.spin.push(o);
      else if (o.name === 'bus-wheel-steer') W.steer.push(o);
      else if (o.isMesh && MIC_INNER.test(o.material?.name || '')) W.inner.push(o);
    });
    _wheelSets.set(shell, W);
    return;
  }
  const dx = pos.x - W.x, dz = pos.z - W.z;
  W.x = pos.x; W.z = pos.z;
  const dyaw = wrapPi(yaw - W.yaw);
  W.yaw = yaw;
  if (dx * dx + dz * dz > 400) return; // (placed somewhere else: no roll)
  const ds = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  if (Math.abs(ds) > 1e-4) {
    const a = ds / W.r;
    for (const s of W.spin) s.rotation.x = (s.rotation.x + a) % (Math.PI * 2);
    if (Math.abs(ds) > 0.01) W.a += (clamp(Math.atan((W.wb * dyaw) / ds), -0.6, 0.6) - W.a) * 0.25;
  }
  for (const s of W.steer) s.rotation.y = W.a;
}
// a bus's passengers made for the other mode (multiplayer joined or left since): taken out, to be made again
function stalePeople(b) {
  if (!b.people || b.people.userData.mp === isMP()) return false;
  b.people.removeFromParent();
  return true;
}
// its cabin (seats, racks) and the people in it drawn near you only
function busNear(shell, people, d, pos, yaw) {
  if (!_wheelSets.has(shell)) turnWheels(shell, pos, yaw);
  const W = _wheelSets.get(shell);
  const on = d < PEOPLE_NEAR;
  if (W && W.innerOn !== on) { W.innerOn = on; for (const o of W.inner) o.visible = on; }
  if (people) people.visible = on;
}
// A few passengers (Oct 30 2026, the user: "see the people inside through the windows, like the other cars"): the
// traffic's baked seated people (carpeople.js: the game's skiers in the 'sit' pose, knees bent, plain meshes, no
// shadows) on some of its seats (by the bus's number; never the seat single player gives you), and a driver at the
// wheel on the fleet's buses. Null until the traffic's bake is done. Multiplayer (Oct 31 2026, the user: "why are there
// bots sitting in the bus on multiplayer? Only the driver should sit in the bus. And in the parking lot there are a lot
// of bots sitting inside. Only in single player"): the driver only (the players riding sit in their seats as before);
// tagged with the mode it was made for, so joining / leaving redoes it (stalePeople).
function busPeople(bus, seed, driver) {
  const CP = game()?.traffic?.people;
  if (!CP?.ready) return null;
  if (!CP.busWait) { CP.busWait = true; CP.ready.then(() => { CP.busDone = true; }); } // (all its looks baked first)
  const P = CP.figs?.passenger, D = CP.figs?.driver;
  if (!CP.busDone || !P?.length) return null;
  const g = new THREE.Group();
  g.name = 'bus-people';
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const put = (fig, seat) => {
    const o = new THREE.Group();
    o.position.copy(seat);
    for (const p of fig.parts) { const mm = new THREE.Mesh(p.geo, p.mat); mm.castShadow = false; mm.receiveShadow = false; o.add(mm); }
    g.add(o);
  };
  if (driver && bus.driverSeat) put((D?.length ? D : P)[Math.floor(rnd() * 97) % (D?.length || P.length)], bus.driverSeat);
  const S = bus.seats, keep = S.indexOf(S.find((q) => q.window && q.side < 0 && q.row === 2));
  const n = isMP() ? 0 : 3 + Math.floor(rnd() * 3);
  g.userData.mp = isMP();
  const free = S.map((_, i) => i).filter((i) => i !== keep);
  for (let k = 0; k < n && free.length; k++) {
    const i = free.splice(Math.floor(rnd() * free.length), 1)[0];
    put(P[Math.floor(rnd() * P.length)], S[i].pos);
  }
  return g;
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

// a bus's pose: its middle at arc length s of path t (front and rear axles on the road, in the right lane, `shift` 0..1
// out into the other lane, shiftV its rate), on group g; returns its yaw
function poseBus(g, t, s, shift = 0, shiftV = 0, v = 0) {
  const half = 3.0;
  roadAt(t, s + half, _p); roadAt(t, s - half, _q);
  const lane = BUS.lane * (1 - 2 * shift); // (overtaking: out into the other lane)
  // changing lanes the bus steers: the front axle is already further across than the rear (the slope of the path
  // it traces, lateral speed / forward speed), so it turns out and back in instead of sliding sideways
  const slope = clamp((-2 * BUS.lane * shiftV) / Math.max(1, v), -0.32, 0.32);
  const lf = lane + slope * half, lr = lane - slope * half;
  // (the right-hand lane: right of the heading (dx, dz) is (-dz, dx))
  _a.set(_p.x - _p.dz * lf, _p.y, _p.z + _p.dx * lf);
  _b.set(_q.x - _q.dz * lr, _q.y, _q.z + _q.dx * lr);
  // (on the road's own surface under each axle: the mountain roads are banked into their bends)
  if (world.groundHeight) { _a.y = world.groundHeight(_a.x, _a.z, _p.y + 1); _b.y = world.groundHeight(_b.x, _b.z, _q.y + 1); }
  g.position.addVectors(_a, _b).multiplyScalar(0.5);
  _m.lookAt(_b, _a, _up);
  g.quaternion.setFromRotationMatrix(_m);
  g.rotateY(Math.PI);
  g.updateMatrixWorld(true);
  return Math.atan2(_a.x - _b.x, _a.z - _b.z);
}

// the lane change (r.shift 0..1 toward r.passing): a critically damped spring (eases out and in, an S-curve), its
// lateral speed at most ~0.3 of the forward speed v so the bus steers round (poseBus turns it along the path it
// traces), never slides sideways; nearly at a standstill it only creeps across
function steerShift(r, dt, v) {
  const W = 2.1, x = r.shift || 0, sv = r.shiftV || 0, a = W * W * ((r.passing ? 1 : 0) - x) - 2 * W * sv;
  const cap = (0.3 * Math.max(0.7, v)) / (2 * BUS.lane);
  r.shiftV = clamp(sv + a * dt, -cap, cap);
  r.shift = clamp(x + r.shiftV * dt, 0, 1);
  if (r.shift === 0 || r.shift === 1) r.shiftV *= 0.5;
}

// brake / tail lamps on the bus's back (the shell has no lamps of its own to switch): two red lamps low on each
// side, dim as tail lights, bright while it brakes or stands
function addLamps(parent, size) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a0605, emissive: 0xff1608, emissiveIntensity: 0.35, roughness: 0.35 });
  // (the Micruss: over its own tail lamp clusters, a thin glowing strip on each)
  const L = parent.userData?.lamp;
  if (L) {
    const g = new THREE.BoxGeometry(0.1, L.h * 0.9, 0.03);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(g, mat);
      m.position.set(sx * L.x, L.y, L.z - 0.015);
      m.userData.noCollide = true; m.castShadow = false;
      parent.add(m);
    }
    return { mat, k: 0 };
  }
  const geo = new THREE.BoxGeometry(0.26, 0.34, 0.05);
  const w = Math.min(BUS.width, size?.x || BUS.width), l = size?.z || BUS.len;
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(sx * (w / 2 - 0.26), 1.05, -l / 2 - 0.02);
    m.userData.noCollide = true;
    parent.add(m);
  }
  return { mat, k: 0 };
}
// per frame: braking (decelerating) or standing -> bright
function setLamps(L, v, vPrev, dt) {
  if (!L || !(dt > 0)) return;
  const on = v < 0.25 || (vPrev - v) / dt > 0.35 ? 1 : 0;
  L.k += (on - L.k) * (1 - Math.exp(-dt * 12));
  const e = 0.35 + 2.4 * L.k;
  if (Math.abs(L.mat.emissiveIntensity - e) > 0.01) L.mat.emissiveIntensity = e;
}

// ------------------------------------------------------------------ the fleet's timetable
// Each round: from the village out to a terminus (a stop at the end of a branch of the network) and back, stopping at
// every stop on the way. Its way each direction is one path (the trips between the stops joined end to end: the bus
// drives on through each stop after its halt). Where a bus is is a function of the clock alone (a shared clock in
// multiplayer, later): pos(T) from the timetable; near you it drives itself (brakes for the traffic, overtakes:
// clearAhead), keeping to the timetable as best it can, and goes back to it once out of sight.
export const FLEET_N = 8;              // buses in all: bus:0 (yours, waits at the village) and bus:1..7 on the rounds
const DWELL_STOP = 16, DWELL_END = 40, DWELL_DEPOT = 45; // s: at a stop on the way, at the terminus, at the village
const FLEET_SIM = 1300;                // m: nearer you than this a bus drives itself
const FLEET_SHOW = 1300;               // m: drawn within this (beyond, its timetable alone: cheap)
const DEPOT_GAP = 16;                  // m: a bus leaving the village starts this far beyond the one waiting there (no depot)
// With the bus depot (depot.js): a bus back from its round lets its riders off at the village stop (the inbound lane,
// DWELL_UNLOAD), drives on to its own bay and waits there (the rest of its cycle, at least MIN_LAYOVER), then comes
// back round to the stop and boards at the sign (DWELL_DEPOT) before it leaves. Every round's cycle is a whole number
// of SLOT s (the first of FLEET_SLOTS that fits) and each round's buses are given a phase so that no two buses ever
// stand at (or pull in to) the stop's boarding or alighting bay at once (slotFleet): with every cycle a multiple of
// the slot, where each bus is in its cycle repeats every slot, so the stop's timetable is the same every slot.
const DWELL_UNLOAD = 20, MIN_LAYOVER = 60;
const FLEET_SLOTS = [360, 720, 1080, 1440];
const SLOT_PAD = 6;                    // s: before and after a halt at the village stop that nobody else may use its bay
// one direction of a round: the trips (BusLine.leg) joined -> { n, X, Y, Z, S, length, V, marks: [{ s, stop, dwell }],
// sA, sB, kt: [knot times], ks: [knot arc lengths], dur }
function fleetDir(trips, startGap, endDwell) {
  const X = [], Y = [], Z = [], marks = [];
  let off = 0, sA = 0;
  trips.forEach((t, k) => {
    for (let i = 0; i < t.n; i++) {
      if (X.length && i === 0 && Math.hypot(t.X[0] - X[X.length - 1], t.Z[0] - Z[Z.length - 1]) < 0.5) continue;
      X.push(t.X[i]); Y.push(t.Y[i]); Z.push(t.Z[i]);
    }
    if (k === 0) sA = t.s0 + startGap;
    marks.push({ s: off + t.s1, stop: t.to, dwell: t.dwell ?? (k === trips.length - 1 ? endDwell : DWELL_STOP) }); // (the depot's ways: their own dwell at the village)
    off += t.length;
  });
  const n = X.length, P = { n, X: Float32Array.from(X), Y: Float32Array.from(Y), Z: Float32Array.from(Z), S: new Float32Array(n) };
  for (let i = 1; i < n; i++) P.S[i] = P.S[i - 1] + Math.hypot(P.X[i] - P.X[i - 1], P.Z[i] - P.Z[i - 1]);
  P.length = P.S[n - 1];
  // the speeds: the bends (as BusLine.leg), to a standstill at each stop, from it after
  const V = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 4), b = Math.min(n - 1, i + 4);
    const h0 = Math.atan2(P.X[Math.min(n - 1, a + 1)] - P.X[a], P.Z[Math.min(n - 1, a + 1)] - P.Z[a]);
    const h1 = Math.atan2(P.X[b] - P.X[Math.max(0, b - 1)], P.Z[b] - P.Z[Math.max(0, b - 1)]);
    const k = Math.abs(wrapPi(h1 - h0)) / Math.max(1, P.S[b] - P.S[a]);
    V[i] = Math.min(BUS.cruise, Math.sqrt(BUS.lat / Math.max(1e-4, k)));
  }
  const zero = [sA, ...marks.map((m) => m.s)];
  for (const z of zero) { let bi = 0; for (let i = 0; i < n; i++) if (Math.abs(P.S[i] - z) < Math.abs(P.S[bi] - z)) bi = i; V[bi] = 0; }
  for (let i = 0; i < n; i++) if (P.S[i] <= sA || P.S[i] >= marks[marks.length - 1].s) V[i] = 0;
  for (let i = n - 2; i >= 0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] ** 2 + 2 * BUS.brake * (P.S[i + 1] - P.S[i])));
  for (let i = 1; i < n; i++) V[i] = Math.min(V[i], Math.sqrt(V[i - 1] ** 2 + 2 * BUS.acc * (P.S[i] - P.S[i - 1])));
  P.V = V; P.marks = marks; P.sA = sA; P.sB = marks[marks.length - 1].s;
  // the knots (time, arc length): the drive, held at each stop for its dwell
  const kt = [0], ks = [sA];
  let tm = 0, mi = 0, sPrev = sA;
  for (let i = 0; i < n && mi < marks.length; i++) {
    const s = P.S[i];
    if (s <= sA) continue;
    const m = marks[mi], sTo = Math.min(s, m.s), ds = sTo - sPrev;
    if (ds > 0) { const v = Math.max(0.8, (V[Math.max(0, i - 1)] + V[i]) / 2); tm += ds / v; kt.push(tm); ks.push(sTo); sPrev = sTo; }
    if (s >= m.s) { tm += m.dwell; kt.push(tm); ks.push(m.s); mi++; i--; }
  }
  P.kt = Float64Array.from(kt); P.ks = Float32Array.from(ks); P.dur = tm;
  // (multiplayer: when it gets to each stop, from the start of this way)
  for (const m of marks) { const k = P.ks.findIndex((x, i) => i > 0 && Math.abs(x - m.s) < 0.01); m.t = k > 0 ? P.kt[k] : 0; }
  return P;
}
// a direction's state at time tau (0..dur): { s, v, mark (the stop it waits at, or null) }
function dirAt(P, tau, out) {
  const kt = P.kt, ks = P.ks, n = kt.length;
  if (tau <= 0) { out.s = ks[0]; out.v = 0; out.mark = null; return out; }
  if (tau >= kt[n - 1]) { out.s = ks[n - 1]; out.v = 0; out.mark = P.marks[P.marks.length - 1]; return out; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (kt[m] <= tau) lo = m; else hi = m; }
  const dt = kt[hi] - kt[lo], f = dt > 1e-6 ? (tau - kt[lo]) / dt : 0;
  out.s = ks[lo] + (ks[hi] - ks[lo]) * f;
  out.v = dt > 1e-6 ? (ks[hi] - ks[lo]) / dt : 0;
  out.mark = out.v < 1e-3 ? (P.marks.find((m) => Math.abs(m.s - out.s) < 0.5) || null) : null;
  return out;
}

// The fleet's slots (with the depot): every round's cycle the least multiple of SLOT (the first of FLEET_SLOTS that
// fits) over its longest bus's drive + MIN_LAYOVER, and each round's phase psi (its buses at psi + k cycle / m) such
// that no two buses are ever at the village stop at once: from pulling in to the alighting bay until through the bend
// at the road's end on the way to the depot, and from coming round that bend from the depot until pulled away from
// the boarding bay at the sign (the bend is tight: a bus going round it and one standing in the other lane by the
// stop would touch), SLOT_PAD before and after. Two buses with cycles Ca, Cb meet at every offset that is a multiple
// of gcd(Ca, Cb) apart, so their visits are compared modulo that. Greedy, rounds with the most buses first; 5 s steps.
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const mod = (a, m) => ((a % m) + m) % m;
const BEND = 14; // m past the road's end (either way) a bus is still round the bend there
function timeAt(P, s) { // (when way P's timetable first reaches arc length s)
  const kt = P.kt, ks = P.ks;
  for (let i = 1; i < ks.length; i++) if (ks[i] >= s) return kt[i - 1] + (kt[i] - kt[i - 1]) * (ks[i] > ks[i - 1] ? (s - ks[i - 1]) / (ks[i] - ks[i - 1]) : 1);
  return kt[kt.length - 1];
}
function slotFleet(routes) {
  // each bus's visits to the village stop in its own cycle: [start, length]
  const v = busRoads.stops[0];
  for (const r of routes) for (const b of r.buses) {
    const A = b.w.A, B = b.w.B0, mo = A.marks.find((m) => sameStop(m.stop, v)), mb = B.marks[B.marks.length - 2];
    b.halts = [];
    if (mo) { const t0 = timeAt(A, mo.s - BAY - BEND); b.halts.push([t0 - SLOT_PAD, mo.t + mo.dwell + 2 * SLOT_PAD - t0]); }
    if (mb && sameStop(mb.stop, v)) { const t1 = timeAt(B, mb.s + BAY + BEND); b.halts.push([A.dur + mb.t - SLOT_PAD, t1 - mb.t + 2 * SLOT_PAD]); }
  }
  const clash = (p, q) => {
    const g = gcd(p.P, q.P);
    for (const [a, la] of p.h) for (const [b, lb] of q.h) { const d = mod(b - a, g); if (d < la || g - d < lb) return true; }
    return false;
  };
  const order = routes.slice().sort((a, b) => b.m - a.m || a.idx - b.idx);
  for (const SLOT of FLEET_SLOTS) {
    const placed = [];
    let ok = true;
    for (const r of order) {
      r.cycle = Math.ceil((r.base + MIN_LAYOVER) / SLOT) * SLOT;
      let found = null;
      for (let psi = 0; psi < r.cycle / r.m && !found; psi += 5) {
        // (a halt at e in a bus's cycle comes round at clock times e - phase, modulo its cycle)
        const mine = r.buses.map((b, k) => ({ P: r.cycle, h: b.halts.map(([e, l]) => [e - (psi + (r.cycle * k) / r.m), l]) }));
        if (mine.some((p, i) => mine.some((q, j) => j > i && clash(p, q)) || placed.some((q) => clash(p, q)))) continue;
        found = { psi, mine };
      }
      if (!found) { ok = false; break; }
      r.psi = found.psi;
      placed.push(...found.mine);
    }
    if (ok) return SLOT;
  }
  routes.forEach((r, ri) => { r.psi = ri * 53; }); // (no slot fits: as before, the rounds just apart)
  return 0;
}

// ------------------------------------------------------------------ the line
export class BusLine {
  constructor({ scene, models, makeRig = null, colliders = null, cameraBlockers = null }) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'bus-roads';
    if (busRoads.roads.length) buildRoadMeshes(this.group, colliders); // (+ the guardrails' colliders)
    if (busRoads.roads.length) { try { buildScenicProps(this.group, { colliders, models }); } catch (e) { console.warn('scenic props', e); } }
    // speed limit and warning signs (roadsigns.js; the limits are the traffic's, speedlimits.js), after the scenic
    // props so they never stand on a give-way sign or a bench
    if (busRoads.roads.length) { try { busRoads.signs = buildRoadSigns(this.group, colliders).length; } catch (e) { console.warn('road signs', e); } }
    if (busRoads.depot) { try { buildDepot(this.group, { models, colliders, surf: lotMaterial() }); } catch (e) { console.warn('bus depot', e); } }
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
    if (!this.parkInDepot()) this.parkAtVillage();
    // the other buses on their rounds (Oct 29, the user: "busses should sometimes randomly drive around ... there
    // should be 8 buses"): bus:0 is this one (you ride it; it waits at the village between rides), bus:1..7 run the
    // routes on a timetable
    this.fleet = [];
    this.fleetClock = 0;
    this.holds = new Map(); // multiplayer: bus id -> the server's hold-up record for it (setHold; HOLD)
    try { this.buildFleet(scene, colliders); } catch (e) { console.warn('bus fleet', e); this.fleet = []; }
    this.lamps = addLamps(this.bus.shell, this.bus.shell.userData.size); // (after the fleet's shells were cloned: each its own)
  }

  get riding() { return !!this.ride; }
  get speed() { return this.ride ? this.ride.v : 0; }

  // the stop's end of the network: the road whose end is at this stop
  parent(stop) { return busRoads.busLegs?.find((r) => r.to === stop) || busRoads.roads.find((r) => r.to === stop) || null; } // (the legs through the chalet village first: chaletroad.js)
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
    const r = this.ride, g = this.bus.group;
    const yaw = poseBus(g, t, s, shift, r?.shiftV || 0, r?.v || 0);
    turnWheels(this.bus.shell, g.position, yaw); // (its wheels roll and steer)
    // the collider follows (off while you ride inside)
    const c = this.collider;
    if (c) { c.x = this.ride ? 1e9 : g.position.x; c.z = this.ride ? 1e9 : g.position.z; c.rot = -yaw; this.yaw = yaw; }
  }

  /** The stop the bus waits at when p is within `m` metres of its body (null otherwise). */
  waitingAt(p, m = 7) {
    if (this.ride) return null;
    const near = (g, yaw) => {
      const dx = p.x - g.x, dz = p.z - g.z;
      const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const ex = Math.max(0, Math.abs(lx) - BUS.width / 2), ez = Math.max(0, Math.abs(lz) - BUS.len / 2);
      return Math.hypot(ex, ez) < m;
    };
    if (this.at && this.bus.group.visible && near(this.bus.group.position, this.yaw || 0)) return this.at;
    // (or one of the fleet waiting at a stop)
    for (const b of this.fleet) if (b.at && b.group.visible && near(b.group.position, b.yaw)) return b.at;
    return null;
  }

  // with the depot: between rides the bus waits in its own bay there (bay 0); null when there is no depot
  parkInDepot() {
    const T = depotTrips(0);
    if (!T) return false;
    this.place(T.in, T.in.s1);
    this.bus.group.visible = true;
    this.at = null;
    return true;
  }
  // between rides the bus waits at the village stop (or there for you as you arrive: once you are well away from it,
  // it is back in its bay at the depot, updateFleet)
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
    if (this.mp) { const pick = this.mpPick; this.mpPick = null; return pick ? this.mpBoard(from, to, pick) : null; } // (multiplayer: the shared bus you waited for)
    const legs = this.legs(from, to);
    if (!legs) return null;
    const t = legs[0];
    const seat = this.bus.seats.find((s) => s.window && s.side < 0 && s.row === 2) || this.bus.seats[0];
    // (a bus of the fleet waiting at that stop: you get on that one, it leaves its round while you ride it)
    const fb = this.at === from && this.bus.group.visible ? null : this.fleet.find((q) => q.at === from && q.group.visible && !q.taken) || null; // (bus:0 itself when it waits there)
    if (fb) { fb.taken = true; fb.group.visible = false; fb.collider.x = 1e9; }
    this.ride = { legs, li: 0, t, s: t.s0, v: 0, from, to, seat, wait: 2.2, done: false, exitSent: false, turning: false, busId: fb ? fb.id : 'bus:0', fleetBus: fb };
    this.at = null;
    this.look.yaw = -0.35; this.look.pitch = -0.05;
    this.view = 'seat'; this.fov = null; this.chase.off = null;
    this.bus.group.visible = true;
    this.place(t, t.s0);
    this.setInside(true);
    return this.seatPose();
  }

  // (the Micruss: its own cabin, inside and out: the shell stays, seen from your seat through its glass)
  setInside(on) { if (this.bus.micruss) { this.bus.inside.visible = true; this.bus.shell.visible = true; return; } this.bus.inside.visible = on; this.bus.shell.visible = !on; }

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
    if (r.mp) return this.updateMpRide();
    this.timeScale = fast ? 8 : 1;
    let t = r.t;
    // at a stop on the way: the bus turns there for the next leg (behind a short fade)
    if (r.done && r.li < r.legs.length - 1) {
      r.arrive -= dt;
      if (r.arrive <= 0 && !r.turning) {
        r.turning = true;
        const next = () => { r.li++; r.t = r.legs[r.li]; r.s = r.t.s0; r.v = 0; r.done = false; r.wait = 1.4; r.turning = false; r.passing = false; r.shift = 0; r.shiftV = 0; r.ram = false; r.blockT = 0; r.passV = Infinity; this.place(r.t, r.s); };
        transition.fade(async () => { if (this.ride === r) next(); }).catch(() => { if (this.ride === r) next(); });
      }
      this.place(t, r.s);
      return { seat: this.seatPose(), hint: `${t.to.name} · the bus turns here for ${r.to.name}` };
    }
    const vPrev = r.v;
    this._frame = (this._frame | 0) + 1; // (the obstacles: once a frame)
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
      // the lane change: a critically damped spring (eases out and in, ~3 s across; Oct 29, the user: "make sure
      // overtaking is smooth"); place() turns the bus along the path it traces
      steerShift(r, h, r.v);
      r.v += clamp(vt - r.v, -BUS.brake * 2 * h, BUS.acc * 1.5 * h);
      r.s = Math.min(t.s1, r.s + r.v * h);
      if (r.s >= t.s1 - 0.05) { r.done = true; r.v = 0; r.arrive = 1.2; }
    } else r.arrive -= dt;
    this.place(t, r.s);
    if (r.ram) this.ramContact(this.bus.group.position, this.yaw || 0, r.v, this, dt * this.timeScale);
    setLamps(this.lamps, r.v, vPrev, dt);
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

  // the speed (m/s) the bus may drive at so it stops short of whatever stands in its lane ahead (trip t, ride or fleet
  // state r, the bus's middle g, self: the fleet bus, null for bus:0). Anything on the road in the lane it is in or
  // moving to counts: you (on foot, on skis or in your car), the people about, other players and their cars, the
  // traffic, parked / shoved cars, the tow truck and the other buses. (Oct 28, the user: "the bus should overtake";
  // Oct 30: "make sure the bus stops for you and if the person doesn't move it overtakes nice, smoothly and
  // realistically"): held up behind something standing (PASS_WAIT) or crawling (1.5 s) in its lane, with the other
  // lane clear far enough ahead (oncoming traffic's approach included) and the road going on long enough, it pulls
  // out (slowly round something standing: PASS_V), passes with room to spare and pulls back in once its lane is clear
  // beside and behind it. Held up RAM_T in all (Oct 30: "make sure the bus just drives or rams through after 20 sec,
  // otherwise the bus is late for the next bus stops"): it drives on through at RAM_V; a car in the way is shoved
  // aside, a person is hit as by any vehicle (vehiclehits.js). probe: only the speed limit, nothing changed (no
  // timers, horn or overtaking: mustTake asks whether a bus placed from a hold-up record would run into something)
  clearAhead(t, r, dt, want = BUS.cruise, g = this.bus.group.position, self = null, probe = false) {
    const me = self || this, obs = this.obstacles();
    const sh = r.shift || 0;
    const look = 30 + (r.v * r.v) / (2 * CLEAR_DEC), far = Math.max(look, 150);
    // anything near at all? (most of the time nothing is: cheap)
    let any = false;
    for (let k = 0; k < obs.length && !any; k++) { const o = obs[k]; if (o.fleet !== me && Math.abs(o.x - g.x) < far + 12 && Math.abs(o.z - g.z) < far + 12) any = true; }
    if (!any && probe) return Infinity;
    if (!any) { r.heldT = 0; r.slowT = 0; r.blockT = 0; r.passing = false; r.ram = false; r.horn = 0; if (sh < 0.05) r.passV = Infinity; return Infinity; }
    const i0 = roadAt(t, r.s - BUS.len, _p).i, i1 = roadAt(t, r.s + far, _p).i + 1;
    // the lateral band the bus sweeps: where it is now to the lane it is heading for
    const busLat = BUS.lane * (1 - 2 * sh), tgtLat = r.passing ? -BUS.lane : BUS.lane;
    const lo = Math.min(busLat, tgtLat), hi = Math.max(busLat, tgtLat);
    let lim = Infinity, blocker = null, own = null, otherNear = false, otherAhead = Infinity, ownBeside = false;
    let tGap = Infinity;
    for (const o of obs) {
      if (o.fleet === me) continue;
      const reach = o.kind === 'ped' ? look + 12 : far + 12; // (people: only where it might have to stop for them)
      if (Math.abs(o.x - g.x) > reach || Math.abs(o.z - g.z) > reach) continue;
      if (o.y !== undefined && Math.abs(o.y - g.y) > 5) continue; // (a train in a tunnel under the road, a bridge)
      // the nearest point of the road: how far along, how far to the side of the centre line
      let bj = -1, bd = Infinity;
      for (let j = i0; j <= Math.min(t.n - 2, i1); j++) { const d = (t.X[j] - o.x) ** 2 + (t.Z[j] - o.z) ** 2; if (d < bd) { bd = d; bj = j; } }
      if (bj < 0) continue;
      const hx = t.X[bj + 1] - t.X[bj], hz = t.Z[bj + 1] - t.Z[bj], hl = Math.hypot(hx, hz) || 1, ux = hx / hl, uz = hz / hl;
      const dx = o.x - t.X[bj], dz = o.z - t.Z[bj], s = t.S[bj] + dx * ux + dz * uz;
      const latC = -dx * uz + dz * ux; // (right of the heading (ux, uz) is (-uz, ux))
      const ca = Math.abs(Math.sin(o.yaw) * ux + Math.cos(o.yaw) * uz), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
      const across = o.hw * ca + o.hd * sa, along = o.hw * sa + o.hd * ca;
      const ped = o.kind === 'ped';
      if (Math.abs(latC) - across > ROAD_HALF + (ped ? 0.05 : 0.6)) continue; // (off the road: the verge, the waiting area at a stop)
      const W = BUS.width / 2 + across + (ped ? 0.3 : 0.35);
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
      if (latC < lo - W || latC > hi + W) continue; // (not in the band it drives in)
      const gap = ds - BUS.len / 2 - along;
      if (ds < 0 || gap > look) continue;
      // going the bus's way: follow at its speed; anything else: stop short of it (further back from something
      // standing: room to pull round it); pulling round, as close as it needs
      const vo = Math.max(0, vAlong);
      const keep = r.passing && inOwn ? 1.2 : vo < 0.6 ? STOP_GAP : CLEAR_GAP;
      const room = gap - keep, v = room > 0 ? Math.sqrt(vo * vo + 2 * CLEAR_DEC * room) : 0;
      if (v < lim) { lim = v; blocker = o; }
      if (inOwn && (!own || gap < own.gap)) own = { gap, vo, along };
      if (gap < tGap) tGap = gap;
    }
    if (probe) return lim;
    // overtaking: held up behind something in its own lane, standing (PASS_WAIT) or going clearly slower than the bus
    // wants to (1.5 s; Oct 29, the user: "the bus still doesn't overtake, it just drives behind the car super slow").
    // The road it needs: the bus closes the gap, its own length, the other's and a margin at the speed difference, at
    // its own speed; the other lane must be clear that far (at least 60 m: oncoming traffic's approach included) and
    // the road must go on far enough (not into its stop)
    const vWant = Math.max(8, Math.min(want, BUS.cruise));
    const standing = !!own && own.vo < 0.6;
    const slowed = !!own && own.gap < 45 && (standing ? r.v < 0.8 : own.vo < vWant * 0.8 && r.v < vWant * 0.85);
    r.slowT = slowed ? (r.slowT || 0) + dt : 0;
    if (!r.passing && !r.ram && r.slowT > (standing ? PASS_WAIT : 1.5)) {
      const vp = own.vo < 3 ? Math.max(PASS_V, own.vo + 3) : vWant;
      const rel = Math.max(3, vp - own.vo), past = own.gap + 2 * own.along + BUS.len + 12;
      const need = Math.min(450, Math.max(60, (past / rel) * vp + 20));
      if (!otherNear && otherAhead > need && t.s1 - r.s > (standing ? past + 15 : need + 10)) { r.passing = true; r.slowT = 0; r.passV = own.vo < 3 ? vp : Infinity; }
    }
    // back in once its own lane is clear beside it and just behind (or the other lane gets busy ahead: back in as
    // soon as there is room)
    if (r.passing && !ownBeside) r.passing = false;
    // still behind it and something now comes in the other lane: give up, back in behind it
    if (r.passing && own && own.gap > 0 && otherAhead < own.gap + 2 * own.along + BUS.len + 10) r.passing = false;
    if (!r.passing && sh < 0.05) r.passV = Infinity;
    if (r.passV < Infinity) lim = Math.min(lim, r.passV); // (out round something standing: slowly, and back in)
    // held up: the horn after HORN_T (not at another bus or a train), RAM_T in all (waiting to pull out included)
    const held = !!blocker && r.v < 1 && lim < 2;
    r.heldT = held ? (r.heldT || 0) + dt : 0;
    r.blockT = held || (r.passing && r.v < 2) ? (r.blockT || 0) + dt : Math.max(0, (r.blockT || 0) - dt * 0.5);
    if (r.heldT > 3 && blocker?.car && this.traffic?.despawn && !r.ram) { this.traffic.despawn(blocker.car); r.heldT = 0; } // (a traffic car: off the road)
    if (held && blocker.kind !== 'bus' && blocker.kind !== 'train') {
      if (r.heldT > HORN_T && !(r.horn > 0)) { r.horn = 1; this.honk(g, 1); }
      else if (r.heldT > HORN_T + 6 && r.horn === 1) { r.horn = 2; this.honk(g, 0.8); }
    } else if (!held) r.horn = 0;
    if (!r.ram && r.blockT > RAM_T) { r.ram = true; r.ramFree = 0; }
    if (r.ram) {
      lim = Math.max(lim, RAM_V); // (what its front runs into is shoved aside: ramContact)
      r.ramFree = !blocker || tGap > 12 ? (r.ramFree || 0) + dt : 0;
      if (r.ramFree > 1.5) { r.ram = false; r.blockT = 0; }
    }
    return lim;
  }
  // the horn (main.js's audio), as loud as it is near you: the coach's deep two-tone air horn (audio.horn, Oct 30
  // 2026, the user: "make the horn of the bus and train super realistic like in real life"), one blare the first
  // time, an impatient short + long the second; heard farther now (its echo off the mountains: audio.valleyEcho)
  honk(g, amount) {
    try {
      const G = game(), a = G?.audio, p = G?.player?.pos;
      if (!a?.play) return;
      const d = this.ride ? 4 : p ? Math.hypot(p.x - g.x, p.z - g.z) : 0;
      if (d > 320) return;
      if (a.horn) a.horn(amount < 0.9 ? 'bus2' : 'bus', { dist: d, vol: this.ride ? 0.55 : 1 }); // (inside: muffled by the body)
      else if (d < 140) a.play('horn', amount * clamp(1.15 - d / 120, 0.12, 1));
    } catch { /* (silent) */ }
  }
  // Pushing through (RAM_T up: r.ram): whatever of yours its body runs into is bumped out of the way, to the side it
  // is on (the verge when dead ahead) and a little forward, never driven through: a traffic car knocked aside
  // (traffic.js knock), a parked car shoved (drive.js shove), your car or snowmobile pushed, a patrol car knocked
  // (police.js kx / kz), a tow truck, the ambulance, a parked helicopter or snowmobile moved over. The other players'
  // vehicles are bumped on their own screens (the bus is the same bus there: HOLD); people are knocked over by the
  // moving bus (vehiclehits.js). g: the bus's middle, yaw its heading, v its speed, self: the bus (not itself).
  ramContact(g, yaw, v, self, dt) {
    if (!(dt > 0)) return;
    const obs = this.obstacles(), fx = Math.sin(yaw), fz = Math.cos(yaw), now = performance.now();
    const T = (this._shoved ||= new WeakMap());
    for (const o of obs) {
      if (!o.how || o.fleet === self) continue;
      const dx = o.x - g.x, dz = o.z - g.z;
      if (Math.abs(dx) > 16 || Math.abs(dz) > 16) continue;
      if (o.y !== undefined && Math.abs(o.y - g.y) > 4) continue;
      const along = dx * fx + dz * fz, lat = -dx * fz + dz * fx; // (lat > 0: right of the bus, the verge side)
      const ca = Math.abs(Math.sin(o.yaw) * fx + Math.cos(o.yaw) * fz), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
      const across = o.hw * ca + o.hd * sa, alongE = o.hw * sa + o.hd * ca;
      if (Math.abs(along) > BUS.len / 2 + alongE + 0.5) continue;
      const pen = BUS.width / 2 + across + 0.25 - Math.abs(lat);
      if (pen <= 0) continue;
      const side = lat > -0.3 ? 1 : -1, sx = -fz * side, sz = fx * side; // (out to that side)
      const sp = Math.max(2.5, v * 1.1 + 1.5), vx = (sx * 0.85 + fx * 0.5) * sp, vz = (sz * 0.85 + fz * 0.5) * sp;
      const step = Math.min(pen, sp * dt), mx = sx * step + fx * Math.min(step, Math.max(0, v) * dt) * 0.5, mz = sz * step + fz * Math.min(step, Math.max(0, v) * dt) * 0.5;
      const key = o.ref || o.car || o.park, again = key ? !(now - (T.get(key) || 0) < 600) : false;
      const spin = (Math.random() - 0.5) * 1.2;
      try {
        switch (o.how) {
          case 'traffic': if (again) { T.set(key, now); if (this.traffic?.knock) this.traffic.knock(o.car, vx, vz, spin); else this.traffic?.despawn?.(o.car); } break;
          case 'park': if (again) { T.set(key, now); (this.traffic?.you || game()?.drive)?.shove?.(o.park, vx, vz, spin * 0.7); } break;
          case 'police': if (again) { T.set(key, now); const u = o.ref; u.kx = vx; u.kz = vz; u.kyaw = spin; u.v = 0; } break;
          case 'drive': case 'sledd': { const d = o.ref; d.x += mx; d.z += mz; d.vx = (d.vx || 0) + (vx - (d.vx || 0)) * 0.5; d.vz = (d.vz || 0) + (vz - (d.vz || 0)) * 0.5; break; }
          case 'tow': { const t = o.ref; t.x += mx; t.z += mz; t.place?.(); break; }
          case 'amb': { const a = o.ref; a.x += mx; a.z += mz; a.place?.(); break; }
          case 'heli': { const h = o.ref, f = h.flight; if (h.state === 'parked' && !h.active && f?.pos) { f.pos.x += mx; f.pos.z += mz; h.syncModel?.(); } break; }
          case 'sled': { const q = o.ref; q.x += mx; q.z += mz; game()?.sleds?.pose?.(q); break; }
        }
      } catch { /* (it drives on regardless) */ }
    }
  }
  // something's speed along its heading, from its motion (other players' cars: no speed is sent)
  motionV(o, x, z, yaw) {
    const M = (this._mv ||= new WeakMap()), now = performance.now();
    let m = M.get(o);
    if (!m) { M.set(o, (m = { x, z, t: now, v: 0 })); return 0; }
    const h = (now - m.t) / 1000;
    if (h < 0.01) return m.v;
    const dx = x - m.x, dz = z - m.z;
    if (dx * dx + dz * dz > 400) m.v = 0;
    else m.v += (clamp((dx * Math.sin(yaw) + dz * Math.cos(yaw)) / h, -40, 40) - m.v) * Math.min(1, h * 6);
    m.x = x; m.z = z; m.t = now;
    return m.v;
  }
  // everything the bus must not drive through, as boxes { x, y, z, yaw, hw, hd, v, car (a traffic car), park (a
  // parked car's entry), kind ('car' | 'you' | 'ped' | 'bus' | 'train' | 'veh'), fleet (the bus it is, for the buses),
  // how / ref (how ramContact bumps it out of the way, and what: null for the other players' vehicles, the trains,
  // the snow ploughs) }; built once a frame (this._frame). (Oct 30, the user: "make sure the bus can not drive
  // through a tow truck, car, human, police car or heli"): the traffic, parked cars (yours left there among them),
  // your car, the vehicles that register with traffic.js (the patrol cars, the tow trucks (the Autohaus's three),
  // your helicopter on the ground or just over it (the rescue's too: the same helicopter), the ambulance (yours and
  // the other players' rescues), the snow ploughs, the trains, the other buses), the snowmobiles (parked, yours),
  // you and the people about; multiplayer: the other players on foot, their cars, tow trucks, patrol cars,
  // snowmobiles, helicopters parked and their rescue helicopters on the snow
  obstacles() {
    const out = (this._obs ||= []);
    if (this._obsFrame === this._frame && this._obsFrame !== undefined) return out;
    this._obsFrame = this._frame;
    const pool = (this._obsPool ||= []);
    out.length = 0;
    let n = 0;
    const add = (x, y, z, yaw, hw, hd, v = 0, kind = 'car', car = null, fleet = null, park = null, how = null, ref = null) => {
      const o = (pool[n++] ||= {}); o.x = x; o.y = y; o.z = z; o.yaw = yaw; o.hw = hw; o.hd = hd; o.v = v; o.kind = kind; o.car = car; o.fleet = fleet; o.park = park; o.how = how; o.ref = ref; out.push(o);
    };
    const tr = this.traffic, G = game();
    for (const c of tr?.cars || []) if (c.mode !== 'gone' && c.sinkT === undefined) add(c.x, c.y, c.z, c.yaw, c.w / 2, c.l / 2, c.mode === 'road' ? c.v : 0, 'car', c, null, null, 'traffic', c);
    for (const e of tr?.parking?.cars || []) if (!e.driving) { const p = e.car.position; add(p.x, p.y, p.z, e.car.rotation.y, 0.97, (e.length || 4.6) / 2, 0, 'car', null, null, e, 'park', e); }
    const d = tr?.you?.d || G?.drive?.d;
    if (d) add(d.x, d.y, d.z, d.yaw, d.w / 2, d.half, this.motionV(d, d.x, d.z, d.yaw), 'you', null, null, null, 'drive', d);
    // (the blockers: whose box is whose, for bumping them out of the way)
    const refs = (this._refs ||= new Map());
    refs.clear();
    try { for (const u of G?.police?.units || []) if (u.on && u.box) refs.set(u.box, u); } catch { /* (no police) */ }
    try { const T = G?.carRental?.truck; for (const t of T?.trucks || (T ? [T] : [])) if (t.box) refs.set(t.box, t); } catch { /* (no tow trucks) */ }
    const amb = G?.heli?.rescue?.amb, hf = G?.heli?.flight;
    for (const b of trafficBlockers()) {
      let ref = refs.get(b) || null, how = ref ? (ref.box?.police ? 'police' : 'tow') : null;
      if (!ref && amb && b === amb.box) { ref = amb; how = 'amb'; }
      else if (!ref && hf?.pos && b.hw === 2.0 && Math.abs(b.x - hf.pos.x) < 2 && Math.abs(b.z - hf.pos.z) < 2) { ref = G.heli; how = 'heli'; }
      add(b.x, b.y, b.z, b.yaw, b.hw, b.hd, b.v || 0, b.fleet ? 'bus' : b.push && b.hd > 6 ? 'train' : b.police ? 'car' : 'veh', null, b.fleet || null, null, how, ref); // (the fleet's buses among them)
    }
    // the snowmobiles: parked about (each its own collider, away at 1e9 while driven) and the one you drive
    const SL = G?.sleds;
    if (SL?.list?.length) for (const q of SL.list) if (q.collider && Math.abs(q.collider.x) < 1e8 && q !== SL.d?.s) add(q.x, q.y, q.z, q.heading || 0, 0.62, 1.45, 0, 'veh', null, null, null, 'sled', q);
    const sd = SL?.d;
    if (sd && Number.isFinite(sd.x)) add(sd.x, sd.y, sd.z, sd.heading || 0, 0.62, 1.45, (sd.vx || 0) * Math.sin(sd.heading || 0) + (sd.vz || 0) * Math.cos(sd.heading || 0), 'you', null, null, null, 'sledd', sd);
    // bus:0 (waiting at the village or the depot, or the one you ride; in multiplayer its cabin is the fleet bus you ride)
    if (this.bus.group.visible && !this.ride?.mp) { const g = this.bus.group.position; add(g.x, g.y, g.z, this.yaw || 0, BUS.width / 2, BUS.len / 2, this.ride ? this.ride.v : 0, 'bus', null, this); }
    // you, on foot or on skis (not riding anything, not in a car: your car is above)
    const pl = tr?.player || G?.player;
    if (pl && !d && !this.ride && (pl.mode === 'walk' || pl.mode === 'ski' || pl.mode === 'fall' || pl.mode === 'foot') && !pl.frozen) {
      const p = pl.pos, vx = pl.vel?.x || 0, vz = pl.vel?.z || 0, v = Math.hypot(vx, vz);
      add(p.x, p.y, p.z, v > 0.2 ? Math.atan2(vx, vz) : 0, 0.35, 0.35, v, 'ped');
    }
    // the people about (near you: NPC skiers, villagers, the crowds)
    for (const q of people()) if (q && Number.isFinite(q.x)) add(q.x, q.y, q.z, 0, 0.3, 0.3, 0, 'ped');
    // multiplayer: the other players about on foot / on skis, and their cars, tow trucks, patrol cars and sleds
    if (isMP()) {
      const M = G?.multiplayer, R = M?.remotes?.players, V = M?.vehicles;
      if (R) for (const q of R.values()) {
        if (!q.ok || q.veh || q.interior || q.state === ST.sit || q.state === ST.ride || q.state === ST.drive || q.state === ST.fly) continue;
        const vx = q.vel?.x || 0, vz = q.vel?.z || 0, v = Math.hypot(vx, vz);
        add(q.pos.x, q.pos.y, q.pos.z, v > 0.2 ? Math.atan2(vx, vz) : 0, 0.35, 0.35, v, 'ped');
      }
      const box = (c, y, hw, hd) => { const col = c.col; if (c.posed === false || (col && !(Math.abs(col.x) < 1e8))) return; add(c.x, y, c.z, c.yaw || 0, col?.hw || hw, col?.hd || hd, this.motionV(c, c.x, c.z, c.yaw || 0), 'car'); };
      if (V) {
        V.cars?.forEach((c) => box(c, c.y, 0.95, 2.3));
        V.tows?.forEach((w) => box(w, undefined, 1.2, 3.5));
        V.police?.forEach((list) => { for (const u of list || []) box(u, undefined, 0.95, 2.4); });
        V.sleds?.forEach((q) => { if (q.shown !== false) box(q, q.y, 0.6, 1.5); });
        // their helicopters standing somewhere and the rescue helicopters set down for them: the cabin and the tail
        // colliders (net/vehicles.js solid; away at 1e9 while flying or not drawn) -> one box over both
        const heli = (w) => {
          const c = w?.cabinCol, t = w?.tailCol;
          if (!c || !t || !(Math.abs(c.x) < 1e8) || !(Math.abs(t.x) < 1e8)) return;
          const dx = c.x - t.x, dz = c.z - t.z, L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
          const fx = c.x + ux * (c.r || 2.1), fz = c.z + uz * (c.r || 2.1), bx = t.x - ux * (t.r || 0.7), bz = t.z - uz * (t.r || 0.7);
          add((fx + bx) / 2, undefined, (fz + bz) / 2, Math.atan2(ux, uz), c.r || 2.1, Math.hypot(fx - bx, fz - bz) / 2, 0, 'veh');
        };
        V.helis?.forEach(heli);
        V.rescues?.forEach(heli);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ the fleet (bus:1..7)
  buildFleet(scene, colliders) {
    if (!busRoads.roads.length) return;
    const v = busRoads.stops[0];
    const stops = busRoads.stops.filter((q) => q !== v && !q.noRoad);
    const legs = busRoads.busLegs || [];
    const isLeaf = (q) => !legs.some((l) => l.from === q) && !busRoads.roads.some((r) => r.from === q && !r.access);
    // a bus's round to terminus L: out (A) and the trips back (with the depot: from and to its own bay k)
    const depot = !!busRoads.depot;
    const way = (L, k) => {
      const out = this.legs(v, L), back = this.legs(L, v);
      if (!out || !back) return null;
      if (!depot) return { A: fleetDir(out, DEPOT_GAP, DWELL_END), back, B0: fleetDir(back, 0, DWELL_DEPOT), lay: DWELL_DEPOT };
      const T = depotTrips(k, BAY);
      if (!T) return null;
      T.out.dwell = DWELL_DEPOT; back[back.length - 1].dwell = DWELL_UNLOAD; // (boarding at the sign; off across from it)
      const trips = [...back, T.in];
      return { A: fleetDir([T.out, ...out], 0, DWELL_END), back: trips, B0: fleetDir(trips, 0, 0), lay: 0 };
    };
    const routes = [];
    for (const L of stops) {
      if (!isLeaf(L)) continue;
      const w = way(L, 4);
      if (!w) continue;
      routes.push({ to: L, cycle: w.A.dur + w.B0.dur + (depot ? MIN_LAYOVER : 0), chalet: w.A.marks.some((m) => m.stop?.chalets) });
    }
    if (!routes.length) return;
    // the buses over the rounds by their length (every round at least one), spread evenly round each
    const N = FLEET_N - 1, tot = routes.reduce((a, r) => a + r.cycle, 0);
    for (const r of routes) r.m = Math.max(1, Math.round((N * r.cycle) / tot));
    let sum = routes.reduce((a, r) => a + r.m, 0);
    while (sum > N) { const r = routes.filter((q) => q.m > 1).sort((a, b) => a.cycle / a.m - b.cycle / b.m)[0]; if (!r) break; r.m--; sum--; }
    while (sum < N) { routes.sort((a, b) => b.cycle / b.m - a.cycle / a.m)[0].m++; sum++; }
    // (Oct 31 2026, the user wants a second bus serving the "Chalet Village" stop): a round through it runs two buses,
    // half a cycle apart (the wait there about halved); the second one from the round with the most buses (the
    // shortest wait between them), never a round's only one. The same on every client (the same roads, the same sort)
    for (const r of routes) {
      if (!r.chalet || r.m >= 2) continue;
      const d = routes.filter((q) => q !== r && q.m > 1).sort((a, b) => a.cycle / a.m - b.cycle / b.m || b.m - a.m)[0];
      if (d) { d.m--; r.m++; } else console.warn('ski bus: no second bus for the chalet village');
    }
    // each bus its own ways (its own bay: bus:k in bay k, bus:0's is bay 0)
    let id = 1;
    routes.forEach((r, ri) => {
      r.idx = ri; r.mpLine = `R${ri}`; // (multiplayer: each round its own shared timeline 'bus|R<idx>')
      r.buses = [];
      for (let k = 0; k < r.m && id <= N; k++, id++) { const w = way(r.to, id); if (w) r.buses.push({ id, w }); }
      r.m = r.buses.length;
    });
    const live = routes.filter((r) => r.m);
    if (depot) {
      for (const r of live) r.base = Math.max(...r.buses.map((b) => b.w.A.dur + b.w.B0.dur));
      slotFleet(live);
    } else live.forEach((r, ri) => { r.base = r.cycle; r.psi = ri * 53; });
    for (const r of live) {
      r.buses.forEach(({ id: bid, w }, k) => {
        const group = new THREE.Group();
        group.name = `ski-bus-${bid}`;
        const shell = this.bus.shell.clone(true); // (the same geometry and paint as bus:0)
        group.add(shell);
        const lamps = addLamps(shell, this.bus.shell.userData.size);
        group.userData.shell = shell; group.userData.bid = bid; // (its wheels and passengers, updateFleet)
        group.visible = false;
        scene.add(group);
        const collider = { x: 1e9, z: 1e9, hw: BUS.width / 2 + 0.05, hd: BUS.len / 2, rot: 0, soft: true, h: 3.4, bus: true };
        colliders?.push(collider);
        // its round: the round's own (timeline, terminus, cycle), its own ways (its bay; the rest of the cycle waited
        // there, or at the stop without a depot)
        const route = Object.create(r);
        route.out = w.A;
        route.back = depot ? fleetDir(w.back, 0, r.cycle - w.A.dur - w.B0.dur) : w.B0;
        // (its place in the round: evenly apart, each round at its slot so no two meet at the village stop)
        const phase = r.psi + (r.cycle * k) / r.m;
        this.fleet.push({ id: `bus:${bid}`, route, phase, group, collider, lamps, seats: this.bus.seats.length, yaw: 0, at: null, st: null, v: 0, x: 0, y: 0, z: 0 });
      });
    }
    // the traffic brakes for them, follows them (and the bus you ride does too)
    const pool = [];
    this.unblock = addTrafficBlocker((out) => {
      let k = 0;
      for (const b of this.fleet) {
        if (b.taken || !b.near) continue;
        const o = (pool[k++] ||= { push: false });
        o.x = b.x; o.y = b.y; o.z = b.z; o.yaw = b.yaw; o.hw = BUS.width / 2; o.hd = BUS.len / 2; o.v = b.v; o.fleet = b;
        out.push(o);
      }
    });
    this.fleetRoutes = live.map((r) => ({ to: r.to.name, buses: r.m, cycleMin: +(r.cycle / 60).toFixed(1) }));
  }

  /** Multiplayer (later): the fleet's clock (s) from a shared one. */
  setFleetClock(t) { this.fleetClock = t; }

  // where bus b's timetable has it at the fleet's clock (less `late` s: a held-up bus, HOLD): { dir (0 out, 1 back),
  // s, v, mark, tau (s into that way) }
  fleetTarget(b, out = {}, late = 0) {
    const r = b.route, c = r.cycle;
    let tau = ((((this.mp ? this.mp.time(r) : this.fleetClock) + b.phase - late) % c) + c) % c; // (multiplayer: its round's shared timeline)
    if (tau < r.out.dur) { out.dir = 0; out.tau = tau; dirAt(r.out, tau, out); return out; }
    tau -= r.out.dur; out.dir = 1; out.tau = tau; dirAt(r.back, tau, out); return out;
  }

  // bus b exactly where its timetable T has it (no delay)
  fleetReset(b, T) {
    const st = (b.st ||= {});
    st.dir = T.dir; st.s = T.s; st.v = T.v; st.mark = T.mark; st.dwell = 0; st.hold = 0;
    st.shift = 0; st.shiftV = 0; st.passing = false; st.passV = Infinity; st.ram = false;
    st.lag = 0; st.lagS = 0; st.heldT = 0; st.slowT = 0; st.blockT = 0; st.horn = 0;
  }
  // A bus near you (single player and multiplayer alike): where its timetable has it (the shared clock in
  // multiplayer: everyone sees the bus in the same place), less a delay of its own while it is held up by something
  // in its lane (clearAhead: it brakes, waits, pulls round it, or after RAM_T drives on through), and a lane offset
  // while it overtakes. It is never ahead of its timetable; behind it, it catches up (up to CATCH faster, more when
  // its next stop is near) so it gets to that stop on time, or at the latest while the timetable still stands there:
  // it leaves every stop when the timetable does (one that got there after that stands LATE_HOLD).
  fleetDrive(b, st, T, dt) {
    let P = st.dir ? b.route.back : b.route.out;
    const last = () => P.marks[P.marks.length - 1];
    // the timetable in this bus's own way (gone on to the other way: it stands at the end of this one)
    let Ts, Tv, Tm;
    const tt = () => { if (T.dir === st.dir) { Ts = T.s; Tv = T.v; Tm = T.mark; } else { Ts = P.sB; Tv = 0; Tm = last(); } };
    tt();
    if (st.mark) {
      // standing at a stop: off again when the timetable has it gone (late: after LATE_HOLD)
      st.dwell += dt; st.v = 0;
      const still = T.dir === st.dir && T.mark === st.mark;
      if (!still && st.dwell >= (st.hold || 0)) {
        if (st.mark === last() && T.dir !== st.dir) { st.dir = T.dir; P = st.dir ? b.route.back : b.route.out; st.s = P.sA; tt(); } // (the end of the way: turn for the other one)
        st.mark = null; st.dwell = 0; st.hold = 0;
      }
    }
    if (!st.mark) {
      const next = P.marks.find((m) => m.s > st.s + 0.05) || last();
      roadAt(P, st.s, _p);
      const vRoad = Math.max(1.5, P.V[_p.i] || 0);
      const lag = Math.max(0, Ts - st.s);
      const view = (st.view ||= { n: P.n, X: P.X, Y: P.Y, Z: P.Z, S: P.S });
      if (view.X !== P.X) { view.n = P.n; view.X = P.X; view.Y = P.Y; view.Z = P.Z; view.S = P.S; }
      view.s1 = next.s;
      let lim = Infinity;
      try { lim = this.clearAhead(view, st, dt, Math.max(vRoad, Tv), b.group.position, b); } catch (e) { if (!this.fleetWarn) { this.fleetWarn = true; console.warn('bus fleet clearance', e); } }
      if (lim >= Tv && !st.passing && (st.shift || 0) < 0.002 && lag < 0.05 && Math.abs(st.v - Tv) < 0.6) {
        st.s = Ts; st.v = Tv; // (on time, nothing in the way: exactly where the timetable has it)
      } else {
        // behind: faster than the timetable by what closes the gap before the timetable gets to the next stop
        // (at least CATCH; at most CATCH_MAX, within the road's own speed + CATCH_MAX); the timetable standing at
        // a stop: the road's own speed to it
        const dT = Math.max(4, next.s - Ts);
        const k = clamp((1.1 * lag) / dT, CATCH, CATCH_MAX);
        let vt = Tv > 3 ? Tv + Math.min(0.5 * lag, Tv * k) : Tv + Math.min(0.5 * lag + 1, vRoad);
        vt = Math.min(vt, Math.max(vRoad * (1 + CATCH_MAX), 1.5));
        vt = Math.min(vt, Math.sqrt(2 * 1.3 * Math.max(0, next.s - st.s)) + 0.4); // (to a stop at the next one)
        vt = Math.min(vt, lim);
        st.v = Math.max(0, st.v + clamp(vt - st.v, -BUS.brake * 2 * dt, BUS.acc * dt));
        st.s = Math.min(Ts, next.s, st.s + st.v * dt);
        if (st.s >= Ts - 1e-4 && !st.passing) st.v = Math.min(st.v, Tv + 0.3); // (caught up: no faster than the timetable now)
      }
      steerShift(st, dt, st.v);
      // at the stop (or held up just short of it while the timetable stands there: it opens its doors there)
      const there = st.s >= next.s - 0.05, held = next.s - st.s < 25 && lim < 0.5 && st.v < 0.3 && Tm === next;
      if (there || held) {
        if (there) st.s = Math.max(st.s, next.s);
        st.mark = next; st.v = 0; st.dwell = 0;
        st.hold = Tm === next || next.stop?.depot || next === last() ? 0 : LATE_HOLD; // (the timetable gone already: a short halt)
      }
    }
    st.lagS = Math.max(0, Ts - st.s);
    // how far behind the timetable (s): roughly, by the distance at its speed
    st.lag = T.dir !== st.dir ? 999 : st.lagS / Math.max(6, T.v || 0);
  }

  /** Per frame (main.js): the fleet on its rounds. p: where you are (the buses near you drive themselves). */
  updateFleet(dt, p) {
    if (MIC_GLASSES.size) busGlass([this.bus.group, ...this.fleet.map((b) => b.group)]);
    // bus:0's passengers and cabin near you only (the fleet's below)
    if (this.bus.micruss && p && this.bus.group.visible) {
      const g = this.bus.group.position, d0 = Math.hypot(g.x - p.x, g.z - p.z);
      if (stalePeople(this.bus)) this.bus.people = null;
      if (!this.bus.people && d0 < PEOPLE_NEAR) { this.bus.people = busPeople(this.bus, 0, false); if (this.bus.people) this.bus.group.add(this.bus.people); }
      busNear(this.bus.shell, this.bus.people, d0, g, this.yaw || 0);
    }
    if (!this.fleet.length || !(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this.fleetClock += dt;
    // your own bus, waiting at the village stop (as you arrived, or after a ride there): once you are well away from it,
    // back in its bay at the depot, out of the way of the buses coming in to the stop
    if (!this.mp && !this.ride && this.at && this.at === busRoads.stops[0] && busRoads.depot && p && this.bus.group.visible) {
      const g = this.bus.group.position;
      if (Math.hypot(g.x - p.x, g.z - p.z) > 90) this.parkInDepot();
    }
    const T = (this._ft ||= {}), TH = (this._fth ||= {});
    if (this.mp) this.mpBus0();
    this._frame = (this._frame | 0) + 1; // (the obstacles: once a frame)
    const now = this.mp ? this.mp.now?.() ?? Date.now() : 0, me = this.mp ? this.mp.pid?.() : 0;
    for (const b of this.fleet) {
      if (b.taken) continue;
      this.fleetTarget(b, T);
      const d = p ? Math.hypot(b.x - p.x, b.z - p.z) : Infinity;
      b.near = d < FLEET_SHOW;
      const st = b.st;
      b.vPrev = st && !st.mark ? st.v : 0;
      // multiplayer: the bus's shared hold-up record (HOLD), if it has one
      const H = this.mp ? this.holdFor(b, now) : null;
      // driving it yourself (held up near you, reported): until it is out of your range, or someone else (reporting
      // since you took it) holds it further back, or as far back for a while (they see the same block: following
      // them is no worse for what you see; mustTake takes it back if it is)
      if (b.own && (!st || d > FLEET_SIM || (H && H.own !== me && H.fresh && this.holds.get(b.id).at > (b.ownAt || 0) && this.yields(b, st, H, now)))) { b.own = false; b.gaveUp = now; }
      if (H && !b.own) {
        // placed from the record: where its timetable was H.d s ago, out in the other lane by H.sh
        this.followStep(b, this.fleetTarget(b, TH, H.d), H, dt, d);
        // ...unless it would run into something you see there: then you drive it (and report it, with the longer delay)
        if (d < FLEET_SIM && !H.ram && now - (b.gaveUp || -1e9) > 1000 && this.mustTake(b, dt)) {
          const s2 = b.st;
          b.own = true; b.ownAt = now; b.repAt = 0;
          s2.passing = H.sh >= 0.5; s2.passV = s2.passing ? PASS_V : Infinity; s2.ram = false; s2.blockT = H.bt; s2.heldT = 0; s2.slowT = 0; s2.horn = 0;
          s2.lagS = Math.max(0, (T.dir === s2.dir ? T.s : s2.s) - s2.s);
        }
      } else if (!st || d > FLEET_SIM || (st.lag > 180 && d > 600)) this.fleetReset(b, T); // far from you (or new): exactly where the timetable has it
      else this.fleetDrive(b, st, T, dt); // near you: the timetable plus its own delay
      // (multiplayer: held up near you -> reported; back on time -> cleared)
      if (this.mp && b.st && (b.own || (!H && d < FLEET_SIM))) this.holdReport(b, now);
      b.d = d;
    }
    // two waiting at one stop queue one behind the other (by how far each stands short of the stop)
    const Q = (this._fq ||= new Map());
    Q.clear();
    for (const b of this.fleet) {
      const st = b.st;
      if (b.taken || !st) continue;
      const P = st.dir ? b.route.back : b.route.out;
      b.sq = st.s;
      if (!st.mark || st.mark.stop.depot) continue; // (in the depot each in its own bay)
      const k = st.mark.stop.name + st.dir;
      if (!Q.has(k)) Q.set(k, []);
      Q.get(k).push(b);
      b.short = st.mark.s - st.s;
      b.pathLen = P.length;
    }
    for (const list of Q.values()) {
      if (list.length < 2) continue;
      list.sort((a, c) => a.short - c.short || a.id.localeCompare(c.id));
      let need = -Infinity;
      for (const b of list) { const e = Math.max(b.short, need); b.sq = b.st.mark.s - e; need = e + BUS.len + 3; }
    }
    for (const b of this.fleet) {
      const st = b.st, d = b.d;
      if (b.taken || !st) continue;
      // drawn near you only (cheap far away: just its timetable)
      const P = st.dir ? b.route.back : b.route.out, sq = Math.max(0, b.sq);
      b.v = st.mark ? 0 : st.v;
      b.at = st.mark && !st.mark.stop.depot ? st.mark.stop : null; // (in its bay at the depot: at no stop)
      if (d < FLEET_SHOW) {
        b.yaw = poseBus(b.group, P, sq, st.shift || 0, st.shiftV || 0, st.v || 0);
        const mine = this.ride?.fleetBus === b && this.ride.mp; // (multiplayer: the one you ride is drawn as bus:0's cabin)
        b.group.visible = !mine;
        const g = b.group.position;
        b.x = g.x; b.y = g.y; b.z = g.z;
        b.collider.x = mine ? 1e9 : g.x; b.collider.z = g.z; b.collider.rot = -b.yaw;
        setLamps(b.lamps, b.v, b.vPrev ?? b.v, dt);
        // (its wheels roll and steer within WHEEL_NEAR; its cabin and passengers within PEOPLE_NEAR)
        if (this.bus.micruss && !mine) {
          const sh = b.group.userData.shell;
          if (d < WHEEL_NEAR) turnWheels(sh, g, b.yaw);
          if (stalePeople(b)) b.people = null;
          if (!b.people && d < PEOPLE_NEAR) { b.people = busPeople(this.bus, b.group.userData.bid, true); if (b.people) b.group.add(b.people); }
          busNear(sh, b.people, d, g, b.yaw);
        }
        if (st.ram && !st.mark) this.ramContact(g, b.yaw, b.v, b, dt); // (pushing through: bumped out of its way)
      } else {
        roadAt(P, sq, _p);
        b.x = _p.x; b.y = _p.y; b.z = _p.z; b.yaw = Math.atan2(_p.dx, _p.dz);
        b.group.visible = false;
        b.collider.x = 1e9;
      }
    }
  }

  // ------------------------------------------------------------------ multiplayer (net/transit.js)
  // The buses are shared: bus:1..7 run their rounds on the server's clock (mp.time(route): each round its own
  // timeline, 'bus|R<idx>'); you wait at the stop for a real bus that goes your way and ride it on its round, in the
  // seat the server gave you, until it stands at your stop. bus:0 (single player's own bus, waiting at the village)
  // is not used: its cabin is drawn in place of the fleet bus you ride (the fleet bus itself is hidden for you).
  /** Multiplayer on (hook { time(route) -> s, rate(route) }) or off (null: back to single player). */
  setMp(hook) {
    if (this.mp === hook) return;
    if (this.ride?.mp) this.abort();
    this.mp = hook || null;
    this.holds.clear();
    for (const b of this.fleet) { b.st = null; b.own = false; b.repAt = 0; } // (re-placed from the timetable next frame)
    if (!this.mp && !this.parkInDepot()) this.parkAtVillage();
    else this.mpBus0();
  }
  // ---- the hold-ups (HOLD): the server's records
  /** A 'busHold' broadcast: { bus, d, dd, sh, sv, ram, bt, own, at } or { bus, clear }. */
  setHold(d) {
    if (!d || typeof d.bus !== 'string') return;
    if (d.clear) { this.holds.delete(d.bus); return; }
    if (!Number.isFinite(d.d) || !Number.isFinite(d.at)) return;
    this.holds.set(d.bus, d);
  }
  /** The records standing now (joining a world: net/transit.js fetchHolds). */
  setHolds(list) { this.holds.clear(); for (const d of list || []) this.setHold(d); }
  // bus b's record now (aged: holdAt), or null (none, or aged out: forgotten)
  holdFor(b, now) {
    const rec = this.holds.get(b.id);
    if (!rec) return null;
    const H = holdAt(rec, now, (b.hrec ||= {}));
    if (H.done) { this.holds.delete(b.id); return null; }
    return H;
  }
  // how far behind its timetable bus b is (s on its round's timeline): when its timetable was where it is now
  // (standing at a stop it got to: the time it has stood there counted in)
  delayOf(b, st) {
    const r = b.route, c = r.cycle, P = st.dir ? r.back : r.out;
    const at = st.mark && Math.abs(st.s - st.mark.s) < 1 ? st.mark.t + Math.min(st.dwell || 0, st.mark.dwell) : timeAt(P, st.s);
    const tau = ((((this.mp ? this.mp.time(r) : this.fleetClock) + b.phase) % c) + c) % c;
    const D = ((((tau - (st.dir ? r.out.dur : 0) - at) % c) + c) % c);
    return D > c / 2 ? 0 : Math.min(D, HOLD.MAX); // (never ahead of it)
  }
  // a bus you drive near you (fleetDrive): off its timetable (behind, out in the other lane, pushing through) ->
  // reported (REPORT_MS, at once when it pulls out / in or starts pushing through); back on it -> cleared
  holdReport(b, now) {
    const st = b.st, off = st.lagS > 0.3 || (st.shift || 0) > 0.01 || st.passing || st.ram;
    if (!off) {
      if (b.own) { b.own = false; b.repAt = 0; if (this.holds.get(b.id)?.own === this.mp.pid?.()) this.holds.delete(b.id); try { this.mp.report?.({ bus: b.id, d: 0, sh: 0 }); } catch { /* (offline) */ } }
      return;
    }
    if (!b.own) { b.own = true; b.ownAt = now; }
    const D = this.delayOf(b, st), pass = !!st.passing, ram = !!st.ram;
    if (b.repAt && now - b.repAt < REPORT_MS && pass === b.repPass && ram === b.repRam) return;
    const h = b.repAt ? (now - b.repAt) / 1000 : 0;
    b.repDD = h > 0.05 ? clamp((D - b.repD) / h, -4, 32) : st.v < 0.3 && !st.mark ? 1 : 0; // (standing: the timetable runs away at 1 s/s)
    b.repAt = now; b.repD = D; b.repPass = pass; b.repRam = ram;
    const r2 = (x) => Math.round(x * 1000) / 1000;
    try { this.mp.report?.({ bus: b.id, d: r2(D), dd: r2(b.repDD), sh: r2(clamp(st.shift || 0, 0, 1)), sv: r2(clamp(st.shiftV || 0, -1, 1)), ram, bt: r2(clamp(st.blockT || 0, 0, 600)) }); } catch { /* (offline) */ }
  }
  // someone else's record for the bus you drive: theirs clearly further back, or about as far for 2.5 s
  yields(b, st, H, now) {
    const D = this.delayOf(b, st);
    return H.d >= D + 0.25 || (H.d >= D - 0.25 && now - (b.ownAt || 0) > 2500);
  }
  // bus b placed from its record H (TH: its timetable H.d s ago): eased onto it (no pop when a new report comes),
  // straight there when it is far from where it was drawn or far from you
  followStep(b, TH, H, dt, dist) {
    let st = b.st;
    const rate = this.mp?.rate?.(b.route) || 1;
    if (!st || st.dir !== TH.dir || Math.abs(TH.s - st.s) > 40 || dist > FLEET_SIM) {
      this.fleetReset(b, TH); st = b.st; st.shift = H.sh;
    } else {
      const prev = st.s, pred = st.s + TH.v * rate * dt;
      st.s = pred + (TH.s - pred) * (1 - Math.exp(-dt * 3));
      if (TH.mark && Math.abs(st.s - TH.mark.s) < 0.25) st.s = TH.mark.s;
      st.v += (clamp((st.s - prev) / Math.max(1e-3, dt), 0, 40) - st.v) * Math.min(1, dt * 8);
      const sh0 = st.shift || 0;
      st.shift = clamp(sh0 + (H.sh - sh0) * (1 - Math.exp(-dt * 3)), 0, 1);
      st.shiftV = (st.shift - sh0) / Math.max(1e-3, dt);
    }
    st.mark = TH.mark && Math.abs(st.s - TH.mark.s) < 0.5 ? TH.mark : null;
    if (st.mark) st.v = 0;
    st.dwell = 0; st.hold = st.mark ? Math.max(0, st.mark.t + st.mark.dwell - TH.tau) : 0;
    st.passing = H.sh >= 0.5; st.ram = H.ram; st.blockT = H.bt;
    st.heldT = 0; st.slowT = 0; st.horn = 0; st.passV = Infinity;
    st.lagS = 0; st.lag = H.d;
  }
  // a bus placed from someone else's record: would it run into something you see (going faster than it may to stop
  // short of it: clearAhead, probing only)?
  mustTake(b, dt) {
    const st = b.st;
    if (!st || st.mark || st.v < 0.8) return false;
    const P = st.dir ? b.route.back : b.route.out;
    const next = P.marks.find((m) => m.s > st.s + 0.05) || P.marks[P.marks.length - 1];
    const view = (st.view ||= { n: P.n, X: P.X, Y: P.Y, Z: P.Z, S: P.S });
    if (view.X !== P.X) { view.n = P.n; view.X = P.X; view.Y = P.Y; view.Z = P.Z; view.S = P.S; }
    view.s1 = next.s;
    let lim = Infinity;
    try { lim = this.clearAhead(view, st, dt, BUS.cruise, b.group.position, b, true); } catch { return false; }
    return st.v > lim + 0.8;
  }
  // bus:0 is out of the game in multiplayer (its cabin shows only round you, in the fleet bus you ride)
  mpBus0() {
    if (this.ride?.mp) return;
    this.at = null;
    if (this.bus.group.visible) { this.bus.group.visible = false; if (this.collider) this.collider.x = 1e9; }
  }
  // the marks (stops) bus b's round reaches from mark i of way d on: the rest of that way, then the other way
  serves(b, d, i, to) {
    const r = b.route, A = d ? r.back : r.out, B = d ? r.out : r.back;
    for (let k = i + 1; k < A.marks.length; k++) if (sameStop(A.marks[k].stop, to)) return true;
    for (const m of B.marks) if (sameStop(m.stop, to)) return true;
    return false;
  }
  // bus b at mark m of way d, `into` s after its timetable got there: { bus, wait, left } by the timetable, or by
  // where the bus near you really is (held up on its way: not there yet; got there late: its short halt)
  busAt(b, d, m, into, c) {
    let n = into < m.dwell ? { bus: b, wait: 0, left: m.dwell - into } : { bus: b, wait: c - into, left: m.dwell };
    const st = b.st;
    if (!st || !b.near || b.taken) return n;
    if (st.mark === m && st.dir === d) { if (n.wait > 0) n = { bus: b, wait: 0, left: Math.max(0, (st.hold || 0) - st.dwell) }; }
    else if (n.wait === 0 && (st.dir !== d || st.s < m.s - 0.5)) n = { bus: b, wait: st.dir === d ? Math.max(1, (m.s - st.s) / 7) : 20, left: n.left };
    return n;
  }
  /** The next bus from stop `from` that goes on to `to`: { bus, wait (s until it stands at the stop), left (s it still
   *  stands there) } (wait 0: it is there now), or null when no round serves the trip. */
  mpNextBus(from, to) {
    let best = null;
    for (const b of this.fleet) {
      const r = b.route, c = r.cycle;
      const tau = ((((this.mp ? this.mp.time(r) : this.fleetClock) + b.phase) % c) + c) % c;
      for (let d = 0; d < 2; d++) {
        const P = d ? r.back : r.out;
        for (let i = 0; i < P.marks.length; i++) {
          const m = P.marks[i];
          if (!sameStop(m.stop, from) || !this.serves(b, d, i, to)) continue;
          const at = (d ? r.out.dur : 0) + m.t, into = (((tau - at) % c) + c) % c;
          const n = this.busAt(b, d, m, into, c);
          if (!best || n.wait < best.wait || (n.wait === 0 && best.wait === 0 && n.left > best.left)) best = n;
        }
      }
    }
    return best;
  }
  /** Every bus from `from` that goes on to `to`, soonest first: [{ bus, wait, left }] (its next stop there each;
   *  multiplayer: the next one with a free seat, net/transit.js). */
  mpBuses(from, to) {
    const out = [];
    for (const b of this.fleet) {
      const r = b.route, c = r.cycle;
      const tau = ((((this.mp ? this.mp.time(r) : this.fleetClock) + b.phase) % c) + c) % c;
      let best = null;
      for (let d = 0; d < 2; d++) {
        const P = d ? r.back : r.out;
        for (let i = 0; i < P.marks.length; i++) {
          const m = P.marks[i];
          if (!sameStop(m.stop, from) || !this.serves(b, d, i, to)) continue;
          const at = (d ? r.out.dur : 0) + m.t, into = (((tau - at) % c) + c) % c;
          const n = this.busAt(b, d, m, into, c);
          if (!best || n.wait < best.wait) best = n;
        }
      }
      if (best) out.push(best);
    }
    return out.sort((x, y) => x.wait - y.wait || y.left - x.left);
  }
  /** The seat single player gives you (a window seat on the left, row 2): the seat registry's index. */
  preferredSeat() { const S = this.bus.seats; return Math.max(0, S.indexOf(S.find((q) => q.window && q.side < 0 && q.row === 2) || S[0])); }
  get seatCount() { return this.bus.seats.length; }
  /** Where seat n of fleet bus `id` is now (as drawn here): into out, its facing as a heading; null if not placed. */
  seatWorldAt(id, n, out) {
    const st = this.bus.seats[n];
    let b = null;
    for (const q of this.fleet) if (q.id === id) { b = q; break; }
    if (!st || !b || !b.near || b.taken) return null;
    const g = b.group; // (posed on the road; its parent is the scene)
    out.copy(st.pos).applyQuaternion(g.quaternion).add(g.position);
    _mpf.set(Math.sin(st.yaw || 0), 0, Math.cos(st.yaw || 0)).applyQuaternion(g.quaternion);
    return Math.atan2(_mpf.x, _mpf.z);
  }
  // board fleet bus pick.bus at `from` (it stands there) for `to`, in seat pick.seat
  mpBoard(from, to, pick) {
    const b = pick.bus;
    if (!b || b.taken) return null;
    const seat = this.bus.seats[pick.seat] || this.bus.seats[0];
    this.ride = { mp: true, fleetBus: b, from, to, seat, seatNo: this.bus.seats.indexOf(seat), v: 0, departed: false, exitSent: false, li: 0, legs: [], t: null, s: 0 };
    this.look.yaw = -0.35; this.look.pitch = -0.05;
    this.view = 'seat'; this.fov = null; this.chase.off = null;
    this.bus.group.visible = true;
    this.mpPose();
    this.setInside(true);
    return this.seatPose();
  }
  // bus:0's cabin onto the fleet bus you ride
  mpPose() {
    const b = this.ride.fleetBus, g = this.bus.group;
    g.position.copy(b.group.position); g.quaternion.copy(b.group.quaternion);
    if (this.collider) this.collider.x = 1e9;
    this.yaw = b.yaw;
    turnWheels(this.bus.shell, g.position, b.yaw);
  }
  updateMpRide() {
    const r = this.ride, b = r.fleetBus, st = b.st;
    this.timeScale = this.mp?.rate(b.route) || 1;
    this.mpPose();
    r.v = b.v;
    if (!sameStop(b.at, r.from)) r.departed = true;
    const seat = this.seatPose();
    if (r.departed && sameStop(b.at, r.to)) {
      if (!r.exitSent) {
        r.exitSent = true;
        const g = this.bus.group;
        const door = g.localToWorld(_c.set(-(BUS.width / 2 + 1.8), 0, BUS.len / 2 - 2.0));
        const fw = new THREE.Vector3(0, 0, 1).transformDirection(g.matrixWorld);
        return { seat, exit: { x: door.x, z: door.z, heading: Math.atan2(fw.x, fw.z), name: r.to.name }, hint: `${r.to.name} · arrived` };
      }
      return { seat, hint: `${r.to.name} · arrived` };
    }
    let hint = `Ski bus to ${r.to.name} · waiting at ${r.from.name}`;
    if (st && r.departed) {
      const P = st.dir ? b.route.back : b.route.out;
      const next = st.mark ? st.mark : P.marks.find((m) => m.s > st.s + 0.05) || P.marks[P.marks.length - 1];
      hint = st.mark ? `Ski bus to ${r.to.name} · stopped at ${next.stop.name}` : `Ski bus to ${r.to.name} · next stop ${next.stop.name} · ${Math.round(r.v * 3.6)} km/h`;
    }
    return { seat, hint };
  }

  /** The fleet now (multiplayer, the route map): [{ id, x, z, yaw, at (stop name), route, seats, taken }] */
  fleetState() {
    return [
      { id: 'bus:0', x: this.bus.group.position.x, z: this.bus.group.position.z, yaw: this.yaw || 0, at: this.at?.name || null, route: null, seats: this.bus.seats.length, taken: !!this.ride },
      ...this.fleet.map((b) => ({ id: b.id, x: b.x, z: b.z, yaw: b.yaw, at: b.at?.name || null, route: b.route.to.name, seats: b.seats, taken: !!b.taken })),
    ];
  }

  abort() {
    if (!this.ride) return;
    const r = this.ride;
    this.ride = null;
    if (r.mp) { this.setInside(false); this.bus.group.visible = false; this.timeScale = 1; return; } // (the fleet bus drives on)
    if (r.fleetBus) { r.fleetBus.taken = false; r.fleetBus.st = null; } // (back on its round, where its timetable has it)
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
export const railsForTest = { planRails, railRuns, roadStrip, ACROSS, Guardrails, BEAM_TOP }; // (Node checks)
