// The scenic roads' traffic routes (traffic.js drives the cars along them). Each car follows its own path: a random
// walk over the scenic network's graph (scenicloop.js scenicGraph), in the right-hand lane, anticlockwise round each
// single-lane roundabout and out at a random other arm, round in a car park's aisle with a pause for the view,
// across a T junction onto either other way, turning round in the mouth of a junction with a valley road. The path
// is built a few junctions ahead and extended as the car goes (it always ends half way along a road, so the next
// piece carries straight on). Pure layout (no THREE).
import { busRoads, roadAt } from './roads.js';
import { scenicGraph } from './scenicloop.js';

const TRIM = { ring: 12, lot: 2, tee: 9, exit: 10 };
const P = {};

/** A random place on the scenic network: { e, dir, s } (rand: () => 0..1; near: { x, z, min, max } to aim for). */
export function scenicSpawn(rand = Math.random, near = null, ok = null) {
  const G = scenicGraph();
  const edges = G.edges.filter((e) => e.s1 - e.s0 > 40);
  if (!edges.length) return null;
  const total = edges.reduce((a, e) => a + (e.s1 - e.s0), 0);
  for (let tries = 0; tries < (near ? 60 : 1); tries++) {
    let t = rand() * total, e = edges[0];
    for (const q of edges) { t -= q.s1 - q.s0; if (t <= 0) { e = q; break; } }
    const s = e.s0 + 15 + rand() * (e.s1 - e.s0 - 30), dir = rand() < 0.5 ? 1 : -1;
    if (near) {
      roadAt(e.road, s, P);
      const d = Math.hypot(P.x - near.x, P.z - near.z);
      if (d < near.min || d > near.max || (ok && !ok(P.x, P.z))) continue;
    }
    return { e, dir, s };
  }
  return null;
}

/**
 * The path from state { e, dir, s } through `legs` junctions: { X, Z (every 2 m), L, entries: [{ u, ring }],
 * pauses: [u], exits: [u], end: state }. lane: the offset of the right-hand lane from the centre line (m).
 */
export function scenicWalk(st, lane = 1.6, legs = 6, rand = Math.random) {
  const pts = [], marks = [];
  const along = (r, s0, s1) => { // the right-hand lane from s0 to s1 (either way)
    const dir = s1 >= s0 ? 1 : -1, n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 2));
    for (let i = 0; i <= n; i++) { const s = s0 + ((s1 - s0) * i) / n; roadAt(r, s, P); const tx = P.dx * dir, tz = P.dz * dir; pts.push([P.x - tz * lane, P.z + tx * lane]); }
  };
  const trimFor = (n) => TRIM[n.kind] ?? 10;
  // the far end of edge e going `dir`, its node and the lane's stopping point
  const farEnd = (e, dir) => (dir > 0 ? { n: e.n1, end: 1, s: e.s1 - trimFor(e.n1) } : { n: e.n0, end: 0, s: e.s0 + trimFor(e.n0) });
  const nearStart = (e, end) => (end === 0 ? { dir: 1, s: e.s0 + trimFor(e.n0) } : { dir: -1, s: e.s1 - trimFor(e.n1) });
  let { e, dir, s } = st;
  for (let k = 0; k < legs; k++) {
    const f = farEnd(e, dir);
    if ((f.s - s) * dir > 0) along(e.road, s, f.s);
    const N = f.n;
    let next = null; // { e, end } the link we leave by
    if (N.kind === 'ring') {
      const ring = N.ring;
      const outs = N.links.filter((l) => l.e !== e || l.end !== f.end);
      const L = outs.length ? outs[Math.floor(rand() * outs.length)] : { e, end: f.end };
      const angOf = (ed, end) => { roadAt(ed.road, end === 0 ? ed.s0 + TRIM.ring : ed.s1 - TRIM.ring, P); return Math.atan2(P.x - ring.x, P.z - ring.z); };
      const a0 = angOf(e, f.end), a1 = angOf(L.e, L.end);
      let d = a1 - a0;
      while (d <= 0.25) d += Math.PI * 2; // (anticlockwise: increasing angle)
      marks.push(['entry', pts.length, ring]);
      const n = Math.ceil((d * ring.R) / 2);
      for (let i = 1; i < n; i++) { const a = a0 + (d * i) / n; pts.push([ring.x + Math.sin(a) * ring.R, ring.z + Math.cos(a) * ring.R]); }
      next = L;
    } else if (N.kind === 'lot') {
      const Lt = N.lot, ax = Lt.dirx, az = Lt.dirz, bx = -az, bz = ax, cx = Lt.x - ax * 2, cz = Lt.z - az * 2;
      pts.push([Lt.ex, Lt.ez], [Lt.ex - ax * 4 + bx * 1.6, Lt.ez - az * 4 + bz * 1.6]);
      marks.push(['pause', pts.length]);
      for (let i = 0; i <= 10; i++) { const t = (i / 10) * Math.PI; pts.push([cx + bx * 4 * Math.cos(t) - ax * 4 * Math.sin(t), cz + bz * 4 * Math.cos(t) - az * 4 * Math.sin(t)]); }
      pts.push([Lt.ex - ax * 4 - bx * 1.6, Lt.ez - az * 4 - bz * 1.6], [Lt.ex, Lt.ez]);
      next = { e, end: f.end };
    } else if (N.kind === 'tee') {
      const outs = N.links.filter((l) => l.e !== e || l.end !== f.end);
      next = outs.length ? outs[Math.floor(rand() * outs.length)] : { e, end: f.end };
      const ns = nearStart(next.e, next.end);
      roadAt(next.e.road, ns.s, P);
      const tx = P.dx * ns.dir, tz = P.dz * ns.dir, bx = P.x - tz * lane, bz = P.z + tx * lane, a = pts[pts.length - 1];
      const cx = N.x, cz = N.z;
      for (let i = 1; i < 8; i++) { const t = i / 8, u = 1 - t; pts.push([u * u * a[0] + 2 * u * t * cx + t * t * bx, u * u * a[1] + 2 * u * t * cz + t * t * bz]); }
    } else { // an exit: the junction with a valley road (the car may leave there, out of sight; else it turns round)
      marks.push(['exit', pts.length]);
      roadAt(e.road, f.s, P);
      const tx = P.dx * dir, tz = P.dz * dir, cx = P.x + tx * 4, cz = P.z + tz * 4;
      for (let i = 1; i < 10; i++) { const a = (i / 10) * Math.PI; pts.push([cx - tz * lane * Math.cos(a) + tx * lane * 1.6 * Math.sin(a), cz + tx * lane * Math.cos(a) + tz * lane * 1.6 * Math.sin(a)]); }
      next = { e, end: f.end };
    }
    const ns = nearStart(next.e, next.end);
    e = next.e; dir = ns.dir; s = ns.s;
  }
  // end half way along the next road (or ~60 m on): the next piece carries on straight from there
  const fe = farEnd(e, dir), sEnd = s + dir * Math.min(60, Math.abs(fe.s - s) / 2);
  along(e.road, s, sEnd);
  const end = { e, dir, s: sEnd };
  // corners rounded (Chaikin, twice; the ends kept), then every 2 m
  let p = pts;
  for (let k = 0; k < 2; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) { const a = p[i], b = p[i + 1]; q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
    q.push(p[p.length - 1]);
    p = q;
  }
  const X = [], Z = [];
  let carry = 0;
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = carry;
    while (t < l) { X.push(a[0] + ((b[0] - a[0]) * t) / (l || 1)); Z.push(a[1] + ((b[1] - a[1]) * t) / (l || 1)); t += 2; }
    carry = t - l;
  }
  if (!X.length) { X.push(p[0][0]); Z.push(p[0][1]); }
  // the marks: the raw point's position, its arc length on the smoothed line (raw index i -> smoothed ~ i * 4)
  const uOf = (i) => { const j = Math.min(cum.length - 1, Math.max(0, i * 4)); return cum[j]; };
  const entries = [], pauses = [], exits = [];
  for (const [kind, i, ring] of marks) { const u = uOf(i); if (kind === 'entry') entries.push({ u, ring }); else if (kind === 'pause') pauses.push(u); else exits.push(u); }
  return { X, Z, L: (X.length - 1) * 2, entries, pauses, exits, end };
}

/** Is there a scenic network to drive? */
export function scenicNetReady() {
  if (!busRoads.roads.some((r) => r.scenic)) return false;
  return scenicGraph().edges.length > 0;
}
