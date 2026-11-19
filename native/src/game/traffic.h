// Cars driving the roads: a port of src/game/traffic.js's road driving (see vehicles.h). Each car keeps the
// right-hand lane of its road (LANE 1.6 m right of the centre line), drives at speedlimits.js's target (the signed
// limit braked ahead of a lower one, the bends ahead) times its driver's own factor, keeps a time gap behind the car
// ahead (followV / lookFor), stops for you on foot and for your car and the buses, turns off at junctions onto the
// car parks' access roads and parks a while, comes back out, turns round before a bus stop's dead end, and is knocked
// aside when you hit it. About six cars stay round you (traffic.js NEAR_WANT x the preset's traffic share): the far
// ones come back on the roads 150-420 m round you out of the camera's sight, trips end out of sight, a car making no
// headway for 5 minutes is taken off; beyond SIM_R they are not simulated and between 300 and 600 m they update at a
// quarter of the rate (distance-based update rates). carpeople.js: a driver at the wheel of every car that drives, now
// and then a front passenger, sometimes one or two in the back (the game's skiers, seated by each model's seats).
#pragma once
#include "game/vehicles.h"

namespace sl { class People; }

namespace sl {
class Drive;

class Traffic {
public:
  double density = 1;   // (Phase 7, the quality preset: quality.traffic) x the cars kept round you
  /// (Phase 7) the cars to light (at night) / plate
  void carPoses(std::vector<CarPose>& out, const dvec3& cam, double maxD, bool night) const;
  Traffic(World& w, Transport& t, VehicleModels& m) : world_(w), t_(t), models_(m) {}
  void init();
  /// per frame: player position (on foot) / your car (drive), the bus boxes to brake for
  void update(double dt, const dvec3& player, const Drive* you, const std::vector<Obb>& buses, const Camera& cam);
  /// carpeople.js: the people in the cars that drive near the camera (seated skiers; `kinds`: the looks to pick from)
  void addPeople(People& people, const dvec3& cam, const std::vector<int>& kinds) const;
  mutable int peopleShown = 0;   // (the last addPeople: how many)
  void addDraw(VehicleDraw& draw, const dvec3& cam) const;
  void fillColliders(std::vector<Collider>& out) const;
  void others(std::vector<struct OtherBody>& out, const dvec3& near) const;
  void knock(int id, double vx, double vz, double w);
  /// a car that has held a bus at a standstill is taken off the road (traffic.js despawn; it comes back out of sight)
  void takeOff(int id);
  /// (autotest) the cars driving within r of p are taken off the road for `wait` s: a clear road for a driving check
  void clearNear(const dvec3& p, double r, double wait);
  /// the cars on road `ri` (the buses brake for them)
  struct CarView { dvec3 pos; double yaw, v, l, w; int road; double s; int dir; };
  void cars(std::vector<CarView>& out) const;

  struct Car {
    std::string name;
    const VehicleModel* vm = nullptr;
    double l = 4.7, w = 1.9, drv = 1, vmax = 30;
    enum class Mode : uint8_t { Road, Parked, Knocked, Gone, Wreck } mode = Mode::Gone;   // (Wreck: traffic.js 'wreck', knocked to a stop: it rests there, crooked, hazards on, until the watchdog takes it out of sight)
    int road = -1, dir = 1;
    double s = 0, v = 0, off = 0, offT = 0, offQ = 0, brake = 0;
    int nextJ = -2;        // junction index (-1 none, -2 not picked yet)
    double x = 0, y = 0, z = 0, yaw = 0, pitch = 0;
    double wait = 0, trip = 0, simAcc = 0, odo = 0;   // odo: metres driven along roads (autotest)
    int lot = -1, bay = -1;
    double kvx = 0, kvz = 0, kw = 0, kt = 0;   // knocked: sliding
    bool scenic = false;                       // one of the scenic network's own cars
    double wdX = 1e18, wdZ = 1e18, wdT = 0;    // the watchdog: where it last made 3 m headway, for how long not
    uint32_t crew = 0;                         // (carpeople.js fill) who sits in it: a seed per trip
    int pass = 0;                              // (traffic.js c.pass) round a crash ahead: 0 no, 1 by its own edge ('right'), 2 through the other lane ('left')
    double passT = 0;                          // (its plan looked at again every 0.4 s)
  };
  std::vector<Car> list;
  int movingCount() const;
  /// (traffic.js hard) what a car may never move into at (x, z) with radius r: a guardrail, a building, a parked car, a
  /// rock, a tree trunk (the game sets it; unset: nothing)
  std::function<bool(double x, double z, double r)> hardAt;
  int passes = 0;
  int noRoom = 0;   // (wrecktest) how many times a car found no room on either side of something in its lane   // (wrecktest) how many times a car pulled out round something standing in its lane

private:
  void spawn(Car& c, const dvec3& player, bool first);
  void drive(Car& c, double dt, const dvec3& player, const Drive* you, const std::vector<Obb>& buses);
  double clearance(const Car& c, const dvec3& player, const Drive* you, const std::vector<Obb>& buses) const;
  void placeOnRoad(Car& c);
  void planPass(Car& c, const Drive* you, const std::vector<Obb>& buses);
  void toRoad(Car& c, int ri, double s, int dir, double v);
  void deadEnd(Car& c, const dvec3& player);
  bool inSight(double x, double z, double d = 260) const;
  bool recycle(Car& c, const dvec3& player);
  void putOnRoad(Car& c, int ri, double s, int dir, double v);
  void despawn(Car& c, double wait);
  bool toLot(Car& c);
  double rnd() { seed_ = seed_ * 1664525u + 1013904223u; return double(seed_ >> 8) / double(1u << 24); }

  World& world_;
  Transport& t_;
  VehicleModels& models_;
  std::vector<int> main_, access_, scenic_;
  struct Junction { int access, road; double s; int lot; };
  std::vector<Junction> junctions_;
  /// (the native village's roads) a main road's end that runs on into another main road's end: [road * 2 + (end at
  /// its far end)] -> (that road, its far end?) ; -1 none
  struct Link { int road = -1; bool far = false; };
  std::vector<Link> links_;
  const Link* linkAt(int road, int dir) const { const size_t k = size_t(road) * 2 + (dir > 0 ? 1 : 0); return k < links_.size() && links_[k].road >= 0 ? &links_[k] : nullptr; }
  std::vector<int> lots_;
  double recycleT_ = 0;
  dvec3 cam_{0}, camFwd_{0, 0, 1};
  unsigned seed_ = 7919;
};

} // namespace sl
