// Player controller: a port of src/player/player.js.
//
// Skiing model (fixed 1/120 s steps, exactly as the web game since its multiplayer fix): gravity along the snow,
// glide friction and drag (a tuck halves it), steering that turns the skis at a rate a carve can hold at that speed,
// edge grip pulling the velocity onto the skis' line (carve) or scrubbing speed beyond it (skid), snowplow / hockey
// stop braking, edges holding a stopped skier, push-off (W while slow), ground following with take-off over crests
// (STICK), pops charged with Space, landings judged on impact and on how sideways they are, crashes (tumble / roll /
// slam, slide, lie, get up). On foot: walking with grade limits (30 / 50 degrees), sprint, jump.
// Phase 1 simplifications: no freestyle tricks (spins / flips / grabs scoring), no park features, no lifts / seats,
// no other people; colliders are the village buildings, lamp posts and tree trunks / crowns.
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include <string>
#include <vector>

namespace sl {
class World;
class Scenery;

/// Controls sampled for one fixed tick.
struct PlayerControls {
  float steer = 0;            // +1 = left (A) .. -1 = right (D); analog from a stick
  bool front = false, back = false, grab = false;
  bool jumpPressed = false, jumpDown = false, jumpReleased = false;
  float moveX = 0, moveY = 0; // on foot: right / forward
  bool sprint = false;
  bool frozen = false;
};

/// Per rendered frame.
struct PlayerFrameControls {
  bool toggleView = false, toggleSkis = false;
  float lookX = 0, lookY = 0, wheel = 0;
  double now = 0, lastLook = -1e9;
  float fovSetting = 65;
};

enum class PlayerMode : uint8_t { Walk, Ski, Fall };

struct PlayerEvent { enum class Type : uint8_t { Crash, Bump, Land, Pop, Step, TooSteep, SkisOn, SkisOff } type; float amount = 0; };

/// Crash state (player.js `fall`): drives the body's tumble in the rig.
struct FallState {
  double t = 0; enum class State : uint8_t { None, Tumble, Lie, GetUp } state = State::None;
  enum class Kind : uint8_t { Slam, Tumble, Roll } kind = Kind::Slam;
  double axisHeading = 0, pitch = 0, pitchVel = 0, roll = 0, rollVel = 0;
  bool hasPitchTarget = false, hasRollTarget = false;
  double pitchTarget = 0, rollTarget = 0, rollRest = 0, ball = 0, getUp = 0, lieT = 0;
};

class Player {
public:
  Player(World& world, Scenery* scenery);

  void teleport(double x, double z, double heading);
  void setSkisOn(bool on);
  void fixedUpdate(double h, const PlayerControls& c);
  void frameUpdate(double dt, double alpha, const PlayerFrameControls& f, const PlayerControls& c);
  void cameraFor(Camera& cam) const;

  // state
  PlayerMode mode = PlayerMode::Walk;
  bool hasSkis = true, skisOn = false;
  dvec3 pos{0}, vel{0}, prevPos{0}, renderPos{0};
  dvec3 normal{0, 1, 0};
  double heading = PI;       // facing -Z (toward the mountain)
  bool air = false, ballistic = false, parked = false, hold = false;
  double airTime = 0;
  double steer = 0, lean = 0, edge = 0, crouch = 0.2, plow = 0, absorb = 0, absorbV = 0, sideslip = 0, skidYaw = 0;
  bool tuck = false;
  double charge = 0;
  bool charging = false;
  double flip = 0, yawFx = 0, yawFxV = 0;
  double footJumpY = 0;
  FallState fall;
  int fallSide = 1;
  double distance = 0, topSpeed = 0;
  enum class View : uint8_t { Third, First } view = View::Third;
  std::vector<PlayerEvent> events;   // drained by the game each frame (audio, rumble, HUD)
  double speed() const { return glm::length(vel); }
  const char* modeName() const;

private:
  // skiing
  void skiTick(double h, const PlayerControls& c);
  void steerToward(double target, double dt);
  void updatePop(double h, const PlayerControls& c);
  void pop(double charge);
  void skiStep(double h);
  void brakeStop(double h, bool brake);
  void followGround(double h);
  bool onGroomedRun(double x, double z) const;
  void liftOff(double h);
  void takeoff(bool pop);
  double predictAirLeft();
  void airStep(double h);
  void reattach(double gy);
  void land(double gy);
  void absorbImpact(double impact);
  dvec3 surfNormal(double x, double z, double h0);
  double turnRateAt(double sp, bool tuck, bool brake) const;
  void animateSki(double dt);
  // crashes
  void crash(int side, FallState::Kind kind, bool ski, double flipAngle = 0, double pitchVel = 0);
  void fallTick(double h);
  // walking
  void walkTick(double h, const PlayerControls& c);
  // collisions
  void collide(double speed, double feetY, double above = 0);
  void bounce(double nx, double nz, double speed, bool soft);
  // camera
  void updateCamera(double dt, const PlayerFrameControls& f);

  World& world_;
  Scenery* scenery_;
  struct Ctl { double steer = 0, steerIn = 0; bool tuck = false, brake = false, go = false, move = false; } ctl_;
  double heldL_ = 0, heldR_ = 0;
  bool popped_ = false;
  double popT_ = 1, liftT_ = 0, airEnd_ = 0;
  double airHeading_ = 0, airTravel_ = 0, airSteer_ = 0;
  dvec3 lastGroundNormal_{0, 1, 0};
  double brakeStopT_ = 0, launch_ = 0;
  double skidAmt_ = 0, skidSide_ = 1, turnRate_ = 0, prevVelYaw_ = PI, lastTurnSide_ = 1;
  bool footAir_ = false;
  double footJumpV_ = 0, walkSlip_ = 0, steepT_ = 0, steepOkT_ = 0, footT_ = 0;
  bool steepWarned_ = false;
  bool fallAir_ = false;
  // camera
  double camYaw_ = 0, camPitch_ = -0.12, camDist_ = 4.6, lookYaw_ = 0, lookPitch_ = 0;
  dvec3 camPos_{0, 3, 6}, camLook_{0}, camFocus_{0};
  double camFocusY_ = 0;
  bool camFocusInit_ = false;
  double camDip_ = 0, camDipV_ = 0, fovKick_ = 0, airBlend_ = 0, travelYaw_ = PI, shake_ = 0, camFov_ = 65;
  double fpEye_ = 1.26;
  double time_ = 0;
};

} // namespace sl
