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
};

class AssetManager {
public:
  AssetManager(platform::Platform& p, gfx::Device& dev, const AssetPaths& paths) : p_(p), dev_(dev), paths_(paths) {}
  /// models/<name>.glb from the asset root; nullptr (and a log line) if missing or broken.
  std::shared_ptr<Model> model(const std::string& name, const ModelLoadOptions& opt = {});
  /// Load from an explicit path.
  std::shared_ptr<Model> loadFile(const std::string& path, const std::string& name, const ModelLoadOptions& opt);
  size_t textureBytes() const { return texBytes_; }

private:
  platform::Platform& p_;
  gfx::Device& dev_;
  const AssetPaths& paths_;
  std::unordered_map<std::string, std::shared_ptr<Model>> cache_;
  size_t texBytes_ = 0;
};

} // namespace sl
