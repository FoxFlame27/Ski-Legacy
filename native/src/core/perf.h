// (Phase 7) CPU time per system, per frame: ScopedTimer t(perf, "render"); the autotest prints the table (mean / max ms,
// share of the frame), the numbers a Switch port budgets against (33.3 ms at 30 fps on four ~1 GHz A57 cores).
#pragma once
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

namespace sl {

class PerfStats {
public:
  struct Sys { std::string name; double sum = 0, max = 0, frame = 0; int n = 0; };
  void add(const char* name, double ms) {
    for (auto& s : sys_) if (s.name == name) { s.frame += ms; return; }
    sys_.push_back({name, 0, 0, ms, 0});
  }
  /// end of a frame: the frame's totals into the means / maxima
  void endFrame() {
    for (auto& s : sys_) { s.sum += s.frame; s.max = std::max(s.max, s.frame); s.n++; s.frame = 0; }
    frames_++;
  }
  void reset() { for (auto& s : sys_) { s.sum = s.max = s.frame = 0; s.n = 0; } frames_ = 0; }
  int frames() const { return frames_; }
  const std::vector<Sys>& systems() const { return sys_; }
  double mean(const char* name) const { for (auto& s : sys_) if (s.name == name) return s.n ? s.sum / s.n : 0; return 0; }
private:
  std::vector<Sys> sys_;
  int frames_ = 0;
};

class ScopedTimer {
public:
  ScopedTimer(PerfStats& p, const char* name) : p_(p), name_(name), t0_(std::chrono::steady_clock::now()) {}
  ~ScopedTimer() { p_.add(name_, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0_).count()); }
  ScopedTimer(const ScopedTimer&) = delete;
  ScopedTimer& operator=(const ScopedTimer&) = delete;
private:
  PerfStats& p_;
  const char* name_;
  std::chrono::steady_clock::time_point t0_;
};

} // namespace sl
