// Gondolas and chairlifts: stations, towers over the terrain, sagging haul ropes, moving cars, riding.
// Long gondolas stop at a mid-station: the cabins slow down through it and riders can get off or on there.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from './world.js';
import { bakeGeometry, makeLOD, fitModel, dequantize, clusterDecimate } from '../core/assets.js';
import { clamp, lerp, smoothstep } from '../core/noise.js';
import { drawnHeight } from './settle.js';

const CAR_HI = 32; // m: lift cars in full Meshy detail within this (a lighter copy out to 110 m, the light one beyond)

const CFG = {
  gondola: { stationH: 7.5, side: 3.4, spacing: 240, clearance: 16, speed: 18, carGap: 64, carH: 3.1, model: 'gondola_cabin', seatDrop: 2.5, stationSize: 14 },
  chair: { stationH: 5.2, side: 2.6, spacing: 115, clearance: 9, speed: 8, carGap: 28, carH: 3.2, model: 'chairlift_chair', seatDrop: 2.78, stationSize: 8 },
};
// mid-station: cabins crawl through +-MID_HALF m of the station centre and ramp back to line speed
// over MID_RAMP m either side; riders can get off / on while their cabin is in the crawl zone
const MID_HALF = 9, MID_RAMP = 36, MID_SLOW = 0.1; // (0.1 x 18 m/s: the same ~1.8 m/s crawl as before the speed-up)
// multiplayer (net/transit.js): the cabins / chairs also crawl through the bottom and top stations (+-half m of the
// bullwheel, ramping back to line speed over ramp m), so the one you wait for visibly comes in and you board it there
const END_DWELL = { gondola: { half: 7, ramp: 30, slow: 0.1 }, chair: { half: 4, ramp: 14, slow: 0.15 } };
const MID_LEN = 26, MID_W = 15; // station hall (along / across the line)

// ground clearance under the cabins (cabin / chair bottom over the snow, both ways, out of the stations):
// lifts.js adds or raises towers until the whole line keeps it (see LiftLine.fitClearance)
const GONDOLA_CLEAR = 4.5, CHAIR_CLEAR = 2.8, PROFILE_STEP = 2;

const _o = new THREE.Object3D(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _p2 = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();

// distance from (x, z) to the edge of the nearest run (pistes and races; lift corridors don't count)
function nearRun(x, z) {
  const arr = world.corridorGrid.get(Math.floor(x / 64) + ',' + Math.floor(z / 64));
  let best = Infinity;
  if (!arr) return best;
  for (const s of arr) {
    if (s.kind === 'lift') continue;
    const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
    best = Math.min(best, Math.hypot(s.ax + ex * t - x, s.az + ez * t - z) - s.w);
  }
  return best;
}

class LiftLine {
  constructor(spec, models, scene, colliders) {
    this.spec = spec;
    this.cfg = CFG[spec.type];
    this.scene = scene;
    this.colliders = colliders;
    const c = this.cfg;
    // (a station in a road's cutting: the ground there is only final once the roads are carved, after the layout)
    if (spec.bottomOnRoad) spec.bottom.y = world.height(spec.bottom.x, spec.bottom.z);
    const B = new THREE.Vector3(spec.bottom.x, spec.bottom.y + c.stationH, spec.bottom.z);
    const T = new THREE.Vector3(spec.top.x, spec.top.y + c.stationH, spec.top.z);
    this.B = B; this.T = T;
    this.L = spec.length;
    this.dir = new THREE.Vector3(spec.dir[0], 0, spec.dir[1]);
    this.sideV = new THREE.Vector3(-spec.dir[1], 0, spec.dir[0]);
    this.yaw = Math.atan2(spec.dir[0], spec.dir[1]);
    this.mid = spec.mid && spec.type === 'gondola' ? spec.mid : null;
    // gondola terminals: the Meshy hall on its podium (the cabins ride level through it at deck height)
    this.termHall = spec.type === 'gondola' && MESHY_TERMINAL && !!models.gondola_terminal;
    // support points (stations + towers), each { u (horizontal dist), y }
    const spots = spec.towers || defaultTowers(spec, c.spacing);
    this.supports = [{ u: 0, y: B.y, fixed: true }];
    this.towers = [];
    for (const t of spots) {
      const { u } = t;
      const x = B.x + this.dir.x * u, z = B.z + this.dir.z * u;
      const g = world.height(x, z);
      // look around for the highest ground under this span
      let gmax = g;
      for (let k = -3; k <= 3; k++) {
        const uu = clamp(u + (k * c.spacing) / 4, 0, this.L);
        gmax = Math.max(gmax, world.height(B.x + this.dir.x * uu, B.z + this.dir.z * uu) + (k ? -2 : 0));
      }
      // towers follow the terrain (real lifts don't run a straight chord high above the valley)
      const y = gmax + c.clearance;
      const tw = { u, x, z, g, top: y, pad: !!t.pad };
      this.supports.push({ u, y, tower: tw });
      this.towers.push(tw);
    }
    // the haul rope runs through the mid-station at station height
    if (this.mid) this.supports.push({ u: this.mid.u, y: this.mid.y + c.stationH, fixed: true });
    this.supports.push({ u: this.L, y: T.y, fixed: true });
    this.supports.sort((a, b) => a.u - b.u);
    // keep every cabin / chair clear of the ground (knolls, a summit's shoulder, a station's embankment)
    this.fitClearance(spec);
    for (const s of this.supports) if (s.tower) s.tower.top = s.y;
    this.towers.sort((a, b) => a.u - b.u);
    // each tower stands on its lowest foot (no leg left hanging over a side slope): the snow as drawn under the
    // model's own legs, which spread wider the taller the tower (twice: the foot grows as the tower does)
    const fp = models.lift_tower ? towerFootprint(models.lift_tower) : null;
    const tYaw = this.yaw + Math.PI / 2, tc = Math.cos(tYaw), ts = Math.sin(tYaw);
    for (const t of this.towers) {
      let g = world.height(t.x, t.z);
      for (const [a, b] of [[1.6, 0], [-1.6, 0], [0, 1.6], [0, -1.6]]) g = Math.min(g, world.height(t.x + this.dir.x * a + this.sideV.x * b, t.z + this.dir.z * a + this.sideV.z * b));
      if (fp) for (let k = 0; k < 2; k++) {
        const h = t.top - g + 1.2, sc = Math.min(1, 14 / h), lx = fp.ox * h * sc, lz = fp.oz * h * sc;
        g = Math.min(g, footMin(t.x + lx * tc + lz * ts, t.z - lx * ts + lz * tc, Math.hypot(fp.hx, fp.hz) * h * sc));
      }
      t.g = g;
    }
    this.buildVisuals(models, colliders);
    this.cars = [];
    const count = Math.floor((2 * this.L) / c.carGap);
    for (let i = 0; i < count; i++) this.cars.push({ s: (i * 2 * this.L) / count });
    // cabins bunch up in the slow mid-station like real detachable cabins: spread them along the loop by
    // travel time (not distance), so every cabin keeps the same time gap through the station
    if (this.mid) this.spreadByTime();
    this.carPos = this.cars.map(() => new THREE.Vector3());
    this.loopTimes();
    this.tmp = new THREE.Object3D();
  }

  // ---- motion along the loop (s in [0, 2L): up line 0..L, down line L..2L)
  uOf(s) { return s < this.L ? s : 2 * this.L - s; }
  speedAt(s) {
    let v = this.cfg.speed;
    if (this.dwell) { // (multiplayer: the station crawl at both ends of the loop)
      const e = this.dwell, r = (((s % this.L) + this.L) % this.L), d = Math.min(r, this.L - r);
      if (d < e.half + e.ramp) v *= d < e.half ? e.slow : e.slow + (1 - e.slow) * smoothstep(0, 1, (d - e.half) / e.ramp);
    }
    if (!this.mid) return v;
    const d = Math.abs(this.uOf(s) - this.mid.u);
    return Math.min(v, this.cfg.speed * (d < MID_HALF ? MID_SLOW : d < MID_HALF + MID_RAMP ? MID_SLOW + (1 - MID_SLOW) * smoothstep(0, 1, (d - MID_HALF) / MID_RAMP) : 1));
  }
  /** Multiplayer on / off: the end-station crawl (the loop's times change with it; back in single player the cars
   *  get their single-player spacing again). */
  setDwell(on) {
    const e = on ? END_DWELL[this.spec.type === 'chair' ? 'chair' : 'gondola'] : null;
    if (e === (this.dwell || null)) return;
    this.dwell = e;
    this.loopTimes();
    if (!on) { if (this.mid) this.spreadByTime(); else this.cars.forEach((c, i) => { c.s = (i * 2 * this.L) / this.cars.length; }); }
  }
  // move one car by time t (sub-stepped so cars never skip through the slow zone; t < 0 runs backwards)
  advance(car, t) {
    const L2 = 2 * this.L;
    const n = Math.max(1, Math.ceil(Math.abs(t) * this.cfg.speed / 2));
    const h = t / n;
    for (let i = 0; i < n; i++) car.s = (((car.s + this.speedAt(car.s) * h) % L2) + L2) % L2;
  }
  inStation(s) { return !!this.mid && Math.abs(this.uOf(s) - this.mid.u) < MID_HALF; }
  // ---- multiplayer (net/transit.js): every car's place from a time T (s, the line's shared timeline), so everyone
  // sees the same cabin in the same place. Car k sits where a car leaving s = 0 is after T + k/n of the loop's time
  // (the same equal time gaps spreadByTime sets up; with no mid-station that is plain distance / speed)
  loopTimes() {
    const L2 = 2 * this.L;
    if (!this.mid && !this.dwell) { this.loopT = { P: L2 / this.cfg.speed, steps: 0, times: null }; return; }
    const steps = Math.ceil(L2 / 2), times = new Float64Array(steps + 1);
    for (let i = 1; i <= steps; i++) times[i] = times[i - 1] + (L2 / steps) / this.speedAt((i - 0.5) * (L2 / steps));
    this.loopT = { P: times[steps], steps, times };
  }
  // loop position after time tau (0..P) from s = 0
  sAfter(tau) {
    const T = this.loopT, L2 = 2 * this.L;
    if (!T.times) return (tau / T.P) * L2;
    let lo = 0, hi = T.steps;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T.times[m] <= tau) lo = m; else hi = m; }
    const span = T.times[lo + 1] - T.times[lo] || 1;
    return ((lo + (tau - T.times[lo]) / span) * L2) / T.steps;
  }
  placeAt(T) {
    const P = this.loopT.P, n = this.cars.length, L2 = 2 * this.L;
    for (let k = 0; k < n; k++) {
      const tau = ((((T + (P * k) / n) % P) + P) % P);
      this.cars[k].s = this.sAfter(tau) % L2;
    }
  }
  /** The car next at loop position `target`: { idx, t } (t: s until it is there; < 0: it passed t s ago, at most a
   *  moment). Nothing is moved (multiplayer: you wait for it). */
  nextCar(target) {
    const L2 = 2 * this.L;
    let best = null;
    for (let i = 0; i < this.cars.length; i++) {
      const s = this.cars[i].s, ahead = (((s - target) % L2) + L2) % L2;
      const t = ahead < Math.max(1.5, 0.5 * (this.dwell?.half || 0)) ? -ahead / this.speedAt(s) : this.travelTime(s, (((target - s) % L2) + L2) % L2); // (one still crawling out of the station: that one)
      if (!best || t < best.t) best = { idx: i, t };
    }
    return best;
  }
  /** Seats per cabin / chair (the seat registry's n): a gondola's two benches of 3; a chair as wide as the model. */
  get seatCount() {
    if (this.spec.type !== 'chair') return 6;
    const w = this.carSize ? Math.max(this.carSize.x, this.carSize.z) : 2;
    return Math.max(1, Math.min(6, Math.floor((w * 0.85) / 0.62)));
  }
  /** The seat single player gives you (the gondola's bench facing forward, middle; a chair's seat right of centre). */
  get preferredSeat() {
    if (this.spec.type !== 'chair') return 1;
    const n = this.seatCount;
    let best = 0;
    for (let k = 0; k < n; k++) if (Math.abs((k - (n - 1) / 2) * 0.62 - 0.35) < Math.abs((best - (n - 1) / 2) * 0.62 - 0.35)) best = k;
    return best;
  }
  /** Seat n of car carIdx now: into out (world), its facing (fwd: into outFwd if given) as a heading. */
  seatInto(carIdx, n, out, outFwd = null) {
    const c = this.cfg, p = this.carPos[carIdx], side = this.cars[carIdx].side || 1;
    const fx = this.dir.x * side, fz = this.dir.z * side;
    out.copy(p); out.y -= c.seatDrop;
    let lat, along, face = 1;
    if (this.spec.type === 'chair') { const m = this.seatCount; lat = (Math.min(n, m - 1) - (m - 1) / 2) * 0.62; along = 0.1; }
    else { const b = n >= 3 ? 1 : 0; lat = ((n % 3) - 1) * 0.55; along = b ? 0.55 : -0.55; face = b ? -1 : 1; }
    out.x += fx * along + this.sideV.x * lat; out.z += fz * along + this.sideV.z * lat;
    if (outFwd) outFwd.set(fx * face, 0, fz * face);
    return Math.atan2(fx * face, fz * face);
  }
  spreadByTime() {
    // loop time at line speed vs. real loop time with the slow zone: place cabins at equal time steps
    let t = 0;
    const L2 = 2 * this.L, steps = Math.ceil(L2 / 2), probe = { s: 0 };
    const times = [0];
    for (let i = 1; i <= steps; i++) { t += (L2 / steps) / this.speedAt((i - 0.5) * (L2 / steps)); times.push(t); }
    const n = this.cars.length;
    for (let k = 0; k < n; k++) {
      const target = (t * k) / n;
      let i = 0;
      while (i < steps && times[i + 1] < target) i++;
      probe.s = ((i + (target - times[i]) / (times[i + 1] - times[i] || 1)) * L2) / steps;
      this.cars[k].s = probe.s % L2;
    }
  }

  // cable point at horizontal distance u along the line, on side (+1 up line / -1 down line)
  cableAt(u, side, out = new THREE.Vector3()) {
    u = clamp(u, 0, this.L);
    let i = 0;
    while (i < this.supports.length - 2 && this.supports[i + 1].u < u) i++;
    const a = this.supports[i], b = this.supports[i + 1];
    const t = (u - a.u) / (b.u - a.u || 1);
    const span = b.u - a.u;
    const sag = span * (this.spec.type === 'gondola' ? 0.012 : 0.015) * 4 * t * (1 - t);
    out.set(this.B.x + this.dir.x * u, lerp(a.y, b.y, t) - sag, this.B.z + this.dir.z * u);
    // into the mid-station the cabins level out onto the station's rail
    if (this.mid) {
      const k = smoothstep(MID_LEN / 2 + 16, MID_LEN / 2, Math.abs(u - this.mid.u));
      if (k > 0) out.y = lerp(out.y, this.mid.y + this.cfg.stationH, k);
    }
    // through a terminal hall too (deck height, level with its floor)
    if (this.termHall) {
      const k = smoothstep(HALL_LEN / 2 + TERM_SHIFT + 16, HALL_LEN / 2 + TERM_SHIFT, Math.min(u, this.L - u));
      if (k > 0) out.y = lerp(out.y, u < this.L / 2 ? this.B.y : this.T.y, k);
    }
    out.addScaledVector(this.sideV, side * this.cfg.side);
    return out;
  }

  // Ground under each line (both ways), every PROFILE_STEP m: the highest point under the cabin's footprint.
  groundProfile() {
    if (this._ground) return this._ground;
    const c = this.cfg, n = Math.floor(this.L / PROFILE_STEP) + 1, R = 1.3;
    const dx = this.dir.x, dz = this.dir.z, sx = this.sideV.x, sz = this.sideV.z;
    this._ground = [1, -1].map((side) => {
      const g = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const u = Math.min(this.L, i * PROFILE_STEP);
        const x = this.B.x + dx * u + sx * side * c.side, z = this.B.z + dz * u + sz * side * c.side;
        g[i] = Math.max(world.height(x, z), world.height(x + dx * R, z + dz * R), world.height(x - dx * R, z - dz * R),
          world.height(x + sx * R, z + sz * R), world.height(x - sx * R, z - sz * R));
      }
      return g;
    });
    return this._ground;
  }
  // clearance the cabins need at u: gondolas everywhere out of the stations; a chair comes down to unloading
  // height over the last ~30 m into a station
  needAt(u) {
    // (by the mid-station the cabins come down to its deck: 4.4 m over the levelled pad)
    if (this.spec.type === 'gondola') {
      const nearDeck = (this.mid && Math.abs(u - this.mid.u) < MID_LEN / 2 + 17) || (this.termHall && Math.min(u, this.L - u) < HALL_LEN / 2 + TERM_SHIFT + 17);
      return nearDeck ? GONDOLA_CLEAR - 0.5 : GONDOLA_CLEAR;
    }
    const ds = Math.min(u, this.L - u);
    return lerp(1.6, CHAIR_CLEAR, clamp((ds - 6) / 24, 0, 1));
  }
  inStationZone(u) {
    const e = this.spec.type === 'gondola' ? 8 : 6;
    return u < e || u > this.L - e || (!!this.mid && Math.abs(u - this.mid.u) < 14);
  }
  // lowest clearance under the cabins along the line (both ways) minus what they need there: { d, u, side, clear }
  worstSpot() {
    const G = this.groundProfile(), p = _p2, carH = this.cfg.carH;
    let worst = { d: -Infinity, u: 0, side: 1, clear: Infinity };
    for (let i = 0; i < G[0].length; i++) {
      const u = Math.min(this.L, i * PROFILE_STEP);
      if (this.inStationZone(u)) continue;
      const need = this.needAt(u);
      for (let k = 0; k < 2; k++) {
        this.cableAt(u, k ? -1 : 1, p);
        const clear = p.y - carH - G[k][i];
        if (need - clear > worst.d) worst = { d: need - clear, u, side: k ? -1 : 1, clear, need };
      }
    }
    return worst;
  }
  // Worst spot first: raise the tower right next to a low spot, or stand a new tower there (clear of the
  // stations and the other towers), until the cabins clear the ground all along the line.
  fitClearance(spec) {
    const c = this.cfg, S = this.supports, L = this.L, gond = spec.type === 'gondola';
    const gap = gond ? 26 : 14, stationGap = gond ? 16 : 10, midGap = MID_LEN / 2 + 20;
    const G = this.groundProfile();
    const groundNear = (u, r) => {
      let g = -Infinity;
      const i0 = Math.max(0, Math.floor((u - r) / PROFILE_STEP)), i1 = Math.min(G[0].length - 1, Math.ceil((u + r) / PROFILE_STEP));
      for (let i = i0; i <= i1; i++) g = Math.max(g, G[0][i], G[1][i]);
      return g;
    };
    const tried = new Map();
    this.added = 0;
    for (let iter = 0; iter < 64; iter++) {
      const w = this.worstSpot();
      if (w.d <= 0) break;
      const key = Math.round(w.u / 6);
      const n = (tried.get(key) || 0) + 1;
      tried.set(key, n);
      if (n > 6) { this.clearIssue = w; break; } // can't be helped here (reported by clearanceReport)
      let j = 0;
      while (j < S.length - 2 && S[j + 1].u < w.u) j++;
      const a = S[j], b = S[j + 1], t = (w.u - a.u) / (b.u - a.u || 1);
      const near = t < 0.5 ? a : b, wt = t < 0.5 ? 1 - t : t;
      // the spot sits right by a tower: that tower goes up
      if (!near.fixed && Math.abs(near.u - w.u) < gap) { near.y += w.d / Math.max(wt, 0.5) + 0.4; continue; }
      // otherwise a new tower: at the spot, kept clear of the stations, the mid-station and the other towers
      const lo = a.u + (a.fixed ? (a.u === 0 || a.u === L ? stationGap : midGap) : gap);
      const hi = b.u - (b.fixed ? (b.u === 0 || b.u === L ? stationGap : midGap) : gap);
      if (hi < lo) {
        // no room for one: raise whichever end of the span may move
        const m = !a.fixed && (b.fixed || wt < 0.5) ? a : !b.fixed ? b : null;
        if (!m) { this.clearIssue = w; break; }
        m.y += w.d / Math.max(m === a ? 1 - t : t, 0.25) + 0.4;
        continue;
      }
      const u = clamp(w.u, lo, hi);
      // its top: the rope clears the ground around it, and lifts the low spot (when the tower can't stand on it)
      let y = groundNear(u, 8) + c.carH + this.needAt(u) + 1.2;
      const ref = w.u < u ? a : b, tt = Math.abs(w.u - ref.u) / Math.max(1e-3, Math.abs(u - ref.u));
      if (tt < 0.999) y = Math.max(y, ref.y + (this.cableAt(w.u, 1, _p2).y + w.d + 0.6 - ref.y) / Math.max(tt, 0.3));
      y = Math.max(y, this.cableAt(u, 1, _p2).y); // a new tower never pulls the rope down
      const x = this.B.x + this.dir.x * u, z = this.B.z + this.dir.z * u;
      const tw = { u, x, z, g: world.height(x, z), top: y, pad: nearRun(x, z) < 6, added: true };
      this.towers.push(tw);
      S.push({ u, y, tower: tw });
      S.sort((p, q) => p.u - q.u);
      spec.towers?.push({ u, x, z, pad: tw.pad, added: true });
      this.added++;
    }
  }

  carState(s, out) {
    const L = this.L;
    s = ((s % (2 * L)) + 2 * L) % (2 * L);
    if (s < L) { this.cableAt(s, 1, out); return 1; }
    this.cableAt(2 * L - s, -1, out); return -1;
  }

  buildVisuals(models, colliders) {
    const c = this.cfg;
    const group = new THREE.Group();
    this.group = group;
    // stations
    this.termSides = {};
    for (const [p, top] of [[this.spec.bottom, false], [this.spec.top, true]]) {
      if (this.termHall) { this.buildTerminal(p, top, models, colliders, group); continue; }
      if (this.spec.type === 'chair' && MESHY_CHAIR && models.chair_terminal && models.chair_bullwheel) { this.buildChairTerminal(p, top, models, colliders, group); continue; }
      const st = makeLOD(models.gondola_station, { size: c.stationSize, axis: 'z' }, 160, 0.02);
      st.position.set(p.x, p.y - 0.3, p.z);
      st.rotation.y = this.yaw + (top ? Math.PI : 0);
      group.add(st);
      const sz = st.userData.size || new THREE.Vector3(c.stationSize, 6, c.stationSize);
      colliders.push({ x: p.x, z: p.z, hw: sz.x / 2 * 0.85, hd: sz.z / 2 * 0.85, rot: -this.yaw });
    }
    if (this.mid) this.buildMid(models, colliders);
    // towers
    if (models.lift_tower) {
      const pads = [];
      for (const t of this.towers) {
        const h = t.top - t.g + 1.2;
        const tw = makeLOD(models.lift_tower, { size: h, axis: 'y' }, 120, 0.02); // (0.04 left a 2k-triangle blob of the lattice)
        tw.position.set(t.x, t.g - 0.5, t.z);
        tw.rotation.y = this.yaw + Math.PI / 2;
        // keep tower slim regardless of height
        const s = Math.min(1, 14 / h);
        tw.scale.set(s, 1, s);
        group.add(tw);
        colliders.push({ x: t.x, z: t.z, r: 1.0 });
        if (t.pad) pads.push({ t, h, s });
      }
      // towers beside a run wear crash padding around their base
      if (pads.length) group.add(towerPadding(models.lift_tower, pads, this.yaw + Math.PI / 2));
    }
    // haul ropes
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.8 });
    for (const side of [1, -1]) {
      const pts = [];
      for (let u = 0; u <= this.L; u += 8) pts.push(this.cableAt(u, side));
      pts.push(this.cableAt(this.L, side));
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, this.spec.type === 'gondola' ? 0.05 : 0.035, 5), ropeMat);
      tube.castShadow = false;
      group.add(tube);
    }
    // cars (instanced)
    // gondola cabins stay full detail (you ride inside them); chairs get a light LOD
    // cars: full Meshy detail near the player, a light decimated version for the rest of the line
    const hi = bakeGeometry(models[c.model], { size: c.carH, axis: 'y' });
    const lo = bakeGeometry(models[c.model], { size: c.carH, axis: 'y', decimate: 0.08 }); // (beyond 110 m: 2.6k triangles a cabin, was 4.1k at 0.05)
    if (hi.geometry) {
      hi.geometry.computeBoundingBox?.();
      const bb = hi.geometry.boundingBox;
      if (bb) this.carSize = { x: bb.max.x - bb.min.x, z: bb.max.z - bb.min.z }; // (a chair's seats: multiplayer)
      const count = Math.floor((2 * this.L) / c.carGap);
      const mk = (b, shadow) => {
        b.geometry.translate(0, -c.carH, 0); // hang from the top of the grip
        const m = new THREE.InstancedMesh(b.geometry, b.material, count);
        m.castShadow = shadow; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
        group.add(m);
        return m;
      };
      this.carNear = mk(hi, true);
      this.carFar = mk(lo, false);
      // (performance pass) a middle tier: the full Meshy cabin (57k triangles) only within CAR_HI m (the one you ride
      // in, the station you stand at), a 5x lighter copy (no shadow) out to the near range, the light one beyond
      const mid = bakeGeometry(models[c.model], { size: c.carH, axis: 'y', decimate: 0.02 });
      if (mid.geometry) this.carMid = mk(mid, false);
    }
    this.scene.add(group);
  }

  // a gondola terminal: the Meshy hall on its podium, its stair on the side with the levelest ground, and a
  // bullwheel under the arch that the haul rope swings round behind the boarding point
  buildTerminal(p, top, models, colliders, group) {
    // the hall sits TERM_SHIFT m out along the line from the boarding point (the bullwheel), so little of it
    // stands behind the station (the village plaza's lamps and the bus stops there stay clear)
    const sv = this.sideV, out = HALL_W / 2 + 2.8, f = top ? -TERM_SHIFT : TERM_SHIFT;
    const c = { x: p.x + this.dir.x * f, y: p.y, z: p.z + this.dir.z * f };
    const score = (sd) => Math.abs(world.height(c.x + sv.x * sd * out, c.z + sv.z * sd * out) - p.y) + (this.blocked(c.x + sv.x * sd * out, c.z + sv.z * sd * out) ? 20 : 0);
    const sd = score(1) <= score(-1) ? 1 : -1;
    this.termSides[top ? 'top' : 'bottom'] = sd;
    (this.termCenters ??= {})[top ? 'top' : 'bottom'] = c;
    const m = new THREE.Mesh(podiumGeometry(sd), midStationMaterial());
    m.position.set(c.x, p.y - 0.05, c.z);
    m.rotation.y = this.yaw;
    m.castShadow = true; m.receiveShadow = true;
    m.updateMatrix(); m.matrixAutoUpdate = false;
    group.add(m);
    const hall = makeLOD({ scene: hallModel(models.gondola_terminal, sd) }, { size: HALL_LEN, axis: 'z' }, 180, 0.015);
    hall.position.set(c.x, p.y + HALL_BASE, c.z);
    hall.rotation.y = this.yaw;
    group.add(hall);
    const wheel = new THREE.Mesh(bullwheelGeometry(this.cfg.side), bullwheelMaterial());
    wheel.position.set(p.x, p.y + this.cfg.stationH, p.z);
    wheel.rotation.y = this.yaw + (top ? Math.PI : 0); // the rope's half loop faces away from the line
    wheel.castShadow = true;
    group.add(wheel);
    colliders.push({ x: c.x, z: c.z, hw: HALL_W / 2 - 0.4, hd: HALL_LEN / 2 - 0.4, rot: -this.yaw });
  }

  // a chairlift terminal: the Meshy bullwheel under its dome (chairs swing round at the rim), the haul rope's half
  // loop round the back, and the Meshy operator hut beside the line, behind the bullwheel, on the levelest side
  buildChairTerminal(p, top, models, colliders, group) {
    const c = this.cfg, sv = this.sideV, back = top ? 1 : -1; // "behind the station": away from the line
    const fit = chairBullwheel(models.chair_bullwheel, c.side, c.stationH);
    const w = new THREE.LOD();
    for (const [geo, d] of [[fit.geometry, 0], [fit.low, 150]]) {
      const m = new THREE.Mesh(geo, fit.material);
      m.castShadow = d === 0; m.receiveShadow = true;
      w.addLevel(m, d);
    }
    const loop = new THREE.Mesh(ropeLoopGeometry(c.side), ropeLoopMaterial());
    loop.castShadow = true;
    w.add(loop); // (a plain child: drawn at every LOD level)
    w.position.set(p.x, p.y + c.stationH, p.z);
    w.rotation.y = this.yaw + (top ? Math.PI : 0);
    group.add(w);
    colliders.push({ x: p.x, z: p.z, r: Math.max(0.8, fit.footR * 0.9) }); // its round foundation
    const off = c.side + 6.2, bk = 1.5;
    const spot = (sd) => ({ x: p.x + sv.x * sd * off + this.dir.x * back * bk, z: p.z + sv.z * sd * off + this.dir.z * back * bk });
    const score = (sd) => { const q = spot(sd); return Math.abs(world.height(q.x, q.z) - p.y) + (this.blocked(q.x, q.z) ? 20 : 0); };
    const sd = score(1) <= score(-1) ? 1 : -1, q = spot(sd);
    const hut = makeLOD(models.chair_terminal, { size: 6.4, axis: 'xz' }, 150, 0.02);
    const sz0 = hut.userData.size || new THREE.Vector3(6.4, 4, 6.4);
    const g = footMin(q.x, q.z, Math.max(sz0.x, sz0.z) * 0.42); // (the lowest ground under it: no floating downhill side)
    hut.position.set(q.x, Math.min(g, p.y) - 0.12, q.z);
    hut.rotation.y = this.yaw + (sd > 0 ? -Math.PI / 2 : Math.PI / 2); // its front (+z) faces the line
    group.add(hut);
    const sz = hut.userData.size || new THREE.Vector3(6.4, 4, 6.4);
    colliders.push({ x: q.x, z: q.z, hw: sz.x / 2 * 0.9, hd: sz.z / 2 * 0.9, rot: -hut.rotation.y });
  }

  // where a rider steps off: the foot of the stair down the podium at (p, side sd), or the nearest clear spot
  stairExit(p, sd, hall) {
    const sv = this.sideV, d = this.dir;
    const out = hall ? HALL_W / 2 + 2.8 : 10.6, back = hall ? 2.6 : 1.8;
    let x = 0, z = 0;
    for (const [o, b] of [[out, back], [out, back + 3], [out + 2, back], [out, back - 3], [out + 2, back + 4], [out + 4, back]]) {
      x = p.x + sv.x * sd * o - d.x * b; z = p.z + sv.z * sd * o - d.z * b;
      if (!this.blocked(x, z)) break;
    }
    // face downhill, unless that's back into the station (on its levelled pad): then down the line
    const [gx, gz] = world.gradient(x, z), gl = Math.hypot(gx, gz);
    const away = gl > 0.03 && (-gx * sv.x * sd - gz * sv.z * sd) / gl > -0.2;
    return { x, z, heading: away ? Math.atan2(-gx, -gz) : Math.atan2(-d.x, -d.z) };
  }
  terminalExit(top) {
    const key = top ? 'top' : 'bottom';
    this._termExit ??= {};
    return (this._termExit[key] ??= this.stairExit(this.termCenters?.[key] || (top ? this.spec.top : this.spec.bottom), this.termSides[key] || 1, true));
  }

  // the mid-station: the Meshy hall on a podium (MESHY_MID) or the built steel-and-timber hall
  buildMid(models, colliders) {
    if (this.midGroup) {
      this.group.remove(this.midGroup);
      for (const c of this.midColliders) { const i = colliders.indexOf(c); if (i >= 0) colliders.splice(i, 1); }
    }
    const g = new THREE.Group(), cols = [];
    this.midGroup = g; this.midColliders = cols;
    this.hall = !!(this.useHall ?? MESHY_MID) && !!models.gondola_terminal;
    const m = new THREE.Mesh(this.hall ? podiumGeometry(this.mid.side) : midStationGeometry(this.mid.side), midStationMaterial());
    m.position.set(this.mid.x, this.mid.y - 0.05, this.mid.z);
    m.rotation.y = this.yaw;
    m.castShadow = true; m.receiveShadow = true;
    m.updateMatrix(); m.matrixAutoUpdate = false;
    g.add(m);
    if (this.hall) {
      const hall = makeLOD({ scene: hallModel(models.gondola_terminal, this.mid.side) }, { size: HALL_LEN, axis: 'z' }, 180, 0.015);
      hall.position.set(this.mid.x, this.mid.y + HALL_BASE, this.mid.z);
      hall.rotation.y = this.yaw;
      g.add(hall);
      // the podium (the cabins ride over its deck, through the hall)
      cols.push({ x: this.mid.x, z: this.mid.z, hw: HALL_W / 2 - 0.4, hd: HALL_LEN / 2 - 0.4, rot: -this.yaw });
    } else {
      // the two machine rooms under the platforms (the cabins pass between them, over the pad)
      for (const sd of [1, -1]) {
        const ox = this.sideV.x * sd * 6.4, oz = this.sideV.z * sd * 6.4;
        cols.push({ x: this.mid.x + ox, z: this.mid.z + oz, hw: 1.3, hd: MID_LEN / 2 - 1, rot: -this.yaw });
      }
    }
    colliders.push(...cols);
    this.group.add(g);
  }

  update(dt, timeScale, viewer, T = null) {
    const d = this.tmp;
    let nNear = 0, nFar = 0, nMid = 0;
    if (T !== null) this.placeAt(T); // (multiplayer: from the shared timeline)
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (dt > 0 && T === null) {
        if (this.mid) this.advance(car, dt * timeScale);
        else car.s = (car.s + this.cfg.speed * dt * timeScale) % (2 * this.L);
      }
      const side = this.carState(car.s, this.carPos[i]);
      car.side = side;
      if (this.carNear) {
        d.position.copy(this.carPos[i]);
        d.rotation.set(0, this.yaw + (side > 0 ? 0 : Math.PI), 0);
        // gentle swing (steady while crawling through a station)
        d.rotation.z = Math.sin(car.s * 0.15 + i) * 0.025 * (this.inStation(car.s) ? 0.2 : 1);
        d.updateMatrix();
        const d2 = viewer ? this.carPos[i].distanceToSquared(viewer) : 0;
        const near = d2 < 110 * 110;
        if (near && (d2 < CAR_HI * CAR_HI || !this.carMid)) this.carNear.setMatrixAt(nNear++, d.matrix);
        else if (near) this.carMid.setMatrixAt(nMid++, d.matrix);
        else this.carFar.setMatrixAt(nFar++, d.matrix);
      }
    }
    if (this.carNear) {
      this.carNear.count = nNear; this.carFar.count = nFar;
      this.carNear.instanceMatrix.needsUpdate = true; this.carFar.instanceMatrix.needsUpdate = true;
      if (this.carMid) { this.carMid.count = nMid; this.carMid.instanceMatrix.needsUpdate = true; }
    }
  }

  seatFor(carIdx, n = -1) {
    if (n >= 0) { const pos = new THREE.Vector3(), fwd = new THREE.Vector3(); this.seatInto(carIdx, n, pos, fwd); return { pos, fwd }; } // (multiplayer: your seat)
    const c = this.cfg;
    const p = this.carPos[carIdx];
    const side = this.cars[carIdx].side;
    const fwd = this.dir.clone().multiplyScalar(side);
    const seat = p.clone();
    seat.y -= c.seatDrop;
    if (this.spec.type === 'chair') seat.addScaledVector(fwd, 0.1).addScaledVector(this.sideV, 0.35);
    else seat.addScaledVector(fwd, -0.55);
    return { pos: seat, fwd };
  }

  // where a rider steps off at the mid-station: at the foot of the stairs on the side of the nearby run
  midExit() {
    if (this._midExit?.hall === this.hall) return this._midExit;
    this._midExit = { ...this.stairExit(this.mid, this.mid.side || 1, this.hall), hall: this.hall };
    return this._midExit;
  }
  // is (x, z) inside (or within 0.6 m of) a collider? (same box convention as player.collide)
  blocked(x, z) {
    for (const c of this.colliders) {
      const reach = (c.r ?? Math.max(c.hw, c.hd)) + 0.6;
      if (Math.abs(x - c.x) > reach || Math.abs(z - c.z) > reach) continue;
      if (c.r !== undefined) { if (Math.hypot(x - c.x, z - c.z) < c.r + 0.6) return true; continue; }
      const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
      const lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
      if (Math.abs(lx) < c.hw + 0.6 && Math.abs(lz) < c.hd + 0.6) return true;
    }
    return false;
  }

  // the car that reaches loop position `target` soonest (or just passed it), and the time to bring it
  // there (negative = it already passed): every car moves by that same time, keeping the time gaps
  pickCar(target) {
    const L2 = 2 * this.L;
    let iB = 0, iA = 0, dB = Infinity, dA = Infinity;
    for (let i = 0; i < this.cars.length; i++) {
      const behind = (target - this.cars[i].s + L2) % L2, ahead = (L2 - behind) % L2;
      if (behind < dB) { dB = behind; iB = i; }
      if (ahead < dA) { dA = ahead; iA = i; }
    }
    const tB = this.travelTime(this.cars[iB].s, dB), tA = this.travelTime(target, dA);
    return tB <= tA ? { idx: iB, t: tB } : { idx: iA, t: -tA };
  }
  travelTime(s0, dist) {
    if (!this.mid && !this.dwell) return dist / this.cfg.speed;
    let t = 0;
    const n = Math.max(1, Math.ceil(dist / 2)), h = dist / n;
    for (let i = 0; i < n; i++) t += h / this.speedAt(s0 + h * (i + 0.5));
    return t;
  }
}

function defaultTowers(spec, spacing) {
  const n = Math.max(0, Math.round(spec.length / spacing) - 1), out = [];
  for (let i = 1; i <= n; i++) out.push({ u: (spec.length * i) / (n + 1) });
  return out;
}

// ------------------------------------------------------------------ mid-station building
// A pass-through hall: galvanised steel portal frames, a standing-seam roof with a snow load, a warm timber
// ceiling and the house-blue fascia, timber-clad machine rooms with windows under the two boarding platforms, a
// centre platform between the lines and a stair down to the pad on the side of the nearby run. The cabins ride
// through on the haul rope; nothing runs along the lines at cabin height (the ride camera follows the cabin
// through the hall, right along the line).
// Local frame: +z up the line, +x = the station's left looking up the line (world -sideV); y up from the pad.
let midMat = null;
function midStationMaterial() {
  if (midMat) return midMat;
  midMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.08 });
  // surface detail on the plain vertex colours: board-formed concrete on the grey faces, vertical larch grain on
  // the warm ones, box-projected in world space (no UVs needed), a little rougher where darker
  const conc = { value: podiumTexture('concrete') }, wood = { value: podiumTexture('wood') };
  midMat.onBeforeCompile = (sh) => {
    sh.uniforms.uConc = conc; sh.uniforms.uWood = wood;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vPodW;\nvarying vec3 vPodN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPodW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvPodN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uConc;\nuniform sampler2D uWood;\nvarying vec3 vPodW;\nvarying vec3 vPodN;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 an = abs(vPodN);
        vec2 puv = an.x > an.y && an.x > an.z ? vPodW.zy : (an.z > an.y ? vPodW.xy : vPodW.xz);
        float warm = clamp((vColor.r - vColor.b) * 5.0, 0.0, 1.0);
        float pd = mix(texture2D(uConc, puv * 0.16).r, texture2D(uWood, vec2(puv.x * 0.9, puv.y * 0.11)).r, warm);
        diffuseColor.rgb *= mix(0.58, 1.2, pd);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * mix(1.12, 0.9, pd), 0.0, 1.0);');
  };
  midMat.customProgramCacheKey = () => 'podium-detail';
  return midMat;
}
// 512 px detail maps (grey, 0.5 = no change): concrete with 1.4 m formwork seams, blotches and run-off streaks;
// larch with fine vertical grain and a few knots
function podiumTexture(kind) {
  const N = 512, data = new Uint8Array(N * N * 4);
  const h = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const wx = (v) => ((v % 16) + 16) % 16; // tiles every 16 cells
    const a = h(wx(xi), wx(yi)), b = h(wx(xi + 1), wx(yi)), c = h(wx(xi), wx(yi + 1)), d = h(wx(xi + 1), wx(yi + 1));
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x / N) * 16, v = (y / N) * 16;
    let t;
    if (kind === 'concrete') {
      t = 0.5 + (vnoise(u, v) - 0.5) * 0.4 + (vnoise(u * 4, v * 4) - 0.5) * 0.22 + (h(x, y) - 0.5) * 0.1;
      if (y % 128 < 4 || x % 256 < 3) t -= 0.22; // formwork joints
      t -= Math.max(0, vnoise(u * 3, v * 0.25) - 0.6) * 0.9; // streaks running down
    } else {
      const g = Math.sin(u * 9 + vnoise(u * 2, v * 0.3) * 6) * 0.5 + 0.5; // grain lines along v
      t = 0.5 + (g - 0.5) * 0.3 + (vnoise(u * 6, v * 0.5) - 0.5) * 0.28 + (h(x, y) - 0.5) * 0.08;
      const kx = (u % 4) - 2, ky = (v % 5.3) - 2.6; // a few knots
      if (h(Math.floor(u / 4), Math.floor(v / 5.3)) > 0.7) t -= Math.max(0, 0.35 - Math.hypot(kx, ky * 0.6)) * 0.9;
    }
    const k = (y * N + x) * 4, b = Math.max(0, Math.min(255, Math.round(t * 255)));
    data[k] = data[k + 1] = data[k + 2] = b; data[k + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
const midGeoCache = new Map();
function midStationGeometry(side) {
  if (midGeoCache.has(side)) return midGeoCache.get(side);
  const parts = [];
  const box = (x, y, z, sx, sy, sz, col, rx = 0) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, 0, 0)), _s.set(1, 1, 1)));
    const n = g.attributes.position.count, cols = new Float32Array(n * 3);
    _c.set(col);
    for (let i = 0; i < n; i++) { cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  };
  const STEEL = '#9aa1a8', STEEL_D = '#6b7178', WOOD = ['#80593a', '#77522f', '#8a6240'], GLASS = '#26384a', ROOF = '#4a5057', SNOW = '#eef3f9', BLUE = '#1546c8', CONC = '#8b8e93', WHITE = '#f2f2ef';
  const CEIL = ['#b98a5a', '#ad7f50', '#c29463']; // larch boards under the roof
  const L = MID_LEN, W = MID_W, deck = 4.3, roofY = 10.2, hl = L / 2, hw = W / 2;
  // concrete plinths under the machine rooms
  for (const sx of [-1, 1]) box(sx * 6.4, 0.2, 0, 2.9, 0.6, L - 1.2, CONC);
  // machine rooms: timber boards over a dark core, windows, a door on the stair side
  for (const sx of [-1, 1]) {
    box(sx * 6.4, deck / 2, 0, 2.5, deck - 0.2, L - 2, '#4a3524');
    const boards = 26;
    for (let i = 0; i < boards; i++) {
      const z = -hl + 1 + (i + 0.5) * ((L - 2) / boards);
      box(sx * (6.4 + 1.27), deck / 2, z, 0.06, deck - 0.3, (L - 2) / boards - 0.03, WOOD[i % 3]);
    }
    for (const z of [-8, -3, 3, 8]) {
      box(sx * (6.4 + 1.32), 2.4, z, 0.06, 1.3, 2.4, WHITE);
      box(sx * (6.4 + 1.35), 2.4, z, 0.05, 1.1, 2.2, GLASS);
    }
    // deck slab + steel edge
    box(sx * 6.25, deck, 0, 2.7, 0.3, L, '#9a9ea4');
    box(sx * (6.25 + 1.37), deck, 0, 0.08, 0.36, L, STEEL);
  }
  // centre platform between the two lines, on slim columns
  box(0, deck, 0, 3.0, 0.3, L - 6, '#9a9ea4');
  for (const z of [-8, 0, 8]) box(0, deck / 2, z, 0.35, deck, 0.35, STEEL);
  // railings along the platform edges toward the cabins (yellow safety edge stripe on the deck)
  for (const x of [-4.86, 4.86, -1.46, 1.46]) {
    box(x, deck + 0.17, 0, 0.12, 0.04, x === -1.46 || x === 1.46 ? L - 6 : L, '#f1c40f');
  }
  // outer railings, open where the stair comes up (on the run's side, world sideV * side = local -x)
  const st = -(side || 1), gap = [4.6, 7.4];
  for (const sx of [-1, 1]) {
    for (let z = -hl + 0.5; z <= hl - 0.5; z += 2.1) if (sx !== st || z < gap[0] - 0.3 || z > gap[1] + 0.3) box(sx * 7.55, deck + 0.55, z, 0.05, 1.1, 0.05, STEEL_D);
    if (sx !== st) box(sx * 7.55, deck + 1.1, 0, 0.07, 0.07, L - 0.6, STEEL_D);
    else {
      box(sx * 7.55, deck + 1.1, (-hl + 0.3 + gap[0]) / 2, 0.07, 0.07, gap[0] + hl - 0.3, STEEL_D);
      box(sx * 7.55, deck + 1.1, (gap[1] + hl - 0.3) / 2, 0.07, 0.07, hl - 0.3 - gap[1], STEEL_D);
    }
  }
  // portal frames: columns from the ground to the roof beam, every 6.5 m
  for (let z = -hl + 0.4; z <= hl; z += (L - 0.8) / 4) {
    for (const sx of [-1, 1]) box(sx * (hw - 0.3), roofY / 2, z, 0.4, roofY, 0.4, STEEL);
    box(0, roofY - 0.35, z, W - 0.2, 0.5, 0.35, STEEL);
  }
  // timber ceiling: larch boards along the hall just under the pitched roof, above the portal beams
  for (const sx of [-1, 1]) {
    const n = 7, x0 = 0.1, x1 = 5.15, bw = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const ax = x0 + (i + 0.5) * bw;
      const g = new THREE.BoxGeometry(bw - 0.025, 0.05, L + 2.2).toNonIndexed();
      g.applyMatrix4(new THREE.Matrix4().compose(_p.set(sx * ax, roofY + 0.45 - ax * 0.1, 0), _q.setFromEuler(_e.set(0, 0, -sx * 0.1)), _s.set(1, 1, 1)));
      const m = g.attributes.position.count, cc = new Float32Array(m * 3);
      _c.set(CEIL[(i + (sx > 0 ? 1 : 0)) % 3]);
      for (let k = 0; k < m; k++) { cc[k * 3] = _c.r; cc[k * 3 + 1] = _c.g; cc[k * 3 + 2] = _c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      parts.push(g);
    }
  }
  // roof: two gently pitched standing-seam slabs, snow load on top, house-blue fascia with a white band
  for (const sx of [-1, 1]) {
    const g = new THREE.BoxGeometry(hw + 1.2, 0.32, L + 2.4).toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().compose(_p.set(sx * (hw + 1.2) / 2, roofY + 0.25, 0), _q.setFromEuler(_e.set(0, 0, -sx * 0.1)), _s.set(1, 1, 1)));
    const n = g.attributes.position.count, cols = new Float32Array(n * 3);
    _c.set(ROOF);
    for (let i = 0; i < n; i++) { cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(g);
    const sn = new THREE.BoxGeometry(hw + 1.0, 0.26, L + 2.1).toNonIndexed();
    sn.applyMatrix4(new THREE.Matrix4().compose(_p.set(sx * (hw + 1.0) / 2, roofY + 0.5, 0), _q.setFromEuler(_e.set(0, 0, -sx * 0.1)), _s.set(1, 1, 1)));
    const m2 = sn.attributes.position.count, c2 = new Float32Array(m2 * 3);
    _c.set(SNOW);
    for (let i = 0; i < m2; i++) { c2[i * 3] = _c.r; c2[i * 3 + 1] = _c.g; c2[i * 3 + 2] = _c.b; }
    sn.setAttribute('color', new THREE.BufferAttribute(c2, 3));
    parts.push(sn);
  }
  for (const sz of [-1, 1]) {
    box(0, roofY - 0.25, sz * (hl + 1.15), W + 2.6, 0.7, 0.12, BLUE);
    box(0, roofY - 0.42, sz * (hl + 1.22), W + 2.6, 0.12, 0.04, WHITE);
  }
  for (const sx of [-1, 1]) box(sx * (hw + 1.25), roofY - 0.25, 0, 0.12, 0.7, L + 2.4, BLUE);
  // stair down the outside of the wall, from the platform's railing gap to the pad
  const steps = 16, rise = deck / steps, run = 0.42, sxs = st * 8.55, z0 = gap[0] + 0.2;
  for (let i = 0; i < steps; i++) box(sxs, deck - (i + 1) * rise - 0.04, z0 - (i + 0.5) * run, 1.5, 0.08, run + 0.02, '#9a9ea4');
  box(sxs, deck - 0.04, (z0 + gap[1]) / 2, 1.5, 0.08, gap[1] - z0 + 0.1, '#9a9ea4'); // landing at the top
  // stringers + handrails (they slope down toward -z: rotate about x by -angle)
  const sl = Math.hypot(steps * run, deck), ang = Math.atan2(deck, steps * run), zc = z0 - (steps * run) / 2;
  for (const o of [-0.78, 0.78]) {
    box(sxs + o, deck / 2 - 0.12, zc, 0.08, 0.3, sl, STEEL_D, -ang);
    box(sxs + o, deck / 2 + 0.85, zc, 0.05, 0.05, sl, STEEL_D, -ang);
  }
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  geo.computeBoundingSphere();
  midGeoCache.set(side, geo);
  return geo;
}

// ------------------------------------------------------------------ Meshy mid-station hall
// The Meshy terminal (models/gondola_terminal.glb: a white arched glass hall between four timber rooms) sits on a
// concrete-and-timber podium, its floor level with the boarding deck: the cabins ride through the arch over the
// floor (both lanes pass between the rooms) and riders step off onto a stair down the podium. Anything of the
// model inside the cabin lanes (railings across the ends, posts) and the drone-like gadget on the roof is cut out.
// Fitted frame: z along the line (HALL_LEN), x across (widened to HALL_W so both lanes clear the rooms), y up
// from the model's base; its floor is at HALL_FLOOR.
const MESHY_MID = true; // false = the built hall (midStationGeometry); Lifts.setMidModel swaps at run time
// (?meshyterm / ?meshychair in the page URL switch an unverified station style on for a test)
const urlFlag = (k) => typeof location !== 'undefined' && new RegExp(`[?&]${k}(&|=|$)`).test(location.search);
const MESHY_TERMINAL = false || urlFlag('meshyterm'); // gondola base / top terminals: the same hall on its podium (off: the user prefers the original station models)
const MESHY_CHAIR = true || urlFlag('meshychair'); // chairlift terminals: built bullwheel + the Meshy chair_terminal hut
const TERM_SHIFT = 6; // a terminal hall's centre, out along the line from the boarding point
const HALL_LEN = 26, HALL_W = 27.7, HALL_FLOOR = 0.0475 * HALL_LEN, DECK = 4.3, HALL_BASE = DECK - HALL_FLOOR;
const hallCache = new Map();
function hallModel(gltf, side) {
  const key = side || 1;
  if (hallCache.has(key)) return hallCache.get(key);
  const fitted = fitModel(gltf, { size: HALL_LEN, axis: 'z' });
  fitted.scale.x = HALL_W / fitted.userData.size.x;
  fitted.updateMatrixWorld(true);
  const st = -key, root = new THREE.Group();
  const cut = (x, y, z) => {
    const ax = Math.abs(x);
    if (ax > 1.6 && ax < 5.25 && y > HALL_FLOOR + 0.06 && y < 8.4) return true; // the cabin lanes (+ the ride camera)
    if (ax < 5.25 && Math.abs(z) > HALL_LEN / 2 - 1.4 && y > HALL_FLOOR + 0.06 && y < HALL_FLOOR + 1.9) return true; // railings across the ends
    if (ax < 1.7 && Math.abs(z) > HALL_LEN / 2 - 2.6 && y > HALL_FLOOR + 0.06 && y < 9.4) return true; // posts in the arch openings (the ride camera passes them)
    if (ax < 2.6 && Math.abs(z) < 4.5 && y > 12.25) return true; // roof gadget
    if (x * st > HALL_W / 2 - 1.1 && z > 4.0 && z < 8.0 && y > HALL_FLOOR + 0.05 && y < 3.4) return true; // stair gap in the railing
    return false;
  };
  fitted.traverse((o) => {
    if (!o.isMesh) return;
    const geo = dequantize(o.geometry);
    geo.applyMatrix4(o.matrixWorld);
    const p = geo.attributes.position, src = geo.index ? geo.index.array : null, n = src ? src.length : p.count;
    const keep = [];
    for (let t = 0; t < n; t += 3) {
      const a = src ? src[t] : t, b = src ? src[t + 1] : t + 1, c = src ? src[t + 2] : t + 2;
      const x = (p.getX(a) + p.getX(b) + p.getX(c)) / 3, y = (p.getY(a) + p.getY(b) + p.getY(c)) / 3, z = (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3;
      if (!cut(x, y, z)) keep.push(a, b, c);
    }
    geo.setIndex(keep);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, o.material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh);
  });
  hallCache.set(key, root);
  return root;
}

// a terminal's bullwheel (radius r = the rope's offset from the line): a steel wheel just above the rope, the
// gearbox and drive shaft up to the roof, and the haul rope's half loop round it (local -z: away from the line)
const wheelGeos = new Map();
let wheelMat = null;
function bullwheelGeometry(r) {
  if (wheelGeos.has(r)) return wheelGeos.get(r);
  const parts = [];
  const add = (g, x, y, z, col) => {
    g = g.index ? g.toNonIndexed() : g;
    g.translate(x, y, z);
    const n = g.attributes.position.count, cols = new Float32Array(n * 3);
    _c.set(col);
    for (let i = 0; i < n; i++) { cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
    parts.push(g);
  };
  add(new THREE.CylinderGeometry(r - 0.22, r - 0.22, 0.34, 48), 0, 0.3, 0, '#8d949b'); // the wheel
  add(new THREE.CylinderGeometry(r - 0.5, r - 0.5, 0.06, 48), 0, 0.5, 0, '#c9cdd1'); // its bright top rim
  add(new THREE.BoxGeometry(1.8, 1.2, 1.8), 0, 1.1, 0, '#1546c8'); // gearbox (house blue)
  add(new THREE.CylinderGeometry(0.32, 0.32, 5.5, 16), 0, 4.4, 0, '#6b7178'); // drive shaft / hanger up to the roof
  const loop = new THREE.TorusGeometry(r, 0.05, 6, 40, Math.PI);
  loop.rotateX(Math.PI / 2); // flat, round the back (-z) half
  loop.rotateY(Math.PI);
  add(loop, 0, 0, 0, '#2a2a2a');
  const geo = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  wheelGeos.set(r, geo);
  return geo;
}

// The chairlift bullwheel: the Meshy chair_bullwheel (a dome over the wheel rim on one steel column, a machine base
// and a round foundation) fitted to the line. Scaled so the rim runs round the rope (radius r) at the origin, which
// is rope height, with its foundation on the pad h below; only the plain column in between is stretched to make up
// the height (a piecewise height remap, no cut). The parts are found from its radius profile around the column.
const bullwheelFits = new Map();
function chairBullwheel(gltf, r, h) {
  const key = r + ',' + h;
  if (bullwheelFits.has(key)) return bullwheelFits.get(key);
  let src = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  const geo = dequantize(src.geometry);
  geo.applyMatrix4(src.matrixWorld);
  const pos = geo.attributes.position, n = pos.count;
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox, H = max.y - min.y;
  // the column axis: the middle of the vertices at 30-55 % of the height
  let ax = 0, az = 0, k = 0;
  for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y > min.y + H * 0.3 && y < min.y + H * 0.55) { ax += pos.getX(i); az += pos.getZ(i); k++; } }
  ax /= k || 1; az /= k || 1;
  // widest point in 60 height bands: the rim is the widest band, the column the thin run below it
  const B = 60, rad = new Float32Array(B), band = (y) => Math.min(B - 1, Math.max(0, Math.floor(((y - min.y) / H) * B)));
  for (let i = 0; i < n; i++) { const b = band(pos.getY(i)); rad[b] = Math.max(rad[b], Math.hypot(pos.getX(i) - ax, pos.getZ(i) - az)); }
  let rimB = 0;
  for (let b = 1; b < B; b++) if (rad[b] > rad[rimB]) rimB = b;
  const rimR = rad[rimB], thin = rimR * 0.18, yAt = (b) => min.y + (b / B) * H;
  let b1 = rimB;
  while (b1 > 0 && rad[b1 - 1] >= thin) b1--; // down from the rim: the wheel's underside
  let b2 = 0;
  while (b2 < b1 && rad[b2] >= thin) b2++; // up from the foot: the top of the machine base
  let rimC = 0, m = 0;
  for (let i = 0; i < n; i++) if (Math.hypot(pos.getX(i) - ax, pos.getZ(i) - az) > rimR * 0.95) { rimC += pos.getY(i); m++; }
  rimC = m ? rimC / m : yAt(rimB + 0.5);
  const y1 = yAt(b1), y2 = yAt(b2), s = r / rimR, foot = -h - 0.05;
  const Y1 = (y1 - rimC) * s, Y2 = foot + (y2 - min.y) * s;
  const kc = Y1 - Y2 > 0.3 && y1 > y2 ? (Y1 - Y2) / (y1 - y2) : s;
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    const ny = y >= y1 ? (y - rimC) * s : y >= y2 ? Y2 + (y - y2) * kc : foot + (y - min.y) * s;
    pos.setXYZ(i, (pos.getX(i) - ax) * s, ny, (pos.getZ(i) - az) * s);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  // its own copy of the material without the faint glow Meshy baked in (a steel terminal never lights up)
  const material = src.material.clone();
  material.emissiveMap = null; material.emissive.setRGB(0, 0, 0);
  const fit = { geometry: geo, low: clusterDecimate(geo, (H * s) * 0.015), material, footR: Math.max(rad[0], rad[1], rad[2]) * s };
  bullwheelFits.set(key, fit);
  return fit;
}

// the haul rope's half loop round the back of a chairlift bullwheel (-z), at rope height
const loopGeos = new Map();
function ropeLoopGeometry(r) {
  if (!loopGeos.has(r)) {
    const g = new THREE.TorusGeometry(r, 0.04, 6, 40, Math.PI);
    g.rotateX(Math.PI / 2);
    g.rotateY(Math.PI);
    loopGeos.set(r, g);
  }
  return loopGeos.get(r);
}
let loopMat = null;
const ropeLoopMaterial = () => (loopMat ??= new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.8 }));
function bullwheelMaterial() {
  wheelMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.55 });
  return wheelMat;
}

// the podium under the hall: a concrete base with a timber-clad, windowed band on the long sides, and the stair
// from the deck down to the pad on the side of the nearby run (local frame as midStationGeometry)
const podiumCache = new Map();
function podiumGeometry(side) {
  if (podiumCache.has(side)) return podiumCache.get(side);
  const parts = [];
  const box = (x, y, z, sx, sy, sz, col, rx = 0) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, 0, 0)), _s.set(1, 1, 1)));
    const n = g.attributes.position.count, cols = new Float32Array(n * 3);
    _c.set(col);
    for (let i = 0; i < n; i++) { cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  };
  const W = HALL_W - 0.5, L = HALL_LEN - 0.6, top = HALL_BASE + 0.1, hw = W / 2, hl = L / 2;
  const CONC = '#8f9297', CONC_D = '#74777c', WOOD = ['#80593a', '#77522f', '#8a6240'], GLASS = '#26384a', WHITE = '#f2f2ef', STEEL_D = '#6b7178';
  box(0, (top - 4) / 2, 0, W, top + 4, L, CONC); // the core, down into the ground
  box(0, top - 0.12, 0, W + 0.3, 0.24, L + 0.3, CONC_D); // deck edge under the hall's floor
  for (const sx of [-1, 1]) {
    // larch boards over the long sides, with windows into the machine rooms
    const boards = 30;
    for (let i = 0; i < boards; i++) {
      const z = -hl + 0.6 + (i + 0.5) * ((L - 1.2) / boards);
      box(sx * (hw + 0.04), 1.75, z, 0.06, 2.3, (L - 1.2) / boards - 0.03, WOOD[i % 3]);
    }
    for (const z of [-8.5, -3, 3, 8.5]) {
      box(sx * (hw + 0.09), 1.85, z, 0.06, 1.2, 2.6, WHITE);
      box(sx * (hw + 0.12), 1.85, z, 0.05, 1.0, 2.4, GLASS);
    }
  }
  for (const sz of [-1, 1]) {
    // the ends under the cabin lanes: larch boards over a concrete plinth, a steel fascia under the deck
    const boards = 34;
    for (let i = 0; i < boards; i++) {
      const x = -hw + 0.6 + (i + 0.5) * ((W - 1.2) / boards);
      box(x, 1.75, sz * (hl + 0.04), (W - 1.2) / boards - 0.03, 2.3, 0.06, WOOD[i % 3]);
    }
    box(0, 0.3, sz * (hl + 0.03), W - 0.4, 0.6, 0.06, CONC_D);
    box(0, top - 0.45, sz * (hl + 0.08), W + 0.2, 0.35, 0.08, STEEL_D);
  }
  // stair down the outside of the podium, from the hall's floor to the pad
  const st = -(side || 1), steps = 16, rise = DECK / steps, run = 0.42, sxs = st * (hw + 1.05), z0 = 4.8, z1 = 7.6;
  for (let i = 0; i < steps; i++) box(sxs, DECK - (i + 1) * rise - 0.04, z0 - (i + 0.5) * run, 1.5, 0.08, run + 0.02, '#9a9ea4');
  box(sxs, DECK - 0.04, (z0 + z1) / 2, 1.5, 0.08, z1 - z0 + 0.1, '#9a9ea4'); // landing at the top
  const sl = Math.hypot(steps * run, DECK), ang = Math.atan2(DECK, steps * run), zc = z0 - (steps * run) / 2;
  for (const o of [-0.78, 0.78]) {
    box(sxs + o, DECK / 2 - 0.12, zc, 0.08, 0.3, sl, STEEL_D, -ang);
    box(sxs + o, DECK / 2 + 0.85, zc, 0.05, 0.05, sl, STEEL_D, -ang);
  }
  box(sxs + st * 0.78, DECK + 0.55, (z0 + z1) / 2, 0.05, 1.1, z1 - z0, STEEL_D); // landing rail
  box(sxs + st * 0.78, DECK + 1.1, (z0 + z1) / 2, 0.07, 0.07, z1 - z0, STEEL_D);
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  geo.computeBoundingSphere();
  podiumCache.set(side, geo);
  return geo;
}

// ------------------------------------------------------------------ crash padding around tower bases
// Blue mattresses strapped round the tower's legs, sized to the model's real base footprint.
let towerBase = null;
function towerFootprint(gltf) {
  if (towerBase) return towerBase;
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), low = new THREE.Box3();
  const v = new THREE.Vector3(), cut = box.min.y + (box.max.y - box.min.y) * 0.06;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y <= cut) low.expandByPoint(v);
    }
  });
  const c = box.getCenter(new THREE.Vector3()), lc = low.getCenter(new THREE.Vector3()), ls = low.getSize(new THREE.Vector3());
  const H = box.max.y - box.min.y;
  // in units of the fitted height: offset of the base centre from the model's XZ centre, and its half size
  towerBase = { ox: (lc.x - c.x) / H, oz: (lc.z - c.z) / H, hx: ls.x / 2 / H, hz: ls.z / 2 / H };
  return towerBase;
}
let padGeo = null;
// the lowest drawn ground under a round footprint (centre + 8 points on radius r): a flat-bottomed model set there
// never hangs over the downhill side
function footMin(x, z, r) {
  let h = drawnHeight(x, z);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; h = Math.min(h, drawnHeight(x + Math.cos(a) * r, z + Math.sin(a) * r)); }
  return h;
}
function footMax(x, z, r) {
  let h = drawnHeight(x, z);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; h = Math.max(h, drawnHeight(x + Math.cos(a) * r, z + Math.sin(a) * r)); }
  return h;
}

function towerPadding(gltf, pads, yaw) {
  const fp = towerFootprint(gltf);
  if (!padGeo) {
    // an octagonal wrap 1 m across (scaled per tower), 2.8 m tall, blue with white straps and a red top band
    const parts = [];
    const ring = (y0, y1, r0, r1, col) => {
      const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, 8, 1, false).toNonIndexed();
      g.rotateY(Math.PI / 8);
      g.translate(0, (y0 + y1) / 2, 0);
      const n = g.attributes.position.count, cols = new Float32Array(n * 3);
      _c.set(col);
      for (let i = 0; i < n; i++) { cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      parts.push(g);
    };
    ring(-0.3, 0.55, 0.52, 0.52, '#1d4fa8');
    ring(0.55, 0.62, 0.525, 0.525, '#f2f2f2');
    ring(0.62, 1.55, 0.52, 0.52, '#1d4fa8');
    ring(1.55, 1.62, 0.525, 0.525, '#f2f2f2');
    ring(1.62, 2.3, 0.52, 0.5, '#1d4fa8');
    ring(2.3, 2.55, 0.5, 0.47, '#c8261d');
    ring(2.55, 2.62, 0.47, 0.3, '#c8261d');
    padGeo = mergeGeometries(parts);
  }
  const mesh = new THREE.InstancedMesh(padGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), pads.length);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  pads.forEach(({ t, h, s }, i) => {
    // base centre in world space (the model is centred on its XZ bounds, then turned and slimmed)
    const lx = fp.ox * h * s, lz = fp.oz * h * s;
    const x = t.x + lx * cy + lz * sy, z = t.z - lx * sy + lz * cy;
    const w = (Math.max(fp.hx, fp.hz) * h * s + 0.3) * 2;
    // its downhill side on the snow too; on a steep side it stretches up so ~1.9 m still shows above the
    // uphill snow (a level wrap there was swallowed whole)
    const g0 = footMin(x, z, w * 0.5), stretch = Math.min(2.2, Math.max(1, (footMax(x, z, w * 0.5) + 1.9 - g0) / 2.62));
    _o.position.set(x, g0, z);
    _o.rotation.set(0, yaw, 0);
    _o.scale.set(w, stretch, w);
    _o.updateMatrix();
    mesh.setMatrixAt(i, _o.matrix);
  });
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  mesh.name = 'tower-padding';
  return mesh;
}

export class Lifts {
  constructor(scene, models, colliders, layout) {
    this.scene = scene;
    this.models = models;
    this.colliders = colliders;
    this.lines = [];
    this.timeScale = 1;
    this.ride = null;
    for (const l of layout.lifts) this.add(l);
    layout.onAdd((kind, obj) => { if (kind === 'lift') this.add(obj); });
  }

  add(spec) { const l = new LiftLine(spec, this.models, this.scene, this.colliders); l.mpId = this.lines.length; this.lines.push(l); l.setDwell(!!this._mp); }
  // multiplayer (net/transit.js sets the shared-timeline hooks): every line crawls through its end stations then
  get mp() { return this._mp || null; }
  set mp(v) { this._mp = v || null; for (const l of this.lines) l.setDwell(!!v); }

  /** Swap every mid-station to the Meshy hall (the gltf of models/gondola_terminal) or back to the built hall (null). */
  setMidModel(gltf) {
    if (gltf) this.models.gondola_terminal = gltf;
    for (const l of this.lines) if (l.mid) { l.useHall = !!gltf; l.buildMid(this.models, this.colliders); }
  }

  /** Debug: per lift, the lowest cabin / chair bottom over the ground along the line (both ways, out of the stations) and the towers added for it. */
  clearanceReport() {
    return this.lines.map((l) => {
      const w = l.worstSpot();
      return { name: l.spec.name, type: l.spec.type, minClear: +w.clear.toFixed(2), need: w.need, at: Math.round(w.u), side: w.side, towers: l.towers.length, added: l.added, issue: !!l.clearIssue };
    });
  }

  update(dt, playerPos) {
    const r = this.ride;
    for (const l of this.lines) {
      const mx = (l.spec.bottom.x + l.spec.top.x) / 2, mz = (l.spec.bottom.z + l.spec.top.z) / 2;
      const near = Math.hypot(playerPos.x - mx, playerPos.z - mz) < 2500 + l.L / 2 || r?.line === l;
      l.group.visible = near;
      if (!near) continue;
      // fast-forwarding rides slow to x2 while the rider's cabin crawls through a mid-station (time to get off)
      const ts = r?.line === l && l.inStation(l.cars[r.idx].s) ? Math.min(this.timeScale, 2) : this.timeScale;
      l.update(dt, ts, playerPos, this.mp ? this.mp.time(l) : null); // (multiplayer: the line's shared timeline, net/transit.js)
    }
  }

  /**
   * Nearest boarding point: { line, up, dist } at a bottom / top station, or at a mid-station
   * { line, up: true, dist, stop: { name }, options: [{ up: true, label }, { up: false, label }] }
   * (a mid-station serves both directions: let the rider pick, then call board(line, up, stop)).
   */
  nearestStation(p) {
    let best = null;
    for (const l of this.lines) {
      const db = Math.hypot(p.x - l.spec.bottom.x, p.z - l.spec.bottom.z);
      if (!best || db < best.dist) best = { line: l, up: true, dist: db };
      // every lift also takes you back down from its top station (gondolas and chairlifts alike)
      const dt = Math.hypot(p.x - l.spec.top.x, p.z - l.spec.top.z);
      if (dt < best.dist) best = { line: l, up: false, dist: dt };
      if (l.mid) {
        const dm = Math.hypot(p.x - l.mid.x, p.z - l.mid.z);
        if (dm < best.dist) {
          const base = l.spec.name.replace(/ Gondola$/, '');
          best = { line: l, up: true, dist: dm, stop: { name: l.mid.name },
            options: [{ up: true, label: `Up to ${l.spec.topName || base + ' summit'}` }, { up: false, label: `Down to ${l.spec.bottomName || base + ' base'}` }] };
        }
      }
    }
    return best;
  }

  /** Board the next cabin: at the bottom (up) / top (down) station, or at the mid-station when `stop` is given. */
  /** The loop position a rider boards at: the bottom (up), the top (down) or the mid-station (stop). */
  boardTarget(line, up, stop = null) { return stop && line.mid ? (up ? line.mid.u : 2 * line.L - line.mid.u) : (up ? 0 : line.L); }
  board(line, up, stop = null) {
    const atMid = !!(stop && line.mid);
    const pick = this.mp ? this.mpPick : null; // multiplayer: the cabin you waited for and the seat the server gave you
    this.mpPick = null;
    if (pick) {
      line.update(0, 1, null, this.mp.time(line));
      this.ride = { line, idx: pick.idx, up, t: 0, clearOfStop: !atMid, seat: pick.seat };
      return line.seatFor(pick.idx, pick.seat);
    }
    const target = atMid ? (up ? line.mid.u : 2 * line.L - line.mid.u) : (up ? 0 : line.L);
    const { idx, t } = line.pickCar(target);
    // bring that cabin to the boarding point: the whole loop moves on (or back) by the same time
    if (line.mid) {
      for (const c of line.cars) line.advance(c, t);
      line.cars[idx].s = (target + 0.5) % (2 * line.L);
    } else {
      // constant line speed: shift the loop so that cabin sits at the boarding point (keeps spacing intact)
      const L2 = 2 * line.L, delta = target + 0.5 - line.cars[idx].s;
      for (const c of line.cars) c.s = (((c.s + delta) % L2) + L2) % L2;
    }
    line.update(0, 1);
    // a rider who boards at the mid-station isn't offered to get off there again
    this.ride = { line, idx, up, t: 0, clearOfStop: !atMid };
    return line.seatFor(idx);
  }

  /**
   * While riding: { seat }, plus stop: { name, exit: { x, z, heading } } while the cabin crawls through a
   * mid-station (main.js offers "get off" and calls leaveAtStop()). On arrival: { exit } and the ride ends.
   * Returns null when not riding.
   */
  updateRide() {
    const r = this.ride;
    if (!r) return null;
    const line = r.line;
    const car = line.cars[r.idx];
    const L = line.L;
    const seat = line.seatFor(r.idx, r.seat ?? -1);
    const arrived = r.up ? car.s >= L - 3 : car.s >= 2 * L - 3 || car.s < 1;
    if (!arrived) {
      if (line.mid) {
        if (!line.inStation(car.s)) r.clearOfStop = true;
        else if (r.clearOfStop) return { seat, stop: { name: line.mid.name, exit: line.midExit() } };
      }
      return { seat };
    }
    this.ride = null;
    if (line.termHall) return { exit: line.terminalExit(r.up) }; // down the stair beside the terminal hall
    const spec = line.spec;
    const end = r.up ? spec.top : spec.bottom;
    const dir = line.dir.clone().multiplyScalar(r.up ? 1 : -1);
    // step out beyond the station, facing downhill
    const ex = end.x + dir.x * (line.cfg.stationSize * 0.5 + 9) + line.sideV.x * 4;
    const ez = end.z + dir.z * (line.cfg.stationSize * 0.5 + 9) + line.sideV.z * 4;
    const [gx, gz] = world.gradient(ex, ez);
    const heading = Math.hypot(gx, gz) > 0.03 ? Math.atan2(-gx, -gz) : Math.atan2(dir.x, dir.z);
    return { exit: { x: ex, z: ez, heading } };
  }

  /** Get off at the mid-station the cabin is passing through: ends the ride and returns the exit spot { x, z, heading } (or null). */
  leaveAtStop() {
    const r = this.ride;
    if (!r || !r.line.mid || !r.line.inStation(r.line.cars[r.idx].s)) return null;
    this.ride = null;
    return r.line.midExit();
  }
}
