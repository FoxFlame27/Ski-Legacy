// Ski Legacy native port: the transport's runtime data (Phase 3), written into transport.json's `net` by
// export_resort.mjs once the game's own modules have planned and built everything:
//   roads      every road of busRoads (game/bus/roads.js): its centre line (x, y, z, arc length every ~4 m), the stops at
//              its ends, its kind (access / scenic / depot...), the speed profile speedlimits.js gives it (signed limit,
//              braked envelopes of the limit and of the bends, both ways); the bus legs (chalet village, scenic stops)
//   stops, lots (car parks with their bays), junctions, lay-bys, guardrail lines, the road tunnels' tubes
//   parked     the cars parking.js parks (model, place, heading)
//   cars       per car model: the fit (model space -> car frame: nose +z, wheels on y 0, real length; cars.js fitCar),
//              the nodes fitCar leaves out, the glass materials, drive.js CAR_SPECS / MASS / DRIVE, the Autohaus price
//   bus        the Micruss's fit (bus.js buildMicruss), seats, BUS constants
//   rail       the Wolkenspitzbahn (railroute.js): the line, stations, tunnels, the passing loop, the speed profile and
//              timetable constants, the stations' board / exit spots (railstations.js); the railcar (train.js: the
//              Meshy body's fit, the procedural cabin / underframe / bogie as local meshes, the rider's seat)
//   express    the Legacy Express (expressroute.js / expressground.js / express.js): the ring, stations, tunnels,
//              viaducts, the speed profile
// Long arrays go to transport.bin (Float32 / Int16); the JSON holds their offsets.
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function exportNet({ THREE, SRC, world, L, busRoads, skibus, parking, roadTunnels, railStations, xtrack, models, freeMod, loadGLB, pack, log, r4 }) {
  const imp = (p) => import(pathToFileURL(path.join(SRC, p)));
  const f32 = (a) => ({ off: pack.blob(Float32Array.from(a)), n: a.length });
  const i16 = (a) => ({ off: pack.blob(Int16Array.from(a)), n: a.length });
  const out = {};

  // ---------------------------------------------------------------- roads
  const { roadProfile } = await imp('game/bus/speedlimits.js');
  const stops = busRoads.stops || [];
  const sIdx = (s) => stops.indexOf(s);
  const line = (r) => ({ n: r.n, length: r.length ?? r.S[r.n - 1], X: f32(r.X), Y: f32(r.Y), Z: f32(r.Z), S: f32(r.S), from: sIdx(r.from), to: sIdx(r.to) });
  out.roads = busRoads.roads.map((r) => {
    const o = { ...line(r), access: !!r.access, scenic: !!r.scenic, depot: !!r.depot, heli: !!r.heli, ring: !!r.ringRoad, loop: !!r.loop, chalet: !!r.chalet };
    try {
      const P = roadProfile(r);
      o.prof = { kmh: i16(P.kmh), limF: f32(P.limF), limB: f32(P.limB), vcF: f32(P.vcF), vcB: f32(P.vcB) };
    } catch (e) { log('road profile', e.message); }
    return o;
  });
  out.busLegs = (busRoads.busLegs || []).map(line);
  out.stops = stops.map((s) => ({ name: s.name, x: r4(s.x), z: r4(s.z), heading: r4(s.heading ?? 0), noRoad: !!s.noRoad }));
  out.lots = busRoads.lots.map((q) => ({
    name: q.name || '', x: r4(q.x), z: r4(q.z), y: r4(q.y ?? world.height(q.x, q.z)), ux: r4(q.ux ?? 1), uz: r4(q.uz ?? 0), vx: r4(q.vx ?? 0), vz: r4(q.vz ?? 1),
    hw: r4(q.hw ?? 0), hd: r4(q.hd ?? 0), ex: r4(q.ex ?? q.x), ez: r4(q.ez ?? q.z),
    building: !!q.building, impound: !!q.impound, scenic: !!q.scenic, hospital: !!q.hospital, depot: !!q.depot,
    bays: (q.bays || []).map((b) => [r4(b.x), r4(b.z), r4(b.hx), r4(b.hz)]),
  }));
  out.junctions = busRoads.junctions.map((j) => [r4(j.x), r4(j.z)]);
  out.laybys = (busRoads.laybys || []).map((b) => [r4(b.x), r4(b.z), r4(b.yaw)]);
  out.rails = (busRoads.rails || []).map((g) => [r4(g.ax), r4(g.az), r4(g.bx), r4(g.bz), g.roadTunnel ? 1 : 0]);
  {
    const { TUBE } = await imp('game/bus/tunnels.js');
    out.roadTunnels = (busRoads.tunnels || []).map((t) => {
      const pts = [], A = {};
      for (let s = t.pF0 - 3; s <= t.pF1 + 3 + 1e-6; s += 4) { t.path.at(Math.min(s, t.pF1 + 3), A); pts.push([r4(A.x), r4(A.z), r4(t.floor(Math.min(s, t.pF1 + 3)))]); }
      return { name: t.name || '', pts, wi: TUBE.Wi, hc: TUBE.Hc };
    });
  }
  out.depot = busRoads.depot ? { x: r4(busRoads.depot.x ?? 0), z: r4(busRoads.depot.z ?? 0) } : null;
  out.autohaus = busRoads.rental ? { x: r4(busRoads.rental.x), y: r4(busRoads.rental.y ?? 0), z: r4(busRoads.rental.z), dirx: r4(busRoads.rental.dirx ?? 0), dirz: r4(busRoads.rental.dirz ?? 1) } : null;
  out.parked = (parking?.cars || []).map((e) => ({ name: e.name, x: r4(e.car.position.x), y: r4(e.car.position.y), z: r4(e.car.position.z), yaw: r4(e.car.rotation.y), length: e.length }));
  log('net: roads', out.roads.length, 'legs', out.busLegs.length, 'stops', out.stops.length, 'lots', out.lots.length, 'rails', out.rails.length, 'road tunnels', out.roadTunnels.length, 'parked', out.parked.length);

  // ---------------------------------------------------------------- vehicles
  // a GLB's materials as the file has them (the exporter's loader strips extensions: the transmission is read here)
  const glbMaterials = (name) => {
    const buf = fs.readFileSync(path.join(SRC, '../public/models', name + '.glb'));
    const len = buf.readUInt32LE(12), json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
    return (json.materials || []).map((m) => ({ name: m.name || '', transmission: !!m.extensions?.KHR_materials_transmission }));
  };
  const { fitCar, CAR_MODELS, REAL } = await imp('game/cars.js');
  const { CAR_SPECS } = await imp('game/drive.js');
  const { RENTALS } = await imp('game/carrental.js');
  const MASS = { car_bmw_x3: 1900, car_audi_rs6: 2100, car_vw_golf_gti: 1450, car_tesla_m3: 1850, car_mercedes_sls: 1620, car_porsche_taycan: 2300,
    car_lamborghini_huracan: 1420, car_toyota_gr_yaris: 1280, car_audi_etron_gt: 2300, car_mercedes_gls: 2500 }; // (drive.js MASS)
  const DRIVE = { car_vw_golf_gti: 'fwd', car_mercedes_sls: 'rwd' }; // (drive.js DRIVE)
  const meshNames = (root) => { const s = []; root.traverse((o) => { if (o.isMesh) s.push(o.name); }); return s; };
  out.cars = [];
  for (const [name, length] of CAR_MODELS) {
    const g = models[name] || await loadGLB(name);
    if (!g) continue;
    const fit = fitCar(g, length, name), m = fit.children[0];
    m.updateMatrix();
    const kept = new Set(meshNames(m)), hide = [...new Set(meshNames(g.scene).filter((n) => !kept.has(n)))];
    const box = new THREE.Box3().setFromObject(fit), size = box.getSize(new THREE.Vector3());
    const glass = glbMaterials(name).map((q, i) => ({ ...q, i })).filter((q) => q.transmission || (/glass|glas$|window|windscreen/.test(q.name.toLowerCase()) && !/surr|frame|seal|rubber|trim/.test(q.name.toLowerCase())))
      .map((q) => ({ i: q.i, red: /red/.test(q.name.toLowerCase()), clear: /front_light|light/.test(q.name.toLowerCase()) && !/red/.test(q.name.toLowerCase()) }));
    const spec = CAR_SPECS[name] || {}, rent = RENTALS.find((x) => x.id === name);
    out.cars.push({ name, label: spec.label || name, accel: spec.accel ?? 5, top: spec.top ?? 55, electric: !!spec.electric, rev: spec.rev ?? 1, mass: MASS[name] ?? 1700,
      drive: DRIVE[name] || 'awd', length, size: [r4(size.x), r4(size.y), r4(size.z)], real: REAL[name] || null, fit: m.matrix.toArray().map(r4), hide, glass,
      price: rent?.price ?? 0, kind: rent?.kind || '' });
  }
  if (skibus?.line?.bus?.shell) {
    const B = await imp('game/bus/bus.js'), sh = skibus.line.bus.shell, m = sh.children[0];
    m.updateMatrix();
    out.bus = { model: 'ski_bus_micruss', fit: m.matrix.toArray().map(r4), BUS: B.BUS, size: sh.userData.size ? [sh.userData.size.x, sh.userData.size.y, sh.userData.size.z] : null,
      wheelBase: sh.userData.wheelBase ?? 6.8, fleet: B.FLEET_N ?? 8,
      glass: glbMaterials('ski_bus_micruss').map((q, i) => (/^(Windows|InteriorWindow)$/.test(q.name) ? i : -1)).filter((i) => i >= 0),
      paint: glbMaterials('ski_bus_micruss').map((q, i) => (q.name === 'Body' ? i : -1)).filter((i) => i >= 0),
      seats: (skibus.line.bus.seats || []).map((s) => ({ p: [r4(s.pos.x), r4(s.pos.y), r4(s.pos.z)], window: !!s.window, side: s.side, row: s.row })) };
  }

  // ---------------------------------------------------------------- the Wolkenspitzbahn
  {
    const R = await imp('world/railroute.js'), T = await imp('world/train.js'), W = await imp('world/railway.js');
    const { RAIL, PROFILE, PASSING_LOOP } = R;
    out.rail = {
      name: R.RAIL_NAME, step: R.STEP, n: RAIL.n, length: RAIL.length, X: f32(RAIL.X), Y: f32(RAIL.Y), Z: f32(RAIL.Z),
      stations: RAIL.stations.map((s) => ({ id: s.id, name: s.name, s: s.s, s0: s.s0, s1: s.s1, side: s.side ?? 1, halt: !!s.halt, underground: !!s.underground })),
      tunnels: RAIL.tunnels.map((t) => ({ s0: t.s0, s1: t.s1, end: !!t.end })), bridges: (RAIL.bridges || []).map((b) => ({ s0: b.s0, s1: b.s1 })),
      loop: PASSING_LOOP, V: f32(PROFILE.V), T: f32(PROFILE.T), i0: PROFILE.i0, i1: PROFILE.i1, trip: PROFILE.trip, stops: PROFILE.stops,
      dwellMid: R.DWELL_MID, dwellEnd: R.DWELL_END, dwellBot: R.DWELL_BOT, cycle: R.CYCLE, tripS0: R.TRIP_S0, tripS1: R.TRIP_S1,
      units: W.RAIL_UNITS, car: T.CAR, price: W.RAIL_PRICE,
      list: (railStations?.list || []).map((s) => ({ id: s.id, name: s.name, board: s.board ? [r4(s.board.x), r4(s.board.z)] : null, exit: s.exit ? [r4(s.exit.x), r4(s.exit.z), r4(s.exit.heading ?? 0)] : null })),
    };
    // the railcar: the Meshy body (setCarModel's stretch as a matrix on its first mesh), the procedural cabin, the
    // underframe and a bogie (local meshes), the rider's seat
    const g = models.rail_car2;
    if (g) {
      let mesh = null;
      g.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      g.scene.updateMatrixWorld(true);
      let geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      if (geo.index) geo = geo.toNonIndexed();
      geo.computeBoundingBox();
      const bb = geo.boundingBox, cut = bb.min.y + (bb.max.y - bb.min.y) * T.BODY_CFG.trim, P = geo.attributes.position, ob = new THREE.Box3(), v = new THREE.Vector3();
      for (let t = 0; t < P.count; t += 3) if ((P.getY(t) + P.getY(t + 1) + P.getY(t + 2)) / 3 > cut) for (let k = 0; k < 3; k++) ob.expandByPoint(v.fromBufferAttribute(P, t + k));
      const Lx = ob.max.x - ob.min.x, Wd = ob.max.z - ob.min.z, Ht = ob.max.y - ob.min.y;
      const M = new THREE.Matrix4().makeTranslation(0, T.BODY_CFG.base, 0)
        .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
        .multiply(new THREE.Matrix4().makeScale(T.CAR.len / Lx, T.BODY_CFG.height / Ht, (2 * T.CAR.hw) / Wd))
        .multiply(new THREE.Matrix4().makeTranslation(-(ob.min.x + ob.max.x) / 2, -ob.min.y, -(ob.min.z + ob.max.z) / 2));
      out.rail.body = { model: 'rail_car2', fit: M.toArray().map(r4) };
      try { T.setCarModel(g); } catch { /* (the procedural body) */ }
    }
    const car = T.buildCar({ number: 1 });
    const proc = car.group.getObjectByName('rail-car-proc');
    const frame = new THREE.Group();
    for (const ch of [...car.group.children]) if (ch !== proc && ch.name !== 'rail-car-meshy' && !car.bogies.includes(ch)) frame.add(ch.clone());
    out.rail.models = {
      cabin: proc ? pack.localModel(proc) : [],
      frame: pack.localModel(frame),
      bogie: car.bogies[0] ? pack.localModel(car.bogies[0]) : [],
      lo: car.lo ? pack.localModel(car.lo) : [],
    };
    out.rail.bogies = car.bogies.map((b) => [r4(b.position.x), r4(b.position.y), r4(b.position.z)]);
    const seat = car.seats.find((s) => s.row === 1 && s.window && s.side > 0) || car.seats.find((s) => s.front && s.window) || car.seats[0];
    out.rail.seat = seat ? { p: [r4(seat.pos.x), r4(seat.pos.y), r4(seat.pos.z)], yaw: seat.yaw } : null;
    out.rail.seats = car.seats.map((s) => [r4(s.pos.x), r4(s.pos.y), r4(s.pos.z), r4(s.yaw)]);
    log('net: rail', RAIL.n, 'samples,', RAIL.stations.length, 'stations, cycle', R.CYCLE.toFixed(0), 's; railcar parts', Object.entries(out.rail.models).map(([k, v]) => k + ':' + v.length).join(' '));
  }

  // ---------------------------------------------------------------- the Legacy Express
  try {
    const E = await imp('world/expressroute.js'), X = await imp('world/express.js');
    const { EXPRESS, EXPRESS_PROFILE } = E;
    if (EXPRESS.ready && EXPRESS_PROFILE.V) {
      out.express = {
        name: E.EXPRESS_NAME, step: E.STEP, n: EXPRESS.n, length: E.LENGTH, X: f32(EXPRESS.X), Y: f32(EXPRESS.Y), Z: f32(EXPRESS.Z), trackOff: E.TRACK_OFF,
        tunnels: EXPRESS.tunnels.map((t) => ({ s0: t.s0, s1: t.s1 })), bridges: EXPRESS.bridges.map((b) => ({ s0: b.s0, s1: b.s1 })),
        V: f32(EXPRESS_PROFILE.V), T: f32(EXPRESS_PROFILE.T), loop: EXPRESS_PROFILE.loop, dwell: E.DWELL, vmax: E.VMAX, price: X.EXPRESS_PRICE, fast: X.FAST,
        stations: (L.layout.express?.stations || []).map((s) => ({ id: s.id, name: s.name, course: s.course, s: s.s, x: r4(s.x), z: r4(s.z), y: r4(s.y), heading: r4(s.heading), side: s.side,
          board: s.board ? [r4(s.board.x), r4(s.board.z)] : null, exit: s.exit ? [r4(s.exit.x), r4(s.exit.z), r4(s.exit.heading ?? 0)] : null })),
      };
      log('net: express', EXPRESS.n, 'samples,', out.express.stations.length, 'stations, loop', EXPRESS_PROFILE.loop.toFixed(0), 's');
    }
  } catch (e) { log('net: express skipped', e.message); }
  void xtrack; void roadTunnels; void freeMod;
  return out;
}
