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
  const pack = makePack('play');
  const f32 = (a) => ({ off: pack.blob(Float32Array.from(a)), n: a.length });
  for (const n of ['job_board', 'start_house', 'race_arch', 'grandstand', 'timing_board', 'patrol_hut', 'snow_cannon', 'lamp_post', 'snowmobile', 'piste/bnet_panel', 'piste/flag_pole', 'floodlight_mast', 'floodlight_head_b', 'floodlight_head_c'])
    if (!models[n]) models[n] = await loadGLB(n);
  const pt = (p) => (p ? { x: r4(p.x), y: r4(p.y ?? world.height(p.x, p.z)), z: r4(p.z), heading: r4(p.heading ?? 0), s: r4(p.s ?? 0) } : null);
  const courseOut = (e, bus) => {
    const c = e.course, T = c.track, n = T.n;
    const X = [], Y = [], Z = [], W = [], H = [], K = [];
    for (let i = 0; i < n; i++) {
      X.push(T.X[i]); Z.push(T.Z[i]); W.push(T.W ? T.W[i] : 8); H.push(T.H[i]);
      Y.push(T.Y ? T.Y[i] : world.height(T.X[i], T.Z[i]));
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
      line: { n, ds: 2, X: f32(X), Y: f32(Y), Z: f32(Z), W: f32(W), H: f32(H), K: f32(K) },
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

  // ---------------------------------------------------------------- capture
  pack.capture(pScene);
  pack.finish({ colliders: pack.colliderOut(pCols.filter((c) => c && Number.isFinite(c.x))), surfaces: [], play: out });
}
