// Seeded 2D simplex noise + fractal helpers + deterministic hashing.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

export class Simplex {
  constructor(seed = 1) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] & 7;
    }
  }

  noise(xin, yin) {
    const perm = this.perm, pm = this.permMod8;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj]] * 2;
      t0 *= t0; n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1; n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2; n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * n; // ~[-1, 1]
  }

  // octaves may be fractional: the last octave fades in (used for band-limited LOD sampling).
  // The normalization always uses `fullOct` so amplitude doesn't change between LODs.
  fbm(x, y, octaves = 4, lac = 2.0, gain = 0.5, fullOct = octaves) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < Math.ceil(fullOct); o++) {
      const k = Math.min(1, Math.max(0, octaves - o));
      if (k > 0) sum += a * k * this.noise(x * f, y * f);
      norm += a; a *= gain; f *= lac;
    }
    return sum / norm;
  }

  // Ridged multifractal in [0, 1]: sharp crests like real alpine ridgelines.
  ridged(x, y, octaves = 5, lac = 2.05, gain = 0.5, fullOct = octaves) {
    let a = 1, f = 1, sum = 0, norm = 0, w = 1;
    for (let o = 0; o < Math.ceil(fullOct); o++) {
      const k = Math.min(1, Math.max(0, octaves - o));
      if (k > 0) {
        const v = this.noise(x * f, y * f);
        let n = 1 - Math.sqrt(v * v + 0.012); // soft crease: sharp crests without knife-edge cliffs
        n *= n;
        n *= w;
        w = Math.min(1, Math.max(0, n * 1.6));
        // a missing octave contributes its mean (~0.45 * w) so average height is preserved
        sum += a * (k * n + (1 - k) * 0.45 * w);
      } else sum += a * 0.45 * w;
      norm += a; a *= gain; f *= lac;
    }
    return sum / norm;
  }
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
