// The Legacy Express's stations (expresstrack.js builds them lazily, as entities of the line):
//   - the eight course stops: two side platforms (240 m, either side of the double track: you board on the station's
//     side, which faces the course's finish), a steel and glass canopy over the middle 90 m of each, windscreens,
//     benches, lamps, the name boards (the course's name, "Legacy Express"), walkable platform surfaces, colliders
//   - Legacy Village: the entrance pavilion beside the ski shop (stairs down into a lit doorway; the terrain is
//     clipped open over the stairwell) and the underground hall under the village (a vaulted hall with both
//     platforms, seen from the train)
// (No module-level calls into expresstrack.js: the two modules import each other.)
import * as THREE from 'three';
import { world } from './world.js';
import { layout } from './layout.js';
import { PLATFORM, VILLAGE_ENTRANCE, EXPRESS_NAME } from './expressroute.js';
import { XB, lin, expressFrame, tubeProfile } from './expresstrack.js';
import { canvasTex } from './railtrack.js';
import { bakeGeometry } from '../core/assets.js';

export const HALL_HALF = PLATFORM / 2 + 12;   // the village hall's half length along the line (its end walls)
export const PLAT_Y = 0.25;                   // platform top over the top of rail (the squares lie at -0.12)
const EDGE = 3.9, BACK = 8.7;                 // platform edge / back, m from the centre line
const HALL_W = 10.2, HALL_SPR = 4.6, HALL_CR = 11.2; // the hall's walls, springline, crown
const CAN = 45;                               // the canopies' half length
const FLOOR_Y = -0.62;
const FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

// a station's frame: u along the line (+s), lat to the right; y over the top of rail
function stFrame(st) {
  const dx = Math.sin(st.heading), dz = Math.cos(st.heading);
  const rx = -dz, rz = dx;
  const P = (u, lat, y = 0) => [st.x + dx * u + rx * lat, st.y + y, st.z + dz * u + rz * lat];
  return { dx, dz, rx, rz, P };
}

// ------------------------------------------------------------------ boards
const TEX = new Map();
function tex(key, w, h, draw) { if (!TEX.has(key)) TEX.set(key, canvasTex(w, h, draw)); return TEX.get(key); }
// the station name board: dark slate, the name in white, a red bar with LEGACY EXPRESS
function nameTex(name) {
  return tex(`xn-${name}`, 2048, 320, (g, w, h) => {
    g.fillStyle = '#1e232a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#b0121a'; g.fillRect(0, 0, w, 62);
    g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.font = `700 44px ${FONT}`; g.fillText(`${EXPRESS_NAME.toUpperCase()}  ·  HIGH-SPEED LINE TO EVERY RACE`, 36, 33);
    g.textAlign = 'center';
    let size = 170;
    g.font = `italic 700 ${size}px ${FONT}`;
    while (g.measureText(name.toUpperCase()).width > w - 120 && size > 80) { size -= 6; g.font = `italic 700 ${size}px ${FONT}`; }
    g.fillText(name.toUpperCase(), w / 2, 62 + (h - 62) / 2 + 6);
  });
}
function boardMesh(name, wM, hM, mats) {
  const t = nameTex(name);
  const mat = new THREE.MeshStandardMaterial({ map: t, color: t ? 0xffffff : 0x1e232a, roughness: 0.45, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0 });
  mats.push(mat);
  const g = new THREE.Group();
  for (const sd of [1, -1]) { // printed both sides
    const face = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), mat);
    face.position.z = sd * 0.045; face.rotation.y = sd > 0 ? 0 : Math.PI;
    g.add(face);
  }
  const back = new THREE.Mesh(new THREE.BoxGeometry(wM + 0.1, hM + 0.1, 0.08), FRAME_MAT.m ??= new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.5, metalness: 0.5 }));
  g.add(back);
  return g;
}
const FRAME_MAT = { m: null };
function placeAt(o, p, yaw) { o.position.set(p[0], p[1], p[2]); o.rotation.y = yaw; return o; }

// ------------------------------------------------------------------ props (instanced)
let PROPS = null;
function props(models) {
  if (PROPS) return PROPS;
  PROPS = {};
  try {
    if (models?.wooden_bench) { const b = bakeGeometry(models.wooden_bench, { size: 1.9, axis: 'x', decimate: 0.01 }); if (b.geometry) PROPS.bench = b; }
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

// ------------------------------------------------------------------ the course stops: layout
// Everything that needs a collider is laid out here once (planExpressStations), the meshes follow it.
function courseLayout(st) {
  const L = { columns: [], benches: [], lamps: [], boards: [], posts: [] };
  for (const sd of [-1, 1]) {
    for (let u = -CAN; u <= CAN + 1e-6; u += 9) L.columns.push({ u, lat: sd * 7.4, sd });
    for (const u of [-36, -22, 22, 36]) L.benches.push({ u, lat: sd * 7.9, sd });
    for (const u of [-112, -92, -72, -55, 55, 72, 92, 112]) L.lamps.push({ u, lat: sd * 7.9, sd });
    for (const u of [-102, 102]) L.posts.push({ u, lat: sd * 7.6, sd });
    for (const u of [-CAN + 4, CAN - 4]) L.boards.push({ u, lat: sd * 6.0, sd, hang: true });
  }
  void st;
  return L;
}

/**
 * The stations as records (layout.express.stations plus the frame, the layout, the build radius); registers the
 * colliders, the walkable platforms and (the village) the stairwell's terrain clip volume.
 */
export function planExpressStations({ colliders = [], cameraBlockers = [], clips = [] } = {}) {
  const recs = [];
  for (const st of layout.express?.stations || []) {
    const F = stFrame(st);
    const rec = { ...st, F, r: st.underground ? HALL_HALF + 20 : PLATFORM / 2 + 20, cameraBlockers };
    if (!st.underground) {
      rec.lay = courseLayout(st);
      const at = (u, lat) => { const p = F.P(u, lat); return { x: p[0], z: p[2] }; };
      for (const c of rec.lay.columns) colliders.push({ ...at(c.u, c.lat), r: 0.3 });
      for (const b of rec.lay.benches) colliders.push({ ...at(b.u, b.lat), hw: 0.95, hd: 0.4, rot: -st.heading, top: st.y + PLAT_Y + 0.5 });
      for (const l of rec.lay.lamps) colliders.push({ ...at(l.u, l.lat), r: 0.2 });
      for (const p of rec.lay.posts) for (const du of [-1.5, 1.5]) colliders.push({ ...at(p.u + du, p.lat), r: 0.15 });
      // the windscreens behind the canopies
      for (const sd of [-1, 1]) colliders.push({ ...at(0, sd * 8.55), hw: 0.15, hd: 30, rot: -st.heading });
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
    } else {
      // the village entrance: its frame (z out of the stairs, x to the right of that), the stairwell's footprint
      const E = VILLAGE_ENTRANCE, oz = [Math.sin(E.heading), Math.cos(E.heading)], ox = [-oz[1], oz[0]];
      const gy = world.height(E.x, E.z);
      rec.ent = { x: E.x, z: E.z, y: gy, ox, oz, heading: E.heading };
      const L = (x, z) => ({ x: E.x + ox[0] * x + oz[0] * z, z: E.z + ox[1] * x + oz[1] * z });
      colliders.push({ ...L(0, -7.6), hw: 2.4, hd: 6.8, rot: -E.heading }); // (the stairwell: E itself stays free)
      for (const [x, z] of [[-3.6, 1.2], [3.6, 1.2], [-3.6, -14.2], [3.6, -14.2]]) colliders.push({ ...L(x, z), r: 0.25 });
      // the terrain is clipped open over the stairwell (a box: from the top step to the doorway's wall)
      clips.push({ x: E.x, y: gy, z: E.z, grade: 0, tx: -oz[0], tz: -oz[1], a0: 0.85, a1: 13.6, hw: 2.15, v0: -7, vS: 1.5, v1: 1.5 });
    }
    recs.push(rec);
  }
  return recs;
}

// ------------------------------------------------------------------ the course stops: meshes
const COL = () => ({
  edge: lin('#d2cfc8'), strip: lin('#c4c1ba'), line: lin('#f6f6f4'), pave: lin('#aeaba4'), wall: lin('#8c8982'), wallDark: lin('#7a7771'),
  steel: lin('#59616b'), steelDark: lin('#3b4148'), roof: lin('#e3e5e8'), roofUnder: lin('#c9ccd0'), fascia: lin('#2c3138'), red: lin('#a5141c'),
  lamp: lin('#ffffff'), glassFrame: lin('#3b4148'), snow: lin('#f1f5fa'),
});
// a platform slab from u0 to u1 on side sd: the edge coping, the safety strip and its white line, the paving, the
// front wall down into the track bed, the back wall into the ground (straight and level: four corners suffice)
function platform(b, F, sd, u0, u1, { back = BACK, y = PLAT_Y } = {}) {
  const K = COL();
  const strips = [[EDGE, EDGE + 0.4, K.edge], [EDGE + 0.4, EDGE + 1.0, K.strip], [EDGE + 1.0, EDGE + 1.1, K.line], [EDGE + 1.1, back, K.pave]];
  const up = F.P(u0, 0, 50);
  for (const [l0, l1, c] of strips) b.face(F.P(u0, sd * l0, y), F.P(u1, sd * l0, y), F.P(u1, sd * l1, y), F.P(u0, sd * l1, y), [up[0], -1e4, up[2]], c, 3);
  const mid = F.P((u0 + u1) / 2, sd * (EDGE + back) / 2, y - 1);
  b.face(F.P(u0, sd * EDGE, y), F.P(u1, sd * EDGE, y), F.P(u1, sd * EDGE, -0.8), F.P(u0, sd * EDGE, -0.8), mid, K.wall, 3);
  b.face(F.P(u0, sd * back, y), F.P(u1, sd * back, y), F.P(u1, sd * back, -1.4), F.P(u0, sd * back, -1.4), mid, K.wall, 3);
  for (const u of [u0, u1]) b.face(F.P(u, sd * EDGE, y), F.P(u, sd * back, y), F.P(u, sd * back, -1.4), F.P(u, sd * EDGE, -0.8), mid, K.wallDark, 3);
}
// the canopy over one platform: columns on the platform's middle, a roof falling gently toward the back, the dark
// fascia along the track with an LED line under it, glass windscreens at the back
function canopy(steel, glass, lamps, F, sd) {
  const K = COL();
  const yF = PLAT_Y + 4.0, yB = PLAT_Y + 3.6, l0 = 4.35, l1 = 9.0;
  const X = [F.rx * sd, 0, F.rz * sd], Z = [F.dx, 0, F.dz];
  for (let u = -CAN; u <= CAN + 1e-6; u += 9) {
    const c = F.P(u, sd * 7.4, 0);
    steel.obx([c[0], c[1] + PLAT_Y + 1.8, c[2]], X, Z, 0.14, 1.8, 0.14, K.steel);
    // a Y-head: two arms up to the roof's front and back beams
    steel.rod(F.P(u, sd * 7.4, PLAT_Y + 3.4), F.P(u, sd * 5.0, yF - 0.35), 0.09, K.steel, 6);
    steel.rod(F.P(u, sd * 7.4, PLAT_Y + 3.4), F.P(u, sd * 8.7, yB - 0.3), 0.09, K.steel, 6);
  }
  // the roof slab (top, underside, edges), its beams
  const ins = F.P(0, sd * 6.5, -50);
  const corner = (u, l) => F.P(u, sd * l, yF + ((yB - yF) * (l - l0)) / (l1 - l0));
  steel.face(corner(-CAN - 2, l0), corner(CAN + 2, l0), corner(CAN + 2, l1), corner(-CAN - 2, l1), ins, K.roof, 4);
  const lo = (p) => [p[0], p[1] - 0.22, p[2]];
  const above = F.P(0, sd * 6.5, 50);
  steel.face(lo(corner(-CAN - 2, l0)), lo(corner(CAN + 2, l0)), lo(corner(CAN + 2, l1)), lo(corner(-CAN - 2, l1)), above, K.roofUnder, 4);
  // fascia along the front, a thinner one at the back, the ends
  const fa = (l, h, c) => { const a = corner(-CAN - 2, l), b2 = corner(CAN + 2, l); steel.face([a[0], a[1] + 0.12, a[2]], [b2[0], b2[1] + 0.12, b2[2]], [b2[0], b2[1] - h, b2[2]], [a[0], a[1] - h, a[2]], [ins[0], a[1], ins[2]], c, 4); };
  fa(l0, 0.62, K.fascia); fa(l1, 0.35, K.fascia);
  for (const u of [-CAN - 2, CAN + 2]) steel.face(corner(u, l0), corner(u, l1), lo(corner(u, l1)), lo(corner(u, l0)), F.P(0, sd * 6.5, yF), K.fascia, 4);
  // snow on the roof (a thin layer, short of the edges)
  const sn = (u, l) => { const p = corner(u, l); return [p[0], p[1] + 0.06, p[2]]; };
  steel.face(sn(-CAN - 1.6, l0 + 0.3), sn(CAN + 1.6, l0 + 0.3), sn(CAN + 1.6, l1 - 0.2), sn(-CAN - 1.6, l1 - 0.2), ins, K.snow, 4);
  // LED line under the front fascia
  const a = corner(-CAN, l0 + 0.5), b2 = corner(CAN, l0 + 0.5);
  lamps.obx([(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2 - 0.3, (a[2] + b2[2]) / 2], X, Z, 0.06, 0.03, CAN, K.lamp);
  // windscreens: glass panes in slim frames along the back (u -30..30)
  for (let u = -30; u < 30 - 1e-6; u += 3) {
    glass.face(F.P(u + 0.05, sd * 8.55, PLAT_Y + 0.15), F.P(u + 2.95, sd * 8.55, PLAT_Y + 0.15), F.P(u + 2.95, sd * 8.55, PLAT_Y + 2.6), F.P(u + 0.05, sd * 8.55, PLAT_Y + 2.6), F.P(u, 0, 1), lin('#ffffff'), 4);
    steel.obx(F.P(u, sd * 8.55, PLAT_Y + 1.35), X, Z, 0.05, 1.3, 0.05, K.glassFrame);
  }
  steel.obx(F.P(30, sd * 8.55, PLAT_Y + 1.35), X, Z, 0.05, 1.3, 0.05, K.glassFrame);
  steel.obx(F.P(0, sd * 8.55, PLAT_Y + 2.63), X, Z, 0.05, 0.04, 30, K.glassFrame);
}
// a modern lamp: a slim pole and a flat LED head leaning out over the platform's edge
function lamp(steel, lamps, F, l) {
  const K = COL();
  const X = [F.rx * l.sd, 0, F.rz * l.sd], Z = [F.dx, 0, F.dz];
  const c = F.P(l.u, l.lat, PLAT_Y);
  steel.obx([c[0], c[1] + 2.6, c[2]], X, Z, 0.06, 2.6, 0.06, K.steel);
  const h = F.P(l.u, l.lat - l.sd * 0.55, PLAT_Y + 5.15);
  steel.obx(h, X, Z, 0.6, 0.06, 0.2, K.steelDark);
  lamps.obx([h[0], h[1] - 0.07, h[2]], X, Z, 0.5, 0.012, 0.14, K.lamp);
}
function buildCourseStation(rec, M, models) {
  const { F } = rec;
  const grp = new THREE.Group();
  const conc = new XB({ uv: true }), steel = new XB(), glass = new XB(), lamps = new XB();
  for (const sd of [-1, 1]) {
    platform(conc, F, sd, -PLATFORM / 2, PLATFORM / 2);
    canopy(steel, glass, lamps, F, sd);
  }
  for (const l of rec.lay.lamps) lamp(steel, lamps, F, l);
  // name boards on two posts at both ends of each platform
  const mats = [];
  const K = COL();
  for (const p of rec.lay.posts) {
    const X = [F.rx * p.sd, 0, F.rz * p.sd], Z = [F.dx, 0, F.dz];
    for (const du of [-1.5, 1.5]) { const c = F.P(p.u + du, p.lat, PLAT_Y); steel.obx([c[0], c[1] + 1.6, c[2]], X, Z, 0.06, 1.6, 0.06, K.steel); }
    const bd = boardMesh(rec.name, 4.2, 0.66, mats);
    placeAt(bd, F.P(p.u, p.lat, PLAT_Y + 2.75), rec.heading + Math.PI / 2);
    grp.add(bd);
  }
  // boards hanging under the canopies (at both ends), the long one on each canopy's fascia
  for (const b of rec.lay.boards) {
    const bd = boardMesh(rec.name, 3.6, 0.56, mats);
    placeAt(bd, F.P(b.u, b.lat, PLAT_Y + 3.15), rec.heading);
    bd.rotation.y = rec.heading + Math.PI / 2;
    grp.add(bd);
    for (const du of [-1.2, 1.2]) steel.rod(F.P(b.u + du, b.lat, PLAT_Y + 3.44), F.P(b.u + du, b.lat, PLAT_Y + 3.8), 0.015, K.steelDark, 4);
  }
  for (const sd of [-1, 1]) {
    const bd = boardMesh(rec.name, 9.0, 1.4, mats);
    placeAt(bd, F.P(0, sd * 4.2, PLAT_Y + 4.65), rec.heading + Math.PI / 2);
    grp.add(bd);
  }
  const add = (b, mat, cast = true) => { const g = b.build(); if (!g) return null; const m = new THREE.Mesh(g, mat); m.castShadow = cast; m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); return m; };
  add(conc, M.concrete, false);
  add(steel, M.mast);
  add(glass, M.glass, false);
  add(lamps, M.lampX, false);
  // benches under the canopies, facing the track
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

// ------------------------------------------------------------------ Legacy Village: the entrance pavilion
function buildEntrance(rec, M) {
  const E = rec.ent;
  const K = COL();
  const L = (x, y, z) => [E.x + E.ox[0] * x + E.oz[0] * z, E.y + y, E.z + E.ox[1] * x + E.oz[1] * z];
  const X = [E.ox[0], 0, E.ox[1]], Z = [E.oz[0], 0, E.oz[1]];
  const conc = new XB({ uv: true }), steel = new XB(), glass = new XB(), lamps = new XB(), stone = new XB({ uv: true });
  const W = 1.9, DROP = 5.6, Z0 = -1.0, Z1 = -10.8, Z2 = -13.4; // half width, depth, top step, foot, door wall
  // the steps (a rise of ~0.175 m) from Z0 down to Z1
  const n = Math.round(DROP / 0.175), run = (Z0 - Z1) / n;
  for (let k = 0; k < n; k++) {
    const za = Z0 - k * run, zb = za - run, yt = -(k + 1) * (DROP / n);
    conc.obx(L(0, yt - 0.35, (za + zb) / 2), X, Z, W, 0.35, run / 2, K.wall, K.edge);
    // a dark nosing strip on every step
    steel.obx(L(0, yt + 0.006, za - 0.04), X, Z, W - 0.05, 0.008, 0.04, K.steelDark);
  }
  // the landing and the doorway wall: a lit opening with glass doors, the name over it
  conc.obx(L(0, -DROP - 0.3, (Z1 + Z2) / 2), X, Z, W, 0.3, (Z1 - Z2) / 2, K.pave, K.edge);
  stone.obx(L(0, -DROP / 2 + 0.6, Z2 - 0.3), X, Z, W + 0.4, DROP / 2 + 1.2, 0.3, K.wallDark);
  lamps.obx(L(0, -DROP + 1.3, Z2 + 0.02), X, Z, 1.25, 1.3, 0.02, K.lamp);
  for (const x of [-0.62, 0.62]) steel.obx(L(x, -DROP + 1.3, Z2 + 0.06), X, Z, 0.03, 1.3, 0.03, K.steelDark);
  steel.obx(L(0, -DROP + 2.62, Z2 + 0.06), X, Z, 1.3, 0.03, 0.04, K.steelDark);
  // the side walls (from under the steps to 1.05 m over the ground: the parapets), the handrails
  for (const sd of [-1, 1]) {
    stone.obx(L(sd * (W + 0.2), -DROP / 2 + 0.2, (Z0 + Z2) / 2), X, Z, 0.2, DROP / 2 + 0.85, (Z0 - Z2) / 2 + 0.2, K.wallDark, K.edge);
    steel.rod(L(sd * (W - 0.08), 0.95, Z0), L(sd * (W - 0.08), -DROP + 0.95, Z1), 0.035, K.steel, 6);
  }
  stone.obx(L(0, 0.55, Z2 - 0.35), X, Z, W + 0.4, 0.5, 0.35, K.wallDark, K.edge);
  // the ceiling lights along the stairwell's walls
  for (let z = Z0 - 1.5; z > Z2; z -= 3) for (const sd of [-1, 1]) lamps.obx(L(sd * (W - 0.02), -((Z0 - z) / (Z0 - Z1)) * DROP + 2.2, z), X, Z, 0.02, 0.05, 0.5, K.lamp);
  // the pavilion: four slim columns, a flat roof with a deep fascia, glass walls on the sides and the back
  const RW = 3.6, RZ0 = 1.6, RZ1 = -14.4, RY = 3.9;
  for (const [x, z] of [[-RW, RZ0 - 0.4], [RW, RZ0 - 0.4], [-RW, RZ1 + 0.2], [RW, RZ1 + 0.2]]) steel.obx(L(x, RY / 2, z), X, Z, 0.12, RY / 2, 0.12, K.steel);
  conc.obx(L(0, RY + 0.25, (RZ0 + RZ1) / 2), X, Z, RW + 0.6, 0.25, (RZ0 - RZ1) / 2 + 0.5, K.roofUnder, K.roof);
  conc.obx(L(0, RY + 0.55, (RZ0 + RZ1) / 2), X, Z, RW + 0.45, 0.05, (RZ0 - RZ1) / 2 + 0.35, K.snow);
  for (const sd of [-1, 1]) {
    glass.face(L(sd * RW, 0.05, RZ0 - 0.6), L(sd * RW, 0.05, RZ1 + 0.4), L(sd * RW, RY, RZ1 + 0.4), L(sd * RW, RY, RZ0 - 0.6), L(0, 1, (RZ0 + RZ1) / 2), lin('#ffffff'), 4);
    steel.obx(L(sd * RW, 0.05, (RZ0 + RZ1) / 2), X, Z, 0.06, 0.05, (RZ0 - RZ1) / 2 - 0.5, K.steelDark);
  }
  glass.face(L(-RW, 0.05, RZ1 + 0.2), L(RW, 0.05, RZ1 + 0.2), L(RW, RY, RZ1 + 0.2), L(-RW, RY, RZ1 + 0.2), L(0, 1, 0), lin('#ffffff'), 4);
  // the stone plinth round the stairwell (the floor of the pavilion) and a lit soffit over the stairs
  for (const sd of [-1, 1]) stone.obx(L(sd * (RW - 0.6), 0.04, (RZ0 + RZ1) / 2), X, Z, 1.2 - 0.2, 0.08, (RZ0 - RZ1) / 2 - 0.3, K.pave);
  lamps.obx(L(0, RY - 0.02, -6), X, Z, 0.08, 0.02, 6, K.lamp);
  const grp = new THREE.Group();
  const add = (b, mat, cast = true) => { const g = b.build(); if (!g) return null; const m = new THREE.Mesh(g, mat); m.castShadow = cast; m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); return m; };
  add(conc, M.form);
  add(stone, M.form);
  add(steel, M.mast);
  add(glass, M.glass, false);
  add(lamps, M.lampX, false);
  // the sign on the fascia, facing out (and a smaller one at the back)
  const mats = [];
  const t = tex('x-entrance', 2048, 256, (g, w, h) => {
    g.fillStyle = '#1e232a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#b0121a'; g.fillRect(0, 0, 230, h);
    g.fillStyle = '#ffffff'; g.font = `italic 700 150px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('X', 115, h / 2 + 6);
    g.fillText('LEGACY EXPRESS  ·  ALL RACES', 230 + (w - 230) / 2, h / 2 + 6);
  });
  const sm = new THREE.MeshStandardMaterial({ map: t, color: t ? 0xffffff : 0x1e232a, roughness: 0.4, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.25 });
  mats.push(sm);
  for (const [z, yaw] of [[RZ0 + 0.52, 0], [RZ1 - 0.52, Math.PI]]) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(2 * RW + 1.0, (2 * RW + 1.0) / 8), sm);
    pl.position.set(...L(0, RY + 0.25, z));
    pl.rotation.y = E.heading + yaw;
    grp.add(pl);
  }
  rec.cameraBlockers?.push(grp.children[0]);
  grp.userData.signs = mats;
  grp.userData.dispose = mats;
  grp.userData.sign = sm;
  return grp;
}

// ------------------------------------------------------------------ Legacy Village: the underground hall
// The tube opens into a vaulted hall over both platforms; its end walls close the vault round the tube's mouths.
function hallProfile() {
  const P = [[-EDGE, FLOOR_Y], [-EDGE, PLAT_Y - 0.06], [-HALL_W, PLAT_Y - 0.06], [-HALL_W, HALL_SPR]];
  const n = 24;
  for (let k = 1; k < n; k++) { const a = (k / n) * Math.PI; P.push([-HALL_W * Math.cos(a), HALL_SPR + (HALL_CR - HALL_SPR) * Math.sin(a)]); }
  P.push([HALL_W, HALL_SPR], [HALL_W, PLAT_Y - 0.06], [EDGE, PLAT_Y - 0.06], [EDGE, FLOOR_Y], [-EDGE, FLOOR_Y]);
  return P;
}
function resampleRing(P, n) {
  const acc = [0];
  for (let i = 1; i < P.length; i++) acc.push(acc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = acc.at(-1), out = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * L;
    while (j < P.length - 1 && acc[j] < t) j++;
    const u = (t - acc[j - 1]) / (acc[j] - acc[j - 1] || 1);
    out.push([P[j - 1][0] + (P[j][0] - P[j - 1][0]) * u, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * u]);
  }
  return out;
}
function buildHall(rec, M) {
  const K = COL();
  const lining = new XB({ uv: true, light: true }), lamps = new XB(), steel = new XB(), plat = new XB({ uv: true });
  const P = hallProfile();
  let A = 0;
  const arc = P.map((p, i) => (i ? (A += Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1])) : 0));
  const f = {};
  const ring = (s, prof, arcs, lit) => {
    expressFrame(s, f);
    return prof.map(([x, y], k) => {
      const a = prof[Math.max(0, k - 1)], b = prof[Math.min(prof.length - 1, k + 1)];
      let nx = b[1] - a[1], ny = -(b[0] - a[0]); const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      const low = 1 - Math.min(1, Math.max(0, (y - 0.1) / 1.5)), g = 0.96 - low * 0.3;
      return lining.vc(f.x + f.rx * x, f.y + y, f.z + f.rz * x, f.rx * nx, ny, f.rz * nx, [g, g * 0.985, g * 0.96], (arcs ? arcs[k] : 0) / 6, s / 6, lit, 0);
    });
  };
  let prev = null;
  for (let s = -HALL_HALF; s <= HALL_HALF + 1e-6; s += 3) {
    const r = ring(s, P, arc, 0.95);
    if (prev) for (let k = 0; k < r.length - 1; k++) lining.aq(prev[k], r[k], r[k + 1], prev[k + 1]);
    prev = r;
  }
  // the end walls: from the hall's ring in to the tube's (facing into the hall)
  const N = 80, outer = resampleRing(P, N), inner = resampleRing(tubeProfile().P, N);
  for (const s of [-HALL_HALF, HALL_HALF]) {
    const o = ring(s, outer, null, 0.75), i = ring(s, inner, null, 0.75);
    const into = s < 0 ? 1 : -1;
    expressFrame(s, f);
    for (const idx of [...o, ...i]) { lining.N[idx * 3] = f.tx * into; lining.N[idx * 3 + 1] = 0; lining.N[idx * 3 + 2] = f.tz * into; }
    for (let k = 0; k < N; k++) lining.aq(o[k], o[k + 1], i[k + 1], i[k]);
  }
  // both platforms (to the walls), the lamp rows along the vault, benches and the name boards
  const F = rec.F, mats = [], grp = new THREE.Group();
  for (const sd of [-1, 1]) platform(plat, F, sd, -PLATFORM / 2, PLATFORM / 2, { back: HALL_W - 0.02 });
  const X = [F.rx, 0, F.rz], Z = [F.dx, 0, F.dz];
  for (let u = -PLATFORM / 2 + 6; u <= PLATFORM / 2 - 6; u += 8) for (const lat of [-6.4, -2.2, 2.2, 6.4]) {
    const y = HALL_SPR + (HALL_CR - HALL_SPR) * Math.sqrt(Math.max(0, 1 - (lat / HALL_W) ** 2)) - 1.4;
    lamps.obx(F.P(u, lat, y), X, Z, 0.12, 0.05, 3.2, K.lamp);
    for (const du of [-2.4, 2.4]) steel.rod(F.P(u + du, lat, y + 0.05), F.P(u + du, lat, y + 1.5), 0.012, K.steelDark, 4);
  }
  for (const sd of [-1, 1]) for (const u of [-90, -45, 0, 45, 90]) {
    const bd = boardMesh('Legacy Village', 4.6, 0.72, mats);
    placeAt(bd, F.P(u, sd * 6.6, PLAT_Y + 3.2), rec.heading + Math.PI / 2);
    for (const du of [-1.6, 1.6]) steel.rod(F.P(u + du, sd * 6.6, PLAT_Y + 3.55), F.P(u + du, sd * 6.6, HALL_SPR + 3.5), 0.015, K.steelDark, 4);
    grp.add(bd);
  }
  const add = (b, mat) => { const g = b.build(); if (!g) return null; const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); return m; };
  add(lining, M.lining);
  add(lamps, M.lampX);
  add(steel, M.mast);
  // the platforms: lit by the hall's lamps (the sky does not reach down here)
  M.hallPlat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, emissive: 0x6a645a, envMapIntensity: 0.05 });
  add(plat, M.hallPlat);
  grp.userData.signs = mats;
  grp.userData.dispose = mats;
  return grp;
}

/** Is the village hall worth drawing for a viewer at v (underground: under the ground there, near the hall)? */
export function hallVisible(rec, v, under) {
  return under && Math.hypot(v.x - rec.x, v.z - rec.z) < HALL_HALF + 700;
}

export function buildExpressStation(rec, M, models) {
  if (!rec.underground) return buildCourseStation(rec, M, models);
  const grp = new THREE.Group();
  const ent = buildEntrance(rec, M), hall = buildHall(rec, M);
  grp.add(ent, hall);
  grp.userData.signs = [...(ent.userData.signs || []), ...(hall.userData.signs || [])];
  grp.userData.dispose = [...(ent.userData.dispose || []), ...(hall.userData.dispose || [])];
  grp.userData.view = (v, under) => { const on = hallVisible(rec, v, under); if (hall.visible !== on) hall.visible = on; };
  grp.userData.setNight = (n) => { if (ent.userData.sign) ent.userData.sign.emissiveIntensity = 0.25 + n * 0.6; };
  return grp;
}
