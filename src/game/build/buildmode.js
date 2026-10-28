// Chalet BUILD MODE: inside your rented chalet press F to furnish it. A furniture catalog opens on the
// right (src/ui/buildmenu.js) while you keep walking; the selected item follows your gaze as a blue
// blueprint ghost (red when it doesn't fit), snapping to a 0.25 m grid and flush against walls.
// Click / Enter buys and places the real Meshy model (with a collider) and saves it to
// save.chalet.furniture = [{ id, x, y, z, rot }] (coordinates in the interior root's local space).
// Q picks a placed piece up to move it, X sells it back for half its price.
//
// It talks to the chalet module only through ./chaletadapter.js (see the interface documented there).
// main.js calls buildMode.update(dt, input) every frame; that also discovers the chalet API.
import * as THREE from 'three';
import { FURNITURE_BY_ID, SELL_REFUND } from './catalog.js';
import { loadFurniture, makeFurnitureObject, renderThumbs } from './furniture.js';
import { makeGhost } from './blueprint.js';
import { snap, corners, onFloor, pointOnFloor, boxesOverlap, boxHitsWall, snapToWalls, rayWall, GRID } from './placement.js';
import { adaptChalet, currentRawAPI, discoverChaletAPI } from './chaletadapter.js';
import { BuildMenu } from '../../ui/buildmenu.js';

const REACH = 6; // metres you can place from
const RAD = Math.PI / 180;
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Footprint + vertical extent of an item at a base position (see makeFurnitureObject's local frame). */
function footprint(item, dims, x, y, z, rot) {
  let cx = x, cz = z;
  if (item.place === 'wall') { cx += Math.sin(rot) * dims.z / 2; cz += Math.cos(rot) * dims.z / 2; }
  const y0 = item.place === 'ceiling' ? y - dims.y : y;
  return { x: cx, z: cz, hw: dims.x / 2, hd: dims.z / 2, rot, y0, y1: y0 + dims.y };
}

export class BuildMode {
  constructor({ save, writeSave, spend, hud, audio, input }) {
    Object.assign(this, { save, writeSave, spend, hud, audio, input });
    this.on = false;
    this.chalet = null; // normalised chalet interior (chaletadapter.js)
    this.wasActive = false;
    this.placed = []; // { rec, item, obj, handle, fp }
    this.loadedRoot = null;
    this.item = null; // catalog item in hand
    this.moving = null; // placed entry being moved (no charge)
    this.ghost = null;
    this.ghostToken = 0;
    this.rot = 0;
    this.pose = null; // { x, y, z, rot, fp, valid, reason, host }
    this.rHeld = { wheeled: false };
    this.menu = null;
    this.hover = null;
    this.hoverBox = null;
    this.raycaster = new THREE.Raycaster();
    this.lastMoney = -1;
    this.queued = { click: false, cancel: false };
    discoverChaletAPI();
    addEventListener('mousedown', (e) => {
      if (!this.on || !document.pointerLockElement) return;
      if (e.button === 0) this.queued.click = true;
      if (e.button === 2) this.queued.cancel = true;
    });
    addEventListener('contextmenu', (e) => { if (this.on) e.preventDefault(); });
  }

  get furniture() {
    this.save.chalet ??= {};
    return (this.save.chalet.furniture ??= []);
  }

  /** Explicitly attach a chalet interior API (optional: it is also discovered automatically). */
  attach(raw) { this.rawAPI = raw; this.chalet = adaptChalet(raw); }

  /** One-line HUD objective while inside the chalet (null when not inside). */
  hudLine() {
    if (!this.chalet || !this.wasActive) return null;
    if (!this.on) return 'Press F to furnish your chalet';
    if (this.moving) return `Moving ${this.item.name} · click to drop`;
    if (this.item) return `${this.item.name} · $${this.item.price.toLocaleString('en-US')} · click to buy`;
    return 'Build mode · pick furniture on the right';
  }

  /** Called by main.js every frame. */
  update(dt, input = this.input) {
    const raw = currentRawAPI();
    if (raw && raw !== this.rawAPI) this.attach(raw);
    this.tick(dt, input);
  }

  tick(dt, input) {
    const c = this.chalet;
    const active = !!c?.active() && !!c.root;
    if (active && c.root !== this.loadedRoot) this.loadPlaced();
    if (!active) { if (this.wasActive) this.setOn(false); this.wasActive = false; return; }
    this.wasActive = true;
    if (input.hit('KeyF')) this.setOn(!this.on);
    if (!this.on) return;
    if (this.save.money !== this.lastMoney) { this.lastMoney = this.save.money; this.menu.setMoney(this.save.money); }

    // browse / rotate
    const wheel = input.enabled ? input.wheel : 0;
    const fine = input.down('KeyR') || input.down('ShiftLeft') || input.down('ShiftRight');
    if (wheel) {
      if (fine && this.item) { this.rot += Math.sign(wheel) * 15 * RAD; this.rHeld.wheeled = true; }
      else if (!this.moving) this.menu.step(Math.sign(wheel));
    }
    if (input.hit('KeyR')) this.rHeld.wheeled = false;
    if (input.up('KeyR') && !this.rHeld.wheeled && this.item) this.rot += (input.down('ShiftLeft') ? -90 : 90) * RAD;
    if (!this.moving) {
      if (input.hit('ArrowDown')) this.menu.step(1);
      if (input.hit('ArrowUp')) this.menu.step(-1);
      if (input.hit('ArrowRight')) this.menu.stepCategory(1);
      if (input.hit('ArrowLeft')) this.menu.stepCategory(-1);
    }

    this.updateGhost(dt);
    this.updateHover();

    const click = this.queued.click || input.hit('Enter') || input.hit('NumpadEnter');
    const cancel = this.queued.cancel || input.hit('Backspace');
    this.queued.click = this.queued.cancel = false;
    if (cancel) this.cancel();
    else if (click && this.item) this.placeHere();
    if (input.hit('KeyX') && this.hover) this.sell(this.hover);
    if (input.hit('KeyQ') && this.hover && !this.moving) this.pickUp(this.hover);
  }

  setOn(on) {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      this.menu ??= new BuildMenu({ onSelect: (item) => this.hold(item) });
      this.lastMoney = -1;
      this.menu.show(true);
      this.menu.status('');
      renderThumbs((id, url) => this.menu?.setThumb(id, url)); // lazily, the first time
      this.audio?.play('click');
    } else {
      if (this.moving) this.cancel();
      this.menu?.select(-1);
      this.menu?.show(false);
      this.hold(null);
      this.setHover(null);
    }
  }

  // ------------------------------------------------------------ ghost
  hold(item) {
    if (this.ghost) { this.ghost.group.parent?.remove(this.ghost.group); this.ghost.dispose(); this.ghost = null; }
    this.item = item;
    this.pose = null;
    const token = ++this.ghostToken;
    if (!item) return;
    if (!this.moving) this.rot = this.rot || 0;
    const make = (gltf) => {
      if (token !== this.ghostToken || !this.chalet?.root) return;
      if (this.ghost) { this.ghost.group.parent?.remove(this.ghost.group); this.ghost.dispose(); }
      this.ghost = makeGhost(makeFurnitureObject(item, gltf));
      this.ghost.dims = this.ghost.group.userData.dims;
      this.chalet.root.add(this.ghost.group);
    };
    make(null); // a box at once, the model when it has loaded
    loadFurniture(item.id).then((g) => { if (g) make(g); });
  }

  cameraRayLocal() {
    const cam = this.chalet.camera, root = this.chalet.root;
    if (!cam) return null;
    cam.getWorldPosition(_o);
    cam.getWorldDirection(_d);
    root.updateMatrixWorld();
    _m.copy(root.matrixWorld).invert();
    _o.applyMatrix4(_m);
    _d.transformDirection(_m);
    return { o: _o, d: _d };
  }

  currentStorey(storeys) {
    const pp = this.chalet.playerPos();
    let y = pp ? this.chalet.root.worldToLocal(_p.copy(pp)).y : this.cameraRayLocal()?.o.y - 1.6;
    let best = storeys[0];
    for (const s of storeys) if (s.floorY <= y + 0.5 && (!best || s.floorY > best.floorY || best.floorY > y + 0.5)) best = s;
    return best;
  }

  updateGhost(dt) {
    if (!this.ghost || !this.item) return;
    this.ghost.tick(dt);
    const ray = this.cameraRayLocal();
    const storeys = this.chalet.storeys();
    if (!ray || !storeys.length) return;
    const st = this.currentStorey(storeys);
    const item = this.item, dims = this.ghost.dims;
    const walls = (st.walls || []);
    const { o, d } = ray;
    const hl = Math.hypot(d.x, d.z) || 1e-6;
    let x, y, z, rot = this.rot, host = null, reason = '';

    if (item.place === 'wall') {
      y = st.floorY + (item.mount ?? 1.2);
      const hit = rayWall(o.x, o.z, d.x / hl, d.z / hl, walls.filter((w) => w.y0 <= y && w.y1 >= y + dims.y), REACH);
      if (hit) {
        host = hit.wall;
        const L = hit.L, s = Math.min(L, Math.max(0, snap(hit.s * L)));
        const tx = (host.bx - host.ax) / L, tz = (host.bz - host.az) / L, off = (host.t || 0.2) / 2;
        x = host.ax + tx * s + hit.nx * off; z = host.az + tz * s + hit.nz * off;
        rot = Math.atan2(hit.nx, hit.nz);
      } else {
        x = o.x + (d.x / hl) * 2; z = o.z + (d.z / hl) * 2; reason = 'Aim at a wall';
      }
    } else {
      const planeY = item.place === 'ceiling' && d.y > 0.05 ? st.ceilingY : st.floorY;
      let t = Math.abs(d.y) > 0.05 ? (planeY - o.y) / d.y : -1;
      if (t < 0 || t * hl > REACH) t = Math.min(REACH, 2.5) / hl; // looking level/away: hold it in front
      x = snap(o.x + d.x * t); z = snap(o.z + d.z * t);
      y = item.place === 'ceiling' ? (st.ceilingAt?.(x, z) ?? st.ceilingY) : st.floorY;
    }

    let fp = footprint(item, dims, x, y, z, rot);
    if (item.place !== 'wall' && !item.flat) {
      snapToWalls(fp, walls.filter((w) => w.y0 < fp.y1 && w.y1 > fp.y0));
      x = fp.x; z = fp.z;
    }
    if (!reason) reason = this.misfit(item, fp, walls, host, st);
    this.pose = { x, y, z, rot, fp, valid: !reason, reason };
    this.ghost.group.position.set(x, y, z);
    this.ghost.group.rotation.set(0, rot, 0);
    this.ghost.setValid(!reason);
    this.menu.status(reason || (this.moving ? 'Click to drop it here' : `Click to buy · $${item.price.toLocaleString('en-US')}`), !!reason);
  }

  /** Why the footprint doesn't fit here ('' = it fits). */
  misfit(item, fp, walls, host, st) {
    if (item.place === 'wall') { if (!pointOnFloor(fp.x, fp.z, st.rects)) return 'Not inside your chalet'; }
    else if (!onFloor(fp, st.rects)) return 'Outside the floor';
    for (const w of walls) {
      if (w === host || w.y0 >= fp.y1 || w.y1 <= fp.y0) continue;
      if (boxHitsWall(fp, w)) return 'Blocked by a wall';
    }
    for (const b of st.blocks || []) if (b.y0 < fp.y1 && b.y1 > fp.y0 && boxesOverlap(fp, b)) return 'Keep the way clear';
    if (st.ceilingAt && item.place !== 'ceiling') {
      for (const [cx, cz] of corners(fp)) if (fp.y1 > st.ceilingAt(cx, cz) + 0.02) return 'Too tall under the roof';
    }
    if (!item.flat) {
      for (const p of this.placed) {
        if (p.item.flat || p === this.moving) continue;
        if (p.fp.y0 >= fp.y1 - 0.01 || p.fp.y1 <= fp.y0 + 0.01) continue;
        if (boxesOverlap(fp, p.fp)) return `Overlaps the ${p.item.name.toLowerCase()}`;
      }
      const pp = this.chalet.playerPos();
      if (pp && item.place === 'floor') {
        const l = this.chalet.root.worldToLocal(_p.copy(pp));
        const c = Math.cos(fp.rot), s = Math.sin(fp.rot), dx = l.x - fp.x, dz = l.z - fp.z;
        if (Math.abs(dx * c - dz * s) < fp.hw + 0.3 && Math.abs(dx * s + dz * c) < fp.hd + 0.3) return "You're standing there";
      }
    }
    return '';
  }

  // ------------------------------------------------------------ place / sell / move
  async placeHere() {
    const item = this.item, pose = this.pose;
    if (!pose) return;
    if (!pose.valid) { this.audio?.play('error'); this.menu.deny(null); this.hud?.flash(pose.reason || "Doesn't fit here", 'bad'); return; }
    if (this.moving) {
      const m = this.moving;
      Object.assign(m.rec, { x: pose.x, y: pose.y, z: pose.z, rot: pose.rot });
      this.moving = null;
      this.hold(null);
      this.menu.select(-1);
      this.addPlaced(m.rec, await loadFurniture(m.rec.id), m);
      this.writeSave();
      this.audio?.play('click');
      return;
    }
    if (!this.spend(item.price)) { this.menu.deny(item.id); return; } // (spend flashes "Not enough money")
    const rec = { id: item.id, x: round(pose.x), y: round(pose.y), z: round(pose.z), rot: round(pose.rot) };
    this.furniture.push(rec);
    this.writeSave();
    this.audio?.play('cash');
    this.hud?.flash(`${item.name} placed · -$${item.price.toLocaleString('en-US')}`, 'gold', 1400);
    this.addPlaced(rec, await loadFurniture(item.id));
  }

  addPlaced(rec, gltf, entry = null) {
    const item = FURNITURE_BY_ID[rec.id];
    if (!item || !this.chalet?.root) return null;
    const obj = makeFurnitureObject(item, gltf);
    obj.position.set(rec.x, rec.y, rec.z);
    obj.rotation.y = rec.rot || 0;
    obj.name = `furniture:${rec.id}`;
    const fp = footprint(item, obj.userData.dims, rec.x, rec.y, rec.z, rec.rot || 0);
    const col = item.flat ? null : { ...fp, place: item.place, id: rec.id };
    const handle = this.chalet.addObject(obj, col);
    if (!obj.parent) this.chalet.root.add(obj);
    const e = Object.assign(entry || {}, { rec, item, obj, handle, fp });
    if (!this.placed.includes(e)) this.placed.push(e);
    return e;
  }

  removePlaced(e) {
    this.chalet?.removeObject(e.handle);
    e.obj.parent?.remove(e.obj);
    this.placed = this.placed.filter((p) => p !== e);
  }

  sell(e) {
    const refund = Math.round(e.item.price * SELL_REFUND);
    this.removePlaced(e);
    const i = this.furniture.indexOf(e.rec);
    if (i >= 0) this.furniture.splice(i, 1);
    this.save.money += refund;
    this.hud?.setMoney(this.save.money, refund);
    this.writeSave();
    this.audio?.play('cash');
    this.hud?.flash(`Sold ${e.item.name} · +$${refund.toLocaleString('en-US')}`, 'good', 1400);
    this.setHover(null);
  }

  pickUp(e) {
    this.removePlaced(e);
    this.moving = e;
    this.moving.orig = { ...e.rec };
    this.setHover(null);
    this.rot = e.rec.rot || 0;
    this.menu.select(-1);
    this.hold(e.item);
  }

  cancel() {
    if (this.moving) { // put it back where it was
      const m = this.moving;
      this.moving = null;
      Object.assign(m.rec, m.orig);
      loadFurniture(m.rec.id).then((g) => this.addPlaced(m.rec, g, m));
    }
    this.menu?.select(-1);
    this.hold(null);
  }

  // ------------------------------------------------------------ hover (aimed placed piece)
  updateHover() {
    if (this.moving) return this.setHover(null);
    const cam = this.chalet.camera;
    if (!cam || !this.placed.length) return this.setHover(null);
    cam.getWorldPosition(_o); cam.getWorldDirection(_d);
    this.raycaster.set(_o, _d);
    this.raycaster.far = REACH;
    const hits = this.raycaster.intersectObjects(this.placed.map((p) => p.obj), true);
    let hit = null;
    if (hits.length) {
      let o = hits[0].object;
      while (o && !this.placed.some((p) => p.obj === o)) o = o.parent;
      hit = this.placed.find((p) => p.obj === o) || null;
    }
    this.setHover(hit);
  }

  setHover(e) {
    if (e === this.hover) return;
    this.hover = e;
    if (this.hoverBox) { this.hoverBox.parent?.remove(this.hoverBox); this.hoverBox.geometry.dispose(); this.hoverBox = null; }
    if (e) {
      this.hoverBox = new THREE.BoxHelper(e.obj, 0xffd479);
      this.hoverBox.material.depthTest = false;
      this.hoverBox.renderOrder = 12;
      let top = this.chalet.root; // BoxHelper geometry is in world space: hang it on the scene itself
      while (top.parent) top = top.parent;
      top.add(this.hoverBox);
      this.hoverBox.update();
      if (!this.item) this.menu?.status(`${e.item.name} · Q move · X sell +$${Math.round(e.item.price * SELL_REFUND)}`);
    }
  }

  // ------------------------------------------------------------ saved furniture
  loadPlaced() {
    for (const p of this.placed) { try { this.chalet.removeObject(p.handle); } catch { /* old interior */ } p.obj.parent?.remove(p.obj); }
    this.placed = [];
    this.loadedRoot = this.chalet.root;
    const recs = this.furniture.filter((r) => FURNITURE_BY_ID[r.id]);
    const root = this.loadedRoot;
    for (const rec of recs) loadFurniture(rec.id).then((g) => { if (this.loadedRoot === root) this.addPlaced(rec, g); });
  }
}

const round = (v) => Math.round(v * 1000) / 1000;
export { GRID };
