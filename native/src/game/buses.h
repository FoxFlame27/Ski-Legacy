// The ski buses: a port of src/game/bus/bus.js (BusLine) and skibus.js. The network is a tree rooted at the village
// (bus.js parent / toRoot / legs: the roads and busRoads.busLegs); a trip is one leg per road driven forward or in
// reverse with bus.js leg()'s speed profile (BUS.cruise, slower in the bends by BUS.lat, from and to a standstill
// in the bays, BUS.acc / BUS.brake). The fleet (FLEET_N buses: bus 0 waits at the village between rides, the others
// on their rounds village -> a stop -> village) brakes for the traffic and for you. Riding: E at a stop with a bus
// route boards (a fleet bus waiting there, else bus 0 comes), you sit in a window seat, the bus drives the legs (at a
// stop on the way it turns there for the next leg), Space runs it x8, you get off by the front door.
#pragma once
#include "game/vehicles.h"

namespace sl {
class Drive;
class Traffic;

class BusLine {
public:
  BusLine(World& w, Transport& t, VehicleModels& m) : world_(w), t_(t), models_(m) {}
  void init();
  void update(double dt, const dvec3& player, const Drive* you, const Traffic* traffic, bool fast);
  void addDraw(VehicleDraw& draw, const dvec3& cam) const;
  void boxes(std::vector<Obb>& out) const;
  void fillColliders(std::vector<Collider>& out) const;

  // ---- riding
  /// the stop within reach of p (index into transport stops) and whether a bus route serves it, -1 if none
  int stopNear(const dvec3& p, double r = 9) const;
  bool canRide(int from, int to) const;
  /// destinations from a stop (stop indices with a route)
  std::vector<int> destinations(int from) const;
  bool board(int from, int to);
  bool riding() const { return ride_.on; }
  int rideBus() const { return ride_.on ? ride_.bus : -1; }   // (Phase 6: the seat registry's 'bus:<n>')
  struct RideState { dvec3 seat{0}, fwd{0, 0, 1}; std::string hint; bool arrived = false; dvec3 exit{0}; };   // exit: x, z, heading
  RideState rideState() const;
  void abort() { ride_.on = false; }
  double rideSpeed() const;
  dvec3 busPos() const;
  double busYaw() const;
  std::string stopName(int i) const { return i >= 0 && size_t(i) < t_.stops.size() ? t_.stops[size_t(i)].name : ""; }

  /// (Phase 7, audio) where buses pulled out of a stop since the game last took them (a horn)
  std::vector<dvec3> departures;

private:
  struct Leg { std::vector<double> X, Y, Z, S, V; double length = 0, s0 = 0, s1 = 0; int to = -1; };
  const Road* parent(int stop) const;
  std::vector<const Road*> toRoot(int stop) const;
  bool legs(int from, int to, std::vector<Leg>& out) const;
  Leg leg(const Road& r, bool rev) const;
  struct Pose { dvec3 pos; double yaw, pitch; };
  Pose place(const Leg& t, double s) const;
  double clearAhead(const Leg& t, double s, double v, const dvec3& player, const Drive* you, const Traffic* traffic, int self) const;

  World& world_;
  Transport& t_;
  VehicleModels& models_;
  struct Bus {
    std::vector<Leg> legs;
    int li = 0;
    double s = 0, v = 0, dwell = 0;
    int at = -1;        // the stop it waits at (-1 while driving)
    int dest = 0;       // round: the stop it is heading out to
    bool idle = true;
    Pose pose{dvec3(1e9), 0, 0};
    bool visible = false;
  };
  std::vector<Bus> fleet_;
  int round_ = 1;
  struct Ride { bool on = false; int bus = 0, from = -1, to = -1; double wait = 0, arrive = 0; bool done = false, exitSent = false; } ride_;
  vec3 seatLocal_{-0.9f, 1.4f, 0.5f};
};

} // namespace sl
