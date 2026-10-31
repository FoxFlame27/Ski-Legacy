// The Legacy Express's stations (expresstrack.js builds them lazily, as entities of the line). Every stop (Legacy
// Village and the race stations) is the same at-grade station, built like the Wolkenspitzbahn's (railstations.js):
//   - two side platforms (240 m, either side of the double track: the station's side faces the course's start /
//     the village), styled like the Wolkenspitzbahn's (stone coping, white safety line, paving)
//   - the Wolkenspitzbahn's own station building (its Meshy models: rail_station_valley at the village,
//     rail_station_halt at the races) behind the station-side platform, its front to the track, on the snow,
//     with the valley station's glazed platform canopy in front of it
//   - the red name boards (the station's name, "LEGACY EXPRESS") on posts along both platforms and one on the
//     station square behind the building (facing the start), benches, lamps, walkable platforms, colliders
// (No module-level calls into expresstrack.js: the two modules import each other.)
import * as THREE from 'three';
import { world } from './world.js';
import { layout } from './layout.js';
import { PLATFORM, EXPRESS_NAME } from './expressroute.js';
import { XB, lin } from './expresstrack.js';
import { RailBuilder, canvasTex } from './railtrack.js';
import { bakeGeometry, makeLOD } from '../core/assets.js';
import { crisp } from './train.js';
import { propProfile, registerBench } from '../game/seating.js';
import { breakables } from './breakables.js'; // (the platform lamps: snapped off by a car over 100 km/h, Oct 31 2026)

export const PLAT_Y = 0.25;                   // platform top over the top of rail (the squares lie at -0.12)
const EDGE = 3.9, BACK = 8.7;                 // platform edge / back, m from the centre line
const HOUSE_LAT = 10.3;                       // the building's front line, m from the centre line (behind the masts)
const CAN_LEN = 36, CAN_W = 4.4;              // the glazed canopy in front of the building
const FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const RED = '#a5141c', WHITE = '#f4f2ed';

// the station building's model: the Wolkenspitzbahn's valley station at the village, its halt at the races (either
// one if the other is missing); size: its width along the track
function houseModel(st, models) {
  const want = st.course ? ['rail_station_halt', 'rail_station_valley'] : ['rail_station_valley', 'rail_station_halt'];
  for (const key of want) if (models?.[key]?.scene) return { key, gltf: models[key], size: key === 'rail_station_valley' ? 22 : 8.6 };
  return null;
}
// the model's size once fitted (fitModel: width `size` along x), without building it
function houseSize(h) {
  const m = h.gltf.scene;
  m.updateMatrixWorld(true);
  const d = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
  const k = h.size / (d.x || 1);
  return { x: d.x * k, y: d.y * k, z: d.z * k };
}

// a station's frame: u along the line (+s), lat to the right; y over the top of rail
function stFrame(st) {
  const dx = Math.sin(st.heading), dz = Math.cos(st.heading);
  const rx = -dz, rz = dx;
  const P = (u, lat, y = 0) => [st.x + dx * u + rx * lat, st.y + y, st.z + dz * u + rz * lat];
  return { dx, dz, rx, rz, P };
}

// ------------------------------------------------------------------ boards (the Wolkenspitzbahn's red name board)
const TEX = new Map();
function tex(key, w, h, draw) { if (!TEX.has(key)) TEX.set(key, canvasTex(w, h, draw)); return TEX.get(key); }
function nameTex(name) {
  return tex(`xn-${name}`, 1024, 256, (g, w, h) => {
    g.fillStyle = RED; g.fillRect(0, 0, w, h);
    g.strokeStyle = WHITE; g.lineWidth = 12; g.strokeRect(14, 14, w - 28, h - 28);
    g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 112;
    g.font = `italic 700 ${size}px ${FONT}`;
    while (g.measureText(name.toUpperCase()).width > w - 90 && size > 56) { size -= 4; g.font = `italic 700 ${size}px ${FONT}`; }
    g.fillText(name.toUpperCase(), w / 2, h * 0.42);
    g.font = `600 50px ${FONT}`; g.fillText(EXPRESS_NAME.toUpperCase(), w / 2, h * 0.8);
  });
}
const FRAME_MAT = { m: null }, FOOT_MAT = { m: null };
export const SIGN = { post: 0.12, depth: 0.07, inset: 0.35 }; // post section = the frame's rim (0.06 a side) x2
// A free-standing station name sign (Oct 31 2026, the user, with a screenshot: "fix these kind of stuff, look, the
// board doesn't look good, please fix all of these area boards": the posts stood IN FRONT of the board (at its
// centre plane, 0.1 m thick, poking 5 mm through both printed faces), reached only to its middle, floated over /
// sank into the ground, had no feet, and the board was printed on both sides with no back). Now: a solid panel
// wM wide (4:1) with a little thickness, printed on its front (+z) only, a dark back face and its rim; two posts
// BEHIND it (their front faces flush with the panel's back), under its ends inset SIGN.inset, as thick as the
// rim, from the ground at each post (gy(sx): the ground's height there over the group's origin, so they never
// float or sink) up to the board's top edge, each on a small concrete footing. bottom: the board's bottom edge
// over the origin (2.2-2.5 m). The group's origin is on the ground under the board's centre.
export function signMesh(t, wM, mats, { bottom = 2.3, gy = () => 0, color = 0xa5141c } = {}) {
  const mat = new THREE.MeshStandardMaterial({ map: t, color: t ? 0xffffff : color, roughness: 0.5, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0 });
  mats?.push(mat);
  const hM = wM / 4, g = new THREE.Group(), cy = bottom + hM / 2, D = SIGN.depth, P = SIGN.post;
  const fm = FRAME_MAT.m ??= new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.3 });
  const ft = FOOT_MAT.m ??= new THREE.MeshStandardMaterial({ color: 0x9a968f, roughness: 0.9 });
  // the panel: a dark box (its back face and its rim, 0.06 m round the print) and the print just proud of its front
  const back = new THREE.Mesh(new THREE.BoxGeometry(wM + 0.12, hM + 0.12, D), fm);
  back.position.y = cy; back.castShadow = true; back.receiveShadow = true;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), mat);
  face.position.set(0, cy, D / 2 + 0.004);
  g.add(back, face);
  // the posts behind it, ground -> the board's top edge, on concrete footings (sunk 0.1 m: no gap on a slope)
  const top = cy + hM / 2 + 0.06, pz = -(D / 2 + P / 2);
  for (const sx of [-1, 1]) {
    const x = sx * (wM / 2 - SIGN.inset), y0 = gy(sx), h = top - y0;
    if (h <= 0.2) continue;
    const p = new THREE.Mesh(new THREE.BoxGeometry(P, h, P), fm);
    p.position.set(x, y0 + h / 2, pz); p.castShadow = true;
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.34), ft);
    f.position.set(x, y0 + 0.0, pz); f.receiveShadow = true;
    g.add(p, f);
  }
  g.userData.face = mat;
  return g;
}
// the express board: the station's name over "LEGACY EXPRESS", on its posts (signMesh); yaw turns its front to face
function boardMesh(name, wM, mats, opts) { return signMesh(nameTex(name), wM, mats, opts); }
// where a sign's posts stand (world x, z), its origin p and its yaw (local x = (cos yaw, -sin yaw), the posts on -z)
export function signPosts(p, yaw, wM) {
  const cx = Math.cos(yaw), cz = -Math.sin(yaw), bx = -Math.sin(yaw), bz = -Math.cos(yaw), b = SIGN.depth / 2 + SIGN.post / 2;
  return [-1, 1].map((sx) => { const x = sx * (wM / 2 - SIGN.inset); return { sx, x: p[0] + cx * x + bx * b, z: p[2] + cz * x + bz * b }; });
}
// the yaw that turns a sign's front to the station frame's lateral direction s (+1 right of +s, -1 left)
const faceLat = (heading, s) => heading + (s > 0 ? -Math.PI / 2 : Math.PI / 2);
function placeAt(o, p, yaw) { o.position.set(p[0], p[1], p[2]); o.rotation.y = yaw; return o; }

// ------------------------------------------------------------------ props (instanced)
let PROPS = null;
function props(models) {
  if (PROPS) return PROPS;
  PROPS = {};
  try {
    if (models?.wooden_bench) { const b = bakeGeometry(models.wooden_bench, { size: 1.9, axis: 'x', decimate: 0.01 }); if (b.geometry) { b.geometry.userData.shared = true; PROPS.bench = b; } }
  } catch (e) { console.warn('express bench', e); }
  return PROPS;
}
function instanced(geo, mat, list, { cast = true } = {}) {
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const o = new THREE.Object3D();
  list.forEach(([x, y, z, yaw], i) => { o.position.set(x, y, z); o.rotation.set(0, yaw, 0); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = cast; im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}

// ------------------------------------------------------------------ layout
// Everything that needs a collider is laid out here once (planExpressStations), the meshes follow it.
function stationLayout(st, models) {
  const L = { benches: [], lamps: [], boards: [], house: null, square: null };
  for (const sd of [-1, 1]) {
    const own = sd === st.side;
    for (const u of own ? [-60, -46, 46, 60] : [-36, -12, 12, 36]) L.benches.push({ u, lat: sd * 7.9, sd });
    for (const u of [-112, -88, -64, -40, 40, 64, 88, 112]) L.lamps.push({ u, lat: sd * 7.9, sd });
    for (const u of own ? [-100, -30, 30, 100] : [-100, -50, 0, 50, 100]) L.boards.push({ u, lat: sd * 7.7, sd });
  }
  const h = houseModel(st, models);
  if (h) { L.house = { ...h, sz: houseSize(h) }; }
  // the board on the square behind the building, facing away from the track (toward the start / the village)
  const depth = L.house ? L.house.sz.z : 0;
  // (Oct 31 2026, the user: "the board doesn't look good": it stood against the building's back wall; now 4.5 m
  // clear of the model's whole footprint, eaves included)
  L.square = { u: 0, lat: st.side * (HOUSE_LAT + depth + 4.5) };
  return L;
}

/**
 * The stations as records (layout.express.stations plus the frame, the layout, the build radius); registers the
 * colliders and the walkable platforms.
 */
export function planExpressStations({ colliders = [], cameraBlockers = [], models = null } = {}) {
  const recs = [];
  for (const st of layout.express?.stations || []) {
    const F = stFrame(st);
    const rec = { ...st, F, r: PLATFORM / 2 + 20, cameraBlockers };
    rec.lay = stationLayout(st, models);
    const at = (u, lat) => { const p = F.P(u, lat); return { x: p[0], z: p[2] }; };
    for (const b of rec.lay.benches) colliders.push({ ...at(b.u, b.lat), hw: 0.4, hd: 0.95, rot: -st.heading, top: st.y + PLAT_Y + 0.5 });
    const BP = propProfile('wooden_bench', 1.9); // (as baked: 1.9 m long)
    if (models?.wooden_bench) for (const b of rec.lay.benches) { // (the benches facing the track: sit and wait)
      const p = F.P(b.u, b.lat, PLAT_Y);
      registerBench({ x: p[0], y: p[1] + BP.h, z: p[2], yaw: st.heading + (b.sd > 0 ? -Math.PI / 2 : Math.PI / 2), width: 1.9, off: BP.off, floorY: p[1], back: BP.back, front: BP.front, recline: BP.recline });
    }
    for (const l of rec.lay.lamps) colliders.push((l.c = { ...at(l.u, l.lat), r: 0.2 })); // (l.c: its breakable, buildStation)
    // the name boards' posts (signMesh: exactly where they are drawn; Oct 31 2026, the user: "fix all of these area
    // boards"; small colliders, none where nothing stands)
    for (const b of rec.lay.boards) for (const q of signPosts(F.P(b.u, b.lat), faceLat(st.heading, -b.sd), 3.0)) colliders.push({ x: q.x, z: q.z, r: 0.12 });
    for (const q of signPosts(F.P(rec.lay.square.u, rec.lay.square.lat), faceLat(st.heading, st.side), 5.2)) colliders.push({ x: q.x, z: q.z, r: 0.12 });
    // the glazed canopy's steel columns (canopy(): every 6 m along its length, 0.3 m in front of the building)
    for (let u = -CAN_LEN / 2; u <= CAN_LEN / 2 + 0.01; u += 6) colliders.push({ ...at(u, st.side * (HOUSE_LAT - 0.3)), r: 0.16 });
    const H = rec.lay.house;
    if (H) colliders.push({ ...at(0, st.side * (HOUSE_LAT + H.sz.z / 2)), hw: (H.sz.z / 2) * 0.9, hd: (H.sz.x / 2) * 0.9, rot: -st.heading }); // (hd: along the track)
    // both platforms are walkable (their tops stand 0.37 m over the squares: you step up onto them)
    for (const sd of [-1, 1]) {
      const cs = [F.P(-PLATFORM / 2, sd * EDGE), F.P(PLATFORM / 2, sd * EDGE), F.P(-PLATFORM / 2, sd * BACK), F.P(PLATFORM / 2, sd * BACK)];
      const bounds = { minx: Math.min(...cs.map((p) => p[0])), maxx: Math.max(...cs.map((p) => p[0])), minz: Math.min(...cs.map((p) => p[2])), maxz: Math.max(...cs.map((p) => p[2])) };
      const top = st.y + PLAT_Y;
      world.addSurface({
        bounds,
        height(x, z) {
          const u = (x - st.x) * F.dx + (z - st.z) * F.dz, l = ((x - st.x) * F.rx + (z - st.z) * F.rz) * sd;
          return Math.abs(u) <= PLATFORM / 2 && l >= EDGE && l <= BACK + 0.05 ? top : null;
        },
      });
    }
    recs.push(rec);
  }
  return recs;
}

// ------------------------------------------------------------------ meshes
const COL = () => ({
  face: lin('#9b9892'), coping: lin('#d8d5ce'), line: lin('#f2f2f0'), pave: lin('#c7c4bd'), wall: lin('#8f8c86'), wallDark: lin('#7a7771'),
  steel: lin('#3d4249'), steelDark: lin('#2f3338'), lamp: lin('#ffffff'),
});
// a platform slab from u0 to u1 on side sd: the coping, the white safety line, the paving (the Wolkenspitzbahn's),
// the front wall down into the track bed, the back wall into the ground (straight and level: four corners suffice)
function platform(b, F, sd, u0, u1, { back = BACK, y = PLAT_Y } = {}) {
  const K = COL();
  const strips = [[EDGE, EDGE + 0.12, K.face], [EDGE + 0.12, EDGE + 0.62, K.coping], [EDGE + 0.62, EDGE + 0.72, K.line], [EDGE + 0.72, back, K.pave]];
  const up = F.P(u0, 0, 50);
  for (const [l0, l1, c] of strips) b.face(F.P(u0, sd * l0, y), F.P(u1, sd * l0, y), F.P(u1, sd * l1, y), F.P(u0, sd * l1, y), [up[0], -1e4, up[2]], c, 3);
  const mid = F.P((u0 + u1) / 2, sd * (EDGE + back) / 2, y - 1);
  b.face(F.P(u0, sd * EDGE, y), F.P(u1, sd * EDGE, y), F.P(u1, sd * EDGE, -0.8), F.P(u0, sd * EDGE, -0.8), mid, K.face, 3);
  b.face(F.P(u0, sd * back, y), F.P(u1, sd * back, y), F.P(u1, sd * back, -1.4), F.P(u0, sd * back, -1.4), mid, K.wall, 3);
  for (const u of [u0, u1]) b.face(F.P(u, sd * EDGE, y), F.P(u, sd * back, y), F.P(u, sd * back, -1.4), F.P(u, sd * EDGE, -0.8), mid, K.wallDark, 3);
}
// a lamp: a slim pole and a flat LED head leaning out over the platform's edge (Oct 31 2026, the user: "make sure you
// break these lamps after 100 kph, and they respawn after 90 sec": one lamp in its own frame (x toward the track side
// it stands on, the head leaning out 0.45 m along -x), instanced per lamp in buildStation so each can be knocked off)
let LAMPG = null;
function lampGeo() {
  if (LAMPG) return LAMPG;
  const K = COL(), X = [1, 0, 0], Z = [0, 0, 1], steel = new XB(), led = new XB();
  steel.obx([0, 2.4, 0], X, Z, 0.06, 2.4, 0.06, K.steel);
  steel.obx([-0.45, 4.75, 0], X, Z, 0.5, 0.06, 0.2, K.steelDark);
  led.obx([-0.45, 4.68, 0], X, Z, 0.42, 0.012, 0.14, K.lamp);
  LAMPG = { steel: steel.build(), led: led.build() };
  for (const g of [LAMPG.steel, LAMPG.led]) if (g) g.userData.shared = true; // (never disposed with a station)
  return LAMPG;
}
// the Wolkenspitzbahn valley station's platform canopy (railstations.js buildCanopy): steel columns, a glazed
// lean-to roof, snow along its low edge. Local frame: x along the track, z away from it, front edge at z = 0.
function canopy(steelMat, glassMat, len, width) {
  const S = new RailBuilder(), G = new RailBuilder();
  for (let x = -len / 2; x <= len / 2 + 0.01; x += 6) {
    S.box(x, 1.6, width - 0.3, 0.18, 3.2, 0.18, '#3d4249');
    S.bar([x, 3.2, width - 0.3], [x, 3.55, 0.2], 0.07, '#3d4249');
  }
  S.box(0, 3.25, width - 0.3, len + 0.3, 0.16, 0.2, '#3d4249');
  S.box(0, 3.6, 0.15, len + 0.3, 0.16, 0.2, '#3d4249');
  G.box(0, 3.45, width / 2, len, 0.04, width, '#ffffff');
  S.box(0, 3.5, width - 0.6, len, 0.14, 0.8, '#eef3f9');
  const grp = new THREE.Group();
  const s = new THREE.Mesh(S.build(), steelMat); s.castShadow = true; s.receiveShadow = true;
  const g = new THREE.Mesh(G.build(), glassMat);
  grp.add(s, g);
  return grp;
}

function buildStation(rec, M, models) {
  const { F } = rec, side = rec.side;
  const grp = new THREE.Group();
  const conc = new XB({ uv: true });
  for (const sd of [-1, 1]) platform(conc, F, sd, -PLATFORM / 2, PLATFORM / 2);
  const add = (b, mat, cast = true) => { const g = b.build(); if (!g) return null; const m = new THREE.Mesh(g, mat); m.castShadow = cast; m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); return m; };
  add(conc, M.concrete, false);
  // (Oct 31 2026, the user: "make sure you break these lamps after 100 kph, and they respawn after 90 sec"; the station
  // lamps too, open point after 6bf82f9): the platform lamps instanced (yaw: lampGeo's x along the side's own right),
  // each a breakable street lamp on its planned collider (l.c); the station is built again in range: the same
  // breakable re-pointed at the new instances (breakables.rebind; one still down stays hidden): world/breakables.js
  const LG = lampGeo();
  if (LG.steel && LG.led) {
    const list = rec.lay.lamps.map((l) => { const p = F.P(l.u, l.lat, PLAT_Y); return [p[0], p[1], p[2], Math.atan2(-l.sd * F.dx, -l.sd * F.dz)]; });
    const post = instanced(LG.steel, M.mast, list), head = instanced(LG.led, M.lampX, list, { cast: false });
    if (post && head) {
      grp.add(post, head);
      rec.lay.lamps.forEach((l, k) => {
        if (!l.c) return;
        const parts = [[post, k], [head, k]];
        if (l.c.breakable) breakables.rebind(l.c.breakable, parts); else breakables.add(l.c, parts, { h: 4.8, loud: 0.7, lamp: true });
      });
    }
  }
  // the building and the canopy in front of it: local x along the track, z away from it (a right-handed basis)
  const az = new THREE.Vector3(F.rx * side, 0, F.rz * side), ax = new THREE.Vector3(F.dx * side, 0, F.dz * side);
  const basis = new THREE.Matrix4().makeBasis(ax, new THREE.Vector3(0, 1, 0), az);
  const H = rec.lay.house;
  if (H) {
    try {
      const bld = makeLOD(H.gltf, { size: H.size, axis: 'x' }, 260, 0.05);
      bld.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; crisp(o.material); } });
      bld.levels[0].object.traverse((o) => { if (o.isMesh) o.geometry.userData.shared = true; }); // (the model's own geometry: never disposed)
      const sz = bld.userData.size;
      const holder = new THREE.Group();
      const hp = F.P(0, side * HOUSE_LAT, -0.1);
      holder.position.set(hp[0], hp[1], hp[2]);
      holder.quaternion.setFromRotationMatrix(basis);
      bld.position.set(0, 0, sz.z / 2);
      bld.rotation.y = Math.PI; // the model's front (+z) faces the track (-z here)
      holder.add(bld);
      // (no plinth: it stands on the snow of the station square, flattened to platform level in expressground.js;
      // Oct 27, the user: "a weird platform under them, they should be on snow")
      bld.position.y = -0.18;
      grp.add(holder);
      rec.cameraBlockers?.push(bld);
    } catch (e) { console.warn('Legacy Express station building', e); }
  }
  {
    const can = canopy(M.mast, M.glass, CAN_LEN, CAN_W);
    const cp = F.P(0, side * (HOUSE_LAT - CAN_W), PLAT_Y);
    can.position.set(cp[0], cp[1], cp[2]);
    can.quaternion.setFromRotationMatrix(basis);
    grp.add(can);
  }
  // the name boards along both platforms (facing the track) and on the square behind the building
  const mats = [];
  // (Oct 31 2026: free-standing signs, signMesh; the platform ones face the track, their posts on the platform's
  // paving; the square's faces away from the track, toward the start / the village, its posts each on the snow)
  for (const b of rec.lay.boards) grp.add(placeAt(boardMesh(rec.name, 3.0, mats, { bottom: 2.2 }), F.P(b.u, b.lat, PLAT_Y), faceLat(rec.heading, -b.sd)));
  const sq = rec.lay.square, sp = F.P(sq.u, sq.lat, -0.12), syaw = faceLat(rec.heading, side);
  sp[1] = world.groundHeight(sp[0], sp[2], rec.y + 3);
  const sg = {};
  for (const q of signPosts(sp, syaw, 5.2)) sg[q.sx] = world.groundHeight(q.x, q.z, rec.y + 3) - sp[1];
  grp.add(placeAt(boardMesh(rec.name, 5.2, mats, { bottom: 2.4, gy: (sx) => sg[sx] ?? 0 }), sp, syaw));
  // benches facing the track
  const P = props(models);
  if (P.bench) {
    const list = rec.lay.benches.map((b) => { const p = F.P(b.u, b.lat, PLAT_Y); return [p[0], p[1], p[2], rec.heading + (b.sd > 0 ? -Math.PI / 2 : Math.PI / 2)]; });
    const im = instanced(P.bench.geometry, P.bench.material, list);
    if (im) grp.add(im);
  }
  grp.userData.signs = mats;
  grp.userData.dispose = mats;
  return grp;
}

export function buildExpressStation(rec, M, models) { return buildStation(rec, M, models); }
