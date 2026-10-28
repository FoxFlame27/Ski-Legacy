// The ambulance that meets the rescue helicopter at the village pad (game/heli/rescue.js): it waits beside the
// pad, you are carried in, and it drives you with its blue lights flashing all the way to the medical centre's door
// (along the bus road that passes nearest both when there is one); `arrived` once it has pulled up there.
import * as THREE from 'three';
import { fitModel } from '../../core/assets.js';
import { busRoads, roadAt } from '../bus/roads.js';

const LEN = 5.9;      // m, a high-roof van
const _v = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class Ambulance {
  constructor({ scene, models, world }) {
    this.world = world;
    this.ok = !!models.ambulance;
    this.group = new THREE.Group();
    this.group.name = 'ambulance';
    this.group.visible = false;
    if (!this.ok) return;
    // (Meshy vans are modelled along x with the cab at -x: turned so the cab leads, toward +z)
    const m = fitModel(models.ambulance, { size: LEN, axis: 'z', rotateY: Math.PI / 2 });
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(m);
    const size = m.userData.size || new THREE.Vector3(2.1, 2.7, LEN);
    // flashing light-bar segments on the roof (front and back), blue on the left, red on the right (emissive:
    // no extra scene lights); they sit in the model's own light bars, just under the top of the roof
    this.lights = [0, 1].map((k) => {
      const col = k ? 0xff2a1a : 0x2f6bff;
      const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.15, roughness: 0.3 });
      for (const zf of [0.2, -0.42]) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.2), mat);
        l.position.set(k ? -0.4 : 0.4, size.y - 0.09, size.z * zf);
        this.group.add(l);
      }
      return mat;
    });
    scene.add(this.group);
    this.path = null;
  }

  /** Waiting beside the pad (x, z, facing yaw). */
  park(x, z, yaw) {
    if (!this.ok) return;
    this.x = x; this.z = z; this.yaw = yaw; this.s = 0; this.v = 0; this.t = 0; this.vx = 0; this.vz = 0;
    this.path = null; this.goal = null; this.arrived = false;
    this.place();
    this.group.visible = true;
    for (const m of this.lights) m.emissiveIntensity = 0.15;
  }

  hide() { this.group.visible = false; this.path = null; this.goal = null; this.arrived = false; }

  // the way out: toward the medical centre (along the road that passes nearest both, else straight to it), else to
  // the nearest bus road within ~300 m and on along it, else straight out over the snow
  plan() {
    const pts = [[this.x, this.z]];
    const H = busRoads.hospital;
    if (H) {
      let best = null;
      for (const r of busRoads.roads) {
        let is = 0, ds = Infinity, ih = 0, dh = Infinity;
        for (let i = 0; i < r.n; i++) {
          const a = Math.hypot(r.X[i] - this.x, r.Z[i] - this.z), b = Math.hypot(r.X[i] - H.ex, r.Z[i] - H.ez);
          if (a < ds) { ds = a; is = i; }
          if (b < dh) { dh = b; ih = i; }
        }
        if (!best || ds + dh < best.cost) best = { r, is, ih, cost: ds + dh };
      }
      pts.push([this.x + Math.sin(this.yaw) * 8, this.z + Math.cos(this.yaw) * 8]);
      if (best && best.cost < 420) {
        const { r, is, ih } = best, step = ih >= is ? 2 : -2;
        for (let k = is; step > 0 ? k <= ih : k >= ih; k += step) pts.push([r.X[k], r.Z[k]]);
      }
      // pull up a few metres out from the entrance (the van stops beside the door, not in it)
      pts.push([H.ex + (H.dirx || 0) * 6, H.ez + (H.dirz || 0) * 6]);
      const S = [0];
      for (let k = 1; k < pts.length; k++) S.push(S[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      this.path = { pts, S, n: pts.length, length: S[S.length - 1] };
      this.goal = { x: pts[pts.length - 1][0], z: pts[pts.length - 1][1] };
      return;
    }
    let best = null, bd = 300;
    for (const r of busRoads.roads) for (let i = 0; i < r.n; i += 2) { const d = Math.hypot(r.X[i] - this.x, r.Z[i] - this.z); if (d < bd) { bd = d; best = { r, i }; } }
    if (best) {
      const { r, i } = best;
      // drive along it away from the village (toward the far end of that road)
      const dir = Math.hypot(r.X[r.n - 1], r.Z[r.n - 1]) > Math.hypot(r.X[0], r.Z[0]) ? 1 : -1;
      pts.push([this.x + Math.sin(this.yaw) * 10, this.z + Math.cos(this.yaw) * 10]);
      for (let k = i; k >= 0 && k < r.n && pts.length < 120; k += dir * 2) pts.push([r.X[k], r.Z[k]]);
    } else {
      for (let k = 1; k <= 30; k++) pts.push([this.x + Math.sin(this.yaw) * k * 10, this.z + Math.cos(this.yaw) * k * 10]);
    }
    // arc lengths
    const S = [0];
    for (let k = 1; k < pts.length; k++) S.push(S[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    this.path = { pts, S, n: pts.length, length: S[S.length - 1] };
    this.goal = { x: pts[pts.length - 1][0], z: pts[pts.length - 1][1] };
  }

  // a point on the path at arc length s
  at(s, out) {
    const P = this.path, S = P.S;
    s = Math.max(0, Math.min(P.length, s));
    let i = 0;
    while (i < P.n - 2 && S[i + 1] < s) i++;
    const t = (s - S[i]) / Math.max(1e-6, S[i + 1] - S[i]);
    out.x = P.pts[i][0] + (P.pts[i + 1][0] - P.pts[i][0]) * t;
    out.z = P.pts[i][1] + (P.pts[i + 1][1] - P.pts[i][1]) * t;
    return out;
  }

  /** Drive on toward the medical centre (dt already sped up with SPACE); stops at the end of the way, `arrived`. */
  drive(dt) {
    if (!this.ok) return;
    if (!this.path) this.plan();
    this.t += dt;
    const left = this.path.length - this.s;
    // up to 16 m/s, braking gently (2.5 m/s^2) to a stop at the door
    this.v = Math.min(16, this.v + dt * 3.2, Math.sqrt(2 * 2.5 * Math.max(0, left - 0.5)) + 0.3);
    this.s = Math.min(this.path.length, this.s + this.v * dt);
    if (this.path.length - this.s < 0.6) { this.arrived = true; this.v = 0; }
    const a = this.at(this.s + 3, {}), b = this.at(Math.max(0, this.s - 3), {});
    const px = this.x, pz = this.z;
    this.x = (a.x + b.x) / 2; this.z = (a.z + b.z) / 2;
    if (dt > 0) { this.vx = (this.x - px) / dt; this.vz = (this.z - pz) / dt; }
    if (Math.hypot(a.x - b.x, a.z - b.z) > 0.5) {
      const want = Math.atan2(a.x - b.x, a.z - b.z);
      this.yaw += Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw)) * Math.min(1, dt * 4);
    }
    this.place();
    this.flash(0);
  }

  /** The roof lights: blue and red, two quick flashes each, alternating (bright at night, readable by day). */
  flash(dt, night = 0) {
    if (!this.ok) return;
    this.t += dt;
    const ph = (this.t * 2.2) % 1, k = 3.5 + night * 3;
    const on = (i) => { const q = (ph + i * 0.5) % 1; return q < 0.1 || (q > 0.18 && q < 0.28) ? k : 0.15; };
    this.lights[0].emissiveIntensity = on(0); this.lights[1].emissiveIntensity = on(1);
  }

  // on the snow, tilted with it
  place() {
    const W = this.world, x = this.x, z = this.z, fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const f = W.groundHeight(x + fx * 2, z + fz * 2), b = W.groundHeight(x - fx * 2, z - fz * 2);
    const l = W.groundHeight(x + fz * 0.9, z - fx * 0.9), r = W.groundHeight(x - fz * 0.9, z + fx * 0.9);
    this.group.position.set(x, Math.max(f, b, l, r) - 0.03, z);
    _e.set(Math.atan2(b - f, 4), this.yaw, Math.atan2(l - r, 1.8), 'YXZ');
    this.group.quaternion.setFromEuler(_e);
    this.group.updateMatrixWorld(true);
  }

  /** World position of the van (for the camera and the world streaming). */
  pos(out = _v) { return out.set(this.x, this.group.position.y, this.z); }
}
