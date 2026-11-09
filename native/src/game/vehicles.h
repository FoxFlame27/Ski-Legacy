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
struct CarPose;   // (Phase 7, game/scenefx.h)

struct VehicleModel {
  std::shared_ptr<Model> model;
  mat4 fit{1};
  vec3 size{1.9f, 1.5f, 4.7f};
  bool ok() const { return bool(model); }
  // (Phase 7, cars.js splitWheels) the body without its wheels (in the fitted space: nose +z, wheels on y 0) and the
  // four wheels as their own pieces centred on their axles (they roll; the front ones steer), for the near LOD
  std::shared_ptr<Model> body;
  struct Wheel { std::shared_ptr<Model> model; vec3 c{0}; float r = 0.33f; bool front = false; };
  std::vector<Wheel> wheels;
  bool split() const { return body && wheels.size() == 4; }
  vec3 lampF{0.7f, 0.68f, 2.3f}, lampR{0.68f, 0.85f, -2.3f};   // a headlamp / tail lamp (right side; mirrored in x)
};

/// (Phase 7) car paint colours (carconfig.js PAINTS, linear) by id, and a traffic / parked car's by its index
vec4 paintColor(const std::string& id);
vec4 paintForIndex(uint32_t k);

class VehicleModels {
public:
  void load(gfx::Device& dev, AssetManager& assets, Transport& t, Resort& resort);
  const VehicleModel* car(const std::string& name) const;
  VehicleModel bus;
  struct Rail { VehicleModel body, express; std::shared_ptr<Model> cabin, frame, bogie, lo; } rail;   // express: (Phase 7) the blue livery
private:
  std::unordered_map<std::string, VehicleModel> cars_;
};

class VehicleDraw {
public:
  void begin() { for (auto& [m, b] : batches_) for (auto& l : b.inst) l.clear(); }
  /// One instance this frame (world matrix incl. the model's fit). lod 0: near, 1: far
  void add(const Model* m, const glm::dmat4& M, int lod = 0, const vec4& tint = vec4(1, 1, 1, 0));
  /// (Phase 7) a car: M its pose (without the model's fit); near (lod 0) with its wheels turning (spin: the roll angle,
  /// steer: the front wheels' angle), else the whole model; tint: its paint (a = 0: the model's own)
  void addCar(const VehicleModel& vm, const glm::dmat4& M, int lod, const vec4& tint, double spin = 0, double steer = 0);
  void submit(Renderer& r, gfx::Device& dev, const dvec3& cam);
private:
  struct Batch { std::vector<std::pair<glm::dmat4, vec4>> inst[2]; MatrixInstanceBatch gpu[2]; uint32_t cap[2] = {0, 0}; };
  std::unordered_map<const Model*, Batch> batches_;
};

/// A collision box for vehicles (drive.js obb): centre, heading, half width / half length
struct Obb { double x, z, yaw, hw, hd; };

/// Rumble / sound events the game turns into controller vibration (and later audio)
struct VehicleEvent { enum class Type : uint8_t { Bump, Crash, Land, Knock, RailHit, Break } type; float amount = 0; std::string text; };

} // namespace sl
