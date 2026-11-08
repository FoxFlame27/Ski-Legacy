#include "game/play.h"
#include "core/prompts.h"
#include <cmath>
#include <cstdio>

namespace sl {

std::string PlayCtx::K(Action a) const { return input ? prompts::K(*input, a) : std::string(); }

std::string fmtMoney(int64_t v) {
  std::string n = std::to_string(v < 0 ? -v : v), o;
  for (size_t i = 0; i < n.size(); i++) { if (i && (n.size() - i) % 3 == 0) o += ','; o += n[i]; }
  return (v < 0 ? "-$" : "$") + o;
}

std::string fmtRaceTime(double t) {
  if (!(t >= 0) || t > 35999) return "--:--";
  int m = int(t / 60);
  double s = t - m * 60;
  char b[32];
  std::snprintf(b, sizeof b, "%d:%05.2f", m, s);
  return b;
}

std::string ordinal(int n) {
  int m = n % 100;
  const char* suf = (m >= 11 && m <= 13) ? "th" : n % 10 == 1 ? "st" : n % 10 == 2 ? "nd" : n % 10 == 3 ? "rd" : "th";
  return std::to_string(n) + suf;
}

} // namespace sl
