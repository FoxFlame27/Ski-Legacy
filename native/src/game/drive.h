// The car you drive and the cars parked round the resort: a port of src/game/drive.js (the physics, collisions,
// damage, cameras) with parking.js's parked cars and carrental.js's Autohaus (buy a car: it waits in your bay, nose to
// the road; only your own cars let you in). See vehicles.h for the list of what Phase 3 ports.
#pragma once
#include "game/vehicles.h"
#include "world/scenery.h"

namespace sl {

struct DriveInput {
  float throttle = 0, brake = 0, steer = 0;   // steer: +1 left .. -1 right (analog)
  bool handbrake = false, lookBack = false, horn = false;
};
struct DriveFrameInput {
  bool toggleView = false, toggleLights = false, unstuck = false, flip = false;
  float lookX = 0, lookY = 0;
  double now = 0;
};

/// another body the car can hit (traffic, a bus, a parked car): drive.js bash()
struct OtherBody { Obb box; double vx = 0, vz = 0, w = 0, mass = 1500; int kind = 0; int id = -1; };   // kind 0 traffic, 1 bus, 2 parked

class Drive {
public:
  Drive(World& w, Scenery& s, Transport& t, VehicleModels& m) : world_(w), scenery_(s), t_(t), models_(m) {}
  void init();

  // ---- getting in / out
  /// the prompt beside a car (drive.js interaction / the Autohaus), empty if none
  std::string prompt(const dvec3& p, bool canUse);
  /// E: get in (or buy at the Autohaus); true if something happened
  bool interact(const dvec3& p);
  bool active() const { return d_.on; }
  /// E while driving: out at a standstill; fills the spot to stand on (x, z, heading)
  bool exit(dvec3& out);
  /// the car nearest p you may drive (autotest)
  int nearestOwned(const dvec3& p) const;
  bool enter(int parkedIndex);
  /// (autotest) brought to a stop at once
  void stopNow() { d_.vx = d_.vz = d_.vy = 0; d_.yawRate = 0; d_.offT = 0; d_.crash = false; }
  /// buy a car at the Autohaus (economy is Phase 4: free) -> parked index, -1 if none
  int buy(const std::string& model);

  // ---- per tick / frame
  void fixedUpdate(double h, const DriveInput& in, double now);
  void frame(double dt, const DriveFrameInput& in);
  void seat(dvec3& pos, dvec3& fwd) const;
  void cameraFor(Camera& cam) const { cam.lookAt(camPos_, camLook_); cam.fovY = float(camFov_); cam.nearZ = view_ == View::Cockpit ? 0.05f : 0.1f; }
  void addDraw(VehicleDraw& draw, const dvec3& cam) const;
  void fillColliders(std::vector<Collider>& out) const;

  // ---- state for the HUD, the traffic, the autotest
  double speed() const { return std::hypot(d_.vx, d_.vz); }
  dvec3 pos() const { return dvec3(d_.x, d_.y, d_.z); }
  double yaw() const { return d_.yaw; }
  dvec2 vel() const { return dvec2(d_.vx, d_.vz); }
  double halfLen() const { return d_.half; }
  double halfWidth() const { return d_.w / 2; }
  bool air() const { return d_.air; }
  double damage() const;
  std::string label() const;
  bool cockpit() const { return view_ == View::Cockpit; }
  double rpm() const { return d_.rpm; }
  char gear() const { return d_.gear; }
  bool lights() const { return d_.lights; }
  std::vector<VehicleEvent> events;

  std::function<void(std::vector<OtherBody>&)> gatherOthers;
  std::function<void(const OtherBody&, double vx, double vz, double w)> onKnock;

  struct Parked {
    std::string name;
    const CarSpec* spec = nullptr;
    const VehicleModel* vm = nullptr;
    double x = 0, y = 0, z = 0, yaw = 0, length = 4.7, damage = 0;
    bool owned = false, forSale = false, driving = false, wrecked = false;
    double svx = 0, svz = 0, sw = 0;   // shoved: sliding to a stop
  };
  std::vector<Parked> parked;

private:
  void step(double h, double thr, double brk, double steerIn, bool hb, bool thrKey, bool brkKey);
  void terrainHit(double g1);
  void collide(double now);
  void railHit(double px, double pz, int rk, double now);
  void railBreak(double into, double nx, double nz);
  void bash(double h);
  void knock(double v, double nx, double nz, double now);
  void crash(double v, double nx, double nz);
  void crashStep(double h);
  void pose(double dt);
  void placeCamera(double dt, const DriveFrameInput& in);
  void unstuck();
  void unflip();
  void slideParked(double h);
  bool clearAt(double x, double z, double r, int own) const;

  World& world_;
  Scenery& scenery_;
  Transport& t_;
  VehicleModels& models_;
  struct D {
    bool on = false;
    int e = -1;                         // the parked entry being driven
    const CarSpec* spec = nullptr;
    double x = 0, y = 0, z = 0, yaw = 0, vx = 0, vz = 0, vy = 0, yawRate = 0, steer = 0;
    char gear = 'P';
    double rpm = 820;
    int gi = 0;
    double shiftT = 0, holdR = 0;
    bool air = false;
    double pitch = 0, roll = 0, pitchV = 0, rollV = 0, la = 0, lat = 0;
    bool lights = false, horn = false;
    double squeal = 0, offT = 0, wheelBase = 2.8, half = 2.35, w = 1.9, start = 0, load = 0, thrP = 0, brkP = 0;
    bool restSet = false;
    double restX = 0, restZ = 0;
    double flipT = 0, stuckT = 0, railT = 0, railSlide = 0, downhill = 0;
    bool thruSet = false;
    double thruX = 0, thruZ = 0, thruT = 0;
    bool crash = false;
    double crashT = 0, crashRoll = 0, crashRollTo = 0, crashRate = 3;
    double rough = 0;
  } d_;
  enum class View : uint8_t { Chase, Cockpit } view_ = View::Chase;
  dvec3 camPos_{0}, camLook_{0};
  double camFov_ = 62, camYaw_ = 0, camPitch_ = 0.17, lastMouse_ = -1e9, lookYaw_ = 0, lookPitch_ = -0.05, shake_ = 0;
  bool camReady_ = false, lookBackPrev_ = false;
  double knockT_ = -1e9, bangT_ = -1e9, unstuckT_ = -1e9, now_ = 0;
  unsigned seed_ = 12345;
  double rnd() { seed_ = seed_ * 1103515245u + 12345u; return double((seed_ >> 8) & 0xffffff) / double(0x1000000); }
};

} // namespace sl
