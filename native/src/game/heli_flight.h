// The helicopter's flight model, the pilot who flies it home and the autopilot: a port of src/game/heli/flight.js
// (same numbers, same order of operations). Controls (each -1..1): fwd (W/S), turn (A/D, + = left), lift (Space /
// Shift). pos is the centre of mass (cgH above the skid bottoms); yaw 0 = nose toward +z; pitch + = nose down,
// roll + = right side down; the attitude is THREE's Euler(pitch, yaw, roll, 'YXZ').
#pragma once
#include "core/math.h"
#include "core/noise.h"
#include <functional>

namespace sl {

struct HeliCtl { double fwd = 0, turn = 0, lift = 0; };
using GroundFn = std::function<double(double, double)>;

namespace heli {
constexpr double MAX_FWD = 95, MAX_BACK = 10, ACC = 13, BRAKE = 16, BACK_ACC = 3.4, COAST = 2.4, DRAG = 0.0008, DRIFT = 1.7;
constexpr double TURN = 1.15, TURN_FAST = 0.5, TURN_TAU = 0.28, CLIMB = 16, SINK = 10, V_ACC = 9, V_STOP = 16;
constexpr double AGL_MAX = 420, LAND_SLOPE = 0.30, POWER = 0.92;
inline double wrapPi(double a) { return std::atan2(std::sin(a), std::cos(a)); }
inline double smooth(double a, double b, double x) { double t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3 - 2 * t); }
} // namespace heli

/// model.js FRAME: the airframe's numbers for the flight model (metres)
struct HeliFrame {
  double cgH = 1.6, skidL = 3.8, skidW = 2.7, skidZ = 0.4;
  double nose[2] = {3.0, 0.7}, tail[2] = {-6.1, 1.2}, stab[3] = {-4.2, 1.7, 1.6}, rotor[2] = {5.1, 3.3};
  double rotorR = 5.1;
};

class HeliFlight {
public:
  HeliFrame fr;
  dvec3 pos{0}, vel{0};
  double yaw = 0, yawRate = 0, u = 0, accel = 0;
  bool landed = true, steep = false;
  double agl = 0, groundY = 0, pitch = 0, pitchV = 0, roll = 0, rollV = 0, t = 0, climbAssist = 0, hold = 0;
  double landPitch = 0, landRoll = 0;
  glm::dquat quat{1, 0, 0, 0};
  GroundFn groundFn;   // (the autopilot's terrain look-ahead samples it)

  double speed() const { return std::hypot(vel.x, vel.z); }
  /// down on the ground at (x, z), facing yaw
  void place(double x, double z, double yaw, const GroundFn& ground);
  double settle(const GroundFn& ground, double k);
  void step(double dt, const HeliCtl& ctl, const GroundFn& ground, double power = 1);
  void clampTerrain(const GroundFn& ground);
  double hullFloor(const GroundFn& ground) const;
  double slopeAt(const GroundFn& ground) const;
  void updateQuat();
  /// root-local (metres round the centre of mass) -> world
  dvec3 world(const dvec3& local) const { return pos + quat * local; }
private:
  void sub(double dt, const HeliCtl& ctl, const GroundFn& ground, double power);
  void springAttitude(double dt, double pitchT, double rollT, double w);
};

struct HeliGoal { double x = 0, z = 0, y = 0, agl = 30, speed = 70, stop = 1.2, yaw = 0, decel = 3.3; bool hasY = false, hasAgl = false, hasYaw = false; };
/// controls that fly toward a point (flight.js autopilot)
void heliAutopilot(const HeliFlight& f, const HeliGoal& goal, HeliCtl& out);

struct HeliPad { double x = 0, z = 0, y = 0, yaw = 0; };

/// flight.js HomePilot: climb away, cruise on a glide path that ends over the pad, hover, turn, set down
class HeliHomePilot {
public:
  enum class Phase : uint8_t { Idle, Depart, Transit, Align, Down, Landed } phase = Phase::Idle;
  HeliPad pad;
  double t = 0;
  void home(const HeliPad& p, double wait = 1.2) { pad = p; phase = Phase::Depart; t = -wait; }
  HeliCtl update(const HeliFlight& f, double dt);
};

} // namespace sl
