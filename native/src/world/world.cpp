#include "world/world.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"

#include <nlohmann/json.hpp>
#include <array>
#include <cstring>
#include <limits>

namespace sl {

static inline int64_t cellKey(int64_t cx, int64_t cz) { return (cx << 32) ^ (cz & 0xffffffffLL); }
static inline int fl(double v) { return int(std::floor(v)); }

static const double MAIN_SUMMIT_X = 0, MAIN_SUMMIT_Z = -2350;
static const double CROWN_X = 10, CROWN_Z = -2120;   // world.js CROWN_CLEAR
static const double Q_CUT = 4.6;

static inline double valleyCenter(double z) {
  return (280 * std::sin(z / 2600) + 120 * std::sin(z / 900)) * smoothstep(0, 1500, z);
}
static inline double descent(double z) {
  double t = z - 200;
  return t > 0 ? -0.17 * t * smoothstep(0, 450, t) : 0;
}
// noise octaves a band-limited sample can represent (spacing > 0: a coarse LOD mesh drops finer octaves)
static inline double oct(double lambda, double full, double spacing) {
  return spacing > 0 ? std::min(full, std::max(0.0, std::log2(lambda / (4 * spacing)) + 1)) : full;
}
static inline double smax(double a, double b, double k) {
  if (k <= 0) return std::max(a, b);
  double d = std::fabs(a - b);
  return std::max(a, b) + (d < k ? (k - d) * (k - d) / (4 * k) : 0);
}
static inline double smin(double a, double b, double k) {
  double d = std::fabs(a - b);
  return std::min(a, b) - (d < k ? (k - d) * (k - d) / (4 * k) : 0);
}

// ====================================================================== Wolkenspitze (wolkenspitze.js)
namespace ws {
const double SUMMIT_X = 4120, SUMMIT_Z = -3260, SUMMIT_H = 2520;
const double FOOT = 300;
const double BX = 3450, BZ = -3450, BA = 2150, BB = 1800, BROT = -0.25, BH = 1420;
const double PX = 3500, PZ = -3800, PA = 900, PB = 560, PROT = -0.75, HLIP = 1360, HBACK = 1680;
const double T_FLOOR = 70, T_WALL = 1.25, T_REACH = 760, TCELL = 256;
const double BOX[4] = {BX - 4300, BZ - 4300, BX + 4300, BZ + 4300};
static double BC() { static const double v = std::cos(BROT); return v; }
static double BS() { static const double v = std::sin(BROT); return v; }
static double PC() { static const double v = std::cos(PROT); return v; }
static double PS() { static const double v = std::sin(PROT); return v; }
static double glacierSurface(double x, double z) {
  double u = (x - PX) * PC() + (z - PZ) * PS(), v = -(x - PX) * PS() + (z - PZ) * PC();
  double t = clamp((u + PA) / (2 * PA), -0.15, 1.15);
  return lerp(HLIP, HBACK, t) + std::fabs(v) * 0.08;
}
struct Keep { double ax, az, bx, bz, r0, r1; };
static const Keep KEEP[2] = {{10, -2240, 0, 60, 1185, 1450}, {2406, -590, 30, 34, 1000, 1250}};
static double protect(double x, double z) {
  double k = 1;
  for (const auto& s : KEEP) {
    double ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez;
    double t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
    double d = std::hypot(s.ax + ex * t - x, s.az + ez * t - z);
    k = std::min(k, smoothstep(s.r0, s.r1, d));
  }
  return k;
}
} // namespace ws

struct World::Trough {
  struct Seg { double ax, az, ay, bx, bz, by, l, s0; };
  std::vector<Seg> segs;
  std::unordered_map<int64_t, std::vector<int>> grid;
  bool at(double x, double z, double& d, double& s, double& y) const {
    auto it = grid.find(int64_t(std::floor(x / ws::TCELL)) * 4096 + int64_t(std::floor(z / ws::TCELL)));
    if (it == grid.end()) return false;
    double best = std::numeric_limits<double>::infinity(), bs = 0, by = 0;
    for (int i : it->second) {
      const Seg& g = segs[i];
      double ex = g.bx - g.ax, ez = g.bz - g.az;
      double t = clamp(((x - g.ax) * ex + (z - g.az) * ez) / (g.l * g.l), 0, 1);
      double dd = std::hypot(g.ax + ex * t - x, g.az + ez * t - z);
      if (dd < best) { best = dd; bs = g.s0 + t * g.l; by = g.ay + (g.by - g.ay) * t; }
    }
    d = best; s = bs; y = by;
    return true;
  }
};

double World::wolkenspitzeHeight(double x, double z, double h0, double spacing) const {
  using namespace ws;
  // wolkenspitze(x, z, spacing)
  if (x < BOX[0] || z < BOX[1] || x > BOX[2] || z > BOX[3]) return h0;
  double u = (x - BX) * BC() + (z - BZ) * BS(), v = -(x - BX) * BS() + (z - BZ) * BC();
  double q = (u * u) / (BA * BA) + (v * v) / (BB * BB);
  if (q > 4.4) return h0;
  double keep = protect(x, z);
  if (keep <= 0) return h0;
  static const Simplex WN(4417), WN2(4423);
  q *= 1 + 0.2 * WN.noise(x * 0.0006 + 1.1, z * 0.0006 - 4.4) + 0.07 * WN.noise(x * 0.0019 - 3.3, z * 0.0019 + 0.6);
  if (q > 3.2) return h0;
  double dome = std::exp(-q * 1.15);
  double wx = x + WN2.fbm(x * 0.0007, z * 0.0007, 3) * 380, wz = z + WN2.fbm(x * 0.0007 + 31.7, z * 0.0007 - 12.3, 3) * 380;
  double rid = WN.ridged(wx * 0.00055 + 5.3, wz * 0.00055 - 3.7, std::max(1.0, oct(1800, 4, spacing)), 2.0, 0.4, 4);
  double M = std::pow(rid, 1.4);
  double h = FOOT + dome * (BH - FOOT - 380 + M * 1050) + (1 - dome) * M * 160;
  {
    double hx = x - SUMMIT_X, hz = z - SUMMIT_Z, r = std::hypot(hx, hz);
    if (r < 1700) {
      double ex = hx + WN.noise(x * 0.002, z * 0.002) * 60, ez = hz + WN.noise(x * 0.002 + 9.1, z * 0.002 - 3.3) * 60;
      double fd = std::max(std::max(-ex * 0.105 + ez * 0.995, -ex * 0.995 - ez * 0.105 * 1.1),
                           std::max(ex * 0.105 - ez * 0.995, ex * 0.995 * 0.92 + ez * 0.105));
      double hd = std::max(0.0, fd);
      double rough = WN2.ridged(x * 0.006 + 2.2, z * 0.006 - 7.7, std::max(1.0, oct(170, 3, spacing)), 2.0, 0.5, 3);
      double horn = SUMMIT_H - hd * (1.45 - 0.5 * smoothstep(0, 1100, hd)) - (rough - 0.4) * 60 * smoothstep(40, 300, hd);
      horn -= smoothstep(700, 1650, r) * 900;
      h = smax(h, horn, 90);
    }
  }
  double glacier = 0;
  double pu = (x - PX) * PC() + (z - PZ) * PS(), pv = -(x - PX) * PS() + (z - PZ) * PC();
  double pr = std::hypot(pu, pv);
  if (pr == 0) pr = 1;
  double pd = std::hypot(pu / PA, pv / PB);
  pd *= 1 + 0.08 * WN.noise(pu / pr * 1.8 + 5.5, pv / pr * 1.8 - 1.1) + 0.04 * WN.noise(x * 0.003, z * 0.003);
  double surf = glacierSurface(x, z) + WN2.fbm(x * 0.0019 + 3.3, z * 0.0019 - 1.9, std::max(1.0, oct(520, 3, spacing))) * 12;
  if (pd < 1.9) {
    double lip = smoothstep(0.55, 0.92, -pu / pr);
    double crest = surf + smoothstep(0.84, 1.12, pd) * (150 + M * 420);
    double ring = (1 - smoothstep(1.35, 1.85, pd)) * (1 - lip);
    h = std::max(h, lerp(h, crest, ring));
    double inside = 1 - smoothstep(0.84, 1.0, pd);
    h = lerp(h, surf, inside);
    if (lip > 0 && pd > 0.95) {
      double beyond = std::max(0.0, (pd - 1) * std::hypot(PA * pu / pr, PB * pv / pr));
      h = lerp(h, std::min(h, surf - beyond * 1.7), lip * (1 - smoothstep(1.45, 1.9, pd)));
    }
    glacier = inside;
  }
  if (trough_) {
    double td, ts, ty;
    if (trough_->at(x, z, td, ts, ty) && td < T_REACH) {
      double floor = ty + WN2.noise(ts * 0.004 + 2.2, 1.7) * 6 * smoothstep(20, 70, td);
      double out = std::max(0.0, td - T_FLOOR);
      double wall = floor + out * T_WALL * (1 + 0.25 * WN.noise(x * 0.004, z * 0.004)) + out * out * 0.0004;
      double k = 1 - smoothstep(T_REACH - 220, T_REACH, td);
      h = lerp(h, -smax(-h, -wall, 40), k);
      if (td < T_FLOOR + 30) h = lerp(h, floor + out * T_WALL, 1 - smoothstep(T_FLOOR - 10, T_FLOOR + 30, td));
    }
  }
  double upper = smoothstep(0.15, 0.7, dome);
  h += WN2.fbm(x * 0.0035 + 2.1, z * 0.0035 - 9.4, oct(285, 3, spacing), 2, 0.5, 3) * 14 * (1 - upper) * (1 - glacier);
  if (spacing < 10) h += (WN2.noise(x * 0.025, z * 0.025) * 0.9 + WN2.noise(x * 0.09, z * 0.09) * 0.18) * (1 - 0.7 * glacier);
  double calm = smoothstep(0.06, 0.3, dome);
  // wolkenspitzeHeight blend
  double kw = 160, dw = std::fabs(h0 - h);
  double top = std::max(h0, h) + (dw < kw ? (kw - dw) * (kw - dw) / (4 * kw) : 0);
  return lerp(h0, lerp(top, h, calm), keep);
}

// ====================================================================== Legacy Peak (legacypeak.js)
struct World::Peak {
  static constexpr double SX = 200, SZ = -4600, SH = 2755, H_J = 1160, W = 250, FLOOR = 500;
  static constexpr double R0 = 110, R_FACE = 1000, P_FACE = 2.6, S_TAU = 40;
  static constexpr double MINX = -1300, MAXX = 2000, MINZ = -6000, MAXZ = -2270;
  struct Seg { double ax, az, ex, ez, l, s0; };
  std::vector<Seg> segs;
  double len = 0, G = 0;
  Simplex N{5113}, N2{5119};
  Peak() {
    std::vector<std::array<double, 2>> p = {{200, -4600}, {600, -4420}, {800, -4000}, {790, -3500}, {620, -3060}, {380, -2730}, {130, -2450}};
    for (int k = 0; k < 2; k++) { // chaikin(SPINE_CTRL, 2)
      std::vector<std::array<double, 2>> o{p[0]};
      for (size_t i = 0; i + 1 < p.size(); i++) {
        auto [ax, az] = p[i]; auto [bx, bz] = p[i + 1];
        o.push_back({ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25});
        o.push_back({ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75});
      }
      o.push_back(p.back());
      p = o;
    }
    for (size_t i = 1; i < p.size(); i++) {
      double ax = p[i - 1][0], az = p[i - 1][1], bx = p[i][0], bz = p[i][1], l = std::hypot(bx - ax, bz - az);
      segs.push_back({ax, az, bx - ax, bz - az, l, len});
      len += l;
    }
    G = (SH - H_J) / prof(len);
  }
  static double prof(double s) { return std::sqrt(s * s + R0 * R0) - R0; }
  static double softplus(double x, double k) { return x > 8 * k ? x : k * std::log1p(std::exp(x / k)); }
  static double keep(double x, double z) {
    double w = smoothstep(-2270, -2470, z) * smoothstep(-1300, -950, x) * smoothstep(-6000, -5650, z) * (1 - smoothstep(1300, 2000, x));
    if (w <= 0) return 0;
    w *= smoothstep(150, 320, std::hypot(x + 460, z + 2290));
    w *= smoothstep(230, 600, std::hypot(x - 1550, z + 3930));
    return w;
  }
  void spineAt(double x, double z, double& dOut, double& sOut) const {
    double d2[64], ss[64];
    double bd = std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < segs.size(); i++) {
      const Seg& g = segs[i];
      double t = clamp(((x - g.ax) * g.ex + (z - g.az) * g.ez) / (g.l * g.l), 0, 1);
      double dx = g.ax + g.ex * t - x, dz = g.az + g.ez * t - z, d = dx * dx + dz * dz;
      d2[i] = d; ss[i] = g.s0 + t * g.l;
      if (d < bd) bd = d;
    }
    double dmin = std::sqrt(bd), cut = (dmin + 12 * S_TAU) * (dmin + 12 * S_TAU);
    double sw = 0, s = 0;
    for (size_t i = 0; i < segs.size(); i++) {
      if (d2[i] > cut) continue;
      double wgt = std::exp(-(std::sqrt(d2[i]) - dmin) / S_TAU);
      sw += wgt; s += wgt * ss[i];
    }
    dOut = dmin; sOut = s / sw;
  }
};

static double ridgedOf(const Simplex& n, double x, double z, double o, double lac, double gain, double full) { return n.ridged(x, z, o, lac, gain, full); }

double World::legacyPeakHeight(double x, double z, double h0, double spacing) const {
  const Peak& P = *peak_;
  if (x < Peak::MINX || x > Peak::MAXX || z < Peak::MINZ || z > Peak::MAXZ) return h0;
  double w = Peak::keep(x, z);
  if (w <= 0) return h0;
  double r = std::hypot(x - Peak::SX, z - Peak::SZ);
  double cone = smin(Peak::SH - P.G * Peak::prof(r), Peak::FLOOR + (Peak::SH - Peak::FLOOR) * std::exp(-std::pow(r / Peak::R_FACE, Peak::P_FACE)), 60);
  double d, s;
  P.spineAt(x, z, d, s);
  double onSpur = 1 - smoothstep(Peak::W, Peak::W + 220, d);
  double rock = smoothstep(300, 650, r) * (1 - onSpur);
  if (rock > 0) cone += (ridgedOf(P.N, x * 0.0016 + 3.1, z * 0.0016 - 7.3, std::max(1.0, oct(620, 4, spacing)), 2.0, 0.45, 4) - 0.45) * 160 * rock;
  double yS = Peak::SH - P.G * Peak::prof(s);
  double e = Peak::softplus(d - Peak::W, 80);
  double spur = yS - 0.1 * std::min(d, Peak::W) - (yS - Peak::FLOOR) * (1 - std::exp(-std::pow(e / 600, 1.6)));
  double h = smax(cone, spur, 50 * smoothstep(150, 400, r));
  double quiet = smoothstep(60, 220, r);
  h += P.N2.fbm(x * 0.004 + 1.3, z * 0.004 - 2.2, oct(250, 3, spacing), 2, 0.5, 3) * 7 * quiet;
  if (spacing < 10) h += (P.N2.noise(x * 0.025, z * 0.025) * 0.8 + P.N2.noise(x * 0.09, z * 0.09) * 0.15) * quiet;
  double calm = std::max(onSpur, 1 - smoothstep(300, 560, r));
  double top = smax(h0, h, 80);
  return lerp(h0, lerp(top, h, calm), w);
}

// ====================================================================== World
World::World() : N_(SEED), N2_(SEED + 101), peak_(std::make_unique<Peak>()), vcache_(1 << 16, VCache{INT64_MIN, 0}) {
  // MASSIFS (world.js), with the derived fields of its set-up loop
  struct Def { const char* id; const char* name; double bx, bz, tx, tz, h, rf, rb, rl, rr, hb, hh, hr, crown, bowl, apron, foot; };
  static const Def defs[] = {
    {"adlerhorn", "Adlerhorn", 223.6, -17.0, 2290, -560, 760, 1700, 760, 820, 760, 380, 500, 440, 300, 430, 900, 0.42},
    {"silberhorn", "Silberhorn", -221.0, 64.6, -2300, -215, 820, 1600, 740, 760, 820, 360, 440, 420, 300, 420, 900, 0.42},
    {"sonnenkopf", "Sonnenkopf", 505, 1545, 2330, 2290, 760, 1700, 740, 820, 1000, 340, 420, 400, 270, 400, 0, 0.44},
  };
  for (const Def& d : defs) {
    Massif m{d.id, d.name, d.bx, d.bz, d.tx, d.tz, d.h, d.rf, d.rb, d.rl, d.rr, d.hb, d.hh, d.hr, d.crown, d.bowl, d.apron, d.foot};
    double dx = m.baseX - m.topX, dz = m.baseZ - m.topZ, l = std::hypot(dx, dz);
    m.fx = dx / l; m.fz = dz / l; m.faceLen = l;
    double crest = 0.3246 * m.rFace;
    m.x = m.topX - m.fx * crest; m.z = m.topZ - m.fz * crest;
    m.hx = m.x - m.fx * m.hornBack; m.hz = m.z - m.fz * m.hornBack;
    m.kFace = 1 / (m.rFace * m.rFace); m.kBack = 1 / (m.rBack * m.rBack); m.kLeft = 1 / (m.rLeft * m.rLeft); m.kRight = 1 / (m.rRight * m.rRight);
    m.kHorn = 1 / (m.hornR * m.hornR);
    m.seed = std::fmod(m.topX * 0.013 + m.topZ * 0.007, 97.0);
    m.stationSlope = 2 * m.h * crest * m.kFace * 0.9;
    massifs_.push_back(m);
  }
}
World::~World() = default;

bool World::load(platform::Platform& p, const AssetPaths& paths) {
  std::vector<uint8_t> bytes;
  if (!p.readFile(paths.data("world.json"), bytes)) { SL_WARN("world data missing: %s", paths.data("world.json").c_str()); return false; }
  nlohmann::json j = nlohmann::json::parse(bytes.begin(), bytes.end(), nullptr, false);
  if (j.is_discarded()) { SL_ERROR("world.json: parse error"); return false; }

  // Wolkenspitze trough (the railway's valley floor), bucketed like wolkenspitze.js
  trough_ = std::make_unique<Trough>();
  {
    auto& T = j["trough"];
    double acc = 0;
    for (size_t i = 1; i < T.size(); i++) {
      double ax = T[i - 1][0], az = T[i - 1][1], ay = T[i - 1][2], bx = T[i][0], bz = T[i][1], by = T[i][2];
      double l = std::hypot(bx - ax, bz - az);
      trough_->segs.push_back({ax, az, ay, bx, bz, by, l, acc});
      acc += l;
    }
    for (size_t gi = 0; gi < trough_->segs.size(); gi++) {
      const auto& g = trough_->segs[gi];
      double r = ws::T_REACH + g.l;
      for (int64_t cx = fl((std::min(g.ax, g.bx) - r) / ws::TCELL); cx <= fl((std::max(g.ax, g.bx) + r) / ws::TCELL); cx++)
        for (int64_t cz = fl((std::min(g.az, g.bz) - r) / ws::TCELL); cz <= fl((std::max(g.az, g.bz) + r) / ws::TCELL); cz++)
          trough_->grid[cx * 4096 + cz].push_back(int(gi));
    }
  }
  // pads (in the order they were added: a later pad blends over an earlier one)
  for (auto& a : j["pads"]) {
    Pad pd{a[0], a[1], a[2], a[3], a[4]};
    int id = int(pads_.size());
    pads_.push_back(pd);
    double R = pd.r + pd.blend;
    for (int cx = fl((pd.x - R) / 256); cx <= fl((pd.x + R) / 256); cx++)
      for (int cz = fl((pd.z - R) / 256); cz <= fl((pd.z + R) / 256); cz++) padGrid_[cellKey(cx, cz)].push_back(id);
  }
  for (auto& a : j["corridors"]) addCorridor({a[0], a[1], a[2], a[3], a[4], CorridorKind(a[5].get<int>())});
  // crag mask
  {
    auto& c = j["crag"];
    crag_.x0 = c["x0"]; crag_.z0 = c["z0"]; crag_.cell = c["cell"]; crag_.nx = c["nx"]; crag_.nz = c["nz"];
    std::vector<uint8_t> b;
    if (p.readFile(paths.data(c["file"].get<std::string>()), b) && b.size() >= size_t(crag_.nx) * crag_.nz * 2) {
      crag_.d.resize(size_t(crag_.nx) * crag_.nz);
      for (size_t i = 0; i < crag_.d.size(); i++) crag_.d[i] = float(uint16_t(b[i * 2] | (b[i * 2 + 1] << 8))) / 10.f;
    } else { crag_.nx = crag_.nz = 0; SL_WARN("crag mask missing"); }
  }
  // cuts
  {
    std::vector<uint8_t> b;
    if (p.readFile(paths.data(j["cuts"]["file"].get<std::string>()), b) && b.size() >= 16 && std::memcmp(b.data(), "SLCT", 4) == 0) {
      auto i32 = [&](size_t o) { int32_t v; std::memcpy(&v, b.data() + o, 4); return v; };
      cutCell_ = i32(4); cutTile_ = i32(8);
      int n = i32(12), S1 = cutTile_ + 1;
      size_t o = 16, tileBytes = 12 + size_t(S1) * S1 * 2;
      for (int t = 0; t < n && o + tileBytes <= b.size(); t++, o += tileBytes) {
        CutTile ct;
        int32_t tx = i32(o), tz = i32(o + 4);
        std::memcpy(&ct.scale, b.data() + o + 8, 4);
        ct.v.resize(size_t(S1) * S1);
        std::memcpy(ct.v.data(), b.data() + o + 12, ct.v.size() * 2);
        cuts_.emplace(cellKey(tx, tz), std::move(ct));
      }
    } else SL_WARN("terrain cuts missing");
  }
  // the gondola top station's shoulder height (lazy in world.js; computed once here, with the crag mask in place)
  shoulderLock_ = true;
  shoulderH_ = baseHeight(CROWN_X, CROWN_Z);
  shoulderLock_ = false;
  loaded_ = true;
  for (auto& v : vcache_) v.key = INT64_MIN;
  SL_INFO("world: %zu pads, %zu corridor segments, %zu cut tiles, crag %dx%d", pads_.size(), corridors_.size(), cuts_.size(), crag_.nx, crag_.nz);
  return true;
}

void World::addCorridor(const CorridorSeg& s) {
  int id = int(corridors_.size());
  corridors_.push_back(s);
  double minx = std::min(s.ax, s.bx) - s.w - 40, maxx = std::max(s.ax, s.bx) + s.w + 40;
  double minz = std::min(s.az, s.bz) - s.w - 40, maxz = std::max(s.az, s.bz) + s.w + 40;
  for (int cx = fl(minx / 64); cx <= fl(maxx / 64); cx++)
    for (int cz = fl(minz / 64); cz <= fl(maxz / 64); cz++) corridorGrid_[cellKey(cx, cz)].push_back(id);
}

double World::cragAllow(double x, double z) const {
  const Crag& m = crag_;
  if (m.nx == 0) return 1;
  double fx = (x - m.x0) / m.cell, fz = (z - m.z0) / m.cell;
  if (fx < 0 || fz < 0 || fx >= m.nx - 1 || fz >= m.nz - 1) return 1;
  int i = fl(fx), j = fl(fz);
  double tx = fx - i, tz = fz - j;
  size_t k = size_t(j) * m.nx + i;
  const float* D = m.d.data();
  double dd = (D[k] + (D[k + 1] - D[k]) * tx) * (1 - tz) + (D[k + m.nx] + (D[k + m.nx + 1] - D[k + m.nx]) * tx) * tz;
  return smoothstep(40, 55, dd);
}

double World::baseHeight(double x, double z, double spacing) const {
  const Simplex& N = N_;
  const Simplex& N2 = N2_;
  double d = std::sqrt(x * x + z * z);
  double zx = x / 900, zz = (z + 1250) / 1650;
  double inZone = 1 - smoothstep(0.65, 1.25, std::sqrt(zx * zx + zz * zz));
  double range = smoothstep(240, 1150, d);

  double wx = x + N2.fbm(x * 0.0004, z * 0.0004, 3) * 600;
  double wz = z + N2.fbm(x * 0.0004 + 31.7, z * 0.0004 - 12.3, 3) * 600;
  double rid = N.ridged(wx * 0.00019 + 11.3, wz * 0.00019 - 7.1, std::max(1.0, oct(5200, 6, spacing)), 2.0, 0.34, 6);
  double big = N.fbm(wx * 0.00021 - 3.3, wz * 0.00021 + 5.2, 3) * 0.5 + 0.5;
  double vcDist = std::fabs(x - valleyCenter(z)), vMouth = smoothstep(-150, 240, z);
  double valley = (1 - smoothstep(450, 1100, vcDist)) * smoothstep(40, 240, z);

  double mx = (x - MAIN_SUMMIT_X) * 1.15, mz = z - MAIN_SUMMIT_Z;
  double md2 = mx * mx + mz * mz;
  double mainG = std::exp(-md2 / (1500.0 * 1500.0));
  double protect = 1 - smoothstep(0.12, 0.3, mainG);

  const Massif* pk = nullptr;
  double pkH = 0, pkFade = 0, pkCalm = 0, pkBowl = 0, pkCrown = 0, pkBand = 0;
  for (const Massif& m : massifs_) {
    double dx = x - m.x, dz = z - m.z;
    double a = dx * m.fx + dz * m.fz, b = dz * m.fx - dx * m.fz;
    double q = a * a * (a > 0 ? m.kFace : m.kBack) + b * b * (b > 0 ? m.kRight : m.kLeft);
    if (q * (a > 0 ? 0.85 : 0.7) >= Q_CUT) continue;
    q *= 1 + 0.3 * N.noise(x * 0.0011 + m.seed, z * 0.0011 - m.seed) * (a > 0 ? 0.5 : 1);
    if (q >= Q_CUT) continue;
    double fade = (1 - smoothstep(Q_CUT * 0.4, Q_CUT, q)) * protect;
    if (m.apron != 0) fade *= smoothstep(VILLAGE_R * 0.6, VILLAGE_R * 0.6 + m.apron, d);
    double hx = x - m.hx, hz = z - m.hz, hq = (hx * hx + hz * hz) * m.kHorn;
    double g = (m.h * std::exp(-q) + (hq < 12 ? m.hornH * std::exp(-hq) : 0)) * fade;
    double ramp = std::max(0.0, vcDist - 450) * m.foot + (1 - vMouth) * 4000;
    if (g > ramp - 50) { double k = std::max(0.0, 50 - std::fabs(g - ramp)); g = std::max(0.0, std::min(g, ramp) - k * k / 200); }
    if (g > pkH) { pk = &m; pkH = g; pkFade = fade; }
  }
  if (pk) {
    double rel = pkH / pk->h;
    pkFade *= smoothstep(0, 80, pkH);
    double tx = x - pk->topX, tz = z - pk->topZ;
    double u = tx * pk->fx + tz * pk->fz, v = std::fabs(tz * pk->fx - tx * pk->fz);
    double spread = v - u * 0.2;
    if (u > -350 && u < pk->faceLen + 250 && spread < pk->bowl + 500) {
      double end = 1 - smoothstep(pk->faceLen - 250, pk->faceLen + 250, u);
      pkBowl = smoothstep(-160, 40, u) * (1 - smoothstep(pk->bowl, pk->bowl + 260, spread)) * end * pkFade;
      pkCalm = smoothstep(-350, 0, u) * (1 - smoothstep(pk->bowl + 100, pk->bowl + 500, spread)) * end * pkFade * (1 - (1 - smoothstep(450, 1300, vcDist)) * vMouth);
    }
    if (rel > 0.28 && pkBowl < 1) {
      double clear = smoothstep(140, 320, std::sqrt(tx * tx + tz * tz));
      pkCrown = smoothstep(0.42, 0.8, rel) * (1 - pkBowl) * clear;
      pkBand = smoothstep(0.28, 0.6, rel) * (1 - pkBowl) * clear;
    }
    if (u > -120 && u < 1000 && v < 260)
      pkH += pk->stationSlope * 130 * smoothstep(-120, 70, u) * (1 - smoothstep(70, 1000, u)) * (1 - smoothstep(110, 260, v)) * pkFade;
  }
  double mountains = (std::pow(rid, 1.7) * 1150 + big * 650) * range * (1 - 0.82 * inZone) * (1 - 0.985 * valley);
  if (pkCalm > 0) mountains *= 1 - 0.88 * pkCalm;

  double mainM = 1000 * mainG + 160 * std::exp(-md2 / (420.0 * 420.0));
  mainM *= 1 - smoothstep(0, 450, z);
  double cx = x - CROWN_X, cz = z - CROWN_Z;
  double crownMask = smoothstep(0.42, 0.85, mainM / 1160) * smoothstep(170, 420, std::sqrt(cx * cx + cz * cz));
  if (crownMask > 0 || pkCrown > 0.002) {
    double cr = std::pow(N2.ridged(x * 0.0011 + 5.3, z * 0.0011 - 3.7, std::max(1.0, oct(900, 5, spacing)), 2.0, 0.45, 5), 1.5);
    mainM += cr * 430 * crownMask;
    pkH += cr * (pk ? pk->crown : 0) * pkCrown;
  }

  const double k = 220;
  double hmax = std::max(mountains, mainM);
  double bump = std::max(0.0, k - std::fabs(mountains - mainM));
  double hblend = hmax + bump * bump * 0.25 / k * (1 - smoothstep(0, 400, z));
  if (pkH > 0) {
    double kp = 160 * pkFade, dd = std::fabs(hblend - pkH);
    hblend = std::max(hblend, pkH) + (kp > dd ? (kp - dd) * (kp - dd) * 0.25 / kp : 0);
  }

  double h = hblend;
  if (spacing < 40) {
    double crag = std::max(std::max(crownMask * crownMask, pkCrown * pkCrown * 0.85), pkBand * 0.2);
    if (hblend > 800 && rid > 0.5) crag = std::max(crag, smoothstep(800, 1250, hblend) * smoothstep(0.5, 0.85, rid) * (1 - valley) * (1 - pkBowl));
    if (crag > 0.01) {
      crag *= smoothstep(0.18, 0.55, N2.noise(x * 0.0019 + 7.7, z * 0.0019 - 3.1)) * 0.6 * (1 - smoothstep(12, 40, spacing));
      if (crag > 0.01 && crag_.nx) crag *= cragAllow(x, z);
      if (crag > 0.01) {
        crag *= 0.55 + 0.45 * smoothstep(-0.35, 0.35, N.noise(x * 0.0061 - 2.9, z * 0.0061 + 8.3));
        double wob = N2.noise(x * 0.004, z * 0.004) * 16 + N2.noise(x * 0.017, z * 0.017) * 5;
        double band = 21 + N.noise(x * 0.0007, z * 0.0007) * 9;
        double tt = (hblend + wob) / band, fi = std::floor(tt), f = tt - fi;
        double terr = (fi + smoothstep(0.38, 0.96, f)) * band - wob;
        h = lerp(hblend, terr, crag);
      }
    }
  }
  h += N.fbm(x * 0.0035 + 2.1, z * 0.0035 - 9.4, oct(285, 4, spacing), 2, 0.5, 4) * (6 + 12 * range) * (1 - 0.88 * valley) * (1 - 0.5 * pkBowl);
  h += descent(z);
  if (spacing < 10) h += (N2.noise(x * 0.025, z * 0.025) * 0.9 + N2.noise(x * 0.09, z * 0.09) * 0.18) * (1 - 0.6 * valley);

  h = wolkenspitzeHeight(x, z, h, spacing);

  double sd = std::sqrt(cx * cx + cz * cz);
  if (sd < 260 && !shoulderLock_) {
    double k2 = 1 - smoothstep(120, 260, sd);
    h = lerp(h, shoulderH_ + (h - shoulderH_) * 0.3, k2);
  }
  double vf = smoothstep(VILLAGE_R * 0.7, VILLAGE_R * 3.4, d);
  h = lerp(N2.noise(x * 0.01, z * 0.01) * 0.6, h, vf);
  h = legacyPeakHeight(x, z, h, spacing);
  return h;
}

double World::cutDelta(double x, double z) const {
  if (cuts_.empty()) return 0;
  double tw = double(cutCell_ * cutTile_);
  int tx = fl(x / tw), tz = fl(z / tw);
  auto it = cuts_.find(cellKey(tx, tz));
  if (it == cuts_.end()) return 0;
  const CutTile& t = it->second;
  double fx = (x - tx * tw) / cutCell_, fz = (z - tz * tw) / cutCell_;
  int i = std::min(cutTile_ - 1, fl(fx)), j = std::min(cutTile_ - 1, fl(fz));
  double ax = fx - i, az = fz - j;
  int S1 = cutTile_ + 1;
  const int16_t* v = t.v.data();
  double a = v[j * S1 + i], b = v[j * S1 + i + 1], c = v[(j + 1) * S1 + i], d = v[(j + 1) * S1 + i + 1];
  return ((a + (b - a) * ax) * (1 - az) + (c + (d - c) * ax) * az) * t.scale;
}

double World::height(double x, double z, double spacing) const {
  double h = baseHeight(x, z, spacing);
  auto it = padGrid_.find(cellKey(fl(x / 256), fl(z / 256)));
  if (it != padGrid_.end()) {
    for (int id : it->second) {
      const Pad& p = pads_[id];
      double d = std::hypot(x - p.x, z - p.z);
      if (d < p.r + p.blend) h = lerp(p.h, h, smoothstep(p.r, p.r + p.blend, d));
    }
  }
  return h + cutDelta(x, z);
}

double World::meshHeight(double x, double z) {
  double fx = x * 0.5, fz = z * 0.5;
  double fi = std::floor(fx), fj = std::floor(fz), tx = fx - fi, tz = fz - fj;
  int64_t i = int64_t(fi), j = int64_t(fj);
  auto V = [&](int64_t a, int64_t b) {
    int64_t key = (a + 1048576) * 2097152 + (b + 1048576);
    VCache& c = vcache_[size_t((uint64_t(key) * 0x9E3779B97F4A7C15ull) >> 48)];
    if (c.key != key) { c.key = key; c.h = height(double(a) * 2, double(b) * 2); }
    return c.h;
  };
  double hb = V(i + 1, j), hc = V(i, j + 1);
  if (tx + tz <= 1) { double ha = V(i, j); return ha + (hb - ha) * tx + (hc - ha) * tz; }
  double hd = V(i + 1, j + 1);
  return hd + (hc - hd) * (1 - tx) + (hb - hd) * (1 - tz);
}

vec3 World::groundNormal(double x, double z, double yHint) {
  const double e = 0.35;
  double hx = groundHeight(x + e, z, yHint) - groundHeight(x - e, z, yHint);
  double hz = groundHeight(x, z + e, yHint) - groundHeight(x, z - e, yHint);
  return glm::normalize(vec3(float(-hx), float(2 * e), float(-hz)));
}

CorridorHit World::corridorAt(double x, double z) const {
  CorridorHit out;
  auto it = corridorGrid_.find(cellKey(fl(x / 64), fl(z / 64)));
  if (it == corridorGrid_.end()) return out;
  for (int id : it->second) {
    const CorridorSeg& s = corridors_[id];
    double ex = s.bx - s.ax, ez = s.bz - s.az;
    double l2 = ex * ex + ez * ez;
    if (l2 == 0) l2 = 1;
    double t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
    double px = s.ax + ex * t - x, pz = s.az + ez * t - z;
    double d = std::sqrt(px * px + pz * pz) - s.w;
    if (d < out.d) {
      out.d = d; out.kind = s.kind; out.any = true;
      double il = 1 / std::sqrt(l2);
      out.dx = ex * il; out.dz = ez * il;
      out.lat = (ex * (s.az - z) - ez * (s.ax - x)) * il;
      out.groomed = s.kind != CorridorKind::Lift;
    }
  }
  return out;
}

double World::padInfluence(double x, double z) const {
  auto it = padGrid_.find(cellKey(fl(x / 256), fl(z / 256)));
  if (it == padGrid_.end()) return 0;
  double m = 0;
  for (int id : it->second) {
    const Pad& p = pads_[id];
    double d = std::hypot(x - p.x, z - p.z);
    if (d < p.r + p.blend) m = std::max(m, 1 - smoothstep(p.r, p.r + p.blend, d));
  }
  return m;
}

bool World::nearPad(double x, double z) const {
  auto it = padGrid_.find(cellKey(fl(x / 256), fl(z / 256)));
  if (it == padGrid_.end()) return false;
  for (int id : it->second) {
    const Pad& p = pads_[id];
    if (std::hypot(x - p.x, z - p.z) < p.r + p.blend * 0.6) return true;
  }
  return false;
}

double World::forest(double x, double z, double h, double slope) const {
  double n = N2_.fbm(x * 0.0022 + 40, z * 0.0022 - 17, 3) * 0.5 + 0.5;
  double tl = 520 + N_.noise(x * 0.001, z * 0.001) * 90;
  double alt = 1 - smoothstep(tl - 120, tl, h);
  double steep = 1 - smoothstep(0.7, 1.1, slope);
  double nearVillage = smoothstep(VILLAGE_R * 0.9, VILLAGE_R * 1.6, std::hypot(x, z));
  return clamp((n - 0.38) * 2.6, 0, 1) * alt * steep * nearVillage;
}

} // namespace sl
