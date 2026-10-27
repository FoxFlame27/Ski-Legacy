// Free-standing secret features built from meshes over the (lightly shaped) terrain:
//  - the frozen waterfall in a couloir's bay: an icefall pours down the bay's back wall onto a rock ledge, and the
//    ice hangs from the ledge as a fluted curtain, so you ride the passage between the wall and the blue ice
//    (buildIceBaySteps)
//  - a natural rock arch you ski under (buildArch)
// Rock uses the terrain shader (the mountain's own rock, snow on what faces up), ice a shared glacier material.
import * as THREE from 'three';
import { Simplex, smoothstep, mulberry32, clamp } from '../../core/noise.js';
import { MeshBuilder, tint } from '../../modes/parkour/kit.js';
import { glacierIceMaterial } from './tunnel.js';
import { rockSkinMaterial } from './rock.js';
import { late, sharedMaterial } from './slice.js';

const NZ = new Simplex(9901), NZ2 = new Simplex(9902);

export const featureRockMaterial = () => rockSkinMaterial();
const iceColumnMaterial = () => sharedMaterial('ice-column', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0, emissive: new THREE.Color(0x0e3556), emissiveIntensity: 0.85, envMapIntensity: 1.2 }));
export function featureMaterials() { featureRockMaterial(); glacierIceMaterial(); iceColumnMaterial(); }
const withData = (geo) => { geo.setAttribute('aData', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4)); return geo; };

/**
 * A frozen waterfall in a bay of a couloir: the icefall pours down the bay's back wall from near the rim onto a rock
 * ledge, and from the ledge's lip an ice curtain hangs to the snow along the couloir's own wall line, so a passage
 * runs behind the ice (in at one end, out at the other, a window in the middle).
 * o: path, floor(s) (the couloir's), s0 / s1 (the bay's extent), side (-1 / 1: the bay's side), curtainAt(s) (the
 *   curtain's lateral offset), wallAt(s, h) (the bay's back wall's lateral offset at h over the floor), rimAt(s)
 *   (the wall's height there), ledgeH, seed. Returns { group, colliders, passage(s) (the passage's lateral offset) }
 */
export function* buildIceBaySteps(o) {
  const { path, floor, s0, s1, side, curtainAt, wallAt, rimAt, ledgeH = 9, seed = 1 } = o;
  const rnd = mulberry32(seed * 101 + 7);
  const group = new THREE.Group();
  group.name = 'secret-icefall';
  const colliders = [];
  const P = {};
  // lateral v from the line (positive toward the bay's side) -> world
  const pt = (s, v, h) => { path.point(s, v * side, P); return [P.x, floor(s) + h, P.z]; };
  const end = (s) => smoothstep(s0, s0 + 5, s) * (1 - smoothstep(s1 - 5, s1, s)); // the ends taper into the wall
  // ---- the ledge: a slab out of the back wall to just past the curtain's line; snow on top, ice under it
  {
    const NU = Math.ceil((s1 - s0) / 1.1), NV = 7;
    const pos = [], uvs = [], idxTop = [], idxBot = [];
    for (const top of [1, -1]) {
      const base = pos.length / 3;
      for (let i = 0; i <= NU; i++) {
        const s = s0 + ((s1 - s0) * i) / NU, e = end(s);
        const back = wallAt(s, ledgeH) + 1.2, front = curtainAt(s) - 0.5 - 0.5 * (0.5 + 0.5 * NZ.noise(s * 0.23 + seed, 1.7));
        const fv = front * e + (back - 1.5) * (1 - e); // the ends pull back into the wall
        for (let j = 0; j <= NV; j++) {
          const t = j / NV, v = back + (fv - back) * t;
          const thick = (1.5 + 0.7 * NZ.noise(s * 0.17, v * 0.2 + seed)) * (0.4 + 0.6 * e) * (0.55 + 0.45 * (1 - t));
          const bump = NZ2.noise(s * 0.31 + v * 0.2, top * 3 + seed) * 0.3;
          const h = ledgeH + top * thick * 0.5 + bump + (j === NV ? -0.25 * top : 0) - (1 - e) * 1.2;
          pos.push(...pt(s, v, h)); uvs.push(s / 5, v / 5);
        }
        if (late()) yield;
      }
      const into = top > 0 ? idxTop : idxBot, R = NV + 1;
      for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
        const a = base + i * R + j, b = a + R, c = a + 1, d = b + 1;
        // (v runs from the wall out toward the couloir; facing up for the top, down for the underside)
        if ((top > 0) === (side > 0)) into.push(a, c, b, b, c, d); else into.push(a, b, c, b, d, c);
      }
    }
    // the lip: the front row of the top joined to the front row of the underside (glazed with ice)
    const half = (NU + 1) * (NV + 1);
    for (let i = 0; i < NU; i++) {
      const a = i * (NV + 1) + NV, b = a + NV + 1, c = half + a, d = half + b;
      if (side > 0) idxBot.push(a, b, c, b, d, c); else idxBot.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex([...idxTop, ...idxBot]);
    geo.addGroup(0, idxTop.length, 0); geo.addGroup(idxTop.length, idxBot.length, 1);
    geo.computeVertexNormals();
    withData(geo);
    const m = new THREE.Mesh(geo, [featureRockMaterial(), glacierIceMaterial()]);
    m.castShadow = true; m.receiveShadow = true;
    m.name = 'secret-icefall-ledge';
    group.add(m);
  }
  yield;
  // ---- the icefall: down the back wall from near the rim onto the ledge, bulging, with flutes
  {
    const sc = (s0 + s1) / 2, width = Math.min(11, (s1 - s0) * 0.38);
    const top = Math.max(ledgeH + 6, rimAt(sc) - 2.5);
    const rows = 30, cols = 12, pos = [], uvs = [], idx = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows, h = ledgeH + 0.3 + (top - ledgeH - 0.3) * t;
      const w = width * (0.62 + 0.38 * Math.sin(t * Math.PI * 0.85 + 0.25)) * (0.85 + 0.25 * NZ.noise(t * 5, seed));
      for (let c = 0; c <= cols; c++) {
        const k = c / cols - 0.5, s = sc + k * w;
        const bulge = (1 - (2 * k) ** 2) * (0.65 + 0.45 * NZ.noise(t * 8 + seed, k * 3)) + 0.22 * NZ2.noise(t * 15, k * 9) + 0.12 * Math.sin(k * 23 + t * 3);
        pos.push(...pt(s, wallAt(s, h) - 0.25 - Math.max(0, bulge) * 0.75, h)); uvs.push((k * w) / 4, h / 5);
      }
      if (late()) yield;
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + cols + 1, cc = a + 1, d = b + 1;
      if (side > 0) idx.push(a, b, cc, b, d, cc); else idx.push(a, cc, b, b, cc, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, glacierIceMaterial()); // (double-sided)
    m.castShadow = true; m.receiveShadow = true;
    m.name = 'secret-icefall-cascade';
    group.add(m);
  }
  yield;
  // ---- the curtain: a fluted drapery of ice from the ledge's lip to the snow, along the couloir's wall line;
  // a window in the middle (the hem hangs at head height there), the passage open at both ends
  const win = s0 + (s1 - s0) * (0.45 + 0.1 * rnd()), winW = 2.2;
  const flute = (s, h) => (0.17 * Math.sin(s * 5.3 + 2.4 * NZ.noise(s * 0.35, seed)) + 0.1 * Math.sin(s * 12.1 + 3.1 * NZ2.noise(s * 0.6 + 4, seed))) * (0.55 + 0.6 * Math.abs(NZ.noise(s * 0.21, h * 0.09 + 1.3)))
    + 0.2 * NZ.noise(s * 0.95 + seed, h * 0.16) + 0.3 * NZ2.noise(s * 0.13, h * 0.07 + seed);
  const cs0 = s0 + 6, cs1 = s1 - 6;
  {
    const hem = (s) => { const open = 1 - smoothstep(winW * 0.55, winW, Math.abs(s - win)); return -0.25 + open * (2.4 + 0.4 * NZ.noise(s * 0.9, seed)); };
    const topAt = (s) => ledgeH - 0.75 + NZ.noise(s * 0.4 + seed, 2.2) * 0.2;
    const pos = [], uvs = [], idx = [];
    const NS = Math.ceil((cs1 - cs0) / 0.22), NH = 16;
    for (let i = 0; i <= NS; i++) {
      const s = cs0 + ((cs1 - cs0) * i) / NS, ht = topAt(s), hb = hem(s);
      // the curtain's ends curl back toward the wall (they meet the ledge's tapered ends)
      const curl = 1 - Math.min(smoothstep(cs0, cs0 + 3, s), 1 - smoothstep(cs1 - 3, cs1, s));
      for (let j = 0; j <= NH; j++) {
        const t = j / NH, h = ht + (hb - ht) * t;
        const foot = smoothstep(0.6, 1, t) * (hb < 0.5 ? 1 : 0.2); // the frozen splash bulges out at the foot
        const v = curtainAt(s) + flute(s, h) - foot * (0.5 + 0.25 * NZ.noise(s * 1.1, 4.4)) + curl * 2.5;
        pos.push(...pt(s, v, h)); uvs.push(s / 3.2, h / 6);
      }
      if (late()) yield;
    }
    const R = NH + 1;
    for (let i = 0; i < NS; i++) for (let j = 0; j < NH; j++) {
      const a = i * R + j, b = a + R, c = a + 1, d = b + 1;
      if (side > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, glacierIceMaterial()); // (double-sided)
    m.castShadow = true; m.receiveShadow = true;
    m.name = 'secret-icefall-curtain';
    group.add(m);
    yield;
    // icicles: along the window's hem and under the ledge
    const b = new MeshBuilder();
    for (let s = win - winW; s < win + winW; s += 0.12 + rnd() * 0.18) {
      const hb = hem(s);
      if (hb < 0.8) continue;
      const [x, , z] = pt(s, curtainAt(s) + flute(s, hb), 0);
      const len = 0.25 + rnd() * rnd() * 1.4;
      b.at(x, floor(s) + hb - len + 0.05, z, rnd() * 6).cyl(0, 0, 0, 0, 0.035 + rnd() * 0.06, len, 5, tint('#cfeaff', 0.06, s));
    }
    for (let s = cs0; s < cs1; s += 0.35 + rnd() * 0.5) {
      const v = curtainAt(s) + 1.2 + rnd() * Math.max(0.5, wallAt(s, ledgeH) - curtainAt(s) - 2.4);
      const [x, , z] = pt(s, v, 0);
      const topH = floor(s) + ledgeH - 0.95, len = 0.2 + rnd() * rnd() * 1.3;
      b.at(x, topH - len, z, rnd() * 6).cyl(0, 0, 0, 0, 0.035 + rnd() * 0.06, len, 5, tint('#d6efff', 0.05, s * 3));
    }
    const icicles = new THREE.Mesh(b.build(), iceColumnMaterial());
    icicles.castShadow = true;
    icicles.name = 'secret-icefall-icicles';
    group.add(icicles);
    // soft colliders along the curtain (open at the window and the ends: in / out of the passage)
    for (let s = cs0 + 1; s < cs1 - 1; s += 2.5) {
      if (Math.abs(s + 1.25 - win) < winW + 0.3) continue;
      const a = path.point(s, curtainAt(s) * side, {}), c = path.point(Math.min(cs1, s + 2.5), curtainAt(Math.min(cs1, s + 2.5)) * side, {});
      colliders.push({ x: (a.x + c.x) / 2, z: (a.z + c.z) / 2, hw: Math.hypot(c.x - a.x, c.z - a.z) / 2 + 0.2, hd: 0.4, rot: Math.atan2(c.z - a.z, c.x - a.x), soft: true, secret: true });
    }
  }
  // the passage behind the ice: halfway between the curtain and the wall's foot
  const passage = (s) => (curtainAt(s) + wallAt(s, 0)) / 2;
  return { group, colliders, passage, cs0, cs1 };
}

/**
 * A natural rock arch over a path: two legs rooted in rock masses either side, a thick irregular span, snow on top.
 * o: at {x, z} (the arch's centre on the path), yaw (the path's direction through it), span (clear width), clear
 *   (clear height over the snow), thick (span thickness), depth (along the path), heightAt(x, z)
 */
export function* buildArchSteps(o) {
  const { at, yaw, span = 14, clear = 10, thick = 6.5, depth = 9, heightAt, seed = 1 } = o;
  const group = new THREE.Group();
  group.name = 'secret-arch';
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // local frame: a = across the path (the arch's span), b = along the path, y up
  const W = (a, b) => [at.x + a * cy + b * sy, at.z - a * sy + b * cy];
  const y0 = heightAt(at.x, at.z);
  // the arch's centre line: an irregular half-ellipse whose feet go well below the snow
  const R = span / 2 + thick * 0.5, H = clear + thick * 0.5;
  // the feet stand on the slope across the path: the base line runs from one foot's snow to the other's
  const yL = Math.min(...[-1, 0, 1].map((k) => { const [x, z] = W(-R, k * depth * 0.3); return heightAt(x, z); }));
  const yR = Math.min(...[-1, 0, 1].map((k) => { const [x, z] = W(R, k * depth * 0.3); return heightAt(x, z); }));
  const base = (a) => { const u = clamp((a / R + 1) / 2, 0, 1); return yL + (yR - yL) * u; };
  const N = 60, M = 18;
  const pos = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, th = Math.PI * (1 - t);
    const ex = (0.08 + 0.04 * NZ.noise(t * 3, seed)) * Math.sin(th * 2); // lopsided
    let ca = Math.cos(th) * R * (1 + ex), cb = NZ.noise(t * 2.2 + seed, 4.1) * 0.8, ch = Math.sin(th) * H;
    // feet: continue down below the snow and spread
    const foot = 1 - smoothstep(0, 0.18, Math.min(t, 1 - t));
    ch -= foot * 3.5;
    ca *= 1 + foot * 0.12;
    // cross-section size: thicker at the feet, thinnest at the crown
    const crown = Math.sin(th);
    // thicker at the feet and lopsided along the span (one leg heavier), thinnest a little off the crown
    const lop = 1 + 0.18 * NZ.noise(t * 2.6 + seed, 8.1) + 0.12 * (t - 0.5);
    const ra = thick * (0.5 + 0.5 * (1 - crown)) * (1 + 0.6 * foot) * lop, rb = depth * (0.48 + 0.22 * (1 - crown)) * (1 + 0.5 * foot) * (1 + 0.15 * NZ2.noise(t * 3.1, seed + 2));
    for (let j = 0; j <= M; j++) {
      const ph = (j / M) * Math.PI * 2;
      // around the centre line: in the plane spanned by the curve's normal (in the a-y plane) and b
      const nx = Math.cos(th), ny = Math.sin(th); // outward from the ellipse centre
      // lumpy rock: broad blocks, then smaller facets; the top side flatter (it carries the snow)
      let n = 1 + 0.26 * NZ.noise(t * 6 + Math.cos(ph) * 1.2, Math.sin(ph) * 1.2 + seed) + 0.13 * NZ2.noise(t * 17 + Math.cos(ph) * 2.2, Math.sin(ph) * 2.2 - seed)
        + 0.06 * NZ.noise(t * 41 + ph * 1.7, seed + 5);
      n *= 1 - 0.18 * Math.max(0, Math.cos(ph)) ** 3;
      const ox = Math.cos(ph) * ra * 0.5 * n, ob = Math.sin(ph) * rb * 0.5 * n;
      const a = ca + nx * ox, y = ch + ny * ox, b = cb + ob;
      const [wx, wz] = W(a, b);
      // (the crown keeps its clear height over the path; the legs follow the slope down to their feet)
      const yb = y0 + (base(ca) - y0) * (1 - Math.sin(th));
      pos.push(wx, yb + y, wz);
    }
    if (late()) yield;
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + M + 1, c = a + 1, d = b + 1;
    idx.push(a, c, b, b, c, d); // (faces out)
  }
  yield;
  // rock masses the legs stand in: lumpy blobs, half buried
  const blobs = [];
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
    const a = s * (R + 1 + k * 2.2), b = (k - 1) * depth * 0.45;
    blobs.push({ a, b, r: 4.5 - k * 0.8, h: 3 - k * 1.2 });
  }
  for (const bl of blobs) {
    const base = pos.length / 3, NB = 10, MB = 16;
    for (let i = 0; i <= NB; i++) {
      const th = (i / NB) * Math.PI * 0.62; // a dome, its rim below the snow
      for (let j = 0; j <= MB; j++) {
        const ph = (j / MB) * Math.PI * 2;
        const n = 1 + 0.25 * NZ.noise(Math.cos(ph) * 1.6 + bl.a, Math.sin(ph) * 1.6 + i * 0.3) + 0.08 * NZ2.noise(ph * 3, i + bl.b);
        const rr = Math.sin(th) * bl.r * n, yy = Math.cos(th) * bl.r * 0.85 * n;
        const [wx, wz] = W(bl.a + Math.cos(ph) * rr, bl.b + Math.sin(ph) * rr);
        pos.push(wx, heightAt(wx, wz) - bl.r * 0.55 + bl.h * 0.5 + yy, wz);
      }
      if (late()) yield;
    }
    for (let i = 0; i < NB; i++) for (let j = 0; j < MB; j++) {
      const a = base + i * (MB + 1) + j, b = a + MB + 1, c = a + 1, d = b + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  withData(geo);
  const m = new THREE.Mesh(geo, featureRockMaterial());
  m.castShadow = true; m.receiveShadow = true;
  m.name = 'secret-arch-rock';
  group.add(m);
  // colliders: the legs
  const colliders = [];
  for (const s of [-1, 1]) {
    const [x, z] = W(s * (R + 0.2), 0);
    colliders.push({ x, z, r: thick * 0.75, secret: true });
  }
  return { group, colliders, R, H, y0 };
}
