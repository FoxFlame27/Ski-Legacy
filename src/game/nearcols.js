// The colliders round a moving thing (Nov 1 2026 perf pass, the user: "now I'm getting 10 fps while in a car"). The
// world's collider list is one flat array of thousands (the village's props, the piste markers, the lamps, the signs,
// buildings, nets...): your car went over all of them three times a physics sub-step (up to 18 times a frame), a
// knocked traffic car up to 9 times a frame. Each user keeps a cache instead: the colliders within R m of where it was
// (one pass over the list every `every` s, once it has moved `move` m, or when colliders were added / removed) and
// tests only those. Anything that moves (traffic, buses, snowcats) is covered by the slack between R and the query
// reach plus the distance moved: a query within `slack` m of the cache's centre takes the list, else the whole array.
// (police.js nearCols does the same for the patrol cars.)
const EMPTY = [];

/**
 * @param {object} cache  per-user state ({} to start)
 * @param {Array} all     the world's colliders
 * @param {number} x, z   the query point
 * @param {number} reach  how far from (x, z) the query looks (its radius + margin)
 * @param {number} now    a clock in seconds (any monotonic one)
 */
export function nearColliders(cache, all, x, z, reach, now, { R = 70, every = 0.15, move = 12, skip = null } = {}) {
  if (!all?.length) return EMPTY;
  const C = cache;
  if (C.list === undefined || C.a !== all || now - C.t > every || now < C.t || C.n !== all.length || Math.abs(x - C.x) > move || Math.abs(z - C.z) > move) {
    const L = (C.list ||= []);
    L.length = 0; C.a = all; C.x = x; C.z = z; C.t = now; C.n = all.length;
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (skip && skip(c)) continue;
      const E = R + (c.r ?? Math.max(c.hw || 0, c.hd || 0));
      if (Math.abs(c.x - x) <= E && Math.abs(c.z - z) <= E) L.push(c);
    }
  }
  // (slack: R less how far the query reaches and how far the cache's centre may be from it; 70 - 12 - 4 = 54 m in
  // 0.15 s is far beyond anything that drives)
  return Math.abs(x - C.x) + reach <= R - 4 && Math.abs(z - C.z) + reach <= R - 4 ? C.list : all;
}
