#include "engine/ui.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iterator>
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
constexpr int ATLAS = 4096;
constexpr float BAKE = 56;        // glyphs are baked at a 56 px em (sharp corners up to the 2x logo)
constexpr int PAD = 8;
constexpr unsigned char ONEDGE = 128;
constexpr float PDS = 128.f / PAD;
constexpr size_t kFontFiles = 5;   // inter, barlow 600, 700, 700 italic, 800 italic
// UiFont -> the font file and its weight: the edge moved out by `bold` em on each side (Inter is the variable font at its
// default 400: 500 / 600 / 700 / 800 are emboldened from the same outlines, the advances widened with them)
struct FontPick { int file; float bold; };
const FontPick FONT_PICK[size_t(UiFont::Count)] = {
  {0, 0}, {1, 0}, {2, 0}, {3, 0}, {4, 0},            // Body, Cond, CondBold, CondItalic, CondHeavy
  {0, 0.007f}, {0, 0.015f}, {0, 0.023f}, {0, 0.03f}, // BodyMed, BodySemi, BodyBold, BodyHeavy
  {3, -0.008f},                                      // CondSemiItalic (600 italic from the 700 italic)
};
constexpr float kBoldAdv = 1.5f;   // advance widening per em of bold

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
  if (vQ.y < 0.5) {                 // SDF glyph (vQ.x: the weight, an offset of the edge)
    float d = texture(uTex, vUv).r;
    float w = max(fwidth(d) * 0.7, 0.002);
    a = smoothstep(0.5 - vQ.x - w, 0.5 - vQ.x + w, d);
  } else if (vQ.y < 1.5) {          // rounded rect (vP.xy local px from the centre, vP.zw half size, vQ.x radius)
    a = clamp(0.5 - sdRound(vP.xy, vP.zw, vQ.x), 0.0, 1.0);
  } else if (vQ.y < 2.5) {          // rounded rect outline (stroke width in vUv.x)
    float d = sdRound(vP.xy, vP.zw, vQ.x);
    a = clamp(0.5 - abs(d + vUv.x * 0.5) + vUv.x * 0.5, 0.0, 1.0);
  } else if (vQ.y < 3.5) {          // flat (triangles, polygons)
    a = 1.0;
  } else if (vQ.y < 4.5) {          // image
    c *= texture(uTex, vUv);
  } else {                          // alpha mask (the paper shapes, their shadows, text shadows)
    a = texture(uTex, vUv).r;
  }
  oColor = vec4(c.rgb, c.a * a);
}
)GLSL";

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
  static const char* files[kFontFiles] = {"fonts/inter.ttf", "fonts/barlow-condensed-600.ttf", "fonts/barlow-condensed-700.ttf",
                                                     "fonts/barlow-condensed-700-italic.ttf", "fonts/barlow-condensed-800-italic.ttf"};
  std::vector<uint32_t> cps;
  for (uint32_t c = 32; c < 127; c++) cps.push_back(c);
  for (uint32_t c = 160; c < 256; c++) cps.push_back(c);
  for (uint32_t c : {0x2014u, 0x2013u, 0x2026u, 0x2022u, 0x2190u, 0x2191u, 0x2192u, 0x2193u, 0x2212u, 0x20ACu, 0x2018u, 0x2019u, 0x201Cu, 0x201Du, 0x2715u, 0x25CBu, 0x25A1u, 0x25B3u, 0x00D7u})
    cps.push_back(c);
  std::vector<uint8_t> px(size_t(ATLAS) * ATLAS, 0);
  int x = 1, y = 1, rowH = 0;
  bool full = false;
  for (size_t fi = 0; fi < kFontFiles; fi++) {
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
      G.gi = gi;
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
  return fonts_[0]->ok || fonts_[2]->ok;
}

bool Ui::init(gfx::Device& dev, platform::Platform& plat, const AssetPaths& paths) {
  dev_ = &dev;
  plat_ = &plat;
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
  dpr_ = plat_ ? std::clamp(plat_->pixelRatio(), 0.5f, 4.f) : 1.f;
  // the shape masks nobody drew for a while go (a resize, a screen left, a label that changed)
  frame_++;
  maskBuilds_ = 0;
  if (masks_.size() > 64 || maskBytes_ > (size_t(48) << 20)) {
    uint64_t keep = maskBytes_ > (size_t(96) << 20) ? 2 : 90;
    for (auto it = masks_.begin(); it != masks_.end();) {
      if (frame_ - it->second.used > keep) { maskBytes_ -= size_t(it->second.w) * size_t(it->second.h); dev_->destroy(it->second.tex); it = masks_.erase(it); }
      else ++it;
    }
  }
  verts_.clear();
  batches_.clear();
  clips_.clear();
  xf_.clear();
  alpha_.clear();
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
void Ui::quad(float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, const vec4& cIn,
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
  vec2 p00 = X(x0, y0), p10 = X(x1, y0), p11 = X(x1, y1), p01 = X(x0, y1);
  const vec4 c = vec4(cIn.x, cIn.y, cIn.z, cIn.w * A());
  Vert a{p00.x, p00.y, u0, v0, c.x, c.y, c.z, c.w, lx0, ly0, hw, hh, rad, mode};
  Vert b{p10.x, p10.y, u1, v0, c.x, c.y, c.z, c.w, lx1, ly0, hw, hh, rad, mode};
  Vert d{p11.x, p11.y, u1, v1, c.x, c.y, c.z, c.w, lx1, ly1, hw, hh, rad, mode};
  Vert e{p01.x, p01.y, u0, v1, c.x, c.y, c.z, c.w, lx0, ly1, hw, hh, rad, mode};
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
  auto V = [&](vec2 p, const vec4& c) { vec2 q = X(p.x, p.y); return Vert{q.x, q.y, 0, 0, c.x, c.y, c.z, c.w * A(), 0, 0, 0, 0, 0, 3}; };
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
  auto V = [&](vec2 p) { vec2 q = X(p.x, p.y); return Vert{q.x, q.y, 0, 0, col.x, col.y, col.z, col.w * A(), 0, 0, 0, 0, 0, 3}; };
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
  if (!dropShadows) return;
  for (int i = 3; i >= 1; i--) {
    float s = spread * float(i) / 3.f;
    roundRect(x - s, y - s * 0.4f + spread * 0.5f, w + 2 * s, h + 2 * s, r + s, vec4(0.0f, 0.08f, 0.24f, alpha / 3.f));
  }
}

// ---------------------------------------------------------------- the paper shapes (CPU masks)
namespace {
uint64_t hashMix(uint64_t h, uint64_t v) { return (h ^ (v + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2))) * 1099511628211ull; }
int64_t q4(float v) { return int64_t(std::lround(double(v) * 4)); }

// a path in stb_truetype's vertex form (moves, lines, quadratic curves), in units of 1 / kScale
struct Path {
  std::vector<stbtt_vertex> v;
  float scale = 16;   // path units per stored unit
  void put(unsigned char type, float x, float y, float cx = 0, float cy = 0) {
    stbtt_vertex q{};
    q.type = type;
    q.x = stbtt_vertex_type(std::lround(x * scale)); q.y = stbtt_vertex_type(std::lround(y * scale));
    q.cx = stbtt_vertex_type(std::lround(cx * scale)); q.cy = stbtt_vertex_type(std::lround(cy * scale));
    v.push_back(q);
  }
  void M(float x, float y) { put(STBTT_vmove, x, y); }
  void L(float x, float y) { put(STBTT_vline, x, y); }
  void Q(float cx, float cy, float x, float y) { put(STBTT_vcurve, x, y, cx, cy); }
  /// rasterises into px (W x H): path unit (0, 0) at (ox, oy), sx / sy drawable px per path unit
  void raster(std::vector<uint8_t>& px, int W, int H, float sx, float sy, float ox, float oy) {
    if (v.empty()) return;
    stbtt__bitmap bm{W, H, W, px.data()};
    stbtt_Rasterize(&bm, 0.25f, v.data(), int(v.size()), sx / scale, sy / scale, ox, oy, 0, 0, 0, nullptr);
  }
};

const vec2 BRUSH_A[] = {{1, 14}, {7, 4}, {31, 9}, {56, 2}, {79, 8}, {96, 0}, {100, 20}, {97.5f, 42}, {100, 63}, {96.5f, 86}, {99, 100}, {71, 93}, {46, 99}, {21, 92}, {3, 98}, {0, 72}, {2, 46}, {0, 26}};
const vec2 BRUSH_B[] = {{0, 8}, {22, 2}, {48, 7}, {74, 0}, {98, 6}, {100, 34}, {97, 58}, {100, 90}, {82, 97}, {55, 92}, {30, 100}, {6, 94}, {1, 68}, {3, 40}};

// menu.js rng(seed)
struct Rng {
  double s;
  explicit Rng(int seed) : s(double(seed) * 9301 + 49297) {}
  double operator()() { s = std::fmod(s * 233280 + 49297, 2147483647.0); return s / 2147483647.0; }
};
float n1(double v) { return float(std::round(v * 10) / 10); }   // (toFixed(1): the SVG path's precision)

// menu.js brushSVG(seed, w, h): the outline, point for point (quadratic curves through the edge samples)
Path strokePath(int seed, float w, float h) {
  Path P;
  P.scale = std::min(16.f, 30000.f / std::max(w, h));
  Rng r(seed);
  r();
  float tail = std::min(w * 0.24f, h * 0.62f), x1 = w - tail, xa = std::min(h * 0.16f, w * 0.06f);
  double ph[4] = {r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283};
  auto top = [&](double X) { return h * 0.12 + std::sin(X / w * 5.1 + ph[0]) * h * 0.022 + std::sin(X / w * 12.7 + ph[1]) * h * 0.011; };
  auto bot = [&](double X) { return h * 0.88 + std::sin(X / w * 4.3 + ph[2]) * h * 0.022 + std::sin(X / w * 11.3 + ph[3]) * h * 0.011; };
  int N = std::max(8, int(std::round((x1 - xa) / (h * 0.42f))));
  std::vector<vec2> T, B;
  for (int i = 0; i <= N; i++) {
    double X = xa + double(x1 - xa) * i / N;
    T.push_back(vec2(float(X), float(top(X) + (r() - 0.5) * h * 0.008)));
    B.push_back(vec2(float(X), float(bot(X) + (r() - 0.5) * h * 0.008)));
  }
  // smoothTo: quadratic curves through the midpoints, a line to the last point
  auto smooth = [&](const std::vector<vec2>& Pp) {
    for (size_t i = 1; i + 1 < Pp.size(); i++) P.Q(n1(Pp[i].x), n1(Pp[i].y), n1((Pp[i].x + Pp[i + 1].x) / 2), n1((Pp[i].y + Pp[i + 1].y) / 2));
    P.L(n1(Pp.back().x), n1(Pp.back().y));
  };
  P.M(n1(T[0].x), n1(T[0].y));
  smooth(T);
  float yT = T[size_t(N)].y, yB = B[size_t(N)].y;
  int F = 8 + int(std::floor(r() * 5));
  std::vector<double> wts;
  double sum = 0;
  for (int k = 0; k < F; k++) { double v = 0.45 + r() * 1.1; wts.push_back(v); sum += v; }
  double y0 = yT, acc = 0;
  for (int k = 0; k < F; k++) {
    acc += wts[size_t(k)];
    double y1 = k == F - 1 ? yB : yT + (yB - yT) * acc / sum;
    double ym = y0 + (y1 - y0) * (0.35 + r() * 0.3);
    bool outer = k == 0 || k == F - 1;
    double len = tail * (outer ? 0.25 + r() * 0.35 : 0.3 + r() * 0.7);
    double tipX = std::min(double(w) - 1, x1 + len);
    P.Q(n1(x1 + len * 0.55), n1(y0 + (ym - y0) * 0.25), n1(tipX), n1(ym));
    if (k < F - 1) {
      double notch = x1 - tail * 0.16 * r();
      P.Q(n1(x1 + len * 0.45), n1(y1 - (y1 - ym) * 0.35), n1(notch), n1(y1));
    } else P.Q(n1(x1 + len * 0.5), n1(y1 - (y1 - ym) * 0.25), n1(x1), n1(yB));
    y0 = y1;
  }
  std::vector<vec2> Br(B.rbegin(), B.rend());
  smooth(Br);
  double capX = h * (0.015 + r() * 0.03), capY = h * (0.5 + (r() - 0.5) * 0.06);
  P.Q(n1(capX + h * 0.02), n1(h * 0.86), n1(capX), n1(capY));
  P.Q(n1(capX + h * 0.02), n1(h * 0.14), n1(T[0].x), n1(T[0].y));
  return P;
}

// a separable Gaussian (three box passes) over an 8-bit mask
void blurMask(std::vector<uint8_t>& px, int W, int H, float sigma) {
  if (sigma < 0.3f) return;
  // box widths for 3 passes (Kovesi)
  double wIdeal = std::sqrt(12.0 * sigma * sigma / 3 + 1);
  int wl = int(std::floor(wIdeal));
  if (wl % 2 == 0) wl--;
  int wu = wl + 2;
  double mIdeal = (12.0 * sigma * sigma - 3.0 * wl * wl - 4.0 * 3 * wl - 3.0 * 3) / (-4.0 * wl - 4);
  int m = int(std::lround(mIdeal));
  std::vector<float> a(px.begin(), px.end()), b(a.size());
  auto pass = [&](std::vector<float>& src, std::vector<float>& dst, int r, bool horiz) {
    int n = horiz ? W : H, lines = horiz ? H : W;
    size_t step = horiz ? 1 : size_t(W);
    float inv = 1.f / float(2 * r + 1);
    for (int l = 0; l < lines; l++) {
      size_t base = horiz ? size_t(l) * size_t(W) : size_t(l);
      float acc = 0;
      for (int i = -r - 1; i < r; i++) { int j = std::clamp(i, 0, n - 1); acc += (i >= 0 && i < n) ? src[base + size_t(j) * step] : 0; }
      for (int i = 0; i < n; i++) {
        int add = i + r, sub = i - r - 1;
        acc += add < n ? src[base + size_t(add) * step] : 0;
        acc -= sub >= 0 ? src[base + size_t(sub) * step] : 0;
        dst[base + size_t(i) * step] = acc * inv;
      }
    }
  };
  for (int k = 0; k < 3; k++) {
    int r = ((k < m ? wl : wu) - 1) / 2;
    pass(a, b, r, true);
    pass(b, a, r, false);
  }
  for (size_t i = 0; i < px.size(); i++) px[i] = uint8_t(std::clamp(a[i] + 0.5f, 0.f, 255.f));
}
} // namespace

float Ui::cssU() const {
  float cw = float(w_) / dpr_, ch = float(h_) / dpr_;
  return std::clamp(std::min(ch * 0.00125f, cw * 0.00078125f), 0.7f, 2.2f) * dpr_;
}

void Ui::maskDraw(uint64_t key, float x, float y, float w, float h, float sigma, const vec4& c, const Raster& r) {
  if (w <= 0.5f || h <= 0.5f || c.w <= 0.f) return;
  float fx = std::floor(x), fy = std::floor(y);
  float subX = float(q4(x - fx)) / 4, subY = float(q4(y - fy)) / 4;
  int pad = sigma > 0 ? int(std::ceil(sigma * 3)) + 2 : 2;
  uint64_t k = hashMix(hashMix(hashMix(hashMix(hashMix(key, uint64_t(q4(w))), uint64_t(q4(h))), uint64_t(q4(subX))), uint64_t(q4(subY))), uint64_t(q4(sigma)));
  auto it = masks_.find(k);
  if (it == masks_.end()) {
    Mask m;
    m.pad = pad;
    m.w = int(std::ceil(w + subX)) + 2 * pad;
    m.h = int(std::ceil(h + subY)) + 2 * pad;
    if (size_t(m.w) * size_t(m.h) > size_t(8192) * 4096) return;
    std::vector<uint8_t> px(size_t(m.w) * size_t(m.h), 0);
    r(px, m.w, m.h, float(pad) + subX, float(pad) + subY);
    if (sigma > 0) blurMask(px, m.w, m.h, sigma);
    gfx::TextureDesc td;
    td.width = m.w; td.height = m.h; td.format = gfx::TexFormat::R8; td.filter = gfx::Filter::Linear; td.wrap = gfx::Wrap::Clamp; td.mipmaps = false; td.anisotropy = 1;
    m.tex = dev_->createTexture(td, px.data());
    maskBytes_ += px.size();
    maskBuilds_++;
    it = masks_.emplace(k, m).first;
  }
  Mask& m = it->second;
  m.used = frame_;
  float x0 = fx - float(m.pad), y0 = fy - float(m.pad);
  quad(x0, y0, x0 + float(m.w), y0 + float(m.h), 0, 0, 1, 1, c, 0, 0, 0, 0, 0, 0, 0, 5, m.tex);
}

void Ui::drawShape(uint64_t key, float x, float y, float w, float h, const vec4& c, const Shadow* sh, const Raster& r) {
  if (dropShadows && sh && sh->color.w > 0) maskDraw(key, x + sh->dx, y + sh->dy, w, h, sh->blur * 0.5f, vec4(vec3(sh->color), sh->color.w * c.w), r);
  maskDraw(key, x, y, w, h, 0, c, r);
}

void Ui::brushPanel(float x, float y, float w, float h, const vec4& c, int variant, const Shadow* sh) {
  bool b = variant == 1;
  drawShape(hashMix(0xB0B0ull, b ? 2 : 1), x, y, w, h, c, sh, [w, h, b](std::vector<uint8_t>& px, int W, int H, float ox, float oy) {
    Path P;
    P.scale = std::min(8.f, 30000.f / std::max(w, h));
    const vec2* pts = b ? BRUSH_B : BRUSH_A;
    size_t n = b ? std::size(BRUSH_B) : std::size(BRUSH_A);
    for (size_t i = 0; i < n; i++) { float px_ = pts[i].x / 100.f * w, py_ = pts[i].y / 100.f * h; if (i == 0) P.M(px_, py_); else P.L(px_, py_); }
    P.L(pts[0].x / 100.f * w, pts[0].y / 100.f * h);
    P.raster(px, W, H, 1, 1, ox, oy);
  });
}

void Ui::clipPoly(float x, float y, float w, float h, const vec4& c, const std::vector<vec4>& pts, uint64_t id, const Shadow* sh) {
  drawShape(hashMix(0xC11Bull, id), x, y, w, h, c, sh, [w, h, pts](std::vector<uint8_t>& px, int W, int H, float ox, float oy) {
    Path P;
    P.scale = std::min(8.f, 30000.f / std::max(w, h));
    for (size_t i = 0; i < pts.size(); i++) {
      float px_ = pts[i].x * w + pts[i].y, py_ = pts[i].z * h + pts[i].w;
      if (i == 0) P.M(px_, py_); else P.L(px_, py_);
    }
    if (!pts.empty()) P.L(pts[0].x * w + pts[0].y, pts[0].z * h + pts[0].w);
    P.raster(px, W, H, 1, 1, ox, oy);
  });
}

void Ui::brushClip(float x, float y, float w, float h, const vec4& c, int seed, float amp, float side, float u, const Shadow* sh) {
  // menu.js brushClip: 15 points along the top (ragged by amp u), 4 down the right (side u), the bottom, the left
  Rng r(seed + 7);
  r();
  const int NX = 14, NY = 5;
  std::vector<vec4> pts;
  for (int i = 0; i <= NX; i++) pts.push_back(vec4(float(i) / NX, 0, 0, n1(r() * amp) * u));
  for (int j = 1; j < NY; j++) pts.push_back(vec4(1, -n1(r() * side) * u, float(j) / NY, 0));
  for (int i = NX; i >= 0; i--) pts.push_back(vec4(float(i) / NX, 0, 1, -n1(r() * amp) * u));
  for (int j = NY - 1; j >= 1; j--) pts.push_back(vec4(0, n1(r() * side) * u, float(j) / NY, 0));
  clipPoly(x, y, w, h, c, pts, hashMix(hashMix(hashMix(uint64_t(seed), uint64_t(q4(amp))), uint64_t(q4(side))), uint64_t(q4(u))), sh);
}

float Ui::brushTextEnd(float w, float h) {
  float tail = std::min(w * 0.24f, h * 0.62f);
  return (w - tail * 1.16f) / w;
}

void Ui::brushStroke(float x, float y, float w, float h, const vec4& c, int seed, float vbW, float vbH, const Shadow* sh) {
  drawShape(hashMix(hashMix(hashMix(0x57B0ull, uint64_t(seed)), uint64_t(q4(vbW))), uint64_t(q4(vbH))), x, y, w, h, c, sh,
            [w, h, seed, vbW, vbH](std::vector<uint8_t>& px, int W, int H, float ox, float oy) {
    Path P = strokePath(seed, vbW, vbH);
    P.raster(px, W, H, w / vbW, h / vbH, ox, oy);   // (preserveAspectRatio="none": stretched to the box)
  });
}

// ---------------------------------------------------------------- keycaps (style.css .kc)
float Ui::kcHeight(float u) const { return std::max(17.f * dpr_, 22 * u); }

namespace {
bool isArrow(const std::string& l) { return l == "\xE2\x86\x90" || l == "\xE2\x86\x91" || l == "\xE2\x86\x92" || l == "\xE2\x86\x93"; }
bool isPsGlyph(const std::string& l) { return l == "\xE2\x9C\x95" || l == "\xE2\x97\x8B" || l == "\xE2\x96\xA1" || l == "\xE2\x96\xB3"; }
} // namespace

float Ui::kcWidth(float u, const std::string& label) {
  float h = kcHeight(u), minW = std::max(18.f * dpr_, 24 * u);
  if (isArrow(label)) return minW;
  if (isPsGlyph(label)) return std::max(minW, h);
  float fs = std::max(11.f * dpr_, 11 * u);
  float padX = utf8Decode(label).size() > 1 ? std::max(5.f * dpr_, 7 * u) : std::max(4.f * dpr_, 6 * u);
  return std::max(minW, textWidth(label, fs, UiFont::BodyBold, 0.06f) + 2 * padX + 3 * dpr_);
}

float Ui::kc(float x, float y, float u, const std::string& label, const vec4& fg, const vec4& bg, const vec4& border) {
  float w = kcWidth(u, label), h = kcHeight(u), r = std::max(4.f * dpr_, 5 * u), bw = 1.5f * dpr_;
  vec4 bc = border.x < 0 ? fg : border;
  if (bg.w > 0) roundRect(x, y, w, h, r, bg);
  roundRectStroke(x, y, w, h, r, bw, bc);
  float cx = x + w / 2, cy = y + h / 2;
  if (isArrow(label)) {
    // .kc-arrow::before: a 28 % square's left + bottom border (2 px), rotated to point the way
    float s = w * 0.28f, lw = 2 * dpr_;
    vec2 d = label == "\xE2\x86\x90" ? vec2(-1, 0) : label == "\xE2\x86\x91" ? vec2(0, -1) : label == "\xE2\x86\x92" ? vec2(1, 0) : vec2(0, 1);
    vec2 n(-d.y, d.x), tip = vec2(cx, cy) + d * (s * 0.36f);
    float arm = s * 0.98f;
    vec2 a0 = tip - d * arm * 0.7071f + n * arm * 0.7071f, a1 = tip - d * arm * 0.7071f - n * arm * 0.7071f;
    line(a0, tip + (tip - a0) * (lw * 0.35f / arm), lw, fg);
    line(a1, tip + (tip - a1) * (lw * 0.35f / arm), lw, fg);
    return w;
  }
  if (isPsGlyph(label)) {
    float s = h * 0.24f, lw = std::max(1.5f * dpr_, h * 0.08f);
    if (label == "\xE2\x9C\x95") { line(vec2(cx - s, cy - s), vec2(cx + s, cy + s), lw, fg); line(vec2(cx - s, cy + s), vec2(cx + s, cy - s), lw, fg); }
    else if (label == "\xE2\x97\x8B") ring(cx, cy, s * 1.15f, lw, fg);
    else if (label == "\xE2\x96\xA1") roundRectStroke(cx - s, cy - s, 2 * s, 2 * s, 1, lw, fg);
    else {
      vec2 a(cx, cy - s * 1.15f), b(cx + s * 1.2f, cy + s * 0.9f), c(cx - s * 1.2f, cy + s * 0.9f);
      line(a, b, lw, fg); line(b, c, lw, fg); line(c, a, lw, fg);
    }
    return w;
  }
  float fs = std::max(11.f * dpr_, 11 * u);
  // font: 700 t-xs / 1, letter-spacing 0.06em (the trailing spacing included, as in the browser)
  text(cx, cy - lineHeight(fs, UiFont::BodyBold) * 0.5f + fs * 0.04f, fs, UiFont::BodyBold, fg, label, UiAlign::Center, 0.06f);
  return w;
}

float Ui::keycapWidth(float h, const std::string& label) { return kcWidth(h / 22.f, label); }
float Ui::keycap(float x, float y, float h, const std::string& label, bool inverted) {
  float u = h / 22.f;
  return inverted ? kc(x, y, u, label, ui_color::blue, ui_color::white, ui_color::white) : kc(x, y, u, label, ui_color::white);
}

// ---------------------------------------------------------------- text
int Ui::fileOf(UiFont f) const { return FONT_PICK[std::min(size_t(f), size_t(UiFont::Count) - 1)].file; }

const Ui::Glyph* Ui::glyph(UiFont f, uint32_t cp, int* usedFile) const {
  const int chain[3] = {fileOf(f), 0, 2};
  for (int k : chain) {
    const FontData* fd = size_t(k) < fonts_.size() ? fonts_[size_t(k)].get() : nullptr;
    if (!fd || !fd->ok) continue;
    auto it = fd->glyphs.find(cp);
    if (it != fd->glyphs.end()) { if (usedFile) *usedFile = k; return &it->second; }
  }
  return nullptr;
}

float Ui::lineHeight(float size, UiFont) const { return size * 1.2f; }
float Ui::ascent(UiFont f) const { const FontData* fd = size_t(fileOf(f)) < fonts_.size() ? fonts_[size_t(fileOf(f))].get() : nullptr; return fd && fd->ok ? fd->ascent : 0.8f; }
float Ui::descent(UiFont f) const { const FontData* fd = size_t(fileOf(f)) < fonts_.size() ? fonts_[size_t(fileOf(f))].get() : nullptr; return fd && fd->ok ? fd->descent : -0.2f; }

namespace {
// the pen advance of one code point (with the pair kerning to the next one, GPOS / kern as a browser applies it)
struct Pen { int file = -1, gi = 0; };
} // namespace

float Ui::textWidth(const std::string& s, float size, UiFont f, float tracking) const {
  float w = 0, k = size / BAKE, bold = FONT_PICK[size_t(f)].bold * kBoldAdv * size;
  Pen prev;
  for (uint32_t cp : utf8Decode(s)) {
    int u = -1;
    const Glyph* g = glyph(f, cp, &u);
    if (!g && cp >= 0x2190 && cp <= 0x2193) { w += size * 0.62f + tracking * size; prev = {}; continue; }   // (arrows drawn as shapes)
    if (!g) g = glyph(f, '?', &u);
    if (!g) continue;
    if (prev.file == u && u >= 0) w += float(stbtt_GetGlyphKernAdvance(&fonts_[size_t(u)]->info, prev.gi, g->gi)) * fonts_[size_t(u)]->bakeScale * k;
    w += g->adv * k + bold + tracking * size;
    prev = {u, g->gi};
  }
  return w;
}

float Ui::text(float x, float y, float size, UiFont f, const vec4& c, const std::string& s, UiAlign al, float tracking) {
  float w = textWidth(s, size, f, tracking);
  if (al == UiAlign::Center) x -= w / 2;
  else if (al == UiAlign::Right) x -= w;
  float asc = ascent(f), desc = descent(f);
  float base = y + (lineHeight(size, f) - (asc - desc) * size) * 0.5f + asc * size;
  float k = size / BAKE, pen = x;
  float boldEm = FONT_PICK[size_t(f)].bold, bold = boldEm * kBoldAdv * size;
  // the weight as an offset of the SDF edge (normalised distance per baked pixel: PDS / 255)
  float thr = boldEm * BAKE * PDS / 255.f;
  Pen prev;
  for (uint32_t cp : utf8Decode(s)) {
    int u = -1;
    const Glyph* g = glyph(f, cp, &u);
    if (!g && cp >= 0x2190 && cp <= 0x2193) {
      // an arrow the fonts lack (Inter's latin subset): a small solid triangle, pointing the arrow's way
      float a = size * 0.62f, cx = pen + a / 2, cy = base - size * 0.33f, r = size * 0.24f;
      vec2 d = cp == 0x2190 ? vec2(-1, 0) : cp == 0x2191 ? vec2(0, -1) : cp == 0x2192 ? vec2(1, 0) : vec2(0, 1), n(-d.y, d.x);
      vec2 o(cx, cy);
      triRaw(o + d * r * 1.1f, o - d * r * 0.8f + n * r, o - d * r * 0.8f - n * r, c);
      pen += a + tracking * size;
      prev = {};
      continue;
    }
    if (!g) g = glyph(f, '?', &u);
    if (!g) continue;
    if (prev.file == u && u >= 0) pen += float(stbtt_GetGlyphKernAdvance(&fonts_[size_t(u)]->info, prev.gi, g->gi)) * fonts_[size_t(u)]->bakeScale * k;
    float gx = pen + bold * 0.5f;
    if (g->ok) quad(gx + g->x0 * k, base + g->y0 * k, gx + g->x1 * k, base + g->y1 * k, g->u0, g->v0, g->u1, g->v1, c, 0, 0, 0, 0, 0, 0, u == fileOf(f) ? thr : 0, 0, atlas_);
    pen += g->adv * k + bold + tracking * size;
    prev = {u, g->gi};
  }
  return w;
}

float Ui::textLH(float x, float yTop, float lh, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a, float tracking) {
  return text(x, yTop + (lh - lineHeight(size, f)) * 0.5f, size, f, c, s, a, tracking);
}

void Ui::textShadow(float x, float y, float size, UiFont f, const std::string& s, UiAlign al, float tracking, float dx, float dy, float blur, const vec4& c) {
  if (s.empty() || c.w <= 0) return;
  float w = textWidth(s, size, f, tracking);
  if (al == UiAlign::Center) x -= w / 2;
  else if (al == UiAlign::Right) x -= w;
  float asc = ascent(f), desc = descent(f), lh = lineHeight(size, f);
  float baseOff = (lh - (asc - desc) * size) * 0.5f + asc * size;
  uint64_t key = 1469598103934665603ull;
  auto mix = [&](uint64_t v) { key = (key ^ v) * 1099511628211ull; };
  for (char ch : s) mix(uint64_t(uint8_t(ch)));
  mix(uint64_t(f) + 77); mix(uint64_t(std::lround(size * 8))); mix(uint64_t(std::lround(tracking * 1000))); mix(uint64_t(std::lround(blur * 4)));
  int fileF = fileOf(f);
  float boldEm = FONT_PICK[size_t(f)].bold;
  maskDraw(key, x + dx, y + dy, w, lh, blur * 0.5f, c, [this, s, size, f, tracking, baseOff, fileF, boldEm](std::vector<uint8_t>& px, int W, int H, float ox, float oy) {
    float k = size / BAKE, pen = ox, bold = boldEm * kBoldAdv * size;
    std::vector<uint8_t> tmp;
    Pen prev;
    for (uint32_t cp : utf8Decode(s)) {
      int u = -1;
      const Glyph* g = glyph(f, cp, &u);
      if (!g) { pen += size * 0.62f + tracking * size; prev = {}; continue; }
      const FontData& fd = *fonts_[size_t(u)];
      if (prev.file == u) pen += float(stbtt_GetGlyphKernAdvance(&fd.info, prev.gi, g->gi)) * fd.bakeScale * k;
      float sc = fd.bakeScale * k, gx = pen + bold * 0.5f, by = oy + baseOff;
      int x0, y0, x1, y1;
      stbtt_GetGlyphBitmapBoxSubpixel(&fd.info, g->gi, sc, sc, gx - std::floor(gx), by - std::floor(by), &x0, &y0, &x1, &y1);
      int gw = x1 - x0, gh = y1 - y0;
      if (gw > 0 && gh > 0) {
        tmp.assign(size_t(gw) * size_t(gh), 0);
        stbtt_MakeGlyphBitmapSubpixel(&fd.info, tmp.data(), gw, gh, gw, sc, sc, gx - std::floor(gx), by - std::floor(by), g->gi);
        int bx = int(std::floor(gx)) + x0, byy = int(std::floor(by)) + y0;
        for (int r = 0; r < gh; r++) {
          int yy = byy + r;
          if (yy < 0 || yy >= H) continue;
          for (int q = 0; q < gw; q++) {
            int xx = bx + q;
            if (xx < 0 || xx >= W) continue;
            uint8_t& d = px[size_t(yy) * size_t(W) + size_t(xx)];
            d = std::max(d, tmp[size_t(r) * size_t(gw) + size_t(q)]);
          }
        }
      }
      pen += g->adv * k + bold + tracking * size;
      prev = {u, g->gi};
    }
  });
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

float Ui::textFit(float x, float y, float maxW, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a, float tracking) {
  float w = textWidth(s, size, f, tracking);
  float sz = w > maxW && w > 0 ? std::max(size * 0.6f, size * maxW / w) : size;
  return text(x, y + (size - sz) * 0.6f, sz, f, c, s, a, tracking);
}

void Ui::pushClip(float x, float y, float w, float h) {
  if (!clips_.empty()) {
    const vec4& k = clips_.back();
    float x0 = std::max(x, k.x), y0 = std::max(y, k.y), x1 = std::min(x + w, k.x + k.z), y1 = std::min(y + h, k.y + k.w);
    clips_.push_back(vec4(x0, y0, std::max(0.f, x1 - x0), std::max(0.f, y1 - y0)));
  } else clips_.push_back(vec4(x, y, w, h));
}
void Ui::popClip() { if (!clips_.empty()) clips_.pop_back(); }

void Ui::pushRotate(float cx, float cy, float r) {
  Xf t;
  float c = std::cos(r), s = std::sin(r);
  t.a = c; t.b = s; t.c = -s; t.d = c;
  t.e = cx - (c * cx - s * cy); t.f = cy - (s * cx + c * cy);
  if (!xf_.empty()) {   // (composed with the one in force: outer * t)
    const Xf& o = xf_.back();
    Xf m;
    m.a = o.a * t.a + o.c * t.b; m.b = o.b * t.a + o.d * t.b;
    m.c = o.a * t.c + o.c * t.d; m.d = o.b * t.c + o.d * t.d;
    m.e = o.a * t.e + o.c * t.f + o.e; m.f = o.b * t.e + o.d * t.f + o.f;
    t = m;
  }
  xf_.push_back(t);
}
void Ui::pushTranslate(float dx, float dy) {
  Xf t;
  if (!xf_.empty()) t = xf_.back();
  t.e += dx; t.f += dy;
  xf_.push_back(t);
}
void Ui::popTransform() { if (!xf_.empty()) xf_.pop_back(); }

void Ui::gradientGrid(float x, float y, float w, float h, int nx, int ny, const std::function<vec4(float, float)>& col) {
  if (w <= 0 || h <= 0) return;
  nx = std::max(1, nx); ny = std::max(1, ny);
  useTexture(white_);
  std::vector<vec4> c(size_t(nx + 1) * size_t(ny + 1));
  for (int j = 0; j <= ny; j++) for (int i = 0; i <= nx; i++) c[size_t(j) * size_t(nx + 1) + size_t(i)] = col(float(i) / nx, float(j) / ny);
  auto V = [&](int i, int j) {
    const vec4& k = c[size_t(j) * size_t(nx + 1) + size_t(i)];
    vec2 q = X(x + w * float(i) / nx, y + h * float(j) / ny);
    return Vert{q.x, q.y, 0, 0, k.x, k.y, k.z, k.w * A(), 0, 0, 0, 0, 0, 3};
  };
  for (int j = 0; j < ny; j++)
    for (int i = 0; i < nx; i++) verts_.insert(verts_.end(), {V(i, j), V(i + 1, j), V(i + 1, j + 1), V(i, j), V(i + 1, j + 1), V(i, j + 1)});
}

} // namespace sl
