// The game (Phases 1-2): boots the platform, renderer and world, runs the main loop (fixed 120 Hz simulation with
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
  double hour = -1;              // time of day to start at (default 10:00; it runs on 24 h / 16 min like sky.js)
};

int runGame(const GameOptions& opt);

} // namespace sl
