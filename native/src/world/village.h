// The native game's own village layout (Nov 2026): native/data/village.json + village.bin, written by
// native/tools/village/village_layout.mjs from the exported world. The JS game keeps its village; the C++ applies this
// one ON TOP of the exported packs, so a later export from the JS does not wipe it:
//   relief       the village's levels (the Oberdorf terraces climbing north-west to the Legacy Express station, the
//                church's knoll, the streets climbing through them): a 2 m grid of height deltas World::height adds.
//                Zero wherever an exported thing stays (roads, lifts, stations, pistes, the square's furniture).
//   applyToPack  the resort pack edited as it loads: the old village's eight identical hotels, its lamp ring, its cobble
//                paths, snowmen and firewood (and their colliders) out; the new buildings (Meshy models under
//                public/models/village), retaining walls, the church stair, lamps, trees, benches, fountains, bus
//                shelters and snow banks in as props with colliders; the new paving as baked meshes
//   places       the hotels' doors, the buildings (the trail map), the walking network (the village's people), the spawn
#pragma once
#include "core/math.h"
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include <nlohmann/json_fwd.hpp>

namespace sl {
class World;
class AssetPaths;
struct Model;
namespace platform { class Platform; }

struct VillageDoor { std::string name; dvec2 at{0}, in{0}, out{0}; double w = 1; };
struct VillageBuilding { std::string id, name, kind; double x = 0, z = 0, yaw = 0, w = 0, d = 0, h = 0; };

class Village {
public:
  Village();
  ~Village();
  /// native/data/village.json(.zst) + village.bin(.zst); false (no village of its own: the exported one as it is) without it
  bool load(platform::Platform& p, const AssetPaths& paths);
  bool loaded() const { return loaded_; }
  /// the relief at (x, z) in metres (0 outside the grid, or with reliefOn false). Thread safe.
  double delta(double x, double z) const;
  /// (--verify-heights compares the JS terrain: the relief off)
  bool reliefOn = true;
  /// whether (x, z) is where the relief raises / cuts the ground
  bool inRelief(double x, double z) const { return reliefOn && std::fabs(delta(x, z)) > 0.005; }

  /// Edits an exported pack as it loads (only the resort pack has anything to edit): see the header. `model` loads a
  /// prop's model with the pack's own options (its bounds place it).
  void applyToPack(const std::string& pack, nlohmann::json& j, std::vector<uint8_t>& bin, World& world,
                   const std::function<std::shared_ptr<Model>(const std::string&)>& model) const;

  /// A walk from `from` to `to` along the village's streets (the last point is `to`); `lane` shifts the in-between
  /// points sideways (m) so people do not walk in single file.
  std::vector<dvec2> route(const dvec2& from, const dvec2& to, double lane = 0) const;
  const std::vector<VillageDoor>& hotels() const { return hotels_; }
  const std::vector<VillageBuilding>& buildings() const { return buildings_; }
  /// the player's start on the square (x, z, yaw) and the hotel the autotest walks into
  dvec3 spawn() const { return spawn_; }
  dvec2 autotestHotel() const { return autotestHotel_; }

  /// A site of the exported world moved somewhere else (village.json "moves", round 2: the heliport...): everything of
  /// every pack within r of `from` (props, colliders, baked triangles, walkable decks, the play data's places: pads,
  /// doors, parking spots, paths) is carried rigidly to `to`, turned by rot (yaw adds rot), raised by dy. The relief
  /// at `to` copies the old site's ground, so all of it sits as it sat.
  struct Move { std::string name; dvec2 from{0}, to{0}; double r = 0, rot = 0, dy = 0; };
  const std::vector<Move>& moves() const { return moves_; }
  /// the move whose source holds (x, z), or null
  const Move* moveAt(double x, double z) const;
  /// (x, z) carried by m
  static dvec2 movePoint(const Move& m, dvec2 p);

private:
  void applyMoves(const std::string& pack, nlohmann::json& j, std::vector<uint8_t>& bin) const;
  std::vector<Move> moves_;
  bool loaded_ = false;
  double x0_ = 0, z0_ = 0, step_ = 2;
  int nx_ = 0, nz_ = 0;
  std::vector<int16_t> relief_;
  std::shared_ptr<nlohmann::json> j_;
  std::vector<VillageDoor> hotels_;
  std::vector<VillageBuilding> buildings_;
  std::vector<dvec2> nodes_;
  std::vector<std::vector<int>> adj_;
  dvec3 spawn_{4, 34, PI};
  dvec2 autotestHotel_{62, 34};
};

} // namespace sl
