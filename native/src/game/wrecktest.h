// (debug: SKI_LEGACY_DEBUG=wrecktest --autotest --frames 9000 --png out.png) a wreck on a busy road: a traffic car
// knocked to a stop ahead of the traffic behind it, then your own car wrecked in a lane: the cars behind brake and
// queue (logged: their distance to the wreck and speed every second), shots right after, 10 s and 60 s later
// (out_wreck_<what>_<t>.png), the wreck's label, its height over the road (never sunk into it).
#pragma once
#include "core/math.h"
#include <functional>
#include <string>

namespace sl {
class Drive;
class Traffic;
class Transport;
class World;

struct WreckTestEnv {
  Drive* drive = nullptr;
  Traffic* traffic = nullptr;
  Transport* transport = nullptr;
  World* world = nullptr;
  dvec3 player{0};
  double simTime = 0;
  std::string prompt, toast;
  std::function<void(int parkedIdx)> enterCar;              // in (rideKind = Car, seated)
  std::function<void(double x, double z, double heading)> teleport;
  std::function<void(const std::string& variant)> png;
};

class WreckTest {
public:
  /// one frame; true (and the camera) while it holds a fixed camera
  bool frame(WreckTestEnv& e, dvec3& camPos, dvec3& camLook);
  bool done = false, ok = true;
private:
  int phase_ = 0, idx_ = -1, tcar_ = -1;
  double t0_ = 0, nextLog_ = 0;
  dvec3 at_{0}, fwd_{0, 0, 1}, stand_{0};
  int shots_ = 0;
};
} // namespace sl
