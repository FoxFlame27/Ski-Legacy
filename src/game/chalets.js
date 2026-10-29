// THE CHALET VILLAGE (Almdorf): two-storey chalets (the user's Meshy chalet: white plaster below, timber above,
// snowy roofs) on terraces on both sides of the Chaletweg up the gentle forested slope north of Legacy Village (its
// layout, its ground and its road: game/bus/chaletroad.js, part of busRoads; its bus stop "Almdorf" at the junction
// with the valley road). Every plot: the chalet facing the road, a snowy garden inside a picket fence (small spruces
// and dwarf spruces from the game's own pine models, a bench, a shed or a snowman, a sledge by the steps), stepping
// stones from the gate to the front steps, and a private parking bay beside the house (two 2.5 x 5 m bays, fenced,
// a "Privat" sign) with its drive off the road. The playground on a plot of its own.
// Cheap: the chalets are one instanced low-poly mesh (chalet_lo.glb), the full model (chalet.glb) only on the one you
// stand nearest; the props instanced too.
// BUY A CHALET ($50,000, yours for good, ONE each: save.chalet = { id, name, owned, since, furniture }). E at a
// chalet's door: buy it, or have a look inside. Your own chalet's door (and the one you're viewing) opens with E or
// when you walk into it: you walk straight in, no fade, no scene switch. The interior (game/chaletroom.js, one shared
// instance) stands in the world inside the chalet you're at; that chalet's model gets its painted door cut away
// and shows only its outward faces (FrontSide), so from inside you see the rooms and, through the windows, the world.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { layout } from '../world/layout.js';
import { busRoads } from './bus/roads.js';
import { loadGLB, fitModel } from '../core/assets.js';
import { HX, HZ, G, DOOR, DOOR_CUT, MODEL, FOOT, STEPS, IX, IZ, FL } from './chaletplan.js';
import { ChaletRoom, setChaletInterior } from './chaletroom.js';

export const CHALET_PRICE = 50000; // (bought for good, not rented)
const S = MODEL.scale;
const FENCE_L = 1.6;               // m: one fence section (stretched to fit its run)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _l = new THREE.Vector3();
const hash = (i) => { const v = Math.sin(i * 91.7 + 17.3) * 43758.5453; return v - Math.floor(v); };

// ------------------------------------------------------------------ where everything stands (pure: the game and the
// Node checks use it). Items: { kind, x, z, yaw, y, ... } in the world; boxes for the checks: { hw, hd, y0, y1 }
// round (x, z) turned by yaw (three.js rotation.y), flat: laid on the ground.
export function houseFrame(p) {
  const f = new THREE.Object3D();
  f.position.set(p.house.x, p.y, p.house.z); f.rotation.y = -Math.PI / 2 + p.house.yaw; // (+x, the door, to the road)
  f.updateMatrixWorld(true);
  return f;
}
export function villagePlacements(V, height = (x, z) => world.height(x, z)) {
  const out = [];
  const put = (o) => { out.push(o); return o; };
  const fenceRun = (pid, ax, az, bx, bz, gaps = []) => { // sections along a -> b, gaps [[u0, u1]] (metres along it)
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, yaw = Math.atan2(-uz, ux);
    let u = 0;
    const cuts = [...gaps].filter((g) => g[1] > 0 && g[0] < L).sort((a, b) => a[0] - b[0]);
    cuts.push([L, L]);
    for (const [g0, g1] of cuts) {
      const a = u, b = Math.min(g0, L);
      if (b - a > 0.5) {
        const n = Math.max(1, Math.round((b - a) / FENCE_L)), l = (b - a) / n;
        for (let k = 0; k < n; k++) { const m = a + l * (k + 0.5), x = ax + ux * m, z = az + uz * m; put({ kind: 'fence', pid, x, z, y: height(x, z), yaw, len: l, hw: l / 2, hd: 0.1, y0: 0, y1: 1.0 }); }
        put({ kind: 'fenceCol', pid, x: ax + ux * (a + b) / 2, z: az + uz * (a + b) / 2, yaw, hw: (b - a) / 2, hd: 0.08, col: true });
      }
      u = Math.max(u, g1);
    }
  };
  for (const p of V.plots) {
    const sd = p.side, zIn = (d) => p.front + sd * d, depth = Math.abs(p.back - p.front), yawOut = sd < 0 ? 0 : Math.PI; // (facing the road)
    const xa = p.x0 + 0.2, xb = p.x1 - 0.2, zf = zIn(0.25), zb = zIn(depth - 0.25);
    if (p.playground) {
      const x = (p.x0 + p.x1) / 2, z = zIn(depth / 2 + 0.5);
      put({ kind: 'playground', pid: p.id, x, z, y: height(x, z), yaw: yawOut, hw: 2.35, hd: 2.1, y0: 0, y1: 3.6, col: true });
      for (const dx of [-6.5, 6.5]) { const bz = zIn(2.4); put({ kind: 'bench', pid: p.id, x: x + dx, z: bz, y: height(x + dx, bz), yaw: yawOut, hw: 0.8, hd: 0.45, y0: 0, y1: 1.15, col: true }); }
      fenceRun(p.id, xa, zf, xb, zf, [[(xb - xa) / 2 - 1.0, (xb - xa) / 2 + 1.0]]);
      fenceRun(p.id, xa, zf, xa, zb); fenceRun(p.id, xb, zf, xb, zb); fenceRun(p.id, xa, zb, xb, zb);
      continue;
    }
    const f = houseFrame(p), L = (x, z) => f.localToWorld(_l.set(x, 0, z)).clone();
    const yaw = f.rotation.y, c = f.position;
    put({ kind: 'house', pid: p.id, x: c.x, z: c.z, y: p.y, yaw, hw: HX, hd: HZ, y0: 0, y1: 8 });
    { const q = L((STEPS.x0 + STEPS.x1) / 2, (STEPS.z0 + STEPS.z1) / 2); put({ kind: 'steps', pid: p.id, x: q.x, z: q.z, y: p.y, yaw, hw: (STEPS.x1 - STEPS.x0) / 2, hd: (STEPS.z1 - STEPS.z0) / 2, y0: 0, y1: G }); }
    put({ kind: 'eaves', pid: p.id, x: L((FOOT.x0 + FOOT.x1) / 2, (FOOT.z0 + FOOT.z1) / 2).x, z: L((FOOT.x0 + FOOT.x1) / 2, (FOOT.z0 + FOOT.z1) / 2).z, y: p.y, yaw, hw: (FOOT.x1 - FOOT.x0) / 2, hd: (FOOT.z1 - FOOT.z0) / 2, y0: 4.6, y1: 8 });
    const door = L(HX + 1.6, DOOR.z), dx = door.x;
    // the bay and its drive (flat), its fence (back, and the back half of its house side), the sign
    const bay = p.bay, bw = bay.w, bz0 = zIn(0.3), bz1 = zIn(0.3 + bay.d), road = p.legZ + sd * 3.7;
    put({ kind: 'bay', pid: p.id, x: bay.x, z: (bz0 + bz1) / 2, yaw: 0, hw: bw / 2, hd: bay.d / 2, flat: true, x0: bay.x - bw / 2, x1: bay.x + bw / 2, za: bz0, zb: bz1, out: sd });
    put({ kind: 'drive', pid: p.id, x: bay.x, z: (road + bz0) / 2, yaw: 0, hw: bw / 2, hd: Math.abs(bz0 - road) / 2, flat: true, x0: bay.x - bw / 2, x1: bay.x + bw / 2, za: road, zb: bz0 });
    const bzF = zIn(0.3 + bay.d + 0.2), inner = bay.x < c.x ? bay.x + bw / 2 + 0.2 : bay.x - bw / 2 - 0.2, outer = bay.x < c.x ? xa : xb;
    fenceRun(p.id, outer, bzF, inner, bzF);
    fenceRun(p.id, inner, zIn(0.3 + bay.d * 0.5), inner, bzF);
    { const sx = inner + (bay.x < c.x ? 0.3 : -0.3), sz = zIn(0.45); put({ kind: 'sign', pid: p.id, x: sx, z: sz, y: height(sx, sz), yaw: yawOut, hw: 0.3, hd: 0.06, y0: 0, y1: 1.9, col: true }); }
    // the garden fence: the front (gaps: the drive, the gate to the path), both sides, the back
    const gx0 = Math.min(bay.x - bw / 2, bay.x + bw / 2) - 0.1 - xa, gx1 = Math.max(bay.x - bw / 2, bay.x + bw / 2) + 0.1 - xa;
    fenceRun(p.id, xa, zf, xb, zf, [[gx0, gx1], [dx - 0.7 - xa, dx + 0.7 - xa]]);
    fenceRun(p.id, xa, zf, xa, zb); fenceRun(p.id, xb, zf, xb, zb);
    fenceRun(p.id, xa, zb, xb, zb);
    // stepping stones from the gate to the steps (flush with the snow)
    for (const d of [0.65, 1.3, 1.95]) { const z = zIn(d), x = dx + (hash(p.id * 3 + d * 7) - 0.5) * 0.12; put({ kind: 'stone', pid: p.id, x, z, y: height(x, z), yaw: 0, spin: hash(p.id + d) * 6, hw: 0.29, hd: 0.29, flat: true, r: 0.29 }); }
    // the garden strip beside the house: a bench facing the view, small spruces, a shed or a snowman
    const [g0, g1] = p.garden, gx = (Math.max(g0, xa + 0.2) + Math.min(g1, xb - 0.2)) / 2;
    if (p.bench !== false) { const z = zIn(2.3); put({ kind: 'bench', pid: p.id, x: gx, z, y: height(gx, z), yaw: yawOut, hw: 0.8, hd: 0.45, y0: 0, y1: 1.15, col: true }); }
    const tree = (x, d, h, kind = 'spruce') => { const z = zIn(d); put({ kind, pid: p.id, x, z, y: height(x, z), yaw: hash(p.id * 5 + d) * 6.28, h, hw: h * 0.2, hd: h * 0.2, y0: 0, y1: h, col: kind === 'spruce', r: h * 0.16, v: hash(p.id * 11 + d) < 0.5 ? 0 : 1 }); };
    tree(gx - 0.75, 5.2, 2.6 + hash(p.id) * 0.8); tree(gx + 0.85, 7.0, 2.2 + hash(p.id + 1) * 0.6);
    if (p.shed) { const z = zIn(depth - 0.25 - 1.75); put({ kind: 'shed', pid: p.id, x: gx, z, y: height(gx, z), yaw: yawOut, hw: 1.48, hd: 1.6, y0: 0, y1: 2.2, col: true }); }
    else {
      tree(gx, 10.2, 3.0 + hash(p.id + 2) * 0.7);
      if (hash(p.id * 7) < 0.6) { const z = zIn(8.4), x = gx - 0.6; put({ kind: 'snowman', pid: p.id, x, z, y: height(x, z), yaw: yawOut + 0.4, hw: 0.35, hd: 0.35, y0: 0, y1: 1.5, col: true, r: 0.4 }); }
    }
    // dwarf spruces along the front of the house (either side of the path), a sledge by the steps
    const wx = (lz) => L(HX + 2.0, lz);
    for (const lz of [-4.2, -2.5, 2.1, 3.9]) { const q = wx(lz); const z = q.z, d = Math.abs(z - p.front); tree(q.x, d, 0.9 + hash(p.id * 13 + lz) * 0.4, 'shrub'); }
    if (hash(p.id * 17) < 0.55) { const q = L(HX + 0.9, STEPS.z1 + 0.55); put({ kind: 'sledge', pid: p.id, x: q.x, z: q.z, y: height(q.x, q.z), yaw: yaw + Math.PI / 2, hw: 0.5, hd: 0.2, y0: 0, y1: 0.35 }); }
  }
  return out;
}

export class Chalets {
  constructor(o) {
    // o: scene, camera, renderer, colliders, cameraBlockers, hud, audio, save, writeSave, spend, transition, player, getPost, getHour
    Object.assign(this, o);
    this.V = busRoads.chalets;
    this.inside = false; this.current = null; this.target = null; this.viewing = null;
    this.houses = []; this.hiAt = -1; this.roomAt = -1;
    if (!this.V) return;
    this.migrateSave();
    this.plan();
    this.room = new ChaletRoom({ renderer: o.renderer });
    this.room.attach(this.scene);
    setChaletInterior(this.room, this);
    this.ready = this.build().catch((e) => console.warn('chalet village', e));
  }

  // furniture saved before the Oct 28 rescale (floors at 0.55 / 3.5, a wider house): onto the new floors, inside
  migrateSave() {
    const c = this.save?.chalet;
    if (!c?.furniture?.length || c.plan >= 2) { if (c) c.plan = 2; return; }
    for (const r of c.furniture) {
      if (Number.isFinite(r.y)) r.y = r.y < 3.2 ? Math.max(G, r.y - 0.25) : r.y - 0.35;
      if (Number.isFinite(r.x)) r.x = Math.max(-IX + 0.25, Math.min(IX - 0.25, r.x));
      if (Number.isFinite(r.z)) r.z = Math.max(-IZ + 0.25, Math.min(IZ - 0.25, r.z));
    }
    c.plan = 2;
    this.writeSave?.();
  }

  plan() {
    let n = 0;
    for (const p of this.V.plots) {
      if (p.playground) continue;
      const frame = houseFrame(p);
      const door = frame.localToWorld(new THREE.Vector3(HX + 1.6, 0, DOOR.z));
      const out = new THREE.Vector3(1, 0, 0).applyQuaternion(frame.quaternion);
      this.houses.push({ id: p.id, name: `Chalet ${++n}`, plot: p, frame, door, out, yaw: frame.rotation.y });
    }
    this.items = villagePlacements(this.V);
    this.benchSpots = this.items.filter((i) => i.kind === 'bench').map((b) => ({ x: b.x, y: b.y, z: b.z, yaw: b.yaw }));
    const J = this.V.junction, first = this.houses.slice().sort((a, b) => Math.hypot(a.door.x - J.x, a.door.z - J.z) - Math.hypot(b.door.x - J.x, b.door.z - J.z))[0];
    const r = this.V.road, road = [];
    for (let i = 0; i < r.n; i += 3) road.push([r.X[i], r.Z[i]]);
    layout.chaletVillage = {
      x: first ? first.door.x : this.V.place.x, z: first ? first.door.z : this.V.place.z, label: 'Chalet village', center: { x: this.V.place.x, z: this.V.place.z },
      houses: this.houses.map((h) => ({ id: h.id, x: h.frame.position.x, z: h.frame.position.z, yaw: h.yaw, w: 2 * HX, d: 2 * HZ })),
      road, playground: this.V.plots.filter((p) => p.playground).map((p) => ({ x: (p.x0 + p.x1) / 2, z: (p.z0 + p.z1) / 2 })),
      rented: () => this.save.chalet?.id ?? null,
    };
  }

  // ------------------------------------------------------------------ the houses, the gardens, the bays
  async build() {
    const names = ['chalet_lo', 'picket_fence', 'garden_shed', 'garden_bench', 'playground', 'pine_tree', 'pine_tree2', 'garden/snowman', 'garden/sledge'];
    const [lo, fence, shed, bench, play, pine1, pine2, snowman, sledge] = await Promise.all(names.map((n) => loadGLB(n).catch(() => null)));
    const g = new THREE.Group(); g.name = 'chalet-village';
    this.scene.add(g); this.group = g;
    if (lo) this.inst = this.instance(this.modelGroup(lo), this.houses.map((h) => h.frame.matrixWorld), g, true);
    // the houses' colliders: the body, the front wall either side of the door (a gap you walk through when it's
    // open), the door leaf (moved away while open), the front steps (a top you step onto)
    const lbox = (h, x0, x1, z0, z1, extra = {}) => {
      const c = h.frame.localToWorld(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2));
      const col = { x: c.x, z: c.z, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: -h.yaw, ...extra };
      this.colliders.push(col);
      return col;
    };
    for (const h of this.houses) {
      const dz0 = DOOR.z - DOOR.w / 2, dz1 = DOOR.z + DOOR.w / 2;
      lbox(h, -HX - 0.1, HX - 0.7, -HZ - 0.1, HZ + 0.1);
      lbox(h, HX - 0.7, HX + 0.1, -HZ - 0.1, dz0);
      lbox(h, HX - 0.7, HX + 0.1, dz1, HZ + 0.1);
      h.leafCol = lbox(h, HX - 0.45, HX - 0.05, dz0, dz1);
      h.leafAt = { x: h.leafCol.x, z: h.leafCol.z };
      lbox(h, STEPS.x0, STEPS.x1, STEPS.z0, STEPS.z1, { top: h.frame.position.y + G });
      const c = h.frame.position;
      const blk = new THREE.Mesh(new THREE.BoxGeometry(2 * HX, 7.5, 2 * HZ), new THREE.MeshBasicMaterial());
      blk.visible = false; blk.position.set(c.x, c.y + 3.75, c.z); blk.rotation.y = h.yaw; g.add(blk); blk.updateMatrixWorld(true);
      this.cameraBlockers?.push(blk);
    }
    // the props, instanced per kind
    const M = (o, s = 1, sx = 1) => _m.compose(_p.set(o.x, o.y, o.z), _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, o.yaw || 0), _s.set(s * sx, s, s)).clone();
    const by = (k) => this.items.filter((i) => i.kind === k);
    for (const i of this.items) {
      if (!i.col) continue;
      if (i.kind === 'spruce' || i.kind === 'snowman') this.colliders.push({ x: i.x, z: i.z, r: i.r });
      else if (i.kind === 'bench') this.colliders.push({ x: i.x, z: i.z, hw: i.hw, hd: 0.3, rot: -i.yaw, top: i.y + 0.47 });
      else this.colliders.push({ x: i.x, z: i.z, hw: i.hw, hd: i.hd, rot: -(i.yaw || 0) });
    }
    if (fence) { const base = this.fit(fence, { size: 1.0, axis: 'y' }, FENCE_L); this.instance(base, by('fence').map((f) => M(f, 1, f.len / FENCE_L)), g); }
    if (shed) this.instance(this.fit(shed, { size: 2.2, axis: 'y' }), by('shed').map((o) => M(o)), g, true);
    if (bench) this.instance(this.fit(bench, { size: 1.6, axis: 'x' }), by('bench').map((o) => M(o)), g, true);
    if (play) this.instance(this.fit(play, { size: 3.6, axis: 'y' }), by('playground').map((o) => M(o)), g, true);
    if (snowman) this.instance(this.fit(snowman, { size: 1.5, axis: 'y' }), by('snowman').map((o) => M(o)), g, true);
    if (sledge) this.instance(this.fit(sledge, { size: 1.0, axis: 'xz' }), by('sledge').map((o) => M(o)), g, true);
    // the garden's spruces and dwarf spruces: the game's own pine models (vegetation.js's), small
    const pines = [pine1, pine2].map((p) => (p ? this.pine(p) : null));
    for (const v of [0, 1]) {
      const base = pines[v] || pines[1 - v];
      if (!base) continue;
      const list = this.items.filter((i) => (i.kind === 'spruce' || i.kind === 'shrub') && (pines[v] ? i.v === v : i.v !== v));
      this.instance(base, list.map((t) => M(t, t.h)), g, true);
    }
    this.buildStones(g, by('stone'));
    this.buildBays(g, by('bay'), by('drive'));
    this.buildSigns(g, by('sign'));
    g.updateMatrixWorld(true);
  }
  // the chalet model in the house frame (its body centred, its ground at y 0)
  modelGroup(gltf) {
    const m = gltf.scene.clone(true);
    m.scale.setScalar(S); m.position.set(-MODEL.x * S, -MODEL.y * S, -MODEL.z * S);
    const g = new THREE.Group(); g.add(m); g.updateMatrixWorld(true);
    return g;
  }
  fit(gltf, opts, len = 0) {
    const g = fitModel(gltf, opts);
    if (len) { const b = new THREE.Box3().setFromObject(g), sx = len / Math.max(0.01, b.max.x - b.min.x); g.scale.x *= sx; }
    g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g); g.position.y -= b.min.y;
    const w = new THREE.Group(); w.add(g); w.updateMatrixWorld(true);
    return w;
  }
  // a pine 1 m tall (instances scale it to their height), the forest's look: no baked glow, a touch of tint
  pine(gltf) {
    const w = this.fit(gltf, { size: 1, axis: 'y' });
    w.traverse((o) => { if (o.isMesh) { const m = o.material.clone(); if (m.emissive) m.emissive.setRGB(0, 0, 0); m.emissiveMap = null; m.metalness = 0; o.material = m; } });
    return w;
  }
  instance(base, mats, parent, shadows = false) {
    const out = [];
    if (!mats.length) return out;
    base.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, mats.length);
      const local = o.matrixWorld.clone();
      mats.forEach((Mx, i) => im.setMatrixAt(i, _m.multiplyMatrices(Mx, local)));
      im.userData.local = local; im.userData.mats = mats.map((Mx) => Mx.clone());
      im.castShadow = shadows; im.receiveShadow = true;
      im.computeBoundingSphere();
      parent.add(im); out.push(im);
    });
    return out;
  }
  // stepping stones: flat slabs of grey granite, their tops 3 cm over the snow (no coplanar faces)
  buildStones(g, list) {
    if (!list.length) return;
    const geo = new THREE.CylinderGeometry(0.27, 0.29, 0.08, 9);
    const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x8f9296, roughness: 0.9 }), list.length);
    list.forEach((s, i) => im.setMatrixAt(i, _m.compose(_p.set(s.x, s.y - 0.01, s.z), _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.spin), _s.set(1, 1, 0.8 + 0.2 * hash(i)))));
    im.receiveShadow = true; im.computeBoundingSphere(); g.add(im);
  }
  // each plot's parking (two 2.5 x 5 m bays, lines and PRIVAT painted on) and its drive to the road: draped on the
  // ground, 4 cm over it; the bay and the drive meet edge to edge (never on top of each other)
  buildBays(g, bays, drives) {
    const drape = (list, textured) => {
      const pos = [], uv = [], idx = [];
      for (const r of list) {
        const x0 = r.x0, x1 = r.x1, za = r.za, zb = r.zb, nx = Math.max(1, Math.ceil((x1 - x0) / 1)), nz = Math.max(1, Math.ceil(Math.abs(zb - za) / 1)), b = pos.length / 3;
        for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
          const x = x0 + ((x1 - x0) * i) / nx, z = za + ((zb - za) * j) / nz;
          pos.push(x, world.height(x, z) + 0.04, z);
          // uv: u across the bay, v from its road end (0) to its back (1); mirrored for the plots facing -z
          uv.push(r.out > 0 ? i / nx : 1 - i / nx, j / nz);
        }
        const flip = (zb - za) < 0;
        for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = b + j * (nx + 1) + i; if (flip) idx.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1); else idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx); geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial(textured ? { map: this.bayTexture(), roughness: 0.9 } : { color: 0x8d8a84, roughness: 0.95 });
      const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; g.add(m);
    };
    if (bays.length) drape(bays, true);
    if (drives.length) drape(drives, false);
  }
  bayTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = '#7f7d79'; x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2500; i++) { const v = 100 + Math.random() * 50; x.fillStyle = `rgba(${v},${v},${v - 4},0.35)`; x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
    // (v = 0 at the drive's end, 1 at the back: canvas y flipped) two bays side by side, white lines, PRIVAT
    x.fillStyle = 'rgba(240,240,236,0.9)';
    for (const u of [0.04, 0.5, 0.96]) x.fillRect(u * 256 - 3, 0, 6, 256 * 0.93);
    x.fillRect(0.04 * 256, 0, 0.92 * 256, 6);
    x.save(); x.translate(128, 200); x.rotate(Math.PI); x.font = 'bold 30px Arial'; x.textAlign = 'center';
    x.fillText('PRIVAT', -64 + 128, 0); x.fillText('PRIVAT', 64 - 128, 0); x.restore();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  // the "Privat" sign at each bay: a post, a white plate with the blue P and PRIVAT / Parken nur für Anwohner
  buildSigns(g, list) {
    if (!list.length) return;
    const c = document.createElement('canvas'); c.width = 256; c.height = 192;
    const x = c.getContext('2d');
    x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, 256, 192); x.strokeStyle = '#1d3f8f'; x.lineWidth = 10; x.strokeRect(5, 5, 246, 182);
    x.fillStyle = '#1d4fb8'; x.fillRect(18, 22, 88, 88); x.fillStyle = '#fff'; x.font = 'bold 80px Arial'; x.textAlign = 'center'; x.fillText('P', 62, 96);
    x.fillStyle = '#b3171d'; x.font = 'bold 44px Arial'; x.fillText('PRIVAT', 178, 80);
    x.fillStyle = '#222'; x.font = '19px Arial'; x.fillText('Parken nur für', 128, 145); x.fillText('Bewohner', 128, 170);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.BoxGeometry(0.5, 0.375, 0.02), post = new THREE.CylinderGeometry(0.025, 0.025, 1.5, 8);
    const face = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 }), edge = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
    const ip = new THREE.InstancedMesh(post, steel, list.length), iq = new THREE.InstancedMesh(plate, [edge, edge, edge, edge, face, face], list.length);
    list.forEach((s, i) => {
      ip.setMatrixAt(i, _m.compose(_p.set(s.x, s.y + 0.75, s.z), _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.yaw), _s.set(1, 1, 1)));
      iq.setMatrixAt(i, _m.compose(_p.set(s.x, s.y + 1.62, s.z), _q, _s));
    });
    for (const m of [ip, iq]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); g.add(m); }
  }

  setInstance(i, hidden) {
    if (!this.inst || i < 0) return;
    for (const im of this.inst) { im.setMatrixAt(i, hidden ? ZERO : _m.multiplyMatrices(im.userData.mats[i], im.userData.local)); im.instanceMatrix.needsUpdate = true; }
  }

  // ------------------------------------------------------------------ buying (one chalet each, yours for good)
  rented() { const id = this.save.chalet?.id; return id == null ? null : this.houses.find((h) => h.id === id) || null; }
  insideOwn() { return this.inside && !!this.current && this.current.id === this.save.chalet?.id; }
  hour() { return this.getHour?.() ?? 12; }
  canEnter(h) { return !!h && (this.rented() === h || this.viewing === h); }
  interaction(p) {
    if (!this.V || this.inside || !this.room) return null;
    for (const h of this.houses) {
      if (Math.abs(p.x - h.door.x) > 3.2 || Math.abs(p.z - h.door.z) > 3.2 || Math.hypot(p.x - h.door.x, p.z - h.door.z) > 2.6) continue;
      const mine = this.rented();
      if (this.canEnter(h) && this.roomAt === this.houses.indexOf(h)) {
        const shut = Math.abs(this.room.front.target) < 0.01;
        return { label: shut ? `Open the door (${mine === h ? 'your chalet' : h.name})` : 'Close the door', act: () => this.room.front.toggle(9, 0) };
      }
      if (mine === h || this.viewing === h) return null; // (the interior is on its way there)
      if (mine) return { label: `${h.name} · you already own ${mine.name}`, act: () => this.hud?.flash(`One chalet each: you already own ${mine.name}`, 'bad', 2400) };
      return (h._buy ||= { label: `${h.name} for sale · $${CHALET_PRICE.toLocaleString('en-US')}`, act: () => this.offer(h) });
    }
    return null;
  }
  offer(h) {
    const say = 'A two-storey chalet in Almdorf: entrance hall, open living room and kitchen, two bathrooms and three bedrooms under the roof, a garden and its own parking. It comes empty: furnish it as you like. Yours for good.';
    this.hud.dialog(`${h.name} · Almdorf`, say, [
      { label: 'Buy this chalet', sub: 'Yours for good', price: `$${CHALET_PRICE.toLocaleString('en-US')}`, act: () => this.buy(h) },
      { label: 'Have a look inside', sub: 'The door is open', act: () => { this.viewing = h; this.openFor(h); } },
      { label: 'Not now' },
    ], { kicker: `Chalet village · $${CHALET_PRICE.toLocaleString('en-US')}` });
  }
  buy(h) {
    if (this.rented()) return;
    if (!this.spend(CHALET_PRICE)) return;
    const old = this.save.chalet;
    this.save.chalet = { id: h.id, name: h.name, owned: true, rented: true, since: this.save.day ?? 1, furniture: old?.furniture || [], plan: 2 };
    this.writeSave();
    this.hud.flash(`${h.name} is yours · walk in through the front door`, 'good', 3400);
    if (this.inside && this.current === h) return;
    this.openFor(h);
  }
  openFor(h) { const i = this.houses.indexOf(h); this.placeRoom(i); this.room.front.target = this.room.front.inward; this.audio?.play?.('click'); }

  // ------------------------------------------------------------------ the interior at a chalet; walking in and out
  placeRoom(i) {
    if (i === this.roomAt) return;
    this.roomAt = i;
    if (i < 0) { this.room.setVisible(false); return; }
    const h = this.houses[i];
    this.room.place(h.frame);
    for (const d of this.room.doors) { d.target = 0; d.angle = 0; d.update(0); } // (a fresh house: every door shut)
  }
  enter(h) { // (seamless: you crossed the threshold)
    const lp = h.frame.worldToLocal(_l.copy(this.player.pos));
    this.current = h; this.inside = true;
    this.room.enter(lp.x, lp.z, -Math.PI / 2, this.camera);
    this.player.frozen = true;
    this.rigWas = [this.player.rig?.root, this.player.rig?.gear].filter(Boolean).map((o) => [o, o.visible]);
    for (const [o] of this.rigWas) o.visible = false;
    this.getPost().setView(this.scene, this.room.camera);
    const ch = document.getElementById('crosshair'); if (ch) ch.hidden = false;
  }
  leave(now = false) {
    if (!this.inside) return;
    const h = this.current, r = this.room;
    this.inside = false; r.leave();
    for (const [o, v] of this.rigWas || []) o.visible = v;
    this.current = null;
    this.getPost().setView(this.scene, this.camera);
    const ch = document.getElementById('crosshair'); if (ch) ch.hidden = true;
    this.player.frozen = false;
    if (!h) return;
    // out on the steps where you walked out (or, leaving abruptly: at the door)
    const z = now ? DOOR.z : Math.max(DOOR.z - DOOR.w / 2 + 0.3, Math.min(DOOR.z + DOOR.w / 2 - 0.3, r.pos.z));
    const w = h.frame.localToWorld(_l.set(HX + 0.75, 0, z)), f = h.out, heading = Math.atan2(f.x, f.z);
    this.player.teleport(w.x, w.z, heading, h.frame.position.y + G);
    this.player.camYaw = heading + Math.PI;
    this.player.camPitch = -0.12;
  }
  /** Inside, per frame (main.js): walking, the doors. Returns the prompt target. */
  frame(dt, input, sensitivity) {
    const r = this.room;
    this.target = r.update(dt, input, sensitivity);
    if (this.target && input?.hit?.('KeyE')) { this.audio?.play?.('click'); r.use(this.target); }
    r.tick(dt, _l.set(r.pos.x, r.eyeY, r.pos.z), this.hour());
    this.syncLeaf();
    // the front door closes behind you once you're in; out through it: back in the world
    const d = r.doorAt;
    if (r.front.target !== 0 && Math.hypot(r.pos.x - d.x, r.pos.z - (d.z0 + d.z1) / 2) > 2.6) r.front.target = 0;
    if (r.outFront(r.pos) && r.pos.x > HX - 0.2) this.leave();
    return this.target;
  }
  roomName() { return this.inside ? `${this.current?.name || 'Chalet'} · ${this.room.roomName()}` : ''; }
  // the front door's outside collider: out of the way while the door is open
  syncLeaf() {
    const h = this.houses[this.roomAt];
    for (const x of this.houses) if (x.leafCol && x !== h) { x.leafCol.x = x.leafAt.x; x.leafCol.z = x.leafAt.z; }
    if (!h?.leafCol) return;
    const open = this.room.front.open || Math.abs(this.room.front.target) > 0.01;
    h.leafCol.x = open ? 1e9 : h.leafAt.x; h.leafCol.z = open ? 1e9 : h.leafAt.z;
  }

  /** Per frame, outside: the full-detail model and the interior on the chalet you're nearest; its door. */
  update(dt = 0.016) {
    if (!this.V || !this.room) return;
    if (this.inside) { this.updateHi(); return; }
    const p = this.player?.pos;
    if (!p) return;
    this.updateHi();
    const i = this.hiAt, h = this.houses[i];
    // the interior stands in the chalet you're at (it shows once you're near its door)
    if (h && Math.hypot(p.x - h.frame.position.x, p.z - h.frame.position.z) < 40) this.placeRoom(i);
    const R = this.houses[this.roomAt], near = R ? Math.hypot(p.x - R.door.x, p.z - R.door.z) : 1e9;
    this.room.setVisible(!!R && near < 22);
    this.cutDoor(!!R && near < 22);
    if (!R) return;
    const lp = R.frame.worldToLocal(_l.copy(p));
    const f = this.room.front;
    if (this.canEnter(R)) {
      // walking into the door opens it
      if (Math.abs(f.target) < 0.01 && lp.x > HX - 0.3 && lp.x < HX + 1.1 && Math.abs(lp.z - DOOR.z) < DOOR.w / 2 + 0.2 && Math.hypot(this.player.vel?.x || 0, this.player.vel?.z || 0) > 0.3) f.target = f.inward;
      // through the open door: in
      if (f.open && lp.x < HX - 0.25 && Math.abs(lp.z - DOOR.z) < DOOR.w / 2) { this.enter(R); return; }
      // walked away: it closes
      if (Math.abs(f.target) > 0.01 && near > 6) f.target = 0;
    } else if (Math.abs(f.target) > 0.01 && near > 6) f.target = 0;
    if (this.viewing && this.viewing !== R && near > 30) this.viewing = null;
    this.room.tick(dt, this.room.house.visible ? lp.setY(lp.y + 1.6) : null, this.hour());
    this.syncLeaf();
  }
  updateHi() {
    const p = this.inside ? this.current.frame.position : this.player?.pos;
    if (!p || !this.inst) return;
    const b = this.V.bounds;
    let best = -1;
    if (this.inside) best = this.houses.indexOf(this.current);
    else if (p.x > b.minx - 80 && p.x < b.maxx + 80 && p.z > b.minz - 80 && p.z < b.maxz + 80) {
      let bd = 70;
      this.houses.forEach((h, i) => { const d = Math.hypot(p.x - h.frame.position.x, p.z - h.frame.position.z); if (d < bd) { bd = d; best = i; } });
    }
    if (best === this.hiAt) return;
    if (best >= 0 && !this.hiModel) {
      if (!this.hiLoading) this.hiLoading = loadGLB('chalet').then((gl) => { this.hiModel = gl ? this.modelGroup(gl) : null; }).catch(() => null);
      return;
    }
    if (this.hiAt >= 0) this.setInstance(this.hiAt, false);
    this.hiAt = best;
    if (best < 0) { if (this.hi) this.hi.visible = false; return; }
    if (!this.hi) this.makeHi();
    const h = this.houses[best];
    this.hi.visible = true;
    this.hi.position.copy(h.frame.position); this.hi.quaternion.copy(h.frame.quaternion); this.hi.updateMatrixWorld(true);
    this.cut.inv.value.copy(this.hi.matrixWorld).invert();
    this.setInstance(best, true);
  }
  // the full model, with a second set of materials for when the interior is in it: only its outward faces, and its
  // painted front door cut away (the interior's real door stands in the opening)
  makeHi() {
    this.hi = this.hiModel; this.group.add(this.hi);
    this.cut = { inv: { value: new THREE.Matrix4() }, min: { value: new THREE.Vector3(DOOR_CUT.x0, G + 0.03, DOOR_CUT.z0) }, max: { value: new THREE.Vector3(DOOR_CUT.x1, G + DOOR.h + 0.04, DOOR_CUT.z1) } };
    const cut = this.cut;
    this.hi.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      const m = o.material.clone();
      m.side = THREE.FrontSide;
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uCutInv = cut.inv; sh.uniforms.uCutMin = cut.min; sh.uniforms.uCutMax = cut.max;
        sh.vertexShader = 'uniform mat4 uCutInv;\nvarying vec3 vCutP;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n vCutP = (uCutInv * modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = 'uniform vec3 uCutMin;\nuniform vec3 uCutMax;\nvarying vec3 vCutP;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n if (all(greaterThan(vCutP, uCutMin)) && all(lessThan(vCutP, uCutMax))) discard;');
      };
      m.customProgramCacheKey = () => 'chaletDoorCut';
      o.userData.mats = [o.material, m];
    });
  }
  cutDoor(on) {
    if (!this.hi || this.cutOn === on) return;
    this.cutOn = on;
    this.hi.traverse((o) => { if (o.userData.mats) o.material = o.userData.mats[on ? 1 : 0]; });
  }
}
