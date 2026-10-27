// Course structures: the tunnel through the rock ridge, the arch bridge over the gorge, the frozen lake
// and the frozen waterfall. All are fitted to the region heightfield (feet, springings and edges are
// sampled from world.height so nothing floats or clips).
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { createTerrainMaterial, terrainUniforms } from '../../world/terrain.js';
import { mulberry32, smoothstep, clamp } from '../../core/noise.js';
import { MeshBuilder, tint, vcMaterial, canvasTexture, FONT, BLUE } from './kit.js';
import { floodBank, floodBankLow, floodMaterial, bracketLanterns } from '../../world/meshylights.js';

const UP = new THREE.Vector3(0, 1, 0);

// ================================================================== TUNNEL
// A rock tunnel (alpine) or an ice tunnel (glacier) through the ridge the region heightfield raises across
// the track (region.js): the tube sits in a trench whose flat floor reaches past its outer shell, a terrain-
// shaded cap closes the trench, and at both ends a stone portal facade stands in a notch of the mountain
// (the ridge face leans back above it and the spur's flanks come forward around it).
// Inside it is dark: daylight only reaches a few metres in from the portals, the lamps light the rest
// (warm pools on the walls and the floor); the glacier tunnel stays blue, lit through the ice.
const TUN_HS = 3.5, TUN_HC = 7.4; // springline / crown height of the inner profile

// Portal facade dimensions, shared with the ridge face in the heightfield (region.js): halfW / topW = the
// trapezoid's half-width at the foot / top, wallTop = its height above the track, depth = its thickness,
// floorHalf = half-width of the flat trench floor around the tube.
export function portalDims(tn) {
  const TH = tn.cutHalf - tn.inner;
  return { halfW: tn.cutHalf + 7.5, topW: tn.cutHalf + 4.6, wallTop: TUN_HC + TH + 3.6, depth: 3.6, floorHalf: tn.cutHalf + 2.9 };
}

// Inner cross-section: vertical walls to the springline, elliptical arch to the crown. Also returns the
// arc length of every profile point (texture u).
function tunnelProfile(Wi, Hs, Hc, n = 16) {
  const P = [[-Wi, -0.45], [-Wi, 0.7], [-Wi, 1.9], [-Wi, Hs]];
  for (let k = 1; k < n; k++) {
    const th = (k / n) * Math.PI;
    P.push([-Wi * Math.cos(th), Hs + (Hc - Hs) * Math.sin(th)]);
  }
  P.push([Wi, Hs], [Wi, 1.9], [Wi, 0.7], [Wi, -0.45]);
  let L = 0;
  const arc = P.map((p, i) => (i ? (L += Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1])) : 0));
  return { P, arc };
}

// ------------------------------------------------------------------ surface textures (drawn once, shared)
// 256 px tileable tiles on a canvas (~0.35 MB each with mipmaps), kept across course rebuilds.
const TEX = {};
function sharedTex(key, draw) {
  if (key in TEX) return TEX[key];
  const t = canvasTexture(256, 256, draw, { wrap: true, anisotropy: 4 });
  if (t) t.userData.shared = true;
  return (TEX[key] = t);
}
// draw fn at (x, y) and at its wrapped copies, so the tile repeats without seams
function wrapped(w, h, x, y, r, fn) {
  for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
    const px = x + ox, py = y + oy;
    if (px + r < 0 || px - r > w || py + r < 0 || py - r > h) continue;
    fn(px, py);
  }
}
function speckle(g, w, h, rnd, n, light, dark, size = 1.6) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, s = 0.6 + rnd() * size;
    g.fillStyle = rnd() < 0.5 ? light : dark;
    g.fillRect(x, y, s, s);
  }
}
function blotches(g, w, h, rnd, n, rMin, rMax, colors) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = rMin + rnd() * (rMax - rMin), c = colors[Math.floor(rnd() * colors.length)];
    wrapped(w, h, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
}
function cracks(g, w, h, rnd, n, color, len = 40, lw = 1) {
  g.strokeStyle = color; g.lineWidth = lw;
  for (let i = 0; i < n; i++) {
    let x = rnd() * w, y = rnd() * h, a = rnd() * Math.PI * 2;
    const pts = [[x, y]];
    for (let k = 0; k < len / 4; k++) { a += (rnd() - 0.5) * 1.1; x += Math.cos(a) * 4; y += Math.sin(a) * 4; pts.push([x, y]); }
    wrapped(w, h, pts[0][0], pts[0][1], len + 4, (px, py) => {
      const dx = px - pts[0][0], dy = py - pts[0][1];
      g.beginPath(); g.moveTo(pts[0][0] + dx, pts[0][1] + dy);
      for (const p of pts) g.lineTo(p[0] + dx, p[1] + dy);
      g.stroke();
    });
  }
}

// cut stone blocks (ashlar) for the portal facades: tile = 4 x 4 m, courses 0.5 m, blocks 0.6 - 1.5 m
function stoneTexture() {
  return sharedTex('stone', (g, w, h) => {
    const rnd = mulberry32(7301);
    g.fillStyle = '#45443f'; g.fillRect(0, 0, w, h); // mortar
    // courses of varying height (0.55 - 0.8 m), long rough-faced blocks (0.9 - 2.2 m), tones from grey granite
    // to weathered ochre
    const rows = [40, 50, 36, 46, 42, 42];
    let y = 0;
    const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
    for (const rh of rows) {
      let x = -rnd() * 90;
      while (x < w) {
        const bw = 58 + rnd() * 84, tone = 0.72 + rnd() * 0.42, warm = (rnd() - 0.35) * 16;
        const base = [c(150 * tone + warm), c(148 * tone + warm * 0.45), c(144 * tone - warm * 0.3)];
        const y0 = y + 1.5, x0 = x + 1.5, bh = rh - 3, bw2 = bw - 3;
        const spots = Array.from({ length: 3 }, () => [rnd() * bw2, rnd() * bh, 6 + rnd() * 16, rnd() < 0.5]);
        for (const ox of [-w, 0, w]) { // (rows tile vertically by construction: only wrap around x)
          const xx = x0 + ox;
          if (xx + bw2 < 0 || xx > w) continue;
          g.save();
          g.beginPath(); g.rect(xx, y0, bw2, bh); g.clip();
          g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; g.fillRect(xx, y0, bw2, bh);
          // rough face: a few lighter / darker hollows on every block
          for (const [sx, sy, sr, light] of spots) {
            const gr = g.createRadialGradient(xx + sx, y0 + sy, 0, xx + sx, y0 + sy, sr);
            gr.addColorStop(0, light ? 'rgba(255,255,255,0.14)' : 'rgba(20,18,16,0.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
            g.fillStyle = gr; g.fillRect(xx, y0, bw2, bh);
          }
          // chiselled edges: light top / left, shadowed bottom / right
          g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(xx, y0, bw2, 2); g.fillRect(xx, y0, 2, bh);
          g.fillStyle = 'rgba(0,0,0,0.26)'; g.fillRect(xx, y0 + bh - 3, bw2, 3); g.fillRect(xx + bw2 - 2, y0, 2, bh);
          g.restore();
        }
        x += bw;
      }
      y += rh;
    }
    blotches(g, w, h, rnd, 40, 14, 40, ['rgba(40,44,52,0.16)', 'rgba(255,255,255,0.08)', 'rgba(90,70,50,0.12)']);
    speckle(g, w, h, rnd, 3600, 'rgba(255,255,255,0.16)', 'rgba(0,0,0,0.22)');
  });
}
// dressed stone (voussoirs, jambs, coping): grain and weathering only; every block face maps the whole tile
function grainTexture() {
  return sharedTex('grain', (g, w, h) => {
    const rnd = mulberry32(7411);
    g.fillStyle = '#9a9b9e'; g.fillRect(0, 0, w, h);
    blotches(g, w, h, rnd, 30, 16, 50, ['rgba(40,44,52,0.16)', 'rgba(255,255,255,0.12)', 'rgba(80,70,60,0.1)']);
    speckle(g, w, h, rnd, 3000, 'rgba(255,255,255,0.2)', 'rgba(0,0,0,0.22)');
    // chiselled rim: every block face reads as a separate stone
    g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(0, 0, w, 5); g.fillRect(0, 0, 5, h);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, h - 5, w, 5); g.fillRect(w - 5, 0, 5, h);
  });
}
// tunnel lining: rock tunnel = sprayed concrete (shotcrete) with ring joints every 3 m; tile = 6 x 6 m
function liningTexture(ice) {
  return sharedTex(ice ? 'ice' : 'lining', (g, w, h) => {
    const rnd = mulberry32(ice ? 9203 : 9107);
    if (ice) {
      g.fillStyle = '#9ccfec'; g.fillRect(0, 0, w, h);
      blotches(g, w, h, rnd, 50, 16, 52, ['rgba(255,255,255,0.22)', 'rgba(40,125,195,0.2)', 'rgba(160,220,250,0.25)', 'rgba(25,90,160,0.14)']);
      cracks(g, w, h, rnd, 7, 'rgba(255,255,255,0.18)', 70, 1);
      for (let i = 0; i < 120; i++) { // trapped air bubbles
        const x = rnd() * w, y = rnd() * h, r = 0.4 + rnd() * 0.9;
        g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    } else {
      g.fillStyle = '#8d8c89'; g.fillRect(0, 0, w, h);
      blotches(g, w, h, rnd, 90, 10, 40, ['rgba(40,38,36,0.2)', 'rgba(255,255,255,0.12)', 'rgba(90,80,66,0.16)', 'rgba(30,34,40,0.18)']);
      speckle(g, w, h, rnd, 5200, 'rgba(255,255,255,0.2)', 'rgba(0,0,0,0.24)', 1.4);
      cracks(g, w, h, rnd, 10, 'rgba(30,28,26,0.16)', 50, 1);
      // ring joints between the lining segments (3 m apart along the tube), with seepage stains below them
      for (const y of [0, h / 2]) {
        g.fillStyle = 'rgba(25,24,22,0.3)'; g.fillRect(0, y, w, 2);
        g.fillStyle = 'rgba(25,24,22,0.08)'; g.fillRect(0, y + 2, w, 4);
      }
    }
  });
}

export function buildTunnel(course, models, group) {
  const T = course.track, tn = course.tunnel, R = course.region;
  if (!tn) return;
  const ice = tn.ice, P = tn.portal || portalDims(tn);
  const Wi = tn.inner, Hs = TUN_HS, Hc = TUN_HC, TH = tn.cutHalf - tn.inner;
  const { P: prof, arc } = tunnelProfile(Wi, Hs, Hc);
  const { P: outer } = tunnelProfile(Wi + TH, Hs, Hc + TH);
  const sA = tn.s0 - 0.1, sB = tn.s1 + 0.1; // just behind the portal arch's stone lip
  const N = Math.ceil((sB - sA) / 1.5);
  const lampEvery = 10;
  const lamps = [];
  for (let s = tn.s0 + 5; s < tn.s1 - 3; s += lampEvery) lamps.push(s);
  // daylight reaching in from the portals (1 at the mouth, gone ~22 m in)
  const daylight = (s) => Math.max(1 - smoothstep(-1, 22, s - tn.s0), smoothstep(tn.s1 - 22, tn.s1 + 1, s));
  const lampCol = ice ? [0.75, 0.9, 1.1] : [1.0, 0.84, 0.62];

  // --- tube (inner + outer shell). aLight = (lamp pool, daylight) -> lighting in the shader
  const pos = [], nor = [], col = [], uvs = [], light = [], idx = [];
  const frame = (s) => {
    const p = T.pointAt(s, 0);
    return { x: p.x, z: p.z, y: T.surfaceY(s, 0), rx: -Math.cos(p.heading), rz: Math.sin(p.heading), tx: Math.sin(p.heading), tz: Math.cos(p.heading) };
  };
  const shell = (Pf, inward) => {
    const start = pos.length / 3;
    for (let j = 0; j <= N; j++) {
      const s = sA + ((sB - sA) * j) / N;
      const f = frame(s), day = daylight(s);
      for (let k = 0; k < Pf.length; k++) {
        const [v, h] = Pf[k];
        pos.push(f.x + f.rx * v, f.y + h, f.z + f.rz * v);
        // normal from the profile tangent (rotated 90 deg), pointing into the tunnel for the inner shell
        const a = Pf[Math.max(0, k - 1)], b = Pf[Math.min(Pf.length - 1, k + 1)];
        let nv = b[1] - a[1], nh = -(b[0] - a[0]);
        const l = Math.hypot(nv, nh) || 1; nv /= l; nh /= l;
        if (!inward) { nv = -nv; nh = -nh; }
        nor.push(f.rx * nv, nh, f.rz * nv);
        uvs.push(arc[k] / 6, s / 6);
        // grime and seepage along the foot of the walls, a darker crown (soot / meltwater)
        const low = 1 - smoothstep(0.1, 1.8, h), crown = smoothstep(Hc - 1.6, Hc, h);
        const g = ice ? 1 - low * 0.25 : 1 - low * 0.45 - crown * 0.18;
        col.push(g, g, ice ? g * 1.02 : g);
        let gl = 0;
        if (inward) {
          const wR = THREE.MathUtils.clamp(0.5 + (v / Wi) * 0.75, 0.08, 1), wL = THREE.MathUtils.clamp(0.5 - (v / Wi) * 0.75, 0.08, 1);
          for (const ls of lamps) {
            const dl = s - ls, dr = s - ls - lampEvery / 2;
            gl += Math.exp(-(dl * dl) / 6) * wL + Math.exp(-(dr * dr) / 6) * wR;
          }
          gl *= 0.2 + 0.8 * smoothstep(0.5, Hs + 2, h);
        }
        light.push(inward ? Math.min(1, gl) : 0, day);
      }
    }
    const W = Pf.length;
    for (let j = 0; j < N; j++) for (let k = 0; k < W - 1; k++) {
      const a = start + j * W + k, b = a + 1, c = a + W, d = c + 1;
      if (inward) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  };
  shell(prof, true);
  shell(outer, false);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aLight', new THREE.Float32BufferAttribute(light, 2));
  geo.setIndex(fixWinding(pos, nor, idx));
  geo.computeBoundingSphere();
  const tubeMat = new THREE.MeshStandardMaterial({
    map: liningTexture(ice), vertexColors: true, roughness: ice ? 0.22 : 0.92, metalness: 0, envMapIntensity: ice ? 1.0 : 0.6,
  });
  const v3 = (c) => `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`;
  tubeMat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aLight;\nvarying vec2 vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vLight;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // inside the mountain the sun and the sky only reach in from the portals (vLight.y); the glacier
        // tunnel keeps a blue glow through the ice
        reflectedLight.directDiffuse *= vLight.y;
        reflectedLight.directSpecular *= vLight.y;
        reflectedLight.indirectDiffuse *= mix(${ice ? 'vec3(0.2, 0.42, 0.75)' : 'vec3(0.035)'}, vec3(1.0), vLight.y);
        reflectedLight.indirectSpecular *= mix(${ice ? '0.4' : '0.06'}, 1.0, vLight.y);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * ${v3(lampCol)} * (vLight.x * ${ice ? '0.9' : '1.3'} + ${ice ? '0.0' : '0.025'});`);
  };
  tubeMat.customProgramCacheKey = () => 'parkour-tunnel2-' + (ice ? 'ice' : 'rock');
  const tube = new THREE.Mesh(geo, tubeMat);
  tube.castShadow = true; tube.receiveShadow = true;
  group.add(tube);

  // --- lamp fixtures, cable trays, delineators
  const fx = new MeshBuilder();
  const tray = tint('#2a2c30'), refl = tint('#ff7a1a');
  const th = 0.42; // lamp position on the arch (radians from the springline)
  const spots = [];
  for (const ls of lamps) {
    for (const sd of [-1, 1]) {
      const s = ls + (sd > 0 ? lampEvery / 2 : 0);
      if (s <= tn.s1 - 3) spots.push({ s, sd });
    }
  }
  // the Meshy COB floodlight bank (the piste masts' four floods in a row, 0.8 m long; its texture baked into a
  // light copy) flat on the arch, its row along the tube, its glass facing across it, always lit; without the
  // model a built strip lamp
  const bank = floodBank(models, 'floodlight_head_c', 0.8);
  if (bank) {
    const geo = floodBankLow(bank, 0.016);
    const bb = geo.boundingBox;
    const mat = floodMaterial(bank, { color: ice ? [0.78, 0.9, 1.08] : [1.0, 0.86, 0.68], gain: 0.8, deSnow: true, baked: true, interior: ice ? 'ice' : 'rock' });
    mat.userData.shared = true; // (its textures are the piste masts' too: never disposed with the course)
    // (a geometry of its own carrying each lamp's (own light, daylight), sharing the baked buffers)
    const lit = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(geo.attributes)) lit.setAttribute(name, a);
    lit.setIndex(geo.index);
    lit.setAttribute('aLight', new THREE.InstancedBufferAttribute(new Float32Array(spots.flatMap(({ s }) => [1, daylight(s)])), 2));
    const mesh = new THREE.InstancedMesh(lit, mat, spots.length);
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), m4 = new THREE.Matrix4(), P = new THREE.Vector3();
    spots.forEach(({ s, sd }, i) => {
      const f = frame(s);
      // the point on the arch and the lining's inward normal there (the elliptic arch's)
      const v = sd * Wi * Math.cos(th), h = Hs + (Hc - Hs) * Math.sin(th);
      P.set(f.x + f.rx * v, f.y + h, f.z + f.rz * v);
      const nv = -sd * Math.cos(th) / Wi, nh = -Math.sin(th) / (Hc - Hs);
      Z.set(f.rx * nv, nh, f.rz * nv).normalize();
      X.set(f.tx, 0, f.tz).addScaledVector(Z, -(f.tx * Z.x + f.tz * Z.z)).normalize();
      Y.crossVectors(Z, X);
      if (Y.y < 0) { X.negate(); Y.negate(); }
      // its back 1 cm off the lining, centred on the spot
      P.addScaledVector(Z, -bb.min.z + 0.01).addScaledVector(Y, -(bb.min.y + bb.max.y) / 2);
      m4.makeBasis(X, Y, Z).setPosition(P);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'tunnel-lamps';
    group.add(mesh);
  } else {
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: ice ? 0xcfe8ff : 0xffd9a8, emissiveIntensity: 9, roughness: 0.4 });
    const lb = new MeshBuilder();
    for (const { s, sd } of spots) {
      const f = frame(s);
      const v = sd * Wi * Math.cos(th) * 0.97, h = Hs + (Hc - Hs) * Math.sin(th) - 0.12;
      lb.at(f.x + f.rx * v, f.y + h, f.z + f.rz * v, Math.atan2(f.tx, f.tz), 0, sd * 0.35).box(0, 0, 0, 0.22, 0.14, 1.3, WHITE);
    }
    group.add(new THREE.Mesh(lb.build(), lampMat));
  }
  for (let s = tn.s0 + 1; s < tn.s1 - 1; s += 3) {
    const f = frame(s), f2 = frame(Math.min(tn.s1 - 1, s + 3));
    for (const sd of [-1, 1]) {
      const v = sd * (Wi - 0.12);
      fx.at(0, 0, 0).rod(f.x + f.rx * v, f.y + 2.5, f.z + f.rz * v, f2.x + f2.rx * v, f2.y + 2.5, f2.z + f2.rz * v, 0.05, 5, tray);
    }
  }
  for (let s = tn.s0 + 4; s < tn.s1 - 2; s += 8) {
    const f = frame(s);
    for (const sd of [-1, 1]) {
      const v = sd * (Wi - 0.04);
      fx.at(f.x + f.rx * v, f.y + 0.95, f.z + f.rz * v, Math.atan2(f.rx, f.rz)).box(0, 0, 0, 0.05, 0.16, 0.08, refl);
    }
  }
  const fxMesh = new THREE.Mesh(fx.build(), vcMaterial({ roughness: 0.6, metalness: 0.3 }));
  fxMesh.castShadow = true; fxMesh.receiveShadow = true;
  group.add(fxMesh);

  // --- the snow floor (terrain) in the dark: a multiply decal takes the daylight away (it fades in toward
  // the portals) and an additive one lays the lamps' pools on it
  {
    const Pm = [], Cm = [], Ca = [], I = [];
    const M = Math.ceil((sB - sA) / 1);
    const lat = [-1, -0.6, -0.2, 0.2, 0.6, 1];
    for (let j = 0; j <= M; j++) {
      const s = sA + ((sB - sA) * j) / M;
      const f = frame(s), day = daylight(s);
      let pL = 0, pR = 0; // pools under the left lamps and under the right ones (half a spacing on)
      for (const ls of lamps) { pL += Math.exp(-((s - ls) ** 2) / 5); pR += Math.exp(-((s - ls - lampEvery / 2) ** 2) / 5); }
      for (const l of lat) {
        const v = l * (Wi - 0.05);
        Pm.push(f.x + f.rx * v, T.surfaceY(s, v) + 0.03, f.z + f.rz * v);
        const k = THREE.MathUtils.lerp(ice ? 0.38 : 0.06, 1, day);
        // (the snow in there is lit blue by the sky through the shader; a warm-neutral dark keeps it from glowing navy)
        const tw = ice ? [0.82, 0.92, 1] : [1, 0.86, 0.68];
        Cm.push(k * THREE.MathUtils.lerp(tw[0], 1, day), k * THREE.MathUtils.lerp(tw[1], 1, day), k * THREE.MathUtils.lerp(tw[2], 1, day));
        const pool = pL * THREE.MathUtils.clamp(0.55 - l * 0.45, 0.1, 1) + pR * THREE.MathUtils.clamp(0.55 + l * 0.45, 0.1, 1);
        const p = Math.min(1, pool) * (1 - day) * (ice ? 0.1 : 0.32);
        Ca.push(lampCol[0] * p, lampCol[1] * p, lampCol[2] * p);
      }
    }
    for (let j = 0; j < M; j++) for (let q = 0; q < lat.length - 1; q++) {
      const a = j * lat.length + q, b = a + 1, c = a + lat.length, d = c + 1;
      I.push(a, c, b, b, c, d);
    }
    const decal = (colors, blending, order) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(Pm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.setIndex(I);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, blending, transparent: true, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.renderOrder = order;
      group.add(m);
    };
    decal(Cm, THREE.MultiplyBlending, 2);
    decal(Ca, THREE.AdditiveBlending, 3);
  }

  // --- rock cap over the trench (terrain material: identical shading to the ridge around it), from the
  // back of one portal facade to the other
  {
    const half = P.floorHalf + 3, cs0 = tn.s0 + P.depth - 0.5, cs1 = tn.s1 - P.depth + 0.5;
    const NJ = Math.ceil((cs1 - cs0) / 2), NK = Math.ceil((2 * half) / 1);
    const Pc = [], I = [];
    for (let j = 0; j <= NJ; j++) {
      const s = cs0 + ((cs1 - cs0) * j) / NJ;
      for (let k = 0; k <= NK; k++) {
        const v = -half + (2 * half * k) / NK;
        const p = T.pointAt(s, v);
        const edge = Math.abs(v) > half - 1.5 ? 0.15 : 0;
        // never lower than just above the tube crown
        const y = Math.max(R.uncutHeight(p.x, p.z) - edge, T.surfaceY(s, 0) + Hc + TH + 0.35);
        Pc.push(p.x, y, p.z);
      }
    }
    for (let j = 0; j < NJ; j++) for (let k = 0; k < NK; k++) {
      const a = j * (NK + 1) + k, b = a + 1, c = a + NK + 1, d = c + 1;
      I.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(Pc, 3));
    g.setAttribute('aData', new THREE.Float32BufferAttribute(new Float32Array((Pc.length / 3) * 4), 4));
    g.setIndex(fixWindingUp(Pc, I));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const cap = new THREE.Mesh(g, createTerrainMaterial());
    cap.castShadow = true; cap.receiveShadow = true;
    group.add(cap);
  }

  // --- portals at both ends
  for (const end of [0, 1]) {
    const s = end ? tn.s1 + 0.2 : tn.s0 - 0.2;
    const f = frame(s);
    const yaw = Math.atan2(f.tx, f.tz) + (end ? 0 : Math.PI); // portal front faces out of the tunnel
    group.add(buildPortal(course, f, yaw, Wi, end, ice, P, lampCol, models));
  }
}

const WHITE = new THREE.Color(1, 1, 1);

// Portal facade: a stone headwall (trapezoid, cut-stone texture, weathered toward the foot) with the arched
// opening, a ring of voussoirs with a keystone and stone jambs framing it, a plinth, a coping with a snow
// cap, two wall lamps and the name plaque. Front face at local z = 0 facing +z.
function buildPortal(course, f, yaw, Wi, end, ice, P, lampCol, models = {}) {
  const g = new THREE.Group();
  g.position.set(f.x, f.y, f.z);
  g.rotation.y = yaw;
  const Hs = TUN_HS, Hc = TUN_HC;
  const { halfW, topW, wallTop: H, depth: D } = P;
  const B0 = -1.2, Wn = Wi + 0.1, Hn = Hc + 0.1; // the opening sits just outside the tube (no z-fighting)
  const sh = new THREE.Shape();
  sh.moveTo(-halfW, B0);
  sh.lineTo(-Wn, B0);
  sh.lineTo(-Wn, Hs);
  sh.absellipse(0, Hs, Wn, Hn - Hs, Math.PI, 0, true);
  sh.lineTo(Wn, B0);
  sh.lineTo(halfW, B0);
  sh.lineTo(topW, H);
  sh.lineTo(-topW, H);
  sh.lineTo(-halfW, B0);
  const geo = new THREE.ExtrudeGeometry(sh, { depth: D, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 1, curveSegments: 28 });
  geo.translate(0, 0, -D);
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) / 4, uv.getY(k) / 4); // texture tile = 4 m
  // weathering: darker and colder toward the snow line, meltwater streaks under the coping
  const Pp = geo.attributes.position, Cc = new Float32Array(Pp.count * 3);
  const cold = ice ? [0.84, 0.92, 1.04] : [1, 1, 1];
  for (let k = 0; k < Pp.count; k++) {
    const x = Pp.getX(k), y = Pp.getY(k);
    const streak = 0.5 + 0.5 * Math.sin(x * 2.3 + Math.sin(x * 0.7) * 2);
    const t = 0.32 * (1 - smoothstep(-0.8, 2.6, y)) + 0.14 * streak * smoothstep(H - 4.5, H, y);
    for (let q = 0; q < 3; q++) Cc[k * 3 + q] = (1 - t) * cold[q];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(Cc, 3));
  const stone = stoneTexture();
  const wall = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: stone, vertexColors: true, roughness: 0.93, metalness: 0 }));
  wall.castShadow = true; wall.receiveShadow = true;
  g.add(wall);

  // dressed stone: voussoirs + keystone, jambs, plinth, coping (vertex-coloured blocks with the stone map)
  const b = new MeshBuilder({ uv: true });
  const rnd = mulberry32(course.def.seed * 7 + end * 13);
  const blockCol = (k = 1) => { const v = (0.86 + rnd() * 0.2) * k; return new THREE.Color(v * cold[0], v * cold[1], v * cold[2] * (ice ? 1 : 0.98)); };
  // arch ring: equal arc-length blocks around the opening (an ellipse), radial depth 1.05 m, 0.3 m proud
  const ell = [];
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * Math.PI;
    const x = Wn * Math.cos(t), y = Hs + (Hn - Hs) * Math.sin(t);
    ell.push({ x, y, nx: Math.cos(t) / Wn, ny: Math.sin(t) / (Hn - Hs), L: i ? ell[i - 1].L + Math.hypot(x - ell[i - 1].x, y - ell[i - 1].y) : 0 });
  }
  const total = ell[200].L, NV = 19;
  const at = (L) => { let i = 1; while (i < 200 && ell[i].L < L) i++; const a = ell[i - 1], c = ell[i], t = (L - a.L) / Math.max(1e-6, c.L - a.L); return { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, nx: a.nx + (c.nx - a.nx) * t, ny: a.ny + (c.ny - a.ny) * t }; };
  for (let i = 0; i < NV; i++) {
    const L0 = (i / NV) * total, L1 = ((i + 1) / NV) * total, m = at((L0 + L1) / 2);
    const nl = Math.hypot(m.nx, m.ny), nx = m.nx / nl, ny = m.ny / nl;
    const key = i === (NV - 1) / 2, depth = key ? 1.45 : 1.05, proud = key ? 0.45 : 0.3;
    const len = L1 - L0 - 0.05;
    b.at(m.x + nx * (depth / 2 - 0.18), m.y + ny * (depth / 2 - 0.18), (proud - 0.8) / 2, 0, 0, Math.atan2(-nx, ny))
      .box(0, 0, 0, len, depth, 0.8 + proud, blockCol(key ? 1.05 : 1));
  }
  // jambs: stacked blocks from below the snow to the springline, alternating wide / narrow
  for (const sx of [-1, 1]) {
    let y = B0, k = 0;
    while (y < Hs - 0.05) {
      const hgt = Math.min(0.78, Hs - y), wide = k % 2 ? 1.0 : 1.35;
      b.at(sx * (Wn - 0.18 + wide / 2), y + hgt / 2, -0.25).box(0, 0, 0, wide, hgt - 0.05, 1.1, blockCol());
      y += hgt; k++;
    }
  }
  // plinth along the foot, coping with a snow cap along the top
  const dark = new THREE.Color(0.55 * cold[0], 0.56 * cold[1], 0.6 * cold[2]);
  for (const sx of [-1, 1]) {
    const x0 = Wn + 1.45, x1 = halfW - 0.4;
    b.at(sx * (x0 + x1) / 2, (B0 + 0.55) / 2, 0.05).box(0, 0, 0, x1 - x0, 0.55 - B0, 0.3, dark);
  }
  const cop = blockCol(0.92);
  b.at(0, H + 0.2, -D / 2).box(0, 0, 0, topW * 2 + 0.8, 0.42, D + 0.7, cop, cop);
  const trim = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({ map: grainTexture(), vertexColors: true, roughness: 0.9, metalness: 0 }));
  trim.castShadow = true; trim.receiveShadow = true;
  g.add(trim);
  // snow on the coping (a soft, uneven cornice) and, at the glacier, icicles
  const sb = new MeshBuilder();
  const snow = tint('#f2f6fb');
  sb.at(0, H + 0.52, -D / 2 - 0.05).box(0, 0, 0, topW * 2 + 0.55, 0.24, D + 0.5, snow);
  for (let x = -topW; x < topW - 0.3; x += 0.9 + rnd() * 1.2) {
    const w = 0.8 + rnd() * 1.4;
    sb.at(Math.min(x + w / 2, topW - w / 2), H + 0.68, 0.12 + rnd() * 0.1).box(0, 0, 0, w, 0.14 + rnd() * 0.12, 0.5, snow);
  }
  if (ice) {
    const ic = tint('#cfefff');
    for (let x = -topW; x < topW; x += 0.45 + rnd() * 0.5) {
      const len = 0.4 + rnd() * 1.6;
      sb.at(x, H - len, 0.45, 0).cyl(0, 0, 0, 0.0, 0.07 + rnd() * 0.06, len, 5, ic);
    }
  }
  const snowMesh = new THREE.Mesh(sb.build(), vcMaterial({ roughness: 0.75 }));
  snowMesh.castShadow = true; snowMesh.receiveShadow = true;
  g.add(snowMesh);
  // wall lamps either side of the arch: the Meshy lamp post's lantern on its bracket, fixed to the stonework (its
  // flame where the old lamps glowed), else built ones
  const lant = bracketLanterns(models.lamp_post, [-1, 1].map((sx) => ({ position: new THREE.Vector3(sx * (Wn + 2.4), Hs + 0.5, 0.05), out: new THREE.Vector3(0, 0, 1) })), // (the face: z 0.06)
    { size: 0.8, color: lampCol, intensity: 4 });
  if (lant) {
    lant.mesh.userData.keepGeometry = true;    // (the shared lantern's buffers and the model's textures: never
    lant.mesh.material.userData.shared = true; // disposed with the course)
    g.add(lant.mesh);
  } else {
    const lb = new MeshBuilder();
    for (const sx of [-1, 1]) {
      lb.at(sx * (Wn + 2.4), Hs + 0.6, 0.14).box(0, 0, 0, 0.36, 0.5, 0.22, tint('#1d1f23'));
    }
    g.add(new THREE.Mesh(lb.build(), vcMaterial({ roughness: 0.5, metalness: 0.4 })));
    const glow = new MeshBuilder();
    for (const sx of [-1, 1]) glow.at(sx * (Wn + 2.4), Hs + 0.6, 0.26).box(0, 0, 0, 0.26, 0.36, 0.04, WHITE);
    g.add(new THREE.Mesh(glow.build(), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: new THREE.Color(...lampCol), emissiveIntensity: 6, roughness: 0.4 })));
  }
  // name plaque above the keystone
  const name = course.def.tunnelName || 'TUNNEL';
  const tex = canvasTexture(1024, 256, (c, w, h) => {
    c.fillStyle = '#1b1f27'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#e8edf5'; c.lineWidth = 10; c.strokeRect(14, 14, w - 28, h - 28);
    c.fillStyle = '#f2f5fa'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `italic 700 120px ${FONT}`; c.fillText(name, w / 2, h / 2 + 4);
  });
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 1.3), new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x20242c, roughness: 0.5 }));
  plaque.position.set(0, Math.min(Hn + 2.15, H - 0.9), 0.08);
  g.add(plaque);
  g.updateMatrixWorld(true);
  return g;
}

// ================================================================== BRIDGE
export function buildBridge(course, models, group, mats) {
  const T = course.track, B = course.bridge;
  if (!B) return;
  const g = B.gorge;
  const Wd = B.w + 0.75;
  const sA = B.mid - B.rim - 3, sB = B.mid + B.rim + 3; // skiable deck top (overlaps the rims a little)
  const frame = (s) => {
    const p = T.pointAt(s, 0);
    return { x: p.x, z: p.z, rx: -Math.cos(p.heading), rz: Math.sin(p.heading), tx: Math.sin(p.heading), tz: Math.cos(p.heading), heading: p.heading };
  };
  const deckY = (s, v) => T.surfaceY(s, v) + course.deckLift(s);

  // --- deck top: groomed snow with the terrain shader (corduroy along the track)
  {
    const P = [], D = [], I = [];
    const NJ = Math.ceil((sB - sA) / 1.5), lat = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
    for (let j = 0; j <= NJ; j++) {
      const s = sA + ((sB - sA) * j) / NJ;
      const f = frame(s);
      for (const l of lat) {
        const v = l * Wd;
        P.push(f.x + f.rx * v, deckY(s, v), f.z + f.rz * v);
        D.push(0, 1, f.tx, f.tz);
      }
    }
    for (let j = 0; j < NJ; j++) for (let k = 0; k < lat.length - 1; k++) {
      const a = j * lat.length + k, b = a + 1, c = a + lat.length, d = c + 1;
      I.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('aData', new THREE.Float32BufferAttribute(D, 4));
    geo.setIndex(fixWindingUp(P, I));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = createTerrainMaterial();
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1;
    const top = new THREE.Mesh(geo, mat);
    top.receiveShadow = true; top.castShadow = true;
    group.add(top);
  }

  // --- steel structure: edge girders, deck slab, cross beams, railings, arch ribs, columns, abutments
  const st = new MeshBuilder();
  const corten = tint('#7b3f24'), corten2 = tint('#6a3420'), steel = tint('#3a3e45'), conc = tint('#9c9890'), snow = tint('#f1f5fb');
  const dA = B.deck0 + 4, dB = B.deck1 - 4;
  const step = 2;
  for (let s = dA; s < dB; s += step) {
    const s2 = Math.min(dB, s + step);
    const f = frame(s), f2 = frame(s2);
    const y = deckY(s, 0), y2 = deckY(s2, 0);
    const yaw = f.heading, pitch = -Math.atan2(y2 - y, s2 - s);
    const mx = (f.x + f2.x) / 2, my = (y + y2) / 2, mz = (f.z + f2.z) / 2;
    // weathering-steel edge girders (1.5 m deep) with a lighter top flange, concrete slab between
    st.at(mx, my, mz, yaw, pitch);
    for (const sd of [-1, 1]) {
      st.box(sd * (Wd - 0.3), -0.95, 0, 0.5, 1.5, s2 - s + 0.03, corten);
      st.box(sd * (Wd - 0.3), -0.18, 0, 0.62, 0.08, s2 - s + 0.03, corten2);
    }
    st.box(0, -0.32, 0, Wd * 2 - 0.9, 0.5, s2 - s + 0.03, conc, conc);
    // cross beam every 4 m
    if (Math.round((s - dA) / step) % 2 === 0) st.at(f.x, y - 1.15, f.z, yaw).box(0, 0, 0, Wd * 2 - 0.9, 0.5, 0.35, steel);
  }
  // railings with orange nets
  const netB = new MeshBuilder({ uv: true });
  // (railings run the full bridge section so they join the barriers before and after it)
  for (const sd of [-1, 1]) {
    const vx = sd * (Wd - 0.1);
    let prev = null, ul = 0;
    for (let s = B.s0; s <= B.s1 + 0.01; s += 2) {
      const f = frame(s), y = deckY(s, sd * B.w);
      const px = f.x + f.rx * vx, pz = f.z + f.rz * vx;
      st.at(px, y - 0.1, pz, f.heading).box(0, 0.67, 0, 0.08, 1.35, 0.08, steel);
      if (prev) {
        st.at(0, 0, 0).rod(prev.x, prev.y + 1.22, prev.z, px, y + 1.22, pz, 0.045, 6, steel);
        st.rod(prev.x, prev.y + 0.62, prev.z, px, y + 0.62, pz, 0.03, 5, steel);
        // net panel
        netB.at(0, 0, 0);
        const nx = f.rx * sd, nz = f.rz * sd;
        const i0 = netB.v(prev.x, prev.y + 0.05, prev.z, nx, 0, nz, WHITE, ul, 0.02);
        const i1 = netB.v(px, y + 0.05, pz, nx, 0, nz, WHITE, ul + 2, 0.02);
        const i2 = netB.v(px, y + 1.2, pz, nx, 0, nz, WHITE, ul + 2, 0.5);
        const i3 = netB.v(prev.x, prev.y + 1.2, prev.z, nx, 0, nz, WHITE, ul, 0.5);
        netB.quad(i0, i1, i2, i3);
        ul += 2;
      }
      prev = { x: px, y, z: pz };
    }
  }
  // arch ribs springing from the gorge walls
  const mid = B.mid, fm = frame(mid);
  const crownY = deckY(mid, 0) - 1.9;
  // find the springing distance where the gorge wall is ~55% of the depth below the deck
  const findSpring = (dir) => {
    let best = null;
    for (let r = g.floorHalf + 2; r < B.rim + 4; r += 0.5) {
      const p = T.pointAt(mid + dir * r, 0);
      const gy = world.height(p.x, p.z);
      if (crownY - gy < (crownY - g.floorY) * 0.5) { best = { r, y: gy }; break; }
    }
    return best || { r: B.rim * 0.7, y: crownY - 30 };
  };
  const spA = findSpring(-1), spB = findSpring(1);
  const ribs = [];
  for (const sd of [-1, 1]) {
    const vx = sd * (Wd - 0.9);
    const pts = [];
    const NA = 28;
    for (let k = 0; k <= NA; k++) {
      const t = k / NA; // 0 = spring A, 1 = spring B
      const r = -spA.r + (spA.r + spB.r) * t;
      const yS = spA.y + (spB.y - spA.y) * t;
      const sag = 1 - Math.pow(2 * t - 1, 2); // parabola
      const y = yS + (crownY - (spA.y + spB.y) / 2) * sag + ((spA.y + spB.y) / 2 - yS) * sag;
      const p = T.pointAt(mid + r, vx);
      pts.push({ x: p.x, y, z: p.z, r });
    }
    ribs.push(pts);
    for (let k = 0; k < pts.length - 1; k++) st.at(0, 0, 0).rod(pts[k].x, pts[k].y, pts[k].z, pts[k + 1].x, pts[k + 1].y, pts[k + 1].z, 0.55, 6, corten);
    // springing blocks set into the rock
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const gy = world.height(p.x, p.z);
      st.at(p.x, Math.min(gy, p.y) - 1.2, p.z, fm.heading).box(0, 1.2, 0, 2.6, 3.2, 2.6, conc, conc);
    }
  }
  // columns from the ribs up to the deck, and bracing between the ribs
  for (let k = 2; k < ribs[0].length - 2; k += 2) {
    for (const pts of ribs) {
      const p = pts[k];
      const s = mid + p.r;
      const top = deckY(s, 0) - 1.2;
      if (top - p.y > 0.6) st.at(0, 0, 0).rod(p.x, p.y, p.z, p.x, top, p.z, 0.22, 6, steel);
    }
    const a = ribs[0][k], c = ribs[1][k];
    st.at(0, 0, 0).rod(a.x, a.y + 0.2, a.z, c.x, c.y + 0.2, c.z, 0.2, 5, steel);
  }
  // abutments: concrete blocks at both rims carrying the deck ends
  for (const s of [B.deck0 + 5, B.deck1 - 5]) {
    const f = frame(s);
    const y = deckY(s, 0);
    st.at(f.x, y - 4.2, f.z, f.heading).box(0, 0, 0, Wd * 2 + 1.4, 7.2, 7, conc, snow);
  }
  const mesh = new THREE.Mesh(st.build(), vcMaterial({ roughness: 0.62, metalness: 0.15 }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  group.add(mesh);
  const nets = new THREE.Mesh(netB.build(), mats.net);
  group.add(nets);
}

// ================================================================== FROZEN LAKE
export function buildLake(course, group) {
  const L = course.lake;
  if (!L) return;
  const NA = 160, NR = 14;
  const P = [], E = [], I = [];
  P.push(L.cx, L.level + 0.035, L.cz); E.push(0);
  const radius = [];
  for (let a = 0; a < NA; a++) {
    const ang = (a / NA) * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    // shoreline along this ray (sdf = -0.6 m: keep the ice just inside the flat basin)
    let lo = 0, hi = Math.max(L.a, L.b) * 1.6;
    for (let it = 0; it < 32; it++) { const m = (lo + hi) / 2; if (L.sdf(L.cx + dx * m, L.cz + dz * m) < -0.6) lo = m; else hi = m; }
    radius.push(lo);
    for (let r = 1; r <= NR; r++) {
      const t = Math.pow(r / NR, 0.7);
      const x = L.cx + dx * lo * t, z = L.cz + dz * lo * t;
      P.push(x, L.level + 0.035, z);
      E.push(t);
    }
  }
  for (let a = 0; a < NA; a++) {
    const a2 = (a + 1) % NA;
    const ring = (q, r) => 1 + q * NR + (r - 1);
    I.push(0, ring(a2, 1), ring(a, 1));
    for (let r = 1; r < NR; r++) {
      const p = ring(a, r), q = ring(a, r + 1), p2 = ring(a2, r), q2 = ring(a2, r + 1);
      I.push(p, p2, q, q, p2, q2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(P.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(E, 1));
  geo.setIndex(fixWindingUp(P, I));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, iceLakeMaterial());
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  group.add(mesh);
}

// Glossy lake ice: deep clear ice with frost patches, white cracks with depth, trapped bubbles and
// wind-blown snow toward the shore. Mirror-like sky reflections come from the scene environment.
function iceLakeMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, envMapIntensity: 1.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uNoise = terrainUniforms.uNoise;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aEdge;\nvarying float vEdge;\nvarying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvEdge = aEdge;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D uNoise;
      varying float vEdge;
      varying vec3 vWP;
      float iRough;
      vec4 iN(vec2 p) { return texture2D(uNoise, p * 0.125); }
      vec2 iHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
      // distance to the nearest Voronoi cell border (crack network)
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
        float n1 = iN(vWP.xz * 0.05).r, n2 = iN(vWP.xz * 0.012 + 3.0).a, n3 = iN(vWP.xz * 0.35).r;
        // clear black-blue ice, lighter where it is thinner / frosted
        vec3 deep = vec3(0.025, 0.07, 0.11), clear = vec3(0.07, 0.19, 0.27), frost = vec3(0.74, 0.84, 0.92);
        vec3 c = mix(deep, clear, smoothstep(0.25, 0.75, n2));
        float frostK = smoothstep(0.55, 0.78, n1 * 0.6 + n2 * 0.5) * 0.75;
        // cracks: sharp white lines on the surface + a fainter copy deeper in the ice (parallax)
        float fade = 1.0 - smoothstep(60.0, 260.0, dist);
        vec2 cp = vWP.xz * 0.11;
        float cr = iCracks(cp + (iN(vWP.xz * 0.02).gb - 0.5) * 0.6);
        float crack = (1.0 - smoothstep(0.0, 0.035 + fwidth(cr) * 1.5, cr)) * fade;
        vec2 par = V.xz / max(V.y, 0.25) * 0.09;
        float cr2 = iCracks(cp * 1.7 + 7.3 - par);
        float crackDeep = (1.0 - smoothstep(0.0, 0.05 + fwidth(cr2) * 1.5, cr2)) * fade * 0.55;
        // trapped air bubbles
        vec2 bc = floor(vWP.xz * 3.0); vec2 bh = iHash(bc);
        float bub = step(0.93, bh.x) * (1.0 - smoothstep(0.05, 0.12, length(fract(vWP.xz * 3.0) - bh))) * (1.0 - smoothstep(8.0, 30.0, dist));
        c = mix(c, frost * 0.9, crackDeep);
        c = mix(c, frost, frostK);
        c = mix(c, vec3(0.92, 0.96, 1.0), crack * 0.85 + bub * 0.6);
        // drifted snow toward the shore and in wind streaks
        float drift = smoothstep(0.72, 0.98, vEdge + (n3 - 0.5) * 0.25) + smoothstep(0.62, 0.8, iN(vWP.xz * vec2(0.03, 0.09)).a) * 0.6;
        drift = clamp(drift, 0.0, 1.0);
        c = mix(c, vec3(0.93, 0.95, 0.99), drift);
        diffuseColor.rgb = c;
        iRough = mix(0.04, 0.32, frostK) + crack * 0.2;
        iRough = mix(iRough, 0.8, drift);
      }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = iRough;');
  };
  m.customProgramCacheKey = () => 'parkour-lake-ice';
  return m;
}

// ================================================================== FROZEN WATERFALL
// An ice cascade hanging down the canyon wall: a ribbed curtain of columns following the wall's
// surface, icicle fringes at the lip and a frozen splash mound at the foot.
export function buildWaterfall(course, group, iceMat) {
  const W = course.waterfall, T = course.track;
  if (!W) return;
  const sg = W.side; // -1 = left wall
  const width = 26, rows = 26, cols = 52;
  const rnd = mulberry32(course.def.seed + 811);
  // wall profile at a given s: walk outward from the track edge, find the foot and the lip
  const prof = (s) => {
    const w = T.sAt(T.W, s);
    const pts = [];
    for (let u = 2; u <= 30; u += 0.5) {
      const p = T.pointAt(s, sg * (w + u));
      pts.push({ u, x: p.x, z: p.z, y: world.height(p.x, p.z), nx: -Math.cos(p.heading) * sg, nz: Math.sin(p.heading) * sg });
    }
    // foot = where it starts to rise steeply, lip = where it flattens again
    let foot = pts[0], lip = pts[pts.length - 1];
    for (let k = 1; k < pts.length; k++) if ((pts[k].y - pts[k - 1].y) / 0.5 > 1.2) { foot = pts[k - 1]; break; }
    for (let k = pts.length - 1; k > 0; k--) if ((pts[k].y - pts[k - 1].y) / 0.5 > 1.2) { lip = pts[k]; break; }
    return { pts, foot, lip };
  };
  const P = [], N = [], C = [], I = [];
  const cBlue = tint('#4f9fd6'), cLight = tint('#cdeeff'), cWhite = tint('#f2fbff');
  const colPhase = Array.from({ length: cols + 1 }, () => rnd() * 6.28);
  for (let i = 0; i <= cols; i++) {
    const a = (i / cols - 0.5) * width;
    const s = W.s + a;
    const pr = prof(s);
    const taper = 1 - Math.pow(Math.abs(i / cols - 0.5) * 2, 3);
    for (let j = 0; j <= rows; j++) {
      const t = j / rows; // 0 = lip, 1 = foot
      const y = pr.lip.y + (pr.foot.y - pr.lip.y) * t;
      // point on the wall at that height
      let q = pr.pts[0];
      for (const p of pr.pts) if (p.y <= y) q = p;
      // bulging columns: ribbed across, swelling toward the foot
      const rib = Math.pow(Math.abs(Math.sin(i * 0.9 + colPhase[i] * 0.3)), 0.6);
      const out = (0.35 + 1.4 * rib + 1.6 * t * t + 0.4 * Math.sin(j * 0.7 + colPhase[i])) * taper;
      P.push(q.x - q.nx * out, y - (t > 0.98 ? 0.4 : 0), q.z - q.nz * out);
      N.push(-q.nx, 0.25, -q.nz);
      const c = rib > 0.7 ? cWhite : rib > 0.35 ? cLight : cBlue;
      C.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const a = i * (rows + 1) + j, b = a + 1, c = a + rows + 1, d = c + 1;
    I.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  // orient faces toward the track
  const nrm = geo.attributes.normal;
  const pm = T.pointAt(W.s, 0);
  let dot = 0;
  for (let k = 0; k < nrm.count; k += 17) dot += nrm.getX(k) * (pm.x - P[k * 3]) + nrm.getZ(k) * (pm.z - P[k * 3 + 2]);
  if (dot < 0) {
    const ix = geo.index.array;
    for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; }
    geo.computeVertexNormals();
  }
  geo.computeBoundingSphere();
  const curtain = new THREE.Mesh(geo, iceMat);
  curtain.castShadow = true; curtain.receiveShadow = true;
  group.add(curtain);
  // icicle fringe at the lip and a frozen splash mound at the foot
  const b = new MeshBuilder();
  const prMid = prof(W.s);
  for (let a = -width / 2; a < width / 2; a += 0.35 + rnd() * 0.35) {
    const pr = prof(W.s + a);
    const len = 1 + rnd() * 3.5;
    b.at(pr.lip.x - pr.lip.nx * 0.6, pr.lip.y - len, pr.lip.z - pr.lip.nz * 0.6).cyl(0, 0, 0, 0.0, 0.1 + rnd() * 0.18, len, 5, rnd() > 0.5 ? cLight : cWhite);
  }
  // frozen splash mound at the foot, behind the ice wall and the B-net
  const f = prMid.foot;
  b.at(f.x + f.nx * 0.8, f.y - 0.7, f.z + f.nz * 0.8, Math.atan2(f.nx, f.nz), 0, 0, width * 0.42, 2.2, 2.4);
  b.blob(0, 0, 0, (x, y, z) => 1 + 0.12 * Math.sin(x * 6) * Math.cos(z * 5), 2, (x, y, z, ny) => (ny > 0.5 ? cWhite : cLight));
  const extra = new THREE.Mesh(b.build(), iceMat);
  extra.castShadow = true; extra.receiveShadow = true;
  group.add(extra);
}

// ------------------------------------------------------------------ winding helpers
// flip triangles whose geometric normal disagrees with the stored vertex normals
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
// make every triangle face up (+y): for heightfield-like meshes
function fixWindingUp(P, I) {
  const out = I.slice();
  for (let k = 0; k < out.length; k += 3) {
    const a = out[k] * 3, b = out[k + 1] * 3, c = out[k + 2] * 3;
    const ux = P[b] - P[a], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vz = P[c + 2] - P[a + 2];
    if (uz * vx - ux * vz < 0) { const t = out[k + 1]; out[k + 1] = out[k + 2]; out[k + 2] = t; }
  }
  return out;
}
export { fixWindingUp };
