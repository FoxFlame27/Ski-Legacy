// THE CHALET VILLAGE (Almdorf): ~26 two-storey chalets (the user's Meshy chalet: white plaster below, timber above,
// snowy roofs) in terraced rows up the gentle forested slope north of Legacy Village, along the Chaletweg (its layout,
// its ground and its road: game/bus/chaletroad.js, part of busRoads). Each chalet has its own parking bay and drive
// off the road, a picket fence along its front, some a garden shed or a bench; the playground on a plot of its own.
// The forest round it is the game's own (world/vegetation.js; chaletroad.js clears the pads, thickens the banks).
// Cheap: the chalets are one instanced low-poly mesh (chalet_lo.glb, 24k triangles), the full model (chalet.glb)
// only on the one you stand nearest; the props instanced too.
// RENT A CHALET: E at any chalet's front door: rent it by the night ($100-$230 a night, dearer higher up the slope
// with the view, a shed or a bench; pay 1, 3 or 7 nights up front; checkout at noon on the day after the last night;
// one chalet at a time, kept in the save: save.chalet = { id, name, rented, since, until (save.day), nightly,
// furniture }; when the stay runs out the chalet is given back, save.chalet keeps only the furniture). Only your chalet opens (E: in, game/chaletroom.js, the one
// shared interior, its windows on the real world from where that chalet stands); the others offer to be rented
// (renting another gives the old one up: your furniture moves with you, every chalet is the same house).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { layout } from '../world/layout.js';
import { busRoads } from './bus/roads.js';
import { loadGLB, fitModel } from '../core/assets.js';
import { HX, HZ, DOOR, NIGHT } from './chaletplan.js';
import { ChaletRoom, setChaletInterior } from './chaletroom.js';

// the model's body (chalet.glb, scene units, measured): x -0.17..0.61 (the door's side +x), z -0.88..0.31, ground y -0.40
const BODY = { x: 0.22, z: -0.285, y: -0.40, len: 1.19 };
const S = (2 * HZ) / BODY.len;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class Chalets {
  constructor(o) {
    // o: scene, renderer, colliders, cameraBlockers, hud, audio, save, writeSave, spend, transition, player, getPost
    Object.assign(this, o);
    this.V = busRoads.chalets;
    this.inside = false; this.current = null; this.target = null;
    this.houses = []; this.hiAt = -1; this.hiddenId = -1;
    if (!this.V) return;
    this.plan();
    this.room = new ChaletRoom({ renderer: o.renderer });
    setChaletInterior(this.room, this);
    this.ready = this.build().catch((e) => console.warn('chalet village', e));
  }

  // ------------------------------------------------------------------ where everything stands
  plan() {
    let n = 0;
    for (const p of this.V.plots) {
      if (p.playground) continue;
      const frame = new THREE.Object3D();
      frame.position.set(p.house.x, p.y, p.house.z); frame.rotation.y = -Math.PI / 2 + p.house.yaw; // (+x, the door, downhill)
      frame.updateMatrixWorld(true);
      const door = frame.localToWorld(new THREE.Vector3(HX + 1.1, 0, DOOR.z));
      const out = new THREE.Vector3(1, 0, 0).applyQuaternion(frame.quaternion);
      const nightly = Math.round((NIGHT + p.row * 35 + (p.shed ? 15 : 0) + (p.bench ? 10 : 0)) / 5) * 5; // (the view higher up, the garden)
      this.houses.push({ id: p.id, name: `Chalet ${++n}`, plot: p, frame, door, out, yaw: frame.rotation.y, nightly });
    }
    // where the objective points (the trail map draws the village from this too)
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

  // ------------------------------------------------------------------ the houses, the props, the bays
  async build() {
    const [lo, fence, shed, bench, play] = await Promise.all(['chalet_lo', 'picket_fence', 'garden_shed', 'garden_bench', 'playground'].map((n) => loadGLB(n).catch(() => null)));
    const g = new THREE.Group(); g.name = 'chalet-village';
    this.scene.add(g); this.group = g;
    // the chalets: the model, scaled and its body centred on the house frame (ground at y 0)
    if (lo) {
      const base = this.modelGroup(lo);
      this.inst = this.instance(base, this.houses.map((h) => h.frame.matrixWorld), g, true);
    }
    for (const h of this.houses) {
      const c = h.frame.position;
      this.colliders.push({ x: c.x, z: c.z, hw: HX + 0.15, hd: HZ + 0.15, rot: -h.yaw });
      const blk = new THREE.Mesh(new THREE.BoxGeometry(2 * HX, 7.5, 2 * HZ), new THREE.MeshBasicMaterial());
      blk.visible = false; blk.position.set(c.x, c.y + 3.75, c.z); blk.rotation.y = h.yaw; g.add(blk); blk.updateMatrixWorld(true);
      this.cameraBlockers?.push(blk);
    }
    // the props
    const M = (x, y, z, yaw, s = 1) => _m.compose(_p.set(x, y, z), _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw), _s.set(s, s, s)).clone();
    const fences = [], sheds = [], benches = [], plays = [];
    const FL = 1.6; // m: one fence section
    for (const p of this.V.plots) {
      const zf = p.z1 - 0.6, gap = [p.drive.x - 2.4, p.drive.x + 2.4];
      for (let x = p.x0 + 0.2; x + FL <= p.x1 - 0.2 + 1e-6; x += FL) {
        if (x + FL > gap[0] && x < gap[1]) continue;
        const xm = x + FL / 2;
        fences.push(M(xm, world.height(xm, zf), zf, 0));
      }
      // (a fence run's collider: one box per stretch between the gaps)
      const runs = [[p.x0 + 0.2, gap[0]], [gap[1], p.x1 - 0.2]];
      for (const [a, b] of runs) if (b - a > 1) this.colliders.push({ x: (a + b) / 2, z: zf, hw: (b - a) / 2, hd: 0.1, rot: 0 });
      if (p.playground) {
        const x = (p.x0 + p.x1) / 2, z = (p.z0 + p.z1) / 2 - 2;
        plays.push(M(x, world.height(x, z), z, 0));
        this.colliders.push({ x, z, hw: 2.4, hd: 2.1, rot: 0 });
        for (const dx of [-7, 7]) { const bz = p.z1 - 3; benches.push(M(x + dx, world.height(x + dx, bz), bz, Math.PI)); this.colliders.push({ x: x + dx, z: bz, r: 0.7 }); }
        continue;
      }
      if (p.shed) { const x = p.park.x, z = p.z0 + 3.5; sheds.push(M(x, world.height(x, z), z, 0)); this.colliders.push({ x, z, hw: 1.6, hd: 1.7, rot: 0 }); }
      if (p.bench) { const x = p.house.x + (p.mirror ? 3.2 : -3.2), z = p.house.z + HX + 2.6; benches.push(M(x, world.height(x, z), z, 0)); this.colliders.push({ x, z, r: 0.7 }); }
    }
    if (fence) this.instance(this.fit(fence, { size: 1.0, axis: 'y' }, FL), fences, g);
    if (shed) this.instance(this.fit(shed, { size: 2.4, axis: 'y' }), sheds, g, true);
    if (bench) this.instance(this.fit(bench, { size: 1.6, axis: 'x' }), benches, g);
    if (play) this.instance(this.fit(play, { size: 3.6, axis: 'y' }), plays, g, true);
    this.buildBays(g);
    g.updateMatrixWorld(true);
  }
  // the chalet model in the house frame (a group: its meshes' matrices are what the instances use)
  modelGroup(gltf) {
    const m = gltf.scene.clone(true);
    m.scale.setScalar(S); m.position.set(-BODY.x * S, -BODY.y * S, -BODY.z * S);
    const g = new THREE.Group(); g.add(m); g.updateMatrixWorld(true);
    return g;
  }
  // a prop fitted to size; `len`: stretched along x to this length (the fence sections)
  fit(gltf, opts, len = 0) {
    const g = fitModel(gltf, opts);
    if (len) { const b = new THREE.Box3().setFromObject(g), sx = len / Math.max(0.01, b.max.x - b.min.x); g.scale.x *= sx; }
    // stand it on y 0
    g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g); g.position.y -= b.min.y;
    const w = new THREE.Group(); w.add(g); w.updateMatrixWorld(true);
    return w;
  }
  // one InstancedMesh per mesh of `base`, an instance per matrix
  instance(base, mats, parent, shadows = false) {
    const out = [];
    if (!mats.length) return out;
    base.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, mats.length);
      const local = o.matrixWorld.clone();
      mats.forEach((M, i) => im.setMatrixAt(i, _m.multiplyMatrices(M, local)));
      im.userData.local = local; im.userData.mats = mats.map((M) => M.clone());
      im.castShadow = shadows; im.receiveShadow = true;
      im.computeBoundingSphere();
      parent.add(im); out.push(im);
    });
    return out;
  }
  // each plot's parking bay and drive (packed snow over gravel), and the path to the door: laid on the ground
  buildBays(g) {
    const pos = [], col = [], idx = [];
    const c0 = new THREE.Color(0x8d8a84), c1 = new THREE.Color(0xc9ccd0);
    const rect = (x0, z0, x1, z1, c) => {
      const nx = Math.max(1, Math.ceil((x1 - x0) / 1)), nz = Math.max(1, Math.ceil((z1 - z0) / 1)), b = pos.length / 3;
      for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * j) / nz;
        pos.push(x, world.height(x, z) + 0.05, z); col.push(c.r, c.g, c.b);
      }
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = b + j * (nx + 1) + i; idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
    };
    for (const p of this.V.plots) {
      if (p.playground) continue;
      const leg = p.legZ;
      rect(p.park.x - 1.9, p.park.z - 3.4, p.park.x + 1.9, leg - 4.2, c0); // (the bay and its drive down to the road's edge)
      const dx = p.house.x + 0.25 * (p.mirror ? -1 : 1), zd = p.house.z + HX;
      rect(Math.min(dx, p.park.x) - 0.7, zd + 0.2, Math.max(dx, p.park.x) + 0.7, zd + 1.6, c1); // (the path along the front)
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    m.receiveShadow = true; g.add(m);
  }

  // one instance hidden (the one you're in, or the one the full model stands on)
  setInstance(i, hidden) {
    if (!this.inst || i < 0) return;
    for (const im of this.inst) { im.setMatrixAt(i, hidden ? ZERO : _m.multiplyMatrices(im.userData.mats[i], im.userData.local)); im.instanceMatrix.needsUpdate = true; }
  }

  // ------------------------------------------------------------------ renting (by the night)
  rented() { this.expire(); const id = this.save.chalet?.id; return id == null ? null : this.houses.find((h) => h.id === id) || null; }
  insideOwn() { return this.inside && !!this.current && this.current.id === this.save.chalet?.id; }
  hour() { return this.getHour?.() ?? 12; }
  /** Nights left on your stay (0 on the last morning, before checkout at noon). */
  nightsLeft() { const c = this.save.chalet; return c?.until == null ? 0 : Math.max(0, c.until - (this.save.day ?? 1)); }
  // the stay over (checkout at noon on the day after the last night): the chalet goes back, the furniture is kept
  expire() {
    const c = this.save.chalet;
    if (!c || c.id == null || c.until == null || this.inside) return;
    const day = this.save.day ?? 1;
    if (day > c.until || (day === c.until && this.hour() >= 12)) {
      this.save.chalet = { furniture: c.furniture || [], last: c.id, lastName: c.name };
      this.writeSave();
      this.hud?.flash(`Your stay at ${c.name} is over · rent a chalet again to go back in`, 'bad', 3600);
    }
  }
  interaction(p) {
    if (!this.V || this.inside || !this.room) return null;
    for (const h of this.houses) {
      if (Math.abs(p.x - h.door.x) > 3 || Math.abs(p.z - h.door.z) > 3 || Math.hypot(p.x - h.door.x, p.z - h.door.z) > 2.4) continue;
      if (this.rented() === h) {
        const n = this.nightsLeft();
        return { label: `Enter your chalet (${h.name} · ${n ? `${n} night${n > 1 ? 's' : ''} left` : 'checkout at noon'})`, act: () => (n ? this.enter(h) : this.offer(h)) };
      }
      return (h._rent ||= { label: `Rent this chalet · $${h.nightly} / night`, act: () => this.offer(h) });
    }
    return null;
  }
  offer(h) {
    const own = this.rented() === h, old = own ? null : this.rented();
    const say = own
      ? `Your stay at ${h.name} ends at noon today. Stay longer?`
      : `A two-storey chalet in Almdorf: entrance hall, open living room and kitchen, two bathrooms and three bedrooms under the roof, its own parking bay. It comes empty: furnish it as you like. $${h.nightly} a night, paid up front; checkout at noon.${old ? ` Renting it gives up ${old.name} (your furniture moves with you).` : ''}`;
    const opts = [1, 3, 7].map((n) => ({ label: `${own ? 'Stay' : 'Rent'} ${n} night${n > 1 ? 's' : ''}`, sub: `$${(n * h.nightly).toLocaleString('en-US')} · $${h.nightly} / night`, price: `$${(n * h.nightly).toLocaleString('en-US')}`, act: () => this.rent(h, n) }));
    if (own) opts.push({ label: 'Go in', sub: 'until noon', act: () => this.enter(h) });
    opts.push({ label: 'Not now' });
    this.hud.dialog(`${h.name} · Almdorf`, say, opts, { kicker: `Chalet village · $${h.nightly} / night` });
  }
  rent(h, nights) {
    if (!this.spend(nights * h.nightly)) return;
    const old = this.save.chalet, day = this.save.day ?? 1, same = old?.id === h.id && old.until != null;
    // nights from tonight (or on from the stay you have there)
    const until = (same ? Math.max(old.until, day) : day) + nights;
    this.save.chalet = { id: h.id, name: h.name, rented: true, since: same ? old.since : day, until, nightly: h.nightly, furniture: old?.furniture || [] };
    this.writeSave();
    this.hud.flash(same ? `${h.name}: your stay runs to noon on day ${until}` : `${h.name} is yours for ${nights} night${nights > 1 ? 's' : ''} · E at its door to go in`, 'good', 3400);
  }

  // ------------------------------------------------------------------ in and out
  enter(h) {
    if (this.inside || this.transition.active) return;
    this.player.frozen = true;
    this.audio?.play?.('click');
    this.transition.fade(() => {
      this.current = h; this.inside = true;
      this.hiddenId = this.houses.indexOf(h);
      this.setInstance(this.hiddenId, true);
      this.room.setWorld({ scene: this.scene, frame: h.frame, hide: () => [this.player.rig?.root, this.player.rig?.gear, this.hi] });
      this.room.enter();
      this.getPost().setView(this.room.scene, this.room.camera);
      document.getElementById('crosshair').hidden = false;
    });
  }
  leave(now = false) {
    if (!this.inside) return;
    const h = this.current;
    const out = () => {
      this.inside = false; this.room.leave();
      if (this.hiddenId !== this.hiAt) this.setInstance(this.hiddenId, false);
      this.hiddenId = -1; this.current = null;
      this.getPost().setView(this.scene, this.camera);
      document.getElementById('crosshair').hidden = true;
      this.player.frozen = false;
      if (now || !h) return;
      const f = h.out;
      this.player.teleport(h.door.x + f.x * 0.6, h.door.z + f.z * 0.6, Math.atan2(f.x, f.z));
      this.player.camYaw = Math.atan2(f.x, f.z) + Math.PI + 0.3;
      this.player.camPitch = -0.12;
    };
    if (now) out(); else { this.audio?.play?.('click'); this.transition.fade(out); }
  }
  /** Inside, per frame (main.js): walking, the front door. Returns the prompt target. */
  frame(dt, input, sensitivity) {
    this.target = this.room.update(dt, input, sensitivity);
    if (this.target && input?.hit?.('KeyE')) { this.audio?.play?.('click'); this.leave(); }
    return this.target;
  }
  roomName() { return this.inside ? `${this.current?.name || 'Chalet'} · ${this.room.roomName()}` : ''; }

  /** Per frame, outside: the full-detail model on the chalet you're nearest (within 70 m). */
  update() {
    if (this.V && (this._ex = (this._ex || 0) + 1) % 60 === 0) this.expire(); // (the stay's checkout)
    if (!this.inst || this.inside) return;
    const p = this.player?.pos;
    if (!p) return;
    const b = this.V.bounds;
    let best = -1;
    if (p.x > b.minx - 80 && p.x < b.maxx + 80 && p.z > b.minz - 80 && p.z < b.maxz + 80) {
      let bd = 70;
      this.houses.forEach((h, i) => { const d = Math.hypot(p.x - h.frame.position.x, p.z - h.frame.position.z); if (d < bd) { bd = d; best = i; } });
    }
    if (best === this.hiAt) return;
    if (best >= 0 && !this.hiModel) { // (the full model: loaded the first time you come near)
      if (!this.hiLoading) this.hiLoading = loadGLB('chalet').then((gl) => { this.hiModel = gl ? this.modelGroup(gl) : null; }).catch(() => null);
      return;
    }
    if (this.hiAt >= 0) this.setInstance(this.hiAt, false);
    this.hiAt = best;
    if (best < 0) { if (this.hi) this.hi.visible = false; return; }
    if (!this.hi) { this.hi = this.hiModel; this.hi.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } }); this.group.add(this.hi); }
    const h = this.houses[best];
    this.hi.visible = true;
    this.hi.position.copy(h.frame.position); this.hi.quaternion.copy(h.frame.quaternion); this.hi.updateMatrixWorld(true);
    this.setInstance(best, true);
  }
}
