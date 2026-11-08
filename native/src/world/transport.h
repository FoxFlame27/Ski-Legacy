// The transport network's data (Phase 3), from transport.json's `net` (native/tools/export_net.mjs runs the game's own
// planning: game/bus/roads.js, speedlimits.js, railroute.js, expressroute.js, ...):
//   roads        centre lines (x, y, z, arc length every ~4 m) with the stops at their ends and speedlimits.js's
//                profile (signed limit, braked envelopes of the limit and the bends, both ways); roads.js roadAt
//   lots, junctions, lay-bys, guardrail lines (busRoads.rails: the cars slide along them, break through over
//                100 km/h), road tunnels (the tubes: inside, the ground is the road)
//   the queries the vehicles and the player need: laneDistance, the road's smooth surface (world.roadSurface),
//                tarmac (drive.js onTarmac), the speed limit where you are, the railway and Legacy Express track
//                decks (railroute.js railDeckHeight / expressroute.js expressDeckHeight)
//   Line         a railway's centre line sampled every STEP m (railAt / expressAt, nearest point)
//   the vehicles' descriptors: car models (fit, specs), the Micruss bus, the railcar
#pragma once
#include "core/math.h"
#include <nlohmann/json_fwd.hpp>
#include <string>
#include <unordered_map>
#include <vector>

namespace sl {
class World;

struct Road {
  int n = 0;
  std::vector<float> X, Y, Z, S;
  double length = 0;
  int from = -1, to = -1;
  bool access = false, scenic = false, depot = false, heli = false, ring = false, loop = false, chalet = false;
  std::vector<int16_t> kmh;
  std::vector<float> limF, limB, vcF, vcB;
  int indexAt(double s) const;
};
struct RoadPoint { double x = 0, y = 0, z = 0, dx = 0, dz = 1, grade = 0; int i = 0; };
/// roads.js roadAt: the point at arc length s (heading over ~10 m)
RoadPoint roadAt(const Road& r, double s);

struct Bay { double x, z, hx, hz; bool taken = false; };
struct Lot {
  std::string name;
  double x = 0, z = 0, y = 0, ux = 1, uz = 0, vx = 0, vz = 1, hw = 0, hd = 0, ex = 0, ez = 0;
  bool building = false, impound = false, scenic = false, hospital = false, depot = false;
  std::vector<Bay> bays;
};
struct Guardrail { double ax, az, bx, bz; bool tunnel = false; double offUntil = -1; };
struct RoadTunnel { std::vector<dvec3> pts; double wi = 4.6, hc = 6.6; dvec2 bmin{1e30}, bmax{-1e30}; };
struct StopInfo { std::string name; double x = 0, z = 0, heading = 0; bool noRoad = false; };

/// A railway centre line sampled every `step` m (railroute.js RAIL / expressroute.js EXPRESS)
struct Line {
  double step = 2, length = 0;
  int n = 0;
  bool ring = false;
  std::vector<double> X, Y, Z;
  struct P { double x, y, z, dx, dz, grade; };
  P at(double s) const;
  double wrap(double s) const { return ring ? std::fmod(std::fmod(s, length) + length, length) : s; }
  struct Near { double d = 1e18, s = 0; };
  Near nearest(double x, double z, double maxD = 12) const;
  void index();
private:
  std::unordered_map<int64_t, std::vector<int>> grid_;
};
struct Span { double s0, s1; bool end = false; };

struct CarSpec {
  std::string name, label, kind, drive = "awd";
  double accel = 5, top = 55, rev = 1, mass = 1700, length = 4.7, price = 0;
  bool electric = false;
  vec3 size{1.9f, 1.5f, 4.7f};
  mat4 fit{1};
  std::vector<std::string> hide;
  struct Glass { int i; bool red, clear; };
  std::vector<Glass> glass;
};

class Transport {
public:
  bool load(const nlohmann::json& net, const std::vector<uint8_t>& bin);
  bool loaded() const { return !roads.empty(); }

  // ---- roads.js queries
  /// distance from (x, z) to the nearest road centre line (Infinity beyond ~16 m)
  double laneDistance(double x, double z) const;
  /// nearest point on any road: road index, arc length, distance, and which side
  struct RoadHit { int road = -1; double s = 0, d = 1e18; };
  RoadHit nearestRoad(double x, double z, double maxD = 16) const;
  /// world.roadSurface: the road's surface (height + 3.5 cm) across the plowed width, eased back to the drawn terrain
  /// (`mesh`) over 1.5 m of shoulder; NaN away from the roads. In a road tunnel (below its crown) the tube's floor.
  double roadSurface(const World& world, double x, double z, double mesh, double yHint) const;
  /// drive.js onTarmac: the ploughed road, car parks, junctions, lay-bys
  bool onTarmac(double x, double z) const;
  /// speedlimits.js speedLimitAt: the signed limit (km/h) at the nearest road sample within maxD, 0 if none
  int speedLimitAt(double x, double z, double maxD = 3.4 + 2.5) const;
  /// busRoads.tunnelAt: inside a road tunnel's tube?
  const RoadTunnel* inRoadTunnel(double x, double z, double y, double pad = 0.4) const;
  /// guardrail segments near (x, z) (16 m grid)
  const std::vector<int>* railsNear(double x, double z) const;

  // ---- the railways' track decks (walkable: the ballast, sleepers, viaduct decks, platforms)
  double railDeckHeight(double x, double z) const;
  double expressDeckHeight(double x, double z) const;
  bool inRailTunnel(double s) const;
  bool inExpressTunnel(double s) const;
  double loopOffset(double s) const;

  std::vector<Road> roads, legs;   // legs: busRoads.busLegs (the chalet village's and the scenic stops')
  std::vector<StopInfo> stops;
  std::vector<Lot> lots;
  std::vector<dvec2> junctions;
  std::vector<dvec3> laybys;       // x, z, yaw
  std::vector<Guardrail> rails;
  std::vector<RoadTunnel> tunnels;
  struct Parked { std::string name; dvec3 pos; double yaw, length; };
  std::vector<Parked> parked;
  bool hasAutohaus = false;
  dvec3 autohaus{0};
  dvec2 autohausDir{0, 1};

  std::vector<CarSpec> cars;
  const CarSpec* car(const std::string& name) const;
  std::vector<int> busGlass, busPaint;   // the Micruss's glass and paint materials
  struct BusSpec { std::string model; mat4 fit{1}; double len = 9.3, width = 2.55, floor = 0.95, lane = 1.55, cruise = 26, acc = 1.7, brake = 2.0, lat = 2.6, wheelBase = 6.8; int fleet = 8;
                   struct S { vec3 p; bool window; int side, row; }; std::vector<S> seats; bool ok = false; } bus;

  struct Station { std::string id, name, course; double s = 0, s0 = 0, s1 = 0, side = 1, heading = 0; bool halt = false, underground = false;
                   dvec3 pos{0}; dvec2 board{0}; bool hasBoard = false; dvec3 exit{0}; bool hasExit = false; };
  struct RailData {
    bool ok = false;
    std::string name;
    Line line;
    std::vector<Station> stations;
    std::vector<Span> tunnels, bridges;
    struct { double s0 = 2410, s1 = 2650, off = 4.6, ease = 46; } loop;
    std::vector<float> V, T;
    int i0 = 0, i1 = 0;
    double trip = 0, dwellMid = 20, dwellEnd = 40, dwellBot = 40, cycle = 600, tripS0 = 0, tripS1 = 0;
    std::vector<std::pair<std::string, int>> stops;
    int units = 2, price = 50;
    struct { double len = 17.2, half = 8.6, hw = 1.32, floor = 1.04, bogie = 5.9, gap = 1.0, roofTop = 3.64; } car;
    mat4 bodyFit{1};
    bool hasBody = false;
    vec3 seat{0.6f, 1.5f, 5.4f};
    double seatYaw = 0;
    std::vector<vec3> bogies;
  } rail;
  struct ExpressData {
    bool ok = false;
    std::string name;
    Line line;
    double trackOff = 2.3, loop = 0, dwell = 30, vmax = 125, fast = 10;
    int price = 75;
    std::vector<Span> tunnels, bridges;
    std::vector<float> V, T;
    std::vector<Station> stations;
  } express;
  /// the procedural railcar parts (local meshes in transport.bin): name -> json list (built by Vehicles)
  const nlohmann::json* railModels = nullptr;

  static constexpr double ROAD_HALF = 3.4;

private:
  struct Seg { float ax, az, bx, bz; int ri; float s; };
  std::unordered_map<int64_t, std::vector<Seg>> laneGrid_;     // 16 m cells
  std::unordered_map<int64_t, std::vector<int>> railGrid_;     // 16 m cells -> rails
  std::unordered_map<int64_t, std::vector<std::pair<int, int>>> limitGrid_;  // 24 m cells -> (road, sample)
  std::vector<std::string> keep_;
};

} // namespace sl
