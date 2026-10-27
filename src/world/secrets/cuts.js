// Terrain shaping for the secrets (and anything else that needs a tunnel, a cut or a shaped trail): each builder
// returns world cut objects ({ bounds, apply, covered?, forest? }, see world.addCut). Everything is a function of
// the projection onto a Path (arc length s, signed lateral offset d), so cuts follow curved lines exactly.
//
//   tunnelCuts(path, spec)  -> { approach, mound, slot }   the cuttings in front of the portals + a rock mound
//                                               where the cover is thin (open) and the trench under the lid (slot,
//                                               covered: coarse LODs and world.outsideHeight skip it)
//   trenchCut(path, spec)   -> cut              an open slot with rock walls (couloir, notch, approach)
//   shapeCut(path, spec)    -> cut              a rideable floor blended into the terrain (hidden trail, run-out)
//   ridgeFill(path, spec)   -> cut              raises a natural rock spur / ridge along a line (cover, hiding)
import { Simplex, smoothstep, clamp } from '../../core/noise.js';
import { skinWallOffset } from './rock.js';

const N = new Simplex(4401), N2 = new Simplex(4402);
const P = {}; // projection scratch (cuts run one at a time)

const boundsOf = (path, pad) => ({ minx: path.bounds.minx - pad, minz: path.bounds.minz - pad, maxx: path.bounds.maxx + pad, maxz: path.bounds.maxz + pad });

// Rock relief on cut walls: the foot line wavers and the wall height varies, with ledges (only near the camera's
// LOD: a coarse mesh can't hold them). Returns [lateral wobble (m), height relief (m)].
function rock(x, z, spacing, amp = 1) {
  const fine = spacing < 6 ? 1 : 0;
  const wob = (N.noise(x * 0.06 + 3.1, z * 0.06 - 1.7) * 1.1 + N2.noise(x * 0.17, z * 0.17) * 0.45 * fine) * amp;
  const rel = (N2.noise(x * 0.045 - 7.3, z * 0.045 + 2.2) * 2.2 + Math.abs(N.noise(x * 0.13 + 1.9, z * 0.13)) * 1.6 * fine) * amp;
  return [wob, rel];
}

/**
 * A tunnel, cut-and-cover style, its portals at the back of cuttings with rock / ice walls:
 *  - approach (open): from each cutting's mouth (s0 / s1: there the floor meets the terrain) to the portal planes
 *    (sF0 / sF1): the floor between steep heightfield walls set back `gap` m behind the cutting's skins (rock.js,
 *    floor half-width half(s), leaning back at kS); the cut eases in over `ease` m at the mouth
 *  - mound (open): wherever the rock over the tube is thinner than `cover`, a natural rock mound with a flat top
 *    and rocky flanks rises over it (between the portal planes)
 *  - slot (covered): the trench along the tube between the portal planes, leaning walls like the cutting's for
 *    `lean` m behind each plane (the lid closes the cutting's top there), vertical walls further in
 * spec: floor(s); sF0 / sF1; s0 / s1; Wi, Hc = tube half-width / crown; half(s); kS; gap; cover; flank.
 * Returns { approach, mound, slot, open, slotSurface(s, |d|) (the slot's own surface, Infinity outside it: the
 * lid's carving test), cw(s) (the heightfield wall's lateral offset), slotHalf }.
 */
export function tunnelCuts(path, spec) {
  const { floor, sF0, sF1, s0, s1, Wi = 4, Hc = 5, cover = 1.7, flank = 1.15, kS = 3.2, gap = 1.6, ease = 6, rough = 1, lean = 3 } = spec;
  const halfFn = spec.half || (() => Wi + 1.8);
  const cw = (s) => skinWallOffset(halfFn(s), gap);
  const cwF0 = cw(sF0), cwF1 = cw(sF1), slotHalf = Math.max(cwF0, cwF1);
  const topHalf = Wi + 1.4;
  const reach = slotHalf + 70 / kS + 6;
  const approach = {
    bounds: boundsOf(path, reach),
    apply(x, z, h) {
      if (this.off) return h;
      const p = path.project(x, z, P);
      if (p.dist === Infinity) return h;
      const s = p.s;
      // (the cut fades in / out beyond the mouths, where the snow is already at about the floor: no bump)
      let k;
      if (s >= s0 - ease && s <= sF0) k = smoothstep(s0 - ease, s0, s);
      else if (s >= sF1 && s <= s1 + ease) k = 1 - smoothstep(s1, s1 + ease, s);
      else return h;
      if (k <= 0) return h;
      const u = Math.abs(p.d) - cw(s);
      const t = floor(s) + (u > 0 ? u * kS : 0);
      return t < h ? h + (t - h) * k : h;
    },
  };
  const slotSurface = (s, ad) => {
    if (s < sF0 - 0.3 || s > sF1 + 0.3) return Infinity;
    const y = floor(s);
    if (s < sF0 + lean) { const u = ad - cwF0; return y + (u > 0 ? u * kS : 0); }
    if (s > sF1 - lean) { const u = ad - cwF1; return y + (u > 0 ? u * kS : 0); }
    return y + Math.max(0, ad - slotHalf) * 40;
  };
  const mound = {
    bounds: boundsOf(path, topHalf + 40 / flank),
    apply(x, z, h, spacing) {
      if (this.off) return h;
      const p = path.project(x, z, P);
      if (p.dist === Infinity || p.s < sF0 + 1 || p.s > sF1 - 1) return h;
      const s = p.s, ad = Math.abs(p.d);
      const k = smoothstep(sF0 + 1, sF0 + 6, s) * (1 - smoothstep(sF1 - 6, sF1 - 1, s));
      if (k <= 0) return h;
      const [wob, rel] = rock(x, z, spacing, rough);
      const u = Math.max(0, ad - topHalf - wob * 0.5);
      const t = floor(s) + Hc + cover + (rel * 0.35 + 0.6) * smoothstep(0, 3, u) - u * flank * (1 + 0.25 * N.noise(s * 0.05, 1.3));
      const m = h + (t - h) * k;
      return m > h ? m : h;
    },
  };
  const slot = {
    covered: true,
    bounds: boundsOf(path, reach),
    apply(x, z, h) {
      if (this.off) return h;
      const p = path.project(x, z, P);
      if (p.dist === Infinity) return h;
      const t = slotSurface(p.s, Math.abs(p.d));
      return t < h ? t : h;
    },
  };
  return { approach, mound, slot, open: [approach, mound], slotSurface, cw, slotHalf, reach };
}

/**
 * An open slot along a path between rock walls (a couloir between cliffs, a notch through a ridge).
 * spec: floor(s); s0 / s1 = active range (the cut eases in / out over `ease` m); half(s) or number = floor
 * half-width; wallK = wall steepness; rough = wall relief; sideK?: [left, right] steepness factors.
 */
export function trenchCut(path, spec) {
  const { floor, s0 = 0, s1 = path.length, wallK = 2.2, rough = 1, ease = 12, maxDepth = 120 } = spec;
  const halfFn = typeof spec.half === 'function' ? spec.half : () => spec.half ?? 5;
  const reach = 30 + maxDepth / wallK;
  return {
    bounds: boundsOf(path, reach),
    apply(x, z, h, spacing) {
      if (this.off) return h;
      const p = path.project(x, z, P);
      if (p.dist === Infinity || p.s < s0 - 1 || p.s > s1 + 1) return h;
      const s = p.s, ad = Math.abs(p.d);
      const k = smoothstep(s0 - 1, s0 + ease, s) * (1 - smoothstep(s1 - ease, s1 + 1, s));
      const [wob, rel] = rock(x, z, spacing, rough);
      const w = halfFn(s) * (0.6 + 0.4 * k) + wob;
      const u = ad - w;
      const sideK = spec.sideK ? spec.sideK[p.d < 0 ? 0 : 1] : 1;
      const t = floor(s) + (u > 0 ? u * wallK * sideK + rel * smoothstep(0, 5, u) : 0) + (1 - k) * 60;
      return t < h ? t : h;
    },
  };
}

/**
 * A rideable floor blended into the terrain: within `half` of the line the snow lies at floor(s) (cut or filled),
 * easing back to the natural terrain over `blend` m (both sides, or per side with blendL / blendR). mode: 'both' |
 * 'cut' (only lowers) | 'fill' (only raises). The ends ease in and out over `ease` m. Optional `bank` tilts it.
 */
export function shapeCut(path, spec) {
  const { floor, s0 = 0, s1 = path.length, half = 4, blend = 10, mode = 'both', ease = 16, wave = 0 } = spec;
  const blendL = spec.blendL ?? blend, blendR = spec.blendR ?? blend;
  return {
    bounds: boundsOf(path, half + Math.max(blendL, blendR) + 4),
    apply(x, z, h) {
      if (this.off) return h;
      const p = path.project(x, z, P);
      if (p.dist === Infinity || p.s < s0 - 1 || p.s > s1 + 1) return h;
      const k = smoothstep(s0 - 1, s0 + ease, p.s) * (1 - smoothstep(s1 - ease, s1 + 1, p.s));
      if (k <= 0) return h;
      const ad = Math.abs(p.d), bl = p.d < 0 ? blendL : blendR;
      const w = half + (wave ? N.noise(p.s * 0.03, 7.7) * wave : 0);
      if (ad > w + bl) return h;
      const y = floor(p.s);
      const t = smoothstep(w, w + bl, ad); // 0 on the floor, 1 where the natural terrain takes over
      let out = y + (h - y) * t;
      out = h + (out - h) * k;
      if (mode === 'cut') return Math.min(h, out);
      if (mode === 'fill') return Math.max(h, out);
      return out;
    },
  };
}

/**
 * Raises a natural rock spur / ridge along a line: crest height above the floor top(s) at the line, falling away
 * at `flank` steepness (m down per m out) with rock relief. Only raises the terrain (max).
 */
export function ridgeFill(path, spec) {
  const { top, s0 = 0, s1 = path.length, flank = 1.2, rough = 1.5, ease = 20 } = spec;
  const reach = spec.reach ?? 60;
  return {
    bounds: boundsOf(path, reach),
    apply(x, z, h, spacing) {
      if (this.off) return h;
      const p = path.project(x, z, P);
      if (p.dist === Infinity || p.s < s0 - 1 || p.s > s1 + 1) return h;
      const k = smoothstep(s0 - 1, s0 + ease, p.s) * (1 - smoothstep(s1 - ease, s1 + 1, p.s));
      const [, rel] = rock(x, z, spacing, rough);
      const t = top(p.s) - p.dist * flank * (1.2 - 0.2 * k) + rel - (1 - k) * 40;
      return t > h ? t : h;
    },
  };
}

/** forest density along a line: a band of dense trees either side of a clear lane (the hidden forest trail) */
export function forestBand(path, { clear = 4, band = 26, density = 0.9, s0 = 0, s1 = path.length } = {}) {
  return (x, z, f) => {
    const p = path.project(x, z, P);
    if (p.dist === Infinity || p.s < s0 || p.s > s1) return f;
    const ad = Math.abs(p.d);
    if (ad < clear) return 0;
    const k = smoothstep(clear, clear + 3, ad) * (1 - smoothstep(band * 0.6, band, ad));
    return Math.max(f, density * k);
  };
}

export { clamp };
