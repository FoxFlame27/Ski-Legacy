// Race podium: after the field is home, the top three stand on a procedural podium in the finish
// run-out (house style: white blocks, blue italic 1/2/3, red trim on a blue plinth) facing down the
// run-out, with the finish arch and the course behind them. Confetti cannons and a burst of snow, a
// slow broadcast orbit and a lower third with the top three; then the results screen comes up over
// it (the scene holds behind the results until the session moves on).
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { lerp, smoothstep } from '../../core/noise.js';
import { applyCamera, ground, poseRig, showRig, ease, UP } from './cinecam.js';

const SHOW = 6.2;             // s of the podium before the results screen
const BLOCK = [               // place: x (viewer's left = -x), height
  null, { x: 0, h: 1.05 }, { x: -1.78, h: 0.74 }, { x: 1.78, h: 0.5 },
];
const BW = 1.66, BD = 1.7;    // block width / depth
const CONFETTI = 360;
const BLUE = '#1546c8', RED = '#ff4d3d';

let fontReady = null;
function loadFont() {
  if (fontReady) return fontReady;
  fontReady = typeof document !== 'undefined' && document.fonts?.load
    ? document.fonts.load('italic 700 200px "Barlow Condensed"').catch(() => {})
    : Promise.resolve();
  return fontReady;
}

// Block front: white, a red stripe along the top, the place in big blue italic Barlow Condensed.
function frontTexture(place) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const draw = () => {
    g.fillStyle = '#f5f8fe';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = RED;
    g.fillRect(0, 0, 256, 14);
    g.fillStyle = BLUE;
    g.font = 'italic 700 190px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(String(place), 122, 216);
    tex.needsUpdate = true;
  };
  draw();
  loadFont().then(draw);
  return tex;
}

export class Podium {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.track      race Track (frame(s), finishS)
   * @param {THREE.Camera} o.camera
   * @param {Array<{rig: object, name: string, time: string, me: boolean}>} o.top  1st..3rd
   * @param {object[]} [o.hide]   rigs that step out of the picture
   * @param {object} [o.spray]    snow spray particles (emit(pos, vel, count, spread, size, life))
   * @param {object} [o.ui]
   * @param {object} [o.info]     lower third ({ kicker, title, rows })
   * @param {object} [o.audio]
   */
  constructor(o) {
    Object.assign(this, o);
    this.t = 0;
    this.phase = 'show'; // show (skippable) -> hold (behind the results) -> disposed
    this.build();
  }

  build() {
    const tr = this.track;
    const fr = tr.frame(tr.finishS + 7, {});
    // the podium faces down the run-out: the camera looks back up at it, the finish arch behind
    this.heading = fr.h;
    const fx = Math.sin(fr.h), fz = Math.cos(fr.h);
    this.fwd = new THREE.Vector3(fx, 0, fz);
    this.right = new THREE.Vector3(-fz, 0, fx); // across the podium (the viewer's left when looking back up at it)
    let gy = -Infinity;
    for (const [dx, dz] of [[0, 0], [-2.6, -0.9], [2.6, -0.9], [-2.6, 0.9], [2.6, 0.9]]) {
      gy = Math.max(gy, ground(fr.x + this.right.x * dx + fx * dz, fr.z + this.right.z * dx + fz * dz, fr.y + 4));
    }
    this.base = new THREE.Vector3(fr.x, gy, fr.z);

    const g = this.group = new THREE.Group();
    g.name = 'race-podium';
    g.position.copy(this.base);
    g.rotation.y = fr.h; // local +z = down the run-out (toward the camera)
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f5fb, roughness: 0.55, metalness: 0 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x1546c8, roughness: 0.5, metalness: 0.05 });
    const red = new THREE.MeshStandardMaterial({ color: 0xff4d3d, roughness: 0.5, metalness: 0 });
    this.mats = [white, blue, red];
    this.geos = [];
    this.texs = [];
    const box = (w, h, d) => { const b = new THREE.BoxGeometry(w, h, d); this.geos.push(b); return b; };
    // blue plinth, a little wider than the blocks, sunk into the snow
    const plinth = new THREE.Mesh(box(BW * 3 + 0.9, 0.42, BD + 0.7), blue);
    plinth.position.y = -0.11;
    g.add(plinth);
    const lift = 0.1; // plinth top
    this.tops = [];
    for (let place = 1; place <= 3; place++) {
      const B = BLOCK[place];
      const tex = frontTexture(place);
      this.texs.push(tex);
      const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
      this.mats.push(face);
      // BoxGeometry faces: +x, -x, +y, -y, +z (front), -z
      const m = new THREE.Mesh(box(BW, B.h, BD), [white, white, white, white, face, white]);
      m.position.set(B.x, lift + B.h / 2, 0); // the viewer looks along local -z: local -x is on their left
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      // red band around the top edge (just under the white top face)
      const trim = new THREE.Mesh(box(BW + 0.024, 0.06, BD + 0.024), red);
      trim.position.set(B.x, lift + B.h - 0.036, 0);
      g.add(trim);
      this.tops[place] = new THREE.Vector3(B.x, lift + B.h, 0.05);
    }
    this.scene.add(g);
    g.updateMatrixWorld(true);
    // world positions of the three standing spots
    this.spots = this.tops.map((p) => p && p.clone().applyMatrix4(g.matrixWorld));
    // the blocks (and the plinth) are walkable surfaces while the podium stands: the riders' feet plant
    // on the block tops instead of reaching down to the snow underneath
    this.surfaces = [];
    const surf = (x, w, d, top) => {
      const c = new THREE.Vector3(x, 0, 0).applyMatrix4(g.matrixWorld);
      const cs = Math.cos(fr.h), sn = Math.sin(fr.h), y = this.base.y + top, r = Math.hypot(w, d) / 2 + 0.1;
      const S = {
        bounds: { minx: c.x - r, maxx: c.x + r, minz: c.z - r, maxz: c.z + r },
        height: (px, pz) => {
          const dx = px - c.x, dz = pz - c.z;
          const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; // into the podium's local frame
          return Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2 ? y : null;
        },
      };
      world.addSurface(S);
      this.surfaces.push(S);
    };
    surf(0, BW * 3 + 0.9, BD + 0.7, 0.1);
    for (let place = 1; place <= 3; place++) surf(BLOCK[place].x, BW, BD, 0.1 + BLOCK[place].h);
    this.buildConfetti();
    this.shown = new Set();
  }

  buildConfetti() {
    const geo = new THREE.PlaneGeometry(0.09, 0.15);
    this.geos.push(geo);
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.45, metalness: 0.15 });
    this.mats.push(mat);
    const mesh = this.confetti = new THREE.InstancedMesh(geo, mat, CONFETTI);
    mesh.frustumCulled = false;
    const cols = [0x1546c8, 0xff4d3d, 0xffffff, 0xffcb5c, 0x1546c8, 0xffffff];
    const col = new THREE.Color();
    this.cf = [];
    for (let i = 0; i < CONFETTI; i++) {
      col.setHex(cols[i % cols.length]);
      mesh.setColorAt(i, col);
      this.cf.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), ax: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), a: Math.random() * 6, w: 4 + Math.random() * 8, ph: Math.random() * 6.28, born: Infinity });
    }
    mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(1, 1, 1);
    this.hideAll();
  }

  hideAll() {
    const z = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < CONFETTI; i++) this.confetti.setMatrixAt(i, z);
    this.confetti.instanceMatrix.needsUpdate = true;
  }

  // Two cannons at the podium's sides fire up and inward; a third of the pieces rain from above.
  fire(t) {
    const b = this.base, r = this.right, f = this.fwd;
    this.cf.forEach((c, i) => {
      const k = i % 3;
      c.born = t + (i / CONFETTI) * 0.5;
      if (k === 2) {
        c.p.set(b.x + r.x * (Math.random() - 0.5) * 7 + f.x * (Math.random() - 0.3) * 4, b.y + 6 + Math.random() * 3, b.z + r.z * (Math.random() - 0.5) * 7 + f.z * (Math.random() - 0.3) * 4);
        c.v.set(0, -0.5, 0);
      } else {
        const s = k === 0 ? -1 : 1;
        c.p.set(b.x + r.x * s * 3.4, b.y + 0.4, b.z + r.z * s * 3.4);
        const up = 9 + Math.random() * 4, inward = 2.2 + Math.random() * 2.6, out = (Math.random() - 0.3) * 2.4;
        c.v.set(-r.x * s * inward + f.x * out + (Math.random() - 0.5), up, -r.z * s * inward + f.z * out + (Math.random() - 0.5));
      }
    });
    // snow kicked up off the blocks
    if (this.spray) {
      const v = new THREE.Vector3(0, 2.4, 0);
      for (let place = 1; place <= 3; place++) {
        const s = this.spots[place];
        if (s) this.spray.emit(s, v, 60, 1.6, 0.3, 1.4);
      }
      for (const s of [-1, 1]) this.spray.emit(new THREE.Vector3(b.x + r.x * s * 3.4, b.y + 0.3, b.z + r.z * s * 3.4), new THREE.Vector3(-r.x * s * 1.5, 4, -r.z * s * 1.5), 90, 1.8, 0.35, 1.6);
    }
    this.audio?.play?.('chime');
  }

  updateConfetti(dt, t) {
    const m = this._m, q = this._q, sc = this._s;
    const zero = this._zero || (this._zero = new THREE.Matrix4().makeScale(0, 0, 0));
    for (let i = 0; i < CONFETTI; i++) {
      const c = this.cf[i];
      if (t < c.born) { this.confetti.setMatrixAt(i, zero); continue; }
      // light pieces: strong air drag, fluttering sideways while they fall
      const drag = Math.exp(-dt * 2.6);
      c.v.x *= drag; c.v.z *= drag;
      c.v.y = c.v.y * Math.exp(-dt * 1.2) - 9.8 * dt * 0.55;
      if (c.v.y < -1.4) c.v.y = -1.4;
      const fl = Math.sin(t * 3.1 + c.ph) * 0.9;
      c.p.x += (c.v.x + fl * this.right.x) * dt;
      c.p.y += c.v.y * dt;
      c.p.z += (c.v.z + fl * this.right.z) * dt;
      const gy = this.base.y + 0.02;
      if (c.p.y < gy) { c.p.y = gy; c.v.set(0, 0, 0); }
      else c.a += c.w * dt;
      q.setFromAxisAngle(c.ax, c.a);
      m.compose(c.p, q, sc);
      this.confetti.setMatrixAt(i, m);
    }
    this.confetti.instanceMatrix.needsUpdate = true;
  }

  skip() {
    if (this.phase !== 'show') return;
    this.phase = 'hold';
    this.ui?.hideLowerThird();
    this.ui?.skipHint(null);
  }

  /**
   * Per frame (real dt). Poses the riders, the confetti and the camera. Returns true while the
   * skippable podium part runs (false once it is time for the results; the scene keeps updating).
   */
  update(dt) {
    if (this.phase === 'disposed') return false;
    const t0 = this.t;
    this.t += dt;
    const t = this.t;
    if (t0 === 0) {
      this.fire(0.15);
      if (this.info) this.ui?.lowerThird(this.info);
      this.ui?.skipHint('SKIP');
    }
    if (this.phase === 'show' && t >= SHOW) this.skip();
    // riders standing on their blocks, facing the camera side
    for (const r of this.hide || []) showRig(r, false);
    for (let place = 1; place <= 3; place++) {
      const r = this.top[place - 1];
      const s = this.spots[place];
      if (!r?.rig || !s) continue;
      if (!this.shown.has(r.rig)) {
        this.shown.add(r.rig);
        r.rig.setSkisVisible?.(false);
        r.rig.setCarry?.(false);
        r.rig.snapPose?.();
      }
      showRig(r.rig, true);
      const st = r.st || (r.st = { mode: 'idle', speed: 0, crouch: 0, lean: 0, edge: 0, plow: 0, tuck: false, air: false, normal: UP, fp: false, carry: false });
      // a gentle sway: the winner turns a little to each side of the crowd
      st.heading = this.heading + (place === 1 ? 0.18 * Math.sin(t * 0.7) : place === 2 ? 0.22 : -0.22);
      poseRig(r.rig, s.x, s.y, s.z, dt, st);
    }
    this.updateConfetti(dt, t);
    this.updateCamera(t);
    return this.phase === 'show';
  }

  updateCamera(t) {
    const b = this.base, f = this.fwd, r = this.right;
    const k = ease(Math.min(1, t / SHOW));
    // a slow orbit across the front of the podium; it keeps drifting (slower) behind the results
    const drift = t > SHOW ? (t - SHOW) * 0.03 : 0;
    const a = lerp(-0.62, 0.5, k) + drift;
    const R = lerp(10.5, 8, k) - Math.min(1.5, drift * 4);
    const pos = this._cp || (this._cp = new THREE.Vector3());
    const look = this._cl || (this._cl = new THREE.Vector3());
    pos.set(b.x + (f.x * Math.cos(a) + r.x * Math.sin(a)) * R, b.y + lerp(1.55, 2.3, k), b.z + (f.z * Math.cos(a) + r.z * Math.sin(a)) * R);
    pos.y = Math.max(pos.y, ground(pos.x, pos.z, pos.y + 3) + 1.2);
    look.set(b.x, b.y + lerp(2.1, 1.9, smoothstep(0, 1, k)), b.z);
    // frame the podium right of centre (the lower third sits bottom left): aim a little to its left
    const dx = look.x - pos.x, dz = look.z - pos.z, dl = Math.hypot(dx, dz) || 1;
    look.x += (dz / dl) * 2.3; look.z -= (dx / dl) * 2.3;
    applyCamera(this.camera, pos, look, lerp(44, 38, k));
  }

  dispose() {
    if (this.phase === 'disposed') return;
    this.phase = 'disposed';
    for (const S of this.surfaces || []) world.removeSurface(S);
    this.surfaces = [];
    this.scene.remove(this.group);
    this.scene.remove(this.confetti);
    this.confetti.dispose?.();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    for (const r of this.top) if (r?.rig) r.rig.setSkisVisible?.(true);
  }
}
