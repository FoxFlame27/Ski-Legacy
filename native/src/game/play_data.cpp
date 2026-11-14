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
  if (c.contains("house") && c["house"].is_object()) o.houseS = num(c["house"], "s", -1e9);
  for (auto& q : c["checkpoints"]) o.checkpoints.push_back(pt(q));
  for (auto& g : c["gates"]) o.gates.push_back({num(g, "s"), num(g, "x"), num(g, "y"), num(g, "z"), num(g, "nx"), num(g, "nz"), num(g, "width", 8), int(num(g, "side", 1)), str(g, "color") == "blue"});
  auto& L = c["line"];
  o.line.n = int(num(L, "n")); o.line.ds = num(L, "ds", 2);
  o.line.X = f32(L["X"], bin); o.line.Y = f32(L["Y"], bin); o.line.Z = f32(L["Z"], bin);
  o.line.W = f32(L["W"], bin); o.line.H = f32(L["H"], bin); o.line.K = f32(L["K"], bin);
  if (L.contains("B")) o.line.B = f32(L["B"], bin);
  if (L.contains("F")) o.line.F = f32(L["F"], bin);
  if (int(o.line.B.size()) != o.line.n) o.line.B.clear();
  if (int(o.line.F.size()) != o.line.n) o.line.F.clear();
  if (int(o.line.X.size()) != o.line.n || int(o.line.H.size()) != o.line.n) o.line.n = 0;
  o.night = c.value("night", false);
  if (c.contains("masts") && c["masts"].is_array())
    for (auto& m : c["masts"]) if (m.is_array() && m.size() >= 10) o.masts.push_back({m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9]});
  if (c.contains("board") && c["board"].is_object()) { o.hasBoard = true; o.boardX = num(c["board"], "x"); o.boardZ = num(c["board"], "z"); o.boardYaw = num(c["board"], "yaw"); }
  return o;
}
} // namespace

namespace {
RoomDef parseRoom(const nlohmann::json& r) {
  RoomDef o;
  if (!r.is_object()) return o;
  o.ok = true;
  o.W = num(r, "W", 8); o.D = num(r, "D", 8); o.H = num(r, "H", 3); o.eye = num(r, "eye", 1.62);
  if (r.contains("spawn") && r["spawn"].is_array() && r["spawn"].size() >= 3) { o.spawnX = r["spawn"][0]; o.spawnZ = r["spawn"][1]; o.spawnYaw = r["spawn"][2]; }
  if (r.contains("bounds") && r["bounds"].is_array() && r["bounds"].size() >= 4) for (size_t k = 0; k < 4; k++) o.bounds[k] = r["bounds"][k];
  if (r.contains("obstacles")) for (auto& q : r["obstacles"]) if (q.is_array() && q.size() >= 3) o.obstacles.push_back({q[0], q[1], q[2]});
  if (r.contains("counter") && r["counter"].is_array() && r["counter"].size() >= 4) { o.hasCounter = true; for (size_t k = 0; k < 4; k++) o.counter[k] = r["counter"][k]; }
  if (r.contains("hits")) for (auto& h : r["hits"]) {
    if (!h.contains("box") || h["box"].size() < 6) continue;
    auto& b = h["box"];
    o.hits.push_back({str(h, "kind"), str(h, "id"), str(h, "name"), dvec3(b[0].get<double>(), b[1].get<double>(), b[2].get<double>()), dvec3(b[3].get<double>(), b[4].get<double>(), b[5].get<double>()), h.value("up", false)});
  }
  if (r.contains("clerk") && r["clerk"].is_object()) { o.hasClerk = true; o.clerkX = num(r["clerk"], "x"); o.clerkZ = num(r["clerk"], "z"); o.clerkYaw = num(r["clerk"], "yaw"); o.clerkChar = str(r["clerk"], "char"); }
  if (r.contains("background") && r["background"].is_array() && r["background"].size() >= 3) o.background = vec3(r["background"][0].get<float>(), r["background"][1].get<float>(), r["background"][2].get<float>());
  if (r.contains("lights")) for (auto& l : r["lights"]) {
    const std::string t = str(l, "type");
    RoomDef::Light q;
    q.type = t == "point" ? 0 : t == "spot" ? 1 : t == "dir" ? 2 : t == "hemi" ? 3 : 4;
    q.color = vec3(l["color"][0].get<float>(), l["color"][1].get<float>(), l["color"][2].get<float>());
    q.intensity = float(num(l, "intensity", 1)); q.distance = float(num(l, "distance"));
    q.p = dvec3(l["p"][0].get<double>(), l["p"][1].get<double>(), l["p"][2].get<double>());
    const std::string role = str(l, "role");
    q.role = role == "day" ? 1 : role == "hemi" ? 2 : role == "lamp" ? 3 : role == "fire" ? 4 : 0;
    o.lights.push_back(q);
  }
  if (r.contains("panes")) for (auto& q : r["panes"]) {
    if (!q.contains("m") || q["m"].size() < 12) continue;
    RoomDef::Pane pn;
    for (int k = 0; k < 12; k++) pn.m[k % 4][k / 4] = q["m"][size_t(k)].get<float>();   // (rows of the 3 x 4 matrix)
    pn.w = float(num(q, "w", 1)); pn.h = float(num(q, "h", 1));
    o.panes.push_back(pn);
  }
  if (r.contains("door") && r["door"].is_object()) { o.hasDoor = true; o.doorX = num(r["door"], "x"); o.doorZ = num(r["door"], "z"); o.frontX = num(r["door"], "fx"); o.frontZ = num(r["door"], "fz", 1); o.doorR = num(r["door"], "r", 3.2); }
  if (r.contains("clock") && r["clock"].is_object() && r["clock"].contains("m") && r["clock"]["m"].size() >= 12) { o.hasClock = true; for (int k = 0; k < 12; k++) o.clock[k % 4][k / 4] = r["clock"]["m"][size_t(k)].get<float>(); }
  if (r.contains("podium") && r["podium"].is_array() && r["podium"].size() >= 3) o.podium = dvec3(r["podium"][0].get<double>(), r["podium"][1].get<double>(), r["podium"][2].get<double>());
  if (r.contains("shell") && r["shell"].is_array() && r["shell"].size() >= 3) { o.hasShell = true; o.shell = dvec3(r["shell"][0].get<double>(), r["shell"][1].get<double>(), r["shell"][2].get<double>()); }
  if (r.contains("stair") && r["stair"].is_array() && r["stair"].size() >= 4) { o.hasStair = true; for (size_t k = 0; k < 4; k++) o.stair[k] = r["stair"][k]; o.FL = num(r, "FL"); o.MZ = num(r, "MZ"); }
  if (r.contains("obstaclesUp")) for (auto& q : r["obstaclesUp"]) if (q.is_array() && q.size() >= 3) o.obstaclesUp.push_back({q[0], q[1], q[2]});
  if (r.contains("cars")) for (auto& c : r["cars"]) {
    RoomDef::Car q;
    q.id = str(c, "id"); q.label = str(c, "label"); q.price = int(num(c, "price")); q.up = c.value("up", false);
    if (c.contains("m") && c["m"].size() == 16) for (int k = 0; k < 16; k++) q.M[k / 4][k % 4] = c["m"][size_t(k)].get<double>();
    if (c.contains("paint") && c["paint"].is_array() && c["paint"].size() >= 3) q.paint = vec4(c["paint"][0].get<float>(), c["paint"][1].get<float>(), c["paint"][2].get<float>(), 1);
    o.cars.push_back(q);
  }
  return o;
}
} // namespace

namespace {
RoomDef::Pane parsePane(const nlohmann::json& q) {
  RoomDef::Pane pn;
  if (q.contains("m") && q["m"].size() >= 12) for (int k = 0; k < 12; k++) pn.m[k % 4][k / 4] = q["m"][size_t(k)].get<float>();
  pn.w = float(num(q, "w", 1)); pn.h = float(num(q, "h", 1));
  return pn;
}
glm::dmat4 parseM34(const nlohmann::json& m) {
  glm::dmat4 o(1);
  if (m.is_array() && m.size() >= 12) for (int k = 0; k < 12; k++) o[k % 4][k / 4] = m[size_t(k)].get<double>();
  return o;
}
ChaletRoomDef parseChaletRoom(const nlohmann::json& r) {
  ChaletRoomDef o;
  if (!r.is_object() || !r.contains("solid") || !r.contains("plan")) return o;
  o.ok = true;
  o.eye = num(r, "eye", 1.62); o.radius = num(r, "radius", 0.28);
  static const char* lv[3] = {"ground", "up", "stair"};
  for (int k = 0; k < 3; k++) if (r["solid"].contains(lv[k])) for (auto& q : r["solid"][lv[k]]) if (q.is_array() && q.size() >= 5) o.solid[k].push_back({q[0], q[1], q[2], q[3], q[4]});
  for (int k = 0; k < 2; k++) {
    if (r.contains("round") && r["round"].contains(lv[k])) for (auto& q : r["round"][lv[k]]) if (q.is_array() && q.size() >= 3) o.round[k].push_back({q[0], q[1], q[2]});
    if (r.contains("boxes") && r["boxes"].contains(lv[k])) for (auto& q : r["boxes"][lv[k]]) if (q.is_array() && q.size() >= 5) o.boxes[k].push_back({q[0], q[1], q[2], q[3], q[4]});
  }
  if (r.contains("doors")) for (auto& d : r["doors"]) {
    ChaletRoomDef::Door q;
    q.key = str(d, "key");
    if (d.contains("hinge") && d["hinge"].size() >= 2) { q.hx = d["hinge"][0]; q.hz = d["hinge"][1]; }
    if (d.contains("u") && d["u"].size() >= 2) { q.ux = d["u"][0]; q.uz = d["u"][1]; }
    if (d.contains("n") && d["n"].size() >= 2) { q.nx = d["n"][0]; q.nz = d["n"][1]; }
    q.w = num(d, "w", 0.9); q.h = num(d, "h", 2.1); q.y0 = num(d, "y0"); q.inward = num(d, "inward"); q.base = num(d, "base"); q.k = int(num(d, "k", 1));
    q.up = str(d, "level") == "up"; q.front = d.value("front", false);
    o.doors.push_back(q);
  }
  if (r.contains("lamps")) for (auto& l : r["lamps"]) o.lamps.push_back({num(l, "x"), num(l, "y"), num(l, "z"), num(l, "power", 1), l.value("up", false)});
  if (r.contains("panes")) for (auto& q : r["panes"]) o.panes.push_back(parsePane(q));
  if (r.contains("doorAt") && r["doorAt"].is_object()) { o.doorX = num(r["doorAt"], "x"); o.doorZ = (num(r["doorAt"], "z0") + num(r["doorAt"], "z1")) / 2; o.doorNx = num(r["doorAt"], "nx", 1); o.doorNz = num(r["doorAt"], "nz"); }
  const auto& P = r["plan"];
  o.IX = num(P, "IX", o.IX); o.IZ = num(P, "IZ", o.IZ); o.G = num(P, "G", o.G); o.GC = num(P, "GC", o.GC); o.FL = num(P, "FL", o.FL); o.rise = num(P, "RISE", o.rise); o.run = num(P, "RUN", o.run);
  auto rect = [&](const char* k, double* v) { if (P.contains(k)) { v[0] = num(P[k], "x0", v[0]); v[1] = num(P[k], "x1", v[1]); v[2] = num(P[k], "z0", v[2]); v[3] = num(P[k], "z1", v[3]); } };
  rect("STAIR", o.stair); rect("HOLE", o.hole);
  if (P.contains("STAIR")) o.steps = int(num(P["STAIR"], "steps", 16));
  if (P.contains("DORMER")) { o.dormerZ0 = num(P["DORMER"], "z0", o.dormerZ0); o.dormerZ1 = num(P["DORMER"], "z1", o.dormerZ1); }
  if (P.contains("STEPS")) o.stepsX1 = num(P["STEPS"], "x1", o.stepsX1);
  if (P.contains("DOOR")) o.doorZc = num(P["DOOR"], "z", o.doorZc);
  if (r.contains("rooms")) for (auto& q : r["rooms"]) {
    ChaletRoomDef::Rm m;
    m.name = str(q, "name"); m.up = q.value("up", false);
    if (q.contains("rects")) for (auto& t : q["rects"]) if (t.is_array() && t.size() >= 4) m.rects.push_back({t[0], t[1], t[2], t[3]});
    o.rooms.push_back(std::move(m));
  }
  if (r.contains("background") && r["background"].is_array() && r["background"].size() >= 3) o.background = vec3(r["background"][0].get<float>(), r["background"][1].get<float>(), r["background"][2].get<float>());
  return o;
}
PrisonDef parsePrison(const nlohmann::json& r, const nlohmann::json* outModel) {
  PrisonDef o;
  if (!r.is_object() || !r.contains("boxes") || !r.contains("EXIT")) return o;
  o.ok = true;
  o.eye = num(r, "eye", 1.62); o.radius = num(r, "radius", 0.26);
  for (auto& q : r["boxes"]) if (q.is_array() && q.size() >= 4) o.boxes.push_back({q[0].get<double>(), q[1].get<double>(), q[2].get<double>(), q[3].get<double>()});
  if (r.contains("cellDoors")) for (auto& q : r["cellDoors"]) if (q.is_array() && q.size() >= 2) o.cellDoors.push_back(dvec2(q[0].get<double>(), q[1].get<double>()));
  if (r.contains("ROOM")) { const auto& R = r["ROOM"]; o.roomX0 = num(R, "x0", o.roomX0); o.roomX1 = num(R, "x1", o.roomX1); o.roomZ0 = num(R, "z0", o.roomZ0); o.bars = num(R, "bars", o.bars); o.roomZ1 = num(R, "z1", o.roomZ1); }
  if (r.contains("FRONT")) { const auto& F = r["FRONT"]; o.frontX0 = num(F, "x0", o.frontX0); o.frontX1 = num(F, "x1", o.frontX1); o.frontZ0 = num(F, "z0", o.frontZ0); o.frontZ1 = num(F, "z1", o.frontZ1); }
  o.exitX = num(r["EXIT"], "x", o.exitX); o.exitZ = num(r["EXIT"], "z", o.exitZ);
  o.cellW = num(r, "CELL_W", 3.6);
  if (r.contains("CELLS")) for (auto& q : r["CELLS"]) o.cells.push_back(q.get<double>());
  if (o.cells.empty()) o.cells = {-3.6, 0, 3.6};
  if (r.contains("guard") && r["guard"].is_object()) { o.hasGuard = true; o.guardX = num(r["guard"], "x"); o.guardZ = num(r["guard"], "z"); }
  if (r.contains("panes")) for (auto& q : r["panes"]) o.panes.push_back(parsePane(q));
  if (r.contains("outside") && r["outside"].is_object()) {
    const auto& O = r["outside"];
    o.hasOutside = true;
    o.doorX = num(O["door"], "x"); o.doorZ = num(O["door"], "z"); o.doorYaw = num(O["door"], "yaw");
    o.cellsFrame = parseM34(O["cells"]); o.officeFrame = parseM34(O["office"]);
    if (O.contains("colliders")) for (auto& c : O["colliders"]) o.colliders.push_back({num(c, "x"), num(c, "z"), num(c, "hw"), num(c, "hd"), num(c, "rot"), num(c, "r", -1), 1e30});
    if (O.contains("patrol") && O["patrol"].is_object()) { o.hasPatrol = true; o.patrolX = num(O["patrol"], "x"); o.patrolZ = num(O["patrol"], "z"); o.patrolYaw = num(O["patrol"], "yaw"); }
    if (outModel && outModel->contains("at") && (*outModel)["at"].size() >= 3) o.outsideAt = dvec3((*outModel)["at"][0].get<double>(), (*outModel)["at"][1].get<double>(), (*outModel)["at"][2].get<double>());
  }
  return o;
}
ChaletVillageDef parseVillage(const nlohmann::json& r) {
  ChaletVillageDef o;
  if (!r.is_object() || !r.contains("at") || r["at"].size() < 3) return o;
  o.ok = true;
  o.at = dvec3(r["at"][0].get<double>(), r["at"][1].get<double>(), r["at"][2].get<double>());
  if (r.contains("windows")) for (auto& w : r["windows"]) {
    if (!w.contains("m") || w["m"].size() < 12) continue;
    ChaletVillageDef::Win q;
    for (int k = 0; k < 12; k++) q.m[k % 4][k / 4] = w["m"][size_t(k)].get<float>();
    if (w.contains("c") && w["c"].size() >= 3) q.c = vec3(w["c"][0].get<float>(), w["c"][1].get<float>(), w["c"][2].get<float>());
    o.windows.push_back(q);
  }
  if (r.contains("lamps")) for (auto& l : r["lamps"]) if (l.is_array() && l.size() >= 3) o.lamps.push_back(dvec3(l[0].get<double>(), l[1].get<double>(), l[2].get<double>()));
  if (r.contains("inst")) for (auto& q : r["inst"]) {
    ChaletVillageDef::Inst I;
    I.key = str(q, "key");
    if (q.contains("m")) for (auto& mm : q["m"]) if (mm.is_array() && mm.size() >= 12) { mat4 M(1); for (int k = 0; k < 12; k++) M[k % 4][k / 4] = mm[size_t(k)].get<float>(); I.m.push_back(M); }
    o.inst.push_back(std::move(I));
  }
  if (r.contains("colliders")) for (auto& c : r["colliders"]) o.colliders.push_back({num(c, "x"), num(c, "z"), num(c, "hw"), num(c, "hd"), num(c, "rot"), num(c, "r", -1), num(c, "top", 1e30)});
  return o;
}
WerkstattDef parseWerkstatt(const nlohmann::json& r) {
  WerkstattDef o;
  if (!r.is_object() || !r.contains("site") || !r.contains("at") || r["at"].size() < 3) return o;
  o.ok = true;
  o.at = dvec3(r["at"][0].get<double>(), r["at"][1].get<double>(), r["at"][2].get<double>());
  const auto& S = r["site"];
  o.x = num(S, "x"); o.z = num(S, "z"); o.ax = num(S, "ax", 1); o.az = num(S, "az"); o.fx = num(S, "fx"); o.fz = num(S, "fz", 1); o.yaw = num(S, "yaw");
  if (r.contains("BAY")) { o.bayX = num(r["BAY"], "x", o.bayX); o.bayZ = num(r["BAY"], "z", o.bayZ); o.bayHw = num(r["BAY"], "hw", o.bayHw); o.bayHl = num(r["BAY"], "hl", o.bayHl); }
  if (r.contains("BENCH")) { o.benchX = num(r["BENCH"], "x", o.benchX); o.benchZ = num(r["BENCH"], "z", o.benchZ); }
  o.IW = num(r, "IW", o.IW); o.ID = num(r, "ID", o.ID); o.repairS = num(r, "REPAIR_S", 4);
  if (r.contains("colliders")) for (auto& c : r["colliders"]) o.colliders.push_back({num(c, "x"), num(c, "z"), num(c, "hw"), num(c, "hd"), num(c, "rot"), num(c, "r", -1), 1e30});
  return o;
}
} // namespace

bool PlayData::load(const nlohmann::json& j, const std::vector<uint8_t>& bin) {
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("werkstatt")) werkstatt = parseWerkstatt(j["rooms"]["werkstatt"]);
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("chalet_village")) chaletVillage = parseVillage(j["rooms"]["chalet_village"]);
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("village") && j["rooms"]["village"].contains("huts"))
    for (auto& h : j["rooms"]["village"]["huts"]) if (h.is_array() && h.size() >= 3) hutDoors.push_back({h[0].get<double>(), h[1].get<double>(), h[2].get<double>()});
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("village") && j["rooms"]["village"].contains("tickets") && j["rooms"]["village"]["tickets"].is_array() && j["rooms"]["village"]["tickets"].size() >= 3) {
    const auto& t = j["rooms"]["village"]["tickets"];
    hasTickets = true; tickets = {t[0].get<double>(), t[1].get<double>(), t[2].get<double>()};
  }
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("chalet")) chaletRoom = parseChaletRoom(j["rooms"]["chalet"]);
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("prison")) prisonDef = parsePrison(j["rooms"]["prison"], j["rooms"].contains("prison_outside") ? &j["rooms"]["prison_outside"] : nullptr);
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("shop")) shop = parseRoom(j["rooms"]["shop"]);
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("autohaus")) autohaus = parseRoom(j["rooms"]["autohaus"]);
  if (j.contains("rooms") && j["rooms"].is_object() && j["rooms"].contains("prison")) prisonRoom = parseRoom(j["rooms"]["prison"]);
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
  if (j.contains("heli") && j["heli"].is_object()) heli = std::make_shared<nlohmann::json>(j["heli"]);
  if (j.contains("ward") && j["ward"].is_object()) ward = std::make_shared<nlohmann::json>(j["ward"]);
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
