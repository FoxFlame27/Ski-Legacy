#include "game/intro.h"

#include "core/assets_path.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/audio.h"
#include "engine/ui.h"
#include "gfx/gfx.h"
#include "platform/platform.h"

#include <nlohmann/json.hpp>
#include <stb_image_write.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <vector>

namespace sl {
namespace {

constexpr float PI_F = 3.14159265358979f;
constexpr double PI_D = 3.14159265358979323846;

// ---------------------------------------------------------------- the timeline (intro.js, studioident.js, style.css)
constexpr double CLIP_S = 4.25;          // introclip.js CLIP_MS: the hold ends, the scene fades out
constexpr double CLIP_OUT_S = 0.5;       // .scene-clip.timed: introOut 0.5 s ease
constexpr double STUDIO_AT = CLIP_S + 0.5;   // the ident's first frame (--in, --sd-at)
constexpr double STUDIO_IN_S = 0.35;     // .scene-studio.timed: introIn 0.35 s ease
constexpr double STUDIO_S = 2.35;        // studioident.js STUDIO_MS
constexpr double STUDIO_LEAVE_S = 0.55;  // STUDIO_LEAVE_MS
constexpr float STUDIO_HIT_S = 0.95f;    // STUDIO_HIT_S: the freeze hit (the sound's)
constexpr double DONE_S = 0.5;           // #intro.done: opacity 0.5 s (cut after 0.25 s when skipped)

double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
double lerp(double a, double b, double t) { return a + (b - a) * t; }
double sstep(double a, double b, double x) { double t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
double outCubic(double u) { double v = 1 - u; return 1 - v * v * v; }
double inOutCubic(double u) { return u < 0.5 ? 4 * u * u * u : 1 - std::pow(-2 * u + 2, 3) / 2; }

// CSS cubic-bezier(x1, y1, x2, y2) at time x
double bezier(double x1, double y1, double x2, double y2, double x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  auto B = [](double a, double b, double t) { double u = 1 - t; return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t; };
  double lo = 0, hi = 1, t = x;
  for (int i = 0; i < 40; i++) {
    t = (lo + hi) * 0.5;
    if (B(x1, x2, t) < x) lo = t; else hi = t;
  }
  return B(y1, y2, t);
}
double ease(double x) { return bezier(0.25, 0.1, 0.25, 1, x); }
double easeOut(double x) { return bezier(0, 0, 0.58, 1, x); }
double easeInOut(double x) { return bezier(0.42, 0, 0.58, 1, x); }

// The letter-spacing that makes the Ui's run of `s` as wide as the browser lays it out (em, the trailing space
// included): Inter's advances differ by a few hundredths of an em from Chrome's at these sizes and weights.
float fitTracking(const Ui& ui, const std::string& s, UiFont f, float tracking, float targetEm) {
  size_t n = utf8Decode(s).size();
  return n ? tracking + (targetEm - ui.textWidth(s, 100, f, tracking) / 100) / float(n) : tracking;
}

// a 2D affine transform, composed as the canvas does (translate / rotate / scale multiply on the right)
struct M2 {
  float a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
  vec2 at(float x, float y) const { return vec2(a * x + c * y + e, b * x + d * y + f); }
  M2 mul(const M2& o) const { return M2{a * o.a + c * o.b, b * o.a + d * o.b, a * o.c + c * o.d, b * o.c + d * o.d, a * o.e + c * o.f + e, b * o.e + d * o.f + f}; }
  M2 translate(float x, float y) const { return mul(M2{1, 0, 0, 1, x, y}); }
  M2 rotate(float r) const { float cs = std::cos(r), sn = std::sin(r); return mul(M2{cs, sn, -sn, cs, 0, 0}); }
  M2 scale(float sx, float sy) const { return mul(M2{sx, 0, 0, sy, 0, 0}); }
  M2 inverse() const {
    float det = a * d - b * c, k = std::fabs(det) > 1e-12f ? 1 / det : 0;
    M2 r{d * k, -b * k, -c * k, a * k, 0, 0};
    r.e = -(r.a * e + r.c * f); r.f = -(r.b * e + r.d * f);
    return r;
  }
};

struct Tex { gfx::Texture t; int w = 0, h = 0; };
struct Circle { vec2 c{0}; float r = 0; };

// premultiplied RGBA8 -> a texture (trilinear, clamped)
Tex makeTexture(gfx::Device& dev, int w, int h, const std::vector<uint8_t>& rgba, bool mips = true) {
  gfx::TextureDesc d;
  d.width = w; d.height = h;
  d.format = gfx::TexFormat::RGBA8;
  d.filter = mips ? gfx::Filter::Trilinear : gfx::Filter::Linear;
  d.wrap = gfx::Wrap::Clamp;
  d.mipmaps = mips;
  d.anisotropy = 1;
  return Tex{dev.createTexture(d, rgba.data()), w, h};
}
void premultiply(std::vector<uint8_t>& px) {
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    unsigned a = px[i + 3];
    px[i] = uint8_t((px[i] * a + 127) / 255); px[i + 1] = uint8_t((px[i + 1] * a + 127) / 255); px[i + 2] = uint8_t((px[i + 2] * a + 127) / 255);
  }
}

// ---------------------------------------------------------------- shared drawing (drawable px)
struct Painter {
  Ui& ui;
  int W = 1, H = 1;
  std::vector<UiVertex> tmp;

  // a convex polygon with a texture (premultiplied), cut to a circle when one is given (the canvas clip)
  void convex(const Tex& t, std::vector<UiVertex> p, const Circle* clip) {
    if (p.size() < 3) return;
    if (clip) {
      bool inside = true;
      for (auto& v : p) if (glm::length(v.pos - clip->c) > clip->r) { inside = false; break; }
      if (!inside) {
        const int N = 160;
        std::vector<UiVertex> q;
        for (int i = 0; i < N && p.size() >= 3; i++) {
          float an = 2 * PI_F * float(i) / N;
          vec2 n(std::cos(an), std::sin(an));
          q.clear();
          for (size_t k = 0; k < p.size(); k++) {
            const UiVertex& A = p[k], &B = p[(k + 1) % p.size()];
            float da = glm::dot(A.pos - clip->c, n) - clip->r, db = glm::dot(B.pos - clip->c, n) - clip->r;
            if (da <= 0) q.push_back(A);
            if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
              float u = da / (da - db);
              q.push_back(UiVertex{A.pos + (B.pos - A.pos) * u, A.uv + (B.uv - A.uv) * u, A.col + (B.col - A.col) * u});
            }
          }
          p.swap(q);
        }
        if (p.size() < 3) return;
      }
    }
    tmp.clear();
    for (size_t k = 1; k + 1 < p.size(); k++) { tmp.push_back(p[0]); tmp.push_back(p[k]); tmp.push_back(p[k + 1]); }
    ui.mesh(t.t, tmp.data(), tmp.size(), true);
  }
  // ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) under the transform m, globalAlpha alpha
  void image(const Tex& t, float sx, float sy, float sw, float sh, float dx, float dy, float dw, float dh, const M2& m, float alpha, const Circle* clip = nullptr) {
    if (!t.t || alpha <= 0.0004f) return;
    float u0 = sx / float(t.w), v0 = sy / float(t.h), u1 = (sx + sw) / float(t.w), v1 = (sy + sh) / float(t.h);
    vec4 c(1, 1, 1, alpha);
    convex(t, {UiVertex{m.at(dx, dy), vec2(u0, v0), c}, UiVertex{m.at(dx + dw, dy), vec2(u1, v0), c}, UiVertex{m.at(dx + dw, dy + dh), vec2(u1, v1), c},
               UiVertex{m.at(dx, dy + dh), vec2(u0, v1), c}}, clip);
  }
  void whole(const Tex& t, float dx, float dy, float dw, float dh, const M2& m, float alpha) { image(t, 0, 0, float(t.w), float(t.h), dx, dy, dw, dh, m, alpha); }
  // a disc filled with a texture laid out by toUv (drawable px -> uv), anti-aliased rim; the whole screen when the
  // disc covers it
  void disc(const Tex& t, const M2& toUv, float alpha, const Circle& k) {
    if (!t.t || alpha <= 0.0004f || k.r <= 0) return;
    vec4 c(1, 1, 1, alpha), c0(1, 1, 1, 0);
    auto V = [&](vec2 p, const vec4& col) { return UiVertex{p, toUv.at(p.x, p.y), col}; };
    const vec2 corners[4] = {vec2(0, 0), vec2(float(W), 0), vec2(float(W), float(H)), vec2(0, float(H))};
    bool covers = true;
    for (const vec2& q : corners) if (glm::length(q - k.c) > k.r - 1) covers = false;
    tmp.clear();
    if (covers) {
      for (int i : {0, 1, 2, 0, 2, 3}) tmp.push_back(V(corners[i], c));
    } else {
      const int N = 256;
      float ri = std::max(0.f, k.r - 0.5f), ro = k.r + 0.5f;
      for (int i = 0; i < N; i++) {
        float a0 = 2 * PI_F * float(i) / N, a1 = 2 * PI_F * float(i + 1) / N;
        vec2 d0(std::cos(a0), std::sin(a0)), d1(std::cos(a1), std::sin(a1));
        UiVertex ctr = V(k.c, c), i0 = V(k.c + d0 * ri, c), i1 = V(k.c + d1 * ri, c), o0 = V(k.c + d0 * ro, c0), o1 = V(k.c + d1 * ro, c0);
        tmp.insert(tmp.end(), {ctr, i0, i1, i0, o0, o1, i0, o1, i1});
      }
    }
    ui.mesh(t.t, tmp.data(), tmp.size(), true);
  }
  // a radial gradient of one colour: alpha by radius (stops: radius, alpha), nothing inside the first stop
  void radial(vec2 ctr, const std::vector<std::pair<float, float>>& stops, const vec3& rgb, float alpha, float sy = 1) {
    if (alpha <= 0.0004f || stops.size() < 2) return;
    const int N = 96;
    tmp.clear();
    for (size_t s = 0; s + 1 < stops.size(); s++) {
      float r0 = stops[s].first, r1 = stops[s + 1].first;
      vec4 c0(rgb, stops[s].second * alpha), c1(rgb, stops[s + 1].second * alpha);
      for (int i = 0; i < N; i++) {
        float a0 = 2 * PI_F * float(i) / N, a1 = 2 * PI_F * float(i + 1) / N;
        vec2 d0(std::cos(a0), std::sin(a0) * sy), d1(std::cos(a1), std::sin(a1) * sy);
        UiVertex p00{ctr + d0 * r0, vec2(0), c0}, p01{ctr + d1 * r0, vec2(0), c0}, p10{ctr + d0 * r1, vec2(0), c1}, p11{ctr + d1 * r1, vec2(0), c1};
        if (r0 > 0) tmp.insert(tmp.end(), {p00, p10, p11, p00, p11, p01});
        else tmp.insert(tmp.end(), {p00, p10, p11});
      }
    }
    ui.mesh(gfx::Texture{}, tmp.data(), tmp.size());
  }
  // a stroked line with round caps (ctx.lineCap = 'round')
  void capsule(vec2 a, vec2 b, float w, const vec4& col) {
    if (col.w <= 0.0004f) return;
    vec2 d = b - a;
    float len = glm::length(d);
    ui.pushRotate(a.x, a.y, len > 1e-5f ? std::atan2(d.y, d.x) : 0.f);
    ui.roundRect(a.x - w * 0.5f, a.y - w * 0.5f, len + w, w, w * 0.5f, col);
    ui.popTransform();
  }
  // a closed stroked path (anti-aliased)
  void strokeLoop(const std::vector<vec2>& pts, float w, const vec4& col) {
    size_t n = pts.size();
    if (n < 3 || col.w <= 0.0004f) return;
    vec4 c0(col.x, col.y, col.z, 0);
    float hw = std::max(0.f, w * 0.5f - 0.5f), ho = w * 0.5f + 0.5f;
    auto nrm = [&](size_t i) { vec2 t = pts[(i + 1) % n] - pts[(i + n - 1) % n]; float l = glm::length(t); return l > 1e-6f ? vec2(-t.y, t.x) / l : vec2(0, 1); };
    tmp.clear();
    for (size_t i = 0; i < n; i++) {
      size_t j = (i + 1) % n;
      vec2 n0 = nrm(i), n1 = nrm(j);
      const float off[4] = {-ho, -hw, hw, ho};
      const vec4* cols[4] = {&c0, &col, &col, &c0};
      for (int s = 0; s < 3; s++) {
        UiVertex a{pts[i] + n0 * off[s], vec2(0), *cols[s]}, b{pts[j] + n1 * off[s], vec2(0), *cols[s]};
        UiVertex c{pts[i] + n0 * off[s + 1], vec2(0), *cols[s + 1]}, d{pts[j] + n1 * off[s + 1], vec2(0), *cols[s + 1]};
        tmp.insert(tmp.end(), {a, b, d, a, d, c});
      }
    }
    ui.mesh(gfx::Texture{}, tmp.data(), tmp.size());
  }
};

// ================================================================= the logo clip (introclip.js clipEngine)
class Clip {
public:
  Clip(gfx::Device& dev, Ui& ui) : dev_(dev), ui_(ui), pt_{ui} {}
  ~Clip() {
    for (Tex* t : {&bg_, &backdrop_, &skier_, &ski_, &legacy_, &puff_, &vig_, &glow_}) if (t->t) dev_.destroy(t->t);
    if (acc_) dev_.destroy(acc_);
  }

  bool load(platform::Platform& plat, const AssetPaths& paths) {
    const std::string base = paths.publicRoot + "/intro/clip/";
    std::vector<uint8_t> file;
    if (!plat.readFile(base + "clip.json", file)) return false;
    auto j = nlohmann::json::parse(file.begin(), file.end(), nullptr, false);
    if (j.is_discarded() || !j.contains("circle") || !j.contains("skier") || !j.contains("ski") || !j.contains("legacy")) return false;
    L.size = j.value("size", 1254.0); L.scale = j.value("scale", 2.0);
    L.ccx = j["circle"].value("cx", 0.0); L.ccy = j["circle"].value("cy", 0.0); L.cr = j["circle"].value("r", 1.0);
    auto rect = [](const nlohmann::json& o, double* r) { r[0] = o.value("x", 0.0); r[1] = o.value("y", 0.0); r[2] = o.value("w", 1.0); r[3] = o.value("h", 1.0); };
    rect(j["skier"], L.skier); L.px = j["skier"].value("px", 0.0); L.py = j["skier"].value("py", 0.0);
    rect(j["ski"], L.ski);
    rect(j["legacy"], L.legacy);
    if (j["legacy"].contains("letters")) for (auto& l : j["legacy"]["letters"]) if (l.is_array() && l.size() >= 2) L.letters.push_back({l[0].get<double>(), l[1].get<double>()});
    if (j["legacy"].contains("rule")) rect(j["legacy"]["rule"], L.rule);
    if (j.contains("sun") && j["sun"].is_array() && j["sun"].size() >= 2) { L.sun[0] = j["sun"][0].get<double>(); L.sun[1] = j["sun"][1].get<double>(); }
    std::vector<uint8_t> skiPx;
    int skiW = 0, skiH = 0;
    auto tex = [&](const char* name, Tex& out, bool keep) {
      std::vector<uint8_t> f, px;
      int w = 0, h = 0;
      if (!plat.readFile(base + name, f) || !decodeImageRGBA(f, w, h, px) || w < 1 || h < 1) return false;
      premultiply(px);
      out = makeTexture(dev_, w, h, px);
      if (keep) { skiPx.swap(px); skiW = w; skiH = h; }
      return bool(out.t);
    };
    if (!tex("bg.webp", bg_, false) || !tex("backdrop.webp", backdrop_, false) || !tex("skier.webp", skier_, false) || !tex("ski.webp", ski_, true) || !tex("legacy.webp", legacy_, false)) return false;
    initFx(skiPx, skiW, skiH);
    return true;
  }

  /// the cue sounds due by t (whoosh, slam, announce, tick), once each
  template <class F> void cues(double t, F&& play) {
    static const std::pair<double, const char*> C[4] = {{0.02, "whoosh"}, {IMPACT, "slam"}, {IMPACT + 0.3, "announce"}, {LEG0 + 0.04, "tick"}};
    while (cue_ < 4 && t >= C[cue_].first) play(C[cue_++].second);
  }

  /// Draws the clip's frame at t into the window (cleared), leaving the Ui pass open for what goes over it.
  void render(double t, int W, int H, float dpr) {
    if (W != W_ || H != H_ || dpr != dpr_) size(W, H, dpr);
    const St s = state(t);
    const vec2 sh = shake(t);
    // the badge: zoom-blurred while the camera whips back (a running average of exposures)
    const St s1 = state(t - 1.0 / 60);
    double zv = std::fabs(std::log(s.bz / s1.bz)) * 60, pv = std::hypot(s.bx - s1.bx, s.by - s1.by) * s.bz;
    int K = std::max(1, std::min(6, int(std::ceil(zv * 2.2 + pv / 10))));
    bool blur = K == 1 && t < RISE + 0.05;
    if (blur && acc_) {
      // motion blur: N exposures over the shutter, summed premultiplied, composited once
      const int N = 6;
      const double SH = 0.04;
      dev_.bindRenderTarget(acc_, W_, H_);
      dev_.clear(0, 0, 0, 0, true, false);
      ui_.begin(W_, H_);
      ui_.setBlend(UiBlend::Add);
      for (int j = 0; j < N; j++) drawSkier(state(t - (SH * j) / (N - 1)), sh, 1.f / N, nullptr);
      ui_.end();
    }
    dev_.bindRenderTarget({}, W_, H_);
    dev_.clear(0, 0, 0, 1, true, true);
    ui_.begin(W_, H_);
    ui_.setBlend(UiBlend::Premultiplied);
    ui_.rect(0, 0, float(W_), float(H_), ui_color::hex(0x04122b));
    // backdrop (cover, slower zoom, little shake)
    if (s.rm < rBig_ * 0.999) {
      float cover = float(std::max(vw_, vh_) / L.size * (1 + 0.12 * (1 - s.p)) * (1 + 0.012 * sstep(IMPACT, END + 0.6, t)));
      M2 m{cover * dpr_, 0, 0, cover * dpr_, dpr_ * float(vw_ / 2 - L.ccx * cover + sh.x * 0.3), dpr_ * float(vh_ / 2 - L.ccy * cover + sh.y * 0.3)};
      pt_.whole(backdrop_, 0, 0, float(L.size), float(L.size), m, 1);
      // the disc's soft contact shadow
      vec2 o = toScreen(L.ccx, L.ccy, s.bx, s.by, s.bz, sh) * dpr_;
      float r0 = float(s.rm * s.bz) * dpr_, r1 = float((s.rm + 52) * s.bz) * dpr_;
      auto R = [&](float f) { return r0 + (r1 - r0) * f; };
      pt_.radial(o, {{R(0), 0.15f}, {R(0.3f), 0.14f}, {R(0.58f), 0.075f}, {R(0.77f), 0.035f}, {R(1), 0}}, vec3(0), float(sstep(0.55, 1, s.p)));
    }
    if (K == 1) drawScene(t, 1, sh, blur);
    else for (int k = 0; k < K; k++) drawScene(t - (0.03 * (K - 1 - k)) / (K - 1), 1.f / float(k + 1), sh, false);
    drawFx(t, s, sh);
    // cinematic vignette in the opening
    float va = float(0.62 * (1 - sstep(0.2, 0.95, s.p)));
    if (va > 0.002f) pt_.whole(vig_, -float(W_) * 0.12f, -float(H_) * 0.12f, float(W_) * 1.24f, float(H_) * 1.24f, M2{}, va);
    drawText(t, s, sh);
    // fade up from black
    float fa = float(1 - sstep(0, 0.22, t));
    if (fa > 0) ui_.rect(0, 0, float(W_), float(H_), vec4(0, 0, 0, fa));
    ui_.setBlend(UiBlend::Normal);
  }

private:
  // timeline (seconds)
  static constexpr double RISE = 1.45, ZOOM0 = 1.0, ZOOM1 = 1.95, SLAM0 = 1.8, IMPACT = 2.0, LEG0 = 2.22, RULE0 = 2.45, SWEEP0 = 2.32, END = 4.25;
  // skier take-off: offset from the logo pose (world px), tilt (rad), extra scale
  static constexpr double D0X = -210, D0Y = 280, ROT0 = -0.3, SC0 = 0.1;
  static constexpr double ZA0 = 2.25, ZA1 = 2.0;   // opening zoom (x the final framing)

  struct Layout {
    double size = 1254, scale = 2, ccx = 0, ccy = 0, cr = 1;
    double skier[4] = {0, 0, 1, 1}, px = 0, py = 0, ski[4] = {0, 0, 1, 1}, legacy[4] = {0, 0, 1, 1}, rule[4] = {0, 0, 1, 1}, sun[2] = {0, 0};
    std::vector<std::array<double, 2>> letters;
  } L;
  struct St { double u, p, z, cx, cy, dx, dy, rot, sc, bz, bx, by, rm; };
  struct Burst { double x, y, vx, vy, r, t0, life, w; };
  struct Puff { double x, y, vx, vy, r0, r1, life, a; };
  struct Streak { double t0, life, x, y, len, w, a, sp; };
  struct Flake { double x, y, r, a, vx, vy; };
  struct Dust { double x, y, vx, vy, r, life; };

  void size(int W, int H, float dpr) {
    W_ = W; H_ = H; dpr_ = dpr;
    pt_.W = W; pt_.H = H;
    vw_ = W / double(dpr); vh_ = H / double(dpr);
    if (acc_) dev_.destroy(acc_);
    acc_ = dev_.createRenderTarget(W, H, true, gfx::TexFormat::RGBA8, false, gfx::TexFormat::Depth24);
    accTex_ = Tex{acc_ ? dev_.renderTargetColor(acc_) : gfx::Texture{}, W, H};
    if (accTex_.t) dev_.setSampling(accTex_.t, gfx::Filter::Linear, gfx::Wrap::Clamp, 1);
    sF_ = std::min(vh_ * 0.385, vw_ * 0.3) / L.cr;
    // mask radius during the opening: past the farthest corner the opening shot can see
    rBig_ = 0;
    St s = state(ZOOM0);
    rBig_ = 1.12 * std::hypot(vw_ / 2 / s.bz + std::fabs(s.bx - L.ccx), vh_ / 2 / s.bz + std::fabs(s.by - L.ccy));
  }

  // camera + skier pose at time t (world = logo source pixels)
  St state(double t) const {
    double u = clamp01(t / RISE);
    double ex = 1 - (1 - u) * (1 - u), ey = 1 - std::pow(1 - u, 3), er = outCubic(u);
    double dx = D0X * (1 - ex), dy = D0Y * (1 - ey);
    double hold = 1 + 0.025 * sstep(IMPACT, END + 0.6, t);
    double zF = sF_ * hold, zA = sF_ * lerp(ZA0, ZA1, u);
    double ax = L.px + dx * 0.6 + 20, ay = L.py + dy * 0.62 - 25 * (1 - u);
    double p = inOutCubic(std::pow(clamp01((t - ZOOM0) / (ZOOM1 - ZOOM0)), 0.85));
    double z = std::exp(lerp(std::log(zA), std::log(zF), p));
    double cx = lerp(ax, L.ccx, p), cy = lerp(ay, L.ccy, p);
    return St{u, p, z, cx, cy, dx, dy, ROT0 * (1 - er), 1 + SC0 * (1 - er), zF * std::pow(z / zF, 0.9), L.ccx + (cx - L.ccx) * 0.6, L.ccy + (cy - L.ccy) * 0.6,
              lerp(rBig_, L.cr, sstep(0, 0.9, p))};
  }
  static vec2 shake(double t) {
    double x = 0, y = 0;
    double a = 2.4 * (1 - sstep(0.9, 1.9, t));
    x += a * (std::sin(6.28 * 1.7 * t + 1) + 0.6 * std::sin(6.28 * 3.1 * t + 2));
    y += a * (std::sin(6.28 * 1.3 * t + 4) + 0.6 * std::sin(6.28 * 2.7 * t + 5));
    double j = 7 * std::exp(-t / 0.1);
    x += j * std::sin(6.28 * 17 * t); y += j * std::cos(6.28 * 13 * t);
    if (t >= IMPACT) { double k = 11 * std::exp(-(t - IMPACT) / 0.11); x += k * std::sin(6.28 * 24 * (t - IMPACT)); y += k * std::cos(6.28 * 19 * (t - IMPACT)); }
    return vec2(float(x), float(y));
  }
  // world -> drawable px
  M2 plane(double cx, double cy, double z, vec2 sh) const {
    return M2{float(z) * dpr_, 0, 0, float(z) * dpr_, dpr_ * float(vw_ / 2 - cx * z + sh.x), dpr_ * float(vh_ / 2 - cy * z + sh.y)};
  }
  // world -> CSS px
  vec2 toScreen(double x, double y, double cx, double cy, double z, vec2 sh) const { return vec2(float(vw_ / 2 + (x - cx) * z + sh.x), float(vh_ / 2 + (y - cy) * z + sh.y)); }
  M2 css() const { return M2{dpr_, 0, 0, dpr_, 0, 0}; }

  void drawSkier(const St& s, vec2 sh, float alpha, const Circle* clip) {
    float k = float(L.scale);
    M2 m = plane(s.cx, s.cy, s.z, sh).translate(float(L.px + s.dx), float(L.py + s.dy)).rotate(float(s.rot)).scale(float(s.sc), float(s.sc)).translate(float(-L.px), float(-L.py));
    pt_.image(skier_, 0, 0, float(L.skier[2]) * k, float(L.skier[3]) * k, float(L.skier[0]), float(L.skier[1]), float(L.skier[2]), float(L.skier[3]), m, alpha, clip);
  }

  // one exposure of the badge (plate + skier, clipped to the disc) at time t, over what is already drawn
  void drawScene(double t, float alpha, vec2 sh, bool blurSkier) {
    const St s = state(t);
    vec2 o = toScreen(L.ccx, L.ccy, s.bx, s.by, s.bz, sh);
    Circle clip{o * dpr_, float(s.rm * s.bz) * dpr_};
    // the plate over the logo's square (its edge pixels run on outside it: the texture clamps)
    M2 toUv = M2{1 / float(L.size), 0, 0, 1 / float(L.size), 0, 0}.mul(plane(s.bx, s.by, s.bz, sh).inverse());
    pt_.disc(bg_, toUv, alpha, clip);
    if (blurSkier && accTex_.t) pt_.disc(accTex_, M2{1 / float(W_), 0, 0, -1 / float(H_), 0, 1}, alpha, clip);
    else drawSkier(s, sh, alpha, &clip);
  }

  uint64_t seed_ = 11;
  double rnd(double a = 0, double b = 1) { seed_ = (seed_ * 16807) % 2147483647ull; return a + (b - a) * (double(seed_) / 2147483647.0); }

  void initFx(const std::vector<uint8_t>& skiPx, int skiW, int skiH) {
    // soft round sprite
    {
      std::vector<uint8_t> px(64 * 64 * 4);
      for (int y = 0; y < 64; y++) for (int x = 0; x < 64; x++) {
        double d = std::hypot(x + 0.5 - 32, y + 0.5 - 32) / 32;
        double a = d < 0.45 ? lerp(1, 0.45, d / 0.45) : d < 1 ? lerp(0.45, 0, (d - 0.45) / 0.55) : 0;
        uint8_t v = uint8_t(std::lround(a * 255));
        uint8_t* p = &px[size_t(y * 64 + x) * 4];
        p[0] = p[1] = p[2] = p[3] = v;
      }
      puff_ = makeTexture(dev_, 64, 64, px);
    }
    {
      std::vector<uint8_t> px(256 * 256 * 4);
      for (int y = 0; y < 256; y++) for (int x = 0; x < 256; x++) {
        double a = clamp01((std::hypot(x + 0.5 - 128, y + 0.5 - 128) - 60) / (182 - 60));
        uint8_t* p = &px[size_t(y * 256 + x) * 4];
        p[0] = 0; p[1] = uint8_t(std::lround(6 * a)); p[2] = uint8_t(std::lround(18 * a)); p[3] = uint8_t(std::lround(255 * a));
      }
      vig_ = makeTexture(dev_, 256, 256, px, false);
    }
    // pre-blurred SKI (a ninth of its size) for the light sweep's glow
    {
      int gw = std::max(1, int(std::ceil(L.ski[2] / 9))), gh = std::max(1, int(std::ceil(L.ski[3] / 9)));
      std::vector<uint8_t> px(size_t(gw) * size_t(gh) * 4, 0);
      double sw = std::min(double(skiW), L.ski[2] * L.scale), shh = std::min(double(skiH), L.ski[3] * L.scale);
      for (int y = 0; y < gh; y++) for (int x = 0; x < gw; x++) {
        int x0 = int(x * sw / gw), x1 = std::max(x0 + 1, int((x + 1) * sw / gw)), y0 = int(y * shh / gh), y1 = std::max(y0 + 1, int((y + 1) * shh / gh));
        unsigned acc[4] = {0, 0, 0, 0}, n = 0;
        for (int yy = y0; yy < y1 && yy < skiH; yy++) for (int xx = x0; xx < x1 && xx < skiW; xx++) { const uint8_t* p = &skiPx[(size_t(yy) * size_t(skiW) + size_t(xx)) * 4]; for (int c = 0; c < 4; c++) acc[c] += p[c]; n++; }
        if (n) for (int c = 0; c < 4; c++) px[(size_t(y) * size_t(gw) + size_t(x)) * 4 + size_t(c)] = uint8_t(acc[c] / n);
      }
      glow_ = makeTexture(dev_, gw, gh, px, false);
    }
    // take-off snow burst from under the skis (world coords at the take-off pose)
    const double sc0 = 1 + SC0;
    auto pose = [&](double x, double y, double& ox, double& oy) {
      double lx = (x - L.px) * sc0, ly = (y - L.py) * sc0, c = std::cos(ROT0), sn = std::sin(ROT0);
      ox = L.px + D0X + lx * c - ly * sn; oy = L.py + D0Y + lx * sn + ly * c;
    };
    for (int i = 0; i < 240; i++) {
      double f = rnd(), ax = lerp(450, 700, f) + rnd(-10, 10), ay = lerp(352, 465, f) + rnd(0, 26);
      Burst b{};
      pose(ax, ay, b.x, b.y);
      b.vx = rnd(-260, 120); b.vy = rnd(-260, 120); b.r = rnd(0.8, 3.4); b.t0 = rnd(0, 0.1); b.life = rnd(0.45, 1.05); b.w = rnd(0.55, 1);
      burst_.push_back(b);
    }
    for (int i = 0; i < 9; i++) {
      double f = i / 8.0;
      Puff q{};
      pose(lerp(440, 720, f), lerp(380, 490, f) + 10, q.x, q.y);
      q.vx = rnd(-70, 10); q.vy = rnd(-10, 60); q.r0 = rnd(16, 30); q.r1 = rnd(80, 150); q.life = rnd(0.7, 1.1); q.a = rnd(0.35, 0.6);
      puffs_.push_back(q);
    }
    for (int i = 0; i < 46; i++) {
      Streak q{};
      q.t0 = rnd(0, 1.2); q.life = rnd(0.18, 0.34); q.x = rnd(-0.1, 1.1); q.y = rnd(-0.1, 1.1); q.len = rnd(70, 240); q.w = rnd(0.7, 2); q.a = rnd(0.1, 0.26); q.sp = rnd(1500, 2600);
      streaks_.push_back(q);
    }
    for (int i = 0; i < 26; i++) {
      Flake q{};
      q.x = rnd(300, 1000); q.y = rnd(150, 900); q.r = rnd(2, 7); q.a = rnd(0.18, 0.45); q.vx = rnd(-40, 20); q.vy = rnd(10, 60);
      flakes_.push_back(q);
    }
    // impact dust off the bottom of the letters
    for (int i = 0; i < 150; i++) {
      Dust q{};
      q.x = rnd(185, 1000); q.y = rnd(735, 748);
      double k = rnd(0.2, 0.8);
      q.vx = (q.x - 600) * k + rnd(-90, 90); q.vy = rnd(-90, 110); q.r = rnd(0.8, 2.6); q.life = rnd(0.55, 1.15);
      dust_.push_back(q);
    }
  }

  // a soft sprite centred at (x, y) CSS px, half sizes rx / ry
  void sprite(vec2 c, float rx, float ry, float alpha) { pt_.whole(puff_, c.x - rx, c.y - ry, rx * 2, ry * 2, css(), alpha); }

  void drawFx(double t, const St& s, vec2 sh) {
    const double z = s.z;
    // take-off powder (skier plane)
    if (t < 1.4) {
      for (const Puff& q : puffs_) {
        double a = t / q.life;
        if (a >= 1) continue;
        float r = float(lerp(q.r0, q.r1, outCubic(a)) * z);
        sprite(toScreen(q.x + q.vx * t, q.y + q.vy * t, s.cx, s.cy, z, sh), r, r, float(q.a * (1 - a) * (1 - a) * sstep(0, 0.06, t)));
      }
      for (const Burst& q : burst_) {
        double tau = t - q.t0;
        if (tau < 0 || tau > q.life) continue;
        auto pos = [&](double tt) { double e = (1 - std::exp(-1.6 * tt)) / 1.6; return toScreen(q.x + q.vx * e, q.y + q.vy * e + 260 * tt * tt, s.cx, s.cy, z, sh); };
        vec2 p1 = pos(tau), p0 = pos(std::max(0.0, tau - 0.035));
        float lw = float(std::max(0.6, q.r * z * 0.7));
        pt_.capsule(p0 * dpr_, (p1 + vec2(0.01f, 0)) * dpr_, lw * dpr_, vec4(1, 1, 1, float(0.85 * q.w * (1 - tau / q.life))));
      }
    }
    // speed streaks (screen space, the world rushing past down-left)
    if (t < 1.55) {
      ui_.setBlend(UiBlend::Add);
      const double dirx = -0.36, diry = 0.93, fade = 1 - sstep(0.7, 1.5, t);
      for (const Streak& q : streaks_) {
        double tau = t - q.t0;
        if (tau < 0 || tau > q.life) continue;
        double k = tau / q.life, x = q.x * vw_ + dirx * q.sp * tau, y = q.y * vh_ + diry * q.sp * tau;
        pt_.capsule(vec2(float(x), float(y)) * dpr_, vec2(float(x - dirx * q.len), float(y - diry * q.len)) * dpr_, float(q.w) * dpr_,
                    vec4(0xea / 255.f, 0xf4 / 255.f, 1, float(q.a * std::sin(PI_D * k) * fade)));
      }
      ui_.setBlend(UiBlend::Premultiplied);
    }
    // foreground flakes (nearer than the skier: more parallax), gone by the reveal
    if (t < 2.1) {
      double fa = sstep(0, 0.3, t) * (1 - sstep(1.3, 2.0, t)), zf = z * 1.6;
      for (const Flake& q : flakes_) {
        vec2 c = toScreen(q.x + q.vx * t, q.y + q.vy * t, s.cx + (s.cx - L.ccx) * 0.6, s.cy + (s.cy - L.ccy) * 0.6, zf, sh);
        float r = float(q.r * zf * 0.6);
        sprite(c, r, r, float(q.a * fa));
      }
    }
    // the sun behind the slope: warm bloom + anamorphic streak, strongest in the opening
    {
      ui_.setBlend(UiBlend::Add);
      vec2 c = toScreen(L.sun[0], L.sun[1], s.bx, s.by, s.bz, sh);
      float a = float(lerp(0.42, 0.07, s.p) * sstep(0, 0.3, t) * (1 + 0.08 * std::sin(t * 5))), r = float(260 * s.bz);
      sprite(c, r, r, a);
      pt_.whole(puff_, c.x - r * 5, c.y - r * 0.05f, r * 10, r * 0.1f, css(), a * 0.55f);
      ui_.setBlend(UiBlend::Premultiplied);
    }
  }

  void drawText(double t, const St& s, vec2 sh) {
    const double z = s.z;
    const float k = float(L.scale);
    const M2 pl = plane(s.cx, s.cy, z, sh);
    const float SX = float(L.ski[0]), SY = float(L.ski[1]), SW = float(L.ski[2]), SH = float(L.ski[3]);
    // SKI: slams in from close to the lens (accelerating), ghosted while it flies
    if (t >= SLAM0) {
      float cx = SX + SW / 2, cy = SY + SH / 2;
      double kk = clamp01((t - SLAM0) / (IMPACT - SLAM0));
      auto scaleAt = [](double q) { return 1 + 1.6 * (1 - q * q); };
      double sc = scaleAt(kk);
      if (t >= IMPACT) sc = 1 - 0.035 * std::sin(PI_D * clamp01((t - IMPACT) / 0.2));
      int ghosts = t < IMPACT ? 4 : 0;
      for (int g = ghosts; g >= 0; g--) {
        double q = clamp01(kk - g * 0.05), gs = g ? scaleAt(q) : sc;
        M2 m = pl.translate(cx, cy).scale(float(gs), float(gs)).translate(-cx, -cy);
        pt_.image(ski_, 0, 0, SW * k, SH * k, SX, SY, SW, SH, m, float(sstep(0, 0.35, g ? q : kk) * (g ? 0.22 / g : 1)));
      }
      // light sweep: a slanted band of glow running across the letters
      double ts = (t - SWEEP0) / 0.75;
      if (ts > 0 && ts < 1 && glow_.t) {
        const float w = std::ceil(SW / 2), h = std::ceil(SH / 2);
        const float bx = float(lerp(-0.25, 1.25, inOutCubic(ts))) * w, gx = 0.24f * w, gy = 0.35f * h, gl = gx * gx + gy * gy;
        const float al = float(0.9 * std::sin(PI_D * ts));
        const float X0 = SX - SW * 0.04f, Y0 = SY - SH * 0.06f, DW = SW * 1.08f, DH = SH * 1.12f;
        const int NX = 96, NY = 10;
        auto V = [&](int i, int j) {
          float fx = float(i) / NX, fy = float(j) / NY;
          float u = ((fx * w - (bx - 0.12f * w)) * gx + fy * h * gy) / gl;
          float a = u <= 0 || u >= 1 ? 0.f : 1 - std::fabs(2 * u - 1);
          return UiVertex{pl.at(X0 + DW * fx, Y0 + DH * fy), vec2(fx, fy), vec4(1, 1, 1, al * a)};
        };
        std::vector<UiVertex> v;
        v.reserve(size_t(NX) * NY * 6);
        for (int j = 0; j < NY; j++) for (int i = 0; i < NX; i++) v.insert(v.end(), {V(i, j), V(i + 1, j), V(i + 1, j + 1), V(i, j), V(i + 1, j + 1), V(i, j + 1)});
        ui_.setBlend(UiBlend::Add);
        ui_.mesh(glow_.t, v.data(), v.size(), true);
        ui_.setBlend(UiBlend::Premultiplied);
      }
    }
    // LEGACY: letters track in from the right, staggered; then the rule draws out from the centre
    if (t >= LEG0) {
      const float GX = float(L.legacy[0]), GY = float(L.legacy[1]);
      const float top = GY, bottom = float(L.rule[1]) - 8;
      for (size_t i = 0; i < L.letters.size(); i++) {
        double q = clamp01((t - LEG0 - double(i) * 0.055) / 0.45);
        if (q <= 0) continue;
        double e = outCubic(q);
        float dx = float((1 - e) * (34 + (double(i) - 2.5) * 16)), sx = float(L.letters[i][0]) - 4, sw = float(L.letters[i][1] - L.letters[i][0]) + 9;
        for (int g = 1; g >= 0; g--) {
          float off = float(g * (1 - e) * 22);
          pt_.image(legacy_, (sx - GX) * k, (top - GY) * k, sw * k, (bottom - top) * k, sx + dx + off, top, sw, bottom - top, pl, float(sstep(0, 0.5, q) * (g ? 0.3 : 1)));
        }
      }
      double q = clamp01((t - RULE0) / 0.55);
      if (q > 0) {
        const float RX = float(L.rule[0]), RY = float(L.rule[1]), RW = float(L.rule[2]), RH = float(L.rule[3]);
        float cxr = RX + RW / 2, half = (RW / 2 + 4) * float(outCubic(q));
        pt_.image(legacy_, (cxr - half - GX) * k, (RY - 4 - GY) * k, half * 2 * k, (RH + 8) * k, cxr - half, RY - 4, half * 2, RH + 8, pl, float(sstep(0, 0.3, q)));
      }
    }
    // impact: flash, bloom, shock ring, dust
    if (t >= IMPACT && t < IMPACT + 1.3) {
      double a = t - IMPACT;
      ui_.setBlend(UiBlend::Add);
      ui_.rect(0, 0, float(W_), float(H_), vec4(1, 1, 1, float(0.5 * std::exp(-a / 0.07))));
      vec2 c = toScreen(SX + SW / 2, SY + SH / 2, s.cx, s.cy, z, sh);
      float r = float(SW * z * 0.9);
      sprite(c, r, r * 0.55f, float(0.8 * std::exp(-a / 0.22)));
      ui_.setBlend(UiBlend::Premultiplied);
      float rr = float(lerp(0.35, 1.25, outCubic(clamp01(a / 0.5))) * SW * z * 0.5);
      float ra = float(0.32 * (1 - clamp01(a / 0.5)));
      if (ra > 0.001f) {
        std::vector<vec2> pts;
        const float cr = std::cos(-0.08f), sr = std::sin(-0.08f);
        for (int i = 0; i < 128; i++) {
          float an = 2 * PI_F * float(i) / 128, ex = std::cos(an) * rr, ey = std::sin(an) * rr * 0.42f;
          pts.push_back((c + vec2(ex * cr - ey * sr, ex * sr + ey * cr)) * dpr_);
        }
        pt_.strokeLoop(pts, 2.5f * dpr_, vec4(1, 1, 1, ra));
      }
      for (const Dust& q : dust_) {
        if (a > q.life) continue;
        double e = (1 - std::exp(-2.6 * a)) / 2.6;
        vec2 d = toScreen(q.x + q.vx * e, q.y + q.vy * e + 40 * a * a, s.cx, s.cy, z, sh);
        float r2 = float(q.r * z * 1.4);
        sprite(d, r2, r2, float(0.75 * (1 - a / q.life)));
      }
    }
  }

  gfx::Device& dev_;
  Ui& ui_;
  Painter pt_;
  Tex bg_, backdrop_, skier_, ski_, legacy_, puff_, vig_, glow_, accTex_;
  gfx::RenderTarget acc_;
  int W_ = 0, H_ = 0;
  float dpr_ = 0;
  double vw_ = 1, vh_ = 1, sF_ = 1, rBig_ = 900;
  int cue_ = 0;
  std::vector<Burst> burst_;
  std::vector<Puff> puffs_;
  std::vector<Streak> streaks_;
  std::vector<Flake> flakes_;
  std::vector<Dust> dust_;
};

// ================================================================= the Icecold Studio ident (studioident.js, .sd-*)
class Studio {
public:
  Studio(gfx::Device& dev, Ui& ui) : dev_(dev), ui_(ui), pt_{ui} { buildWord(); }
  ~Studio() { freeTex(); if (spark_.t) dev_.destroy(spark_.t); }

  /// builds the logotype's pictures for this drawable (a few tens of ms: ahead of the first frame)
  void prepare(int W, int H, float dpr) { if (W != W_ || H != H_ || dpr != dpr_) layout(W, H, dpr); }

  /// the scene at ts seconds after its first frame (the Ui pass is open, the target cleared to black)
  void render(double ts, int W, int H, float dpr) {
    prepare(W, H, dpr);
    const float D = dpr_;
    ui_.setBlend(UiBlend::Premultiplied);
    ui_.rect(0, 0, float(W_), float(H_), ui_color::hex(0x05080d));
    // .sd-bloom: a breath of cold light behind the lockup on the hit
    {
      double u = (ts - 0.92) / 1.3;
      if (u > 0 && u < 1) {
        double op = u < 0.15 ? easeOut(u / 0.15) : 1 - easeOut((u - 0.15) / 0.85), sc = 0.6 + 0.8 * easeOut(u);
        float side = 0.8f * float(std::min(vw_, vh_));
        pt_.radial(vec2(float(vw_) * 0.5f, float(vh_) * 0.46f) * D, {{0, 0.32f}, {0.65f * 0.70710678f * side * float(sc) * D, 0}}, vec3(150 / 255.f, 210 / 255.f, 1), float(op));
      }
    }
    // .sd-logo: the logotype (overflow: hidden), punched in on the hit
    {
      double uh = (ts - 0.95) / 0.55;
      float hit = uh >= 0 && uh < 1 ? float(1.04 - 0.04 * bezier(0.2, 0.9, 0.2, 1, uh)) : 1.f;
      float x0 = bx_, y0 = by_, bw = lw_ * D, bh = lh_ * D;
      ui_.pushScale(x0 + bw / 2, y0 + bh / 2, hit, hit);
      pt_.whole(ice_, float(tx_), float(ty_), float(ice_.w), float(ice_.h), M2{}, 1);
      // .sd-flash: white, glowing, on the hit
      double uf = (ts - 0.92) / 0.75;
      float flash = uf <= 0 || uf >= 1 ? 0.f : float(uf < 0.1 ? easeOut(uf / 0.1) : 1 - easeOut((uf - 0.1) / 0.9));
      pt_.whole(flash_, float(tx_), float(ty_), float(flash_.w), float(flash_.h), M2{}, flash);
      // .sd-wipe: the cover sliding off to the right behind a bright frost edge
      {
        float shift = 0.48f * 2.4f * bw * float(bezier(0.45, 0.05, 0.35, 1, (ts - 0.05) / 0.9));
        float wl = x0 - 0.08f * bw + shift, ww = 2.4f * bw;
        struct Stop { float p; vec4 c; };   // premultiplied
        const Stop S[5] = {{0, vec4(0)}, {0.016f, vec4(200 / 255.f, 235 / 255.f, 1, 1) * 0.95f}, {0.03f, vec4(120 / 255.f, 185 / 255.f, 235 / 255.f, 1) * 0.5f},
                           {0.055f, vec4(5 / 255.f, 8 / 255.f, 13 / 255.f, 1)}, {1, vec4(5 / 255.f, 8 / 255.f, 13 / 255.f, 1)}};
        auto colAt = [&](float p) {   // CSS gradients interpolate premultiplied; the mesh takes straight colours
          vec4 c = S[4].c;
          for (int i = 0; i < 4; i++) if (p <= S[i + 1].p) { float u = std::clamp((p - S[i].p) / (S[i + 1].p - S[i].p), 0.f, 1.f); c = S[i].c + (S[i + 1].c - S[i].c) * u; break; }
          return c.w > 1e-5f ? vec4(c.x / c.w, c.y / c.w, c.z / c.w, c.w) : vec4(200 / 255.f, 235 / 255.f, 1, 0);
        };
        std::vector<float> ps;
        for (int i = 0; i < 4; i++) { int n = i == 3 ? 1 : 10; for (int k = 0; k < n; k++) ps.push_back(S[i].p + (S[i + 1].p - S[i].p) * float(k) / float(n)); }
        ps.push_back(1);
        float xa = x0, xb = x0 + bw;
        std::vector<UiVertex> v;
        for (size_t i = 0; i + 1 < ps.size(); i++) {
          float a = wl + ww * ps[i], b = wl + ww * ps[i + 1];
          float ca = std::max(a, xa), cb = std::min(b, xb);
          if (cb <= ca) continue;
          vec4 c0 = colAt(ps[i] + (ps[i + 1] - ps[i]) * (ca - a) / (b - a)), c1 = colAt(ps[i] + (ps[i + 1] - ps[i]) * (cb - a) / (b - a));
          UiVertex p00{vec2(ca, y0), vec2(0), c0}, p10{vec2(cb, y0), vec2(0), c1}, p11{vec2(cb, y0 + bh), vec2(0), c1}, p01{vec2(ca, y0 + bh), vec2(0), c0};
          v.insert(v.end(), {p00, p10, p11, p00, p11, p01});
        }
        if (!v.empty()) ui_.mesh(gfx::Texture{}, v.data(), v.size());
      }
      // .sd-glint: a slanted band of light across the ice (soft-light on the letters, plain white beside them)
      {
        double ug = (ts - 1.3) / 0.85;
        if (ug > 0 && ug < 1 && glint_.t) {
          float gw = 0.18f * bw, gh = 1.5f * bh, gl = x0 - 0.30f * bw + 9 * gw * float(easeInOut(ug)), gt = y0 - 0.25f * bh;
          const float th = 100 * PI_F / 180, dx = std::sin(th), dy = -std::cos(th), len = std::fabs(gw * dx) + std::fabs(gh * dy);
          vec2 gc(gl + gw / 2, gt + gh / 2);
          float xa = std::max(gl, x0), xb = std::min(gl + gw, x0 + bw);
          if (xb > xa) {
            const int NX = 48, NY = 8;
            auto V = [&](int i, int j) {
              vec2 p(xa + (xb - xa) * float(i) / NX, y0 + bh * float(j) / NY);
              float u = 0.5f + ((p.x - gc.x) * dx + (p.y - gc.y) * dy) / len;
              float a = u <= 0 || u >= 1 ? 0.f : 0.9f * (1 - std::fabs(2 * u - 1));
              return UiVertex{p, vec2((p.x - float(tx_)) / float(glint_.w), (p.y - float(ty_)) / float(glint_.h)), vec4(1, 1, 1, a)};
            };
            std::vector<UiVertex> v;
            for (int j = 0; j < NY; j++) for (int i = 0; i < NX; i++) v.insert(v.end(), {V(i, j), V(i + 1, j), V(i + 1, j + 1), V(i, j), V(i + 1, j + 1), V(i, j + 1)});
            ui_.setBlend(UiBlend::Add);
            ui_.mesh(glint_.t, v.data(), v.size());
            ui_.setBlend(UiBlend::Premultiplied);
          }
        }
      }
      ui_.popTransform();
    }
    // .sd-sub: STUDIO tracks in under the wordmark
    {
      double us = (ts - 1.15) / 0.8;
      if (us > 0) {
        float e = float(bezier(0.2, 0.9, 0.2, 1, us));
        const float tr = fitTracking(ui_, "STUDIO", UiFont::BodySemi, 0.36f, 5.9678f);   // (146.09 px at 24.48 px in Chrome)
        float fs = fs_ * D, w = ui_.textWidth("STUDIO", fs, UiFont::BodySemi, tr);
        // (- 0.025 em: the emboldened Inter sits that much to the right of the browser's 600)
        float left = (lx_ + lw_ * 0.5f) * D - (w - 0.36f * fs) * 0.5f - 0.025f * fs, top = subTop_ * D, boxH = subH_ * D;   // (margin-right: -0.36em)
        float base = top + std::round(ui_.ascent(UiFont::BodySemi) * fs_) * D;
        float y = base - ui_.ascent(UiFont::BodySemi) * fs - (ui_.lineHeight(fs, UiFont::BodySemi) - (ui_.ascent(UiFont::BodySemi) - ui_.descent(UiFont::BodySemi)) * fs) * 0.5f;
        ui_.pushTranslate(0, 0.35f * boxH * (1 - e));
        ui_.pushScale(left + w / 2, top + boxH / 2, 1 + 0.18f * (1 - e), 1);
        ui_.text(left, y, fs, UiFont::BodySemi, ui_color::hex(0x9fb3c4, e), "STUDIO", UiAlign::Left, tr);
        ui_.popTransform();
        ui_.popTransform();
      }
    }
    // .sd-spark: ice crystals thrown off by the hit
    for (int i = 0; i < 14; i++) {
      double d = 0.95 + (i % 5) * 0.06, sMax = 0.6 + (i % 3) * 0.35, u = (ts - d) / 1.0;
      if (u <= 0 || u >= 1) continue;
      double op, sc, ty = 0;
      if (u < 0.3) { double e = easeOut(u / 0.3); op = e; sc = sMax * e; }
      else { double e = easeOut((u - 0.3) / 0.7); op = 1 - e; sc = sMax + (0.2 - sMax) * e; ty = -0.03 * vh_ * e; }
      vec2 c(float(vw_ * (26 + (i * 37) % 48) / 100.0 + 3) * D, float(vh_ * (41 + (i * 23) % 14) / 100.0 + 3 + ty) * D);
      float k = float(sc) * D;
      ui_.pushRotate(c.x, c.y, PI_F / 4);
      pt_.whole(spark_, c.x - 16 * k, c.y - 16 * k, 32 * k, 32 * k, M2{}, float(op));   // box-shadow: 0 0 8px #bfe6ff
      ui_.roundRect(c.x - 3 * k, c.y - 3 * k, 6 * k, 6 * k, 0.01f, ui_color::hex(0xe8f6ff, float(op)));
      ui_.popTransform();
    }
    ui_.setBlend(UiBlend::Normal);
  }

private:
  using Poly = std::vector<dvec2>;
  struct Glyph { double x = 0, w = 0; std::vector<Poly> polys; };

  // ---- the logotype (studioident.js identEngine; units: cap height = 1), the look 'a': flats on the crystal points
  static constexpr double FLAT = 0.2, V = 0.235, HB = 0.19, DG = 0.222, HM = 0.18;
  // inner contour of a convex polygon, each edge moved inward by its own stroke weight
  static Poly inset(const Poly& P, const std::vector<double>& th) {
    size_t n = P.size();
    dvec2 ctr(0);
    for (auto& p : P) ctr += p / double(n);
    struct Ln { double x, y, dx, dy; };
    std::vector<Ln> ln;
    for (size_t i = 0; i < n; i++) {
      dvec2 p = P[i], q = P[(i + 1) % n];
      double l = glm::length(q - p), dx = (q.x - p.x) / l, dy = (q.y - p.y) / l, nx = -dy, ny = dx;
      if ((ctr.x - (p.x + q.x) / 2) * nx + (ctr.y - (p.y + q.y) / 2) * ny < 0) { nx = -nx; ny = -ny; }
      ln.push_back({p.x + nx * th[i], p.y + ny * th[i], dx, dy});
    }
    Poly out;
    for (size_t i = 0; i < n; i++) {
      const Ln& a = ln[(i + n - 1) % n], &b = ln[i];
      double t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / (a.dx * b.dy - a.dy * b.dx);
      out.push_back(dvec2(a.x + a.dx * t, a.y + a.dy * t));
    }
    return out;
  }
  // flat-top hexagon of width W (60-degree sides), its points blunted by a flat
  static void hexagon(double W, Poly& o, Poly& i, double& r) {
    r = (0.5 - FLAT / 2) / std::sqrt(3.0);
    double y0 = 0.5 - FLAT / 2, y1 = 0.5 + FLAT / 2;
    o = {{r, 0}, {W - r, 0}, {W, y0}, {W, y1}, {W - r, 1}, {r, 1}, {0, y1}, {0, y0}};
    i = inset(o, {HB, DG, V, DG, HB, DG, V, DG});
  }
  void buildWord() {
    auto I = [] { return Glyph{0, V, {Poly{{0, 0}, {V, 0}, {V, 1}, {0, 1}}}}; };
    auto C = [] {
      const double Wc = 0.84;
      Poly o, i; double r;
      hexagon(1.0, o, i, r);
      return Glyph{0, Wc, {Poly{{Wc, 0}, o[0], o[7], o[6], o[5], {Wc, 1}, {Wc, 1 - HB}, i[5], i[6], i[7], i[0], {Wc, HB}}}};
    };
    auto E = [] {
      const double We = 0.74, Wm = 0.68;
      return Glyph{0, We, {Poly{{0, 0}, {We, 0}, {We, HB}, {V, HB}, {V, 0.5 - HM / 2}, {Wm, 0.5 - HM / 2}, {Wm, 0.5 + HM / 2}, {V, 0.5 + HM / 2}, {V, 1 - HB}, {We, 1 - HB}, {We, 1}, {0, 1}}}};
    };
    auto O = [] {
      Poly o, i; double r;
      hexagon(1.04, o, i, r);
      return Glyph{0, 1.04, {o, i}};
    };
    auto Lg = [] { const double W = 0.68; return Glyph{0, W, {Poly{{0, 0}, {V, 0}, {V, 1 - HB}, {W, 1 - HB}, {W, 1}, {0, 1}}}}; };
    auto Dg = [] {
      const double W = 0.96;
      Poly hx, hi; double r;
      hexagon(2 * W, hx, hi, r);   // the right half of a hexagon on a stem
      Poly o{{0, 0}, {W - r, 0}, {W, hx[2].y}, {W, hx[3].y}, {W - r, 1}, {0, 1}};
      return Glyph{0, W, {o, inset(o, {HB, DG, V, DG, HB, V})}};
    };
    const double gaps[7] = {0.105, 0.085, 0.07, 0.045, 0.085, 0.075, 0};   // optical spacing after each letter
    Glyph g[7] = {I(), C(), E(), C(), O(), Lg(), Dg()};
    wordW_ = 0;
    for (int k = 0; k < 7; k++) { g[k].x = wordW_; wordW_ += g[k].w + gaps[k]; glyphs_.push_back(g[k]); }
  }

  void freeTex() { for (Tex* t : {&ice_, &flash_, &glint_}) if (t->t) { dev_.destroy(t->t); *t = Tex{}; } }

  void layout(int W, int H, float dpr) {
    W_ = W; H_ = H; dpr_ = dpr;
    pt_.W = W; pt_.H = H;
    vw_ = W / double(dpr); vh_ = H / double(dpr);
    // .sd-lockup: a centred column: the logo min(16vh, 10.5vw) tall, a gap min(6.7vh, 3.8vw), STUDIO min(3.4vh, 2.25vw)
    lh_ = float(std::min(0.16 * vh_, 0.105 * vw_));
    lw_ = lh_ * float((wordW_ + 0.04) / 1.04);
    float gap = float(std::min(0.067 * vh_, 0.038 * vw_));
    fs_ = float(std::min(0.034 * vh_, 0.0225 * vw_));
    subH_ = std::round(ui_.ascent(UiFont::BodySemi) * fs_) + std::round(-ui_.descent(UiFont::BodySemi) * fs_);   // line-height: normal
    // (the lockup sits on whole CSS pixels, STUDIO's line box on whole pixels under it: the page's own layers,
    // measured off the web game's frames at three window sizes)
    lx_ = std::round((float(vw_) - lw_) / 2); ly_ = std::round((float(vh_) - (lh_ + gap + subH_)) / 2);
    subTop_ = std::round(ly_ + lh_ + gap);
    buildTextures();
    if (!spark_.t) {
      // a 6 px square's box-shadow (blur 8 px: a Gaussian of sigma 4), #bfe6ff, on a 32 px tile at 4 texels a px
      const int N = 128;
      std::vector<uint8_t> px(size_t(N) * N * 4);
      auto F = [](double x) { const double k = 4 * std::sqrt(2.0); return 0.5 * (std::erf((x + 3) / k) - std::erf((x - 3) / k)); };
      for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) {
        double a = F((x + 0.5) / 4 - 16) * F((y + 0.5) / 4 - 16);
        uint8_t* p = &px[(size_t(y) * N + size_t(x)) * 4];
        p[0] = uint8_t(std::lround(0xbf * a)); p[1] = uint8_t(std::lround(0xe6 * a)); p[2] = uint8_t(std::lround(255 * a)); p[3] = uint8_t(std::lround(255 * a));
      }
      spark_ = makeTexture(dev_, N, N, px);
    }
  }

  // the logotype at the drawable's resolution: anti-aliased coverage (even-odd), then the pictures made of it
  void buildTextures() {
    freeTex();
    const double D = dpr_, k = lh_ * D / 1.04;   // px per cap height (the SVG viewBox is 1.04 tall, 0.02 around the word)
    double bx = lx_ * D, by = ly_ * D;
    bx_ = float(bx); by_ = float(by);
    tx_ = int(std::floor(bx)); ty_ = int(std::floor(by));
    const int TW = int(std::ceil(bx + lw_ * D)) - tx_ + 1, TH = int(std::ceil(by + lh_ * D)) - ty_ + 1;
    const double ox = bx - tx_ + 0.02 * k, oy = by - ty_ + 0.02 * k;
    std::vector<float> cov(size_t(TW) * size_t(TH), 0.f);
    const int SUB = 8;
    std::vector<double> xs;
    for (const Glyph& g : glyphs_) {
      for (int y = 0; y < TH; y++) {
        for (int sb = 0; sb < SUB; sb++) {
          double yy = (y + (sb + 0.5) / SUB - oy) / k;
          if (yy <= 0 || yy >= 1) continue;
          xs.clear();
          for (const Poly& P : g.polys)
            for (size_t i = 0, j = P.size() - 1; i < P.size(); j = i++) {
              const dvec2& a = P[i], &b = P[j];
              if ((a.y > yy) != (b.y > yy)) xs.push_back(((b.x - a.x) * (yy - a.y) / (b.y - a.y) + a.x + g.x) * k + ox);
            }
          std::sort(xs.begin(), xs.end());
          for (size_t i = 0; i + 1 < xs.size(); i += 2) {
            double x0 = std::max(0.0, xs[i]), x1 = std::min(double(TW), xs[i + 1]);
            for (int x = int(x0); x < TW && double(x) < x1; x++) cov[size_t(y) * size_t(TW) + size_t(x)] += float((std::min(x1, x + 1.0) - std::max(x0, double(x))) / SUB);
          }
        }
      }
    }
    // the box the page clips the logo to (.sd-logo overflow: hidden)
    auto boxCov = [&](int x, int y) {
      double cx = std::clamp(std::min(x + 1.0, bx - tx_ + lw_ * D) - std::max(double(x), bx - tx_), 0.0, 1.0);
      double cy = std::clamp(std::min(y + 1.0, by - ty_ + lh_ * D) - std::max(double(y), by - ty_), 0.0, 1.0);
      return float(cx * cy);
    };
    // the glow of .sd-flash: filter: drop-shadow(0 0 0.35em #bfe6ff) (em = 16 px; a filter's blur is the Gaussian's sigma)
    std::vector<float> blur(cov.size()), row(cov.size());
    {
      const double sigma = 0.35 * 16 * D;
      const int R = int(std::ceil(sigma * 3));
      std::vector<float> kern(size_t(2 * R + 1));
      float sum = 0;
      for (int i = -R; i <= R; i++) sum += kern[size_t(i + R)] = float(std::exp(-0.5 * i * i / (sigma * sigma)));
      for (float& v : kern) v /= sum;
      for (int y = 0; y < TH; y++) for (int x = 0; x < TW; x++) {
        float a = 0;
        for (int i = std::max(-R, -x); i <= R && x + i < TW; i++) a += cov[size_t(y) * size_t(TW) + size_t(x + i)] * kern[size_t(i + R)];
        row[size_t(y) * size_t(TW) + size_t(x)] = a;
      }
      for (int y = 0; y < TH; y++) for (int x = 0; x < TW; x++) {
        float a = 0;
        for (int i = std::max(-R, -y); i <= R && y + i < TH; i++) a += row[size_t(y + i) * size_t(TW) + size_t(x)] * kern[size_t(i + R)];
        blur[size_t(y) * size_t(TW) + size_t(x)] = a;
      }
    }
    std::vector<uint8_t> ice(cov.size() * 4), fl(cov.size() * 4), gl(cov.size() * 4);
    const vec3 c0(1, 1, 1), c1(0xdc / 255.f, 0xec / 255.f, 0xf8 / 255.f), c2(0x9f / 255.f, 0xc4 / 255.f, 0xde / 255.f), bg(5 / 255.f, 8 / 255.f, 13 / 255.f), glowC(0xbf / 255.f, 0xe6 / 255.f, 1);
    auto soft = [](float c) { return c <= 0.25f ? ((16 * c - 12) * c + 4) * c : std::sqrt(c); };   // soft-light under white
    auto put = [](uint8_t* p, const vec3& rgb, float a) {
      p[0] = uint8_t(std::lround(std::clamp(rgb.x, 0.f, 1.f) * 255)); p[1] = uint8_t(std::lround(std::clamp(rgb.y, 0.f, 1.f) * 255));
      p[2] = uint8_t(std::lround(std::clamp(rgb.z, 0.f, 1.f) * 255)); p[3] = uint8_t(std::lround(std::clamp(a, 0.f, 1.f) * 255));
    };
    for (int y = 0; y < TH; y++) {
      float t = float(std::clamp((y + 0.5 - oy) / k, 0.0, 1.0));   // the gradient runs over the path's box (top to bottom)
      vec3 col = t < 0.55f ? c0 + (c1 - c0) * (t / 0.55f) : c1 + (c2 - c1) * ((t - 0.55f) / 0.45f);
      for (int x = 0; x < TW; x++) {
        size_t i = size_t(y) * size_t(TW) + size_t(x);
        float box = boxCov(x, y), a = std::min(1.f, cov[i]) * box, g = std::min(1.f, blur[i]) * box;
        put(&ice[i * 4], col * a, a);
        put(&fl[i * 4], vec3(a) + glowC * (g * (1 - a)), a + g * (1 - a));
        // the glint over this pixel adds (per unit of its alpha): white beside the letters, soft-light on them
        vec3 d = (vec3(1) - bg) * (1 - a) + (vec3(soft(col.x), soft(col.y), soft(col.z)) - col) * a;
        put(&gl[i * 4], d * box, 1);
      }
    }
    ice_ = makeTexture(dev_, TW, TH, ice, false);
    flash_ = makeTexture(dev_, TW, TH, fl, false);
    glint_ = makeTexture(dev_, TW, TH, gl, false);
  }

  gfx::Device& dev_;
  Ui& ui_;
  Painter pt_;
  std::vector<Glyph> glyphs_;
  double wordW_ = 0, vw_ = 1, vh_ = 1;
  int W_ = 0, H_ = 0, tx_ = 0, ty_ = 0;
  float bx_ = 0, by_ = 0;   // the logo box's corner (drawable px)
  float dpr_ = 0, lx_ = 0, ly_ = 0, lw_ = 1, lh_ = 1, fs_ = 12, subTop_ = 0, subH_ = 1;
  Tex ice_, flash_, glint_, spark_;
};

// .intro-skip: 12 px, white at 50 %, letter-spacing 0.08em, right 26 px, bottom 22 px; fadeIn 1 s after 1 s
void drawSkipHint(Ui& ui, int W, int H, double T, bool pad, float alpha) {
  float op = float(ease((T - 1) / 1.0)) * alpha;
  if (op <= 0.002f) return;
  const float D = ui.dpr(), fs = 12 * D;
  const char* s = pad ? "Press any button to skip" : "Press any key to skip";
  float asc = ui.ascent(UiFont::Body), desc = ui.descent(UiFont::Body);
  float boxH = std::round(asc * 12) + std::round(-desc * 12);   // line-height: normal
  float base = float(H) - (22 + boxH) * D + std::round(asc * 12) * D;
  float y = base - asc * fs - (ui.lineHeight(fs, UiFont::Body) - (asc - desc) * fs) * 0.5f;
  ui.setBlend(UiBlend::Normal);
  const float tr = fitTracking(ui, "Press any key to skip", UiFont::Body, 0.08f, 11.6419f);   // (139.70 px at 12 px in Chrome)
  ui.text(float(W) - 26 * D - ui.textWidth(s, fs, UiFont::Body, tr), y, fs, UiFont::Body, vec4(1, 1, 1, 0.5f * op), s, UiAlign::Left, tr);
}

void writeFrame(gfx::Device& dev, int W, int H, const std::string& path) {
  std::vector<uint8_t> px, flipped;
  dev.readPixels(W, H, px);
  flipped.resize(px.size());
  for (int y = 0; y < H; y++) {
    std::memcpy(&flipped[size_t(y) * size_t(W) * 4], &px[size_t(H - 1 - y) * size_t(W) * 4], size_t(W) * 4);
    for (int x = 0; x < W; x++) flipped[(size_t(y) * size_t(W) + size_t(x)) * 4 + 3] = 255;
  }
  if (stbi_write_png(path.c_str(), W, H, 4, flipped.data(), W * 4)) SL_INFO("[intro] wrote %s", path.c_str());
}

} // namespace

bool playIntro(platform::Platform& plat, gfx::Device& dev, Ui& ui, Audio& audio, const AssetPaths& paths, const IntroOptions& opt) {
  int W = 1, H = 1;
  auto black = [&] {
    plat.drawableSize(W, H);
    dev.bindRenderTarget({}, W, H);
    dev.clear(0, 0, 0, 1, true, true);
    plat.swapBuffers();
  };
  black();
  const bool test = !opt.testPng.empty();
  const double tLoad = plat.timeSeconds();
  Clip clip(dev, ui);
  const bool haveClip = clip.load(plat, paths);
  if (!haveClip) SL_WARN("intro: the logo clip's layers are missing (%s/intro/clip): the studio ident only", paths.publicRoot.c_str());
  Studio studio(dev, ui);
  studio.prepare(W, H, std::clamp(plat.pixelRatio(), 0.5f, 4.f));
  // the ident's sound renders while the clip plays
  std::thread iceThread;
  if (audio.running() && !test) iceThread = std::thread([&audio, &plat] {
    double t0 = plat.timeSeconds();
    audio.prepareIceHit(STUDIO_HIT_S);
    SL_INFO("intro: the ident's sound rendered in %.2f s", plat.timeSeconds() - t0);
  });
  struct Join { std::thread& t; ~Join() { if (t.joinable()) t.join(); } } join{iceThread};
  // (the first cue is 20 ms in: give the loader thread a moment to decode it)
  if (audio.running() && !test) {
    platform::Events ev;
    while (!audio.shot("whoosh", 0) && plat.timeSeconds() - tLoad < 1.2) { plat.pollEvents(ev); if (ev.quit) return false; black(); }
  }
  SL_INFO("intro: ready in %.2f s (%s)", plat.timeSeconds() - tLoad, haveClip ? "logo clip + studio ident" : "studio ident");

  // the clock: T seconds from the first frame; the clip runs 0 .. CLIP_S (none: the ident starts at once)
  const double clipEnd = haveClip ? CLIP_S : 0, studioAt = haveClip ? STUDIO_AT : 0.5, total = studioAt + STUDIO_S;
  double skipT = -1;   // skipped at
  bool usingPad = false, iceStarted = false;
  auto frame = [&](double T) {
    plat.drawableSize(W, H);
    const float dpr = std::clamp(plat.pixelRatio(), 0.5f, 4.f);   // (as Ui::begin takes it)
    const bool skipped = skipT >= 0;
    bool open = false;
    // 1 -- the logo clip, its 0.5 s fade to black
    if (haveClip && !skipped && T < clipEnd + CLIP_OUT_S) {
      clip.render(std::min(T, clipEnd + 1), W, H, dpr);
      open = true;
      float out = float(ease((T - clipEnd) / CLIP_OUT_S));
      if (out > 0) ui.rect(0, 0, float(W), float(H), vec4(0, 0, 0, out));
    }
    if (!open) {
      dev.bindRenderTarget({}, W, H);
      dev.clear(0, 0, 0, 1, true, true);
      ui.begin(W, H);
    }
    // 2 -- Icecold Studio over it: in from the clip's end, out after STUDIO_S (a skip: shown, fading out at once)
    float op = skipped ? float(1 - ease((T - skipT) / STUDIO_LEAVE_S)) : T < studioAt ? 0.f : T < total ? float(ease((T - studioAt) / STUDIO_IN_S)) : float(1 - ease((T - total) / STUDIO_LEAVE_S));
    if (op > 0.001f) {
      studio.render(T - studioAt, W, H, dpr);
      if (op < 1) ui.rect(0, 0, float(W), float(H), vec4(0, 0, 0, 1 - op));
    }
    drawSkipHint(ui, W, H, T, usingPad, 1);
    ui.end();
  };

  if (test) {
    // (debug) the frames at fixed times, as tools' JS reference shots
    std::vector<int> times;
    if (const char* e = std::getenv("SKI_LEGACY_INTRO_TIMES")) { for (const char* p = e; *p;) { times.push_back(std::atoi(p)); while (*p && *p != ',') p++; if (*p) p++; } }
    else {
      for (int t = 50; t <= 4250; t += 100) times.push_back(t);
      for (int t : {4350, 4500, 4650}) times.push_back(t);
      for (int t = 4750; t <= 7100; t += 50) times.push_back(t);
      for (int t : {7250, 7400, 7600}) times.push_back(t);
    }
    size_t dot = opt.testPng.rfind('.');
    for (int ms : times) {
      double t0 = plat.timeSeconds();
      frame(ms / 1000.0);
      char tag[32];
      std::snprintf(tag, sizeof tag, "_intro_%04d", ms);
      writeFrame(dev, W, H, dot == std::string::npos ? opt.testPng + tag : opt.testPng.substr(0, dot) + tag + opt.testPng.substr(dot));
      SL_INFO("[intro] t = %d ms drawn in %.1f ms", ms, (plat.timeSeconds() - t0) * 1000);
      plat.swapBuffers();
      platform::Events ev;
      plat.pollEvents(ev);
      if (ev.quit) return false;
    }
    return true;
  }

  const double t0 = plat.timeSeconds();
  int frames = 0;
  double worst = 0, last = t0;
  for (;;) {
    platform::Events ev;
    plat.pollEvents(ev);
    if (ev.quit) { audio.stopIceHit(0.05f); return false; }
    const double now = plat.timeSeconds(), T = now - t0;
    if (frames > 2) worst = std::max(worst, now - last);
    last = now;
    if (!ev.padPressed.empty()) usingPad = true;
    if (skipT < 0 && (!ev.pressed.empty() || ev.mousePressed || !ev.padPressed.empty())) {
      skipT = T;
      audio.stopIceHit(0.35f);
    }
    if (skipT < 0) {
      if (haveClip) clip.cues(T, [&](const char* name) { if (std::strcmp(name, "announce") == 0) audio.announce("ski_legacy"); else audio.play(name); });
      if (!iceStarted && T >= studioAt) {
        iceStarted = true;
        if (!audio.iceHit(STUDIO_HIT_S) && audio.running()) SL_WARN("intro: the ident's sound was not rendered in time");
      }
    }
    if (skipT >= 0 ? T >= skipT + STUDIO_LEAVE_S : T >= total + STUDIO_LEAVE_S) break;
    frame(T);
    plat.swapBuffers();
    audio.update(1.0 / 60);
    frames++;
  }
  const double Tend = plat.timeSeconds() - t0;
  SL_INFO("intro: %s after %.2f s, %d frames (%.1f fps, the longest %.1f ms)", skipT >= 0 ? "skipped" : "played", Tend, frames, frames / std::max(0.001, Tend), worst * 1000);
  // #intro.done: the intro's black lifts off what is under it (0.5 s; gone after 0.25 s when it was skipped)
  if (opt.after) {
    const double f0 = plat.timeSeconds(), dur = skipT >= 0 ? 0.25 : DONE_S;
    for (;;) {
      platform::Events ev;
      plat.pollEvents(ev);
      if (ev.quit) return false;
      double x = (plat.timeSeconds() - f0) / DONE_S;
      if (x * DONE_S >= dur) break;
      float veil = float(1 - ease(x));
      opt.after([&] {
        ui.setBlend(UiBlend::Normal);
        ui.rect(0, 0, float(ui.width()), float(ui.height()), vec4(0, 0, 0, veil));
        drawSkipHint(ui, ui.width(), ui.height(), Tend + x * DONE_S, usingPad, veil);
      });
    }
  }
  return true;
}

} // namespace sl
