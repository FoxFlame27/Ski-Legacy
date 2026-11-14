// Ski Legacy native port: the gameplay data (Phase 5), written by export_resort.mjs as a third pack, `play.json / .bin`,
// once the game's own modules have planned and built the resort and the transport:
//   courses    the World Racing courses (modes/parkour/courses.js, freeworld.js: name, difficulty, prize, par / medals,
//              start / finish / checkpoints / slalom gates, the line every 2 m with width, heading, curvature) and the
//              ski bus's free races (modes/race/busraces.js: the piste courses, their boards beside the stops); their
//              meshes (start house, arches, nets, gates, FINISH portal, grandstands...) captured like the resort's
//   stand      the RACING stand beside the village job board (game/racestand.js placement rules)
//   jobs       the job sites (game/jobs/sites.js: the boards' hubs, every destination, the piste-side spots, the lifts
//              the router knows); the C++ ports catalog.js and the Router on them
//   taxi       the taxi's places (game/taxi.js buildPlaces)
//   prison, impound (the Autohaus car park), helipad, hospital, chalets (the 18 houses' frames, game/chalets.js) and
//              the chalet's ground floor plan (game/build/chaletlayout.js), the furniture catalogue (game/build/catalog.js)
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function exportPlay({ THREE, SRC, world, L, busRoads, skibus, models, freeMod, loadGLB, makePack, cols, log, r4 }) {
  const imp = (p) => import(pathToFileURL(path.join(SRC, p)));
  const pScene = new THREE.Scene();
  const pCols = [];
  const out = {};
  const pack = makePack('play', { instColor: true });
  const f32 = (a) => ({ off: pack.blob(Float32Array.from(a)), n: a.length });
  for (const n of ['job_board', 'start_house', 'race_arch', 'grandstand', 'timing_board', 'patrol_hut', 'snow_cannon', 'lamp_post', 'snowmobile', 'piste/bnet_panel', 'piste/flag_pole', 'floodlight_mast', 'floodlight_head_b', 'floodlight_head_c'])
    if (!models[n]) models[n] = await loadGLB(n);
  const pt = (p) => (p ? { x: r4(p.x), y: r4(p.y ?? world.height(p.x, p.z)), z: r4(p.z), heading: r4(p.heading ?? 0), s: r4(p.s ?? 0) } : null);
  const courseOut = (e, bus) => {
    const c = e.course, T = c.track, n = T.n;
    const X = [], Y = [], Z = [], W = [], H = [], K = [], B = [], F = [];
    for (let i = 0; i < n; i++) {
      X.push(T.X[i]); Z.push(T.Z[i]); W.push(T.W ? T.W[i] : 8); H.push(T.H[i]);
      Y.push(T.Y ? T.Y[i] : world.height(T.X[i], T.Z[i]));
      // (bots.js Track: the bank of the piste and the snow's friction along it, course.frictionAt: ice < 1)
      B.push(T.B ? T.B[i] : 0);
      { let f = 1; try { if (typeof c.frictionAt === 'function') f = c.frictionAt(i * 2); } catch { f = 1; } F.push(Number.isFinite(f) ? f : 1); }
      if (T.K) K.push(T.K[i]);
      else { const a = T.H[Math.max(0, i - 1)], b = T.H[Math.min(n - 1, i + 1)]; K.push(Math.atan2(Math.sin(b - a), Math.cos(b - a)) / (2 * 2 * (i > 0 && i < n - 1 ? 1 : 0.5))); }
    }
    const o = {
      id: e.id, name: e.name, bus, diff: e.D?.label || 'Medium', color: e.D?.color || '#2f7bff', entry: e.D?.entry ?? 0, ai: e.D?.ai || 'medium',
      reward: e.reward ?? 0, rewardMax: e.rewardMax ?? 0, length: r4(e.length ?? c.length), drop: Math.round(e.drop ?? c.drop ?? 0),
      par: c.par ?? e.par ?? null, medals: c.medals ?? null, tagline: c.tagline || e.def?.tagline || '',
      start: pt(c.start), finish: pt(c.finish),
      checkpoints: (c.checkpoints || []).map((q) => ({ ...pt(q), name: q.name })),
      gates: (c.gates || []).map((g) => ({ s: r4(g.s), x: r4(g.x), y: r4(g.y ?? world.height(g.x, g.z)), z: r4(g.z), side: g.side, color: g.color, nx: r4(g.nx), nz: r4(g.nz), width: g.width || 8 })),
      line: { n, ds: 2, X: f32(X), Y: f32(Y), Z: f32(Z), W: f32(W), H: f32(H), K: f32(K), B: f32(B), F: f32(F) },
      night: !!(c.def?.night), masts: (c.floodlights || []).map((m) => [m.x, m.y, m.z, m.yaw, m.lx, m.ly, m.lz, m.ax, m.ay, m.az].map(r4)),
    };
    if (bus) { o.stop = e.stop; o.end = e.end; o.board = e.board ? { x: r4(e.board.x), z: r4(e.board.z), yaw: r4(e.board.yaw) } : null; }
    if (c.startHouse) o.house = pt(c.startHouse);
    return o;
  };

  // ---------------------------------------------------------------- the World Racing courses (their meshes too)
  out.courses = [];
  for (const e of freeMod.freeCourses()) {
    try {
      const g = e.course.build(pScene, models);
      // (the low-poly spectators are per-instance coloured: the C++ draws the crowd with the real characters instead,
      // game/races.cpp addPeople; their colliders stay)
      const nc = g?.userData?.crowd || 0;
      if (nc) for (const o of g.children) if (o.isInstancedMesh && o.count === nc) o.userData.slSkip = true;
      for (const s of e.course.solids || []) pCols.push(s);
      for (const m of e.course.floodlights || []) pCols.push({ x: m.x, z: m.z, r: 0.2, h: 11 });
      out.courses.push(courseOut(e, false));
    } catch (err) { log('course', e.id, 'skipped:', err.message); }
  }
  log('play: courses', out.courses.length);
  // ---------------------------------------------------------------- the job sites (the boards, destinations, spots)
  const { Sites } = await imp('game/jobs/sites.js');
  let sites = null;
  try { sites = new Sites({ layout: L.layout, colliders: [...cols] }); } catch (err) { log('job sites skipped:', err.message); }
  const plain = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) if (typeof v === 'number') r[k] = r4(v); else if (typeof v === 'string' || typeof v === 'boolean') r[k] = v; return r; };
  if (sites) {
    out.jobs = {
      hubs: sites.hubs.map((h) => ({ ...plain(h), front: { x: r4(h.front.x), z: r4(h.front.z) }, hut: !!h.hut })),
      dests: sites.dests.map(plain),
      spots: sites.spots.map(plain),
      lifts: sites.lifts.map((l) => ({ id: l.id, name: l.name, type: l.type, len: r4(l.len), bottom: plain(l.bottom), top: plain(l.top), topExit: plain(l.topExit), bottomExit: plain(l.bottomExit) })),
    };
    log('play: job sites', out.jobs.hubs.length, 'boards,', out.jobs.dests.length, 'destinations,', out.jobs.spots.length, 'spots');
  }
  // ---------------------------------------------------------------- the ski bus's free races (+ their boards)
  out.busRaces = [];
  try {
    const BR = await imp('modes/race/busraces.js');
    const br = new BR.BusRaces({ scene: pScene, models, colliders: pCols, stops: skibus?.stops || [], sites });
    for (const e of BR.busRaceEntries()) {
      try { e.course.build(pScene, models); for (const s of e.course.solids || []) pCols.push(s); } catch (err) { log('bus race meshes', e.id, err.message); }
      out.busRaces.push(courseOut(e, true));
    }
    void br;
  } catch (err) { log('bus races skipped:', err.stack?.split('\n').slice(0, 3).join(' | ')); }
  log('play: bus races', out.busRaces.length);
  // ---------------------------------------------------------------- the RACING stand beside the village board
  try {
    const { RaceStand } = await imp('game/racestand.js');
    const jobs = { sites, boardById: (id) => { const hub = sites?.hubs.find((h) => h.id === id); return hub ? { hub } : null; }, recheckBoards() {} };
    const rs = new RaceStand({ scene: pScene, models, jobs, colliders: pCols, open() {} });
    if (rs.spot) out.stand = { x: r4(rs.spot.x), z: r4(rs.spot.z), yaw: r4(rs.spot.yaw) };
  } catch (err) { log('race stand skipped:', err.message); }
  // the job boards themselves (job_board.glb where the hubs stand: jobs.js buildBoard)
  out.boardModel = !!models.job_board;
  // ---------------------------------------------------------------- the taxi's places
  try {
    const { Taxi } = await imp('game/taxi.js');
    out.taxi = Taxi.prototype.buildPlaces.call({ layout: L.layout }).map((p) => ({ name: p.name, x: r4(p.x), z: r4(p.z), sx: r4(p.sx ?? p.x), sz: r4(p.sz ?? p.z) }));
    log('play: taxi places', out.taxi.length);
  } catch (err) { log('taxi places skipped:', err.message); }
  // ---------------------------------------------------------------- sites planned with the roads
  for (const k of ['prison', 'rentalPark', 'helipad', 'hospital', 'rental']) if (busRoads[k]) out[k] = plain(busRoads[k]);
  // the chalets: the 18 houses (game/chalets.js plan(): each plot's frame, door and the spot outside it)
  try {
    const CH = await imp('game/chalets.js');
    const o = Object.create(CH.Chalets.prototype);
    Object.assign(o, { V: busRoads.chalets, houses: [], save: null });
    o.plan();
    out.chalets = o.houses.map((h) => ({ id: h.id, num: h.num, name: h.name, x: r4(h.frame.position.x), y: r4(h.frame.position.y), z: r4(h.frame.position.z), yaw: r4(h.yaw),
      door: h.door ? { x: r4(h.door.x), z: r4(h.door.z) } : null, out: h.out ? { x: r4(h.out.x), z: r4(h.out.z) } : null }));
    out.chaletPrice = CH.CHALET_PRICE;
    const P = await imp('game/chaletplan.js');
    out.chaletModel = { ...P.MODEL, HX: P.HX, HZ: P.HZ, IX: P.IX, IZ: P.IZ, G: P.G, GC: P.GC, DOOR: P.DOOR };
    log('play: chalets', out.chalets.length);
  } catch (err) { log('chalets skipped:', err.stack?.split('\n').slice(0, 3).join(' | ')); }
  try {
    const { planLayout, planSills } = await imp('game/build/chaletlayout.js');
    const g = planLayout()[0];
    out.chaletPlan = { floorY: g.floorY, ceilingY: g.ceilingY, rects: g.rects, walls: g.walls.map((w) => ({ ax: r4(w.ax), az: r4(w.az), bx: r4(w.bx), bz: r4(w.bz), t: w.t, y0: r4(w.y0), y1: r4(w.y1) })),
      blocks: g.blocks.map((b) => ({ x: b.x, z: b.z, hw: b.hw, hd: b.hd })), sills: planSills().filter((s) => s.level === 'ground') };
    const C = await imp('game/build/catalog.js');
    out.furniture = C.FURNITURE; out.categories = C.CATEGORIES; out.sellRefund = C.SELL_REFUND;
  } catch (err) { log('chalet plan skipped:', err.message); }

  // ---------------------------------------------------------------- the rooms you walk into (export_rooms.mjs)
  try { out.rooms = await (await import('./export_rooms.mjs')).exportRooms({ THREE, SRC, models, loadGLB, pack, log, r4 }); }
  catch (err) { log('rooms skipped:', err.stack?.split('\n').slice(0, 3).join(' | ')); }
  // ---------------------------------------------------------------- the helicopter, its pad, the ambulance, the ward
  const m34 = (m) => { const e = m.elements; return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]].map((v) => Math.round(v * 1e5) / 1e5); };
  const surfBefore = new Set();
  for (const arr of world.surfaceGrid.values()) for (const s of arr) surfBefore.add(s);
  try { out.heli = await exportHeli({ THREE, imp, world, L, models, loadGLB, pack, pScene, pCols, cols, log, r4, freeMod }); } catch (err) { log('heli skipped:', err.stack?.split('\n').slice(0, 4).join(' | ')); }
  try { out.ward = await exportWard({ THREE, imp, busRoads, loadGLB, pack, log, r4, m34 }); } catch (err) { log('ward skipped:', err.stack?.split('\n').slice(0, 4).join(' | ')); }
  const surfSet = new Set();
  for (const arr of world.surfaceGrid.values()) for (const s of arr) if (!surfBefore.has(s)) surfSet.add(s);

  // ---------------------------------------------------------------- capture
  pack.capture(pScene);
  pack.finish({ colliders: pack.colliderOut(pCols.filter((c) => c && Number.isFinite(c.x))), surfaces: pack.sampleSurfaces(surfSet), play: out });
}

// The heli-ski base and the helicopter (game/heli.js, heli/pad.js, model.js, zones.js, ambulance.js), built by the
// game's own modules: the pad (deck with its painted H, edge lights, the hut and its sign, the floodlight mast, the
// windsock) goes into the pack's scene with its colliders and its walkable deck; the helicopter's parts as local
// meshes: `body` (the Meshy airframe with its static rotor head cut away by model.js meshyBody, the mast, the ski
// basket; root frame: metres round the centre of mass), the main rotor's hub and one blade (droop pivot frame), the
// tail rotor's hub and blades (spin frame), the two blur discs with their painted textures; the numbers the flight
// model runs on (FRAME), the anchors (seat, door, basket, lamp, hub); the drop zones (zones.js) and the race
// courses' landing spots; the ambulance's fit, where it waits, and the way it drives to the medical centre
// (Ambulance.plan + setPath: the Rettungsweg, its corners rounded).
async function exportHeli({ THREE, imp, world, L, models, loadGLB, pack, pScene, pCols, cols, log, r4, freeMod }) {
  for (const n of ['heli_body', 'ambulance', 'patrol_hut']) if (!models[n]) models[n] = await loadGLB(n);
  const PAD = await imp('game/heli/pad.js'), MOD = await imp('game/heli/model.js'), ZON = await imp('game/heli/zones.js');
  let price = 1500;
  try { price = (await imp('game/heli.js')).HELI_PRICE; } catch (err) { log('heli.js not loaded (price 1500):', err.message); }
  const v3 = (v) => [r4(v.x), r4(v.y), r4(v.z)];
  const site = PAD.chooseSite(L.layout, cols);
  const pad = new PAD.Helipad({ scene: pScene, models, colliders: pCols, site, price });
  pad.update(30, { camera: null, washFrom: null, wash: 0 }); // (the windsock settled in the breeze)
  const o = { price, padR: PAD.PAD_R, home: { x: r4(pad.x), z: r4(pad.z), y: r4(pad.y), yaw: r4(pad.yaw) },
    hut: { x: r4(pad.hut.x), z: r4(pad.hut.z), door: { x: r4(pad.hut.door.x), z: r4(pad.hut.door.z) } },
    sock: v3(pad.sockPivot.position) };
  // the helicopter (its blur discs' textures are pixels: replayed exactly)
  const ce = document.createElement;
  document.createElement = (t) => { const c = ce(t); if (t === 'canvas') c.slExact = true; return c; };
  let hm;
  try { hm = new MOD.HeliModel(models); } finally { document.createElement = ce; }
  hm.root.updateMatrixWorld(true);
  o.meshy = hm.meshy; o.K = MOD.K; o.frame = MOD.FRAME;
  o.anchors = Object.fromEntries(Object.entries(MOD.ANCHORS).map(([k, v]) => [k, v.isVector3 ? v3(v) : v]));
  o.hub = v3(hm.main.spin.position); o.tailHub = v3(hm.tail.spin.position); // (airframe frame: reference units)
  o.airframe = { scale: hm.airframe.scale.x, pos: v3(hm.airframe.position) };
  o.discY = r4(hm.main.disc.position.y - hm.main.spin.position.y); o.tailDiscX = r4(hm.tail.disc.position.x - hm.tail.spin.position.x);
  o.bladeX = r4(hm.main.blades[0].position.x);
  const parts = {};
  const pivots = hm.main.blades.map((b) => b.parent);
  for (const p of pivots) hm.main.spin.remove(p);
  parts.hub = pack.localModel(hm.main.spin);
  parts.blade = pack.localModel(hm.main.blades[0]);
  parts.disc = pack.localModel(hm.main.disc);
  const tHub = hm.tail.spin.children[0], tBlades = hm.tail.spin.children[1];
  hm.tail.spin.remove(tBlades); parts.tailHub = pack.localModel(hm.tail.spin);
  hm.tail.spin.add(tBlades); hm.tail.spin.remove(tHub); hm.tail.spin.updateMatrixWorld(true); parts.tailBlades = pack.localModel(hm.tail.spin);
  parts.tailDisc = pack.localModel(hm.tail.disc);
  hm.airframe.remove(hm.main.spin, hm.main.disc, hm.tail.spin, hm.tail.disc);
  hm.root.remove(hm.beam, hm.lights);
  hm.root.updateMatrixWorld(true);
  parts.body = pack.localModel(hm.root);
  o.parts = parts;
  log('play: helicopter', hm.meshy ? 'Meshy airframe:' : 'procedural airframe:', Object.entries(parts).map(([k, p]) => `${k} ${p.reduce((a, q) => a + q.tris, 0)}`).join(', '), 'tris');
  // the drop zones and the race courses' landing spots (heli.js openDialog)
  o.zones = ZON.dropZones().map((z) => ({ name: z.name, x: r4(z.x), z: r4(z.z), y: r4(z.y), heading: r4(z.heading), vertical: z.vertical }));
  o.races = [];
  try { for (const e of freeMod.freeCourses()) if (e.heli) o.races.push({ name: e.name, x: r4(e.heli.x), z: r4(e.heli.z), label: e.D?.label || '' }); } catch (err) { log('heli: race courses', err.message); }
  // the ambulance: beside the pad (rescue.js start), its way to the medical centre
  try {
    const { Ambulance } = await imp('game/heli/ambulance.js');
    const amb = new Ambulance({ scene: new THREE.Scene(), models, world, colliders: [] });
    if (amb.ok) {
      const a = pad.yaw - Math.PI / 2, d = PAD.PAD_R + 9;
      amb.park(pad.x + Math.sin(a) * d, pad.z + Math.cos(a) * d, a);
      const fit = amb.group.children[0], size = fit.userData.size;
      const A = { park: { x: r4(amb.x), z: r4(amb.z), yaw: r4(a) }, fit: fit.userData.slFit.fit.map((v) => Math.round(v * 1e6) / 1e6), size: v3(size),
        lights: amb.group.children.filter((c) => c.isMesh).map((c) => ({ p: v3(c.position), red: c.material === amb.lights[1] })) };
      amb.plan();
      A.path = amb.path.pts.map((q) => [r4(q[0]), r4(q[1])]);
      A.goal = { x: r4(amb.goal.x), z: r4(amb.goal.z) };
      o.ambulance = A;
      log('play: ambulance path', A.path.length, 'points,', Math.round(amb.path.length), 'm');
      amb.hide();
    }
  } catch (err) { log('ambulance skipped:', err.stack?.split('\n').slice(0, 3).join(' | ')); }
  return o;
}

// The medical centre inside (game/hospitalroom.js HospitalRoom, built by the game's own module): the shell (floors,
// panelled walls, the partition, ceilings and beams), the windows' frames, curtains, sills and radiators, the glass
// doors, the lights' fittings, the lobby's and the ward's built pieces with their painted textures as one local mesh
// (the room's frame: x along the front, +z out of the front, y up from the floor); the Meshy furniture as placed
// (model + matrix), the window / door panes (the live view's planes), what the walker bumps into (obstacles), the
// chairs, the beds and their mattress tops as measured on the model, the door spot outside.
async function exportWard({ THREE, imp, busRoads, loadGLB, pack, log, r4, m34 }) {
  const HR = await imp('game/hospitalroom.js');
  const { HOSPITAL_LOT } = await imp('game/bus/roads.js');
  const { HOUSE } = await imp('game/hospital.js');
  const room = new HR.HospitalRoom({ renderer: null });
  // (the furniture is swapped in once its GLB has loaded: prisonoutside.js swapInModel)
  await Promise.all(['hospital_bed', 'bedside_cabinet', 'patient_monitor', 'iv_stand', 'privacy_screen', 'visitor_chair', 'reception_desk', 'waiting_bench', 'medical_cart', 'medicine_cabinet'].map((n) => loadGLB('hospital/' + n))
    .concat(['decor/lamp_pendant', 'decor/plant_ficus', 'decor/plant_monstera', 'furniture/picture_mountain'].map((n) => loadGLB(n))));
  for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 20));
  const S = room.scene;
  S.updateMatrixWorld(true);
  const props = [], panes = [];
  S.traverse((o) => {
    if (o.userData.slFit) {
      props.push({ model: o.userData.slFit.model, m: m34(o.matrixWorld.clone().multiply(new THREE.Matrix4().fromArray(o.userData.slFit.fit))) });
      o.traverse((q) => { if (q.isMesh) q.userData.slSkip = true; });
    } else if (o.isMesh && (o.visible === false || [].concat(o.material)[0]?.blending === THREE.AdditiveBlending)) o.userData.slSkip = true; // (the walker's unseen solids; the reading lights' additive glow on the wall)
  });
  for (const mesh of room.portal.meshes) {
    mesh.userData.slSkip = true;
    panes.push({ m: m34(mesh.matrixWorld), w: r4(mesh.geometry.parameters.width), h: r4(mesh.geometry.parameters.height) });
  }
  const out = { mesh: pack.localModel(S), props, panes,
    obstacles: room.obstacles.map((q) => q.map(r4)), bounds: room.bounds.map(r4),
    chairs: room.chairs.map((c) => ({ x: r4(c.x), z: r4(c.z), yaw: r4(c.yaw), bed: c.bed, y: c.y })),
    beds: HR.BEDS, bedTops: room.bedTops.map(r4), stay: HR.STAY_S };
  const H = busRoads.hospital;
  if (H) {
    const yaw0 = Math.atan2(H.dirx, H.dirz), FRONT = HOSPITAL_LOT.front, BZ = FRONT - HOUSE.D / 2;
    const w = (lx, lz) => ({ x: r4(H.x + H.dirz * lx + H.dirx * lz), z: r4(H.z - H.dirx * lx + H.dirz * lz) });
    out.door = { ...w(0, FRONT + 2.2), yaw: r4(yaw0) };
    out.house = { ...w(0, BZ), yaw: r4(yaw0), y: r4(H.y ?? 0) }; // (the room's frame outdoors: hospitalroom.js linkWorld)
  }
  log('play: ward', out.mesh.reduce((a, q) => a + q.tris, 0), 'tris,', props.length, 'models,', panes.length, 'panes, mattress tops', out.bedTops.join(' '));
  return out;
}
