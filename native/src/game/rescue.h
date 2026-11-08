// MOUNTAIN RESCUE (Phase 5, game/heli/rescue.js + heli/ambulance.js + hospitalroom.js, simplified): after the second
// wipeout (or a hard hit by a vehicle) you stay down in the snow and the rescue helicopter comes from its pad (from
// far away it is already on its way), hovers over you and winches you up, flies you home to the pad (hold Space: x4),
// where the ambulance takes over and drives you along the Rettungsweg to the medical centre (blue lights; Space x4);
// the bill (rescue.js rescueFee: $300 +$25 per earlier rescue, at most $1,000, even into the red); you come round in a
// hospital bed (RECOVERING), E gets you up and out through the front doors. A watchdog sends you straight to the
// medical centre if the helicopter or the ambulance stops getting closer.
#pragma once
#include "game/interiors.h"
#include "game/play.h"
#include "game/vehicles.h"
#include <memory>

namespace sl {
class Renderer;

class Rescue {
public:
  Rescue(PlayCtx& c, Interiors& rooms);
  void load(AssetManager& assets);
  void start();                                // you are down: the helicopter comes
  bool active() const { return stage_ != Stage::None; }
  bool carried() const { return stage_ == Stage::Cabin || stage_ == Stage::Ambulance; }
  bool inBed() const { return stage_ == Stage::Bed; }
  void update(double dt, bool fast);
  /// the seat while carried (the game seats the player there) and the chase camera
  bool seat(dvec3& pos, dvec3& fwd) const;
  void camera(Camera& cam) const;
  void addDraw(VehicleDraw& vd, const dvec3& cam) const;
  void draw(Renderer& r, const dvec3& cam);
  void hud(Ui& ui, float u);
  bool interact(std::string& prompt, bool pressed);
  std::string objective() const;
  bool visit();                                // E at the medical centre's door: walk the ward
private:
  enum class Stage { None, Wait, Winch, Cabin, Ambulance, Bed, Visit } stage_ = Stage::None;
  void toHospital();
  PlayCtx& c_;
  Interiors& rooms_;
  std::shared_ptr<Model> heli_, amb_;
  mat4 heliFit_{1}, ambFit_{1};
  dvec3 heliPos_{0}, heliVel_{0}, down_{0}, ambPos_{0};
  double heliYaw_ = 0, rotor_ = 0, t_ = 0, stuckT_ = 0, bestD_ = 1e18, ambYaw_ = 0, ambS_ = 0, ropeT_ = 0, bedT_ = 0;
  int road_ = -1, roadDir_ = 1;
  double roadEnd_ = 0;
  int fee_ = 0;
};

} // namespace sl
