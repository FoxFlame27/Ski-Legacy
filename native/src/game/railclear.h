// (debug: SKI_LEGACY_DEBUG=railclear) the trains' swept volume along both lines against everything the packs place:
// the baked meshes (resort, transport, the courses' nets, fences, ribbons, banners...) and the placed props. A point
// is inside when it is over a track (the Wolkenspitzbahn's, its passing loop's, the Legacy Express's two) within the
// car's half width (train.js CAR.hw 1.32 + 0.1) and between 0.25 m over the rail and the roof (CAR.roofTop 3.64 + 0.15).
// The lines' own structures (rails, sleepers, bed, tunnels, bridges, platforms, catenary) sit under, beside or over it.
#pragma once
#include "core/log.h"
#include "world/resort.h"
#include "world/transport.h"
#include <cmath>
#include <map>
#include <string>

namespace sl {

inline int railClearance(const Resort& resort, const Transport& T) {
  constexpr double HW = 1.32 + 0.1, LO = 0.25, HI = 3.64 + 0.15;
  int total = 0;
  for (int which = 0; which < 2; which++) {
    const Line* L = which == 0 ? (T.rail.ok ? &T.rail.line : nullptr) : (T.express.ok ? &T.express.line : nullptr);
    if (!L || L->n < 2) continue;
    const char* name = which == 0 ? "Wolkenspitzbahn" : "Legacy Express";
    const double reach = which == 0 ? 4.6 + HW + 1 : T.express.trackOff + HW + 1;
    auto inside = [&](const dvec3& p) {
      Line::Near n = L->nearest(p.x, p.z, reach + 1);
      if (n.d > reach) return false;
      const Line::P q = L->at(n.s);
      const double lat = (p.x - q.x) * -q.dz + (p.z - q.z) * q.dx, h = p.y - q.y;
      if (h < LO || h > HI) return false;
      // (train.js LOWER: the bogies under the skirt, the skirt from 0.52 m (half width 1.17), full width from 0.74 m)
      const double hw = h < 0.52 ? 1.0 : h < 0.74 ? 1.27 + 0.05 : HW;
      if (which == 0) { const double off = T.loopOffset(n.s); return std::fabs(lat) < hw || (off != 0 && std::fabs(lat - off) < hw); }
      return std::fabs(lat - T.express.trackOff) < hw || std::fabs(lat + T.express.trackOff) < hw;
    };
    // (the line's grid answers within 20 m of it: small boxes ask it, big ones (chunks) test the line's points)
    std::vector<dvec2> pts;
    for (int i = 0; i < L->n; i += 2) pts.push_back(dvec2(L->X[size_t(i)], L->Z[size_t(i)]));
    auto near = [&](const dvec3& mn, const dvec3& mx) {
      const dvec3 c = (mn + mx) * 0.5;
      const double r = glm::length(dvec2(mx.x - mn.x, mx.z - mn.z)) * 0.5;
      if (r + reach < 18) return L->nearest(c.x, c.z, r + reach + 1).d < r + reach;
      for (const dvec2& q : pts) if (q.x > mn.x - reach && q.x < mx.x + reach && q.y > mn.z - reach && q.y < mx.z + reach) return true;
      return false;
    };
    std::map<std::string, int> kinds;
    int hits = 0;
    resort.sweepClearance(near, inside, [&](const dvec3& p, const std::string& what) {
      Line::Near n = L->nearest(p.x, p.z, reach + 1);
      const Line::P q = L->at(n.s);
      SL_INFO("[railclear] %s s %7.1f: (%.1f, %.1f, %.1f) %.2f m over the rail, %+.2f m across: %s", name, n.s, p.x, p.y, p.z, p.y - q.y,
              (p.x - q.x) * -q.dz + (p.z - q.z) * q.dx, what.c_str());
      kinds[what]++; hits++;
    });
    for (auto& [k, v] : kinds) SL_INFO("[railclear] %s: %3d x %s", name, v, k.c_str());
    SL_INFO("[railclear] %s: %d hits", name, hits);
    total += hits;
  }
  SL_INFO("[railclear] %s (%d hits)", total ? "FAIL" : "PASS", total);
  return total;
}

} // namespace sl
