// The Legacy Express's ground works (expressroute.js is the line): main.js calls buildExpressGround() once, right
// after the World Racing courses are registered (the profile is fitted on their final ground) and before any terrain
// is built. It fits the profile, registers the roadbed (cuttings, embankments, portal cuts, the cover over the
// tubes; no trees on the formation), flattens the course stops' station squares and publishes the line for the
// trail map and the route picker as layout.express. Pure layout (no THREE): it runs in Node too.
//
// layout.express = {
//   name, pts: [[x, z, tunnel 0/1]...] (centre line every 20 m, the ring closed),
//   stations: [{ id ('village' | course id), name, course (course id | null), s, x, z, y (rail), heading (+s),
//                side (+1: the station's side, right of +s), underground,
//                board: { x, z } (where E boards: on the platform / at the village entrance),
//                exit: { x, z, heading } (where you stand after getting off) }]
// }
import { world } from './world.js';
import { layout } from './layout.js';
import { smoothstep } from '../core/noise.js';
import {
  EXPRESS, EXPRESS_NAME, fitExpressProfile, shapeExpressBed, expressAt, expressBounds, expressNearest, inExpressTunnel,
  TRACK_OFF, VILLAGE_ENTRANCE, PLATFORM, expressDeckHeight, LENGTH,
} from './expressroute.js';

export const PLATFORM_OFF = 7.2;   // m from the centre line to the middle of a side platform (3 m wide)
const _f = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
const beside = (s, lat) => { expressAt(s, _f); return { x: _f.x - _f.dz * lat, z: _f.z + _f.dx * lat, y: _f.y }; };

/** courses: freeCourses() (modes/parkour/freeworld.js), for the side each station's square faces. */
export function buildExpressGround(courses = []) {
  // (the profile on the ground without Legacy Peak: the line runs on through under it, in a tunnel)
  const natural = (x, z) => { world._noPeak = true; try { return world.height(x, z); } finally { world._noPeak = false; } };
  fitExpressProfile((x, z) => world.height(x, z), { under: keepUnder(courses), protect: courseGround(courses), natural });
  const L = EXPRESS;
  // the stations: side platforms either side of the double track; the station's side (entrance, square, exit) faces
  // the course's start (the station stands beside it: you walk over to the start house)
  const startOf = (id) => courses.find((e) => e.id === id)?.start;
  const stations = L.stations.map((st) => {
    expressAt(st.s, _f);
    const heading = Math.atan2(_f.dx, _f.dz), x = _f.x, z = _f.z, y = _f.y;
    if (st.underground) {
      const e = VILLAGE_ENTRANCE;
      return { id: st.id, name: st.name, course: null, s: st.s, x, z, y, heading, side: 1, underground: true, board: { x: e.x, z: e.z }, exit: { x: e.x + Math.sin(e.heading) * 3, z: e.z + Math.cos(e.heading) * 3, heading: e.heading } };
    }
    // which side the course's start is on
    const start = startOf(st.course) || st.toward; // (a halt: its square faces the way to its run)
    const side = !start || -_f.dz * (start.x - x) + _f.dx * (start.z - z) > 0 ? 1 : -1;
    const plat = beside(st.s, side * PLATFORM_OFF);
    const out = beside(st.s, side * (PLATFORM_OFF + 9));
    return {
      id: st.id, name: st.name, course: st.course, s: st.s, x, z, y, heading, side, underground: false,
      board: { x: plat.x, z: plat.z },
      exit: { x: out.x, z: out.z, heading: Math.atan2(-_f.dz * side, _f.dx * side) },
    };
  });
  // station squares: flat ground beside the platforms on the station's side (at platform height), and the far side
  for (const st of stations) {
    if (st.underground) continue;
    const y = st.y - 0.12;
    for (let s = st.s - PLATFORM / 2 + 10; s <= st.s + PLATFORM / 2 - 10; s += 22) {
      for (const side of [-1, 1]) {
        const p = beside(s, side * (PLATFORM_OFF + 4));
        world.addPad({ x: p.x, z: p.z, r: 8, blend: 14, h: y });
      }
    }
    const sq = beside(st.s, st.side * (PLATFORM_OFF + 16));
    world.addPad({ x: sq.x, z: sq.z, r: 14, blend: 18, h: y });
  }
  // the roadbed, and no trees on it or right beside it (the forest over the tunnels stays)
  const _n = { d: 0, s: 0, side: 0, i: 0 };
  world.addCut({
    bounds: expressBounds,
    apply: (x, z, h, spacing) => shapeExpressBed(x, z, h, spacing),
    forest: (x, z, f) => {
      const n = expressNearest(x, z, _n);
      if (!n) return f;
      if (inExpressTunnel(n.s, 20)) return f;
      // (under the viaducts too: no crown pokes up through a deck)
      return f * smoothstep(TRACK_OFF + 10, TRACK_OFF + 20, n.d);
    },
  });
  // the ballast bed and the viaducts' decks are walked on (not the formation, nor the valley under a deck)
  world.addLineSurface((s, o) => expressAt(s, o), LENGTH, expressDeckHeight);
  // the line for the trail map: centre line every 20 m with a tunnel flag, the ring closed
  const pts = [];
  for (let s = 0; s <= L.length; s += 20) { expressAt(s, _f); pts.push([_f.x, _f.z, inExpressTunnel(s) ? 1 : 0]); }
  layout.express = { name: EXPRESS_NAME, pts, stations };
  return layout.express;
}

// where the line has to stay deep underground: within 50 m of a race course's line (it tunnels under the track,
// never cuts across it) and 30 m of a lift line (its towers). A 10 m cell set.
function keepUnder(courses) {
  const C = 10, set = new Set();
  const mark = (ax, az, bx, bz, r) => {
    const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / C));
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps, z = az + ((bz - az) * k) / steps;
      for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) {
        if (Math.hypot(cx * C + C / 2 - x, cz * C + C / 2 - z) < r) set.add(cx * 100000 + cz);
      }
    }
  };
  for (const e of courses) { const T = e.course?.track; if (!T) continue; for (let i = 0; i + 4 < T.n; i += 4) mark(T.X[i], T.Z[i], T.X[i + 4], T.Z[i + 4], 50); }
  for (const l of layout.lifts) mark(l.bottom.x, l.bottom.z, l.top.x, l.top.z, 30);
  return (x, z) => set.has(Math.floor(x / C) * 100000 + Math.floor(z / C));
}

// the ground the roadbed shaper must never change: 35 m either side of a race course's line (the track, its berms and
// shoulders) and 60 m round its start and finish areas
function courseGround(courses) {
  const C = 10, set = new Set();
  const mark = (x, z, r) => {
    for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) {
      if (Math.hypot(cx * C + C / 2 - x, cz * C + C / 2 - z) < r + C * 0.7) set.add(cx * 100000 + cz);
    }
  };
  for (const e of courses) {
    const T = e.course?.track; if (!T) continue;
    for (let i = 0; i < T.n; i += 4) mark(T.X[i], T.Z[i], 35);
    if (e.start) mark(e.start.x, e.start.z, 60);
    if (e.finish) mark(e.finish.x, e.finish.z, 60);
  }
  return (x, z) => set.has(Math.floor(x / C) * 100000 + Math.floor(z / C));
}
