// A paved patch that lies exactly on the drawn terrain: the near terrain mesh's own 2 m triangles (world.meshHeight:
// the same grid and diagonal as terrain.js buildNode) clipped to a convex outline, each point `lift` m above them.
// A paving grid of its own (rotated, other spacing) laid with its vertices on the terrain is not on it between them:
// where the ground is not dead flat (a car park's mouth, a yard running into a road's shoulder, a car park on the
// natural slope) the terrain's triangles bulged up through it, snow showing through the asphalt or flickering with it
// (Oct 30, the user: "snow floor mixing with brick floor ... like the dealership parking lot"). Conforming, the gap is
// `lift` everywhere: no snow can show through at any distance (the paving materials add a depth offset on top).
import * as THREE from 'three';
import { world } from './world.js';

const G = 2; // the terrain's finest grid (m)

// clip a convex polygon `p` ([[x, z]...]) to the inner side of edge a -> b (s: the outline's winding sign)
function clipEdge(p, ax, az, bx, bz, s) {
  const out = [], side = (q) => s * ((bx - ax) * (q[1] - az) - (bz - az) * (q[0] - ax));
  for (let i = 0; i < p.length; i++) {
    const P = p[i], Q = p[(i + 1) % p.length], dp = side(P), dq = side(Q);
    if (dp >= 0) out.push(P);
    if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
  }
  return out;
}

/**
 * The drawn terrain's triangles inside a convex outline, lifted.
 * @param {number[][]} poly convex outline [[x, z], ...] (world, either winding)
 * @param {object} o lift (m above the drawn terrain), height(x, z) (default world.meshHeight)
 * @returns {{ pos: number[], idx: number[] }} welded vertices (x, y, z) and upward-facing triangles
 */
export function groundPatch(poly, { lift = 0.04, height = null } = {}) {
  const H = height || ((x, z) => world.meshHeight(x, z));
  let area = 0, minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x, z] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    area += x * z2 - x2 * z;
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z);
  }
  const s = area >= 0 ? 1 : -1, pos = [], idx = [], weld = new Map();
  const vert = (x, z) => {
    const k = Math.round(x * 2000) * 1e7 + Math.round(z * 2000);
    let i = weld.get(k);
    if (i === undefined) { i = pos.length / 3; weld.set(k, i); pos.push(x, H(x, z) + lift, z); }
    return i;
  };
  for (let i = Math.floor(minx / G); i <= Math.floor(maxx / G); i++) for (let j = Math.floor(minz / G); j <= Math.floor(maxz / G); j++) {
    const x0 = i * G, z0 = j * G, x1 = x0 + G, z1 = z0 + G;
    // the cell's two triangles, the diagonal from (i + 1, j) to (i, j + 1) (world.meshHeight / terrain.js)
    for (const tri of [[[x0, z0], [x0, z1], [x1, z0]], [[x1, z1], [x1, z0], [x0, z1]]]) {
      let p = tri;
      for (let e = 0; e < poly.length && p.length >= 3; e++) { const a = poly[e], b = poly[(e + 1) % poly.length]; p = clipEdge(p, a[0], a[1], b[0], b[1], s); }
      if (p.length < 3) continue;
      const ids = p.map((q) => vert(q[0], q[1]));
      for (let k = 1; k < ids.length - 1; k++) {
        const a = ids[0], b = ids[k], c = ids[k + 1];
        if (a === b || b === c || a === c) continue;
        // face up (three.js: counter-clockwise seen from above is (b - a) x (c - a) pointing +y)
        const ux = pos[b * 3] - pos[a * 3], uz = pos[b * 3 + 2] - pos[a * 3 + 2], vx = pos[c * 3] - pos[a * 3], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
        const ny = uz * vx - ux * vz;
        if (Math.abs(ny) < 1e-7) continue;
        if (ny > 0) idx.push(a, b, c); else idx.push(a, c, b);
      }
    }
  }
  return { pos, idx };
}

/**
 * groundPatch as a BufferGeometry. uv(x, z) -> [u, v] and color(x, z) -> [r, g, b, a] (optional, world x z);
 * toLocal(v3) (optional): world -> the parent's frame (e.g. group.worldToLocal).
 */
export function groundPatchGeometry(poly, { lift = 0.04, height = null, uv = null, color = null, toLocal = null } = {}) {
  const { pos, idx } = groundPatch(poly, { lift, height });
  const n = pos.length / 3, P = new Float32Array(pos.length), U = uv ? new Float32Array(n * 2) : null, C = color ? new Float32Array(n * 4) : null;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (U) { const q = uv(x, z); U[i * 2] = q[0]; U[i * 2 + 1] = q[1]; }
    if (C) { const c = color(x, z); C.set(c, i * 4); }
    if (toLocal) { v.set(x, y, z); toLocal(v); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; } else { P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  if (U) g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (C) g.setAttribute('color', new THREE.BufferAttribute(C, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A rectangle's outline in a frame: centre (cx, cz), axes (ux, uz) and (vx, vz), u in [u0, u1], v in [v0, v1]. */
export function frameRect(cx, cz, ux, uz, vx, vz, u0, u1, v0, v1) {
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [cx + ux * u + vx * v, cz + uz * u + vz * v]);
}

/**
 * A ground-laid mesh re-laid on the drawn terrain. A strip on a grid of its own (a road's 1 m rows, a path's 1.5 m
 * steps) has its points on the terrain but not the straight lines between them: over a crease of the 2 m triangles (a
 * berm's foot, a cutting's edge, a hump) the snow rose through it (Oct 30, the user: "snow floor mixing with brick
 * floor"). Every triangle the terrain bends under by more than `tol` m is cut along the terrain's 2 m triangles (in
 * plan), each new point at the drawn terrain + the triangle's own clearance there (its corners' heights over the drawn
 * terrain, interpolated), its other attributes (uv, colour, aEnd, ...) interpolated with it. A triangle beside such a
 * one, itself near enough flat, only takes the same points on the edge they share (fanned from its middle): no crack.
 * geo: indexed or not; matrix (optional): its local -> world transform (a group's matrixWorld: a turn about y and a
 * shift). Returns a new indexed geometry in the same frame (normals recomputed, zero-area triangles dropped) and
 * stats { tris, conformed } (source triangles, how many of them were cut).
 */
export function conformGeometry(geo, { height = null, matrix = null, tol = 0.005 } = {}) {
  // (a terrain grid vertex: the drawn terrain's own cache, world.meshVertex; or height(x, z) there)
  const HV = height ? (i, j) => height(i * G, j * G) : (i, j) => world.meshVertex(i, j);
  const P = geo.attributes.position, I = geo.index ? geo.index.array : null, n0 = I ? I.length : P.count;
  const names = Object.keys(geo.attributes).filter((k) => k !== 'position' && k !== 'normal');
  const attrs = names.map((k) => geo.attributes[k]), sizes = attrs.map((a) => a.itemSize), stride = sizes.reduce((s, v) => s + v, 0);
  const inv = matrix ? matrix.clone().invert() : null, v3 = new THREE.Vector3();
  // the terrain's grid heights, cached (a dense grid over the mesh's extent: one road chunk, one yard)
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (let i = 0; i < P.count; i++) {
    v3.fromBufferAttribute(P, i); if (matrix) v3.applyMatrix4(matrix);
    bx0 = Math.min(bx0, v3.x); bx1 = Math.max(bx1, v3.x); bz0 = Math.min(bz0, v3.z); bz1 = Math.max(bz1, v3.z);
  }
  const gi0 = Math.floor(bx0 / G) - 1, gj0 = Math.floor(bz0 / G) - 1, gw = Math.floor(bx1 / G) - gi0 + 3, gh = Math.floor(bz1 / G) - gj0 + 3;
  const dense = P.count > 0 && gw * gh < 4e6, grid = dense ? new Float64Array(gw * gh).fill(NaN) : null, cellH = new Map();
  const hAt = dense
    ? (i, j) => { const k = (j - gj0) * gw + (i - gi0); let h = grid[k]; if (h !== h) h = grid[k] = HV(i, j); return h; }
    : (i, j) => { const k = (i + 2097152) * 4194304 + (j + 2097152); let h = cellH.get(k); if (h === undefined) { h = HV(i, j); cellH.set(k, h); } return h; };
  // the drawn terrain (as world.meshHeight, from the cached grid heights)
  // (corners weighing next to nothing not fetched: a point stored in 32 bits a hair off a grid line or point, as the
  // roads' are, would otherwise ask for terrain samples nothing else needs, each a full world.height)
  const EPS = 5e-4, mix = (i0, j0, k0, i1, j1, k1, i2 = 0, j2 = 0, k2 = 0) => {
    let h = 0, s = 0;
    if (k0 > EPS) { h += hAt(i0, j0) * k0; s += k0; }
    if (k1 > EPS) { h += hAt(i1, j1) * k1; s += k1; }
    if (k2 > EPS) { h += hAt(i2, j2) * k2; s += k2; }
    return h / s;
  };
  const drawn = (x, z) => {
    const i = Math.floor(x / G), j = Math.floor(z / G), tx = x / G - i, tz = z / G - j;
    if (tx + tz <= 1) return mix(i, j, 1 - tx - tz, i + 1, j, tx, i, j + 1, tz);
    return mix(i + 1, j + 1, tx + tz - 1, i, j + 1, 1 - tx, i + 1, j, 1 - tz);
  };
  // the source points in world space, their height over the drawn terrain and their attributes (flat)
  const nv = P.count, WX = new Float64Array(nv), WZ = new Float64Array(nv), GH = new Float64Array(nv), OFF = new Float64Array(nv), AT = new Float64Array(nv * stride);
  for (let i = 0; i < nv; i++) {
    v3.fromBufferAttribute(P, i); if (matrix) v3.applyMatrix4(matrix);
    WX[i] = v3.x; WZ[i] = v3.z; GH[i] = drawn(v3.x, v3.z); OFF[i] = v3.y - GH[i];
    for (let a = 0, o = i * stride; a < attrs.length; a++) for (let c = 0; c < sizes[a]; c++) AT[o++] = attrs[a].array[i * sizes[a] + c];
  }
  // the drawn terrain on one of its lines (f 0: x = kG, 1: z = kG, 2: x + z = kG, a cell's diagonal), from the two
  // grid points either side only (no other heights fetched: each one is a full terrain sample)
  const lineH = (f, k, x, z) => {
    if (f === 0) { const v = z / G, j = Math.floor(v), t = v - j; return mix(k, j, 1 - t, k, j + 1, t); }
    if (f === 1) { const u = x / G, i = Math.floor(u), t = u - i; return mix(i, k, 1 - t, i + 1, k, t); }
    const u = x / G, i = Math.floor(u), t = u - i; return mix(i, k - i, 1 - t, i + 1, k - i - 1, t);
  };
  // where the terrain's lines cross the edge a -> b: [t (0..1), f, k] in order
  const crossings = (ia, ib) => {
    const ax = WX[ia], az = WZ[ia], dx = WX[ib] - ax, dz = WZ[ib] - az, ts = [];
    for (let f = 0; f < 3; f++) {
      const p = f === 0 ? ax : f === 1 ? az : ax + az, dp = f === 0 ? dx : f === 1 ? dz : dx + dz;
      if (Math.abs(dp) < 1e-9) continue;
      const lo = Math.min(p, p + dp), hi = Math.max(p, p + dp);
      for (let k = Math.ceil(lo / G); k * G <= hi; k++) { const t = (k * G - p) / dp; if (t > 1e-6 && t < 1 - 1e-6) ts.push([t, f, k]); }
    }
    return ts.sort((a, b) => a[0] - b[0]);
  };
  // 1. which triangles the terrain bends under (by more than tol: its lines' crossings on the edges, its grid points inside)
  const nt = n0 / 3, bent = new Uint8Array(nt), canon = new Int32Array(nv), seen = new Map();
  for (let i = 0; i < nv; i++) { const k = (Math.round(WX[i] * 1000) + 2e7) * 4e7 + (Math.round(WZ[i] * 1000) + 2e7), c = seen.get(k); if (c === undefined) { seen.set(k, i); canon[i] = i; } else canon[i] = c; }
  const ekey = (ia, ib) => { const a = canon[ia], b = canon[ib]; return a < b ? a * nv + b : b * nv + a; }; // (an edge, by position)
  // the most the terrain rises over the straight edge a -> b (at its lines' crossings), once per edge
  const edgeErr = new Map();
  const riseOn = (ia, ib) => {
    const key = ekey(ia, ib);
    let e = edgeErr.get(key);
    if (e !== undefined) return e;
    e = 0;
    const ax = WX[ia], az = WZ[ia], dx = WX[ib] - ax, dz = WZ[ib] - az, ga = GH[ia], dg = GH[ib] - ga;
    for (let f = 0; f < 3; f++) {
      const p = f === 0 ? ax : f === 1 ? az : ax + az, dp = f === 0 ? dx : f === 1 ? dz : dx + dz;
      if (Math.abs(dp) < 1e-9) continue;
      const lo = Math.min(p, p + dp), hi = Math.max(p, p + dp);
      for (let k = Math.ceil(lo / G); k * G <= hi; k++) {
        const t = (k * G - p) / dp;
        if (t > 1e-6 && t < 1 - 1e-6) e = Math.max(e, lineH(f, k, ax + dx * t, az + dz * t) - (ga + dg * t));
      }
    }
    edgeErr.set(key, e);
    return e;
  };
  const splitEdges = new Set();
  let conformed = 0;
  for (let t = 0; t < nt; t++) {
    const ia = I ? I[t * 3] : t * 3, ib = I ? I[t * 3 + 1] : t * 3 + 1, ic = I ? I[t * 3 + 2] : t * 3 + 2;
    const ax = WX[ia], az = WZ[ia], bx = WX[ib], bz = WZ[ib], cx = WX[ic], cz = WZ[ic];
    const d = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(d) < 1e-9) continue;
    let err = Math.max(riseOn(ia, ib), riseOn(ib, ic), riseOn(ic, ia));
    if (err <= tol) {
      const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx), minz = Math.min(az, bz, cz), maxz = Math.max(az, bz, cz);
      for (let i = Math.ceil(minx / G); i * G <= maxx && err <= tol; i++) for (let j = Math.ceil(minz / G); j * G <= maxz; j++) {
        const x = i * G, z = j * G, l1 = ((x - ax) * (cz - az) - (z - az) * (cx - ax)) / d, l2 = ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / d;
        if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
        err = Math.max(err, hAt(i, j) - (GH[ia] * (1 - l1 - l2) + GH[ib] * l1 + GH[ic] * l2));
      }
    }
    if (err > tol) { bent[t] = 1; conformed++; splitEdges.add(ekey(ia, ib)); splitEdges.add(ekey(ib, ic)); splitEdges.add(ekey(ic, ia)); }
  }
  // 2. the output, welded (by position, and attributes where a seam carries two sets on one point)
  const pos = [], att = [], idx = [], weld = new Map(), tmp = new Float64Array(stride), outOf = new Int32Array(nv).fill(-1);
  const vert = (x, z, y) => {
    const k = (Math.round(x * 1000) + 2e7) * 4e7 + (Math.round(z * 1000) + 2e7);
    let list = weld.get(k);
    if (list) for (const i of list) { let same = true; for (let c = 0; c < stride && same; c++) same = Math.abs(att[i * stride + c] - tmp[c]) < 1e-4; if (same) return i; }
    const i = pos.length / 3; pos.push(x, y, z); for (let c = 0; c < stride; c++) att.push(tmp[c]);
    if (list) list.push(i); else weld.set(k, [i]);
    return i;
  };
  for (let t = 0; t < nt; t++) {
    const ia = I ? I[t * 3] : t * 3, ib = I ? I[t * 3 + 1] : t * 3 + 1, ic = I ? I[t * 3 + 2] : t * 3 + 2;
    const ax = WX[ia], az = WZ[ia], bx = WX[ib], bz = WZ[ib], cx = WX[ic], cz = WZ[ic];
    const d = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(d) < 1e-9) continue; // (nothing drawn: a cut-away fold)
    // a point in plan: barycentric in the source triangle; on the drawn terrain + the clearance there (onGround), or
    // in the source triangle's own plane
    const at = (x, z, onGround, hGround) => {
      const l1 = ((x - ax) * (cz - az) - (z - az) * (cx - ax)) / d, l2 = ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / d, l0 = 1 - l1 - l2;
      for (let c = 0; c < stride; c++) tmp[c] = AT[ia * stride + c] * l0 + AT[ib * stride + c] * l1 + AT[ic * stride + c] * l2;
      const g = onGround ? (hGround ?? drawn(x, z)) : GH[ia] * l0 + GH[ib] * l1 + GH[ic] * l2;
      return vert(x, z, g + OFF[ia] * l0 + OFF[ib] * l1 + OFF[ic] * l2);
    };
    const emit = (ids) => { // (a convex fan, in the source's winding)
      const u = ids.filter((id, k) => id !== ids[(k + ids.length - 1) % ids.length]);
      for (let k = 1; k < u.length - 1; k++) idx.push(u[0], u[k], u[k + 1]);
    };
    if (!bent[t]) {
      const own = (i) => { if (outOf[i] < 0) { for (let c = 0; c < stride; c++) tmp[c] = AT[i * stride + c]; outOf[i] = vert(WX[i], WZ[i], GH[i] + OFF[i]); } return outOf[i]; };
      if (!splitEdges.size || !(splitEdges.has(ekey(ia, ib)) || splitEdges.has(ekey(ib, ic)) || splitEdges.has(ekey(ic, ia)))) {
        const A = own(ia), B = own(ib), C = own(ic);
        if (A !== B && B !== C && C !== A) idx.push(A, B, C);
        continue;
      }
      const sp = [[ia, ib], [ib, ic], [ic, ia]].map(([p, q]) => (splitEdges.has(ekey(p, q)) ? crossings(p, q) : []));
      // its shared edges take the bent neighbour's points; fanned from its middle (in its own plane)
      const ring = [];
      [[ia, ib], [ib, ic], [ic, ia]].forEach(([p, q], e) => {
        ring.push(at(WX[p], WZ[p], false));
        for (const [s, f, k] of sp[e]) { const x = WX[p] + (WX[q] - WX[p]) * s, z = WZ[p] + (WZ[q] - WZ[p]) * s; ring.push(at(x, z, true, lineH(f, k, x, z))); }
      });
      const mid = at((ax + bx + cx) / 3, (az + bz + cz) / 3, false);
      for (let k = 0; k < ring.length; k++) if (ring[k] !== ring[(k + 1) % ring.length]) idx.push(mid, ring[k], ring[(k + 1) % ring.length]);
      continue;
    }
    const s = d > 0 ? 1 : -1, T = [[ax, az], [bx, bz], [cx, cz]];
    const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx), minz = Math.min(az, bz, cz), maxz = Math.max(az, bz, cz);
    for (let i = Math.floor(minx / G); i <= Math.floor(maxx / G); i++) for (let j = Math.floor(minz / G); j <= Math.floor(maxz / G); j++) {
      const x0 = i * G, z0 = j * G, x1 = x0 + G, z1 = z0 + G, h00 = hAt(i, j), h10 = hAt(i + 1, j), h01 = hAt(i, j + 1), h11 = hAt(i + 1, j + 1);
      for (let half = 0; half < 2; half++) {
        let p = half ? [[x1, z1], [x1, z0], [x0, z1]] : [[x0, z0], [x0, z1], [x1, z0]];
        for (let e = 0; e < 3 && p.length >= 3; e++) p = clipEdge(p, T[e][0], T[e][1], T[(e + 1) % 3][0], T[(e + 1) % 3][1], s);
        if (p.length < 3) continue;
        const ids = p.map(([x, z]) => {
          const tx = (x - x0) / G, tz = (z - z0) / G; // (the half cell's own plane)
          return at(x, z, true, half ? h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz) : h00 + (h10 - h00) * tx + (h01 - h00) * tz);
        });
        if (s > 0) ids.reverse(); // (a half cell runs the other way round in plan: the source's own winding kept)
        emit(ids);
      }
    }
  }
  const n = pos.length / 3, out = new THREE.BufferGeometry(), PP = new Float32Array(pos.length);
  for (let i = 0; i < n; i++) {
    v3.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); if (inv) v3.applyMatrix4(inv);
    PP[i * 3] = v3.x; PP[i * 3 + 1] = v3.y; PP[i * 3 + 2] = v3.z;
  }
  out.setAttribute('position', new THREE.BufferAttribute(PP, 3));
  for (let a = 0, off = 0; a < attrs.length; off += sizes[a], a++) {
    const A = new Float32Array(n * sizes[a]);
    for (let i = 0; i < n; i++) for (let c = 0; c < sizes[a]; c++) A[i * sizes[a] + c] = att[i * stride + off + c];
    out.setAttribute(names[a], new THREE.BufferAttribute(A, sizes[a], attrs[a].normalized));
  }
  out.setIndex(idx);
  out.computeVertexNormals();
  out.userData.conform = { tris: nt, conformed };
  return out;
}

/**
 * Paving drawn a hair toward the camera (a share of its distance, as the roads and car parks are: bus.js
 * ROAD_DECAL 0.0015; their markings 0.0019): up close the patch's own few cm over the drawn terrain keep it clear,
 * far off the coarser terrain LODs (4 m / 8 m triangles, up to ~0.4 m over the 2 m ones) can't cover it either.
 * Chains a material's own onBeforeCompile / customProgramCacheKey.
 */
export function groundDecal(mat, k = 0.0015) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      mvPosition.xyz *= ${(1 - k).toFixed(5)};
      gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}-gdecal${k}`;
  return mat;
}
