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

// traffic.js planPass: the cars round a wreck through the other lane (logged once each as they come beside it: their
// offset from the lane line, speed, gap to the wreck's side), a shot of the first one beside it; no car's footprint
// ever overlaps the wreck's
void WreckTest::watchPass(WreckTestEnv& e, int which, const dvec3& at, double yaw, double hw, double hl, int skip) {
  Traffic& T = *e.traffic;
  const double fx = std::sin(yaw), fz = std::cos(yaw);
  for (size_t i = 0; i < T.list.size(); i++) {
    const Traffic::Car& c = T.list[i];
    if (int(i) == skip || c.mode != Traffic::Car::Mode::Road) continue;
    const double dx = c.x - at.x, dz = c.z - at.z;
    if (std::fabs(dx) > 15 || std::fabs(dz) > 15) continue;
    const double along = dx * fx + dz * fz, side = dx * fz - dz * fx;
    // (the car's footprint in the wreck's frame: its extents along / across the wreck's heading)
    const double ca = std::fabs(std::sin(c.yaw) * fx + std::cos(c.yaw) * fz), sa = std::sqrt(std::max(0.0, 1 - ca * ca));
    const double cAlong = c.l / 2 * ca + c.w / 2 * sa, cAcross = c.l / 2 * sa + c.w / 2 * ca;
    const double gapSide = std::fabs(side) - hw - cAcross, gapAlong = std::fabs(along) - hl - cAlong;
    if (gapSide < -0.05 && gapAlong < -0.05) {
      ok = false;
      SL_WARN("[wrecktest] car %zu drives into / through the %s wreck (side gap %.2f m, along gap %.2f m)", i, which ? "your" : "traffic", gapSide, gapAlong);
    }
    if (gapAlong < 0 && gapSide < 3.5 && std::find(passed_.begin(), passed_.end(), int(i) * 2 + which) == passed_.end()) {
      passed_.push_back(int(i) * 2 + which);
      passSeen_[which]++;
      SL_INFO("[wrecktest] car %zu (%s) passes the %s wreck: pass %s, %.1f m off its lane line, %.0f km/h, %.2f m clear of its side", i, c.name.c_str(), which ? "your" : "traffic",
              c.pass == 2 ? "through the other lane" : c.pass == 1 ? "by its own edge" : "none", c.off, c.v * 3.6, gapSide);
      if (!passShot_ && which == 1) { passShot_ = true; e.png("wreck_pass_yours"); }
    }
  }
}

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
      char b[80];
      std::snprintf(b, sizeof b, " %5.1fm@%4.0fkm/h%s", dist, c.v * 3.6, c.pass == 2 ? "(other lane)" : c.pass == 1 ? "(edge)" : "");
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
      if (c.mode == Traffic::Car::Mode::Wreck) watchPass(e, 0, at_, c.yaw, c.w / 2, c.l / 2, tcar_);
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
      // (cardamage.js / carlights.js Smoke) its dents and the plume from the bonnet: logged, a close shot of the dented
      // side right after the crash and 10 s later (the plume stops after a minute, what is in the air drifts away)
      const int puffs = p.smoke ? p.smoke->live() : 0;
      static const double LOGS[] = {0.6, 10.6, 30, 61.5};
      if (dentLogs_ < 4 && k >= LOGS[dentLogs_]) {
        dentLogs_++;
        std::string ds;
        for (const Dent& D : p.dents) { char b[96]; std::snprintf(b, sizeof b, " [at (%.2f %.2f %.2f) r %.2f depth %.2f]", D.x, D.y, D.z, D.r, D.depth); ds += b; }
        SL_INFO("[wrecktest] your wreck t+%.1fs: damage %.0f%%, %zu dents:%s; smoke: %d puffs in the air (rate %.1f)", k, p.damage, p.dents.size(), ds.c_str(), puffs, p.smoke ? p.smoke->rate : 0.0);
        if (k < 1 && (p.dents.empty() || puffs == 0)) { SL_WARN("[wrecktest] the wreck has no dents / no smoke"); ok = false; }
        if (k > 20 && k < 40 && puffs == 0) { SL_WARN("[wrecktest] the wreck stopped steaming before its first minute was out"); ok = false; }
      }
      const bool close = (k > 0.55 && k < 0.75) || (k > 10.55 && k < 10.75);
      if (close && !p.dents.empty()) {
        // (the dented side: the first dent's point as it lies, seen from outside it, a little above)
        const Dent& D = p.dents.back();
        const dvec3 dp(p.wreckM * glm::dvec4(D.x, D.y, D.z, 1)), mid(p.wreckM * glm::dvec4(0, 0.7, 0, 1));
        dvec3 out(dp.x - mid.x, 0, dp.z - mid.z);
        out = glm::length(out) > 1e-3 ? glm::normalize(out) : dvec3(-fwd_.z, 0, fwd_.x);
        const dvec3 side = glm::cross(out, dvec3(0, 1, 0));
        camPos = dp + out * 5.2 + side * 2.2 + dvec3(0, 1.6, 0);
        camPos.y = std::max(camPos.y, e.world->groundHeight(camPos.x, camPos.z, dp.y + 2) + 1.2);
        camLook = dp + dvec3(0, 0.6, 0);
        if (dentShots_ < 2 && k >= (dentShots_ == 0 ? 0.65 : 10.65)) { e.png(dentShots_ == 0 ? "wreck_dents_0s" : "wreck_dents_10s"); dentShots_++; }
      } else camBehind(36, 10);
      watchPass(e, 1, at_, std::atan2(p.wreckM[2][0], p.wreckM[2][2]), 0.97, p.length / 2, -1);
      static const double SH[] = {0.5, 10, 60};
      if (shots_ < 3 && k >= SH[shots_] && !close) { e.png("wreck_yours_" + std::to_string(int(SH[shots_])) + "s"); shots_++; }
      if (k > 62) {   // you walk away and look elsewhere: the tow truck takes it (drive.js: 3 s out of sight)
        SL_INFO("[wrecktest] round the wrecks: %d cars passed the traffic wreck, %d passed yours; traffic pulled out %d times", passSeen_[0], passSeen_[1], T.passes);
        // (a wreck lying across a narrow stretch (walls or guardrails both sides) leaves no room: the queue waits for the
        // tow truck, as on a real road; a failure only where there was room and nobody used it)
        if (passSeen_[1] == 0 && T.noRoom == 0) { SL_WARN("[wrecktest] no car came round your wreck"); ok = false; }
        else if (passSeen_[1] == 0) SL_INFO("[wrecktest] no room beside your wreck (%d checks found both sides blocked): the queue waits for the tow truck", T.noRoom);
        if (passSeen_[0] == 0) { SL_WARN("[wrecktest] no car came round the traffic wreck"); ok = false; }
        e.teleport(at_.x + fwd_.x * 400, at_.z + fwd_.z * 400, std::atan2(fwd_.x, fwd_.z));
        phase_ = 6; t0_ = t;
      }
      return k <= 62;
    }
    case 6: {
      Drive::Parked& p = e.drive->parked[size_t(idx_)];
      if (!p.wrecked) {
        // (impound.js: towed back repaired: no damage, no dents, no steam)
        SL_INFO("[wrecktest] towed %.1f s after you left it: damage %.0f%%, %zu dents, smoke %d puffs", t - t0_, p.damage, p.dents.size(), p.smoke ? p.smoke->live() : 0);
        if (p.damage > 0 || !p.dents.empty() || (p.smoke && p.smoke->any())) { SL_WARN("[wrecktest] the tow did not bring it back repaired"); ok = false; }
        // (the Werkstatt: a dented car of yours repaired: the dents out)
        e.drive->debugDent(idx_, 0, 1, 0.8); e.drive->debugDent(idx_, -1, 0.3, 0.5);
        p.damage = 23;
        SL_INFO("[wrecktest] in its bay, knocked about again: damage %.0f%%, %zu dents", p.damage, p.dents.size());
        at_ = dvec3(p.x, p.y, p.z); fwd_ = dvec3(std::sin(p.yaw), 0, std::cos(p.yaw));
        e.teleport(p.x + fwd_.x * 9 + fwd_.z * 3, p.z + fwd_.z * 9 - fwd_.x * 3, 0);
        phase_ = 7; t0_ = t;
      } else if (t - t0_ > 30) { SL_WARN("[wrecktest] the wreck was never towed"); ok = false; done = true; }
      if (done) SL_INFO("[wrecktest] %s", ok ? "PASS" : "FAILED");
      return false;
    }
    case 7: {   // the dented car in its bay (a shot), then the Werkstatt's repair (a shot)
      Drive::Parked& p = e.drive->parked[size_t(idx_)];
      const double k = t - t0_;
      camPos = at_ + fwd_ * 5.5 + dvec3(fwd_.z, 0, -fwd_.x) * 2.5 + dvec3(0, 1.7, 0);
      camLook = at_ + dvec3(0, 0.6, 0);
      if (werkShots_ == 0 && k >= 1.0) { werkShots_++; e.png("werkstatt_before"); }
      if (k > 1.5 && !p.dents.empty() && e.repair) {
        e.repair(p.plate);
        SL_INFO("[wrecktest] the Werkstatt repaired it: damage %.0f%%, %zu dents", p.damage, p.dents.size());
        if (p.damage > 0 || !p.dents.empty()) { SL_WARN("[wrecktest] the repair left dents"); ok = false; }
      }
      if (werkShots_ == 1 && k >= 2.5) { werkShots_++; e.png("werkstatt_after"); }
      if (k > 3) { done = true; SL_INFO("[wrecktest] %s", ok ? "PASS" : "FAILED"); }
      return true;
    }
  }
  return false;
}

} // namespace sl
