// The gameplay data of Phase 5 (native/data/play.json, written by tools/export_play.mjs from the game's own modules):
// the World Racing courses and the ski bus's free races (line, gates, checkpoints, prizes), the RACING stand, the job
// sites (boards, destinations, piste-side spots, the router's lifts), the taxi's places, the sites planned with the roads
// (police station / prison, the Autohaus car park with its impound row, the heli pad, the medical centre), the 18
// chalets, the chalet's ground floor plan and the furniture catalogue (game/build/catalog.js).
#pragma once
#include "core/math.h"
#include <nlohmann/json_fwd.hpp>
#include <array>
#include <cmath>
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
  /// the course's set pieces along its line (courses.js features: kicker, tabletop, roller, bridge, tunnel, lake, slalom,
  /// narrow, cliff, bank; land1 = where a jump's landing ends, NaN without one) and its own rating (course.difficulty)
  struct Feature { std::string type; double s0 = 0, s1 = 0, land1 = std::nan(""); };
  std::vector<Feature> features;
  std::string difficulty;
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
  /// type 0 point, 1 spot, 2 directional, 3 hemisphere, 4 ambient; role (the web room's updateLight): 0 as built, 1 the
  /// daylight through the windows, 2 the sky light, 3 a lantern (brighter after dark), 4 the stove's fire (flickers)
  struct Light { int type; vec3 color; float intensity, distance; dvec3 p; int role = 0; };
  std::vector<Light> lights;
  // (the Autohaus showroom, carrentalroom.js) the mezzanine: its floor's height and front edge, the stair up to it along
  // the wall (x0, x1, z0 at the top, z1 at the foot), what stands up there; the cars on show (the model, where)
  bool hasStair = false; double stair[4] = {0, 0, 0, 0}, FL = 0, MZ = 0;
  std::vector<Circle> obstaclesUp;
  struct Car {
    std::string id, label; int price = 0; glm::dmat4 M{1}; bool up = false; vec4 paint{1, 1, 1, 0};   // paint: a = 0 the model's own
    std::string paintId = "white";                 // carrental.js DISPLAY / UPPER: the paint it stands in
    double x = 0, y = 0, z = 0, yaw = 0, length = 4.6;   // its turntable (the floor it stands on), its heading
  };
  std::vector<Car> cars;
  // (the showroom's moving parts, each a model of its own: export_rooms.mjs) the sliding doors' leaves, the salesman's
  // marker (arrow, ring), the polished floor's tiles (drawn over the mirrored hall); the door bay (x, width, height)
  struct Leaf { std::string model; dvec3 p{0}; double dir = 0, slide = 0; };
  std::vector<Leaf> doors;
  std::string markerArrow, markerRing, floorModel;
  double door[3] = {0, 3.7, 2.7}, RISE = 0;
  /// the glass (the web game's live view of the world outside): the planes' matrices in the room (their normal into the
  /// room), their size; where the room stands outdoors: the point in front of its door, the way it faces, E within r
  struct Pane { mat4 m{1}; float w = 1, h = 1; };
  std::vector<Pane> panes;
  bool hasDoor = false; double doorX = 0, doorZ = 0, frontX = 0, frontZ = 1, doorR = 3.2;
  dvec3 podium{0};
  bool hasClock = false; mat4 clock{1};   // the wall clock's hands: their frame (turned about its z)
  bool hasShell = false; dvec3 shell{0};   // a room the C++ walks on its own walls: where the exported model goes in its frame
};

/// inside a chalet as the web game builds it (export_rooms.mjs from chaletroom.js): the house frame (x toward the front
/// door, z along the house, y up from the ground outside: the ground floor at G, the upper floor at FL)
struct ChaletRoomDef {
  bool ok = false;
  double eye = 1.62, radius = 0.28;
  struct Seg { double ax, az, bx, bz, half; };
  std::vector<Seg> solid[3];                    // ground, upstairs, the stair's sides (on the ground floor)
  std::vector<RoomDef::Circle> round[2];
  struct Box { double x, z, hw, hd, rot; };
  std::vector<Box> boxes[2];
  /// a hinged door: the hinge on the floor, the shut leaf along u, the wall's normal n; base / k: its model's turn
  /// (rotation.y = base - angle * k); inward: the front door's open angle
  struct Door { std::string key; double hx = 0, hz = 0, ux = 1, uz = 0, nx = 0, nz = 1, w = 0.9, h = 2.1, y0 = 0, inward = 0, base = 0; int k = 1; bool up = false, front = false; };
  std::vector<Door> doors;
  struct Lamp { double x, y, z, power; bool up; };
  std::vector<Lamp> lamps;
  std::vector<RoomDef::Pane> panes;
  double doorX = 0, doorZ = 0, doorNx = 1, doorNz = 0;   // chaletroom.js doorAt: just inside the front door, its outward normal
  double IX = 3.72, IZ = 5.78, G = 0.3, GC = 2.95, FL = 3.15, rise = 0.178, run = 0.27, stepsX1 = 5.32, doorZc = -0.17;
  int steps = 16;
  double stair[4] = {-1.83, -0.78, -2.6, 1.72}, hole[4] = {-1.83, -0.78, -1.9, 1.72}, dormerZ0 = -2.8, dormerZ1 = 2.8;   // x0, x1, z0, z1
  struct Rm { std::string name; bool up = false; std::vector<Rect2> rects; };
  std::vector<Rm> rooms;
  vec3 background{0.6f, 0.7f, 0.8f};
};

/// the police station inside (export_rooms.mjs from prison.js): the walker's boxes, the cells, the way out, the guard,
/// the glass; outdoors: the door's spot, the room's two wings on the house (the windows' frames), its colliders
struct PrisonDef {
  bool ok = false;
  double eye = 1.62, radius = 0.26;
  std::vector<std::array<double, 4>> boxes;     // x0, x1, z0, z1
  std::vector<dvec2> cellDoors;
  double roomX0 = -5.4, roomX1 = 9, roomZ0 = -4, bars = -0.4, roomZ1 = 3.6, frontX0 = 9, frontX1 = 17, frontZ0 = -4, frontZ1 = 5.6, cellW = 3.6, exitX = 16.95, exitZ = 2.6;
  std::vector<double> cells;
  bool hasGuard = false; double guardX = 0, guardZ = 0;
  std::vector<RoomDef::Pane> panes;
  bool hasOutside = false; double doorX = 0, doorZ = 0, doorYaw = 0;
  glm::dmat4 cellsFrame{1}, officeFrame{1};     // room -> world, the cell block / the front office
  dvec3 outsideAt{0};                           // where the station's exported model stands
  struct Col { double x, z, hw, hd, rot, r, top = 1e30; };
  std::vector<Col> colliders;
  bool hasPatrol = false; double patrolX = 0, patrolZ = 0, patrolYaw = 0;   // the patrol car parked in the first bay
};

/// the chalet village outdoors (export_rooms.mjs from chalets.js build()): where its exported model stands, the lit
/// windows' panes (about that point) and their warmth, the street lamps' lanterns, what you bump into
struct ChaletVillageDef {
  bool ok = false;
  dvec3 at{0};
  struct Win { mat4 m{1}; vec3 c{1}; };
  std::vector<Win> windows;
  std::vector<dvec3> lamps;
  std::vector<PrisonDef::Col> colliders;
  struct Inst { std::string key; std::vector<mat4> m; };   // a model standing many times (about `at`)
  std::vector<Inst> inst;
};

/// the Werkstatt (export_rooms.mjs from werkstatt.js): where its exported model stands, the garage frame (origin on the
/// floor in the middle, +z out of the bay toward the road, +x along it), the repair box, the workbench, the colliders
struct WerkstattDef {
  bool ok = false;
  dvec3 at{0};
  double x = 0, z = 0, ax = 1, az = 0, fx = 0, fz = 1, yaw = 0;
  double bayX = -3.5, bayZ = -0.6, bayHw = 1.6, bayHl = 2.9, benchX = 3.4, benchZ = -4.8, IW = 6.7, ID = 5.2, repairS = 4;
  std::vector<PrisonDef::Col> colliders;
};

struct PlayData {
  bool ok = false;
  WerkstattDef werkstatt;
  ChaletRoomDef chaletRoom;
  std::vector<std::array<double, 3>> hutDoors;   // village.js: the huts' door spots (x, z, the reach)
  bool hasTickets = false; std::array<double, 3> tickets{15, -50, 2.6};   // the ticket booth's counter spot
  ChaletVillageDef chaletVillage;
  PrisonDef prisonDef;
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
