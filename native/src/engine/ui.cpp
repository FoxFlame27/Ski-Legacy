#include "engine/ui.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include <stb_truetype.h>

namespace sl {

namespace ui_color {
vec4 hex(uint32_t rgb, float alpha) { return vec4(float((rgb >> 16) & 255) / 255.f, float((rgb >> 8) & 255) / 255.f, float(rgb & 255) / 255.f, alpha); }
} // namespace ui_color

std::vector<uint32_t> utf8Decode(const std::string& s) {
  std::vector<uint32_t> out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    uint8_t c = uint8_t(s[i]);
    uint32_t cp = c;
    int n = 0;
    if (c >= 0xf0) { cp = c & 7; n = 3; } else if (c >= 0xe0) { cp = c & 15; n = 2; } else if (c >= 0xc0) { cp = c & 31; n = 1; }
    i++;
    for (int k = 0; k < n && i < s.size(); k++, i++) cp = (cp << 6) | (uint8_t(s[i]) & 63);
    out.push_back(cp);
  }
  return out;
}

namespace {
constexpr int ATLAS = 2048;
constexpr float BAKE = 40;        // glyphs are baked at a 40 px em
constexpr int PAD = 6;
constexpr unsigned char ONEDGE = 128;
constexpr float PDS = 128.f / PAD;

const char* kVS = R"GLSL(
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aCol;
layout(location = 3) in vec4 aP;
layout(location = 4) in vec2 aQ;
uniform vec2 uScreen;
out vec2 vUv; out vec4 vCol; out vec4 vP; out vec2 vQ;
void main() {
  vUv = aUv; vCol = aCol; vP = aP; vQ = aQ;
  gl_Position = vec4(aPos / uScreen * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}
)GLSL";
const char* kFS = R"GLSL(
in vec2 vUv; in vec4 vCol; in vec4 vP; in vec2 vQ;
uniform sampler2D uTex;
out vec4 oColor;
float sdRound(vec2 p, vec2 h, float r) { vec2 q = abs(p) - h + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  float a = 1.0;
  vec4 c = vCol;
  if (vQ.y < 0.5) {                 // SDF glyph
    float d = texture(uTex, vUv).r;
    float w = max(fwidth(d) * 0.7, 0.002);
    a = smoothstep(0.5 - w, 0.5 + w, d);
  } else if (vQ.y < 1.5) {          // rounded rect (vP.xy local px from the centre, vP.zw half size, vQ.x radius)
    a = clamp(0.5 - sdRound(vP.xy, vP.zw, vQ.x), 0.0, 1.0);
  } else if (vQ.y < 2.5) {          // rounded rect outline (stroke width in vUv.x)
    float d = sdRound(vP.xy, vP.zw, vQ.x);
    a = clamp(0.5 - abs(d + vUv.x * 0.5) + vUv.x * 0.5, 0.0, 1.0);
  } else if (vQ.y < 3.5) {          // flat (triangles, polygons)
    a = 1.0;
  } else {                          // image
    c *= texture(uTex, vUv);
  }
  oColor = vec4(c.rgb, c.a * a);
}
)GLSL";

const vec2 BRUSH_A[] = {{1, 14}, {7, 4}, {31, 9}, {56, 2}, {79, 8}, {96, 0}, {100, 20}, {97.5f, 42}, {100, 63}, {96.5f, 86}, {99, 100}, {71, 93}, {46, 99}, {21, 92}, {3, 98}, {0, 72}, {2, 46}, {0, 26}};
const vec2 BRUSH_B[] = {{0, 8}, {22, 2}, {48, 7}, {74, 0}, {98, 6}, {100, 34}, {97, 58}, {100, 90}, {82, 97}, {55, 92}, {30, 100}, {6, 94}, {1, 68}, {3, 40}};

// menu.js rng(seed)
struct Rng {
  double s;
  explicit Rng(int seed) : s(double(seed) * 9301 + 49297) {}
  double operator()() { s = std::fmod(s * 233280 + 49297, 2147483647.0); return s / 2147483647.0; }
};
} // namespace

struct Ui::FontData {
  std::vector<uint8_t> ttf;
  stbtt_fontinfo info{};
  float ascent = 0.8f, descent = -0.2f;   // per em
  float bakeScale = 1;
  std::unordered_map<uint32_t, Glyph> glyphs;
  bool ok = false;
};

Ui::Ui() = default;
Ui::~Ui() = default;

bool Ui::bakeAtlas(platform::Platform& plat, const AssetPaths& paths) {
  static const char* files[size_t(UiFont::Count)] = {"fonts/inter.ttf", "fonts/barlow-condensed-600.ttf", "fonts/barlow-condensed-700.ttf",
                                                     "fonts/barlow-condensed-700-italic.ttf", "fonts/barlow-condensed-800-italic.ttf"};
  std::vector<uint32_t> cps;
  for (uint32_t c = 32; c < 127; c++) cps.push_back(c);
  for (uint32_t c = 160; c < 256; c++) cps.push_back(c);
  for (uint32_t c : {0x2014u, 0x2013u, 0x2026u, 0x2022u, 0x2190u, 0x2191u, 0x2192u, 0x2193u, 0x2212u, 0x20ACu, 0x2018u, 0x2019u, 0x201Cu, 0x201Du, 0x2715u, 0x25CBu, 0x25A1u, 0x25B3u, 0x00D7u})
    cps.push_back(c);
  std::vector<uint8_t> px(size_t(ATLAS) * ATLAS, 0);
  int x = 1, y = 1, rowH = 0;
  bool full = false;
  for (size_t fi = 0; fi < size_t(UiFont::Count); fi++) {
    auto fd = std::make_unique<FontData>();
    if (!plat.readFile(paths.data(files[fi]), fd->ttf) || !stbtt_InitFont(&fd->info, fd->ttf.data(), stbtt_GetFontOffsetForIndex(fd->ttf.data(), 0))) {
      SL_WARN("ui: font %s missing (node native/tools/export_fonts.mjs)", files[fi]);
      fonts_.push_back(std::move(fd));
      continue;
    }
    fd->ok = true;
    int a, d, g;
    stbtt_GetFontVMetrics(&fd->info, &a, &d, &g);
    float em = stbtt_ScaleForMappingEmToPixels(&fd->info, 1.f);
    fd->ascent = a * em; fd->descent = d * em;
    fd->bakeScale = stbtt_ScaleForMappingEmToPixels(&fd->info, BAKE);
    for (uint32_t cp : cps) {
      int gi = stbtt_FindGlyphIndex(&fd->info, int(cp));
      if (!gi && cp != 32) continue;
      Glyph G{};
      int adv, lsb;
      stbtt_GetGlyphHMetrics(&fd->info, gi, &adv, &lsb);
      G.adv = adv * fd->bakeScale;
      int w = 0, h = 0, xo = 0, yo = 0;
      unsigned char* bm = full ? nullptr : stbtt_GetGlyphSDF(&fd->info, fd->bakeScale, gi, PAD, ONEDGE, PDS, &w, &h, &xo, &yo);
      if (bm && w > 0 && h > 0) {
        if (x + w + 1 >= ATLAS) { x = 1; y += rowH + 1; rowH = 0; }
        if (y + h + 1 >= ATLAS) { full = true; SL_WARN("ui: glyph atlas full"); }
        else {
          for (int r = 0; r < h; r++) std::memcpy(&px[size_t(y + r) * ATLAS + size_t(x)], bm + size_t(r) * w, size_t(w));
          G.u0 = float(x) / ATLAS; G.v0 = float(y) / ATLAS; G.u1 = float(x + w) / ATLAS; G.v1 = float(y + h) / ATLAS;
          G.x0 = float(xo); G.y0 = float(yo); G.x1 = float(xo + w); G.y1 = float(yo + h);
          G.ok = true;
          x += w + 1;
          rowH = std::max(rowH, h);
        }
      }
      if (bm) stbtt_FreeSDF(bm, nullptr);
      fd->glyphs[cp] = G;
    }
    fonts_.push_back(std::move(fd));
  }
  gfx::TextureDesc td;
  td.width = td.height = ATLAS; td.format = gfx::TexFormat::R8; td.filter = gfx::Filter::Linear; td.wrap = gfx::Wrap::Clamp; td.mipmaps = false; td.anisotropy = 1;
  atlas_ = dev_->createTexture(td, px.data());
  return fonts_[size_t(UiFont::Body)]->ok || fonts_[size_t(UiFont::CondBold)]->ok;
}

bool Ui::init(gfx::Device& dev, platform::Platform& plat, const AssetPaths& paths) {
  dev_ = &dev;
  prog_ = dev.createProgram("ui", std::string("#version 410 core\n") + kVS, std::string("#version 410 core\n") + kFS);
  if (!prog_) return false;
  vboBytes_ = 1 << 20;
  vbo_ = dev.createBuffer(gfx::BufferUsage::Vertex, nullptr, vboBytes_, true);
  const uint32_t S = sizeof(Vert);
  vi_ = dev.createVertexInput({{0, 0, 2, gfx::AttribType::Float, false, 0, S}, {1, 0, 2, gfx::AttribType::Float, false, 8, S},
                               {2, 0, 4, gfx::AttribType::Float, false, 16, S}, {3, 0, 4, gfx::AttribType::Float, false, 32, S},
                               {4, 0, 2, gfx::AttribType::Float, false, 48, S}}, {vbo_}, {});
  uint32_t wpx = 0xffffffffu;
  gfx::TextureDesc td;
  td.width = td.height = 1; td.filter = gfx::Filter::Nearest; td.mipmaps = false;
  white_ = dev.createTexture(td, &wpx);
  ready_ = bakeAtlas(plat, paths);
  if (!ready_) SL_WARN("ui: no fonts: menus and HUD without text");
  return true;
}

void Ui::begin(int w, int h) {
  w_ = std::max(1, w); h_ = std::max(1, h);
  verts_.clear();
  batches_.clear();
  clips_.clear();
}

void Ui::useTexture(gfx::Texture t) {
  if (!t) t = atlas_;
  if (batches_.empty() || batches_.back().tex.id != t.id) batches_.push_back({t, uint32_t(verts_.size()), 0});
}

void Ui::end() {
  if (verts_.empty() || !prog_) return;
  for (auto& b : batches_) b.count = 0;
  for (size_t i = 0; i < batches_.size(); i++) batches_[i].count = (i + 1 < batches_.size() ? batches_[i + 1].first : uint32_t(verts_.size())) - batches_[i].first;
  size_t bytes = verts_.size() * sizeof(Vert);
  if (bytes > vboBytes_) { vboBytes_ = bytes * 2; dev_->destroy(vbo_); dev_->destroy(vi_);
    vbo_ = dev_->createBuffer(gfx::BufferUsage::Vertex, nullptr, vboBytes_, true);
    const uint32_t S = sizeof(Vert);
    vi_ = dev_->createVertexInput({{0, 0, 2, gfx::AttribType::Float, false, 0, S}, {1, 0, 2, gfx::AttribType::Float, false, 8, S},
                                   {2, 0, 4, gfx::AttribType::Float, false, 16, S}, {3, 0, 4, gfx::AttribType::Float, false, 32, S},
                                   {4, 0, 2, gfx::AttribType::Float, false, 48, S}}, {vbo_}, {});
  }
  dev_->replaceBuffer(vbo_, verts_.data(), bytes);
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None; ps.blend = gfx::Blend::Alpha;
  dev_->setPipeline(ps);
  dev_->useProgram(prog_);
  vec2 scr{float(w_), float(h_)};
  dev_->setVec2("uScreen", &scr.x);
  dev_->setInt("uTex", 0);
  for (const Batch& b : batches_) {
    if (!b.count) continue;
    dev_->bindTexture(0, b.tex);
    dev_->draw(vi_, b.count, b.first);
  }
}

// ---------------------------------------------------------------- primitives
void Ui::quad(float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, const vec4& c,
              float lx0, float ly0, float lx1, float ly1, float hw, float hh, float rad, float mode, gfx::Texture tex) {
  if (!clips_.empty()) {
    const vec4& k = clips_.back();
    float cx0 = std::max(x0, k.x), cy0 = std::max(y0, k.y), cx1 = std::min(x1, k.x + k.z), cy1 = std::min(y1, k.y + k.w);
    if (cx0 >= cx1 || cy0 >= cy1) return;
    auto lerpf = [](float a, float b, float t) { return a + (b - a) * t; };
    float tx0 = (cx0 - x0) / (x1 - x0), tx1 = (cx1 - x0) / (x1 - x0), ty0 = (cy0 - y0) / (y1 - y0), ty1 = (cy1 - y0) / (y1 - y0);
    float nu0 = lerpf(u0, u1, tx0), nu1 = lerpf(u0, u1, tx1), nv0 = lerpf(v0, v1, ty0), nv1 = lerpf(v0, v1, ty1);
    float nl0 = lerpf(lx0, lx1, tx0), nl1 = lerpf(lx0, lx1, tx1), nm0 = lerpf(ly0, ly1, ty0), nm1 = lerpf(ly0, ly1, ty1);
    if (mode > 1.5f && mode < 2.5f) { nu0 = u0; nu1 = u1; nv0 = v0; nv1 = v1; }   // (the stroke width rides in uv)
    x0 = cx0; x1 = cx1; y0 = cy0; y1 = cy1; u0 = nu0; u1 = nu1; v0 = nv0; v1 = nv1; lx0 = nl0; lx1 = nl1; ly0 = nm0; ly1 = nm1;
  }
  useTexture(tex);
  Vert a{x0, y0, u0, v0, c.x, c.y, c.z, c.w, lx0, ly0, hw, hh, rad, mode};
  Vert b{x1, y0, u1, v0, c.x, c.y, c.z, c.w, lx1, ly0, hw, hh, rad, mode};
  Vert d{x1, y1, u1, v1, c.x, c.y, c.z, c.w, lx1, ly1, hw, hh, rad, mode};
  Vert e{x0, y1, u0, v1, c.x, c.y, c.z, c.w, lx0, ly1, hw, hh, rad, mode};
  verts_.insert(verts_.end(), {a, b, d, a, d, e});
}

void Ui::rect(float x, float y, float w, float h, const vec4& c) {
  if (w <= 0 || h <= 0) return;
  quad(x, y, x + w, y + h, 0, 0, 0, 0, c, 0, 0, 0, 0, 0, 0, 0, 3, white_);
}
void Ui::rectGradient(float x, float y, float w, float h, const vec4& c0, const vec4& c1, bool horizontal) {
  if (w <= 0 || h <= 0) return;
  vec2 p00(x, y), p10(x + w, y), p11(x + w, y + h), p01(x, y + h);
  vec4 a = c0, b = horizontal ? c1 : c0, d = c1, e = horizontal ? c0 : c1;   // corners: 00, 10, 11, 01
  useTexture(white_);
  auto V = [&](vec2 p, const vec4& c) { return Vert{p.x, p.y, 0, 0, c.x, c.y, c.z, c.w, 0, 0, 0, 0, 0, 3}; };
  verts_.insert(verts_.end(), {V(p00, a), V(p10, b), V(p11, d), V(p00, a), V(p11, d), V(p01, e)});
}
void Ui::roundRect(float x, float y, float w, float h, float r, const vec4& c) {
  if (w <= 0 || h <= 0) return;
  r = std::min(r, std::min(w, h) * 0.5f);
  float hw = w * 0.5f, hh = h * 0.5f;
  // half a pixel of margin for the anti-aliased edge
  quad(x - 1, y - 1, x + w + 1, y + h + 1, 0, 0, 0, 0, c, -hw - 1, -hh - 1, hw + 1, hh + 1, hw, hh, r, 1, white_);
}
void Ui::roundRectStroke(float x, float y, float w, float h, float r, float width, const vec4& c) {
  if (w <= 0 || h <= 0) return;
  r = std::min(r, std::min(w, h) * 0.5f);
  float hw = w * 0.5f, hh = h * 0.5f;
  quad(x - 1, y - 1, x + w + 1, y + h + 1, width, 0, width, 0, c, -hw - 1, -hh - 1, hw + 1, hh + 1, hw, hh, r, 2, white_);
}
void Ui::triRaw(vec2 a, vec2 b, vec2 c, const vec4& col) {
  useTexture(white_);
  auto V = [&](vec2 p) { return Vert{p.x, p.y, 0, 0, col.x, col.y, col.z, col.w, 0, 0, 0, 0, 0, 3}; };
  verts_.insert(verts_.end(), {V(a), V(b), V(c)});
}
void Ui::tri(vec2 a, vec2 b, vec2 c, const vec4& col) { triRaw(a, b, c, col); }
void Ui::poly(const std::vector<vec2>& p, const vec4& c) {
  if (p.size() < 3) return;
  vec2 ctr(0);
  for (const vec2& q : p) ctr += q;
  ctr /= float(p.size());
  for (size_t i = 0; i < p.size(); i++) triRaw(ctr, p[i], p[(i + 1) % p.size()], c);
}
void Ui::line(vec2 a, vec2 b, float w, const vec4& c) {
  vec2 d = b - a;
  float l = glm::length(d);
  if (l < 1e-4f) return;
  vec2 n = vec2(-d.y, d.x) / l * (w * 0.5f);
  triRaw(a + n, b + n, b - n, c);
  triRaw(a + n, b - n, a - n, c);
}
void Ui::polyline(const std::vector<vec2>& pts, float w, const vec4& c, bool dashed, float dash) {
  if (pts.size() < 2) return;
  if (!dashed) {
    for (size_t i = 1; i < pts.size(); i++) line(pts[i - 1], pts[i], w, c);
    // round-ish joints
    if (w > 2.5f) for (size_t i = 1; i + 1 < pts.size(); i++) circle(pts[i].x, pts[i].y, w * 0.5f, c);
    return;
  }
  float acc = 0;
  bool on = true;
  for (size_t i = 1; i < pts.size(); i++) {
    vec2 a = pts[i - 1], b = pts[i];
    float l = glm::length(b - a), t = 0;
    while (t < l) {
      float step = std::min(dash - acc, l - t);
      if (on) line(a + (b - a) * (t / l), a + (b - a) * ((t + step) / l), w, c);
      t += step; acc += step;
      if (acc >= dash - 1e-4f) { acc = 0; on = !on; }
    }
  }
}
void Ui::image(gfx::Texture t, float x, float y, float w, float h, vec2 uv0, vec2 uv1, const vec4& tint) {
  quad(x, y, x + w, y + h, uv0.x, uv0.y, uv1.x, uv1.y, tint, 0, 0, 0, 0, 0, 0, 0, 4, t);
}
void Ui::shadow(float x, float y, float w, float h, float r, float spread, float alpha) {
  for (int i = 3; i >= 1; i--) {
    float s = spread * float(i) / 3.f;
    roundRect(x - s, y - s * 0.4f + spread * 0.5f, w + 2 * s, h + 2 * s, r + s, vec4(0.0f, 0.08f, 0.24f, alpha / 3.f));
  }
}

// ---------------------------------------------------------------- house style
void Ui::brushPanel(float x, float y, float w, float h, const vec4& c, int variant) {
  std::vector<vec2> p;
  if (variant == 1) for (const vec2& q : BRUSH_B) p.push_back(vec2(x + w * q.x / 100.f, y + h * q.y / 100.f));
  else for (const vec2& q : BRUSH_A) p.push_back(vec2(x + w * q.x / 100.f, y + h * q.y / 100.f));
  poly(p, c);
}

float Ui::brushTextEnd(float w, float h) {
  float tail = std::min(w * 0.24f, h * 0.62f);
  return (w - tail * 1.16f) / w;
}

void Ui::brushStroke(float x, float y, float w, float h, const vec4& c, int seed) {
  Rng r(seed);
  r();
  float tail = std::min(w * 0.24f, h * 0.62f), x1 = w - tail, xa = std::min(h * 0.16f, w * 0.06f);
  double ph[4] = {r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283};
  auto top = [&](float X) { return h * 0.12f + float(std::sin(X / w * 5.1 + ph[0])) * h * 0.022f + float(std::sin(X / w * 12.7 + ph[1])) * h * 0.011f; };
  auto bot = [&](float X) { return h * 0.88f + float(std::sin(X / w * 4.3 + ph[2])) * h * 0.022f + float(std::sin(X / w * 11.3 + ph[3])) * h * 0.011f; };
  int N = std::max(8, int(std::round((x1 - xa) / (h * 0.42f))));
  std::vector<vec2> T, B;
  for (int i = 0; i <= N; i++) {
    float X = xa + (x1 - xa) * float(i) / float(N);
    T.push_back(vec2(X, top(X) + float(r() - 0.5) * h * 0.008f));
    B.push_back(vec2(X, bot(X) + float(r() - 0.5) * h * 0.008f));
  }
  // the body: a strip of quads between the long edges (always convex pieces)
  auto P = [&](vec2 q) { return vec2(x + q.x, y + q.y); };
  for (int i = 0; i < N; i++) { triRaw(P(T[size_t(i)]), P(T[size_t(i) + 1]), P(B[size_t(i) + 1]), c); triRaw(P(T[size_t(i)]), P(B[size_t(i) + 1]), P(B[size_t(i)]), c); }
  // the blunt left cap
  float capX = h * float(0.015 + r() * 0.03), capY = h * float(0.5 + (r() - 0.5) * 0.06);
  std::vector<vec2> cap = {T[0], vec2(capX + h * 0.02f, h * 0.3f), vec2(capX, capY), vec2(capX + h * 0.02f, h * 0.7f), B[0]};
  for (size_t i = 1; i + 1 < cap.size(); i++) triRaw(P(cap[0]), P(cap[i]), P(cap[i + 1]), c);
  // the bristle tail: fingers fanning out to the right
  int F = 8 + int(r() * 5);
  std::vector<double> wts;
  double sum = 0;
  for (int k = 0; k < F; k++) { double v = 0.45 + r() * 1.1; wts.push_back(v); sum += v; }
  float yT = T[size_t(N)].y, yB = B[size_t(N)].y, y0 = yT;
  double acc = 0;
  for (int k = 0; k < F; k++) {
    acc += wts[size_t(k)];
    float y1 = k == F - 1 ? yB : yT + float((yB - yT) * acc / sum);
    float ym = y0 + (y1 - y0) * float(0.35 + r() * 0.3);
    bool outer = k == 0 || k == F - 1;
    float len = tail * float(outer ? 0.25 + r() * 0.35 : 0.3 + r() * 0.7);
    float tipX = std::min(w - 1, x1 + len);
    float notch = k < F - 1 ? x1 - tail * 0.16f * float(r()) : x1;
    // finger: from the root (x1 - a little, y0..y1) to the tip
    vec2 a(x1 - 2, y0), b(x1 + len * 0.5f, y0 + (ym - y0) * 0.3f), t(tipX, ym), d(x1 + len * 0.45f, y1 - (y1 - ym) * 0.35f), e(notch, y1), f(x1 - 2, y1);
    triRaw(P(a), P(b), P(t), c); triRaw(P(a), P(t), P(d), c); triRaw(P(a), P(d), P(e), c); triRaw(P(a), P(e), P(f), c);
    y0 = y1;
  }
}

float Ui::keycapWidth(float h, const std::string& label) {
  if (label == "\xE2\x9C\x95" || label == "\xE2\x97\x8B" || label == "\xE2\x96\xA1" || label == "\xE2\x96\xB3") return h * 1.05f;
  float tw = textWidth(label, h * 0.62f, UiFont::Body);
  return std::max(h * 1.05f, tw + h * (label.size() > 1 ? 0.62f : 0.5f));
}

float Ui::keycap(float x, float y, float h, const std::string& label, bool inverted) {
  float w = keycapWidth(h, label);
  vec4 bg = inverted ? ui_color::white : ui_color::blue, fg = inverted ? ui_color::blue : ui_color::white;
  roundRect(x, y + h * 0.06f, w, h, h * 0.2f, ui_color::a(ui_color::navy, 0.35f));   // (the cap's lower edge)
  roundRect(x, y, w, h, h * 0.2f, bg);
  float cx = x + w / 2, cy = y + h / 2, s = h * 0.24f, lw = std::max(1.5f, h * 0.09f);
  if (label == "\xE2\x9C\x95") { line(vec2(cx - s, cy - s), vec2(cx + s, cy + s), lw, fg); line(vec2(cx - s, cy + s), vec2(cx + s, cy - s), lw, fg); }
  else if (label == "\xE2\x97\x8B") ring(cx, cy, s * 1.15f, lw, fg);
  else if (label == "\xE2\x96\xA1") roundRectStroke(cx - s, cy - s, 2 * s, 2 * s, 1, lw, fg);
  else if (label == "\xE2\x96\xB3") {
    vec2 a(cx, cy - s * 1.15f), b(cx + s * 1.2f, cy + s * 0.9f), c(cx - s * 1.2f, cy + s * 0.9f);
    line(a, b, lw, fg); line(b, c, lw, fg); line(c, a, lw, fg);
  } else text(cx, y + h * 0.5f - lineHeight(h * 0.62f, UiFont::Body) * 0.5f, h * 0.62f, UiFont::Body, fg, label, UiAlign::Center);
  return w;
}

// ---------------------------------------------------------------- text
const Ui::Glyph* Ui::glyph(UiFont f, uint32_t cp, UiFont* used) const {
  const UiFont chain[3] = {f, UiFont::Body, UiFont::CondBold};
  for (UiFont k : chain) {
    const FontData* fd = size_t(k) < fonts_.size() ? fonts_[size_t(k)].get() : nullptr;
    if (!fd || !fd->ok) continue;
    auto it = fd->glyphs.find(cp);
    if (it != fd->glyphs.end()) { if (used) *used = k; return &it->second; }
  }
  return nullptr;
}

float Ui::lineHeight(float size, UiFont) const { return size * 1.2f; }

float Ui::textWidth(const std::string& s, float size, UiFont f) const {
  float w = 0, k = size / BAKE;
  for (uint32_t cp : utf8Decode(s)) {
    UiFont u;
    const Glyph* g = glyph(f, cp, &u);
    if (!g && cp >= 0x2190 && cp <= 0x2193) { w += size * 0.62f; continue; }   // (arrows drawn as shapes)
    if (!g) g = glyph(f, '?', &u);
    if (g) w += g->adv * k;
  }
  return w;
}

float Ui::text(float x, float y, float size, UiFont f, const vec4& c, const std::string& s, UiAlign al) {
  float w = textWidth(s, size, f);
  if (al == UiAlign::Center) x -= w / 2;
  else if (al == UiAlign::Right) x -= w;
  const FontData* fd = size_t(f) < fonts_.size() ? fonts_[size_t(f)].get() : nullptr;
  float asc = fd && fd->ok ? fd->ascent : 0.8f, desc = fd && fd->ok ? fd->descent : -0.2f;
  float base = y + (lineHeight(size, f) - (asc - desc) * size) * 0.5f + asc * size;
  float k = size / BAKE, pen = x;
  for (uint32_t cp : utf8Decode(s)) {
    UiFont u = f;
    const Glyph* g = glyph(f, cp, &u);
    if (!g && cp >= 0x2190 && cp <= 0x2193) {
      // an arrow the fonts lack (Inter's latin subset): a small solid triangle, pointing the arrow's way
      float a = size * 0.62f, cx = pen + a / 2, cy = base - size * 0.33f, r = size * 0.24f;
      vec2 d = cp == 0x2190 ? vec2(-1, 0) : cp == 0x2191 ? vec2(0, -1) : cp == 0x2192 ? vec2(1, 0) : vec2(0, 1), n(-d.y, d.x);
      vec2 o(cx, cy);
      triRaw(o + d * r * 1.1f, o - d * r * 0.8f + n * r, o - d * r * 0.8f - n * r, c);
      pen += a;
      continue;
    }
    if (!g) g = glyph(f, '?', &u);
    if (!g) continue;
    if (g->ok) quad(pen + g->x0 * k, base + g->y0 * k, pen + g->x1 * k, base + g->y1 * k, g->u0, g->v0, g->u1, g->v1, c, 0, 0, 0, 0, 0, 0, 0, 0, atlas_);
    pen += g->adv * k;
  }
  return w;
}

float Ui::textWrapped(float x, float y, float maxW, float size, UiFont f, const vec4& c, const std::string& s, float gap) {
  std::string line, word;
  float yy = y, lh = size * gap;
  auto flush = [&]() { if (!line.empty()) { text(x, yy, size, f, c, line); yy += lh; line.clear(); } };
  for (size_t i = 0; i <= s.size(); i++) {
    char ch = i < s.size() ? s[i] : ' ';
    if (ch == '\n') { if (!word.empty()) { line += (line.empty() ? "" : " ") + word; word.clear(); } flush(); continue; }
    if (ch != ' ') { word += ch; continue; }
    if (word.empty()) continue;
    std::string cand = line.empty() ? word : line + " " + word;
    if (!line.empty() && textWidth(cand, size, f) > maxW) { flush(); line = word; }
    else line = cand;
    word.clear();
  }
  flush();
  return yy - y;
}

float Ui::textFit(float x, float y, float maxW, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a) {
  float w = textWidth(s, size, f);
  float sz = w > maxW && w > 0 ? std::max(size * 0.6f, size * maxW / w) : size;
  return text(x, y + (size - sz) * 0.6f, sz, f, c, s, a);
}

void Ui::pushClip(float x, float y, float w, float h) {
  if (!clips_.empty()) {
    const vec4& k = clips_.back();
    float x0 = std::max(x, k.x), y0 = std::max(y, k.y), x1 = std::min(x + w, k.x + k.z), y1 = std::min(y + h, k.y + k.w);
    clips_.push_back(vec4(x0, y0, std::max(0.f, x1 - x0), std::max(0.f, y1 - y0)));
  } else clips_.push_back(vec4(x, y, w, h));
}
void Ui::popClip() { if (!clips_.empty()) clips_.pop_back(); }

} // namespace sl
