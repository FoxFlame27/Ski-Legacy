// The small cards in the top-right corner (src/ui/racehud.js trick() / best(), style.css .tp; src/game/bests.js):
//   the trick popup      the trick's name, +points, how it was landed (CLEAN green / SKETCHY amber / BAILED red: the
//                        bar on its left in that colour) and the running SCORE; under the race info panel in a race
//   the personal best    PERSONAL BEST / MILESTONE, the title and the value with its unit (free ride only), announced
//                        once: a new top speed (from 50 km/h, 2 km/h over the old one, once you are 4 km/h off the
//                        peak), the longest jump (10 m, +1 m), the biggest air (1.2 s, +0.15 s), distance milestones
#pragma once
#include "core/math.h"
#include "engine/ui.h"
#include <string>
#include <vector>

namespace sl {
class Save;

class Popups {
public:
  /// landed: 0 clean, 1 sketchy, 2 crash (bailed: the name and BAILED, no points)
  void trick(const std::string& name, int points, int total, int landed, double now);
  void best(const std::string& kicker, const std::string& title, const std::string& value, const std::string& unit, double now);
  /// bests.js update(): every frame while playing; busy: a race runs. True when a card came up (the chime).
  bool updateBests(double dt, bool skiing, double speed, bool air, double airTime, const dvec3& pos, bool lastLandingCrash, Save& save, bool busy, double now);
  void draw(Ui& ui, bool inRace, double now);
  int trickCount() const { return trickN_; }

private:
  struct Card { std::string kicker, name, value, tag; int q = 0; int total = -1; double at = -100, life = 2.3; int seed = 0; bool best = false; };
  void drawCard(Ui& ui, const Card& c, float top, double now) const;
  Card trick_, best_;
  int trickN_ = 0;
  // bests.js
  struct Q { std::string kicker, title, value, unit; double delay = 0; };
  std::vector<Q> queue_;
  double speedBest_ = -1, peak_ = 0, cooldown_ = 0, milestoneKm_ = -1;
  bool wasAir_ = false;
  dvec2 takeoff_{0};
};

} // namespace sl
