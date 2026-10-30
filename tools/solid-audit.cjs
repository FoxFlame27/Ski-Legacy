// Headless collider audit (Linux / cloud, Playwright + software WebGL): loads the built game (vite preview of dist/),
// waits for world/solidify.js to finish, then walks every visible static mesh in the scene (LOD levels: the full-detail
// copy, every instance of an instanced mesh) and lists the drawn parts between 0.4 m and 1.9 m over the snow (what you
// would walk, ski or drive into, over the terrain or a walkable deck) that no collider covers: the shared `colliders`
// (player + drive) and the trees (vegetation.collide, their crowns). Moving things (people, vehicles, trains) and
// streamed pools (the piste fences' colliders follow you) are left out: they carry their own.
// Usage: npx vite build && npx vite preview --port 4319 &  then  node tools/solid-audit.cjs [maxRows]
//   env: PORT (4319), RADIUS (m round the village's middle, default 2600: the resort), MIN (uncovered cells to list, 2)
const { chromium } = require('playwright');
(async () => {
  const PORT = process.env.PORT || 4319, MAXROWS = +process.argv[2] || 80;
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=8192', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  let solidDone = false;
  page.on('console', (m) => { const t = m.text(); if (/^Solid props/.test(t)) { solidDone = true; console.log(t.slice(0, 600)); } else if (m.type() === 'error') console.log('[error]', t.slice(0, 300)); });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/?nointro`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 900000, polling: 1000 });
  for (let i = 0; i < 600 && !solidDone; i++) await page.waitForTimeout(500);
  await page.waitForTimeout(4000); // (late Meshy swaps, chalets' async build)
  console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  const res = await page.evaluate(({ RADIUS, MIN }) => {
    const G = window.__game, scene = G.scene, world = G.world, colliders = G.colliders, veg = G.vegetation;
    const M4 = G.camera.matrix.constructor, V3 = G.camera.position.constructor;
    const _m = new M4(), _mi = new M4(), _v = new V3();
    const CELL = 0.5, LO = 0.4, HI = 1.9, TOL = 0.15;
    // moving things (their own colliders, near you only), streamed pools, shader-bent meshes, walkable features
    const SKIP = /^(far-skiers|townsfolk|crowds|crowd-|express-train|rail-train|ski-bus|helicopter|snowmobile|traffic|mp-|chalet-hi|legacy-park)|piste-fences|guardrail|people/;
    // a 16 m grid over the colliders
    const grid = new Map(), key = (i, j) => i * 100003 + j;
    for (const c of colliders) {
      if (!Number.isFinite(c.x) || c.carOnly) continue;
      const r = c.r ?? Math.hypot(c.hw, c.hd);
      if (!(r < 400)) continue;
      for (let i = Math.floor((c.x - r) / 16); i <= Math.floor((c.x + r) / 16); i++) for (let j = Math.floor((c.z - r) / 16); j <= Math.floor((c.z + r) / 16); j++) {
        let a = grid.get(key(i, j)); if (!a) grid.set(key(i, j), (a = [])); a.push(c);
      }
    }
    const inCol = (c, x, z) => {
      if (c.r !== undefined) return Math.hypot(x - c.x, z - c.z) <= c.r + TOL;
      const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), dx = x - c.x, dz = z - c.z;
      return Math.abs(dx * cs - dz * sn) <= c.hw + TOL && Math.abs(dx * sn + dz * cs) <= c.hd + TOL;
    };
    const covered = (x, z) => {
      for (const c of grid.get(key(Math.floor(x / 16), Math.floor(z / 16))) || []) if (inCol(c, x, z)) return true;
      if (veg?.collide?.(x, z, TOL, 0, 'crown')) return true;
      return false;
    };
    // what is not a static obstacle
    const skipRoots = new Set([G.terrain?.group, G.backdrop?.group, G.player?.rig?.root, G.player?.rig?.gear, G.pisteLights?.group].filter(Boolean));
    const movers = new Set(); // (vehicles: their own colliders follow them)
    for (const c of G.traffic?.cars || []) movers.add(c.g);
    for (const e of G.parking?.cars || []) movers.add(e.car);
    const pathOf = (o) => { const n = []; for (let p = o; p && p !== scene && n.length < 5; p = p.parent) if (p.name) n.push(p.name); return n.reverse().join('/') || o.type; };
    const rows = new Map();
    const scanned = {};
    const visit = (o, inherited, lodLevel = false) => {
      if ((!o.visible && !lodLevel) || skipRoots.has(o) || o.userData?.noCollide || SKIP.test(o.name || '')) return;
      if (o.isSkinnedMesh || o.isPoints || o.isLine || o.isSprite || o.isLight) return;
      if (o.isLOD && o.levels?.length) { visit(o.levels[0].object, inherited || o, true); return; } // (the full-detail copy, whatever the camera)
      if (o.isMesh && o.geometry?.attributes?.position) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const hidden = mats.every((m) => !m || m.visible === false || m.colorWrite === false || (m.transparent && m.opacity < 0.05) || m.depthWrite === false && m.transparent);
        if (!hidden) scan(o, inherited);
      }
      for (const c of o.children) visit(c, inherited);
    };
    const scan = (mesh, inherited) => {
      const pos = mesh.geometry.attributes.position, n = mesh.isInstancedMesh ? mesh.count : 1;
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      if (pos.count * n > 3e6) return;
      const stride = Math.max(1, Math.floor(pos.count / 20000));
      for (let k = 0; k < n; k++) {
        if (mesh.isInstancedMesh) { mesh.getMatrixAt(k, _mi); _m.multiplyMatrices(mesh.matrixWorld, _mi); } else _m.copy(mesh.matrixWorld);
        _v.copy(mesh.geometry.boundingSphere.center).applyMatrix4(_m);
        if (Math.hypot(_v.x, _v.z) > RADIUS) continue;
        const top = pathOf(inherited || mesh).split('/')[0];
        scanned[top] = (scanned[top] || 0) + 1;
        const cells = new Map();
        for (let i = 0; i < pos.count; i += stride) {
          _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(_m);
          const ci = Math.floor(_v.x / CELL), cj = Math.floor(_v.z / CELL), kk = key(ci, cj);
          if (cells.has(kk) && cells.get(kk)) continue;
          const g = world.groundHeight(_v.x, _v.z, _v.y), h = _v.y - g; // (decks, platforms, bridges: floors)
          if (h >= LO && h <= HI) cells.set(kk, [(ci + 0.5) * CELL, (cj + 0.5) * CELL, _v.x, _v.z]);
        }
        let bad = 0, cx = 0, cz = 0, total = 0;
        for (const c of cells.values()) { if (!c) continue; total++; if (!covered(c[0], c[1]) && !covered(c[2], c[3])) { bad++; cx += c[0]; cz += c[1]; } }
        if (bad < MIN) continue;
        const bb = mesh.geometry.boundingBox || (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox);
        const name = pathOf(inherited || mesh) + (mesh.isInstancedMesh ? '[inst]' : '') + ' :' + (mesh.name || mesh.geometry.name || '') + ' <' + (mesh.material?.name || mesh.material?.type || '') + ' ' + bb.max.clone().sub(bb.min).toArray().map((v) => v.toFixed(1)).join('x') + '>';
        let r = rows.get(name);
        if (!r) rows.set(name, (r = { name, n: 0, cells: 0, at: [] }));
        r.n++; r.cells += bad;
        if (r.at.length < 4) r.at.push([Math.round(cx / bad), Math.round(cz / bad), bad + '/' + total]);
      }
    };
    for (const o of scene.children) if (!movers.has(o)) visit(o, null);
    return { rows: [...rows.values()].sort((a, b) => b.cells - a.cells), colliders: colliders.length, scanned };
  }, { RADIUS: +(process.env.RADIUS || 2600), MIN: +(process.env.MIN || 2) });
  console.log('colliders:', res.colliders, ' props with uncovered drawn parts:', res.rows.length);
  console.log('scanned (meshes / instances per top-level group):', JSON.stringify(res.scanned));
  for (const r of res.rows.slice(0, MAXROWS)) console.log(String(r.cells).padStart(6), String(r.n).padStart(4), r.name.slice(0, 110), JSON.stringify(r.at));
  await browser.close();
})();
