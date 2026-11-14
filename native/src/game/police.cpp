#include "game/police.h"
#include "game/policehud.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/drive.h"
#include "game/economy.h"
#include "game/menus.h"
#include "game/people.h"
#include "game/play_data.h"
#include "game/shapes.h"
#include "game/traffic.h"
#include "player/player.h"
#include "world/transport.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>

namespace sl {

namespace {
// police.js TUNING / LEVELS
constexpr double TRIGGER_KMH = 25, COP_RAM_KMH = 15, FINE = 1000, ARREST_FINE = 3000, FINE_STEP = 500, ARREST_STEP = 1000, JAIL_S = 45;
constexpr double LOSE_S = 2.5, SEE_NEAR = 45, KEEP_ESC = 0.5, NO_SPOT_S = 75, HEAT_PER_S = 1.0 / 36, HEAT_HIT_COP = 0.35;
constexpr double STOP_R = 40, STOP_KMH = 3, STOP_S = 3, SPAWN_MIN = 260, SPAWN_MAX = 420, REACH_R = 60, GRACE_S = 6;
constexpr double FOOT_CATCH_R = 1.5, FOOT_RUN_V = 6.9, FOOT_LOSE_M = 45, FOOT_LEASH_M = 400, FOOT_ESC_K = 2.2;
constexpr double HOLD_R = 12, HOLD_S = 10, HOLD_MORE = 0.6, V_TOP = 250 / 3.6, LEN = 5.0, WALK_V = 1.6;
[[maybe_unused]] constexpr double WB = 2.95;
constexpr double HELI_V = 64, HELI_A = 13, HELI_ALT = 72, HELI_SEE = 170, HELI_HIDE = 1.25, HELI_CALL_S = 45;
struct Level { int cars; double reinS, vRoad, catchUp, ramGap, ramExtra, sightR, escS; bool heli; };
const Level LEVELS[6] = {{0, 99, 0, 0, 0, 0, 0, 0, false},
  {1, 99, 52, 0.34, 1.5, 10, 150, 14, false}, {2, 8, 54, 0.4, 1.1, 11, 175, 18, false}, {3, 8, 57, 0.45, 0.9, 12, 205, 24, false},
  {4, 7, 60, 0.5, 0.75, 13, 235, 32, true}, {5, 7, 63, 0.55, 0.6, 14, 265, 42, true}};
const char* COMPASS[8] = {"north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"};
// vehiclehits.js / peoplehits.js
constexpr double V_MIN = 10 / 3.6, SOFT = 35 / 3.6, HARD = 45 / 3.6, SAFE_S = 2, PERSON_R = 0.3;
std::string mmss(double s) { int t = int(std::max(0.0, std::ceil(s))); char b[16]; std::snprintf(b, sizeof b, "%d:%02d", t / 60, t % 60); return b; }
// a circle (player) against an oriented box: penetration and the push-out normal
bool circleObb(double px, double pz, double r, double bx, double bz, double yaw, double hw, double hd, double& nx, double& nz, double& pen) {
  double c = std::cos(yaw), s = std::sin(yaw);
  double dx = px - bx, dz = pz - bz;
  double lx = dx * c - dz * s, lz = dx * s + dz * c;   // (local: x across, z along the nose)
  double qx = std::clamp(lx, -hw, hw), qz = std::clamp(lz, -hd, hd);
  double ex = lx - qx, ez = lz - qz, d = std::hypot(ex, ez);
  if (d > r) return false;
  if (d < 1e-6) { if (hw - std::fabs(lx) < hd - std::fabs(lz)) { ex = lx >= 0 ? 1 : -1; ez = 0; } else { ex = 0; ez = lz >= 0 ? 1 : -1; } d = 0; }
  else { ex /= d; ez /= d; }
  nx = ex * c + ez * s; nz = -ex * s + ez * c;
  pen = r - d;
  return true;
}
} // namespace

Police::Police(PlayCtx& c, Interiors& rooms, WindowView& win) : c_(c), rooms_(rooms), win_(win) {}

void Police::load(AssetManager& assets) {
  ModelLoadOptions o;
  o.maxTextureSize = 512;
  o.lodRatios = {0.15f};
  car_ = assets.model("car1", o);
  if (!car_) car_ = assets.model("police/police_car", o);
  if (car_) carFit_ = car_->fitTransform(float(LEN), 2);
  heliModel_ = assets.model("heli_body", o);
  if (heliModel_) heliFit_ = heliModel_->fitTransform(11.5f, 3, true);
  station_ = assets.model("prison/prison_station", o);
  if (station_) stationFit_ = station_->fitTransform(18.0f, 3);
}

int Police::arrests() const {
  const nlohmann::json& r = c_.save->data("policeRecord");
  return r.value("arrests", 0);
}

// ---------------------------------------------------------------- the chase
void Police::callFor(const std::string& why, double kmh) {
  if (kmh < TRIGGER_KMH || rooms_.inside() || jailed()) return;
  if (!wanted_) {
    wanted_ = true; fleeing_ = false; heat_ = 1; wantedT_ = 0; spotted_ = false; reachT_ = -1; stopT_ = 0; escT_ = 0; searching_ = false;
    lastSeen_ = c_.player->pos;
    radio_ = "All units: " + why + " \xC2\xB7 suspect in a car near " + (std::hypot(lastSeen_.x, lastSeen_.z) < 400 ? std::string("Legacy Village") : std::string("the valley road"));
    radioT_ = c_.now;
    c_.flash("The police are on their way \xC2\xB7 stop and pay, or run", 1);
    slam("PULL OVER", c_.driving ? "POLICE \xC2\xB7 STOP AT THE SIDE OF THE ROAD" : "POLICE \xC2\xB7 STAY WHERE YOU ARE", 0);
    prevStars_ = 1;
    SL_INFO("police: called (%s, %.0f km/h)", why.c_str(), kmh);
  } else if (fleeing_) heat_ = std::min(5.0, heat_ + 0.2);
}

void Police::hitCop(int, double kmh) {
  if (kmh < COP_RAM_KMH) return;
  if (!wanted_) { callFor("a patrol car rammed", TRIGGER_KMH); fleeing_ = true; heat_ = 2; slam("WANTED", "YOU HIT A POLICE CAR", 0.4); prevStars_ = 2; }
  else { heat_ = std::min(5.0, heat_ + HEAT_HIT_COP); slam("WRECKED!", "POLICE CAR HIT \xC2\xB7 MORE HEAT", 0.15); }
}

void Police::clear(const char* why) {
  if (!wanted_) return;
  wanted_ = false; fleeing_ = false; searching_ = false; pulled_ = false; heat_ = 0;
  for (Unit& u : units_) { u.leaving = true; u.out = false; u.offState = 0; }
  heli_.on = false;
  SL_INFO("police: %s", why);
}

void Police::spawnUnit() {
  const Transport& T = *c_.transport;
  const dvec3 p = c_.driving ? c_.drive->pos() : c_.player->pos;
  double fwdX = std::sin(c_.driving ? c_.drive->yaw() : c_.player->heading), fwdZ = std::cos(c_.driving ? c_.drive->yaw() : c_.player->heading);
  double best = -1e9;
  int br = -1, bi = 0;
  for (size_t ri = 0; ri < T.roads.size(); ri++) {
    const Road& r = T.roads[ri];
    for (int i = 0; i < r.n; i += 6) {
      double dx = r.X[size_t(i)] - p.x, dz = r.Z[size_t(i)] - p.z, d = std::hypot(dx, dz);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      double behind = -(dx * fwdX + dz * fwdZ) / d;
      double sc = behind * 2 + rnd() * 0.5;
      if (sc > best) { best = sc; br = int(ri); bi = i; }
    }
  }
  Unit u;
  if (br >= 0) {
    const Road& r = T.roads[size_t(br)];
    u.road = br; u.s = r.S[size_t(bi)];
    RoadPoint q = roadAt(r, u.s);
    u.pos = dvec3(q.x, q.y, q.z);
    u.yaw = std::atan2(q.dx, q.dz);
  } else {   // (off the network: behind you over the snow)
    u.pos = dvec3(p.x - fwdX * SPAWN_MIN, 0, p.z - fwdZ * SPAWN_MIN);
    u.pos.y = c_.world->groundHeight(u.pos.x, u.pos.z, p.y + 50);
    u.yaw = std::atan2(fwdX, fwdZ);
  }
  u.v = 20;
  units_.push_back(u);
}

bool Police::canSee(const Unit& u, const dvec3& p, double range) const {
  double d = glm::length(p - u.pos);
  if (d < SEE_NEAR) return true;
  if (d > range) return false;
  // line of sight through the terrain (a bump, a ridge, the mountain)
  for (int i = 1; i < 8; i++) {
    dvec3 q = glm::mix(u.pos + dvec3(0, 1.5, 0), p + dvec3(0, 1.2, 0), i / 8.0);
    if (c_.world->height(q.x, q.z) > q.y + 0.5) return false;
  }
  return !c_.transport->inRoadTunnel(p.x, p.z, p.y + 1);
}

void Police::driveUnit(Unit& u, double dt, const dvec3& target, double want) {
  const Transport& T = *c_.transport;
  double dist = std::hypot(target.x - u.pos.x, target.z - u.pos.z);
  u.v += std::clamp(want - u.v, -9 * dt, 6 * dt);
  // (not getting any closer along the roads for a while: straight over the snow instead)
  if (dist < u.bestD - 3) { u.bestD = dist; u.stuckT = 0; } else u.stuckT += dt;
  if (u.stuckT > 6 && u.road >= 0) { u.road = -1; u.stuckT = 0; u.bestD = dist; }
  // along the roads while far (the lane ahead toward you), straight at you when close or off the roads
  if (dist > 110 && u.road >= 0) {
    const Road& r = T.roads[size_t(u.road)];
    RoadPoint a = roadAt(r, std::clamp(u.s + 25, 0.0, r.length)), b = roadAt(r, std::clamp(u.s - 25, 0.0, r.length));
    double da = std::hypot(target.x - a.x, target.z - a.z), db = std::hypot(target.x - b.x, target.z - b.z);
    int want_dir = da < db ? 1 : -1;
    if (want_dir != u.dir && u.v < 12) u.dir = want_dir;
    u.s += u.dir * u.v * dt;
    if (u.s < 0 || u.s > r.length || std::min(da, db) > dist + 30) {
      // the road ends or leads away: onto another road nearer you, or over the snow
      Transport::RoadHit h = T.nearestRoad(u.pos.x, u.pos.z, 30);
      u.road = (h.road >= 0 && h.road != u.road) ? h.road : -1;
      u.s = h.s;
    }
    if (u.road >= 0) {
      const Road& r2 = T.roads[size_t(u.road)];
      RoadPoint q = roadAt(r2, std::clamp(u.s, 0.0, r2.length));
      double lane = 1.6 * u.dir;
      u.pos = dvec3(q.x - q.dz * lane, 0, q.z + q.dx * lane);
      u.yaw = std::atan2(q.dx * u.dir, q.dz * u.dir);
      u.pos.y = c_.world->groundHeight(u.pos.x, u.pos.z, q.y + 1);
      return;
    }
  }
  double tgtYaw = std::atan2(target.x - u.pos.x, target.z - u.pos.z);
  double rate = 1.4 * std::min(1.0, u.v / 6 + 0.2);
  u.yaw += std::clamp(wrapPi(tgtYaw - u.yaw), -rate * dt, rate * dt);
  u.pos.x += std::sin(u.yaw) * u.v * dt + u.kvx * dt;
  u.pos.z += std::cos(u.yaw) * u.v * dt + u.kvz * dt;
  u.kvx *= std::exp(-dt * 2); u.kvz *= std::exp(-dt * 2);
  u.pos.y = c_.world->groundHeight(u.pos.x, u.pos.z, u.pos.y + 1.5);
  if (dist < 60 && u.road >= 0) u.road = -1;
  else if (u.road < 0 && dist > 160 && u.stuckT < 3) { Transport::RoadHit h = T.nearestRoad(u.pos.x, u.pos.z, 8); if (h.road >= 0) { u.road = h.road; u.s = h.s; } }
}

void Police::arrest(const char* how) {
  if (arrestT_ >= 0) return;
  arrestT_ = 0;
  arrestHow_ = how;
  nlohmann::json& r = c_.save->data("policeRecord");
  int n = r.value("arrests", 0);
  int fine = int(ARREST_FINE + ARREST_STEP * n);
  r["arrests"] = n + 1;
  r["fined"] = r.value("fined", 0) + fine;
  c_.charge(fine);
  c_.save->markDirty();
  c_.flash(std::string("ARRESTED \xC2\xB7 ") + how + " \xC2\xB7 -" + fmtMoney(fine), 1);
  SL_INFO("police: arrested (%s), fine $%d", how, fine);
}

void Police::openFine() {
  fineOpen_ = true;
  nlohmann::json& r = c_.save->data("policeRecord");
  int n = r.value("fines", 0) + r.value("arrests", 0);
  int fine = int(FINE + FINE_STEP * n);
  Dialog d;
  d.kicker = "Polizei \xC2\xB7 traffic stop";
  d.title = "License and registration";
  d.say = "License and registration, please... That's a fine of " + fmtMoney(fine) + ". Drive safely.";
  DialogOption pay; pay.label = "Pay the fine"; pay.price = fine;
  pay.act = [this, fine]() {
    nlohmann::json& rr = c_.save->data("policeRecord");
    rr["fines"] = rr.value("fines", 0) + 1; rr["fined"] = rr.value("fined", 0) + fine;
    c_.charge(fine);
    c_.flash("Fined " + fmtMoney(fine) + " \xC2\xB7 the police drive off", 1);
    fineOpen_ = false;
    clear("fined");
  };
  DialogOption run; run.label = "Drive off"; run.sub = "Run: they come after you (wanted)"; run.secondary = false;
  run.act = [this]() { fineOpen_ = false; pulled_ = false; fleeing_ = true; heat_ = std::max(heat_, 2.0); for (Unit& u : units_) { u.out = false; u.offState = 0; } };
  d.options = {pay, run};
  c_.menus->openDialog(d);
}

void Police::update(double dt) {
  // ---- the arrest moment: the banner, then the cell
  if (arrestT_ >= 0) {
    arrestT_ += dt;
    if (c_.player->mode != PlayerMode::Sit) c_.player->vel = dvec3(0);
    if (arrestT_ > 3.2) {
      arrestT_ = -1;
      clear("arrested");
      units_.clear();
      jail(JAIL_S, arrestHow_);
    }
    return;
  }
  // ---- the prison sentence
  if (jailLeft_ > 0) {
    jailLeft_ -= dt;
    saveT_ -= dt;
    if (saveT_ <= 0) { saveT_ = 1; c_.save->data("jail") = {{"left", std::max(0.0, jailLeft_)}, {"reason", jailReason_}}; c_.save->markDirty(); }
    if (jailLeft_ <= 0) {
      jailLeft_ = 0;
      c_.save->data("jail") = nlohmann::json::object();
      rooms_.leave();
    }
    return;
  }
  // ---- units leaving after it's over (driving off, gone out of sight)
  for (size_t i = 0; i < units_.size();) {
    Unit& u = units_[i];
    if (u.leaving) {
      u.out = false;
      u.v = std::min(u.v + 4 * dt, 18.0);
      u.pos.x += std::sin(u.yaw) * u.v * dt; u.pos.z += std::cos(u.yaw) * u.v * dt;
      u.pos.y = c_.world->groundHeight(u.pos.x, u.pos.z, u.pos.y + 1.5);
      if (glm::length(u.pos - c_.player->pos) > 350) { units_.erase(units_.begin() + long(i)); continue; }
    }
    i++;
  }
  if (!wanted_) return;
  if (rooms_.inside()) return;
  wantedT_ += dt;
  const Level& L = LEVELS[stars()];
  bool onFoot = !c_.driving;
  dvec3 you = c_.driving ? c_.drive->pos() : c_.player->pos;
  double yourV = c_.driving ? c_.drive->speed() : c_.player->speed();
  // ---- reinforcements up to the level's cars
  int active = 0;
  for (auto& u : units_) active += !u.leaving;
  reinT_ -= dt;
  if (active < L.cars && (active == 0 || reinT_ <= 0) && units_.size() < 8) { spawnUnit(); reinT_ = L.reinS; }
  // ---- who sees you
  bool seen = false;
  double nearest = 1e9;
  int nearI = -1;
  for (size_t i = 0; i < units_.size(); i++) {
    const Unit& u = units_[i];
    if (u.leaving) continue;
    double d = glm::length(u.pos - you);
    if (d < nearest) { nearest = d; nearI = int(i); }
    if (canSee(u, you, L.sightR) || (u.out && glm::length(u.off - you) < 60)) seen = true;
  }
  // the helicopter (police.js heliStep): flies in, then keeps 72 m over you with its light on
  if ((L.heli || (fleeing_ && fleeT_ > HELI_CALL_S)) && !heli_.on) {
    heli_.on = true;
    heli_.pos = lastSeen_ + dvec3(-600, 0, -400);
    heli_.pos.y = c_.world->height(heli_.pos.x, heli_.pos.z) + HELI_ALT + 40;
    heli_.vel = dvec3(0);
    radio_ = "Air support on the way"; radioT_ = c_.now;
  }
  if (heli_.on) {
    dvec3 aim = (spotted_ && !searching_ ? you : lastSeen_) + dvec3(0, 0, 0);
    dvec3 goal(aim.x - std::sin(heli_.yaw) * 22, std::max(c_.world->height(aim.x, aim.z), c_.world->height(heli_.pos.x, heli_.pos.z)) + HELI_ALT, aim.z - std::cos(heli_.yaw) * 22);
    dvec3 dv = goal - heli_.pos;
    double dl = glm::length(dv);
    dvec3 want = dl > 1 ? dv / dl * std::min(HELI_V, dl * 0.6) : dvec3(0);
    dvec3 acc = want - heli_.vel;
    double al = glm::length(acc);
    if (al > HELI_A * dt) acc *= HELI_A * dt / al;
    heli_.vel += acc;
    heli_.pos += heli_.vel * dt;
    if (glm::length(dvec2(heli_.vel.x, heli_.vel.z)) > 2) heli_.yaw = dampAngle(heli_.yaw, std::atan2(heli_.vel.x, heli_.vel.z), dt * 2);
    heli_.rotor += dt * 40;
    double hd = std::hypot(heli_.pos.x - you.x, heli_.pos.z - you.z);
    bool hidden = c_.transport->inRoadTunnel(you.x, you.z, you.y + 1);
    bool inView = hd < HELI_SEE && !hidden;
    heli_.hideT = inView ? 0 : heli_.hideT + dt;
    heli_.sees = heli_.hideT < HELI_HIDE && hd < 400;
    if (heli_.sees && inView) seen = true;
  }
  if (seen) {
    if (searching_) { escT_ *= KEEP_ESC; searching_ = false; radio_ = "Suspect spotted again!"; radioT_ = c_.now; }
    spotted_ = true; unseenT_ = 0; lastSeen_ = you; seenT_ += dt;
    if (fleeing_) heat_ = std::min(5.0, heat_ + HEAT_PER_S * dt);
  } else {
    unseenT_ += dt;
    if (unseenT_ > LOSE_S && spotted_ && !searching_) { searching_ = true; radio_ = "We lost them \xC2\xB7 searching the area"; radioT_ = c_.now; }
  }
  if (searching_ && fleeing_) {
    escT_ += dt / (onFoot ? FOOT_ESC_K : 1);
    if (escT_ >= L.escS) { c_.flash("You escaped the police", 2); clear("escaped"); return; }
  }
  if (!spotted_ && wantedT_ > NO_SPOT_S) { clear("gave up"); return; }
  if (fleeing_) fleeT_ += dt; else fleeT_ = 0;
  // ---- reached you: the grace to pull over; still moving after it: fleeing
  if (nearest < REACH_R && reachT_ < 0) reachT_ = 0;
  if (reachT_ >= 0) reachT_ += dt;
  bool stoppedNow = yourV * 3.6 < STOP_KMH;
  stopT_ = stoppedNow ? stopT_ + dt : 0;
  if (!fleeing_ && !pulled_) {
    if (stopT_ > STOP_S && nearest < STOP_R) {
      pulled_ = true;
      if (nearI >= 0) { Unit& u = units_[size_t(nearI)]; u.stopped = true; u.out = true; u.offState = 1; u.off = u.pos + dvec3(std::cos(u.yaw) * 1.2, 0, -std::sin(u.yaw) * 1.2); u.offT = 0; }
      radio_ = "Pulling the suspect over"; radioT_ = c_.now;
    } else if (reachT_ > GRACE_S && !stoppedNow) {
      fleeing_ = true; heat_ = std::max(heat_, 2.0);
      radio_ = std::string("Suspect fleeing ") + COMPASS[int(std::fmod(std::atan2(c_.player->vel.x, -c_.player->vel.z) / TAU * 8 + 8.5, 8.0))] + "!"; radioT_ = c_.now;
      c_.flash("You are fleeing \xC2\xB7 WANTED", 1);
    }
  }
  if (pulled_ && !fleeing_ && !stoppedNow && yourV > 4) { pulled_ = false; fleeing_ = true; heat_ = std::max(heat_, 2.0); for (Unit& u : units_) { u.out = false; u.offState = 0; } }
  // ---- arrest: boxed in, stopped while fleeing
  if (fleeing_) {
    int close = 0;
    for (auto& u : units_) close += !u.leaving && glm::length(u.pos - you) < HOLD_R;
    if (close >= 2) holdT_ += dt * (1 + HOLD_MORE * (close - 2)); else holdT_ = std::max(0.0, holdT_ - dt * 0.5);
    if (holdT_ > HOLD_S) { arrest("boxed in by the police"); return; }
    if (c_.driving && stopT_ > STOP_S && nearest < 15) { arrest("caught fleeing the police"); return; }
  }
  // ---- the units
  for (size_t i = 0; i < units_.size(); i++) {
    Unit& u = units_[i];
    if (u.leaving) continue;
    u.flash += dt;
    u.ramT -= dt;
    double d = glm::length(u.pos - you);
    if (u.out) {
      // the officer on foot (walks to your window when pulled over; runs after you on foot when you flee)
      u.offT += dt;
      dvec3 tgt = u.offState == 1 ? (c_.driving ? you + dvec3(std::cos(c_.drive->yaw()) * 1.6, 0, -std::sin(c_.drive->yaw()) * 1.6) : you) : u.offState == 3 ? c_.player->pos : u.pos;
      double sp = u.offState == 3 ? FOOT_RUN_V : WALK_V;
      if (u.offState == 3) {   // slowed by steep ground as you are
        double gx = c_.world->height(u.off.x + 1, u.off.z) - c_.world->height(u.off.x - 1, u.off.z), gz = c_.world->height(u.off.x, u.off.z + 1) - c_.world->height(u.off.x, u.off.z - 1);
        sp *= clamp(1.2 - std::hypot(gx, gz) * 0.9, 0.35, 1);
      }
      dvec3 dv = tgt - u.off;
      double dl = glm::length(dvec2(dv.x, dv.z));
      if (dl > 0.2) { u.off.x += dv.x / dl * std::min(dl, sp * dt); u.off.z += dv.z / dl * std::min(dl, sp * dt); u.offYaw = std::atan2(dv.x, dv.z); }
      u.off.y = c_.world->groundHeight(u.off.x, u.off.z, u.off.y + 1);
      if (u.offState == 1 && dl < 1.0) { u.offState = 2; if (!fineOpen_) openFine(); }
      if (u.offState == 3) {
        double dp = std::hypot(c_.player->pos.x - u.off.x, c_.player->pos.z - u.off.z);
        if (dp < FOOT_CATCH_R) { arrest("caught on foot"); return; }
        if (dp > FOOT_LOSE_M + 60 || glm::length(u.off - u.pos) > FOOT_LEASH_M) u.offState = 4;
        if (c_.driving) u.offState = 4;
      }
      if (u.offState == 4 && glm::length(dvec2(u.off.x - u.pos.x, u.off.z - u.pos.z)) < 1.5) { u.out = false; u.offState = 0; }
      if (u.offState == 4) { dvec3 b = u.pos - u.off; double bl = glm::length(dvec2(b.x, b.z)); if (bl > 0.1) { u.off.x += b.x / bl * std::min(bl, 5 * dt); u.off.z += b.z / bl * std::min(bl, 5 * dt); } }
      continue;
    }
    if (pulled_ && !fleeing_) { u.v = std::max(0.0, u.v - 8 * dt); continue; }
    if (onFoot && d < 22 && fleeing_ && int(i) == nearI && !u.out) {
      // out of the car and after you on foot
      u.v = 0; u.out = true; u.offState = 3; u.off = u.pos + dvec3(std::cos(u.yaw) * 1.2, 0, -std::sin(u.yaw) * 1.2); u.offT = 0;
      continue;
    }
    if (!fleeing_ && !onFoot && d < STOP_R) { u.v = std::max(0.0, std::min(u.v, yourV + 1) - 2 * dt); driveUnit(u, dt, you, std::max(0.0, yourV)); continue; }
    // the chase: road speed far, the rubber band closing in, rams when close (a PIT at the rear quarter)
    double want = L.vRoad;
    if (d < 200) want = std::min(V_TOP, yourV + (fleeing_ ? L.ramExtra : 3) + std::max(0.0, d - 90) * L.catchUp * 0.05);
    if (onFoot && d < 30) want = std::min(want, 6.0);
    dvec3 aim = you;
    if (fleeing_ && c_.driving && d < 25 && u.ramT <= 0) {
      double yy = c_.drive->yaw();
      aim = you - dvec3(std::sin(yy), 0, std::cos(yy)) * 1.6 + dvec3(std::cos(yy), 0, -std::sin(yy)) * ((i % 2) ? 1.2 : -1.2);
      if (d < 6) { u.ramT = L.ramGap; slam("RAMMED!", "MORE HEAT", 0.25 + 0.75 * std::clamp(u.v / 30.0, 0.0, 1.0)); }
    }
    driveUnit(u, dt, aim, want);
  }
}

void Police::others(std::vector<OtherBody>& out, const dvec3& near) const {
  for (size_t i = 0; i < units_.size(); i++) {
    const Unit& u = units_[i];
    if (glm::length(u.pos - near) > 30) continue;
    OtherBody o;
    o.box = {u.pos.x, u.pos.z, u.yaw, 0.97, LEN / 2};
    o.vx = std::sin(u.yaw) * u.v; o.vz = std::cos(u.yaw) * u.v;
    o.mass = 1900; o.kind = 3; o.id = int(i);
    out.push_back(o);
  }
}

void Police::knockUnit(int id, double vx, double vz) {
  if (id < 0 || id >= int(units_.size())) return;
  Unit& u = units_[size_t(id)];
  u.kvx += vx; u.kvz += vz;
  u.v *= 0.6;
}

void Police::fillColliders(std::vector<Collider>& out) const {
  // (prisonoutside.js: the house, the lamp, the signs' posts, the planters)
  if (c_.data && c_.data->prisonDef.hasOutside && !rooms_.inside() && std::hypot(c_.player->pos.x - c_.data->prisonDef.doorX, c_.player->pos.z - c_.data->prisonDef.doorZ) < 80)
    for (const PrisonDef::Col& q : c_.data->prisonDef.colliders) {
      Collider c;
      c.x = q.x; c.z = q.z;
      if (q.r >= 0) c.r = q.r; else { c.hw = q.hw; c.hd = q.hd; c.rot = q.rot; }
      out.push_back(c);
    }
  for (const Unit& u : units_) {
    if (glm::length(u.pos - c_.player->pos) > 40) continue;
    Collider c;
    c.x = u.pos.x; c.z = u.pos.z; c.hw = 0.97; c.hd = LEN / 2; c.rot = -u.yaw; c.top = u.pos.y + 1.6;
    out.push_back(c);
  }
}

void Police::addDraw(VehicleDraw& vd, const dvec3& cam) const {
  if (!car_) return;
  for (const Unit& u : units_) {
    double d = glm::length(u.pos - cam);
    if (d > 600) continue;
    glm::dmat4 M = glm::translate(glm::dmat4(1), u.pos) * glm::rotate(glm::dmat4(1), u.yaw, dvec3(0, 1, 0)) * glm::dmat4(carFit_);
    vd.add(car_.get(), M, d > 70 ? 1 : 0);
  }
  // the patrol car parked at the station
  if (c_.data && c_.data->prison.ok) {
    const Site& P = c_.data->prison;
    dvec3 p(P.ex + (P.x - P.ex) * 0.35 + P.dirx * 6, 0, P.ez + (P.z - P.ez) * 0.35 + P.dirz * 6);
    double pyaw = std::atan2(P.dirx, P.dirz);
    // (prisonoutside.js: the patrol car parked in the station's first bay)
    if (c_.data->prisonDef.hasPatrol) { p = dvec3(c_.data->prisonDef.patrolX, 0, c_.data->prisonDef.patrolZ); pyaw = c_.data->prisonDef.patrolYaw + PI; }   // (its nose to the house)
    p.y = c_.world->groundHeight(p.x, p.z, P.y + 2);
    if (glm::length(p - cam) < 500) vd.add(car_.get(), glm::translate(glm::dmat4(1), p) * glm::rotate(glm::dmat4(1), pyaw, dvec3(0, 1, 0)) * glm::dmat4(carFit_), glm::length(p - cam) > 70 ? 1 : 0);
  }
}

void Police::draw(Renderer& r, const dvec3& cam) {
  Shapes& sh = *c_.shapes;
  // the station (prisonoutside.js: the POLIZEI house on its lot, its door toward the road)
  if (!outside_ && c_.roomModel && c_.data && c_.data->prisonDef.hasOutside) outside_ = c_.roomModel("prison_outside");
  if (outside_ && !rooms_.inside()) {
    // (the alpine POLIZEI house on its lot as the web game builds it; out of its own windows' photographs)
    const dvec3 p = c_.data->prisonDef.outsideAt;
    if (!(entering_ && win_.capturing()) && glm::length(p - cam) < 1500 && r.visible(p - dvec3(30, 2, 30), p + dvec3(30, 16, 30)))
      r.submitModel(*outside_, p, mat4(1), nullptr, glm::length(p - cam) < 300);
  } else if (station_ && c_.data && c_.data->prison.ok && !rooms_.inside()) {
    const Site& P = c_.data->prison;
    dvec3 p(P.x, c_.world->height(P.x, P.z), P.z);
    if (glm::length(p - cam) < 1500 && r.visible(p - dvec3(12, 0, 12), p + dvec3(12, 14, 12)))
      r.submitModel(*station_, p, glm::rotate(mat4(1), float(std::atan2(P.ex - P.x, P.ez - P.z)), vec3(0, 1, 0)) * stationFit_, nullptr, glm::length(p - cam) < 300);
  }
  // the roof bars' blue lights flashing
  for (const Unit& u : units_) {
    if (glm::length(u.pos - cam) > 400) continue;
    bool a = std::fmod(u.flash * 4, 1.0) < 0.5;
    for (int s = -1; s <= 1; s += 2) {
      dvec3 p = u.pos + dvec3(std::cos(u.yaw) * 0.3 * s, 1.63, -std::sin(u.yaw) * 0.3 * s);
      bool on = (s < 0) == a;
      sh.box(r, p, u.yaw, vec3(0.42f, 0.09f, 0.22f), on ? vec4(0.15f, 0.3f, 1.0f, 1) : vec4(0.05f, 0.08f, 0.25f, 1), on ? 9.f : 0.f, false);
    }
  }
  // the helicopter and its searchlight
  if (heli_.on && heliModel_) {
    r.submitModel(*heliModel_, heli_.pos, glm::rotate(mat4(1), float(heli_.yaw), vec3(0, 1, 0)) * heliFit_, nullptr, true);
    mat4 rot = glm::rotate(mat4(1), float(heli_.rotor), vec3(0, 1, 0)) * glm::scale(mat4(1), vec3(5.6f, 0.02f, 5.6f));
    sh.oriented(r, Shapes::Kind::Cylinder, heli_.pos + dvec3(0, 2.6, 0), rot, vec4(0.1f, 0.1f, 0.1f, 0.35f), 0, false);
    dvec3 g = heli_.sees ? (c_.driving ? c_.drive->pos() : c_.player->pos) : lastSeen_;
    g.y = c_.world->groundHeight(g.x, g.z, g.y + 1);
    sh.beam(r, heli_.pos - dvec3(0, 0.5, 0), g, 7.5, vec4(1.0f, 0.97f, 0.85f, 0.16f), 2.5f);
  }
}

void Police::addPeople(People& p, const dvec3& cam) const {
  int k = p.officer >= 0 ? p.officer : p.kind("skier_black");
  for (const Unit& u : units_) {
    if (!u.out || glm::length(u.off - cam) > 200) continue;
    Person q;
    q.kind = k; q.pos = u.off; q.yaw = u.offYaw;
    q.anim = u.offState == 3 ? PAnim::Run : u.offState == 2 ? PAnim::Idle : PAnim::Walk;
    q.phase = u.offT * (u.offState == 3 ? 1.6 : 1.1);
    p.add(q);
  }
  // the desk officer and the guard inside the prison
  if (rooms_.prisonExported()) {
    // (prison.js: the guard is the plain black-suited figure, makeRig('skier_black'))
    Person q; q.kind = p.kind("skier_black") >= 0 ? p.kind("skier_black") : k; q.anim = PAnim::Idle; q.phase = c_.now;
    if (rooms_.prisonGuard(q.pos, q.yaw)) p.add(q);
  } else if (rooms_.room() == Interiors::Room::Prison) {
    Person q; q.kind = k; q.pos = rooms_.toWorld(13 - 5.8, 0, -1.6 - 0.8); q.yaw = 0; q.anim = PAnim::Idle; q.phase = c_.now; p.add(q);
    Person g = q; g.pos = rooms_.toWorld(7.4 - 5.8, 0, 2.0 - 0.8); g.yaw = PI; p.add(g);
  }
}

bool Police::interact(std::string& prompt, bool pressed) {
  if (rooms_.prisonExported()) {
    // prison.js frame(): the way out (a visitor), your cell's door
    const int t = rooms_.prisonTarget(camPos_, camDir_);
    if (t == 1 && !jailed()) { prompt = "Leave the prison"; if (pressed) rooms_.leave(); return true; }
    if (t == 2) { prompt = "Cell door \xC2\xB7 locked"; if (pressed) c_.flash("Locked \xC2\xB7 " + mmss(jailLeft_) + " to go", 1); return true; }
    return false;
  }
  if (rooms_.room() == Interiors::Room::Prison) {
    if (jailed()) return false;
    if (rooms_.atExit(c_.player->pos)) { prompt = "Leave the police station"; if (pressed) rooms_.leave(); return true; }
    return false;
  }
  if (!c_.data || !c_.data->prison.ok || rooms_.inside() || wanted_ || entering_) return false;
  if (c_.data->prisonDef.ok && c_.data->prisonDef.hasOutside) {
    // prison.js interaction(): within 2.6 m of the spot in front of the door
    const PrisonDef& D = c_.data->prisonDef;
    if (std::hypot(c_.player->pos.x - D.doorX, c_.player->pos.z - D.doorZ) >= 2.6) return false;
    prompt = "Visit the prison";
    if (pressed) {
      nlohmann::json& r = c_.save->data("policeRecord");
      r["visits"] = r.value("visits", 0) + 1;
      c_.save->markDirty();
      visiting_ = true;
      enterStation(false);
    }
    return true;
  }
  const Site& P = c_.data->prison;
  dvec3 door(P.x + (P.ex - P.x) * 0.55, 0, P.z + (P.ez - P.z) * 0.55);
  if (std::hypot(c_.player->pos.x - door.x, c_.player->pos.z - door.z) < 4.5) {
    prompt = "Polizei \xC2\xB7 visit the prison";
    if (pressed) {
      nlohmann::json& r = c_.save->data("policeRecord");
      r["visits"] = r.value("visits", 0) + 1;
      c_.save->markDirty();
      visiting_ = true;
      if (c_.fade) c_.fade();
      dvec3 out(door.x + (P.ex - P.x) * 0.15, 0, door.z + (P.ez - P.z) * 0.15);
      double h = std::atan2(P.ex - P.x, P.ez - P.z);
      rooms_.enter(Interiors::Room::Prison, [this, out, h]() { visiting_ = false; if (c_.fade) c_.fade(); c_.teleport(out.x, out.z, h, false); });
    }
    return true;
  }
  return false;
}

void Police::jail(double seconds, const std::string& reason) {
  jailLeft_ = jailTotal_ = std::clamp(seconds, 1.0, 300.0);
  jailReason_ = reason;
  if (c_.data->prisonDef.ok && c_.data->prisonDef.hasOutside) {
    if (rooms_.inside()) rooms_.leave();   // (a visit when the sentence came)
    enterStation(true);
    nlohmann::json& r = c_.save->data("policeRecord");
    r["longest"] = std::max(r.value("longest", 0.0), seconds);
    c_.save->data("jail") = {{"left", seconds}, {"reason", reason}};
    c_.save->markDirty();
    if (c_.onJail) c_.onJail(seconds, reason, !c_.driving);   // (Phase 6: the server's sentence, your passengers too)
    SL_INFO("prison: %.0f s (%s)", seconds, reason.c_str());
    return;
  }
  if (c_.fade) c_.fade();
  const Site& P = c_.data->prison;
  dvec3 out(P.x + (P.ex - P.x) * 0.7, 0, P.z + (P.ez - P.z) * 0.7);
  double h = std::atan2(P.ex - P.x, P.ez - P.z);
  rooms_.enter(Interiors::Room::Prison, [this, out, h]() {
    if (c_.fade) c_.fade();
    c_.teleport(out.x, out.z, h, false);
    c_.flash("Released \xC2\xB7 behave yourself", 0);
  });
  // in the middle cell, behind the bars
  dvec3 cell = rooms_.toWorld(0 - 5.8, 0, -2.2 - 0.8);
  c_.player->teleport(cell.x, cell.z, 0);
  c_.player->pos.y = rooms_.toWorld(0, 0, 0).y;
  c_.player->prevPos = c_.player->renderPos = c_.player->pos;
  nlohmann::json& r = c_.save->data("policeRecord");
  r["longest"] = std::max(r.value("longest", 0.0), seconds);
  c_.save->data("jail") = {{"left", seconds}, {"reason", reason}};
  c_.save->markDirty();
  if (c_.onJail) c_.onJail(seconds, reason, !c_.driving);   // (Phase 6: the server's sentence, your passengers too)
  SL_INFO("prison: %.0f s (%s)", seconds, reason.c_str());
}

// prison.js toCell() / visit(): into the station's own scene behind a fade: a prisoner in the middle cell, a visitor in
// at the front door. On the way the world is photographed for its windows (the web game's live view: the cell block
// and the office carried onto the house outdoors, Prison.buildOutside), one frame for each wall with glass.
void Police::enterStation(bool jailed) {
  const PrisonDef& D = c_.data->prisonDef;
  entering_ = true;
  if (c_.fade) c_.fade();
  c_.player->vel = dvec3(0);
  std::vector<WindowView::Shot> shots;
  std::vector<WindowView::Pane> panes;
  struct Group { bool office; vec3 out; dvec3 sum{0}; int n = 0; int shot = -1; };
  std::vector<Group> groups;
  for (const RoomDef::Pane& p : D.panes) {
    const vec3 nIn = glm::normalize(vec3(p.m * vec4(0, 0, 1, 0)));
    const vec3 out = std::fabs(nIn.x) > std::fabs(nIn.z) ? vec3(nIn.x > 0 ? -1.f : 1.f, 0, 0) : vec3(0, 0, nIn.z > 0 ? -1.f : 1.f);
    const bool office = p.m[3].x >= float(D.frontX0);
    size_t g = 0;
    for (; g < groups.size(); g++) if (groups[g].office == office && glm::dot(groups[g].out, out) > 0.9f) break;
    if (g == groups.size()) groups.push_back({office, out});
    groups[g].sum += dvec3(vec3(p.m[3])); groups[g].n++;
    panes.push_back({p.m, p.w, p.h, int(g)});
  }
  for (Group& g : groups) {
    // (from 2.5 m inside the glass, at eye height, looking out)
    WindowView::Shot s;
    const dvec3 c = g.sum / double(g.n) - dvec3(g.out) * 2.5;
    s.local = g.out; s.eyeLocal = vec3(float(c.x), float(D.eye), float(c.z));
    const glm::dmat4& F = g.office ? D.officeFrame : D.cellsFrame;
    s.eye = dvec3(F * glm::dvec4(c.x, D.eye, c.z, 1));
    s.dir = glm::normalize(dvec3(F * glm::dvec4(g.out.x, 0, g.out.z, 0)));
    s.halfAngle = 60; s.nearZ = 0.4f; s.depth = 14; s.gain = 0.6f;
    shots.push_back(s);
  }
  win_.begin(std::move(shots), std::move(panes), [this, jailed] {
    entering_ = false;
    const PrisonDef& P = c_.data->prisonDef;
    rooms_.setPrisonRole(jailed, 1);
    rooms_.enter(Interiors::Room::Prison, [this, jailed, &P]() {
      // prison.js outside(): out of the door into the village
      visiting_ = false;
      win_.clear();
      if (c_.fade) c_.fade();
      c_.teleport(P.doorX, P.doorZ, P.doorYaw, false);
      if (jailed) c_.flash("Released", 0);
    });
    if (jailed) c_.flash("In prison \xC2\xB7 " + mmss(jailLeft_) + " \xC2\xB7 " + jailReason_, 1);
  });
}

std::string Police::objective() const {
  if (jailLeft_ > 0) return "In prison \xC2\xB7 " + mmss(jailLeft_) + " \xC2\xB7 " + jailReason_;
  if (rooms_.room() == Interiors::Room::Prison) return "Visiting the prison \xC2\xB7 the way out: the front door past the counter";
  if (!wanted_) return "";
  if (pulled_) return "Pulled over \xC2\xB7 wait for the officer";
  if (!fleeing_) return "The police are coming \xC2\xB7 stop to pay the fine";
  return "";
}

std::string Police::status() const {
  if (arrestT_ >= 0) return "arrested";
  if (jailLeft_ > 0) return "jail " + mmss(jailLeft_);
  if (!wanted_) return "clear";
  return std::string(fleeing_ ? "fleeing" : pulled_ ? "pulled over" : "called") + " " + std::to_string(stars()) + "*" + (searching_ ? " searching" : "");
}

std::vector<Police::MapMark> Police::mapMarks() const {
  std::vector<MapMark> out;
  if (wanted_) for (const Unit& u : units_) if (!u.leaving) out.push_back({u.pos.x, u.pos.z, false, false});
  if (heli_.on) out.push_back({heli_.pos.x, heli_.pos.z, true, heli_.sees});
  return out;
}

void Police::hud(Ui& ui, float) {
  // the wanted level going up (police.js: the stars slam in with what it brings)
  if (wanted_ && stars() > prevStars_) {
    prevStars_ = stars();
    if (prevStars_ == 3) slam("\xE2\x98\x85\xE2\x98\x85\xE2\x98\x85", "MORE UNITS \xC2\xB7 ROADBLOCKS", 0);
    else if (prevStars_ == 4) slam("\xE2\x98\x85\xE2\x98\x85\xE2\x98\x85\xE2\x98\x85", "HELICOPTER \xC2\xB7 SPIKE STRIPS", 0);
    else if (prevStars_ == 5) slam("\xE2\x98\x85\xE2\x98\x85\xE2\x98\x85\xE2\x98\x85\xE2\x98\x85", "MAXIMUM RESPONSE", 0);
  }
  if (!wanted_) prevStars_ = 0;
  if (c_.now - slamAt_ < 1.7 && arrestT_ < 0) drawPoliceSlam(ui, slamText_, slamSub_, c_.now - slamAt_, slamK_);
  if (wanted_) {
    // the WANTED box (police.js hudFrame / setHud)
    const Level& L = LEVELS[stars()];
    PoliceHudState H;
    H.now = c_.now; H.shownFor = wantedT_;
    H.t = mmss(wantedT_);
    H.stars = stars();
    for (const Unit& q : units_) H.cars += !q.leaving;
    H.air = heli_.on;
    H.heli = !heli_.on ? "" : heli_.sees ? "Police helicopter is tracking you" : heli_.hideT > 0 ? "The helicopter lost you" : "Police helicopter on its way";
    H.heliCls = !heli_.on || heli_.sees ? "" : heli_.hideT > 0 ? "lost" : "come";
    if (!radio_.empty() && c_.now - radioT_ < 5.2) { H.radio = radio_; H.radioAge = c_.now - radioT_; }
    const nlohmann::json& rec = c_.save->data("policeRecord");
    const std::string fine = fmtMoney(int(FINE + FINE_STEP * (rec.value("fines", 0) + rec.value("arrests", 0))));
    const bool foot = !c_.driving;
    bool officer = false;
    for (const Unit& q : units_) officer = officer || q.offState == 3;
    if (fineOpen_) { H.msg = "Press " + c_.K(Action::Interact) + " to pay the " + fine + " fine"; H.tip = std::string(foot ? "Run" : "Drive") + " off instead and it's a chase \xC2\xB7 jail if caught."; H.state = "PULLED OVER"; }
    else if (officer) { H.msg = "An officer is running after you!"; H.tip = "Outrun him, or he arrests you."; H.state = "FOOT CHASE"; H.hot = true; }
    else if (searching_) { H.msg = "They lost you \xC2\xB7 stay out of sight"; H.tip = "Stay hidden until the bar fills to escape."; H.state = "SEARCHING"; H.stateCls = "lost"; }
    else if (fleeing_) {
      bool seen = seenT_ > 0 && unseenT_ <= 0;
      H.msg = seen ? "You're fleeing \xC2\xB7 escape or you'll be arrested" : "Out of sight \xC2\xB7 keep going";
      H.tip = seen ? (heli_.on && heli_.sees ? "Lose the helicopter: a tunnel, a bridge, buildings or thick forest." : "Break their line of sight to escape.") : "Stay hidden until the bar fills to escape.";
      H.state = "PURSUIT"; H.stateCls = "hot"; H.hot = true;
    } else if (pulled_) { H.msg = std::string(foot ? "Stopped" : "Pulled over") + " \xE2\x9C\x93 \xC2\xB7 wait for the officer"; H.tip = "Stay put: it's just a " + fine + " fine."; H.state = "PULL OVER"; }
    else {
      H.msg = std::string("Police \xC2\xB7 ") + (foot ? "stay where you are" : "pull over");
      H.tip = foot ? "Stand still and wait for the officer.\nStay put and you only pay the " + fine + " fine.\nRun off and they'll chase you \xC2\xB7 jail if caught."
                   : "Pull over at the side of the road and stop.\nStay put and you only pay the " + fine + " fine.\nDrive off and they'll chase you \xC2\xB7 jail if caught.";
      H.state = "PULL OVER";
    }
    H.search = searching_; H.gain = searching_;
    if ((fleeing_ || searching_) && !fineOpen_) { H.esc = mmss(escT_); H.escOf = "/ " + mmss(L.escS) + " \xC2\xB7 out of sight"; H.frac = L.escS > 0 ? escT_ / L.escS : 0; }
    double nearest = 1e9;
    for (auto& q : units_) nearest = std::min(nearest, glm::length(q.pos - c_.player->pos));
    if (nearest > 1e8) H.near = "NO POLICE NEAR";
    else H.near = std::string(searching_ ? "LOST YOU" : unseenT_ <= 0 ? "SEEN" : "OUT OF SIGHT") + " \xC2\xB7 " + std::to_string(int(std::lround(nearest / 5)) * 5) + " M";
    drawPoliceHud(ui, H);
  }
  // the ARRESTED moment (police.js bustedBanner)
  if (arrestT_ >= 0) drawBusted(ui, "ARRESTED", "You were " + arrestHow_, arrestT_);
}

// ---------------------------------------------------------------- getting hit (vehiclehits.js), hitting people (peoplehits.js)
void Police::vehicleHits(double dt, const std::vector<Obb>& buses) {
  Player& pl = *c_.player;
  if (c_.driving || c_.riding || rooms_.inside() || pl.mode == PlayerMode::Sit || pl.mode == PlayerMode::Fall || c_.now < safeUntil_) {
    busPrev_.clear();
    for (auto& b : buses) busPrev_.push_back(dvec2(b.x, b.z));
    return;
  }
  struct V { Obb box; double vx, vz; const char* what; bool calm; };
  std::vector<V> vs;
  for (const auto& c : c_.traffic->list) {
    if (c.mode == Traffic::Car::Mode::Gone || c.mode == Traffic::Car::Mode::Parked) continue;
    if (std::hypot(c.x - pl.pos.x, c.z - pl.pos.z) > 15) continue;
    vs.push_back({{c.x, c.z, c.yaw, c.w / 2, c.l / 2}, std::sin(c.yaw) * c.v + c.kvx, std::cos(c.yaw) * c.v + c.kvz, "car", false});
  }
  for (size_t i = 0; i < buses.size(); i++) {
    const Obb& b = buses[i];
    if (std::hypot(b.x - pl.pos.x, b.z - pl.pos.z) > 15) continue;
    dvec2 v = i < busPrev_.size() && dt > 0 ? (dvec2(b.x, b.z) - busPrev_[i]) / dt : dvec2(0);
    if (glm::length(v) > 70) v = dvec2(0);
    vs.push_back({b, v.x, v.y, "bus", false});
  }
  busPrev_.clear();
  for (auto& b : buses) busPrev_.push_back(dvec2(b.x, b.z));
  for (const Unit& u : units_) {
    if (std::hypot(u.pos.x - pl.pos.x, u.pos.z - pl.pos.z) > 15) continue;
    vs.push_back({{u.pos.x, u.pos.z, u.yaw, 0.97, LEN / 2}, std::sin(u.yaw) * u.v, std::cos(u.yaw) * u.v, "police car", u.v < 3 || arrestT_ >= 0});
  }
  for (const V& v : vs) {
    double nx, nz, pen;
    if (!circleObb(pl.pos.x, pl.pos.z, 0.35 + 0.15, v.box.x, v.box.z, v.box.yaw, v.box.hw, v.box.hd, nx, nz, pen)) continue;
    double closing = std::max(0.0, -(v.vx * nx + v.vz * nz));   // (the vehicle's speed into you)
    if (v.calm || closing < V_MIN) continue;
    // knock: out of the box, thrown along its line and up (peoplehits.js launchFor), a strike from 35, the rescue at 45
    pl.pos.x += nx * (pen + 0.05); pl.pos.z += nz * (pen + 0.05);
    double vs2 = std::hypot(v.vx, v.vz) + 1e-6;
    double tx = v.vx / vs2 * 0.8 + nx * 0.2, tz = v.vz / vs2 * 0.8 + nz * 0.2, tl = std::hypot(tx, tz);
    tx /= tl; tz /= tl;
    double kmh = closing * 3.6;
    double vy = std::sqrt(2 * 9.81 * clamp((kmh - 8) * 0.045, 0, 3.4)), vh = std::min(10.0, 1.2 + closing * 0.36);
    int side = (v.vx / vs2) * nz - (v.vz / vs2) * nx >= 0 ? 1 : -1;
    bool strike = closing >= SOFT;
    pl.knockDown(side, dvec3(tx * std::max(3.0, vh), std::max(1.6, vy), tz * std::max(3.0, vh)), kmh >= 25 ? 1 : kmh >= 15 ? 2 : 0, strike);
    pl.shake(clamp(0.8 + closing / 18, 1, 2.3));
    safeUntil_ = c_.now + SAFE_S;
    hit_.pending = true; hit_.strike = strike; hit_.rescue = closing >= HARD; hit_.kmh = int(std::round(kmh)); hit_.what = v.what;
    SL_INFO("hit by a %s at %.0f km/h (%s)", v.what, kmh, hit_.rescue ? "rescue" : strike ? "strike" : "bump");
    return;
  }
}

void Police::peopleHits(double dt) {
  if (!c_.driving || !c_.folk) return;
  Drive& d = *c_.drive;
  double sp = d.speed();
  if (sp < 8 / 3.6) return;
  c_.folk->near(d.pos(), 6, nearTmp_);
  for (int i : nearTmp_) {
    const dvec3& p = c_.folk->pos(i);
    double nx, nz, pen;
    if (!circleObb(p.x, p.z, PERSON_R, d.pos().x, d.pos().z, d.yaw(), d.halfWidth(), d.halfLen(), nx, nz, pen)) continue;
    dvec2 v = d.vel();
    double kmh = sp * 3.6;
    c_.folk->knock(i, v.x * 0.8 + nx * 2, v.y * 0.8 + nz * 2);
    if (c_.now - fineT_ > 5) {
      fineT_ = c_.now;
      int fine = int(std::round(clamp(12 * kmh, 200, 1500) / 10) * 10);
      c_.charge(fine);
      c_.flash("You knocked somebody over \xC2\xB7 fine " + fmtMoney(fine), 1);
      callFor("a pedestrian was hit", kmh);
    }
  }
  // speeding hard past the police station (its patrol car): they come after you
  if (c_.data && c_.data->prison.ok && !wanted_) {
    const Site& P = c_.data->prison;
    double dd = std::hypot(d.pos().x - P.ex, d.pos().z - P.ez);
    int lim = c_.transport->speedLimitAt(d.pos().x, d.pos().z);
    bool fast = lim != 0 && sp * 3.6 > std::abs(lim) + 40;
    speedT_ = dd < 90 && fast ? speedT_ + dt : 0;
    if (speedT_ > 0.5) { speedT_ = 0; callFor("speeding past the station", TRIGGER_KMH); }
  }
}

} // namespace sl
