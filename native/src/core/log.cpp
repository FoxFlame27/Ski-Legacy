#include "core/log.h"
#include <cstdarg>
#include <mutex>

namespace sl {
void logPrint(int level, const char* fmt, ...) {
  static std::mutex m;
  std::lock_guard<std::mutex> lock(m);
  FILE* out = level >= 2 ? stderr : stdout;
  static const char* tags[] = {"", "warning: ", "error: "};
  std::fputs(tags[level < 0 ? 0 : (level > 2 ? 2 : level)], out);
  va_list ap;
  va_start(ap, fmt);
  std::vfprintf(out, fmt, ap);
  va_end(ap);
  std::fputc('\n', out);
  std::fflush(out);
}
} // namespace sl
