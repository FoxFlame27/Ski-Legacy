#include "game/wrecktest.h"
#include "core/log.h"
#include "game/drive.h"
#include "game/traffic.h"
#include "world/transport.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
// the road car with the most cars behind it on its road, the same way (a busy stretch)
int busiest(const Traffic& T, const Transport& tr, int skip) {
  int best = -1, bestN = -1;
  for (size_t i = 0; i < T.list.size(); i++) {
    const Traffic::Car& c = T.list[i];
    if (int(i) == skip || c.mode != Traffic::Car::Mode::Road || c.scenic || c.road < 0 || c.v < 4) continue;
    const Road& r = tr.roads[size_t(c.road)];
    if (r.access) continue;
    const double ahead = c.dir > 0 ? r.length - c.s : c.s;
    if (ahead < 160) continue;   // (room ahead on its road for the wreck)
    int n = 0;
    for (const Traffic::Car& o : T.list)
      if (&o != &c && o.mode == Traffic::Car::Mode::Road && o.road == c.road && o.dir == c.dir && (c.s - o.s) * c.dir > 0 && (c.s - o.s) * c.dir < 400) n++;
    if (n > bestN) { bestN = n; best = int(i); }
  }
  return best;
}
} // namespace

bool WreckTest::frame(WreckTestEnv& e, dvec3& camPos, dvec3& camLook) {
  if (done) return false;
  Traffic& T = *e.traffic;
  const double t = e.simTime;
  auto followers = [&](const char* what) {
    // the traffic behind the wreck (within 250 m, coming its way): distance to it and speed; none inside its footprint
    std::string s;
    int n = 0;
    for (size_t i = 0; i < T.list.size(); i++) {
      const Traffic::Car& c = T.list[i];
      if (c.mode != Traffic::Car::Mode::Road || int(i) == tcar_) continue;
      const dvec3 d(c.x - at_.x, 0, c.z - at_.z);
      const double along = d.x * fwd_.x + d.z * fwd_.z, dist = std::hypot(d.x, d.z);
      if (dist < 2.2) { ok = false; SL_WARN("[wrecktest] a car drove into / through the wreck (%.1f m from its middle)", dist); }
      if (dist > 250 || along > 0) continue;
      char b[64];
      std::snprintf(b, sizeof b, " %5.1fm@%4.0fkm/h", dist, c.v * 3.6);
      s += b; n++;
    }
    SL_INFO("[wrecktest] %s t+%4.1fs: %d cars behind:%s", what, t - t0_, n, s.c_str());
  };
  auto camBehind = [&](double back, double up) {
    camPos = at_ - fwd_ * back + dvec3(0, up, 0);
    camPos.y = std::max(camPos.y, e.world->groundHeight(camPos.x, camPos.z, at_.y + up) + 2.5);
    camLook = at_ - fwd_ * (back * 0.35) + dvec3(0, 0.8, 0);
  };
  switch (phase_) {
    case 0: {   // a traffic car with traffic behind it: knocked to a stop -> a wreck
      if (t < 4) return false;
      tcar_ = busiest(T, *e.transport, -1);
      if (tcar_ < 0) { if (t > 60) { SL_WARN("[wrecktest] no traffic car on a road"); ok = false; done = true; } return false; }
      Traffic::Car& c = T.list[size_t(tcar_)];
      fwd_ = dvec3(std::sin(c.yaw), 0, std::cos(c.yaw));
      stand_ = dvec3(c.x - fwd_.z * 18, 0, c.z + fwd_.x * 18);   // (beside the road: the traffic is simulated round you)
      e.teleport(stand_.x, stand_.z, 0);
      T.knock(tcar_, fwd_.z * 3, -fwd_.x * 3, 0.9);           // (knocked toward its kerb, spinning)
      at_ = dvec3(c.x, c.y, c.z);
      t0_ = t; nextLog_ = t; shots_ = 0; phase_ = 1;
      SL_INFO("[wrecktest] traffic car %d (%s) knocked on road %d at (%.0f, %.0f), %.0f km/h", tcar_, c.name.c_str(), c.road, c.x, c.z, c.v * 3.6);
      return false;
    }
    case 1: {
      const Traffic::Car& c = T.list[size_t(tcar_)];
      at_ = dvec3(c.x, c.y, c.z);
      e.teleport(stand_.x, stand_.z, 0);   // (held there: the autotest's skiing would take you away)
      if (t >= nextLog_) {
        nextLog_ += 1;
        SL_INFO("[wrecktest] traffic wreck: mode %d (0 road, 2 knocked, 4 wreck), %.2f m over the road", int(c.mode), c.y - e.world->groundHeight(c.x, c.z, c.y + 1));
        followers("traffic wreck");
      }
      camBehind(38, 11);
      const double k = t - t0_;
      static const double SH[] = {1.5, 10, 30};
      if (shots_ < 3 && k >= SH[shots_]) { e.png("wreck_traffic_" + std::to_string(int(SH[shots_])) + "s"); shots_++; }
      if (k > 32) { phase_ = 2; t0_ = t; }
      return true;
    }
    case 2: {   // your car in a lane ahead of the traffic, wrecked
      const int u = busiest(T, *e.transport, tcar_);
      if (u < 0) return false;
      const Traffic::Car& c = T.list[size_t(u)];
      const Road& r = e.transport->roads[size_t(c.road)];
      const double s = std::clamp(c.s + c.dir * 110, 5.0, r.length - 5);
      const RoadPoint P = roadAt(r, s);
      const double tx = P.dx * c.dir, tz = P.dz * c.dir;
      idx_ = e.drive->debugCar("car_vw_golf_gti");
      if (idx_ < 0) { ok = false; done = true; return false; }
      Drive::Parked& p = e.drive->parked[size_t(idx_)];
      p.x = P.x - tz * 1.6; p.z = P.z + tx * 1.6; p.yaw = std::atan2(tx, tz); p.y = e.world->groundHeight(p.x, p.z, P.y + 1) + 0.03;
      p.wrecked = false; p.wreckPose = false; p.damage = 0;
      e.teleport(p.x - tz * 4, p.z + tx * 4, p.yaw);
      e.enterCar(idx_);
      fwd_ = dvec3(tx, 0, tz);
      at_ = dvec3(p.x, p.y, p.z);
      SL_INFO("[wrecktest] your %s on road %d, %.0f m ahead of traffic car %d", p.name.c_str(), c.road, 110.0, u);
      phase_ = 3; t0_ = t;
      return false;
    }
    case 3:
      if (t - t0_ > 0.6 && e.drive->active()) { e.drive->debugCrash(45, PI); phase_ = 4; t0_ = t; }   // (onto its roof: the case that sank into the road)
      return false;
    case 4: {   // rolling / spinning to a stop, then out beside it
      const glm::dmat4 M = e.drive->carMatrix();
      if (e.drive->active()) {
        at_ = dvec3(M[3]);
        const double g = e.world->groundHeight(M[3][0], M[3][2], M[3][1] + 2);
        if (std::fmod(t - t0_, 0.5) < 1.0 / 60) SL_INFO("[wrecktest] crashing: body origin %.2f m over the ground, up (%.2f %.2f %.2f)", M[3][1] - g, M[1][0], M[1][1], M[1][2]);
        camBehind(16, 5);
        if (t - t0_ > 12) { SL_WARN("[wrecktest] never got out of the wreck"); ok = false; done = true; }
        return true;
      }
      const Drive::Parked& p = e.drive->parked[size_t(idx_)];
      at_ = dvec3(p.x, p.y, p.z);
      SL_INFO("[wrecktest] out of the wreck (toast '%s'): wrecked %d, kept its pose %d, up (%.2f %.2f %.2f)", e.toast.c_str(), int(p.wrecked), int(p.wreckPose), p.wreckM[1][0], p.wreckM[1][1], p.wreckM[1][2]);
      if (!p.wrecked || !p.wreckPose) ok = false;
      stand_ = e.player;
      phase_ = 5; t0_ = t; nextLog_ = t; shots_ = 0;
      return false;
    }
    case 5: {
      const Drive::Parked& p = e.drive->parked[size_t(idx_)];
      const double k = t - t0_;
      if (k > 1 && k < 1.02) { SL_INFO("[wrecktest] beside your wreck the prompt says '%s'", e.prompt.c_str()); if (e.prompt.find("wrecked") == std::string::npos) ok = false; }
      if (t >= nextLog_) {
        nextLog_ += 2;
        const double g = e.world->groundHeight(p.x, p.z, p.y + 1);
        SL_INFO("[wrecktest] your wreck: wrecked %d, drawn at %.2f m over the road (origin), up y %.2f", int(p.wrecked), p.wreckM[3][1] - g, p.wreckM[1][1]);
        followers("your wreck");
      }
      if (k <= 2) e.teleport(stand_.x, stand_.z, 0);   // (where wreckOut put you, beside it)
      if (k > 2 && k < 62) e.teleport(at_.x - fwd_.z * 9 - fwd_.x * 6, at_.z + fwd_.x * 9 - fwd_.z * 6, 0);   // (you stand by the road, out of the lane)
      camBehind(36, 10);
      static const double SH[] = {0.5, 10, 60};
      if (shots_ < 3 && k >= SH[shots_]) { e.png("wreck_yours_" + std::to_string(int(SH[shots_])) + "s"); shots_++; }
      if (k > 62) {   // you walk away and look elsewhere: the tow truck takes it (drive.js: 3 s out of sight)
        e.teleport(at_.x + fwd_.x * 400, at_.z + fwd_.z * 400, std::atan2(fwd_.x, fwd_.z));
        phase_ = 6; t0_ = t;
      }
      return k <= 62;
    }
    case 6: {
      const Drive::Parked& p = e.drive->parked[size_t(idx_)];
      if (!p.wrecked) { SL_INFO("[wrecktest] towed %.1f s after you left it", t - t0_); done = true; }
      else if (t - t0_ > 30) { SL_WARN("[wrecktest] the wreck was never towed"); ok = false; done = true; }
      if (done) SL_INFO("[wrecktest] %s", ok ? "PASS" : "FAILED");
      return false;
    }
  }
  return false;
}

} // namespace sl
