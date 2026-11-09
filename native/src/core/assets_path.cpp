#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"
#include <cstdlib>
#include <filesystem>
#include <zstd.h>

namespace sl {
namespace fs = std::filesystem;

bool AssetPaths::init(platform::Platform& p) {
  auto ok = [&](const fs::path& pub, const fs::path& data) {
    std::error_code ec;
    if (fs::exists(pub / "models", ec) && (fs::exists(data / "world.json.zst", ec) || fs::exists(data / "world.json", ec))) {
      publicRoot = fs::weakly_canonical(pub).generic_string();
      dataRoot = fs::weakly_canonical(data).generic_string();
      return true;
    }
    return false;
  };
  if (const char* env = std::getenv("SKI_LEGACY_ASSETS")) if (ok(env, fs::path(env) / "data")) return true;
  fs::path exe = p.executableDir();
  if (ok(exe / "assets", exe / "assets" / "data")) return true;
  // (Phase 7) the macOS app bundle: Ski Legacy.app/Contents/MacOS/<exe>, the assets in Contents/Resources/assets
  if (ok(exe / ".." / "Resources" / "assets", exe / ".." / "Resources" / "assets" / "data")) return true;
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
bool AssetPaths::readData(platform::Platform& p, const std::string& file, std::vector<uint8_t>& out) const {
  std::vector<uint8_t> z;
  if (p.readFile(data(file + ".zst"), z)) {
    unsigned long long n = ZSTD_getFrameContentSize(z.data(), z.size());
    if (n == ZSTD_CONTENTSIZE_ERROR || n == ZSTD_CONTENTSIZE_UNKNOWN || n > (1ull << 33)) { SL_ERROR("%s.zst: not a zstd frame with a size", file.c_str()); return false; }
    out.resize(size_t(n));
    size_t r = ZSTD_decompress(out.data(), out.size(), z.data(), z.size());
    if (ZSTD_isError(r) || r != out.size()) { SL_ERROR("%s.zst: %s", file.c_str(), ZSTD_isError(r) ? ZSTD_getErrorName(r) : "short"); out.clear(); return false; }
    return true;
  }
  return p.readFile(data(file), out);
}
} // namespace sl
