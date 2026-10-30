// Piste fences: the continuous nets and rope lines along both edges of every free-ride run (planned by
// layout.js planPisteFences; layout.nets entries with fence: true). Tens of kilometres of fence, so it is all
// instanced and streamed round the camera:
//  - B-net fences: the orange race B-net look (the same mesh material as the hazard nets, distance-faded) on dark
//    posts every ~3.5 m, with a hem, a top rope and a low snow drift at the foot (one shared instance matrix per
//    panel: the panel is a unit quad sheared onto its two posts, so it follows the slope);
//  - rope lines: light orange poles every ~6 m with a cord and orange / yellow bunting.
// Meshy models (tools/meshy-piste.mjs, public/models/piste) replace the procedural look once they load:
//  - bnet_panel.glb: a B-net section with its two posts, sheared onto each span exactly like the procedural panel
//    (so it follows the slope); it stands in for the panel, its trim and the B posts;
//  - rope_pole.glb / flag_pole.glb: the rope line's stakes (alternating pennant / flag), turned along the line;
//    the rope spans keep only their cord.
// A model that fails to load (or is over its triangle budget) leaves that part procedural.
// Four draw calls in all (net panels, panel trim, rope spans, posts); none of them casts a shadow. The instances
// live in 256 m cells and only the cells within NET_FAR of the camera are packed into the meshes (repacked
// after the camera moves ~40 m).
// Colliders: one thin soft box per straight stretch of up to 12 m (net: true: the player bounces off, never wipes
// out), bucketed in a 64 m grid. They never enter the shared collider list one by one: a fixed pool of POOL
// box colliders sits in it, refilled with the boxes nearest the camera as it moves, so every system that scans
// the colliders pays for POOL boxes, not thousands.
import * as THREE from 'three';
import { world } from './world.js';
import { meshGround } from '../modes/parkour/kit.js';

const USE_GLB_STAKES = false;
const CELL = 256, FAR = 480, REPACK = 40;
const COL_CELL = 64, COL_R = 70, POOL = 160, REFILL = 4;
export const FENCE_TYPES = {
  B: { post: 3.5, h: 1.6, lean: 0.28, postH: 1.85, postR: 0.034, postCol: '#26282b' },
  R: { post: 6.0, h: 0.95, lean: 0, postH: 1.15, postR: 0.022, postCol: '#ff6a12' },
};

function arcLengths(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return acc;
}

// ---- unit geometries (local x 0..1 along the span, y 0..1 up the panel / to the rope, z metres toward the run)
function quadGeo(rows, cols) { // rows: [[x, y, z, r, g, b, u, v] x4]...
  const p = [], c = [], u = [], idx = [];
  for (const q of rows) {
    const b = p.length / 3;
    for (const v of q) { p.push(v[0], v[1], v[2]); c.push(v[3] ?? 1, v[4] ?? 1, v[5] ?? 1); u.push(v[6] ?? 0, v[7] ?? 0); }
    if (q.length === 4) idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); else idx.push(b, b + 1, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  if (cols) g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
// The catch angle: the net's foot is pulled toward the run in the middle of each span, but its side edges hang
// straight down the posts (a lean that was the same right up to the posts left the net's foot 0.25 m off its
// post, Oct 30, the user: "the ski nets and poles don't connect"). z (m, toward the run) of the net at (x, y):
const NCOL = 8;
const leanW = (x) => Math.min(1, Math.sin(Math.PI * Math.min(1, Math.max(0, x))) * 2.2);
function netZ(x, y, T, type) { return type === 'R' ? 0 : T.lean * leanW(x) * Math.max(0, 1 - y / 0.955); }
function panelGeo() {
  // a 3.5 x 1.6 m panel: one net texture tile is 0.5 m; NCOL columns so the foot can bow out between the posts
  const B = FENCE_TYPES.B, rows = [];
  for (let j = 0; j < NCOL; j++) {
    const x0 = j / NCOL, x1 = (j + 1) / NCOL;
    rows.push([[x0, 0, netZ(x0, 0, B), 1, 1, 1, 7 * x0, 0], [x1, 0, netZ(x1, 0, B), 1, 1, 1, 7 * x1, 0], [x0, 0.955, 0, 1, 1, 1, 7 * x0, 3.05], [x1, 0.955, 0, 1, 1, 1, 7 * x1, 3.05]]);
  }
  return quadGeo(rows, false);
}
// the hem, the top rope and the wind drift banked against the net's foot (toward the run); drift only: under the
// Meshy B-net section (it brings its own hem and rope)
function trimGeo(driftOnly = false) {
  const B = FENCE_TYPES.B, hem = rgb('#e8470f'), rope = rgb('#2b2d30'), snow = rgb('#eef2f7'), snow2 = rgb('#e3e9f2');
  const q = (y0, y1, z0, z1, col) => [[0, y0, z0, ...col], [1, y0, z0, ...col], [0, y1, z1, ...col], [1, y1, z1, ...col]];
  const rows = driftOnly ? [] : [q(0.955, 0.985, 0, 0, hem), q(0.985, 1.005, 0, 0, rope), q(1.005, 1.005, -0.018, 0.018, rope)];
  const prof = [[-0.45, -0.03, snow2], [-0.1, 0.07, snow], [0.25, 0.085, snow], [0.6, -0.03, snow2]];
  for (let j = 0; j < NCOL; j++) {
    const x0 = j / NCOL, x1 = (j + 1) / NCOL, o0 = netZ(x0, 0, B), o1 = netZ(x1, 0, B);
    for (let r = 0; r < prof.length - 1; r++) {
      const [z0, y0, c0] = prof[r], [z1, y1, c1] = prof[r + 1];
      rows.push([[x0, y0, z0 + o0, ...c0], [x1, y0, z0 + o1, ...c0], [x0, y1, z1 + o0, ...c1], [x1, y1, z1 + o1, ...c1]]);
    }
  }
  return quadGeo(rows, true);
}
function ropeGeo(bunting = true) {
  const cord = rgb('#f08a12'), A = rgb('#ff6a12'), Y = rgb('#ffd21f');
  const rows = [
    [[0, 0.985, 0, ...cord], [1, 0.985, 0, ...cord], [0, 1.015, 0, ...cord], [1, 1.015, 0, ...cord]],
    [[0, 1.015, -0.012, ...cord], [1, 1.015, -0.012, ...cord], [0, 1.015, 0.012, ...cord], [1, 1.015, 0.012, ...cord]],
  ];
  for (let k = 0; bunting && k < 9; k++) { // bunting: small pennants hanging off the cord
    const x0 = 0.07 + k * 0.1, col = k % 2 ? Y : A;
    rows.push([[x0, 0.99, 0, ...col], [x0 + 0.04, 0.99, 0, ...col], [x0 + 0.02, 0.83, 0, ...col]]);
  }
  return quadGeo(rows, true);
}
const _up = new THREE.Vector3(0, 1, 0);
// a loaded GLB's meshes as [{ geo, mat }], merged into one frame, the long horizontal side along x and normalised by
// norm(box, size, shaft) (shaft: the centre of the model's lowest 30 %, i.e. a pole's foot); null when missing or
// over maxTris triangles
function glbParts(gltf, dequantize, name, maxTris, norm) {
  if (!gltf) return null;
  const parts = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes.position) return;
    const geo = dequantize(o.geometry);
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    geo.applyMatrix4(o.matrixWorld);
    parts.push({ geo, mat: Array.isArray(o.material) ? o.material[0] : o.material });
  });
  const tris = parts.reduce((s, p) => s + (p.geo.index ? p.geo.index.count : p.geo.attributes.position.count) / 3, 0);
  if (!parts.length || tris > maxTris) { console.warn(`piste fence model ${name}: ${tris} triangles, keeping the procedural look`); return null; }
  const bounds = () => { const b = new THREE.Box3(); for (const p of parts) { p.geo.computeBoundingBox(); b.union(p.geo.boundingBox); } return b; };
  let box = bounds(), size = box.getSize(new THREE.Vector3());
  if (size.z > size.x * 1.05) {
    const r = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    for (const p of parts) p.geo.applyMatrix4(r);
    box = bounds(); size = box.getSize(new THREE.Vector3());
  }
  const shaft = new THREE.Vector3(), y0 = box.min.y + size.y * 0.3;
  let n = 0;
  for (const p of parts) {
    const a = p.geo.attributes.position;
    for (let i = 0; i < a.count; i++) if (a.getY(i) < y0) { shaft.x += a.getX(i); shaft.z += a.getZ(i); n++; }
  }
  if (n) shaft.divideScalar(n); else box.getCenter(shaft);
  // the lowest point of the middle 60 % of its length (a net section: the foot of the net between its posts)
  let midMinY = Infinity;
  for (const p of parts) {
    const a = p.geo.attributes.position;
    for (let i = 0; i < a.count; i++) { const x = (a.getX(i) - box.min.x) / (size.x || 1); if (x > 0.2 && x < 0.8) midMinY = Math.min(midMinY, a.getY(i)); }
  }
  if (!Number.isFinite(midMinY)) midMinY = box.min.y;
  const M = norm(box, size, shaft, midMinY);
  for (const p of parts) { p.geo.applyMatrix4(M); p.geo.computeBoundingSphere(); }
  return parts;
}
// a post at (x, z) on the snow as it is drawn (the 2 m terrain mesh: between its vertices the analytic surface can
// bulge above or sag below it, and a post set on world.height floated up to 1.3 m over cut edges), its foot 0.25 m
// into the snow (deeper where the exact surface drops below the drawn one)
function postAt(x, z, nx, nz) {
  const g = meshGround(x, z);
  return { x, z, g, foot: Math.min(g, world.height(x, z)) - 0.25, nx, nz };
}
function postGeo() {
  const g = new THREE.CylinderGeometry(0.9, 1, 1, 6, 1, false);
  g.translate(0, 0.5, 0);
  return g;
}

// (Node checks) how well one span's net meets its two posts and the snow as drawn: endGap = horizontal distance
// from the net's side edges (foot and top) to the post axes beyond the post radius; footFloat / postFloat = net foot
// / post foot above the drawn snow at the posts; midFloat / midBuried = the net's bottom edge over / under the snow
// between the posts
const _pv = new THREE.Vector3(), NODE = typeof window === 'undefined';
function measureSpan(fs, m, a, b, T, type) {
  const at = (x, y) => _pv.set(x, y, netZ(x, y, T, type)).applyMatrix4(m);
  for (const [x, P] of [[0, a], [1, b]]) for (const y of [0, type === 'R' ? 1 : 0.955]) {
    const q = at(x, y);
    fs.endGap = Math.max(fs.endGap, Math.hypot(q.x - P.x, q.z - P.z) - T.postR);
    if (y === 0 && type !== 'R') fs.footFloat = Math.max(fs.footFloat, q.y - meshGround(q.x, q.z));
  }
  if (type === 'R') return;
  for (let k = 1; k < 8; k++) {
    const q = at(k / 8, 0), d = q.y - meshGround(q.x, q.z);
    fs.midFloat = Math.max(fs.midFloat, d); fs.midBuried = Math.max(fs.midBuried, -d);
  }
}

/**
 * @param {Array} fences layout.nets entries with fence: true ({ type: 'B' | 'R', line: [[x, z, nx, nz]...] })
 * @param {{ netMaterial: THREE.Material }} o the B-net mesh material (resortdressing.js: distance-faded)
 * @returns {{ group, colliders (the pool, to add to the shared list), update(cam), stats }}
 */
export function buildPisteFences(fences, { netMaterial } = {}) {
  const group = new THREE.Group();
  group.name = 'piste-fences';
  const cells = new Map(), colGrid = new Map();
  const stats = { fences: 0, B: 0, R: 0, length: 0, panels: 0, ropes: 0, posts: 0, colliders: 0, cells: 0, drawCalls: 4, pool: POOL, perFence: [] };
  const cellAt = (x, z) => {
    const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
    let c = cells.get(k);
    if (!c) {
      cells.set(k, (c = { cx: (Math.floor(x / CELL) + 0.5) * CELL, cz: (Math.floor(z / CELL) + 0.5) * CELL,
        panel: [], rope: [], postB: [], postBCol: [], postR: [], postRCol: [], poleA: [], poleB: [] }));
    }
    return c;
  };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), sv = new THREE.Vector3();
  const colB = rgb(FENCE_TYPES.B.postCol), colR = rgb(FENCE_TYPES.R.postCol), colW = rgb('#f4f4f2');
  for (const f of fences) {
    const T = FENCE_TYPES[f.type] || FENCE_TYPES.B;
    const line = f.line;
    if (!line || line.length < 2) continue;
    const pts = line.map((p) => [p[0], p[1]]), acc = arcLengths(pts), L = acc.at(-1);
    if (L < 3) continue;
    stats.fences++; stats[f.type === 'R' ? 'R' : 'B']++; stats.length += L;
    const fs = { owner: f.owner, type: f.type, side: f.side, endGap: 0, footFloat: 0, postFloat: 0, midFloat: 0, midBuried: 0 };
    stats.perFence.push(fs);
    const n = Math.max(1, Math.round(L / T.post)), posts = [];
    let i = 1;
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * L;
      while (i < line.length - 1 && acc[i] < s) i++;
      const a = line[i - 1], b = line[i], t = Math.min(1, Math.max(0, (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1)));
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      posts.push(postAt(x, z, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t));
    }
    // an extra post wherever the drawn snow between two posts leaves the straight line between their feet by more
    // than 0.15 m (a bump, a berm, a dip), so the net's foot (and the rope) keeps to the snow
    for (let k = 1; k < posts.length; k++) {
      const a = posts[k - 1], b = posts[k], len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1.2) continue;
      let dev = 0;
      for (let t = 0.125; t < 1; t += 0.125) dev = Math.max(dev, Math.abs(meshGround(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) - (a.g + (b.g - a.g) * t)));
      if (dev > 0.15) { posts.splice(k, 0, postAt((a.x + b.x) / 2, (a.z + b.z) / 2, (a.nx + b.nx) / 2, (a.nz + b.nz) / 2)); k--; }
    }
    fs.ends = [[posts[0].x, posts[0].z], [posts.at(-1).x, posts.at(-1).z]];
    for (const p of posts) fs.postFloat = Math.max(fs.postFloat, p.foot - meshGround(p.x, p.z));
    // posts (planted 0.25 m into the snow); the rope line's poles alternate orange / white
    // (the Meshy stakes: turned along the line, uniformly scaled to the post height, a little jitter)
    posts.forEach((p, k) => {
      const c = cellAt(p.x, p.z);
      m.compose(pv.set(p.x, p.foot, p.z), q.identity(), sv.set(T.postR, p.g + T.postH - p.foot, T.postR));
      if (f.type === 'R') {
        c.postR.push(...m.elements);
        c.postRCol.push(...(k % 2 ? colW : colR));
        const a = posts[Math.max(0, k - 1)], b = posts[Math.min(posts.length - 1, k + 1)];
        q.setFromAxisAngle(_up, Math.atan2(-(b.z - a.z), b.x - a.x) + ((k * 7) % 5 - 2) * 0.06);
        const H = p.g + T.postH - p.foot;
        m.compose(pv, q, sv.set(H, H, H));
        (k % 2 ? c.poleB : c.poleA).push(...m.elements);
      } else {
        c.postB.push(...m.elements);
        c.postBCol.push(...colB);
      }
      stats.posts++;
    });
    // spans: the unit panel stretched onto posts a -> b (its foot bowed toward the run between them, netZ)
    for (let k = 1; k < posts.length; k++) {
      const a = posts[k - 1], b = posts[k];
      let nx = a.nx + b.nx, nz = a.nz + b.nz;
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-3) { const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1; nx = -(b.z - a.z) / dl; nz = (b.x - a.x) / dl; } else { nx /= nl; nz /= nl; }
      const base = f.type === 'R' ? 0 : 0.05;
      // the bow (scales local z: the foot's catch angle and the drift with it): as much as the cross slope allows
      // with the foot still within 12 cm of the drawn snow (on a steep side slope it closes up toward the posts)
      let bow = 1;
      if (f.type !== 'R') {
        let best = Infinity;
        for (const sc of [1, 0.7, 0.45, 0.25, 0]) {
          let dev = 0;
          for (const t of [0.25, 0.5, 0.75]) {
            const o = T.lean * leanW(t) * sc;
            dev = Math.max(dev, Math.abs(a.g + (b.g - a.g) * t + base - meshGround(a.x + (b.x - a.x) * t + nx * o, a.z + (b.z - a.z) * t + nz * o)));
          }
          if (dev < best - 0.02) { best = dev; bow = sc; }
          if (dev <= 0.12) break;
        }
      }
      m.set(
        b.x - a.x, 0, nx * bow, a.x,
        b.g - a.g, T.h, 0, a.g + base,
        b.z - a.z, 0, nz * bow, a.z,
        0, 0, 0, 1,
      );
      const c = cellAt((a.x + b.x) / 2, (a.z + b.z) / 2);
      if (f.type === 'R') { c.rope.push(...m.elements); stats.ropes++; } else { c.panel.push(...m.elements); stats.panels++; }
      if (NODE) measureSpan(fs, m, a, b, T, f.type);
    }
    // colliders: one thin box per straight stretch of up to ~12 m
    for (let a0 = 0; a0 < posts.length - 1;) {
      let j = a0 + 1;
      while (j + 1 < posts.length) {
        const a = posts[a0], b = posts[j + 1], l = Math.hypot(b.x - a.x, b.z - a.z);
        if (l > 12) break;
        let dev = 0;
        for (let k = a0 + 1; k <= j; k++) dev = Math.max(dev, Math.abs(((posts[k].x - a.x) * (b.z - a.z) - (posts[k].z - a.z) * (b.x - a.x)) / (l || 1)));
        if (dev > 0.3) break;
        j++;
      }
      const a = posts[a0], b = posts[j], len = Math.hypot(b.x - a.x, b.z - a.z);
      const box = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, hw: len / 2 + 0.05, hd: 0.3, rot: -Math.atan2(-(b.z - a.z), b.x - a.x) };
      const k = Math.floor(box.x / COL_CELL) + ',' + Math.floor(box.z / COL_CELL);
      if (!colGrid.has(k)) colGrid.set(k, []);
      colGrid.get(k).push(box);
      stats.colliders++;
      a0 = j;
    }
  }
  stats.cells = cells.size;
  const KEYS = ['panel', 'rope', 'postB', 'postBCol', 'postR', 'postRCol', 'poleA', 'poleB'];
  for (const c of cells.values()) for (const k of KEYS) c[k] = new Float32Array(c[k]);

  // ---- the four instanced meshes (capacity: every instance; only the cells near the camera are packed)
  const tot = { panel: 0, rope: 0, postB: 0, postR: 0, poleA: 0, poleB: 0 };
  for (const c of cells.values()) for (const k in tot) tot[k] += c[k].length / 16;
  tot.post = tot.postB + tot.postR;
  const trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, side: THREE.DoubleSide });
  const postMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const mk = (geo, mat, cap, name) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
    im.name = name; im.count = 0; im.frustumCulled = false; // (it is all round the camera anyway)
    im.castShadow = false; im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(im);
    return im;
  };
  const panel = mk(panelGeo(), netMaterial || new THREE.MeshStandardMaterial({ color: '#ff5d17', side: THREE.DoubleSide }), tot.panel, 'fence-net');
  const trim = mk(trimGeo(), trimMat, tot.panel, 'fence-trim');
  trim.instanceMatrix = panel.instanceMatrix; // (the same spans: one matrix buffer for both)
  const rope = mk(ropeGeo(), trimMat, tot.rope, 'fence-rope');
  const post = mk(postGeo(), postMat, tot.post, 'fence-posts');
  post.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, tot.post) * 3), 3);
  post.instanceColor.setUsage(THREE.DynamicDrawUsage);

  // the Meshy models (set once loaded): glb.panel: [InstancedMesh] sharing panel.instanceMatrix; glb.poleA / poleB:
  // [InstancedMesh] sharing their own matrix buffer
  const glb = { panel: null, poleA: null, poleB: null };
  const glbPoles = () => !!(glb.poleA && glb.poleB);

  let packX = Infinity, packZ = Infinity;
  const pack = (x, z) => {
    packX = x; packZ = z;
    let np = 0, nr = 0, nq = 0, na = 0, nb = 0;
    const R = FAR + REPACK, poles = glbPoles();
    const pa = glb.poleA?.[0].instanceMatrix.array, pb = glb.poleB?.[0].instanceMatrix.array;
    const addPosts = (mat, col) => {
      if (!mat.length) return;
      post.instanceMatrix.array.set(mat, nq * 16); post.instanceColor.array.set(col, nq * 3); nq += mat.length / 16;
    };
    for (const c of cells.values()) {
      if (Math.hypot(Math.max(0, Math.abs(c.cx - x) - CELL / 2), Math.max(0, Math.abs(c.cz - z) - CELL / 2)) > R) continue;
      if (c.panel.length) { panel.instanceMatrix.array.set(c.panel, np * 16); np += c.panel.length / 16; }
      if (c.rope.length) { rope.instanceMatrix.array.set(c.rope, nr * 16); nr += c.rope.length / 16; }
      if (!glb.panel) addPosts(c.postB, c.postBCol); // (the Meshy B-net section brings its own posts)
      if (!poles) addPosts(c.postR, c.postRCol);
      else {
        if (c.poleA.length) { pa.set(c.poleA, na * 16); na += c.poleA.length / 16; }
        if (c.poleB.length) { pb.set(c.poleB, nb * 16); nb += c.poleB.length / 16; }
      }
    }
    panel.count = trim.count = np; rope.count = nr; post.count = nq;
    const up = [[panel.instanceMatrix, np, 16], [rope.instanceMatrix, nr, 16], [post.instanceMatrix, nq, 16], [post.instanceColor, nq, 3]];
    for (const im of glb.panel || []) im.count = np;
    if (poles) {
      for (const im of glb.poleA) im.count = na;
      for (const im of glb.poleB) im.count = nb;
      up.push([glb.poleA[0].instanceMatrix, na, 16], [glb.poleB[0].instanceMatrix, nb, 16]);
    }
    // (upload only the packed part of each buffer)
    for (const [attr, cnt, size] of up) {
      attr.clearUpdateRanges?.();
      attr.addUpdateRange?.(0, Math.max(1, cnt) * size);
      attr.needsUpdate = true;
    }
    stats.packed = { panels: np, ropes: nr, posts: nq, poles: na + nb };
  };

  // ---- swap in the Meshy models (browser only; Node checks keep the procedural meshes)
  const useGLBs = ({ loadGLB, dequantize }) => Promise.all([
    loadGLB('piste/bnet_panel'), USE_GLB_STAKES ? loadGLB('piste/rope_pole') : null, USE_GLB_STAKES ? loadGLB('piste/flag_pole') : null,
  ]).then(([gPanel, gRope, gFlag]) => {
    const B = FENCE_TYPES.B;
    // the section: x 0..1 across the span (its posts at the span's ends), y in units of the net height; scaled so
    // the foot of its net (netY: it hangs from 30 % of the model's height) reaches the snow (2 cm over it) and its
    // posts' tops stand B.postH over the snow, the posts running on down into it; z in metres toward the run
    const panelParts = glbParts(gPanel, dequantize, 'panel', 600, (box, size, shaft, netY) => {
      const bot = -0.03, top = B.postH - 0.05, k = (top - bot) / Math.max(1e-6, box.max.y - netY);
      return new THREE.Matrix4().makeTranslation(0, bot / B.h, 0)
        .multiply(new THREE.Matrix4().makeScale(1 / size.x, k / B.h, k))
        .multiply(new THREE.Matrix4().makeTranslation(-box.min.x, -netY, -(box.min.z + box.max.z) / 2));
    });
    if (panelParts) {
      glb.panel = panelParts.map((p, i) => {
        p.mat.side = THREE.DoubleSide;
        const im = mk(p.geo, p.mat, 1, 'fence-net-glb' + (i || ''));
        im.instanceMatrix = panel.instanceMatrix;
        return im;
      });
      panel.visible = false;
      trim.geometry.dispose();
      trim.geometry = trimGeo(true); // (the drift stays: the section brings its own hem and rope)
    }
    // the stakes: height 1 (the instance scales it to the post height), centred on the shaft
    const stake = (g, name) => {
      const parts = glbParts(g, dequantize, name, 300, (box, size, shaft) => new THREE.Matrix4()
        .makeScale(1 / size.y, 1 / size.y, 1 / size.y)
        .multiply(new THREE.Matrix4().makeTranslation(-shaft.x, -box.min.y, -shaft.z)));
      if (!parts) return null;
      const cap = Math.max(1, tot[name]);
      const buf = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      buf.setUsage(THREE.DynamicDrawUsage);
      return parts.map((p, i) => { const im = mk(p.geo, p.mat, 1, 'fence-stake-' + name + (i || '')); im.instanceMatrix = buf; return im; });
    };
    // (off: the Meshy stakes lost their shafts in the simplify, so their flags floated beside the rope, Oct 29, the
    // user: "these models are not attached"; the procedural poles and bunting stay)
    const a = USE_GLB_STAKES ? stake(gRope, 'poleA') : null, b = a && stake(gFlag, 'poleB');
    if (a && b) {
      glb.poleA = a; glb.poleB = b;
      rope.geometry.dispose();
      rope.geometry = ropeGeo(false); // (the stakes carry the flags: the cord alone)
    } else for (const im of [...(a || []), ...(b || [])]) group.remove(im);
    stats.glb = { panel: !!glb.panel, poles: glbPoles() };
    stats.drawCalls = group.children.filter((o) => o.visible).length;
    if (Number.isFinite(packX)) pack(packX, packZ);
  });
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    import('../core/assets.js').then(useGLBs).catch((e) => console.warn('piste fence models', e));
  }

  // ---- the collider pool
  const pool = [];
  for (let k = 0; k < POOL; k++) pool.push({ x: 1e9, z: 1e9, hw: 0.05, hd: 0.05, rot: 0, net: true, fence: true });
  let colX = Infinity, colZ = Infinity;
  const near = [];
  const refill = (x, z) => {
    colX = x; colZ = z;
    near.length = 0;
    const r = Math.ceil(COL_R / COL_CELL), cx = Math.floor(x / COL_CELL), cz = Math.floor(z / COL_CELL);
    for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) {
      const arr = colGrid.get(i + ',' + j);
      if (!arr) continue;
      for (const b of arr) { const d = Math.hypot(b.x - x, b.z - z) - b.hw; if (d < COL_R) near.push([d, b]); }
    }
    if (near.length > POOL) near.sort((u, v) => u[0] - v[0]);
    for (let k = 0; k < POOL; k++) {
      const c = pool[k], b = near[k]?.[1];
      if (b) { c.x = b.x; c.z = b.z; c.hw = b.hw; c.hd = b.hd; c.rot = b.rot; } else { c.x = c.z = 1e9; c.hw = c.hd = 0.05; }
    }
    return near.length;
  };

  const update = (cam) => {
    if (!cam) return;
    if (Math.hypot(cam.x - packX, cam.z - packZ) > REPACK) pack(cam.x, cam.z);
    if (Math.hypot(cam.x - colX, cam.z - colZ) > REFILL) refill(cam.x, cam.z);
  };
  // the boxes near (x, z) (Node checks / debugging)
  const boxesNear = (x, z) => { refill(x, z); return near.map((e) => e[1]); };
  return { group, colliders: pool, update, stats, boxesNear, colGrid, meshes: { panel, trim, rope, post } };
}
