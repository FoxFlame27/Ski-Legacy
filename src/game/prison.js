// The PRISON: Legacy Village's police station (Polizei) and its cells. Outside (game/prisonoutside.js): an alpine
// two-storey POLIZEI house on its lot right on the village road (planned with the roads: game/bus/roads.js
// planPrison), its door facing the road over a ploughed forecourt, the lit POLIZEI board and the blue lamp; E at the
// door: "Visit the prison" (anyone, any time). Inside (its own scene, like the car rental's: main.js renders it
// through post.setView): the front office (stone floor, larch panelling, a timber ceiling, warm pendants, the
// reception counter of stone and oak behind glass with the desk officer, benches, the wanted posters, a clock), a
// barred gate into the cell block: a visitor corridor along three cells behind real bars (instanced steel rods: crisp
// and see-through), cold fluorescent tubes, a bunk bed, a steel toilet and a barred window in each cell, the guard
// post, a visiting desk; E at the front door leaves.
//
//   prison.jail(seconds, reason)  fade, you are in a cell (behind the bars) for that long ("In prison · 1:30 · why"),
//                                 you walk the cell and nothing else; at the end: fade, out of the door, "Released"
//   prison.active                 true while you serve a sentence
//   prison.door                   { x, z, yaw }: where you stand outside the door (yaw: facing away from it)
//
// Multiplayer: the interior id is 'prison' (jailed or visiting), so everyone inside sees everyone else (net/remote.js):
// visitors in the corridor, prisoners in their cells (each in cell pid % 3). The sentence is the server's: the 'jail'
// request stores jailUntil in your profile, and a login before then puts you back in the cell for the rest.
// Single player: save.jail = { until (Date.now ms), reason } does the same across a reload.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { fitModel, loadGLB } from '../core/assets.js';
import { busRoads } from './bus/roads.js';
import { makeSign, nightUniform } from '../world/village.js';
import { shellMaterials } from './carrentalshell.js';
import { buildPrisonOutside, polizeiSign, drawBadge } from './prisonoutside.js';
import { policeModelReady } from './police.js';
import { isMP, MP } from '../net/mode.js';
import { net } from '../net/client.js';

export const MAX_SENTENCE = 300; // s (the server's limit too)
const EYE = 1.62, UP = new THREE.Vector3(0, 1, 0), R = 0.26; // eye height, the walker's radius

// ---------------------------------------------------------------- the inside: one room, all in metres (floor y 0)
// x: the long axis (the cells at x < 5.4, the guard's office and the way out beyond); z: -4 the cells' back wall,
// -0.4 the bars, +3.6 the corridor's far wall
const ROOM = { x0: -5.4, x1: 9.0, z0: -4.0, bars: -0.4, z1: 3.6, H: 3.3 };
const CELLS = [-3.6, 0, 3.6]; // the cells' middles (each 3.6 m wide)
const CELL_W = 3.6;
// the front office beyond the cell block (x 9 .. 17): taller, deeper (to z 5.6); the barred gate between them in the
// corridor (z GATE.z0 .. z1), the reception counter along z -0.9 .. -0.2 (the staff behind it), the front door in its
// far end (EXIT)
const FRONT = { x0: 9.0, x1: 17.0, z0: -4.0, z1: 5.6, H: 3.6 };
const GATE = { z0: 0.4, z1: 2.6 };
const EXIT = { x: 16.95, z: 2.6 };

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

export class PrisonRoom {
  constructor({ renderer, makeRig, models = {} }) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1d20);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.yaw = 0; this.pitch = 0;
    this.bounds = null; this.obstacles = []; this.flicker = null; this.t = 0;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
      pmrem.dispose();
      this.scene.environmentIntensity = 0.35;
    } catch (e) { console.warn('prison env', e); }
    this.buildShell();
    this.buildBars();
    this.buildLights();
    this.buildFront(models);
    this.ready = this.buildProps(makeRig);
  }

  // ------------------------------------------------------------ walls, floor, ceiling (canvas textures)
  buildShell() {
    const S = this.scene, { x0, x1, z0, z1, H, bars } = ROOM;
    const floorMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, map: tex(512, 512, (g, w, h) => {
      g.fillStyle = '#7d8286'; g.fillRect(0, 0, w, h);
      const r = rng(7);
      for (let i = 0; i < 9000; i++) { const v = 100 + r() * 60 | 0; g.fillStyle = `rgba(${v},${v + 4},${v + 8},0.35)`; g.fillRect(r() * w, r() * h, 2, 2); }
      g.strokeStyle = 'rgba(40,44,48,0.55)'; g.lineWidth = 3; g.strokeRect(0, 0, w, h); // (the joints of 2 m slabs)
    }, [(x1 - x0) / 2, (z1 - z0) / 2]) });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2); floor.receiveShadow = true;
    S.add(floor);
    // a yellow line along the bars: visitors keep behind it
    const line = new THREE.Mesh(new THREE.PlaneGeometry(CELL_W * 3, 0.08), new THREE.MeshStandardMaterial({ color: 0xd8b21c, roughness: 0.6 }));
    line.rotation.x = -Math.PI / 2; line.position.set(0, 0.004, bars + 0.75); line.receiveShadow = true; S.add(line);
    // painted block walls: pale institutional green to 1.25 m, a dark stripe, off-white above, the block joints
    const wallTex = (u) => tex(512, 512, (g, w, h) => {
      const split = h * (1 - 1.25 / H);
      g.fillStyle = '#d9dcd6'; g.fillRect(0, 0, w, split);
      g.fillStyle = '#8fa39a'; g.fillRect(0, split, w, h - split);
      g.fillStyle = '#4c5c57'; g.fillRect(0, split - 6, w, 8);
      g.strokeStyle = 'rgba(70,74,70,0.22)'; g.lineWidth = 2;
      const bh = h / (H / 0.2), bw = w / 2.5; // (0.2 m x 0.4 m blocks; the texture is 1 m wide)
      for (let row = 0, y = 0; y < h; row++, y += bh) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
        for (let x = (row % 2) * bw / 2; x < w; x += bw) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + bh); g.stroke(); }
      }
      const r = rng(u);
      for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(60,55,45,${0.04 + r() * 0.06})`; g.beginPath(); g.ellipse(r() * w, h - r() * h * 0.5, 6 + r() * 30, 2 + r() * 8, 0, 0, 7); g.fill(); } // (scuffs)
    });
    const wallMat = (len, seed) => { const t = wallTex(seed); t.wrapS = THREE.RepeatWrapping; t.repeat.set(len, 1); return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 }); };
    const wall = (len, x, z, rotY, seed = 1) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, H), wallMat(len, seed));
      m.position.set(x, H / 2, z); m.rotation.y = rotY; m.receiveShadow = true; S.add(m); return m;
    };
    wall(x1 - x0, (x0 + x1) / 2, z0, 0, 2);             // the cells' back wall (faces +z)
    wall(x1 - x0, (x0 + x1) / 2, z1, Math.PI, 3);       // the corridor's far wall
    wall(z1 - z0, x0, (z0 + z1) / 2, Math.PI / 2, 4);   // the left end
    // the right end: the partition to the front office, the barred gate's opening in it (the corridor's face)
    { const a = wall(GATE.z0 - z0, x1 - 0.1, (z0 + GATE.z0) / 2, -Math.PI / 2, 5); void a;
      const b = wall(z1 - GATE.z1, x1 - 0.1, (GATE.z1 + z1) / 2, -Math.PI / 2, 6); void b; }
    // the walls between the cells (and the office): 0.2 m block, both faces painted
    const block = new THREE.MeshStandardMaterial({ map: wallTex(9), roughness: 0.85 });
    block.map.wrapS = THREE.RepeatWrapping; block.map.repeat.set(3.6, 1);
    for (const x of [-1.8, 1.8, 5.4]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, H, bars - z0), block);
      m.position.set(x, H / 2, (bars + z0) / 2); m.castShadow = m.receiveShadow = true; S.add(m);
      this.obstacles.push([x - 0.1, x + 0.1, z0, bars]);
    }
    // the office's counter (beyond the cells, in line with the bars): visitors stay in the corridor
    const counter = new THREE.Mesh(new THREE.BoxGeometry(x1 - 5.4, 1.05, 0.5), new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 0.6 }));
    counter.position.set((5.4 + x1) / 2, 0.525, bars + 0.05); counter.castShadow = counter.receiveShadow = true; S.add(counter);
    const top = new THREE.Mesh(new THREE.BoxGeometry(x1 - 5.4 + 0.06, 0.05, 0.62), new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 0.4 }));
    top.position.set((5.4 + x1) / 2, 1.075, bars + 0.05); top.castShadow = top.receiveShadow = true; S.add(top);
    // the ceiling: acoustic tiles in a grid
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ roughness: 0.95, map: tex(256, 256, (g, w, h) => {
      g.fillStyle = '#c9cbc6'; g.fillRect(0, 0, w, h);
      const r = rng(3); for (let i = 0; i < 1500; i++) { g.fillStyle = 'rgba(90,90,90,0.25)'; g.fillRect(r() * w, r() * h, 1.5, 1.5); }
      g.strokeStyle = '#8c8f8a'; g.lineWidth = 6; g.strokeRect(0, 0, w, h);
    }, [(x1 - x0) / 0.6, (z1 - z0) / 0.6]) }));
    ceil.rotation.x = Math.PI / 2; ceil.position.set((x0 + x1) / 2, H, (z0 + z1) / 2); S.add(ceil);
    // skirting
    const skirt = new THREE.MeshStandardMaterial({ color: 0x3d4744, roughness: 0.5 });
    for (const [len, x, z, ry] of [[x1 - x0, (x0 + x1) / 2, z1 - 0.01, 0], [z1 - bars, x0 + 0.01, (z1 + bars) / 2, Math.PI / 2], [z1 - GATE.z1, x1 - 0.11, (z1 + GATE.z1) / 2, Math.PI / 2]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.02), skirt); m.position.set(x, 0.06, z); m.rotation.y = ry; S.add(m);
    }
    // a notice board and the cell numbers
    const plate = (text, x, z, ry, w = 0.5) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.22), new THREE.MeshStandardMaterial({ roughness: 0.5, map: tex(256, 112, (g, cw, ch) => {
        g.fillStyle = '#1b2a3d'; g.fillRect(0, 0, cw, ch); g.strokeStyle = '#e8eef5'; g.lineWidth = 6; g.strokeRect(5, 5, cw - 10, ch - 10);
        g.fillStyle = '#fff'; g.font = 'bold 60px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, cw / 2, ch / 2 + 2);
      }) }));
      m.position.set(x, 2.95, z); m.rotation.y = ry; S.add(m); return m;
    };
    CELLS.forEach((cx, i) => plate(`ZELLE ${i + 1}`, cx, bars + 0.06, 0, 0.62));
    const rules = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshStandardMaterial({ roughness: 0.7, map: tex(440, 320, (g, w, h) => {
      g.fillStyle = '#f2efe6'; g.fillRect(0, 0, w, h); g.fillStyle = '#123a6b'; g.fillRect(0, 0, w, 64);
      g.fillStyle = '#fff'; g.font = 'bold 40px Arial'; g.textAlign = 'center'; g.fillText('BESUCHSZEIT', w / 2, 46);
      g.fillStyle = '#222'; g.font = '24px Arial'; g.textAlign = 'left';
      ['Visiting hours: always', 'Stay behind the yellow line', 'Do not pass anything', 'through the bars', 'Polizei Legacy Village'].forEach((t, i) => g.fillText(t, 26, 108 + i * 44));
    }) }));
    rules.position.set(2.0, 1.65, z1 - 0.02); rules.rotation.y = Math.PI; S.add(rules);
    this.obstacles.push([5.4, x1, bars - 0.25, bars + 0.35]); // (the counter)
  }

  // ------------------------------------------------------------ the bars: instanced round steel rods and flat bands
  buildBars() {
    const S = this.scene, { x0, H, bars, z0 } = ROOM;
    const steel = new THREE.MeshStandardMaterial({ color: 0x4d5257, metalness: 0.85, roughness: 0.32 });
    const rods = [], bands = []; // rods: [x, z, y0, y1, r]; bands: [x, z, y, w, h, d]
    const span = (a, b, z) => {
      for (let x = a + 0.11; x < b - 0.06; x += 0.125) rods.push([x, z, 0, H, 0.017]);
      for (const y of [0.06, 1.05, 2.1, H - 0.05]) bands.push([(a + b) / 2, z, y, b - a, y > H - 0.1 || y < 0.1 ? 0.1 : 0.05, 0.035]);
    };
    for (const cx of CELLS) span(cx - CELL_W / 2 + 0.1, cx + CELL_W / 2 - 0.1, bars);
    // the posts at the cell walls, and each cell's door: a heavier frame, the hinges, the lock box
    for (const x of [x0 + 0.06, -1.8, 1.8, 5.4]) bands.push([x, bars, H / 2, 0.14, H, 0.14]);
    this.doors = [];
    for (const cx of CELLS) {
      const dx0 = cx + 0.25, dx1 = cx + 1.25;
      for (const x of [dx0, dx1]) bands.push([x, bars, 1.08, 0.06, 2.16, 0.06]);
      bands.push([(dx0 + dx1) / 2, bars, 2.16, dx1 - dx0 + 0.06, 0.07, 0.06]);
      bands.push([dx1 - 0.08, bars + 0.06, 1.05, 0.16, 0.22, 0.1]); // (the lock box)
      for (const y of [0.35, 1.8]) bands.push([dx0 - 0.03, bars, y, 0.07, 0.14, 0.09]); // (hinges)
      this.doors.push({ x: (dx0 + dx1) / 2, z: bars });
    }
    // the small high windows at the back of each cell (night sky blue, a few bars)
    const winMat = new THREE.MeshStandardMaterial({ color: 0x9fb8d6, emissive: 0x7fa0c8, emissiveIntensity: 0.9, roughness: 0.3 });
    this.winMat = winMat;
    for (const cx of CELLS) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.45), winMat); w.position.set(cx, 2.55, z0 + 0.012); S.add(w);
      for (let x = cx - 0.42; x <= cx + 0.43; x += 0.14) rods.push([x, z0 + 0.05, 2.32, 2.78, 0.014]);
      bands.push([cx, z0 + 0.05, 2.33, 1.04, 0.05, 0.04], [cx, z0 + 0.05, 2.78, 1.04, 0.05, 0.04]);
    }
    const rod = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), steel, rods.length);
    const box = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, bands.length);
    const o = new THREE.Object3D();
    rods.forEach(([x, z, y0, y1, r], i) => { o.position.set(x, (y0 + y1) / 2, z); o.scale.set(r, y1 - y0, r); o.updateMatrix(); rod.setMatrixAt(i, o.matrix); });
    bands.forEach(([x, z, y, w, h, d], i) => { o.position.set(x, y, z); o.scale.set(w, h, d); o.updateMatrix(); box.setMatrixAt(i, o.matrix); });
    for (const m of [rod, box]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; S.add(m); }
  }

  // ------------------------------------------------------------ cold fluorescent light
  buildLights() {
    const S = this.scene, { H, x0, x1, z0, z1 } = ROOM;
    S.add(new THREE.HemisphereLight(0xdfe9f2, 0x3a4044, 0.75));
    // one cold key from above the corridor: the bars throw their stripes across the cell floors
    const key = new THREE.DirectionalLight(0xe4f0ff, 1.25);
    key.position.set(1.5, H + 5, 4.5); key.target.position.set(0, 0, -2); S.add(key.target);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -10, right: 10, top: 8, bottom: -8, near: 0.5, far: 20 });
    key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
    S.add(key);
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0xf2f8ff, emissive: 0xe8f2ff, emissiveIntensity: 2.2 });
    const housing = new THREE.MeshStandardMaterial({ color: 0xcfd3d6, metalness: 0.3, roughness: 0.5 });
    const fixture = (x, z, along = 'x', I = 6, dist = 9) => {
      const g = new THREE.Group();
      const hz = along === 'x' ? [1.3, 0.05, 0.22] : [0.22, 0.05, 1.3];
      const hb = new THREE.Mesh(new THREE.BoxGeometry(...hz), housing); g.add(hb);
      const mat = tubeMat.clone();
      for (const off of [-0.05, 0.05]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.2, 8), mat);
        t.rotation.z = along === 'x' ? Math.PI / 2 : 0; t.rotation.x = along === 'x' ? 0 : Math.PI / 2;
        if (along === 'x') t.position.set(0, -0.04, off); else t.position.set(off, -0.04, 0);
        g.add(t);
      }
      g.position.set(x, H - 0.03, z); S.add(g);
      const L = new THREE.PointLight(0xe6f1ff, I, dist, 1.6); L.position.set(x, H - 0.25, z); S.add(L);
      return { mat, L, I };
    };
    const lights = [];
    for (const x of [-3.6, 0, 3.6, 7.2]) lights.push(fixture(x, 1.6, 'x', 7, 10));
    for (const x of CELLS) lights.push(fixture(x, -2.2, 'z', 3.2, 6));
    this.flicker = lights[2]; // (one tube in the corridor never quite settles)
    void x0; void x1; void z0; void z1;
  }

  // ------------------------------------------------------------ the front office: reception, waiting, the gate
  buildFront(models) {
    const S = this.scene, F = FRONT, M = shellMaterials(), cx = (F.x0 + F.x1) / 2, cz = (F.z0 + F.z1) / 2;
    const add = (geo, mat, x, y, z, ry = 0, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = shadow; m.receiveShadow = true; S.add(m); return m; };
    const box = (w, h, d, mat, x, y, z, ry = 0, shadow = true) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, ry, shadow);
    // the floor: big slate flags, warm grey, a little sheen
    const floor = add(new THREE.PlaneGeometry(F.x1 - F.x0, F.z1 - F.z0), new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05, map: tex(512, 512, (g, w, h) => {
      const r = rng(31); g.fillStyle = '#4b4842'; g.fillRect(0, 0, w, h);
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const v = 96 + r() * 26; g.fillStyle = `rgb(${v},${v - 4},${v - 10})`; g.fillRect(x * w / 2 + 3, y * h / 2 + 3, w / 2 - 6, h / 2 - 6);
        for (let i = 0; i < 500; i++) { const q = 70 + r() * 70; g.fillStyle = `rgba(${q},${q - 3},${q - 8},0.25)`; g.fillRect(x * w / 2 + r() * w / 2, y * h / 2 + r() * h / 2, 2, 2); } }
    }, [(F.x1 - F.x0) / 1.2, (F.z1 - F.z0) / 1.2]) }), cx, 0, cz, 0, false);
    floor.rotation.x = -Math.PI / 2;
    // the walls: larch panelling to 1.1 m under a dado rail, warm lime plaster above
    const wallT = (len, seed) => { const t = tex(512, 512, (g, w, h) => {
      const r = rng(seed), split = h * (1 - 1.1 / F.H);
      g.fillStyle = '#ece3d1'; g.fillRect(0, 0, w, split);
      for (let i = 0; i < 3000; i++) { const v = 215 + r() * 30; g.fillStyle = `rgba(${v},${v - 8},${v - 22},0.25)`; g.fillRect(r() * w, r() * split, 3, 3); }
      for (let x = 0; x < w; x += 64) { const v = (r() - 0.5) * 24; g.fillStyle = `rgb(${172 + v},${120 + v * 0.8},${72 + v * 0.6})`; g.fillRect(x, split, 64, h - split); g.fillStyle = 'rgba(40,20,6,0.55)'; g.fillRect(x, split, 3, h - split);
        for (let k = 0; k < 6; k++) { g.fillStyle = `rgba(70,35,12,${0.05 + r() * 0.08})`; g.fillRect(x + 6 + r() * 52, split, 1 + r() * 2, h - split); } }
      g.fillStyle = '#5a3a20'; g.fillRect(0, split - 10, w, 14); g.fillStyle = '#3a2412'; g.fillRect(0, h - 14, w, 14);
    }); t.wrapS = THREE.RepeatWrapping; t.repeat.set(len, 1); return new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 }); };
    const wall = (len, x, z, ry, seed, y0 = 0, h = F.H) => { const m = add(new THREE.PlaneGeometry(len, h), wallT(len, seed), x, y0 + h / 2, z, ry, false); return m; };
    wall(F.x1 - F.x0, cx, F.z0, 0, 41);                                   // the back (behind the counter)
    wall(F.x1 - F.x0, cx, F.z1, Math.PI, 42);                             // the front (the benches, the windows)
    wall(F.z1 - F.z0, F.x1, cz, -Math.PI / 2, 43);                        // the far end (the front door)
    wall(GATE.z0 - F.z0, F.x0 + 0.1, (F.z0 + GATE.z0) / 2, Math.PI / 2, 44); // the partition, either side of the gate
    wall(F.z1 - GATE.z1, F.x0 + 0.1, (GATE.z1 + F.z1) / 2, Math.PI / 2, 45);
    const plaster = new THREE.MeshStandardMaterial({ color: 0xe2ddd2, roughness: 0.9 });
    box(0.2, F.H - 2.45, GATE.z1 - GATE.z0, plaster, F.x0, (F.H + 2.45) / 2, (GATE.z0 + GATE.z1) / 2); // (the lintel over the gate)
    // the ceiling: larch boards on glulam beams
    const ceil = add(new THREE.PlaneGeometry(F.x1 - F.x0, F.z1 - F.z0), M.larchIn, cx, F.H, cz, 0, false); ceil.rotation.x = Math.PI / 2;
    ceil.geometry.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 ? (F.z1 - F.z0) : (F.x1 - F.x0)); });
    for (let x = F.x0 + 1.0; x < F.x1; x += 2.0) box(0.2, 0.26, F.z1 - F.z0, M.glulam, x, F.H - 0.13, cz, 0, false);
    // ---- the barred gate into the cell block: a steel frame round the opening, the grille slid open beside it
    const steel = new THREE.MeshStandardMaterial({ color: 0x3f454b, metalness: 0.85, roughness: 0.35 });
    for (const z of [GATE.z0, GATE.z1]) box(0.24, 2.45, 0.1, steel, F.x0, 1.225, z);
    box(0.24, 0.12, GATE.z1 - GATE.z0 + 0.1, steel, F.x0, 2.45, (GATE.z0 + GATE.z1) / 2);
    { const gz0 = GATE.z1 + 0.05, gz1 = gz0 + (GATE.z1 - GATE.z0), x = F.x0 + 0.2, rods = [];
      for (let z = gz0 + 0.1; z < gz1 - 0.05; z += 0.12) rods.push(z);
      const rod = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.016, 0.016, 2.3, 8), steel, rods.length), o = new THREE.Object3D();
      rods.forEach((z, i) => { o.position.set(x, 1.2, z); o.updateMatrix(); rod.setMatrixAt(i, o.matrix); });
      rod.castShadow = true; S.add(rod);
      for (const y of [0.06, 1.05, 2.33]) box(0.05, 0.08, gz1 - gz0, steel, x, y, (gz0 + gz1) / 2);
      for (const z of [gz0, gz1]) box(0.06, 2.4, 0.06, steel, x, 1.2, z);
      box(0.12, 0.2, 0.16, steel, x + 0.05, 1.05, gz1 - 0.12); // (the lock)
      box(0.08, 0.08, gz1 - gz0 + 0.6, steel, x - 0.05, 2.5, (gz0 + gz1) / 2 - 0.3); // (its track)
      this.obstacles.push([F.x0, x + 0.12, gz0, gz1]);
    }
    const plateMat = (text, sub = '') => new THREE.MeshStandardMaterial({ roughness: 0.5, map: tex(512, 160, (g, w, h) => {
      g.fillStyle = '#123e86'; g.fillRect(0, 0, w, h); g.strokeStyle = '#e8eef5'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
      drawBadge(g, 70, h / 2, 46);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 54px Georgia'; g.fillText(text, w / 2 + 40, sub ? h * 0.4 : h / 2 + 2);
      if (sub) { g.font = '28px Georgia'; g.fillStyle = '#dbe4f0'; g.fillText(sub, w / 2 + 40, h * 0.76); }
    }) });
    add(new THREE.PlaneGeometry(1.5, 0.47), plateMat('ZELLEN', 'Cells · Besuch / Visits'), F.x0 + 0.12, 2.95, (GATE.z0 + GATE.z1) / 2, Math.PI / 2, false);
    // ---- the reception counter: a stone base, an oak top, glass above it (a pass slot under), half doors to the wall
    const cX0 = 10.4, cX1 = 15.8, cZ = -0.55, cmx = (cX0 + cX1) / 2, cl = cX1 - cX0;
    box(cl, 1.0, 0.7, M.stone, cmx, 0.5, cZ);
    const oak = new THREE.MeshStandardMaterial({ color: 0xa8743f, roughness: 0.45 });
    box(cl + 0.1, 0.06, 0.86, oak, cmx, 1.03, cZ + 0.03);
    box(cl, 0.05, 0.5, oak, cmx, 0.76, cZ - 0.62); // (the staff's worktop behind)
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xdcecf2, roughness: 0.04, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    const bays = 4, bw = cl / bays;
    for (let i = 0; i < bays; i++) add(new THREE.PlaneGeometry(bw - 0.06, 0.8), glass, cX0 + bw * (i + 0.5), 1.62, cZ - 0.05, 0, false);
    for (let i = 0; i <= bays; i++) box(0.05, 0.92, 0.05, steel, cX0 + bw * i, 1.52, cZ - 0.05);
    box(cl + 0.05, 0.05, 0.07, steel, cmx, 2.0, cZ - 0.05);
    box(0.7, 0.03, 0.3, steel, cmx, 1.075, cZ - 0.05); // (the pass tray under the glass)
    for (const [x0, x1] of [[F.x0 + 0.1, cX0], [cX1, F.x1]]) { box(x1 - x0, 1.05, 0.08, M.larchIn, (x0 + x1) / 2, 0.525, cZ); box(x1 - x0 + 0.02, 0.05, 0.14, oak, (x0 + x1) / 2, 1.07, cZ); }
    this.obstacles.push([F.x0, F.x1, cZ - 0.4, cZ + 0.38]);
    // the POLIZEI plaque on its front, the reception sign hanging over it
    const plaque = polizeiSign(2.2, 0.55, 'ANMELDUNG · RECEPTION'); plaque.position.set(cmx, 0.55, cZ + 0.36); S.add(plaque);
    this.plaqueMat = plaque.userData.faceMaterial;
    const hang = makeSign('ANMELDUNG\nReception', { w: 1.5, h: 0.5, bg: '#123e86', fg: '#ffffff', border: '#dfe8f5', font: 'bold 120px Georgia' });
    hang.position.set(cmx, 2.75, cZ + 0.1); S.add(hang);
    for (const sx of [-1, 1]) box(0.015, F.H - 3.0, 0.015, steel, cmx + sx * 0.6, (F.H + 3.0) / 2, cZ + 0.1, 0, false);
    // on the counter: the brass bell, a clipboard and pen, leaflets, a stamp
    const brass = new THREE.MeshStandardMaterial({ color: 0xd2a640, metalness: 0.95, roughness: 0.22 });
    const top = 1.06, front = cZ + 0.22;
    add(new THREE.CylinderGeometry(0.075, 0.08, 0.02, 20), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 }), 14.9, top + 0.01, front, 0, false);
    const bell = add(new THREE.SphereGeometry(0.065, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), brass, 14.9, top + 0.02, front, 0, false); void bell;
    add(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 8), brass, 14.9, top + 0.1, front, 0, false);
    const paper = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.9 }), board = new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.7 });
    box(0.25, 0.012, 0.34, board, 11.6, top + 0.006, front, 0.12, false); box(0.22, 0.006, 0.28, paper, 11.6, top + 0.015, front + 0.01, 0.12, false);
    box(0.012, 0.012, 0.15, new THREE.MeshStandardMaterial({ color: 0x1546c8 }), 11.78, top + 0.01, front, 0.5, false);
    for (let i = 0; i < 4; i++) box(0.11, 0.004, 0.22, new THREE.MeshStandardMaterial({ color: [0xf2f2f2, 0x123e86, 0xf2f2f2, 0xd8c070][i] }), 12.4 + i * 0.03, top + 0.004 + i * 0.004, front - 0.02, 0.1 * i, false);
    // ---- behind it: the desk officer's desk (the Meshy guard desk: buildProps), a monitor, a lamp, filing cabinets,
    // a shelf of binders, the POLIZEI crest on the back wall, a clock
    const crest = polizeiSign(2.8, 0.7); crest.position.set(cmx, 2.55, F.z0 + 0.05); S.add(crest);
    this.crestMat = crest.userData.faceMaterial;
    const cab = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.4, map: tex(128, 256, (g, w, h) => {
      g.fillStyle = '#8d949a'; g.fillRect(0, 0, w, h);
      for (let k = 0; k < 4; k++) { g.strokeStyle = '#5d6369'; g.lineWidth = 4; g.strokeRect(6, 6 + k * h / 4, w - 12, h / 4 - 10); g.fillStyle = '#c9cdd1'; g.fillRect(w / 2 - 18, k * h / 4 + 24, 36, 8); g.fillStyle = '#f4f2ea'; g.fillRect(w / 2 - 14, k * h / 4 + 40, 28, 12); }
    }) });
    for (let i = 0; i < 3; i++) box(0.5, 1.32, 0.6, cab, 15.25 + i * 0.52, 0.66, F.z0 + 0.32);
    box(2.2, 0.04, 0.32, oak, 10.6, 1.55, F.z0 + 0.17); box(2.2, 0.04, 0.32, oak, 10.6, 1.95, F.z0 + 0.17);
    { const r = rng(52); for (let k = 0; k < 30; k++) { const row = k < 15 ? 0 : 1, x = 9.6 + (k % 15) * 0.13; box(0.08, 0.3, 0.26, new THREE.MeshStandardMaterial({ color: [0x123e86, 0xc8342c, 0x2a2c30, 0xe8c21a, 0x2e6a3a][Math.floor(r() * 5)], roughness: 0.7 }), x, (row ? 1.97 : 1.57) + 0.15, F.z0 + 0.18, 0, false); } }
    // the clock (real time: update())
    { const face = tex(256, 256, (g, w, h) => {
        g.fillStyle = '#f7f4ec'; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 4, 0, 7); g.fill();
        g.strokeStyle = '#1c1c1c'; g.lineWidth = 10; g.stroke();
        for (let i = 0; i < 60; i++) { const a = (i / 60) * Math.PI * 2, L = i % 5 ? 8 : 22; g.lineWidth = i % 5 ? 3 : 8; g.beginPath(); g.moveTo(w / 2 + Math.sin(a) * (w / 2 - 14), h / 2 - Math.cos(a) * (h / 2 - 14)); g.lineTo(w / 2 + Math.sin(a) * (w / 2 - 14 - L), h / 2 - Math.cos(a) * (h / 2 - 14 - L)); g.stroke(); }
        g.fillStyle = '#123e86'; g.font = 'bold 20px Georgia'; g.textAlign = 'center'; g.fillText('POLIZEI', w / 2, h * 0.68);
      });
      const cg = new THREE.Group(); cg.position.set(15.9, 2.75, F.z0 + 0.04); S.add(cg);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 32), new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.4, metalness: 0.5 })); rim.rotation.x = Math.PI / 2; cg.add(rim);
      const fc = new THREE.Mesh(new THREE.CircleGeometry(0.22, 32), new THREE.MeshStandardMaterial({ map: face, roughness: 0.5 })); fc.position.z = 0.027; cg.add(fc);
      const hand = (len, w, color, z) => { const p = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.005), new THREE.MeshBasicMaterial({ color })); m.position.y = len / 2 - 0.02; p.add(m); p.position.z = z; cg.add(p); return p; };
      this.clock = { h: hand(0.11, 0.018, 0x111111, 0.03), m: hand(0.17, 0.012, 0x111111, 0.034), s: hand(0.18, 0.004, 0xc8342c, 0.038) };
    }
    // ---- the waiting side: two oak benches, the notice board (GESUCHT / wanted), windows on the snowy village
    for (const [x0, x1] of [[10.0, 12.6], [13.5, 15.9]]) {
      const mx = (x0 + x1) / 2, l = x1 - x0;
      box(l, 0.06, 0.42, oak, mx, 0.46, F.z1 - 0.26);
      box(l, 0.36, 0.04, oak, mx, 0.82, F.z1 - 0.06);
      for (const x of [x0 + 0.15, x1 - 0.15]) { box(0.05, 0.44, 0.38, steel, x, 0.22, F.z1 - 0.26); }
      this.obstacles.push([x0, x1, F.z1 - 0.5, F.z1]);
    }
    const posters = tex(1024, 560, (g, w, h) => {
      g.fillStyle = '#b48a5a'; g.fillRect(0, 0, w, h);
      const r = rng(77); for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(${90 + r() * 60},${60 + r() * 40},${30 + r() * 20},0.35)`; g.fillRect(r() * w, r() * h, 2, 2); }
      g.strokeStyle = '#5a3a20'; g.lineWidth = 22; g.strokeRect(0, 0, w, h);
      const wanted = (x, y, name, reward, seed) => {
        const q = rng(seed); g.save(); g.translate(x, y); g.rotate((q() - 0.5) * 0.06);
        g.fillStyle = '#efe6cf'; g.fillRect(0, 0, 200, 270); g.fillStyle = '#1b1b1b'; g.font = 'bold 40px Georgia'; g.textAlign = 'center'; g.fillText('GESUCHT', 100, 44);
        g.fillStyle = '#c8c0aa'; g.fillRect(30, 60, 140, 130);
        g.fillStyle = '#3a3a3a'; g.beginPath(); g.arc(100, 112, 30 + q() * 6, 0, 7); g.fill(); g.beginPath(); g.ellipse(100, 192, 58, 44, 0, Math.PI, 0); g.fill();
        g.fillStyle = '#c8c0aa'; g.fillRect(84 - q() * 6, 104, 10, 6); g.fillRect(108, 104, 10, 6);
        g.fillStyle = '#1b1b1b'; g.font = 'bold 20px Georgia'; g.fillText(name, 100, 218); g.font = '18px Georgia'; g.fillStyle = '#8a1a14'; g.fillText(`Belohnung ${reward}`, 100, 246);
        g.restore(); g.fillStyle = '#c8342c'; g.beginPath(); g.arc(x + 100, y + 8, 7, 0, 7); g.fill();
      };
      wanted(40, 40, '"Der Pistenrowdy"', '$2,000', 1); wanted(270, 60, 'Speeding · Talstrasse', '$1,500', 2); wanted(500, 36, '"Schneeschuh-Sepp"', '$3,000', 3);
      const note = (x, y, wd, ht, lines, col, seed) => { const q = rng(seed); g.save(); g.translate(x, y); g.rotate((q() - 0.5) * 0.08); g.fillStyle = col; g.fillRect(0, 0, wd, ht); g.fillStyle = '#222'; g.font = '19px Arial'; g.textAlign = 'left'; lines.forEach((t, i) => g.fillText(t, 12, 30 + i * 25)); g.restore(); g.fillStyle = '#1546c8'; g.beginPath(); g.arc(x + wd / 2, y + 7, 6, 0, 7); g.fill(); };
      note(740, 40, 240, 170, ['FUNDBÜRO / Lost & found', 'Ski, poles, 1 left glove', 'ask at the counter'], '#fff7c0', 4);
      note(740, 240, 240, 140, ['Lawinenwarnstufe 3', 'Avalanche danger:', 'considerable'], '#ffd6c8', 5);
      note(80, 350, 300, 150, ['NOTRUF 133', 'Police emergency', 'Bergrettung 140'], '#e8f0ff', 6);
      note(420, 360, 280, 160, ['Speed limit in the', 'village: 30 km/h', 'Fines from $500'], '#ffffff', 7);
    });
    add(new THREE.BoxGeometry(2.3, 1.26, 0.04), new THREE.MeshStandardMaterial({ color: 0x5a3a20, roughness: 0.7 }), 11.3, 1.85, F.z1 - 0.03, 0, false);
    add(new THREE.PlaneGeometry(2.2, 1.2), new THREE.MeshStandardMaterial({ map: posters, roughness: 0.85 }), 11.3, 1.85, F.z1 - 0.055, Math.PI, false);
    this.viewMat = M.winIn.clone();
    for (const x of [14.7]) {
      add(new THREE.PlaneGeometry(1.3, 1.25), this.viewMat, x, 1.95, F.z1 - 0.02, Math.PI, false);
      box(1.45, 0.08, 0.1, M.larchIn, x, 2.6, F.z1 - 0.05); box(1.5, 0.06, 0.24, oak, x, 1.3, F.z1 - 0.1);
      box(0.06, 1.3, 0.1, M.larchIn, x - 0.7, 1.95, F.z1 - 0.05); box(0.06, 1.3, 0.1, M.larchIn, x + 0.7, 1.95, F.z1 - 0.05); box(0.05, 1.25, 0.06, M.larchIn, x, 1.95, F.z1 - 0.05);
    }
    // ---- the front door (oak, a glass panel, the green AUSGANG sign), a doormat, a coat stand, plants
    { const door = new THREE.Group(), dm = new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 0.55 });
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 0.06), dm); leaf.position.y = 1.1; door.add(leaf);
      for (const [w, h, x, y] of [[0.1, 2.32, -0.6, 1.16], [0.1, 2.32, 0.6, 1.16], [1.3, 0.1, 0, 2.27]]) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), M.glulam); m.position.set(x, y, 0); door.add(m); }
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.8), this.viewMat); pane.position.set(0, 1.55, 0.032); door.add(pane);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.05), brass); handle.position.set(0.42, 1.05, 0.06); door.add(handle);
      const exitSign = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.06), new THREE.MeshBasicMaterial({ map: tex(320, 104, (g, w, h) => {
        g.fillStyle = '#0f8a3c'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = 'bold 56px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('AUSGANG', w / 2, h / 2 + 3);
      }) }));
      exitSign.position.set(0, 2.55, 0.04); door.add(exitSign);
      door.position.set(F.x1 - 0.04, 0, EXIT.z); door.rotation.y = -Math.PI / 2;
      door.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      S.add(door);
      const mat = add(new THREE.PlaneGeometry(0.9, 1.4), new THREE.MeshStandardMaterial({ roughness: 1, map: tex(128, 192, (g, w, h) => { g.fillStyle = '#2b2a28'; g.fillRect(0, 0, w, h); g.strokeStyle = '#4a4740'; g.lineWidth = 6; g.strokeRect(8, 8, w - 16, h - 16); }) }), F.x1 - 0.6, 0.006, EXIT.z, 0, false);
      mat.rotation.x = -Math.PI / 2;
      // the coat stand
      const cs = new THREE.Group(); cs.position.set(F.x1 - 0.35, 0, F.z1 - 0.4); S.add(cs);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 10), M.glulam); pole.position.y = 0.9; cs.add(pole);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.04, 16), M.glulam); foot.position.y = 0.02; cs.add(foot);
      const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x1d4f7a, roughness: 0.85 })); coat.position.set(0.1, 1.3, 0); cs.add(coat);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.07, 14), new THREE.MeshStandardMaterial({ color: 0x15233a, roughness: 0.6 })); cap.position.set(-0.08, 1.82, 0.05); cs.add(cap);
      cs.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.obstacles.push([F.x1 - 0.65, F.x1, F.z1 - 0.7, F.z1]);
    }
    const plant = (x, z, s = 1) => {
      const g = new THREE.Group(); g.position.set(x, 0, z); S.add(g);
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26 * s, 0.2 * s, 0.5 * s, 16), new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 0.8 })); pot.position.y = 0.25 * s; g.add(pot);
      const r = rng(Math.round(x * 13 + z * 7)), leaf = new THREE.MeshStandardMaterial({ color: 0x2f6a34, roughness: 0.75 });
      for (let i = 0; i < 9; i++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.22 * s, 10, 8), leaf); const a = r() * 7, d = r() * 0.2 * s; l.position.set(Math.cos(a) * d, (0.65 + r() * 0.75) * s, Math.sin(a) * d); l.scale.set(1, 1.4, 1); g.add(l); }
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.obstacles.push([x - 0.3 * s, x + 0.3 * s, z - 0.3 * s, z + 0.3 * s]);
    };
    plant(F.x0 + 0.55, F.z1 - 0.45); plant(13.05, F.z1 - 0.35, 0.9); plant(16.55, 0.35, 0.9);
    // the corridor behind the cell block's far wall, the partition either side of the gate: solid
    this.obstacles.push([ROOM.x0 - 1, F.x0 + 0.1, ROOM.z1, F.z1 + 1], [F.x0 - 0.1, F.x0 + 0.1, F.z0, GATE.z0], [F.x0 - 0.1, F.x0 + 0.1, GATE.z1, F.z1]);
    // ---- warm light: three pendants (a shade, a glowing bulb, a point light each), the desk lamp (buildProps)
    const shade = new THREE.MeshStandardMaterial({ color: 0x1f2a24, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
    this.bulbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd39a, emissiveIntensity: 2.6 });
    for (const [x, z] of [[11.4, 2.5], [14.8, 2.5], [cmx, -2.2]]) {
      box(0.012, 0.75, 0.012, steel, x, F.H - 0.375, z, 0, false);
      const sh = add(new THREE.ConeGeometry(0.28, 0.24, 20, 1, true), shade, x, F.H - 0.82, z, 0, false); void sh;
      add(new THREE.SphereGeometry(0.07, 12, 8), this.bulbMat, x, F.H - 0.9, z, 0, false);
      const L = new THREE.PointLight(0xffc98f, 6.5, 10, 1.5); L.position.set(x, F.H - 1.0, z); S.add(L);
    }
    const fill = new THREE.PointLight(0xffd8b0, 2.2, 12, 1.4); fill.position.set(cx, 2.4, 3.5); S.add(fill);
  }

  // ------------------------------------------------------------ the Meshy props (bunk beds, toilets, desks), the guard
  async buildProps(makeRig) {
    const S = this.scene, { z0, bars, z1, x1 } = ROOM;
    const [bed, wc, visit, guard] = await Promise.all(['prison/bunk_bed', 'prison/cell_toilet', 'prison/visit_desk', 'prison/guard_desk'].map((n) => loadGLB(n)));
    const place = (gltf, size, axis, x, z, ry, fallback) => {
      let m = gltf ? fitModel(gltf, { size, axis }) : null;
      if (!m || !m.children.length) m = fallback();
      m.position.set(x, 0, z); m.rotation.y = ry;
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      S.add(m); return m;
    };
    const plainBox = (w, h, d, color) => () => { const g = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.6 })); b.position.y = h / 2; g.add(b); return g; };
    for (const cx of CELLS) {
      // the bunk along the back wall (its long side, 1.95 m), the steel toilet on the side wall by the bars' far end
      place(bed, 1.95, 'x', cx - 0.55, z0 + 0.58, 0, plainBox(1.95, 1.6, 0.95, 0x6d737a));
      this.obstacles.push([cx - 0.55 - 1.0, cx - 0.55 + 1.0, z0, z0 + 1.1]);
      place(wc, 1.15, 'y', cx + CELL_W / 2 - 0.1 - 0.3, -2.9, -Math.PI / 2, plainBox(0.5, 1.1, 0.6, 0xb8bcc0));
      this.obstacles.push([cx + CELL_W / 2 - 0.1 - 0.62, cx + CELL_W / 2 - 0.1, -3.25, -2.55]);
    }
    // the visiting desk at the corridor's left end (stool toward the room), a bench on the far wall
    place(visit, 1.9, 'x', -4.65, 1.6, Math.PI / 2, plainBox(1.9, 1.3, 0.9, 0x3a3d40));
    this.obstacles.push([-5.4, -4.15, 0.6, 2.6]);
    for (const z of [0.95, 2.25]) { // (two stools at the visiting desk)
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 16), new THREE.MeshStandardMaterial({ color: 0x5f6b72, roughness: 0.5 }));
      st.position.set(-3.75, 0.47, z); st.castShadow = true; S.add(st);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.46, 8), new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.6, roughness: 0.4 }));
      leg.position.set(-3.75, 0.23, z); S.add(leg);
    }
    const bench = place(null, 0, 'x', -0.6, z1 - 0.28, 0, plainBox(2.4, 0.45, 0.42, 0x5f6b72));
    void bench;
    this.obstacles.push([-1.8, 0.6, z1 - 0.5, z1]);
    // the desk officer's desk in the front office behind the reception counter, facing it; on it a monitor, a
    // desk lamp (its own warm light), papers, a mug
    const DXk = (FRONT.x0 + FRONT.x1) / 2 - 0.4, DZ = -2.35;
    const desk = place(guard, 1.75, 'x', DXk, DZ, Math.PI, plainBox(1.75, 0.78, 0.9, 0x5b4a3a));
    try {
      const bb = new THREE.Box3().setFromObject(desk), top = Math.min(1.1, Math.max(0.68, bb.max.y));
      const dark = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.5 });
      const add = (geo, mat, x, y, z, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = true; S.add(m); return m; };
      const screen = tex(256, 160, (g, w, h) => { g.fillStyle = '#0d2347'; g.fillRect(0, 0, w, h); g.fillStyle = '#5f8fd8'; g.fillRect(0, 0, w, 22); g.fillStyle = '#fff'; g.font = 'bold 16px Arial'; g.fillText('INPOL · Legacy Village', 8, 16);
        g.fillStyle = '#9fc0ee'; g.font = '13px monospace'; ['ZELLE 1 .... belegt', 'ZELLE 2 .... frei', 'ZELLE 3 .... belegt', 'Streife 1 .. unterwegs', 'Streife 2 .. Wache'].forEach((t, i) => g.fillText(t, 10, 46 + i * 22)); });
      add(new THREE.BoxGeometry(0.6, 0.38, 0.04), dark, DXk + 0.35, top + 0.3, DZ + 0.1, Math.PI + 0.2);
      add(new THREE.PlaneGeometry(0.56, 0.34), new THREE.MeshStandardMaterial({ color: 0x000000, emissiveMap: screen, map: screen, emissive: 0xffffff, emissiveIntensity: 0.9 }), DXk + 0.35 - Math.sin(0.2) * 0.022, top + 0.3, DZ + 0.1 - Math.cos(0.2) * 0.022, Math.PI + 0.2);
      add(new THREE.BoxGeometry(0.06, 0.12, 0.06), dark, DXk + 0.35, top + 0.06, DZ + 0.12);
      add(new THREE.BoxGeometry(0.45, 0.02, 0.15), dark, DXk + 0.3, top + 0.01, DZ - 0.2);
      // the desk lamp: a weighted foot, two arms, a green shade over a warm bulb
      const lampM = new THREE.MeshStandardMaterial({ color: 0x1f4a32, roughness: 0.35, metalness: 0.4 });
      add(new THREE.CylinderGeometry(0.09, 0.1, 0.03, 16), lampM, DXk - 0.6, top + 0.015, DZ + 0.15);
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.36, 8), lampM, DXk - 0.6, top + 0.2, DZ + 0.15).rotation.z = 0.25;
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8), lampM, DXk - 0.5, top + 0.42, DZ + 0.15).rotation.z = -1.0;
      const hd = add(new THREE.ConeGeometry(0.09, 0.14, 16, 1, true), lampM, DXk - 0.38, top + 0.44, DZ + 0.15); hd.rotation.z = -0.5; hd.material.side = THREE.DoubleSide;
      this.deskBulb = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd08a, emissiveIntensity: 3 });
      add(new THREE.SphereGeometry(0.03, 10, 8), this.deskBulb, DXk - 0.37, top + 0.4, DZ + 0.15);
      const dl = new THREE.PointLight(0xffc27a, 1.6, 2.6, 1.6); dl.position.set(DXk - 0.36, top + 0.3, DZ + 0.15); S.add(dl);
      const paper = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.9 });
      for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.22, 0.006, 0.3), paper, DXk - 0.1 + i * 0.03, top + 0.005 + i * 0.006, DZ + 0.05 - i * 0.02, 0.2 * i);
      add(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 14), new THREE.MeshStandardMaterial({ color: 0x123e86, roughness: 0.4 }), DXk + 0.72, top + 0.05, DZ - 0.15);
    } catch (e) { console.warn('prison desk', e); }
    // the cell block's guard post (behind the bars' counter): the CCTV of the cells, a key board
    {
      const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.5, metalness: 0.3 });
      const t = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.7), new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 0.4 }));
      t.position.set(7.2, 0.76, -3.5); S.add(t);
      const legs = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.74, 0.6), dark); legs.position.set(7.2, 0.37, -3.5); S.add(legs);
      const cctv = tex(256, 160, (g, w, h) => { g.fillStyle = '#20262a'; g.fillRect(0, 0, w, h); const r = rng(5); for (let i = 0; i < 3000; i++) { const v = 60 + r() * 60; g.fillStyle = `rgba(${v},${v + 8},${v},0.5)`; g.fillRect(r() * w, r() * h, 2, 2); }
        g.strokeStyle = '#9aa'; g.lineWidth = 2; for (let x = 20; x < w; x += 18) { g.beginPath(); g.moveTo(x, 30); g.lineTo(x, h); g.stroke(); } g.fillStyle = '#e0f0e0'; g.font = '14px monospace'; g.fillText('CAM 1  REC', 8, 18); });
      for (const x of [6.4, 7.2, 8.0]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.42, 0.06), dark); m.position.set(x, 1.05, -3.7); S.add(m);
        const sc = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.36), new THREE.MeshStandardMaterial({ map: cctv, emissiveMap: cctv, emissive: 0xffffff, emissiveIntensity: 0.7 })); sc.position.set(x, 1.05, -3.665); S.add(sc);
      }
    }
    try {
      if (makeRig) {
        this.guard = makeRig();
        this.guard.setSkisVisible?.(false);
        this.guard.addTo(this.scene);
        this.guard.root.position.set(DXk, 0, DZ - 0.85);
        this.guardYaw = 0;
      }
    } catch (e) { console.warn('prison guard', e); this.guard = null; }
    void bars; void x1;
  }

  /** You in the room: role 'jailed' (in cell `cell`) or 'visitor' (in at the exit door). */
  place(role, cell = 1) {
    this.role = role; this.cell = cell;
    const cx = CELLS[cell] ?? 0;
    if (role === 'jailed') {
      this.bounds = [cx - CELL_W / 2 + 0.1 + R, cx + CELL_W / 2 - 0.1 - R, ROOM.z0 + R, ROOM.bars - 0.05 - R];
      this.pos.set(cx + 0.4, 0, -1.4); this.yaw = 0.15; this.pitch = -0.05;
    } else {
      this.bounds = [ROOM.x0 + R, FRONT.x1 - R, ROOM.bars + 0.3 + R, FRONT.z1 - R];
      this.pos.set(EXIT.x - 0.9, 0, EXIT.z); this.yaw = -Math.PI / 2; this.pitch = -0.04;
    }
    this.vel.set(0, 0, 0);
    this.update(0, null);
  }

  walk(dt) {
    const p = this.pos;
    p.x += this.vel.x * dt; p.z += this.vel.z * dt;
    const [ax, bx, az, bz] = this.bounds || [ROOM.x0, ROOM.x1, ROOM.z0, ROOM.z1];
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

  /** Walk / look (input null: a panel or the menu is open). Returns what you look at: { kind, label } or null. */
  update(dt, input, sensitivity = 1) {
    this.t += dt;
    if (input) {
      const sens = 0.0022 * sensitivity;
      this.yaw -= input.mdx * sens;
      this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - input.mdy * sens));
      const fw = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0), st = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const want = new THREE.Vector3(-fz * st + fx * fw, 0, fx * st + fz * fw);
      if (want.lengthSq()) want.normalize().multiplyScalar(input.down('ShiftLeft') ? 3.4 : 2.2);
      this.vel.lerp(want, 1 - Math.exp(-dt * 10));
    } else this.vel.multiplyScalar(Math.exp(-dt * 10));
    this.walk(dt);
    const bob = Math.sin(this.t * 9) * Math.min(1, this.vel.length() / 2.2) * 0.025;
    this.camera.position.set(this.pos.x, EYE + bob, this.pos.z);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(this.camera.position.clone().add(dir));
    // the flickering tube; the window: night blue after dark, pale daylight by day
    if (this.flicker) {
      const f = Math.sin(this.t * 37) > 0.97 || (this.t % 7 < 0.18 && Math.sin(this.t * 83) > 0) ? 0.25 : 1;
      this.flicker.mat.emissiveIntensity = 2.2 * f; this.flicker.L.intensity = this.flicker.I * f;
    }
    const n = nightUniform.value || 0;
    this.winMat.emissive.setRGB(0.5 - 0.4 * n, 0.63 - 0.45 * n, 0.78 - 0.4 * n);
    if (this.viewMat) this.viewMat.color.setRGB(1 - 0.82 * n, 1 - 0.78 * n, 1 - 0.6 * n); // (the snowy view out: dusk, night)
    if (this.plaqueMat) this.plaqueMat.emissiveIntensity = 0.12;
    if (this.crestMat) this.crestMat.emissiveIntensity = 0.35;
    if (this.clock) {
      const d = new Date(), s = d.getSeconds() + d.getMilliseconds() / 1000, m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
      this.clock.s.rotation.z = -(s / 60) * Math.PI * 2; this.clock.m.rotation.z = -(m / 60) * Math.PI * 2; this.clock.h.rotation.z = -(h / 12) * Math.PI * 2;
    }
    // the guard: idle at his desk, an eye on whoever comes near the counter
    if (this.guard) {
      const g = this.guard.root.position, near = Math.hypot(this.pos.x - g.x, this.pos.z - g.z) < 6;
      const want = near ? Math.atan2(this.pos.x - g.x, this.pos.z - g.z) : 0;
      this.guardYaw += Math.atan2(Math.sin(want - this.guardYaw), Math.cos(want - this.guardYaw)) * (1 - Math.exp(-dt * 3));
      try { this.guard.update(dt, { mode: 'idle', heading: this.guardYaw, speed: 0, crouch: 0, lean: 0, plow: 0, normal: UP }); } catch { /* (decor) */ }
    }
    if (!input) return null;
    // what's in front of you: the way out (visitors), the cell door (prisoners)
    if (this.role === 'visitor') {
      const dx = EXIT.x - this.pos.x, dz = EXIT.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d < 2.0 && (dx * dir.x + dz * dir.z) / d > 0.4) return { kind: 'door', label: 'Leave the prison' };
    } else if (this.role === 'jailed') {
      const door = this.doors?.[this.cell];
      if (door && Math.hypot(door.x - this.pos.x, door.z - this.pos.z) < 1.5) return { kind: 'cellDoor', label: 'Cell door · locked' };
    }
    return null;
  }
}

export class Prison {
  /**
   * @param {object} o  scene, renderer, colliders, cameraBlockers, hud, audio, transition, player, save, writeSave,
   *   getPost: () => post, makeRig: () => rig (the guard), clearActivity: () => void (out of vehicles, lifts, shops:
   *   main.js), canStart: () => bool (free roaming: a sentence left over from before starts then)
   */
  constructor(o) {
    Object.assign(this, o);
    this.active = false;   // serving a sentence
    this.inside = false;   // in the prison's scene (jailed or visiting)
    this.role = null;      // 'jailed' | 'visitor'
    this.until = 0;        // when the sentence ends (server ms in multiplayer, Date.now ms in single player)
    this.reason = '';
    this.busy = false;     // a fade under way
    this.door = null;
    this.target = null;
    this.H = busRoads.prison || null;
    this.room = new PrisonRoom({ renderer: o.renderer, makeRig: o.makeRig, models: o.models });
    this.ready = Promise.all([this.room.ready, this.H ? this.buildOutside() : null]).catch((e) => console.warn('prison', e));
  }

  // ------------------------------------------------------------ outside: the station on its lot in the village
  // (game/prisonoutside.js: the alpine POLIZEI house, its forecourt on the road, the colliders, the door's spot)
  async buildOutside() {
    try { policeModelReady(); await loadGLB('police/police_car'); } catch { /* (the patrol car out front: its fallback) */ }
    this.outside3d = buildPrisonOutside(this, this.H);
    this.group = this.outside3d.group;
    this.door = this.outside3d.door;
  }

  // ------------------------------------------------------------ the clock (the server's in multiplayer)
  now() { return isMP() ? net.serverNow() : Date.now(); }
  left() { return this.active ? Math.max(0, (this.until - this.now()) / 1000) : 0; }
  cellIndex() { return isMP() ? (MP.pid >>> 0) % CELLS.length : 1; }

  /** Put the player in a cell for `seconds` (1-300) for `reason`. A sentence while serving one only ever adds time. */
  jail(seconds, reason = 'Arrested', { until = null } = {}) {
    const sec = Math.max(1, Math.min(MAX_SENTENCE, Number(seconds) || 0));
    const now = this.now(), end = until ?? now + sec * 1000;
    const was = this.active;
    this.until = was ? Math.max(this.until, end) : end;
    this.reason = String(reason || 'Arrested').slice(0, 80);
    if (until == null) {
      if (isMP()) {
        net.request('jail', { seconds: sec, reason: this.reason }).then((d) => {
          if (d && Number.isFinite(d.jailUntil)) { this.until = d.jailUntil; if (MP.profile) { MP.profile.jailUntil = d.jailUntil; MP.profile.jailReason = d.reason; } }
        }).catch((e) => console.warn('[mp] jail', e?.code || e));
      } else this.store();
    }
    this.active = true;
    if (was && this.inside && this.role === 'jailed') { this.hud?.flash(`Sentence: ${fmt(this.left())} · ${this.reason}`, 'bad', 2600); return; }
    this.toCell();
  }
  store() {
    if (isMP() || !this.save) return;
    if (this.active) this.save.jail = { until: this.until, reason: this.reason };
    else delete this.save.jail;
    this.writeSave?.();
  }
  toCell() {
    if (this.busy) return; // (update() tries again once the fade under way is done)
    this.busy = true;
    this.player.frozen = true;
    this.audio?.play?.('click');
    this.transition.fade(() => {
      try { this.clearActivity?.(); } catch (e) { console.warn('prison: clear', e); }
      if (!this.active) return; // (served meanwhile)
      this.room.place('jailed', this.cellIndex());
      this.role = 'jailed';
      this.show(true);
      this.player.frozen = true;
    }).catch((e) => console.warn('prison', e)).finally(() => {
      this.busy = false;
      if (this.active && this.inside) this.hud?.flash(`In prison · ${fmt(this.left())} · ${this.reason}`, 'bad', 3200);
    });
  }
  show(on) {
    this.inside = on;
    const post = this.getPost();
    if (on) post.setView(this.room.scene, this.room.camera);
    else post.setView(this.scene, this.camera);
    const ch = document.getElementById('crosshair'); if (ch) ch.hidden = !on;
  }
  /** Out of the door into the village (a fade), the sentence served. */
  release() {
    if (this.busy) return;
    this.active = false;
    this.store();
    if (isMP() && MP.profile) { delete MP.profile.jailUntil; delete MP.profile.jailReason; }
    if (!this.inside) return;
    this.busy = true;
    this.transition.fade(() => this.outside()).catch((e) => console.warn('prison', e)).finally(() => {
      this.busy = false;
      this.hud?.flash('Released', 'good', 2800);
      this.audio?.play?.('board');
    });
  }
  outside() {
    this.show(false);
    this.role = null;
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
    if (!this.door || this.inside || this.active) return null;
    if (Math.hypot(p.x - this.door.x, p.z - this.door.z) < 2.6) return this._prompt ||= { label: 'Visit the prison', act: () => this.visit() };
    return null;
  }
  visit() {
    if (this.busy || this.inside || this.transition.active) return;
    this.busy = true;
    this.player.frozen = true;
    this.audio?.play?.('click');
    this.transition.fade(() => { this.room.place('visitor'); this.role = 'visitor'; this.show(true); })
      .catch((e) => console.warn('prison', e)).finally(() => { this.busy = false; });
  }
  leave() {
    if (this.busy || !this.inside || this.active) return;
    this.busy = true;
    this.audio?.play?.('click');
    this.transition.fade(() => this.outside()).catch((e) => console.warn('prison', e)).finally(() => { this.busy = false; });
  }

  /** Inside, per frame (main.js): walking, looking, E. */
  frame(dt, input, sensitivity) {
    this.target = this.room.update(dt, input, sensitivity);
    if (this.target && input?.hit?.('KeyE')) {
      this.audio?.play?.('click');
      if (this.target.kind === 'door') this.leave();
      else if (this.target.kind === 'cellDoor') this.hud?.flash(`Locked · ${fmt(this.left())} to go`, 'bad', 1800);
    }
    return this.target;
  }
  /** The HUD's objective line inside. */
  hudLine() {
    if (this.active) return `In prison · ${fmt(this.left())} · ${this.reason}`;
    if (this.role === 'visitor') return 'Visiting the prison · the way out: the front door past the counter';
    return '';
  }

  /** Every frame: the countdown, a sentence left over from before (a reload, a login), the cell kept shut. */
  update(dt) {
    const n = nightUniform.value || 0;
    try { this.outside3d?.update(n, performance.now() / 1000); } catch (e) { console.warn('prison outside', e); this.outside3d = null; }
    if (this.inside && !this.active && this.role === 'jailed' && !this.busy) this.release(); // (cleared from elsewhere)
    if (this.active) {
      if (this.now() >= this.until + 300 && !this.busy) { this.release(); return; } // (a moment late: the server's clock rules)
      // not in the cell (a visit when the sentence came, a teleport, a race start...): in you go
      if ((!this.inside || this.role !== 'jailed') && !this.busy && !this.transition.active && this.canStart?.()) this.toCell();
      return;
    }
    // a sentence from before: the server's (multiplayer) or the save's
    if (this.busy || !this.canStart?.()) return;
    let until = 0, reason = '';
    if (isMP()) { const P = MP.profile; if (P?.jailUntil) { until = P.jailUntil; reason = P.jailReason; } }
    else if (this.save?.jail?.until) { until = this.save.jail.until; reason = this.save.jail.reason; }
    if (!until) return;
    const left = (until - this.now()) / 1000;
    if (left > 1) this.jail(left, reason || 'Arrested', { until });
    else if (!isMP()) { delete this.save.jail; this.writeSave?.(); }
  }

  /** Back to the main menu / out of multiplayer: out of the scene at once (a sentence resumes from the save / the
   *  server profile when you play on). */
  reset() {
    if (this.inside) { this.show(false); this.player.frozen = false; }
    this.inside = false; this.role = null; this.active = false; this.busy = false; this.target = null;
  }

  /** The trail map's marker (main.js passes it with the places). */
  mapMarker() { return this.door ? { x: this.door.x, z: this.door.z, label: 'Police / Prison', kind: 'police' } : null; }
}
