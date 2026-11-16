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
  /// clip (round 3): only what lies short of `clipMax` m along `clipDir` from `from` goes (a roadside site: its lot and
  /// buildings, not the road in front of it)
  /// lift (Nov 16, round 3 fixes): the exported terrain cuts (a piste's run-out ramp west of the Autohaus, up to 7 m)
  /// lay on top of the copied ground, so the Werkstatt stood 3.3 m and the police yard 1.4 m under the Dorfstrasse in
  /// front (its yard, sign and floor buried): a roadside site is raised by the cut where the road passes it (liftSites,
  /// added to dy) and within it the cuts give way to its own level (siteGround, World::height)
  struct Move { std::string name; dvec2 from{0}, to{0}; double r = 0, rot = 0, dy = 0; dvec2 clipDir{0}; double clipMax = 1e30; double lift = 0; };
  const std::vector<Move>& moves() const { return moves_; }
  /// (World::load, before the packs load and before prepareRoads) each roadside site's lift: `cut` (the exported
  /// cuts) at the road in front of it
  void liftSites(const std::function<double(double, double)>& cut);
  /// the ground of the raised sites: `cut` the exported cuts' delta here; returns what replaces it (the cut faded out
  /// into the sites' lift within them, over MOVE_FADE beyond their radius)
  double siteGround(double x, double z, double cut) const;
private:
  std::function<double(double, double)> cutAt_;   // (liftSites: the exported cuts, for the old sites' ground)
public:
  /// Roads of the village's own (village.json "roads", round 3: the Dorfstrasse through the village): appended to the
  /// transport pack's road network (traffic, police, the car's road surface and tarmac, speed limits) with their
  /// heights from the drawn ground, and drawn as the exported roads are (the roadsnow-road ribbon).
  void addRoads(nlohmann::json& j, std::vector<uint8_t>& bin, World& world) const;
  /// (Nov 16) the Autohaus car park (village.json "rentalPark"): the transport pack's impound lot put beside the moved
  /// Autohaus (its frame, mouth and bays: your cars' bays, the tow yard, the map follow), its asphalt (the car parks'
  /// roadsnow-lot material), the mouth onto the Dorfstrasse and the bay lines laid as meshes (addRoads)
  void addRentalPark(nlohmann::json& j, std::vector<uint8_t>& bin, World& world) const;
  /// The village's own roads cut into the ground (as roads.js cuts the terrain under the exported roads, their cut
  /// tiles): prepareRoads (World::load, once the cuts and regions are in) levels each road along its middle (the
  /// ground there, smoothed over +-16 m); roadCut (World::height) holds the ground 6 cm under that level across the
  /// ribbon and a flat shoulder 2.6 m wide each side (no 2 m terrain triangle that reaches under the ribbon climbs a
  /// terrace, a piste's groove or a bank), then eases it back into the ground over 5 m. Both ways (cut and fill),
  /// except within 24 m of a road's start (where it leaves an exported road: only cut, never over that road's own
  /// surface). Off with the relief (--verify-heights). Thread safe once prepared.
  void prepareRoads(const std::function<double(double, double)>& ground);
  double roadCut(double x, double z, double h) const;
  /// a road's level along its points (prepareRoads; empty before)
  const std::vector<double>& roadLevel(size_t road) const { static const std::vector<double> none; return road < roadLines_.size() ? roadLines_[road].y : none; }
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
  struct RoadLine { std::vector<dvec2> p; std::vector<double> y, s; double half = 3.4; dvec2 lo{0}, hi{0}; };
  std::vector<RoadLine> roadLines_;
  std::shared_ptr<nlohmann::json> j_;
  std::vector<VillageDoor> hotels_;
  std::vector<VillageBuilding> buildings_;
  std::vector<dvec2> nodes_;
  std::vector<std::vector<int>> adj_;
  dvec3 spawn_{4, 34, PI};
  dvec2 autotestHotel_{62, 34};
};

} // namespace sl
