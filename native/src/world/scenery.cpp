#include "world/scenery.h"
#include "core/assets_path.h"
#include "core/jobs.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "platform/platform.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <thread>
#include <chrono>
#include <algorithm>

namespace sl {

static const double CROWN = 0.16;   // branch spread low on the tree / height (vegetation.js measures it per model)

Scenery::Scenery(gfx::Device& dev, World& world, JobSystem& jobs, AssetManager& assets, const VegetationSettings& vs)
  : dev_(dev), world_(world), jobs_(jobs), assets_(assets), vs_(vs), alive_(std::make_shared<int>(1)) {
  ModelLoadOptions o;
  o.lodRatios = {0.2f, 0.02f};
  o.maxTextureSize = 1024;
  const char* names[2] = {"pine_tree", "pine_tree2"};
  for (int t = 0; t < 2; t++) {
    treeModel_[t] = assets_.model(names[t], o);
    if (!treeModel_[t]) continue;
    treeFit_[t] = treeModel_[t]->fitTransform(1.f, 1);   // unit height, base at 0 (bakeGeometry size 1, axis y)
    for (int l = 0; l < 3; l++) batches_[t][l].init(dev_, *treeModel_[t], l == 2 ? 40000 : l == 1 ? 16000 : 4000);
  }
}

Scenery::~Scenery() {
  *alive_ = 0;
  while (jobs_.pending() > 0) std::this_thread::yield();
}

// vegetation.js genCell (trees; boulders and scree are a later phase)
void Scenery::genCell(int64_t cx, int64_t cz, Cell& out) const {
  double x0 = double(cx) * CELL, z0 = double(cz) * CELL;
  int gx0 = int(std::floor(x0 / SPACING)), gx1 = int(std::floor((x0 + CELL) / SPACING));
  int gz0 = int(std::floor(z0 / SPACING)), gz1 = int(std::floor((z0 + CELL) / SPACING));
  for (int gz = gz0; gz < gz1; gz++)
    for (int gx = gx0; gx < gx1; gx++) {
      double r1 = hash2(gx, gz, 1), r2 = hash2(gx, gz, 2), r3 = hash2(gx, gz, 3);
      double x = (gx + r1) * SPACING, z = (gz + r2) * SPACING;
      double h = world_.height(x, z);
      double hx = world_.height(x + 1, z) - h, hz = world_.height(x, z + 1) - h;
      double slope = std::hypot(hx, hz);
      double f = world_.forest(x, z, h, slope);
      double rr = hash2(gx, gz, 5);
      if (r3 < f * 0.85) {
        CorridorHit c = world_.corridorAt(x, z);
        if (c.d < 3 + r1 * 4) continue;
        if (world_.nearPad(x, z)) continue;
        double s = 7 + r1 * 9 + f * 5;
        uint8_t type = rr < 0.6 ? 0 : 1;
        out.trees.push_back({float(x), float(h - 0.3), float(z), float(s), float(r2 * 6.283), float(0.15 + s * 0.012),
                             float(std::max(0.6, s * CROWN)), type});
      }
    }
}

void Scenery::update(const dvec3& cam, bool force) {
  // queue the missing cells in range, nearest first
  int R = int(std::ceil(vs_.farR / CELL));
  int64_t pcx = int64_t(std::floor(cam.x / CELL)), pcz = int64_t(std::floor(cam.z / CELL));
  std::vector<std::pair<int, int64_t>> want;
  for (int i = -R; i <= R; i++)
    for (int j = -R; j <= R; j++) {
      if ((i * i + j * j) * CELL * CELL > (vs_.farR + CELL) * (vs_.farR + CELL)) continue;
      int64_t k = key(pcx + i, pcz + j);
      if (cells_.count(k) || queued_.count(k)) continue;
      want.push_back({i * i + j * j, k});
    }
  std::sort(want.begin(), want.end());
  for (auto& [d, k] : want) {
    if (int(queued_.size()) >= jobs_.threads() * 8) break;
    queued_.insert(k);
    int64_t kx = k >> 32, kz = int64_t(int32_t(k & 0xffffffff));
    std::weak_ptr<int> alive = alive_;
    jobs_.push([this, k, kx, kz, alive] {
      if (alive.expired()) return;
      auto c = std::make_unique<Cell>();
      genCell(kx, kz, *c);
      std::lock_guard<std::mutex> l(m_);
      done_.push_back({k, std::move(c)});
    });
  }
  {
    std::lock_guard<std::mutex> l(m_);
    for (auto& [k, c] : done_) { cells_[k] = std::move(*c); queued_.erase(k); dirty_ = true; }
    done_.clear();
  }
  // drop far cells
  for (auto it = cells_.begin(); it != cells_.end();) {
    int64_t kx = it->first >> 32, kz = int64_t(int32_t(it->first & 0xffffffff));
    double dx = (kx + 0.5) * CELL - cam.x, dz = (kz + 0.5) * CELL - cam.z;
    if (dx * dx + dz * dz > (vs_.farR + 3 * CELL) * (vs_.farR + 3 * CELL)) it = cells_.erase(it);
    else ++it;
  }
  if (force || dirty_ || std::hypot(cam.x - lastBuild_.x, cam.z - lastBuild_.z) > 8) rebuildInstances(cam);
}

void Scenery::finish(const dvec3& cam) {
  for (;;) {
    update(cam);
    bool busy;
    { std::lock_guard<std::mutex> l(m_); busy = !queued_.empty() || !done_.empty(); }
    if (!busy) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  update(cam, true);
}

void Scenery::rebuildInstances(const dvec3& cam) {
  lastBuild_ = cam;
  dirty_ = false;
  std::vector<InstanceBatch::Inst> lists[2][3];
  const double r0 = vs_.nearR * vs_.nearR, r1 = vs_.midR * vs_.midR, r2 = vs_.farR * vs_.farR;
  drawn_ = 0;
  for (auto& [k, c] : cells_)
    for (const Tree& t : c.trees) {
      double dx = t.x - cam.x, dz = t.z - cam.z, d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      int lod = d2 < r0 ? 0 : d2 < r1 ? 1 : 2;
      lists[t.type][lod].push_back({vec4(t.x, t.y, t.z, t.s), vec4(t.rot, 0, 0, 0)});
      drawn_++;
    }
  for (int t = 0; t < 2; t++)
    if (treeModel_[t]) for (int l = 0; l < 3; l++) batches_[t][l].upload(dev_, lists[t][l]);
}

void Scenery::submit(Renderer& r, bool trees, bool buildings) {
  for (int t = 0; t < 2; t++) {
    if (!treeModel_[t] || !trees) continue;
    for (int l = 0; l < 3; l++) r.submitInstances(batches_[t][l], treeFit_[t], l, l == 0);
  }
  const dvec3 cam = r.camera().pos;
  if (buildings) for (const Placed& p : placed_) {
    double d = glm::length(p.pos - cam);
    if (d > 2500) continue;
    dvec3 ext(p.radius);
    bool vis = r.visible(p.pos - ext, p.pos + ext), cast = r.castsShadow(p.pos - ext, p.pos + ext);
    if (!vis && !cast) continue;
    r.submitModel(*p.model, p.pos, p.local, nullptr, cast, d > 400 ? 1 : 0, vis);
  }
}

const Tree* Scenery::treeAt(double x, double z, double r, bool crown) const {
  const double REACH = 6;
  int64_t cx0 = int64_t(std::floor((x - r - REACH) / CELL)), cx1 = int64_t(std::floor((x + r + REACH + SPACING) / CELL));
  int64_t cz0 = int64_t(std::floor((z - r - REACH) / CELL)), cz1 = int64_t(std::floor((z + r + REACH + SPACING) / CELL));
  for (int64_t cx = cx0; cx <= cx1; cx++)
    for (int64_t cz = cz0; cz <= cz1; cz++) {
      auto it = cells_.find(key(cx, cz));
      if (it == cells_.end()) continue;
      for (const Tree& t : it->second.trees) {
        double dx = x - t.x, dz = z - t.z, tr = crown ? t.crown : t.trunk;
        if (dx * dx + dz * dz < (r + tr) * (r + tr)) return &t;
      }
    }
  return nullptr;
}

void Scenery::setColliders(std::vector<Collider> c) {
  colliders_ = std::move(c);
  colliderGrid_.clear();
  const double G = 32;
  for (size_t i = 0; i < colliders_.size(); i++) {
    const Collider& k = colliders_[i];
    double reach = (k.r >= 0 ? k.r : std::hypot(k.hw, k.hd)) + 1.0;
    for (int64_t cx = int64_t(std::floor((k.x - reach) / G)); cx <= int64_t(std::floor((k.x + reach) / G)); cx++)
      for (int64_t cz = int64_t(std::floor((k.z - reach) / G)); cz <= int64_t(std::floor((k.z + reach) / G)); cz++)
        colliderGrid_[key(cx, cz)].push_back(int(i));
  }
}

const std::vector<int>* Scenery::collidersNear(double x, double z) const {
  auto it = colliderGrid_.find(key(int64_t(std::floor(x / 32)), int64_t(std::floor(z / 32))));
  return it == colliderGrid_.end() ? nullptr : &it->second;
}

bool Scenery::loadVillage(platform::Platform& p, const AssetPaths& paths) {
  std::vector<uint8_t> bytes;
  if (!p.readFile(paths.data("world.json"), bytes)) return false;
  nlohmann::json j = nlohmann::json::parse(bytes.begin(), bytes.end(), nullptr, false);
  if (j.is_discarded()) return false;
  ModelLoadOptions o;
  o.maxTextureSize = 1024;
  o.lodRatios = {0.08f};   // a light copy for buildings seen from the slopes
  for (auto& pl : j["placements"]) {
    std::string name = pl["model"];
    auto m = assets_.model(name, o);
    if (!m) continue;
    int axis = pl["axis"] == "y" ? 1 : pl["axis"] == "z" ? 2 : 0;
    float size = pl["size"];
    double x = pl["x"], z = pl["z"], yaw = pl["yaw"], sink = pl["sink"];
    mat4 fit = m->fitTransform(size, axis);
    vec3 dim = m->bmax - m->bmin;
    float s = size / std::max(1e-6f, axis == 1 ? dim.y : axis == 2 ? dim.z : dim.x);
    vec3 fitted = dim * s;
    Placed pc;
    pc.model = m;
    pc.pos = dvec3(x, world_.height(x, z) - sink, z);
    pc.local = glm::rotate(mat4(1), float(yaw), vec3(0, 1, 0)) * fit;
    pc.radius = glm::length(fitted) * 0.5f + 1;
    placed_.push_back(pc);
    Collider c;
    c.x = x; c.z = z;
    if (pl.contains("radius")) c.r = pl["radius"];
    else { double k = pl.value("box", 0.42); c.hw = fitted.x * k; c.hd = fitted.z * k; c.rot = -yaw; }
    colliders_.push_back(c);
  }
  SL_INFO("village: %zu buildings / props placed", placed_.size());
  return true;
}

} // namespace sl
