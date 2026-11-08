// Graphics presets (engine/quality.js, condensed). The Switch target is about "medium" docked and "low" handheld.
#pragma once
#include <string>

namespace sl {
struct Quality {
  std::string name = "medium";
  float terrainLodK = 1.6f;   // terrain node splits while closer than size * lodK (JS: 1.15 / 1.6 / 2.2 / 2.9)
  int shadowSize = 2048;
  float shadowRange = 80;     // m (half extent of the shadow box)
  float treeNear = 40, treeMid = 150, treeFar = 600;  // full mesh / 20 % / 2 % LOD distances
  float renderScale = 1.0f;

  /// the web game's six presets (engine/quality.js QUALITY_ORDER, the SETTINGS row) onto the four here
  static std::string fromWeb(const std::string& n) {
    if (n == "super" || n == "performance") return "low";
    if (n == "balanced") return "medium";
    if (n == "superultra") return "ultra";
    return n;
  }
  static Quality preset(const std::string& web) {
    Quality q;
    std::string n = fromWeb(web);
    q.name = n;
    if (n == "low") { q.terrainLodK = 1.15f; q.shadowSize = 1024; q.shadowRange = 60; q.treeNear = 25; q.treeMid = 100; q.treeFar = 380; q.renderScale = web == "super" ? 0.6f : 0.75f; }
    else if (n == "high") { q.terrainLodK = 2.2f; q.shadowSize = 4096; q.shadowRange = 110; q.treeNear = 70; q.treeMid = 250; q.treeFar = 900; }
    else if (n == "ultra") { q.terrainLodK = 2.9f; q.shadowSize = 4096; q.shadowRange = 140; q.treeNear = 100; q.treeMid = 350; q.treeFar = 1300; }
    else q.name = "medium";
    return q;
  }
};
} // namespace sl
