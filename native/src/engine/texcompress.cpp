#include "engine/texcompress.h"
#include <string.h>
#define STB_DXT_IMPLEMENTATION
#include <stb_dxt.h>
#include <algorithm>
#include <cstring>

namespace sl {

void compressBC(const uint8_t* rgba, int w, int h, std::vector<std::vector<uint8_t>>& levels, bool& alpha) {
  alpha = false;
  for (size_t i = 0; i < size_t(w) * h; i++) if (rgba[i * 4 + 3] < 250) { alpha = true; break; }
  levels.clear();
  std::vector<uint8_t> cur(rgba, rgba + size_t(w) * h * 4), next;
  int cw = w, ch = h;
  const int bs = alpha ? 16 : 8;
  for (;;) {
    int bx = (cw + 3) / 4, by = (ch + 3) / 4;
    std::vector<uint8_t> out(size_t(bx) * by * bs);
    uint8_t block[64];
    for (int y = 0; y < by; y++)
      for (int x = 0; x < bx; x++) {
        for (int j = 0; j < 4; j++)
          for (int i = 0; i < 4; i++) {
            int sx = std::min(cw - 1, x * 4 + i), sy = std::min(ch - 1, y * 4 + j);   // (edge texels repeated: padding)
            std::memcpy(&block[(j * 4 + i) * 4], &cur[(size_t(sy) * cw + sx) * 4], 4);
          }
        stb_compress_dxt_block(&out[(size_t(y) * bx + x) * bs], block, alpha ? 1 : 0, STB_DXT_NORMAL);
      }
    levels.push_back(std::move(out));
    if (cw == 1 && ch == 1) break;
    int nw = std::max(1, cw / 2), nh = std::max(1, ch / 2);
    next.assign(size_t(nw) * nh * 4, 0);
    for (int y = 0; y < nh; y++)
      for (int x = 0; x < nw; x++)
        for (int c = 0; c < 4; c++) {
          int x0 = std::min(cw - 1, x * 2), x1 = std::min(cw - 1, x * 2 + 1), y0 = std::min(ch - 1, y * 2), y1 = std::min(ch - 1, y * 2 + 1);
          int s = cur[(size_t(y0) * cw + x0) * 4 + c] + cur[(size_t(y0) * cw + x1) * 4 + c] + cur[(size_t(y1) * cw + x0) * 4 + c] + cur[(size_t(y1) * cw + x1) * 4 + c];
          next[(size_t(y) * nw + x) * 4 + c] = uint8_t((s + 2) / 4);
        }
    cur.swap(next);
    cw = nw; ch = nh;
  }
}

} // namespace sl
