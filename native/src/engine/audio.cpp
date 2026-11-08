#include "engine/audio.h"
#include "platform/platform.h"
#include <algorithm>
#include <cmath>

namespace sl {

bool Audio::start(platform::Platform& p) {
  running_ = p.openAudio(48000, 2, [this](float* out, int frames, int ch) { render(out, frames, ch); });
  return running_;
}
void Audio::stop(platform::Platform& p) { if (running_) p.closeAudio(); running_ = false; }

void Audio::setSki(float speed, float edge, float skid, bool airborne, bool onSkis) {
  float s = std::min(1.f, speed / 30.f);
  wind_ = s * s * 0.35f;
  carve_ = onSkis && !airborne ? std::min(1.f, speed / 15.f) * (0.08f + 0.25f * std::min(1.f, edge)) : 0.f;
  skid_ = onSkis && !airborne ? std::min(1.f, skid) * std::min(1.f, speed / 8.f) * 0.35f : 0.f;
}
void Audio::thud(float amount) { thud_ = std::max(thud_.load(), amount); }

void Audio::render(float* out, int frames, int channels) {
  const float wT = wind_, cT = carve_, sT = skid_;
  float th = thud_.exchange(0);
  if (th > 0) { thudEnv_ = std::max(thudEnv_, th); thudPh_ = 0; }
  for (int i = 0; i < frames; i++) {
    seed_ = seed_ * 1664525u + 1013904223u;
    float n = float(int32_t(seed_)) / 2147483648.f;
    gWind_ += (wT - gWind_) * 0.0005f; gCarve_ += (cT - gCarve_) * 0.002f; gSkid_ += (sT - gSkid_) * 0.002f;
    // wind: low-passed noise, two poles
    lp1_ += (n - lp1_) * 0.02f; lp2_ += (lp1_ - lp2_) * 0.05f;
    // carve hiss: high-passed noise; skid: band-passed (scrape)
    hp_ = 0.97f * (hp_ + n - prevN_); prevN_ = n;
    bp1_ += (n - bp1_) * 0.25f; bp2_ += (bp1_ - bp2_) * 0.25f;
    float s = lp2_ * gWind_ * 6.f + hp_ * gCarve_ * 0.5f + (bp1_ - bp2_) * gSkid_ * 1.5f;
    if (thudEnv_ > 0.001f) {
      thudPh_ += 2.f * 3.14159265f * (55.f + 40.f * thudEnv_) / 48000.f;
      s += std::sin(thudPh_) * thudEnv_ * 0.5f + lp1_ * thudEnv_ * 2.f;
      thudEnv_ *= 0.9993f;
    }
    s = std::tanh(s * masterVolume);
    for (int c = 0; c < channels; c++) out[i * channels + c] = s;
  }
}

} // namespace sl
