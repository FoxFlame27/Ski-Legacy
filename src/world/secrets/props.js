// Small in-world hints and dressing for the secrets, all procedural and weathered: an old wooden arrow sign on a
// post, a sagging rope line on stakes, an oil lantern on a post (it glows at dusk), a cairn of stacked stones and
// faint old ski tracks in the snow. Placed on the snow as the terrain renders it (meshGround).
import * as THREE from 'three';
import { MeshBuilder, tint, canvasTexture, meshGround } from '../../modes/parkour/kit.js';
import { mulberry32, Simplex } from '../../core/noise.js';
import { woodTexture, lanternGlass, boardMaterial, lanternModel } from './tunnel.js';
import { lampPost, lanternMaterial } from '../meshylights.js';
import { sharedMaterial } from './slice.js';
import { fitModel } from '../../core/assets.js';

const NZ = new Simplex(6603);
const MAT = {
  wood: () => sharedMaterial('prop-wood', () => new THREE.MeshStandardMaterial({ map: woodTexture(), vertexColors: true, roughness: 0.88, metalness: 0 })),
  iron: () => sharedMaterial('portal-iron', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 })),
  stone: () => sharedMaterial('prop-stone', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 })),
  rope: () => sharedMaterial('prop-rope', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })),
  snowTrim: () => sharedMaterial('snow-trim', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 })),
  tracks: () => sharedMaterial('tracks-multiply', () => new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.MultiplyBlending, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
};
export function propMaterials() { for (const k in MAT) MAT[k](); }

/**
 * A weathered wooden arrow sign on a post: carved, faded lettering on a plank whose pointed end shows the way.
 * yaw = the direction the arrow points (radians, atan2(dx, dz)); text: one or two lines. pole: the Meshy signpost
 * (sign_pole.glb) to carry it, else a plain timber post.
 */
export function oldSign(x, z, yaw, text, { sub = '', w = 1.5, h = 0.34, postH = 1.55, seed = 1, lean = 0.05, pole = null } = {}) {
  const g = new THREE.Group();
  const y = meshGround(x, z);
  g.position.set(x, y, z);
  // the plank faces across the way it points
  g.rotation.set(0, yaw - Math.PI / 2, 0);
  const rnd = mulberry32(seed * 911 + 5);
  const lx = lean * (rnd() - 0.5), lz = lean * (rnd() - 0.3);
  if (pole) {
    // the Meshy larch signpost (its metal cap on top), 12 cm thick, its foot in the snow
    const m = fitModel(pole, { size: postH + 0.3, axis: 'y' });
    const k = 0.12 / Math.max(0.05, m.userData.size.x, m.userData.size.z);
    m.scale.set(k, 1, k);
    m.position.y = -0.22;
    m.rotation.set(lx, 0, lz);
    m.traverse((q) => { if (q.isMesh) { q.castShadow = true; q.receiveShadow = true; q.userData.secretKeep = true; } });
    g.add(m);
  } else {
    const b = new MeshBuilder({ uv: true });
    b.at(0, 0, 0, 0, lx, lz).box(0, postH / 2 - 0.2, 0, 0.11, postH + 0.4, 0.11, tint('#ffffff', 0.12, seed));
    const post = new THREE.Mesh(b.build(), MAT.wood());
    post.castShadow = true;
    g.add(post);
  }
  // plank: a pointed board (arrow) with carved letters, the paint mostly gone
  const shape = new THREE.Shape();
  const L = w, H = h, tip = H * 0.75;
  shape.moveTo(-L / 2, -H / 2); shape.lineTo(L / 2 - tip, -H / 2); shape.lineTo(L / 2, 0); shape.lineTo(L / 2 - tip, H / 2); shape.lineTo(-L / 2, H / 2); shape.lineTo(-L / 2, -H / 2);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: false });
  geo.translate(0, 0, -0.0175);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + L / 2) / L, (uv.getY(i) + H / 2) / H);
  const tex = canvasTexture(512, Math.round(512 * H / L), (c, cw, ch) => {
    c.fillStyle = '#7a5634'; c.fillRect(0, 0, cw, ch);
    const r = mulberry32(seed * 3 + 1);
    for (let i = 0; i < 70; i++) { c.fillStyle = `rgba(${r() < 0.5 ? '40,24,12' : '170,130,90'},${0.08 + r() * 0.22})`; c.fillRect(0, r() * ch, cw, 0.8 + r() * 2.4); }
    for (let i = 0; i < 26; i++) { c.fillStyle = `rgba(230,235,240,${0.05 + r() * 0.12})`; c.fillRect(r() * cw, r() * ch, 6 + r() * 40, 2 + r() * 6); } // weathering
    c.textAlign = 'left'; c.textBaseline = 'middle';
    const fs = Math.round(ch * (sub ? 0.38 : 0.5));
    c.font = `700 ${fs}px Georgia, "Times New Roman", serif`;
    const tx = cw * 0.07;
    // carved: dark groove + light lower edge, faded paint
    const line = (t, yy, f) => {
      c.font = f;
      c.fillStyle = 'rgba(28,16,8,0.85)'; c.fillText(t, tx, yy);
      c.fillStyle = 'rgba(235,220,190,0.35)'; c.fillText(t, tx + 1, yy + 2);
    };
    line(text, sub ? ch * 0.36 : ch * 0.53, `700 ${fs}px Georgia, "Times New Roman", serif`);
    if (sub) line(sub, ch * 0.74, `italic 600 ${Math.round(ch * 0.24)}px Georgia, serif`);
  });
  const plank = new THREE.Mesh(geo, boardMaterial(tex));
  plank.position.set(0.02, postH - 0.15, pole ? 0.09 : 0.08);
  plank.rotation.z = (rnd() - 0.5) * 0.08;
  plank.castShadow = true;
  g.add(plank);
  // a little snow on the plank's top edge
  const sb = new MeshBuilder();
  sb.at(0.02 - 0.08, postH - 0.15 + H / 2 + 0.02, 0.08).box(0, 0, 0, L - tip - 0.1, 0.04, 0.05, tint('#eef3f8'));
  g.add(new THREE.Mesh(sb.build(), MAT.snowTrim()));
  g.userData.colliders = [{ x, z, r: 0.25 }];
  return g;
}

/** an old fixed rope along a line: leaning wooden stakes every ~6 m, a sagging hemp rope between them */
export function ropeLine(points, { seed = 1, h = 0.95, spacing = 6 } = {}) {
  const rnd = mulberry32(seed * 13 + 7);
  const sb = new MeshBuilder({ uv: true }), rb = new MeshBuilder();
  const stakes = [];
  // resample the line every `spacing` m
  let acc = 0;
  stakes.push(points[0]);
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i], l = Math.hypot(bx - ax, bz - az);
    let t = spacing - acc;
    while (t <= l) { stakes.push([ax + (bx - ax) * t / l, az + (bz - az) * t / l]); t += spacing; }
    acc = l - (t - spacing);
  }
  const tops = stakes.map(([x, z], i) => {
    const y = meshGround(x, z), lean = (rnd() - 0.5) * 0.16, hh = h * (0.85 + rnd() * 0.3);
    sb.at(x, y - 0.3, z, rnd() * 6, lean, (rnd() - 0.5) * 0.16).box(0, (hh + 0.3) / 2, 0, 0.07, hh + 0.3, 0.07, tint('#ffffff', 0.15, i + seed));
    return [x + Math.sin(lean) * 0.3, y + hh - 0.06, z];
  });
  for (let i = 1; i < tops.length; i++) {
    const a = tops[i - 1], b = tops[i];
    const n = 6;
    let prev = a;
    for (let k = 1; k <= n; k++) {
      const t = k / n, sag = Math.sin(t * Math.PI) * 0.22;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag, a[2] + (b[2] - a[2]) * t];
      rb.at(0, 0, 0).rod(prev[0], prev[1], prev[2], p[0], p[1], p[2], 0.016, 4, tint('#9a8466', 0.1, i));
      prev = p;
    }
  }
  const g = new THREE.Group();
  const stakesM = new THREE.Mesh(sb.build(), MAT.wood()); stakesM.castShadow = true;
  g.add(stakesM, new THREE.Mesh(rb.build(), MAT.rope()));
  g.userData.colliders = stakes.map(([x, z]) => ({ x, z, r: 0.12, soft: true }));
  return g;
}

/** an oil lantern on a short post: the Meshy lamp post 2.6 m tall (its lantern toward +z), else a built one */
export function lanternPost(x, z, { h = 1.7, seed = 1 } = {}) {
  const y = meshGround(x, z);
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const gltf = lanternModel(), post = gltf && lampPost(gltf, 2.6);
  if (post) {
    g.position.y = y - 0.06; // (its foot just into the snow)
    const lamp = new THREE.Mesh(post.geometry, lanternMaterial(gltf, post, { color: [1.0, 0.62, 0.3], intensity: 3.5 }));
    lamp.castShadow = true; lamp.receiveShadow = true;
    lamp.name = 'secret-lantern-glass'; // (the runtime flickers its glass)
    lamp.userData.secretKeep = true;    // (the shared lamp post geometry)
    g.add(lamp);
    g.userData.lantern = lamp;
    g.userData.colliders = [{ x, z, r: 0.2 }];
    return g;
  }
  const b = new MeshBuilder({ uv: true });
  b.at(0, 0, 0).box(0, h / 2 - 0.2, 0, 0.12, h + 0.4, 0.12, tint('#ffffff', 0.1, seed));
  b.at(0, h - 0.05, 0).box(0.22, 0, 0, 0.5, 0.08, 0.08, tint('#ffffff', 0.1, seed + 1));
  g.add(Object.assign(new THREE.Mesh(b.build(), MAT.wood()), { castShadow: true }));
  const ib = new MeshBuilder();
  ib.at(0.42, h - 0.32, 0).box(0, 0.24, 0, 0.24, 0.05, 0.24, tint('#1b1c1f')).box(0, -0.16, 0, 0.26, 0.04, 0.26, tint('#1b1c1f')).rod(0, 0.26, 0, 0, 0.27, 0, 0.01, 3, tint('#1b1c1f'));
  ib.at(0.42, h - 0.32, 0).rod(0, 0.27, 0, 0, 0.31, 0, 0.012, 4, tint('#1b1c1f'));
  g.add(new THREE.Mesh(ib.build(), MAT.iron()));
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.34, 0.18), lanternGlass(3.5));
  glass.position.set(0.42, h - 0.29, 0);
  glass.name = 'secret-lantern-glass';
  g.add(glass);
  g.userData.lantern = glass;
  g.userData.colliders = [{ x, z, r: 0.2 }];
  return g;
}

/** a cairn: 5-7 flat stones stacked, a dusting of snow on top */
export function cairn(x, z, { seed = 1, size = 1 } = {}) {
  const rnd = mulberry32(seed * 41 + 3);
  const y = meshGround(x, z);
  const b = new MeshBuilder();
  let h = -0.12 * size;
  const n = 5 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const r = (0.48 - i * 0.055) * size * (0.85 + rnd() * 0.3), th = r * (0.45 + rnd() * 0.2);
    const ox = (rnd() - 0.5) * 0.08 * size, oz = (rnd() - 0.5) * 0.08 * size;
    const c = tint('#6f6d6a', 0.18, i + seed * 7);
    const a = r, bb = th / 2;
    b.blob(x + ox, y + h + th * 0.5, z + oz, (nx, ny, nz) => {
      const k = 1 + NZ.noise(nx * 2.1 + i, nz * 2.1 + seed) * 0.2;
      return k / Math.sqrt((nx * nx + nz * nz) / (a * a) + (ny * ny) / (bb * bb));
    }, 1, (px, py, pz, ny) => (ny > 0.75 && i === n - 1 ? tint('#e9eef4') : c));
    h += th * 0.9;
  }
  const m = new THREE.Mesh(b.build(), MAT.stone());
  m.castShadow = true; m.receiveShadow = true;
  m.userData.colliders = [{ x, z, r: 0.45 * size, top: y + h }];
  return m;
}

/**
 * Faint old ski tracks along a line: two shallow, wind-softened grooves (a multiply decal on the snow), fading in
 * and out; `wander` lets them weave like a real line through powder.
 */
export function oldTracks(points, { seed = 1, wander = 1.2, width = 0.13, gap = 0.22, strength = 0.82 } = {}) {
  const P = [], C = [], I = [];
  // dense resample (1 m)
  const pts = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  const N = pts.length;
  for (const side of [-1, 1]) {
    const base = P.length / 3;
    for (let i = 0; i < N; i++) {
      const [x, z] = pts[i], [px, pz] = pts[Math.max(0, i - 1)], [qx, qz] = pts[Math.min(N - 1, i + 1)];
      const dx = qx - px, dz = qz - pz, l = Math.hypot(dx, dz) || 1, rx = -dz / l, rz = dx / l;
      const wob = NZ.noise(i * 0.045 + seed, 3.3) * wander;
      const fade = Math.min(1, i / 12, (N - 1 - i) / 12) * (0.75 + 0.25 * NZ.noise(i * 0.11, seed * 1.7));
      // three vertices across each groove: untouched snow at its edges, a soft blue-grey shade in the middle
      for (const e of [-1, 0, 1]) {
        const off = wob + side * gap + e * width;
        const X = x + rx * off, Z = z + rz * off;
        P.push(X, meshGround(X, Z) + 0.025, Z);
        const k = e ? 1 : 1 - (1 - strength) * fade;
        C.push(k * 0.97 + (e ? 0.03 : 0), k * 0.985 + (e ? 0.015 : 0), 1);
      }
      if (i) {
        const a = base + (i - 1) * 3;
        I.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, MAT.tracks());
  m.renderOrder = 2;
  m.name = 'secret-old-tracks';
  return m;
}
