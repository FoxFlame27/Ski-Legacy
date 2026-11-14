#include "player/tricks.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr double PI_ = 3.14159265358979323846, TAU_ = PI_ * 2, DEG_ = PI_ / 180;
// rotation feel (tricks.js)
constexpr double SPIN_MAX = 7.4;      // rad/s at full spin (~420 deg/s: a 360 in ~0.95 s)
constexpr double SPIN_ACC = 26;       // rad/s^2 spin-up
constexpr double FLIP_MAX = 5.9;      // rad/s at full flip
constexpr double FLIP_ACC = 15;       // rad/s^2
constexpr double SPIN_EASE = 16;      // deceleration used to predict where a released spin comes to rest
constexpr double FLIP_EASE = 9;
constexpr double SETTLE_W = 7.5;      // settle spring (critically damped) natural frequency
constexpr double MIN_FLIP_AIR = 1.05; // a flip is only started with the flight time it needs to land (s)
// landing windows
constexpr double CLEAN_YAW = 15 * DEG_, SKETCHY_YAW = 40 * DEG_, CLEAN_FLIP = 15 * DEG_, SKETCHY_FLIP = 35 * DEG_;
constexpr double SKETCHY_IMPACT = 12, CRASH_IMPACT = 16;   // m/s into the snow
constexpr int SPIN_POINTS[9] = {0, 150, 300, 500, 750, 1050, 1400, 1800, 2250};
constexpr int FLIP_POINTS[5] = {0, 600, 1500, 2700, 4200};
const char* const FLIP_WORDS[5] = {"", "", "Double ", "Triple ", "Quad "};
const char* const GRAB_NAMES[4] = {"", "Mute", "Safety", "Japan"};

double wrapPi(double a) { return std::atan2(std::sin(a), std::cos(a)); }
double approach(double x, double t, double step) { return x < t ? std::min(t, x + step) : std::max(t, x - step); }
// exact critically damped spring step toward `target` (frame-rate independent)
void settle(double& x, double& v, double target, double w, double dt) {
  double d = x - target, e = std::exp(-w * dt), c = v + w * d;
  x = target + (d + c * dt) * e;
  v = (v - c * w * dt) * e;
}
} // namespace

void Tricks::cancel() {
  active = false;
  spin = spinVel = 0; hasSpinTarget_ = false;
  flip = flipVel = 0; hasFlipTarget_ = false;
  grab = grabTime = 0; grabType = 0;
  airTime = maxSpinVel = 0; switchTakeoff = false; allowFlip = allowSpin = true;
  live = TrickKeys{};
}

void Tricks::takeoff(bool latch, bool flips, bool spins, const TrickKeys& held, bool sw) {
  cancel();
  active = true;
  allowFlip = flips;
  allowSpin = spins;
  switchTakeoff = sw;
  latch_ = latch ? held : TrickKeys{};
}

void Tricks::update(double dt, const TrickKeys& keys, double airLeft) {
  if (!active) return;
  airTime += dt;
  // a key held since an unintended takeoff only counts after it has been released once
  auto key = [](bool down, bool& latched) { if (!down) latched = false; return down && !latched; };
  live.left = key(keys.left, latch_.left); live.right = key(keys.right, latch_.right);
  live.front = key(keys.front, latch_.front); live.back = key(keys.back, latch_.back);
  live.grab = key(keys.grab, latch_.grab);
  if (!allowSpin) live.left = live.right = false;
  if (!allowFlip) live.front = live.back = false;

  // ---- spin (yaw): A = +, D = -
  int si = (live.left ? 1 : 0) - (live.right ? 1 : 0);
  if (si) {
    spinVel = approach(spinVel, si * SPIN_MAX, SPIN_ACC * dt);
    hasSpinTarget_ = false;
    spin += spinVel * dt;
  } else {
    if (!hasSpinTarget_) {
      // where a comfortable spin-down would stop -> the nearest clean 180
      double rest = spin + (spinVel * std::fabs(spinVel)) / (2 * SPIN_EASE);
      spinTarget_ = std::round(rest / PI_) * PI_;
      hasSpinTarget_ = true;
    }
    settle(spin, spinVel, spinTarget_, SETTLE_W, dt);
  }
  maxSpinVel = std::max(maxSpinVel, std::fabs(spinVel));

  // ---- flip (pitch about the travel axis): W = front (+), S = back (-)
  int fi = (live.front ? 1 : 0) - (live.back ? 1 : 0);
  bool flipping = std::fabs(flip) > 0.05 || std::fabs(flipVel) > 0.3;
  if (fi && (flipping || airLeft > MIN_FLIP_AIR)) {
    flipVel = approach(flipVel, fi * FLIP_MAX, FLIP_ACC * dt);
    hasFlipTarget_ = false;
    flip += flipVel * dt;
  } else if (flipping) {
    if (!hasFlipTarget_) {
      // a released flip carries on (or opens up) to the nearest full rotation
      double rest = flip + (flipVel * std::fabs(flipVel)) / (2 * FLIP_EASE);
      flipTarget_ = std::round(rest / TAU_) * TAU_;
      hasFlipTarget_ = true;
    }
    settle(flip, flipVel, flipTarget_, SETTLE_W * 0.8, dt);
  }

  // ---- grab (Shift): picked from what the body is doing when it starts
  if (live.grab) {
    if (!grabType) grabType = std::fabs(flipVel) > 1.5 || std::fabs(flip) > 0.5 ? 3 : std::fabs(spinVel) > 1.5 ? 1 : 2;
    grab = approach(grab, 1, dt / 0.22);
    if (grab > 0.7) grabTime += dt;
  } else grab = approach(grab, 0, dt / 0.18);
}

std::string Tricks::describe(int* halfTurnsOut, int* flipsOut) const {
  int halfTurns = int(std::lround(std::fabs(spin) / PI_)), flips = int(std::lround(std::fabs(flip) / TAU_));
  std::string name;
  auto add = [&](const std::string& s) { if (!name.empty()) name += ' '; name += s; };
  if (flips) add(std::string(FLIP_WORDS[std::min(flips, 4)]) + (flip > 0 ? "Frontflip" : "Backflip"));
  if (halfTurns) add(std::to_string(halfTurns * 180));
  if (grabType && grabTime >= 0.25) add(GRAB_NAMES[grabType]);
  if (!name.empty() && switchTakeoff) name = "Switch " + name;
  if (halfTurnsOut) *halfTurnsOut = halfTurns;
  if (flipsOut) *flipsOut = flips;
  return name;
}

TrickResult Tricks::land(double yawErr, double impact, double speed) {
  TrickResult r;
  const double air = airTime, yaw = wrapPi(yawErr);
  const bool sw = std::fabs(yaw) > PI_ / 2;
  const double yawOff = sw ? PI_ - std::fabs(yaw) : std::fabs(yaw);   // from forward or from switch
  const double flipErr = std::fabs(wrapPi(flip));
  int halfTurns = 0, flips = 0;
  std::string name = describe(&halfTurns, &flips);

  if (flipErr > SKETCHY_FLIP) { r.landed = TrickResult::Landed::Crash; r.cause = TrickResult::Cause::Flip; }
  else if (yawOff > SKETCHY_YAW && speed > 5) { r.landed = TrickResult::Landed::Crash; r.cause = TrickResult::Cause::Sideways; }
  else if (impact > CRASH_IMPACT) { r.landed = TrickResult::Landed::Crash; r.cause = TrickResult::Cause::Impact; }
  else if (flipErr > CLEAN_FLIP || yawOff > CLEAN_YAW || impact > SKETCHY_IMPACT || grab > 0.5) r.landed = TrickResult::Landed::Sketchy;

  double points = 0;
  const bool grabbed = grabType && grabTime >= 0.25;
  const int parts = (halfTurns > 0 ? 1 : 0) + (flips > 0 ? 1 : 0) + (grabbed ? 1 : 0);
  if (parts) {
    double base = SPIN_POINTS[std::min(halfTurns, 8)] + FLIP_POINTS[std::min(flips, 4)] + (grabbed ? 100 + 250 * std::min(grabTime, 2.0) : 0) + 40 * air;
    if (switchTakeoff) base *= 1.2;
    points = base * (1 + 0.25 * (parts - 1));
  } else if (air >= 1.1) {
    name = "Big Air";
    points = 60 * air;
  }
  if (!name.empty() && sw && halfTurns % 2 == 1) name += " \xC2\xB7 Switch";
  points = r.landed == TrickResult::Landed::Crash ? 0 : std::round(points * (r.landed == TrickResult::Landed::Sketchy ? 0.6 : 1) / 10) * 10;
  if (name.empty()) points = 0;
  total += int(points);
  r.isSwitch = sw; r.name = name; r.points = int(points); r.total = total; r.airTime = air;
  r.spin = halfTurns * 180; r.flips = flips; r.grab = grabbed ? grabType : 0;
  r.yawErr = yaw; r.flipErr = flipErr;
  active = false;
  return r;
}

} // namespace sl
