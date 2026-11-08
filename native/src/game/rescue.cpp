#include "game/rescue.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/economy.h"
#include "game/play_data.h"
#include "game/shapes.h"
#include "player/player.h"
#include "world/transport.h"
#include "world/world.h"

namespace sl {

namespace {
constexpr double FLY_V = 52, HOVER = 12, ROPE_DOWN = 2.6, ROPE_UP = 4.2, AMB_V = 24, STAY_S = 8, STUCK = 45, CRUISE = 45;
}

Rescue::Rescue(PlayCtx& c, Interiors& rooms) : c_(c), rooms_(rooms) {}

void Rescue::load(AssetManager& assets) {
  ModelLoadOptions o;
  o.maxTextureSize = 512;
  heli_ = assets.model("heli_body", o);
  if (heli_) heliFit_ = heli_->fitTransform(11.5f, 3, true);
  amb_ = assets.model("ambulance", o);
  if (amb_) ambFit_ = amb_->fitTransform(5.9f, 2);
}

void Rescue::start() {
  if (stage_ != Stage::None) return;
  down_ = c_.player->pos;
  dvec2 pad = c_.data ? c_.data->helipad : dvec2(92, -128);
  // from its pad, or already on its way when you are far out (rescue.js FAR / START_D)
  dvec2 d(down_.x - pad.x, down_.z - pad.y);
  double L = glm::length(d);
  dvec2 from = L > 1500 ? dvec2(down_.x, down_.z) - d / L * 800.0 : pad;
  heliPos_ = dvec3(from.x, c_.world->height(from.x, from.y) + (L > 1500 ? CRUISE : 2), from.y);
  heliVel_ = dvec3(0);
  heliYaw_ = std::atan2(d.x, d.y);
  stage_ = Stage::Wait; t_ = 0; stuckT_ = 0; bestD_ = 1e18;
  c_.flash("The rescue helicopter is on its way", 1);
  SL_INFO("rescue: called at (%.0f, %.0f), %.0f m from the pad", down_.x, down_.z, L);
}

void Rescue::toHospital() {
  fee_ = c_.save->rescueFee();
  c_.charge(fee_);
  c_.save->rescues++;
  c_.save->markDirty();
  if (c_.fade) c_.fade();
  // you come round in a hospital bed (hospitalroom.js admit)
  const Site H = c_.data ? c_.data->hospital : Site{};
  double ox = H.ok ? H.ex : 4, oz = H.ok ? H.ez : 34, h = H.ok ? std::atan2(H.ex - H.x, H.ez - H.z) : 0;
  rooms_.enter(Interiors::Room::Hospital, [this, ox, oz, h]() { stage_ = Stage::None; if (c_.fade) c_.fade(); c_.teleport(ox, oz, h, false); c_.flash("Treated and released \xC2\xB7 take it easy", 0); });
  stage_ = Stage::Bed; bedT_ = 0;
  c_.flash("Mountain rescue \xC2\xB7 treated at the medical centre \xC2\xB7 -" + fmtMoney(fee_), 1);
}

void Rescue::update(double dt, bool fast) {
  if (stage_ == Stage::None || stage_ == Stage::Visit) return;
  double k = fast ? 4 : 1;
  t_ += dt;
  rotor_ += dt * 40;
  Player& pl = *c_.player;
  auto fly = [&](const dvec3& goal, double vmax) {
    dvec3 dv = goal - heliPos_;
    double dl = glm::length(dv);
    dvec3 want = dl > 0.5 ? dv / dl * std::min(vmax * k, dl * 0.8) : dvec3(0);
    heliVel_ += (want - heliVel_) * std::min(1.0, dt * 1.5);
    heliPos_ += heliVel_ * dt;
    if (glm::length(dvec2(heliVel_.x, heliVel_.z)) > 2) heliYaw_ = dampAngle(heliYaw_, std::atan2(heliVel_.x, heliVel_.z), dt * 2);
    return dl;
  };
  auto watchdog = [&](double d) {
    if (d < bestD_ - 2) { bestD_ = d; stuckT_ = 0; } else stuckT_ += dt;
    if (stuckT_ > STUCK) { SL_WARN("rescue: watchdog"); toHospital(); return true; }
    return false;
  };
  if (stage_ == Stage::Wait) {
    // you lie in the snow meanwhile (the player's fall plays out; then held)
    if (pl.mode != PlayerMode::Fall) pl.vel = dvec3(0);
    double gy = c_.world->groundHeight(down_.x, down_.z, down_.y + 2);
    dvec3 over(down_.x, gy + HOVER, down_.z);
    double cruiseY = std::max(gy, c_.world->height(heliPos_.x, heliPos_.z)) + CRUISE;
    double hd = std::hypot(over.x - heliPos_.x, over.z - heliPos_.z);
    dvec3 goal = hd > 150 ? dvec3(over.x, cruiseY, over.z) : over;
    double d = fly(goal, FLY_V);
    if (watchdog(hd)) return;
    if (hd < 4 && std::fabs(heliPos_.y - over.y) < 3) { stage_ = Stage::Winch; ropeT_ = 0; bestD_ = 1e18; }
    (void)d;
  } else if (stage_ == Stage::Winch) {
    ropeT_ += dt * k;
    heliVel_ *= std::exp(-dt * 3);
    if (ropeT_ > ROPE_DOWN + ROPE_UP) {
      stage_ = Stage::Cabin; bestD_ = 1e18; stuckT_ = 0;
      pl.setSkisOn(false);
      dvec3 s, f; seat(s, f);
      pl.sitOn(s, f);
      c_.flash("Aboard \xC2\xB7 flying you home \xC2\xB7 hold " + c_.K(Action::Jump) + " to speed up", 0);
    }
  } else if (stage_ == Stage::Cabin) {
    dvec2 pad = c_.data ? c_.data->helipad : dvec2(92, -128);
    double gy = c_.world->height(pad.x, pad.y);
    double hd = std::hypot(pad.x - heliPos_.x, pad.y - heliPos_.z);
    dvec3 goal(pad.x, hd > 120 ? std::max(gy, c_.world->height(heliPos_.x, heliPos_.z)) + CRUISE : gy + 1.5, pad.y);
    fly(goal, FLY_V);
    if (watchdog(hd + std::fabs(heliPos_.y - goal.y))) return;
    if (hd < 3 && heliPos_.y - gy < 2.5) {
      // the ambulance at the pad: the Rettungsweg (bus/roads.js planHeliRoad) to the medical centre
      stage_ = Stage::Ambulance; bestD_ = 1e18; stuckT_ = 0;
      road_ = -1;
      const Transport& T = *c_.transport;
      for (size_t i = 0; i < T.roads.size(); i++) if (T.roads[i].heli) road_ = int(i);
      if (road_ >= 0) {
        const Road& r = T.roads[size_t(road_)];
        double d0 = std::hypot(r.X[0] - pad.x, r.Z[0] - pad.y), d1 = std::hypot(r.X[size_t(r.n - 1)] - pad.x, r.Z[size_t(r.n - 1)] - pad.y);
        roadDir_ = d0 < d1 ? 1 : -1;
        ambS_ = roadDir_ > 0 ? 0 : r.length;
        roadEnd_ = roadDir_ > 0 ? r.length : 0;
      }
      ambPos_ = dvec3(pad.x + 6, gy, pad.y);
      c_.flash("The ambulance takes you to the medical centre", 0);
    }
  } else if (stage_ == Stage::Ambulance) {
    const Transport& T = *c_.transport;
    const Site H = c_.data ? c_.data->hospital : Site{};
    dvec3 goal(H.ok ? H.ex : 150, 0, H.ok ? H.ez : 110);
    if (road_ >= 0 && (roadDir_ > 0 ? ambS_ < roadEnd_ : ambS_ > roadEnd_)) {
      const Road& r = T.roads[size_t(road_)];
      ambS_ += roadDir_ * AMB_V * k * dt;
      RoadPoint q = roadAt(r, std::clamp(ambS_, 0.0, r.length));
      ambPos_ = dvec3(q.x - q.dz * 1.6 * roadDir_, q.y, q.z + q.dx * 1.6 * roadDir_);
      ambYaw_ = std::atan2(q.dx * roadDir_, q.dz * roadDir_);
    } else {
      double d = std::hypot(goal.x - ambPos_.x, goal.z - ambPos_.z);
      if (d > 3) {
        ambYaw_ = std::atan2(goal.x - ambPos_.x, goal.z - ambPos_.z);
        ambPos_.x += std::sin(ambYaw_) * std::min(d, AMB_V * 0.5 * k * dt); ambPos_.z += std::cos(ambYaw_) * std::min(d, AMB_V * 0.5 * k * dt);
      } else { toHospital(); return; }
      if (watchdog(d)) return;
    }
    ambPos_.y = c_.world->groundHeight(ambPos_.x, ambPos_.z, ambPos_.y + 1.5);
    // the helicopter goes back to sleep on its pad
    heliVel_ = dvec3(0);
  } else if (stage_ == Stage::Bed) {
    bedT_ += dt;
    pl.vel = dvec3(0);
  }
}

bool Rescue::seat(dvec3& pos, dvec3& fwd) const {
  if (stage_ == Stage::Cabin) { pos = heliPos_ + dvec3(0, -0.4, 0); fwd = dvec3(std::sin(heliYaw_), 0, std::cos(heliYaw_)); return true; }
  if (stage_ == Stage::Ambulance) { pos = ambPos_ + dvec3(0, 0.9, 0) - dvec3(std::sin(ambYaw_), 0, std::cos(ambYaw_)) * 1.2; fwd = -dvec3(std::sin(ambYaw_), 0, std::cos(ambYaw_)); return true; }
  return false;
}

void Rescue::camera(Camera& cam) const {
  dvec3 focus = stage_ == Stage::Ambulance ? ambPos_ + dvec3(0, 1.5, 0) : heliPos_;
  double yaw = stage_ == Stage::Ambulance ? ambYaw_ : heliYaw_;
  double dist = stage_ == Stage::Ambulance ? 14 : 24;
  dvec3 eye = focus - dvec3(std::sin(yaw), 0, std::cos(yaw)) * dist + dvec3(0, stage_ == Stage::Ambulance ? 4 : 8, 0);
  eye.y = std::max(eye.y, c_.world->height(eye.x, eye.z) + 2);
  cam.lookAt(eye, focus);
  cam.fovY = 62; cam.nearZ = 0.2f;
}

void Rescue::addDraw(VehicleDraw& vd, const dvec3& cam) const {
  if (!amb_) return;
  dvec3 p = ambPos_;
  double yaw = ambYaw_;
  if (stage_ != Stage::Ambulance) {   // (waiting beside the pad)
    dvec2 pad = c_.data ? c_.data->helipad : dvec2(92, -128);
    p = dvec3(pad.x + 9, 0, pad.y + 3); p.y = c_.world->height(p.x, p.z); yaw = 0.4;
  }
  if (glm::length(p - cam) > 600) return;
  vd.add(amb_.get(), glm::translate(glm::dmat4(1), p) * glm::rotate(glm::dmat4(1), yaw, dvec3(0, 1, 0)) * glm::dmat4(ambFit_), glm::length(p - cam) > 70 ? 1 : 0);
}

void Rescue::draw(Renderer& r, const dvec3& cam) {
  if (!heli_ || rooms_.inside()) return;
  Shapes& sh = *c_.shapes;
  dvec3 p = heliPos_;
  double yaw = heliYaw_;
  if (stage_ == Stage::None || stage_ == Stage::Bed || stage_ == Stage::Visit || stage_ == Stage::Ambulance) {
    if (stage_ != Stage::Ambulance) { dvec2 pad = c_.data ? c_.data->helipad : dvec2(92, -128); p = dvec3(pad.x, c_.world->height(pad.x, pad.y) + 0.1, pad.y); yaw = 0.6; }
  }
  if (glm::length(p - cam) > 2500) return;
  r.submitModel(*heli_, p, glm::rotate(mat4(1), float(yaw), vec3(0, 1, 0)) * heliFit_, nullptr, true);
  bool flying = stage_ == Stage::Wait || stage_ == Stage::Winch || stage_ == Stage::Cabin;
  mat4 rot = glm::rotate(mat4(1), float(flying ? rotor_ : 0.3), vec3(0, 1, 0)) * glm::scale(mat4(1), vec3(5.6f, 0.02f, flying ? 5.6f : 0.25f));
  sh.oriented(r, Shapes::Kind::Cylinder, p + dvec3(0, 2.6, 0), rot, vec4(0.08f, 0.08f, 0.08f, flying ? 0.35f : 1.f), 0, false);
  if (stage_ == Stage::Winch) {
    double f = ropeT_ < ROPE_DOWN ? ropeT_ / ROPE_DOWN : 1 - (ropeT_ - ROPE_DOWN) / ROPE_UP;
    dvec3 top = p - dvec3(0, 0.8, 0), bot = glm::mix(top, down_ + dvec3(0, 1, 0), clamp(f, 0, 1));
    sh.cylinder(r, bot, 0.03, glm::length(top - bot), vec4(0.9f, 0.9f, 0.9f, 1), 0, false);
    if (ropeT_ > ROPE_DOWN) c_.player->pos = glm::mix(down_, top - dvec3(0, 1.6, 0), clamp((ropeT_ - ROPE_DOWN) / ROPE_UP, 0, 1));
  }
  if (stage_ == Stage::Ambulance) {   // its blue lights
    bool a = std::fmod(t_ * 4, 1.0) < 0.5;
    for (int s = -1; s <= 1; s += 2) sh.box(r, ambPos_ + dvec3(std::cos(ambYaw_) * 0.5 * s, 2.75, -std::sin(ambYaw_) * 0.5 * s), ambYaw_, vec3(0.3f, 0.1f, 0.2f), (s < 0) == a ? vec4(0.15f, 0.3f, 1, 1) : vec4(0.05f, 0.08f, 0.25f, 1), (s < 0) == a ? 8.f : 0.f, false);
  }
}

void Rescue::hud(Ui& ui, float u) {
  if (stage_ == Stage::Bed) {
    float H = float(ui.height());
    ui.brushPanel(24 * u, H - 230 * u, 280 * u, 100 * u, ui_color::a(ui_color::paper, 0.94f), 1);
    ui.text(38 * u, H - 222 * u, 15 * u, UiFont::CondBold, ui_color::red, "MEDICAL CENTRE");
    ui.text(38 * u, H - 200 * u, 30 * u, UiFont::CondHeavy, ui_color::blue, bedT_ < STAY_S ? "RECOVERING..." : "FEELING BETTER");
    ui.textFit(38 * u, H - 162 * u, 250 * u, 15 * u, UiFont::Cond, ui_color::navy, bedT_ < STAY_S ? "The bill: " + fmtMoney(fee_) : c_.K(Action::Interact) + " gets you up \xC2\xB7 the front doors lead out");
  }
}

bool Rescue::interact(std::string& prompt, bool pressed) {
  if (rooms_.room() == Interiors::Room::Hospital) {
    if (stage_ == Stage::Bed && bedT_ >= STAY_S && pressed) { stage_ = Stage::Visit; prompt.clear(); return true; }
    if (stage_ == Stage::Bed) { prompt = bedT_ >= STAY_S ? "Get up" : ""; return bedT_ >= STAY_S; }
    if (rooms_.atExit(c_.player->pos)) { prompt = "Leave the medical centre"; if (pressed) rooms_.leave(); return true; }
    return false;
  }
  if (stage_ != Stage::None || rooms_.inside() || !c_.data || !c_.data->hospital.ok) return false;
  const Site& H = c_.data->hospital;
  dvec3 door(H.x + (H.ex - H.x) * 0.6, 0, H.z + (H.ez - H.z) * 0.6);
  if (std::hypot(c_.player->pos.x - door.x, c_.player->pos.z - door.z) < 4.5) {
    prompt = "Medical centre \xC2\xB7 visit the ward";
    if (pressed) visit();
    return true;
  }
  return false;
}

bool Rescue::visit() {
  const Site& H = c_.data->hospital;
  double ox = H.ex, oz = H.ez, h = std::atan2(H.ex - H.x, H.ez - H.z);
  if (c_.fade) c_.fade();
  stage_ = Stage::Visit;
  rooms_.enter(Interiors::Room::Hospital, [this, ox, oz, h]() { stage_ = Stage::None; if (c_.fade) c_.fade(); c_.teleport(ox, oz, h, false); });
  dvec3 sp = rooms_.toWorld(0, 0, 4.4);
  c_.player->teleport(sp.x, sp.z, PI);
  c_.player->pos.y = rooms_.toWorld(0, 0, 0).y;
  return true;
}

std::string Rescue::objective() const {
  if (stage_ == Stage::Wait) return "Stay down \xC2\xB7 the rescue helicopter is coming \xC2\xB7 " + std::to_string(int(std::hypot(heliPos_.x - down_.x, heliPos_.z - down_.z))) + " m";
  if (stage_ == Stage::Cabin) return "Rescue helicopter \xC2\xB7 flying you to Legacy Village";
  if (stage_ == Stage::Ambulance) return "Ambulance \xC2\xB7 to the medical centre";
  return "";
}

} // namespace sl
