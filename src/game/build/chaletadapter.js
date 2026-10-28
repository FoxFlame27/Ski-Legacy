// Adapter between build mode and the chalet village's interior API (the chalet agent's module).
// Build mode only talks to the normalised shape below, so the real API can name things a little
// differently without touching build mode.
//
// Normalised interior (what build mode needs):
//   active()            true while the player is inside THEIR rented chalet
//   root                Object3D furniture is parented to (storey/wall coords are in its local space)
//   camera              the camera used inside
//   playerPos()         player feet position (world space) or null
//   storeys()           [{ floorY, ceilingY, rects: [{ x0, z0, x1, z1 }], walls, blocks, ceilingAt(x,z) }]
//                       (defaults to the shared plan in src/game/chaletplan.js via ./chaletlayout.js)
//   walls()             [{ ax, az, bx, bz, t, y0, y1 }]                     wall segments (with door gaps)
//   addObject(obj, col) -> handle   place obj (already positioned) + collider col = { x, z, hw, hd, rot, y0, y1 }
//   removeObject(handle)
//   sills()             [{ x, z, y, len, depth, yaw, storey }] window ledges (optional: else from chaletplan.js)
//
// Discovery: any module matching src/world/chalet*.js or src/game/chalet*.js that exports
// `chaletInteriorAPI` (an object, or a zero-arg getter function), or window.chaletInteriorAPI.

import { planLayout, planSills } from './chaletlayout.js';

const modules = import.meta.glob(['/src/world/chalet*.js', '/src/game/chalet*.js']);

let found = null;
let searching = null;
/** Look up the chalet module's API (async, once). Returns the raw API or null. */
export function discoverChaletAPI() {
  if (found) return Promise.resolve(found);
  searching ??= (async () => {
    for (const load of Object.values(modules)) {
      try {
        const ns = await load();
        if ('chaletInteriorAPI' in ns) { found = { ns }; return found; }
      } catch (e) { console.warn('[build] chalet module failed to load', e); }
    }
    return null;
  })();
  return searching;
}

/** The current raw API object (live binding / getter / window fallback). */
export function currentRawAPI() {
  let a = found?.ns?.chaletInteriorAPI ?? globalThis.chaletInteriorAPI ?? null;
  if (typeof a === 'function' && a.length === 0 && !a.prototype?.addObject) { try { a = a(); } catch { a = null; } }
  return a || null;
}

const val = (v, self) => (typeof v === 'function' ? v.call(self) : v);
const num = (...v) => v.find((x) => Number.isFinite(x));

export function normRect(r) {
  if (Array.isArray(r)) return { x0: Math.min(r[0], r[2]), z0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), z1: Math.max(r[1], r[3]) };
  if (r.x0 != null) return { x0: Math.min(r.x0, r.x1), z0: Math.min(r.z0, r.z1), x1: Math.max(r.x0, r.x1), z1: Math.max(r.z0, r.z1) };
  if (r.minX != null) return { x0: r.minX, z0: r.minZ, x1: r.maxX, z1: r.maxZ };
  if (r.min && r.max) return { x0: r.min.x, z0: r.min.z, x1: r.max.x, z1: r.max.z };
  const w = num(r.w, r.width, r.sx), d = num(r.d, r.depth, r.sz);
  return { x0: r.x - w / 2, z0: r.z - d / 2, x1: r.x + w / 2, z1: r.z + d / 2 };
}

export function normWall(w, faceLine = false) {
  let o;
  if (Array.isArray(w)) o = { ax: w[0], az: w[1], bx: w[2], bz: w[3] };
  else if (w.a && w.b) o = { ax: w.a.x, az: w.a.z, bx: w.b.x, bz: w.b.z };
  else if (w.ax != null) o = { ax: w.ax, az: w.az, bx: w.bx, bz: w.bz };
  else if (w.x0 != null) o = { ax: w.x0, az: w.z0, bx: w.x1, bz: w.z1 };
  else if (w.minX != null) { // an AABB wall: use its long axis as the segment
    const cx = (w.minX + w.maxX) / 2, cz = (w.minZ + w.maxZ) / 2;
    o = w.maxX - w.minX >= w.maxZ - w.minZ
      ? { ax: w.minX, az: cz, bx: w.maxX, bz: cz, t: w.maxZ - w.minZ }
      : { ax: cx, az: w.minZ, bx: cx, bz: w.maxZ, t: w.maxX - w.minX };
  } else return null;
  o.t = num(o.t, w.t, w.thickness, w.thick, 0.2);
  o.y0 = num(w.y0, w.bottom, -Infinity);
  o.y1 = num(w.y1, w.top, Infinity);
  if (w.storey != null) o.storey = w.storey;
  if (faceLine && w.exterior) { // the chalet API: an exterior wall's line is its inner face, t outward (away from the middle)
    let nx = -(o.bz - o.az), nz = o.bx - o.ax;
    const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
    const mx = (o.ax + o.bx) / 2, mz = (o.az + o.bz) / 2;
    if (mx * nx + mz * nz < 0) { nx = -nx; nz = -nz; }
    o.ax += nx * o.t / 2; o.az += nz * o.t / 2; o.bx += nx * o.t / 2; o.bz += nz * o.t / 2;
  }
  return o;
}

function normStoreys(raw) {
  const list = val(raw.storeys ?? raw.floors ?? raw.levels ?? raw.floorRects ?? raw.walkable, raw) || [];
  return list.map((s, i) => {
    if (Array.isArray(s)) s = { rects: s };
    const floorY = num(s.floorY, s.y, s.floor, i * 2.9);
    const ceilingY = num(s.ceilingY, s.ceiling, s.top, floorY + num(s.height, 2.6));
    const rects = (s.rects ?? s.floorRects ?? s.walkable ?? s.areas ?? []).map(normRect);
    return { floorY, ceilingY, rects, walls: s.walls ? s.walls.map(normWall).filter(Boolean) : null, blocks: s.blocks || [], ceilingAt: s.ceilingAt || (() => ceilingY) };
  });
}

/** Wrap a raw chalet API in the normalised interface (null when there is none). */
export function adaptChalet(raw) {
  if (!raw) return null;
  return {
    raw,
    active: () => !!val(raw.isActive ?? raw.active ?? raw.inside ?? raw.isInside, raw),
    get root() { return val(raw.group ?? raw.root ?? raw.interior ?? raw.scene, raw); },
    get camera() { return val(raw.camera, raw); },
    /** Player feet position in ROOT space (the chalet API gives it there already). */
    playerPos() {
      const p = val(raw.player, raw);
      return p?.pos ?? p?.position ?? (p?.isVector3 ? p : null);
    },
    storeys() {
      const st = normStoreys(raw);
      const plan = (this._plan ??= planLayout()); // the shared chalet plan (chaletplan.js): walls split at windows
      if (!st.length) return plan;
      const shared = (val(raw.walls ?? raw.wallSegments, raw) || []);
      return st.map((s, i) => {
        const lvl = raw.storeys?.[i]?.level ?? (i ? 'up' : 'ground');
        const p = plan.find((q) => q.level === lvl);
        // walls: the plan's (they know the windows) unless the API gave this storey its own
        const walls = s.walls || p?.walls || shared.filter((w) => (w.storey ?? i) === i).map((w) => normWall(w, true)).filter(Boolean);
        const ceilingAt = typeof raw.ceilingAt === 'function' ? (x, z) => raw.ceilingAt(x, z, lvl) : (p?.ceilingAt ?? s.ceilingAt);
        return { ...s, level: lvl, walls, blocks: s.blocks?.length ? s.blocks : (p?.blocks || []), ceilingAt };
      });
    },
    /** Window sills: [{ x, z, y, len, depth, yaw, storey }] (root space; yaw = the direction into the room). */
    sills() {
      const own = (val(raw.sills, raw) || []).filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));
      return own.length ? own : (this._sills ??= planSills()); // (the plan's windows when the API has none)
    },
    addObject(obj, col) {
      const f = raw.addObject ?? raw.addPlaced ?? raw.place ?? raw.addFurniture;
      if (f) return f.call(raw, obj, col) ?? obj;
      this.root?.add(obj);
      return obj;
    },
    removeObject(handle) {
      const f = raw.removeObject ?? raw.removePlaced ?? raw.remove ?? raw.removeFurniture;
      if (f) return f.call(raw, handle);
      handle?.parent?.remove(handle);
    },
    // (no per-frame hook: main.js calls buildMode.update every frame, which also notices you leaving)
  };
}

/** Is a chalet rented in this save? (tolerant of how the chalet module stores it) */
export function chaletRented(save) {
  const c = save?.chalet;
  if (!c) return false;
  return !!(c.rented || c.owned || c.id != null || c.chaletId != null || c.plot != null || c.index != null);
}
