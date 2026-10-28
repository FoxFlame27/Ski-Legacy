// Pure 2D placement math for build mode (no three.js: unit-testable in Node).
// Footprint = oriented box { x, z, hw, hd, rot } (rot about +y, model front = +z).
// Rect = { x0, z0, x1, z1 } floor area. Wall = { ax, az, bx, bz, t } segment with thickness t.

export const GRID = 0.25;
export const snap = (v, g = GRID) => Math.round(v / g) * g;

const axes = (rot) => {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[c, -s], [s, c]]; // local x axis, local z axis in world xz (three.js y-rotation)
};

export function corners(f) {
  const [ux, uz] = axes(f.rot);
  const out = [];
  for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    out.push([f.x + ux[0] * f.hw * a + uz[0] * f.hd * b, f.z + ux[1] * f.hw * a + uz[1] * f.hd * b]);
  }
  return out;
}

const inRect = (x, z, r, e = 0.02) => x >= r.x0 - e && x <= r.x1 + e && z >= r.z0 - e && z <= r.z1 + e;
export const pointOnFloor = (x, z, rects) => rects.some((r) => inRect(x, z, r));
/** Every corner (and the centre) of the footprint lies on the floor. */
export const onFloor = (f, rects) => pointOnFloor(f.x, f.z, rects) && corners(f).every(([x, z]) => pointOnFloor(x, z, rects));

/** Oriented boxes overlap (SAT), with a small tolerance so flush furniture is allowed. */
export function boxesOverlap(a, b, tol = 0.01) {
  const ca = corners(a), cb = corners(b);
  for (const f of [a, b]) {
    for (const [ax, az] of axes(f.rot)) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, z] of ca) { const p = x * ax + z * az; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
      for (const [x, z] of cb) { const p = x * ax + z * az; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
      if (a1 - tol <= b0 || b1 - tol <= a0) return false;
    }
  }
  return true;
}

/** Wall segment (thickened by t/2) crosses the footprint. */
export function boxHitsWall(f, w, tol = 0.01) {
  const [ux, uz] = axes(f.rot);
  const loc = (x, z) => { const dx = x - f.x, dz = z - f.z; return [dx * ux[0] + dz * ux[1], dx * uz[0] + dz * uz[1]]; };
  const [px, pz] = loc(w.ax, w.az), [qx, qz] = loc(w.bx, w.bz);
  const h = (w.t || 0.2) / 2 - tol;
  const ex = f.hw + h, ez = f.hd + h; // slab test of the segment against the expanded box
  let t0 = 0, t1 = 1;
  for (const [p, d, e] of [[px, qx - px, ex], [pz, qz - pz, ez]]) {
    if (Math.abs(d) < 1e-9) { if (p < -e || p > e) return false; continue; }
    let a = (-e - p) / d, b = (e - p) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}

/** Push the footprint flush against any wall it is within `reach` metres of. Mutates and returns f. */
export function snapToWalls(f, walls, reach = 0.35) {
  const [ux, uz] = axes(f.rot);
  for (const w of walls) {
    const dx = w.bx - w.ax, dz = w.bz - w.az, L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const tx = dx / L, tz = dz / L, nx = -tz, nz = tx;
    const along = (f.x - w.ax) * tx + (f.z - w.az) * tz;
    const supT = f.hw * Math.abs(ux[0] * tx + ux[1] * tz) + f.hd * Math.abs(uz[0] * tx + uz[1] * tz);
    if (along + supT < 0.05 || along - supT > L - 0.05) continue; // not beside this wall
    const dist = (f.x - w.ax) * nx + (f.z - w.az) * nz;
    const supN = f.hw * Math.abs(ux[0] * nx + ux[1] * nz) + f.hd * Math.abs(uz[0] * nx + uz[1] * nz);
    const gap = Math.abs(dist) - supN - (w.t || 0.2) / 2;
    if (Math.abs(gap) > 0.001 && gap > -0.15 && gap < reach) { // (also pushes out of a slight overlap)
      const s = Math.sign(dist) || 1;
      f.x -= nx * s * gap; f.z -= nz * s * gap;
    }
  }
  return f;
}

/** Ray (origin o, dir d in xz) against wall segments: nearest hit { wall, x, z, dist, nx, nz } facing the ray origin. */
export function rayWall(ox, oz, dx, dz, walls, maxDist = 8) {
  let best = null;
  for (const w of walls) {
    const ex = w.bx - w.ax, ez = w.bz - w.az, L = Math.hypot(ex, ez);
    if (L < 1e-6) continue;
    let nx = -ez / L, nz = ex / L;
    if ((ox - w.ax) * nx + (oz - w.az) * nz < 0) { nx = -nx; nz = -nz; } // the face toward us
    const off = (w.t || 0.2) / 2;
    const ax = w.ax + nx * off, az = w.az + nz * off; // the wall surface line
    const dn = dx * nx + dz * nz;
    if (dn >= -1e-6) continue; // looking away from (or along) this face
    const t = ((ax - ox) * nx + (az - oz) * nz) / dn;
    if (t < 0 || t > maxDist) continue;
    const hx = ox + dx * t, hz = oz + dz * t;
    const s = ((hx - ax) * ex + (hz - az) * ez) / (L * L);
    if (s < 0 || s > 1) continue;
    if (!best || t < best.dist) best = { wall: w, x: hx, z: hz, dist: t, nx, nz, s, L };
  }
  return best;
}

/**
 * How to fit a model with raw bounding-box size d = [x, y, z] to a catalog item (pure, for Node checks).
 * Returns { layFlat, turn, scale: [sx, sy, sz] }: first lay it flat (rotate -90 deg about x) if `layFlat`,
 * then turn it 90 deg about y if `turn`, then scale by `scale` (in the turned frame). Height is matched
 * exactly (flat items: width); width and depth each follow the catalog within -23%..+30% of the height scale.
 */
export function fitScales(item, d) {
  let [dx, dy, dz] = d;
  const [w, h, dd] = item.size;
  const layFlat = !!item.flat && dy > dz * 2; // a rug modelled standing up
  if (layFlat) [dy, dz] = [dz, dy];
  const turn = (w > dd * 1.3 && dz > dx * 1.3) || (dd > w * 1.3 && dx > dz * 1.3);
  if (turn) [dx, dz] = [dz, dx];
  if (item.flat) {
    const s = Math.sqrt((w / dx) * (dd / dz));
    return { layFlat, turn, scale: [s, Math.min(s, h / dy), s] };
  }
  const sy = h / dy;
  const clamp = (v) => Math.min(sy * 1.3, Math.max(sy * 0.77, v));
  const sx = clamp(w / dx);
  const sz = item.place === 'wall' ? Math.min(clamp(dd / dz), dd / dz) : clamp(dd / dz);
  return { layFlat, turn, scale: [sx, sy, sz] };
}

/** Local bulb point of a lamp (object frame: see makeFurnitureObject), dims = { x, y, z } scaled size. */
export function lampLocal(item, dims) {
  const f = item.light ?? 0.8;
  if (item.place === 'ceiling') return { x: 0, y: -dims.y * f, z: 0 };
  if (item.place === 'wall') return { x: 0, y: dims.y * f, z: dims.z * 0.6 };
  return { x: 0, y: dims.y * f, z: 0 };
}
/** World-of-root bulb point of a placed lamp record { x, y, z, rot }. */
export function lampPoint(item, dims, rec) {
  const l = lampLocal(item, dims), c = Math.cos(rec.rot || 0), s = Math.sin(rec.rot || 0);
  return { x: rec.x + l.x * c + l.z * s, y: rec.y + l.y, z: rec.z - l.x * s + l.z * c };
}

/** Ray (o, d: {x,y,z}) against window sills [{ x, z, y, len, depth, yaw }] (yaw: into the room).
 *  Nearest hit within maxT: { sill, t, u (along, from the centre), v (across), x, y, z }. */
export function raySill(o, d, sills, maxT = 6) {
  let best = null;
  for (const s of sills) {
    if (Math.abs(d.y) < 1e-4) continue;
    const t = (s.y - o.y) / d.y;
    if (t <= 0 || t > maxT || (best && t >= best.t)) continue;
    const px = o.x + d.x * t, pz = o.z + d.z * t;
    const ix = Math.sin(s.yaw), iz = Math.cos(s.yaw), ax = Math.cos(s.yaw), az = -Math.sin(s.yaw);
    const u = (px - s.x) * ax + (pz - s.z) * az, v = (px - s.x) * ix + (pz - s.z) * iz;
    const m = 0.06; // a little slack round the ledge
    if (Math.abs(u) > s.len / 2 + m || Math.abs(v) > s.depth / 2 + m) continue;
    best = { sill: s, t, u, v, x: px, y: s.y, z: pz };
  }
  return best;
}
