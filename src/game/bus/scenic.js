// The Panoramastrasse: a narrow scenic mountain road "the other way" from the bus roads (they run south down the
// valley; this one goes east, over the Legacy Express's tunnel under the village's edge, to the free mountain east of
// the resort) and up it in switchbacks to a summit viewpoint with a car park. Planned by roads.js planBusRoads (last,
// after the car parks / hospital / rental) and carved by its own world cut (shapeScenic). Pure layout (no THREE).
//   - the approach: A* (roads.js route) from a T junction on the village -> Sonnenkopf road east to a ROUNDABOUT at
//     the mountain's foot (three arms: the approach, the climb, a short spur to the Talblick car park)
//   - the climb: climb() routes it on the ground (Oct 29, the user: "make it like your driving up a real mountain"):
//     climbRouted, the heading-aware A* (scenicnet.js routeH) up to the summit, winding round the spurs and gullies,
//     the road's height following the ground (the flowing legs of zigzagFlow / the comb of zigzag, which ran up to
//     500 m under or over the ground, only a last fallback; gradeClimb, the grade line, on request); the profile is
//     capped at 11.5 % with both ends fixed (makeRoad envelope), the road banked into its bends, the cut into the
//     hillside and the fill an embankment at gentle batters, eased back into the slope (shapeScenic)
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
const HAIRPIN_R = 14;               // m (centre line): tight but a car (and a bus) gets round
export const RING_R = 15;           // the roundabout's centre line radius (single lane ring, the island inside)
export const ISLAND_R = RING_R - 3.4 - 0.7; // (ROAD_HALF 3.4: roads.js imports this module, so its constants are not ready here yet)
// the island's kerb and snow dome: inside a packed apron level with the ring, so every 2 m triangle of the drawn
// terrain touching the ring's lane (up to 2.83 m inside its inner edge) is flat (before, the kerb at the lane's edge
// lifted the lane's inner edge ~0.2 m off the road surface)
const DOME_R = RING_R - 3.4 - 2.9;
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

// The climb as an alpine road (Oct 29, the user: "they should not be like a zig zag road ... when you look between
// them there should be a big mountain where you drive up"). The comb above had short straight legs ~34 m apart joined
// by square-ended hairpins, the ground between them carved into terraces. Here, on the same proven layout (legs across
// the face, each next one where the ground has come up to the road's height, all checked against the no-go ground):
//   - long legs (fewer hairpins), their ends staggered, so the legs lie far apart: the next leg at least far enough up
//     that the natural slope between two legs stays under ~40 degrees (a real mountainside between them, not a bench)
//   - each leg bends with the terrain: shifted up or down the face (within ~30 % of the gap to its neighbours) toward
//     its grade line, the contour at the road's own height, eased (gentle curvature, no kinks), square into its hairpins
//   - each hairpin one smooth half turn into the slope across the whole gap (a wide gap: two wide quarter turns and a
//     short rise between), no straight-and-square corners
// -> { pts: [[x, z]...] every ~4 m from B, pins, yEnd, U, flow: true } or null
export function zigzagFlow(B, ang, y0, O, allowNear, { topH = TOP_H, bad: badFn = null, minPins = 1, legHalf = 260, bend = 0.42, side = 1, cap = null } = {}) {
  const bad = badFn || badGround(O, allowNear), ds = 4, R = HAIRPIN_R;
  const Ux = Math.sin(ang), Uz = Math.cos(ang), Cx = Uz * side, Cz = -Ux * side; // (uphill, across)
  const P = (u, l) => [B.x + Ux * u + Cx * l, B.z + Uz * u + Cz * l];
  const hash = (k) => { const v = Math.sin(k * 91.7 + 13.1 + side * 3.3) * 43758.5; return v - Math.floor(v); };
  const ends = []; // the hairpins' l (staggered)
  // (the legs shorten as the mountain narrows toward its top)
  let frac = 0;
  // (cap: { x, z, max }: the legs' ends on that side of the line up the face no further out than max: room kept there)
  const lEnd = (k) => {
    if (ends[k] !== undefined) return ends[k];
    const sg = k % 2 ? -1 : 1, c = [].concat(cap || []).find((q) => (Cx * q.x + Cz * q.z) * sg > 0.5);
    const L = Math.max(Math.min(legHalf, 130), legHalf * (1 - 0.7 * frac)) * (0.85 + 0.3 * hash(k));
    return (ends[k] = sg * (c ? Math.min(L, c.max * (0.9 + 0.1 * hash(k + 5))) : L));
  };
  // a hairpin across a gap: half an ellipse (semi-axes: half the gap up the face, its bulge past the leg's end)
  const pinAB = (gap) => { const a = gap / 2; return [a, Math.max(Math.sqrt(15 * a), Math.min(a, 46))]; };
  const pinLen = (gap) => { const [a, b] = pinAB(gap); return (Math.PI / 2) * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); };
  const G = (u, a, b) => { let t = 0, n = 0; const lo = Math.min(a, b), hi = Math.max(a, b); for (let l = lo; l <= hi; l += 20) { const [x, z] = P(u, l); t += world.height(x, z); n++; } return t / n; };
  // the skeleton: legs { u, l0, l1 } (the first from the middle out), the gaps du between them
  const legs = [{ u: 0, l0: 0, l1: lEnd(0) }];
  let s = Math.abs(lEnd(0)), u = 0;
  for (let k = 0; k < 30; k++) {
    const a = lEnd(k), b = lEnd(k + 1), L = Math.abs(b - a), g0 = G(u, a, b);
    let du = Math.max(2 * R + 4, (2 * 8.6 + DESIGN_G * (Math.PI * 22 + L)) / 0.84);
    while (du < 220 && G(u + du, a, b) < y0 + DESIGN_G * (s + pinLen(du) + L * 0.5)) du += 4;
    if (Math.max(G(u + 30, a, b), G(u + 60, a, b), G(u + 90, a, b)) < g0 + 1) { DBG('zf top', k, Math.round(y0 + DESIGN_G * s)); break; } // (over the top)
    s += pinLen(du) + L;
    frac = clamp((DESIGN_G * s) / Math.max(1, topH - y0), 0, 1);
    u += du;
    legs.push({ u, l0: a, l1: b });
    if (y0 + DESIGN_G * s > topH) break;
  }
  // (a quick look first: the skeleton's straight legs and its hairpins clear of no-go ground, before the slow part)
  for (let k = 0; k < legs.length; k++) {
    const L0 = legs[k];
    for (let l = L0.l0; Math.abs(l - L0.l0) <= Math.abs(L0.l1 - L0.l0); l += 10 * Math.sign(L0.l1 - L0.l0 || 1)) { const [x, z] = P(L0.u, l); if (bad(x, z)) { DBG('zf bad (quick)', Math.round(legHalf), side, k, Math.round(x), Math.round(z)); return null; } }
    if (k < legs.length - 1) {
      const gap = legs[k + 1].u - L0.u, [ea, eb] = pinAB(gap), dir = Math.sign(L0.l1 - L0.l0) || 1;
      for (let i = 1; i < 8; i++) { const a = (i / 8) * Math.PI, [x, z] = P(L0.u + ea - Math.cos(a) * ea, L0.l1 + dir * Math.sin(a) * eb); if (bad(x, z)) { DBG('zf bad pin (quick)', Math.round(legHalf), side, k); return null; } }
    }
  }
  // the geometry, leg by leg: the grade line within the leg's band, eased; the half turns between
  const out = [[B.x, B.z]];
  let sAt = 0;
  const push = (p) => { const q = out[out.length - 1]; sAt += Math.hypot(p[0] - q[0], p[1] - q[1]); out.push(p); };
  for (let k = 0; k < legs.length; k++) {
    const L0 = legs[k], dn = k ? L0.u - legs[k - 1].u : 60, up = k < legs.length - 1 ? legs[k + 1].u - L0.u : 60;
    const n = Math.max(2, Math.round(Math.abs(L0.l1 - L0.l0) / ds)), ls = [], du0 = [];
    for (let i = 0; i <= n; i++) ls.push(L0.l0 + ((L0.l1 - L0.l0) * i) / n);
    // (per station: the shift toward the contour at the road's height there)
    const yA = y0 + DESIGN_G * sAt;
    for (let i = 0; i <= n; i++) {
      const yi = yA + DESIGN_G * ds * i, lo = -bend * dn, hi = bend * up;
      let bestD = 0, be = Infinity;
      if (i % 2 && i < n) { du0.push(NaN); continue; } // (every other station: filled in between below)
      for (let d = lo; d <= hi; d += 3) { const [x, z] = P(L0.u + d, ls[i]); const e = Math.abs(world.height(x, z, 8) - yi) + Math.abs(d) * 0.02; if (e < be) { be = e; bestD = d; } }
      du0.push(bestD);
    }
    for (let i = 1; i < n; i++) if (Number.isNaN(du0[i])) du0[i] = (du0[i - 1] + du0[i + 1]) / 2;
    // eased: ~24 degrees at most off the face's line, square (no shift) over the 40 m into either end
    const RATE = 0.45 * ds;
    for (let i = 0; i <= n; i++) { const e = Math.min(i, n - i) * ds; du0[i] *= k === 0 && i < n / 2 ? Math.min(1, (i * ds) / 40) : Math.min(1, Math.max(0, (e - 8) / 40)); }
    for (let i = 1; i <= n; i++) du0[i] = clamp(du0[i], du0[i - 1] - RATE, du0[i - 1] + RATE);
    for (let i = n - 1; i >= 0; i--) du0[i] = clamp(du0[i], du0[i + 1] - RATE, du0[i + 1] + RATE);
    for (let pass = 0; pass < 6; pass++) for (let i = 1; i < n; i++) du0[i] = (du0[i - 1] + 2 * du0[i] + du0[i + 1]) / 4;
    for (let i = 1; i <= n; i++) push(P(L0.u + du0[i], ls[i]));
    if (k === legs.length - 1) break;
    // the half turn up to the next leg, bulging past this leg's end
    const gap = legs[k + 1].u - L0.u, [ea, eb] = pinAB(gap), dir = Math.sign(L0.l1 - L0.l0) || 1, le = L0.l1, cu = L0.u + ea;
    const m = Math.max(6, Math.ceil(pinLen(gap) / ds));
    for (let i = 1; i <= m; i++) { const a = (i / m) * Math.PI; push(P(cu - Math.cos(a) * ea, le + dir * Math.sin(a) * eb)); }
  }
  const pins = legs.length - 1;
  if (pins < minPins) return null;
  // (eased once more: corners cut and every bend opened to a bus's 13 m: roads.js smoothPath)
  const p = smoothPath(out, 4, 4);
  const badAt = p.findIndex((q) => bad(q[0], q[1]));
  if (badAt >= 0) { DBG('zf bad', legHalf, side, 'pins', pins, p[badAt].map(Math.round)); return null; }
  return { pts: p, pins, yEnd: y0 + DESIGN_G * sAt, U: [Ux, Uz], flow: true };
}
// The climb laid on the grade line (Oct 29, the user: "no mountains look like this ... make it like your driving up a
// real mountain"): the legs above were laid across a guessed face and their profile capped at ~10 %, so where the
// mountain did not face the way it was guessed the road ran hundreds of metres under (or over) the ground: the cut
// made combs of trenches and cliffs. Here the road walks up the mountain the way a surveyor lays a pass road: each
// 4 m step it takes the heading (no bend tighter than rMin) whose next ~40 m stays nearest the ground at the road's
// own height climbing at `grade`: it winds round the spurs and into the gullies, across the slope, the hill rising on
// one side and falling away on the other. Where it can go no further (no-go ground ahead, its own lower legs, too far
// out) it turns uphill in a hairpin and carries on the other way. The road's own height follows the ground (within
// gMin..gMax per metre), so the cut and fill stay a few metres. -> { pts, pins, yEnd, U, flow, gradeLine } or null
const Hg = (x, z) => (world.height(x, z, 8) * 2 + world.height(x + 12, z, 8) + world.height(x - 12, z, 8) + world.height(x, z + 12, 8) + world.height(x, z - 12, 8)) / 6;
export function gradeClimb(B, ang, y0, O, allowNear, opts = {}) {
  const { topH = TOP_H, bad: badFn = null, grade = 0.085, gMax = 0.1, gMin = -0.07, rMin = 55, pinR = 16, minSep = 48, maxLen = 9000, maxR = 1600, prefer = 2, maxPins = 9, pinGap = 160, target = null } = opts;
  const bad = badFn || badGround(O, allowNear), ds = 4, maxTurn = ds / rMin;
  const OFFS = [0, -0.1, 0.1, -0.25, 0.25, -0.45, 0.45, -0.7, 0.7, -1, 1, -1.35, 1.35, -1.7, 1.7];
  const pts = [[B.x, B.z]], S = [0];
  let x = B.x, z = B.z, hd = ang, y = y0, s = 0, pins = 0, lastPin = -Infinity, yBest = y0, gainS = 0, devSum = 0, devN = 0, devBig = 0;
  // (the path so far in 24 m cells: its own legs keep apart)
  const GC = 24, grid = new Map();
  const addPt = (i) => { const k = Math.floor(pts[i][0] / GC) * 65536 + Math.floor(pts[i][1] / GC); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); };
  addPt(0);
  // (closer than this to the path `ds` behind: legs that met; a hairpin's two legs start 2 pinR apart and must open)
  const need = (dS) => (dS < 70 ? 0 : clamp(0.2 * dS, 2 * pinR - 3, minSep));
  const crowded = (px, pz, sNow) => {
    const cx = Math.floor(px / GC), cz = Math.floor(pz / GC);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const arr = grid.get((cx + a) * 65536 + cz + b);
      if (arr) for (const i of arr) { const r = need(sNow - S[i]); if (r > 0 && Math.hypot(pts[i][0] - px, pts[i][1] - pz) < r) return true; }
    }
    return false;
  };
  const step = (nx, nz) => { s += Math.hypot(nx - x, nz - z); x = nx; z = nz; pts.push([x, z]); S.push(s); addPt(pts.length - 1); };
  while (s < maxLen) {
    if (y >= topH) break;
    // (over the top: the ground round about no higher than the road)
    let up = -Infinity;
    for (const rr of [50, 100, 160]) for (let a = 0; a < 6.28; a += 0.3) up = Math.max(up, Hg(x + Math.sin(a) * rr, z + Math.cos(a) * rr));
    // (a lower top on the way (a shoulder, a spur): over it toward the target, unless it has stopped gaining)
    if (up < y + 1.5 && (!target || Math.hypot(target.x - x, target.z - z) < 250 || s - gainS > 1200)) { DBG('grade top', Math.round(y)); break; }
    if (y > yBest + 5) { yBest = y; gainS = s; }
    // (its general way: toward the target, else the way it set out)
    const want = target && Math.hypot(target.x - x, target.z - z) > 120 ? Math.atan2(target.x - x, target.z - z) : ang;
    // (off its lead it may turn quickly: the caller rounds that corner)
    const mt = s < 24 ? 0.3 : maxTurn;
    // each way it could head (turning there no faster than rMin allows, then straight on), its next ~72 m: how near
    // the ground at the road's height climbing at `grade`, clear of no-go ground and of its own lower legs
    let best = null;
    for (const off of OFFS) {
      const goal = hd + off;
      let cost = 0, mis = 0, w = 0, hard = false, soft = false, px = x, pz = z, ph = hd, above = 0;
      for (let d = 4; d <= 72; d += 4) {
        ph += clamp(goal - ph, -mt, mt);
        px += Math.sin(ph) * 4; pz += Math.cos(ph) * 4;
        if (d % 8) continue;
        const e = Hg(px, pz) - (y + grade * d), wd = 1 / (1 + d / 40);
        mis += Math.abs(e) * wd; w += wd; if (d <= 32) above += e;
        if (bad(px, pz) || crowded(px, pz, s + d)) { if (d <= 16) { hard = true; break; } soft = true; cost += 60 * wd; }
        if (Math.hypot(px - B.x, pz - B.z) > maxR) cost += (2 + (Math.hypot(px - B.x, pz - B.z) - maxR) * 0.2) * wd;
      }
      if (hard) continue;
      mis /= w;
      cost += mis + 0.4 * Math.abs(off) + prefer * (1 - Math.cos(goal - want));
      if (!best || cost < best.cost) best = { cost, h: hd + clamp(off, -mt, mt), soft, mis, above };
    }
    // (boxed in, or the ground ahead everywhere well above the road: the head of a valley, a face too steep to
    // traverse: a hairpin)
    if (!best || best.soft || (best.mis > 12 && best.above > 0 && s - lastPin >= pinGap && pins < maxPins)) {
      // a hairpin: a half turn uphill (both ways tried, uphill first), then on the other way
      if (pins >= maxPins || s - lastPin < pinGap) { DBG('grade stuck', Math.round(x), Math.round(z), Math.round(y), 'pins', pins); break; }
      const nX = Math.cos(hd), nZ = -Math.sin(hd);
      const upSide = Hg(x + nX * 25, z + nZ * 25) >= Hg(x - nX * 25, z - nZ * 25) ? 1 : -1;
      let done = false;
      for (const sg of [upSide, -upSide]) {
        const n = Math.ceil((Math.PI * pinR) / ds), da = (sg * Math.PI) / n, ch = 2 * pinR * Math.sin(Math.abs(da) / 2), arc = [];
        let ax = x, az = z, ah = hd, ok = true;
        for (let i = 0; i < n && ok; i++) { const m = ah + da / 2; ax += Math.sin(m) * ch; az += Math.cos(m) * ch; ah += da; if (bad(ax, az)) ok = false; arc.push([ax, az]); }
        // (and room past it: the first stretch of the next leg clear)
        for (let d = 8; d <= 24 && ok; d += 8) { const px = ax + Math.sin(ah) * d, pz = az + Math.cos(ah) * d; if (bad(px, pz) || crowded(px, pz, s + Math.PI * pinR + d)) ok = false; }
        if (!ok) continue;
        for (const [px, pz] of arc) { step(px, pz); y += 0.06 * ds; }
        hd = ah; pins++; lastPin = s; done = true;
        break;
      }
      if (!done) { DBG('grade no pin', Math.round(x), Math.round(z), Math.round(y)); break; }
      continue;
    }
    hd = best.h;
    step(x + Math.sin(hd) * ds, z + Math.cos(hd) * ds);
    const hg = Hg(x, z);
    y = clamp(hg, y + gMin * ds, y + gMax * ds);
    devSum += Math.abs(hg - y); devN++; if (Math.abs(hg - y) > 8) devBig++;
  }
  if (y < topH - 60 || pts.length < 20) { DBG('grade short', Math.round(y), 'of', Math.round(topH), 'len', Math.round(s)); return null; }
  const p = smoothPath(pts, 3, 4);
  const badAt = p.findIndex((q) => bad(q[0], q[1]));
  if (badAt >= 0) { DBG('grade bad after smoothing', p[badAt].map(Math.round)); return null; }
  return { pts: p, pins, yEnd: y, U: [Math.sin(ang), Math.cos(ang)], flow: true, gradeLine: true, dev: devSum / Math.max(1, devN), devBig: devBig / Math.max(1, devN) };
}

// how far a road along p (from y0, ending wherever the ground takes it) would leave the ground: makeRoad's profile
// (the ground smoothed, the grade capped both ways) against the ground -> { dev (mean m), big (share > 8 m), yEnd }
export function roadDeviation(p, y0, y1 = null, maxGrade = SC_GRADE) {
  const r = makeRoad(p, {}, {}, { y0, y1, maxGrade, envelope: y1 !== null });
  let sum = 0, big = 0;
  for (let i = 0; i < r.n; i++) { const d = Math.abs(r.Y[i] - world.height(r.X[i], r.Z[i])); sum += d; if (d > 8) big++; }
  return { dev: sum / r.n, big: big / r.n, yEnd: r.Y[r.n - 1] };
}
// The climb routed (the heading-aware A*, scenicnet.js routeH): from B (heading ang) to opts.target, the road's height
// following the ground within the grade, cut and fill paid by the metre: the whole way searched at once (the grade
// line above only looks ~70 m ahead). -> { pts, pins, yEnd, dev, devBig, routed: true } or null
export function climbRouted(B, ang, y0, O, allowNear, opts = {}) {
  const T = opts.target;
  if (!T) return null;
  const bad = opts.bad || badGround(O, allowNear);
  // (the end: the clear spot nearest the target, on its highest ground nearby)
  let E = null;
  for (let dx = -200; dx <= 200; dx += 20) for (let dz = -200; dz <= 200; dz += 20) {
    const x = T.x + dx, z = T.z + dz;
    if (bad(x, z)) continue;
    const sc = Math.hypot(dx, dz) * 0.15 - Math.min(Hg(x, z), opts.topH ?? Infinity);
    if (!E || sc < E.sc) E = { x, z, sc };
  }
  if (!E) return null;
  // (a target above the top height (a summit, the road to stop on its shoulder): the spot on the way up to it where the
  // ground has come up to that height)
  if (opts.topH !== undefined && Hg(E.x, E.z) > opts.topH + 20) {
    const L = Math.hypot(E.x - B.x, E.z - B.z);
    for (let t = 0; t < L; t += 10) {
      const x = E.x + ((B.x - E.x) * t) / L, z = E.z + ((B.z - E.z) * t) / L;
      if (Hg(x, z) > opts.topH) continue;
      let F = null;
      for (let dx = -100; dx <= 100; dx += 20) for (let dz = -100; dz <= 100; dz += 20) { const px = x + dx, pz = z + dz; if (bad(px, pz)) continue; const sc = Math.abs(Hg(px, pz) - opts.topH) + Math.hypot(dx, dz) * 0.1; if (!F || sc < F.sc) F = { x: px, z: pz, sc }; }
      if (F) E = F;
      break;
    }
  }
  const yT = Math.min(Hg(E.x, E.z), opts.topH ?? Infinity);
  let best = null;
  // (the grade between the grid's cells paid gently (the ground is craggy at 20 m: a hard cap leaves no way at all and
  // the search gives up into the straightest line), the slope itself not at all: the road may cross a steep face)
  const VARS = [{ maxGrade: 0.1, grK: 0.1, maxTurn: 1.2 }, { maxGrade: 0.11, grK: 0.3, maxTurn: 0.8 }, { maxGrade: 0.1, grK: 0.3, maxTurn: 1.0, y0, exK: 20 }, { maxGrade: 0.09, grK: 1, maxTurn: 1.2 }, { maxGrade: 0.085, grK: 3, maxTurn: 1.2 }];
  for (const v of Array.isArray(opts.routeVariants) ? opts.routeVariants : VARS.slice(0, opts.routeVariants ?? 3)) {
    const raw = routeH(B, E, { obstacles: O, bad, margin: opts.margin ?? 700, soft: true, dirA: ang, steepPen: 0, ...v });
    if (!raw) { DBG('climb routed: no route', JSON.stringify(v)); continue; }
    // (smoothed; tighter to the grid's line where the smoothing cut a corner into no-go ground)
    let p = null;
    for (const eps of [6, 3, 1.5]) { const q = smoothRoute(raw, { eps, minR: 24 }); if (!q.some((t) => bad(t[0], t[1]))) { p = q; break; } }
    if (!p) { const q = smoothRoute(raw, { eps: 1.5, minR: 24 }), i = q.findIndex((t) => bad(t[0], t[1])); DBG('climb routed: bad after smoothing', JSON.stringify(v), i, q.length, q[i].map(Math.round), raw.findIndex((t) => bad(t[0], t[1]))); continue; }
    const sep = selfClearance(p, 120);
    if (sep < 26) { DBG('climb routed: legs too close', sep.toFixed(0)); continue; }
    const D = roadDeviation(p, y0, yT);
    let pins = 0;
    for (let i = 0; i + 18 < p.length; i += 6) { const a = Math.atan2(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]), b = Math.atan2(p[i + 18][0] - p[i + 17][0], p[i + 18][1] - p[i + 17][1]); if (Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) > 2.4) { pins++; i += 18; } }
    DBG('climb routed', JSON.stringify(v), 'len', p.length * 4, 'pins', pins, 'dev', D.dev.toFixed(1), (100 * D.big).toFixed(0) + '%', 'sep', sep.toFixed(0));
    const r = { pts: p, pins, yEnd: yT, dev: D.dev, devBig: D.big, U: [Math.sin(ang), Math.cos(ang)], flow: true, routed: true };
    if (!best || r.dev + 20 * r.devBig < best.dev + 20 * best.devBig) best = r;
    if (best.dev < 8 && best.devBig < 0.3) break; // (good enough: the search is not free)
  }
  return best;
}

// the climb: on the grade line (a few ways: gentler or steeper, freer or keener on its general direction); else the
// flowing legs, the longest that fit (either way across the face), else the old comb
export function climb(B, ang, y0, O, allowNear, opts = {}) {
  if (!opts.noGrade) {
    // (the one whose road keeps nearest the ground: routed to the target, or on the grade line)
    let best = null;
    try { best = climbRouted(B, ang, y0, O, allowNear, opts); } catch (e) { console.warn('climb routed', e); }
    if (best && (best.dev < 20 || !opts.gradeLine)) { DBG('climb picked routed', 'dev', best.dev.toFixed(1)); return best; }
    for (const v of !opts.gradeLine ? [] : [{}, { prefer: 4 }, { prefer: 1, grade: 0.095, rMin: 45 }, { grade: 0.095, rMin: 40, prefer: 4, minSep: 40 }, { grade: 0.075 }]) {
      const r = gradeClimb(B, ang, y0, O, allowNear, { ...opts, ...v });
      if (r) DBG('climb grade', JSON.stringify(v), 'pins', r.pins, 'yEnd', Math.round(r.yEnd), 'len', r.pts.length * 4, 'dev', r.dev.toFixed(1), (100 * r.devBig).toFixed(0) + '%');
      if (r && (!best || r.dev + 20 * r.devBig < best.dev + 20 * best.devBig)) best = r;
    }
    if (best) { DBG('climb picked', best.routed ? 'routed' : 'grade line', 'dev', best.dev.toFixed(1)); return best; }
    if (opts.noFlow) return null;
    console.warn('scenic climb: no grade line up from', Math.round(B.x), Math.round(B.z));
  }
  const lh = opts.legHalf ?? LEG_HALF;
  for (const f of opts.noComb ? [1.9, 1.6, 1.35, 1.15, 1, 0.85] : [1.9, 1.6, 1.35, 1.15]) for (const side of [1, -1]) for (const bend of [0.42, 0.2]) {
    const r = zigzagFlow(B, ang, y0, O, allowNear, { ...opts, legHalf: lh * f, side, bend });
    if (r && r.yEnd >= (opts.topH ?? TOP_H) - 60) { DBG('climb flow', f, side, bend, 'pins', r.pins, 'yEnd', Math.round(r.yEnd)); return r; }
    if (r) DBG('climb flow short', f, side, Math.round(r.yEnd));
  }
  return opts.noComb ? null : zigzag(B, ang, y0, O, allowNear, opts);
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
  // (the flowing climb; the old comb of straight legs only if it finds no way)
  // (the climb starts ~100 m out from the ring, so its legs leave room round the roundabout for its other arms; north
  // of it: room for the Passstrasse)
  let ZZ = null, lead = [];
  for (const out of [100, 60, 14]) {
    const bS = armPt(angB, RING_R + out), ld = [];
    for (let t = 14 + 4; t < out; t += 4) { const q = armPt(angB, RING_R + t); ld.push([q.x, q.z]); }
    if (ld.some((q) => bad(q[0], q[1]))) continue;
    ZZ = climb(bS, angB, yR + 0.04 * Math.max(0, out - 30), O, ring, { minDu: 34, cap: [{ x: 0, z: 1, max: 160 }, { x: 0, z: -1, max: 230 }], target: CLIMB_AT });
    if (ZZ) { lead = ld; break; }
  }
  if (!ZZ) { console.warn('scenic road: no climb', Math.round(ring.x), Math.round(ring.z)); return; }
  const zz = ZZ.pts.slice(Math.hypot(ZZ.pts[0][0] - b1.x, ZZ.pts[0][1] - b1.z) < 1 ? 1 : 0);
  // (the corner where the lead turns onto the first leg rounded)
  const pb = [[b0.x, b0.z], ...smoothPath([[b1.x, b1.z], ...lead, ...zz.slice(0, 18)], 4, 4), ...zz.slice(18)];
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
    // (Oct 29: the grade between cells paid gently, no pull toward y1, the bends it finds kept: it keeps near the ground)
    const raw = routeH(J1, p2, { obstacles: O, bad: badA, margin: 350, maxGrade: g, grK: 0.15, maxTurn: 1.0, soft: true, steepPen: 0 });
    if (!raw) continue;
    const p = smoothRoute([[p0.x, p0.z], [p1.x, p1.z], ...raw.reverse().slice(1)], { fixedA: 2, eps: 6, minR: 24 });
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
  top.y = Math.min(top.y, ZZ.yEnd, yR + 0.105 * 4 * pb.length); // (the pad at the road's height: cut into the summit if need be; never more than the road can climb)
  pb.push([top.ex, top.ez], [top.ex - top.dirx * 7, top.ez - top.dirz * 7]); // (in through the entrance: no gap)
  // C: a short spur to the Talblick car park (the side of the ring away from the other two arms)
  // (in the widest gap between the other two arms and the way the Passstrasse leaves for the pass: scenicloop.js)
  let angC = Math.atan2(-(Math.sin(angA) + Math.sin(angB)), -(Math.cos(angA) + Math.cos(angB)));
  {
    const dirs = [angA, angB, dirTo({ x: 2790, z: 1660 })].map((a) => (a + 4 * Math.PI) % (2 * Math.PI)).sort((p, q) => p - q);
    let best = -1;
    for (let k = 0; k < dirs.length; k++) { const a = dirs[k], b = k + 1 < dirs.length ? dirs[k + 1] : dirs[0] + 2 * Math.PI; if (b - a > best) { best = b - a; angC = (a + b) / 2; } }
  }
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

// m the cut reaches from the centre line; the batters: the cut into the hillside steep (rock and packed snow, tan 49
// degrees), the fill down the valley side an embankment (tan 36 degrees). (Oct 29: was 100 m and 38 degrees both ways:
// between the switchbacks' legs the mountain was carved into terraces; now the cut stays close to the road and the
// natural slope rises between the legs)
// (Oct 29, the user: "pls remove these stone walls": 49 / 36 degrees and an inverse-square blend between two legs made
// rock walls; now 39 / 32 degrees, a straight ramp between two legs' shoulders, and never a pit inside a hairpin)
const REACH = 80, CUT_K = 0.8, FILL_K = 0.62;
const smin = (a, b, k) => { const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
const smax = (a, b, k) => -smin(-a, -b, k);
// One world cut for the scenic roads: flat across the road, eased back to the slope beyond the shoulder. Where two
// legs of the switchbacks lie close the ground between them blends between both (partition of unity: never a step);
// a pull-out's shoulder is wider; the roundabout's island a low snow dome inside its kerb.
export function shapeScenic() {
  const roads = busRoads.roads.filter((r) => r.scenic);
  if (!roads.length) return;
  // each roundabout arm level with the ring until its shoulder is clear of the ring's (then up or down to its own
  // grade): before, an arm curving away beside the ring already 2-3 m above it met the ring's flat shoulder in a step
  for (const ring of busRoads.roundabouts || []) for (const a of ring.arms || []) {
    const r = a.road, n = r.n, D0 = RING_R + 2 * BENCH + 1;
    // (the ease from the ring's level back to the arm's own profile long enough to stay under ~10 %: before, a fixed
    // 22 m took up to 4 m: a 30 % ramp off the roundabout)
    const Yo = (dc) => { for (let k = 0; k < n; k++) { const i = a.end ? n - 1 - k : k; if (Math.hypot(r.X[i] - ring.x, r.Z[i] - ring.z) >= dc) return r.Y[i]; } return r.Y[a.end ? 0 : n - 1]; };
    let D1 = D0 + 22;
    const spur = r.lot0 && r.length < 120; // (a short spur to a car park: as it was, level into its car park)
    while (!spur && D1 < D0 + 140 && (D1 - D0) * 0.1 < 1.5 * Math.abs(Yo(D1) - ring.y)) D1 += 4;
    for (let k = 0; k < n; k++) {
      const i = a.end ? n - 1 - k : k, dc = Math.hypot(r.X[i] - ring.x, r.Z[i] - ring.z);
      if (dc > D1) break;
      r.Y[i] = ring.y + (r.Y[i] - ring.y) * smoothstep(D0, D1, dc);
    }
    // (then out along the arm no steeper than 13 %: it catches up with its own profile within a few hundred metres)
    // (and back from the far end the same: no step where it meets the profile there)
    if (!spur) for (const fwd of [true, false]) for (let k = 1; k < n; k++) {
      const i = a.end === fwd ? n - 1 - k : k, j = a.end === fwd ? i + 1 : i - 1, d = Math.abs(r.S[i] - r.S[j]) * 0.13;
      r.Y[i] = clamp(r.Y[i], r.Y[j] - d, r.Y[j] + d);
    }
  }
  // superelevation: the road banked into its bends (inside lower), up to 4 % on the tight ones (radius under ~60 m),
  // none on the straights, eased in and out along the road, none near its ends, its T junctions and lay-bys (level
  // there) or on a roundabout's ring. Signed by the side the bend turns to (as `side` below): bank * side * d lowers
  // the inside. (The car's physics feels it through the ground's slope: drive.js)
  const tees = busRoads.scenicTees || [];
  for (const r of roads) {
    const n = r.n, raw = new Float32Array(n), bank = new Float32Array(n);
    r.bank = bank;
    if (r.ringRoad || r.length < 120) continue;
    for (let i = 3; i < n - 3; i++) {
      const dx = r.X[i + 1] - r.X[i - 1], dz = r.Z[i + 1] - r.Z[i - 1], l = Math.hypot(dx, dz) || 1;
      const ax = r.X[i] - r.X[i - 3], az = r.Z[i] - r.Z[i - 3], bx = r.X[i + 3] - r.X[i], bz = r.Z[i + 3] - r.Z[i];
      const t = Math.atan2(ax * bz - az * bx, ax * bx + az * bz), R = (Math.hypot(ax, az) + Math.hypot(bx, bz)) / Math.max(1e-4, Math.abs(t));
      const turn = (dx / l) * (r.Z[i + 3] - r.Z[i]) - (dz / l) * (r.X[i + 3] - r.X[i]) >= 0 ? 1 : -1;
      raw[i] = 0.04 * clamp((60 / R - 0.15) / 0.85, 0, 1) * turn;
    }
    for (let i = 0; i < n; i++) {
      let t = 0, w = 0;
      for (let k = -6; k <= 6; k++) { const j = clamp(i + k, 0, n - 1), wt = 7 - Math.abs(k); t += raw[j] * wt; w += wt; }
      let f = smoothstep(30, 60, r.S[i]) * smoothstep(30, 60, r.length - r.S[i]);
      for (const tq of tees) { const d = Math.hypot(r.X[i] - tq.x, r.Z[i] - tq.z); if (d < 70) f *= smoothstep(35, 70, d); }
      for (const l of busRoads.laybys || []) if (l.scenic && busRoads.roads[l.ri] === r && Math.abs(l.s - r.S[i]) < 50) f *= smoothstep(25, 50, Math.abs(l.s - r.S[i]));
      bank[i] = (t / w) * f;
    }
  }
  const bankOff = (sg, t, side, d) => {
    const b = sg.ka + (sg.kb - sg.ka) * t;
    if (!b) return 0;
    return -b * side * Math.min(d, ROAD_HALF + 0.6) * (1 - smoothstep(ROAD_HALF + 0.6, BENCH - 0.6, d));
  };
  const G = 32, grid = new Map();
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const r of roads) {
    const ri = busRoads.roads.indexOf(r);
    for (let i = 0; i < r.n - 1; i++) {
      const sg = { ax: r.X[i], az: r.Z[i], bx: r.X[i + 1], bz: r.Z[i + 1], ay: r.Y[i], by: r.Y[i + 1], ri, sa: r.S[i], sb: r.S[i + 1], r, ka: r.bank[i], kb: r.bank[i + 1] };
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
  for (const ring of rings) ring.islandR = DOME_R; // (scenicprops.js: the boulders round the dome's foot)
  for (const ring of rings) world.addCorridor([[ring.x - 1, ring.z], [ring.x + 1, ring.z]], ring.R + BENCH, 'lift', { busRoad: true, scenic: true });
  const ringNear = (x, z, r) => { for (const ring of rings) if (Math.abs(x - ring.x) < r && Math.abs(z - ring.z) < r && Math.hypot(x - ring.x, z - ring.z) < r) return ring; return null; };
  const lb = (busRoads.laybys || []).filter((l) => l.scenic);
  // the bus roads and the car parks keep their own ground: the scenic cut may only ease toward them at a ~42 degree
  // batter (before, a switchback's deep fill 75 m off buried the valley bus road 23 m deep: the bus drove through the hill)
  const KEEP_K = 0.9, KG = 32, keep = new Map();
  busRoads.roads.forEach((r, ri) => {
    if (r.scenic) return;
    for (let i = 0; i < r.n - 1; i++) {
      const sg = [r.X[i], r.Z[i], r.X[i + 1], r.Z[i + 1], r.Y[i], r.Y[i + 1], ri * 4096 + Math.floor(r.S[i] / 48)], R = 80;
      for (let cx = Math.floor((Math.min(sg[0], sg[2]) - R) / KG); cx <= Math.floor((Math.max(sg[0], sg[2]) + R) / KG); cx++) for (let cz = Math.floor((Math.min(sg[1], sg[3]) - R) / KG); cz <= Math.floor((Math.max(sg[1], sg[3]) + R) / KG); cz++) {
        const key = cx * 65536 + cz;
        if (!keep.has(key)) keep.set(key, []);
        keep.get(key).push(sg);
      }
    }
  });
  const KB = new Map();
  const keepBand = (x, z, h, out) => {
    let lo = -Infinity, hi = Infinity;
    keepBand.d = Infinity;
    const arr = keep.get(Math.floor(x / KG) * 65536 + Math.floor(z / KG));
    if (arr) {
      KB.clear(); // (each road's stretch of ~48 m once: its nearest segment)
      for (const sg of arr) {
        const [ax, az, bx, bz, ay, by, key] = sg, ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1, t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
        const d = Math.hypot(ax + ex * t - x, az + ez * t - z), o = KB.get(key);
        if (!o || d < o[0]) KB.set(key, [d, ay + (by - ay) * t]);
      }
      for (const [d] of KB.values()) keepBand.d = Math.min(keepBand.d, d);
      // (+ the grade along the road for the further stretches: the next stretch of the same road agrees)
      for (const [d, y] of KB.values()) { const w = KEEP_K * Math.max(0, d - BENCH) + (d > keepBand.d ? 0.3 * d : 0); lo = Math.max(lo, y - w); hi = Math.min(hi, y + w); }
    }
    for (const L of busRoads.lots) {
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx) > 120 || Math.abs(dz) > 120) continue;
      const u = dx * L.ux + dz * L.uz, v = dx * L.vx + dz * L.vz, o = Math.hypot(Math.max(0, Math.abs(u) - L.hw), Math.max(0, Math.abs(v) - L.hd));
      const w = KEEP_K * Math.max(0, o - (L.flat ?? 1.5)); // (a building lot's wider flat apron: roads.js lotShape)
      lo = Math.max(lo, L.y - w); hi = Math.min(hi, L.y + w);
    }
    // (two of them disagree: pinned into the gap between them, continuous where they just meet)
    return clamp(out, Math.min(lo, hi, h), Math.max(lo, hi, h));
  };
  // nearest point (d, y, s, ri, side, seg) and the nearest of another stretch (|s - s1| > 60 or another road)
  const A = { d: 0, y: 0, s: 0, ri: 0, side: 1, r: null }, B = { d: 0, y: 0, s: 0, ri: 0, side: 1, r: null };
  const CAND = [], BANDS = [], BEST = new Map(), BO = { ri: 0, s: 0, side: 1 };
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
        return rr < DOME_R ? ring.y + 0.18 + 0.85 * Math.max(0, 1 - (rr / DOME_R) ** 2) : ring.y; // (kerb + snow dome inside the apron)
      }
      pick(x, z);
      if (A.d > REACH) return h;
      // batters: beyond the flat shoulder the ground may rise or fall from the road at no more than ~38 degrees
      // (steeper only where the cut or fill is so deep it would not meet the slope within REACH), a soft crease where
      // the batter meets the slope; two stretches near each other (the switchbacks' legs): both their batters
      let out;
      const bA = bench(A);
      // (each road's stretch of ~48 m once: its nearest point, its height and bench a soft blend of the segments
      // nearly as near (a hairpin or a tight corner inside one stretch: no step where its nearer leg swaps))
      const best = BEST; best.clear();
      for (const c of CAND) {
        if (c[0] > REACH) continue;
        const key = c[1].ri * 4096 + Math.floor(c[1].sa / 48), o = best.get(key), sg = c[1];
        const px = sg.ax + (sg.bx - sg.ax) * c[2], pz = sg.az + (sg.bz - sg.az) * c[2];
        if (!o) best.set(key, [c[0], 0, 0, 0, px, pz]); else if (c[0] < o[0]) { o[0] = c[0]; o[4] = px; o[5] = pz; }
      }
      for (const [d0, sg, t0] of CAND) {
        if (d0 > REACH) continue;
        const o = best.get(sg.ri * 4096 + Math.floor(sg.sa / 48)), wq = Math.exp(-(d0 - o[0]) / 1.5);
        if (wq < 1e-3) continue;
        // (its own bench: wider at its own lay-by; before, the lay-by's width jumped from one leg to the other
        // where the nearest leg swapped: a step in the ground)
        BO.ri = sg.ri; BO.s = sg.sa + (sg.sb - sg.sa) * t0; BO.side = (sg.bx - sg.ax) * (z - sg.az) - (sg.bz - sg.az) * (x - sg.ax) >= 0 ? 1 : -1;
        o[1] += wq; o[2] += wq * (sg.ay + (sg.by - sg.ay) * t0 + bankOff(sg, t0, BO.side, d0)); o[3] += wq * bench(BO);
      }
      if (A.d <= bA) {
        // on the shoulder: its height; where another stretch's shoulder overlaps (two arms by a roundabout, a spur at
        // its tee, the inside of a tight corner) the heights blended by nearness: no step where the nearer one swaps
        let ws = 0, wy = 0, dmin = Infinity;
        for (const v of BEST.values()) dmin = Math.min(dmin, v[0]);
        for (const [d, w0, ys, bs] of BEST.values()) {
          const b = bs / w0, w = Math.exp(-(d - dmin) / 1.0) * smoothstep(b + 2, b, d);
          if (w > 1e-4) { ws += w; wy += w * (ys / w0); }
        }
        out = ws > 0 ? wy / ws : A.y;
      } else {
        // (each stretch's band: y +- its batter; its weight below fades out toward REACH)
        let lo = -Infinity, hi = Infinity, soft = 1.6;
        const BD = BANDS; BD.length = 0;
        for (const [d, ws, ys, bs] of best.values()) {
          const y = ys / ws, b = bs / ws;
          const kc = Math.max(CUT_K, (h - y) / (REACH - 2 - b)), kf = Math.max(FILL_K, (y - h) / (REACH - 2 - b)), f = smoothstep(REACH * 0.75, REACH, d);
          // (a further stretch's band loosens from 40 m out, gently (0.2 m per m: at 1 m per m a deep cut's batter
          // steepened to 61 degrees from 32 m out: the rock walls), so one coming into reach never steps the ground)
          const e = Math.max(0, d - b), q = smoothstep(REACH * 0.92, REACH, d), w0 = 0.2 * Math.max(0, d - REACH * 0.5) + 3000 * q * q;
          const wl = kf * e + w0, wu = kc * e + w0, l = y - wl, u = y + wu, w = Math.min(wl, wu);
          lo = Math.max(lo, l); hi = Math.min(hi, u); soft = Math.min(soft, 0.2 * w + 0.01);
          BD.push((1 - f) / (e + 0.3), l, u); // (its inverse-distance weight: used where the bands disagree: a straight ramp between)
        }
        // the bands agree (the batters meet the slope): the ground eased into all of them; where they do not (two legs
        // too steep apart, stacked switchbacks), each leg's own batter weighted by nearness, blended in by how far they
        // disagree: continuous everywhere (no cliffs where the nearest legs swap)
        if (lo > hi - 4) {
          // (P: the ground pinned into the intersection, or into the gap between the bands where they disagree; W: each
          // band's nearest point to P weighted by nearness, so W = P where the bands just meet: no step there)
          const P = lo <= hi ? clamp(h, lo, hi) : clamp(h, hi, lo);
          let ws = 0, wy = 0;
          for (let q = 0; q < BD.length; q += 3) { ws += BD[q]; wy += BD[q] * clamp(P, BD[q + 1], BD[q + 2]); }
          const W = ws > 0 ? wy / ws : P, t = smoothstep(-4, 0, lo - hi);
          out = t >= 1 ? W : smax(smin(h, hi, soft), lo, soft) * (1 - t) + W * t;
        } else out = smax(smin(h, hi, soft), lo, soft);
        // between two stretches (the inside of a hairpin, two legs one above the other): never below the ramp from the
        // one's shoulder to the other's: the mountainside rises from the lower leg to the upper, no gully under both
        let s1 = null, s2 = null;
        for (const v of best.values()) { if (!s1 || v[0] < s1[0]) { s2 = s1; s1 = v; } else if (!s2 || v[0] < s2[0]) s2 = v; }
        if (s2 && s2[0] < 50) {
          const cs = ((s1[4] - x) * (s2[4] - x) + (s1[5] - z) * (s2[5] - z)) / (s1[0] * s2[0] + 1e-6);
          const f = smoothstep(-0.2, -0.6, cs) * smoothstep(50, 34, s2[0]);
          if (f > 0) {
            const yA = s1[2] / s1[1], yB = s2[2] / s2[1], eA = Math.max(0.01, s1[0] - s1[3] / s1[1]), eB = Math.max(0.01, s2[0] - s2[3] / s2[1]);
            const R = (yA * eB + yB * eA) / (eA + eB) - 1;
            if (out < R) out += (R - out) * f;
          }
        }
      }
      // the plough berm (as on the bus roads; none round the ring and at the pull-outs: berm() tapers there)
      if (spacing <= 4 && A.d > BERM_IN && A.d < BERM_IN + 4.8 && !A.r.ringRoad && !ringNear(x, z, RING_R + 22)) {
        const bm = berm(A.ri, A.side, A.s, A.r.length, x, z), t = (A.d - BERM_IN) / bm.W;
        if (bm.H > 0.01 && t > 0 && t < 1) out += bm.H * 0.8 * (t < 0.38 ? smoothstep(0, 0.38, t) : 1 - smoothstep(0.38, 1, t));
      }
      // (the scenic road's own surface wins on its shoulder: a junction, a lot's spur)
      const kept = keepBand(x, z, h, out);
      if (globalThis.__scDbg) globalThis.__scDbg.push({ bands: [...BANDS].map((v) => +v.toFixed(2)), best: [...BEST.entries()].map(([k, v]) => [k, v.map((q) => +q.toFixed(2))]), h, out, kept, Ad: A.d, Ay: A.y, As: A.s, An: A.r.name, kd: keepBand.d });
      // (and a bus road's where its centre line is the nearer one: the T junctions' mouths)
      return kept === out ? out : out + (kept - out) * Math.max(smoothstep(bench(A), bench(A) + 6, A.d), smoothstep(-1.5, 1.5, A.d - keepBand.d));
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
