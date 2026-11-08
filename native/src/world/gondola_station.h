// The gondola stations, built procedurally: a port of src/world/gondolastation.js (buildGondolaStation: the valley /
// summit end stations; buildGondolaMidStation: the pass-through mid-stations). Same frame, dimensions, parts and
// colours, merged per material (base / metal / glass / light) plus the signs, whose canvas (the lift's name, the
// station, TICKETS, ENTRANCE, the next-cabin screens) is drawn with the C++ canvas and Barlow Condensed.
// The colliders and walkable surfaces come from the exported data (export_resort.mjs samples the JS stations').
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {
namespace gfx { class Device; }
class World;
struct FontSet;

struct GondolaStationParams {
  bool mid = false, top = false;
  double x = 0, y = 0, z = 0, yaw = 0;
  int mx = 1;
  float side = 3.4f, ropeY = 7.5f, carH = 3.1f;
  std::string name, place, up, down;
  std::vector<vec2> rope;   // ropeAt samples every 0.5 m: end z = 0..9, mid z = -13..13 (NaN: none)
};

/// Builds the station's model in its local frame (origin on the station's ground at the bullwheel / the hall's centre,
/// +z down / up the line); place it with translate(x, y, z) * rotateY(yaw).
std::shared_ptr<Model> buildGondolaStation(gfx::Device& dev, const World& world, const FontSet& fonts, const GondolaStationParams& p);

} // namespace sl
