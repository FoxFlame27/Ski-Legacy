// THE WERKSTATT · GARAGE (Oct 30, the user: "make sure that there is a garage next to the car dealership where you can
// repair your car make sure it makes sense with the towing price and the full price of the car"): a repair garage
// beside the Autohaus, on the road through Legacy Village, in the Autohaus's alpine style (carrentalshell.js
// shellMaterials): larch walls on a stone plinth, a snow-laden gable roof with the WERKSTATT · GARAGE board on the
// gable (lit at night), a wide open bay (the roll-up door rolled up under its drum), a lit office window, lanterns
// either side of the bay, a wrought-iron bracket sign, a paved apron from the road to the bay. Inside (self-lit at
// night: the boards, the floor, the Meshy props): the repair bay (a yellow box on the concrete, REPARATUR), and the
// workshop half: a red two-post lift, the workbench under the tool wall, tyre stacks, oil drums (tools/meshy-werkstatt.mjs;
// each with a procedural stand-in until, or if never, it loads).
// - The site: planned here at start-up from the Autohaus's own (busRoads.rental) and its car park (impound.js lot):
//   on the side of the hall away from the car park, else past the car park, else further along; its front square to
//   the road, the apron reaching the road's edge; clear of every lane, junction, car park, the railway, runs, lifts,
//   other buildings' colliders and the forest, on the flattest ground (as impound.js plans the car park).
// - Repair: drive your car into the bay and stop: the card (bottom left, the tow yard card's brush style) shows the
//   damage and the price (a flat $500 for any car and any damage: carrental.js repairCost; a wreck: the $1,500 tow +
//   the $500 repair); E: pay, the car is held a few seconds
//   while the progress card runs, then (behind a fade) the dents come out, the lamps are new, damage 0. On foot: E at
//   the workbench repairs your car standing in the bay. Multiplayer: the server prices and charges it (net/session.js
//   repairCar -> server carRepair: the flat repairFee for any damage); the others never saw the knocks'
//   dents (only a wreck's look is shared: net/vehicles.js), so nothing else changes for them.
//
// Garage frame: origin on the floor in the middle of the building, +z out of the bay toward the road, +x along it.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { nightUniform, makeSign, standSign } from '../world/village.js';
import { busRoads, laneDistance, roadsideBlocked, ROAD_HALF } from './bus/roads.js';
import { planWerkstattSite } from './bus/autohaus.js'; // (its site: planned with the roads)
import { groundPatchGeometry, groundDecal } from '../world/groundpatch.js';
import { shellMaterials } from './carrentalshell.js';
import { swapInModel } from './prisonoutside.js';
import { mergeStatic } from '../engine/merge.js';
import { RENTALS, repairCost, wreckFee } from './carrental.js';

// the building (outer, m): width along the road, depth, wall height, the ridge's rise, wall thickness, eaves
export const SHOP = { W: 14, D: 11, H: 4.4, RISE: 2.3, T: 0.3, EAVE: 0.9, EAVE_F: 1.3 };
const IW = SHOP.W / 2 - SHOP.T, ID = SHOP.D / 2 - SHOP.T; // (inside half width / half depth)
const DOOR = { x0: -5.9, x1: -1.1, h: 3.7 };   // the open bay in the front wall
const BAY = { x: -3.5, z: -0.6, hw: 1.6, hl: 2.9 }; // the repair box (the car's middle inside it)
const BENCH = { x: 3.4, z: -ID + 0.4 };        // the workbench (on foot: E here)
const REPAIR_S = 4;                            // the repair's few seconds
const SLAB = 0.15;                             // the floor slab's top over the ground's highest point under it
const WIN = { x0: 1.0, x1: 4.4, y0: 1.1, y1: 2.6 }; // the office window's opening in the front wall (right of the bay)

const CSS = `
#werk-card { position: absolute; left: 22px; bottom: 92px; width: calc(var(--u, 1px) * 430); padding: calc(var(--u, 1px) * 12) calc(var(--u, 1px) * 30) calc(var(--u, 1px) * 14) calc(var(--u, 1px) * 24);
  background: #fff; color: var(--blue, #1546c8); clip-path: var(--brush-a); filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)); pointer-events: none; }
#werk-card[hidden] { display: none; }
body.wanted #werk-card { bottom: auto; top: calc(var(--u, 1px) * 150); }
#werk-card .wk-head { font-family: var(--num); font-style: italic; font-weight: 700; font-size: calc(var(--u, 1px) * 18); letter-spacing: 0.08em; color: #d98a00; }
#werk-card .wk-main { font-family: var(--num); font-style: italic; font-weight: 700; font-size: calc(var(--u, 1px) * 34); line-height: 1.05; font-variant-numeric: tabular-nums; }
#werk-card .wk-sub { margin-top: calc(var(--u, 1px) * 4); font-size: calc(var(--u, 1px) * 14.5); font-weight: 700; color: var(--blue-dim, #4f72d4); line-height: 1.3; }
#werk-card .wk-sub:empty { display: none; }
#werk-card .wk-bar { margin-top: calc(var(--u, 1px) * 8); height: calc(var(--u, 1px) * 10); background: #dfe6f7; }
#werk-card .wk-bar[hidden] { display: none; }
#werk-card .wk-bar i { display: block; height: 100%; width: 0; background: var(--blue, #1546c8); }`;

const money = (v) => `$${Math.round(v || 0).toLocaleString('en-US')}`;
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
// UVs in metres on a box (each face by its own two axes: one texture scale everywhere)
function worldUV(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ay > 0.5) uv.setXY(i, p.getX(i), p.getZ(i)); else if (ax > 0.5) uv.setXY(i, p.getZ(i), p.getY(i)); else uv.setXY(i, p.getX(i), p.getY(i));
  }
  return geo;
}

export class Werkstatt {
  /** @param {import('./carrental.js').CarRental} rental */
  constructor(rental) {
    this.R = rental;
    this.site = null;
    this.job = null;      // the repair under way { e, t, fee, driving }
    this.paying = false;  // (multiplayer: waiting for the server's answer)
    this.offered = false; // (this frame: E is the Repair, not getting out: drive.js eTaken)
    this.litMats = [];
    try { this.site = this.plan(); } catch (e) { console.warn('Werkstatt: plan', e); }
    if (!this.site) { console.warn('Werkstatt: no site found'); return; }
    try { this.build(); } catch (e) { console.warn('Werkstatt: build', e); }
    const d = rental.drive;
    if (d) d.eTaken = () => this.offered;
  }

  // garage frame -> world { x, z }; world -> garage frame [lx, lz]
  w(lx, lz) { const S = this.site; return { x: S.x + S.ax * lx + S.fx * lz, z: S.z + S.az * lx + S.fz * lz }; }
  local(x, z) { const S = this.site, dx = x - S.x, dz = z - S.z; return [dx * S.ax + dz * S.az, dx * S.fx + dz * S.fz]; }
  inside(x, z, pad = 0) { const [lx, lz] = this.local(x, z); return Math.abs(lx) < IW + pad && Math.abs(lz) < ID + pad; }

  // ------------------------------------------------------------------ the site
  plan() {
    const R = this.R, RL = R.L;
    if (!RL || !busRoads.roads.length) return null;
    // (planned with the roads, bus/autohaus.js: a building lot the roads' cut levels, the apron flush with the road and
    // no plough berm across it; fallback: the same planning here, on the ground as it is)
    const lot = busRoads.werkstatt;
    const best = lot?.site ? { ...lot.site } : planWerkstattSite(RL, R.impound?.lot || null, { colliders: R.colliders });
    if (!best) return null;
    const { W, D } = SHOP;
    // the floor: a level concrete slab a hand above the ground's highest point under the building and the bay's
    // threshold (the drawn terrain, every 2 m vertex of it: none pokes through), its walls reaching down to the lowest
    // (Oct 30, the user: "make the floor in the garage straight": it followed the slope before)
    let top = -Infinity;
    for (let lx = -W / 2; lx <= W / 2 + 0.01; lx += 0.5) for (let lz = -D / 2; lz <= D / 2 + 0.81; lz += 0.5) {
      if (lz > D / 2 && (lx < DOOR.x0 - 0.3 || lx > DOOR.x1 + 0.3)) continue;
      const x = best.x + best.ax * lx + best.fx * lz, z = best.z + best.az * lx + best.fz * lz;
      top = Math.max(top, world.meshHeight ? world.meshHeight(x, z) : world.height(x, z));
    }
    best.y = (Number.isFinite(top) ? top : world.height(best.x, best.z)) + SLAB;
    best.yaw = Math.atan2(best.fx, best.fz);
    return best;
  }

  // ------------------------------------------------------------------ the building
  build() {
    const S = this.site, R = this.R, { W, D, H, RISE, T, EAVE, EAVE_F } = SHOP;
    const m = shellMaterials();
    const g = new THREE.Group(); g.name = 'werkstatt';
    g.position.set(S.x, S.y, S.z); g.rotation.y = S.yaw;
    const MH = (x, z) => (world.meshHeight ? world.meshHeight(x, z) : world.height(x, z));
    const gy = (lx, lz) => { const p = this.w(lx, lz); return MH(p.x, p.z) - S.y; };
    const base = Math.min(S.lo, S.y) - S.y - 0.6; // (the walls' foot, under the snow at the lowest corner; the floor: y 0)
    const add = (geo, mat, x, y, z, shadow = true, parent = g) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = shadow; o.receiveShadow = true; parent.add(o); return o; };
    const B = (w, h, d, mat, x, y, z, shadow, parent) => add(worldUV(new THREE.BoxGeometry(w, h, d)), mat, x, y, z, shadow, parent);
    // self-lit at night (update(): more at night): the inner boards, the floor, the props
    const lit = (src, k = 0.2) => { const o = src.clone(); o.emissive = new THREE.Color(0xffffff); o.emissiveMap = src.map || null; if (!src.map) o.emissive.copy(src.color); o.emissiveIntensity = k; o.userData.lit = k; this.litMats.push(o); return o; };
    const inner = lit(m.larchIn, 0.18);
    const steel = m.steel, red = new THREE.MeshStandardMaterial({ color: 0xb8231c, roughness: 0.5, metalness: 0.3 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe8b81c, roughness: 0.6 }), rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.9 });
    const wallH = H - base, wallY = (H + base) / 2;
    // walls: the back and the sides (larch outside, the lit boards inside), the stone plinth round the foot
    B(W, wallH, T, m.larchOut, 0, wallY, -D / 2 + T / 2);
    B(2 * IW, H, 0.02, inner, 0, H / 2, -ID + 0.01, false);
    for (const sx of [-1, 1]) {
      B(T, wallH, D, m.larchOut, sx * (W / 2 - T / 2), wallY, 0);
      B(0.02, H, 2 * ID, inner, sx * (IW - 0.01), H / 2, 0, false);
      B(0.14, 0.9 - base, D + 0.28, m.stone, sx * (W / 2 + 0.07), (0.9 + base) / 2 - 0.2, 0);
    }
    B(W + 0.28, 0.9 - base, 0.14, m.stone, 0, (0.9 + base) / 2 - 0.2, -D / 2 - 0.07);
    // the front: a stone pier left of the bay, the larch wall right of it (the office window, a side door), a header over
    // the bay; the plinth along the front except across the bay
    const fz0 = D / 2 - T / 2, fzO = D / 2 + 0.01, pierW = DOOR.x0 + W / 2, rightW = W / 2 - DOOR.x1;
    B(pierW, wallH, T + 0.12, m.stone, -W / 2 + pierW / 2, wallY, fz0 + 0.06);
    // (the right part round the office window's opening: a real hole through the wall, glazed: see below)
    const { x0: wx0, x1: wx1, y0: wy0, y1: wy1 } = WIN, wcx = (wx0 + wx1) / 2, wcy = (wy0 + wy1) / 2, ww = wx1 - wx0, wh = wy1 - wy0;
    B(wx0 - DOOR.x1, wallH, T, m.larchOut, (DOOR.x1 + wx0) / 2, wallY, fz0);
    B(W / 2 - wx1, wallH, T, m.larchOut, (wx1 + W / 2) / 2, wallY, fz0);
    B(ww, wy0 - base, T, m.larchOut, wcx, (wy0 + base) / 2, fz0);
    B(ww, H - wy1, T, m.larchOut, wcx, (H + wy1) / 2, fz0);
    const board = (x0, x1, y0, y1) => B(x1 - x0, y1 - y0, 0.02, inner, (x0 + x1) / 2, (y0 + y1) / 2, ID - 0.01, false);
    board(DOOR.x1, wx0, 0, H); board(wx1, IW, 0, H); board(wx0, wx1, 0, wy0); board(wx0, wx1, wy1, H);
    B(DOOR.x1 - DOOR.x0, H - DOOR.h, T, m.larchOut, (DOOR.x0 + DOOR.x1) / 2, (H + DOOR.h) / 2, fz0);
    const SD = 5.6; // (the side door; the plinth stops either side of it, a stone step up to it)
    B(SD - 0.6 - DOOR.x1, 0.9 - base, 0.14, m.stone, (DOOR.x1 + SD - 0.6) / 2, (0.9 + base) / 2 - 0.2, D / 2 + 0.07);
    B(W / 2 + 0.14 - SD - 0.6, 0.9 - base, 0.14, m.stone, (SD + 0.6 + W / 2 + 0.14) / 2, (0.9 + base) / 2 - 0.2, D / 2 + 0.07);
    B(1.3, -base, 0.6, m.stone, SD, base / 2, D / 2 + 0.3);
    B(DOOR.x1 - DOOR.x0 + 0.3, 0.32, 0.36, m.glulam, (DOOR.x0 + DOOR.x1) / 2, DOOR.h + 0.16, D / 2 + 0.05); // (the lintel)
    // the roll-up door, rolled up: its drum box over the opening inside, a hand's width of slats below it, the guide rails
    const slatT = canvasTex(64, 256, (c, w, h) => { c.fillStyle = '#c9ccd0'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 16) { c.fillStyle = '#9ea2a8'; c.fillRect(0, y, w, 3); c.fillStyle = '#e4e6e9'; c.fillRect(0, y + 3, w, 2); } });
    slatT.wrapS = slatT.wrapT = THREE.RepeatWrapping; slatT.repeat.set(8, 1);
    const slat = new THREE.MeshStandardMaterial({ map: slatT, roughness: 0.55, metalness: 0.5 });
    B(DOOR.x1 - DOOR.x0 + 0.2, 0.55, 0.55, m.steel, (DOOR.x0 + DOOR.x1) / 2, DOOR.h + 0.2, ID - 0.3);
    add(new THREE.BoxGeometry(DOOR.x1 - DOOR.x0, 0.32, 0.05), slat, (DOOR.x0 + DOOR.x1) / 2, DOOR.h - 0.16, ID - 0.06);
    for (const x of [DOOR.x0 + 0.06, DOOR.x1 - 0.06]) B(0.1, DOOR.h, 0.12, steel, x, DOOR.h / 2, ID - 0.06);
    // the office window (Oct 30, the user: "fix this window so you can look in from outside and look out from inside":
    // it was an opaque lit plane, flush with the inner boards, flickering against them): a framed opening through the
    // wall, its reveals lined, a steel sash with two mullions round clear tinted glass (both faces, see-through; the
    // lit workshop shows through it at night, the glass itself a warm sheen then), an oak sill outside and in.
    // Still solid (the wall's collider runs across it).
    const ft = 0.08; // (the casing's width)
    for (const [z, d] of [[fzO + 0.02, 0.05], [ID - 0.025, 0.05]]) { // (the casing, outside and in)
      B(ww + 2 * ft, ft, d, m.glulam, wcx, wy1 + ft / 2, z, false);
      for (const x of [wx0 - ft / 2, wx1 + ft / 2]) B(ft, wh, d, m.glulam, x, wcy, z, false);
    }
    for (const y of [wy0 + 0.015, wy1 - 0.015]) B(ww, 0.03, T, inner, wcx, y, fz0, false); // (the reveals)
    for (const x of [wx0 + 0.015, wx1 - 0.015]) B(0.03, wh, T, inner, x, wcy, fz0, false);
    B(ww, 0.06, 0.08, steel, wcx, wy0 + 0.06, fz0, false); B(ww, 0.06, 0.08, steel, wcx, wy1 - 0.06, fz0, false); // (the sash)
    for (const x of [wx0 + 0.06, wx1 - 0.06, wx0 + ww / 3, wx0 + 2 * ww / 3]) B(0.06, wh - 0.12, 0.08, steel, x, wcy, fz0, false);
    B(ww + 0.3, 0.06, 0.26, m.oak, wcx, wy0 - 0.03, D / 2 + 0.08, false); // (the sills)
    B(ww + 0.1, 0.05, 0.2, m.oak, wcx, wy0 - 0.025, ID - 0.08, false);
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0xc4dbe6, emissive: 0xffd6a0, emissiveIntensity: 0.05, roughness: 0.06, metalness: 0.15,
      transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
    { const gl = add(new THREE.PlaneGeometry(ww - 0.1, wh - 0.1), this.glassMat, wcx, wcy, fz0, false); gl.receiveShadow = false; gl.renderOrder = 2; gl.userData.noMerge = true; }
    // the side door (dark larch, a little window), on its step
    this.winMat = new THREE.MeshStandardMaterial({ color: 0x9fb4c4, emissive: 0xffe2b8, emissiveIntensity: 0.3, roughness: 0.15, metalness: 0.2 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.7 });
    B(1.0, 2.15, 0.08, doorMat, SD, 1.075, fzO + 0.04, false);
    add(new THREE.PlaneGeometry(0.42, 0.5), this.winMat, SD, 1.6, fzO + 0.085, false);
    B(0.06, 0.24, 0.06, steel, SD - 0.35, 1.05, fzO + 0.1, false);
    // the gables (back and front), larch
    const gable = new THREE.Shape(); gable.moveTo(-W / 2, 0); gable.lineTo(W / 2, 0); gable.lineTo(0, RISE); gable.closePath();
    const gGeo = new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false });
    { const p = gGeo.attributes.position, uv = gGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i)); }
    add(gGeo, m.larchOut, 0, H, -D / 2);
    add(gGeo, m.larchOut, 0, H, D / 2 - T);
    // the roof: two dark slabs from the ridge to the eaves (the boards underneath), a thick layer of snow, the fascia
    const k = RISE / (W / 2), runR = W / 2 + EAVE, drop = RISE + k * EAVE, len = Math.hypot(runR, drop), angR = Math.atan2(drop, runR);
    const zlen = D + EAVE_F + 0.5, zc = (EAVE_F - 0.5) / 2;
    for (const sx of [-1, 1]) {
      const nx = Math.sin(angR) * sx, ny = Math.cos(angR), cx = sx * runR / 2, cy = H + RISE - drop / 2;
      B(len, 0.26, zlen, m.roof, cx + nx * 0.13, cy + ny * 0.13, zc).rotation.z = -sx * angR;
      B(len, 0.02, D - 0.1, inner, cx - nx * 0.012, cy - ny * 0.012, 0, false).rotation.z = -sx * angR;
      B(len + 0.08, 0.32, zlen - 0.1, m.snow, cx + nx * 0.42, cy + ny * 0.42, zc).rotation.z = -sx * angR;
      B(0.12, 0.4, zlen, steel, sx * (runR + 0.02), H - k * EAVE - 0.05, zc);
    }
    // inside: tie beams with light strips under them (lit at night), the ridge beam
    this.stripMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1dc, emissiveIntensity: 1.4 });
    const glu = lit(m.glulam, 0.12);
    for (const z of [-3.4, 0, 3.4]) {
      B(2 * IW, 0.3, 0.22, glu, 0, H - 0.15, z);
      B(2 * IW - 2, 0.05, 0.14, this.stripMat, 0, H - 0.33, z, false);
    }
    B(0.24, 0.32, 2 * ID, glu, 0, H + RISE - 0.3, 0);
    // the floor: a level concrete slab (its top: y 0, down to the walls' foot under the snow), on it the yellow repair
    // box with REPARATUR, oil stains, a drain; a concrete ramp from the bay's sill down to the apron where the ground
    // falls away; the apron outside: packed snow over asphalt from the bay to the road's edge, fading into the snow at
    // its sides (on the drawn terrain's own triangles: world/groundpatch.js)
    g.updateMatrixWorld(true);
    const conc = lit(new THREE.MeshStandardMaterial({ color: 0x8c8a85, roughness: 0.9 }), 0.06);
    B(W - 0.04, -base, D - 0.04, conc, 0, base / 2, 0);
    const floorT = canvasTex(1024, 768, (c, w, h) => {
      const r = rng(17), X = (lx) => ((lx + IW) / (2 * IW)) * w, Z = (lz) => ((lz + ID) / (2 * ID)) * h;
      c.fillStyle = '#8f8d88'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const v = 120 + r() * 40; c.fillStyle = `rgba(${v},${v - 2},${v - 6},0.35)`; c.fillRect(r() * w, r() * h, 2, 2); }
      for (let i = 0; i < 14; i++) { const x = r() * w, y = r() * h, R2 = 14 + r() * 40, gr = c.createRadialGradient(x, y, 0, x, y, R2); gr.addColorStop(0, 'rgba(40,36,30,0.35)'); gr.addColorStop(1, 'rgba(40,36,30,0)'); c.fillStyle = gr; c.fillRect(x - R2, y - R2, 2 * R2, 2 * R2); }
      c.strokeStyle = 'rgba(70,70,70,0.5)'; c.lineWidth = 2; // (the slab's joints)
      for (let lx = -IW + 3.35; lx < IW; lx += 3.35) { c.beginPath(); c.moveTo(X(lx), 0); c.lineTo(X(lx), h); c.stroke(); }
      c.beginPath(); c.moveTo(0, Z(0)); c.lineTo(w, Z(0)); c.stroke();
      c.strokeStyle = 'rgba(236,184,28,0.95)'; c.lineWidth = 9;
      c.strokeRect(X(BAY.x - BAY.hw), Z(BAY.z - BAY.hl), X(BAY.x + BAY.hw) - X(BAY.x - BAY.hw), Z(BAY.z + BAY.hl) - Z(BAY.z - BAY.hl));
      c.fillStyle = 'rgba(236,184,28,0.95)'; c.font = 'italic 700 46px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.save(); c.translate(X(BAY.x), Z(BAY.z + BAY.hl) + 34); c.fillText('REPARATUR', 0, 0); c.restore();
      c.fillStyle = '#5d5c58'; c.fillRect(X(BAY.x) - 30, Z(BAY.z) - 8, 60, 16); // (the drain)
    });
    const floorMat = lit(new THREE.MeshStandardMaterial({ map: floorT, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), 0.1);
    add(new THREE.PlaneGeometry(2 * IW, 2 * ID), floorMat, 0, 0.004, 0, false).rotation.x = -Math.PI / 2;
    const toLocal = (v) => g.worldToLocal(v), corners = (x0, x1, z0, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([lx, lz]) => { const p = this.w(lx, lz); return [p.x, p.z]; });
    // the ramp: as gentle as the apron allows (1 in 7 at the least), across the bay a little wider than it, until it
    // meets the ground (none where the ground at the sill is level with the floor)
    const RX0 = DOOR.x0 - 0.3, RX1 = DOOR.x1 + 0.3, rMax = Math.max(1, S.gap - 0.4);
    const dropAt = (d) => Math.min(gy(RX0, D / 2 + d), gy((RX0 + RX1) / 2, D / 2 + d), gy(RX1, D / 2 + d)); // (the ground, floor-relative)
    let rk = 0, rL = 0;
    if (dropAt(0.3) < -0.06) {
      let need = Infinity;
      for (let d = 0.5; d <= rMax + 1e-6; d += 0.25) need = Math.min(need, -dropAt(d) / d);
      rk = Math.min(0.35, Math.max(1 / 7, need));
      rL = rMax;
      for (let d = 0.5; d <= rMax + 1e-6; d += 0.25) if (-rk * d <= dropAt(d)) { rL = d; break; }
      rL = Math.min(rMax, rL + 0.4); // (its toe under the snow)
      const rGeo = new THREE.BoxGeometry(RX1 - RX0, 1, rL + 0.02), pp = rGeo.attributes.position, foot = Math.min(base, -rk * rL - 0.5);
      for (let i = 0; i < pp.count; i++) { const d = Math.max(0, pp.getZ(i) + rL / 2 - 0.02); pp.setY(i, pp.getY(i) > 0 ? -rk * d : foot); }
      rGeo.computeVertexNormals();
      add(worldUV(rGeo), conc, (RX0 + RX1) / 2, 0, D / 2 + rL / 2 - 0.02);
    }
    // walkable and drivable: the slab level (cars sit level in the box), the ramp down from its sill (world.groundHeight)
    {
      const Y = S.y, hw = W / 2, hd = D / 2;
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (const [x, z] of corners(-hw, hw, -hd, hd + rL)) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
      this.surface = world.addSurface({ bounds: { minx: minx - 1, minz: minz - 1, maxx: maxx + 1, maxz: maxz + 1 }, height: (x, z) => {
        const [lx, lz] = this.local(x, z);
        if (lx > -hw && lx < hw && lz > -hd && lz <= hd) return Y;
        if (rL > 0 && lz > hd && lz < hd + rL && lx > RX0 && lx < RX1) return Y - rk * (lz - hd);
        return null;
      } });
    }
    const AX0 = -W / 2 - 0.6, AX1 = W / 2 + 0.6, AZ0 = D / 2 - 0.05, AZ1 = D / 2 + S.gap - 0.1, AW = AX1 - AX0, AD = AZ1 - AZ0;
    const apronT = canvasTex(1024, 512, (c, w, h) => {
      const r = rng(23);
      c.fillStyle = '#7b7975'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 8000; i++) { const v = 100 + r() * 40; c.fillStyle = `rgba(${v + 6},${v + 3},${v},0.4)`; c.fillRect(r() * w, r() * h, 2, 2); }
      for (let i = 0; i < 50; i++) { const x = r() * w, y = r() * h, R2 = 20 + r() * 80, gr = c.createRadialGradient(x, y, 0, x, y, R2); gr.addColorStop(0, 'rgba(236,238,240,0.4)'); gr.addColorStop(1, 'rgba(236,238,240,0)'); c.fillStyle = gr; c.fillRect(x - R2, y - R2, 2 * R2, 2 * R2); }
      c.globalCompositeOperation = 'destination-in';
      const fx = c.createLinearGradient(0, 0, w, 0); fx.addColorStop(0, 'rgba(0,0,0,0)'); fx.addColorStop(0.05, '#000'); fx.addColorStop(0.95, '#000'); fx.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = fx; c.fillRect(0, 0, w, h);
    });
    const apron = new THREE.Mesh(groundPatchGeometry(corners(AX0, AX1, AZ0, AZ1), { lift: 0.04, toLocal, uv: (x, z) => { const [lx, lz] = this.local(x, z); return [(lx - AX0) / AW, 1 - (lz - AZ0) / AD]; } }),
      groundDecal(new THREE.MeshStandardMaterial({ map: apronT, roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })));
    apron.receiveShadow = true; apron.renderOrder = 1; g.add(apron);
    // the WERKSTATT · GARAGE board on the front gable (the village's sign style), lit at night
    const sign = makeSign('WERKSTATT · GARAGE\nReparaturen · Repairs', { w: 5.6, h: 1.2, font: 'bold 84px Georgia' });
    sign.position.set(0, H + 0.72, D / 2 + 0.06); g.add(sign);
    this.signMat = sign.userData.faceMaterial;
    // lanterns either side of the bay and a floodlight bar over it (lit at night)
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffc77a, emissiveIntensity: 0.2 });
    for (const x of [DOOR.x0 - 0.5, DOOR.x1 + 0.5]) {
      B(0.1, 0.24, 0.16, steel, x, 2.95, fzO + 0.08, false);
      B(0.26, 0.42, 0.26, steel, x, 2.8, fzO + 0.3);
      add(new THREE.BoxGeometry(0.2, 0.32, 0.2), this.lampMat, x, 2.8, fzO + 0.3, false);
    }
    B(DOOR.x1 - DOOR.x0 - 0.6, 0.1, 0.22, steel, (DOOR.x0 + DOOR.x1) / 2, DOOR.h + 0.42, fzO + 0.2, false);
    add(new THREE.BoxGeometry(DOOR.x1 - DOOR.x0 - 0.8, 0.03, 0.14), this.lampMat, (DOOR.x0 + DOOR.x1) / 2, DOOR.h + 0.36, fzO + 0.2, false);

    // the props (Meshy; each a procedural stand-in until it loads), lit at night like the boards, on the level floor (y 0)
    const props = new THREE.Group(); g.add(props);
    const prop = (name, fit, lx, lz, ry, y, stand, onModel) => {
      const pg = new THREE.Group(); pg.position.set(lx, y, lz); pg.rotation.y = ry; props.add(pg);
      const fb = new THREE.Group(); pg.add(fb); stand(fb);
      swapInModel(pg, `decor/${name}`, fit, fb, (mdl) => { onModel?.(mdl); this.litModel(mdl); });
      return pg;
    };
    // the workbench under the tool wall (back wall, workshop half)
    prop('garage_workbench', { size: 2.0, axis: 'x' }, BENCH.x, BENCH.z, 0, 0, (fb) => {
      B(2.0, 0.08, 0.75, m.oak, 0, 0.88, 0, true, fb);
      B(1.9, 0.8, 0.68, new THREE.MeshStandardMaterial({ color: 0x24407a, roughness: 0.6, metalness: 0.3 }), 0, 0.42, 0, true, fb);
    });
    prop('garage_toolwall', { size: 2.4, axis: 'x' }, BENCH.x, -ID + 0.26, 0, 0.93, (fb) => {
      B(2.4, 1.3, 0.04, new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.7 }), 0, 0.75, -0.2, false, fb);
      for (let i = 0; i < 9; i++) B(0.05, 0.3 + (i % 3) * 0.08, 0.03, steel, -1.0 + i * 0.25, 0.9, -0.16, false, fb);
    });
    // the two-post lift in the workshop half (standing free, its arms folded), stretched to a car's width between posts
    const LIFT = { x: 3.3, z: 0.4, s: 1.45 };
    prop('garage_lift', { size: 3.5, axis: 'y' }, LIFT.x, LIFT.z, 0, 0, (fb) => {
      for (const sx of [-1, 1]) { B(0.3, 3.5, 0.3, red, sx * 1.45, 1.75, -0.3, true, fb); B(0.4, 0.06, 1.8, red, sx * 1.45, 0.03, 0.2, true, fb); }
      B(3.2, 0.2, 0.2, red, 0, 3.4, -0.3, true, fb);
    }, (mdl) => { mdl.scale.x *= LIFT.s; });
    // tyre stacks, oil drums
    const tyres = (lx, lz) => prop('garage_tyres', { size: 0.95, axis: 'y' }, lx, lz, lx * 1.7, 0, (fb) => {
      for (let i = 0; i < 4; i++) add(new THREE.TorusGeometry(0.24, 0.085, 8, 18), rubber, 0, 0.1 + i * 0.22, 0, true, fb).rotation.x = Math.PI / 2;
    });
    tyres(IW - 0.5, ID - 0.6); tyres(IW - 1.25, ID - 0.55); tyres(0.0, -ID + 0.5);
    prop('garage_drums', { size: 1.4, axis: 'xz' }, -IW + 0.85, -ID + 0.75, 0.3, 0, (fb) => {
      for (const [x, z, c] of [[-0.35, -0.15, 0x1d4fa8], [0.35, -0.15, 0x1d4fa8], [0, 0.4, 0xb8231c]]) add(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 16), new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.4 }), x, 0.44, z, true, fb);
    });
    // the wrought-iron bracket sign right of the bay (the gilded spanners), sticking out toward the road
    const signP = prop('garage_signbracket', { size: 1.3, axis: 'xz' }, DOOR.x1 + 1.0, fzO + 0.66, Math.PI / 2, 2.55, (fb) => {
      B(1.3, 0.05, 0.05, steel, 0, 0.78, 0, false, fb);
      add(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 20), steel, 0.05, 0.4, 0, false, fb).rotation.x = Math.PI / 2;
    });
    void signP;
    // a yellow-black kerb stop at the back of the repair box
    B(1.6, 0.12, 0.22, yellow, BAY.x, 0.06, -ID + 0.5);

    // (performance pass: the building's boxes welded per material; the props' stand-ins stay to be swapped)
    try { mergeStatic(g, { skip: [props] }); } catch (e) { console.warn('Werkstatt: merge', e); }
    R.scene.add(g);
    g.updateMatrixWorld(true);
    this.group = g;

    // the roadside sign by the apron (on its posts), if the verge there is free
    try {
      const lx = DOOR.x1 + 2.6, lz = D / 2 + S.gap - 2.4, p = this.w(lx, lz);
      if (!roadsideBlocked(p.x, p.z, 1.4, -1, 0, { lots: false }) && laneDistance(p.x, p.z) > ROAD_HALF + 1.4) { // (lots: its own apron is one now, bus/autohaus.js)
        const post = makeSign('WERKSTATT\nRepairs · Reparatur', { w: 2.4, h: 0.9, font: 'bold 92px Georgia', posts: true, postH: 1.1, pole: R.models?.sign_pole });
        R.scene.add(standSign(post, p.x, p.z, S.yaw + 0.5));
        this.postMat = post.userData.faceMaterial;
        R.colliders.push({ x: p.x, z: p.z, hw: 1.25, hd: 0.15, rot: -(S.yaw + 0.5) });
      }
    } catch (e) { console.warn('Werkstatt: roadside sign', e); }

    // solid: the walls (the bay open), the props; camera blockers for the walls and the roof
    const col = (lx, lz, hw, hd) => { const p = this.w(lx, lz); R.colliders.push({ x: p.x, z: p.z, hw, hd, rot: -S.yaw }); };
    const circ = (lx, lz, r) => { const p = this.w(lx, lz); R.colliders.push({ x: p.x, z: p.z, r }); };
    col(0, -D / 2 + T / 2, W / 2, T / 2 + 0.05);
    for (const sx of [-1, 1]) col(sx * (W / 2 - T / 2), 0, T / 2 + 0.05, D / 2);
    col(-W / 2 + pierW / 2, fz0 + 0.06, pierW / 2, (T + 0.12) / 2 + 0.05);
    col(DOOR.x1 + rightW / 2, fz0, rightW / 2, T / 2 + 0.05);
    col(BENCH.x, BENCH.z, 1.02, 0.42);
    for (const sx of [-1, 1]) circ(LIFT.x + sx * 1.45, LIFT.z - 0.3, 0.28);
    circ(IW - 0.5, ID - 0.6, 0.36); circ(IW - 1.25, ID - 0.55, 0.36); circ(0.0, -ID + 0.5, 0.36);
    circ(-IW + 0.85, -ID + 0.75, 0.72);
    const blockMat = new THREE.MeshBasicMaterial();
    const blocker = (w, h, d, x, y, z, rz = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), blockMat); b.position.set(x, y, z); b.rotation.z = rz; b.visible = false; g.add(b); b.updateMatrixWorld(true); R.cameraBlockers?.push(b); };
    blocker(W, H, T, 0, H / 2, -D / 2 + T / 2);
    for (const sx of [-1, 1]) blocker(T, H, D, sx * (W / 2 - T / 2), H / 2, 0);
    blocker(pierW, H, T, -W / 2 + pierW / 2, H / 2, fz0);
    blocker(rightW, H, T, DOOR.x1 + rightW / 2, H / 2, fz0);
    blocker(DOOR.x1 - DOOR.x0, H - DOOR.h, T, (DOOR.x0 + DOOR.x1) / 2, (H + DOOR.h) / 2, fz0);
    for (const sx of [-1, 1]) blocker(len, 0.3, D + 1, sx * runR / 2, H + RISE - drop / 2 + 0.1, 0, -sx * angR);
    g.updateMatrixWorld(true);
    // where the map points and the HUD waypoint goes: the apron in front of the bay
    this.door = this.w((DOOR.x0 + DOOR.x1) / 2, D / 2 + 1.5);
  }

  /** A Meshy prop lit at night like the boards (its own materials, glowing a little by their own texture). */
  litModel(mdl) {
    mdl.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = mats.map((src) => {
        const c = src.clone();
        if (c.emissive) { c.emissive = new THREE.Color(0xffffff); c.emissiveMap = c.map || null; if (!c.map) c.emissive.copy(c.color || new THREE.Color(0x808080)); c.userData.lit = 0.06; c.emissiveIntensity = 0.06 + 0.42 * (this._n ?? 0); this.litMats.push(c); }
        return c;
      });
      o.material = Array.isArray(o.material) ? out : out[0];
    });
  }

  // ------------------------------------------------------------------ repairing
  /** Your car in the repair box: the car (a parking entry) driven or standing there, or null. */
  carInBay() {
    const D = this.R.drive, d = D?.d;
    const inBox = (x, z) => { const [lx, lz] = this.local(x, z); return Math.abs(lx - BAY.x) < BAY.hw + 0.35 && Math.abs(lz - BAY.z) < BAY.hl + 0.3; };
    if (d) return (d.e.rental || d.e.free) && inBox(d.x, d.z) ? d.e : null;
    for (const e of [this.R.current, ...(this.R.kept || [])]) if (e && !e.driving && !e.wrecked && !e.towing && e.car && inBox(e.car.position.x, e.car.position.z)) return e;
    return null;
  }
  /** What a repair of car e costs now (the damage share, the price, its list price). */
  quote(e) {
    const id = e.cfg?.id || e.name, list = RENTALS.find((c) => c.id === id)?.price || 0;
    let frac = Math.max(0, Math.min(1, (e.damage || 0) / 100));
    if (frac <= 0 && e.dents?.length) frac = 0.01; // (dented, no damage on the clock: a small job)
    return { id, list, frac, pct: frac > 0 ? Math.max(1, Math.round(frac * 100)) : 0, fee: e.free ? 0 : repairCost(id, frac), wreck: wreckFee(id) };
  }

  /** main.js findInteraction (also while you drive): E to repair your car in the box. */
  interaction(p) {
    this.offered = false;
    if (!this.site || this.job || this.paying) return null;
    const D = this.R.drive, d = D?.d;
    const e = this.carInBay();
    if (!e) return null;
    if (d) { if (D.speed > 0.6 || d.crash) return null; }
    else {
      // on foot: at the workbench (the mechanic's place), your car standing in the box
      const [lx, lz] = this.local(p.x, p.z);
      if (Math.hypot(lx - BENCH.x, lz - (BENCH.z + 0.6)) > 2.2) return null;
    }
    const q = this.quote(e);
    if (q.frac <= 0) return null;
    this.offered = !!d;
    const pr = this._prompt ||= { label: '', act: null };
    pr.label = `Repair · ${q.fee ? money(q.fee) : 'free'} · damage ${q.pct}%`;
    pr.act = () => this.start(e);
    return pr;
  }

  async start(e) {
    if (this.job || this.paying || !e) return;
    const why = this.blocked?.();
    if (why) { this.R.hud?.flash(why, 'bad', 2400); this.R.audio?.play?.('error'); return; }
    const q = this.quote(e);
    if (q.frac <= 0) return;
    let fee = q.fee;
    if (fee > 0) {
      const mp = this.R.mp;
      if (mp?.repair) {
        this.paying = true;
        let r = null;
        try { r = await mp.repair(q.frac, e.cfg?.plate); } finally { this.paying = false; }
        if (!r) return;
        fee = r.fee;
        this.R.audio?.play?.('cash');
      } else if (!this.R.spend?.(fee)) return; // (single player: spend() says when it's short)
    }
    const D = this.R.drive, driving = D?.d?.e === e;
    this.job = { e, t: 0, fee, driving, label: this.R.label?.(q.id) || 'car' };
    if (driving) D.servicing = true;
    this.R.audio?.play?.('click');
  }

  finish() {
    const j = this.job;
    if (!j) return;
    const D = this.R.drive;
    let once = false;
    const done = () => {
      if (once) return; once = true;
      try { D?.repair?.(j.e); } catch (err) { console.warn('Werkstatt: repair', err); }
      if (D) D.servicing = false;
      this.job = null;
      this.R.hud?.flash(`Your ${j.label} is repaired · as good as new${j.fee ? ` · paid ${money(j.fee)}` : ''}`, 'good', 3600);
      this.R.audio?.play?.('board');
    };
    if (this.R.transition?.fade) this.R.transition.fade(done).catch(() => done()); else done();
    j.t = -1e9; // (once)
  }

  /** Per frame (carrental.js update): the repair's progress, the card, the lights at night. */
  update(dt) {
    if (!this.site) return;
    if (this.job && this.job.t >= 0) { this.job.t += dt; if (this.job.t >= REPAIR_S) this.finish(); }
    try { this.hudFrame(); } catch (e) { console.warn('Werkstatt: card', e); }
    this.offered = false; // (set again by the next frame's interaction)
    const n = nightUniform?.value ?? 0;
    if (this.signMat) this.signMat.emissiveIntensity = 0.05 + 0.75 * n;
    if (this.postMat) this.postMat.emissiveIntensity = 0.05 + 0.75 * n;
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.2 + 2.4 * n;
    if (this.winMat) this.winMat.emissiveIntensity = 0.3 + 0.9 * n;
    if (this.glassMat) this.glassMat.emissiveIntensity = 0.05 + 0.55 * n; // (a warm sheen on the office glass at night)
    if (this.stripMat) this.stripMat.emissiveIntensity = 1.4 + 2.2 * n;
    if (Math.abs(n - (this._n ?? -1)) > 0.01) { this._n = n; for (const mt of this.litMats) mt.emissiveIntensity = (mt.userData.lit ?? 0.1) + 0.42 * n; }
  }

  // The Werkstatt card (bottom left, the tow yard card's place and brush style): your car in the garage, its damage and
  // the price worked out, set against a wreck and a new one; the repair's progress
  hudFrame() {
    let t = null;
    const D = this.R.drive, d = D?.d;
    if (this.job) {
      const k = this.job.t < 0 ? 1 : Math.max(0, Math.min(1, this.job.t / REPAIR_S));
      t = { head: 'WERKSTATT · GARAGE', main: `Repairing… ${Math.round(k * 100)}%`, sub: `Your ${this.job.label} · panel beating · new lamps · paint`, sub2: '', bar: k };
    } else if (this.paying) {
      t = { head: 'WERKSTATT · GARAGE', main: 'Paying…', sub: '', sub2: '' };
    } else {
      const e = this.carInBay();
      const here = e || (d && (d.e.rental || d.e.free) && this.inside(d.x, d.z, 0.5) ? d.e : null);
      const onFoot = !d && e && this.inside(this.R.player?.pos?.x ?? 1e9, this.R.player?.pos?.z ?? 1e9, 0.3);
      if (here && (d || onFoot)) {
        const q = this.quote(here);
        // (Oct 30, the user: "don't show the calculation so complicated, show it way easier": just the damage)
        const how = q.frac <= 0 ? '' : `Damage ${q.pct}%`;
        const vs = '';
        const label = this.R.label?.(q.id) || 'car';
        if (q.frac <= 0) t = { head: 'WERKSTATT · GARAGE', main: 'No damage', sub: `Your ${label} is as good as new · nothing to repair`, sub2: '' };
        else if (!e) t = { head: 'WERKSTATT · GARAGE', main: 'Drive into the yellow box', sub: `Repair: ${money(q.fee)} · ${how}`, sub2: vs };
        else if (d && D.speed > 0.6) t = { head: 'WERKSTATT · GARAGE', main: 'Stop the car', sub: `Repair: ${money(q.fee)} · ${how}`, sub2: vs };
        else t = { head: `WERKSTATT · ${label}`, main: `Repair ${q.fee ? money(q.fee) : 'free'} · E${d ? '' : ' at the workbench'}`, sub: how, sub2: vs };
      }
    }
    this.card(t, !!d);
  }
  card(t, driving) {
    if (!t && !this.el) return;
    if (!this.el) {
      if (typeof document === 'undefined') return;
      if (!document.getElementById('werk-card-css')) { const st = document.createElement('style'); st.id = 'werk-card-css'; st.textContent = CSS; document.head.appendChild(st); }
      const el = document.createElement('div');
      el.id = 'werk-card'; el.hidden = true;
      el.innerHTML = '<div class="wk-head"></div><div class="wk-main"></div><div class="wk-sub"></div><div class="wk-sub wk-sub2"></div><div class="wk-bar" hidden><i></i></div>';
      (document.getElementById('hud') || document.body).appendChild(el);
      this.el = el; this.$ = { head: el.querySelector('.wk-head'), main: el.querySelector('.wk-main'), sub: el.querySelector('.wk-sub'), sub2: el.querySelector('.wk-sub2'), bar: el.querySelector('.wk-bar'), fill: el.querySelector('.wk-bar i') }; this.C = {};
    }
    const C = this.C, $ = this.$;
    if (!t) { if (!this.el.hidden) this.el.hidden = true; return; }
    for (const k of ['head', 'main', 'sub', 'sub2']) if (C[k] !== t[k]) $[k].textContent = C[k] = t[k] || '';
    const bar = t.bar != null;
    if ($.bar.hidden === bar) $.bar.hidden = !bar;
    if (bar) { const wv = `${Math.round(t.bar * 100)}%`; if (C.bar !== wv) $.fill.style.width = C.bar = wv; }
    if (this.el.hidden) {
      this.el.hidden = false;
      if (driving) document.querySelector('#drive-hud .ch-card')?.classList.add('out'); // (the controls card shares the corner)
      const pk = document.getElementById('park-card'); if (pk) pk.hidden = true;
    }
  }
}
