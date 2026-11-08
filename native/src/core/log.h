// Minimal logging (printf style). Goes to stdout/stderr on desktop; a console port would route it to its debug log.
#pragma once
#include <cstdio>

namespace sl {
void logPrint(int level, const char* fmt, ...)
#if defined(__GNUC__) || defined(__clang__)
  __attribute__((format(printf, 2, 3)))
#endif
  ;
}
#define SL_INFO(...) ::sl::logPrint(0, __VA_ARGS__)
#define SL_WARN(...) ::sl::logPrint(1, __VA_ARGS__)
#define SL_ERROR(...) ::sl::logPrint(2, __VA_ARGS__)
