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
// bus.js: braking for something in the lane (m/s^2), the gap it stops at behind something moving / standing (m), how
// long it waits behind something standing before it pulls out (s), its speed round it (m/s), the horn (s), held up
// this long in all it drives on through (s) at RAM_V (m/s); roads.js ROAD_HALF: half the plowed width
constexpr double CLEAR_DEC = 1.8, CLEAR_GAP = 4, STOP_GAP = 6, PASS_WAIT = 3, PASS_V = 5, HORN_T = 2, RAM_T = 20, RAM_V = 4.2;
constexpr double ROAD_HALF = 3.4, INF = 1e18;
inline double sq(double v) { return v * v; }
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
}

// clearAhead: the speed (m/s) the bus may drive at so it stops short of whatever stands in its lane ahead, along the
// road it drives (round the bends too). Anything on the road in the lane it is in or moving to counts. Held up behind
// something standing (PASS_WAIT) or crawling (1.5 s) in its lane, with the other lane clear far enough ahead (oncoming
// traffic's approach included) and the road going on long enough, it pulls out (slowly round something standing:
// PASS_V), passes with room to spare and pulls back in once its lane is clear beside and behind it. Held up RAM_T in
// all it drives on through at RAM_V (ramContact shoves what its front runs into aside).
double BusLine::clearAhead(const Leg& t, Bus& r, double dt, double want, int self) {
  const auto& B = t_.bus;
  const dvec3 g = r.pose.pos;
  const double sh = r.shift;
  const double look = 30 + (r.v * r.v) / (2 * CLEAR_DEC), far = std::max(look, 150.0);
  // anything near at all? (most of the time nothing is: cheap)
  bool any = false;
  for (const Ob& o : obs_) if (o.fleet != self && std::fabs(o.x - g.x) < far + 12 && std::fabs(o.z - g.z) < far + 12) { any = true; break; }
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
  // overtaking: held up behind something in its own lane, standing (PASS_WAIT) or going clearly slower than the bus
  // wants to (1.5 s). The road it needs: the bus closes the gap, its own length, the other's and a margin at the speed
  // difference, at its own speed; the other lane must be clear that far (at least 60 m: oncoming traffic's approach
  // included) and the road must go on far enough (not into its stop)
  const double vWant = std::max(8.0, std::min(want, B.cruise));
  const bool standing = own.on && own.vo < 0.6;
  const bool slowed = own.on && own.gap < 45 && (standing ? r.v < 0.8 : own.vo < vWant * 0.8 && r.v < vWant * 0.85);
  r.slowT = slowed ? r.slowT + dt : 0;
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
        resetPass(b);
        departures.push_back(b.pose.pos);   // (Phase 7: the horn as it pulls out)
      }
    }
    if (b.legs.empty()) continue;
    Leg& t = b.legs[size_t(b.li)];
    if (b.s >= t.s1 - 0.05) {
      // at the end of a leg: on to the next (it turns at the stop), or arrived
      if (b.li + 1 < int(b.legs.size())) {
        if (mine) { ride_.arrive -= dt; if (ride_.arrive > 0) continue; }
        b.li++; b.s = b.legs[size_t(b.li)].s0; b.v = 0;
        resetPass(b);
        if (mine) ride_.arrive = 1.2;
        b.pose = place(b.legs[size_t(b.li)], b.s);
        continue;
      }
      b.at = t.to; b.dwell = DWELL; b.v = 0;
      resetPass(b);
      b.pose = place(t, b.s);
      if (mine && !ride_.done) { ride_.done = true; ride_.arrive = 1.2; }
      continue;
    }
    int i = 0;
    { size_t lo = 0, hi = t.S.size() - 1; while (hi - lo > 1) { size_t m = (lo + hi) / 2; if (t.S[m] <= b.s) lo = m; else hi = m; } i = int(lo); }
    double f = clamp((b.s - t.S[size_t(i)]) / std::max(1e-3, t.S[size_t(std::min<size_t>(t.S.size() - 1, size_t(i + 1)))] - t.S[size_t(i)]), 0, 1);
    double vt = std::max(b.s < t.s1 - 0.5 ? 1.2 : 0.0, t.V[size_t(i)] + (t.V[size_t(std::min<size_t>(t.V.size() - 1, size_t(i + 1)))] - t.V[size_t(i)]) * f);
    double dist = glm::length(b.pose.pos - player);
    // anything in its lane ahead, along the road it drives: it never drives through it, it brakes in time and waits,
    // pulls round it, or after RAM_T pushes through (bus.js FLEET_SIM: a bus far from you is on its timetable alone)
    if (dist < 1300) vt = std::min(vt, clearAhead(t, b, dt, vt, int(k)));
    else b.passing = false;
    // the lane change: a critically damped spring (eases out and in, ~3 s across); place() turns the bus along the
    // path it traces
    steerShift(b, h, b.v, t_.bus.lane);
    b.v += clamp(vt - b.v, -t_.bus.brake * 2 * h, t_.bus.acc * 1.5 * h);
    b.s = std::min(t.s1, b.s + b.v * h);
    b.pose = place(t, b.s, b.shift, b.shiftV, b.v);
    b.visible = true;
    if (b.ram) ramContact(b, int(k), h);
  }
}

// (debug) bustest: you stand in the lane of a bus on its round; it stops short of you, sounds its horn, pulls out round
// you and back in
bool BusLine::debugStand(dvec3& p, double& heading) {
  if (dbg_.done) return false;
  if (dbg_.bus < 0) {
    for (size_t k = 1; k < fleet_.size(); k++) {
      const Bus& b = fleet_[k];
      if (b.at >= 0 || b.legs.empty()) continue;
      const Leg& t = b.legs[size_t(b.li)];
      if (b.s < t.s0 + 40 || t.s1 - b.s < 260 || b.v < 6) continue;
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
  }
  if (b.s > dbg_.s + 45 || b.at >= 0) { dbg_.done = true; SL_INFO("[bustest] the bus is past (overtakes %d, pushed through %d, shift now %.3f)", overtakes, rams, b.shift); return false; }
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
