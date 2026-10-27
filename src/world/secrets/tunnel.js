// Tunnel meshes for the secrets: an old miners' drift (rough-hewn rock, timber sets, oil lanterns, a timber portal
// in a rock headwall) or a glacier ice cave (irregular blue ice, icicles, a natural ice mouth). The tube sits in
// the trench of tunnelCuts (cuts.js), the lid (lid.js) closes the mountain over it.
//  - inside it is dark: daylight reaches ~20 m in from the portals, the lanterns light the rest (pools baked per
//    vertex: aLight = (lamp, daylight)); a multiply decal darkens the snow floor, an additive one lays the pools
//  - soft wall colliders (you brush along a wall, you never wipe out on it) and a low-poly camera blocker keep the
//    skier and the third-person camera inside the tube
import * as THREE from 'three';
import { Simplex, smoothstep, mulberry32, clamp } from '../../core/noise.js';
import { MeshBuilder, tint, canvasTexture } from '../../modes/parkour/kit.js';
import { createTerrainMaterial } from '../terrain.js';
import { quality, onQualityChange } from '../../engine/quality.js';
import { late, sharedMaterial } from './slice.js';
import { rockSkinMaterial, skinLateral } from './rock.js';
import { lanternOnBracket, bracketLanterns } from '../meshylights.js';

const NZ = new Simplex(5501);
const WHITE = new THREE.Color(1, 1, 1);
// the Meshy lamp post (lamp_post.glb) whose lantern hangs on its bracket on the timber posts and beside the portals
// (Secrets sets it once the models are loaded; without it the old built lanterns)
let LAMP_MODEL = null;
export function setLanternModel(gltf) { LAMP_MODEL = gltf || null; }
export const lanternModel = () => LAMP_MODEL;
const LANTERN_IN = 0.6, LANTERN_PORTAL = 0.75; // lantern size (m per model unit): ~0.25 / 0.31 m glass
const LANTERN_GLOW = [1.0, 0.62, 0.3];

// ------------------------------------------------------------------ textures (256 px tiles, shared)
const TEX = {};
function tex(key, draw) {
  if (key in TEX) return TEX[key];
  return (TEX[key] = canvasTexture(256, 256, draw, { wrap: true, anisotropy: 4 }));
}
function speckle(g, rnd, n, a, b, size = 1.6) {
  for (let i = 0; i < n; i++) { g.fillStyle = rnd() < 0.5 ? a : b; const s = 0.6 + rnd() * size; g.fillRect(rnd() * 256, rnd() * 256, s, s); }
}
function blobs(g, rnd, n, r0, r1, cols) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = r0 + rnd() * (r1 - r0), c = cols[Math.floor(rnd() * cols.length)];
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
}
function cracks(g, rnd, n, col, len, lw = 1) {
  g.strokeStyle = col; g.lineWidth = lw;
  for (let i = 0; i < n; i++) {
    let x = rnd() * 256, y = rnd() * 256, a = rnd() * 6.28;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < len / 4; k++) { a += (rnd() - 0.5) * 1.1; x += Math.cos(a) * 4; y += Math.sin(a) * 4; g.lineTo(x, y); }
    g.stroke();
  }
}
// hewn rock: grey-brown, chisel facets, cracks, damp streaks (tile = 4 m)
export function rockTexture() {
  return tex('rock', (g) => {
    const rnd = mulberry32(8101);
    g.fillStyle = '#6d6862'; g.fillRect(0, 0, 256, 256);
    blobs(g, rnd, 70, 12, 46, ['rgba(30,28,26,0.28)', 'rgba(255,250,240,0.10)', 'rgba(95,80,62,0.22)', 'rgba(40,46,56,0.22)']);
    // chisel facets: short angular light/dark planes
    for (let i = 0; i < 160; i++) {
      const x = rnd() * 256, y = rnd() * 256, w = 6 + rnd() * 18, h = 4 + rnd() * 10, a = rnd() * 3.14;
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.12)';
      g.fillRect(-w / 2, -h / 2, w, h); g.restore();
    }
    speckle(g, rnd, 5000, 'rgba(255,255,255,0.16)', 'rgba(0,0,0,0.24)', 1.4);
    cracks(g, rnd, 18, 'rgba(20,18,16,0.45)', 46, 1.2);
    // damp streaks running down
    for (let i = 0; i < 14; i++) {
      const x = rnd() * 256, w = 2 + rnd() * 6;
      const gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, 'rgba(20,24,30,0)'); gr.addColorStop(0.5, 'rgba(20,24,30,0.22)'); gr.addColorStop(1, 'rgba(20,24,30,0)');
      g.fillStyle = gr; g.fillRect(x, 0, w, 256);
    }
  });
}
// weathered timber (tile = one beam face: grain along u)
export function woodTexture() {
  return tex('wood', (g) => {
    const rnd = mulberry32(8203);
    g.fillStyle = '#6b4a2e'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 90; i++) {
      const y = rnd() * 256, h = 0.8 + rnd() * 2.6;
      g.fillStyle = rnd() < 0.5 ? `rgba(40,24,12,${0.25 + rnd() * 0.3})` : `rgba(160,120,80,${0.12 + rnd() * 0.18})`;
      g.fillRect(0, y, 256, h);
    }
    for (let i = 0; i < 8; i++) { // knots
      const x = rnd() * 256, y = rnd() * 256, r = 3 + rnd() * 5;
      g.fillStyle = 'rgba(35,20,10,0.6)'; g.beginPath(); g.ellipse(x, y, r * 2, r, 0, 0, 6.29); g.fill();
    }
    blobs(g, rnd, 26, 10, 40, ['rgba(20,20,20,0.18)', 'rgba(200,190,170,0.10)', 'rgba(90,100,90,0.12)']);
    speckle(g, rnd, 2500, 'rgba(255,240,220,0.10)', 'rgba(0,0,0,0.18)', 1.2);
  });
}
// glacier ice: deep blue, soft clouds of denser / clearer ice, faint annual layers, a few hairline fractures and
// bubbles -- calm, so the walls read as ice rather than a printed pattern (tile = 6 m)
export function iceTexture() {
  return tex('ice', (g) => {
    const rnd = mulberry32(8307);
    g.fillStyle = '#6aaedc'; g.fillRect(0, 0, 256, 256);
    blobs(g, rnd, 46, 30, 90, ['rgba(20,80,150,0.16)', 'rgba(150,215,245,0.14)', 'rgba(40,110,185,0.14)', 'rgba(210,240,255,0.08)']);
    // annual layers: broad, soft, slightly wavy
    for (let i = 0; i < 9; i++) {
      const y = rnd() * 256, hgt = 4 + rnd() * 10, a = 0.03 + rnd() * 0.05;
      const gr = g.createLinearGradient(0, y - hgt, 0, y + hgt);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, `rgba(235,248,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      for (const oy of [-256, 0, 256]) g.fillRect(0, y - hgt + oy, 256, hgt * 2);
    }
    cracks(g, rnd, 7, 'rgba(235,248,255,0.2)', 50, 0.8);
    cracks(g, rnd, 5, 'rgba(25,80,140,0.18)', 36, 0.8);
    for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(255,255,255,${0.12 + rnd() * 0.16})`; g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 0.4 + rnd() * 0.9, 0, 6.29); g.fill(); }
  });
}

// ------------------------------------------------------------------ interior lighting
// Lit inside the mountain: the sun and the sky only reach in from the portals (aLight.y), the lanterns add warm
// pools (aLight.x). The glacier cave keeps a blue glow through the ice.
export function interiorMaterial(params, { ice = false, lamp = [1.0, 0.78, 0.5], key = 'mine' } = {}) {
  const m = new THREE.MeshStandardMaterial(params);
  const v3 = (c) => `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`;
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aLight;\nvarying vec2 vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vLight;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directDiffuse *= vLight.y;
        reflectedLight.directSpecular *= vLight.y;
        reflectedLight.indirectDiffuse *= mix(${ice ? 'vec3(0.16, 0.36, 0.62)' : 'vec3(0.03)'}, vec3(1.0), vLight.y);
        reflectedLight.indirectSpecular *= mix(${ice ? '0.45' : '0.05'}, 1.0, vLight.y);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * ${v3(lamp)} * (vLight.x * ${ice ? '0.55' : '1.25'} + ${ice ? '0.035' : '0.012'});`);
  };
  m.customProgramCacheKey = () => 'secret-interior-' + key;
  return m;
}

// the materials of the tunnels (shared by every build; tunnelMaterials() makes them all, for the boot's compile)
const LAMP_MINE = [1.0, 0.74, 0.44], LAMP_ICE = [0.62, 0.86, 1.15];
const MAT = {
  tubeMine: () => sharedMaterial('tube-mine', () => Object.assign(interiorMaterial({ map: rockTexture(), vertexColors: true, roughness: 0.94, metalness: 0, envMapIntensity: 0.5 }, { lamp: LAMP_MINE, key: 'mine' }), { side: THREE.DoubleSide })),
  tubeIce: () => sharedMaterial('tube-ice', () => Object.assign(interiorMaterial({ map: iceTexture(), vertexColors: true, roughness: 0.34, metalness: 0, envMapIntensity: 0.65, emissive: new THREE.Color(0x0b2a4a), emissiveIntensity: 1 }, { ice: true, lamp: LAMP_ICE, key: 'ice' }), { side: THREE.DoubleSide })),
  timber: () => sharedMaterial('tube-timber', () => interiorMaterial({ map: woodTexture(), vertexColors: true, roughness: 0.88, metalness: 0 }, { lamp: LAMP_MINE, key: 'timber' })),
  iron: () => sharedMaterial('tube-iron', () => interiorMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 }, { lamp: LAMP_MINE, key: 'iron' })),
  icicle: () => sharedMaterial('tube-icicle', () => interiorMaterial({ vertexColors: true, roughness: 0.12, metalness: 0, emissive: new THREE.Color(0x0e3558), emissiveIntensity: 1 }, { ice: true, lamp: LAMP_ICE, key: 'icicle' })),
  // (lantern glass: a clone per lantern, each flickers on its own; one program)
  glass: () => sharedMaterial('lantern-glass', () => new THREE.MeshStandardMaterial({ color: 0x221a10, emissive: new THREE.Color(1.0, 0.62, 0.3), emissiveIntensity: 3, roughness: 0.4 })),
  decalMul: () => sharedMaterial('decal-multiply', () => new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.MultiplyBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
  decalAdd: () => sharedMaterial('decal-add', () => new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
  blocker: () => sharedMaterial('camera-blocker', () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
  portalWood: () => sharedMaterial('portal-wood', () => new THREE.MeshStandardMaterial({ map: woodTexture(), vertexColors: true, roughness: 0.86, metalness: 0 })),
  snowTrim: () => sharedMaterial('snow-trim', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 })),
  iron2: () => sharedMaterial('portal-iron', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 })),
  // (a carved board: a clone per board with its own canvas; one program)
  board: () => sharedMaterial('carved-board', () => new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.8 })),
  glacier: () => sharedMaterial('glacier-ice', () => new THREE.MeshStandardMaterial({ map: iceTexture(), color: 0xc4e6fb, roughness: 0.3, metalness: 0, emissive: new THREE.Color(0x0b2c4c), emissiveIntensity: 0.75, envMapIntensity: 0.8, side: THREE.DoubleSide })),
  portalIcicle: () => sharedMaterial('portal-icicle', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0, emissive: new THREE.Color(0x10304c), emissiveIntensity: 0.6 })),
};
export function tunnelMaterials() { for (const k in MAT) MAT[k](); portalRockMaterial(); }
/** blue glacier ice (UV-mapped): the ice cave's headwall and cutting, the grotto's icefall */
export const glacierIceMaterial = () => MAT.glacier();
/** a lantern's glass (its own material: the runtime flickers each one) */
export function lanternGlass(intensity = 3) { const m = MAT.glass().clone(); m.emissiveIntensity = intensity; m.userData.shared = false; return m; }
/** a board's material with its own canvas texture (disposed with the board) */
export function boardMaterial(map) { const m = MAT.board().clone(); m.map = map; m.userData.shared = false; if (map) map.userData.secretOwn = true; return m; }

// ------------------------------------------------------------------ the tube
/**
 * @param {object} t  path, floor(s), sA / sB (portal planes), depth (facade thickness), style 'mine' | 'ice',
 *   Wi (inner half-width), Hs (springline / cap height), Hc (crown), lampEvery (m), seed, name
 * @returns {{ group, colliders, blocker, interior }} interior = meshes using the interior lighting
 */
export function buildTube(t) {
  const it = buildTubeSteps(t);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
// the same as a generator that yields between slices of work (time-sliced building)
export function* buildTubeSteps(t) {
  const { path, floor, sA, sB, depth, style = 'mine', Wi = 4, Hs = 4, Hc = 5, seed = 1 } = t;
  const ice = style === 'ice', cave = style === 'cave', rough = ice || cave; // (cave: a natural rock cave)
  const group = new THREE.Group();
  group.name = 'secret-tunnel';
  const s0 = sA - depth, s1 = sB + depth;
  const rnd = mulberry32(seed * 977 + 13);
  const lampCol = ice ? LAMP_ICE : LAMP_MINE;
  // lantern spots along the drift (mine: hung from the timber caps, some dark; ice: none)
  const lamps = [];
  if (!ice) for (let s = sA + 6; s < sB - 4; s += t.lampEvery || (cave ? 17 : 12)) if (rnd() > 0.15) lamps.push({ s, side: rnd() < 0.5 ? -1 : 1 });
  // where each lantern hangs and its flame (v, h) is, which the pools are lit from. Meshy lantern: on its bracket,
  // (mine) on the inner face of a timber post, under its knee brace, (cave) in the rock wall; else the old ones
  // (mine: hung under a cap)
  const fx = lanternOnBracket(LAMP_MODEL, LANTERN_IN);
  for (const l of lamps) {
    if (!cave) l.s = Math.round((l.s - sA - 1.5) / 3) * 3 + sA + 1.5; // (on a timber set)
    if (fx) {
      l.mv = l.side * (cave ? Wi - 0.3 : Wi - 0.38); // the bracket's end: in the rock / 1 cm into the post's face
      l.mh = cave ? Hs - 1.4 : Hs - 1.75;
      l.v = l.mv - l.side * fx.flame.z; l.h = l.mh + fx.flame.y;
    } else { l.v = l.side * (Wi - 1.2); l.h = Hs - 0.6; }
  }
  const daylight = (s) => Math.max(1 - smoothstep(s0 - 1, s0 + (ice ? 30 : 20), s), smoothstep(s1 - (ice ? 30 : 20), s1 + 1, s));
  const lampAt = (s, v, h) => {
    let L = 0;
    for (const l of lamps) {
      const ds = s - l.s;
      if (ds < -12 || ds > 12) continue;
      const dv = v - l.v, dh = h - l.h;
      L += Math.exp(-(ds * ds + dv * dv * 0.6 + dh * dh * 0.5) / 14);
    }
    return Math.min(1.2, L);
  };
  // the Meshy lanterns of the tube, one draw (lit like the walls: daylight only near the portals)
  const meshyLanterns = () => {
    const f = {}, frames = lamps.map((l) => {
      path.at(l.s, f);
      return { position: new THREE.Vector3(f.x + f.rx * l.mv, floor(l.s) + l.mh, f.z + f.rz * l.mv), out: new THREE.Vector3(-f.rx * l.side, 0, -f.rz * l.side), light: [0.9, daylight(l.s)] };
    });
    const L = bracketLanterns(LAMP_MODEL, frames, { size: LANTERN_IN, color: LANTERN_GLOW, intensity: 5, deSnow: true, interior: true });
    if (!L) return;
    L.mesh.name = 'secret-lantern-glass'; // (the runtime flickers its glass)
    L.mesh.userData.secretKeep = true;    // (its buffers are the shared lantern's)
    group.add(L.mesh);
  };

  // inner profile (v, h): walls to the cap, then a shallow arch (mine) / an irregular vault (ice)
  const prof = tubeProfile(style, Wi, Hs, Hc);
  const arc = [0];
  for (let k = 1; k < prof.length; k++) arc.push(arc[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
  const W = prof.length;
  const ringStep = rough ? 1.0 : 1.25;
  const NR = Math.ceil((s1 - s0) / ringStep);
  const pos = [], nor = [], col = [], uv = [], light = [];
  const fr = {};
  // displaced profile point (rough rock / ice), none at the ends (they meet the facade openings) and the foot
  const disp = (s, k, v, h) => {
    const end = smoothstep(s0, s0 + 0.7, s) * (1 - smoothstep(s1 - 0.7, s1, s)); // (exactly the mouth's outline at the ends)
    const foot = smoothstep(0.2, 1.4, h);
    const a = ice ? 0.55 : cave ? 0.5 : 0.2;
    const n = NZ.noise(s * (rough ? 0.09 : 0.21) + k * 0.73, k * 0.37 + seed) * a + NZ.noise(s * 0.6 + k * 1.9, k * 1.1 - seed) * a * 0.35;
    return n * end * foot;
  };
  for (let j = 0; j <= NR; j++) {
    const s = s0 + ((s1 - s0) * j) / NR;
    path.at(s, fr);
    const y = floor(s), day = daylight(s);
    for (let k = 0; k < W; k++) {
      const [v0, h0] = prof[k];
      // outward normal of the profile (toward the rock), from its neighbours
      const a = prof[Math.max(0, k - 1)], b = prof[Math.min(W - 1, k + 1)];
      let nv = -(b[1] - a[1]), nh = b[0] - a[0];
      const nl = Math.hypot(nv, nh) || 1; nv /= nl; nh /= nl;
      if (nv * v0 + nh * (h0 - Hs * 0.6) < 0) { nv = -nv; nh = -nh; }
      const d = disp(s, k, v0, h0);
      const v = v0 + nv * d, h = h0 + nh * d;
      pos.push(fr.x + fr.rx * v, y + h, fr.z + fr.rz * v);
      nor.push(-fr.rx * nv, -nh, -fr.rz * nv); // inward
      uv.push(arc[k] / (ice ? 6 : 4), s / (ice ? 6 : 4));
      const low = 1 - smoothstep(0.1, 1.6, h0), crown = smoothstep(Hc - 0.8, Hc, h0);
      const g = ice ? 1 - low * 0.2 + crown * 0.05 : (1 - low * 0.42 - crown * 0.12) * (0.9 + 0.2 * NZ.noise(s * 0.13, k * 0.5));
      col.push(g, g, ice ? g * 1.03 : g * 0.97);
      light.push(lampAt(s, v, h), day);
    }
    if ((j & 7) === 7 && late()) yield;
  }
  const idx = [];
  for (let j = 0; j < NR; j++) for (let k = 0; k < W - 1; k++) {
    const a = j * W + k, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  yield;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aLight', new THREE.Float32BufferAttribute(light, 2));
  geo.setIndex(fixWinding(pos, nor, idx));
  geo.computeVertexNormals(); // the rough rock shades by its own relief
  orientNormals(geo, nor);
  geo.computeBoundingSphere();
  // (double-sided: seen from outside only if the camera clips the rock, never a hole)
  const tube = new THREE.Mesh(geo, ice ? MAT.tubeIce() : MAT.tubeMine());
  tube.castShadow = true; tube.receiveShadow = true;
  tube.name = 'secret-tube';
  group.add(tube);
  const interior = [tube];
  yield;

  // --- cave: old oil lanterns on iron brackets in the rock (the smugglers' lights), nothing else
  if (cave && fx) meshyLanterns();
  else if (cave) {
    const lb = new MeshBuilder(), gb = new MeshBuilder(), ll = [];
    for (const l of lamps) {
      path.at(l.s, fr);
      const y = floor(l.s), v = l.side * (Wi - 0.55), yaw = Math.atan2(fr.tx, fr.tz);
      const x = fr.x + fr.rx * v, z = fr.z + fr.rz * v, hy = Hs - 0.5;
      const c0 = lb.count;
      // a bracket out of the wall, the lantern hanging from it
      lb.at(fr.x + fr.rx * l.side * (Wi + 0.15), y + hy + 0.55, fr.z + fr.rz * l.side * (Wi + 0.15), 0).rod(0, 0, 0, x - (fr.x + fr.rx * l.side * (Wi + 0.15)), 0, z - (fr.z + fr.rz * l.side * (Wi + 0.15)), 0.02, 4, tint('#1b1c1f'));
      lb.at(x, y + hy, z, yaw).box(0, 0.28, 0, 0.3, 0.06, 0.3, tint('#1b1c1f')).box(0, -0.2, 0, 0.32, 0.05, 0.32, tint('#1b1c1f')).rod(0, 0.31, 0, 0, 0.56, 0, 0.012, 4, tint('#1b1c1f'));
      for (let i = c0; i < lb.count; i++) ll.push(0.9, daylight(l.s));
      gb.at(x, y + hy, z, yaw).box(0, 0.04, 0, 0.22, 0.42, 0.22, WHITE);
    }
    if (lb.count) {
      const lgeo = lb.build();
      lgeo.setAttribute('aLight', new THREE.Float32BufferAttribute(ll, 2));
      group.add(new THREE.Mesh(lgeo, MAT.iron()));
      const glass = new THREE.Mesh(gb.build(), lanternGlass(5));
      glass.name = 'secret-lantern-glass';
      group.add(glass);
    }
  }
  // --- mine: timber sets (posts + cap + knee braces) every 3 m, lanterns on the caps
  if (style === 'mine') {
    const tb = new MeshBuilder({ uv: true }), lb = new MeshBuilder(), gb = new MeshBuilder();
    const tl = [];
    const dark = tint('#ffffff');
    const set = (s, broken) => {
      path.at(s, fr);
      const y = floor(s), yaw = Math.atan2(fr.tx, fr.tz);
      const L = (v, h) => { tl.push(lampAt(s, v, h), daylight(s)); };
      const c0 = tb.count;
      for (const sd of [-1, 1]) {
        const v = sd * (Wi - 0.22);
        tb.at(fr.x + fr.rx * v, y, fr.z + fr.rz * v, yaw + (rnd() - 0.5) * 0.04).box(0, Hs / 2 - 0.2, 0, 0.34, Hs + 0.4, 0.34, tint('#ffffff', 0.12, s + sd));
        // knee brace
        tb.at(fr.x + fr.rx * (v - sd * 0.55), y + Hs - 0.55, fr.z + fr.rz * (v - sd * 0.55), yaw, 0, sd * 0.8).box(0, 0, 0, 0.18, 1.3, 0.2, tint('#ffffff', 0.1, s * 3 + sd));
      }
      if (!broken) tb.at(fr.x, y + Hs + 0.12, fr.z, yaw).box(0, 0, 0, Wi * 2 + 0.4, 0.36, 0.36, tint('#ffffff', 0.1, s * 7));
      else {
        // a cracked cap, one end sagging (still well above head height)
        tb.at(fr.x - fr.rx * Wi * 0.45, y + Hs + 0.05, fr.z - fr.rz * Wi * 0.45, yaw, 0, 0.12).box(0, 0, 0, Wi + 0.3, 0.34, 0.34, tint('#ffffff', 0.1, s * 5));
      }
      for (let i = c0; i < tb.count; i++) {
        const px = tb.P[i * 3], py = tb.P[i * 3 + 1], pz = tb.P[i * 3 + 2];
        L((px - fr.x) * fr.rx + (pz - fr.z) * fr.rz, py - y);
      }
    };
    let n = 0;
    for (let s = sA + 1.5; s < sB - 1; s += 3) { set(s, n++ % 9 === 6); if ((n & 3) === 3 && late()) yield; }
    // lanterns: the Meshy lantern on its bracket on a timber post, else a dark iron cage with a warm glass hung
    // under a cap
    if (fx) meshyLanterns();
    else for (const l of lamps) {
      const s = l.s;
      path.at(s, fr);
      const y = floor(s), v = l.side * (Wi - 1.2), yaw = Math.atan2(fr.tx, fr.tz);
      const x = fr.x + fr.rx * v, z = fr.z + fr.rz * v;
      lb.at(x, y + Hs - 0.62, z, yaw).box(0, 0.28, 0, 0.3, 0.06, 0.3, tint('#1b1c1f')).box(0, -0.2, 0, 0.32, 0.05, 0.32, tint('#1b1c1f'));
      lb.at(x, y + Hs - 0.62, z, yaw).rod(0, 0.31, 0, 0, 0.74, 0, 0.012, 4, tint('#1b1c1f'));
      gb.at(x, y + Hs - 0.62, z, yaw).box(0, 0.04, 0, 0.22, 0.42, 0.22, WHITE);
    }
    // (no rails on the floor: two bare rods without sleepers read as two stray lines drawn along the drift)
    const tgeo = tb.build();
    tgeo.setAttribute('aLight', new THREE.Float32BufferAttribute(tl, 2));
    const timber = new THREE.Mesh(tgeo, MAT.timber());
    timber.castShadow = true; timber.receiveShadow = true;
    group.add(timber); interior.push(timber);
    if (lb.count) {
      const lgeo = lb.build();
      const ll = [];
      for (let i = 0; i < lb.count; i++) { const sP = path.project(lb.P[i * 3], lb.P[i * 3 + 2], {}).s ?? sA; ll.push(0.9, daylight(sP)); }
      lgeo.setAttribute('aLight', new THREE.Float32BufferAttribute(ll, 2));
      group.add(new THREE.Mesh(lgeo, MAT.iron()));
    }
    if (gb.count) {
      const glass = new THREE.Mesh(gb.build(), lanternGlass(5));
      glass.name = 'secret-lantern-glass';
      group.add(glass);
    }
  } else if (ice) {
    // --- ice: icicles hanging from the vault, a few ice columns at the walls
    const ib = new MeshBuilder(), il = [];
    for (let s = sA + 2; s < sB - 1; s += 0.9 + rnd() * 1.4) {
      path.at(s, fr);
      const y = floor(s);
      const n = 1 + Math.floor(rnd() * 3);
      for (let q = 0; q < n; q++) {
        const a = 0.25 + rnd() * 0.5, k = Math.PI * a; // around the vault
        const v = -Wi * Math.cos(k) * 0.92, h = Hs + (Hc - Hs) * Math.sin(k) * 0.96;
        const len = 0.3 + rnd() * rnd() * 1.9;
        const c0 = ib.count;
        ib.at(fr.x + fr.rx * v, y + h - len, fr.z + fr.rz * v, rnd() * 6).cyl(0, 0, 0, 0.0, 0.05 + rnd() * 0.08, len, 5, tint('#d9f2ff', 0.05, s + q));
        for (let i = c0; i < ib.count; i++) il.push(0, daylight(s));
      }
    }
    if (ib.count) {
      const g = ib.build();
      g.setAttribute('aLight', new THREE.Float32BufferAttribute(il, 2));
      const icicles = new THREE.Mesh(g, MAT.icicle());
      group.add(icicles); interior.push(icicles);
    }
  }

  // --- the snow floor in the dark: multiply decal (daylight fades out), additive lamp pools
  yield;
  {
    const Pm = [], Cm = [], Ca = [], I = [];
    const M = Math.ceil((s1 - s0) / 1);
    const lat = [-1, -0.6, -0.2, 0.2, 0.6, 1];
    for (let j = 0; j <= M; j++) {
      const s = s0 + ((s1 - s0) * j) / M;
      path.at(s, fr);
      const y = floor(s), day = daylight(s);
      for (const l of lat) {
        const v = l * (Wi + 0.45); // (on under the walls' foot: the rough walls bulge back in places)
        Pm.push(fr.x + fr.rx * v, y + 0.04, fr.z + fr.rz * v);
        const k = THREE.MathUtils.lerp(ice ? 0.42 : 0.07, 1, day);
        Cm.push(k * (ice ? 0.8 : 1), k * (ice ? 0.92 : 0.97), k);
        const p = Math.min(1, lampAt(s, v, 0.2) * 1.4) * (1 - day) * 0.22;
        Ca.push(lampCol[0] * p, lampCol[1] * p, lampCol[2] * p);
      }
    }
    for (let j = 0; j < M; j++) for (let q = 0; q < lat.length - 1; q++) {
      const a = j * lat.length + q, b = a + 1, c = a + lat.length, d = c + 1;
      I.push(a, c, b, b, c, d);
    }
    const decal = (colors, mat, order) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(Pm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.setIndex(I);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = order;
      m.name = 'secret-floor-decal';
      group.add(m);
    };
    decal(Cm, MAT.decalMul(), 2);
    if (lamps.length) decal(Ca, MAT.decalAdd(), 3);
  }

  // --- soft wall colliders every 4 m (the skier brushes along), and the camera blocker (low-poly inner tube)
  yield;
  const colliders = [];
  for (let s = s0; s < s1; s += 4) {
    const a = path.at(s, {}), b = path.at(Math.min(s1, s + 4), {});
    for (const sd of [-1, 1]) {
      const off = sd * (Wi + 0.25);
      const ax = a.x + a.rx * off, az = a.z + a.rz * off, bx = b.x + b.rx * off, bz = b.z + b.rz * off;
      colliders.push({ x: (ax + bx) / 2, z: (az + bz) / 2, hw: Math.hypot(bx - ax, bz - az) / 2 + 0.2, hd: 0.25, rot: Math.atan2(bz - az, bx - ax), soft: true, secret: true });
    }
  }
  const bp = [], bi = [];
  const BW = [[-Wi + 0.3, -0.2], [-Wi + 0.3, Hs], [-Wi * 0.55, Hc - 0.15], [0, Hc - 0.1], [Wi * 0.55, Hc - 0.15], [Wi - 0.3, Hs], [Wi - 0.3, -0.2]];
  const BN = Math.ceil((s1 - s0) / 5);
  for (let j = 0; j <= BN; j++) {
    const s = s0 + ((s1 - s0) * j) / BN;
    path.at(s, fr);
    const y = floor(s);
    for (const [v, h] of BW) bp.push(fr.x + fr.rx * v, y + h, fr.z + fr.rz * v);
  }
  for (let j = 0; j < BN; j++) for (let k = 0; k < BW.length - 1; k++) {
    const a = j * BW.length + k, b = a + 1, c = a + BW.length, d = c + 1;
    bi.push(a, c, b, b, c, d);
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
  bg.setIndex(bi);
  bg.computeBoundingSphere();
  const blocker = new THREE.Mesh(bg, MAT.blocker());
  blocker.visible = false;
  blocker.name = 'secret-camera-blocker';
  blocker.updateMatrixWorld(true);
  return { group, colliders, blocker, interior, lamps, profile: prof };
}

// ------------------------------------------------------------------ portals
// The Meshy lantern on its bracket in the headwall's rock at portal-local (x, y): the bracket's end on the rock's
// face (found by rays; moved out where the rock bulges under the lantern). Returns the lantern mesh, or null
// without the model.
const PROBE_MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
function portalLantern(g, x, y) {
  const fx = lanternOnBracket(LAMP_MODEL, LANTERN_PORTAL);
  if (!fx) return null;
  const head = g.getObjectByName('secret-portal-headwall');
  const probe = head ? new THREE.Mesh(head.geometry, PROBE_MAT) : null, ray = new THREE.Raycaster();
  const face = (px, py) => { if (!probe) return 0.3; ray.set(new THREE.Vector3(px, py, 8), new THREE.Vector3(0, 0, -1)); ray.far = 16; return ray.intersectObject(probe, false)[0]?.point.z ?? -9; };
  let z = face(x, y);
  if (z < -8) z = 0.3;
  // the rock under the lantern's body (it starts glassMin.z out from the wall)
  let bulge = -9;
  for (const dx of [-0.2, 0, 0.2]) for (const dy of [-0.3, 0, 0.3, 0.6]) bulge = Math.max(bulge, face(x + dx, y + dy));
  z = Math.max(z, bulge - fx.glassMin.z * 0.8) - 0.02;
  const L = bracketLanterns(LAMP_MODEL, [{ position: new THREE.Vector3(x, y, z), out: new THREE.Vector3(0, 0, 1) }], { size: LANTERN_PORTAL, color: LANTERN_GLOW, intensity: 1.6 });
  L.mesh.name = 'secret-lantern-glass'; // (the runtime flickers its glass)
  L.mesh.userData.secretKeep = true;    // (shared buffers)
  g.add(L.mesh);
  g.userData.lantern = L.mesh;
  return L.mesh;
}
// the old built lantern (an iron cage with a warm glass) when the model is missing; lb holds its bracket
function builtPortalLantern(g, lb, lx, ly) {
  lb.at(lx, ly, 0).box(0, 0.3, 0.62, 0.28, 0.05, 0.28, tint('#1b1c1f')).box(0, -0.13, 0.62, 0.3, 0.05, 0.3, tint('#1b1c1f'));
  g.add(new THREE.Mesh(lb.build(), MAT.iron2()));
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.38, 0.2), lanternGlass(1.6));
  glass.position.set(lx, ly + 0.085, 0.62);
  glass.name = 'secret-lantern-glass';
  g.add(glass);
  g.userData.lantern = glass;
}
/**
 * A portal at one end of the tube, at the back of its cutting: a headwall fills the cutting's cross-section in the
 * portal plane (between the cutting's walls, from under the snow floor up to the mountain's surface) around the
 * tube's mouth -- lumpy rock around an old timber adit frame (mine: posts, lintel, knee braces, a carved name
 * board, an iron lantern) or a bulging face of glacier ice with icicles along the arch (ice). A lumpy snow cornice
 * caps its top edge and reaches back over the lid.
 * t: the tunnel spec (path, floor, sF0 / sF1 = the portal planes, Wi / Hs / Hc, style, seed, half(s) = the
 * cutting's floor half-width, kS = its wall steepness). end 0 = at sF0 (the outside toward -s), 1 = at sF1.
 * heightAt(x, z): the mountain's surface without the cutting.
 */
export function buildPortal(t, end, { name = '', year = '', heightAt } = {}) {
  const { path, floor, sF0, sF1, style = 'mine', Wi = 4, Hs = 4, Hc = 5, seed = 1, kS = 3.2 } = t;
  const ice = style === 'ice', cave = style === 'cave';
  const sF = end ? sF1 : sF0, dir = end ? 1 : -1; // dir: toward the outside
  const fr = path.at(sF, {});
  const y = floor(sF);
  const g = new THREE.Group();
  g.name = 'secret-portal';
  g.position.set(fr.x, y, fr.z);
  g.rotation.y = Math.atan2(fr.tx * dir, fr.tz * dir); // local +z: out of the mountain, local x: across
  const rnd = mulberry32(seed * 31 + end * 7);
  const latD = (x) => (end ? -x : x); // local x (right, looking out) -> path lateral offset
  const w = t.half ? t.half(sF) : Wi + 1.8;
  // the cutting's cross-section at the plane: its walls (the skins' mean surface + a margin behind them) and the
  // mountain's surface over the floor
  const wallX = (h) => skinLateral(w, h, kS) + 0.75;
  const TOP = [];
  const X0 = wallX(60) + 2;
  for (let x = -X0; x <= X0 + 1e-6; x += 0.5) { const q = path.point(sF, latD(x), {}); TOP.push(heightAt(q.x, q.z) - y); }
  const topI = (x) => { const u = clamp((x + X0) / 0.5, 0, TOP.length - 1), i = Math.min(TOP.length - 2, Math.floor(u)), f = u - i; return TOP[i] + (TOP[i + 1] - TOP[i]) * f; };
  // the headwall's lateral half-extent at height h (inside the walls, never past the mountain's surface)
  const clampPt = (x, h) => {
    h = Math.max(-0.6, h);
    for (let it = 0; it < 3; it++) { h = Math.min(h, topI(x) + 0.3); const W = wallX(h); x = clamp(x, -W, W); }
    return [x, h];
  };
  const colliders = [];
  // ---- the headwall: rings around the mouth, out to the cutting's walls and the mountain's surface
  {
    const prof = tubeProfile(style, Wi, Hs, Hc);
    // the mouth's outline, densified, with outward normals (in the plane)
    const O = [];
    for (let k = 0; k < prof.length - 1; k++) {
      const [ax, ah] = prof[k], [bx, bh] = prof[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bh - ah) / 0.45));
      for (let i = 0; i < n; i++) O.push([ax + ((bx - ax) * i) / n, ah + ((bh - ah) * i) / n]);
    }
    O.push(prof[prof.length - 1]);
    const NRM = O.map(([x, h], k) => {
      const a = O[Math.max(0, k - 1)], b = O[Math.min(O.length - 1, k + 1)];
      let nx = b[1] - a[1], nh = -(b[0] - a[0]); // the outline runs up the left wall, over, down the right: out = left of travel... checked below
      const l = Math.hypot(nx, nh) || 1; nx /= l; nh /= l;
      if (nx * x + nh * (h - Hs * 0.55) < 0) { nx = -nx; nh = -nh; }
      return [nx, nh];
    });
    const RINGS = [0, 0.22, 0.55, 1.0, 1.6, 2.4, 3.4, 4.7, 6.3, 8.4, 11, 14.5, 19];
    const pos = [], uv = [], idx = [];
    const relief = (x, h, r) => {
      const k = smoothstep(0, 1.4, r);
      const topFade = 1 - smoothstep(-1.6, 0, h - topI(x)); // calm under the cornice
      let z;
      if (ice) z = (NZ.noise(x * 0.32 + seed, h * 0.18) * 0.55 + NZ.noise(x * 0.9 - seed, h * 0.12 + 3.1) * 0.25 + 0.55) * k
        + 0.55 * smoothstep(Hs, Hc + 2.5, h) * k; // the brow leans out over the mouth
      else if (cave) z = (NZ.noise(x * 0.38 + seed, h * 0.3) * 0.55 + NZ.noise(x * 1.1 - seed, h * 0.9 + 2.2) * 0.2 + Math.abs(NZ.noise(x * 0.18, h * 0.22 + 9.1)) * 0.45 + 0.35) * k
        + 0.35 * smoothstep(Hs, Hc + 2, h) * k; // a rough natural mouth, its brow overhanging a little
      else z = (NZ.noise(x * 0.45 + seed, h * 0.4) * 0.35 + NZ.noise(x * 1.3 - seed, h * 1.1 + 2.2) * 0.14 + Math.abs(NZ.noise(x * 0.2, h * 0.25 + 9.1)) * 0.3 + 0.25) * k;
      return z * (0.35 + 0.65 * topFade);
    };
    for (const r of RINGS) {
      for (let k = 0; k < O.length; k++) {
        const [ox, oh] = O[k], [nx, nh] = NRM[k];
        const [x, h] = clampPt(ox + nx * r, oh + nh * r);
        pos.push(x, h, relief(x, h, r));
        uv.push(x / 5, h / 5);
      }
    }
    const W = O.length;
    for (let i = 0; i < RINGS.length - 1; i++) for (let k = 0; k < W - 1; k++) {
      const a = i * W + k, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    // faces out of the mountain (+z): flip the winding if the first real triangle faces in
    {
      const P3 = pos, I = idx;
      let flip = 0;
      for (let q = 0; q < I.length; q += 3) {
        const a = I[q] * 3, b = I[q + 1] * 3, c = I[q + 2] * 3;
        const ux = P3[b] - P3[a], uy = P3[b + 1] - P3[a + 1], vx = P3[c] - P3[a], vy = P3[c + 1] - P3[a + 1];
        flip += ux * vy - uy * vx; // z of the normal (x-h plane)
      }
      if (flip < 0) for (let q = 0; q < I.length; q += 3) { const tmp = I[q + 1]; I[q + 1] = I[q + 2]; I[q + 2] = tmp; }
    }
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.setAttribute('aData', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
    geo.computeBoundingSphere();
    const head = new THREE.Mesh(geo, ice ? MAT.glacier() : portalRockMaterial());
    head.castShadow = true; head.receiveShadow = true;
    head.name = 'secret-portal-headwall';
    g.add(head);
  }
  // ---- the snow cornice along the top edge: overhanging the front a little, reaching back over the lid
  {
    const pos = [], idx = [];
    const xs = [];
    const Xt = Math.min(wallX(topI(0)) + 0.4, Wi + 2.6);
    for (let x = -Xt; x <= Xt + 1e-6; x += 0.4) xs.push(x);
    const rows = [[0.62, -0.42], [0.45, -0.05], [0.12, 0.2], [-0.6, 0.3], [-1.6, 0.28], [-2.8, 0.12]];
    for (const x of xs) {
      const top = topI(x), taper = smoothstep(Xt, Xt - 1.6, Math.abs(x)); // (the ends sink into the rim)
      for (const [zz, dy] of rows) {
        const lump = NZ.noise(x * 0.7 + seed, zz * 0.9 + end * 3) * 0.14 + NZ.noise(x * 2.1, seed + zz) * 0.05;
        pos.push(x, top + (dy + lump) * taper - 0.35 * (1 - taper), (zz + (zz > 0 ? NZ.noise(x * 0.5, seed) * 0.16 : 0)) * (0.4 + 0.6 * taper));
      }
    }
    const R = rows.length;
    for (let i = 0; i < xs.length - 1; i++) for (let r = 0; r < R - 1; r++) {
      const a = i * R + r, b2 = a + R, c = a + 1, d = b2 + 1;
      idx.push(a, b2, c, b2, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const nA = geo.attributes.normal;
    for (let i = 0; i < nA.count; i++) if (nA.getY(i) < 0 && pos[i * 3 + 2] < 0.3) nA.setXYZ(i, -nA.getX(i), -nA.getY(i), -nA.getZ(i));
    // all snow: the terrain shader keeps rock off "groomed" snow (aData.y)
    const dat = new Float32Array((pos.length / 3) * 4);
    for (let i = 0; i < pos.length / 3; i++) { dat[i * 4 + 1] = 1; dat[i * 4 + 2] = 1; }
    geo.setAttribute('aData', new THREE.Float32BufferAttribute(dat, 4));
    const cap = new THREE.Mesh(geo, portalRockMaterial());
    cap.castShadow = true; cap.receiveShadow = true;
    cap.name = 'secret-portal-cornice';
    g.add(cap);
  }

  if (cave) {
    // ---- a natural mouth: only an old oil lantern on an iron bracket in the rock beside it
    const lb = new MeshBuilder();
    const lx = -(Wi + 0.7), ly = Hs - 0.7;
    if (!portalLantern(g, lx, ly - 0.1)) lb.at(lx, ly, 0).rod(0.0, 0.62, -0.1, 0.0, 0.62, 0.62, 0.022, 4, tint('#1b1c1f')).rod(0, 0.62, 0.62, 0, 0.33, 0.62, 0.012, 3, tint('#1b1c1f'));
    if (!g.userData.lantern) builtPortalLantern(g, lb, lx, ly);
  } else if (!ice) {
    // ---- the old adit frame: two posts, a heavy lintel with its name board, knee braces, a lantern on the rock
    const b = new MeshBuilder({ uv: true });
    const post = 0.46, lin = 0.6, Ht = Hs + 0.08, linTop = Ht + lin;
    const wood = (k) => tint('#ffffff', 0.12, seed * 13 + k);
    const zf = 0.32; // in front of the rock
    for (const sx of [-1, 1]) b.at(sx * (Wi - post / 2 + 0.16), 0, zf, 0, 0, sx * 0.012).box(0, (Ht + lin) / 2 - 0.45, 0, post, Ht + lin + 0.9, post + 0.08, wood(sx));
    b.at(0, Ht + lin / 2 - 0.04, zf + 0.04).box(0, 0, 0, (Wi + post) * 2 + 0.55, lin, post + 0.14, wood(3));
    for (const sx of [-1, 1]) b.at(sx * (Wi - 0.6), Ht - 0.5, zf + 0.02, 0, 0, sx * -0.78).box(0, 0, 0, 0.2, 1.35, 0.22, wood(sx * 7));
    // a couple of old lagging planks wedged over the lintel against the rock
    for (let k = 0, yy = linTop - 0.02; k < 2; k++) {
      const hgt = 0.22 + rnd() * 0.06, len = Wi * 1.4 + rnd() * 0.8;
      b.at((rnd() - 0.5) * 0.6, yy + hgt / 2, zf - 0.08, 0, 0, (rnd() - 0.5) * 0.05).box(0, 0, 0, len, hgt - 0.02, 0.12, wood(20 + k));
      yy += hgt;
    }
    const timber = new THREE.Mesh(b.build(), MAT.portalWood());
    timber.castShadow = true; timber.receiveShadow = true;
    timber.name = 'secret-portal-timber';
    g.add(timber);
    const sb = new MeshBuilder();
    sb.at(0, linTop + 0.02 - 0.04, zf + 0.04).box(0, 0, 0, (Wi + post) * 2 + 0.45, 0.1, post + 0.1, tint('#eef3f8'));
    g.add(new THREE.Mesh(sb.build(), MAT.snowTrim()));
    if (name) {
      const tx = canvasTexture(512, 128, (c, w2, h2) => {
        c.fillStyle = '#5a3b22'; c.fillRect(0, 0, w2, h2);
        const r = mulberry32(seed + 77);
        for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(30,18,8,${0.15 + r() * 0.25})`; c.fillRect(0, r() * h2, w2, 1 + r() * 2); }
        c.strokeStyle = 'rgba(25,14,6,0.8)'; c.lineWidth = 6; c.strokeRect(8, 8, w2 - 16, h2 - 16);
        c.textAlign = 'center'; c.textBaseline = 'middle';
        const line = (txt, yy, font) => { c.font = font; c.fillStyle = 'rgba(22,12,5,0.9)'; c.fillText(txt, w2 / 2, yy); c.fillStyle = 'rgba(233,217,184,0.82)'; c.fillText(txt, w2 / 2 - 1, yy - 2); };
        line(name.toUpperCase(), h2 / 2 - (year ? 12 : 0), '700 52px Georgia, "Times New Roman", serif');
        if (year) line(year, h2 / 2 + 33, 'italic 600 26px Georgia, serif');
      });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 0.72), boardMaterial(tx));
      board.position.set(0, Ht + lin / 2 - 0.04, zf + 0.04 + (post + 0.14) / 2 + 0.012);
      g.add(board);
    }
    // the Meshy lantern on its bracket in the rock beside the frame (else the old built one)
    const lx = -(Wi + 0.85), ly = Hs - 0.55;
    if (!portalLantern(g, lx, ly - 0.07)) {
      const lb = new MeshBuilder();
      lb.at(lx, ly, 0).rod(0.0, 0.62, -0.1, 0.0, 0.62, 0.62, 0.022, 4, tint('#1b1c1f')).rod(0, 0.62, 0.62, 0, 0.33, 0.62, 0.012, 3, tint('#1b1c1f'));
      builtPortalLantern(g, lb, lx, ly);
    }
  } else {
    // ---- icicles along the brow of the mouth
    const ib = new MeshBuilder();
    for (let x = -Wi + 0.2; x <= Wi - 0.2; x += 0.22 + rnd() * 0.3) {
      const k = clamp(1 - (x / Wi) ** 2, 0, 1);
      const top = Hs + (Hc - Hs) * Math.sqrt(k) + 0.05;
      const len = 0.2 + rnd() * rnd() * 1.6 * (0.35 + 0.65 * k);
      ib.at(x, top - len, 0.08 + rnd() * 0.3, rnd() * 6).cyl(0, 0, 0, 0, 0.04 + rnd() * 0.08, len, 5, tint('#e6f6ff', 0.05, x));
    }
    const icicles = new THREE.Mesh(ib.build(), MAT.portalIcicle());
    icicles.castShadow = true;
    g.add(icicles);
  }
  g.updateMatrixWorld(true);
  // colliders: the headwall either side of the mouth (soft)
  for (const sd of [-1, 1]) {
    const v0 = Wi + 0.1, v1 = wallX(1.5), vm = ((v0 + v1) / 2) * sd;
    const c = path.point(sF + dir * 0.4, vm, {});
    colliders.push({ x: c.x, z: c.z, hw: Math.max(0.3, (v1 - v0) / 2), hd: 0.6, rot: Math.atan2(fr.rz, fr.rx), soft: true, secret: true });
  }
  return { group: g, colliders };
}

/** the tube's inner profile [[lateral, height], ...] from the left foot over the crown to the right foot */
export function tubeProfile(style, Wi, Hs, Hc) {
  const prof = [];
  const NA = style === 'ice' || style === 'cave' ? 14 : 10;
  prof.push([-Wi, -0.5], [-Wi, 0.6], [-Wi, 1.8], [-Wi, Hs]);
  for (let k = 1; k < NA; k++) { const a = (k / NA) * Math.PI; prof.push([-Wi * Math.cos(a), Hs + (Hc - Hs) * Math.sin(a)]); }
  prof.push([Wi, Hs], [Wi, 1.8], [Wi, 0.6], [Wi, -0.5]);
  return prof;
}

// The headwall's snow and rock: the terrain shader (the same rock and snow as the mountain around the portal).
const portalRockMaterial = () => rockSkinMaterial();

// ------------------------------------------------------------------ helpers
function fixWinding(P, Nrm, I) {
  const out = I.slice();
  for (let k = 0; k < out.length; k += 3) {
    const a = out[k] * 3, b = out[k + 1] * 3, c = out[k + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * Nrm[a] + ny * Nrm[a + 1] + nz * Nrm[a + 2] < 0) { const t = out[k + 1]; out[k + 1] = out[k + 2]; out[k + 2] = t; }
  }
  return out;
}
// keep recomputed normals pointing into the tunnel (the reference normals face inward)
function orientNormals(geo, ref) {
  const n = geo.attributes.normal;
  for (let i = 0; i < n.count; i++) {
    if (n.getX(i) * ref[i * 3] + n.getY(i) * ref[i * 3 + 1] + n.getZ(i) * ref[i * 3 + 2] < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  }
  n.needsUpdate = true;
}
