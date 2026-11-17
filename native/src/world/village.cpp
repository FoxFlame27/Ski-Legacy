#include "world/village.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "engine/model.h"
#include "platform/platform.h"
#include "world/world.h"

#include <nlohmann/json.hpp>
#include <algorithm>
#include <cstring>
#include <map>
#include <queue>

namespace sl {

namespace {
bool inPoly(double x, double z, const nlohmann::json& poly) {
  bool c = false;
  const size_t n = poly.size();
  for (size_t i = 0, j = n - 1; i < n; j = i++) {
    const double xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) != (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
glm::dmat4 rows34(const nlohmann::json& a) {
  glm::dmat4 m(1);
  for (int r = 0; r < 3; r++) for (int c = 0; c < 4; c++) m[c][r] = a[size_t(r * 4 + c)].get<double>();
  return m;
}
nlohmann::json toRows34(const glm::dmat4& m) {
  nlohmann::json a = nlohmann::json::array();
  for (int r = 0; r < 3; r++) for (int c = 0; c < 4; c++) a.push_back(std::round(m[c][r] * 1e5) / 1e5);
  return a;
}
// a pack's instance list (inline rows of 12, or float32 x 12 in the bin), as rows
std::vector<glm::dmat4> instances(const nlohmann::json& e, const std::vector<uint8_t>& bin) {
  std::vector<glm::dmat4> out;
  if (e.contains("inst")) { for (auto& a : e["inst"]) out.push_back(rows34(a)); return out; }
  const size_t off = e.value("instOff", size_t(0)), n = e.value("instN", size_t(0));
  if (off + n * 48 > bin.size()) return out;
  for (size_t i = 0; i < n; i++) {
    float f[12];
    std::memcpy(f, bin.data() + off + i * 48, 48);
    glm::dmat4 m(1);
    for (int r = 0; r < 3; r++) for (int c = 0; c < 4; c++) m[c][r] = f[r * 4 + c];
    out.push_back(m);
  }
  return out;
}
} // namespace

Village::Village() = default;
Village::~Village() = default;

bool Village::load(platform::Platform& p, const AssetPaths& paths) {
  std::vector<uint8_t> jb, bb;
  if (!paths.readData(p, "village.json", jb) || !paths.readData(p, "village.bin", bb)) {
    SL_WARN("village: native/data/village.json missing (node native/tools/village/village_layout.mjs): the exported village as it is");
    return false;
  }
  j_ = std::make_shared<nlohmann::json>(nlohmann::json::parse(jb.begin(), jb.end(), nullptr, false));
  nlohmann::json& j = *j_;
  if (j.is_discarded()) { SL_ERROR("village.json: parse error"); j_.reset(); return false; }
  const auto& R = j["relief"];
  x0_ = R["x0"]; z0_ = R["z0"]; step_ = R["step"]; nx_ = R["nx"]; nz_ = R["nz"];
  const size_t off = R.value("off", size_t(0)), n = size_t(nx_) * size_t(nz_);
  if (off + n * 2 > bb.size()) { SL_ERROR("village.bin: short"); j_.reset(); return false; }
  relief_.resize(n);
  std::memcpy(relief_.data(), bb.data() + off, n * 2);
  const auto& P = j["places"];
  for (auto& h : P["hotels"]) {
    VillageDoor d;
    d.name = h.value("name", std::string());
    d.at = dvec2(h["x"].get<double>(), h["z"].get<double>());
    d.in = dvec2(h["in"][0].get<double>(), h["in"][1].get<double>());
    d.out = dvec2(h["out"][0].get<double>(), h["out"][1].get<double>());
    d.w = h.value("w", 1.0);
    hotels_.push_back(d);
  }
  for (auto& b : j["buildings"]) {
    VillageBuilding v;
    v.id = b["id"]; v.name = b["name"]; v.kind = b["kind"];
    v.x = b["x"]; v.z = b["z"]; v.yaw = b["yaw"]; v.w = b["w"]; v.d = b["d"]; v.h = b["h"];
    buildings_.push_back(v);
  }
  if (P.contains("spawn")) spawn_ = dvec3(P["spawn"][0].get<double>(), P["spawn"][1].get<double>(), P["spawn"][2].get<double>());
  if (P.contains("autotestHotel")) autotestHotel_ = dvec2(P["autotestHotel"][0].get<double>(), P["autotestHotel"][1].get<double>());
  if (j.contains("moves"))
    for (auto& m : j["moves"]) {
      Move v;
      v.name = m.value("name", std::string());
      v.from = dvec2(m["from"][0].get<double>(), m["from"][1].get<double>());
      v.to = dvec2(m["to"][0].get<double>(), m["to"][1].get<double>());
      v.r = m.value("r", 0.0); v.rot = m.value("rot", 0.0); v.dy = m.value("dy", 0.0);
      if (m.contains("clip") && m["clip"].is_array() && m["clip"].size() == 3) {
        v.clipDir = dvec2(m["clip"][0].get<double>(), m["clip"][1].get<double>());
        v.clipMax = m["clip"][2].get<double>();
      }
      moves_.push_back(v);
    }
  for (auto& q : j["walk"]["nodes"]) nodes_.push_back(dvec2(q[0].get<double>(), q[1].get<double>()));
  adj_.assign(nodes_.size(), {});
  for (auto& e : j["walk"]["edges"]) {
    const int a = e[0], b = e[1];
    if (a < 0 || b < 0 || size_t(a) >= nodes_.size() || size_t(b) >= nodes_.size()) continue;
    adj_[size_t(a)].push_back(b);
    adj_[size_t(b)].push_back(a);
  }
  loaded_ = true;
  int raised = 0;
  double mx = 0;
  for (int16_t v : relief_) if (v) { raised++; mx = std::max(mx, std::fabs(v * 0.01)); }
  SL_INFO("village: %zu buildings, %zu props, %zu paths, %zu hotels; relief %dx%d at %.0f m (%d cells, max %.2f m); walking network %zu nodes",
          buildings_.size(), j["props"].size(), j["paths"].size(), hotels_.size(), nx_, nz_, step_, raised, mx, nodes_.size());
  return true;
}

double Village::delta(double x, double z) const {
  if (!reliefOn || relief_.empty()) return 0;
  const double fi = (x - x0_) / step_, fj = (z - z0_) / step_;
  if (fi < 0 || fj < 0 || fi >= nx_ - 1 || fj >= nz_ - 1) return 0;
  const int i = int(fi), k = int(fj);
  const double tx = fi - i, tz = fj - k;
  const auto v = [&](int a, int b) { return double(relief_[size_t(b) * size_t(nx_) + size_t(a)]); };
  const double a = v(i, k), b = v(i + 1, k), c = v(i, k + 1), d = v(i + 1, k + 1);
  return ((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz) * 0.01;
}

namespace {
constexpr double ROAD_FLAT = 2.6, ROAD_EASE = 5.0, ROAD_UNDER = 0.06, ROAD_JOIN = 24.0;
}

void Village::prepareRoads(const std::function<double(double, double)>& ground) {
  roadLines_.clear();
  if (!j_ || !j_->contains("roads")) return;
  std::vector<RoadLine> lines;
  for (auto& R : (*j_)["roads"]) {
    RoadLine L;
    for (auto& q : R["pts"]) L.p.push_back(dvec2(q[0].get<double>(), q[1].get<double>()));
    L.half = R.value("half", 3.4);
    const int n = int(L.p.size());
    if (n < 2) { lines.push_back(std::move(L)); continue; }
    std::vector<double> g(static_cast<size_t>(n));
    for (int i = 0; i < n; i++) g[size_t(i)] = ground(L.p[size_t(i)].x, L.p[size_t(i)].y);
    L.y.resize(size_t(n)); L.s.resize(size_t(n));
    double acc = 0;
    for (int i = 0; i < n; i++) {
      double sum = 0, w = 0;
      for (int k = -4; k <= 4; k++) { const int q = std::clamp(i + k, 0, n - 1); sum += g[size_t(q)]; w += 1; }
      // (the first points keep the ground's own level: the exported road the Dorfstrasse leaves from)
      const double t = std::min(1.0, i / 4.0);
      L.y[size_t(i)] = g[size_t(i)] + (sum / w - g[size_t(i)]) * t;
      if (i) acc += glm::length(L.p[size_t(i)] - L.p[size_t(i - 1)]);
      L.s[size_t(i)] = acc;
    }
    const double m = L.half + ROAD_FLAT + ROAD_EASE;
    L.lo = L.p[0]; L.hi = L.p[0];
    for (const dvec2& q : L.p) { L.lo = glm::min(L.lo, q); L.hi = glm::max(L.hi, q); }
    L.lo -= dvec2(m); L.hi += dvec2(m);
    lines.push_back(std::move(L));
  }
  roadLines_ = std::move(lines);
  // the buildings' pads (village.json "pads"): the ground levelled under each footprint at the level in front of its
  // door (the drawn ground there: relief, cuts, the road), so no wall or door of a house is buried on a slope
  pads_.clear();
  if (j_->contains("pads"))
    for (auto& P : (*j_)["pads"]) {
      BuildingPad b;
      b.x = P["x"]; b.z = P["z"]; b.yaw = P["yaw"]; b.hw = P["hw"]; b.hd = P["hd"]; b.fade = P.value("fade", 4.0);
      const double c = std::cos(b.yaw), s = std::sin(b.yaw);
      double gmin = 1e30, gmax = -1e30;
      for (int u = -2; u <= 2; u++) for (int v = -2; v <= 2; v++) {
        const double lx = u * b.hw * 0.5, lz = v * b.hd * 0.5, g = ground(b.x + lx * c + lz * s, b.z - lx * s + lz * c);
        gmin = std::min(gmin, g); gmax = std::max(gmax, g);
      }
      const double front = ground(b.x + s * (b.hd + 1.5), b.z + c * (b.hd + 1.5));
      b.level = P.contains("level") ? P["level"].get<double>() : std::clamp(front, gmin, gmax);
      const double r = std::hypot(b.hw, b.hd) + b.fade;
      b.lo = dvec2(b.x - r, b.z - r); b.hi = dvec2(b.x + r, b.z + r);
      pads_.push_back(b);
    }
  // (Nov 17, the user: "these bent parking lots are wrong") the Autohaus car park levelled like a building's pad: its
  // asphalt and bay lines followed the slope at the foot of the Oberdorf (bent lines, cars and tow trucks half sunk)
  if (j_->contains("rentalPark")) {
    const nlohmann::json& P = (*j_)["rentalPark"];
    BuildingPad b;
    b.x = P["x"]; b.z = P["z"];
    const double ux = P["ux"], uz = P["uz"], hw = P["hw"], hd = P["hd"];
    b.yaw = std::atan2(-uz, ux);   // (the pad's own x along the lot's u: c = ux, -s = uz)
    b.hw = hw + 0.6; b.hd = hd + 0.6; b.fade = 4.0;
    const double c = std::cos(b.yaw), s = std::sin(b.yaw);
    double sum = 0; int cnt = 0;
    for (int u = -2; u <= 2; u++) for (int v = -2; v <= 2; v++) {
      const double lx = u * hw * 0.5, lz = v * hd * 0.5;
      sum += ground(b.x + lx * c + lz * s, b.z - lx * s + lz * c); cnt++;
    }
    b.level = P.contains("level") ? P["level"].get<double>() : sum / cnt;
    const double r = std::hypot(b.hw, b.hd) + b.fade;
    b.lo = dvec2(b.x - r, b.z - r); b.hi = dvec2(b.x + r, b.z + r);
    pads_.push_back(b);
    SL_INFO("village: the Autohaus car park levelled at %.2f m", b.level);
  }
}

double Village::padLevel(double x, double z, double h) const {
  for (const BuildingPad& b : pads_) {
    if (x < b.lo.x || z < b.lo.y || x > b.hi.x || z > b.hi.y) continue;
    const double c = std::cos(b.yaw), s = std::sin(b.yaw), dx = x - b.x, dz = z - b.z;
    const double ex = std::max(0.0, std::fabs(dx * c - dz * s) - b.hw), ez = std::max(0.0, std::fabs(dx * s + dz * c) - b.hd);
    const double d = std::hypot(ex, ez);
    if (d >= b.fade) continue;
    const double t = d / b.fade, w = 1 - t * t * (3 - 2 * t);
    h += (b.level - h) * w;
  }
  return h;
}

double Village::roadCut(double x, double z, double h) const {
  if (!reliefOn) return h;
  h = padLevel(x, z, h);
  for (const RoadLine& L : roadLines_) {
    if (L.y.empty() || x < L.lo.x || z < L.lo.y || x > L.hi.x || z > L.hi.y) continue;
    double best = 1e30, y = 0, s = 0;
    bool before = false;
    for (size_t q = 1; q < L.p.size(); q++) {
      const dvec2 a = L.p[q - 1], e = L.p[q] - a;
      const double l2 = std::max(1e-9, glm::dot(e, e)), t0 = glm::dot(dvec2(x, z) - a, e) / l2, t = std::clamp(t0, 0.0, 1.0);
      const double d = glm::length(a + e * t - dvec2(x, z));
      if (d < best) { best = d; y = L.y[q - 1] + (L.y[q] - L.y[q - 1]) * t; s = L.s[q - 1] + (L.s[q] - L.s[q - 1]) * t; before = q == 1 && t0 < 0; }
    }
    const double flat = L.half + ROAD_FLAT;
    if (before || best > flat + ROAD_EASE) continue;
    double w = 1;
    if (best > flat) { const double t = (best - flat) / ROAD_EASE; w = 1 - t * t * (3 - 2 * t); }
    const double want = h + (y - ROAD_UNDER - h) * w;
    h = s < ROAD_JOIN ? std::min(h, want) : want;
  }
  return h;
}

void Village::liftSites(const std::function<double(double, double)>& cut) {
  cutAt_ = cut;
  for (Move& m : moves_) {
    if (m.clipMax > 1e29) continue;   // (roadside sites only: the heliport stands on the open meadow)
    const double c = std::cos(m.rot), s = std::sin(m.rot);
    const dvec2 dir(m.clipDir.x * c + m.clipDir.y * s, -m.clipDir.x * s + m.clipDir.y * c);   // (toward the road, turned)
    const dvec2 front = m.to + dir * (m.clipMax + 4.0);
    m.lift = std::max(0.0, cut(front.x, front.y));
    if (m.lift < 0.02) { m.lift = 0; continue; }
    m.dy += m.lift;
    SL_INFO("village: '%s' raised %.2f m to the road in front of it (the exported cuts there)", m.name.c_str(), m.lift);
  }
}

double Village::siteGround(double x, double z, double cut) const {
  if (!reliefOn) return cut;
  constexpr double FADE = 12.0;   // (village_layout.mjs MOVE_FADE)
  // (the level: the nearest site's, by the distance past 3/4 of its radius (its buildings and yard), blended over ~1 m
  // where two meet (the police yard and the Werkstatt's overlap); the cut faded out within the nearest radius)
  double wmax = 0, best = 1e30;
  for (const Move& m : moves_) {
    if (m.lift == 0) continue;
    const double d = glm::length(dvec2(x, z) - m.to);
    if (d >= m.r + FADE) continue;
    const double t = std::clamp((d - m.r) / FADE, 0.0, 1.0);
    wmax = std::max(wmax, 1 - t * t * (3 - 2 * t));
    best = std::min(best, d - 0.75 * m.r);
  }
  if (wmax <= 0) return cut;
  double ws = 0, wl = 0;
  for (const Move& m : moves_) {
    if (m.lift == 0) continue;
    const double d = glm::length(dvec2(x, z) - m.to);
    if (d >= m.r + FADE) continue;
    const double w = std::exp(-(d - 0.75 * m.r - best));
    // (lowered where the old site's ground was cut (the valley road's cut it stood in): its apron and ramp followed
    // that ground; the Werkstatt's apron lay under the copied snow in front of the bay)
    double old = 0;
    if (cutAt_ && d < m.r) {
      const dvec2 q = dvec2(x, z) - m.to;
      const double c = std::cos(m.rot), s = std::sin(m.rot);
      const dvec2 o = m.from + dvec2(q.x * c - q.y * s, q.x * s + q.y * c);   // (movePoint's inverse)
      if (glm::dot(o - m.from, m.clipDir) < m.clipMax) old = std::min(0.0, cutAt_(o.x, o.y));
    }
    ws += w; wl += w * (m.lift + old);
  }
  return cut * (1 - wmax) + (wl / ws) * wmax;
}

std::vector<dvec2> Village::route(const dvec2& from, const dvec2& to, double lane) const {
  std::vector<dvec2> out;
  if (nodes_.empty() || glm::length(to - from) < 10) { out.push_back(to); return out; }
  auto nearest = [&](const dvec2& p) {
    int best = 0;
    double bd = 1e30;
    for (size_t i = 0; i < nodes_.size(); i++) { const double d = glm::length(nodes_[i] - p); if (d < bd) { bd = d; best = int(i); } }
    return best;
  };
  const int a = nearest(from), b = nearest(to);
  // Dijkstra on the walking network
  std::vector<double> dist(nodes_.size(), 1e30);
  std::vector<int> prev(nodes_.size(), -1);
  using Q = std::pair<double, int>;
  std::priority_queue<Q, std::vector<Q>, std::greater<Q>> q;
  dist[size_t(a)] = 0;
  q.push({0, a});
  while (!q.empty()) {
    auto [d, u] = q.top();
    q.pop();
    if (d > dist[size_t(u)]) continue;
    if (u == b) break;
    for (int v : adj_[size_t(u)]) {
      const double nd = d + glm::length(nodes_[size_t(v)] - nodes_[size_t(u)]);
      if (nd < dist[size_t(v)]) { dist[size_t(v)] = nd; prev[size_t(v)] = u; q.push({nd, v}); }
    }
  }
  std::vector<int> chain;
  if (dist[size_t(b)] < 1e29) for (int u = b; u >= 0; u = prev[size_t(u)]) chain.push_back(u);
  std::reverse(chain.begin(), chain.end());
  // (skip the first node when it lies behind us, the last when `to` is nearer than it)
  for (size_t i = 0; i < chain.size(); i++) {
    dvec2 p = nodes_[size_t(chain[i])];
    if (lane != 0 && chain.size() > 1) {
      const dvec2 n0 = nodes_[size_t(chain[i > 0 ? i - 1 : i])], n1 = nodes_[size_t(chain[i + 1 < chain.size() ? i + 1 : i])];
      dvec2 dir = n1 - n0;
      const double l = glm::length(dir);
      if (l > 1e-6) { dir /= l; p += dvec2(-dir.y, dir.x) * lane; }
    }
    out.push_back(p);
  }
  if (out.size() >= 2 && glm::length(out[1] - from) < glm::length(out[1] - out[0])) out.erase(out.begin());
  if (out.size() >= 2 && glm::length(to - out[out.size() - 2]) < glm::length(out.back() - out[out.size() - 2])) out.pop_back();
  out.push_back(to);
  return out;
}

const Village::Move* Village::moveAt(double x, double z) const {
  for (const Move& m : moves_)
    if (glm::length(dvec2(x, z) - m.from) < m.r && glm::dot(dvec2(x, z) - m.from, m.clipDir) < m.clipMax) return &m;
  return nullptr;
}

dvec2 Village::movePoint(const Move& m, dvec2 p) {
  const dvec2 d = p - m.from;
  const double c = std::cos(m.rot), s = std::sin(m.rot);
  return m.to + dvec2(d.x * c + d.y * s, -d.x * s + d.y * c);   // (glm::rotate about +y: a front (sin yaw, cos yaw) turns to yaw + rot)
}

namespace {
glm::dmat4 moveMatrix(const Village::Move& m) {
  glm::dmat4 T = glm::translate(glm::dmat4(1), dvec3(m.to.x, m.dy, m.to.y));
  T = glm::rotate(T, m.rot, dvec3(0, 1, 0));
  return glm::translate(T, dvec3(-m.from.x, 0, -m.from.y));
}
} // namespace

void Village::applyMoves(const std::string& pack, nlohmann::json& j, std::vector<uint8_t>& bin) const {
  if (moves_.empty()) return;
  size_t nInst = 0, nCol = 0, nTri = 0, nSurf = 0, nPlace = 0;
  // ---- props and instanced pieces: their matrices
  for (const char* key : {"props", "instanced"}) {
    if (!j.contains(key)) continue;
    for (auto& p : j[key]) {
      auto inst = instances(p, bin);
      bool any = false;
      for (auto& M : inst)
        if (const Move* m = moveAt(M[3][0], M[3][2])) { M = moveMatrix(*m) * M; any = true; nInst++; }
      if (!any) continue;
      nlohmann::json rows = nlohmann::json::array();
      for (const auto& M : inst) rows.push_back(toRows34(M));
      p.erase("instOff"); p.erase("instN");
      p["inst"] = std::move(rows);
    }
  }
  // ---- colliders (rot = -yaw)
  for (auto& c : j["colliders"]) {
    const Move* m = moveAt(c["x"].get<double>(), c["z"].get<double>());
    if (!m) continue;
    const dvec2 q = movePoint(*m, dvec2(c["x"].get<double>(), c["z"].get<double>()));
    c["x"] = q.x; c["z"] = q.y;
    if (c.contains("rot")) c["rot"] = c["rot"].get<double>() - m->rot;
    else if (!c.contains("r") && m->rot != 0) c["rot"] = -m->rot;
    if (c.contains("top")) c["top"] = c["top"].get<double>() + m->dy;
    nCol++;
  }
  // ---- walkable decks (sampled height grids): carried along (turned only by whole quarter turns: not supported, kept)
  if (j.contains("surfaces"))
    for (auto& s : j["surfaces"]) {
      const double cx = s["x0"].get<double>() + s["step"].get<double>() * s["nx"].get<double>() * 0.5;
      const double cz = s["z0"].get<double>() + s["step"].get<double>() * s["nz"].get<double>() * 0.5;
      const Move* m = moveAt(cx, cz);
      if (!m) continue;
      if (std::fabs(m->rot) > 1e-6) { SL_WARN("village: a walkable deck at (%.0f, %.0f) in move '%s' is not turned (rot)", cx, cz, m->name.c_str()); continue; }
      s["x0"] = s["x0"].get<double>() + m->to.x - m->from.x;
      s["z0"] = s["z0"].get<double>() + m->to.y - m->from.y;
      s["base"] = s["base"].get<double>() + m->dy;
      nSurf++;
    }
  // ---- baked meshes: the triangles whose centre is in a move's source go into a new mesh of their own, carried
  if (j.contains("meshes")) {
    nlohmann::json added = nlohmann::json::array();
    for (auto& mj : j["meshes"]) {
      const size_t verts = mj["verts"], tris = mj["tris"], vOff = mj["vOff"], iOff = mj["iOff"];
      const bool i16 = mj.value("i16", false);
      if (vOff + verts * 28 > bin.size() || iOff + tris * 3 * (i16 ? 2 : 4) > bin.size()) continue;
      const dvec3 o(mj["origin"][0].get<double>(), mj["origin"][1].get<double>(), mj["origin"][2].get<double>());
      auto idx = [&](size_t k) -> uint32_t {
        if (i16) { uint16_t v; std::memcpy(&v, bin.data() + iOff + k * 2, 2); return v; }
        uint32_t v; std::memcpy(&v, bin.data() + iOff + k * 4, 4); return v;
      };
      auto pos = [&](uint32_t v) { float q[3]; std::memcpy(q, bin.data() + vOff + size_t(v) * 28, 12); return dvec3(q[0], q[1], q[2]) + o; };
      std::map<const Move*, std::vector<size_t>> out;   // the move -> its triangles
      std::vector<const Move*> tm(tris, nullptr);
      for (size_t t = 0; t < tris; t++) {
        const uint32_t a = idx(t * 3), b = idx(t * 3 + 1), c = idx(t * 3 + 2);
        if (a >= verts || b >= verts || c >= verts) continue;
        const dvec3 ctr = (pos(a) + pos(b) + pos(c)) / 3.0;
        if (const Move* m = moveAt(ctr.x, ctr.z)) { tm[t] = m; out[m].push_back(t); }
      }
      if (out.empty()) continue;
      // the moved triangles' own copies (vertices duplicated as needed)
      std::vector<std::array<uint32_t, 3>> keep;
      for (size_t t = 0; t < tris; t++) if (!tm[t]) keep.push_back({idx(t * 3), idx(t * 3 + 1), idx(t * 3 + 2)});
      for (auto& [m, list] : out) {
        const glm::dmat4 T = moveMatrix(*m);
        const double c = std::cos(m->rot), s = std::sin(m->rot);
        const dvec3 no = dvec3(T * glm::dvec4(o, 1));
        std::map<uint32_t, uint32_t> remap;
        std::vector<uint8_t> vb;
        std::vector<uint32_t> ib;
        for (size_t t : list)
          for (int k = 0; k < 3; k++) {
            const uint32_t v = idx(t * 3 + size_t(k));
            auto it = remap.find(v);
            if (it == remap.end()) {
              it = remap.emplace(v, uint32_t(remap.size())).first;
              uint8_t raw[28];
              std::memcpy(raw, bin.data() + vOff + size_t(v) * 28, 28);
              const dvec3 w = dvec3(T * glm::dvec4(pos(v), 1)) - no;
              const float q[3] = {float(w.x), float(w.y), float(w.z)};
              std::memcpy(raw, q, 12);
              int8_t n[3];
              std::memcpy(n, raw + 12, 3);
              const double nx = n[0] * c + n[2] * s, nz = -n[0] * s + n[2] * c;
              n[0] = int8_t(std::lround(std::clamp(nx, -127.0, 127.0)));
              n[2] = int8_t(std::lround(std::clamp(nz, -127.0, 127.0)));
              std::memcpy(raw + 12, n, 3);
              vb.insert(vb.end(), raw, raw + 28);
            }
            ib.push_back(it->second);
          }
        const bool small = remap.size() < 65536;
        while (bin.size() % 4) bin.push_back(0);
        const size_t nvOff = bin.size();
        bin.insert(bin.end(), vb.begin(), vb.end());
        const size_t niOff = bin.size();
        for (uint32_t v : ib) {
          if (small) { const uint16_t s16 = uint16_t(v); bin.push_back(uint8_t(s16 & 255)); bin.push_back(uint8_t(s16 >> 8)); }
          else { uint8_t b4[4]; std::memcpy(b4, &v, 4); bin.insert(bin.end(), b4, b4 + 4); }
        }
        nlohmann::json nm = mj;
        nm["verts"] = remap.size(); nm["tris"] = list.size(); nm["vOff"] = nvOff; nm["iOff"] = niOff; nm["i16"] = small;
        nm["origin"] = {no.x, no.y, no.z};
        added.push_back(std::move(nm));
        nTri += list.size();
      }
      // (what stays: compacted in place, as the cobble's clearing does; the index buffer is re-read above first)
      auto put = [&](size_t k, uint32_t v) {
        if (i16) { const uint16_t s16 = uint16_t(v); std::memcpy(bin.data() + iOff + k * 2, &s16, 2); }
        else std::memcpy(bin.data() + iOff + k * 4, &v, 4);
      };
      for (size_t t = 0; t < keep.size(); t++) for (int k = 0; k < 3; k++) put(t * 3 + size_t(k), keep[t][size_t(k)]);
      mj["tris"] = keep.size();
    }
    for (auto& a : added) j["meshes"].push_back(std::move(a));
  }
  // ---- the gameplay data's places (play.json "play", transport.json "net"): points with x / z (y, yaw, the frame's
  // directions with them), [x, y, z] spots, rows-of-12 frames, the paths that start in a site
  std::function<void(nlohmann::json&, const std::string&)> walk = [&](nlohmann::json& o, const std::string& key) {
    if (o.is_array()) {
      if ((key == "at" || key == "sock") && o.size() == 3 && o[0].is_number()) {
        if (const Move* m = moveAt(o[0].get<double>(), o[2].get<double>())) {
          const dvec2 q = movePoint(*m, dvec2(o[0].get<double>(), o[2].get<double>()));
          o = {q.x, o[1].get<double>() + m->dy, q.y};
          nPlace++;
        }
        return;
      }
      if ((key == "cells" || key == "office") && o.size() == 12 && o[0].is_number()) {
        if (const Move* m = moveAt(o[3].get<double>(), o[11].get<double>())) { o = toRows34(moveMatrix(*m) * rows34(o)); nPlace++; }
        return;
      }
      if (key == "path" && !o.empty() && o[0].is_array() && o[0].size() == 2 && o[0][0].is_number()) {
        // a path leaving a moved site: its points in the site carried; then on from the nearest of the rest
        size_t k = 0;
        dvec2 last(0);
        while (k < o.size()) {
          const Move* m = moveAt(o[k][0].get<double>(), o[k][1].get<double>());
          if (!m) break;
          last = movePoint(*m, dvec2(o[k][0].get<double>(), o[k][1].get<double>()));
          o[k] = {last.x, last.y};
          k++;
        }
        if (k == 0 || k >= o.size()) return;
        size_t best = k;
        double bd = 1e30;
        for (size_t i = k; i < o.size(); i++) {
          const double d = glm::length(dvec2(o[i][0].get<double>(), o[i][1].get<double>()) - last);
          if (d < bd) { bd = d; best = i; }
        }
        o.erase(o.begin() + std::ptrdiff_t(k), o.begin() + std::ptrdiff_t(best));
        nPlace++;
        return;
      }
      for (auto& e : o) walk(e, key);
      return;
    }
    if (!o.is_object()) return;
    if (o.contains("x") && o.contains("z") && o["x"].is_number() && o["z"].is_number())
      if (const Move* m = moveAt(o["x"].get<double>(), o["z"].get<double>())) {
        const dvec2 q = movePoint(*m, dvec2(o["x"].get<double>(), o["z"].get<double>()));
        o["x"] = q.x; o["z"] = q.y;
        if (o.contains("y") && o["y"].is_number()) o["y"] = o["y"].get<double>() + m->dy;
        for (const char* a : {"yaw", "heading", "facing"}) if (o.contains(a) && o[a].is_number()) o[a] = o[a].get<double>() + m->rot;
        if (o.contains("rot") && o["rot"].is_number()) o["rot"] = o["rot"].get<double>() - m->rot;   // (a box collider: rot = -yaw)
        const double c = std::cos(m->rot), s = std::sin(m->rot);
        for (auto [a, b] : {std::pair{"dirx", "dirz"}, {"ux", "uz"}, {"vx", "vz"}, {"ax", "az"}, {"fx", "fz"}, {"tvx", "tvz"}})
          if (o.contains(a) && o.contains(b) && o[a].is_number() && o[b].is_number()) {
            const double u = o[a].get<double>(), v = o[b].get<double>();
            o[a] = u * c + v * s; o[b] = -u * s + v * c;
          }
        for (auto [a, b] : {std::pair{"ex", "ez"}, {"sx", "sz"}})
          if (o.contains(a) && o.contains(b) && o[a].is_number() && o[b].is_number()) {
            const dvec2 e = movePoint(*m, dvec2(o[a].get<double>(), o[b].get<double>()));
            o[a] = e.x; o[b] = e.y;
          }
        nPlace++;
      }
    // (a room model standing at `at` (its parts about that point, unturned): the turn it now stands at, "atRot",
    // applied where it is drawn (the police station outside, the Werkstatt); before, only `at` moved and the house
    // stood unturned while its door, colliders, cells and the patrol car's bay were turned: the car stood inside)
    if (o.contains("at") && o.contains("parts") && o["at"].is_array() && o["at"].size() >= 3 && o["at"][0].is_number())
      if (const Move* m = moveAt(o["at"][0].get<double>(), o["at"][2].get<double>())) o["atRot"] = o.value("atRot", 0.0) + m->rot;
    for (auto it = o.begin(); it != o.end(); ++it) if (it.key() != "parts") walk(it.value(), it.key());
  };
  for (const char* key : {"play", "net"}) if (j.contains(key)) walk(j[key], key);
  if (nInst + nCol + nTri + nSurf + nPlace)
    SL_INFO("village: moved sites in %s: %zu props, %zu colliders, %zu triangles, %zu decks, %zu places", pack.c_str(), nInst, nCol, nTri, nSurf, nPlace);
}

void Village::addRoads(nlohmann::json& j, std::vector<uint8_t>& bin, World& world) const {
  if (!j_ || !j_->contains("roads") || !j.contains("net")) return;
  int roadMat = -1;
  for (size_t k = 0; k < j["materials"].size(); k++)
    if (j["materials"][k].value("tag", std::string()) == "roadsnow-road") { roadMat = int(k); break; }
  // the exported roads' centre lines (where ours run on top of one, at a junction, theirs is drawn)
  std::vector<std::vector<dvec2>> old;
  auto fl = [&](const nlohmann::json& a) {
    std::vector<float> v;
    const size_t off = a["off"], n = a["n"];
    if (off + n * 4 > bin.size()) return v;
    v.resize(n);
    std::memcpy(v.data(), bin.data() + off, n * 4);
    return v;
  };
  for (auto& r : j["net"]["roads"]) {
    const auto X = fl(r["X"]), Z = fl(r["Z"]);
    std::vector<dvec2> pts;
    for (size_t i = 0; i < X.size() && i < Z.size(); i++) pts.push_back(dvec2(X[i], Z[i]));
    old.push_back(std::move(pts));
  }
  auto nearOld = [&](const dvec2& p, double d) {
    for (auto& pts : old) for (const dvec2& q : pts) if (glm::length(q - p) < d) return true;
    return false;
  };
  auto put = [&](const void* data, size_t bytes) {
    while (bin.size() % 4) bin.push_back(0);
    const size_t off = bin.size();
    bin.insert(bin.end(), static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + bytes);
    return off;
  };
  size_t nTris = 0;
  size_t roadIdx = 0;
  for (auto& R : (*j_)["roads"]) {
    const size_t ri = roadIdx++;
    std::vector<dvec2> p;
    for (auto& q : R["pts"]) p.push_back(dvec2(q[0].get<double>(), q[1].get<double>()));
    if (p.size() < 2) continue;
    const int n = int(p.size());
    // heights: the road's level along its middle (prepareRoads: the ground is cut to it, World::height); without it the
    // drawn ground's highest across the ribbon, smoothed
    std::vector<double> y(static_cast<size_t>(n));
    const double halfW = R.value("half", 3.4);
    const std::vector<double>& lv = roadLevel(ri);
    if (lv.size() == size_t(n)) {
      y = lv;
    } else {
      std::vector<double> y0(static_cast<size_t>(n));
      for (int i = 0; i < n; i++) {
        dvec2 d = p[size_t(std::min(n - 1, i + 1))] - p[size_t(std::max(0, i - 1))];
        d /= std::max(1e-6, glm::length(d));
        double top = -1e30;
        for (int a = 0; a < 7; a++) { const dvec2 q = p[size_t(i)] + dvec2(-d.y, d.x) * ((a - 3) / 3.0 * halfW); top = std::max(top, world.meshHeight(q.x, q.y)); }
        y0[size_t(i)] = top + 0.04;
      }
      for (int i = 0; i < n; i++) {
        double s = 0, w = 0;
        for (int k = -3; k <= 3; k++) { const int q = std::clamp(i + k, 0, n - 1); s += y0[size_t(q)]; w += 1; }
        y[size_t(i)] = s / w;
      }
    }
    std::vector<float> X, Y, Z, S, lim;
    std::vector<int16_t> kmh;
    double acc = 0;
    const int16_t lk = int16_t(R.value("kmh", 30));
    for (int i = 0; i < n; i++) {
      if (i) acc += glm::length(p[size_t(i)] - p[size_t(i - 1)]);
      X.push_back(float(p[size_t(i)].x)); Y.push_back(float(y[size_t(i)])); Z.push_back(float(p[size_t(i)].y)); S.push_back(float(acc));
      kmh.push_back(lk); lim.push_back(float(lk / 3.6));
    }
    auto ref = [&](const void* d, size_t count, size_t sz) { return nlohmann::json{{"off", put(d, count * sz)}, {"n", count}}; };
    nlohmann::json road = {{"n", n}, {"length", acc}, {"from", -1}, {"to", -1}, {"access", false}, {"scenic", false}, {"depot", false},
                           {"heli", false}, {"ring", false}, {"loop", false}, {"chalet", false}, {"village", R.value("name", std::string())}};
    road["X"] = ref(X.data(), X.size(), 4); road["Y"] = ref(Y.data(), Y.size(), 4); road["Z"] = ref(Z.data(), Z.size(), 4); road["S"] = ref(S.data(), S.size(), 4);
    road["prof"] = {{"kmh", ref(kmh.data(), kmh.size(), 2)}, {"limF", ref(lim.data(), lim.size(), 4)}, {"limB", ref(lim.data(), lim.size(), 4)},
                    {"vcF", ref(lim.data(), lim.size(), 4)}, {"vcB", ref(lim.data(), lim.size(), 4)}};
    j["net"]["roads"].push_back(road);
    if (roadMat < 0) continue;
    // the ribbon: 7 vertices across the 6.8 m, the exported road's texture (u across, v 0.0754 per m along); left out
    // where an exported road already lies (the junction)
    const double half = R.value("half", 3.4);
    const dvec3 origin(p[0].x, y[0], p[0].y);
    std::vector<uint8_t> vb;
    std::vector<uint16_t> ib;
    for (int i = 0; i + 1 < n; i++) {
      const dvec2 mid = (p[size_t(i)] + p[size_t(i + 1)]) * 0.5;
      if (nearOld(mid, half + 1.5)) continue;
      const uint16_t base = uint16_t(vb.size() / 28);
      if (vb.size() / 28 + 14 > 65000) break;
      for (int e = 0; e < 2; e++) {
        const int k = i + e;
        dvec2 d = p[size_t(std::min(n - 1, k + 1))] - p[size_t(std::max(0, k - 1))];
        d /= std::max(1e-6, glm::length(d));
        const dvec2 rgt(-d.y, d.x);
        for (int a = 0; a < 7; a++) {
          const dvec2 q = p[size_t(k)] + rgt * ((a - 3) / 3.0 * half);
          const float pos[3] = {float(q.x - origin.x), float(y[size_t(k)] + 0.035 - origin.y), float(q.y - origin.z)};
          const int8_t nrm[4] = {0, 127, 0, 0};
          const float uv[2] = {float(a / 6.0), float(S[size_t(k)] * 0.0754)};
          const uint8_t col[4] = {255, 189, 255, 0};
          uint8_t raw[28];
          std::memcpy(raw, pos, 12); std::memcpy(raw + 12, nrm, 4); std::memcpy(raw + 16, uv, 8); std::memcpy(raw + 24, col, 4);
          vb.insert(vb.end(), raw, raw + 28);
        }
      }
      for (int a = 0; a < 6; a++) {
        const uint16_t p0 = uint16_t(base + a), p1 = uint16_t(base + a + 1), p2 = uint16_t(base + 7 + a), p3 = uint16_t(base + 7 + a + 1);
        for (uint16_t k : {p0, p1, p2, p1, p3, p2}) ib.push_back(k);   // (counter-clockwise seen from above: the other way round it was culled, only its shadow drawn)
      }
    }
    if (ib.empty()) continue;
    const size_t vOff = put(vb.data(), vb.size()), iOff = put(ib.data(), ib.size() * 2);
    j["meshes"].push_back({{"mat", roadMat}, {"verts", vb.size() / 28}, {"tris", ib.size() / 3}, {"vOff", vOff}, {"iOff", iOff}, {"i16", true},
                           {"origin", {origin.x, origin.y, origin.z}}});
    nTris += ib.size() / 3;
  }
  SL_INFO("village: %zu roads of its own on the network (%zu road triangles)", (*j_)["roads"].size(), nTris);
  addRentalPark(j, bin, world);
}

void Village::addRentalPark(nlohmann::json& j, std::vector<uint8_t>& bin, World& world) const {
  if (!j_ || !j_->contains("rentalPark") || !j.contains("net") || !j["net"].contains("lots")) return;
  const nlohmann::json& P = (*j_)["rentalPark"];
  nlohmann::json* lot = nullptr;
  for (auto& q : j["net"]["lots"]) if (q.value("impound", false)) { lot = &q; break; }
  if (!lot) { SL_WARN("village: no impound lot in the transport pack: the Autohaus car park stays where it was"); return; }
  const double cx = P["x"], cz = P["z"], ux = P["ux"], uz = P["uz"], vx = P["vx"], vz = P["vz"], hw = P["hw"], hd = P["hd"];
  const double mouthW = P.value("mouthW", 8.0), mouthTo = P.value("mouthTo", cz + hw + 4);
  auto at = [&](double u, double v) { return dvec2(cx + ux * u + vx * v, cz + uz * u + vz * v); };
  auto ground = [&](double x, double z) { return std::max(world.height(x, z), world.meshHeight(x, z)); };
  const double cy = world.height(cx, cz);
  // the bays: as Drive::freeBay lays them on a lot without its own (two rows along the long sides, 2.6 m apart, their
  // backs 0.25 m in from the edge, backed in: the nose out to the aisle)
  constexpr double BAY_W = 2.6, BAY_D = 5.7;
  nlohmann::json bays = nlohmann::json::array();
  std::vector<std::array<double, 4>> lines;   // u0, v0, u1, v1
  for (double side : {-1.0, 1.0}) {
    double last = -1e9;
    for (double u = -hw + 1.6; u <= hw - 1.6; u += BAY_W) {
      const double v = side * (hd - 2.85);
      const dvec2 p = at(u, v);
      bays.push_back({p.x, p.y, -vx * side, -vz * side});
      for (double e : {u - BAY_W / 2, u + BAY_W / 2}) if (e > last + 0.01) { lines.push_back({e, side * (hd - 0.05), e, side * (hd - 0.05 - BAY_D)}); last = e; }
    }
  }
  const dvec2 mouth = at(hw + 2, 0);
  (*lot)["name"] = P.value("name", std::string("Autohaus car park"));
  (*lot)["x"] = cx; (*lot)["z"] = cz; (*lot)["y"] = cy; (*lot)["ux"] = ux; (*lot)["uz"] = uz; (*lot)["vx"] = vx; (*lot)["vz"] = vz;
  (*lot)["hw"] = hw; (*lot)["hd"] = hd; (*lot)["ex"] = mouth.x; (*lot)["ez"] = mouth.y; (*lot)["dirx"] = P.value("dirx", ux); (*lot)["dirz"] = P.value("dirz", uz);
  (*lot)["bays"] = bays;
  // ---- the meshes: the asphalt (1 m grid over the lot and its mouth, 5 cm over the ground) and the lines (2 cm over it)
  int lotMat = -1;
  for (size_t k = 0; k < j["materials"].size(); k++)
    if (j["materials"][k].value("tag", std::string()) == "roadsnow-lot") { lotMat = int(k); break; }
  if (lotMat < 0) { SL_WARN("village: no car park material in the transport pack: the Autohaus car park is not drawn"); return; }
  const int paintMat = int(j["materials"].size());
  j["materials"].push_back({{"color", {0.87, 0.875, 0.85}}, {"opacity", 1}, {"transparent", false}, {"double", false}, {"rough", 0.92}, {"metal", 0}, {"vc", false},
                            {"emissive", {0, 0, 0}}, {"map", nullptr}, {"emissiveMap", nullptr}, {"alphaTest", 0}, {"glow", 0}, {"glb", nullptr}, {"nightEmissive", 0},
                            {"night", nullptr}, {"basic", false}, {"tag", "rentalpark-paint"}});
  auto put = [&](const void* data, size_t bytes) {
    while (bin.size() % 4) bin.push_back(0);
    const size_t off = bin.size();
    bin.insert(bin.end(), static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + bytes);
    return off;
  };
  const dvec3 origin(cx, cy, cz);
  auto vert = [&](std::vector<uint8_t>& vb, double x, double y, double z) {
    const float pos[3] = {float(x - origin.x), float(y - origin.y), float(z - origin.z)};
    const int8_t nrm[4] = {0, 127, 0, 0};
    const float uv[2] = {float(x * 0.0754), float(z * 0.0754)};
    const uint8_t col[4] = {255, 255, 255, 0};
    uint8_t raw[28];
    std::memcpy(raw, pos, 12); std::memcpy(raw + 12, nrm, 4); std::memcpy(raw + 16, uv, 8); std::memcpy(raw + 24, col, 4);
    vb.insert(vb.end(), raw, raw + 28);
  };
  auto mesh = [&](int mat, const std::vector<uint8_t>& vb, const std::vector<uint16_t>& ib) {
    if (ib.empty()) return;
    const size_t vOff = put(vb.data(), vb.size()), iOff = put(ib.data(), ib.size() * 2);
    j["meshes"].push_back({{"mat", mat}, {"verts", vb.size() / 28}, {"tris", ib.size() / 3}, {"vOff", vOff}, {"iOff", iOff}, {"i16", true},
                           {"origin", {origin.x, origin.y, origin.z}}});
  };
  // a grid patch over [u0, u1] x [v0, v1] of the lot's frame (counter-clockwise seen from above)
  std::vector<uint8_t> vb;
  std::vector<uint16_t> ib;
  auto patch = [&](double u0, double u1, double v0, double v1, double lift) {
    const int nu = std::max(1, int(std::ceil((u1 - u0) / 1.0))), nv = std::max(1, int(std::ceil((v1 - v0) / 1.0)));
    const uint16_t base = uint16_t(vb.size() / 28);
    for (int a = 0; a <= nu; a++)
      for (int b = 0; b <= nv; b++) {
        const dvec2 p = at(u0 + (u1 - u0) * a / nu, v0 + (v1 - v0) * b / nv);
        vert(vb, p.x, ground(p.x, p.y) + lift, p.y);
      }
    const bool flip = (ux * vz - uz * vx) > 0;   // (the frame's handedness: keep the faces up)
    for (int a = 0; a < nu; a++)
      for (int b = 0; b < nv; b++) {
        const uint16_t p0 = uint16_t(base + a * (nv + 1) + b), p1 = uint16_t(p0 + 1), p2 = uint16_t(p0 + nv + 1), p3 = uint16_t(p2 + 1);
        if (flip) for (uint16_t k : {p0, p1, p2, p1, p3, p2}) ib.push_back(k);
        else for (uint16_t k : {p0, p2, p1, p1, p2, p3}) ib.push_back(k);
      }
  };
  patch(-hw, hw, -hd, hd, 0.05);
  // the mouth: from the lot's end to the road (its edge under the road's ribbon)
  {
    const double uEnd = std::fabs(uz) > 0.5 ? std::max(hw + 0.5, (mouthTo - cz) / uz) : hw + 4;
    patch(hw, uEnd, -mouthW / 2, mouthW / 2, 0.045);
  }
  const size_t lotTris = ib.size() / 3;
  mesh(lotMat, vb, ib);
  vb.clear(); ib.clear();
  for (const auto& L : lines) {
    const double w = 0.06;
    patch(L[0] - w, L[0] + w, std::min(L[1], L[3]), std::max(L[1], L[3]), 0.07);
  }
  mesh(paintMat, vb, ib);
  SL_INFO("village: the Autohaus car park at (%.0f, %.0f): %zu bays, %zu asphalt triangles, %zu lines", cx, cz, bays.size(), lotTris, lines.size());
}

void Village::applyToPack(const std::string& pack, nlohmann::json& j, std::vector<uint8_t>& bin, World& world,
                          const std::function<std::shared_ptr<Model>(const std::string&)>& model) const {
  if (j_) applyMoves(pack, j, bin);
  if (j_ && pack == "transport") addRoads(j, bin, world);
  if (!j_ || pack != j_->value("clear", nlohmann::json::object()).value("pack", std::string("resort"))) return;
  const nlohmann::json& V = *j_;
  const auto& C = V["clear"];
  const auto& zone = C["zone"];
  const auto& keep = C["keep"];
  auto clearedAt = [&](double x, double z) {
    if (!inPoly(x, z, zone)) return false;
    for (auto& k : keep) if (inPoly(x, z, k)) return false;
    return true;
  };
  // ---- the old village's props out (the eight hotels, the lamp ring, snowmen, firewood), with their colliders
  std::vector<dvec2> gone;
  size_t nGone = 0;
  for (auto& p : j["props"]) {
    const std::string m = p.value("model", std::string());
    bool listed = false;
    for (auto& c : C["models"]) if (c.get<std::string>() == m) listed = true;
    if (!listed) continue;
    auto inst = instances(p, bin);
    nlohmann::json keepRows = nlohmann::json::array();
    for (const auto& M : inst) {
      if (clearedAt(M[3][0], M[3][2])) { gone.push_back(dvec2(M[3][0], M[3][2])); nGone++; continue; }
      keepRows.push_back(toRows34(M));
    }
    p.erase("instOff"); p.erase("instN");
    p["inst"] = keepRows;
  }
  {
    nlohmann::json cols = nlohmann::json::array();
    size_t n0 = j["colliders"].size();
    for (auto& c : j["colliders"]) {
      const dvec2 at(c["x"].get<double>(), c["z"].get<double>());
      bool drop = false;
      for (const dvec2& g : gone) if (glm::length(g - at) < 0.6) { drop = true; break; }
      if (!drop) cols.push_back(c);
    }
    j["colliders"] = std::move(cols);
    SL_INFO("village: %zu props of the old village out, %zu colliders with them", nGone, n0 - j["colliders"].size());
  }
  // ---- the old cobble paths out (triangle by triangle, inside the village)
  size_t trisOut = 0;
  for (auto& m : j["meshes"]) {
    const int mat = m["mat"];
    bool listed = false;
    for (auto& c : C["meshMats"]) if (c.get<int>() == mat) listed = true;
    if (!listed) continue;
    const size_t verts = m["verts"], tris = m["tris"], vOff = m["vOff"], iOff = m["iOff"];
    const bool i16 = m.value("i16", false);
    if (vOff + verts * 28 > bin.size() || iOff + tris * 3 * (i16 ? 2 : 4) > bin.size()) continue;
    const double ox = m["origin"][0], oz = m["origin"][2];
    auto idx = [&](size_t k) -> uint32_t {
      if (i16) { uint16_t v; std::memcpy(&v, bin.data() + iOff + k * 2, 2); return v; }
      uint32_t v; std::memcpy(&v, bin.data() + iOff + k * 4, 4); return v;
    };
    auto put = [&](size_t k, uint32_t v) {
      if (i16) { const uint16_t s = uint16_t(v); std::memcpy(bin.data() + iOff + k * 2, &s, 2); }
      else std::memcpy(bin.data() + iOff + k * 4, &v, 4);
    };
    size_t kept = 0;
    for (size_t t = 0; t < tris; t++) {
      const uint32_t a = idx(t * 3), b = idx(t * 3 + 1), c = idx(t * 3 + 2);
      double cx = 0, cz = 0;
      for (uint32_t v : {a, b, c}) {
        if (v >= verts) continue;
        float q[3];
        std::memcpy(q, bin.data() + vOff + size_t(v) * 28, 12);
        cx += q[0] / 3.0; cz += q[2] / 3.0;
      }
      if (clearedAt(ox + cx, oz + cz)) { trisOut++; continue; }
      put(kept * 3, a); put(kept * 3 + 1, b); put(kept * 3 + 2, c);
      kept++;
    }
    m["tris"] = kept;
  }
  // ---- the new props: buildings, walls, the stair, lamps, trees, benches, fountains, shelters, snow banks
  struct Group { std::string model; float glow; nlohmann::json rows = nlohmann::json::array(); };
  std::vector<Group> groups;
  size_t nAdd = 0, nCol = 0;
  placed_.clear();
  for (auto& p : V["props"]) {
    const std::string name = p["m"];
    auto M = model(name);
    if (!M || M->bmax.x < M->bmin.x) { SL_WARN("village: model '%s' missing", name.c_str()); continue; }
    const double x = p["x"], z = p["z"], yaw = p["yaw"];
    const dvec3 s(p["s"][0].get<double>(), p["s"][1].get<double>(), p["s"][2].get<double>());
    const dvec3 bmin(M->bmin), bmax(M->bmax);
    const double cx = (bmin.x + bmax.x) * 0.5, cz = (bmin.z + bmax.z) * 0.5;
    const double hw = (bmax.x - bmin.x) * 0.5 * s.x, hd = (bmax.z - bmin.z) * 0.5 * s.z;
    const double c = std::cos(yaw), sn = std::sin(yaw);
    // the ground under its footprint (the corners, the edges' middles, the centre)
    double gmin = 1e30, gmax = -1e30;
    const double gc = world.height(x, z);
    for (int u = -1; u <= 1; u++) for (int v = -1; v <= 1; v++) {
      const double lx = u * hw * 0.92, lz = v * hd * 0.92;
      const double g = world.height(x + lx * c + lz * sn, z - lx * sn + lz * c);
      gmin = std::min(gmin, g); gmax = std::max(gmax, g);
    }
    const std::string mode = p.value("ground", std::string("min"));
    const double g = mode == "center" ? gc : mode == "max" ? gmax : gmin;
    const double y = g - p.value("sink", 0.0);
    placed_.push_back({name, x, z, yaw, hw, hd, y, (bmax.y - bmin.y) * s.y});
    glm::dmat4 T = glm::translate(glm::dmat4(1), dvec3(x, y, z));
    T = glm::rotate(T, yaw, dvec3(0, 1, 0));
    T = glm::scale(T, s);
    T = glm::translate(T, dvec3(-cx, -bmin.y, -cz));
    const float glow = p.value("glow", 0.f);
    Group* gr = nullptr;
    for (auto& q : groups) if (q.model == name && q.glow == glow) gr = &q;
    if (!gr) { groups.push_back({name, glow}); gr = &groups.back(); }
    gr->rows.push_back(toRows34(T));
    nAdd++;
    if (p.contains("col") && p["col"].is_object()) {
      const auto& k = p["col"];
      nlohmann::json col = {{"x", x}, {"z", z}};
      if (k.contains("r")) col["r"] = k["r"];
      else { const double f = k.value("k", 0.42); col["hw"] = hw * 2 * f; col["hd"] = hd * 2 * f; col["rot"] = -yaw; }
      if (k.contains("top")) col["top"] = (k["top"] == "max" ? gmax : gc) + k.value("topAdd", 0.0);
      if (k.contains("brk")) col["brk"] = k["brk"];
      if (k.value("lamp", 0) != 0) col["lamp"] = 1;
      j["colliders"].push_back(col);
      nCol++;
    }
  }
  for (auto& gr : groups) j["props"].push_back({{"model", gr.model}, {"glow", gr.glow}, {"inst", gr.rows}});
  // ---- the new paving: the exported cobble material (a 3 m strip whose sides fade into the snow, as decor.js lays it)
  // along the streets: a wider street as overlapping 3 m strips (their faded sides blend into one another), 3 vertices
  // across each, 1.5 m apart along, on the drawn terrain
  const int pathMat = V.value("pathMat", -1);
  size_t nPathTris = 0;
  constexpr double STRIP = 3.0, PITCH = 2.2;
  auto strip = [&](const std::vector<dvec2>& sm, double centre, double w, double lift) {
    const dvec3 origin(sm[0].x, world.height(sm[0].x, sm[0].y), sm[0].y);
    while (bin.size() % 4) bin.push_back(0);
    const size_t vOff = bin.size();
    double v = 0;
    for (size_t i = 0; i < sm.size(); i++) {
      dvec2 d = sm[std::min(sm.size() - 1, i + 1)] - sm[i ? i - 1 : 0];
      d /= std::max(1e-6, glm::length(d));
      const dvec2 r(-d.y, d.x);
      if (i) v += glm::length(sm[i] - sm[i - 1]) / w;
      for (int a = 0; a < 3; a++) {
        const dvec2 q = sm[i] + r * (centre + (a - 1) * w * 0.5);
        const double y = world.meshHeight(q.x, q.y) + 0.03 + lift;
        const float pos[3] = {float(q.x - origin.x), float(y - origin.y), float(q.y - origin.z)};
        const int8_t nrm[4] = {0, 127, 0, 0};
        const float uv[2] = {float(a * 0.5), float(v)};
        const uint8_t col[4] = {255, 255, 255, 255};
        const size_t o = bin.size();
        bin.resize(o + 28);
        std::memcpy(bin.data() + o, pos, 12);
        std::memcpy(bin.data() + o + 12, nrm, 4);
        std::memcpy(bin.data() + o + 16, uv, 8);
        std::memcpy(bin.data() + o + 24, col, 4);
      }
    }
    const size_t verts = sm.size() * 3, iOff = bin.size();
    size_t tris = 0;
    for (size_t i = 0; i + 1 < sm.size(); i++)
      for (int a = 0; a < 2; a++) {
        const uint16_t p0 = uint16_t(i * 3 + a), p1 = uint16_t(i * 3 + a + 1), p2 = uint16_t((i + 1) * 3 + a), p3 = uint16_t((i + 1) * 3 + a + 1);
        for (uint16_t k : {p0, p2, p1, p1, p2, p3}) { bin.push_back(uint8_t(k & 255)); bin.push_back(uint8_t(k >> 8)); }
        tris += 2;
      }
    if (verts > 65535) return;
    j["meshes"].push_back({{"mat", pathMat}, {"verts", verts}, {"tris", tris}, {"vOff", vOff}, {"iOff", iOff}, {"i16", true},
                           {"origin", {origin.x, origin.y, origin.z}}});
    nPathTris += tris;
  };
  if (pathMat >= 0) {
    for (auto& path : V["paths"]) {
      const double w = path["w"];
      std::vector<dvec2> pts;
      for (auto& q : path["pts"]) pts.push_back(dvec2(q[0].get<double>(), q[1].get<double>()));
      if (pts.size() < 2) continue;
      std::vector<dvec2> sm;   // resampled every 1.5 m
      for (size_t i = 0; i + 1 < pts.size(); i++) {
        const double L = glm::length(pts[i + 1] - pts[i]);
        const int n = std::max(1, int(std::ceil(L / 1.5)));
        for (int k = 0; k < n; k++) sm.push_back(pts[i] + (pts[i + 1] - pts[i]) * (double(k) / n));
      }
      sm.push_back(pts.back());
      if (w <= STRIP + 0.3) { strip(sm, 0, w, 0); continue; }
      const int n = int(std::ceil((w - STRIP) / PITCH)) + 1;
      for (int k = 0; k < n; k++) strip(sm, -(w - STRIP) * 0.5 + (w - STRIP) * k / (n - 1), STRIP, 0.004 * k);
    }
  }
  SL_INFO("village: %zu props in (%zu models), %zu colliders; %zu old path triangles out, %zu new", nAdd, groups.size(), nCol, trisOut, nPathTris);
}

} // namespace sl
