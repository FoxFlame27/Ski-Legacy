#include "core/noise.h"

namespace sl {

static inline uint32_t imul(int64_t a, int64_t b) { return uint32_t(a) * uint32_t(b); }

double hash2(int32_t x, int32_t y, int32_t seed) {
  // (JS: Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647), summed as doubles of int32
  // values, then Math.imul(h ^ (h >>> 13), ...) truncates back to int32: summing in uint32 gives the same bits)
  uint32_t h = imul(x, 374761393) + imul(y, 668265263) + imul(seed, 2147483647);
  h = imul(int32_t(h ^ (h >> 13)), 1274126177);
  h ^= h >> 16;
  return double(h) / 4294967296.0;
}

static const double F2 = 0.5 * (std::sqrt(3.0) - 1);
static const double G2 = (3 - std::sqrt(3.0)) / 6;
static const float GRAD[16] = {1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1};

Simplex::Simplex(uint32_t seed) {
  Mulberry32 rnd(seed);
  uint8_t p[256];
  for (int i = 0; i < 256; i++) p[i] = uint8_t(i);
  for (int i = 255; i > 0; i--) {
    int j = int(std::floor(rnd.next() * (i + 1)));
    std::swap(p[i], p[j]);
  }
  for (int i = 0; i < 512; i++) {
    perm_[i] = p[i & 255];
    permMod8_[i] = perm_[i] & 7;
  }
}

double Simplex::noise(double xin, double yin) const {
  const uint8_t* perm = perm_;
  const uint8_t* pm = permMod8_;
  double s = (xin + yin) * F2;
  double fi = std::floor(xin + s), fj = std::floor(yin + s);
  double t = (fi + fj) * G2;
  double x0 = xin - (fi - t), y0 = yin - (fj - t);
  int i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  double x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  double x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  // (JS: i & 255 on a double converts through int32)
  int ii = int(int32_t(int64_t(fi))) & 255, jj = int(int32_t(int64_t(fj))) & 255;
  double n = 0;
  double t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    int g = pm[ii + perm[jj]] * 2;
    t0 *= t0; n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
  }
  double t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    int g = pm[ii + i1 + perm[jj + j1]] * 2;
    t1 *= t1; n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
  }
  double t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    int g = pm[ii + 1 + perm[jj + 1]] * 2;
    t2 *= t2; n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
  }
  return 70 * n;
}

double Simplex::fbm(double x, double y, double octaves, double lac, double gain, double fullOct) const {
  if (fullOct < 0) fullOct = octaves;
  double a = 1, f = 1, sum = 0, norm = 0;
  int n = int(std::ceil(fullOct));
  for (int o = 0; o < n; o++) {
    double k = std::min(1.0, std::max(0.0, octaves - o));
    if (k > 0) sum += a * k * noise(x * f, y * f);
    norm += a; a *= gain; f *= lac;
  }
  return sum / norm;
}

double Simplex::ridged(double x, double y, double octaves, double lac, double gain, double fullOct) const {
  if (fullOct < 0) fullOct = octaves;
  double a = 1, f = 1, sum = 0, norm = 0, w = 1;
  int n = int(std::ceil(fullOct));
  for (int o = 0; o < n; o++) {
    double k = std::min(1.0, std::max(0.0, octaves - o));
    if (k > 0) {
      double v = noise(x * f, y * f);
      double nn = 1 - std::sqrt(v * v + 0.012);
      nn *= nn;
      nn *= w;
      w = std::min(1.0, std::max(0.0, nn * 1.6));
      sum += a * (k * nn + (1 - k) * 0.45 * w);
    } else sum += a * 0.45 * w;
    norm += a; a *= gain; f *= lac;
  }
  return sum / norm;
}

} // namespace sl
