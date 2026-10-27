// Tyre tracks: the car you drive presses its tyres into the snow (fx/snowfx.js trails, one strip per tyre: ids
// 'car-fl', 'car-fr', 'car-rl', 'car-rr', as wide as the car's tyres, ~0.22-0.26 m; deeper in untracked snow than on a
// groomed piste). Only on snow: off the road, pistes, the snowy shoulders and berms; never on a bus road's ploughed
// carriageway, a car park or a lay-by. The trailing tyres run in the leading ones' ruts (no second strip) until they
// leave them by half a tyre or more: cutting inside in a tight turn, swinging out in a slide (a handbrake turn
// draws its own wide arcs); a tyre sliding sideways smears a scraped band (the trails' skid). No marks in the air; the
// strips end when the car stops, when you get out (drive.js park) and when it's wrecked. Errors never reach driving.
import { busRoads, ROAD_HALF } from './bus/roads.js';

const IDS = ['car-fl', 'car-fr', 'car-rl', 'car-rr'];
// tyre widths (m): the real ones (245, 285, 225, 235, 215 mm), the RS6's narrowed to what one strip column takes
const TYRE = { car_bmw_x3: 0.245, car_audi_rs6: 0.262, car_vw_golf_gti: 0.225, car_tesla_m3: 0.235, car_dacia_duster: 0.22 };
const G_MAX = 0.133; // groove half width: past 0.2 m quad half width (groove x 1.5) the trails split a strip in 6 columns
const CELL = 16;     // road grid (m)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class TyreTracks {
  constructor(trails) {
    this.trails = trails || null;
    this.d = null;
    this.marking = false;
    this.lead = 0;
    this.hist = [[], [], [], []];              // recent ground points per tyre (x, z pairs, oldest first)
    this.live = [false, false, false, false];  // a strip open
    this.split = [false, false, false, false]; // a trailing tyre out of the leading one's rut: its own strip
    this.grid = null;
  }

  /** Per frame while driving (drive.js update): d is the drive state. */
  update(d) {
    const T = this.trails;
    if (!T || !d) return;
    try {
      if (this.d !== d) { this.end(); this.d = d; for (const h of this.hist) h.length = 0; this.split.fill(false); }
      const sp = Math.hypot(d.vx, d.vz);
      if (d.crash || d.air || sp < (this.marking ? 0.3 : 0.6)) { this.end(); return; }
      this.marking = true;
      const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), lx = fz, lz = -fx; // forward, left (car +x)
      const r = d.yawRate || 0, cs = Math.cos(d.steer || 0), sn = Math.sin(d.steer || 0);
      const u = d.vx * fx + d.vz * fz, lead = u >= 0 ? 0 : 2; // the leading axle: the front one, the rear reversing
      if (lead !== this.lead) { this.lead = lead; this.split.fill(false); }
      const W4 = this.wheels(d);
      const half = Math.min(G_MAX, (TYRE[d.e?.name] || 0.235) / 2);
      const soft = T.softAt ? T.softAt('car', d.x, d.z) : 1; // 0 groomed piste .. 1 untracked snow
      for (let i = 0; i < 4; i++) {
        const w = W4[i];
        const px = d.x + fx * w.z + lx * w.x, pz = d.z + fz * w.z + lz * w.x;
        this.remember(i, px, pz);
        if (this.ploughed(px, pz)) { this.stop(i); continue; }
        const trailing = i < 2 ? lead === 2 : lead === 0;
        if (trailing) {
          // in the leading tyre's rut (same side, other axle) or out of it (hysteresis: no flicker)
          const dev = devFrom(this.hist[i ^ 2], px, pz);
          if (this.split[i] ? dev < 0.06 : dev > 0.12) this.split[i] = !this.split[i];
          if (!this.split[i]) { this.stop(i); continue; }
        }
        // the tyre's ground speed (the car's plus its turning) against where it points (the front ones steered)
        const vx = d.vx + r * (w.z * lx - w.x * fx), vz = d.vz + r * (w.z * lz - w.x * fz), vs = Math.hypot(vx, vz);
        const front = i < 2, hx = front ? fx * cs + lx * sn : fx, hz = front ? fz * cs + lz * sn : fz;
        const sinA = vs > 0.4 ? Math.abs(vx * hz - vz * hx) / vs : 0, cosA = Math.sqrt(Math.max(0, 1 - sinA * sinA));
        const skid = vs > 1 ? clamp((sinA - 0.14) / 0.26, 0, 1) : 0;
        // the strip runs along the path (a sliding tyre sweeps a band as wide as its patch across it)
        let dx = hx * (u >= 0 ? 1 : -1), dz = hz * (u >= 0 ? 1 : -1);
        if (vs > 0.4) { dx = vx / vs; dz = vz / vs; }
        const G = Math.min(G_MAX, half * cosA + 0.12 * sinA);
        const D = (0.016 + 0.05 * soft) * (1 - 0.55 * skid);
        if (T.track) T.track(IDS[i], px, pz, d.y, dx, dz, G, D, 0, skid);
        else T.emit(IDS[i], { x: px, y: d.y, z: pz }, { x: dx, z: dz }, G, true, skid);
        this.live[i] = true;
      }
    } catch (e) { this.end(); this.trails = null; console.warn('tyre tracks: ' + e); }
  }

  /** All strips end (stopped, in the air, out of the car, wrecked). */
  end() {
    for (let i = 0; i < 4; i++) this.stop(i);
    this.marking = false;
  }

  stop(i) {
    if (!this.live[i]) return;
    this.live[i] = false;
    try { this.trails?.end(IDS[i]); } catch { /* (the strip just stays open until it goes stale) */ }
  }

  // where the tyre has been (a few metres: enough to tell whether the one behind runs in its rut)
  remember(i, x, z) {
    const h = this.hist[i], n = h.length;
    if (n) {
      const m = Math.abs(x - h[n - 2]) + Math.abs(z - h[n - 1]);
      if (m < 0.15) return;
      if (m > 5) h.length = 0; // (moved: unflipped, teleported)
    }
    h.push(x, z);
    if (h.length > 80) h.splice(0, 2);
  }

  // the tyres' contact points in the car's frame (x to the left, z forward): the model's wheels, else from its size
  wheels(d) {
    if (this.wt === d.t && this.w4) return this.w4;
    let w4 = null;
    const W = d.t?.wheels;
    if (W?.length === 4) {
      const f = W.filter((w) => w.front), b = W.filter((w) => !w.front);
      const lr = (p) => (p[0].c.x >= p[1].c.x ? p : [p[1], p[0]]); // (+x: left)
      if (f.length === 2 && b.length === 2) w4 = [...lr(f), ...lr(b)].map((w) => ({ x: w.c.x, z: w.c.z }));
    }
    if (!w4) {
      const wb = (d.wheelBase || 2.7) / 2, tr = (d.w || 1.85) / 2 - 0.15;
      w4 = [{ x: tr, z: wb }, { x: -tr, z: wb }, { x: tr, z: -wb }, { x: -tr, z: -wb }];
    }
    this.wt = d.t; this.w4 = w4;
    return w4;
  }

  // on a bus road's ploughed carriageway, a car park or a lay-by (cleared: no marks); its snowy shoulders are not
  ploughed(x, z) {
    const R = busRoads;
    if (!R?.ready) return false;
    if (R.roads?.length) {
      if (!this.grid || this.gridN !== R.roads.length) this.buildGrid();
      const cell = this.grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
      if (cell) {
        const lim2 = (ROAD_HALF + 0.25) ** 2;
        for (let k = 0; k < cell.length; k += 4) {
          const ax = cell[k], az = cell[k + 1], ex = cell[k + 2] - ax, ez = cell[k + 3] - az, l2 = ex * ex + ez * ez || 1;
          const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1), qx = ax + ex * t - x, qz = az + ez * t - z;
          if (qx * qx + qz * qz < lim2) return true;
        }
      }
    }
    for (const L of R.lots || []) {
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx) > 80 || Math.abs(dz) > 80) continue;
      if (Math.abs(dx * L.ux + dz * L.uz) < L.hw + 0.6 && Math.abs(dx * L.vx + dz * L.vz) < L.hd + 0.6) return true;
    }
    for (const b of R.laybys || []) {
      const dx = x - b.x, dz = z - b.z, ax = Math.sin(b.yaw), az = Math.cos(b.yaw);
      if (Math.abs(dx * ax + dz * az) < 9 && Math.abs(dx * az - dz * ax) < 1.7) return true;
    }
    return false;
  }

  buildGrid() {
    const g = new Map(), m = ROAD_HALF + 0.5;
    for (const r of busRoads.roads) {
      const X = r.X, Z = r.Z, n = Math.min(r.n ?? X?.length ?? 0, X?.length ?? 0);
      for (let i = 0; i < n - 1; i++) {
        const ax = X[i], az = Z[i], bx = X[i + 1], bz = Z[i + 1];
        for (let gx = Math.floor((Math.min(ax, bx) - m) / CELL); gx <= Math.floor((Math.max(ax, bx) + m) / CELL); gx++) {
          for (let gz = Math.floor((Math.min(az, bz) - m) / CELL); gz <= Math.floor((Math.max(az, bz) + m) / CELL); gz++) {
            const k = gx * 100003 + gz;
            let a = g.get(k);
            if (!a) g.set(k, (a = []));
            a.push(ax, az, bx, bz);
          }
        }
      }
    }
    this.grid = g; this.gridN = busRoads.roads.length;
  }
}

// distance from (x, z) to a path (x, z pairs); Infinity when there is none yet
function devFrom(h, x, z) {
  const n = h.length;
  if (!n) return Infinity;
  if (n < 4) return Math.hypot(x - h[0], z - h[1]);
  let best = Infinity;
  for (let k = 0; k + 3 < n; k += 2) {
    const ax = h[k], az = h[k + 1], ex = h[k + 2] - ax, ez = h[k + 3] - az, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1), qx = ax + ex * t - x, qz = az + ez * t - z;
    const dd = qx * qx + qz * qz;
    if (dd < best) best = dd;
  }
  return Math.sqrt(best);
}
