// The ski bus up the mountain roads (Oct 29, the user: "also add more bus stops that way"): a line off the valley road
// at the Panoramastrasse's junction, up to the Panorama roundabout, up the Panoramastrasse's switchbacks (a stop half
// way, at a bend) to the Gipfelblick car park; and from the roundabout over the Passstrasse to the Ostal and up the
// Hochalmstrasse to the Hochalm viewpoint. The bus network is a tree of legs rooted at the village (bus.js parent /
// legs); each new stop gets one leg from the stop below it: pieces of the scenic roads joined end to end, round the
// roundabouts the way the traffic goes. Planned last (roads.js planBusRoads, after the Almdorf stop), pure layout.
// (roads.js imports this module and it imports roads.js: its bindings are only used inside functions)
import { busRoads, roadAt } from './roads.js';

const P = {};
// road r from arc length s0 to s1 (either way): [[x, y, z]...] every ~4 m, both ends included
function piece(r, s0, s1) {
  const n = Math.max(1, Math.round(Math.abs(s1 - s0) / 4)), out = [];
  for (let i = 0; i <= n; i++) { roadAt(r, s0 + ((s1 - s0) * i) / n, P); out.push([P.x, P.y, P.z]); }
  return out;
}
// round a roundabout's ring the way the traffic goes (increasing angle, as scenic.js scenicTour), from a0 to a1
function arc(ring, a0, a1) {
  let d = a1 - a0;
  while (d <= 0.05) d += Math.PI * 2;
  const n = Math.max(2, Math.ceil((d * ring.R) / 4)), out = [];
  for (let i = 1; i < n; i++) { const a = a0 + (d * i) / n; out.push([ring.x + Math.sin(a) * ring.R, ring.y, ring.z + Math.cos(a) * ring.R]); }
  return out;
}
// a bus leg (bus.js leg(): X, Y, Z, S, n, length, from, to) through the given points (consecutive duplicates dropped,
// the corners where one piece meets the next eased a little)
function leg(from, to, parts) {
  const pts = [];
  for (const p of parts) for (const q of p) { const l = pts[pts.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[2] - l[2]) > 0.8) pts.push(q); }
  for (let it = 0; it < 2; it++) for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    pts[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, (a[2] + 2 * b[2] + c[2]) / 4];
  }
  const n = pts.length, X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) { X[i] = pts[i][0]; Y[i] = pts[i][1]; Z[i] = pts[i][2]; if (i) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]); }
  return { from, to, n, X, Y, Z, S, length: S[n - 1], busLeg: true, scenicBus: true };
}
const stopAt = (name, r, s) => { roadAt(r, s, P); return { x: P.x, z: P.z, heading: 0, name, scenic: true }; };
const armOf = (ring, road) => ring?.arms?.find((a) => a.road === road) || null;

/** The mountain bus line's stops and legs (appended to busRoads.stops / busRoads.busLegs). */
export function planScenicBus() {
  const SC = busRoads.scenic;
  if (!SC || !SC.junction || !SC.approach || !SC.climb) return;
  const RA = SC.approach, RB = SC.climb, ring = SC.ring, jn = busRoads.junctions.find((j) => j.arm === RA);
  const base = jn?.road;
  if (!base) return;
  const legs = (busRoads.busLegs ||= []);
  // 1. "Panoramastrasse": on the valley road 30 m before the junction (from the village), its leg split there
  const sStop = jn.s - 30;
  let host = legs.find((l) => l.base === base && sStop > l.s0 + 20 && sStop < l.s0 + l.length - 20);
  if (!host) {
    if (legs.some((l) => l.base === base)) return; // (split elsewhere already: leave it)
    host = { base, s0: 0, length: base.length, from: base.from, to: base.to };
  }
  const slice = (a, b, from, to) => { const out = leg(from, to, [piece(base, a, b)]); out.base = base; out.s0 = a; return out; };
  const A = stopAt('Panoramastrasse', base, sStop);
  const hostEnd = host.s0 + host.length;
  const i = legs.indexOf(host);
  const l1 = slice(host.s0, sStop, host.from, A), l2 = slice(sStop, hostEnd, A, host.to);
  if (i >= 0) legs.splice(i, 1, l1, l2); else legs.push(l1, l2);
  const stops = [A];
  // 2. "Panorama roundabout": on the Panoramastrasse (valley) 55 m short of the roundabout
  const sB = Math.min(55, RA.length / 3), B = stopAt('Panorama Kreisel', RA, sB);
  legs.push(leg(A, B, [piece(base, sStop, jn.s), piece(RA, RA.length, sB)]));
  stops.push(B);
  // round the ring from the approach's arm to another arm's
  const aA = armOf(ring, RA), toRing = piece(RA, sB, 0);
  const viaRing = (road) => { const a = armOf(ring, road); return a && aA ? arc(ring, aA.ang, a.ang) : null; };
  // 3. "Panorama Kehre" half way up the climb, 4. "Gipfelblick" at its top (the climb: s = 0 at the car park)
  const rb = viaRing(RB);
  if (rb) {
    const sC = Math.round(RB.length * 0.5), C = stopAt('Panorama Kehre', RB, sC), sD = Math.min(16, RB.length / 4), D = stopAt('Gipfelblick', RB, sD);
    legs.push(leg(B, C, [toRing, rb, piece(RB, RB.length, sC)]));
    legs.push(leg(C, D, [piece(RB, sC, sD)]));
    stops.push(C, D);
  }
  // 5. "Ostal" over the Passstrasse (s = 0 at the Panorama roundabout), 6. "Hochalm" up the Hochalmstrasse
  const L = SC.loop, RP = L?.pass, E = L?.east, RL1 = L?.ostal, RH = SC.summit;
  const rp = RP && viaRing(RP);
  if (rp && E) {
    const sE = RP.length - 60, Es = stopAt('Ostal', RP, sE);
    // (a stop at the Passhöhe on the way: 25 m short of its car park's junction)
    const ph = (busRoads.scenicTees || []).find((t) => t.road === RP && /Passh/.test(t.spur?.lot0?.name || ''));
    const sP = ph ? ph.s - 25 : -1;
    if (ph && sP > 200 && sP < sE - 200) {
      const Ps = stopAt('Passhöhe', RP, sP);
      legs.push(leg(B, Ps, [toRing, rp, piece(RP, 0, sP)]), leg(Ps, Es, [piece(RP, sP, sE)]));
      stops.push(Ps);
    } else legs.push(leg(B, Es, [toRing, rp, piece(RP, 0, sE)]));
    stops.push(Es);
    const aP = armOf(E, RP), aO = armOf(E, RL1), tee = RH && (busRoads.scenicTees || []).find((t) => t.spur === RH);
    if (aP && aO && tee) {
      const sF = Math.min(16, RH.length / 4), F = stopAt('Hochalm', RH, sF);
      legs.push(leg(Es, F, [piece(RP, sE, RP.length), arc(E, aP.ang, aO.ang), piece(RL1, 0, tee.s), piece(RH, RH.length, sF)]));
      stops.push(F);
    }
  }
  busRoads.stops.push(...stops); // (the same array as layout.busStops: the stop list, the trail map and skibus.js show them)
  busRoads.scenicStops = stops;
}

/** The Westgrat stop at the top of the Westgratstrasse (rentalroad.js): one leg from the village stop, up the valley
 * road to the junction across from the car rental and up the Westgratstrasse (s = 0 at its car park). */
export function planWestgratBus() {
  const RW = busRoads.rentalRoad, ex = RW?.exitAt1;
  if (!RW || !ex || !RW.westRoad) return;
  const base = ex.road, v = busRoads.stops[0];
  if (!base || base.from !== v) return;
  const sW = Math.min(16, RW.length / 4), W = stopAt('Westgrat', RW, sW);
  (busRoads.busLegs ||= []).push(leg(v, W, [piece(base, 0, ex.s), piece(RW, RW.length, sW)]));
  busRoads.stops.push(W);
  (busRoads.scenicStops ||= []).push(W);
}
