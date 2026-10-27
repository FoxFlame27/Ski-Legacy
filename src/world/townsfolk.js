// People in Legacy Village and at the lift bases / bus stops around the resort (the stations have their own:
// railpeople.js). In the village they walk the plaza's paths (the ring round the Christmas tree and its spokes,
// world/decor.js) between the hotels, the ski shop, the ticket booth, the gondola, the trail map, the Christmas
// market and the bus stop: skiers carry their skis over the shoulder to the gondola (and back from it), others
// browse the stalls, warm their hands at the fire pit, stop at the tree for a photo, read the trail map and point
// out a run, chat in small groups, wait for the bus. Out at the other lift bases and bus stops a few people stand
// about, chat and come and go (one pool of people serves the few of those places nearest the camera).
//
// The people are the instanced crowd people of fans.js (FanCrowd.dynamic, a few draw calls), moved by
// peoplesim.js; only simulated near the camera, drawn within VIEW m (three LODs), fewer of them out at night.
import * as THREE from 'three';
import { loadFanKits, FanCrowd, FAN_KEYS as K } from './fans.js';
import { PeopleSim } from './peoplesim.js';
import { world } from './world.js';
import { mulberry32 } from '../core/noise.js';

const VIEW = 170, LOD = [18, 50];
const C = { x: 0, z: -4 }, RING = 15;          // the path ring round the Christmas tree (decor.js)
const HOTELS = [[62, 34], [-74, 44], [100, -34], [-108, -60], [22, 92], [-36, 108], [118, 70], [-128, 22]];
const MARKET = [0, 1, 2].map((i) => [30 + i * 0.5, 4 + i * 7.2]);
const FIRE = { x: 22, z: 12 };
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4();
const ang = (x, z) => Math.atan2(z - C.z, x - C.x);
const wrapA = (a) => { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a; };

// ------------------------------------------------------------------ the village
class Village {
  constructor({ kits, rnd, parent, village, layout, colliders, n = 56 }) {
    this.rnd = rnd;
    this.time = 0; this.spawnT = 0; this.active = false; this.idleFor = 1e9;
    const spots = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, yaw: 0, free: 0.5, prop: 0 }));
    this.crowd = new FanCrowd(kits, spots, rnd, { parent, name: 'village-people', shadows: false, dynamic: true, bounds: { center: new THREE.Vector3(0, world.height(0, 0), 0), radius: 150 } });
    // obstacles near the plaza (lamps, benches, stalls, signs, racks, buildings) for walking round them
    const obst = colliders.filter((c) => Math.abs(c.x) < 170 && Math.abs(c.z) < 170);
    this.sim = new PeopleSim(this.crowd, { groundY: (x, z) => world.height(x, z), obstacles: obst });
    this.center = new THREE.Vector3(0, world.height(0, -4), -4);
    // places: where people come on / go off stage (doors), where they do things
    const P = (x, z) => ({ x, z });
    const sd = village.shopDoor, sf = village.shopFront || new THREE.Vector3(0, 0, 1);
    this.doors = [];
    for (const [x, z] of HOTELS) {
      // (the hotels face the plaza: their door on the front, ~7 m from the middle)
      const l = Math.hypot(x, z) || 1, d = P(x - (x / l) * 7.4, z - (z / l) * 7.4);
      this.doors.push({ kind: 'hotel', in: d, out: P(x - (x / l) * 12.5, z - (z / l) * 12.5), w: 1 });
    }
    this.shop = { kind: 'shop', in: P(sd.x - sf.x * 1.4, sd.z - sf.z * 1.4), out: P(sd.x + sf.x * 1.6, sd.z + sf.z * 1.6), w: 1.4,
      face: Math.atan2(-sf.x, -sf.z), window: P(sd.x + sf.x * 1.5 + sf.z * 2.4, sd.z + sf.z * 1.5 - sf.x * 2.4) };
    this.doors.push(this.shop);
    this.gondola = { kind: 'gondola', in: P(0, -62), out: P(0, -53), w: 2 };
    this.doors.push(this.gondola);
    for (const l of layout.lifts) {
      if (!l.village) continue;
      const e = P(l.bottom.x - l.dir[0] * 16, l.bottom.z - l.dir[1] * 16);
      this.doors.push({ kind: 'gondola', in: P(l.bottom.x - l.dir[0] * 9, l.bottom.z - l.dir[1] * 9), out: e, w: 1 });
    }
    const bs = layout.busStops?.[0];
    this.bus = bs ? { x: bs.x, z: bs.z, heading: bs.heading } : null;
    const bc = village.booth?.counter, bf = village.booth?.front;
    this.booth = bc && bf ? { at: P(bc.x + bf.x * 0.5, bc.z + bf.z * 0.5), face: Math.atan2(-bf.x, -bf.z) } : null;
    this.map = { at: P(8, -21.6), face: Math.PI };
  }

  // ---- routes: along the path ring between the spokes
  ringPt(a, lane) { return { x: C.x + Math.cos(a) * (RING + lane), z: C.z + Math.sin(a) * (RING + lane) }; }
  route(from, to, lane = (this.rnd() - 0.5) * 1.8) {
    const a0 = ang(from.x, from.z), a1 = ang(to.x, to.z);
    const r0 = Math.hypot(from.x - C.x, from.z - C.z), r1 = Math.hypot(to.x - C.x, to.z - C.z);
    const pts = [];
    // (inside the ring or right beside it: straight there)
    if (Math.abs(wrapA(a1 - a0)) < 0.5 || (r0 < RING + 4 && r1 < RING + 4 && Math.abs(wrapA(a1 - a0)) < 1.2)) { pts.push(to); return pts; }
    if (r0 > RING + 2) pts.push(this.ringPt(a0, lane));
    const da = wrapA(a1 - a0), steps = Math.max(1, Math.ceil(Math.abs(da) / 0.3));
    for (let k = 1; k < steps; k++) pts.push(this.ringPt(a0 + (da * k) / steps, lane));
    if (r1 > RING + 2) pts.push(this.ringPt(a1, lane));
    pts.push(to);
    return pts;
  }
  pickDoor(kinds) {
    const list = this.doors.filter((d) => kinds.includes(d.kind));
    let r = this.rnd() * list.reduce((a, d) => a + d.w, 0);
    for (const d of list) { r -= d.w; if (r <= 0) return d; }
    return list[0];
  }
  free() { return this.sim.people.find((p) => !p.onStage); }
  onStage() { let k = 0; for (const p of this.sim.people) if (p.onStage && p.fadeTo > 0) k++; return k; }

  // ---- someone comes out of a door with something to do
  spawn(shown = false) {
    const p = this.free();
    if (!p) return null;
    const r = this.rnd();
    let from, plan;
    if (r < 0.26) { from = this.pickDoor(['hotel', 'shop']); plan = 'ski'; }                 // off to the gondola, skis on the shoulder
    else if (r < 0.42) { from = this.pickDoor(['gondola']); plan = 'back'; }                 // back from the slopes
    else if (r < 0.62) { from = this.pickDoor(['hotel', 'gondola']); plan = 'market'; }
    else if (r < 0.74) { from = this.pickDoor(['hotel', 'gondola']); plan = 'shop'; }
    else if (r < 0.84 && this.bus) { from = this.pickDoor(['hotel', 'shop', 'gondola']); plan = 'bus'; }
    else { from = this.pickDoor(['hotel', 'shop', 'gondola']); plan = 'stroll'; }
    const at = from.in;
    this.sim.spawn(p, at.x + (this.rnd() - 0.5) * 0.8, at.z + (this.rnd() - 0.5) * 0.8, Math.atan2(from.out.x - at.x, from.out.z - at.z), { vmax: 1.15 + this.rnd() * 0.25 });
    p.plan = plan; p.from = from; p.carry = plan === 'ski' || plan === 'back' ? 1 : 0;
    p.ghostAt = from.in; // (walking out of the building)
    p.todo = this.agenda(plan);
    p.state = 'walk';
    // a friend along (a third of them): the same plan, side by side, stopping together (and talking: chats())
    let mate = null;
    if (plan !== 'ski' && plan !== 'back' && this.rnd() < 0.35 && (mate = this.free())) {
      const ox = (this.rnd() < 0.5 ? 1 : -1) * 0.85;
      this.sim.spawn(mate, p.x + ox * 0.6, p.z + ox * 0.6, p.yaw, { vmax: p.vmax });
      mate.plan = plan; mate.from = from; mate.ghostAt = from.in; mate.state = 'walk';
      mate.todo = p.todo.map((st) => st.at ? { ...st, at: { x: st.at.x + ox, z: st.at.z + ox * 0.5 }, chat: true, dur: st.dur } : st);
      for (const st of p.todo) if (st.at) st.chat = true;
    }
    this.next(p, from.out);
    if (mate) this.next(mate, { x: from.out.x + 0.7, z: from.out.z + 0.7 });
    if (shown) {
      // stage set: somewhere along the way already
      const k0 = Math.floor(this.rnd() * (p.path?.length || 1));
      for (const q of mate ? [p, mate] : [p]) {
        q.alpha = 1;
        if (q.path?.length > 1) { const k = Math.min(k0, q.path.length - 1), w = q.path[k]; q.x = w.x + (q === mate ? 0.8 : 0); q.z = w.z; q.pi = Math.min(k + 1, q.path.length - 1); }
      }
    }
    return p;
  }
  // a plan as a list of stops: { at, face, hold, look, dur } (the last one: where the person leaves)
  agenda(plan) {
    const R = this.rnd, out = [];
    const tree = () => { const a = R() * Math.PI * 2, r = 4.2 + R() * 1.6, x = C.x + Math.cos(a) * r, z = C.z + Math.sin(a) * r; return { at: { x, z }, face: Math.atan2(C.x - x, C.z - z), look: { x: C.x, y: world.height(0, -4) + 7, z: C.z }, hold: R() < 0.5 ? K.PHONE : 0, dur: 6 + R() * 8 }; };
    const stall = () => { const [x, z] = MARKET[Math.floor(R() * 3)]; return { at: { x: x - 2.7, z: z + (R() - 0.5) * 2.4 }, face: Math.PI / 2, hold: R() < 0.4 ? K.HOLD : 0, dur: 10 + R() * 14, chat: true }; };
    const fire = () => { const a = R() * Math.PI * 2, r = 1.7 + R() * 0.5, x = FIRE.x + Math.cos(a) * r, z = FIRE.z + Math.sin(a) * r; return { at: { x, z }, face: Math.atan2(FIRE.x - x, FIRE.z - z), hold: K.HOLD, dur: 14 + R() * 20, chat: true }; };
    const map = () => ({ at: { x: this.map.at.x + (R() - 0.5) * 2.2, z: this.map.at.z + R() * 0.8 }, face: this.map.face, hold: R() < 0.5 ? K.POINT : 0, look: { x: 8, y: world.height(8, -24) + 1.8, z: -24 }, dur: 6 + R() * 6 });
    const booth = () => this.booth && { at: { x: this.booth.at.x, z: this.booth.at.z }, face: this.booth.face, dur: 5 + R() * 5 };
    const window = () => ({ at: { x: this.shop.window.x + (R() - 0.5) * 1.5, z: this.shop.window.z + (R() - 0.5) * 1.5 }, face: this.shop.face, dur: 5 + R() * 8 });
    const busWait = () => this.bus && { at: { x: this.bus.x + (R() - 0.5) * 4, z: this.bus.z + (R() - 0.5) * 3 }, face: this.bus.heading + Math.PI / 2 + (R() - 0.5) * 1.2, hold: R() < 0.45 ? K.PHONE : 0, dur: 30 + R() * 60, chat: true };
    const leave = (kinds) => ({ door: this.pickDoor(kinds) });
    if (plan === 'ski') {
      if (R() < 0.35) out.push(map());
      if (R() < 0.3 && this.booth) out.push(booth());
      out.push({ door: this.gondola.w && R() < 0.75 ? this.gondola : this.pickDoor(['gondola']) });
    } else if (plan === 'back') {
      if (R() < 0.3) out.push(fire());
      out.push(leave(R() < 0.7 ? ['hotel'] : ['shop']));
    } else if (plan === 'market') {
      out.push(stall());
      if (R() < 0.6) out.push(stall());
      if (R() < 0.7) out.push(fire());
      if (R() < 0.3) out.push(tree());
      out.push(leave(['hotel', 'gondola', 'bus']));
    } else if (plan === 'shop') {
      out.push(window());
      out.push({ door: this.shop });
    } else if (plan === 'bus') {
      if (this.bus) out.push(busWait());
      out.push(leave(['hotel']));
    } else {
      out.push(tree());
      if (R() < 0.5) out.push(R() < 0.5 ? map() : stall());
      out.push(leave(['hotel', 'shop', 'gondola']));
    }
    return out.filter(Boolean);
  }
  // to the next stop of the plan
  next(p, from = null) {
    const stop = p.todo.shift();
    if (!stop) { this.sim.hide(p, 1.5); p.state = 'gone'; return; }
    p.state = 'walk'; p.holdTo = 0; p.look = null; p.talkTo = 0; p.face = null;
    if (stop.door) {
      const d = stop.door;
      const pts = (from ? [from] : []).concat(this.route(from || p, d.out), [d.in]);
      this.sim.setPath(p, pts, () => { this.sim.hide(p, 1.8); p.state = 'gone'; });
      p.ghostAt = d.in; // (into the building through its door)
      return;
    }
    const pts = (from ? [from] : []).concat(this.route(from || p, stop.at));
    if (!from) p.ghostAt = null;
    this.sim.setPath(p, pts, () => {
      p.state = 'stop'; p.face = stop.face; p.look = stop.look || null;
      if (stop.hold) { p.hold = stop.hold; p.holdTo = 1; }
      p.until = this.time + stop.dur; p.stop = stop;
    });
  }
  // people standing at the same place (fire pit, stall, bus stop) talk now and then
  chats() {
    const P = this.sim.people;
    for (const p of P) {
      if (!p.onStage || p.state !== 'stop' || !p.stop?.chat) { if (p.state !== 'stop') p.talkTo = 0; continue; }
      let mate = null, best = 9;
      for (const q of P) {
        if (q === p || !q.onStage || q.state !== 'stop') continue;
        const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
        if (d < best) { best = d; mate = q; }
      }
      if (!mate) { p.talkTo = 0; continue; }
      // turn toward the other one; whoever's turn it is talks with the hands
      p.face = Math.atan2(mate.x - p.x, mate.z - p.z) * 0.7 + (p.stop.face ?? 0) * 0.3;
      p.look = { x: mate.x, z: mate.z };
      p.talkTo = Math.sin(this.time * 0.35 + p.i * 1.7) > 0.2 ? 1 : 0.2;
    }
  }
  update(dt, night) {
    this.time += dt;
    const want = Math.round(this.sim.people.length * (0.78 - 0.5 * night));
    if (!this.active) {
      this.active = true;
      if (this.idleFor > 60) for (let k = 0; k < want * 0.8; k++) this.spawn(true);
    }
    this.idleFor = 0;
    this.spawnT -= dt;
    if (this.spawnT <= 0) { this.spawnT = 1.2 + this.rnd() * 2.5; if (this.onStage() < want) this.spawn(false); }
    for (const p of this.sim.people) {
      if (!p.onStage) continue;
      if (p.state === 'stop' && this.time > p.until) { p.holdTo = 0; this.next(p); }
    }
    if ((this.frame = (this.frame || 0) + 1) % 10 === 0) this.chats();
    this.sim.update(dt);
  }
  sleep(dt) { this.idleFor += dt; this.active = false; }
}

// ------------------------------------------------------------------ lift bases + bus stops out of the village
// One pool of people for the few of these places nearest the camera: a handful each, standing about (talking,
// phones, looking up the slope), a few coming and going with their skis on the shoulder.
class Bases {
  constructor({ kits, rnd, parent, layout, n = 30 }) {
    this.rnd = rnd; this.time = 0;
    const spots = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, yaw: 0, free: 0.5, prop: 0 }));
    this.crowd = new FanCrowd(kits, spots, rnd, { parent, name: 'base-people', shadows: false, dynamic: true, bounds: { center: new THREE.Vector3(), radius: 1e5 } });
    this.sim = new PeopleSim(this.crowd, { groundY: (x, z) => world.height(x, z) });
    this.places = [];
    for (const l of layout.lifts) {
      if (l.village || l.main) continue;
      // in front of the bottom station, off to the side of the way in (the skiers' lane stays clear)
      const [ux, uz] = l.dir, sx = uz, sz = -ux, g = l.type === 'gondola', side = l.id % 2 ? 1 : -1;
      const x = l.bottom.x - ux * (g ? 15 : 10) + sx * side * (g ? 10 : 8), z = l.bottom.z - uz * (g ? 15 : 10) + sz * side * (g ? 10 : 8);
      this.places.push({ kind: 'lift', x, z, sx, sz, ux, uz, n: g ? 7 : 5, r: g ? 6 : 4, entry: { x: l.bottom.x - ux * (g ? 7 : 4), z: l.bottom.z - uz * (g ? 7 : 4) } });
    }
    for (const b of layout.busStops || []) {
      if (Math.hypot(b.x, b.z) < 120) continue; // (the village's stop is the village's)
      this.places.push({ kind: 'bus', x: b.x, z: b.z, heading: b.heading, n: 4, r: 2.5 });
    }
    this.live = new Set();
  }
  fill(pl, shown) {
    const p = this.sim.people.find((q) => !q.onStage);
    if (!p) return;
    const R = this.rnd, a = R() * Math.PI * 2, r = 1 + R() * pl.r;
    const x = pl.x + Math.cos(a) * r, z = pl.z + Math.sin(a) * r;
    this.sim.spawn(p, x, z, R() * 6.28, { shown, vmax: 1.15 + R() * 0.2 });
    p.place = pl; p.state = 'stand'; p.until = this.time + 8 + R() * 20;
    p.carry = pl.kind === 'lift' && R() < 0.45 ? 1 : 0;
    this.pose(p);
  }
  pose(p) {
    const pl = p.place, R = this.rnd;
    p.face = pl.kind === 'bus' ? pl.heading + Math.PI / 2 + (R() - 0.5) : Math.atan2(pl.ux, pl.uz) + (R() - 0.5) * 2.2;
    const r = R();
    p.holdTo = !p.carry && r < 0.35 ? 1 : 0; p.hold = r < 0.2 ? K.PHONE : K.HOLD;
    p.look = pl.kind === 'lift' && R() < 0.4 ? { x: pl.x + pl.ux * 60, y: world.height(pl.x, pl.z) + 25, z: pl.z + pl.uz * 60 } : null;
    p.talkTo = 0;
  }
  update(dt, cam, night) {
    this.time += dt;
    // the places within reach of the camera (nearest first, at most 4)
    const near = this.places.map((pl) => [pl, Math.hypot(pl.x - cam.x, pl.z - cam.z)]).filter(([, d]) => d < 150).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([pl]) => pl);
    const nearSet = new Set(near);
    for (const p of this.sim.people) if (p.onStage && !nearSet.has(p.place)) { p.onStage = false; p.alpha = 0; p.fadeTo = 0; this.crowd.dyn.alpha[p.i] = 0; }
    for (const pl of near) {
      const fresh = !this.live.has(pl);
      let have = 0;
      for (const p of this.sim.people) if (p.onStage && p.place === pl && p.fadeTo > 0) have++;
      const want = Math.round(pl.n * (1 - 0.6 * night));
      if (have < want && (fresh || this.rnd() < dt * 0.15)) for (let k = 0; k < (fresh ? want - have : 1); k++) this.fill(pl, fresh);
    }
    this.live = nearSet;
    for (const p of this.sim.people) {
      if (!p.onStage || p.fadeTo <= 0 || p.path) continue;
      if (this.time < p.until) continue;
      const pl = p.place, R = this.rnd();
      if (pl.kind === 'lift' && p.carry && R < 0.5) {
        // off up the lift: to the way in, gone
        p.state = 'go'; p.holdTo = 0; p.look = null;
        this.sim.setPath(p, [pl.entry], () => this.sim.hide(p, 1.6));
      } else if (R < 0.55) {
        // a few steps, a chat with whoever stands near
        const a = this.rnd() * Math.PI * 2, r = 1 + this.rnd() * pl.r;
        this.sim.setPath(p, [{ x: pl.x + Math.cos(a) * r, z: pl.z + Math.sin(a) * r }], () => this.pose(p));
        p.until = this.time + 10 + this.rnd() * 18;
      } else {
        let mate = null, best = 6;
        for (const q of this.sim.people) { if (q === p || !q.onStage || q.place !== pl) continue; const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < best) { best = d; mate = q; } }
        if (mate) { p.face = Math.atan2(mate.x - p.x, mate.z - p.z); p.look = { x: mate.x, z: mate.z }; p.talkTo = this.rnd() < 0.6 ? 1 : 0.25; p.holdTo = 0; } else this.pose(p);
        p.until = this.time + 8 + this.rnd() * 14;
      }
    }
    this.sim.update(dt);
  }
}

export class Townsfolk {
  /** @param {object} o  scene, layout, village (world/village.js), colliders */
  constructor({ scene, layout, village, colliders = [] }) {
    this.group = new THREE.Group();
    this.group.name = 'townsfolk';
    scene.add(this.group);
    this.stages = [];
    this.time = 0;
    loadFanKits().then((kits) => {
      if (!kits.length) return;
      const rnd = mulberry32(6612);
      try { if (village?.shopDoor) this.village = new Village({ kits, rnd, parent: this.group, village, layout, colliders }); } catch (e) { console.warn('village people', e); }
      try { this.bases = new Bases({ kits, rnd, parent: this.group, layout }); } catch (e) { console.warn('base people', e); }
    }).catch((e) => console.warn('townsfolk', e));
  }

  /** Each frame after the camera is placed. env: dayFactor / nightFactor (fewer people out at night). */
  update(dt, camera, env = null) {
    if (!camera || (!this.village && !this.bases)) return;
    const t0 = performance.now();
    this.time = (this.time + dt) % 3600;
    const night = env ? Math.max(0, Math.min(1, Math.max(env.nightFactor || 0, 1 - (env.dayFactor ?? 1)))) : 0;
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cam = camera.position, c = { cam, frustum: _frustum, view: VIEW, lod: LOD, cheer: 0, player: null, time: this.time, shadows: false };
    const v = this.village;
    if (v) {
      if (Math.hypot(cam.x - v.center.x, cam.z - v.center.z) < 260 && cam.y < v.center.y + 400) { v.update(dt, night); v.crowd.update(dt, c); }
      else { if (v.crowd.visible) { v.crowd.group.visible = false; v.crowd.visible = false; } v.sleep(dt); }
    }
    if (this.bases) { this.bases.update(dt, cam, night); this.bases.crowd.update(dt, c); }
    this.ms = (this.ms || 0) * 0.95 + (performance.now() - t0) * 0.05;
  }
}
