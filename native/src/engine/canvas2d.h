// A small software 2D canvas with the subset of the HTML canvas API the game's sign textures use: fill / stroke
// styles (CSS colours), line width, global alpha, save / restore, translate / rotate / scale, paths (moveTo, lineTo,
// arc, arcTo, ellipse, rect, roundRect, curves), fill (non-zero), stroke, clip, fillRect / strokeRect / clearRect and
// fillText with alignment and baselines (stb_truetype glyph outlines, rasterised with the same anti-aliased polygon
// filler). Used two ways: replaying the drawing commands export_resort.mjs recorded from the JavaScript canvases
// (signposts, sign boards, the cobble path texture), and directly by C++ builders (the gondola stations' signs).
#pragma once
#include "core/math.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {

class Font {
public:
  bool load(std::vector<uint8_t> ttf);
  bool ok() const { return !data_.empty(); }
  float width(const std::string& utf8, float px) const;
  // glyph outline of one code point in pixels at size px (y down), appended as contours of points
  float glyph(uint32_t cp, float px, std::vector<std::vector<vec2>>& contours) const;
  float ascent(float px) const;
  float descent(float px) const;   // negative
private:
  std::vector<uint8_t> data_;
  std::shared_ptr<void> info_;
};

/// Fonts by weight (Barlow Condensed 500 / 700, exported to native/data/fonts).
struct FontSet { Font regular, bold; const Font& pick(bool b) const { return b && bold.ok() ? bold : regular.ok() ? regular : bold; } };

/// The platform's own faces for a CSS family, as the browser picks them (Georgia / Times / serif -> 1, Arial /
/// Helvetica / sans-serif -> 2): Georgia / Arial on macOS and Windows, fontconfig's stand-ins on Linux (Gelasio or
/// DejaVu Serif, Liberation Sans / Arimo). Loaded once; null when none is installed (the caller keeps its own set).
const FontSet* systemFontSet(int family);

class Canvas2D {
public:
  Canvas2D(int w, int h, const FontSet* fonts);
  int width() const { return w_; }
  int height() const { return h_; }
  const std::vector<uint8_t>& pixels() const { return px_; }   // RGBA8, top row first

  // state
  void fillStyle(const std::string& css);
  void strokeStyle(const std::string& css);
  void lineWidth(float w) { st_.lineWidth = w; }
  void globalAlpha(float a) { st_.alpha = a; }
  void font(const std::string& css);
  void textAlign(const std::string& a);
  void textBaseline(const std::string& b);
  void save();
  void restore();
  void translate(float x, float y);
  void rotate(float a);
  void scale(float x, float y);
  void setTransform(float a, float b, float c, float d, float e, float f);
  // paths
  void beginPath();
  void moveTo(float x, float y);
  void lineTo(float x, float y);
  void closePath();
  void rect(float x, float y, float w, float h);
  void roundRect(float x, float y, float w, float h, float r);
  void arc(float x, float y, float r, float a0, float a1, bool ccw = false);
  void arcTo(float x1, float y1, float x2, float y2, float r);
  void ellipse(float x, float y, float rx, float ry, float rot, float a0, float a1, bool ccw = false);
  void quadraticCurveTo(float cx, float cy, float x, float y);
  void bezierCurveTo(float c1x, float c1y, float c2x, float c2y, float x, float y);
  void fill();
  void stroke();
  void clip();
  // immediate
  void fillRect(float x, float y, float w, float h);
  void strokeRect(float x, float y, float w, float h);
  void clearRect(float x, float y, float w, float h);
  void fillText(const std::string& text, float x, float y);
  float measureText(const std::string& text) const;
  void putAlpha(int x, int y, int w, int h, const std::vector<uint8_t>& alpha);
  // (the full canvas API for a canvas replayed exactly, the trail map board: export_resort.mjs `exact`)
  void putImage(int x, int y, int w, int h, const std::vector<uint8_t>& rgba);   // putImageData: RGBA8 rows
  void lineCap(const std::string& c) { st_.roundCap = c == "round"; st_.squareCap = c == "square"; }
  void setLineDash(std::vector<float> d);
  void systemFonts(bool on) { sysFonts_ = on; }   // font(): the family named (systemFontSet) instead of Barlow Condensed

  static vec4 parseColor(const std::string& css);   // straight RGBA 0..1 (sRGB)

private:
  struct State {
    vec4 fill{0, 0, 0, 1}, stroke{0, 0, 0, 1};
    float lineWidth = 1, alpha = 1, px = 10;
    bool bold = false;
    bool roundCap = false, squareCap = false;
    int family = 0;              // systemFontSet's family, 0 = the canvas's own fonts
    std::vector<float> dash;     // setLineDash (user-space lengths)
    int align = 0, baseline = 0;   // align: 0 left 1 center 2 right; baseline: 0 alphabetic 1 middle 2 top 3 bottom 4 hanging
    float m[6] = {1, 0, 0, 1, 0, 0}; // a b c d e f
    std::shared_ptr<std::vector<uint8_t>> clip;
  };
  vec2 xf(float x, float y) const;
  float scaleK() const;
  const FontSet* fontSet() const;
  void fillPolys(const std::vector<std::vector<vec2>>& polys, const vec4& color, std::vector<uint8_t>* mask = nullptr);
  void strokePolys(const std::vector<std::vector<vec2>>& lines, const std::vector<bool>& closed, float width, const vec4& color);
  int w_, h_;
  std::vector<uint8_t> px_;
  const FontSet* fonts_;
  bool sysFonts_ = false;
  State st_;
  std::vector<State> stack_;
  std::vector<std::vector<vec2>> path_;   // device-space subpaths
  std::vector<bool> closed_;
  vec2 cur_{0}, start_{0};                // user space
};

} // namespace sl
