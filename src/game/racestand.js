// The RACING stand in Legacy Village (Oct 27, the user: "move race into a stand like jobs so there's no choose
// mode anymore ... racing is still accessible if you just want to play racing for fun"): the job board's Meshy
// notice board a few metres beside the village job board, with a RACING header plank, a race poster on its face
// and a red and a blue gate flag either side. E in front of it opens the stand (ui/racestand.js): pick a course
// and the AI difficulty, then the same RACE as the old menu option (vs 14 AI, teleport to the course). Just for
// fun: RACE pays nothing; races for money are the free-ride races at the courses' start houses.
// Placement uses the job sites' own rules (game/jobs/sites.js boardOk: level ground, clear of colliders, not on a
// run or under a lift) and keeps clear of the village job board and its reading spot.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { fitModel } from '../core/assets.js';
import { BOARD } from './jobs/props.js';
import { edgeDist } from './jobs/sites.js';

const READ_R = 2.3; // read the stand from in front of it (like a job board)

// canvas sign: dark race-office blue, white italic lettering (the house's race look)
function signTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function headerTex() {
  return signTex(1024, 314, (g, W, H) => {
    g.fillStyle = '#13348f'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#d8231a'; g.fillRect(0, H - 54, W, 54);
    g.strokeStyle = '#ffffff'; g.lineWidth = 10; g.strokeRect(14, 14, W - 28, H - 28);
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'italic bold 158px "Arial Narrow", Arial, sans-serif';
    if ('letterSpacing' in g) g.letterSpacing = '18px';
    g.fillText('RACING', W / 2 + 9, 126);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    g.font = 'bold 34px Arial, sans-serif';
    g.fillText('JUST FOR FUN · NO PRIZE MONEY', W / 2, H - 27);
  });
}
function posterTex() {
  return signTex(768, 512, (g, W, H) => {
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0b3593'); sky.addColorStop(0.55, '#3a74db'); sky.addColorStop(1, '#eaf1fc');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    // a snowy slope with slalom gates
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(0, H * 0.5); g.bezierCurveTo(W * 0.4, H * 0.48, W * 0.7, H * 0.7, W, H * 0.62); g.lineTo(W, H); g.lineTo(0, H); g.fill();
    const gates = [[150, 300, '#d8231a'], [300, 340, '#1f55e0'], [470, 390, '#d8231a'], [620, 440, '#1f55e0']];
    for (const [x, y, c] of gates) {
      g.fillStyle = c; g.fillRect(x - 3, y - 70, 6, 70);
      g.beginPath(); g.moveTo(x + 3, y - 70); g.lineTo(x + 48, y - 56); g.lineTo(x + 3, y - 40); g.fill();
    }
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'italic bold 96px "Arial Narrow", Arial, sans-serif';
    g.fillText('RACE DAY', W / 2, 92);
    g.font = 'bold 34px Arial, sans-serif';
    g.fillText('8 COURSES · 14 AI RIVALS', W / 2, 168);
    g.fillStyle = '#13348f';
    g.font = 'italic bold 36px Arial, sans-serif';
    g.fillText('Press E · pick a course', W / 2, H - 40);
  });
}

// a slalom gate flag on a pole (stand-alone: 1.9 m)
function gateFlag(color) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.9, 8), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
  pole.position.y = 0.95;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.46), new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide }));
  flag.position.set(0.32, 1.6, 0);
  for (const m of [pole, flag]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
  return g;
}

export class RaceStand {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.models   the loaded GLTFs (job_board)
   * @param {object} o.jobs     game/jobs.js (its sites and the village board)
   * @param {object[]} o.colliders
   * @param {() => void} o.open   E at the stand
   */
  constructor({ scene, models, jobs, colliders, open }) {
    this.open = open;
    this.spot = null;
    this.group = null;
    try {
      jobs.recheckBoards?.(); // the village board settles first (props built after the job sites may have moved it)
      this.spot = this.place(jobs);
    } catch (e) { console.warn('Racing stand: no spot', e); }
    if (!this.spot) return;
    const { x, z, yaw } = this.spot;
    colliders.push(this.spot.collider);
    jobs.sites?.obst?.add(this.spot.collider);
    // the two gate flags' poles either side of the board (build(): local x ±1.45, z 0.3)
    for (const lx of [-1.45, 1.45]) colliders.push({ x: x + lx * Math.cos(yaw) + 0.3 * Math.sin(yaw), z: z - lx * Math.sin(yaw) + 0.3 * Math.cos(yaw), r: 0.12 });
    try { this.group = this.build(models); } catch (e) { console.warn('Racing stand: build failed', e); }
    if (!this.group) return;
    const fx = Math.cos(yaw) * 0.72, fz = -Math.sin(yaw) * 0.72;
    const gh = (a, b) => Math.min(world.height(a, b), world.meshHeight(a, b)); // (the exact ground or the drawn snow, the lower)
    this.group.position.set(x, Math.min(gh(x + fx, z + fz), gh(x - fx, z - fz), gh(x, z)) - 0.03, z);
    this.group.rotation.y = yaw;
    this.group.updateMatrixWorld(true);
    scene.add(this.group);
  }

  // beside the village job board (same facing), else around the plaza edge facing the village centre
  place(jobs) {
    const sites = jobs.sites, hub = jobs.boardById?.('village')?.hub;
    if (!sites) return null;
    const cands = [];
    if (hub) {
      const rx = Math.cos(hub.yaw), rz = -Math.sin(hub.yaw);
      for (const d of [5.5, -5.5, 7, -7, 8.5, -8.5, 10, -10]) cands.push([hub.x + rx * d, hub.z + rz * d, hub.yaw]);
    }
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2 + 0.13, r = 20 + (a % 3) * 4;
      const x = Math.cos(ang) * r, z = -4 + Math.sin(ang) * r;
      cands.push([x, z, Math.atan2(-x, -4 - z)]);
    }
    for (const [x, z, yaw] of cands) {
      if (!sites.boardOk(x, z, yaw)) continue;
      const collider = { x, z, hw: BOARD.halfW, hd: 0.2, rot: -yaw };
      const front = { x: x + Math.sin(yaw) * 1.1, z: z + Math.cos(yaw) * 1.1 };
      if (hub) {
        // keep the job board's own spot valid (its edges and its reading spot) and the two prompts apart
        const hx = Math.cos(hub.yaw) * BOARD.halfW, hz = -Math.sin(hub.yaw) * BOARD.halfW;
        const pts = [[hub.x + hx, hub.z + hz], [hub.x - hx, hub.z - hz], [hub.x + Math.sin(hub.yaw) * 1.4, hub.z + Math.cos(hub.yaw) * 1.4]];
        if (pts.some(([px, pz]) => edgeDist(collider, px, pz) < 1)) continue;
        if (Math.hypot(front.x - hub.front.x, front.z - hub.front.z) < READ_R * 2 + 0.3) continue;
      }
      return { x, z, yaw, front, collider };
    }
    return null;
  }

  build(models) {
    const g = new THREE.Group();
    g.name = 'racing-stand';
    const gltf = models?.job_board;
    let faceZ = 0.2, beamZ = 0.2;
    if (gltf?.scene) {
      const m = fitModel(gltf, { size: 2.6, axis: 'y' });
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.add(m);
      m.updateMatrixWorld(true);
      // the model faces +z: find the front of the beam under the roof and of the notice face
      const hit = (y) => new THREE.Raycaster(new THREE.Vector3(0, y, 3), new THREE.Vector3(0, 0, -1), 0, 6).intersectObject(m, true)[0];
      const hb = hit(2.0), hf = hit(1.45);
      if (hb) beamZ = hb.point.z + 0.015;
      if (hf) faceZ = hf.point.z + 0.02;
    } else {
      // (no model: two posts and a plain panel)
      const wood = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 });
      for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.3, 0.1), wood); p.position.set(s * 0.8, 1.15, 0); g.add(p); }
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.62, 1.2, 0.06), wood);
      panel.position.set(0, 1.5, 0); g.add(panel);
      faceZ = 0.05; beamZ = 0.05;
    }
    const sign = (tex, w, h, y, z) => {
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.08 });
      mat.userData.isSign = true;
      const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      s.position.set(0, y, z);
      s.receiveShadow = true;
      g.add(s);
    };
    sign(headerTex(), 0.98, 0.3, 2.0, beamZ);
    sign(posterTex(), 1.26, 0.84, 1.45, faceZ);
    // a red and a blue gate flag either side: it reads as racing from across the plaza
    const red = gateFlag(0xd8231a), blue = gateFlag(0x1f55e0);
    red.position.set(-1.45, 0, 0.3); red.rotation.y = 0.5;
    blue.position.set(1.45, 0, 0.3); blue.rotation.y = Math.PI - 0.5;
    g.add(red, blue);
    return g;
  }

  /** E prompt in front of the stand (main.js findInteraction). */
  interaction(p) {
    const f = this.spot?.front;
    if (!f || Math.hypot(p.x - f.x, p.z - f.z) > READ_R) return null;
    return { label: 'Racing · just for fun', act: () => this.open?.() };
  }

  /** Where a fun race brings you back: in front of the stand, facing it. */
  returnPoint() {
    const s = this.spot;
    if (!s) return null;
    const x = s.x + Math.sin(s.yaw) * 2.2, z = s.z + Math.cos(s.yaw) * 2.2;
    return { x, z, heading: s.yaw + Math.PI };
  }

  /** Trail map / waypoint marker. */
  marker() { return this.spot ? { x: this.spot.x, z: this.spot.z, kind: 'race', label: 'Racing' } : null; }
}
