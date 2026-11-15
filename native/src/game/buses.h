// The ski buses: a port of src/game/bus/bus.js (BusLine) and skibus.js. The network is a tree rooted at the village
// (bus.js parent / toRoot / legs: the roads and busRoads.busLegs); a trip is one leg per road driven forward or in
// reverse with bus.js leg()'s speed profile (BUS.cruise, slower in the bends by BUS.lat, from and to a standstill
// in the bays, BUS.acc / BUS.brake). The fleet (FLEET_N buses: bus 0 waits at the village between rides, the others
// on their rounds village -> a stop -> village) brakes for the traffic and for you. Riding: E at a stop with a bus
// route boards (a fleet bus waiting there, else bus 0 comes), you sit in a window seat, the bus drives the legs (at a
// stop on the way it turns there for the next leg), Space runs it x8, you get off by the front door.
// Something in its lane (bus.js clearAhead / steerShift / poseBus / ramContact): it brakes to a stop STOP_GAP short of
// something standing (CLEAR_GAP behind something moving), sounds its horn after HORN_T, pulls round it after PASS_WAIT
// (1.5 s behind something crawling) when the other lane is clear far enough ahead and the road goes on long enough: an
// eased S-curve into the other lane (a critically damped spring, the front axle leading: it steers, never slides),
// slowly (PASS_V) round something standing, back in once its own lane is clear beside and behind it; held up RAM_T in
// all it drives on through at RAM_V, shoving cars aside.
// The fleet's timetable (bus.js buildFleet / fleetTarget / fleetDrive / updateFleet, Nov 2026): bus:1..7 run their
// rounds (out from the village to a terminus and back to their own bay at the depot) on the web game's slotted
// timetable, exported at full precision (transport.json fleet): where a bus is is a function of the clock alone (single
// player: the fleet's own clock; online: each round its own shared timeline 'bus|R<round>', the server clock plus its
// speed-up), so every client, native or web, places every bus at the same spot. Near you a bus drives itself (the
// timetable less a delay of its own while held up, overtaking, pushing through) and, online, its hold-up is reported
// to the server (busHold) so the others place it from that record (followStep), and a client that sees it run into
// something takes it over (mustTake). Online you wait at the stop for a real bus going your way and ride it (mpBoard)
// in the seat the server gave you; bus 0 (single player's own bus, in its bay at the depot) is not used online.
#pragma once
#include "game/vehicles.h"
#include <functional>
#include <map>

namespace sl {
class Drive;
class Traffic;

class BusLine {
public:
  BusLine(World& w, Transport& t, VehicleModels& m) : world_(w), t_(t), models_(m) {}
  void init();
  void update(double dt, const dvec3& player, Drive* you, Traffic* traffic, bool fast);
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
  /// the shared timeline's line of the bus you ride ('R<round>': the server's warp 'bus|R<round>'), "" for bus 0
  std::string rideLine() const;
  /// the seat you sit in (the server's seat registry, online)
  void setRideSeat(int n);
  /// the Micruss's seats (bus.js seatCount: the seat registry's capacity)
  int seatCount() const { return std::max(1, int(t_.bus.seats.size())); }

  // ---- multiplayer (net/transit.js hooks.bus): the fleet on the shared timelines, the hold-ups
  struct Hold { std::string bus; double d = 0, dd = 0, sh = 0, sv = 0, bt = 0, at = 0; bool ram = false, clear = false; int own = 0; };
  struct Mp {
    std::function<double(const std::string& line)> time;   // s: the round's shared timeline (lineTime / 1000)
    std::function<double(const std::string& line)> rate;   // its speed-up now
    std::function<double()> now;                           // ms: the server clock (the records' stamps)
    std::function<int()> pid;                              // you
    std::function<void(const Hold&)> report;               // a busHold of a bus you drive (clear: d 0, sh 0)
  };
  /// online (the hooks) or single player again (nullptr)
  void setMp(const Mp* hook);
  bool mpOn() const { return mpOn_; }
  /// a 'busHold' broadcast / the 'busHolds' list on joining
  void setHold(const Hold& h);
  void setHolds(const std::vector<Hold>& list);
  /// (bus.js mpBuses) every bus from stop `from` that goes on to `to`, soonest first: wait (s until it stands at the
  /// stop, 0: there now), left (s it still stands there)
  struct Next { int bus = -1; double wait = 1e18, left = 0; };
  std::vector<Next> mpBuses(int from, int to) const;
  /// (bus.js mpBoard) get on fleet bus `bus` standing at `from`, for `to`
  bool mpBoard(int bus, int from, int to);
  /// (debug) every bus of the fleet: id, x, z, speed, the stop it stands at
  std::string debugFleet() const;
  /// (multiplayer) the others about, on foot / on skis (ped) or in their cars: the buses stop for them too
  struct ExtraOb { double x, y, z, yaw, hw, hd, v; bool ped; };
  std::vector<ExtraOb> extraObs;
  struct RideState { dvec3 seat{0}, fwd{0, 0, 1}; std::string hint; bool arrived = false; dvec3 exit{0}; };   // exit: x, z, heading
  RideState rideState() const;
  /// (bus.js seatWorldAt) where seat n of fleet bus `bus` is now, the way it faces; false if it is not out
  bool seatWorld(int bus, int n, dvec3& pos, double& yaw) const;
  void abort();
  double rideSpeed() const;
  dvec3 busPos() const;
  double busYaw() const;
  std::string stopName(int i) const { return i >= 0 && size_t(i) < t_.stops.size() ? t_.stops[size_t(i)].name : ""; }

  /// (Phase 7, audio) where buses pulled out of a stop, or sounded their horn at something in the way, since the game
  /// last took them (a horn)
  std::vector<dvec3> departures;
  /// (autotest) lane changes begun (pulling out to overtake), times a bus pushed through, the furthest out a bus is now
  int overtakes = 0, rams = 0;
  double maxShift() const;
  /// (autotest) the fleet: how many buses, where bus k is, how fast, how far out into the other lane (0..1)
  int fleetSize() const { return int(fleet_.size()); }
  dvec3 fleetPos(int k) const { return fleet_[size_t(k)].pose.pos; }
  double fleetYaw(int k) const { return fleet_[size_t(k)].pose.yaw; }
  double fleetSpeed(int k) const { return fleet_[size_t(k)].v; }
  double fleetShift(int k) const { return fleet_[size_t(k)].shift; }
  bool fleetDriving(int k) const { return fleet_[size_t(k)].at < 0 && fleet_[size_t(k)].v > 0.1; }
  /// (debug, SKI_LEGACY_DEBUG=bustest) somebody standing in the lane of a bus on its round, 45 m ahead of it: where to
  /// stand (true while the test runs) and a camera on the scene; the bus's speed and lane offset are logged
  bool debugStand(dvec3& p, double& heading);
  bool debugCam(dvec3& pos, dvec3& look) const;

private:
  struct Leg { std::vector<double> X, Y, Z, S, V; double length = 0, s0 = 0, s1 = 0; int to = -1; };
  /// (bus.js fleetDir) one way of a round: the trips joined (s1: the next stop's mark, set before clearAhead)
  struct Path : Leg { std::vector<Transport::FleetWay::Mark> marks; std::vector<double> kt, ks; double sA = 0, sB = 0, dur = 0; };
  /// (bus.js fleetTarget) where a bus's timetable has it: the way (0 out, 1 back), s, v, the mark it stands at (-1)
  struct Target { int dir = 0, mark = -1; double s = 0, v = 0, tau = 0; };
  struct HoldAt { double d = 0, sh = 0, bt = 0; bool fresh = false, ram = false, done = false; int own = 0; };
  const Road* parent(int stop) const;
  std::vector<const Road*> toRoot(int stop) const;
  bool legs(int from, int to, std::vector<Leg>& out) const;
  Leg leg(const Road& r, bool rev) const;
  struct Pose { dvec3 pos; double yaw, pitch; };
  struct Bus;
  /// everything a bus must not drive through (bus.js obstacles()), gathered once per update
  struct Ob { double x, y, z, yaw, hw, hd, v; enum Kind : uint8_t { Car, You, Ped, BusK } kind; int fleet, car, park; bool hasY, drive; };
  void gather(const dvec3& player, double dt, Drive* you, Traffic* traffic);
  Pose place(const Leg& t, double s, double shift = 0, double shiftV = 0, double v = 0) const;
  double clearAhead(const Leg& t, Bus& r, double dt, double want, int self, bool probe = false);
  void ramContact(const Bus& b, int self, double dt);
  static void steerShift(Bus& r, double dt, double v, double lane);
  static void resetPass(Bus& r);
  // the timetable (bus.js fleetTarget .. mpNextBus)
  const Path& way(const Bus& b, int dir) const;
  Target fleetTarget(const Bus& b, double late = 0) const;
  double roundTime(const Bus& b) const;
  void fleetReset(Bus& b, const Target& T);
  void fleetDrive(Bus& b, const Target& T, double dt);
  void updateFleet(double dt, const dvec3& p);
  bool holdFor(Bus& b, double now, HoldAt& H);
  double delayOf(const Bus& b) const;
  void holdReport(Bus& b, double now);
  bool yields(const Bus& b, const HoldAt& H, double now) const;
  void followStep(Bus& b, const Target& TH, const HoldAt& H, double dt, double dist);
  bool mustTake(Bus& b, double dt);
  bool serves(const Bus& b, int d, int i, int to) const;
  Next busAt(const Bus& b, int d, int i, double into, double c) const;
  void parkBus0();
  void driveRide(double dt, bool fast);

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
    // overtaking (bus.js r.shift .. r.horn): how far out in the other lane (0..1) and its rate, pulling out, the speed
    // round something standing, held up / slowed / blocked for how long, pushing through, the horn sounded
    double shift = 0, shiftV = 0, passV = 1e18, heldT = 0, slowT = 0, blockT = 0, ramFree = 0;
    bool passing = false, ram = false;
    int horn = 0;
    double dOtherAhead = 0, dNeed = 0, dOwnV = 0, dLeft = 0; bool dOtherNear = false, dOwn = false;   // (debug bustest: why it does or does not pull out)
    // the timetable (bus.js b.st): its round (index into transport fleet, -1: bus 0), its two ways, the way it drives
    // (dir), the mark it stands at (-1 driving), how long still (hold), how far behind (lag s, lagS m); taken off its
    // round for your ride (single player); online: driven by you (own) and reported, its last report
    int fi = -1;
    std::string id;
    Path out, back;
    bool st = false, taken = false, own = false, near = false;
    int dir = 0, mark = -1;
    double hold = 0, lag = 0, lagS = 0, sq = 0, dist = 1e18, vPrev = 0;
    double ownAt = 0, gaveUp = -1e18, repAt = 0, repD = 0, repDD = 0;
    bool repPass = false, repRam = false;
  };
  std::vector<Ob> obs_;
  Drive* you_ = nullptr;
  Traffic* traffic_ = nullptr;
  dvec3 lastPlayer_{1e18};
  double playerV_ = 0, playerYaw_ = 0, clock_ = 0;
  std::vector<std::pair<int, double>> shoved_;   // (ramContact: what was knocked when, 600 ms apart)
  struct Dbg { int bus = -1; dvec3 p{0}, cam{0}; double s = 0, h = 0, logT = 0; bool done = false; } dbg_;
  std::vector<Bus> fleet_;
  double fleetClock_ = 0;
  bool mpOn_ = false;
  Mp mp_;
  std::map<std::string, Hold> holds_;
  struct Ride { bool on = false, mp = false, departed = false; int bus = 0, from = -1, to = -1, seat = -1; double wait = 0, arrive = 0; bool done = false, exitSent = false; } ride_;
  vec3 seatLocal_{-0.9f, 1.4f, 0.5f};
};

} // namespace sl
