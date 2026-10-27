// Car lights and wreck smoke, shared by the car you drive (drive.js) and the traffic (traffic.js).
//  - Lamps: the car's own light meshes glow (cars.js sorts them per model into head / drl / tail / third / rev / ind /
//    lens: inst.lamps); lampsOn() sets them. The red stays RED: the final pass tone-maps with ACES (bright pure red
//    turns pale orange-white above ~2.5), so the tail / brake / third lights use a pure red at tone-map-safe
//    intensities and get their glow from a soft red halo (a sprite per lamp, additive, made on first use) instead of
//    the bloom pass (which only takes things far brighter, and is off on the Performance preset).
//  - Pool: the light the headlights throw on the road: a soft, feathered ellipse draped on the ground ahead (a small
//    grid laid on the terrain every frame it shows, additive, fading to nothing at its edges), never hovering.
//  - Smoke: steam (and smoke) rising from a damaged / crashed car's bonnet: lit volumetric puffs on one instanced
//    draw per car, simulated with buoyancy, wind and the car's motion (only near the camera).
import * as THREE from 'three';
import { nightUniform } from '../world/village.js';
import { windUniform } from '../world/atmosphere.js';
import { mulberry32 } from '../core/noise.js';

const C = {
  head: new THREE.Color(1, 0.93, 0.82), drl: new THREE.Color(0.9, 0.95, 1), red: new THREE.Color(1, 0.006, 0),
  rev: new THREE.Color(0.95, 0.97, 1), amber: new THREE.Color(1, 0.36, 0.015),
};
/** The hazard lights' blink (1 on, 0 off), the same for every wreck. */
export const hazardPhase = () => (Math.floor(performance.now() / 380) % 2 ? 1 : 0);
// emissive intensity per lamp tier: the LED / DRL cores, the textured lamp graphics, plain lenses. (Red: running
// ~0.8 -> a deep clear red; braking ~2.2 -> a bright red that the tone map keeps red; white can go far brighter.)
const K = {
  head: { core: 6, tex: 3, plain: 1.5 },        // low beams (night / L)
  dayH: { core: 2, tex: 0.6, plain: 0.35 },     // a headlamp as the daytime running light (no DRL of its own)
  drl: { core: 3.2, tex: 1.4, plain: 1 },
  tail: { core: 0.8, tex: 1, plain: 0.65 },     // running
  brake: { core: 1.4, tex: 1.6, plain: 1.3 },   // added under braking (~2.7x)
  third: { core: 2.2, tex: 2.4, plain: 2 },     // only under braking
  rev: { core: 3, tex: 2, plain: 1.4 },
  ind: { core: 2.6, tex: 2.2, plain: 1.8 },
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
let warned = false;
/**
 * Lamps of a car instance (cars.js inst.lamps): head 0..1 (low beams), tail 0..1 (running), brake 0..1 (on above
 * 0.05: the brake lights and the third light, a quick fade in and out); opts.drl: daytime running lights;
 * opts.reverse: the reversing lights; opts.hazard: null, or the blink (0 / 1): the hazards flash (amber), the tails
 * stay on dim, the headlights stay as they are.
 */
export function lampsOn(inst, head, tail, brake = 0, { drl = 0, reverse = false, hazard = null } = {}) {
  const L = inst?.lamps;
  if (!L?.list) return;
  try {
    const now = performance.now();
    if (brake > 0.05) L.hold = now + 280; // (a short press still shows; no flicker)
    const bt = now < (L.hold || 0) ? 1 : 0;
    L.bs = L.bs ?? 0;
    L.bs += (bt - L.bs) * (bt > L.bs ? 0.5 : 0.28);
    if (Math.abs(L.bs - bt) < 0.03) L.bs = bt;
    const b = Math.round(L.bs * 40) / 40;
    const haz = hazard === null ? -1 : hazard ? 1 : 0;
    if (haz >= 0) { tail = Math.max(tail, 0.55); drl = 0; } // (a wreck: dim tails at least, hazards)
    const night = clamp01(nightUniform?.value ?? 0), dk = Math.round((0.3 + 0.7 * night) * 10) / 10;
    const rv = reverse ? 1 : 0;
    const off = !head && !tail && !b && !drl && !rv && haz < 0;
    const key = off ? '0|0|0|0|false' : `${head}|${tail}|${b}|${drl}|${rv}|${haz}|${dk}`;
    if (L.key === key) return;
    L.key = key;
    const has = L.kinds, dayH = has.has('drl') ? 0 : drl; // (the headlamps light by day only on cars with no DRL)
    const indF = has.has('ind') && hasEnd(L, 'ind', 1), indR = has.has('ind') && hasEnd(L, 'ind', -1);
    for (const e of L.list) {
      const m = e.m, t = e.tier;
      let col = C.red, k = 0;
      switch (e.kind) {
        case 'head': col = C.head; k = head * K.head[t] + dayH * K.dayH[t]; break;
        case 'drl': col = C.drl; k = Math.max(drl, head * 0.75) * K.drl[t]; break;
        case 'tail': k = tail * K.tail[t] + b * K.brake[t]; break;
        case 'third': k = b * K.third[t]; break;
        case 'rev': col = C.rev; k = rv * K.rev[t]; break;
        case 'ind': col = C.amber; k = haz > 0 ? K.ind[t] : 0; break;
        case 'lensF': if (haz > 0 && !indF) { col = C.amber; k = 1.2; } else { col = C.head; k = head * 0.22 + dayH * 0.05; } break;
        case 'lensR': if (haz > 0 && !indR) { col = C.amber; k = 1.2; } else k = tail * 0.3 + b * 0.75; break;
      }
      m.emissive.copy(col);
      m.emissiveIntensity = k * e.boost;
    }
    // the halos: the soft glow round each lit lamp (red round the tails, stronger braking; warm round the low beams)
    const H = halos(L);
    for (const h of H) {
      let o = 0;
      switch (h.kind) {
        case 'tail': o = (tail * 0.16 + b * 0.5) * dk; break;
        case 'third': o = b * 0.45 * dk; break;
        case 'head': o = (head * 0.3 + dayH * 0.06 + (has.has('drl') ? drl * 0.04 : 0)) * dk; break;
        case 'rev': o = rv * 0.42 * dk; break;
        case 'ind': o = haz > 0 ? 0.6 * (0.45 + 0.55 * dk) : 0; break;
      }
      h.m.opacity = Math.min(1, o);
      h.s.visible = o > 0.004;
    }
  } catch (e) { if (!warned) { warned = true; console.warn('car lamps', e); } }
}
const hasEnd = (L, kind, sign) => (L.ends ||= {})[kind + sign] ??= (L.halo[kind] || []).some((a) => a.c.z * sign > L.halfL * 0.45);

let haloTex = null;
function haloTexture() {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  // (a bright core falling off fast, then a long soft skirt: like bloom)
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.1, 'rgba(255,255,255,0.7)'); gr.addColorStop(0.28, 'rgba(255,255,255,0.28)');
  gr.addColorStop(0.55, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  haloTex = new THREE.CanvasTexture(c);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  return haloTex;
}
// A halo only shows from in front of its lamp (it is the lens's glow, not a ball of light): the sprite fades out as the
// view turns past ~80 deg off the lamp's axis (dir: +1 the car's front, -1 its back, 0 a side repeater: always), so
// from behind or inside the car nothing floats ahead of the bonnet; it sits a hair toward the eye (no cut on the body).
const haloFacing = (sh) => {
  sh.vertexShader = 'varying float vFace;\n' + sh.vertexShader.replace('vec4 mvPosition = modelViewMatrix[ 3 ];', `vec4 mvPosition = modelViewMatrix[ 3 ];
    vec3 toEye = normalize( - mvPosition.xyz );
    #if LAMP_DIR != 0
      vFace = smoothstep( 0.17, 0.6, dot( normalize( ( modelViewMatrix * vec4( 0.0, 0.0, float( LAMP_DIR ), 0.0 ) ).xyz ), toEye ) );
    #else
      vFace = 1.0;
    #endif
    mvPosition.xyz += toEye * 0.1;`);
  sh.fragmentShader = 'varying float vFace;\n' + sh.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', `if ( vFace < 0.003 ) discard;
    vec4 diffuseColor = vec4( diffuse, opacity * vFace * vFace );`);
};
const HALO_COL = { tail: new THREE.Color(1, 0.04, 0.01), third: new THREE.Color(1, 0.04, 0.01), head: new THREE.Color(1, 0.88, 0.7), rev: new THREE.Color(0.85, 0.9, 1), ind: new THREE.Color(1, 0.42, 0.04) };
// the halo sprites of a car (once): at each lamp, a little out from its lens. Reversing / indicator halos where the
// model has none of its own: on the inner / outer part of the tail and head lamps.
function halos(L) {
  if (L.halos) return L.halos;
  L.halos = [];
  if (!L.full) return L.halos;
  const A = L.halo, hl = L.halfL, out = (a) => (a.c.z > 0 ? a.size.z / 2 + 0.05 : -a.size.z / 2 - 0.05);
  const add = (kind, x, y, z, sx, sy) => {
    const m = new THREE.SpriteMaterial({ map: haloTexture(), color: HALO_COL[kind], transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    m.defines = { LAMP_DIR: kind === 'ind' && Math.abs(z) <= hl * 0.45 ? 0 : z >= 0 ? 1 : -1 }; m.onBeforeCompile = haloFacing;
    const s = new THREE.Sprite(m);
    s.position.set(x, y, z); s.scale.set(sx, sy, 1); s.visible = false; s.renderOrder = 5;
    s.name = 'lamp-halo';
    L.full.add(s);
    L.halos.push({ kind, s, m });
  };
  const cl = (v, a, b) => Math.min(b, Math.max(a, v));
  for (const a of A.tail || []) add('tail', a.c.x, a.c.y, a.c.z + out(a), cl(a.size.x * 1.5, 0.42, 0.85), cl(a.size.y * 2.4, 0.3, 0.6));
  const th = A.third || [];
  if (th.length) {
    const mn = new THREE.Vector3(Infinity, Infinity, Infinity), mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const a of th) { mn.min(a.c.clone().addScaledVector(a.size, -0.5)); mx.max(a.c.clone().addScaledVector(a.size, 0.5)); }
    add('third', (mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z - 0.05, cl((mx.x - mn.x) * 1.6, 0.4, 0.9), 0.24);
  }
  for (const a of A.head || []) add('head', a.c.x, a.c.y, a.c.z + out(a), cl(a.size.x * 1.2, 0.3, 0.6), cl(a.size.y * 2, 0.22, 0.4));
  if (A.rev?.length) for (const a of A.rev) add('rev', a.c.x, a.c.y, a.c.z + out(a), 0.4, 0.3);
  else for (const a of A.tail || []) add('rev', a.c.x * 0.72, a.c.y - a.size.y * 0.12, a.c.z + out(a) - 0.01, 0.36, 0.26);
  const ind = A.ind || [];
  for (const a of ind) add('ind', a.c.x, a.c.y, a.c.z + (Math.abs(a.c.z) > hl * 0.45 ? out(a) : 0), 0.32, 0.24);
  // ends with no amber lamp of their own: at the outer edge of the head / tail lamps
  const has = (sign) => ind.some((a) => a.c.z * sign > hl * 0.45);
  if (!has(1)) for (const a of A.head || []) add('ind', a.c.x + Math.sign(a.c.x) * a.size.x * 0.4, a.c.y, a.c.z + out(a) + 0.01, 0.34, 0.26);
  if (!has(-1)) for (const a of A.tail || []) add('ind', a.c.x + Math.sign(a.c.x) * a.size.x * 0.4, a.c.y, a.c.z + out(a) - 0.01, 0.34, 0.26);
  return L.halos;
}

let poolTex = null;
function poolTexture() {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  // a feathered ellipse, brightest just ahead of the car (the bottom of the texture), nothing at any border
  g.save(); g.scale(1, 1.9);
  const gr = g.createRadialGradient(32, 40, 2, 32, 34, 29);
  gr.addColorStop(0, 'rgba(255,241,220,1)'); gr.addColorStop(0.35, 'rgba(255,236,210,0.5)'); gr.addColorStop(0.7, 'rgba(255,232,205,0.14)'); gr.addColorStop(1, 'rgba(255,232,205,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 68);
  g.restore();
  poolTex = new THREE.CanvasTexture(c);
  poolTex.colorSpace = THREE.SRGBColorSpace;
  return poolTex;
}

const NU = 7, NV = 11;
export class LightPool {
  constructor(scene, color = 0xffffff) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(NU * NV * 3), uv = new Float32Array(NU * NV * 2), idx = [];
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      uv.set([i / (NU - 1), 1 - j / (NV - 1)], (j * NU + i) * 2);
      if (i < NU - 1 && j < NV - 1) { const a = j * NU + i, b = a + NU; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.mat = new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16 });
    this.mat.color.set(color);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.mesh.name = 'car-light-pool';
    scene.add(this.mesh);
  }
  /** Lay it ahead of a car (x, z, yaw, front: distance of the bumper from the centre) on the ground; on: 0..1. */
  update(x, z, yaw, front, world, on, size = 1) {
    this.mesh.visible = on > 0.01;
    if (!this.mesh.visible) return;
    this.mat.opacity = 0.55 * on;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
    const P = this.mesh.geometry.attributes.position, a = P.array;
    for (let j = 0; j < NV; j++) {
      const v = j / (NV - 1), ahead = front + 0.25 + v * 15 * size, half = (1.5 + v * 2.6) * Math.min(1, 0.4 + size * 0.6);
      for (let i = 0; i < NU; i++) {
        const u = (i / (NU - 1)) * 2 - 1, px = x + fx * ahead + lx * u * half, pz = z + fz * ahead + lz * u * half;
        const k = (j * NU + i) * 3;
        a[k] = px; a[k + 1] = world.height(px, pz) + 0.07; a[k + 2] = pz;
      }
    }
    P.needsUpdate = true;
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ------------------------------------------------------------------ wreck steam and smoke
// Steam out of a knocked-about car's bonnet seams; from a wrecked one a plume, with darker smoke in it. One instanced
// draw per car: camera-facing quads on an InstancedBufferGeometry, simulated on the CPU (a fixed pool, nothing
// allocated per frame) and drawn back to front.
//  - the look: a 2 x 2 atlas of procedural puffs (clusters of soft blobs, domain-warped, eroded by billow noise, fading
//    out well inside their cells: no edge, no disc), each texel a density (alpha) and the normal of the puff's surface
//    (rgb), so every puff is lit as a volume: the sun / moon on its lit side with a wrapped falloff, forward
//    scattering (thin edges glow with the sun behind them), the sky's light (the haze colour: blue and dark at night)
//    and, at night, the car's own headlights on the steam that drifts ahead of it. Each puff its own variant, mirror
//    and slow spin; thin parts erode first as it ages (it breaks up into wisps as it thins out).
//  - the motion: hot steam leaves the seams fast and rises on its heat (a buoyancy that fades as it cools), the air
//    takes it (drag toward the wind, atmosphere.js, plus eddies that grow with it), it grows as it mixes and thins
//    out within ~2 s. A puff keeps only part of the car's velocity (the air over a moving car takes it): a moving
//    car leaves a trail. Wrecked: some dark grey smoke as well, bigger, slower, longer-lived.
//  - no hard lines: each puff is pushed toward the camera by part of its size (no cut where it meets the bonnet),
//    never sinks below the bonnet, and fades right in front of the lens.
const PUFF_N = 128; // texels per puff (the atlas: 256 x 256, mipmapped)
let puffTex = null;
function puffTexture() {
  if (puffTex) return puffTex;
  const N = PUFF_N, S = N * 2, data = new Uint8Array(S * S * 4), dens = new Float32Array(N * N);
  const rnd = mulberry32(7331), P = new Float32Array(256 * 256);
  for (let i = 0; i < P.length; i++) P[i] = rnd();
  const vn = (x, y) => { // value noise, 0..1
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const i0 = xi & 255, j0 = yi & 255, i1 = (i0 + 1) & 255, j1 = (j0 + 1) & 255;
    const a = P[j0 * 256 + i0], b = P[j0 * 256 + i1], c = P[j1 * 256 + i0], d = P[j1 * 256 + i1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, y, oct, billow) => { // (billow: |n| folded, the rounded cauliflower lumps of a cloud)
    let s = 0, a = 0.5, w = 0;
    for (let k = 0; k < oct; k++) { const n = vn(x, y); s += (billow ? 1 - Math.abs(2 * n - 1) : n) * a; w += a; x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; a *= 0.5; }
    return s / w;
  };
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let cell = 0; cell < 4; cell++) {
    const r = mulberry32(101 + cell * 977), blobs = [], nb = 6 + Math.floor(r() * 4), ox = r() * 60, oy = r() * 60;
    for (let i = 0; i < nb; i++) {
      const a = r() * Math.PI * 2, d = Math.pow(r(), 0.8) * 0.42;
      blobs.push(Math.cos(a) * d, Math.sin(a) * d, (0.24 + r() * 0.2) * (1.2 - d));
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N) * 2 - 1, y = ((j + 0.5) / N) * 2 - 1;
      const wx = x + (fbm(x * 2.2 + ox, y * 2.2 + oy, 3) - 0.5) * 0.4, wy = y + (fbm(x * 2.2 + oy + 9, y * 2.2 + ox, 3) - 0.5) * 0.4;
      let f = 0;
      for (let b = 0; b < blobs.length; b += 3) { const dx = wx - blobs[b], dy = wy - blobs[b + 1], rr = blobs[b + 2]; f += Math.exp(-((dx * dx + dy * dy) / (rr * rr)) * 1.6); }
      // lumpy (billow) and soft (plain fbm) detail; a saturating density: no flat insides, no sharp rims
      const nz = 0.55 * fbm(wx * 3.1 + ox, wy * 3.1 + oy, 5, true) + 0.45 * fbm(wx * 4.3 + oy, wy * 4.3 + ox, 4);
      let d = 1 - Math.exp(-Math.max(0, Math.min(f, 2.2) * (0.12 + 1.25 * nz) - 0.1) * 1.1);
      d *= 1 - ss(0.5, 0.98, Math.hypot(x, y));
      dens[j * N + i] = d;
    }
    const cx = (cell & 1) * N, cy = (cell >> 1) * N;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N) * 2 - 1, y = ((j + 0.5) / N) * 2 - 1;
      // the surface's normal: the slope of the density (its lumps) on the puff's overall bulge
      const gx = (dens[j * N + Math.min(N - 1, i + 1)] - dens[j * N + Math.max(0, i - 1)]) * (N / 4);
      const gy = (dens[Math.min(N - 1, j + 1) * N + i] - dens[Math.max(0, j - 1) * N + i]) * (N / 4);
      let nx = -gx * 0.32 + x * 0.75, ny = -gy * 0.32 + y * 0.75, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const o = ((cy + j) * S + cx + i) * 4;
      data[o] = (nx * 0.5 + 0.5) * 255; data[o + 1] = (ny * 0.5 + 0.5) * 255; data[o + 2] = (nz * 0.5 + 0.5) * 255;
      data[o + 3] = dens[j * N + i] * 255;
    }
  }
  puffTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  puffTex.generateMipmaps = true;
  puffTex.minFilter = THREE.LinearMipmapLinearFilter;
  puffTex.magFilter = THREE.LinearFilter;
  puffTex.needsUpdate = true;
  return puffTex;
}

const SMOKE_VERT = `
  attribute vec3 aPos;   // centre (world)
  attribute vec4 aA;     // size (m), spin (rad), opacity, darkness (0 steam .. 1 smoke)
  attribute vec4 aB;     // atlas cell, mirror (+-1), erosion, lamp light (0..1)
  uniform vec3 uL;       // toward the sun / moon (view space)
  varying vec2 vUv; varying vec3 vL; varying float vA; varying float vDark; varying float vErode; varying float vFwd; varying float vLamp;
  void main(){
    vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
    float c = cos(aA.y), s = sin(aA.y), sz = aA.x;
    // forward scattering toward the eye: Henyey-Greenstein (g 0.6), looking toward the light
    vec3 vd = normalize(mv.xyz);
    float g = 0.6, ct = dot(vd, uL);
    vFwd = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * ct, 1.5) * 0.25;
    vec2 q = position.xy * sz;
    mv.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
    // toward the camera by part of its size: no cut line where a puff meets the bonnet; never through the lens
    mv.xyz -= vd * min(sz * 0.4, max(0.0, -mv.z - 0.35));
    gl_Position = projectionMatrix * mv;
    vec2 uv0 = vec2(aB.y < 0.0 ? 1.0 - uv.x : uv.x, uv.y);
    vUv = (vec2(mod(aB.x, 2.0), floor(aB.x * 0.5)) + uv0) * 0.5;
    // the light in the puff's own texture frame (its spin and mirror undone)
    vL = vec3((uL.x * c + uL.y * s) * sign(aB.y), -uL.x * s + uL.y * c, uL.z);
    vA = aA.z * smoothstep(0.3, 1.4, -mv.z);
    vDark = aA.w; vErode = aB.z; vLamp = aB.w;
  }`;
const SMOKE_FRAG = `
  uniform sampler2D uMap; uniform vec3 uSun; uniform vec3 uAmb; uniform vec3 uLamp;
  varying vec2 vUv; varying vec3 vL; varying float vA; varying float vDark; varying float vErode; varying float vFwd; varying float vLamp;
  void main(){
    vec4 t = texture2D(uMap, vUv);
    float d = max(t.a - vErode, 0.0) / (1.0 - vErode); // (ageing: the thin parts go first)
    float a = pow(d, 1.2) * vA;
    if (a < 0.003) discard;
    vec3 n = normalize(t.rgb * 2.0 - 1.0);
    // wrapped diffuse (light gets round a puff's side), less of it through the thick core onto the far side
    float diff = clamp(dot(n, vL) * 0.5 + 0.5, 0.0, 1.0);
    diff *= mix(1.0, 0.7, smoothstep(0.4, 1.0, t.a) * (1.0 - clamp(vL.z, 0.0, 1.0)));
    vec3 alb = mix(vec3(0.94, 0.95, 0.96), vec3(0.17, 0.165, 0.16), vDark);
    vec3 col = alb * (uAmb * (0.78 + 0.22 * n.z) + uSun * diff + uLamp * vLamp);
    // the silver lining: the thin parts glow with the light behind them (water droplets scatter forward; soot hardly)
    col += uSun * vFwd * (1.0 - t.a) * (1.0 - 0.85 * vDark);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const SMOKE_MAX = 96;
const _sd = new THREE.Vector3(), _sm = new THREE.Matrix4();
const LAMP_COL = new THREE.Color(1, 0.9, 0.75);
/**
 * Steam and smoke from a damaged / crashed car's bonnet. smoke.rate: how hard it steams (~1 a faint wisp, 6 the
 * wrecked plume, which has dark smoke in it too). smoke.update(dt, worldPos | null, camera, night, fwd?, lamps?)
 * every frame: worldPos the bonnet (null: nothing more comes out, what is in the air drifts away); fwd the car's
 * forward (world, unit) and lamps 0..1 its headlights (the steam ahead of the car catches them at night).
 */
export class Smoke {
  constructor(scene, max = SMOKE_MAX) {
    this.scene = scene; this.max = max; this.rate = 6;
    this.P = new Float32Array(max * 3); this.V = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(1e9); this.life = new Float32Array(max).fill(1);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.rot = new Float32Array(max); this.spin = new Float32Array(max);
    this.dark = new Float32Array(max); this.a0 = new Float32Array(max); this.floor = new Float32Array(max); this.seed = new Float32Array(max);
    this.cell = new Float32Array(max); this.depth = new Float32Array(max); this.order = new Uint16Array(max);
    const q = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry();
    g.setIndex(q.index); g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv);
    const ia = (k) => new THREE.InstancedBufferAttribute(new Float32Array(max * k), k).setUsage(THREE.DynamicDrawUsage);
    this.aPos = ia(3); this.aA = ia(4); this.aB = ia(4);
    g.setAttribute('aPos', this.aPos); g.setAttribute('aA', this.aA); g.setAttribute('aB', this.aB);
    g.instanceCount = 0;
    this.uniforms = { uMap: { value: puffTexture() }, uL: { value: new THREE.Vector3(0, 1, 0) }, uSun: { value: new THREE.Color() }, uAmb: { value: new THREE.Color() }, uLamp: { value: new THREE.Color() } };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG, transparent: true, depthWrite: false });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6; this.mesh.visible = false; this.mesh.name = 'car-smoke';
    scene.add(this.mesh);
    this.acc = 0; this.accD = 0; this.t = 0; this.next = 0;
    this.prev = new THREE.Vector3(); this.hasPrev = false; this.carV = new THREE.Vector3(); this.lampW = new THREE.Vector3(); this.lampOn = 0;
    this.sun = null;
  }

  update(dt, at, camera, night = 0, fwd = null, lamps = night > 0.2 ? 1 : 0) {
    dt = Math.min(dt, 0.1);
    if (!(dt > 0)) return;
    this.t += dt;
    // the car's velocity, from how far the bonnet moved (a jump of 5 m+ is a teleport: no trail across it)
    let jump = true;
    if (at) {
      if (this.hasPrev) {
        const dx = at.x - this.prev.x, dy = at.y - this.prev.y, dz = at.z - this.prev.z;
        if (dx * dx + dy * dy + dz * dz < 25) {
          const k = 1 - Math.exp(-dt * 10);
          this.carV.x += (dx / dt - this.carV.x) * k; this.carV.y += (dy / dt - this.carV.y) * k; this.carV.z += (dz / dt - this.carV.z) * k;
          jump = false;
        }
      }
      if (jump) { this.carV.set(0, 0, 0); this.prev.copy(at); }
    }
    const near = at && camera && at.distanceToSquared(camera.position) < 160 * 160;
    if (near) {
      const k = this.rate ?? 6, inten = Math.min(1, k / 6), heavy = Math.min(1, Math.max(0, (k - 4) / 2));
      // more puffs on the move (the same steam spread along the way: a continuous trail, not dots)
      const sp = Math.hypot(this.carV.x, this.carV.z), more = 1 + Math.min(1.5, sp / 8);
      this.acc += dt * (4 + k * 4.4) * more; // (a wisp: still a steady stream, only fainter)
      this.accD += dt * heavy * 2 * more;
      const ns = Math.floor(this.acc), nd = Math.floor(this.accD), n = ns + nd;
      this.acc -= ns; this.accD -= nd;
      // spread along the way the car moved this frame (a fast car: an even trail, not clumps per frame)
      for (let i = 0; i < n; i++) {
        const u = (i + 1) / n, back = (1 - u) * dt;
        this.spawn(this.prev.x + (at.x - this.prev.x) * u, this.prev.y + (at.y - this.prev.y) * u, this.prev.z + (at.z - this.prev.z) * u, i >= ns, inten, fwd, back, sp);
      }
    }
    if (at) { this.prev.copy(at); this.hasPrev = true; } else this.hasPrev = false;
    if (fwd && at && lamps > 0) { this.lampW.set(at.x + fwd.x * 2.2, at.y - 0.35, at.z + fwd.z * 2.2); this.lampOn = lamps; } else this.lampOn = 0;
    this.step(dt, camera, night);
  }

  spawn(x, y, z, smoke, inten, fwd, back, sp) {
    let i = -1;
    for (let k = 0; k < this.max; k++) { const j = (this.next + k) % this.max; if (this.age[j] >= this.life[j]) { i = j; break; } }
    if (i < 0) return; // (the pool is full: never cut a puff off mid-air)
    this.next = (i + 1) % this.max;
    const R = Math.random, i3 = i * 3;
    // anywhere along the seams at the back of the bonnet / round the grille
    const a = (R() - 0.5) * 0.9, b = (R() - 0.5) * 0.5;
    if (fwd) { x += fwd.z * a + fwd.x * b; z += -fwd.x * a + fwd.z * b; } else { x += a; z += b; }
    const cv = this.carV, keep = 0.5; // (the rest of the car's speed: the air over it takes the puff)
    this.P[i3] = x; this.P[i3 + 1] = y; this.P[i3 + 2] = z;
    if (!smoke) {
      this.V[i3] = cv.x * keep + (R() - 0.5) * 0.6; this.V[i3 + 1] = cv.y * keep + (1.3 + R() * 1.3) * (0.6 + 0.4 * inten); this.V[i3 + 2] = cv.z * keep + (R() - 0.5) * 0.6;
      this.life[i] = 1.1 + R() * 1.0; this.s0[i] = 0.2 + R() * 0.15 + Math.min(0.5, sp * 0.03); this.s1[i] = (1.0 + R() * 0.8) * (0.65 + 0.35 * inten);
      this.a0[i] = (0.62 + R() * 0.25) * (0.3 + 0.7 * inten) / (1 + sp * 0.03); this.dark[i] = R() * 0.06;
    } else {
      this.V[i3] = cv.x * keep + (R() - 0.5) * 0.4; this.V[i3 + 1] = cv.y * keep + 0.7 + R() * 0.6; this.V[i3 + 2] = cv.z * keep + (R() - 0.5) * 0.4;
      this.life[i] = 3.2 + R() * 1.8; this.s0[i] = 0.35 + R() * 0.2; this.s1[i] = 2.0 + R() * 1.2;
      this.a0[i] = 0.26 + R() * 0.12; this.dark[i] = 0.45 + R() * 0.35;
    }
    this.age[i] = back; this.floor[i] = y - 0.12;
    this.P[i3] += this.V[i3] * back; this.P[i3 + 1] += this.V[i3 + 1] * back; this.P[i3 + 2] += this.V[i3 + 2] * back;
    this.rot[i] = R() * Math.PI * 2; this.spin[i] = (R() - 0.5) * 1.1; this.seed[i] = R() * 100;
    this.cell[i] = (Math.floor(R() * 4) + 1) * (R() < 0.5 ? -1 : 1); // atlas cell 1..4, the sign mirrors it
  }

  step(dt, camera, night) {
    const P = this.P, V = this.V, w = windUniform.value, wx = w.x * 0.55, wz = w.y * 0.55, T = this.t;
    let n = 0;
    const cp = camera?.position, cd = camera ? camera.getWorldDirection(_sd) : null;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) continue;
      const age = (this.age[i] += dt);
      if (age >= this.life[i]) continue;
      const i3 = i * 3, f = age / this.life[i], smoke = this.dark[i] > 0.3, ph = this.seed[i];
      // buoyancy: hot steam / smoke rises on its heat, which it loses as it mixes with the cold air
      V[i3 + 1] += (smoke ? 1.6 * Math.exp(-age / 1.4) : 2.0 * Math.exp(-age / 0.5)) * dt;
      // eddies: a smooth, slowly changing flow round the puff (stronger as the plume grows and slows)
      const x = P[i3], y = P[i3 + 1], z = P[i3 + 2], ta = 0.25 + 0.8 * f;
      const tx = (Math.sin(y * 1.7 + T * 1.3 + ph) + 0.6 * Math.sin(z * 1.1 - T * 0.9 + ph * 2.1)) * ta;
      const ty = (Math.sin(x * 1.3 + T * 1.1 + ph * 1.3) + 0.5 * Math.sin(z * 2.1 + T * 1.7)) * ta * 0.4;
      const tz = (Math.sin(x * 1.5 - T * 1.2 + ph * 0.7) + 0.6 * Math.sin(y * 1.2 + T * 0.8 + ph)) * ta;
      // drag toward the moving air (the wind and the eddies)
      const kd = 1 - Math.exp(-dt * (smoke ? 1.1 : 1.6)), kv = 1 - Math.exp(-dt * 1.0);
      V[i3] += (wx + tx - V[i3]) * kd; V[i3 + 1] += (ty - V[i3 + 1]) * kv; V[i3 + 2] += (wz + tz - V[i3 + 2]) * kd;
      P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
      if (P[i3 + 1] < this.floor[i]) { P[i3 + 1] = this.floor[i]; if (V[i3 + 1] < 0) V[i3 + 1] = 0; }
      this.rot[i] += this.spin[i] * dt; this.spin[i] *= Math.exp(-dt * 0.4);
      this.depth[i] = cp ? (P[i3] - cp.x) * cd.x + (P[i3 + 1] - cp.y) * cd.y + (P[i3 + 2] - cp.z) * cd.z : 0;
      // back to front (insertion sort: the order hardly changes from one frame to the next)
      let k = n++;
      while (k > 0 && this.depth[this.order[k - 1]] < this.depth[i]) { this.order[k] = this.order[k - 1]; k--; }
      this.order[k] = i;
    }
    this.mesh.visible = n > 0;
    this.mesh.geometry.instanceCount = n;
    if (!n || !camera) return;
    const A = this.aA.array, B = this.aB.array, Pa = this.aPos.array, lw = this.lampW;
    for (let k = 0; k < n; k++) {
      const i = this.order[k], i3 = i * 3, age = this.age[i], f = age / this.life[i], smoke = this.dark[i] > 0.3;
      // it grows as it mixes in (fast at first), fades in at the seam and thins out (steam quickly, smoke slowly)
      const grow = 1 - Math.exp(-age * (smoke ? 0.8 : 1.7));
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * grow;
      const fin = Math.min(1, age / (smoke ? 0.45 : 0.14)), fout = Math.pow(1 - f, smoke ? 1.3 : 1.7);
      Pa[k * 3] = P[i3]; Pa[k * 3 + 1] = P[i3 + 1]; Pa[k * 3 + 2] = P[i3 + 2];
      A[k * 4] = size; A[k * 4 + 1] = this.rot[i]; A[k * 4 + 2] = this.a0[i] * fin * fout; A[k * 4 + 3] = this.dark[i];
      const c = this.cell[i];
      B[k * 4] = Math.abs(c) - 1; B[k * 4 + 1] = c < 0 ? -1 : 1; B[k * 4 + 2] = smoke ? f * 0.4 : 0.02 + f * 0.5;
      // the headlights: on the puffs ahead of the car, falling off with distance from the beams
      let lamp = 0;
      if (this.lampOn > 0) { const dx = P[i3] - lw.x, dy = P[i3 + 1] - lw.y, dz = P[i3 + 2] - lw.z; lamp = this.lampOn / (1 + (dx * dx + dy * dy + dz * dz) * 1.2); }
      B[k * 4 + 3] = lamp;
    }
    this.aPos.needsUpdate = true; this.aA.needsUpdate = true; this.aB.needsUpdate = true;
    this.light(camera, night);
  }

  // the scene's light on it: the sun (or the moon, sky.js uses the one light for both), the sky's light (the haze
  // colour, which is dark blue at night) and the headlights
  light(camera, night) {
    const u = this.uniforms, scene = this.scene;
    if (!this.sun || !this.sun.parent) {
      this.sun = null;
      for (const o of scene.children) if (o.isDirectionalLight && (o.castShadow || !this.sun)) this.sun = o;
    }
    const s = this.sun;
    if (s) {
      u.uL.value.subVectors(s.position, s.target.position).normalize().transformDirection(_sm.copy(camera.matrixWorld).invert());
      u.uSun.value.copy(s.color).multiplyScalar(s.intensity * 0.45);
    } else { u.uL.value.set(0, 1, 0); u.uSun.value.setRGB(0, 0, 0); }
    const bg = scene.fog?.color || (scene.background?.isColor ? scene.background : null);
    if (bg) u.uAmb.value.copy(bg).multiplyScalar(1.0); else u.uAmb.value.setScalar(0.5 - 0.42 * night);
    u.uLamp.value.copy(LAMP_COL).multiplyScalar(1.1 * (0.25 + 0.75 * night));
  }

  clear() {
    this.age.fill(1e9); this.acc = 0; this.accD = 0; this.hasPrev = false;
    this.mesh.visible = false; this.mesh.geometry.instanceCount = 0;
  }
}
