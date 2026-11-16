// The resort (Phase 2): everything world/village.js, decor.js, resortdressing.js and lifts.js build in and around the
// village and on the mountains, from native/data/resort.json + resort.bin (export_resort.mjs runs those modules in
// Node and walks the scene they build):
//   props      every placed GLB (hotels, shops, huts, lamps, benches, market stalls, snow cannons, lift towers, chair
//              terminals, patrol huts, deck chairs...) at its exact matrix, drawn instanced per model and 512 m cell
//              with two levels of detail, its night glow (lit windows / lanterns) as in addNightGlow
//   meshes     the procedural geometry baked per material and 256 m cell (signs' boards, posts, bullwheels, haul
//              ropes, nets, tower padding, paths...); repeated pieces (piste markers, chair bullwheels) instanced
//   canvases   sign / signpost / cobble textures, replayed from the recorded canvas commands
//   stations   the gondola stations, built by gondola_station.cpp
//   lifts      moving cabins and chairs, boarding and riding (lifts.h)
//   colliders + walkable surfaces (decks, stairs) handed to Scenery / World
#pragma once
#include <functional>
#include "core/math.h"
#include "engine/canvas2d.h"
#include "engine/renderer.h"
#include "world/lifts.h"
#include "world/scenery.h"
#include <future>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include <nlohmann/json_fwd.hpp>

namespace sl {
class World;
class AssetManager;
class AssetPaths;
namespace platform { class Platform; }

class Resort {
public:
  Resort(gfx::Device& dev, World& world, AssetManager& assets) : dev_(dev), world_(world), assets_(assets) {}
  /// Loads the resort data; false (and nothing changes) without it.
  bool load(platform::Platform& p, const AssetPaths& paths, Scenery& scenery);
  /// (Phase 3) transport.json's `net` and its bin (the vehicles' data: world/transport.h), null without it
  const nlohmann::json* transportNet() const;
  const std::vector<uint8_t>& transportBin() const { return tbin_; }
  /// (Phase 5) play.json's `play` (courses, job sites, chalets...: game/play_data.h) and its bin
  const nlohmann::json* playData() const;
  const std::vector<uint8_t>& playBin() const { return pbin_; }
  /// A vehicle's procedural parts (export_net.mjs localModel: [{ mat, verts, vOff, ... }]) as one model
  std::shared_ptr<Model> transportModel(const nlohmann::json& parts);
  /// (rooms, export_rooms.mjs) a room the web game builds as a scene of its own (play.json's rooms.<id>.parts), as one
  /// model in the room's own frame; built when the play pack loads, null if the pack has none
  std::shared_ptr<Model> roomModel(const std::string& id) const;
  /// (the helicopter's parts, the ward: export_play.mjs localModel) a play pack local model
  std::shared_ptr<Model> playModel(const nlohmann::json& parts) { return partsModel(parts, pbin_, pmats_); }
  /// (Phase 7) the transport / play packs' parsed json and bins dropped once Transport, VehicleModels and PlayData have
  /// read them (hundreds of MB of DOM and raw data; the Switch budget)
  void releaseLoadData();
  void update(double dt, const dvec3& cam);
  /// view: a room window's view of the world (game/window_view): the props instance by instance, only those in the
  /// renderer's (window-narrowed) frustum or shading it
  void submit(Renderer& r, bool props = true, bool meshes = true, bool view = false);
  Lifts& lifts() { return lifts_; }
  /// (debug: SKI_LEGACY_DEBUG=railclear) what of the baked meshes and the placed props reaches into a clearance
  /// envelope (a train's swept volume): near(bmin, bmax) culls whole chunks / instances, inside(p) tests a point;
  /// hit(p, what) once per 4 m cell of each chunk / instance that reaches in (what: "<pack> mesh, mat <i> ..." or the
  /// prop's model name)
  void sweepClearance(const std::function<bool(const dvec3&, const dvec3&)>& near, const std::function<bool(const dvec3&)>& inside,
                      const std::function<void(const dvec3&, const std::string&)>& hit) const;
  size_t propCount() const { return nProps_; }
  // (Phase 7) streaming of the baked mesh chunks (the resort's, the transport's and the courses' meshes per cell): the
  // vertex / index bytes are kept zstd-packed on the CPU and uploaded within loadRadius of the camera, released past
  // loadRadius + 400 m (Switch: unified memory, so a released chunk is memory back). Distances x lodScale.
  float lodScale = 1.0f;
  int textureCap = 4096;   // (Phase 7) the canvases' (signs') size cap: the quality preset's
  bool compressTextures = false;   // (Phase 7) BC1 / BC3 (the switch preset)
  double loadRadius() const { return 1800.0 * lodScale + 250.0; }
  struct StreamStats { size_t chunks = 0, loaded = 0, gpuBytes = 0, packedBytes = 0, rawBytes = 0; int uploads = 0, releases = 0; };
  StreamStats streamStats() const { return stream_; }
  /// uploads every chunk in range at once (the loading screen; the autotest's teleports)
  void finishStreaming(const dvec3& cam) { streamChunks(cam, true); }
  /// (Phase 7) where the lamp posts' heads are (their light pools at night) and the snow cannons stand (spray)
  const std::vector<dvec3>& lamps() const { return lamps_; }
  const std::vector<glm::dmat4>& cannons() const { return cannons_; }
  const FontSet& fonts() const { return fonts_; }
  /// (world/breakables.js) a knocked pole / sign / lamp: the small placed prop standing at (x, z) (within `reach`, at most
  /// `maxR` big) hidden where it stood; its model and world matrix for the flying copy. -> a handle (>= 0) for
  /// standProp(), -1: nothing drawn there as a prop of its own (a baked mesh)
  struct KnockedProp { std::shared_ptr<Model> model; glm::dmat4 M{1}; float radius = 1; int64_t handle = -1; };
  int64_t knockProp(double x, double z, double reach, double maxR, KnockedProp& out);
  /// the prop stands again (breakables.js restore)
  void standProp(int64_t handle);
  /// (world/breakables.js) a breakable collider's own drawn parts (export_resort.mjs brkInst: each part an instance of
  /// its kind's set; prop: a GLB part too, knockProp at the collider; nid: its multiplayer id, breakables.js spotId)
  struct BreakParts { std::vector<int64_t> parts; bool prop = false; std::string nid; };
  const BreakParts* breakParts(int collider) const { auto it = brk_.find(collider); return it == brk_.end() ? nullptr : &it->second; }
  /// each part hidden where it stands (as knockProp), its model and world matrix appended to `out`
  void hideParts(const BreakParts& b, std::vector<KnockedProp>& out);
  /// (debug brkdrive) a part's world matrix and its model's box
  bool partMatrix(int64_t h, glm::dmat4& M, vec3& bmin, vec3& bmax) const;

private:
  struct Cell { dvec3 origin; std::vector<glm::dmat4> inst; MatrixInstanceBatch lod[2]; double radius = 10; dvec3 bmin{1e30}, bmax{-1e30}; std::vector<uint8_t> band; };   // band: each instance's last LOD (0 near, 1 far, 2 off)
  struct PropSet { std::shared_ptr<Model> model; float radius = 5; std::vector<Cell> cells; bool shadow = true; std::string what; std::vector<uint64_t> loc; };   // loc: the pack's instance k -> (cell << 20 | index in it)
  std::map<int, BreakParts> brk_;   // collider index -> its parts (handles as knockProp's)
  int64_t hideHandle(int64_t h, KnockedProp& out);
  struct Chunk {
    std::shared_ptr<Model> model;    // null while unloaded
    dvec3 origin; dvec3 bmin, bmax; bool shadow = true;
    std::vector<uint8_t> packed;     // zstd(vertices 28 B each + indices)
    size_t verts = 0, tris = 0, raw = 0; bool i16 = false; Material mat;
    std::string what;                // (sweepClearance) the pack and the material it came from
  };
  void streamChunks(const dvec3& cam, bool all);
  StreamStats stream_;
  std::vector<dvec3> lamps_;
  std::vector<glm::dmat4> cannons_;
  void rebuild(const dvec3& cam);
  void uploadCell(Cell& c);
  std::shared_ptr<Model> partsModel(const nlohmann::json& parts, const std::vector<uint8_t>& bin, const std::vector<Material>& mats);
  bool loadPack(platform::Platform& p, const AssetPaths& paths, const std::string& name, std::vector<Collider>& cols, size_t& nSurf);
  std::shared_ptr<nlohmann::json> tjson_;
  std::vector<uint8_t> tbin_;
  std::shared_ptr<nlohmann::json> pjson_;
  std::vector<uint8_t> pbin_;
  std::vector<Material> tmats_, pmats_;
  std::vector<std::pair<std::string, std::shared_ptr<Model>>> rooms_;

  gfx::Device& dev_;
  World& world_;
  AssetManager& assets_;
  FontSet fonts_;
  std::vector<PropSet> props_;
  // (a window's view: per prop set, its instances in view, the full model / the light copy; origin: the camera's metre)
  struct ViewProps { MatrixInstanceBatch lod[2]; uint32_t cap = 0; };
  std::vector<ViewProps> viewProps_;
  void submitPropsView(Renderer& r);
  std::vector<Chunk> chunks_;
  std::map<size_t, std::future<std::vector<uint8_t>>> unpacking_;   // (chunks being decompressed on a worker: streamChunks; after chunks_: gone first, the workers read their packed bytes)
  struct Placed { std::shared_ptr<Model> model; dvec3 pos; mat4 local; float radius; };
  std::vector<Placed> stations_;
  Lifts lifts_;
  dvec3 lastBuild_{1e18};
  size_t nProps_ = 0;
};

} // namespace sl
