// Placed scenery for Phase 1: the forests (vegetation.js tree placement, ported exactly: same grid, hashes, forest
// density and clearances, so trees stand where they stand in the web game) drawn as instanced pine GLBs with
// meshoptimizer LODs, and the village / mountain hut buildings from the exported placements (village.js).
// Also owns the static colliders (building boxes, lamp posts) and the tree trunk queries the player collides with.
// The mountains' rocks (vegetation.js rockSpot / placeRock, ported exactly the same way: same grid points, hashes and
// clearances): the Meshy rock models (public/models/rocks, tools/meshy-rocks.mjs) drawn as matrix instances with the
// snow-on-top rock shading (shading kind 4), with their colliders (rockAt).
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include <functional>
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
  bool soft = false;              // a net / fence: a soft bump, never a wipeout
  // (Phase 3)
  bool rail = false;              // a guardrail's own collider (cars slide along busRoads.rails instead)
  double brk = 0;                 // breakable (world/breakables.js): a car faster than this (m/s) knocks it flying
  bool lamp = false;              // ...a street lamp
  mutable double downUntil = -1;  // knocked down until this time (s): no collider
};

struct Tree { float x, y, z, s, rot, trunk, crown; uint8_t type; };
/// One rock (vegetation.js placeRock): its collider (x, z, r; s the collision size: under 2.6 it is skied over; y + 0.75 s
/// its top) and, for v >= 0, the model and its world matrix (rotation x scale `m`, column-major 3x3, at (x, base, z)) with
/// the terrain plane under it (gx, gz: gradient, gh: height at x, z) for the snow banked at its foot. v = -1: an
/// elongated rock's extra collider.
struct Rock {
  double x, z;
  float y, s, r;
  int8_t v;
  float base, w;       // the model's base height and its width (m)
  float m[9];
  float gx, gz, gh;
};

struct VegetationSettings {
  float nearR = 70, midR = 220, farR = 650;
  float impostorR = 0;      // far forest impostors (vegetation.js's billboard forests) out to this (m), 0: none
  int maxImpostors = 30000;
  int shadowLods = 1;       // tree LODs that cast into the shadow map
  float rockR = 230;        // rocks drawn within this (m; crags and outcrops to twice it), quality.js veg.rockR
};

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
  /// ...the first rock (collision size >= minSize: smaller ones are skied over) overlapping it
  const Rock* rockAt(double x, double z, double r, double minSize) const;
  /// vegetation.js onExpressBed / onRailBed: no rock on the railways' formations (set by the game once the transport
  /// is loaded, before any cell is generated; called from the worker threads: read-only)
  using RailBedFn = std::function<bool(double x, double z, double size)>;
  RailBedFn railBed;
  /// The rocks of one 64 m cell as genCell places them (--verify-heights compares them with the JavaScript's)
  static void cellRocks(const World& wd, const RailBedFn& rb, int64_t cx, int64_t cz, std::vector<Rock>& out);
  size_t rocksDrawn() const { return rocksDrawn_; }
  const std::vector<Collider>& colliders() const { return colliders_; }
  /// Replaces the static colliders (the resort's, from export_resort.mjs) and indexes them on a 32 m grid.
  void setColliders(std::vector<Collider> c);
  /// Indices of the colliders that can touch a point in the 32 m cell of (x, z) (padded by their reach + 1 m).
  const std::vector<int>* collidersNear(double x, double z) const;
  /// Phase 1 placements (world.json): only when there is no resort data.
  bool hasResort() const { return !colliderGrid_.empty(); }
  size_t treesDrawn() const { return drawn_; }
  /// (Phase 3) moving bodies the player bumps into: parked / traffic cars, the buses, the trains near you (refilled
  /// by the vehicles every frame)
  std::vector<Collider> dynamic;
  /// (Phase 5) inside an interior (prison, hospital, chalet): no tree is in the way
  bool noTrees = false;

  static constexpr double CELL = 64, SPACING = 6.5;

private:
  struct Cell { std::vector<Tree> trees; std::vector<Rock> rocks; };
  struct FarTree { float x, y, z, s; uint8_t type; float seed; };
  struct FarCell { std::vector<FarTree> trees; };
  void updateFar(const dvec3& cam);
  void rebuildImpostors(const dvec3& cam);
  std::unordered_map<int64_t, FarCell> far_;
  std::unordered_set<int64_t> farQueued_;
  std::vector<std::pair<int64_t, std::unique_ptr<FarCell>>> farDone_;
  ImpostorBatch impostors_;
  dvec3 lastImp_{1e18};
  bool farDirty_ = false;
  static int64_t key(int64_t cx, int64_t cz) { return (cx << 32) ^ (cz & 0xffffffff); }
  static void genCell(const World& wd, const RailBedFn& rb, int64_t cx, int64_t cz, Cell& out, bool rocks);
  void rebuildInstances(const dvec3& cam);
  void rebuildRocks(const dvec3& cam);

  gfx::Device& dev_;
  World& world_;
  JobSystem& jobs_;
  AssetManager& assets_;
  VegetationSettings vs_;
  std::shared_ptr<Model> treeModel_[2];
  mat4 treeFit_[2];
  InstanceBatch batches_[2][3];
  static constexpr int ROCK_KINDS = 5;
  std::shared_ptr<Model> rockModel_[ROCK_KINDS];
  mat4 rockFit_[ROCK_KINDS];
  MatrixInstanceBatch rockBatch_[ROCK_KINDS][3];   // full mesh (close), 25 %, 8 % (crags and outcrops far off)
  dvec3 rockOrigin_{0}, lastRocks_{1e18};
  size_t rocksDrawn_ = 0;
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
  std::unordered_map<int64_t, std::vector<int>> colliderGrid_;
};

} // namespace sl
