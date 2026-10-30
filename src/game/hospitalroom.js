// The MEDICAL CENTRE inside ("ARZT · MEDICAL CENTRE", game/hospital.js outside): its own scene (like the prison's and
// the Autohaus's: main.js renders it through post.setView), laid out in the house's own frame (x along the front, +z
// out of the front toward the road, y up from the floor), so its windows look out exactly where the house's windows
// are, onto the real village (game/liveportal.js).
//  - the LOBBY at the front (z 1.9 .. 5.8): warm stone flags, larch panelling under lime plaster, a larch ceiling on
//    glulam beams, the reception counter (ANMELDUNG), waiting benches, plants, the BESUCHSZEIT board, the glass doors
//  - the WARD behind it (z -5.8 .. 1.7), through a wide larch-framed opening: oak planks, four beds with their heads to
//    the back wall (a bed-head unit with a reading light over each, a bedside cabinet, a monitor and an IV stand, a
//    visitor's chair, a curtain on its ceiling track), radiators under the windows, a medicine cabinet, a supply cart
// The furniture is Meshy's (tools/meshy-hospital.mjs: public/models/hospital), each piece with a procedural stand-in
// until (or if never) its model loads.
//
//   HospitalWard.admit()   you come round in a hospital bed (the rescue's ambulance, game/heli/rescue.js release;
//                          called behind its fade): eyes open, a short stay (STAY_S, the RECOVERING card bottom left),
//                          then E gets you up and you walk out through the front doors to the forecourt
//   HospitalWard.visit()   E at the front door outside: in through the doors, walk the ward, sit by a bed
//
// Multiplayer: the interior id is 'hospital' (net/remote.js shows everyone inside to everyone else inside): a patient
// lies in bed pid % 4 (the presence row: state fall, pitch -90 deg, the tumble's tuck half way, so the body lies on
// its back with the bed's head end raised; HospitalRoom.mpPose), a visitor walks or sits on a bed's chair (state sit).
// No server state: the stay is the client's own (the server takes any interior id but a chalet's).
import * as THREE from 'three';
import { roomEnvironment } from '../engine/roomenv.js';
import { busRoads, HOSPITAL_LOT } from './bus/roads.js';
import { HOUSE } from './hospital.js';
import { makeSign, nightUniform } from '../world/village.js';
import { shellMaterials } from './carrentalshell.js';
import { swapInModel } from './prisonoutside.js';
import { LivePortal } from './liveportal.js';
import { isMP, MP } from '../net/mode.js';
import { ST, fallFlags } from '../net/protocol.js';
import { world } from '../world/world.js';
import { twoBone } from './carpeople.js';

const BEAMS_X = [-6.0, -3.6, -1.2, 1.2, 3.6, 6.0]; // the ceiling's glulam beams (x, every 2.4 m, symmetric about the middle)
export const STAY_S = 20; // the recovery (game seconds in bed before you may get up; Oct 30, the user: 20 s)
export const INTERIOR_ID = 'hospital';
const EYE = 1.62, R = 0.26, UP = new THREE.Vector3(0, 1, 0);
// the inside of the walls (the house is 15 x 12 m outside, its walls 0.2 m thick), the ceiling
const IN = { x0: -7.3, x1: 7.3, z0: -5.8, z1: 5.8, H: 3.1 };
// the partition between the ward (behind) and the lobby (in front), its wide opening in the middle
const PART = { z: 1.8, t: 0.16, ox0: -1.0, ox1: 1.0, oh: 2.45 };
const EXIT = { x: 0, z: IN.z1 - 0.15 };
// the beds: their middles along x, their heads to the back wall; the cabinet / chair side (toward the next bed's IV
// side is the other); the mattress top until the model says otherwise
export const BEDS = [-6.0, -2.0, 2.0, 6.0];
const CAB_SIDE = [1, -1, 1, -1];
const BED = { len: 2.1, w: 1.0, top: 0.61 };
const BED_STRETCH = 1.3; // (the Meshy bed lengthened: a grown-up's feet on the mattress)
const BED_Z = IN.z0 + 0.02 + BED.len / 2; // (the bed's middle)
// a patient lying in bed (the presence row's root: the hips; the head on the pillow toward the wall)
const HIPS_Z = IN.z0 + 1.0;
const PITCH = -Math.PI / 2, TUCK = 0; // (flat on the back: the tucked pose looked odd in a bed; Oct 30, the user: "just make them lie flat")
// (the tuck as it goes out in the presence row, 4 bits: your own body in bed posed exactly as the others see it)
const TUCK_Q = Math.round(TUCK * 15) / 15;
const _bh = new THREE.Vector3(), _bn = new THREE.Vector3(), _bu = new THREE.Vector3(), _bf = new THREE.Vector3();
const _ba = new THREE.Vector3(), _bl = new THREE.Vector3(), _br = new THREE.Vector3(), _bt = new THREE.Vector3(), _bp = new THREE.Vector3();

/** A patient's arms lying by its side (after the rig's fall pose, which sprawls one arm out as on the snow): the hands
 *  beside the hips on the mattress, the elbows a little out. Your own body in bed and the other players' (net/remote.js). */
export function bedArms(rig) {
  const b = rig?.b;
  if (!b?.hips || !b.lArm || !b.rArm) return;
  rig.root.updateMatrixWorld(true);
  const hip = _bh.setFromMatrixPosition(b.hips.matrixWorld);
  const ls = _bl.setFromMatrixPosition(b.lArm.matrixWorld), rs = _br.setFromMatrixPosition(b.rArm.matrixWorld);
  const right = _bn.subVectors(rs, ls).normalize(); // (the body's right)
  const down = _ba.copy(ls).add(rs).multiplyScalar(0.5); down.subVectors(hip, down).normalize(); // shoulders -> hips
  const front = _bf.copy(UP).addScaledVector(down, -UP.dot(down));
  if (front.lengthSq() < 1e-6) front.set(0, 1, 0); else front.normalize();
  for (const [s, arm, fore, hand] of [[-1, b.lArm, b.lFore, b.lHand], [1, b.rArm, b.rFore, b.rHand]]) {
    _bt.copy(hip).addScaledVector(right, s * 0.27).addScaledVector(down, 0.06).addScaledVector(front, 0.02);
    _bp.copy(right).multiplyScalar(s * 0.6).addScaledVector(front, -0.8);
    try { twoBone(arm, fore, hand, _bt, _bp); } catch { /* (the fall pose's arms stay) */ }
  }
  // the legs straight out along the bed, side by side (the fall pose sprawls them): feet ~0.9 m down from the hips
  if (b.lUp && b.lLeg && b.lFoot && b.rUp && b.rLeg && b.rFoot) {
    for (const [s, up, leg, foot] of [[-1, b.lUp, b.lLeg, b.lFoot], [1, b.rUp, b.rLeg, b.rFoot]]) {
      _bt.copy(hip).addScaledVector(right, s * 0.11).addScaledVector(down, 0.88).addScaledVector(front, 0.17); // (feet on top of the mattress, never sunk into it: the user saw no legs)
      _bp.copy(front).multiplyScalar(1).addScaledVector(down, 0.2); // (the knees up toward the ceiling: straight, never bent sideways)
      try { twoBone(up, leg, foot, _bt, _bp); } catch { /* (the fall pose's legs stay) */ }
    }
  }
}

// this ward's mattress tops as the beds' models measured them here (HospitalRoom), for the other players lying in them
let wardTops = null;
const _pst = { mode: 'fall', heading: 0, speed: 0, crouch: 0, lean: 0, edge: 0, tuck: false, air: false, normal: UP,
  fall: { pitch: PITCH, roll: 0, ball: 0, getUp: 0 }, fallSide: 1, fallHeading: 0, fallAir: false, fallT: 1, carry: false, airY: 0 };
/** Where another player lying in a bed rests (the rig's root): the bed nearest their x, on this ward's mattress (your
 *  own bed's spot in poseBody: x, the mattress + 4 cm, HIPS_Z), not the height their own client measured and sent. */
export function patientSpot(x, out) {
  let bed = 0, bd = Infinity;
  BEDS.forEach((bx, i) => { const d = Math.abs(x - bx); if (d < bd) { bd = d; bed = i; } });
  return out.set(BEDS[bed], (wardTops?.[bed] ?? BED.top) + 0.04, HIPS_Z);
}
/** Another player in a hospital bed (net/remote.js: ST.fall inside the hospital), posed exactly as your own body in
 *  bed (poseBody): the root on patientSpot, the mattress its floor, flat on the back (the pose set here, not decoded
 *  from the row's lossy pitch / flags), no blend, the arms by the side and the legs straight along the bed, the head
 *  showing, no skis, no poles, no snow. */
export function posePatient(rig, dt) {
  if (!rig?.root || !rig.b?.hips) return;
  patientSpot(rig.root.position.x, rig.root.position);
  const top = rig.root.position.y;
  if (!rig.bedUnculled) { rig.bedUnculled = true; rig.root.traverse((o) => { if (o.isMesh) o.frustumCulled = false; }); } // (lying, outside the standing pose's bounds)
  rig.snapNext = true;
  rig.setHeadHidden?.(false);
  const own = Object.prototype.hasOwnProperty.call(world, 'groundHeight'), g0 = world.groundHeight;
  world.groundHeight = () => top;
  try { rig.update(Math.min(dt, 0.1), _pst); } catch (e) { console.warn('hospital: patient', e); } finally { if (own) world.groundHeight = g0; else delete world.groundHeight; }
  if (rig.fx?.length) rig.fx.length = 0;
  if (rig.gear) rig.gear.visible = false;
  bedArms(rig);
}

// the house's windows (hospital.js: ground floor, sill-to-lintel 1.15 .. 2.45 m)
const WIN = {
  front: [[-5.2, 1.4, 1.3], [5.2, 1.4, 1.3]],
  back: [[-4.6, 1.2, 1.2], [0, 1.2, 1.2], [4.6, 1.2, 1.2]],
  side: [[-3.6, 1.3, 1.25], [0, 1.3, 1.25], [3.6, 1.3, 1.25]],
};
const WIN_Y = 1.8;

const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
function tex(w, h, draw, repeat = null) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
const fmt = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const RED = '#b3172b';
function drawCross(c, x, y, r, a = r * 0.34, col = RED) { c.fillStyle = col; c.fillRect(x - r, y - a, 2 * r, 2 * a); c.fillRect(x - a, y - r, 2 * a, 2 * r); }
// boxes with UVs in metres (for the larch / stone maps that repeat every few metres)
function worldUV(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ay > 0.5) uv.setXY(i, p.getX(i), p.getZ(i)); else if (ax > 0.5) uv.setXY(i, p.getZ(i), p.getY(i)); else uv.setXY(i, p.getX(i), p.getY(i));
  }
  return geo;
}

// How each Meshy model is turned into the room's convention (its front toward +z: a chair's sitter, a cabinet's
// doors, a counter's customer side; a bed's head toward -z), fitted by its size along an axis
const MODELS = {
  bed: { name: 'hospital/hospital_bed', size: BED.len, axis: 'xz', rotateY: 0 },
  cabinet: { name: 'hospital/bedside_cabinet', size: 0.82, axis: 'y', rotateY: 0 },
  monitor: { name: 'hospital/patient_monitor', size: 1.5, axis: 'y', rotateY: 0 },
  iv: { name: 'hospital/iv_stand', size: 1.95, axis: 'y', rotateY: 0 },
  screen: { name: 'hospital/privacy_screen', size: 1.8, axis: 'y', rotateY: 0 },
  chair: { name: 'hospital/visitor_chair', size: 0.88, axis: 'y', rotateY: 0 },
  desk: { name: 'hospital/reception_desk', size: 2.0, axis: 'xz', rotateY: Math.PI }, // (its curved customer front faces -z as made)
  bench: { name: 'hospital/waiting_bench', size: 1.8, axis: 'xz', rotateY: 0 },
  cart: { name: 'hospital/medical_cart', size: 1.0, axis: 'y', rotateY: 0 },
  medcab: { name: 'hospital/medicine_cabinet', size: 1.9, axis: 'y', rotateY: 0 },
};

export class HospitalRoom {
  constructor({ renderer }) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1d1a17);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.yaw = 0; this.pitch = 0;
    this.bounds = null; this.obstacles = []; this.t = 0;
    this.role = null; this.bed = 1; this.seat = null; this.top = BED.top;
    this.chairs = []; this.clock = null;
    // your own body in bed (the player's rig lent to this scene while you rest: poseBody / returnBody); the view from
    // its eyes, or (R, the game's view toggle) from beside the bed
    this.restView = 'first'; this.tpYaw = Math.PI; this.tpPitch = -0.45;
    this.eye = null; this.bodyC = null; this.lift = null; this.liftV = 0; this.rigHome = null; this.unculled = null;
    this.renderer = renderer;
    this.portal = new LivePortal({ name: 'Medical centre', tint: 0xf6f3ee });
    this.frame = null;
    try {
      this.scene.environment = roomEnvironment(renderer, 0.03); // (made once per blur, shared: engine/roomenv.js)
      this.scene.environmentIntensity = 0.35;
    } catch (e) { console.warn('hospital env', e); }
    const step = (n, f) => { try { f(); } catch (e) { console.warn(`hospital room: ${n}`, e); } };
    step('shell', () => this.buildShell());
    step('windows', () => this.buildWindows());
    step('lights', () => this.buildLights());
    step('lobby', () => this.buildLobby());
    step('ward', () => this.buildWard());
  }

  // ------------------------------------------------------------ helpers
  add(geo, mat, x, y, z, ry = 0, shadow = true, parent = this.scene) {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m;
  }
  box(w, h, d, mat, x, y, z, ry = 0, shadow = true, parent = this.scene) { return this.add(worldUV(new THREE.BoxGeometry(w, h, d)), mat, x, y, z, ry, shadow, parent); }
  /** A piece of furniture: the group at (x, 0, z) turned ry (its front toward local +z), the procedural stand-in made
   *  by fallback(group), the Meshy model swapped in for it once loaded. */
  furn(key, x, z, ry, fallback, onModel, y = 0) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = ry; this.scene.add(g);
    const fb = new THREE.Group(); g.add(fb);
    try { fallback?.(fb); } catch (e) { console.warn('hospital fallback', key, e); }
    fb.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const M = MODELS[key];
    if (M) swapInModel(g, M.name, { size: M.size, axis: M.axis, rotateY: M.rotateY }, fb, (m) => { try { onModel?.(m, g); } catch (e) { console.warn('hospital model', key, e); } });
    return g;
  }
  mats() {
    if (this._m) return this._m;
    const S = shellMaterials();
    const m = {
      larch: S.larchIn, glulam: S.glulam, steel: S.steel,
      white: new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.55 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xd6d9dc, roughness: 0.22, metalness: 0.9 }),
      birch: new THREE.MeshStandardMaterial({ color: 0xd9b98c, roughness: 0.55 }),
      oak: new THREE.MeshStandardMaterial({ color: 0xb98a55, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.5 }),
      sheet: new THREE.MeshStandardMaterial({ color: 0xf7f6f2, roughness: 0.9 }),
      blanket: new THREE.MeshStandardMaterial({ color: 0x8fb3cf, roughness: 0.95 }),
      teal: new THREE.MeshStandardMaterial({ color: 0x2f7f86, roughness: 0.85 }),
      mint: new THREE.MeshStandardMaterial({ color: 0xbfd8c8, roughness: 0.9 }),
      sill: new THREE.MeshStandardMaterial({ color: 0xe7e2d8, roughness: 0.6 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x2f6a34, roughness: 0.75 }),
      pot: new THREE.MeshStandardMaterial({ color: 0xa65a35, roughness: 0.8 }),
      glow: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2b0, emissiveIntensity: 2.4 }),
    };
    return (this._m = m);
  }

  // ------------------------------------------------------------ floors, walls, ceilings, the partition
  buildShell() {
    const S = this.scene, { x0, x1, z0, z1, H } = IN, M = this.mats();
    const W = x1 - x0;
    // the ward: warm oak planks (a 2 m square of boards per texture tile, staggered joints)
    const plank = tex(1024, 1024, (g, w, h) => {
      const r = rng(17), rows = 10, ph = h / rows;
      for (let row = 0; row < rows; row++) {
        let x = -r() * w * 0.5;
        while (x < w) {
          const len = w * (0.32 + r() * 0.3), v = (r() - 0.5) * 22;
          g.fillStyle = `rgb(${196 + v},${154 + v * 0.85},${108 + v * 0.6})`; g.fillRect(x, row * ph, len, ph);
          for (let k = 0; k < 14; k++) { g.fillStyle = `rgba(120,78,40,${0.04 + r() * 0.07})`; g.fillRect(x + r() * len, row * ph + 2 + r() * (ph - 4), 30 + r() * 120, 1 + r() * 1.5); }
          g.fillStyle = 'rgba(70,42,20,0.5)'; g.fillRect(x, row * ph, 2, ph);
          x += len;
        }
        g.fillStyle = 'rgba(70,42,20,0.45)'; g.fillRect(0, row * ph, w, 2);
      }
    }, [W / 2, (PART.z - z0) / 2]);
    const wardFloor = this.add(new THREE.PlaneGeometry(W, PART.z - z0), new THREE.MeshStandardMaterial({ map: plank, roughness: 0.48 }), 0, 0, (z0 + PART.z) / 2, 0, false);
    wardFloor.rotation.x = -Math.PI / 2;
    // the lobby: warm limestone flags (0.6 m), a fine sheen
    const flags = tex(512, 512, (g, w, h) => {
      const r = rng(29); g.fillStyle = '#8c8174'; g.fillRect(0, 0, w, h);
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        const v = 198 + r() * 18; g.fillStyle = `rgb(${v},${v - 10},${v - 24})`; g.fillRect(x * w / 2 + 2, y * h / 2 + 2, w / 2 - 4, h / 2 - 4);
        for (let i = 0; i < 700; i++) { const q = 150 + r() * 80; g.fillStyle = `rgba(${q},${q - 8},${q - 20},0.22)`; g.fillRect(x * w / 2 + r() * w / 2, y * h / 2 + r() * h / 2, 2, 2); }
      }
    }, [W / 1.2, (z1 - PART.z) / 1.2]);
    const lobbyFloor = this.add(new THREE.PlaneGeometry(W, z1 - PART.z), new THREE.MeshStandardMaterial({ map: flags, roughness: 0.38 }), 0, 0, (PART.z + z1) / 2, 0, false);
    lobbyFloor.rotation.x = -Math.PI / 2;
    // the walls: larch panelling to 1.0 m under a dark rail, warm lime plaster above (a 1 m wide tile: no stretching)
    const wallMat = (len, seed) => {
      const t = tex(512, 1536, (g, w, h) => {
        const r = rng(seed), split = h * (1 - 1.0 / H);
        g.fillStyle = '#f1ebdf'; g.fillRect(0, 0, w, split);
        for (let i = 0; i < 5000; i++) { const v = 222 + r() * 26; g.fillStyle = `rgba(${v},${v - 6},${v - 18},0.28)`; g.fillRect(r() * w, r() * split, 3, 3); }
        for (let x = 0; x < w; x += 64) {
          const v = (r() - 0.5) * 22; g.fillStyle = `rgb(${190 + v},${140 + v * 0.8},${90 + v * 0.6})`; g.fillRect(x, split, 64, h - split);
          g.fillStyle = 'rgba(60,30,10,0.5)'; g.fillRect(x, split, 3, h - split);
          for (let k = 0; k < 7; k++) { g.fillStyle = `rgba(80,40,14,${0.05 + r() * 0.08})`; g.fillRect(x + 6 + r() * 52, split, 1 + r() * 2, h - split); }
        }
        g.fillStyle = '#6b4526'; g.fillRect(0, split - 14, w, 18); g.fillStyle = 'rgba(255,240,220,0.25)'; g.fillRect(0, split - 14, w, 3);
        g.fillStyle = '#4a2f18'; g.fillRect(0, h - 22, w, 22);
      });
      t.wrapS = THREE.RepeatWrapping; t.repeat.set(len, 1);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.82 });
    };
    this.wallMat = wallMat;
    const wall = (len, x, z, ry, seed, y0 = 0, h = H) => this.add(new THREE.PlaneGeometry(len, h), wallMat(len, seed), x, y0 + h / 2, z, ry, false);
    wall(W, 0, z0, 0, 3);                     // the back (the ward's bed heads)
    wall(W, 0, z1, Math.PI, 4);               // the front (the glass doors)
    wall(z1 - z0, x0, 0, Math.PI / 2, 5);     // the left side
    wall(z1 - z0, x1, 0, -Math.PI / 2, 6);    // the right side
    // the partition: both faces panelled, the wide opening between, a plaster lintel over it, a larch frame round it
    const pz = PART.z, pt = PART.t;
    for (const [a, b] of [[x0, PART.ox0], [PART.ox1, x1]]) {
      const len = b - a, mx = (a + b) / 2;
      wall(len, mx, pz - pt / 2, Math.PI, 7 + Math.round(mx));   // (the ward's face, toward -z)
      wall(len, mx, pz + pt / 2, 0, 9 + Math.round(mx));         // (the lobby's face)
      this.box(len, H, pt - 0.01, M.white, mx, H / 2, pz, 0, false).visible = false; // (solid for the walker only)
      this.obstacles.push([a, b, pz - pt / 2, pz + pt / 2]);
    }
    const plaster = new THREE.MeshStandardMaterial({ color: 0xf1ebdf, roughness: 0.9 });
    this.box(PART.ox1 - PART.ox0, H - PART.oh, pt, plaster, 0, (H + PART.oh) / 2, pz, 0, false);
    for (const x of [PART.ox0, PART.ox1]) this.box(0.1, PART.oh + 0.1, pt + 0.06, M.larch, x, (PART.oh + 0.1) / 2, pz, 0);
    this.box(PART.ox1 - PART.ox0 + 0.2, 0.1, pt + 0.06, M.larch, 0, PART.oh + 0.05, pz, 0);
    // a threshold strip where the stone meets the oak
    this.box(PART.ox1 - PART.ox0, 0.012, pt + 0.04, M.glulam, 0, 0.006, pz, 0, false);
    // the ceilings: larch boards (the map repeats every 4 m: UVs in metres) on glulam beams across
    for (const [za, zb] of [[z0, pz], [pz, z1]]) {
      const geo = new THREE.PlaneGeometry(W, zb - za);
      geo.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 ? (zb - za) : W); });
      const c = this.add(geo, M.larch, 0, H, (za + zb) / 2, 0, false); c.rotation.x = Math.PI / 2;
    }
    for (const x of BEAMS_X) this.box(0.18, 0.24, z1 - z0, M.glulam, x, H - 0.12, 0, 0, false); // (symmetric: the lights hang in the bays between them)
    // skirting along the walls
    const skirt = new THREE.MeshStandardMaterial({ color: 0x4a2f18, roughness: 0.6 });
    for (const [len, x, z, ry] of [[W, 0, z0 + 0.012, 0], [W, 0, z1 - 0.012, 0], [z1 - z0, x0 + 0.012, 0, Math.PI / 2], [z1 - z0, x1 - 0.012, 0, Math.PI / 2]]) this.box(len, 0.1, 0.02, skirt, x, 0.05, z, ry, false);
    // the ward's bumper rail (larch on brass brackets, 0.9 m) along its walls
    const brass = new THREE.MeshStandardMaterial({ color: 0xc09a4e, metalness: 0.9, roughness: 0.3 });
    for (const [len, x, z, ry] of [[(PART.z - z0), x0 + 0.06, (z0 + PART.z) / 2, Math.PI / 2], [(PART.z - z0), x1 - 0.06, (z0 + PART.z) / 2, Math.PI / 2]]) {
      this.box(len - 0.4, 0.07, 0.05, M.larch, x, 0.92, z, ry, false);
      for (let k = -len / 2 + 0.6; k < len / 2 - 0.4; k += 1.4) this.box(0.03, 0.05, 0.08, brass, x + (ry ? 0 : k), 0.92, z + (ry ? k : 0), ry, false);
    }
    this.bounds = [x0 + R, x1 - R, z0 + R, z1 - R];
  }

  // ------------------------------------------------------------ the windows (live view out) and the glass doors
  buildWindows() {
    const M = this.mats(), { x0, x1, z0, z1 } = IN;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x7a4f2c, roughness: 0.6 });
    const win = (px, pz, ry, w, h, y = WIN_Y, radiator = false) => {
      const g = new THREE.Group(); g.position.set(px, 0, pz); g.rotation.y = ry; this.scene.add(g);
      this.portal.add(this.add(new THREE.PlaneGeometry(w, h), null, 0, y, 0.008, 0, false, g));
      const f = 0.08, d = 0.1;
      this.box(w + 2 * f, f, d, frameMat, 0, y + h / 2 + f / 2, d / 2, 0, false, g);
      this.box(w + 2 * f, f, d, frameMat, 0, y - h / 2 - f / 2, d / 2, 0, false, g);
      this.box(f, h, d, frameMat, -w / 2 - f / 2, y, d / 2, 0, false, g);
      this.box(f, h, d, frameMat, w / 2 + f / 2, y, d / 2, 0, false, g);
      this.box(0.045, h, 0.05, frameMat, 0, y, 0.03, 0, false, g);               // (the mullion)
      this.box(w, 0.045, 0.05, frameMat, 0, y + h * 0.12, 0.03, 0, false, g);    // (the transom)
      this.box(w + 0.34, 0.05, 0.24, M.sill, 0, y - h / 2 - f - 0.02, 0.12, 0, false, g); // (the sill)
      // short linen curtains either side, tied back
      const cur = new THREE.MeshStandardMaterial({ color: 0xe9dfcc, roughness: 0.95, side: THREE.DoubleSide });
      for (const s of [-1, 1]) {
        const cg = new THREE.PlaneGeometry(0.34, h + 0.5, 6, 1), p = cg.attributes.position;
        for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) / 0.34 + 0.5) * Math.PI * 3) * 0.035);
        cg.computeVertexNormals();
        this.add(cg, cur, s * (w / 2 + f + 0.14), y + 0.12, 0.16, 0, false, g);
      }
      this.box(w + 0.9, 0.025, 0.025, M.chrome, 0, y + h / 2 + 0.32, 0.16, 0, false, g); // (the curtain rod)
      if (radiator) { // a white panel radiator under the sill
        const rw = Math.min(1.1, w), rad = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.45, metalness: 0.1 });
        this.box(rw, 0.55, 0.06, rad, 0, 0.5, 0.07, 0, false, g);
        for (let x = -rw / 2 + 0.04; x < rw / 2; x += 0.05) this.box(0.012, 0.55, 0.035, rad, x, 0.5, 0.11, 0, false, g);
        this.box(0.05, 0.08, 0.05, M.chrome, rw / 2 - 0.03, 0.83, 0.1, 0, false, g); // (the valve)
      }
      return g;
    };
    for (const [x, w, h] of WIN.back) win(x, z0, 0, w, h, WIN_Y, x === 0);
    for (const [x, w, h] of WIN.front) win(x, z1, Math.PI, w, h);
    for (const [u, w, h] of WIN.side) { win(x0, u, Math.PI / 2, w, h, WIN_Y, u < PART.z); win(x1, u, -Math.PI / 2, w, h, WIN_Y, u < PART.z); }
    // the front: sliding glass doors (2.6 m, the live view through them), steel frames, a lit transom, AUSGANG over them
    {
      const g = new THREE.Group(); g.position.set(0, 0, z1); g.rotation.y = Math.PI; this.scene.add(g);
      this.portal.add(this.add(new THREE.PlaneGeometry(2.6, 2.5), null, 0, 1.25, 0.008, 0, false, g));
      const st = new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.8, roughness: 0.3 });
      for (const x of [-1.32, 0, 1.32]) this.box(0.07, 2.5, 0.08, st, x, 1.25, 0.04, 0, false, g);
      this.box(2.72, 0.12, 0.1, st, 0, 2.56, 0.05, 0, false, g);
      for (const s of [-1, 1]) this.box(0.03, 0.5, 0.04, M.chrome, s * 0.12, 1.1, 0.1, 0, false, g); // (the pull bars)
      this.box(3.0, 0.08, 0.14, frameMat, 0, 2.66, 0.07, 0, false, g);
      const exitT = tex(320, 104, (c, w, h) => { c.fillStyle = '#0f8a3c'; c.fillRect(0, 0, w, h); c.fillStyle = '#fff'; c.font = 'bold 56px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('AUSGANG', w / 2, h / 2 + 3); });
      const exitSign = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.06), new THREE.MeshBasicMaterial({ map: exitT }));
      exitSign.position.set(0, 2.88, 0.06); g.add(exitSign);
      // the doormat
      const mat = this.add(new THREE.PlaneGeometry(2.2, 1.2), new THREE.MeshStandardMaterial({ roughness: 1, map: tex(352, 192, (c, w, h) => { c.fillStyle = '#3a342d'; c.fillRect(0, 0, w, h); c.strokeStyle = '#6a5b48'; c.lineWidth = 8; c.strokeRect(10, 10, w - 20, h - 20); for (let y = 24; y < h - 20; y += 8) { c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(18, y, w - 36, 3); } }) }), 0, 0.006, z1 - 0.75, 0, false);
      mat.rotation.x = -Math.PI / 2;
    }
  }

  // ------------------------------------------------------------ light: warm and soft, a key from above for shadows
  buildLights() {
    const S = this.scene, { H } = IN, M = this.mats();
    S.add(new THREE.HemisphereLight(0xfff3e2, 0x6a5440, 0.62));
    const key = new THREE.DirectionalLight(0xfff0dc, 1.05);
    key.position.set(-2.5, H + 6, 3.5); key.target.position.set(0, 0, -1); S.add(key.target);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -9, right: 9, top: 8, bottom: -8, near: 0.5, far: 22 });
    key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
    S.add(key);
    // the ward: three round flush ceiling lights (opal glass on a larch ring), a warm point light under each
    const ring = new THREE.MeshStandardMaterial({ color: 0x9c6b3e, roughness: 0.5 });
    for (const x of [-4.8, 0, 4.8]) { // (bay centres between the beams, BEAMS_X: never cut by one; Oct 30, the user)
      const z = -2.6;
      this.add(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 32), ring, x, H - 0.025, z, 0, false);
      const d = this.add(new THREE.CircleGeometry(0.34, 32), M.glow, x, H - 0.052, z, 0, false); d.rotation.x = Math.PI / 2;
      const L = new THREE.PointLight(0xffd6a6, 5.2, 9.5, 1.5); L.position.set(x, H - 0.4, z); S.add(L);
    }
    // the lobby: the Meshy alpine pendants (tools/meshy-decor.mjs, as in the police station), a glowing bulb in each
    const shade = new THREE.MeshStandardMaterial({ color: 0x23302a, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd39a, emissiveIntensity: 2.6 });
    for (const [x, z] of [[-2.4, 3.8], [2.4, 3.8]]) { // (in the bays between the beams)
      const pg = new THREE.Group(); pg.position.set(x, 0, z); S.add(pg);
      const fb = new THREE.Group(); pg.add(fb);
      const cord = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.7, 0.012), M.steel); cord.position.y = H - 0.35; fb.add(cord);
      const sh = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.26, 20, 1, true), shade); sh.position.y = H - 0.82; fb.add(sh);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), bulbMat); bulb.position.y = H - 0.9; pg.add(bulb);
      swapInModel(pg, 'decor/lamp_pendant', { size: 0.56, axis: 'xz' }, fb, (m) => {
        const h = m.userData.size.y, y0 = H - 0.3 - h; m.position.y = y0; m.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        const cord2 = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.32, 0.012), M.steel); cord2.position.y = H - 0.16; pg.add(cord2);
        bulb.position.y = y0 + Math.min(0.12, h * 0.2); bulb.scale.setScalar(0.85);
      });
      const L = new THREE.PointLight(0xffc98f, 6.0, 9.5, 1.5); L.position.set(x, H - 1.0, z); S.add(L);
    }
  }

  // ------------------------------------------------------------ the lobby: reception, waiting, the visiting board
  buildLobby() {
    const M = this.mats(), { x0, x1, z1, H } = IN, pz = PART.z + PART.t / 2;
    // ---- the reception counter (the Meshy clinic counter) along the left, its customer side toward the room (+x)
    const DX = -5.15, DZ = 3.75;
    this.furn('desk', DX, DZ, Math.PI / 2, (fb) => {
      this.box(2.6, 1.08, 0.5, M.birch, 0, 0.54, 0.25, 0, true, fb);
      this.box(2.7, 0.05, 0.62, M.white, 0, 1.1, 0.25, 0, true, fb);
      this.box(2.6, 0.04, 0.6, M.white, 0, 0.76, -0.35, 0, true, fb);
      this.box(0.5, 0.34, 0.04, M.dark, 0.4, 1.0, -0.4, Math.PI, true, fb);
    });
    this.obstacles.push([x0, DX + 1.05, DZ - 1.05, DZ + 1.05]);
    const recep = makeSign('ANMELDUNG\nReception', { w: 1.5, h: 0.5, bg: '#ffffff', fg: '#7a0a1c', border: '#b3172b', font: 'bold 120px Georgia' });
    recep.position.set(DX + 0.2, 2.62, DZ); recep.rotation.y = Math.PI / 2; this.scene.add(recep);
    for (const s of [-1, 1]) this.box(0.012, H - 2.87, 0.012, M.steel, DX + 0.2, (H + 2.87) / 2, DZ + s * 0.6, 0, false);
    // the ARZT board on the wall behind the counter (hospital.js's own sign), a red cross light under it
    // (no MEDICAL CENTRE board on the side wall: it sat over the window behind the curtains; Oct 30, the user: "delete it")
    // a brass bell and a stack of leaflets on the counter (the Meshy counter carries its own monitor and folders)
    // ---- the waiting side: two benches (the right wall under its window, the front under the right window)
    const benchFb = (fb) => {
      for (let i = 0; i < 3; i++) { const x = -0.6 + i * 0.6; this.box(0.52, 0.06, 0.46, M.birch, x, 0.46, 0, 0, true, fb); this.box(0.52, 0.42, 0.04, M.birch, x, 0.76, -0.22, 0, true, fb); this.box(0.46, 0.05, 0.4, M.teal, x, 0.51, 0.02, 0, true, fb); }
      this.box(1.8, 0.06, 0.08, M.chrome, 0, 0.4, -0.05, 0, true, fb);
      for (const x of [-0.75, 0.75]) this.box(0.05, 0.4, 0.4, M.chrome, x, 0.2, -0.02, 0, true, fb);
    };
    this.furn('bench', x1 - 0.32, 3.6, -Math.PI / 2, benchFb);
    this.obstacles.push([x1 - 0.6, x1, 2.65, 4.55]);
    this.furn('bench', 4.9, z1 - 0.32, Math.PI, benchFb);
    this.obstacles.push([3.95, 5.85, z1 - 0.6, z1]);
    // a low table with magazines in the corner between them
    { const tx = x1 - 0.75, tz = z1 - 0.75;
      this.add(new THREE.CylinderGeometry(0.34, 0.34, 0.04, 28), M.oak, tx, 0.46, tz);
      this.add(new THREE.CylinderGeometry(0.04, 0.05, 0.44, 10), M.chrome, tx, 0.22, tz);
      this.add(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 20), M.chrome, tx, 0.01, tz);
      const cols = [0xc8342c, 0x1d4f7a, 0xe8c21a];
      cols.forEach((c, i) => this.box(0.21, 0.008, 0.28, new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }), tx - 0.06 + i * 0.06, 0.485 + i * 0.008, tz - 0.02 + i * 0.03, 0.3 * i - 0.2, false));
      this.obstacles.push([tx - 0.38, tx + 0.38, tz - 0.38, tz + 0.38]);
    }
    // ---- plants (the Meshy ficus / monstera of the police station, a pot of leaves till then)
    this.plant(-2.05, z1 - 0.45, 1, 'ficus'); this.plant(2.05, z1 - 0.45, 0.95, 'monstera'); this.plant(x1 - 0.45, pz + 0.45, 1, 'ficus');
    this.plant(x0 + 0.5, z1 - 0.5, 0.9, 'monstera');
    // ---- the visiting-hours board on the partition by the opening, the ward's sign over it, a clock
    this.board(-2.25, 1.6, pz + 0.005);
    const wardSign = tex(1024, 256, (g, w, h) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.strokeStyle = RED; g.lineWidth = 12; g.strokeRect(10, 10, w - 20, h - 20);
      g.fillStyle = RED; g.beginPath(); g.arc(128, h / 2, 82, 0, 7); g.fill(); drawCross(g, 128, h / 2, 54, 18, '#ffffff');
      g.fillStyle = '#7a0a1c'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = 'bold 96px Georgia'; g.fillText('STATION · Ward', 248, h * 0.4);
      g.fillStyle = '#5a4a3c'; g.font = 'italic 46px Georgia'; g.fillText('Patienten & Besuch · Patients & visitors', 252, h * 0.76);
    });
    this.add(new THREE.PlaneGeometry(1.84, 0.46), new THREE.MeshStandardMaterial({ map: wardSign, roughness: 0.5 }), 0, 2.78, pz + 0.01, 0, false);
    this.clockAt(2.3, 2.45, pz + 0.01, 0);
    // ---- a water cooler by the benches, a hand sanitiser by the door
    { const cx = x1 - 0.35, cz = 1.95 + 0.45;
      this.box(0.36, 1.0, 0.36, M.white, cx, 0.5, cz, 0, true);
      const bottle = this.add(new THREE.CylinderGeometry(0.15, 0.15, 0.4, 20), new THREE.MeshPhysicalMaterial({ color: 0x9fd0f0, roughness: 0.05, transparent: true, opacity: 0.55 }), cx, 1.22, cz); void bottle;
      this.box(0.08, 0.05, 0.05, M.chrome, cx - 0.2, 0.86, cz, 0, false);
      this.obstacles.push([cx - 0.22, x1, cz - 0.22, cz + 0.22]);
      this.box(0.12, 0.26, 0.1, M.white, 1.65, 1.25, z1 - 0.06, 0, false);
      this.box(0.08, 0.1, 0.03, new THREE.MeshStandardMaterial({ color: 0x2a8fd0, roughness: 0.4 }), 1.65, 1.3, z1 - 0.115, 0, false);
    }
  }

  // ------------------------------------------------------------ the ward: the four beds and their kit
  buildWard() {
    const M = this.mats(), { z0, x0, x1 } = IN, pz = PART.z - PART.t / 2;
    const bedFb = (fb) => {
      // a white steel frame on castors, birch head and foot boards, the mattress, the raised head section, a pillow
      this.box(0.92, 0.12, 2.0, M.white, 0, 0.38, 0, 0, true, fb);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        this.box(0.05, 0.3, 0.05, M.white, sx * 0.4, 0.2, sz * 0.9, 0, true, fb);
        this.add(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12), M.dark, sx * 0.4, 0.05, sz * 0.9, 0, true, fb).rotation.z = Math.PI / 2;
      }
      this.box(0.9, 0.16, 1.32, M.sheet, 0, 0.53, 0.33, 0, true, fb);
      const back = this.box(0.9, 0.16, 0.72, M.sheet, 0, 0.62, -0.62, 0, true, fb); back.rotation.x = -0.32;
      const pil = this.add(new THREE.CapsuleGeometry(0.13, 0.42, 6, 12), M.sheet, 0, 0.78, -0.8, 0, true, fb); pil.rotation.z = Math.PI / 2; pil.scale.set(1, 1, 0.6); pil.rotation.x = -0.32;
      this.box(0.94, 0.08, 0.62, M.blanket, 0, 0.64, 0.62, 0, true, fb);
      this.box(1.0, 0.95, 0.06, M.birch, 0, 0.62, -1.02, 0, true, fb);
      this.box(1.0, 0.7, 0.06, M.birch, 0, 0.5, 1.02, 0, true, fb);
      for (const sx of [-1, 1]) this.box(0.03, 0.18, 0.8, M.white, sx * 0.47, 0.72, -0.3, 0, true, fb);
    };
    const cabFb = (fb) => {
      this.box(0.48, 0.74, 0.46, M.birch, 0, 0.42, 0, 0, true, fb);
      this.box(0.5, 0.03, 0.48, M.white, 0, 0.8, 0, 0, true, fb);
      this.box(0.42, 0.005, 0.005, M.chrome, 0, 0.66, 0.235, 0, false, fb);
      this.box(0.15, 0.02, 0.02, M.chrome, 0, 0.5, 0.24, 0, false, fb);
      this.add(new THREE.CylinderGeometry(0.035, 0.03, 0.11, 14), new THREE.MeshPhysicalMaterial({ color: 0xdff0f8, roughness: 0.05, transparent: true, opacity: 0.4 }), 0.1, 0.87, 0.05, 0, false, fb);
    };
    const ivFb = (fb) => {
      this.add(new THREE.CylinderGeometry(0.014, 0.014, 1.9, 8), M.chrome, 0, 0.95, 0, 0, true, fb);
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2, l = this.box(0.3, 0.02, 0.03, M.chrome, Math.sin(a) * 0.14, 0.06, Math.cos(a) * 0.14, a + Math.PI / 2, true, fb); void l; }
      this.box(0.3, 0.012, 0.012, M.chrome, 0, 1.88, 0, 0, false, fb);
      this.box(0.12, 0.2, 0.04, new THREE.MeshPhysicalMaterial({ color: 0xeaf6ff, roughness: 0.1, transparent: true, opacity: 0.6 }), 0.12, 1.7, 0, 0, false, fb);
    };
    const monFb = (fb) => {
      this.add(new THREE.CylinderGeometry(0.02, 0.02, 1.2, 8), M.chrome, 0, 0.62, 0, 0, true, fb);
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; this.box(0.28, 0.02, 0.03, M.chrome, Math.sin(a) * 0.13, 0.06, Math.cos(a) * 0.13, a + Math.PI / 2, true, fb); }
      this.box(0.36, 0.28, 0.1, new THREE.MeshStandardMaterial({ color: 0xd8dadc, roughness: 0.4 }), 0, 1.32, 0, 0, true, fb);
      this.add(new THREE.PlaneGeometry(0.3, 0.2), this.ecgMat(), 0, 1.33, 0.052, 0, false, fb);
    };
    const chairFb = (fb) => {
      this.box(0.52, 0.08, 0.5, M.teal, 0, 0.45, 0, 0, true, fb);
      const bk = this.box(0.52, 0.5, 0.07, M.teal, 0, 0.74, -0.24, 0, true, fb); bk.rotation.x = -0.1;
      for (const sx of [-1, 1]) { this.box(0.05, 0.05, 0.5, M.birch, sx * 0.28, 0.64, -0.02, 0, true, fb); this.box(0.04, 0.2, 0.04, M.birch, sx * 0.28, 0.54, 0.2, 0, true, fb); }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.box(0.04, 0.42, 0.04, M.birch, sx * 0.23, 0.21, sz * 0.21, 0, true, fb);
    };
    this.bedTops = wardTops = BEDS.map(() => BED.top); // (wardTops: the other players' patients lie on these too)
    BEDS.forEach((bx, i) => {
      const cs = CAB_SIDE[i];
      this.furn('bed', bx, BED_Z, 0, bedFb, (m) => {
        // the mattress top: the height most of the model's top surface sits at between the boards
        const top = m.userData.size?.y ? Math.min(0.75, Math.max(0.38, m.userData.size.y * 0.53)) : BED.top; // (Meshy's bed: the mattress at ~53 % of its height)
        this.bedTops[i] = top;
        // (Oct 30, the user: "please make the bed longer": the feet stuck out past its end) stretched 30 % along its
        // length, the head end staying at the wall
        m.scale.z *= BED_STRETCH; m.position.z += (BED.len * (BED_STRETCH - 1)) / 2;
      });
      this.obstacles.push([bx - 0.55, bx + 0.55, z0, z0 + BED.len * BED_STRETCH + 0.08]);
      // the bed-head unit on the wall: a larch rail with the reading light under a hood, the gas outlets, the call button
      this.bedHead(bx, z0, i);
      // the cabinet at the head on the chair's side, the monitor and the drip on the other
      this.furn('cabinet', bx + cs * 0.95, z0 + 0.32, 0, cabFb);
      this.obstacles.push([bx + cs * 0.95 - 0.28, bx + cs * 0.95 + 0.28, z0, z0 + 0.6]);
      this.furn('monitor', bx - cs * 0.78, z0 + 0.38, cs * 0.5, monFb);
      this.furn('iv', bx - cs * 0.82, z0 + 1.05, 0, ivFb);
      this.obstacles.push([bx - cs * 0.8 - 0.22, bx - cs * 0.8 + 0.22, z0, z0 + 1.3]);
      // the visitor's chair beside the bed, turned to it (a little toward the head)
      const chx = bx + cs * 1.08, chz = z0 + 1.6, yaw = Math.atan2(-cs, -0.35);
      this.furn('chair', chx, chz, yaw, chairFb);
      this.chairs.push({ x: chx, z: chz, yaw, bed: i, y: 0.47 });
      this.obstacles.push([chx - 0.3, chx + 0.3, chz - 0.3, chz + 0.3]);
      // the bed's number over the head unit
      const nT = tex(128, 128, (g, w, h) => { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(w / 2, h / 2, 60, 0, 7); g.fill(); g.strokeStyle = RED; g.lineWidth = 8; g.stroke(); g.fillStyle = '#7a0a1c'; g.font = 'bold 70px Georgia'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), w / 2, h / 2 + 4); });
      this.add(new THREE.CircleGeometry(0.12, 24), new THREE.MeshStandardMaterial({ map: nT, roughness: 0.5 }), bx, 2.0, z0 + 0.012, 0, false);
    });
    // the curtains on their ceiling tracks between the beds (pulled back to the wall, soft folds)
    for (const x of [-4.0, 4.0]) this.curtain(x, z0);
    // ---- along the partition (the ward's side): the medicine cabinet, the supply cart, a folded privacy screen, plants
    this.furn('medcab', -5.6, pz - 0.24, 0, (fb) => {
      this.box(0.9, 1.9, 0.4, M.white, 0, 0.95, 0, 0, true, fb);
      this.box(0.82, 1.1, 0.01, new THREE.MeshPhysicalMaterial({ color: 0xdff0f8, roughness: 0.05, transparent: true, opacity: 0.35 }), 0, 1.25, 0.205, 0, false, fb);
      const ct = tex(64, 64, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); drawCross(g, 32, 32, 24, 8); });
      this.add(new THREE.PlaneGeometry(0.16, 0.16), new THREE.MeshStandardMaterial({ map: ct }), 0, 1.78, 0.205, 0, false, fb);
    });
    this.obstacles.push([-6.1, -5.1, pz - 0.48, pz]);
    this.furn('cart', -3.9, pz - 0.35, 0.15, (fb) => {
      this.box(0.6, 0.85, 0.45, M.white, 0, 0.5, 0, 0, true, fb);
      for (let k = 0; k < 3; k++) this.box(0.5, 0.02, 0.02, new THREE.MeshStandardMaterial({ color: 0x2a6fd0 }), 0, 0.3 + k * 0.22, 0.23, 0, false, fb);
      this.box(0.04, 0.3, 0.42, M.chrome, 0.32, 0.95, 0, 0, false, fb);
    });
    this.obstacles.push([-4.3, -3.5, pz - 0.65, pz]);
    this.furn('screen', 4.6, pz - 0.4, 0.2, (fb) => {
      for (let k = -1; k <= 1; k++) {
        const pg = new THREE.Group(); pg.position.set(k * 0.68, 0, k === 0 ? 0 : -0.12); pg.rotation.y = k * 0.35; fb.add(pg);
        this.box(0.66, 1.75, 0.03, M.white, 0, 0.92, 0, 0, true, pg);
        this.box(0.6, 1.5, 0.035, M.mint, 0, 0.98, 0, 0, true, pg);
      }
    });
    this.obstacles.push([3.5, 5.7, pz - 0.65, pz]);
    this.plant(x1 - 0.45, pz - 0.45, 1, 'monstera'); this.plant(x0 + 0.5, pz - 0.5, 0.9, 'ficus');
    this.plant(0, z0 + 0.45, 0.8, 'monstera');
    this.clockAt(-2.3, 2.45, pz - 0.01, Math.PI);
    // the ward's flowers: a vase on two of the cabinets' tops comes with the Meshy cabinet; a picture over the middle
    swapInModel(this.scene, 'furniture/picture_mountain', { size: 0.95, axis: 'xz' }, null, (m) => { m.position.set(2.3, 1.75, pz - 0.03); m.rotation.y = Math.PI; });
  }

  /** The bed-head unit on the wall over bed i at x (z0: the wall): a larch rail, the reading light, outlets, a button. */
  bedHead(x, z0, i) {
    const M = this.mats();
    const g = new THREE.Group(); g.position.set(x, 0, z0); this.scene.add(g);
    this.box(1.05, 0.34, 0.08, M.larch, 0, 1.38, 0.04, 0, false, g);
    this.box(1.05, 0.04, 0.12, M.white, 0, 1.57, 0.06, 0, false, g);
    // the reading light: a warm strip under a little hood on top
    this.box(0.8, 0.05, 0.12, M.white, 0, 1.64, 0.08, 0, false, g);
    const strip = this.box(0.72, 0.012, 0.05, M.glow, 0, 1.612, 0.1, 0, false, g); void strip;
    // the outlets (oxygen green, air white), the nurse call (red), a small socket strip
    this.add(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 14), new THREE.MeshStandardMaterial({ color: 0x2f9e5a, roughness: 0.4 }), -0.32, 1.38, 0.1, 0, false, g).rotation.x = Math.PI / 2;
    this.add(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 14), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }), -0.22, 1.38, 0.1, 0, false, g).rotation.x = Math.PI / 2;
    this.add(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 14), new THREE.MeshStandardMaterial({ color: 0xd8283a, emissive: 0x6a0c14, emissiveIntensity: 0.6 }), 0.3, 1.38, 0.095, 0, false, g).rotation.x = Math.PI / 2;
    this.box(0.16, 0.06, 0.02, M.white, 0.12, 1.3, 0.09, 0, false, g);
    // a soft warm pool of light over the pillow (no light source: an emissive glow on the wall under the hood)
    const glowT = this.glowTex || (this.glowTex = tex(128, 128, (c, w, h) => { const gr = c.createRadialGradient(w / 2, 0, 4, w / 2, 0, h); gr.addColorStop(0, 'rgba(255,214,160,0.55)'); gr.addColorStop(1, 'rgba(255,214,160,0)'); c.fillStyle = gr; c.fillRect(0, 0, w, h); }));
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), new THREE.MeshBasicMaterial({ map: glowT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    gl.position.set(0, 1.15, 0.006); g.add(gl);
    void i;
  }

  /** A curtain pulled back to the wall on a ceiling track along z (at x). */
  curtain(x, z0) {
    const M = this.mats(), { H } = IN;
    this.box(0.035, 0.035, 2.6, M.chrome, x, H - 0.25, z0 + 1.3, 0, false);
    for (let z = z0 + 0.6; z < z0 + 2.6; z += 1.0) this.box(0.012, 0.23, 0.012, M.chrome, x, H - 0.12, z, 0, false);
    const ct = tex(256, 512, (g, w, h) => {
      g.fillStyle = '#d9e7dc'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(120,160,135,0.35)'; g.lineWidth = 3; for (let x2 = 0; x2 < w; x2 += 32) { g.beginPath(); g.moveTo(x2, 0); g.lineTo(x2, h); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, 0, w, 26); // (the mesh band at the top)
    });
    const mat = new THREE.MeshStandardMaterial({ map: ct, roughness: 0.95, side: THREE.DoubleSide });
    const len = 0.62, hh = H - 0.45;
    const geo = new THREE.PlaneGeometry(len, hh, 24, 1), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const u = p.getX(i) / len + 0.5; p.setZ(i, Math.sin(u * Math.PI * 9) * 0.05 * (0.6 + 0.4 * u)); }
    geo.computeVertexNormals();
    const c = this.add(geo, mat, x, 0.3 + hh / 2, z0 + 0.06 + len / 2, Math.PI / 2, true);
    void c;
    this.obstacles.push([x - 0.1, x + 0.1, z0, z0 + 0.06 + len]);
  }

  /** A potted plant: the Meshy ficus / monstera (tools/meshy-decor.mjs), a pot of leaves until it loads. */
  plant(x, z, s = 1, kind = 'ficus') {
    const M = this.mats();
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = (x * 7 + z * 3) % 6.28; this.scene.add(g);
    const fb = new THREE.Group(); g.add(fb);
    this.add(new THREE.CylinderGeometry(0.26 * s, 0.2 * s, 0.5 * s, 16), M.pot, 0, 0.25 * s, 0, 0, true, fb);
    const r = rng(Math.round(x * 13 + z * 7 + 100));
    for (let i = 0; i < 9; i++) { const l = this.add(new THREE.SphereGeometry(0.22 * s, 10, 8), M.leaf, 0, 0, 0, 0, true, fb); const a = r() * 7, d = r() * 0.2 * s; l.position.set(Math.cos(a) * d, (0.65 + r() * 0.75) * s, Math.sin(a) * d); l.scale.set(1, 1.4, 1); }
    swapInModel(g, `decor/plant_${kind}`, { size: (kind === 'ficus' ? 1.55 : 1.2) * s, axis: 'y' }, fb, (m) => m.traverse((o) => { if (o.isMesh && o.material) o.material.side = THREE.DoubleSide; }));
    this.obstacles.push([x - 0.3 * s, x + 0.3 * s, z - 0.3 * s, z + 0.3 * s]);
  }

  /** A wall clock (real time) at (x, y, z) facing ry. */
  clockAt(x, y, z, ry) {
    const face = tex(256, 256, (g, w, h) => {
      g.fillStyle = '#f7f4ec'; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 4, 0, 7); g.fill();
      g.strokeStyle = '#3a2412'; g.lineWidth = 10; g.stroke();
      for (let i = 0; i < 60; i++) { const a = (i / 60) * Math.PI * 2, L = i % 5 ? 8 : 22; g.lineWidth = i % 5 ? 3 : 8; g.strokeStyle = '#1c1c1c'; g.beginPath(); g.moveTo(w / 2 + Math.sin(a) * (w / 2 - 14), h / 2 - Math.cos(a) * (h / 2 - 14)); g.lineTo(w / 2 + Math.sin(a) * (w / 2 - 14 - L), h / 2 - Math.cos(a) * (h / 2 - 14 - L)); g.stroke(); }
      drawCross(g, w / 2, h * 0.68, 12, 4);
    });
    const cg = new THREE.Group(); cg.position.set(x, y, z); cg.rotation.y = ry; this.scene.add(cg);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 32), new THREE.MeshStandardMaterial({ color: 0x6b4526, roughness: 0.5 })); rim.rotation.x = Math.PI / 2; rim.position.z = 0.025; cg.add(rim);
    const fc = new THREE.Mesh(new THREE.CircleGeometry(0.18, 32), new THREE.MeshStandardMaterial({ map: face, roughness: 0.5 })); fc.position.z = 0.052; cg.add(fc);
    const hand = (len, w, color, zz) => { const p = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.005), new THREE.MeshBasicMaterial({ color })); m.position.y = len / 2 - 0.02; p.add(m); p.position.z = zz; cg.add(p); return p; };
    (this.clocks ||= []).push({ h: hand(0.09, 0.016, 0x111111, 0.056), m: hand(0.14, 0.011, 0x111111, 0.06), s: hand(0.15, 0.004, 0xc8342c, 0.064) });
  }

  /** The monitors' screens: a heart trace on black that scrolls (update()). */
  ecgMat() {
    if (this._ecg) return this._ecg;
    const t = tex(512, 256, (g, w, h) => {
      g.fillStyle = '#050a08'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(60,120,80,0.25)'; g.lineWidth = 1; for (let x = 0; x < w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      const trace = (y0, amp, col, beat) => {
        g.strokeStyle = col; g.lineWidth = 4; g.beginPath();
        for (let x = 0; x <= w; x++) {
          const u = (x % beat) / beat;
          let y = 0;
          if (u > 0.1 && u < 0.16) y = Math.sin((u - 0.1) / 0.06 * Math.PI) * 0.15;
          else if (u > 0.22 && u < 0.25) y = -0.2; else if (u >= 0.25 && u < 0.29) y = 1; else if (u >= 0.29 && u < 0.32) y = -0.35;
          else if (u > 0.45 && u < 0.58) y = Math.sin((u - 0.45) / 0.13 * Math.PI) * 0.25;
          const yy = y0 - y * amp; if (x) g.lineTo(x, yy); else g.moveTo(x, yy);
        }
        g.stroke();
      };
      trace(h * 0.36, 60, '#41f07a', 128);
      trace(h * 0.78, 18, '#f0d841', 170);
    });
    t.wrapS = THREE.RepeatWrapping; t.repeat.set(1, 1);
    this.ecgTex = t;
    return (this._ecg = new THREE.MeshStandardMaterial({ color: 0x000000, map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 1.1 }));
  }

  /** The BESUCHSZEIT board (the police station's style in the medical centre's red) at (x, y) on the partition. */
  board(x, y, z) {
    const PW = 0.88, PH = 1.1;
    const panelT = tex(1024, 1280, (g, w, h) => {
      const red = '#a3101f', ink = '#1d2530', grey = '#5a6470';
      const fitT = (t, tx, ty, max) => { const m = g.measureText(t).width; if (m <= max) { g.fillText(t, tx, ty); return; } g.save(); g.translate(tx, ty); g.scale(max / m, 1); g.fillText(t, 0, 0); g.restore(); };
      const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#f8f6f0'); bg.addColorStop(1, '#ece8de');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.fillStyle = red; g.fillRect(0, 0, w, 250);
      g.fillStyle = '#c9a54a'; g.fillRect(0, 250, w, 8);
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(128, 125, 86, 0, 7); g.fill(); drawCross(g, 128, 125, 58, 20, red);
      g.fillStyle = '#ffffff'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
      g.font = 'bold 44px Arial'; fitT('ARZT · MEDICAL CENTRE', 244, 92, w - 290);
      g.font = 'bold 76px Arial'; fitT('BESUCHSZEIT', 240, 170, w - 280);
      g.fillStyle = '#f3d0d4'; g.font = 'italic 40px Georgia'; g.fillText('Visiting hours', 244, 222);
      const cy = 380;
      g.save(); g.translate(130, cy);
      g.fillStyle = '#ffffff'; g.strokeStyle = red; g.lineWidth = 12; g.beginPath(); g.arc(0, 0, 66, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = red; for (let i = 0; i < 12; i++) { const a = (i * Math.PI) / 6; g.beginPath(); g.arc(Math.sin(a) * 48, -Math.cos(a) * 48, i % 3 ? 3.5 : 6, 0, 7); g.fill(); }
      g.strokeStyle = red; g.lineCap = 'round'; g.lineWidth = 9; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -38); g.stroke();
      g.lineWidth = 7; g.beginPath(); g.moveTo(0, 0); g.lineTo(30, 14); g.stroke();
      g.beginPath(); g.arc(0, 0, 8, 0, 7); g.fill(); g.restore();
      g.fillStyle = ink; g.font = 'bold 54px Arial'; g.fillText('Täglich · Daily', 236, cy - 14);
      g.fillStyle = red; g.font = 'bold 60px Arial'; g.fillText('00:00 – 24:00', 236, cy + 56);
      const rules = [
        ['Bitte am Empfang melden', 'Please report to reception'],
        ['Leise sein · Patienten ruhen', 'Keep quiet · patients resting'],
        ['Hände desinfizieren', 'Sanitise your hands'],
        ['Blumen willkommen', 'Flowers welcome'],
      ];
      let yy = 540;
      g.strokeStyle = 'rgba(163,16,31,0.18)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(60, yy - 40); g.lineTo(w - 60, yy - 40); g.stroke();
      for (const [de, en] of rules) {
        g.fillStyle = red; g.beginPath(); g.arc(82, yy + 18, 13, 0, 7); g.fill();
        g.fillStyle = ink; g.font = 'bold 44px Arial'; fitT(de, 118, yy + 34, w - 180);
        g.fillStyle = grey; g.font = 'italic 40px Georgia'; fitT(en, 118, yy + 88, w - 180);
        yy += 152;
        g.beginPath(); g.moveTo(60, yy - 22); g.lineTo(w - 60, yy - 22); g.stroke();
      }
      g.fillStyle = red; g.fillRect(0, h - 96, w, 96);
      g.fillStyle = '#ffffff'; g.font = 'bold 36px Arial'; g.textAlign = 'center';
      fitT('Notaufnahme 24 h · Notruf 144 · Legacy Village', w / 2, h - 36, w - 100);
      g.strokeStyle = red; g.lineWidth = 6; g.strokeRect(18, 18, w - 36, h - 36);
    });
    panelT.anisotropy = 16;
    const larch = new THREE.MeshStandardMaterial({ color: 0x5a3a20, roughness: 0.55 });
    const bg = new THREE.Group(); bg.position.set(x, y, z); this.scene.add(bg);
    const fw = 0.06, fd = 0.045;
    this.box(PW + 0.04, PH + 0.04, 0.02, this.mats().dark, 0, 0, 0.01, 0, false, bg);
    this.add(new THREE.PlaneGeometry(PW, PH), new THREE.MeshStandardMaterial({ map: panelT, roughness: 0.38 }), 0, 0, 0.022, 0, false, bg);
    this.box(PW + 2 * fw, fw, fd, larch, 0, PH / 2 + fw / 2, fd / 2, 0, false, bg);
    this.box(PW + 2 * fw, fw, fd, larch, 0, -PH / 2 - fw / 2, fd / 2, 0, false, bg);
    this.box(fw, PH, fd, larch, -PW / 2 - fw / 2, 0, fd / 2, 0, false, bg);
    this.box(fw, PH, fd, larch, PW / 2 + fw / 2, 0, fd / 2, 0, false, bg);
  }

  // ------------------------------------------------------------ the live window view
  /** Where the house stands outdoors: { scene, frame (an Object3D whose local frame is this room's), hide }. */
  setWorld(o) {
    this.frame = o && o.scene && o.frame ? o.frame : null;
    this.portal.setWorld(this.frame ? o : null);
  }
  renderPortal() {
    if (!this.frame) return;
    this.camera.updateMatrixWorld();
    this.portal.render(this.renderer, this.camera, this.frame);
  }
  releasePortal() { this.portal.releasePortal(); }

  // ------------------------------------------------------------ you in the room
  /** role 'patient' (lying in bed `bed`) or 'visitor' (in at the front doors). */
  place(role, bed = 1) {
    this.role = role; this.bed = bed; this.seat = null;
    this.bounds = [IN.x0 + R, IN.x1 - R, IN.z0 + R, IN.z1 - R];
    if (role === 'patient') {
      this.pos.set(BEDS[bed] ?? 0, 0, HIPS_Z); this.yaw = 0; this.pitch = -0.3; // (looking down along yourself to your feet)
      this.restView = 'first'; this.tpYaw = Math.PI; this.tpPitch = -0.45; this.eye = null; this.bodyC = null; this.lift = null; this.liftV = 0;
    }
    else { this.pos.set(EXIT.x, 0, EXIT.z - 0.9); this.yaw = Math.PI; this.pitch = -0.04; }
    this.vel.set(0, 0, 0);
    this.update(0, null);
  }
  /** Out of bed: standing beside it on the chair's side, looking along the ward. */
  getUp() {
    const i = this.bed, bx = BEDS[i] ?? 0, cs = CAB_SIDE[i] ?? 1;
    this.role = 'visitor'; this.seat = null;
    this.pos.set(bx + cs * 0.95, 0, IN.z0 + 2.35); this.yaw = cs > 0 ? 0.6 : -0.6; this.pitch = -0.05;
    this.vel.set(0, 0, 0);
  }
  sit(ch) { this.seat = ch; this.vel.set(0, 0, 0); this.yaw = ch.yaw; this.pitch = -0.1; }
  stand() {
    const ch = this.seat; this.seat = null;
    if (ch) { this.pos.set(ch.x + Math.sin(ch.yaw) * -0.55, 0, ch.z + Math.cos(ch.yaw) * -0.55 + 0.25); }
  }

  walk(dt) {
    const p = this.pos;
    p.x += this.vel.x * dt; p.z += this.vel.z * dt;
    const [ax, bx, az, bz] = this.bounds || [IN.x0, IN.x1, IN.z0, IN.z1];
    for (let k = 0; k < 2; k++) {
      for (const [ox0, ox1, oz0, oz1] of this.obstacles) {
        const x0 = ox0 - R, x1 = ox1 + R, z0 = oz0 - R, z1 = oz1 + R;
        if (p.x <= x0 || p.x >= x1 || p.z <= z0 || p.z >= z1) continue;
        const dl = p.x - x0, dr = x1 - p.x, dn = p.z - z0, df = z1 - p.z, m = Math.min(dl, dr, dn, df);
        if (m === dl) p.x = x0; else if (m === dr) p.x = x1; else if (m === dn) p.z = z0; else p.z = z1;
      }
      p.x = Math.min(bx, Math.max(ax, p.x)); p.z = Math.min(bz, Math.max(az, p.z));
    }
  }

  /**
   * Your own body lying in your bed while you rest (HospitalWard.update, every frame after main.js's player.update has
   * posed the rig where you stand outdoors): the player's rig lent to this scene, posed as the others see you (mpPose,
   * net/remote.js: the fall pose, pitch -90 deg, the tuck half way, on the bed's top, its head on the pillow), the arms
   * by its side; the pillow camera goes to its eyes (the head folded away for it, as in first person outdoors).
   */
  poseBody(rig, dt) {
    if (!rig?.root || !rig.b?.head || this.role !== 'patient') return;
    if (rig.root.parent !== this.scene) {
      this.rigHome = rig.root.parent;
      this.scene.add(rig.root);
      // (lying, the body leaves the standing pose's bounds the renderer would cull it by)
      this.unculled = [];
      rig.root.traverse((o) => { if (o.isMesh && o.frustumCulled) { o.frustumCulled = false; this.unculled.push(o); } });
    }
    const bx = BEDS[this.bed] ?? 0, top = this.bedTops?.[this.bed] ?? BED.top;
    const st = this._bst ||= { mode: 'fall', heading: 0, speed: 0, crouch: 0, lean: 0, edge: 0, tuck: false, air: false, normal: UP,
      fall: { pitch: PITCH, roll: 0, ball: TUCK_Q, getUp: 0 }, fallSide: 1, fallHeading: 0, fallAir: false, fallT: 1, carry: false, airY: 0, fp: false };
    rig.root.position.set(bx, top + 0.04, HIPS_Z); // (+4 cm: lying on the mattress, not in it)
    // (no blend from the standing pose the player's update just made, and the body's settle onto the mattress kept
    // from frame to frame: the rig resets it whenever its mode changes, which it does twice a frame here)
    rig.mode = 'fall'; rig.snapNext = true;
    rig.fallLift = this.lift ?? 0; rig.fallLiftV = this.liftV || 0;
    rig.setHeadHidden(this.restView !== 'third');
    // the floor its fall pose lies on: the mattress (as net/remote.js onFloor), not the world's terrain under these coordinates
    const own = Object.prototype.hasOwnProperty.call(world, 'groundHeight'), g0 = world.groundHeight;
    world.groundHeight = () => top + 0.04;
    try { rig.update(Math.min(dt, 0.1), st); } catch (e) { console.warn('hospital: body', e); } finally { if (own) world.groundHeight = g0; else delete world.groundHeight; }
    this.lift = rig.fallLift; this.liftV = rig.fallLiftV;
    if (rig.fx?.length) rig.fx.length = 0; // (no snow puffs off a mattress)
    if (rig.gear) rig.gear.visible = false; // (no skis or poles in bed)
    bedArms(rig);
    // the eyes: up the head from the neck, toward the face (lying on your back: up), a little above
    rig.root.updateMatrixWorld(true);
    const h = _bh.setFromMatrixPosition(rig.b.head.matrixWorld);
    const u = rig.b.neck ? _bu.subVectors(h, _bn.setFromMatrixPosition(rig.b.neck.matrixWorld)).normalize() : _bu.set(0, 0.5, -0.87);
    const f = _bf.copy(UP).addScaledVector(u, -UP.dot(u));
    if (f.lengthSq() < 1e-6) f.set(0, 0, 1); else f.normalize();
    (this.eye ||= new THREE.Vector3()).copy(h).addScaledVector(u, 0.1).addScaledVector(f, 0.1).addScaledVector(UP, 0.03);
    (this.bodyC ||= new THREE.Vector3()).setFromMatrixPosition(rig.b.hips.matrixWorld).addScaledVector(UP, 0.12);
  }
  /** Out of bed (up, out of the door, back to the menu): the rig back where it came from, walking again. */
  returnBody(rig) {
    if (!rig?.root || rig.root.parent !== this.scene) return;
    this.scene.remove(rig.root);
    (this.rigHome || null)?.add(rig.root);
    this.rigHome = null;
    for (const o of this.unculled || []) o.frustumCulled = true;
    this.unculled = null;
    if (rig.gear) rig.gear.visible = !rig.fpGearHidden;
    rig.setHeadHidden(false);
    rig.snapPose?.();
    this.eye = null; this.bodyC = null;
  }

  /** The other players lying in the ward's beds now (multiplayer): bed index -> name. */
  patients() {
    const out = this._pat || (this._pat = new Map());
    out.clear();
    try {
      const rp = isMP() ? window.__game?.multiplayer?.remotes?.players : null;
      if (rp) for (const r of rp.values()) {
        if (!r.ok || r.interior !== INTERIOR_ID || r.state !== ST.fall) continue;
        let best = -1, bd = 1.2;
        BEDS.forEach((bx, i) => { const d = Math.hypot(r.pos.x - bx, r.pos.z - HIPS_Z); if (d < bd) { bd = d; best = i; } });
        if (best >= 0) out.set(best, r.name || 'a patient');
      }
    } catch { /* (none shown) */ }
    return out;
  }
  /** The other players sitting on bed i's chair (multiplayer): their names. */
  visitorsOf(i) {
    const ch = this.chairs.find((c) => c.bed === i), out = [];
    if (!ch) return out;
    try {
      const rp = isMP() ? window.__game?.multiplayer?.remotes?.players : null;
      if (rp) for (const r of rp.values()) if (r.ok && r.interior === INTERIOR_ID && r.state === ST.sit && Math.hypot(r.pos.x - ch.x, r.pos.z - ch.z) < 0.7) out.push(r.name || 'Someone');
    } catch { /* (none) */ }
    return out;
  }

  /** Your presence row inside (main.js mpPose): lying in your bed, or sitting on a chair. false: walking (as usual). */
  mpPose(o) {
    if (this.role === 'patient') {
      o.x = BEDS[this.bed] ?? 0; o.y = this.bedTops?.[this.bed] ?? BED.top; o.z = HIPS_Z; o.yaw = 0;
      o.vx = 0; o.vy = 0; o.vz = 0; o.st = ST.fall; o.crouch = PITCH; o.lean = 0;
      o.flags = fallFlags(1, false, TUCK, 0, 0);
      return true;
    }
    if (this.seat) {
      const s = this.seat;
      o.x = s.x; o.y = s.y; o.z = s.z; o.yaw = s.yaw; o.vx = 0; o.vy = 0; o.vz = 0; o.st = ST.sit; o.crouch = 0; o.lean = 0; o.flags = 0;
      return true;
    }
    return false;
  }

  /** Walk / look (input null: a panel or the menu is open). Returns what you look at: { kind, label, ... } or null. */
  update(dt, input, sensitivity = 1) {
    this.t += dt;
    const patient = this.role === 'patient';
    if (patient && input?.hit?.('KeyR')) this.restView = this.restView === 'third' ? 'first' : 'third'; // (the game's view toggle)
    const third = patient && this.restView === 'third';
    if (input && third) { // (from beside the bed: round your body, from the foot end and the sides, never through the wall)
      const sens = 0.0022 * sensitivity;
      this.tpYaw = Math.max(Math.PI - 1.5, Math.min(Math.PI + 1.5, this.tpYaw - input.mdx * sens));
      this.tpPitch = Math.max(-1.2, Math.min(-0.08, this.tpPitch - input.mdy * sens));
    } else if (input) {
      const sens = 0.0022 * sensitivity;
      this.yaw -= input.mdx * sens;
      this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - input.mdy * sens));
      if (patient) { // (lying back on the pillow: the head turns, the body stays; down far enough to see yourself)
        this.yaw = Math.max(-1.35, Math.min(1.35, this.yaw)); this.pitch = Math.max(-1.1, Math.min(0.95, this.pitch));
      }
    }
    if (input && !patient && !this.seat) {
      const fw = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0), st = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const want = new THREE.Vector3(-fz * st + fx * fw, 0, fx * st + fz * fw);
      if (want.lengthSq()) want.normalize().multiplyScalar(input.down('ShiftLeft') ? 3.2 : 2.0);
      this.vel.lerp(want, 1 - Math.exp(-dt * 10));
    } else this.vel.multiplyScalar(Math.exp(-dt * 10));
    if (!patient && !this.seat) this.walk(dt);
    const cam = this.camera;
    if (patient) { // the head on the raised pillow (your body's eyes: poseBody), a slow breath
      const bx = BEDS[this.bed] ?? 0, top = this.bedTops?.[this.bed] ?? BED.top;
      if (this.eye) cam.position.copy(this.eye);
      else cam.position.set(bx, top + 0.42, IN.z0 + 0.55);
      cam.position.y += Math.sin(this.t * 1.3) * 0.006;
    } else if (this.seat) {
      cam.position.set(this.seat.x - Math.sin(this.seat.yaw) * 0.08, this.seat.y + 0.72, this.seat.z - Math.cos(this.seat.yaw) * 0.08);
    } else {
      const bob = Math.sin(this.t * 9) * Math.min(1, this.vel.length() / 2.0) * 0.025;
      cam.position.set(this.pos.x, EYE + bob, this.pos.z);
    }
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    if (third) { // beside the bed, looking at you lying in it
      const bx = BEDS[this.bed] ?? 0, top = this.bedTops?.[this.bed] ?? BED.top;
      const c = this.bodyC || _bt.set(bx, top + 0.3, HIPS_Z - 0.2), cp = this.tpPitch;
      cam.position.set(c.x - Math.sin(this.tpYaw) * Math.cos(cp) * 2.3, c.y - Math.sin(cp) * 2.3, c.z - Math.cos(this.tpYaw) * Math.cos(cp) * 2.3);
      cam.position.x = Math.max(IN.x0 + 0.2, Math.min(IN.x1 - 0.2, cam.position.x));
      cam.position.y = Math.max(0.4, Math.min(IN.H - 0.15, cam.position.y));
      cam.position.z = Math.max(IN.z0 + 0.2, Math.min(PART.z - 0.2, cam.position.z));
      cam.lookAt(c);
    } else cam.lookAt(cam.position.clone().add(dir));
    if (this.ecgTex) this.ecgTex.offset.x = (this.t * 0.22) % 1;
    if (this.clocks) {
      const d = new Date(), s = d.getSeconds() + d.getMilliseconds() / 1000, m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
      for (const c of this.clocks) { c.s.rotation.z = -(s / 60) * Math.PI * 2; c.m.rotation.z = -(m / 60) * Math.PI * 2; c.h.rotation.z = -(h / 12) * Math.PI * 2; }
    }
    this.portal.setDay(1 - (nightUniform.value || 0));
    this.renderPortal();
    if (!input) return null;
    if (patient) return { kind: 'bed', label: null };
    if (this.seat) {
      const who = this.patients().get(this.seat.bed);
      return { kind: 'stand', label: who ? `Visiting ${who} · stand up` : 'Stand up' };
    }
    // the way out
    const dx = EXIT.x - this.pos.x, dz = EXIT.z - this.pos.z, d = Math.hypot(dx, dz);
    if (d < 2.0 && (dx * dir.x + dz * dir.z) / Math.max(d, 1e-3) > 0.3) return { kind: 'door', label: 'Leave the medical centre' };
    // a visitor's chair (by a patient: visit them)
    let best = null, bd = 1.25;
    for (const ch of this.chairs) {
      const cx = ch.x - this.pos.x, cz = ch.z - this.pos.z, cd = Math.hypot(cx, cz);
      if (cd < bd && (cx * dir.x + cz * dir.z) / Math.max(cd, 1e-3) > 0.2) { bd = cd; best = ch; }
    }
    if (best) {
      if (this.visitorsOf(best.bed).length) return { kind: 'taken', label: 'Chair taken' };
      const who = this.patients().get(best.bed);
      return { kind: 'chair', chair: best, label: who ? `Visit ${who} · sit by the bed` : 'Sit down' };
    }
    // an empty bed / a patient's bed
    for (let i = 0; i < BEDS.length; i++) {
      if (Math.abs(this.pos.x - BEDS[i]) < 1.0 && this.pos.z - (IN.z0 + BED.len) < 1.0 && this.pos.z > IN.z0) {
        const who = this.patients().get(i);
        if (who) return { kind: 'patient', label: `${who} · bed ${i + 1}` };
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------- the waking up, the stay card (HUD)
const CARD_CSS = `
#hosp-card { position: absolute; left: 22px; bottom: 92px; min-width: calc(var(--u, 1px) * 300); padding: calc(var(--u, 1px) * 12) calc(var(--u, 1px) * 30) calc(var(--u, 1px) * 14) calc(var(--u, 1px) * 24);
  background: #fff; color: var(--blue, #1546c8); clip-path: var(--brush-a); filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)); pointer-events: none; }
#hosp-card[hidden] { display: none; }
#hosp-card .hc-head { font-family: var(--num); font-style: italic; font-weight: 700; font-size: calc(var(--u, 1px) * 20); letter-spacing: 0.08em; color: #d8283a; }
#hosp-card.fit .hc-head { color: #1f9d55; }
#hosp-card .hc-t { font-family: var(--num); font-style: italic; font-weight: 700; font-size: calc(var(--u, 1px) * 52); line-height: 1; font-variant-numeric: tabular-nums; }
#hosp-card .hc-sub { margin-top: calc(var(--u, 1px) * 4); font-size: calc(var(--u, 1px) * 15); font-weight: 700; color: var(--blue-dim, #4f72d4); }
#hosp-wake { position: fixed; inset: 0; pointer-events: none; z-index: 60; overflow: hidden; }
#hosp-wake .hw-haze { position: absolute; inset: 0; backdrop-filter: blur(9px) saturate(0.7); -webkit-backdrop-filter: blur(9px) saturate(0.7); background: rgba(255, 236, 214, 0.12); animation: hw-haze 5.2s ease-out forwards; }
#hosp-wake .hw-lid { position: absolute; left: -15%; width: 130%; height: 56%; background: radial-gradient(ellipse at 50% 100%, #1a0f0c 0%, #040203 70%); }
#hosp-wake .hw-t { top: 0; border-radius: 0 0 50% 50% / 0 0 38% 38%; animation: hw-top 3.6s ease-in-out forwards; }
#hosp-wake .hw-b { bottom: 0; border-radius: 50% 50% 0 0 / 38% 38% 0 0; background: radial-gradient(ellipse at 50% 0%, #1a0f0c 0%, #040203 70%); animation: hw-bot 3.6s ease-in-out forwards; }
@keyframes hw-top { 0% { transform: translateY(0); } 16% { transform: translateY(-30%); } 24% { transform: translateY(-2%); } 44% { transform: translateY(-62%); } 52% { transform: translateY(-14%); } 100% { transform: translateY(-112%); } }
@keyframes hw-bot { 0% { transform: translateY(0); } 16% { transform: translateY(30%); } 24% { transform: translateY(2%); } 44% { transform: translateY(62%); } 52% { transform: translateY(14%); } 100% { transform: translateY(112%); } }
@keyframes hw-haze { 0% { opacity: 1; } 60% { opacity: 0.8; } 100% { opacity: 0; } }`;
function hudCss() {
  if (typeof document === 'undefined' || document.getElementById('hosp-css')) return;
  const st = document.createElement('style'); st.id = 'hosp-css'; st.textContent = CARD_CSS; document.head.appendChild(st);
}

export class HospitalWard {
  /**
   * @param {object} o  scene, renderer, hud, audio, transition, player, getPost: () => post, clearActivity: () => void
   *   (out of vehicles, lifts: main.js), canStart: () => bool
   */
  constructor(o) {
    Object.assign(this, o);
    this.inside = false;   // in the medical centre's scene
    this.role = null;      // 'patient' (in bed) | 'visitor'
    this.active = false;   // recovering (in bed, not yet allowed up)
    this.until = 0;
    this.busy = false;
    this.target = null;
    this.door = null;
    this.H = busRoads.hospital || null;
    this.room = new HospitalRoom({ renderer: o.renderer });
    try { this.setupOutside(); } catch (e) { console.warn('hospital ward: outside', e); }
  }

  // the door spot outside (the forecourt, 2 m out from the glass doors, facing away from them) and the window frame
  setupOutside() {
    const L = this.H;
    if (!L) return;
    const w = (lx, lz) => ({ x: L.x + L.dirz * lx + L.dirx * lz, z: L.z - L.dirx * lx + L.dirz * lz });
    const yaw0 = Math.atan2(L.dirx, L.dirz), FRONT = HOSPITAL_LOT.front, BZ = FRONT - HOUSE.D / 2;
    const d = w(0, FRONT + 2.2);
    this.door = { x: d.x, z: d.z, yaw: yaw0 };
    this.linkWorld();
  }
  // the live window view: the house's frame in the outdoor medical centre (hospital.js builds it before us; looked up
  // by name, again later if it was not there yet)
  linkWorld() {
    if (this.linked || !this.H || !this.scene) return;
    const g = this.scene.getObjectByName('medical-centre');
    if (!g) return;
    const BZ = HOSPITAL_LOT.front - HOUSE.D / 2;
    const frame = new THREE.Object3D(); frame.position.set(0, 0, BZ); g.add(frame); g.updateMatrixWorld(true);
    // the house itself (hospital.js: the group at the house's middle) hidden while the world is drawn from inside it
    const house = g.children.find((c) => c.isGroup && c !== frame && Math.abs(c.position.z - BZ) < 1e-3 && Math.abs(c.position.x) < 1e-3) || null;
    this.room.setWorld({ scene: this.scene, frame, hide: () => [house, this.player?.rig?.root, this.player?.rig?.gear] });
    this.linked = true;
  }

  now() { return Date.now(); }
  left() { return this.active ? Math.max(0, (this.until - this.now()) / 1000) : 0; }
  bedIndex() { return isMP() ? (MP.pid >>> 0) % BEDS.length : 1; }

  /**
   * Taken to the medical centre (the rescue's ambulance; behind its fade): you wake up in a hospital bed. Returns
   * false when it cannot (no medical centre, in prison): the caller leaves you outside its door as before.
   */
  admit({ seconds = STAY_S } = {}) {
    if (!this.H) return false;
    const pr = window.__game?.prison;
    if (pr?.active || pr?.inside) return false;
    const fromRescue = !!this.transition?.active;
    const go = () => {
      // (from the rescue: already out of the helicopter and the ambulance; from anywhere else: out of whatever you were doing)
      if (!fromRescue) { try { this.clearActivity?.(); } catch (e) { console.warn('hospital: clear', e); } }
      this.linkWorld();
      this.room.place('patient', this.bedIndex());
      this.role = 'patient';
      this.active = true;
      this.until = this.now() + Math.max(5, seconds) * 1000;
      this.notified = false; this.visitSeen = new Set();
      this.show(true);
      this.player.frozen = true;
      this.wake();
    };
    if (this.transition?.active) go(); // (behind the rescue's fade already)
    else { this.busy = true; this.transition.fade(go).catch((e) => console.warn('hospital', e)).finally(() => { this.busy = false; }); }
    setTimeout(() => this.hud?.flash('You wake up in the medical centre · rest a moment', 'good', 3600), 1600);
    return true;
  }
  // the eyes opening: dark lids part, blink, open; the room swims into focus
  wake() {
    if (typeof document === 'undefined') return;
    hudCss();
    document.getElementById('hosp-wake')?.remove();
    const el = document.createElement('div'); el.id = 'hosp-wake';
    el.innerHTML = '<div class="hw-haze"></div><div class="hw-lid hw-t"></div><div class="hw-lid hw-b"></div>';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5600);
  }

  show(on) {
    this.inside = on;
    const post = this.getPost();
    if (on) post.setView(this.room.scene, this.room.camera);
    else { post.setView(this.scene, this.camera); this.room.releasePortal(); }
    const ch = document.getElementById('crosshair'); if (ch) ch.hidden = !on;
    if (!on) this.card(null);
  }
  /** Out of bed, once fit. */
  getUp() {
    if (this.role !== 'patient' || this.active) return;
    this.audio?.play?.('click');
    this.room.returnBody(this.player?.rig);
    this.room.getUp();
    this.role = 'visitor'; this.discharged = true; // (a patient on the way out: "get well soon" at the door)
    this.card(null);
    this.hud?.flash('Discharged · the way out: the glass doors past reception', 'good', 3200);
  }
  outside() {
    this.room.returnBody(this.player?.rig);
    this.show(false);
    this.role = null; this.active = false;
    this.player.frozen = false;
    const d = this.door;
    if (d) {
      this.player.teleport(d.x, d.z, d.yaw);
      this.player.camYaw = d.yaw + Math.PI + 0.35;
      this.player.camPitch = -0.12;
    }
  }

  // ------------------------------------------------------------ visiting
  interaction(p) {
    if (!this.door || this.inside) return null;
    if (Math.hypot(p.x - this.door.x, p.z - this.door.z) < 2.6) return this._prompt ||= { label: 'Visit the medical centre', act: () => this.visit() };
    return null;
  }
  visit() {
    if (this.busy || this.inside || this.transition.active) return;
    this.busy = true;
    this.player.frozen = true;
    this.audio?.play?.('click');
    this.transition.fade(() => { this.linkWorld(); this.room.place('visitor'); this.role = 'visitor'; this.discharged = false; this.show(true); })
      .catch((e) => console.warn('hospital', e)).finally(() => { this.busy = false; });
  }
  leave() {
    if (this.busy || !this.inside || this.role === 'patient') return;
    this.busy = true;
    this.audio?.play?.('click');
    this.transition.fade(() => this.outside()).catch((e) => console.warn('hospital', e)).finally(() => {
      this.busy = false;
      if (this.discharged) this.hud?.flash('Get well soon · ARZT · MEDICAL CENTRE', 'good', 2400); // (only a patient: not after a visit, Oct 30, the user)
      this.discharged = false;
    });
  }

  /** Inside, per frame (main.js): looking, walking, E. */
  frame(dt, input, sensitivity) {
    this.target = this.room.update(dt, input, sensitivity);
    if (this.role === 'patient') this.target = this.active ? { kind: 'bed', label: `Resting · ${fmt(this.left())}` } : { kind: 'getUp', label: 'Get up' };
    if (this.target && input?.hit?.('KeyE')) {
      const t = this.target;
      if (t.kind === 'door') { this.audio?.play?.('click'); this.leave(); }
      else if (t.kind === 'getUp') this.getUp();
      else if (t.kind === 'bed') this.hud?.flash(`Stay in bed a little longer · ${fmt(this.left())}`, 'bad', 1600);
      else if (t.kind === 'chair') { this.audio?.play?.('click'); this.room.sit(t.chair); }
      else if (t.kind === 'stand') { this.audio?.play?.('click'); this.room.stand(); }
      else if (t.kind === 'taken') this.hud?.flash('Somebody is sitting there', 'bad', 1400);
    }
    return this.target;
  }
  /** The HUD's objective line inside. */
  hudLine() {
    if (this.role === 'patient') return (this.active ? `Recovering in bed ${this.room.bed + 1} · ${fmt(this.left())}` : 'Fit again · press E to get up') + ' · R: view';
    if (this.room.seat) return 'Sitting by the bed · E to stand up';
    return 'Medical centre · visit a patient in the ward, the way out: the glass doors';
  }

  /** Every frame: the stay's clock, the card, the visitors you get. */
  update(dt) {
    if (!this.linked && this.H) this.linkWorld();
    if (!this.inside) return;
    if (this.role === 'patient') {
      if (this.active && this.now() >= this.until) {
        this.active = false;
        this.hud?.flash('You feel fit again · press E to get up', 'good', 3200);
        this.audio?.play?.('board');
      }
      // a visitor sat down by your bed (multiplayer)
      try {
        const v = this.room.visitorsOf(this.room.bed);
        for (const n of v) if (!this.visitSeen?.has(n)) { this.visitSeen?.add(n); this.hud?.flash(`${n} came to visit you`, 'good', 3000); }
      } catch { /* (decor) */ }
      try { this.room.poseBody(this.player?.rig, dt); } catch (e) { console.warn('hospital: body', e); } // (you, lying in your bed)
      this.card(this.active ? ['RECOVERING', fmt(this.left()), `Medical centre · bed ${this.room.bed + 1} · rest until you are fit`] : ['FIT AGAIN', '✓', 'Press E to get up and walk out'], !this.active);
    } else this.card(null);
    void dt;
  }
  // the stay card (bottom left, the tow yard card's place and brush style)
  card(t, fit = false) {
    if (!t && !this.cardEl) return;
    if (!this.cardEl) {
      if (typeof document === 'undefined') return;
      hudCss();
      const el = document.createElement('div');
      el.id = 'hosp-card'; el.hidden = true;
      el.innerHTML = '<div class="hc-head"></div><div class="hc-t"></div><div class="hc-sub"></div>';
      (document.getElementById('hud') || document.body).appendChild(el);
      this.cardEl = el; this.$h = el.querySelector('.hc-head'); this.$t = el.querySelector('.hc-t'); this.$s = el.querySelector('.hc-sub'); this.cardC = {};
    }
    if (!t) { if (!this.cardEl.hidden) this.cardEl.hidden = true; return; }
    const C = this.cardC;
    if (this.cardEl.hidden) this.cardEl.hidden = false;
    if (C.fit !== fit) { this.cardEl.classList.toggle('fit', fit); C.fit = fit; }
    if (C.h !== t[0]) this.$h.textContent = C.h = t[0];
    if (C.t !== t[1]) this.$t.textContent = C.t = t[1];
    if (C.s !== t[2]) this.$s.textContent = C.s = t[2];
  }

  /** Back to the main menu / the village / out of multiplayer: out of the scene at once. */
  reset() {
    this.room.returnBody(this.player?.rig);
    if (this.inside) { this.show(false); this.player.frozen = false; }
    this.room.releasePortal();
    this.card(null);
    this.inside = false; this.role = null; this.active = false; this.busy = false; this.target = null; this.room.seat = null;
  }

  /** The trail map's marker. */
  mapMarker() { return this.door ? { x: this.door.x, z: this.door.z, label: 'Medical centre', kind: 'hospital' } : null; }
}
