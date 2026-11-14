// The ground's height round the camera for the valley mist (atmosphere.js updateTerrainMap is the JS's version, for
// its cloud scenery): N x N samples of world.height over SPAN metres, recomputed on a worker thread whenever the
// camera has moved a good way from the map's centre, then handed to the renderer (an R16F texture whose mips are the
// regional ground level the mist compares the valley floors with).
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "world/world.h"
#include <chrono>
#include <cmath>
#include <future>
#include <vector>

namespace sl {

class GroundMap {
public:
  static constexpr int N = 128;
  static constexpr double CELL = 96, SPAN = N * CELL;
  ~GroundMap() { if (job_.valid()) job_.wait(); }
  /// per frame (cheap: starts / collects the worker's job); `now`: block until the first map is in (loading)
  void update(const World& world, Renderer& r, const dvec3& cam, bool now = false) {
    if (!r.wantsGroundMap()) return;
    if (!job_.valid()) {
      dvec2 c(std::floor(cam.x / (CELL * 4) + 0.5) * CELL * 4, std::floor(cam.z / (CELL * 4) + 0.5) * CELL * 4);
      if (!have_ || std::fabs(c.x - center_.x) > SPAN * 0.12 || std::fabs(c.y - center_.y) > SPAN * 0.12) {
        jobCenter_ = c;
        const World* w = &world;
        job_ = std::async(std::launch::async, [w, c]() {
          std::vector<float> h(size_t(N) * N);
          for (int j = 0; j < N; j++)
            for (int i = 0; i < N; i++)
              h[size_t(j) * N + size_t(i)] = float(w->height(c.x + (i + 0.5 - N * 0.5) * CELL, c.y + (j + 0.5 - N * 0.5) * CELL));
          return h;
        });
      }
    }
    if (job_.valid() && (now || job_.wait_for(std::chrono::seconds(0)) == std::future_status::ready)) {
      std::vector<float> h = job_.get();
      r.setGroundMap(h, N, jobCenter_, SPAN);
      center_ = jobCenter_;
      have_ = true;
    }
  }

private:
  std::future<std::vector<float>> job_;
  dvec2 center_{0}, jobCenter_{0};
  bool have_ = false;
};

} // namespace sl
