// The railways' track swept along their centre lines (Phase 3): the Wolkenspitzbahn (railtrack.js buildTrack: a
// metre-gauge single track with its passing loop, ballast in the open, a concrete slab in the tunnels) and the Legacy
// Express (expresstrack.js: double track, a ballast prism of both tracks, slabs on the viaducts and in the tubes, the
// tubes' lining). Their cross-sections and heights are railtrack.js / expresstrack.js's (and match the walkable decks
// railroute.js / expressroute.js give the player); the viaducts, portals, stations, the Wolkenspitzbahn's tube linings
// and tunnel lamps are captured from the game's own builders (transport.json). Built in 250 m chunks at load, drawn by
// distance; the sleepers are instanced round the camera.
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include <memory>
#include <unordered_map>
#include <vector>

namespace sl {
class Transport;

class RailSweep {
public:
  void build(gfx::Device& dev, const Transport& t);
  /// the roads' guardrails (bus.js Guardrails: a galvanised W-beam on posts along busRoads.rails), swept per 256 m cell
  void buildGuardrails(gfx::Device& dev, const Transport& t, const class World& world);
  void submit(Renderer& r, const dvec3& cam);
  size_t chunkCount() const { return chunks_.size(); }

private:
  struct Chunk { std::shared_ptr<Model> bed, detail, lining; dvec3 origin; dvec3 bmin, bmax; };
  struct Sleeper { dvec3 p; double yaw, pitch; };
  void rebuildSleepers(const dvec3& cam);
  std::vector<Chunk> chunks_;
  std::vector<Sleeper> sleeperSpots_;            // every sleeper of both lines (positions only)
  std::vector<std::vector<int>> sleeperCells_;   // 128 m grid -> indices
  std::unordered_map<int64_t, int> cellIndex_;
  std::shared_ptr<Model> sleeper_;
  MatrixInstanceBatch sleepers_;
  dvec3 sleeperOrigin_{0}, lastCam_{1e18};
  gfx::Device* dev_ = nullptr;
};

} // namespace sl
