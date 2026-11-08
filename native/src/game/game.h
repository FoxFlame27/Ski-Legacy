// The Phase 1 game: boots the platform, renderer and world, runs the main loop (fixed 120 Hz simulation with
// interpolated rendering), and hosts the skier on the mountain. Also the headless --autotest and --verify-heights.
#pragma once
#include <string>

namespace sl {

struct GameOptions {
  bool autotest = false;
  int frames = 600;
  std::string png;            // autotest: write the last frame here
  bool verifyHeights = false;
  std::string quality = "medium";
  int width = 1280, height = 720;
  bool fullscreen = false, vsync = true;
  std::string spawn;             // village | piste (default: village; piste for --autotest)
  std::string bindings;          // JSON file with web-style { kb: {...}, pad: {...} } overrides
  int toneMap = 0;               // 0 ACES, 1 Neutral
};

int runGame(const GameOptions& opt);

} // namespace sl
