#include "world/terrain.h"
#include "core/jobs.h"
#include "engine/renderer.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>
#include <thread>
#include <chrono>
#include <functional>

namespace sl {

static constexpr int V = Terrain::SEG + 1;
static constexpr int FLOATS = 11; // pos3 normal3 data4 macro1

Terrain::Terrain(gfx::Device& dev, World& world, JobSystem& jobs, float lodK)
  : dev_(dev), world_(world), jobs_(jobs), lodK_(lodK), alive_(std::make_shared<int>(1)) {
  // boundary ring (counter-clockwise), for the skirts
  for (int i = 0; i < V; i++) ring_.push_back(i);                       // j = 0
  for (int j = 1; j < V; j++) ring_.push_back(j * V + V - 1);           // i = V-1
  for (int i = V - 2; i >= 0; i--) ring_.push_back((V - 1) * V + i);    // j = V-1
  for (int j = V - 2; j >= 1; j--) ring_.push_back(j * V);              // i = 0
  std::vector<uint32_t> idx;
  // the same triangulation as world.meshHeight: the diagonal runs from (i+1, j) to (i, j+1); up-facing winding
  for (int j = 0; j < Terrain::SEG; j++)
    for (int i = 0; i < Terrain::SEG; i++) {
      uint32_t a = uint32_t(j * V + i), b = a + 1, c = a + V, d = c + 1;
      idx.insert(idx.end(), {a, c, b, b, c, d});
    }
  uint32_t base = uint32_t(V * V), R = uint32_t(ring_.size());
  for (uint32_t k = 0; k < R; k++) {
    uint32_t t0 = uint32_t(ring_[k]), t1 = uint32_t(ring_[(k + 1) % R]), s0 = base + k, s1 = base + (k + 1) % R;
    idx.insert(idx.end(), {t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0}); // both sides
  }
  indexCount_ = uint32_t(idx.size());
  ibo_ = dev_.createBuffer(gfx::BufferUsage::Index, idx.data(), idx.size() * 4);
}

Terrain::~Terrain() {
  *alive_ = 0;
  while (jobs_.pending() > 0) std::this_thread::yield();
  for (auto& [k, n] : active_) { dev_.destroy(n.vi); dev_.destroy(n.vbo); }
  dev_.destroy(ibo_);
}

void Terrain::computeDesired(const dvec3& cam) {
  desired_.clear();
  desiredSet_.clear();
  double px = cam.x, pz = cam.z;
  int64_t rx = int64_t(std::floor(px / ROOT_SIZE)), rz = int64_t(std::floor(pz / ROOT_SIZE));
  struct Item { Key k; double d; };
  std::vector<Item> out;
  std::function<void(int64_t, int64_t, int64_t)> visit = [&](int64_t x, int64_t z, int64_t size) {
    double cx = x + size / 2.0, cz = z + size / 2.0;
    double dx = std::max(std::fabs(px - cx) - size / 2.0, 0.0), dz = std::max(std::fabs(pz - cz) - size / 2.0, 0.0);
    double d = std::hypot(dx, dz);
    if (size > MIN_SIZE && d < size * lodK_) {
      int64_t h = size / 2;
      visit(x, z, h); visit(x + h, z, h); visit(x, z + h, h); visit(x + h, z + h, h);
    } else out.push_back({{x, z, size}, d});
  };
  for (int i = -1; i <= 1; i++)
    for (int j = -1; j <= 1; j++) visit((rx + i) * int64_t(ROOT_SIZE), (rz + j) * int64_t(ROOT_SIZE), int64_t(ROOT_SIZE));
  std::sort(out.begin(), out.end(), [](const Item& a, const Item& b) { return a.d < b.d; });
  for (auto& it : out) { desired_.push_back(it.k); desiredSet_.insert(it.k); }
}

void Terrain::build(const Key& k, CpuNode& out) const {
  const double x0 = double(k.x), z0 = double(k.z), size = double(k.size), st = size / SEG;
  const int W = V + 2;
  std::vector<double> H(size_t(W) * W);
  const double spacing = st > 3 ? st : 0;
  for (int j = -1; j <= V; j++)
    for (int i = -1; i <= V; i++) H[size_t(j + 1) * W + (i + 1)] = world_.height(x0 + i * st, z0 + j * st, spacing);
  // (terrain.js marks the groomed runs on the 128-512 m nodes only; here also on the coarser ones out to 2 km nodes,
  // so the pistes read as smooth bright bands down the far slopes)
  const bool near = size <= 2048;
  // terrain.js macro slope: the slope without the crags' cliff bands and small bumps (heights band-limited to
  // 40 m on a coarse grid every MS vertices); the shader tells cliff zones from open slopes by it
  const int MS = 4, MV = SEG / MS + 1, mw = MV + 2;
  const double mst = st * MS;
  std::vector<double> M(size_t(mw) * mw), macro(size_t(MV) * MV);
  for (int j = -1; j <= MV; j++)
    for (int i = -1; i <= MV; i++) M[size_t(j + 1) * mw + (i + 1)] = world_.height(x0 + i * mst, z0 + j * mst, std::max(40.0, mst));
  for (int j = 0; j < MV; j++)
    for (int i = 0; i < MV; i++) {
      double mx = M[size_t(j + 1) * mw + i] - M[size_t(j + 1) * mw + i + 2], mz = M[size_t(j) * mw + i + 1] - M[size_t(j + 2) * mw + i + 1];
      macro[size_t(j) * MV + i] = 1 - (2 * mst) / std::sqrt(mx * mx + 4 * mst * mst + mz * mz);
    }
  const size_t count = size_t(V) * V + ring_.size();
  out.verts.assign(count * FLOATS, 0.f);
  out.minY = 1e30f; out.maxY = -1e30f;
  for (int j = 0; j < V; j++)
    for (int i = 0; i < V; i++) {
      float* o = &out.verts[(size_t(j) * V + i) * FLOATS];
      double h = H[size_t(j + 1) * W + (i + 1)];
      double hl = H[size_t(j + 1) * W + i], hr = H[size_t(j + 1) * W + i + 2];
      double hd = H[size_t(j) * W + i + 1], hu = H[size_t(j + 2) * W + i + 1];
      double nx = hl - hr, ny = 2 * st, nz = hd - hu, nl = std::sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nl; ny /= nl; nz /= nl;
      o[0] = float(i * st); o[1] = float(h); o[2] = float(j * st);
      o[3] = float(nx); o[4] = float(ny); o[5] = float(nz);
      double wx = x0 + i * st, wz = z0 + j * st;
      double forest = world_.forest(wx, wz, h, std::sqrt(std::max(0.0, 1 - ny * ny)) / std::max(ny, 0.05));
      double g = 0, dx = 0, dz = 0;
      if (near) {
        CorridorHit c = world_.corridorAt(wx, wz);
        if (c.any && c.groomed) {
          g = 1 - std::min(1.0, std::max(0.0, (c.d + 3) / 6));
          forest *= 1 - g;
          double m = 4 + std::max(-100.0, std::min(100.0, c.lat)) / 50;
          dx = c.dx * m; dz = c.dz * m;
        } else if (c.any && c.d < 4) forest = 0;
        double pad = world_.padInfluence(wx, wz);
        if (pad > 0.02 && pad > g) { g = std::min(1.0, pad * 1.5); forest = 0; if (dx == 0 && dz == 0) dx = 1; }
      }
      o[6] = float(forest); o[7] = float(g); o[8] = float(dx); o[9] = float(dz);
      {
        double fi = double(i) / MS, fj = double(j) / MS;
        int i0 = std::min(MV - 2, int(std::floor(fi))), j0 = std::min(MV - 2, int(std::floor(fj)));
        double ti = fi - i0, tj = fj - j0;
        double a = macro[size_t(j0) * MV + i0], b = macro[size_t(j0) * MV + i0 + 1], cc = macro[size_t(j0 + 1) * MV + i0], dd = macro[size_t(j0 + 1) * MV + i0 + 1];
        o[10] = float((a + (b - a) * ti) * (1 - tj) + (cc + (dd - cc) * ti) * tj);
      }
      out.minY = std::min(out.minY, o[1]); out.maxY = std::max(out.maxY, o[1]);
    }
  const float skirt = float(std::max(2.0, size * 0.02));
  for (size_t r = 0; r < ring_.size(); r++) {
    const float* s = &out.verts[size_t(ring_[r]) * FLOATS];
    float* d = &out.verts[(size_t(V) * V + r) * FLOATS];
    std::copy(s, s + FLOATS, d);
    d[1] -= skirt;
  }
  out.minY -= skirt;
}

void Terrain::upload(CpuNode& n) {
  GpuNode g;
  g.vbo = dev_.createBuffer(gfx::BufferUsage::Vertex, n.verts.data(), n.verts.size() * sizeof(float));
  const uint32_t st = FLOATS * 4;
  g.vi = dev_.createVertexInput({{0, 0, 3, gfx::AttribType::Float, false, 0, st}, {1, 0, 3, gfx::AttribType::Float, false, 12, st},
                                 {2, 0, 4, gfx::AttribType::Float, false, 24, st}, {3, 0, 1, gfx::AttribType::Float, false, 40, st}}, {g.vbo}, ibo_);
  g.minY = n.minY; g.maxY = n.maxY;
  active_[n.key] = g;
}

void Terrain::prune() {
  for (auto it = active_.begin(); it != active_.end();) {
    if (!desiredSet_.count(it->first)) { dev_.destroy(it->second.vi); dev_.destroy(it->second.vbo); it = active_.erase(it); }
    else ++it;
  }
}

void Terrain::update(const dvec3& cam, int maxUploads) {
  if (std::hypot(cam.x - lastCenter_.x, cam.z - lastCenter_.z) > 24) {
    lastCenter_ = cam;
    computeDesired(cam);
  }
  // queue builds, nearest first, a few ahead of the workers
  int inFlight = int(queued_.size());
  for (const Key& k : desired_) {
    if (inFlight >= jobs_.threads() * 3) break;
    if (active_.count(k) || queued_.count(k)) continue;
    queued_.insert(k);
    inFlight++;
    std::weak_ptr<int> alive = alive_;
    jobs_.push([this, k, alive] {
      if (alive.expired()) return;
      auto n = std::make_unique<CpuNode>();
      n->key = k;
      build(k, *n);
      std::lock_guard<std::mutex> l(doneM_);
      done_.push_back(std::move(n));
    });
  }
  std::vector<std::unique_ptr<CpuNode>> ready;
  {
    std::lock_guard<std::mutex> l(doneM_);
    int n = std::min<int>(maxUploads, int(done_.size()));
    for (int i = 0; i < n; i++) ready.push_back(std::move(done_[size_t(i)]));
    done_.erase(done_.begin(), done_.begin() + n);
  }
  for (auto& n : ready) {
    queued_.erase(n->key);
    if (desiredSet_.count(n->key)) upload(*n);
  }
  if (queued_.empty()) prune();
}

void Terrain::finish(const dvec3& cam) {
  update(cam, 1000);
  while (true) {
    bool all = true;
    for (const Key& k : desired_) if (!active_.count(k)) { all = false; break; }
    if (all) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    update(cam, 1000);
  }
  prune();
}

int Terrain::pending() const {
  int n = 0;
  for (const Key& k : desired_) if (!active_.count(k)) n++;
  return n;
}

void Terrain::submit(Renderer& r, double shadowMax) {
  auto overlaps = [](const Key& a, const Key& b) {
    return a.x < b.x + b.size && b.x < a.x + a.size && a.z < b.z + b.size && b.z < a.z + a.size;
  };
  std::vector<Key> missing;
  for (const Key& k : desired_) if (!active_.count(k)) missing.push_back(k);
  for (auto& [k, n] : active_) {
    bool want = desiredSet_.count(k) > 0;
    if (!want) { // an old node stands in where its replacements are not built yet
      bool cover = false;
      for (const Key& m : missing) if (overlaps(k, m)) { cover = true; break; }
      if (!cover) continue;
    }
    dvec3 bmin(double(k.x), n.minY, double(k.z)), bmax(double(k.x + k.size), n.maxY, double(k.z + k.size));
    bool vis = r.visible(bmin, bmax), cast = double(k.size) <= shadowMax && r.castsShadow(bmin, bmax);
    if (!vis && !cast) continue;
    r.submitTerrain(n.vi, indexCount_, dvec3(double(k.x), 0, double(k.z)), cast, vis, bmin, bmax);
  }
}

} // namespace sl
