// People who walk about (stations, the village, lift bases): a light simulation over one FanCrowd.dynamic
// (world/fans.js). Each person follows a path of waypoints at their own pace (turning smoothly, slowing for the
// last metres, stepping round the people in front), stands facing somewhere, talks, holds a phone, fades in where
// they come on stage (a door, a platform end) and out where they leave it. Whoever owns the stage decides where
// people go (setPath / stand / leave); this module moves them and hands the crowd its per-person pose inputs.
import { WALK_STRIDE } from './fans.js';

const TAU = Math.PI * 2;
const wrap = (a) => { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };

export class Person {
  constructor(i) {
    this.i = i;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
    this.v = 0; this.vmax = 1.25;
    this.path = null; this.pi = 0; this.onArrive = null; // waypoints [{x, z}], then onArrive(person)
    this.alpha = 0; this.fadeTo = 0; this.fadeRate = 2.2; // on stage 0..1
    this.face = null;   // body yaw wanted while standing (null: keep)
    this.look = null;   // {x, z} the head turns to (null: ahead / around)
    this.talkTo = 0;    // 0..1 talking (gestures)
    this.hold = 0; this.holdTo = 0; // held pose (FAN_KEYS.*) and whether it is wanted (0 / 1)
    this.carry = 0;     // skis over the shoulder
    this.state = 'off'; this.until = 0; // owner's state machine (+ a time it ends)
    this.group = null; this.plan = null; this.slot = null;
    this.onStage = false;
    this.ghostAt = null; // a door: within 4 m of it obstacles are ignored (walking in / out of a building)
    this.tg = null; this.bestD = Infinity; this.stuck = 0;
    this.down = null;   // knocked over / stumbling (knock, stumble: game/peoplehits.js)
  }
  get visible() { return this.alpha > 0.001 || this.fadeTo > 0; }
}

// the closest point of a collider ({x, z, r} circle or {x, z, hw, hd, rot} box) to (x, z): [dx, dz, distance
// outside its surface] (negative inside) (also game/npcs.js: a thrown villager stopped at a wall)
export function away(c, x, z) {
  if (c.r !== undefined) { const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz) || 1e-6; return [dx / d, dz / d, d - c.r]; }
  const cs = Math.cos(-c.rot || 0), sn = Math.sin(-c.rot || 0), dx = x - c.x, dz = z - c.z;
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  const qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz));
  let ex = lx - qx, ez = lz - qz, d = Math.hypot(ex, ez);
  if (d < 1e-6) { // inside: out through the nearest side
    const ox = c.hw - Math.abs(lx), oz = c.hd - Math.abs(lz);
    if (ox < oz) { ex = Math.sign(lx) || 1; ez = 0; d = -ox; } else { ex = 0; ez = Math.sign(lz) || 1; d = -oz; }
  } else { ex /= d; ez /= d; }
  return [ex * cs + ez * sn, -ex * sn + ez * cs, d];
}

// rotate the 3x3 part of the column-major matrix at m[o] by angle a about the horizontal axis (kx, 0, kz) (unit),
// about its origin (the feet); lifted a little as it lies down (the body's thickness: `lift`)
function tilt(m, o, kx, kz, a, lift = 0.06) {
  const c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  for (let col = 0; col < 3; col++) {
    const j = o + col * 4, vx = m[j], vy = m[j + 1], vz = m[j + 2], kv = kx * vx + kz * vz;
    m[j] = vx * c - kz * vy * s + kx * kv * C;
    m[j + 1] = vy * c + (kz * vx - kx * vz) * s;
    m[j + 2] = vz * c + kx * vy * s + kz * kv * C;
  }
  m[o + 13] += lift * Math.abs(s);
}
const G = 9.81;
const BODY_C = 0.9;  // m: the body's centre over the feet (times the person's height scale): a thrown body turns about it
const THICK = 0.15;  // m: lying, the centre's height over the snow (about where the old fall's figure lies)
// a figure tilted by a (about the axis across the throw) and r (about the throw's line): its centre's lowest height
// over the snow (standing c, lying THICK)
const restH = (c, a, r) => { const u = Math.abs(Math.cos(a) * Math.cos(r)); return c * u + THICK * (1 - u); };

export class PeopleSim {
  /**
   * @param {FanCrowd} crowd  a dynamic crowd (its n people become this sim's people)
   * @param {object} o  groundY(x, z, person) -> feet height; obstacles: colliders to walk round
   */
  constructor(crowd, { groundY, obstacles = [] }) {
    this.crowd = crowd;
    this.groundY = groundY;
    this.obst = obstacles.map((c) => ({ ...c, reach: (c.r ?? Math.hypot(c.hw, c.hd)) + 1.6 }));
    // (a grid of 8 m cells: each person only looks at the colliders in its own cell)
    this.grid = new Map();
    for (const c of this.obst) {
      for (let i = Math.floor((c.x - c.reach) / 8); i <= Math.floor((c.x + c.reach) / 8); i++) for (let j = Math.floor((c.z - c.reach) / 8); j <= Math.floor((c.z + c.reach) / 8); j++) {
        const k = i * 65536 + j;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(c);
      }
    }
    this.people = Array.from({ length: crowd.n }, (_, i) => new Person(i));
    this.ms = 0;
    for (const p of this.people) { crowd.dyn.alpha[p.i] = 0; p.sim = this; } // (p.sim: game/peoplehits.js)
    PeopleSim.all.push(this);
  }
  /** On-stage people within r m of (x, z) (for the player's soft bumps). */
  near(x, z, r, out) {
    if (this.crowd.visible === false) return out;
    for (const p of this.people) if (p.onStage && p.alpha > 0.5 && Math.abs(p.x - x) < r && Math.abs(p.z - z) < r) out.push(p);
    return out;
  }

  /** Puts a person on stage at (x, z) facing yaw (fades in unless `shown`). */
  spawn(p, x, z, yaw, { shown = false, vmax = null } = {}) {
    p.x = x; p.z = z; p.yaw = yaw; p.v = 0;
    p.y = this.groundY(x, z, p); p.gx = x; p.gz = z;
    p.alpha = shown ? 1 : 0; p.fadeTo = 1; p.onStage = true; p.down = null;
    p.path = null; p.onArrive = null; p.face = null; p.look = null; p.talkTo = 0; p.holdTo = 0; p.group = null; p.ghostAt = null; p.carry = 0;
    if (vmax) p.vmax = vmax;
    const D = this.crowd.dyn;
    D.walk[p.i] = 0; D.talk[p.i] = 0; D.holdW[p.i] = 0; D.wph[p.i] = Math.random();
    this.crowd.lookY[p.i] = 0; this.crowd.lookP[p.i] = 0;
  }
  /** Walks along waypoints [{x, z}], then calls onArrive(person). */
  setPath(p, pts, onArrive = null) {
    p.path = pts; p.pi = 0; p.onArrive = onArrive; p.face = null; p.talkTo = 0;
  }
  /** Fades out where the person stands (then off stage). */
  hide(p, rate = 2.4) { p.fadeTo = 0; p.fadeRate = rate; }

  /**
   * Knocked over toward (dx, dz) (unit): falls flat, lies a moment, gets up and carries on (game/peoplehits.js). L: a
   * vehicle's throw (peoplehits.js launchFor: vh, vy, spin, twist, lie, up): thrown instead (updateThrown).
   */
  knock(p, dx, dz, speed = 6, L = null) {
    if (L) {
      const c = BODY_C * (this.crowd.scl[p.i * 2 + 1] || 1);
      p.down = {
        t: 0, fall: true, thrown: true, state: 'fly', dx, dz, vx: dx * L.vh, vz: dz * L.vh, c, h: c, vy: L.vy,
        a: 0, w: L.spin, r: 0, rw: L.twist, aT: null, lie: L.lie, up: L.up, lt: 0, aLie: 0, fx: 0, fz: 0,
      };
    } else p.down = { t: 0, fall: true, dx, dz, s: 0, slide: Math.min(3, 0.8 + speed * 0.2), dur: 0.42, lie: 1.3 + Math.random() * 1.2, up: 0.9 };
    p.v = 0;
  }
  /** A stumble: tips with the push and steps back up (0.8 s). */
  stumble(p, dx, dz) { p.down = { t: 0, fall: false, dx, dz, s: 0, slide: 0.45, dur: 0.8 }; p.v = 0; }
  // one frame of a knocked-over / stumbling person: the whole figure tips over about its feet toward the push
  updateDown(p, dt) {
    const K = p.down, i = p.i;
    K.t += dt;
    if (K.thrown) { this.updateThrown(p, K, dt); return; }
    let a, done = false, slideT;
    if (K.fall) {
      const t1 = K.dur, t2 = t1 + K.lie, t3 = t2 + K.up;
      if (K.t < t1) { const u = K.t / t1; a = 1.45 * u * u; }                            // over, faster and faster
      else if (K.t < t2) a = 1.45 - 0.08 * Math.exp(-(K.t - t1) * 9) * Math.abs(Math.sin((K.t - t1) * 22)); // (a small bounce)
      else { const u = Math.min(1, (K.t - t2) / K.up); a = 1.45 * (1 - u * u * (3 - 2 * u)); done = K.t >= t3; }
      slideT = Math.min(1, K.t / (t1 + 0.3));
    } else {
      const u = Math.min(1, K.t / K.dur);
      a = 0.3 * Math.sin(Math.PI * u);
      done = u >= 1;
      slideT = Math.min(1, u * 2);
    }
    const s = K.slide * (1 - (1 - slideT) * (1 - slideT));
    p.x += K.dx * (s - K.s); p.z += K.dz * (s - K.s); K.s = s;
    p.y = this.groundY(p.x, p.z, p); p.gx = p.x; p.gz = p.z;
    this.crowd.setPlace(i, p.x, p.y, p.z, p.yaw);
    if (a > 1e-3) tilt(this.crowd.mat, i * 16, K.dz, -K.dx, a);
    this.calm(p, dt);
    if (done) { p.down = null; p.stuck = 0; }
  }
  // the pose inputs of somebody on the snow: no walking, talking, holding, looking about
  calm(p, dt) {
    const D = this.crowd.dyn, i = p.i;
    D.alpha[i] = p.alpha;
    const k = Math.min(1, dt * 7);
    D.walk[i] -= D.walk[i] * k; D.talk[i] -= D.talk[i] * k; D.holdW[i] -= D.holdW[i] * k;
    D.lookY[i] = 0; D.lookP[i] = 0;
  }
  // Thrown by a vehicle: the body's centre (p.x, p.z; K.h over the snow) flies a ballistic arc, the figure turning
  // about it (a: the somersault across the throw, + = toward the push; r: the twist about the throw's line); landing
  // hard it bounces (a thud, a puff: PeopleSim.onLand), then tumbles on along the snow with friction and settles flat
  // (on the back or the front); lies K.lie s; gets up about its feet (the old fall's get-up). Never under the snow
  // (restH), stopped by the walls it's thrown at (the obstacles).
  updateThrown(p, K, dt) {
    const i = p.i, m = this.crowd.mat, o = i * 16, c = K.c;
    const gy = this.groundY(p.x, p.z, p);
    if (K.state === 'up') {
      const u = Math.min(1, K.lt / K.up);
      K.lt += dt;
      const a = K.aLie * (1 - u * u * (3 - 2 * u));
      p.y = gy; p.gx = p.x; p.gz = p.z;
      this.crowd.setPlace(i, p.x, p.y, p.z, p.yaw);
      if (Math.abs(a) > 1e-3) tilt(m, o, K.dz, -K.dx, a);
      this.calm(p, dt);
      if (u >= 1) { p.down = null; p.stuck = 0; }
      return;
    }
    if (K.state === 'fly') {
      K.vy -= G * dt; K.h += K.vy * dt;
      K.a += K.w * dt; K.r += K.rw * dt;
      p.x += K.vx * dt; p.z += K.vz * dt;
      const floor = restH(c, K.a, K.r);
      if (K.h <= floor) {
        const imp = -K.vy, k = imp > 3 ? 0.6 : 0.8;
        K.h = floor;
        K.vx *= k; K.vz *= k; K.w *= 0.5; K.rw *= 0.5;
        if (imp > 1) PeopleSim.onLand?.(p.x, gy, p.z, imp, K.vx, K.vz);
        if (imp > 2.5) K.vy = imp * 0.3; // a bounce
        else { K.vy = 0; K.state = 'tumble'; K.w = K.w * 0.6 + Math.min(9, Math.hypot(K.vx, K.vz) * 1.2); K.lt = 0; }
      }
    } else if (K.state === 'tumble' || K.state === 'lie') {
      K.lt += dt;
      // the slide: friction on the snow (the limbs dig in as it slows)
      const s = Math.hypot(K.vx, K.vz);
      if (s > 1e-4) { const k = Math.max(0, s - 7.5 * dt) / s; K.vx *= k; K.vz *= k; }
      p.x += K.vx * dt; p.z += K.vz * dt;
      if (K.state === 'tumble') {
        // rolling on along the snow, then settling flat: the nearest lying angle (on the back / the front)
        if (K.aT === null && (Math.abs(K.w) < 3 || (s < 2 && K.lt > 0.5))) {
          const rest = K.a + (K.w * Math.abs(K.w)) / 14;
          K.aT = Math.round((rest - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
        }
        if (K.aT === null) { K.w *= Math.exp(-dt * (s < 1.5 ? 3 : 0.9)); K.a += K.w * dt; }
        else { const d = K.a - K.aT, e = Math.exp(-6 * dt), q = K.w + 6 * d; K.a = K.aT + (d + q * dt) * e; K.w = (K.w - q * 6 * dt) * e; }
        // the twist: back to square
        const rT = Math.round(K.r / TAU) * TAU, dr = K.r - rT, er = Math.exp(-5 * dt), qr = K.rw + 5 * dr;
        K.r = rT + (dr + qr * dt) * er; K.rw = (K.rw - qr * 5 * dt) * er;
        if ((K.aT !== null && Math.abs(K.a - K.aT) < 0.05 && Math.abs(K.w) < 0.4 && Math.abs(K.r - rT) < 0.05 && s < 0.3) || K.lt > 5) {
          // flat: one angle in (-PI, PI] (+-PI/2), no twist
          K.state = 'lie'; K.lt = 0; K.vx = 0; K.vz = 0;
          K.a = K.aT !== null ? K.aT : K.a; K.a -= Math.round(K.a / TAU) * TAU;
          if (Math.abs(Math.abs(K.a) - Math.PI / 2) > 0.3) K.a = Math.sign(K.a || 1) * Math.PI / 2;
          K.r = 0; K.w = 0; K.rw = 0;
        }
      } else if (K.lt > K.lie) {
        // getting up about the feet: the body's centre is half a body from them, toward the head
        const sa = Math.sin(K.a);
        p.x -= K.dx * sa * c; p.z -= K.dz * sa * c;
        K.aLie = 1.45 * Math.sign(sa || 1);
        K.state = 'up'; K.lt = 0;
        this.updateThrown(p, K, 0);
        return;
      }
      K.h = restH(c, K.a, K.r);
    }
    // a wall in the way (lamps, stalls, buildings): out of it, the speed into it gone
    if (K.vx || K.vz) {
      const cell = this.grid.size ? this.grid.get(Math.floor(p.x / 8) * 65536 + Math.floor(p.z / 8)) : null;
      if (cell) for (const ob of cell) {
        if (Math.abs(p.x - ob.x) > ob.reach || Math.abs(p.z - ob.z) > ob.reach) continue;
        const [ux, uz, d] = away(ob, p.x, p.z);
        if (d >= 0.35) continue;
        p.x += ux * (0.35 - d); p.z += uz * (0.35 - d);
        const vn = K.vx * ux + K.vz * uz;
        if (vn < 0) {
          K.vx -= ux * vn * 1.2; K.vz -= uz * vn * 1.2; K.vx *= 0.5; K.vz *= 0.5;
          if (-vn > 2) PeopleSim.onLand?.(p.x, gy + K.h, p.z, -vn, 0, 0);
        }
      }
    }
    // the figure: turned about its centre, the centre placed K.h over the snow
    const g2 = this.groundY(p.x, p.z, p);
    this.crowd.setPlace(i, p.x, g2, p.z, p.yaw);
    tilt(m, o, K.dz, -K.dx, K.a, 0);
    if (K.r) tilt(m, o, K.dx, K.dz, K.r, 0);
    const sy = this.crowd.scl[i * 2 + 1] || 1, k = c / sy; // (column 1: the body's up, times its height scale)
    m[o + 12] = p.x - m[o + 4] * k; m[o + 13] = g2 + K.h - m[o + 5] * k; m[o + 14] = p.z - m[o + 6] * k;
    p.y = g2; p.gx = p.x; p.gz = p.z;
    this.calm(p, dt);
  }

  update(dt) {
    const t0 = performance.now();
    const P = this.people, n = P.length, D = this.crowd.dyn, crowd = this.crowd;
    for (let a = 0; a < n; a++) {
      const p = P[a];
      if (!p.onStage) continue;
      // fade in / out
      if (p.alpha !== p.fadeTo) {
        const s = dt * p.fadeRate;
        p.alpha = p.fadeTo > p.alpha ? Math.min(p.fadeTo, p.alpha + s) : Math.max(p.fadeTo, p.alpha - s);
        if (p.alpha <= 0 && p.fadeTo <= 0) { p.onStage = false; p.path = null; p.v = 0; p.down = null; D.alpha[p.i] = 0; continue; }
      }
      if (p.down) {
        try { this.updateDown(p, dt); } catch (e) { p.down = null; console.warn('crowd person fall', e); }
        continue;
      }
      let ax = 0, az = 0; // avoidance
      if (p.path) {
        // the people close in front (walking) push the heading aside; standing people are walked round
        for (let b = 0; b < n; b++) {
          if (b === a) continue;
          const q = P[b];
          if (!q.onStage || q.alpha < 0.3) continue;
          const dx = p.x - q.x, dz = p.z - q.z, d2 = dx * dx + dz * dz;
          if (d2 > 2.6 || d2 < 1e-6) continue;
          const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
          if (-(dx * fx + dz * fz) < -0.2) continue; // behind me
          const d = Math.sqrt(d2), k = (1.6 - d) / (d * 1.6) * (q.path ? 0.7 : 1.2);
          ax += dx * k; az += dz * k;
        }
        // the player (walking people step round you)
        const pl = PeopleSim.player;
        if (pl) {
          const dx = p.x - pl.x, dz = p.z - pl.z, d2 = dx * dx + dz * dz;
          if (d2 < 4 && d2 > 1e-6 && (dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw)) < 0.3) { const d = Math.sqrt(d2), k = (2 - d) / (d * 2) * 1.4; ax += dx * k; az += dz * k; }
        }
        // lamps, benches, stalls, buildings: steer round them (not near the door the person walks through)
        const ghost = p.ghostAt && (p.x - p.ghostAt.x) ** 2 + (p.z - p.ghostAt.z) ** 2 < 16;
        const cell = this.grid.size ? this.grid.get(Math.floor(p.x / 8) * 65536 + Math.floor(p.z / 8)) : null;
        if (!ghost && cell) for (const c of cell) {
          if (Math.abs(p.x - c.x) > c.reach || Math.abs(p.z - c.z) > c.reach) continue;
          const [ux, uz, d] = away(c, p.x, p.z);
          if (d > 1.3) continue;
          if ((ux * Math.sin(p.yaw) + uz * Math.cos(p.yaw)) > 0.5 && d > 0.5) continue; // (behind: walking away from it)
          const k = (1.3 - Math.max(0, d)) * 1.1;
          ax += ux * k; az += uz * k;
        }
        const tg = p.path[p.pi], dx = tg.x - p.x, dz = tg.z - p.z, d = Math.hypot(dx, dz);
        const last = p.pi === p.path.length - 1;
        // (no headway for 2 s - somebody stands on the spot, a corner: count it as reached)
        if (tg !== p.tg || d < p.bestD - 0.05) { p.tg = tg; p.bestD = d; p.stuck = 0; } else p.stuck += dt;
        if (d < (last ? 0.06 : 0.5) || p.stuck > 2) {
          p.stuck = 0;
          if (!last) p.pi++;
          else { p.path = null; const cb = p.onArrive; p.onArrive = null; cb?.(p); }
        } else {
          let ux = dx / d + ax * 0.8, uz = dz / d + az * 0.8;
          const want = Math.atan2(ux, uz), err = wrap(want - p.yaw);
          p.yaw = wrap(p.yaw + Math.max(-dt * 4.2, Math.min(dt * 4.2, err)));
          const vWant = (last ? Math.min(p.vmax, 0.18 + d * 1.25) : p.vmax) * Math.max(0.15, Math.cos(err));
          p.v += Math.max(-dt * 2.6, Math.min(dt * 1.5, vWant - p.v));
          p.x += Math.sin(p.yaw) * p.v * dt; p.z += Math.cos(p.yaw) * p.v * dt;
        }
      }
      if (!p.path) {
        p.v = Math.max(0, p.v - dt * 3);
        if (p.v > 0) { p.x += Math.sin(p.yaw) * p.v * dt; p.z += Math.cos(p.yaw) * p.v * dt; }
        if (p.face !== null) { const err = wrap(p.face - p.yaw); p.yaw = wrap(p.yaw + Math.max(-dt * 1.9, Math.min(dt * 1.9, err))); }
        // standing people never overlap (a soft push apart)
        for (let b = a + 1; b < n; b++) {
          const q = P[b];
          if (!q.onStage || q.path) continue;
          const dx = p.x - q.x, dz = p.z - q.z, d2 = dx * dx + dz * dz;
          if (d2 > 0.3 || d2 < 1e-6) continue;
          const d = Math.sqrt(d2), push = (0.55 - d) * 0.5 * Math.min(1, dt * 3) / d;
          p.x += dx * push; p.z += dz * push; q.x -= dx * push; q.z -= dz * push;
        }
      }
      // never inside a lamp post, a bench, a wall (unless walking through a door)
      const cell2 = this.grid.size ? this.grid.get(Math.floor(p.x / 8) * 65536 + Math.floor(p.z / 8)) : null;
      if (cell2 && !(p.ghostAt && (p.x - p.ghostAt.x) ** 2 + (p.z - p.ghostAt.z) ** 2 < 16)) {
        for (const c of cell2) {
          if (Math.abs(p.x - c.x) > c.reach || Math.abs(p.z - c.z) > c.reach) continue;
          const [ux, uz, d] = away(c, p.x, p.z);
          if (d < 0.32) { const k = Math.min(0.32 - d, 0.12); p.x += ux * k; p.z += uz * k; }
        }
      }
      if ((p.x - p.gx) ** 2 + (p.z - p.gz) ** 2 > 0.04 || p.gx === undefined) { p.y = this.groundY(p.x, p.z, p); p.gx = p.x; p.gz = p.z; }
      // ---- pose inputs
      const i = p.i;
      crowd.setPlace(i, p.x, p.y, p.z, p.yaw);
      D.alpha[i] = p.alpha;
      const wt = Math.min(1, p.v / 0.75);
      D.walk[i] += (wt - D.walk[i]) * Math.min(1, dt * 7);
      D.wph[i] = (D.wph[i] + (p.v * dt) / WALK_STRIDE) % 1;
      D.talk[i] += (p.talkTo - D.talk[i]) * Math.min(1, dt * 1.6);
      // a held pose: ease out before switching to another one
      if (p.holdTo && D.hold[i] !== p.hold && D.holdW[i] < 0.02) D.hold[i] = p.hold;
      const hw = p.holdTo && D.hold[i] === p.hold ? 1 : 0;
      D.holdW[i] += (hw - D.holdW[i]) * Math.min(1, dt * 2.2);
      D.carry[i] = p.carry;
      let ly = 0, lp = 0.02;
      if (p.look) {
        ly = wrap(Math.atan2(p.look.x - p.x, p.look.z - p.z) - p.yaw);
        ly = Math.max(-1.15, Math.min(1.15, ly));
        if (p.look.y !== undefined) lp = Math.max(-0.35, Math.min(0.4, -Math.atan2(p.look.y - p.y - 1.55, Math.hypot(p.look.x - p.x, p.look.z - p.z))));
      }
      D.lookY[i] = ly * (1 - D.walk[i] * 0.6); D.lookP[i] = lp;
    }
    this.ms = this.ms * 0.95 + (performance.now() - t0) * 0.05;
  }
}
PeopleSim.all = [];      // every simulation (the player bumps off their people: npcs.js)
PeopleSim.player = null; // {x, z}: walking people step round the player
PeopleSim.onLand = null; // (x, y, z, m/s down, vx, vz): a thrown person landed / hit a wall (game/peoplehits.js landed)
