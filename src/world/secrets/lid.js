// The lid over a covered cut (a tunnel's trench): terrain-material chunks that copy the finest terrain mesh
// exactly where the covered cut changes the terrain or its shading, so from outside the mountain looks untouched.
//  - same 2 m grid, same triangulation (a, c, b) / (b, c, d), same node-local coordinates as terrain.js, so the
//    chunk meets the surrounding terrain without a seam; heights from world.outsideHeight (no covered cuts)
//  - normals by the same central differences, the same macro slope (aMacro) and the same aData (forest tint,
//    grooming and corduroy of any piste over the tunnel), so its shading is identical to the terrain it replaces
//  - it covers every grid triangle that touches a vertex the cut lowers or whose normal the cut tilts; where it
//    lies on the unchanged terrain the two coincide and the lid wins the depth test (polygon offset)
//  - one chunk per 128 m terrain node, shown only while that node is built at the finest LOD (coarser LODs skip
//    covered cuts, so the mountain is whole there anyway)
//  - `keep` regions (convex, made of vertical planes) limit it, e.g. to between a tunnel's two portal planes (in
//    front of them are the open cuttings)
import * as THREE from 'three';
import { world } from '../world.js';
import { createTerrainMaterial } from '../terrain.js';
import { quality, onQualityChange } from '../../engine/quality.js';
import { late, sharedMaterial } from './slice.js';

const NODE = 128, ST = 2, SEG = NODE / ST; // finest terrain node: 128 m, 64 segments
const corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
export function lidMaterial() {
  return sharedMaterial('lid', () => {
    const m = createTerrainMaterial();
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -1;
    onQualityChange((q) => { if (m.defines.TERRAIN_DETAIL !== q.terrain.detail) { m.defines.TERRAIN_DETAIL = q.terrain.detail; m.needsUpdate = true; } });
    m.defines.TERRAIN_DETAIL = quality.terrain.detail;
    return m;
  });
}

/**
 * @param {object} o  bounds {minx, minz, maxx, maxz} of the covered cut; keep?: [[{ x, z, nx, nz }, ...], ...] the
 *   lid is kept only inside these regions (each the intersection of the +n sides of its vertical planes; they must
 *   not overlap; clip: one region). near?(x, z): false where the cut can't reach (those heights are skipped);
 *   cutAt?(x, z): the covered cut's own surface (Infinity outside it; default: the terrain sampled with the cut);
 *   lift?(x, z, h): the lid's height there (default h: the outside surface)
 * @returns {{ chunks: { key: string, mesh: THREE.Mesh }[], dispose(): void }}
 */
export function buildLid(o) {
  const it = buildLidSteps(o);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
// the same, as a generator that yields between its heavy steps (time-sliced building)
export function* buildLidSteps({ bounds, clip = null, keep = clip ? [clip] : [], near = null, lift = null, cutAt = null }) {
  const i0 = Math.floor(bounds.minx / ST) - 2, i1 = Math.ceil(bounds.maxx / ST) + 2;
  const j0 = Math.floor(bounds.minz / ST) - 2, j1 = Math.ceil(bounds.maxz / ST) + 2;
  const W = i1 - i0 + 1, H = j1 - j0 + 1;
  const out = new Float32Array(W * H), carved = new Uint8Array(W * H);
  let n = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i0 + i) * ST, z = (j0 + j) * ST, k = j * W + i;
      // (near(x, z) false: too far from the cut to be carved; the height is only needed for normals there)
      if (near && !near(x, z)) { out[k] = NaN; continue; }
      out[k] = world.outsideHeight(x, z, 0);
      // cutAt(x, z): the covered cut's own surface there (carved where it is below the outside one); without it,
      // the terrain is sampled with the cut
      const c = cutAt ? cutAt(x, z) : world.height(x, z, 0);
      carved[k] = out[k] - c > 0.01 ? 1 : 0;
      if ((++n & 31) === 0 && late()) yield;
    }
  }
  // heights the normals need beside sampled vertices; lift(x, z, h) may raise the lid (over a portal facade)
  const lifted = new Float32Array(W * H).fill(NaN);
  const need = (k) => {
    if (Number.isNaN(lifted[k])) {
      const i = k % W, j = (k - i) / W, x = (i0 + i) * ST, z = (j0 + j) * ST;
      if (Number.isNaN(out[k])) out[k] = world.outsideHeight(x, z, 0);
      lifted[k] = lift ? lift(x, z, out[k]) : out[k];
    }
    return lifted[k];
  };
  // affected: carved, or a 4-neighbour of a carved vertex (its terrain normal leans into the trench)
  const aff = new Uint8Array(W * H);
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const k = j * W + i;
    if (carved[k] || carved[k - 1] || carved[k + 1] || carved[k - W] || carved[k + W]) aff[k] = 1;
  }
  // group the triangles by 128 m node
  const nodes = new Map();
  for (let j = 1; j < H - 2; j++) for (let i = 1; i < W - 2; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    const t1 = aff[a] || aff[c] || aff[b], t2 = aff[b] || aff[c] || aff[d];
    if (!t1 && !t2) continue;
    const gx = (i0 + i) * ST, gz = (j0 + j) * ST;
    const nx0 = Math.floor(gx / NODE) * NODE, nz0 = Math.floor(gz / NODE) * NODE;
    const key = `${nx0},${nz0},${NODE}`;
    let n = nodes.get(key);
    if (!n) nodes.set(key, (n = { x0: nx0, z0: nz0, tris: [] }));
    if (t1) n.tris.push(a, c, b);
    if (t2) n.tris.push(b, c, d);
  }
  const mat = lidMaterial();
  const chunks = [];
  for (const [key, n] of nodes) {
    // macro slope as terrain.js computes it for this node (40 m band-limited samples every 8 m, bilinear), only
    // where the lid needs it
    const MS = 4, MV = SEG / MS + 1, mst = ST * MS, mw = MV + 2;
    const M = new Float32Array(mw * mw).fill(NaN), macro = new Float32Array(MV * MV).fill(NaN);
    const mH = (i, j) => { const k = (j + 1) * mw + (i + 1); if (Number.isNaN(M[k])) M[k] = world.height(n.x0 + i * mst, n.z0 + j * mst, Math.max(40, mst)); return M[k]; };
    const macroAt = (i, j) => {
      const k = j * MV + i;
      if (Number.isNaN(macro[k])) { const mx = mH(i - 1, j) - mH(i + 1, j), mz = mH(i, j - 1) - mH(i, j + 1); macro[k] = 1 - (2 * mst) / Math.hypot(mx, 2 * mst, mz); }
      return macro[k];
    };
    // a grid vertex: [local x, h, local z, nx, ny, nz, macro, forest, groomed, dirx, dirz] (as terrain.js has it),
    // computed once per vertex (a vertex is shared by up to six triangles)
    const vcache = new Map();
    const vert = (k) => { let v = vcache.get(k); if (!v) vcache.set(k, (v = vertRaw(k))); return v; };
    const vertRaw = (k) => {
      const i = k % W, j = (k - i) / W, x = (i0 + i) * ST, z = (j0 + j) * ST;
      const nx = need(k - 1) - need(k + 1), ny = 2 * ST, nz = need(k - W) - need(k + W), l = Math.hypot(nx, ny, nz);
      const li = (x - n.x0) / ST, lj = (z - n.z0) / ST, fi = li / MS, fj = lj / MS;
      const ii = Math.min(MV - 2, Math.max(0, Math.floor(fi))), jj = Math.min(MV - 2, Math.max(0, Math.floor(fj))), ti = fi - ii, tj = fj - jj;
      const A = macroAt(ii, jj), B = macroAt(ii + 1, jj), C = macroAt(ii, jj + 1), D = macroAt(ii + 1, jj + 1);
      const h = need(k), uy = ny / l;
      const d = [world.forest(x, z, h, Math.sqrt(1 - uy * uy) / Math.max(uy, 0.05)), 0, 0, 0];
      world.corridorAt(x, z, corr);
      if (corr.groomed) {
        const gr = 1 - Math.min(1, Math.max(0, (corr.d + 3) / 6));
        const m = 4 + Math.max(-100, Math.min(100, corr.lat || 0)) / 50; // (as Terrain.buildNode: the groomer lanes' lateral position)
        d[1] = gr; d[0] *= 1 - gr; d[2] = corr.dx * m; d[3] = corr.dz * m;
      } else if (corr.d < 4) d[0] = 0;
      const pad = world.padInfluence(x, z);
      if (pad > 0.02 && pad > d[1]) { d[1] = Math.min(1, pad * 1.5); d[0] = 0; if (!d[2] && !d[3]) d[2] = 1; }
      return [x - n.x0, h, z - n.z0, nx / l, uy, nz / l, (A + (B - A) * ti) * (1 - tj) + (C + (D - C) * ti) * tj, d[0], d[1], d[2], d[3]];
    };
    const pos = [], nor = [], mac = [], dat = [];
    const emit = (v) => { pos.push(v[0], v[1], v[2]); nor.push(v[3], v[4], v[5]); mac.push(v[6]); dat.push(v[7], v[8], v[9], v[10]); };
    const lerpV = (a, b, t) => { const v = a.map((q, i) => q + (b[i] - q) * t); const l = Math.hypot(v[3], v[4], v[5]) || 1; v[3] /= l; v[4] /= l; v[5] /= l; return v; };
    for (let t = 0; t < n.tris.length; t += 3) {
      const tri = [vert(n.tris[t]), vert(n.tris[t + 1]), vert(n.tris[t + 2])];
      // keep the parts inside the union of the (disjoint, convex) keep-regions; no regions: keep it whole
      for (const region of keep.length ? keep : [[]]) {
        let poly = tri;
        for (const pl of region) {
          const sd = (v) => (v[0] + n.x0 - pl.x) * pl.nx + (v[2] + n.z0 - pl.z) * pl.nz;
          const res = [];
          for (let q = 0; q < poly.length; q++) {
            const a = poly[q], b = poly[(q + 1) % poly.length], da = sd(a), db = sd(b);
            if (da >= 0) res.push(a);
            if ((da >= 0) !== (db >= 0)) res.push(lerpV(a, b, da / (da - db)));
          }
          poly = res;
          if (poly.length < 3) break;
        }
        for (let q = 1; q + 1 < poly.length; q++) { emit(poly[0]); emit(poly[q]); emit(poly[q + 1]); }
      }
      if ((t & 63) === 63 && late()) yield;
    }
    if (!pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aData', new THREE.Float32BufferAttribute(dat, 4));
    g.setAttribute('aMacro', new THREE.Float32BufferAttribute(mac, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(n.x0, 0, n.z0);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = 'secret-lid';
    mesh.visible = false;
    chunks.push({ key, mesh });
    yield;
  }
  return { chunks, dispose() { for (const c of chunks) c.mesh.geometry.dispose(); } };
}

/** show each lid chunk only while its 128 m terrain node is built (finest LOD) */
export function updateLidVisibility(lid, terrain) {
  for (const c of lid.chunks) c.mesh.visible = !!terrain?.active?.has(c.key);
}
