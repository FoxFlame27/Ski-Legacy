// The POLICE STATION's outside (game/prison.js): an alpine two-storey "POLIZEI" house on its lot right on the village
// road (game/bus/roads.js planPrison: the lot's edge on the road's edge, the door facing the road), built like the
// rest of Legacy Village (the Autohaus's materials: carrentalshell.js shellMaterials): a rough stone ground floor
// (the cell wing on the right: small barred windows), a larch upper floor with a balcony, a deep snow-laden gable
// roof, wooden shutters, warm windows lit at night, a porch over the door, the blue POLIZEI board with its star (lit
// at night) and the blue police lamp, lanterns, flags, potted spruces, snow banked against the walls, and a ploughed
// forecourt from the door to the road (parking bays: two POLIZEI bays, a patrol car in one, a visitors' bay) fading
// into the snow at its sides.
//
// Lot frame (as carrental.js): origin at the lot's middle on the road's height, +z toward the road (its edge at
// z = L.hd), +x along it. The house: W x D, its front (the door) at z FRONT.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { makeSign, standSign } from '../world/village.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fitModel, loadGLB, dequantize } from '../core/assets.js';
import { shellMaterials } from './carrentalshell.js';
import { buildPoliceCar } from './police.js';

export const HOUSE = { W: 17, D: 10, BZ: -5.8, G: 3.3, Hw: 6.2, RISE: 3.0, EAVE: 1.4, GO: 0.9, DX: -3.2 };
const { W, D, BZ, G, Hw, RISE, EAVE, GO, DX } = HOUSE;
const FRONT = BZ + D / 2; // (-0.8)
const BAYS = { lines: [1.0, 3.7, 6.4, 9.1], z0: 0.4, z1: 5.6 };

const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
// UVs in metres on a box (each face by its own two axes): the shared board / stone textures at one scale everywhere
function worldUV(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ay > 0.5) uv.setXY(i, p.getX(i), p.getZ(i)); else if (ax > 0.5) uv.setXY(i, p.getZ(i), p.getY(i)); else uv.setXY(i, p.getX(i), p.getY(i));
  }
  return geo;
}
/** The star badge (a five-pointed star in a ring) at (x, y), radius r. */
export function drawBadge(c, x, y, r, { ring = '#e9c860', star = '#f4d77a', inner = '#0d3a7a' } = {}) {
  c.save(); c.translate(x, y);
  c.fillStyle = ring; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
  c.fillStyle = inner; c.beginPath(); c.arc(0, 0, r * 0.84, 0, Math.PI * 2); c.fill();
  c.fillStyle = star; c.strokeStyle = '#8a6a1c'; c.lineWidth = Math.max(2, r * 0.04);
  c.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, R = i % 2 ? r * 0.33 : r * 0.74; c.lineTo(Math.cos(a) * R, Math.sin(a) * R); }
  c.closePath(); c.fill(); c.stroke();
  c.fillStyle = inner; c.beginPath(); c.arc(0, 0, r * 0.16, 0, Math.PI * 2); c.fill();
  c.restore();
}
/** The POLIZEI board (the village's sign style: a lettered face on a wooden back board) with the star badge either
 *  side; its face glows at night (userData.faceMaterial: emissiveIntensity). */
export function polizeiSign(w = 4.2, h = 1.05, sub = 'LEGACY VILLAGE') {
  const tex = canvasTex(1024, Math.round((1024 * h) / w), (c, cw, ch) => {
    const gr = c.createLinearGradient(0, 0, 0, ch); gr.addColorStop(0, '#174a96'); gr.addColorStop(1, '#0b2f68');
    c.fillStyle = gr; c.fillRect(0, 0, cw, ch);
    c.strokeStyle = '#e8eef7'; c.lineWidth = 10; c.strokeRect(14, 14, cw - 28, ch - 28);
    c.strokeStyle = 'rgba(232,238,247,0.5)'; c.lineWidth = 3; c.strokeRect(30, 30, cw - 60, ch - 60);
    const r = ch * 0.34;
    drawBadge(c, 40 + r + 12, ch / 2, r); drawBadge(c, cw - 40 - r - 12, ch / 2, r);
    c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `bold ${Math.round(ch * (sub ? 0.46 : 0.6))}px Georgia, "Times New Roman", serif`;
    c.fillText('POLIZEI', cw / 2, sub ? ch * 0.42 : ch / 2 + 4);
    if (sub) { c.font = `600 ${Math.round(ch * 0.15)}px Georgia, serif`; c.fillStyle = '#dfe7f2'; c.fillText(sub.split('').join(' '), cw / 2, ch * 0.77); }
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.05 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x3a2716, roughness: 0.85 });
  const g = new THREE.Group();
  const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, h + 0.14, 0.08), wood);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); face.position.z = 0.042;
  g.add(back, face);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.faceMaterial = mat;
  return g;
}
/** The blue police lamp: a lantern of blue glass lettered POLIZEI on a wrought bracket (z: out of the wall). */
export function policeLamp() {
  const g = new THREE.Group();
  const tex = canvasTex(256, 320, (c, w, h) => {
    c.fillStyle = '#1d55d8'; c.fillRect(0, 0, w, h);
    const gr = c.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.7); gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gr; c.fillRect(0, 0, w, h);
    c.save(); c.translate(w / 2, h / 2); c.rotate(-Math.PI / 2); c.fillStyle = '#ffffff'; c.font = 'bold 64px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('POLIZEI', 0, 4); c.restore();
  });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb8ff, map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.25 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.45, metalness: 0.7 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  add(new THREE.BoxGeometry(0.16, 0.24, 0.04), iron, 0, 0.1, 0.02); // (the wall plate)
  add(new THREE.BoxGeometry(0.04, 0.04, 0.5), iron, 0, 0.18, 0.27); // (the arm)
  add(new THREE.BoxGeometry(0.3, 0.42, 0.3), glass, 0, -0.12, 0.42).castShadow = false;
  add(new THREE.ConeGeometry(0.26, 0.16, 4), iron, 0, 0.17, 0.42).rotation.y = Math.PI / 4;
  add(new THREE.BoxGeometry(0.34, 0.04, 0.34), iron, 0, 0.1, 0.42);
  add(new THREE.BoxGeometry(0.34, 0.04, 0.34), iron, 0, -0.34, 0.42);
  for (const [x, z] of [[-0.155, 0.265], [0.155, 0.265], [-0.155, 0.575], [0.155, 0.575]]) add(new THREE.BoxGeometry(0.03, 0.44, 0.03), iron, x, -0.12, z);
  g.userData.glass = glass;
  return g;
}

// ---- Meshy decor (tools/meshy-decor.mjs): natural snow drifts and the lanterns / lamps / plants. Nothing waits for
// them: each spot gets a procedural stand-in at once and the model replaces it when its GLB has loaded.
/** Swap a Meshy model into `group` once `name` has loaded (fitModel(gltf, fit)), removing the group's procedural
 * stand-in (`fallback`, a child of the group); onModel(model) dresses it. A missing model keeps the stand-in. */
export function swapInModel(group, name, fit, fallback, onModel) {
  loadGLB(name).then((gltf) => {
    if (!gltf) return;
    const m = fitModel(gltf, fit);
    if (!m.children.length) return;
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    if (fallback) group.remove(fallback);
    group.add(m);
    onModel?.(m);
  }).catch((e) => console.warn('decor', name, e));
}

// the snow drifts' shape: the model's geometry welded smooth, normalised to a unit box (x / z -0.5..0.5, y 0..1),
// its long side along x; plain snow on it (the ground's colour and sheen: no texture, which reads grey up close)
const DRIFTS = { long: 'snow/drift_long', heap: 'snow/snow_heap', mound: 'snow/snow_mound' };
const driftGeo = new Map();
function driftGeometry(kind) {
  if (!driftGeo.has(kind)) driftGeo.set(kind, loadGLB(DRIFTS[kind]).then((gltf) => {
    if (!gltf) return null;
    gltf.scene.updateMatrixWorld(true);
    let geo = null;
    gltf.scene.traverse((o) => {
      if (!o.isMesh || geo) return;
      const g = dequantize(o.geometry); g.applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
      geo = mergeVertices(g, 1e-4);
    });
    if (!geo) return null;
    geo.computeBoundingBox();
    let b = geo.boundingBox, sz = b.getSize(new THREE.Vector3());
    if (sz.z > sz.x) { geo.rotateY(Math.PI / 2); geo.computeBoundingBox(); b = geo.boundingBox; sz = b.getSize(new THREE.Vector3()); }
    const c = b.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -b.min.y, -c.z); geo.scale(1 / sz.x, 1 / sz.y, 1 / sz.z);
    geo.computeVertexNormals(); geo.computeBoundingSphere();
    // (the ground's snow shading, terrain.js: a touch of sky blue in the steep sides and hollows, brighter on the crest)
    const pa = geo.attributes.position, na = geo.attributes.normal, col = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) {
      const k = Math.min(1, Math.max(0, na.getY(i) * 0.65 + pa.getY(i) * 0.45));
      col[i * 3] = 0.9 + 0.12 * k; col[i * 3 + 1] = 0.94 + 0.08 * k; col[i * 3 + 2] = 1.0 + 0.02 * k;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }).catch(() => null));
  return driftGeo.get(kind);
}
let driftMat = null, driftMatFb = null;
/** The drifts' snow: the ground's (terrain.js: albedo ~0.83 / 0.86 / 0.90 linear, roughness ~0.6), shaded by the
 * drift's vertex colours (fb: the stand-in's, without them). */
export function snowDriftMaterial(fb = false) {
  if (fb) return (driftMatFb ??= new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.84, 0.87, 0.91), roughness: 0.64, metalness: 0 }));
  return (driftMat ??= new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.84, 0.87, 0.91), roughness: 0.64, metalness: 0, vertexColors: true }));
}
/**
 * A natural snow drift (kind 'long': a wind-blown bank, 'heap': a ploughed pile, 'mound': a low hump) of len (x) ×
 * wid (z) × h metres, its base `sink` × h below the group's origin (no floating edge on uneven ground). Returns a
 * Group at once (a soft procedural lump until the Meshy drift has loaded). (Used by the police station, and free for
 * the other village lots.)
 */
export function snowDrift(kind, len, wid, h, { mat = snowDriftMaterial(), sink = 0.14, shadow = false } = {}) {
  const g = new THREE.Group();
  const fb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat.vertexColors ? snowDriftMaterial(true) : mat);
  fb.scale.set(len, h * 2, wid); fb.position.y = -sink * h; fb.receiveShadow = true; fb.castShadow = false; g.add(fb);
  driftGeometry(kind in DRIFTS ? kind : 'long').then((geo) => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(len, h * (1 + sink), wid); m.position.y = -sink * h;
    m.receiveShadow = true; m.castShadow = shadow;
    g.remove(fb); g.add(m);
  });
  return g;
}

/**
 * Build the station into the scene. P: the Prison (scene, models, colliders, cameraBlockers), L: its lot.
 * Returns { group, house, door: { x, z, yaw }, update(n, t) } (n: 0 day .. 1 night).
 */
export function buildPrisonOutside(P, L) {
  const M = shellMaterials(), models = P.models || {};
  const yaw0 = Math.atan2(L.dirx, L.dirz);
  const w = (lx, lz) => ({ x: L.x + L.dirz * lx + L.dirx * lz, z: L.z - L.dirx * lx + L.dirz * lz });
  const gy = (lx, lz) => { const p = w(lx, lz); return world.height(p.x, p.z) - L.y; }; // (the ground, lot frame)
  const g = new THREE.Group(); g.name = 'prison';
  g.position.set(L.x, L.y, L.z); g.rotation.y = yaw0;
  const add = (geo, mat, x, y, z, parent = g, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m; };
  const B = (w_, h, d, mat, x, y, z, parent = g, shadow = true) => add(worldUV(new THREE.BoxGeometry(w_, h, d)), mat, x, y, z, parent, shadow);
  // materials: the Autohaus's larch, stone, roof and snow; dark larch for the beams and frames, painted shutters
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.8 });
  const oak = new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 0.6 });
  const shutterT = canvasTex(128, 256, (c, cw, ch) => {
    c.fillStyle = '#2e4a37'; c.fillRect(0, 0, cw, ch);
    for (let y = 8; y < ch - 8; y += 14) { c.fillStyle = 'rgba(0,0,0,0.28)'; c.fillRect(8, y, cw - 16, 4); c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(8, y + 4, cw - 16, 2); } // (louvres)
    c.strokeStyle = '#1d3024'; c.lineWidth = 8; c.strokeRect(4, 4, cw - 8, ch - 8);
  });
  const shutter = new THREE.MeshStandardMaterial({ map: shutterT, roughness: 0.7 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.45, metalness: 0.7 });
  const winLit = new THREE.MeshStandardMaterial({ color: 0x8fa3b3, emissive: 0xffd9a0, emissiveIntensity: 0.35, roughness: 0.12, metalness: 0.2 });
  const winCell = new THREE.MeshStandardMaterial({ color: 0x5d6b78, emissive: 0xcfe0ff, emissiveIntensity: 0.08, roughness: 0.15, metalness: 0.25 });
  const snow = M.snow;
  const house = new THREE.Group(); house.position.set(0, 0, BZ); g.add(house);

  // ---- walls: the stone ground floor (a little into the ground: no plinth edge), a dark beam, the larch upper floor
  B(W + 0.12, G + 0.45, D + 0.12, M.stone, 0, (G - 0.45) / 2, 0, house);
  B(W + 0.34, 0.26, D + 0.34, darkWood, 0, G + 0.02, 0, house);
  B(W, Hw - G, D, M.larchOut, 0, G + (Hw - G) / 2, 0, house);
  // stone quoins at the corners (lighter, bigger blocks)
  const quoin = new THREE.MeshStandardMaterial({ color: 0xa8a49a, roughness: 0.9 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 6; k++) {
    const y = 0.05 + k * 0.55, long = k % 2 === 0;
    B(long ? 0.7 : 0.4, 0.5, 0.08, quoin, sx * (W / 2 + 0.06 - (long ? 0.35 : 0.2)), y + 0.25, sz * (D / 2 + 0.07), house);
    B(0.08, 0.5, long ? 0.4 : 0.7, quoin, sx * (W / 2 + 0.07), y + 0.25, sz * (D / 2 + 0.06 - (long ? 0.2 : 0.35)), house);
  }
  // the gables (larch, over the upper floor) and the roof: two slabs, ridge along x, deep eaves; snow on each
  const gable = new THREE.Shape(); gable.moveTo(-D / 2, 0); gable.lineTo(D / 2, 0); gable.lineTo(0, RISE); gable.closePath();
  const gGeo = new THREE.ExtrudeGeometry(gable, { depth: 0.25, bevelEnabled: false });
  { const p = gGeo.attributes.position, uv = gGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i)); }
  for (const sx of [-1, 1]) { const m = add(gGeo, M.larchOut, sx > 0 ? W / 2 - 0.25 : -W / 2, Hw, 0, house); m.rotation.y = Math.PI / 2; }
  const k = RISE / (D / 2), run = D / 2 + EAVE, drop = RISE + k * EAVE, len = Math.hypot(run, drop), ang = Math.atan2(drop, run), RW = W + 2 * GO;
  for (const sz of [-1, 1]) {
    const ny = Math.cos(ang), nz = Math.sin(ang) * sz, cy = Hw + RISE - drop / 2, cz = sz * run / 2;
    const slab = B(RW, 0.28, len, M.roof, 0, cy + ny * 0.14, cz + nz * 0.14, house); slab.rotation.x = sz * ang;
    const sn = B(RW + 0.1, 0.36, len - 0.05, snow, 0, cy + ny * 0.46, cz + nz * 0.46, house); sn.rotation.x = sz * ang;
    // (the snow's rounded lip at the eaves)
    const lip = add(new THREE.CylinderGeometry(0.2, 0.2, RW + 0.1, 10), snow, 0, Hw - k * EAVE + 0.32, sz * (run - 0.05), house); lip.rotation.z = Math.PI / 2; lip.scale.set(1, 1, 1.3);
    B(RW, 0.34, 0.1, darkWood, 0, Hw - k * EAVE - 0.08, sz * (run + 0.02), house); // (the fascia)
    // carved rafter ends under the eaves
    for (let x = -W / 2 - GO + 0.5; x <= W / 2 + GO - 0.4; x += 1.1) { const r = B(0.14, 0.18, EAVE + 0.3, darkWood, x, Hw - k * (EAVE / 2) - 0.2, sz * (D / 2 + EAVE / 2 - 0.15), house, false); r.rotation.x = sz * ang; }
  }
  // the barge boards along the gables' edges
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const b = B(0.1, 0.36, len, darkWood, sx * (RW / 2 + 0.02), Hw + RISE - drop / 2 - 0.05, sz * run / 2, house); b.rotation.x = sz * ang;
  }
  // a stone chimney on the back slope, a cap of snow
  { const cx = 4.2, cz = -1.6, top = Hw + RISE - k * Math.abs(cz) + 1.3;
    B(0.75, 2.6, 0.75, M.stone, cx, top - 1.3, cz, house);
    B(0.95, 0.12, 0.95, darkWood, cx, top + 0.06, cz, house);
    const cap = add(new THREE.SphereGeometry(0.55, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), snow, cx, top + 0.1, cz, house); cap.scale.set(1, 0.45, 1); }

  // ---- windows, the door, the porch (a face: front +z, back -z, right +x, left -x; local x across it, +z out)
  const faces = {
    front: (o) => { o.position.set(0, 0, D / 2); return o; },
    back: (o) => { o.position.set(0, 0, -D / 2); o.rotation.y = Math.PI; return o; },
    right: (o) => { o.position.set(W / 2, 0, 0); o.rotation.y = Math.PI / 2; return o; },
    left: (o) => { o.position.set(-W / 2, 0, 0); o.rotation.y = -Math.PI / 2; return o; },
  };
  const F = {}; for (const [n, f] of Object.entries(faces)) { F[n] = f(new THREE.Group()); house.add(F[n]); }
  const win = (face, x, y, ww, wh, kind = 'lit', z0 = 0.06) => {
    const p = F[face];
    B(ww + 0.2, wh + 0.2, 0.1, darkWood, x, y, z0, p, false);
    add(new THREE.PlaneGeometry(ww, wh), kind === 'bars' ? winCell : winLit, x, y, z0 + 0.052, p, false);
    if (kind !== 'bars') { B(0.06, wh, 0.05, darkWood, x, y, z0 + 0.07, p, false); B(ww, 0.06, 0.05, darkWood, x, y + wh * 0.12, z0 + 0.07, p, false); }
    B(ww + 0.36, 0.08, 0.26, kind === 'bars' ? M.stone : darkWood, x, y - wh / 2 - 0.13, z0 + 0.1, p, false);
    B(ww + 0.3, 0.07, 0.22, snow, x, y - wh / 2 - 0.055, z0 + 0.11, p, false); // (snow on the sill)
    if (kind === 'bars') {
      const n = Math.max(3, Math.round(ww / 0.16));
      for (let i = 1; i < n; i++) { const r = add(new THREE.CylinderGeometry(0.016, 0.016, wh + 0.12, 6), iron, x - ww / 2 + (ww * i) / n, y, z0 + 0.12, p, false); void r; }
      B(ww + 0.08, 0.04, 0.04, iron, x, y + wh * 0.18, z0 + 0.12, p, false);
    }
    if (kind === 'shutter') for (const s of [-1, 1]) B(ww / 2 + 0.04, wh + 0.12, 0.05, shutter, x + s * (ww * 0.75 + 0.14), y, z0 + 0.04, p, false);
  };
  // front: the office window and the door's left, the cell wing's small barred windows right; upstairs three windows
  win('front', -6.6, 1.75, 1.4, 1.3, 'shutter');
  for (const x of [1.2, 3.9, 6.6]) win('front', x, 2.35, 0.95, 0.55, 'bars');
  win('front', -7.0, G + 1.55, 1.2, 1.25, 'shutter');
  win('front', 2.2, G + 1.55, 1.2, 1.25, 'shutter');
  win('front', 5.9, G + 1.55, 1.2, 1.25, 'shutter');
  // back: the cells' high barred windows (as inside), upstairs; the sides
  for (const x of [-4.4, -0.8, 2.8]) win('back', x, 2.4, 0.95, 0.5, 'bars');
  for (const x of [-5.5, 0, 5.5]) win('back', x, G + 1.55, 1.1, 1.15, 'shutter');
  win('right', 0, 2.35, 0.95, 0.55, 'bars'); win('right', -2.2, G + 1.55, 1.2, 1.25, 'shutter'); win('right', 2.2, G + 1.55, 1.2, 1.25, 'shutter');
  win('left', 0.5, 1.75, 1.4, 1.3, 'shutter'); win('left', 0, G + 1.55, 1.2, 1.25, 'shutter'); win('left', 0, Hw + 1.1, 0.8, 0.8, 'lit');
  // the door: a stone surround, a double oak door with panels, a lit transom; a granite step
  { const p = F.front, z0 = 0.05;
    B(2.3, 2.95, 0.16, quoin, DX, 1.47, z0, p);
    const doorT = canvasTex(256, 384, (c, cw, ch) => {
      c.fillStyle = '#5a3820'; c.fillRect(0, 0, cw, ch);
      for (let x = 0; x < cw; x += 16) { c.fillStyle = `rgba(30,15,5,${0.15 + (x % 48 ? 0 : 0.2)})`; c.fillRect(x, 0, 2, ch); }
      c.strokeStyle = '#2e1b0c'; c.lineWidth = 10; c.strokeRect(5, 5, cw / 2 - 8, ch - 10); c.strokeRect(cw / 2 + 3, 5, cw / 2 - 8, ch - 10);
      for (const x0 of [22, cw / 2 + 20]) for (const [y0, h] of [[24, ch * 0.38], [ch * 0.5, ch * 0.42]]) { c.strokeStyle = 'rgba(25,12,4,0.8)'; c.lineWidth = 5; c.strokeRect(x0, y0, cw / 2 - 42, h); }
    });
    add(new THREE.PlaneGeometry(1.7, 2.45), new THREE.MeshStandardMaterial({ map: doorT, roughness: 0.6 }), DX, 1.225, z0 + 0.085, p);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.3, 0.05), new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.9, roughness: 0.3 }), DX + s * 0.12, 1.15, z0 + 0.12, p, false);
    add(new THREE.PlaneGeometry(1.7, 0.32), winLit, DX, 2.65, z0 + 0.085, p, false);
    B(1.74, 0.05, 0.05, darkWood, DX, 2.47, z0 + 0.1, p, false);
    B(2.6, 0.16, 1.1, quoin, DX, 0.02, z0 + 0.55, p);
  }
  // the porch: two larch posts, a little gable roof over the door, snow on it
  const porch = { x0: DX - 1.6, x1: DX + 1.6, z: D / 2 + 1.9, h: 2.95 };
  for (const x of [porch.x0, porch.x1]) {
    B(0.2, porch.h, 0.2, darkWood, x, porch.h / 2, porch.z, house);
    B(0.32, 0.12, 0.32, M.stone, x, 0.06, porch.z, house);
    B(0.14, 0.14, 1.95, darkWood, x, porch.h - 0.05, D / 2 + 0.95, house);
  }
  { const pw = porch.x1 - porch.x0 + 0.9, pr = 0.75, pd = 2.5, pl = Math.hypot(pw / 2, pr), pa = Math.atan2(pr, pw / 2);
    for (const sx of [-1, 1]) {
      const cx = DX + sx * pw / 4, cy = porch.h + 0.1 + pr / 2;
      const s = B(pl + 0.1, 0.14, pd, M.roof, cx, cy, D / 2 + pd / 2 - 0.1, house); s.rotation.z = -sx * pa;
      const n = B(pl + 0.12, 0.22, pd - 0.08, snow, cx - sx * Math.sin(pa) * 0.17, cy + Math.cos(pa) * 0.17, D / 2 + pd / 2 - 0.1, house); n.rotation.z = -sx * pa;
    }
    const tri = new THREE.Shape(); tri.moveTo(-pw / 2 + 0.2, 0); tri.lineTo(pw / 2 - 0.2, 0); tri.lineTo(0, pr - 0.06); tri.closePath();
    const tg = new THREE.ExtrudeGeometry(tri, { depth: 0.1, bevelEnabled: false });
    { const p = tg.attributes.position, uv = tg.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i)); }
    add(tg, M.larchOut, DX, porch.h + 0.1, D / 2 + pd - 0.35, house);
    B(pw - 0.3, 0.16, 0.16, darkWood, DX, porch.h + 0.06, D / 2 + pd - 0.3, house);
  }
  // the balcony upstairs over the cell wing: a larch floor on brackets, a board railing, snow on its rail
  { const x0 = 0.3, x1 = 7.9, bd = 1.1, y = G + 0.18, cx = (x0 + x1) / 2, bl = x1 - x0;
    B(bl, 0.16, bd, M.larchOut, cx, y, D / 2 + bd / 2, house);
    for (let x = x0 + 0.4; x < x1; x += 2.4) { const br = B(0.12, 0.12, 1.2, darkWood, x, y - 0.42, D / 2 + 0.5, house); br.rotation.x = -0.75; }
    B(bl, 0.1, 0.1, darkWood, cx, y + 1.0, D / 2 + bd - 0.05, house);
    B(bl, 0.08, 0.08, darkWood, cx, y + 0.18, D / 2 + bd - 0.05, house);
    for (const x of [x0 + 0.05, x1 - 0.05]) { B(0.1, 1.0, bd, darkWood, x, y + 0.6, D / 2 + bd / 2, house); B(0.08, 0.06, bd, snow, x, y + 1.12, D / 2 + bd / 2, house); }
    const n = Math.floor(bl / 0.17), board = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.8, 0.035), M.larchOut, n), o = new THREE.Object3D();
    for (let i = 0; i < n; i++) { o.position.set(x0 + 0.1 + i * (bl - 0.2) / (n - 1), y + 0.58, D / 2 + bd - 0.05); o.updateMatrix(); board.setMatrixAt(i, o.matrix); }
    board.castShadow = board.receiveShadow = true; house.add(board);
    B(bl + 0.04, 0.08, 0.16, snow, cx, y + 1.09, D / 2 + bd - 0.05, house); // (snow along the rail)
    B(bl - 0.1, 0.06, 0.5, snow, cx, y + 0.11, D / 2 + bd - 0.3, house); // (drifted on its floor)
  }
  // the POLIZEI board over the porch, the blue police lamp and a warm lantern either side of the door
  const sign = polizeiSign(4.2, 1.05); sign.position.set(DX, G + 1.35, D / 2 + 0.06); house.add(sign);
  const lamp = policeLamp(); lamp.position.set(DX - 1.55, 2.55, D / 2); house.add(lamp);
  const lanternGlass = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffc77a, emissiveIntensity: 0.25 });
  // (the lanterns: the Meshy black iron alpine wall lantern, tools/meshy-decor.mjs, its wall plate on the wall and its
  // panes lit at night through their own texture; a box lantern on a bracket until it has loaded or without it)
  const lanternMats = [];
  const lantern = (x, z, ry, y, fbBuild) => {
    const lg = new THREE.Group(); lg.position.set(x, y, z); lg.rotation.y = ry; house.add(lg);
    const fb = new THREE.Group(); lg.add(fb); fbBuild(fb);
    swapInModel(lg, 'decor/lantern_wall', { size: 0.72, axis: 'y' }, fb, (m) => {
      m.position.set(0, -0.3, 0.2); // (the plate, at the model's back, on the wall; the lantern's middle about here)
      m.traverse((o) => { if (!o.isMesh || !o.material) return;
        o.material = o.material.clone(); o.castShadow = false;
        if (o.material.map) { o.material.emissiveMap = o.material.map; o.material.emissive = new THREE.Color(0xffc77a); o.material.emissiveIntensity = lanternGlass.emissiveIntensity; lanternMats.push(o.material); } });
    });
  };
  const lB = (fb, w_, h, d, mat, x, y, z) => B(w_, h, d, mat, x, y, z, fb); // (the stand-in, in the lantern's own frame)
  lantern(DX + 1.55, D / 2 + 0.06, 0, 2.42, (fb) => { // (the door's right)
    lB(fb, 0.12, 0.22, 0.12, iron, 0, 0.2, 0.06); lB(fb, 0.04, 0.04, 0.3, iron, 0, 0.28, 0.2);
    lB(fb, 0.26, 0.4, 0.26, iron, 0, 0, 0.36); add(new THREE.BoxGeometry(0.2, 0.32, 0.2), lanternGlass, 0, 0, 0.36, fb, false);
  });
  for (const s of [-1, 1]) lantern(s * (W / 2 + 0.06), D / 2 - 0.5, s * Math.PI / 2, 2.5, (fb) => { // (on the corners, on the side walls)
    lB(fb, 0.06, 0.06, 0.16, iron, 0, 0.24, 0.1);
    lB(fb, 0.26, 0.4, 0.26, iron, 0, 0, 0.26); add(new THREE.BoxGeometry(0.2, 0.32, 0.2), lanternGlass, 0, 0, 0.26, fb, false);
  });
  // a brass plate by the door: what it is
  { const pl = makeSign('POLIZEIINSPEKTION\nPrison · visits welcome', { w: 1.0, h: 0.5, bg: '#f2ede0', fg: '#14263f', border: '#b08d4a', font: 'bold 96px Georgia' });
    pl.position.set(DX + 1.55, 1.55, D / 2 + 0.04); house.add(pl); }

  // ---- snow banked against the walls (the Meshy drifts: long wind-blown banks, a heap in the back corners, low
  // mounds in front; overlapping so they read as one bank, sunk a little), deeper at the back and sides
  const drift = (kind, x, z, len, wid, h, rot = 0, y = -0.04) => { const d = snowDrift(kind, len, wid, h); d.position.set(x, y, z); d.rotation.y = rot; g.add(d); return d; };
  { const r = rng(17), flip = () => (r() < 0.5 ? 0 : Math.PI), back = BZ - D / 2;
    // the back wall: long banks end to end (their lee side against the stone)
    for (let x = -W / 2 + 1.9; x < W / 2 - 1.2; x += 3.1 + r() * 0.5) { const wid = 1.4 + r() * 0.4; drift('long', x, back - wid * 0.32, 3.8 + r() * 0.8, wid, 0.6 + r() * 0.3, flip() + (r() - 0.5) * 0.1); }
    // the sides, back to front, lower toward the front
    for (const sx of [-1, 1]) for (let z = back + 1.6; z < FRONT - 0.9; z += 2.8 + r() * 0.4) {
      const k = (z - back) / D, wid = 1.25 - 0.3 * k + r() * 0.25;
      drift('long', sx * (W / 2 + wid * 0.3), z, 3.4 + r() * 0.6, wid, 0.75 - 0.3 * k + r() * 0.2, Math.PI / 2 + flip() + (r() - 0.5) * 0.12);
    }
    // the back corners: a deeper heap; the front corners: a low mound
    for (const sx of [-1, 1]) { drift('heap', sx * (W / 2 + 0.35), back - 0.35, 2.7, 2.5, 1.0, r() * 6); drift('mound', sx * (W / 2 + 0.25), FRONT + 0.15, 1.7, 1.2, 0.42, r() * 6); }
    // the front: only a little against the stone, either side of the door (the forecourt is ploughed)
    for (const x of [-7.6, -5.3, 0.4, 2.6, 4.9, 7.3]) drift('mound', x, FRONT + 0.12, 1.6 + r() * 0.5, 0.7, 0.24 + r() * 0.1, flip());
    // the ploughed snow along the forecourt's sides (on the ground's slope), a heap at each front corner (off the road)
    for (const sx of [-1, 1]) {
      for (let z = 0.6; z < L.hd - 3.5; z += 2.3 + r() * 0.3) { const x = sx * (L.hw - 0.6); drift('long', x, z, 2.9 + r() * 0.5, 1.1 + r() * 0.3, 0.45 + r() * 0.2, Math.PI / 2 + flip() + (r() - 0.5) * 0.15, gy(x, z) - 0.02); }
      const x = sx * (L.hw - 0.3), z = L.hd - 3.4; drift('heap', x, z, 2.4, 2.0, 0.85, r() * 6, gy(x, z) - 0.03);
    }
  }

  // ---- the forecourt: packed snow over asphalt from the house to the road, the bays, fading into the snow at its sides
  const X0 = -L.hw + 1.4, X1 = L.hw - 1.4, Z0 = FRONT - 0.2, Z1 = L.hd + 0.5, YW = X1 - X0, YD = Z1 - Z0;
  const yardT = canvasTex(1024, 512, (c, cw, ch) => {
    const r = rng(9), X = (lx) => ((lx - X0) / YW) * cw, Z = (lz) => ((lz - Z0) / YD) * ch;
    c.fillStyle = '#7d7b77'; c.fillRect(0, 0, cw, ch);
    for (let i = 0; i < 9000; i++) { const v = 100 + r() * 40; c.fillStyle = `rgba(${v + 6},${v + 3},${v},0.4)`; c.fillRect(r() * cw, r() * ch, 2, 2); }
    for (let i = 0; i < 70; i++) { const x = r() * cw, y = r() * ch, R = 20 + r() * 80, gr = c.createRadialGradient(x, y, 0, x, y, R); gr.addColorStop(0, 'rgba(236,238,240,0.45)'); gr.addColorStop(1, 'rgba(236,238,240,0)'); c.fillStyle = gr; c.fillRect(x - R, y - R, 2 * R, 2 * R); }
    // the path to the door: swept stone flags
    c.fillStyle = 'rgba(150,146,138,0.55)'; c.fillRect(X(DX - 1.3), Z(Z0), X(DX + 1.3) - X(DX - 1.3), Z(5.5) - Z(Z0));
    c.strokeStyle = 'rgba(246,246,240,0.92)'; c.lineWidth = 5;
    for (const lx of BAYS.lines) { c.beginPath(); c.moveTo(X(lx), Z(BAYS.z0)); c.lineTo(X(lx), Z(BAYS.z1)); c.stroke(); }
    c.beginPath(); c.moveTo(X(BAYS.lines[0]), Z(BAYS.z1)); c.lineTo(X(BAYS.lines.at(-1)), Z(BAYS.z1)); c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    BAYS.lines.slice(0, -1).forEach((lx, i) => {
      c.save(); c.translate(X(lx + 1.35), Z(BAYS.z1 - 1.0)); c.rotate(Math.PI); // (read from the road)
      c.fillStyle = i < 2 ? 'rgba(80,140,255,0.95)' : 'rgba(246,246,240,0.92)'; c.font = 'bold 30px Arial'; c.fillText(i < 2 ? 'POLIZEI' : 'BESUCH', 0, 0); c.restore();
    });
    c.globalCompositeOperation = 'destination-in';
    const fx = c.createLinearGradient(0, 0, cw, 0); fx.addColorStop(0, 'rgba(0,0,0,0)'); fx.addColorStop(0.045, '#000'); fx.addColorStop(0.955, '#000'); fx.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = fx; c.fillRect(0, 0, cw, ch);
  });
  const yard = new THREE.Mesh(new THREE.PlaneGeometry(YW, YD, 28, 16), new THREE.MeshStandardMaterial({ map: yardT, roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  yard.receiveShadow = true;
  { const pa = yard.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) { const lx = (X0 + X1) / 2 + pa.getX(i), lz = (Z0 + Z1) / 2 - pa.getY(i); pa.setXYZ(i, lx, gy(lx, lz) + 0.04, lz); }
    pa.needsUpdate = true; yard.geometry.computeVertexNormals(); }
  yard.renderOrder = 1; g.add(yard);
  // granite kerbs along the forecourt's sides
  const kerb = new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.85 });
  for (const sx of [-1, 1]) for (let z = Z0 + 0.4; z < L.hd - 2.5; z += 2) { const lx = sx * (X1 - 0.3); B(0.22, 0.16, 1.96, kerb, lx, gy(lx, z + 1) + 0.06, z + 1); }

  // ---- flags (blue-white POLIZEI banners), potted spruces by the door, the patrol car in its bay, the signpost
  const banner = canvasTex(128, 512, (c, cw, ch) => {
    c.fillStyle = '#123e86'; c.fillRect(0, 0, cw, ch); c.fillStyle = '#f2f4f8'; c.fillRect(0, ch * 0.62, cw, ch * 0.38);
    drawBadge(c, cw / 2, ch * 0.26, cw * 0.36);
    c.save(); c.translate(cw / 2, ch * 0.81); c.rotate(-Math.PI / 2); c.fillStyle = '#123e86'; c.font = 'bold 40px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('POLIZEI', 0, 2); c.restore();
  });
  const bannerMat = new THREE.MeshStandardMaterial({ map: banner, roughness: 0.8, side: THREE.DoubleSide });
  const colliders = [];
  for (const lx of [-L.hw + 1.0, -L.hw + 2.6]) {
    const lz = L.hd - 2.2, y = gy(lx, lz);
    add(new THREE.CylinderGeometry(0.05, 0.06, 7, 10), iron, lx, y + 3.2, lz);
    add(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.9, roughness: 0.3 }), lx, y + 6.75, lz);
    add(new THREE.BoxGeometry(0.04, 0.04, 1.0), iron, lx, y + 6.4, lz - 0.48);
    const b = add(new THREE.PlaneGeometry(0.9, 3.4), bannerMat, lx, y + 4.68, lz - 0.48, g, false); b.rotation.y = Math.PI / 2;
    const p = w(lx, lz); colliders.push({ x: p.x, z: p.z, r: 0.15 });
  }
  const potMat = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.7 });
  for (const lx of [DX - 2.4, DX + 2.4]) {
    const lz = FRONT + 0.75;
    add(new THREE.CylinderGeometry(0.42, 0.34, 0.7, 20), potMat, lx, 0.35, lz);
    add(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 20), snow, lx, 0.71, lz);
    if (models.pine_tree) { const t = fitModel(models.pine_tree, { size: 2.2, axis: 'y' }); t.position.set(lx, 0.62, lz); t.traverse((m) => { if (m.isMesh) m.castShadow = true; }); g.add(t); }
    else { add(new THREE.ConeGeometry(0.55, 1.9, 10), new THREE.MeshStandardMaterial({ color: 0x24402c, roughness: 0.9 }), lx, 1.6, lz); }
    const p = w(lx, lz); colliders.push({ x: p.x, z: p.z, r: 0.45 });
  }
  for (const x of [porch.x0, porch.x1]) { const p = w(x, BZ + porch.z); colliders.push({ x: p.x, z: p.z, r: 0.16 }); }
  // the patrol car, nose to the house, in the first POLIZEI bay (lights off)
  try {
    const car = buildPoliceCar(models);
    const cx = BAYS.lines[0] + 1.35, cz = (BAYS.z0 + BAYS.z1) / 2;
    car.g.position.set(cx, gy(cx, cz) + 0.02, cz); car.g.rotation.y = Math.PI;
    car.g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    for (const s of car.glows || []) s.material.opacity = 0;
    g.add(car.g);
    const p = w(cx, cz), sz = car.size || { x: 1.9, z: 4.7 };
    colliders.push({ x: p.x, z: p.z, hw: sz.x / 2 + 0.05, hd: sz.z / 2 + 0.05, rot: -(yaw0 + Math.PI) });
  } catch (e) { console.warn('prison: patrol car', e); }
  // the signpost at the forecourt's mouth, facing the road
  let postMat = null;
  try {
    const lx = DX - 4.6, lz = L.hd - 2.6, p = w(lx, lz);
    const post = makeSign('POLIZEI · PRISON\nVisitors welcome', { w: 2.4, h: 0.9, bg: '#0d3a7a', fg: '#ffffff', border: '#dfe8f5', font: 'bold 100px Arial', posts: true, postH: 1.1, pole: models.sign_pole });
    P.scene.add(standSign(post, p.x, p.z, yaw0));
    postMat = post.userData.faceMaterial;
    colliders.push({ x: p.x, z: p.z, hw: 1.25, hd: 0.15, rot: -yaw0 });
  } catch (e) { console.warn('prison sign', e); }

  P.scene.add(g);
  g.updateMatrixWorld(true);
  // ---- solid: the house (its stone walls), a camera blocker the same size
  const c = w(0, BZ);
  colliders.push({ x: c.x, z: c.z, hw: W / 2 + 0.12, hd: D / 2 + 0.12, rot: -yaw0 });
  P.colliders?.push(...colliders);
  const blk = new THREE.Mesh(new THREE.BoxGeometry(W + 0.2, Hw + RISE, D + 0.2), new THREE.MeshBasicMaterial());
  blk.position.set(0, (Hw + RISE) / 2, 0); blk.visible = false; house.add(blk); blk.updateMatrixWorld(true);
  P.cameraBlockers?.push(blk);
  const d = w(DX, FRONT + 2.6);
  return {
    group: g, colliders,
    house, // (the house itself: its frame is the interior's windows' frame, prison.js; hidden in their view)
    door: { x: d.x, z: d.z, yaw: yaw0 },
    update(n, t) {
      sign.userData.faceMaterial.emissiveIntensity = 0.06 + 0.85 * n;
      if (postMat) postMat.emissiveIntensity = 0.05 + 0.3 * n;
      lamp.userData.glass.emissiveIntensity = 0.5 + 2.6 * n * (0.8 + 0.2 * Math.sin(t * 2.4));
      lanternGlass.emissiveIntensity = 0.25 + 2.4 * n;
      for (const m of lanternMats) m.emissiveIntensity = 0.05 + 1.6 * n;
      winLit.emissiveIntensity = 0.3 + 1.1 * n;
      winCell.emissiveIntensity = 0.06 + 0.35 * n;
    },
  };
}
