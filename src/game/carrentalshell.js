// The CAR RENTAL building, once, for both sides of its glass: carrental.js builds it in the world (its snowy roof, the
// lit sign, the cars on display seen through the glazing) and carrentalroom.js builds the very same shell round the
// showroom you walk in (the same timber walls, glass front and mullions, door, vaulted ceiling with its trusses, the
// same cars on the same turntables). Building frame: origin on the floor in the middle of the hall, +z out of the
// glass front (to the road), +x along it. An alpine car hall: a wide gable facing the road (larch boards in the
// gable, deep eaves, a snow-laden pitched roof), a full-height glass front between stone corner piers, larch walls
// on a stone plinth, glulam trusses inside under a timber ceiling.
import * as THREE from 'three';

// the hall (inside, m): width, depth, wall height (two storeys), the ridge's rise over the walls; eaves overhang
// (Oct 29: 26 x 14 m -> 32 x 17.5 m, +54 % floor: "not enough space to walk around". Every car, the counter and the
// walls >= 2.5 m apart, upstairs too: three rows of cars downstairs standing along the hall (no longer spinning: the
// rows are closer than a turning car's circle), three supercars in a row upstairs)
export const LAYOUT = {
  W: 32, D: 17.5, H: 7.6, RISE: 4.2, T: 0.3, EAVE: 1.1, EAVE_F: 1.8, PIER: 0.7,
  mullions: 8, // glass bays across the front
  door: { bay: 3, h: 2.7, x: 0, w: 0 }, // an automatic sliding pair filling one glass bay (x, w: below)
  // the upper floor: a mezzanine along the back (its floor's height, its front edge z), the stair up to it along the
  // left wall (from z1 at the bottom to z0 at the top), the steel posts under its edge (x)
  FL: 3.6, MZ: -1.3,
  stair: { x0: -16, x1: -14.5, z0: -1.3, z1: 5.1, steps: 20 },
  posts: [-5.4, 2.4, 12.5], // (in the gaps between the middle row's cars)
  // the cars on display (x, z, heading: along the hall, a little turned), on low plinths of radius R: two behind the
  // glass either side of the way in from the door, a row of three in the middle, three at the back under the
  // mezzanine; upstairs a row of three (the supercars, for rent too), and the office on the right
  spots: [[-9.33, 4.85, 1.49], [6.35, 4.85, -1.49], [-9.33, -0.05, -1.49], [-1.49, -0.05, 1.49], [6.35, -0.05, -1.49],
    [-10.83, -5.05, 1.49], [-2.99, -5.05, -1.49], [4.85, -5.05, 1.49]], R: 2.0,
  upSpots: [[-9.44, -5.06, 1.49], [-1.82, -5.06, -1.49], [5.74, -5.06, 1.49]],
  office: { x0: 10.8, gap: -2.8 }, // its glass partition at x0, from the back wall to z gap (the way in)
  desk: { x: 12.0, z: -7.6, r: 1.45 }, // the reception desk (an arc of counter round its centre, open to the back wall)
  lounge: { x: 13.6, z: 4.9 },
};
const L = LAYOUT;
L.bayW = (L.W - 2 * L.PIER) / L.mullions;
L.door.x = -L.W / 2 + L.PIER + L.bayW * (L.door.bay + 0.5);
L.door.w = L.bayW - 0.09;
L.officeX = (L.office.x0 + L.W / 2) / 2; // (the office's middle, x)
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
    // the upper side windows: from outside a warm lit glass, from inside (no view given) a painted sky
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
 * The shell into `g` (building frame). side 'out': the outside's roof snow, plinth, piers and eaves, and the inside as
 * seen through the glass (self-lit, no roof shadow on it); 'in': what you see from the showroom (the same walls, glass,
 * door, mezzanine, stair, trusses). glass: the glazing's material (each side its own).
 * Returns { glassMeshes, strips (the light strips' material), front (z of the glass), doors (the two sliding leaves:
 * setDoors()), lit (the self-lit inner materials, outside only) }.
 * opts.view ('in'): the material of the upper side windows' view (carrentalroom.js: the live world).
 */
export function buildShell(g, side, glass, opts = {}) {
  const m = shellMaterials(), { W, D, H, RISE, T, EAVE, EAVE_F, PIER, FL, MZ } = L, out = side === 'out';
  const wallMat = out ? m.larchOut : m.larchIn;
  const inner = out ? m.larchInLit : m.larchIn, oak = out ? m.oakLit : m.oak, glu = out ? m.glulamLit : m.glulam;
  const add = (geo, mat, x, y, z, shadow = true, parent = g) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = shadow; o.receiveShadow = true; parent.add(o); return o; };
  const B = (w, h, d, mat, x, y, z, shadow, parent) => add(worldUV(new THREE.BoxGeometry(w, h, d)), mat, x, y, z, shadow, parent);
  // (the inside's parts: seen from outside they take no shadow from the roof, so the hall reads lit)
  const I = (o) => { if (out) { o.receiveShadow = false; o.castShadow = false; } return o; };
  // walls: the sides and the back (larch, on the outside a stone plinth), the gables (back and front, over the glass)
  if (out) {
    for (const sx of [-1, 1]) { B(T, H, D + 2 * T, m.larchOut, sx * (W / 2 + T / 2), H / 2, 0); I(B(0.02, H, D, inner, sx * (W / 2 - 0.01), H / 2, 0, false)); }
    B(W + 2 * T, H, T, m.larchOut, 0, H / 2, -D / 2 - T / 2); I(B(W, H, 0.02, inner, 0, H / 2, -D / 2 + 0.01, false));
    for (const sx of [-1, 1]) B(0.16, 0.9, D + 2 * T + 0.16, m.stone, sx * (W / 2 + T + 0.08), 0.45 - 0.2, 0);
    B(W + 2 * T + 0.32, 0.9, 0.16, m.stone, 0, 0.45 - 0.2, -D / 2 - T - 0.08);
    for (const sx of [-1, 1]) B(PIER + T, H, T + 0.5, m.stone, sx * (W / 2 - PIER / 2 + T / 2), H / 2, D / 2 + 0.05);
  } else {
    for (const sx of [-1, 1]) B(T, H, D, m.larchIn, sx * (W / 2 + T / 2), H / 2, 0);
    B(W, H, T, m.larchIn, 0, H / 2, -D / 2 - T / 2);
    for (const sx of [-1, 1]) B(PIER, H, 0.4, m.stone, sx * (W / 2 - PIER / 2), H / 2, D / 2 - 0.1); // (the piers' inner faces)
  }
  // the upper windows in the side walls (the second storey): outside a warm lit glass, inside the view out
  const wy = FL + 1.85, ww = 1.9, wh = 1.6;
  for (const sx of [-1, 1]) for (const wz of [-6.5, -2.0, 2.5, 6.75]) {
    if (out) {
      B(0.08, wh + 0.18, ww + 0.18, m.steel, sx * (W / 2 + T + 0.03), wy, wz, false);
      B(0.04, wh, ww, m.winOut, sx * (W / 2 + T + 0.07), wy, wz, false);
      B(0.14, 0.06, ww + 0.3, m.steel, sx * (W / 2 + T + 0.08), wy - wh / 2 - 0.1, wz, false);
    } else {
      B(0.06, wh + 0.18, ww + 0.18, m.steel, sx * (W / 2 - 0.02), wy, wz, false);
      const sky = add(new THREE.PlaneGeometry(ww, wh), opts.view || m.winIn, sx * (W / 2 - 0.06), wy, wz, false);
      sky.rotation.y = -sx * Math.PI / 2;
      B(0.2, 0.05, ww + 0.2, m.oak, sx * (W / 2 - 0.1), wy - wh / 2 - 0.05, wz, false);
    }
  }
  const gable = new THREE.Shape(); gable.moveTo(-W / 2 - T, 0); gable.lineTo(W / 2 + T, 0); gable.lineTo(0, RISE + T * RISE / (W / 2)); gable.closePath();
  const gGeo = new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false });
  { const p = gGeo.attributes.position, uv = gGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i)); }
  add(gGeo, wallMat, 0, H, -D / 2 - T);
  add(gGeo, wallMat, 0, H, D / 2 - T + 0.05);
  // the front: a glulam beam over the glass (the gable sits on it), the glazing bay by bay between the piers (thin dark
  // mullions, a transom at the upper floor, a sill), one bay the door: an automatic sliding pair under a steel header
  const n = L.mullions, bw = L.bayW, gx0 = -W / 2 + PIER, gx1 = W / 2 - PIER, gw = gx1 - gx0, fz = D / 2, top = H - 0.5, d = L.door;
  B(W + 2 * T, 0.5, T + 0.1, m.glulam, 0, H - 0.25, fz - T / 2 + 0.05);
  const glassMeshes = [];
  const pane = (x, y0, y1, w, z = fz, parent = g) => { const p = add(new THREE.PlaneGeometry(w, y1 - y0), glass, x, (y0 + y1) / 2, z, false, parent); if (!out) p.rotation.y = Math.PI; glassMeshes.push(p); return p; };
  for (let i = 0; i < n; i++) { const cx = gx0 + bw * (i + 0.5); pane(cx, i === d.bay ? d.h + 0.2 : 0.12, top, bw); }
  for (let i = 0; i <= n; i++) B(0.09, top, 0.16, m.steel, gx0 + bw * i, top / 2, fz, false);
  B(gw, 0.09, 0.14, m.steel, (gx0 + gx1) / 2, FL, fz, false); // (the transom at the upper floor)
  const dl = d.x - bw / 2, dr = d.x + bw / 2; // (the sill either side of the door, a flush threshold in it)
  B(dl - gx0, 0.12, 0.2, m.steel, (gx0 + dl) / 2, 0.06, fz, false);
  B(gx1 - dr, 0.12, 0.2, m.steel, (dr + gx1) / 2, 0.06, fz, false);
  B(bw - 0.09, 0.012, 0.44, m.steel, d.x, 0.006, fz - 0.06, false);
  B(bw - 0.09, 0.2, 0.3, m.steel, d.x, d.h + 0.1, fz - 0.08, false); // (the header: the sliding gear)
  for (const sz of [-1, 1]) B(0.18, 0.05, 0.05, new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.3 }), d.x, d.h - 0.02, fz - 0.08 + sz * 0.16, false); // (the motion sensors)
  const leaves = [], lw = (bw - 0.09) / 2, lh = d.h - 0.02, band = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const leaf = new THREE.Group(), x0 = d.x + s * lw / 2;
    leaf.position.set(x0, 0, fz - 0.14);
    leaf.userData = { x0, dir: s, slide: lw - 0.06 };
    for (const sx of [-1, 1]) B(0.05, lh, 0.05, m.steel, sx * (lw / 2 - 0.025), lh / 2 + 0.01, 0, false, leaf);
    B(lw, 0.05, 0.05, m.steel, 0, lh - 0.015, 0, false, leaf);
    B(lw, 0.09, 0.05, m.steel, 0, 0.055, 0, false, leaf);
    const gp = add(new THREE.PlaneGeometry(lw - 0.1, lh - 0.14), glass, 0, lh / 2 + 0.03, 0, false, leaf); if (!out) gp.rotation.y = Math.PI; glassMeshes.push(gp);
    add(new THREE.PlaneGeometry(lw - 0.1, 0.06), band, 0, 1.45, 0.004, false, leaf); // (the frosted band: you see it's a door)
    g.add(leaf); leaves.push(leaf);
  }
  // the upper floor: an oak mezzanine along the back on a steel edge beam and posts, a glass balustrade, lights under it
  const zb = -D / 2, dz = MZ - zb;
  I(B(W, 0.3, dz, oak, 0, FL - 0.15, zb + dz / 2));
  I(B(W, 0.34, 0.06, m.steel, 0, FL - 0.15, MZ + 0.03));
  for (const px of L.posts) I(B(0.2, FL - 0.3, 0.2, m.steel, px, (FL - 0.3) / 2, MZ - 0.14));
  const strips = out ? m.strip.clone() : m.strip;
  for (const lx of [-12.3, -6.9, -1.0, 4.7, 10.3, 14.3]) I(B(1.4, 0.03, 0.3, strips, lx, FL - 0.315, zb + dz / 2, false));
  const S = L.stair, rx0 = S.x1, rlen = W / 2 - rx0, rcx = (rx0 + W / 2) / 2;
  add(new THREE.BoxGeometry(rlen, 0.9, 0.02), m.railGlass, rcx, FL + 0.5, MZ - 0.06, false);
  I(B(rlen, 0.06, 0.08, m.steel, rcx, FL + 1.0, MZ - 0.06, false));
  for (let x = rx0 + 0.03; x < W / 2; x += 2.45) I(B(0.05, 1.0, 0.05, m.steel, x, FL + 0.5, MZ - 0.06, false));
  // the stair up along the left wall: floating oak treads on two steel stringers, a glass balustrade and handrail
  const N = S.steps, rise = FL / N, run = (S.z1 - S.z0) / N, sw = S.x1 - S.x0, slen = Math.hypot(S.z1 - S.z0, FL), ang = Math.atan2(FL, S.z1 - S.z0), zm = (S.z0 + S.z1) / 2;
  for (let i = 0; i < N; i++) I(B(sw - 0.04, 0.06, run + 0.04, oak, (S.x0 + S.x1) / 2, (i + 1) * rise - 0.03, S.z1 - (i + 0.5) * run));
  for (const sx of [S.x0 + 0.05, S.x1 - 0.05]) I(B(0.1, 0.3, slen, m.steel, sx, FL / 2 - 0.12, zm)).rotation.x = ang;
  const ya = 0.3, yb = FL + 0.12, hb = 0.9, rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute([S.x1, ya, S.z1, S.x1, yb, S.z0, S.x1, yb + hb, S.z0, S.x1, ya + hb, S.z1], 3));
  rg.setIndex([0, 1, 2, 0, 2, 3]); rg.computeVertexNormals();
  add(rg, m.railGlass, 0, 0, 0, false);
  I(B(0.06, 0.06, slen, m.steel, S.x1, (ya + yb) / 2 + hb + 0.05, zm, false)).rotation.x = ang;
  I(B(0.07, ya + hb + 0.1, 0.07, m.steel, S.x1, (ya + hb + 0.1) / 2, S.z1, false)); // (the newel at the foot)
  // upstairs on the right: the office behind a glass partition (a desk, a chair, a screen, a shelf of binders)
  const O = L.office, olen = O.gap - zb;
  add(new THREE.BoxGeometry(0.03, 2.5, olen), m.railGlass, O.x0, FL + 1.25, zb + olen / 2, false);
  for (const y of [FL + 0.03, FL + 2.5]) I(B(0.06, 0.06, olen, m.steel, O.x0, y, zb + olen / 2, false));
  I(B(0.06, 2.5, 0.06, m.steel, O.x0, FL + 1.25, O.gap, false));
  const OX = L.officeX, OZ = zb + 1.8; // (the office's desk: in the middle of the office, 1.8 m off the back wall)
  I(B(1.9, 0.05, 0.85, oak, OX, FL + 0.75, OZ));
  for (const sx of [-1, 1]) I(B(0.05, 0.72, 0.75, m.steel, OX + sx * 0.88, FL + 0.36, OZ));
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.5 });
  I(B(0.6, 0.38, 0.03, dark, OX, FL + 1.0, OZ - 0.25, false));
  I(B(0.56, 0.34, 0.005, new THREE.MeshStandardMaterial({ color: 0x0, emissive: 0x9fc0ee, emissiveIntensity: 1 }), OX, FL + 1.0, OZ - 0.232, false));
  I(B(0.52, 0.08, 0.5, dark, OX, FL + 0.48, OZ - 0.8)); I(B(0.52, 0.6, 0.06, dark, OX, FL + 0.82, OZ - 1.05));
  I(B(0.06, 0.44, 0.06, m.steel, OX, FL + 0.22, OZ - 0.8, false));
  I(B(2.6, 1.9, 0.38, oak, OX + 1.0, FL + 0.95, zb + 0.2));
  { const r = rng(21); for (let k = 0; k < 22; k++) I(B(0.08, 0.3, 0.26, new THREE.MeshStandardMaterial({ color: [0x1546c8, 0xd0342c, 0x2a2c30, 0xe8c21a][k % 4], roughness: 0.7 }), OX - 0.15 + k * 0.105, FL + 1.25 + (k > 10 ? -0.6 : 0) + r() * 0.01, zb + 0.25, false)); }
  // the roof: two slabs from the ridge to the eaves (timber underneath: the ceiling inside), front and back overhangs;
  // outside, a thick layer of snow on each and a dark fascia on the eaves
  const k = RISE / (W / 2), runR = W / 2 + EAVE, drop = RISE + k * EAVE, len = Math.hypot(runR, drop), angR = Math.atan2(drop, runR);
  const zlen = D + 2 * T + (out ? EAVE_F + 0.6 : 0), zc = out ? (EAVE_F - 0.6) / 2 : 0;
  for (const sx of [-1, 1]) {
    const nx = Math.sin(angR) * sx, ny = Math.cos(angR);
    const cx = sx * runR / 2, cy = H + RISE - drop / 2;
    const slab = B(len, 0.28, zlen, out ? m.roof : m.larchIn, cx + nx * 0.14, cy + ny * 0.14, zc);
    slab.rotation.z = -sx * angR;
    if (out) {
      const ce = I(B(len, 0.02, D + 2 * T, inner, cx - nx * 0.012, cy - ny * 0.012, 0, false)); ce.rotation.z = -sx * angR;
      const sn = B(len + 0.08, 0.34, zlen - 0.1, m.snow, cx + nx * 0.45, cy + ny * 0.45, zc);
      sn.rotation.z = -sx * angR;
      B(0.12, 0.42, zlen, m.steel, sx * (runR + 0.02), H - k * EAVE - 0.05, zc);
    }
  }
  // glulam trusses (a tie beam, the king post, two struts), the ridge beam, light strips under each tie beam
  for (let z = -D / 2 + 1.75; z < D / 2 - 0.5; z += 3.5) {
    I(B(W, 0.36, 0.24, glu, 0, H - 0.18, z));
    I(B(0.24, RISE, 0.24, glu, 0, H + RISE / 2, z));
    for (const sx of [-1, 1]) { const s = I(B(Math.hypot(W / 4, RISE * 0.5), 0.2, 0.2, glu, sx * W / 8, H + RISE * 0.25, z)); s.rotation.z = -sx * Math.atan2(RISE * 0.5, W / 4); }
    I(B(W - 3, 0.04, 0.12, strips, 0, H - 0.38, z, false));
  }
  I(B(0.3, 0.4, D, glu, 0, H + RISE - 0.35, 0));
  return { glassMeshes, strips, front: fz, doors: leaves, lit: out ? [m.larchInLit, m.oakLit, m.glulamLit] : [] };
}
