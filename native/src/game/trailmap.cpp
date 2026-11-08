#include "game/trailmap.h"
#include "core/assets_path.h"
#include "core/jobs.h"
#include "core/log.h"
#include "core/prompts.h"
#include "platform/platform.h"
#include "world/lifts.h"
#include "world/transport.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace sl {
using namespace ui_color;

namespace {
constexpr double MIN_S = 0.028, MAX_S = 1.6;   // trailmap.js zoom range (px per m)
const uint32_t PISTE_COLORS[4] = {0x1f9d4a, 0x1f5fd6, 0xd42525, 0x161616};
const char* GRADES[4] = {"Easy", "Intermediate", "Difficult", "Expert"};
const uint32_t EXPRESS = 0x6a22c9;
} // namespace

TrailMap::~TrailMap() {
  for (auto& t : tex_) if (t && dev_) dev_->destroy(t);
}

void TrailMap::load(platform::Platform& p, const AssetPaths& paths, const World&, const Transport& t, Lifts& lifts) {
  std::vector<uint8_t> b;
  if (paths.readData(p, "world.json", b)) {
    auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
    if (!j.is_discarded() && j.contains("layout")) {
      for (auto& q : j["layout"]["pistes"]) {
        Poly pl;
        pl.name = q.value("name", std::string());
        pl.diff = std::clamp(q.value("diff", 1), 0, 3);
        for (auto& pt : q["pts"]) pl.pts.push_back(dvec2(pt[0].get<double>(), pt[1].get<double>()));
        if (pl.pts.size() > 1) pistes_.push_back(std::move(pl));
      }
      for (auto& h : j["layout"]["huts"]) places_.push_back({h.value("x", 0.0), h.value("z", 0.0), 0, h.value("name", std::string("Hut"))});
    }
  }
  for (const LiftLine& l : lifts.lines()) {
    Poly pl;
    pl.name = l.name; pl.kind = l.gondola ? 1 : 0;
    pl.pts = {dvec2(l.bottom.x, l.bottom.z), dvec2(l.top.x, l.top.z)};
    lifts_.push_back(pl);
    if (!l.topName.empty()) places_.push_back({l.top.x, l.top.z, 5, l.topName});
  }
  for (const Road& r : t.roads) {
    Poly pl;
    pl.kind = r.scenic ? 1 : r.access ? 2 : 0;
    for (int i = 0; i < r.n; i += 2) pl.pts.push_back(dvec2(r.X[size_t(i)], r.Z[size_t(i)]));
    if (r.n > 0) pl.pts.push_back(dvec2(r.X[size_t(r.n - 1)], r.Z[size_t(r.n - 1)]));
    if (pl.pts.size() > 1) roads_.push_back(std::move(pl));
  }
  auto railPoly = [&](const Line& L, const std::vector<Span>& tunnels, int kind, const std::string& name) {
    if (L.n < 2) return;
    Poly pl;
    pl.kind = kind; pl.name = name;
    std::vector<bool> tun;
    int step = std::max(1, int(16 / std::max(0.5, L.step)));
    for (int i = 0; i < L.n; i += step) {
      double s = i * L.step;
      pl.pts.push_back(dvec2(L.X[size_t(i)], L.Z[size_t(i)]));
      bool in = false;
      for (const Span& sp : tunnels) in = in || (s >= sp.s0 && s <= sp.s1);
      tun.push_back(in);
    }
    if (L.ring && !pl.pts.empty()) { pl.pts.push_back(pl.pts.front()); tun.push_back(tun.front()); }
    rails_.push_back(std::move(pl));
    railTunnel_.push_back(std::move(tun));
  };
  if (t.rail.ok) railPoly(t.rail.line, t.rail.tunnels, 0, t.rail.name);
  if (t.express.ok) railPoly(t.express.line, t.express.tunnels, 1, t.express.name);
  for (const StopInfo& st : t.stops) places_.push_back({st.x, st.z, 1, "Bus stop \xC2\xB7 " + st.name});
  for (const auto& st : t.rail.stations) places_.push_back({st.pos.x, st.pos.z, 2, t.rail.name + " \xC2\xB7 " + st.name});
  for (const auto& st : t.express.stations) places_.push_back({st.pos.x, st.pos.z, 2, t.express.name + " \xC2\xB7 " + st.name});
  for (const Lot& L : t.lots) {
    if (L.building) places_.push_back({L.ex != 0 ? L.ex : L.x, L.ez != 0 ? L.ez : L.z, 3, L.name});
    else if (!L.impound) places_.push_back({L.x, L.z, 4, L.name});
  }
  places_.push_back({-40, -18, 3, "Ski shop"});
  places_.push_back({15, -50, 3, "Lift tickets"});
  // the map's extent: everything drawn, plus a margin
  dvec2 lo(1e18), hi(-1e18);
  auto grow = [&](const dvec2& q) { lo = glm::min(lo, q); hi = glm::max(hi, q); };
  for (auto* v : {&pistes_, &lifts_, &roads_, &rails_}) for (const Poly& pl : *v) for (const dvec2& q : pl.pts) grow(q);
  if (lo.x > hi.x) { lo = dvec2(-4000); hi = dvec2(4000); }
  bmin_ = lo - 600.0; bmax_ = hi + 600.0;
  SL_INFO("trail map: %zu pistes, %zu lifts, %zu roads, %zu railways, %zu places, %.1f x %.1f km", pistes_.size(), lifts_.size(), roads_.size(), rails_.size(),
          places_.size(), (bmax_.x - bmin_.x) / 1000, (bmax_.y - bmin_.y) / 1000);
}

// trailmap.js buildTile: a soft hillshade lit from the north-west
void TrailMap::buildRelief(JobSystem& jobs, const World& world, gfx::Device& dev) {
  dev_ = &dev;
  sh_ = std::make_shared<Shared>();
  dvec2 c0 = (bmin_ + bmax_) * 0.5;
  double s0 = std::max(bmax_.x - bmin_.x, bmax_.y - bmin_.y);
  // the core: the pistes and lifts
  dvec2 lo(1e18), hi(-1e18);
  for (auto* v : {&pistes_, &lifts_}) for (const Poly& pl : *v) for (const dvec2& q : pl.pts) { lo = glm::min(lo, q); hi = glm::max(hi, q); }
  if (lo.x > hi.x) { lo = dvec2(-3000); hi = dvec2(3000); }
  dvec2 c1 = (lo + hi) * 0.5;
  double s1 = std::max(hi.x - lo.x, hi.y - lo.y) + 1200;
  const int N[2] = {768, 1024};
  const dvec2 C[2] = {c0, c1};
  const double S[2] = {s0, s1};
  const World* w = &world;
  for (int li = 0; li < 2; li++) {
    Relief& R = sh_->rel[li];
    R.n = N[li]; R.size = S[li]; R.x0 = C[li] - S[li] * 0.5;
    R.px.assign(size_t(R.n) * R.n * 4, 255);
    const int ROWS = 32;
    R.rowsLeft = (R.n + ROWS - 1) / ROWS;
    double contour = li == 0 ? 100 : 50;
    for (int r0 = 0; r0 < R.n; r0 += ROWS) {
      std::shared_ptr<Shared> sh = sh_;
      jobs.push([sh, li, r0, ROWS, w, contour] {
        Relief& R = sh->rel[li];
        double step = R.size / R.n;
        int n = R.n;
        int r1 = std::min(n, r0 + ROWS);
        int M = n + 2;
        // heights with a one-sample ring (for the gradients)
        std::vector<float> Hh(size_t(M) * size_t(r1 - r0 + 2));
        for (int j = r0 - 1; j <= r1; j++)
          for (int i = -1; i <= n; i++) Hh[size_t(j - r0 + 1) * M + size_t(i + 1)] = float(w->height(R.x0.x + (i + 0.5) * step, R.x0.y + (j + 0.5) * step, step));
        const double Lx = -0.55, Ly = 0.62, Lz = -0.56;
        auto ci = [&](double h) { return std::floor(h / contour); };
        auto cj = [&](double h) { return std::floor(h / (contour * 5)); };
        for (int j = r0; j < r1; j++)
          for (int i = 0; i < n; i++) {
            size_t k = size_t(j - r0 + 1) * M + size_t(i + 1);
            double h = Hh[k];
            double gx = (Hh[k + 1] - Hh[k - 1]) / (2 * step), gz = (Hh[k + M] - Hh[k - M]) / (2 * step);
            double slope = std::hypot(gx, gz);
            double nx = -gx * 1.5, nz = -gz * 1.5, nl = std::sqrt(nx * nx + 1 + nz * nz);
            double t = std::clamp(((nx * Lx + Ly + nz * Lz) / nl / Ly - 0.3) / 0.85, 0.0, 1.0);
            double r = 200 + 51 * t, g = 212 + 40 * t, b = 236 + 19 * t;
            double rock = std::clamp((slope - 0.85) / 0.35, 0.0, 1.0);
            if (rock > 0) { double rt = 0.8 + 0.2 * t; r += (170 * rt - r) * rock * 0.85; g += (182 * rt - g) * rock * 0.85; b += (206 * rt - b) * rock * 0.85; }
            double x = R.x0.x + (i + 0.5) * step, z = R.x0.y + (j + 0.5) * step;
            double f = w->forest(x, z, h, slope);
            if (f > 0.12) { double ft = std::min(1.0, (f - 0.12) / 0.55) * 0.5, fl = 0.8 + 0.2 * t; r += (150 * fl - r) * ft; g += (176 * fl - g) * ft; b += (206 * fl - b) * ft; }
            if (ci(Hh[k + 1]) != ci(h) || ci(Hh[k + M]) != ci(h)) {
              double m = cj(Hh[k + 1]) != cj(h) || cj(Hh[k + M]) != cj(h) ? 0.87 : 0.94;
              r *= m; g *= m; b *= m;
            }
            uint8_t* o = &R.px[(size_t(j) * n + size_t(i)) * 4];
            o[0] = uint8_t(std::clamp(r, 0.0, 255.0)); o[1] = uint8_t(std::clamp(g, 0.0, 255.0)); o[2] = uint8_t(std::clamp(b, 0.0, 255.0)); o[3] = 255;
          }
        R.rowsLeft--;
      });
    }
  }
}

bool TrailMap::reliefReady() const { return sh_ && sh_->rel[0].rowsLeft.load() == 0 && sh_->rel[1].rowsLeft.load() == 0; }

void TrailMap::uploadRelief(gfx::Device& dev) {
  if (!sh_) return;
  for (int li = 0; li < 2; li++) {
    Relief& R = sh_->rel[li];
    if (tex_[li] || R.rowsLeft.load() != 0 || R.n == 0) continue;
    gfx::TextureDesc td;
    td.width = td.height = R.n; td.format = gfx::TexFormat::RGBA8;   // (the 2D layer works in display space, like the canvas) td.filter = gfx::Filter::Trilinear; td.wrap = gfx::Wrap::Clamp; td.mipmaps = true;
    tex_[li] = dev.createTexture(td, R.px.data());
  }
}

void TrailMap::open(const dvec3& at) {
  open_ = true;
  cx_ = at.x; cz_ = at.z;
  s_ = std::clamp(s_, 0.12, 0.45);
  drag_ = vec2(-1);
}

vec2 TrailMap::toScreen(double x, double z) const { return vec2(float(W_ / 2 + (x - cx_) * s_), float(H_ / 2 + (z - cz_) * s_)); }
dvec2 TrailMap::toWorld(vec2 p) const { return dvec2(cx_ + (p.x - W_ / 2) / s_, cz_ + (p.y - H_ / 2) / s_); }

bool TrailMap::frame(Ui& ui, const UiNav& nav, const Input& in, double dt, const dvec3& you, double heading, const dvec3* car) {
  if (!open_) return false;
  if (dev_) uploadRelief(*dev_);
  W_ = float(ui.width()); H_ = float(ui.height());
  float u = std::clamp(std::min(H_ / 800.f, W_ / 1280.f), 0.55f, 2.2f);
  // ---- input
  if (nav.cancel || nav.menu) { open_ = false; return false; }
  auto zoomAbout = [&](double k, vec2 at) {
    dvec2 before = toWorld(at);
    s_ = std::clamp(s_ * k, MIN_S, MAX_S);
    dvec2 after = toWorld(at);
    cx_ += before.x - after.x; cz_ += before.y - after.y;
  };
  if (nav.wheel != 0) zoomAbout(std::pow(1.18, double(nav.wheel)), nav.mouse.x >= 0 ? nav.mouse : vec2(W_ / 2, H_ / 2));
  double zk = double(nav.zoomIn - nav.zoomOut);
  if (zk != 0) zoomAbout(std::exp(zk * dt * 1.8), vec2(W_ / 2, H_ / 2));
  vec2 st = nav.stickL;
  if (glm::length(st) > 0.18f) { cx_ += double(st.x) * dt * 650 / s_; cz_ += double(st.y) * dt * 650 / s_; }
  if (nav.usingPad && in.padPressed(3)) { cx_ = you.x; cz_ = you.z; }
  if (!nav.usingPad) for (platform::Key k : nav.keys) if (k == platform::Key::KeyR) { cx_ = you.x; cz_ = you.z; }
  if (nav.click && nav.mouse.x >= 0) { drag_ = nav.mouse; dragStart_ = nav.mouse; dragged_ = false; }
  if (nav.mouseDown && drag_.x >= 0) {
    vec2 d = nav.mouse - drag_;
    if (glm::length(nav.mouse - dragStart_) > 5) dragged_ = true;
    cx_ -= d.x / s_; cz_ -= d.y / s_;
    drag_ = nav.mouse;
  } else if (drag_.x >= 0) {
    // released: a click without a drag marks a place (or clears the mark)
    if (!dragged_) {
      dvec2 w = toWorld(drag_);
      vec2 ms = toScreen(mark.x, mark.z);
      if (mark.on && glm::length(ms - drag_) < 16 * u) mark.on = false;
      else { mark.on = true; mark.x = w.x; mark.z = w.y; mark.label = hover.empty() ? "Marked spot" : hover; }
    }
    drag_ = vec2(-1);
  }
  // controller: the confirm button marks the centre
  if (nav.usingPad && nav.confirm) { mark.on = true; mark.x = cx_; mark.z = cz_; mark.label = hover.empty() ? "Marked spot" : hover; }
  // ---- draw
  drawnItems = 0;
  ui.rect(0, 0, W_, H_, hex(0xeef2fa));
  for (int li = 0; li < 2; li++) {
    if (!tex_[li] || !sh_) continue;
    const Relief& R = sh_->rel[li];
    vec2 a = toScreen(R.x0.x, R.x0.y), b = toScreen(R.x0.x + R.size, R.x0.y + R.size);
    ui.image(tex_[li], a.x, a.y, b.x - a.x, b.y - a.y);
    drawnItems++;
  }
  auto line = [&](const std::vector<dvec2>& pts, float w, const vec4& c, bool dashed = false) {
    std::vector<vec2> sp;
    sp.reserve(pts.size());
    for (const dvec2& q : pts) sp.push_back(toScreen(q.x, q.y));
    // cull off-screen polylines
    vec2 lo(1e9f), hi(-1e9f);
    for (const vec2& q : sp) { lo = glm::min(lo, q); hi = glm::max(hi, q); }
    if (hi.x < -50 || hi.y < -50 || lo.x > W_ + 50 || lo.y > H_ + 50) return;
    ui.polyline(sp, w, c, dashed, 9 * u);
    drawnItems++;
  };
  // roads: a white casing, valley grey / scenic amber
  float rw = std::max(1.6f, float(7 * s_));
  for (const Poly& r : roads_) line(r.pts, rw + 2, white);
  for (const Poly& r : roads_) line(r.pts, rw, r.kind == 1 ? hex(0xe7a500) : r.kind == 2 ? hex(0xaab4cf) : hex(0x8796bb));
  // railways (dashed in the tunnels)
  for (size_t k = 0; k < rails_.size(); k++) {
    const Poly& r = rails_[k];
    vec4 c = r.kind == 1 ? hex(EXPRESS) : hex(0x15214a);
    float w = std::max(2.f, float(5 * s_)) + (r.kind == 1 ? 1.f : 0.f);
    std::vector<dvec2> run;
    bool tun = railTunnel_[k].empty() ? false : bool(railTunnel_[k][0]);
    for (size_t i = 0; i < r.pts.size(); i++) {
      bool t = railTunnel_[k][i];
      if (t != tun && !run.empty()) { run.push_back(r.pts[i]); line(run, w, tun ? a(c, 0.45f) : c, tun); run.clear(); tun = t; }
      run.push_back(r.pts[i]);
    }
    if (run.size() > 1) line(run, w, tun ? a(c, 0.45f) : c, tun);
  }
  // pistes
  float pw = std::max(2.5f, float(16 * s_));
  for (const Poly& p : pistes_) line(p.pts, pw + 2, a(white, 0.9f));
  for (const Poly& p : pistes_) line(p.pts, pw, hex(PISTE_COLORS[p.diff], 0.92f));
  // lifts: a dark line with the stations
  for (const Poly& l : lifts_) {
    line(l.pts, l.kind ? 3.f : 2.f, hex(0x161616));
    for (const dvec2& q : l.pts) { vec2 sp = toScreen(q.x, q.y); ui.circle(sp.x, sp.y, 4.5f, white); ui.circle(sp.x, sp.y, 3, hex(0x161616)); }
  }
  // labels: lift names, piste names (zoomed in)
  float lfs = std::max(11.f, 12.5f * u);
  if (s_ > 0.09)
    for (const Poly& l : lifts_) {
      vec2 a0 = toScreen(l.pts[0].x, l.pts[0].y), b0 = toScreen(l.pts[1].x, l.pts[1].y), m = (a0 + b0) * 0.5f;
      if (m.x < 0 || m.y < 0 || m.x > W_ || m.y > H_) continue;
      float tw = ui.textWidth(l.name, lfs, UiFont::CondBold);
      ui.roundRect(m.x - tw / 2 - 5, m.y - lfs * 0.7f, tw + 10, lfs * 1.4f, 4, a(white, 0.85f));
      ui.text(m.x, m.y - ui.lineHeight(lfs, UiFont::CondBold) / 2, lfs, UiFont::CondBold, hex(0x161616), l.name, UiAlign::Center);
    }
  if (s_ > 0.32)
    for (const Poly& p : pistes_) {
      const dvec2& q = p.pts[p.pts.size() / 2];
      vec2 m = toScreen(q.x, q.y);
      if (m.x < 0 || m.y < 0 || m.x > W_ || m.y > H_) continue;
      ui.text(m.x + 6, m.y - 8, lfs, UiFont::CondItalic, hex(PISTE_COLORS[p.diff]), p.name);
    }
  // places: one icon style (a rounded badge, white rim, white glyph)
  hover.clear();
  float bestHover = 14 * u;
  for (const Place& pl : places_) {
    if (pl.kind == 5 && s_ < 0.06) continue;
    if (pl.kind == 4 && s_ < 0.12) continue;
    vec2 sp = toScreen(pl.x, pl.z);
    if (sp.x < -20 || sp.y < -20 || sp.x > W_ + 20 || sp.y > H_ + 20) continue;
    static const uint32_t col[6] = {0xd42525, 0x1546c8, 0x6a22c9, 0x1546c8, 0x1f5fd6, 0x15214a};
    static const char* glyph[6] = {"H", "B", "T", "i", "P", "\xE2\x96\xB3"};
    std::string g = glyph[pl.kind];
    if (pl.kind == 3) {
      if (pl.name.find("Ski") != std::string::npos) g = "S";
      else if (pl.name.find("ticket") != std::string::npos) g = "$";
      else if (pl.name.find("Autohaus") != std::string::npos) g = "A";
      else if (pl.name.find("Werkstatt") != std::string::npos) g = "W";
      else if (pl.name.find("Medical") != std::string::npos) g = "+";
      else if (pl.name.find("Police") != std::string::npos) g = "P";
    }
    float r = 8 * u;
    if (pl.kind == 5) { ui.tri(sp + vec2(0, -7 * u), sp + vec2(6 * u, 4 * u), sp + vec2(-6 * u, 4 * u), hex(0x15214a)); }
    else {
      ui.circle(sp.x, sp.y, r + 1.6f, white);
      ui.circle(sp.x, sp.y, r, hex(col[pl.kind]));
      ui.text(sp.x, sp.y - ui.lineHeight(r * 1.4f, UiFont::CondBold) / 2, r * 1.4f, UiFont::CondBold, white, g, UiAlign::Center);
    }
    drawnItems++;
    float d = nav.mouse.x >= 0 ? glm::length(nav.mouse - sp) : glm::length(vec2(W_ / 2, H_ / 2) - sp);
    if (d < bestHover) { bestHover = d; hover = pl.name; }
  }
  // hover over a piste / lift line
  if (hover.empty()) {
    vec2 m = nav.mouse.x >= 0 && !nav.usingPad ? nav.mouse : vec2(W_ / 2, H_ / 2);
    float best = 8 * u;
    auto segD = [](vec2 p, vec2 a0, vec2 b0) { vec2 ab = b0 - a0; float t = std::clamp(glm::dot(p - a0, ab) / std::max(1e-6f, glm::dot(ab, ab)), 0.f, 1.f); return glm::length(p - (a0 + ab * t)); };
    for (const Poly& p : pistes_) for (size_t i = 1; i < p.pts.size(); i++) {
      float d = segD(m, toScreen(p.pts[i - 1].x, p.pts[i - 1].y), toScreen(p.pts[i].x, p.pts[i].y));
      if (d < best) { best = d; hover = p.name + " \xC2\xB7 " + GRADES[p.diff]; }
    }
    for (const Poly& l : lifts_) {
      float d = segD(m, toScreen(l.pts[0].x, l.pts[0].y), toScreen(l.pts[1].x, l.pts[1].y));
      if (d < best) { best = d; hover = l.name; }
    }
  }
  // the mark, your car, you
  if (mark.on) {
    vec2 sp = toScreen(mark.x, mark.z);
    ui.circle(sp.x, sp.y - 14 * u, 9 * u, red);
    ui.tri(sp + vec2(-7 * u, -10 * u), sp + vec2(7 * u, -10 * u), sp, red);
    ui.circle(sp.x, sp.y - 14 * u, 3.5f * u, white);
  }
  if (car) {
    vec2 sp = toScreen(car->x, car->z);
    ui.roundRect(sp.x - 7 * u, sp.y - 5 * u, 14 * u, 10 * u, 3 * u, white);
    ui.roundRect(sp.x - 5.5f * u, sp.y - 3.5f * u, 11 * u, 7 * u, 2 * u, blue);
  }
  {
    vec2 sp = toScreen(you.x, you.z);
    float ang = float(heading);
    // heading 0 looks toward +z (down on the map); the arrow points along (sin h, cos h)
    vec2 f(std::sin(ang), std::cos(ang)), r(f.y, -f.x);
    float k = 11 * u;
    ui.circle(sp.x, sp.y, k * 1.1f, a(white, 0.9f));
    ui.tri(sp + f * k, sp - f * k * 0.6f + r * k * 0.7f, sp - f * k * 0.25f, red);
    ui.tri(sp + f * k, sp - f * k * 0.25f, sp - f * k * 0.6f - r * k * 0.7f, red);
  }
  // header, legend, tooltip, hints
  {
    float x = 40 * u, y = 24 * u, h = 70 * u, fs = 36 * u;
    float w = ui.textWidth("TRAIL MAP", fs, UiFont::CondItalic) + 40 * u + h * 0.8f;
    ui.brushStroke(x, y, w, h, white, 91);
    ui.text(x + 30 * u, y + (h - ui.lineHeight(fs, UiFont::CondItalic)) / 2, fs, UiFont::CondItalic, blue, "TRAIL MAP");
    // legend (right)
    float lw = 190 * u, lh = 170 * u, lx = W_ - lw - 30 * u, ly = 30 * u;
    ui.shadow(lx, ly, lw, lh, 6 * u, 10 * u, 0.2f);
    ui.brushPanel(lx, ly, lw, lh, white, 0);
    float yy = ly + 18 * u, sfs = std::max(11.f, 13 * u);
    ui.text(lx + 18 * u, yy, std::max(10.f, 11 * u), UiFont::Body, red, "PISTES");
    yy += 20 * u;
    for (int d = 0; d < 4; d++) {
      ui.roundRect(lx + 18 * u, yy + 4 * u, 22 * u, 8 * u, 3 * u, hex(PISTE_COLORS[d]));
      ui.text(lx + 48 * u, yy, sfs, UiFont::Body, blue, GRADES[d]);
      yy += 20 * u;
    }
    ui.rect(lx + 18 * u, yy + 7 * u, 22 * u, 3 * u, hex(0x161616)); ui.text(lx + 48 * u, yy, sfs, UiFont::Body, blue, "Lifts"); yy += 20 * u;
    ui.rect(lx + 18 * u, yy + 6 * u, 22 * u, 4 * u, hex(EXPRESS)); ui.text(lx + 48 * u, yy, sfs, UiFont::Body, blue, "Legacy Express");
  }
  if (!hover.empty()) {
    vec2 m = nav.mouse.x >= 0 && !nav.usingPad ? nav.mouse + vec2(16, 10) : vec2(W_ / 2 + 16, H_ / 2 + 10);
    float fs = std::max(12.f, 14 * u), tw = ui.textWidth(hover, fs, UiFont::CondBold);
    ui.roundRect(m.x, m.y, tw + 18, fs * 1.7f, 5, a(white, 0.95f));
    ui.text(m.x + 9, m.y + fs * 0.25f, fs, UiFont::CondBold, blue, hover);
  }
  if (nav.usingPad) { ui.line(vec2(W_ / 2 - 8, H_ / 2), vec2(W_ / 2 + 8, H_ / 2), 2, a(navy, 0.7f)); ui.line(vec2(W_ / 2, H_ / 2 - 8), vec2(W_ / 2, H_ / 2 + 8), 2, a(navy, 0.7f)); }
  {
    float x = 40 * u, y = H_ - 50 * u, kh = std::max(17.f, 22 * u), fs = std::max(11.f, 13 * u);
    auto hint = [&](const std::string& cap, const std::string& label) {
      x += ui.keycap(x, y, kh, cap) + 6 * u;
      x += ui.text(x, y + (kh - ui.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::Body, navy, label) + 20 * u;
    };
    if (nav.usingPad) {
      platform::PadFamily f = in.padFamily();
      hint("L STICK", "MOVE");
      hint(std::string(prompts::padGlyph(6, f)) + " " + prompts::padGlyph(7, f), "ZOOM");
      hint(prompts::padGlyph(prompts::confirmButton(f), f), "MARK");
      hint(prompts::padGlyph(3, f), "YOU");
      hint(prompts::padGlyph(prompts::backButton(f), f), "CLOSE");
    } else {
      hint("DRAG", "MOVE"); hint("WHEEL", "ZOOM"); hint("CLICK", "MARK"); hint("R", "YOU"); hint(prompts::K(in, Action::Map), "CLOSE");
    }
  }
  return true;
}

} // namespace sl
