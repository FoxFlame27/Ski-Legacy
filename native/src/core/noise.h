// Seeded 2D simplex noise + fractal helpers + deterministic hashing.
// Exact port of src/core/noise.js: same permutation (mulberry32), same arithmetic in double precision and the same
// 32-bit integer wrap-around as Math.imul, so the C++ world produces the same heights as the JavaScript one.
#pragma once
#include <cstdint>
#include <cmath>
#include <algorithm>

namespace sl {

/// mulberry32 PRNG (returns [0, 1)), identical sequence to noise.js.
class Mulberry32 {
public:
  explicit Mulberry32(uint32_t seed) : a_(seed) {}
  double next() {
    a_ += 0x6d2b79f5u;
    uint32_t t = a_;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return double(t ^ (t >> 14)) / 4294967296.0;
  }
private:
  uint32_t a_;
};

/// Integer hash of a lattice point -> [0, 1) (noise.js hash2).
double hash2(int32_t x, int32_t y, int32_t seed = 0);

class Simplex {
public:
  explicit Simplex(uint32_t seed = 1);
  double noise(double x, double y) const;
  /// Fractal sum; `octaves` may be fractional (band-limited LOD sampling), normalised with `fullOct`.
  double fbm(double x, double y, double octaves = 4, double lac = 2.0, double gain = 0.5, double fullOct = -1) const;
  /// Ridged multifractal in [0, 1].
  double ridged(double x, double y, double octaves = 5, double lac = 2.05, double gain = 0.5, double fullOct = -1) const;
private:
  uint8_t perm_[512];
  uint8_t permMod8_[512];
};

inline double smoothstep(double a, double b, double x) {
  double t = std::min(1.0, std::max(0.0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
inline double lerp(double a, double b, double t) { return a + (b - a) * t; }
inline double clamp(double x, double a, double b) { return x < a ? a : (x > b ? b : x); }

} // namespace sl
