// Road tunnels (Oct 31 2026, the user: "add tunnels for the cars, so like roads going through tunnels, but don't add
// any new roads"): where a scenic road ran through a ridge or a spur in a deep open cutting (the mountain standing
// 10 m and more over the road for a long stretch), that stretch is now a road tunnel. No road is added, removed or
// rerouted: the same polyline, the same heights; only how the stretch is built changes.
//  - planRoadTunnels(roads) (scenic.js shapeScenic, before its cut): along every scenic road the cover (the natural
//    ground over the road, the least of the centre line and 6.5 m either side) and the places a tunnel may not be
//    (the road's ends, junctions, roundabouts, car parks, lay-bys, bus stops, the village, the chalet village site,
//    pistes, lifts, buildings, the railway and the Legacy Express, another road or another leg of the same road
//    nearby). Each stretch with >= PORTAL_COVER m of cover all along, >= DEEP m somewhere and >= MIN_LEN m long whose
//    portal approaches are clear too is a candidate; the best MAX_N (longest and deepest) are built. busRoads.tunnels.
//  - the terrain, cut-and-cover like the secrets' tunnels (world/secrets.js defineTunnel): the scenic cut leaves the
//    tunnel stretch out (tunnelCore: no open cutting there, the natural ground stays over it) and its cutting ends at
//    each portal in an end slope (tunnelEnd: a concrete headwall HP m high at the portal plane, the slope above it at
//    the cutting's own batter, back up to the natural ground); the trench under the mountain (the slot) is a covered
//    cut, so the coarse LODs and world.outsideHeight keep the mountain whole and a lid (secrets/lid.js) closes it
//    from above at the finest LOD
//  - world.groundHeight inside is the road (the slot's floor is the road's own height); the mountain over it is a
//    surface ridden from above (its `over`: anyone above the tube's crown is on the mountain, anyone inside is on the
//    road: every vehicle asks with its own height as yHint)
//  - the meshes (tube, portals, lights, the rock walls of the cuttings, the lid) are built near the camera:
//    tunnelview.js; inRoadTunnel / busRoads.tunnelAt answer "is this point inside a tunnel" (weather, police sight)
// Pure layout (no THREE): runs in Node with the road planning.
import { world } from '../../world/world.js';
import { Path } from '../../world/secrets/path.js';
import { expressNearest } from '../../world/expressroute.js';
import { inChaletSite } from './chaletroad.js';
import { busRoads, roadAt } from './roads.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// the tube: a 2-lane road (6.8 m) + a 1.2 m kerb each side; walls to 4.4 m, a flat arch to 6.6 m (5.9 m clear at the
// lanes' outer edges: the 12 m bus and the tow truck fit)
export const TUBE = { Wi: 4.6, Hs: 4.4, Hc: 6.6, kerb: 0.22 };
const PORTAL_COVER = 10;   // m of mountain over the road where a portal stands (and all along the tunnel)
const DEEP = 15;           // m: the deepest cover a tunnel must reach somewhere
const MIN_LEN = 80;        // m between the portals at least
const APP = 30;            // m clear of junctions, stops, lay-bys... before each portal (the headwall, its wings)
const MAX_N = 6;
export const HP = 9.2;     // m: the portal headwall over the road (the end slope starts on its top)
const K_END = 0.8;         // the end slope over a portal (the scenic cut's own batter: scenic.js CUT_K)
// the trench's half-width: its flat floor (the road's height) reaches 3.2 m past the tube's wall, so no triangle of the
// finest terrain mesh (a 2 m grid: 2.83 m across) that has a corner up on the trench's steep side wall reaches back
// over the tube's wall into it (Oct 31 2026, the user, of a road tunnel: "this black pointy thing is wrong"; with the
// floor only 1.6 m past the wall (Wi + 1.6) such triangles leaned 0.3-2.7 m high into the tube along its walls, the
// whole tunnel long: dark terrain slivers just in front of the white wall)
const SLOT = TUBE.Wi + 3.2;
const LID_MIN = 1.2;       // m: the lid (the mountain drawn over the trench) at least this far over the tube's crown
const LID_PORTAL = 3;      // m in front of each portal plane where the lid's grid corners are lifted (> 2.83: a cell)
// (Austrian names, west to east: "Kalkwand-Tunnel" in the Austrian style)
const NAMES = ['Kalkwand-Tunnel', 'Lärchkogel-Tunnel', 'Gamsleiten-Tunnel', 'Schrofen-Tunnel', 'Steinbock-Tunnel', 'Hochalm-Tunnel', 'Zirbenwald-Tunnel', 'Felsentor-Tunnel'];
const P = {}, Q = {};

/** Plan the tunnels on the scenic roads (heights final, before the scenic cut is registered). -> busRoads.tunnels */
export function planRoadTunnels(roads) {
  const list = (busRoads.tunnels = []);
  if (globalThis.__noRoadTunnels) return list; // (Node checks: the network as it was)
  const O = busRoads.obstacles, OQ = {};
  // every road's samples in a 32 m grid (another road, or another leg of the same road, too near a tunnel)
  const G = 32, grid = new Map();
  busRoads.roads.forEach((r) => {
    for (let i = 0; i < r.n; i += 2) {
      const k = Math.floor(r.X[i] / G) * 65536 + Math.floor(r.Z[i] / G);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([r.X[i], r.Z[i], r, r.S[i]]);
    }
  });
  const crowded = (r, x, z, s, R = 70) => {
    for (let gx = Math.floor((x - R) / G); gx <= Math.floor((x + R) / G); gx++) for (let gz = Math.floor((z - R) / G); gz <= Math.floor((z + R) / G); gz++) {
      for (const [px, pz, o, os] of grid.get(gx * 65536 + gz) || []) {
        if (o === r && Math.abs(os - s) < 260) continue;
        if (Math.hypot(px - x, pz - z) < R) return true;
      }
    }
    return false;
  };
  const scStop = busRoads.scenic?.climb; // (the "Panorama Kehre" stop half way up the climb: scenicbus.js, planned later)
  const cands = [];
  for (const r of roads) {
    if (r.ringRoad || r.chalet || r.length < 2 * APP + MIN_LEN + 120) continue;
    const ri = busRoads.roads.indexOf(r), n = r.n, L = r.length;
    const cover = new Float32Array(n), bad = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = r.X[i], z = r.Z[i], s = r.S[i];
      roadAt(r, s, P);
      let c = Infinity;
      for (const o of [-6.5, 0, 6.5]) c = Math.min(c, world.height(x - P.dz * o, z + P.dx * o) - r.Y[i]);
      cover[i] = c;
      let b = s < 120 || s > L - 120 || Math.hypot(x, z) < 320 || inChaletSite(x, z);
      if (!b && O) { O.query(x, z, OQ); b = OQ.ski < 22 || OQ.lift < 28 || OQ.block < 18 || OQ.rail < 30 || OQ.net < 10; }
      if (!b) { const e = expressNearest(x, z); b = !!(e && e.d < 45); }
      if (!b) for (const j of busRoads.junctions) if (Math.hypot(j.x - x, j.z - z) < 110) { b = true; break; }
      if (!b) for (const g of busRoads.roundabouts || []) if (Math.hypot(g.x - x, g.z - z) < (g.R || 15) + 130) { b = true; break; }
      if (!b) for (const l of busRoads.lots) if (Math.hypot(l.x - x, l.z - z) < (l.hw || 10) + (l.hd || 10) + 60) { b = true; break; }
      if (!b) for (const lb of busRoads.laybys || []) if ((lb.ri === ri && Math.abs(lb.s - s) < 70) || Math.hypot(lb.x - x, lb.z - z) < 70) { b = true; break; }
      if (!b) for (const st of busRoads.stops) if (Math.hypot(st.x - x, st.z - z) < 110) { b = true; break; }
      if (!b && r === scStop && Math.abs(s - L * 0.5) < 110) b = true;
      if (!b) b = crowded(r, x, z, s);
      bad[i] = b ? 1 : 0;
    }
    // (a portal's approach must be clear too: the bad places grown by the approach + 10 m along the road)
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!bad[i]) continue;
      for (let j = i; j >= 0 && r.S[i] - r.S[j] <= APP + 10; j--) near[j] = 1;
      for (let j = i; j < n && r.S[j] - r.S[i] <= APP + 10; j++) near[j] = 1;
    }
    let i0 = -1;
    for (let i = 0; i <= n; i++) {
      const ok = i < n && !near[i] && cover[i] >= PORTAL_COVER;
      if (ok && i0 < 0) i0 = i;
      if (!ok && i0 >= 0) {
        const i1 = i - 1, len = r.S[i1] - r.S[i0];
        let deep = 0, sum = 0;
        for (let k = i0; k <= i1; k++) { deep = Math.max(deep, cover[k]); sum += cover[k]; }
        if (len >= MIN_LEN && deep >= DEEP) cands.push({ r, ri, sF0: r.S[i0], sF1: r.S[i1], len, deep, mean: sum / (i1 - i0 + 1), score: len * Math.min(40, sum / (i1 - i0 + 1)) });
        i0 = -1;
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const pick = cands.slice(0, MAX_N);
  // named west to east
  pick.sort((a, b) => roadAt(a.r, (a.sF0 + a.sF1) / 2, P).x - roadAt(b.r, (b.sF0 + b.sF1) / 2, Q).x);
  pick.forEach((c, k) => list.push(makeTunnel(c, NAMES[k % NAMES.length])));
  for (const t of list) (t.road.tunnels ||= []).push(t);
  return list;
}

// One tunnel on road c.r between the portal planes c.sF0 / c.sF1 (road arc lengths): its centre line (a Path over
// the road's own samples, from before the first approach to after the second, path s = road s - off), floor (the
// road's own height), the cuts, and the queries.
function makeTunnel(c, name) {
  const r = c.r, { Wi, Hc } = TUBE;
  const off = Math.max(0, c.sF0 - APP - 30), end = Math.min(r.length, c.sF1 + APP + 30);
  const pts = [];
  for (let s = off; s < end; s += 2) { roadAt(r, s, P); pts.push([P.x, P.z]); }
  roadAt(r, end, P); pts.push([P.x, P.z]);
  const path = new Path(pts, { step: 1.5, smooth: false, reach: 90 });
  const pF0 = c.sF0 - off, pF1 = c.sF1 - off;
  const F = {};
  const floor = (ps) => roadAt(r, off + ps, F).y;
  // the trench under the mountain (covered: the coarse LODs and world.outsideHeight skip it): the road's height
  // across SLOT m either side, vertical walls beyond, between the portal planes
  const slotSurface = (ps, ad) => (ps < pF0 - 0.3 || ps > pF1 + 0.3 ? Infinity : floor(ps) + Math.max(0, ad - SLOT) * 40);
  const SP = {};
  const slot = {
    covered: true, roadTunnel: true,
    bounds: { minx: path.bounds.minx, minz: path.bounds.minz, maxx: path.bounds.maxx, maxz: path.bounds.maxz },
    apply(x, z, h) {
      path.project(x, z, SP);
      if (SP.dist === Infinity || SP.dist > SLOT + 30) return h;
      const t = slotSurface(SP.s, Math.abs(SP.d));
      return t < h ? t : h;
    },
  };
  // The lid over the trench (tunnelview.js, secrets/lid.js: a copy of the finest terrain mesh, clipped at the portal
  // planes) and the mountain ridden over the tube (addTunnelCuts) take their heights from lidLift and their carved
  // corners from lidCut. (Oct 31 2026, the user, at night looking into the Kalkwand-Tunnel: "tunnels are good but this
  // black pointy thing is wrong": a big black wedge in the tube's upper right a few metres in, from the ceiling down
  // to the road. It was the lid: its 2 m grid triangles that cross a portal plane have corners in front of it, down in
  // the open cutting at the road's height, and the lid clipped at the plane took its height there from them, so its
  // first metre or two sloped down from the end slope's top (HP over the road) into the tube, as low as the road,
  // with the terrain's material, unlit by the tube's lamps: black. Found in all six tunnels (Node check: up to 5.8 m
  // into the tube, within 1 m of a portal plane), and inside the lid stood only 0.2 m over the crown in places, under
  // it by 0.9 m at the Schrofen-Tunnel's east portal.) Now:
  //  - every lid corner over the trench between the portal planes stands at least LID_MIN over the crown
  //  - its corners up to LID_PORTAL m in front of a portal plane, across the tube and a cell beyond, stand on the
  //    headwall's top (HP over the road, inside the 3.6 m deep headwall: hidden), so the clipped edge at the plane is
  //    over the crown too
  //  - lidCut counts those front corners as carved, so the lid takes every triangle round them: its outer edges keep
  //    the terrain's own heights (no crack where the lid meets the terrain)
  const LQ = {};
  const portalZone = (ps, ad) => ad <= Wi + LID_PORTAL && ((ps >= pF0 - LID_PORTAL && ps < pF0) || (ps > pF1 && ps <= pF1 + LID_PORTAL));
  const lidCut = (x, z) => {
    path.project(x, z, LQ);
    if (LQ.dist === Infinity) return Infinity;
    return portalZone(LQ.s, Math.abs(LQ.d)) ? -Infinity : slotSurface(LQ.s, Math.abs(LQ.d));
  };
  const lidLift = (x, z, h) => {
    path.project(x, z, LQ);
    if (LQ.dist === Infinity) return h;
    const ps = LQ.s, ad = Math.abs(LQ.d);
    if (portalZone(ps, ad)) return Math.max(h, floor(ps) + HP);
    if (ps >= pF0 && ps <= pF1 && slotSurface(ps, ad) < h - 0.01) return Math.max(h, floor(ps) + Hc + LID_MIN);
    return h;
  };
  const mid = path.at((pF0 + pF1) / 2, {});
  const t = {
    name, road: r, ri: c.ri, sF0: c.sF0, sF1: c.sF1, length: c.sF1 - c.sF0,
    deep: c.deep, path, off, pF0, pF1, floor, slot, slotSurface, slotHalf: SLOT, HP, lidCut, lidLift,
    center: { x: mid.x, z: mid.z },
    /** (x, y, z) inside the tube (y: optional; under the crown) */
    inside(x, y, z, pad = 0.4) {
      path.project(x, z, Q);
      if (Q.dist === Infinity || Q.s < pF0 - 3 || Q.s > pF1 + 3 || Math.abs(Q.d) > Wi + pad) return false;
      return y === undefined || y === null || (y < floor(Q.s) + Hc + pad && y > floor(Q.s) - 3);
    },
    /** how deep inside (m from the nearer portal; <= 0: outside), for (x, y, z) in the tube */
    depth(x, y, z) {
      path.project(x, z, Q);
      if (Q.dist === Infinity || Q.s < pF0 - 3 || Q.s > pF1 + 3 || Math.abs(Q.d) > Wi + 0.6) return 0;
      if (y !== undefined && (y > floor(Q.s) + Hc + 0.6 || y < floor(Q.s) - 3)) return 0;
      return Math.min(Q.s - pF0, pF1 - Q.s) + 3;
    },
  };
  return t;
}

// The scenic cut leaves out the road's segments inside a tunnel (no open cutting through the ridge) ...
export function tunnelCore(r, sa, sb) {
  if (!r.tunnels) return false;
  for (const t of r.tunnels) if (sa >= t.sF0 && sb <= t.sF1) return true;
  return false;
}
// ... and its cutting ends at each portal: past the portal plane the ground is never below the end slope (the
// headwall's top, HP m over the road, then up at the cutting's batter); -Infinity elsewhere. r / s: the road
// stretch nearest (x, z) (only its own tunnels count: another road or leg nearby keeps its own cut). (the scenic
// cut keeps min(natural, max(its cut, this)); the trench under the mountain is carved by the slot)
export function tunnelEnd(x, z, r, s) {
  let lim = -Infinity;
  for (const t of r.tunnels || []) {
    if (s < t.sF0 - 12 || s > t.sF1 + 12) continue;
    const b = t.path.bounds;
    if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
    t.path.project(x, z, Q);
    if (Q.dist === Infinity) continue;
    const ds = Math.min(Q.s - t.pF0, t.pF1 - Q.s);
    if (ds <= 0) continue;
    lim = Math.max(lim, t.floor(Q.s) + HP + K_END * ds);
  }
  return lim;
}
/** the corridors that keep trees and rocks off road r (scenic.js): its open stretches at width w, over a tunnel only
 * as wide as the trench under the mountain (the trees on the mountain over it stand on, not in it) */
export function tunnelCorridors(r, w, add) {
  let line = [];
  const flush = () => { if (line.length > 1) add(line, w); line = []; };
  for (let i = 0; i < r.n; i += 3) {
    if (tunnelCore(r, r.S[i] - 3, r.S[i] + 3)) { flush(); continue; }
    line.push([r.X[i], r.Z[i]]);
  }
  if (!tunnelCore(r, r.S[r.n - 1] - 3, r.S[r.n - 1])) line.push([r.X[r.n - 1], r.Z[r.n - 1]]);
  flush();
  for (const t of r.tunnels || []) {
    const pl = [];
    for (let s = t.sF0 + 1; s <= t.sF1 - 1; s += 6) { roadAt(r, s, P); pl.push([P.x, P.z]); }
    add(pl, Math.max(2, t.slotHalf - 2.5)); // (trees skip 3-7 m past a corridor's edge: all of them clear of the trench)
  }
}

// The tunnels' trenches (covered, after the scenic cut) and the mountain over each tube as a surface (ridden from
// above; one per ~120 m of tunnel, so the surface grid only asks it near).
export function addTunnelCuts() {
  for (const t of busRoads.tunnels || []) {
    const { path, floor, pF0, pF1, slotSurface, lidLift } = t;
    world.addCut(t.slot);
    const SQ = {}, pad = SLOT + 4;
    const height = (x, z) => {
      path.project(x, z, SQ);
      if (SQ.dist === Infinity || SQ.s < pF0 || SQ.s > pF1 || slotSurface(SQ.s, Math.abs(SQ.d)) === Infinity) return null;
      return lidLift(x, z, world.outsideHeight(x, z)); // (as the lid is drawn: Oct 31 2026, tunnels.js makeTunnel)
    };
    // (anyone over the tube's crown is on the mountain; inside it you are on the road)
    const over = (x, z) => { path.project(x, z, SQ); return SQ.dist === Infinity ? Infinity : floor(SQ.s) + TUBE.Hc + 1.2; };
    t.surfaces = [];
    const A = {};
    for (let a = pF0; a < pF1; a += 120) {
      const b = Math.min(pF1, a + 120);
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (let s = a; s <= b + 1e-6; s += 6) { path.at(Math.min(s, b), A); minx = Math.min(minx, A.x); maxx = Math.max(maxx, A.x); minz = Math.min(minz, A.z); maxz = Math.max(maxz, A.z); }
      t.surfaces.push(world.addSurface({ bounds: { minx: minx - pad, minz: minz - pad, maxx: maxx + pad, maxz: maxz + pad }, height, over, roadTunnel: true }));
    }
  }
  busRoads.tunnelAt = inRoadTunnel;
}

/**
 * The tunnel (x, z) is in (inside its tube; with y: below its crown), or null. (Oct 31 2026: the police helicopter
 * loses sight of you in a tunnel; no snowfall inside) pad: m past the tube's walls.
 */
export function inRoadTunnel(x, z, y, pad = 0.4) {
  for (const t of busRoads.tunnels || []) {
    const b = t.path.bounds;
    if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
    if (t.inside(x, y, z, pad)) return t;
  }
  return null;
}
/** the tunnel whose tube or portal headwalls (x, z) is at (roadside props keep out: the walls do their job), or null */
export function tunnelWorks(x, z, pad = 1) {
  for (const t of busRoads.tunnels || []) {
    const b = t.path.bounds;
    if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
    t.path.project(x, z, Q);
    if (Q.dist !== Infinity && Q.s > t.pF0 - 8 && Q.s < t.pF1 + 8 && Math.abs(Q.d) < t.slotHalf + pad) return t;
  }
  return null;
}
