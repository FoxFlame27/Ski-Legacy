// Car lights and wreck smoke, shared by the car you drive (drive.js) and the traffic (traffic.js).
//  - Lamps: the car's own light meshes glow (cars.js sorts them per model into head / drl / tail / third / rev / ind /
//    lens: inst.lamps); lampsOn() sets them. The red stays RED: the final pass tone-maps with ACES (bright pure red
//    turns pale orange-white above ~2.5), so the tail / brake / third lights use a pure red at tone-map-safe
//    intensities and get their glow from a soft red halo (a sprite per lamp, additive, made on first use) instead of
//    the bloom pass (which only takes things far brighter, and is off on the Performance preset).
//  - Pool: the light the headlights throw on the road: a soft, feathered ellipse draped on the ground ahead (a small
//    grid laid on the terrain every frame it shows, additive, fading to nothing at its edges), never hovering.
//  - Smoke: steam / smoke rising from a crashed car's bonnet (a few soft sprites, only near the camera).
import * as THREE from 'three';
import { nightUniform } from '../world/village.js';

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
        case 'head': o = (head * 0.42 + dayH * 0.1 + (has.has('drl') ? drl * 0.06 : 0)) * dk; break;
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
  for (const a of A.head || []) add('head', a.c.x, a.c.y, a.c.z + out(a), cl(a.size.x * 1.7, 0.5, 0.95), cl(a.size.y * 3, 0.35, 0.6));
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

let smokeTex = null;
function smokeTexture() {
  if (smokeTex) return smokeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  smokeTex = new THREE.CanvasTexture(c);
  smokeTex.colorSpace = THREE.SRGBColorSpace;
  return smokeTex;
}
/** Steam and smoke from a crashed car's bonnet: smoke.update(dt, worldPos | null, camera). */
export class Smoke {
  constructor(scene, n = 14) {
    this.parts = [];
    this.group = new THREE.Group();
    this.group.name = 'car-smoke';
    for (let i = 0; i < n; i++) {
      const m = new THREE.SpriteMaterial({ map: smokeTexture(), color: 0xc9ccd0, transparent: true, opacity: 0, depthWrite: false });
      const s = new THREE.Sprite(m);
      s.visible = false;
      this.group.add(s);
      this.parts.push({ s, m, age: 9, life: 2.4, vx: 0, vy: 0, vz: 0 });
    }
    this.acc = 0;
    scene.add(this.group);
  }
  update(dt, at, camera, dark = 0) {
    const near = at && camera && at.distanceToSquared(camera.position) < 160 * 160;
    if (near) {
      this.acc += dt * (this.rate ?? 6);
      while (this.acc >= 1) {
        this.acc -= 1;
        const p = this.parts.find((q) => q.age >= q.life);
        if (!p) break;
        p.age = 0; p.life = 2 + Math.random() * 1.2;
        p.s.position.set(at.x + (Math.random() - 0.5) * 0.5, at.y, at.z + (Math.random() - 0.5) * 0.5);
        p.vx = (Math.random() - 0.5) * 0.4 + 0.25; p.vy = 0.7 + Math.random() * 0.4; p.vz = (Math.random() - 0.5) * 0.4;
        p.s.visible = true;
      }
    }
    for (const p of this.parts) {
      if (p.age >= p.life) { p.s.visible = false; continue; }
      p.age += dt;
      const k = p.age / p.life;
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      p.vy *= Math.exp(-dt * 0.6);
      const sz = 0.5 + k * 2.2;
      p.s.scale.set(sz, sz, 1);
      p.m.opacity = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * 0.55;
      p.m.color.setScalar(0.8 - dark * 0.45);
    }
  }
  clear() { for (const p of this.parts) { p.age = 9; p.s.visible = false; } this.acc = 0; }
}
