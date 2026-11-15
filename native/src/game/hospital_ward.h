// The MEDICAL CENTRE inside (src/game/hospitalroom.js HospitalRoom + HospitalWard): the lobby at the front (reception,
// waiting benches, the BESUCHSZEIT board, the glass doors) and the ward behind it through the wide opening (four beds
// with their bed-head units, cabinets, monitors, IV stands, visitors' chairs, curtains, radiators under the windows),
// as hospitalroom.js builds it: export_play.mjs runs that module and writes the built room (one local mesh with its
// painted textures), the Meshy furniture as placed, the window / door panes, what the walker bumps into, the chairs,
// the beds and their mattress tops. It stands in the Interiors' quiet spot, in the room's own frame (x along the
// front, +z out of the front, y up from the floor).
//   admit()   you come round in a hospital bed (the rescue's ambulance, behind its fade): the eyes open (dark lids
//             part, blink, open; the room swims into focus), a short stay (STAY_S, the RECOVERING card bottom left),
//             then E gets you up and you walk out through the front doors to the forecourt
//   visit()   E at the front door outside: in through the doors, walk the ward, sit by a bed
#pragma once
#include "game/interiors.h"
#include "game/play.h"
#include "game/window_view.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {
class Renderer;

class HospitalWard {
public:
  HospitalWard(PlayCtx& c, Interiors& rooms, WindowView& win);
  void load(AssetManager& assets, std::shared_ptr<Model> mesh);
  /// Taken to the medical centre: you wake up in a hospital bed. false when it cannot (no medical centre): the caller
  /// leaves you outside its door as before.
  bool admit(double seconds = -1);
  bool visit();
  bool inside() const { return role_ != Role::None; }
  /// in bed, or being carried in (controls frozen)
  bool inBed() const { return role_ == Role::Patient || pending_ == Role::Patient; }
  /// lying in the bed, in the room (the rig's bed pose, the pillow's view)
  bool lying() const { return role_ == Role::Patient; }
  bool seated() const { return seat_ >= 0; }
  /// (hospitalroom.js mpPose) how the others see you in the ward: lying in your bed (the bed's spot, flat on the back:
  /// `patient`) or sitting on a visitor's chair; pos in the world. false: walking about
  bool mpPose(dvec3& pos, double& yaw, bool& patient) const;
  /// (hospitalroom.js patientSpot) the bed a patient at world x lies in: where the rig's root rests (the mattress + 4 cm)
  dvec3 patientSpot(double worldX) const;
  /// recovering (in bed, not yet allowed up)
  bool recovering() const { return role_ == Role::Patient && left_ > 0; }
  double left() const { return std::max(0.0, left_); }
  void update(double dt, bool input);
  /// the mattress under you while you lie in bed (a World deck), else NaN
  double deck(double x, double z) const;
  bool seat(dvec3& pos, dvec3& fwd) const;
  bool camera(Camera& cam) const;
  bool interact(std::string& prompt, bool pressed);
  std::string objective() const;
  void hud(Ui& ui, float u);
  void reset();
  /// (the wake-up's eyelids are still closing / opening)
  bool waking() const { return wakeT_ >= 0 && wakeT_ < 5.6; }
  /// (the rig, game.cpp) lying in bed now: the mattress under the body, the view; back from the rig: the eyes, the body
  double bedFloor() const { return role_ == Role::Patient ? rooms_.toWorld(0, bedTops_[size_t(bed_)] + 0.04, 0).y : 0; }
  bool third() const { return third_; }
  void setBody(const dvec3& eye, const dvec3& body) { eye_ = eye; body_ = body; hasEye_ = true; }
  /// (debug) a spot in front of the first visitor's chair, facing it
  bool debugChair(dvec3& at, double& yaw) const { if (chairs_.empty() || role_ == Role::None) return false; const Chair& c = chairs_[0]; at = rooms_.toWorld(c.x, 0, c.z + 0.9); yaw = PI; return true; }
  /// (debug: wardtest) fit in a moment
  void debugFit() { if (left_ > 0.05) left_ = 0.05; }

private:
  enum class Role : uint8_t { None, Patient, Visitor } role_ = Role::None;
  struct Chair { double x, z, yaw, y; int bed; };
  struct Pane { mat4 m; float w, h; };
  struct Furn { std::shared_ptr<Model> model; mat4 m; };
  void build();
  void enterNow();
  void outside();
  void getUp();
  PlayCtx& c_;
  Interiors& rooms_;
  WindowView& win_;   // (the windows and the glass doors: the village live, hospitalroom.js LivePortal)
  bool ok_ = false;
  std::shared_ptr<Model> mesh_;
  std::vector<Furn> furn_;
  std::vector<Pane> panes_;
  std::vector<std::array<double, 4>> obstacles_;
  std::vector<Chair> chairs_;
  std::vector<double> beds_, bedTops_;
  double stay_ = 20;
  dvec3 door_{0};
  double doorYaw_ = 0;
  bool hasDoor_ = false;
  int bed_ = 1, seat_ = -1;
  double left_ = 0, t_ = 0, wakeT_ = -1, flashT_ = -1;
  bool discharged_ = false, third_ = false, notified_ = false;
  double yaw_ = 0, pitch_ = -0.3, tpYaw_ = PI, tpPitch_ = -0.45;
  dvec3 eye_{0}, body_{0};
  Role pending_ = Role::None;       // admitted / visiting: in at the next update
  double pendingSeconds_ = -1;
  bool hasEye_ = false;
};

} // namespace sl
