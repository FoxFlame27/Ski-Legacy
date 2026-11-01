// The Wolkenspitzbahn's stations: platforms along the track, the station buildings (procedural: stationbuildings.js;
// the valley station in Legacy Village: stone ground floor, timber upper floor, a deep snowy roof and the platform
// canopy; a timber halt at Wolkensee by the frozen lake; the top station's granite, concrete and glass terminal on
// the glacier, its platform in a rock hall under the ice; Adlerwald, a request halt below the Adlerhorn, has a
// timber halt like Wolkensee's), name
// boards, timetable boards, benches and lamps. Each station also says where you
// board (board) and where you step out on arrival (exit).
import * as THREE from 'three';
import { world } from './world.js';
import { RAIL, railAt, PROFILE, CYCLE, DWELL_MID, haltArrival } from './railroute.js';
import { RailBuilder as B, railMaterials, canvasTex } from './railtrack.js';
import { mulberry32 } from '../core/noise.js';
import { bakeGeometry } from '../core/assets.js';
import { stationBuilding, stationCanopy, registerStation } from './stationbuildings.js';
import { seatsFromObject } from '../game/seating.js';
import { breakables } from './breakables.js'; // (the platform lamps: snapped off by a car over 100 km/h, Oct 31 2026)

// the station buildings and the canopy are procedural (stationbuildings.js; Nov 1 2026, the user: the Meshy station
// models were "blurry and weird from the outside"); the platform lanterns are the Meshy lamp_post (off: procedural)
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

// ------------------------------------------------------------------ the top station's terrace on the glacier
// The train arrives in the rock hall under the ice; the station building stands on the glacier above it
// (stationbuildings.js 'glacier', behind this), and in front of it a timber viewing terrace with a railing,
// telescopes and benches, looking down the glacier and the Wolkental to Legacy Village. Local frame: x along the
// front, z back, the building's front at z = 0.
function buildGlacierTerrace(M, steel) {
  const W = new B(), P = new B();
  const rnd = mulberry32(9931);
  const len = 24;
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
  add(W, M.wood); add(P, steel);
  grp.userData.size = { len, deck: -dz0 };
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

// the departures board in the valley station's hall / the screens in the top station's (off the timetable, railroute.js)
function departuresFor(id) {
  const trip = Math.round(PROFILE.trip / 60), every = Math.round(CYCLE / 2 / 60), halts = RAIL.stations.filter((st) => st.halt);
  const min = (t) => `${Math.max(1, Math.round(t / 60))} min`;
  const up = id !== 'platt';
  const rows = [[up ? 'Wolkenplatt · Gletscher' : 'Legacy Village', `via ${halts.map((st) => st.name).join(' · ')}`, `${trip} min`]];
  for (const st of halts.slice(0, 2)) { const tA = haltArrival(st.id); if (tA !== null) rows.push([st.name, 'halt', min(up ? tA : PROFILE.trip - tA - DWELL_MID)]); }
  rows.push(['Next train', 'Wolkenspitzbahn', `every ${every} min`]);
  return { title: 'ABFAHRT · DEPARTURES', rows };
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
    // the building beside the platform (stationbuildings.js: the valley station, a halt): its front to the track, its
    // front line 1.2 m behind the platform's back edge, on a stone plinth that reaches 5 m into the ground
    if (st.id === 'tal' || st.halt) {
      const big = st.id === 'tal';
      const bld = stationBuilding(big ? 'valley' : 'halt', { plinth: 5, apron: -1.2, departures: big ? departuresFor(st.id) : null });
      const bp = besideLine(mid, side * (1.75 + 4.2 + 1.2));
      // local z away from the track, local x along it (right-handed: x = z x up)
      const az = new THREE.Vector3(-bp.dz * side, 0, bp.dx * side), ax = new THREE.Vector3(bp.dx * side, 0, bp.dz * side);
      const m = new THREE.Matrix4().makeBasis(ax, new THREE.Vector3(0, 1, 0), az);
      bld.position.set(bp.x, bp.y + 0.04, bp.z);
      bld.quaternion.setFromRotationMatrix(m);
      group.add(bld);
      const sz = bld.userData.size, rot = -Math.atan2(az.x, az.z);
      void rot;
      // walk in (Nov 1 2026, the user: "make it so you can go inside"): its walls, counter and benches solid, its floor
      // and the paving in front of its doors walkable (stationbuildings.js registerStation)
      registerStation(bld.userData.plan, bld.position, az, colliders);
      const c = new THREE.Vector3(0, 0, sz.z / 2).applyMatrix4(m).add(bld.position);
      rec.house = { x: c.x, z: c.z, r: Math.max(sz.x, sz.z) / 2 + 2 };
      // the name board on the building's front
      const ba = bld.userData.board, nb = nameBoard(st.name, rec.alt, ba.w);
      nb.position.set(ba.x, ba.y, ba.z - 0.05); nb.rotation.y = Math.PI; // (its print, +z, to the track)
      bld.add(nb); signs.push(nb.userData.face);
      if (big) {
        const can = stationCanopy(30, 4.4);
        can.position.copy(bld.position).addScaledVector(az, -4.4);
        can.quaternion.copy(bld.quaternion);
        group.add(can);
        // its steel columns (stationCanopy(): every 6 m along it, 0.3 m in front of its back edge)
        for (let x = -15; x <= 15.01; x += 6) colliders.push({ x: can.position.x + ax.x * x + az.x * 4.1, z: can.position.z + ax.z * x + az.z * 4.1, r: 0.15 });
      }
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
      const house = buildGlacierTerrace(M, steel);
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
      // the glacier terminal behind the terrace (stationbuildings.js; its front toward the village), its walls solid
      const bld = stationBuilding('glacier', { plinth: 3.5, departures: departuresFor(st.id) });
      bld.position.set(0, 0, 0.2);
      house.add(bld);
      const ba = bld.userData.board, tb = nameBoard(st.name, rec.alt, ba.w);
      tb.position.set(ba.x, ba.y, ba.z - 0.05); tb.rotation.y = Math.PI; // (on the tower, over the roof)
      bld.add(tb); signs.push(tb.userData.face);
      const rot = -Math.atan2(az.x, az.z);
      void rot;
      registerStation(bld.userData.plan, house.position, az, colliders, { zOff: 0.2 }); // (walk in, as the valley station)
      const bs = bld.userData.size;
      sz.depth = bs.z + 0.2;
      const c = new THREE.Vector3(0, 0, sz.depth / 2).applyMatrix4(m).add(house.position);
      // the name board on two posts at the terrace's front edge, facing the village
      // (Oct 31 2026: free-standing on its posts, nameSign, each post on the ground)
      const nb = nameBoard(st.name, rec.alt, 4.4);
      const o = new THREE.Vector3().copy(house.position).addScaledVector(az, -8.9);
      o.y = Math.max(house.position.y, world.groundHeight(o.x, o.z, house.position.y + 3));
      group.add(nameSign(nb, 4.4, o, Math.atan2(-az.x, -az.z), colliders, { bottom: 2.3 }));
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
