// The gameplay data of Phase 5 (native/data/play.json, written by tools/export_play.mjs from the game's own modules):
// the World Racing courses and the ski bus's free races (line, gates, checkpoints, prizes), the RACING stand, the job
// sites (boards, destinations, piste-side spots, the router's lifts), the taxi's places, the sites planned with the roads
// (police station / prison, the Autohaus car park with its impound row, the heli pad, the medical centre), the 18
// chalets, the chalet's ground floor plan and the furniture catalogue (game/build/catalog.js).
#pragma once
#include "core/math.h"
#include <nlohmann/json_fwd.hpp>
#include <string>
#include <vector>

namespace sl {

/// A course's line (parkour/track.js conventions: heading = atan2(dx, dz), lateral + toward (-cos h, sin h)), 2 m samples
struct CourseLine {
  int n = 0;
  double ds = 2;
  std::vector<float> X, Y, Z, W, H, K;
  double length() const { return n > 1 ? (n - 1) * ds : 0; }
  double sAt(const std::vector<float>& a, double s) const;
  dvec3 point(double s, double lateral = 0) const;
  double heading(double s) const;
  double width(double s) const { return sAt(W, s); }
  /// nearest sample to (x, z), searched round the hint (or everywhere): arc length, lateral offset, distance
  struct Proj { double s = 0, lat = 0, d = 1e18; };
  Proj project(double x, double z, double hintS = -1, double window = 120) const;
};

struct CoursePt { double x = 0, y = 0, z = 0, heading = 0, s = 0; std::string name; };
struct CourseGate { double s, x, y, z, nx, nz, width; int side; bool blue; };

struct Course {
  std::string id, name, diff, ai, tagline, stop, end;
  uint32_t color = 0x2f7bff;
  int entry = 0, reward = 0, rewardMax = 0, drop = 0;
  double length = 0, par = 0, gold = 0, silver = 0, bronze = 0;
  bool bus = false;
  CoursePt start, finish;
  std::vector<CoursePt> checkpoints;
  std::vector<CourseGate> gates;
  CourseLine line;
  bool hasBoard = false;
  double boardX = 0, boardZ = 0, boardYaw = 0;
};

struct JobHub { std::string id, kind, name, place; double x = 0, z = 0, yaw = 0, fx = 0, fz = 0; bool hut = false; };
struct JobDest {
  std::string kind, id, label, to, place, role, hubId, lift, peak, race;
  double x = 0, z = 0, yaw = 0;
  bool npc = false, top = false;
};
struct JobSpot { double x, z, heading; int side; std::string piste; };
struct RouterLift { std::string name; bool gondola; double len; dvec2 bottom, top, topExit, bottomExit; };

struct TaxiPlace { std::string name; double x, z, sx, sz; };

/// a building's lot planned with the roads (roads.js: centre, frame u / v, half extents, the entrance on the road)
struct Site { bool ok = false; double x = 0, z = 0, y = 0, yaw = 0, hw = 0, hd = 0, ux = 1, uz = 0, vx = 0, vz = 1, ex = 0, ez = 0, dirx = 0, dirz = 1; };

struct ChaletHouse { int id = 0, num = 0; std::string name; double x = 0, y = 0, z = 0, yaw = 0, doorX = 0, doorZ = 0; };
struct ChaletWall { double ax, az, bx, bz, t, y0, y1; };
struct Rect2 { double x0, z0, x1, z1; };
struct FurnitureDef {
  std::string id, name, category, place;
  int price = 0;
  vec3 size{1};
  double mount = 0, light = 0, lux = 0;
  bool small = false, flat = false, seat = false;
};

struct PlayData {
  bool ok = false;
  std::vector<Course> courses, busRaces;
  bool hasStand = false;
  double standX = 0, standZ = 0, standYaw = 0;
  std::vector<JobHub> hubs;
  std::vector<JobDest> dests;
  std::vector<JobSpot> spots;
  std::vector<RouterLift> routerLifts;
  std::vector<TaxiPlace> taxi;
  Site prison, rentalPark, hospital, rental;
  dvec2 helipad{92, -128};
  std::vector<ChaletHouse> chalets;
  int chaletPrice = 50000;
  struct ChaletModel { double scale = 10.305, x = 0.2186, z = -0.2762, y = -0.405, HX = 4.02, HZ = 6.08, IX = 3.72, IZ = 5.78, G = 0.3, GC = 2.95, doorZ = -0.17; } chaletModel;
  struct ChaletPlan { double floorY = 0.3, ceilingY = 2.95; std::vector<Rect2> rects; std::vector<ChaletWall> walls; std::vector<Rect2> blocks; } chaletPlan;
  std::vector<FurnitureDef> furniture;
  std::vector<std::pair<std::string, std::string>> categories;
  double sellRefund = 0.5;

  bool load(const nlohmann::json& j, const std::vector<uint8_t>& bin);
  const Course* course(const std::string& id) const;
  const FurnitureDef* furnitureById(const std::string& id) const;
};

} // namespace sl
