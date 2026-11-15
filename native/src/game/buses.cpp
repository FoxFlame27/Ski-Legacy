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
constexpr double BAY = 7;
// bus.js: braking for something in the lane (m/s^2), the gap it stops at behind something moving / standing (m), how
// long it waits behind something standing before it pulls out (s), its speed round it (m/s), the horn (s), held up
// this long in all it drives on through (s) at RAM_V (m/s); roads.js ROAD_HALF: half the plowed width
constexpr double CLEAR_DEC = 1.8, CLEAR_GAP = 4, STOP_GAP = 6, PASS_WAIT = 3, PASS_V = 5, HORN_T = 2, RAM_T = 20, RAM_V = 4.2;
constexpr double ROAD_HALF = 3.4, INF = 1e18;
// the fleet (bus.js): extra speed over the timetable's while behind it (share) and at most; s a bus that got to a stop
// after its timetable left still stands there; nearer you than FLEET_SIM a bus drives itself, drawn within FLEET_SHOW
constexpr double CATCH = 0.15, CATCH_MAX = 0.4, LATE_HOLD = 4, FLEET_SIM = 1300, FLEET_SHOW = 1300;
// the hold-ups (bus.js HOLD, server.js BUS_HOLD: keep the three the same) and how often a bus you drive is reported (ms)
constexpr double H_FRESH = 1, H_CATCH = 0.2, H_SHIFT = 0.35, H_MAX = 60, REPORT_MS = 250;
inline double sq(double v) { return v * v; }
inline double pmod(double a, double m) { return std::fmod(std::fmod(a, m) + m, m); }
// roads.js roadAt on a leg: the point at arc length s, its heading over ~10 m, the sample index below it
int legIndex(const std::vector<double>& S, double s) {
  size_t lo = 0, hi = S.size() - 1;
  while (hi - lo > 1) { size_t m = (lo + hi) / 2; if (S[m] <= s) lo = m; else hi = m; }
  return int(lo);
}
// (bus.js timeAt) when a way's timetable first reaches arc length s
double timeAt(const std::vector<double>& kt, const std::vector<double>& ks, double s) {
  for (size_t i = 1; i < ks.size(); i++)
    if (ks[i] >= s) return kt[i - 1] + (kt[i] - kt[i - 1]) * (ks[i] > ks[i - 1] ? (s - ks[i - 1]) / (ks[i] - ks[i - 1]) : 1);
  return kt.empty() ? 0 : kt.back();
}
}

void BusLine::init() {
  if (!t_.bus.ok || t_.stops.size() < 2) return;
  // the rider's seat: a window seat on the door side, row 2 (bus.js board / preferredSeat)
  for (auto& s : t_.bus.seats) if (s.window && s.side < 0 && s.row == 2) { seatLocal_ = s.p; break; }
  fleet_.assign(1, Bus{});
  fleet_[0].id = "bus:0";
  // bus:1..7 on the web game's timetable (bus.js buildFleet, exported): bus k at fleet_[k]
  if (t_.fleet.ok)
    for (size_t i = 0; i < t_.fleet.buses.size(); i++) {
      const Transport::FleetBus& F = t_.fleet.buses[i];
      const int id = F.id.rfind("bus:", 0) == 0 ? std::atoi(F.id.c_str() + 4) : 0;
      if (id <= 0 || id > 64) continue;
      if (fleet_.size() <= size_t(id)) fleet_.resize(size_t(id) + 1);
      Bus& b = fleet_[size_t(id)];
      b.fi = int(i); b.id = F.id;
      auto path = [](const Transport::FleetWay& w, Path& P) {
        P.X.assign(w.X.begin(), w.X.end()); P.Y.assign(w.Y.begin(), w.Y.end()); P.Z.assign(w.Z.begin(), w.Z.end());
        P.S.assign(w.S.begin(), w.S.end()); P.V.assign(w.V.begin(), w.V.end());
        P.length = w.length; P.marks = w.marks; P.kt = w.kt; P.ks.assign(w.ks.begin(), w.ks.end());
        P.sA = w.sA; P.sB = w.sB; P.dur = w.dur; P.s0 = w.sA; P.s1 = w.sB;
      };
      path(F.out, b.out); path(F.back, b.back);
    }
  for (size_t k = 1; k < fleet_.size(); k++) if (fleet_[k].fi < 0) fleet_[k].id = "bus:" + std::to_string(k);   // (a gap: never used)
  parkBus0();
  int n = 0;
  for (const Bus& b : fleet_) n += b.fi >= 0;
  std::string names;
  for (size_t i = 0; i < t_.stops.size(); i++) names += (i ? ", " : "") + std::to_string(i) + " " + t_.stops[i].name;
  SL_INFO("buses: bus 0 and %d on the timetable (%s), %zu stops: %s", n, t_.fleet.ok ? "the web game's" : "MISSING: re-export the data", t_.stops.size(), names.c_str());
}

// bus 0 between rides (single player): in its own bay at the depot (bus.js parkInDepot), else at the village stop
void BusLine::parkBus0() {
  if (fleet_.empty()) return;
  Bus& b = fleet_[0];
  b.legs.clear(); b.li = 0; b.v = 0; resetPass(b);
  const auto& F = t_.fleet;
  if (F.parkX.size() >= 4 && F.parkS.size() == F.parkX.size()) {
    Leg L;
    L.X.assign(F.parkX.begin(), F.parkX.end()); L.Y.assign(F.parkY.begin(), F.parkY.end()); L.Z.assign(F.parkZ.begin(), F.parkZ.end()); L.S.assign(F.parkS.begin(), F.parkS.end());
    L.length = L.S.back();
    b.pose = place(L, F.parkS1); b.at = -1; b.visible = true;
    return;
  }
  for (const Road& r : t_.roads)
    if (r.from == 0 && r.n > 3 && !r.access && !r.depot) { Leg L = leg(r, false); b.pose = place(L, std::min(BAY, L.length / 2)); b.at = 0; b.visible = true; return; }
  b.visible = false;
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

// poseBus: the front and rear axles on the right-hand lane, each on the road's own surface. Overtaking (shift 0..1):
// out into the other lane; changing lanes the bus steers: the front axle is already further across than the rear (the
// slope of the path it traces, lateral speed / forward speed), so it turns out and back in instead of sliding sideways
BusLine::Pose BusLine::place(const Leg& t, double s, double shift, double shiftV, double v) const {
  auto at = [&](double q, dvec3& p, dvec2& d) {
    q = clamp(q, 0, t.length);
    size_t n = t.S.size(), lo = 0, hi = n - 1;
    while (hi - lo > 1) { size_t m = (lo + hi) / 2; if (t.S[m] <= q) lo = m; else hi = m; }
    double f = clamp((q - t.S[lo]) / std::max(1e-6, t.S[hi] - t.S[lo]), 0, 1);
    p = dvec3(t.X[lo] + (t.X[hi] - t.X[lo]) * f, t.Y[lo] + (t.Y[hi] - t.Y[lo]) * f, t.Z[lo] + (t.Z[hi] - t.Z[lo]) * f);
    size_t a = lo > 0 ? lo - 1 : 0, b = std::min(n - 1, hi + 1);
    d = glm::normalize(dvec2(t.X[b] - t.X[a], t.Z[b] - t.Z[a]) + dvec2(1e-9));
  };
  const double half = 3.0, lane = t_.bus.lane * (1 - 2 * shift);
  const double slope = clamp((-2 * t_.bus.lane * shiftV) / std::max(1.0, v), -0.32, 0.32);
  const double lf = lane + slope * half, lr = lane - slope * half;
  dvec3 P, Q;
  dvec2 dp, dq;
  at(s + half, P, dp); at(s - half, Q, dq);
  dvec3 a(P.x - dp.y * lf, 0, P.z + dp.x * lf), b(Q.x - dq.y * lr, 0, Q.z + dq.x * lr);
  a.y = world_.groundHeight(a.x, a.z, P.y + 1); b.y = world_.groundHeight(b.x, b.z, Q.y + 1);
  Pose o;
  o.pos = (a + b) * 0.5;
  o.yaw = std::atan2(a.x - b.x, a.z - b.z);
  o.pitch = std::atan2(b.y - a.y, std::hypot(a.x - b.x, a.z - b.z));
  return o;
}

// steerShift: the lane change (shift 0..1 toward passing): a critically damped spring (eases out and in, an S-curve),
// its lateral speed at most ~0.3 of the forward speed so the bus steers round, never slides sideways; nearly at a
// standstill it only creeps across
void BusLine::steerShift(Bus& r, double dt, double v, double lane) {
  const double W = 2.1, x = r.shift, sv = r.shiftV, a = W * W * ((r.passing ? 1 : 0) - x) - 2 * W * sv;
  const double cap = (0.3 * std::max(0.7, v)) / (2 * lane);
  r.shiftV = clamp(sv + a * dt, -cap, cap);
  r.shift = clamp(x + r.shiftV * dt, 0, 1);
  if (r.shift == 0 || r.shift == 1) r.shiftV *= 0.5;
}
void BusLine::resetPass(Bus& r) {
  r.passing = false; r.shift = 0; r.shiftV = 0; r.ram = false; r.blockT = 0; r.passV = INF; r.heldT = 0; r.slowT = 0; r.horn = 0; r.ramFree = 0;
}
double BusLine::maxShift() const { double m = 0; for (const Bus& b : fleet_) if (b.visible) m = std::max(m, b.shift); return m; }

// obstacles(): everything the bus must not drive through, as boxes: the traffic (driving: its speed; parked or knocked:
// standing), the parked cars (yours left on the road among them), the car you drive, the other buses, you on foot or
// on skis
void BusLine::gather(const dvec3& player, double dt, Drive* you, Traffic* traffic) {
  obs_.clear();
  auto add = [&](double x, double y, double z, double yaw, double hw, double hd, double v, Ob::Kind kind) -> Ob& {
    obs_.push_back(Ob{x, y, z, yaw, hw, hd, v, kind, -1, -1, -1, true, false});
    return obs_.back();
  };
  if (traffic)
    for (size_t i = 0; i < traffic->list.size(); i++) {
      const Traffic::Car& c = traffic->list[i];
      if (c.mode == Traffic::Car::Mode::Gone) continue;
      add(c.x, c.y, c.z, c.yaw, c.w / 2, c.l / 2, c.mode == Traffic::Car::Mode::Road ? c.v : 0, Ob::Car).car = int(i);
    }
  if (you) {
    for (size_t i = 0; i < you->parked.size(); i++) {
      const Drive::Parked& e = you->parked[i];
      if (!e.driving) add(e.x, e.y, e.z, e.yaw, 0.97, e.length / 2, 0, Ob::Car).park = int(i);
    }
    if (you->active()) {
      dvec3 p = you->pos();
      dvec2 vv = you->vel();
      double yaw = you->yaw();
      add(p.x, p.y, p.z, yaw, you->halfWidth(), you->halfLen(), vv.x * std::sin(yaw) + vv.y * std::cos(yaw), Ob::You).drive = true;
    }
  }
  for (size_t k = 0; k < fleet_.size(); k++) {
    const Bus& b = fleet_[k];
    if (!b.visible) continue;
    add(b.pose.pos.x, b.pose.pos.y, b.pose.pos.z, b.pose.yaw, t_.bus.width / 2, t_.bus.len / 2, b.at >= 0 ? 0 : b.v, Ob::BusK).fleet = int(k);
  }
  // you, on foot or on skis (not in your car, not riding the bus): your speed from your motion
  if (dt > 0) {
    double dx = player.x - lastPlayer_.x, dz = player.z - lastPlayer_.z, d = std::hypot(dx, dz);
    double v = d > 20 ? 0 : d / dt;
    playerV_ += (std::min(v, 40.0) - playerV_) * std::min(1.0, dt * 6);
    if (d > 20) playerV_ = 0;
    else if (v > 0.2) playerYaw_ = std::atan2(dx, dz);
    lastPlayer_ = player;
  }
  if (!(you && you->active()) && !ride_.on) add(player.x, player.y, player.z, playerV_ > 0.2 ? playerYaw_ : 0, 0.35, 0.35, playerV_, Ob::Ped);
  // (multiplayer) the other players about on foot / on skis, and their cars
  for (const ExtraOb& e : extraObs) add(e.x, e.y, e.z, e.yaw, e.hw, e.hd, e.v, e.ped ? Ob::Ped : Ob::Car);
}

// clearAhead: the speed (m/s) the bus may drive at so it stops short of whatever stands in its lane ahead, along the
// road it drives (round the bends too). Anything on the road in the lane it is in or moving to counts. Held up behind
// something standing (PASS_WAIT) or crawling (1.5 s) in its lane, with the other lane clear far enough ahead (oncoming
// traffic's approach included) and the road going on long enough, it pulls out (slowly round something standing:
// PASS_V), passes with room to spare and pulls back in once its lane is clear beside and behind it. Held up RAM_T in
// all it drives on through at RAM_V (ramContact shoves what its front runs into aside).
double BusLine::clearAhead(const Leg& t, Bus& r, double dt, double want, int self, bool probe) {
  const auto& B = t_.bus;
  const dvec3 g = r.pose.pos;
  const double sh = r.shift;
  const double look = 30 + (r.v * r.v) / (2 * CLEAR_DEC), far = std::max(look, 150.0);
  // anything near at all? (most of the time nothing is: cheap)
  bool any = false;
  for (const Ob& o : obs_) if (o.fleet != self && std::fabs(o.x - g.x) < far + 12 && std::fabs(o.z - g.z) < far + 12) { any = true; break; }
  if (!any && probe) return INF;
  if (!any) { r.heldT = 0; r.slowT = 0; r.blockT = 0; r.passing = false; r.ram = false; r.horn = 0; if (sh < 0.05) r.passV = INF; return INF; }
  const int n = int(t.S.size());
  auto index = [&](double q) { q = clamp(q, 0, t.length); size_t lo = 0, hi = size_t(n) - 1; while (hi - lo > 1) { size_t m = (lo + hi) / 2; if (t.S[m] <= q) lo = m; else hi = m; } return int(lo); };
  const int i0 = index(r.s - B.len), i1 = index(r.s + far) + 1;
  // the lateral band the bus sweeps: where it is now to the lane it is heading for
  const double busLat = B.lane * (1 - 2 * sh), tgtLat = r.passing ? -B.lane : B.lane;
  const double lo = std::min(busLat, tgtLat), hi = std::max(busLat, tgtLat);
  double lim = INF, otherAhead = INF, tGap = INF;
  const Ob* blocker = nullptr;
  struct Own { bool on = false; double gap = 0, vo = 0, along = 0; } own;
  bool otherNear = false, ownBeside = false;
  for (const Ob& o : obs_) {
    if (o.fleet == self) continue;
    const bool ped = o.kind == Ob::Ped;
    const double reach = ped ? look + 12 : far + 12;   // (people: only where it might have to stop for them)
    if (std::fabs(o.x - g.x) > reach || std::fabs(o.z - g.z) > reach) continue;
    if (o.hasY && std::fabs(o.y - g.y) > 5) continue;   // (on a bridge over the road, in a tunnel under it)
    // the nearest point of the road: how far along, how far to the side of the centre line
    int bj = -1;
    double bd = INF;
    for (int j = i0; j <= std::min(n - 2, i1); j++) { double d = sq(t.X[size_t(j)] - o.x) + sq(t.Z[size_t(j)] - o.z); if (d < bd) { bd = d; bj = j; } }
    if (bj < 0) continue;
    const size_t J = size_t(bj);
    const double hx = t.X[J + 1] - t.X[J], hz = t.Z[J + 1] - t.Z[J], hl0 = std::hypot(hx, hz), hl = hl0 > 0 ? hl0 : 1, ux = hx / hl, uz = hz / hl;
    const double dx = o.x - t.X[J], dz = o.z - t.Z[J], s = t.S[J] + dx * ux + dz * uz;
    const double latC = -dx * uz + dz * ux;   // (right of the heading (ux, uz) is (-uz, ux))
    const double ca = std::fabs(std::sin(o.yaw) * ux + std::cos(o.yaw) * uz), sa = std::sqrt(std::max(0.0, 1 - ca * ca));
    const double across = o.hw * ca + o.hd * sa, along = o.hw * sa + o.hd * ca;
    if (std::fabs(latC) - across > ROAD_HALF + (ped ? 0.05 : 0.6)) continue;   // (off the road: the verge, the waiting area at a stop)
    const double W = B.width / 2 + across + (ped ? 0.3 : 0.35);
    const bool inOwn = std::fabs(latC - B.lane) < W, inOther = std::fabs(latC + B.lane) < W;
    const double ds = s - r.s, vAlong = o.v * (std::sin(o.yaw) * ux + std::cos(o.yaw) * uz);
    // the other lane: anything near the bus or ahead of it there (something coming the other way: further ahead, by
    // how far it closes in while the bus passes)
    if (inOther) {
      const double rch = ds - std::max(0.0, -vAlong) * 9;
      if (ds > -B.len / 2 - along - 3 && ds < B.len / 2 + along + 6) otherNear = true;
      if (ds > 0) otherAhead = std::min(otherAhead, rch - B.len / 2 - along);
    }
    if (inOwn && ds > -(B.len / 2 + along + 8) && ds < B.len / 2 + along + 30) ownBeside = true;   // (beside it, still ahead in its lane, or not yet 8 m behind)
    if (latC < lo - W || latC > hi + W) continue;   // (not in the band it drives in)
    const double gap = ds - B.len / 2 - along;
    if (ds < 0 || gap > look) continue;
    // going the bus's way: follow at its speed; anything else: stop short of it (further back from something
    // standing: room to pull round it); pulling round, as close as it needs
    const double vo = std::max(0.0, vAlong);
    const double keep = r.passing && inOwn ? 1.2 : vo < 0.6 ? STOP_GAP : CLEAR_GAP;
    const double room = gap - keep, v = room > 0 ? std::sqrt(vo * vo + 2 * CLEAR_DEC * room) : 0;
    if (v < lim) { lim = v; blocker = &o; }
    if (inOwn && (!own.on || gap < own.gap)) own = {true, gap, vo, along};
    if (gap < tGap) tGap = gap;
  }
  if (probe) return lim;
  // overtaking: held up behind something in its own lane, standing (PASS_WAIT) or going clearly slower than the bus
  // wants to (1.5 s). The road it needs: the bus closes the gap, its own length, the other's and a margin at the speed
  // difference, at its own speed; the other lane must be clear that far (at least 60 m: oncoming traffic's approach
  // included) and the road must go on far enough (not into its stop)
  const double vWant = std::max(8.0, std::min(want, B.cruise));
  const bool standing = own.on && own.vo < 0.6;
  const bool slowed = own.on && own.gap < 45 && (standing ? r.v < 0.8 : own.vo < vWant * 0.8 && r.v < vWant * 0.85);
  r.slowT = slowed ? r.slowT + dt : 0;
  r.dOtherAhead = otherAhead; r.dOtherNear = otherNear; r.dOwn = own.on; r.dOwnV = own.vo; r.dLeft = t.s1 - r.s;
  r.dNeed = own.on ? std::min(450.0, std::max(60.0, ((own.gap + 2 * own.along + B.len + 12) / std::max(3.0, (own.vo < 3 ? std::max(PASS_V, own.vo + 3) : vWant) - own.vo)) * (own.vo < 3 ? std::max(PASS_V, own.vo + 3) : vWant) + 20)) : 0;
  if (!r.passing && !r.ram && r.slowT > (standing ? PASS_WAIT : 1.5)) {
    const double vp = own.vo < 3 ? std::max(PASS_V, own.vo + 3) : vWant;
    const double rel = std::max(3.0, vp - own.vo), past = own.gap + 2 * own.along + B.len + 12;
    const double need = std::min(450.0, std::max(60.0, (past / rel) * vp + 20));
    if (!otherNear && otherAhead > need && t.s1 - r.s > (standing ? past + 15 : need + 10)) { r.passing = true; r.slowT = 0; r.passV = own.vo < 3 ? vp : INF; overtakes++; }
  }
  // back in once its own lane is clear beside it and just behind (or the other lane gets busy ahead: back in as soon
  // as there is room)
  if (r.passing && !ownBeside) r.passing = false;
  // still behind it and something now comes in the other lane: give up, back in behind it
  if (r.passing && own.on && own.gap > 0 && otherAhead < own.gap + 2 * own.along + B.len + 10) r.passing = false;
  if (!r.passing && sh < 0.05) r.passV = INF;
  if (r.passV < INF) lim = std::min(lim, r.passV);   // (out round something standing: slowly, and back in)
  // held up: the horn after HORN_T (not at another bus), RAM_T in all (waiting to pull out included)
  const bool held = blocker && r.v < 1 && lim < 2;
  r.heldT = held ? r.heldT + dt : 0;
  r.blockT = held || (r.passing && r.v < 2) ? r.blockT + dt : std::max(0.0, r.blockT - dt * 0.5);
  if (r.heldT > 3 && blocker && blocker->car >= 0 && traffic_ && !r.ram) { traffic_->takeOff(blocker->car); r.heldT = 0; }   // (a traffic car: off the road)
  if (held && blocker->kind != Ob::BusK) {
    if (r.heldT > HORN_T && r.horn == 0) { r.horn = 1; departures.push_back(g); }
    else if (r.heldT > HORN_T + 6 && r.horn == 1) { r.horn = 2; departures.push_back(g); }
  } else if (!held) r.horn = 0;
  if (!r.ram && r.blockT > RAM_T) { r.ram = true; r.ramFree = 0; rams++; }
  if (r.ram) {
    lim = std::max(lim, RAM_V);   // (what its front runs into is shoved aside: ramContact)
    r.ramFree = !blocker || tGap > 12 ? r.ramFree + dt : 0;
    if (r.ramFree > 1.5) { r.ram = false; r.blockT = 0; }
  }
  return lim;
}

// Pushing through (RAM_T up): whatever its body runs into is bumped out of the way, to the side it is on (the verge
// when dead ahead) and a little forward, never driven through: a traffic car knocked aside (Traffic::knock), a parked
// car shoved (drive.js shove), your car pushed.
void BusLine::ramContact(const Bus& b, int self, double dt) {
  if (!(dt > 0)) return;
  const auto& B = t_.bus;
  const dvec3& g = b.pose.pos;
  const double fx = std::sin(b.pose.yaw), fz = std::cos(b.pose.yaw), v = b.v;
  for (const Ob& o : obs_) {
    if (o.fleet == self || o.kind == Ob::BusK || o.kind == Ob::Ped) continue;
    const double dx = o.x - g.x, dz = o.z - g.z;
    if (std::fabs(dx) > 16 || std::fabs(dz) > 16) continue;
    if (o.hasY && std::fabs(o.y - g.y) > 4) continue;
    const double along = dx * fx + dz * fz, lat = -dx * fz + dz * fx;   // (lat > 0: right of the bus, the verge side)
    const double ca = std::fabs(std::sin(o.yaw) * fx + std::cos(o.yaw) * fz), sa = std::sqrt(std::max(0.0, 1 - ca * ca));
    const double across = o.hw * ca + o.hd * sa, alongE = o.hw * sa + o.hd * ca;
    if (std::fabs(along) > B.len / 2 + alongE + 0.5) continue;
    const double pen = B.width / 2 + across + 0.25 - std::fabs(lat);
    if (pen <= 0) continue;
    const double side = lat > -0.3 ? 1 : -1, sx = -fz * side, sz = fx * side;   // (out to that side)
    const double sp = std::max(2.5, v * 1.1 + 1.5), vx = (sx * 0.85 + fx * 0.5) * sp, vz = (sz * 0.85 + fz * 0.5) * sp;
    const double step = std::min(pen, sp * dt), fwd = std::min(step, std::max(0.0, v) * dt) * 0.5;
    const double mx = sx * step + fx * fwd, mz = sz * step + fz * fwd;
    // (the same car is knocked again 600 ms later at the earliest)
    const int key = o.car >= 0 ? o.car : o.park >= 0 ? 100000 + o.park : -1;
    bool again = key >= 0, known = false;
    for (auto& [k, at] : shoved_) if (k == key) { known = true; again = clock_ - at >= 0.6; if (again) at = clock_; break; }
    if (key >= 0 && !known) shoved_.push_back({key, clock_});
    const double spin = (std::fmod(std::fabs(o.x * 12.9898 + o.z * 78.233 + clock_ * 37.7), 1.0) - 0.5) * 1.2;
    if (o.car >= 0) { if (again && traffic_) traffic_->knock(o.car, vx, vz, spin); }
    else if (o.park >= 0) { if (again && you_ && size_t(o.park) < you_->parked.size()) { Drive::Parked& e = you_->parked[size_t(o.park)]; e.svx = vx; e.svz = vz; e.sw = spin * 0.7; } }
    else if (o.drive && you_) you_->push(mx, mz, vx, vz);
  }
}

// ---------------------------------------------------------------- the fleet + the ride
void BusLine::update(double dt, const dvec3& player, Drive* you, Traffic* traffic, bool fast) {
  if (fleet_.empty()) return;
  you_ = you; traffic_ = traffic;
  clock_ += dt;
  gather(player, dt, you, traffic);
  if (shoved_.size() > 64) shoved_.erase(shoved_.begin(), shoved_.begin() + 32);
  if (ride_.on && !ride_.mp) driveRide(dt, fast);
  // bus 0 waiting at the village stop (after a ride there): once you are well away from it, back in its bay at the
  // depot, out of the way of the buses coming in to the stop (bus.js updateFleet); online it is out of the game
  Bus& b0 = fleet_[0];
  if (mpOn_) b0.visible = false;
  else if (!(ride_.on && ride_.bus == 0) && b0.at == 0 && b0.visible && !t_.fleet.parkX.empty() && std::hypot(b0.pose.pos.x - player.x, b0.pose.pos.z - player.z) > 90) parkBus0();
  updateFleet(dt, player);
  if (ride_.on && ride_.mp && fleet_[size_t(ride_.bus)].at != ride_.from) ride_.departed = true;
}

// single player: the bus you ride (bus 0, or a fleet bus taken off its round) drives the legs of your trip
void BusLine::driveRide(double dt, bool fast) {
  Bus& b = fleet_[size_t(ride_.bus)];
  const int k = ride_.bus;
  const double h = dt * (fast ? 8 : 1);
  if (b.at >= 0) {
    ride_.wait -= dt;
    if (ride_.wait > 0) return;
    b.at = -1;
  }
  if (b.legs.empty()) return;
  Leg& t = b.legs[size_t(b.li)];
  if (b.s >= t.s1 - 0.05) {
    // at the end of a leg: on to the next (it turns at the stop), or arrived
    if (b.li + 1 < int(b.legs.size())) {
      ride_.arrive -= dt;
      if (ride_.arrive > 0) return;
      b.li++; b.s = b.legs[size_t(b.li)].s0; b.v = 0;
      resetPass(b);
      ride_.arrive = 1.2;
      b.pose = place(b.legs[size_t(b.li)], b.s);
      return;
    }
    b.at = t.to; b.v = 0;
    resetPass(b);
    b.pose = place(t, b.s);
    if (!ride_.done) { ride_.done = true; ride_.arrive = 1.2; }
    return;
  }
  const int i = legIndex(t.S, b.s);
  const size_t i1 = std::min<size_t>(t.S.size() - 1, size_t(i + 1));
  const double f = clamp((b.s - t.S[size_t(i)]) / std::max(1e-3, t.S[i1] - t.S[size_t(i)]), 0, 1);
  double vt = std::max(b.s < t.s1 - 0.5 ? 1.2 : 0.0, t.V[size_t(i)] + (t.V[i1] - t.V[size_t(i)]) * f);
  // anything in its lane ahead, along the road it drives: it never drives through it, it brakes in time and waits,
  // pulls round it, or after RAM_T pushes through
  vt = std::min(vt, clearAhead(t, b, dt, vt, k));
  steerShift(b, h, b.v, t_.bus.lane);
  b.v += clamp(vt - b.v, -t_.bus.brake * 2 * h, t_.bus.acc * 1.5 * h);
  b.s = std::min(t.s1, b.s + b.v * h);
  b.pose = place(t, b.s, b.shift, b.shiftV, b.v);
  b.visible = true;
  if (b.ram) ramContact(b, k, h);
}

// ---------------------------------------------------------------- the timetable (bus.js fleetTarget .. updateFleet)
const BusLine::Path& BusLine::way(const Bus& b, int dir) const { return dir ? b.back : b.out; }
double BusLine::roundTime(const Bus& b) const {
  return mpOn_ && mp_.time ? mp_.time(t_.fleet.buses[size_t(b.fi)].line) : fleetClock_;   // (online: its round's shared timeline)
}
// where bus b's timetable has it at the fleet's clock (less `late` s: a held-up bus)
BusLine::Target BusLine::fleetTarget(const Bus& b, double late) const {
  const Transport::FleetBus& F = t_.fleet.buses[size_t(b.fi)];
  double tau = pmod(roundTime(b) + F.phase - late, F.cycle);
  Target T;
  if (tau < b.out.dur) T.dir = 0;
  else { tau -= b.out.dur; T.dir = 1; }
  T.tau = tau;
  // (bus.js dirAt) the way's state at tau: s, v, the stop it waits at
  const Path& P = way(b, T.dir);
  const auto& kt = P.kt;
  const auto& ks = P.ks;
  const size_t n = kt.size();
  if (tau <= 0) { T.s = ks[0]; T.v = 0; T.mark = -1; return T; }
  if (tau >= kt[n - 1]) { T.s = ks[n - 1]; T.v = 0; T.mark = int(P.marks.size()) - 1; return T; }
  size_t lo = 0, hi = n - 1;
  while (hi - lo > 1) { size_t m = (lo + hi) >> 1; if (kt[m] <= tau) lo = m; else hi = m; }
  const double d = kt[hi] - kt[lo], f = d > 1e-6 ? (tau - kt[lo]) / d : 0;
  T.s = ks[lo] + (ks[hi] - ks[lo]) * f;
  T.v = d > 1e-6 ? (ks[hi] - ks[lo]) / d : 0;
  T.mark = -1;
  if (T.v < 1e-3) for (size_t i = 0; i < P.marks.size(); i++) if (std::fabs(P.marks[i].s - T.s) < 0.5) { T.mark = int(i); break; }
  return T;
}
// bus b exactly where its timetable T has it (no delay)
void BusLine::fleetReset(Bus& b, const Target& T) {
  b.st = true;
  b.dir = T.dir; b.s = T.s; b.v = T.v; b.mark = T.mark; b.dwell = 0; b.hold = 0;
  b.shift = 0; b.shiftV = 0; b.passing = false; b.passV = INF; b.ram = false; b.ramFree = 0;
  b.lag = 0; b.lagS = 0; b.heldT = 0; b.slowT = 0; b.blockT = 0; b.horn = 0;
}
// A bus near you: where its timetable has it, less a delay of its own while it is held up by something in its lane
// (clearAhead), and a lane offset while it overtakes. Never ahead of its timetable; behind it, it catches up (up to
// CATCH faster, more when its next stop is near); it leaves every stop when the timetable does (late: LATE_HOLD)
void BusLine::fleetDrive(Bus& b, const Target& T, double dt) {
  const int self = int(&b - fleet_.data());
  Path* P = b.dir ? &b.back : &b.out;
  auto last = [&]() { return int(P->marks.size()) - 1; };
  double Ts = 0, Tv = 0;
  int Tm = -1;
  auto tt = [&]() { if (T.dir == b.dir) { Ts = T.s; Tv = T.v; Tm = T.mark; } else { Ts = P->sB; Tv = 0; Tm = last(); } };
  tt();
  if (b.mark >= 0) {
    // standing at a stop: off again when the timetable has it gone (late: after LATE_HOLD)
    b.dwell += dt; b.v = 0;
    const bool still = T.dir == b.dir && T.mark == b.mark;
    if (!still && b.dwell >= b.hold) {
      if (!P->marks[size_t(b.mark)].depot) departures.push_back(b.pose.pos);   // (Phase 7: the horn as it pulls out)
      if (b.mark == last() && T.dir != b.dir) { b.dir = T.dir; P = b.dir ? &b.back : &b.out; b.s = P->sA; tt(); }   // (the end of the way: on to the other one)
      b.mark = -1; b.dwell = 0; b.hold = 0;
    }
  }
  if (b.mark < 0) {
    int next = last();
    for (size_t i = 0; i < P->marks.size(); i++) if (P->marks[i].s > b.s + 0.05) { next = int(i); break; }
    const double ns = P->marks[size_t(next)].s;
    const double vRoad = std::max(1.5, P->V[size_t(legIndex(P->S, clamp(b.s, 0, P->S.back())))]);
    const double lag = std::max(0.0, Ts - b.s);
    P->s1 = ns;
    const double lim = clearAhead(*P, b, dt, std::max(vRoad, Tv), self);
    if (lim >= Tv && !b.passing && b.shift < 0.002 && lag < 0.05 && std::fabs(b.v - Tv) < 0.6) {
      b.s = Ts; b.v = Tv;   // (on time, nothing in the way: exactly where the timetable has it)
    } else {
      // behind: faster than the timetable by what closes the gap before the timetable gets to the next stop
      const double dT = std::max(4.0, ns - Ts);
      const double k = clamp((1.1 * lag) / dT, CATCH, CATCH_MAX);
      double vt = Tv > 3 ? Tv + std::min(0.5 * lag, Tv * k) : Tv + std::min(0.5 * lag + 1, vRoad);
      vt = std::min(vt, std::max(vRoad * (1 + CATCH_MAX), 1.5));
      vt = std::min(vt, std::sqrt(2 * 1.3 * std::max(0.0, ns - b.s)) + 0.4);   // (to a stop at the next one)
      vt = std::min(vt, lim);
      b.v = std::max(0.0, b.v + clamp(vt - b.v, -t_.bus.brake * 2 * dt, t_.bus.acc * dt));
      b.s = std::min({Ts, ns, b.s + b.v * dt});
      if (b.s >= Ts - 1e-4 && !b.passing) b.v = std::min(b.v, Tv + 0.3);   // (caught up: no faster than the timetable now)
    }
    steerShift(b, dt, b.v, t_.bus.lane);
    // at the stop (or held up just short of it while the timetable stands there: it opens its doors there)
    const bool there = b.s >= ns - 0.05, held = ns - b.s < 25 && lim < 0.5 && b.v < 0.3 && Tm == next;
    if (there || held) {
      if (there) b.s = std::max(b.s, ns);
      b.mark = next; b.v = 0; b.dwell = 0;
      b.hold = Tm == next || P->marks[size_t(next)].depot || next == last() ? 0 : LATE_HOLD;   // (the timetable gone already: a short halt)
    }
  }
  b.lagS = std::max(0.0, Ts - b.s);
  b.lag = T.dir != b.dir ? 999 : b.lagS / std::max(6.0, T.v);   // (how far behind the timetable, s: roughly)
}

// the hold-ups (bus.js holdFor / holdAt): bus b's record now (aged), false if none (or aged out: forgotten)
bool BusLine::holdFor(Bus& b, double now, HoldAt& H) {
  auto it = holds_.find(b.id);
  if (it == holds_.end()) return false;
  const Hold& rec = it->second;
  const double el = std::max(0.0, (now - rec.at) / 1000), f = std::min(el, H_FRESH), late = el - f;
  H.fresh = el < H_FRESH;
  H.d = clamp(rec.d + rec.dd * f - H_CATCH * late, 0, H_MAX);
  H.sh = clamp(rec.sh + rec.sv * f - H_SHIFT * late, 0, 1);
  H.ram = rec.ram && H.fresh;
  H.bt = rec.bt + (H.fresh ? el : 0);
  H.done = !H.fresh && H.d <= 0 && H.sh <= 0;
  H.own = rec.own;
  if (H.done) { holds_.erase(it); return false; }
  return true;
}
// how far behind its timetable bus b is (s on its round's timeline): when its timetable was where it is now
double BusLine::delayOf(const Bus& b) const {
  const Transport::FleetBus& F = t_.fleet.buses[size_t(b.fi)];
  const double c = F.cycle;
  const Path& P = way(b, b.dir);
  const bool atMark = b.mark >= 0 && std::fabs(b.s - P.marks[size_t(b.mark)].s) < 1;
  const double at = atMark ? P.marks[size_t(b.mark)].t + std::min(b.dwell, P.marks[size_t(b.mark)].dwell) : timeAt(P.kt, P.ks, b.s);
  const double tau = pmod(roundTime(b) + F.phase, c);
  const double D = pmod(tau - (b.dir ? b.out.dur : 0) - at, c);
  return D > c / 2 ? 0 : std::min(D, H_MAX);   // (never ahead of it)
}
// a bus you drive near you: off its timetable -> reported (REPORT_MS, at once when it pulls out / in or starts pushing
// through); back on it -> cleared
void BusLine::holdReport(Bus& b, double now) {
  const bool off = b.lagS > 0.3 || b.shift > 0.01 || b.passing || b.ram;
  const int me = mp_.pid ? mp_.pid() : 0;
  if (!off) {
    if (b.own) {
      b.own = false; b.repAt = 0;
      auto it = holds_.find(b.id);
      if (it != holds_.end() && it->second.own == me) holds_.erase(it);
      Hold h; h.bus = b.id; h.clear = true;
      if (mp_.report) mp_.report(h);
    }
    return;
  }
  if (!b.own) { b.own = true; b.ownAt = now; }
  const double D = delayOf(b);
  const bool pass = b.passing, ram = b.ram;
  if (b.repAt > 0 && now - b.repAt < REPORT_MS && pass == b.repPass && ram == b.repRam) return;
  const double h = b.repAt > 0 ? (now - b.repAt) / 1000 : 0;
  b.repDD = h > 0.05 ? clamp((D - b.repD) / h, -4, 32) : b.v < 0.3 && b.mark < 0 ? 1 : 0;   // (standing: the timetable runs away at 1 s/s)
  b.repAt = now; b.repD = D; b.repPass = pass; b.repRam = ram;
  auto r3 = [](double x) { return std::round(x * 1000) / 1000; };
  Hold m;
  m.bus = b.id; m.d = r3(D); m.dd = r3(b.repDD); m.sh = r3(clamp(b.shift, 0, 1)); m.sv = r3(clamp(b.shiftV, -1, 1)); m.ram = ram; m.bt = r3(clamp(b.blockT, 0, 600));
  if (mp_.report) mp_.report(m);
}
// someone else's record for the bus you drive: theirs clearly further back, or about as far for 2.5 s
bool BusLine::yields(const Bus& b, const HoldAt& H, double now) const {
  const double D = delayOf(b);
  return H.d >= D + 0.25 || (H.d >= D - 0.25 && now - b.ownAt > 2500);
}
// bus b placed from its record H (TH: its timetable H.d s ago): eased onto it, straight there when far
void BusLine::followStep(Bus& b, const Target& TH, const HoldAt& H, double dt, double dist) {
  const double rate = mp_.rate ? mp_.rate(t_.fleet.buses[size_t(b.fi)].line) : 1;
  if (!b.st || b.dir != TH.dir || std::fabs(TH.s - b.s) > 40 || dist > FLEET_SIM) {
    fleetReset(b, TH); b.shift = H.sh;
  } else {
    const double prev = b.s, pred = b.s + TH.v * rate * dt;
    b.s = pred + (TH.s - pred) * (1 - std::exp(-dt * 3));
    if (TH.mark >= 0 && std::fabs(b.s - way(b, TH.dir).marks[size_t(TH.mark)].s) < 0.25) b.s = way(b, TH.dir).marks[size_t(TH.mark)].s;
    b.v += (clamp((b.s - prev) / std::max(1e-3, dt), 0, 40) - b.v) * std::min(1.0, dt * 8);
    const double sh0 = b.shift;
    b.shift = clamp(sh0 + (H.sh - sh0) * (1 - std::exp(-dt * 3)), 0, 1);
    b.shiftV = (b.shift - sh0) / std::max(1e-3, dt);
  }
  const Path& P = way(b, TH.dir);
  b.mark = TH.mark >= 0 && std::fabs(b.s - P.marks[size_t(TH.mark)].s) < 0.5 ? TH.mark : -1;
  if (b.mark >= 0) b.v = 0;
  b.dwell = 0; b.hold = b.mark >= 0 ? std::max(0.0, P.marks[size_t(b.mark)].t + P.marks[size_t(b.mark)].dwell - TH.tau) : 0;
  b.passing = H.sh >= 0.5; b.ram = H.ram; b.blockT = H.bt;
  b.heldT = 0; b.slowT = 0; b.horn = 0; b.passV = INF;
  b.lagS = 0; b.lag = H.d;
}
// a bus placed from someone else's record: would it run into something you see (clearAhead, probing only)?
bool BusLine::mustTake(Bus& b, double dt) {
  if (!b.st || b.mark >= 0 || b.v < 0.8) return false;
  Path& P = b.dir ? b.back : b.out;
  int next = int(P.marks.size()) - 1;
  for (size_t i = 0; i < P.marks.size(); i++) if (P.marks[i].s > b.s + 0.05) { next = int(i); break; }
  P.s1 = P.marks[size_t(next)].s;
  const double lim = clearAhead(P, b, dt, t_.bus.cruise, int(&b - fleet_.data()), true);
  return b.v > lim + 0.8;
}

// Per frame: the fleet on its rounds. p: where you are (the buses near you drive themselves)
void BusLine::updateFleet(double dt, const dvec3& p) {
  if (!(dt > 0) || !t_.fleet.ok) return;
  dt = std::min(dt, 0.1);
  fleetClock_ += dt;
  const double now = mpOn_ && mp_.now ? mp_.now() : 0;
  const int me = mpOn_ && mp_.pid ? mp_.pid() : 0;
  for (size_t k = 1; k < fleet_.size(); k++) {
    Bus& b = fleet_[k];
    if (b.fi < 0 || b.taken) continue;
    const Target T = fleetTarget(b);
    const double d = std::hypot(b.pose.pos.x - p.x, b.pose.pos.z - p.z);
    b.near = d < FLEET_SHOW;
    b.vPrev = b.st && b.mark < 0 ? b.v : 0;
    // online: the bus's shared hold-up record, if it has one
    HoldAt H;
    const bool hasH = mpOn_ && holdFor(b, now, H);
    // driving it yourself (held up near you, reported): until it is out of your range, or someone else (reporting
    // since you took it) holds it further back, or as far back for a while
    if (b.own && (!b.st || d > FLEET_SIM || (hasH && H.own != me && H.fresh && holds_[b.id].at > b.ownAt && yields(b, H, now)))) { b.own = false; b.gaveUp = now; }
    if (hasH && !b.own) {
      // placed from the record: where its timetable was H.d s ago, out in the other lane by H.sh
      followStep(b, fleetTarget(b, H.d), H, dt, d);
      // ...unless it would run into something you see there: then you drive it (and report it, with the longer delay)
      if (d < FLEET_SIM && !H.ram && now - b.gaveUp > 1000 && mustTake(b, dt)) {
        b.own = true; b.ownAt = now; b.repAt = 0;
        b.passing = H.sh >= 0.5; b.passV = b.passing ? PASS_V : INF; b.ram = false; b.blockT = H.bt; b.heldT = 0; b.slowT = 0; b.horn = 0;
        b.lagS = std::max(0.0, (T.dir == b.dir ? T.s : b.s) - b.s);
      }
    } else if (!b.st || d > FLEET_SIM || (b.lag > 180 && d > 600)) fleetReset(b, T);   // far from you (or new): exactly where the timetable has it
    else fleetDrive(b, T, dt);   // near you: the timetable plus its own delay
    if (mpOn_ && b.st && (b.own || (!hasH && d < FLEET_SIM))) holdReport(b, now);   // (held up near you -> reported; on time -> cleared)
    b.dist = d;
  }
  // two waiting at one stop queue one behind the other (by how far each stands short of the stop)
  std::map<std::pair<int, int>, std::vector<size_t>> Q;
  std::vector<double> shortBy(fleet_.size(), 0);
  for (size_t k = 1; k < fleet_.size(); k++) {
    Bus& b = fleet_[k];
    if (b.fi < 0 || b.taken || !b.st) continue;
    b.sq = b.s;
    if (b.mark < 0) continue;
    const auto& m = way(b, b.dir).marks[size_t(b.mark)];
    if (m.depot) continue;   // (in the depot each in its own bay)
    Q[{m.stop, b.dir}].push_back(k);
    shortBy[k] = m.s - b.s;
  }
  for (auto& [key, list] : Q) {
    if (list.size() < 2) continue;
    std::sort(list.begin(), list.end(), [&](size_t a, size_t c) { return shortBy[a] != shortBy[c] ? shortBy[a] < shortBy[c] : fleet_[a].id < fleet_[c].id; });
    double need = -INF;
    for (size_t k : list) { Bus& b = fleet_[k]; const double e = std::max(shortBy[k], need); b.sq = way(b, b.dir).marks[size_t(b.mark)].s - e; need = e + t_.bus.len + 3; }
  }
  // drawn near you only (cheap far away: just its timetable)
  for (size_t k = 1; k < fleet_.size(); k++) {
    Bus& b = fleet_[k];
    if (b.fi < 0 || b.taken || !b.st) continue;
    const Path& P = way(b, b.dir);
    const double sq = std::max(0.0, b.sq);
    if (b.mark >= 0) b.v = 0;
    b.at = b.mark >= 0 && !P.marks[size_t(b.mark)].depot ? P.marks[size_t(b.mark)].stop : -1;   // (in its bay at the depot: at no stop)
    if (b.dist < FLEET_SHOW) {
      b.pose = place(P, sq, b.shift, b.shiftV, b.v);
      b.visible = true;
      if (b.ram && b.mark < 0) ramContact(b, int(k), dt);   // (pushing through: bumped out of its way)
    } else {
      const double q = clamp(sq, 0, P.S.back());
      const int i = legIndex(P.S, q);
      const size_t j = std::min(P.S.size() - 1, size_t(i) + 1), a = i > 0 ? size_t(i) - 1 : 0, c = std::min(P.S.size() - 1, j + 1);
      const double f = clamp((q - P.S[size_t(i)]) / std::max(1e-6, P.S[j] - P.S[size_t(i)]), 0, 1);
      b.pose.pos = dvec3(P.X[size_t(i)] + (P.X[j] - P.X[size_t(i)]) * f, P.Y[size_t(i)] + (P.Y[j] - P.Y[size_t(i)]) * f, P.Z[size_t(i)] + (P.Z[j] - P.Z[size_t(i)]) * f);
      b.pose.yaw = std::atan2(P.X[c] - P.X[a], P.Z[c] - P.Z[a]); b.pose.pitch = 0;
      b.visible = false;
    }
  }
}

// ---------------------------------------------------------------- multiplayer (net/transit.js)
void BusLine::setMp(const Mp* hook) {
  const bool on = hook != nullptr;
  if (on == mpOn_) { if (on) mp_ = *hook; return; }
  if (ride_.on) abort();
  mpOn_ = on;
  mp_ = on ? *hook : Mp{};
  holds_.clear();
  for (Bus& b : fleet_) { b.st = false; b.own = false; b.repAt = 0; b.taken = false; }   // (re-placed from the timetable next frame)
  if (!fleet_.empty()) { if (on) { fleet_[0].visible = false; fleet_[0].at = -1; } else parkBus0(); }
}
void BusLine::setHold(const Hold& h) {
  if (h.bus.empty()) return;
  if (h.clear) { holds_.erase(h.bus); return; }
  if (!std::isfinite(h.d) || !std::isfinite(h.at)) return;
  holds_[h.bus] = h;
}
void BusLine::setHolds(const std::vector<Hold>& list) { holds_.clear(); for (const Hold& h : list) setHold(h); }
// the marks (stops) bus b's round reaches from mark i of way d on: the rest of that way, then the other way
bool BusLine::serves(const Bus& b, int d, int i, int to) const {
  const Path& A = way(b, d);
  const Path& B = way(b, 1 - d);
  for (size_t k = size_t(i) + 1; k < A.marks.size(); k++) if (!A.marks[k].depot && A.marks[k].stop == to) return true;
  for (const auto& m : B.marks) if (!m.depot && m.stop == to) return true;
  return false;
}
// bus b at mark i of way d, `into` s after its timetable got there: wait / left by the timetable, or by where the bus
// near you really is (held up on its way: not there yet; got there late: its short halt)
BusLine::Next BusLine::busAt(const Bus& b, int d, int i, double into, double c) const {
  const auto& m = way(b, d).marks[size_t(i)];
  const int id = int(&b - fleet_.data());
  Next n = into < m.dwell ? Next{id, 0, m.dwell - into} : Next{id, c - into, m.dwell};
  if (!b.st || !b.near || b.taken) return n;
  if (b.mark == i && b.dir == d) { if (n.wait > 0) n = Next{id, 0, std::max(0.0, b.hold - b.dwell)}; }
  else if (n.wait == 0 && (b.dir != d || b.s < m.s - 0.5)) n = Next{id, b.dir == d ? std::max(1.0, (m.s - b.s) / 7) : 20, n.left};
  return n;
}
std::vector<BusLine::Next> BusLine::mpBuses(int from, int to) const {
  std::vector<Next> out;
  if (!t_.fleet.ok) return out;
  for (size_t k = 1; k < fleet_.size(); k++) {
    const Bus& b = fleet_[k];
    if (b.fi < 0) continue;
    const double c = t_.fleet.buses[size_t(b.fi)].cycle, tau = pmod(roundTime(b) + t_.fleet.buses[size_t(b.fi)].phase, c);
    Next best;
    bool any = false;
    for (int d = 0; d < 2; d++) {
      const Path& P = way(b, d);
      for (size_t i = 0; i < P.marks.size(); i++) {
        const auto& m = P.marks[i];
        if (m.depot || m.stop != from || !serves(b, d, int(i), to)) continue;
        const double at = (d ? b.out.dur : 0) + m.t, into = pmod(tau - at, c);
        const Next n = busAt(b, d, int(i), into, c);
        if (!any || n.wait < best.wait) { best = n; any = true; }
      }
    }
    if (any) out.push_back(best);
  }
  std::sort(out.begin(), out.end(), [](const Next& x, const Next& y) { return x.wait != y.wait ? x.wait < y.wait : x.left > y.left; });
  return out;
}
bool BusLine::mpBoard(int bus, int from, int to) {
  if (bus <= 0 || size_t(bus) >= fleet_.size() || fleet_[size_t(bus)].fi < 0 || fleet_[size_t(bus)].taken) return false;
  ride_ = Ride{};
  ride_.on = true; ride_.mp = true; ride_.bus = bus; ride_.from = from; ride_.to = to;
  return true;
}
std::string BusLine::rideLine() const {
  if (!ride_.on || fleet_[size_t(ride_.bus)].fi < 0) return "";
  return t_.fleet.buses[size_t(fleet_[size_t(ride_.bus)].fi)].line;
}
void BusLine::setRideSeat(int n) { if (ride_.on) ride_.seat = n; }
std::string BusLine::debugFleet() const {
  std::string s;
  char buf[128];
  for (size_t k = 1; k < fleet_.size(); k++) {
    const Bus& b = fleet_[k];
    if (b.fi < 0) continue;
    std::snprintf(buf, sizeof buf, " %s %.2f %.2f %.2f %.3f %d %d", b.id.c_str(), b.pose.pos.x, b.pose.pos.z, b.st ? b.v * (mp_.rate ? mp_.rate(t_.fleet.buses[size_t(b.fi)].line) : 1) : 0.0, b.pose.yaw, b.at, int(b.visible));
    s += buf;
  }
  return s;
}

// (debug) bustest: you stand in the lane of a bus on its round; it stops short of you, sounds its horn, pulls out round
// you and back in
bool BusLine::debugStand(dvec3& p, double& heading) {
  if (dbg_.done) return false;
  if (dbg_.bus < 0) {
    for (size_t k = 1; k < fleet_.size(); k++) {
      const Bus& b = fleet_[k];
      if (b.fi < 0 || !b.st || b.taken || b.mark >= 0 || !b.visible) continue;
      const Path& t = way(b, b.dir);
      double ns = t.sB;
      for (const auto& m : t.marks) if (m.s > b.s + 0.05) { ns = m.s; break; }
      if (b.s < t.sA + 25 || ns - b.s < 200 || b.v < 4) continue;
      dbg_.bus = int(k); dbg_.s = b.s + 60;
      Pose q = place(t, dbg_.s), c = place(t, dbg_.s + 26);
      dbg_.p = q.pos; dbg_.h = q.yaw + PI;
      dbg_.cam = c.pos + dvec3(std::cos(c.yaw) * 7.5, 5.5, -std::sin(c.yaw) * 7.5);
      SL_INFO("[bustest] standing in the lane of bus %zu, 60 m ahead of it (%.0f, %.0f)", k, q.pos.x, q.pos.z);
      break;
    }
    if (dbg_.bus < 0) return false;
  }
  const Bus& b = fleet_[size_t(dbg_.bus)];
  if (clock_ - dbg_.logT > 0.5) {
    dbg_.logT = clock_;
    SL_INFO("[bustest] t=%6.1f  gap %6.1f m  v %5.2f m/s  shift %.3f (rate %+.3f)  passing %d  held %.1f s  blocked %.1f s  ram %d  horn %d  yaw %.3f",
            clock_, dbg_.s - b.s - t_.bus.len / 2, b.v, b.shift, b.shiftV, int(b.passing), b.heldT, b.blockT, int(b.ram), b.horn, b.pose.yaw);
    if (b.heldT > 0.2) SL_INFO("[bustest]   pull out? in its lane %d (moving %.2f m/s), slowed for %.1f s, the other lane: something beside %d, clear %.0f m ahead (needs %.0f), road left %.0f m",
                               int(b.dOwn), b.dOwnV, b.slowT, int(b.dOtherNear), std::min(b.dOtherAhead, 9999.0), b.dNeed, b.dLeft);
  }
  if (b.s > dbg_.s + 45 || b.mark >= 0) { dbg_.done = true; SL_INFO("[bustest] the bus is past (overtakes %d, pushed through %d, shift now %.3f)", overtakes, rams, b.shift); return false; }
  p = dbg_.p; heading = dbg_.h;
  return true;
}
bool BusLine::debugCam(dvec3& pos, dvec3& look) const {
  if (dbg_.bus < 0) return false;
  pos = dbg_.cam; look = dbg_.p + dvec3(0, 1.2, 0);
  return true;
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
  if (fleet_.empty() || mpOn_ || !legs(from, to, L)) return false;
  // (single player) a bus of the fleet waiting at that stop: you get on that one, it leaves its round while you ride
  // it (bus.js board); else bus 0 comes to you
  int bi = 0;
  if (!(fleet_[0].at == from && fleet_[0].visible))
    for (size_t k = 1; k < fleet_.size(); k++) if (fleet_[k].fi >= 0 && !fleet_[k].taken && fleet_[k].at == from && fleet_[k].visible) { bi = int(k); break; }
  Bus& b = fleet_[size_t(bi)];
  if (bi > 0) { b.taken = true; b.st = false; b.mark = -1; }
  resetPass(b);
  b.legs = std::move(L); b.li = 0; b.s = b.legs[0].s0; b.v = 0; b.at = from; b.visible = true;
  b.pose = place(b.legs[0], b.s);
  ride_ = Ride{};
  ride_.on = true; ride_.bus = bi; ride_.from = from; ride_.to = to; ride_.wait = 2.2;
  return true;
}
void BusLine::abort() {
  if (!ride_.on) return;
  Bus& b = fleet_[size_t(ride_.bus)];
  if (!ride_.mp && ride_.bus > 0) { b.taken = false; b.st = false; b.legs.clear(); }   // (back on its round, where its timetable has it)
  ride_ = Ride{};
}

BusLine::RideState BusLine::rideState() const {
  RideState rs;
  if (!ride_.on) return rs;
  const Bus& b = fleet_[size_t(ride_.bus)];
  glm::dmat4 M = glm::translate(glm::dmat4(1), b.pose.pos) * glm::rotate(glm::dmat4(1), b.pose.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), b.pose.pitch, dvec3(1, 0, 0));
  const vec3 sl = ride_.seat >= 0 && size_t(ride_.seat) < t_.bus.seats.size() ? t_.bus.seats[size_t(ride_.seat)].p : seatLocal_;   // (online: the seat the server gave you)
  rs.seat = dvec3(M * glm::dvec4(dvec3(sl), 1));
  rs.fwd = dvec3(std::sin(b.pose.yaw), 0, std::cos(b.pose.yaw));
  std::string to = stopName(ride_.to);
  if (ride_.mp) {
    // (bus.js updateMpRide) the shared bus: off at your stop once it stands there (after it left the one you got on at)
    const char* DOT = " \xC2\xB7 ";
    if (ride_.departed && b.at == ride_.to) {
      rs.hint = to + DOT + "arrived";
      dvec3 door = dvec3(M * glm::dvec4(-(t_.bus.width / 2 + 1.8), 0, t_.bus.len / 2 - 2.0, 1));
      rs.arrived = true; rs.exit = dvec3(door.x, door.z, b.pose.yaw);
      return rs;
    }
    rs.hint = "Ski bus to " + to + DOT + "waiting at " + stopName(ride_.from);
    if (ride_.departed && b.st) {
      const Path& P = way(b, b.dir);
      if (b.mark >= 0) rs.hint = "Ski bus to " + to + DOT + "stopped at " + (P.marks[size_t(b.mark)].depot ? std::string("the depot") : stopName(P.marks[size_t(b.mark)].stop));
      else {
        int next = int(P.marks.size()) - 1;
        for (size_t i = 0; i < P.marks.size(); i++) if (P.marks[i].s > b.s + 0.05) { next = int(i); break; }
        char buf[64];
        std::snprintf(buf, sizeof buf, "%.0f km/h", b.v * 3.6 * (mp_.rate ? mp_.rate(rideLine()) : 1));
        rs.hint = "Ski bus to " + to + DOT + "next stop " + stopName(P.marks[size_t(next)].stop) + DOT + buf;
      }
    }
    return rs;
  }
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
bool BusLine::seatWorld(int bus, int n, dvec3& pos, double& yaw) const {
  if (bus < 0 || bus >= int(fleet_.size()) || n < 0) return false;
  const Bus& b = fleet_[size_t(bus)];
  if (!b.visible) return false;
  const vec3 sl = size_t(n) < t_.bus.seats.size() ? t_.bus.seats[size_t(n)].p : seatLocal_;
  glm::dmat4 M = glm::translate(glm::dmat4(1), b.pose.pos) * glm::rotate(glm::dmat4(1), b.pose.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), b.pose.pitch, dvec3(1, 0, 0));
  pos = dvec3(M * glm::dvec4(dvec3(sl), 1));
  yaw = b.pose.yaw;
  return true;
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
