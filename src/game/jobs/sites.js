// Job sites: where the job boards stand and every place a job can send you (mountain huts, ski
// patrol posts, lift operators, race starters, the park crew, spots beside the pistes). Everything is
// read from the live layout and checked on the ground: level enough to stand on and never a cliff,
// on groomed snow or a station pad (so never in the trees), clear of buildings, props and race gates,
// and not under a kicker or a bridge deck. Deterministic: the same layout gives the same sites.
import { world } from '../../world/world.js';
import { BOARD } from './props.js';

export const CLIFF = Math.tan((40 * Math.PI) / 180); // nothing ever sits on ground steeper than 40 deg
export const LEVEL = 0.16;    // boards and hand-over points: you stop and stand here
export const SIDEHILL = 0.5;  // piste-side spots (injured skier, lost items): ~27 deg at most
const PISTE_W = [24, 20, 16, 14]; // groomed half-width by difficulty (as in layout.js)
const STATION = { gondola: 14, chair: 8 }; // station building length (lifts.js)
const RIDE = { gondola: 12, chair: 4.5 }; // cable speed m/s (lifts.js)
export const VILLAGE = { x: 0, z: -4 };

const hyp = Math.hypot;
const dist = (a, b) => hyp(a.x - b.x, a.z - b.z);

// ------------------------------------------------------------------ ground checks
// Steepest grade around (x, z): the gradient at the point and on a 2.5 m ring (catches small steps).
export function slopeAt(x, z) {
  let m = 0;
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI) / 2;
    const cx = i ? x + Math.cos(a) * 2.5 : x, cz = i ? z + Math.sin(a) * 2.5 : z;
    const gx = (world.height(cx + 0.8, cz) - world.height(cx - 0.8, cz)) / 1.6;
    const gz = (world.height(cx, cz + 0.8) - world.height(cx, cz - 0.8)) / 1.6;
    const s = hyp(gx, gz);
    if (s > m) m = s;
  }
  return m;
}

// signed distance from (x, z) to a collider's edge (negative inside); same shapes as player.collide
export function edgeDist(c, x, z) {
  if (c.r !== undefined) return hyp(x - c.x, z - c.z) - c.r;
  const rot = c.rot || 0, cs = Math.cos(-rot), sn = Math.sin(-rot);
  const lx = Math.abs((x - c.x) * cs - (z - c.z) * sn) - c.hw, lz = Math.abs((x - c.x) * sn + (z - c.z) * cs) - c.hd;
  if (lx <= 0 && lz <= 0) return Math.max(lx, lz);
  return hyp(Math.max(lx, 0), Math.max(lz, 0));
}

// Spatial hash over colliders (and props that have none, like race gates and deck chairs).
export class Obstacles {
  constructor(cell = 24) { this.cell = cell; this.map = new Map(); this.count = 0; }
  add(c) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) return;
    const box = c.r === undefined;
    const R = box ? hyp(c.hw, c.hd) : c.r;
    if (!Number.isFinite(R) || R < 0 || R > 300) return;
    const s = this.cell;
    for (let i = Math.floor((c.x - R) / s); i <= Math.floor((c.x + R) / s); i++) {
      for (let j = Math.floor((c.z - R) / s); j <= Math.floor((c.z + R) / s); j++) {
        const k = i + ',' + j;
        let a = this.map.get(k);
        if (!a) this.map.set(k, (a = []));
        a.push(c);
      }
    }
    this.count++;
  }
  // distance from (x, z) to the nearest obstacle edge (negative = inside one), searched up to `range`;
  // `skip` leaves one obstacle out (a board checking its own spot)
  clearance(x, z, range = 6, skip = null) {
    let best = range;
    const s = this.cell;
    for (let i = Math.floor((x - range) / s); i <= Math.floor((x + range) / s); i++) {
      for (let j = Math.floor((z - range) / s); j <= Math.floor((z + range) / s); j++) {
        const a = this.map.get(i + ',' + j);
        if (!a) continue;
        for (let k = 0; k < a.length; k++) {
          if (a[k] === skip) continue;
          const d = edgeDist(a[k], x, z);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ travel-time estimate
// Seconds to get from a to b the way a decent skier would: ski down, skate/walk on the flat, or take
// one lift (up any lift, or down a gondola) when that is quicker than hiking.
export class Router {
  constructor(lifts) { this.lifts = lifts; }
  direct(ax, az, bx, bz) {
    const d = hyp(bx - ax, bz - az);
    if (d < 1) return 0;
    const dh = world.height(bx, bz) - world.height(ax, az);
    if (dh < -0.06 * d - 10) return (d * 1.35) / 10 + 10;          // downhill on skis, ~10 m/s with turns
    if (dh < 0.04 * d + 8) return d < 200 ? d / 2.5 : 80 + (d - 200) / 5; // flat: walk, then skate
    return d / 1.2 + dh * 3;                                          // hiking uphill in ski boots
  }
  est(a, b) {
    let best = this.direct(a.x, a.z, b.x, b.z), via = null;
    for (const l of this.lifts) {
      const ride = l.len / RIDE[l.type] + 25;
      const up = this.direct(a.x, a.z, l.bottom.x, l.bottom.z) + ride + this.direct(l.topExit.x, l.topExit.z, b.x, b.z);
      if (up < best) { best = up; via = l; }
      if (l.type === 'gondola') {
        const down = this.direct(a.x, a.z, l.top.x, l.top.z) + ride + this.direct(l.bottomExit.x, l.bottomExit.z, b.x, b.z);
        if (down < best) { best = down; via = l; }
      }
    }
    return { t: best, via };
  }
}

// ------------------------------------------------------------------ sites
export class Sites {
  /** @param {{ layout: object, colliders?: object[] }} o */
  constructor({ layout, colliders = [] }) {
    this.layout = layout;
    this.colliders = colliders;
    this.c = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }; // corridorAt scratch
    this.obst = new Obstacles();
    for (const c of colliders) this.obst.add(c);
    this.seen = colliders.length;
    this.lifts = this.resortLifts();
    this.router = new Router(this.lifts);
    this.addSoftObstacles();
    this.hubs = this.placeBoards();
    for (const h of this.hubs) this.obst.add(h.collider); // later sites keep clear of the boards
    this.dests = this.findDests();
    this.spots = this.findSpots();
    this.areas = this.findAreas();
    this.escortDests = this.dests.filter((d) => d.kind === 'hut' || d.kind === 'board' || d.kind === 'park');
  }

  // Colliders registered after the sites were laid out (another system built later): index them.
  syncColliders() {
    const list = this.colliders;
    if (list.length === this.seen) return false;
    for (let i = Math.max(0, Math.min(this.seen, list.length)); i < list.length; i++) this.obst.add(list[i]);
    this.seen = list.length;
    return true;
  }

  // Resort lifts with their exit points (the procedural race lifts out in the backcountry are left out).
  resortLifts() {
    const L = this.layout;
    const remote = new Set(L.races.filter((r) => !r.main && r.lift !== undefined).map((r) => r.lift));
    const out = [];
    for (const l of L.lifts) {
      if (l.procedural || remote.has(l.id) || !l.top || !l.bottom || !l.dir) continue;
      const type = l.type === 'gondola' ? 'gondola' : 'chair';
      const dx = l.dir[0], dz = l.dir[1], sx = -dz, sz = dx; // sideV as in lifts.js
      const off = STATION[type] * 0.5 + 9;
      out.push({
        id: l.id, name: l.name, type, len: l.length, dir: { x: dx, z: dz }, side: { x: sx, z: sz },
        bottom: { x: l.bottom.x, z: l.bottom.z }, top: { x: l.top.x, z: l.top.z },
        topExit: { x: l.top.x + dx * off + sx * 4, z: l.top.z + dz * off + sz * 4 },
        bottomExit: { x: l.bottom.x - dx * off + sx * 4, z: l.bottom.z - dz * off + sz * 4 },
      });
    }
    return out;
  }

  // Props without colliders that spots must still keep clear of.
  addSoftObstacles() {
    const L = this.layout;
    for (const r of L.races) {
      if (!r.main) continue;
      for (const g of r.gates || []) {
        this.obst.add({ x: g.x, z: g.z, r: 0.6, soft: true });
        this.obst.add({ x: g.x + g.nx * g.side * 5.5, z: g.z + g.nz * g.side * 5.5, r: 0.6, soft: true });
      }
      this.obst.add({ x: r.start.x, z: r.start.z, r: 9, soft: true });   // start arch + sign
      this.obst.add({ x: r.finish.x, z: r.finish.z, r: 7, soft: true }); // finish banner
    }
    // the safety nets along the pistes (their colliders may be registered after the jobs are built)
    for (const n of L.nets || []) {
      const line = n.line || [];
      for (let i = 0; i < line.length; i += 2) this.obst.add({ x: line[i][0], z: line[i][1], r: 1.2, soft: true });
    }
    // hut sun terraces: the deck-chair row along the terrace edge has no colliders
    for (const hut of L.huts) {
      const yaw = hut.yaw ?? 0;
      const [x, z] = this.hutLocal(hut, 0, 12.6);
      this.obst.add({ x, z, hw: 7.8, hd: 1.4, rot: -yaw, soft: true });
    }
  }

  // hut-local coordinates as in the resort dressing: lx along the hut's own +x, lz out of its front
  hutLocal(hut, lx, lz) {
    const yaw = hut.yaw ?? 0, fx = Math.sin(yaw), fz = Math.cos(yaw);
    return [hut.x + fz * lx + fx * lz, hut.z - fx * lx + fz * lz];
  }
  // half-depth of a hut building (from its collider box when there is one)
  hutHalfDepth(hut) {
    for (const c of this.colliders) {
      if (c.r === undefined && Math.abs(c.x - hut.x) < 1 && Math.abs(c.z - hut.z) < 1 && c.hd > 2) return c.hd / 0.84;
    }
    return 5.5;
  }

  // ---------------------------------------------------------------- validity
  // Ground a person can stand or lie on: finite, no deck above, not too steep, clear of obstacles,
  // on groomed snow or a pad (never in the forest), out of the lift tracks.
  ok(x, z, { slope = SIDEHILL, clear = 1.5, pad = false, skip = null, station = false } = {}) {
    const h = world.height(x, z);
    if (!Number.isFinite(h)) return false;
    if (world.groundHeight(x, z) > h + 0.05) return false;
    if (this.obst.clearance(x, z, clear + 1, skip) < clear) return false;
    const c = world.corridorAt(x, z, this.c);
    const padK = world.padInfluence(x, z);
    // out from under the lift lines (beside a station, on its pad, is where the operator stands)
    if (c.kind === 'lift' && c.d < 2 && !(station && padK > 0.6)) return false;
    // off the groomed snow trees and rocks grow (the village plateau has none)
    if (c.d > 1 && padK < 0.6 && hyp(x - VILLAGE.x, z - VILLAGE.z) > 190) return false;
    if (pad && padK < 0.6) return false;
    return slopeAt(x, z) <= slope;
  }

  boardOk(x, z, yaw, skip = null) {
    if (!this.ok(x, z, { slope: LEVEL, clear: 0.4, skip })) return false;
    // the whole board width and the reading spot in front of it
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = fz, rz = -fx;
    for (const s of [-1, 1]) if (this.obst.clearance(x + rx * BOARD.halfW * s, z + rz * BOARD.halfW * s, 2, skip) < 0.5) return false;
    if (this.obst.clearance(x + fx * 1.4, z + fz * 1.4, 2, skip) < 0.6) return false;
    const c = world.corridorAt(x, z, this.c);
    if ((c.kind === 'piste' || c.kind === 'race') && c.d < -3 && world.padInfluence(x, z) < 0.6) return false; // not in the middle of a run
    if (c.kind === 'lift' && c.d < 4) return false;
    return true;
  }

  // ---------------------------------------------------------------- job boards
  placeBoards() {
    const L = this.layout, hubs = [];
    const v = this.villageBoard();
    if (v) hubs.push(v);
    const huts = L.huts.slice().sort((a, b) => hyp(a.x, a.z) - hyp(b.x, b.z));
    for (const hut of huts) { const h = this.hutBoard(hut); if (h) hubs.push(h); }
    for (const l of this.lifts) {
      if (l.type !== 'gondola' || huts.some((h) => dist(h, l.top) < 450)) continue;
      const h = this.stationBoard(l);
      if (h) hubs.push(h);
    }
    // a small number of boards: never two within 300 m, at most 5 within 3 km of the village, 6 in all
    const out = [];
    for (const h of hubs) {
      if (out.some((o) => dist(o, h) < 300)) continue;
      if (hyp(h.x, h.z) < 3000 && out.filter((o) => hyp(o.x, o.z) < 3000).length >= 5) continue;
      if (out.length >= 6) break;
      out.push(h);
    }
    return out;
  }

  // a board whose spot got taken by something built after it (checked once colliders settle)
  boardBlocked(hub) { return !this.boardOk(hub.x, hub.z, hub.yaw, hub.collider); }
  // a new spot for that board (same rules), or null
  replace(hub) {
    if (hub.kind === 'village') return this.villageBoard();
    if (hub.kind === 'hut') return this.hutBoard(hub.hut);
    return hub.gondola ? this.stationBoard(hub.gondola) : null;
  }

  makeHub(id, kind, name, place, x, z, yaw, extra = {}) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    return {
      id, kind, name, place, x, z, yaw, ...extra,
      front: { x: x + fx * 1.1, z: z + fz * 1.1 },
      collider: { x, z, hw: BOARD.halfW, hd: 0.2, rot: -yaw },
    };
  }

  // the gondola that brings people up to a spot (its top exit within 450 m)
  servingGondola(p) {
    let best = null;
    for (const l of this.lifts) {
      if (l.type !== 'gondola') continue;
      const d = dist(l.topExit, p);
      if (d < 450 && (!best || d < dist(best.topExit, p))) best = l;
    }
    return best;
  }

  villageBoard() {
    // the info corner beside the trail map at the gondola approach, else around the plaza edge
    const face = (x, z, k = 1) => Math.atan2(VILLAGE.x - x, VILLAGE.z - z) * k;
    const cands = [
      [13.6, -23.6, -0.3], [-16, 22, face(-16, 22)], [16.5, 25, face(16.5, 25)], [-15, -24, 0.3], [24, -12, face(24, -12)],
    ];
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2, r = 22 + (a % 3) * 4;
      const x = VILLAGE.x + Math.cos(ang) * r, z = VILLAGE.z + Math.sin(ang) * r;
      cands.push([x, z, face(x, z)]);
    }
    for (const [x, z, yaw] of cands) {
      if (this.boardOk(x, z, yaw)) return this.makeHub('village', 'village', 'Legacy Village', 'the village', x, z, yaw, { gondola: this.lifts.find((l) => l.type === 'gondola' && dist(l.bottom, { x, z }) < 200) || null });
    }
    return null;
  }

  hutBoard(hut) {
    const name = hut.name || 'Mountain hut';
    const gondola = this.servingGondola(hut);
    const approach = gondola ? gondola.topExit : { x: hut.x, z: hut.z };
    const hd = this.hutHalfDepth(hut), door = this.hutLocal(hut, 0, hd + 1.6);
    const cands = [];
    for (const lx of [-10.5, 10.5, -12, 12]) for (const lz of [hd - 1.5, 2, -1.5, hd + 3]) cands.push([lx, lz]);
    cands.push([-6.5, 17], [6.5, 17], [0, 18.5]);
    let best = null;
    for (const [lx, lz] of cands) {
      const [x, z] = this.hutLocal(hut, lx, lz);
      if (hyp(x - door[0], z - door[1]) < 4.5) continue;
      // face whoever arrives from the station; read from the terrace side when they come from behind
      let yaw = Math.atan2(approach.x - x, approach.z - z);
      if (dist(approach, hut) < 20) yaw = hut.yaw ?? 0;
      if (!this.boardOk(x, z, yaw)) continue;
      const score = hyp(approach.x - x, approach.z - z) + Math.abs(lz - 3) * 0.5;
      if (!best || score < best.score) best = { x, z, yaw, score };
    }
    if (!best) return null;
    return this.makeHub(hutId(hut), 'hut', name, name, best.x, best.z, best.yaw, { hut, gondola });
  }

  stationBoard(l) {
    const stationHalf = STATION[l.type] * 0.5;
    let best = null;
    for (const s of [-1, 1]) for (const along of [0, -6, 6, -12]) for (const out of [5, 8]) {
      const o = stationHalf + out;
      const x = l.top.x + l.side.x * o * s + l.dir.x * along, z = l.top.z + l.side.z * o * s + l.dir.z * along;
      const yaw = Math.atan2(l.topExit.x - x, l.topExit.z - z);
      if (hyp(l.topExit.x - x, l.topExit.z - z) < 6 || !this.boardOk(x, z, yaw)) continue;
      const score = Math.abs(hyp(l.topExit.x - x, l.topExit.z - z) - 14);
      if (!best || score < best.score) best = { x, z, yaw, score };
    }
    if (!best) return null;
    const name = `${l.name} top`;
    return this.makeHub(`top:${l.name}`, 'top', name, `the top of the ${l.name}`, best.x, best.z, best.yaw, { gondola: l });
  }

  // ---------------------------------------------------------------- destinations (hand-over points)
  // first valid point from a list of candidates (someone stands there, facing `yaw`)
  standPoint(cands, opts = {}) {
    for (const [x, z, yaw] of cands) if (this.ok(x, z, { slope: LEVEL, clear: opts.clear ?? 0.9, pad: opts.pad, station: opts.station })) return { x, z, yaw };
    return null;
  }

  findDests() {
    const L = this.layout, out = [];
    // mountain huts: the chef waits beside the door
    for (const hut of L.huts) {
      const name = hut.name || 'Mountain hut', yaw = hut.yaw ?? 0, hd = this.hutHalfDepth(hut);
      const cands = [[2.5, hd + 1.9], [3.2, hd + 1.2], [-2.6, hd + 3.6], [2.4, hd + 3.4], [6.5, hd - 1]].map(([lx, lz]) => [...this.hutLocal(hut, lx, lz), yaw]);
      const p = this.standPoint(cands);
      if (p) out.push({ id: hutId(hut), kind: 'hut', role: 'chef', npc: true, label: name, to: name, place: name, ...p });
    }
    // ski patrol posts: a patroller in front of the hut, facing the top station
    for (const pk of L.peaks || []) {
      if (!pk.patrol || !pk.lift?.top) continue;
      const t = pk.lift.top, P = pk.patrol;
      const d = hyp(t.x - P.x, t.z - P.z) || 1, ux = (t.x - P.x) / d, uz = (t.z - P.z) / d;
      const yaw = Math.atan2(ux, uz);
      const cands = [3.6, 4.6, 5.8].flatMap((k) => [[P.x + ux * k, P.z + uz * k, yaw], [P.x + ux * k - uz * 2, P.z + uz * k + ux * 2, yaw]]);
      const p = this.standPoint(cands);
      const peak = pk.name || 'Legacy';
      if (p) out.push({ id: `patrol:${pk.id || peak}`, kind: 'patrol', role: 'patrol', npc: true, label: `Ski patrol · ${peak}`, to: `the ${peak} ski patrol`, place: `the ${peak} patrol hut`, peak, ...p });
    }
    // lift operators beside each station (the side away from the exit path first)
    for (const l of this.lifts) {
      for (const top of [false, true]) {
        const S = top ? l.top : l.bottom, half = STATION[l.type] * 0.5 + (l.type === 'gondola' ? 3.5 : 3);
        const cands = [];
        for (const s of [1, -1]) for (const along of [0, 3, -3]) for (const k of [0, 2]) {
          const x = S.x - l.side.x * s * (half + k) + l.dir.x * along, z = S.z - l.side.z * s * (half + k) + l.dir.z * along;
          cands.push([x, z, Math.atan2(-l.side.x * s, -l.side.z * s)]); // facing out, away from the building
        }
        const p = this.standPoint(cands, { station: true });
        const where = top ? 'top' : 'base';
        if (p) out.push({ id: `lift:${l.name}:${where}`, kind: 'lift', role: 'operator', npc: true, label: `${l.name} · ${where}`, to: `the ${l.name} ${where} station`, place: `the ${l.name} ${where} station`, lift: l.name, top, ...p });
      }
    }
    // race starters beside the start platform (opposite the course sign)
    for (const r of L.races) {
      if (!r.main || !r.path || r.path.length < 4) continue;
      const dx = r.path[3][0] - r.path[0][0], dz = r.path[3][1] - r.path[0][1], dl = hyp(dx, dz) || 1;
      const fx = dx / dl, fz = dz / dl, rx = -fz, rz = fx;
      const cands = [];
      for (const k of [10.5, 12.5]) for (const back of [0, 3]) cands.push([r.start.x - rx * k - fx * back, r.start.z - rz * k - fz * back, Math.atan2(rx, rz)]);
      const p = this.standPoint(cands);
      if (p) out.push({ id: `race:${r.name}`, kind: 'race', role: 'starter', npc: true, label: `${r.name} · start`, to: `the ${r.name} start`, place: `the ${r.name} start`, race: r.name, ...p });
    }
    // Legacy Park: the park crew at the drop-in
    const park = L.park;
    if (park?.drop && Number.isFinite(park.fx)) {
      const d = park.drop, cands = [];
      for (const s of [1, -1]) for (const k of [8, 10]) cands.push([d.x + park.rx * k * s - park.fx * 3, d.z + park.rz * k * s - park.fz * 3, Math.atan2(-park.rx * s, -park.rz * s)]);
      const p = this.standPoint(cands);
      if (p) out.push({ id: 'park', kind: 'park', role: 'crew', npc: true, label: 'Legacy Park', to: 'the Legacy Park drop-in', place: 'Legacy Park', ...p });
    }
    // the job boards themselves (mail and lost property end up there)
    for (const h of this.hubs) {
      out.push({ id: `board:${h.id}`, kind: 'board', role: null, npc: false, hubId: h.id, label: `Job board · ${h.name}`,
        to: h.kind === 'village' ? 'the village job board' : `the job board at ${h.place}`, place: h.place, x: h.front.x, z: h.front.z, yaw: h.yaw });
    }
    return out;
  }

  // ---------------------------------------------------------------- piste-side spots
  // A few metres in from the piste edge (clear of the border markers, nets and snowbanks outside it),
  // never above a drop, never on a station pad, a race start or under a gate.
  findSpots() {
    const out = [];
    for (const p of this.layout.pistes) {
      if (!p.pts || p.pts.length < 8 || p.park) continue;
      const w = PISTE_W[p.diff] ?? 18, inset = w >= 20 ? 4.5 : 3;
      const acc = arcLengths(p.pts), Lp = acc[acc.length - 1];
      for (let s = 90, k = 0; s < Lp - 110; s += 45, k++) {
        const q = sampleAt(p.pts, acc, s);
        for (const side of [1, -1]) {
          const rx = -q.dz * side, rz = q.dx * side; // toward this side's edge
          const x = q.x + rx * (w - inset), z = q.z + rz * (w - inset);
          if (world.padInfluence(x, z) > 0.05 || dangerEdge(q.x + rx * (w + 0.5), q.z + rz * (w + 0.5), rx, rz)) continue;
          if (!this.ok(x, z, { slope: SIDEHILL, clear: 2.5 })) continue;
          const c = world.corridorAt(x, z, this.c);
          if (c.d > -1.5) continue; // well inside the groomed snow
          out.push({ x, z, heading: Math.atan2(q.dx, q.dz), side, piste: p.name, diff: p.diff, s: Math.round(s) });
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- lost & found search areas
  findAreas() {
    const out = [];
    for (const l of this.lifts) {
      const c = { x: l.topExit.x + l.dir.x * 6, z: l.topExit.z + l.dir.z * 6 };
      if (this.ok(c.x, c.z, { slope: SIDEHILL, clear: 1 })) out.push({ x: c.x, z: c.z, r: 14, label: `${l.name} top`, place: `the top of the ${l.name}` });
    }
    for (const p of this.layout.pistes) {
      if (!p.pts || p.pts.length < 8 || p.park) continue;
      const acc = arcLengths(p.pts), Lp = acc[acc.length - 1];
      for (const f of [0.3, 0.55, 0.8]) {
        const q = sampleAt(p.pts, acc, Lp * f);
        if (this.ok(q.x, q.z, { slope: SIDEHILL, clear: 2 }) && world.padInfluence(q.x, q.z) < 0.05) {
          out.push({ x: q.x, z: q.z, r: Math.min(20, (PISTE_W[p.diff] ?? 18) - 2), label: `${p.name} piste`, place: `the ${p.name} piste`, piste: p.name });
        }
      }
    }
    return out;
  }

  // A spot for the lost item inside an area (deterministic for a given rnd). Null if none fits.
  itemSpot(area, rnd) {
    for (let i = 0; i < 40; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * area.r * 0.85;
      const x = area.x + Math.cos(a) * r, z = area.z + Math.sin(a) * r;
      if (this.ok(x, z, { slope: SIDEHILL, clear: 1.2 })) return { x, z, yaw: rnd() * Math.PI * 2 };
    }
    return null;
  }

  // Spot to stand beside a board (escort guests wait there).
  besideBoard(hub) {
    const fx = Math.sin(hub.yaw), fz = Math.cos(hub.yaw), rx = fz, rz = -fx;
    const cands = [[1.7, 1.5], [-1.7, 1.5], [0, 2.6], [2.4, 0.4], [-2.4, 0.4]].map(([a, b]) => [hub.x + rx * a + fx * b, hub.z + rz * a + fz * b, hub.yaw]);
    for (const [x, z, yaw] of cands) if (this.ok(x, z, { slope: 0.3, clear: 0.5 })) return { x, z, yaw };
    return { x: hub.front.x + fx * 1.2, z: hub.front.z + fz * 1.2, yaw: hub.yaw };
  }
}

// stable id of a mountain hut (its name; its position when it has none)
const hutId = (hut) => (hut.name ? `hut:${hut.name}` : `hut:${Math.round(hut.x)},${Math.round(hut.z)}`);

// Steep drop beyond a piste edge (where the resort puts B-nets): same test as the resort dressing.
function dangerEdge(ex, ez, rx, rz) {
  const he = world.height(ex, ez);
  let steep = 0;
  for (const k of [6, 12, 20]) steep = Math.max(steep, (he - world.height(ex + rx * k, ez + rz * k)) / k);
  return steep > 0.7;
}

export function arcLengths(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return acc;
}
export function sampleAt(pts, acc, s) {
  let i = 1;
  while (i < pts.length - 1 && acc[i] < s) i++;
  const a = pts[i - 1], b = pts[i], l = acc[i] - acc[i - 1] || 1, t = Math.min(1, Math.max(0, (s - acc[i - 1]) / l));
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / l, dz: (b[1] - a[1]) / l };
}
