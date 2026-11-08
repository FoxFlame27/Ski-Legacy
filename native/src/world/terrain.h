// Streamed quadtree-LOD terrain (terrain.js): 3 x 3 root nodes of 16 km round the camera, split while the camera is
// closer than size * lodK, down to 128 m nodes of 64 x 64 quads (2 m: the physics grid). Nodes are generated on
// worker threads (heights band-limited to their spacing, normals, forest / groomed-piste data for the snow shader)
// and uploaded on the main thread; skirts hide LOD cracks.
#pragma once
#include "core/math.h"
#include "gfx/gfx.h"
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace sl {
class World;
class JobSystem;
class Renderer;

class Terrain {
public:
  static constexpr int SEG = 64;
  static constexpr double MIN_SIZE = 128, ROOT_SIZE = 16384;

  Terrain(gfx::Device& dev, World& world, JobSystem& jobs, float lodK);
  ~Terrain();
  /// Recompute the wanted nodes (when the camera moved > 24 m), queue builds, upload finished ones.
  void update(const dvec3& cam, int maxUploads = 6);
  /// Block until every wanted node is built (loading screens, tests).
  void finish(const dvec3& cam);
  void submit(Renderer& r, double shadowCastMaxSize = 512);
  int pending() const;
  size_t nodeCount() const { return active_.size(); }

private:
  struct Key { int64_t x, z, size; bool operator==(const Key& o) const { return x == o.x && z == o.z && size == o.size; } };
  struct KeyHash { size_t operator()(const Key& k) const { return size_t(k.x * 73856093 ^ k.z * 19349663 ^ k.size * 83492791); } };
  struct CpuNode { Key key; std::vector<float> verts; float minY, maxY; };
  struct GpuNode { gfx::Buffer vbo; gfx::VertexInput vi; float minY = 0, maxY = 0; };

  void computeDesired(const dvec3& cam);
  void build(const Key& k, CpuNode& out) const;
  void upload(CpuNode& n);
  void prune();

  gfx::Device& dev_;
  World& world_;
  JobSystem& jobs_;
  float lodK_;
  gfx::Buffer ibo_;
  uint32_t indexCount_ = 0;
  std::vector<int> ring_;
  std::vector<Key> desired_;
  std::unordered_set<Key, KeyHash> desiredSet_, queued_;
  std::unordered_map<Key, GpuNode, KeyHash> active_;
  std::mutex doneM_;
  std::vector<std::unique_ptr<CpuNode>> done_;
  std::shared_ptr<int> alive_;
  dvec3 lastCenter_{1e18};
};

} // namespace sl
