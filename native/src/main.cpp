// Ski Legacy — native entry point.
//   ski_legacy [--quality low|medium|high] [--spawn village|piste] [--fullscreen] [--size WxH] [--no-vsync]
//              [--bindings file.json] [--neutral] [--hour H] [--no-menu] [--save name.json]
//   ski_legacy --autotest [--frames N] [--png out.png]   load, ski a run for N frames, walk into a hotel, ride a gondola,
//                                                        print stats, exit 0 on success
//   ski_legacy --verify-heights                          compare the C++ terrain with the JavaScript reference samples
#include "game/game.h"
#include "core/log.h"
#include <SDL.h>   // SDL_main on Windows / macOS
#include <cstring>
#include <string>
#include <cstdlib>
#include <cstdio>
#include <algorithm>

int main(int argc, char** argv) {
  sl::GameOptions o;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--autotest") o.autotest = true;
    else if (a == "--frames") o.frames = std::max(1, std::atoi(next().c_str()));
    else if (a == "--png") o.png = next();
    else if (a == "--verify-heights") o.verifyHeights = true;
    else if (a == "--quality") { o.quality = next(); o.qualitySet = true; }
    else if (a == "--no-menu") o.menu = false;
    else if (a == "--save") o.saveName = next();
    else if (a == "--spawn") o.spawn = next();
    else if (a == "--fullscreen") o.fullscreen = true;
    else if (a == "--no-vsync") o.vsync = false;
    else if (a == "--bindings") o.bindings = next();
    else if (a == "--neutral") o.toneMap = 1;
    else if (a == "--hour") o.hour = std::atof(next().c_str());
    else if (a == "--size") { std::string s = next(); std::sscanf(s.c_str(), "%dx%d", &o.width, &o.height); }
    else if (a == "--help" || a == "-h") {
      std::puts("ski_legacy [--quality low|medium|high|ultra] [--spawn village|piste] [--fullscreen] [--size WxH] [--no-vsync]\n"
                "           [--bindings binds.json] [--neutral] [--hour 0-24] [--no-menu] [--save name.json]\n"
                "           [--autotest [--frames N] [--png out.png]] [--verify-heights]");
      return 0;
    } else SL_WARN("unknown option %s", a.c_str());
  }
  return sl::runGame(o);
}
