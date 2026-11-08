#include "game/play_data.h"
#include "core/log.h"
#include "core/noise.h"
#include <nlohmann/json.hpp>
#include <cstring>

namespace sl {

double CourseLine::sAt(const std::vector<float>& a, double s) const {
  if (a.empty()) return 0;
  double f = clamp(s / ds, 0.0, double(n) - 1.0001);
  int i = int(f);
  double t = f - i;
  return a[size_t(i)] + (a[size_t(i) + 1] - a[size_t(i)]) * t;
}

double CourseLine::heading(double s) const {
  double f = clamp(s / ds, 0.0, double(n) - 1.0001);
  int i = int(f);
  double a = H[size_t(i)], b = H[size_t(i) + 1];
  return a + wrapPi(b - a) * (f - i);
}

dvec3 CourseLine::point(double s, double lateral) const {
  double h = heading(s);
  return dvec3(sAt(X, s) - std::cos(h) * lateral, sAt(Y, s), sAt(Z, s) + std::sin(h) * lateral);
}

CourseLine::Proj CourseLine::project(double x, double z, double hintS, double window) const {
  Proj p;
  if (n < 2) return p;
  int i0 = 0, i1 = n - 1;
  if (hintS >= 0) { i0 = std::max(0, int((hintS - window) / ds)); i1 = std::min(n - 1, int((hintS + window) / ds)); }
  int best = i0;
  double bd = 1e30;
  for (int i = i0; i <= i1; i++) {
    double dx = X[size_t(i)] - x, dz = Z[size_t(i)] - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  // refine on the segment toward the nearer neighbour
  int j = best + 1 < n ? best + 1 : best - 1;
  double ax = X[size_t(best)], az = Z[size_t(best)], bx = X[size_t(j)], bz = Z[size_t(j)];
  double ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
  double t = L2 > 1e-9 ? clamp(((x - ax) * ex + (z - az) * ez) / L2, 0.0, 1.0) : 0;
  double s = (best + (j > best ? t : -t)) * ds;
  p.s = clamp(s, 0.0, length());
  double h = heading(p.s);
  dvec3 c = point(p.s);
  // lateral + toward (-cos h, sin h)
  p.lat = (x - c.x) * -std::cos(h) + (z - c.z) * std::sin(h);
  p.d = std::hypot(x - c.x, z - c.z);
  return p;
}

namespace {
std::vector<float> f32(const nlohmann::json& j, const std::vector<uint8_t>& bin) {
  std::vector<float> v;
  if (!j.is_object()) return v;
  size_t off = j.value("off", size_t(0)), n = j.value("n", size_t(0));
  if (off + n * 4 > bin.size()) return v;
  v.resize(n);
  std::memcpy(v.data(), bin.data() + off, n * 4);
  return v;
}
std::string str(const nlohmann::json& j, const char* k) { return j.contains(k) && j[k].is_string() ? j[k].get<std::string>() : std::string(); }
double num(const nlohmann::json& j, const char* k, double d = 0) { return j.contains(k) && j[k].is_number() ? j[k].get<double>() : d; }
CoursePt pt(const nlohmann::json& j) {
  CoursePt p;
  if (!j.is_object()) return p;
  p.x = num(j, "x"); p.y = num(j, "y"); p.z = num(j, "z"); p.heading = num(j, "heading"); p.s = num(j, "s"); p.name = str(j, "name");
  return p;
}
Site site(const nlohmann::json& j) {
  Site s;
  if (!j.is_object()) return s;
  s.ok = true;
  s.x = num(j, "x"); s.z = num(j, "z"); s.y = num(j, "y"); s.yaw = num(j, "yaw"); s.hw = num(j, "hw"); s.hd = num(j, "hd");
  s.ux = num(j, "ux", 1); s.uz = num(j, "uz"); s.vx = num(j, "vx"); s.vz = num(j, "vz", 1);
  s.ex = num(j, "ex", s.x); s.ez = num(j, "ez", s.z); s.dirx = num(j, "dirx"); s.dirz = num(j, "dirz", 1);
  return s;
}
uint32_t hexOf(const std::string& s) { return s.size() == 7 && s[0] == '#' ? uint32_t(std::stoul(s.substr(1), nullptr, 16)) : 0x2f7bff; }
Course parseCourse(const nlohmann::json& c, const std::vector<uint8_t>& bin) {
  Course o;
  o.id = str(c, "id"); o.name = str(c, "name"); o.diff = str(c, "diff"); o.ai = str(c, "ai"); o.tagline = str(c, "tagline");
  o.color = hexOf(str(c, "color"));
  o.entry = int(num(c, "entry")); o.reward = int(num(c, "reward")); o.rewardMax = int(num(c, "rewardMax")); o.drop = int(num(c, "drop"));
  o.length = num(c, "length"); o.par = num(c, "par");
  if (c.contains("medals") && c["medals"].is_object()) { o.gold = num(c["medals"], "gold"); o.silver = num(c["medals"], "silver"); o.bronze = num(c["medals"], "bronze"); }
  else if (o.par > 0) { o.gold = o.par * 1.02; o.silver = o.par * 1.08; o.bronze = o.par * 1.16; }
  o.bus = c.value("bus", false);
  o.stop = str(c, "stop"); o.end = str(c, "end");
  o.start = pt(c["start"]); o.finish = pt(c["finish"]);
  for (auto& q : c["checkpoints"]) o.checkpoints.push_back(pt(q));
  for (auto& g : c["gates"]) o.gates.push_back({num(g, "s"), num(g, "x"), num(g, "y"), num(g, "z"), num(g, "nx"), num(g, "nz"), num(g, "width", 8), int(num(g, "side", 1)), str(g, "color") == "blue"});
  auto& L = c["line"];
  o.line.n = int(num(L, "n")); o.line.ds = num(L, "ds", 2);
  o.line.X = f32(L["X"], bin); o.line.Y = f32(L["Y"], bin); o.line.Z = f32(L["Z"], bin);
  o.line.W = f32(L["W"], bin); o.line.H = f32(L["H"], bin); o.line.K = f32(L["K"], bin);
  if (int(o.line.X.size()) != o.line.n || int(o.line.H.size()) != o.line.n) o.line.n = 0;
  if (c.contains("board") && c["board"].is_object()) { o.hasBoard = true; o.boardX = num(c["board"], "x"); o.boardZ = num(c["board"], "z"); o.boardYaw = num(c["board"], "yaw"); }
  return o;
}
} // namespace

bool PlayData::load(const nlohmann::json& j, const std::vector<uint8_t>& bin) {
  for (auto& c : j["courses"]) { Course o = parseCourse(c, bin); if (o.line.n > 1) courses.push_back(std::move(o)); }
  for (auto& c : j["busRaces"]) { Course o = parseCourse(c, bin); if (o.line.n > 1) busRaces.push_back(std::move(o)); }
  if (j.contains("stand") && j["stand"].is_object()) { hasStand = true; standX = num(j["stand"], "x"); standZ = num(j["stand"], "z"); standYaw = num(j["stand"], "yaw"); }
  if (j.contains("jobs")) {
    auto& J = j["jobs"];
    for (auto& h : J["hubs"]) hubs.push_back({str(h, "id"), str(h, "kind"), str(h, "name"), str(h, "place"), num(h, "x"), num(h, "z"), num(h, "yaw"), num(h["front"], "x"), num(h["front"], "z"), h.value("hut", false)});
    for (auto& d : J["dests"]) {
      JobDest o;
      o.kind = str(d, "kind"); o.id = str(d, "id"); o.label = str(d, "label"); o.to = str(d, "to"); o.place = str(d, "place"); o.role = str(d, "role");
      o.hubId = str(d, "hubId"); o.lift = str(d, "lift"); o.peak = str(d, "peak"); o.race = str(d, "race");
      o.x = num(d, "x"); o.z = num(d, "z"); o.yaw = num(d, "yaw"); o.npc = d.value("npc", false); o.top = d.value("top", false);
      dests.push_back(o);
    }
    for (auto& s : J["spots"]) spots.push_back({num(s, "x"), num(s, "z"), num(s, "heading"), int(num(s, "side", 1)), str(s, "piste")});
    for (auto& l : J["lifts"]) {
      auto p2 = [&](const char* k) { return dvec2(num(l[k], "x"), num(l[k], "z")); };
      routerLifts.push_back({str(l, "name"), str(l, "type") == "gondola", num(l, "len"), p2("bottom"), p2("top"), p2("topExit"), p2("bottomExit")});
    }
  }
  for (auto& t : j["taxi"]) taxi.push_back({str(t, "name"), num(t, "x"), num(t, "z"), num(t, "sx"), num(t, "sz")});
  prison = site(j.value("prison", nlohmann::json())); rentalPark = site(j.value("rentalPark", nlohmann::json()));
  hospital = site(j.value("hospital", nlohmann::json())); rental = site(j.value("rental", nlohmann::json()));
  if (j.contains("helipad")) helipad = dvec2(num(j["helipad"], "x", 92), num(j["helipad"], "z", -128));
  for (auto& c : j["chalets"]) {
    ChaletHouse h;
    h.id = int(num(c, "id")); h.num = int(num(c, "num")); h.name = str(c, "name");
    h.x = num(c, "x"); h.y = num(c, "y"); h.z = num(c, "z"); h.yaw = num(c, "yaw");
    if (c.contains("door") && c["door"].is_object()) { h.doorX = num(c["door"], "x"); h.doorZ = num(c["door"], "z"); } else { h.doorX = h.x; h.doorZ = h.z; }
    chalets.push_back(h);
  }
  chaletPrice = int(num(j, "chaletPrice", 50000));
  if (j.contains("chaletModel")) {
    auto& m = j["chaletModel"];
    chaletModel.scale = num(m, "scale", 10.305); chaletModel.x = num(m, "x"); chaletModel.z = num(m, "z"); chaletModel.y = num(m, "y");
    chaletModel.HX = num(m, "HX", 4.02); chaletModel.HZ = num(m, "HZ", 6.08); chaletModel.IX = num(m, "IX", 3.72); chaletModel.IZ = num(m, "IZ", 5.78);
    chaletModel.G = num(m, "G", 0.3); chaletModel.GC = num(m, "GC", 2.95);
    if (m.contains("DOOR")) chaletModel.doorZ = num(m["DOOR"], "z", -0.17);
  }
  if (j.contains("chaletPlan")) {
    auto& P = j["chaletPlan"];
    chaletPlan.floorY = num(P, "floorY", 0.3); chaletPlan.ceilingY = num(P, "ceilingY", 2.95);
    for (auto& r : P["rects"]) chaletPlan.rects.push_back({num(r, "x0"), num(r, "z0"), num(r, "x1"), num(r, "z1")});
    for (auto& w : P["walls"]) chaletPlan.walls.push_back({num(w, "ax"), num(w, "az"), num(w, "bx"), num(w, "bz"), num(w, "t", 0.2), num(w, "y0"), num(w, "y1")});
    for (auto& b : P["blocks"]) { double x = num(b, "x"), z = num(b, "z"), hw = num(b, "hw"), hd = num(b, "hd"); chaletPlan.blocks.push_back({x - hw, z - hd, x + hw, z + hd}); }
  }
  for (auto& f : j["furniture"]) {
    FurnitureDef d;
    d.id = str(f, "id"); d.name = str(f, "name"); d.category = str(f, "category"); d.place = str(f, "place");
    d.price = int(num(f, "price"));
    if (f.contains("size") && f["size"].size() == 3) d.size = vec3(f["size"][0].get<float>(), f["size"][1].get<float>(), f["size"][2].get<float>());
    d.mount = num(f, "mount"); d.light = num(f, "light"); d.lux = num(f, "lux");
    d.small = f.value("small", false); d.flat = f.value("flat", false); d.seat = f.contains("seat");
    furniture.push_back(d);
  }
  for (auto& c : j["categories"]) categories.push_back({str(c, "id"), str(c, "name")});
  sellRefund = num(j, "sellRefund", 0.5);
  ok = true;
  SL_INFO("play: %zu courses, %zu bus races, %zu job boards, %zu destinations, %zu spots, %zu taxi places, %zu chalets, %zu furniture items",
          courses.size(), busRaces.size(), hubs.size(), dests.size(), spots.size(), taxi.size(), chalets.size(), furniture.size());
  return true;
}

const Course* PlayData::course(const std::string& id) const {
  for (auto& c : courses) if (c.id == id) return &c;
  for (auto& c : busRaces) if (c.id == id) return &c;
  return nullptr;
}
const FurnitureDef* PlayData::furnitureById(const std::string& id) const {
  for (auto& f : furniture) if (f.id == id) return &f;
  return nullptr;
}

} // namespace sl
