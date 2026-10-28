// The Panoramastrasse: a narrow scenic mountain road "the other way" from the bus roads (they run south down the
// valley; this one goes east, over the Legacy Express's tunnel under the village's edge, to the free mountain east of
// the resort) and up it in switchbacks to a summit viewpoint with a car park. Planned by roads.js planBusRoads (last,
// after the car parks / hospital / rental) and carved by its own world cut (shapeScenic). Pure layout (no THREE).
//   - the approach: A* (roads.js route) from a T junction on the village -> Sonnenkopf road east to a ROUNDABOUT at
//     the mountain's foot (three arms: the approach, the climb, a short spur to the Talblick car park)
//   - the climb: zigzag() lays straight legs across the mountain's face joined by hairpins (radius 14 m), each leg
//     where the ground has come up to the road at ~9.8 %; the profile is capped at 11.5 % with both ends fixed
//     (makeRoad envelope), the cut and fill (shapeScenic) deal with the crags: a sketchy road
//   - pull-outs (lay-bys) on straight stretches with a drop on the valley side (a bench and a view board stand there,
//     bus.js), the Gipfelblick car park at the top
// Every scenic road is an access road (s = 0 at its car park / the ring, its end at the junction / the ring): the
// traffic drives them like the car parks' access roads (traffic.js), with the ring between them.
import { world } from '../../world/world.js';
import { expressNearest } from '../../world/expressroute.js';
import { routeH, minRadius, selfClearance, smoothRoute } from './scenicnet.js';
import {
  busRoads, route, smoothPath, makeRoad, roadAt, laneDistance, berm, ROAD_HALF, BENCH, BERM_IN, CLEAR,
} from './roads.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const SC_GRADE = 0.115;             // the scenic road's steepest grade (alpine pass road)
const LEG_G = 0.065;                // the grade the walker looks for along a leg (the hairpins make up the rest)
const HAIRPIN_R = 14;               // m (centre line): tight but a car (and a bus) gets round
export const RING_R = 15;           // the roundabout's centre line radius (single lane ring, the island inside)
export const ISLAND_R = RING_R - 3.4 - 0.7; // (ROAD_HALF 3.4: roads.js imports this module, so its constants are not ready here yet)
// where it goes (checked in Node: no pistes, lifts, races or course regions out there; the Express only in its tunnel)
const JUNCTION_NEAR = { x: 205, z: 330 };  // the T junction on the village -> Sonnenkopf road (over the Express tunnel)
const RING_AT = { x: 1300, z: 520 };       // the roundabout (the basin east of the Express, the mountain's foot)
const CLIMB_AT = { x: 2500, z: 560 };     // the summit the switchbacks head for (~770 m)
const TOP_H = 715;                         // the summit plateau (the walker stops there)
const BOX = { minx: 250, maxx: 3900, minz: -350, maxz: 1250 };
const EXPRESS_OK = [420, 820];             // arc length span of the Express tunnel under the village's edge we cross

// ground the scenic road keeps off: ski areas, stations, the railway, lifts, the Express (except over its tunnel),
// the other roads (except at its own junction), outside the planned box
export function badGround(O, allowNear = null) {
  const q = {};
  return (x, z) => {
    if (x < BOX.minx - 200 || x > BOX.maxx || z < BOX.minz || z > BOX.maxz) return true;
    O.query(x, z, q);
    if (q.ski < CLEAR.ski + 12 || q.net < 12 || q.block < CLEAR.block + 4 || q.rail < 20 || q.lift < 10) return true;
    const c = world.corridorAt(x, z);
    if ((c.kind === 'piste' || c.kind === 'race') && c.d < 25) return true;
    const e = expressNearest(x, z);
    if (e && e.d < 40 && !(e.s > EXPRESS_OK[0] && e.s < EXPRESS_OK[1])) return true;
    if (allowNear && Math.hypot(x - allowNear.x, z - allowNear.z) < 70) return false;
    return laneDistance(x, z) < 30;
  };
}

// the climb: contour walker with hairpins -> [[x, z]...] every ~4 m, or null
function serpentine(x, z, hd, O, TOP_H, { leg0 = 380, legs = [300, 180], maxPins = 12, allowNear = null, goal = null } = {}) {
  const bad = badGround(O, allowNear), ds = 4, pts = [[x, z]];
  // the mountain's broad shape (local crags averaged out: the road's cut deals with those)
  const H = (a, b) => (world.height(a, b, 8) * 2 + world.height(a + 14, b, 8) + world.height(a - 14, b, 8) + world.height(a, b + 14, 8) + world.height(a, b - 14, 8)) / 6;
  let leg = 0, legLen = leg0, hairpins = 0;
  const nearOwn = (px, pz, skip) => { // distance to the road so far, leaving out its last `skip` points
    let d = Infinity;
    for (let i = 0; i < pts.length - skip; i += 2) d = Math.min(d, Math.hypot(pts[i][0] - px, pts[i][1] - pz));
    return d;
  };
  for (let step = 0; step < 3000; step++) {
    if (H(x, z) >= TOP_H || (hairpins >= maxPins && leg > 200 && H(x, z) > TOP_H - 90)) break;
    const h0 = H(x, z);
    let best = null;
    for (let k = -6; k <= 6; k++) {
      const a = hd + k * 0.05, nx = x + Math.sin(a) * ds, nz = z + Math.cos(a) * ds;
      let cost = Math.min(2, Math.abs((H(nx, nz) - h0) / ds - LEG_G)) + Math.abs(k) * 0.004;
      if (goal && Math.hypot(goal.x - x, goal.z - z) > 250) cost += 0.03 * (1 - Math.cos(a - Math.atan2(goal.x - x, goal.z - z))); // (toward the mountain while the ground lets it)
      if (bad(nx, nz)) cost += 100;
      const own = nearOwn(nx, nz, 30);
      if (own < 48) cost += (48 - own) * 0.08;
      if (!best || cost < best.cost) best = { a, nx, nz, cost };
    }
    // a hairpin: the leg is long enough, or ahead is no-go / the road below / a cliff
    const ax = x + Math.sin(hd) * 40, az = z + Math.cos(hd) * 40;
    const blocked = bad(ax, az) || best.cost > 0.3;
    if ((leg >= legLen || (blocked && leg > 80)) && hairpins < maxPins) {
      const e = 6, gx = H(x + e, z) - H(x - e, z), gz = H(x, z + e) - H(x, z - e);
      const lx = Math.cos(hd), lz = -Math.sin(hd); // (the heading's left)
      const turn = gx * lx + gz * lz > 0 ? 1 : -1; // (into the slope)
      const cx = x + lx * turn * HAIRPIN_R, cz = z + lz * turn * HAIRPIN_R;
      const a0 = Math.atan2(x - cx, z - cz), n = Math.ceil((Math.PI * HAIRPIN_R) / ds);
      let ok = true;
      const arc = [];
      for (let i = 1; i <= n; i++) {
        const a = a0 + turn * -(i / n) * Math.PI; // (sin/cos frame: + turns the radius vector right; left = -)
        const px = cx + Math.sin(a) * HAIRPIN_R, pz = cz + Math.cos(a) * HAIRPIN_R;
        if (bad(px, pz) || nearOwn(px, pz, Math.round(leg / ds) + 4) < 2 * HAIRPIN_R + 6) ok = false;
        arc.push([px, pz]);
      }
      if (ok) {
        pts.push(...arc);
        x = arc[arc.length - 1][0]; z = arc[arc.length - 1][1]; hd = hd + Math.PI;
        leg = 0; hairpins++; legLen = legs[0] + ((hairpins * 97) % legs[1]);
        continue;
      }
    }
    if (best.cost > 50) { if (typeof process !== "undefined" && process.env?.SCENIC_DEBUG) { const q = {}; O.query(x + Math.sin(hd) * 4, z + Math.cos(hd) * 4, q); console.log("walker stuck", step, Math.round(x), Math.round(z), Math.round(h0), hairpins, JSON.stringify(q), laneDistance(x, z), JSON.stringify(world.corridorAt(x, z)), JSON.stringify(expressNearest(x, z))); } return H(x, z) > TOP_H - 120 ? pts : null; } // (stuck near the top: the car park goes here)
    x = best.nx; z = best.nz; hd = best.a; leg += ds;
    pts.push([x, z]);
  }
  return pts;
}

// the climb, laid out: straight legs across the mountain's face (along its contours, alternately left and right of the
// line from the foot B up toward the summit), joined by hairpins (two quarter arcs of radius HAIRPIN_R into the
// slope, a straight up the fall line between them where the next leg must sit higher up). Each next leg goes where the
// ground (averaged along it) has come up to the road's own height at DESIGN_G: the profile hugs the mountain, the
// cut and fill (shapeScenic) deal with its crags. -> { pts: [[x, z]...] every ~4 m from B, pins, yEnd } or null
const DBG = (...a) => { if (typeof process !== 'undefined' && process.env?.SCENIC_DEBUG) console.log(...a); };
const DESIGN_G = 0.098, LEG_HALF = 150;
export function zigzag(B, ang, y0, O, allowNear, { topH = TOP_H, bad: badFn = null, minPins = 3, legHalf = LEG_HALF, minDu = null } = {}) {
  const bad = badFn || badGround(O, allowNear), ds = 4, R = HAIRPIN_R, LEG_HALF = legHalf;
  const Ux = Math.sin(ang), Uz = Math.cos(ang), Cx = Uz, Cz = -Ux; // (uphill, across)
  const P = (u, l) => [B.x + Ux * u + Cx * l, B.z + Uz * u + Cz * l];
  const G = (u) => { let t = 0, n = 0; for (let l = -LEG_HALF; l <= LEG_HALF; l += 25) { const [x, z] = P(u, l); t += world.height(x, z); n++; } return t / n; };
  const pts = [[B.x, B.z]];
  let x = B.x, z = B.z, hd = Math.atan2(Cx, Cz), s = 0, u = 0, pins = 0;
  const go = (len) => { const n = Math.max(1, Math.round(len / ds)), st = len / n; for (let i = 0; i < n; i++) { x += Math.sin(hd) * st; z += Math.cos(hd) * st; pts.push([x, z]); } s += len; };
  const turn = (sg) => { const n = Math.ceil((Math.PI / 2) * R / ds), da = (sg * Math.PI) / 2 / n, ch = 2 * R * Math.sin(Math.abs(da) / 2); for (let i = 0; i < n; i++) { const m = hd + da / 2; x += Math.sin(m) * ch; z += Math.cos(m) * ch; hd += da; pts.push([x, z]); } s += (Math.PI / 2) * R; };
  const ok = (from) => { for (let i = from; i < pts.length; i++) if (bad(pts[i][0], pts[i][1])) return false; return true; };
  go(LEG_HALF); // (the first leg: from the middle out)
  if (!ok(0)) { DBG('zz first leg bad', pts.find((p) => bad(p[0], p[1])).map(Math.round)); return null; }
  for (let k = 0; k < 30; k++) {
    // where the next leg goes: the nearest line up the face whose ground has come up to the road there
    const g0 = G(u);
    // (the next leg at least far enough up the face that the ground between two legs stays under ~45 degrees: the
    // height they gain over a hairpin and a leg, over the gap between their shoulders)
    let du = Math.max(2 * R, minDu ?? (2 * 8.6 + DESIGN_G * (Math.PI * R + 2 * LEG_HALF - 2 * R)) / (1 - DESIGN_G));
    while (du < 160 && G(u + du) < y0 + DESIGN_G * (s + Math.PI * R + du - 2 * R)) du += 4;
    if (Math.max(G(u + 28), G(u + 56), G(u + 84)) < g0 + 1) { DBG('zz top', k, u, du); break; } // (over the top: the ground no longer rises)
    const keep = pts.length, save = { x, z, hd, s, u, pins };
    const sg = Math.sin(hd) * Uz - Math.cos(hd) * Ux > 0 ? -1 : 1; // (turn toward uphill)
    turn(sg); go(du - 2 * R); turn(sg); go(2 * LEG_HALF);
    if (!ok(keep)) { DBG('zz bad', k, u, du, pts.slice(keep).find((p) => bad(p[0], p[1])).map(Math.round)); pts.length = keep; ({ x, z, hd, s, u, pins } = save); break; }
    u += du; pins++;
    if (y0 + DESIGN_G * s > topH) break;
  }
  return pins >= minPins ? { pts, pins, yEnd: y0 + DESIGN_G * s, U: [Ux, Uz] } : null;
}

// a car park's frame from where the road reaches it (end point, heading in): { lot fields } (cf. roads.js planLots)
export function lotAt(def, ex, ez, hx, hz) {
  const cx = ex + hx * (def.hd + 2), cz = ez + hz * (def.hd + 2);
  const yaw = Math.atan2(hz, -hx), ux = Math.sin(yaw), uz = Math.cos(yaw), vx = uz, vz = -ux;
  let lo = Infinity, hi = -Infinity;
  for (let a = -def.hw; a <= def.hw; a += 4) for (let b = -def.hd; b <= def.hd; b += 4) { const h = world.height(cx + ux * a + vx * b, cz + uz * a + vz * b); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  return { ...def, x: cx, z: cz, yaw, y: (lo + hi) / 2, ux, uz, vx, vz, ex, ez, dirx: -hx, dirz: -hz, piles: [], scenic: true };
}

// a roundabout's ring: a closed loop (drawn as a road, counted as tarmac by laneDistance), level
export function ringRoad(ring, name) {
  const n = 28, X = new Float32Array(n + 1), Z = new Float32Array(n + 1), Y = new Float32Array(n + 1).fill(ring.y), S = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; X[i] = ring.x + Math.sin(a) * ring.R; Z[i] = ring.z + Math.cos(a) * ring.R; if (i) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]); }
  return { from: { name }, to: { name }, n: n + 1, X, Z, Y, S, length: S[n], ringRoad: ring, name };
}

// pull-outs on a scenic road: straight, gentle-ish stretches with the ground falling away on one side (the view)
export function findLaybys(road, { max = 7, apart = 450, from = 120, toEnd = 150 } = {}) {
  busRoads.laybys ||= [];
  const ri = busRoads.roads.indexOf(road), taken = [];
  for (let s = from; s < road.length - toEnd && taken.length < max; s += 8) {
    if (taken.some((t) => Math.abs(t - s) < apart)) continue;
    const a = roadAt(road, s - 16), b = roadAt(road, s + 16), p = roadAt(road, s);
    const bend = Math.abs(Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz));
    if (bend > 0.08 || Math.abs(p.grade) > 0.09) continue;
    for (const side of [1, -1]) {
      const rx = -p.dz * side, rz = p.dx * side, x = p.x + rx * 4.6, z = p.z + rz * 4.6;
      const far = world.height(p.x + rx * 30, p.z + rz * 30);
      if (far > p.y - 10) continue; // (no view: the slope rises there)
      if (laneDistance(p.x + rx * 14, p.z + rz * 14, ri, s, 60) < 12) continue; // (the leg below too close)
      busRoads.laybys.push({ ri, s, side, x, z, yaw: Math.atan2(p.dx, p.dz), scenic: true, view: true });
      taken.push(s);
      break;
    }
  }
  return taken.length;
}

/** Plan the scenic road(s), the roundabout and their car parks (appended to busRoads). */
export function planScenic(O) {
  const main = busRoads.roads.filter((r) => !r.access);
  const r0 = main.find((r) => r.from === busRoads.stops[0]);
  if (!r0) return;
  // the T junction: the village road's point nearest the planned spot
  let J = null;
  for (let i = 0; i < r0.n; i++) { const d = Math.hypot(r0.X[i] - JUNCTION_NEAR.x, r0.Z[i] - JUNCTION_NEAR.z); if (!J || d < J.d) J = { i, x: r0.X[i], z: r0.Z[i], y: r0.Y[i], s: r0.S[i], d }; }
  if (!J || J.d > 120) return;
  const bad = badGround(O, J);
  // the roundabout: on the flattest spot near RING_AT (the basin east of the Express, at the mountain's foot)
  let R0 = null;
  for (let dx = -120; dx <= 120; dx += 20) for (let dz = -120; dz <= 120; dz += 20) {
    const x = RING_AT.x + dx, z = RING_AT.z + dz;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let a = 0; a < 6.28 && ok; a += 0.52) for (const r of [0, 20, 40]) { const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r; if (bad(px, pz)) ok = false; const h = world.height(px, pz); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const sc = hi - lo + Math.hypot(dx, dz) * 0.01;
    if (ok && (!R0 || sc < R0.sc)) R0 = { x, z, sc };
  }
  if (!R0) { console.warn('scenic road: no roundabout site'); return; }
  const RX = R0.x, RZ = R0.z, yR = world.height(RX, RZ);
  const ring = { x: RX, z: RZ, y: yR, R: RING_R, arms: [], name: 'Panorama roundabout' };
  const armPt = (ang, r) => ({ x: ring.x + Math.sin(ang) * r, z: ring.z + Math.cos(ang) * r });
  // an arm from the ring outward (angle ang) to target b: [[x, z]...] from the ring's centre line, or null
  const arm = (ang, b, opts = {}) => {
    const p0 = armPt(ang, RING_R), p1 = armPt(ang, RING_R + 14), p2 = armPt(ang, RING_R + 30);
    const pts = route(p2, b, { obstacles: O, bad: opts.bad || bad, margin: opts.margin ?? 500, maxGrade: opts.maxGrade ?? 0.09 });
    if (!pts) return null;
    return smoothPath([[p0.x, p0.z], [p1.x, p1.z], ...pts], 4, 4);
  };
  const dirTo = (b) => Math.atan2(b.x - ring.x, b.z - ring.z);
  // A: from the T junction square off the village road, east over the Express's tunnel, to the ring (A* with a hard
  // grade cap); the arm leaves the ring toward the junction
  const jd = roadAt(r0, J.s), ex0 = -jd.dz, ez0 = jd.dx, sgn = ex0 >= 0 ? 1 : -1; // (the road's normal, pointing east)
  const ux = ex0 * sgn, uz = ez0 * sgn;
  const J1 = { x: J.x + ux * 26, z: J.z + uz * 26 };
  // B (planned first: the approach keeps off its switchbacks): ring -> the climb's start, then the switchbacks
  const angB = dirTo(CLIMB_AT), b0 = armPt(angB, RING_R), b1 = armPt(angB, RING_R + 14);
  const ZZ = zigzag(b1, angB, yR, O, ring, { minDu: 34 });
  if (!ZZ) { console.warn('scenic road: no climb', Math.round(ring.x), Math.round(ring.z)); return; }
  const pb = [[b0.x, b0.z], ...ZZ.pts];
  const angA = dirTo(J1);
  const nearClimb = (x, z) => { let d = Infinity; for (let i = 0; i < pb.length; i += 2) { const q = pb[i]; if (Math.abs(q[0] - x) < 60 && Math.abs(q[1] - z) < 60) d = Math.min(d, Math.hypot(q[0] - x, q[1] - z)); } return d; };
  const badA = (x, z) => bad(x, z) || (Math.hypot(x - ring.x, z - ring.z) > 60 && nearClimb(x, z) < 55);
  // (the gentlest way over the ridge without a hairpin: the A* on its 20 m grid meets a hard grade cap with tight
  // zigzags, which the smoothing turns into ~6 m kinks; a steeper cap with no bend under ~12 m wins, the cut and fill
  // make up the grade)
  let appr = null;
  // first: the heading-aware A* (proper switchbacks over the ridge), its legs clear of each other
  for (const g of [0.1, 0.115, 0.13]) {
    const p0 = armPt(angA, RING_R), p1 = armPt(angA, RING_R + 14), p2 = armPt(angA, RING_R + 30);
    // (searched from the junction's end, the low one: the road there gains its height in switchbacks before the ridge)
    const raw = routeH(J1, p2, { obstacles: O, bad: badA, margin: 350, maxGrade: g, maxTurn: 0.8, soft: true, y0: J.y, y1: yR });
    if (!raw) continue;
    const p = smoothRoute([[p0.x, p0.z], [p1.x, p1.z], ...raw.reverse().slice(1)], { fixedA: 2 });
    DBG('approach H', g, 'minR', minRadius(p).toFixed(1), 'clear', selfClearance(p, 120).toFixed(1), p.length);
    if (minRadius(p) >= 12 && selfClearance(p, 120) > 26) { appr = p; break; }
  }
  if (!appr) for (const g of [0.1, 0.12, 0.14, 0.17, 0.2, 0.25, 0.35]) {
    const p = arm(angA, J1, { margin: 300, maxGrade: g });
    if (!p) continue;
    if (!appr) appr = p;
    if (minRadius(p) >= 12) { appr = p; break; }
  }
  if (!appr) { console.warn('scenic road: no way to the junction'); return; }
  const pa = [...appr, [J.x + ux * 12, J.z + uz * 12], [J.x, J.z]];
  // the summit car park where the climb ends
  const e = pb.length, hx0 = pb[e - 1][0] - pb[e - 3][0], hz0 = pb[e - 1][1] - pb[e - 3][1], hl = Math.hypot(hx0, hz0) || 1;
  const top = lotAt({ size: 'small', name: 'Gipfelblick car park', hw: 15, hd: 9 }, pb[e - 1][0] + (hx0 / hl) * 4, pb[e - 1][1] + (hz0 / hl) * 4, hx0 / hl, hz0 / hl);
  top.y = Math.min(top.y, ZZ.yEnd); // (the pad at the road's height: cut into the summit if need be)
  pb.push([top.ex, top.ez], [top.ex - top.dirx * 7, top.ez - top.dirz * 7]); // (in through the entrance: no gap)
  // C: a short spur to the Talblick car park (the side of the ring away from the other two arms)
  let angC = Math.atan2(-(Math.sin(angA) + Math.sin(angB)), -(Math.cos(angA) + Math.cos(angB)));
  const lowDef = { size: 'small', name: 'Talblick car park', hw: 13, hd: 9 };
  const c0 = armPt(angC, RING_R), c1 = armPt(angC, RING_R + 40);
  const pc = smoothPath([[c0.x, c0.z], [c1.x, c1.z]], 0, 4);
  const low = lotAt(lowDef, c1.x + Math.sin(angC) * 2, c1.z + Math.cos(angC) * 2, Math.sin(angC), Math.cos(angC));
  low.y = yR + clamp(low.y - yR, -2.5, 2.5); // (level with the ring: a short spur)
  pc.push([low.ex, low.ez], [low.ex - low.dirx * 7, low.ez - low.dirz * 7]);
  // the roads (access roads: s = 0 at the car park / ring)
  const rev = (p) => p.slice().reverse();
  const RA = makeRoad(pa, { name: 'Panorama roundabout', x: ring.x, z: ring.z, ring: true }, { name: 'junction', x: J.x, z: J.z }, { y0: yR, y1: J.y, maxGrade: SC_GRADE, envelope: true });
  const RB = makeRoad(rev(pb), { name: top.name, x: top.ex, z: top.ez, lot: true }, { name: 'Panorama roundabout', x: ring.x, z: ring.z, ring: true }, { y0: top.y, y1: yR, maxGrade: SC_GRADE, envelope: true });
  const RC = makeRoad(rev(pc), { name: low.name, x: low.ex, z: low.ez, lot: true }, { name: 'Panorama roundabout', x: ring.x, z: ring.z, ring: true }, { y0: low.y, y1: yR, maxGrade: SC_GRADE, envelope: true });
  // the ring itself: a closed loop (drawn as a road, counted as tarmac by laneDistance), level
  const RR = ringRoad(ring, 'Panorama roundabout');
  for (const r of [RA, RB, RC, RR]) { r.access = true; r.scenic = true; }
  RA.ringAt0 = ring; RB.ringAtEnd = ring; RC.ringAtEnd = ring;
  RB.lot0 = top; RC.lot0 = low; RA.exitAt1 = { road: r0, s: J.s, x: J.x, z: J.z }; // (the scenic network's graph: scenicloop.js)
  RA.name = 'Panoramastrasse (valley)'; RB.name = 'Panoramastrasse'; RC.name = 'Talblick spur';
  ring.arms = [{ road: RA, end: 0, ang: angA }, { road: RB, end: 1, ang: angB }, { road: RC, end: 1, ang: angC }];
  busRoads.roads.push(RA, RB, RC, RR);
  busRoads.lots.push(top, low);
  busRoads.junctions.push({ x: J.x, z: J.z, scenic: true, road: r0, s: J.s, arm: RA });
  busRoads.junctions.push({ x: ring.x, z: ring.z, ring: true });
  busRoads.roundabouts = [ring];
  busRoads.scenic = { pins: ZZ.pins, junction: J, ring, climb: RB, approach: RA, spur: RC, top, low };
  // pull-outs on the climb: straight, gentle-ish stretches with the ground falling away on one side (the view)
  findLaybys(RB);
}

const REACH = 100, BATTER = 0.78; // m the cut reaches from the centre line; batter slope (tan 38 degrees)
const smin = (a, b, k) => { const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
const smax = (a, b, k) => -smin(-a, -b, k);
// One world cut for the scenic roads: flat across the road, eased back to the slope beyond the shoulder. Where two
// legs of the switchbacks lie close the ground between them blends between both (partition of unity: never a step);
// a pull-out's shoulder is wider; the roundabout's island a low snow dome inside its kerb.
export function shapeScenic() {
  const roads = busRoads.roads.filter((r) => r.scenic);
  if (!roads.length) return;
  const G = 32, grid = new Map();
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const r of roads) {
    const ri = busRoads.roads.indexOf(r);
    for (let i = 0; i < r.n - 1; i++) {
      const sg = { ax: r.X[i], az: r.Z[i], bx: r.X[i + 1], bz: r.Z[i + 1], ay: r.Y[i], by: r.Y[i + 1], ri, sa: r.S[i], sb: r.S[i + 1], r };
      const R = REACH, x0 = Math.min(sg.ax, sg.bx) - R, x1 = Math.max(sg.ax, sg.bx) + R, z0 = Math.min(sg.az, sg.bz) - R, z1 = Math.max(sg.az, sg.bz) + R;
      minx = Math.min(minx, x0); minz = Math.min(minz, z0); maxx = Math.max(maxx, x1); maxz = Math.max(maxz, z1);
      for (let cx = Math.floor(x0 / G); cx <= Math.floor(x1 / G); cx++) for (let cz = Math.floor(z0 / G); cz <= Math.floor(z1 / G); cz++) {
        const key = cx * 65536 + cz;
        let arr = grid.get(key);
        if (!arr) grid.set(key, (arr = []));
        arr.push(sg);
      }
    }
    const line = [];
    for (let i = 0; i < r.n; i += 3) line.push([r.X[i], r.Z[i]]);
    line.push([r.X[r.n - 1], r.Z[r.n - 1]]);
    world.addCorridor(line, BENCH + 3, 'lift', { busRoad: true, scenic: true });
  }
  const rings = busRoads.roundabouts || [];
  for (const ring of rings) world.addCorridor([[ring.x - 1, ring.z], [ring.x + 1, ring.z]], ring.R + BENCH, 'lift', { busRoad: true, scenic: true });
  const ringNear = (x, z, r) => { for (const ring of rings) if (Math.abs(x - ring.x) < r && Math.abs(z - ring.z) < r && Math.hypot(x - ring.x, z - ring.z) < r) return ring; return null; };
  const lb = (busRoads.laybys || []).filter((l) => l.scenic);
  // nearest point (d, y, s, ri, side, seg) and the nearest of another stretch (|s - s1| > 60 or another road)
  const A = { d: 0, y: 0, s: 0, ri: 0, side: 1, r: null }, B = { d: 0, y: 0, s: 0, ri: 0, side: 1, r: null };
  const CAND = [], BEST = new Map();
  const pick = (x, z) => {
    const arr = grid.get(Math.floor(x / G) * 65536 + Math.floor(z / G));
    A.d = B.d = Infinity;
    if (!arr) return;
    const cand = CAND; cand.length = 0;
    for (const s of arr) {
      const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
      const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z);
      cand.push([d, s, t]);
      if (d < A.d) set(A, d, s, t, x, z);
    }
    for (const [d, s, t] of cand) if (d < B.d && (s.r !== A.r || Math.abs(s.sa - A.s) > 60)) set(B, d, s, t, x, z);
  };
  const set = (o, d, s, t, x, z) => {
    o.d = d; o.y = s.ay + (s.by - s.ay) * t; o.s = s.sa + (s.sb - s.sa) * t; o.ri = s.ri; o.r = s.r;
    o.side = (s.bx - s.ax) * (z - s.az) - (s.bz - s.az) * (x - s.ax) >= 0 ? 1 : -1;
  };
  const bench = (o) => { let b = BENCH; for (const l of lb) if (l.ri === o.ri && l.side === o.side && Math.abs(l.s - o.s) < 22) b = Math.max(b, BENCH + 4 * smoothstep(22, 12, Math.abs(l.s - o.s))); return b; };

  world.addCut({
    bounds: { minx, minz, maxx, maxz },
    busRoads: true, scenic: true,
    apply(x, z, h, spacing = 0) {
      const ring = ringNear(x, z, ISLAND_R + 0.4);
      if (ring) {
        const rr = Math.hypot(x - ring.x, z - ring.z);
        return ring.y + 0.18 + 0.85 * Math.max(0, 1 - (rr / ISLAND_R) ** 2); // (kerb + snow dome)
      }
      pick(x, z);
      if (A.d > REACH) return h;
      // batters: beyond the flat shoulder the ground may rise or fall from the road at no more than ~38 degrees
      // (steeper only where the cut or fill is so deep it would not meet the slope within REACH), a soft crease where
      // the batter meets the slope; two stretches near each other (the switchbacks' legs): both their batters
      let out;
      const bA = bench(A);
      if (A.d <= bA) out = A.y;
      else {
        // (nearest first: a further leg narrows the band only as far as it still agrees with the nearer ones, so the
        // ground is continuous at every shoulder and between legs too steep apart the nearer leg's batter wins)
        const best = BEST; best.clear(); // (each road's stretch of ~48 m once: its nearest segment)
        for (const c of CAND) {
          if (c[0] > REACH) continue;
          const key = c[1].ri * 4096 + Math.floor(c[1].sa / 48), o = best.get(key);
          if (!o || c[0] < o[0]) best.set(key, c);
        }
        // (each stretch's band: y +- its batter, widened to nothing toward REACH so a stretch fades in smoothly)
        let lo = -Infinity, hi = Infinity, soft = 1.6, ws = 0, wy = 0;
        for (const [d, sg, t] of best.values()) {
          const y = sg.ay + (sg.by - sg.ay) * t, b = sg.r === A.r && Math.abs(sg.sa - A.s) < 30 ? bA : BENCH;
          const k = Math.max(BATTER, Math.abs(h - y) / (REACH - 2 - b)), f = smoothstep(REACH * 0.75, REACH, d);
          const e = Math.max(0, d - b), w = k * e + 4000 * f * f, l = y - w, u = y + w;
          lo = Math.max(lo, l); hi = Math.min(hi, u); soft = Math.min(soft, 0.2 * w + 0.01);
          // (inverse-distance weights of each band's own answer: used where the bands disagree)
          const wt = (1 - f) / ((e + 0.5) * (e + 0.5));
          ws += wt; wy += wt * (h < l ? l : h > u ? u : h);
        }
        // the bands agree (the batters meet the slope): the ground eased into all of them; where they do not (two legs
        // too steep apart, stacked switchbacks), each leg's own batter weighted by nearness, blended in by how far they
        // disagree: continuous everywhere (no cliffs where the nearest legs swap)
        if (lo <= hi) out = smax(smin(h, hi, soft), lo, soft);
        else {
          const c = h < hi ? hi : h > lo ? lo : h, W = ws > 0 ? wy / ws : c;
          out = c + (W - c) * smoothstep(0, 8, lo - hi) * smoothstep(0, 3, A.d - bA); // (A's own height at its shoulder)
        }
      }
      // the plough berm (as on the bus roads; none round the ring and at the pull-outs: berm() tapers there)
      if (spacing <= 4 && A.d > BERM_IN && A.d < BERM_IN + 4.8 && !A.r.ringRoad && !ringNear(x, z, RING_R + 22)) {
        const bm = berm(A.ri, A.side, A.s, A.r.length, x, z), t = (A.d - BERM_IN) / bm.W;
        if (bm.H > 0.01 && t > 0 && t < 1) out += bm.H * 0.8 * (t < 0.38 ? smoothstep(0, 0.38, t) : 1 - smoothstep(0.38, 1, t));
      }
      return out;
    },
  });
}

// The scenic traffic's tour (traffic.js drives a few cars round it, out and back, in the right-hand lane): out of the
// Talblick car park, up the spur, anticlockwise round the ring to the climb, up the switchbacks to the Gipfelblick car
// park (round in its aisle, a pause for the view), down again, anticlockwise round the ring, back down the spur and
// round in the Talblick car park. -> { X, Z, S, L, entries: [s before each ring entry], pauses: [s], ring } or null
export function scenicTour(lane = 1.6) {
  const SC = busRoads.scenic;
  if (!SC) return null;
  const { ring, climb: RB, spur: RC, top, low } = SC;
  const pts = [], entries = [], pauses = [], mark = [];
  const P = {};
  const along = (r, s0, s1) => { // a road's right-hand lane from s0 to s1 (either way)
    const dir = s1 > s0 ? 1 : -1;
    for (let s = s0; dir > 0 ? s <= s1 : s >= s1; s += dir * 2) { roadAt(r, s, P); const tx = P.dx * dir, tz = P.dz * dir; pts.push([P.x - tz * lane, P.z + tx * lane]); }
  };
  const angOf = (r, s) => { roadAt(r, s, P); return Math.atan2(P.x - ring.x, P.z - ring.z); };
  const round = (a0, a1) => { // anticlockwise (increasing angle) round the ring's single lane
    let d = a1 - a0; while (d <= 0.25) d += Math.PI * 2;
    const n = Math.ceil((d * ring.R) / 2);
    for (let i = 1; i < n; i++) { const a = a0 + (d * i) / n; pts.push([ring.x + Math.sin(a) * ring.R, ring.z + Math.cos(a) * ring.R]); }
  };
  const turnIn = (L) => { // in at the entrance, round in the aisle (radius ~4 m), out at the entrance
    const cx = L.x - L.dirx * 2, cz = L.z - L.dirz * 2, ax = L.dirx, az = L.dirz, bx = -az, bz = ax; // (a: toward the entrance)
    pts.push([L.ex, L.ez], [L.ex - ax * 4 + bx * 1.6, L.ez - az * 4 + bz * 1.6]);
    mark.push(['pause', pts.length]);
    for (let i = 0; i <= 10; i++) { const t = (i / 10) * Math.PI; pts.push([cx + bx * 4 * Math.cos(t) - ax * 4 * Math.sin(t), cz + bz * 4 * Math.cos(t) - az * 4 * Math.sin(t)]); }
    pts.push([L.ex - ax * 4 - bx * 1.6, L.ez - az * 4 - bz * 1.6], [L.ex, L.ez]);
  };
  const E = 12; // (an arm's lane ends this far from its end on the ring's centre line: then the ring)
  along(RC, 2, RC.length - E); mark.push(['entry', pts.length]); round(angOf(RC, RC.length - E), angOf(RB, RB.length - E));
  along(RB, RB.length - E, 2); turnIn(top);
  along(RB, 2, RB.length - E); mark.push(['entry', pts.length]); round(angOf(RB, RB.length - E), angOf(RC, RC.length - E));
  along(RC, RC.length - E, 2); turnIn(low);
  // corners rounded (Chaikin, twice), then every 2 m
  let p = pts;
  const keep = new Set();
  for (let k = 0; k < 2; k++) {
    const q = [];
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
    p = q;
  }
  void keep;
  const scale = p.length / pts.length;
  const X = [], Z = [], S = [];
  let s = 0, carry = 0;
  const raw = [0];
  for (let i = 1; i <= p.length; i++) raw.push(raw[i - 1] + Math.hypot(p[i % p.length][0] - p[i - 1][0], p[i % p.length][1] - p[i - 1][1]));
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = carry;
    while (t < l) { X.push(a[0] + ((b[0] - a[0]) * t) / l); Z.push(a[1] + ((b[1] - a[1]) * t) / l); S.push(s); s += 2; t += 2; }
    carry = t - l;
  }
  for (const [kind, i] of mark) (kind === 'entry' ? entries : pauses).push(raw[Math.min(raw.length - 1, Math.round(i * scale))]);
  return { X, Z, S, L: s, entries, pauses, ring };
}
