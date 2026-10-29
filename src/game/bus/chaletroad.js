// The chalet village (Almdorf): an Austrian chalet resort on the gentle forested slope (~10 degrees, falling north)
// between the village -> Sonnenkopf road and the Legacy Express, a little way north of Legacy Village. Pure layout
// (no THREE): runs in Node too; world/chalets.js builds the houses from busRoads.chalets.
//   - the Chaletweg: a T junction off the valley road, a wide bend (R 40 m) onto the lowest terrace, then up the
//     slope in three switchbacks (hairpins R 30 m: the legs run along the contours, 60 m apart), to a small car park
//     at the top; a scenic road (scenic.js carves it, scenicdrive.js drives a few cars up and down it)
//   - the terraces: a flat pad per chalet on the uphill side of each leg, level with the road at its drive (the
//     parking spot beside the house), the ground eased back to the slope round it at no more than ~35 degrees; the
//     chalets face downhill over the road to the view; the playground on a pad of its own in the middle
//   - the forest: none on the pads (cleared strips), thicker on the banks between the terraces
// Kept off: pistes, lifts, the Express, the valley road (but at the junction), the car rental, the race regions.
import { world } from '../../world/world.js';
import { expressNearest } from '../../world/expressroute.js';
import { busRoads, makeRoad, roadAt, laneDistance } from './roads.js';
import { lotAt } from './scenic.js';
import { HX, FOOT } from '../chaletplan.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const SC_GRADE = 0.115;
const JUNCTION_NEAR = { x: 416, z: 1200 }; // the T junction on the valley road
const LEG_Z = [1180, 1120, 1060, 1000];    // the legs (along the contours, the slope falls toward +z)
const XE = 628, XW = 388, XL = 334;        // the east hairpins, the west hairpin, the car park's entrance (top leg)
const HAIRPIN_R = 30, BEND_R = 40;
// the terraces on the uphill side of each leg: [x from, x to] of the row of plots
// the rows of plots: [leg, side (-1 uphill, +1 downhill), x from, x to]
const ROWS = [[0, -1, 438, 590], [0, 1, 470, 590], [1, -1, 410, 640], [1, 1, 432, 590], [2, -1, 368, 590], [2, 1, 404, 600], [3, -1, 352, 608], [3, 1, 362, 585]];
const PLOT_W = 26;                         // m along the leg: a side garden, the house (eaves 13.5 m), its private parking, gaps
const PAD_FRONT = 7.5, FRONT_GARDEN = 2.6; // m from the leg's centre line to the pad; the front garden (pad edge to the steps)
const PAD_DEPTH = FRONT_GARDEN + FOOT.x1 + HX + 1.2; // (the back wall 1.2 m short of the pad's back: the eaves overhang the bank)
const BAY = { w: 5.4, d: 5.6 };            // the private parking beside each house: two 2.5 x 5 m bays, fenced
const BANK = 0.7;                          // tan 35 degrees: the terraces' banks
export const CHALET_PLACE = { x: 500, z: 1075, label: 'Chalet village', r: 200 };

const hash = (i) => { const v = Math.sin(i * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

// a polyline with every corner rounded (tangent arcs, radius R[i] at corner i), every ~4 m
function filleted(P, R, step = 4) {
  const dense = [P[0]];
  let cur = P[0];
  for (let i = 1; i < P.length - 1; i++) {
    const [px, pz] = P[i], ax = px - P[i - 1][0], az = pz - P[i - 1][1], la = Math.hypot(ax, az), bx = P[i + 1][0] - px, bz = P[i + 1][1] - pz, lb = Math.hypot(bx, bz);
    const a = [ax / la, az / la], b = [bx / lb, bz / lb];
    const th = Math.acos(clamp(a[0] * b[0] + a[1] * b[1], -1, 1)), cr = a[0] * b[1] - a[1] * b[0];
    const t = R[i] * Math.tan(th / 2), S = [px - a[0] * t, pz - a[1] * t];
    line(dense, cur, S);
    const n = cr > 0 ? [-a[1], a[0]] : [a[1], -a[0]], C = [S[0] + n[0] * R[i], S[1] + n[1] * R[i]], v0 = [S[0] - C[0], S[1] - C[1]], sg = cr > 0 ? 1 : -1;
    const m = Math.max(2, Math.ceil((th * R[i]) / 0.5));
    for (let k = 1; k <= m; k++) { const f = (sg * th * k) / m, c = Math.cos(f), s = Math.sin(f); dense.push([C[0] + v0[0] * c - v0[1] * s, C[1] + v0[0] * s + v0[1] * c]); }
    cur = dense[dense.length - 1];
  }
  line(dense, cur, P[P.length - 1]);
  // even resampling
  const out = [dense[0]];
  let carry = 0;
  for (let i = 0; i < dense.length - 1; i++) {
    const [ax, az] = dense[i], [bx, bz] = dense[i + 1], L = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= L) { out.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); t += step; }
    carry = L - (t - step);
  }
  const last = dense[dense.length - 1], ol = out[out.length - 1];
  if (Math.hypot(last[0] - ol[0], last[1] - ol[1]) > 1.5) out.push(last); else out[out.length - 1] = last;
  return out;
}
function line(out, a, b) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(L / 0.5);
  for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
}

const smin = (a, b, k) => { const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
const smax = (a, b, k) => -smin(-a, -b, k);

/** Plan the Chaletweg, its car park and the terraces (appended to busRoads; busRoads.chalets for the houses). */
export function planChaletVillage(O) {
  const main = busRoads.roads.filter((r) => !r.access && !r.scenic);
  const r0 = main.find((r) => r.from === busRoads.stops[0]);
  if (!r0) return;
  let J = null;
  for (let i = 0; i < r0.n; i++) { const d = Math.hypot(r0.X[i] - JUNCTION_NEAR.x, r0.Z[i] - JUNCTION_NEAR.z); if (!J || d < J.d) J = { x: r0.X[i], z: r0.Z[i], y: r0.Y[i], s: r0.S[i], d }; }
  if (!J || J.d > 40) { console.warn('chalet village: no junction'); return; }
  // square off the valley road (its normal into the site), then the bend onto the lowest leg
  const jd = roadAt(r0, J.s), sg = jd.dz >= 0 ? 1 : -1, ex = jd.dz * sg, ez = -jd.dx * sg; // (pointing east, uphill)
  if (ez > -0.2) { console.warn('chalet village: the valley road runs the wrong way here'); return; }
  const t0 = (J.z - LEG_Z[0]) / -ez, C0 = [J.x + ex * t0, LEG_Z[0]];
  const corners = [[J.x, J.z], C0, [XE, LEG_Z[0]], [XE, LEG_Z[1]], [XW, LEG_Z[1]], [XW, LEG_Z[2]], [XE, LEG_Z[2]], [XE, LEG_Z[3]], [XL, LEG_Z[3]]];
  const radii = [0, BEND_R, HAIRPIN_R, HAIRPIN_R, HAIRPIN_R, HAIRPIN_R, HAIRPIN_R, HAIRPIN_R, 0];
  const up = filleted(corners, radii); // (from the junction up to the car park's entrance)
  const lot = lotAt({ size: 'small', name: 'Almdorf car park', hw: 14, hd: 9 }, XL, LEG_Z[3], -1, 0);
  const pts = [[lot.ex - lot.dirx * 7, lot.ez - lot.dirz * 7], ...up.slice().reverse()]; // (s = 0 in the car park)
  // the clearances (warned, not fatal: the layout is fixed)
  const q = {};
  let worst = null;
  for (const [x, z] of up) {
    O.query(x, z, q);
    const c = world.corridorAt(x, z), e = expressNearest(x, z), dj = Math.hypot(x - J.x, z - J.z);
    const why = q.ski < 25 ? 'piste' : q.lift < 12 ? 'lift' : q.block < 16 ? 'building' : (c.kind === 'piste' || c.kind === 'race') && c.d < 20 ? 'piste' : e && e.d < 45 ? 'Express' : dj > 45 && laneDistance(x, z) < 30 ? 'road' : null;
    if (why && !worst) worst = { why, x: Math.round(x), z: Math.round(z) };
  }
  if (worst) console.warn('chalet village: the road runs close to', worst);
  const road = makeRoad(pts, { name: lot.name, x: lot.ex, z: lot.ez, lot: true }, { name: 'junction', x: J.x, z: J.z }, { y0: lot.y, y1: J.y, maxGrade: SC_GRADE, envelope: true });
  road.name = 'Chaletweg'; road.access = true; road.scenic = true; road.chalet = true;
  road.lot0 = lot; road.exitAt1 = { road: r0, s: J.s, x: J.x, z: J.z };
  lot.y = road.Y[0];
  // ---- the terraces: plots on both sides of each leg (uphill: side -1, downhill: +1), the houses facing the road
  const ri = busRoads.roads.length; // (the index the road gets)
  const P = {};
  const nearestS = (x, z) => { let bs = 0, bd = Infinity; for (let i = 0; i < road.n; i++) { const d = Math.hypot(road.X[i] - x, road.Z[i] - z); if (d < bd) { bd = d; bs = road.S[i]; } } return bs; };
  const plots = [];
  let id = 0;
  for (const [leg, side, xa, xb] of ROWS) {
    const zl = LEG_Z[leg], n = Math.floor((xb - xa) / PLOT_W), w = (xb - xa) / n, sd = side;
    const at = (d) => zl + sd * d; // (d metres from the leg's centre line, on this side)
    for (let k = 0; k < n; k++) {
      const h = hash(id * 7 + 3), mirror = hash(id * 5 + 1) < 0.45, bs = mirror ? -1 : 1; // (bs: the bay's side of the house)
      const x0 = xa + w * k + 0.5, x1 = xa + w * (k + 1) - 0.5;
      // the house faces the road: its frame's +x (the door) toward the leg; its local z runs along the leg, world
      // +x for a downhill plot, -x uphill (three.js: rotation.y = -PI/2 + yaw, yaw 0 uphill, PI downhill)
      const wz = sd > 0 ? 1 : -1, lo = Math.min(wz * FOOT.z0, wz * FOOT.z1), hi = Math.max(wz * FOOT.z0, wz * FOOT.z1);
      const hx = bs > 0 ? x0 + 4.4 - lo : x1 - 4.4 - hi; // (a 4.4 m side garden, the bay on the other side)
      const bx = bs > 0 ? hx + hi + 1.0 + BAY.w / 2 : hx + lo - 1.0 - BAY.w / 2;
      const bay = { x: bx, z: at(PAD_FRONT + 0.3 + BAY.d / 2), w: BAY.w, d: BAY.d, yaw: sd > 0 ? 0 : Math.PI };
      const s = nearestS(bay.x, zl);
      roadAt(road, s, P);
      const za = at(PAD_FRONT), zb = at(PAD_FRONT + PAD_DEPTH);
      plots.push({
        id: id++, row: leg * 2 + (sd > 0 ? 1 : 0), leg, side: sd, x0, x1, z0: Math.min(za, zb), z1: Math.max(za, zb), legZ: zl, mirror,
        y: P.y + 0.2 + (sd < 0 ? 0.5 : -0.3), // (uphill pads a little above the road, downhill ones a little below: gentler banks)
        house: { x: hx, z: at(PAD_FRONT + FRONT_GARDEN + FOOT.x1), yaw: (sd < 0 ? 0 : Math.PI) + (h - 0.5) * 0.03 },
        // front: the pad's road edge (z); back: its far edge; out: the way the front faces (+1 / -1 in z)
        front: za, back: zb, out: -sd, garden: bs > 0 ? [x0, hx + lo - 0.3] : [hx + hi + 0.3, x1],
        bay, park: { x: bay.x, z: bay.z }, drive: { x: bay.x, z: at(5), s },
        shed: hash(id * 13 + 7) < 0.4, bench: hash(id * 3 + 11) < 0.7,
      });
    }
  }
  // the playground: a downhill plot in the middle of the village
  const mid = plots.filter((p) => p.leg === 2 && p.side > 0).sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - 480) - Math.abs((b.x0 + b.x1) / 2 - 480))[0];
  if (mid) { mid.playground = true; mid.shed = false; }
  // neighbouring pads in a row: their levels within reach of each other's banks
  for (let it = 0; it < 3; it++) for (let i = 1; i < plots.length; i++) {
    const a = plots[i - 1], b = plots[i];
    if (a.row !== b.row) continue;
    const gap = Math.max(1, b.x0 - a.x1), lim = gap * BANK * 0.8;
    if (b.y - a.y > lim) b.y = a.y + lim; else if (a.y - b.y > lim) a.y = b.y + lim;
  }
  // ---- the ground: one cut for every pad (registered before the roads' cuts: those come after and ease the
  // ground between road and pad); the forest kept off the pads, thicker on the banks
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const p of plots) { minx = Math.min(minx, p.x0 - 40); maxx = Math.max(maxx, p.x1 + 40); minz = Math.min(minz, p.z0 - 40); maxz = Math.max(maxz, p.z1 + 40); }
  const C = [];
  world.addCut({
    bounds: { minx, minz, maxx, maxz },
    chalets: true,
    apply(x, z, h) {
      C.length = 0;
      for (const p of plots) {
        const dx = Math.max(p.x0 - x, 0, x - p.x1), dz = Math.max(p.z0 - z, 0, z - p.z1);
        if (dx > 40 || dz > 40) continue;
        const d = Math.hypot(dx, dz);
        if (d * BANK > Math.abs(h - p.y) + 1.5) continue; // (the slope there is within the bank already)
        C.push(d, p.y);
      }
      if (!C.length) return h;
      // nearest pad first; a further one narrows the band only while it still agrees
      let lo = -Infinity, hi = Infinity, used = 0;
      while (used < C.length / 2) {
        let m = -1;
        for (let i = 0; i < C.length; i += 2) if (C[i] >= 0 && (m < 0 || C[i] < C[m])) m = i;
        if (m < 0) break;
        const d = C[m], y = C[m + 1];
        C[m] = -1; used++;
        const l = Math.max(lo, y - d * BANK), u = Math.min(hi, y + d * BANK);
        if (l > u) break;
        lo = l; hi = u;
      }
      const soft = Math.min(1.2, (hi - lo) * 0.2 + 0.01);
      return smax(smin(h, hi, soft), lo, soft);
    },
    forest(x, z, f) {
      for (const p of plots) if (x > p.x0 - 3 && x < p.x1 + 3 && z > p.z0 - 2 && z < p.z1 + 3) return 0;
      if (x < minx + 30 || x > maxx - 30 || z < minz + 30 || z > maxz - 30) return f;
      const n = 0.55 + 0.45 * Math.sin(x * 0.083 + z * 0.031) * Math.sin(z * 0.071 - x * 0.027);
      return Math.max(f, 0.34 * n);
    },
  });
  // no trees or rocks on a pad (a cleared strip along it, as on the car parks)
  for (const p of plots) {
    const zc = (p.z0 + p.z1) / 2, hd = (p.z1 - p.z0) / 2;
    world.addCorridor([[p.x0 + hd, zc], [Math.max(p.x0 + hd + 0.5, p.x1 - hd), zc]], hd + 1, 'lift', { chalet: true });
  }
  busRoads.roads.push(road);
  busRoads.lots.push(lot);
  busRoads.junctions.push({ x: J.x, z: J.z, scenic: true, road: r0, s: J.s, arm: road });
  // the drives: no snow poles, guardrail or plough berm across a house's entrance
  for (const p of plots) busRoads.junctions.push({ x: p.drive.x, z: p.drive.z, drive: true }, { x: p.bay.x, z: p.bay.z, drive: true, bay: true }); // (a bay: firm tarmac grip)
  busRoads.chalets = { road, ri, lot, plots, junction: J, place: CHALET_PLACE, bounds: { minx, minz, maxx, maxz } };
}

/**
 * The ski bus stop "Almdorf" (after every road is shaped: planBusRoads calls it last). It stands on the valley road
 * at the Chaletweg's junction, so the 12 m bus never has to turn into the village's lanes: the road from the village
 * stop past the junction is split there for the bus network (busRoads.busLegs: village -> Almdorf -> the next stop,
 * slices of the same road, nothing new built or carved), so every ride along it stops at Almdorf on the way, and a
 * ride from Almdorf goes either way. bus.js (parent) and skibus.js (besideBay) look the legs up first.
 */
export function planAlmdorfStop() {
  const V = busRoads.chalets;
  if (!V) return;
  const J = V.junction, r0 = V.road.exitAt1?.road;
  if (!r0) return;
  let iJ = 0;
  for (let i = 0; i < r0.n; i++) if (Math.abs(r0.S[i] - J.s) < Math.abs(r0.S[iJ] - J.s)) iJ = i;
  if (iJ < 8 || iJ > r0.n - 8) return; // (too near either end to stop there)
  const slice = (a, b, from, to) => {
    const n = b - a + 1, X = r0.X.slice(a, b + 1), Y = r0.Y.slice(a, b + 1), Z = r0.Z.slice(a, b + 1), S = new Float32Array(n);
    for (let k = 1; k < n; k++) S[k] = S[k - 1] + Math.hypot(X[k] - X[k - 1], Z[k] - Z[k - 1]);
    return { from, to, n, X, Y, Z, S, length: S[n - 1], busLeg: true, base: r0, s0: r0.S[a] };
  };
  const stop = { x: J.x, z: J.z, heading: 0, name: 'Almdorf', chalets: true };
  busRoads.stops.push(stop); // (the same array as layout.busStops: the trail map and the stop list show it)
  busRoads.busLegs = [slice(0, iJ, r0.from, stop), slice(iJ, r0.n - 1, stop, r0.to)];
}
