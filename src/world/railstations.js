// The Wolkenspitzbahn's stations: platforms along the track, the station buildings (the valley station in
// Legacy Village: stone ground floor, timber upper floor, a deep snowy roof and a glazed platform canopy; a
// timber halt at Wolkensee by the frozen lake; the top station's glass hall on the glacier, its platform in a
// rock hall under the ice; Adlerwald, a request halt below the Adlerhorn, has a timber halt like Wolkensee's), name
// boards, timetable boards, benches and lamps. Each station also says where you
// board (board) and where you step out on arrival (exit).
import * as THREE from 'three';
import { world } from './world.js';
import { RAIL, railAt, PROFILE, CYCLE, DWELL_MID, haltArrival } from './railroute.js';
import { RailBuilder as B, railMaterials, canvasTex } from './railtrack.js';
import { mulberry32 } from '../core/noise.js';
import { makeLOD, bakeGeometry } from '../core/assets.js';
import { crisp } from './train.js';
import { seatsFromObject } from '../game/seating.js';
import { breakables } from './breakables.js'; // (the platform lamps: snapped off by a car over 100 km/h, Oct 31 2026)

// the station buildings are Meshy models (rail_station_valley / _halt / _glacier, main.js MODEL_LIST); without
// them (or with this off) the procedural buildings below stand in
export const MESHY_STATIONS = true;

const ALT0 = 1245;
const FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const RED = '#a5141c', WHITE = '#f4f2ed';
const _f = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };

// a point beside the line: lat m to the right of the centre line at arc length s (y = rail height there)
export function besideLine(s, lat) {
  railAt(s, _f);
  return { x: _f.x - _f.dz * lat, z: _f.z + _f.dx * lat, y: _f.y, heading: Math.atan2(_f.dx, _f.dz), dx: _f.dx, dz: _f.dz };
}

// ------------------------------------------------------------------ printed boards
const texCache = new Map();
function boardTex(key, w, h, draw) {
  if (texCache.has(key)) return texCache.get(key);
  const t = canvasTex(w, h, draw);
  texCache.set(key, t);
  return t;
}
// station name board: red with a white rim, the name and the altitude
function nameBoard(name, alt, wM = 5.2) {
  const t = boardTex(`name-${name}`, 1024, 256, (g, w, h) => {
    g.fillStyle = RED; g.fillRect(0, 0, w, h);
    g.strokeStyle = WHITE; g.lineWidth = 12; g.strokeRect(14, 14, w - 28, h - 28);
    g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `italic 700 118px ${FONT}`; g.fillText(name.toUpperCase(), w / 2, h * 0.42);
    g.font = `600 52px ${FONT}`; g.fillText(`${alt.toLocaleString('en-US')} m  ·  WOLKENSPITZBAHN`, w / 2, h * 0.8);
  });
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(wM, wM / 4), new THREE.MeshStandardMaterial({ map: t, color: t ? 0xffffff : 0xa5141c, roughness: 0.5, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0 }));
  face.position.z = 0.04;
  const back = new THREE.Mesh(new THREE.BoxGeometry(wM + 0.12, wM / 4 + 0.12, 0.07), new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.7 }));
  g.add(back, face);
  g.userData.face = face.material;
  return g;
}
// a name board as a free-standing sign (Oct 31 2026, the user: "the board doesn't look good, please fix all of these
// area boards": its posts were thin poles 3.2 m long hung off the board's middle, not standing on anything): nb
// (nameBoard, centred on its origin, front +z) mounted on two posts BEHIND it under its ends (inset 0.35 m, as thick
// as its 0.06 m rim x2), from the ground at each post (world.groundHeight, so they never float or sink) up to its
// top edge, on small concrete footings. o: the ground point under its centre; yaw: its front's heading; bottom: the
// board's bottom edge over o. Pushes the posts' colliders. Returns the group (origin at o).
const SIGN_POST = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.3 });
const SIGN_FOOT = new THREE.MeshStandardMaterial({ color: 0x9a968f, roughness: 0.9 });
function nameSign(nb, wM, o, yaw, colliders, { bottom = 2.3 } = {}) {
  const g = new THREE.Group(), hM = wM / 4, P = 0.12, pz = -(0.035 + P / 2);
  g.position.set(o.x, o.y, o.z); g.rotation.y = yaw;
  nb.position.set(0, bottom + hM / 2, 0);
  g.add(nb);
  const top = bottom + hM + 0.06, cx = Math.cos(yaw), cz = -Math.sin(yaw), bx = -Math.sin(yaw), bz = -Math.cos(yaw);
  for (const sx of [-1, 1]) {
    const x = sx * (wM / 2 - 0.35), wx = o.x + cx * x + bx * -pz, wz = o.z + cz * x + bz * -pz;
    const y0 = world.groundHeight(wx, wz, o.y + 3) - o.y, h = top - y0;
    if (h <= 0.2) continue;
    const post = new THREE.Mesh(new THREE.BoxGeometry(P, h, P), SIGN_POST);
    post.position.set(x, y0 + h / 2, pz); post.castShadow = true;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.34), SIGN_FOOT);
    foot.position.set(x, y0, pz); foot.receiveShadow = true;
    g.add(post, foot);
    colliders.push({ x: wx, z: wz, r: 0.12 });
  }
  return g;
}
// departures board: the ride times off the timetable (railroute.js), the interval between the two trains
function timetableBoard(stationName, id) {
  const trip = Math.round(PROFILE.trip / 60), every = Math.round(CYCLE / 2 / 60);
  const tA = haltArrival(id); // a halt: valley -> here (= here -> valley)
  const toVal = tA, toTop = tA === null ? 0 : PROFILE.trip - tA - DWELL_MID; // (here -> top = top -> here)
  const via = `via ${RAIL.stations.filter((st) => st.halt).map((st) => st.name).join(' · ')}`;
  const t = boardTex(`tt-${stationName}`, 512, 640, (g, w, h) => {
    g.fillStyle = '#16191e'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, 0, w, 96);
    g.fillStyle = WHITE; g.font = `italic 700 60px ${FONT}`; g.textBaseline = 'middle'; g.fillText('ABFAHRT · DEPARTURES', 24, 50);
    g.font = `600 40px ${FONT}`;
    const rows = stationName === 'Wolkenplatt'
      ? [['Legacy Village', `${trip} min`], [via, ''], ['every', `${every} min`]]
      : tA !== null
        ? [['Wolkenplatt', `${Math.max(1, Math.round(toTop / 60))} min`], ['Legacy Village', `${Math.max(1, Math.round(toVal / 60))} min`], ['every', `${every} min`]]
        : [['Wolkenplatt  2,611 m', `${trip} min`], [via, ''], ['every', `${every} min`]];
    rows.forEach(([a, b], i) => {
      const y = 160 + i * 90;
      g.fillStyle = '#ffb12e'; g.fillText(a, 28, y);
      g.textAlign = 'right'; g.fillText(b, w - 28, y); g.textAlign = 'left';
      g.fillStyle = '#2a2f36'; g.fillRect(24, y + 38, w - 48, 2);
    });
    g.fillStyle = '#c9ced6'; g.font = `500 32px ${FONT}`;
    g.fillText('Day pass valid · uphill $50', 28, h - 110); // (RAIL_PRICE in railway.js)
    g.fillText('Downhill free · skis in the cabin', 28, h - 64);
  });
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.5), new THREE.MeshStandardMaterial({ map: t, color: t ? 0xffffff : 0x16191e, roughness: 0.45, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.35 }));
  face.position.set(0, 1.9, 0.05);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.32, 1.62, 0.08), new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.3 }));
  frame.position.set(0, 1.9, 0);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), frame.material);
  post.position.set(0, 0.55, 0);
  g.add(frame, face, post);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ------------------------------------------------------------------ platform
// Platform slab beside the track from s0 to s1 on `side` (+1 right), with the white safety line and a curb.
function buildPlatform(b, s0, s1, side, width = 4.2) {
  const edge = 1.75, step = 2;
  let prev = null;
  for (let s = s0; s <= s1 + 1e-6; s += step) {
    railAt(Math.min(s, s1), _f);
    const rx = -_f.dz * side, rz = _f.dx * side;
    const y = _f.y + 0.06;
    const pts = [[edge, -0.68], [edge, 0], [edge + 0.12, 0], [edge + 0.62, 0], [edge + 0.7, 0], [edge + width, 0], [edge + width, -2.8]];
    const cols = ['#9b9892', '#d8d5ce', '#f2f2f0', '#c7c4bd', '#c7c4bd', '#c7c4bd', '#8f8c86'];
    const ring = pts.map(([d, dy], k) => b.v(_f.x + rx * d, y + dy, _f.z + rz * d, k === 0 ? -rx : k === pts.length - 1 ? rx : 0, k === 0 || k === pts.length - 1 ? 0 : 1, k === 0 ? -rz : k === pts.length - 1 ? rz : 0, cols[k]));
    if (prev) for (let k = 0; k < ring.length - 1; k++) { if (side > 0) b.quad(prev[k], ring[k], ring[k + 1], prev[k + 1]); else b.quad(prev[k], prev[k + 1], ring[k + 1], ring[k]); }
    prev = ring;
  }
}

// ------------------------------------------------------------------ the valley station building
// Local frame: x along the track (toward s1), z away from the track (the building's back), y up from the
// platform. Front (toward the track) at z = 0.
function buildStationHouse(stone, wood, glass, warm, { len = 24, depth = 11, floors = 2, clock = true } = {}) {
  const S = new B(), W = new B(), G = new B(), L = new B();
  const rnd = mulberry32(7741);
  const h1 = 3.8, h2 = floors > 1 ? 3.0 : 0;
  // the plinth: dressed stone a little proud of the walls, 5 m deep (wherever the ground falls away, the building
  // still stands on it)
  S.box(0, -2.45, depth / 2, len + 0.16, 5.0, depth + 0.16, '#6e6a63');
  S.box(0, 0.03, depth / 2, len + 0.22, 0.1, depth + 0.22, '#8f8a81');
  // stone ground floor: courses of slightly varied tone
  for (let y = 0; y < h1; y += 0.5) {
    for (const [x0, x1, z0, z1, n] of [[-len / 2, len / 2, 0, 0.6, 'f'], [-len / 2, len / 2, depth - 0.6, depth, 'b'], [-len / 2, -len / 2 + 0.6, 0, depth, 'l'], [len / 2 - 0.6, len / 2, 0, depth, 'r']]) {
      const v = 0.82 + rnd() * 0.16, col = new THREE.Color(0.62 * v, 0.6 * v, 0.56 * v).getHexString();
      S.box((x0 + x1) / 2, y + 0.25, (z0 + z1) / 2, x1 - x0, 0.48, z1 - z0, '#' + col);
      void n;
    }
  }
  // openings on the front: the main door, windows (dark glass, warm at night), the ticket window
  const openings = [];
  for (let x = -len / 2 + 2.2; x <= len / 2 - 2.2; x += 3.2) openings.push(x);
  for (const x of openings) {
    const door = Math.abs(x) < 1.7;
    const w = door ? 2.4 : 1.5, hgt = door ? 2.9 : 1.6, y0 = door ? 0 : 1.1;
    G.box(x, y0 + hgt / 2, -0.03, w, hgt, 0.06, '#ffffff');
    L.box(x, y0 + hgt / 2, 0.05, w - 0.05, hgt - 0.05, 0.02, '#ffffff');
    S.box(x, y0 + hgt + 0.18, -0.08, w + 0.5, 0.36, 0.2, '#b9b3a8'); // lintel
    if (!door) S.box(x, y0 - 0.08, -0.12, w + 0.3, 0.12, 0.28, '#b9b3a8'); // sill
  }
  // timber upper floor: vertical boards, windows with shutters
  if (h2) {
    for (const [x0, x1, z0, z1] of [[-len / 2, len / 2, 0, 0.3], [-len / 2, len / 2, depth - 0.3, depth], [-len / 2, -len / 2 + 0.3, 0, depth], [len / 2 - 0.3, len / 2, 0, depth]]) {
      const n = Math.round(Math.max(x1 - x0, z1 - z0) / 0.32);
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, tone = 0.85 + rnd() * 0.2;
        const col = '#' + new THREE.Color(0.36 * tone, 0.22 * tone, 0.13 * tone).getHexString();
        if (x1 - x0 > z1 - z0) W.box(x0 + (x1 - x0) * (t0 + t1) / 2, h1 + h2 / 2, (z0 + z1) / 2, (x1 - x0) / n - 0.015, h2, z1 - z0, col);
        else W.box((x0 + x1) / 2, h1 + h2 / 2, z0 + (z1 - z0) * (t0 + t1) / 2, x1 - x0, h2, (z1 - z0) / n - 0.015, col);
      }
    }
    W.box(0, h1 + 0.06, depth / 2, len + 0.3, 0.14, depth + 0.3, '#4a2f1c'); // floor beam
    for (const x of openings) {
      G.box(x, h1 + 1.45, -0.02, 1.2, 1.3, 0.04, '#ffffff');
      L.box(x, h1 + 1.45, 0.05, 1.15, 1.25, 0.02, '#ffffff');
      for (const sx of [-1, 1]) W.box(x + sx * 0.95, h1 + 1.45, -0.06, 0.55, 1.4, 0.06, '#6b2a1d'); // shutters
    }
  }
  // roof: gabled along the length, deep overhangs, a thick snow cover
  const top = h1 + h2, ridge = top + depth * 0.32, over = 1.4;
  const roofSlab = (sideZ) => {
    // a slab from the eave (z = -over or depth + over) to the ridge (z = depth / 2)
    const za = sideZ < 0 ? -over : depth + over, zb = depth / 2;
    const ya = top - 0.15, yb = ridge;
    const x0 = -len / 2 - over, x1 = len / 2 + over;
    const nrm = sideZ < 0 ? [0, Math.cos(0.6), -Math.sin(0.6)] : [0, Math.cos(0.6), Math.sin(0.6)];
    for (const [dy, col] of [[0, '#3a3633'], [0.32, '#f3f6fa']]) {
      const a = W.v(x0, ya + dy, za, ...nrm, col), b2 = W.v(x1, ya + dy, za, ...nrm, col), c = W.v(x1, yb + dy, zb, ...nrm, col), d = W.v(x0, yb + dy, zb, ...nrm, col);
      if (sideZ < 0) W.quad(b2, a, d, c); else W.quad(a, b2, c, d);
    }
    // the snow's thickness at the eave
    const e0 = W.v(x0, ya, za, 0, 0, sideZ < 0 ? -1 : 1, '#e9eef5'), e1 = W.v(x1, ya, za, 0, 0, sideZ < 0 ? -1 : 1, '#e9eef5'), e2 = W.v(x1, ya + 0.32, za, 0, 0, sideZ < 0 ? -1 : 1, '#f3f6fa'), e3 = W.v(x0, ya + 0.32, za, 0, 0, sideZ < 0 ? -1 : 1, '#f3f6fa');
    if (sideZ < 0) W.quad(e1, e0, e3, e2); else W.quad(e0, e1, e2, e3);
  };
  roofSlab(-1); roofSlab(1);
  // gable ends
  for (const sx of [-1, 1]) {
    const x = sx * len / 2;
    const a = W.v(x, top, -0.0, sx, 0, 0, '#5a3a22'), b2 = W.v(x, top, depth, sx, 0, 0, '#5a3a22'), c = W.v(x, ridge - 0.1, depth / 2, sx, 0, 0, '#5a3a22');
    if (sx > 0) W.tri(b2, a, c); else W.tri(a, b2, c);
  }
  // clock on the front, at the eave's middle
  if (clock) {
    S.box(0, top + 0.9, -over + 0.6, 1.5, 1.5, 0.2, '#f5f3ee');
    S.box(0, top + 0.9, -over + 0.48, 0.08, 0.6, 0.03, '#111111');
    S.box(0.18, top + 0.95, -over + 0.47, 0.42, 0.06, 0.03, '#111111');
  }
  const grp = new THREE.Group();
  const add = (bd, mat, cast = true) => { const geo = bd.build(); if (!geo) return; const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; grp.add(m); };
  add(S, stone); add(W, wood); add(G, glass, false); add(L, warm, false);
  grp.userData.size = { len, depth, height: ridge + 0.4 };
  return grp;
}

// ------------------------------------------------------------------ the top station on the glacier
// The train arrives in the rock hall under the ice; the station building stands on the glacier above it: a stone
// ground floor with big windows, a glazed upper hall under a flat roof (red fascia, the name board), a weather
// station on the roof, and a timber viewing terrace in front with a railing, telescopes and benches, looking down
// the glacier and the Wolkental to Legacy Village. Local frame: x along the front, z back, front at z = 0.
function buildGlacierStation(M, steel, { terraceOnly = false } = {}) {
  const S = new B(), W = new B(), G = new B(), L = new B(), P = new B();
  const rnd = mulberry32(9931);
  const len = 24, depth = 13, h1 = 4.2, h2 = 3.6, top = h1 + h2;
  if (!terraceOnly) {
  // stone ground floor (a skirt below the ground hides any step of the pad), coursed blocks of varied tone
  const course = (x0, x1, z0, z1, y0, y1) => {
    for (let y = y0; y < y1 - 1e-6; y += 0.5) {
      const v = 0.8 + rnd() * 0.17, col = '#' + new THREE.Color(0.6 * v, 0.585 * v, 0.55 * v).getHexString();
      S.box((x0 + x1) / 2, y + Math.min(0.5, y1 - y) / 2, (z0 + z1) / 2, x1 - x0, Math.min(0.5, y1 - y) - 0.02, z1 - z0, col);
    }
  };
  course(-len / 2, len / 2, depth - 0.6, depth, -3.5, h1);
  course(-len / 2, -len / 2 + 0.6, 0, depth, -3.5, h1);
  course(len / 2 - 0.6, len / 2, 0, depth, -3.5, h1);
  // the front: piers between big windows and the door in the middle
  const bays = [-10.2, -6.2, -2.2, 2.2, 6.2, 10.2];
  for (let i = 0; i < bays.length - 1; i++) {
    const a = bays[i], b = bays[i + 1], mid = (a + b) / 2, door = Math.abs(mid) < 1;
    course(a - 0.6, a + 0.6, 0, 0.6, -1.5, h1); // pier
    if (door) {
      G.box(mid, 1.6, 0.25, b - a - 1.2, 3.2, 0.06, '#ffffff');
      L.box(mid, 1.6, 0.4, b - a - 1.3, 3.1, 0.02, '#ffffff');
      course(a + 0.6, b - 0.6, 0, 0.6, 3.3, h1); // lintel
      S.box(mid, 3.25, -0.05, b - a - 0.9, 0.16, 0.3, '#bdb7ab');
    } else {
      course(a + 0.6, b - 0.6, 0, 0.6, -1.5, 0.8); // sill wall
      G.box(mid, 2.05, 0.25, b - a - 1.2, 2.5, 0.06, '#ffffff');
      L.box(mid, 2.05, 0.4, b - a - 1.3, 2.4, 0.02, '#ffffff');
      course(a + 0.6, b - 0.6, 0, 0.6, 3.3, h1);
      S.box(mid, 0.78, -0.08, b - a - 1.0, 0.1, 0.34, '#bdb7ab');
    }
  }
  course(bays[0] - 0.6 - (len / 2 + bays[0] - 0.6), bays[0] - 0.6, 0, 0.6, -1.5, h1); // corner piece left
  course(bays.at(-1) + 0.6, len / 2, 0, 0.6, -1.5, h1);
  // the floor slab between the storeys, then the glazed hall: steel posts, glass, the warm interior behind
  S.box(0, h1 + 0.12, depth / 2, len + 0.3, 0.26, depth + 0.3, '#9a958c');
  const posts = [];
  for (let x = -len / 2; x <= len / 2 + 1e-6; x += 2.4) posts.push([x, 0.25], [x, depth - 0.25]);
  for (let z = 2.4; z < depth - 1; z += 2.4) posts.push([-len / 2 + 0.25, z], [len / 2 - 0.25, z]);
  for (const [x, z] of posts) P.box(x, h1 + h2 / 2 + 0.12, z, 0.16, h2, 0.16, '#2f3338');
  for (const [z, nz] of [[0.25, -1], [depth - 0.25, 1]]) { G.box(0, h1 + h2 / 2 + 0.12, z, len - 0.2, h2 - 0.1, 0.05, '#ffffff'); L.box(0, h1 + h2 / 2 + 0.12, z - nz * 0.6, len - 1.2, h2 - 0.6, 0.02, '#ffffff'); }
  for (const x of [-len / 2 + 0.25, len / 2 - 0.25]) { G.box(x, h1 + h2 / 2 + 0.12, depth / 2, 0.05, h2 - 0.1, depth - 0.2, '#ffffff'); }
  P.box(0, h1 + 1.1, 0.18, len, 0.08, 0.1, '#2f3338'); // transom
  // flat roof: a deep fascia (red band under a dark cap), snow on top
  S.box(0, top + 0.45, depth / 2, len + 1.6, 0.5, depth + 1.6, '#55595f');
  P.box(0, top + 0.32, -0.81, len + 1.62, 0.36, 0.06, '#a5141c');
  P.box(0, top + 0.32, depth + 0.81, len + 1.62, 0.36, 0.06, '#a5141c');
  for (const sx of [-1, 1]) P.box(sx * (len / 2 + 0.81), top + 0.32, depth / 2, 0.06, 0.36, depth + 1.62, '#a5141c');
  S.box(0, top + 0.82, depth / 2, len + 1.3, 0.26, depth + 1.3, '#f2f5f9');
  // weather station on the roof: a small cabin, a lattice mast with an anemometer and a dish
  S.box(len / 2 - 4, top + 2.1, depth - 3.6, 4.2, 2.4, 3.6, '#d9d6cf', '#f2f5f9');
  G.box(len / 2 - 4, top + 2.3, depth - 5.43, 3.2, 1.0, 0.04, '#ffffff');
  const mx = len / 2 - 1.6, mz = depth - 1.6, mh = 9;
  for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]) P.bar([mx + dx, top + 1, mz + dz], [mx + dx * 0.4, top + 1 + mh, mz + dz * 0.4], 0.035, '#c9cdd2', 4);
  for (let k = 1; k < 6; k++) { const y = top + 1 + (k * mh) / 6, f = 1 - 0.6 * (k / 6); P.box(mx, y, mz, 0.6 * f + 0.06, 0.04, 0.6 * f + 0.06, '#c9cdd2'); }
  P.bar([mx - 0.9, top + mh + 0.6, mz], [mx + 0.9, top + mh + 0.6, mz], 0.03, '#2f3338', 4);
  for (const sx of [-1, 1]) P.cylY(mx + sx * 0.9, top + mh + 0.5, mz, 0.12, 0.16, 8, '#e6e8ea');
  P.cylY(mx, top + mh + 0.2, mz, 0.04, 1.4, 6, '#2f3338');
  }
  // the viewing terrace in front: timber deck, steel railing, telescopes and benches
  const dz0 = -8.5;
  for (let x = -len / 2; x < len / 2 - 1e-6; x += 0.6) {
    const tone = 0.85 + rnd() * 0.2;
    W.box(x + 0.3, 0.22, dz0 / 2, 0.56, 0.12, -dz0, '#' + new THREE.Color(0.47 * tone, 0.32 * tone, 0.2 * tone).getHexString());
  }
  W.box(0, -1.6, dz0 / 2, len, 3.5, -dz0 - 0.2, '#5d4029'); // the deck's apron (down into the snow)
  const rail = (a, b) => {
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let i = 0; i <= n; i++) { const x = a[0] + (b[0] - a[0]) * i / n, z = a[1] + (b[1] - a[1]) * i / n; P.box(x, 0.85, z, 0.07, 1.1, 0.07, '#2f3338'); }
    for (const y of [1.38, 0.86]) P.bar([a[0], y, a[1]], [b[0], y, b[1]], y > 1 ? 0.035 : 0.018, '#2f3338', 5);
  };
  rail([-len / 2, dz0], [len / 2, dz0]);
  rail([-len / 2, dz0], [-len / 2, -0.3]);
  rail([len / 2, dz0], [len / 2, -0.3]);
  for (const x of [-6.5, 7.5]) {
    const z = dz0 + 0.9;
    P.cylY(x, 0.28, z, 0.09, 0.08, 12, '#3c4148'); // foot
    P.cylY(x, 0.36, z, 0.05, 0.9, 10, '#3c4148'); // column
    P.box(x, 1.28, z, 0.36, 0.05, 0.08, '#3c4148'); // yoke
    for (const sx of [-1, 1]) P.box(x + sx * 0.17, 1.38, z, 0.04, 0.22, 0.08, '#3c4148');
    // the two barrels, angled down toward the valley, a hood over the eyepieces
    for (const sx of [-1, 1]) {
      P.bar([x + sx * 0.075, 1.44, z + 0.2], [x + sx * 0.075, 1.4, z - 0.28], 0.075, '#2f6f52', 10);
      P.bar([x + sx * 0.075, 1.4, z - 0.28], [x + sx * 0.075, 1.395, z - 0.31], 0.06, '#15181b', 10); // lens
      P.bar([x + sx * 0.075, 1.445, z + 0.2], [x + sx * 0.075, 1.45, z + 0.27], 0.035, '#15181b', 8); // eyepiece
    }
    P.box(x, 1.42, z - 0.02, 0.08, 0.1, 0.36, '#2f6f52'); // bridge
  }
  for (const x of [-3.2, 3.6]) {
    for (const k of [-0.7, 0.7]) P.box(x + k, 0.5, dz0 + 2.1, 0.06, 0.46, 0.5, '#2f3338');
    for (let i = 0; i < 3; i++) W.box(x, 0.74, dz0 + 1.95 + i * 0.16, 1.8, 0.05, 0.13, '#8a5a35');
  }
  const grp = new THREE.Group();
  const add = (bd, mat, cast = true) => { const geo = bd.build(); if (!geo) return; const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; grp.add(m); };
  add(S, M.stone); add(W, M.wood); add(P, steel); add(G, M.glass, false); add(L, M.warm, false);
  grp.userData.size = { len, depth, height: top + 1, deck: -dz0 };
  return grp;
}

// (Oct 31 2026, the user: the halt cabins, rail_station_halt, at the Legacy Express stations ("Sunny Meadow") and the
// Wolkenspitzbahn stops show "a strange green, map-like texture with white blobs" on the roof, "it should be a snowy
// roof, like the other huts". The cause is the model's own texture, not the LOD copies: its one atlas paints the roof
// green moss with white snow patches (the emissive map lights those patches too), already at full detail; the
// decimated copies keep that look but fold the roof's top and its underside together, so wood shows through too.
// So the roof's triangles get their own mesh with a plain snow material, on every LOD level, the rest of the model
// keeping all its maps. The roof at full detail: faces looking up (normal y > 0.3) in the top third of the model
// (above the eaves); the decimated copies cannot be judged by their normals (vertex clustering tilts them), so a
// triangle there is roof when two of its vertices carry the uv of a full-detail roof (or roof underside) vertex
// (clusterDecimate copies one source vertex's uv exactly). The snow colour is the station houses' roof snow
// (buildStationHouse, '#f3f6fa'), pulled a little forward (polygonOffset) over the folded-in underside.)
const ROOF_T = 0.66, ROOF_NY = 0.3;
let ROOF_SNOW = null;
const roofKeyCache = new WeakMap(), roofSplitCache = new WeakMap();
function roofSnowMaterial() {
  if (!ROOF_SNOW) {
    ROOF_SNOW = new THREE.MeshStandardMaterial({ color: '#f3f6fa', roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    ROOF_SNOW.userData.shared = true; // (one for every station: never disposed with a chunk / course)
  }
  return ROOF_SNOW;
}
const uvKey = (uv, i) => Math.fround(uv.getX(i)) + ',' + Math.fround(uv.getY(i));
// one triangle's height in the model (0 bottom .. 1 top) and its face normal's y
function triFacts(pos, a, b, c, y0, dy) {
  const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
  const ux = pos.getX(b) - ax, uy = pos.getY(b) - ay, uz = pos.getZ(b) - az;
  const vx = pos.getX(c) - ax, vy = pos.getY(c) - ay, vz = pos.getZ(c) - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
  return { t: ((ay + pos.getY(b) + pos.getY(c)) / 3 - y0) / dy, ny: l > 1e-12 ? ny / l : 0 };
}
// split a geometry into { body, roof }: two index subsets sharing its attributes (cached: the model's and the LOD
// copies' geometries are shared by every station); keys = null for the full-detail geometry (it collects them)
function splitRoof(geo, keys) {
  if (roofSplitCache.has(geo)) return roofSplitCache.get(geo);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  let out = null;
  if (pos && uv) {
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const dy = Math.max(1e-9, y1 - y0);
    const idx = geo.index, count = idx ? idx.count : pos.count;
    const body = [], roof = [];
    const hiKeys = keys ? null : new Set();
    for (let k = 0; k + 2 < count; k += 3) {
      const a = idx ? idx.getX(k) : k, b = idx ? idx.getX(k + 1) : k + 1, c = idx ? idx.getX(k + 2) : k + 2;
      const f = triFacts(pos, a, b, c, y0, dy);
      let isRoof;
      if (!keys) {
        isRoof = f.t > ROOF_T && f.ny > ROOF_NY;
        if (f.t > ROOF_T && (isRoof || f.ny < -ROOF_NY)) for (const i of [a, b, c]) hiKeys.add(uvKey(uv, i)); // (top and underside)
      } else isRoof = f.t > ROOF_T - 0.06 && (keys.has(uvKey(uv, a)) + keys.has(uvKey(uv, b)) + keys.has(uvKey(uv, c))) >= 2;
      (isRoof ? roof : body).push(a, b, c);
    }
    if (hiKeys) roofKeyCache.set(geo, hiKeys);
    if (roof.length) {
      const sub = (list) => {
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
        g.setIndex(new THREE.BufferAttribute(pos.count > 65535 ? new Uint32Array(list) : new Uint16Array(list), 1));
        g.boundingBox = geo.boundingBox?.clone() ?? null; g.boundingSphere = geo.boundingSphere?.clone() ?? null;
        if (!g.boundingSphere) g.computeBoundingSphere();
        g.userData.shared = true; // (cached for every station: never disposed with an express chunk)
        return g;
      };
      out = { body: sub(body), roof: sub(roof) };
    }
  }
  roofSplitCache.set(geo, out);
  return out;
}
/** Give a makeLOD'd rail_station_halt a snowy roof on every LOD level (see above). Call it right after makeLOD. */
export function snowRoof(lod) {
  if (!lod || lod.userData.snowRoof) return lod;
  lod.userData.snowRoof = true; // (once per building)
  const levels = lod?.levels?.length ? lod.levels.map((l) => l.object) : [lod];
  const meshesOf = (o) => { const list = []; o.traverse((m) => { if (m.isMesh && !m.userData.snowRoof && !Array.isArray(m.material)) list.push(m); }); return list; };
  const hiGeos = meshesOf(levels[0]).map((m) => m.geometry); // (the model's own, before level 0 is split)
  for (const g of hiGeos) splitRoof(g, null); // (collects the roof's uv keys first)
  levels.forEach((obj, li) => {
    meshesOf(obj).forEach((m, k) => {
      const keys = li === 0 ? null : roofKeyCache.get(hiGeos[k]);
      if (li > 0 && !keys) return;
      const split = li === 0 ? roofSplitCache.get(m.geometry) : splitRoof(m.geometry, keys);
      if (!split) return;
      m.geometry = split.body;
      const r = new THREE.Mesh(split.roof, roofSnowMaterial());
      r.userData.snowRoof = true;
      r.castShadow = m.castShadow; r.receiveShadow = m.receiveShadow;
      m.add(r); // (a child: the mesh's own transform)
    });
  });
  return lod;
}

// platform canopy: steel columns, a glazed lean-to roof, lamps under it
function buildCanopy(steelMat, glassMat, len, width) {
  const S = new B(), G = new B();
  for (let x = -len / 2; x <= len / 2 + 0.01; x += 6) {
    S.box(x, 1.6, width - 0.3, 0.18, 3.2, 0.18, '#3d4249');
    S.bar([x, 3.2, width - 0.3], [x, 3.55, 0.2], 0.07, '#3d4249');
  }
  S.box(0, 3.25, width - 0.3, len + 0.3, 0.16, 0.2, '#3d4249');
  S.box(0, 3.6, 0.15, len + 0.3, 0.16, 0.2, '#3d4249');
  G.box(0, 3.45, width / 2, len, 0.04, width, '#ffffff');
  // snow lying on the glass along its low edge
  S.box(0, 3.5, width - 0.6, len, 0.14, 0.8, '#eef3f9');
  const grp = new THREE.Group();
  const s = new THREE.Mesh(S.build(), steelMat); s.castShadow = true; s.receiveShadow = true;
  const g = new THREE.Mesh(G.build(), glassMat);
  grp.add(s, g);
  return grp;
}

// bench + lamp post
function platformProps(paint, wood, lampMat) {
  const P = new B(), Wd = new B(), L = new B();
  // bench (seat on two steel frames)
  for (const x of [-0.7, 0.7]) P.box(x, 0.23, 0, 0.06, 0.46, 0.5, '#2f3338');
  for (let i = 0; i < 3; i++) Wd.box(0, 0.47, -0.16 + i * 0.16, 1.8, 0.05, 0.13, '#8a5a35');
  for (let i = 0; i < 2; i++) Wd.box(0, 0.68 + i * 0.16, 0.24, 1.8, 0.12, 0.04, '#8a5a35');
  const bench = new THREE.Group();
  bench.add(new THREE.Mesh(P.build(), paint), new THREE.Mesh(Wd.build(), wood));
  // lamp post with a warm lantern
  const LP = new B();
  LP.cylY(0, 0, 0, 0.07, 4.2, 8, '#2f3338');
  LP.box(0, 4.25, 0, 0.36, 0.08, 0.36, '#2f3338');
  L.box(0, 4.05, 0, 0.26, 0.32, 0.26, '#ffffff');
  const lamp = new THREE.Group();
  lamp.add(new THREE.Mesh(LP.build(), paint), new THREE.Mesh(L.build(), lampMat));
  for (const g of [bench, lamp]) g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { bench, lamp };
}

// ------------------------------------------------------------------ the Meshy platform lanterns (lamp_post)
// The model baked 4.2 m tall and split at 80 % of its height: the post keeps its material, the lantern on top gets a
// copy that glows after dusk (setNight). Instanced: one post + one lantern mesh per station.
let LAMP = null;
function lampParts(models) {
  if (LAMP !== null) return LAMP;
  LAMP = false;
  if (!models?.lamp_post) return LAMP;
  const b = bakeGeometry(models.lamp_post, { size: 4.2, axis: 'y', decimate: 0.012 });
  if (!b?.geometry) return LAMP;
  const g = b.geometry.index ? b.geometry.toNonIndexed() : b.geometry;
  g.computeBoundingBox();
  const cut = g.boundingBox.min.y + (g.boundingBox.max.y - g.boundingBox.min.y) * 0.8;
  const pos = g.attributes.position, top = [], low = [];
  for (let t = 0; t < pos.count; t += 3) ((pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3 > cut ? top : low).push(t);
  const part = (list) => {
    const out = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) {
      const isz = attr.itemSize, arr = new Float32Array(list.length * 3 * isz);
      let o = 0;
      for (const t of list) for (let v = 0; v < 3; v++) for (let k = 0; k < isz; k++) arr[o++] = attr.getComponent(t + v, k);
      out.setAttribute(name, new THREE.BufferAttribute(arr, isz, name === 'position' || name === 'normal' ? false : attr.normalized));
    }
    out.computeBoundingSphere();
    return out;
  };
  const glow = b.material.clone();
  glow.emissive = new THREE.Color(0xffd7a0); glow.emissiveMap = glow.map || null; glow.emissiveIntensity = 0.1;
  LAMP = { post: part(low), lantern: part(top), mat: b.material, glow };
  return LAMP;
}

// ------------------------------------------------------------------ all stations
export function buildStations(scene, colliders = [], models = null) {
  const M = railMaterials();
  const group = new THREE.Group();
  group.name = 'rail-stations';
  const steel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x332a22, emissive: 0xffd9a0, emissiveIntensity: 0.6, roughness: 0.5 });
  const signs = [];
  const list = [];
  const pools = []; // lamp light pools on the platforms (x, y, z, radius)
  const lampPools = []; // (Oct 31 2026: [breakable lamp, its pool's index]: the pool folded away while it is down)
  const plat = new B(), platHall = new B();
  for (const st of RAIL.stations) {
    const side = st.side;
    const len = st.s1 - st.s0;
    const mid = (st.s0 + st.s1) / 2;
    const rec = { id: st.id, name: st.name, s: mid, alt: Math.round(ALT0 + railAt(mid, _f).y), side };
    buildPlatform(st.underground ? platHall : plat, st.s0 + 4, st.s1 - 4, side, st.underground ? 5.55 : 4.2); // (underground: to the rock hall's wall)
    const P = besideLine(mid, side * 3.6);
    rec.board = { x: P.x, z: P.z };
    // the building beside the platform (its front faces the track)
    const toTrack = Math.atan2(-(-_f.dz * side), -(_f.dx * side)); void toTrack;
    const meshyKey = st.id === 'tal' ? 'rail_station_valley' : st.halt ? 'rail_station_halt' : null;
    if (meshyKey && MESHY_STATIONS && models?.[meshyKey]) {
      // the Meshy building: its front (+z) to the track, its front line 1.2 m behind the platform's back edge, on a
      // stone plinth that reaches into the ground
      const big = st.id === 'tal';
      const bld = makeLOD(models[meshyKey], { size: big ? 22 : 8.6, axis: 'x' }, 260, 0.05);
      if (meshyKey === 'rail_station_halt') snowRoof(bld); // (Oct 31 2026, the user: a snowy roof, not the model's green one)
      bld.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; crisp(o.material); } });
      const sz = bld.userData.size;
      const bp = besideLine(mid, side * (1.75 + 4.2 + 1.2));
      const az = new THREE.Vector3(-bp.dz * side, 0, bp.dx * side), ax = new THREE.Vector3(bp.dx * side, 0, bp.dz * side);
      const m = new THREE.Matrix4().makeBasis(ax, new THREE.Vector3(0, 1, 0), az);
      const holder = new THREE.Group();
      holder.position.set(bp.x, bp.y + 0.04, bp.z);
      holder.quaternion.setFromRotationMatrix(m);
      bld.position.set(0, 0, sz.z / 2);
      bld.rotation.y = Math.PI; // the model's front (+z) faces the track (-z here)
      holder.add(bld);
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(sz.x * 0.96, 5, sz.z * 0.96), new THREE.MeshStandardMaterial({ color: 0x6e6a63, roughness: 0.9 }));
      plinth.position.set(0, -2.5, sz.z / 2);
      holder.add(plinth);
      group.add(holder);
      const c = new THREE.Vector3(0, 0, sz.z / 2).applyMatrix4(m).add(holder.position);
      colliders.push({ x: c.x, z: c.z, hw: (sz.x / 2) * 0.88, hd: (sz.z / 2) * 0.88, rot: -Math.atan2(az.x, az.z) });
      rec.house = { x: c.x, z: c.z, r: Math.max(sz.x, sz.z) / 2 + 2 };
      if (big) {
        const can = buildCanopy(steel, M.glass, 30, 4.4);
        can.position.copy(holder.position).addScaledVector(az, -4.4);
        can.quaternion.copy(holder.quaternion);
        group.add(can);
        for (let x = -15; x <= 15.01; x += 6) colliders.push({ x: can.position.x + ax.x * x + az.x * 4.1, z: can.position.z + ax.z * x + az.z * 4.1, r: 0.15 }); // its steel columns
      }
      const ex = besideLine(mid + 4, side * 4.3);
      rec.exit = { x: ex.x, z: ex.z, heading: Math.atan2(az.x, az.z) };
    } else if (st.id === 'tal' || st.halt) {
      const big = st.id === 'tal';
      const house = buildStationHouse(M.stone, M.wood, M.glass, M.warm, big ? { len: 24, depth: 11, floors: 2 } : { len: 11, depth: 7, floors: 1, clock: false });
      const bp = besideLine(mid, side * (1.75 + 4.2 + 1.2));
      // local z away from the track, local x along it (right-handed: x = z x up)
      const az = new THREE.Vector3(-bp.dz * side, 0, bp.dx * side);
      const ax = new THREE.Vector3(bp.dx * side, 0, bp.dz * side);
      const m = new THREE.Matrix4().makeBasis(ax, new THREE.Vector3(0, 1, 0), az);
      house.position.set(bp.x, bp.y + 0.06, bp.z);
      house.quaternion.setFromRotationMatrix(m);
      group.add(house);
      const sz = house.userData.size;
      const c = new THREE.Vector3(0, 0, sz.depth / 2).applyMatrix4(m).add(house.position);
      colliders.push({ x: c.x, z: c.z, hw: sz.len / 2, hd: sz.depth / 2, rot: -Math.atan2(az.x, az.z) });
      rec.house = { x: c.x, z: c.z, r: Math.max(sz.len, sz.depth) / 2 + 2 };
      if (big) {
        const can = buildCanopy(steel, M.glass, 30, 4.4);
        can.position.copy(house.position).addScaledVector(az, -4.4);
        can.quaternion.copy(house.quaternion);
        group.add(can);
        // its steel columns (buildCanopy(): every 6 m along it, 0.3 m in front of the building)
        for (let x = -15; x <= 15.01; x += 6) colliders.push({ x: can.position.x + ax.x * x + az.x * 4.1, z: can.position.z + ax.z * x + az.z * 4.1, r: 0.15 });
      }
      // name board on the building's front, over the door
      const nb = nameBoard(st.name, rec.alt, big ? 6.4 : 4.2);
      nb.position.copy(house.position).addScaledVector(az, -0.12).add(new THREE.Vector3(0, big ? 4.5 : 3.2, 0));
      nb.quaternion.copy(house.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      group.add(nb); signs.push(nb.userData.face);
      // exit (arrival): on the platform by the door, facing the village / the lake
      const ex = besideLine(mid + 4, side * 4.3);
      rec.exit = { x: ex.x, z: ex.z, heading: Math.atan2(az.x, az.z) };
    }
    {
      // timetable board, benches and lamps along the platform
      const tt = timetableBoard(st.name, st.id);
      const tp = besideLine(mid - 8, side * 4.6);
      tt.position.set(tp.x, tp.y + 0.06, tp.z);
      tt.rotation.y = Math.atan2(_f.dz * side, -_f.dx * side) ;
      tt.lookAt(besideLine(mid - 8, 0).x, tp.y + 0.06, besideLine(mid - 8, 0).z);
      group.add(tt);
      colliders.push({ x: tp.x, z: tp.z, r: 0.5 });
      const { bench, lamp } = platformProps(M.paint, M.wood, lampMat);
      const LP = MESHY_STATIONS ? lampParts(models) : false, lampAt = [], lampBrk = []; let lampIms = [];
      for (let s = st.s0 + 16; s < st.s1 - 10; s += 24) {
        const bp = besideLine(s, side * 4.8);
        const b = bench.clone(); b.position.set(bp.x, bp.y + 0.06, bp.z); b.lookAt(besideLine(s, 0).x, bp.y + 0.06, besideLine(s, 0).z); group.add(b);
        seatsFromObject(b, [-0.55, 0, 0.55].map((x) => ({ x, y: 0.5, z: 0, yaw: Math.PI, floor: 0, back: -0.22, front: 0.225 }))); // (its backrest on +z: you face -z)
        colliders.push({ x: bp.x, z: bp.z, r: 0.6, top: bp.y + 0.55 }); // (low: jumped over)
        const lp = besideLine(s + 12, side * 5.3);
        let l = null;
        if (LP) lampAt.push([lp.x, lp.y + 0.06, lp.z, Math.atan2(-(-lp.dz * side), -(lp.dx * side))]);
        else { l = lamp.clone(); l.position.set(lp.x, lp.y + 0.06, lp.z); group.add(l); }
        const lc = { x: lp.x, z: lp.z, r: 0.25 };
        colliders.push(lc); lampBrk.push([lc, l, pools.length]); // (its pool: the next one pushed)
        const pp = besideLine(s + 12, side * 4.0);
        pools.push([pp.x, pp.y + 0.09, pp.z, 4.2]);
      }
      if (LP && lampAt.length) {
        const post = new THREE.InstancedMesh(LP.post, LP.mat, lampAt.length), lan = new THREE.InstancedMesh(LP.lantern, LP.glow, lampAt.length);
        const o = new THREE.Object3D();
        lampAt.forEach(([x, y, z, yaw], i) => { o.position.set(x, y, z); o.rotation.set(0, yaw, 0); o.updateMatrix(); post.setMatrixAt(i, o.matrix); lan.setMatrixAt(i, o.matrix); });
        for (const im of [post, lan]) { im.instanceMatrix.needsUpdate = true; im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); group.add(im); }
        lampIms = [post, lan];
      }
      // (Oct 31 2026, the user: "make sure you break these lamps after 100 kph, and they respawn after 90 sec"; the
      // station lamps too (open point after 6bf82f9): each platform lamp (its Meshy post + lantern instances, or the
      // procedural one) a breakable street lamp: world/breakables.js; its light pool folded away while it is down)
      lampBrk.forEach(([lc, l, pi], i) => { const e = breakables.add(lc, l ? [l] : lampIms.map((im) => [im, i]), { h: 4.3, loud: 0.7, lamp: true }); if (e) lampPools.push([e, pi]); });
      // name boards on posts at both ends of the platform
      for (const s of [st.s0 + 10, st.s1 - 10]) {
        // (Oct 31 2026: free-standing on its posts, nameSign; facing the track, its posts on the platform; the
        // posts' own colliders instead of one 0.6 m disc under the board's middle, where nothing stood)
        const p = besideLine(s, side * 5.6), c = besideLine(s, 0);
        const nb = nameBoard(st.name, rec.alt, 3.0);
        const o = { x: p.x, y: Math.max(p.y, world.groundHeight(p.x, p.z, p.y + 3)), z: p.z }; // (the platform, or the snow over it)
        group.add(nameSign(nb, 3.0, o, Math.atan2(c.x - p.x, c.z - p.z), colliders, { bottom: 2.2 })); signs.push(nb.userData.face);
      }
    }
    if (st.id === 'platt') {
      // the top station is under the glacier: you come out of its building on the plateau above it, onto the
      // viewing terrace (the building's front faces down the glacier toward the village)
      const above = besideLine(mid, 0);
      const gy = world.height(above.x, above.z);
      const fl = Math.hypot(above.x, above.z) || 1, fx = -above.x / fl, fz = -above.z / fl; // toward the village
      const meshyTop = MESHY_STATIONS && models?.rail_station_glacier;
      const house = buildGlacierStation(M, steel, { terraceOnly: !!meshyTop });
      const sz = house.userData.size;
      // local z (back) = -front; x = z x up: the right-handed basis of the valley station
      const az = new THREE.Vector3(-fx, 0, -fz), ax = new THREE.Vector3(-fz, 0, fx);
      const m = new THREE.Matrix4().makeBasis(ax, new THREE.Vector3(0, 1, 0), az);
      const ox = above.x + fx * 2.5, oz = above.z + fz * 2.5; // the building + terrace centred on the pad
      house.position.set(ox, gy - 0.12, oz);
      house.quaternion.setFromRotationMatrix(m);
      group.add(house);
      // the terrace's two benches (no backrest), looking out to the front (-z), the deck at y 0.28
      seatsFromObject(house, [-3.2, 3.6].flatMap((x) => [-0.55, 0, 0.55].map((k) => ({ x: x + k, y: 0.77, z: -8.5 + 2.1, yaw: Math.PI, floor: 0.28 }))));
      if (meshyTop) {
        // the Meshy summit station behind the terrace (its front, +z, toward the village)
        const bld = makeLOD(models.rail_station_glacier, { size: 14, axis: 'y' }, 300, 0.05);
        bld.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; crisp(o.material); } });
        const bs = bld.userData.size;
        bld.position.set(0, 0, bs.z / 2 + 0.2);
        bld.rotation.y = Math.PI;
        const plinth = new THREE.Mesh(new THREE.BoxGeometry(bs.x * 0.96, 5, bs.z * 0.96), new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.9 }));
        plinth.position.set(0, -2.45, bs.z / 2 + 0.2);
        house.add(bld, plinth);
        sz.len = Math.max(sz.len, bs.x); sz.depth = bs.z + 0.2;
      }
      const c = new THREE.Vector3(0, 0, sz.depth / 2).applyMatrix4(m).add(house.position);
      colliders.push({ x: c.x, z: c.z, hw: sz.len / 2, hd: sz.depth / 2, rot: -Math.atan2(az.x, az.z) });
      const nb = nameBoard(st.name, rec.alt, meshyTop ? 4.4 : 6.0);
      if (meshyTop) {
        // on two posts at the terrace's front edge, facing the village
        // (Oct 31 2026: free-standing on its posts, nameSign, each post on the ground)
        const o = new THREE.Vector3().copy(house.position).addScaledVector(az, -8.9);
        o.y = Math.max(house.position.y, world.groundHeight(o.x, o.z, house.position.y + 3));
        group.add(nameSign(nb, 4.4, o, Math.atan2(-az.x, -az.z), colliders, { bottom: 2.3 }));
      } else {
        nb.position.copy(house.position).addScaledVector(az, -0.9).add(new THREE.Vector3(0, 8.0, 0));
        nb.quaternion.copy(house.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
        group.add(nb);
      }
      signs.push(nb.userData.face);
      const door = new THREE.Vector3(0, 0, -2.6).applyMatrix4(m).add(house.position);
      rec.house = { x: c.x, z: c.z, r: Math.max(sz.len, sz.depth) / 2 + 2 };
      rec.board = { x: door.x, z: door.z };
      const ex = new THREE.Vector3(3.2, 0, -4.2).applyMatrix4(m).add(house.position);
      rec.exit = { x: ex.x, z: ex.z, heading: Math.atan2(fx, fz), surface: true };
      rec.surface = { x: above.x, y: gy, z: above.z };
    }
    list.push(rec);
  }
  // the lamps' light on the platform after dusk: soft warm pools (additive, faded in by setNight)
  const poolTex = canvasTex(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,214,160,1)'); gr.addColorStop(0.45, 'rgba(255,200,140,0.45)'); gr.addColorStop(1, 'rgba(255,190,130,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  if (pools.length && poolTex) {
    const pos = [], uv = [], idx = [];
    for (const [x, y, z, r] of pools) {
      const b = pos.length / 3;
      pos.push(x - r, y, z - r, x + r, y, z - r, x + r, y, z + r, x - r, y, z + r);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const pm = new THREE.Mesh(g, poolMat);
    pm.renderOrder = 2;
    pm.visible = false;
    group.add(pm);
    poolMat.userData.mesh = pm;
    // (Oct 31 2026, the user: "make sure you break these lamps after 100 kph": a knocked platform lamp's pool (its quad)
    // collapsed onto its first corner while it is down (breakables sets light.out), back with it)
    const pa = g.getAttribute('position'), P0 = pa.array.slice();
    for (const [e, i] of lampPools) e.light = { set out(v) { for (let j = i * 12; j < i * 12 + 12; j++) pa.array[j] = v ? P0[i * 12 + (j % 3)] : P0[j]; pa.needsUpdate = true; } };
  }
  const platM = new THREE.Mesh(plat.build(), M.stone);
  platM.receiveShadow = true;
  group.add(platM);
  // the rock hall's platform: lit by the hall's lamps (the sky barely reaches in there)
  const hallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, emissive: 0x5e5850, envMapIntensity: 0.05 });
  const hallGeo = platHall.build();
  if (hallGeo) group.add(new THREE.Mesh(hallGeo, hallMat));
  scene?.add(group);
  return {
    group, list,
    update() {},
    setNight(n) {
      for (const m of signs) m.emissiveIntensity = n * 0.3;
      M.warm.emissiveIntensity = 0.06 + n * 0.9;
      hallMat.emissiveIntensity = 1;
      lampMat.emissiveIntensity = 0.12 + n * 2.6; // the platform lanterns
      if (LAMP) LAMP.glow.emissiveIntensity = 0.05 + n * 1.6;
      poolMat.opacity = n * 0.5;
      if (poolMat.userData.mesh) poolMat.userData.mesh.visible = n > 0.02;
    },
  };
}
