// (debug: SKI_LEGACY_DEBUG=sinktest SKI_LEGACY_SINKREF=ref.json --autotest) every World Racing course's line against
// the web game's own ground: ref.json holds, every metre along each course at five laterals, world.groundHeight of the
// JS (its terrain, the course's region and cuts, the ramps' and the bridge's walkable surfaces) and world.height.
// Here the C++ physics ground (World::groundHeight) is taken at the same points; every place it sits more than 4 cm
// under the JS surface (you sink into what is drawn) or over it (you ski on air) is listed, grouped in runs.
#include "game/sinktest.h"
#include "core/log.h"
#include "world/world.h"

#include <nlohmann/json.hpp>
#include <cmath>
#include <fstream>

namespace sl {

int runSinkTest(World& world, const char* refPath) {
  std::ifstream f(refPath);
  if (!f) { SL_WARN("[sinktest] no reference %s", refPath); return 1; }
  nlohmann::json J = nlohmann::json::parse(f, nullptr, false);
  if (!J.is_array()) { SL_WARN("[sinktest] bad reference"); return 1; }
  const double TOL = 0.04;
  int total = 0, hitsAll = 0;
  for (auto& c : J) {
    const std::string id = c["id"].get<std::string>();
    auto& feats = c["feats"];
    auto featAt = [&](double s) {
      for (auto& q : feats) if (s >= q[1].get<double>() - 2 && s <= q[2].get<double>() + 2) return q[0].get<std::string>();
      return std::string("-");
    };
    int hits = 0, n = 0;
    double runS0 = -1, runS1 = -1, runWorst = 0;
    std::string runFeat;
    double rx = 0, rz = 0;
    auto flush = [&]() {
      if (runS0 < 0) return;
      SL_INFO("[sinktest] %-12s s %7.1f-%7.1f  worst %+6.2f m  at (%.1f, %.1f)  feature %s", id.c_str(), runS0, runS1, runWorst, rx, rz, runFeat.c_str());
      runS0 = -1; runWorst = 0;
    };
    for (auto& p : c["pts"]) {
      const double x = p[0], z = p[1], gJ = p[2], s = p[4];
      const double gC = world.groundHeight(x, z, gJ + 3);
      const double d = gC - gJ;
      n++;
      if (std::fabs(d) > TOL) {
        hits++;
        if (runS0 >= 0 && s - runS1 > 3) flush();
        if (runS0 < 0) { runS0 = s; runFeat = featAt(s); }
        runS1 = s;
        if (std::fabs(d) > std::fabs(runWorst)) { runWorst = d; rx = x; rz = z; }
      }
    }
    flush();
    SL_INFO("[sinktest] %-12s %d of %d points off by more than %.0f cm", id.c_str(), hits, n, TOL * 100);
    total += n; hitsAll += hits;
  }
  SL_INFO("[sinktest] %d of %d points off -> %s", hitsAll, total, hitsAll == 0 ? "PASS" : "FAIL");
  return hitsAll == 0 ? 0 : 1;
}

} // namespace sl
