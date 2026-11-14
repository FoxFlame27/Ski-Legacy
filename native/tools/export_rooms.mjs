// Ski Legacy native port: the rooms you walk into. The web game builds each room as a scene of its own (the walk-in ski
// shop: game/interior.js ShopInterior; ...) and renders it with post.setView. Here the game's own module builds the
// room in Node, and its scene goes into the play pack as one local model (the meshes merged per material, the GLB
// props with their own materials, the canvas textures replayed) together with what the C++ needs to walk about in it:
// the room's size, the eye height, where you come in, the furniture's circles and the counter's box (the room's own
// collision), the things you can aim at (their boxes, kind, id, name), the clerk, the lights.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function exportRooms({ THREE, SRC, models, loadGLB, pack, log, r4, village, world }) {
  globalThis.slSysFonts = true; // (text fitted to a width is measured in the serif the C++ draws these canvases with)
  try { return await build({ THREE, SRC, models, loadGLB, pack, log, r4, village, world }); } finally { globalThis.slSysFonts = false; }
}
async function build({ THREE, SRC, models, loadGLB, pack, log, r4, village, world }) {
  const imp = (p) => import(pathToFileURL(path.join(SRC, p)));
  const rooms = {};
  const need = async (names) => { for (const n of names) if (!models[n]) { try { models[n] = await loadGLB(n); } catch (e) { log('rooms: model', n, 'missing:', e.message); } } };
  const m34 = (m) => { const e = m.elements; return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]].map((v) => Math.round(v * 1e5) / 1e5); };
  const box = (o) => { const b = new THREE.Box3().setFromObject(o); return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(r4); };
  // a stand-in for a skier rig (the clerk, the podium's skier: the C++ poses its own rigs there)
  const fakeRig = () => ({ root: new THREE.Group(), gear: new THREE.Group(), setSkisVisible() {}, setCarry() {}, addTo() {}, update() {}, snapPose() {} });
  const lightsOf = (scene) => {
    const out = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!o.isLight) return;
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      out.push({ ...(o.userData.slRole ? { role: o.userData.slRole } : {}), type: o.isPointLight ? 'point' : o.isSpotLight ? 'spot' : o.isDirectionalLight ? 'dir' : o.isHemisphereLight ? 'hemi' : 'ambient',
        color: [r4(o.color.r), r4(o.color.g), r4(o.color.b)], ground: o.groundColor ? [r4(o.groundColor.r), r4(o.groundColor.g), r4(o.groundColor.b)] : null,
        intensity: r4(o.intensity), distance: r4(o.distance || 0), decay: r4(o.decay ?? 2), p: [r4(p.x), r4(p.y), r4(p.z)] });
    });
    return out;
  };
  // the meshes nobody sees (the aim boxes: colorWrite off) stay out of the model
  const hideHelpers = (scene) => scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.visible === false) o.userData.slSkip = true; // (a camera blocker: a box round the house nobody sees)
    if ([].concat(o.material).every((m) => m && m.colorWrite === false)) o.userData.slSkip = true;
    // (the rooms' canvases paint with gradients: the paper tags, the signs, the old photographs: replayed with them)
    for (const m of [].concat(o.material)) for (const k of ['map', 'emissiveMap']) if (m?.[k]?.image && m[k].image._id !== undefined) m[k].image.slGrad = true;
  });

  // ---------------------------------------------------------------- the walk-in ski shop (game/interior.js)
  try {
    const E = await imp('game/economy.js');
    await need(['helmet_shelf', 'boot_rack', 'jacket_rail', 'shop_counter', 'potted_plant', 'glove_bin', 'shop_bench', 'farm_table', 'firewood_pile', 'ski_goggles',
      'wooden_barrel', 'wooden_sled', ...new Set(E.SKIS.flatMap((s) => [s.model, s.fallback].filter(Boolean)))]);
    const { ShopInterior } = await imp('game/interior.js');
    const shop = new ShopInterior({
      renderer: null, models, makeRig: fakeRig, makeCharRig: null, getCharacter: () => null, getOutfit: () => null,
      getSkiState: (id) => { const s = E.skiById(id); return { owned: false, equipped: false, price: s.price, rent: s.rent, canAfford: true }; },
      outside: null,
    });
    try { shop.refreshPlaques(); } catch { /* (the price plaques as a new save sees them) */ }
    // (interior.js update: every frame the skis' highlight is set, black unless you look at them: the Meshy skis'
    // own emissive never shows)
    for (const d of shop.displays || []) d.traverse((m) => { if (m.isMesh) m.material.emissive?.setHex(0x000000); });
    hideHelpers(shop.scene);
    // (interior.js updateLight: the daylight and the sky light follow the sun outside, the lanterns glow brighter after
    // dark, the stove flickers: the C++ does the same by these roles)
    if (shop.daylight) shop.daylight.userData.slRole = 'day';
    if (shop.hemi) shop.hemi.userData.slRole = 'hemi';
    for (const L of shop.lamps || []) L.userData.slRole = 'lamp';
    if (shop.fire) shop.fire.userData.slRole = 'fire';
    // the glass (the live view of the village, liveportal): its pane for the C++'s photograph of the plaza
    let pane = null;
    if (shop.portalMesh) {
      shop.portalMesh.userData.slSkip = true;
      shop.portalMesh.updateMatrixWorld(true);
      const e = shop.portalMesh.matrixWorld.elements, gp = shop.portalMesh.geometry.parameters;
      pane = { m: [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]].map(r4), w: r4(gp.width), h: r4(gp.height) };
    }
    // the wall clock keeps the game's time (updateLight): its hands are drawn by the C++, turned about this frame's z
    let clock = null;
    if (shop.clock?.hour?.parent) {
      const hands = shop.clock.hour.parent;
      shop.scene.updateMatrixWorld(true);
      shop.clock.hour.userData.slSkip = true; shop.clock.minute.userData.slSkip = true;
      const e = hands.matrixWorld.elements;
      clock = { m: [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]].map(r4) };
    }
    shop.scene.updateMatrixWorld(true);
    const hits = [];
    for (const d of shop.displays || []) hits.push({ kind: 'ski', id: d.userData.id, name: d.userData.name, box: box(d) });
    if (shop.doorHit) hits.push({ kind: 'door', box: box(shop.doorHit) });
    if (shop.clerkHit) hits.push({ kind: 'clerk', box: box(shop.clerkHit) });
    for (const h of shop.outfitHits || []) hits.push({ kind: 'outfits', box: box(h) });
    const bg = shop.scene.background;
    rooms.shop = {
      parts: pack.localModel(shop.scene),
      W: 16, D: 8, H: 3.6, eye: 1.62, spawn: [0, 8 / 2 - 1.4, Math.PI], speed: 2.2,
      // (ShopInterior.update: x within +-(W / 2 - 0.4), z within -D / 2 + 0.65 .. D / 2 - 0.4)
      bounds: [-16 / 2 + 0.4, 16 / 2 - 0.4, -8 / 2 + 0.65, 8 / 2 - 0.4],
      obstacles: (shop.obstacles || []).map((o) => [r4(o.x), r4(o.z), r4(o.r)]),
      counter: shop.counterBox ? [shop.counterBox.minX, shop.counterBox.maxX, shop.counterBox.minZ, shop.counterBox.maxZ].map(r4) : null,
      hits, clerk: shop.clerk ? { x: r4(shop.clerk.root.position.x), z: r4(shop.clerk.root.position.z), yaw: -Math.PI / 2, char: 'skier_black' } : null,
      podium: [-6.75, 0.16, -0.45], panes: pane ? [pane] : [], clock,
      // where the shop stands (village.js shopDoor: 1.6 m in front of the door, the way it faces; E within 3.2 m)
      door: village?.shopDoor ? { x: r4(village.shopDoor.x), z: r4(village.shopDoor.z), fx: r4(village.shopFront.x), fz: r4(village.shopFront.z), r: 3.2 } : null,
      lights: lightsOf(shop.scene), background: bg?.isColor ? [r4(bg.r), r4(bg.g), r4(bg.b)] : [0.01, 0.006, 0.003],
    };
    log('rooms: ski shop', rooms.shop.parts.length, 'parts,', hits.length, 'things to aim at,', rooms.shop.obstacles.length, 'obstacles,', rooms.shop.lights.length, 'lights');
  } catch (e) { log('rooms: ski shop skipped:', e.stack?.split('\n').slice(0, 4).join(' | ')); }

  // ---------------------------------------------------------------- the Autohaus showroom (game/carrentalroom.js)
  try {
    const CR = await imp('game/carrental.js'), CC = await imp('game/carconfig.js'), SH = await imp('game/carrentalshell.js');
    const { CarRentalRoom } = await imp('game/carrentalroom.js');
    const L = SH.LAYOUT, hex = (id) => CC.paintOf(id).hex;
    await need([...new Set([...CR.DISPLAY, ...CR.UPPER].map(([id]) => id))]);
    const room = new CarRentalRoom({ renderer: null, models, makeRig: fakeRig, cars: CR.RENTALS,
      display: CR.DISPLAY.map(([id, paint]) => ({ id, paint: hex(paint) })), upper: CR.UPPER.map(([id, paint]) => ({ id, paint: hex(paint) })) });
    try { SH.setDoors(room.doors, 0); } catch { /* (the sliding doors shut) */ }
    // (the polished floor: the web game lays its dark stone tiles, 80 % opaque, over a Reflector that mirrors the cars; the
    // C++ has no planar mirror: the tiles alone, opaque, with their clear coat)
    if (room.mirror) { room.mirror.userData.slSkip = true; room.scene.traverse((o) => { if (o.isMesh && o.material?.isMeshPhysicalMaterial && o.material.transparent && o.material.opacity === 0.8) { o.material.transparent = false; o.material.opacity = 1; } }); }
    room.scene.updateMatrixWorld(true);
    // the cars: the C++ draws its own models of them where they stand (their meshes stay out of the room's model)
    const cars = [];
    for (const t of room.tables || []) {
      const g = t.inst?.group;
      if (!g) continue;
      g.userData.slSkip = true;
      g.traverse((o) => { o.userData.slSkip = true; });
      const spec = t.spec || {};
      const pid = [...CR.DISPLAY, ...CR.UPPER].find(([id]) => id === t.id)?.[1], pc = new THREE.Color(pid ? hex(pid) : 0xffffff);
      cars.push({ id: t.id, label: spec.label || t.id, price: spec.price ?? 0, m: g.matrixWorld.toArray().map(r4), up: g.matrixWorld.elements[13] > 1,
        paint: pid ? [r4(pc.r), r4(pc.g), r4(pc.b)] : null, plate: t.inst?.plate || null });
    }
    hideHelpers(room.scene);
    const hits = [];
    for (const h of room.aimables || []) { const u = h.userData || {}; if (u.kind) hits.push({ kind: u.kind, id: u.id || null, name: u.label || null, up: !!u.up, box: box(h) }); }
    const bg = room.scene.background;
    rooms.autohaus = {
      parts: pack.localModel(room.scene),
      W: L.W, D: L.D, H: L.H, eye: 1.62, spawn: [L.door.x, L.D / 2 - 1.3, Math.PI - 0.15], speed: 2.4,
      bounds: [-L.W / 2 + 0.45, L.W / 2 - 0.45, -L.D / 2 + 0.45, L.D / 2 - 0.45],
      obstacles: (room.obstacles || []).map((o) => [r4(o.x), r4(o.z), r4(o.r)]),
      obstaclesUp: (room.obstaclesUp || []).map((o) => [r4(o.x), r4(o.z), r4(o.r)]),
      stair: [L.stair.x0, L.stair.x1, L.stair.z0, L.stair.z1], FL: L.FL, MZ: L.MZ,
      hits, cars, clerk: room.clerk ? { x: r4(room.clerk.root.position.x), z: r4(room.clerk.root.position.z), yaw: room.deskYaw || 0, char: 'skier_black' } : null,
      lights: lightsOf(room.scene), background: bg?.isColor ? [r4(bg.r), r4(bg.g), r4(bg.b)] : [0.02, 0.017, 0.014],
    };
    log('rooms: Autohaus showroom', rooms.autohaus.parts.length, 'parts,', cars.length, 'cars,', hits.length, 'things to aim at,', rooms.autohaus.obstacles.length, '+', rooms.autohaus.obstaclesUp.length, 'obstacles,', rooms.autohaus.lights.length, 'lights');
  } catch (e) { log('rooms: Autohaus showroom skipped:', e.stack?.split('\n').slice(0, 5).join(' | ')); }

  // ---------------------------------------------------------------- the police station: the cell block and the front
  // office (game/prison.js PrisonRoom + prisoncell.js). The C++ keeps its own walls as the collision and the jail's
  // logic in its frame (the JS frame shifted by 5.8, 0.8): here the room as the web game builds it, to draw.
  try {
    const { PrisonRoom } = await imp('game/prison.js');
    const room = new PrisonRoom({ renderer: null, makeRig: fakeRig, models });
    try { await Promise.race([Promise.resolve(room.ready), new Promise((r) => setTimeout(r, 4000))]); } catch { /* (its props' GLBs) */ }
    hideHelpers(room.scene);
    // the glass (LivePortal: the cells' barred windows, the office's, the front door's pane): the C++'s photographs
    const panes = [];
    room.scene.updateMatrixWorld(true);
    for (const mesh of room.portal?.meshes || []) {
      mesh.userData.slSkip = true;
      const gp = mesh.geometry.parameters;
      panes.push({ m: m34(mesh.matrixWorld), w: r4(gp.width), h: r4(gp.height) });
    }
    // (the guard is the C++'s own figure; the wall clock's hands run on the real time: left as built)
    const bg = room.scene.background;
    const g = room.guard?.root?.position;
    rooms.prison = { parts: pack.localModel(room.scene), shell: [0, 0, 0], lights: lightsOf(room.scene), background: bg?.isColor ? [r4(bg.r), r4(bg.g), r4(bg.b)] : [0.01, 0.012, 0.014],
      // prison.js: the walker's boxes [x0, x1, z0, z1] (radius 0.26), the cells' doors, the way out, the guard
      eye: 1.62, radius: 0.26, boxes: (room.obstacles || []).map((q) => q.map(r4)), cellDoors: (room.doors || []).map((d) => [r4(d.x), r4(d.z)]),
      ROOM: { x0: -5.4, x1: 9.0, z0: -4.0, bars: -0.4, z1: 3.6, H: 3.3 }, CELLS: [-3.6, 0, 3.6], CELL_W: 3.6, FRONT: { x0: 9.0, x1: 17.0, z0: -4.0, z1: 5.6, H: 3.6 }, EXIT: { x: 16.95, z: 2.6 },
      guard: g ? { x: r4(g.x), z: r4(g.z) } : null, panes };
    // the station outdoors (prisonoutside.js: the alpine POLIZEI house on its lot, its forecourt, lamp and sign), as the
    // web game builds it, and the room's two wings carried onto the house (Prison.buildOutside: the windows' frames)
    try {
      const { busRoads } = await imp('game/bus/roads.js');
      const PO = await imp('game/prisonoutside.js');
      if (busRoads.prison && PO.buildPrisonOutside) {
        const scene = new THREE.Scene();
        await need(['pine_tree']); // (the potted spruces by the door)
        const o3 = PO.buildPrisonOutside({ scene, colliders: [], cameraBlockers: [], models }, busRoads.prison);
        for (let k = 0; k < 60; k++) await new Promise((r) => setTimeout(r, 25)); // (its Meshy props swapped in)
        const G = o3.group;
        if (G && !G.parent) scene.add(G);
        try { o3.showPatrol?.(false); } catch { /* (the patrol car out front is the C++'s own) */ }
        scene.updateMatrixWorld(true);
        hideHelpers(scene);
        // (everything it put in the world, the roadside sign too, about the lot's own place)
        const all = new THREE.Group();
        all.position.copy(G.position);
        scene.add(all); all.updateMatrixWorld(true);
        for (const c of [...scene.children]) if (c !== all) all.attach(c);
        scene.updateMatrixWorld(true);
        const house = o3.house;
        const cells = new THREE.Object3D(), office = new THREE.Object3D();
        cells.position.set(3.9, 0, 1.0); cells.rotation.y = Math.PI;
        office.position.set(-0.6, 0, -12.0); office.rotation.y = -Math.PI / 2;
        house.add(cells, office);
        house.updateMatrixWorld(true);
        // (drawn at the group's place in the world: the model in the group's own frame)
        rooms.prison_outside = { parts: pack.localModel(all), at: [r4(all.position.x), r4(all.position.y), r4(all.position.z)] };
        // (the patrol car parked in the first bay: the C++ parks its own there; found by its collider)
        const pcar = (o3.colliders || []).find((c) => c.r === undefined && c.hw > 0.9 && c.hw < 1.2 && c.hd > 2.2 && c.hd < 2.7);
        rooms.prison.outside = { door: { x: r4(o3.door.x), z: r4(o3.door.z), yaw: r4(o3.door.yaw) }, cells: m34(cells.matrixWorld), office: m34(office.matrixWorld),
          patrol: pcar ? { x: r4(pcar.x), z: r4(pcar.z), yaw: r4(-pcar.rot) } : null,
          colliders: (o3.colliders || []).map((c) => (c.r !== undefined ? { x: r4(c.x), z: r4(c.z), r: r4(c.r) } : { x: r4(c.x), z: r4(c.z), hw: r4(c.hw), hd: r4(c.hd), rot: r4(c.rot || 0) })) };
        log('rooms: police station outdoors', rooms.prison_outside.parts.length, 'parts, door', JSON.stringify(rooms.prison.outside.door), (o3.colliders || []).length, 'colliders');
      }
    } catch (e) { log('rooms: police station outdoors skipped:', e.stack?.split('\n').slice(0, 5).join(' | ')); }
    log('rooms: police station', rooms.prison.parts.length, 'parts,', rooms.prison.lights.length, 'lights,', rooms.prison.boxes.length, 'boxes,', rooms.prison.panes.length, 'panes');
  } catch (e) { log('rooms: police station skipped:', e.stack?.split('\n').slice(0, 5).join(' | ')); }

  // ---------------------------------------------------------------- the Werkstatt (game/werkstatt.js: the repair garage
  // beside the Autohaus: larch on a stone plinth, the open bay with its yellow repair box, the workshop half with the
  // lift, the workbench and the tool wall, the board on the gable, the apron): the building as the web game builds it,
  // its site's frame, the repair box and the workbench, what you bump into
  try {
    const { busRoads } = await imp('game/bus/roads.js');
    const WK = await imp('game/werkstatt.js');
    if (busRoads.rental) {
      await need(['sign_pole']);
      const scene = new THREE.Scene(), cols = [];
      const W = new WK.Werkstatt({ L: busRoads.rental, scene, colliders: cols, models, impound: null, drive: null });
      for (let k = 0; k < 80; k++) await new Promise((r) => setTimeout(r, 25)); // (its Meshy props swapped in)
      if (W.site) {
        const S = W.site;
        scene.updateMatrixWorld(true);
        hideHelpers(scene);
        const all = new THREE.Group();
        all.position.set(S.x, S.y, S.z);
        scene.add(all); all.updateMatrixWorld(true);
        for (const c of [...scene.children]) if (c !== all) all.attach(c);
        scene.updateMatrixWorld(true);
        rooms.werkstatt = { parts: pack.localModel(all), at: [r4(S.x), r4(S.y), r4(S.z)],
          site: { x: r4(S.x), y: r4(S.y), z: r4(S.z), ax: r4(S.ax), az: r4(S.az), fx: r4(S.fx), fz: r4(S.fz), yaw: r4(S.yaw) },
          // werkstatt.js: the repair box (the car's middle inside it), the workbench (on foot: E within 2.2 m of the spot 0.6 m in front), the inside
          BAY: { x: -3.5, z: -0.6, hw: 1.6, hl: 2.9 }, BENCH: { x: 3.4, z: -(WK.SHOP.D / 2 - WK.SHOP.T) + 0.4 }, IW: WK.SHOP.W / 2 - WK.SHOP.T, ID: WK.SHOP.D / 2 - WK.SHOP.T, REPAIR_S: 4,
          colliders: cols.filter((c) => Number.isFinite(c.x)).map((c) => (c.r !== undefined ? { x: r4(c.x), z: r4(c.z), r: r4(c.r) } : { x: r4(c.x), z: r4(c.z), hw: r4(c.hw), hd: r4(c.hd), rot: r4(c.rot || 0) })) };
        log('rooms: Werkstatt', rooms.werkstatt.parts.length, 'parts at', JSON.stringify(rooms.werkstatt.at), rooms.werkstatt.colliders.length, 'colliders');
      } else log('rooms: Werkstatt: no site');
    }
  } catch (e) { log('rooms: Werkstatt skipped:', e.stack?.split('\n').slice(0, 6).join(' | ')); }

  // ---------------------------------------------------------------- the mountain huts' doors (village.js: the spot 1.6 m
  // in front of each hut's door, E within 3.5 m: the hot chocolate counter)
  if (village?.interactables) rooms.village = { huts: village.interactables.filter((i) => i.id === 'hut').map((i) => [r4(i.x), r4(i.z), r4(i.r)]),
    // (the ticket booth's counter: E within 2.6 m: 'Talk to the ticket seller')
    tickets: village.interactables.filter((i) => i.id === 'tickets').map((i) => [r4(i.x), r4(i.z), r4(i.r)])[0] || null };

  // ---------------------------------------------------------------- the chalet village outdoors (game/chalets.js
  // build(): the gardens' picket fences, sheds, benches, snowmen and spruces, the parking bays with their PRIVAT
  // lettering and signs, the driveways, the house numbers by the doors, the mailboxes; the lit windows at night). The
  // houses themselves and the street lamps are the C++'s own (chalets.cpp, scenefx)
  try {
    const { busRoads } = await imp('game/bus/roads.js');
    const CH = await imp('game/chalets.js');
    if (busRoads.chalets) {
      const scene = new THREE.Scene(), cols = [];
      const o = Object.create(CH.Chalets.prototype);
      Object.assign(o, { V: busRoads.chalets, houses: [], save: {}, scene, colliders: cols, cameraBlockers: [], inside: false });
      o.stats = () => {};
      o.plan();
      const before = cols.length;
      await Promise.race([o.build(), new Promise((r) => setTimeout(r, 15000))]);
      for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 25));
      const G = o.group;
      scene.updateMatrixWorld(true);
      hideHelpers(scene);
      for (const im of o.inst || []) im.userData.slSkip = true; // (the houses)
      // the windows' glow follows the night (chalets.js update: lit from dusk): the panes as the C++'s own quads
      const first = o.houses[0];
      const at = new THREE.Vector3(first.frame.position.x, first.frame.position.y, first.frame.position.z);
      const windows = [];
      if (o.windows) {
        const im = o.windows, M = new THREE.Matrix4(), col = new THREE.Color();
        im.userData.slSkip = true;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, M); im.getColorAt(i, col);
          const e = M.elements;
          windows.push({ m: [e[0], e[4], e[8], e[12] - at.x, e[1], e[5], e[9], e[13] - at.y, e[2], e[6], e[10], e[14] - at.z].map((v) => Math.round(v * 1e4) / 1e4), c: [r4(col.r), r4(col.g), r4(col.b)] });
        }
      }
      // the Meshy props stand many times over (spruces, sheds, benches, snowmen, lamp posts): each model once, with the
      // places it stands at (the C++ draws it there), not its triangles for every one of them
      const inst = [];
      G.traverse((im) => {
        if (!im.isInstancedMesh || im.userData.slSkip || im.count < 2) return;
        const tris = (im.geometry.index ? im.geometry.index.count : im.geometry.attributes.position.count) / 3;
        if (tris < 150) return;
        const key = `chalet_village_i${inst.length}`, proto = new THREE.Group();
        proto.add(new THREE.Mesh(im.geometry, im.material));
        proto.updateMatrixWorld(true);
        rooms[key] = { parts: pack.localModel(proto) };
        const M = new THREE.Matrix4(), list = [];
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, M); M.premultiply(im.matrixWorld);
          const e = M.elements;
          list.push([e[0], e[4], e[8], e[12] - at.x, e[1], e[5], e[9], e[13] - at.y, e[2], e[6], e[10], e[14] - at.z].map((v) => Math.round(v * 1e4) / 1e4));
        }
        inst.push({ key, m: list });
        im.userData.slSkip = true;
      });
      // the bays and driveways lie under packed snow with wheel tracks (chalets.js drivewaySnow: a shader on their
      // material: most of the paint covered, the tracks worn to slush): laid over their painted canvas / colour here
      const snowed = new Set();
      G.traverse((q) => {
        for (const m of [].concat(q.material || [])) {
          const key = typeof m?.customProgramCacheKey === 'function' ? String(m.customProgramCacheKey()) : '';
          if (!key.startsWith('chalet-drive-snow') || snowed.has(m)) continue;
          snowed.add(m);
          const cv = m.map?.image;
          if (cv && cv._id !== undefined && cv.getContext) {
            const g2 = cv.getContext('2d'), w = cv.width, h = cv.height;
            g2.fillStyle = 'rgba(231,236,242,0.7)'; g2.fillRect(0, 0, w, h);
            if (key.endsWith('bay')) for (const a0 of [-2.05, -0.45, 0.45, 2.05]) { // (a tyre's track in each half of the two bays)
              const u = 0.5 + a0 / 5.4;
              g2.fillStyle = 'rgba(96,94,92,0.3)'; g2.fillRect((u - 0.03) * w, 0, 0.06 * w, h);
              g2.fillStyle = 'rgba(96,94,92,0.22)'; g2.fillRect((u - 0.016) * w, 0, 0.032 * w, h);
            }
          } else if (m.color) m.color.lerp(new THREE.Color().setRGB(0.80, 0.84, 0.89), 0.7);
        }
      });
      const all = new THREE.Group();
      all.position.copy(at); scene.add(all); all.updateMatrixWorld(true);
      for (const c of [...scene.children]) if (c !== all) all.attach(c);
      scene.updateMatrixWorld(true);
      rooms.chalet_village = { parts: pack.localModel(all), at: [r4(at.x), r4(at.y), r4(at.z)], windows, inst,
        // (the street lamps' lanterns: their light pools at night, chalets.js LAMP_LIGHT_Y)
        lamps: (o.lamps || []).map((l) => [r4(l.x), r4(l.y + 3.1), r4(l.z)]),
        colliders: cols.slice(before).filter((c) => Number.isFinite(c.x)).map((c) => (c.r !== undefined ? { x: r4(c.x), z: r4(c.z), r: r4(c.r) } : { x: r4(c.x), z: r4(c.z), hw: r4(c.hw), hd: r4(c.hd), rot: r4(c.rot || 0), ...(c.top !== undefined ? { top: r4(c.top) } : {}) })) };
      log('rooms: chalet village outdoors', rooms.chalet_village.parts.length, 'parts,', windows.length, 'lit windows,', rooms.chalet_village.lamps.length, 'lamps,', rooms.chalet_village.colliders.length, 'colliders,', inst.length, 'instanced models', inst.map((q) => q.m.length).join(' '));
    }
  } catch (e) { log('rooms: chalet village outdoors skipped:', e.stack?.split('\n').slice(0, 6).join(' | ')); }

  // ---------------------------------------------------------------- inside a chalet (game/chaletroom.js ChaletRoom:
  // both floors, the stair, the bathrooms' ware, the built-in lamps), with what the C++ walks on: the wall segments of
  // each floor, the fixtures, the hinged doors (each its own model about its hinge), the stair, the glass
  try {
    const P = await imp('game/chaletplan.js');
    const { ChaletRoom } = await imp('game/chaletroom.js');
    const room = new ChaletRoom({ renderer: null });
    try { await Promise.race([Promise.allSettled(room.loads || []), new Promise((r) => setTimeout(r, 6000))]); } catch { /* (its Meshy fittings) */ }
    for (let k = 0; k < 8; k++) await new Promise((r) => setTimeout(r, 20));
    hideHelpers(room.scene);
    room.scene.updateMatrixWorld(true);
    const panes = [];
    for (const mesh of room.portalMeshes || []) {
      mesh.userData.slSkip = true;
      const gp = mesh.geometry.parameters;
      panes.push({ m: m34(mesh.matrixWorld), w: r4(gp.width), h: r4(gp.height) });
    }
    // the doors: shut, each leaf with its handles in its hinge's frame (the C++ swings it)
    const doors = [];
    const doorSegs = new Set();
    (room.doors || []).forEach((d, i) => {
      d.target = 0; d.angle = 0; d.update(0);
      doorSegs.add(d.seg);
      const key = `chalet_door${i}`;
      d.pivot.rotation.y = 0; d.pivot.updateMatrixWorld(true);
      rooms[key] = { parts: pack.localModel(d.pivot) };
      d.pivot.traverse((o) => { o.userData.slSkip = true; });
      // (Door.update: rotation.y = base - angle * k)
      const nz = [-d.u[1], d.u[0]], k = (nz[0] * d.n[0] + nz[1] * d.n[1]) > 0 ? 1 : -1;
      doors.push({ key, hinge: d.hinge.map(r4), u: d.u.map(r4), n: d.n.map(r4), w: r4(d.w), h: r4(d.h), y0: r4(d.y0), level: d.level, front: !!d.front, inward: r4(d.inward ?? 0), base: r4(d.base), k });
    });
    const segs = (list) => (list || []).filter((q) => !doorSegs.has(q)).map((q) => q.map(r4));
    const bg = room.scene.background;
    rooms.chalet = {
      parts: pack.localModel(room.scene), eye: 1.62, radius: 0.28, speed: 2.3,
      solid: { ground: segs(room.solid.ground), up: segs(room.solid.up), stair: segs(room.solidStair) },
      round: { ground: room.round.ground.map((o) => [r4(o.x), r4(o.z), r4(o.r)]), up: room.round.up.map((o) => [r4(o.x), r4(o.z), r4(o.r)]) },
      boxes: { ground: room.boxes.ground.map((o) => [r4(o.x), r4(o.z), r4(o.hw), r4(o.hd), r4(o.rot || 0)]), up: room.boxes.up.map((o) => [r4(o.x), r4(o.z), r4(o.hw), r4(o.hd), r4(o.rot || 0)]) },
      doors, doorAt: room.doorAt, lamps: (room.lamps || []).map((l) => ({ x: r4(l.x), y: r4(l.y), z: r4(l.z), up: l.level === 'up', power: r4(l.power) })),
      panes, lights: lightsOf(room.scene), background: bg?.isColor ? [r4(bg.r), r4(bg.g), r4(bg.b)] : [0.6, 0.7, 0.8],
      plan: { IX: P.IX, IZ: P.IZ, HX: P.HX, HZ: P.HZ, G: P.G, GC: P.GC, FL: P.FL, STAIR: P.STAIR, HOLE: P.HOLE, DORMER: P.DORMER, STEPS: P.STEPS, DOOR: P.DOOR, RISE: r4(P.RISE), RUN: r4(P.RUN) },
      rooms: P.ROOMS.map((q) => ({ name: q.name, up: q.level === 'up', rects: q.rects.map((t) => [t.x0, t.z0, t.x1, t.z1]) })),
    };
    log('rooms: chalet', rooms.chalet.parts.length, 'parts,', doors.length, 'doors,', rooms.chalet.solid.ground.length, '+', rooms.chalet.solid.up.length, 'wall segments,', panes.length, 'panes,', rooms.chalet.lamps.length, 'lamps');
  } catch (e) { log('rooms: chalet skipped:', e.stack?.split('\n').slice(0, 5).join(' | ')); }

  return rooms;
}
