// The Wolkenspitzbahn at runtime: two trains on the timetable (railroute.js), crossing on the passing loop;
// boarding at the stations, riding inside the cabin (a seat camera with mouse look, R for an outside view, Space
// to speed up), getting off at Wolkensee or at the end of the line; the tunnels' darkness (the sun and the sky
// fade out when the camera is deep inside a tunnel, the cabin and the tunnel lamps carry the light).
//
// main.js glue (see the integration notes at the bottom of this file):
//   railway = new Railway({ scene, colliders, makeRig, layout, world })
//   findInteraction(): railway.interaction(player.pos)        -> { label, act } | null
//   loop, after lifts.update:    railway.update(dt, ctx)        (moves the trains, the ride, the HUD hint)
//   loop, after player.update:   railway.applyCamera(camera, input, dt)   (seat / outside camera while riding)
//   loop, before post.render:    railway.lateUpdate(camera, env, atmosphere)  (tunnel light, snowfall indoors)
import * as THREE from 'three';
import { RAIL, RAIL_NAME, railAt, inTunnel, CYCLE, PROFILE, trainState, boardingU, TRIP_S0, TRIP_S1, DWELL_END, STEP, railNearest } from './railroute.js';
import { buildRailway, loopOffset, LOOP, railUniforms, setTunnelLampModel, portalClips } from './railtrack.js';
import { setTerrainClips } from './terrain.js';
import { meshyHead, HEADS } from './pistelights.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { buildCar, CAR, trainUniforms, setCarModel, crisp } from './train.js';
import { poseSeated } from './seatpose.js';
import { buildStations } from './railstations.js';
import { RailPeople } from './railpeople.js';
import { addTrainBlocker } from '../game/traffic.js';
import { brakeFor, release, latOf, CarColliders } from './trainstop.js';

// people waiting at the stations (fans.js crowd people); the Meshy railcar body for outside views
export const RAIL_PEOPLE = true;
export const RAIL_MESHY_CAR = true;
export const RAIL_MESHY_TUNNEL_LAMPS = true; // the Meshy four-flood banks on the tunnel walls (else plain light strips)
export const RAIL_TERRAIN_CLIP = true; // no terrain inside the tubes behind the portals (terrain.js clip volumes)
import { smoothstep, clamp, lerp, mulberry32 } from '../core/noise.js';
import { world } from './world.js';

export const RAIL_PRICE = 50; // uphill (Oct 29 rebalance: was $30)
const ALT0 = 1245; // the village's altitude above sea level (signs)
const SET_HALF = (CAR.len + CAR.gap) / 2; // car centres from the set's middle

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const _f = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };

// world position of the track at arc length s (the loop track for the down train while it passes the loop)
function trackPoint(s, onLoop, out) {
  railAt(s, _f);
  const off = onLoop ? loopOffset(s) : 0;
  return out.set(_f.x - _f.dz * off, _f.y, _f.z + _f.dx * off);
}

// A skinned mesh in its current pose as a static geometry (root space), simplified to about `tris` triangles by
// meshoptimizer (edge collapses; the uv seams are borders and stay locked, so the texture keeps its mapping)
function bakePosed(mesh, tris) {
  const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv, n = pos.count;
  const v = new THREE.Vector3(), P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
  let idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
  if (MeshoptSimplifier.supported !== false && idx.length / 3 > tris) {
    const [res] = MeshoptSimplifier.simplify(idx, P, 3, tris * 3, 0.05, ['LockBorder']);
    if (res?.length) idx = res;
  }
  // keep only the vertices still used
  const map = new Int32Array(n).fill(-1), outP = [], outU = [], outI = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (map[i] < 0) { map[i] = outP.length / 3; outP.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); if (uv) outU.push(uv.getX(i), uv.getY(i)); }
    outI[k] = map[i];
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(outU, 2));
  out.setIndex(new THREE.BufferAttribute(outI, 1));
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

// A skinned mesh in its current pose as a static geometry (root space), thinned by vertex clustering with cells of
// `cell` m and 1/96 of the texture (so a cell never spans a uv seam; degenerate triangles dropped), normals
// recomputed.
function bakeSkinned(mesh, cell, uvq = 96) {
  const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv, n = pos.count;
  const v = new THREE.Vector3(), P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
  const remap = new Int32Array(n), cells = new Map(), outP = [], outU = [];
  for (let i = 0; i < n; i++) {
    // (the uv is part of the key: vertices merge only within one texture island, so seams keep their mapping)
    const key = Math.round(P[i * 3] / cell) + ',' + Math.round(P[i * 3 + 1] / cell) + ',' + Math.round(P[i * 3 + 2] / cell)
      + (uv ? ',' + Math.round(uv.getX(i) * uvq) + ',' + Math.round(uv.getY(i) * uvq) : '');
    let j = cells.get(key);
    if (j === undefined) {
      j = outP.length / 3; cells.set(key, j);
      outP.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      if (uv) outU.push(uv.getX(i), uv.getY(i));
    }
    remap[i] = j;
  }
  const idx = g.index, tri = [];
  const count = idx ? idx.count : n;
  for (let t = 0; t < count; t += 3) {
    const a = remap[idx ? idx.getX(t) : t], b = remap[idx ? idx.getX(t + 1) : t + 1], c = remap[idx ? idx.getX(t + 2) : t + 2];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  if (!tri.length) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(outU, 2));
  out.setIndex(tri);
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

class TrainSet {
  constructor(railway, phase, index) {
    this.phase = phase;
    this.index = index;
    this.group = new THREE.Group();
    this.group.name = `rail-train-${index}`;
    // car 0 leads uphill (cab at its +z end, which faces up the line), car 1 is turned round (cab facing down)
    this.cars = [buildCar({ cab: true, number: index * 2 + 1 }), buildCar({ cab: true, number: index * 2 + 2 })];
    for (const c of this.cars) { this.group.add(c.group); this.group.add(c.lo); c.lo.visible = false; }
    this.state = {};
    this.s = TRIP_S0;
    this.near = true;
    railway.scene.add(this.group);
  }
  // place the cars on the track around arc length s (each body between its bogies, the bogies on the rails)
  place(s, onLoop, viewer) {
    this.s = s;
    const dist = viewer ? Math.hypot(viewer.x - trackPoint(s, onLoop, _a).x, viewer.z - _a.z) : 0;
    const near = dist < 220;
    for (let k = 0; k < 2; k++) {
      const c = this.cars[k];
      const sc = s + (k === 0 ? SET_HALF : -SET_HALF);
      const flip = k === 1; // car 1 faces down the line
      const sFront = sc + (flip ? -CAR.bogie : CAR.bogie), sBack = sc - (flip ? -CAR.bogie : CAR.bogie);
      trackPoint(sFront, onLoop, _a); trackPoint(sBack, onLoop, _b);
      const g = c.group;
      g.position.addVectors(_a, _b).multiplyScalar(0.5);
      // look along the chord: +z of the car toward its front bogie
      _m.lookAt(_b, _a, _up);
      g.quaternion.setFromRotationMatrix(_m);
      g.rotateY(Math.PI); // lookAt points -z at the target
      c.lo.position.copy(g.position); c.lo.quaternion.copy(g.quaternion);
      // bogies follow the track under them (yaw relative to the body)
      for (let j = 0; j < 2; j++) {
        const bs = j === 0 ? sBack : sFront; // bogie 0 sits at the car's rear (-z)
        railAt(bs, _f);
        const heading = Math.atan2(_f.dx, _f.dz) + (flip ? Math.PI : 0);
        const bodyYaw = new THREE.Euler().setFromQuaternion(g.quaternion, 'YXZ').y;
        c.bogies[j].rotation.y = heading - bodyYaw;
      }
      g.visible = near; c.lo.visible = !near;
    }
    this.near = near;
  }
}

export class Railway {
  constructor({ scene, colliders = [], makeRig = null, models = null }) {
    this.scene = scene;
    this.colliders = colliders;
    this.makeRig = makeRig;
    // the tunnel luminaires: the Meshy four-flood bank (pistelights.js), else the plain light strips
    try { if (RAIL_MESHY_TUNNEL_LAMPS && models?.floodlight_head_c) setTunnelLampModel(meshyHead(models.floodlight_head_c, HEADS.floodlight_head_c)); } catch (e) { console.warn('rail tunnel lamps', e); }
    this.track = buildRailway(scene);
    colliders.push(...(this.track.colliders || [])); // the catenary masts and the stone viaduct's piers
    this.clips = [];
    try { if (RAIL_TERRAIN_CLIP) { this.clips = portalClips(); setTerrainClips(this.clips); } } catch (e) { console.warn('rail terrain clips', e); }
    this.stations = buildStations(scene, colliders, models);
    // (each of these falls back to the procedural version if anything about the model goes wrong)
    try { if (RAIL_MESHY_CAR && models?.rail_car2) setCarModel(models.rail_car2); } catch (e) { console.warn('rail car', e); } // the Meshy railcar (outside views)
    try { this.people = RAIL_PEOPLE && typeof document !== 'undefined' ? new RailPeople(scene, this.stations) : null; } catch (e) { console.warn('rail people', e); this.people = null; }
    this.trains = [new TrainSet(this, 0, 0), new TrainSet(this, 0.5, 1)];
    // no car drives through a train, the train shoves any car on the line aside (traffic.js)
    const bodies = this.trains.flatMap((tr) => tr.cars.map((c) => c.group));
    addTrainBlocker(() => bodies, { hw: CAR.hw, hd: CAR.half });
    this.solid = new CarColliders(colliders, 4, SET_HALF); // the cars near you are solid (trainstop.js)
    this.passengerMats = [];
    MeshoptSimplifier.ready.then(() => this.seatPassengers(this.trains[0])).catch((e) => console.warn('rail passengers', e));
    this.t = CYCLE * 0.62; // timetable time (s)
    this.ride = null;      // { train, car, seat, up, dest, t0 }
    this.view = 'seat';    // seat | outside
    this.look = { yaw: 0, pitch: -0.05 };
    this.chase = { yaw: 0, pitch: 0.18, dist: 34 };
    this.dark = 0;         // 0 daylight .. 1 deep in a tunnel (smoothed)
    this.timeScale = 1;
    this.update(0, {});
  }

  get riding() { return !!this.ride; }

  // ------------------------------------------------------------------ passengers
  // Skiers ride along in the train you board (both cars), baked once in relaxed seated poses (seatpose.js: hands on
  // the thighs or in the lap, arms folded, a phone; slouched a little, feet on the floor, the head turned toward
  // the window or the neighbour) and instanced on the seats (they move with the car, nothing updates per frame);
  // their skis stay in the rack. The front row on the rider's side stays free. Their materials are copies with a
  // warm self-light from the cabin strips (the scene's lights barely reach in tunnels): lateUpdate drives it.
  // The bakes are spread over frames (one figure per frame).
  async seatPassengers(train) {
    if (!this.makeRig) return;
    const looks = ['skier_red', 'skier_green', 'skier_orange', 'skier_black', 'skier_purple', 'skier_blue'];
    const kinds = ['thighs', 'lap', 'crossed', 'phone'];
    const rnd = mulberry32(5150);
    const frame = () => new Promise((r) => setTimeout(r, 0));
    // per look: every kind with the head turned left and right (the phone: bowed over it), baked in the seat's frame
    const baked = []; // { look, kind, dir, parts: [{ geo, mat }], phone: Matrix4|null }
    for (const id of looks) {
      let rig;
      try { rig = this.makeRig(id, 'rental'); } catch { continue; }
      if (!rig?.root) continue;
      rig.gear.visible = false;
      const mats = new Map();
      for (const kind of kinds) for (const dir of kind === 'phone' ? [0] : [-1, 1]) {
        const seat = new THREE.Vector3(0, 0, 0);
        for (let k = 0; k < 2; k++) { rig.snapNext = true; rig.update(0.016, { mode: 'sit', seat, heading: 0, speed: 0, lookYaw: 0 }); }
        rig.root.updateMatrixWorld(true);
        const phone = poseSeated(rig, kind, dir * (0.38 + rnd() * 0.25), rnd());
        const parts = [];
        rig.root.traverse((o) => {
          if (!o.isSkinnedMesh || !o.visible || !o.geometry?.attributes?.position) return;
          const geo = bakePosed(o, 2600);
          if (!geo) return;
          const src = Array.isArray(o.material) ? o.material[0] : o.material;
          let mat = mats.get(src);
          if (!mat) {
            mat = crisp(src.clone());
            if (mat.emissive) { mat.emissive.set(0xffd2a0); mat.emissiveMap = mat.map || null; mat.emissiveIntensity = 0.1; this.passengerMats.push(mat); }
            mats.set(src, mat);
          }
          parts.push({ geo, mat });
        });
        if (parts.length) baked.push({ look: id, kind, dir, parts, phone });
        await frame();
      }
    }
    if (!baked.length) return;
    const phoneGeo = new THREE.BoxGeometry(0.072, 0.15, 0.009), screenGeo = new THREE.PlaneGeometry(0.064, 0.136);
    screenGeo.translate(0, 0, 0.0047);
    const phoneMat = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.35, metalness: 0.3 });
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x0b1626, emissive: 0x9fc6ff, emissiveIntensity: 0.55, roughness: 0.2 });
    for (const car of train.cars) {
      car.passengers = [];
      // most seats taken: not the rider's own seat or the one beside it (front row, the right side)
      const places = car.seats.filter((st) => !(st.row === 1 && st.side > 0) && rnd() < 0.56);
      const lists = new Map(), phones = [];
      for (const st of places) {
        const look = looks[Math.floor(rnd() * looks.length)];
        const r = rnd(), kind = r < 0.36 ? 'thighs' : r < 0.6 ? 'lap' : r < 0.8 ? 'crossed' : 'phone';
        // the head: toward the window (most) or the neighbour; +x in the car is the passenger's left facing +z
        const toWindow = rnd() < 0.65, lateral = Math.sign(st.pos.x) * (toWindow ? 1 : -1);
        const dir = kind === 'phone' ? 0 : lateral * (st.yaw === 0 ? 1 : -1) > 0 ? 1 : -1;
        const b = baked.find((x) => x.look === look && x.kind === kind && x.dir === dir) || baked.find((x) => x.kind === kind && x.dir === dir) || baked[0];
        if (!lists.has(b)) lists.set(b, []);
        const o = new THREE.Object3D();
        o.position.copy(st.pos); o.rotation.set(0, st.yaw + (rnd() - 0.5) * 0.12, 0);
        const sc = 0.95 + rnd() * 0.08; o.scale.set(sc, sc, sc); o.updateMatrix();
        lists.get(b).push(o.matrix.clone());
        if (b.phone) phones.push(o.matrix.clone().multiply(b.phone));
      }
      for (const [b, mats] of lists) {
        for (const part of b.parts) {
          const im = new THREE.InstancedMesh(part.geo, part.mat, mats.length);
          mats.forEach((m4, i) => im.setMatrixAt(i, m4));
          im.instanceMatrix.needsUpdate = true;
          im.castShadow = false; im.receiveShadow = true;
          im.computeBoundingSphere();
          car.group.add(im);
          car.passengers.push(im);
        }
      }
      if (phones.length) {
        for (const [g, m] of [[phoneGeo, phoneMat], [screenGeo, screenMat]]) {
          const im = new THREE.InstancedMesh(g, m, phones.length);
          phones.forEach((m4, i) => im.setMatrixAt(i, m4));
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          car.group.add(im);
          car.passengers.push(im);
        }
      }
      car.passengersVisible = undefined; // (showPassengers sets them)
    }
  }
  // passengers show in the car you ride in, or from outside when the train is close (skinned meshes are not cheap)
  showPassengers(viewer) {
    const tr = this.trains[0];
    for (const [ci, car] of tr.cars.entries()) {
      if (!car.passengers) continue;
      let vis;
      if (this.noPassengers) vis = false; // (multiplayer: nobody but real players)
      else if (car.hasBody) vis = !!car.inside;
      else if (this.ride) vis = this.ride.train === tr && (this.ride.car === ci || this.view === 'outside');
      else vis = !!viewer && car.group.visible && Math.hypot(viewer.x - car.group.position.x, viewer.z - car.group.position.z) < 110;
      if (vis !== car.passengersVisible) { car.passengersVisible = vis; for (const r of car.passengers) r.visible = vis; }
    }
  }

  // ------------------------------------------------------------------ timetable + trains
  // player: your position on foot / skis (main.js; null while you ride a train): the trains stop for you on the
  // track (the whole line's clock slows with the held train: one track with a passing loop, the crossing holds)
  update(dt, { viewer = null, fast = false, player = null, audio = null } = {}) {
    this.timeScale = this.ride && fast ? 6 : 1;
    const rate = this.stopFor(this.ride ? null : player, dt, audio);
    this.t = (this.t + dt * this.timeScale * rate) % (CYCLE * 1000);
    const cam = viewer || (this.ride ? this.seatWorld() : null);
    for (const tr of this.trains) {
      trainState(this.t, tr.phase, tr.state);
      const onLoop = tr.state.dir < 0 && tr.state.s > LOOP.s0 && tr.state.s < LOOP.s1;
      tr.place(tr.state.s, onLoop, cam);
    }
    this.solidCars(this.ride ? null : player);
    // the car you sit in shows its cabin (our shell, glass, seats, passengers); every other car the Meshy body
    for (const tr of this.trains) tr.cars.forEach((c, k) => {
      const inside = !!this.ride && this.ride.train === tr && this.ride.car === k && this.view === 'seat';
      if (c.inside !== inside) { c.inside = inside; c.setInside?.(inside); }
    });
    if (viewer) this.track.update(viewer, { inTunnel: !!this.ride && inTunnel(this.camS ?? this.ride.train.s, -80) });
    this.showPassengers(cam);
    this.stations.update?.(viewer, this.t);
  }

  // the line's clock rate this frame (0..1): each train brakes for you if you are on its track ahead (trainstop.js)
  stopFor(p, dt, audio) {
    let lat = null, sp = 0, LAT = 2.3;
    const n = p && railNearest(p.x, p.z);
    if (n) {
      sp = n.s; lat = latOf(p, railAt(sp, _f));
      // at a platform only between the rails (its edge is 1.75 m from the track's middle)
      if (RAIL.stations.some((st) => sp > st.s0 - 15 && sp < st.s1 + 15)) LAT = 1.45;
    }
    let rate = 1;
    for (const tr of this.trains) {
      const st = tr.state, b = tr.stop || (tr.stop = {});
      if (st.s === undefined) continue;
      const v = st.speed || 0;
      if (!p || !(dt > 0)) { release(b, v); continue; }
      const dir = st.dir || (st.leg === 'bottom' ? 1 : -1); // (standing at a terminus: the way it leaves)
      const trackLat = dir < 0 ? loopOffset(sp) : 0;    // (going down it takes the passing loop's other track)
      const nose = st.s + dir * (SET_HALF + CAR.half);
      const D = (sp - nose) * dir;
      const on = lat !== null && Math.abs(lat - trackLat) < LAT && D > -(2 * SET_HALF + 2 * CAR.half + 2);
      rate = Math.min(rate, brakeFor(b, v, on ? D : null, dt, audio));
    }
    for (const tr of this.trains) if (tr.stop && tr.state.s !== undefined) tr.stop.ve = rate * (tr.state.speed || 0); // (all on the one clock)
    return rate;
  }
  // the cars within reach of you as box colliders (null: all parked)
  solidCars(p) {
    this.solid.begin();
    if (p) for (const tr of this.trains) {
      const onLoop = tr.state.dir < 0 && tr.state.s > LOOP.s0 && tr.state.s < LOOP.s1;
      if (Math.abs(trackPoint(tr.state.s, onLoop, _c).x - p.x) > 60 || Math.abs(_c.z - p.z) > 60) continue;
      for (const k of [-1, 1]) {
        const sc = tr.state.s + k * SET_HALF;
        trackPoint(sc, onLoop, _c); railAt(sc, _f);
        this.solid.add(_c.x, _c.y, _c.z, _f.dx, _f.dz, p);
      }
    }
    this.solid.end();
  }

  // ------------------------------------------------------------------ stations + boarding
  /** The prompt at a station's platform: { label, act } (act gets { board(up) } from main.js) or null. */
  interaction(p, { hasPass = false } = {}) {
    if (this.ride) return null;
    for (const st of this.stations.list) {
      if (Math.hypot(p.x - st.board.x, p.z - st.board.z) > 9) continue;
      const price = hasPass ? 'Day pass' : `$${RAIL_PRICE}`;
      if (st.id === 'tal') return { station: st, options: [{ up: true, label: `Up to Wolkenplatt · ${price}` }], label: `Ride the ${RAIL_NAME} to Wolkenplatt · ${price}` };
      if (st.id === 'platt') return { station: st, options: [{ up: false, label: 'Down to Legacy Village · free' }], label: `Ride the ${RAIL_NAME} down to Legacy Village` };
      return { station: st, options: [{ up: true, label: `Up to Wolkenplatt · ${price}` }, { up: false, label: 'Down to Legacy Village · free' }], label: `${st.name} · ${RAIL_NAME}` };
    }
    return null;
  }

  /**
   * For the route map (ui/travel.js): every other station from `id`, in line order, with the direction, the ride
   * time off the timetable and the track between: [{ id, name, up, min, km, pts: [[x, z]...] }].
   */
  destinations(id) {
    const S = RAIL.stations, k = S.findIndex((s) => s.id === id), P = PROFILE;
    const at = (s) => Math.max(P.i0, Math.min(P.i1, Math.round(s.s / STEP)));
    return S.filter((s, j) => j !== k).map((s) => {
      const a = at(S[k]), b = at(s), lo = Math.min(a, b), hi = Math.max(a, b), pts = [];
      for (let i = lo; i <= hi; i += 3) pts.push([RAIL.X[i], RAIL.Z[i]]);
      pts.push([RAIL.X[hi], RAIL.Z[hi]]);
      if (b < a) pts.reverse();
      return { id: s.id, name: s.name, up: S.indexOf(s) > k, min: Math.abs(P.T[b] - P.T[a]) / 60, km: Math.abs(s.s - S[k].s) / 1000, pts };
    });
  }

  /**
   * Board at station `id` heading up (true) or down: the timetable jumps so a train stands at the platform with
   * its doors open (main.js hides the jump behind a fade), and you take a window seat in its leading car.
   * `dest` (a station id) ends the ride there (default: the end of the line). Returns the seat (for player.sitOn).
   */
  board(id, up, destId = null) {
    const dir = up ? 1 : -1;
    const tr = this.trains[0];
    const want = boardingU(id, dir);
    // shift the timetable so train 0 is at cycle time `want`
    const u = ((((this.t / CYCLE + tr.phase) % 1) + 1) % 1) * CYCLE;
    this.t += want - u;
    this.update(0, {});
    const carIdx = up ? 0 : 1; // the car whose cab leads in this direction
    const car = tr.cars[carIdx];
    // the front seats facing the way we go, on the side with the better view (left going up: the valley)
    const seat = car.seats.find((s) => s.row === 1 && s.window && s.side > 0) || car.seats.find((s) => s.front && s.window) || car.seats[0];
    const dest = destId && destId !== id ? destId : up ? 'platt' : 'tal';
    this.ride = { train: tr, car: carIdx, seat, up, from: id, dest, departed: false, wait: 0 };
    this.look.yaw = 0; this.look.pitch = -0.04;
    this.view = 'seat';
    this.fov = null; this.chase.off = null;
    return this.seatPose();
  }

  // the rider's seat: { pos (world, seat surface), fwd (world, horizontal) } for player.sitOn / updateSit
  seatPose() {
    const r = this.ride, car = r.train.cars[r.car].group;
    car.updateMatrixWorld(true);
    const pos = r.seat.pos.clone();
    car.localToWorld(pos);
    const fwd = new THREE.Vector3(Math.sin(r.seat.yaw), 0, Math.cos(r.seat.yaw)).transformDirection(car.matrixWorld);
    fwd.y = 0; fwd.normalize();
    return { pos, fwd };
  }
  seatWorld() { return this.ride ? this.seatPose().pos : null; }

  /**
   * While riding: { seat, hint, stop?: { name, exit } (standing at Wolkensee: E gets you off) } or
   * { exit: { x, z, heading, name } } when you arrive (the ride is over).
   */
  updateRide() {
    const r = this.ride;
    if (!r) return null;
    const st = r.train.state;
    const seat = this.seatPose();
    if (st.at !== r.from) r.departed = true; // (it has left the station you boarded at)
    // arrived at the end of the trip: hand out the exit once (main.js fades out, then calls abort())
    if (r.departed && st.at === r.dest) {
      const sta = this.stations.list.find((x) => x.id === r.dest);
      if (!r.exitSent) { r.exitSent = true; return { seat, exit: { ...sta.exit, name: sta.name }, hint: `${sta.name} · arrived` }; }
      return { seat, hint: `${sta.name} · arrived` };
    }
    const next = r.up ? (st.s < RAIL.stations[1].s - 1 ? 'Wolkensee' : 'Wolkenplatt') : (st.s > RAIL.stations[1].s + 1 ? 'Wolkensee' : 'Legacy Village');
    let stop = null;
    if (r.departed && st.at === 'see' && !r.exitSent) {
      const sta = this.stations.list.find((x) => x.id === 'see');
      stop = { name: sta.name, exit: { ...sta.exit, name: sta.name } };
    }
    const kmh = Math.round(st.speed * 3.6);
    const hint = stop ? `${stop.name} · press E to get off here` : !r.departed ? `${RAIL_NAME} · departing for ${RAIL.stations.find((x) => x.id === r.dest)?.name || (r.up ? 'Wolkenplatt' : 'Legacy Village')}` : `${RAIL_NAME} · next stop ${next} · ${kmh} km/h`;
    return { seat, hint, stop };
  }
  /** Get off at Wolkensee while the train stands there: the exit spot (main.js fades out, then calls abort()). */
  leaveAtStop() {
    const r = this.ride;
    if (!r || r.train.state.at !== 'see' || r.exitSent) return null;
    r.exitSent = true;
    const sta = this.stations.list.find((x) => x.id === 'see');
    return { ...sta.exit, name: sta.name };
  }
  abort() { this.ride = null; }
  // dev: the terrain clip volumes on / off (A/B shots)
  terrainClip(on) { setTerrainClips(on ? this.clips : []); }
  // dev: move the timetable so train 0 is at arc length s on its way up (down: false = on its way down)
  debugAt(s, up = true) {
    const i = Math.round(clamp(s, TRIP_S0, TRIP_S1) / 2);
    const tUp = PROFILE.T[i];
    const u = up ? tUp : 2 * PROFILE.trip + DWELL_END - tUp;
    this.t = u - this.trains[0].phase * CYCLE + CYCLE * 10;
    this.update(0, {});
    return this.trains[0].state;
  }

  // ------------------------------------------------------------------ cameras
  /** Seat or outside camera while riding (call after player.update). R switches, the mouse looks around. */
  applyCamera(camera, input, dt) {
    const r = this.ride;
    if (!r) return false;
    if (input?.hit?.('KeyR')) { this.view = this.view === 'seat' ? 'outside' : 'seat'; this.chase.off = null; }
    const sens = 0.0022 * (input?.sensitivity || 1);
    const car = r.train.cars[r.car].group;
    car.updateMatrixWorld(true);
    // (the player's camera ran before this every frame: everything smoothed here keeps its own state)
    const k6 = 1 - Math.exp(-dt * 6);
    if (this.view === 'seat') {
      // (a seated passenger looks round to the side windows, not back through the own backrest)
      this.look.yaw = clamp(this.look.yaw - (input?.mdx || 0) * sens, -1.75, 1.75);
      this.look.pitch = clamp(this.look.pitch - (input?.mdy || 0) * sens, -0.9, 1.0);
      // the eye of a seated passenger, in the car's frame (it tilts with the car on the grade); turning to the
      // side, the head leans a little forward and away from the window pane
      const turn = Math.abs(Math.sin(this.look.yaw)), fz = Math.cos(r.seat.yaw);
      const eye = _a.copy(r.seat.pos).add(_b.set(-Math.sign(r.seat.pos.x) * turn * 0.1, 0.76, (0.06 + turn * 0.12) * fz));
      car.localToWorld(eye);
      const yaw = r.seat.yaw + this.look.yaw;
      const dir = _c.set(Math.sin(yaw) * Math.cos(this.look.pitch), Math.sin(this.look.pitch), Math.cos(yaw) * Math.cos(this.look.pitch)).transformDirection(car.matrixWorld);
      camera.position.copy(eye);
      camera.up.copy(_up).transformDirection(car.matrixWorld);
      camera.lookAt(eye.add(dir));
      camera.near = 0.05;
      this.camS = r.train.s;
      this.fov = this.fov == null ? 72 : lerp(this.fov, 72, k6);
    } else {
      this.chase.yaw -= (input?.mdx || 0) * sens;
      this.chase.pitch = clamp(this.chase.pitch - (input?.mdy || 0) * sens, -0.15, 0.9);
      this.chase.dist = clamp(this.chase.dist + (input?.wheel || 0) * 2, 14, 70);
      const tr = r.train, s = tr.s;
      const dirSign = tr.state.dir >= 0 ? 1 : (tr.state.dir < 0 ? -1 : (r.up ? 1 : -1));
      const onLoop = tr.state.dir < 0 && s > LOOP.s0 && s < LOOP.s1;
      // look at the middle of the set
      const target = trackPoint(s, onLoop, _t).add(_b.set(0, 2.2, 0));
      // orbit: behind the train (mouse to swing round, wheel to zoom)
      railAt(s, _f);
      const heading = Math.atan2(_f.dx, _f.dz) + (dirSign < 0 ? Math.PI : 0) + Math.PI + this.chase.yaw;
      const d = this.chase.dist, cp = Math.cos(this.chase.pitch);
      const want = _c.set(Math.sin(heading) * cp * d, Math.sin(this.chase.pitch) * d + 2, Math.cos(heading) * cp * d);
      // in a tunnel, a cutting or behind a shoulder the orbit would sit in the rock: follow the track instead
      // (just behind and above the last car, inside the tube / the cut)
      const tunnelNear = inTunnel(s, -60);
      let follow = tunnelNear;
      if (!follow) {
        // any terrain in the way (the whole sight line, the camera itself with room for the near plane)?
        for (let i = 1; i <= 10 && !follow; i++) {
          const k = i / 10, x = target.x + want.x * k, y = target.y + want.y * k, z = target.z + want.z * k;
          if (world.height(x, z) > y - (i === 10 ? 3 : 2)) follow = true;
        }
      }
      // (hysteresis: once the view has had to follow the track it keeps doing so for a moment, no flicking)
      if (follow) this.chase.hold = 1.2; else if ((this.chase.hold || 0) > 0) { this.chase.hold -= dt; follow = true; }
      this.camS = s;
      let rigid = false;
      if (follow) {
        this.camS = s - dirSign * (SET_HALF + CAR.half + 10);
        const back = trackPoint(this.camS, onLoop, _a);
        // in a tunnel: on the tube's axis, 4.6 m over the rail (inside the lining whatever the curve); in a cutting
        // a little higher, over the train's roof
        const inTube = inTunnel(this.camS, -4) || inTunnel(s, 0);
        want.set(back.x - target.x, back.y + (inTube || tunnelNear ? 4.6 : 7.5) - target.y, back.z - target.z);
        rigid = inTube;
        this.chase.yaw *= 1 - k6;
      }
      // never inside a station building: over its roof instead
      if (!follow) {
        const cx = target.x + want.x, cz = target.z + want.z;
        for (const st of this.stations.list) {
          const h = st.house;
          if (!h || Math.abs(cx - h.x) > h.r + 2 || Math.abs(cz - h.z) > h.r + 2 || Math.hypot(cx - h.x, cz - h.z) > h.r + 2) continue;
          want.y = Math.max(want.y, world.height(h.x, h.z) + 14 - target.y);
        }
      }
      // smooth the offset from the train (the camera never trails a fast train)
      if (!this.chase.off || this.chase.snap || rigid) this.chase.off = want.clone();
      else this.chase.off.lerp(want, 1 - Math.exp(-dt * 5));
      this.chase.snap = false;
      camera.position.copy(target).add(this.chase.off);
      camera.up.copy(_up);
      camera.lookAt(target);
      camera.near = 0.1;
      this.fov = this.fov == null ? 60 : lerp(this.fov, 60, k6);
    }
    camera.fov = this.fov;
    camera.updateProjectionMatrix();
    return true;
  }
  /** While riding: the train's speed (m/s) and a place name for the HUD. */
  get speed() { return this.ride ? Math.abs(this.ride.train.state.speed || 0) : 0; }
  locName(p = null) {
    const r = this.ride;
    if (!r) {
      // standing at one of the stations
      if (!p) return null;
      for (const st of this.stations.list) {
        const h = st.house || st.board;
        if (h && Math.hypot(p.x - h.x, p.z - h.z) < 60 && (st.id !== 'platt' || p.y > st.surface.y - 20)) return st.id === 'platt' ? 'Wolkenplatt · Gletscherbahnhof' : `${st.name} · ${RAIL_NAME}`;
      }
      return null;
    }
    const st = r.train.state;
    if (st.at) return this.stations.list.find((x) => x.id === st.at)?.name || RAIL_NAME;
    if (r.train.s > RAIL.stations[2].s0 - 30) return 'Wolkenplatt';
    return inTunnel(r.train.s, 0) ? `${RAIL_NAME} · tunnel` : RAIL_NAME;
  }

  // ------------------------------------------------------------------ light: tunnels, cabin, headlights
  /** After the environment update, before rendering: darkness inside tunnels, cabin light, snowfall indoors. */
  lateUpdate(camera, env, atmosphere, dt = 0.016) {
    if (!this.noPassengers) this.people?.update(dt, camera); // (multiplayer: nobody waiting at the stations either)
    // how deep inside a tunnel the camera is (0 outside / near a portal .. 1 well inside)
    let deep = 0;
    const cp = camera.position;
    for (const t of RAIL.tunnels) {
      // cheap test: near the line and below the ground
      if (!this.ride && !this.camNearRail(cp)) continue;
      const s = this.ride ? (this.camS ?? this.ride.train.s) : this.nearS;
      if (s === undefined || s < t.s0 || s > t.s1) continue;
      const inner = Math.min(s - t.s0, t.end ? 1e9 : t.s1 - s);
      deep = Math.max(deep, smoothstep(10, 70, inner));
    }
    this.dark = lerp(this.dark, deep, 1 - Math.exp(-dt * 3));
    const k = 1 - this.dark * 0.94;
    if (env && this.dark > 0.003) {
      env.sun.intensity *= k;
      env.hemi.intensity *= k;
      if (this.scene.environmentIntensity !== undefined) this.scene.environmentIntensity *= 1 - this.dark * 0.9;
    }
    if (this.dark > 0.3) { // no snowfall in a tunnel (atmosphere.update shows both again every frame)
      if (atmosphere?.snow) atmosphere.snow.visible = false;
      if (atmosphere?.crystalMesh) atmosphere.crystalMesh.visible = false;
    }
    const night = env ? clamp(Math.max(env.nightFactor || 0, 1 - (env.dayFactor ?? 1)), 0, 1) : 0;
    trainUniforms.uCabin.value = 0.3 + 0.9 * Math.max(night, this.dark);
    for (const m of this.passengerMats) m.emissiveIntensity = 0.05 + 0.4 * Math.max(night, this.dark);
    // dusk: the station windows and name boards light up (only when it changes)
    const nk = Math.round(night * 20) / 20;
    if (nk !== this.nightK) { this.nightK = nk; this.stations.setNight(nk); }
    trainUniforms.uHead.value = Math.max(night, this.dark);
    railUniforms.uDay.value = 1 - this.dark;
  }
  camNearRail(p) {
    // the arc length of the nearest point of the line to the camera (coarse: every 20 m), cached for lateUpdate
    let best = 1e9, bs = 0;
    for (let i = 0; i < RAIL.n; i += 10) { const d = (RAIL.X[i] - p.x) ** 2 + (RAIL.Z[i] - p.z) ** 2; if (d < best) { best = d; bs = RAIL.S[i]; } }
    this.nearS = bs;
    return best < 15 * 15 && p.y < railAt(bs, _f).y + 8;
  }
}

// ------------------------------------------------------------------ integration notes (main.js)
// boardRail(st, up): if (!hasPass() && up && !spend(RAIL_PRICE)) return;  transition.fade(() => { const seat =
//   railway.board(st.id, up); player.sitOn(seat); hide the rig; player.viewBeforeRide = player.view; })
// in the loop: if (railway.riding) { const r = railway.updateRide(); if (r?.seat) player.seat = r.seat;
//   if (r?.stop && input.hit('KeyE')) leave(railway.leaveAtStop()); if (r?.exit) leave(r.exit); hud.rideHint(r?.hint) }
export { PROFILE as RAIL_PROFILE, DWELL_END as RAIL_DWELL, TRIP_S1 as RAIL_TOP_S, ALT0 };
