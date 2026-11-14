// The helicopter (src/game/heli.js + heli/*.js, ported 1:1 on the data native/tools/export_play.mjs writes from the
// game's own modules: the pad, the airframe cut by model.js, its rotors, the drop zones, the ambulance's way):
//   Heli        heli.js: the heli-ski base in Legacy Village (book a flight at the pad / the hut, $1,500: you are the
//               pilot), boarding, the flight (heli_flight: flight.js), the chase camera, landing anywhere flat and open
//               ("Land here" / "Too steep to land" / "Trees below"), getting out / jumping out, the parked helicopter
//               waiting where you landed, its pilot flying it home, the flight HUD, the compass's drop zone, the rotors
//               (spool up, idle, wind down; blades fading into the blur discs), the lamps
//   HeliRescue  heli/rescue.js: after a crash you stay down in the snow and the helicopter comes: it lands on flat open
//               snow beside you (a fade, you are in the cabin) or hovers and winches you up, flies you home to the pad,
//               the ambulance drives you to the medical centre, you wake up in a hospital bed (game/hospital_ward)
//   Ambulance   heli/ambulance.js: waits beside the pad, drives the Rettungsweg with its lights flashing, steering
//               round what is in its way
#pragma once
#include "game/heli_flight.h"
#include "game/play.h"
#include "game/vehicles.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {
class Renderer;
class Resort;
class HospitalWard;
class Heli;
struct Collider;

/// the models built from the play pack (before its bin is released: Resort::playModel)
struct HeliParts {
  std::shared_ptr<Model> body, hub, blade, disc, tailHub, tailBlades, tailDisc, ward;
};
HeliParts loadHeliParts(Resort& resort);

struct DropZone { std::string name, label; double x = 0, z = 0, y = 0, heading = 0; int vertical = 0; bool race = false; };

// ---------------------------------------------------------------- heli/ambulance.js
class Ambulance {
public:
  explicit Ambulance(PlayCtx& c) : c_(c) {}
  void load(AssetManager& assets, const nlohmann::json& j);
  bool ok() const { return bool(model_); }
  void park(double x, double z, double yaw);
  void parkAtPad() { park(parkX_, parkZ_, parkYaw_); }
  void hide() { visible = false; hasPath_ = false; arrived = false; }
  void plan();
  void drive(double dt);
  void flash(double dt, double night);
  dvec3 pos() const { return dvec3(x, y, z); }
  void draw(Renderer& r, const dvec3& cam) const;
  void fillColliders(std::vector<Collider>& out) const;
  bool visible = false, arrived = false, rider = false;
  double x = 0, y = 0, z = 0, yaw = 0, v = 0, vx = 0, vz = 0;
  dvec2 goal{0};
  bool hasGoal = false;
private:
  struct Obs { double s, lat, across, along, vAlong; bool person; };
  struct At { double x, z, tx, tz; int i; };
  At at(double s) const;
  void scan();
  void place();
  PlayCtx& c_;
  std::shared_ptr<Model> model_;
  mat4 fit_{1};
  vec3 size_{2.1f, 2.7f, 5.9f};
  struct Light { vec3 p; bool red; };
  std::vector<Light> lights_;
  double lightK_[2] = {0.15, 0.15};
  double parkX_ = 0, parkZ_ = 0, parkYaw_ = 0;
  std::vector<dvec2> route_;           // the exported way (Ambulance.plan + setPath from the pad)
  std::vector<dvec2> pts_;
  std::vector<double> S_, TX_, TZ_;
  double length_ = 0;
  bool hasPath_ = false;
  int iSeg_ = 0;
  double s_ = 0, t_ = 0, lat_ = 0, latT_ = 0, q_ = 0, wait_ = 0, scanT_ = 0, pitch_ = 0, roll_ = 0;
  std::vector<Obs> obs_;
};

// ---------------------------------------------------------------- heli/rescue.js
class HeliRescue {
public:
  HeliRescue(Heli& h, PlayCtx& c, HospitalWard& ward);
  enum class Phase : uint8_t { None, Inbound, Settle, Pickup, Hover, Home, Arrive, Ambulance };
  Phase phase = Phase::None;
  bool active() const { return phase != Phase::None; }
  /// in the cabin (inside sound, the chase camera)
  bool aboard() const { return phase == Phase::Home || phase == Phase::Arrive || (phase == Phase::Pickup && inCabin); }
  /// the helicopter has gone after handing you to the ambulance (its rotor stops)
  bool grounded() const { return phase == Phase::Ambulance && gone; }
  std::string hudLine() const;
  bool start(bool free);
  HeliCtl controls(double dt);
  void after(double dt, bool fastKey);
  void cleanup();
  void fail();
  void draw(Renderer& r, const dvec3& cam) const;
  /// (debug: ambtest) straight to the pad, landed, you in the cabin
  void debugArrive();
  bool fast = false, inCabin = false, attached = false, gone = false, free = false, leaving = false, boarding = false;
  double t = 0, pt = 0, liftT = -1;
  Ambulance amb;
  /// the camera this frame (the shot from the snow, the pad shot, the ambulance chase): false while the crash camera has you
  bool camOn = false;
  dvec3 camPos{0}, camLook{0};
  double camFov = 58;
  dvec3 seatPos{0}, seatFwd{0, 0, 1};
  bool seated = false;      // on the winch / in the ambulance (the cabin seat is the helicopter's)
private:
  struct Spot { bool ok = false, land = false; double x = 0, z = 0, y = 0, yaw = 0, hx = 0, hz = 0, hoverY = 0; } spot_;
  void go(Phase p) { phase = p; pt = 0; }
  bool settled() const;
  Spot pickSpot() const;
  Spot pickWinch() const;
  void winch(double dt);
  void intoCabin();
  void finish();
  void release();
  void charge(const std::string& what);
  void groundShot(double dt);
  void ambShot(double dt);
  void ambChase(double dt);
  dvec3 door(double& heading) const;
  Heli& h_;
  PlayCtx& c_;
  HospitalWard& ward_;
  double ropeLen_ = 0, winchT_ = 0;
  bool ropeOn_ = false;
  dvec3 ropeTop_{0}, lieAt_{0};
  bool hasLieAt_ = false;
  struct { dvec3 pos{0}, look{0}; double dx = 0, dz = 1; bool ready = false; } shot_;
  bool hasShotAt_ = false, hasChase_ = false, sirenOff_ = false, failing_ = false;
  dvec3 shotAt_{0}, chase_{0};
  struct { Phase phase = Phase::None; double best = 1e18, t = 0; } watch_;
  friend class Heli;
};

// ---------------------------------------------------------------- heli.js
class Heli {
public:
  Heli(PlayCtx& c, HospitalWard& ward);
  void load(AssetManager& assets, const HeliParts& parts);
  bool ok() const { return ok_; }
  enum class State : uint8_t { Parked, Boarding, Flying, Auto, Rescue };
  State state = State::Parked;
  /// you are flying it (seated in the cabin with the controls)
  bool active() const { return state == State::Flying; }
  bool rescuing() const { return state == State::Rescue; }
  /// seated in it or carried by the rescue (the game seats the player at seat())
  bool riding() const { return state == State::Flying || (state == State::Rescue && (rescue.inCabin || rescue.seated)); }
  /// the rescue: down in the snow, waiting (controls frozen, you stay lying)
  bool waiting() const { return state == State::Rescue && !rescue.inCabin && !rescue.seated; }
  double speed() const { return flight.speed(); }
  /// after a crash: the helicopter comes for you; false when it can't (the caller uses the old fade)
  bool rescueMe(bool free);
  void abort();
  /// per frame; `fly`: the keys may fly it (no menu, map or dialog open)
  void update(double dt, bool fly);
  bool seat(dvec3& pos, dvec3& fwd) const;
  /// the frame's camera when the helicopter / the rescue owns it
  bool camera(Camera& cam) const;
  bool hideRig() const { return state == State::Rescue && rescue.phase == HeliRescue::Phase::Ambulance; }
  void draw(Renderer& r, const Camera& cam);
  void hud(Ui& ui, float u);
  bool interact(std::string& prompt, bool pressed);
  std::string objective() const;
  /// the compass while you fly: the drop zone
  bool waypoint(std::string& label, double& x, double& z) const;
  void fillColliders(std::vector<Collider>& out) const;
  /// (audio) the rotor: where, how fast, heard from inside; the ambulance's siren
  bool rotorAt(dvec3& out, double& rpmOut, bool& inside) const;
  bool sirenAt(dvec3& out) const;
  std::function<bool()> blocked;      // (no flying off mid-chase)
  /// (debug: helitest) aboard at once on a flight plan to zone i, paid
  void debugFly(int zone) { if (state != State::Parked) return; c_.spend(price_); plan_ = zone >= 0 && size_t(zone) < zones_.size() ? &zones_[size_t(zone)] : nullptr; board(); }

  // the parts the rescue flies
  HeliFlight flight;
  HeliHomePilot pilot;
  HeliPad home;
  HeliRescue rescue;
  double rpm = 0, time = 0;
  double padR = 10;
  dvec3 streamPos{0};
  struct Cam { double yaw = 0, pitch = 0.22, dist = 17, lastMouse = -1e9, fov = 62; } cam;
  void placeCamera(double dt, bool snap, bool input);
  void place();
  double ground(double x, double z) const;
  double snow(double x, double z) const;
  dvec3 anchorSeat{0}, anchorDoor{0}, anchorBasket{0}, anchorLamp{0}, anchorHub{0};
  const GroundFn& groundFn() const { return groundFn_; }
  bool treeNear(double x, double z, double r) const;
  bool solidNear(double x, double z, double pad, bool carsToo = true) const;
  bool liftLineNear(double x, double z, double d) const;

private:
  void openDialog();
  void board();
  void jumpOut();
  void getOut();
  void callHome(bool quiet);
  void checkJump();
  void landCheck();
  double skidSlope() const;
  void updateSeat();
  const DropZone* targetZone(double skip) const;
  PlayCtx& c_;
  bool ok_ = false;
  HeliParts parts_;
  GroundFn groundFn_;
  // model.js numbers (the airframe's frame: reference units, K metres each, the centre of mass at airPos_)
  double K_ = 9.8 / 10.5, bladeX_ = 0.42, discY_ = 0.02, tailDiscX_ = 0.06;
  vec3 hub_{0, 4.02f, 1.3f}, tailHub_{0.41f, 2.25f, -4.92f}, airPos_{0};
  double angle_ = 0, tailAngle_ = 0;
  int price_ = 1500;
  dvec2 hutDoor_{0};
  std::vector<DropZone> zones_;
  const DropZone* plan_ = nullptr;
  HeliCtl ctl_;
  dvec3 seatPos_{0}, seatFwd_{0, 0, 1};
  dvec3 camPos_{0}, camLook_{0};
  double camFovNow_ = 62;
  bool camSet_ = false;
  double handoff_ = 0;
  dvec3 handPos_{0}, handLook_{0};
  double handFov_ = 62;
  bool parkSkier_ = false;
  int flights_ = 0;
  struct { bool ok = false, warn = false, onPad = false, landed = false; std::string label; } jump_;
  struct { bool ok = false, warn = false, pad = false; double hold = 0, t = 0; std::string label; } land_;
  bool away_ = false;
  double awayT_ = 0, landedT_ = 0, keysT_ = 0;
  bool spun_ = false;
  std::string promptText_, promptKey_;
  bool promptWarn_ = false;
  int prevView_ = 0;
  // heli/fx.js Downwash: the powder blown out from under the rotor when it is close to the snow
  struct Puff { dvec3 p{0}, v{0}; double age = 1e9, life = 1, s0 = 1, s1 = 2; };
  std::vector<Puff> puffs_;
  size_t puffNext_ = 0;
  double puffAcc_ = 0;
  uint32_t rnd_ = 0x2545f491u;
  double rnd() { rnd_ = rnd_ * 1664525u + 1013904223u; return (rnd_ >> 8) / 16777216.0; }
  void updateWash(double dt);
  std::shared_ptr<Model> puffModel_[4];
  VehicleDraw puffDraw_;
  friend class HeliRescue;
};

} // namespace sl
