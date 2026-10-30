// The PRISON's cells, furnished like a small Swiss police holding cell (game/prison.js's PrisonRoom builds the room,
// the bars and the lights; this fills each cell): a powder-coated steel bunk welded to the side wall (thin vinyl
// mattresses, a grey wool blanket, flat pillows), a brushed stainless combi unit (seatless toilet + basin) bolted to
// the wall in the back corner, a wall-mounted steel table and shelf, a stool bolted to the floor, an epoxy floor with
// a drain, a caged recessed ceiling light, a concrete reveal round the high barred window (its daylight spilling in),
// the intercom by the bars, a food hatch and kick plate on the door, tally marks scratched into the paint.
// Everything procedural (crisp edges, no melted Meshy geometry), with soft contact shadows under each piece.
//
//   blockWallMaterial(len, seed, H)  painted concrete block (dark lower band, joints in relief, grime, scuffs)
//   buildCells(scene, { cells, cellW, room })  -> { obstacles: [[x0, x1, z0, z1]...], update(day) }
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
function canvasTex(w, h, draw, { srgb = true, repeat = null } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

// ---------------------------------------------------------------- the walls: painted concrete block
const BAND = 1.15; // m: the dark lower band's top
const wallCache = new Map();
function blockWallCanvases(seed, H) {
  const key = `${seed}:${H}`;
  if (wallCache.has(key)) return wallCache.get(key);
  // 2 m wide x the wall's height; blocks 0.4 x 0.2 m laid from the floor up
  const W = 1024, HP = 1024, pxH = HP / H, pxW = W / 2, bw = 0.4 * pxW, bh = 0.2 * pxH;
  const bandY = HP - BAND * pxH;
  const r = rng(seed * 7919 + 13);
  const color = document.createElement('canvas'); color.width = W; color.height = HP;
  const g = color.getContext('2d');
  g.fillStyle = '#cfcdc3'; g.fillRect(0, 0, W, bandY);
  g.fillStyle = '#56625e'; g.fillRect(0, bandY, W, HP - bandY);
  // each block a touch different (the paint never quite hides the block)
  for (let row = 0; row * bh < HP; row++) {
    const y = HP - (row + 1) * bh, off = (row % 2) * bw / 2;
    for (let x = -off; x < W; x += bw) {
      const v = r();
      g.fillStyle = v > 0.5 ? `rgba(255,255,250,${(v - 0.5) * 0.08})` : `rgba(20,22,18,${(0.5 - v) * 0.09})`;
      g.fillRect(x, y, bw, bh);
    }
  }
  // the pores: speckle
  for (let i = 0; i < 26000; i++) {
    const v = r(); g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
    g.fillRect(r() * W, r() * HP, 1 + r() * 2, 1 + r() * 2);
  }
  // the joints: a dark mortar line with a faint lit lip under it
  for (let row = 0; row * bh < HP + bh; row++) {
    const y = HP - row * bh, off = (row % 2) * bw / 2;
    g.fillStyle = 'rgba(30,32,28,0.26)'; g.fillRect(0, y - 2, W, 3);
    g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(0, y + 1, W, 2);
    for (let x = -off; x < W + bw; x += bw) { g.fillStyle = 'rgba(30,32,28,0.22)'; g.fillRect(x - 1, y - bh, 3, bh); }
  }
  // the band's edge: a dark painted stripe
  g.fillStyle = '#323b38'; g.fillRect(0, bandY - 5, W, 6);
  // grime: hands at 0.9..1.6 m, long faint streaks, the floor's dirt creeping up
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(70,62,48,${0.025 + r() * 0.04})`;
    g.beginPath(); g.ellipse(r() * W, HP - (0.9 + r() * 0.7) * pxH, 10 + r() * 40, 8 + r() * 26, r() * 3, 0, 7); g.fill();
  }
  for (let i = 0; i < 14; i++) {
    const x = r() * W, y0 = r() * bandY * 0.6, len = 60 + r() * 260;
    const gr = g.createLinearGradient(0, y0, 0, y0 + len); gr.addColorStop(0, 'rgba(95,88,70,0)'); gr.addColorStop(0.3, `rgba(95,88,70,${0.04 + r() * 0.05})`); gr.addColorStop(1, 'rgba(95,88,70,0)');
    g.fillStyle = gr; g.fillRect(x, y0, 2 + r() * 5, len);
  }
  { const gr = g.createLinearGradient(0, HP, 0, HP - 0.35 * pxH); gr.addColorStop(0, 'rgba(25,24,20,0.38)'); gr.addColorStop(1, 'rgba(25,24,20,0)'); g.fillStyle = gr; g.fillRect(0, HP - 0.35 * pxH, W, 0.35 * pxH); }
  // scuffs on the band: shoe marks (dark), scraped paint (light), and a few chips higher up
  for (let i = 0; i < 70; i++) {
    const x = r() * W, y = HP - (0.06 + r() * 0.7) * pxH, l = 6 + r() * 34;
    g.strokeStyle = r() < 0.55 ? `rgba(10,10,10,${0.12 + r() * 0.2})` : `rgba(190,192,182,${0.08 + r() * 0.14})`;
    g.lineWidth = 1 + r() * 2.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (r() - 0.5) * 8); g.stroke();
  }
  for (let i = 0; i < 18; i++) {
    const x = r() * W, y = r() * HP, s = 2 + r() * 6;
    g.fillStyle = y > bandY ? 'rgba(170,172,164,0.45)' : 'rgba(120,118,108,0.4)';
    g.beginPath(); g.moveTo(x, y); for (let k = 1; k < 6; k++) { const a = k * 1.256 + r() * 0.5; g.lineTo(x + Math.cos(a) * s * (0.6 + r() * 0.6), y + Math.sin(a) * s * (0.6 + r() * 0.6)); } g.fill();
  }
  // the relief: the joints sunk, the block face a little rough
  const bump = document.createElement('canvas'); bump.width = W; bump.height = HP;
  const b = bump.getContext('2d');
  b.fillStyle = '#c8c8c8'; b.fillRect(0, 0, W, HP);
  for (let i = 0; i < 18000; i++) { const v = 150 + r() * 100 | 0; b.fillStyle = `rgb(${v},${v},${v})`; b.fillRect(r() * W, r() * HP, 1 + r() * 2, 1 + r() * 2); }
  b.filter = 'blur(1.2px)';
  b.fillStyle = '#5a5a5a';
  for (let row = 0; row * bh < HP + bh; row++) {
    const y = HP - row * bh, off = (row % 2) * bw / 2;
    b.fillRect(0, y - 3, W, 5);
    for (let x = -off; x < W + bw; x += bw) b.fillRect(x - 2, y - bh, 5, bh);
  }
  b.filter = 'none';
  const out = { color, bump };
  wallCache.set(key, out);
  return out;
}
/** A painted concrete block wall material for a face `len` metres long (the texture spans 2 m x the wall's height). */
export function blockWallMaterial(len, seed = 1, H = 3.3) {
  const { color, bump } = blockWallCanvases(seed, H);
  const map = new THREE.CanvasTexture(color); map.colorSpace = THREE.SRGBColorSpace;
  const bumpMap = new THREE.CanvasTexture(bump);
  for (const t of [map, bumpMap]) { t.anisotropy = 8; t.wrapS = THREE.RepeatWrapping; t.repeat.set(len / 2, 1); }
  return new THREE.MeshStandardMaterial({ map, bumpMap, bumpScale: 1.6, roughness: 0.82, metalness: 0 });
}

// ---------------------------------------------------------------- shared materials and textures (built once)
let MATS = null;
function mats() {
  if (MATS) return MATS;
  const brushed = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#b9bec1'; g.fillRect(0, 0, w, h);
    const r = rng(41);
    for (let i = 0; i < 1400; i++) { const v = 160 + r() * 80 | 0; g.fillStyle = `rgba(${v},${v + 3},${v + 5},0.35)`; g.fillRect(0, r() * h, w, 1); }
    for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(120,125,120,0.08)'; g.beginPath(); g.arc(r() * w, r() * h, 2 + r() * 8, 0, 7); g.fill(); } // (water spots)
  }, { repeat: [2, 2] });
  const steelRough = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, w, h);
    const r = rng(43); for (let i = 0; i < 900; i++) { const v = 90 + r() * 90 | 0; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, r() * h, w, 1); }
  }, { srgb: false, repeat: [2, 2] });
  const powder = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#8b9398'; g.fillRect(0, 0, w, h);
    const r = rng(47);
    for (let i = 0; i < 5000; i++) { const v = r(); g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'; g.fillRect(r() * w, r() * h, 1.5, 1.5); }
    for (let i = 0; i < 26; i++) { g.strokeStyle = `rgba(60,62,60,${0.15 + r() * 0.25})`; g.lineWidth = 1; const x = r() * w, y = r() * h; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 40, y + (r() - 0.5) * 6); g.stroke(); } // (scratches)
  }, { repeat: [1, 1] });
  const vinyl = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#2f3b47'; g.fillRect(0, 0, w, h);
    const r = rng(53); for (let i = 0; i < 6000; i++) { const v = r(); g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)'; g.fillRect(r() * w, r() * h, 2, 2); }
    g.strokeStyle = 'rgba(15,20,26,0.6)'; g.lineWidth = 3; g.strokeRect(8, 8, w - 16, h - 16); // (the welted seam)
    g.strokeStyle = 'rgba(120,135,150,0.12)'; g.lineWidth = 1; g.strokeRect(11, 11, w - 22, h - 22);
    for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(200,210,220,${0.03 + r() * 0.03})`; g.beginPath(); g.ellipse(r() * w, r() * h, 20 + r() * 40, 10 + r() * 30, r() * 3, 0, 7); g.fill(); } // (worn shine)
  });
  const wool = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#6d6f6c'; g.fillRect(0, 0, w, h);
    const r = rng(59);
    for (let i = 0; i < 16000; i++) { const v = 70 + r() * 70 | 0; g.fillStyle = `rgba(${v},${v + 1},${v - 2},0.45)`; g.fillRect(r() * w, r() * h, 1 + r() * 2, 1); }
    for (const y of [0.12, 0.17]) { g.fillStyle = 'rgba(40,44,52,0.55)'; g.fillRect(0, y * h, w, 0.025 * h); } // (the stripes near the edge)
    for (const y of [0.83, 0.88]) { g.fillStyle = 'rgba(40,44,52,0.55)'; g.fillRect(0, y * h, w, 0.025 * h); }
  });
  const cotton = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#e4e1d8'; g.fillRect(0, 0, w, h);
    const r = rng(61); for (let i = 0; i < 2500; i++) { const v = r(); g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.2)' : 'rgba(120,115,100,0.12)'; g.fillRect(r() * w, r() * h, 1.5, 1.5); }
  });
  // a soft dark blob: fake contact shadow under each piece (multiplied over the floor and walls)
  const blob = canvasTex(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  // the dark inside of the bowl and the basin, seen from above
  const hollow = canvasTex(256, 256, (g, w, h) => {
    const gr = g.createRadialGradient(w * 0.5, h * 0.55, 4, w / 2, h / 2, w / 2);
    gr.addColorStop(0, '#10161a'); gr.addColorStop(0.35, '#2a3236'); gr.addColorStop(0.8, '#7d8488'); gr.addColorStop(1, '#a9afb2');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(160,190,205,0.12)'; g.beginPath(); g.ellipse(w * 0.5, h * 0.56, w * 0.17, h * 0.13, 0, 0, 7); g.fill(); // (a little water)
  });
  MATS = {
    powder: new THREE.MeshStandardMaterial({ map: powder, color: 0xffffff, metalness: 0.35, roughness: 0.48 }),
    stainless: new THREE.MeshStandardMaterial({ map: brushed, roughnessMap: steelRough, color: 0xffffff, metalness: 0.92, roughness: 0.42 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x3b4044, metalness: 0.75, roughness: 0.4 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xe6eaec, metalness: 1, roughness: 0.15 }),
    vinyl: new THREE.MeshStandardMaterial({ map: vinyl, roughness: 0.5, metalness: 0 }),
    wool: new THREE.MeshStandardMaterial({ map: wool, roughness: 1, metalness: 0 }),
    cotton: new THREE.MeshStandardMaterial({ map: cotton, roughness: 0.92, metalness: 0 }),
    hollow: new THREE.MeshStandardMaterial({ map: hollow, metalness: 0.6, roughness: 0.3 }),
    blob: new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    whitePaint: new THREE.MeshStandardMaterial({ color: 0xe9eae6, roughness: 0.55, metalness: 0.1 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xc8c6bc, roughness: 0.9 }),
  };
  return MATS;
}

/** A pillow-ish rounded box: the top and bottom bulge, the edges pinch in. */
function pillowGeo(w, h, d, pinch = 0.6) {
  const geo = new RoundedBoxGeometry(w, h, d, 4, Math.min(h, w, d) * 0.45);
  const p = geo.attributes.position, hw = w / 2, hd = d / 2;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), e = Math.max(Math.abs(x) / hw, Math.abs(z) / hd);
    p.setY(i, p.getY(i) * (1 - pinch * e * e * e));
  }
  geo.computeVertexNormals();
  return geo;
}
/** A D-shaped outline (straight back, round front) in the x / -depth plane, for the toilet bowl. */
function dShape(w, back, front, inset = 0) {
  const r = w / 2 - inset, s = new THREE.Shape();
  s.moveTo(-r, -(back + inset)); s.lineTo(r, -(back + inset)); s.lineTo(r, -(front - w / 2));
  s.absarc(0, -(front - w / 2), r, 0, Math.PI, true);
  s.lineTo(-r, -(back + inset));
  return s;
}

// ---------------------------------------------------------------- the decals: tally marks, initials
function scratchTex(seed) {
  return canvasTex(512, 256, (g, w, h) => {
    const r = rng(seed);
    const scratch = (x0, y0, x1, y1) => {
      g.strokeStyle = `rgba(215,214,204,${0.45 + r() * 0.3})`; g.lineWidth = 2 + r() * 1.5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2 + (r() - 0.5) * 6, (y0 + y1) / 2, x1, y1); g.stroke();
      g.strokeStyle = 'rgba(20,24,22,0.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x0 + 1.5, y0 + 1); g.lineTo(x1 + 1.5, y1 + 1); g.stroke();
    };
    // tally marks: groups of five
    const n = 7 + Math.floor(r() * 17);
    let x = 30, y = 40;
    for (let i = 0; i < n; i++) {
      const k = i % 5;
      if (k < 4) scratch(x + k * 14 + (r() - 0.5) * 3, y + (r() - 0.5) * 4, x + k * 14 + (r() - 0.5) * 5, y + 62 + (r() - 0.5) * 6);
      else { scratch(x - 6, y + 52, x + 54, y + 10); x += 86; if (x > w - 90) { x = 30; y += 92; } }
    }
    // some initials and a date, scratched
    g.save(); g.translate(w * 0.55 + r() * 60, h - 40 - r() * 30); g.rotate((r() - 0.5) * 0.15);
    g.font = 'bold 40px "Courier New", monospace'; g.lineWidth = 2.2; g.strokeStyle = 'rgba(215,214,204,0.6)';
    const tags = ['M.K. 24', 'R+S', 'LV 23', 'J.B.', 'free', 'D.R. 19'];
    g.strokeText(tags[Math.floor(r() * tags.length)], 0, 0); g.restore();
  });
}

// ---------------------------------------------------------------- the cells
export function buildCells(scene, { cells, cellW, room }) {
  const M = mats(), { z0, bars, H, x0: roomX0 } = room;
  const obstacles = [], dayLights = [];
  const add = (geo, mat, x, y, z, parent = scene, shadow = true) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (w, h, d, mat, x, y, z, parent, shadow) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent, shadow);
  // a contact shadow on the floor (y up) or a wall (normal along axis)
  const blob = (w, d, x, z, y = 0.004) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), M.blob); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.renderOrder = 1; scene.add(m); return m; };
  const gusset = (len, drop) => { // a right-triangle steel bracket in the x-y plane (the wall at x 0, the deck at y 0)
    const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(len, 0); s.lineTo(0, -drop); s.lineTo(0, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.008, bevelEnabled: false }); g.translate(0, 0, -0.004); return g;
  };
  // the epoxy cell floor: grey, a little sheen, darker in the corners, worn pale by the door
  const floorTex = (seed) => canvasTex(512, 512, (g, w, h) => {
    const r = rng(seed);
    g.fillStyle = '#6f7476'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { const v = 90 + r() * 70 | 0; g.fillStyle = `rgba(${v},${v + 3},${v + 5},0.3)`; g.fillRect(r() * w, r() * h, 2, 2); }
    for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(150,155,152,${0.03 + r() * 0.04})`; g.beginPath(); g.ellipse(w * (0.4 + r() * 0.5), h * (0.55 + r() * 0.45), 30 + r() * 70, 20 + r() * 50, r() * 3, 0, 7); g.fill(); } // (the worn path to the door)
    const edge = g.createLinearGradient(0, 0, 0, 40); edge.addColorStop(0, 'rgba(20,20,18,0.35)'); edge.addColorStop(1, 'rgba(20,20,18,0)');
    g.fillStyle = edge; g.fillRect(0, 0, w, 40);
    for (const [x, y, ww, hh] of [[0, 0, 36, h], [w - 36, 0, 36, h]]) { const gr = g.createLinearGradient(x === 0 ? 0 : w, 0, x === 0 ? 36 : w - 36, 0); gr.addColorStop(0, 'rgba(20,20,18,0.3)'); gr.addColorStop(1, 'rgba(20,20,18,0)'); g.fillStyle = gr; g.fillRect(x, y, ww, hh); }
    for (let i = 0; i < 40; i++) { g.strokeStyle = `rgba(30,30,30,${0.06 + r() * 0.1})`; g.lineWidth = 1 + r() * 2; const x = r() * w, y = r() * h; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30); g.stroke(); } // (scuffs)
  });
  const drainTex = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#9aa0a3'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#15191b'; for (let i = 0; i < 7; i++) g.fillRect(18, 16 + i * 14, w - 36, 6);
    g.strokeStyle = '#6f7477'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  });
  const intercomTex = canvasTex(128, 192, (g, w, h) => {
    g.fillStyle = '#b7bcbf'; g.fillRect(0, 0, w, h);
    const r = rng(71); for (let i = 0; i < 400; i++) { g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(0, r() * h, w, 1); }
    g.fillStyle = '#1b1f22'; for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) { g.beginPath(); g.arc(34 + x * 15, 30 + y * 15, 3.6, 0, 7); g.fill(); }
    g.fillStyle = '#4a5054'; g.beginPath(); g.arc(w / 2, 142, 28, 0, 7); g.fill();
    g.fillStyle = '#c4231c'; g.beginPath(); g.arc(w / 2, 142, 21, 0, 7); g.fill();
    g.fillStyle = '#e05a4f'; g.beginPath(); g.arc(w / 2 - 5, 137, 7, 0, 7); g.fill();
    g.fillStyle = '#222'; g.font = 'bold 13px Arial'; g.textAlign = 'center'; g.fillText('RUF · APPEL', w / 2, 185);
    for (const [x, y] of [[10, 10], [w - 10, 10], [10, h - 10], [w - 10, h - 10]]) { g.fillStyle = '#6e7376'; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
  });
  const lightPanel = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, emissive: 0xe9f1ff, emissiveIntensity: 1.6, roughness: 0.6 });
  const books = [0x7a2a24, 0x2d4a6b, 0x3c5a3a];

  cells.forEach((cx, i) => {
    const L = i === 0 ? roomX0 : cx - cellW / 2 + 0.1, R = cx + cellW / 2 - 0.1; // (the cell's inner faces)
    const seed = 100 + i * 17, r = rng(seed);
    // ---- the floor
    const fl = add(new THREE.PlaneGeometry(R - L, bars - z0), new THREE.MeshStandardMaterial({ map: floorTex(seed), roughness: 0.38, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), (L + R) / 2, 0.001, (z0 + bars) / 2, scene, false);
    fl.rotation.x = -Math.PI / 2;
    // the drain in front of the combi unit
    const dr = add(new THREE.PlaneGeometry(0.16, 0.16), new THREE.MeshStandardMaterial({ map: drainTex, metalness: 0.8, roughness: 0.35 }), R - 0.95, 0.003, -2.75, scene, false);
    dr.rotation.x = -Math.PI / 2;
    { const st = blob(0.5, 0.5, R - 0.95, -2.75, 0.0025); st.material = M.blob.clone(); st.material.opacity = 0.35; } // (damp round it)
    // ---- the skirting: a dark coved strip round the cell
    const skirt = M.darkSteel;
    box(R - L, 0.1, 0.015, skirt, (L + R) / 2, 0.05, z0 + 0.008, scene, false);
    box(0.015, 0.1, bars - z0, skirt, L + 0.008, 0.05, (z0 + bars) / 2, scene, false);
    box(0.015, 0.1, bars - z0, skirt, R - 0.008, 0.05, (z0 + bars) / 2, scene, false);

    // ---- the bunk: two powder-coated steel decks welded to the left wall, head at the back wall
    const D = 0.8, BL = 2.0, bx0 = L, bx1 = L + D, bz0 = z0, bz1 = z0 + BL, bxc = (bx0 + bx1) / 2, bzc = (bz0 + bz1) / 2;
    for (const top of [0.42, 1.6]) {
      box(D, 0.035, BL, M.powder, bxc, top - 0.0175, bzc);                                  // the deck plate
      box(0.035, 0.11, BL, M.powder, bx1 - 0.0175, top - 0.03, bzc);                        // its front lip
      box(D - 0.035, 0.11, 0.035, M.powder, bxc - 0.0175, top - 0.03, bz1 - 0.0175);        // the foot lip
      box(0.05, 0.06, BL, M.powder, bx0 + 0.025, top - 0.065, bzc);                         // the wall rail (angle)
      for (const z of [bz0 + 0.25, bzc, bz1 - 0.25]) {
        const gm = add(gusset(0.5, 0.32), M.powder, bx0, top - 0.035, z); void gm;          // the brackets
        box(0.012, 0.14, 0.1, M.darkSteel, bx0 + 0.006, top - 0.12, z);                     // their wall plates
      }
    }
    for (const z of [bz0 + 0.03, bz1 - 0.03]) box(0.05, 1.6, 0.05, M.powder, bx1 - 0.025, 0.8, z); // the front posts
    for (const z of [bz0 + 0.03, bz1 - 0.03]) box(0.09, 0.012, 0.09, M.darkSteel, bx1 - 0.025, 0.006, z); // their floor plates
    // the ladder at the foot end: three rungs from the post to the wall
    for (const y of [0.78, 1.04, 1.3]) { const rg = add(new THREE.CylinderGeometry(0.016, 0.016, D, 10), M.powder, bxc, y, bz1 - 0.03); rg.rotation.z = Math.PI / 2; }
    // the top bunk's guard rail along the front, from the head
    { const rl = add(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 10), M.powder, bx1 - 0.03, 1.6 + 0.28, bz0 + 0.6); rl.rotation.x = Math.PI / 2;
      for (const z of [bz0 + 0.07, bz0 + 1.12]) box(0.035, 0.28, 0.035, M.powder, bx1 - 0.03, 1.6 + 0.14, z); }
    blob(D + 0.3, BL + 0.2, bxc, bzc);
    obstacles.push([bx0, bx1 + 0.02, bz0, bz1]);
    // the bedding: thin vinyl mattresses, flat pillows, a grey wool blanket (the lower one slept in, the top folded)
    const mt = 0.09;
    for (const top of [0.42, 1.6]) add(new RoundedBoxGeometry(D - 0.07, mt, BL - 0.06, 3, 0.03), M.vinyl, bxc - 0.01, top + mt / 2, bzc - 0.005);
    const pil = (top, rot) => { const p = add(pillowGeo(0.56, 0.085, 0.36, 0.55), M.cotton, bxc - 0.01 + (r() - 0.5) * 0.04, top + mt + 0.03, bz0 + 0.3); p.rotation.y = rot; return p; };
    pil(0.42, (r() - 0.5) * 0.12); pil(1.6, (r() - 0.5) * 0.08);
    { // lower: the blanket spread over the lower two-thirds, its top turned down
      const bl = add(new RoundedBoxGeometry(D - 0.02, 0.035, 1.3, 2, 0.015), M.wool, bxc - 0.01, 0.42 + mt + 0.012, bz1 - 0.68);
      bl.rotation.y = (r() - 0.5) * 0.03;
      add(new RoundedBoxGeometry(D - 0.02, 0.04, 0.16, 2, 0.018), M.wool, bxc - 0.01, 0.42 + mt + 0.036, bz1 - 1.27);
    }
    { // top: folded square at the foot
      const fb = add(pillowGeo(0.6, 0.09, 0.42, 0.25), M.wool, bxc - 0.02, 1.6 + mt + 0.045, bz1 - 0.35); fb.rotation.y = (r() - 0.5) * 0.1;
    }
    // the tally marks scratched into the wall over the lower bunk
    { const d = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.31), new THREE.MeshStandardMaterial({ map: scratchTex(seed + 5), transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      d.position.set(L + 0.004, 0.88 + r() * 0.12, bz0 + 0.7 + r() * 0.5); d.rotation.y = Math.PI / 2; d.receiveShadow = true; scene.add(d); }

    // ---- the combi unit: brushed stainless, its back on the right wall in the back corner, facing into the cell
    {
      const g = new THREE.Group(); g.position.set(R, 0, z0 + 0.36); g.rotation.y = -Math.PI / 2; scene.add(g);
      const W = 0.56;
      add(new THREE.BoxGeometry(W + 0.1, 1.16, 0.012), M.stainless, 0, 0.6, 0.006, g); // the wall plate
      // the rear cabinet up to the basin, then the basin shelf on top projecting forward
      const cab = add(new RoundedBoxGeometry(W, 0.86, 0.26, 3, 0.02), M.stainless, 0, 0.43, 0.012 + 0.13, g);
      const shelf = add(new RoundedBoxGeometry(W, 0.13, 0.4, 3, 0.03), M.stainless, 0, 0.86 + 0.065, 0.012 + 0.2, g); void cab; void shelf;
      const basin = add(new THREE.CircleGeometry(0.15, 32), M.hollow, 0, 0.991, 0.24, g, false); basin.rotation.x = -Math.PI / 2; basin.scale.set(1.15, 0.85, 1);
      const rim = add(new THREE.TorusGeometry(0.15, 0.008, 6, 40), M.stainless, 0, 0.992, 0.24, g, false); rim.rotation.x = -Math.PI / 2; rim.scale.set(1.15, 0.85, 1);
      // the tap: a short spout out of the shelf's back edge, the push button on top, and the flush button above the bowl
      const sp = add(new THREE.CylinderGeometry(0.012, 0.012, 0.09, 12), M.chrome, 0, 1.045, 0.09, g); sp.rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.018, 0.022, 0.07, 16), M.chrome, 0, 1.025, 0.04, g);
      add(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 20), M.chrome, 0.17, 0.993, 0.07, g);
      const fbtn = add(new THREE.CylinderGeometry(0.028, 0.028, 0.012, 20), M.chrome, 0, 0.66, 0.012 + 0.26 + 0.006, g); fbtn.rotation.x = Math.PI / 2;
      // the bowl: a D-shaped stainless body from the cabinet forward, no seat, the dark hollow in its rim
      const BACK = 0.2, FRONT = 0.66, BH = 0.4, bev = 0.015;
      const body = new THREE.ExtrudeGeometry(dShape(0.42, BACK, FRONT), { depth: BH - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 24 });
      body.rotateX(-Math.PI / 2); body.translate(0, bev, 0);
      add(body, M.stainless, 0, 0, 0, g);
      const hol = add(new THREE.ShapeGeometry(dShape(0.42, BACK, FRONT, 0.045), 24), M.hollow, 0, BH + 0.002, 0, g, false);
      hol.rotation.x = -Math.PI / 2;
      { const p = hol.geometry.attributes.position, uv = hol.geometry.attributes.uv; // (the gradient centred on the hole)
        for (let k = 0; k < p.count; k++) uv.setXY(k, 0.5 + p.getX(k) / 0.38, 0.5 + (p.getY(k) + (BACK + FRONT) / 2) / 0.5); uv.needsUpdate = true; }
      // the floor seal and the shadows
      const sb = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.8), M.blob); sb.rotation.x = -Math.PI / 2; sb.position.set(0, 0.004, 0.36); sb.renderOrder = 1; g.add(sb);
      const wb = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.3), M.blob.clone()); wb.material.opacity = 0.5; wb.position.set(0, 0.62, 0.002); wb.renderOrder = 1; g.add(wb);
      // the toilet roll on its little steel holder on the side wall, beside the unit (toward the bars)
      const tr = add(new THREE.CylinderGeometry(0.055, 0.055, 0.1, 18), M.cotton, W / 2 + 0.12, 0.72, 0.075, g); tr.rotation.z = Math.PI / 2;
      const tc = add(new THREE.CylinderGeometry(0.02, 0.02, 0.102, 10), M.darkSteel, W / 2 + 0.12, 0.72, 0.075, g, false); tc.rotation.z = Math.PI / 2;
      add(new THREE.BoxGeometry(0.14, 0.02, 0.07), M.stainless, W / 2 + 0.12, 0.79, 0.04, g);
      obstacles.push([R - FRONT - 0.01, R, z0 + 0.36 - W / 2 - 0.02, z0 + 0.36 + W / 2 + 0.02]);
    }

    // ---- the wall table, the shelf over it, the stool bolted to the floor
    {
      const tx = cx + 0.18, tw = 0.8, td = 0.45, ty = 0.74;
      box(tw, 0.03, td, M.powder, tx, ty - 0.015, z0 + td / 2);
      box(tw, 0.06, 0.03, M.powder, tx, ty - 0.03, z0 + td - 0.015);
      for (const sx of [-1, 1]) { const gs = add(gusset(0.38, 0.3), M.powder, tx + sx * (tw / 2 - 0.08), ty - 0.03, z0); gs.rotation.y = -Math.PI / 2; }
      blob(tw + 0.2, td + 0.3, tx, z0 + td / 2);
      obstacles.push([tx - tw / 2, tx + tw / 2, z0, z0 + td]);
      // the shelf: a steel plate on two brackets, a paperback and a plastic cup on it
      const sy = 1.42, sw = 0.7, sd = 0.22;
      box(sw, 0.02, sd, M.powder, tx + 0.05, sy - 0.01, z0 + sd / 2);
      for (const sx of [-1, 1]) { const gs = add(gusset(sd - 0.02, 0.16), M.powder, tx + 0.05 + sx * (sw / 2 - 0.06), sy - 0.02, z0); gs.rotation.y = -Math.PI / 2; }
      const nb = 1 + (i % 3);
      for (let k = 0; k < nb; k++) { const bk = box(0.13, 0.025, 0.19, new THREE.MeshStandardMaterial({ color: books[(i + k) % 3], roughness: 0.75 }), tx - 0.12 + (r() - 0.5) * 0.02, sy + 0.0125 + k * 0.026, z0 + 0.11); bk.rotation.y = (r() - 0.5) * 0.3; }
      const cup = add(new THREE.CylinderGeometry(0.04, 0.032, 0.1, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0xd9dfe4, roughness: 0.4, side: THREE.DoubleSide }), tx + 0.22, sy + 0.05, z0 + 0.1);
      add(new THREE.CircleGeometry(0.032, 16), cup.material, tx + 0.22, sy + 0.002, z0 + 0.1, scene, false).rotation.x = -Math.PI / 2;
      // on the table: a sheet of paper (the house rules)
      const pp = add(new THREE.PlaneGeometry(0.21, 0.297), new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.9 }), tx - 0.1, ty + 0.0015, z0 + 0.24, scene, false);
      pp.rotation.x = -Math.PI / 2; pp.rotation.z = (r() - 0.5) * 0.4;
      // the stool
      const stx = tx + 0.05, stz = z0 + td + 0.32;
      add(new THREE.CylinderGeometry(0.17, 0.17, 0.035, 24), M.powder, stx, 0.45, stz);
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.43, 12), M.powder, stx, 0.215, stz);
      add(new THREE.CylinderGeometry(0.12, 0.13, 0.015, 20), M.darkSteel, stx, 0.0075, stz);
      blob(0.5, 0.5, stx, stz);
      obstacles.push([stx - 0.17, stx + 0.17, stz - 0.17, stz + 0.17]);
    }

    // ---- the window: a deep concrete reveal round the existing pane and its bars, the daylight through it
    {
      const wy = 2.55, ww = 1.0, wh = 0.45, dpth = 0.16, f = 0.09;
      box(ww + 2 * f, f, dpth, M.concrete, cx, wy + wh / 2 + f / 2, z0 + dpth / 2);
      const sill = box(ww + 2 * f + 0.04, f * 0.7, dpth + 0.03, M.concrete, cx, wy - wh / 2 - f * 0.35, z0 + (dpth + 0.03) / 2); void sill;
      for (const sx of [-1, 1]) box(f, wh, dpth, M.concrete, cx + sx * (ww / 2 + f / 2), wy, z0 + dpth / 2);
      const sun = new THREE.SpotLight(0xdde8ff, 0, 7, 0.75, 0.95, 1.4);
      sun.position.set(cx, wy, z0 + 0.1); sun.target.position.set(cx + 0.35, 0, -1.4);
      scene.add(sun, sun.target);
      dayLights.push(sun);
    }

    // ---- the ceiling light: recessed, a frosted diffuser behind a welded steel cage; a dome camera in the corner
    {
      const lx = cx + 0.1, lz = -2.1;
      box(0.46, 0.02, 0.46, M.whitePaint, lx, H - 0.01, lz, scene, false);
      const pn = add(new THREE.PlaneGeometry(0.36, 0.36), lightPanel, lx, H - 0.022, lz, scene, false); pn.rotation.x = Math.PI / 2;
      const cage = M.darkSteel;
      for (const s of [-1, 1]) {
        box(0.42, 0.012, 0.012, cage, lx, H - 0.07, lz + s * 0.2, scene, false);
        box(0.012, 0.012, 0.42, cage, lx + s * 0.2, H - 0.07, lz, scene, false);
      }
      for (const o of [-0.1, 0, 0.1]) { box(0.012, 0.01, 0.4, cage, lx + o, H - 0.072, lz, scene, false); box(0.4, 0.01, 0.012, cage, lx, H - 0.074, lz + o, scene, false); }
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(0.012, 0.05, 0.012, cage, lx + sx * 0.2, H - 0.045, lz + sz * 0.2, scene, false);
      const lamp = new THREE.PointLight(0xe8f0ff, 3.0, 6.5, 1.6); lamp.position.set(lx, H - 0.35, lz); scene.add(lamp);
      const dome = add(new THREE.SphereGeometry(0.07, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x15181b, metalness: 0.4, roughness: 0.15, transparent: true, opacity: 0.92 }), R - 0.18, H, bars - 0.35, scene, false);
      dome.rotation.x = Math.PI;
      box(0.18, 0.02, 0.18, M.whitePaint, R - 0.18, H - 0.01, bars - 0.35, scene, false);
    }

    // ---- the intercom / call button on the right wall by the bars
    {
      box(0.012, 0.22, 0.15, M.stainless, R - 0.006, 1.35, bars - 0.32, scene, false);
      const ic = add(new THREE.PlaneGeometry(0.14, 0.21), new THREE.MeshStandardMaterial({ map: intercomTex, metalness: 0.6, roughness: 0.4 }), R - 0.0125, 1.35, bars - 0.32, scene, false);
      ic.rotation.y = -Math.PI / 2;
      const btn = add(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 16), new THREE.MeshStandardMaterial({ color: 0xc4231c, emissive: 0x6a0e0a, emissiveIntensity: 0.6, roughness: 0.35 }), R - 0.018, 1.35 - 0.035, bars - 0.32, scene, false);
      btn.rotation.z = Math.PI / 2;
    }

    // ---- the door: a solid kick plate, the food hatch (Speiseklappe) welded across the bars, the keyhole plate
    {
      const dx0 = cx + 0.25, dx1 = cx + 1.25, dc = (dx0 + dx1) / 2;
      box(dx1 - dx0 - 0.04, 0.34, 0.05, M.darkSteel, dc, 0.25, bars);
      box(0.44, 0.26, 0.07, M.darkSteel, dc - 0.06, 1.15, bars);
      box(0.38, 0.19, 0.012, M.powder, dc - 0.06, 1.15, bars + 0.041);       // the flap (corridor side)
      box(0.38, 0.19, 0.012, M.powder, dc - 0.06, 1.15, bars - 0.041);       // its back plate (cell side)
      const knob = add(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 10), M.chrome, dc - 0.06, 1.22, bars + 0.06); knob.rotation.x = Math.PI / 2;
      box(0.11, 0.18, 0.025, M.darkSteel, dx1 - 0.08, 1.05, bars - 0.05);
    }
    void r;
  });

  return {
    obstacles,
    /** day: 0 (night) .. 1 (noon): the window's daylight */
    update(day) { for (const s of dayLights) s.intensity = 5.5 * Math.max(0, day); },
  };
}
