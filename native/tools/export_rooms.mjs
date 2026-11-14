// Ski Legacy native port: the rooms you walk into. The web game builds each room as a scene of its own (the walk-in ski
// shop: game/interior.js ShopInterior; ...) and renders it with post.setView. Here the game's own module builds the
// room in Node, and its scene goes into the play pack as one local model (the meshes merged per material, the GLB
// props with their own materials, the canvas textures replayed) together with what the C++ needs to walk about in it:
// the room's size, the eye height, where you come in, the furniture's circles and the counter's box (the room's own
// collision), the things you can aim at (their boxes, kind, id, name), the clerk, the lights.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function exportRooms({ THREE, SRC, models, loadGLB, pack, log, r4 }) {
  const imp = (p) => import(pathToFileURL(path.join(SRC, p)));
  const rooms = {};
  const need = async (names) => { for (const n of names) if (!models[n]) { try { models[n] = await loadGLB(n); } catch (e) { log('rooms: model', n, 'missing:', e.message); } } };
  const box = (o) => { const b = new THREE.Box3().setFromObject(o); return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(r4); };
  // a stand-in for a skier rig (the clerk, the podium's skier: the C++ poses its own rigs there)
  const fakeRig = () => ({ root: new THREE.Group(), gear: new THREE.Group(), setSkisVisible() {}, setCarry() {}, addTo() {}, update() {}, snapPose() {} });
  const lightsOf = (scene) => {
    const out = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!o.isLight) return;
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      out.push({ type: o.isPointLight ? 'point' : o.isSpotLight ? 'spot' : o.isDirectionalLight ? 'dir' : o.isHemisphereLight ? 'hemi' : 'ambient',
        color: [r4(o.color.r), r4(o.color.g), r4(o.color.b)], ground: o.groundColor ? [r4(o.groundColor.r), r4(o.groundColor.g), r4(o.groundColor.b)] : null,
        intensity: r4(o.intensity), distance: r4(o.distance || 0), decay: r4(o.decay ?? 2), p: [r4(p.x), r4(p.y), r4(p.z)] });
    });
    return out;
  };
  // the meshes nobody sees (the aim boxes: colorWrite off) stay out of the model
  const hideHelpers = (scene) => scene.traverse((o) => {
    if (!o.isMesh) return;
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
      podium: [-6.75, 0.16, -0.45],
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
    // A part of the room as a model of its own (in the frame of `root`), left out of the room's model
    const extras = {};
    const own = (key, root) => { root.updateMatrixWorld(true); const parts = pack.localModel(root); root.traverse((o) => { o.userData.slSkip = true; }); if (parts.length) rooms[key] = { parts }; extras[key] = parts.length; return parts.length > 0; };
    const inRoom = (o) => { const h = new THREE.Group(); room.scene.add(h); h.attach(o); return h; };
    // (the polished floor: the web game lays its dark stone tiles, 80 % opaque, over a Reflector that mirrors the hall and
    // the cars. The C++ has no planar mirror pass: it draws the room and the cars a second time, mirrored under the floor,
    // and these tiles, still 80 % opaque, over them: the floor is a model of its own, game/showroom)
    let hasFloor = false;
    if (room.mirror) {
      room.mirror.userData.slSkip = true;
      let fl = null;
      room.scene.traverse((o) => { if (o.isMesh && o.material?.isMeshPhysicalMaterial && o.material.transparent && o.material.opacity === 0.8) fl = o; });
      if (fl) hasFloor = own('autohaus_floor', inRoom(fl));
    }
    // the sliding doors' two leaves (carrentalshell.js setDoors: each slides `slide` m along x from x0), each its own model
    const doors = [];
    (room.doors || []).forEach((leaf, k) => {
      const u = leaf.userData || {};
      leaf.position.x = u.x0 ?? leaf.position.x;
      const at = [r4(leaf.position.x), r4(leaf.position.y), r4(leaf.position.z)];
      if (own('autohaus_door' + k, leaf)) doors.push({ model: 'autohaus_door' + k, p: at, dir: u.dir ?? 0, slide: r4(u.slide ?? 0) });
    });
    // the salesman's tip (carrentalroom.js guide): the gold arrow that bobs over the car, the ring round it
    let marker = null;
    try {
      const first = room.tables?.[0]?.id;
      if (first) {
        room.guide(first);
        const M = room.marker;
        M.g.position.set(0, 0, 0); M.arrow.position.set(0, 0, 0); M.ring.scale.setScalar(1);
        const okA = own('autohaus_arrow', M.arrow), okR = own('autohaus_ring', M.g);
        if (okA && okR) marker = { arrow: 'autohaus_arrow', ring: 'autohaus_ring' };
        room.guide(null);
      }
    } catch (e) { log('rooms: Autohaus marker skipped:', e.message); }
    // (the brushed steel of the turntables' rims and the price stands: full metal in the web game, where the hall's
    // environment map lights it. The C++ lights a room without one, and a bare metal turns black there: the same pale
    // steel as a mostly diffuse surface)
    room.scene.traverse((o) => { const m = o.isMesh && o.material; if (m && m.isMeshStandardMaterial && m.metalness >= 0.95 && m.color.r > 0.6) { o.material = m.clone(); o.material.metalness = 0.35; } });
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
      cars.push({ id: t.id, label: spec.label || t.id, price: spec.price ?? 0, m: g.matrixWorld.toArray().map(r4), up: !!t.up, length: spec.length ?? 4.6,
        table: [r4(t.x), r4(t.up ? (t.y || 0) : 0.16), r4(t.z), r4(t.spin.rotation.y)], paintId: pid || 'white',
        paint: pid ? [r4(pc.r), r4(pc.g), r4(pc.b)] : null, plate: t.inst?.plate || null });
    }
    // the windows: carrentalroom.js shows the live world on one plane behind the whole glass front and on the upper side
    // windows (its portal material). The C++ photographs the world from the hall as you go in and lays the photographs
    // on these planes (game/showroom): their places, left out of the room's model
    const panes = [];
    for (const m of room.portalMeshes?.() || []) {
      const gp = m.geometry.parameters || {};
      panes.push({ m: m.matrixWorld.toArray().map(r4), w: r4(gp.width ?? 1), h: r4(gp.height ?? 1) });
      m.userData.slSkip = true;
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
      stair: [L.stair.x0, L.stair.x1, L.stair.z0, L.stair.z1], FL: L.FL, MZ: L.MZ, RISE: L.RISE,
      door: [r4(L.door.x), r4(L.door.w), r4(L.door.h)], doors, marker, floor: hasFloor ? 'autohaus_floor' : null, panes,
      hits, cars, clerk: room.clerk ? { x: r4(room.clerk.root.position.x), z: r4(room.clerk.root.position.z), yaw: room.deskYaw || 0, char: 'skier_black' } : null,
      lights: lightsOf(room.scene), background: bg?.isColor ? [r4(bg.r), r4(bg.g), r4(bg.b)] : [0.02, 0.017, 0.014],
    };
    log('rooms: Autohaus showroom', rooms.autohaus.parts.length, 'parts,', cars.length, 'cars,', hits.length, 'things to aim at,', rooms.autohaus.obstacles.length, '+', rooms.autohaus.obstaclesUp.length, 'obstacles,', rooms.autohaus.lights.length, 'lights; own models', JSON.stringify(extras));
  } catch (e) { log('rooms: Autohaus showroom skipped:', e.stack?.split('\n').slice(0, 5).join(' | ')); }

  // ---------------------------------------------------------------- the Autohaus's tow truck (game/towtruck.js
  // buildTowTruck: the 508 D turned nose to +z, re-centred and scaled, the star on its grille, the beacons on the cab):
  // one model in the truck's own frame; the C++ parks three in the yard's TOW bays (game/showroom)
  try {
    await need(['tow_truck']);
    const { buildTowTruck } = await imp('game/towtruck.js');
    const t = buildTowTruck(models);
    rooms.towtruck = { parts: pack.localModel(t.g) };
    log('rooms: tow truck', rooms.towtruck.parts.length, 'parts');
  } catch (e) { log('rooms: tow truck skipped:', e.stack?.split('\n').slice(0, 4).join(' | ')); }

  // ---------------------------------------------------------------- the police station: the cell block and the front
  // office (game/prison.js PrisonRoom + prisoncell.js). The C++ keeps its own walls as the collision and the jail's
  // logic in its frame (the JS frame shifted by 5.8, 0.8): here the room as the web game builds it, to draw.
  try {
    const { PrisonRoom } = await imp('game/prison.js');
    const room = new PrisonRoom({ renderer: null, makeRig: fakeRig, models });
    try { await Promise.race([Promise.resolve(room.ready), new Promise((r) => setTimeout(r, 4000))]); } catch { /* (its props' GLBs) */ }
    hideHelpers(room.scene);
    room.scene.updateMatrixWorld(true);
    const bg = room.scene.background;
    rooms.prison = { parts: pack.localModel(room.scene), shell: [-5.8, 0, -0.8], lights: lightsOf(room.scene), background: bg?.isColor ? [r4(bg.r), r4(bg.g), r4(bg.b)] : [0.01, 0.012, 0.014] };
    log('rooms: police station', rooms.prison.parts.length, 'parts,', rooms.prison.lights.length, 'lights');
  } catch (e) { log('rooms: police station skipped:', e.stack?.split('\n').slice(0, 5).join(' | ')); }

  return rooms;
}
