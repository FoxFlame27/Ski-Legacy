// Legacy Park: a terrain park on the upper Legacy Valley, a short walk below the village. A jump line
// (S / M / L kickers and a tabletop, each with a clear landing zone) and a beginner roller line run
// side by side down a groomed, fenced corridor that is served by the Park Lift.
// Where the park is (its corridor, features and lift) is part of the resort layout (layout.js
// registers it in initLayout, before any terrain is built); this module builds its meshes.
import * as THREE from 'three';
import { world } from './world.js';
import { layout } from './layout.js';
import { makeRamp, disposeRamp } from './ramps.js';
import { buildNetRuns, mergeParts, SIGN_FONT, PISTE_COLORS } from './resortdressing.js';

const HAS_DOM = typeof document !== 'undefined';
const HOUSE_BLUE = '#1546c8';

function canvasTex(w, h, draw) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const paint = () => { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); draw(g, w, h); };
  paint();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const probe = `italic 700 40px ${SIGN_FONT}`;
  if (document.fonts && !document.fonts.check(probe)) document.fonts.load(probe).then(() => { paint(); t.needsUpdate = true; }).catch(() => {});
  return t;
}

// banner in the game's house style: white cloth, blue italic condensed lettering, red and blue stripes
function drawBanner(g, w, h) {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.fillStyle = HOUSE_BLUE; g.fillRect(0, 0, w, h * 0.035); // hem
  g.fillStyle = HOUSE_BLUE; g.fillRect(0, h - h * 0.11, w, h * 0.11);
  g.fillStyle = '#e2231a'; g.fillRect(0, h - h * 0.16, w, h * 0.05);
  g.fillStyle = HOUSE_BLUE; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `italic 700 ${Math.round(h * 0.6)}px ${SIGN_FONT}`;
  g.fillText('LEGACY PARK', w / 2, h * 0.43);
  // grommets
  g.fillStyle = '#9aa3ad';
  for (const x of [h * 0.12, w - h * 0.12]) for (const y of [h * 0.12, h * 0.88]) { g.beginPath(); g.arc(x, y, h * 0.035, 0, 7); g.fill(); }
}
// line boards (JUMP LINE with its S / M / L sizes, ROLLER LINE) and the square size plates
function drawLaneBoard(g, w, h, title, chips) {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.strokeStyle = HOUSE_BLUE; g.lineWidth = 8; g.strokeRect(6, 6, w - 12, h - 12);
  g.fillStyle = HOUSE_BLUE; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.font = `italic 700 ${Math.round(h * 0.42)}px ${SIGN_FONT}`;
  g.fillText(title, h * 0.3, h * 0.5);
  let x = w - h * 0.25;
  for (const [txt, col] of chips.slice().reverse()) {
    const s = h * 0.56;
    x -= s;
    g.fillStyle = col; g.fillRect(x, (h - s) / 2, s, s);
    g.fillStyle = '#ffffff'; g.textAlign = 'center';
    g.font = `700 ${Math.round(s * 0.72)}px ${SIGN_FONT}`;
    g.fillText(txt, x + s / 2, h / 2 + 1);
    x -= h * 0.12;
  }
}
function drawSizePlate(g, w, h, txt, col) {
  g.fillStyle = col; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffffff'; g.lineWidth = 10; g.strokeRect(10, 10, w - 20, h - 20);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${Math.round(h * 0.7)}px ${SIGN_FONT}`;
  g.fillText(txt, w / 2, h / 2 + 4);
}

// size colours of the S / M / L kickers (as the piste grades: green, blue, black)
const sizeColor = (s) => PISTE_COLORS[{ S: 0, M: 1, L: 3 }[s]];

/**
 * Build Legacy Park: the features (kickers, tabletops, rollers — rideable surfaces via makeRamp),
 * B-net fences down both sides, the entry banner and line boards.
 * @returns {THREE.Group} added to the scene; group.userData = { colliders, ramps, plan }
 */
export function buildPark(scene, models = {}) {
  const p = layout.park;
  const group = new THREE.Group();
  group.name = 'legacy-park';
  if (!p) { console.warn('buildPark: call initLayout() first'); scene?.add(group); return group; }
  const colliders = [];
  const ramps = [];
  for (const f of p.features) {
    const r = makeRamp({ x: f.x, z: f.z, heading: p.heading, type: f.type, height: f.height, lip: f.lip, width: f.width, length: f.length, deckLength: f.deckLength, shaped: true });
    r.mesh.name = `park-${f.type}${f.size ? '-' + f.size : ''}`;
    group.add(r.mesh);
    ramps.push(r);
  }

  // fences: B-nets just outside the groomed corridor, open at the drop-in and the outrun (each point
  // carries the unit vector toward the park, so the nets lean in and their drifts bank on the park side)
  const runs = [];
  for (const side of [-1, 1]) {
    const line = [];
    for (let s = 4; s <= p.length - 12; s += 2) { const q = p.at(s, side * (p.halfWidth + 1.2)); line.push([q.x, q.z, -side * p.rx, -side * p.rz]); }
    runs.push({ type: 'B', line, owner: 'Legacy Park' });
  }
  const nets = buildNetRuns(runs);
  group.add(nets.group);
  colliders.push(...nets.colliders);

  // signs and banner: every part is baked into world space and merged per material (4 draw calls)
  const parts = { wood: [], steel: [], cloth: [], print: [] };
  const yaw = p.heading + Math.PI; // signs face up the park, toward riders dropping in
  const frame = (s, lat, sink = 0.15) => {
    const q = p.at(s, lat);
    return { q, m: new THREE.Matrix4().compose(new THREE.Vector3(q.x, world.height(q.x, q.z) - sink, q.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)) };
  };
  const put = (list, geo, x, y, z, base, rx = 0, ry = 0, rz = 0) => {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z));
    geo.applyMatrix4(base);
    list.push(geo);
  };

  // entry banner across the drop-in, on two steel masts with tension lines
  {
    const bw = 8.4, bh = 1.25, mastH = 4.7, span = p.halfWidth - 3.2, by = mastH - 0.25 - bh / 2;
    const { m } = frame(-6, 0, 0.3);
    put(parts.cloth, new THREE.PlaneGeometry(bw, bh), 0, by, 0, m);
    // a second sheet turned round, so the banner also reads correctly from below
    put(parts.cloth, new THREE.PlaneGeometry(bw, bh), 0, by, -0.012, m, 0, Math.PI, 0);
    for (const sx of [-1, 1]) {
      put(parts.steel, new THREE.CylinderGeometry(0.07, 0.085, mastH, 12), sx * span, mastH / 2, -0.06, m);
      put(parts.steel, new THREE.SphereGeometry(0.1, 12, 8), sx * span, mastH + 0.04, -0.06, m);
      const len = span - bw / 2;
      for (const y of [by + bh / 2 - 0.05, by - bh / 2 + 0.05]) put(parts.steel, new THREE.CylinderGeometry(0.008, 0.008, len, 4), sx * (bw / 2 + len / 2), y, -0.03, m, 0, 0, Math.PI / 2);
      const q = p.at(-6, sx * span);
      colliders.push({ x: q.x, z: q.z, r: 0.2 });
    }
  }

  // line boards at the top of each line, size plates beside each kicker's run-in.
  // One 1024 x 512 canvas: two 8:1 line boards on top, three square size plates below.
  const quad = (w, h, u0, v0, u1, v1) => {
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    return geo;
  };
  // a printed face on a wooden backing board, on one or two posts
  const board = (face, w, h, postH, m) => {
    put(parts.print, face, 0, postH + h / 2, 0.026, m);
    put(parts.wood, new THREE.BoxGeometry(w + 0.06, h + 0.06, 0.045), 0, postH + h / 2, 0, m);
    for (const sx of (w > 1 ? [-1, 1] : [0])) put(parts.wood, new THREE.BoxGeometry(0.09, postH + h, 0.09), sx * (w / 2 - 0.15), (postH + h) / 2 - 0.1, -0.06, m);
  };
  // each line's board stands just outside its line, where riders pick their line at the drop-in
  const jump = p.features.find((f) => f.line === 'jump'), roll = p.features.find((f) => f.line === 'roll');
  for (const [lat, v0, v1] of [[jump.lat - 7.5, 0.75, 1], [roll.lat + 5, 0.5, 0.75]]) {
    const { q, m } = frame(6, lat);
    board(quad(2.4, 0.3, 0, v0, 1, v1), 2.4, 0.3, 1.15, m);
    colliders.push({ x: q.x, z: q.z, hw: 1.2, hd: 0.2, rot: -yaw });
  }
  // size plates: 0.5 m squares on a stake, 14 m above each kicker, on the outside of the line
  for (const f of p.features) {
    if (f.type !== 'kicker') continue;
    const i = ['S', 'M', 'L'].indexOf(f.size);
    const u0 = (i * 248) / 1024, u1 = u0 + 240 / 1024;
    const { q, m } = frame(f.s - 14, f.lat - f.width / 2 - 1.6);
    board(quad(0.5, 0.5, u0, 1 - 504 / 512, u1, 1 - 264 / 512), 0.5, 0.5, 0.85, m);
    colliders.push({ x: q.x, z: q.z, r: 0.25 });
  }

  const bannerTex = canvasTex(1024, 152, drawBanner);
  const boardTex = canvasTex(1024, 512, (g) => {
    drawLaneBoard(g, 1024, 128, 'JUMP LINE', ['S', 'M', 'L'].map((t) => [t, sizeColor(t)]));
    g.save(); g.translate(0, 128); drawLaneBoard(g, 1024, 128, 'ROLLER LINE', []); g.restore();
    ['S', 'M', 'L'].forEach((t, i) => { g.save(); g.translate(i * 248, 264); drawSizePlate(g, 240, 240, t, sizeColor(t)); g.restore(); });
  });
  const mats = {
    wood: new THREE.MeshStandardMaterial({ color: 0x3a2716, roughness: 0.85 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.45, metalness: 0.6 }),
    cloth: new THREE.MeshStandardMaterial({ map: bannerTex, color: bannerTex ? 0xffffff : 0xf2f2f2, roughness: 0.9 }),
    print: new THREE.MeshStandardMaterial({ map: boardTex, color: boardTex ? 0xffffff : 0xdddddd, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
  };
  for (const [k, list] of Object.entries(parts)) {
    const mesh = mergeParts(list, mats[k], { cast: k !== 'cloth' });
    if (mesh) { mesh.name = `park-${k}`; group.add(mesh); }
  }

  group.userData = { colliders, ramps, plan: p };
  scene?.add(group);
  return group;
}

// Remove the park's meshes and walkable surfaces (e.g. when rebuilding).
export function disposePark(group) {
  for (const r of group.userData.ramps || []) disposeRamp(r);
  group.parent?.remove(group);
}
