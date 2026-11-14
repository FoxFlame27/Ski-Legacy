#include "game/ui_widgets.h"
#include <algorithm>
#include <cmath>

namespace sl::uiw {
using namespace ui_color;

std::string upper(const std::string& s) {
  std::string o;
  o.reserve(s.size());
  for (size_t i = 0; i < s.size(); i++) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c == 0xC3 && i + 1 < s.size()) {
      unsigned char n = static_cast<unsigned char>(s[i + 1]);
      o += char(c);
      o += char(n >= 0xA0 && n != 0xB7 && n != 0xBF ? n - 0x20 : n);
      i++;
    } else o += char(std::toupper(c));
  }
  return o;
}

std::string thousands(long long v) {
  std::string s = std::to_string(v < 0 ? -v : v), o;
  for (size_t i = 0; i < s.size(); i++) { if (i && (s.size() - i) % 3 == 0) o += ','; o += s[i]; }
  return (v < 0 ? "-" : "") + o;
}

std::vector<std::string> wrap(const Ui& ui, const std::string& s, float size, UiFont f, float maxW, float tracking) {
  std::vector<std::string> out;
  std::string line, word;
  auto flushWord = [&]() {
    if (word.empty()) return;
    std::string cand = line.empty() ? word : line + " " + word;
    if (!line.empty() && ui.textWidth(cand, size, f, tracking) > maxW) { out.push_back(line); line = word; } else line = cand;
    word.clear();
  };
  for (size_t i = 0; i <= s.size(); i++) {
    char ch = i < s.size() ? s[i] : ' ';
    if (ch == '\n') { flushWord(); out.push_back(line); line.clear(); continue; }
    if (ch != ' ') { word += ch; continue; }
    flushWord();
  }
  if (!line.empty()) out.push_back(line);
  return out;
}

std::string ellipsis(const Ui& ui, const std::string& s, float size, UiFont f, float maxW, float tracking) {
  if (ui.textWidth(s, size, f, tracking) <= maxW) return s;
  std::vector<uint32_t> cps = utf8Decode(s);
  auto enc = [](const std::vector<uint32_t>& v, size_t n) {
    std::string o;
    for (size_t i = 0; i < n && i < v.size(); i++) {
      uint32_t c = v[i];
      if (c < 0x80) o += char(c);
      else if (c < 0x800) { o += char(0xC0 | (c >> 6)); o += char(0x80 | (c & 63)); }
      else if (c < 0x10000) { o += char(0xE0 | (c >> 12)); o += char(0x80 | ((c >> 6) & 63)); o += char(0x80 | (c & 63)); }
      else { o += char(0xF0 | (c >> 18)); o += char(0x80 | ((c >> 12) & 63)); o += char(0x80 | ((c >> 6) & 63)); o += char(0x80 | (c & 63)); }
    }
    return o;
  };
  for (size_t n = cps.size(); n > 0; n--) {
    std::string t = enc(cps, n);
    while (!t.empty() && t.back() == ' ') t.pop_back();
    t += "\xE2\x80\xA6";
    if (ui.textWidth(t, size, f, tracking) <= maxW) return t;
  }
  return "\xE2\x80\xA6";
}

void paper(Ui& ui, float x, float y, float w, float h, int seed, float amp, float side, float u, const vec4& c, bool shadow) {
  Ui::Shadow sh{0, 6 * u, 14 * u, hex(0x00143c, 0.28f)};
  ui.brushClip(x, y, w, h, c, seed, amp, side, u, shadow ? &sh : nullptr);
}

namespace {
struct BtnPad { float l, r; };
BtnPad btnPad(float h, float u) {
  // .brush-btn (82u: 46 / 66), .big (100u: 46 / 80), .mid (74u: 40 / 60), .small (62u: 38 / 50)
  if (h > 95 * u) return {46 * u, 80 * u};
  if (h < 64 * u) return {38 * u, 50 * u};
  if (h < 78 * u) return {40 * u, 60 * u};
  return {46 * u, 66 * u};
}
} // namespace

float brushButtonWidth(Ui& ui, float minW, float h, float fs, const std::string& label, float u, const std::string& cap) {
  BtnPad p = btnPad(h, u);
  float w = p.l + ui.textWidth(label, fs, UiFont::CondItalic, 0.06f) + p.r;
  if (!cap.empty()) w += 14 * u + ui.kcWidth(u, cap);
  return std::max(minW, w);
}

float brushButton(Ui& ui, float x, float y, float minW, float h, float fs, const std::string& label, int seed, bool foc, float u, const std::string& cap, float alpha,
                  const vec4& fill, const vec4& inkIn) {
  BtnPad p = btnPad(h, u);
  float w = brushButtonWidth(ui, minW, h, fs, label, u, cap);
  const vec4 ink = inkIn.x < 0 ? blue : inkIn;
  ui.pushAlpha(alpha);
  if (foc) { ui.pushTranslate(14 * u, 0); ui.pushRotate(x + w / 2, y + h / 2, -3.14159265f / 180.f); ui.rect(x - 16 * u, y + h * 0.3f, 6 * u, h * 0.4f, red); }
  Ui::Shadow sh{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
  ui.brushStroke(x, y, w * (foc ? 1.05f : 1.f), h, fill, seed, 420, 96, &sh);
  float tx = x + p.l;
  tx += ui.textLH(tx, y, h, fs, UiFont::CondItalic, ink, label, UiAlign::Left, 0.06f);
  if (!cap.empty()) ui.kc(tx + 14 * u - fs * 0.06f, y + (h - ui.kcHeight(u)) / 2, u, cap, ink, vec4(0), vec4(ink.x, ink.y, ink.z, 0.45f));
  if (foc) { ui.popTransform(); ui.popTransform(); }
  ui.popAlpha();
  return w;
}

void medal(Ui& ui, float x, float y, float m, int kind, bool number) {
  const float R = m / 2, cx = x + R, cy = y + m * 1.22f - R;
  if (kind < 1 || kind > 3) {
    // .medal.none: a dashed ring
    float lw = std::max(1.5f * ui.dpr(), m * 0.06f);
    const int N = 14;
    for (int i = 0; i < N; i++) {
      float a0 = float(i) / N * 6.2831853f, a1 = a0 + 6.2831853f / N * 0.55f;
      ui.arc(cx, cy, R - lw / 2, a0, a1, lw, hex(0x1546c8, 0.32f));
    }
    return;
  }
  // the ribbon: left 17% .. 83%, the top 46% of the box; blue | red halves, a V cut into the top
  {
    float rx = x + m * 0.17f, rw = m * 0.66f, rh = m * 1.22f * 0.46f;
    auto P = [&](float fx, float fy) { return vec2(rx + rw * fx, y + rh * fy); };
    ui.polyAA({P(0, 0), P(0.34f, 0), P(0.5f, 0.44f), P(0.5f, 1), P(0.3f, 1)}, blue);
    ui.polyAA({P(0.5f, 0.44f), P(0.66f, 0), P(1, 0), P(0.7f, 1), P(0.5f, 1)}, red);
  }
  static const uint32_t G[3][4] = {{0xfff7d1, 0xffd75e, 0xe8a915, 0xb97c06}, {0xffffff, 0xe6ebf2, 0xaab4c2, 0x77818f}, {0xffe6cc, 0xe9a56b, 0xbb6c33, 0x84431a}};
  static const float ST[3][4] = {{0, 0.26f, 0.6f, 1}, {0, 0.28f, 0.64f, 1}, {0, 0.28f, 0.64f, 1}};
  const uint32_t* g = G[kind - 1];
  const float* st = ST[kind - 1];
  ui.boxShadow(cx - R, cy - R, m, m, R, 0, m * 0.06f, m * 0.14f, hex(0x00143c, 0.35f));
  // radial-gradient(circle at 34% 28%): rings shrinking toward the highlight (the gradient's radius: to the far corner)
  const vec2 focus(x + m * 0.34f, cy - R + m * 0.28f);
  const float far = std::hypot(m * 0.66f, m * 0.72f);
  const int N = 18;
  for (int i = 0; i < N; i++) {
    float t = 1 - float(i) / N;                       // 1 (the rim) .. towards 0 (the highlight)
    vec2 c = focus + (vec2(cx, cy) - focus) * t;
    float r = R * t;
    float gr = std::min(1.f, (glm::length(c - focus) + r) / far);   // the gradient position of this ring's far edge
    int k = gr <= st[1] ? 0 : gr <= st[2] ? 1 : 2;
    float f = (gr - st[k]) / std::max(1e-4f, st[k + 1] - st[k]);
    vec4 c0 = hex(g[k]), c1 = hex(g[k + 1]);
    ui.circle(c.x, c.y, std::max(r, 0.5f), c0 + (c1 - c0) * std::clamp(f, 0.f, 1.f));
  }
  ui.ring(cx, cy, R, m * 0.07f, kind == 1 ? hex(0xfff4c8, 0.55f) : hex(0xffffff, 0.55f));
  if (number) {
    static const uint32_t ink[3] = {0x784800, 0x3c4658, 0x602a0a};
    static const float ia[3] = {0.78f, 0.72f, 0.75f};
    float fs = m * 0.5f;
    std::string n = std::to_string(kind);
    ui.text(cx, cy - ui.lineHeight(fs, UiFont::CondItalic) / 2 + ui.dpr(), fs, UiFont::CondItalic, a(white, 0.6f), n, UiAlign::Center);
    ui.text(cx, cy - ui.lineHeight(fs, UiFont::CondItalic) / 2, fs, UiFont::CondItalic, hex(ink[kind - 1], ia[kind - 1]), n, UiAlign::Center);
  }
}

float hints(Ui& ui, float x, float y, float u, const std::vector<Hint>& hs, const vec4& col, const vec4& border, float maxX) {
  const float d = ui.dpr(), fs = std::max(11 * d, 11 * u), kh = ui.kcHeight(u), gap = std::max(4 * d, 6 * u);
  const vec4 shc = a(hex(0x000000), 0.5f);
  for (const Hint& h : hs) {
    float w = ui.textWidth(h.label, fs, UiFont::BodySemi, 0.1f);
    for (const std::string& c : h.caps) w += ui.kcWidth(u, c) + gap;
    if (x + w > maxX) break;
    for (size_t i = 0; i < h.caps.size(); i++) x += ui.kc(x, y, u, h.caps[i], col, vec4(0), border) + (i + 1 < h.caps.size() ? 4 * u : gap);
    float ty = y + (kh - ui.lineHeight(fs, UiFont::BodySemi)) / 2;
    ui.textShadow(x, ty, fs, UiFont::BodySemi, h.label, UiAlign::Left, 0.1f, 0, d, 6 * d, shc);
    x += ui.text(x, ty, fs, UiFont::BodySemi, col, h.label, UiAlign::Left, 0.1f) + 22 * u;
  }
  return x;
}

} // namespace sl::uiw
