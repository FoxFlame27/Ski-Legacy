// Traffic: cars (any of CAR_MODELS, so every car added later drives too) on the bus roads and the car parks' access
// roads. On the road each keeps to the right-hand lane, 30-60 km/h, slower in bends and on steep grades, with smooth
// acceleration; at a junction it may turn off to a car park. In the car park it drives like a person parks: slowly
// along the aisle (10-15 km/h) past a free bay, stops, and backs into it in an arc, ending straight and centred, the
// nose out toward the aisle (like every parked car); later it drives forward out of it in an arc and off. At a dead end (the bus stops) it never turns on the
// spot: out of the player's sight it is taken off and comes back from a car park. It keeps its distance behind other
// cars and the bus and stops for you on the road ahead. Soft colliders (you bump off, no wipeout). The wheels spin
// with the distance driven and the front ones steer. At dusk and night the moving cars light up: headlights, tail
// lights (brighter when braking) and a pool of light on the road ahead (no extra scene lights). Only cars near you are
// simulated (600 m), drawn within 300 m, with the decimated model beyond 60 m.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { nightUniform } from '../world/village.js';
import { busRoads, roadAt, laneDistance, ROAD_HALF } from './bus/roads.js';
import { scenicWalk, scenicSpawn, scenicNetReady } from './bus/scenicdrive.js';
import { CAR_MODELS, CAR_RARE, carTemplate, carInstance, farMesh } from './cars.js';
import { setPlates } from './carconfig.js';
import { CarPeople } from './carpeople.js';
import { lampsOn, LightPool, hazardPhase } from './carlights.js';
import { carPath, linkPath, prepPath, followPath } from './carpath.js';

const N_CARS = 12, N_SCENIC = 6, NEAR_WANT = 6, SIM_R = 600, SHOW_R = 300, LOD_R = 70, LANE = 1.6, BACK_R = 4.6; // (BACK_R: the arc into / out of a bay)
// the bus-stop ends of the bus roads are the bus's: cars turn round (or leave, out of sight) this far before them
const END_KEEP = 95;
// a car is always on its road: its body at most 1 m beyond the plowed edge (knocked aside, or swerving round a crash
// or a car stopped on the road), never in the trees or the open snow; one that makes no headway for 5 minutes (a
// wreck, boxed in behind one) is taken off and comes back parked in a car park
const EDGE = ROAD_HALF + 1, STUCK_T = 300;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _p = {}, _q = {}, _a = new THREE.Vector3(), _b = new THREE.Vector3(), _f = new THREE.Vector3();
const TURN_LEAD = 7, OFF_TURN = 0.12; // (a car turning at a junction starts its arc this far before it)
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
    const roads = busRoads.roads.filter((r) => !r.scenic); // (the scenic roads and their roundabouts: their own cars below)
    if (!roads.length) return;
    this.main = roads.filter((r) => !r.access);
    this.access = roads.filter((r) => r.access);
    this.lots = busRoads.lots.filter((l) => !l.building && !l.scenic && l.bays?.length);
    // junctions: where each access road meets a bus road
    this.junctions = [];
    for (const r of this.access) {
      const jx = r.X[r.n - 1], jz = r.Z[r.n - 1];
      let best = null;
      for (const m of this.main) for (let i = 0; i < m.n; i++) { const d = Math.hypot(m.X[i] - jx, m.Z[i] - jz); if (!best || d < best.d) best = { m, s: m.S[i], d }; }
      const lot = this.lots.find((l) => Math.hypot(l.ex - r.X[0], l.ez - r.Z[0]) < 12);
      if (best && best.d < 8) this.junctions.push({ access: r, road: best.m, s: best.s, lot });
    }
    // (the supercars, CAR_RARE: one each among the cars, not one in every seven)
    const all = CAR_MODELS.filter(([name]) => models[name]), rare = all.filter(([name]) => CAR_RARE.has(name));
    const avail = all.filter(([name]) => !CAR_RARE.has(name));
    if (!avail.length) return;
    // shared night light pieces
    this.pools = []; // the headlights' pools of light on the road: the few nearest cars at night (carlights.js)
    const colours = [null, 0x1b1d22, 0x9aa0a6, 0x24324e, 0x7a1d1d, 0xf2f2f0];
    for (let k = 0; k < N_CARS; k++) {
      const [name, length] = k === 7 && rare[0] ? rare[0] : avail[k % avail.length];
      const car = this.makeCar(carTemplate(models[name], length, name), k, colours[k % colours.length]);
      car.name = name;
      this.cars.push(car);
      this.spawn(car, true);
    }
    // the scenic roads (the Panoramastrasse, the Passstrasse, the loop round the back): cars of their own, each on
    // its own random way round the network (bus/scenicdrive.js), brought back near you when they're far out of sight
    try {
      if (scenicNetReady()) for (let k = 0; k < N_SCENIC; k++) {
        const [name, length] = k === 4 && rare[1] ? rare[1] : avail[(k * 5 + 3) % avail.length];
        const car = this.makeCar(carTemplate(models[name], length, name), N_CARS + k, colours[(k * 2 + 1) % colours.length]);
        car.name = name; car.scenic = true; car.vmax = 9 + (k % 4) * 1.5;
        this.cars.push(car);
        this.scenicPlace(car, k < 3 ? { x: player.pos.x, z: player.pos.z, min: 120, max: 900 } : null);
      }
    } catch (e) { console.warn('scenic traffic', e); }
    // the people in them (baked over the first frames; parked traffic cars show nobody)
    try {
      this.people = new CarPeople(makeRig);
      this.people.ready.then(() => { for (const c of this.cars) { try { c.people = this.people.fill(c.t); if (c.people) c.inst.full.add(c.people); } catch (e) { console.warn('car people', e); } } });
    } catch (e) { console.warn('car people', e); }
  }

  makeCar(t, k, paint) {
    const inst = carInstance(t, { paint, wheels: true });
    try { setPlates(inst, t); } catch { /* (no plate spots on this model) */ }
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
      c.mode = 'road'; c.road = r; c.s = s; c.dir = Math.random() < 0.5 ? 1 : -1; c.v = c.vmax * 0.7; c.path = null; c.off = 0; c.offT = 0; c.offQ = 0; c.pass = null;
      this.placeOnRoad(c, 0);
      return;
    }
    c.mode = 'gone'; c.g.visible = false; c.collider.x = 1e9; c.wait = 5;
  }

  parkAt(c, lot, bay, wait) {
    if (c.bay && c.bay !== bay) c.bay.traffic = false;
    bay.traffic = true;
    c.mode = 'parked'; c.lot = lot; c.bay = bay; c.wait = wait; c.v = 0; c.path = null; c.rev = false; c.lotSteer = 0;
    c.x = bay.x; c.z = bay.z; c.yaw = Math.atan2(bay.hx, bay.hz); c.y = world.meshHeight(c.x, c.z) + 0.03;
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
    c.off = 0; c.offT = 0; c.offQ = 0; c.pass = null;
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
    const spare = () => this.cars.filter((o) => !o.scenic && o.mode !== 'parked' && !this.inSight(o.x, o.z, 400)).sort((a, b) => Math.hypot(b.x - bp.x, b.z - bp.z) - Math.hypot(a.x - bp.x, a.z - bp.z))[0];
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
        // trips end (out of sight) and cars come back somewhere else; a wreck stays where it came to rest
        for (const c of this.cars) {
          if (c.scenic) { // (a wreck out of sight, or far away out of sight: back on the network, near you if it can)
            const far = Math.hypot(c.x - p.x, c.z - p.z) > 900;
            if (((c.mode === 'wreck' || c.mode === 'knocked') || (far && c.mode === 'scenic')) && !this.inSight(c.x, c.z)) this.scenicPlace(c, { x: p.x, z: p.z, min: 150, max: 700 });
            continue;
          }
          if (c.mode === 'gone') continue;
          const odd = c.mode === 'wreck' || c.mode === 'knocked', dP = Math.hypot(c.x - p.x, c.z - p.z);
          c.trip = (c.trip ?? (120 + Math.random() * 180)) - 2;
          // the watchdog: no headway (3 m) for 5 minutes (a wreck, boxed in behind one, blocked by a crash; not a
          // parked car): taken off (out of sight at once, in sight it sinks away, never beside you) and parked in a
          // car park
          if (!c.wd || c.mode === 'parked' || Math.hypot(c.x - c.wd.x, c.z - c.wd.z) > 3) c.wd = { x: c.x, z: c.z, t: 0 };
          else c.wd.t += 2;
          if (c.wd.t >= STUCK_T && c.sinkT === undefined) {
            if (!this.inSight(c.x, c.z)) { this.toLot(c); continue; }
            if (dP > 6) { c.sinkT = 0; c.toLot = true; }
            continue;
          }
          const away = !this.inSight(c.x, c.z) || dP > 80;
          if (away && c.trip <= 0 && c.mode !== 'lot' && !odd) { this.despawn(c); c.trip = undefined; continue; }
        }
        // about six cars on the roads around you (the rest stay spread over the network)
        let near = this.cars.filter((c) => !c.scenic && c.mode !== 'gone' && Math.hypot(c.x - p.x, c.z - p.z) < 420).length;
        for (const c of this.cars) {
          if (c.scenic) continue;
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
        if (c.sinkT !== undefined) { c.sinkT += dt; c.g.position.y -= dt * 1.8; if (c.sinkT > 0.8) { if (c.toLot) this.toLot(c); else this.despawn(c); } continue; }
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
          if (!c.inst.far && c.t.lod) { const m = farMesh(c.t, c.inst); m.visible = false; c.g.add(m); c.inst.far = m; }
          const near = d < lodR || !c.inst.far;
          c.inst.full.visible = near;
          if (c.inst.far) c.inst.far.visible = !near;
          if (c.people) c.people.visible = c.mode !== 'parked';
          // lamps on while it drives at night (parked: off); the brake lights whenever it brakes
          // knocked aside: its lights stay on (braking while it slides), the hazards flash; at rest (a wreck)
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
    if (c.mode === 'gone') { c.wait -= dt; if (c.wait <= 0) { if (c.scenic) { const p = this.player.pos; this.scenicPlace(c, { x: p.x, z: p.z, min: 150, max: 700 }); } else this.spawn(c); } return; }
    if (c.mode === 'knocked') { this.slide(c, dt); return; }
    if (c.mode === 'wreck') { c.v = 0; c.brake = 0; return; } // (rests where it stopped, crooked, until the watchdog takes it)
    if (c.mode === 'parked') {
      c.wait -= dt;
      if (c.wait <= 0 && Math.hypot(this.player.pos.x - c.x, this.player.pos.z - c.z) > c.l) this.leaveBay(c);
      return;
    }
    if (c.mode === 'lot') { this.manoeuvre(c, dt); return; }
    if (c.mode === 'scenic') { this.tourDrive(c, dt); return; }
    this.drive(c, dt);
  }

  // ---- the scenic roads: each car along its own path (scenicWalk: right-hand lane, single-lane rings anticlockwise),
  // slowing for the bends and the grade, keeping its distance behind any car ahead, giving way before a ring to
  // anyone on it (cars, you), stopping for you in its way, a pause at each viewpoint car park; at a junction with a
  // valley road, out of sight, it leaves (and comes back somewhere else on the network)
  scenicPlace(c, near = null) {
    const ok = near ? (x, z) => !this.inSight(x, z) : null;
    const st = (near && scenicSpawn(Math.random, near, ok)) || scenicSpawn(Math.random);
    if (!st) { c.mode = 'gone'; c.g.visible = false; c.collider.x = 1e9; c.wait = 30; return; }
    c.mode = 'scenic'; c.v = 0; c.pause = 0; c.brake = 0;
    c.spath = scenicWalk(st, LANE, 6); c.u = 4;
    this.tourPose(c);
  }
  tourAt(u, out, c) {
    const T = c.spath, n = T.X.length, f = Math.max(0, Math.min(T.L, u)) / 2, i = Math.min(n - 1, Math.floor(f)), j = Math.min(n - 1, i + 1), t = f - Math.floor(f);
    out.x = T.X[i] + (T.X[j] - T.X[i]) * t; out.z = T.Z[i] + (T.Z[j] - T.Z[i]) * t;
    return out;
  }
  tourPose(c) {
    const a = this.tourAt(c.u + c.l * 0.38, {}, c), b = this.tourAt(c.u - c.l * 0.38, {}, c);
    const ya = world.groundHeight(a.x, a.z, (c.y ?? 0) + 1), yb = world.groundHeight(b.x, b.z, (c.y ?? 0) + 1); // (on the road: its smooth surface)
    c.x = (a.x + b.x) / 2; c.z = (a.z + b.z) / 2; c.y = (ya + yb) / 2 + 0.02;
    c.yaw = Math.atan2(a.x - b.x, a.z - b.z);
    this.pose(c, Math.atan2(yb - ya, Math.hypot(a.x - b.x, a.z - b.z)));
  }
  // the path running out: the next piece appended (from where this one ends: straight on), the passed part dropped
  tourExtend(c) {
    const T = c.spath, cut = Math.max(0, Math.floor((c.u - 20) / 2)), nx = scenicWalk(T.end, LANE, 6), off = cut * 2, L0 = T.L - off;
    const X = T.X.slice(cut).concat(nx.X.slice(1)), Z = T.Z.slice(cut).concat(nx.Z.slice(1));
    const sh = (u) => u - off, sh2 = (u) => u + L0;
    c.spath = {
      X, Z, L: (X.length - 1) * 2, end: nx.end,
      entries: [...T.entries.map((e) => ({ u: sh(e.u), ring: e.ring })), ...nx.entries.map((e) => ({ u: sh2(e.u), ring: e.ring }))].filter((e) => e.u > -50),
      pauses: [...T.pauses.map(sh), ...nx.pauses.map(sh2)].filter((u) => u > -50),
      exits: [...T.exits.map(sh), ...nx.exits.map(sh2)].filter((u) => u > -50),
    };
    c.u -= off;
  }
  tourDrive(c, dt) {
    if (!c.spath) { this.scenicPlace(c); return; }
    if (c.u > c.spath.L - 80) this.tourExtend(c);
    const T = c.spath, u = c.u;
    if (c.pause > 0) { c.pause -= dt; c.v = 0; c.brake = 1; return; }
    // the bend ahead (the tightest within ~30 m): v <= sqrt(a_lat * R)
    let vt = c.vmax;
    const h = (q) => { const a = this.tourAt(q, _p, c), bx = a.x, bz = a.z, b = this.tourAt(q + 4, _q, c); return Math.atan2(b.x - bx, b.z - bz); };
    for (let d = 0; d < 32; d += 8) { const k = Math.abs(wrapPi(h(u + d + 6) - h(u + d))) / 6; if (k > 1e-3) vt = Math.min(vt, Math.sqrt(2.6 / k) + d * 0.12); }
    // any car ahead of it, going its way (the scenic cars are on paths of their own)
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    for (const o of this.cars) {
      if (o === c || o.mode === 'gone' || o.mode === 'parked') continue;
      const dx = o.x - c.x, dz = o.z - c.z, al = dx * fx + dz * fz;
      if (al <= 0 || al > 40 || Math.abs(dx * fz - dz * fx) > 2.4) continue;
      if (Math.sin(o.yaw) * fx + Math.cos(o.yaw) * fz < 0.3 && o.mode === 'scenic') continue; // (oncoming, in its own lane)
      vt = Math.min(vt, Math.max(0, (al - 11) * 0.45));
    }
    // give way before a ring: someone on it (or about to be), within its quarter to the left
    for (const e of T.entries) {
      const toE = e.u - u;
      if (toE < 0 || toE > 16) continue;
      const R = e.ring;
      const busy = [...this.cars.filter((o) => o !== c && o.scenic && o.mode === 'scenic'), { x: this.player.pos.x, z: this.player.pos.z }]
        .some((o) => { const r = Math.hypot(o.x - R.x, o.z - R.z); return r < R.R + 5 && r > R.R - 5 && Math.hypot(o.x - c.x, o.z - c.z) < 28; });
      if (busy) vt = Math.min(vt, Math.max(0, (toE - 2) * 0.5));
    }
    // you, in its way (on foot or in a car)
    const pdx = this.player.pos.x - c.x, pdz = this.player.pos.z - c.z, al = pdx * fx + pdz * fz;
    if (al > 0 && al < 18 && Math.abs(pdx * fz - pdz * fx) < 2.6) vt = Math.min(vt, Math.max(0, (al - 6) * 0.5));
    // the grade: slower up and down the steep bits
    c.brake = vt < c.v - 0.3 ? 1 : 0;
    c.v = vt > c.v ? Math.min(vt, c.v + 1.6 * dt) : Math.max(vt, c.v - 4 * dt);
    const u1 = u + c.v * dt;
    for (const ps of T.pauses) if (u < ps && u1 >= ps) { c.pause = 15 + Math.random() * 30; c.v = 0; }
    for (const ex of T.exits) if (u < ex && u1 >= ex && !this.inSight(c.x, c.z)) { c.mode = 'gone'; c.g.visible = false; c.collider.x = 1e9; c.wait = 20 + Math.random() * 40; return; }
    c.u = u1;
    this.tourPose(c);
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
    if (J && toJ < 30) vt = Math.min(vt, 2.6 + Math.max(0, toJ - TURN_LEAD) * 0.3);
    // the end of a bus road is a bus stop (a dead end): no car goes in there, unless it turns off to a car park on the
    // way; it eases down and turns round (or, out of sight, leaves) well before the bus bay
    const toJ0 = J ? (J.s - c.s) * c.dir : Infinity, keepOut = !r.access && !(toJ0 <= toEnd + 0.5);
    if (keepOut && toEnd < END_KEEP + 45) vt = Math.min(vt, 1.5 + Math.max(0, toEnd - END_KEEP) * 0.3);
    if (keepOut && toEnd <= END_KEEP + 1) { this.deadEnd(c); return; }
    if (r.access && c.dir < 0) vt = Math.min(vt, 3.5 + toEnd * 0.15); // (slowing for the car park)
    if (r.access && c.dir > 0) vt = Math.min(vt, 2.6 + Math.max(0, toEnd - TURN_LEAD) * 0.3); // (and for the junction)
    // a crash or a car stopped on the road ahead: round it (into the other lane, or up to 1 m beyond the plowed edge)
    // when there's room and nothing beside the road there (guardrail, tree, wall); else it waits behind it
    c.passT = (c.passT || 0) - dt;
    if (c.passT <= 0) { c.passT = 0.4; this.planPass(c); }
    // (a lane change / swerve is steered: the body angled off the lane line (c.offQ, tan of the angle, at most 0.28),
    // the angle turning only as it drives (up to OFF_TURN per metre, lateral acceleration <= 1.8: standing, nothing
    // moves sideways), straightened out in time to arrive on the new line; it moves only where it points)
    const off = c.off || 0, err = (c.offT || 0) - off, q = c.offQ || 0, k = Math.min(OFF_TURN, 1.8 / Math.max(1, c.v * c.v));
    const turnBy = k * c.v * dt, qMax = Math.min(0.28, Math.sqrt(2 * k * Math.abs(err))); // (k: per metre, gentler at speed)
    const qT = Math.abs(err) < 0.02 ? 0 : clamp(err * 0.5, -qMax, qMax);
    c.offQ = q + clamp(qT - q, -turnBy, turnBy);
    if (c.pass) vt = Math.min(vt, 4.5);
    vt = Math.min(vt, this.clearance(c));
    const dv = vt - c.v;
    c.brake = dv < -0.5 ? clamp(-dv / 4, 0, 1) : 0;
    c.v = Math.max(0, c.v + clamp(dv, -6 * dt, 2.2 * dt));
    c.s = clamp(c.s + c.dir * c.v * dt, 0, r.length);
    c.off = (c.off || 0) + (c.offQ || 0) * c.v * dt; // (sideways only as far as it is angled: never crabbing)
    if (J && (J.s - c.s) * c.dir <= TURN_LEAD) {
      c.nextJ = undefined;
      // (the bay is booked here: no car drives in to find the car park full and turn in its entrance); it turns in
      // round an arc onto the access road's lane (link), never pivoting at the junction
      const bay = J.lot && this.entryBay(J.lot);
      if (bay) { if (c.bay) c.bay.traffic = false; bay.traffic = true; c.bay = bay; this.link(c, J.access, J.access.length - 9, -1); this.manoeuvre(c, dt); return; }
    }
    // up the access road to the junction: round onto the bus road, either way
    if (r.access && c.dir > 0 && c.s >= r.length - TURN_LEAD) {
      const jn = this.junctions.find((j) => j.access === r);
      if (jn) { const d = Math.random() < 0.5 ? 1 : -1; this.link(c, jn.road, clamp(jn.s + d * 9, 2, jn.road.length - 2), d); this.manoeuvre(c, dt); return; }
    }
    if (r.access && c.dir < 0 && c.s <= 7.5) { this.enterLot(c); return; } // (in through the entrance, turning for the aisle)
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
      if (ahead > TURN_LEAD + 2 && (!best || ahead < (best.s - c.s) * c.dir)) best = j;
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
    // (a box: something by its footprint, so a car can pass beside it; in a car park (backing into / out of a bay
    // between parked cars) only a real overlap stops it: 0.3 m short of the footprint, not 2.5 m)
    const inLot = c.mode === 'lot' && c.lot, m = inLot ? 0.3 : 2.5, sm = inLot ? 0.1 : 0.3;
    const box = (x, z, yaw, hw, hd, gap) => {
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > gap + hd || Math.abs(dz) > gap + hd) return;
      const ahead = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx), e = extents(yaw, hw, hd, fx, fz, _ext);
      if (ahead + e.along > 0.5 && ahead - e.along < gap && side < c.w / 2 + e.across + sm) lim = Math.min(lim, Math.max(0, (ahead - e.along - c.l / 2 - m) * 0.7));
    };
    // other cars: the moving ones by their line, a wreck / knocked car by its footprint (it may be passed)
    for (const o of this.cars) {
      if (o === c || o.mode === 'gone' || o.mode === 'parked') continue;
      if (o.mode === 'wreck' || o.mode === 'knocked') box(o.x, o.z, o.yaw, o.w / 2, o.l / 2, 32); else check(o.x, o.z, 32, (c.l + o.l) / 2 + 3);
    }
    // parked cars, wrecks and shoved cars in the way (parking.js; the lay-by and bay cars are beside the lane)
    for (const e of this.parking?.cars || []) {
      const g = e.car.position;
      if (e.driving || Math.abs(g.x - c.x) > 34 || Math.abs(g.z - c.z) > 34) continue;
      if (inLot && c.bay && Math.hypot(g.x - c.bay.x, g.z - c.bay.z) < 3.2) continue; // (the cars either side of its bay: the arc in / out clears them)
      box(g.x, g.z, e.car.rotation.y, 0.97, (e.length || 4.6) / 2, 30);
    }
    // the car you drive (its body, not just where you sit; stopped: by its footprint, it may be passed)
    // (Oct 28, the user: "make it so other cars can crash into you": about one driver in ten isn't looking: on the
    // road it never brakes for your car, and runs into it; the bash (drive.js) does the rest, both ways)
    const dv = this.you?.d;
    c.careless ??= Math.random() < 0.1;
    if (dv && !(c.careless && c.mode === 'road')) { if (Math.hypot(dv.vx || 0, dv.vz || 0) < 0.8) box(dv.x, dv.z, dv.yaw, dv.w / 2, dv.half, 32); else check(dv.x, dv.z, 32, (c.l + dv.half * 2) / 2 + 3); }
    // the bus (its whole length: also when it stands across the way at a junction), the trains and a helicopter on
    // the road (trafficBlockers, at about the car's height)
    const line = this.skibus?.line, bus = line?.bus?.group;
    if (bus?.visible) box(bus.position.x, bus.position.z, line.yaw || 0, BUS_HW, BUS_HD, 36);
    for (const b of this.blk || []) if (b.y === undefined || Math.abs(b.y - c.y) < 5) box(b.x, b.z, b.yaw, b.hw, b.hd, 40);
    const p = this.player.pos;
    check(p.x, p.z, 26, c.l / 2 + 3);
    return lim;
  }

  // ---- round a crash: the nearest thing standing in its lane ahead (a wreck, a shoved or abandoned car, the car you
  // drive stopped on the road) -> c.offT, the lateral shift off its lane line (+ toward its own edge). Its own edge
  // first, else the other lane (when nothing comes the other way); never beyond the plowed edge + 1 m, never into a
  // guardrail, tree or wall beside the road. No room: c.offT 0 and it waits behind (the watchdog takes it after 5 min).
  planPass(c) {
    const r = c.road, fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), M = EDGE - c.w / 2;
    let best = null;
    const consider = (x, z, yaw, hw, hd) => {
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > 40 || Math.abs(dz) > 40) return;
      const e = extents(yaw, hw, hd, fx, fz, _ext), u = dx * fx + dz * fz;
      if (u < -(e.along + c.l / 2 + 1) || u > 36) return; // (behind it, or still beside it)
      const so = clamp(c.s + c.dir * u, 0, r.length);
      roadAt(r, so, _p);
      const rx = -_p.dz * c.dir, rz = _p.dx * c.dir, w = (x - _p.x) * rx + (z - _p.z) * rz, gap = e.across + c.w / 2 + 0.4;
      if (Math.abs(w) > EDGE + e.across) return; // (not on the road)
      if (Math.abs(w - LANE - (c.off || 0)) > gap && Math.abs(w - LANE) > gap) return; // (clear of the lane)
      if (!best || u < best.u) best = { u, so, w, gap, along: e.along };
    };
    for (const o of this.cars) if (o !== c && (o.mode === 'wreck' || o.mode === 'knocked')) consider(o.x, o.z, o.yaw, o.w / 2, o.l / 2);
    for (const e of this.parking?.cars || []) if (!e.driving) consider(e.car.position.x, e.car.position.z, e.car.rotation.y, 0.97, (e.length || 4.6) / 2);
    const d = this.you?.d;
    if (d && Math.hypot(d.vx || 0, d.vz || 0) < 0.8) consider(d.x, d.z, d.yaw, d.w / 2, d.half);
    if (!best) { c.pass = null; c.offT = 0; return; } // (nothing in the way: back on its lane line)
    // a lateral position (from the centre line) free beside it: on the road + 1 m, nothing standing there
    const free = (wT) => {
      if (Math.abs(wT) > M) return false;
      for (const k of [-1, 0, 1]) {
        roadAt(r, clamp(best.so + c.dir * k * (best.along + c.l / 2), 0, r.length), _q);
        const x = _q.x - _q.dz * c.dir * wT, z = _q.z + _q.dx * c.dir * wT;
        if (this.hard(c, x, z, c.w / 2)) return false;
      }
      return true;
    };
    const right = best.w + best.gap, left = best.w - best.gap;
    // (beside it already: keep to the side it chose)
    if (c.pass && best.u < best.along + c.l / 2) return;
    const oncoming = this.cars.some((o) => o !== c && o.mode === 'road' && o.road === r && o.dir !== c.dir && (o.s - c.s) * c.dir > -10 && (o.s - c.s) * c.dir < best.u + 80);
    if (free(right)) { c.pass = 'right'; c.offT = right - LANE; }
    else if (!oncoming && free(left)) { c.pass = 'left'; c.offT = left - LANE; }
    else { c.pass = null; c.offT = 0; }
  }

  // ---- what a car may never move into: a guardrail, the bus, a building, a parked car, a rock, a tree (trunk)
  hard(c, x, z, r) {
    for (const o of this.colliders) {
      if (o === c.collider || o.traffic || (o.soft && !o.rail && !o.bus)) continue;
      const R = o.r ?? Math.max(o.hw, o.hd);
      if (Math.abs(o.x - x) > R + r + 0.5 || Math.abs(o.z - z) > R + r + 0.5) continue;
      if (o.r !== undefined) { if (Math.hypot(x - o.x, z - o.z) < o.r + r) return true; continue; }
      const cs = Math.cos(-o.rot), sn = Math.sin(-o.rot), lx = (x - o.x) * cs - (z - o.z) * sn, lz = (x - o.x) * sn + (z - o.z) * cs;
      if (Math.abs(lx) < o.hw + r && Math.abs(lz) < o.hd + r) return true;
    }
    return !!this.player.vegetation?.collide?.(x, z, r, 0.6, true);
  }
  // on the way: within the plowed half width + 1 m of a road (body), or on a car park (+1 m)
  onWay(c, x, z) {
    if (laneDistance(x, z) <= EDGE - c.w / 2) return true;
    for (const L of this.lots) {
      const dx = x - L.x, dz = z - L.z;
      if (Math.abs(dx * L.ux + dz * L.uz) < L.hw + 1 - c.w / 2 && Math.abs(dx * L.vx + dz * L.vz) < L.hd + 1 - c.w / 2) return true;
    }
    return false;
  }
  // the car's body at (x, z, yaw) (three circles along it) on the way and clear of everything hard
  canBe(c, x, z, yaw) {
    const h = Math.max(0, c.l / 2 - c.w / 2), fx = Math.sin(yaw) * h, fz = Math.cos(yaw) * h;
    for (const k of [0, 1, -1]) if (!this.onWay(c, x + fx * k, z + fz * k) || this.hard(c, x + fx * k, z + fz * k, c.w / 2)) return false;
    return true;
  }
  // away from the nearest road's centre line (unit), or null off the network
  outward(x, z) {
    const h = 0.25, gx = laneDistance(x + h, z) - laneDistance(x - h, z), gz = laneDistance(x, z + h) - laneDistance(x, z - h), l = Math.hypot(gx, gz);
    return Number.isFinite(l) && l > 1e-6 ? { x: gx / l, z: gz / l } : null;
  }
  // pushed beyond the edge (+1 m, a train's shove, a knock's overlap): back in toward the road (unless on a car park)
  pullIn(c) {
    const lim = EDGE - c.w / 2;
    for (let k = 0; k < 3 && !this.onWay(c, c.x, c.z); k++) {
      const ld = laneDistance(c.x, c.z), n = this.outward(c.x, c.z);
      if (!n || !Number.isFinite(ld)) return;
      c.x -= n.x * (ld - lim + 0.02); c.z -= n.z * (ld - lim + 0.02);
    }
  }

  placeOnRoad(c, dt) {
    const r = c.road, half = c.l * 0.38;
    roadAt(r, clamp(c.s + c.dir * half, 0, r.length), _p); roadAt(r, clamp(c.s - c.dir * half, 0, r.length), _q);
    const tx = (_p.x - _q.x) || c.dir * _p.dx, tz = (_p.z - _q.z) || c.dir * _p.dz, tl = Math.hypot(tx, tz) || 1;
    const rx = -tz / tl, rz = tx / tl, w = LANE + (c.off || 0); // (the lane line, or swerving round something)
    _a.set(_p.x + rx * w, _p.y, _p.z + rz * w); _b.set(_q.x + rx * w, _q.y, _q.z + rz * w);
    // (on the drawn road: the ground as the terrain mesh shows it, which the strip follows; the road's design profile
    // _p.y lies up to ~0.5 m under it where a stop's or a car park's pad meets the road -- the cars sank into the road)
    _a.y = world.groundHeight(_a.x, _a.z, _p.y + 1); _b.y = world.groundHeight(_b.x, _b.z, _q.y + 1);
    c.x = (_a.x + _b.x) / 2; c.z = (_a.z + _b.z) / 2; c.y = (_a.y + _b.y) / 2 + 0.02;
    // (the body points where it goes: along the road, turned toward a lane change by its lateral speed)
    const ux = _a.x - _b.x, uz = _a.z - _b.z, ul = Math.hypot(ux, uz) || 1, q = c.offQ || 0;
    c.yaw = Math.atan2(ux / ul + rx * q, uz / ul + rz * q);
    this.pose(c, Math.atan2(_b.y - _a.y, Math.hypot(_a.x - _b.x, _a.z - _b.z)));
  }
  // onto road r (at s, way dir) from wherever a manoeuvre left it: no jump; what is left over (beside the lane line,
  // a slightly different heading) becomes a lane offset and a lateral speed it then steers out
  toRoad(c, r, s, dir, v) {
    const x = c.x, z = c.z, yaw = c.yaw;
    c.mode = 'road'; c.road = r; c.dir = dir; c.v = v; c.path = null; c.rev = false; c.nextJ = undefined; c.pass = null; c.offT = 0; c.pause = 0;
    roadAt(r, clamp(s, 1, r.length - 1), _p);
    const tx = _p.dx * dir, tz = _p.dz * dir, dx = x - _p.x, dz = z - _p.z;
    c.s = clamp(s + (dx * tx + dz * tz) * dir, 1, r.length - 1);
    c.off = clamp(dx * -tz + dz * tx - LANE, -3.5, 1.8);
    const e = wrapPi(yaw - Math.atan2(tx, tz)); // (+ = turned left of the road: angled leftward)
    c.offQ = clamp(-Math.tan(e), -1, 1);
    this.placeOnRoad(c, 0);
  }
  // a turn from one road onto another (a junction): an arc from where it is, as it heads, onto r's lane at s (way dir)
  link(c, r, s, dir) {
    roadAt(r, s, _p);
    const hx = _p.dx * dir, hz = _p.dz * dir, x = _p.x - hz * LANE, z = _p.z + hx * LANE;
    const P = linkPath({ x: c.x, z: c.z }, { x: Math.sin(c.yaw), z: Math.cos(c.yaw) }, { x, z }, { x: hx, z: hz }, 9);
    for (const k of [2, 4, 6, 8]) P.push({ x: x + hx * k, z: z + hz * k }); // (a straight run-out: it settles on the lane)
    c.mode = 'lot'; c.lot = null; c.rev = false; c.pause = 0; c.next = 'road'; c.link = { r, s: s + dir * 8, dir };
    c.path = prepPath(P, { vMax: 6, vEnd: 3 }); c.pi = 0; c.lotSteer = c.steer || 0; c.off = 0; c.offT = 0; c.offQ = 0;
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
        this.pullIn(c); // (never off its road: back within the edge + 1 m)
        this.pose(c, 0);
      }
      for (const e of this.parking?.cars || []) {
        if (e.driving) continue;
        const g = e.car.position, k = hit(g.x, g.y, g.z, e.car.rotation.y, 0.97, (e.length || 4.6) / 2);
        if (!k) continue;
        const sg = Math.sign(k);
        this.you?.shove?.(e, rx * sg * 2.5, rz * sg * 2.5, (Math.random() - 0.5) * 0.8); // (first: it remembers its bay)
        g.x += rx * k; g.z += rz * k; g.y = world.meshHeight(g.x, g.z) + 0.03;
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

  // ---- knocked by the car you drive (drive.js bash) or shoved by a train: it slides aside, turning, to a stop on its
  // road (a wreck: it stays there until the 5-minute watchdog parks it in a car park)
  knock(c, vx, vz, w) {
    if (!c || c.mode === 'gone') return;
    if (c.mode === 'road') {
      // aside: a knock from behind or ahead still sends it toward its own shoulder, turning (slide: never beyond the
      // plowed edge + 1 m, never through a guardrail or a tree)
      const sp = Math.hypot(vx, vz), rx = -Math.cos(c.yaw), rz = Math.sin(c.yaw);
      vx += rx * sp * 0.35; vz += rz * sp * 0.35;
      w += (Math.random() < 0.5 ? -1 : 1) * Math.min(1.2, sp * 0.09);
    }
    if (c.bay) { c.bay.traffic = false; c.bay = null; }
    c.mode = 'knocked'; c.path = null; c.rev = false; c.v = 0; c.brake = 1; c.pause = 0; c.nextJ = undefined;
    c.kvx = vx; c.kvz = vz; c.kw = clamp(w, -3, 3);
    c.off = 0; c.offT = 0; c.offQ = 0; c.pass = null; c.wd = { x: c.x, z: c.z, t: 0 }; // (it rests where it stops: the 5-minute watchdog)
  }
  slide(c, dt) {
    const sp = Math.hypot(c.kvx, c.kvz);
    const g = world.corridorAt?.(c.x, c.z, this._corr || (this._corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }));
    const mu = g && g.kind === 'lift' && g.d < 0 ? 0.7 : 0.5; // (on the road the tyres scrub harder than in the snow)
    const dec = mu * 9.81 * dt;
    if (sp > dec) { c.kvx -= (c.kvx / sp) * dec; c.kvz -= (c.kvz / sp) * dec; } else { c.kvx = 0; c.kvz = 0; }
    c.kw *= Math.exp(-dt * (1.4 + mu * 2));
    if (!c.kvx && !c.kvz && Math.abs(c.kw) < 0.05) c.kw = 0;
    // it stays on its road (the plowed edge + 1 m) and never goes into a guardrail, tree, rock, wall or the bus: the
    // push that way is taken out (it slides on along the road), and where even that is blocked it stops there
    this.pullIn(c);
    let nx = c.x + c.kvx * dt, nz = c.z + c.kvz * dt, ny = wrapPi(c.yaw + c.kw * dt);
    if (!this.canBe(c, nx, nz, ny)) {
      const n = this.outward(c.x, c.z), vn = n ? c.kvx * n.x + c.kvz * n.z : 0;
      if (n && vn > 0) { c.kvx -= n.x * vn; c.kvz -= n.z * vn; }
      c.kw *= 0.5; nx = c.x + c.kvx * dt; nz = c.z + c.kvz * dt; ny = wrapPi(c.yaw + c.kw * dt);
      if (!this.canBe(c, nx, nz, ny)) {
        c.kw = 0; ny = c.yaw;
        if (!this.canBe(c, nx, nz, ny)) { c.kvx = 0; c.kvz = 0; nx = c.x; nz = c.z; }
      }
    }
    c.x = nx; c.z = nz; c.yaw = ny;
    c.y = world.meshHeight(c.x, c.z) + 0.03;
    c.v = 0; c.brake = 1;
    this.pose(c, 0);
    if (!c.kvx && !c.kvz && !c.kw) { c.mode = 'wreck'; c.brake = 0; }
  }

  // off the map for a moment (it comes back elsewhere, out of sight)
  despawn(c) {
    c.kvx = 0; c.kvz = 0; c.kw = 0; c.sinkT = undefined;
    if (c.bay) { c.bay.traffic = false; c.bay = null; }
    c.mode = 'gone'; c.wait = 1 + Math.random() * 4; c.g.visible = false; c.collider.x = 1e9; c.path = null; c.rev = false;
    c.off = 0; c.offT = 0; c.offQ = 0; c.pass = null; c.wd = null; c.link = null;
  }
  // stuck for 5 minutes: taken off, and back parked in a free bay of a car park out of your sight (it drives off from
  // there later); none free: it comes back a moment later the usual way (spawn)
  toLot(c) {
    this.despawn(c); c.toLot = false; c.trip = undefined;
    const lots = this.lots.filter((l) => !this.inSight(l.x, l.z) && l.bays.some((b) => !b.taken && !b.traffic));
    const lot = lots[Math.floor(Math.random() * lots.length)];
    if (lot) this.parkAt(c, lot, lot.bays.find((b) => !b.taken && !b.traffic), 20 + Math.random() * 40);
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

  // ---- in the car park: along the aisle past the bay, then back into it in an arc; later forward out in an arc, go
  // a point of the lot in its own frame (u along the long side, v across)
  lotPt(L, u, v) { return { x: L.x + L.ux * u + L.vx * v, z: L.z + L.uz * u + L.vz * v }; }
  lotUV(L, x, z) { const dx = x - L.x, dz = z - L.z; return { u: dx * L.ux + dz * L.uz, v: dx * L.vx + dz * L.vz }; }
  // the aisle in front of a bay: its centre line (v), sB the way from it into the bay (v), side: the entrance's side (u)
  aisleFor(L, bay) {
    const b = this.lotUV(L, bay.x, bay.z), sB = -Math.sign(bay.hx * L.vx + bay.hz * L.vz) || 1; // (the nose points out, to the aisle)
    const e = this.lotUV(L, L.ex - L.dirx * 4, L.ez - L.dirz * 4);
    return { b, e, sB, vA: b.v - sB * ((bay.hd || 2.75) + 3.4), side: Math.sign(e.u - b.u) || 1 };
  }
  // a free bay a car can back into from the entrance: room in the aisle beyond it to pull up before reversing
  entryBay(L) {
    return L.bays.find((bay) => {
      if (bay.taken || bay.traffic) return false;
      const { b, side } = this.aisleFor(L, bay);
      return Math.abs(b.u - side * BACK_R) < L.hw - 2.6;
    });
  }
  enterLot(c) {
    const lot = this.junctions.find((j) => j.access === c.road)?.lot;
    const bay = lot && (c.bay?.traffic && lot.bays.includes(c.bay) ? c.bay : this.entryBay(lot)); // (booked at the junction)
    if (!lot || !bay) { this.deadEnd(c); return; } // (full: never a U-turn on the spot)
    if (c.bay && c.bay !== bay) c.bay.traffic = false;
    bay.traffic = true;
    c.lot = lot; c.bay = bay; c.mode = 'lot'; c.rev = false; c.next = 'backIn'; c.turnRoad = null;
    const { b, e, sB, vA, side } = this.aisleFor(lot, bay), R = BACK_R;
    const uIn = clamp(e.u, -lot.hw + 3, lot.hw - 3), uS = b.u - side * R;
    // entrance -> into the aisle -> along it past the bay -> pull up R beyond it, straight along the aisle
    c.path = [{ x: c.x, z: c.z }, this.lotPt(lot, e.u, e.v), this.lotPt(lot, uIn, vA)];
    if ((uIn - uS) * side > 7) c.path.push(this.lotPt(lot, uS + side * 5, vA));
    c.path.push(this.lotPt(lot, uS + side * 2.5, vA), this.lotPt(lot, uS, vA)); // (the last leg straight along the aisle)
    // then (endManoeuvre) back round a quarter circle into the bay's mouth, and straight back to its middle
    c.after = [this.lotPt(lot, uS, vA)];
    for (const t of [0.5, 1.0, Math.PI / 2]) c.after.push(this.lotPt(lot, uS + side * R * Math.sin(t), vA + sB * R * (1 - Math.cos(t))));
    c.after.push({ x: bay.x, z: bay.z });
    c.pi = 1;
  }
  leaveBay(c) {
    const lot = c.lot, bay = c.bay;
    const { b, e, sB, vA, side } = this.aisleFor(lot, bay), R = BACK_R;
    // forward out (the nose is already out): straight to the bay's mouth, then round toward the exit along the aisle
    c.mode = 'lot'; c.rev = false; c.next = 'out'; c.after = null;
    c.path = [{ x: c.x, z: c.z }, this.lotPt(lot, b.u, vA + sB * R)];
    if (Math.abs(e.u - b.u) > R + 1) {
      for (const t of [0.5, 1.0, Math.PI / 2]) c.path.push(this.lotPt(lot, b.u + side * R * (1 - Math.cos(t)), vA + sB * R * (1 - Math.sin(t))));
      c.path.push(this.lotPt(lot, clamp(e.u, -lot.hw + 3, lot.hw - 3), vA));
    }
    c.path.push(this.lotPt(lot, e.u, e.v));
    const acc = this.junctions.find((j) => j.lot === lot)?.access;
    if (acc) for (const s of [9, 12]) { roadAt(acc, s, _p); c.path.push({ x: _p.x - _p.dz * LANE, z: _p.z + _p.dx * LANE }); }
    else c.path.push({ x: lot.ex + lot.dirx * 2, z: lot.ez + lot.dirz * 2 });
    c.pi = 1;
  }
  // follow the waypoints at walking pace with a smoothly turning steering wheel (pure pursuit, 3.5 m ahead)
  manoeuvre(c, dt) {
    if (c.pause > 0) { c.pause -= dt; c.brake = 1; return; }
    // (waypoints -> corners rounded into arcs it can drive, points already behind it dropped, slower in the bends)
    if (!c.path.dense) { c.path = carPath(c, c.path, { r: c.rev ? 4 : 5, vMax: c.rev ? 1.4 : 3.6, vEnd: c.next === 'out' || c.next === 'turn3' ? 2 : 0 }); c.pi = 0; }
    // slow: 10-15 km/h forward, walking pace in reverse, easing to a stop at the end (and for anything in the way);
    // pure pursuit on the bicycle model (carpath.js): the steering turns gradually, the body only ever goes where it points
    if (followPath(c, c.path, dt, this.clearance(c))) { this.endManoeuvre(c); return; }
    c.y += (world.groundHeight(c.x, c.z, c.y + 1) + 0.03 - c.y) * (1 - Math.exp(-dt * 10));
    this.pose(c, 0);
  }
  endManoeuvre(c) {
    if (c.next === 'road') { const L = c.link; c.link = null; this.toRoad(c, L.r, L.s, L.dir, c.v); return; } // (a junction turn: on at speed)
    const v0 = c.v;
    c.v = 0;
    // the three-point turn: forward across, back, forward into the other lane, then on along the road
    if (c.next === 'turn1') { c.next = 'turn2'; c.rev = true; c.path = [c.turnPts[0], c.turnPts[1]]; c.pi = 1; c.pause = 0.4; return; }
    if (c.next === 'turn2') { c.next = 'turn3'; c.rev = false; c.path = [c.turnPts[1], c.turnPts[2]]; c.pi = 1; c.pause = 0.4; return; }
    if (c.next === 'turn3') { const T = c.turnRoad; c.turnRoad = null; this.toRoad(c, T.r, T.s + T.dir * 5, T.dir, v0); return; }
    if (c.next === 'park') {
      // settle straight and centred in the bay
      this.parkAt(c, c.lot, c.bay, 25 + Math.random() * 60);
      return;
    }
    if (c.next === 'backIn') { c.rev = true; c.path = c.after; c.after = null; c.pi = 1; c.next = 'park'; c.pause = 0.7; return; }
    // out of the car park: onto the access road, away to the junction
    const jn = this.junctions.find((j) => j.lot === c.lot);
    if (c.bay) { c.bay.traffic = false; c.bay = null; }
    if (jn) this.toRoad(c, jn.access, 12, 1, v0);
    else { c.mode = 'gone'; c.wait = 4; }
  }
}
