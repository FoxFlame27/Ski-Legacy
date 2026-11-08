#include "game/trains.h"
#include "core/log.h"
#include "world/scenery.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
glm::dmat4 between(const dvec3& a, const dvec3& b) {   // a car between its bogies: +z toward a (the front)
  dvec3 m = (a + b) * 0.5;
  double yaw = std::atan2(a.x - b.x, a.z - b.z), pitch = std::atan2(b.y - a.y, std::hypot(a.x - b.x, a.z - b.z));
  return glm::translate(glm::dmat4(1), m) * glm::rotate(glm::dmat4(1), yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), pitch, dvec3(1, 0, 0));
}
} // namespace

// ================================================================ the Wolkenspitzbahn
void Railway::init() {
  if (!t_.rail.ok) return;
  ncars_ = 2 * t_.rail.units;
  trains_ = {{0.0, {}}, {0.5, {}}};
  t_now_ = t_.rail.cycle * 0.62;
  update(0, false, dvec3(0));
  SL_INFO("railway: %s, %zu trains of %d cars, cycle %.0f s (trip %.0f s)", t_.rail.name.c_str(), trains_.size(), ncars_, t_.rail.cycle, t_.rail.trip);
}

double Railway::tripS(double t) const {
  const auto& R = t_.rail;
  const double STEP = R.line.step;
  if (t <= 0) return R.i0 * STEP;
  if (t >= R.T[size_t(R.i1)]) return R.i1 * STEP;
  int lo = R.i0, hi = R.i1;
  while (hi - lo > 1) { int m = (lo + hi) >> 1; if (R.T[size_t(m)] <= t) lo = m; else hi = m; }
  double span = R.T[size_t(hi)] - R.T[size_t(lo)];
  for (auto& st : R.stops) if (st.second == lo) {   // the step that holds a halt's dwell: stand, then roll on
    double travel = STEP / std::max((R.V[size_t(hi)] + R.V[size_t(lo)]) / 2.0, 0.25);
    return (lo + clamp((t - R.T[size_t(lo)] - (span - travel)) / travel, 0, 1)) * STEP;
  }
  return (lo + (span > 0 ? (t - R.T[size_t(lo)]) / span : 0)) * STEP;
}
double Railway::speedAt(double s) const { int i = int(std::lround(clamp(s / t_.rail.line.step, 0, t_.rail.line.n - 1))); return t_.rail.V[size_t(i)]; }

// railroute.js trainState: up trip, dwell at the top, down trip, dwell at the bottom; the halts' dwells in the trips
Railway::State Railway::trainState(double t, double phase) const {
  const auto& R = t_.rail;
  State o;
  double T = R.trip, C = R.cycle;
  double u = std::fmod(std::fmod(t / C + phase, 1.0) + 1.0, 1.0) * C;
  if (u < T) { o.s = tripS(u); o.dir = 1; o.leg = "up"; }
  else if (u < T + R.dwellEnd) { o.s = R.tripS1; o.dir = 0; o.leg = "top"; }
  else if (u < 2 * T + R.dwellEnd) { o.s = tripS(2 * T + R.dwellEnd - u); o.dir = -1; o.leg = "down"; }
  else { o.s = R.tripS0; o.dir = 0; o.leg = "bottom"; }
  o.speed = o.dir ? speedAt(o.s) : 0;
  for (size_t i = 0; i < R.stations.size(); i++) if (std::fabs(o.s - R.stations[i].s) < 1.5 && o.speed < 0.5) o.at = int(i);
  return o;
}
double Railway::haltArrival(const std::string& id) const {
  for (auto& st : t_.rail.stops) if (st.first == id) return t_.rail.T[size_t(st.second + 1)] - t_.rail.dwellMid;
  return -1;
}
double Railway::boardingU(int st, int dir) const {
  const auto& R = t_.rail;
  double T = R.trip;
  if (st == 0) return R.cycle - 20;
  if (st == int(R.stations.size()) - 1) return T + R.dwellEnd - 20;
  double tA = haltArrival(R.stations[size_t(st)].id);
  return dir > 0 ? tA + R.dwellMid * 0.3 : 2 * T + R.dwellEnd - tA - R.dwellMid * 0.7;
}
dvec3 Railway::trackPoint(double s, bool loop) const {
  Line::P p = t_.rail.line.at(s);
  double off = loop ? t_.loopOffset(s) : 0;
  return dvec3(p.x - p.dz * off, p.y, p.z + p.dx * off);
}

void Railway::update(double dt, bool fast, const dvec3&) {
  if (trains_.empty()) return;
  double scale = ride_.on && fast ? 6 : 1;
  if (mpTime) t_now_ = std::fmod(mpTime(), t_.rail.cycle * 1000);   // (multiplayer: the shared timeline)
  else t_now_ = std::fmod(t_now_ + dt * scale, t_.rail.cycle * 1000);
  for (auto& tr : trains_) tr.st = trainState(t_now_, tr.phase);
  if (ride_.on && trains_[size_t(ride_.train)].st.at != ride_.from) ride_.departed = true;
}

void Railway::carMatrix(int train, int k, glm::dmat4& M) const {
  const auto& C = t_.rail.car;
  const State& st = trains_[size_t(train)].st;
  bool onLoop = st.dir < 0 && st.s > t_.rail.loop.s0 && st.s < t_.rail.loop.s1;
  double pitch = C.len + C.gap, sc = st.s + ((ncars_ - 1) / 2.0 - k) * pitch;
  bool flip = k % 2 == 1;
  double sF = sc + (flip ? -C.bogie : C.bogie), sB = sc - (flip ? -C.bogie : C.bogie);
  M = between(trackPoint(sF, onLoop), trackPoint(sB, onLoop));
}

int Railway::stationNear(const dvec3& p) const {
  if (ride_.on) return -1;
  for (size_t i = 0; i < t_.rail.stations.size(); i++) {
    const auto& st = t_.rail.stations[i];
    if (st.hasBoard && std::hypot(p.x - st.board.x, p.z - st.board.y) <= 9) return int(i);
  }
  return -1;
}
std::string Railway::label(int st, bool down) const {
  const auto& S = t_.rail.stations;
  if (st == 0) return "Ride the " + t_.rail.name + " to " + S.back().name;
  if (st == int(S.size()) - 1) return "Ride the " + t_.rail.name + " down to Legacy Village";
  return S[size_t(st)].name + " - " + t_.rail.name + (down ? " down to Legacy Village" : " up to " + S.back().name);
}

// board: the timetable jumps so train 0 stands at the platform with its doors open; a window seat in its leading car
bool Railway::trainReady(int st, bool up) const {
  if (!mpTime) return true;
  int nst = int(t_.rail.stations.size());
  if (st == 0) up = true;
  if (st == nst - 1) up = false;
  int dir = up ? 1 : -1;
  for (const auto& tr : trains_) if (tr.st.at == st && (tr.st.dir == dir || st == 0 || st == nst - 1)) return true;
  return false;
}

bool Railway::board(int st, bool up) {
  if (trains_.empty() || st < 0) return false;
  int nst = int(t_.rail.stations.size());
  if (st == 0) up = true;
  if (st == nst - 1) up = false;
  int dir = up ? 1 : -1;
  int train = 0;
  if (mpTime) {
    // multiplayer (transit.js): nobody brings or holds a train: the one standing at this platform, going your way
    train = -1;
    for (size_t k = 0; k < trains_.size(); k++)
      if (trains_[k].st.at == st && (trains_[k].st.dir == dir || st == 0 || st == nst - 1)) train = int(k);
    if (train < 0) return false;
  } else {
    double want = boardingU(st, dir), C = t_.rail.cycle;
    double u = std::fmod(std::fmod(t_now_ / C + trains_[0].phase, 1.0) + 1.0, 1.0) * C;
    t_now_ += want - u;
    for (auto& tr : trains_) tr.st = trainState(t_now_, tr.phase);
  }
  ride_ = Ride{};
  ride_.on = true; ride_.train = train; ride_.car = up ? 0 : ncars_ - 1; ride_.up = up; ride_.from = st; ride_.dest = up ? nst - 1 : 0;
  return true;
}

TrainRide Railway::ride() const {
  TrainRide r;
  if (!ride_.on) return r;
  r.on = true;
  glm::dmat4 M;
  carMatrix(ride_.train, ride_.car, M);
  const auto& R = t_.rail;
  r.seat = dvec3(M * glm::dvec4(dvec3(R.seat), 1));
  dvec3 f = dvec3(M * glm::dvec4(std::sin(R.seatYaw), 0, std::cos(R.seatYaw), 0));
  r.fwd = glm::normalize(dvec3(f.x, 0, f.z) + dvec3(1e-9));
  const State& st = trains_[size_t(ride_.train)].st;
  r.speed = st.speed;
  r.trainPos = dvec3(M[3]); r.trainYaw = std::atan2(M[2][0], M[2][2]);
  if (ride_.departed && st.at == ride_.dest) {
    const auto& s = R.stations[size_t(ride_.dest)];
    r.arrived = true; r.exit = s.hasExit ? s.exit : dvec3(s.board.x, s.board.y, 0);
    r.hint = s.name + " - arrived";
    return r;
  }
  std::string next = ride_.up ? R.stations.back().name : "Legacy Village";
  if (ride_.up) { for (auto& s : R.stations) if (s.s > st.s + 1) { next = s.name; break; } }
  else for (int i = int(R.stations.size()) - 1; i >= 0; i--) if (R.stations[size_t(i)].s < st.s - 1) { next = R.stations[size_t(i)].name; break; }
  if (ride_.departed && st.at >= 0 && R.stations[size_t(st.at)].halt && !ride_.exitSent) { r.atStop = true; r.stop = R.stations[size_t(st.at)].name; }
  char b[200];
  if (r.atStop) std::snprintf(b, sizeof b, "%s - get off here", r.stop.c_str());
  else if (!ride_.departed) std::snprintf(b, sizeof b, "%s - departing for %s", R.name.c_str(), R.stations[size_t(ride_.dest)].name.c_str());
  else std::snprintf(b, sizeof b, "%s - next stop %s - %.0f km/h", R.name.c_str(), next.c_str(), st.speed * 3.6);
  r.hint = b;
  return r;
}
bool Railway::leaveAtStop(dvec3& exit) {
  if (!ride_.on) return false;
  const State& st = trains_[size_t(ride_.train)].st;
  if (st.at < 0 || !t_.rail.stations[size_t(st.at)].halt || ride_.exitSent) return false;
  const auto& s = t_.rail.stations[size_t(st.at)];
  exit = s.hasExit ? s.exit : dvec3(s.board.x, s.board.y, 0);
  ride_.exitSent = true;
  return true;
}

void Railway::addDraw(VehicleDraw& draw, const dvec3& cam) const {
  for (size_t t = 0; t < trains_.size(); t++)
    for (int k = 0; k < ncars_; k++) {
      glm::dmat4 M;
      carMatrix(int(t), k, M);
      double d = glm::length(dvec3(M[3]) - cam);
      if (d > 4500) continue;
      bool riding = ride_.on && ride_.train == int(t) && ride_.car == k;
      if (d > 220 && !riding) { if (models_.rail.lo) draw.add(models_.rail.lo.get(), M, 0); continue; }
      if (riding && insideView && models_.rail.cabin) { draw.add(models_.rail.cabin.get(), M, 0); continue; }
      if (models_.rail.body.ok()) draw.add(models_.rail.body.model.get(), M * glm::dmat4(models_.rail.body.fit), d < 90 ? 0 : 1);
      else if (models_.rail.cabin) draw.add(models_.rail.cabin.get(), M, 0);
      if (models_.rail.frame) draw.add(models_.rail.frame.get(), M, 0);
      if (models_.rail.bogie) for (const vec3& b : t_.rail.bogies) draw.add(models_.rail.bogie.get(), M * glm::translate(glm::dmat4(1), dvec3(b)), 0);
    }
}
void Railway::fillColliders(std::vector<Collider>& out, const dvec3& near) const {
  const auto& C = t_.rail.car;
  for (size_t t = 0; t < trains_.size(); t++)
    for (int k = 0; k < ncars_; k++) {
      if (ride_.on && ride_.train == int(t)) continue;
      glm::dmat4 M;
      carMatrix(int(t), k, M);
      if (glm::length(dvec3(M[3]) - near) > 60) continue;
      Collider c;
      c.x = M[3][0]; c.z = M[3][2]; c.hw = C.hw; c.hd = C.half + C.gap / 2; c.rot = -std::atan2(M[2][0], M[2][2]); c.top = M[3][1] + C.roofTop;
      out.push_back(c);
    }
}

// ================================================================ the Legacy Express
void Express::init() {
  const auto& E = t_.express;
  if (!E.ok) return;
  const int n = E.line.n;
  const double STEP = E.line.step;
  Tm_.assign(size_t(n + 1), 0);   // pure running time from the hall at each sample (+s)
  for (int i = 1; i <= n; i++) Tm_[size_t(i)] = Tm_[size_t(i - 1)] + STEP / std::max((E.V[size_t(i)] + E.V[size_t(i - 1)]) / 2.0, 0.3);
  for (auto& st : E.stations) idx_.push_back(int(std::lround(st.s / STEP)));
  int ns = int(E.stations.size());
  auto build = [&](int dir) {
    Way w;
    w.dir = dir;
    std::vector<int> order;
    if (dir > 0) for (int k = 0; k < ns; k++) order.push_back(k);
    else { order.push_back(0); for (int k = ns - 1; k >= 1; k--) order.push_back(k); }
    double t = 0;
    for (size_t j = 0; j < order.size(); j++) {
      int a = order[j], b = order[(j + 1) % order.size()];
      w.segs.push_back({true, a, a, a, 0, 0, t, E.dwell}); t += E.dwell;
      int ia = idx_[size_t(a)], ib = idx_[size_t(b)];
      if (dir > 0 && ib == 0) ib = n;
      if (dir < 0 && ia == 0) ia = n;
      double dur = std::fabs(Tm_[size_t(ib)] - Tm_[size_t(ia)]);
      w.segs.push_back({false, -1, a, b, ia, ib, t, dur}); t += dur;
    }
    w.loop = t;
    return w;
  };
  up_ = build(1); down_ = build(-1);
  const int PER_DIR = 8;
  for (int dir : {1, -1}) for (int k = 0; k < PER_DIR; k++) trains_.push_back({dir, double(k) / PER_DIR + (dir > 0 ? 0 : 0.5 / PER_DIR), {}});
  update(0, false, dvec3(0));
  SL_INFO("express: %s, %zu trains, %zu stations, a round %.0f s", E.name.c_str(), trains_.size(), E.stations.size(), up_.loop);
}

Express::State Express::trainState(const Way& w, double u) const {
  State o;
  double L = w.loop;
  u = std::fmod(std::fmod(u, L) + L, L);
  size_t k = 0;
  while (k + 1 < w.segs.size() && w.segs[k + 1].t0 <= u) k++;
  const Seg& g = w.segs[k];
  o.seg = int(k); o.u = u;
  if (g.dwell) { o.at = g.st; o.next = g.st; o.speed = 0; o.s = t_.express.stations[size_t(g.st)].s; o.left = g.t0 + g.dur - u; return o; }
  bool fwd = g.ib > g.ia;
  double tau = u - g.t0, target = fwd ? Tm_[size_t(g.ia)] + tau : Tm_[size_t(g.ia)] - tau;
  int lo = std::min(g.ia, g.ib), hi = std::max(g.ia, g.ib);
  while (hi - lo > 1) { int mid = (lo + hi) >> 1; if (Tm_[size_t(mid)] <= target) lo = mid; else hi = mid; }
  double f = clamp((target - Tm_[size_t(lo)]) / std::max(1e-6, Tm_[size_t(hi)] - Tm_[size_t(lo)]), 0, 1);
  o.s = t_.express.line.wrap((lo + f) * t_.express.line.step);
  o.speed = t_.express.V[size_t(lo)] + (t_.express.V[size_t(hi)] - t_.express.V[size_t(lo)]) * f;
  o.at = -1; o.next = g.b;
  return o;
}
double Express::u(int k) const {
  const Train& tr = trains_[size_t(k)];
  double L = way(tr.dir).loop;
  if (mpTime) return std::fmod(std::fmod(mpTime(tr.dir) + tr.phase * L, L) + L, L);   // (multiplayer: the direction's shared timeline)
  return std::fmod(std::fmod(t_now_ + off_[tr.dir > 0 ? 0 : 1] + tr.phase * L, L) + L, L);
}
void Express::update(double dt, bool fast, const dvec3&) {
  if (trains_.empty()) return;
  double scale = ride_.on && fast ? t_.express.fast : 1;
  t_now_ = std::fmod(t_now_ + dt * scale, up_.loop * 1000);
  for (size_t k = 0; k < trains_.size(); k++) trains_[k].st = trainState(way(trains_[k].dir), u(int(k)));
  if (ride_.on && trains_[size_t(ride_.train)].st.at != ride_.from) ride_.departed = true;
}

double Express::rideTime(int a, int b, int dir) const {
  const auto& E = t_.express;
  const auto& T = E.T;
  int n = E.line.n, ia = idx_[size_t(a)], ib = idx_[size_t(b)];
  auto fwd = [&](int from, int to) { return to >= from ? T[size_t(to)] - T[size_t(from)] : T[size_t(n)] - T[size_t(from)] + T[size_t(to)] + E.dwell; };
  return dir > 0 ? fwd(ia, ib == 0 ? n : ib) - E.dwell : fwd(ib, ia == 0 ? n : ia) - E.dwell;
}

int Express::stationNear(const dvec3& p) const {
  if (ride_.on) return -1;
  const auto& E = t_.express;
  for (size_t i = 0; i < E.stations.size(); i++) {
    const auto& st = E.stations[i];
    if (st.hasBoard && std::hypot(p.x - st.board.x, p.z - st.board.y) <= 12) return int(i);
    // anywhere on its platforms (expressground.js PLATFORM_OFF 7.2 m out, 3 m wide; 240 m long)
    Line::Near nn = E.line.nearest(p.x, p.z, 10);
    if (nn.d <= 9.5 && nn.d >= 3.5) { double ds = std::fabs(std::remainder(nn.s - st.s, E.line.length)); if (ds < 120) return int(i); }
  }
  return -1;
}

// board: the quicker way round; the next train that way is brought in to stand at the platform (express.js serve /
// NUDGE: that direction's timetable shifted, its trains keep their spacing), you take a seat in its first car
bool Express::trainReady(int from, int to) const {
  if (!mpTime) return true;
  if (trains_.empty() || from == to || from < 0 || to < 0) return false;
  int dir = rideTime(from, to, 1) <= rideTime(from, to, -1) ? 1 : -1;
  for (const auto& tr : trains_) if (tr.dir == dir && tr.st.at == from && tr.st.left >= 4) return true;
  return false;
}

bool Express::board(int from, int to) {
  if (trains_.empty() || from == to || from < 0 || to < 0) return false;
  int dir = rideTime(from, to, 1) <= rideTime(from, to, -1) ? 1 : -1;
  const Way& w = way(dir);
  const Seg* dw = nullptr;
  for (const Seg& g : w.segs) if (g.dwell && g.st == from) { dw = &g; break; }
  if (!dw) return false;
  double want = dw->t0 + dw->dur - 15, L = w.loop, best = 1e18;
  int bk = -1;
  for (size_t k = 0; k < trains_.size(); k++) {
    if (trains_[k].dir != dir) continue;
    double d = std::remainder(want - u(int(k)), L);
    if (std::fabs(d) < std::fabs(best)) { best = d; bk = int(k); }
  }
  if (mpTime) {
    // multiplayer: the train standing at this platform now (at least 4 s before it leaves, transit.js BOARD_MIN)
    bk = -1;
    for (size_t k = 0; k < trains_.size(); k++)
      if (trains_[k].dir == dir && trains_[k].st.at == from && trains_[k].st.left >= 4) bk = int(k);
    if (bk < 0) return false;
  } else {
    if (bk < 0) return false;
    off_[dir > 0 ? 0 : 1] += best;
    update(0, false, dvec3(0));
  }
  ride_ = Ride{};
  ride_.on = true; ride_.train = bk; ride_.from = from; ride_.to = to;
  return true;
}

std::string Express::rideVehicle() const {
  if (!ride_.on) return "";
  int dir = trains_[size_t(ride_.train)].dir, n = 0;
  for (int k = 0; k < ride_.train; k++) if (trains_[size_t(k)].dir == dir) n++;
  return std::string("express-") + (dir > 0 ? "e" : "w") + std::to_string(n);
}

void Express::carMatrix(int k, int car, glm::dmat4& M) const {
  const auto& C = t_.rail.car;
  const Train& tr = trains_[size_t(k)];
  const int d = tr.dir;
  static const bool FLIP[4] = {false, true, false, true};
  double pitch = C.len + C.gap, sc = tr.st.s + d * (1.5 - car) * pitch;
  int fwd = FLIP[car] ? -d : d;
  double sF = sc + fwd * C.bogie, sB = sc - fwd * C.bogie;
  auto trackAt = [&](double s) { Line::P p = t_.express.line.at(s); double off = t_.express.trackOff * d; return dvec3(p.x - p.dz * off, p.y, p.z + p.dx * off); };
  M = between(trackAt(sF), trackAt(sB));
}

TrainRide Express::ride() const {
  TrainRide r;
  if (!ride_.on) return r;
  r.on = true;
  glm::dmat4 M;
  carMatrix(ride_.train, 0, M);
  const auto& R = t_.rail;
  r.seat = dvec3(M * glm::dvec4(dvec3(R.seat), 1));
  dvec3 f = dvec3(M * glm::dvec4(std::sin(R.seatYaw), 0, std::cos(R.seatYaw), 0));
  r.fwd = glm::normalize(dvec3(f.x, 0, f.z) + dvec3(1e-9));
  const State& st = trains_[size_t(ride_.train)].st;
  r.speed = st.speed;
  r.trainPos = dvec3(M[3]); r.trainYaw = std::atan2(M[2][0], M[2][2]);
  const auto& S = t_.express.stations;
  if (ride_.departed && st.at == ride_.to) {
    const auto& s = S[size_t(ride_.to)];
    r.arrived = true; r.exit = s.hasExit ? s.exit : dvec3(s.board.x, s.board.y, s.heading);
    r.hint = s.name + " - arrived";
    return r;
  }
  char b[200];
  if (!ride_.departed) std::snprintf(b, sizeof b, "%s to %s - departing in %.0f s", t_.express.name.c_str(), S[size_t(ride_.to)].name.c_str(), st.left);
  else std::snprintf(b, sizeof b, "%s to %s - next %s - %.0f km/h", t_.express.name.c_str(), S[size_t(ride_.to)].name.c_str(), st.next >= 0 ? S[size_t(st.next)].name.c_str() : "", st.speed * 3.6);
  r.hint = b;
  return r;
}

void Express::addDraw(VehicleDraw& draw, const dvec3& cam) const {
  for (size_t k = 0; k < trains_.size(); k++) {
    glm::dmat4 M0;
    carMatrix(int(k), 0, M0);
    double d0 = glm::length(dvec3(M0[3]) - cam);
    bool mine = ride_.on && ride_.train == int(k);
    if (d0 > 4500 && !mine) continue;
    for (int c = 0; c < 4; c++) {
      glm::dmat4 M;
      carMatrix(int(k), c, M);
      double d = glm::length(dvec3(M[3]) - cam);
      if (d > 420 && !mine) { if (models_.rail.lo) draw.add(models_.rail.lo.get(), M, 0); continue; }
      if (mine && c == 0 && insideView && models_.rail.cabin) { draw.add(models_.rail.cabin.get(), M, 0); continue; }
      if (models_.rail.body.ok()) draw.add(models_.rail.body.model.get(), M * glm::dmat4(models_.rail.body.fit), d < 90 ? 0 : 1);
      if (models_.rail.frame) draw.add(models_.rail.frame.get(), M, 0);
      if (models_.rail.bogie && d < 200) for (const vec3& b : t_.rail.bogies) draw.add(models_.rail.bogie.get(), M * glm::translate(glm::dmat4(1), dvec3(b)), 0);
    }
  }
}
void Express::fillColliders(std::vector<Collider>& out, const dvec3& near) const {
  const auto& C = t_.rail.car;
  for (size_t k = 0; k < trains_.size(); k++) {
    if (ride_.on && ride_.train == int(k)) continue;
    for (int c = 0; c < 4; c++) {
      glm::dmat4 M;
      carMatrix(int(k), c, M);
      if (glm::length(dvec3(M[3]) - near) > 60) continue;
      Collider col;
      col.x = M[3][0]; col.z = M[3][2]; col.hw = C.hw; col.hd = C.half + C.gap / 2; col.rot = -std::atan2(M[2][0], M[2][2]); col.top = M[3][1] + C.roofTop;
      out.push_back(col);
    }
  }
}

} // namespace sl
