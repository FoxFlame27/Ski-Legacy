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

void Village::applyToPack(const std::string& pack, nlohmann::json& j, std::vector<uint8_t>& bin, World& world,
                          const std::function<std::shared_ptr<Model>(const std::string&)>& model) const {
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
