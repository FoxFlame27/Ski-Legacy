// Solid props: makes sure nothing that stands in the world can be walked, skied, sledded or driven through.
// (Oct 30, the user: "make sure you can't go through any objects - there are still some attachments on buildings in
// the village where you just drive through".)
//
// The buildings and props carry hand-sized colliders (a box at ~84 % of a Meshy building's bounding box, a circle
// round a bench...), which leave porches, balconies, stairs, annexes, sheds, chimney stacks, the ends of benches and
// stalls and the like outside them. Once everything is built (main.js), solidify() looks at what is actually drawn:
// for every placed prop it rasterises the triangles between 0.3 m and 2 m over the snow (what a skier, a walker or
// a car would run into) onto a 0.5 m grid in the prop's own frame, drops the cells some collider already covers, and
// adds rotated boxes for the rest (greedily merged into rectangles), so the colliders follow the drawn footprint.
// Only adds colliders: meshes are never touched (instancing / merging elsewhere does not matter, it reads triangles).
//  - low things (drawn top under 1.6 m over the snow: benches, steps, planters, a porch deck) get `top`, so you step
//    up onto them on foot (Player: WALK_STEP) or jump them on skis; taller ones have no top (the usual walls);
//  - roofs, eaves, awnings and balconies over 2 m are not obstacles (you pass under them); open structures (a bus
//    shelter, a canopy on posts) stay open: only their posts and walls are drawn in that band;
//  - `keepOut` spots (doorways, counters, the places you walk up to) never get a collider;
//  - invisible meshes (camera blockers, hit boxes), skinned meshes (people), points, lines and sprites are ignored,
//    and so is anything already inside a vehicle's collider (parked cars come and go).
import * as THREE from 'three';
import { drawnHeight } from './settle.js';
import { world } from './world.js';

const CELL = 0.5;  // m: the footprint grid
const LIFT = 0.3;  // m over the snow: lower geometry (paving, kerbs, drifts, decals) is not an obstacle
const HEAD = 2.0;  // m over the snow: higher geometry (roofs, eaves, balconies, sign boards up high) is passed under
const LOW = 1.6;   // m over the snow: below this an obstacle gets a top (stepped / jumped onto)
const TOL = 0.15;  // m: a cell whose centre is this close to an existing collider counts as covered
const MAX_ITEM = 70; // m: bigger "items" are merged runs (nets, fences, markers across the resort): skipped
const MAX_INST = 64; // an instanced mesh with more instances is scatter (piste markers, cannons): left to its module

const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _v = new THREE.Vector3();

// the ground under a cell: the drawn terrain, or a walkable deck (a platform, a helipad, a bridge) up to just over
// what is drawn there (settle.js groundAt): a station's benches on its platform get colliders, the platform does not
function groundAt(x, z, yHint) {
  let h = drawnHeight(x, z);
  const arr = world.surfaceGrid?.get(Math.floor(x / 64) + ',' + Math.floor(z / 64));
  if (arr) for (const sf of arr) { const hs = sf.height(x, z); if (hs !== null && hs > h && hs <= yHint + 0.1) h = hs; }
  return h;
}

// every visible, solid-looking mesh under `obj` (only the coarsest level of a LOD), with its world matrices
// (a LOD's level: whatever its own visible flag says. THREE.LOD shows one level at a time by the camera's distance, so
// the level read here was hidden for every building near the camera at boot, and those got no colliders at all:
// Oct 30, the user stood inside a hotel's spruce and porch in Legacy Village)
function meshesOf(obj, base, out, level = false) {
  if ((!obj.visible && !level) || obj.userData?.noCollide) return out;
  if (obj.isSkinnedMesh || obj.isPoints || obj.isLine || obj.isSprite || obj.isLight) return out;
  if (obj.isLOD && obj.levels?.length) { meshesOf(obj.levels.at(obj.userData.solidLevel ?? -1).object, base, out, true); return out; } // (solidLevel: makeLOD's far copy is too coarse for a footprint)
  if (obj.isMesh && obj.geometry?.attributes?.position) {
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const hidden = mats.every((m) => !m || m.visible === false || m.colorWrite === false || (m.transparent && m.opacity < 0.05));
    if (!hidden) {
      if (obj.isInstancedMesh) {
        if (obj.count > MAX_INST) return out; // (scatter / streamed instances: the fences, markers...)
        for (let k = 0; k < obj.count; k++) { obj.getMatrixAt(k, _mi); out.push({ mesh: obj, m: new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, _mi) }); }
      } else out.push({ mesh: obj, m: obj.matrixWorld });
    }
  }
  for (const c of obj.children) meshesOf(c, base, out);
  return out;
}

// point in polygon (u, v pairs)
function inPoly(P, u, v) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ui, vi] = P[i], [uj, vj] = P[j];
    if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}
// clip a polygon of [x, y, z] to y >= lo and y <= hi
function clipY(poly, lo, hi) {
  const cut = (P, keep, edge) => {
    const out = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], ka = keep(a[1]), kb = keep(b[1]);
      if (ka) out.push(a);
      if (ka !== kb) { const t = (edge - a[1]) / (b[1] - a[1]); out.push([a[0] + (b[0] - a[0]) * t, edge, a[2] + (b[2] - a[2]) * t]); }
    }
    return out;
  };
  let P = cut(poly, (y) => y >= lo, lo);
  if (P.length >= 3) P = cut(P, (y) => y <= hi, hi);
  return P;
}

/**
 * The drawn footprint of one placed prop (meshes: from meshesOf), as grid cells in its own frame.
 * @returns {null | { yaw, ox, oz, cells: Map<key, {i, j, h, x, z, g}> }}
 */
const _box = new THREE.Box3(), _bb = new THREE.Box3();
// world vertices of `meshes` (+ their bounds)
function prepare(meshes) {
  const tris = [];
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const { mesh, m } of meshes) {
    const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
    const W = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      W[i * 3] = _v.x; W[i * 3 + 1] = _v.y; W[i * 3 + 2] = _v.z;
      if (_v.x < minx) minx = _v.x; if (_v.x > maxx) maxx = _v.x;
      if (_v.z < minz) minz = _v.z; if (_v.z > maxz) maxz = _v.z;
      if (_v.y < miny) miny = _v.y; if (_v.y > maxy) maxy = _v.y;
    }
    tris.push({ W, idx, n: idx ? idx.count : pos.count });
  }
  return { tris, minx, maxx, minz, maxz, miny, maxy };
}
// (big merged meshes, in tiles) the triangles of `prep` by TILE m world tile of their first corner: Map key -> [k, t...]
const TILE = 32;
function tileBuckets(prep) {
  const B = new Map();
  prep.tris.forEach(({ W, idx, n }, k) => {
    const ia = idx?.array;
    for (let t = 0; t < n; t += 3) {
      const a = ia ? ia[t] : t, key = Math.floor(W[a * 3] / TILE) * 100003 + Math.floor(W[a * 3 + 2] / TILE);
      let arr = B.get(key);
      if (!arr) B.set(key, (arr = []));
      arr.push(k, t);
    }
  });
  return B;
}
function footprint(meshes, yaw, name, tile = null) {
  if (!tile) {
    // a cheap size check first (merged runs across the resort are skipped before any vertex work)
    _box.makeEmpty();
    for (const { mesh, m } of meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      _box.union(_bb.copy(mesh.geometry.boundingBox).applyMatrix4(m));
    }
    if (_box.max.x - _box.min.x > MAX_ITEM || _box.max.z - _box.min.z > MAX_ITEM) return { skip: 'too big' };
  }
  const prep = tile ? tile.prep : prepare(meshes), tris = prep.tris;
  let { minx, maxx, minz, maxz, maxy } = prep;
  if (!tris.length || !Number.isFinite(minx)) return null;
  if (tile) { minx = tile.x0; maxx = tile.x0 + TILE; minz = tile.z0; maxz = tile.z0 + TILE; }
  else if (maxx - minx > MAX_ITEM || maxz - minz > MAX_ITEM) return { skip: 'too big' };
  const ox = (minx + maxx) / 2, oz = (minz + maxz) / 2, c = Math.cos(yaw), s = Math.sin(yaw);
  let gMin = Infinity, gMax = -Infinity;
  for (const [x, z] of [[minx, minz], [maxx, minz], [minx, maxz], [maxx, maxz], [ox, oz]]) { const g = drawnHeight(x, z); gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
  const lo = gMin + 0.12, hi = gMax + HEAD, gHug = gMax + LIFT;
  if (maxy < lo + LIFT * 0.5) return null; // flat on the snow
  const cells = new Map();
  const mark = (u, v, h) => {
    const i = Math.floor(u / CELL), j = Math.floor(v / CELL), k = (i + 32768) * 65536 + (j + 32768);
    const e = cells.get(k);
    if (e) { if (h > e.h) e.h = h; } else cells.set(k, { i, j, h });
  };
  const P3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k0 = 0; k0 < tris.length; k0++) {
    const { W, idx, n } = tris[k0];
    // (u, v) of every vertex in the prop's frame
    const UV = tile ? null : new Float32Array((W.length / 3) * 2);
    if (UV) for (let i = 0, k = 0; i < W.length; i += 3, k += 2) { const dx = W[i] - ox, dz = W[i + 2] - oz; UV[k] = dx * c - dz * s; UV[k + 1] = dx * s + dz * c; }
    const ia = idx?.array, list = tile?.list, N = tile ? list.length : n;
    for (let q0 = 0; q0 < N; q0 += tile ? 2 : 3) {
      if (tile && list[q0] !== k0) continue;
      const t = tile ? list[q0 + 1] : q0;
      const a = ia ? ia[t] : t, b = ia ? ia[t + 1] : t + 1, d = ia ? ia[t + 2] : t + 2;
      const ya = W[a * 3 + 1], yb = W[b * 3 + 1], yd = W[d * 3 + 1];
      const ymax = ya > yb ? (ya > yd ? ya : yd) : (yb > yd ? yb : yd), ymin = ya < yb ? (ya < yd ? ya : yd) : (yb < yd ? yb : yd);
      if (ymax < lo || ymin > hi) continue;
      // (geometry draped on the ground, every corner under LIFT over the snow right there: a car park's surface and its
      // painted lines, a yard, kerbs. On a slope a triangle's top is well over the ground at its low end, and the Autohaus
      // car park's lines became a row of invisible walls across it: your car could not drive out of its bay)
      if (ymin <= gHug) {
        const AG = (tris[k0].ag ||= new Float32Array(W.length / 3).fill(NaN));
        let hug = true;
        for (const vi of [a, b, d]) {
          let h = AG[vi];
          if (h !== h) h = AG[vi] = W[vi * 3 + 1] - drawnHeight(W[vi * 3], W[vi * 3 + 2]);
          if (h >= LIFT) { hug = false; break; }
        }
        if (hug) continue;
      }
      // (most triangles of a detailed model: small and inside the band, their corners' cells will do)
      if (ymin >= lo && ymax <= hi && UV) {
        const ua = UV[a * 2], va = UV[a * 2 + 1], ub = UV[b * 2], vb = UV[b * 2 + 1], ud = UV[d * 2], vd = UV[d * 2 + 1];
        if (Math.abs(ua - ub) < CELL * 0.5 && Math.abs(ua - ud) < CELL * 0.5 && Math.abs(va - vb) < CELL * 0.5 && Math.abs(va - vd) < CELL * 0.5) {
          mark(ua, va, ymax); mark(ub, vb, ymax); mark(ud, vd, ymax);
          continue;
        }
      }
      P3[0] = [W[a * 3], ya, W[a * 3 + 2]]; P3[1] = [W[b * 3], yb, W[b * 3 + 2]]; P3[2] = [W[d * 3], yd, W[d * 3 + 2]];
      const C = clipY(P3, lo, hi);
      if (C.length < 3) continue;
      // to the prop's frame (u along its local x, v along its local z)
      let ph = -Infinity;
      const P = C.map(([x, y, z]) => { const dx = x - ox, dz = z - oz; if (y > ph) ph = y; return [dx * c - dz * s, dx * s + dz * c, y]; });
      // edges (thin walls and posts project to lines)
      for (let k = 0; k < P.length; k++) {
        const [u0, v0, y0] = P[k], [u1, v1, y1] = P[(k + 1) % P.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / (CELL * 0.5)));
        for (let q = 0; q <= steps; q++) { const f = q / steps; mark(u0 + (u1 - u0) * f, v0 + (v1 - v0) * f, Math.max(y0, y1)); }
      }
      // inside (cell centres)
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [u, v] of P) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      if (u1 - u0 < CELL && v1 - v0 < CELL) continue;
      for (let i = Math.floor(u0 / CELL); i <= Math.floor(u1 / CELL); i++) for (let j = Math.floor(v0 / CELL); j <= Math.floor(v1 / CELL); j++) {
        if (inPoly(P, (i + 0.5) * CELL, (j + 0.5) * CELL)) mark((i + 0.5) * CELL, (j + 0.5) * CELL, ph);
      }
    }
  }
  // keep the cells whose geometry rises LIFT over the snow right there
  for (const [k, e] of cells) {
    const u = (e.i + 0.5) * CELL, v = (e.j + 0.5) * CELL;
    e.x = ox + u * c + v * s; e.z = oz - u * s + v * c;
    e.g = groundAt(e.x, e.z, e.h);
    if (e.h < e.g + LIFT) cells.delete(k);
    else e.tall = e.h >= hi - 0.05 || e.h - e.g > LOW;
  }
  return { yaw, ox, oz, cells, hi, name };
}

const insideCol = (c, x, z, tol) => {
  if (c.r !== undefined) return Math.hypot(x - c.x, z - c.z) <= c.r + tol;
  const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), dx = x - c.x, dz = z - c.z;
  return Math.abs(dx * cs - dz * sn) <= c.hw + tol && Math.abs(dx * sn + dz * cs) <= c.hd + tol;
};
const colSize = (c) => (c.r ?? Math.hypot(c.hw, c.hd));

// a 16 m grid over colliders (the static ones: the fence pool moves, vehicles come and go)
class ColGrid {
  constructor() { this.g = new Map(); }
  add(c) {
    if (c.fence || c.traffic || c.mp || !Number.isFinite(c.x) || Math.abs(c.x) > 1e8) return;
    const r = colSize(c);
    for (let i = Math.floor((c.x - r) / 16); i <= Math.floor((c.x + r) / 16); i++) for (let j = Math.floor((c.z - r) / 16); j <= Math.floor((c.z + r) / 16); j++) {
      const k = i * 100003 + j;
      let a = this.g.get(k);
      if (!a) this.g.set(k, (a = []));
      a.push(c);
    }
  }
  near(x, z) { return this.g.get(Math.floor(x / 16) * 100003 + Math.floor(z / 16)) || []; }
  covered(x, z, tol = TOL) { for (const c of this.near(x, z)) if (insideCol(c, x, z, tol)) return c; return null; }
}

/**
 * Add colliders for whatever is drawn but not yet solid.
 * @param {Array<{ root: THREE.Object3D, whole?: boolean, area?: string, maxInst?: number, blob?: boolean }>} entries prop
 *   groups: each direct child is one placed prop (whole: the root itself is one, e.g. a building lot); an instanced
 *   child's instances are props of their own (up to maxInst of them, default MAX_INST; blob false: boxed like any prop
 *   instead of one circle each). A child with userData.noSolid is left out (its module has its own colliders).
 * @param {object[]} colliders the colliders that already exist (read)
 * @param {{ out?: object[], keepOut?: Array<{x, z, r}>, skip?: (o) => boolean }} o out: where the new colliders go
 *   (default: colliders)
 * @returns {{ areas: object, added: number, items: Array }} per area: props seen, props with nothing drawn left
 *   uncovered before (solid), with some (partial), with no collider at all (bare), the uncovered 0.5 m cells before
 *   and after, colliders added
 */
export function solidify(entries, colliders, o = {}) {
  const steps = solidifySteps(entries, colliders, o);
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}
/** solidify() in slices of ~`budget` ms between frames (in game: ~2 s of work at boot otherwise); resolves with its result. */
export function solidifyIdle(entries, colliders, o = {}, budget = 5) {
  const steps = solidifySteps(entries, colliders, o);
  return new Promise((resolve) => {
    const slice = () => {
      const t0 = performance.now();
      for (;;) {
        const r = steps.next();
        if (r.done) { resolve(r.value); return; }
        if (performance.now() - t0 > budget) break;
      }
      setTimeout(slice, 16);
    };
    setTimeout(slice, 0);
  });
}
function* solidifySteps(entries, colliders, { out = colliders, keepOut = [], skip = () => false } = {}) {
  const grid = new ColGrid();
  for (const c of colliders) grid.add(c);
  if (out !== colliders) for (const c of out) grid.add(c);
  const res = { areas: {}, added: 0, items: [] };
  for (const e of entries) {
    const root = e?.root;
    if (!root) continue;
    root.updateMatrixWorld(true);
    const A = (res.areas[e.area || root.name || 'props'] ??= { props: 0, solid: 0, partial: 0, bare: 0, skipped: 0, cellsBefore: 0, cellsAfter: 0, added: 0 });
    const items = [];
    for (const it of e.whole ? [root] : root.children) {
      if (skip(it) || it.userData?.noSolid || it.userData?.noCollide) continue; // (noCollide: its module's own colliders, e.g. the breakable snow poles and reflector posts: world/breakables.js)
      if (it.isInstancedMesh && it.count > (e.maxInst ?? MAX_INST)) { A.skipped++; continue; }
      if (it.isInstancedMesh && !e.whole) {
        // every instance its own prop (e.blob false: footprint boxes as for any prop, not one circle round it)
        for (let k = 0; k < it.count; k++) {
          it.getMatrixAt(k, _mi); _m.multiplyMatrices(it.matrixWorld, _mi);
          if (Math.abs(_m.determinant()) < 1e-9) continue; // (an instance hidden by a zero matrix)
          items.push({ name: it.name || 'instanced', meshes: [{ mesh: it, m: _m.clone() }], yaw: Math.atan2(_m.elements[8], _m.elements[10]), blob: e.blob !== false });
        }
      } else {
        const meshes = meshesOf(it, null, []);
        if (meshes.length) items.push({ name: it.name || nameOf(it), meshes, yaw: Math.atan2(it.matrixWorld.elements[8], it.matrixWorld.elements[10]) });
      }
    }
    const handle = (fp, tiled) => {
      if (!fp) return;
      if (fp.skip) { A.skipped++; return; }
      if (!fp.cells.size) return;
      // (a little breakable pole / sign standing here (world/breakables.js): its own collider knocks it flying; a solid
      // box round it would stop the car short of it, a "Knock" with car damage and the pole left standing)
      if (fp.cells.size <= 8 && grid.near(fp.ox, fp.oz).some((c) => c.breakable && Math.hypot(c.x - fp.ox, c.z - fp.oz) < 0.6)) { A.skipped++; return; }
      // parked vehicles come and go: leave them to their own colliders
      if (!tiled && grid.near(fp.ox, fp.oz).some((c) => (c.car || c.vehicle) && insideCol(c, fp.ox, fp.oz, 0))) return;
      A.props++;
      const free = [];
      let covered = 0, kept = 0;
      for (const cell of fp.cells.values()) {
        if (grid.covered(cell.x, cell.z)) { covered++; continue; }
        if (keepOut.some((k) => Math.hypot(k.x - cell.x, k.z - cell.z) < k.r)) { cell.keep = true; kept++; continue; }
        free.push(cell);
      }
      // (scatter: an ice tower, a boulder: one circle round the bulk of it, unless its collider holds 85 % already)
      if (fp.blob && covered >= 0.85 * fp.cells.size) { A.solid++; return; }
      A.cellsBefore += free.length;
      if (!free.length) { A.solid++; return; }
      if (!covered) A.bare++; else A.partial++;
      const boxes = (!kept && fp.blob && blob(fp)) || (!kept && !tiled && small(fp)) || mergeCells(free, fp, grid, keepOut);
      for (const b of boxes) { out.push(b); grid.add(b); }
      A.added += boxes.length; res.added += boxes.length;
      // (after: what is still uncovered, with the new boxes in)
      A.cellsAfter += free.filter((cell) => !grid.covered(cell.x, cell.z, TOL)).length;
      res.items.push({ area: e.area || root.name, name: fp.name, x: Math.round(fp.ox), z: Math.round(fp.oz), cells: fp.cells.size, uncovered: free.length, bare: !covered, added: boxes.length });
    };
    for (const item of items) {
      yield;
      const fp = footprint(item.meshes, item.yaw, item.name);
      if (fp && !fp.skip) fp.blob = item.blob;
      if (fp?.skip && e.tiles) {
        // a big merged mesh (statics merged into one across the village): its triangles in 32 m world tiles
        const prep = prepare(item.meshes);
        for (const [key, list] of tileBuckets(prep)) {
          yield;
          const ti = Math.round(key / 100003), tj = key - ti * 100003;
          handle(footprint(item.meshes, 0, item.name + '#tile', { prep, list, x0: ti * TILE, z0: tj * TILE }), true);
        }
        continue;
      }
      handle(fp, false);
    }
  }
  return res;
}

// scatter (an instanced ice tower, a boulder): one circle round its drawn cells (the 85th percentile of their distance
// from the middle: a spike sticking out is not worth a second collider)
function blob(fp) {
  let x = 0, z = 0, top = -Infinity, tall = false;
  const cells = [...fp.cells.values()];
  for (const e of cells) { x += e.x; z += e.z; top = Math.max(top, e.h); tall ||= e.tall; }
  x /= cells.length; z /= cells.length;
  const d = cells.map((e) => Math.hypot(e.x - x, e.z - z)).sort((a, b) => a - b);
  const b = { x, z, r: d[Math.floor(0.85 * (d.length - 1))] + CELL / 2, solidified: true };
  if (!tall) b.top = top;
  return [b];
}
// a small prop (drawn footprint within 3 x 3 m: a lamp, a bench, a sign, a barrel, a snowman): one box round all of it
function small(fp) {
  let i0 = Infinity, i9 = -Infinity, j0 = Infinity, j9 = -Infinity, top = -Infinity, tall = false;
  for (const e of fp.cells.values()) { i0 = Math.min(i0, e.i); i9 = Math.max(i9, e.i); j0 = Math.min(j0, e.j); j9 = Math.max(j9, e.j); top = Math.max(top, e.h); tall ||= e.tall; }
  if ((i9 - i0 + 1) * CELL > 3 || (j9 - j0 + 1) * CELL > 3) return null;
  const c = Math.cos(fp.yaw), s = Math.sin(fp.yaw), u = ((i0 + i9 + 1) / 2) * CELL, v = ((j0 + j9 + 1) / 2) * CELL;
  const b = { x: fp.ox + u * c + v * s, z: fp.oz - u * s + v * c, hw: ((i9 - i0 + 1) * CELL) / 2, hd: ((j9 - j0 + 1) * CELL) / 2, rot: -fp.yaw, solidified: true };
  if (!tall) b.top = top;
  return [b];
}
function nameOf(o) {
  let n = '';
  o.traverse((c) => { if (!n && c.name) n = c.name; });
  return n || o.type;
}

// greedy rectangles over the free cells (cells of one height class together: tall ones, or low ones whose tops are
// within 0.25 m), as rotated box colliders in the prop's frame. A rectangle may run on across cells that a collider
// already covers (they are blocked anyway), so a ring of wall round a building's existing box, or an annex beside
// it, comes out as a few big boxes instead of dozens of strips.
function mergeCells(free, fp, grid, keepOut = []) {
  // (a building: mostly walls. Its low bits, sills, steps, a porch deck, a woodshed's roof, are just more of it, so the
  // boxes need not break up at every one of them)
  let nTall = 0;
  for (const e of fp.cells.values()) if (e.tall) nTall++;
  const building = nTall >= 0.4 * fp.cells.size;
  const cls = (e) => (e.tall || building ? 'T' : 'L' + Math.round(e.h / 0.25));
  const map = new Map();
  let i0 = Infinity, i9 = -Infinity, j0 = Infinity, j9 = -Infinity;
  for (const e of fp.cells.values()) { i0 = Math.min(i0, e.i); i9 = Math.max(i9, e.i); j0 = Math.min(j0, e.j); j9 = Math.max(j9, e.j); }
  for (const e of free) map.set(e.i + ',' + e.j, e);
  const used = new Set(), boxes = [];
  const c = Math.cos(fp.yaw), s = Math.sin(fp.yaw);
  // (a cell in a doorway's keep-out circle: never spanned, not even where a collider covers it already, e.g. the
  // front steps' box: a wall's rectangle run on across them would shut the door)
  const covered = new Map(), kept = new Map(), isKept = (i, j) => {
    const key = i + ',' + j;
    let v = kept.get(key);
    if (v === undefined) {
      const u = (i + 0.5) * CELL, w = (j + 0.5) * CELL, x = fp.ox + u * c + w * s, z = fp.oz - u * s + w * c;
      v = keepOut.some((k) => Math.hypot(k.x - x, k.z - z) < k.r);
      kept.set(key, v);
    }
    return v;
  }, isCovered = (i, j) => {
    const key = i + ',' + j;
    let v = covered.get(key);
    if (v === undefined) {
      const u = (i + 0.5) * CELL, w = (j + 0.5) * CELL;
      v = !!grid.covered(fp.ox + u * c + w * s, fp.oz - u * s + w * c, 0);
      covered.set(key, v);
    }
    return v;
  };
  // the inside of a closed building (walls all round, nothing drawn within: not reachable from outside the walls)
  const has = (i, j) => fp.cells.has((i + 32768) * 65536 + (j + 32768));
  const outside = new Set(), stack = [[i0 - 1, j0 - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(), key = i + ',' + j;
    if (i < i0 - 1 || i > i9 + 1 || j < j0 - 1 || j > j9 + 1 || outside.has(key) || has(i, j)) continue;
    outside.add(key);
    stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
  const sorted = [...free].sort((a, b) => a.j - b.j || a.i - b.i);
  for (const e of sorted) {
    const key0 = e.i + ',' + e.j;
    if (used.has(key0)) continue;
    const k = cls(e);
    const ok = (i, j) => {
      if (i < i0 || i > i9 || j < j0 || j > j9) return false;
      const q = map.get(i + ',' + j);
      if (q) return !used.has(i + ',' + j) && cls(q) === k;
      if (keepOut.length && isKept(i, j)) return false;
      if (has(i, j)) return !fp.cells.get((i + 32768) * 65536 + (j + 32768)).keep; // (drawn, and covered already; never a doorway)
      return isCovered(i, j) || ((e.tall || building) && !outside.has(i + ',' + j)); // (a wall's box may span the closed inside)
    };
    let i1 = e.i;
    while (ok(i1 + 1, e.j)) i1++;
    let j1 = e.j;
    for (;;) {
      let row = true;
      for (let i = e.i; i <= i1 && row; i++) row = ok(i, j1 + 1);
      if (!row) break;
      j1++;
    }
    let top = -Infinity;
    for (let i = e.i; i <= i1; i++) for (let j = e.j; j <= j1; j++) { const q = map.get(i + ',' + j); if (q) { used.add(i + ',' + j); top = Math.max(top, q.h); } }
    const u = ((e.i + i1 + 1) / 2) * CELL, v = ((e.j + j1 + 1) / 2) * CELL;
    const b = { x: fp.ox + u * c + v * s, z: fp.oz - u * s + v * c, hw: ((i1 - e.i + 1) * CELL) / 2, hd: ((j1 - e.j + 1) * CELL) / 2, rot: -fp.yaw, solidified: true };
    if (!e.tall && !building) b.top = top;
    boxes.push(b);
  }
  return boxes;
}

/** Every collider-less prop in `entries` (Node checks / ?solid): the same audit without adding anything. */
export function solidAudit(entries, colliders, o = {}) {
  return solidify(entries, colliders, { ...o, out: [] });
}
export const _debug = { footprint, meshesOf, insideCol };
