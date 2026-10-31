// Ambient people: skiers carving down the pistes near the player, villagers strolling the plaza.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { clamp, lerp } from '../core/noise.js';
import { quality } from '../engine/quality.js';
import { Townsfolk } from '../world/townsfolk.js';
import { PeopleSim, away } from '../world/peoplesim.js';
import { getRunIndex } from '../world/crowds.js';
import { newFall, newStumble, stepFall, landed, keepClear } from './peoplehits.js';

const G = 9.81;
const UP = new THREE.Vector3(0, 1, 0);
const _ZERO = new THREE.Vector3();
const _n = new THREE.Vector3(), _fw = new THREE.Vector3(), _side = new THREE.Vector3(), _np = new THREE.Vector3();
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 2);

function resample(pts, step = 1) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    for (let t = 0; t < l; t += step) out.push({ x: ax + ((bx - ax) * t) / l, z: az + ((bz - az) * t) / l });
  }
  return out;
}

// Distant skiers all over the resort: one instanced draw of small figures carving down every piste.
// Only drawn far from the camera (a few pixels tall there); up close the real skier rigs take over.
const FAR_NEAR = 160, FAR_FADE = 50;
const JACKETS = ['#d7263d', '#1546c8', '#f6ae2d', '#2a9d8f', '#ffffff', '#111111', '#e76f51', '#7b2cbf', '#ff6b9a', '#3a86ff'];
class FarSkiers {
  constructor(scene, layout, count) {
    const parts = [];
    const box = (w, h, d, x, y, z, color) => {
      const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
      const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g);
    };
    // skis, legs (dark), jacket (white: tinted per instance), helmet; a slight forward lean
    box(0.09, 0.03, 1.65, -0.11, 0.02, 0.1, '#30343c'); box(0.09, 0.03, 1.65, 0.11, 0.02, 0.1, '#30343c');
    box(0.13, 0.78, 0.16, -0.11, 0.42, 0.04, '#1d2230'); box(0.13, 0.78, 0.16, 0.11, 0.42, 0.04, '#1d2230');
    box(0.44, 0.62, 0.3, 0, 1.12, 0.12, '#ffffff');
    box(0.22, 0.24, 0.24, 0, 1.55, 0.2, '#e8ecf2');
    const geo = mergeGeos(parts);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'far-skiers';
    scene.add(this.mesh);
    this.paths = layout.pistes.map((pi) => resample(pi.pts, 2)).filter((p) => p.length > 60);
    this.s = [];
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      this.s.push(this.spawn({}, true));
      // jacket colour: the white parts take the tint, dark parts stay dark (vertex colours x instance colour)
      this.mesh.setColorAt(i, tint.set(JACKETS[i % JACKETS.length]).lerp(new THREE.Color('#ffffff'), 0.15));
    }
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.lq = new THREE.Quaternion(); this.sc = new THREE.Vector3(); this.p = new THREE.Vector3();
  }

  spawn(o, anywhere = false) {
    if (!this.paths.length) return o;
    o.path = this.paths[Math.floor(Math.random() * this.paths.length)];
    o.u = (anywhere ? Math.random() * 0.9 : Math.random() * 0.3) * (o.path.length - 4); // new ones start high up
    o.v = 4 + Math.random() * 5; o.amp = 3 + Math.random() * 7; o.wave = 22 + Math.random() * 26; o.phase = Math.random() * 6.28;
    o.heading = 0;
    return o;
  }

  update(dt, camera, dayFactor) {
    const cam = camera.position;
    const active = Math.round(this.s.length * (0.2 + 0.8 * dayFactor)); // fewer people out at night
    for (let i = 0; i < this.s.length; i++) {
      const o = this.s[i];
      if (!o.path) continue;
      o.u += (o.v * dt) / 2;
      if (o.u >= o.path.length - 3) this.spawn(o); // finished this run: start a new one (o.path changes)
      const P = o.path;
      const i0 = Math.min(Math.max(0, Math.floor(o.u)), P.length - 2), f = clamp(o.u - i0, 0, 1), c0 = P[i0], c1 = P[i0 + 1];
      const tx = c1.x - c0.x, tz = c1.z - c0.z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
      const ph = (o.u * 2) / o.wave * 6.283 + o.phase, lat = Math.sin(ph) * o.amp, dl = Math.cos(ph) * o.amp * 6.283 / o.wave;
      const x = c0.x + tx * f + nx * lat, z = c0.z + tz * f + nz * lat;
      const y = world.height(x, z);
      const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
      // hidden near the camera (real rigs there) and when not "out" (night); grows in over FAR_FADE metres
      const k = i >= active ? 0 : clamp((d - FAR_NEAR) / FAR_FADE, 0, 1);
      o.heading = Math.atan2(tx / tl + nx * dl * 0.5, tz / tl + nz * dl * 0.5);
      this.q.setFromAxisAngle(UP, o.heading);
      this.q.premultiply(this.lq.setFromAxisAngle(_fw.set(Math.sin(o.heading), 0, Math.cos(o.heading)), -Math.cos(ph) * 0.35)); // lean into the turn
      this.m.compose(this.p.set(x, y, z), this.q, this.sc.setScalar(k * 1.05));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function mergeGeos(parts) {
  let n = 0;
  for (const g of parts) n += g.index.count;
  const pos = [], nor = [], col = [], idx = [];
  let base = 0;
  for (const g of parts) {
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); col.push(...g.attributes.color.array);
    for (const i of g.index.array) idx.push(i + base);
    base += g.attributes.position.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

export class NPCs {
  constructor({ scene, makeSkier, layout, fx, village = null, colliders = [], racing = null }) {
    this.scene = scene;
    this.colliders = colliders; // (a villager thrown by a vehicle stops at a wall: updateDown)
    this.makeSkier = makeSkier;
    this.layout = layout;
    this.fx = fx;
    this.racing = racing; // () => the resort race running now (NPC skiers keep off its line) | null
    // the village's people, the lift bases' and bus stops' (instanced, world/townsfolk.js)
    try { this.town = village ? new Townsfolk({ scene, layout, village, colliders }) : null; } catch (e) { console.warn('townsfolk', e); this.town = null; }
    // people all over the mountain, not just around you (cheap figures far away)
    this.far = new FarSkiers(scene, layout, Math.round(60 + 5 * quality.npcs.skiers));
    this.skiers = [];
    this.walkers = [];
    this.near = []; // positions of the people near the player (player.people)
    this.paths = new Map();
    this.maxSkiers = Infinity; // (cap on top of the graphics preset's quality.npcs.skiers)
    this.spawnTimer = 0;
    this.pool = []; // rigs of skiers that left, reused (building a rig clones a skinned model: a frame spike)
  }

  takeRig(k) {
    const s = this.pool.pop() || this.makeSkier(k);
    s.rig.addTo(this.scene);
    return s;
  }

  releaseRig(s) {
    s.rig.removeFrom(this.scene);
    if (this.pool.length < 16) this.pool.push({ rig: s.rig });
  }

  pathFor(obj, pts) {
    if (!this.paths.has(obj)) this.paths.set(obj, resample(pts));
    return this.paths.get(obj);
  }

  // candidate slopes: the pistes (never the race lines: racers come down those)
  candidates() {
    return this.layout.pistes.map((pi) => [pi, this.pathFor(pi, pi.pts)]);
  }
  // the races whose corridors a piste comes within 25 m of (computed once per piste)
  raceConflicts(pi, path) {
    if (pi._raceNear) return pi._raceNear;
    const idx = getRunIndex(), out = new Set();
    for (let i = 0; i < path.length; i += 6) { if (idx.raceClearance(path[i].x, path[i].z, 30) < 25 && idx.nearest) out.add(idx.nearest); }
    return (pi._raceNear = out);
  }

  spawnSkier(p, camera) {
    const paths = this.candidates(p), race = this.racing?.();
    // find a point on some path 80-450m away, preferably uphill of the player
    for (let tries = 0; tries < 30; tries++) {
      const [pi, path] = paths[Math.floor(Math.random() * paths.length)] || [];
      if (!path || path.length < 100) continue;
      if (race && this.raceConflicts(pi, path).has(race)) continue; // (a race is on: not across its line)
      const u = Math.floor(Math.random() * (path.length - 60));
      const q = path[u];
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < 70 || d > 450) continue;
      const k = this.skiers.length + this.walkers.length;
      const s = this.takeRig(k);
      s.rig.setSkisVisible(true);
      s.rig.setCarry?.(false);
      const style = Math.random();
      const rec = {
        ...s, path, piste: pi, u, v: 3 + Math.random() * 4, amp: 4 + Math.random() * 8, wave: 26 + Math.random() * 30,
        phase: Math.random() * 6.28, maxV: 7 + style * 9, heading: 0, lean: 0, lastTurn: 0, pos: new THREE.Vector3(),
        vel: new THREE.Vector3(), id: 1000 + k * 4, stopT: 0, kind: 'skier', down: null, offX: 0, offZ: 0,
      };
      rec.pos.who = rec; // (the near list holds positions: peoplehits.js finds the skier from it)
      this.skiers.push(rec);
      return;
    }
  }

  removeSkier(i) {
    this.releaseRig(this.skiers[i]);
    this.skiers.splice(i, 1);
  }

  ensureWalkers(p) {
    const inVillage = Math.hypot(p.x, p.z) < 500;
    if (inVillage && this.walkers.length === 0) {
      for (let i = 0; i < quality.npcs.walkers; i++) {
        const s = this.takeRig(i + 3);
        // every other one carries skis on the back (to or from the gondola)
        const carry = i % 2 === 0;
        s.rig.setSkisVisible(carry);
        s.rig.setCarry?.(carry);
        const a = Math.random() * 6.28, r = 14 + Math.random() * 2;
        const pos = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r - 4);
        const rec = { ...s, pos, target: null, route: null, wait: Math.random() * 4, heading: Math.random() * 6.28, speed: 0, carry, kind: 'walker', down: null, id: 900 + i };
        pos.who = rec;
        this.walkers.push(rec);
      }
    } else if (!inVillage && this.walkers.length) {
      for (const w of this.walkers) this.releaseRig(w);
      this.walkers.length = 0;
    }
  }

  // ---- knocked over / stumbling (game/peoplehits.js: you ran into them). o: a skier or walker record. L: a vehicle's
  // throw (peoplehits.js launchFor): flying first (the root lifted off the snow), then the tumble.
  // col: the vehicle's box (kept out of it: peoplehits.js keepClear, Oct 31 2026)
  knock(o, dx, dz, speed, L = null, col = null) {
    const h = o.heading || 0, dr = -dx * Math.cos(h) + dz * Math.sin(h); // the push toward their right (+) / left
    const side = Math.abs(dr) > 0.25 ? Math.sign(dr) : Math.random() < 0.5 ? -1 : 1;
    o.down = newFall(side, dx, dz, speed, L);
    o.down.col = col;
    o.resume = false;
  }
  stumble(o, dx, dz) { o.down = newStumble(dx, dz); o.resume = false; }
  updateDown(o, dt) {
    const F = o.down;
    let done = true;
    try {
      done = stepFall(F, dt, o.heading || 0);
      const p = o.pos;
      p.x += F.vx * dt; p.z += F.vz * dt;
      keepClear(F, p, dt); // (never inside the car that hit them)
      // thrown into a wall, a stall, a lamp post (the village's colliders): stopped there, the push off it gone
      if (o.kind === 'walker' && (F.vx || F.vz)) this.wall(F, p);
      const gy = world.height(p.x, p.z);
      p.y = gy + (F.h || 0); // (flying: over the snow below, never under it)
      if (F.thud) { landed(p.x, gy, p.z, F.thud, F.vx, F.vz); F.thud = 0; }
      o.rig.root.position.copy(p);
      const n = world.normal(p.x, p.z, _n) || UP;
      o.rig.update(dt, { mode: 'fall', heading: o.heading || 0, speed: 0, crouch: 0, lean: 0, tuck: false, plow: 0, normal: n, air: false,
        fall: F, fallSide: F.side, fallHeading: F.hd ?? o.heading ?? 0, fallAir: !!F.air, fallT: F.t / 0.6, flail: F.fl || 0 });
      if (o.rig.fx?.length) this.fx(o.id, o.rig, { grounded: false, speed: 0, vel: o.vel || _ZERO, sideslip: 0, plow: 0, lean: 0 }, dt); // (the body's puffs)
    } catch (e) { console.warn('npc fall', e); done = true; }
    if (done) {
      o.down = null;
      o.resume = true;
      if (o.kind === 'skier') { o.v = 2.5; o.animAcc = 0; } else o.speed = 0;
    }
  }
  // a body sliding / flying into a collider: out of it, and its speed into it gone
  wall(F, p) {
    const C = this.colliders;
    for (let i = 0; i < C.length; i++) {
      const c = C[i], reach = (c.r ?? Math.max(c.hw || 0, c.hd || 0)) + 0.6;
      if (!(Math.abs(p.x - c.x) < reach && Math.abs(p.z - c.z) < reach)) continue;
      const [ux, uz, d] = away(c, p.x, p.z);
      if (d >= 0.35) continue;
      p.x += ux * (0.35 - d); p.z += uz * (0.35 - d);
      const vn = F.vx * ux + F.vz * uz;
      if (vn < 0) {
        F.vx -= ux * vn * 1.2; F.vz -= uz * vn * 1.2; F.vx *= 0.5; F.vz *= 0.5;
        if (-vn > 2) F.thud = Math.max(F.thud || 0, -vn); // (a thump against it)
      }
    }
  }

  /** Multiplayer: nobody but real players (true): the resort's skiers, walkers, villagers and far skiers go. */
  setOff(off) {
    off = !!off;
    if (off === !!this.off) return;
    this.off = off;
    if (off) {
      for (let i = this.skiers.length - 1; i >= 0; i--) { try { this.removeSkier(i); } catch (e) { console.warn('npcs off', e); } }
      for (const w of this.walkers) { try { this.releaseRig(w); } catch { /* gone */ } }
      this.walkers.length = 0;
      this.near.length = 0;
    }
    if (this.far?.mesh) this.far.mesh.visible = !off;
    if (this.town?.group) this.town.group.visible = !off;
  }

  update(dt, playerPos, env, camera) {
    if (this.off) { this.near.length = 0; return; }
    this.ensureWalkers(playerPos);
    if (camera) this.far.update(dt, camera, env.dayFactor);
    PeopleSim.player = { x: playerPos.x, z: playerPos.z };
    if (camera) this.town?.update(dt, camera, env);
    // a race is running: skiers on pistes that cross its line leave while nobody sees them
    const race = this.racing?.();
    if (race && camera) {
      camera.updateMatrixWorld();
      _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (let i = this.skiers.length - 1; i >= 0; i--) {
        const s = this.skiers[i];
        if (!s.piste || !this.raceConflicts(s.piste, s.path).has(race)) continue;
        _sph.center.copy(s.pos);
        if (!_frustum.intersectsSphere(_sph) || s.pos.distanceTo(camera.position) > 160) this.removeSkier(i);
      }
    }
    // fewer people out at night
    const want = Math.round(Math.min(this.maxSkiers, quality.npcs.skiers) * (0.25 + 0.75 * env.dayFactor)), animNear = quality.npcs.animNear;
    this.spawnTimer -= dt;
    if (this.skiers.length < want && this.spawnTimer <= 0) { this.spawnTimer = 1.5; this.spawnSkier(playerPos); }

    for (let i = this.skiers.length - 1; i >= 0; i--) {
      const s = this.skiers[i];
      const P = s.path;
      const iu = Math.floor(s.u);
      if (iu >= P.length - 3 || s.pos.distanceTo(playerPos) > 650 || (this.skiers.length > want && s.pos.distanceTo(playerPos) > 200)) {
        this.removeSkier(i);
        continue;
      }
      if (s.down) { this.updateDown(s, dt); continue; } // knocked over (game/peoplehits.js)
      const a = P[iu], b = P[Math.min(P.length - 1, iu + 4)];
      const ha = world.height(a.x, a.z), hb = world.height(b.x, b.z);
      const slope = (ha - hb) / 4;
      const accel = G * slope / Math.sqrt(1 + slope * slope) - 0.06 * G - 0.004 * s.v * s.v;
      s.v = clamp(s.v + accel * dt, 2.5, s.maxV);
      // S-turns: lateral offset follows a sine along the path
      const prevLat = Math.sin(s.u / s.wave * 6.283 + s.phase) * s.amp;
      s.u += s.v * dt * 0.92;
      const lat = Math.sin(s.u / s.wave * 6.283 + s.phase) * s.amp;
      const i0 = Math.floor(s.u), f = s.u - i0;
      const c0 = P[i0], c1 = P[Math.min(P.length - 1, i0 + 1)];
      const tx = c1.x - c0.x, tz = c1.z - c0.z, tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      let x = lerp(c0.x, c1.x, f) + nx * lat, z = lerp(c0.z, c1.z, f) + nz * lat;
      // back up after a fall: carry on from where the slide left you, easing back onto the line
      if (s.resume) { s.resume = false; s.offX = s.pos.x - x; s.offZ = s.pos.z - z; }
      if (s.offX || s.offZ) {
        x += s.offX; z += s.offZ;
        const k = Math.exp(-dt * 0.9);
        s.offX *= k; s.offZ *= k;
        if (Math.abs(s.offX) + Math.abs(s.offZ) < 0.02) { s.offX = 0; s.offZ = 0; }
      }
      const dlat = (lat - prevLat) / Math.max(1e-3, s.v * dt * 0.92);
      const heading = Math.atan2(tx / tl + nx * dlat, tz / tl + nz * dlat);
      const prevH = s.heading;
      s.heading = heading;
      let dh = heading - prevH; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      s.lean = lerp(s.lean, clamp((-dh / Math.max(dt, 1e-3)) * s.v * 0.08, -1, 1), Math.min(1, dt * 4));
      const np = _np.set(x, world.height(x, z), z);
      s.vel.subVectors(np, s.pos).divideScalar(Math.max(dt, 1e-3));
      if (s.vel.length() > 40) s.vel.set(0, 0, 0);
      s.pos.copy(np);
      s.rig.root.position.copy(np);
      const n = world.normal(x, z, _n) || _n;
      const turn = Math.sign(Math.round(s.lean * 2));
      if (turn !== 0 && turn !== s.lastTurn) {
        const fw = _fw.set(Math.sin(s.heading), 0, Math.cos(s.heading));
        s.rig.startPolePlant(turn < 0 ? 0 : 1, fw, _side.crossVectors(fw, UP));
      }
      s.lastTurn = turn;
      const d = s.pos.distanceTo(playerPos);
      // animation LOD: distant skiers update at a lower rate
      s.animAcc = (s.animAcc || 0) + dt;
      if (d < animNear || s.animAcc > (d < animNear * 2.5 ? 0.06 : 0.12)) {
        s.rig.update(s.animAcc, { mode: 'ski', heading: s.heading, crouch: 0.3 + Math.abs(s.lean) * 0.25, lean: s.lean, tuck: false, plow: 0, speed: s.v, normal: n, air: false });
        s.animAcc = 0;
      }
      if (d < 150) this.fx(s.id, s.rig, { grounded: true, speed: s.v, vel: s.vel, sideslip: Math.abs(s.lean) * 0.15, plow: 0, lean: s.lean }, dt);
    }

    const vil = this.town?.village;
    for (const w of this.walkers) {
      if (w.down) { this.updateDown(w, dt); continue; } // knocked over / stumbling (game/peoplehits.js)
      if (!w.target) {
        w.wait -= dt;
        w.speed = lerp(w.speed, 0, Math.min(1, dt * 6));
        if (w.wait <= 0) {
          if (vil) {
            // somewhere on the plaza's paths: the gondola (skiers), the shop, the market, the trail map, a hotel
            const opts = w.carry ? [vil.gondola.out, vil.shop.out, vil.map.at, ...vil.doors.filter((d) => d.kind === 'hotel').map((d) => d.out)]
              : [vil.shop.out, { x: 26.5, z: 6 + Math.random() * 10 }, vil.map.at, vil.gondola.out, ...vil.doors.filter((d) => d.kind === 'hotel').map((d) => d.out)];
            const to = opts[Math.floor(Math.random() * opts.length)];
            w.route = vil.route(w.pos, to);
            const q = w.route.shift();
            w.target = new THREE.Vector3(q.x, 0, q.z);
          } else {
            const a = Math.random() * 6.28, r = 8 + Math.random() * 30;
            w.target = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r - 6);
          }
        }
      } else {
        const dx = w.target.x - w.pos.x, dz = w.target.z - w.pos.z, dd = Math.hypot(dx, dz);
        if (dd < (w.route?.length ? 1.6 : 1)) {
          const q = w.route?.shift();
          if (q) w.target.set(q.x, 0, q.z);
          else { w.target = null; w.route = null; w.wait = 2 + Math.random() * 6; }
        } else {
          const want = Math.atan2(dx, dz);
          let dh = want - w.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          w.heading += dh * Math.min(1, dt * 4);
          w.speed = lerp(w.speed, 1.35, Math.min(1, dt * 3));
          w.pos.x += Math.sin(w.heading) * w.speed * dt;
          w.pos.z += Math.cos(w.heading) * w.speed * dt;
        }
      }
      w.pos.y = world.height(w.pos.x, w.pos.z);
      w.rig.root.position.copy(w.pos);
      // animation LOD as the skiers' (performance pass): walkers further off pose at a lower rate
      const wd = w.pos.distanceTo(playerPos);
      w.animAcc = (w.animAcc || 0) + dt;
      if (wd < animNear || w.animAcc > (wd < animNear * 2.5 ? 0.06 : 0.12)) {
        w.rig.update(w.animAcc, { mode: w.speed > 0.1 ? 'walk' : 'idle', heading: w.heading, speed: w.speed, crouch: 0, lean: 0, plow: 0, normal: UP });
        w.animAcc = 0;
      }
    }
    // people near you, for the player's collisions (positions only: the player bumps off them softly)
    const near = this.near;
    near.length = 0;
    for (const s of this.skiers) if (Math.abs(s.pos.x - playerPos.x) < 50 && Math.abs(s.pos.z - playerPos.z) < 50) near.push(s.pos);
    for (const w of this.walkers) if (Math.abs(w.pos.x - playerPos.x) < 50 && Math.abs(w.pos.z - playerPos.z) < 50) near.push(w.pos);
    // (the instanced people too: the village's, the stations', the lift bases')
    for (const sim of PeopleSim.all) sim.near(playerPos.x, playerPos.z, 30, near);
  }
}
