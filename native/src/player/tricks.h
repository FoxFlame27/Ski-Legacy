// Freestyle tricks: a port of src/player/tricks.js. Spins (A / D), flips (W / S) and grabs (Shift) while airborne.
// Spins and flips need a deliberate jump (a Space pop); keys held into the jump (tuck, brake, a held turn) only count
// once pressed again, so normal riding never turns into a trick by accident. Rotations ease in while a key is held;
// on release they settle onto the nearest clean 180 (spins) or full flip. A landing is judged on the skis' direction
// against the travel direction (forward or switch), how upright the skier is and how hard the snow hits; the trick is
// then named ("Backflip 360 Mute") and scored.
#pragma once
#include <string>

namespace sl {

struct TrickKeys { bool left = false, right = false, front = false, back = false, grab = false; };

struct TrickResult {
  enum class Landed { Clean, Sketchy, Crash } landed = Landed::Clean;
  enum class Cause { None, Flip, Sideways, Impact } cause = Cause::None;
  bool isSwitch = false;
  std::string name;          // "" when nothing was done
  int points = 0, total = 0;
  double airTime = 0;
  int spin = 0, flips = 0;   // degrees, full flips
  int grab = 0;              // 0 none, 1 mute, 2 safety, 3 japan
  double yawErr = 0, flipErr = 0;
};

class Tricks {
public:
  Tricks() { cancel(); }
  int total = 0;             // running score (reset by the race session)
  bool active = false;       // airborne with the trick system armed
  double spin = 0, spinVel = 0, flip = 0, flipVel = 0, grab = 0, grabTime = 0, airTime = 0, maxSpinVel = 0;
  int grabType = 0;          // 0 none, 1 mute, 2 safety, 3 japan (the rig's GrabType order is mapped by the caller)
  bool switchTakeoff = false, allowFlip = true, allowSpin = true;
  TrickKeys live;            // trick keys that count this tick (held, not latched, allowed)

  /// forget the current jump (teleports, lifts, crashes that are not landings)
  void cancel();
  void resetScore() { total = 0; }
  /// leaving the snow: `held` keys are latched (they count only after a release) when `latch`
  void takeoff(bool latch, bool flips, bool spins, const TrickKeys& held, bool sw);
  /// a pop shortly after rolling off a lip makes the jump deliberate after all
  void arm() { allowFlip = true; allowSpin = true; }
  /// integrates the rotations (airLeft: the predicted remaining flight time; new flips need some room)
  void update(double dt, const TrickKeys& keys, double airLeft);
  /// the trick's name for what has been done so far
  std::string describe(int* halfTurns = nullptr, int* flips = nullptr) const;
  /// judges a landing (yawErr: the skis' heading minus the travel heading; impact: m/s into the snow; speed: along it)
  TrickResult land(double yawErr, double impact, double speed);

private:
  TrickKeys latch_;
  bool hasSpinTarget_ = false, hasFlipTarget_ = false;
  double spinTarget_ = 0, flipTarget_ = 0;
};

} // namespace sl
