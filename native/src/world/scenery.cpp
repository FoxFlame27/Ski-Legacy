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

// ---- the rocks (boulders.js ROCKS, vegetation.js rockSpot / placeRock)
// the models' proportions (unit width = the longest horizontal side, base at y = 0): h height / width, d depth / width,
// sy the placement's vertical scale
struct RockKind { const char* model; double h, d, sy; };
static const RockKind ROCKS[5] = {
  {"rocks/granite_boulder", 0.606, 0.962, 1}, {"rocks/limestone_block", 0.713, 0.984, 1}, {"rocks/gneiss_slab", 0.346, 0.316, 1},
  {"rocks/crag_spire", 1.466, 0.809, 1}, {"rocks/scree_pile", 0.53, 0.998, 0.6},
};
enum { R_GRANITE = 0, R_LIMESTONE, R_SLAB, R_CRAG, R_SCREE };
static const double VILLAGE_CLEAR = 160, BIG_ROCK = 2.6, LOW_ROCK = 0.55, BIG_FAR = 4;
static const double PI_D = 3.14159265358979323846;

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
    // vegetation.js pineMaterial: needle colour from the texture's luminance (NEEDLE_LUM), snow, sway, translucency
    for (Material& m : treeModel_[t]->materials) {
      m.shading = 1;
      m.lumNorm = 1.f / (t == 0 ? 0.077f : 0.23f);
      m.emissive = vec3(0); m.emissiveTex = {};
      m.metallic = 0;
    }
    for (int l = 0; l < 3; l++) batches_[t][l].init(dev_, *treeModel_[t], l == 2 ? 40000 : l == 1 ? 16000 : 4000);
  }
  if (vs_.impostorR > vs_.farR) impostors_.init(dev_, uint32_t(std::max(1000, vs_.maxImpostors)));
  // the rocks: the Meshy models with meshoptimizer LODs, snow-on-top rock shading (renderer: shading 4)
  ModelLoadOptions ro;
  ro.lodRatios = {0.25f, 0.08f};
  ro.maxTextureSize = 1024;
  for (int v = 0; v < ROCK_KINDS; v++) {
    rockModel_[v] = assets_.model(ROCKS[v].model, ro);
    if (!rockModel_[v]) continue;
    const Model& m = *rockModel_[v];
    vec3 dim = m.bmax - m.bmin;
    // boulders.js rockGeometry: unit width, centred, base at 0, the long side along x
    rockFit_[v] = (dim.z > dim.x ? glm::rotate(mat4(1), float(PI_D / 2), vec3(0, 1, 0)) : mat4(1)) * m.fitTransform(1.f, 3);
    for (Material& mt : rockModel_[v]->materials) {
      mt.shading = 4;
      mt.metallic = 0;
      mt.emissive = vec3(0); mt.emissiveTex = {};
    }
    for (int l = 0; l < 3; l++) rockBatch_[v][l].init(dev_, *rockModel_[v], l == 0 ? 300 : 1500);
  }
}

Scenery::~Scenery() {
  *alive_ = 0;
  while (jobs_.pending() > 0) std::this_thread::yield();
}

static void rockSpot(const World& world_, const Scenery::RailBedFn& railBed, int gx, int gz, double x, double z, double h,
                     double hx, double hz, double slope, double f, double rr, std::vector<Rock>& out);

// vegetation.js genCell (trees and rocks; `rocks` false: the trees only, for the far forest's impostors)
void Scenery::genCell(const World& wd, const RailBedFn& rb, int64_t cx, int64_t cz, Cell& out, bool rocks) {
  double x0 = double(cx) * CELL, z0 = double(cz) * CELL;
  int gx0 = int(std::floor(x0 / SPACING)), gx1 = int(std::floor((x0 + CELL) / SPACING));
  int gz0 = int(std::floor(z0 / SPACING)), gz1 = int(std::floor((z0 + CELL) / SPACING));
  for (int gz = gz0; gz < gz1; gz++)
    for (int gx = gx0; gx < gx1; gx++) {
      double r1 = hash2(gx, gz, 1), r2 = hash2(gx, gz, 2), r3 = hash2(gx, gz, 3);
      double x = (gx + r1) * SPACING, z = (gz + r2) * SPACING;
      double h = wd.height(x, z);
      double hx = wd.height(x + 1, z) - h, hz = wd.height(x, z + 1) - h;
      double slope = std::hypot(hx, hz);
      double f = wd.forest(x, z, h, slope);
      double rr = hash2(gx, gz, 5);
      if (r3 < f * 0.85) {
        CorridorHit c = wd.corridorAt(x, z);
        if (c.d < 3 + r1 * 4) continue;
        if (wd.nearPad(x, z)) continue;
        double s = 7 + r1 * 9 + f * 5;
        uint8_t type = rr < 0.6 ? 0 : 1;
        out.trees.push_back({float(x), float(h - 0.3), float(z), float(s), float(r2 * 6.283), float(0.15 + s * 0.012),
                             float(std::max(0.6, s * CROWN)), type});
      } else if (rr < 0.055 && rocks) {
        rockSpot(wd, rb, gx, gz, x, z, h, hx, hz, slope, f, rr, out.rocks);
      }
    }
}

// vegetation.js rockSpot's clear(): off the runs / lifts / roads (corridors), the pads, the village, the railways
static bool rockClearAt(const World& world_, const Scenery::RailBedFn& railBed, double x, double z, double size) {
  CorridorHit c = world_.corridorAt(x, z);
  return !(c.d < 3 + size * 0.6 || world_.nearPad(x, z) || x * x + z * z < VILLAGE_CLEAR * VILLAGE_CLEAR || (railBed && railBed(x, z, size)));
}

// vegetation.js rockSpot: the rocks at a grid point that holds no tree (crags, outcrops, boulders, scree)
static void placeRock(std::vector<Rock>& out, int v, double x, double z, double h, double hx, double hz, double s, double yaw,
                      double follow, double sink, int gx, int gz, int k0 = 10);

static void rockSpot(const World& world_, const Scenery::RailBedFn& railBed, int gx, int gz, double x, double z, double h,
                     double hx, double hz, double slope, double f, double rr, std::vector<Rock>& out) {
  auto rockClear = [&](double px, double pz, double size) { return rockClearAt(world_, railBed, px, pz, size); };
  auto H = [&](int k) { return hash2(gx, gz, k); };
  const double contour = std::atan2(-hx, -hz) + (H(9) - 0.5) * 0.6;
  if (slope > 0.9) {
    // the steep faces: a crag standing out of the rock, or a big slab of bedrock breaking out of it
    if (rr >= 0.012) return;
    bool crag = H(7) < 0.6;
    double s = crag ? 3 + H(8) * 2.5 : 5 + H(8) * 3;
    if (rockClear(x, z, s)) placeRock(out, crag ? R_CRAG : R_SLAB, x, z, h, hx, hz, s, crag ? H(9) * PI_D * 2 : contour, 0.3, crag ? 0.25 : 0.4, gx, gz);
    return;
  }
  if (rr < 0.02 && slope > 0.3) {
    // ridges and convex shoulders: a slab along the contour or the top of a big boulder
    const double k = 12;
    double curv = h - (world_.height(x + k, z) + world_.height(x - k, z) + world_.height(x, z + k) + world_.height(x, z - k)) / 4;
    if (curv > 1.5) {
      bool slab = H(7) < 0.6;
      double s = slab ? 5 + H(8) * 3 : 3.5 + H(8) * 2;
      if (rockClear(x, z, s)) placeRock(out, slab ? R_SLAB : R_GRANITE, x, z, h, hx, hz, s, slab ? contour : H(9) * PI_D * 2, 0.6, slab ? 0.35 : 0.4, gx, gz);
      return;
    }
  }
  if (rr < (f > 0.04 ? 0.01 : slope > 0.45 ? 0.006 : 0.002)) {
    bool slab = slope < 0.35 && H(7) < 0.35;
    int v = slab ? R_SLAB : H(7) < 0.68 ? R_GRANITE : R_LIMESTONE;
    double s = slab ? 2.5 + H(8) * 2.5 : 1 + H(8) * H(8) * 2.6;
    if (rockClear(x, z, s)) placeRock(out, v, x, z, h, hx, hz, s, slab ? contour : H(9) * PI_D * 2, 0.65, 0.2 + H(12) * 0.15, gx, gz);
    return;
  }
  if (rr >= 0.04 && slope > 0.12 && slope < 0.8) {
    double ux = hx / slope, uz = hz / slope, ax = x + ux * 15, az = z + uz * 15;
    double cliff = std::hypot(world_.height(ax + 2, az) - world_.height(ax - 2, az), world_.height(ax, az + 2) - world_.height(ax, az - 2)) / 4;
    if (cliff < 1.0) return;
    double s = 3 + H(8) * 2;
    if (!rockClear(x, z, s + 3)) return;
    placeRock(out, R_SCREE, x, z, h, hx, hz, s, H(9) * PI_D * 2, 0.85, 0.15, gx, gz);
    int n = 1 + int(std::floor(H(13) * 2));
    for (int i = 0; i < n; i++) {
      double ox = x + (H(20 + i) - 0.5) * 9, oz = z + (H(30 + i) - 0.5) * 9;
      double oh = world_.height(ox, oz), ohx = world_.height(ox + 1, oz) - oh, ohz = world_.height(ox, oz + 1) - oh;
      double os = 0.8 + H(40 + i) * 1.2;
      if (rockClear(ox, oz, os)) placeRock(out, H(50 + i) < 0.6 ? R_GRANITE : R_LIMESTONE, ox, oz, oh, ohx, ohz, os, H(60 + i) * PI_D * 2, 0.65, 0.25, gx, gz, 70 + i * 4);
    }
  }
}

// vegetation.js placeRock (three.js's Quaternion setFromUnitVectors / slerp / multiply and Matrix4.compose, in double)
static void placeRock(std::vector<Rock>& out, int v, double x, double z, double h, double hx, double hz, double s, double yaw,
                      double follow, double sink, int gx, int gz, int k0) {
  const RockKind& R = ROCKS[v];
  double nl = std::sqrt(hx * hx + 1 + hz * hz), nx = -hx / nl, ny = 1 / nl, nz = -hz / nl;
  // setFromUnitVectors((0, 1, 0), n): (cross, dot + 1), normalised
  double qx = nz, qy = 0, qz = -nx, qw = ny + 1;
  { double l = std::sqrt(qx * qx + qy * qy + qz * qz + qw * qw); qx /= l; qy /= l; qz /= l; qw /= l; }
  // slerp toward the identity by t = 1 - follow
  double t = 1 - follow;
  if (t == 1) { qx = qy = qz = 0; qw = 1; }
  else if (t != 0) {
    double cosHalf = qw;
    if (cosHalf < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; cosHalf = -cosHalf; }
    if (cosHalf < 1) {
      double sqrSin = 1 - cosHalf * cosHalf;
      if (sqrSin <= 2.220446049250313e-16) {
        double k = 1 - t;
        qw = k * qw + t; qx *= k; qy *= k; qz *= k;
        double l = std::sqrt(qx * qx + qy * qy + qz * qz + qw * qw); qx /= l; qy /= l; qz /= l; qw /= l;
      } else {
        double sinHalf = std::sqrt(sqrSin), half = std::atan2(sinHalf, cosHalf);
        double ra = std::sin((1 - t) * half) / sinHalf, rb = std::sin(t * half) / sinHalf;
        qw = qw * ra + rb; qx *= ra; qy *= ra; qz *= ra;
      }
    }
  }
  // multiply by the yaw about y: q * (0, sin(yaw / 2), 0, cos(yaw / 2))
  {
    double by = std::sin(yaw / 2), bw = std::cos(yaw / 2);
    double ax = qx, ay = qy, az = qz, aw = qw;
    qx = ax * bw - az * by;
    qy = ay * bw + aw * by;
    qz = az * bw + ax * by;
    qw = aw * bw - ay * by;
  }
  double sx = s, sy = s * (0.85 + hash2(gx, gz, k0) * 0.3) * R.sy, sz = s * (0.9 + hash2(gx, gz, k0 + 1) * 0.2);
  double Hh = R.h * sy, slope = std::hypot(hx, hz);
  double base = h - sink * Hh - slope * s * 0.45 * (1 - follow);
  // Matrix4.compose: the rotation's columns times the scale
  double x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  double xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  Rock r{};
  r.m[0] = float((1 - (yy + zz)) * sx); r.m[1] = float((xy + wz) * sx); r.m[2] = float((xz - wy) * sx);
  r.m[3] = float((xy - wz) * sy); r.m[4] = float((1 - (xx + zz)) * sy); r.m[5] = float((yz + wx) * sy);
  r.m[6] = float((xz + wy) * sz); r.m[7] = float((yz - wx) * sz); r.m[8] = float((1 - (xx + yy)) * sz);
  double top = base + Hh, above = top - h;
  double S = above < LOW_ROCK ? std::min(s, 2.0) : std::max(s, BIG_ROCK);
  double d = R.d * (sz / s), y = top - 0.75 * S;
  bool elongated = d < 0.6;
  r.x = x; r.z = z; r.y = float(y); r.s = float(S); r.v = int8_t(v); r.base = float(base); r.w = float(s);
  r.r = float(elongated ? 0.5 * s * d * 0.95 : 0.5 * s * std::sqrt(d) * 0.9);
  r.gx = float(hx); r.gz = float(hz); r.gh = float(h);
  out.push_back(r);
  if (elongated) {
    double e0 = (1 - (yy + zz)) * sx, e2 = (xz - wy) * sx, l = std::hypot(e0, e2);
    if (l == 0) l = 1;
    double ax = e0 / l, az = e2 / l, o = (0.5 - 0.5 * d) * s * 0.8;
    for (int k = -1; k <= 1; k += 2) {
      Rock c = r;
      c.x = x + ax * o * k; c.z = z + az * o * k; c.v = -1; c.r = float(0.5 * s * d * 0.9);
      out.push_back(c);
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
      genCell(world_, railBed, kx, kz, *c, true);
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
  if (vs_.impostorR > vs_.farR) updateFar(cam);
}

// the far forest: the same placement (genCell) out to impostorR, kept as positions only, drawn as impostors
void Scenery::updateFar(const dvec3& cam) {
  const double R = vs_.impostorR, R0 = std::max(0.0, double(vs_.farR) - 2 * CELL);
  int n = int(std::ceil(R / CELL));
  int64_t pcx = int64_t(std::floor(cam.x / CELL)), pcz = int64_t(std::floor(cam.z / CELL));
  std::vector<std::pair<int, int64_t>> want;
  for (int i = -n; i <= n; i++)
    for (int j = -n; j <= n; j++) {
      double d2 = double(i * i + j * j) * CELL * CELL;
      if (d2 > (R + CELL) * (R + CELL) || d2 < R0 * R0) continue;
      int64_t k = key(pcx + i, pcz + j);
      if (far_.count(k) || farQueued_.count(k)) continue;
      want.push_back({i * i + j * j, k});
    }
  std::sort(want.begin(), want.end());
  for (auto& [d, k] : want) {
    if (int(farQueued_.size()) >= jobs_.threads() * 16) break;
    farQueued_.insert(k);
    int64_t kx = k >> 32, kz = int64_t(int32_t(k & 0xffffffff));
    std::weak_ptr<int> alive = alive_;
    jobs_.push([this, k, kx, kz, alive] {
      if (alive.expired()) return;
      Cell c;
      genCell(world_, railBed, kx, kz, c, false);
      auto f = std::make_unique<FarCell>();
      f->trees.reserve(c.trees.size());
      for (const Tree& t : c.trees) f->trees.push_back({t.x, t.y, t.z, t.s, t.type, float(hash2(int(t.x * 3), int(t.z * 3), 9))});
      std::lock_guard<std::mutex> l(m_);
      farDone_.push_back({k, std::move(f)});
    });
  }
  {
    std::lock_guard<std::mutex> l(m_);
    for (auto& [k, c] : farDone_) { far_[k] = std::move(*c); farQueued_.erase(k); farDirty_ = true; }
    farDone_.clear();
  }
  for (auto it = far_.begin(); it != far_.end();) {
    int64_t kx = it->first >> 32, kz = int64_t(int32_t(it->first & 0xffffffff));
    double dx = (kx + 0.5) * CELL - cam.x, dz = (kz + 0.5) * CELL - cam.z;
    if (dx * dx + dz * dz > (R + 3 * CELL) * (R + 3 * CELL)) it = far_.erase(it);
    else ++it;
  }
  if (farDirty_ || std::hypot(cam.x - lastImp_.x, cam.z - lastImp_.z) > 24) rebuildImpostors(cam);
}

void Scenery::rebuildImpostors(const dvec3& cam) {
  lastImp_ = cam;
  farDirty_ = false;
  const float f0 = vs_.farR * 0.86f, fl = vs_.farR * 0.14f;
  const double r0 = double(f0) * f0, R2 = double(vs_.impostorR) * vs_.impostorR;
  struct C { float d2; ImpostorBatch::Inst i; };
  std::vector<C> list;
  list.reserve(size_t(vs_.maxImpostors) + 1024);
  for (auto& [k, c] : far_)
    for (const FarTree& t : c.trees) {
      double dx = t.x - cam.x, dz = t.z - cam.z, d2 = dx * dx + dz * dz;
      if (d2 < r0 || d2 > R2) continue;
      list.push_back({float(d2), {vec4(t.x, t.y, t.z, t.s), vec4(t.seed, float(t.type), f0, fl)}});
    }
  if (list.size() > size_t(vs_.maxImpostors)) {
    std::nth_element(list.begin(), list.begin() + vs_.maxImpostors, list.end(), [](const C& a, const C& b) { return a.d2 < b.d2; });
    list.resize(size_t(vs_.maxImpostors));
  }
  std::vector<ImpostorBatch::Inst> inst;
  inst.reserve(list.size());
  for (auto& c : list) inst.push_back(c.i);
  impostors_.upload(dev_, inst);
}

void Scenery::finish(const dvec3& cam) {
  // (the far forest too, for at most a few seconds: the loading screen shows complete slopes)
  auto t0 = std::chrono::steady_clock::now();
  for (;;) {
    update(cam);
    bool busy, farBusy;
    { std::lock_guard<std::mutex> l(m_); busy = !queued_.empty() || !done_.empty(); farBusy = !farQueued_.empty() || !farDone_.empty(); }
    double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    if (!busy && (!farBusy || el > 6)) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  update(cam, true);
  SL_INFO("scenery: %zu far forest cells, %u impostors", far_.size(), impostors_.count());
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
  rebuildRocks(cam);
}

// vegetation.js rebuildRocks: the rocks within the preset's reach (crags and outcrops BIG_FAR wide and up to twice it),
// the full mesh close by, meshoptimizer's 25 % to the reach, 8 % beyond. Instance tint = the terrain plane under the
// rock (gradient x, z; its height over the model's base) for the snow banked at its foot (shaders: kind 4).
void Scenery::rebuildRocks(const dvec3& cam) {
  lastRocks_ = cam;
  rockOrigin_ = dvec3(std::floor(cam.x), std::floor(cam.y), std::floor(cam.z));
  const double rockR = vs_.rockR, bigR = std::min(rockR * 2, double(vs_.farR)), closeR = std::max(45.0, double(vs_.nearR) * 0.6);
  const double rR2 = rockR * rockR, bR2 = bigR * bigR, cR2 = closeR * closeR;
  static thread_local std::vector<MatrixInstanceBatch::Inst> lists[ROCK_KINDS][3];
  for (auto& lv : lists) for (auto& l : lv) l.clear();
  rocksDrawn_ = 0;
  for (auto& [k, c] : cells_)
    for (const Rock& r : c.rocks) {
      if (r.v < 0 || !rockModel_[size_t(r.v)]) continue;
      double dx = r.x - cam.x, dz = r.z - cam.z, d2 = dx * dx + dz * dz;
      bool big = r.w >= BIG_FAR;
      if (d2 > (big ? bR2 : rR2)) continue;
      int lod = d2 < cR2 ? 0 : d2 < rR2 ? 1 : 2;
      glm::dmat4 M(1);
      for (int col = 0; col < 3; col++)
        for (int row = 0; row < 3; row++) M[col][row] = r.m[col * 3 + row];
      M[3] = glm::dvec4(r.x, r.base, r.z, 1);
      M = M * glm::dmat4(rockFit_[size_t(r.v)]);
      lists[size_t(r.v)][lod].push_back(MatrixInstanceBatch::pack(M, rockOrigin_, vec4(r.gx, r.gz, r.gh - r.base, 0)));
      rocksDrawn_++;
    }
  for (int v = 0; v < ROCK_KINDS; v++)
    if (rockModel_[v]) for (int l = 0; l < 3; l++) rockBatch_[v][l].upload(dev_, lists[v][l]);
}

void Scenery::submit(Renderer& r, bool trees, bool buildings) {
  for (int t = 0; t < 2; t++) {
    if (!treeModel_[t] || !trees) continue;
    for (int l = 0; l < 3; l++) r.submitInstances(batches_[t][l], treeFit_[t], l, l < vs_.shadowLods);
  }
  if (trees) r.submitImpostors(impostors_, false);
  if (trees)
    for (int v = 0; v < ROCK_KINDS; v++)
      if (rockModel_[v]) for (int l = 0; l < 3; l++) r.submitInstances(rockBatch_[v][l], rockOrigin_, l, l < 2 || vs_.shadowLods >= 2);
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
  if (noTrees) return nullptr;
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

void Scenery::cellRocks(const World& wd, const RailBedFn& rb, int64_t cx, int64_t cz, std::vector<Rock>& out) {
  Cell c;
  genCell(wd, rb, cx, cz, c, true);
  out = std::move(c.rocks);
}

const Rock* Scenery::rockAt(double x, double z, double r, double minSize) const {
  if (noTrees) return nullptr;
  const double REACH = 6;   // (a rock's collider reaches at most ~5 m from its grid point's cell)
  int64_t cx0 = int64_t(std::floor((x - r - REACH) / CELL)), cx1 = int64_t(std::floor((x + r + REACH + SPACING) / CELL));
  int64_t cz0 = int64_t(std::floor((z - r - REACH) / CELL)), cz1 = int64_t(std::floor((z + r + REACH + SPACING) / CELL));
  for (int64_t cx = cx0; cx <= cx1; cx++)
    for (int64_t cz = cz0; cz <= cz1; cz++) {
      auto it = cells_.find(key(cx, cz));
      if (it == cells_.end()) continue;
      for (const Rock& k : it->second.rocks) {
        if (k.s < minSize) continue;
        double dx = x - k.x, dz = z - k.z;
        if (dx * dx + dz * dz < (r + k.r) * (r + k.r)) return &k;
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
  if (!paths.readData(p, "world.json", bytes)) return false;
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
