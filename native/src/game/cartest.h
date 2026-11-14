// The autotest's car check on the path a player takes (the --autotest phase after the Phase 3 drive; alone with
// SKI_LEGACY_DEBUG=cartest): every input goes through the platform as real input events (SDL_PushEvent key events, an
// SDL virtual game controller for the pad), never through Input::inject or direct calls — walk to the Autohaus with
// W A S D (Shift to run), E at the cheapest car for sale, Enter on "Buy it" (the money granted first), walk to the car
// in your bay, E to get in, hold W 10 s (> 40 km/h) steering with A / D, S to stop, E to get out; then the same car
// with the controller (X in, RT throttle, the left stick steering, LT brake, X out); then 30 s on the village plaza
// counting the traffic cars driving within 300 m (drawn: inside the draw distance) and the parked cars and buses there.
#pragma once
#include "core/math.h"
#include "platform/platform.h"
#include <functional>
#include <string>
#include <vector>

namespace sl {
class Player;
class Drive;
class Traffic;
class Transport;
class BusLine;
class Menus;

struct CarFlowEnv {
  Player* player = nullptr;
  Drive* drive = nullptr;
  Traffic* traffic = nullptr;
  Transport* transport = nullptr;
  BusLine* buses = nullptr;
  Menus* menus = nullptr;
  int64_t money = 0;
  size_t garage = 0;
  std::function<void(int64_t)> grant;
  std::function<void(double x, double z, double heading)> teleport;   // on foot, skis off
  std::function<void(const char*)> png;                                // a screenshot (variant name)
  std::function<double(double x, double z)> ground;                    // the terrain's height
  dvec3 camPos{0}, camFwd{0, 0, 1};
  std::string prompt;
  bool driving = false;
  double simTime = 0, frameDt = 0.1;
};

class CarFlowTest {
public:
  /// one frame (after the game's frame): the events for the next one are pushed here. true when the test is over.
  bool frame(CarFlowEnv& e);
  bool buyOk = true, enterOk = true, driveOk = true, padOk = true, exitOk = true, trafficOk = true;
  bool ok() const { return buyOk && enterOk && driveOk && padOk && exitOk && trafficOk; }
  void releaseAll();

private:
  enum class St { Setup, WalkToSale, OpenSale, ConfirmBuy, WalkToCar, GetIn, Drive, Stop, GetOut, PadIn, PadDrive, PadStop, PadOut, Village, Traffic, Shot, Done } st_ = St::Setup;
  void go(St s) { st_ = s; t_ = 0; n_ = 0; }
  void key(platform::Key k, bool down);
  void tap(platform::Key k) { key(k, true); tapUp_.push_back(k); }
  /// walk toward (x, z) with the movement keys relative to the camera; true within r m
  bool walkTo(CarFlowEnv& e, double x, double z, double r, bool run);
  void steerTo(CarFlowEnv& e, double x, double z);
  bool pad(bool on);
  void padAxis(int axis, float v);
  void padButton(int b, bool down);
  std::vector<platform::Key> held_, tapUp_;
  double t_ = 0;
  int n_ = 0, sale_ = -1, own_ = -1, road_ = -1;
  int64_t money0_ = 0, price_ = 0;
  size_t garage0_ = 0;
  double top_ = 0, dist_ = 0, walked_ = 0, padTop_ = 0;
  dvec3 last_{0}, start_{0}, walkFrom_{0};
  double walkT_ = 0, side_ = 1;
  std::string model_;
  int padIndex_ = -1;
  // the traffic sample
  struct Seen { double odo0 = -1, near = 0; bool drawn = false; dvec3 p0{0}; double moved = 0; };
  std::vector<Seen> seen_;
  int parkedNear_ = 0, busesNear_ = 0, shotCar_ = -1;
};

} // namespace sl
