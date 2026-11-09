// The world heightfield: an exact port of src/world/world.js (baseHeight, pads, forest, corridors, crag mask),
// src/world/wolkenspitze.js and src/world/legacypeak.js, plus the terrain cuts exported by
// native/tools/export_world.mjs (piste grading, bowls, the railway's roadbed...) as a sparse 2 m delta grid.
//
// height() is const and thread safe (terrain and vegetation are built on worker threads). meshHeight() /
// groundHeight() are the physics surface (the 2 m triangle grid the near terrain mesh draws) with a small vertex
// cache: main thread only.
#pragma once
#include "core/math.h"
#include "core/noise.h"
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sl {
class AssetPaths;
namespace platform { class Platform; }

struct Massif {
  std::string id, name;
  double baseX, baseZ, topX, topZ, h, rFace, rBack, rLeft, rRight;
  double hornBack, hornH, hornR, crown, bowl, apron, foot;
  // derived (world.js constructor loop)
  double fx = 0, fz = 0, faceLen = 0, x = 0, z = 0, hx = 0, hz = 0;
  double kFace = 0, kBack = 0, kLeft = 0, kRight = 0, kHorn = 0, seed = 0, stationSlope = 0;
};

struct Pad { double x, z, r, blend, h; };
enum class CorridorKind : uint8_t { Piste = 0, Race = 1, Lift = 2 };
struct CorridorSeg { double ax, az, bx, bz, w; CorridorKind kind; };
/// A walkable surface above the terrain (a station's deck and stair): world.addSurface's height(x, z) sampled on a
/// grid by export_resort.mjs (int16 cm over `base`; -32768 = not over it).
struct SampledSurface {
  double x0 = 0, z0 = 0, step = 0.25, base = 0;
  int nx = 0, nz = 0;
  std::vector<int16_t> h;
  /// height at (x, z), or NaN where (x, z) is not over it
  double at(double x, double z) const;
};

struct CorridorHit { double d = 1e9; CorridorKind kind = CorridorKind::Piste; bool any = false; double dx = 0, dz = 1, lat = 0; bool groomed = false; };

class World {
public:
  World();
  ~World();
  /// Loads native/data (pads, corridors, crag mask, cuts, the Wolkenspitze trough). Without it the world is the
  /// bare analytic terrain.
  bool load(platform::Platform& p, const AssetPaths& paths);

  double baseHeight(double x, double z, double spacing = 0) const;
  double height(double x, double z, double spacing = 0) const;
  /// The physics surface: world.js meshHeight (2 m grid, same triangulation as the near terrain mesh).
  double meshHeight(double x, double z);
  /// world.js groundHeight: the terrain, or the highest walkable surface not far above yHint
  double groundHeight(double x, double z, double yHint = 1e30);
  void addSurface(SampledSurface s);
  vec3 groundNormal(double x, double z, double yHint = 1e30);

  CorridorHit corridorAt(double x, double z) const;
  double padInfluence(double x, double z) const;
  bool nearPad(double x, double z) const;  // vegetation.js nearPad
  double forest(double x, double z, double h, double slope) const;
  /// (Phase 7) world.js addCut({ forest }): the railways' formations thin the forest (no trees on the beds or right
  /// beside them; the forest over the tunnels stays). Each takes (x, z, f) and returns the new density; called from
  /// the scenery's worker threads (must be thread-safe: read-only).
  struct ForestCut { dvec2 bmin, bmax; std::function<double(double, double, double)> fn; };
  std::vector<ForestCut> forestCuts;
  double cragAllow(double x, double z) const;
  double thinned(double x, double z, double f) const;
  double cutDelta(double x, double z) const;
  /// (Phase 3) the World Racing courses' regions as exported (8 m bilinear delta over base + pads), and whether (x, z)
  /// is inside one (their forest density replaces the analytic one there)
  double regionDelta(double x, double z) const;
  bool inRegion(double x, double z) const;
  /// world.roadSurface (roads.js): (x, z, drawn terrain height, yHint) -> the road's surface or NaN. Replaces the
  /// terrain where it applies, like the JS (a road in a tunnel lies under the mountain).
  std::function<double(double, double, double, double)> roadSurface;
  /// Walkable decks given as functions (the railways' track beds, the Legacy Express's viaducts): NaN off them; taken
  /// like a sampled surface (above the ground, not far above yHint).
  void addDeck(std::function<double(double, double)> f) { decks_.push_back(std::move(f)); }

  const std::vector<Massif>& massifs() const { return massifs_; }
  const std::vector<Pad>& pads() const { return pads_; }
  bool hasData() const { return loaded_; }

  static constexpr double VILLAGE_R = 230;
  static constexpr int SEED = 7331;

private:
  double wolkenspitzeHeight(double x, double z, double h, double spacing) const;
  double legacyPeakHeight(double x, double z, double h, double spacing) const;
  void addCorridor(const CorridorSeg& s);

  Simplex N_, N2_;
  std::vector<Massif> massifs_;
  double shoulderH_ = 0;
  bool shoulderLock_ = false;

  std::vector<Pad> pads_;
  std::unordered_map<int64_t, std::vector<int>> padGrid_;       // 256 m cells
  std::vector<CorridorSeg> corridors_;
  std::unordered_map<int64_t, std::vector<int>> corridorGrid_;  // 64 m cells

  struct Crag { double x0 = 0, z0 = 0, cell = 10; int nx = 0, nz = 0; std::vector<float> d; } crag_;
  struct CutTile { float scale; std::vector<int16_t> v; };
  struct RegTile { float scale; std::vector<int16_t> v; std::vector<uint8_t> f; };
  int regCell_ = 8, regTile_ = 32;
  std::unordered_map<int64_t, RegTile> regs_;
  std::vector<std::function<double(double, double)>> decks_;
  int cutCell_ = 2, cutTile_ = 32;
  std::unordered_map<int64_t, CutTile> cuts_;

  struct Trough;
  std::unique_ptr<Trough> trough_;
  struct Peak;
  std::unique_ptr<Peak> peak_;

  std::vector<SampledSurface> surfaces_;
  std::unordered_map<int64_t, std::vector<int>> surfGrid_;      // 64 m cells

  struct VCache { int64_t key; double h; };
  std::vector<VCache> vcache_;
  bool loaded_ = false;
};

} // namespace sl
