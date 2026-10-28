// The CAR RENTAL building, once, for both sides of its glass: carrental.js builds it in the world (its snowy roof, the
// lit sign, the cars on display seen through the glazing) and carrentalroom.js builds the very same shell round the
// showroom you walk in (the same timber walls, glass front and mullions, door, vaulted ceiling with its trusses, the
// same cars on the same turntables). Building frame: origin on the floor in the middle of the hall, +z out of the
// glass front (to the road), +x along it. An alpine car hall: a wide gable facing the road (larch boards in the
// gable, deep eaves, a snow-laden pitched roof), a full-height glass front between stone corner piers, larch walls
// on a stone plinth, glulam trusses inside under a timber ceiling.
import * as THREE from 'three';

// the hall (inside, m): width, depth, wall height (two storeys), the ridge's rise over the walls; eaves overhang
export const LAYOUT = {
  W: 26, D: 14, H: 7.6, RISE: 3.8, T: 0.3, EAVE: 1.1, EAVE_F: 1.8, PIER: 0.7,
  mullions: 8, // glass bays across the front
  door: { bay: 3, h: 2.7, x: 0, w: 0 }, // an automatic sliding pair filling one glass bay (x, w: below)
  // the upper floor: a mezzanine along the back (its floor's height, its front edge z), the stair up to it along the
  // left wall (from z1 at the bottom to z0 at the top), the steel posts under its edge (x)
  FL: 3.6, MZ: -2.2,
  stair: { x0: -13, x1: -11.5, z0: -2.2, z1: 4.2, steps: 20 },
  posts: [-4.9, 2.4, 8.2],
  // the cars on display: a row of three behind the glass, two at the back under the mezzanine (x, z, heading),
  // turntable radius; upstairs: two more (not for rent), and the office on the right
  spots: [[-8.2, 2.3, 0.75], [-1.6, 2.3, -0.6], [5.4, 2.3, 0.55], [-8.2, -3.9, -0.5], [-1.6, -3.9, 0.6]], R: 2.55,
  upSpots: [[-6.8, -4.6, 1.3], [-0.6, -4.6, -1.85]],
  office: { x0: 5.4, gap: -3.7 }, // its glass partition at x0, from the back wall to z gap (the way in)
  desk: { x: 8.6, z: -6.1, r: 2.5 }, // the reception desk (an arc of counter round its centre, open to the back wall)
  lounge: { x: 10.4, z: 3.9 },
};
const L = LAYOUT;
L.bayW = (L.W - 2 * L.PIER) / L.mullions;
L.door.x = -L.W / 2 + L.PIER + L.bayW * (L.door.bay + 0.5);
L.door.w = L.bayW - 0.09;
/** Ceiling height (underside of the roof) at x. */
export const ceilingAt = (x) => L.H + L.RISE * Math.max(0, 1 - Math.abs(x) / (L.W / 2));
/** The stair's height at z (0 at its foot, FL at its top). */
export const stairY = (z) => L.FL * Math.max(0, Math.min(1, (L.stair.z1 - z) / (L.stair.z1 - L.stair.z0)));
/** The sliding doors: t 0 shut .. 1 open (the leaves buildShell returned). */
export function setDoors(leaves, t) { for (const l of leaves || []) l.position.x = l.userData.x0 + l.userData.dir * l.userData.slide * t; }

const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
// shared materials (made once): weathered larch boards (vertical), the stone plinth, dark steel, glulam, snow
let M = null;
export function shellMaterials() {
  if (M) return M;
  const larch = (seed, base) => canvasTex(512, 512, (c, w, h) => {
    const r = rng(seed);
    for (let x = 0; x < w; x += 32) {
      const v = (r() - 0.5) * 28; c.fillStyle = `rgb(${base[0] + v},${base[1] + v * 0.8},${base[2] + v * 0.6})`; c.fillRect(x, 0, 32, h);
      c.fillStyle = 'rgba(30,16,6,0.6)'; c.fillRect(x, 0, 2, h); // (the joint between boards)
      for (let k = 0; k < 9; k++) { c.fillStyle = `rgba(60,30,10,${0.05 + r() * 0.09})`; c.fillRect(x + 4 + r() * 24, 0, 1 + r() * 2, h); }
      for (let k = 0; k < 2; k++) if (r() < 0.5) { c.fillStyle = 'rgba(50,25,8,0.35)'; c.beginPath(); c.ellipse(x + 8 + r() * 16, r() * h, 2.5, 4, 0, 0, 7); c.fill(); } // (knots)
    }
  });
  const outT = larch(9, [150, 98, 56]); outT.wrapS = outT.wrapT = THREE.RepeatWrapping; outT.repeat.set(1 / 4, 1 / 4); // (world-size: boxes get UVs in m below)
  const inT = larch(4, [192, 140, 88]); inT.wrapS = inT.wrapT = THREE.RepeatWrapping; inT.repeat.set(1 / 4, 1 / 4);
  const stoneT = canvasTex(512, 256, (c, w, h) => {
    const r = rng(5); c.fillStyle = '#4e4c48'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 42) for (let x = -(y % 84 ? 30 : 0); x < w; x += 58 + r() * 30) { const v = 112 + r() * 54; c.fillStyle = `rgb(${v},${v - 4},${v - 10})`; c.beginPath(); c.roundRect(x + 3, y + 3, 52 + r() * 22, 36, 9); c.fill(); }
  });
  stoneT.wrapS = stoneT.wrapT = THREE.RepeatWrapping; stoneT.repeat.set(1 / 3, 1 / 1.5);
  M = {
    larchOut: new THREE.MeshStandardMaterial({ map: outT, roughness: 0.85 }),
    larchIn: new THREE.MeshStandardMaterial({ map: inT, roughness: 0.7 }),
    stone: new THREE.MeshStandardMaterial({ map: stoneT, roughness: 0.95 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x1f2124, roughness: 0.38, metalness: 0.75 }),
    glulam: new THREE.MeshStandardMaterial({ color: 0xc89a62, roughness: 0.6 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x2c2926, roughness: 0.8 }),
    snow: new THREE.MeshStandardMaterial({ color: 0xf3f6fa, roughness: 0.92 }),
    strip: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2b8, emissiveIntensity: 2.2 }),
    oak: new THREE.MeshStandardMaterial({ color: 0xc2925e, roughness: 0.5 }),
    railGlass: new THREE.MeshPhysicalMaterial({ color: 0xd8ecf2, roughness: 0.05, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
    // the upper side windows: from outside a warm lit glass, from inside the bright snowy sky and peaks
    winOut: new THREE.MeshStandardMaterial({ color: 0x9fb4c4, emissive: 0xffe6c0, emissiveIntensity: 0.55, roughness: 0.12, metalness: 0.2 }),
    winIn: new THREE.MeshBasicMaterial({ map: canvasTex(512, 512, (c, w, h) => {
      const sky = c.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#6fa3d8'); sky.addColorStop(0.7, '#d9e8f4'); sky.addColorStop(1, '#eef4f8');
      c.fillStyle = sky; c.fillRect(0, 0, w, h);
      const r = rng(11); c.fillStyle = '#f6f9fc'; c.beginPath(); c.moveTo(0, h);
      for (let x = 0; x <= w; x += 32) c.lineTo(x, h * (0.55 + r() * 0.25)); c.lineTo(w, h); c.fill();
      c.fillStyle = '#9fb0c2'; for (let k = 0; k < 6; k++) { const x = r() * w; c.beginPath(); c.moveTo(x - 40, h); c.lineTo(x, h * (0.62 + r() * 0.1)); c.lineTo(x + 30, h); c.fill(); }
    }) }),
  };
  // the inner faces seen from outside: the same boards and oak, self-lit (the hall's lights on them; no roof shadow)
  const lit = (src, k) => { const o = src.clone(); o.emissive = new THREE.Color(0xffffff); o.emissiveMap = src.map || null; if (!src.map) o.emissive.copy(src.color); o.emissiveIntensity = k; return o; };
  M.larchInLit = lit(M.larchIn, 0.5); M.oakLit = lit(M.oak, 0.45); M.glulamLit = lit(M.glulam, 0.4);
  return M;
}
// UVs in metres on a box (each face mapped by its own two axes): one texture scale everywhere, no stretched boards
function worldUV(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ay > 0.5) uv.setXY(i, p.getX(i), p.getZ(i)); else if (ax > 0.5) uv.setXY(i, p.getZ(i), p.getY(i)); else uv.setXY(i, p.getX(i), p.getY(i));
  }
  return geo;
}

/**
 * The shell into `g` (building frame). side 'out': the outside's roof snow, plinth, piers and eaves; 'in': what you see
 * from the showroom (the same walls, glass, trusses). glass: the glazing's material (each side its own).
 * Returns { glassMeshes, strips (the light strips' material), front (z of the glass) }.
 */
export function buildShell(g, side, glass) {
  const m = shellMaterials(), { W, D, H, RISE, T, EAVE, EAVE_F, PIER } = L, out = side === 'out';
  const wallMat = out ? m.larchOut : m.larchIn;
  const add = (geo, mat, x, y, z, shadow = true) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = shadow; o.receiveShadow = true; g.add(o); return o; };
  const B = (w, h, d, mat, x, y, z, shadow) => add(worldUV(new THREE.BoxGeometry(w, h, d)), mat, x, y, z, shadow);
  // walls: the sides and the back (larch, on the outside a stone plinth), the gables (back and front, over the glass)
  if (out) {
    // (the outer skin: larch outside; the hall's inner faces show through the glass in the inner larch: a thin
    // second skin just inside, so both sides read right)
    for (const sx of [-1, 1]) { B(T, H, D + 2 * T, m.larchOut, sx * (W / 2 + T / 2), H / 2, 0); B(0.02, H, D, m.larchIn, sx * (W / 2 - 0.01), H / 2, 0, false); }
    B(W + 2 * T, H, T, m.larchOut, 0, H / 2, -D / 2 - T / 2); B(W, H, 0.02, m.larchIn, 0, H / 2, -D / 2 + 0.01, false);
    // the stone plinth round the sides and back (proud of the boards), the corner piers in front
    for (const sx of [-1, 1]) B(0.16, 0.9, D + 2 * T + 0.16, m.stone, sx * (W / 2 + T + 0.08), 0.45 - 0.2, 0);
    B(W + 2 * T + 0.32, 0.9, 0.16, m.stone, 0, 0.45 - 0.2, -D / 2 - T - 0.08);
    for (const sx of [-1, 1]) B(PIER + T, H, T + 0.5, m.stone, sx * (W / 2 - PIER / 2 + T / 2), H / 2, D / 2 + 0.05);
  } else {
    for (const sx of [-1, 1]) B(T, H, D, m.larchIn, sx * (W / 2 + T / 2), H / 2, 0);
    B(W, H, T, m.larchIn, 0, H / 2, -D / 2 - T / 2);
    for (const sx of [-1, 1]) B(PIER, H, 0.4, m.stone, sx * (W / 2 - PIER / 2), H / 2, D / 2 - 0.1); // (the piers' inner faces)
  }
  const gable = new THREE.Shape(); gable.moveTo(-W / 2 - T, 0); gable.lineTo(W / 2 + T, 0); gable.lineTo(0, RISE + T * RISE / (W / 2)); gable.closePath();
  const gGeo = new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false });
  { const p = gGeo.attributes.position, uv = gGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i)); }
  add(gGeo, wallMat, 0, H, -D / 2 - T);
  add(gGeo, wallMat, 0, H, D / 2 - T + 0.05);
  // the front beam over the glass (glulam, the gable sits on it) and the glazing: full height between the piers,
  // thin dark mullions, a transom, a sill
  const gx0 = -W / 2 + PIER, gx1 = W / 2 - PIER, gw = gx1 - gx0, fz = D / 2;
  B(W + 2 * T, 0.5, T + 0.1, m.glulam, 0, H - 0.25, fz - T / 2 + 0.05);
  const glassMeshes = [];
  const pane = add(new THREE.PlaneGeometry(gw, H - 0.6), glass, (gx0 + gx1) / 2, (H - 0.6) / 2 + 0.1, fz, false);
  if (!out) pane.rotation.y = Math.PI;
  glassMeshes.push(pane);
  const n = L.mullions;
  for (let i = 0; i <= n; i++) B(0.09, H - 0.5, 0.16, m.steel, gx0 + (gw * i) / n, (H - 0.5) / 2, fz, false);
  B(gw, 0.07, 0.14, m.steel, (gx0 + gx1) / 2, L.transom, fz, false);
  B(gw, 0.12, 0.2, m.steel, (gx0 + gx1) / 2, 0.06, fz, false);
  // the door: a heavier frame, a push bar each side
  const d = L.door;
  for (const sx of [-1, 1]) B(0.11, d.h, 0.2, m.steel, d.x + sx * d.w / 2, d.h / 2, fz, false);
  B(d.w, 0.11, 0.2, m.steel, d.x, d.h, fz, false);
  B(0.04, d.h - 0.2, 0.04, m.steel, d.x, (d.h - 0.2) / 2 + 0.1, fz, false); // (the meeting stiles)
  for (const sz of [-1, 1]) B(d.w * 0.7, 0.045, 0.05, new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 1, roughness: 0.2 }), d.x, 1.05, fz + sz * 0.14, false);
  // the roof: two slabs from the ridge to the eaves (timber underneath: the ceiling inside), front and back overhangs;
  // outside, a thick layer of snow on each and a dark fascia on the eaves
  const k = RISE / (W / 2), run = W / 2 + EAVE, drop = RISE + k * EAVE, len = Math.hypot(run, drop), ang = Math.atan2(drop, run);
  const zlen = D + 2 * T + (out ? EAVE_F + 0.6 : 0), zc = out ? (EAVE_F - 0.6) / 2 : 0;
  for (const sx of [-1, 1]) {
    const nx = Math.sin(ang) * sx, ny = Math.cos(ang); // (the slab's outward normal)
    const cx = sx * run / 2, cy = H + RISE - drop / 2;
    const slab = B(len, 0.28, zlen, out ? m.roof : m.larchIn, cx + nx * 0.14, cy + ny * 0.14, zc);
    slab.rotation.z = -sx * ang;
    if (out) {
      const ce = B(len, 0.02, D + 2 * T, m.larchIn, cx - nx * 0.012, cy - ny * 0.012, 0, false); ce.rotation.z = -sx * ang; // (the timber ceiling, seen through the glass)
      const sn = B(len + 0.08, 0.34, zlen - 0.1, m.snow, cx + nx * 0.45, cy + ny * 0.45, zc);
      sn.rotation.z = -sx * ang;
      const fa = B(0.12, 0.42, zlen, m.steel, sx * (run + 0.02), H - k * EAVE - 0.05, zc); void fa; // (the eaves' fascia)
    }
  }
  // inside (and seen through the glass): glulam trusses (a tie beam, the king post, two struts), the ridge beam, light
  // strips under each tie beam
  const strips = out ? m.strip.clone() : m.strip;
  for (const z of [-D / 2 + 1.75, -D / 2 + 5.25, -D / 2 + 8.75, -D / 2 + 12.25]) {
    B(W, 0.36, 0.24, m.glulam, 0, H - 0.18, z);
    B(0.24, RISE, 0.24, m.glulam, 0, H + RISE / 2, z);
    for (const sx of [-1, 1]) { const s = B(Math.hypot(W / 4, RISE * 0.5), 0.2, 0.2, m.glulam, sx * W / 8, H + RISE * 0.25, z); s.rotation.z = -sx * Math.atan2(RISE * 0.5, W / 4); }
    B(W - 3, 0.04, 0.12, strips, 0, H - 0.38, z, false);
  }
  B(0.3, 0.4, D, m.glulam, 0, H + RISE - 0.35, 0);
  return { glassMeshes, strips, front: fz };
}
