// The MEDICAL CENTRE ("ARZT · MEDICAL CENTRE"): an alpine two-storey house on its lot right on a village road
// (game/bus/roads.js planHospital: the lot's edge on the road's edge, the door facing the road), built like the police
// station next door in style (game/prisonoutside.js) with the Autohaus's materials (carrentalshell.js shellMaterials):
// a white-rendered ground floor on a stone plinth sunk into the ground, stone quoins, a larch upper floor, the gable to
// the road with a red cross in it, a deep snow-laden roof with a rounded lip, red-and-white shutters, warm windows lit
// at night, a covered ambulance bay over the entrance (its NOTAUFNAHME gable lit at night, downlights under it), the
// lit ARZT board, a red-cross light box on a bracket, the Meshy wall lanterns / lamp posts / benches, the Meshy snow
// drifts banked against the walls, and a ploughed forecourt (the AMBULANZ drop-off box under the canopy, an AMBULANZ
// bay, visitors' bays) fading into the snow at its sides. The ambulance pulls up under the canopy
// (game/heli/ambulance.js: 6 m out from H.ex/H.ez, the door step) and you come round 2 m out from the door.
//
// Lot frame (as prisonoutside.js): origin at the lot's middle on the road's height, +z toward the road (its edge at
// z = L.hd), +x along it. The house: W (x) x D (z), its ridge along z, its front gable (the door) at z FRONT.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { groundPatchGeometry, groundDecal } from '../world/groundpatch.js'; // (paving on the drawn terrain's own triangles)
import { makeSign, standSign, nightUniform, addNightGlow } from '../world/village.js';
import { fitModel } from '../core/assets.js';
import { shellMaterials } from './carrentalshell.js';
import { snowDrift, swapInModel, parkingSigns, driftsReady } from './prisonoutside.js';
import { busRoads, HOSPITAL_LOT } from './bus/roads.js';
import { mergeStatic } from '../engine/merge.js'; // (the house's boxes welded per material)

const FRONT = HOSPITAL_LOT.front; // (-1.6: roads.js puts the door step 0.6 m out from it, on x = 0)
export const HOUSE = { W: 15, D: 12, G: 3.4, Hw: 6.4, RISE: 3.4, EAVE: 1.3, GO: 1.0 };
const { W, D, G, Hw, RISE, EAVE, GO } = HOUSE;
const BZ = FRONT - D / 2;
const CAN = { hw: 3.7, z1: FRONT + 7.9, posts: [FRONT + 4.0, FRONT + 7.6], h: 3.75, rise: 0.75, eave: 0.45 }; // the ambulance canopy
const BAYS = { lines: [4.6, 7.4, 10.2, 13.0], z0: 0.0, z1: 5.4 }; // visitors (right)
const AMB = { x0: -9.9, x1: -5.5, z0: 0.0, z1: 7.0 }; // the AMBULANZ parking bay (left)
const DROP = { x0: -2.3, x1: 2.3, z0: FRONT + 1.6, z1: FRONT + 10.6 }; // the drop-off box under the canopy

const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function worldUV(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ay > 0.5) uv.setXY(i, p.getX(i), p.getZ(i)); else if (ax > 0.5) uv.setXY(i, p.getZ(i), p.getY(i)); else uv.setXY(i, p.getX(i), p.getY(i));
  }
  return geo;
}
const RED = '#c8102e';
/** A red cross (arm length r, arm half-width a) at (x, y) on a canvas. */
function drawCross(c, x, y, r, a = r * 0.34, col = RED) { c.fillStyle = col; c.fillRect(x - r, y - a, 2 * r, 2 * a); c.fillRect(x - a, y - r, 2 * a, 2 * r); }
/** Set c.font to `weight size family`, the size at most px and small enough for text to fit maxW (never squashed). */
function fitFont(c, text, weight, family, px, maxW) {
  c.font = `${weight} ${px}px ${family}`;
  const m = c.measureText(text).width;
  if (m > maxW) c.font = `${weight} ${Math.max(8, Math.floor((px * maxW) / m))}px ${family}`;
}

/** The MEDICAL CENTRE board (the village's sign style: a lettered face on a wooden back board), a red cross in a
 *  square field at either end, the lettering fitted between them (the canvas the board's own shape: nothing stretched);
 *  its face glows at night (userData.faceMaterial). */
export function arztSign(w = 5.2, h = 1.0) {
  const tex = canvasTex(1536, Math.round((1536 * h) / w), (c, cw, ch) => {
    c.fillStyle = '#f7f5ef'; c.fillRect(0, 0, cw, ch);
    const bw = Math.round(ch * 0.05); c.strokeStyle = RED; c.lineWidth = bw; c.strokeRect(bw, bw, cw - 2 * bw, ch - 2 * bw);
    const r = ch * 0.27, inset = bw * 2 + ch * 0.12; // (a cross either end, clear of the border)
    for (const x of [inset + r, cw - inset - r]) drawCross(c, x, ch / 2, r);
    const x0 = inset + 2 * r + ch * 0.18, maxW = cw - 2 * x0; // (the lettering's room between the crosses)
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#7a0a1c'; fitFont(c, 'MEDICAL CENTRE', 'bold', 'Georgia, "Times New Roman", serif', Math.round(ch * 0.4), maxW); c.fillText('MEDICAL CENTRE', cw / 2, ch * 0.4);
    c.fillStyle = '#5a4a3c'; fitFont(c, 'ARZT  ·  NOTAUFNAHME 24 h  ·  LEGACY VILLAGE', '600', 'Georgia, serif', Math.round(ch * 0.16), maxW); c.fillText('ARZT  ·  NOTAUFNAHME 24 h  ·  LEGACY VILLAGE', cw / 2, ch * 0.76);
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.05 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x3a2716, roughness: 0.85 });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, h + 0.14, 0.08), wood));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); face.position.z = 0.042; g.add(face);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.faceMaterial = mat;
  return g;
}

export class Hospital {
  /** o: { scene, models, colliders, cameraBlockers? }. Builds nothing without the planned lot (busRoads.hospital). */
  constructor({ scene, models = {}, colliders: shared, cameraBlockers }) {
    this.group = null;
    const L = busRoads.hospital;
    if (!L) return;
    const M = shellMaterials();
    const yaw0 = Math.atan2(L.dirx, L.dirz);
    const w = (lx, lz) => ({ x: L.x + L.dirz * lx + L.dirx * lz, z: L.z - L.dirx * lx + L.dirz * lz });
    const gy = (lx, lz) => { const p = w(lx, lz); return world.meshHeight(p.x, p.z) - L.y; }; // (the ground as drawn, lot frame)
    const g = new THREE.Group(); g.name = 'medical-centre';
    g.position.set(L.x, L.y, L.z); g.rotation.y = yaw0;
    const add = (geo, mat, x, y, z, parent = g, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m; };
    const B = (w_, h, d, mat, x, y, z, parent = g, shadow = true) => add(worldUV(new THREE.BoxGeometry(w_, h, d)), mat, x, y, z, parent, shadow);
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.8 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.45, metalness: 0.7 });
    const quoin = new THREE.MeshStandardMaterial({ color: 0xa8a49a, roughness: 0.9 });
    const plasterT = canvasTex(256, 256, (c, cw, ch) => {
      const r = rng(23); c.fillStyle = '#ece7dc'; c.fillRect(0, 0, cw, ch);
      for (let i = 0; i < 2600; i++) { const v = 205 + r() * 40; c.fillStyle = `rgba(${v},${v - 4},${v - 12},0.5)`; c.fillRect(r() * cw, r() * ch, 2, 2); }
    });
    plasterT.wrapS = plasterT.wrapT = THREE.RepeatWrapping; plasterT.repeat.set(1 / 2.5, 1 / 2.5);
    const plaster = new THREE.MeshStandardMaterial({ map: plasterT, roughness: 0.95 });
    // the shutters: red and white chevrons (the old Austrian painted shutters)
    const shutterT = canvasTex(128, 256, (c, cw, ch) => {
      c.fillStyle = '#f2efe8'; c.fillRect(0, 0, cw, ch); c.fillStyle = '#b3172b';
      for (let y = -40; y < ch + 40; y += 44) { c.beginPath(); c.moveTo(0, y); c.lineTo(cw / 2, y + 30); c.lineTo(cw, y); c.lineTo(cw, y + 20); c.lineTo(cw / 2, y + 50); c.lineTo(0, y + 20); c.closePath(); c.fill(); }
      c.strokeStyle = '#6e1020'; c.lineWidth = 8; c.strokeRect(4, 4, cw - 8, ch - 8);
    });
    const shutter = new THREE.MeshStandardMaterial({ map: shutterT, roughness: 0.7 });
    const winLit = new THREE.MeshStandardMaterial({ color: 0x8fa3b3, emissive: 0xffd9a0, emissiveIntensity: 0.35, roughness: 0.12, metalness: 0.2 });
    const glassDoor = new THREE.MeshStandardMaterial({ color: 0x9fb4c4, emissive: 0xfff0d8, emissiveIntensity: 0.4, roughness: 0.08, metalness: 0.3 });
    const downlight = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3e0, emissiveIntensity: 0.3 });
    const snow = M.snow;
    const house = new THREE.Group(); house.position.set(0, 0, BZ); g.add(house);

    // ---- walls: a stone plinth (sunk 0.45 m: no edge over the snow), the white ground floor, a dark beam, the larch upper floor
    B(W + 0.16, 1.0, D + 0.16, M.stone, 0, 0.05, 0, house);
    const walls = B(W, G - 0.5, D, plaster, 0, 0.55 + (G - 0.55) / 2 - 0.02, 0, house);
    B(W + 0.34, 0.26, D + 0.34, darkWood, 0, G + 0.02, 0, house);
    B(W, Hw - G, D, M.larchOut, 0, G + (Hw - G) / 2, 0, house);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 5; k++) { // (stone quoins at the corners)
      const y = 0.55 + k * 0.55, long = k % 2 === 0;
      B(long ? 0.7 : 0.4, 0.5, 0.08, quoin, sx * (W / 2 + 0.06 - (long ? 0.35 : 0.2)), y + 0.25, sz * (D / 2 + 0.07), house);
      B(0.08, 0.5, long ? 0.4 : 0.7, quoin, sx * (W / 2 + 0.07), y + 0.25, sz * (D / 2 + 0.06 - (long ? 0.2 : 0.35)), house);
    }
    // the gables (front and back, larch) and the roof: two slabs, the ridge along z, deep eaves; snow on each
    const gable = new THREE.Shape(); gable.moveTo(-W / 2, 0); gable.lineTo(W / 2, 0); gable.lineTo(0, RISE); gable.closePath();
    const gGeo = new THREE.ExtrudeGeometry(gable, { depth: 0.25, bevelEnabled: false });
    { const p = gGeo.attributes.position, uv = gGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i)); }
    for (const sz of [-1, 1]) add(gGeo, M.larchOut, 0, Hw, sz > 0 ? D / 2 - 0.25 : -D / 2, house);
    const k = RISE / (W / 2), run = W / 2 + EAVE, drop = RISE + k * EAVE, len = Math.hypot(run, drop), ang = Math.atan2(drop, run), RD = D + 2 * GO;
    for (const sx of [-1, 1]) {
      const nx = Math.sin(ang) * sx, ny = Math.cos(ang), cy = Hw + RISE - drop / 2, cx = sx * run / 2;
      const slab = B(len, 0.28, RD, M.roof, cx + nx * 0.14, cy + ny * 0.14, 0, house); slab.rotation.z = -sx * ang;
      const sn = B(len - 0.05, 0.38, RD + 0.1, snow, cx + nx * 0.47, cy + ny * 0.47, 0, house); sn.rotation.z = -sx * ang;
      const lip = add(new THREE.CylinderGeometry(0.21, 0.21, RD + 0.1, 10), snow, sx * (run - 0.05), Hw - k * EAVE + 0.33, 0, house); lip.rotation.x = Math.PI / 2; lip.scale.set(1.3, 1, 1);
      B(0.1, 0.34, RD, darkWood, sx * (run + 0.02), Hw - k * EAVE - 0.08, 0, house); // (the fascia)
      for (let z = -D / 2 - GO + 0.5; z <= D / 2 + GO - 0.4; z += 1.1) { const r = B(EAVE + 0.3, 0.18, 0.14, darkWood, sx * (W / 2 + EAVE / 2 - 0.15), Hw - k * (EAVE / 2) - 0.2, z, house, false); r.rotation.z = -sx * ang; }
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { // (the barge boards along the gables, a snow ridge on them)
      const b = B(len, 0.36, 0.1, darkWood, sx * run / 2, Hw + RISE - drop / 2 - 0.05, sz * (RD / 2 + 0.02), house); b.rotation.z = -sx * ang;
    }
    { const cx = -3.4, cz = -2.8, top = Hw + RISE - k * Math.abs(cx) + 1.3; // (a stone chimney, a cap of snow)
      B(0.75, 2.6, 0.75, M.stone, cx, top - 1.3, cz, house); B(0.95, 0.12, 0.95, darkWood, cx, top + 0.06, cz, house);
      const cap = add(new THREE.SphereGeometry(0.55, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), snow, cx, top + 0.1, cz, house); cap.scale.set(1, 0.4, 1); }

    // ---- windows, the door (a face: front +z, back -z, right +x, left -x; local x across it, +z out)
    const faces = {
      front: (o) => { o.position.set(0, 0, D / 2); return o; }, back: (o) => { o.position.set(0, 0, -D / 2); o.rotation.y = Math.PI; return o; },
      right: (o) => { o.position.set(W / 2, 0, 0); o.rotation.y = Math.PI / 2; return o; }, left: (o) => { o.position.set(-W / 2, 0, 0); o.rotation.y = -Math.PI / 2; return o; },
    };
    const F = {}; for (const [n, f] of Object.entries(faces)) { F[n] = f(new THREE.Group()); house.add(F[n]); }
    const win = (face, x, y, ww, wh, shut = true, z0 = 0.06) => {
      const p = F[face];
      B(ww + 0.2, wh + 0.2, 0.1, darkWood, x, y, z0, p, false);
      add(new THREE.PlaneGeometry(ww, wh), winLit, x, y, z0 + 0.052, p, false);
      B(0.06, wh, 0.05, darkWood, x, y, z0 + 0.07, p, false); B(ww, 0.06, 0.05, darkWood, x, y + wh * 0.12, z0 + 0.07, p, false);
      B(ww + 0.36, 0.08, 0.26, quoin, x, y - wh / 2 - 0.13, z0 + 0.1, p, false);
      B(ww + 0.3, 0.07, 0.22, snow, x, y - wh / 2 - 0.055, z0 + 0.11, p, false); // (snow on the sill)
      if (shut) for (const s of [-1, 1]) B(ww / 2 + 0.04, wh + 0.12, 0.05, shutter, x + s * (ww * 0.75 + 0.14), y, z0 + 0.04, p, false);
    };
    for (const x of [-5.2, 5.2]) { win('front', x, 1.8, 1.4, 1.3); win('front', x, G + 1.6, 1.2, 1.25); }
    win('front', 0, Hw + 1.0, 0.7, 0.9, false); // (the attic window under the gable's cross)
    for (const x of [-4.6, 0, 4.6]) { win('back', x, 1.8, 1.2, 1.2); win('back', x, G + 1.55, 1.2, 1.25); }
    for (const f of ['left', 'right']) for (const x of [-3.6, 0, 3.6]) { win(f, x, 1.8, 1.3, 1.25); win(f, x, G + 1.55, 1.2, 1.25); }
    // the entrance: a stone surround, sliding glass doors lit from inside, a transom, a granite step
    { const p = F.front, z0 = 0.05;
      B(3.1, 3.05, 0.16, quoin, 0, 1.52, z0, p);
      add(new THREE.PlaneGeometry(2.6, 2.5), glassDoor, 0, 1.25, z0 + 0.085, p, false);
      for (const x of [-1.3, 0, 1.3]) B(0.08, 2.5, 0.05, M.steel, x, 1.25, z0 + 0.1, p, false);
      B(2.7, 0.08, 0.05, M.steel, 0, 2.52, z0 + 0.1, p, false);
      add(new THREE.PlaneGeometry(2.6, 0.36), winLit, 0, 2.76, z0 + 0.085, p, false);
      B(3.4, 0.16, 1.2, quoin, 0, 0.02, z0 + 0.6, p);
    }
    // the red cross in the front gable (lit at night), the ARZT board over the canopy
    const crossT = canvasTex(256, 256, (c, cw, ch) => {
      c.fillStyle = '#ffffff'; c.beginPath(); c.arc(cw / 2, ch / 2, cw * 0.48, 0, Math.PI * 2); c.fill();
      c.strokeStyle = RED; c.lineWidth = 8; c.beginPath(); c.arc(cw / 2, ch / 2, cw * 0.45, 0, Math.PI * 2); c.stroke();
      drawCross(c, cw / 2, ch / 2, cw * 0.32, cw * 0.11);
    });
    const crossMat = new THREE.MeshStandardMaterial({ map: crossT, emissiveMap: crossT, emissive: 0xffffff, emissiveIntensity: 0.08, transparent: true, alphaTest: 0.5, roughness: 0.5 });
    add(new THREE.CircleGeometry(0.95, 40), darkWood, 0, Hw + 2.15, D / 2 + 0.03, house, false); // (a larch roundel behind it)
    add(new THREE.PlaneGeometry(1.7, 1.7), crossMat, 0, Hw + 2.15, D / 2 + 0.05, house, false);
    const sign = arztSign(5.2, 1.0); sign.position.set(0, G + 2.15, D / 2 + 0.06); house.add(sign);
    // the red-cross light box on a bracket at the front's right corner (seen along the road both ways)
    const boxT = canvasTex(256, 256, (c, cw, ch) => { c.fillStyle = '#ffffff'; c.fillRect(0, 0, cw, ch); c.strokeStyle = RED; c.lineWidth = 14; c.strokeRect(7, 7, cw - 14, ch - 14); drawCross(c, cw / 2, ch / 2, cw * 0.34, cw * 0.12); });
    const boxMat = new THREE.MeshStandardMaterial({ map: boxT, emissiveMap: boxT, emissive: 0xffffff, emissiveIntensity: 0.1, roughness: 0.4 });
    { const x = W / 2 - 0.9, y = G - 0.35, z = D / 2;
      B(0.05, 0.05, 0.75, iron, x, y + 0.5, z + 0.38, house, false); B(0.18, 0.3, 0.05, iron, x, y + 0.45, z + 0.03, house, false);
      const bx = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.8, 0.8), [boxMat, boxMat, M.steel, M.steel, M.steel, M.steel]);
      bx.position.set(x, y, z + 0.6); bx.castShadow = true; house.add(bx); }
    // the wall lanterns (the Meshy alpine iron lantern, tools/meshy-decor.mjs; a box lantern until it has loaded)
    const lanternGlass = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffc77a, emissiveIntensity: 0.25 });
    const lanternMats = [];
    const lantern = (x, z, ry, y) => {
      const lg = new THREE.Group(); lg.position.set(x, y, z); lg.rotation.y = ry; house.add(lg);
      const fb = new THREE.Group(); lg.add(fb);
      B(0.06, 0.06, 0.16, iron, 0, 0.24, 0.1, fb); B(0.26, 0.4, 0.26, iron, 0, 0, 0.26, fb); add(new THREE.BoxGeometry(0.2, 0.32, 0.2), lanternGlass, 0, 0, 0.26, fb, false);
      swapInModel(lg, 'decor/lantern_wall', { size: 0.72, axis: 'y' }, fb, (m) => {
        m.position.set(0, -0.3, 0.2);
        m.traverse((o) => { if (!o.isMesh || !o.material) return;
          o.material = o.material.clone(); o.castShadow = false;
          if (o.material.map) { o.material.emissiveMap = o.material.map; o.material.emissive = new THREE.Color(0xffc77a); o.material.emissiveIntensity = lanternGlass.emissiveIntensity; lanternMats.push(o.material); } });
      });
    };
    for (const s of [-1, 1]) { lantern(s * 2.05, D / 2 + 0.06, 0, 2.5); lantern(s * (W / 2 + 0.06), D / 2 - 0.6, s * Math.PI / 2, 2.6); }
    // (no plaque left of the door: Oct 30, the user asked it gone)

    // ---- the ambulance canopy over the entrance: four larch posts on stone footings, beams, a low gable roof with
    // snow, its front gable lettered NOTAUFNAHME (lit at night), downlights under it
    const LW = 2 * CAN.hw - 0.6, LH = 0.42; // (the lettered strip, m: its canvas the same shape)
    const canopyLetter = canvasTex(2048, Math.round((2048 * LH) / LW), (c, cw, ch) => {
      c.fillStyle = '#b3172b'; c.fillRect(0, 0, cw, ch);
      const q = Math.round(ch * 0.74), pad = Math.round(ch * 0.4); // (a white field with the red cross at either end)
      for (const x of [pad, cw - pad - q]) { c.fillStyle = '#ffffff'; c.fillRect(x, (ch - q) / 2, q, q); drawCross(c, x + q / 2, ch / 2, q * 0.38, q * 0.13); }
      const room = cw - 2 * (pad + q) - 2 * pad;
      c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle';
      fitFont(c, 'NOTAUFNAHME  ·  EMERGENCY', 'bold', 'Arial', Math.round(ch * 0.6), room); c.fillText('NOTAUFNAHME  ·  EMERGENCY', cw / 2, ch / 2 + ch * 0.03);
    });
    const letterMat = new THREE.MeshStandardMaterial({ map: canopyLetter, emissiveMap: canopyLetter, emissive: 0xffffff, emissiveIntensity: 0.08, roughness: 0.5 });
    const colliders = [];
    { const { hw, z1, posts, h, rise, eave } = CAN, zc = (FRONT + z1) / 2, cl = z1 - FRONT;
      for (const z of posts) for (const sx of [-1, 1]) {
        const x = sx * hw;
        B(0.24, h, 0.24, darkWood, x, h / 2 - 0.1, z); B(0.42, 0.3, 0.42, M.stone, x, 0.05, z);
        const p = w(x, z); colliders.push({ x: p.x, z: p.z, r: 0.24 });
      }
      for (const sx of [-1, 1]) B(0.2, 0.3, cl, darkWood, sx * hw, h - 0.05, zc); // (the side beams, into the wall)
      for (const z of posts) B(2 * hw + 0.2, 0.26, 0.2, darkWood, 0, h - 0.02, z);
      const hwR = hw + eave, cLen = Math.hypot(hwR, rise), ca = Math.atan2(rise, hwR);
      for (const sx of [-1, 1]) {
        const nx = Math.sin(ca) * sx, ny = Math.cos(ca), cx = sx * hwR / 2, cy = h + 0.1 + rise / 2;
        const s = B(cLen + 0.1, 0.16, cl + 0.3, M.roof, cx + nx * 0.08, cy + ny * 0.08, zc + 0.15); s.rotation.z = -sx * ca;
        const n = B(cLen, 0.26, cl + 0.25, snow, cx + nx * 0.28, cy + ny * 0.28, zc + 0.15); n.rotation.z = -sx * ca;
        const lip = add(new THREE.CylinderGeometry(0.14, 0.14, cl + 0.25, 8), snow, sx * (hwR - 0.04), h + 0.1 + 0.22, zc + 0.15); lip.rotation.x = Math.PI / 2; lip.scale.set(1.25, 1, 1);
        B(0.08, 0.26, cl + 0.3, darkWood, sx * (hwR + 0.02), h + 0.04, zc + 0.15);
      }
      // the front gable: the lettered red board on a larch triangle
      const tri = new THREE.Shape(); tri.moveTo(-hwR + 0.15, 0); tri.lineTo(hwR - 0.15, 0); tri.lineTo(0, rise - 0.05); tri.closePath();
      const tg = new THREE.ExtrudeGeometry(tri, { depth: 0.1, bevelEnabled: false });
      { const p = tg.attributes.position, uv = tg.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i)); }
      add(tg, M.larchOut, 0, h + 0.12, z1 + 0.12);
      add(new THREE.PlaneGeometry(LW, LH), letterMat, 0, h - 0.02, z1 + 0.235, g, false);
      B(2 * hw + 0.3, 0.5, 0.08, darkWood, 0, h - 0.02, z1 + 0.19);
      for (const z of [FRONT + 1.6, FRONT + 4.0 + 1.8, FRONT + 6.4]) { const d = add(new THREE.PlaneGeometry(1.2, 0.3), downlight, 0, h - 0.18, z, g, false); d.rotation.x = Math.PI / 2; }
    }

    // ---- snow banked against the walls (the Meshy drifts, prisonoutside.js snowDrift): long banks at the back and
    // sides, heaps in the back corners, low mounds at the front corners (the forecourt itself is ploughed)
    const drifts = new THREE.Group(); drifts.name = 'medical-centre-drifts'; g.add(drifts); // (welded into one mesh once the Meshy drifts have loaded: below)
    const drift = (kind, x, z, len, wid, h, rot = 0, y = -0.04) => { const d = snowDrift(kind, len, wid, h); d.position.set(x, y, z); d.rotation.y = rot; drifts.add(d); return d; };
    { const r = rng(31), back = BZ - D / 2, flip = () => (r() < 0.5 ? 0 : Math.PI);
      for (let x = -W / 2 + 1.9; x < W / 2 - 1.2; x += 3.1 + r() * 0.5) { const wid = 1.4 + r() * 0.4; drift('long', x, back - wid * 0.32, 3.8 + r() * 0.8, wid, 0.6 + r() * 0.3, flip() + (r() - 0.5) * 0.1); }
      for (const sx of [-1, 1]) for (let z = back + 1.8; z < FRONT - 1.5; z += 3.0 + r() * 0.5) {
        const wid = 1.2 + r() * 0.3;
        drift('long', sx * (W / 2 + wid * 0.3), z, 3.4 + r() * 0.6, wid, 0.6 + r() * 0.2, Math.PI / 2 + flip() + (r() - 0.5) * 0.12);
      }
      for (const sx of [-1, 1]) { drift('heap', sx * (W / 2 + 0.35), back - 0.35, 2.7, 2.5, 1.0, r() * 6); drift('mound', sx * (W / 2 + 0.25), FRONT + 0.15, 1.7, 1.2, 0.42, r() * 6); }
      // the ploughed snow along the forecourt's sides, a heap at each front corner (kept off the road)
      for (const sx of [-1, 1]) {
        for (let z = 0.6; z < L.hd - 3.5; z += 2.3 + r() * 0.3) { const x = sx * (L.hw - 0.6); drift('long', x, z, 2.9 + r() * 0.5, 1.1 + r() * 0.3, 0.45 + r() * 0.2, Math.PI / 2 + flip() + (r() - 0.5) * 0.15, gy(x, z) - 0.02); }
        const x = sx * (L.hw - 0.3), z = L.hd - 3.4; drift('heap', x, z, 2.4, 2.0, 0.85, r() * 6, gy(x, z) - 0.03);
      }
    }

    // ---- the forecourt: packed snow over asphalt from the house to the road, the AMBULANZ box and bay, the visitors'
    // bays, fading into the snow at its sides
    const X0 = -L.hw + 1.4, X1 = L.hw - 1.4, Z0 = FRONT - 0.2, Z1 = L.hd + 0.5, YW = X1 - X0, YD = Z1 - Z0;
    const PXM = 1024 / YW; // (the canvas the forecourt's own shape: px per metre both ways, no stretched lettering)
    const yardT = canvasTex(1024, Math.round(YD * PXM), (c, cw, ch) => {
      const r = rng(13), X = (lx) => (lx - X0) * PXM, Z = (lz) => (lz - Z0) * PXM;
      c.fillStyle = '#7d7b77'; c.fillRect(0, 0, cw, ch);
      for (let i = 0; i < 9000; i++) { const v = 100 + r() * 40; c.fillStyle = `rgba(${v + 6},${v + 3},${v},0.4)`; c.fillRect(r() * cw, r() * ch, 2, 2); }
      for (let i = 0; i < 70; i++) { const x = r() * cw, y = r() * ch, R = 20 + r() * 80, gr = c.createRadialGradient(x, y, 0, x, y, R); gr.addColorStop(0, 'rgba(236,238,240,0.45)'); gr.addColorStop(1, 'rgba(236,238,240,0)'); c.fillStyle = gr; c.fillRect(x - R, y - R, 2 * R, 2 * R); }
      // lettering read from the road, fitted inside its box (maxW x maxH metres; never past the lines)
      const text = (s_, lx, lz, col, maxW, maxH) => {
        c.save(); c.translate(X(lx), Z(lz)); c.rotate(Math.PI); c.fillStyle = col; c.textAlign = 'center'; c.textBaseline = 'middle';
        fitFont(c, s_, 'bold', 'Arial', Math.round(maxH * PXM * 1.3), maxW * PXM); c.fillText(s_, 0, 0); c.restore();
      };
      // the drop-off box under the canopy: yellow, hatched toward the door, AMBULANZ across its road end (on the bare
      // asphalt: no patch behind it)
      const yel = 'rgba(240,196,40,0.92)', tz = DROP.z1 - 1.5;
      c.save(); c.beginPath(); c.rect(X(DROP.x0), Z(DROP.z0), X(DROP.x1) - X(DROP.x0), Z(tz - 1.3) - Z(DROP.z0)); c.clip();
      c.strokeStyle = 'rgba(240,196,40,0.55)'; c.lineWidth = 6;
      for (let t = -20; t < 40; t += 1.2) { c.beginPath(); c.moveTo(X(DROP.x0 + t), Z(DROP.z0)); c.lineTo(X(DROP.x0 + t - 10), Z(DROP.z1)); c.stroke(); }
      c.restore();
      c.strokeStyle = yel; c.lineWidth = 8; c.strokeRect(X(DROP.x0), Z(DROP.z0), X(DROP.x1) - X(DROP.x0), Z(DROP.z1) - Z(DROP.z0));
      c.beginPath(); c.moveTo(X(DROP.x0), Z(tz - 1.3)); c.lineTo(X(DROP.x1), Z(tz - 1.3)); c.stroke();
      text('AMBULANZ', 0, tz, yel, DROP.x1 - DROP.x0 - 0.9, 1.0);
      // the AMBULANZ parking bay (left: a yellow box, a cross in it; its board at its head says whose) and the visitors'
      // bays (right: lines only, their board at their heads)
      c.strokeStyle = yel; c.lineWidth = 6;
      c.strokeRect(X(AMB.x0), Z(AMB.z0), X(AMB.x1) - X(AMB.x0), Z(AMB.z1) - Z(AMB.z0));
      c.save(); c.translate(X((AMB.x0 + AMB.x1) / 2), Z((AMB.z0 + AMB.z1) / 2)); c.fillStyle = 'rgba(246,246,240,0.9)'; c.fillRect(-0.7 * PXM, -0.2 * PXM, 1.4 * PXM, 0.4 * PXM); c.fillRect(-0.2 * PXM, -0.7 * PXM, 0.4 * PXM, 1.4 * PXM); c.restore();
      c.strokeStyle = 'rgba(246,246,240,0.92)'; c.lineWidth = 5;
      for (const lx of BAYS.lines) { c.beginPath(); c.moveTo(X(lx), Z(BAYS.z0)); c.lineTo(X(lx), Z(BAYS.z1)); c.stroke(); }
      c.beginPath(); c.moveTo(X(BAYS.lines[0]), Z(BAYS.z1)); c.lineTo(X(BAYS.lines.at(-1)), Z(BAYS.z1)); c.stroke();
      c.globalCompositeOperation = 'destination-in';
      const fx = c.createLinearGradient(0, 0, cw, 0); fx.addColorStop(0, 'rgba(0,0,0,0)'); fx.addColorStop(0.045, '#000'); fx.addColorStop(0.955, '#000'); fx.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = fx; c.fillRect(0, 0, cw, ch);
    });
    // (the drawn terrain's own triangles under it, 4 cm up: world/groundpatch.js; before, a plane of its own laid on
    // world.height at its vertices: where the ground eases into the road's shoulder the terrain's 2 m triangles poked
    // up through it)
    g.updateMatrixWorld(true);
    const lotXZ = (x, z) => { const dx = x - L.x, dz = z - L.z; return [dx * L.dirz - dz * L.dirx, dx * L.dirx + dz * L.dirz]; };
    const yard = new THREE.Mesh(groundPatchGeometry([[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]].map(([lx, lz]) => { const p = w(lx, lz); return [p.x, p.z]; }), {
      lift: 0.04, toLocal: (v) => g.worldToLocal(v),
      uv: (x, z) => { const [lx, lz] = lotXZ(x, z); return [(lx - X0) / YW, 1 - (lz - Z0) / YD]; },
    }), groundDecal(new THREE.MeshStandardMaterial({ map: yardT, roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }))); // (a hair nearer, as the car parks)
    yard.receiveShadow = true;
    yard.renderOrder = 1; g.add(yard);
    const kerb = new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.85 });
    for (const sx of [-1, 1]) for (let z = Z0 + 0.4; z < L.hd - 2.5; z += 2) { const lx = sx * (X1 - 0.1); B(0.22, 0.16, 1.96, kerb, lx, gy(lx, z + 1) + 0.06, z + 1); }

    // ---- the parking signs at the bays' heads, as the police station's (prisonoutside.js parkingSigns): the blue P
    // with an additional panel, here with the red cross, dark red lettering and a red rim (Oct 30, the user: "put the
    // same boards for the hospital parking as for the police parking but matching the hospital"; no lettering in the bays)
    try {
      const parkSign = parkingSigns({ g, add, gy, w, colliders, yaw0, snow }, {
        ink: '#7a0a1c', rim: RED,
        badge: (c, x, y, r) => {
          c.fillStyle = '#ffffff'; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
          c.strokeStyle = RED; c.lineWidth = Math.max(3, r * 0.12); c.beginPath(); c.arc(x, y, r * 0.88, 0, Math.PI * 2); c.stroke();
          drawCross(c, x, y, r * 0.58, r * 0.2);
        },
      });
      parkSign((AMB.x0 + AMB.x1) / 2, AMB.z0 - 0.3, ['Ambulanz'], true, ['Nur Einsatzfahrzeuge', 'Emergency vehicles only']);
      parkSign((BAYS.lines[1] + BAYS.lines[2]) / 2, BAYS.z0 - 0.3, ['Besucher', 'Visitors'], true, ['Patienten & Besucher', 'Patients & visitors']);
    } catch (e) { console.warn('medical centre: parking signs', e); }

    // ---- the Meshy props: benches either side of the door, lamp posts at the forecourt's mouth, the signpost
    const prop = (name, size, axis, lx, lz, ry, col) => {
      if (!models[name]) return null;
      const m = fitModel(models[name], { size, axis });
      m.position.set(lx, gy(lx, lz) - 0.02, lz); m.rotation.y = ry;
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.add(m);
      const p = w(lx, lz);
      if (col) colliders.push(col.r ? { x: p.x, z: p.z, r: col.r } : { x: p.x, z: p.z, hw: col.hw, hd: col.hd, rot: -(yaw0 + ry) });
      return m;
    };
    for (const sx of [-1, 1]) prop('wooden_bench', 1.7, 'xz', sx * 5.2, FRONT + 0.75, 0, { hw: 0.9, hd: 0.4 });
    for (const sx of [-1, 1]) { const lamp = prop('lamp_post', 4.2, 'y', sx * (L.hw - 2.4), L.hd - 1.6, sx > 0 ? -Math.PI / 2 : Math.PI / 2, { r: 0.25 }); if (lamp) addNightGlow(lamp, 6); }
    // the Meshy forecourt props (tools/meshy-hospital-outside.mjs: decor/*): planters with little spruces either side of
    // the door, bollards before the canopy's front posts, a litter bin by the bench, a grit box by the AMBULANZ bay; a
    // procedural stand-in each until (or if never) its model loads
    { const larch = M.larchOut, steel = M.steel, red = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4 });
      const spruce = new THREE.MeshStandardMaterial({ color: 0x23402c, roughness: 0.9 }), grey = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.55, metalness: 0.4 });
      const yellow = new THREE.MeshStandardMaterial({ color: 0xe8b81c, roughness: 0.6 });
      const meshyProp = (name, fit, lx, lz, ry, stand, col) => {
        const pg = new THREE.Group(); pg.position.set(lx, gy(lx, lz) - 0.02, lz); pg.rotation.y = ry; g.add(pg);
        const fb = new THREE.Group(); pg.add(fb); stand(fb);
        swapInModel(pg, `decor/${name}`, fit, fb);
        const p = w(lx, lz);
        colliders.push(col.r ? { x: p.x, z: p.z, r: col.r } : { x: p.x, z: p.z, hw: col.hw, hd: col.hd, rot: -(yaw0 + ry) });
      };
      for (const sx of [-1, 1]) {
        meshyProp('planter_spruce', { size: 0.85, axis: 'xz' }, sx * 2.85, FRONT + 0.55, 0, (fb) => {
          B(0.8, 0.55, 0.8, larch, 0, 0.27, 0, fb);
          add(new THREE.ConeGeometry(0.3, 0.9, 10), spruce, 0, 0.95, 0, fb);
        }, { r: 0.45 });
        meshyProp('bollard_steel', { size: 0.9, axis: 'y' }, sx * CAN.hw, CAN.posts[1] + 1.7, 0, (fb) => {
          add(new THREE.CylinderGeometry(0.07, 0.075, 0.9, 12), steel, 0, 0.45, 0, fb);
          add(new THREE.CylinderGeometry(0.076, 0.076, 0.08, 12), red, 0, 0.72, 0, fb, false);
        }, { r: 0.12 });
      }
      meshyProp('litter_bin', { size: 1.0, axis: 'y' }, 6.55, FRONT + 0.45, 0, (fb) => {
        add(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), grey, 0, 0.25, 0, fb);
        add(new THREE.CylinderGeometry(0.22, 0.2, 0.55, 14), grey, 0, 0.72, 0, fb);
      }, { r: 0.3 });
      meshyProp('grit_box', { size: 1.0, axis: 'xz' }, -12.3, 1.2, Math.PI / 2, (fb) => {
        B(1.0, 0.62, 0.7, yellow, 0, 0.31, 0, fb);
      }, { hw: 0.52, hd: 0.37 });
    }
    let postMat = null;
    try {
      const lx = -11.2, lz = L.hd - 4.6, p = w(lx, lz);
      const post = makeSign('+ ARZT · MEDICAL CENTRE\nNotaufnahme 24 h', { w: 2.6, h: 0.9, bg: '#f7f5ef', fg: '#a3101f', border: RED, font: 'bold 92px Arial', posts: true, postH: 1.1, pole: models.sign_pole });
      scene.add(standSign(post, p.x, p.z, yaw0));
      postMat = post.userData.faceMaterial;
      colliders.push({ x: p.x, z: p.z, hw: 1.35, hd: 0.15, rot: -yaw0 });
    } catch (e) { console.warn('medical centre sign', e); }

    // (performance pass: the house and the forecourt's boxes welded per material; the walls keep their own mesh: their
    // onBeforeRender drives the night lighting below)
    try { const keep = new Set([walls]); mergeStatic(house, { keep }); mergeStatic(g, { keep, skip: [house, drifts] }); } catch (e) { console.warn('medical centre: merge', e); }
    // (the ~30 drifts: one mesh once the Meshy drifts have swapped in)
    driftsReady().then(() => { try { mergeStatic(drifts); } catch (e) { console.warn('medical centre: drifts merge', e); } });
    scene.add(g);
    g.updateMatrixWorld(true);
    // ---- solid: the house (its plinth), a camera blocker the same size
    const c = w(0, BZ);
    colliders.push({ x: c.x, z: c.z, hw: W / 2 + 0.16, hd: D / 2 + 0.16, rot: -yaw0 });
    this.colliders = colliders;
    shared?.push(...colliders);
    const blk = new THREE.Mesh(new THREE.BoxGeometry(W + 0.2, Hw + RISE, D + 0.2), new THREE.MeshBasicMaterial());
    blk.position.set(0, (Hw + RISE) / 2, 0); blk.visible = false; house.add(blk); blk.updateMatrixWorld(true);
    cameraBlockers?.push(blk);
    this.group = g;
    const d = w(0, FRONT + 2.6);
    this.door = { x: d.x, z: d.z, yaw: yaw0 };
    // night: everything lit follows the village's night value (no update call needed: checked when the walls draw)
    let lastN = -1;
    walls.onBeforeRender = () => {
      const n = nightUniform.value || 0;
      if (Math.abs(n - lastN) < 0.01) return;
      lastN = n;
      sign.userData.faceMaterial.emissiveIntensity = 0.06 + 0.85 * n;
      if (postMat) postMat.emissiveIntensity = 0.05 + 0.3 * n;
      crossMat.emissiveIntensity = 0.08 + 1.4 * n; boxMat.emissiveIntensity = 0.1 + 1.6 * n; letterMat.emissiveIntensity = 0.08 + 1.1 * n;
      lanternGlass.emissiveIntensity = 0.25 + 2.4 * n; for (const m of lanternMats) m.emissiveIntensity = 0.25 + 2.4 * n;
      winLit.emissiveIntensity = 0.3 + 1.1 * n; glassDoor.emissiveIntensity = 0.4 + 1.2 * n; downlight.emissiveIntensity = 0.3 + 2.2 * n;
    };
  }
}
