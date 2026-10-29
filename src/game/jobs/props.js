// Job props, all procedural and real-world sized: the wooden job board (the only permanent prop jobs
// add to the world), cargo packs worn on the skier's back, lost items lying in the snow with a faint
// glint, a pair of skis crossed upright in the snow (the real "skier down" signal), and a simple
// stand-in figure for when a character model is missing.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from '../../world/world.js';
import { fitModel, dequantize } from '../../core/assets.js';

const HAS_DOM = typeof document !== 'undefined';
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

// Height of the rendered terrain mesh (2 m triangles near the player), so small items rest on the
// visible snow instead of hovering over or sinking into it between grid vertices.
const STEP = 2;
export function meshY(x, z) {
  const gx = Math.floor(x / STEP), gz = Math.floor(z / STEP);
  const u = x / STEP - gx, v = z / STEP - gz;
  const a = world.height(gx * STEP, gz * STEP);
  const b = world.height((gx + 1) * STEP, gz * STEP);
  const c = world.height(gx * STEP, (gz + 1) * STEP);
  if (u + v < 1) return a + (b - a) * u + (c - a) * v;
  const d = world.height((gx + 1) * STEP, (gz + 1) * STEP);
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

// A primitive baked into place with a flat vertex colour (merged into one draw call later).
function part(geo, color, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  _c.set(color);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
function merged(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ job board
const WOOD = '#6b4a2e', WOOD_DARK = '#3a2818', ROOF = '#4a3220', SNOW = '#eef3f9';
export const BOARD = { w: 1.62, faceW: 1.5, faceH: 0.98, faceY: 1.585, halfW: 0.99, depth: 0.42 };

// Notice-board face: dark planks, a big "JOBS" header and three pinned paper notes.
function drawBoardFace(g, W, H) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#3b2717';
  g.fillRect(0, 0, W, H);
  // vertical planks with a little tone variation, gaps and grain
  const pw = W / 8;
  for (let i = 0; i < 8; i++) {
    const v = 50 + rnd() * 14;
    g.fillStyle = `rgb(${v + 12},${v - 6},${v - 26})`;
    g.fillRect(i * pw + 2, 0, pw - 4, H);
    g.strokeStyle = 'rgba(20,10,4,0.35)';
    g.lineWidth = 2;
    for (let k = 0; k < 7; k++) {
      const x = i * pw + 8 + rnd() * (pw - 16);
      g.beginPath(); g.moveTo(x, 0);
      g.bezierCurveTo(x + rnd() * 10 - 5, H * 0.33, x + rnd() * 10 - 5, H * 0.66, x + rnd() * 8 - 4, H);
      g.stroke();
    }
  }
  // header
  g.fillStyle = '#f3e3c2';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 128px Georgia, "Times New Roman", serif';
  if ('letterSpacing' in g) g.letterSpacing = '14px';
  g.fillText('JOBS', W / 2 + 7, 104);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  g.fillStyle = '#c9a36a';
  g.fillRect(W / 2 - 230, 172, 460, 4);
  g.fillStyle = '#e2d2b0';
  g.font = '600 31px Georgia, "Times New Roman", serif';
  g.fillText('Odd jobs around the mountain · paid on completion', W / 2, 210);
  // three pinned notes
  const notes = [
    { head: 'DELIVERIES', lines: ['Huts & lift crews', 'Mail to the village', 'Parcels, spare parts'], pin: '#c0392b', rot: -0.035 },
    { head: 'SKI PATROL', lines: ['Skier down?', 'Akja to the patrol', 'Stuck in deep snow'], pin: '#2e6bd1', rot: 0.022 },
    { head: 'GUESTS', lines: ['Guide a guest', 'to the huts', 'Quick & safe: tips'], pin: '#2f9d58', rot: -0.014 },
  ];
  const nw = 276, nh = 372, top = 252;
  notes.forEach((n, i) => {
    const cx = W / 2 + (i - 1) * 318, cy = top + nh / 2;
    g.save();
    g.translate(cx, cy); g.rotate(n.rot);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(-nw / 2 + 6, -nh / 2 + 8, nw, nh);
    g.fillStyle = '#f2ead6';
    g.fillRect(-nw / 2, -nh / 2, nw, nh);
    g.fillStyle = '#2b2118';
    g.font = 'bold 36px Georgia, "Times New Roman", serif';
    g.fillText(n.head, 0, -nh / 2 + 72);
    g.fillStyle = '#c9b48c';
    g.fillRect(-nw / 2 + 34, -nh / 2 + 104, nw - 68, 3);
    g.fillStyle = '#3d3226';
    g.font = 'italic 29px Georgia, "Times New Roman", serif';
    n.lines.forEach((ln, k) => g.fillText(ln, 0, -nh / 2 + 152 + k * 50));
    g.fillStyle = '#7a1f12';
    g.font = 'bold 32px Georgia, "Times New Roman", serif';
    g.fillText(i === 1 ? '$500 - 2,200' : i === 0 ? '$200 - 1,300' : '$400 - 1,600', 0, nh / 2 - 46); // (the pay ranges in catalog.js)
    // pin
    g.fillStyle = n.pin;
    g.beginPath(); g.arc(0, -nh / 2 + 20, 13, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.arc(-4, -nh / 2 + 16, 4, 0, Math.PI * 2); g.fill();
    g.restore();
  });
}

let boardShared = null;
export function boardAssets() {
  if (boardShared) return boardShared;
  // wood frame, posts and a small snow-capped gable roof (one draw call)
  const parts = [];
  const postL = 2.85; // 0.45 m of each post is in the snow
  for (const sx of [-1, 1]) parts.push(part(new THREE.BoxGeometry(0.11, postL, 0.11), WOOD, sx * 0.72, postL / 2 - 0.45, -0.03));
  parts.push(part(new THREE.BoxGeometry(BOARD.w, 1.08, 0.05), WOOD_DARK, 0, BOARD.faceY, 0));
  parts.push(part(new THREE.BoxGeometry(1.72, 0.08, 0.09), WOOD, 0, BOARD.faceY + 0.55, 0.012));
  parts.push(part(new THREE.BoxGeometry(1.72, 0.08, 0.09), WOOD, 0, BOARD.faceY - 0.55, 0.012));
  for (const sx of [-1, 1]) parts.push(part(new THREE.BoxGeometry(0.07, 1.16, 0.09), WOOD, sx * 0.83, BOARD.faceY, 0.012));
  const pitch = 0.42, ridgeY = 2.47;
  for (const s of [-1, 1]) {
    // plank sloping down toward the front (s = 1) or the back (s = -1)
    const cz = s * 0.19 * Math.cos(pitch), cy = ridgeY - 0.19 * Math.sin(pitch);
    parts.push(part(new THREE.BoxGeometry(1.98, 0.035, 0.42), ROOF, 0, cy, cz, s * pitch));
    parts.push(part(new THREE.BoxGeometry(1.9, 0.05, 0.36), SNOW, 0, cy + 0.04 * Math.cos(pitch), cz + s * 0.04 * Math.sin(pitch) - s * 0.01, s * pitch));
  }
  parts.push(part(new THREE.BoxGeometry(2.0, 0.06, 0.06), ROOF, 0, ridgeY, 0));
  // little shelf under the notes
  parts.push(part(new THREE.BoxGeometry(1.5, 0.03, 0.12), WOOD, 0, BOARD.faceY - 0.6, 0.07));
  const frame = merged(parts);
  const frameMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });

  let tex = null;
  if (HAS_DOM) {
    try {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = Math.round((1024 * BOARD.faceH) / BOARD.faceW);
      const g = c.getContext('2d');
      if (g) {
        drawBoardFace(g, c.width, c.height);
        tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 16;
      }
    } catch { tex = null; }
  }
  // printed face; glows faintly at night like the village signs (emissiveIntensity set by Jobs.update)
  const faceMat = new THREE.MeshStandardMaterial({
    map: tex, emissiveMap: tex, emissive: tex ? 0xffffff : 0x000000, emissiveIntensity: 0,
    color: tex ? 0xffffff : 0x8a7350, roughness: 0.8, metalness: 0,
  });
  faceMat.userData.isSign = true;
  const face = new THREE.PlaneGeometry(BOARD.faceW, BOARD.faceH);
  face.translate(0, BOARD.faceY, 0.027);
  boardShared = { frame, frameMat, face, faceMat, tex };
  return boardShared;
}

// One board: origin on the ground, facing +z (rotate with yaw). The Meshy notice board (log frame,
// snowy roof, cork board with pinned notes) carries a crisp JOBS header plank under its roof; without
// the model the built-in board is used.
export function makeBoard() {
  const art = artBoard();
  if (art) return art;
  const A = boardAssets();
  const g = new THREE.Group();
  const frame = new THREE.Mesh(A.frame, A.frameMat);
  const face = new THREE.Mesh(A.face, A.faceMat);
  for (const m of [frame, face]) { m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix(); }
  g.add(frame, face);
  g.name = 'job-board';
  return g;
}

// ------------------------------------------------------------------ cargo packs (worn on the back)
// colours: body, band
const PACKS = {
  food: ['#c8321f', '#f4f1ea'],     // insulated delivery bag (fondue, bread, hot chocolate)
  mail: ['#e7b416', '#1d3a7a'],     // post bag
  patrol: ['#c42a22', '#ffffff'],   // ski patrol red with a white cross
  tools: ['#3a4048', '#ff6a12'],    // maintenance grey with hi-vis band
  race: ['#1f5fd6', '#ffffff'],     // race office blue
};
const packCache = new Map();
let packMat = null;
// Pack geometry in its own frame: x across the back, y up, z away from the body (0 = against it).
export function packGeometry(kind) {
  if (packCache.has(kind)) return packCache.get(kind);
  const [body, band] = PACKS[kind] || PACKS.food;
  const parts = [];
  const W = 0.31, H = 0.4, D = 0.15;
  parts.push(part(new THREE.BoxGeometry(W, H, D), body, 0, 0, D / 2));
  parts.push(part(new THREE.BoxGeometry(W + 0.012, 0.07, D * 0.92), body, 0, H / 2 - 0.01, D * 0.5)); // lid
  parts.push(part(new THREE.BoxGeometry(W + 0.006, 0.045, D + 0.006), band, 0, -0.02, D / 2)); // band
  parts.push(part(new THREE.BoxGeometry(W * 0.62, 0.12, 0.035), body, 0, -0.08, D + 0.016)); // front pocket
  // shoulder straps running into the jacket
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.045, 0.012, 0.09), '#1c1c1e', sx * 0.085, H / 2 - 0.03, -0.03));
    parts.push(part(new THREE.BoxGeometry(0.045, 0.012, 0.07), '#1c1c1e', sx * 0.1, -H / 2 + 0.03, -0.025));
  }
  if (kind === 'patrol') {
    parts.push(part(new THREE.BoxGeometry(0.11, 0.032, 0.006), band, 0, 0.07, D + 0.004));
    parts.push(part(new THREE.BoxGeometry(0.032, 0.11, 0.006), band, 0, 0.07, D + 0.004));
  }
  const g = merged(parts);
  packCache.set(kind, g);
  return g;
}
export function makePack(kind) {
  const a = artPack(kind);
  if (a) return a;
  packMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
  const m = new THREE.Mesh(packGeometry(kind), packMat);
  m.castShadow = true; m.receiveShadow = true;
  m.name = 'job-pack';
  return m;
}

// ------------------------------------------------------------------ lost items
const itemCache = new Map();
let itemMat = null;
export const ITEMS = {
  phone: { noun: 'phone' },
  glove: { noun: 'glove' },
  goggles: { noun: 'goggles' },
  beanie: { noun: 'beanie' },
  camera: { noun: 'camera' },
};
// Each item's geometry rests on y = 0 in its own frame.
function itemGeometry(kind) {
  if (itemCache.has(kind)) return itemCache.get(kind);
  const parts = [];
  if (kind === 'phone') {
    parts.push(part(new THREE.BoxGeometry(0.074, 0.009, 0.152), '#16181d', 0, 0.0045, 0));
    parts.push(part(new THREE.BoxGeometry(0.066, 0.001, 0.138), '#2a3446', 0, 0.0095, 0)); // screen
    parts.push(part(new THREE.CylinderGeometry(0.009, 0.009, 0.002, 12), '#0a0a0c', 0.018, 0.0, -0.052)); // camera bump (underside)
  } else if (kind === 'glove') {
    parts.push(part(new THREE.BoxGeometry(0.11, 0.035, 0.15), '#1d3f8f', 0, 0.0175, 0.01));
    for (let f = 0; f < 4; f++) parts.push(part(new THREE.BoxGeometry(0.024, 0.026, 0.07), '#1d3f8f', -0.039 + f * 0.026, 0.014, 0.115, 0, 0, 0));
    parts.push(part(new THREE.BoxGeometry(0.03, 0.026, 0.075), '#1d3f8f', 0.068, 0.014, 0.03, 0, -0.6, 0)); // thumb
    parts.push(part(new THREE.BoxGeometry(0.12, 0.05, 0.075), '#15151a', 0, 0.025, -0.095)); // cuff
  } else if (kind === 'goggles') {
    parts.push(part(new THREE.BoxGeometry(0.19, 0.085, 0.032), '#141416', 0, 0.0425, 0));
    parts.push(part(new THREE.BoxGeometry(0.176, 0.07, 0.006), '#ff8a1f', 0, 0.0425, 0.018)); // mirrored lens
    parts.push(part(new THREE.BoxGeometry(0.42, 0.04, 0.004), '#222428', 0, 0.002, -0.07, Math.PI / 2, 0, 0)); // strap lying flat
  } else if (kind === 'beanie') {
    parts.push(part(new THREE.SphereGeometry(0.105, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), '#b3261e', 0, 0.045, 0, 0, 0, 0, 1, 0.9, 1));
    parts.push(part(new THREE.CylinderGeometry(0.108, 0.11, 0.05, 18), '#f1ece4', 0, 0.025, 0));
    parts.push(part(new THREE.SphereGeometry(0.042, 12, 8), '#f1ece4', 0, 0.16, 0));
  } else if (kind === 'camera') {
    parts.push(part(new THREE.BoxGeometry(0.12, 0.075, 0.055), '#1b1c20', 0, 0.0375, 0));
    parts.push(part(new THREE.CylinderGeometry(0.026, 0.028, 0.045, 16), '#2b2d33', 0, 0.04, 0.045, Math.PI / 2, 0, 0));
    parts.push(part(new THREE.BoxGeometry(0.03, 0.012, 0.02), '#c8321f', 0.035, 0.08, -0.01));
  } else { // ski pole lying in the snow
    parts.push(part(new THREE.CylinderGeometry(0.009, 0.009, 1.2, 8), '#c9ccd2', 0, 0.012, 0, Math.PI / 2, 0, 0));
    parts.push(part(new THREE.CylinderGeometry(0.02, 0.018, 0.16, 10), '#1b1b1f', 0, 0.02, -0.55, Math.PI / 2, 0, 0)); // grip
    parts.push(part(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 14), '#1b1b1f', 0, 0.01, 0.5, Math.PI / 2, 0, 0)); // basket
  }
  const g = merged(parts);
  itemCache.set(kind, g);
  return g;
}

// A lost item lying on the snow at (x, z): tilted to the slope, a little pressed into the surface.
export function makeItem(kind, x, z, yaw) {
  let mesh = artItem(kind);
  if (!mesh) {
    itemMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
    mesh = new THREE.Mesh(itemGeometry(kind), itemMat);
    mesh.castShadow = false; mesh.receiveShadow = true;
  }
  const g = new THREE.Group();
  g.add(mesh);
  const n = world.normal(x, z, new THREE.Vector3());
  g.quaternion.setFromUnitVectors(UP, n).multiply(_q.setFromAxisAngle(UP, yaw));
  g.position.set(x, meshY(x, z) - 0.004, z);
  g.name = 'job-item';
  return g;
}

// A soft sparkle that catches the eye from a few dozen metres (only while an item is being searched).
let glintTex = null;
export function makeGlint() {
  if (!glintTex && HAS_DOM) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      if (g) {
        const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        rg.addColorStop(0, 'rgba(255,255,255,1)');
        rg.addColorStop(0.18, 'rgba(255,248,225,0.75)');
        rg.addColorStop(0.5, 'rgba(255,240,200,0.12)');
        rg.addColorStop(1, 'rgba(255,240,200,0)');
        g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
        // four-point star
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath(); g.moveTo(32, 2); g.lineTo(34, 30); g.lineTo(62, 32); g.lineTo(34, 34); g.lineTo(32, 62); g.lineTo(30, 34); g.lineTo(2, 32); g.lineTo(30, 30); g.closePath(); g.fill();
        glintTex = new THREE.CanvasTexture(c);
        glintTex.colorSpace = THREE.SRGBColorSpace;
      }
    } catch { glintTex = null; }
  }
  const mat = new THREE.SpriteMaterial({ map: glintTex, color: 0xfff4dc, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(0.42);
  s.name = 'job-glint';
  return s;
}

// ------------------------------------------------------------------ crossed skis ("skier down")
// The casualty's skis: the shop's Meshy rental ski (another loaded ski model as a stand-in), turned into the
// frame used below: along +y from the tail (y = 0) to the tip (1.68 m), top sheet and binding toward +z.
// (Meshy skis lie along the file's +x, tip at +x, binding up +y: see player/skier.js)
const SKI_MODELS = ['ski_rental', 'ski_sport', 'ski_pro', 'ski_cruiser'];
let skiGeo = null, skiMat = null;
function skiPiece() {
  if (skiGeo === null) {
    skiGeo = false;
    const gltf = SKI_MODELS.map((n) => art?.[n]).find((g) => g?.scene);
    let src = null;
    gltf?.scene.updateMatrixWorld(true);
    gltf?.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
    if (src) {
      const g = dequantize(src.geometry);
      g.applyMatrix4(src.matrixWorld);
      // file axes -> this frame: length +x -> +y, up +y -> +z, width z -> x
      g.applyMatrix4(_m.makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));
      g.computeBoundingBox();
      const b = g.boundingBox, s = 1.68 / (b.max.y - b.min.y);
      const sx = Math.min(1, 0.105 / ((b.max.x - b.min.x) * s)); // a realistic width, binding included
      g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -b.min.z);
      g.scale(s * sx, s, s);
      g.translate(0, 0, -0.009); // (the base just under the snow line the poses below were made for)
      g.computeBoundingSphere();
      skiGeo = g; skiMat = src.material;
    }
  }
  if (!skiGeo) return null;
  const m = new THREE.Mesh(skiGeo, skiMat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
// Two skis planted tails-down 0.35 m deep, leaning 17 degrees each way so they cross in an X about
// 0.7 m above the snow (the tips stand ~1.25 m high). `facing` turns the X toward the viewer.
export function makeCrossedSkis(x, z, facing) {
  const g = new THREE.Group();
  const lean = 0.3, cross = 1.1; // rad, metres along each ski to the crossing
  for (const s of [-1, 1]) {
    const m = skiPiece();
    if (!m) continue;
    // rotation.z > 0 tips the top toward -x, so that ski is planted on the +x side
    m.rotation.set(0, 0, s * lean);
    m.position.set(s * Math.sin(lean) * cross, -0.35, s * 0.014);
    g.add(m);
  }
  // the lower of the two planted tails decides the height (never floating on a slope)
  const dx = Math.cos(facing) * Math.sin(lean) * cross, dz = -Math.sin(facing) * Math.sin(lean) * cross;
  g.position.set(x, Math.min(world.height(x + dx, z + dz), world.height(x - dx, z - dz)), z);
  g.rotation.y = facing;
  g.name = 'job-crossed-skis';
  return g;
}

// A pair of skis lying side by side flat on the snow (tips toward `yaw`), tilted to the slope.
export function makeLyingSkis(x, z, yaw) {
  const g = new THREE.Group();
  for (const s of [-1, 1]) {
    const m = skiPiece();
    if (!m) continue;
    // the ski is built along +y with its tip curling to +z: lay it along +z, tip curl up
    m.rotation.set(Math.PI / 2, Math.PI, 0);
    m.position.set(s * 0.08, 0.012, -0.84);
    g.add(m);
  }
  const n = world.normal(x, z, new THREE.Vector3());
  g.quaternion.setFromUnitVectors(UP, n).multiply(_q.setFromAxisAngle(UP, yaw));
  g.position.set(x, meshY(x, z), z);
  // never under the visible snow: lift the pair until the base clears the terrain mesh by 2.5 cm at the tail, the
  // middle and the tip of both skis (the slope curves under a 1.7 m ski, and the ski-track strips are drawn
  // pulled toward the camera, which hid a ski lying flush)
  g.updateMatrixWorld(true);
  let lift = 0;
  for (const lz of [-0.84, 0, 0.84]) for (const lx of [-0.13, 0.13]) {
    _p.set(lx, 0.003, lz).applyMatrix4(g.matrixWorld);
    lift = Math.max(lift, meshY(_p.x, _p.z) + 0.025 - _p.y);
  }
  g.position.y += lift;
  g.name = 'job-lying-skis';
  return g;
}

// ------------------------------------------------------------------ stand-in figure
// Only used when no character model could be loaded: a plain jacket + helmet figure, standing or
// sitting in the snow (legs out in front, facing +z).
let figMat = null;
export function makeFallbackFigure(pose, jacket = '#2e6bd1') {
  figMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const parts = [];
  if (pose === 'sit') {
    parts.push(part(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), jacket, 0, 0.5, -0.04, -0.15, 0, 0));
    parts.push(part(new THREE.SphereGeometry(0.125, 14, 10), '#1b1b1f', 0, 0.98, -0.1));
    for (const sx of [-1, 1]) {
      parts.push(part(new THREE.CapsuleGeometry(0.075, 0.62, 4, 8), '#24262c', sx * 0.11, 0.13, 0.4, Math.PI / 2 - 0.12, 0, 0));
      parts.push(part(new THREE.CapsuleGeometry(0.055, 0.42, 4, 8), jacket, sx * 0.24, 0.56, 0.13, -0.9, 0, sx * 0.1)); // arms to the knees
      parts.push(part(new THREE.BoxGeometry(0.11, 0.26, 0.1), '#1b1b1f', sx * 0.11, 0.14, 0.82));
    }
  } else {
    parts.push(part(new THREE.CapsuleGeometry(0.19, 0.5, 4, 10), jacket, 0, 1.18, 0));
    parts.push(part(new THREE.SphereGeometry(0.125, 14, 10), '#1b1b1f', 0, 1.66, 0));
    for (const sx of [-1, 1]) {
      parts.push(part(new THREE.CapsuleGeometry(0.075, 0.72, 4, 8), '#24262c', sx * 0.1, 0.48, 0));
      parts.push(part(new THREE.CapsuleGeometry(0.055, 0.5, 4, 8), jacket, sx * 0.27, 1.13, 0, 0, 0, sx * 0.12));
      parts.push(part(new THREE.BoxGeometry(0.11, 0.1, 0.28), '#1b1b1f', sx * 0.1, 0.05, 0.04));
    }
  }
  const geo = merged(parts);
  const m = new THREE.Mesh(geo, figMat);
  m.castShadow = true; m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  g.userData.ownGeometry = geo;
  return g;
}

// ------------------------------------------------------------------ hand-over marker (fallback only)
// A soft ring on the snow marks a hand-over point when there is nobody there to receive the parcel.
let ringGeo = null, ringMat = null;
export function makeRing(x, z) {
  ringGeo ??= new THREE.RingGeometry(0.85, 1.0, 48).rotateX(-Math.PI / 2);
  ringMat ??= new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: true });
  const m = new THREE.Mesh(ringGeo, ringMat);
  m.position.set(x, meshY(x, z) + 0.03, z);
  m.renderOrder = 2;
  m.name = 'job-ring';
  return m;
}

// ------------------------------------------------------------------ optional art
// main.js loads a few job-prop models when they exist (all optional): a model is used in place of the
// built-in prop of the same kind, sized to the real thing. The job board stays built-in (its printed
// "JOBS" face is what makes it readable).
export const ART = {
  pack: { food: 'delivery_backpack', patrol: 'patrol_backpack', mail: 'mail_bag' },
  item: { glove: 'ski_glove', goggles: 'ski_goggles', beanie: 'beanie', camera: 'compact_camera', phone: 'smartphone' },
};
const ITEM_SIZE = { glove: 0.26, goggles: 0.19, beanie: 0.22, camera: 0.12, phone: 0.15 };
let art = null;
export function setPropModels(models) { art = models || null; }
function artProp(name, size, axis) {
  const gltf = art?.[name];
  if (!gltf?.scene) return null;
  try {
    const g = fitModel(gltf, { size, axis });
    if (!g.children.length || !g.userData.size) return null;
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  } catch { return null; }
}
// a model pack: centred across the back and up, its back panel against the jacket (z = 0, model front +z)
function artPack(kind) {
  const g = artProp(ART.pack[kind], 0.42, 'y');
  if (!g) return null;
  const sz = g.userData.size, m = g.children[0];
  m.position.y -= sz.y / 2; m.position.z += sz.z / 2;
  g.name = 'job-pack';
  return g;
}
// the Meshy notice board + a JOBS header plank on the beam under its roof
let headerMat = null;
function artBoard() {
  const g0 = artProp('job_board', 2.6, 'y');
  if (!g0) return null;
  const g = new THREE.Group();
  g.add(g0);
  g0.updateMatrixWorld(true);
  // find the front face of the beam under the roof (the model faces +z)
  const y = 2.0, hit = new THREE.Raycaster(new THREE.Vector3(0, y, 3), new THREE.Vector3(0, 0, -1), 0, 6).intersectObject(g0, true)[0];
  const z = hit ? hit.point.z + 0.015 : 0.2;
  headerMat ??= new THREE.MeshStandardMaterial({
    map: HAS_DOM ? canvasHeader() : null, color: HAS_DOM ? 0xffffff : 0x3b2717, roughness: 0.8, metalness: 0,
    emissive: 0xffffff, emissiveMap: HAS_DOM ? canvasHeader() : null, emissiveIntensity: 0.06,
  });
  headerMat.userData.isSign = true;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.3), headerMat);
  sign.position.set(0, y, z);
  sign.castShadow = false; sign.receiveShadow = true;
  g.add(sign);
  g.name = 'job-board';
  return g;
}
let headerTex = null;
function canvasHeader() {
  if (headerTex) return headerTex;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 314;
  const g = c.getContext('2d');
  g.fillStyle = '#3b2717'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#c9a36a'; g.lineWidth = 10; g.strokeRect(14, 14, c.width - 28, c.height - 28);
  g.fillStyle = '#f3e3c2'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 168px Georgia, "Times New Roman", serif';
  if ('letterSpacing' in g) g.letterSpacing = '22px';
  g.fillText('JOBS', c.width / 2 + 11, 140);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  g.fillStyle = '#e2d2b0';
  g.font = '600 38px Georgia, "Times New Roman", serif';
  g.fillText('Odd jobs around the mountain · paid on completion', c.width / 2, 254);
  headerTex = new THREE.CanvasTexture(c);
  headerTex.colorSpace = THREE.SRGBColorSpace;
  headerTex.anisotropy = 8;
  return headerTex;
}

// the ski patrol's red rescue sled beside an injured skier (Meshy model; none without it)
export function makeRescueSled(x, z, yaw) {
  const g = artProp('rescue_sled', 2.3, 'xz');
  if (!g) return null;
  g.position.set(x, meshY(x, z) - 0.02, z);
  g.rotation.y = yaw;
  g.name = 'job-sled';
  return g;
}

// a model item resting on the snow
function artItem(kind) {
  const g = artProp(ART.item[kind], ITEM_SIZE[kind] || 0.2, 'xz');
  if (g) g.name = 'job-item-art';
  return g;
}
// every optional model that is present (for the shader warm-up)
export function artWarmup() {
  const out = [];
  for (const k of Object.keys(ART.pack)) { const g = artPack(k); if (g) out.push(g); }
  for (const k of Object.keys(ART.item)) { const g = artItem(k); if (g) out.push(g); }
  const sled = artProp('rescue_sled', 2.3, 'xz');
  if (sled) out.push(sled);
  return out;
}

// Free every shared geometry, material and texture created here.
export function disposeProps() {
  if (boardShared) {
    boardShared.frame.dispose(); boardShared.frameMat.dispose(); boardShared.face.dispose(); boardShared.faceMat.dispose(); boardShared.tex?.dispose();
    boardShared = null;
  }
  for (const g of packCache.values()) g.dispose();
  packCache.clear();
  for (const g of itemCache.values()) g.dispose();
  itemCache.clear();
  packMat?.dispose(); itemMat?.dispose(); figMat?.dispose(); ringMat?.dispose(); // (skiMat is the ski model's own)
  packMat = itemMat = skiMat = figMat = ringMat = null;
  if (skiGeo) skiGeo.dispose(); skiGeo = null;
  ringGeo?.dispose(); ringGeo = null;
  glintTex?.dispose(); glintTex = null;
}
