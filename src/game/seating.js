// Sitting down anywhere: benches, deck chairs, the chalet's sofas, armchairs, chairs and bed edges.
//
// A registry of seat points (a spatial grid per scene) that the world's builders fill as they place their props:
//   registerSeat({ x, y, z, yaw, scene: 'world' | 'chalet', floorY?, label?, back?, front?, recline?, legs? }) -> seat
//                        (y: the seat surface, yaw: the way you face sitting on it (three.js: forward = (sin yaw, 0, cos yaw));
//                        the seat's shape for the rig's seated pose (skier.js poseBench), in m along the facing from
//                        (x, z): back = the backrest's front face (null: none), front = the seat's front edge;
//                        recline: the backrest's lean back (rad), legs: 'out' = a lounger (the legs along the seat))
//   registerBench({ x, y, z, yaw, width, scene }) -> [seat]   n spots along a bench (local x), all facing yaw
//   propSeats(name, obj, size)   a placed Meshy prop (wooden_bench, garden_bench, shop_bench, deck_chair): its seats
//   seatsFromObject(obj, spots)  spots in obj's local frame [{ x, y, z, yaw }] -> world seats (its matrixWorld)
//   removeSeat(seat | [seat])
// Outside (main.js): seating.interaction(player) gives the "Sit down" prompt (E) when you stand at a free seat;
// sitting puts the player in its existing 'sit' mode (player.sitOn: the rig's sit pose, both cameras), E or a
// move key stands you up in front of the seat (seating.updateSeated).
// In your chalet (its own scene, chaletroom.js): seating.chaletFrame(input, doorTarget, building) builds the
// seats of the furniture you placed (save.chalet.furniture, catalog entries with `seat`), gives the prompt and
// sits you; a chaletInteriorAPI.onFrame hook lowers the interior camera to the seat's eye while you sit.
import * as THREE from 'three';

const CELL = 8;
const SIT_R = 1.25; // m: how close to a seat point you have to stand
const grids = { world: new Map(), chalet: new Map() };
const key = (x, z) => Math.floor(x / CELL) * 73856093 ^ Math.floor(z / CELL) * 19349663;
let count = 0;

export function registerSeat({ x, y, z, yaw = 0, scene = 'world', floorY, label, back = -0.22, front = 0.24, recline = 0, legs = null } = {}) {
  if (![x, y, z, yaw].every(Number.isFinite)) return null;
  const g = grids[scene] || (grids[scene] = new Map());
  const s = { x, y, z, yaw, scene, floorY: floorY ?? y - 0.45, label: label || 'Sit down', k: key(x, z),
    back: Number.isFinite(back) ? back : null, front: Number.isFinite(front) ? front : 0.24, recline: recline || 0, legs };
  if (!g.has(s.k)) g.set(s.k, []);
  g.get(s.k).push(s);
  count++;
  return s;
}
export function removeSeat(s) {
  if (Array.isArray(s)) { s.forEach(removeSeat); return; }
  const list = s && grids[s.scene]?.get(s.k);
  const i = list ? list.indexOf(s) : -1;
  if (i >= 0) { list.splice(i, 1); count--; if (!list.length) grids[s.scene].delete(s.k); }
}
/** n spots along a bench `width` m long (local x), facing yaw; `off`: the spots' offset forward of (x, z); back / front
 *  (the backrest's face, null: none / the front edge), m forward of (x, z) like off (default: a 0.46 m seat round the spots). */
export function registerBench({ x, y, z, yaw = 0, width = 1.8, n, off = 0, scene = 'world', floorY, back, front, recline = 0, legs = null } = {}) {
  n ??= Math.max(1, Math.round(width / 0.6));
  const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = fz, rz = -fx, step = n > 1 ? (width - 0.55) / (n - 1) : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const l = (i - (n - 1) / 2) * step;
    const s = registerSeat({ x: x + rx * l + fx * off, y, z: z + rz * l + fz * off, yaw, scene, floorY,
      back: back === null ? null : back === undefined ? undefined : back - off, front: front === undefined ? undefined : front - off, recline, legs });
    if (s) out.push(s);
  }
  return out;
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _f = new THREE.Vector3();
const yawOf = (q) => { _f.set(0, 0, 1).applyQuaternion(q); return Math.atan2(_f.x, _f.z); };
/** Seats in an object's local frame (metres of its parent's scale: the object is not scaled) -> world seats. */
export function seatsFromObject(obj, spots, scene = 'world') {
  obj.updateWorldMatrix(true, false);
  obj.matrixWorld.decompose(_p, _q, _s);
  const yaw0 = yawOf(_q), out = [];
  for (const sp of spots) {
    const v = new THREE.Vector3(sp.x, sp.y, sp.z).applyMatrix4(obj.matrixWorld);
    const s = registerSeat({ x: v.x, y: v.y, z: v.z, yaw: yaw0 + (sp.yaw || 0), scene, floorY: sp.floor != null ? v.y - sp.y + sp.floor : undefined,
      back: sp.back, front: sp.front, recline: sp.recline, legs: sp.legs });
    if (s) out.push(s);
  }
  return out;
}
// the Meshy props you can sit on (front = +z, origin on the ground, centred), measured off their meshes in the model's
// own units, where `ref` is the extent fitModel's `size` sets (benches: their length): the seat's top (h), the
// backrest's front face at the small of the back (back; null: none), the seat's front edge (front), the backrest's lean
// (recline, rad); off: the seat spots' offset forward of the origin (m), n: spots. (The wooden bench's seat is ~0.95 m
// deep: you sit forward on it, the knees past its front edge; the garden bench's seat stands ~0.6 m high.)
const PROPS = {
  wooden_bench: { ref: 1.9, h: 0.51, back: -0.40, front: 0.60, recline: 0.3, off: 0.04 },
  garden_bench: { ref: 1.9, h: 0.70, back: -0.20, front: 0.57, recline: 0.35, off: 0.04 },
  shop_bench: { ref: 1.9, h: 0.649, back: null, front: 0.47, off: 0 },
  // (a deck chair: sling 0.63 high from the backrest's foot to its front bar, the backrest ~49 deg back; ref: its depth)
  deck_chair: { ref: 1.9, h: 0.63, back: -0.03, front: 0.95, recline: 0.85, legs: 'out', off: 0.2, n: 1, refY: 1.449 },
};
/** A prop's seat at the size it was fitted to (axis 'y': size = its height): { h, back, front, recline, legs, off, n } in m. */
export function propProfile(name, size, axis = 'xz') {
  const P = PROPS[name];
  if (!P) return null;
  const k = (size || 1.8) / (axis === 'y' && P.refY ? P.refY : P.ref);
  return { h: P.h * k, back: P.back == null ? null : P.back * k, front: P.front * k, recline: P.recline || 0, legs: P.legs || null, off: P.off * k, n: P.n };
}
/** A placed Meshy prop (position / rotation.y set, origin on the ground): registers its seats if it is one. */
export function propSeats(name, obj, size, axis = 'xz') {
  const P = propProfile(name, size, axis);
  if (!P || !obj) return null;
  obj.updateWorldMatrix(true, false);
  obj.matrixWorld.decompose(_p, _q, _s);
  return registerBench({ x: _p.x, y: _p.y + P.h, z: _p.z, yaw: yawOf(_q), width: size || 1.8, n: P.n, off: P.off, floorY: _p.y,
    back: P.back, front: P.front, recline: P.recline, legs: P.legs });
}
/** The seat whose surface point is at (x, y, z) (within r m, 0.2 m in height): a remote player sitting there. */
export function seatAt(scene, x, y, z, r = 0.35) {
  const g = grids[scene];
  if (!g || !g.size) return null;
  let best = null, bd = r * r;
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
    const list = g.get(i * 73856093 ^ j * 19349663);
    if (list) for (const s of list) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd && Math.abs(s.y - y) < 0.2) { bd = d; best = s; }
    }
  }
  return best;
}

/** The nearest seat within r (m) of (x, y, z) in a scene (y: your feet; the seat's floor within 1 m). */
export function nearestSeat(scene, x, y, z, r = SIT_R) {
  const g = grids[scene];
  if (!g || !g.size) return null;
  let best = null, bd = r * r;
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
    const list = g.get(i * 73856093 ^ j * 19349663);
    if (!list) continue;
    for (const s of list) {
      if (Math.floor(s.x / CELL) !== i || Math.floor(s.z / CELL) !== j) continue; // (a hash collision)
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd && Math.abs(s.floorY - y) < 1.0) { bd = d; best = s; }
    }
  }
  return best;
}

// ------------------------------------------------------------------ the chalet's furniture (catalog `seat`)
// seat: { h: seat height, n: spots along the front, sides: spots along each long side (beds: facing out) }
function furnitureSpots(item, rec) {
  const S = item.seat, [w, , d] = item.size, out = [];
  const rot = rec.rot || 0, c = Math.cos(rot), s = Math.sin(rot);
  const W = (lx, lz, ly) => ({ x: rec.x + c * lx + s * lz, y: (rec.y ?? 0) + ly, z: rec.z - s * lx + c * lz }); // (three.js y-rotation)
  if (S.sides) {
    for (const side of [-1, 1]) for (let i = 0; i < S.sides; i++) {
      const lz = S.sides > 1 ? (i / (S.sides - 1) - 0.5) * d * 0.45 : 0.05 * d;
      out.push({ ...W(side * (w / 2 - 0.22), lz, S.h), yaw: rot + side * Math.PI / 2, floorY: rec.y ?? 0, back: null, front: 0.22 });
    }
  } else {
    const n = S.n || 1, step = n > 1 ? (w - 0.6) / (n - 1) : 0, lz = d / 2 - Math.min(0.32, d * 0.5);
    // (the seat from the front edge back to the backrest: a sofa's / armchair's thick, a chair's thin; a chest has none)
    const front = d / 2 - lz, back = item.size[1] > S.h + 0.25 ? -(d - front) + Math.min(0.2, Math.max(0.04, d * 0.22)) : null;
    for (let i = 0; i < n; i++) out.push({ ...W((i - (n - 1) / 2) * step, lz, S.h), yaw: rot, floorY: rec.y ?? 0, back, front });
  }
  return out;
}

const STAND_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
const EYE_SEATED = 0.74; // m over the seat surface

export const seating = {
  get count() { return count; },
  cur: null, // outside: { seat, ride: { pos, fwd }, player, frame }
  chalet: { api: null, catalog: null, save: null, seats: [], sig: '', seat: null, cam: null, unhook: null },

  /** main.js: the save (the chalet's furniture), the chalet interior API, the furniture catalog (by id). */
  init({ save, chaletAPI, catalog, chalets } = {}) {
    this.chalet.save = save; this.chalet.api = chaletAPI; this.chalet.catalog = catalog;
    this.chalets = chalets;
    if (chaletAPI && !this.chalet.unhook) this.chalet.unhook = chaletAPI.onFrame((dt) => this.chaletCamera(dt));
  },

  // ---------------------------------------------------------------- outside
  get seated() { return !!(this.cur && this.cur.player.seat === this.cur.ride && this.cur.player.mode === 'sit'); },
  /** findInteraction(): the "Sit down" prompt at a seat (on foot, or standing still on skis). */
  interaction(player) {
    this.villageSeats();
    if (this.seated) return null;
    if (!(player.mode === 'walk' || (player.mode === 'ski' && player.speed < 1.5))) return null;
    const p = player.pos, s = nearestSeat('world', p.x, p.y, p.z);
    return s ? { label: s.label, act: () => this.sit(player, s) } : null;
  },
  sit(player, s) {
    // (bench: the seat's shape for the rig's seated pose, skier.js poseBench; lifts and vehicles have none)
    const ride = { pos: new THREE.Vector3(s.x, s.y, s.z), fwd: new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw)), bench: s };
    player.sitOn(ride);
    player.heading = s.yaw;
    this.cur = { seat: s, ride, player, t: 0 };
  },
  /** Per frame while seated (main.js): E or a move key stands you up. Returns the prompt ('Stand up'). */
  updateSeated(dt, input, menu) {
    const c = this.cur;
    if (!this.seated) { this.cur = null; return null; }
    c.t += dt;
    if (!menu && c.t > 0.25 && (input.hit('KeyE') || STAND_KEYS.some((k) => input.hit(k)))) { this.stand(); return null; }
    return 'Stand up';
  },
  stand() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    const { seat: s, player: pl } = c;
    if (pl.seat !== c.ride) return; // (something else took over the seat: a teleport, a reset)
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    pl.seat = null;
    pl.mode = pl.skisOn ? 'ski' : 'walk';
    pl.teleport(s.x + fx * 0.7, s.z + fz * 0.7, s.yaw, s.floorY);
    pl.rig?.snapPose?.();
  },
  // the chalet village's garden and playground benches (game/chalets.js places them from its plots)
  villageSeats() {
    if (this._village || !this.chalets?.V?.plots) return;
    if (!this._height) return;
    this._village = true;
    // (chalets.js publishes its benches: the gardens' and the playground's, each facing the road; the Meshy garden
    // bench at 1.6 m, chalets.js's fit: its seat ~0.59 m high)
    const P = propProfile('garden_bench', 1.6);
    for (const b of this.chalets.benchSpots || []) registerBench({ x: b.x, y: b.y + P.h, z: b.z, yaw: b.yaw, width: 1.6, off: P.off, floorY: b.y, back: P.back, front: P.front, recline: P.recline });
  },
  /** main.js: the ground height and the house's half-depth (chaletplan HX) for the chalet village's benches. */
  setVillage(height, HX) { this._height = height; this._HX = HX; },

  // ---------------------------------------------------------------- inside your chalet
  syncChalet() {
    const C = this.chalet, recs = C.save?.chalet?.furniture || [];
    let sig = '' + recs.length;
    for (const r of recs) sig += `|${r.id},${(+r.x || 0).toFixed(2)},${(+r.z || 0).toFixed(2)},${(+r.y || 0).toFixed(2)},${(+r.rot || 0).toFixed(2)}`; // (a damaged record, x: null, must not throw every frame)
    if (sig === C.sig) return;
    C.sig = sig;
    removeSeat(C.seats); C.seats = [];
    for (const r of recs) {
      const item = C.catalog?.[r.id];
      if (!item?.seat || !item.size) continue;
      for (const sp of furnitureSpots(item, r)) { const s = registerSeat({ ...sp, scene: 'chalet' }); if (s) C.seats.push(s); }
    }
  },
  /** main.js, inside a chalet after chalets.frame: the prompt (Sit down / Stand up) or null. */
  chaletFrame(input, doorTarget, building) {
    const C = this.chalet, api = C.api, pl = api?.player;
    if (!pl || !api.inside) { C.seat = null; return null; }
    if (C.seat) {
      if (!input) return 'Stand up';
      C.t = (C.t || 0) + 1;
      if (C.t > 1 && (input.hit('KeyE') || STAND_KEYS.some((k) => input.down(k)))) { C.seat = null; return null; }
      return 'Stand up';
    }
    if (!api.active) return null; // (seats: only your own chalet's furniture)
    this.syncChalet();
    if (doorTarget || building || !input) return null;
    const s = nearestSeat('chalet', pl.pos.x, pl.pos.y, pl.pos.z, 1.1);
    if (!s) return null;
    if (input.hit('KeyE')) { C.seat = s; C.t = 0; C.cam = null; return 'Stand up'; }
    return s.label;
  },
  leftChalet() { this.chalet.seat = null; },
  // (the interior's onFrame hook: after its walking and camera, before its portal render)
  chaletCamera(dt) {
    const C = this.chalet, s = C.seat, api = C.api;
    if (!s || !api) return;
    const cam = api.camera, pl = api.player;
    if (!cam || !pl) return;
    const want = _p.set(s.x, s.y + EYE_SEATED, s.z);
    C.cam ??= cam.position.clone();
    C.cam.lerp(want, 1 - Math.exp(-dt * 10));
    cam.position.copy(C.cam);
    const dir = _f.set(Math.sin(pl.yaw) * Math.cos(pl.pitch), Math.sin(pl.pitch), Math.cos(pl.yaw) * Math.cos(pl.pitch));
    _s.copy(cam.position).add(dir);
    if (cam.parent) { cam.parent.updateWorldMatrix(true, false); cam.parent.localToWorld(_s); } // (the chalet's camera: a child of the house, its position in the house frame)
    cam.lookAt(_s);
  },
};
if (typeof window !== 'undefined') window.seating = seating;
