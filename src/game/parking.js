// Car parks: a big one by Legacy Village, a medium one at a gondola base, a small one at the trailhead (planned with
// their access roads in game/bus/roads.js, which also flattens them into the terrain and ploughs a berm round their
// edges). Here: the surface (packed snow over asphalt), crisp painted bays (real geometry, sharp at any distance),
// lamp posts that light up at night, a pay machine and a P sign at the entrance (Meshy props), and parked cars
// backed into the bays (centred, nose out toward the aisle).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { fitModel } from '../core/assets.js';
import { carTemplate, carInstance, CAR_MODELS } from './cars.js';
import { mulberry32 } from '../core/noise.js';
import { nightUniform } from '../world/village.js';
import { busRoads, roadsideBlocked, ROAD_HALF } from './bus/roads.js';

const BAY_W = 2.6, BAY_D = 5.5, LINE = 0.12; // (5.5 m deep: the longest car, 5.0 m, fits inside the lines)
// parked cars: [model, real length (m), which car park] (the car models are the user's own, in MODEL_LIST)
export const PARKED = [['car_bmw_x3', 4.7, 'big'], ['car_audi_rs6', 5.0, 'big'], ['car_vw_golf_gti', 4.3, 'medium'], ['car_tesla_m3', 4.7, 'small']];

// draw a hair toward the camera (stays on top of the flat terrain it lies on at every LOD, no z-fighting)
function decal(mat, k = 0.001) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      mvPosition.xyz *= ${(1 - k).toFixed(5)};
      gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.customProgramCacheKey = () => `lotdecal${k}`;
  return mat;
}

// packed snow over dark asphalt, tyre-polished in places, grit: tiles every 8 m
function lotTexture() {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // a warm mid grey (a cold dark grey reads blue-icy under the snow light), fine grain
  g.fillStyle = '#86837e'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 26000; i++) { const v = 108 + rnd() * 40; g.fillStyle = `rgba(${v + 6},${v + 3},${v},0.4)`; g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2); }
  // packed snow in soft drifts (the plough leaves a thin layer); every blob drawn wrapped so the tiles meet seamlessly
  const wrapped = (fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); };
  for (let i = 0; i < 110; i++) {
    const x = rnd() * S, y = rnd() * S, r = 40 + rnd() * 140;
    wrapped((ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, 'rgba(232,234,236,0.5)'); gr.addColorStop(1, 'rgba(232,234,236,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x + ox, y + oy, r, 0, 7); g.fill();
    });
  }
  for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(238,240,242,${0.2 + rnd() * 0.45})`; g.beginPath(); g.arc(rnd() * S, rnd() * S, 0.6 + rnd() * 2, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// The bays of a car park, in its own frame (u along the long side, v across): rows along both long sides (a middle
// double row in the big one), BAY_W x BAY_D between the painted lines. A bay is kept only when all of it is clear of
// the entrance mouth (8 m), of the access road (+1 m) and of every collider standing on it; the lines are drawn only
// for kept bays, so the markings and the cars always agree. Each bay: its centre, and (hx, hz) the way the nose of a
// car backed into it points (out, toward the aisle; the rear at the bay's back line).
export function lotBays(L, colliders = []) {
  const at = (u, v) => [L.x + L.ux * u + L.vx * v, L.z + L.uz * u + L.vz * v];
  const R = Math.hypot(L.hw, L.hd) + 8;
  const access = busRoads.roads.filter((r) => r.access && Math.hypot(r.X[0] - L.ex, r.Z[0] - L.ez) < 12);
  const near = colliders.filter((c) => c && !c.car && Number.isFinite(c.x) && (c.r != null || c.hw != null) && Math.hypot(c.x - L.x, c.z - L.z) < R + (c.r ?? Math.hypot(c.hw, c.hd)));
  const onRoad = (x, z) => {
    for (const r of access) for (let i = 1; i < r.n; i++) {
      const ax = r.X[i - 1], az = r.Z[i - 1], dx = r.X[i] - ax, dz = r.Z[i] - az;
      if (Math.abs(ax - x) > 40 || Math.abs(az - z) > 40) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < ROAD_HALF + 1) return true;
    }
    return false;
  };
  const inCollider = (x, z, c) => {
    const dx = x - c.x, dz = z - c.z;
    if (c.r != null) return Math.hypot(dx, dz) < c.r + 0.1;
    const cs = Math.cos(-(c.rot || 0)), sn = Math.sin(-(c.rot || 0));
    return Math.abs(dx * cs - dz * sn) < c.hw + 0.1 && Math.abs(dx * sn + dz * cs) < c.hd + 0.1;
  };
  const clear = (uc, vc) => {
    for (const a of [-1, -0.5, 0, 0.5, 1]) for (const b of [-1, -0.5, 0, 0.5, 1]) {
      const [x, z] = at(uc + a * BAY_W / 2, vc + b * BAY_D / 2);
      if (Math.abs(a) === 1 && Math.abs(b) === 1 && Math.hypot(x - L.ex, z - L.ez) < 8) return false; // (the mouth)
      if (onRoad(x, z) || near.some((c) => inCollider(x, z, c))) return false;
    }
    // (a small collider between the samples: its centre in the bay)
    for (const c of near) { const dx = c.x - L.x, dz = c.z - L.z; if (Math.abs(dx * L.ux + dz * L.uz - uc) < BAY_W / 2 && Math.abs(dx * L.vx + dz * L.vz - vc) < BAY_D / 2) return false; }
    return true;
  };
  const bays = [], lines = [], mid = new Set();
  const rows = [[-L.hd + 0.4, 1], [L.hd - 0.4, -1]];
  if (L.hd >= 16) rows.push([0, 1], [0, -1]);
  const n = Math.floor((L.hw * 2 - 3.5 * 2) / BAY_W), u0 = -n * BAY_W / 2;
  for (const [v0, dir] of rows) {
    const v1 = v0 + dir * BAY_D, vc = (v0 + v1) / 2, keep = [];
    for (let k = 0; k < n; k++) {
      const uc = u0 + (k + 0.5) * BAY_W;
      keep[k] = clear(uc, vc);
      if (!keep[k]) continue;
      const [x, z] = at(uc, vc);
      bays.push({ x, z, hx: dir * L.vx, hz: dir * L.vz, u: uc, v: vc, hw: BAY_W / 2, hd: BAY_D / 2, edge: v0 !== 0 });
      if (v0 === 0) mid.add(k);
    }
    // the dividers: each line beside a kept bay (once)
    for (let k = 0; k <= n; k++) if (keep[k - 1] || keep[k]) lines.push([u0 + k * BAY_W, v0, u0 + k * BAY_W, v1]);
  }
  for (const k of mid) lines.push([u0 + k * BAY_W, 0, u0 + (k + 1) * BAY_W, 0]); // (the middle double row's centre line)
  return { bays, lines };
}

export class ParkingLots {
  constructor({ scene, models, colliders, cameraBlockers = null }) {
    this.group = new THREE.Group();
    this.group.name = 'car-parks';
    this.bulbs = [];
    if (!busRoads.lots.length) return;
    try {
      // matte: packed snow and dry asphalt, no icy gloss or blue sky reflections
      const surf = decal(new THREE.MeshStandardMaterial({ map: lotTexture(), vertexColors: true, transparent: true, roughness: 1, metalness: 0, envMapIntensity: 0.15, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
      const paint = decal(new THREE.MeshStandardMaterial({ color: 0xeeefea, roughness: 0.92, metalness: 0, envMapIntensity: 0.15, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), 0.0013);
      this.bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffd59a, emissiveIntensity: 0, roughness: 0.4 });
      for (const L of busRoads.lots) {
        if (L.building) continue; // (the hospital's site: game/hospital.js)
        try { this.build(L, surf, paint, models, colliders); } catch (e) { console.warn('car park', L.name, e); }
      }
      scene.add(this.group);
      // the Dacias: parked at the roadside in their lay-bys (never in a car park, never in the traffic)
      for (const lb of busRoads.laybys || []) {
        if (!models.car_dacia_duster) break;
        try { this.roadsideCar(lb, models.car_dacia_duster, 4.34, colliders, cameraBlockers); } catch (e) { console.warn('roadside car', e); }
      }
      // parked cars: the car parks well filled (about 55 % of the bays), every model in many paint colours, mostly
      // with a free bay between them; seeded, so it is the same every time. Shared geometry; the detailed car only
      // close to the camera, a one-mesh version further out (update())
      try {
        const rnd = mulberry32(4417);
        const lots = busRoads.lots.filter((l) => !l.building && l.bays?.length);
        const colours = [null, 0xf2f2f0, 0x1b1d22, 0x9aa0a6, 0x24324e, 0x7a1d1d, 0x5d6166, 0xd8d2c4, 0x2f4a3a, 0xb8b1a3];
        const kinds = CAR_MODELS.filter(([name]) => models[name]);
        for (const lot of lots) {
          const want = Math.round(lot.bays.length * 0.55);
          const order = lot.bays.map((b) => ({ b, r: rnd() })).sort((a, b) => a.r - b.r).map((o) => o.b);
          let n = 0;
          // first with a free bay either side, then the rest at random
          for (const pass of [0, 1]) for (const bay of order) {
            if (n >= want || bay.taken) continue;
            if (pass === 0 && lot.bays.some((o) => o.taken && Math.hypot(o.x - bay.x, o.z - bay.z) < 3.2)) continue;
            const [name, length] = kinds[Math.floor(rnd() * kinds.length)];
            const paint = colours[Math.floor(rnd() * colours.length)];
            try { this.parkCar(lot, models[name], colliders, cameraBlockers, { length, bay, paint, name }); n++; } catch (e) { console.warn('parked car', name, e); }
          }
        }
      } catch (e) { console.warn('parked cars', e); }
    } catch (e) { console.warn('car parks', e); this.bulbMat = null; }
  }

  build(L, surf, paint, models, colliders) {
    const at = (u, v) => [L.x + L.ux * u + L.vx * v, L.z + L.uz * u + L.vz * v];
    const nearRoad = (x, z, r) => {
      for (const rd of busRoads.roads) for (let i = 0; i < rd.n; i += 2) if (Math.abs(rd.X[i] - x) < r && Math.abs(rd.Z[i] - z) < r && Math.hypot(rd.X[i] - x, rd.Z[i] - z) < r) return true;
      return false;
    };
    // surface: a grid over the lot that follows the (flattened) terrain a few cm up
    const nu = Math.ceil((L.hw * 2) / 2), nv = Math.ceil((L.hd * 2) / 2);
    const pos = [], uv = [], col = [], idx = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = -L.hw + (i / nu) * L.hw * 2, v = -L.hd + (j / nv) * L.hd * 2, [x, z] = at(u, v);
      pos.push(x, world.height(x, z) + 0.03, z); uv.push(u / 14, v / 14);
      // the edges fade into the snow (no hard slab edge against the bank)
      const e = Math.min(L.hw - Math.abs(u), L.hd - Math.abs(v)), a = Math.min(1, Math.max(0, e / 1.8));
      col.push(1, 1, 1, a * a * (3 - 2 * a));
      if (i < nu && j < nv) { const a = j * (nu + 1) + i, b = a + nu + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    sg.setIndex(idx); sg.computeVertexNormals();
    const surface = new THREE.Mesh(sg, surf);
    surface.receiveShadow = true;
    this.group.add(surface);
    // painted bays: rows along both long sides (a middle double row in the big one), crisp white strips
    const lp = [], li = [];
    const strip = (u0, v0, u1, v1) => {
      const du = u1 - u0, dv = v1 - v0, l = Math.hypot(du, dv) || 1, nu2 = (-dv / l) * LINE / 2, nv2 = (du / l) * LINE / 2;
      const base = lp.length / 3;
      for (const [u, v] of [[u0 + nu2, v0 + nv2], [u0 - nu2, v0 - nv2], [u1 + nu2, v1 + nv2], [u1 - nu2, v1 - nv2]]) { const [x, z] = at(u, v); lp.push(x, world.height(x, z) + 0.05, z); }
      li.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    };
    const { bays, lines } = lotBays(L, colliders);
    L.bays = bays;
    for (const [u0, v0, u1, v1] of lines) strip(u0, v0, u1, v1);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setIndex(li); lg.computeVertexNormals();
    this.group.add(new THREE.Mesh(lg, paint));
    // props (Meshy): lamp posts along the long sides, the pay machine and the P sign by the entrance
    const prop = (name, size, x, z, yaw, r) => {
      if (!models[name]) return null;
      const m = fitModel(models[name], { size, axis: 'y' });
      m.position.set(x, world.height(x, z) - 0.02, z);
      m.rotation.y = yaw;
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(m);
      colliders.push({ x, z, r });
      return m;
    };
    const lamps = Math.max(2, Math.round((L.hw * 2) / 22));
    for (let k = 0; k < lamps; k++) {
      const u = -L.hw + 4 + (k / Math.max(1, lamps - 1)) * (L.hw * 2 - 8);
      for (const side of [-1, 1]) {
        const [x, z] = at(u, side * (L.hd + 0.9));
        if (Math.hypot(x - L.ex, z - L.ez) < 10) continue;
        if (nearRoad(x, z, 7.5)) continue; // (never in a road's way)
        const lamp = prop('lamp_post', 5.6, x, z, Math.atan2(-L.vx * side, -L.vz * side), 0.3);
        if (lamp) {
          // the bulb, glowing at dusk and night
          const b = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), this.bulbMat);
          b.position.set(x - L.vx * side * 0.35, world.height(x, z) + 5.15, z - L.vz * side * 0.35);
          this.group.add(b);
        }
      }
    }
    // the pay machine and the P sign stand beside the entrance, just outside the car park (never in its mouth, where
    // the cars turn in), clear of the access road and every other road: further out to the side until they are
    const sx = -L.dirz, sz = L.dirx; // across the mouth
    const beside = (out, lat, r) => {
      for (let k = 0; k <= 12; k++) {
        const o = lat + Math.sign(lat) * k * 0.5, x = L.ex + L.dirx * out + sx * o, z = L.ez + L.dirz * out + sz * o;
        if (!roadsideBlocked(x, z, r + 0.4, -1, 0, { lots: false })) return [x, z];
      }
      return null;
    };
    const pm = beside(-0.6, 6.2, 0.6); // (1.4 m outside the edge: still the car park's flat, no berm by the mouth)
    if (pm) prop('parking_pay_machine', 1.75, pm[0], pm[1], Math.atan2(sx, sz) + Math.PI, 0.6);
    const ps = beside(3, -7.6, 0.25);
    if (ps) prop('parking_sign', 2.7, ps[0], ps[1], Math.atan2(L.dirx, L.dirz), 0.25);
  }

  // The BMW (a detailed model: 110 meshes, transmission glass): glass made plain tinted see-through (transmission
  // costs a whole extra render pass), lights off, the meshes merged per material (a few draw calls), a box collider
  // and a camera blocker. Backed into its bay: centred in it, the nose out toward the aisle (lotBays()).
  parkCar(L, gltf, colliders, cameraBlockers, { length = 4.7, bay = null, paint = null, name = '' } = {}) {
    if (!bay) return null;
    bay.taken = true;
    const inst = carInstance(carTemplate(gltf, length, name), { paint }), car = inst.group; // (shared, merged per material, glass tinted)
    car.name = 'parked-car';
    const yaw = Math.atan2(bay.hx, bay.hz);
    car.position.set(bay.x, world.height(bay.x, bay.z) + 0.03, bay.z);
    car.rotation.y = yaw;
    this.group.add(car);
    const collider = { x: bay.x, z: bay.z, hw: 0.97, hd: length / 2, rot: -yaw, h: 1.7, car: true };
    colliders.push(collider);
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, length - 0.1), new THREE.MeshBasicMaterial());
    block.position.y = 0.8; block.visible = false;
    car.add(block);
    car.updateMatrixWorld(true);
    cameraBlockers?.push(block);
    (this.cars ||= []).push({ car, inst, t: carTemplate(gltf, length, name), far: null, full: car.children[0], name, length, paint, collider, block, bay, held: [bay] });
    return bay;
  }

  roadsideCar(lb, gltf, length, colliders, cameraBlockers) {
    const inst = carInstance(carTemplate(gltf, length, 'car_dacia_duster')), car = inst.group;
    car.name = 'parked-roadside-car';
    car.position.set(lb.x, world.height(lb.x, lb.z) + 0.03, lb.z);
    car.rotation.y = lb.yaw;
    this.group.add(car);
    const collider = { x: lb.x, z: lb.z, hw: 0.97, hd: length / 2, rot: -lb.yaw, h: 1.7, car: true };
    colliders.push(collider);
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.85, 1.5, length - 0.1), new THREE.MeshBasicMaterial());
    block.position.y = 0.8; block.visible = false;
    car.add(block);
    car.updateMatrixWorld(true);
    cameraBlockers?.push(block);
    (this.cars ||= []).push({ car, inst, t: carTemplate(gltf, length, 'car_dacia_duster'), far: null, full: car.children[0], name: 'car_dacia_duster', length, paint: null, collider, block });
  }

  /** Per frame: the lamps come on at dusk; parked cars: detailed close to the camera, one mesh further out. */
  update(camera = null) {
    try {
      if (camera && this.cars?.length) {
        this.lodT = (this.lodT || 0) - 1;
        if (this.lodT <= 0) {
          this.lodT = 10; // (every 10 frames)
          const c = camera.position;
          for (const p of this.cars) {
            if (p.driving) continue; // (the car you drive: drive.js shows it)
            const d = Math.hypot(p.car.position.x - c.x, p.car.position.z - c.z);
            if (!p.far && p.t.lod) { const m = new THREE.Mesh(p.t.lod.geometry, p.t.lod.material); m.visible = false; m.castShadow = true; p.car.add(m); p.far = m; }
            const near = d < 55 || !p.far;
            p.car.visible = d < 420;
            p.full.visible = near;
            if (p.far) p.far.visible = !near;
          }
        }
      }
    } catch { /* (never stop the game over a parked car) */ }
    if (!this.bulbMat) return;
    try {
    const n = nightUniform?.value ?? 0;
    this.bulbMat.emissiveIntensity = n > 0.15 ? 2.5 * Math.min(1, n * 1.4) : 0;
    } catch { /* (never stop the game over a lamp) */ }
  }
}
