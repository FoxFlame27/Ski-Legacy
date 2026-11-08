#include "game/buses.h"
#include "core/log.h"
#include "game/drive.h"
#include "game/traffic.h"
#include "world/scenery.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr double BAY = 7, DWELL = 20;
}

void BusLine::init() {
  if (!t_.bus.ok || t_.stops.size() < 2) return;
  // the rider's seat: a window seat on the door side, row 2 (bus.js board)
  for (auto& s : t_.bus.seats) if (s.window && s.side < 0 && s.row == 2) { seatLocal_ = s.p; break; }
  int n = std::max(1, t_.bus.fleet);
  fleet_.resize(size_t(n));
  // bus 0 waits at the village; the others start their rounds spread over the network
  for (int k = 0; k < n; k++) {
    Bus& b = fleet_[size_t(k)];
    b.at = 0; b.idle = true; b.dwell = k == 0 ? 1e9 : 4.0 + k * 9.0;
    std::vector<Leg> L;
    int to = 1 + (k % int(t_.stops.size() - 1));
    if (legs(0, to, L)) { b.pose = place(L[0], L[0].s0); b.visible = true; }
    b.dest = to;
  }
  SL_INFO("buses: %d in the fleet, %zu stops", n, t_.stops.size());
}

// ---------------------------------------------------------------- the network (bus.js parent / toRoot / legs / leg)
const Road* BusLine::parent(int stop) const {
  for (const Road& r : t_.legs) if (r.to == stop && r.n > 3) return &r;
  for (const Road& r : t_.roads) if (r.to == stop && r.n > 3 && !r.access && !r.depot) return &r;
  return nullptr;
}
std::vector<const Road*> BusLine::toRoot(int stop) const {
  std::vector<const Road*> out;
  for (int s = stop, g = 0; g < 20; g++) { const Road* r = parent(s); if (!r) break; out.push_back(r); s = r->from; }
  return out;
}
bool BusLine::legs(int from, int to, std::vector<Leg>& out) const {
  out.clear();
  if (from == to || from < 0 || to < 0) return false;
  auto up = toRoot(from), down = toRoot(to);
  while (!up.empty() && !down.empty() && up.back() == down.back()) { up.pop_back(); down.pop_back(); }
  auto reach = [&](int s, const std::vector<const Road*>& l) { return l.empty() ? s : l.back()->from; };
  if (reach(from, up) != reach(to, down)) return false;
  for (const Road* r : up) out.push_back(leg(*r, true));
  for (int k = int(down.size()) - 1; k >= 0; k--) out.push_back(leg(*down[size_t(k)], false));
  for (auto& l : out) if (l.X.size() < 4) return false;
  return !out.empty();
}
bool BusLine::canRide(int from, int to) const { std::vector<Leg> L; return legs(from, to, L); }
std::vector<int> BusLine::destinations(int from) const {
  std::vector<int> out;
  for (int i = 0; i < int(t_.stops.size()); i++) if (i != from && !t_.stops[size_t(i)].noRoad && canRide(from, i)) out.push_back(i);
  return out;
}
BusLine::Leg BusLine::leg(const Road& r, bool rev) const {
  Leg t;
  int n = r.n;
  t.X.resize(size_t(n)); t.Y.resize(size_t(n)); t.Z.resize(size_t(n)); t.S.assign(size_t(n), 0); t.V.assign(size_t(n), 0);
  for (int k = 0; k < n; k++) {
    int i = rev ? n - 1 - k : k;
    t.X[size_t(k)] = r.X[size_t(i)]; t.Y[size_t(k)] = r.Y[size_t(i)]; t.Z[size_t(k)] = r.Z[size_t(i)];
    if (k) t.S[size_t(k)] = t.S[size_t(k - 1)] + std::hypot(t.X[size_t(k)] - t.X[size_t(k - 1)], t.Z[size_t(k)] - t.Z[size_t(k - 1)]);
  }
  t.length = t.S[size_t(n - 1)];
  t.to = rev ? r.from : r.to;
  const auto& B = t_.bus;
  for (int i = 0; i < n; i++) {
    int a = std::max(0, i - 4), b = std::min(n - 1, i + 4);
    double h0 = std::atan2(t.X[size_t(std::min(n - 1, a + 1))] - t.X[size_t(a)], t.Z[size_t(std::min(n - 1, a + 1))] - t.Z[size_t(a)]);
    double h1 = std::atan2(t.X[size_t(b)] - t.X[size_t(std::max(0, b - 1))], t.Z[size_t(b)] - t.Z[size_t(std::max(0, b - 1))]);
    double dh = std::fabs(wrapPi(h1 - h0)), k = dh / std::max(1.0, t.S[size_t(b)] - t.S[size_t(a)]);
    t.V[size_t(i)] = std::min(B.cruise, std::sqrt(B.lat / std::max(1e-4, k)));
  }
  t.V[0] = 0; t.V[size_t(n - 1)] = 0;
  t.s1 = std::max(0.0, t.length - BAY); t.s0 = std::min(BAY, t.length / 2);
  for (int i = 0; i < n; i++) if (t.S[size_t(i)] >= t.s1) t.V[size_t(i)] = 0;
  for (int i = n - 2; i >= 0; i--) t.V[size_t(i)] = std::min(t.V[size_t(i)], std::sqrt(t.V[size_t(i + 1)] * t.V[size_t(i + 1)] + 2 * B.brake * (t.S[size_t(i + 1)] - t.S[size_t(i)])));
  for (int i = 1; i < n; i++) if (t.S[size_t(i)] > t.s0) t.V[size_t(i)] = std::min(t.V[size_t(i)], std::sqrt(t.V[size_t(i - 1)] * t.V[size_t(i - 1)] + 2 * B.acc * (t.S[size_t(i)] - t.S[size_t(i - 1)])));
  return t;
}

// poseBus: the front and rear axles on the right-hand lane, each on the road's own surface
BusLine::Pose BusLine::place(const Leg& t, double s) const {
  auto at = [&](double q, dvec3& p, dvec2& d) {
    q = clamp(q, 0, t.length);
    size_t n = t.S.size(), lo = 0, hi = n - 1;
    while (hi - lo > 1) { size_t m = (lo + hi) / 2; if (t.S[m] <= q) lo = m; else hi = m; }
    double f = clamp((q - t.S[lo]) / std::max(1e-6, t.S[hi] - t.S[lo]), 0, 1);
    p = dvec3(t.X[lo] + (t.X[hi] - t.X[lo]) * f, t.Y[lo] + (t.Y[hi] - t.Y[lo]) * f, t.Z[lo] + (t.Z[hi] - t.Z[lo]) * f);
    size_t a = lo > 0 ? lo - 1 : 0, b = std::min(n - 1, hi + 1);
    d = glm::normalize(dvec2(t.X[b] - t.X[a], t.Z[b] - t.Z[a]) + dvec2(1e-9));
  };
  const double half = 3.0, lane = t_.bus.lane;
  dvec3 P, Q;
  dvec2 dp, dq;
  at(s + half, P, dp); at(s - half, Q, dq);
  dvec3 a(P.x - dp.y * lane, 0, P.z + dp.x * lane), b(Q.x - dq.y * lane, 0, Q.z + dq.x * lane);
  a.y = world_.groundHeight(a.x, a.z, P.y + 1); b.y = world_.groundHeight(b.x, b.z, Q.y + 1);
  Pose o;
  o.pos = (a + b) * 0.5;
  o.yaw = std::atan2(a.x - b.x, a.z - b.z);
  o.pitch = std::atan2(b.y - a.y, std::hypot(a.x - b.x, a.z - b.z));
  return o;
}

// clearAhead (simplified): the traffic in its lane ahead, your car, you on foot in its way: it brakes in time and waits
double BusLine::clearAhead(const Leg& t, double s, double v, const dvec3& player, const Drive* you, const Traffic* traffic, int self) const {
  Pose p = place(t, s);
  double fx = std::sin(p.yaw), fz = std::cos(p.yaw), look = 30 + v * v / (2 * 2.0), lim = 1e18;
  const double halfLen = t_.bus.len / 2;
  auto check = [&](double x, double z, double vl, double len) {
    double dx = x - p.pos.x, dz = z - p.pos.z, ahead = dx * fx + dz * fz, side = dx * fz - dz * fx;
    // its lane: right of the centre line (side < 0 here is left of the bus's heading ... the bus's own lane +- 2 m)
    if (ahead > 0 && ahead < look && std::fabs(side) < 2.2) {
      double room = ahead - halfLen - len / 2 - 3;
      double q = vl * vl + 2 * 2.0 * room;
      lim = std::min(lim, room <= 0 ? 0 : std::min(vl + room * 0.7, q > 0 ? std::sqrt(q) : 0.0));
    }
  };
  if (traffic) {
    std::vector<Traffic::CarView> cars;
    traffic->cars(cars);
    for (auto& c : cars) check(c.pos.x, c.pos.z, std::max(0.0, (std::sin(c.yaw) * fx + std::cos(c.yaw) * fz) * c.v), c.l);
  }
  if (you && you->active()) { dvec2 vv = you->vel(); check(you->pos().x, you->pos().z, std::max(0.0, vv.x * fx + vv.y * fz), you->halfLen() * 2); }
  else if (!ride_.on || ride_.bus != self) check(player.x, player.z, 0, 0.6);
  for (size_t k = 0; k < fleet_.size(); k++) {
    if (int(k) == self || !fleet_[k].visible) continue;
    const Pose& q = fleet_[k].pose;
    double vl = fleet_[k].at >= 0 ? 0 : std::max(0.0, (std::sin(q.yaw) * fx + std::cos(q.yaw) * fz) * fleet_[k].v);
    check(q.pos.x, q.pos.z, vl, t_.bus.len);
  }
  return lim;
}

// ---------------------------------------------------------------- the fleet + the ride
void BusLine::update(double dt, const dvec3& player, const Drive* you, const Traffic* traffic, bool fast) {
  if (fleet_.empty()) return;
  for (size_t k = 0; k < fleet_.size(); k++) {
    Bus& b = fleet_[k];
    bool mine = ride_.on && ride_.bus == int(k);
    double h = dt * (mine && fast ? 8 : 1);
    // distance-based update rate: a bus far from you is not simulated beyond its timetable steps
    if (b.at >= 0) {
      if (mine) {
        ride_.wait -= dt;
        if (ride_.wait > 0) continue;
        b.at = -1;
      } else {
        b.dwell -= dt;
        if (b.dwell > 0 || k == 0) continue;
        // off on its round: out to the next stop, or back to the village
        int from = b.at, to = from == 0 ? b.dest : 0;
        if (from == 0) { round_ = round_ % int(t_.stops.size() - 1) + 1; b.dest = round_; to = b.dest; }
        if (!legs(from, to, b.legs)) { b.dwell = 30; if (from == 0) continue; b.at = 0; continue; }
        b.li = 0; b.s = b.legs[0].s0; b.v = 0; b.at = -1;
      }
    }
    if (b.legs.empty()) continue;
    Leg& t = b.legs[size_t(b.li)];
    if (b.s >= t.s1 - 0.05) {
      // at the end of a leg: on to the next (it turns at the stop), or arrived
      if (b.li + 1 < int(b.legs.size())) {
        if (mine) { ride_.arrive -= dt; if (ride_.arrive > 0) continue; }
        b.li++; b.s = b.legs[size_t(b.li)].s0; b.v = 0;
        if (mine) ride_.arrive = 1.2;
        b.pose = place(b.legs[size_t(b.li)], b.s);
        continue;
      }
      b.at = t.to; b.dwell = DWELL; b.v = 0;
      if (mine && !ride_.done) { ride_.done = true; ride_.arrive = 1.2; }
      continue;
    }
    int i = 0;
    { size_t lo = 0, hi = t.S.size() - 1; while (hi - lo > 1) { size_t m = (lo + hi) / 2; if (t.S[m] <= b.s) lo = m; else hi = m; } i = int(lo); }
    double f = clamp((b.s - t.S[size_t(i)]) / std::max(1e-3, t.S[size_t(std::min<size_t>(t.S.size() - 1, size_t(i + 1)))] - t.S[size_t(i)]), 0, 1);
    double vt = std::max(b.s < t.s1 - 0.5 ? 1.2 : 0.0, t.V[size_t(i)] + (t.V[size_t(std::min<size_t>(t.V.size() - 1, size_t(i + 1)))] - t.V[size_t(i)]) * f);
    double dist = glm::length(b.pose.pos - player);
    if (dist < 700) vt = std::min(vt, clearAhead(t, b.s, b.v, player, you, traffic, int(k)));
    b.v += clamp(vt - b.v, -t_.bus.brake * 2 * h, t_.bus.acc * 1.5 * h);
    b.s = std::min(t.s1, b.s + b.v * h);
    b.pose = place(t, b.s);
    b.visible = true;
  }
}

int BusLine::stopNear(const dvec3& p, double r) const {
  int best = -1;
  double bd = r;
  for (size_t i = 0; i < t_.stops.size(); i++) {
    if (t_.stops[i].noRoad) continue;
    double d = std::hypot(t_.stops[i].x - p.x, t_.stops[i].z - p.z);
    // (or beside a bus waiting at the stop)
    for (const Bus& b : fleet_) if (b.at == int(i) && b.visible) d = std::min(d, std::hypot(b.pose.pos.x - p.x, b.pose.pos.z - p.z) - t_.bus.len / 2);
    if (d < bd) { bd = d; best = int(i); }
  }
  return best;
}

bool BusLine::board(int from, int to) {
  std::vector<Leg> L;
  if (fleet_.empty() || !legs(from, to, L)) return false;
  // a bus of the fleet waiting at that stop: you get on that one; else bus 0 comes to you
  int bi = 0;
  for (size_t k = 1; k < fleet_.size(); k++) if (fleet_[k].at == from) { bi = int(k); break; }
  Bus& b = fleet_[size_t(bi)];
  b.legs = std::move(L); b.li = 0; b.s = b.legs[0].s0; b.v = 0; b.at = from; b.visible = true;
  b.pose = place(b.legs[0], b.s);
  ride_ = Ride{};
  ride_.on = true; ride_.bus = bi; ride_.from = from; ride_.to = to; ride_.wait = 2.2;
  return true;
}

BusLine::RideState BusLine::rideState() const {
  RideState rs;
  if (!ride_.on) return rs;
  const Bus& b = fleet_[size_t(ride_.bus)];
  glm::dmat4 M = glm::translate(glm::dmat4(1), b.pose.pos) * glm::rotate(glm::dmat4(1), b.pose.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), b.pose.pitch, dvec3(1, 0, 0));
  rs.seat = dvec3(M * glm::dvec4(dvec3(seatLocal_), 1));
  rs.fwd = dvec3(std::sin(b.pose.yaw), 0, std::cos(b.pose.yaw));
  std::string to = stopName(ride_.to);
  if (ride_.done) {
    rs.hint = to + " - arrived";
    if (ride_.arrive <= 0 || b.at == ride_.to) {
      // out through the front door (the right side), clear of the bus, facing the way it points
      dvec3 door = dvec3(M * glm::dvec4(-(t_.bus.width / 2 + 1.8), 0, t_.bus.len / 2 - 2.0, 1));
      rs.arrived = true; rs.exit = dvec3(door.x, door.z, b.pose.yaw);
    }
    return rs;
  }
  double left = 0;
  if (!b.legs.empty()) { left = std::max(0.0, b.legs[size_t(b.li)].s1 - b.s); for (size_t k = size_t(b.li) + 1; k < b.legs.size(); k++) left += b.legs[k].s1 - b.legs[k].s0; }
  char buf[200];
  if (b.at == ride_.from && ride_.wait > 0) std::snprintf(buf, sizeof buf, "Ski bus to %s - doors closing", to.c_str());
  else std::snprintf(buf, sizeof buf, "Ski bus to %s - %.1f km - %.0f km/h", to.c_str(), left / 1000, b.v * 3.6);
  rs.hint = buf;
  return rs;
}
double BusLine::rideSpeed() const { return ride_.on ? fleet_[size_t(ride_.bus)].v : 0; }
dvec3 BusLine::busPos() const { return ride_.on ? fleet_[size_t(ride_.bus)].pose.pos : dvec3(0); }
double BusLine::busYaw() const { return ride_.on ? fleet_[size_t(ride_.bus)].pose.yaw : 0; }

void BusLine::boxes(std::vector<Obb>& out) const {
  for (const Bus& b : fleet_) if (b.visible) out.push_back({b.pose.pos.x, b.pose.pos.z, b.pose.yaw, t_.bus.width / 2 + 0.05, t_.bus.len / 2});
}
void BusLine::fillColliders(std::vector<Collider>& out) const {
  for (size_t k = 0; k < fleet_.size(); k++) {
    const Bus& b = fleet_[k];
    if (!b.visible || (ride_.on && ride_.bus == int(k))) continue;
    Collider c;
    c.x = b.pose.pos.x; c.z = b.pose.pos.z; c.hw = t_.bus.width / 2 + 0.05; c.hd = t_.bus.len / 2; c.rot = -b.pose.yaw; c.soft = true; c.top = b.pose.pos.y + 3.2;
    out.push_back(c);
  }
}
void BusLine::addDraw(VehicleDraw& draw, const dvec3& cam) const {
  if (!models_.bus.ok()) return;
  for (const Bus& b : fleet_) {
    if (!b.visible) continue;
    double d = glm::length(b.pose.pos - cam);
    if (d > 900) continue;
    glm::dmat4 M = glm::translate(glm::dmat4(1), b.pose.pos) * glm::rotate(glm::dmat4(1), b.pose.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), b.pose.pitch, dvec3(1, 0, 0));
    draw.add(models_.bus.model.get(), M * glm::dmat4(models_.bus.fit), d < 90 ? 0 : 1);
  }
}

} // namespace sl
