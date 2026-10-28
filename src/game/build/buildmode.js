// Chalet BUILD MODE: inside your rented chalet press F to furnish it. The mouse is freed (CURSOR mode) and the
// furniture catalogue opens on the right (src/ui/buildmenu.js): scroll it with the wheel, click a room tab, click
// a card to take it in hand. You keep walking with WASD; TAB switches to LOOK mode (mouse look, aim with the
// centre dot) and back, and holding the right mouse button looks around without leaving CURSOR mode.
// The item in hand follows the cursor as a blue blueprint ghost (red when it doesn't fit): floor items snap to a
// 0.25 m grid and flush against walls, wall items hang on the wall you point at, ceiling lamps hang from the
// ceiling, and small decor (pots, vases, candles, frames...) sits on window sills or on top of furniture.
// Click / Enter buys and places the real Meshy model (with a collider) and saves it to
// save.chalet.furniture = [{ id, x, y, z, rot, on? }] (the interior root's frame = the chalet's house frame).
// Q picks a placed piece up to move it, X sells it back for half its price. E toggles a lamp (in or out of
// build mode); lamps really light the room (lamps.js).
//
// It talks to the chalet module only through ./chaletadapter.js (see the interface documented there).
// main.js calls buildMode.update(dt, input) every frame; that also discovers the chalet API.
import * as THREE from 'three';
import { FURNITURE_BY_ID, SELL_REFUND } from './catalog.js';
import { loadFurniture, makeFurnitureObject, renderThumbs, setBulb } from './furniture.js';
import { makeGhost } from './blueprint.js';
import { snap, corners, onFloor, pointOnFloor, boxesOverlap, boxHitsWall, snapToWalls, rayWall, raySill, GRID } from './placement.js';
import { adaptChalet, currentRawAPI, discoverChaletAPI } from './chaletadapter.js';
import { LampPool } from './lamps.js';
import { BuildMenu } from '../../ui/buildmenu.js';

const REACH = 6; // metres you can place from
const RAD = Math.PI / 180;
const SMALL_GRID = 0.05;
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Matrix4(), _ndc = new THREE.Vector2();
const fmt = (n) => n.toLocaleString('en-US');

/** Footprint + vertical extent of an item at a base position (see makeFurnitureObject's local frame). */
function footprint(item, dims, x, y, z, rot) {
  let cx = x, cz = z;
  if (item.place === 'wall') { cx += Math.sin(rot) * dims.z / 2; cz += Math.cos(rot) * dims.z / 2; }
  const y0 = item.place === 'ceiling' ? y - dims.y : y;
  return { x: cx, z: cz, hw: dims.x / 2, hd: dims.z / 2, rot, y0, y1: y0 + dims.y };
}
const inBox = (px, pz, b, m = 0) => {
  const c = Math.cos(b.rot), s = Math.sin(b.rot), dx = px - b.x, dz = pz - b.z;
  return Math.abs(dx * c - dz * s) <= b.hw + m && Math.abs(dx * s + dz * c) <= b.hd + m;
};

export class BuildMode {
  constructor({ save, writeSave, spend, hud, audio, input }) {
    Object.assign(this, { save, writeSave, spend, hud, audio, input });
    this.on = false;
    this.look = false; // LOOK mode (pointer locked) vs CURSOR mode (mouse free) while building
    this.chalet = null; // normalised chalet interior (chaletadapter.js)
    this.wasActive = false;
    this.placed = []; // { rec, item, obj, handle, fp }
    this.loadedRoot = null;
    this.lamps = null;
    this.item = null; // catalog item in hand
    this.moving = null; // placed entry being moved (no charge)
    this.ghost = null;
    this.ghostToken = 0;
    this.rot = 0;
    this.pose = null; // { x, y, z, rot, fp, valid, reason }
    this.menu = null;
    this.hover = null;
    this.hoverBox = null;
    this.lampAim = null; // the lamp you look at outside build mode (E toggles it)
    this.raycaster = new THREE.Raycaster();
    this.lastMoney = -1;
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, overMenu: false, seen: false };
    this.rmb = null;
    this.wheel = 0;
    this.queued = { click: false, cancel: false };
    discoverChaletAPI();

    addEventListener('mousemove', (e) => {
      Object.assign(this.mouse, { x: e.clientX, y: e.clientY, overMenu: !!this.menu?.owns(e.target), seen: true });
      if (this.rmb) this.rmb.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    });
    addEventListener('mousedown', (e) => {
      if (!this.on) return;
      const free = !document.pointerLockElement;
      if (e.button === 0 && (!free || e.target === this.input.canvas)) this.queued.click = true;
      if (e.button === 2) {
        if (free) { this.rmb = { moved: 0 }; this.input.lookDrag = true; } // hold to look around
        else this.queued.cancel = true;
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button !== 2 || !this.rmb) return;
      if (this.rmb.moved < 6) this.queued.cancel = true; // a right click (no drag): empty your hand
      this.rmb = null;
      this.input.lookDrag = false;
    });
    addEventListener('contextmenu', (e) => { if (this.on) e.preventDefault(); });
    addEventListener('wheel', (e) => {
      if (!this.on || this.menu?.owns(e.target)) return; // over the catalogue: it scrolls itself
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    addEventListener('keydown', (e) => {
      if (!this.wasActive || !this.input.enabled || e.repeat) return;
      if (e.code === 'KeyF') { this.setOn(!this.on); return; }
      if (e.code === 'Tab' || e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault();
        if (this.on) this.setLook(!this.look);
        else this.setCursorFree(!this.input.cursorFree); // outside build mode too: free the mouse / take it back
        return;
      }
      if (e.code === 'Escape' && (this.on || this.input.cursorFree)) { this.setOn(false); this.setCursorFree(false, false); }
    });
    // Esc in LOOK mode: the browser drops pointer lock (and may swallow the key): fall back to CURSOR mode instead
    // of the pause menu (registered before main.js's pause handler, so overlayOpen() already sees cursorFree)
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.on && this.look) this.setLook(false);
    });
  }

  get furniture() {
    this.save.chalet ??= {};
    return (this.save.chalet.furniture ??= []);
  }

  /** Explicitly attach a chalet interior API (optional: it is also discovered automatically). */
  attach(raw) { this.rawAPI = raw; this.chalet = adaptChalet(raw); }

  /** One-line HUD objective while inside the chalet (null when not inside). */
  hudLine() {
    if (!this.chalet || !this.wasActive || !this.chalet.active()) return null; // (only while you're inside it)
    if (!this.on) {
      if (this.lampAim) return `Press E to switch the ${this.lampAim.item.name.toLowerCase()} ${this.lampAim.rec.on === false ? 'on' : 'off'}`;
      return this.input.cursorFree ? 'Mouse free · TAB to look around · F to furnish' : 'Press F to furnish your chalet · TAB frees the mouse';
    }
    if (this.moving) return `Moving the ${this.moving.item.name.toLowerCase()} · click to put it down`;
    if (this.item) return `${this.item.name} · $${fmt(this.item.price)} · click to buy and place`;
    return 'Furnish your chalet · pick something from the catalogue';
  }

  /** Called by main.js every frame. */
  update(dt, input = this.input) {
    const raw = currentRawAPI();
    if (raw && raw !== this.rawAPI) this.attach(raw);
    const c = this.chalet;
    const active = !!c?.active() && !!c.root;
    if (!active) {
      if (this.wasActive) { this.setOn(false); this.setCursorFree(false); } // (left the chalet: mouse look again)
      this.wasActive = false;
      return;
    }
    if (c.root !== this.loadedRoot) this.loadPlaced();
    this.wasActive = true;
    const pp = c.playerPos();
    this.lamps?.update(dt, this.placed, pp);

    if (!this.on) { // outside build mode: E switches the lamp you look at
      this.updateLampAim();
      if (this.lampAim && input.hit('KeyE')) this.toggleLamp(this.lampAim);
      this.wheel = 0;
      return;
    }
    if (this.save.money !== this.lastMoney) { this.lastMoney = this.save.money; this.menu.setMoney(this.save.money); }

    // rotate: R (90 deg, Shift+R back) or the wheel over the room (15 deg)
    if (this.item) {
      if (this.wheel) this.rot += Math.sign(this.wheel) * 15 * RAD;
      if (input.hit('KeyR')) this.rot += (input.down('ShiftLeft') || input.down('ShiftRight') ? -90 : 90) * RAD;
    }
    this.wheel = 0;

    this.updateGhost(dt);
    this.updateHover();

    const click = this.queued.click || input.hit('Enter') || input.hit('NumpadEnter');
    const cancel = this.queued.cancel || input.hit('Backspace');
    this.queued.click = this.queued.cancel = false;
    if (cancel) this.cancel();
    else if (click && this.item) this.placeHere();
    if (this.hover && !this.item) {
      if (input.hit('KeyX')) this.sell(this.hover);
      else if (input.hit('KeyQ')) this.pickUp(this.hover);
      else if (input.hit('KeyE') && this.hover.item.light != null) this.toggleLamp(this.hover);
    }
  }

  // ------------------------------------------------------------ modes
  setOn(on) {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      this.menu ??= new BuildMenu({ onSelect: (item) => { if (!this.moving) this.hold(item); } });
      this.lastMoney = -1;
      this.menu.show(true);
      this.menu.status('');
      this.setLook(false); // the mouse is free to use the catalogue
      renderThumbs((id, url) => this.menu?.setThumb(id, url)); // lazily, the first time
      this.audio?.play('click');
    } else {
      if (this.moving) this.cancel();
      this.menu?.select(-1, false);
      this.menu?.show(false);
      this.hold(null);
      this.setHover(null);
      this.rmb = null;
      this.input.lookDrag = false;
      this.setCursorFree(false); // back to walking with mouse look
    }
  }

  /** Build mode: LOOK (pointer locked, aim with the centre dot) or CURSOR (mouse free). */
  setLook(look) {
    this.look = look;
    this.setCursorFree(!look);
    this.menu?.setMode(look ? 'look' : 'cursor');
  }

  /** Free the mouse (no pause menu, no auto re-lock) or take it back. relock: request pointer lock now. */
  setCursorFree(free, relock = true) {
    this.input.cursorFree = free;
    if (free) { if (document.pointerLockElement) document.exitPointerLock(); }
    else if (relock && this.wasActive && !document.pointerLockElement) this.input.lock();
  }

  // ------------------------------------------------------------ rays
  /** The pick ray in world space: from the cursor (CURSOR mode) or the screen centre (LOOK mode). */
  worldRay() {
    const cam = this.chalet.camera;
    if (!cam) return null;
    if (this.on && !document.pointerLockElement && this.mouse.seen) {
      const r = this.input.canvas.getBoundingClientRect();
      _ndc.set(((this.mouse.x - r.left) / r.width) * 2 - 1, -((this.mouse.y - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(_ndc, cam);
    } else {
      cam.getWorldPosition(_o); cam.getWorldDirection(_d);
      this.raycaster.set(_o, _d);
    }
    this.raycaster.far = REACH;
    return this.raycaster.ray;
  }
  /** The same ray in the interior root's frame. */
  localRay() {
    const ray = this.worldRay();
    if (!ray) return null;
    const root = this.chalet.root;
    root.updateMatrixWorld();
    _m.copy(root.matrixWorld).invert();
    return { o: ray.origin.clone().applyMatrix4(_m), d: ray.direction.clone().transformDirection(_m) }; // (own vectors: worldRay reuses _o/_d)
  }

  currentStorey(storeys) {
    const y = this.chalet.playerPos()?.y ?? (this.chalet.camera ? this.chalet.camera.position.y - 1.6 : 0);
    let best = storeys[0];
    for (const s of storeys) if (s.floorY <= y + 0.5 && s.floorY >= best.floorY) best = s;
    for (const s of storeys) if (best.floorY > y + 0.5 && s.floorY < best.floorY) best = s;
    return best;
  }

  // ------------------------------------------------------------ ghost
  hold(item) {
    if (this.ghost) { this.ghost.group.parent?.remove(this.ghost.group); this.ghost.dispose(); this.ghost = null; }
    this.item = item;
    this.pose = null;
    const token = ++this.ghostToken;
    if (!item) { this.menu?.status(''); return; }
    const make = (gltf) => {
      if (token !== this.ghostToken || !this.chalet?.root) return;
      if (this.ghost) { this.ghost.group.parent?.remove(this.ghost.group); this.ghost.dispose(); }
      this.ghost = makeGhost(makeFurnitureObject(item, gltf));
      this.ghost.dims = this.ghost.group.userData.dims;
      this.ghost.group.visible = false; // until it has a pose
      this.chalet.root.add(this.ghost.group);
    };
    make(null); // a box at once, the model when it has loaded
    loadFurniture(item.id).then((g) => { if (g) make(g); });
  }

  updateGhost(dt) {
    if (!this.ghost || !this.item) return;
    this.ghost.tick(dt);
    if (!document.pointerLockElement && (this.mouse.overMenu || this.rmb)) return; // pointing at the menu / looking around: keep the pose
    const ray = this.localRay();
    const storeys = this.chalet.storeys();
    if (!ray || !storeys.length) return;
    const st = this.currentStorey(storeys);
    const item = this.item, dims = this.ghost.dims;
    const walls = st.walls || [];
    const { o, d } = ray;
    const hl = Math.hypot(d.x, d.z) || 1e-6;
    const g = item.small ? SMALL_GRID : GRID;
    let x, y, z, rot = this.rot, host = null, surface = 'floor', reason = '';

    if (item.place === 'wall') {
      y = st.floorY + (item.mount ?? 1.2);
      const hit = rayWall(o.x, o.z, d.x / hl, d.z / hl, walls.filter((w) => w.y0 <= y && w.y1 >= y + dims.y), REACH);
      if (hit) {
        host = hit.wall;
        const L = hit.L, s = Math.min(L, Math.max(0, snap(hit.s * L, g)));
        const tx = (host.bx - host.ax) / L, tz = (host.bz - host.az) / L, off = (host.t || 0.2) / 2;
        x = host.ax + tx * s + hit.nx * off; z = host.az + tz * s + hit.nz * off;
        rot = Math.atan2(hit.nx, hit.nz);
      } else {
        x = o.x + (d.x / hl) * 2; z = o.z + (d.z / hl) * 2; reason = 'Point at a wall';
      }
    } else {
      // where the ray meets the floor (or the ceiling, for ceiling lamps you look up at)
      const planeY = item.place === 'ceiling' && d.y > 0.05 ? st.ceilingY : st.floorY;
      let t = Math.abs(d.y) > 0.05 ? (planeY - o.y) / d.y : -1;
      if (t < 0 || t * hl > REACH) t = Math.min(REACH, 2.5) / hl; // looking level / away: hold it in front
      // small decor: a window sill or the top of a placed piece, when that's nearer than the floor
      let top = null;
      if (item.small) {
        const sills = this.chalet.sills().filter((q) => q.y > st.floorY + 0.2 && q.y < st.floorY + 2.4); // (this storey's)
        const sill = raySill(o, d, sills, Math.min(t, REACH));
        const tt = this.rayTop(Math.min(t, sill ? sill.t : t));
        if (tt) top = tt;
        else if (sill) top = { kind: 'sill', ...sill };
      }
      if (top?.kind === 'sill') {
        const s = top.sill, half = s.len / 2 - dims.x / 2;
        const u = Math.max(-half, Math.min(half, snap(top.u, g)));
        rot = s.yaw + Math.round(this.rot / (Math.PI / 2)) * (Math.PI / 2); // square to the window
        x = s.x + Math.cos(s.yaw) * u; z = s.z - Math.sin(s.yaw) * u; y = s.y;
        surface = 'sill'; host = s;
        if (half < 0 || Math.min(dims.x, dims.z) > s.depth + 0.08) reason = 'Too big for the sill';
      } else if (top) {
        x = snap(top.x, g); z = snap(top.z, g); y = top.y;
        surface = 'top'; host = top.entry;
      } else {
        x = snap(o.x + d.x * t, g); z = snap(o.z + d.z * t, g);
        y = item.place === 'ceiling' ? (st.ceilingAt?.(x, z) ?? st.ceilingY) : st.floorY;
      }
    }

    const fp = footprint(item, dims, x, y, z, rot);
    if (surface === 'floor' && item.place !== 'wall' && !item.flat && !item.small) {
      snapToWalls(fp, walls.filter((w) => w.y0 < fp.y1 && w.y1 > fp.y0));
      x = fp.x; z = fp.z;
    }
    if (!reason) reason = this.misfit(item, fp, walls, host, st, surface);
    this.pose = { x, y, z, rot, fp, valid: !reason, reason, surface };
    this.ghost.group.visible = true;
    this.ghost.group.position.set(x, y, z);
    this.ghost.group.rotation.set(0, rot, 0);
    this.ghost.setValid(!reason);
    const where = surface === 'sill' ? ' on the window sill' : surface === 'top' ? ` on the ${host.item.name.toLowerCase()}` : '';
    this.menu.status(reason || (this.moving ? `Click to put it down${where}` : `Click to buy${where} · $${fmt(item.price)}`), !!reason);
  }

  /** Small decor: the top of a placed piece the ray hits (an upward face), nearer than maxT. */
  rayTop(maxT) {
    const hosts = this.placed.filter((p) => !p.item.flat && p.item.place === 'floor' && p !== this.moving);
    if (!hosts.length) return null;
    const ray = this.worldRay();
    this.raycaster.far = maxT + 0.05;
    const hit = this.raycaster.intersectObjects(hosts.map((p) => p.obj), true)[0];
    this.raycaster.far = REACH;
    if (!hit?.face) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.y < 0.7) return null; // a side, not a top
    let ob = hit.object;
    while (ob && !hosts.some((p) => p.obj === ob)) ob = ob.parent;
    const entry = hosts.find((p) => p.obj === ob);
    if (!entry || !ray) return null;
    const lp = this.chalet.root.worldToLocal(hit.point.clone());
    return { kind: 'top', entry, x: lp.x, y: lp.y, z: lp.z };
  }

  /** Why the footprint doesn't fit here ('' = it fits). */
  misfit(item, fp, walls, host, st, surface) {
    if (surface === 'top') {
      if (!corners(fp).every(([cx, cz]) => inBox(cx, cz, host.fp, 0.02))) return `Doesn't fit on the ${host.item.name.toLowerCase()}`;
    } else if (surface === 'floor') {
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
    }
    if (!item.flat) {
      for (const p of this.placed) {
        if (p.item.flat || p === this.moving || p === host) continue;
        if (p.fp.y0 >= fp.y1 - 0.01 || p.fp.y1 <= fp.y0 + 0.01) continue;
        if (boxesOverlap(fp, p.fp)) return `Overlaps the ${p.item.name.toLowerCase()}`;
      }
      const pp = this.chalet.playerPos();
      if (pp && surface === 'floor' && item.place === 'floor' && !item.small && inBox(pp.x, pp.z, fp, 0.3)) return "You're standing there";
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
      Object.assign(m.rec, { x: round(pose.x), y: round(pose.y), z: round(pose.z), rot: round(pose.rot) });
      this.moving = null;
      this.menu.select(-1, false);
      this.hold(null);
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
    this.hud?.flash(`${item.name} placed · -$${fmt(item.price)}`, 'gold', 1400);
    this.addPlaced(rec, await loadFurniture(item.id));
  }

  addPlaced(rec, gltf, entry = null) {
    const item = FURNITURE_BY_ID[rec.id];
    if (!item || !this.chalet?.root) return null;
    const obj = makeFurnitureObject(item, gltf);
    obj.position.set(rec.x, rec.y, rec.z);
    obj.rotation.y = rec.rot || 0;
    obj.name = `furniture:${rec.id}`;
    setBulb(obj, rec.on !== false);
    const fp = footprint(item, obj.userData.dims, rec.x, rec.y, rec.z, rec.rot || 0);
    // colliders: real furniture only (rugs, little decor and things up on a sill / table don't block you)
    const col = item.flat || item.small || item.place !== 'floor' ? null : { x: fp.x, z: fp.z, hw: fp.hw, hd: fp.hd, rot: fp.rot, y0: fp.y0, y1: fp.y1 };
    const handle = this.chalet.addObject(obj, col);
    if (!obj.parent) this.chalet.root.add(obj);
    const e = Object.assign(entry || {}, { rec, item, obj, handle, fp });
    if (!this.placed.includes(e)) this.placed.push(e);
    if (this.lamps) this.lamps.timer = 0;
    return e;
  }

  removePlaced(e) {
    this.chalet?.removeObject(e.handle);
    e.obj.parent?.remove(e.obj);
    this.placed = this.placed.filter((p) => p !== e);
    if (this.lamps) this.lamps.timer = 0;
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
    this.hud?.flash(`Sold ${e.item.name} · +$${fmt(refund)}`, 'good', 1400);
    this.setHover(null);
    this.dropOrphans(e);
  }

  /** Small pieces that stood on `base` (now gone) drop to the floor below them. */
  dropOrphans(base) {
    const floorY = base.fp.y0;
    for (const p of this.placed) {
      if (!p.item.small || Math.abs(p.rec.y - base.fp.y1) > 0.25 || !inBox(p.fp.x, p.fp.z, base.fp, 0.05)) continue;
      p.rec.y = round(floorY);
      p.obj.position.y = p.rec.y;
      p.fp = footprint(p.item, p.obj.userData.dims, p.rec.x, p.rec.y, p.rec.z, p.rec.rot || 0);
    }
    this.writeSave();
  }

  pickUp(e) {
    this.removePlaced(e);
    this.dropOrphans(e);
    this.moving = e;
    this.moving.orig = { ...e.rec };
    this.setHover(null);
    this.rot = e.rec.rot || 0;
    this.menu.select(-1, false);
    this.hold(e.item);
  }

  cancel() {
    if (this.moving) { // put it back where it was
      const m = this.moving;
      this.moving = null;
      Object.assign(m.rec, m.orig);
      loadFurniture(m.rec.id).then((g) => this.addPlaced(m.rec, g, m));
    }
    this.menu?.select(-1, false);
    this.hold(null);
  }

  // ------------------------------------------------------------ lamps
  toggleLamp(e) {
    e.rec.on = e.rec.on === false; // (absent = on)
    setBulb(e.obj, e.rec.on);
    if (this.lamps) this.lamps.timer = 0;
    this.writeSave();
    this.audio?.play('click');
  }

  updateLampAim() {
    const lamps = this.placed.filter((p) => p.item.light != null);
    this.lampAim = null;
    if (!lamps.length || !this.worldRay()) return;
    this.raycaster.far = 3.5;
    const hit = this.raycaster.intersectObjects(lamps.map((p) => p.obj), true)[0];
    this.raycaster.far = REACH;
    let o = hit?.object;
    while (o && !lamps.some((p) => p.obj === o)) o = o.parent;
    this.lampAim = lamps.find((p) => p.obj === o) || null;
  }

  // ------------------------------------------------------------ hover (the placed piece you point at)
  updateHover() {
    if (this.moving || this.item || !this.placed.length || (!document.pointerLockElement && this.mouse.overMenu)) return this.setHover(null);
    if (!this.worldRay()) return this.setHover(null);
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
      this.hoverBox = new THREE.BoxHelper(e.obj, 0xff4d3d);
      this.hoverBox.material.depthTest = false;
      this.hoverBox.renderOrder = 12;
      let top = this.chalet.root; // BoxHelper geometry is in world space: hang it on the scene itself
      while (top.parent) top = top.parent;
      top.add(this.hoverBox);
      this.hoverBox.update();
      const lamp = e.item.light != null ? ` · E ${e.rec.on === false ? 'on' : 'off'}` : '';
      this.menu?.status(`${e.item.name} · Q move · X sell +$${fmt(Math.round(e.item.price * SELL_REFUND))}${lamp}`);
    } else if (!this.item) this.menu?.status('');
  }

  // ------------------------------------------------------------ saved furniture
  loadPlaced() {
    for (const p of this.placed) { try { this.chalet.removeObject(p.handle); } catch { /* old interior */ } p.obj.parent?.remove(p.obj); }
    this.placed = [];
    this.loadedRoot = this.chalet.root;
    this.lamps?.dispose();
    this.lamps = new LampPool(this.loadedRoot); // a fixed light count from the start: no recompiles when you buy lamps
    const recs = this.furniture.filter((r) => FURNITURE_BY_ID[r.id]);
    const root = this.loadedRoot;
    for (const rec of recs) loadFurniture(rec.id).then((g) => { if (this.loadedRoot === root) this.addPlaced(rec, g); });
  }
}

const round = (v) => Math.round(v * 1000) / 1000;
export { GRID };
