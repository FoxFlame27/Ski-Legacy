// Getting hit by vehicles (Oct 29, the user: "also you should be able to get hit by busses and cars"): the mirror of
// peoplehits.js (your car knocking people over). On foot or on skis, a moving vehicle that runs into you at more than
// ~10 km/h knocks you over: the player's own wipeout ('fall' with a tumble) thrown along the vehicle's line and a bit
// up, scaled by the speed; an impact sound and a camera shake. It counts as a crash (main.js: a strike; the second
// brings the rescue helicopter) and a hard hit (50+ km/h) brings the helicopter at once (main.js reads take()).
// After a hit you can't be hit again for 2 s. Never while seated / riding / driving, inside, or in a race session
// (main.js `enabled`). The drivers still brake for you (traffic.js); hits mostly come from stepping out in front.
//
// The vehicles: every moving box collider of
//  - the traffic's cars (game/traffic.js: car.collider),
//  - the ski bus you ride (bus:0) and the fleet on their rounds (game/bus/bus.js: line.collider, line.fleet[].collider),
//  - the CAR RENTAL's tow truck (game/towtruck.js: carRental.truck.collider),
//  - the snow ploughs (world/snowcats.js: cats[].col),
//  - multiplayer: the other players' cars (net/vehicles.js: session.vehicles.cars, col; their interpolated pose).
// Their velocity is measured from the collider's motion frame to frame (the same for every source, the remote cars'
// interpolation included); a jump (respawn, parked far away at 1e9) resets it. Only vehicles within 15 m are tested;
// nothing is allocated per frame (one record per collider, made the first time it is seen).

const R = 0.35;                 // the player's radius (player.js collide)
const MARGIN = 0.15;            // touching counts (the player's own collide has just pushed you out to the edge)
const NEAR = 15;                // m: broad phase
const V_MIN = 10 / 3.6;         // m/s: slower vehicles (and slower closing speeds) only push you softly
const HARD = 50 / 3.6;          // m/s: a hard hit, like a big crash (the rescue helicopter comes)
const SAFE_MS = 2000;           // invulnerable this long after a hit
const JUMP = 70;                // m/s: faster "motion" is a teleport (respawned, parked away): not a velocity
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class VehicleHits {
  /**
   * @param {object} o
   * @param {object} o.player  the Player (pos, vel, mode, crash, shake, camDipV)
   * @param {object} [o.audio]
   * @param {() => boolean} o.enabled  free ride, on foot / on skis outdoors (main.js)
   * @param {() => object} o.sources  { traffic, skibus, carRental, snowcats, multiplayer } (any may be null)
   */
  constructor({ player, audio = null, enabled, sources }) {
    Object.assign(this, { player, audio, enabled, sources });
    this.recs = new Map(); // collider -> { col, o (pose owner: .y), what, px, pz, vx, vz, init, f }
    this.list = [];        // this frame's records (the first `n`)
    this.n = 0;
    this.frame = 0;
    this.safeUntil = -1e9;
    this.hit = { hard: false, kmh: 0, what: 'car', pending: false }; // (reused: take())
    this.addRemote = (c) => this.add(c.col, c, 'car'); // (Map.forEach callback, bound once)
  }

  /** main.js, on the 'crash' event: the vehicle hit behind it (null when it was an ordinary wipeout). */
  take() {
    if (!this.hit.pending) return null;
    this.hit.pending = false;
    return this.hit;
  }

  add(col, o, what) {
    if (!col) return;
    let r = this.recs.get(col);
    if (!r) { r = { col, o, what, px: 0, pz: 0, vx: 0, vz: 0, init: false, f: 0 }; this.recs.set(col, r); }
    r.o = o; r.what = what; r.f = this.frame;
    this.list[this.n++] = r;
  }

  collect() {
    this.n = 0;
    const S = this.sources() || {};
    const cars = S.traffic?.cars;
    if (cars) for (let i = 0; i < cars.length; i++) this.add(cars[i].collider, cars[i], 'car');
    const line = S.skibus?.line;
    if (line) {
      if (line.bus?.group) this.add(line.collider, line.bus.group.position, 'bus');
      const F = line.fleet;
      if (F) for (let i = 0; i < F.length; i++) this.add(F[i].collider, F[i], 'bus');
    }
    const tr = S.carRental?.truck;
    if (tr) this.add(tr.collider, tr.g?.position || tr, 'tow truck');
    const cats = S.snowcats?.cats;
    if (cats) for (let i = 0; i < cats.length; i++) this.add(cats[i].col, cats[i], 'snow plough');
    const rc = S.multiplayer?.vehicles?.cars;
    if (rc && rc.size) rc.forEach(this.addRemote);
    // records of colliders gone for good (a remote car dropped): forgotten now and then
    if ((this.frame & 1023) === 0) for (const [k, r] of this.recs) if (this.frame - r.f > 600) this.recs.delete(k);
  }

  /** Per frame, after every vehicle moved (main.js). dt: the game's (0 while paused). */
  update(dt) {
    if (!(dt > 0)) return;
    this.frame++;
    try { this.collect(); } catch (e) { if (!this.warned) { this.warned = true; console.warn('vehicle hits', e); } return; }
    // velocities from the motion (every vehicle, so it's known before one gets near)
    const k = 1 - Math.exp(-dt * 14);
    for (let i = 0; i < this.n; i++) {
      const r = this.list[i], c = r.col, x = c.x, z = c.z;
      if (!(Math.abs(x) < 1e8)) { r.init = false; r.vx = r.vz = 0; continue; }
      if (!r.init) { r.init = true; r.vx = r.vz = 0; }
      else {
        const vx = (x - r.px) / dt, vz = (z - r.pz) / dt;
        if (vx * vx + vz * vz > JUMP * JUMP) { r.vx = r.vz = 0; }
        else { r.vx += (vx - r.vx) * k; r.vz += (vz - r.vz) * k; }
      }
      r.px = x; r.pz = z;
    }
    const pl = this.player;
    if (pl.mode !== 'ski' && pl.mode !== 'walk') return;
    if (performance.now() < this.safeUntil) return;
    let on = false;
    try { on = !!this.enabled(); } catch { on = false; }
    if (!on) return;
    const p = pl.pos;
    for (let i = 0; i < this.n; i++) {
      const r = this.list[i], c = r.col;
      const dx = p.x - c.x, dz = p.z - c.z;
      if (dx > NEAR || dx < -NEAR || dz > NEAR || dz < -NEAR) continue; // broad phase
      if (r.vx * r.vx + r.vz * r.vz < V_MIN * V_MIN) continue;          // parked / crawling: the soft push
      const oy = r.o?.y;
      if (Number.isFinite(oy) && (p.y - oy > (c.h || 2) + 0.2 || oy - p.y > 3)) continue; // jumped over it / under a bridge
      // into the box's frame (as player.js collide)
      const cs = Math.cos(-c.rot || 0), sn = Math.sin(-c.rot || 0);
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const ex = c.hw + R + MARGIN, ez = c.hd + R + MARGIN;
      if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
      const lvx = r.vx * cs - r.vz * sn, lvz = r.vx * sn + r.vz * cs;
      // which face hit you: the leading one when you're within what it swept through this frame (+ a little), else
      // the side you're on (a vehicle driving past only brushes you: the soft push; a near miss is no hit)
      let nlx = 0, nlz = 0, pen;
      if (Math.abs(lvz) >= Math.abs(lvx)) {
        const s = lvz >= 0 ? 1 : -1, d = ez - lz * s;
        if (d < Math.abs(lvz) * dt * 2 + 0.6 && Math.abs(lx) < c.hw + R) { nlz = s; pen = d; } else { nlx = lx >= 0 ? 1 : -1; pen = ex - Math.abs(lx); }
      } else {
        const s = lvx >= 0 ? 1 : -1, d = ex - lx * s;
        if (d < Math.abs(lvx) * dt * 2 + 0.6 && Math.abs(lz) < c.hd + R) { nlx = s; pen = d; } else { nlz = lz >= 0 ? 1 : -1; pen = ez - Math.abs(lz); }
      }
      const vn = lvx * nlx + lvz * nlz; // the vehicle's speed into you
      if (vn < V_MIN) continue;
      const c2 = Math.cos(c.rot || 0), s2 = Math.sin(c.rot || 0);
      const nx = nlx * c2 - nlz * s2, nz = nlx * s2 + nlz * c2; // (world: out of the box toward you)
      const closing = vn - (pl.vel.x * nx + pl.vel.z * nz);
      if (closing < V_MIN) continue; // (running / skiing away from it about as fast)
      this.knock(r, nx, nz, Math.max(0, pen - MARGIN), closing);
      return;
    }
  }

  knock(r, nx, nz, pen, speed) {
    const pl = this.player, p = pl.pos;
    const hard = speed > HARD;
    this.safeUntil = performance.now() + SAFE_MS;
    // out of the box first, then thrown along its line (and a little off the face that hit you) and a bit up
    p.x += nx * (pen + 0.05); p.z += nz * (pen + 0.05);
    const vs = Math.hypot(r.vx, r.vz) || 1;
    let tx = (r.vx / vs) * 0.8 + nx * 0.2, tz = (r.vz / vs) * 0.8 + nz * 0.2;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const h = clamp(speed + 1.5, 4, 18), up = clamp(1.2 + speed * 0.2, 1.8, 6.5);
    pl.vel.set(tx * h, up, tz * h);
    // the side you go over to: away from the vehicle's line (left / right of its travel)
    const side = (r.vx / vs) * nz - (r.vz / vs) * nx >= 0 ? 1 : -1;
    const H = this.hit;
    H.hard = hard; H.kmh = Math.round(speed * 3.6); H.what = r.what || 'car'; H.pending = true;
    pl.crash(side, { kind: hard ? 'tumble' : speed > 7 ? 'roll' : 'slam', pitchVel: hard ? speed * 0.6 : 0 });
    if (pl.mode === 'fall') pl.fallAir = true; // (flying: lands on the snow, then slides and tumbles on)
    else H.pending = false;
    pl.shake = Math.max(pl.shake || 0, 1);
    pl.camDipV = (pl.camDipV || 0) - (hard ? 5 : 3);
    pl.fovKick = Math.max(pl.fovKick || 0, hard ? 0.8 : 0.4);
    try { this.audio?.impact?.('car', hard ? clamp(speed / 25, 0.6, 1) : clamp(speed / 28, 0.2, 0.5)); } catch { /* (silent) */ }
  }
}
