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
#include <memory>
#include <string>
#include <vector>

namespace sl {
class AssetPaths;
namespace platform { class Platform; }

enum class UiFont : uint8_t { Body, Cond, CondBold, CondItalic, CondHeavy, Count };
enum class UiAlign : uint8_t { Left, Center, Right };

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

  // ---- the house style
  /// paper panel with the CSS clip-path --brush-a / --brush-b silhouette (jagged paper edges)
  void brushPanel(float x, float y, float w, float h, const vec4& c, int variant = 0);
  /// a menu paint stroke (menu.js brushSVG): blunt left cap, wavy long edges, a bristle tail on the right
  void brushStroke(float x, float y, float w, float h, const vec4& c, int seed);
  /// where the stroke's tail begins (labels end before it), as menu.js brushTextEnd
  static float brushTextEnd(float w, float h);
  /// a keycap (style.css .kc): blue cap with a white label; PlayStation symbols and arrows are drawn as shapes.
  /// Returns its width.
  float keycap(float x, float y, float h, const std::string& label, bool inverted = false);
  float keycapWidth(float h, const std::string& label);

  // ---- text (y = top of the line box; size = font size in px)
  float text(float x, float y, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a = UiAlign::Left);
  float textWidth(const std::string& s, float size, UiFont f) const;
  float lineHeight(float size, UiFont f) const;
  /// wraps to maxW; returns the height used
  float textWrapped(float x, float y, float maxW, float size, UiFont f, const vec4& c, const std::string& s, float lineGap = 1.25f);
  /// text shrunk to fit maxW (never below 60 %)
  float textFit(float x, float y, float maxW, float size, UiFont f, const vec4& c, const std::string& s, UiAlign a = UiAlign::Left);

  // ---- clipping (axis-aligned quads only)
  void pushClip(float x, float y, float w, float h);
  void popClip();

private:
  struct Vert { float x, y, u, v, r, g, b, a, lx, ly, hw, hh, rad, mode; };
  struct Glyph { float u0, v0, u1, v1, x0, y0, x1, y1, adv; bool ok; };
  struct FontData;
  void quad(float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, const vec4& c,
            float lx0, float ly0, float lx1, float ly1, float hw, float hh, float rad, float mode, gfx::Texture tex);
  void triRaw(vec2 a, vec2 b, vec2 c, const vec4& col);
  void useTexture(gfx::Texture t);
  const Glyph* glyph(UiFont f, uint32_t cp, UiFont* used) const;
  bool bakeAtlas(platform::Platform& plat, const AssetPaths& paths);

  gfx::Device* dev_ = nullptr;
  gfx::Program prog_;
  gfx::Buffer vbo_;
  gfx::VertexInput vi_;
  gfx::Texture atlas_, white_;
  size_t vboBytes_ = 0;
  std::vector<Vert> verts_;
  struct Batch { gfx::Texture tex; uint32_t first, count; };
  std::vector<Batch> batches_;
  std::vector<vec4> clips_;
  int w_ = 1, h_ = 1;
  bool ready_ = false;
  std::vector<std::unique_ptr<FontData>> fonts_;
};

/// UTF-8 -> code points
std::vector<uint32_t> utf8Decode(const std::string& s);

} // namespace sl
