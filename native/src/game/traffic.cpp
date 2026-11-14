#include "game/traffic.h"
#include "game/scenefx.h"
#include "core/log.h"
#include "game/drive.h"
#include "game/people.h"
#include "world/scenery.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr int N_CARS = 12, N_SCENIC = 6;
constexpr double SIM_R = 600, SHOW_R = 300, LOD_R = 70, LANE = 1.6, END_KEEP = 95, TURN_LEAD = 7, OFF_TURN = 0.12, NEAR_WANT = 6, STUCK_T = 300;
constexpr double PEOPLE_R = 70;   // (traffic.js: the people go with the detailed model)
constexpr double HEAD = 1.7, BRK = 3.0, V_MAX = 150 / 3.6;
double lookFor(double v) { return 30 + v * HEAD + (v * v) / (2 * BRK); }
double followV(double room, double vl = 0) {
  if (room <= 0) return 0;
  double q = vl * vl + 2 * BRK * (room - HEAD * vl);
  return std::min(vl + room * 0.7, q > 0 ? std::sqrt(q) : 0.0);
}
// cars.js CAR_WEIGHT (the user's spawn rates)
double weightOf(const std::string& n) {
  if (n == "car_lamborghini_huracan") return 1.0 / 240;
  if (n == "car_mercedes_sls") return 1.0 / 225;
  if (n == "car_toyota_gr_yaris") return 1.0 / 80;
  if (n == "car_mercedes_gls") return 1.0 / 50;
  if (n == "car_porsche_taycan") return 1.0 / 40;
  if (n == "car_audi_rs6" || n == "car_audi_etron_gt") return 1.0 / 25;
  if (n == "car_bmw_x3") return 0.15;
  return (1 - (1.0 / 240 + 1.0 / 225 + 1.0 / 80 + 1.0 / 50 + 1.0 / 40 + 2.0 / 25 + 0.15)) / 2;
}
// mulberry32 (noise.js): seeded draws, the same cars every session
double mulberry(uint32_t a) {
  a += 0x6D2B79F5u;
  uint32_t t = a;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return double((t ^ (t >> 14)) & 0xffffffffu) / 4294967296.0;
}
// the speed a driver wants (speedlimits.js roadTarget)
double roadTarget(const Road& r, double s, int dir, double f) {
  if (r.limF.empty()) return 13.9 * f;
  int i = r.indexAt(s), j = dir > 0 ? i : std::min(r.n - 1, i + 1);
  return std::min({V_MAX, double(dir > 0 ? r.limF[size_t(j)] : r.limB[size_t(j)]) * f, double(dir > 0 ? r.vcF[size_t(j)] : r.vcB[size_t(j)])});
}
} // namespace

void Traffic::init() {
  for (size_t i = 0; i < t_.roads.size(); i++) {
    const Road& r = t_.roads[i];
    if (r.n < 4 || r.depot) continue;
    if (r.scenic) { if (!r.ring && r.length > 300) scenic_.push_back(int(i)); continue; }   // (the scenic network: its own cars)
    (r.access ? access_ : main_).push_back(int(i));
  }
  for (size_t i = 0; i < t_.lots.size(); i++) { const Lot& L = t_.lots[i]; if (!L.building && !L.scenic && !L.impound && !L.bays.empty()) lots_.push_back(int(i)); }
  // junctions: where each access road meets a bus road (traffic.js constructor)
  for (int ai : access_) {
    const Road& r = t_.roads[size_t(ai)];
    if (r.heli) continue;
    double jx = r.X[size_t(r.n - 1)], jz = r.Z[size_t(r.n - 1)], bd = 1e18, bs = 0;
    int bm = -1;
    for (int mi : main_) { const Road& m = t_.roads[size_t(mi)]; for (int i = 0; i < m.n; i++) { double d = std::hypot(m.X[size_t(i)] - jx, m.Z[size_t(i)] - jz); if (d < bd) { bd = d; bm = mi; bs = m.S[size_t(i)]; } } }
    int lot = -1;
    for (int li : lots_) if (std::hypot(t_.lots[size_t(li)].ex - r.X[0], t_.lots[size_t(li)].ez - r.Z[0]) < 12) lot = li;
    if (bm >= 0 && bd < 8) junctions_.push_back({ai, bm, bs, lot});
  }
  std::vector<std::string> names;
  for (const CarSpec& c : t_.cars) if (models_.car(c.name)) names.push_back(c.name);
  if (names.empty() || main_.empty()) { SL_WARN("traffic: no roads / car models"); return; }
  auto draw = [&](uint32_t k) {
    double sum = 0;
    for (auto& n : names) sum += weightOf(n);
    double a = mulberry(k * 7919 + 17) * sum;
    for (auto& n : names) { a -= weightOf(n); if (a < 0) return n; }
    return names.back();
  };
  int nCars = N_CARS + (scenic_.empty() ? 0 : N_SCENIC);   // (traffic.js: every car; the preset's share is how many stay round you)
  for (int k = 0; k < nCars; k++) {
    Car c;
    c.name = draw(uint32_t(k < N_CARS ? k : 1000 + k - N_CARS));
    c.vm = models_.car(c.name);
    const CarSpec* sp = t_.car(c.name);
    c.l = sp ? sp->length : 4.7; c.w = sp ? sp->size.x : 1.9;
    c.drv = 0.92 + mulberry(uint32_t(k * 131 + 7)) * 0.34;   // traffic.js DRV: this driver's own pace
    c.vmax = 30;
    c.scenic = k >= N_CARS;
    c.crew = uint32_t(k) * 2654435761u + 99u;
    list.push_back(c);
  }
  for (size_t k = 0; k < list.size(); k++) spawn(list[k], dvec3(1e9), true);
  SL_INFO("traffic: %zu cars on %zu roads (%zu access roads, %zu junctions, %zu scenic roads)", list.size(), main_.size(), access_.size(), junctions_.size(), scenic_.size());
}

// seen from the camera? (traffic.js inSight: within d m and not behind it; the camera's own facing)
bool Traffic::inSight(double x, double z, double d) const {
  double dx = x - cam_.x, dz = z - cam_.z, dist = std::hypot(dx, dz);
  if (dist > d) return false;
  return dist < 40 || (dx * camFwd_.x + dz * camFwd_.z) / dist > -0.15;
}

// on a bus road somewhere around you (150-420 m away), out of sight, clear of the other cars (traffic.js recycle)
bool Traffic::recycle(Car& c, const dvec3& player) {
  if (main_.empty()) return false;
  for (int tries = 0; tries < 30; tries++) {
    int ri = main_[size_t(rnd() * main_.size()) % main_.size()];
    const Road& r = t_.roads[size_t(ri)];
    if (r.length < 2 * END_KEEP + 30) continue;
    double s = END_KEEP + 10 + rnd() * std::max(1.0, r.length - 2 * END_KEEP - 20);
    RoadPoint p = roadAt(r, s);
    double d = std::hypot(p.x - player.x, p.z - player.z);
    if (d < 150 || d > 420 || inSight(p.x, p.z)) continue;
    bool crowded = false;
    for (const Car& o : list) crowded = crowded || (&o != &c && o.mode != Car::Mode::Gone && std::hypot(o.x - p.x, o.z - p.z) < 45);
    if (crowded) continue;
    putOnRoad(c, ri, s, rnd() < 0.5 ? 1 : -1, c.vmax * 0.8);
    return true;
  }
  return false;
}
void Traffic::putOnRoad(Car& c, int ri, double s, int dir, double v) {
  const Road& r = t_.roads[size_t(ri)];
  c.mode = Car::Mode::Road; c.road = ri; c.s = clamp(s, 2, r.length - 2); c.dir = dir; c.v = v; c.nextJ = -2; c.lot = c.bay = -1;
  c.off = c.offT = c.offQ = 0; c.trip = 120 + rnd() * 180; c.wdT = 0; c.wdX = c.wdZ = 1e18; c.crew = c.crew * 1664525u + 1013904223u;
  placeOnRoad(c);
}
// off the map for a moment (it comes back elsewhere, out of sight)
void Traffic::despawn(Car& c, double wait) {
  c.mode = Car::Mode::Gone; c.wait = wait; c.lot = c.bay = -1; c.v = 0; c.kvx = c.kvz = c.kw = 0; c.wdT = 0; c.wdX = c.wdZ = 1e18;
}
// stuck: taken off and parked in a free bay of a car park out of your sight (it drives off from there later)
bool Traffic::toLot(Car& c) {
  despawn(c, 1 + rnd() * 4);
  std::vector<int> free;
  for (int li : lots_) {
    const Lot& L = t_.lots[size_t(li)];
    if (inSight(L.x, L.z)) continue;
    for (size_t b = 0; b < L.bays.size(); b++) {
      if (L.bays[b].taken) continue;
      bool busy = false;
      for (const Car& o : list) busy = busy || (&o != &c && o.lot == li && o.bay == int(b));
      if (!busy) { free.push_back(li); break; }
    }
  }
  if (free.empty()) return false;
  int li = free[size_t(rnd() * free.size()) % free.size()];
  const Lot& L = t_.lots[size_t(li)];
  for (size_t b = 0; b < L.bays.size(); b++) {
    if (L.bays[b].taken) continue;
    bool busy = false;
    for (const Car& o : list) busy = busy || (&o != &c && o.lot == li && o.bay == int(b));
    if (busy) continue;
    const Bay& bay = L.bays[b];
    c.mode = Car::Mode::Parked; c.lot = li; c.bay = int(b);
    c.x = bay.x; c.z = bay.z; c.yaw = std::atan2(bay.hx, bay.hz); c.y = world_.height(c.x, c.z) + 0.03;
    c.wait = 20 + rnd() * 40; c.v = 0;
    return true;
  }
  return false;
}

void Traffic::spawn(Car& c, const dvec3& player, bool first) {
  // a car park now and then (parked a while, then it drives out), else on a road away from you (never popping up)
  // (traffic.js spawn: at the start every other car parked, later 6 in 10; the scenic network's cars on their roads)
  if (!c.scenic && !lots_.empty() && (first ? ((&c - list.data()) % 2 == 1) : rnd() < 0.6)) {
    int li = lots_[size_t(rnd() * lots_.size()) % lots_.size()];
    Lot& L = t_.lots[size_t(li)];
    for (size_t b = 0; b < L.bays.size(); b++) {
      Bay& bay = L.bays[b];
      if (bay.taken) continue;
      bool busy = false;
      for (auto& o : list) if (&o != &c && o.lot == li && o.bay == int(b)) busy = true;
      if (busy) continue;
      c.mode = Car::Mode::Parked; c.lot = li; c.bay = int(b);
      c.x = bay.x; c.z = bay.z; c.yaw = std::atan2(bay.hx, bay.hz); c.y = world_.height(c.x, c.z) + 0.03;
      c.wait = first ? 8 + rnd() * 40 : 4 + rnd() * 10; c.v = 0;
      return;
    }
  }
  const std::vector<int>& pool = c.scenic && !scenic_.empty() ? scenic_ : main_;
  for (int tries = 0; tries < 30; tries++) {
    int ri = pool[size_t(rnd() * pool.size()) % pool.size()];
    const Road& r = t_.roads[size_t(ri)];
    if (r.length < 2 * END_KEEP + 30) continue;
    double s = END_KEEP + 10 + rnd() * std::max(1.0, r.length - 2 * END_KEEP - 20);
    RoadPoint p = roadAt(r, s);
    double dp = std::hypot(p.x - player.x, p.z - player.z);
    if (!first && (dp < (c.scenic ? 150 : 220) || (c.scenic && (dp > 700 || inSight(p.x, p.z))))) continue;
    putOnRoad(c, ri, s, rnd() < 0.5 ? 1 : -1, c.vmax * 0.5);
    return;
  }
  c.mode = Car::Mode::Gone; c.wait = 5;
}

int Traffic::movingCount() const { int n = 0; for (auto& c : list) if (c.mode == Car::Mode::Road && c.v > 1) n++; return n; }

void Traffic::update(double dt, const dvec3& player, const Drive* you, const std::vector<Obb>& buses, const Camera& cam) {
  if (list.empty() || dt <= 0) return;
  cam_ = cam.pos;
  camFwd_ = dvec3(cam.forward());   // (the way the camera looks: what you see is never popped in or out)
  dvec3 me = you && you->active() ? you->pos() : player;
  // traffic.js update, every 2 s: trips end out of sight, the watchdog, about six cars on the roads round you (the rest
  // spread over the network); the scenic network's cars come back on it near you when they are far out of sight
  recycleT_ -= dt;
  if (recycleT_ <= 0) {
    recycleT_ = 2;
    for (auto& c : list) {
      double dP = std::hypot(c.x - me.x, c.z - me.z);
      if (c.scenic) {
        if ((c.mode == Car::Mode::Knocked || (dP > 900 && c.mode == Car::Mode::Road)) && !inSight(c.x, c.z)) spawn(c, me, false);
        continue;
      }
      if (c.mode == Car::Mode::Gone) continue;
      c.trip -= 2;
      // no headway (3 m) for 5 minutes (boxed in, blocked; not a parked car): taken off, parked in a car park
      if (c.mode == Car::Mode::Parked || std::hypot(c.x - c.wdX, c.z - c.wdZ) > 3) { c.wdX = c.x; c.wdZ = c.z; c.wdT = 0; }
      else c.wdT += 2;
      if (c.wdT >= STUCK_T && !inSight(c.x, c.z)) { if (!toLot(c)) despawn(c, 5); continue; }
      bool away = !inSight(c.x, c.z) || dP > 80;
      if (away && c.trip <= 0 && c.mode == Car::Mode::Road) despawn(c, 1 + rnd() * 4);
    }
    int near = 0;
    for (auto& c : list) if (!c.scenic && c.mode != Car::Mode::Gone && std::hypot(c.x - me.x, c.z - me.z) < 420) near++;
    int nearWant = std::max(2, int(std::lround(NEAR_WANT * density)));
    for (auto& c : list) {
      if (c.scenic) continue;
      if (near >= nearWant) break;
      double d = std::hypot(c.x - me.x, c.z - me.z);
      if ((c.mode == Car::Mode::Gone || d > 520) && !inSight(c.x, c.z) && recycle(c, me)) near++;
    }
  }
  for (auto& c : list) {
    double d = std::hypot(c.x - me.x, c.z - me.z);
    if (d > SIM_R && c.mode != Car::Mode::Gone) continue;   // (not simulated far away)
    // distance-based update rate: past 300 m a quarter of the rate
    c.simAcc += dt;
    double every = d > 300 ? 0.1 : 0;
    if (c.simAcc < every) continue;
    double h = std::min(c.simAcc, 0.1);
    c.simAcc = 0;
    switch (c.mode) {
      case Car::Mode::Gone: c.wait -= h; if (c.wait <= 0) spawn(c, me, false); break;
      case Car::Mode::Parked:
        c.wait -= h;
        if (c.wait <= 0 && d > c.l + 2) {
          // out of the bay onto the access road's car park end, toward the junction (traffic.js leaveBay)
          int ai = -1;
          for (auto& j : junctions_) if (j.lot == c.lot) ai = j.access;
          if (ai >= 0 && (!inSight(c.x, c.z) || d > 80)) { toRoad(c, ai, 6, 1, 0); c.lot = c.bay = -1; c.trip = 120 + rnd() * 180; c.crew = c.crew * 1664525u + 1013904223u; }
          else c.wait = 5;
        }
        break;
      case Car::Mode::Knocked: {
        double sp = std::hypot(c.kvx, c.kvz), dec = 0.6 * 9.81 * h;
        if (sp > dec) { c.kvx -= c.kvx / sp * dec; c.kvz -= c.kvz / sp * dec; } else { c.kvx = c.kvz = 0; }
        c.kw *= std::exp(-h * 2.6);
        c.x += c.kvx * h; c.z += c.kvz * h; c.yaw = wrapPi(c.yaw + c.kw * h);
        c.y = world_.groundHeight(c.x, c.z, c.y + 1) + 0.02;
        c.kt += h;
        if (c.kt > 3 && sp < 0.1) {   // back onto its road, steering out what is left over
          Transport::RoadHit rh = t_.nearestRoad(c.x, c.z, 14);
          if (rh.road >= 0) toRoad(c, rh.road, rh.s, std::cos(wrapPi(c.yaw - std::atan2(roadAt(t_.roads[size_t(rh.road)], rh.s).dx, roadAt(t_.roads[size_t(rh.road)], rh.s).dz))) >= 0 ? 1 : -1, 0);
          else if (!inSight(c.x, c.z)) despawn(c, 5);
        }
        break;
      }
      case Car::Mode::Road: drive(c, h, player, you, buses); break;
    }
  }
}

// traffic.js drive(): the road's target, junctions, dead ends, lane offsets steered, the clearance ahead
void Traffic::drive(Car& c, double dt, const dvec3& player, const Drive* you, const std::vector<Obb>& buses) {
  const Road& r = t_.roads[size_t(c.road)];
  double end = c.dir > 0 ? r.length : 0;
  double vt = roadTarget(r, c.s, c.dir, c.drv);
  double toEnd = std::fabs(end - c.s);
  const bool acc = r.access && !r.scenic;   // (the scenic roads are planned as access roads: driven as roads here)
  if (c.nextJ == -2) {
    c.nextJ = -1;
    if (!acc && rnd() <= 0.45) {
      double best = 1e18;
      for (size_t k = 0; k < junctions_.size(); k++) {
        const Junction& j = junctions_[k];
        if (j.road != c.road || j.lot < 0) continue;
        double ahead = (j.s - c.s) * c.dir;
        if (ahead > TURN_LEAD + 2 && ahead < best) { best = ahead; c.nextJ = int(k); }
      }
    }
  }
  const Junction* J = c.nextJ >= 0 ? &junctions_[size_t(c.nextJ)] : nullptr;
  double toJ = J ? (J->s - c.s) * c.dir : 1e18;
  if (J) vt = std::min(vt, std::sqrt(2.6 * 2.6 + 2 * 2.4 * std::max(0.0, toJ - TURN_LEAD)));
  if (J && toJ < 30) vt = std::min(vt, 2.6 + std::max(0.0, toJ - TURN_LEAD) * 0.3);
  bool keepOut = !acc && !(J && toJ <= toEnd + 0.5);
  if (keepOut) vt = std::min(vt, std::sqrt(1.5 * 1.5 + 2 * 2.4 * std::max(0.0, toEnd - END_KEEP)));
  if (keepOut && toEnd < END_KEEP + 45) vt = std::min(vt, 1.5 + std::max(0.0, toEnd - END_KEEP) * 0.3);
  if (keepOut && toEnd <= END_KEEP + 1) { deadEnd(c, player); return; }
  if (acc && c.dir < 0) vt = std::min(vt, 3.5 + toEnd * 0.15);
  if (acc && c.dir > 0) vt = std::min(vt, 2.6 + std::max(0.0, toEnd - TURN_LEAD) * 0.3);
  // a lane change / swerve is steered: the body angled off the lane line, turning only as it drives
  double err = c.offT - c.off, q = c.offQ, k = std::min(OFF_TURN, 1.8 / std::max(1.0, c.v * c.v));
  double turnBy = k * c.v * dt, qMax = std::min(0.28, std::sqrt(2 * k * std::fabs(err)));
  double qT = std::fabs(err) < 0.02 ? 0 : clamp(err * 0.5, -qMax, qMax);
  c.offQ = q + clamp(qT - q, -turnBy, turnBy);
  vt = std::min(vt, clearance(c, player, you, buses));
  double dv = vt - c.v;
  c.brake = dv < -0.5 ? clamp(-dv / 4, 0, 1) : 0;
  c.v = std::min(V_MAX, std::max(0.0, c.v + clamp(dv, -6 * dt, (c.v < 20 ? 2.4 : 1.6) * dt)));
  c.s = clamp(c.s + c.dir * c.v * dt, 0, r.length);
  c.odo += c.v * dt;
  c.off += c.offQ * c.v * dt;
  // the turn into a car park's access road (its bay booked), round onto its lane
  if (J && (J->s - c.s) * c.dir <= TURN_LEAD) {
    c.nextJ = -2;
    const Road& a = t_.roads[size_t(J->access)];
    toRoad(c, J->access, a.length - 9, -1, std::min(c.v, 4.0));
    return;
  }
  // up the access road to the junction: round onto the bus road, either way
  if (acc && c.dir > 0 && c.s >= r.length - TURN_LEAD) {
    for (auto& j : junctions_) if (j.access == c.road) {
      int d = rnd() < 0.5 ? 1 : -1;
      toRoad(c, j.road, clamp(j.s + d * 9, 2, t_.roads[size_t(j.road)].length - 2), d, std::min(c.v, 4.0));
      return;
    }
  }
  // down the access road into the car park: into a free bay for a while (traffic.js enterLot / manoeuvre)
  if (acc && c.dir < 0 && c.s <= 7.5) {
    for (auto& j : junctions_) if (j.access == c.road && j.lot >= 0) {
      Lot& L = t_.lots[size_t(j.lot)];
      for (size_t b = 0; b < L.bays.size(); b++) {
        if (L.bays[b].taken) continue;
        bool busy = false;
        for (auto& o : list) if (&o != &c && o.lot == j.lot && o.bay == int(b)) busy = true;
        if (busy) continue;
        c.mode = Car::Mode::Parked; c.lot = j.lot; c.bay = int(b);
        c.x = L.bays[b].x; c.z = L.bays[b].z; c.yaw = std::atan2(L.bays[b].hx, L.bays[b].hz) + PI; c.y = world_.height(c.x, c.z) + 0.03;
        c.wait = 20 + rnd() * 40; c.v = 0;
        return;
      }
    }
    deadEnd(c, player);
    return;
  }
  if (c.dir > 0 ? c.s >= r.length - 0.5 : c.s <= 0.5) { deadEnd(c, player); return; }
  placeOnRoad(c);
}

// turning round before a dead end (a bus stop): out of sight it leaves; in sight it turns across the road, the lane
// offset carrying it over to the other lane (no jump)
void Traffic::deadEnd(Car& c, const dvec3& player) {
  if (!inSight(c.x, c.z) || std::hypot(c.x - player.x, c.z - player.z) > 80) { despawn(c, 1 + rnd() * 4); return; }
  c.dir = -c.dir;
  c.off = -2 * LANE - c.off; c.offT = 0; c.offQ = 0;
  c.v = 0; c.nextJ = -2;
}

// onto road ri from wherever it is: what is left over (beside the lane line, another heading) becomes a lane offset
// and an angle it steers out (traffic.js toRoad)
void Traffic::toRoad(Car& c, int ri, double s, int dir, double v) {
  const Road& r = t_.roads[size_t(ri)];
  c.mode = Car::Mode::Road; c.road = ri; c.dir = dir; c.v = v; c.nextJ = -2; c.offT = 0;
  RoadPoint p = roadAt(r, clamp(s, 1, r.length - 1));
  double tx = p.dx * dir, tz = p.dz * dir, dx = c.x - p.x, dz = c.z - p.z;
  if (c.x != 0 || c.z != 0) {
    c.s = clamp(s + (dx * tx + dz * tz) * dir, 1, r.length - 1);
    c.off = clamp(dx * -tz + dz * tx - LANE, -3.5, 1.8);
    double e = wrapPi(c.yaw - std::atan2(tx, tz));
    c.offQ = clamp(-std::tan(e), -1, 1);
  } else { c.s = s; c.off = 0; c.offQ = 0; }
  placeOnRoad(c);
}

// on the lane line (or swerving), the body along the road between its axles, on the drawn road
void Traffic::placeOnRoad(Car& c) {
  const Road& r = t_.roads[size_t(c.road)];
  double half = c.l * 0.38;
  RoadPoint P = roadAt(r, clamp(c.s + c.dir * half, 0, r.length)), Q = roadAt(r, clamp(c.s - c.dir * half, 0, r.length));
  double tx = (P.x - Q.x) != 0 ? P.x - Q.x : c.dir * P.dx, tz = (P.z - Q.z) != 0 ? P.z - Q.z : c.dir * P.dz, tl = std::hypot(tx, tz);
  if (tl < 1e-9) tl = 1;
  double rx = -tz / tl, rz = tx / tl, w = LANE + c.off;
  dvec3 a(P.x + rx * w, 0, P.z + rz * w), b(Q.x + rx * w, 0, Q.z + rz * w);
  a.y = world_.groundHeight(a.x, a.z, P.y + 1); b.y = world_.groundHeight(b.x, b.z, Q.y + 1);
  c.x = (a.x + b.x) / 2; c.z = (a.z + b.z) / 2; c.y = (a.y + b.y) / 2 + 0.02;
  double ux = a.x - b.x, uz = a.z - b.z, ul = std::hypot(ux, uz);
  if (ul < 1e-9) ul = 1;
  c.yaw = std::atan2(ux / ul + rx * c.offQ, uz / ul + rz * c.offQ);
  c.pitch = std::atan2(b.y - a.y, std::hypot(a.x - b.x, a.z - b.z));
}

// traffic.js clearance(): the speed that still stops short of whatever is ahead (a time gap behind a moving one)
double Traffic::clearance(const Car& c, const dvec3& player, const Drive* you, const std::vector<Obb>& buses) const {
  double fx = std::sin(c.yaw), fz = std::cos(c.yaw), lim = 1e18, look = lookFor(c.v);
  auto check = [&](double x, double z, double gap, double stopAt, double vl) {
    double dx = x - c.x, dz = z - c.z, ahead = dx * fx + dz * fz, side = std::fabs(dx * fz - dz * fx);
    if (ahead > 0 && ahead < gap && side < 3.2) lim = std::min(lim, followV(ahead - stopAt, std::max(0.0, vl)));
  };
  auto box = [&](const Obb& o, double gap, double mm, double vl) {
    double dx = o.x - c.x, dz = o.z - c.z;
    if (std::fabs(dx) > gap + o.hd || std::fabs(dz) > gap + o.hd) return;
    double ahead = dx * fx + dz * fz, side = std::fabs(dx * fz - dz * fx);
    double along = o.hd * std::fabs(std::sin(o.yaw) * fx + std::cos(o.yaw) * fz) + o.hw * std::fabs(std::cos(o.yaw) * fx - std::sin(o.yaw) * fz);
    double across = o.hd * std::fabs(std::sin(o.yaw) * fz - std::cos(o.yaw) * fx) + o.hw * std::fabs(std::cos(o.yaw) * fz + std::sin(o.yaw) * fx);
    if (ahead + along > 0.5 && ahead - along < gap && side < c.w / 2 + across + 0.3) lim = std::min(lim, followV(ahead - along - c.l / 2 - mm, vl));
  };
  double gapW = std::max(36.0, look);
  for (const Car& o : list) {
    if (&o == &c || o.mode == Car::Mode::Gone || o.mode == Car::Mode::Parked) continue;
    if (o.mode == Car::Mode::Knocked) { box({o.x, o.z, o.yaw, o.w / 2, o.l / 2}, gapW, 14, 0); continue; }
    if (o.road == c.road && o.dir == c.dir) {
      double ds = (o.s - c.s) * c.dir;
      if (ds > 0 && ds < look && std::fabs(o.off - c.off) < 2.6) lim = std::min(lim, followV(ds - (c.l + o.l) / 2 - 3, o.v));
      continue;
    }
    double vl = (std::sin(o.yaw) * fx + std::cos(o.yaw) * fz) * o.v;
    check(o.x, o.z, 32, (c.l + o.l) / 2 + 3, vl);
  }
  if (you && you->active()) {
    dvec3 p = you->pos();
    dvec2 v = you->vel();
    if (std::hypot(v.x, v.y) < 0.8) box({p.x, p.z, you->yaw(), you->halfWidth(), you->halfLen()}, gapW, 2.5, 0);
    else { double vl = v.x * fx + v.y * fz; check(p.x, p.z, vl > -1 ? look : 32, (c.l + you->halfLen() * 2) / 2 + 3, vl); }
  } else check(player.x, player.z, std::max(26.0, look), c.l / 2 + 3, 0);
  for (const Obb& b : buses) box(b, gapW, 2.5, 0);
  return lim;
}

void Traffic::knock(int id, double vx, double vz, double w) {
  if (id < 0 || size_t(id) >= list.size()) return;
  Car& c = list[size_t(id)];
  c.mode = Car::Mode::Knocked; c.kvx = vx; c.kvz = vz; c.kw = w; c.kt = 0; c.v = 0; c.lot = c.bay = -1;
}

void Traffic::others(std::vector<OtherBody>& out, const dvec3& near) const {
  for (size_t i = 0; i < list.size(); i++) {
    const Car& c = list[i];
    if (c.mode == Car::Mode::Gone || std::fabs(c.x - near.x) > 14 || std::fabs(c.z - near.z) > 14) continue;
    OtherBody o;
    o.box = {c.x, c.z, c.yaw, c.w / 2, c.l / 2};
    if (c.mode == Car::Mode::Knocked) { o.vx = c.kvx; o.vz = c.kvz; o.w = c.kw; }
    else { o.vx = std::sin(c.yaw) * c.v; o.vz = std::cos(c.yaw) * c.v; }
    const CarSpec* sp = t_.car(c.name);
    o.mass = sp ? sp->mass : 1700; o.kind = 0; o.id = int(i);
    out.push_back(o);
  }
}

void Traffic::cars(std::vector<CarView>& out) const {
  for (const Car& c : list) if (c.mode == Car::Mode::Road || c.mode == Car::Mode::Knocked) out.push_back({dvec3(c.x, c.y, c.z), c.yaw, c.v, c.l, c.w, c.mode == Car::Mode::Road ? c.road : -1, c.s, c.dir});
}

void Traffic::fillColliders(std::vector<Collider>& out) const {
  for (const Car& c : list) {
    if (c.mode == Car::Mode::Gone) continue;
    Collider k;
    k.x = c.x; k.z = c.z; k.hw = c.w / 2; k.hd = c.l / 2; k.rot = -c.yaw; k.top = c.y + 1.6; k.soft = true;
    out.push_back(k);
  }
}

void Traffic::carPoses(std::vector<CarPose>& out, const dvec3& cam, double maxD, bool night) const {
  static const char* CANTONS[] = {"VS", "GR", "BE", "UR", "OW", "TI", "ZH", "LU"};
  for (const Car& c : list) {
    if (c.mode == Car::Mode::Gone || !c.vm || !c.vm->ok()) continue;
    if (std::hypot(c.x - cam.x, c.z - cam.z) > maxD) continue;
    CarPose p;
    p.vm = c.vm;
    p.M = glm::translate(glm::dmat4(1), dvec3(c.x, c.y, c.z)) * glm::rotate(glm::dmat4(1), c.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), c.pitch, dvec3(1, 0, 0));
    p.lights = night && c.mode == Car::Mode::Road;
    p.brake = c.mode == Car::Mode::Road && c.brake > 0.2;
    uint32_t h = uint32_t(&c - list.data()) * 2246822519u + 77u;
    p.plate = std::string(CANTONS[(h >> 8) % 8]) + " " + std::to_string(1000 + (h >> 12) % 899000);
    out.push_back(p);
  }
}

void Traffic::addDraw(VehicleDraw& draw, const dvec3& cam) const {
  for (const Car& c : list) {
    if (c.mode == Car::Mode::Gone || !c.vm || !c.vm->ok()) continue;
    double d = std::hypot(c.x - cam.x, c.z - cam.z);
    if (d > SHOW_R) continue;
    glm::dmat4 M = glm::translate(glm::dmat4(1), dvec3(c.x, c.y, c.z)) * glm::rotate(glm::dmat4(1), c.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), c.pitch, dvec3(1, 0, 0));
    draw.addCar(*c.vm, M, d < LOD_R ? 0 : 1, paintForIndex(uint32_t(&c - list.data())), c.odo / 0.34, 0);
  }
}

} // namespace sl

namespace sl {
namespace {
// carpeople.js SEATS (measured from the models' interiors, nose +z, the driver on +x): d the driver's seat [x, the
// cushion's y, the seat point's z], p the front passenger's [y, z] when it differs (x mirrored), r the rear outboard
// seats [x, y, z] (none: a two-seater)
struct SeatHint { const char* name; double d[3]; double p[2]; bool hasP; double r[3]; bool hasR; };
const SeatHint SEATS[] = {
  {"car_vw_golf_gti", {0.35, 0.436, -0.209}, {0, 0}, false, {0.37, 0.461, -1.085}, true},
  {"car_bmw_x3", {0.373, 0.632, -0.238}, {0, 0}, false, {0.38, 0.631, -1.079}, true},
  {"car_audi_rs6", {0.381, 0.432, 0.0}, {0.407, -0.10}, true, {0.38, 0.455, -0.986}, true},
  {"car_tesla_m3", {0.47, 0.395, -0.105}, {0, 0}, false, {0.38, 0.394, -0.97}, true},
  {"car_mercedes_sls", {0.43, 0.29, -0.675}, {0, 0}, false, {0, 0, 0}, false},
  {"car_porsche_taycan", {0.37, 0.37, -0.255}, {0, 0}, false, {0.38, 0.47, -1.08}, true},
  {"car_lamborghini_huracan", {0.37, 0.27, -0.24}, {0, 0}, false, {0, 0, 0}, false},
  {"car_toyota_gr_yaris", {0.35, 0.47, -0.26}, {0, 0}, false, {0.38, 0.54, -1.085}, true},
  {"car_audi_etron_gt", {0.37, 0.36, -0.255}, {0, 0}, false, {0.38, 0.475, -0.995}, true},
  {"car_mercedes_gls", {0.42, 0.79, -0.01}, {0, 0}, false, {0.42, 0.73, -1.16}, true},
};
// a seated Person's hips are ~0.55 m over its point (people.cpp: the seat 0.45 m up, the hips 0.1 m over it); the hip
// joints ~6 cm over the cushion (carpeople.js SEAT_LIFT)
constexpr double SIT_HIP = 0.06 - 0.55;
} // namespace

void Traffic::addPeople(People& people, const dvec3& cam, const std::vector<int>& kinds) const {
  peopleShown = 0;
  if (kinds.empty()) return;
  for (const Car& c : list) {
    if (c.mode != Car::Mode::Road && c.mode != Car::Mode::Knocked) continue;   // (parked traffic cars show nobody)
    if (std::hypot(c.x - cam.x, c.z - cam.z) > PEOPLE_R) continue;
    const SeatHint* S = nullptr;
    for (const SeatHint& h : SEATS) if (c.name == h.name) S = &h;
    double dx = S ? S->d[0] : 0.36, dy = S ? S->d[1] : 0.45, dz = S ? S->d[2] : -0.2;
    double cs = std::cos(c.yaw), sn = std::sin(c.yaw);
    uint32_t h = c.crew;
    auto rnd = [&h]() { h ^= h << 13; h ^= h >> 17; h ^= h << 5; return double(h & 0xffffff) / double(0x1000000); };
    auto put = [&](double x, double y, double z) {
      Person p;
      p.kind = kinds[size_t(rnd() * double(kinds.size())) % kinds.size()];
      p.pos = dvec3(c.x + x * cs + z * sn, c.y + y + SIT_HIP, c.z - x * sn + z * cs);
      p.yaw = c.yaw;
      p.anim = PAnim::Sit;
      p.scale = float(0.94 + rnd() * 0.08);
      people.add(p);
      peopleShown++;
    };
    put(dx, dy, dz);   // the driver, left front
    if (rnd() < 0.45) put(-dx, S && S->hasP ? S->p[0] : dy, S && S->hasP ? S->p[1] : dz);
    double back = !S || S->hasR ? rnd() : 1;   // (a two-seater: nobody in the back)
    double rx = S && S->hasR ? S->r[0] : dx, ry = S && S->hasR ? S->r[1] : dy, rz = S && S->hasR ? S->r[2] : dz - 0.86;
    if (back < 0.22) put((rnd() < 0.5 ? 1 : -1) * rx, ry, rz);
    else if (back < 0.3) { put(rx, ry, rz); put(-rx, ry, rz); }
  }
}

} // namespace sl
