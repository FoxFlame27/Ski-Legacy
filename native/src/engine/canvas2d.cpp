#include "engine/canvas2d.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include <stb_truetype.h>

namespace sl {

// ---------------------------------------------------------------- fonts
static std::vector<uint32_t> utf8(const std::string& s) {
  std::vector<uint32_t> out;
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

bool Font::load(std::vector<uint8_t> ttf) {
  if (ttf.empty()) return false;
  auto info = std::make_shared<stbtt_fontinfo>();
  data_ = std::move(ttf);
  if (!stbtt_InitFont(info.get(), data_.data(), stbtt_GetFontOffsetForIndex(data_.data(), 0))) { data_.clear(); return false; }
  info_ = info;
  return true;
}
static const stbtt_fontinfo* FI(const std::shared_ptr<void>& p) { return static_cast<const stbtt_fontinfo*>(p.get()); }
float Font::width(const std::string& s, float px) const {
  if (!ok()) return float(s.size()) * px * 0.5f;
  float k = stbtt_ScaleForMappingEmToPixels(FI(info_), px), w = 0;
  for (uint32_t cp : utf8(s)) { int adv, lsb; stbtt_GetCodepointHMetrics(FI(info_), int(cp), &adv, &lsb); w += adv * k; }
  return w;
}
float Font::ascent(float px) const {
  if (!ok()) return px * 0.75f;
  int a, d, g; stbtt_GetFontVMetrics(FI(info_), &a, &d, &g);
  return a * stbtt_ScaleForMappingEmToPixels(FI(info_), px);
}
float Font::descent(float px) const {
  if (!ok()) return -px * 0.25f;
  int a, d, g; stbtt_GetFontVMetrics(FI(info_), &a, &d, &g);
  return d * stbtt_ScaleForMappingEmToPixels(FI(info_), px);
}
float Font::glyph(uint32_t cp, float px, std::vector<std::vector<vec2>>& out) const {
  if (!ok()) return px * 0.5f;
  const stbtt_fontinfo* f = FI(info_);
  float k = stbtt_ScaleForMappingEmToPixels(f, px);
  int adv, lsb; stbtt_GetCodepointHMetrics(f, int(cp), &adv, &lsb);
  stbtt_vertex* v = nullptr;
  int n = stbtt_GetCodepointShape(f, int(cp), &v);
  vec2 p(0);
  for (int i = 0; i < n; i++) {
    vec2 q(v[i].x * k, -v[i].y * k);
    if (v[i].type == STBTT_vmove) { out.push_back({q}); }
    else if (out.empty()) continue;
    else if (v[i].type == STBTT_vline) out.back().push_back(q);
    else if (v[i].type == STBTT_vcurve) {
      vec2 c(v[i].cx * k, -v[i].cy * k);
      int seg = std::clamp(int(px / 8), 3, 10);
      for (int s = 1; s <= seg; s++) { float t = float(s) / seg; out.back().push_back((1 - t) * (1 - t) * p + 2 * (1 - t) * t * c + t * t * q); }
    } else if (v[i].type == STBTT_vcubic) {
      vec2 c1(v[i].cx * k, -v[i].cy * k), c2(v[i].cx1 * k, -v[i].cy1 * k);
      int seg = std::clamp(int(px / 6), 4, 12);
      for (int s = 1; s <= seg; s++) {
        float t = float(s) / seg, u = 1 - t;
        out.back().push_back(u * u * u * p + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * q);
      }
    }
    p = q;
  }
  stbtt_FreeShape(f, v);
  return adv * k;
}

// ---------------------------------------------------------------- colours
vec4 Canvas2D::parseColor(const std::string& in) {
  std::string s;
  for (char c : in) if (c != ' ') s += char(std::tolower(uint8_t(c)));
  auto hex = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : 0; };
  if (!s.empty() && s[0] == '#') {
    if (s.size() == 4 || s.size() == 5) {
      vec4 c(hex(s[1]) / 15.f, hex(s[2]) / 15.f, hex(s[3]) / 15.f, s.size() == 5 ? hex(s[4]) / 15.f : 1.f);
      return c;
    }
    if (s.size() >= 7) {
      auto b = [&](int i) { return (hex(s[size_t(i)]) * 16 + hex(s[size_t(i) + 1])) / 255.f; };
      return vec4(b(1), b(3), b(5), s.size() >= 9 ? b(7) : 1.f);
    }
  }
  if (s.rfind("rgb", 0) == 0) {
    size_t a = s.find('('), b = s.find(')');
    if (a != std::string::npos) {
      std::string body = s.substr(a + 1, b == std::string::npos ? std::string::npos : b - a - 1);
      float v[4] = {0, 0, 0, 1};
      int n = 0;
      size_t i = 0;
      while (i < body.size() && n < 4) {
        size_t j = body.find(',', i);
        std::string tok = body.substr(i, j == std::string::npos ? std::string::npos : j - i);
        float x = float(std::atof(tok.c_str()));
        if (!tok.empty() && tok.back() == '%') x *= n < 3 ? 2.55f : 0.01f;
        v[n++] = x;
        if (j == std::string::npos) break;
        i = j + 1;
      }
      return vec4(v[0] / 255.f, v[1] / 255.f, v[2] / 255.f, v[3]);
    }
  }
  static const std::unordered_map<std::string, uint32_t> names = {
    {"white", 0xffffff}, {"black", 0x000000}, {"red", 0xff0000}, {"green", 0x008000}, {"blue", 0x0000ff}, {"yellow", 0xffff00},
    {"orange", 0xffa500}, {"gray", 0x808080}, {"grey", 0x808080}, {"silver", 0xc0c0c0}, {"gold", 0xffd700}, {"navy", 0x000080},
    {"darkgreen", 0x006400}, {"lightgray", 0xd3d3d3}, {"darkgray", 0xa9a9a9}, {"crimson", 0xdc143c}};
  if (s == "transparent") return vec4(0);
  auto it = names.find(s);
  if (it != names.end()) return vec4(((it->second >> 16) & 255) / 255.f, ((it->second >> 8) & 255) / 255.f, (it->second & 255) / 255.f, 1);
  return vec4(0, 0, 0, 1);
}

// ---------------------------------------------------------------- canvas
Canvas2D::Canvas2D(int w, int h, const FontSet* fonts) : w_(std::max(1, w)), h_(std::max(1, h)), px_(size_t(w_) * h_ * 4, 0), fonts_(fonts) {}

void Canvas2D::fillStyle(const std::string& c) { st_.fill = parseColor(c); }
void Canvas2D::strokeStyle(const std::string& c) { st_.stroke = parseColor(c); }
void Canvas2D::font(const std::string& f) {
  size_t p = f.find("px");
  if (p != std::string::npos) {
    size_t a = p;
    while (a > 0 && (std::isdigit(uint8_t(f[a - 1])) || f[a - 1] == '.')) a--;
    st_.px = float(std::atof(f.substr(a, p - a).c_str()));
  }
  st_.bold = f.find("bold") != std::string::npos || f.find("600") != std::string::npos || f.find("700") != std::string::npos ||
             f.find("800") != std::string::npos || f.find("900") != std::string::npos;
}
void Canvas2D::textAlign(const std::string& a) { st_.align = a == "center" ? 1 : (a == "right" || a == "end") ? 2 : 0; }
void Canvas2D::textBaseline(const std::string& b) {
  st_.baseline = b == "middle" ? 1 : b == "top" ? 2 : (b == "bottom" || b == "ideographic") ? 3 : b == "hanging" ? 4 : 0;
}
void Canvas2D::save() { stack_.push_back(st_); }
void Canvas2D::restore() { if (!stack_.empty()) { st_ = stack_.back(); stack_.pop_back(); } }
void Canvas2D::setTransform(float a, float b, float c, float d, float e, float f) { float m[6] = {a, b, c, d, e, f}; std::memcpy(st_.m, m, sizeof m); }
void Canvas2D::translate(float x, float y) { float* m = st_.m; m[4] += m[0] * x + m[2] * y; m[5] += m[1] * x + m[3] * y; }
void Canvas2D::scale(float x, float y) { float* m = st_.m; m[0] *= x; m[1] *= x; m[2] *= y; m[3] *= y; }
void Canvas2D::rotate(float r) {
  float c = std::cos(r), s = std::sin(r), *m = st_.m;
  float a = m[0] * c + m[2] * s, b = m[1] * c + m[3] * s, cc = m[0] * -s + m[2] * c, d = m[1] * -s + m[3] * c;
  m[0] = a; m[1] = b; m[2] = cc; m[3] = d;
}
vec2 Canvas2D::xf(float x, float y) const { const float* m = st_.m; return vec2(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]); }
float Canvas2D::scaleK() const { const float* m = st_.m; return std::sqrt(std::fabs(m[0] * m[3] - m[1] * m[2])); }

void Canvas2D::beginPath() { path_.clear(); closed_.clear(); }
void Canvas2D::moveTo(float x, float y) { path_.push_back({xf(x, y)}); closed_.push_back(false); cur_ = start_ = vec2(x, y); }
void Canvas2D::lineTo(float x, float y) {
  if (path_.empty()) { moveTo(x, y); return; }
  path_.back().push_back(xf(x, y));
  cur_ = vec2(x, y);
}
void Canvas2D::closePath() {
  if (path_.empty()) return;
  closed_.back() = true;
  cur_ = start_;
  path_.push_back({xf(start_.x, start_.y)}); closed_.push_back(false);   // a new subpath at the start point
}
void Canvas2D::rect(float x, float y, float w, float h) { moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); closePath(); }
void Canvas2D::roundRect(float x, float y, float w, float h, float r) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  r = std::max(0.f, std::min(r, std::min(w, h) / 2));
  moveTo(x + r, y);
  lineTo(x + w - r, y); arc(x + w - r, y + r, r, -PI / 2, 0);
  lineTo(x + w, y + h - r); arc(x + w - r, y + h - r, r, 0, PI / 2);
  lineTo(x + r, y + h); arc(x + r, y + h - r, r, PI / 2, PI);
  lineTo(x, y + r); arc(x + r, y + r, r, PI, 1.5 * PI);
  closePath();
}
void Canvas2D::ellipse(float x, float y, float rx, float ry, float rot, float a0, float a1, bool ccw) {
  const float T = float(TAU);
  float sweep;
  if (!ccw) { sweep = a1 - a0; if (sweep >= T) sweep = T; else { sweep = std::fmod(sweep, T); if (sweep < 0) sweep += T; } }
  else { sweep = a0 - a1; if (sweep >= T) sweep = T; else { sweep = std::fmod(sweep, T); if (sweep < 0) sweep += T; } sweep = -sweep; }
  float cr = std::cos(rot), sr = std::sin(rot);
  int n = std::clamp(int(std::fabs(sweep) * std::max(rx, ry) * scaleK() / 3.f), 6, 96);
  for (int i = 0; i <= n; i++) {
    float a = a0 + sweep * i / n, ex = rx * std::cos(a), ey = ry * std::sin(a);
    float px = x + ex * cr - ey * sr, py = y + ex * sr + ey * cr;
    if (i == 0 && path_.empty()) moveTo(px, py); else lineTo(px, py);
  }
}
void Canvas2D::arc(float x, float y, float r, float a0, float a1, bool ccw) { ellipse(x, y, r, r, 0, a0, a1, ccw); }
void Canvas2D::arcTo(float x1, float y1, float x2, float y2, float r) {
  if (path_.empty()) { moveTo(x1, y1); return; }
  vec2 p0 = cur_, p1(x1, y1), p2(x2, y2);
  vec2 d1 = p0 - p1, d2 = p2 - p1;
  float l1 = glm::length(d1), l2 = glm::length(d2);
  if (r <= 0 || l1 < 1e-6f || l2 < 1e-6f) { lineTo(x1, y1); return; }
  d1 /= l1; d2 /= l2;
  float cs = std::clamp(glm::dot(d1, d2), -1.f, 1.f), ang = std::acos(cs);
  if (ang < 1e-4f || std::fabs(ang - float(PI)) < 1e-4f) { lineTo(x1, y1); return; }
  float dist = r / std::tan(ang / 2);
  vec2 t1 = p1 + d1 * dist, t2 = p1 + d2 * dist;
  vec2 c = p1 + glm::normalize(d1 + d2) * (r / std::sin(ang / 2));
  lineTo(t1.x, t1.y);
  float a0 = std::atan2(t1.y - c.y, t1.x - c.x), a1 = std::atan2(t2.y - c.y, t2.x - c.x);
  float cross = d1.x * d2.y - d1.y * d2.x;
  arc(c.x, c.y, r, a0, a1, cross > 0);
  cur_ = t2;
}
void Canvas2D::quadraticCurveTo(float cx, float cy, float x, float y) {
  vec2 p = cur_;
  for (int i = 1; i <= 10; i++) { float t = i / 10.f; vec2 q = (1 - t) * (1 - t) * p + 2 * (1 - t) * t * vec2(cx, cy) + t * t * vec2(x, y); lineTo(q.x, q.y); }
}
void Canvas2D::bezierCurveTo(float c1x, float c1y, float c2x, float c2y, float x, float y) {
  vec2 p = cur_;
  for (int i = 1; i <= 14; i++) {
    float t = i / 14.f, u = 1 - t;
    vec2 q = u * u * u * p + 3 * u * u * t * vec2(c1x, c1y) + 3 * u * t * t * vec2(c2x, c2y) + t * t * t * vec2(x, y);
    lineTo(q.x, q.y);
  }
}

// anti-aliased non-zero polygon fill: 4 sub-scanlines per row, exact horizontal coverage
void Canvas2D::fillPolys(const std::vector<std::vector<vec2>>& polys, const vec4& color, std::vector<uint8_t>* mask) {
  struct Edge { float x0, y0, x1, y1; int dir; };
  std::vector<Edge> edges;
  float ymin = 1e30f, ymax = -1e30f, xmin = 1e30f, xmax = -1e30f;
  for (auto& p : polys) {
    if (p.size() < 2) continue;
    for (size_t i = 0; i < p.size(); i++) {
      vec2 a = p[i], b = p[(i + 1) % p.size()];
      xmin = std::min(xmin, a.x); xmax = std::max(xmax, a.x);
      if (a.y == b.y) continue;
      int dir = a.y < b.y ? 1 : -1;
      if (dir < 0) std::swap(a, b);
      edges.push_back({a.x, a.y, b.x, b.y, dir});
      ymin = std::min(ymin, a.y); ymax = std::max(ymax, b.y);
    }
  }
  if (edges.empty()) return;
  int y0 = std::max(0, int(std::floor(ymin))), y1 = std::min(h_ - 1, int(std::ceil(ymax)));
  int x0 = std::max(0, int(std::floor(xmin))), x1 = std::min(w_ - 1, int(std::ceil(xmax)));
  if (x0 > x1) return;
  std::vector<float> acc(size_t(x1 - x0 + 2));
  std::vector<std::pair<float, int>> xs;
  const float sub[4] = {0.125f, 0.375f, 0.625f, 0.875f};
  for (int y = y0; y <= y1; y++) {
    std::fill(acc.begin(), acc.end(), 0.f);
    bool any = false;
    for (float sy : sub) {
      float yy = y + sy;
      xs.clear();
      for (const Edge& e : edges)
        if (yy >= e.y0 && yy < e.y1) xs.push_back({e.x0 + (yy - e.y0) / (e.y1 - e.y0) * (e.x1 - e.x0), e.dir});
      if (xs.size() < 2) continue;
      std::sort(xs.begin(), xs.end(), [](auto& a, auto& b) { return a.first < b.first; });
      int wind = 0;
      for (size_t i = 0; i + 1 < xs.size(); i++) {
        wind += xs[i].second;
        if (wind == 0) continue;
        float a = std::max(xs[i].first, float(x0)), b = std::min(xs[i + 1].first, float(x1 + 1));
        if (b <= a) continue;
        any = true;
        int ia = int(std::floor(a)), ib = int(std::floor(b));
        if (ia == ib) { acc[size_t(ia - x0)] += (b - a) * 0.25f; continue; }
        acc[size_t(ia - x0)] += (ia + 1 - a) * 0.25f;
        for (int k = ia + 1; k < ib; k++) acc[size_t(k - x0)] += 0.25f;
        if (ib <= x1) acc[size_t(ib - x0)] += (b - ib) * 0.25f;
      }
    }
    if (!any) continue;
    for (int x = x0; x <= x1; x++) {
      float cov = std::min(1.f, acc[size_t(x - x0)]);
      if (cov <= 0.001f) continue;
      size_t o = size_t(y) * w_ + x;
      if (mask) { (*mask)[o] = uint8_t(std::lround(cov * 255)); continue; }
      if (st_.clip) cov *= (*st_.clip)[o] / 255.f;
      float a = cov * color.w * st_.alpha;
      if (a <= 0) continue;
      uint8_t* d = &px_[o * 4];
      float da = d[3] / 255.f, oa = a + da * (1 - a);
      for (int k = 0; k < 3; k++) {
        float v = (color[k] * a + d[k] / 255.f * da * (1 - a)) / std::max(oa, 1e-6f);
        d[k] = uint8_t(std::lround(std::clamp(v, 0.f, 1.f) * 255));
      }
      d[3] = uint8_t(std::lround(std::clamp(oa, 0.f, 1.f) * 255));
    }
  }
}

static float area(const std::vector<vec2>& p) {
  float a = 0;
  for (size_t i = 0; i < p.size(); i++) { const vec2 &u = p[i], &v = p[(i + 1) % p.size()]; a += u.x * v.y - v.x * u.y; }
  return a * 0.5f;
}

void Canvas2D::strokePolys(const std::vector<std::vector<vec2>>& lines, const std::vector<bool>& closed, float width, const vec4& color) {
  std::vector<std::vector<vec2>> polys;
  float hw = std::max(0.35f, width * 0.5f);
  auto circle = [&](vec2 c) {
    std::vector<vec2> q;
    int n = std::clamp(int(hw * 2), 8, 24);
    for (int i = 0; i < n; i++) { float a = float(TAU) * i / n; q.push_back(c + vec2(std::cos(a), std::sin(a)) * hw); }
    polys.push_back(q);
  };
  for (size_t l = 0; l < lines.size(); l++) {
    const auto& p = lines[l];
    if (p.size() < 2) continue;
    bool cl = l < closed.size() && closed[l];
    size_t n = cl ? p.size() : p.size() - 1;
    for (size_t i = 0; i < n; i++) {
      vec2 a = p[i], b = p[(i + 1) % p.size()], d = b - a;
      float len = glm::length(d);
      if (len < 1e-5f) continue;
      vec2 nn = vec2(-d.y, d.x) / len * hw;
      std::vector<vec2> q = {a + nn, b + nn, b - nn, a - nn};
      if (area(q) < 0) std::reverse(q.begin(), q.end());
      polys.push_back(q);
    }
    for (size_t i = cl ? 0 : 1; i < (cl ? p.size() : p.size() - 1); i++) circle(p[i]);
  }
  for (auto& q : polys) if (area(q) < 0) std::reverse(q.begin(), q.end());
  fillPolys(polys, color);
}

void Canvas2D::fill() { fillPolys(path_, st_.fill); }
void Canvas2D::stroke() { strokePolys(path_, closed_, st_.lineWidth * scaleK(), st_.stroke); }
void Canvas2D::clip() {
  auto m = std::make_shared<std::vector<uint8_t>>(size_t(w_) * h_, 0);
  fillPolys(path_, vec4(1), m.get());
  if (st_.clip) for (size_t i = 0; i < m->size(); i++) (*m)[i] = uint8_t((*m)[i] * (*st_.clip)[i] / 255);
  st_.clip = m;
}
void Canvas2D::fillRect(float x, float y, float w, float h) {
  fillPolys({{xf(x, y), xf(x + w, y), xf(x + w, y + h), xf(x, y + h)}}, st_.fill);
}
void Canvas2D::strokeRect(float x, float y, float w, float h) {
  strokePolys({{xf(x, y), xf(x + w, y), xf(x + w, y + h), xf(x, y + h)}}, {true}, st_.lineWidth * scaleK(), st_.stroke);
}
void Canvas2D::clearRect(float x, float y, float w, float h) {
  vec2 a = xf(x, y), b = xf(x + w, y + h);
  int xa = std::max(0, int(std::floor(std::min(a.x, b.x)))), xb = std::min(w_, int(std::ceil(std::max(a.x, b.x))));
  int ya = std::max(0, int(std::floor(std::min(a.y, b.y)))), yb = std::min(h_, int(std::ceil(std::max(a.y, b.y))));
  for (int yy = ya; yy < yb; yy++) for (int xx = xa; xx < xb; xx++) std::memset(&px_[(size_t(yy) * w_ + xx) * 4], 0, 4);
}
float Canvas2D::measureText(const std::string& t) const { return fonts_ ? fonts_->pick(st_.bold).width(t, st_.px) : t.size() * st_.px * 0.5f; }
void Canvas2D::fillText(const std::string& text, float x, float y) {
  if (!fonts_) return;
  const Font& f = fonts_->pick(st_.bold);
  float px = st_.px, w = f.width(text, px);
  if (st_.align == 1) x -= w / 2; else if (st_.align == 2) x -= w;
  float asc = f.ascent(px), desc = f.descent(px);
  if (st_.baseline == 1) y += (asc + desc) / 2; else if (st_.baseline == 2) y += asc; else if (st_.baseline == 3) y += desc; else if (st_.baseline == 4) y += asc * 0.8f;
  std::vector<std::vector<vec2>> polys;
  float pen = 0;
  for (uint32_t cp : utf8(text)) {
    std::vector<std::vector<vec2>> g;
    float adv = f.glyph(cp, px, g);
    for (auto& c : g) { for (auto& p : c) p = xf(x + pen + p.x, y + p.y); polys.push_back(std::move(c)); }
    pen += adv;
  }
  fillPolys(polys, st_.fill);
}
void Canvas2D::putAlpha(int x, int y, int w, int h, const std::vector<uint8_t>& a) {
  for (int j = 0; j < h; j++) for (int i = 0; i < w; i++) {
    int xx = x + i, yy = y + j;
    if (xx < 0 || yy < 0 || xx >= w_ || yy >= h_ || size_t(j) * w + i >= a.size()) continue;
    px_[(size_t(yy) * w_ + xx) * 4 + 3] = a[size_t(j) * w + i];
  }
}

} // namespace sl
