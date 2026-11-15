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

export async function exportNet({ THREE, SRC, world, L, busRoads, skibus, parking, roadTunnels, railStations, xtrack, models, freeMod, loadGLB, pack, log, r4, scene = null }) {
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
  // the guardrails' drawn 4 m sections (bus.js Guardrails.build: each instance a railGeometry() bent along a cubic
  // Hermite from a to b with the tangents ta / tb, heights linear less the terminal's sink): per section
  // [ax, ay, az, asink, bx, by, bz, bsink, tax, taz, tbx, tbz] in world space, and for each rail line the section it
  // draws (busRoads.rails[k].seg: broken through, that section goes)
  if (scene) {
    const S = [], key = (x, z, x2, z2) => `${Math.round(x * 50)},${Math.round(z * 50)},${Math.round(x2 * 50)},${Math.round(z2 * 50)}`, at = new Map();
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!o.isInstancedMesh || o.name !== 'guardrail') return;
      const A = o.geometry.getAttribute('aRailA'), B = o.geometry.getAttribute('aRailB'), T = o.geometry.getAttribute('aRailT');
      const c = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      for (let k = 0; k < o.count; k++) {
        const ax = A.getX(k) + c.x, az = A.getZ(k) + c.z, bx = B.getX(k) + c.x, bz = B.getZ(k) + c.z;
        at.set(key(ax, az, bx, bz), S.length / 12);
        S.push(ax, A.getY(k) + c.y, az, A.getW(k), bx, B.getY(k) + c.y, bz, B.getW(k), T.getX(k), T.getY(k), T.getZ(k), T.getW(k));
      }
    });
    const railSeg = (busRoads.rails || []).map((g) => (g.seg ? at.get(key(g.seg.a[0], g.seg.a[2], g.seg.b[0], g.seg.b[2])) ?? -1 : -1));
    out.railSegs = { off: pack.blob(Float32Array.from(S)), n: S.length };
    out.railSeg = railSeg;
    log('net: guardrail sections', S.length / 12, '; rail lines with their section', railSeg.filter((k) => k >= 0).length, 'of', railSeg.length);
  }
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
  // The cars' lamps (cars.js carTemplate: the model's own light meshes sorted triangle by triangle into head / drl /
  // tail / third / brake / rev / ind / lens groups by LAMP_RULES, and where their halos go): the game's own code runs
  // on a copy of the model whose materials carry the base colour maps' pixels (the colour-aware rules read them:
  // texels() takes image.px), decoded here with sharp. Exported per car: the halo anchors, and each lamp part's
  // triangles in the car's frame (positions, uvs with the map's KHR_texture_transform applied) with the tier / boost
  // carInstance gives its material, so the C++ lights the same triangles with the same intensities (carlights.js).
  const { carTemplate } = await imp('game/cars.js');
  let sharp = null;
  try { sharp = (await import('node:module')).createRequire(path.join(SRC, '../package.json'))('sharp'); } catch (e) { log('lamps: no sharp (', e.message, '): the colour-aware lamp rules see no texels'); }
  // The steering wheel (cars.js splitWheels: the triangles of the model that are the wheel, by name, or found by its
  // shape round a hint: findSteering): where it is, the column's axis, and which triangles (their middles, in the car's
  // frame): the C++ takes the same triangles out of its own copy of the model and turns them (game/vehicles)
  const steerData = (t) => {
    const S = t?.steering;
    if (!S?.parts?.length) return null;
    const cen = [];
    for (const p of S.parts) {
      const P = p.geometry.attributes.position, I = p.geometry.index;
      if (!P || !I || p.material?.userData?.slMat?.index === undefined) continue;   // (the hub's rings: made by the game, not in the model)
      for (let i = 0; i < I.count; i += 3) {
        const a = I.getX(i), b = I.getX(i + 1), c = I.getX(i + 2);
        cen.push((P.getX(a) + P.getX(b) + P.getX(c)) / 3 + S.c.x, (P.getY(a) + P.getY(b) + P.getY(c)) / 3 + S.c.y, (P.getZ(a) + P.getZ(b) + P.getZ(c)) / 3 + S.c.z);
      }
    }
    if (!cen.length) return null;
    return { c: [r4(S.c.x), r4(S.c.y), r4(S.c.z)], axis: [r4(S.axis.x), r4(S.axis.y), r4(S.axis.z)], tilt: r4(S.tilt), rimR: r4(S.rimR), cen: { off: pack.blob(Float32Array.from(cen)), n: cen.length } };
  };
  let lastSteer = null;
  const lampData = async (name, g, length) => {
    const buf = fs.readFileSync(path.join(SRC, '../public/models', name + '.glb'));
    const len = buf.readUInt32LE(12), json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8')), bin = buf.subarray(20 + len + 8);
    const texOf = new Map(); // material index -> THREE.Texture with image.px
    const imgCache = new Map();
    for (let i = 0; i < (json.materials || []).length; i++) {
      const bt = json.materials[i].pbrMetallicRoughness?.baseColorTexture;
      if (!bt || !sharp) continue;
      const t = json.textures?.[bt.index];
      const src = t?.extensions?.EXT_texture_webp?.source ?? t?.source;
      const im = json.images?.[src];
      if (!im || im.bufferView === undefined) continue;
      if (!imgCache.has(src)) {
        const bv = json.bufferViews[im.bufferView];
        const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
        try {
          const { data, info } = await sharp(bytes).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          imgCache.set(src, { width: info.width, height: info.height, px: { w: info.width, h: info.height, d: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) } });
        } catch (e) { imgCache.set(src, null); }
      }
      const img = imgCache.get(src);
      if (!img) continue;
      const tex = new THREE.Texture();
      tex.image = img; tex.flipY = false; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const tt = bt.extensions?.KHR_texture_transform;
      if (tt) { if (tt.offset) tex.offset.fromArray(tt.offset); if (tt.scale) tex.repeat.fromArray(tt.scale); if (tt.rotation) tex.rotation = tt.rotation; }
      tex.updateMatrix();
      texOf.set(i, tex);
    }
    // a private copy of the scene: its materials cloned (the shared ones stay as the rest of the export saw them)
    const scene = g.scene.clone(true), mats = new Map();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const one = (m) => {
        if (!m) return m;
        if (!mats.has(m)) { const c = m.clone(); c.userData = { ...m.userData }; const idx = m.userData?.slMat?.index; if (idx !== undefined && texOf.has(idx)) c.map = texOf.get(idx); mats.set(m, c); }
        return mats.get(m);
      };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
    const t = carTemplate({ scene }, length, name);
    try { lastSteer = steerData(t); } catch (e) { lastSteer = null; log('steering wheel of', name, 'skipped:', e.message); }
    const L = t?.lamps;
    if (!L) return null;
    const v3 = (v) => [r4(v.x), r4(v.y), r4(v.z)];
    const halo = {};
    for (const [kind, list] of Object.entries(L.halo || {})) halo[kind] = list.map((a) => ({ c: v3(a.c), size: v3(a.size) }));
    const parts = [];
    for (const p of L.parts || []) {
      const src = p.material, orig = src.userData?.emOrig, nm = src.name || '';
      const core = p.core || !!orig || /drl|led|glow|emiss|signature/i.test(nm);
      const map = src.userData?.flat ? null : orig?.map || src.map || null;
      const tier = core ? 'core' : map ? 'tex' : 'plain';
      const boost = (src.transparent ? 1 / Math.max(0.12, src.opacity ?? 1) : 1) * (p.glow ?? 1);
      const P = p.geometry.attributes.position, U = p.geometry.attributes.uv, I = p.geometry.index;
      if (!P || !I) continue;
      const pos = new Float32Array(P.count * 3), uv = new Float32Array(P.count * 2);
      const uvw = new THREE.Vector2();
      for (let i = 0; i < P.count; i++) {
        pos[i * 3] = P.getX(i); pos[i * 3 + 1] = P.getY(i); pos[i * 3 + 2] = P.getZ(i);
        if (U) { uvw.set(U.getX(i), U.getY(i)); if (map?.matrix) uvw.applyMatrix3(map.matrix); uv[i * 2] = uvw.x; uv[i * 2 + 1] = uvw.y; }
      }
      parts.push({ kind: p.kind, tier, boost: r4(boost), alpha: r4(src.transparent ? Math.min(1, src.opacity ?? 1) : 1), mat: src.userData?.slMat?.index ?? -1, map: !!map, P: { off: pack.blob(pos), n: pos.length }, U: { off: pack.blob(uv), n: uv.length },
        I: { off: pack.blob(Uint32Array.from(I.array)), n: I.count } });
    }
    return { halfL: r4(L.halfL), halo, parts };
  };

  // The models' own number plates (cars.js dropPlates: every material named like a plate, isPlateMat, and per model the
  // plate pieces of shared materials, PLATE_PIECES: the connected pieces welded at 1 mm lying wholly inside a box of the
  // fitted frame, or with 'face' just the triangles in it facing out of the car's end) are left out of the web game's
  // template: their triangles' middles in the car's frame, so the C++ leaves the same triangles out of its own copy.
  // (the copy of PLATE_PIECES below must follow cars.js; triangles carTemplate's lamp split took first stay)
  const { isPlateMat } = await imp('game/cars.js');
  const PLATE_PIECES = {
    car_tesla_m3: [[/^(White|BlackWash)$/, [-0.17, 0.17, 0.32, 0.5, 2.28, 2.42]], [/^(White|BlackWash)$/, [-0.17, 0.17, 0.67, 0.85, -2.38, -2.26]]],
    car_vw_golf_gti: [[/^Atlas$/, [-0.28, 0.28, 0.42, 0.565, 2.125, 2.2], 'face'], [/^Atlas$/, [-0.28, 0.28, 0.42, 0.565, -2.2, -2.08]]],
    car_porsche_taycan: [[/turbo_s_misc/, [-0.17, 0.17, 0.35, 0.47, -2.47, -2.38]]],
    car_audi_etron_gt: [[/^gtVehicle_Exterior_mm_misc1$/, [-0.26, 0.26, 0.64, 0.76, -2.41, -2.33]]],
    car_toyota_gr_yaris: [[/Coloured_Material/, [-0.17, 0.17, 0.73, 0.9, -1.885, -1.8]]],
    car_mercedes_gls: [[/^gls_dash_wood$/, [-0.28, 0.28, 0.5, 0.625, 2.59, 2.62], 'face']],
    car1: [[/^material$/, [-0.3, 0.34, 0.385, 0.56, 2.45, 2.54]], [/^material$/, [-0.3, 0.34, 0.61, 0.765, -2.44, -2.34]]],
  };
  const plateDrop = (g, length, name) => {
    const model = name.replace(/_full$/, ''), pieces = PLATE_PIECES[model] || [];
    const src = fitCar(g, length, name);
    src.updateMatrixWorld(true);
    const lampAt = new Set(), key = (x, y, z) => `${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`;
    try {
      const t = carTemplate(g, length, name);
      for (const p of t?.lamps?.parts || []) {
        const P = p.geometry.attributes.position, I = p.geometry.index;
        if (!P || !I) continue;
        for (let i = 0; i < I.count; i += 3) { const a = I.getX(i), b = I.getX(i + 1), c = I.getX(i + 2); lampAt.add(key((P.getX(a) + P.getX(b) + P.getX(c)) / 3, (P.getY(a) + P.getY(b) + P.getY(c)) / 3, (P.getZ(a) + P.getZ(b) + P.getZ(c)) / 3)); }
      }
    } catch { /* (no template: no lamps to keep) */ }
    const cen = [], v = new THREE.Vector3();
    src.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const P0 = o.geometry.attributes.position, n = P0.count;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { v.fromBufferAttribute(P0, i).applyMatrix4(o.matrixWorld); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; }
      const idxAll = o.geometry.index ? Array.from(o.geometry.index.array) : [...Array(n).keys()];
      const sets = mats.length === 1 || !o.geometry.groups?.length ? [[mats[0], idxAll]]
        : o.geometry.groups.map((gr) => [mats[gr.materialIndex] || mats[0], idxAll.slice(gr.start, gr.start + gr.count)]);
      for (const [mat, I] of sets) {
        const X = (i) => pos[i * 3], Y = (i) => pos[i * 3 + 1], Z = (i) => pos[i * 3 + 2];
        const drop = new Uint8Array(I.length / 3);
        if (isPlateMat(mat)) drop.fill(1);
        else for (const [re, box, face] of pieces) {
          if (!re.test(mat?.name || '')) continue;
          if (face) {
            const s = Math.sign(box[4] + box[5]), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
            for (let t = 0; t < I.length; t += 3) {
              a.set(X(I[t]), Y(I[t]), Z(I[t])); b.set(X(I[t + 1]), Y(I[t + 1]), Z(I[t + 1])); c.set(X(I[t + 2]), Y(I[t + 2]), Z(I[t + 2]));
              const x = (a.x + b.x + c.x) / 3, y = (a.y + b.y + c.y) / 3, z = (a.z + b.z + c.z) / 3;
              const nz = b.sub(a).cross(c.sub(a)).normalize().z * s;
              if (Math.abs(nz) > 0.9 && x >= box[0] && x <= box[1] && y >= box[2] && y <= box[3] && z >= box[4] && z <= box[5]) drop[t / 3] = 1;
            }
            continue;
          }
          const wk = new Map(), canon = new Int32Array(n), par = new Int32Array(n).map((_, i) => i);
          for (let i = 0; i < n; i++) { const k = `${Math.round(X(i) * 1000)},${Math.round(Y(i) * 1000)},${Math.round(Z(i) * 1000)}`; if (!wk.has(k)) wk.set(k, i); canon[i] = wk.get(k); }
          const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
          for (let t = 0; t < I.length; t += 3) { const a = find(canon[I[t]]), b = find(canon[I[t + 1]]), c = find(canon[I[t + 2]]); par[b] = a; par[find(c)] = a; }
          const inside = new Map();
          const used = new Set(I);
          for (const i of used) { const r = find(canon[i]); const ins = X(i) >= box[0] && X(i) <= box[1] && Y(i) >= box[2] && Y(i) <= box[3] && Z(i) >= box[4] && Z(i) <= box[5]; inside.set(r, (inside.get(r) ?? true) && ins); }
          for (let t = 0; t < I.length; t += 3) if (inside.get(find(canon[I[t]]))) drop[t / 3] = 1;
        }
        for (let t = 0; t < I.length; t += 3) {
          if (!drop[t / 3]) continue;
          const x = (X(I[t]) + X(I[t + 1]) + X(I[t + 2])) / 3, y = (Y(I[t]) + Y(I[t + 1]) + Y(I[t + 2])) / 3, z = (Z(I[t]) + Z(I[t + 1]) + Z(I[t + 2])) / 3;
          if (lampAt.has(key(x, y, z))) continue;
          cen.push(x, y, z);
        }
      }
    });
    log('net: own plates of', name, cen.length / 3, 'triangles left out');
    return cen.length ? { off: pack.blob(Float32Array.from(cen)), n: cen.length } : null;
  };
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
    // where the number plates go (carconfig.js plateSpots: each model's front and rear spot measured on its own
    // geometry, flush on the holder / in the recess; the car's frame; none where the model carries none)
    let plates = null;
    try {
      const CARS = await imp('game/cars.js'), CFG = await imp('game/carconfig.js');
      const tpl = CARS.carTemplate(g, length, name);
      plates = (CFG.plateSpots(tpl) || []).map((p) => ({ front: !!p.front, m: p.m.toArray().map(r4) }));
    } catch (e) { log('net: plates of', name, 'skipped:', e.message); }
    out.cars.push({ name, label: spec.label || name, accel: spec.accel ?? 5, top: spec.top ?? 55, electric: !!spec.electric, rev: spec.rev ?? 1, mass: MASS[name] ?? 1700,
      drive: DRIVE[name] || 'awd', length, size: [r4(size.x), r4(size.y), r4(size.z)], real: REAL[name] || null, fit: m.matrix.toArray().map(r4), hide, glass,
      price: rent?.price ?? 0, kind: rent?.kind || '', plates, plateDrop: plateDrop(g, length, name) });
    lastSteer = null;
    try {
      const lamps = await lampData(name, g, length);
      if (lamps) { out.cars[out.cars.length - 1].lamps = lamps; log('lamps', name, lamps.parts.map((q) => `${q.kind}/${q.tier}:${q.I.n / 3}`).join(' '), '| halos', Object.entries(lamps.halo).map(([k, v]) => `${k}x${v.length}`).join(' ')); }
    } catch (e) { log('lamps', name, 'failed:', e.message); }
    if (lastSteer) out.cars[out.cars.length - 1].steer = lastSteer;
    log('steering wheel', name, lastSteer ? `${lastSteer.cen.n / 3} triangles at ${lastSteer.c.join(', ')}` : 'none');
  }
  // the patrol car (police.js car1Template: car1.glb as a fleet car template fitted to CAR1_LEN = 5.0, nose +z) and where
  // its two Swiss plates go on it (setPlates(inst, C.t, policePlate()): carconfig.js plateSpots, PLATE_SPOT.car1)
  try {
    const g = models.car1 || await loadGLB('car1');
    const CARS = await imp('game/cars.js'), CFG = await imp('game/carconfig.js');
    const tpl = CARS.carTemplate(g, 5.0, 'car1');
    // (and the template's fit, cars.js fitCar: every vertex measured (PRECISE), so the car and its plates sit as in the web game)
    const fit = fitCar(g, 5.0, 'car1').children[0];
    fit.updateMatrix();
    out.policeCar = { length: 5.0, fit: fit.matrix.toArray().map(r4), size: [r4(tpl.size.x), r4(tpl.size.y), r4(tpl.size.z)], plates: (CFG.plateSpots(tpl) || []).map((p) => ({ front: !!p.front, m: p.m.toArray().map(r4) })), plateDrop: plateDrop(g, 5.0, 'car1') };
    log('net: the patrol car', out.policeCar.size.join(' x '), 'm,', out.policeCar.plates.length, 'plates');
  } catch (e) { log('net: the patrol car\'s plates skipped:', e.message); }
  // the full-detail models (drive.js FULL: the car you drive shows its `_full` model, with its interior): fitted like
  // the simple ones (the same rules: cars.js works on the name without `_full`)
  out.carsFull = [];
  try {
    const { FULL } = await imp('game/drive.js');
    for (const [base, name] of Object.entries(FULL || {})) {
      const length = (CAR_MODELS.find(([n]) => n === base) || [])[1];
      const g = models[name] || await loadGLB(name);
      if (!g || !length) continue;
      const fit = fitCar(g, length, name), m = fit.children[0];
      m.updateMatrix();
      const kept = new Set(meshNames(m)), hide = [...new Set(meshNames(g.scene).filter((n) => !kept.has(n)))];
      const size = new THREE.Box3().setFromObject(fit).getSize(new THREE.Vector3());
      const glass = glbMaterials(name).map((q, i) => ({ ...q, i })).filter((q) => q.transmission || (/glass|glas$|window|windscreen/.test(q.name.toLowerCase()) && !/surr|frame|seal|rubber|trim/.test(q.name.toLowerCase())))
        .map((q) => ({ i: q.i, red: /red/.test(q.name.toLowerCase()), clear: /front_light|light/.test(q.name.toLowerCase()) && !/red/.test(q.name.toLowerCase()) }));
      let steer = null;
      try { steer = steerData(carTemplate(g, length, name)); } catch (e) { log('steering wheel of', name, 'skipped:', e.message); }
      log('steering wheel', name, steer ? `${steer.cen.n / 3} triangles at ${steer.c.join(', ')}` : 'none');
      out.carsFull.push({ name, base, length, size: [r4(size.x), r4(size.y), r4(size.z)], fit: m.matrix.toArray().map(r4), hide, glass, steer, plateDrop: plateDrop(g, length, name) });
    }
    log('net: full-detail car models', out.carsFull.map((c) => c.name).join(' '));
  } catch (e) { log('net: full-detail car models skipped:', e.message); }
  if (skibus?.line?.bus?.shell) {
    const B = await imp('game/bus/bus.js'), sh = skibus.line.bus.shell, m = sh.children[0];
    m.updateMatrix();
    out.bus = { model: 'ski_bus_micruss', fit: m.matrix.toArray().map(r4), BUS: B.BUS, size: sh.userData.size ? [sh.userData.size.x, sh.userData.size.y, sh.userData.size.z] : null,
      wheelBase: sh.userData.wheelBase ?? 6.8, fleet: B.FLEET_N ?? 8,
      glass: glbMaterials('ski_bus_micruss').map((q, i) => (/^(Windows|InteriorWindow)$/.test(q.name) ? i : -1)).filter((i) => i >= 0),
      paint: glbMaterials('ski_bus_micruss').map((q, i) => (q.name === 'Body' ? i : -1)).filter((i) => i >= 0),
      seats: (skibus.line.bus.seats || []).map((s) => ({ p: [r4(s.pos.x), r4(s.pos.y), r4(s.pos.z)], window: !!s.window, side: s.side, row: s.row })) };
    // the fleet's timetable as bus.js buildFleet / slotFleet made it (bus:1..7 on their rounds, each round its own
    // shared timeline 'bus|R<idx>' online): per bus its round, cycle, phase and its two ways (fleetDir: the joined
    // trips, the speed profile, the stops' marks, the knots (time, arc length)) at full precision, so the C++ places
    // every bus where the web game does at the same clock; and bus:0's bay at the depot (depotTrips(0).in, its end)
    const L = skibus.line, idx = (s) => stops.indexOf(s);
    const way = (P) => ({ n: P.n, length: P.length, X: f32(P.X), Y: f32(P.Y), Z: f32(P.Z), S: f32(P.S), V: f32(P.V), sA: P.sA, sB: P.sB, dur: P.dur,
      kt: Array.from(P.kt), ks: f32(P.ks), marks: P.marks.map((m) => ({ s: m.s, stop: idx(m.stop), depot: !!m.stop?.depot, dwell: m.dwell, t: m.t ?? 0 })) });
    if (L.fleet?.length) {
      out.fleet = { buses: L.fleet.map((b) => ({ id: b.id, line: b.route.mpLine, round: b.route.idx, to: idx(b.route.to), cycle: b.route.cycle, phase: b.phase, out: way(b.route.out), back: way(b.route.back) })) };
      try {
        const { depotTrips } = await imp('game/bus/depot.js');
        const T = depotTrips(0);
        if (T) out.fleet.park0 = { n: T.in.n, X: f32(T.in.X), Y: f32(T.in.Y), Z: f32(T.in.Z), S: f32(T.in.S), s1: T.in.s1 };
      } catch (e) { log('net: bus:0 bay', e.message); }
      log('net: bus fleet', out.fleet.buses.map((b) => `${b.id} ${b.line} ${(b.cycle / 60).toFixed(0)} min`).join(', '));
    }
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
    // (the cabin's surfaces: train.js textures them in its shader; baked into maps here: tools/train_detail.mjs)
    const { bakeCabinDetail } = await import('./train_detail.mjs');
    if (proc) { try { bakeCabinDetail(THREE, proc, log); } catch (e) { log('train detail skipped:', e.stack?.split('\n').slice(0, 3).join(' | ')); } }
    const frame = new THREE.Group();
    for (const ch of [...car.group.children]) if (ch !== proc && ch.name !== 'rail-car-meshy' && !car.bogies.includes(ch)) frame.add(ch.clone());
    out.rail.models = {
      cabin: proc ? pack.localModel(proc) : [],
      frame: pack.localModel(frame),
      bogie: car.bogies[0] ? pack.localModel(car.bogies[0]) : [],
      lo: car.lo ? pack.localModel(car.lo) : [],
    };
    // the Legacy Express's own cabin (express.js: buildCar({ express: true }) furnished by expressinterior.js: rounded
    // laminate tables, the aluminium luggage racks with their glass shelf, and the Meshy double seats and racks from
    // public/models/train once their GLBs are in); what the web game hides (the procedural coach seats and rack the
    // Meshy pieces replace) stays out
    try {
      const X = await imp('world/expressinterior.js');
      const xcar = T.buildCar({ number: 1, express: true });
      X.furnishExpress(xcar);
      for (let k = 0; k < 40; k++) await new Promise((r) => setTimeout(r, 25)); // (its two GLBs load and are fitted)
      const xproc = xcar.group.getObjectByName('rail-car-proc');
      if (xproc) {
        xproc.traverse((o) => { if (o !== xproc && o.visible === false) o.traverse((q) => { q.userData.slSkip = true; }); });
        try { bakeCabinDetail(THREE, xproc, log); } catch (e) { log('train detail (express) skipped:', e.message); }
        // (express.js drawInfo: the railcar's two info screens, over the cab door and on the rear wall, found by their
        // planes, show the Express's own live trip display: their material is named so the game can redraw its canvas)
        let screens = 0;
        xproc.traverse((o) => {
          const p = o.geometry?.parameters;
          if (o.isMesh && p && o.geometry.type === 'PlaneGeometry' && ((p.width === 1.2 && p.height === 0.3) || (p.width === 0.84 && p.height === 0.21))) {
            o.material = o.material.clone(); o.material.userData = { ...o.material.userData, slTag: 'express-info' }; screens++;
          }
        });
        log('net: the Legacy Express info screens', screens);
        out.rail.models.cabinExpress = pack.localModel(xproc);
        log('net: the Legacy Express cabin', out.rail.models.cabinExpress.length, 'parts; Meshy interior', !!xcar.group.getObjectByName('express-interior'));
      }
    } catch (e) { log('net: express cabin skipped:', e.stack?.split('\n').slice(0, 3).join(' | ')); }
    out.rail.bogies = car.bogies.map((b) => [r4(b.position.x), r4(b.position.y), r4(b.position.z)]);
    const seat = car.seats.find((s) => s.row === 1 && s.window && s.side > 0) || car.seats.find((s) => s.front && s.window) || car.seats[0];
    out.rail.seat = seat ? { p: [r4(seat.pos.x), r4(seat.pos.y), r4(seat.pos.z)], yaw: seat.yaw } : null;
    out.rail.seats = car.seats.map((s) => [r4(s.pos.x), r4(s.pos.y), r4(s.pos.z), r4(s.yaw)]);
    // (the cabin's layout: express.js walks about in it by these: WALK, walkBoxes, walkCamera)
    out.rail.cabin = { W: T.CABIN.W, HW: T.CABIN.HW, BAYS_N: T.CABIN.BAYS_N, BAYS_Z0: T.CABIN.BAYS_Z0, BAY: T.CABIN.BAY, CEIL_Y: T.CABIN.CEIL_Y, cabZ: T.CAR.cabZ };
    // the seated passengers (railway.js seatPassengers: skiers on about half the seats of the train you board, never the
    // rider's front row; their looks, poses and places from its own seeded generator, drawn in its order: first the
    // bakes' two numbers for every look x pose x head turn, then per car the seats, and per passenger the look, the
    // pose, window or neighbour, the turn in the seat, the size). Per car: [seat, look, pose, head, yaw jitter, scale, the
    // bake's head turn (rad), the bake's variation]
    try {
      const { mulberry32 } = await imp('core/noise.js');
      const looks = ['skier_red', 'skier_green', 'skier_orange', 'skier_black', 'skier_purple', 'skier_blue'], kinds = ['thighs', 'lap', 'crossed', 'phone'];
      const rnd = mulberry32(5150);
      // (poseSeated(rig, kind, dir * (0.38 + rnd() * 0.25), rnd()): each bake's head turn and its own variation)
      const bake = new Map();
      for (let i = 0; i < looks.length; i++) for (let k = 0; k < kinds.length; k++) for (const dir of kinds[k] === 'phone' ? [0] : [-1, 1]) { const turn = dir * (0.38 + rnd() * 0.25), v = rnd(); bake.set(`${i}|${k}|${dir}`, [r4(turn), r4(v)]); }
      out.rail.passengerLooks = looks;
      out.rail.passengers = [];
      for (let c = 0; c < 2 * (W.RAIL_UNITS ?? 2); c++) {
        const places = car.seats.filter((st) => !(st.row === 1 && st.side > 0) && rnd() < 0.56), list = [];
        for (const st of places) {
          const look = Math.floor(rnd() * looks.length), r = rnd(), kind = r < 0.36 ? 0 : r < 0.6 ? 1 : r < 0.8 ? 2 : 3;
          const toWindow = rnd() < 0.65, lateral = Math.sign(st.pos.x) * (toWindow ? 1 : -1);
          const dir = kind === 3 ? 0 : lateral * (st.yaw === 0 ? 1 : -1) > 0 ? 1 : -1;
          const yawJ = (rnd() - 0.5) * 0.12, sc = 0.95 + rnd() * 0.08;
          list.push([car.seats.indexOf(st), look, kind, dir, r4(yawJ), r4(sc), ...(bake.get(`${look}|${kind}|${dir}`) || [0, 0.5])]);
        }
        out.rail.passengers.push(list);
      }
      log('net: rail passengers per car', out.rail.passengers.map((l) => l.length).join(' '), 'of', car.seats.length, 'seats');
    } catch (e) { log('net: rail passengers skipped:', e.message); }
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
        V: f32(EXPRESS_PROFILE.V), T: f32(EXPRESS_PROFILE.T), V64: Array.from(EXPRESS_PROFILE.V), loop: EXPRESS_PROFILE.loop, dwell: E.DWELL, vmax: E.VMAX, price: X.EXPRESS_PRICE, fast: X.FAST,
        stations: (L.layout.express?.stations || []).map((s) => ({ id: s.id, name: s.name, course: s.course, s: s.s, x: r4(s.x), z: r4(s.z), y: r4(s.y), heading: r4(s.heading), side: s.side,
          board: s.board ? [r4(s.board.x), r4(s.board.z)] : null, exit: s.exit ? [r4(s.exit.x), r4(s.exit.z), r4(s.exit.heading ?? 0)] : null })),
      };
      log('net: express', EXPRESS.n, 'samples,', out.express.stations.length, 'stations, loop', EXPRESS_PROFILE.loop.toFixed(0), 's');
    }
  } catch (e) { log('net: express skipped', e.message); }
  void xtrack; void roadTunnels; void freeMod;
  return out;
}
