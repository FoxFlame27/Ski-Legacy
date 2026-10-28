// Crash damage you can see (drive.js): every knock leaves a dent where it hit (the body pushed in round the impact, a
// crumple of a few cm to ~20 cm, wider and deeper the harder the hit; the panel's shading follows the dent), the lamps
// at that corner smashed (dark, they never light again), and from 40 % on steam from the bonnet (drive.js). Kept on
// the car (e.dents, in its own frame): every look of it (the parked one, the driven one, the full-detail cockpit one)
// carries the same dents, until it is towed and repaired. Works on any model (the geometry, not per-model data).
import * as THREE from 'three';

const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _d = new THREE.Vector3();

/** A dent on car e: where (car frame: the impact's direction from the car's middle, dx / dz) and how hard (0..1). */
export function addDent(e, dirX, dirZ, hard, size) {
  const hw = size.x / 2, hl = size.z / 2, l = Math.hypot(dirX, dirZ) || 1, ux = dirX / l, uz = dirZ / l;
  // the point on the car's outline in that direction, at bumper / wing height
  const s = Math.min(hw / Math.max(1e-3, Math.abs(ux)), hl / Math.max(1e-3, Math.abs(uz)));
  const dent = { x: ux * s, y: Math.min(0.62, size.y * 0.42), z: uz * s, ux, uz, r: 0.42 + 0.5 * hard, depth: 0.05 + 0.17 * hard, seed: Math.random() * 100 };
  (e.dents ||= []).push(dent);
  if (e.dents.length > 12) e.dents.shift();
  return dent;
}

/** Bring an instance (cars.js carInstance) up to date with e.dents (idempotent: only the new ones are applied). */
export function applyDents(inst, e) {
  const list = e?.dents;
  if (!inst || !list?.length) return;
  const done = inst.dentsDone || 0;
  if (done >= list.length) return;
  for (let k = done; k < list.length; k++) dentInstance(inst, list[k]);
  inst.dentsDone = list.length;
}
/** Back to new (towed and repaired): the shared geometry back on every part. */
export function repairInstance(inst) {
  if (!inst?.full) return;
  for (const o of inst.full.children) if (o.isMesh && o.userData.srcGeo) { o.geometry.dispose(); o.geometry = o.userData.srcGeo; delete o.userData.srcGeo; }
  for (const l of inst.lamps?.list || []) if (l.broken) { l.broken = false; l.boost = l.boost0; l.m.color.copy(l.color0); }
  if (inst.lamps) inst.lamps.key = '';
  inst.dentsDone = 0;
}

function dentInstance(inst, D) {
  const P = _p.set(D.x, D.y, D.z), R = D.r, R2 = R * R;
  const into = _d.set(-D.ux, 0, -D.uz);
  for (const o of inst.full.children) {
    if (!o.isMesh || !o.geometry?.attributes?.position) continue;
    const g0 = o.userData.srcGeo || o.geometry;
    g0.computeBoundingBox?.();
    const bb = g0.boundingBox;
    if (bb && (P.x < bb.min.x - R || P.x > bb.max.x + R || P.z < bb.min.z - R || P.z > bb.max.z + R || P.y < bb.min.y - R || P.y > bb.max.y + R)) continue;
    // (the parts are shared by every car of the model: this car's own copy, once)
    if (!o.userData.srcGeo) { o.userData.srcGeo = o.geometry; o.geometry = o.geometry.clone(); }
    const pos = o.geometry.attributes.position, nor = o.geometry.attributes.normal;
    let moved = false;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), dx = x - P.x, dy = (y - P.y) * 1.3, dz = z - P.z, q = dx * dx + dy * dy + dz * dz;
      if (q >= R2) continue;
      const f = 1 - q / R2, w = f * f; // (a smooth bowl, deepest at the impact)
      // a crumple, not a perfect bowl: a little noise in it
      const n = 0.75 + 0.25 * Math.sin(x * 23 + D.seed) * Math.sin(y * 19 + z * 17 + D.seed * 0.7);
      const k = D.depth * w * n;
      pos.setXYZ(i, x + into.x * k, y - k * 0.25, z + into.z * k);
      if (nor) {
        // the shading of the dent: the normal tipped toward the dent's middle (its slope), more where it is steepest
        const tip = Math.min(0.9, (D.depth * 4 * f) / R);
        _n.set(nor.getX(i), nor.getY(i), nor.getZ(i)).addScaledVector(_n.clone().set(-dx, -dy, -dz).normalize(), tip * Math.sqrt(q) / R).normalize();
        nor.setXYZ(i, _n.x, _n.y, _n.z);
      }
      moved = true;
    }
    if (moved) { pos.needsUpdate = true; if (nor) nor.needsUpdate = true; o.geometry.computeBoundingSphere(); }
  }
  // the lamps at that corner: smashed (dark lenses, never lit again)
  for (const l of inst.lamps?.list || []) {
    if (l.broken) continue;
    const mesh = inst.full.children.find((o) => o.material === l.m);
    const bs = mesh?.geometry?.boundingSphere || (mesh?.geometry?.computeBoundingSphere(), mesh?.geometry?.boundingSphere);
    if (!bs) continue;
    // (one lamp mesh is both sides of the car: smashed only when the hit is at its end and hard)
    const sameEnd = Math.sign(bs.center.z) === Math.sign(D.z) && Math.abs(D.z) > 1.2;
    if (!sameEnd || D.depth < 0.1 || bs.center.distanceTo(P) > R + bs.radius) continue;
    l.broken = true; l.boost0 ??= l.boost; l.color0 ??= l.m.color.clone();
    l.boost = 0; l.m.color.multiplyScalar(0.35);
  }
  if (inst.lamps) inst.lamps.key = ''; // (lampsOn sets them again)
}
