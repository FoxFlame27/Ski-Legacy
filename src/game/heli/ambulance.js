// The ambulance that meets the rescue helicopter at the village pad (game/heli/rescue.js): it waits beside the
// pad, you are carried in, and it drives you with its blue lights flashing all the way to the medical centre's door
// along the RETTUNGSWEG, the pad's own road to the medical centre (bus/roads.js planHeliRoad: an ordinary road anybody
// can drive), else along the bus road that passes nearest both; `arrived` once it has pulled up there.
// (Oct 30, the user: "make sure the ambulance dodges objects for eg if someone is standing there or if a car is in the
// way but make sure it dodges properly and smoothly"): it follows the road's centre line with a lateral offset it eases
// in and out of (never sideways: it steers onto it as it drives), looking ahead (10 m + 1.8 s) for you, other players,
// people, cars (yours, parked ones, traffic, other players'), the bus / ploughs / police (the traffic blockers) and
// anything solid along the way (the colliders beside its path, found once when it sets off); it picks the free line
// within the road (onto the shoulder only when it must) nearest where it is, slows for what it can't get round in time
// and waits behind what blocks the whole road, carrying on once it is clear. The cars stop for it (a traffic blocker).
import * as THREE from 'three';
import { fitModel } from '../../core/assets.js';
import { busRoads, ROAD_HALF } from '../bus/roads.js';
import { addTrafficBlocker, trafficBlockers } from '../traffic.js';

const LEN = 5.9;      // m, a high-roof van
const HW = 1.1;       // its half width (m, with the mirrors)
const VMAX = 24;      // m/s (buffed from 16)
const LAT_HARD = ROAD_HALF - HW - 0.25, LAT_SOFT = ROAD_HALF + 0.55 - HW; // its line off the centre: on the road / onto the shoulder
const SCAN = 45;      // m round it: what it looks at
const _v = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

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
    this.lat = 0; this.latT = 0; this.q = 0; this.wait = 0; this.scanT = 0; this.obs = []; this.raw = [];
    // the cars stop for it (or round it) like for the bus
    this.box = { x: 0, y: 0, z: 0, yaw: 0, hw: HW, hd: LEN / 2 + 0.2, push: true };
    addTrafficBlocker((out) => { if (!this.group.visible) return; const b = this.box; b.x = this.x; b.y = this.group.position.y; b.z = this.z; b.yaw = this.yaw; out.push(b); });
  }

  /** Waiting beside the pad (x, z, facing yaw). */
  park(x, z, yaw) {
    if (!this.ok) return;
    this.x = x; this.z = z; this.yaw = yaw; this.s = 0; this.v = 0; this.t = 0; this.vx = 0; this.vz = 0;
    this.path = null; this.goal = null; this.arrived = false;
    this.lat = 0; this.latT = 0; this.q = 0; this.wait = 0; this.scanT = 0; this.obs.length = 0;
    this.place();
    this.group.visible = true;
    for (const m of this.lights) m.emissiveIntensity = 0.15;
  }

  hide() { this.group.visible = false; this.path = null; this.goal = null; this.arrived = false; }

  // the way out: along the Rettungsweg from the pad (straight on into the medical centre's forecourt when it ends across
  // the road from it), else toward the medical centre along the road that passes nearest both, else to the nearest
  // bus road within ~300 m and on along it, else straight out over the snow
  plan() {
    const pts = [[this.x, this.z]], H = busRoads.hospital, R = busRoads.heliRoad;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let cx = this.x, cz = this.z, done = false;
    if (R && Math.hypot(R.X[0] - this.x, R.Z[0] - this.z) < 40) {
      let i0 = 0, bd = Infinity;
      for (let i = 0; i < R.n; i++) { const d = Math.hypot(R.X[i] - this.x, R.Z[i] - this.z); if (d < bd) { bd = d; i0 = i; } }
      while (i0 < R.n - 1 && (R.X[i0] - this.x) * fx + (R.Z[i0] - this.z) * fz < 2) i0++; // (from the next point ahead)
      for (let i = i0; i < R.n; i++) pts.push([R.X[i], R.Z[i]]);
      cx = R.X[R.n - 1]; cz = R.Z[R.n - 1];
      if (R.toHospital && H) { if (H.road) pts.push([H.road.x, H.road.z]); done = true; }
    } else pts.push([this.x + fx * 8, this.z + fz * 8]);
    if (H) {
      if (!done) {
        let best = null;
        for (const r of busRoads.roads) {
          if (r.heli) continue;
          let is = 0, ds = Infinity, ih = 0, dh = Infinity;
          for (let i = 0; i < r.n; i++) {
            const a = Math.hypot(r.X[i] - cx, r.Z[i] - cz), b = Math.hypot(r.X[i] - H.ex, r.Z[i] - H.ez);
            if (a < ds) { ds = a; is = i; }
            if (b < dh) { dh = b; ih = i; }
          }
          if (!best || ds + dh < best.cost) best = { r, is, ih, cost: ds + dh };
        }
        if (best && best.cost < 420) {
          const { r, is, ih } = best, step = ih >= is ? 2 : -2;
          for (let k = is; step > 0 ? k <= ih : k >= ih; k += step) pts.push([r.X[k], r.Z[k]]);
        }
        if (H.road) pts.push([H.road.x, H.road.z]);
      }
      // pull up a few metres out from the entrance (the van stops beside the door, not in it)
      pts.push([H.ex + (H.dirx || 0) * 6, H.ez + (H.dirz || 0) * 6]);
    } else if (!R || !done) {
      let best = null, bd = 300;
      for (const r of busRoads.roads) for (let i = 0; i < r.n; i += 2) { const d = Math.hypot(r.X[i] - cx, r.Z[i] - cz); if (d < bd) { bd = d; best = { r, i }; } }
      if (best) {
        const { r, i } = best;
        // drive along it away from the village (toward the far end of that road)
        const dir = Math.hypot(r.X[r.n - 1], r.Z[r.n - 1]) > Math.hypot(r.X[0], r.Z[0]) ? 1 : -1;
        for (let k = i; k >= 0 && k < r.n && pts.length < 160; k += dir * 2) pts.push([r.X[k], r.Z[k]]);
      } else {
        for (let k = 1; k <= 30; k++) pts.push([cx + fx * k * 10, cz + fz * k * 10]);
      }
    }
    this.setPath(pts);
  }

  // the path: its corners rounded (Chaikin, the ends kept), arc lengths, unit headings per segment; the solid things
  // beside it (colliders within ~8 m of it: parked cars, props, a wreck) kept to look at as it drives
  setPath(raw) {
    let p = raw.filter((q, k) => !k || Math.hypot(q[0] - raw[k - 1][0], q[1] - raw[k - 1][1]) > 0.3);
    for (let it = 0; it < 2 && p.length > 2; it++) {
      const q = [p[0]];
      for (let i = 0; i < p.length - 1; i++) {
        const [ax, az] = p[i], [bx, bz] = p[i + 1];
        q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
      }
      q.push(p[p.length - 1]);
      p = q;
    }
    if (p.length < 2) p.push([p[0][0] + Math.sin(this.yaw), p[0][1] + Math.cos(this.yaw)]);
    const n = p.length, S = new Float32Array(n), TX = new Float32Array(n), TZ = new Float32Array(n);
    let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
    for (let k = 0; k < n; k++) {
      if (k) S[k] = S[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
      const j = Math.min(n - 1, k + 1), i = j - 1, l = Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1]) || 1;
      TX[k] = (p[j][0] - p[i][0]) / l; TZ[k] = (p[j][1] - p[i][1]) / l;
      minx = Math.min(minx, p[k][0]); maxx = Math.max(maxx, p[k][0]); minz = Math.min(minz, p[k][1]); maxz = Math.max(maxz, p[k][1]);
    }
    const statics = [];
    for (const c of window.__game?.colliders || []) {
      if (!c || c.x < minx - 12 || c.x > maxx + 12 || c.z < minz - 12 || c.z > maxz + 12) continue;
      const ext = c.r ?? Math.max(c.hw || 0, c.hd || 0);
      if (!(ext >= 0) || ext > 12) continue; // (no buildings: the road keeps clear of them)
      let near = false;
      for (let k = 0; k < n && !near; k++) if (Math.abs(p[k][0] - c.x) < 8 + ext && Math.abs(p[k][1] - c.z) < 8 + ext) near = true;
      if (near) statics.push(c);
    }
    this.path = { pts: p, S, TX, TZ, n, length: S[n - 1], statics };
    this.goal = { x: p[n - 1][0], z: p[n - 1][1] };
    this.s = 0; this.iSeg = 0; this.lat = 0; this.latT = 0; this.q = 0; this.wait = 0; this.scanT = 0; this.obs.length = 0;
  }

  // a point on the path at arc length s (out.x, out.z, the heading out.tx, out.tz; past either end: straight on)
  at(s, out = {}) {
    const P = this.path, S = P.S;
    let i = clamp(this.iSeg || 0, 0, P.n - 2);
    while (i < P.n - 2 && S[i + 1] < s) i++;
    while (i > 0 && S[i] > s) i--;
    const tx = P.TX[i], tz = P.TZ[i];
    out.x = P.pts[i][0] + tx * (s - S[i]); out.z = P.pts[i][1] + tz * (s - S[i]);
    out.tx = tx; out.tz = tz; out.i = i;
    return out;
  }

  // what is around it (every 0.1 s): boxes { x, z, ax (its half-width axis), hw, hd, vx, vz, person } within SCAN m,
  // then each laid on the path ahead: obs { s (along), lat (across, + to the left), across, along (half extents), vAlong }
  scan() {
    const g = window.__game || {}, x = this.x, z = this.z, raw = this.raw;
    let k = 0;
    const put = (px, pz, axx, axz, hw, hd, vx = 0, vz = 0, person = false) => {
      if (!(Math.abs(px - x) < SCAN && Math.abs(pz - z) < SCAN)) return;
      const o = raw[k] || (raw[k] = {}); k++;
      o.x = px; o.z = pz; o.axx = axx; o.axz = axz; o.hw = hw; o.hd = hd; o.vx = vx || 0; o.vz = vz || 0; o.person = person;
    };
    const car = (px, pz, yaw, hw, hd, v = 0) => put(px, pz, Math.cos(yaw), -Math.sin(yaw), hw, hd, Math.sin(yaw) * v, Math.cos(yaw) * v);
    const pl = g.player; // (you: unless you are aboard, the rescue's own passenger)
    if (pl?.pos && Math.hypot(pl.pos.x - x, pl.pos.z - z) > 3.5) put(pl.pos.x, pl.pos.z, 1, 0, 0.45, 0.45, pl.vel?.x, pl.vel?.z, true);
    try {
      const d = g.drive?.d; if (d) car(d.x, d.z, d.yaw, (d.w || 1.9) / 2, d.half || 2.4);
      for (const e of g.drive?.parking?.cars || g.traffic?.parking?.cars || []) if (e?.car && !e.driving) car(e.car.position.x, e.car.position.z, e.car.rotation.y, 0.95, (e.length || 4.7) / 2);
      for (const c of g.traffic?.cars || []) if (c.mode !== 'gone' && c.g?.visible !== false) car(c.x, c.z, c.yaw, (c.w || 1.9) / 2, (c.l || 4.7) / 2, c.mode === 'knocked' ? 0 : (c.v || 0) * (c.rev ? -1 : 1));
      for (const b of trafficBlockers()) if (b !== this.box) car(b.x, b.z, b.yaw || 0, b.hw || 1.2, b.hd || 3); // (the bus, ploughs, police, the tow truck, the helicopter)
      for (const r of g.multiplayer?.remotes?.players?.values?.() || []) { // (other players, and their cars / sleds)
        const inVeh = (r.vcar && !r.vcar.at) || (r.vpolice && !r.vpolice.at) || (r.vtow && !r.vtow.at);
        if (r.pos) put(r.pos.x, r.pos.z, 1, 0, inVeh ? 1.2 : 0.45, inVeh ? 2.4 : 0.45, r.vel?.x, r.vel?.z, !inVeh);
        for (const v of [r.vcar, r.vpolice, r.vtow, r.vsled]) if (v?.at) car(v.at[0], v.at[2], v.at[3] || 0, 1.0, 2.4);
      }
      for (const q of g.npcs?.near || []) if (q && Number.isFinite(q.x)) put(q.x, q.z, 1, 0, 0.4, 0.4, 0, 0, true); // (skiers, villagers, the crowds)
    } catch (e) { if (!this.warned) { this.warned = true; console.warn('ambulance: looking round', e); } }
    for (const c of this.path.statics) { // (solid things along the way)
      if (c.r !== undefined) put(c.x, c.z, 1, 0, c.r, c.r);
      else { const r = c.rot || 0; put(c.x, c.z, Math.cos(r), Math.sin(r), c.hw || 0.3, c.hd || 0.3); }
    }
    // laid on the path, from just behind the van to 50 m ahead
    const P = this.path, obs = this.obs;
    let m = 0;
    for (let j = 0; j < k; j++) {
      const o = raw[j];
      let bd = Infinity, bs = 0, bl = 0, bi = 0;
      const i0 = Math.max(0, this.iSeg - 2);
      for (let i = i0; i < P.n - 1 && P.S[i] < this.s + 55; i++) {
        const ax = P.pts[i][0], az = P.pts[i][1], tx = P.TX[i], tz = P.TZ[i], L = P.S[i + 1] - P.S[i];
        let t = (o.x - ax) * tx + (o.z - az) * tz;
        if (i < P.n - 2) t = Math.min(t, L); // (past the last point: straight on)
        if (i > i0) t = Math.max(t, 0); // (behind the first one looked at: behind the van, not beside it)
        const lx = ax + tx * t, lz = az + tz * t, dd = Math.hypot(o.x - lx, o.z - lz);
        if (dd < bd) { bd = dd; bs = P.S[i] + t; bl = (o.x - lx) * -tz + (o.z - lz) * tx; bi = i; }
      }
      if (bd > ROAD_HALF + 9) continue;
      const tx = P.TX[bi], tz = P.TZ[bi], nx = -tz, nz = tx, azx = -o.axz, azz = o.axx;
      const b = obs[m] || (obs[m] = {}); m++;
      b.s = bs; b.lat = bl; b.person = o.person;
      b.across = o.hw * Math.abs(o.axx * nx + o.axz * nz) + o.hd * Math.abs(azx * nx + azz * nz);
      b.along = o.hw * Math.abs(o.axx * tx + o.axz * tz) + o.hd * Math.abs(azx * tx + azz * tz);
      b.vAlong = o.vx * tx + o.vz * tz;
    }
    obs.length = m;
  }

  /** Drive on toward the medical centre (dt already sped up with SPACE); stops at the end of the way, `arrived`. */
  drive(dt) {
    if (!this.ok) return;
    if (!this.path) this.plan();
    if (!(dt > 0)) return;
    this.t += dt;
    const P = this.path, s = this.s, left = P.length - s, v = this.v;
    if ((this.scanT -= dt) <= 0) { this.scanT = 0.1; this.scan(); }
    // the line it may take: across the road (onto the shoulder only when it must), easing in to the middle over the
    // last ~14 m (the drop-off box at the door); squeezing past (closer, further out) after waiting a while
    const squeeze = this.wait > 3 ? 1 : 0, taper = clamp((left - 2) / 12, 0, 1);
    const hard = LAT_HARD * taper, soft = (LAT_SOFT + squeeze * 0.5) * taper;
    const look = Math.min(left + 1, 10 + v * 1.8), gapM = squeeze ? 0.15 : 0.45;
    // the free line nearest where it is (then nearer the middle), from the edges of what is in the way
    const obs = this.obs, cand = [0, this.latT, this.lat, -hard, hard, -soft, soft];
    for (const o of obs) {
      if (o.s + o.along < s - LEN / 2 - 0.5 || o.s - o.along > s + look) continue;
      const pad = HW + o.across + gapM + (o.person ? 0.35 : 0);
      cand.push(o.lat - pad - 0.05, o.lat + pad + 0.05);
    }
    let best = null, bc = Infinity;
    for (const c0 of cand) {
      const c = clamp(c0, -soft, soft);
      let ok = true;
      for (const o of obs) {
        if (o.s + o.along < s - LEN / 2 - 0.5 || o.s - o.along > s + look) continue;
        if (Math.abs(c - o.lat) < HW + o.across + gapM + (o.person ? 0.35 : 0)) { ok = false; break; }
      }
      if (!ok) continue;
      const cost = Math.abs(c - this.lat) + Math.abs(c) * 0.5 + Math.abs(c - this.latT) * 0.3 + (Math.abs(c) > hard + 0.01 ? 1.5 + Math.abs(c) : 0);
      if (cost < bc) { bc = cost; best = c; }
    }
    const free = best !== null;
    this.latT = free ? best : clamp(this.latT, -soft, soft);
    // steering onto it: a heading off the road's (q, tan of the angle) that turns only as it drives, straightened out
    // in time to arrive on the line (a smooth S, never crabbing)
    const err = this.latT - this.lat, qMax = v < 6 ? 0.36 : 0.22;
    const qDes = clamp(err / Math.max(3.5, v * 0.85), -qMax, qMax);
    // speed: the road's bends, the door, and whatever it would still run into on the line it is steering for
    let vT = Math.min(VMAX, Math.sqrt(2 * 3.5 * Math.max(0, left - 0.5)) + 0.3);
    { const a = this.at(s), b = this.at(Math.min(P.length, s + 14), {}); const ang = Math.acos(clamp(a.tx * b.tx + a.tz * b.tz, -1, 1)); if (ang > 0.05) vT = Math.min(vT, Math.sqrt(3.4 * 14 / ang) + 2); }
    const shift = Math.max(4, Math.abs(err) / qMax + 3);
    let gapMin = Infinity;
    for (const o of obs) {
      if (o.s + o.along < s - LEN / 2 + 0.3 || o.s - o.along > s + look + 6) continue;
      const lp = this.lat + err * clamp((o.s - s) / shift, 0, 1); // (where it will be across the road when it gets there)
      if (Math.abs(lp - o.lat) >= HW + o.across + (squeeze ? 0.1 : 0.3)) continue;
      const gap = o.s - o.along - s - LEN / 2 - (o.person ? 2.5 : 1.8);
      gapMin = Math.min(gapMin, gap);
      vT = Math.min(vT, gap <= 0 ? Math.max(0, Math.min(o.vAlong, 2)) : Math.max(0, o.vAlong) + Math.sqrt(2 * 5 * gap));
    }
    if (free && Math.abs(err) > 0.15 && gapMin > 0.6) vT = Math.max(vT, 1.8); // (creeping round it, never stuck waiting for room to swing out)
    this.v = clamp(v + clamp(vT - v, -8 * dt, 4.5 * dt), 0, VMAX);
    this.wait = this.v < 0.3 && vT < 0.5 ? this.wait + dt : 0;
    // (something that won't move at the door: it pulls up where it is)
    if (this.wait > 8 && left < 25) { this.arrived = true; this.v = 0; }
    const ds = this.v * dt;
    this.q += clamp(qDes - this.q, -(0.07 * ds + 0.25 * dt), 0.07 * ds + 0.25 * dt);
    if (Math.abs(this.latT - this.lat) < 0.02 && Math.abs(qDes) < 0.01) this.q *= Math.max(0, 1 - dt * 3);
    this.lat = clamp(this.lat + this.q * ds, -soft - 0.3, soft + 0.3);
    if (taper < 1) this.lat *= 1 - (1 - taper) * Math.min(1, dt * 2); // (into the middle at the door)
    this.s = Math.min(P.length, s + ds);
    if (P.length - this.s < 0.6) { this.arrived = true; this.v = 0; }
    const a = this.at(this.s);
    this.iSeg = a.i;
    const px = this.x, pz = this.z;
    this.x = a.x - a.tz * this.lat; this.z = a.z + a.tx * this.lat;
    this.vx = (this.x - px) / dt; this.vz = (this.z - pz) / dt;
    const want = Math.atan2(a.tx - a.tz * this.q, a.tz + a.tx * this.q);
    this.yaw += wrapPi(want - this.yaw) * Math.min(1, dt * 6);
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
