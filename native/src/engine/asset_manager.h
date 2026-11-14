// Asset manager: GLB -> GPU models, cached by name.
// Handles everything our GLBs use: EXT_meshopt_compression (decoded with meshoptimizer), KHR_mesh_quantization
// (normalised integer attributes, unpacked to float), EXT_texture_webp (libwebp) and PNG / JPEG (stb_image),
// skins and animations. Optionally builds extra LODs per primitive with meshoptimizer's simplifier.
#pragma once
#include "engine/model.h"
#include <memory>
#include <string>
#include <unordered_map>

namespace sl {
class AssetPaths;
namespace platform { class Platform; }

struct ModelLoadOptions {
  std::vector<float> lodRatios;   // e.g. {0.15f, 0.03f}: extra LOD index ranges at these triangle ratios
  bool ignoreEmissive = true;     // Meshy exports bake emissive = 1 with a copy of the albedo: off by default
  int maxTextureSize = 2048;      // larger textures are box-downsampled on load (memory budget, Switch)
  bool keepCpu = false;           // (Phase 7) keep the vertices / indices on the CPU (the cars' wheels are split off)
  // The extra LODs are drawn with per-vertex colours taken from the base colour map instead of the textures
  // (Model::lodMaterials). For Meshy models whose atlas is thousands of tiny UV islands (the gondola cabin): any
  // simplified mesh joins vertices across islands and samples garbage (pink polka-dot cabins down the line).
  bool lodVertexColor = false;
  // With lodVertexColor: the LODs by vertex clustering instead of edge collapses (assets.js clusterDecimate, the
  // trees' "branch soup" of separate pieces an edge-collapse simplifier cannot reduce and the sloppy one shreds):
  // the cluster cells as shares of the mesh's height, one LOD each; positions, normals and colours averaged per
  // cell, snow and needles kept apart
  std::vector<float> lodCluster;
};

class AssetManager {
public:
  AssetManager(platform::Platform& p, gfx::Device& dev, const AssetPaths& paths) : p_(p), dev_(dev), paths_(paths) {}
  /// models/<name>.glb from the asset root; nullptr (and a log line) if missing or broken.
  std::shared_ptr<Model> model(const std::string& name, const ModelLoadOptions& opt = {});
  /// Load from an explicit path.
  std::shared_ptr<Model> loadFile(const std::string& path, const std::string& name, const ModelLoadOptions& opt);
  size_t textureBytes() const { return texBytes_; }
  std::string modelPath(const std::string& name) const;
  gfx::Device& device() { return dev_; }   // (models built on the side: the crowd people, player/fans_rig)
  /// (Phase 7) a cap on every texture's size (the quality preset: 512 on Switch), whatever the load options ask
  int textureCap = 4096;
  int textureScale = 1;            // the models' own colour-map budgets x this (Balanced and up: 2, with block compression)
  float anisotropy = 8;            // anisotropic filtering of the models' maps (16: the GPU's maximum, High and up)
  int triangleBudget = 0;          // (Phase 7, the switch preset's mesh LOD bias) a model over it is simplified to it
  bool compressTextures = false;   // (Phase 7, the switch preset) BC1 / BC3 block compression at load (engine/texcompress)

private:
  platform::Platform& p_;
  gfx::Device& dev_;
  const AssetPaths& paths_;
  std::unordered_map<std::string, std::shared_ptr<Model>> cache_;
  size_t texBytes_ = 0;
};

/// decodes an image file (WebP, PNG, JPEG) to RGBA8 (the UI's pictures: the round logo of the loading screen)
bool decodeImageRGBA(const std::vector<uint8_t>& file, int& w, int& h, std::vector<uint8_t>& rgba);

} // namespace sl
