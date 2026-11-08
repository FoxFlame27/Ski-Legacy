// Phase 3: everything that moves on the roads and the rails, ported from the web game:
//   VehicleModels   the car GLBs fitted as cars.js fitCar does (nose +z, wheels on y 0, real length; stray planes
//                   hidden; glass tinted as carTemplate), the Micruss bus (bus.js buildMicruss), the railcar (train.js:
//                   the Meshy body stretched as setCarModel, the procedural underframe / bogies / cabin from the export)
//   VehicleDraw     per-frame instancing: every visible car / bus / railcar of a model in one draw per LOD
//   Drive           drive.js: get in / out (E), the bicycle-model car physics on the snow (engine through the gears,
//                   grip per surface, slip angles, handbrake, ESC, hill hold), springs, terrain walls, colliders,
//                   guardrails (slide along, break through over 100 km/h), breakable poles and lamps, other cars
//                   (impulses), damage (knock / crash / wreck), unstuck (U), flip back (F), lights, horn, the chase and
//                   cockpit cameras with look back; the Autohaus (carrental.js: buy a car, it waits in your bay)
//   Traffic         traffic.js: cars on the roads (right-hand lane, speedlimits.js targets and bends, following at a
//                   time gap, braking for you / your car / the buses, junctions onto the car parks' access roads,
//                   parking a while, turning at dead ends, knocked aside by you); parking.js's parked cars
//   BusLine         bus.js: the fleet on its rounds between the stops, riding as a passenger (board with E at a stop,
//                   the bus drives the legs, Space x8, off at the door)
//   Railway         railway.js / railroute.js: the Wolkenspitzbahn's two trains on the timetable (crossing on the
//                   passing loop), boarding at the stations, riding, halts, Space x6
//   Express         express.js: the Legacy Express's 16 trains round the ring (8 each way), boarding at any station for
//                   a chosen destination, the ride, Space x10
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "world/transport.h"
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sl {
class World;
class Scenery;
class AssetManager;
class Resort;
class Player;
struct Collider;

struct VehicleModel {
  std::shared_ptr<Model> model;
  mat4 fit{1};
  vec3 size{1.9f, 1.5f, 4.7f};
  bool ok() const { return bool(model); }
};

class VehicleModels {
public:
  void load(gfx::Device& dev, AssetManager& assets, Transport& t, Resort& resort);
  const VehicleModel* car(const std::string& name) const;
  VehicleModel bus;
  struct Rail { VehicleModel body; std::shared_ptr<Model> cabin, frame, bogie, lo; } rail;
private:
  std::unordered_map<std::string, VehicleModel> cars_;
};

class VehicleDraw {
public:
  void begin() { for (auto& [m, b] : batches_) for (auto& l : b.inst) l.clear(); }
  /// One instance this frame (world matrix incl. the model's fit). lod 0: near, 1: far
  void add(const Model* m, const glm::dmat4& M, int lod = 0);
  void submit(Renderer& r, gfx::Device& dev, const dvec3& cam);
private:
  struct Batch { std::vector<glm::dmat4> inst[2]; MatrixInstanceBatch gpu[2]; uint32_t cap[2] = {0, 0}; };
  std::unordered_map<const Model*, Batch> batches_;
};

/// A collision box for vehicles (drive.js obb): centre, heading, half width / half length
struct Obb { double x, z, yaw, hw, hd; };

/// Rumble / sound events the game turns into controller vibration (and later audio)
struct VehicleEvent { enum class Type : uint8_t { Bump, Crash, Land, Knock, RailHit, Break } type; float amount = 0; std::string text; };

} // namespace sl
