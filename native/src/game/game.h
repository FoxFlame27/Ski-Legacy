// The game (Phases 1-6): boots the platform, renderer and world, runs the main loop (fixed 120 Hz simulation with
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
  bool qualitySet = false;       // --quality given (else the save's SETTINGS preset)
  bool menu = true;              // start at the main menu (--no-menu: straight into the game)
  std::string saveName = "ski-legacy-save-v1.json";   // --save NAME (the autotest uses its own, fresh)
  int width = 1280, height = 720;
  bool fullscreen = false, vsync = true;
  std::string spawn;             // village | piste (default: village; piste for --autotest)
  std::string bindings;          // JSON file with web-style { kb: {...}, pad: {...} } overrides
  int toneMap = 0;               // 0 ACES, 1 Neutral
  double hour = -1;              // time of day to start at (default 10:00; it runs on 24 h / 16 min like sky.js)
  // (Phase 6) multiplayer
  std::string server;            // --server URL (else SKI_LEGACY_SERVER, else the game's wss:// server)
  std::string mptest;            // --mptest ws://127.0.0.1:PORT/ws: the multiplayer check against a server
  int mpPeers = 0;               // --mp-peers N: the check also waits for N other players to show up
  double mpSeconds = 8;          // --mp-seconds S: presence sent this long
};

int runGame(const GameOptions& opt);

} // namespace sl
