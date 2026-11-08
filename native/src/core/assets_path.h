// Where the game's data lives at run time.
//   1. $SKI_LEGACY_ASSETS (a folder with models/ and data/)
//   2. assets/ next to the executable (packaged builds: cmake -DSL_COPY_ASSETS=ON)
//   3. the repository: <repo>/public (models, audio) and <repo>/native/data (exported world data), found by walking
//      up from the executable, then from the source tree the binary was built from
#pragma once
#include <string>

namespace sl {
namespace platform { class Platform; }

class AssetPaths {
public:
  bool init(platform::Platform& p);
  /// "models/pine_tree.glb" -> absolute path (public/ or assets/).
  std::string model(const std::string& name) const { return publicRoot + "/models/" + name + ".glb"; }
  /// "world.json" -> absolute path in the exported data folder.
  std::string data(const std::string& file) const { return dataRoot + "/" + file; }
  std::string publicRoot, dataRoot;
};
} // namespace sl
