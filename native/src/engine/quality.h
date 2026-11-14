// Graphics presets (engine/quality.js: the web game's seven SETTINGS presets, one table for what every system may
// cost), plus 'switch': the Nintendo Switch budget.
//
// The 'switch' preset is modelled on the console: 1280x720 handheld / 1920x1080 docked, ~4 GB of unified RAM (about
// 3.2 GB for a game), a Maxwell GPU (256 CUDA cores, 307-384 MHz handheld / 768 MHz docked: ~0.2-0.4 TFLOPS FP32) and
// four A57 cores at ~1 GHz. Target 30 fps. So: textures capped at 512, one 1024 shadow map over a short range with
// single-tap PCF, shorter tree / prop / vehicle LOD distances and draw distance, half the townsfolk and traffic,
// simplified shaders (SL_LOW: no normal maps past 30 m, four point lights, no sun glints), no MSAA / AO / shafts,
// a small trail map, dynamic resolution between 60 % and 100 % of the output.
//
// The heavy look lives in High / Ultra / Super Ultra (quality.fx 2..4, as the web game): cascaded shadows (3-4, up
// to 4096 px each), MSAA 4x / 8x with alpha to coverage, GTAO, sun shafts, the 2048 px snow / rock detail maps, a
// 2048-3072 px snow trail map, PBR Neutral tone mapping on Ultra and up, the ray-marched cloud layer at full steps,
// farther forests (impostors to 2-3 km), maximum anisotropic filtering.
#pragma once
#include "engine/renderer.h"
#include <cstdlib>
#include <string>

namespace sl {
struct Quality {
  std::string name = "balanced";
  float terrainLodK = 1.6f;   // terrain node splits while closer than size * lodK (JS: 1.15 / 1.6 / 2.2 / 2.9 / 3.3 / 3.8)
  int shadowSize = 2048;      // per cascade
  float shadowRange = 80;     // m: where the sun's shadows end (one cascade: half extent of the box round the player)
  int cascades = 1;
  float treeNear = 40, treeMid = 150, treeFar = 600;  // full mesh / 20 % / 2 % LOD distances
  float renderScale = 1.0f;
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
  // quality.js npcs: the resort's skiers and walkers (npcs.js), the distance within which their rigs pose every frame
  int npcSkiers = 10, npcWalkers = 4;
  float animNear = 90;
  // the look (renderer)
  int fx = 1;                 // quality.fx realism tier 0..4
  int terrainDetail = 1;      // terrain.js TERRAIN_DETAIL
  int msaa = 1;
  int ao = 0, aoDirs = 2, aoSteps = 6;
  bool shafts = false, fxaa = true;
  float sharpen = 0.15f;
  int toneMap = 0;            // 0 ACES filmic, 1 PBR Neutral
  int grade = 2;
  int detailTex = 1024;       // baked snow / rock detail maps (px, 0: none)
  int trailSize = 1024;       // snow trail map (px, 0: none)
  float trailRange = 96;      // m across
  int envSize = 256;
  float aniso = 8;            // anisotropic filtering of the models' textures (16: the GPU's maximum)
  float impostorR = 1400;     // far forest impostors out to (m)
  int maxImpostors = 30000;
  float sprayScale = 1;       // spray particles x this
  float rockR = 230;          // the mountains' rocks drawn within (m; crags and outcrops twice that): quality.js veg.rockR

  /// the web game's names (quality.js QUALITY_ORDER) and the old native ones onto the presets here
  static std::string normalize(const std::string& n) {
    if (n == "low") return "performance";
    if (n == "medium") return "balanced";
    if (n == "switch" || n == "super" || n == "performance" || n == "balanced" || n == "high" || n == "ultra" || n == "superultra") return n;
    return "auto";
  }
  /// first launch: High on Apple silicon (an M-series GPU carries it at 60 fps), Balanced elsewhere
  static std::string platformDefault() {
#if defined(__APPLE__) && (defined(__aarch64__) || defined(__arm64__))
    return "high";
#else
    return "balanced";
#endif
  }
  static Quality preset(const std::string& web) {
    Quality q;
    std::string n = normalize(web);
    if (n == "auto") n = platformDefault();
    q.name = n;
    if (n == "super" || n == "performance") {
      q.terrainLodK = 1.15f; q.shadowSize = 1024; q.shadowRange = 60; q.treeNear = 25; q.treeMid = 100; q.treeFar = 380; q.renderScale = n == "super" ? 0.6f : 0.85f;
      q.maxTexture = 1024; q.lodScale = 0.75f; q.farZ = 20000; q.npcScale = 0.75f; q.maxLights = 8; q.maxPeople = 36;
      q.fx = 0; q.terrainDetail = 0; q.sharpen = 0.25f; q.detailTex = 0; q.trailSize = 512; q.trailRange = 64; q.envSize = 128; q.aniso = 4;
      q.impostorR = n == "super" ? 700 : 900; q.maxImpostors = n == "super" ? 8000 : 15000; q.sprayScale = 0.5f;
    } else if (n == "high") {
      q.terrainLodK = 2.9f; q.shadowSize = 2048; q.shadowRange = 320; q.cascades = 3; q.treeNear = 70; q.treeMid = 250; q.treeFar = 900; q.lodScale = 1.25f;
      q.fx = 2; q.terrainDetail = 2; q.msaa = 4; q.ao = 1; q.aoDirs = 2; q.aoSteps = 6; q.shafts = true; q.sharpen = 0.25f;
      q.toneMap = 1;   // (PBR Neutral as Ultra: sunlit snow white with its detail, no ACES hue skew; costs the same)
      q.detailTex = 2048; q.trailSize = 2048; q.trailRange = 128; q.aniso = 16; q.impostorR = 1900; q.maxImpostors = 50000;
    } else if (n == "ultra") {
      q.terrainLodK = 3.3f; q.shadowSize = 3072; q.shadowRange = 480; q.cascades = 4; q.treeNear = 100; q.treeMid = 350; q.treeFar = 1300; q.lodScale = 1.5f; q.maxPeople = 64;
      q.fx = 3; q.terrainDetail = 2; q.msaa = 8; q.ao = 2; q.aoDirs = 3; q.aoSteps = 8; q.shafts = true; q.sharpen = 0.3f; q.toneMap = 1;
      q.detailTex = 2048; q.trailSize = 2048; q.trailRange = 128; q.envSize = 512; q.aniso = 16; q.impostorR = 2400; q.maxImpostors = 60000; q.sprayScale = 1.3f;
    } else if (n == "superultra") {
      q.terrainLodK = 3.8f; q.shadowSize = 4096; q.shadowRange = 640; q.cascades = 4; q.treeNear = 130; q.treeMid = 420; q.treeFar = 1600; q.lodScale = 2.0f; q.maxPeople = 72;
      q.fx = 4; q.terrainDetail = 2; q.msaa = 8; q.ao = 2; q.aoDirs = 4; q.aoSteps = 10; q.shafts = true; q.sharpen = 0.3f; q.toneMap = 1;
      q.detailTex = 2048; q.trailSize = 3072; q.trailRange = 150; q.envSize = 512; q.aniso = 16; q.impostorR = 3000; q.maxImpostors = 80000; q.sprayScale = 1.5f;
    } else if (n == "switch") {
      q.terrainLodK = 1.05f; q.shadowSize = 1024; q.shadowRange = 50; q.treeNear = 22; q.treeMid = 85; q.treeFar = 320; q.renderScale = 1.0f;
      q.maxTexture = 512; q.lodScale = 0.6f; q.farZ = 14000; q.npcScale = 0.5f; q.maxLights = 4; q.lowShaders = true; q.dynamicRes = true; q.maxPeople = 24; q.compressTextures = true; q.triangleBudget = 90000;
      q.fx = 0; q.terrainDetail = 0; q.fxaa = false; q.sharpen = 0; q.grade = 1; q.detailTex = 0; q.trailSize = 512; q.trailRange = 48; q.envSize = 64; q.aniso = 4;
      q.impostorR = 700; q.maxImpostors = 6000; q.sprayScale = 0.35f;
    } else {
      q.name = "balanced";
      q.terrainLodK = 2.2f; q.shadowSize = 2048; q.shadowRange = 160; q.cascades = 2; q.treeNear = 40; q.treeMid = 150; q.treeFar = 600;
      q.fx = 1; q.terrainDetail = 1; q.sharpen = 0.15f; q.detailTex = 1024; q.trailSize = 1024; q.trailRange = 96; q.aniso = 8;
    }
    q.rockR = n == "super" || n == "switch" ? 80.f : n == "performance" ? 150.f : n == "high" ? 300.f : n == "ultra" ? 340.f : n == "superultra" ? 400.f : 230.f;
    // (the six web presets' own npcs rows; switch: performance's)
    if (n == "super") { q.npcSkiers = 3; q.npcWalkers = 1; q.animNear = 25; }
    else if (n == "performance" || n == "switch") { q.npcSkiers = 7; q.npcWalkers = 3; q.animNear = 45; }
    else if (n == "high") { q.npcSkiers = 14; q.npcWalkers = 7; q.animNear = 140; }
    else if (n == "ultra") { q.npcSkiers = 17; q.npcWalkers = 8; q.animNear = 180; }
    else if (n == "superultra") { q.npcSkiers = 20; q.npcWalkers = 9; q.animNear = 220; }
    // (dev: SKI_LEGACY_TEXCAP=512 caps the models' textures and block-compresses them: look tests on a busy machine)
    if (const char* tc = std::getenv("SKI_LEGACY_TEXCAP")) { int c = std::atoi(tc); if (c >= 64) { q.maxTexture = c; q.compressTextures = true; } }
    return q;
  }
  void renderSettings(RenderSettings& rs) const {
    rs.shadowSize = shadowSize; rs.shadowRange = shadowRange; rs.cascades = cascades; rs.renderScale = renderScale;
    rs.lowShaders = lowShaders; rs.maxLights = maxLights; rs.fx = fx; rs.terrainDetail = terrainDetail; rs.msaa = msaa;
    rs.ao = ao; rs.aoDirs = aoDirs; rs.aoSteps = aoSteps; rs.shafts = shafts; rs.fxaa = fxaa; rs.sharpen = sharpen;
    rs.toneMap = toneMap; rs.grade = grade; rs.detailTex = detailTex; rs.trailSize = trailSize; rs.trailRange = trailRange; rs.envSize = envSize;
  }
};
} // namespace sl
