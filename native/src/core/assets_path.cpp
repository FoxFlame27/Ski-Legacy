#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"
#include <cstdlib>
#include <filesystem>

namespace sl {
namespace fs = std::filesystem;

bool AssetPaths::init(platform::Platform& p) {
  auto ok = [&](const fs::path& pub, const fs::path& data) {
    std::error_code ec;
    if (fs::exists(pub / "models", ec) && fs::exists(data / "world.json", ec)) {
      publicRoot = fs::weakly_canonical(pub).generic_string();
      dataRoot = fs::weakly_canonical(data).generic_string();
      return true;
    }
    return false;
  };
  if (const char* env = std::getenv("SKI_LEGACY_ASSETS")) if (ok(env, fs::path(env) / "data")) return true;
  fs::path exe = p.executableDir();
  if (ok(exe / "assets", exe / "assets" / "data")) return true;
  for (fs::path d = exe; !d.empty(); d = d.parent_path()) {
    if (ok(d / "public", d / "native" / "data")) return true;
    if (d == d.parent_path()) break;
  }
#ifdef SL_SOURCE_ROOT
  if (ok(fs::path(SL_SOURCE_ROOT) / ".." / "public", fs::path(SL_SOURCE_ROOT) / "data")) return true;
#endif
  SL_ERROR("assets not found: set SKI_LEGACY_ASSETS or build with -DSL_COPY_ASSETS=ON");
  return false;
}
} // namespace sl
