// The PRISON: Legacy Village's police station (Polizei) and its cells. Outside: the Meshy station on its own flattened
// lot off the village road (planned with the roads: game/bus/roads.js planPrison), a POLIZEI sign over its door, a
// blue lamp, E at the door: "Visit the prison" (anyone, any time). Inside (its own scene, like the car rental's:
// main.js renders it through post.setView): a visitor corridor along three cells behind real bars (instanced steel
// rods: crisp and see-through), cold fluorescent tubes, a bunk bed and a steel toilet in each cell, the guard's desk,
// a visiting desk; E at the exit door leaves.
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
import { makeSign, standSign, nightUniform } from '../world/village.js';
import { isMP, MP } from '../net/mode.js';
import { net } from '../net/client.js';

export const MAX_SENTENCE = 300; // s (the server's limit too)
const EYE = 1.62, UP = new THREE.Vector3(0, 1, 0), R = 0.26; // eye height, the walker's radius
const STATION_SIZE = 15.5; // the Meshy station's length (its model x, the plaza included), m
// measured on the model (fitted units: its x extent = 1.9): the door in the -x wall (its face at x -0.635), 0.25 toward +z
const DOOR_LOCAL = { z: 0.25, wall: 0.635, unit: STATION_SIZE / 1.9 };

// ---------------------------------------------------------------- the inside: one room, all in metres (floor y 0)
// x: the long axis (the cells at x < 5.4, the guard's office and the way out beyond); z: -4 the cells' back wall,
// -0.4 the bars, +3.6 the corridor's far wall
const ROOM = { x0: -5.4, x1: 9.0, z0: -4.0, bars: -0.4, z1: 3.6, H: 3.3 };
const CELLS = [-3.6, 0, 3.6]; // the cells' middles (each 3.6 m wide)
const CELL_W = 3.6;
const EXIT = { x: 8.95, z: 1.6 };

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
  constructor({ renderer, makeRig }) {
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
    wall(z1 - z0, x1, (z0 + z1) / 2, -Math.PI / 2, 5);  // the right end (the exit door)
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
    for (const [len, x, z, ry] of [[x1 - x0, (x0 + x1) / 2, z1 - 0.01, 0], [z1 - bars, x0 + 0.01, (z1 + bars) / 2, Math.PI / 2], [z1 - bars, x1 - 0.01, (z1 + bars) / 2, Math.PI / 2]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.02), skirt); m.position.set(x, 0.06, z); m.rotation.y = ry; S.add(m);
    }
    // the exit: a steel door with a wired-glass vision panel, a green EXIT sign over it
    const door = new THREE.Group();
    const dm = new THREE.MeshStandardMaterial({ color: 0x4f5d6a, metalness: 0.55, roughness: 0.45 });
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.05, 2.15, 0.06), dm); leaf.position.y = 1.075; door.add(leaf);
    const frame = new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.6, roughness: 0.4 });
    for (const [w, h, x, y] of [[0.08, 2.25, -0.565, 1.125], [0.08, 2.25, 0.565, 1.125], [1.21, 0.08, 0, 2.21]]) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.1), frame); m.position.set(x, y, 0); door.add(m); }
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.5), new THREE.MeshStandardMaterial({ color: 0xbfd2dc, emissive: 0x9fb6c4, emissiveIntensity: 0.6, roughness: 0.2 }));
    pane.position.set(0, 1.55, 0.032); door.add(pane);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.05, 0.06), new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.9, roughness: 0.25 }));
    bar.position.set(0, 1.0, 0.07); door.add(bar);
    const exitSign = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.06), new THREE.MeshBasicMaterial({ map: tex(256, 96, (g, w, h) => {
      g.fillStyle = '#0f8a3c'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = 'bold 60px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('EXIT', w / 2, h / 2 + 3);
    }) }));
    exitSign.position.set(0, 2.45, 0.04); door.add(exitSign);
    door.position.set(x1 - 0.04, 0, EXIT.z); door.rotation.y = -Math.PI / 2;
    door.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    S.add(door);
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
    const bench = place(null, 0, 'x', -0.6, z1 - 0.28, 0, plainBox(2.4, 0.45, 0.42, 0x5f6b72));
    void bench;
    this.obstacles.push([-1.8, 0.6, z1 - 0.5, z1]);
    // the guard's desk in the office beyond the counter, facing the corridor
    place(guard, 1.75, 'x', 7.2, -2.3, Math.PI, plainBox(1.75, 1.0, 0.9, 0x5b4a3a));
    try {
      if (makeRig) {
        this.guard = makeRig();
        this.guard.setSkisVisible?.(false);
        this.guard.addTo(this.scene);
        this.guard.root.position.set(7.2, 0, -3.15);
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
      this.bounds = [ROOM.x0 + R, ROOM.x1 - R, ROOM.bars + 0.3 + R, ROOM.z1 - R];
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
    this.room = new PrisonRoom({ renderer: o.renderer, makeRig: o.makeRig });
    this.ready = Promise.all([this.room.ready, this.H ? this.buildOutside() : null]).catch((e) => console.warn('prison', e));
  }

  // ------------------------------------------------------------ outside: the station on its lot in the village
  async buildOutside() {
    const H = this.H, s = DOOR_LOCAL.unit, g = new THREE.Group();
    g.name = 'prison';
    g.position.set(H.x, H.y - 0.05, H.z);
    g.rotation.y = H.facing + Math.PI / 2; // (the model's -x side, its door, toward the road)
    const gltf = await loadGLB('prison/prison_station');
    const m = gltf ? fitModel(gltf, { size: STATION_SIZE, axis: 'x' }) : this.fallbackStation();
    m.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    g.add(m);
    // the POLIZEI board over the door, a blue lamp beside it
    const sign = makeSign('POLIZEI', { w: 2.4, h: 0.6, bg: '#0d3a7a', fg: '#ffffff', border: '#dfe8f5', font: 'bold 150px Arial' });
    sign.position.set(-DOOR_LOCAL.wall * s - 0.07, 4.3, DOOR_LOCAL.z * s); sign.rotation.y = -Math.PI / 2;
    g.add(sign);
    this.signMat = sign.userData.faceMaterial;
    // over the model's blank board right of the door: the prison's plaque
    const plaque = makeSign('GEFÄNGNIS\nPRISON · visits', { w: 1.05, h: 0.62, bg: '#f4f1e8', fg: '#14263f', border: '#14263f', font: 'bold 120px Arial' });
    plaque.position.set(-DOOR_LOCAL.wall * s - 0.06, 2.6, DOOR_LOCAL.z * s + 1.85); plaque.rotation.y = -Math.PI / 2;
    g.add(plaque);
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x3d7bff, emissive: 0x2a63ff, emissiveIntensity: 1.2, roughness: 0.3 });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.34, 0.22), this.lampMat);
    lamp.position.set(-DOOR_LOCAL.wall * s - 0.16, 2.9, DOOR_LOCAL.z * s - 1.25); g.add(lamp);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.28), new THREE.MeshStandardMaterial({ color: 0x222, metalness: 0.6, roughness: 0.4 }));
    cap.position.copy(lamp.position).y += 0.2; g.add(cap);
    this.scene.add(g);
    this.group = g;
    g.updateMatrixWorld(true);
    const w = (lx, lz) => { const v = new THREE.Vector3(lx, 0, lz).applyMatrix4(g.matrixWorld); return { x: v.x, z: v.z }; };
    const d = w(-DOOR_LOCAL.wall * s - 1.1, DOOR_LOCAL.z * s);
    this.door = { x: d.x, z: d.z, yaw: H.facing };
    // solid: the house (a little inside its walls), the plaza's lamp posts; the camera does not pass through it
    this.colliders.push({ x: H.x, z: H.z, hw: DOOR_LOCAL.wall * s * 0.96, hd: 0.58 * s, rot: -g.rotation.y });
    for (const sz of [-1, 1]) { const p = w(0.82 * s, 0.755 * s * sz); this.colliders.push({ x: p.x, z: p.z, r: 0.3 }); }
    this.cameraBlockers?.push(m);
    // a signpost by the path from the road
    const f = { x: Math.sin(H.facing), z: Math.cos(H.facing) }, side = { x: f.z, z: -f.x };
    const sp = { x: this.door.x + f.x * 5.5 + side.x * 3.2, z: this.door.z + f.z * 5.5 + side.z * 3.2 };
    try {
      const post = makeSign('POLICE · PRISON\nVisitors welcome', { w: 2.4, h: 0.9, bg: '#0d3a7a', fg: '#ffffff', border: '#dfe8f5', font: 'bold 100px Arial', posts: true, postH: 1.1, pole: this.models?.sign_pole });
      this.scene.add(standSign(post, sp.x, sp.z, H.facing + 0.4));
      this.postMat = post.userData.faceMaterial;
      this.colliders.push({ x: sp.x, z: sp.z, r: 0.8 });
    } catch (e) { console.warn('prison sign', e); }
  }
  // (no model: a plain stone-and-timber block of the same size)
  fallbackStation() {
    const s = DOOR_LOCAL.unit, g = new THREE.Group(), W = DOOR_LOCAL.wall * 2 * s;
    const stone = new THREE.Mesh(new THREE.BoxGeometry(W, 4.4, W), new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.9 }));
    stone.position.y = 2.2; g.add(stone);
    const wood = new THREE.Mesh(new THREE.BoxGeometry(W, 3.6, W), new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.8 }));
    wood.position.y = 6.2; g.add(wood);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(W * 0.8, 3.2, 4), new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.8 }));
    roof.position.y = 9.6; roof.rotation.y = Math.PI / 4; g.add(roof);
    g.userData.size = new THREE.Vector3(W, 11, W);
    return g;
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
    if (this.role === 'visitor') return 'Visiting the prison · the exit door is at the end of the corridor';
    return '';
  }

  /** Every frame: the countdown, a sentence left over from before (a reload, a login), the cell kept shut. */
  update(dt) {
    const n = nightUniform.value || 0;
    if (this.signMat) this.signMat.emissiveIntensity = 0.1 + 0.6 * n;
    if (this.postMat) this.postMat.emissiveIntensity = 0.05 + 0.3 * n;
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.8 + 2.2 * n * (0.75 + 0.25 * Math.sin(performance.now() / 260));
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
