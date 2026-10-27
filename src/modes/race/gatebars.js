// Gate bars: a glowing green ribbon strung between the two flags of every gate you must pass through
// (World Racing slalom / GS / super-G gates, open-world race gates), knee high so it reads from a skier's
// low view well up the slope: the opening is exactly where the green is. The next gate's ribbon pulses;
// once you are through a gate its ribbon turns grey, a missed one turns red. Unlit (it glows by night
// and stands out against white snow and red nets by day), striped like barrier tape, fogged with the
// world. One merged mesh: the states are vertex colours.
//
//   const bars = new GateBars(scene, [{ ax, az, bx, bz }]);   // the two poles of each gate, in course order
//   bars.next(i); bars.set(i, 'passed' | 'missed' | 'ahead'); bars.update(dt); bars.dispose();
import * as THREE from 'three';
import { drawnHeight } from '../../world/settle.js';

const LOW = 0.36, HIGH = 0.68;  // m above the snow: the ribbon's lower and upper edge (knee high)
const INSET = 0.05;             // m short of each pole
const STRIPE = 0.9;             // m per stripe pair along the ribbon
const COLORS = {
  ahead: new THREE.Color('#29d36a'),
  next: new THREE.Color('#5dff8f'),
  passed: new THREE.Color('#8e959e'),
  missed: new THREE.Color('#ff3b30'),
};

let tex = null;
function tapeTexture() {
  if (tex || typeof document === 'undefined') return tex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#c4d2c6';
  for (let x = -32; x < 160; x += 64) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 32, 0); g.lineTo(x + 64, 0); g.lineTo(x + 32, 32); g.fill(); }
  g.fillStyle = '#7f8c82'; g.fillRect(0, 0, 128, 3); g.fillRect(0, 29, 128, 3); // darker hems
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export class GateBars {
  /**
   * @param {THREE.Scene} scene
   * @param {Array<{ax:number, az:number, bx:number, bz:number}>} gates  pole A and pole B of each gate
   */
  constructor(scene, gates) {
    this.scene = scene;
    this.n = gates.length;
    const P = new Float32Array(this.n * 4 * 3), UV = new Float32Array(this.n * 4 * 2), C = new Float32Array(this.n * 4 * 3);
    const I = [];
    gates.forEach((q, i) => {
      const dx = q.bx - q.ax, dz = q.bz - q.az, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
      const x0 = q.ax + ux * INSET, z0 = q.az + uz * INSET, x1 = q.bx - ux * INSET, z1 = q.bz - uz * INSET;
      const y0 = drawnHeight(x0, z0), y1 = drawnHeight(x1, z1);
      const L = Math.max(0.5, len - 2 * INSET) / STRIPE;
      const v = [[x0, y0 + LOW, z0, 0, 0], [x1, y1 + LOW, z1, L, 0], [x0, y0 + HIGH, z0, 0, 1], [x1, y1 + HIGH, z1, L, 1]];
      v.forEach(([x, y, z, u, w], k) => { P.set([x, y, z], (i * 4 + k) * 3); UV.set([u, w], (i * 4 + k) * 2); });
      const b = i * 4;
      I.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    this.colors = new THREE.BufferAttribute(C, 3);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', this.colors);
    geo.setIndex(I);
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tapeTexture(), vertexColors: true, side: THREE.DoubleSide, fog: true }));
    this.mesh.name = 'gate-bars';
    this.mesh.frustumCulled = false; // one mesh along the whole course
    this.state = new Array(this.n).fill('ahead');
    this.nextI = -1;
    this.t = 0;
    for (let i = 0; i < this.n; i++) this.paint(i, COLORS.ahead);
    scene.add(this.mesh);
  }

  paint(i, c, k = 1) {
    const A = this.colors.array;
    for (let v = 0; v < 4; v++) { const o = (i * 4 + v) * 3; A[o] = c.r * k; A[o + 1] = c.g * k; A[o + 2] = c.b * k; }
    this.colors.needsUpdate = true;
  }

  /** 'ahead' | 'passed' | 'missed' for gate i. */
  set(i, state) {
    if (i < 0 || i >= this.n || !COLORS[state]) return;
    this.state[i] = state;
    this.paint(i, COLORS[state]);
  }

  /** The gate to ski for next (pulses); -1 = none. */
  next(i) {
    if (i === this.nextI) return;
    if (this.nextI >= 0 && this.nextI < this.n) this.paint(this.nextI, COLORS[this.state[this.nextI]]);
    this.nextI = i >= 0 && i < this.n && this.state[i] === 'ahead' ? i : -1;
  }

  /** Every gate green again (a restart). */
  reset() {
    for (let i = 0; i < this.n; i++) this.set(i, 'ahead');
    this.nextI = -1;
  }

  update(dt) {
    this.t += dt;
    const i = this.nextI;
    if (i >= 0 && i < this.n && this.state[i] === 'ahead') this.paint(i, COLORS.next, 0.82 + 0.18 * Math.sin(this.t * 7));
  }

  set visible(v) { this.mesh.visible = !!v; }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
