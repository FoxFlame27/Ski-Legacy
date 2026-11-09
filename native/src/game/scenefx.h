// (Phase 7) the scene's extras, after the web game's world/ and game/ modules:
//   lamps        pistelights.js / village.js: the lamp posts' light pools on the snow at night (renderer point lights)
//   car lights   carlights.js: headlights (spot lights onto the road and the snow, the nearest cars), the lamps' glow
//                and tail lights (emissive quads), number plates (carconfig.js plates: "VS 123456", yours as bought)
//   snowmaking   snowmaking.js: at dusk and at night the snow guns nearest you blow a plume of fine snow over the run
//   flags        flags.js: the house-style masts (a row of three in the village plaza, one each side of every World
//                Cup finish), the cloths streaming downwind and rippling (harder in a storm)
//   snowcats     snowcats.js: groomers working the runs at night, headlights on (parked by day)
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "game/vehicles.h"
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sl {
class Resort;
class World;
class AssetManager;
class Shapes;
struct FontSet;
struct PlayData;

/// a car to light / plate this frame (Drive::carPoses, Traffic::carPoses)
struct CarPose {
  const VehicleModel* vm = nullptr;
  glm::dmat4 M{1};          // the pose without the model's fit
  std::string plate;
  bool lights = false, brake = false, mine = false;
};

class SceneFx {
public:
  void init(gfx::Device& dev, AssetManager& assets, const Resort& resort, World& world, const FontSet& fonts,
            const std::vector<std::vector<dvec2>>& pistes, const PlayData* play, float npcScale, float lodScale);
  /// per frame: the clock (hours), how dark it is (Lighting::night), the wind (weather), the camera
  void update(double dt, double hour, float night, double wind, const dvec3& cam);
  /// lights (call after Renderer::beginFrame) and the 3D pieces into the vehicle batches
  void submit(Renderer& r, VehicleDraw& vd, Shapes& shapes, const Camera& cam, const std::vector<CarPose>& cars);

  int sprays() const { return nSprays_; }
  int snowcats() const { return int(cats_.size()); }
  int flags() const { return int(masts_.size()); }
  int lampsLit() const { return nLamps_; }
  int carLights() const { return nCarLights_; }
  int plates() const { return nPlates_; }
  /// (autotest) the snow gun nearest p
  bool gunNear(const dvec3& p, dvec3& pos, dvec3& dir) const {
    double best = 1e18;
    for (const Gun& g : guns_) { double d = glm::length(g.pos - p); if (d < best) { best = d; pos = g.pos; dir = g.dir; } }
    return best < 1e17;
  }

private:
  const Model* plateModel(const std::string& text);
  gfx::Device* dev_ = nullptr;
  World* world_ = nullptr;
  const FontSet* fonts_ = nullptr;
  float night_ = 0, lodScale_ = 1;
  double hour_ = 10, t_ = 0, wind_ = 0;
  dvec3 cam_{0};
  std::vector<dvec3> lamps_;
  struct Gun { dvec3 pos; dvec3 dir; };
  std::vector<Gun> guns_;
  std::vector<int> running_;
  struct Seed { float a, b, c, d; };
  std::vector<Seed> seeds_;
  struct Mast { dvec3 pos; int design; };
  std::vector<Mast> masts_;
  std::shared_ptr<Model> segs_[4][8];   // the cloths: per design, 8 slices of one canvas texture
  struct Cat { std::vector<dvec2> path; double s = 0, dir = 1, len = 0; dvec3 pos{0}; double yaw = 0, pitch = 0; };
  std::vector<Cat> cats_;
  std::shared_ptr<Model> catModel_, puff_;   // puff_: a soft round sprite (the spray's particles)
  mat4 catFit_{1};
  std::unordered_map<std::string, std::shared_ptr<Model>> plates_;
  std::vector<std::string> plateOrder_;
  int nSprays_ = 0, nLamps_ = 0, nCarLights_ = 0, nPlates_ = 0;
};

} // namespace sl
