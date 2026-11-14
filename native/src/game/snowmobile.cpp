#include "game/snowmobile.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/asset_manager.h"
#include "game/people.h"
#include "game/play_data.h"
#include "player/player.h"
#include "world/scenery.h"
#include "world/transport.h"
#include "world/world.h"

namespace sl {

namespace {
// snowmobile.js SLED
constexpr double LEN = 2.9, VMAX = 35, VBOOST = 40, VBACK = 4.5, ACC = 14, BRAKE = 13, DRAG = 0.0028, ROLL = 0.35;
constexpr double MU = 1.3, MU_ICE = 0.62, GRIP = 8, GRIP_ICE = 2.4, TURN = 1.7, CRASH = 12.5, G = 9.81;
const dvec3 SEAT(0, 0.74, -0.32);
}

void Snowmobiles::load(AssetManager& assets) {
  ModelLoadOptions o;
  o.maxTextureSize = 512;
  model_ = assets.model("snowmobile", o);
  if (model_) {
    vec3 sz = model_->bmax - model_->bmin;
    // (fitted along its long side, nose +z)
    // (its nose is at -z in the GLB: turned round)
    fit_ = glm::rotate(mat4(1), float(PI), vec3(0, 1, 0)) * (sz.x > sz.z ? glm::rotate(mat4(1), float(-PI / 2), vec3(0, 1, 0)) * model_->fitTransform(float(LEN), 0) : model_->fitTransform(float(LEN), 2));
  }
}

void Snowmobiles::place() {
  sleds_.clear();
  std::vector<dvec2> cands = {{30, -40}, {-46, 26}, {54, -12}, {-22, -50}, {42, 44}, {-60, -20}};
  if (c_.data) {
    for (const JobDest& d : c_.data->dests) if (d.kind == "hut") cands.push_back(dvec2(d.x + 11, d.z + 7));
    for (const RouterLift& l : c_.data->routerLifts) cands.push_back(dvec2(l.bottomExit.x + 9, l.bottomExit.y - 6));
  }
  int village = 0;
  for (const dvec2& p : cands) {
    if (sleds_.size() >= 15) break;
    bool inVillage = std::hypot(p.x, p.y) < 120;
    if (inVillage && village >= 5) continue;
    bool clear = true;
    for (const Sled& s : sleds_) clear = clear && std::hypot(s.pos.x - p.x, s.pos.z - p.y) > 40;
    if (const std::vector<int>* near = c_.scenery->collidersNear(p.x, p.y))
      for (int ci : *near) { const Collider& c = c_.scenery->colliders()[size_t(ci)]; if (std::hypot(c.x - p.x, c.z - p.y) < (c.r >= 0 ? c.r : std::max(c.hw, c.hd)) + 3) clear = false; }
    if (c_.transport && c_.transport->laneDistance(p.x, p.y) < 6) clear = false;
    if (!clear) continue;
    Sled s;
    s.pos = dvec3(p.x, c_.world->groundHeight(p.x, p.y), p.y);
    s.yaw = std::atan2(-p.x, -p.y) + 0.4;
    sleds_.push_back(s);
    village += inVillage;
  }
  SL_INFO("snowmobiles: %zu parked (%d in the village)", sleds_.size(), village);
}

bool Snowmobiles::interact(std::string& prompt, bool pressed) {
  if (cur_ >= 0) return false;
  const dvec3& p = c_.player->pos;
  for (size_t i = 0; i < sleds_.size(); i++) {
    const Sled& s = sleds_[i];
    if (std::hypot(p.x - s.pos.x, p.z - s.pos.z) > 2.6 || std::fabs(p.y - s.pos.y) > 3) continue;
    prompt = "Ride the snowmobile";
    if (pressed) {
      cur_ = int(i);
      c_.player->setSkisOn(false);
      dvec3 sp, sf;
      seat(sp, sf);
      c_.player->sitOn(sp, sf);
      camReady_ = false;
      c_.flash("Snowmobile \xC2\xB7 " + c_.K(Action::Forward) + " throttle \xC2\xB7 " + c_.K(Action::Sprint) + " boost \xC2\xB7 " + c_.K(Action::Interact) + " get off (stopped)", 0);
    }
    return true;
  }
  return false;
}

void Snowmobiles::seat(dvec3& pos, dvec3& fwd) const {
  if (cur_ < 0) return;
  const Sled& s = sleds_[size_t(cur_)];
  double c = std::cos(s.yaw), sn = std::sin(s.yaw);
  pos = s.pos + dvec3(SEAT.x * c + SEAT.z * sn, SEAT.y + s.bounce, -SEAT.x * sn + SEAT.z * c);
  fwd = dvec3(sn, 0, c);
}

bool Snowmobiles::getOff() {
  if (cur_ < 0) return false;
  Sled& s = sleds_[size_t(cur_)];
  if (std::fabs(s.v) > 1.2) return false;
  double ox = s.pos.x + std::cos(s.yaw) * 1.4, oz = s.pos.z - std::sin(s.yaw) * 1.4;
  c_.player->standUp(ox, oz, s.yaw);
  s.v = s.vs = 0;
  cur_ = -1;
  return true;
}

bool Snowmobiles::update(double dt, const In& in) {
  if (cur_ < 0) return false;
  Sled& s = sleds_[size_t(cur_)];
  World& W = *c_.world;
  int n = std::max(1, int(std::ceil(dt * 120)));
  double h = dt / n;
  for (int k = 0; k < n; k++) {
    double fx = std::sin(s.yaw), fz = std::cos(s.yaw), rx = std::cos(s.yaw), rz = -std::sin(s.yaw);
    double y0 = W.groundHeight(s.pos.x, s.pos.z, s.pos.y + 1);
    double grade = W.groundHeight(s.pos.x + fx, s.pos.z + fz, s.pos.y + 1.5) - y0;
    double side = W.groundHeight(s.pos.x + rx, s.pos.z + rz, s.pos.y + 1.5) - y0;
    CorridorHit ch = W.corridorAt(s.pos.x, s.pos.z);
    bool ice = ch.any && ch.groomed;
    double cosA = 1 / std::sqrt(1 + grade * grade), mu = (ice ? MU_ICE : MU) * G * cosA;
    double vmax = in.boost ? VBOOST : VMAX;
    // the drive force, limited by traction; gravity down the grade
    double drive = in.throttle > 0 ? (s.v < vmax ? ACC * in.throttle : 0) : in.brake > 0 ? (s.v > 0.5 ? -BRAKE * in.brake : s.v > -VBACK ? -ACC * 0.4 * in.brake : 0) : 0;
    drive = clamp(drive, -mu, mu);
    double grav = -G * grade * cosA;
    double res = DRAG * s.v * std::fabs(s.v) + (in.throttle <= 0 ? ROLL * sign(s.v) : 0) + (in.handbrake ? 6 * sign(s.v) : 0);
    if (!s.air) {
      s.v += (drive + grav - res) * h;
      // sideways: the side slope pulls, the tracks' grip kills the slide (ice: less)
      s.vs += -G * side * cosA * h * 0.6;
      s.vs *= std::exp(-(ice ? GRIP_ICE : GRIP) * h);
      double turn = TURN * clamp(std::fabs(s.v) / 3, 0, 1) / (1 + std::fabs(s.v) / 25) * sign(s.v);
      s.yaw += in.steer * turn * h;
      if (std::fabs(in.steer) > 0.3 && std::fabs(s.v) > 15) s.vs += -in.steer * std::fabs(s.v) * 0.02 * h * (ice ? 3 : 1);
    }
    dvec3 np = s.pos + dvec3(fx * s.v + rx * s.vs, 0, fz * s.v + rz * s.vs) * h;
    double gy = W.groundHeight(np.x, np.z, s.pos.y + 1);
    // little jumps over crests
    if (s.air) { s.vy -= G * h; np.y = s.pos.y + s.vy * h; if (np.y <= gy) { np.y = gy; s.air = false; s.bounce = -std::min(0.15, -s.vy * 0.02); } }
    else if (gy < s.pos.y - std::max(0.3, std::fabs(s.v) * h * 1.2) && std::fabs(s.v) > 12) { s.air = true; s.vy = (s.pos.y - gy) / h * 0.0 + grade * s.v * 0.5; np.y = s.pos.y; }
    else np.y = gy;
    // snowmobile.js collide: soft bumps off trees, rocks, buildings, towers, nets, the traffic, parked cars, buses,
    // trains, patrol cars and parked sleds (the dynamic colliders) and people; a hard hit at speed throws you off.
    // Two circles along the sled (0.95 m ahead, 0.85 m behind its middle, 0.72 m each).
    double px = 0, pz = 0, hard = 0;
    int nHit = 0;
    bool soft = false;
    const double vx = fx * s.v + rx * s.vs, vz = fz * s.v + rz * s.vs;
    auto hit = [&](double hx, double hz, double over, bool isSoft) {
      px += hx * over; pz += hz * over; nHit++;
      const double vn = vx * hx + vz * hz;
      if (vn < 0) { if (!isSoft && -vn >= hard) hard = -vn; soft = soft || isSoft; }
    };
    for (double k : {0.95, -0.85}) {
      const double cx = np.x + fx * k, cz = np.z + fz * k, PR = 0.72;
      if (const Tree* t = c_.scenery->treeAt(cx, cz, PR, true)) {   // (the whole tree: its branches too)
        double dx = cx - t->x, dz = cz - t->z, l = std::hypot(dx, dz);
        if (l < 1e-6) { dx = 1; dz = 0; l = 1; }
        hit(dx / l, dz / l, std::max(0.0, PR + double(t->crown) - l), false);
      }
      if (const Rock* q = c_.scenery->rockAt(cx, cz, PR, 0)) {
        double dx = cx - q->x, dz = cz - q->z, l = std::hypot(dx, dz);
        if (l < 1e-6) { dx = 1; dz = 0; l = 1; }
        if (double(q->y) + 0.75 * double(q->s) > np.y + 0.45) hit(dx / l, dz / l, std::max(0.0, PR + double(q->r) - l), false);
      }
      auto test = [&](const Collider& c, bool solid) {
        if (c.downUntil > c_.now) return;
        if (c.top < np.y + 0.45) return;   // (low solid props: a kerb, a step, paving over the snow: driven over)
        const bool isSoft = c.soft && !solid;
        if (c.r >= 0) {
          const double dx = cx - c.x, dz = cz - c.z, l = std::hypot(dx, dz);
          if (l < c.r + PR) hit(l > 1e-3 ? dx / l : 1, l > 1e-3 ? dz / l : 0, c.r + PR - l, isSoft);
        } else {
          const double cs = std::cos(-c.rot), sn = std::sin(-c.rot);
          const double lx = (cx - c.x) * cs - (cz - c.z) * sn, lz = (cx - c.x) * sn + (cz - c.z) * cs;
          const double ox = c.hw + PR - std::fabs(lx), oz = c.hd + PR - std::fabs(lz);
          if (ox > 0 && oz > 0) {
            double nlx = 0, nlz = 0;
            if (ox < oz) nlx = lx >= 0 ? 1 : -1; else nlz = lz >= 0 ? 1 : -1;
            const double c2 = std::cos(c.rot), s2 = std::sin(c.rot);
            hit(nlx * c2 - nlz * s2, nlx * s2 + nlz * c2, std::min(ox, oz), isSoft);
          }
        }
      };
      if (const std::vector<int>* near = c_.scenery->collidersNear(cx, cz))
        for (int ci : *near) test(c_.scenery->colliders()[size_t(ci)], false);
      // (the moving things: cars, buses, trains, patrol cars, the other sleds. A vehicle's box is `soft` for you on
      // foot; to a sled its body is solid)
      for (const Collider& c : c_.scenery->dynamic) {
        const double size = c.r >= 0 ? c.r : std::max(c.hw, c.hd);
        if (std::fabs(c.x - cx) > size + PR + 0.5 || std::fabs(c.z - cz) > size + PR + 0.5) continue;
        test(c, c.r < 0 && c.hd > 1.2);
      }
    }
    // people (the villagers): the sled bumps off them; a hit knocks them over (peoplehits.js)
    if (c_.folk) {
      std::vector<int> folk;
      c_.folk->near(np, 3, folk);
      for (int i : folk) {
        if (c_.folk->down(i)) continue;
        const dvec3& q = c_.folk->pos(i);
        if (std::fabs(q.y - np.y) > 2.5) continue;
        for (double k : {0.95, -0.85}) {
          const double cx = np.x + fx * k, cz = np.z + fz * k, dx = cx - q.x, dz = cz - q.z, l = std::hypot(dx, dz), rr = 0.72 + 0.4;
          if (l >= rr || l < 1e-3) continue;
          const double hx = dx / l, hz = dz / l, closing = -(vx * hx + vz * hz), sp = std::hypot(vx, vz);
          if (closing > 0.5) c_.folk->knock(i, (sp > 1 ? vx / sp : -hx) * closing, (sp > 1 ? vz / sp : -hz) * closing);
          hit(hx, hz, rr - l, true);
          break;
        }
      }
    }
    double into = 0;
    if (nHit) {
      const double l0 = std::hypot(px, pz), l = l0 > 0 ? l0 : 1, hx = px / l, hz = pz / l;
      np.x += px; np.z += pz;
      if (hard > CRASH && !soft) into = hard;
      else {
        const double vn = vx * hx + vz * hz;
        if (vn < 0) {
          // a soft bounce back, some speed lost
          double wx = vx - hx * vn * 1.3, wz = vz - hz * vn * 1.3;
          const double loss = std::max(0.5, 1 - (-vn) * 0.04);
          wx *= loss; wz *= loss;
          s.v = wx * fx + wz * fz; s.vs = wx * rx + wz * rz;
          s.bounce -= std::min(0.06, -vn * 0.01);
        }
      }
    }
    s.pos = np;
    s.bounce *= std::exp(-h * 6);
    if (into > CRASH) {
      // thrown off over the bars (a wipeout like on skis)
      double sp = s.v;
      s.v = s.vs = 0;
      cur_ = -1;
      c_.player->standUp(s.pos.x, s.pos.z, s.yaw);
      c_.player->knockDown(1, dvec3(fx * sp * 0.6, 3, fz * sp * 0.6), 1, true);
      return true;
    }
  }
  return false;
}

void Snowmobiles::camera(Camera& cam, double dt) {
  if (cur_ < 0) return;
  const Sled& s = sleds_[size_t(cur_)];
  dvec3 focus = s.pos + dvec3(0, 1.4, 0);
  dvec3 want = focus - dvec3(std::sin(s.yaw), 0, std::cos(s.yaw)) * (6.5 + std::fabs(s.v) * 0.08) + dvec3(0, 2.0, 0);
  want.y = std::max(want.y, c_.world->groundHeight(want.x, want.z, s.pos.y + 3) + 1.2);
  if (!camReady_) { camPos_ = want; camReady_ = true; }
  camPos_ += (want - camPos_) * (1 - std::exp(-dt * 6));
  cam.lookAt(camPos_, focus);
  cam.fovY = float(62 + std::fabs(s.v) * 0.25);
  cam.nearZ = 0.1f;
}

void Snowmobiles::addDraw(VehicleDraw& vd, const dvec3& cam) const {
  if (!model_) return;
  for (const Sled& s : sleds_) {
    double d = glm::length(s.pos - cam);
    if (d > 380) continue;
    glm::dmat4 M = glm::translate(glm::dmat4(1), s.pos + dvec3(0, s.bounce, 0)) * glm::rotate(glm::dmat4(1), s.yaw, dvec3(0, 1, 0)) * glm::dmat4(fit_);
    vd.add(model_.get(), M, d > 60 ? 1 : 0);
  }
}

void Snowmobiles::fillColliders(std::vector<Collider>& out) const {
  for (size_t i = 0; i < sleds_.size(); i++) {
    if (int(i) == cur_) continue;
    const Sled& s = sleds_[i];
    if (glm::length(s.pos - c_.player->pos) > 30) continue;
    Collider c;
    c.x = s.pos.x; c.z = s.pos.z; c.hw = 0.55; c.hd = LEN / 2; c.rot = -s.yaw; c.top = s.pos.y + 1.1;
    out.push_back(c);
  }
}

} // namespace sl
