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
  bool hasPlates = false;              // (carconfig.js plateSpots) the plates' places in the car's frame, exported
  std::vector<glm::dmat4> plates;
  // (Phase 7, cars.js splitWheels) the body without its wheels (in the fitted space: nose +z, wheels on y 0) and the
  // four wheels as their own pieces centred on their axles (they roll; the front ones steer), for the near LOD
  std::shared_ptr<Model> body;
  struct Wheel { std::shared_ptr<Model> model; vec3 c{0}; float r = 0.33f; bool front = false; };
  std::vector<Wheel> wheels;
  bool split() const { return body && wheels.size() == 4; }
  // (cars.js t.steering) the steering wheel as its own piece round its centre (it turns about the column's axis in the
  // car you drive: drive.js updateBody), null where the model has none / the car is not split
  std::shared_ptr<Model> steer;
  vec3 steerC{0}, steerAxis{0, -0.37f, 0.93f};
  // the wheel as cars.js measured it on this model (t.steering: centre, rake, rim radius), whether or not it is split
  // off: where the driver's seat slides to and where the hands hold it (drive.js placeRig, carpeople.js)
  bool steerKnown = false;
  float steerTilt = 0.38f, steerRimR = 0.185f;
  vec3 lampF{0.7f, 0.68f, 2.3f}, lampR{0.68f, 0.85f, -2.3f};   // a headlamp / tail lamp (right side; mirrored in x)
  const CarSpec* spec = nullptr;          // (the exported lamps: world/transport)
  std::vector<gfx::Texture> matTex;       // the GLB materials' base colour maps (the lamps glow through them)
};

/// (cars.js dropPlates) leaves the triangles whose middles (car frame: fit * node) are in cen out of m's primitives
/// (their CPU copy needed: keepCpu; the far LODs simplified again); the number left out
size_t dropTriangles(gfx::Device& dev, Model& m, const mat4& fit, const std::vector<float>& cen);
/// (Phase 7) car paint colours (carconfig.js PAINTS, linear) by id, and a traffic / parked car's by its index
vec4 paintColor(const std::string& id);
vec4 paintForIndex(uint32_t k);
/// carconfig.js RIMS by id (linear; a = 0: the factory alloys, 0.5 gloss black, 1 the other colours)
vec4 rimColor(const std::string& id);

class VehicleModels {
public:
  void load(gfx::Device& dev, AssetManager& assets, Transport& t, Resort& resort);
  const VehicleModel* car(const std::string& name) const;
  /// (drive.js FULL) the full-detail model of a car (its interior), loaded the first time you get into one; null if
  /// the car has none
  const VehicleModel* full(const std::string& baseName);
  /// (carconfig.js dressCar) a car's model dressed as a config: its paint's finish on the body (`finish`: carconfig.js
  /// FINISH, 0 solid, 1 metallic, 2 pearl, 3 matte: roughness, metalness, clear coat; -1: the model's own paint as it
  /// is, a parked / traffic / display car) and its wheels' metal tinted (`rims`: a RIMS id; the tyres and brakes stay
  /// black; "orig" or a car whose wheels are not split off: as they are). The model itself when nothing changes.
  const VehicleModel* dressed(const VehicleModel* vm, int finish, const std::string& rims) const;
  /// (train.js trainUniforms.uCabin: 0.3 by day .. 1.2 at night and in a tunnel) the railcars' cabins lit by their
  /// own strips: the strips' emission x (0.8 + 3.2 k); the surfaces' warm share of it comes from the lamps the game
  /// puts along the ceiling of the car you ride in (cabinLight(): k)
  void setCabinLight(float k);
  float cabinLight() const { return cabinK_; }
  /// (bus.js busGlass) the bus's windows: dark privacy glass from outside, light (16 %, #6f8796) while you sit inside
  void setBusGlassInside(bool in);
  VehicleModel bus;
  struct Rail { VehicleModel body, express; std::shared_ptr<Model> cabin, cabinExpress, frame, bogie, lo, loExpress; } rail;   // cabinExpress: the Legacy Express's furnished cabin (expressinterior.js)
  //   // express: (Phase 7) the blue livery
private:
  std::unordered_map<std::string, VehicleModel> cars_;
  std::unordered_map<std::string, VehicleModel> full_;
  mutable std::unordered_map<std::string, std::unique_ptr<VehicleModel>> rimmed_;
  mutable std::unordered_map<const VehicleModel*, const VehicleModel*> rimBase_;
  struct CabinMat { Model* model; size_t i; vec3 lamp; };
  std::vector<CabinMat> cabinMats_;
  float cabinK_ = -1;
  int busGlassIn_ = -1;
  std::vector<int> busGlassMats_;
  gfx::Device* dev_ = nullptr;
  AssetManager* assets_ = nullptr;
  const Transport* t_ = nullptr;
};

class VehicleDraw {
public:
  void begin() { for (auto& [m, b] : batches_) for (auto& l : b.inst) l.clear(); }
  /// One instance this frame (world matrix incl. the model's fit). lod 0: near, 1: far
  void add(const Model* m, const glm::dmat4& M, int lod = 0, const vec4& tint = vec4(1, 1, 1, 0));
  /// (Phase 7) a car: M its pose (without the model's fit); near (lod 0) with its wheels turning (spin: the roll angle,
  /// steer: the front wheels' angle; wheelTurn: the steering wheel's angle about its column), else the whole model;
  /// tint: its paint (a = 0: the model's own); rim: the configurator's rim colour (rimColor; a = 0: the factory alloys)
  void addCar(const VehicleModel& vm, const glm::dmat4& M, int lod, const vec4& tint, double spin = 0, double steer = 0, double wheelTurn = 0,
              const vec4& rim = vec4(1, 1, 1, 0));
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
