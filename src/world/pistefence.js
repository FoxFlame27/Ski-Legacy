// Piste fences: the continuous nets and rope lines along both edges of every free-ride run (planned by
// layout.js planPisteFences; layout.nets entries with fence: true). Tens of kilometres of fence, so it is all
// instanced and streamed round the camera:
//  - B-net fences: the orange race B-net look (the same mesh material as the hazard nets, distance-faded) on dark
//    posts every ~3.5 m, with a hem, a top rope and a low snow drift at the foot (one shared instance matrix per
//    panel: the panel is a unit quad sheared onto its two posts, so it follows the slope);
//  - rope lines: light orange poles every ~6 m with a cord and orange / yellow bunting.
// Four draw calls in all (net panels, panel trim, rope spans, posts); none of them casts a shadow. The instances
// live in 256 m cells and only the cells within NET_FAR of the camera are packed into the meshes (repacked
// after the camera moves ~40 m).
// Colliders: one thin soft box per straight stretch of up to 12 m (net: true: the player bounces off, never wipes
// out), bucketed in a 64 m grid. They never enter the shared collider list one by one: a fixed pool of POOL
// box colliders sits in it, refilled with the boxes nearest the camera as it moves, so every system that scans
// the colliders pays for POOL boxes, not thousands.
import * as THREE from 'three';
import { world } from './world.js';

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
function panelGeo() {
  // a 3.5 x 1.6 m panel: one net texture tile is 0.5 m
  return quadGeo([[[0, 0, 0, 1, 1, 1, 0, 0], [1, 0, 0, 1, 1, 1, 7, 0], [0, 0.955, 0, 1, 1, 1, 0, 3.05], [1, 0.955, 0, 1, 1, 1, 7, 3.05]]], false);
}
function trimGeo() {
  const hem = rgb('#e8470f'), rope = rgb('#2b2d30'), snow = rgb('#eef2f7'), snow2 = rgb('#e3e9f2');
  const q = (y0, y1, z0, z1, col) => [[0, y0, z0, ...col], [1, y0, z0, ...col], [0, y1, z1, ...col], [1, y1, z1, ...col]];
  const rows = [q(0.955, 0.985, 0, 0, hem), q(0.985, 1.005, 0, 0, rope), q(1.005, 1.005, -0.018, 0.018, rope)];
  // the wind drift banked against the foot (toward the run)
  const prof = [[-0.45, -0.03, snow2], [-0.1, 0.07, snow], [0.25, 0.085, snow], [0.6, -0.03, snow2]];
  for (let r = 0; r < prof.length - 1; r++) {
    const [z0, y0, c0] = prof[r], [z1, y1, c1] = prof[r + 1];
    rows.push([[0, y0, z0, ...c0], [1, y0, z0, ...c0], [0, y1, z1, ...c1], [1, y1, z1, ...c1]]);
  }
  return quadGeo(rows, true);
}
function ropeGeo() {
  const cord = rgb('#f08a12'), A = rgb('#ff6a12'), Y = rgb('#ffd21f');
  const rows = [
    [[0, 0.985, 0, ...cord], [1, 0.985, 0, ...cord], [0, 1.015, 0, ...cord], [1, 1.015, 0, ...cord]],
    [[0, 1.015, -0.012, ...cord], [1, 1.015, -0.012, ...cord], [0, 1.015, 0.012, ...cord], [1, 1.015, 0.012, ...cord]],
  ];
  for (let k = 0; k < 9; k++) { // bunting: small pennants hanging off the cord
    const x0 = 0.07 + k * 0.1, col = k % 2 ? Y : A;
    rows.push([[x0, 0.99, 0, ...col], [x0 + 0.04, 0.99, 0, ...col], [x0 + 0.02, 0.83, 0, ...col]]);
  }
  return quadGeo(rows, true);
}
function postGeo() {
  const g = new THREE.CylinderGeometry(0.9, 1, 1, 6, 1, false);
  g.translate(0, 0.5, 0);
  return g;
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
  const stats = { fences: 0, B: 0, R: 0, length: 0, panels: 0, ropes: 0, posts: 0, colliders: 0, cells: 0, drawCalls: 4, pool: POOL };
  const cellAt = (x, z) => {
    const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { cx: (Math.floor(x / CELL) + 0.5) * CELL, cz: (Math.floor(z / CELL) + 0.5) * CELL, panel: [], rope: [], post: [], postCol: [] }));
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
    const n = Math.max(1, Math.round(L / T.post)), posts = [];
    let i = 1;
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * L;
      while (i < line.length - 1 && acc[i] < s) i++;
      const a = line[i - 1], b = line[i], t = Math.min(1, Math.max(0, (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1)));
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      posts.push({ x, z, g: world.height(x, z), nx: a[2] + (b[2] - a[2]) * t, nz: a[3] + (b[3] - a[3]) * t });
    }
    // posts (planted 0.25 m into the snow); the rope line's poles alternate orange / white
    posts.forEach((p, k) => {
      const c = cellAt(p.x, p.z);
      m.compose(pv.set(p.x, p.g - 0.25, p.z), q.identity(), sv.set(T.postR, T.postH + 0.25, T.postR));
      c.post.push(...m.elements);
      c.postCol.push(...(f.type === 'R' ? (k % 2 ? colW : colR) : colB));
      stats.posts++;
    });
    // spans: a unit quad sheared onto posts a -> b (bottom pulled toward the run by the catch angle)
    for (let k = 1; k < posts.length; k++) {
      const a = posts[k - 1], b = posts[k];
      let nx = a.nx + b.nx, nz = a.nz + b.nz;
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-3) { const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1; nx = -(b.z - a.z) / dl; nz = (b.x - a.x) / dl; } else { nx /= nl; nz /= nl; }
      const lean = T.lean, base = f.type === 'R' ? 0 : 0.05;
      m.set(
        b.x - a.x, -nx * lean, nx, a.x + nx * lean,
        b.g - a.g, T.h, 0, a.g + base,
        b.z - a.z, -nz * lean, nz, a.z + nz * lean,
        0, 0, 0, 1,
      );
      const c = cellAt((a.x + b.x) / 2, (a.z + b.z) / 2);
      if (f.type === 'R') { c.rope.push(...m.elements); stats.ropes++; } else { c.panel.push(...m.elements); stats.panels++; }
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
  for (const c of cells.values()) for (const k of ['panel', 'rope', 'post', 'postCol']) c[k] = new Float32Array(c[k]);

  // ---- the four instanced meshes (capacity: every instance; only the cells near the camera are packed)
  const tot = { panel: 0, rope: 0, post: 0 };
  for (const c of cells.values()) for (const k in tot) tot[k] += c[k].length / 16;
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

  let packX = Infinity, packZ = Infinity;
  const pack = (x, z) => {
    packX = x; packZ = z;
    let np = 0, nr = 0, nq = 0;
    const R = FAR + REPACK;
    for (const c of cells.values()) {
      if (Math.hypot(Math.max(0, Math.abs(c.cx - x) - CELL / 2), Math.max(0, Math.abs(c.cz - z) - CELL / 2)) > R) continue;
      if (c.panel.length) { panel.instanceMatrix.array.set(c.panel, np * 16); np += c.panel.length / 16; }
      if (c.rope.length) { rope.instanceMatrix.array.set(c.rope, nr * 16); nr += c.rope.length / 16; }
      if (c.post.length) { post.instanceMatrix.array.set(c.post, nq * 16); post.instanceColor.array.set(c.postCol, nq * 3); nq += c.post.length / 16; }
    }
    panel.count = trim.count = np; rope.count = nr; post.count = nq;
    // (upload only the packed part of each buffer)
    for (const [attr, cnt, size] of [[panel.instanceMatrix, np, 16], [rope.instanceMatrix, nr, 16], [post.instanceMatrix, nq, 16], [post.instanceColor, nq, 3]]) {
      attr.clearUpdateRanges?.();
      attr.addUpdateRange?.(0, Math.max(1, cnt) * size);
      attr.needsUpdate = true;
    }
    stats.packed = { panels: np, ropes: nr, posts: nq };
  };

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
