// A debug remote control for live multiplayer checks (SKI_LEGACY_DEBUG=mplive with --mptest URL): once the test has
// joined a world it stays there and runs the commands appended, one a line, to the file SKI_LEGACY_MPCTL names
// ("tp 4 34 3.14", "outfit kit_gold.jacket - - -", "png gondola", "quit": game.cpp's mptest step 5), so a web client
// driven next to it (puppeteer) and this one can be put side by side and photographed from both sides.
#pragma once
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace sl {

struct MpLive {
  std::string path;
  long offset = 0;
  double pollT = 0;
  int renderFrames = 0;   // ("render N": the next N frames drawn, not only the shots)
  /// the commands that arrived since the last call (each split at spaces), polled about 5 times a second
  std::vector<std::vector<std::string>> poll(double dt) {
    std::vector<std::vector<std::string>> out;
    if (path.empty() || (pollT -= dt) > 0) return out;
    pollT = 0.2;
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return out;
    std::fseek(f, 0, SEEK_END);
    const long end = std::ftell(f);
    if (end > offset) {
      std::string buf(size_t(end - offset), '\0');
      std::fseek(f, offset, SEEK_SET);
      const size_t n = std::fread(buf.data(), 1, buf.size(), f);
      buf.resize(n);
      const size_t nl = buf.rfind('\n');   // (only whole lines)
      if (nl != std::string::npos) {
        offset += long(nl) + 1;
        std::istringstream in(buf.substr(0, nl));
        for (std::string line; std::getline(in, line);) {
          std::istringstream ws(line);
          std::vector<std::string> a;
          for (std::string w; ws >> w;) a.push_back(w);
          if (!a.empty()) out.push_back(std::move(a));
        }
      }
    }
    std::fclose(f);
    return out;
  }
};

} // namespace sl
