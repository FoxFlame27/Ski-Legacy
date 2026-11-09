// Graphics presets (engine/quality.js, condensed), plus (Phase 7) 'switch': the Nintendo Switch budget.
//
// The 'switch' preset is modelled on the console: 1280x720 handheld / 1920x1080 docked, ~4 GB of unified RAM (about
// 3.2 GB for a game), a Maxwell GPU (256 CUDA cores, 307-384 MHz handheld / 768 MHz docked: ~0.2-0.4 TFLOPS FP32) and
// four A57 cores at ~1 GHz. Target 30 fps. So: textures capped at 512 (the GLBs' 2048 maps are box-downsampled on load:
// 1/16 of the memory), a 1024 shadow map over a short range with single-tap PCF, shorter tree / prop / vehicle LOD
// distances and draw distance, half the townsfolk and traffic, simplified shaders (SL_LOW: no normal maps past 30 m,
// four point lights, no sun glints), dynamic resolution between 60 % and 100 % of the output, bloom at quarter res.
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
  // (Phase 7)
  int maxTexture = 2048;      // texture size cap (box-downsampled at load)
  float lodScale = 1.0f;      // props / vehicles / people / course meshes: LOD and cull distances x this
  float farZ = 30000;         // camera far plane (m)
  float npcScale = 1.0f;      // townsfolk, skiers, traffic x this
  int maxLights = 16;         // point / spot lights per frame (lamps, headlights)
  bool lowShaders = false;    // SL_LOW shader variant
  bool dynamicRes = false;    // render scale follows the frame time (30 fps target)
  int maxPeople = 48;         // people drawn per frame
  bool compressTextures = false;   // BC1 / BC3 block compression at load (1/8 - 1/4 of the memory)
  int triangleBudget = 0;          // mesh LOD bias: a model over this many triangles is simplified to it (0: none)

  /// the web game's six presets (engine/quality.js QUALITY_ORDER, the SETTINGS row) onto the ones here
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
    if (n == "low") { q.terrainLodK = 1.15f; q.shadowSize = 1024; q.shadowRange = 60; q.treeNear = 25; q.treeMid = 100; q.treeFar = 380; q.renderScale = web == "super" ? 0.6f : 0.75f;
                      q.maxTexture = 1024; q.lodScale = 0.75f; q.farZ = 20000; q.npcScale = 0.75f; q.maxLights = 8; q.maxPeople = 36; }
    else if (n == "high") { q.terrainLodK = 2.2f; q.shadowSize = 4096; q.shadowRange = 110; q.treeNear = 70; q.treeMid = 250; q.treeFar = 900; q.lodScale = 1.25f; }
    else if (n == "ultra") { q.terrainLodK = 2.9f; q.shadowSize = 4096; q.shadowRange = 140; q.treeNear = 100; q.treeMid = 350; q.treeFar = 1300; q.lodScale = 1.5f; q.maxPeople = 64; }
    else if (n == "switch") {
      q.terrainLodK = 1.05f; q.shadowSize = 1024; q.shadowRange = 50; q.treeNear = 22; q.treeMid = 85; q.treeFar = 320; q.renderScale = 1.0f;
      q.maxTexture = 512; q.lodScale = 0.6f; q.farZ = 14000; q.npcScale = 0.5f; q.maxLights = 4; q.lowShaders = true; q.dynamicRes = true; q.maxPeople = 24; q.compressTextures = true; q.triangleBudget = 90000;
    } else q.name = "medium";
    return q;
  }
};
} // namespace sl
