// SNOWMOBILES (Phase 5, game/snowmobile.js condensed): fifteen parked round the resort each session (five round Legacy
// Village, the rest at the huts and the lifts' bottom stations, on clear snow, never two within 40 m); E beside one
// rides it (your skis on your back), E at a standstill gets off. SLED's arcade handling: throttle to 35 m/s (Shift: 40),
// brake / reverse, steering that tightens at low speed, traction-limited climbing (it slides back off faces it can't
// grip), side slopes and the groomed pistes' ice let it skid, the snow followed with a little bounce; it bumps off
// trees and colliders, and a hard hit (12.5 m/s straight in) throws you off (a wipeout: the two-strike rule). The
// rider sits on the seat with the handlebar pose (the seated rig, arms forward); the chase camera.
#pragma once
#include "game/play.h"
#include "game/vehicles.h"
#include <memory>
#include <vector>

namespace sl {

class Snowmobiles {
public:
  explicit Snowmobiles(PlayCtx& c) : c_(c) {}
  void load(AssetManager& assets);
  void place();
  bool interact(std::string& prompt, bool pressed);   // E: get on
  bool active() const { return cur_ >= 0; }
  double speed() const { return cur_ >= 0 ? std::fabs(sleds_[size_t(cur_)].v) : 0; }
  struct In { float throttle = 0, brake = 0, steer = 0; bool boost = false, handbrake = false; };
  /// per frame while riding (sub-stepped); true when you were thrown off (a wipeout)
  bool update(double dt, const In& in);
  bool getOff();                                         // E at a standstill
  void seat(dvec3& pos, dvec3& fwd) const;
  void camera(Camera& cam, double dt);
  void addDraw(VehicleDraw& vd, const dvec3& cam) const;
  void fillColliders(std::vector<Collider>& out) const;
  size_t count() const { return sleds_.size(); }
  dvec3 pos(size_t i) const { return sleds_[i].pos; }
  /// (Phase 6) the snowmobile model and its fit, for the other players' sleds
  const Model* model() const { return model_.get(); }
  const mat4& fit() const { return fit_; }
  /// the sled you ride: its pose (presence: x / y / z / yaw are the snowmobile's, flag F.sled)
  bool current(dvec3& p, double& yaw) const { if (cur_ < 0) return false; p = sleds_[size_t(cur_)].pos; yaw = sleds_[size_t(cur_)].yaw; return true; }
private:
  struct Sled { dvec3 pos{0}; double yaw = 0, v = 0, vs = 0, vy = 0, bounce = 0; bool air = false; };
  PlayCtx& c_;
  std::shared_ptr<Model> model_;
  mat4 fit_{1};
  std::vector<Sled> sleds_;
  int cur_ = -1;
  dvec3 camPos_{0};
  bool camReady_ = false;
};

} // namespace sl
