// A small immediate-mode 2D layer for the menus, the HUD and the trail map (Phase 4).
//
// Everything is drawn in drawable pixels (origin top-left) into one vertex list per frame and flushed after the 3D
// frame (Renderer::endFrame) in as few draws as the textures allow. Shapes: rectangles, rounded rectangles and their
// outlines (signed distance in the shader, anti-aliased), circles, triangles, convex polygons (the house style's
// paint-brush silhouettes), lines; textured quads (the trail map's relief); text from signed-distance glyph atlases
// baked with stb_truetype from the game's fonts (Barlow Condensed for headings / numbers, Inter for body text), so one
// atlas serves every size. Axis-aligned quads (rects, rounded rects, glyphs, images) are clipped on the CPU to a clip
// rectangle stack (scrolling lists); polygons are not clipped.
#pragma once
#include "core/math.h"
#include "gfx/gfx.h"
#include <functional>
#include <memory>
#include <unordered_map>
#include <string>
#include <vector>

namespace sl {
class AssetPaths;
namespace platform { class Platform; }

/// Body = Inter (style.css --ui) at 400; BodyMed / BodySemi / BodyBold / BodyHeavy = Inter 500 / 600 / 700 / 800 (the
/// variable font's weights, emboldened from the same outlines); Cond = Barlow Condensed 600, CondBold 700, CondItalic 700
/// italic, CondHeavy 800 italic, CondSemiItalic 600 italic (style.css --num)
enum class UiFont : uint8_t { Body, Cond, CondBold, CondItalic, CondHeavy, BodyMed, BodySemi, BodyBold, BodyHeavy, CondSemiItalic, Count };
enum class UiAlign : uint8_t { Left, Center, Right };
/// how what is drawn meets what is under it: Normal (source-over), Premultiplied (source-over with premultiplied
/// output: the mode for premultiplied textures, see Ui::mesh), Add (the canvas's 'lighter')
enum class UiBlend : uint8_t { Normal, Premultiplied, Add };
/// a vertex of Ui::mesh: drawable px, texture coordinates, a straight-alpha colour
struct UiVertex { vec2 pos{0}; vec2 uv{0}; vec4 col{1}; };

/// house colours (style.css)
namespace ui_color {
inline const vec4 white{1, 1, 1, 1};
inline const vec4 paper{1, 1, 1, 1};
inline const vec4 ice{0.933f, 0.953f, 0.992f, 1};            // #eef3fd
inline const vec4 bluePale{0.875f, 0.906f, 0.984f, 1};       // #dfe7fb
inline const vec4 blue{0.082f, 0.275f, 0.784f, 1};           // #1546c8
inline const vec4 blueDim{0.31f, 0.447f, 0.831f, 1};         // #4f72d4
inline const vec4 navy{0.082f, 0.129f, 0.29f, 1};            // #15214a
inline const vec4 red{1.0f, 0.302f, 0.239f, 1};              // #ff4d3d
inline const vec4 ko{0.816f, 0.204f, 0.173f, 1};             // #d0342c
inline const vec4 ok{0.071f, 0.604f, 0.275f, 1};             // #129a46
inline const vec4 gold{0.761f, 0.486f, 0.0f, 1};             // #c27c00
inline const vec4 shade{0.016f, 0.055f, 0.133f, 1};          // rgb(4, 14, 34)
inline const vec4 none{0, 0, 0, 0};
inline vec4 a(const vec4& c, float alpha) { return vec4(c.x, c.y, c.z, c.w * alpha); }
vec4 hex(uint32_t rgb, float alpha = 1);
} // namespace ui_color

class Ui {
public:
  Ui();
  ~Ui();
  bool init(gfx::Device& dev, platform::Platform& plat, const AssetPaths& paths);
  bool ready() const { return ready_; }

  void begin(int w, int h);
  /// draws everything queued since begin() into the bound (window) target
  void end();
  int width() const { return w_; }
  int height() const { return h_; }

  // ---- shapes
  void rect(float x, float y, float w, float h, const vec4& c);
  void roundRect(float x, float y, float w, float h, float r, const vec4& c);
  /// a linear gradient (horizontal: c0 left -> c1 right; else top -> bottom)
  void rectGradient(float x, float y, float w, float h, const vec4& c0, const vec4& c1, bool horizontal = true);
  void roundRectStroke(float x, float y, float w, float h, float r, float width, const vec4& c);
  void circle(float cx, float cy, float r, const vec4& c) { roundRect(cx - r, cy - r, 2 * r, 2 * r, r, c); }
  void ring(float cx, float cy, float r, float width, const vec4& c) { roundRectStroke(cx - r, cy - r, 2 * r, 2 * r, r, width, c); }
  void tri(vec2 a, vec2 b, vec2 c, const vec4& col);
  void poly(const std::vector<vec2>& convexFan, const vec4& c);   // a fan from the first point (star-shaped)
  void line(vec2 a, vec2 b, float width, const vec4& c);
  void polyline(const std::vector<vec2>& pts, float width, const vec4& c, bool dashed = false, float dash = 8);
  void image(gfx::Texture t, float x, float y, float w, float h, vec2 uv0 = vec2(0), vec2 uv1 = vec2(1), const vec4& tint = vec4(1));
  /// a drop shadow under a box (soft, a few stacked rounded rects)
  void shadow(float x, float y, float w, float h, float r, float spread, float alpha);

  // ---- the house style. The paper shapes are rasterised on the CPU at the exact drawable size (anti-aliased, cached
  // per size) and drawn as alpha masks; a CSS filter: drop-shadow() under them is the mask blurred (a Gaussian).
  struct Shadow { float dx = 0, dy = 0, blur = 0; vec4 color{0}; };   // drawable px (blur: the CSS blur radius)
  /// drop shadows under the paper shapes and boxes (CSS filter: drop-shadow; on, as the web game)
  bool dropShadows = true;
  /// paper panel with the CSS clip-path --brush-a (variant 0, 2, 3) / --brush-b (variant 1) silhouette
  void brushPanel(float x, float y, float w, float h, const vec4& c, int variant = 0, const Shadow* sh = nullptr);
  /// menu.js brushClip(seed, amp, side): the ragged paper of the menu panels and dialog cards (amp / side in u)
  void brushClip(float x, float y, float w, float h, const vec4& c, int seed, float amp, float side, float u, const Shadow* sh = nullptr);
  /// a polygon clip-path: each point is (fraction of w, px, fraction of h, px), e.g. calc(100% - 3u) = (1, -3u)
  void clipPoly(float x, float y, float w, float h, const vec4& c, const std::vector<vec4>& pts, uint64_t id, const Shadow* sh = nullptr);
  /// a menu paint stroke (menu.js brushSVG(seed, vbW, vbH), stretched to the box): blunt left cap, wavy long edges, a
  /// bristle tail on the right
  void brushStroke(float x, float y, float w, float h, const vec4& c, int seed, float vbW = 420, float vbH = 96, const Shadow* sh = nullptr);
  /// where the stroke's tail begins (labels end before it), as menu.js brushTextEnd
  static float brushTextEnd(float w, float h);
  /// a keycap (style.css .kc): an outlined cap (border 1.5 px in `border`, else fg) on `bg`, the label 700 t-xs;
  /// arrows are drawn chevrons, PlayStation symbols shapes. y = the cap's top. Returns its width.
  float kc(float x, float y, float u, const std::string& label, const vec4& fg, const vec4& bg = vec4(0), const vec4& border = vec4(-1));
  float kcWidth(float u, const std::string& label);
  float kcHeight(float u) const;
  /// the old keycap call: an outlined white .kc of height h (inverted: white cap, blue label)
  float keycap(float x, float y, float h, const std::string& label, bool inverted = false);
  float keycapWidth(float h, const std::string& label);
  /// a CSS text-shadow under text drawn with the same arguments (blurred glyph coverage, cached)
  void textShadow(float x, float y, float size, UiFont f, const std::string& s, UiAlign a, float tracking, float dx, float dy, float blur, const vec4& c);

  /// the display's pixels per window point (2 on a Retina screen): CSS px -> drawable px
  float dpr() const { return dpr_; }
  /// style.css --u in drawable px: clamp(0.7px, min(0.125vh, 0.078125vw), 2.2px) of the CSS viewport, times dpr
  float cssU() const;

  // ---- text (y = top of the line box; size = font size in px)
  /// tracking: CSS letter-spacing in em (added after every character, the last one too)
  float text(float x, float y, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a = UiAlign::Left, float tracking = 0);
  float textWidth(const std::string& s, float size, UiFont f, float tracking = 0) const;
  /// text in a CSS line box: yTop = the top of a line-height lh box (the glyphs centred in it as a browser does)
  float textLH(float x, float yTop, float lh, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a = UiAlign::Left, float tracking = 0);
  float lineHeight(float size, UiFont f) const;
  /// wraps to maxW; returns the height used
  float textWrapped(float x, float y, float maxW, float size, UiFont f, const vec4& c, const std::string& s, float lineGap = 1.25f);
  /// text shrunk to fit maxW (never below 60 %)
  float textFit(float x, float y, float maxW, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a = UiAlign::Left, float tracking = 0);
  /// the font's ascent / descent per em (hhea; descent negative)
  float ascent(UiFont f) const;
  float descent(UiFont f) const;

  // ---- clipping (axis-aligned quads only)
  void pushClip(float x, float y, float w, float h);
  void popClip();
  /// a 2D transform (CSS transform: rotate / translate) applied to everything drawn until popTransform (after clipping)
  void pushRotate(float cx, float cy, float radians);
  void pushTranslate(float dx, float dy);
  /// CSS transform: scale(sx, sy) about (cx, cy)
  void pushScale(float cx, float cy, float sx, float sy);
  void popTransform();
  /// the blend mode of everything drawn until it is set again (begin() resets it to Normal)
  void setBlend(UiBlend b) { blend_ = b; }
  /// a triangle list (n = 3 per triangle) with a colour per vertex, flat (no texture) or textured. premultipliedTex:
  /// the texture's colours are premultiplied by its alpha (a render target, a picture prepared so): to be drawn with
  /// UiBlend::Premultiplied or Add. The transform and alpha stacks apply; the clip stack does not.
  void mesh(gfx::Texture t, const UiVertex* v, size_t n, bool premultipliedTex = false);
  /// an opacity multiplied into everything drawn until popAlpha (CSS opacity on a group)
  void pushAlpha(float a) { alpha_.push_back((alpha_.empty() ? 1.f : alpha_.back()) * a); }
  void popAlpha() { if (!alpha_.empty()) alpha_.pop_back(); }
  /// a smooth gradient over a box: col(fx, fy) sampled on an nx x ny grid (fx, fy in 0..1), linearly blended between
  void gradientGrid(float x, float y, float w, float h, int nx, int ny, const std::function<vec4(float, float)>& col);

private:
  struct Vert { float x, y, u, v, r, g, b, a, lx, ly, hw, hh, rad, mode; };
  struct Glyph { float u0, v0, u1, v1, x0, y0, x1, y1, adv; int gi; bool ok; };
  struct FontData;
  /// a cached alpha mask: the shape rasterised with its box's top-left at (pad + the position's fraction) in a w x h
  /// texture (blurred when sigma > 0); drawn at floor(x) - pad
  struct Mask { gfx::Texture tex; int w = 0, h = 0, pad = 0; uint64_t used = 0; };
  using Raster = std::function<void(std::vector<uint8_t>& px, int W, int H, float ox, float oy)>;
  void maskDraw(uint64_t key, float x, float y, float w, float h, float sigma, const vec4& c, const Raster& r);
  void drawShape(uint64_t key, float x, float y, float w, float h, const vec4& c, const Shadow* sh, const Raster& r);
  void quad(float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, const vec4& c,
            float lx0, float ly0, float lx1, float ly1, float hw, float hh, float rad, float mode, gfx::Texture tex);
  void triRaw(vec2 a, vec2 b, vec2 c, const vec4& col);
  void useTexture(gfx::Texture t);
  const Glyph* glyph(UiFont f, uint32_t cp, int* usedFile) const;
  int fileOf(UiFont f) const;
  bool bakeAtlas(platform::Platform& plat, const AssetPaths& paths);

  gfx::Device* dev_ = nullptr;
  gfx::Program prog_;
  gfx::Buffer vbo_;
  gfx::VertexInput vi_;
  gfx::Texture atlas_, white_;
  size_t vboBytes_ = 0;
  std::vector<Vert> verts_;
  struct Batch { gfx::Texture tex; uint32_t first, count; UiBlend blend; };
  UiBlend blend_ = UiBlend::Normal;
  std::vector<Batch> batches_;
  std::vector<vec4> clips_;
  struct Xf { float a = 1, b = 0, c = 0, d = 1, e = 0, f = 0; };   // x' = a x + c y + e, y' = b x + d y + f
  std::vector<Xf> xf_;
  std::vector<float> alpha_;
  float A() const { return alpha_.empty() ? 1.f : alpha_.back(); }
  vec2 X(float x, float y) const { if (xf_.empty()) return vec2(x, y); const Xf& t = xf_.back(); return vec2(t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f); }
  int w_ = 1, h_ = 1;
  bool ready_ = false;
  std::vector<std::unique_ptr<FontData>> fonts_;   // per font file
  platform::Platform* plat_ = nullptr;
  float dpr_ = 1;
  uint64_t frame_ = 0;
  std::unordered_map<uint64_t, Mask> masks_;
  size_t maskBytes_ = 0;
  int maskBuilds_ = 0;
};

/// UTF-8 -> code points
std::vector<uint32_t> utf8Decode(const std::string& s);

} // namespace sl
