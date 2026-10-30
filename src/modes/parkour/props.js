// Course dressing, World Cup style: start house + START arch, checkpoint arches, slalom gates, downhill
// gate flags with blue dye lines across the piste, the finish arena (big red FINISH portal, timing board,
// grandstands with spectators, patrol hut, flags), feature signs and decor. Assembles every mesh of a
// course (barriers + structures + props) into one group. Everything stands on the rendered snow
// (kit.meshGround) or on a flattened pad, nothing floats.
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { layout } from '../../world/layout.js';
import { fitModel, makeLOD } from '../../core/assets.js';
import { mulberry32, smoothstep } from '../../core/noise.js';
import { MeshBuilder, tint, vcMaterial, canvasTexture, bannerTexture, footprintMin, footprintMax, meshGround, clearMeshGround, FONT, BLUE } from './kit.js';
import { buildBarriers } from './barriers.js';
import { buildTunnel, buildBridge, buildLake, buildWaterfall } from './structures.js';
import { buildTurnWarnings } from './warnings.js';
import { buildFloodlightMasts } from '../race/floodlights.js';
import { BARRIER } from './track.js';
import { lookOf, buildCourseScenery } from './looks.js';

const RED = '#d9221c';

// Grandstands step up toward their back: if the model's -z half is the lower one, its front is -z.
function frontIsMinusZ(gltf) {
  let up = 0, nUp = 0, dn = 0, nDn = 0;
  const v = new THREE.Vector3();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(p.count / 4000));
    for (let i = 0; i < p.count; i += step) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (v.z > 0) { up += v.y; nUp++; } else { dn += v.y; nDn++; }
    }
  });
  return nUp && nDn ? up / nUp > dn / nDn : false;
}

// Model clones share geometry/materials with the loaded GLTF: never dispose those with the course.
function shareModel(obj) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      o.userData.keepGeometry = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) m.userData.shared = true;
    }
  });
  return obj;
}

// ------------------------------------------------------------------ entry point
export function buildCourseMeshes(course, models = {}) {
  clearMeshGround();
  course.solids = []; // the props that stand outside the nets as colliders ({x, z, r} | boxes): freeworld.js registers them while the course stands
  const group = new THREE.Group();
  group.name = 'course-' + course.id;
  const barriers = buildBarriers(course, models);
  group.add(barriers);
  const mats = barriers.userData.materials;
  const structures = new THREE.Group();
  structures.name = 'structures';
  buildTunnel(course, models, structures);
  buildBridge(course, models, structures, mats);
  buildLake(course, structures);
  buildWaterfall(course, structures, mats.ice);
  group.add(structures);
  const props = new THREE.Group();
  props.name = 'props';
  const dye = new DyeBuilder();
  buildStart(course, models, props, dye);
  buildCheckpoints(course, props, dye);
  buildGates(course, props, dye);
  buildFinish(course, models, props, dye);
  buildCrowd(course, models, props);
  buildFlags(course, props);
  buildSigns(course, props);
  buildTurnWarnings(course, props); // chevron boards on the outside of every bend
  if (course.def?.night) props.add(buildFloodlightMasts(course)); // night courses: floodlight masts
  buildDecor(course, models, props);
  try { buildCourseScenery(course, models, props); } catch (e) { console.warn('Course scenery failed', e); } // themed dressing (looks.js)
  props.add(dye.build());
  group.add(props);
  group.userData.layout = barriers.userData.layout;
  clearMeshGround();
  return group;
}

// The dressing of a race laid on an existing piste (modes/race/busraces.js: the ski bus's free races): the same
// start house, START arch, checkpoint arches, slalom gates and FINISH portal as a World Racing course, without the
// nets, structures and arena (the piste has its own fences). course.track: any track with X, Z, W, H, n, length,
// sAt(arr, s), pointAt(s, lat) and surfaceY(s, lat) (2 m samples from s = 0).
export function buildPisteRaceMeshes(course, models = {}) {
  clearMeshGround();
  course.solids = [];
  const group = new THREE.Group();
  group.name = 'course-' + course.id;
  const props = new THREE.Group();
  props.name = 'props';
  const dye = new DyeBuilder();
  buildStart(course, models, props, dye, { inward: true });
  buildCheckpoints(course, props, dye);
  buildGates(course, props, dye);
  const T = course.track, fs = course.finishS;
  props.add(finishPortal(course, fs));
  dye.across(T, fs, 0.6, '#d9221c', -T.sAt(T.W, fs) + 0.2, T.sAt(T.W, fs) - 0.2, false);
  props.add(dye.build());
  group.add(props);
  clearMeshGround();
  return group;
}

// ------------------------------------------------------------------ helpers
// a spot beside the track whose footprint is level enough to stand a structure on
function gentleSpot(T, s, lats, hw, hd, maxDrop = 0.6) {
  for (const lat of lats) {
    const p = T.pointAt(s, lat);
    const lo = footprintMin(p.x, p.z, p.heading, hw, hd, 2), hi = footprintMax(p.x, p.z, p.heading, hw, hd, 2);
    if (hi - lo < maxDrop) return { ...p, lat, ground: lo };
  }
  return null;
}
const frameAt = (T, s) => {
  const p = T.pointAt(s, 0);
  return { x: p.x, z: p.z, y: p.y, heading: p.heading, tx: Math.sin(p.heading), tz: Math.cos(p.heading), rx: -Math.cos(p.heading), rz: Math.sin(p.heading) };
};
// snow height where a skier sees it: the rendered terrain, or a walkable surface (bridge deck, ramp)
// at the track's own level
function snowY(x, z, trackY) {
  const g = meshGround(x, z);
  const s = world.groundHeight(x, z, trackY + 0.4);
  return s > g + 0.05 ? s : g;
}

// Spray-paint lines on the snow (dye): every strip of a course goes into one decal mesh.
function dashTexture() {
  // grey levels = coverage (an alphaMap reads the green channel): two soft-edged dashes per tile,
  // like a spray can drawn across the snow
  return canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (const [x0, x1] of [[10, 112], [138, 242]]) {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.24, 'rgba(255,255,255,0.92)');
      grd.addColorStop(0.76, 'rgba(255,255,255,0.92)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.ellipse((x0 + x1) / 2, h / 2, (x1 - x0) / 2, h * 0.48, 0, 0, Math.PI * 2); g.fill();
    }
  }, { wrap: true, anisotropy: 8 });
}
class DyeBuilder {
  constructor() { this.P = []; this.U = []; this.C = []; this.I = []; }
  // strip across the track at s from lateral a to b; dashed (texture) or solid (colour)
  across(T, s, width, color, a, b, dashed) {
    const n = Math.max(2, Math.ceil((b - a) / 0.5));
    const c = new THREE.Color(color);
    const base = this.P.length / 3;
    const ty = T.surfaceY(s, 0);
    for (let k = 0; k <= n; k++) {
      const l = a + ((b - a) * k) / n;
      for (const [ds, v] of [[-width / 2, 0], [width / 2, 1]]) {
        const p = T.pointAt(s + ds, l);
        this.P.push(p.x, snowY(p.x, p.z, ty) + 0.05, p.z);
        // solid strips sample the middle of a dash (fully opaque)
        this.U.push(dashed ? (l - a) / 1.6 : 0.25, dashed ? v : 0.5);
        this.C.push(c.r, c.g, c.b);
      }
    }
    for (let k = 0; k < n; k++) { const i = base + k * 2; this.I.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(this.P.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setIndex(upwards(this.P, this.I));
    g.computeBoundingSphere();
    const tex = dashTexture();
    // the texture is blue: colour it per strip through the vertex colours (red finish line = white
    // texel x red), so the dash map is used as an alpha / brightness mask
    if (tex) tex.colorSpace = THREE.NoColorSpace;
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85, transparent: !!tex, depthWrite: false, alphaMap: tex || null,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    m.receiveShadow = true;
    m.renderOrder = 1;
    m.name = 'dye';
    return m;
  }
}
function upwards(P, I) {
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
    if ((P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2]) < 0) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
  }
  return I;
}

// Inflatable race arch: a fat tube rising from two weighted feet, rounded corners, white bands,
// a banner panel on both faces of the top beam. Feet sit on the rendered snow at each side; the arch
// grows taller with its span so wide World Cup pistes still get a well-proportioned arch.
function inflatableArch(T, s, text, { color = BLUE, band = '#ffffff', sub = 'SKI LEGACY', extra = 1.3 } = {}) {
  const g = new THREE.Group();
  const f = frameAt(T, s);
  const w = T.sAt(T.W, s);
  const half = w + extra;
  const height = Math.min(9.5, Math.max(6.2, 2.4 + half * 0.28));
  const R = half > 14 ? 0.75 : 0.55, cr = R * 3.1;
  const yL = meshGround(f.x - f.rx * half, f.z - f.rz * half), yR = meshGround(f.x + f.rx * half, f.z + f.rz * half);
  const top = Math.max(yL, yR) + height;
  // path in the cross-section plane (x = lateral, y = height), then placed in world space
  const pts2 = [];
  const add = (x, y) => pts2.push(new THREE.Vector2(x, y));
  for (let k = 0; k <= 6; k++) add(-half, yL - 0.3 + ((top - cr - yL + 0.3) * k) / 6);
  for (let k = 1; k <= 8; k++) { const a = Math.PI - (k / 8) * (Math.PI / 2); add(-half + cr + Math.cos(a) * cr, top - cr + Math.sin(a) * cr); }
  for (let k = 1; k <= 14; k++) add(-half + cr + ((2 * half - 2 * cr) * k) / 14, top);
  for (let k = 1; k <= 8; k++) { const a = Math.PI / 2 - (k / 8) * (Math.PI / 2); add(half - cr + Math.cos(a) * cr, top - cr + Math.sin(a) * cr); }
  for (let k = 1; k <= 6; k++) add(half, top - cr - ((top - cr - yR + 0.3) * k) / 6);
  const pts3 = pts2.map((p) => new THREE.Vector3(f.x + f.rx * p.x, p.y, f.z + f.rz * p.x));
  const curve = new THREE.CatmullRomCurve3(pts3, false, 'centripetal', 0.2);
  const SEGS = 140;
  const tube = new THREE.TubeGeometry(curve, SEGS, R, 14, false);
  // vertex colours: brand colour with bands near the corners and at the feet
  const col = new THREE.Color(color), bandC = new THREE.Color(band);
  const P = tube.attributes.position, C = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) {
    const u = Math.floor(i / 15) / SEGS; // tube segments ring by ring
    const b = (Math.abs(u - 0.2) < 0.02 || Math.abs(u - 0.8) < 0.02 || u < 0.012 || u > 0.988) ? bandC : col;
    C[i * 3] = b.r; C[i * 3 + 1] = b.g; C[i * 3 + 2] = b.b;
  }
  tube.setAttribute('color', new THREE.BufferAttribute(C, 3));
  const mesh = new THREE.Mesh(tube, vcMaterial({ roughness: 0.45, metalness: 0, envMapIntensity: 1.1 }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  g.add(mesh);
  // weighted feet (sand bags) + caps
  const fb = new MeshBuilder();
  const dark = tint('#23262d'), white = tint('#f4f6fa');
  for (const [sx, y] of [[-1, yL], [1, yR]]) {
    const x = f.x + f.rx * half * sx, z = f.z + f.rz * half * sx;
    fb.at(x, y - 0.12, z).cyl(0, 0, 0, R * 1.5, R * 1.32, 0.38, 16, dark, { colTop: white });
  }
  const feet = new THREE.Mesh(fb.build(), vcMaterial({ roughness: 0.8 }));
  feet.castShadow = true; feet.receiveShadow = true;
  g.add(feet);
  // banner panel on both faces of the top beam
  const tex = bannerTexture(text, { sub, w: 1024, h: 256 });
  const bw = Math.min(2 * half - 2 * cr - 0.6, 13), bh = (bw / 4) * 0.9;
  const bmat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xf2f4f8, roughness: 0.55 });
  for (const sd of [-1, 1]) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), bmat);
    pl.position.set(f.x + f.tx * sd * (R + 0.03), top - R - bh / 2 + 0.25, f.z + f.tz * sd * (R + 0.03));
    pl.rotation.y = f.heading + (sd < 0 ? Math.PI : 0);
    pl.castShadow = true;
    g.add(pl);
  }
  return g;
}

// ------------------------------------------------------------------ start
function buildStart(course, models, group, dye, { inward = false } = {}) {
  const T = course.track, H = course.startHouse;
  const yaw = H.heading;
  // Seat the house by its real depth: the open front sits on H.front (just behind the start line, clear
  // of the racers' ski tails), centred on the track. H is updated with the real footprint.
  const seat = (depth, halfW) => {
    if (Number.isFinite(H.front)) {
      H.s = H.front - depth / 2;
      const p = T.pointAt(H.s, 0);
      H.x = p.x; H.z = p.z;
    }
    H.depth = depth; H.halfWidth = halfW;
  };
  // --- start house: Meshy model if present, else an open timber shelter
  if (models.start_house) {
    const m = shareModel(fitModel(models.start_house, { size: 5.2, axis: 'x' }));
    const size = m.userData.size;
    seat(Math.max(2.5, size?.z || 4.4), (size?.x || 5.2) / 2);
    m.position.set(H.x, footprintMin(H.x, H.z, yaw, H.halfWidth, H.depth / 2) - 0.08, H.z);
    m.rotation.y = yaw;
    m.name = 'start-house'; // main.js hides it while the chase camera is inside it (the racer lines up in it)
    group.add(m);
  } else {
    seat(3.7, 3.05);
    const shelter = startShelter(H, course);
    shelter.name = 'start-house';
    group.add(shelter);
  }
  // --- start wand + timing posts in front of the house
  const f = frameAt(T, course.start.s + 0.6);
  const b = new MeshBuilder();
  const steel = tint('#30343b'), red = tint('#d8231c'), white = tint('#f4f5f7'), led = tint('#141418');
  for (const sd of [-1, 1]) {
    const x = f.x + f.rx * sd * 1.05, z = f.z + f.rz * sd * 1.05, y = meshGround(x, z);
    b.at(x, y - 0.3, z, yaw).box(0, 0.6, 0, 0.14, 1.2, 0.14, steel);
    b.at(x, y, z, yaw).box(0, 0.98, 0, 0.26, 0.18, 0.2, led, steel);
  }
  // red/white striped wand between the posts
  for (let k = 0; k < 8; k++) {
    const t0 = -0.96 + (1.92 * k) / 8, t1 = t0 + 1.92 / 8;
    b.at(0, 0, 0).rod(f.x + f.rx * t0, f.y + 0.6, f.z + f.rz * t0, f.x + f.rx * t1, f.y + 0.6, f.z + f.rz * t1, 0.022, 6, k % 2 ? white : red);
  }
  const m = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.5, metalness: 0.2 }));
  m.castShadow = true; m.receiveShadow = true;
  group.add(m);
  // --- START arch over the track below the gate (house style: blue tube, red bands)
  const LC = lookOf(course).colors || {};
  group.add(inflatableArch(T, course.start.s + 12, 'START', { sub: course.name.toUpperCase(), color: LC.arch || BLUE, band: LC.band || RED, extra: 0.9 }));
  dye.across(T, course.start.s + 0.6, 0.14, BLUE, -1.3, 1.3, false);
  // --- course board beside the house
  const side = -1;
  const bw = 4.4, bh = 2.4;
  const tex = canvasTexture(1024, 560, (g, W, Hh) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, Hh);
    g.fillStyle = BLUE; g.fillRect(0, 0, W, 120);
    g.fillStyle = '#e2231a'; g.fillRect(0, 120, W, 8);
    g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `italic 700 78px ${FONT}`; g.fillText(course.boardTitle || 'WORLD RACING', 44, 62);
    g.fillStyle = BLUE; g.font = `italic 700 92px ${FONT}`;
    let fs = 92; while (g.measureText(course.name.toUpperCase()).width > W - 88 && fs > 40) { fs -= 4; g.font = `italic 700 ${fs}px ${FONT}`; }
    g.fillText(course.name.toUpperCase(), 44, 222);
    g.font = `600 54px ${FONT}`; g.fillStyle = '#1d2533';
    g.fillText(`${(course.length / 1000).toFixed(1)} KM    ${Math.round(course.drop)} M VERTICAL    ${course.difficulty.toUpperCase()}`, 44, 330);
    g.fillStyle = '#5a6476'; g.font = `500 40px ${FONT}`;
    const feats = [...new Set(course.features.map((f) => f.type))].filter((t) => ['tunnel', 'bridge', 'lake', 'kicker', 'tabletop', 'slalom', 'cliff'].includes(t));
    const names = { tunnel: 'TUNNEL', bridge: 'GORGE BRIDGE', lake: 'FROZEN LAKE', kicker: 'JUMPS', tabletop: 'TABLETOPS', slalom: 'GATES', cliff: 'CLIFF TRAVERSE' };
    g.fillText(feats.map((t) => names[t]).join('  ·  '), 44, 420);
    g.fillStyle = BLUE; g.fillRect(0, Hh - 26, W, 26);
  });
  const sb = course.start.s + 20, w0 = T.sAt(T.W, sb);
  const lats = [side * (w0 + 3.2), -side * (w0 + 3.2), side * (w0 + 5)];
  // (Oct 30 2026, the user, at the Valley Classic's start: "move this more to the right so it is not in the
  // fence". The board stood w0 + 3.2 m off the smoothed course line, which put it right on the piste fence 1.2 m
  // beyond the real groomed edge, half of it sunk into the net. Now its footprint (board width + 1 m) is checked
  // against every piste fence / hazard net (layout.nets): on a piste race it slides sideways toward the piste
  // centre until it stands 1 m clear, never closer than beside the slalom openings (10.5 m off the line + half
  // the board: it stays beside the start, off the racing line); on a World Racing course, whose own nets bound the
  // track, it steps outward instead. It keeps its side and faces the gate the same way.)
  const yawOf = (p, lat) => p.heading + Math.PI - Math.sign(lat) * 0.5;
  const minLat = 10.5 + bw / 2 + 0.3, maxLat = w0 + 3.2 + 8;
  const placed = (lat) => {
    const dir = inward ? -Math.sign(lat) : Math.sign(lat);
    for (let l = lat; Math.abs(l) >= minLat && Math.abs(l) <= maxLat; l += dir * 0.25) {
      const p = T.pointAt(sb, l);
      if (fenceClearance(p.x, p.z, yawOf(p, l), bw / 2 + 0.06) >= 1) return l;
    }
    return null;
  };
  let spot = null;
  for (const maxDrop of [0.8, 1.6]) {
    for (const lat0 of lats) {
      const l = placed(lat0);
      if (l !== null) spot = gentleSpot(T, sb, [l], 2.4, 0.5, maxDrop);
      if (spot) break;
    }
    if (spot) break;
  }
  spot ||= gentleSpot(T, sb, lats, 2.4, 0.5, 0.8); // (nowhere clear: the old spots)
  if (spot) {
    const board = signBoard(tex, bw, bh, 1.2);
    board.position.set(spot.x, spot.ground - 0.05, spot.z);
    board.rotation.y = yawOf(spot, spot.lat); // faces the racers at the gate
    group.add(board);
  }
}

// The piste fences and hazard nets (layout.nets lines, posts every ~2 m) as segments in a 32 m grid, built once
// the fences are planned (rebuilt if layout.nets changes).
let fenceGrid = null, fenceGridOf = null, fenceGridN = -1;
const FG = 32;
function fenceSegs() {
  const nets = layout.nets || [];
  if (fenceGrid && fenceGridOf === nets && fenceGridN === nets.length) return fenceGrid;
  fenceGrid = new Map(); fenceGridOf = nets; fenceGridN = nets.length;
  for (const n of nets) {
    const L = n.line;
    if (!L || L.length < 2) continue;
    for (let i = 1; i < L.length; i++) {
      const ax = L[i - 1][0], az = L[i - 1][1], bx = L[i][0], bz = L[i][1];
      for (let gx = Math.floor(Math.min(ax, bx) / FG); gx <= Math.floor(Math.max(ax, bx) / FG); gx++) {
        for (let gz = Math.floor(Math.min(az, bz) / FG); gz <= Math.floor(Math.max(az, bz) / FG); gz++) {
          const k = gx + ',' + gz;
          if (!fenceGrid.has(k)) fenceGrid.set(k, []);
          fenceGrid.get(k).push(ax, az, bx, bz);
        }
      }
    }
  }
  return fenceGrid;
}
// how far (m) a board of half-width hw centred on (x, z), turned to yaw (its face along local x), stands from
// the nearest piste fence / net (Infinity: none within ~30 m)
function fenceClearance(x, z, yaw, hw) {
  const grid = fenceSegs(), ux = Math.cos(yaw), uz = -Math.sin(yaw);
  let best = Infinity;
  const gx0 = Math.floor((x - hw - 4) / FG), gx1 = Math.floor((x + hw + 4) / FG), gz0 = Math.floor((z - hw - 4) / FG), gz1 = Math.floor((z + hw + 4) / FG);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const segs = grid.get(gx + ',' + gz);
    if (!segs) continue;
    for (let j = 0; j < segs.length; j += 4) {
      const ax = segs[j], az = segs[j + 1], bx = segs[j + 2], bz = segs[j + 3], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      // the board's width sampled every ~0.3 m against the segment
      for (let k = -8; k <= 8; k++) {
        const px = x + ux * hw * (k / 8), pz = z + uz * hw * (k / 8);
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
        const d = Math.hypot(px - ax - dx * t, pz - az - dz * t);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// Open-ended timber start shelter (camera-friendly: no back wall), anthracite roof with snow load,
// START fascia, window strips in the side walls.
function startShelter(H, course) {
  const g = new THREE.Group();
  g.position.set(H.x, footprintMin(H.x, H.z, H.heading, 2.6, 2.0) - 0.05, H.z);
  g.rotation.y = H.heading;
  const b = new MeshBuilder();
  const wood = tint('#5a3e2a'), woodL = tint('#7a5638'), roof = tint('#2c2f35'), snow = tint('#f3f6fb'), glass = tint('#1c2a38'), trim = tint('#e9ecf1');
  const W = 2.45, D = 1.85, hF = 3.5, hB = 2.95;
  for (const sx of [-1, 1]) {
    for (let z = -D; z < D - 0.01; z += 0.24) {
      const hh = hB + ((z + 0.12 + D) / (2 * D)) * (hF - hB);
      const c = Math.round((z + D) / 0.24) % 2 ? wood : woodL;
      b.box(sx * W, hh / 2 - 0.1, z + 0.12, 0.14, hh + 0.2, 0.235, c);
    }
    b.box(sx * (W + 0.03), 1.85, -0.2, 0.12, 0.55, 2.4, glass);
    b.box(sx * (W + 0.05), 2.16, -0.2, 0.1, 0.07, 2.5, trim);
    b.box(sx * (W + 0.05), 1.54, -0.2, 0.1, 0.07, 2.5, trim);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * W, (sz > 0 ? hF : hB) / 2 - 0.1, sz * (D - 0.08), 0.26, (sz > 0 ? hF : hB) + 0.2, 0.26, wood);
  const pitch = Math.atan2(hF - hB, 2 * D);
  const save = b.m.clone();
  const rm = new THREE.Matrix4().compose(new THREE.Vector3(0, (hF + hB) / 2 + 0.12, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, 0, 0)), new THREE.Vector3(1, 1, 1));
  b.setMatrix(save.clone().multiply(rm));
  b.box(0, 0, 0, 2 * W + 1.2, 0.2, 2 * D + 1.3, roof);
  b.box(0, 0.22, -0.05, 2 * W + 1.05, 0.26, 2 * D + 1.1, snow);
  b.setMatrix(save);
  b.box(0, hF - 0.45, D + 0.12, 2 * W + 0.3, 0.75, 0.16, trim);
  b.box(0, 0.45, -D + 0.45, 2 * W - 0.4, 0.08, 0.45, woodL);
  for (const sx of [-1, 1]) b.box(sx * (W - 0.5), 0.22, -D + 0.45, 0.08, 0.45, 0.4, wood);
  const mesh = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.85 }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  g.add(mesh);
  const tex = bannerTexture('START', { sub: course.name.toUpperCase(), w: 1024, h: 168, size: 0.72 });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2 * W + 0.2, 0.7), new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xf2f4f8, roughness: 0.55 }));
  sign.position.set(0, hF - 0.45, D + 0.21);
  g.add(sign);
  return g;
}

// Freestanding sign: printed face on a board with two posts (base of the posts at the group origin).
function signBoard(tex, w, h, postH, color = 0x2f3440) {
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xeef1f6, roughness: 0.6 }));
  face.position.set(0, postH + h / 2, 0.045);
  const b = new MeshBuilder();
  const c = tint('#' + color.toString(16).padStart(6, '0')), snow = tint('#f3f6fb');
  b.box(0, postH + h / 2, 0, w + 0.12, h + 0.12, 0.08, c, snow);
  for (const sx of [-1, 1]) b.box(sx * (w / 2 - 0.25), (postH + h) / 2 - 0.2, -0.08, 0.1, postH + h + 0.4, 0.1, c, snow);
  const body = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.6, metalness: 0.25 }));
  g.add(body, face);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ------------------------------------------------------------------ checkpoints
function buildCheckpoints(course, group, dye) {
  const T = course.track;
  const total = course.checkpoints.length - 1;
  for (const cp of course.checkpoints) {
    if (cp.index === 0) continue;
    const LC = lookOf(course).colors || {};
    const arch = inflatableArch(T, cp.s, `CHECKPOINT ${cp.index}`, { sub: course.name.toUpperCase(), color: LC.arch || BLUE, band: LC.band || '#ffffff' });
    group.add(arch);
    group.add(checkpointDisc(T, cp.s, cp.index, total, arch));
    const w = T.sAt(T.W, cp.s);
    dye.across(T, cp.s, 0.4, BLUE, -w + 0.3, w - 0.3, false);
  }
}

// A big numbered disc on a short mast above a checkpoint arch: readable from far up the course (the
// arch banner alone is small at a distance). Two faces back to back, so the number reads right both ways;
// white rim and blue face are painted in the texture.
function checkpointDisc(T, s, index, total, arch) {
  const g = new THREE.Group();
  const f = frameAt(T, s);
  const top = new THREE.Box3().setFromObject(arch).max.y;
  const R = 1.7, cy = top + 0.55 + R;
  const tex = canvasTexture(512, 512, (c, W, H) => {
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); c.fill();
    c.fillStyle = BLUE; c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 26, 0, Math.PI * 2); c.fill();
    c.strokeStyle = RED; c.lineWidth = 12; c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 44, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `italic 700 300px ${FONT}`;
    c.fillText(String(index), W / 2 - 4, H / 2 - 18);
    c.font = `italic 700 54px ${FONT}`;
    c.fillText(`OF ${total}`, W / 2, H / 2 + 138);
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x1546c8, roughness: 0.5, transparent: true, alphaTest: 0.5 });
  for (const sd of [-1, 1]) {
    const d = new THREE.Mesh(new THREE.CircleGeometry(R, 48), mat);
    d.position.set(f.x + f.tx * sd * 0.03, cy, f.z + f.tz * sd * 0.03);
    d.rotation.y = f.heading + (sd < 0 ? Math.PI : 0);
    // (no shadow: a small shadow-casting mesh is culled at a distance by engine/detail.js, and the disc
    // must read from far up the course)
    g.add(d);
  }
  // mast from the arch's top beam up to the disc, and a dark rim
  const b = new MeshBuilder();
  const dark = tint('#23262d');
  const mh = cy - R + 0.05 - (top - 0.35); // up to the disc's lower edge (never through its faces)
  b.at(f.x, top - 0.35, f.z, f.heading).box(0, mh / 2, 0, 0.14, mh, 0.14, dark);
  const mast = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.6, metalness: 0.3 }));
  mast.castShadow = true;
  g.add(mast);
  g.name = 'checkpoint-disc';
  return g;
}

// ------------------------------------------------------------------ gates
// Slalom gates (course.gates, literal contract: turning pole at (x, z), second turning pole at
// (x, z) + (nx, nz) * side * width; each pole's panel hangs on the outside of the opening) and
// downhill gate flags (course.dhGates: red panels at both piste edges) with a blue dye line across.
function buildGates(course, group, dye) {
  const T = course.track;
  const poleGeo = new THREE.CylinderGeometry(0.017, 0.02, 1.95, 6);
  poleGeo.translate(0, 0.975 - 0.25, 0); // 0.25 m set into the snow
  const panelGeo = new THREE.PlaneGeometry(1, 1, 4, 1);
  const pp = panelGeo.attributes.position;
  for (let i = 0; i < pp.count; i++) pp.setZ(i, Math.sin((pp.getX(i) + 0.5) * Math.PI) * 0.04); // slight billow
  panelGeo.computeVertexNormals();
  const items = []; // { x, z, ux, uz (panel direction), wd, hgt, y0, col }
  const red = new THREE.Color('#d21f1f'), blue = new THREE.Color('#1e4fd8');
  for (const gt of course.gates) {
    const col = gt.color === 'red' ? red : blue;
    const dir = gt.side; // + = toward (nx, nz)
    // pole A at (x, z), panel outward away from the opening; pole B at the far side, panel outward
    items.push({ x: gt.x, z: gt.z, ux: -gt.nx * dir, uz: -gt.nz * dir, wd: 0.75, hgt: 0.55, y0: 1.15, col });
    const bx = gt.x + gt.nx * dir * gt.width, bz = gt.z + gt.nz * dir * gt.width;
    items.push({ x: bx, z: bz, ux: gt.nx * dir, uz: gt.nz * dir, wd: 0.75, hgt: 0.55, y0: 1.15, col });
    // dye line across the opening
    const lA = latOf(T, gt.s, gt.x, gt.z), lB = latOf(T, gt.s, bx, bz);
    dye.across(T, gt.s, 0.22, BLUE, Math.min(lA, lB), Math.max(lA, lB), true);
  }
  for (const g of course.dhGates || []) {
    const w = T.sAt(T.W, g.s);
    for (const sd of [-1, 1]) {
      // panel in the strip between the piste edge and the B-net, turned 50 deg toward the racers
      const p = T.pointAt(g.s, sd * (w + 0.3));
      const tx = Math.sin(p.heading), tz = Math.cos(p.heading), ox = -Math.cos(p.heading) * sd, oz = Math.sin(p.heading) * sd;
      const ux = 0.643 * tx + 0.766 * ox, uz = 0.643 * tz + 0.766 * oz;
      items.push({ x: p.x - ux * 0.35, z: p.z - uz * 0.35, ux, uz, wd: 0.7, hgt: 0.8, y0: 0.95, col: red });
    }
    dye.across(T, g.s, 0.3, BLUE, -w + 0.4, w - 0.4, true);
  }
  if (!items.length) return;
  const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ roughness: 0.35 }), items.length * 2);
  const panels = new THREE.InstancedMesh(panelGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide }), items.length);
  const d = new THREE.Object3D();
  let kp = 0;
  items.forEach((it, k) => {
    for (const e of [0, it.wd]) {
      const x = it.x + it.ux * e, z = it.z + it.uz * e;
      d.position.set(x, meshGround(x, z), z);
      d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix();
      poles.setMatrixAt(kp, d.matrix); poles.setColorAt(kp, it.col); kp++;
    }
    const cx = it.x + it.ux * it.wd / 2, cz = it.z + it.uz * it.wd / 2;
    const yb = Math.min(meshGround(it.x, it.z), meshGround(it.x + it.ux * it.wd, it.z + it.uz * it.wd));
    d.position.set(cx, yb + it.y0 + it.hgt / 2, cz);
    // plane's local x along (ux, uz)
    d.rotation.set(0, Math.atan2(-it.uz, it.ux), 0);
    d.scale.set(it.wd - 0.04, it.hgt, 1);
    d.updateMatrix();
    panels.setMatrixAt(k, d.matrix); panels.setColorAt(k, it.col);
  });
  for (const m of [poles, panels]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); group.add(m); }
}
// lateral offset (+ right) of a world point relative to the centreline frame at s
function latOf(T, s, x, z) {
  const p = T.pointAt(s, 0);
  return (x - p.x) * -Math.cos(p.heading) + (z - p.z) * Math.sin(p.heading);
}

// ------------------------------------------------------------------ finish arena
function buildFinish(course, models, group, dye) {
  const T = course.track, A = course.arena;
  const fs = course.finishS;
  group.add(finishPortal(course, fs));
  dye.across(T, fs, 0.6, '#d9221c', -T.sAt(T.W, fs) + 0.2, T.sAt(T.W, fs) - 0.2, false);

  // --- grandstands facing the track
  for (const st of [A.grandstand, A.grandstand2]) {
    // stands are on the left of the track: their front (+z) must face right, toward the course
    const yawS = st.heading - Math.PI / 2;
    course.solids.push({ x: st.x, z: st.z, hw: 10.5, hd: 6, rot: -yawS });
    if (models.grandstand) {
      const m = shareModel(makeLOD(models.grandstand, { size: 22, axis: 'x' }, 180, 0.02));
      m.position.set(st.x, footprintMin(st.x, st.z, yawS, 11, 7) - 0.12, st.z);
      m.rotation.y = yawS + (frontIsMinusZ(models.grandstand) ? Math.PI : 0);
      group.add(m);
    } else {
      group.add(proceduralGrandstand(st, yawS));
    }
  }
  // --- timing board on the right, angled to the finish line
  {
    const tb = A.board;
    const yawB = tb.heading + Math.PI / 2 + 0.35;
    course.solids.push({ x: tb.x, z: tb.z, hw: 3.4, hd: 0.4, rot: -yawB });
    if (models.timing_board) {
      const m = shareModel(fitModel(models.timing_board, { size: 7, axis: 'x' }));
      m.position.set(tb.x, footprintMin(tb.x, tb.z, yawB, 3.5, 1) - 0.1, tb.z);
      m.rotation.y = yawB;
      group.add(m);
    } else {
      group.add(proceduralTimingBoard(tb, yawB, course));
    }
  }
  // --- ski patrol hut
  {
    const h = A.hut;
    const yawH = h.heading + Math.PI / 2;
    course.solids.push({ x: h.x, z: h.z, hw: 2.2, hd: 2.2, rot: -yawH });
    if (models.patrol_hut) {
      const m = shareModel(fitModel(models.patrol_hut, { size: 5, axis: 'xz' }));
      m.position.set(h.x, footprintMin(h.x, h.z, yawH, 2.5, 2.5) - 0.1, h.z);
      m.rotation.y = yawH;
      group.add(m);
    } else {
      group.add(patrolHut(h, yawH));
    }
    if (models.snowmobile) {
      const sm = shareModel(fitModel(models.snowmobile, { size: 3, axis: 'xz' }));
      const x = h.x + Math.sin(yawH + 1.2) * 5, z = h.z + Math.cos(yawH + 1.2) * 5;
      sm.position.set(x, footprintMin(x, z, yawH, 1.2, 0.6, 1) - 0.05, z);
      sm.rotation.y = yawH + 2.2;
      group.add(sm);
    }
  }
  // closing boards across the end of the run-out
  const se = T.length - 1.5, fe = frameAt(T, se), we = T.sAt(T.W, se);
  const eb = new MeshBuilder();
  const white = tint('#f3f5fa'), blue = tint(BLUE);
  for (let l = -we - 1; l < we + 1; l += 3) {
    const x = fe.x + fe.rx * (l + 1.5), z = fe.z + fe.rz * (l + 1.5);
    const y = Math.min(meshGround(fe.x + fe.rx * l, fe.z + fe.rz * l), meshGround(fe.x + fe.rx * (l + 3), fe.z + fe.rz * (l + 3)));
    eb.at(x, y, z, fe.heading + Math.PI / 2).box(0, 0.52, 0, 2.95, 1.04, 0.26, white, blue);
  }
  const em = new THREE.Mesh(eb.build(), vcMaterial({ roughness: 0.6 }));
  em.castShadow = true; em.receiveShadow = true;
  group.add(em);
}

// The big red FINISH portal: two clad towers and a deep beam spanning the piste, FINISH on both faces
// of the beam, SKI LEGACY down the towers, blue and white trim. Each tower stands on its own snow.
function finishPortal(course, s) {
  const T = course.track;
  const g = new THREE.Group();
  const f = frameAt(T, s);
  const w = T.sAt(T.W, s);
  const span = w + 2.4, TW = 1.6, BH = 2.6, BD = 1.8, clear = 8.6;
  const yL = meshGround(f.x - f.rx * span, f.z - f.rz * span), yR = meshGround(f.x + f.rx * span, f.z + f.rz * span);
  const yBeam = Math.max(yL, yR) + clear;
  const b = new MeshBuilder();
  const LC = lookOf(course).colors || {}, PC = LC.portal || RED;
  const red = tint(PC), redD = tint(PC).multiplyScalar(0.72), white = tint('#f4f6fa'), blue = tint(LC.portalBand || BLUE), dark = tint('#24272d');
  for (const [sx, y0] of [[-1, yL], [1, yR]]) {
    const x = f.x + f.rx * span * sx, z = f.z + f.rz * span * sx;
    const hgt = yBeam - y0 + 0.6;
    b.at(x, y0 - 0.6, z, f.heading);
    b.box(0, hgt / 2, 0, TW, hgt, TW, red, red);
    b.box(0, 0.6 + 0.14, 0, TW + 0.24, 0.28, TW + 0.24, dark); // plinth at the snow line
    b.box(0, hgt - BH - 0.1, 0, TW + 0.06, 0.16, TW + 0.06, white);
    for (const c of [-1, 1]) b.box(c * (TW / 2 + 0.01), hgt / 2, 0, 0.04, hgt - 0.4, 0.22, white); // white edge strips
  }
  // beam with a blue band along the bottom and white piping
  b.at(f.x, yBeam, f.z, f.heading);
  b.box(0, BH / 2, 0, 2 * span + TW, BH, BD, red, redD);
  b.box(0, 0.14, 0, 2 * span + TW + 0.04, 0.28, BD + 0.04, blue);
  b.box(0, BH - 0.06, 0, 2 * span + TW + 0.06, 0.12, BD + 0.06, white);
  const body = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.55, metalness: 0.05 }));
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  // FINISH lettering on both beam faces
  const tex = canvasTexture(2048, 256, (c, W, H) => {
    c.fillStyle = PC; c.fillRect(0, 0, W, H);
    c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `italic 700 190px ${FONT}`; c.fillText('FINISH', W / 2, H / 2 + 8);
    c.font = `italic 700 64px ${FONT}`;
    c.textAlign = 'left'; c.fillText('SKI LEGACY', 40, H / 2 + 4);
    c.textAlign = 'right'; c.fillText('WORLD RACING', W - 40, H / 2 + 4);
  });
  const fmat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xd9221c, roughness: 0.55 });
  const pw = Math.min(2 * span - 1, 26), ph = pw / 8;
  for (const sd of [-1, 1]) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(pw, Math.min(ph, BH - 0.5)), fmat);
    pl.position.set(f.x + f.tx * sd * (BD / 2 + 0.02), yBeam + 0.28 + (BH - 0.4) / 2, f.z + f.tz * sd * (BD / 2 + 0.02));
    pl.rotation.y = f.heading + (sd < 0 ? Math.PI : 0);
    g.add(pl);
  }
  // SKI LEGACY down the towers (faces up the course and toward the finish area)
  const vtex = canvasTexture(256, 1024, (c, W, H) => {
    c.fillStyle = PC; c.fillRect(0, 0, W, H);
    c.save(); c.translate(W / 2, H / 2); c.rotate(-Math.PI / 2);
    c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `italic 700 150px ${FONT}`;
    c.fillText('SKI LEGACY', 0, 6); c.restore();
  });
  const vmat = new THREE.MeshStandardMaterial({ map: vtex, color: vtex ? 0xffffff : 0xd9221c, roughness: 0.6 });
  for (const [sx, y0] of [[-1, yL], [1, yR]]) {
    const x = f.x + f.rx * span * sx, z = f.z + f.rz * span * sx;
    const hgt = yBeam - y0 - 1.0;
    for (const sd of [-1, 1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(TW - 0.3, hgt), vmat);
      pl.position.set(x + f.tx * sd * (TW / 2 + 0.02), y0 + 0.5 + hgt / 2, z + f.tz * sd * (TW / 2 + 0.02));
      pl.rotation.y = f.heading + (sd < 0 ? Math.PI : 0);
      g.add(pl);
    }
  }
  return g;
}

function proceduralGrandstand(st, yaw) {
  const g = new THREE.Group();
  const y0 = footprintMin(st.x, st.z, yaw, 11, 6.5) - 0.1;
  g.position.set(st.x, y0, st.z);
  g.rotation.y = yaw;
  const b = new MeshBuilder();
  const steel = tint('#454b55'), white = tint('#eef1f6'), blue = tint(BLUE), seat2 = tint('#2a63e8'), snow = tint('#f3f6fb'), roof = tint('#2b2f36'), red = tint(RED);
  const W = GS.W, rows = GS.rows, rise = GS.rise, depth = GS.depth;
  // tiers: the front row faces +z (toward the track)
  for (let r = 0; r < rows; r++) {
    const z = GS.z0 - r * depth, y = GS.y0 + r * rise;
    b.box(0, y - 0.12, z, 2 * W, 0.24, depth, white, snow);
    for (let x = -W + 0.4; x < W - 0.2; x += 0.55) b.box(x, y + 0.24, z - 0.12, 0.44, 0.1, 0.4, (Math.floor(x / 4) + r) % 2 ? blue : seat2);
  }
  for (let x = -W; x <= W + 0.01; x += W / 3) for (let r = 0; r < rows; r += 3) b.box(x, (GS.y0 + r * rise) / 2, GS.z0 - r * depth, 0.16, GS.y0 + r * rise, 0.16, steel);
  b.box(0, (GS.y0 + rows * rise + 2.6) / 2, GS.z0 - rows * depth - 0.2, 2 * W, GS.y0 + rows * rise + 2.6, 0.2, steel);
  for (const sx of [-1, 1]) b.box(sx * W, 2.4, GS.z0 - (rows * depth) / 2, 0.2, 4.6, rows * depth + 0.6, white);
  const roofY = GS.y0 + rows * rise + 2.6;
  b.box(0, roofY, GS.z0 - (rows * depth) / 2 + 0.6, 2 * W + 0.8, 0.22, rows * depth + 2.6, roof, snow);
  b.box(0, roofY + 0.2, GS.z0 - (rows * depth) / 2 + 0.6, 2 * W + 0.6, 0.2, rows * depth + 2.4, snow);
  for (const sx of [-1, 1]) for (const zz of [5.3, -2.0]) b.box(sx * (W - 0.4), roofY / 2, zz, 0.18, roofY, 0.18, steel);
  b.box(0, roofY - 0.45, GS.z0 - (rows * depth) / 2 + 1.9, 2 * W + 0.8, 0.6, 0.1, red);
  b.box(0, roofY - 0.78, GS.z0 - (rows * depth) / 2 + 1.9, 2 * W + 0.8, 0.08, 0.1, blue);
  const m = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.7, metalness: 0.1 }));
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return g;
}
// procedural grandstand dimensions (shared with the seated crowd)
const GS = { W: 10.5, rows: 7, rise: 0.48, depth: 0.85, z0: 4.2, y0: 0.5 };

function proceduralTimingBoard(tb, yaw, course) {
  const g = new THREE.Group();
  g.position.set(tb.x, footprintMin(tb.x, tb.z, yaw, 3.6, 0.8) - 0.1, tb.z);
  g.rotation.y = yaw;
  const W = 7, H = 3, legH = 3.2;
  const tex = canvasTexture(1024, 440, (c, w, h) => {
    c.fillStyle = '#07080b'; c.fillRect(0, 0, w, h);
    c.fillStyle = BLUE; c.fillRect(0, 0, w, 74);
    c.fillStyle = '#ffffff'; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = `italic 700 52px ${FONT}`; c.fillText(course.name.toUpperCase(), 28, 40);
    c.textAlign = 'right'; c.font = `italic 600 40px ${FONT}`; c.fillText('WORLD RACING', w - 28, 40);
    c.textAlign = 'left'; c.font = `700 64px ${FONT}`;
    const rows = [['PAR', '', fmt(course.par)], ['GOLD', '', fmt(course.medals.gold)], ['SILVER', '', fmt(course.medals.silver)], ['BRONZE', '', fmt(course.medals.bronze)]];
    rows.forEach((r, i) => {
      const y = 130 + i * 84;
      c.fillStyle = i === 0 ? '#ffc23a' : '#f2f4f8';
      c.fillText(r[0], 30, y); c.fillText(r[1], 220, y);
      c.textAlign = 'right'; c.fillStyle = '#ffd34d'; c.fillText(r[2], w - 30, y); c.textAlign = 'left';
    });
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x111111, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: tex ? 0.9 : 0, roughness: 0.4 }));
  face.position.set(0, legH + H / 2, 0.16);
  const b = new MeshBuilder();
  const frame = tint('#1d2026'), steel = tint('#4a505a');
  b.box(0, legH + H / 2, 0, W + 0.3, H + 0.3, 0.3, frame);
  for (const sx of [-1, 1]) b.box(sx * (W / 2 - 0.6), legH / 2 - 0.3, -0.05, 0.3, legH + 0.6, 0.3, steel);
  b.box(0, legH - 0.1, -0.05, W - 0.6, 0.2, 0.25, steel);
  const body = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.5, metalness: 0.4 }));
  g.add(body, face);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

function patrolHut(h, yaw) {
  const g = new THREE.Group();
  g.position.set(h.x, footprintMin(h.x, h.z, yaw, 2.4, 2.2) - 0.08, h.z);
  g.rotation.y = yaw;
  const b = new MeshBuilder();
  const red = tint('#b3241d'), redD = tint('#8f1c17'), white = tint('#f1f3f7'), roof = tint('#2c2f35'), snow = tint('#f3f6fb'), glass = tint('#1c2a38');
  const W = 2.2, D = 2.0, Hh = 2.7;
  for (let x = -W; x < W - 0.01; x += 0.22) b.box(x + 0.11, Hh / 2, D, 0.21, Hh, 0.12, Math.round(x / 0.22) % 2 ? red : redD);
  for (let x = -W; x < W - 0.01; x += 0.22) b.box(x + 0.11, Hh / 2, -D, 0.21, Hh, 0.12, Math.round(x / 0.22) % 2 ? red : redD);
  for (const sx of [-1, 1]) b.box(sx * W, Hh / 2, 0, 0.12, Hh, 2 * D, red);
  b.box(-0.9, 1.0, D + 0.07, 0.95, 2.0, 0.06, white);
  b.box(0.95, 1.6, D + 0.07, 1.1, 0.8, 0.05, glass);
  for (const sx of [-1, 1]) {
    const save = b.m.clone();
    const rm = new THREE.Matrix4().compose(new THREE.Vector3(sx * (W / 2 + 0.1), Hh + 0.62, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -sx * 0.52)), new THREE.Vector3(1, 1, 1));
    b.setMatrix(save.clone().multiply(rm));
    b.box(0, 0, 0, W + 0.9, 0.16, 2 * D + 0.8, roof);
    b.box(0, 0.17, 0, W + 0.8, 0.2, 2 * D + 0.7, snow);
    b.setMatrix(save);
  }
  for (const sz of [-1, 1]) for (let k = 0; k < 5; k++) b.box(0, Hh + 0.12 + k * 0.24, sz * D, 2 * W - k * 0.82, 0.24, 0.12, red);
  const m = new THREE.Mesh(b.build(), vcMaterial({ roughness: 0.8 }));
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  const tex = canvasTexture(768, 192, (c, w, hh) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, hh);
    c.fillStyle = '#b3241d'; c.fillRect(0, 0, w, 18); c.fillRect(0, hh - 18, w, 18);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `italic 700 104px ${FONT}`;
    c.fillText('SKI PATROL', w / 2, hh / 2 + 3);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.6 }));
  sign.position.set(0, Hh + 0.05, D + 0.09);
  g.add(sign);
  return g;
}

// ------------------------------------------------------------------ spectators
// Simple low-poly fans: a jacket (coloured per instance) + legs, head and beanie (shared colours).
// Standing rows behind the finish boards and the lower finish slope, seated fans on procedural stands.
function fanGeometries() {
  const jacket = new MeshBuilder(), rest = new MeshBuilder();
  const W = new THREE.Color(1, 1, 1);
  jacket.box(0, 1.12, 0, 0.44, 0.62, 0.26, W);
  for (const sx of [-1, 1]) jacket.at(sx * 0.27, 1.38, 0.02, 0, 0, sx * 0.12).box(0, -0.27, 0, 0.11, 0.56, 0.13, W);
  const pants = tint('#20242c'), skin = tint('#e2b796'), hat = tint('#eef0f4'), pom = tint('#d9221c');
  for (const sx of [-1, 1]) rest.box(sx * 0.11, 0.41, 0.01, 0.16, 0.82, 0.2, pants);
  rest.at(0, 1.43, 0).cyl(0, 0, 0, 0.11, 0.105, 0.24, 7, skin, { top: false });
  rest.at(0, 1.64, 0).cyl(0, 0, 0, 0.115, 0.05, 0.13, 7, hat, { colTop: hat });
  rest.at(0, 1.77, 0).cyl(0, 0, 0, 0.04, 0.0, 0.05, 5, pom);
  return { jacket: jacket.build(), rest: rest.build() };
}
const JACKETS = ['#d9221c', '#1546c8', '#f4f6fa', '#1d2533', '#ff8a1c', '#2c9b5a', '#f2c230', '#7b2fbf', '#e8467c', '#3fa9f5'];
function buildCrowd(course, models, group) {
  const T = course.track, A = course.arena, fs = course.finishS;
  const rnd = mulberry32(course.def.seed + 919);
  const spots = []; // { x, y, z, yaw }
  // standing rows behind the boards along the finish straight and the bottom of the finish slope
  for (const sd of [-1, 1]) {
    for (let s = fs - 150; s < Math.min(T.length - 20, fs + 70); s += 0.75) {
      if (rnd() < 0.3) continue; // gaps between groups
      const w = T.sAt(T.W, s);
      // behind the finish-area boards only (never inside the net zone), clear of the portal towers
      if (T.codeAt(T.BAR[sd > 0 ? 1 : 0], s) !== BARRIER.arena || Math.abs(s - fs) < 3) continue;
      for (const row of [1.5, 2.35, 3.2]) {
        if (row > 2 && rnd() < 0.45) continue;
        const lat = sd * (w + row + (rnd() - 0.5) * 0.3);
        const p = T.pointAt(s + (rnd() - 0.5) * 0.3, lat);
        if (nearStructure(course, p.x, p.z)) continue;
        // only on level-ish snow beside the course
        const y = meshGround(p.x, p.z);
        if (Math.abs(meshGround(p.x + 0.6, p.z) - y) > 0.4 || Math.abs(meshGround(p.x, p.z + 0.6) - y) > 0.4) continue;
        spots.push({ x: p.x, y, z: p.z, yaw: p.heading + (sd > 0 ? -Math.PI / 2 : Math.PI / 2) + (rnd() - 0.5) * 0.6 });
      }
    }
  }
  // fans lining the lower course behind the B-nets (courses whose look asks for it: night race, World Cup)
  const along = lookOf(course).crowdAlong || 0;
  if (along > 0) {
    for (const sd of [-1, 1]) {
      const side = sd > 0 ? 1 : 0;
      for (let s = Math.max(80, fs - 150 - along); s < fs - 150; s += 0.8) {
        if (rnd() < 0.42) continue; // groups with gaps
        if (T.codeAt(T.BAR[side], s) !== BARRIER.bnet || T.codeAt(T.AN[side], s)) continue; // behind B-nets only, never by an A-net
        const w = T.sAt(T.W, s);
        for (const row of [1.9, 2.75]) {
          if (row > 2 && rnd() < 0.55) continue;
          const lat = sd * (w + row + (rnd() - 0.5) * 0.25);
          const p = T.pointAt(s + (rnd() - 0.5) * 0.3, lat);
          if (nearStructure(course, p.x, p.z)) continue;
          const y = meshGround(p.x, p.z);
          if (Math.abs(meshGround(p.x + 0.6, p.z) - y) > 0.4 || Math.abs(meshGround(p.x, p.z + 0.6) - y) > 0.4) continue;
          spots.push({ x: p.x, y, z: p.z, yaw: p.heading + (sd > 0 ? -Math.PI / 2 : Math.PI / 2) + (rnd() - 0.5) * 0.6 });
        }
      }
    }
  }
  // seated fans on the procedural grandstands
  if (!models.grandstand) {
    for (const st of [A.grandstand, A.grandstand2]) {
      const yaw = st.heading - Math.PI / 2;
      const y0 = footprintMin(st.x, st.z, yaw, 11, 6.5) - 0.1;
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      for (let r = 0; r < GS.rows; r++) {
        const lz = GS.z0 - r * GS.depth + 0.02, ly = GS.y0 + r * GS.rise - 0.47;
        for (let lx = -GS.W + 0.4; lx < GS.W - 0.2; lx += 0.55) {
          if (rnd() < 0.22) continue;
          spots.push({ x: st.x + lx * c + lz * sn, y: y0 + ly, z: st.z - lx * sn + lz * c, yaw: yaw + (rnd() - 0.5) * 0.25 });
        }
      }
    }
  }
  if (!spots.length) return;
  const geo = fanGeometries();
  const jm = new THREE.InstancedMesh(geo.jacket, new THREE.MeshStandardMaterial({ roughness: 0.75 }), spots.length);
  const rm = new THREE.InstancedMesh(geo.rest, vcMaterial({ roughness: 0.8 }), spots.length);
  const d = new THREE.Object3D(), col = new THREE.Color();
  spots.forEach((sp, k) => {
    d.position.set(sp.x, sp.y - 0.02, sp.z);
    d.rotation.set(0, sp.yaw, 0);
    const sc = 0.92 + rnd() * 0.14;
    d.scale.set(sc, sc, sc);
    d.updateMatrix();
    jm.setMatrixAt(k, d.matrix); rm.setMatrixAt(k, d.matrix);
    jm.setColorAt(k, col.set(JACKETS[Math.floor(rnd() * JACKETS.length)]));
  });
  for (const m of [jm, rm]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); group.add(m); }
  group.userData.crowd = spots.length;
}
function nearStructure(course, x, z) {
  for (const f of course.flats) {
    const dx = x - f.x, dz = z - f.z;
    const lx = Math.abs(dx * f.cos + dz * f.sin), lz = Math.abs(-dx * f.sin + dz * f.cos);
    if (lx < f.hw + 1 && lz < f.hd + 1) return true;
  }
  return false;
}

// ------------------------------------------------------------------ flags (one instanced, waving)
function flagAtlas(course) {
  const own = lookOf(course).colors?.flags;
  const designs = own ? own.map(([bg, fg, text]) => ({ bg, fg, text })) : [
    { bg: '#1546c8', fg: '#ffffff', text: 'SKI LEGACY' },
    { bg: '#ffffff', fg: '#1546c8', text: 'WORLD RACING' },
    { bg: '#d9221c', fg: '#ffffff', text: 'SKI LEGACY' },
    { bg: '#1d2533', fg: '#ffffff', text: 'LEGACY' },
  ];
  return canvasTexture(1024, 512, (g, W, H) => {
    designs.forEach((d, i) => {
      const x = (i % 2) * (W / 2), y = Math.floor(i / 2) * (H / 2), w = W / 2, h = H / 2;
      g.fillStyle = d.bg; g.fillRect(x, y, w, h);
      g.fillStyle = d.fg; g.globalAlpha = 0.9;
      g.fillRect(x, y + h * 0.78, w, h * 0.07);
      g.globalAlpha = 1;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      let fs = 74; g.font = `italic 700 ${fs}px ${FONT}`;
      while (g.measureText(d.text).width > w * 0.82 && fs > 20) { fs -= 4; g.font = `italic 700 ${fs}px ${FONT}`; }
      g.fillText(d.text, x + w / 2, y + h * 0.45);
    });
  });
}

function buildFlags(course, group) {
  const T = course.track;
  const spots = [];
  const rnd = mulberry32(course.def.seed + 33);
  // a row behind the start house, on the plateau beyond the start of the line
  const p0 = T.pointAt(0, 0), tx = Math.sin(p0.heading), tz = Math.cos(p0.heading);
  for (let k = 0; k < 3; k++) {
    const q = T.pointAt(0, (k - 1) * 3.4);
    spots.push({ x: q.x - tx * 4, z: q.z - tz * 4, d: k % 4 });
  }
  // along both sides of the finish arena, behind the spectators
  const fs = course.finishS;
  for (let k = 0; k < 6; k++) { // (a few: no flag forest)
    const s = fs - 100 + k * 32;
    if (s > T.length - 10) break;
    const w = T.sAt(T.W, s);
    const p = T.pointAt(s, (w + 4.4) * (k % 2 ? 1 : -1));
    if (nearStructure(course, p.x, p.z)) continue;
    spots.push({ x: p.x, z: p.z, d: (k + 1) % 4 });
  }
  const n = spots.length;
  const cloth = new THREE.PlaneGeometry(1.8, 1.1, 14, 6);
  cloth.translate(0.9, 0, 0); // attached at the left edge (the pole)
  const tex = flagAtlas(course);
  const mat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x1546c8, roughness: 0.75, side: THREE.DoubleSide });
  const time = { value: 0 };
  mat.onBeforeCompile = (s) => {
    s.uniforms.uTime = time;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute vec2 aFlag;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = vec2((aFlag.x - 2.0 * floor(aFlag.x / 2.0)) * 0.5, floor(aFlag.x / 2.0) * -0.5 + 0.5) + vMapUv * 0.5;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float fx = clamp(position.x / 1.8, 0.0, 1.0);
        float wave = sin(position.x * 3.1 - uTime * 4.2 + aFlag.y) * 0.5 + sin(position.x * 5.3 - uTime * 6.1 + aFlag.y * 1.7) * 0.22;
        transformed.z += wave * 0.16 * fx;
        transformed.y -= fx * fx * 0.08;`);
  };
  mat.customProgramCacheKey = () => 'parkour-flag';
  const flags = new THREE.InstancedMesh(cloth, mat, n);
  const aFlag = new Float32Array(n * 2);
  const poles = new MeshBuilder();
  const white = tint('#eef1f5'), ball = tint('#c9ced6');
  const d = new THREE.Object3D();
  const PH = 7;
  spots.forEach((sp, i) => {
    const y = meshGround(sp.x, sp.z);
    poles.at(sp.x, y - 0.5, sp.z).cyl(0, 0, 0, 0.05, 0.035, PH + 0.5, 8, white);
    poles.at(sp.x, y + PH, sp.z).cyl(0, 0, 0, 0.07, 0.0, 0.12, 8, ball);
    d.position.set(sp.x, y + PH - 0.7, sp.z);
    d.rotation.set(0, rnd() * 0.6 - 0.3 + Math.PI * 0.25, 0);
    d.updateMatrix();
    flags.setMatrixAt(i, d.matrix);
    aFlag[i * 2] = sp.d; aFlag[i * 2 + 1] = rnd() * 6.28;
  });
  cloth.setAttribute('aFlag', new THREE.InstancedBufferAttribute(aFlag, 2));
  flags.castShadow = true; flags.receiveShadow = true;
  flags.computeBoundingSphere();
  flags.onBeforeRender = () => { time.value = performance.now() / 1000; };
  group.add(flags);
  const pm = new THREE.Mesh(poles.build(), vcMaterial({ roughness: 0.3, metalness: 0.5 }));
  pm.castShadow = true; pm.receiveShadow = true;
  group.add(pm);
}

// ------------------------------------------------------------------ feature signs (text only)
// Raised above the B-net on two posts, just outside it, on a side without an A-net.
function buildSigns(course, group) {
  const T = course.track;
  const items = [];
  const label = { tunnel: 'TUNNEL', bridge: 'BRIDGE', lake: 'FROZEN LAKE · ICE', kicker: 'JUMP', tabletop: 'JUMP', narrow: 'NARROW', cliff: 'CLIFF', slalom: 'GATES' };
  const seen = new Set();
  for (const f of course.features) {
    if (!label[f.type]) continue;
    const s = f.s0 - 70;
    if (s < 60) continue;
    const key = f.type + Math.round(s / 150);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ s, text: label[f.type], warn: f.type === 'lake' || f.type === 'cliff' || f.type === 'narrow' });
  }
  let inIce = false;
  for (let s = 0; s < course.length; s += 10) {
    const fr = course.frictionAt(s);
    if (fr < 0.8 && !inIce && s > 80 && !course.features.some((f) => f.type === 'lake' && Math.abs(f.s0 - s) < 120)) items.push({ s: s - 50, text: 'ICE', warn: true });
    inIce = fr < 0.8;
  }
  for (const it of items) {
    const w = T.sAt(T.W, it.s);
    const lats = [];
    for (const sd of [1, -1]) if (!T.codeAt(T.AN[sd > 0 ? 1 : 0], it.s) && T.codeAt(T.BAR[sd > 0 ? 1 : 0], it.s) === BARRIER.bnet) lats.push(sd * (w + 1.9));
    const p = gentleSpot(T, it.s, lats, 1.3, 0.3, 0.6);
    if (!p) continue; // canyon walls / cliffs / A-nets: no room for a sign
    const tex = bannerTexture(it.text, { w: 768, h: 256, bg: it.warn ? '#ffd21f' : '#ffffff', fg: it.warn ? '#141414' : BLUE, stripe: it.warn ? '#141414' : BLUE, stripe2: it.warn ? '' : '#e2231a', size: 0.6 });
    const board = signBoard(tex, 2.4, 0.8, 2.15);
    board.position.set(p.x, p.ground - 0.08, p.z);
    board.rotation.y = p.heading + Math.PI; // faces the oncoming racers
    group.add(board);
  }
}

// ------------------------------------------------------------------ decor (Meshy props near the arenas)
function buildDecor(course, models, group) {
  const T = course.track;
  const rnd = mulberry32(course.def.seed + 71);
  const put = (name, s, lat, size, axis = 'y', yawOff = 0, r = 0) => {
    if (!models[name]) return;
    const p = gentleSpot(T, s, [lat], size * 0.35, size * 0.35, 0.45);
    if (!p) return;
    if (r) course.solids?.push({ x: p.x, z: p.z, r });
    const m = shareModel(fitModel(models[name], { size, axis }));
    m.position.set(p.x, p.ground - 0.05, p.z);
    m.rotation.y = p.heading + yawOff;
    group.add(m);
  };
  // lamp posts behind the crowd at the finish, snow cannons between the nets along the course
  const fs = course.finishS;
  for (let k = 0; k < 4; k++) {
    const s = fs - 40 + k * 30;
    const w = T.sAt(T.W, s);
    put('lamp_post', s, (k % 2 ? 1 : -1) * (w + 5.4), 4.2, 'y', 0, 0.25);
  }
  for (let s = 400 + rnd() * 300; s < course.length - 300; s += 600 + rnd() * 400) {
    const w = T.sAt(T.W, s);
    const side = rnd() < 0.5 ? -1 : 1, sd = side > 0 ? 1 : 0;
    if (course.features.some((f) => s > f.s0 - 40 && s < (f.s1 ?? f.s0) + 40)) continue;
    if (T.codeAt(T.AN[sd], s) || T.codeAt(T.BAR[sd], s) !== BARRIER.bnet) continue;
    put('snow_cannon', s, side * (w + 2.6), 2.4, 'y', side * 1.2, 1.0);
  }
}
