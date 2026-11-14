#include "game/transition.h"
#include "core/assets_path.h"
#include "engine/asset_manager.h"
#include "platform/platform.h"
#include <algorithm>
#include <cmath>
#include <vector>

namespace sl {

namespace {
// transition.js
constexpr int STROKES = 6;
constexpr double COVER_S = 0.72;    // 6 strokes x 45 ms stagger + 420 ms travel, then the card has settled
constexpr double MIN_S = 0.65;      // the card stays at least this long
constexpr double REVEAL_S = 0.82;   // card out, 140 ms pause, strokes leave (stagger + travel)
constexpr double FADE_S = 0.34;
constexpr double FADE_HOLD_S = 0.22;   // dark, the logo up (the web game streams the new place meanwhile)
constexpr float PI_F = 3.14159265f;

// CSS cubic-bezier(x1, y1, x2, y2) at time x (Newton on the x polynomial, as browsers do)
float bezier(float x1, float y1, float x2, float y2, float x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  auto B = [](float a, float b, float t) { float u = 1 - t; return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t; };
  auto dB = [](float a, float b, float t) { float u = 1 - t; return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b); };
  float t = x;
  for (int i = 0; i < 8; i++) {
    float e = B(x1, x2, t) - x, d = dB(x1, x2, t);
    if (std::fabs(e) < 1e-5f || std::fabs(d) < 1e-6f) break;
    t = std::clamp(t - e / d, 0.f, 1.f);
  }
  return B(y1, y2, t);
}
float ease(float x) { return bezier(0.25f, 0.1f, 0.25f, 1.f, x); }   // CSS "ease"
// progress of a CSS transition: starts `delay` s in, lasts `dur` s
float prog(double t, double delay, double dur) { return float(std::clamp((t - delay) / dur, 0.0, 1.0)); }

std::string upper(const std::string& s) {
  std::string o = s;
  for (char& c : o) if (c >= 'a' && c <= 'z') c = char(c - 32);   // (ASCII; accented letters keep their case)
  return o;
}
} // namespace

void Transition::init(gfx::Device& dev, platform::Platform& plat, const AssetPaths& paths) {
  // the round logo (public/ui/logo.webp; CSS border-radius: 50% -> an anti-aliased circle cut into its alpha)
  std::vector<uint8_t> file, rgba;
  int w = 0, h = 0;
  if (!plat.readFile(paths.publicRoot + "/ui/logo.webp", file) || !decodeImageRGBA(file, w, h, rgba) || w < 2 || h < 2) return;
  float cx = float(w) * 0.5f, cy = float(h) * 0.5f, r = std::min(cx, cy);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      float d = std::hypot(float(x) + 0.5f - cx, float(y) + 0.5f - cy);
      uint8_t& a = rgba[(size_t(y) * size_t(w) + size_t(x)) * 4 + 3];
      a = uint8_t(float(a) * std::clamp(r - d, 0.f, 1.f));
    }
  gfx::TextureDesc d;
  d.width = w; d.height = h;
  d.format = gfx::TexFormat::RGBA8;
  d.filter = gfx::Filter::Trilinear;
  d.wrap = gfx::Wrap::Clamp;
  d.mipmaps = true;
  logo_ = dev.createTexture(d, rgba.data());
}

double Transition::coverTime() const { return kind_ == Kind::Teleport ? COVER_S : FADE_S; }
double Transition::holdTime() const { return kind_ == Kind::Teleport ? MIN_S : FADE_HOLD_S; }
double Transition::total() const { return coverTime() + holdTime() + (kind_ == Kind::Teleport ? REVEAL_S : FADE_S + 0.04); }

void Transition::fade() {
  if (kind_ == Kind::Teleport) return;   // (a title card is up: it covers this move too)
  if (kind_ == Kind::Fade) {
    // already dipping: once dark, stay dark for this move too (a room entered, then the place outside)
    if (t_ >= FADE_S) t_ = FADE_S;
    return;
  }
  kind_ = Kind::Fade;
  t_ = 0;
}

void Transition::teleport(const std::string& label) {
  // 'KICKER · Title' (or '|'): the kicker is the part before the first separator
  kicker_.clear();
  title_ = label;
  for (const char* sep : {" \xC2\xB7 ", " | "}) {
    size_t p = label.find(sep);
    if (p != std::string::npos) { kicker_ = label.substr(0, p); title_ = label.substr(p + std::string(sep).size()); break; }
  }
  if (kind_ == Kind::Teleport && t_ >= COVER_S) { t_ = COVER_S; return; }   // (covered already: the card changes)
  kind_ = Kind::Teleport;
  t_ = 0;
}

void Transition::update(double dt) {
  if (kind_ == Kind::None) return;
  t_ += std::min(dt, 0.05);   // (a long frame while the new place loads does not skip the reveal)
  if (t_ >= total()) { kind_ = Kind::None; t_ = 0; }
}

void Transition::draw(Ui& ui) {
  if (kind_ == Kind::None) return;
  const float W = float(ui.width()), H = float(ui.height()), u = ui.cssU(), dpr = ui.dpr();
  const double t = t_;

  if (kind_ == Kind::Fade) {
    // .tr-fade: opacity 0.34 s ease, both ways; .tr-load (logo + circle): 0.25 s ease, 0.18 s after the dip starts
    const double out = FADE_S + FADE_HOLD_S;
    float dark = t < out ? ease(prog(t, 0, FADE_S)) : 1 - ease(prog(t, out, FADE_S));
    ui.rect(0, 0, W, H, vec4(0.0196f, 0.0431f, 0.0863f, dark));   // #050b16
    float load = t < out ? ease(prog(t, 0.18, 0.25)) : (1 - ease(prog(t, out, 0.25))) * ease(prog(out, 0.18, 0.25));
    if (load > 0.003f) {
      ui.pushAlpha(load);
      // a column, centred: the logo min(420u, 46vh), a 40u gap, the 40u circle
      float ls = std::min(420 * u, 0.46f * H), gap = 40 * u, ss = 40 * u;
      float top = (H - (ls + gap + ss)) * 0.5f, cx = W * 0.5f;
      if (logo_) ui.image(logo_, std::round(cx - ls * 0.5f), std::round(top), ls, ls);
      // .tr-spin: a ring rgba(255, 255, 255, .22), its top quarter white, one turn in 0.9 s
      float r = ss * 0.5f, bw = std::max(2.f * dpr, 3 * u), cy = top + ls + gap + r;
      ui.ring(cx, cy, r, bw, vec4(1, 1, 1, 0.22f));
      float a0 = float(std::fmod(t / 0.9, 1.0)) * 2 * PI_F - 0.75f * PI_F;   // (border-top: -135 deg .. -45 deg)
      std::vector<vec2> arc;
      const int N = 14;
      for (int i = 0; i <= N; i++) {
        float a = a0 + 0.5f * PI_F * float(i) / N;
        arc.push_back(vec2(cx + std::cos(a) * (r - bw * 0.5f), cy + std::sin(a) * (r - bw * 0.5f)));
      }
      ui.polyline(arc, bw, vec4(1, 1, 1, 1));
      ui.popAlpha();
    }
    return;
  }

  // ---- the title card
  const double rv = COVER_S + MIN_S;   // the reveal starts
  const bool reveal = t >= rv;
  // .tr-stroke: left -16vw, width 132vw, top i * 100 / 6 - 2.5 %, height 100 / 6 + 5 %; translateX(-112 %) -> 0 over
  // 0.42 s cubic-bezier(.65, 0, .25, 1), 45 ms apart; leaving: -> +112 %, 140 ms later
  for (int i = 0; i < STROKES; i++) {
    float sw = 1.32f * W, sh = (100.f / STROKES + 5) * 0.01f * H, sy = (float(i) * 100.f / STROKES - 2.5f) * 0.01f * H;
    float k = reveal ? 1.12f * bezier(0.65f, 0, 0.25f, 1, prog(t, rv + 0.14 + i * 0.045, 0.42))
                     : -1.12f * (1 - bezier(0.65f, 0, 0.25f, 1, prog(t, i * 0.045, 0.42)));
    float sx = -0.16f * W + k * sw;
    if (sx > W || sx + sw < 0) continue;
    ui.brushStroke(std::round(sx), std::round(sy), std::round(sw), std::round(sh), ui_color::white, 500 + i * 7, 1600, 200);
  }
  // .tr-solid: white, in over 0.2 s once the strokes are across (0.42 s), out over 0.2 s at once
  float solid = reveal ? 1 - ease(prog(t, rv, 0.2)) : ease(prog(t, 0.42, 0.2));
  if (solid > 0.003f) ui.rect(0, 0, W, H, vec4(1, 1, 1, solid));
  // .tr-card: opacity 0.3 s ease and a 24u slide (0.5 s cubic-bezier(.2, .9, .2, 1)), 0.4 s in; out in 0.18 s to the right
  float cardA = reveal ? 1 - ease(prog(t, rv, 0.18)) : ease(prog(t, 0.4, 0.3));
  float cardX = reveal ? 24 * u * bezier(0.2f, 0.9f, 0.2f, 1, prog(t, rv, 0.18)) : -24 * u * (1 - bezier(0.2f, 0.9f, 0.2f, 1, prog(t, 0.4, 0.5)));
  if (cardA > 0.003f) {
    ui.pushAlpha(cardA);
    const std::string title = upper(title_);
    // .tr-kicker 800 max(12px, 16u) / 1, letter-spacing .32em, red; .tr-title italic 700 120u / 0.95 (long: 92u),
    // letter-spacing .02em, 12u under the kicker; .tr-bar 220u x max(3px, 5u), 28u under the title, skewX(-20deg)
    float ks = std::max(12.f * dpr, 16 * u), ts = (utf8Decode(title_).size() > 14 ? 92.f : 120.f) * u;
    float maxW = W - 120 * u;
    float tw = ui.textWidth(title, ts, UiFont::CondItalic, 0.02f);
    if (tw > maxW) ts *= maxW / tw;   // (never wider than the card's padding box)
    float kh = kicker_.empty() ? 0 : ks, th = ts * 0.95f, bh = std::max(3.f * dpr, 5 * u);
    float colH = kh + 12 * u + th + 28 * u + bh, y = (H - colH) * 0.5f, cx = W * 0.5f + cardX;
    if (!kicker_.empty()) {
      // (the trailing letter-spacing is part of the centred box, as in the browser)
      ui.textLH(cx, y, ks, ks, UiFont::BodyHeavy, ui_color::red, kicker_, UiAlign::Center, 0.32f);
    }
    y += kh + 12 * u;
    ui.textLH(cx, y, th, ts, UiFont::CondItalic, ui_color::blue, title, UiAlign::Center, 0.02f);
    y += th + 28 * u;
    float bw = 220 * u, bx = cx - bw * 0.5f, sk = std::tan(20.f * PI_F / 180.f) * bh * 0.5f;
    auto slab = [&](float x0, float x1, const vec4& c) {
      ui.poly({vec2(x0 + sk, y), vec2(x1 + sk, y), vec2(x1 - sk, y + bh), vec2(x0 - sk, y + bh)}, c);
    };
    slab(bx, bx + bw, ui_color::bluePale);
    // .tr-bar i: 40 % wide, translateX(-100 % -> 250 %) every 1.1 s, cubic-bezier(.6, 0, .4, 1), clipped by the bar
    float p = bezier(0.6f, 0, 0.4f, 1, float(std::fmod(t, 1.1) / 1.1)), iw = 0.4f * bw, ix = bx + (-1 + 3.5f * p) * iw;
    float x0 = std::max(bx, ix), x1 = std::min(bx + bw, ix + iw);
    if (x1 > x0) slab(x0, x1, ui_color::blue);
    ui.popAlpha();
  }
  // .tr-mark (bottom right, 56u / 40u in): SKI (0.55em, letter-spacing .4em) LEGACY, Barlow 700 28u, blue at 50 %
  float mark = reveal ? 1 - ease(prog(t, rv, 0.3)) : ease(prog(t, 0.45, 0.3));
  if (mark > 0.003f) {
    float fs = 28 * u, ss = fs * 0.55f;
    vec4 c = ui_color::a(ui_color::blue, 0.5f * mark);
    float lw = ui.textWidth("LEGACY", fs, UiFont::CondBold), sw = ui.textWidth("SKI", ss, UiFont::CondBold, 0.4f);
    float right = W - 56 * u, lh = ui.lineHeight(fs, UiFont::CondBold), top = H - 40 * u - lh;
    ui.text(right - lw, top, fs, UiFont::CondBold, c, "LEGACY");
    // (baseline-aligned with LEGACY)
    float base = top + (lh - (ui.ascent(UiFont::CondBold) - ui.descent(UiFont::CondBold)) * fs) * 0.5f + ui.ascent(UiFont::CondBold) * fs;
    float slh = ui.lineHeight(ss, UiFont::CondBold);
    float stop = base - ui.ascent(UiFont::CondBold) * ss - (slh - (ui.ascent(UiFont::CondBold) - ui.descent(UiFont::CondBold)) * ss) * 0.5f;
    ui.text(right - lw - 8 * u - sw, stop, ss, UiFont::CondBold, c, "SKI", UiAlign::Left, 0.4f);
  }
}

} // namespace sl
