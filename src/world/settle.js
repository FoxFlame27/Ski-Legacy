// Settles placed props onto the ground as it is drawn, once, at the end of the boot (after every terrain edit:
// pads, cuts, roads and decks are all registered by then).
//
// Props are placed by their modules from the analytic height at one point (world.height at the centre, or the
// lowest of a few samples), so on a slope the downhill side of a flat-bottomed model hangs in the air, a prop set
// down before a later edit lowered the ground floats over the edit, and on a bump the terrain's 2 m mesh (straight
// chords between its vertices) can lie a few centimetres under the analytic surface. Each ground-standing prop
// (a direct child of a prop group: one placed object) is lowered until its base meets the lowest drawn ground
// under its footprint. Only lowered, never raised: props sunk into the snow on purpose (boulders, ramps, posts)
// stay as they are.
//
// Left alone: instanced meshes (their modules bed them per instance), tall structures (lift towers, station
// halls: their cables and decks line up with them), thin plates and the groups in `skip` (people, vehicles, the
// railway). A prop fixed to another one (userData.mountedOn: a nameboard on a facade) moves with its host.
import * as THREE from 'three';
import { world } from './world.js';

const STEP = 2; // the finest terrain mesh: one vertex every 2 m, triangles split along (1, 0)-(0, 1)

/** Height of the terrain as drawn (the finest mesh) at (x, z). */
export function drawnHeight(x, z) {
  const gx = Math.floor(x / STEP), gz = Math.floor(z / STEP), u = x / STEP - gx, v = z / STEP - gz;
  const a = world.height(gx * STEP, gz * STEP), b = world.height((gx + 1) * STEP, gz * STEP), c = world.height(gx * STEP, (gz + 1) * STEP);
  if (u + v < 1) return a + (b - a) * u + (c - a) * v;
  const d = world.height((gx + 1) * STEP, (gz + 1) * STEP);
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

// the ground a prop stands on: the drawn terrain, or a walkable deck (helipad, ramp) at about its level
function groundAt(x, z, yHint) {
  let h = drawnHeight(x, z);
  const arr = world.surfaceGrid?.get(Math.floor(x / 64) + ',' + Math.floor(z / 64));
  if (arr) for (const s of arr) { const hs = s.height(x, z); if (hs !== null && hs > h && hs <= yHint + 0.6) h = hs; }
  return h;
}

const _box = new THREE.Box3();

/** What the last pass lowered (dev checks): { name, x, z, drop } */
export const settled = [];

/**
 * @param {THREE.Object3D[]} groups  prop groups (their direct children are the placed props)
 * @param {(o: THREE.Object3D) => boolean} [skip]
 * @returns {{ checked: number, lowered: number, maxDrop: number }}
 */
export function settleProps(groups, skip = () => false) {
  const stats = { checked: 0, lowered: 0, maxDrop: 0 };
  const drops = new Map(), mounted = [];
  settled.length = 0;
  for (const g of groups) {
    if (!g) continue;
    g.updateMatrixWorld(true);
    for (const o of g.children) {
      if (o.isInstancedMesh || o.isLight || o.isPoints || o.isLine || o.isSprite || skip(o)) continue;
      if (o.userData.mountedOn) { mounted.push(o); continue; }
      _box.setFromObject(o);
      if (_box.isEmpty()) continue;
      const sx = _box.max.x - _box.min.x, sz = _box.max.z - _box.min.z, sy = _box.max.y - _box.min.y;
      if (sy > 15 || sx > 40 || sz > 40) continue;           // lift towers, halls, long merged runs
      if (Math.min(sx, sz) < 0.3 && sy < 1.6) continue;     // thin plates (facade signs)
      stats.checked++;
      // the lowest ground under the footprint (inset from the box: a turned model's box is wider than it is)
      let gmin = Infinity;
      for (const fx of [0.25, 0.5, 0.75]) for (const fz of [0.25, 0.5, 0.75]) {
        gmin = Math.min(gmin, groundAt(_box.min.x + sx * fx, _box.min.z + sz * fz, _box.min.y));
      }
      const gap = _box.min.y - gmin;
      if (gap <= 0.04 || gap > 4) continue; // resting already / mounted high on purpose
      const drop = gap + 0.03; // (bedded a few centimetres into the snow)
      o.position.y -= drop;
      o.updateMatrix();
      o.updateMatrixWorld(true);
      stats.lowered++;
      stats.maxDrop = Math.max(stats.maxDrop, drop);
      drops.set(o, drop);
      settled.push({ name: o.name || o.type, x: Math.round(o.position.x), z: Math.round(o.position.z), drop: +drop.toFixed(2) });
    }
  }
  for (const o of mounted) {
    const d = drops.get(o.userData.mountedOn);
    if (!d) continue;
    o.position.y -= d;
    o.updateMatrix();
    o.updateMatrixWorld(true);
  }
  stats.maxDrop = +stats.maxDrop.toFixed(2);
  return stats;
}
