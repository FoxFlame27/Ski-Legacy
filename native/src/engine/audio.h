// Procedural audio for Phase 1 (no samples yet): wind that rises with speed, the hiss of carving / skidding skis,
// and thuds for landings and crashes. Parameters are set from the game thread, synthesised on the audio thread.
// The web game's recorded sounds (public/audio) come with Phase 7 (a mixer + Ogg/WAV decoding).
#pragma once
#include <atomic>
#include <cstdint>

namespace sl {
namespace platform { class Platform; }

class Audio {
public:
  bool start(platform::Platform& p);
  void stop(platform::Platform& p);
  void setSki(float speed, float edge, float skid, bool airborne, bool onSkis);
  void thud(float amount);
  float masterVolume = 0.8f;

private:
  void render(float* out, int frames, int channels);
  std::atomic<float> wind_{0}, carve_{0}, skid_{0};
  std::atomic<float> thud_{0};
  // synth state (audio thread)
  uint32_t seed_ = 22222;
  float lp1_ = 0, lp2_ = 0, bp1_ = 0, bp2_ = 0, hp_ = 0, gWind_ = 0, gCarve_ = 0, gSkid_ = 0, thudEnv_ = 0, thudPh_ = 0, prevN_ = 0;
  bool running_ = false;
};

} // namespace sl
