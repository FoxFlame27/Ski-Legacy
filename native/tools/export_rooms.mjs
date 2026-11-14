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

  return rooms;
}
