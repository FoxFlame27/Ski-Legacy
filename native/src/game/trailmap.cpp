#include "game/trailmap.h"
#include "core/assets_path.h"
#include "core/jobs.h"
#include "core/log.h"
#include "core/prompts.h"
#include "game/play_data.h"
#include "platform/platform.h"
#include "world/lifts.h"
#include "world/transport.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <map>
#include <unordered_map>

namespace sl {
using namespace ui_color;

namespace {
constexpr double MIN_S = 0.028, MAX_S = 1.6;   // trailmap.js zoom range (CSS px per m)
constexpr float PIf = 3.14159265f;
const uint32_t PISTE_COLORS[4] = {0x1f9d4a, 0x1f5fd6, 0xd42525, 0x161616};
const char* GRADES[4] = {"Easy", "Intermediate", "Difficult", "Expert"};
const uint32_t C_BLUE = 0x1546c8, C_NAVY = 0x15214a, C_RED = 0xe2231a, C_PARK = 0xff7a1a, C_GOLD = 0xe7a500, C_EXPRESS = 0x6a22c9;
struct Level { double tile, from, contour; };
const Level LEVELS[3] = {{2048, 0, 250}, {512, 0.1, 50}, {128, 0.42, 25}};
constexpr int TPX = 64;
constexpr size_t MAX_TILES = 1400;
struct LayerDef { const char* id; const char* name; uint32_t col; };
const LayerDef LAYERS[7] = {{"pistes", "Pistes & lifts", 0x2f7bff}, {"races", "Races", 0xe23b3b}, {"roads", "Roads & car parks", 0x6f7788},
                            {"transit", "Buses & train", C_EXPRESS}, {"places", "Places", 0x1f5fd6}, {"jobs", "Jobs", 0x7a4a22}, {"mine", "Mine", C_GOLD}};
enum { L_PISTES, L_RACES, L_ROADS, L_TRANSIT, L_PLACES, L_JOBS, L_MINE };

double fadeIn(double s, double from) { return std::clamp((s - from * 0.75) / (from * 0.25), 0.0, 1.0); }
double segDist(double px, double pz, double ax, double az, double bx, double bz) {
  double dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz, t = l > 0 ? std::clamp(((px - ax) * dx + (pz - az) * dz) / l, 0.0, 1.0) : 0;
  return std::hypot(px - ax - dx * t, pz - az - dz * t);
}
std::string fmtLen(double m) {
  char b[32];
  if (m >= 1000) std::snprintf(b, sizeof b, "%.1f km", m / 1000); else std::snprintf(b, sizeof b, "%d m", int(std::lround(m / 10)) * 10);
  return b;
}
std::string fmtInt(long v) {
  std::string s = std::to_string(v < 0 ? -v : v), o;
  for (size_t i = 0; i < s.size(); i++) { if (i && (s.size() - i) % 3 == 0) o += ','; o += s[i]; }
  return (v < 0 ? "-" : "") + o;
}
std::string upper(const std::string& s) {
  std::string o;
  for (size_t i = 0; i < s.size(); i++) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c == 0xC3 && i + 1 < s.size()) { unsigned char n = static_cast<unsigned char>(s[i + 1]); o += char(c); o += char(n >= 0xA0 && n != 0xB7 ? n - 0x20 : n); i++; }   // (ä ö ü -> Ä Ö Ü)
    else o += char(std::toupper(c));
  }
  return o;
}
std::string stripParen(const std::string& s) { size_t p = s.find(" ("); return p == std::string::npos ? s : s.substr(0, p); }
const char* DOT = " \xC2\xB7 ";

enum class Ico { Lot, Depot, Bus, Train, Hut, Shop, Car, Garage, Police, Med, Heli, PoliceHeli, Drop, Board, Job, Secret, Chalet, ChaletV, MyCar, Impound, MyHeli, Dot };
struct IcoDef { uint32_t fill; bool round; };
const IcoDef ICO[] = {{C_BLUE, false}, {0xc99400, false}, {C_BLUE, false}, {C_RED, false}, {0xb8452a, false}, {0x1f5fd6, false}, {0x1f5fd6, false}, {0x1f5fd6, false},
                      {0x1f3fa8, false}, {C_RED, false}, {C_RED, true}, {0x1f3fa8, true}, {C_RED, true}, {0x7a4a22, false}, {C_GOLD, true}, {0xc98a00, true},
                      {C_GOLD, false}, {0x8a3a12, false}, {C_GOLD, false}, {0x6f7788, false}, {C_GOLD, false}, {C_RED, true}};

struct Tip { std::string title; std::vector<std::string> lines; };
struct Box { float x0, y0, x1, y1; };
struct Cand { float dx, dy; int align; float ang; bool hasAng; };   // align: 0 left, 1 center, 2 right
Cand C(float dx, float dy, int align) { return Cand{dx, dy, align, 0, false}; }
Cand CA(float dx, float dy, float ang) { return Cand{dx, dy, 1, ang, true}; }
struct Card { std::string title, more; std::vector<std::pair<std::string, uint32_t>> sub; uint32_t color = C_BLUE; bool hot = false; };
struct LabelOpt { float size = 14; int weight = 700; uint32_t color = C_NAVY; float prio = 5; float alpha = 1; bool force = false; bool hasAlpha = false; };
struct Label {
  std::string text;
  float x = 0, y = 0;
  LabelOpt o;
  std::vector<Cand> cands;
  bool isCard = false;
  Card card;
  std::function<std::vector<Cand>(float, float)> candFn;
  std::function<void(const Box&)> onPlace;
};
struct Spot {
  float x = 0, y = 0, r = 0;
  double wx = 0, wz = 0;
  std::string label;
  Tip tip;
  std::function<Tip()> tipFn;
  std::vector<std::string> more;
  std::string race, station;
  bool hasBox = false;
  Box box{};
};
struct Icon {
  float x = 0, y = 0, r = 9, prio = 5, alpha = 1;
  Ico kind = Ico::Dot;
  std::function<void()> draw;
  double wx = 0, wz = 0;
  std::string label;
  Tip tip;
  std::function<Tip()> tipFn;
  std::string lab;
  LabelOpt labo;
  bool hasBox = false;
  Box box{};
  std::string race, station;
  std::vector<std::string> more;
};
} // namespace

struct TrailMap::Impl {
  // ---------------------------------------------------------------- data
  struct Piste { std::string name; int diff = 1, number = 0; bool lane = false; std::vector<dvec2> pts; dvec2 lo{0}, hi{0}; };
  struct Lift { std::string name; bool gondola = true; dvec2 bottom{0}, top{0}; bool hasMid = false; dvec2 mid{0}; std::string midName; };
  struct RoadM { std::string name, what; int kind = 0; double length = 0; std::vector<dvec2> pts; dvec2 lo{0}, hi{0}; };
  struct RoadLabel { std::string name; double length = 0; bool scenic = false, minor = false; std::vector<dvec3> pts; };
  struct TunnelM { std::string name, road; double length = 0; std::vector<dvec2> pts; glm::dvec4 ends[2]; };
  struct Ring { double x, z, R; std::string name; };
  struct LotM { double x, z, hw, hd, ux, uz, vx, vz; std::string name, size; bool depot; };
  struct Peak { std::string id, name; double x, z, h; };
  struct Hut { std::string name, label; double x, z; };
  struct RailPt { double x, z; bool tunnel; };
  struct StationM { std::string id, name, course; double x, z, bx, bz; };
  struct RaceM { std::string id, name, diff, stop; uint32_t color; bool bus; int reward, rewardMax, drop; double length; dvec2 start, finish; std::vector<dvec2> pts; };
  struct Svc { double x, z; std::string label, what; Ico kind; };
  std::vector<Piste> pistes;
  std::vector<int> pisteOrder;   // by difficulty
  std::vector<Lift> lifts;
  std::vector<RoadM> roads;
  std::vector<RoadLabel> roadLabels;
  std::vector<TunnelM> tunnels;
  std::vector<Ring> rings;
  std::vector<LotM> lots;
  std::vector<Peak> peaks;
  std::vector<Hut> huts;
  std::vector<dvec2> village, parkLine, parkFeatures, chaletRoad;
  std::string parkName = "Legacy Park";
  double parkHalf = 17;
  bool hasPark = false, hasParkDrop = false;
  dvec2 parkDrop{0};
  std::vector<Marker> drops;
  bool hasChaletV = false;
  dvec2 chaletV{0};
  int chaletCount = 18;
  glm::dvec4 roadBox{1e18, 1e18, -1e18, -1e18};
  std::vector<RailPt> express, railway;
  std::string expressName = "Legacy Express", railName = "Wolkenspitzbahn";
  std::vector<StationM> expressStops, railStops;
  struct Stop { std::string name; double x, z; };
  std::vector<Stop> busStops;
  std::vector<RaceM> races;
  std::vector<Svc> services;
  std::vector<Marker> boards;
  dvec2 helipad{92, -128};
  bool hasHelipad = false;
  const PlayData* play = nullptr;
  const Transport* transport = nullptr;
  Travel tv;
  bool tvOpen = false;
  int tvFi = 0;
  float tvScroll = 0;
  double tvOpenT = 0;
  const World* world = nullptr;
  JobSystem* jobs = nullptr;
  gfx::Device* dev = nullptr;

  // ---------------------------------------------------------------- relief tiles
  struct Tile { gfx::Texture tex; double born = 0, used = 0; };
  struct TileJob { int li = 0, tx = 0, tz = 0; std::vector<uint8_t> px; std::atomic<bool> done{false}; };
  std::map<std::tuple<int, int, int>, Tile> tiles;
  std::vector<std::shared_ptr<TileJob>> pending;
  int missing = 1;

  // ---------------------------------------------------------------- view + state
  double vx = 0, vz = 0, vs = 0.2, minS = MIN_S;
  bool opened = false;
  bool layers[7] = {true, true, true, true, true, true, true};
  bool legendOpen = false;
  float legendScroll = 0;
  double now = 0, openT = 0, lastClickT = -10;
  vec2 lastClickAt{-100};
  bool dragging = false;
  vec2 dragStart{0};
  dvec2 dragView{0};
  float dragMoved = 0;
  std::string hotRace, hotStation;
  std::string where;
  // the frame
  Ui* ui = nullptr;
  float d = 1, u = 1;            // dpr, --u (drawable px)
  float ox = 0, oy = 0;          // the canvas's top-left (drawable px)
  float W = 10, H = 10;          // the canvas (CSS px)
  std::vector<Box> boxes;
  std::vector<Label> queue;
  std::vector<Spot> spots, dynSpots;
  std::vector<Icon> icons;
  struct Pin { float x, cy, r; uint32_t col; };
  std::unordered_map<std::string, Pin> pins;
  Live mk;
  int drawn = 0;
  TrailMap* owner = nullptr;

  // ---- canvas helpers (CSS px on the canvas -> drawable px)
  float X(double x) const { return float((x - vx) * vs + W / 2); }
  float Z(double z) const { return float((z - vz) * vs + H / 2); }
  vec2 P(float x, float y) const { return vec2(ox + x * d, oy + y * d); }
  bool inView(float x, float y, float m = 40) const { return x > -m && y > -m && x < W + m && y < H + m; }
  void reserve(float x, float y, float r) { boxes.push_back({x - r, y - r, x + r, y + r}); }
  bool boxVisible(const dvec2& lo, const dvec2& hi, float m = 60) const { return X(hi.x) > -m && X(lo.x) < W + m && Z(hi.y) > -m && Z(lo.y) < H + m; }
  /// trailmap.js path(): the polyline on the canvas, dense stretches thinned
  std::vector<vec2> path(const std::vector<dvec2>& pts) const {
    std::vector<vec2> o;
    o.reserve(pts.size());
    vec2 last(0);
    for (size_t i = 0; i < pts.size(); i++) {
      vec2 q(X(pts[i].x), Z(pts[i].y));
      if (!o.empty() && i + 1 < pts.size() && std::fabs(q.x - last.x) + std::fabs(q.y - last.y) < 1.5f) continue;
      o.push_back(q);
      last = q;
    }
    return o;
  }
  bool segVisible(vec2 a, vec2 b, float m) const { return !(std::max(a.x, b.x) < -m || std::min(a.x, b.x) > W + m || std::max(a.y, b.y) < -m || std::min(a.y, b.y) > H + m); }
  void stroke(const std::vector<vec2>& p, float w, const vec4& c) {
    for (size_t i = 1; i < p.size(); i++) if (segVisible(p[i - 1], p[i], w)) ui->capsule(P(p[i - 1].x, p[i - 1].y), P(p[i].x, p[i].y), w * d, c);
    drawn++;
  }
  void dash(const std::vector<vec2>& p, float w, const vec4& c, float on, float off, bool round = false) {
    // (the dash pattern runs along the whole path, so the off-screen part still counts; long paths are clipped first)
    std::vector<vec2> q;
    q.reserve(p.size());
    for (const vec2& v : p) q.push_back(P(v.x, v.y));
    ui->dashPath(q, w * d, c, on * d, off * d, round);
    drawn++;
  }
  void line(float ax, float ay, float bx, float by, float w, const vec4& c, bool round = true) { ui->capsule(P(ax, ay), P(bx, by), w * d, c, round); }
  void fillRect(float x, float y, float w, float h, const vec4& c) { ui->rect(ox + x * d, oy + y * d, w * d, h * d, c); }
  void strokeRect(float x, float y, float w, float h, float lw, const vec4& c) { ui->roundRectStroke(ox + (x - lw / 2) * d, oy + (y - lw / 2) * d, (w + lw) * d, (h + lw) * d, 0, lw * d, c); }
  void disc(float x, float y, float r, const vec4& c) { vec2 p = P(x, y); ui->circle(p.x, p.y, r * d, c); }
  void ringS(float x, float y, float r, float lw, const vec4& c) { vec2 p = P(x, y); ui->ring(p.x, p.y, (r + lw / 2) * d, lw * d, c); }
  void polyF(std::initializer_list<vec2> pts, const vec4& c) { std::vector<vec2> q; for (const vec2& v : pts) q.push_back(P(v.x, v.y)); ui->polyAA(q, c); }
  void polyS(std::initializer_list<vec2> pts, float lw, const vec4& c) { std::vector<vec2> q; for (const vec2& v : pts) q.push_back(P(v.x, v.y)); ui->strokePath(q, lw * d, c, true); }
  UiFont fontOf(int weight) const { return weight >= 700 ? UiFont::CondItalic : UiFont::CondSemiItalic; }
  float measure(const std::string& s, float size, UiFont f) const { return ui->textWidth(s, size * d, f) / d; }
  /// canvas fillText with textBaseline middle (y = the em box's middle); align 0 left, 1 center, 2 right
  void text(const std::string& s, float x, float y, float size, UiFont f, const vec4& c, int align = 0, const vec4& halo = vec4(0), float haloR = 0) {
    vec2 p = P(x, y);
    float fs = size * d;
    UiAlign al = align == 1 ? UiAlign::Center : align == 2 ? UiAlign::Right : UiAlign::Left;
    float yt = p.y - ui->lineHeight(fs, f) * 0.5f;
    if (halo.w > 0) ui->textHalo(p.x, yt, fs, f, c, halo, haloR * d, s, al);
    else ui->text(p.x, yt, fs, f, c, s, al);
  }

  // ---------------------------------------------------------------- icons (trailmap.js mapIcon)
  void mapIcon(Ico kind, float x, float y, float r, float alpha = 1) {
    const IcoDef& I = ICO[size_t(kind)];
    vec2 c = P(x, y);
    float R = r * d, rad = I.round ? R : R * 0.36f;
    const vec4 fill = hex(I.fill, alpha), wh = a(white, alpha);
    ui->boxShadow(c.x - R, c.y - R, 2 * R, 2 * R, rad, 0, 1 * d, 3 * d, hex(0x08143c, 0.35f * alpha));
    ui->roundRect(c.x - R - d, c.y - R - d, 2 * R + 2 * d, 2 * R + 2 * d, rad + d, wh);
    ui->roundRect(c.x - R + d, c.y - R + d, 2 * R - 2 * d, 2 * R - 2 * d, std::max(0.f, rad - d), fill);
    const float k = r / 9 * d;
    auto G = [&](float gx, float gy) { return vec2(c.x + gx * k, c.y + gy * k); };
    auto rect = [&](float gx, float gy, float gw, float gh, const vec4& col) { ui->rect(c.x + gx * k, c.y + gy * k, gw * k, gh * k, col); };
    auto ln = [&](float ax, float ay, float bx, float by, float lw) { ui->capsule(G(ax, ay), G(bx, by), lw * k, wh); };
    auto txt = [&](const char* t, float px, UiFont f) { float fs = px * k; ui->text(c.x, c.y + 0.7f * k - ui->lineHeight(fs, f) * 0.5f, fs, f, wh, t, UiAlign::Center); };
    auto house = [&]() { ui->polyAA({G(0, -6.5f), G(6.5f, -0.5f), G(6.5f, 5.5f), G(-6.5f, 5.5f), G(-6.5f, -0.5f)}, wh); };
    auto car = [&]() {
      ui->roundRect(c.x - 6 * k, c.y - 1 * k, 12 * k, 4.2f * k, 1.5f * k, wh);
      ui->polyAA({G(-3.5f, -1), G(-2, -4.8f), G(2.5f, -4.8f), G(4, -1)}, wh);
      for (float wx : {-3.5f, 3.5f}) ui->circle(c.x + wx * k, c.y + 3.3f * k, 1.6f * k, fill);
    };
    switch (kind) {
      case Ico::Lot: txt("P", 12.5f, UiFont::BodyHeavy); break;
      case Ico::Depot: txt("B", 12.5f, UiFont::BodyHeavy); break;
      case Ico::Bus: txt("BUS", 6.8f, UiFont::BodyHeavy); break;
      case Ico::Train:
        ui->roundRectStroke(c.x - 5.4f * k, c.y - 6.9f * k, 10.8f * k, 11.8f * k, 3.1f * k, 1.8f * k, wh);
        rect(-4.5f, -1.5f, 9, 1.6f, wh);
        ln(-3, 4, -5, 7, 1.8f); ln(3, 4, 5, 7, 1.8f);
        break;
      case Ico::Hut: case Ico::Chalet: case Ico::ChaletV: house(); break;
      case Ico::Shop: ln(-5, 5.5f, 3, -5.5f, 2.2f); ln(-1.5f, 5.5f, 6, -5.5f, 2.2f); break;
      case Ico::Car: case Ico::MyCar: case Ico::Impound: car(); break;
      case Ico::Garage:
        ln(-4.5f, 4.5f, 2, -2, 2.6f);
        ui->arc(c.x + 3 * k, c.y - 3 * k, 3 * k, PIf * 0.95f, PIf * 2.55f, 2 * k, wh);
        break;
      case Ico::Police:
        for (float bx : {-5.f, -1.5f, 2.f}) rect(bx, -6, 2, 12, wh);
        rect(-6, -6, 12, 1.6f, wh); rect(-6, 4.4f, 12, 1.6f, wh);
        break;
      case Ico::Med: rect(-6, -2, 12, 4, wh); rect(-2, -6, 4, 12, wh); break;
      case Ico::Heli: case Ico::PoliceHeli: case Ico::MyHeli: txt("H", 13, UiFont::CondItalic); break;
      case Ico::Drop: ui->polyAA({G(0, -5), G(5.5f, 4), G(-5.5f, 4)}, wh); break;
      case Ico::Board:
        ui->roundRectStroke(c.x - 5.3f * k, c.y - 5.8f * k, 10.6f * k, 12.6f * k, 0.8f * k, 1.6f * k, wh);
        rect(-2.5f, -6.5f, 5, 2.5f, wh); rect(-2.5f, -1.5f, 5, 1.3f, wh); rect(-2.5f, 1.5f, 5, 1.3f, wh);
        break;
      case Ico::Job: txt("!", 13, UiFont::BodyHeavy); break;
      case Ico::Secret: ui->polyAA({G(0, -6), G(5, 0), G(0, 6), G(-5, 0)}, wh); break;
      case Ico::Dot: break;
    }
    drawn++;
  }
  /// a race badge: a pin in the race's colour with a white rim and a chequered flag, its tip on (x, y)
  float racePin(float x, float y, float r, uint32_t col) {
    float dd = r * 1.75f, cy = y - dd, f = std::acos(r / dd);
    std::vector<vec2> pts;
    const int N = 22;
    float a0 = PIf / 2 + f, a1 = PIf / 2 - f + 2 * PIf;
    for (int i = 0; i <= N; i++) { float t = a0 + (a1 - a0) * float(i) / N; pts.push_back(P(x + std::cos(t) * r, cy + std::sin(t) * r)); }
    pts.push_back(P(x, y));
    vec2 c = P(x, cy);
    ui->boxShadow(c.x - r * d, c.y - r * d, 2 * r * d, 2 * r * d, r * d, 0, 1.5f * d, 5 * d, hex(0x08143c, 0.4f));
    ui->strokePath(pts, std::max(2.f, r * 0.2f) * d + 2 * d, white, true);
    ui->poly(pts, hex(col));
    ui->circle(c.x, c.y, r * d, hex(col));
    ui->strokePath(pts, 1, hex(col), true);
    float px = x - r * 0.44f, top = cy - r * 0.5f, fw = r * 1.02f, fh = r * 0.64f, cw = fw / 3, ch = fh / 2;
    fillRect(px - 0.7f, top - 0.5f, 1.5f, r * 1.12f, white);
    for (int j = 0; j < 2; j++) for (int i = 0; i < 3; i++) if ((i + j) % 2 == 0) fillRect(px + 0.8f + float(i) * cw, top + float(j) * ch, cw, ch, white);
    strokeRect(px + 0.8f, top, fw, fh, 1, white);
    drawn++;
    return cy;
  }
  void finishMark(float x, float y, float q, uint32_t col) {
    float c = q / 3;
    fillRect(x - q / 2 - 2, y - q / 2 - 2, q + 4, q + 4, white);
    strokeRect(x - q / 2 - 2, y - q / 2 - 2, q + 4, q + 4, 1.2f, hex(col));
    for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) if ((i + j) % 2 == 0) fillRect(x - q / 2 + float(i) * c, y - q / 2 + float(j) * c, c, c, hex(0x161616));
    drawn++;
  }
  void expressStop(float x, float y, float r, bool big, float alpha = 1) {
    disc(x, y, r + 1.6f, a(white, alpha));
    ringS(x, y, r - 1.4f - 1.4f, 2.8f, hex(C_EXPRESS, alpha));
    if (big) disc(x, y, r * 0.38f, hex(C_EXPRESS, alpha));
    drawn++;
  }
  void clusterBadge(float x, float y, int n, float r = 7) {
    disc(x, y, r + 0.75f, white);
    disc(x, y, r - 0.75f, hex(C_NAVY));
    text("+" + std::to_string(n - 1), x, y + 0.5f, n > 9 ? 7.5f : 8.5f, UiFont::BodyHeavy, white, 1);
  }
  void pisteBadge(float x, float y, float r, uint32_t col, int num, float alpha = 1) {
    disc(x, y, r + 1, a(white, alpha));
    disc(x, y, r - 1, hex(col, alpha));
    text(std::to_string(num), x, y + 0.5f, std::round(r * (num > 9 ? 1.2f : 1.4f)), UiFont::CondItalic, a(white, alpha), 1);
    drawn++;
  }
  /// you: a red arrow in a white halo; ang on the canvas (0 = +x)
  void arrow(float x, float y, float ang, float k = 1) {
    disc(x, y, 17 * k, a(white, 0.82f));
    ringS(x, y, 17 * k - 0.75f, 1.5f, hex(C_RED, 0.55f));
    float c = std::cos(ang), s = std::sin(ang);
    auto R = [&](float px, float py) { return vec2(x + (px * c - py * s) * k, y + (px * s + py * c) * k); };
    vec2 p0 = R(14, 0), p1 = R(-9, -10), p2 = R(-4, 0), p3 = R(-9, 10);
    vec2 sp = P(x, y);
    ui->boxShadow(sp.x - 8 * k * d, sp.y - 8 * k * d, 16 * k * d, 16 * k * d, 8 * k * d, 0, 1 * d, 4 * d, hex(0x08143c, 0.3f));
    polyS({p0, p1, p2, p3}, 2.5f * k, white);
    ui->tri(P(p0.x, p0.y), P(p1.x, p1.y), P(p2.x, p2.y), hex(C_RED));
    ui->tri(P(p0.x, p0.y), P(p2.x, p2.y), P(p3.x, p3.y), hex(C_RED));
    polyS({p0, p1, p2, p3}, 1 / d, hex(C_RED));
  }

  // ---------------------------------------------------------------- spots, icons, labels
  void spot(float x, float y, float r, double wx, double wz, const std::string& label, Tip tip = {}, std::function<Tip()> tipFn = nullptr) {
    if (label.empty()) return;
    Spot s;
    s.x = x; s.y = y; s.r = r; s.wx = wx; s.wz = wz; s.label = label; s.tip = std::move(tip); s.tipFn = std::move(tipFn);
    spots.push_back(std::move(s));
  }
  void icon(Icon o) { if (o.alpha > 0.04f && inView(o.x, o.y, 20)) icons.push_back(std::move(o)); }
  std::vector<Cand> around(float r, float gap = 5) const { return {C(r + gap, 0, 0), C(-r - gap, 0, 2), C(0, -r - gap - 7, 1), C(0, r + gap + 7, 1)}; }
  void label(const std::string& t, float x, float y, const LabelOpt& o, std::vector<Cand> cands) {
    Label L;
    L.text = t; L.x = x; L.y = y; L.o = o; L.cands = std::move(cands);
    queue.push_back(std::move(L));
  }

  void placeIcons() {
    std::stable_sort(icons.begin(), icons.end(), [](const Icon& p, const Icon& q) { return p.prio < q.prio; });
    std::vector<size_t> placed;
    for (size_t i = 0; i < icons.size(); i++) {
      Icon& o = icons[i];
      Icon* host = nullptr;
      for (size_t pi : placed) { Icon& p = icons[pi]; if (std::hypot(p.x - o.x, p.y - o.y) < p.r + o.r + 1) { host = &p; break; } }
      if (host) { if (!o.label.empty()) host->more.push_back(o.label); continue; }
      placed.push_back(i);
      if (o.draw) { ui->pushAlpha(o.alpha); o.draw(); ui->popAlpha(); } else mapIcon(o.kind, o.x, o.y, o.r, o.alpha);
      if (o.hasBox) boxes.push_back(o.box); else reserve(o.x, o.y, o.r + 1);
      if (!o.lab.empty()) {
        LabelOpt lo = o.labo;
        if (!lo.hasAlpha) lo.alpha = o.alpha;
        label(o.lab, o.x, o.y, lo, around(o.r + 1, 4));
      }
    }
    for (size_t pi : placed) {
      Icon& p = icons[pi];
      if (!p.more.empty()) clusterBadge(p.x + p.r * 0.85f, p.y - p.r * 0.85f, int(p.more.size()) + 1);
      if (!p.label.empty()) {
        Spot s;
        s.x = p.x; s.y = p.y; s.r = p.r + 2; s.wx = p.wx; s.wz = p.wz; s.label = p.label; s.tip = p.tip; s.tipFn = p.tipFn; s.more = p.more; s.race = p.race; s.station = p.station;
        spots.push_back(std::move(s));
      }
    }
  }

  vec2 cardSize(const Card& c) const {
    float w = measure(c.title, 16, UiFont::CondItalic), sw = 0;
    for (const auto& [t, col] : c.sub) sw += measure(t, 13.5f, UiFont::CondItalic);
    w = std::max(w, sw);
    if (!c.more.empty()) w = std::max(w, measure(c.more, 13, UiFont::CondSemiItalic));
    return vec2(std::ceil(w) + 21, c.more.empty() ? 36 : 48);
  }
  void drawCard(const Card& c, float x, float y, float w, float h, float alpha) {
    vec2 p = P(x, y);
    ui->pushAlpha(alpha);
    ui->boxShadow(p.x, p.y, w * d, h * d, 4 * d, 0, 2 * d, 7 * d, hex(0x08143c, 0.3f));
    ui->roundRect(p.x, p.y, w * d, h * d, 4 * d, a(white, 0.97f));
    ui->pushClip(p.x, p.y, 5 * d, h * d);
    ui->roundRect(p.x, p.y, w * d, h * d, 4 * d, hex(c.color));
    ui->popClip();
    if (c.hot) ui->roundRectStroke(p.x - 1.25f * d, p.y - 1.25f * d, (w + 2.5f) * d, (h + 2.5f) * d, 5.25f * d, 2.5f * d, hex(c.color));
    text(c.title, x + 12, y + 12.5f, 16, UiFont::CondItalic, hex(C_NAVY));
    float sx = x + 12;
    for (const auto& [t, col] : c.sub) { text(t, sx, y + 26.5f, 13.5f, UiFont::CondItalic, hex(col)); sx += measure(t, 13.5f, UiFont::CondItalic); }
    if (!c.more.empty()) text(c.more, x + 12, y + 39, 13, UiFont::CondSemiItalic, hex(0x4a5a85));
    ui->popAlpha();
    drawn++;
  }

  void placeLabels() {
    auto hit = [&](const Box& b) { for (const Box& q : boxes) if (q.x0 < b.x1 && q.x1 > b.x0 && q.y0 < b.y1 && q.y1 > b.y0) return true; return false; };
    std::stable_sort(queue.begin(), queue.end(), [](const Label& p, const Label& q) { return p.o.prio < q.o.prio; });
    struct Pick { float x, y; int align; float ang; Box box; float o; bool ok = false; };
    for (Label& L : queue) {
      if (L.o.alpha < 0.05f) continue;
      float size = L.o.size, w, h;
      UiFont f = fontOf(L.o.weight);
      if (L.isCard) { vec2 cs = cardSize(L.card); w = cs.x; h = cs.y; }
      else { w = measure(L.text, size, f); h = size * 0.9f; }
      std::vector<Cand> cands = L.candFn ? L.candFn(w, h) : L.cands;
      if (cands.empty()) cands.push_back(C(0, 0, 0));
      float pad = L.isCard ? 1.f : 2.f;
      Pick pick, fb;
      for (const Cand& cd : cands) {
        float x = L.x + cd.dx, y = L.y + cd.dy, ang = cd.hasAng ? cd.ang : 0;
        Box box;
        if (ang != 0) {
          float c = std::fabs(std::cos(ang)), s = std::fabs(std::sin(ang)), bw = w * c + h * s, bh = w * s + h * c;
          box = {x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2};
        } else {
          float x0 = cd.align == 1 ? x - w / 2 : cd.align == 2 ? x - w : x;
          box = {x0 - pad, y - h / 2 - pad, x0 + w + pad, y + h / 2 + pad};
        }
        if (!(box.x0 > 4 && box.y0 > 4 && box.x1 < W - 4 && box.y1 < H - 4)) continue;
        if (!hit(box)) { pick = {x, y, cd.align, ang, box, 0, true}; break; }
        if (L.o.force) {
          float o = 0;
          for (const Box& q : boxes) o += std::max(0.f, std::min(q.x1, box.x1) - std::max(q.x0, box.x0)) * std::max(0.f, std::min(q.y1, box.y1) - std::max(q.y0, box.y0));
          if (!fb.ok || o < fb.o) fb = {x, y, cd.align, ang, box, o, true};
        }
      }
      if (!pick.ok) pick = fb;
      if (!pick.ok) continue;
      boxes.push_back(pick.box);
      if (L.isCard) { drawCard(L.card, pick.box.x0 + pad, pick.box.y0 + pad, w, h, L.o.alpha); if (L.onPlace) L.onPlace(pick.box); continue; }
      const vec4 halo = a(white, 0.94f * L.o.alpha), col = hex(L.o.color, L.o.alpha);
      float hr = std::max(3.f, size * 0.3f) / 2;
      if (pick.ang != 0) {
        vec2 p = P(pick.x, pick.y);
        ui->pushRotate(p.x, p.y, pick.ang);
        text(L.text, pick.x, pick.y, size, f, col, 1, halo, hr);
        ui->popTransform();
      } else text(L.text, pick.x, pick.y, size, f, col, pick.align, halo, hr);
      drawn++;
    }
  }

  // ---------------------------------------------------------------- tips
  Tip pisteTip(const Piste& p) const {
    double len = 0;
    for (size_t i = 1; i < p.pts.size(); i++) len += glm::length(p.pts[i] - p.pts[i - 1]);
    int drop = 0;
    if (world && p.pts.size() > 1) drop = int(std::lround(std::fabs(world->height(p.pts.front().x, p.pts.front().y) - world->height(p.pts.back().x, p.pts.back().y))));
    return {std::to_string(p.number) + DOT + p.name, {std::string(GRADES[p.diff]) + " piste" + (p.lane ? std::string(DOT) + "ski lane" : ""), fmtLen(len) + DOT + std::to_string(drop) + " m drop"}};
  }
  Tip liftTip(const Lift& l) const {
    double len = glm::length(l.top - l.bottom);
    int rise = world ? int(std::lround(world->height(l.top.x, l.top.y) - world->height(l.bottom.x, l.bottom.y))) : 0;
    return {l.name, {l.gondola ? "Gondola" : "Chairlift", fmtLen(len) + DOT + std::to_string(rise) + " m up"}};
  }
  Tip raceTip(const RaceM& e) const {
    char b[64];
    std::snprintf(b, sizeof b, "%.1f km", e.length / 1000);
    return {e.name, {e.bus ? "Free race" + std::string(DOT) + "ski bus: " + e.stop : e.diff + DOT + "up to $" + fmtInt(e.rewardMax ? e.rewardMax : e.reward), std::string(b) + DOT + std::to_string(e.drop) + " m drop"}};
  }

  // ---------------------------------------------------------------- relief
  struct Range { int tx0, tx1, tz0, tz1; };
  Range range(int li) const {
    double T = LEVELS[li].tile, hw = W / 2 / vs, hh = H / 2 / vs;
    return {int(std::floor((vx - hw) / T)), int(std::floor((vx + hw) / T)), int(std::floor((vz - hh) / T)), int(std::floor((vz + hh) / T))};
  }
  static void buildTile(const World* w, TileJob& J) {
    const Level& L = LEVELS[J.li];
    const double STEP = L.tile / TPX;
    const int N = TPX + 2, M = N + 2;
    const double x0 = J.tx * L.tile - STEP, z0 = J.tz * L.tile - STEP;
    std::vector<float> Hh(size_t(M) * M);
    for (int j = 0; j < M; j++) for (int i = 0; i < M; i++) Hh[size_t(j) * M + size_t(i)] = float(w->height(x0 + (i - 0.5) * STEP, z0 + (j - 0.5) * STEP));
    J.px.assign(size_t(N) * N * 4, 255);
    const double Lx = -0.55, Ly = 0.62, Lz = -0.56;
    auto ci = [&](double h) { return std::floor(h / L.contour); };
    auto cj = [&](double h) { return std::floor(h / (L.contour * 5)); };
    for (int j = 0; j < N; j++)
      for (int i = 0; i < N; i++) {
        size_t k = size_t(j + 1) * M + size_t(i + 1);
        double h = Hh[k];
        double gx = (Hh[k + 1] - Hh[k - 1]) / (2 * STEP), gz = (Hh[k + size_t(M)] - Hh[k - size_t(M)]) / (2 * STEP);
        double slope = std::hypot(gx, gz);
        double nx = -gx * 1.5, nz = -gz * 1.5, nl = std::sqrt(nx * nx + 1 + nz * nz);
        double t = std::clamp(((nx * Lx + Ly + nz * Lz) / nl / Ly - 0.3) / 0.85, 0.0, 1.0);
        double r = 200 + 51 * t, g = 212 + 40 * t, b = 236 + 19 * t;
        double rock = std::clamp((slope - 0.85) / 0.35, 0.0, 1.0);
        if (rock > 0) { double rt = 0.8 + 0.2 * t; r += (170 * rt - r) * rock * 0.85; g += (182 * rt - g) * rock * 0.85; b += (206 * rt - b) * rock * 0.85; }
        double x = x0 + (i + 0.5) * STEP, z = z0 + (j + 0.5) * STEP;
        double f = w->forest(x, z, h, slope);
        if (f > 0.12) { double ft = std::min(1.0, (f - 0.12) / 0.55) * 0.5, fl = 0.8 + 0.2 * t; r += (150 * fl - r) * ft; g += (176 * fl - g) * ft; b += (206 * fl - b) * ft; }
        if (ci(Hh[k + 1]) != ci(h) || ci(Hh[k + size_t(M)]) != ci(h)) {
          double m = cj(Hh[k + 1]) != cj(h) || cj(Hh[k + size_t(M)]) != cj(h) ? 0.87 : 0.94;
          r *= m; g *= m; b *= m;
        }
        uint8_t* o = &J.px[(size_t(j) * N + size_t(i)) * 4];
        o[0] = uint8_t(std::clamp(r, 0.0, 255.0)); o[1] = uint8_t(std::clamp(g, 0.0, 255.0)); o[2] = uint8_t(std::clamp(b, 0.0, 255.0));
      }
    J.done = true;
  }
  // the coarse level everywhere in view first, then the level the zoom wants, nearest the centre first
  void buildTiles() {
    if (!dev || !jobs || !world) { missing = 0; return; }
    // the finished ones become textures
    int up = 0;
    for (size_t i = 0; i < pending.size() && up < 24;) {
      if (!pending[i]->done.load()) { i++; continue; }
      TileJob& J = *pending[i];
      gfx::TextureDesc td;
      td.width = td.height = TPX + 2; td.format = gfx::TexFormat::RGBA8; td.filter = gfx::Filter::Linear; td.wrap = gfx::Wrap::Clamp; td.mipmaps = false; td.anisotropy = 1;
      Tile t;
      t.tex = dev->createTexture(td, J.px.data());
      t.born = now; t.used = now;
      tiles[{J.li, J.tx, J.tz}] = t;
      pending.erase(pending.begin() + long(i));
      up++;
    }
    if (tiles.size() > MAX_TILES) {
      std::vector<std::pair<double, std::tuple<int, int, int>>> old;
      for (auto& [k, t] : tiles) old.push_back({t.used, k});
      std::sort(old.begin(), old.end());
      for (size_t i = 0; i < 300 && i < old.size(); i++) { dev->destroy(tiles[old[i].second].tex); tiles.erase(old[i].second); }
    }
    int want = 0;
    for (int i = 0; i < 3; i++) if (vs >= LEVELS[i].from) want = i;
    struct Todo { int li, tx, tz; double dist; };
    std::vector<Todo> todo;
    int lv[2] = {0, want};
    for (int q = 0; q < (want ? 2 : 1); q++) {
      int li = lv[q];
      Range R = range(li);
      double T = LEVELS[li].tile;
      std::vector<Todo> part;
      for (int tz = R.tz0; tz <= R.tz1; tz++) for (int tx = R.tx0; tx <= R.tx1; tx++) {
        if (tiles.count({li, tx, tz})) continue;
        part.push_back({li, tx, tz, std::hypot((tx + 0.5) * T - vx, (tz + 0.5) * T - vz)});
      }
      std::sort(part.begin(), part.end(), [](const Todo& p, const Todo& q2) { return p.dist < q2.dist; });
      todo.insert(todo.end(), part.begin(), part.end());
    }
    missing = int(todo.size());
    size_t maxFlight = size_t(std::max(2, jobs->threads())) * 3;
    for (const Todo& t : todo) {
      if (pending.size() >= maxFlight) break;
      bool queued = false;
      for (auto& p : pending) queued = queued || (p->li == t.li && p->tx == t.tx && p->tz == t.tz);
      if (queued) continue;
      auto J = std::make_shared<TileJob>();
      J->li = t.li; J->tx = t.tx; J->tz = t.tz;
      pending.push_back(J);
      const World* w = world;
      jobs->push([J, w] { buildTile(w, *J); });
    }
  }
  void drawRelief() {
    for (int li = 0; li < 3; li++) {
      const Level& L = LEVELS[li];
      if (li && vs < L.from) continue;
      Range R = range(li);
      const float e = 1.f / float(TPX + 2);
      for (int tz = R.tz0; tz <= R.tz1; tz++) for (int tx = R.tx0; tx <= R.tx1; tx++) {
        auto it = tiles.find({li, tx, tz});
        if (it == tiles.end()) continue;
        it->second.used = now;
        float al = float(std::min(1.0, (now - it->second.born) / 0.28));
        vec2 p0 = P(X(tx * L.tile), Z(tz * L.tile)), p1 = P(X((tx + 1) * L.tile), Z((tz + 1) * L.tile));
        ui->image(it->second.tex, p0.x, p0.y, p1.x - p0.x, p1.y - p0.y, vec2(e, e), vec2(1 - e, 1 - e), vec4(1, 1, 1, al));
        drawn++;
      }
    }
  }

  // ---------------------------------------------------------------- roads
  void drawRoads() {
    if (roads.empty()) return;
    const double s = vs;
    if (X(roadBox.z) < -40 || Z(roadBox.w) < -40 || X(roadBox.x) > W + 40 || Z(roadBox.y) > H + 40) return;
    const float wMain = float(std::max(2.2, std::min(6.0, 6.8 * s))), wMinor = float(std::max(1.4, std::min(4.5, 5.5 * s)));
    auto pass = [&](int kind, float w, const vec4& casing, const vec4& col) {
      std::vector<std::vector<vec2>> ps;
      for (const RoadM& r : roads) if (r.kind == kind && boxVisible(r.lo, r.hi)) ps.push_back(path(r.pts));
      for (auto& p : ps) stroke(p, w + 2.6f, casing);
      for (auto& p : ps) stroke(p, w, col);
    };
    if (s >= 0.05) { pass(2, wMinor, a(white, 0.92f), hex(0x8a8f98)); pass(3, wMinor, a(white, 0.92f), hex(0xd39a3c)); }
    pass(0, wMain, a(white, 0.95f), hex(0x6f7788));
    pass(1, wMain, a(white, 0.95f), hex(0xc9811a));
    pass(4, wMain, a(white, 0.95f), hex(0xc9811a));
    // the tunnels: the road under them washed out to the paper, then a dark slate dash down it
    for (const TunnelM& T : tunnels) {
      std::vector<vec2> p = path(T.pts);
      bool vis = false;
      for (const vec2& q : p) vis = vis || inView(q.x, q.y, 20);
      if (!vis) continue;
      for (size_t i = 1; i < p.size(); i++) ui->capsule(P(p[i - 1].x, p[i - 1].y), P(p[i].x, p[i].y), (wMain + 0.8f) * d, hex(0xf6f7f9, 0.97f), false);
      for (size_t i = 1; i + 1 < p.size(); i++) disc(p[i].x, p[i].y, (wMain + 0.8f) / 2, hex(0xf6f7f9, 0.97f));
      dash(p, std::max(1.6f, wMain * 0.62f), hex(0x3b4150), 5, 3.5f, false);
    }
    // the portals: a small dark bracket across the road at each end, its wings pointing out of the mountain
    if (!tunnels.empty() && s >= 0.04) {
      const float hw = wMain / 2 + 2.6f, wing = float(std::max(2.0, std::min(4.5, 3 * s + 1.5))), lw = std::max(1.4f, std::min(2.4f, wMain * 0.4f));
      for (const TunnelM& T : tunnels) for (int j = 0; j < 2; j++) {
        const glm::dvec4& e = T.ends[j];
        float x = X(e.x), y = Z(e.y);
        if (!inView(x, y, 20)) continue;
        float o = j ? 1.f : -1.f, ax = float(e.z) * o, ay = float(e.w) * o, nx = -float(e.w), ny = float(e.z);
        std::vector<vec2> q = {P(x + nx * hw + ax * wing, y + ny * hw + ay * wing), P(x + nx * hw, y + ny * hw), P(x - nx * hw, y - ny * hw), P(x - nx * hw + ax * wing, y - ny * hw + ay * wing)};
        ui->strokePath(q, lw * d, hex(0x2a2f3a));
      }
    }
    // the roundabouts: a white island (and the name, zoomed right in; else in the tooltip)
    for (const Ring& q : rings) {
      float x = X(q.x), y = Z(q.z);
      if (!inView(x, y) || s < 0.05) continue;
      float r = float(std::max(2.5, (q.R - 4) * s));
      disc(x, y, r + 0.6f, hex(0xc9811a));
      disc(x, y, r - 0.6f, white);
      reserve(x, y, float(std::max(5.0, q.R * s)));
      if (!q.name.empty()) {
        spot(x, y, float(std::max(7.0, q.R * s)), q.x, q.z, q.name, {q.name, {"Roundabout"}});
        if (s >= 0.4) { LabelOpt o; o.size = 12.5f; o.weight = 600; o.color = 0x8a5a0c; o.prio = 7; o.alpha = float(fadeIn(s, 0.4)); label(q.name, x, y, o, around(float(std::max(6.0, q.R * s)), 5)); }
      }
    }
    // the car parks: the lot's outline zoomed in, a P badge (the big ones from further out; the bus depot a yellow B)
    const float IR = s >= 0.25 ? 10.f : 8.5f;
    for (const LotM& L : lots) {
      float x = X(L.x), y = Z(L.z);
      if (!inView(x, y)) continue;
      if (s >= 0.35) {
        std::vector<vec2> q;
        const int cs[4][2] = {{-1, -1}, {1, -1}, {1, 1}, {-1, 1}};
        for (auto& c : cs) q.push_back(P(X(L.x + L.ux * c[0] * L.hw + L.vx * c[1] * L.hd), Z(L.z + L.uz * c[0] * L.hw + L.vz * c[1] * L.hd)));
        ui->polyAA(q, hex(0x8a8f98, 0.55f));
        ui->strokePath(q, 1 * d, white, true);
      }
      bool big = L.size == "big" || L.depot;
      std::string name = !L.name.empty() ? L.name : L.depot ? "Bus depot" : "Car park";
      Icon o;
      o.kind = L.depot ? Ico::Depot : Ico::Lot; o.x = x; o.y = y; o.r = big ? IR : IR - 1.5f; o.prio = big ? 5.f : 6.5f; o.alpha = float(fadeIn(s, big ? 0.06 : 0.16));
      o.wx = L.x; o.wz = L.z; o.label = name;
      o.tip = {name, {L.depot ? "Bus depot" : "Car park" + (L.size.empty() ? std::string() : DOT + L.size)}};
      if (s >= 0.5 && !L.name.empty()) o.lab = L.name;
      o.labo.size = 12.5f; o.labo.weight = 600; o.labo.color = L.depot ? 0x8a6200 : C_BLUE; o.labo.prio = 8;
      icon(std::move(o));
    }
    // the road names along them (upright, either side, as near the middle of the view as it fits)
    const float cx = W / 2, cy = H / 2;
    for (const RoadLabel& n : roadLabels) {
      if (n.minor ? s < 0.35 : s < 0.1) continue;
      float tw = measure(n.name, 13, UiFont::CondItalic);
      if (n.length * s < tw * 1.6) continue;
      std::vector<std::pair<float, std::pair<Cand, Cand>>> cands;
      for (const dvec3& q : n.pts) {
        float x = X(q.x), y = Z(q.y);
        if (!inView(x, y, -30)) continue;
        float ang = float(q.z);
        if (ang > PIf / 2) ang -= PIf; else if (ang < -PIf / 2) ang += PIf;
        float off = wMain / 2 + 8, nx = -std::sin(ang) * off, ny = std::cos(ang) * off;
        cands.push_back({std::hypot(x - cx, y - cy), {CA(x + nx, y + ny, ang), CA(x - nx, y - ny, ang)}});
      }
      if (cands.empty()) continue;
      std::stable_sort(cands.begin(), cands.end(), [](const auto& p, const auto& q) { return p.first < q.first; });
      std::vector<Cand> flat;
      for (size_t i = 0; i < cands.size() && i < 14; i++) { flat.push_back(cands[i].second.first); flat.push_back(cands[i].second.second); }
      LabelOpt o;
      o.size = 13; o.color = n.scenic ? 0x8a5a0c : 0x4a5263; o.prio = n.minor ? 7.5f : 4.5f; o.alpha = float(fadeIn(s, n.minor ? 0.35 : 0.1));
      label(n.name, 0, 0, o, std::move(flat));
    }
  }

  void drawVillage() {
    float vx0 = X(0), vy0 = Z(0);
    if (!inView(vx0, vy0, 300)) return;
    float b = float(std::max(2.5, 16 * vs));
    for (const dvec2& q : village) {
      float px = X(q.x), py = Z(q.y);
      fillRect(px - b / 2, py - b / 2, b, b, hex(0x8796bb));
      strokeRect(px - b / 2, py - b / 2, b, b, 1, a(white, 0.9f));
    }
    float off = float(std::max(24.0, 150 * vs));
    LabelOpt o;
    o.size = 21; o.color = C_BLUE; o.prio = 0; o.force = true;
    label("LEGACY VILLAGE", vx0, vy0, o, {C(0, off, 1), C(0, -off, 1), C(-off * 0.8f, off * 0.7f, 2), C(off * 0.8f, off * 0.7f, 0), C(0, off * 1.7f, 1), C(-off, -off * 0.6f, 2)});
  }

  void drawChalets() {
    if (!hasChaletV) return;
    const double s = vs;
    float cx = X(chaletV.x), cy = Z(chaletV.y);
    const ChaletHouse* own = nullptr;
    if (play && mk.ownChalet >= 0) for (const ChaletHouse& h : play->chalets) if (h.id == mk.ownChalet) own = &h;
    if (own && layers[L_MINE]) {
      Icon o;
      o.kind = Ico::Chalet; o.x = X(own->x); o.y = Z(own->z); o.r = s >= 0.25 ? 10.f : 8.5f; o.prio = 0.7f; o.wx = own->x; o.wz = own->z;
      o.label = own->name.empty() ? "Your chalet" : own->name; o.tip = {"Your chalet", {own->name}};
      o.lab = "YOUR CHALET" + (own->name.empty() ? std::string() : DOT + upper(own->name));
      o.labo.size = 12; o.labo.color = 0x8a6a00; o.labo.prio = 1;
      icon(std::move(o));
    }
    if (!layers[L_PLACES] || !inView(cx, cy, float(400 * s + 60))) return;
    int n = play && !play->chalets.empty() ? int(play->chalets.size()) : chaletCount;
    float R = s >= 0.25 ? 11.f : 10.f;
    Tip tip{"Chalet village", {"Up the Chaletweg north of Legacy Village", std::to_string(n) + " chalets to buy" + DOT + "ski bus stop Chalet Village"}};
    if (s < 0.6) { Icon o; o.kind = Ico::ChaletV; o.x = cx; o.y = cy; o.r = R; o.prio = 1.4f; o.wx = chaletV.x; o.wz = chaletV.y; o.label = "Chalet village"; o.tip = tip; icon(std::move(o)); }
    else spot(cx, cy, float(std::max(14.0, 120 * s)), chaletV.x, chaletV.y, "Chalet village", tip);
    LabelOpt lo;
    lo.size = 15; lo.color = 0x8a3a12; lo.prio = 1.5f; lo.alpha = float(fadeIn(s, 0.03));
    label("CHALET VILLAGE", cx, cy, lo, s < 0.6 ? around(R + 1, 5) : around(float(std::max(14.0, 130 * s)), 6));
    if (!play || play->chalets.empty()) return;
    if (chaletRoad.size() > 1) {
      std::vector<vec2> p = path(chaletRoad);
      stroke(p, float(std::max(2.5, 9 * s)), white);
      stroke(p, float(std::max(1.5, 6.5 * s)), hex(0x8a8f98));
    }
    const auto& M = play->chaletModel;
    for (const ChaletHouse& h : play->chalets) {
      float x = X(h.x), y = Z(h.z), w = float(std::max(3.0, 2 * M.HX * s)), dd = float(std::max(4.5, 2 * M.HZ * s));
      if (!inView(x, y)) continue;
      vec2 p = P(x, y);
      ui->pushRotate(p.x, p.y, float(-h.yaw));
      ui->rect(p.x - w * d / 2, p.y - dd * d / 2, w * d, dd * d, hex(h.id == mk.ownChalet ? C_GOLD : 0xa0522d));
      ui->roundRectStroke(p.x - w * d / 2 - d / 2, p.y - dd * d / 2 - d / 2, w * d + d, dd * d + d, 0, d, white);
      ui->popTransform();
      if (h.num && s > 0.9) { float fs = std::round(float(std::min(14.0, 5 * s))); text(std::to_string(h.num), x, y, fs, UiFont::BodyBold, white, 1); }
      drawn++;
    }
  }

  void drawPark() {
    if (!hasPark || parkLine.size() < 2) return;
    const double s = vs;
    std::vector<vec2> p = path(parkLine), q;
    for (const vec2& v : p) q.push_back(P(v.x, v.y));
    ui->band(q, float(std::max(6.0, 2 * parkHalf * s)) * d, hex(C_PARK, 0.2f));
    float dd = float(std::max(2.5, std::min(5.0, 18 * s)));
    if (s >= 0.08) for (const dvec2& f : parkFeatures) {
      float x = X(f.x), y = Z(f.y);
      if (!inView(x, y)) continue;
      polyS({vec2(x, y - dd), vec2(x + dd, y), vec2(x, y + dd), vec2(x - dd, y)}, 1.2f, white);
      polyF({vec2(x, y - dd), vec2(x + dd, y), vec2(x, y + dd), vec2(x - dd, y)}, hex(C_PARK));
    }
    drawn++;
    const dvec2& m = parkLine[size_t(std::floor(double(parkLine.size()) * 0.45))];
    float x = X(m.x), y = Z(m.y), r = float(std::max(8.0, parkHalf * s));
    LabelOpt o;
    o.size = 15; o.color = 0xc75400; o.prio = 4; o.alpha = float(fadeIn(s, 0.1));
    label(upper(parkName), x, y, o, around(r, 6));
    dvec2 d0 = hasParkDrop ? parkDrop : parkLine[0];
    spot(X(d0.x), Z(d0.y), 10, d0.x, d0.y, parkName, {parkName, {"Terrain park", std::to_string(parkFeatures.size()) + " features"}});
  }

  void drawPistes() {
    const double s = vs;
    const float w = float(std::min(7.0, std::max(2.6, s * 13)));
    std::vector<std::pair<const Piste*, std::vector<vec2>>> ps;
    for (int i : pisteOrder) { const Piste& p = pistes[size_t(i)]; if (boxVisible(p.lo, p.hi)) ps.push_back({&p, path(p.pts)}); }
    for (auto& [p, pt] : ps) stroke(pt, w + 3.5f, a(white, 0.95f));
    for (auto& [p, pt] : ps) { if (p->lane) dash(pt, w, hex(PISTE_COLORS[p->diff]), w * 2.2f, w * 1.2f, true); else stroke(pt, w, hex(PISTE_COLORS[p->diff])); }
    // number badges from a little way in (the name written zoomed right in; else in the tooltip)
    float al = float(fadeIn(s, 0.07));
    if (al <= 0) return;
    for (int i : pisteOrder) {
      const Piste* p = &pistes[size_t(i)];
      if (p->pts.empty()) continue;
      const dvec2& q = p->pts[size_t(std::floor(double(p->pts.size()) * 0.38))];
      uint32_t col = PISTE_COLORS[p->diff];
      Icon o;
      o.x = X(q.x); o.y = Z(q.y); o.r = 10; o.prio = 3; o.alpha = al;
      float bx = o.x, by = o.y;
      int num = p->number;
      o.draw = [this, bx, by, col, num] { pisteBadge(bx, by, 10, col, num); };
      o.wx = q.x; o.wz = q.y; o.label = p->name; o.tipFn = [this, p] { return pisteTip(*p); };
      if (s >= 0.45) o.lab = p->name;
      o.labo.size = 14; o.labo.color = p->diff == 3 ? 0x161616 : col; o.labo.prio = 6; o.labo.alpha = float(fadeIn(s, 0.45)); o.labo.hasAlpha = true;
      icon(std::move(o));
    }
  }

  void drawRaceLines() {
    const double s = vs;
    const float w0 = float(std::min(6.0, std::max(3.2, s * 8)));
    for (const RaceM& e : races) {
      bool on = hotRace == e.id;
      float w = w0 + (on ? 1.5f : 0.f);
      std::vector<vec2> p = path(e.pts), q;
      bool vis = false;
      for (const vec2& v : p) { q.push_back(P(v.x, v.y)); vis = vis || inView(v.x, v.y, 60); }
      if (!vis) continue;
      ui->band(q, (w + float(std::max(12.0, 30 * s))) * d, hex(e.color, on ? 0.34f : 0.17f));
      stroke(p, w + 4, white);
      stroke(p, w, hex(e.color));
      dash(p, std::max(1.2f, w * 0.32f), a(white, 0.92f), w * 1.2f, w * 2.4f, true);
    }
  }

  void drawRaceMarks() {
    const double s = vs;
    for (const RaceM& e0 : races) {
      const RaceM* e = &e0;
      bool on = hotRace == e->id;
      uint32_t col = e->color;
      float fx = X(e->finish.x), fy = Z(e->finish.y), q = s < 0.07 ? 7.5f : 9.f;
      {
        Icon o;
        o.x = fx; o.y = fy; o.r = q / 2 + 3; o.prio = 2.6f; o.alpha = float(fadeIn(s, 0.04));
        o.draw = [this, fx, fy, q, col] { finishMark(fx, fy, q, col); };
        o.wx = e->finish.x; o.wz = e->finish.y; o.label = e->name + DOT + "finish";
        o.tipFn = [this, e] { Tip t = raceTip(*e); t.title = e->name + DOT + "finish"; return t; };
        o.race = e->id;
        icon(std::move(o));
      }
      float x = X(e->start.x), y = Z(e->start.y);
      if (!inView(x, y, 60)) continue;
      float r = on ? 12.5f : 11.f, cy = y - r * 1.75f, tip = y - cy, gap = 5;
      pins[e->id] = {x, cy, r, col};
      {
        Icon o;
        o.x = x; o.y = cy; o.r = r + 1; o.prio = 1;
        o.draw = [this, x, y, r, col] { racePin(x, y, r, col); };
        o.hasBox = true; o.box = {x - r - 2, cy - r - 2, x + r + 2, y + 1};
        o.wx = e->start.x; o.wz = e->start.y; o.label = e->name; o.tipFn = [this, e] { return raceTip(*e); };
        o.race = e->id;
        icon(std::move(o));
      }
      if (s < 0.09) continue;
      Label L;
      L.text = e->name; L.x = x; L.y = cy; L.o.prio = 0.5f; L.o.force = on; L.o.alpha = float(fadeIn(s, 0.09));
      L.isCard = true;
      L.card.title = upper(e->name); L.card.color = col; L.card.hot = on;
      if (e->bus) L.card.sub = {{"FREE RACE", col}, {std::string("  \xC2\xB7  ski bus: ") + e->stop, C_NAVY}};
      else L.card.sub = {{upper(e->diff), col}, {std::string("  \xC2\xB7  up to $") + fmtInt(e->rewardMax ? e->rewardMax : e->reward), C_NAVY}};
      if (s >= 0.3) {
        char b[160];
        std::snprintf(b, sizeof b, "%.1f km  \xC2\xB7  %d m drop", e->length / 1000, e->drop);
        L.card.more = b;
        if (e->bus) L.card.more += std::string("  \xC2\xB7  free entry  \xC2\xB7  1st $") + fmtInt(e->reward);
      }
      L.candFn = [r, gap, tip](float, float h) {
        std::vector<Cand> c = {C(r + gap, 0, 0), C(-r - gap, 0, 2), C(0, -r - gap - h / 2, 1), C(0, tip + gap + h / 2, 1), C(r, -r - h / 2, 0), C(-r, -r - h / 2, 2), C(r, tip + h / 2, 0), C(-r, tip + h / 2, 2)};
        for (float k : {26.f, 52.f}) { c.push_back(C(r + gap + k, 0, 0)); c.push_back(C(-r - gap - k, 0, 2)); c.push_back(C(0, -r - gap - h / 2 - k, 1)); c.push_back(C(0, tip + gap + h / 2 + k, 1)); }
        return c;
      };
      L.onPlace = [this, e](const Box& b) {
        Spot sp;
        sp.hasBox = true; sp.box = b; sp.x = (b.x0 + b.x1) / 2; sp.y = (b.y0 + b.y1) / 2; sp.wx = e->start.x; sp.wz = e->start.y; sp.label = e->name; sp.race = e->id;
        sp.tipFn = [this, e] { return raceTip(*e); };
        spots.push_back(std::move(sp));
      };
      queue.push_back(std::move(L));
    }
  }

  /// runs of a railway line: the open stretches (tunnel = false) or the tunnel ones, each with its neighbours' ends
  template <typename F> void runs(const std::vector<RailPt>& Pp, bool tunnel, F&& draw) {
    std::vector<vec2> cur;
    for (size_t i = 0; i < Pp.size(); i++) {
      bool on = Pp[i].tunnel == tunnel || (i > 0 && Pp[i - 1].tunnel == tunnel);
      vec2 q(X(Pp[i].x), Z(Pp[i].z));
      if (on) { if (cur.empty() || std::fabs(q.x - cur.back().x) + std::fabs(q.y - cur.back().y) >= 1.5f || i + 1 == Pp.size()) cur.push_back(q); }
      else if (!cur.empty()) { if (cur.size() > 1) draw(cur); cur.clear(); }
    }
    if (cur.size() > 1) draw(cur);
  }
  void strokeExpress(const std::vector<RailPt>& Pp, float w) {
    runs(Pp, true, [&](const std::vector<vec2>& p) {
      dash(p, w * 0.62f + 2.5f, a(white, 0.85f), w * 1.4f, w * 1.1f, true);
      dash(p, w * 0.62f, hex(C_EXPRESS, 0.6f), w * 1.4f, w * 1.1f, true);
    });
    runs(Pp, false, [&](const std::vector<vec2>& p) {
      stroke(p, w + 4, white);
      stroke(p, w, hex(C_EXPRESS));
      stroke(p, std::max(1.f, w * 0.22f), a(white, 0.88f));
    });
  }
  void drawExpress() {
    if (express.empty()) return;
    const double s = vs;
    const float w = float(std::min(5.5, std::max(3.4, 2.8 + s * 5)));
    strokeExpress(express, w);
    // the name: upright along an open stretch, as near the middle of the view as it fits
    std::vector<std::pair<float, std::pair<Cand, Cand>>> cands;
    const auto& Pp = express;
    size_t step = size_t(std::max(6.0, std::round(1.6 / s)));
    for (size_t i = 12; i + 12 < Pp.size(); i += step) {
      if (Pp[i].tunnel || Pp[i - 10].tunnel || Pp[i + 10].tunnel) continue;
      float x = X(Pp[i].x), y = Z(Pp[i].z);
      if (!inView(x, y, -40)) continue;
      float ang = std::atan2(Z(Pp[i + 10].z) - Z(Pp[i - 10].z), X(Pp[i + 10].x) - X(Pp[i - 10].x));
      if (ang > PIf / 2) ang -= PIf; else if (ang < -PIf / 2) ang += PIf;
      float off = w / 2 + 10, nx = -std::sin(ang) * off, ny = std::cos(ang) * off;
      cands.push_back({std::hypot(x - W / 2, y - H / 2), {CA(x + nx, y + ny, ang), CA(x - nx, y - ny, ang)}});
    }
    std::stable_sort(cands.begin(), cands.end(), [](const auto& p, const auto& q) { return p.first < q.first; });
    std::vector<Cand> flat;
    for (auto& c : cands) { flat.push_back(c.second.first); flat.push_back(c.second.second); }
    if (flat.empty()) return;
    LabelOpt o;
    o.size = 14; o.color = C_EXPRESS; o.prio = 2.5f; o.alpha = float(fadeIn(s, 0.05));
    label(upper(expressName), 0, 0, o, std::move(flat));
  }
  void drawExpressStops() {
    const double s = vs;
    for (const StationM& st0 : expressStops) {
      const StationM* st = &st0;
      float x = X(st->x), y = Z(st->z);
      const RaceM* e = nullptr;
      if (!st->course.empty()) for (const RaceM& r : races) if (r.id == st->course) e = &r;
      if (e && layers[L_RACES]) {
        bool on = (!hotRace.empty() && hotRace == e->id) || (!hotStation.empty() && hotStation == st->id);
        auto link = [&](double tx, double tz) {
          float bx = X(tx), by = Z(tz);
          if (!segVisible(vec2(x, y), vec2(bx, by), 10)) return;
          std::vector<vec2> p = {vec2(x, y), vec2(bx, by)};
          dash(p, 5.5f, white, 0.1f, 5.5f, true);
          dash(p, 3, hex(e->color), 0.1f, 5.5f, true);
        };
        link(e->finish.x, e->finish.y);
        if (on) link(e->start.x, e->start.y);
      }
      if (!inView(x, y)) continue;
      bool village = st->id == "village";
      float r = village ? 9.f : 7.f;
      std::string name = village ? "Village station" : st->name;
      Icon o;
      o.x = x; o.y = y; o.r = r + 1; o.prio = village ? 1.2f : 2.2f; o.alpha = village ? 1.f : float(fadeIn(s, 0.045));
      o.draw = [this, x, y, r, village] { expressStop(x, y, r, village); };
      o.wx = st->bx; o.wz = st->bz; o.label = expressName + DOT + name; o.station = st->id; o.race = st->course;
      o.tip = {name, {expressName + " station"}};
      if (e) o.tip.lines.push_back("Race: " + e->name);
      if (village) { o.lab = upper(expressName); o.labo.size = 15; o.labo.color = C_EXPRESS; o.labo.prio = s < 0.08 ? 3.f : 1.5f; }
      else { if (s >= 0.25) o.lab = st->name; o.labo.size = 13; o.labo.color = C_EXPRESS; o.labo.prio = 6; o.labo.alpha = float(fadeIn(s, 0.25)); o.labo.hasAlpha = true; }
      icon(std::move(o));
    }
  }

  void drawLifts() {
    const double s = vs;
    for (const Lift& l0 : lifts) {
      const Lift* l = &l0;
      float ax = X(l->bottom.x), ay = Z(l->bottom.y), bx = X(l->top.x), by = Z(l->top.y);
      if (std::max(ax, bx) < -60 || std::min(ax, bx) > W + 60 || std::max(ay, by) < -60 || std::min(ay, by) > H + 60) continue;
      bool gondola = l->gondola;
      float len = std::hypot(bx - ax, by - ay), ux = (bx - ax) / (len > 0 ? len : 1), uy = (by - ay) / (len > 0 ? len : 1);
      float al = !gondola && s < 0.06 ? 0.55f : 1.f;
      const vec4 navy_ = hex(C_NAVY, al);
      // (the part of the line in view: a long line's capsule is clipped on the canvas)
      line(ax, ay, bx, by, gondola ? 6.f : 5.f, a(white, 0.95f * al));
      line(ax, ay, bx, by, gondola ? 2.6f : 1.8f, navy_);
      if (s >= 0.1) {
        if (!gondola) {
          for (float dd = 10; dd < len - 6; dd += 13) {
            float cx = ax + ux * dd, cy = ay + uy * dd;
            if (!inView(cx, cy, 6)) continue;
            line(cx - uy * 3.5f, cy + ux * 3.5f, cx + uy * 3.5f, cy - ux * 3.5f, 1.4f, navy_);
          }
        } else {
          for (float dd = 16; dd < len - 10; dd += 26) { float cx = ax + ux * dd, cy = ay + uy * dd; if (inView(cx, cy, 6)) disc(cx, cy, 2.1f, navy_); }
        }
      }
      auto st = [&](float x, float y, float q) {
        fillRect(x - q - 0.75f, y - q - 0.75f, 2 * q + 1.5f, 2 * q + 1.5f, a(white, al));
        fillRect(x - q + 0.75f, y - q + 0.75f, 2 * q - 1.5f, 2 * q - 1.5f, navy_);
        reserve(x, y, q + 1);
      };
      st(ax, ay, gondola ? 4.5f : 3.5f); st(bx, by, gondola ? 4.5f : 3.5f);
      spot(ax, ay, 6, l->bottom.x, l->bottom.y, l->name + DOT + "valley station", {}, [this, l] { Tip t = liftTip(*l); t.title = l->name + DOT + "valley station"; return t; });
      spot(bx, by, 6, l->top.x, l->top.y, l->name + DOT + "top station", {}, [this, l] { Tip t = liftTip(*l); t.title = l->name + DOT + "top station"; return t; });
      if (l->hasMid) st(X(l->mid.x), Z(l->mid.y), 3.5f);
      drawn++;
      if (len > 80 && s >= (gondola ? 0.07 : 0.14)) {
        float ang = std::atan2(by - ay, bx - ax);
        if (ang > PIf / 2) ang -= PIf; else if (ang < -PIf / 2) ang += PIf;
        float nx = -std::sin(ang), ny = std::cos(ang), off = 11;
        std::vector<Cand> cands;
        const float tsM[3] = {0.28f, 0.72f, 0.5f}, tsN[3] = {0.5f, 0.32f, 0.68f};
        for (float t : (l->hasMid ? tsM : tsN)) for (float sd : {-1.f, 1.f}) cands.push_back(CA((bx - ax) * t + nx * off * sd, (by - ay) * t + ny * off * sd, ang));
        LabelOpt o;
        o.size = gondola ? 15.f : 14.f; o.color = C_NAVY; o.prio = gondola ? 2.f : 3.f; o.alpha = float(fadeIn(s, gondola ? 0.07 : 0.14));
        label(l->name, ax, ay, o, std::move(cands));
      }
    }
  }

  void drawRailway() {
    if (railway.empty()) return;
    const double s = vs;
    runs(railway, false, [&](const std::vector<vec2>& p) { stroke(p, 6.5f, white); stroke(p, 4, hex(0x1b1f27)); dash(p, 1.6f, white, 5, 7, true); });
    runs(railway, true, [&](const std::vector<vec2>& p) { dash(p, 2.2f, hex(0x1b1f27), 4, 4, true); });
    for (const StationM& st : railStops) {
      float x = X(st.x), y = Z(st.z);
      if (!inView(x, y)) continue;
      Icon o;
      o.kind = Ico::Train; o.x = x; o.y = y; o.r = s >= 0.25 ? 10.f : 8.5f; o.prio = 2; o.wx = st.x; o.wz = st.z; o.label = st.name; o.tip = {st.name, {railName + " station"}};
      if (s >= 0.07) o.lab = st.name;
      o.labo.size = 14; o.labo.color = 0x8f1414; o.labo.prio = 2; o.labo.alpha = float(fadeIn(s, 0.07)); o.labo.hasAlpha = true;
      icon(std::move(o));
    }
    const RailPt& m = railway[size_t(std::floor(double(railway.size()) * 0.36))];
    if (s >= 0.08) { LabelOpt o; o.size = 14; o.color = 0x1b1f27; o.prio = 3; o.alpha = float(fadeIn(s, 0.08)); label(railName, X(m.x), Z(m.z), o, around(12)); }
  }

  void drawPlaces() {
    const double s = vs;
    const float IR = s >= 0.25 ? 10.f : 8.5f;
    // summits
    for (const Peak& p0 : peaks) {
      const Peak* p = &p0;
      float x = X(p->x), y = Z(p->z);
      if (!inView(x, y)) continue;
      Icon o;
      o.x = x; o.y = y; o.r = 8; o.prio = 0; o.wx = p->x; o.wz = p->z; o.label = p->name + " summit";
      o.tipFn = [this, p] { return Tip{p->name, {"Summit" + std::string(DOT) + std::to_string(world ? int(std::lround(world->height(p->x, p->z))) : int(p->h)) + " m"}}; };
      o.draw = [this, x, y] { polyS({vec2(x, y - 7.5f), vec2(x + 8, y + 5.5f), vec2(x - 8, y + 5.5f)}, 3, white); polyF({vec2(x, y - 7.5f), vec2(x + 8, y + 5.5f), vec2(x - 8, y + 5.5f)}, hex(C_NAVY)); drawn++; };
      icon(std::move(o));
      LabelOpt lo;
      lo.size = 17; lo.color = C_NAVY; lo.prio = 1;
      label(upper(p->name), x, y, lo, {C(0, 18, 1), C(0, -18, 1), C(12, 0, 0), C(-12, 0, 2)});
    }
    // ski-bus stops (Buses & train; the village's from far out, the rest fade in)
    if (layers[L_TRANSIT]) for (const Stop& b : busStops) {
      bool village = b.name == "Legacy Village";
      Icon o;
      o.kind = Ico::Bus; o.x = X(b.x); o.y = Z(b.z); o.r = IR; o.prio = village ? 2.3f : 4.f; o.alpha = village ? 1.f : float(fadeIn(s, 0.06)); o.wx = b.x; o.wz = b.z;
      o.label = "Ski bus" + std::string(DOT) + b.name; o.tip = {b.name, {"Ski bus stop"}};
      if (s >= 0.35 && !village) o.lab = b.name;
      o.labo.size = 13; o.labo.weight = 600; o.labo.color = C_BLUE; o.labo.prio = 5;
      icon(std::move(o));
    }
    // heli-ski (Pistes & lifts): the pad, the drop zones zoomed in
    if (layers[L_PISTES]) {
      if (hasHelipad) {
        Icon o;
        o.kind = Ico::Heli; o.x = X(helipad.x); o.y = Z(helipad.y); o.r = IR; o.prio = 2.5f; o.alpha = float(fadeIn(s, 0.04)); o.wx = helipad.x; o.wz = helipad.y; o.label = "Heli-ski";
        o.tip = {"Heli-ski", {"Helicopter pad" + std::string(DOT) + "flights to the drop zones"}};
        if (s >= 0.2) o.lab = "Heli-ski";
        o.labo.size = 14; o.labo.color = C_RED; o.labo.prio = 5;
        icon(std::move(o));
      }
      for (const Marker& m : drops) {
        Icon o;
        o.kind = Ico::Drop; o.x = X(m.x); o.y = Z(m.z); o.r = IR - 1.5f; o.prio = 7; o.alpha = float(fadeIn(s, 0.1)); o.wx = m.x; o.wz = m.z; o.label = m.label;
        o.tip = {m.label.empty() ? "Drop zone" : m.label, {"Heli-ski drop zone"}};
        if (s >= 0.3) o.lab = m.label;
        o.labo.size = 13; o.labo.weight = 600; o.labo.color = C_RED; o.labo.prio = 8;
        icon(std::move(o));
      }
    }
    if (layers[L_PLACES]) {
      for (const Hut& h : huts) {
        Icon o;
        o.kind = Ico::Hut; o.x = X(h.x); o.y = Z(h.z); o.r = IR; o.prio = 3; o.alpha = float(fadeIn(s, 0.05)); o.wx = h.x; o.wz = h.z; o.label = h.name; o.tip = {h.name, {"Mountain hut"}};
        if (s >= 0.3) o.lab = h.name;
        o.labo.size = 14; o.labo.color = 0x8f2f17; o.labo.prio = 5;
        icon(std::move(o));
      }
      for (const Svc& m : services) {
        Icon o;
        o.kind = m.kind; o.x = X(m.x); o.y = Z(m.z); o.r = IR; o.prio = 2; o.alpha = float(fadeIn(s, 0.045)); o.wx = m.x; o.wz = m.z; o.label = m.label; o.tip = {m.label, {m.what}};
        if (s >= 0.18) o.lab = m.label;
        o.labo.size = 14; o.labo.color = m.kind == Ico::Med ? 0xb01810 : m.kind == Ico::Police ? 0x1f3fa8 : 0x1f5fd6; o.labo.prio = 3; o.labo.alpha = float(fadeIn(s, 0.18)); o.labo.hasAlpha = true;
        icon(std::move(o));
      }
      for (const Marker& m : mk.secrets) {
        Icon o;
        o.kind = Ico::Secret; o.x = X(m.x); o.y = Z(m.z); o.r = IR - 1; o.prio = 4; o.alpha = float(fadeIn(s, 0.07)); o.wx = m.x; o.wz = m.z; o.label = m.label; o.tip = {m.label, {"Landmark" + std::string(DOT) + "found"}};
        if (s >= 0.3) o.lab = m.label;
        o.labo.size = 14; o.labo.color = 0x8a6200; o.labo.prio = 4;
        icon(std::move(o));
      }
    }
    if (layers[L_JOBS]) {
      auto job = [&](const Marker& m) {
        float x = X(m.x), y = Z(m.z);
        if (m.kind == "search") {
          if (!inView(x, y, 200)) return;
          float r = float(std::max(8.0, (m.r > 0 ? m.r : 30) * s));
          std::vector<vec2> c;
          for (int i = 0; i <= 48; i++) { float t = float(i) / 48 * 2 * PIf; c.push_back(vec2(x + std::cos(t) * r, y + std::sin(t) * r)); }
          dash(c, 2, hex(C_GOLD), 5, 4, false);
          spot(x, y, r, m.x, m.z, m.label.empty() ? "Search area" : m.label, {m.label.empty() ? "Search area" : m.label, {"Job" + std::string(DOT) + "search here"}});
        } else if (m.kind == "board") {
          Icon o;
          o.kind = Ico::Board; o.x = x; o.y = y; o.r = IR - 1.5f; o.prio = 7; o.alpha = float(fadeIn(s, 0.12)); o.wx = m.x; o.wz = m.z; o.label = m.label.empty() ? "Job board" : m.label;
          o.tip = {o.label, {m.what.empty() ? "Job board" : m.what}};
          if (s >= 0.5) o.lab = m.label;
          o.labo.size = 13; o.labo.weight = 600; o.labo.color = 0x6a3d17; o.labo.prio = 10;
          icon(std::move(o));
        } else {
          Icon o;
          o.kind = Ico::Job; o.x = x; o.y = y; o.r = IR; o.prio = 0.6f; o.wx = m.x; o.wz = m.z; o.label = m.label.empty() ? "Job" : m.label; o.tip = {o.label, {m.what.empty() ? "Job target" : m.what}};
          o.lab = m.label;
          o.labo.size = 14; o.labo.color = 0x9a6a00; o.labo.prio = 1;
          icon(std::move(o));
        }
      };
      for (const Marker& m : boards) job(m);
      for (const Marker& m : mk.jobs) job(m);
    }
    if (layers[L_MINE]) for (const Marker& m : mk.mine) {
      Ico kind = m.kind == "impound" ? Ico::Impound : m.kind == "heli" ? Ico::MyHeli : Ico::MyCar;
      Icon o;
      o.kind = kind; o.x = X(m.x); o.y = Z(m.z); o.r = IR; o.prio = 0.7f; o.wx = m.x; o.wz = m.z; o.label = m.label;
      o.tip = {m.label, {kind == Ico::Impound ? "Impounded" + std::string(DOT) + "at the police station" : kind == Ico::MyHeli ? "Your helicopter" : "Your car"}};
      o.lab = m.label;
      o.labo.size = 13.5f; o.labo.color = kind == Ico::Impound ? 0x4a5263 : 0x8a6a00; o.labo.prio = 1;
      icon(std::move(o));
    }
  }

  void drawTarget() {
    const Mark& t = owner->mark;
    if (!t.on) return;
    float x = X(t.x), y = Z(t.z);
    if (!inView(x, y, 0)) return;
    reserve(x, y, 16);
    LabelOpt o;
    o.size = 14; o.color = C_RED; o.prio = -1; o.force = true;
    label("MARKED" + std::string(DOT) + t.label, x, y, o, {C(0, -27, 1), C(0, 27, 1), C(21, 0, 0), C(-21, 0, 2)});
  }

  // ---------------------------------------------------------------- picking
  const Spot* spotAt(float px, float py) const {
    const Spot* best = nullptr;
    float bd = 1e9f;
    for (const auto* list : {&spots, &dynSpots}) for (const Spot& s : *list) {
      float dd = s.hasBox ? (px > s.box.x0 && px < s.box.x1 && py > s.box.y0 && py < s.box.y1 ? -9.f : 1e9f) : std::hypot(s.x - px, s.y - py) - s.r;
      if (dd < 10 && dd < bd) { bd = dd; best = &s; }
    }
    return best;
  }
  /// the line under the pointer (within 7 px): a piste, lift, road, the express, the railway or a race
  bool lineAt(float px, float py, Spot& out) const {
    const double s = vs, wx = vx + (px - W / 2) / s, wz = vz + (py - H / 2) / s;
    double bd = 7 / s;
    bool found = false;
    auto poly = [&](const std::vector<dvec2>& pts, const dvec2& lo, const dvec2& hi, size_t step = 1) {
      if (wx < lo.x - bd || wx > hi.x + bd || wz < lo.y - bd || wz > hi.y + bd) return false;
      bool hitIt = false;
      for (size_t i = step; i < pts.size(); i += step) {
        double dd = segDist(wx, wz, pts[i - step].x, pts[i - step].y, pts[i].x, pts[i].y);
        if (dd < bd) { bd = dd; hitIt = true; }
      }
      return hitIt;
    };
    const dvec2 none0(-1e18), none1(1e18);
    if (layers[L_PISTES]) {
      for (const Piste& p : pistes) if (poly(p.pts, p.lo, p.hi)) { const Piste* pp = &p; out = Spot(); out.label = p.name; out.tipFn = [this, pp] { return pisteTip(*pp); }; found = true; }
      for (const Lift& l : lifts) {
        double dd = segDist(wx, wz, l.bottom.x, l.bottom.y, l.top.x, l.top.y);
        if (dd < bd) { bd = dd; const Lift* lp = &l; out = Spot(); out.label = l.name; out.tipFn = [this, lp] { return liftTip(*lp); }; found = true; }
      }
    }
    if (layers[L_RACES]) for (const RaceM& r : races) if (poly(r.pts, none0, none1)) { const RaceM* rp = &r; out = Spot(); out.label = r.name; out.race = r.id; out.tipFn = [this, rp] { return raceTip(*rp); }; found = true; }
    if (layers[L_TRANSIT]) {
      auto rail = [&](const std::vector<RailPt>& Pp) {
        bool hitIt = false;
        for (size_t i = 1; i < Pp.size(); i++) { double dd = segDist(wx, wz, Pp[i - 1].x, Pp[i - 1].z, Pp[i].x, Pp[i].z); if (dd < bd) { bd = dd; hitIt = true; } }
        return hitIt;
      };
      if (rail(express)) { out = Spot(); out.label = expressName; out.tip = {expressName, {"Train", std::to_string(expressStops.size()) + " stations"}}; found = true; }
      if (rail(railway)) {
        std::string names;
        for (const StationM& q : railStops) names += (names.empty() ? "" : DOT) + q.name;
        out = Spot(); out.label = railName; out.tip = {railName, {"Railway", names}}; found = true;
      }
    }
    if (layers[L_ROADS] && wx > roadBox.x - bd && wx < roadBox.z + bd && wz > roadBox.y - bd && wz < roadBox.w + bd) {
      const TunnelM* tun = nullptr;
      double td = 1e18;
      for (const TunnelM& T : tunnels) for (size_t i = 1; i < T.pts.size(); i++) { double dd = segDist(wx, wz, T.pts[i - 1].x, T.pts[i - 1].y, T.pts[i].x, T.pts[i].y); if (dd < td) { td = dd; tun = &T; } }
      const RoadM* road = nullptr;
      for (const RoadM& r : roads) { if (r.kind == 4) continue; if (poly(r.pts, r.lo, r.hi)) road = &r; }
      if (tun && td < bd + 1.5 / s) {
        out = Spot(); out.label = tun->name; out.tip = {tun->name + DOT + std::to_string(int(std::lround(tun->length))) + " m", {"Road tunnel", tun->road}}; found = true;
      } else if (road) {
        std::string name = stripParen(road->name.empty() ? "Road" : road->name);
        out = Spot(); out.label = name; out.tip = {name, {road->what}};
        if (road->length > 0) out.tip.lines.push_back(fmtLen(road->length));
        found = true;
      }
    }
    if (found) { out.wx = wx; out.wz = wz; }
    return found;
  }

  void fitBounds() {
    double x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
    auto add = [&](double x, double z) { if (std::isfinite(x) && std::isfinite(z)) { x0 = std::min(x0, x); x1 = std::max(x1, x); z0 = std::min(z0, z); z1 = std::max(z1, z); } };
    if (roadBox.x < roadBox.z) { add(roadBox.x, roadBox.y); add(roadBox.z, roadBox.w); }
    for (const RaceM& e : races) { add(e.start.x, e.start.y); add(e.finish.x, e.finish.y); }
    for (const RailPt& p : express) add(p.x, p.z);
    for (const Stop& b : busStops) add(b.x, b.z);
    for (const Lift& l : lifts) { add(l.bottom.x, l.bottom.y); add(l.top.x, l.top.y); }
    if (x0 > x1) { minS = MIN_S; return; }
    double fit = std::min(W / std::max(500.0, x1 - x0), H / std::max(500.0, z1 - z0)) * 0.9;
    minS = std::max(0.004, std::min(MIN_S, fit));
  }
  void zoomAt(float px, float py, double k) {
    double wx = vx + (px - W / 2) / vs, wz = vz + (py - H / 2) / vs;
    vs = std::clamp(vs * k, minS, MAX_S);
    vx = wx - (px - W / 2) / vs;
    vz = wz - (py - H / 2) / vs;
  }

  /// trailmap.js locationName (main.js)
  std::string locationName(const dvec3& p) const {
    if (std::hypot(p.x, p.z) < 260) return "Legacy Village";
    for (const Hut& h : huts) if (std::hypot(p.x - h.x, p.z - h.z) < 140) return h.label.empty() ? "Summit \xC2\xB7 Gipfel H\xC3\xBCtte" : h.label;
    for (const Lift& l : lifts) if (l.hasMid && std::hypot(p.x - l.mid.x, p.z - l.mid.y) < 70 && !l.midName.empty()) return l.midName;
    double bd = 22;
    std::string best;
    for (const Piste& ps : pistes) {
      if (p.x < ps.lo.x - bd || p.x > ps.hi.x + bd || p.z < ps.lo.y - bd || p.z > ps.hi.y + bd) continue;
      for (size_t i = 1; i < ps.pts.size(); i++) { double dd = segDist(p.x, p.z, ps.pts[i - 1].x, ps.pts[i - 1].y, ps.pts[i].x, ps.pts[i].y); if (dd < bd) { bd = dd; best = ps.lane ? ps.name : ps.name + " piste"; } }
    }
    if (!best.empty()) return best;
    if (hasPark) for (size_t i = 1; i < parkLine.size(); i++) if (segDist(p.x, p.z, parkLine[i - 1].x, parkLine[i - 1].y, parkLine[i].x, parkLine[i].y) < parkHalf) return parkName;
    for (const RaceM& r : races) for (size_t i = 1; i < r.pts.size(); i++) if (segDist(p.x, p.z, r.pts[i - 1].x, r.pts[i - 1].y, r.pts[i].x, r.pts[i].y) < 12) return r.name + " course";
    return p.y > 900 ? "High Alpine \xC2\xB7 Off-piste" : "Backcountry";
  }

  /// .tm-scale: the scale bar at the sheet's bottom left (mx, my, mh: the sheet)
  void drawScale(float mx, float my, float mh) {
    static const int steps[] = {50, 100, 200, 250, 500, 1000, 2000, 2500, 5000};
    int m = steps[0];
    for (int v : steps) if (v * vs <= 190) m = v;
    float bw = std::round(float(m * vs)) * d, bh = 7 * u, bx = mx + 30 * u, fs = 17 * u;
    float rowHs = std::max(bh + 2 * d, fs), by = my + mh - 28 * u - rowHs / 2 - bh / 2;
    ui->roundRectStroke(bx - 2 * d, by - 2 * d, bw + 4 * d, bh + 4 * d, 0, 2 * d, a(white, 0.85f));
    ui->rect(bx, by, 2 * d, bh, blue); ui->rect(bx + bw - 2 * d, by, 2 * d, bh, blue); ui->rect(bx, by + bh - 2 * d, bw, 2 * d, blue);
    char b[32];
    if (m >= 1000) std::snprintf(b, sizeof b, "%g km", m / 1000.0); else std::snprintf(b, sizeof b, "%d m", m);
    float ty = my + mh - 28 * u - rowHs / 2 - ui->lineHeight(fs, UiFont::CondItalic) / 2;
    ui->textHalo(bx + bw + 8 * u, ty, fs, UiFont::CondItalic, blue, a(white, 0.9f), 2 * d, b);
  }

  // ---------------------------------------------------------------- the route picker's map (travel.js)
  struct TvSpot { float x, y, r; int i; };
  std::vector<TvSpot> tvSpots;
  void tvFit() {
    double x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
    auto add = [&](double x, double z) { if (std::isfinite(x) && std::isfinite(z)) { x0 = std::min(x0, x); x1 = std::max(x1, x); z0 = std::min(z0, z); z1 = std::max(z1, z); } };
    for (const auto& s : tv.stops) add(s.x, s.z);
    for (const auto& dd : tv.dests) add(dd.x, dd.z);
    add(tv.from.x, tv.from.z);
    for (const auto& L : tv.lines) for (const dvec3& p : L) add(p.x, p.y);
    if (x0 > x1) { x0 = x1 = tv.from.x; z0 = z1 = tv.from.z; }
    const double pad = 0.13, w = std::max(400.0, x1 - x0), h = std::max(300.0, z1 - z0);
    vs = std::clamp(std::min(W * (1 - 2 * pad) / w, H * (1 - 2 * pad) / h), 0.02, 1.2);
    vx = (x0 + x1) / 2; vz = (z0 + z1) / 2;
  }
  const RaceM* tvRaceOf(const std::string& race, const std::string& name) const {
    for (const RaceM& e : races) if ((!race.empty() && e.id == race) || e.name == name) return &e;
    return nullptr;
  }
  void tvDrawRoute() {
    const int style = tv.lineStyle;
    const TravelDest* dsel = tvFi >= 0 && tvFi < int(tv.dests.size()) ? &tv.dests[size_t(tvFi)] : nullptr;
    for (const auto& L : tv.lines) {
      if (style == 3) {
        std::vector<RailPt> rp;
        for (const dvec3& q : L) rp.push_back({q.x, q.y, q.z > 0.5});
        strokeExpress(rp, 5.5f);
        continue;
      }
      std::vector<dvec2> w2;
      for (const dvec3& q : L) w2.push_back(dvec2(q.x, q.y));
      std::vector<vec2> p = path(w2);
      stroke(p, style == 2 ? 7.f : 9.f, a(white, 0.96f));
      if (style == 1) { stroke(p, 5, hex(0x1b1f27)); dash(p, 1.8f, white, 5, 7, true); }
      else stroke(p, style == 2 ? 3.f : 4.5f, hex(style == 2 ? C_NAVY : C_BLUE));
    }
    if (dsel && dsel->path.size() > 1) {
      std::vector<vec2> p = path(dsel->path);
      if (dsel->transfer) { dash(p, 7, white, 2, 12, true); dash(p, 3.5f, hex(C_RED), 2, 12, true); }
      else {
        // the trip: red, with a slow march along it toward the stop
        stroke(p, 12, white);
        stroke(p, 6.5f, hex(C_RED));
        float off = float(std::fmod(now * 1000 / 45, 16.0));
        std::vector<vec2> q;
        // (lineDashOffset: the pattern shifted along the path by trimming its start)
        float skip = 16 - off, acc = 0;
        bool started = false;
        for (size_t i = 1; i < p.size(); i++) {
          float l = glm::length(p[i] - p[i - 1]);
          if (!started) {
            if (acc + l >= skip) { float t = (skip - acc) / std::max(l, 1e-4f); q.push_back(p[i - 1] + (p[i] - p[i - 1]) * t); q.push_back(p[i]); started = true; }
            acc += l;
          } else q.push_back(p[i]);
        }
        if (q.size() > 1) dash(q, 3, a(white, 0.95f), 3, 13, true);
      }
    }
    if (style == 3) tvDrawExpressRaces();
    const uint32_t ink = style == 1 ? 0x1b1f27 : style == 2 ? C_NAVY : style == 3 ? C_EXPRESS : C_BLUE;
    for (const auto& s : tv.stops) {
      float x = X(s.x), y = Z(s.z);
      if (!inView(x, y)) continue;
      int di = -1;
      for (size_t k = 0; k < tv.dests.size(); k++) if (tv.dests[k].name == s.name) { di = int(k); break; }
      bool here = s.name == tv.from.name, sel = di == tvFi && di >= 0;
      if (sel) { float ph = float(std::fmod(now / 1.3, 1.0)); ringS(x, y, 11 + ph * 20 - 1.25f, 2.5f, hex(C_RED, 0.55f * (1 - ph))); }
      float r = sel ? 10.f : here ? 8.5f : 7.5f;
      if (style == 3 && !sel && !here) expressStop(x, y, r, false);
      else {
        float lw = sel || here ? 3.f : 3.2f;
        disc(x, y, r + lw / 2, sel || here ? white : hex(ink));
        disc(x, y, r - lw / 2, sel ? hex(C_RED) : here ? hex(C_NAVY) : white);
      }
      if (here) disc(x, y, 3, white);
      reserve(x, y, r + 2);
      if (di >= 0) tvSpots.push_back({x, y, std::max(16.f, r + 6), di});
      LabelOpt o;
      if (sel) { o.size = 22; o.color = C_RED; o.prio = -2; o.force = true; label(upper(s.name), x, y, o, around(r + 2, 6)); }
      else if (here) { o.size = 16; o.color = C_NAVY; o.prio = -1; o.force = true; label("YOU ARE HERE", x, y, o, around(r + 2, 6)); }
      else { o.size = 16; o.color = di >= 0 && tv.dests[size_t(di)].color ? (tv.dests[size_t(di)].color == 0x141414 ? 0x161616 : tv.dests[size_t(di)].color) : ink; o.prio = 0; label(s.name, x, y, o, around(r + 2, 6)); }
    }
  }
  void tvDrawExpressRaces() {
    const TravelDest* dsel = tvFi >= 0 && tvFi < int(tv.dests.size()) ? &tv.dests[size_t(tvFi)] : nullptr;
    const RaceM* focus = dsel ? tvRaceOf(dsel->race, dsel->name) : nullptr;
    for (const auto& s : tv.stops) {
      const RaceM* e = nullptr;
      for (const auto& q : tv.dests) if (q.name == s.name) e = tvRaceOf(q.race, q.name);
      if (!e) e = tvRaceOf(s.course, s.name);
      if (!e) continue;
      float x = X(s.x), y = Z(s.z);
      auto link = [&](const dvec2& t) {
        std::vector<vec2> p = {vec2(x, y), vec2(X(t.x), Z(t.y))};
        dash(p, 5.5f, white, 0.1f, 5.5f, true);
        dash(p, 3, hex(e->color), 0.1f, 5.5f, true);
      };
      link(e->finish);
      if (e == focus) link(e->start);
    }
    for (const RaceM& e : races) {
      float fx = X(e.finish.x), fy = Z(e.finish.y), x = X(e.start.x), y = Z(e.start.y);
      if (inView(fx, fy)) { finishMark(fx, fy, 7, e.color); reserve(fx, fy, 6); }
      if (!inView(x, y)) continue;
      float r = &e == focus ? 11.f : 8.5f, cy = racePin(x, y, r, e.color);
      boxes.push_back({x - r - 2, cy - r - 2, x + r + 2, y + 1});
      if (&e == focus) { LabelOpt o; o.size = 14; o.color = e.color; o.prio = -1; label(upper(e.diff) + DOT + "START", x, cy, o, around(r + 1, 5)); }
    }
  }
  /// travel.js draw(): the quiet map under the line
  void tvDrawMap(const dvec3& you, double heading) {
    drawRelief();
    boxes.clear(); queue.clear(); spots.clear(); icons.clear(); pins.clear(); tvSpots.clear();
    fillRect(0, 0, W, H, a(white, 0.22f));   // a soft wash calms the relief so the line reads first
    drawVillage();
    ui->pushAlpha(0.55f);
    for (const Piste& p : pistes) if (boxVisible(p.lo, p.hi)) stroke(path(p.pts), 2.6f, hex(PISTE_COLORS[p.diff]));
    ui->popAlpha();
    ui->pushAlpha(0.6f);
    for (const Lift& l : lifts) { float ax = X(l.bottom.x), ay = Z(l.bottom.y), bx = X(l.top.x), by = Z(l.top.y); if (segVisible(vec2(ax, ay), vec2(bx, by), 4)) line(ax, ay, bx, by, 1.4f, hex(C_NAVY)); }
    ui->popAlpha();
    if (tv.lineStyle == 3) { std::string keep = hotRace; hotRace.clear(); drawRaceLines(); hotRace = keep; }
    for (const Peak& p : peaks) {
      float x = X(p.x), y = Z(p.z);
      if (!inView(x, y)) continue;
      polyS({vec2(x, y - 6), vec2(x + 6, y + 4), vec2(x - 6, y + 4)}, 3, white);
      polyF({vec2(x, y - 6), vec2(x + 6, y + 4), vec2(x - 6, y + 4)}, hex(C_NAVY));
      reserve(x, y, 7);
      LabelOpt o;
      o.size = 15; o.color = C_NAVY; o.alpha = 0.8f; o.prio = 6;
      label(upper(p.name), x, y, o, {C(0, 16, 1), C(0, -16, 1), C(11, 0, 0), C(-11, 0, 2)});
    }
    tvDrawRoute();
    // you (trailmap.js drawPlayer)
    float x = X(you.x), y = Z(you.z), mg = 20, ex = std::clamp(x, mg, W - mg), ey = std::clamp(y, mg, H - mg);
    if (ex != x || ey != y) {
      float ang = std::atan2(y - ey, x - ex), c = std::cos(ang), s = std::sin(ang);
      auto R = [&](float px, float py) { return vec2(ex + px * c - py * s, ey + px * s + py * c); };
      vec2 p0 = R(13, 0), p1 = R(-9, -9), p2 = R(-4, 0), p3 = R(-9, 9);
      polyS({p0, p1, p2, p3}, 2.5f, white);
      ui->tri(P(p0.x, p0.y), P(p1.x, p1.y), P(p2.x, p2.y), hex(C_RED));
      ui->tri(P(p0.x, p0.y), P(p2.x, p2.y), P(p3.x, p3.y), hex(C_RED));
    } else {
      float ph = float(std::fmod(now / 1.4, 1.0));
      ringS(x, y, 17 + ph * 20 - 1.25f, 2.5f, hex(C_RED, 0.55f * (1 - ph)));
      arrow(x, y, std::atan2(float(std::cos(heading)), float(std::sin(heading))));
      reserve(x, y, 17);
    }
  }

  // ---------------------------------------------------------------- the legend's symbols
  enum class Sym { Sw, Gondola, Chair, Park, Pin, Finish, Tape, Road, Scenic, Ring, Express, XTunnel, Icon, You, Peak, MarkS, Cluster, XStop, PNum };
  struct LegRow { Sym sym; uint32_t col; Ico ico; const char* label; };
  /// draws a legend symbol in its box (x, y = top-left in drawable px; cw x ch drawable px)
  void legendSym(const LegRow& r, float x, float y, float cw, float ch) {
    const float cx = x + cw / 2, cy = y + ch / 2;
    // (the canvas icons are drawn with the map's own code in a 24 x 20 CSS px box: a temporary canvas origin)
    float sox = ox, soy = oy;
    ox = cx - 12 * d; oy = cy - 10 * d;
    switch (r.sym) {
      case Sym::Sw:
        ui->roundRect(x - 3 * d, cy - 3.5f * u - 3 * d, cw + 6 * d, 7 * u + 6 * d, 99 * u, hex(C_BLUE, 0.12f));
        ui->roundRect(x - 2 * d, cy - 3.5f * u - 2 * d, cw + 4 * d, 7 * u + 4 * d, 99 * u, white);
        ui->roundRect(x, cy - 3.5f * u, cw, 7 * u, 99 * u, hex(r.col));
        break;
      case Sym::Gondola:
        ui->rect(x, cy - d, cw, 2 * d, hex(C_NAVY));
        ui->circle(x + cw * 0.25f + 2.5f * u, cy, 2.5f * u, hex(C_NAVY)); ui->circle(x + cw * 0.25f + 11.5f * u, cy, 2.5f * u, hex(C_NAVY));
        break;
      case Sym::Chair:
        ui->rect(x, cy - d, cw, 2 * d, hex(C_NAVY));
        for (float tx = x + cw * 0.2f; tx < x + cw * 0.8f; tx += 7 * u) ui->rect(tx, cy - 4 * u, 1.5f * d, 8 * u, hex(C_NAVY));
        break;
      case Sym::Park: ui->polyAA({vec2(cx, cy - 7 * u), vec2(cx + 7 * u, cy), vec2(cx, cy + 7 * u), vec2(cx - 7 * u, cy)}, hex(C_PARK)); break;
      case Sym::Pin: { float rr = 7.5f * u / d; racePin(12, 10 + rr * 1.75f * 0.5f + rr * 0.35f, rr * 0.82f, r.col); break; }
      case Sym::Finish: finishMark(12, 10, 12 * u / d * 0.8f, C_NAVY); break;
      case Sym::Tape:
        ui->roundRect(x - 6 * u, cy - 9 * u, cw + 12 * u, 18 * u, 99 * u, hex(r.col, 0.18f));
        ui->roundRect(x - 2 * d, cy - 3 * u - 2 * d, cw + 4 * d, 6 * u + 4 * d, 99 * u, white);
        ui->roundRect(x, cy - 3 * u, cw, 6 * u, 99 * u, hex(r.col));
        for (float tx = x + u; tx + 3 * u <= x + cw; tx += 8 * u) ui->rect(tx, cy - d, 3 * u, 2 * d, a(white, 0.92f));
        break;
      case Sym::Road: case Sym::Scenic:
        ui->roundRect(x - 2.5f * d, cy - 2.5f * u - 2.5f * d, cw + 5 * d, 5 * u + 5 * d, 99 * u, hex(C_BLUE, 0.12f));
        ui->roundRect(x - 1.5f * d, cy - 2.5f * u - 1.5f * d, cw + 3 * d, 5 * u + 3 * d, 99 * u, white);
        ui->roundRect(x, cy - 2.5f * u, cw, 5 * u, 99 * u, hex(r.sym == Sym::Road ? 0x6f7788 : 0xc9811a));
        break;
      case Sym::Ring: ui->circle(cx, cy, 7 * u, hex(0xc9811a)); ui->circle(cx, cy, 3.5f * u, white); break;
      case Sym::Express:
        ui->rect(x - 2 * d, cy - 3 * u - 2 * d, cw + 4 * d, 6 * u + 4 * d, white);
        ui->rect(x, cy - 3 * u, cw, 6 * u, hex(C_EXPRESS));
        ui->rect(x, cy - 0.75f * d, cw, 1.5f * d, white);
        break;
      case Sym::XTunnel:
        for (float tx = x; tx < x + cw; tx += 10 * u) ui->rect(tx, cy - 2 * u, std::min(6 * u, x + cw - tx), 4 * u, hex(C_EXPRESS, 0.6f));
        break;
      case Sym::Icon: mapIcon(r.ico, 12, 10, 8); break;
      case Sym::You: arrow(12, 10, -PIf / 2 + PIf / 2, 0.62f); break;
      case Sym::Peak: polyS({vec2(12, 3), vec2(19.5f, 16), vec2(4.5f, 16)}, 3, white); polyF({vec2(12, 3), vec2(19.5f, 16), vec2(4.5f, 16)}, hex(C_NAVY)); break;
      case Sym::MarkS: ringS(12, 10, 6.5f - 1.25f, 2.5f, hex(C_RED)); break;
      case Sym::Cluster: clusterBadge(12, 10, 3, 8); break;
      case Sym::XStop: expressStop(12, 10, 6.5f, false); break;
      case Sym::PNum: pisteBadge(12, 10, 7, PISTE_COLORS[1], 4); break;
    }
    ox = sox; oy = soy;
  }
};

// ============================================================================ TrailMap
TrailMap::TrailMap() : m_(std::make_unique<Impl>()) { m_->owner = this; }
TrailMap::~TrailMap() {
  if (m_->dev) for (auto& [k, t] : m_->tiles) if (t.tex) m_->dev->destroy(t.tex);
}

bool TrailMap::layer(int i) const { return i >= 0 && i < 7 && m_->layers[i]; }
void TrailMap::setLayer(int i, bool on) { if (i >= 0 && i < 7) m_->layers[i] = on; }
void TrailMap::setView(double x, double z, double s) { m_->vx = x; m_->vz = z; m_->vs = std::clamp(s, 0.004, MAX_S); }
void TrailMap::showLegend(bool on) { m_->legendOpen = on; }
bool TrailMap::reliefReady() const { return m_->missing == 0 && m_->pending.empty(); }
void TrailMap::buildRelief(JobSystem& jobs, const World& world, gfx::Device& dev) { m_->jobs = &jobs; m_->world = &world; m_->dev = &dev; }

void TrailMap::load(platform::Platform& p, const AssetPaths& paths, const World& world, const Transport& t, Lifts& lifts) {
  Impl& M = *m_;
  M.world = &world;
  M.transport = &t;
  auto bounds = [](const std::vector<dvec2>& pts, dvec2& lo, dvec2& hi) { lo = dvec2(1e18); hi = dvec2(-1e18); for (const dvec2& q : pts) { lo = glm::min(lo, q); hi = glm::max(hi, q); } };
  std::vector<uint8_t> b;
  if (paths.readData(p, "world.json", b)) {
    auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
    if (!j.is_discarded() && j.contains("layout")) {
      int idx = 0;
      for (auto& q : j["layout"]["pistes"]) {
        Impl::Piste pl;
        idx++;
        pl.name = q.value("name", std::string());
        pl.diff = std::clamp(q.value("diff", 1), 0, 3);
        pl.number = q.contains("number") && q["number"].is_number() ? q["number"].get<int>() : idx;
        pl.lane = q.value("lane", false);
        for (auto& pt : q["pts"]) pl.pts.push_back(dvec2(pt[0].get<double>(), pt[1].get<double>()));
        bounds(pl.pts, pl.lo, pl.hi);
        if (pl.pts.size() > 1) M.pistes.push_back(std::move(pl));
      }
      for (auto& h : j["layout"]["huts"]) M.huts.push_back({h.value("name", std::string("Hut")), "", h.value("x", 0.0), h.value("z", 0.0)});
    }
  }
  for (size_t i = 0; i < M.pistes.size(); i++) M.pisteOrder.push_back(int(i));
  std::stable_sort(M.pisteOrder.begin(), M.pisteOrder.end(), [&](int x, int y) { return M.pistes[size_t(x)].diff < M.pistes[size_t(y)].diff; });
  for (const LiftLine& l : lifts.lines()) {
    Impl::Lift L;
    L.name = l.name; L.gondola = l.gondola; L.bottom = dvec2(l.bottom.x, l.bottom.z); L.top = dvec2(l.top.x, l.top.z);
    L.hasMid = l.hasMid; L.mid = dvec2(l.mid.x, l.mid.z); L.midName = l.mid.name;
    M.lifts.push_back(std::move(L));
  }
  // the roads as the map draws them (map.json, tools/export_map.mjs); without it: the network's centre lines, unnamed
  bool haveMap = false;
  b.clear();
  if (paths.readData(p, "map.json", b)) {
    auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
    if (!j.is_discarded()) {
      haveMap = true;
      auto flat2 = [](const nlohmann::json& a, std::vector<dvec2>& out) { for (size_t i = 0; i + 1 < a.size(); i += 2) out.push_back(dvec2(a[i].get<double>(), a[i + 1].get<double>())); };
      for (auto& r : j.value("roads", nlohmann::json::array())) {
        Impl::RoadM R;
        R.name = r.value("name", std::string()); R.what = r.value("what", std::string("Valley road")); R.kind = r.value("kind", 0); R.length = r.value("length", 0.0);
        flat2(r["pts"], R.pts);
        bounds(R.pts, R.lo, R.hi);
        if (R.pts.size() > 1) M.roads.push_back(std::move(R));
      }
      for (auto& n : j.value("roadLabels", nlohmann::json::array())) {
        Impl::RoadLabel L;
        L.name = n.value("name", std::string()); L.length = n.value("length", 0.0); L.scenic = n.value("scenic", false); L.minor = n.value("minor", false);
        for (auto& q : n["pts"]) L.pts.push_back(dvec3(q[0].get<double>(), q[1].get<double>(), q[2].get<double>()));
        M.roadLabels.push_back(std::move(L));
      }
      for (auto& tn : j.value("tunnels", nlohmann::json::array())) {
        Impl::TunnelM T;
        T.name = tn.value("name", std::string("Tunnel")); T.road = tn.value("road", std::string("Road")); T.length = tn.value("length", 0.0);
        flat2(tn["pts"], T.pts);
        for (int e = 0; e < 2; e++) T.ends[e] = glm::dvec4(tn["ends"][size_t(e)][0].get<double>(), tn["ends"][size_t(e)][1].get<double>(), tn["ends"][size_t(e)][2].get<double>(), tn["ends"][size_t(e)][3].get<double>());
        M.tunnels.push_back(std::move(T));
      }
      for (auto& q : j.value("rings", nlohmann::json::array())) M.rings.push_back({q.value("x", 0.0), q.value("z", 0.0), q.value("R", 15.0), q.value("name", std::string())});
      for (auto& q : j.value("lots", nlohmann::json::array()))
        M.lots.push_back({q.value("x", 0.0), q.value("z", 0.0), q.value("hw", 10.0), q.value("hd", 8.0), q.value("ux", 1.0), q.value("uz", 0.0), q.value("vx", 0.0), q.value("vz", 1.0),
                          q.value("name", std::string()), q.value("size", std::string()), q.value("depot", false)});
      if (j.contains("roadBox")) M.roadBox = glm::dvec4(j["roadBox"][0].get<double>(), j["roadBox"][1].get<double>(), j["roadBox"][2].get<double>(), j["roadBox"][3].get<double>());
      for (auto& q : j.value("peaks", nlohmann::json::array())) M.peaks.push_back({q.value("id", std::string()), q.value("name", std::string()), q.value("x", 0.0), q.value("z", 0.0), q.value("h", 0.0)});
      for (auto& q : j.value("village", nlohmann::json::array())) M.village.push_back(dvec2(q[0].get<double>(), q[1].get<double>()));
      if (j.contains("huts")) { M.huts.clear(); for (auto& h : j["huts"]) M.huts.push_back({h.value("name", std::string("Hut")), h.value("label", std::string()), h.value("x", 0.0), h.value("z", 0.0)}); }
      if (j.contains("park")) {
        const auto& pk = j["park"];
        M.hasPark = true; M.parkName = pk.value("name", std::string("Legacy Park")); M.parkHalf = pk.value("halfWidth", 17.0);
        flat2(pk["line"], M.parkLine); flat2(pk["features"], M.parkFeatures);
        if (pk.contains("drop") && pk["drop"].is_object()) { M.hasParkDrop = true; M.parkDrop = dvec2(pk["drop"].value("x", 0.0), pk["drop"].value("z", 0.0)); }
      }
      for (auto& q : j.value("drops", nlohmann::json::array())) { Marker m; m.x = q.value("x", 0.0); m.z = q.value("z", 0.0); m.kind = "drop"; m.label = q.value("label", std::string()); M.drops.push_back(std::move(m)); }
      if (j.contains("chaletVillage")) {
        M.hasChaletV = true; M.chaletV = dvec2(j["chaletVillage"].value("x", 0.0), j["chaletVillage"].value("z", 0.0)); M.chaletCount = j["chaletVillage"].value("n", 18);
        if (j["chaletVillage"].contains("road")) flat2(j["chaletVillage"]["road"], M.chaletRoad);
      }
      if (j.contains("hospital")) M.services.push_back({j["hospital"].value("x", 0.0), j["hospital"].value("z", 0.0), "Medical centre", "Hospital", Ico::Med});
      if (!t.hasAutohaus && j.contains("rental")) M.services.push_back({j["rental"].value("x", 0.0), j["rental"].value("z", 0.0), "Autohaus", "Cars to rent and buy", Ico::Car});
    }
  }
  if (!haveMap) {
    SL_WARN("trail map: map.json missing (node native/tools/export_map.mjs): roads without names, no summits");
    for (const Road& r : t.roads) {
      Impl::RoadM R;
      R.kind = r.ring ? 4 : r.scenic && !r.chalet ? 1 : r.access || r.chalet ? 2 : 0; R.length = r.length;
      R.what = r.scenic && !r.chalet ? "Scenic road" : r.access ? "Car park access" : r.chalet ? "Chalet road" : "Valley road";
      for (int i = 0; i < r.n; i += 2) R.pts.push_back(dvec2(r.X[size_t(i)], r.Z[size_t(i)]));
      if (r.n > 0) R.pts.push_back(dvec2(r.X[size_t(r.n - 1)], r.Z[size_t(r.n - 1)]));
      bounds(R.pts, R.lo, R.hi);
      if (R.pts.size() > 1) { M.roadBox = glm::dvec4(std::min(M.roadBox.x, R.lo.x), std::min(M.roadBox.y, R.lo.y), std::max(M.roadBox.z, R.hi.x), std::max(M.roadBox.w, R.hi.y)); M.roads.push_back(std::move(R)); }
    }
    for (const Lot& L : t.lots) if (!L.building || L.depot) M.lots.push_back({L.x, L.z, L.hw, L.hd, L.ux, L.uz, L.vx, L.vz, L.name, "", L.depot});
    for (const Lot& L : t.lots) if (L.hospital) M.services.push_back({L.ex != 0 ? L.ex : L.x, L.ez != 0 ? L.ez : L.z, "Medical centre", "Hospital", Ico::Med});
    M.village = {{-40, -18}, {15, -50}, {62, 34}, {-74, 44}, {100, -34}, {-108, -60}, {22, 92}, {-36, 108}, {118, 70}, {-128, 22}};
  }
  // the railways: a point every ~16 m with its tunnel flag
  auto railPts = [&](const Line& L, const std::vector<Span>& tunnels, std::vector<Impl::RailPt>& out) {
    if (L.n < 2) return;
    int step = std::max(1, int(16 / std::max(0.5, L.step)));
    for (int i = 0; i < L.n; i += step) {
      double s = i * L.step;
      bool in = false;
      for (const Span& sp : tunnels) in = in || (s >= sp.s0 && s <= sp.s1);
      out.push_back({L.X[size_t(i)], L.Z[size_t(i)], in});
    }
    if (L.ring && !out.empty()) out.push_back(out.front());
  };
  if (t.express.ok) {
    railPts(t.express.line, t.express.tunnels, M.express);
    if (!t.express.name.empty()) M.expressName = t.express.name;
    for (const auto& st : t.express.stations) M.expressStops.push_back({st.id, st.name, st.course, st.pos.x, st.pos.z, st.hasBoard ? st.board.x : st.pos.x, st.hasBoard ? st.board.y : st.pos.z});
  }
  if (t.rail.ok) {
    railPts(t.rail.line, t.rail.tunnels, M.railway);
    if (!t.rail.name.empty()) M.railName = t.rail.name;
    for (const auto& st : t.rail.stations) M.railStops.push_back({st.id, st.name, "", st.pos.x, st.pos.z, st.pos.x, st.pos.z});
  }
  for (const StopInfo& st : t.stops) M.busStops.push_back({st.name, st.x, st.z});
  // the village services (trailmap.js drawPlaces): the Autohaus and the Werkstatt, the ski shop, the medical centre
  if (t.hasAutohaus) M.services.insert(M.services.begin(), {t.autohaus.x, t.autohaus.z, "Autohaus", "Cars to rent and buy", Ico::Car});
  for (const Lot& L : t.lots) if (L.name == "Werkstatt") M.services.push_back({L.ex != 0 ? L.ex : L.x, L.ez != 0 ? L.ez : L.z, "Werkstatt \xC2\xB7 Garage", "Car repairs", Ico::Garage});
  M.services.push_back({-40, -18 + 9.5, "Ski shop", "Skis, boards and gear", Ico::Shop});
  SL_INFO("trail map: %zu pistes, %zu lifts, %zu roads (%zu named), %zu tunnels, %zu car parks, %zu summits, %zu bus stops", M.pistes.size(), M.lifts.size(), M.roads.size(),
          M.roadLabels.size(), M.tunnels.size(), M.lots.size(), M.peaks.size(), M.busStops.size());
}

void TrailMap::setPlay(const PlayData* play) {
  Impl& M = *m_;
  M.play = play;
  M.races.clear(); M.boards.clear();
  if (!play) return;
  auto add = [&](const Course& c, bool bus) {
    Impl::RaceM r;
    r.id = c.id; r.name = c.name; r.diff = c.diff; r.stop = c.stop; r.bus = bus; r.color = c.color == 0x141414 ? 0x161616 : c.color;
    r.reward = c.reward; r.rewardMax = c.rewardMax; r.drop = c.drop; r.length = c.length;
    r.start = dvec2(c.start.x, c.start.z); r.finish = dvec2(c.finish.x, c.finish.z);
    for (int i = 0; i < c.line.n; i += 4) r.pts.push_back(dvec2(c.line.X[size_t(i)], c.line.Z[size_t(i)]));
    if (c.line.n > 0 && (c.line.n - 1) % 4) r.pts.push_back(dvec2(c.line.X[size_t(c.line.n - 1)], c.line.Z[size_t(c.line.n - 1)]));
    M.races.push_back(std::move(r));
    if (bus && c.hasBoard) { Marker m; m.x = c.boardX; m.z = c.boardZ; m.kind = "board"; m.label = "Race board \xC2\xB7 " + c.name; m.what = "Free race \xC2\xB7 at the board"; M.boards.push_back(std::move(m)); }
  };
  for (const Course& c : play->courses) add(c, false);
  for (const Course& c : play->busRaces) add(c, true);
  std::vector<Marker> hubs;
  for (const JobHub& h : play->hubs) { Marker m; m.x = h.x; m.z = h.z; m.kind = "board"; m.label = "Jobs"; hubs.push_back(std::move(m)); }
  M.boards.insert(M.boards.begin(), hubs.begin(), hubs.end());
  if (play->hasStand) { Marker m; m.x = play->standX; m.z = play->standZ; m.kind = "board"; m.label = "Racing stand"; m.what = "Race just for fun"; M.boards.push_back(std::move(m)); }
  M.helipad = play->helipad; M.hasHelipad = true;
  if (play->prison.ok) {
    bool have = false;
    for (const auto& s : M.services) have = have || s.kind == Ico::Police;
    if (!have) M.services.push_back({play->prison.ex != 0 ? play->prison.ex : play->prison.x, play->prison.ez != 0 ? play->prison.ez : play->prison.z, "Police / Prison", "Police station", Ico::Police});
  }
}

void TrailMap::open(const dvec3& at) {
  Impl& M = *m_;
  open_ = true;
  // back to you, unless you were just looking at somewhere close by; opened on you, close in
  if (!M.opened || std::hypot(M.vx - at.x, M.vz - at.z) > 400) { M.vx = at.x; M.vz = at.z; M.vs = 0.75; }
  M.opened = true;
  M.openT = M.now;
  M.dragging = false;
  M.hotRace.clear(); M.hotStation.clear();
  M.where = M.locationName(at);
  hover.clear();
}
void TrailMap::close() { open_ = false; m_->dragging = false; }

bool TrailMap::frame(Ui& ui, const UiNav& nav, const Input& in, double dt, const dvec3& you, double heading, const dvec3* car) {
  if (!open_) return false;
  Impl& M = *m_;
  M.ui = &ui;
  M.now += dt;
  const float d = ui.dpr(), u = ui.cssU();
  M.d = d; M.u = u;
  const float SW = float(ui.width()), SH = float(ui.height());
  // ---- layout (style.css #map.trailmap)
  const float padT = 30 * u, padX = 56 * u, padB = 24 * u, gap = 14 * u, headH = 90 * u, hintH = ui.kcHeight(u);
  const float mx = padX, my = padT + headH + gap, mw = SW - 2 * padX, mh = std::max(40 * u, SH - my - gap - hintH - padB);
  const float cxp = mx + 14 * u, cyp = my + 14 * u, cw = mw - 28 * u, chh = mh - 28 * u;
  M.ox = cxp; M.oy = cyp; M.W = std::max(10.f, cw / d); M.H = std::max(10.f, chh / d);
  M.fitBounds();
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u), tMd = std::max(13 * d, 15 * u);
  // the layer switches and the Legend button (.tm-over: inset 24u 24u 60u; .tm-bar)
  struct Chip { float x, y, w, h; };
  Chip chips[7], legBtn;
  const float ovX = mx + 24 * u, ovY = my + 24 * u, ovW = mw - 48 * u, ovB = my + mh - 60 * u;
  const float chipH = 10 * d + std::max(10 * d, tXs);
  {
    float lbw = 24 * d + ui.textWidth("Legend", tXs, UiFont::BodyBold);
    legBtn = {ovX + ovW - lbw, ovY, lbw, chipH};
    float rowW = ovW - lbw - 8 * d, x = ovX, y = ovY;
    for (int i = 0; i < 7; i++) {
      float w = 8 * d + 10 * d + 6 * d + ui.textWidth(LAYERS[i].name, tXs, UiFont::BodyBold) + 10 * d;
      if (x + w > ovX + rowW && x > ovX) { x = ovX; y += chipH + 5 * d; }
      chips[i] = {x, y, w, chipH};
      x += w + 5 * d;
    }
  }
  const float barBottom = std::max(chips[6].y, legBtn.y) + chipH;
  // the legend panel (.tm-legend.menu-panel): its rows
  using Sym = Impl::Sym;
  using LegRow = Impl::LegRow;
  struct LegSec { int layer; const char* head; std::vector<LegRow> rows; };
  static const std::vector<LegSec> LEGEND = {
    {-1, "MAP", {{Sym::You, 0, Ico::Dot, "You"}, {Sym::Peak, 0, Ico::Dot, "Summit"}, {Sym::MarkS, 0, Ico::Dot, "Marked spot"}, {Sym::Cluster, 0, Ico::Dot, "More here"}}},
    {L_PISTES, "PISTES & LIFTS", {{Sym::Sw, PISTE_COLORS[0], Ico::Dot, GRADES[0]}, {Sym::Sw, PISTE_COLORS[1], Ico::Dot, GRADES[1]}, {Sym::Sw, PISTE_COLORS[2], Ico::Dot, GRADES[2]}, {Sym::Sw, PISTE_COLORS[3], Ico::Dot, GRADES[3]},
                                  {Sym::Gondola, 0, Ico::Dot, "Gondola"}, {Sym::Chair, 0, Ico::Dot, "Chairlift"}, {Sym::Park, 0, Ico::Dot, "Terrain park"}, {Sym::Icon, 0, Ico::Heli, "Heli-ski"},
                                  {Sym::Icon, 0, Ico::Drop, "Drop zone"}, {Sym::PNum, 0, Ico::Dot, "Piste number"}}},
    {L_RACES, "RACES", {{Sym::Pin, 0x2fbf5b, Ico::Dot, "Easy"}, {Sym::Pin, 0x2f7bff, Ico::Dot, "Medium"}, {Sym::Pin, 0xe23b3b, Ico::Dot, "Hard"}, {Sym::Pin, 0x161616, Ico::Dot, "Expert"},
                        {Sym::Finish, 0, Ico::Dot, "Finish"}, {Sym::Tape, 0x2f7bff, Ico::Dot, "Race line"}}},
    {L_ROADS, "ROADS & CAR PARKS", {{Sym::Road, 0, Ico::Dot, "Road"}, {Sym::Scenic, 0, Ico::Dot, "Scenic road"}, {Sym::Icon, 0, Ico::Lot, "Car park"}, {Sym::Ring, 0, Ico::Dot, "Roundabout"}, {Sym::Icon, 0, Ico::Depot, "Bus depot"}}},
    {L_TRANSIT, "BUSES & TRAIN", {{Sym::Express, 0, Ico::Dot, "Legacy Express"}, {Sym::XTunnel, 0, Ico::Dot, "Tunnel"}, {Sym::XStop, 0, Ico::Dot, "Station"}, {Sym::Icon, 0, Ico::Bus, "Ski bus"}, {Sym::Icon, 0, Ico::Train, "Railway"}}},
    {L_PLACES, "PLACES", {{Sym::Icon, 0, Ico::ChaletV, "Chalet village"}, {Sym::Icon, 0, Ico::Hut, "Mountain hut"}, {Sym::Icon, 0, Ico::Shop, "Ski shop"}, {Sym::Icon, 0, Ico::Car, "Autohaus"},
                          {Sym::Icon, 0, Ico::Garage, "Werkstatt"}, {Sym::Icon, 0, Ico::Med, "Medical centre"}, {Sym::Icon, 0, Ico::Police, "Police"}, {Sym::Icon, 0, Ico::Secret, "Landmark"}}},
    {L_JOBS, "JOBS", {{Sym::Icon, 0, Ico::Board, "Job board"}, {Sym::Icon, 0, Ico::Job, "Job target"}}},
    {L_MINE, "MINE", {{Sym::Icon, 0, Ico::Chalet, "Your chalet"}, {Sym::Icon, 0, Ico::MyCar, "Your car"}, {Sym::Icon, 0, Ico::Impound, "Impounded"}, {Sym::Icon, 0, Ico::MyHeli, "Your heli"}}},
  };
  const float rowH = std::max(27 * u, tSm * 1.2f), headLine = tXs;
  auto legSymW = [&](const LegRow& r) { return r.sym == Sym::Icon || r.sym == Sym::You || r.sym == Sym::Peak || r.sym == Sym::MarkS || r.sym == Sym::Cluster || r.sym == Sym::XStop || r.sym == Sym::PNum ? 24 * d : 22 * u; };
  // (the rows never wrap: where the type stops shrinking with the window (t-sm's 12 px floor) the panel grows to hold them)
  float legNeed = 0;
  for (const LegSec& sec : LEGEND) {
    float c0 = 0, c1 = 0;
    for (size_t i = 0; i < sec.rows.size(); i++) { float w = legSymW(sec.rows[i]) + 7 * u + ui.textWidth(sec.rows[i].label, tSm, UiFont::BodySemi); (i % 2 ? c1 : c0) = std::max(i % 2 ? c1 : c0, w); }
    legNeed = std::max(legNeed, c0 + 14 * u + c1);
  }
  const float legW = std::min(ovW, std::max(std::max(210 * d, 290 * u), legNeed + 60 * u)), legX = ovX + ovW - legW, legY = barBottom + 8 * d;
  float legContent = 18 * u + 16 * u;
  {
    bool first = true;
    for (const LegSec& sec : LEGEND) {
      if (sec.layer >= 0 && !M.layers[sec.layer]) continue;
      legContent += (first ? 0 : 12 * u) + headLine + 8 * u + rowH * float((sec.rows.size() + 1) / 2);
      first = false;
    }
  }
  const float legH = std::min(legContent, std::max(40 * u, ovB - legY));
  auto inRect = [&](vec2 p, float x, float y, float w, float h) { return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h; };
  const bool mouseOk = nav.mouse.x >= 0 && !nav.usingPad;
  const bool overLegend = M.legendOpen && mouseOk && inRect(nav.mouse, legX, legY, legW, legH);
  int overChip = -1;
  bool overLegBtn = mouseOk && inRect(nav.mouse, legBtn.x, legBtn.y, legBtn.w, legBtn.h);
  if (mouseOk && !overLegend) for (int i = 0; i < 7; i++) if (inRect(nav.mouse, chips[i].x, chips[i].y, chips[i].w, chips[i].h)) overChip = i;
  const bool overCanvas = mouseOk && !overLegend && overChip < 0 && !overLegBtn && inRect(nav.mouse, cxp, cyp, cw, chh);
  // the pointer on the canvas (CSS px): the mouse, or the centre on a controller
  vec2 ptr = nav.usingPad ? vec2(M.W / 2, M.H / 2) : vec2((nav.mouse.x - cxp) / d, (nav.mouse.y - cyp) / d);
  const bool ptrOn = nav.usingPad || overCanvas;

  // ---- input
  if (nav.cancel || nav.menu) { close(); return false; }
  bool pickNow = false;
  vec2 pickAt(0);
  if (nav.wheel != 0) {
    if (overLegend) M.legendScroll = std::clamp(M.legendScroll - nav.wheel * 40 * u, 0.f, std::max(0.f, legContent - legH));
    else if (overCanvas || nav.usingPad) M.zoomAt(ptr.x, ptr.y, std::pow(1.197, double(nav.wheel)));
  }
  double zk = double(nav.zoomIn - nav.zoomOut);
  if (zk != 0) M.zoomAt(M.W / 2, M.H / 2, std::exp(zk * dt * 1.8));
  if (glm::length(nav.stickL) > 0.18f) { M.vx += double(nav.stickL.x) * dt * 520 / M.vs; M.vz += double(nav.stickL.y) * dt * 520 / M.vs; }
  if (!nav.usingPad) {
    // the arrows: a step of 140 px (trailmap.js keydown); R: back to you
    const double step = 140 / M.vs;
    for (platform::Key k : nav.keys) {
      if (k == platform::Key::KeyR) { M.vx = you.x; M.vz = you.z; }
      else if (k == platform::Key::ArrowLeft) M.vx -= step;
      else if (k == platform::Key::ArrowRight) M.vx += step;
      else if (k == platform::Key::ArrowUp) M.vz -= step;
      else if (k == platform::Key::ArrowDown) M.vz += step;
    }
  } else {
    if (in.padPressed(3)) { M.vx = you.x; M.vz = you.z; }
    if (nav.confirm) { pickNow = true; pickAt = ptr; }
  }
  if (nav.click && mouseOk) {
    if (overLegend) { /* (clicks inside the panel stay there) */ }
    else if (overLegBtn) { M.legendOpen = !M.legendOpen; M.legendScroll = 0; }
    else if (overChip >= 0) { M.layers[overChip] = !M.layers[overChip]; M.hotRace.clear(); M.hotStation.clear(); }
    else if (overCanvas) { M.dragging = true; M.dragStart = nav.mouse; M.dragView = dvec2(M.vx, M.vz); M.dragMoved = 0; }
    else if (!inRect(nav.mouse, mx, my, mw, mh) && !inRect(nav.mouse, padX, padT, SW - 2 * padX, headH) && nav.mouse.y < my + mh + gap * 0.5f) { close(); return false; }   // (a click outside closes the map)
  }
  if (M.dragging) {
    if (nav.mouseDown) {
      vec2 dm = (nav.mouse - M.dragStart) / d;
      M.dragMoved = std::max(M.dragMoved, glm::length(dm));
      M.vx = M.dragView.x - dm.x / M.vs; M.vz = M.dragView.y - dm.y / M.vs;
    } else {
      M.dragging = false;
      if (M.dragMoved < 5) {
        vec2 at = (M.dragStart - vec2(cxp, cyp)) / d;
        // a double click zooms in (trailmap.js dblclick); a single one marks
        if (M.now - M.lastClickT < 0.35 && glm::length(at - M.lastClickAt) < 6) { M.zoomAt(at.x, at.y, 1.8); M.lastClickT = -10; }
        else { M.lastClickT = M.now; M.lastClickAt = at; }
        pickNow = true; pickAt = at;
      }
    }
  }
  M.mk = Live();
  if (live) live(M.mk);
  if (car) { bool have = false; for (const Marker& m : M.mk.mine) have = have || m.kind != "heli"; if (!have) { Marker m; m.x = car->x; m.z = car->z; m.kind = "car"; m.label = "Your car"; M.mk.mine.push_back(std::move(m)); } }
  M.buildTiles();

  // ---- draw: the dimmed game, the head
  const float fade = float(std::clamp((M.now - M.openT) / 0.25, 0.0, 1.0));
  M.drawn = 0;
  ui.pushAlpha(fade);
  ui.rectGradient(0, 0, SW * 0.6f, SH, hex(0x040e22, 0.84f), hex(0x040e22, 0.62f));
  ui.rectGradient(SW * 0.6f, 0, SW * 0.4f, SH, hex(0x040e22, 0.62f), hex(0x040e22, 0.5f));
  {
    Ui::Shadow sh{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
    ui.brushStroke(padX, padT, 290 * u, headH, white, 77, 320, 100, &sh);
    ui.textLH(padX + 40 * u, padT, headH, 44 * u, UiFont::CondItalic, blue, "TRAIL MAP", UiAlign::Left, 0.04f);
    float x = padX + 290 * u + 26 * u + 12 * u, lh = tMd * 1.35f, y = padT + (headH - lh) / 2;
    const vec4 shc = hex(0x000a1e, 0.6f), col = a(white, 0.92f);
    std::string pre = M.where.empty() ? "Legacy Valley" : "You are here \xC2\xB7 ";
    ui.textShadow(x, y + (lh - ui.lineHeight(tMd, UiFont::BodySemi)) / 2, tMd, UiFont::BodySemi, pre, UiAlign::Left, 0.02f, 0, d, 8 * d, shc);
    x += ui.textLH(x, y, lh, tMd, UiFont::BodySemi, col, pre, UiAlign::Left, 0.02f);
    if (!M.where.empty()) {
      float fs = 22 * u;
      // (the bold name sits on the line's baseline)
      float base = y + lh / 2 + (ui.ascent(UiFont::BodySemi) + ui.descent(UiFont::BodySemi)) / 2 * tMd;
      float yt = base - (ui.ascent(UiFont::CondItalic) + ui.descent(UiFont::CondItalic)) / 2 * fs - ui.lineHeight(fs, UiFont::CondItalic) / 2;
      ui.textShadow(x, yt, fs, UiFont::CondItalic, M.where, UiAlign::Left, 0.02f, 0, d, 8 * d, shc);
      ui.text(x, yt, fs, UiFont::CondItalic, col, M.where, UiAlign::Left, 0.02f);
    }
  }
  // the sheet
  {
    Ui::Shadow sh{0, 12 * u, 26 * u, hex(0x000e2c, 0.38f)};
    ui.brushClip(mx, my, mw, mh, white, 171, 3, 4, u, &sh);
  }
  // ---- the map (trailmap.js drawBase)
  ui.pushClip(cxp, cyp, cw, chh);
  ui.rect(cxp, cyp, cw, chh, hex(0xeef2fa));
  M.drawRelief();
  M.boxes.clear(); M.queue.clear(); M.spots.clear(); M.icons.clear(); M.pins.clear(); M.dynSpots.clear();
  if (M.layers[L_ROADS]) M.drawRoads();
  M.drawVillage();
  M.drawChalets();
  if (M.layers[L_PISTES]) { M.drawPark(); M.drawPistes(); }
  if (M.layers[L_TRANSIT]) M.drawExpress();
  if (M.layers[L_RACES]) M.drawRaceLines();
  if (M.layers[L_PISTES]) M.drawLifts();
  if (M.layers[L_TRANSIT]) M.drawRailway();
  M.drawPlaces();
  if (M.layers[L_TRANSIT]) M.drawExpressStops();
  if (M.layers[L_RACES]) M.drawRaceMarks();
  M.drawTarget();
  // you reserve your spot before the labels are placed (drawPlayer's reserve)
  {
    float x = M.X(you.x), y = M.Z(you.z);
    if (x >= 20 && y >= 20 && x <= M.W - 20 && y <= M.H - 20) M.reserve(x, y, 17);
  }
  M.placeIcons();
  ui.popClip();
  M.placeLabels();
  // ---- what moves (trailmap.js drawLive)
  ui.pushClip(cxp, cyp, cw, chh);
  if (mark.on) {
    float x = M.X(mark.x), y = M.Z(mark.z), r = 13 + float(std::sin(M.now * 1000 / 260)) * 2;
    if (M.inView(x, y, 0)) { M.ringS(x, y, r - 3, 6, a(white, 0.95f)); M.ringS(x, y, r - 1.5f, 3, hex(C_RED)); }
  }
  if (!M.hotRace.empty()) {
    auto it = M.pins.find(M.hotRace);
    if (it != M.pins.end()) {
      float ph = float(std::fmod(M.now / 1.3, 1.0));
      M.ringS(it->second.x, it->second.cy, it->second.r + 3 + ph * 18 - 1.25f, 2.5f, hex(it->second.col, 0.6f * (1 - ph)));
    }
  }
  for (const Marker& m : M.mk.players) {
    float x = M.X(m.x), y = M.Z(m.z);
    if (!M.inView(x, y)) continue;
    float ux = float(std::sin(m.yaw)), uy = float(std::cos(m.yaw));
    M.polyS({vec2(x + ux * 12, y + uy * 12), vec2(x - uy * 5.5f, y + ux * 5.5f), vec2(x + uy * 5.5f, y - ux * 5.5f)}, 1, hex(0x12a150));
    M.polyF({vec2(x + ux * 12, y + uy * 12), vec2(x - uy * 5.5f, y + ux * 5.5f), vec2(x + uy * 5.5f, y - ux * 5.5f)}, hex(0x12a150));
    M.disc(x, y, 8, white); M.disc(x, y, 6, hex(0x12a150));
    if (!m.label.empty()) {
      M.text(m.label, x + 11, y, 14, UiFont::CondItalic, hex(0x0d7a3c), 0, a(white, 0.94f), 2);
      Spot s; s.x = x; s.y = y; s.r = 9; s.wx = m.x; s.wz = m.z; s.label = m.label; s.tip = {m.label, {"Player"}};
      M.dynSpots.push_back(std::move(s));
    }
  }
  for (const Marker& m : M.mk.police) {
    float x = M.X(m.x), y = M.Z(m.z);
    if (!M.inView(x, y)) continue;
    Spot s; s.x = x; s.y = y; s.wx = m.x; s.wz = m.z;
    if (m.kind == "heli") {
      if (m.flag) M.ringS(x, y, 13 - 1.25f, 2.5f, hex(0xd0342c, 0.5f + 0.4f * float(std::sin(M.now * 1000 / 180))));
      M.mapIcon(Ico::PoliceHeli, x, y, 9);
      s.r = 10; s.label = "Police helicopter"; s.tip = {"Police helicopter", {m.flag ? "It is tracking you" : "Searching for you"}};
    } else {
      float r = M.vs >= 0.2 ? 7.f : 6.f;
      M.disc(x, y, r + 1, white); M.disc(x, y, r - 1, hex(0x1f4fff));
      s.r = 8; s.label = "Police"; s.tip = {"Police patrol", {"You are wanted"}};
    }
    M.dynSpots.push_back(std::move(s));
  }
  {
    // you: off the map an arrow at the edge pointing to you; else a soft pulse, then the arrow in its halo
    float x = M.X(you.x), y = M.Z(you.z), mg = 20, ex = std::clamp(x, mg, M.W - mg), ey = std::clamp(y, mg, M.H - mg);
    if (ex != x || ey != y) {
      float ang = std::atan2(y - ey, x - ex), c = std::cos(ang), s = std::sin(ang);
      auto R = [&](float px, float py) { return vec2(ex + px * c - py * s, ey + px * s + py * c); };
      vec2 p0 = R(13, 0), p1 = R(-9, -9), p2 = R(-4, 0), p3 = R(-9, 9);
      M.polyS({p0, p1, p2, p3}, 2.5f, white);
      ui.tri(M.P(p0.x, p0.y), M.P(p1.x, p1.y), M.P(p2.x, p2.y), hex(C_RED));
      ui.tri(M.P(p0.x, p0.y), M.P(p2.x, p2.y), M.P(p3.x, p3.y), hex(C_RED));
    } else {
      float ph = float(std::fmod(M.now / 1.4, 1.0));
      M.ringS(x, y, 17 + ph * 20 - 1.25f, 2.5f, hex(C_RED, 0.55f * (1 - ph)));
      M.arrow(x, y, std::atan2(float(std::cos(heading)), float(std::sin(heading))));
    }
  }
  if (nav.usingPad) { M.line(M.W / 2 - 8, M.H / 2, M.W / 2 + 8, M.H / 2, 2, hex(C_NAVY, 0.7f)); M.line(M.W / 2, M.H / 2 - 8, M.W / 2, M.H / 2 + 8, 2, hex(C_NAVY, 0.7f)); }
  ui.popClip();
  // the canvas's rounded corners (border-radius 4u): the paper over them
  ui.roundRectStroke(cxp - 3 * u, cyp - 3 * u, cw + 6 * u, chh + 6 * u, 7 * u, 3 * u, white);

  // ---- the pointer: the pick, the hover and its tooltip
  if (pickNow) {
    const Spot* s = M.spotAt(pickAt.x, pickAt.y);
    Spot ln;
    if (!s && M.lineAt(pickAt.x, pickAt.y, ln)) s = &ln;
    if (s) {
      if (mark.on && std::hypot(mark.x - s->wx, mark.z - s->wz) < 1) mark.on = false;
      else { mark.on = true; mark.x = s->wx; mark.z = s->wz; mark.label = s->label; }
    } else {
      double wx = M.vx + (pickAt.x - M.W / 2) / M.vs, wz = M.vz + (pickAt.y - M.H / 2) / M.vs;
      if (mark.on && std::hypot(mark.x - wx, mark.z - wz) * M.vs < 14) mark.on = false;
      else { mark.on = true; mark.x = wx; mark.z = wz; mark.label = "Marked spot"; }
    }
  }
  hover.clear();
  Tip tip;
  std::vector<std::string> tipMore;
  bool haveTip = false;
  M.hotRace.clear(); M.hotStation.clear();
  if (ptrOn && !(M.dragging && M.dragMoved > 4)) {
    const Spot* s = M.spotAt(ptr.x, ptr.y);
    Spot ln;
    bool isLine = false;
    if (!s && M.lineAt(ptr.x, ptr.y, ln)) { s = &ln; isLine = true; }
    if (s) {
      if (!isLine || !s->race.empty()) { M.hotRace = s->race; M.hotStation = s->station; }
      tip = s->tipFn ? s->tipFn() : s->tip;
      if (tip.title.empty()) tip.title = s->label;
      tipMore = s->more;
      haveTip = true;
      hover = tip.title;
    }
  }

  // ---- the scale bar (.tm-scale)
  {
    static const int steps[] = {50, 100, 200, 250, 500, 1000, 2000, 2500, 5000};
    int m = steps[0];
    for (int v : steps) if (v * M.vs <= 190) m = v;
    float bw = std::round(float(m * M.vs)) * d, bh = 7 * u, bx = mx + 30 * u, fs = 17 * u;
    float rowHs = std::max(bh + 2 * d, fs), by = my + mh - 28 * u - rowHs / 2 - bh / 2;
    ui.roundRectStroke(bx - 2 * d, by - 2 * d, bw + 4 * d, bh + 4 * d, 0, 2 * d, a(white, 0.85f));
    ui.rect(bx, by, 2 * d, bh, blue); ui.rect(bx + bw - 2 * d, by, 2 * d, bh, blue); ui.rect(bx, by + bh - 2 * d, bw, 2 * d, blue);
    char b[32];
    if (m >= 1000) std::snprintf(b, sizeof b, "%g km", m / 1000.0); else std::snprintf(b, sizeof b, "%d m", m);
    float ty = my + mh - 28 * u - rowHs / 2 - ui.lineHeight(fs, UiFont::CondItalic) / 2;
    ui.textHalo(bx + bw + 8 * u, ty, fs, UiFont::CondItalic, blue, a(white, 0.9f), 2 * d, b);
  }
  // ---- the layer switches, the Legend button
  for (int i = 0; i < 7; i++) {
    const Chip& c = chips[i];
    bool on = M.layers[i], hv = overChip == i;
    ui.boxShadow(c.x, c.y, c.w, c.h, c.h / 2, 0, 1 * d, 4 * d, hex(0x08143c, 0.25f));
    ui.roundRect(c.x, c.y, c.w, c.h, c.h / 2, a(white, hv ? 1.f : on ? 0.94f : 0.7f));
    float dx = c.x + 8 * d + 5 * d, dy = c.y + c.h / 2;
    if (on) ui.circle(dx, dy, 6.5f * d, hex(LAYERS[i].col));
    else ui.ring(dx, dy, 5 * d, 1.5f * d, hex(0x9aa3bb));
    ui.textLH(c.x + 8 * d + 10 * d + 6 * d, c.y, c.h, tXs, UiFont::BodyBold, on ? blue : hex(0x7d88a6), LAYERS[i].name);
  }
  {
    bool on = M.legendOpen;
    ui.boxShadow(legBtn.x, legBtn.y, legBtn.w, legBtn.h, legBtn.h / 2, 0, 1 * d, 4 * d, hex(0x08143c, 0.25f));
    ui.roundRect(legBtn.x, legBtn.y, legBtn.w, legBtn.h, legBtn.h / 2, on ? blue : a(white, overLegBtn ? 1.f : 0.94f));
    ui.textLH(legBtn.x + legBtn.w / 2, legBtn.y, legBtn.h, tXs, UiFont::BodyBold, on ? white : blue, "Legend", UiAlign::Center);
  }
  // ---- the legend
  if (M.legendOpen) {
    M.legendScroll = std::clamp(M.legendScroll, 0.f, std::max(0.f, legContent - legH));
    Ui::Shadow sh{0, 10 * u, 24 * u, hex(0x000e2c, 0.3f)};
    ui.brushClip(legX, legY, legW, legH, a(white, 0.95f), 172, 5, 4, u, &sh);
    ui.pushClip(legX, legY + 6 * u, legW, legH - 12 * u);
    float y = legY + 18 * u - M.legendScroll, x0 = legX + 30 * u, colGap = 14 * u, innerW = legW - 60 * u;
    bool first = true;
    for (const LegSec& sec : LEGEND) {
      if (sec.layer >= 0 && !M.layers[sec.layer]) continue;
      if (!first) y += 12 * u;
      first = false;
      ui.textLH(x0, y, headLine, tXs, UiFont::BodyHeavy, red, sec.head, UiAlign::Left, 0.18f);
      y += headLine + 8 * u;
      // .tm-grid: two columns (auto 1fr): the first as wide as its widest entry
      auto symW = legSymW;
      float col0 = 0;
      for (size_t i = 0; i < sec.rows.size(); i += 2) col0 = std::max(col0, symW(sec.rows[i]) + 7 * u + ui.textWidth(sec.rows[i].label, tSm, UiFont::BodySemi));
      (void)innerW;
      for (size_t i = 0; i < sec.rows.size(); i++) {
        const LegRow& r = sec.rows[i];
        float rx = x0 + (i % 2 ? col0 + colGap : 0), ry = y + rowH * float(i / 2), sw = symW(r), sh2 = sw > 22 * u + 0.01f || r.sym == Sym::Icon ? 20 * d : 18 * u;
        if (ry + rowH > legY && ry < legY + legH) {
          M.legendSym(r, rx, ry + (rowH - sh2) / 2, sw, sh2);
          ui.textLH(rx + sw + 7 * u, ry, rowH, tSm, UiFont::BodySemi, blue, r.label);
        }
      }
      y += rowH * float((sec.rows.size() + 1) / 2);
    }
    ui.popClip();
  }
  // ---- the tooltip (.tm-tip)
  if (haveTip) {
    const float tfs = std::max(15 * d, 16 * u), lfs = tXs, llh = lfs * 1.35f, maxW = 240 * d - 20 * d;
    auto wrap = [&](const std::string& s, float fs, UiFont f) {
      std::vector<std::string> out;
      std::string lineS, word;
      for (size_t i = 0; i <= s.size(); i++) {
        char ch = i < s.size() ? s[i] : ' ';
        if (ch != ' ') { word += ch; continue; }
        if (word.empty()) continue;
        std::string cand = lineS.empty() ? word : lineS + " " + word;
        if (!lineS.empty() && ui.textWidth(cand, fs, f) > maxW) { out.push_back(lineS); lineS = word; } else lineS = cand;
        word.clear();
      }
      if (!lineS.empty()) out.push_back(lineS);
      return out;
    };
    struct TL { std::string s; float fs, lh, top; UiFont f; vec4 c; };
    std::vector<TL> L;
    for (const std::string& s : wrap(tip.title, tfs, UiFont::CondItalic)) L.push_back({s, tfs, tfs * 1.1f, 0, UiFont::CondItalic, blue});
    for (const std::string& ln : tip.lines) if (!ln.empty()) for (const std::string& s : wrap(ln, lfs, UiFont::BodyMed)) L.push_back({s, lfs, llh, 0, UiFont::BodyMed, hex(0x4a5a85)});
    if (!tipMore.empty()) {
      std::string all = "Also here: ";
      for (size_t i = 0; i < tipMore.size(); i++) all += (i ? DOT : "") + tipMore[i];
      bool f1 = true;
      for (const std::string& s : wrap(all, lfs, UiFont::BodyMed)) { L.push_back({s, lfs, llh, f1 ? 3 * d : 0, UiFont::BodyMed, hex(0x15214a)}); f1 = false; }
    }
    L.push_back({"Click to mark", lfs * 0.9f, lfs * 0.9f * 1.35f, 3 * d, UiFont::BodyMed, hex(0x8a94b0)});
    float w = 0, h = 7 * d + 8 * d;
    for (const TL& t : L) { w = std::max(w, ui.textWidth(t.s, t.fs, t.f)); h += t.lh + t.top; }
    w += 20 * d;
    float px = ptr.x * d, py = ptr.y * d, Wp = M.W * d, Hp = M.H * d;
    float x = px + 16 * d + w > Wp ? px - 12 * d - w : px + 16 * d, y = py + 18 * d + h > Hp ? py - 12 * d - h : py + 18 * d;
    x = std::round(cxp + std::max(4 * d, x)); y = std::round(cyp + std::max(4 * d, y));
    ui.boxShadow(x, y, w, h, 6 * d, 0, 3 * d, 12 * d, hex(0x08143c, 0.3f));
    ui.roundRect(x, y, w, h, 6 * d, a(white, 0.97f));
    float ty = y + 7 * d;
    for (const TL& t : L) { ty += t.top; ui.textLH(x + 10 * d, ty, t.lh, t.fs, t.f, t.c, t.s); ty += t.lh; }
  }
  // ---- the hints (.tm-hints)
  {
    const vec4 col = a(white, 0.88f), shc = a(hex(0x000000), 0.5f);
    float x = padX, y = my + mh + gap, hgap = std::max(4 * d, 6 * u);
    auto hint = [&](const std::string& cap, const std::string& labelS) {
      float w = ui.kcWidth(u, cap) + hgap + ui.textWidth(labelS, tXs, UiFont::BodySemi, 0.1f);
      if (x + w > SW - padX && x > padX) return;   // (flex-wrap: the row's height is fixed here; the rest is dropped on a narrow window)
      x += ui.kc(x, y, u, cap, col) + hgap;
      float ty = y + (hintH - ui.lineHeight(tXs, UiFont::BodySemi)) / 2;
      ui.textShadow(x, ty, tXs, UiFont::BodySemi, labelS, UiAlign::Left, 0.1f, 0, d, 6 * d, shc);
      x += ui.text(x, ty, tXs, UiFont::BodySemi, col, labelS, UiAlign::Left, 0.1f) + 22 * u;
    };
    if (nav.usingPad) {
      platform::PadFamily f = in.padFamily();
      hint(prompts::padGlyph(prompts::backButton(f), f), "CLOSE");
      hint("L STICK", "MOVE");
      hint(std::string(prompts::padGlyph(6, f)) + " " + prompts::padGlyph(7, f), "ZOOM");
      hint(prompts::padGlyph(prompts::confirmButton(f), f), "MARK A PLACE");
      hint(prompts::padGlyph(3, f), "BACK TO YOU");
    } else {
      hint(prompts::K(in, Action::Map), "CLOSE"); hint("DRAG", "MOVE"); hint("SCROLL", "ZOOM"); hint("POINT", "INFO"); hint("CLICK", "MARK A PLACE"); hint("R", "BACK TO YOU");
    }
  }
  ui.popAlpha();
  drawnItems = M.drawn;
  return true;
}

// ============================================================================ the route picker (travel.js)
namespace {
std::string fmtMin(double min) { return min < 1.5 ? "1 min" : std::to_string(int(std::lround(min))) + " min"; }
std::string fmt1(double v) { char b[32]; std::snprintf(b, sizeof b, "%.1f", v); return b; }
std::string stripSuffix(std::string s, std::initializer_list<const char*> ends) {
  for (const char* e : ends) { std::string k = e; if (s.size() > k.size() && s.compare(s.size() - k.size(), k.size(), k) == 0) return s.substr(0, s.size() - k.size()); }
  return s;
}
} // namespace

TrailMap::Travel TrailMap::busTravel(int from, const std::vector<int>& dests) const {
  const Impl& M = *m_;
  Travel T;
  T.title = "Ski bus"; T.lineStyle = 0;
  if (!M.transport || from < 0 || size_t(from) >= M.transport->stops.size()) return T;
  const Transport& t = *M.transport;
  int nRaces = 0;
  if (M.play) nRaces = int(M.play->busRaces.size());
  T.kicker = nRaces ? "FREE SHUTTLE \xC2\xB7 " + std::to_string(nRaces) + " FREE RACES" : "FREE SHUTTLE";
  const StopInfo& S = t.stops[size_t(from)];
  T.subPre = "From "; T.subBold = S.name; T.subPost = " \xC2\xB7 pick your stop";
  T.from = {S.name, S.x, S.z, ""};
  for (const Road& r : t.roads) {
    std::vector<dvec3> L;
    for (int i = 0; i < r.n; i += 3) L.push_back(dvec3(r.X[size_t(i)], r.Z[size_t(i)], 0));
    if (r.n > 0) L.push_back(dvec3(r.X[size_t(r.n - 1)], r.Z[size_t(r.n - 1)], 0));
    if (L.size() > 1) T.lines.push_back(std::move(L));
  }
  for (const StopInfo& st : t.stops) T.stops.push_back({st.name, st.x, st.z, ""});
  // the way there: up the tree to the common road, then down (bus.js legs)
  auto parent = [&](int stop) -> const Road* {
    for (const Road& r : t.legs) if (r.to == stop && r.n > 3) return &r;
    for (const Road& r : t.roads) if (r.to == stop && r.n > 3 && !r.access && !r.depot) return &r;
    return nullptr;
  };
  auto toRoot = [&](int stop) { std::vector<const Road*> out; for (int s = stop, g = 0; g < 20; g++) { const Road* r = parent(s); if (!r) break; out.push_back(r); s = r->from; } return out; };
  for (int di : dests) {
    if (di < 0 || size_t(di) >= t.stops.size()) continue;
    const StopInfo& D = t.stops[size_t(di)];
    TravelDest d;
    d.name = D.name; d.x = D.x; d.z = D.z; d.tag = "FREE"; d.id = di;
    auto up = toRoot(from), down = toRoot(di);
    while (!up.empty() && !down.empty() && up.back() == down.back()) { up.pop_back(); down.pop_back(); }
    double len = 0, sec = 0;
    d.path.push_back(dvec2(S.x, S.z));
    auto addRoad = [&](const Road& r, bool rev) {
      for (int k = 0; k < r.n; k += 3) { int i = rev ? r.n - 1 - k : k; d.path.push_back(dvec2(r.X[size_t(i)], r.Z[size_t(i)])); }
      int e = rev ? 0 : r.n - 1;
      d.path.push_back(dvec2(r.X[size_t(e)], r.Z[size_t(e)]));
      len += r.length; sec += 4 + r.length / (t.bus.cruise * 0.6);
    };
    for (const Road* r : up) addRoad(*r, true);
    for (int k = int(down.size()) - 1; k >= 0; k--) addRoad(*down[size_t(k)], false);
    d.path.push_back(dvec2(D.x, D.z));
    if (len <= 0) { len = std::hypot(D.x - S.x, D.z - S.z); sec = std::max(60.0, len / 1000 * 1.05 * 60); }
    const Course* br = nullptr;
    if (M.play) for (const Course& c : M.play->busRaces) if (c.stop == D.name) br = &c;
    if (br) d.color = br->color;
    d.meta = (br ? "Race: " + br->name + " \xC2\xB7 free entry \xC2\xB7 " : std::string()) + fmtMin(sec / 60) + " ride \xC2\xB7 " + fmt1(len / 1000) + " km";
    T.dests.push_back(std::move(d));
  }
  std::stable_sort(T.dests.begin(), T.dests.end(), [&](const TravelDest& p, const TravelDest& q) { return std::hypot(p.x - S.x, p.z - S.z) < std::hypot(q.x - S.x, q.z - S.z); });   // (skibus.js destinations: nearest first)
  T.goLabel = [](const TravelDest& d) { return "Ride to " + stripSuffix(d.name, {" Gondola"}); };
  return T;
}

TrailMap::Travel TrailMap::railTravel(int st, bool pass, long long money) const {
  const Impl& M = *m_;
  Travel T;
  T.title = M.railName; T.lineStyle = 1;
  if (!M.transport || !M.transport->rail.ok || st < 0 || size_t(st) >= M.transport->rail.stations.size()) return T;
  const auto& R = M.transport->rail;
  const int price = R.price;
  T.kicker = pass ? "DAY PASS ACTIVE" : "UPHILL $" + std::to_string(price) + " \xC2\xB7 DOWNHILL FREE";
  const auto& S = R.stations[size_t(st)];
  T.subPre = "From "; T.subBold = S.name; T.subPost = " \xC2\xB7 pick your stop";
  T.from = {S.name, S.pos.x, S.pos.z, ""};
  std::vector<dvec3> L;
  for (const Impl::RailPt& p : M.railway) L.push_back(dvec3(p.x, p.z, p.tunnel ? 1 : 0));
  T.lines.push_back(std::move(L));
  for (const auto& q : R.stations) T.stops.push_back({q.name, q.pos.x, q.pos.z, ""});
  // the line climbs with s when its last station is the higher one
  const bool sUp = R.stations.back().pos.y >= R.stations.front().pos.y;
  for (size_t i = 0; i < R.stations.size(); i++) {
    if (int(i) == st) continue;
    const auto& D = R.stations[i];
    TravelDest d;
    d.name = D.name; d.x = D.pos.x; d.z = D.pos.z;
    bool up = (D.s > S.s) == sUp;
    double km = std::fabs(D.s - S.s) / 1000, s0 = std::min(S.s, D.s), s1 = std::max(S.s, D.s);
    int halts = 0;
    for (const auto& q : R.stations) if (q.s > s0 + 1 && q.s < s1 - 1) halts++;
    double min = (std::fabs(D.s - S.s) / 16.0 + halts * R.dwellMid) / 60;
    for (int k = 0; k < R.line.n; k += 4) { double sk = k * R.line.step; if (sk >= s0 && sk <= s1) d.path.push_back(dvec2(R.line.X[size_t(k)], R.line.Z[size_t(k)])); }
    if (S.s > D.s) std::reverse(d.path.begin(), d.path.end());
    d.meta = fmtMin(min) + " \xC2\xB7 " + fmt1(km) + " km \xC2\xB7 " + (up ? "uphill" : "downhill");
    if (!up) d.tag = "FREE"; else if (pass) d.tag = "DAY PASS"; else { d.price = price; d.shortMoney = money < price; }
    d.id = up ? 1 : 0;   // (the direction: 1 up, 0 down)
    T.dests.push_back(std::move(d));
  }
  T.goLabel = [](const TravelDest& d) { return "Ride to " + stripSuffix(d.name, {" Gondola"}); };
  return T;
}

TrailMap::Travel TrailMap::expressTravel(int st, bool pass, long long money) const {
  const Impl& M = *m_;
  Travel T;
  T.title = M.expressName; T.lineStyle = 3; T.listHead = "STATIONS";
  if (!M.transport || !M.transport->express.ok || st < 0 || size_t(st) >= M.transport->express.stations.size()) return T;
  const auto& X = M.transport->express;
  const int price = X.price;
  T.kicker = pass ? "DAY PASS ACTIVE \xC2\xB7 300 KM/H" : "$" + std::to_string(price) + " TO ANY RACE \xC2\xB7 300 KM/H";
  const auto& S = X.stations[size_t(st)];
  T.subPre = "From "; T.subBold = S.name; T.subPost = " \xC2\xB7 pick your station";
  T.from = {S.name, S.pos.x, S.pos.z, S.course};
  std::vector<dvec3> L;
  for (const Impl::RailPt& p : M.express) L.push_back(dvec3(p.x, p.z, p.tunnel ? 1 : 0));
  T.lines.push_back(std::move(L));
  for (const auto& q : X.stations) T.stops.push_back({q.name, q.pos.x, q.pos.z, q.course});
  const double ring = X.line.ring ? X.line.length : 0;
  struct Row { TravelDest d; bool race; double min; };
  std::vector<Row> rows;
  for (size_t i = 0; i < X.stations.size(); i++) {
    if (int(i) == st) continue;
    const auto& D = X.stations[i];
    TravelDest d;
    d.name = D.name; d.x = D.pos.x; d.z = D.pos.z; d.race = D.course; d.id = int(i);
    // the shorter way round the ring
    double fwd = D.s - S.s;
    if (ring > 0) { fwd = std::fmod(fwd + ring, ring); }
    bool forward = ring <= 0 ? fwd >= 0 : fwd <= ring - fwd;
    double dist = ring > 0 ? std::min(fwd, ring - fwd) : std::fabs(fwd);
    int stops = 0;
    for (const auto& q : X.stations) {
      if (&q == &S || &q == &D) continue;
      double a0 = ring > 0 ? std::fmod(q.s - S.s + ring, ring) : q.s - S.s;
      if (ring > 0 ? (forward ? a0 < fwd : a0 > fwd) : (a0 > std::min(0.0, fwd) && a0 < std::max(0.0, fwd))) stops++;
    }
    double min = (dist / 75.0 + 20 + stops * X.dwell) / 60;
    int n = int(dist / 24) + 2;
    for (int k = 0; k <= n; k++) {
      double sk = S.s + (forward ? 1 : -1) * dist * double(k) / n;
      Line::P q = X.line.at(X.line.wrap(sk));
      d.path.push_back(dvec2(q.x, q.z));
    }
    const Impl::RaceM* e = nullptr;
    for (const Impl::RaceM& r : M.races) if (!D.course.empty() && r.id == D.course) e = &r;
    if (e) {
      d.color = e->color;
      d.meta = e->diff + " \xC2\xB7 up to $" + fmtInt(e->rewardMax ? e->rewardMax : e->reward) + " prize \xC2\xB7 " + fmtMin(min);
      d.planName = e->diff; d.planColor = e->color;
      d.plan = {{"RIDE", std::to_string(std::max(1, int(std::lround(min)))), "min"}, {"STOPS", std::to_string(stops), ""}, {"PRIZE", "\xE2\x89\xA4$" + fmtInt(e->rewardMax ? e->rewardMax : e->reward), ""}};
    } else {
      d.meta = fmtMin(min) + " \xC2\xB7 " + std::to_string(int(std::lround(dist / 1000))) + " km \xC2\xB7 the ski shop";
      d.planName = "Legacy Village";
      d.plan = {{"RIDE", std::to_string(std::max(1, int(std::lround(min)))), "min"}, {"STOPS", std::to_string(stops), ""}, {"KM", std::to_string(int(std::lround(dist / 1000))), ""}};
    }
    if (pass) d.tag = "DAY PASS"; else { d.price = price; d.shortMoney = money < price; }
    rows.push_back({std::move(d), e != nullptr, min});
  }
  std::stable_sort(rows.begin(), rows.end(), [](const Row& p, const Row& q) { return p.race != q.race ? p.race : p.min < q.min; });
  for (Row& r : rows) T.dests.push_back(std::move(r.d));
  T.goLabel = [](const TravelDest& d) { return "Ride to " + stripSuffix(d.name, {" Giant Slalom", " Slalom", " Super-G", " Downhill"}); };
  return T;
}

void TrailMap::openTravel(Travel t) {
  Impl& M = *m_;
  M.tv = std::move(t);
  M.tvOpen = !M.tv.dests.empty();
  M.tvFi = std::clamp(M.tv.focus, 0, std::max(0, int(M.tv.dests.size()) - 1));
  M.tvScroll = 0;
  M.tvOpenT = M.now;
  M.opened = false;   // (the trail map opens on you again afterwards)
  open_ = false;
}
bool TrailMap::travelOpen() const { return m_->tvOpen; }
void TrailMap::closeTravel() { m_->tvOpen = false; }
std::string TrailMap::travelFocused() const { const Impl& M = *m_; return M.tvOpen && M.tvFi < int(M.tv.dests.size()) ? M.tv.dests[size_t(M.tvFi)].name : std::string(); }
bool TrailMap::travelFocus(const std::string& name) {
  Impl& M = *m_;
  for (size_t i = 0; i < M.tv.dests.size(); i++) if (M.tv.dests[i].name == name) { M.tvFi = int(i); return true; }
  return false;
}
void TrailMap::travelChoose() {
  Impl& M = *m_;
  if (!M.tvOpen || M.tvFi < 0 || M.tvFi >= int(M.tv.dests.size())) return;
  TravelDest d = M.tv.dests[size_t(M.tvFi)];
  if (d.disabled) return;
  M.tvOpen = false;
  if (d.act) d.act();
}

bool TrailMap::frameTravel(Ui& ui, const UiNav& nav, const Input& in, double dt, const dvec3& you, double heading) {
  Impl& M = *m_;
  if (!M.tvOpen) return false;
  M.ui = &ui;
  M.now += dt;
  const float d = ui.dpr(), u = ui.cssU();
  M.d = d; M.u = u;
  const float SW = float(ui.width()), SH = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u), tMd = std::max(13 * d, 15 * u);
  Travel& T = M.tv;
  const int n = int(T.dests.size());
  // ---- layout (travel.css #travel)
  const float padT = 28 * u, padX = 56 * u, padB = 24 * u, gap = 14 * u, headH = 90 * u, hintH = ui.kcHeight(u);
  const float by = padT + headH + gap, bh = std::max(40 * u, SH - by - gap - hintH - padB);
  const float sideW = std::min(360 * u, (SW - 2 * padX) * 0.46f), mx = padX, my = by, mw = SW - 2 * padX - sideW - 26 * u, mh = bh;
  const float cxp = mx + 14 * u, cyp = my + 14 * u, cw = mw - 28 * u, chh = mh - 28 * u;
  M.ox = cxp; M.oy = cyp; M.W = std::max(10.f, cw / d); M.H = std::max(10.f, chh / d);
  M.tvFit();
  // the side panel: the list's rows (each as tall as its text), the plan, the ride button, cancel
  const float sx = mx + mw + 26 * u, sy = by, inX = sx + 24 * u, inW = sideW - 48 * u;
  auto wrap = [&](const std::string& s, float fs, UiFont f, float maxW, float tracking) {
    std::vector<std::string> out;
    std::string lineS, word;
    for (size_t i = 0; i <= s.size(); i++) {
      char ch = i < s.size() ? s[i] : ' ';
      if (ch != ' ') { word += ch; continue; }
      if (word.empty()) continue;
      std::string cand = lineS.empty() ? word : lineS + " " + word;
      if (!lineS.empty() && ui.textWidth(cand, fs, f, tracking) > maxW) { out.push_back(lineS); lineS = word; } else lineS = cand;
      word.clear();
    }
    if (!lineS.empty()) out.push_back(lineS);
    return out;
  };
  struct Row { float y, h, prW; std::vector<std::string> meta; std::string pr; bool tag; };
  std::vector<Row> rows(static_cast<size_t>(n));
  const float dotW = std::max(9 * d, 14 * u), nameFs = 23 * u, rowW = inW + 16 * u - 16 * u;
  float listH = 0;
  for (int i = 0; i < n; i++) {
    const TravelDest& q = T.dests[size_t(i)];
    Row& r = rows[size_t(i)];
    r.tag = !q.tag.empty();
    r.pr = r.tag ? q.tag : q.price >= 0 ? "$" + std::to_string(q.price) : std::string();
    r.prW = r.pr.empty() ? 0 : r.tag ? ui.textWidth(r.pr, 16 * u, UiFont::CondItalic, 0.08f) + 20 * u : ui.textWidth(r.pr, 24 * u, UiFont::CondItalic, 0.02f);
    float textW = rowW - 12 * u - dotW - 12 * u - (r.prW > 0 ? r.prW + 12 * u : 0) - 14 * u;
    if (!q.meta.empty()) r.meta = wrap(q.meta, tXs, UiFont::BodySemi, textW, 0.04f);
    r.h = 10 * u + nameFs * 1.05f + (r.meta.empty() ? 0 : 3 * u + float(r.meta.size()) * tXs * 1.25f) + 11 * u;
    r.y = listH;
    listH += r.h + (i + 1 < n ? 6 * u : 0);
  }
  const TravelDest* cur = M.tvFi >= 0 && M.tvFi < n ? &T.dests[size_t(M.tvFi)] : nullptr;
  float planH = 0;
  if (cur && !cur->plan.empty()) planH = 14 * u + 2 * d + 14 * u + 34 * u + 12 * u + tXs + 5 * u + 28 * u;
  const float goH = 64 * u, cancelH = std::max(ui.kcHeight(u), tXs) + 8 * u;
  const float fixedH = 18 * u + tXs + 10 * u + planH + 16 * u + goH + 12 * u + cancelH + 22 * u;
  const float listVis = std::min(listH + 4 * u, std::max(60 * u, bh - fixedH)), sideH = fixedH + listVis;
  const float listY = sy + 18 * u + tXs + 10 * u;
  const float maxScroll = std::max(0.f, listH + 4 * u - listVis);
  const float goY = listY + listVis + planH + 16 * u, goX = inX - 4 * u, goW = inW + 10 * u;
  const float cancelY = goY + goH + 12 * u;
  std::string cancelCap = prompts::K(in, "cancel");
  const float cancelW = ui.kcWidth(u, cancelCap) + 8 * u + ui.textWidth("CANCEL", tXs, UiFont::BodyHeavy, 0.14f);
  auto inRect = [&](vec2 p, float x, float y, float w, float h) { return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h; };
  const bool mouseOk = nav.mouse.x >= 0 && !nav.usingPad;

  // ---- input (travel.js key(): the arrows / W A S D / Tab move, Enter / Space ride, 1-9 pick, Esc cancels)
  auto cancel = [&]() { M.tvOpen = false; auto f = T.onCancel; if (f) f(); };
  if (nav.cancel || nav.menu) { cancel(); return false; }
  bool moved = false;
  int step = (nav.down || nav.right || nav.tabNext ? 1 : 0) - (nav.up || nav.left || nav.tabPrev ? 1 : 0);
  for (platform::Key k : nav.keys) {
    if (k == platform::Key::BracketRight || k == platform::Key::Tab) step = 1;
    else if (k == platform::Key::BracketLeft) step = -1;
    else if (int(k) >= int(platform::Key::Digit1) && int(k) <= int(platform::Key::Digit9)) {
      int i = int(k) - int(platform::Key::Digit1);
      if (i < n) { M.tvFi = i; travelChoose(); return M.tvOpen; }
    }
  }
  if (step && n) { M.tvFi = ((M.tvFi + step) % n + n) % n; moved = true; }
  if (nav.wheel != 0 && mouseOk && inRect(nav.mouse, sx, listY, sideW, listVis)) M.tvScroll = std::clamp(M.tvScroll - nav.wheel * 40 * u, 0.f, maxScroll);
  if (std::fabs(nav.stickR.y) > 0.2f) M.tvScroll = std::clamp(M.tvScroll + nav.stickR.y * float(dt) * 700 * u, 0.f, maxScroll);
  int overRow = -1;
  bool overGo = mouseOk && inRect(nav.mouse, goX, goY, goW, goH), overCancel = mouseOk && inRect(nav.mouse, inX, cancelY, cancelW, cancelH);
  if (mouseOk && inRect(nav.mouse, sx, listY, sideW, listVis))
    for (int i = 0; i < n; i++) { float ry = listY + 2 * u + rows[size_t(i)].y - M.tvScroll; if (nav.mouse.y >= ry && nav.mouse.y <= ry + rows[size_t(i)].h) overRow = i; }
  int overSpot = -1;
  if (mouseOk && inRect(nav.mouse, cxp, cyp, cw, chh)) {
    float px = (nav.mouse.x - cxp) / d, py = (nav.mouse.y - cyp) / d, bd = 1e9f;
    for (const auto& s : M.tvSpots) { float dd = std::hypot(s.x - px, s.y - py) - s.r; if (dd < 6 && dd < bd) { bd = dd; overSpot = s.i; } }
  }
  if (nav.mouseMoved || nav.click) { if (overRow >= 0) M.tvFi = overRow; else if (overSpot >= 0) M.tvFi = overSpot; }
  if (nav.click && mouseOk) {
    if (overCancel) { cancel(); return false; }
    if (overRow >= 0 || overSpot >= 0 || overGo) { travelChoose(); if (!M.tvOpen) return false; }
  }
  if (nav.confirm) { travelChoose(); if (!M.tvOpen) return false; }
  if (moved && M.tvFi < n) {   // (scrollIntoView: nearest)
    const Row& r = rows[size_t(M.tvFi)];
    if (r.y < M.tvScroll) M.tvScroll = r.y;
    else if (r.y + r.h > M.tvScroll + listVis - 4 * u) M.tvScroll = r.y + r.h - listVis + 4 * u;
  }
  M.tvScroll = std::clamp(M.tvScroll, 0.f, maxScroll);
  cur = M.tvFi >= 0 && M.tvFi < n ? &T.dests[size_t(M.tvFi)] : nullptr;
  M.mk = Live();
  M.buildTiles();

  // ---- draw: the dimmed game, the head
  const float fade = float(std::clamp((M.now - M.tvOpenT) / 0.25, 0.0, 1.0));
  M.drawn = 0;
  ui.pushAlpha(fade);
  ui.rectGradient(0, 0, SW * 0.6f, SH, hex(0x040e22, 0.84f), hex(0x040e22, 0.64f));
  ui.rectGradient(SW * 0.6f, 0, SW * 0.4f, SH, hex(0x040e22, 0.64f), hex(0x040e22, 0.52f));
  {
    std::string title = upper(T.title);
    int seed = 17;
    for (char c : title) seed = (seed * 31 + static_cast<unsigned char>(c)) % 9973;
    float vw = std::max(240.f, std::round(float(utf8Decode(title).size()) * 25 + 120)), tw = std::round(vw * 0.92f) * u;
    Ui::Shadow sh{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
    ui.brushStroke(padX, padT, tw, headH, white, seed, vw, 100, &sh);
    ui.textLH(padX + 40 * u, padT, headH, 44 * u, UiFont::CondItalic, blue, title, UiAlign::Left, 0.04f);
    // the kicker over the line "From <b>stop</b> · pick your stop"
    float x = padX + tw + 24 * u, lh = tMd * 1.35f, blockH = (T.kicker.empty() ? 0 : tXs + 8 * u) + lh, y = padT + (headH - blockH) / 2;
    const vec4 shc = hex(0x000a1e, 0.6f), col = a(white, 0.92f);
    if (!T.kicker.empty()) {
      ui.rect(x, y + tXs / 2 - 2 * u, 22 * u, 4 * u, red);
      ui.textShadow(x + 32 * u, y + (tXs - ui.lineHeight(tXs, UiFont::BodyHeavy)) / 2, tXs, UiFont::BodyHeavy, T.kicker, UiAlign::Left, 0.22f, 0, d, 6 * d, shc);
      ui.textLH(x + 32 * u, y, tXs, tXs, UiFont::BodyHeavy, white, T.kicker, UiAlign::Left, 0.22f);
      y += tXs + 8 * u;
    }
    auto part = [&](const std::string& s, bool bold) {
      if (s.empty()) return;
      if (!bold) {
        ui.textShadow(x, y + (lh - ui.lineHeight(tMd, UiFont::BodySemi)) / 2, tMd, UiFont::BodySemi, s, UiAlign::Left, 0.02f, 0, d, 8 * d, shc);
        x += ui.textLH(x, y, lh, tMd, UiFont::BodySemi, col, s, UiAlign::Left, 0.02f);
      } else {
        float fs = 22 * u, base = y + lh / 2 + (ui.ascent(UiFont::BodySemi) + ui.descent(UiFont::BodySemi)) / 2 * tMd;
        float yt = base - (ui.ascent(UiFont::CondItalic) + ui.descent(UiFont::CondItalic)) / 2 * fs - ui.lineHeight(fs, UiFont::CondItalic) / 2;
        ui.textShadow(x, yt, fs, UiFont::CondItalic, s, UiAlign::Left, 0.02f, 0, d, 8 * d, shc);
        x += ui.text(x, yt, fs, UiFont::CondItalic, col, s, UiAlign::Left, 0.02f);
      }
    };
    part(T.subPre, false); part(T.subBold, true); part(T.subPost, false);
  }
  // ---- the map sheet
  {
    Ui::Shadow sh{0, 12 * u, 26 * u, hex(0x000e2c, 0.38f)};
    ui.brushClip(mx, my, mw, mh, white, 181, 3, 4, u, &sh);
  }
  ui.pushClip(cxp, cyp, cw, chh);
  ui.rect(cxp, cyp, cw, chh, hex(0xeef2fa));
  M.tvDrawMap(you, heading);
  ui.popClip();
  M.placeLabels();
  ui.roundRectStroke(cxp - 3 * u, cyp - 3 * u, cw + 6 * u, chh + 6 * u, 7 * u, 3 * u, white);
  M.drawScale(mx, my, mh);
  // ---- the side panel
  {
    Ui::Shadow sh{0, 10 * u, 24 * u, hex(0x000e2c, 0.3f)};
    ui.brushClip(sx, sy, sideW, sideH, a(white, 0.95f), 183, 5, 4, u, &sh);
    std::string head = !T.listHead.empty() ? T.listHead : "WHERE TO?";
    ui.textLH(inX, sy + 18 * u, tXs, tXs, UiFont::BodyHeavy, red, head, UiAlign::Left, 0.18f);
    ui.pushClip(sx, listY, sideW + 12 * u, listVis);
    for (int i = 0; i < n; i++) {
      const TravelDest& q = T.dests[size_t(i)];
      const Row& r = rows[size_t(i)];
      bool sel = i == M.tvFi, hv = overRow == i && !sel;
      float rx = inX - 8 * u + 8 * u + (sel ? 8 * u : 0), ry = listY + 2 * u + r.y - M.tvScroll;
      if (ry + r.h < listY || ry > listY + listVis) continue;
      if (sel) ui.rect(rx - 10 * u, ry + r.h * 0.22f, 5 * u, r.h * 0.56f, red);
      ui.brushPanel(rx, ry, rowW, r.h, sel ? blue : hv ? bluePale : ice, 1);
      // the dot (a race: a pin in its colour)
      float dx = rx + 12 * u, cy = ry + r.h / 2;
      if (q.color) {
        uint32_t c = q.color == 0x141414 ? 0x161616 : q.color;
        float rr = dotW / 2, ring = std::max(1.5f * d, 2 * u);
        vec2 ctr(dx + rr, cy - rr * 0.2f);
        auto pin = [&](float k, const vec4& colr) {
          std::vector<vec2> pts;
          for (int a2 = 0; a2 <= 16; a2++) { float t = PIf * (0.75f + 1.5f * float(a2) / 16) + PIf / 2; pts.push_back(ctr + vec2(std::cos(t), std::sin(t)) * (rr * k)); }
          pts.push_back(ctr + vec2(0, rr * 1.41f * k + (k > 1 ? ring * 0.4f : 0)));
          ui.circle(ctr.x, ctr.y, rr * k, colr);
          ui.polyAA(pts, colr);
        };
        pin(1 + ring / rr, white);
        pin(1, hex(c));
      } else if (sel) { ui.circle(dx + dotW / 2, cy, dotW / 2 + std::max(2 * d, 2 * u), white); ui.circle(dx + dotW / 2, cy, dotW / 2, red); }
      else { ui.circle(dx + dotW / 2, cy, dotW / 2, blue); ui.circle(dx + dotW / 2, cy, dotW / 2 - std::max(2 * d, 3 * u), white); }
      float tx = dx + dotW + 12 * u, textW = rowW - 12 * u - dotW - 12 * u - (r.prW > 0 ? r.prW + 12 * u : 0) - 14 * u;
      float ty = ry + 10 * u;
      ui.pushClip(tx, ry, textW, r.h);
      ui.textLH(tx, ty, nameFs * 1.05f, nameFs, UiFont::CondItalic, sel ? white : blue, q.name, UiAlign::Left, 0.02f);
      ui.popClip();
      ty += nameFs * 1.05f + 3 * u;
      for (const std::string& ml : r.meta) { ui.textLH(tx, ty, tXs * 1.25f, tXs, UiFont::BodySemi, sel ? a(white, 0.85f) : blueDim, ml, UiAlign::Left, 0.04f); ty += tXs * 1.25f; }
      if (!r.pr.empty()) {
        float px = rx + rowW - 14 * u - r.prW;
        if (r.tag) {
          bool fr = r.pr.find("FREE") != std::string::npos || r.pr.find("Free") != std::string::npos;
          float chH = 16 * u + 8 * u;
          ui.brushPanel(px, cy - chH / 2, r.prW, chH, sel ? white : fr ? ok : blue, 1);
          ui.textLH(px + 10 * u, cy - chH / 2, chH, 16 * u, UiFont::CondItalic, sel ? (fr ? ok : blue) : white, r.pr, UiAlign::Left, 0.08f);
        } else ui.textLH(px, ry, r.h, 24 * u, UiFont::CondItalic, q.shortMoney ? (sel ? hex(0xffd0cb) : ko) : sel ? white : blue, r.pr, UiAlign::Left, 0.02f);
      }
    }
    ui.popClip();
    if (maxScroll > 0) {
      float th = std::max(24 * d, listVis * listVis / (listH + 4 * u)), ty = listY + (listVis - th) * (M.tvScroll / maxScroll);
      ui.roundRect(sx + sideW - 12 * u, ty, 4 * d, th, 2 * d, hex(0x1546c8, 0.45f));
    }
    // the plan card (.tv-plan)
    if (cur && planH > 0) {
      float py = listY + listVis + 14 * u;
      ui.rect(inX, py, inW, 2 * d, hex(0x1546c8, 0.12f));
      py += 2 * d + 14 * u;
      ui.textLH(inX, py, 34 * u, 34 * u, UiFont::CondItalic, cur->planColor ? hex(cur->planColor == 0x141414 ? 0x161616 : cur->planColor) : blue, upper(cur->planName), UiAlign::Left, 0.02f);
      py += 34 * u + 12 * u;
      float cwid = (inW - 16 * u) / 3;
      for (size_t k = 0; k < cur->plan.size() && k < 3; k++) {
        float cx = inX + float(k) * (cwid + 8 * u);
        ui.textLH(cx, py, tXs, tXs, UiFont::BodyHeavy, blueDim, cur->plan[k].k, UiAlign::Left, 0.14f);
        float vw = ui.textFit(cx, py + tXs + 5 * u - (ui.lineHeight(28 * u, UiFont::CondItalic) - 28 * u) / 2, cwid - (cur->plan[k].unit.empty() ? 0 : 22 * u), 28 * u, UiFont::CondItalic, blue, cur->plan[k].v);
        if (!cur->plan[k].unit.empty()) {
          float us = 28 * u * 0.55f, base = py + tXs + 5 * u + 28 * u * 0.5f + (ui.ascent(UiFont::CondItalic) + ui.descent(UiFont::CondItalic)) / 2 * 28 * u;
          ui.text(cx + vw + 28 * u * 0.15f, base - (ui.ascent(UiFont::CondItalic) + ui.descent(UiFont::CondItalic)) / 2 * us - ui.lineHeight(us, UiFont::CondItalic) / 2 - us * 0.0f, us, UiFont::CondItalic, blueDim, cur->plan[k].unit);
        }
      }
    }
    // the ride button (.tv-go): a red brush, the label fitted (long labels smaller), the confirm key
    if (cur) {
      std::string gl = upper(T.goLabel ? T.goLabel(*cur) : T.go + " \xC2\xB7 " + cur->name);
      bool off = cur->disabled, lng = utf8Decode(gl).size() > 17;
      float gx = goX + (overGo && !off ? 6 * u : 0), fs = (lng ? 21 : 26) * u, tr = lng ? 0.04f : 0.05f;
      ui.brushPanel(gx, goY, goW, goH, off ? hex(0x9aa9cf) : red, 1);
      ui.textFit(gx + 24 * u, goY + (goH - ui.lineHeight(fs, UiFont::CondItalic)) / 2, goW - 24 * u - 30 * u, fs, UiFont::CondItalic, a(white, off ? 0.85f : 1.f), gl, UiAlign::Left, tr);
    }
    {
      const vec4 c = overCancel ? blue : blueDim;
      float kx = inX + ui.kc(inX, cancelY + (cancelH - ui.kcHeight(u)) / 2, u, cancelCap, c, vec4(0), hex(0x1546c8, 0.35f)) + 8 * u;
      ui.textLH(kx, cancelY, cancelH, tXs, UiFont::BodyHeavy, c, "CANCEL", UiAlign::Left, 0.14f);
    }
  }
  // ---- the hints (.tv-hints)
  {
    const vec4 col = a(white, 0.88f), bc = a(white, 0.7f), shc = a(hex(0x000000), 0.5f);
    float x = padX, y = by + bh + gap, hgap = std::max(4 * d, 6 * u);
    auto hint = [&](const std::vector<std::string>& caps, const std::string& labelS) {
      for (size_t i = 0; i < caps.size(); i++) x += ui.kc(x, y, u, caps[i], col, vec4(0), bc) + (i + 1 < caps.size() ? 4 * u : hgap);
      float ty = y + (hintH - ui.lineHeight(tXs, UiFont::BodySemi)) / 2;
      ui.textShadow(x, ty, tXs, UiFont::BodySemi, labelS, UiAlign::Left, 0.1f, 0, d, 6 * d, shc);
      x += ui.text(x, ty, tXs, UiFont::BodySemi, col, labelS, UiAlign::Left, 0.1f) + 22 * u;
    };
    if (nav.usingPad) hint({prompts::K(in, "updown")}, "CHOOSE"); else hint({"\xE2\x86\x91", "\xE2\x86\x93"}, "CHOOSE");
    hint({prompts::K(in, "confirm")}, T.go == "FLY" ? "FLY" : "RIDE");
    if (!nav.usingPad) hint({"CLICK"}, "A STOP ON THE MAP");
    hint({prompts::K(in, "cancel")}, "CANCEL");
  }
  ui.popAlpha();
  (void)tSm;
  return true;
}

} // namespace sl
