// Ski Legacy — native entry point.
//   ski_legacy [--quality switch|low|medium|high|ultra] [--spawn village|piste] [--fullscreen] [--size WxH] [--no-vsync]
//              [--bindings file.json] [--neutral] [--hour H] [--no-menu] [--no-intro] [--save name.json]
//   ski_legacy --autotest [--frames N] [--png out.png]   load, ski a run for N frames, walk into a hotel, ride a gondola,
//                                                        print stats, exit 0 on success
//   ski_legacy --verify-heights                          compare the C++ terrain with the JavaScript reference samples
//   ski_legacy --mptest ws://127.0.0.1:8787/ws [--mp-peers N]   the multiplayer check against a running server
#include "game/game.h"
#include "core/log.h"
#include <SDL.h>   // SDL_main on Windows / macOS
#include <cstring>
#include <string>
#include <cstdlib>
#include <cstdio>
#include <algorithm>
#include <vector>
#include <unistd.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

int main(int argc, char** argv) {
  sl::GameOptions o;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--autotest") o.autotest = true;
    else if (a == "--frames") o.frames = std::max(1, std::atoi(next().c_str()));
    else if (a == "--png") o.png = next();
    else if (a == "--verify-heights") o.verifyHeights = true;
    else if (a == "--rig-shots") o.rigShots = next();
    else if (a == "--verify-poses") o.verifyPoses = i + 1 < argc && argv[i + 1][0] != '-' ? next() : std::string("@data");
    else if (a == "--quality") { o.quality = next(); o.qualitySet = true; }
    else if (a == "--no-menu") o.menu = false;
    else if (a == "--no-intro") o.intro = false;
    else if (a == "--save") o.saveName = next();
    else if (a == "--spawn") o.spawn = next();
    else if (a == "--fullscreen") o.fullscreen = true;
    else if (a == "--no-vsync") o.vsync = false;
    else if (a == "--bindings") o.bindings = next();
    else if (a == "--neutral") o.toneMap = 1;
    else if (a == "--hour") o.hour = std::atof(next().c_str());
    else if (a == "--server") o.server = next();
    else if (a == "--mptest") o.mptest = next();
    else if (a == "--mp-peers") o.mpPeers = std::max(0, std::atoi(next().c_str()));
    else if (a == "--mp-seconds") o.mpSeconds = std::max(1.0, std::atof(next().c_str()));
    else if (a == "--size") { std::string s = next(); std::sscanf(s.c_str(), "%dx%d", &o.width, &o.height); }
    else if (a == "--help" || a == "-h") {
      std::puts("ski_legacy [--quality switch|low|medium|high|ultra] [--spawn village|piste] [--fullscreen] [--size WxH] [--no-vsync]\n"
                "           [--bindings binds.json] [--neutral] [--hour 0-24] [--no-menu] [--no-intro] [--save name.json]\n"
                "           [--autotest [--frames N] [--png out.png]] [--verify-heights] [--verify-poses [ref.json]]\n"
                "           [--server wss://host/ws] [--mptest ws://127.0.0.1:PORT/ws [--mp-peers N] [--mp-seconds S]]");
      return 0;
    } else SL_WARN("unknown option %s", a.c_str());
  }
  // test runs are silent (the autotest's mixer still runs on SDL's dummy driver); SKI_LEGACY_SOUND=1 to hear them
  if ((o.autotest || !o.mptest.empty() || std::getenv("SKI_LEGACY_DEBUG")) && !std::getenv("SKI_LEGACY_SOUND")) {
#if defined(_WIN32)
    _putenv_s("SDL_AUDIODRIVER", "dummy");
#else
    setenv("SDL_AUDIODRIVER", "dummy", 1);
#endif
  }
  const int r = sl::runGame(o);
#if defined(__APPLE__) || defined(__linux__)
  if (r == sl::kRestartGame) {   // (a new graphics preset: this process again, straight to the menu)
    std::string self = argv[0];
#if defined(__APPLE__)
    char buf[4096]; uint32_t sz = sizeof buf;
    if (_NSGetExecutablePath(buf, &sz) == 0) self = buf;
#endif
    std::vector<char*> args(argv, argv + argc);
    bool hasNoIntro = false;
    for (int i = 1; i < argc; i++) hasNoIntro = hasNoIntro || std::strcmp(argv[i], "--no-intro") == 0;
    static char noIntro[] = "--no-intro";
    if (!hasNoIntro) args.push_back(noIntro);
    args.push_back(nullptr);
    SDL_Quit();
    execv(self.c_str(), args.data());
    SL_ERROR("restart failed: %s", self.c_str());
  }
#endif
  return r == sl::kRestartGame ? 0 : r;
}
