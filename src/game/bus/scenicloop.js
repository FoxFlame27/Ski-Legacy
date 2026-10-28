// More scenic roads round the back of the mountains (planned by roads.js right after the Panoramastrasse, carved by
// the same cut: scenic.js shapeScenic). Pure layout (no THREE): runs in Node too.
//   - the Passstrasse: a 4th arm off the Panorama roundabout, east along the foot of the Panorama mountain, over the
//     pass north of the Sonnenkopf's summit (the Passhöhe car park on a T junction at the top) and down in
//     switchbacks into the Ostal, the valley behind the Sonnenkopf, to the Ostal roundabout (its spur: the Ostal
//     car park)
//   - the Hinterkopfstrasse: the loop round the back: from the Ostal roundabout south through the Ostal to the
//     Hinterkopf roundabout in the hollow behind the Sonnenkopf (its spur: the Hinterkopf car park), west over the
//     Legacy Express's tunnel (deep under the ridge there), past the Sonnenblick car park (a T junction at the brink
//     of the Legacy valley: the view straight down 500 m) and down the valley's wall in switchbacks to a T junction
//     on the valley road (Sonnenkopf -> Valley Gondola)
// Kept off: the World Racing regions, the new ski sectors east of the Adlerhorn, lifts, pistes, the Express (but
// over that one tunnel), the car rental site, other roads.
// Also the scenic network's graph for the traffic (scenicGraph).
import { world } from '../../world/world.js';
import { expressNearest } from '../../world/expressroute.js';
import { busRoads, smoothPath, makeRoad, roadAt, laneDistance, CLEAR } from './roads.js';
import { zigzag, lotAt, ringRoad, findLaybys, RING_R } from './scenic.js';
import { routeH, smoothRoute } from './scenicnet.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const SC_GRADE = 0.115;
const DBG = (...a) => { if (globalThis.process?.env?.SCENIC_DEBUG) console.log(...a); };
const EAST_AT = { x: 3560, z: 1800 };     // the Ostal roundabout (the valley floor behind the Sonnenkopf)
const PASS_AT = { x: 2790, z: 1660 };     // the pass (the saddle north of the Sonnenkopf's summit)
const BACK_AT = { x: 2760, z: 3100 };     // the Hinterkopf roundabout (the hollow behind the Sonnenkopf)
const BRINK_AT = { x: 1760, z: 3300 };    // the top of the switchbacks down into the Legacy valley
const VALLEY_J = { x: 640, z: 3110 };     // the T junction on the valley road
const XING = [4150, 4470];                // the Express's arc length span (its tunnel under the ridge) we may cross
const SECTORS = { minx: 2380 - 130, maxx: 4200 + 130, minz: -640 - 130, maxz: 1150 + 130 }; // (sectors.js CLIP + room)

// no-go ground for the new roads: allow = [{x, z, r}] spots where other roads may be near (our junctions)
// the new roads planned so far (not in busRoads.roads yet: laneDistance does not see them), in 40 m cells
const PLAN = new Map();
function addPlanned(pts) { for (const [x, z] of pts) { const k = Math.floor(x / 40) * 65536 + Math.floor(z / 40); if (!PLAN.has(k)) PLAN.set(k, []); PLAN.get(k).push(x, z); } }
function nearPlanned(x, z) {
  let d = Infinity;
  const cx = Math.floor(x / 40), cz = Math.floor(z / 40);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const arr = PLAN.get((cx + a) * 65536 + cz + b); if (arr) for (let i = 0; i < arr.length; i += 2) d = Math.min(d, Math.hypot(arr[i] - x, arr[i + 1] - z)); }
  return d;
}
function badNet(O, allow = [], { xing = false, planned = true } = {}) {
  const q = {};
  const rental = busRoads.rental;
  return (x, z) => {
    if (x < -200 || x > 4120 || z < 200 || z > 3900) return true;
    if (x > SECTORS.minx && x < SECTORS.maxx && z > SECTORS.minz && z < SECTORS.maxz) return true;
    for (const r of world.regions) { const b = r.bounds; if (x > b.minx - 150 && x < b.maxx + 150 && z > b.minz - 150 && z < b.maxz + 150) return true; }
    if (rental && Math.hypot(x - rental.x, z - rental.z) < 90) return true;
    O.query(x, z, q);
    if (q.ski < CLEAR.ski + 14 || q.net < 12 || q.block < CLEAR.block + 4 || q.rail < 20 || q.lift < 12) return true;
    const c = world.corridorAt(x, z);
    if ((c.kind === 'piste' || c.kind === 'race') && c.d < 28) return true;
    const e = expressNearest(x, z);
    if (e && e.d < 50 && !(xing && e.s > XING[0] && e.s < XING[1])) return true;
    // (the car parks planned so far, 30 m round them: never across one, even near our own junctions; before, the
    // Passstrasse ran straight over the Talblick car park, 9 m above it: torn ground and a cliff through the bays)
    for (const L of busRoads.lots) {
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx) > 80 || Math.abs(dz) > 80) continue;
      const u = Math.abs(dx * L.ux + dz * L.uz) - L.hw, v = Math.abs(dx * L.vx + dz * L.vz) - L.hd;
      if (Math.hypot(Math.max(0, u), Math.max(0, v)) < 24) return true;
    }
    for (const a of allow) if (Math.hypot(x - a.x, z - a.z) < a.r) return false;
    return laneDistance(x, z) < 28 || (planned && nearPlanned(x, z) < 45);
  };
}

// the smoothed ground (local crags averaged out)
const Hs = (x, z) => (world.height(x, z, 8) * 2 + world.height(x + 14, z, 8) + world.height(x - 14, z, 8) + world.height(x, z + 14, 8) + world.height(x, z - 14, 8)) / 6;

// a roundabout site: the flattest clear spot near `at`
function ringSite(at, bad, span = 160) {
  let best = null;
  for (let dx = -span; dx <= span; dx += 20) for (let dz = -span; dz <= span; dz += 20) {
    const x = at.x + dx, z = at.z + dz;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let a = 0; a < 6.28 && ok; a += 0.52) for (const r of [0, 20, 40]) { const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r; if (bad(px, pz)) ok = false; const h = world.height(px, pz); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const sc = hi - lo + Math.hypot(dx, dz) * 0.02;
    if (ok && (!best || sc < best.sc)) best = { x, z, sc };
  }
  if (!best) return null;
  return { x: best.x, z: best.z, y: world.height(best.x, best.z), R: RING_R, arms: [] };
}
const armPt = (ring, ang, r) => ({ x: ring.x + Math.sin(ang) * r, z: ring.z + Math.cos(ang) * r });
const dirTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// an arm's angle near `want`, at least `gap` rad from the ring's other arms
function freeAngle(ring, want, gap = 0.95) {
  for (let k = 0; k < 40; k++) {
    const a = want + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.08;
    if (ring.arms.every((o) => Math.abs(wrap(o.ang - a)) >= gap)) return a;
  }
  return want;
}
// the radial start of an arm: [[x, z]] from the ring's centre line out to 30 m
const armStart = (ring, ang) => [0, 14, 30].map((r) => { const p = armPt(ring, ang, RING_R + r); return [p.x, p.z]; });

// a T junction with a short spur to a viewpoint car park, somewhere on road `road` between sA and sB: the side whose
// ground falls away most beyond the lot, clear of everything (and of the road's own other stretches)
function spurLot(road, sA, sB, def, bad, others = []) {
  const P = {}, A = {}, B = {};
  let best = null;
  const nearRoad = (x, z, s) => {
    let d = Infinity;
    for (let i = 0; i < road.n; i += 2) if (Math.abs(road.S[i] - s) > 45) d = Math.min(d, Math.hypot(road.X[i] - x, road.Z[i] - z));
    for (const o of others) for (let i = 0; i < o.n; i += 2) d = Math.min(d, Math.hypot(o.X[i] - x, o.Z[i] - z));
    return d;
  };
  for (let s = Math.max(40, sA); s <= Math.min(road.length - 40, sB); s += 12) {
    roadAt(road, s, P); roadAt(road, s - 20, A); roadAt(road, s + 20, B);
    if (Math.abs(Math.atan2(A.dx * B.dz - A.dz * B.dx, A.dx * B.dx + A.dz * B.dz)) > 0.15 || Math.abs(P.grade) > 0.08) continue;
    for (const side of [1, -1]) {
      const nx = -P.dz * side, nz = P.dx * side, L = 30;
      const ex = P.x + nx * L, ez = P.z + nz * L;
      const lot = lotAt(def, ex, ez, nx, nz);
      let ok = true;
      for (let t = 10; t <= L && ok; t += 4) { const x = P.x + nx * t, z = P.z + nz * t; if (bad(x, z) || nearRoad(x, z, s) < 16) ok = false; }
      for (let a = -def.hw - 4; a <= def.hw + 4 && ok; a += 6) for (let b = -def.hd - 4; b <= def.hd + 4 && ok; b += 6) {
        const x = lot.x + lot.ux * a + lot.vx * b, z = lot.z + lot.uz * a + lot.vz * b;
        if (bad(x, z) || nearRoad(x, z, s) < 18) ok = false;
      }
      if (!ok) continue;
      const view = P.y - Hs(lot.x + nx * (def.hd + 40), lot.z + nz * (def.hd + 40));
      const sc = view - Math.abs(lot.y - P.y) * 2;
      if (!best || sc > best.sc) best = { sc, s, side, P: { ...P }, lot, nx, nz, L };
    }
  }
  if (!best) return null;
  const { P: p, lot, nx, nz, L } = best;
  lot.y = p.y + clamp(lot.y - p.y, -2.5, 2.5); // (level with the road: a short spur)
  const pts = [[lot.ex - lot.dirx * 7, lot.ez - lot.dirz * 7], [lot.ex, lot.ez]];
  for (let t = L - 4; t >= 0; t -= 4) pts.push([p.x + nx * t, p.z + nz * t]);
  return { s: best.s, x: p.x, z: p.z, y: p.y, lot, pts };
}

// a road between two given ends, its middle routed (heading-aware A*, the grade soft: switchbacks where it can, the
// cut and fill elsewhere): head / tail [[x, z]...] fixed, y0 / y1 their heights -> [[x, z]...] every ~4 m or null
function routed(head, tail, y0, y1, bad, O, opts = {}) {
  const a = head[head.length - 1], b = tail[0];
  const dA = Math.atan2(a[0] - head[head.length - 2][0], a[1] - head[head.length - 2][1]);
  const dB = Math.atan2(tail[1][0] - b[0], tail[1][1] - b[1]);
  const raw = routeH({ x: a[0], z: a[1] }, { x: b[0], z: b[1] }, { obstacles: O, bad, margin: opts.margin ?? 450, maxGrade: 0.1, maxTurn: 0.8, soft: true, y0, y1: opts.noY1 ? undefined : y1, dirA: dA, dirB: dB, exK: opts.exK ?? 300 });
  if (!raw) return null;
  return smoothRoute([...head, ...raw.slice(1, -1), ...tail], { fixedA: head.length, fixedB: tail.length });
}

/** Plan the Passstrasse, the Hinterkopfstrasse, their roundabouts, junctions and car parks (appended to busRoads). */
export function planScenicLoop(O) {
  const SC = busRoads.scenic;
  if (!SC) return;
  const P0 = SC.ring;
  const t0 = Date.now();
  PLAN.clear();
  const roads = [], lots = [], tees = [];
  let RL1 = null, RL2 = null, brinkLot = null, H = null, passLot = null, RP = null;
  // ---- the Ostal roundabout
  const bad0 = badNet(O);
  const E = ringSite(EAST_AT, bad0);
  if (!E) { console.warn('scenic loop: no Ostal roundabout site'); return; }
  E.name = 'Ostal roundabout';
  // ---- the Passstrasse: the switchbacks up from the Ostal (zigzag from the roundabout), the rest routed
  const angEP = freeAngle(E, dirTo(E, PASS_AT));
  const bE = armPt(E, angEP, RING_R + 34); // (the switchbacks' first leg well clear of the roundabout's other arms)
  const badP = badNet(O, [{ x: P0.x, z: P0.z, r: 85 }, { x: E.x, z: E.z, r: 55 }]);
  const ZZ = zigzag(bE, angEP, E.y, O, null, { topH: Hs(PASS_AT.x, PASS_AT.z) - 4, bad: badP, minPins: 2, legHalf: 120 });
  if (!ZZ) { console.warn('scenic loop: no switchbacks up to the pass'); return; }
  DBG('pass zigzag pins', ZZ.pins, 'yEnd', ZZ.yEnd.toFixed(0), 'end', ZZ.pts[ZZ.pts.length - 1].map(Math.round));
  const zUp = ZZ.pts; // (from bE up to the top)
  const angPE = freeAngle(P0, dirTo(P0, { x: zUp[zUp.length - 1][0], z: zUp[zUp.length - 1][1] }));
  const headP = armStart(P0, angPE);
  const tailP = [...zUp.slice().reverse(), [armPt(E, angEP, RING_R).x, armPt(E, angEP, RING_R).z]];
  // (the routed part ends where the switchbacks begin, heading into their top leg)
  const tailR = tailP.slice(0, Math.min(tailP.length, 12));
  const mid = routed(headP, tailR, P0.y, ZZ.yEnd, badP, O);
  if (!mid) { console.warn('scenic loop: no way to the pass'); return; }
  const eEnd = [...zUp.slice(0, 12).reverse()];
  for (let t = 30; t >= 0; t -= 4) { const q = armPt(E, angEP, RING_R + t); eEnd.push([q.x, q.z]); }
  const passPts = [...mid, ...tailP.slice(12, tailP.length - 13), ...smoothPath(eEnd, 4, 4)]; // (the corner into the arm rounded)
  RP = makeRoad(passPts, { name: P0.name, ring: true }, { name: E.name, ring: true }, { y0: P0.y, y1: E.y, maxGrade: SC_GRADE, envelope: true });
  RP.name = 'Passstrasse'; RP.ringAt0 = P0; RP.ringAtEnd = E;
  roads.push(RP); addPlanned(passPts);
  P0.arms.push({ road: RP, end: 0, ang: angPE });
  E.arms.push({ road: RP, end: 1, ang: angEP });
  // the Passhöhe car park: on a T junction near the top
  let iTop = 0;
  for (let i = 0; i < RP.n; i++) if (RP.Y[i] > RP.Y[iTop]) iTop = i;
  const sTop = RP.S[iTop];
  passLot = spurLot(RP, sTop - 500, sTop + 200, { size: 'small', name: 'Passhöhe car park', hw: 15, hd: 9 }, badNet(O, [], { planned: false }));
  // ---- the Ostal car park (a short spur off the roundabout, on the side away from the pass)
  const lotSpur = (ring, want, name) => {
    for (let k = 0; k < 8; k++) {
      const ang = freeAngle(ring, want + k * 0.8);
      const c0 = armPt(ring, ang, RING_R), c1 = armPt(ring, ang, RING_R + 40);
      const lot = lotAt({ size: 'small', name, hw: 13, hd: 9 }, c1.x + Math.sin(ang) * 2, c1.z + Math.cos(ang) * 2, Math.sin(ang), Math.cos(ang));
      let ok = true;
      for (let a = -lot.hw - 3; a <= lot.hw + 3 && ok; a += 5) for (let b = -lot.hd - 3; b <= lot.hd + 3 && ok; b += 5) if (bad0(lot.x + lot.ux * a + lot.vx * b, lot.z + lot.uz * a + lot.vz * b)) ok = false;
      if (!ok) continue;
      lot.y = ring.y + clamp(lot.y - ring.y, -2.5, 2.5);
      const pc = smoothPath([[c0.x, c0.z], [c1.x, c1.z]], 0, 4);
      pc.push([lot.ex, lot.ez], [lot.ex - lot.dirx * 7, lot.ez - lot.dirz * 7]);
      const r = makeRoad(pc.slice().reverse(), { name, x: lot.ex, z: lot.ez, lot: true }, { name: ring.name, ring: true }, { y0: lot.y, y1: ring.y, maxGrade: SC_GRADE, envelope: true });
      r.name = name.replace(' car park', ' spur'); r.lot0 = lot; r.ringAtEnd = ring;
      ring.arms.push({ road: r, end: 1, ang });
      roads.push(r); lots.push(lot);
      return r;
    }
    return null;
  };
  // ---- the Hinterkopf roundabout and the road down the Ostal to it
  H = ringSite(BACK_AT, bad0);
  if (!H) { console.warn('scenic loop: no Hinterkopf roundabout site'); finish(); return; }
  H.name = 'Hinterkopf roundabout';
  const side = Math.sign(wrap(dirTo(E, H) - angEP)) || 1; // (away from the switchbacks)
  const angEH = freeAngle(E, dirTo(E, H) + side * 0.6), angHE = freeAngle(H, dirTo(H, E));
  const badL = badNet(O, [{ x: E.x, z: E.z, r: 55 }, { x: H.x, z: H.z, r: 55 }]);
  const pl1 = routed(armStart(E, angEH), armStart(H, angHE).reverse(), E.y, H.y, badL, O);
  if (pl1) {
    RL1 = makeRoad(pl1, { name: E.name, ring: true }, { name: H.name, ring: true }, { y0: E.y, y1: H.y, maxGrade: SC_GRADE, envelope: true });
    RL1.name = 'Ostalstrasse'; RL1.ringAt0 = E; RL1.ringAtEnd = H;
    roads.push(RL1); addPlanned(pl1);
    E.arms.push({ road: RL1, end: 0, ang: angEH });
    H.arms.push({ road: RL1, end: 1, ang: angHE });
  } else console.warn('scenic loop: no road down the Ostal');
  lotSpur(E, angEP + Math.PI * 0.75, 'Ostal car park');
  // ---- the Hinterkopfstrasse: west over the Express's tunnel, down the Legacy valley's wall to the valley road
  const main = busRoads.roads.filter((r) => !r.access && !r.scenic);
  let J = null;
  for (const m of main) for (let i = 0; i < m.n; i++) { const d = Math.hypot(m.X[i] - VALLEY_J.x, m.Z[i] - VALLEY_J.z); if (!J || d < J.d) J = { m, i, x: m.X[i], z: m.Z[i], y: m.Y[i], s: m.S[i], d }; }
  DBG('valley J', J && Math.round(J.d), J && [Math.round(J.x), Math.round(J.z)], 'passLot', !!passLot, 'sTop', Math.round(sTop), 'RP', Math.round(RP.length));
  if (H && J && J.d < 150) {
    const jd = roadAt(J.m, J.s), nx0 = -jd.dz, nz0 = jd.dx, sg = nx0 >= 0 ? 1 : -1, ux = nx0 * sg, uz = nz0 * sg; // (east)
    const B = { x: J.x + ux * 90, z: J.z + uz * 90 };
    const badD = badNet(O, [{ x: J.x, z: J.z, r: 75 }], { xing: true });
    const angUp = dirTo(B, BRINK_AT);
    DBG('valley B', Math.round(B.x), Math.round(B.z), 'top', Math.round(Hs(BRINK_AT.x, BRINK_AT.z)), 'y', Math.round(J.y));
    const ZD = zigzag(B, angUp, J.y + 0.098 * 90, O, null, { topH: Hs(BRINK_AT.x, BRINK_AT.z) - 6, bad: badD, minPins: 2, legHalf: 130 });
    if (ZD) {
      DBG('valley zigzag pins', ZD.pins, 'yEnd', ZD.yEnd.toFixed(0), 'end', ZD.pts[ZD.pts.length - 1].map(Math.round));
      const angHW = freeAngle(H, dirTo(H, BRINK_AT));
      const badW = badNet(O, [{ x: H.x, z: H.z, r: 55 }], { xing: true });
      const down = ZD.pts.slice().reverse(); // (from the top down to B)
      const head = armStart(H, angHW);
      const mid2 = routed(head, down.slice(0, 12), H.y, ZD.yEnd, badW, O, { margin: 400 });
      if (mid2) {
        const end = down.slice(-12);
        for (let t = 86; t >= 0; t -= 4) end.push([J.x + ux * t, J.z + uz * t]);
        const pts = [...mid2, ...down.slice(12, -12), ...smoothPath(end, 4, 4)]; // (the corner off the last leg rounded)
        RL2 = makeRoad(pts, { name: H.name, ring: true }, { name: 'junction', x: J.x, z: J.z }, { y0: H.y, y1: J.y, maxGrade: SC_GRADE, envelope: true });
        RL2.name = 'Hinterkopfstrasse'; RL2.ringAt0 = H; RL2.exitAt1 = { road: J.m, s: J.s, x: J.x, z: J.z };
        roads.push(RL2);
        H.arms.push({ road: RL2, end: 0, ang: angHW });
      } else console.warn('scenic loop: no way over to the valley wall');
    } else console.warn('scenic loop: no switchbacks down to the valley');
  }
  if (H.arms.length) lotSpur(H, dirTo(H, E) + Math.PI, 'Hinterkopf car park');
  // the Sonnenblick car park: a T junction at the brink of the Legacy valley
  if (RL2) {
    let sB = 0, bd = Infinity;
    for (let i = 0; i < RL2.n; i++) { const d = Math.hypot(RL2.X[i] - BRINK_AT.x, RL2.Z[i] - BRINK_AT.z); if (d < bd) { bd = d; sB = RL2.S[i]; } }
    brinkLot = spurLot(RL2, sB - 600, sB + 250, { size: 'small', name: 'Sonnenblick car park', hw: 15, hd: 9 }, badNet(O, [], { planned: false }), roads.filter((r) => r !== RL2));
  }
  finish();

  function finish() {
    const all = [...roads];
    // the spurs on T junctions (s = 0 at the car park, the end on the road they join)
    for (const [T, parent] of [[passLot, RP], [brinkLot, RL2]]) {
      if (!T || !parent) continue;
      const r = makeRoad(T.pts, { name: T.lot.name, x: T.lot.ex, z: T.lot.ez, lot: true }, { name: parent.name, x: T.x, z: T.z }, { y0: T.lot.y, y1: T.y, maxGrade: SC_GRADE, envelope: true });
      r.name = T.lot.name.replace(' car park', ' spur'); r.lot0 = T.lot; r.teeOn = parent; r.teeS = T.s;
      all.push(r); lots.push(T.lot);
      tees.push({ x: T.x, z: T.z, y: T.y, road: parent, s: T.s, spur: r });
    }
    for (const r of all) { r.access = true; r.scenic = true; r.loop = true; }
    const rings = [E, H].filter((g) => g.arms.length);
    const ringRoads = rings.map((g) => { const rr = ringRoad(g, g.name); rr.access = true; rr.scenic = true; rr.loop = true; return rr; });
    busRoads.roads.push(...all, ...ringRoads);
    busRoads.lots.push(...lots);
    busRoads.roundabouts.push(...rings);
    for (const g of rings) busRoads.junctions.push({ x: g.x, z: g.z, ring: true });
    for (const t of tees) busRoads.junctions.push({ x: t.x, z: t.z, scenic: true, tee: true });
    if (RL2) busRoads.junctions.push({ x: RL2.exitAt1.x, z: RL2.exitAt1.z, scenic: true, road: RL2.exitAt1.road, s: RL2.exitAt1.s, arm: RL2 });
    busRoads.scenicTees = tees;
    for (const r of [RP, RL1, RL2]) if (r) findLaybys(r, { max: 4, apart: 600 });
    SC.loop = { east: E, back: H, pass: RP, ostal: RL1, back2: RL2, ms: Date.now() - t0 };
    DBG('scenic loop', all.map((r) => `${r.name} ${Math.round(r.length)}`).join(', '), 'lots', lots.map((l) => l.name).join(', '), Date.now() - t0, 'ms');
  }
}

// ------------------------------------------------------------------ the graph (traffic.js drives it)
// nodes: { kind: 'ring' | 'lot' | 'tee' | 'exit', x, z, ring?, lot?, links: [{ e (edge), end (0: the edge's s0 end) }] }
// edges: { road, s0, s1, n0, n1 } (a scenic road, or the stretch of one between T junctions)
export function scenicGraph() {
  if (busRoads.scenicGraph) return busRoads.scenicGraph;
  const nodes = [], edges = [];
  const ringNode = new Map(), lotNode = new Map();
  const getRing = (g) => { if (!ringNode.has(g)) { const n = { kind: 'ring', x: g.x, z: g.z, ring: g, links: [] }; ringNode.set(g, n); nodes.push(n); } return ringNode.get(g); };
  const getLot = (l) => { if (!lotNode.has(l)) { const n = { kind: 'lot', x: l.ex, z: l.ez, lot: l, links: [] }; lotNode.set(l, n); nodes.push(n); } return lotNode.get(l); };
  const teesOn = new Map();
  for (const t of busRoads.scenicTees || []) { if (!teesOn.has(t.road)) teesOn.set(t.road, []); teesOn.get(t.road).push(t); }
  const teeNode = new Map();
  for (const t of busRoads.scenicTees || []) { const n = { kind: 'tee', x: t.x, z: t.z, tee: t, links: [] }; teeNode.set(t, n); nodes.push(n); }
  const endNode = (r, end) => {
    if (end === 0) {
      if (r.ringAt0) return getRing(r.ringAt0);
      if (r.lot0) return getLot(r.lot0);
      if (r.exitAt0) { const n = { kind: 'exit', x: r.X[0], z: r.Z[0], exit: r.exitAt0, links: [] }; nodes.push(n); return n; }
    } else {
      if (r.ringAtEnd) return getRing(r.ringAtEnd);
      if (r.teeOn) { const t = (busRoads.scenicTees || []).find((q) => q.spur === r); if (t) return teeNode.get(t); }
      if (r.exitAt1) { const n = { kind: 'exit', x: r.X[r.n - 1], z: r.Z[r.n - 1], exit: r.exitAt1, links: [] }; nodes.push(n); return n; }
    }
    return null;
  };
  for (const r of busRoads.roads) {
    if (!r.scenic || r.ringRoad) continue;
    const a = endNode(r, 0), b = endNode(r, 1);
    if (!a || !b) continue;
    const cuts = [{ s: 0, n: a }, ...(teesOn.get(r) || []).map((t) => ({ s: t.s, n: teeNode.get(t) })).sort((p, q) => p.s - q.s), { s: r.length, n: b }];
    for (let k = 0; k < cuts.length - 1; k++) {
      const e = { road: r, s0: cuts[k].s, s1: cuts[k + 1].s, n0: cuts[k].n, n1: cuts[k + 1].n };
      edges.push(e);
      e.n0.links.push({ e, end: 0 }); e.n1.links.push({ e, end: 1 });
    }
  }
  busRoads.scenicGraph = { nodes, edges };
  return busRoads.scenicGraph;
}
