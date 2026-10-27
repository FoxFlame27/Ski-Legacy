// Plans the Legacy Express (the high-speed line to every race): node tools/express-route.mjs
// Finds a stop beside each World Racing course's start (flat ground ~110-240 m out, clear of the course), then
// routes the ring village -> courses -> village through the valleys (A* on a 40 m height grid: length + climb),
// thins the path to control points (Douglas-Peucker) and writes them to src/world/expressdata.js. The runtime
// (src/world/expressroute.js) smooths the control polygon into the line and fits the vertical profile.
// Rerun when the courses or the terrain change.
globalThis.performance ??= { now: Date.now };
import fs from 'node:fs';
const { freeCourses } = await import('../src/modes/parkour/freeworld.js');
const { world } = await import('../src/world/world.js');
const { VILLAGE_STATION } = await import('../src/world/expressroute.js');

const E = Object.fromEntries(freeCourses().map((e) => [e.id, e]));
// the ring, counter-clockwise seen from above (north is -z): out of the village to the south-east, round, back from
// the south-west
const ORDER = ['forestgs', 'bigair', 'floodlight', 'icecanyon', 'eaglepeak', 'glaciersg', 'meadow', 'alpine'];
const HALL = VILLAGE_STATION; // the village's station (E-W, above ground north-west of the ski shop)

const G = 40, X0 = -11000, N = 550;
const H = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = world.height(X0 + i * G, X0 + j * G);
const cell = (x, z) => Math.round((z - X0) / G) * N + Math.round((x - X0) / G);

// keep off the courses (140 m from their lines)
const pen = new Float32Array(N * N);
const courseLine = (e) => { const T = e.course.track, o = []; for (let i = 0; i < T.n; i += 5) o.push([T.X[i], T.Z[i]]); return o; };
for (const e of Object.values(E)) for (const [x, z] of courseLine(e)) {
  const ci = Math.round((x - X0) / G), cj = Math.round((z - X0) / G);
  for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
    const ii = ci + di, jj = cj + dj;
    if (ii >= 0 && jj >= 0 && ii < N && jj < N && Math.hypot(di, dj) * G < 140) pen[jj * N + ii] = 1;
  }
}
// no-go cells: within 100 m of a start (the start house, the line-up, its shoulder) and 45 m of a course line (the
// line never runs under a start or close along a course; Oct 27, the user: "at Floodlight Slalom the race start is on
// top of the tunnel")
const block = new Uint8Array(N * N);
for (const e of Object.values(E)) {
  const mark = (x, z, r) => {
    const ci = Math.round((x - X0) / G), cj = Math.round((z - X0) / G), k = Math.ceil(r / G);
    for (let dj = -k; dj <= k; dj++) for (let di = -k; di <= k; di++) {
      const ii = ci + di, jj = cj + dj;
      if (ii >= 0 && jj >= 0 && ii < N && jj < N && Math.hypot(di, dj) * G <= r) block[jj * N + ii] = 1;
    }
  };
  mark(e.start.x, e.start.z, 100);
  for (const [x, z] of courseLine(e)) mark(x, z, 45);
}
const lineDist = (e, x, z) => { let d = Infinity; for (const [px, pz] of courseLine(e)) d = Math.min(d, Math.hypot(px - x, pz - z)); return d; };

// a stop beside each START (Oct 27, the user: "next to each race course there's a train station where the train
// departs and you never get teleported, always walking to the station or using the train"): the flattest spot
// 110-240 m from the start line, about level with it (a short walk over), 70 m+ off the course line and not down
// the course in front of the start
function stopFor(e) {
  const st = e.start, fx = Math.sin(st.heading), fz = Math.cos(st.heading);
  let best = null;
  for (const r of [110, 140, 170, 200, 240]) for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2, x = st.x + Math.cos(a) * r, z = st.z + Math.sin(a) * r;
    if (lineDist(e, x, z) < 70) continue;
    if (((x - st.x) * fx + (z - st.z) * fz) / r > 0.5) continue; // (not out in front, down the course)
    let lo = Infinity, hi = -Infinity;
    for (let q = 0; q < 8; q++) { const b = (q / 8) * Math.PI * 2, h = world.height(x + Math.cos(b) * 110, z + Math.sin(b) * 110); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const score = hi - lo + Math.abs(world.height(x, z) - st.y) * 0.6 + r * 0.05;
    if (!best || score < best.score) best = { x, z, score };
  }
  return { id: e.id, name: e.name, x: Math.round(best.x), z: Math.round(best.z), sx: Math.round(st.x), sz: Math.round(st.z) };
}

function astar(a, b) {
  const s = cell(a[0], a[1]), t = cell(b[0], b[1]);
  const g = new Float64Array(N * N).fill(Infinity), from = new Int32Array(N * N).fill(-1);
  g[s] = 0;
  const tx = t % N, tz = (t / N) | 0, hd = (v) => Math.hypot((v % N) - tx, ((v / N) | 0) - tz) * G;
  const heap = [[hd(s), s]];
  const push = (f, v) => { heap.push([f, v]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } }
    return top;
  };
  const D = [];
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if ((di || dj) && !(Math.abs(di) === 2 && Math.abs(dj) === 2) && !(Math.abs(di) + Math.abs(dj) === 2 && Math.abs(di) === 2) && !(Math.abs(di) + Math.abs(dj) === 2 && Math.abs(dj) === 2)) D.push([di, dj]);
  while (heap.length) {
    const [f, v] = pop();
    if (v === t) break;
    if (f - hd(v) > g[v] + 1e-6) continue;
    const vi = v % N, vj = (v / N) | 0;
    for (const [di, dj] of D) {
      const ii = vi + di, jj = vj + dj;
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
      const u = jj * N + ii, L = Math.hypot(di, dj) * G, dh = Math.abs(H[u] - H[v]);
      if (block[u] && u !== t) continue;
      const c = L * (1 + pen[u] * 25) + (dh * dh / L) * 60;
      if (g[v] + c < g[u]) { g[u] = g[v] + c; from[u] = v; push(g[u] + hd(u), u); }
    }
  }
  const path = [];
  for (let v = t; v !== -1; v = from[v]) path.push([X0 + (v % N) * G, X0 + ((v / N) | 0) * G]);
  path.reverse();
  path[0] = [a[0], a[1]]; path[path.length - 1] = [b[0], b[1]];
  return path;
}
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  let md = 0, mi = 0;
  const [ax, az] = pts[0], [bx, bz] = pts.at(-1), L = Math.hypot(bx - ax, bz - az) || 1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / L; if (d > md) { md = d; mi = i; } }
  if (md < tol) return [pts[0], pts.at(-1)];
  return [...dp(pts.slice(0, mi + 1), tol).slice(0, -1), ...dp(pts.slice(mi), tol)];
}

const stops = ORDER.map((id) => stopFor(E[id]));
// the village station's ends (the line leaves it east toward the first course and comes back in from the west)
const east = [HALL.x + HALL.len / 2 + 160, HALL.z], west = [HALL.x - HALL.len / 2 - 160, HALL.z];
const legs = [east, ...stops.map((s) => [s.x, s.z]), west];
const ctrl = [[HALL.x, HALL.z]];
const stopAt = { village: 0 };
for (let k = 0; k < legs.length - 1; k++) {
  const p = dp(astar(legs[k], legs[k + 1]), 150);
  for (let i = k === 0 ? 0 : 1; i < p.length; i++) ctrl.push(p[i].map(Math.round));
  if (k < stops.length) stopAt[stops[k].id] = ctrl.length - 1;
}
const out = `// GENERATED by tools/express-route.mjs (do not edit by hand: rerun it). The Legacy Express's control polygon: a
// ring from the village's underground hall through a stop beside every World Racing course's start and back.
export const EXPRESS_CTRL = ${JSON.stringify(ctrl)};
// index of each stop's control point, and the stops beside the courses (course id, name, position)
export const EXPRESS_STOP_AT = ${JSON.stringify(stopAt)};
export const EXPRESS_COURSE_STOPS = ${JSON.stringify(stops)};
`;
fs.writeFileSync(new URL('../src/world/expressdata.js', import.meta.url), out);
console.log('control points', ctrl.length, 'stops', JSON.stringify(stops));
