// Placed scenery for Phase 1: the forests (vegetation.js tree placement, ported exactly: same grid, hashes, forest
// density and clearances, so trees stand where they stand in the web game) drawn as instanced pine GLBs with
// meshoptimizer LODs, and the village / mountain hut buildings from the exported placements (village.js).
// Also owns the static colliders (building boxes, lamp posts) and the tree trunk queries the player collides with.
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace sl {
class World;
class JobSystem;
class AssetManager;
namespace platform { class Platform; }
class AssetPaths;

struct Collider {
  double x = 0, z = 0;
  double r = -1;                  // circle radius (r >= 0), else an oriented box:
  double hw = 0, hd = 0, rot = 0; // half extents and rotation (player.js convention: rot = -yaw)
  double top = 1e30;              // world y of the top (can be jumped over); 1e30 = tall
};

struct Tree { float x, y, z, s, rot, trunk, crown; uint8_t type; };

struct VegetationSettings { float nearR = 70, midR = 220, farR = 650; };

class Scenery {
public:
  Scenery(gfx::Device& dev, World& world, JobSystem& jobs, AssetManager& assets, const VegetationSettings& vs);
  ~Scenery();
  bool loadVillage(platform::Platform& p, const AssetPaths& paths);
  void update(const dvec3& cam, bool force = false);
  void finish(const dvec3& cam);  // wait for the cells in range (loading / tests)
  void submit(Renderer& r, bool trees = true, bool buildings = true);

  /// vegetation.js collide(): the first tree whose trunk (or crown) overlaps a circle of radius r at (x, z).
  const Tree* treeAt(double x, double z, double r, bool crown) const;
  const std::vector<Collider>& colliders() const { return colliders_; }
  size_t treesDrawn() const { return drawn_; }

  static constexpr double CELL = 64, SPACING = 6.5;

private:
  struct Cell { std::vector<Tree> trees; };
  static int64_t key(int64_t cx, int64_t cz) { return (cx << 32) ^ (cz & 0xffffffff); }
  void genCell(int64_t cx, int64_t cz, Cell& out) const;
  void rebuildInstances(const dvec3& cam);

  gfx::Device& dev_;
  World& world_;
  JobSystem& jobs_;
  AssetManager& assets_;
  VegetationSettings vs_;
  std::shared_ptr<Model> treeModel_[2];
  mat4 treeFit_[2];
  InstanceBatch batches_[2][3];
  std::unordered_map<int64_t, Cell> cells_;
  std::unordered_set<int64_t> queued_;
  mutable std::mutex m_;
  std::vector<std::pair<int64_t, std::unique_ptr<Cell>>> done_;
  std::shared_ptr<int> alive_;
  dvec3 lastBuild_{1e18};
  bool dirty_ = true;
  size_t drawn_ = 0;

  struct Placed { std::shared_ptr<Model> model; dvec3 pos; mat4 local; float radius; };
  std::vector<Placed> placed_;
  std::vector<Collider> colliders_;
};

} // namespace sl
