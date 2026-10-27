// Traffic: cars (any of CAR_MODELS, so every car added later drives too) on the bus roads and the car parks' access
// roads. On the road each keeps to the right-hand lane, 30-60 km/h, slower in bends and on steep grades, with smooth
// acceleration; at a junction it may turn off to a car park. In the car park it drives like a person parks: slowly
// along the aisle (10-15 km/h), a smooth turn into a free bay nose in, ending straight and centred; later it reverses
// out in an arc into the aisle, stops a moment, and drives off. At a dead end (the bus stops) it never turns on the
// spot: out of the player's sight it is taken off and comes back from a car park. It keeps its distance behind other
// cars and the bus and stops for you on the road ahead. Soft colliders (you bump off, no wipeout). The wheels spin
// with the distance driven and the front ones steer. At dusk and night the moving cars light up: headlights, tail
// lights (brighter when braking) and a pool of light on the road ahead (no extra scene lights). Only cars near you are
// simulated (600 m), drawn within 300 m, with the decimated model beyond 60 m.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { nightUniform } from '../world/village.js';
import { busRoads, roadAt } from './bus/roads.js';
import { CAR_MODELS, carTemplate, carInstance } from './cars.js';
import { CarPeople } from './carpeople.js';
import { lampsOn, LightPool, hazardPhase } from './carlights.js';

const N_CARS = 12, NEAR_WANT = 6, SIM_R = 600, SHOW_R = 300, LOD_R = 60, LANE = 1.6, BAY_D = 5.2;
// the bus-stop ends of the bus roads are the bus's: cars turn round (or leave, out of sight) this far before them
const END_KEEP = 95;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _p = {}, _q = {}, _a = new THREE.Vector3(), _b = new THREE.Vector3(), _f = new THREE.Vector3();
const BUS_HW = 1.3, BUS_HD = 6; // (the ski bus's footprint: bus.js BUS width 2.55, length 12)

// ------------------------------------------------------------------ other vehicles no car drives through
// Things that are not road traffic but that cars must never drive through (the trains, the helicopter set down on a
// road): each source fills `out` with boxes { x, y, z, yaw (its +z), hw, hd, push }. The traffic and the ski bus
// (bus.js) brake for them in their way (only at about their height: never for a train in a tunnel under the road);
// a `push` box (a train: it keeps its timetable, it never stops) shoves any car on its line off to the side.
const BLOCKERS = [], _boxes = [];
/** Register fill(out) (called every frame); returns a function that unregisters it. */
export function addTrafficBlocker(fill) {
  BLOCKERS.push(fill);
  return () => { const i = BLOCKERS.indexOf(fill); if (i >= 0) BLOCKERS.splice(i, 1); };
}
/** Rail cars: getCars() -> their Object3Ds (placed in world coordinates, +z along the track), hw / hd their half
 * width / length. Express: addTrainBlocker(() => cars, { hw: CAR.hw, hd: CAR.half }). */
export function addTrainBlocker(getCars, { hw = 1.4, hd = 8.6 } = {}) {
  const pool = [];
  return addTrafficBlocker((out) => {
    const cars = getCars() || [];
    for (let k = 0; k < cars.length; k++) {
      const g = cars[k];
      if (!g) continue;
      const b = (pool[k] ||= { hw, hd, push: true });
      _f.set(0, 0, 1).applyQuaternion(g.quaternion);
      b.x = g.position.x; b.y = g.position.y; b.z = g.position.z; b.yaw = Math.atan2(_f.x, _f.z);
      out.push(b);
    }
  });
}
/** This frame's blocker boxes (a shared array: read it, don't keep it). */
export function trafficBlockers() {
  _boxes.length = 0;
  for (const fill of BLOCKERS) { try { fill(_boxes); } catch (e) { if (!fill.warned) { fill.warned = true; console.warn('traffic blocker', e); } } }
  return _boxes;
}
// the box of something (x, z, yaw, half width / length) seen from a car heading (fx, fz): its extent across the
// car's way and along it
function extents(yaw, hw, hd, fx, fz, out) {
  const ca = Math.abs(Math.sin(yaw) * fx + Math.cos(yaw) * fz), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
  out.across = hw * ca + hd * sa; out.along = hw * sa + hd * ca;
  return out;
}
const _ext = {};

// the pool of light a car's headlights throw on the road (a soft additive decal)
function poolTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 112, 4, 32, 64, 70);
  gr.addColorStop(0, 'rgba(255,240,215,0.95)'); gr.addColorStop(0.5, 'rgba(255,236,205,0.35)'); gr.addColorStop(1, 'rgba(255,236,205,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Traffic {
  constructor({ scene, models, colliders, player, camera, skibus = null, makeRig = null }) {
    Object.assign(this, { scene, colliders, player, camera, skibus });
    this.cars = [];
    this.enabled = true;
    const roads = busRoads.roads;
    if (!roads.length) return;
    this.main = roads.filter((r) => !r.access);
    this.access = roads.filter((r) => r.access);
    this.lots = busRoads.lots.filter((l) => !l.building && l.bays?.length);
    // junctions: where each access road meets a bus road
    this.junctions = [];
    for (const r of this.access) {
      const jx = r.X[r.n - 1], jz = r.Z[r.n - 1];
      let best = null;
      for (const m of this.main) for (let i = 0; i < m.n; i++) { const d = Math.hypot(m.X[i] - jx, m.Z[i] - jz); if (!best || d < best.d) best = { m, s: m.S[i], d }; }
      const lot = this.lots.find((l) => Math.hypot(l.ex - r.X[0], l.ez - r.Z[0]) < 12);
      if (best && best.d < 8) this.junctions.push({ access: r, road: best.m, s: best.s, lot });
    }
    const avail = CAR_MODELS.filter(([name]) => models[name]);
    if (!avail.length) return;
    // shared night light pieces
    this.pools = []; // the headlights' pools of light on the road: the few nearest cars at night (carlights.js)
    const colours = [null, 0x1b1d22, 0x9aa0a6, 0x24324e, 0x7a1d1d, 0xf2f2f0];
    for (let k = 0; k < N_CARS; k++) {
      const [name, length] = avail[k % avail.length];
      const car = this.makeCar(carTemplate(models[name], length, name), k, colours[k % colours.length]);
      car.name = name;
      this.cars.push(car);
      this.spawn(car, true);
    }
    // the people in them (baked over the first frames; parked traffic cars show nobody)
    try {
      this.people = new CarPeople(makeRig);
      this.people.ready.then(() => { for (const c of this.cars) { try { c.people = this.people.fill(c.t); if (c.people) c.inst.full.add(c.people); } catch (e) { console.warn('car people', e); } } });
    } catch (e) { console.warn('car people', e); }
  }

  makeCar(t, k, paint) {
    const inst = carInstance(t, { paint, wheels: true });
    const g = inst.group;
    g.name = 'traffic-car';
    const w = t.size.x, l = t.size.z, h = t.size.y;
    // (lights: the car's own lamp meshes glow, inst.lamps; carlights.js lampsOn)
    this.scene.add(g);
    const collider = { x: 1e9, z: 1e9, hw: w / 2 + 0.05, hd: l / 2, rot: 0, soft: true, h, traffic: true };
    this.colliders.push(collider);
    return {
      t, inst, g, collider, w, l, k, mode: 'road', road: null, s: 0, dir: 1, v: 0, vmax: 8.5 + Math.random() * 8,
      x: 0, z: 0, y: 0, yaw: 0, brake: 0, wait: 0, lot: null, bay: null, steer: 0, rev: false, path: null, pause: 0, next: null,
      wheelBase: Math.max(2.4, l * 0.6),
    };
  }

  // a car (re)appears: parked in a car park's free bay (it leaves after a short wait), or on a quiet stretch of road
  spawn(c, first = false) {
    const p = this.player.pos;
    if (this.lots.length && (first ? c.k % 2 === 1 : Math.random() < 0.6)) {
      const lot = this.lots[Math.floor(Math.random() * this.lots.length)];
      const bay = lot.bays.find((b) => !b.taken && !b.traffic);
      if (bay) { this.parkAt(c, lot, bay, first ? 8 + Math.random() * 40 : 4 + Math.random() * 10); return; }
    }
    // on a bus road, away from you (never popping up in view)
    for (let tries = 0; tries < 20; tries++) {
      const r = this.main[Math.floor(Math.random() * this.main.length)];
      const s = END_KEEP + 10 + Math.random() * Math.max(1, r.length - 2 * END_KEEP - 20);
      roadAt(r, s, _p);
      if (!first && Math.hypot(_p.x - p.x, _p.z - p.z) < 220) continue;
      c.mode = 'road'; c.road = r; c.s = s; c.dir = Math.random() < 0.5 ? 1 : -1; c.v = c.vmax * 0.7; c.path = null;
      this.placeOnRoad(c, 0);
      return;
    }
    c.mode = 'gone'; c.g.visible = false; c.collider.x = 1e9; c.wait = 5;
  }

  parkAt(c, lot, bay, wait) {
    if (c.bay && c.bay !== bay) c.bay.traffic = false;
    bay.traffic = true;
    c.mode = 'parked'; c.lot = lot; c.bay = bay; c.wait = wait; c.v = 0; c.path = null; c.rev = false;
    c.x = bay.x; c.z = bay.z; c.yaw = Math.atan2(bay.hx, bay.hz); c.y = world.height(c.x, c.z) + 0.03;
    this.pose(c, 0);
  }

  // ------------------------------------------------------------------ keeping the cars where you are
  // seen from the camera? (within d and not behind it)
  inSight(x, z, d = 260) {
    const cam = this.camera.position, dx = x - cam.x, dz = z - cam.z, dist = Math.hypot(dx, dz);
    if (dist > d) return false;
    const f = this.camera.getWorldDirection(_a);
    return dist < 40 || (dx * f.x + dz * f.z) / dist > -0.15;
  }
  // nearest point of a bus road: { r, s, d }
  project(x, z) {
    let best = null;
    for (const r of this.main) for (let i = 0; i < r.n; i += 2) { const d = Math.hypot(r.X[i] - x, r.Z[i] - z); if (!best || d < best.d) best = { r, s: r.S[i], d }; }
    return best;
  }
  // on the road somewhere around you (150-420 m away), out of sight, clear of the other cars
  recycle(c) {
    const p = this.player.pos;
    for (let tries = 0; tries < 30; tries++) {
      const r = this.main[Math.floor(Math.random() * this.main.length)];
      const s = END_KEEP + 10 + Math.random() * Math.max(1, r.length - 2 * END_KEEP - 20);
      roadAt(r, s, _p);
      const d = Math.hypot(_p.x - p.x, _p.z - p.z);
      if (d < 150 || d > 420 || this.inSight(_p.x, _p.z)) continue;
      if (this.cars.some((o) => o !== c && o.mode !== 'gone' && Math.hypot(o.x - _p.x, o.z - _p.z) < 45)) continue;
      this.putOnRoad(c, r, s, Math.random() < 0.5 ? 1 : -1);
      return true;
    }
    return false;
  }
  putOnRoad(c, r, s, dir, v = null) {
    if (c.bay) { c.bay.traffic = false; c.bay = null; }
    c.mode = 'road'; c.road = r; c.s = clamp(s, 2, r.length - 2); c.dir = dir; c.v = v ?? c.vmax * 0.8; c.path = null; c.rev = false; c.nextJ = undefined; c.pause = 0;
    this.placeOnRoad(c, 0);
  }
  // riding the bus: a car or two ahead of it the same way (at a sensible gap), now and then one coming the other way
  aroundBus(dt) {
    const line = this.skibus?.line;
    if (!line?.riding) return;
    this.busT = (this.busT || 0) - dt;
    if (this.busT > 0) return;
    this.busT = 5;
    const bp = line.bus.group.position, yaw = line.yaw || 0, at = this.project(bp.x, bp.z);
    if (!at || at.d > 12) return;
    roadAt(at.r, at.s, _p);
    const dir = Math.sin(yaw) * _p.dx + Math.cos(yaw) * _p.dz >= 0 ? 1 : -1;
    const ahead = (o, sameWay) => o.mode === 'road' && o.road === at.r && (o.s - at.s) * dir > 0 && (o.s - at.s) * dir < 320 && (o.dir === dir) === sameWay;
    const spare = () => this.cars.filter((o) => o.mode !== 'parked' && !this.inSight(o.x, o.z, 400)).sort((a, b) => Math.hypot(b.x - bp.x, b.z - bp.z) - Math.hypot(a.x - bp.x, a.z - bp.z))[0];
    if (!this.cars.some((o) => ahead(o, true))) {
      const c = spare(), s = at.s + dir * (140 + Math.random() * 40);
      if (c && s > END_KEEP + 30 && s < at.r.length - END_KEEP - 30) this.putOnRoad(c, at.r, s, dir, Math.max(6, line.speed * 0.9));
    } else if (Math.random() < 0.3 && !this.cars.some((o) => ahead(o, false))) {
      const c = spare(), s = at.s + dir * (220 + Math.random() * 60);
      if (c && s > END_KEEP + 30 && s < at.r.length - END_KEEP - 30) this.putOnRoad(c, at.r, s, -dir);
    }
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    if (!this.cars.length || dt <= 0) return;
    try {
      const p = this.player.pos, cam = this.camera.position, night = nightUniform?.value ?? 0;
      // keep the cars near you: far ones (out of sight) come back on the roads around you; some near the bus
      this.recycleT = (this.recycleT || 0) - dt;
      if (this.recycleT <= 0) {
        this.recycleT = 2;
        // trips end, stuck cars are taken off (out of sight), and they come back somewhere else
        for (const c of this.cars) {
          if (c.mode === 'gone') continue;
          c.trip = (c.trip ?? (120 + Math.random() * 180)) - 2;
          // the watchdog: hardly moved in 20 s (and not parked)
          c.wd ||= { x: c.x, z: c.z, t: 0 };
          c.wd.t += 2;
          if (c.wd.t >= 20) { const moved = Math.hypot(c.x - c.wd.x, c.z - c.wd.z); c.stuck = c.mode !== 'parked' && moved < 2; c.wd = { x: c.x, z: c.z, t: 0 }; }
          const away = !this.inSight(c.x, c.z) || Math.hypot(c.x - p.x, c.z - p.z) > 80;
          if (away && ((c.trip <= 0 && c.mode !== 'lot') || c.stuck)) { this.despawn(c); c.trip = undefined; c.stuck = false; continue; }
          // crashed, knocked off the road or stuck: gone soon (3 s out of sight, or after 20 s from 40 m+, sinking
          // away if seen); never beside you (6 m)
          const odd = c.mode === 'wreck' || c.mode === 'knocked' || c.stuck, dP = Math.hypot(c.x - p.x, c.z - p.z);
          if (odd && c.sinkT === undefined && dP > 6) {
            c.oddT = (c.oddT || 0) + 2; c.unseenT = this.inSight(c.x, c.z) ? 0 : (c.unseenT || 0) + 2;
            if (c.unseenT >= 4) { this.despawn(c); continue; }
            if (c.oddT >= 20 && dP > 40) c.sinkT = 0;
          } else if (!odd) { c.oddT = 0; c.unseenT = 0; }
        }
        // about six cars on the roads around you (the rest stay spread over the network)
        let near = this.cars.filter((c) => c.mode !== 'gone' && Math.hypot(c.x - p.x, c.z - p.z) < 420).length;
        for (const c of this.cars) {
          if (near >= NEAR_WANT) break;
          const d = Math.hypot(c.x - p.x, c.z - p.z);
          if ((c.mode === 'gone' || d > 520) && !this.inSight(c.x, c.z) && this.recycle(c)) near++;
        }
      }
      this.aroundBus(dt);
      // the trains and a helicopter on the road: braked for (clearance); a train shoves a car off its line
      this.blk = trafficBlockers();
      if (this.enabled && this.blk.length) this.shoveOff(this.blk);
      const glow = night > 0.18 ? Math.min(1, night * 1.4) : 0;
      const lodR = glow > 0 ? 110 : LOD_R, lit = [], tails = []; // (at night the detailed cars, with their lamps, further out)
      this.tailPools ||= [];
      for (const c of this.cars) {
        if (c.sinkT !== undefined) { c.sinkT += dt; c.g.position.y -= dt * 1.8; if (c.sinkT > 0.8) { this.despawn(c); } continue; }
        const far = Math.hypot(c.x - p.x, c.z - p.z) > SIM_R;
        if (this.enabled && !far) {
          const x0 = c.x, z0 = c.z, yaw0 = c.yaw;
          this.step(c, Math.min(dt, 0.05));
          // the wheels: roll by the distance driven (backwards when reversing); the front ones steer with the turn
          const moved = Math.hypot(c.x - x0, c.z - z0);
          const turn = wrapPi(c.yaw - yaw0) / Math.max(1e-3, dt);
          const steerT = moved > 1e-3 ? clamp(Math.atan(c.wheelBase * turn / Math.max(0.5, moved / dt)) * (c.rev ? -1 : 1), -0.52, 0.52) : c.steer;
          c.steer += (steerT - c.steer) * (1 - Math.exp(-dt * 8));
          for (const w of c.inst.wheels) { w.roll.rotation.x += (c.rev ? -moved : moved) / w.r; if (w.front) w.steer.rotation.y = c.steer; }
        }
        // drawing: the detailed car close by, the light one further out, nothing beyond 300 m
        const d = Math.hypot(c.x - cam.x, c.z - cam.z);
        const show = this.enabled && c.mode !== 'gone' && d < SHOW_R;
        c.g.visible = show;
        if (show) {
          if (!c.inst.far && c.t.lod) { const m = new THREE.Mesh(c.t.lod.geometry, c.t.lod.material); m.visible = false; c.g.add(m); c.inst.far = m; }
          const near = d < lodR || !c.inst.far;
          c.inst.full.visible = near;
          if (c.inst.far) c.inst.far.visible = !near;
          if (c.people) c.people.visible = c.mode !== 'parked';
          // lamps on while it drives at night (parked: off); the brake lights whenever it brakes
          // knocked off the road: its lights stay on (braking while it slides), the hazards flash; at rest (a wreck)
          // hazards, dim tails, the headlights on at night
          const live = near && c.mode !== 'parked' && c.mode !== 'wreck', on = glow > 0 && live ? glow : 0;
          if (near && c.mode === 'wreck') lampsOn(c.inst, glow, 0.55, 0, { hazard: hazardPhase() });
          else lampsOn(c.inst, on, on, live ? c.brake : 0, { drl: live && !on && c.mode !== 'knocked' ? 1 : 0, reverse: live && c.rev, hazard: live && c.mode === 'knocked' ? hazardPhase() : null });
          if (on && d < 120) lit.push([d, c]);
          if (live && d < 70 && (on || (night > 0.05 && (c.inst.lamps?.bs || 0) > 0.02))) tails.push([d, c]);
        } else if (c.inst.lamps?.key && c.inst.lamps.key !== '0|0|0|0|false') lampsOn(c.inst, 0, 0, 0);
        const off = c.mode === 'gone' || !this.enabled;
        c.collider.x = off ? 1e9 : c.x; c.collider.z = off ? 1e9 : c.z; c.collider.rot = -c.yaw;
      }
      // the pools of light on the road: the four nearest lit cars
      lit.sort((a, b) => a[0] - b[0]);
      for (let k = 0; k < 4; k++) {
        const c = lit[k]?.[1];
        if (!c && !this.pools[k]) continue;
        const P = (this.pools[k] ||= new LightPool(this.scene));
        if (c) P.update(c.x, c.z, c.yaw, c.l / 2, world, glow); else P.update(0, 0, 0, 0, world, 0);
      }
      // the tail lights' red glow on the snow behind the two nearest (stronger while they brake)
      try {
        tails.sort((a, b) => a[0] - b[0]);
        for (let k = 0; k < 2; k++) {
          const c = tails[k]?.[1];
          if (!c && !this.tailPools[k]) continue;
          const P = (this.tailPools[k] ||= new LightPool(this.scene, 0xff2a14)), bs = c?.inst.lamps?.bs || 0;
          if (c) P.update(c.x, c.z, c.yaw + Math.PI, c.l / 2, world, glow > 0 ? glow * 0.3 + bs * 0.45 : bs * 0.35, 0.28); else P.update(0, 0, 0, 0, world, 0);
        }
      } catch (e) { if (!this.tailWarn) { this.tailWarn = true; console.warn('traffic tail glow', e); } }
    } catch (e) { console.warn('traffic', e); this.cars.length = 0; }
  }

  step(c, dt) {
    if (c.mode === 'gone') { c.wait -= dt; if (c.wait <= 0) this.spawn(c); return; }
    if (c.mode === 'knocked') { this.slide(c, dt); return; }
    if (c.mode === 'wreck') { c.v = 0; c.brake = 0; return; } // (rests where it stopped, crooked, until the watchdog takes it)
    if (c.mode === 'parked') {
      c.wait -= dt;
      if (c.wait <= 0 && Math.hypot(this.player.pos.x - c.x, this.player.pos.z - c.z) > c.l) this.leaveBay(c);
      return;
    }
    if (c.mode === 'lot') { this.manoeuvre(c, dt); return; }
    this.drive(c, dt);
  }

  // ---- on the road (as it was: following the lane line of the road itself)
  drive(c, dt) {
    const r = c.road, end = c.dir > 0 ? r.length : 0;
    roadAt(r, c.s, _p); roadAt(r, clamp(c.s + c.dir * 14, 0, r.length), _q);
    const turn = Math.abs(wrapPi(Math.atan2(_q.dx, _q.dz) - Math.atan2(_p.dx, _p.dz)));
    let vt = Math.min(c.vmax, Math.sqrt(2.4 / Math.max(1e-4, turn / 14)));
    vt *= 1 - clamp((Math.abs(_p.grade) - 0.07) * 3.2, 0, 0.45);
    const toEnd = Math.abs(end - c.s);
    const J = c.nextJ !== undefined ? c.nextJ : (c.nextJ = this.pickJunction(c));
    const toJ = J ? (J.s - c.s) * c.dir : Infinity;
    if (J && toJ < 30) vt = Math.min(vt, 3 + toJ * 0.3);
    // the end of a bus road is a bus stop (a dead end): no car goes in there, unless it turns off to a car park on the
    // way; it eases down and turns round (or, out of sight, leaves) well before the bus bay
    const toJ0 = J ? (J.s - c.s) * c.dir : Infinity, keepOut = !r.access && !(toJ0 <= toEnd + 0.5);
    if (keepOut && toEnd < END_KEEP + 45) vt = Math.min(vt, 1.5 + Math.max(0, toEnd - END_KEEP) * 0.3);
    if (keepOut && toEnd <= END_KEEP + 1) { this.deadEnd(c); return; }
    if (r.access && c.dir < 0) vt = Math.min(vt, 3.5 + toEnd * 0.15); // (slowing for the car park)
    vt = Math.min(vt, this.clearance(c));
    const dv = vt - c.v;
    c.brake = dv < -0.5 ? clamp(-dv / 4, 0, 1) : 0;
    c.v = Math.max(0, c.v + clamp(dv, -6 * dt, 2.2 * dt));
    c.s = clamp(c.s + c.dir * c.v * dt, 0, r.length);
    if (J && (J.s - c.s) * c.dir <= 0.5) {
      c.nextJ = undefined;
      if (J.lot && J.lot.bays.some((b) => !b.taken && !b.traffic)) { c.road = J.access; c.s = J.access.length - 1; c.dir = -1; c.v = Math.min(c.v, 4); }
    }
    if (c.road === r && (c.dir > 0 ? c.s >= r.length - 0.5 : c.s <= 0.5)) {
      if (r.access && c.dir < 0) { this.enterLot(c); return; }
      if (r.access) {
        const jn = this.junctions.find((j) => j.access === r);
        if (jn) { c.road = jn.road; c.s = jn.s; c.dir = Math.random() < 0.5 ? 1 : -1; c.nextJ = undefined; }
      } else { this.deadEnd(c); return; }
    }
    this.placeOnRoad(c, dt);
  }

  pickJunction(c) {
    if (c.road.access || Math.random() > 0.45) return null;
    let best = null;
    for (const j of this.junctions) {
      if (j.road !== c.road) continue;
      const ahead = (j.s - c.s) * c.dir;
      if (ahead > 2 && (!best || ahead < (best.s - c.s) * c.dir)) best = j;
    }
    return best;
  }

  clearance(c) {
    const s = c.rev ? -1 : 1, fx = Math.sin(c.yaw) * s, fz = Math.cos(c.yaw) * s;
    let lim = Infinity;
    const check = (x, z, gap, stopAt) => {
      const dx = x - c.x, dz = z - c.z, ahead = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
      if (ahead > 0 && ahead < gap && side < 3.2) lim = Math.min(lim, Math.max(0, (ahead - stopAt) * 0.7));
    };
    for (const o of this.cars) if (o !== c && o.mode !== 'gone' && o.mode !== 'parked') check(o.x, o.z, 32, (c.l + o.l) / 2 + 3);
    // parked cars, wrecks and shoved cars in the way (parking.js; the lay-by and bay cars are beside the lane)
    for (const e of this.parking?.cars || []) {
      const g = e.car.position;
      if (Math.abs(g.x - c.x) > 34 || Math.abs(g.z - c.z) > 34) continue;
      const dx = g.x - c.x, dz = g.z - c.z, ahead = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
      if (ahead > 0 && ahead < 30 && side < 2.3) lim = Math.min(lim, Math.max(0, (ahead - (c.l + (e.length || 4.6)) / 2 - 2.5) * 0.7));
    }
    // the car you drive (its body, not just where you sit)
    const dv = this.you?.d;
    if (dv) check(dv.x, dv.z, 32, (c.l + dv.half * 2) / 2 + 3);
    // the bus (its whole length: also when it stands across the way at a junction), the trains and a helicopter on
    // the road (trafficBlockers, at about the car's height)
    const box = (x, z, yaw, hw, hd, gap) => {
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > gap + hd || Math.abs(dz) > gap + hd) return;
      const ahead = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx), e = extents(yaw, hw, hd, fx, fz, _ext);
      if (ahead + e.along > 0.5 && ahead - e.along < gap && side < c.w / 2 + e.across + 0.3) lim = Math.min(lim, Math.max(0, (ahead - e.along - c.l / 2 - 2.5) * 0.7));
    };
    const line = this.skibus?.line, bus = line?.bus?.group;
    if (bus?.visible) box(bus.position.x, bus.position.z, line.yaw || 0, BUS_HW, BUS_HD, 36);
    for (const b of this.blk || []) if (b.y === undefined || Math.abs(b.y - c.y) < 5) box(b.x, b.z, b.yaw, b.hw, b.hd, 40);
    const p = this.player.pos;
    check(p.x, p.z, 26, c.l / 2 + 3);
    return lim;
  }

  placeOnRoad(c, dt) {
    const r = c.road, half = c.l * 0.38;
    roadAt(r, clamp(c.s + c.dir * half, 0, r.length), _p); roadAt(r, clamp(c.s - c.dir * half, 0, r.length), _q);
    const tx = (_p.x - _q.x) || c.dir * _p.dx, tz = (_p.z - _q.z) || c.dir * _p.dz, tl = Math.hypot(tx, tz) || 1;
    const rx = -tz / tl, rz = tx / tl;
    _a.set(_p.x + rx * LANE, _p.y, _p.z + rz * LANE); _b.set(_q.x + rx * LANE, _q.y, _q.z + rz * LANE);
    c.x = (_a.x + _b.x) / 2; c.z = (_a.z + _b.z) / 2; c.y = (_a.y + _b.y) / 2 + 0.02;
    c.yaw = Math.atan2(_a.x - _b.x, _a.z - _b.z);
    this.pose(c, Math.atan2(_b.y - _a.y, Math.hypot(_a.x - _b.x, _a.z - _b.z)));
  }

  // a train keeps its timetable: a car on its line (left there, knocked onto it) is shoved off to the side, the car
  // you drive pushed back off it (a wall you can't drive through)
  shoveOff(blk) {
    for (const b of blk) {
      if (!b.push) continue;
      const sx = Math.sin(b.yaw), sz = Math.cos(b.yaw), rx = sz, rz = -sx; // along the train, across it
      // the push (signed, across the train) that takes a car's box clear of it, or 0
      const hit = (x, y, z, yaw, hw, hd) => {
        if (y !== undefined && b.y !== undefined && Math.abs(y - b.y) > 5) return 0;
        const dx = x - b.x, dz = z - b.z, R = b.hd + hd + 1;
        if (Math.abs(dx) > R || Math.abs(dz) > R) return 0;
        const u = dx * sx + dz * sz, w = dx * rx + dz * rz, e = extents(yaw, hw, hd, sx, sz, _ext);
        if (Math.abs(u) > b.hd + e.along || Math.abs(w) > b.hw + e.across) return 0;
        return (w < 0 ? -1 : 1) * (b.hw + e.across + 0.15) - w;
      };
      for (const c of this.cars) {
        if (c.mode === 'gone' || c.sinkT !== undefined) continue;
        const k = hit(c.x, c.y, c.z, c.yaw, c.w / 2, c.l / 2);
        if (!k) continue;
        const sg = Math.sign(k);
        c.x += rx * k; c.z += rz * k;
        this.knock(c, rx * sg * 3, rz * sg * 3, (Math.random() - 0.5) * 1.5);
        this.pose(c, 0);
      }
      for (const e of this.parking?.cars || []) {
        if (e.driving) continue;
        const g = e.car.position, k = hit(g.x, g.y, g.z, e.car.rotation.y, 0.97, (e.length || 4.6) / 2);
        if (!k) continue;
        const sg = Math.sign(k);
        this.you?.shove?.(e, rx * sg * 2.5, rz * sg * 2.5, (Math.random() - 0.5) * 0.8); // (first: it remembers its bay)
        g.x += rx * k; g.z += rz * k; g.y = world.height(g.x, g.z) + 0.03;
        e.car.updateMatrixWorld(true);
        e.collider.x = g.x; e.collider.z = g.z;
      }
      const d = this.you?.d, k = d ? hit(d.x, d.y, d.z, d.yaw, d.w / 2, d.half) : 0;
      if (k) {
        const sg = Math.sign(k), vn = (d.vx * rx + d.vz * rz) * sg;
        d.x += rx * k; d.z += rz * k;
        if (vn < 0) { d.vx -= rx * sg * vn * 1.2; d.vz -= rz * sg * vn * 1.2; }
      }
    }
  }

  pose(c, pitch = 0) {
    c.g.position.set(c.x, c.y, c.z);
    c.g.rotation.set(pitch, c.yaw, 0, 'YXZ');
  }

  // ---- knocked by the car you drive (drive.js bash): it slides off its lane, turning, to a stop on the snow
  knock(c, vx, vz, w) {
    if (!c || c.mode === 'gone') return;
    if (c.mode === 'road') {
      // off the road: a knock from behind or ahead still sends it toward its own shoulder, turning
      const sp = Math.hypot(vx, vz), rx = -Math.cos(c.yaw), rz = Math.sin(c.yaw);
      vx += rx * sp * 0.35; vz += rz * sp * 0.35;
      w += (Math.random() < 0.5 ? -1 : 1) * Math.min(1.2, sp * 0.09);
    }
    if (c.bay) { c.bay.traffic = false; c.bay = null; }
    c.mode = 'knocked'; c.path = null; c.rev = false; c.v = 0; c.brake = 1; c.pause = 0; c.nextJ = undefined;
    c.kvx = vx; c.kvz = vz; c.kw = clamp(w, -3, 3);
    c.trip = 30 + Math.random() * 30; c.stuck = false; c.wd = { x: c.x, z: c.z, t: 0 };
  }
  slide(c, dt) {
    const sp = Math.hypot(c.kvx, c.kvz);
    const g = world.corridorAt?.(c.x, c.z, this._corr || (this._corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }));
    const mu = g && g.kind === 'lift' && g.d < 0 ? 0.7 : 0.5; // (on the road the tyres scrub harder than in the snow)
    const dec = mu * 9.81 * dt;
    if (sp > dec) { c.kvx -= (c.kvx / sp) * dec; c.kvz -= (c.kvz / sp) * dec; } else { c.kvx = 0; c.kvz = 0; }
    c.kw *= Math.exp(-dt * (1.4 + mu * 2));
    if (!c.kvx && !c.kvz && Math.abs(c.kw) < 0.05) c.kw = 0;
    // never into a building or a tree: it stops against it
    const nx = c.x + c.kvx * dt, nz = c.z + c.kvz * dt;
    let blocked = false;
    for (const o of this.colliders) {
      if (o === c.collider || o.traffic || (o.soft && !o.rail && !o.bus)) continue; // (a guardrail and the bus stop it too)
      const r = o.r ?? Math.max(o.hw, o.hd);
      if (Math.abs(o.x - nx) > r + 2 || Math.abs(o.z - nz) > r + 2) continue;
      if (o.r !== undefined) { if (Math.hypot(nx - o.x, nz - o.z) < o.r + c.w / 2) { blocked = true; break; } }
      else { const cs = Math.cos(-o.rot), sn = Math.sin(-o.rot), lx = (nx - o.x) * cs - (nz - o.z) * sn, lz = (nx - o.x) * sn + (nz - o.z) * cs; if (Math.abs(lx) < o.hw + c.w / 2 && Math.abs(lz) < o.hd + c.w / 2) { blocked = true; break; } }
    }
    if (blocked) { c.kvx = 0; c.kvz = 0; c.kw *= 0.3; }
    else { c.x = nx; c.z = nz; }
    c.yaw = wrapPi(c.yaw + c.kw * dt);
    c.y = world.height(c.x, c.z) + 0.03;
    c.v = 0; c.brake = 1;
    this.pose(c, 0);
    if (!c.kvx && !c.kvz && !c.kw) { c.mode = 'wreck'; c.brake = 0; }
  }

  // off the map for a moment (it comes back elsewhere, out of sight)
  despawn(c) {
    c.kvx = 0; c.kvz = 0; c.kw = 0; c.sinkT = undefined; c.oddT = 0; c.unseenT = 0;
    if (c.bay) { c.bay.traffic = false; c.bay = null; }
    c.mode = 'gone'; c.wait = 1 + Math.random() * 4; c.g.visible = false; c.collider.x = 1e9; c.path = null; c.rev = false;
  }
  // the end of a road: gone at once when nobody sees it (or it is far), else a proper three-point turn
  deadEnd(c) {
    const p = this.player.pos;
    if (!this.inSight(c.x, c.z) || Math.hypot(c.x - p.x, c.z - p.z) > 80) { this.despawn(c); return; }
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), lx = fz, lz = -fx; // forward, left
    const at = (f, l) => ({ x: c.x + fx * f + lx * l, z: c.z + fz * f + lz * l });
    c.mode = 'lot'; c.lot = null; c.v = 0; c.pi = 1; c.next = 'turn1'; c.rev = false;
    c.turnPts = [at(4.5, 3.0), at(1.5, 0.4), at(-5, 1.6)]; // (the last one is the other lane's line: no jump onto it)
    c.path = [{ x: c.x, z: c.z }, at(2.5, 1.8), c.turnPts[0]];
    c.turnRoad = { r: c.road, s: c.s, dir: -c.dir };
  }

  // ---- in the car park: along the aisle, a smooth turn into the bay nose in; later reverse out in an arc, pause, go
  // a point of the lot in its own frame (u along the long side, v across)
  lotPt(L, u, v) { return { x: L.x + L.ux * u + L.vx * v, z: L.z + L.uz * u + L.vz * v }; }
  lotUV(L, x, z) { const dx = x - L.x, dz = z - L.z; return { u: dx * L.ux + dz * L.uz, v: dx * L.vx + dz * L.vz }; }
  // the aisle in front of a bay: its centre line (v) and the side the entrance is on
  aisleFor(L, bay) {
    const b = this.lotUV(L, bay.x, bay.z), hv = bay.hx * L.vx + bay.hz * L.vz; // the nose points along v by hv (+-1)
    return { b, vA: b.v - Math.sign(hv) * (BAY_D / 2 + 3.4) };
  }
  enterLot(c) {
    const lot = this.junctions.find((j) => j.access === c.road)?.lot;
    const bay = lot?.bays.find((b) => !b.taken && !b.traffic);
    if (!lot || !bay) { this.deadEnd(c); return; } // (full: never a U-turn on the spot)
    bay.traffic = true;
    c.lot = lot; c.bay = bay; c.mode = 'lot'; c.rev = false; c.next = 'park'; c.turnRoad = null;
    const e = this.lotUV(lot, lot.ex - lot.dirx * 4, lot.ez - lot.dirz * 4), { b, vA } = this.aisleFor(lot, bay);
    const side = Math.sign(e.u - b.u) || 1; // (it comes along the aisle from the entrance's side)
    const uIn = clamp(e.u, -lot.hw + 3, lot.hw - 3);
    // entrance -> into the aisle -> along it to a few metres short of the bay -> round into the bay -> its middle
    c.path = [this.lotPt(lot, e.u, e.v), this.lotPt(lot, uIn, vA), this.lotPt(lot, b.u + side * 6, vA), this.lotPt(lot, b.u + side * 1.2, (vA + b.v) / 2), { x: bay.x - bay.hx * 1.6, z: bay.z - bay.hz * 1.6 }, { x: bay.x, z: bay.z }];
    c.path.unshift({ x: c.x, z: c.z });
    c.pi = 1;
  }
  leaveBay(c) {
    const lot = c.lot, bay = c.bay;
    const e = this.lotUV(lot, lot.ex - lot.dirx * 4, lot.ez - lot.dirz * 4), { b, vA } = this.aisleFor(lot, bay);
    const side = Math.sign(e.u - b.u) || 1;
    // reverse out: straight back a little, then the back swings away from the exit (the nose turns toward it)
    c.mode = 'lot'; c.rev = true; c.next = 'pause';
    c.path = [{ x: c.x, z: c.z }, { x: bay.x - bay.hx * 2.2, z: bay.z - bay.hz * 2.2 }, this.lotPt(lot, b.u - side * 2.2, (vA + b.v) / 2 + 0 * vA), this.lotPt(lot, b.u - side * 4.5, vA)];
    c.pi = 1;
    c.after = [this.lotPt(lot, b.u - side * 4.5, vA), this.lotPt(lot, b.u + side * 3, vA), this.lotPt(lot, clamp(e.u, -lot.hw + 3, lot.hw - 3), vA), this.lotPt(lot, e.u, e.v), { x: lot.ex + lot.dirx * 2, z: lot.ez + lot.dirz * 2 }];
  }
  // follow the waypoints at walking pace with a smoothly turning steering wheel (pure pursuit, 3.5 m ahead)
  manoeuvre(c, dt) {
    if (c.pause > 0) { c.pause -= dt; c.brake = 1; return; }
    const P = c.path;
    // the look-ahead point along the path
    while (c.pi < P.length - 1 && Math.hypot(P[c.pi].x - c.x, P[c.pi].z - c.z) < 3.0) c.pi++;
    const last = P[P.length - 1], toEnd = Math.hypot(last.x - c.x, last.z - c.z);
    if (c.pi >= P.length - 1 && toEnd < 0.35) { this.endManoeuvre(c); return; }
    const tgt = P[c.pi];
    const fwd = c.rev ? -1 : 1, hx = Math.sin(c.yaw) * fwd, hz = Math.cos(c.yaw) * fwd;
    const dx = tgt.x - c.x, dz = tgt.z - c.z, ld = Math.hypot(dx, dz) || 1;
    const alpha = Math.atan2(dx * hz - dz * hx, dx * hx + dz * hz); // angle to the target (+ = left of the travel direction)
    const want = clamp(Math.atan2(2 * c.wheelBase * Math.sin(alpha), Math.max(2.5, ld)), -0.6, 0.6);
    c.lotSteer = (c.lotSteer || 0) + clamp(want - (c.lotSteer || 0), -dt * 1.2, dt * 1.2);
    // slow: 10-15 km/h forward, walking pace in reverse, easing to a stop at the end (and for anything in the way)
    let vt = c.rev ? 1.4 : 3.6;
    vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * 1.2 * (toEnd - 0.25))) + 0.15, this.clearance(c));
    c.v += clamp(vt - c.v, -3 * dt, 1.2 * dt);
    c.brake = vt < c.v - 0.2 ? 1 : 0;
    const yawRate = (c.v / c.wheelBase) * Math.tan(c.lotSteer) * fwd;
    c.yaw = wrapPi(c.yaw + yawRate * dt);
    c.x += Math.sin(c.yaw) * c.v * dt * fwd; c.z += Math.cos(c.yaw) * c.v * dt * fwd;
    c.y += (world.height(c.x, c.z) + 0.03 - c.y) * (1 - Math.exp(-dt * 10));
    this.pose(c, 0);
  }
  endManoeuvre(c) {
    c.v = 0; c.lotSteer = 0;
    // the three-point turn: forward across, back, forward into the other lane, then on along the road
    if (c.next === 'turn1') { c.next = 'turn2'; c.rev = true; c.path = [c.turnPts[0], c.turnPts[1]]; c.pi = 1; c.pause = 0.4; return; }
    if (c.next === 'turn2') { c.next = 'turn3'; c.rev = false; c.path = [c.turnPts[1], c.turnPts[2]]; c.pi = 1; c.pause = 0.4; return; }
    if (c.next === 'turn3') { const T = c.turnRoad; c.turnRoad = null; c.mode = 'road'; c.road = T.r; c.s = clamp(T.s + T.dir * 5, 1, T.r.length - 1); c.dir = T.dir; c.v = 2; c.nextJ = undefined; this.placeOnRoad(c, 0); return; }
    if (c.next === 'park') {
      // settle straight and centred in the bay
      this.parkAt(c, c.lot, c.bay, 25 + Math.random() * 60);
      return;
    }
    if (c.next === 'pause') { c.rev = false; c.path = c.after; c.after = null; c.pi = 1; c.next = 'out'; c.pause = 0.9; return; }
    // out of the car park: onto the access road, away to the junction
    const jn = this.junctions.find((j) => j.lot === c.lot);
    if (c.bay) { c.bay.traffic = false; c.bay = null; }
    if (jn) { c.mode = 'road'; c.road = jn.access; c.s = 2; c.dir = 1; c.v = 2.5; c.nextJ = undefined; this.placeOnRoad(c, 0); }
    else { c.mode = 'gone'; c.wait = 4; }
  }
}
