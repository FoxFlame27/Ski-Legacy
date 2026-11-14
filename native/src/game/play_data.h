// The gameplay data of Phase 5 (native/data/play.json, written by tools/export_play.mjs from the game's own modules):
// the World Racing courses and the ski bus's free races (line, gates, checkpoints, prizes), the RACING stand, the job
// sites (boards, destinations, piste-side spots, the router's lifts), the taxi's places, the sites planned with the roads
// (police station / prison, the Autohaus car park with its impound row, the heli pad, the medical centre), the 18
// chalets, the chalet's ground floor plan and the furniture catalogue (game/build/catalog.js).
#pragma once
#include "core/math.h"
#include <nlohmann/json_fwd.hpp>
#include <memory>
#include <string>
#include <vector>

namespace sl {

/// A course's line (parkour/track.js conventions: heading = atan2(dx, dz), lateral + toward (-cos h, sin h)), 2 m samples
struct CourseLine {
  int n = 0;
  double ds = 2;
  std::vector<float> X, Y, Z, W, H, K;
  std::vector<float> B, F;   // (bots.js Track) the piste's bank (rad, + leans right) and the snow's friction (1 groomed, < 1 ice)
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
  double houseS = -1e9;   // the start house (courses.js startHouse.s): the grid keeps clear of it
  std::vector<CoursePt> checkpoints;
  std::vector<CourseGate> gates;
  CourseLine line;
  /// a floodlit night course (floodlights.js: course.def.night) and its masts: x, y, z, yaw, the lamps' centre, the aim
  bool night = false;
  struct Mast { double x, y, z, yaw, lx, ly, lz, ax, ay, az; };
  std::vector<Mast> masts;
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

/// a room the web game builds as its own scene (export_rooms.mjs): the room's frame (x across, y up from the floor, z:
/// + toward the door), what you bump into and what you can aim at
struct RoomDef {
  bool ok = false;
  double W = 8, D = 8, H = 3, eye = 1.62, spawnX = 0, spawnZ = 0, spawnYaw = 0;
  double bounds[4] = {-4, 4, -4, 4};           // x0, x1, z0, z1 your feet stay within
  struct Circle { double x, z, r; };
  std::vector<Circle> obstacles;
  bool hasCounter = false; double counter[4] = {0, 0, 0, 0};   // minX, maxX, minZ, maxZ
  struct Hit { std::string kind, id, name; dvec3 bmin{0}, bmax{0}; bool up = false; };
  std::vector<Hit> hits;
  bool hasClerk = false; double clerkX = 0, clerkZ = 0, clerkYaw = 0; std::string clerkChar;
  vec3 background{0.01f, 0.006f, 0.003f};
  struct Light { int type; vec3 color; float intensity, distance; dvec3 p; };   // type 0 point, 1 spot, 2 directional, 3 hemisphere, 4 ambient
  std::vector<Light> lights;
  // (the Autohaus showroom, carrentalroom.js) the mezzanine: its floor's height and front edge, the stair up to it along
  // the wall (x0, x1, z0 at the top, z1 at the foot), what stands up there; the cars on show (the model, where)
  bool hasStair = false; double stair[4] = {0, 0, 0, 0}, FL = 0, MZ = 0;
  std::vector<Circle> obstaclesUp;
  struct Car { std::string id, label; int price = 0; glm::dmat4 M{1}; bool up = false; vec4 paint{1, 1, 1, 0}; };   // paint: a = 0 the model's own
  std::vector<Car> cars;
  bool hasShell = false; dvec3 shell{0};   // a room the C++ walks on its own walls: where the exported model goes in its frame
};

struct PlayData {
  bool ok = false;
  RoomDef shop, autohaus, prisonRoom;   // prisonRoom: the exported look of the police station (its model's place: shell)
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
  /// (export_play.mjs exportHeli / exportWard) the helicopter, its pad, the ambulance; the medical centre inside
  std::shared_ptr<nlohmann::json> heli, ward;
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
