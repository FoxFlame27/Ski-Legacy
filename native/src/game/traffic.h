// Cars driving the roads: a port of src/game/traffic.js's road driving (see vehicles.h). Each car keeps the
// right-hand lane of its road (LANE 1.6 m right of the centre line), drives at speedlimits.js's target (the signed
// limit braked ahead of a lower one, the bends ahead) times its driver's own factor, keeps a time gap behind the car
// ahead (followV / lookFor), stops for you on foot and for your car and the buses, turns off at junctions onto the
// car parks' access roads and parks a while, comes back out, turns round before a bus stop's dead end, and is knocked
// aside when you hit it. About six cars stay round you; the far ones are recycled out of sight; beyond SIM_R they are
// not simulated and between 300 and 600 m they update at a quarter of the rate (distance-based update rates).
#pragma once
#include "game/vehicles.h"

namespace sl {
class Drive;

class Traffic {
public:
  double density = 1;   // (Phase 7, the quality preset) x the number of cars
  /// (Phase 7) the cars to light (at night) / plate
  void carPoses(std::vector<CarPose>& out, const dvec3& cam, double maxD, bool night) const;
  Traffic(World& w, Transport& t, VehicleModels& m) : world_(w), t_(t), models_(m) {}
  void init();
  /// per frame: player position (on foot) / your car (drive), the bus boxes to brake for
  void update(double dt, const dvec3& player, const Drive* you, const std::vector<Obb>& buses, const dvec3& cam);
  void addDraw(VehicleDraw& draw, const dvec3& cam) const;
  void fillColliders(std::vector<Collider>& out) const;
  void others(std::vector<struct OtherBody>& out, const dvec3& near) const;
  void knock(int id, double vx, double vz, double w);
  /// the cars on road `ri` (the buses brake for them)
  struct CarView { dvec3 pos; double yaw, v, l, w; int road; double s; int dir; };
  void cars(std::vector<CarView>& out) const;

  struct Car {
    std::string name;
    const VehicleModel* vm = nullptr;
    double l = 4.7, w = 1.9, drv = 1, vmax = 30;
    enum class Mode : uint8_t { Road, Parked, Knocked, Gone } mode = Mode::Gone;
    int road = -1, dir = 1;
    double s = 0, v = 0, off = 0, offT = 0, offQ = 0, brake = 0;
    int nextJ = -2;        // junction index (-1 none, -2 not picked yet)
    double x = 0, y = 0, z = 0, yaw = 0, pitch = 0;
    double wait = 0, trip = 0, simAcc = 0, odo = 0;   // odo: metres driven along roads (autotest)
    int lot = -1, bay = -1;
    double kvx = 0, kvz = 0, kw = 0, kt = 0;   // knocked: sliding
  };
  std::vector<Car> list;
  int movingCount() const;

private:
  void spawn(Car& c, const dvec3& player, bool first);
  void drive(Car& c, double dt, const dvec3& player, const Drive* you, const std::vector<Obb>& buses);
  double clearance(const Car& c, const dvec3& player, const Drive* you, const std::vector<Obb>& buses) const;
  void placeOnRoad(Car& c);
  void toRoad(Car& c, int ri, double s, int dir, double v);
  void deadEnd(Car& c, const dvec3& player);
  bool inSight(double x, double z, const dvec3& player) const;
  double rnd() { seed_ = seed_ * 1664525u + 1013904223u; return double(seed_ >> 8) / double(1u << 24); }

  World& world_;
  Transport& t_;
  VehicleModels& models_;
  std::vector<int> main_, access_, scenic_;
  struct Junction { int access, road; double s; int lot; };
  std::vector<Junction> junctions_;
  std::vector<int> lots_;
  double recycleT_ = 0;
  dvec3 cam_{0}, camFwd_{0, 0, 1};
  unsigned seed_ = 7919;
};

} // namespace sl
