// Headless invisible-barrier audit (Linux / cloud, Playwright + software WebGL): the inverse of solid-audit.cjs.
// Loads the game, waits for world/solidify.js to finish ('Solid props' console line), starts free ride, then checks that
// every collider has something visible drawn where it blocks:
//  - the shared `colliders` (player.js collide, drive.js: buildings, props, solidify's boxes, nets, cars...);
//  - the guardrail / wall line colliders (busRoads.rails: drive.js), against the drawn guardrail sections (shader
//    placed between their points; hidden while broken through, world/breakables.js) and whatever else is drawn;
//  - the trees and rocks round you (vegetation.collide) against vegetation.js's drawn instances / impostors.
// What counts as drawn: the meshes visible in the scene graph (a LOD's full-detail level; every instance of an
// instanced mesh; not invisible materials: camera blockers, hit boxes), their triangles sampled every ~0.35 m onto a
// 0.5 m grid over the colliders' footprints (+ TOL), between 12 cm over the terrain and the collider's top (no top:
// 3.2 m over the highest walkable surface there); flat faces lying on the ground (lots, decks, paving) do not count.
// Streamed things (net chunks, the Legacy Express's chunks and stations, far lifts, parked cars, traffic) are drawn only
// near the camera: every collider found bare at the start is checked again with you stood next to it (teleported,
// a few frames for the streaming), and listed only if it is still bare there.
// Listed: position, size, flags and (TAG=1, on a dev server: unminified stacks) the module:line that pushed it.
// Usage: npx vite build && npx vite preview --port 4361 &  then  PORT=4361 node tools/invisible-audit.cjs
//    or: npx vite --config tools/vite.nohmr.config.mjs --port 4362 &  then  PORT=4362 TAG=1 node tools/invisible-audit.cjs
//   env: PORT (4361), TOL (0.5 m), MOSTLY (0.1: box colliders with less of their footprint drawn are "oversized"),
//        MAXROWS (per group, 6), NOVISIT=1 (only the check from the village)
const { chromium } = require('playwright');

// (in the page) window.__invCheck(list): list = [{ c: collider-like { x, z, r | hw, hd, rot, top?, h? }, rail?: true }]
// -> per entry [cellsInFootprint, cellsDrawn]
function install(TOL) {
  const G = window.__game, scene = G.scene, world = G.world;
  const M4 = G.camera.matrix.constructor, V3 = G.camera.position.constructor;
  const CELL = 0.5, C16 = 16, key = (i, j) => i * 1000003 + j;
  const STD = /^(aRail|aOffset|iA$|iB$|iC$)/; // (shader-placed instances: guardrails (drawn from their sections below), tree impostors, sky cards)
  const _m = new M4(), _mi = new M4(), _v = new V3();
  window.__invCheck = (list) => {
    scene.updateMatrixWorld(true);
    const cells = new Map(), coarse = new Set(), recs = [];
    for (const { c } of list) {
      const r = c.r ?? Math.hypot(c.hw, c.hd), rec = [];
      const cs = Math.cos(-(c.rot || 0)), sn = Math.sin(-(c.rot || 0));
      for (let i = Math.floor((c.x - r - TOL) / CELL); i <= Math.floor((c.x + r + TOL) / CELL); i++) for (let j = Math.floor((c.z - r - TOL) / CELL); j <= Math.floor((c.z + r + TOL) / CELL); j++) {
        const x = (i + 0.5) * CELL, z = (j + 0.5) * CELL, dx = x - c.x, dz = z - c.z;
        if (c.r !== undefined ? Math.hypot(dx, dz) > c.r + TOL : Math.abs(dx * cs - dz * sn) > c.hw + TOL || Math.abs(dx * sn + dz * cs) > c.hd + TOL) continue;
        const k = key(i, j);
        let cell = cells.get(k);
        if (!cell) {
          const gLo = world.meshHeight ? world.meshHeight(x, z) : world.height(x, z);
          let gHi = gLo; try { gHi = Math.max(gLo, world.groundHeight(x, z)); } catch { /* */ }
          cells.set(k, (cell = { gLo, gHi, minY: Infinity }));
          coarse.add(key(Math.floor(x / C16), Math.floor(z / C16)));
        }
        rec.push(cell);
      }
      recs.push(rec);
    }
    const mark = (x, y, z, flat) => {
      const cell = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!cell || y < cell.gLo + 0.12 || (flat && y < cell.gHi + 0.3)) return; // (the ground, a lot, a deck, paving)
      if (y < cell.minY) cell.minY = y;
    };
    const scanTris = (P, idx, m) => {
      const n = P.count, w = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { _v.set(P.getX(i), P.getY(i), P.getZ(i)).applyMatrix4(m); w[i * 3] = _v.x; w[i * 3 + 1] = _v.y; w[i * 3 + 2] = _v.z; }
      const T = idx ? idx.count / 3 : n / 3;
      for (let t = 0; t < T; t++) {
        const a = (idx ? idx.getX(t * 3) : t * 3) * 3, b = (idx ? idx.getX(t * 3 + 1) : t * 3 + 1) * 3, c = (idx ? idx.getX(t * 3 + 2) : t * 3 + 2) * 3;
        const ax = w[a], ay = w[a + 1], az = w[a + 2], bx = w[b], by = w[b + 1], bz = w[b + 2], cx = w[c], cy = w[c + 1], cz = w[c + 2];
        let hit = false;
        for (let i = Math.floor(Math.min(ax, bx, cx) / C16); i <= Math.floor(Math.max(ax, bx, cx) / C16) && !hit; i++) for (let j = Math.floor(Math.min(az, bz, cz) / C16); j <= Math.floor(Math.max(az, bz, cz) / C16) && !hit; j++) if (coarse.has(key(i, j))) hit = true;
        if (!hit) continue;
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, A2 = Math.hypot(nx, ny, nz);
        const flat = A2 > 0.5 && Math.abs(ny) / A2 > 0.85;
        const e = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(cx - bx, cy - by, cz - bz));
        const N = Math.min(240, Math.max(1, Math.ceil(e / 0.35)));
        for (let i = 0; i <= N; i++) for (let j = 0; j <= N - i; j++) { const s = i / N, q = j / N; mark(ax + ux * s + vx * q, ay + uy * s + vy * q, az + uz * s + vz * q, flat); }
      }
    };
    const near = (bb, m) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < 8; k++) { _v.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(m); x0 = Math.min(x0, _v.x); x1 = Math.max(x1, _v.x); z0 = Math.min(z0, _v.z); z1 = Math.max(z1, _v.z); }
      for (let i = Math.floor(x0 / C16); i <= Math.floor(x1 / C16); i++) for (let j = Math.floor(z0 / C16); j <= Math.floor(z1 / C16); j++) if (coarse.has(key(i, j))) return true;
      return false;
    };
    const skipRoots = new Set([G.terrain?.group, G.backdrop?.group, G.player?.rig?.root, G.player?.rig?.gear].filter(Boolean));
    const visit = (o, lodLevel = false) => {
      if ((!o.visible && !lodLevel) || skipRoots.has(o)) return;
      if (o.isPoints || o.isLine || o.isSprite || o.isLight) return;
      if (o.isLOD && o.levels?.length) { visit(o.levels[0].object, true); return; }
      if (o.isMesh && !o.isSkinnedMesh && o.geometry?.attributes?.position && !o.userData?.guardrail && !Object.keys(o.geometry.attributes).some((k) => STD.test(k))) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (!mats.every((m) => !m || m.visible === false || m.colorWrite === false || (m.transparent && m.opacity < 0.05))) {
          const geo = o.geometry;
          if (!geo.boundingBox) geo.computeBoundingBox();
          const n = o.isInstancedMesh ? o.count : 1;
          for (let k = 0; k < n; k++) {
            if (o.isInstancedMesh) { o.getMatrixAt(k, _mi); if (Math.abs(_mi.determinant()) < 1e-9) continue; _m.multiplyMatrices(o.matrixWorld, _mi); } else _m.copy(o.matrixWorld);
            if (near(geo.boundingBox, _m)) scanTris(geo.attributes.position, geo.index, _m.clone());
          }
        }
      }
      for (const c of o.children) visit(c);
    };
    for (const o of scene.children) visit(o);
    // the guardrails, drawn from their sections (not while broken through: a zero instance matrix)
    const seen = new Set();
    for (const g of G.busRoads?.rails || []) {
      const s = g.seg, im = s?.ims?.[0];
      if (!im || seen.has(s)) continue;
      seen.add(s);
      let on = !!im.parent;
      for (let p = im; p && on; p = p.parent) if (!p.visible && !p.parent?.isLOD) on = false;
      const e = im.instanceMatrix.array;
      if (!on || !(e[s.k * 16] || e[s.k * 16 + 5] || e[s.k * 16 + 10])) continue;
      const a = s.a, b = s.b, N = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.25));
      for (let i = 0; i <= N; i++) { const t = i / N, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t, y = a[1] - a[3] + (b[1] - b[3] - a[1] + a[3]) * t; for (const dy of [0.3, 0.55, 0.75]) mark(x, y + dy, z, false); }
    }
    return list.map(({ c, rail }, n) => {
      let hit = 0;
      for (const cell of recs[n]) { const up = c.top !== undefined ? c.top + 0.2 : cell.gHi + (rail ? 1.2 : 3.2); if (cell.minY <= up) hit++; }
      return [recs[n].length, hit];
    });
  };
  return true;
}

(async () => {
  const PORT = process.env.PORT || 4361, MAXROWS = +(process.env.MAXROWS || 6), TAG = !!process.env.TAG, TOL = +(process.env.TOL || 0.5), MOSTLY = +(process.env.MOSTLY || 0.1);
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=8192', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  if (TAG) await page.addInitScript(() => {
    // each collider-shaped object pushed into any array: the stack of that push (the module and line that made it)
    const push = Array.prototype.push;
    const tag = (o) => {
      if (!o || typeof o !== 'object' || o.__src || typeof o.x !== 'number' || typeof o.z !== 'number' || (o.r === undefined && o.hw === undefined)) return;
      const st = (new Error().stack || '').split('\n').slice(2).filter((l) => /\/src\//.test(l)).slice(0, 3).map((l) => l.replace(/^.*\/src\//, '').replace(/\?[^:]*/, '').replace(/\)$/, '')).join(' < ');
      try { Object.defineProperty(o, '__src', { value: st, enumerable: false, configurable: true }); } catch { /* (frozen) */ }
    };
    Array.prototype.push = function (...a) { for (let i = 0; i < a.length; i++) tag(a[i]); return push.apply(this, a); };
  });
  let solidDone = false;
  page.on('console', (m) => { const t = m.text(); if (/^Solid props/.test(t)) { solidDone = true; console.log(t.slice(0, 200)); } else if (m.type() === 'error') console.log('[error]', t.slice(0, 300)); });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/?nointro`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 1200000, polling: 1000 });
  for (let i = 0; i < 900 && !solidDone; i++) await page.waitForTimeout(500);
  await page.evaluate(() => { try { window.__game.startGame(); } catch (e) { console.log('start', e.message); } });
  await page.waitForTimeout(8000); // (late Meshy swaps, chalets' async build, the car parks' cars)
  console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  await page.evaluate(install, TOL);
  // ---- 1. everything, from where you start
  const first = await page.evaluate(() => {
    const G = window.__game, cols = G.colliders;
    const list = [], meta = [];
    let parked = 0;
    for (let n = 0; n < cols.length; n++) {
      const c = cols[n];
      if (!Number.isFinite(c.x) || !Number.isFinite(c.z) || Math.abs(c.x) > 1e5 || Math.abs(c.z) > 1e5) { parked++; continue; }
      if (!((c.r ?? Math.hypot(c.hw, c.hd)) < 250)) continue;
      list.push({ c }); meta.push(['col', n]);
    }
    const rails = G.busRoads?.rails || [];
    for (let k = 0; k < rails.length; k++) {
      const g = rails[k], L = Math.hypot(g.bx - g.ax, g.bz - g.az);
      if (g.off || !(L > 0.05)) continue;
      list.push({ c: { x: (g.ax + g.bx) / 2, z: (g.az + g.bz) / 2, hw: 0.1, hd: L / 2, rot: -Math.atan2(g.bx - g.ax, g.bz - g.az) }, rail: true }); meta.push(['rail', k]);
    }
    const res = window.__invCheck(list);
    const bad = [];
    res.forEach(([n, hit], i) => {
      const c = list[i].c;
      if (!hit || (meta[i][0] === 'col' && c.r === undefined && n >= 40 && hit / n < 0.1)) bad.push({ kind: meta[i][0], n: meta[i][1], cells: n, hit });
    });
    window.__invList = { list, meta };
    return { colliders: cols.length, checked: list.length, parked, bad, at: [G.player.pos.x, G.player.pos.z] };
  });
  console.log(`colliders ${first.colliders}, checked ${first.checked} (+ rail lines), parked away ${first.parked}; bare or mostly empty from (${first.at.map(Math.round)}): ${first.bad.length}`);
  // ---- 2. each one found bare, again with you stood next to it (the streamed things drawn)
  let bad = first.bad;
  if (!process.env.NOVISIT && bad.length) {
    const spots = await page.evaluate((bad) => {
      const G = window.__game, cols = G.colliders, rails = G.busRoads?.rails || [], m = new Map();
      for (const b of bad) {
        const c = b.kind === 'col' ? cols[b.n] : { x: (rails[b.n].ax + rails[b.n].bx) / 2, z: (rails[b.n].az + rails[b.n].bz) / 2 };
        const k = Math.floor(c.x / 120) + ',' + Math.floor(c.z / 120);
        if (!m.has(k)) m.set(k, { x: c.x, z: c.z, items: [] });
        m.get(k).items.push(b);
      }
      return [...m.values()];
    }, bad);
    console.log('visiting', spots.length, 'spots');
    const still = [];
    for (let s = 0; s < spots.length; s++) {
      const sp = spots[s];
      await page.evaluate(({ x, z }) => { const G = window.__game; G.player.teleport(x + 6, z + 6, 0); }, sp);
      await page.evaluate(() => new Promise((res) => { let n = 0; const f = () => (++n >= 6 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
      await page.waitForTimeout(1200);
      const r = await page.evaluate((items) => {
        const G = window.__game, cols = G.colliders, rails = G.busRoads?.rails || [];
        const list = items.map((b) => b.kind === 'col' ? { c: cols[b.n] } : (() => { const g = rails[b.n]; return { c: { x: (g.ax + g.bx) / 2, z: (g.az + g.bz) / 2, hw: 0.1, hd: Math.hypot(g.bx - g.ax, g.bz - g.az) / 2, rot: -Math.atan2(g.bx - g.ax, g.bz - g.az) }, rail: true }; })());
        const ok = list.map((e) => Number.isFinite(e.c.x) && Math.abs(e.c.x) < 1e5);
        const res = window.__invCheck(list.filter((e, i) => ok[i]));
        let k = 0;
        return items.map((b, i) => (ok[i] ? { ...b, cells: res[k][0], hit: res[k++][1] } : null));
      }, sp.items);
      for (const b of r) if (b && (!b.hit || (b.kind === 'col' && b.cells >= 40 && b.hit / b.cells < MOSTLY))) still.push(b);
      if (s % 20 === 19) console.log(`  ${s + 1}/${spots.length} visited, ${still.length} still bare`);
    }
    bad = still;
  }
  // ---- report
  const rows = await page.evaluate((bad) => {
    const G = window.__game, cols = G.colliders, rails = G.busRoads?.rails || [];
    const flags = (c) => Object.keys(c).filter((k) => c[k] === true || (k === 'police' && c[k])).join(',');
    return bad.map((b) => {
      if (b.kind === 'rail') { const g = rails[b.n]; return { kind: 'rail line', x: +((g.ax + g.bx) / 2).toFixed(1), z: +((g.az + g.bz) / 2).toFixed(1), size: Math.hypot(g.bx - g.ax, g.bz - g.az).toFixed(1) + ' m', flags: g.seg ? 'guardrail' : 'wall', cov: b.hit + '/' + b.cells, src: '' }; }
      const c = cols[b.n], g = G.world.meshHeight ? G.world.meshHeight(c.x, c.z) : G.world.height(c.x, c.z);
      return { kind: b.hit ? 'oversized' : 'bare', x: +c.x.toFixed(1), z: +c.z.toFixed(1), y: +g.toFixed(1), size: c.r !== undefined ? 'r' + c.r.toFixed(2) : (2 * c.hw).toFixed(2) + 'x' + (2 * c.hd).toFixed(2), top: c.top !== undefined ? +(c.top - g).toFixed(2) : undefined, flags: flags(c), cov: b.hit + '/' + b.cells, src: c.__src || '' };
    });
  }, bad);
  const groups = new Map();
  for (const r of rows) { const k = `${r.kind}  ${r.src.split(' < ')[0]} [${r.flags}]`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  console.log(`\nstill bare / mostly empty with you next to them: ${rows.length}`);
  for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(rs.length).padStart(5)}  ${k}`);
    for (const r of rs.slice(0, MAXROWS)) console.log(`         (${r.x}, ${r.z}) y${r.y ?? ''} ${r.size}${r.top !== undefined ? ' top+' + r.top : ''} drawn ${r.cov}${r.src ? '  ' + r.src : ''}`);
  }
  // ---- the trees and rocks round you against what vegetation.js drew
  const v = await page.evaluate(() => {
    const G = window.__game, veg = G.vegetation;
    if (!veg?.cells) return null;
    const M4 = G.camera.matrix.constructor, _mi = new M4();
    const drawn = new Set(), dk = (x, z) => Math.round(x * 4) + ',' + Math.round(z * 4);
    for (const m of [...(veg.closeMeshes || []), ...(veg.nearMeshes || []), ...(veg.rockNear || []), ...(veg.rockFar || [])]) for (let k = 0; k < (m?.count || 0); k++) { m.getMatrixAt(k, _mi); drawn.add(dk(_mi.elements[12], _mi.elements[14])); }
    for (const m of veg.farMeshes || []) { const a = m.geometry.attributes.aOffset.array, n = m.geometry.instanceCount; for (let k = 0; k < n; k++) drawn.add(dk(a[k * 4], a[k * 4 + 2])); }
    const P = veg.lastRebuild, Q = G.quality?.veg || {}, nearR = Q.nearR || 120, rockR = Q.rockR || 150;
    const out = { at: [Math.round(P.x), Math.round(P.y)], trees: 0, rocks: 0, treesUndrawn: [], rocksUndrawn: [] };
    for (const cell of veg.cells.values()) {
      for (const t of cell.trees) { const d = Math.hypot(t.x - P.x, t.z - P.y); if (d > nearR * 0.95) continue; out.trees++; if (!drawn.has(dk(t.x, t.z))) out.treesUndrawn.push([Math.round(t.x), Math.round(t.z)]); }
      for (const r of cell.rocks) { const d = Math.hypot(r.x - P.x, r.z - P.y); if (d > rockR * 0.9) continue; out.rocks++; if (!drawn.has(dk(r.m[12], r.m[14]))) out.rocksUndrawn.push([Math.round(r.x), Math.round(r.z), +r.s.toFixed(1)]); }
    }
    return out;
  });
  if (v) console.log(`\nvegetation round (${v.at}): trees ${v.trees} (not drawn ${v.treesUndrawn.length}${v.treesUndrawn.length ? ': ' + JSON.stringify(v.treesUndrawn.slice(0, 10)) : ''}), rocks ${v.rocks} (not drawn ${v.rocksUndrawn.length}${v.rocksUndrawn.length ? ': ' + JSON.stringify(v.rocksUndrawn.slice(0, 10)) : ''})`);
  await browser.close();
})();
