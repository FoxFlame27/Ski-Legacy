// Gondolas and chairlifts in motion: a port of src/world/lifts.js (LiftLine / Lifts) on the lines export_resort.mjs
// writes from the JavaScript layout (the stations, the supports after lifts.js fitted its towers for clearance, the
// cars' starting places after spreadByTime). Same haul rope (sagging spans, levelled through the mid-station), the
// same speeds, car spacing and mid-station crawl, the gentle swing, the cabins / chairs drawn instanced with three
// detail levels; boarding at a station (the next car brought to the boarding point, the loop shifted as lifts.js
// does), riding in your seat, getting off at the mid-station or at the far end at lifts.js's exit spot.
// The static parts (towers, haul ropes, bullwheels, chair terminals, padding) are in the exported resort meshes.
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include <memory>
#include <string>
#include <vector>
#include <nlohmann/json_fwd.hpp>

namespace sl {
class AssetManager;

struct LiftExit { double x = 0, z = 0, heading = 0; };
struct Seat { dvec3 pos{0}, fwd{0, 0, 1}; };

struct LiftLine {
  std::string name, type, bottomName, topName;
  bool main = false, gondola = true;
  int price = 0;
  dvec3 bottom{0}, top{0}, B{0}, T{0};
  double L = 1, yaw = 0;
  dvec2 dir{0, 1}, sideV{1, 0};
  struct Cfg { double stationH = 7.5, side = 3.4, speed = 18, carGap = 64, carH = 3.1, seatDrop = 2.5, stationSize = 14; } cfg;
  bool hasMid = false;
  struct Mid { double u = 0, x = 0, y = 0, z = 0; int side = 1; std::string name; } mid;
  std::vector<dvec2> supports;   // (u, y)
  std::vector<double> s;         // each car's place on the loop [0, 2L)
  std::vector<int> side;
  std::vector<dvec3> pos;
  LiftExit exitUp, exitDown, midExit;
  dvec2 carSize{2, 1};
  bool near = true;

  double uOf(double q) const { return q < L ? q : 2 * L - q; }
  double speedAt(double q) const;
  bool inStation(double q) const;
  dvec3 cableAt(double u, int sd) const;
  int carState(double q, dvec3& out) const;
  void advance(size_t i, double t);
  void update(double dt, double timeScale);
  double travelTime(double s0, double dist) const;
  struct Pick { size_t idx; double t; };
  Pick pickCar(double target) const;
  Seat seatFor(size_t idx) const;
};

class Lifts {
public:
  bool load(gfx::Device& dev, AssetManager& assets, const nlohmann::json& lifts);
  void update(double dt, const dvec3& viewer);
  void submit(Renderer& r, const dvec3& viewer);

  struct Station { LiftLine* line = nullptr; bool up = true, mid = false; double dist = 1e18; };
  /// lifts.js nearestStation: the closest bottom (up) / top (down) / mid-station (both ways)
  Station nearestStation(const dvec3& p);
  Seat board(LiftLine& line, bool up, bool atMid);
  struct RideState { bool riding = false; Seat seat; bool atStop = false; std::string stopName; bool arrived = false; LiftExit exit; };
  RideState updateRide();
  bool leaveAtStop(LiftExit& out);
  bool riding() const { return ride_.line != nullptr; }
  LiftLine* rideLine() const { return ride_.line; }
  double rideProgress() const;   // 0..1 along the ride
  /// (Phase 6) the cabin / chair you ride as the server's vehicle id ('L<line>-<car>'), its kind and seats; "" if none
  std::string rideVehicle(std::string& kind, int& seats) const {
    if (!ride_.line) return "";
    kind = ride_.line->gondola ? "gondola" : "chair";
    seats = ride_.line->gondola ? 6 : 4;
    return "L" + std::to_string(ride_.line - lines_.data()) + "-" + std::to_string(ride_.idx);
  }
  std::vector<LiftLine>& lines() { return lines_; }
  double timeScale = 1;

private:
  std::vector<LiftLine> lines_;
  struct CarKind { std::shared_ptr<Model> model; mat4 fit{1}; InstanceBatch lod[3]; };
  CarKind cabin_, chair_;
  bool hasCars_ = false;
  struct Ride { LiftLine* line = nullptr; size_t idx = 0; bool up = true, clearOfStop = true; } ride_;
};

} // namespace sl
