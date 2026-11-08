#include "world/transport.h"
#include "core/log.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace sl {

namespace {
int64_t gkey(int64_t cx, int64_t cz) { return (cx << 32) ^ (cz & 0xffffffff); }
template <class T> std::vector<T> arr(const nlohmann::json& a, const std::vector<uint8_t>& bin) {
  std::vector<T> out;
  if (!a.is_object()) return out;
  size_t off = a["off"], n = a["n"];
  if (off + n * sizeof(T) > bin.size()) return out;
  out.resize(n);
  std::memcpy(out.data(), bin.data() + off, n * sizeof(T));
  return out;
}
Road readRoad(const nlohmann::json& r, const std::vector<uint8_t>& bin) {
  Road o;
  o.n = r["n"]; o.length = r["length"];
  o.X = arr<float>(r["X"], bin); o.Y = arr<float>(r["Y"], bin); o.Z = arr<float>(r["Z"], bin); o.S = arr<float>(r["S"], bin);
  o.from = r.value("from", -1); o.to = r.value("to", -1);
  o.access = r.value("access", false); o.scenic = r.value("scenic", false); o.depot = r.value("depot", false); o.heli = r.value("heli", false);
  o.ring = r.value("ring", false); o.loop = r.value("loop", false); o.chalet = r.value("chalet", false);
  if (r.contains("prof")) {
    auto& p = r["prof"];
    o.kmh = arr<int16_t>(p["kmh"], bin); o.limF = arr<float>(p["limF"], bin); o.limB = arr<float>(p["limB"], bin);
    o.vcF = arr<float>(p["vcF"], bin); o.vcB = arr<float>(p["vcB"], bin);
  }
  if (int(o.X.size()) != o.n || int(o.S.size()) != o.n) o.n = 0;
  return o;
}
Transport::Station readStation(const nlohmann::json& s) {
  Transport::Station st;
  st.id = s.value("id", std::string()); st.name = s.value("name", std::string());
  st.course = s["course"].is_string() ? s["course"].get<std::string>() : "";
  st.s = s.value("s", 0.0); st.s0 = s.value("s0", st.s); st.s1 = s.value("s1", st.s);
  st.side = s["side"].is_number() ? s["side"].get<double>() : 1; st.halt = s.value("halt", false); st.underground = s.value("underground", false);
  st.heading = s.value("heading", 0.0);
  st.pos = dvec3(s.value("x", 0.0), s.value("y", 0.0), s.value("z", 0.0));
  if (s["board"].is_array()) { st.board = dvec2(s["board"][0].get<double>(), s["board"][1].get<double>()); st.hasBoard = true; }
  if (s["exit"].is_array()) { st.exit = dvec3(s["exit"][0].get<double>(), s["exit"][1].get<double>(), s["exit"][2].get<double>()); st.hasExit = true; }
  return st;
}
std::vector<Span> spans(const nlohmann::json& a) {
  std::vector<Span> o;
  for (auto& t : a) o.push_back({t["s0"].get<double>(), t["s1"].get<double>(), t.value("end", false)});
  return o;
}
mat4 mat16(const nlohmann::json& a) {
  mat4 m(1);
  if (a.is_array() && a.size() == 16) for (int c = 0; c < 4; c++) for (int r = 0; r < 4; r++) m[c][r] = a[size_t(c * 4 + r)].get<float>();
  return m;
}
} // namespace

int Road::indexAt(double s) const {
  if (s <= 0 || n < 2) return 0;
  if (s >= S[size_t(n - 1)]) return n - 1;
  int lo = 0, hi = n - 1;
  while (hi - lo > 1) { int m = (lo + hi) >> 1; if (S[size_t(m)] <= s) lo = m; else hi = m; }
  return lo;
}

RoadPoint roadAt(const Road& r, double s) {
  RoadPoint o;
  if (r.n < 2) return o;
  s = clamp(s, 0, double(r.S[size_t(r.n - 1)]));
  int lo = r.indexAt(s), hi = std::min(r.n - 1, lo + 1);
  double t = (s - r.S[size_t(lo)]) / std::max(1e-6, double(r.S[size_t(hi)] - r.S[size_t(lo)]));
  t = clamp(t, 0, 1);
  o.x = r.X[size_t(lo)] + (r.X[size_t(hi)] - r.X[size_t(lo)]) * t;
  o.y = r.Y[size_t(lo)] + (r.Y[size_t(hi)] - r.Y[size_t(lo)]) * t;
  o.z = r.Z[size_t(lo)] + (r.Z[size_t(hi)] - r.Z[size_t(lo)]) * t;
  int a = std::max(0, lo - 1), b = std::min(r.n - 1, hi + 1);
  double dx = r.X[size_t(b)] - r.X[size_t(a)], dz = r.Z[size_t(b)] - r.Z[size_t(a)], l = std::hypot(dx, dz);
  if (l < 1e-9) l = 1;
  o.dx = dx / l; o.dz = dz / l;
  o.grade = (r.Y[size_t(b)] - r.Y[size_t(a)]) / std::max(1e-6, double(r.S[size_t(b)] - r.S[size_t(a)]));
  o.i = lo;
  return o;
}

// ---------------------------------------------------------------- Line
Line::P Line::at(double s) const {
  P o{0, 0, 0, 0, 1, 0};
  if (n < 2) return o;
  int i, j;
  double t;
  if (ring) {
    double f = wrap(s) / step;
    i = int(std::floor(f)) % n; j = (i + 1) % n; t = f - std::floor(f);
  } else {
    double f = clamp(s / step, 0, n - 1.0001);
    i = int(std::floor(f)); j = i + 1; t = f - i;
  }
  o.x = X[size_t(i)] + (X[size_t(j)] - X[size_t(i)]) * t;
  o.y = Y[size_t(i)] + (Y[size_t(j)] - Y[size_t(i)]) * t;
  o.z = Z[size_t(i)] + (Z[size_t(j)] - Z[size_t(i)]) * t;
  double dx = X[size_t(j)] - X[size_t(i)], dz = Z[size_t(j)] - Z[size_t(i)], l = std::hypot(dx, dz);
  if (l < 1e-9) l = 1;
  o.dx = dx / l; o.dz = dz / l;
  o.grade = (Y[size_t(j)] - Y[size_t(i)]) / l;
  return o;
}
void Line::index() {
  grid_.clear();
  const int C = 8;
  const double R = 20, CELL = 64;
  int last = ring ? n : n - 1;
  for (int i0 = 0; i0 < last; i0 += C) {
    int i1 = ring ? (i0 + C) % n : std::min(n - 1, i0 + C);
    double minx = std::min(X[size_t(i0)], X[size_t(i1)]) - R, maxx = std::max(X[size_t(i0)], X[size_t(i1)]) + R;
    double minz = std::min(Z[size_t(i0)], Z[size_t(i1)]) - R, maxz = std::max(Z[size_t(i0)], Z[size_t(i1)]) + R;
    for (int64_t cx = int64_t(std::floor(minx / CELL)); cx <= int64_t(std::floor(maxx / CELL)); cx++)
      for (int64_t cz = int64_t(std::floor(minz / CELL)); cz <= int64_t(std::floor(maxz / CELL)); cz++) grid_[gkey(cx, cz)].push_back(i0);
  }
}
Line::Near Line::nearest(double x, double z, double maxD) const {
  Near out;
  auto it = grid_.find(gkey(int64_t(std::floor(x / 64)), int64_t(std::floor(z / 64))));
  if (it == grid_.end()) return out;
  double best = maxD * maxD;
  for (int i0 : it->second) {
    for (int k = -2; k < 10; k++) {
      int i = i0 + k, j;
      if (ring) { i = (i + n) % n; j = (i + 1) % n; }
      else { if (i < 0 || i >= n - 1) continue; j = i + 1; }
      double ax = X[size_t(i)], az = Z[size_t(i)], ex = X[size_t(j)] - ax, ez = Z[size_t(j)] - az, l2 = ex * ex + ez * ez;
      if (l2 < 1e-12) l2 = 1;
      double t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
      double px = ax + ex * t - x, pz = az + ez * t - z, d = px * px + pz * pz;
      if (d < best) { best = d; out.d = std::sqrt(d); out.s = wrap((i + t) * step); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- loading
bool Transport::load(const nlohmann::json& net, const std::vector<uint8_t>& bin) {
  if (!net.is_object()) return false;
  for (auto& r : net["roads"]) roads.push_back(readRoad(r, bin));
  for (auto& r : net["busLegs"]) legs.push_back(readRoad(r, bin));
  for (auto& s : net["stops"]) stops.push_back({s["name"].get<std::string>(), s["x"].get<double>(), s["z"].get<double>(), s.value("heading", 0.0), s.value("noRoad", false)});
  for (auto& q : net["lots"]) {
    Lot L;
    L.name = q.value("name", std::string());
    L.x = q["x"]; L.z = q["z"]; L.y = q["y"]; L.ux = q["ux"]; L.uz = q["uz"]; L.vx = q["vx"]; L.vz = q["vz"]; L.hw = q["hw"]; L.hd = q["hd"]; L.ex = q["ex"]; L.ez = q["ez"];
    L.building = q.value("building", false); L.impound = q.value("impound", false); L.scenic = q.value("scenic", false); L.hospital = q.value("hospital", false); L.depot = q.value("depot", false);
    for (auto& b : q["bays"]) L.bays.push_back({b[0].get<double>(), b[1].get<double>(), b[2].get<double>(), b[3].get<double>()});
    lots.push_back(std::move(L));
  }
  for (auto& j : net["junctions"]) junctions.push_back(dvec2(j[0].get<double>(), j[1].get<double>()));
  for (auto& j : net["laybys"]) laybys.push_back(dvec3(j[0].get<double>(), j[1].get<double>(), j[2].get<double>()));
  for (auto& g : net["rails"]) rails.push_back({g[0].get<double>(), g[1].get<double>(), g[2].get<double>(), g[3].get<double>(), g[4].get<int>() != 0});
  for (auto& t : net["roadTunnels"]) {
    RoadTunnel T;
    T.wi = t.value("wi", 4.6); T.hc = t.value("hc", 6.6);
    for (auto& p : t["pts"]) {
      dvec3 q(p[0].get<double>(), p[2].get<double>(), p[1].get<double>());   // (x, floor, z)
      T.pts.push_back(q);
      T.bmin = glm::min(T.bmin, dvec2(q.x, q.z) - dvec2(T.wi + 4)); T.bmax = glm::max(T.bmax, dvec2(q.x, q.z) + dvec2(T.wi + 4));
    }
    if (T.pts.size() > 1) tunnels.push_back(std::move(T));
  }
  for (auto& p : net["parked"]) parked.push_back({p["name"].get<std::string>(), dvec3(p["x"].get<double>(), p["y"].get<double>(), p["z"].get<double>()), p["yaw"].get<double>(), p["length"].get<double>()});
  if (net["autohaus"].is_object()) {
    auto& a = net["autohaus"];
    hasAutohaus = true; autohaus = dvec3(a["x"].get<double>(), a["y"].get<double>(), a["z"].get<double>()); autohausDir = dvec2(a["dirx"].get<double>(), a["dirz"].get<double>());
  }
  for (auto& c : net["cars"]) {
    CarSpec s;
    s.name = c["name"]; s.label = c.value("label", s.name); s.kind = c.value("kind", std::string());
    s.accel = c.value("accel", 5.0); s.top = c.value("top", 55.0); s.electric = c.value("electric", false); s.rev = c.value("rev", 1.0);
    s.mass = c.value("mass", 1700.0); s.drive = c.value("drive", std::string("awd")); s.length = c.value("length", 4.7); s.price = c.value("price", 0.0);
    if (c["size"].is_array()) s.size = vec3(c["size"][0].get<float>(), c["size"][1].get<float>(), c["size"][2].get<float>());
    s.fit = mat16(c["fit"]);
    for (auto& h : c["hide"]) s.hide.push_back(h.get<std::string>());
    for (auto& g : c["glass"]) s.glass.push_back({g["i"].get<int>(), g.value("red", false), g.value("clear", false)});
    cars.push_back(std::move(s));
  }
  if (net["bus"].is_object()) {
    auto& b = net["bus"];
    bus.ok = true; bus.model = b.value("model", std::string("ski_bus_micruss")); bus.fit = mat16(b["fit"]);
    auto& B = b["BUS"];
    bus.len = B.value("len", 9.3); bus.width = B.value("width", 2.55); bus.floor = B.value("floor", 0.95); bus.lane = B.value("lane", 1.55);
    bus.cruise = B.value("cruise", 26.0); bus.acc = B.value("acc", 1.7); bus.brake = B.value("brake", 2.0); bus.lat = B.value("lat", 2.6);
    bus.wheelBase = b.value("wheelBase", 6.8); bus.fleet = b.value("fleet", 8);
    for (auto& g : b["glass"]) if (g.is_number()) busGlass.push_back(g.get<int>());
    for (auto& g : b["paint"]) if (g.is_number()) busPaint.push_back(g.get<int>());
    for (auto& s : b["seats"]) bus.seats.push_back({vec3(s["p"][0].get<float>(), s["p"][1].get<float>(), s["p"][2].get<float>()), s.value("window", false), s.value("side", 1), s.value("row", 0)});
  }
  if (net["rail"].is_object()) {
    auto& r = net["rail"];
    auto& R = rail;
    R.name = r.value("name", std::string("Wolkenspitzbahn"));
    R.line.step = r["step"]; R.line.n = r["n"]; R.line.length = r["length"];
    auto X = arr<float>(r["X"], bin), Y = arr<float>(r["Y"], bin), Z = arr<float>(r["Z"], bin);
    R.line.X.assign(X.begin(), X.end()); R.line.Y.assign(Y.begin(), Y.end()); R.line.Z.assign(Z.begin(), Z.end());
    R.line.index();
    for (auto& s : r["stations"]) R.stations.push_back(readStation(s));
    for (auto& s : r["list"]) for (auto& st : R.stations) if (st.id == s["id"].get<std::string>()) {
      if (s["board"].is_array()) { st.board = dvec2(s["board"][0].get<double>(), s["board"][1].get<double>()); st.hasBoard = true; }
      if (s["exit"].is_array()) { st.exit = dvec3(s["exit"][0].get<double>(), s["exit"][1].get<double>(), s["exit"][2].get<double>()); st.hasExit = true; }
      if (s["name"].is_string()) st.name = s["name"];
    }
    R.tunnels = spans(r["tunnels"]); R.bridges = spans(r["bridges"]);
    if (r["loop"].is_object()) { R.loop.s0 = r["loop"]["s0"]; R.loop.s1 = r["loop"]["s1"]; R.loop.off = r["loop"]["off"]; R.loop.ease = r["loop"]["ease"]; }
    R.V = arr<float>(r["V"], bin); R.T = arr<float>(r["T"], bin);
    R.i0 = r["i0"]; R.i1 = r["i1"]; R.trip = r["trip"]; R.dwellMid = r["dwellMid"]; R.dwellEnd = r["dwellEnd"]; R.dwellBot = r["dwellBot"];
    R.cycle = r["cycle"]; R.tripS0 = r["tripS0"]; R.tripS1 = r["tripS1"];
    for (auto& s : r["stops"]) R.stops.push_back({s["id"].get<std::string>(), s["i"].get<int>()});
    R.units = r.value("units", 2); R.price = r.value("price", 50);
    if (r["car"].is_object()) { auto& c = r["car"]; R.car.len = c["len"]; R.car.half = c["half"]; R.car.hw = c["hw"]; R.car.floor = c["floor"]; R.car.bogie = c["bogie"]; R.car.gap = c["gap"]; R.car.roofTop = c["roofTop"]; }
    if (r["body"].is_object()) { R.bodyFit = mat16(r["body"]["fit"]); R.hasBody = true; }
    if (r["seat"].is_object()) { R.seat = vec3(r["seat"]["p"][0].get<float>(), r["seat"]["p"][1].get<float>(), r["seat"]["p"][2].get<float>()); R.seatYaw = r["seat"]["yaw"]; }
    for (auto& b : r["bogies"]) R.bogies.push_back(vec3(b[0].get<float>(), b[1].get<float>(), b[2].get<float>()));
    railModels = r.contains("models") ? &r["models"] : nullptr;
    R.ok = R.line.n > 2 && int(R.V.size()) == R.line.n;
  }
  if (net["express"].is_object()) {
    auto& e = net["express"];
    auto& E = express;
    E.name = e.value("name", std::string("Legacy Express"));
    E.line.ring = true; E.line.step = e["step"]; E.line.n = e["n"]; E.line.length = e["length"];
    auto X = arr<float>(e["X"], bin), Y = arr<float>(e["Y"], bin), Z = arr<float>(e["Z"], bin);
    E.line.X.assign(X.begin(), X.end()); E.line.Y.assign(Y.begin(), Y.end()); E.line.Z.assign(Z.begin(), Z.end());
    E.line.index();
    E.trackOff = e.value("trackOff", 2.3); E.loop = e["loop"]; E.dwell = e.value("dwell", 30.0); E.vmax = e.value("vmax", 125.0); E.price = e.value("price", 75);
    E.fast = e.value("fast", 10.0);
    E.tunnels = spans(e["tunnels"]); E.bridges = spans(e["bridges"]);
    E.V = arr<float>(e["V"], bin); E.T = arr<float>(e["T"], bin);
    for (auto& s : e["stations"]) E.stations.push_back(readStation(s));
    E.ok = E.line.n > 2 && int(E.V.size()) == E.line.n + 1 && !E.stations.empty();
  }
  // grids: lanes (16 m), guardrails (16 m), speed limits (24 m)
  const double LC = 16, PAD = 16;
  for (size_t ri = 0; ri < roads.size(); ri++) {
    const Road& r = roads[ri];
    for (int i = 0; i + 1 < r.n; i++) {
      Seg sg{r.X[size_t(i)], r.Z[size_t(i)], r.X[size_t(i + 1)], r.Z[size_t(i + 1)], int(ri), r.S[size_t(i)]};
      for (int64_t gx = int64_t(std::floor((std::min(sg.ax, sg.bx) - PAD) / LC)); gx <= int64_t(std::floor((std::max(sg.ax, sg.bx) + PAD) / LC)); gx++)
        for (int64_t gz = int64_t(std::floor((std::min(sg.az, sg.bz) - PAD) / LC)); gz <= int64_t(std::floor((std::max(sg.az, sg.bz) + PAD) / LC)); gz++)
          laneGrid_[gkey(gx, gz)].push_back(sg);
    }
    for (int i = 0; i < r.n; i++) limitGrid_[gkey(int64_t(std::floor(r.X[size_t(i)] / 24)), int64_t(std::floor(r.Z[size_t(i)] / 24)))].push_back({int(ri), i});
  }
  for (size_t k = 0; k < rails.size(); k++) {
    const Guardrail& g = rails[k];
    for (int64_t gx = int64_t(std::floor(std::min(g.ax, g.bx) / 16)); gx <= int64_t(std::floor(std::max(g.ax, g.bx) / 16)); gx++)
      for (int64_t gz = int64_t(std::floor(std::min(g.az, g.bz) / 16)); gz <= int64_t(std::floor(std::max(g.az, g.bz) / 16)); gz++) railGrid_[gkey(gx, gz)].push_back(int(k));
  }
  SL_INFO("transport: %zu roads, %zu bus legs, %zu stops, %zu car parks, %zu guardrail lines, %zu road tunnels, %zu parked cars, %zu car models; rail %s (%zu stations), express %s (%zu stations)",
          roads.size(), legs.size(), stops.size(), lots.size(), rails.size(), tunnels.size(), parked.size(), cars.size(),
          rail.ok ? "ok" : "missing", rail.stations.size(), express.ok ? "ok" : "missing", express.stations.size());
  return !roads.empty();
}

const CarSpec* Transport::car(const std::string& name) const {
  for (auto& c : cars) if (c.name == name) return &c;
  return nullptr;
}

// ---------------------------------------------------------------- road queries
double Transport::laneDistance(double x, double z) const {
  auto it = laneGrid_.find(gkey(int64_t(std::floor(x / 16)), int64_t(std::floor(z / 16))));
  double d = 1e18;
  if (it == laneGrid_.end()) return d;
  for (const Seg& g : it->second) {
    double ex = g.bx - g.ax, ez = g.bz - g.az, l2 = ex * ex + ez * ez;
    if (l2 < 1e-12) l2 = 1;
    double t = clamp(((x - g.ax) * ex + (z - g.az) * ez) / l2, 0, 1);
    d = std::min(d, std::hypot(g.ax + ex * t - x, g.az + ez * t - z));
  }
  return d;
}
Transport::RoadHit Transport::nearestRoad(double x, double z, double maxD) const {
  RoadHit h;
  auto it = laneGrid_.find(gkey(int64_t(std::floor(x / 16)), int64_t(std::floor(z / 16))));
  if (it == laneGrid_.end()) return h;
  for (const Seg& g : it->second) {
    double ex = g.bx - g.ax, ez = g.bz - g.az, l2 = ex * ex + ez * ez;
    if (l2 < 1e-12) l2 = 1;
    double t = clamp(((x - g.ax) * ex + (z - g.az) * ez) / l2, 0, 1);
    double d = std::hypot(g.ax + ex * t - x, g.az + ez * t - z);
    if (d < h.d && d < maxD) { h.d = d; h.road = g.ri; h.s = g.s + std::sqrt(l2) * t; }
  }
  return h;
}
const RoadTunnel* Transport::inRoadTunnel(double x, double z, double y, double pad) const {
  for (const RoadTunnel& t : tunnels) {
    if (x < t.bmin.x || x > t.bmax.x || z < t.bmin.y || z > t.bmax.y) continue;
    for (size_t i = 0; i + 1 < t.pts.size(); i++) {
      const dvec3 &a = t.pts[i], &b = t.pts[i + 1];
      double ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
      if (l2 < 1e-9) continue;
      double u = clamp(((x - a.x) * ex + (z - a.z) * ez) / l2, 0, 1);
      double d = std::hypot(a.x + ex * u - x, a.z + ez * u - z), floor = a.y + (b.y - a.y) * u;
      if (d < t.wi + pad && y > floor - 1.5 && y < floor + t.hc + pad) return &t;
    }
  }
  return nullptr;
}
double Transport::roadSurface(const World& world, double x, double z, double mesh, double yHint) const {
  if (roads.empty()) return std::nan("");
  double exactHeight = std::nan("");
  auto exact = [&]() { if (std::isnan(exactHeight)) exactHeight = world.height(x, z); return exactHeight; };
  // in a road tunnel (below its crown: the mountain over it is ridden from above), the tube's floor
  for (const RoadTunnel& t : tunnels) {
    if (x < t.bmin.x || x > t.bmax.x || z < t.bmin.y || z > t.bmax.y) continue;
    for (size_t i = 0; i + 1 < t.pts.size(); i++) {
      const dvec3 &a = t.pts[i], &b = t.pts[i + 1];
      double ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
      if (l2 < 1e-9) continue;
      double u = ((x - a.x) * ex + (z - a.z) * ez) / l2;
      if (u < 0 || u > 1) continue;
      double d = std::hypot(a.x + ex * u - x, a.z + ez * u - z), floor = a.y + (b.y - a.y) * u;
      if (d < t.wi + 3 && yHint < floor + t.hc + 1.2 && floor < exact() - 1.0) return floor + 0.035;
    }
  }
  double d = laneDistance(x, z);
  if (d > ROAD_HALF + 2) return std::nan("");
  double r = exact() + 0.035;
  if (d <= ROAD_HALF + 0.5) return r;
  return r + (mesh - r) * clamp((d - ROAD_HALF - 0.5) / 1.5, 0, 1);
}
bool Transport::onTarmac(double x, double z) const {
  if (roads.empty()) return false;
  if (laneDistance(x, z) < ROAD_HALF + 0.9) return true;
  for (const Lot& L : lots) {
    double dx = x - L.x, dz = z - L.z;
    if (std::fabs(dx * L.ux + dz * L.uz) < L.hw + 0.5 && std::fabs(dx * L.vx + dz * L.vz) < L.hd + 0.5) return true;
    if (std::hypot(x - L.ex, z - L.ez) < 8) return true;
  }
  for (const dvec2& j : junctions) if (std::fabs(j.x - x) < 10 && std::fabs(j.y - z) < 10) return true;
  for (const dvec3& lb : laybys) {
    double fx = std::sin(lb.z), fz = std::cos(lb.z), dx = x - lb.x, dz = z - lb.y;
    if (std::fabs(dx * fx + dz * fz) < 10 && std::fabs(dx * fz - dz * fx) < 3) return true;
  }
  return false;
}
int Transport::speedLimitAt(double x, double z, double maxD) const {
  int64_t cx = int64_t(std::floor(x / 24)), cz = int64_t(std::floor(z / 24));
  double bd = maxD + 2.2;
  int br = -1, bi = 0;
  for (int64_t gx = cx - 1; gx <= cx + 1; gx++)
    for (int64_t gz = cz - 1; gz <= cz + 1; gz++) {
      auto it = limitGrid_.find(gkey(gx, gz));
      if (it == limitGrid_.end()) continue;
      for (auto& [ri, i] : it->second) {
        const Road& r = roads[size_t(ri)];
        double d = std::hypot(r.X[size_t(i)] - x, r.Z[size_t(i)] - z);
        if (d < bd) { bd = d; br = ri; bi = i; }
      }
    }
  if (br < 0 || roads[size_t(br)].kmh.empty()) return 0;
  return roads[size_t(br)].kmh[size_t(bi)];
}
const std::vector<int>* Transport::railsNear(double x, double z) const {
  auto it = railGrid_.find(gkey(int64_t(std::floor(x / 16)), int64_t(std::floor(z / 16))));
  return it == railGrid_.end() ? nullptr : &it->second;
}

// ---------------------------------------------------------------- track decks
bool Transport::inRailTunnel(double s) const {
  for (const Span& t : rail.tunnels) if (s > t.s0 && s < t.s1) return true;
  return false;
}
bool Transport::inExpressTunnel(double s) const {
  double L = express.line.length;
  for (const Span& t : express.tunnels) {
    double w = express.line.wrap(s);
    if ((w > t.s0 && w < t.s1) || (w - L > t.s0 && w - L < t.s1)) return true;
  }
  return false;
}
double Transport::loopOffset(double s) const {
  const auto& P = rail.loop;
  if (s <= P.s0 || s >= P.s1) return 0;
  return P.off * smoothstep(P.s0, P.s0 + P.ease, s) * (1 - smoothstep(P.s1 - P.ease, P.s1, s));
}
// railroute.js railDeckHeight: the ballast bed, sleepers, the tunnels' slab, the viaducts' decks, the platforms
double Transport::railDeckHeight(double x, double z) const {
  if (!rail.ok) return std::nan("");
  Line::Near n = rail.line.nearest(x, z, 10);
  if (n.d > 10) return std::nan("");
  double s = n.s;
  Line::P p = rail.line.at(s);
  double lat = (x - p.x) * -p.dz + (z - p.z) * p.dx;
  bool slab = inRailTunnel(s);
  auto trackTop = [&](double a, bool sl) -> double {
    if (a <= 0.525) return -0.24;
    if (sl) return a <= 1.9 ? -0.42 : std::nan("");
    if (a <= 1.55) return -0.36;
    return a <= 2.25 ? -0.36 - (a - 1.55) / 0.7 * 0.38 : std::nan("");
  };
  double top = trackTop(std::fabs(lat), slab);
  double off = loopOffset(s);
  if (off != 0) { double t2 = trackTop(std::fabs(lat - off), false); if (!std::isnan(t2) && (std::isnan(top) || t2 > top)) top = t2; }
  bool bridge = false;
  for (const Span& b : rail.bridges) if (s > b.s0 && s < b.s1) bridge = true;
  if (!slab && bridge && std::fabs(lat) <= 2.7 && (std::isnan(top) || top < -0.4)) top = -0.4;
  for (const Station& st : rail.stations) {
    if (st.underground || s < st.s0 + 4 || s > st.s1 - 4) continue;
    double l = lat * st.side;
    if (l >= 1.75 && l <= 5.95) top = 0.06;
  }
  return std::isnan(top) ? top : p.y + top;
}
// expressroute.js expressDeckHeight
double Transport::expressDeckHeight(double x, double z) const {
  if (!express.ok) return std::nan("");
  Line::Near n = express.line.nearest(x, z, 7.5);
  if (n.d > 7.5) return std::nan("");
  double s = n.s;
  if (inExpressTunnel(s)) return std::nan("");
  Line::P p = express.line.at(s);
  double lat = (x - p.x) * -p.dz + (z - p.z) * p.dx, a = std::fabs(lat), TO = express.trackOff, t = std::fabs(a - TO);
  bool bridge = false;
  double w = express.line.wrap(s), L = express.line.length;
  for (const Span& b : express.bridges) if ((w > b.s0 && w < b.s1) || (w - L > b.s0 && w - L < b.s1)) bridge = true;
  double top = std::nan("");
  if (bridge) { if (a <= 6.6) top = t <= 0.95 ? -0.15 : t <= 1.4 ? -0.25 : -0.55; }
  else if (a <= TO + 2.45) top = t <= 0.95 && a <= TO + 0.95 ? -0.15 : a <= TO + 1.6 ? -0.30 : -0.30 - (a - TO - 1.6) / 0.85 * 0.44;
  else if (std::fabs(a - TO - 3.9) <= 0.3) top = -0.5;
  return std::isnan(top) ? top : p.y + top;
}

} // namespace sl
