// Ski bus: a stop in Legacy Village and one beside every gondola base station. Press E at a stop and
// ride to any other stop (walking up mountains isn't possible, so this is how you reach far-off peaks).
// With BUS_RIDE on, the yellow post bus really drives you there over plowed roads (game/bus/roads.js plans and
// carves them while the game loads, game/bus/bus.js has the bus, the roads' meshes and the ride); otherwise (or
// when two stops are not connected) the branded travel card covers the trip (main.js rideBus).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { fitModel } from '../core/assets.js';
import { busRoads, roadAt, ROAD_HALF } from './bus/roads.js';
import { BusLine } from './bus/bus.js';
import { propSeats } from './seating.js';
import { breakables } from '../world/breakables.js'; // (the stop signs: knocked flying by a car)

// the printed face of a stop's sign plate: SKI BUS over the stop's name, dark green on post-bus yellow
function stopFaceMaterial(name) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 816;
  const g = c.getContext('2d');
  g.fillStyle = '#f2c200'; g.fillRect(0, 0, 512, 816);
  g.fillStyle = '#0f5235'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = 'bold 168px Arial';
  g.fillText('SKI', 256, 250); g.fillText('BUS', 256, 430);
  g.fillRect(56, 500, 400, 10);
  let fs = 64;
  const label = String(name || '').toUpperCase();
  do { g.font = `bold ${fs}px Arial`; fs -= 4; } while (g.measureText(label).width > 430 && fs > 30);
  const words = label.split(' '), lines = [];
  for (const w of words) { const t = lines.length ? lines[lines.length - 1] + ' ' + w : w; if (lines.length && g.measureText(t).width <= 430) lines[lines.length - 1] = t; else lines.push(w); }
  lines.slice(0, 3).forEach((ln, i) => g.fillText(ln, 256, 590 + i * (fs + 14)));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.05 });
}

// The real bus ride: verified in the game 2026-10-26 (false: the travel card everywhere, no roads are planned).
// main.js: if (BUS_RIDE) planBusRoads(layout.busStops) right after initLayout() / initSecrets().
export const BUS_RIDE = true;

const VILLAGE_STOP = { x: -16, z: 46, heading: Math.PI * 0.5, name: 'Legacy Village' };

export class SkiBus {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.models   loaded GLTFs (wooden_bench optional)
   * @param {object} o.layout   the resort layout (gondolas, optional layout.busStops)
   * @param {Array} o.colliders shared collider list ({x, z, r})
   */
  constructor({ scene, models, layout, colliders, makeRig = null, cameraBlockers = null }) {
    this.group = new THREE.Group();
    this.group.name = 'ski-bus-stops';
    this.stops = this.findStops(layout);
    if (BUS_RIDE) for (const s of this.stops) this.besideBay(s);
    for (const s of this.stops) this.buildStop(s, models, colliders);
    scene.add(this.group);
    // the bus and its roads (planned before the terrain was built)
    this.line = null;
    if (BUS_RIDE && busRoads.roads.length) {
      try { this.line = new BusLine({ scene, models, makeRig, colliders, cameraBlockers }); } catch (e) { console.warn('ski bus', e); this.line = null; }
    }
  }

  // ------------------------------------------------------------------ the ride (BusLine), null-safe for main.js
  get riding() { return !!this.line?.riding; }
  get speed() { return this.line?.speed || 0; }
  /** Can the bus drive you from stop a to stop b (else main.js shows the travel card)? */
  canRide(a, b) { return !!this.line && this.line.canRide(this.netStop(a), this.netStop(b)); }
  /** Board at `from` for `to`: returns the seat ({ pos, fwd }) or null. */
  board(from, to) { return this.line ? this.line.board(this.netStop(from), this.netStop(to)) : null; }
  updateRide(dt, fast) { return this.line ? this.line.updateRide(dt, fast) : null; }
  applyCamera(camera, input, dt) { return this.line ? this.line.applyCamera(camera, input, dt) : false; }
  abort() { this.line?.abort(); }
  /** Per frame: the other buses on their rounds (bus.js BusLine.updateFleet). p: where you are. */
  updateFleet(dt, p) { this.line?.updateFleet(dt, p); }
  /** The buses now: [{ id ('bus:0'..'bus:7'), x, z, yaw, at, route, seats, taken }] (multiplayer seats, later). */
  fleetState() { return this.line ? this.line.fleetState() : []; }
  // the road network's own stop object for one of ours (same name: the sign stands beside the road's end)
  netStop(s) { return busRoads.stops.find((q) => q.name === s.name) || s; }

  // With a road: the sign and bench stand at the roadside where the bus's front door stops (the bus's right, off
  // its path), facing the road. (The village: where it departs; a terminus: where it arrives.)
  besideBay(s) {
    const net = this.netStop(s);
    const legs = busRoads.busLegs || [];
    const r = legs.find((q) => q.to === net) || busRoads.roads.find((q) => q.to === net) || legs.find((q) => q.from === net) || busRoads.roads.find((q) => q.from === net);
    if (!r) return;
    const arriving = r.to === net, BAY = 7, o = ROAD_HALF + 3.2;
    const p = roadAt(r, arriving ? r.length - BAY + 3 : BAY + 3);
    // right of the bus's heading there (arriving: along the road; departing: along it too, away from the stop)
    const rx = -p.dz, rz = p.dx;
    s.x = p.x + rx * o; s.z = p.z + rz * o;
    s.heading = Math.atan2(-rx, -rz); // facing the road
  }

  // Stops from the layout when it provides them, else next to each gondola's bottom station.
  findStops(layout) {
    if (layout.busStops?.length) return layout.busStops.map((s) => ({ ...s }));
    const stops = [{ ...VILLAGE_STOP }];
    for (const l of layout.lifts) {
      const type = l.spec?.type ?? l.type;
      if (type !== 'gondola' || l.main) continue; // the main gondola starts in the village
      const dx = l.top.x - l.bottom.x, dz = l.top.z - l.bottom.z, d = Math.hypot(dx, dz) || 1;
      const fx = dx / d, fz = dz / d; // up the lift line
      // beside the station, on its flattened pad, a little downhill of the boarding area
      const x = l.bottom.x - fx * 8 - fz * 15, z = l.bottom.z - fz * 8 + fx * 15;
      stops.push({ x, z, heading: Math.atan2(fx, fz), name: `${l.spec?.name ?? l.name ?? 'Gondola'} base` });
    }
    return stops;
  }

  // The stop: the Meshy post-bus stop sign (a yellow plate with a green rim on a steel pole, its foot in a concrete
  // base) with our own printed face on both sides of the plate (SKI BUS and the stop's name; the model's own
  // lettering is garbled), the plate facing the road and the plaza side behind it alike, and a bench beside it.
  buildStop(s, models, colliders) {
    const y = world.height(s.x, s.z);
    if (models.bus_stop_sign) {
      const sign = fitModel(models.bus_stop_sign, { size: 2.6, axis: 'y' });
      sign.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      // the plate's yellow face, measured on the model (x -0.30..0.44, y -0.33..0.85 of its 2-unit height, its
      // faces 0.09 out either side)
      const k = sign.userData.size.y / 2, mat = stopFaceMaterial(s.name);
      for (const side of [1, -1]) {
        const face = new THREE.Mesh(new THREE.PlaneGeometry(0.74 * k, 1.18 * k), mat);
        face.position.set(0.07 * k, (1 + 0.26) * k, side * (0.09 * k + 0.008));
        if (side < 0) face.rotation.y = Math.PI;
        face.receiveShadow = true;
        sign.add(face);
      }
      sign.position.set(s.x, y - 0.04, s.z);
      sign.rotation.y = s.heading;
      this.group.add(sign);
      colliders.push({ x: s.x, z: s.z, r: 0.6 });
      breakables.add(colliders[colliders.length - 1], [sign], { h: 2.6, loud: 0.6 }); // (a car knocks it flying, back after 90 s: world/breakables.js)
    }
    if (models.wooden_bench) {
      // bench beside the sign, facing the same way
      const bench = fitModel(models.wooden_bench, { size: 1.7, axis: 'xz' });
      const bx = s.x + Math.cos(s.heading) * 1.9, bz = s.z - Math.sin(s.heading) * 1.9;
      bench.position.set(bx, world.height(bx, bz) - 0.03, bz);
      bench.rotation.y = s.heading;
      bench.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(bench);
      colliders.push({ x: bx, z: bz, r: 0.8 });
      propSeats('wooden_bench', bench, 1.7); // (sit and wait)
    }
  }

  /** The stop the player is standing at (within r metres), or null. */
  stopNear(p, r = 3.5) {
    for (const s of this.stops) if (Math.hypot(p.x - s.x, p.z - s.z) < r) return s;
    // anywhere close to the waiting bus (within ~7 m of its body): the stop it waits at
    const at = this.line?.waitingAt(p, 7);
    if (at) return this.stops.find((s) => s.name === at.name) || null;
    return null;
  }

  /**
   * For the route map (ui/travel.js): the way the bus drives from one stop to another and how long it takes,
   * { pts: [[x, z]...], km, min }; a straight line (travel card) when the roads don't connect them.
   */
  route(from, to) {
    const legs = this.line?.legs(this.netStop(from), this.netStop(to));
    if (!legs) {
      const km = Math.hypot(to.x - from.x, to.z - from.z) / 1000;
      return { pts: [[from.x, from.z], [to.x, to.z]], km, min: Math.max(1, km * 1.05) }; // (~57 km/h door to door: BUS.cruise 26)
    }
    const pts = [[from.x, from.z]];
    let len = 0, t = legs.length * 4; // (a few seconds at each stop on the way)
    for (const L of legs) {
      for (let i = 0; i < L.n; i += 3) pts.push([L.X[i], L.Z[i]]);
      pts.push([L.X[L.n - 1], L.Z[L.n - 1]]);
      len += L.length;
      for (let i = 1; i < L.n; i++) t += (L.S[i] - L.S[i - 1]) / Math.max(2, (L.V[i] + L.V[i - 1]) / 2);
    }
    pts.push([to.x, to.z]);
    return { pts, km: len / 1000, min: t / 60 };
  }

  /** The plowed road network as polylines (route map). */
  networkLines() {
    return busRoads.roads.map((r) => {
      const out = [];
      for (let i = 0; i < r.n; i += 3) out.push([r.X[i], r.Z[i]]);
      out.push([r.X[r.n - 1], r.Z[r.n - 1]]);
      return out;
    });
  }

  /** Where you can ride from a stop, nearest first. */
  destinations(from) {
    return this.stops.filter((s) => s !== from)
      .map((s) => ({ stop: s, km: Math.hypot(s.x - from.x, s.z - from.z) / 1000 }))
      .sort((a, b) => a.km - b.km);
  }
}
