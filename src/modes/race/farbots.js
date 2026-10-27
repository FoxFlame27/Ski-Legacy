// Far racers: one instanced draw of small racer figures for the AI racers far from the camera (a few
// pixels tall there). A full skinned rig with IK costs a skinning pass and a pose solve per racer; beyond
// FAR_IN metres the session hides the rig and shows its stand-in here instead (back to the rig inside
// FAR_OUT: hysteresis, no flicker at the switch). Same look as the distant piste skiers (src/game/npcs.js):
// dark skis and legs, the suit in the racer's colour, a white helmet; leaning into the turns, tucked.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const FAR_IN = 150, FAR_OUT = 135; // m: rig -> stand-in beyond FAR_IN, back to the rig inside FAR_OUT

// suit colours of the racer outfits (the white parts of the figure take the instance colour)
const SUIT = {
  skier_blue: '#1f5ad6', skier_red: '#d7263d', skier_green: '#2a9d4f', skier_orange: '#f08a24',
  skier_black: '#22252b', skier_purple: '#7b2cbf',
};
const FALLBACK = ['#d7263d', '#1546c8', '#f6ae2d', '#2a9d8f', '#ffffff', '#111111', '#e76f51', '#7b2cbf', '#ff6b9a', '#3a86ff'];

function figure() {
  const parts = [];
  const box = (w, h, d, x, y, z, color, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  // a racer in a tuck-ish stance: skis, bent legs, torso pitched forward, helmet (facing +Z)
  box(0.09, 0.03, 1.75, -0.12, 0.02, 0.12, '#30343c'); box(0.09, 0.03, 1.75, 0.12, 0.02, 0.12, '#30343c');
  box(0.13, 0.62, 0.16, -0.12, 0.36, 0.1, '#ffffff', -0.35); box(0.13, 0.62, 0.16, 0.12, 0.36, 0.1, '#ffffff', -0.35);
  box(0.42, 0.58, 0.3, 0, 0.95, 0.2, '#ffffff', 0.55);
  box(0.24, 0.25, 0.26, 0, 1.27, 0.45, '#eef1f5');
  const geo = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return geo;
}

export class FarRacers {
  /**
   * @param {THREE.Scene} scene
   * @param {string[]} chars  character id of each racer (instance i = racer i)
   */
  constructor(scene, chars) {
    this.scene = scene;
    this.n = chars.length;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(figure(), mat, Math.max(1, this.n));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'far-racers';
    this.mesh.count = 0;
    const c = new THREE.Color();
    chars.forEach((id, i) => this.mesh.setColorAt(i, c.set(SUIT[id] || FALLBACK[i % FALLBACK.length])));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.colors = chars.map((id, i) => SUIT[id] || FALLBACK[i % FALLBACK.length]);
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._lq = new THREE.Quaternion();
    this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._ax = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0); this._c = new THREE.Color();
  }

  /** Start a frame: no stand-ins yet. */
  begin() { this.k = 0; }

  /** Show racer `i`'s stand-in at pos, facing `heading`, leaning `lean` (-1..1, + = into a left turn). */
  put(i, pos, heading, lean = 0) {
    const k = this.k++;
    if (k >= this.n) return;
    this._q.setFromAxisAngle(this._up, heading);
    this._ax.set(Math.sin(heading), 0, Math.cos(heading));
    this._q.premultiply(this._lq.setFromAxisAngle(this._ax, -lean * 0.45));
    this._m.compose(this._p.copy(pos), this._q, this._s);
    this.mesh.setMatrixAt(k, this._m);
    // instance k shows racer i: its colour follows it
    this.mesh.setColorAt(k, this._c.set(this.colors[i] || '#ffffff'));
  }

  /** End the frame: upload what was put. */
  end() {
    this.mesh.count = Math.min(this.k, this.n);
    if (this.mesh.count) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose?.();
  }
}
