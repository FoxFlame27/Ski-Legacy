#include "world/lifts.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/asset_manager.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr double MID_HALF = 9, MID_RAMP = 36, MID_SLOW = 0.1, MID_LEN = 26;
constexpr double CAR_HI = 32, CAR_MID = 110;
double smooth01(double t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
double smoothstepd(double a, double b, double x) { return smooth01((x - a) / (b - a)); }
double pmod(double a, double m) { return std::fmod(std::fmod(a, m) + m, m); }
}

// ---------------------------------------------------------------- one line (lifts.js LiftLine)
double LiftLine::speedAt(double q) const {
  double v = cfg.speed;
  if (!hasMid) return v;
  double d = std::fabs(uOf(q) - mid.u);
  return std::min(v, cfg.speed * (d < MID_HALF ? MID_SLOW : d < MID_HALF + MID_RAMP ? MID_SLOW + (1 - MID_SLOW) * smooth01((d - MID_HALF) / MID_RAMP) : 1));
}
bool LiftLine::inStation(double q) const { return hasMid && std::fabs(uOf(q) - mid.u) < MID_HALF; }

dvec3 LiftLine::cableAt(double u, int sd) const {
  u = clamp(u, 0, L);
  size_t i = 0;
  while (i < supports.size() - 2 && supports[i + 1].x < u) i++;
  const dvec2 a = supports[i], b = supports[i + 1];
  double t = (u - a.x) / ((b.x - a.x) != 0 ? (b.x - a.x) : 1);
  double span = b.x - a.x;
  double sag = span * (gondola ? 0.012 : 0.015) * 4 * t * (1 - t);
  dvec3 out(B.x + dir.x * u, lerp(a.y, b.y, t) - sag, B.z + dir.y * u);
  if (hasMid) {
    double k = smoothstepd(MID_LEN / 2 + 16, MID_LEN / 2, std::fabs(u - mid.u));
    if (k > 0) out.y = lerp(out.y, mid.y + cfg.stationH, k);
  }
  out.x += sideV.x * sd * cfg.side;
  out.z += sideV.y * sd * cfg.side;
  return out;
}

int LiftLine::carState(double q, dvec3& out) const {
  q = pmod(q, 2 * L);
  if (q < L) { out = cableAt(q, 1); return 1; }
  out = cableAt(2 * L - q, -1);
  return -1;
}

void LiftLine::advance(size_t i, double t) {
  const double L2 = 2 * L;
  int n = std::max(1, int(std::ceil(std::fabs(t) * cfg.speed / 2)));
  double h = t / n;
  for (int k = 0; k < n; k++) s[i] = pmod(s[i] + speedAt(s[i]) * h, L2);
}

void LiftLine::update(double dt, double timeScale) {
  for (size_t i = 0; i < s.size(); i++) {
    if (dt > 0) {
      if (hasMid) advance(i, dt * timeScale);
      else s[i] = std::fmod(s[i] + cfg.speed * dt * timeScale, 2 * L);
    }
    side[i] = carState(s[i], pos[i]);
  }
}

double LiftLine::travelTime(double s0, double dist) const {
  if (!hasMid) return dist / cfg.speed;
  double t = 0;
  int n = std::max(1, int(std::ceil(dist / 2)));
  double h = dist / n;
  for (int i = 0; i < n; i++) t += h / speedAt(s0 + h * (i + 0.5));
  return t;
}

LiftLine::Pick LiftLine::pickCar(double target) const {
  const double L2 = 2 * L;
  size_t iB = 0, iA = 0;
  double dB = 1e300, dA = 1e300;
  for (size_t i = 0; i < s.size(); i++) {
    double behind = pmod(target - s[i] + L2, L2), ahead = pmod(L2 - behind, L2);
    if (behind < dB) { dB = behind; iB = i; }
    if (ahead < dA) { dA = ahead; iA = i; }
  }
  double tB = travelTime(s[iB], dB), tA = travelTime(target, dA);
  return tB <= tA ? Pick{iB, tB} : Pick{iA, -tA};
}

Seat LiftLine::seatFor(size_t idx) const {
  Seat st;
  int sd = side[idx];
  dvec3 fwd(dir.x * sd, 0, dir.y * sd);
  st.fwd = fwd;
  st.pos = pos[idx];
  st.pos.y -= cfg.seatDrop;
  if (!gondola) st.pos += fwd * 0.1 + dvec3(sideV.x, 0, sideV.y) * 0.35;
  else st.pos += fwd * -0.55;
  return st;
}

// ---------------------------------------------------------------- all lines
bool Lifts::load(gfx::Device& dev, AssetManager& assets, const nlohmann::json& J) {
  for (auto& j : J) {
    LiftLine l;
    l.name = j.value("name", std::string("Lift"));
    l.type = j.value("type", std::string("gondola"));
    l.gondola = l.type != "chair";
    l.main = j.value("main", false);
    l.price = j.value("price", 0);
    l.bottomName = j["bottomName"].is_string() ? j["bottomName"].get<std::string>() : "";
    l.topName = j["topName"].is_string() ? j["topName"].get<std::string>() : "";
    auto v3 = [](const nlohmann::json& a) { return dvec3(a[0].get<double>(), a[1].get<double>(), a[2].get<double>()); };
    l.bottom = v3(j["bottom"]); l.top = v3(j["top"]); l.B = v3(j["B"]); l.T = v3(j["T"]);
    l.L = j["L"]; l.yaw = j["yaw"];
    l.dir = dvec2(j["dir"][0].get<double>(), j["dir"][1].get<double>());
    l.sideV = dvec2(-l.dir.y, l.dir.x);
    auto& c = j["cfg"];
    l.cfg.stationH = c["stationH"]; l.cfg.side = c["side"]; l.cfg.speed = c["speed"]; l.cfg.carGap = c["carGap"];
    l.cfg.carH = c["carH"]; l.cfg.seatDrop = c["seatDrop"]; l.cfg.stationSize = c["stationSize"];
    if (j["mid"].is_object()) {
      l.hasMid = true;
      auto& m = j["mid"];
      l.mid.u = m["u"]; l.mid.x = m["x"]; l.mid.y = m["y"]; l.mid.z = m["z"]; l.mid.side = m.value("side", 1);
      l.mid.name = m.value("name", std::string("Mid-station"));
    }
    for (auto& sp : j["supports"]) l.supports.push_back(dvec2(sp[0].get<double>(), sp[1].get<double>()));
    for (auto& q : j["cars"]) l.s.push_back(q.get<double>());
    l.side.assign(l.s.size(), 1);
    l.pos.assign(l.s.size(), dvec3(0));
    auto ex = [](const nlohmann::json& e) { LiftExit x; if (e.is_object()) { x.x = e["x"]; x.z = e["z"]; x.heading = e["heading"]; } return x; };
    l.exitUp = ex(j["exitUp"]); l.exitDown = ex(j["exitDown"]); l.midExit = ex(j["midExit"]);
    if (j["carSize"].is_array()) l.carSize = dvec2(j["carSize"][0].get<double>(), j["carSize"][1].get<double>());
    if (l.supports.size() < 2) continue;
    l.update(0, 1);
    lines_.push_back(std::move(l));
  }
  // cars: full Meshy detail near, lighter copies further out (lifts.js CAR_HI / 110 m tiers)
  ModelLoadOptions o;
  o.maxTextureSize = 1024;
  o.lodRatios = {0.3f, 0.12f};
  size_t nCab = 0, nChair = 0;
  for (auto& l : lines_) (l.gondola ? nCab : nChair) += l.s.size();
  struct K { CarKind* k; const char* model; double carH; size_t n; };
  double cabH = 3.1, chairH = 3.2;
  for (auto& l : lines_) (l.gondola ? cabH : chairH) = l.cfg.carH;
  for (K k : {K{&cabin_, "gondola_cabin", cabH, nCab}, K{&chair_, "chairlift_chair", chairH, nChair}}) {
    k.k->model = assets.model(k.model, o);
    if (!k.k->model) continue;
    // fitted to carH tall, hung from the top of its grip (lifts.js translate(0, -carH, 0))
    k.k->fit = glm::translate(mat4(1), vec3(0, -float(k.carH), 0)) * k.k->model->fitTransform(float(k.carH), 1);
    for (auto& b : k.k->lod) b.init(dev, *k.k->model, uint32_t(std::max<size_t>(1, k.n)));
    hasCars_ = true;
  }
  SL_INFO("lifts: %zu lines, %zu cabins, %zu chairs", lines_.size(), nCab, nChair);
  return !lines_.empty();
}

void Lifts::update(double dt, const dvec3& viewer) {
  for (auto& l : lines_) {
    double mx = (l.bottom.x + l.top.x) / 2, mz = (l.bottom.z + l.top.z) / 2;
    l.near = std::hypot(viewer.x - mx, viewer.z - mz) < 2500 + l.L / 2 || ride_.line == &l;
    if (!l.near) continue;
    // fast-forwarding rides slow to x2 while the rider's cabin crawls through a mid-station (time to get off)
    double ts = ride_.line == &l && l.inStation(l.s[ride_.idx]) ? std::min(timeScale, 2.0) : timeScale;
    l.update(dt, ts);
  }
}

void Lifts::submit(Renderer& r, const dvec3& viewer) {
  if (!hasCars_) return;
  std::vector<InstanceBatch::Inst> lists[2][3];
  for (auto& l : lines_) {
    if (!l.near) continue;
    int kind = l.gondola ? 0 : 1;
    for (size_t i = 0; i < l.s.size(); i++) {
      const dvec3& p = l.pos[i];
      double d2 = glm::dot(p - viewer, p - viewer);
      if (d2 > 3000.0 * 3000.0) continue;
      dvec3 ext(4);
      if (!r.visible(p - ext - dvec3(0, l.cfg.carH, 0), p + ext) && d2 > CAR_HI * CAR_HI) continue;
      int lod = d2 < CAR_HI * CAR_HI ? 0 : d2 < CAR_MID * CAR_MID ? 1 : 2;
      float yaw = float(l.yaw + (l.side[i] > 0 ? 0 : PI));
      float roll = float(std::sin(l.s[i] * 0.15 + double(i)) * 0.025 * (l.inStation(l.s[i]) ? 0.2 : 1));
      lists[kind][lod].push_back({vec4(float(p.x), float(p.y), float(p.z), 1.f), vec4(yaw, roll, 0, 0)});
    }
  }
  CarKind* kinds[2] = {&cabin_, &chair_};
  for (int k = 0; k < 2; k++) {
    if (!kinds[k]->model) continue;
    for (int lod = 0; lod < 3; lod++) {
      kinds[k]->lod[lod].upload(r.device(), lists[k][lod]);
      r.submitInstances(kinds[k]->lod[lod], kinds[k]->fit, lod, lod == 0);
    }
  }
}

Lifts::Station Lifts::nearestStation(const dvec3& p) {
  Station best;
  for (auto& l : lines_) {
    double db = std::hypot(p.x - l.bottom.x, p.z - l.bottom.z);
    if (db < best.dist) best = {&l, true, false, db};
    double dt = std::hypot(p.x - l.top.x, p.z - l.top.z);
    if (dt < best.dist) best = {&l, false, false, dt};
    if (l.hasMid) {
      double dm = std::hypot(p.x - l.mid.x, p.z - l.mid.z);
      if (dm < best.dist) best = {&l, true, true, dm};
    }
  }
  return best;
}

Seat Lifts::board(LiftLine& line, bool up, bool atMid) {
  atMid = atMid && line.hasMid;
  double target = atMid ? (up ? line.mid.u : 2 * line.L - line.mid.u) : (up ? 0 : line.L);
  LiftLine::Pick pk = line.pickCar(target);
  // bring that cabin to the boarding point: the whole loop moves on (or back) by the same time
  if (line.hasMid) {
    for (size_t i = 0; i < line.s.size(); i++) line.advance(i, pk.t);
    line.s[pk.idx] = std::fmod(target + 0.5, 2 * line.L);
  } else {
    const double L2 = 2 * line.L, delta = target + 0.5 - line.s[pk.idx];
    for (double& q : line.s) q = pmod(q + delta, L2);
  }
  line.update(0, 1);
  ride_ = {&line, pk.idx, up, !atMid};
  return line.seatFor(pk.idx);
}

Lifts::RideState Lifts::updateRide() {
  RideState rs;
  if (!ride_.line) return rs;
  LiftLine& line = *ride_.line;
  double q = line.s[ride_.idx], L = line.L;
  rs.riding = true;
  rs.seat = line.seatFor(ride_.idx);
  bool arrived = ride_.up ? q >= L - 3 : (q >= 2 * L - 3 || q < 1);
  if (!arrived) {
    if (line.hasMid) {
      if (!line.inStation(q)) ride_.clearOfStop = true;
      else if (ride_.clearOfStop) { rs.atStop = true; rs.stopName = line.mid.name; rs.exit = line.midExit; }
    }
    return rs;
  }
  rs.arrived = true;
  rs.exit = ride_.up ? line.exitUp : line.exitDown;
  ride_ = {};
  return rs;
}

bool Lifts::leaveAtStop(LiftExit& out) {
  if (!ride_.line || !ride_.line->hasMid || !ride_.line->inStation(ride_.line->s[ride_.idx])) return false;
  out = ride_.line->midExit;
  ride_ = {};
  return true;
}

double Lifts::rideProgress() const {
  if (!ride_.line) return 0;
  double u = ride_.line->uOf(ride_.line->s[ride_.idx]) / ride_.line->L;
  return ride_.up ? u : 1 - u;
}

} // namespace sl
