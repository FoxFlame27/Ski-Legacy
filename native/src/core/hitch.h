// The hitch hunt (SKI_LEGACY_DEBUG=hitchtest --autotest): wall-clock frame times in normal play pacing (vsync on,
// every frame rendered, the simulation in real time), the percentiles, the frames over 20 / 33 ms and, for each of
// those, which system took the time (the [perf] buckets of game.cpp, the buffer swap, the rest).
#pragma once
#include "core/log.h"
#include "core/perf.h"
#include <algorithm>
#include <map>
#include <string>
#include <vector>

namespace sl {

class HitchRecorder {
public:
  bool on = false;
  /// the frame's buckets, before PerfStats::endFrame clears them
  void capture(const PerfStats& perf) {
    if (!on) return;
    cur_.clear();
    for (const auto& s : perf.systems()) if (s.frame > 0) cur_.push_back({s.name, s.frame});
  }
  void note(const char* name, double ms) { if (on && ms > 0) extra_.push_back({name, ms}); }
  /// a frame ended (after the swap): its wall time, the phase it belongs to, where the player is
  void endFrame(double wallMs, double swapMs, const std::string& phase, double x, double z, uint32_t draws, uint64_t tris) {
    if (!on) return;
    if (skip_ > 0) { skip_--; cur_.clear(); extra_.clear(); return; }
    Phase& p = phases_[phase];
    if (p.ms.empty()) order_.push_back(phase);
    p.ms.push_back(float(wallMs));
    p.draws += draws; p.tris += double(tris);
    all_.push_back(float(wallMs));
    double sum = swapMs;
    for (const auto& b : cur_) sum += b.ms;
    // (a spike: a frame well over the pace of the frames round it, what the eye reads as a hitch even at 30 fps)
    const bool spike = wallMs > std::max(20.0, pace_ * 1.6 + 4.0);
    pace_ = pace_ <= 0 ? wallMs : pace_ + (std::min(wallMs, pace_ * 2) - pace_) * 0.05;
    if (wallMs > 33.4) p.over33++;
    if (wallMs > 20.0) p.over20++;
    if (spike) {
      p.spikes++;
      // (who took it: the largest bucket that is itself out of the ordinary, else the swap = the GPU / the driver)
      std::string who = "swap (GPU / driver)";
      double best = 0;
      for (const auto& b : cur_) if (b.ms > best) { best = b.ms; who = b.name; }
      const double other = wallMs - sum;
      if (other > best) { best = other; who = "other (events, script, UI build)"; }
      if (best < 8.0) who = "swap (GPU / driver)";
      blame_[who].n++; blame_[who].ms += wallMs - pace_;
      if (logged_ < 1500) {
        logged_++;
        std::string line;
        char buf[160];
        for (const auto& b : cur_) if (b.ms >= 1.5) { std::snprintf(buf, sizeof buf, " %s %.1f;", shortName(b.name).c_str(), b.ms); line += buf; }
        for (const auto& b : extra_) { std::snprintf(buf, sizeof buf, " {%s %.1f}", b.name.c_str(), b.ms); line += buf; }
        SL_INFO("[hitch] %6.1f ms  %-8s frame %5zu at (%.0f, %.0f): swap %.1f, other %.1f;%s", wallMs, phase.c_str(), all_.size(), x, z, swapMs, other, line.c_str());
      }
    }
    cur_.clear(); extra_.clear();
  }
  /// frames not to count (a teleport the script makes: the loading a player sees behind a fade)
  void skip(int frames) { skip_ = std::max(skip_, frames); }
  void report() {
    if (!on || all_.empty()) return;
    SL_INFO("[hitch] ---- frame times in real time (wall clock, vsync, every frame rendered) ----");
    SL_INFO("[hitch] %-10s %7s %6s %6s %6s %7s %6s %6s %6s %7s %8s", "phase", "frames", "p50", "p95", "p99", "max", ">20ms", ">33ms", "spikes", "draws", "tris");
    for (const auto& name : order_) row(name.c_str(), phases_[name].ms, phases_[name].over20, phases_[name].over33, phases_[name].spikes, phases_[name].draws, phases_[name].tris);
    int o20 = 0, o33 = 0, sp = 0;
    double d = 0, t = 0;
    for (auto& kv : phases_) { o20 += kv.second.over20; o33 += kv.second.over33; sp += kv.second.spikes; d += kv.second.draws; t += kv.second.tris; }
    row("ALL", all_, o20, o33, sp, d, t);
    for (const auto& kv : blame_) SL_INFO("[hitch] blamed: %-44s %4d frames, %7.0f ms over budget", kv.first.c_str(), kv.second.n, kv.second.ms);
  }

private:
  struct Bucket { std::string name; double ms; };
  struct Phase { std::vector<float> ms; int over20 = 0, over33 = 0, spikes = 0; double draws = 0, tris = 0; };
  struct Blame { int n = 0; double ms = 0; };
  static std::string shortName(const std::string& n) { size_t p = n.find(" ("); return p == std::string::npos ? n : n.substr(0, p); }
  static void row(const char* name, std::vector<float> v, int o20, int o33, int spikes, double draws, double tris) {
    if (v.empty()) return;
    const size_t n = v.size();
    std::sort(v.begin(), v.end());
    auto pc = [&](double q) { return double(v[std::min(n - 1, size_t(q * double(n)))]); };
    SL_INFO("[hitch] %-10s %7zu %6.1f %6.1f %6.1f %7.1f %6d %6d %6d %7.0f %7.2fM", name, n, pc(0.50), pc(0.95), pc(0.99), double(v.back()), o20, o33, spikes, draws / double(n), tris / double(n) / 1e6);
  }
  std::vector<Bucket> cur_, extra_;
  std::map<std::string, Phase> phases_;
  std::vector<std::string> order_;
  std::vector<float> all_;
  std::map<std::string, Blame> blame_;
  int logged_ = 0, skip_ = 0;
  double pace_ = 0;
};

/// a part of a bucket, named in the hitch lines when it took over 2 ms: { HitchScope hs(hitch, "trees"); ... }
class HitchScope {
public:
  HitchScope(HitchRecorder& h, const char* name) : h_(h), name_(name), t0_(std::chrono::steady_clock::now()) {}
  ~HitchScope() {
    if (!h_.on) return;
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0_).count();
    if (ms > 2.0) h_.note(name_, ms);
  }
  HitchScope(const HitchScope&) = delete;
  HitchScope& operator=(const HitchScope&) = delete;
private:
  HitchRecorder& h_;
  const char* name_;
  std::chrono::steady_clock::time_point t0_;
};

} // namespace sl
