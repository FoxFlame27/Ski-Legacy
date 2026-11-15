// The eight cloud shapes of atmosphere.js's impostor atlas (CELLS): five cumulus banks / heaps grown like a
// cauliflower from spheres, two stratocumulus sea patches and a wisp. The renderer ray-marches them into the atlas;
// world/clouds reads each cell's visible top and quad trim. (grow / cumulus / seaPatch: the same mulberry32 draws in
// the same order as the JS, so the spheres are identical.)
#pragma once
#include "core/math.h"
#include "core/noise.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace sl {

/// one card: a (base centre xyz, mirror), b (width, height, atlas cell, opacity), c (contact softness, storm, trim, ring)
struct CloudCard { dvec3 pos{0}; float mirror = 1; vec4 b{0}, c{0}; };
/// what the renderer draws this frame
struct CloudFrame {
  std::vector<CloudCard> cards;          // far -> near
  float cover = 0, cloudH = 620, deckAbove = 1;
  bool lean = false;                     // (the graphics preset: the deck's two middle layers only)
  dvec2 drift{0};                        // the free clouds' wind drift (m): the deck's noise moves with it
  // the terrain height map (toroidal: world cell (I, J) at texel (I mod N, J mod N)); dirty: upload it
  std::vector<float> tmap;
  bool tmapDirty = false;
};

struct CloudShape {
  std::vector<std::array<double, 4>> S;   // spheres x, y, z, r (cell volume: x -1..1, y 0..1, z -0.5..0.5)
  int kind = 0;                          // 0 cumulus, 1 sea patch, 2 wisp
  float flat = 1, top = 0, trim = 0;
};

namespace cloudshape_detail {
inline void grow(Mulberry32& rnd, std::vector<std::array<double, 4>>& S, int levels, double shrinkMin, double shrinkMax, double upBias) {
  size_t a = 0, b = S.size();
  for (int l = 0; l < levels; l++) {
    size_t start = S.size();
    for (size_t i = a; i < b; i++) {
      const double px = S[i][0], py = S[i][1], pz = S[i][2], pr = S[i][3];
      const int kids = 1 + int(std::floor(rnd.next() * 2.4));
      for (int k = 0; k < kids; k++) {
        double dx = (rnd.next() - 0.5) * 2;
        double dy = upBias + rnd.next() * (1 - upBias);
        double dz = (rnd.next() - 0.5) * 1.6;
        const double dl = std::sqrt(dx * dx + dy * dy + dz * dz);
        dx /= dl; dy /= dl; dz /= dl;
        const double r = pr * (shrinkMin + rnd.next() * (shrinkMax - shrinkMin));
        const double off = pr * (0.62 + rnd.next() * 0.25);
        const double x = px + dx * off, y = py + dy * off, z = pz + dz * off;
        if (std::fabs(x) + r > 0.94 || y + r > 0.93 || std::fabs(z) + r > 0.46) continue;
        S.push_back({x, y, z, r});
      }
    }
    a = start; b = S.size();
  }
}
inline std::vector<std::array<double, 4>> cumulus(uint32_t seed, int n0, double rMin, double rMax, double spread, int levels, double mound, double upBias) {
  Mulberry32 rnd(seed);
  std::vector<std::array<double, 4>> S;
  for (int i = 0; i < n0; i++) {
    const double x = (((i + 0.5) / n0) * 2 - 1) * spread + (rnd.next() - 0.5) * 0.1;
    const double r = (rMin + rnd.next() * (rMax - rMin)) * (1 - mound * std::min(1.0, (x * x) / (spread * spread)));
    const double z = (rnd.next() - 0.5) * 0.16;
    S.push_back({x, r * 0.72, z, r});
  }
  grow(rnd, S, levels, 0.48, 0.7, upBias);
  return S;
}
inline std::vector<std::array<double, 4>> seaPatch(uint32_t seed, int n0) {
  Mulberry32 rnd(seed);
  std::vector<std::array<double, 4>> S;
  for (int i = 0; i < n0; i++) {
    const double x = (((i + 0.5) / n0) * 2 - 1) * 0.78 + (rnd.next() - 0.5) * 0.08;
    const double r = (0.15 + rnd.next() * 0.08) * (1 - 0.5 * std::pow(std::fabs(x) / 0.8, 3));
    const double z = (rnd.next() - 0.5) * 0.34;
    S.push_back({x, r * 0.5, z, r});
  }
  grow(rnd, S, 1, 0.45, 0.62, 0.6);
  return S;
}
} // namespace cloudshape_detail

/// atlas cells: 0-4 cumulus banks / heaps, 5-6 cloud-sea patches, 7 wisp (2 x 4 cells of 512 x 256 in a 1024 atlas)
inline const std::vector<CloudShape>& cloudShapes() {
  static const std::vector<CloudShape> cells = [] {
    using namespace cloudshape_detail;
    std::vector<CloudShape> c(8);
    c[0].S = cumulus(11, 6, 0.24, 0.34, 0.62, 2, 0.55, 0.25);
    c[1].S = cumulus(23, 5, 0.26, 0.36, 0.55, 2, 0.6, 0.25);
    c[2].S = cumulus(37, 7, 0.2, 0.3, 0.7, 2, 0.35, 0.25);
    c[3].S = cumulus(41, 4, 0.28, 0.36, 0.45, 3, 0.7, 0.4);
    c[4].S = cumulus(53, 3, 0.26, 0.32, 0.28, 3, 0.4, 0.6);
    c[5].S = seaPatch(61, 14); c[5].kind = 1; c[5].flat = 0.6f;
    c[6].S = seaPatch(71, 16); c[6].kind = 1; c[6].flat = 0.6f;
    c[7].kind = 2; c[7].top = 0.56f; c[7].trim = 0.8f;
    for (int i = 0; i < 7; i++) {
      double m = 0;
      for (const auto& s : c[size_t(i)].S) m = std::max(m, double(s[1]) + double(s[3]) * c[size_t(i)].flat);
      c[size_t(i)].top = float(std::min(0.93, m + 0.02));
      c[size_t(i)].trim = float(std::min(1.0, c[size_t(i)].top * 1.1 + 0.05));
      if (c[size_t(i)].S.size() > 48) c[size_t(i)].S.resize(48);
    }
    return c;
  }();
  return cells;
}

} // namespace sl
