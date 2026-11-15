// Broadcast presentation (src/game/presentation/index.js): the game-wide time scale, slow motion on big moments.
//   pres.update(rawDt, ...) every frame BEFORE anything simulates, then the world's dt = rawDt * pres.timeScale
//   pres.slowMo(0.3, 0.12, 1.0, 0.45, "photo")   e.g. a photo finish (the race session)
// Big airs are spotted here for free ride and races alike: a flight predicted to last longer than BIG_AIR seconds
// drops the world to SLOW_SCALE for about a second (eased in and out, in real time), so the apex plays in slow motion
// and normal speed is back for the landing. The race intro, replays and the podium run on real time.
#pragma once
#include "core/noise.h"
#include <algorithm>
#include <cmath>
#include <string>

namespace sl {

class Presentation {
public:
  static constexpr double BIG_AIR = 1.2;       // s of predicted (or actual) airtime that counts as a big air
  static constexpr double SLOW_SCALE = 0.35;   // world speed at the bottom of a slow-motion moment
  static constexpr double AIR_ARM = 0.3;       // s into the flight before a predicted big air triggers
  static constexpr double COOLDOWN = 1.6;      // real s after a slow-motion before the next one may start

  double timeScale = 1;
  bool enabled = true;      // false = never slow down
  bool cinematic = false;   // a race intro / replay / podium owns the camera
  /// (logs / tests) what the running moment is for ("" none), how many have started
  std::string reason;
  int started = 0;

  bool slowing() const { return slow_.on; }

  /// Start a slow-motion moment (ignored while one runs or during the cooldown). Real (wall-clock) seconds.
  bool slowMo(double scale = SLOW_SCALE, double easeIn = 0.18, double hold = 1.0, double easeOut = 0.4, const std::string& why = "") {
    if (!enabled || slow_.on || cooldown_ > 0) return false;
    slow_ = {true, 0, scale, easeIn, hold, easeOut};
    reason = why;
    started++;
    return true;
  }

  /// Back to full speed at once (restart, respawn, menus).
  void cancel() { slow_.on = false; timeScale = 1; reason.clear(); }

  /// what the big airs are watched on (player.js: air, mode ski, frozen, airTime, airEnd)
  struct Air { bool has = false, air = false, ski = false, frozen = false; double airTime = 0, airEnd = 0; };

  /// Per frame with the real frame time. Returns the time scale for this frame.
  double update(double rawDt, const Air& pl, bool paused, bool multiplayer) {
    if (paused || !(rawDt > 0)) return timeScale;
    // multiplayer: never slow your own world down (everyone else keeps real time)
    if (multiplayer) { cancel(); return 1; }
    cooldown_ = std::max(0.0, cooldown_ - rawDt);
    if (pl.has && !cinematic) watchAir(pl);
    if (!slow_.on) { timeScale = 1; return 1; }
    Slow& s = slow_;
    s.t += rawDt;
    const double end = s.easeIn + s.hold + s.easeOut;
    if (s.t >= end || cinematic) {
      cancel();
      cooldown_ = COOLDOWN;
      return 1;
    }
    const double k = smoothstep(0, s.easeIn, s.t) * (1 - smoothstep(s.easeIn + s.hold, end, s.t));
    timeScale = 1 + (s.scale - 1) * k;
    return timeScale;
  }

private:
  // Big airs: the player's controller predicts the flight time at take-off (player.airEnd).
  void watchAir(const Air& pl) {
    if (!pl.air || !pl.ski) { airArmed_ = true; return; }
    if (!airArmed_ || pl.frozen) return;
    const double t = pl.airTime;
    const double predicted = std::isfinite(pl.airEnd) ? pl.airEnd : 0;
    if ((t > AIR_ARM && predicted >= BIG_AIR) || t >= BIG_AIR) {
      airArmed_ = false;
      // the longer the flight, the longer the slow part (never past the landing)
      const double left = std::max(0.0, (predicted != 0 ? predicted : t) - t);
      slowMo(SLOW_SCALE, 0.18, std::min(1.3, std::max(0.6, left * 1.6)), 0.4, "air");
    }
  }
  struct Slow { bool on = false; double t = 0, scale = SLOW_SCALE, easeIn = 0.18, hold = 1, easeOut = 0.4; } slow_;
  double cooldown_ = 0;
  bool airArmed_ = true;   // one slow-motion per flight
};

} // namespace sl
