#include "player/player.h"
#include "player/three_math.h"
#include "world/scenery.h"
#include "world/world.h"
#include <cstdlib>
#include <algorithm>

namespace sl {

namespace {
// ---- ski physics tuning (SI units), player.js
const double G = 9.81;
const double MU = 0.04;
const double DRAG = (0.5 * 1.15) / 80;
const double CDA_STAND = 0.42, CDA_TUCK = 0.2, CDA_AIR = 0.38;
const double TURN_MAX = 1.6, A_TURN = 23, STEER_TAU = 0.1, STEER_TAU_OFF = 0.07, TUCK_TURN = 0.65, SKID_TURN = 1.6;
const double A_GRIP = 30, CARVE_DRAG = 0.012;
const double AIR_STEER_MAX = 20 * DEG;
const double V_HOLD = 0.5, G_GO = 0.6;
const double COS_GO = std::cos(55 * DEG);
const double PUSH_A = 2.6, W_PUSH_V = 5;
const double LAUNCH_A = 6.6, LAUNCH_V = 12.5;
const double PUSH_UP0 = std::sin(7 * DEG), PUSH_UP1 = std::sin(9 * DEG);
const double BRAKE_LOW = 6, BRAKE_HIGH = 8, BRAKE_HOLD_V = 0.6;
const double STICK = 10;
const double POP_MIN = 2.8, POP_MAX = 5.2, CHARGE_TIME = 0.55, COYOTE = 0.16;
const double IMPACT_FRICTION = 0.3, IMPACT_FREE = 3.5;
const double BODY_SLIDE = 8.5, GETUP_TIME = 1.35;
const double CRASH_IMPACT = 16, SKETCHY_YAW = 40 * DEG;
const double CRASH_HIT = 11;
// ---- on foot
const double FOOT_SPEED = 4.2, SPRINT_K = 1.5;
const double WALK_FULL = std::tan(30 * DEG), WALK_MAX = std::tan(50 * DEG);
// ---- first person (player.js FP_*)
const double FP_PITCH = -15 * DEG;     // default look-down while skiing
const double FP_SLOPE_PITCH = 0.55;    // share of the snow's pitch the view follows (looks down a steep run)
const double FP_EYE_H = 1.26;          // eye over the snow in the athletic stance (m), until the rig has one
const double FP_NEAR = 0.08;
const double FP_FOV = 78;              // vertical field of view at rest (deg)...
const double FP_FOV_SPEED = 0.35;      // ...+ this per m/s over 10 m/s (up to +10.5 deg)
const double FP_LEAD = 0.13;           // the head looks this many seconds of turning ahead into a turn...
const double FP_LEAD_MAX = 0.2;        // ...at most this far (rad)
const double FP_BANK = 0.12;           // head roll per radian of body inclination...
const double FP_BANK_MAX = 6 * DEG;    // ...at most (a steady horizon)
// player.js spring(): exact critically damped step of x (velocity v) toward target at angular frequency w
void spring(double& x, double& v, double target, double w, double dt) {
  double d = x - target, e = std::exp(-w * dt), c = v + w * d;
  x = target + (d + c * dt) * e;
  v = (v - c * w * dt) * e;
}
// noise.js smoothstep(a, b, x) (either order of the edges)
double sstep(double a, double b, double x) { double t = std::min(1.0, std::max(0.0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
// THREE.Quaternion.setFromEuler, order 'YXZ'
glm::dquat eulerYXZ(double x, double y, double z) {
  double c1 = std::cos(x / 2), c2 = std::cos(y / 2), c3 = std::cos(z / 2), s1 = std::sin(x / 2), s2 = std::sin(y / 2), s3 = std::sin(z / 2);
  return glm::dquat(c1 * c2 * c3 + s1 * s2 * s3, s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3);
}

double rnd01() { return double(std::rand()) / RAND_MAX; }
double approachAngleDamp(double a, double b, double k) { return dampAngle(a, b, k); }
} // namespace

Player::Player(World& world, Scenery* scenery) : world_(world), scenery_(scenery) {}

const char* Player::modeName() const {
  switch (mode) { case PlayerMode::Walk: return "walk"; case PlayerMode::Ski: return air ? "air" : "ski"; case PlayerMode::Fall: return "crash"; case PlayerMode::Sit: return "ride"; }
  return "";
}

void Player::teleport(double x, double z, double h) {
  teleportCount++;
  pos = dvec3(x, world_.groundHeight(x, z), z);
  prevPos = renderPos = pos;
  vel = dvec3(0);
  heading = h;
  camYaw_ = h + PI;
  if (mode == PlayerMode::Fall) mode = skisOn ? PlayerMode::Ski : PlayerMode::Walk;
  fall = FallState{};
  fallAir_ = false;
  camPos_ = pos + dvec3(-std::sin(h) * 5, 3, -std::cos(h) * 5);
  camFocusInit_ = false; camLook_ = dvec3(0); travelYaw_ = h; camDip_ = camDipV_ = 0;
  shake_ = fovKick_ = airBlend_ = 0; fpSlope_ = 0;
  prevVelYaw_ = h;
  air = ballistic = false; flip = yawFx = yawFxV = airSteer_ = 0; charging = false; charge = 0; popT_ = 1;
  absorb = absorbV = 0; steer = edge = lean = skidAmt_ = skidYaw = turnRate_ = 0;
  crouch = 0.2; plow = 0; sideslip = 0; tuck = false;
  footAir_ = false; footJumpY = footJumpV_ = 0; walkSlip_ = 0; steepT_ = 0; brakeStopT_ = 0;
  parked = true;
  launch_ = 0;
  normal = dvec3(world_.groundNormal(x, z));
}

void Player::sitOn(const dvec3& seat, const dvec3& fwd) {
  mode = PlayerMode::Sit;
  vel = dvec3(0);
  air = ballistic = false; airTime = 0; charging = false; charge = 0; flip = yawFx = yawFxV = airSteer_ = 0;
  absorb = absorbV = 0; steer = edge = lean = 0; footAir_ = false; footJumpY = 0;
  fall = FallState{};
  setSeat(seat, fwd);
  camFocusInit_ = false;
}
void Player::setSeat(const dvec3& seat, const dvec3& fwd) {
  pos = prevPos = renderPos = seat;
  if (std::hypot(fwd.x, fwd.z) > 1e-6) heading = std::atan2(fwd.x, fwd.z);
  normal = dvec3(0, 1, 0);
}
void Player::standUp(double x, double z, double h) {
  mode = skisOn ? PlayerMode::Ski : PlayerMode::Walk;
  teleport(x, z, h);
}

void Player::setSkisOn(bool on) {
  if (on && !hasSkis) return;
  if (on && !skisOn) { parked = true; vel = dvec3(0); }
  skisOn = on;
  if (mode == PlayerMode::Walk || mode == PlayerMode::Ski) mode = on ? PlayerMode::Ski : PlayerMode::Walk;
  events.push_back({on ? PlayerEvent::Type::SkisOn : PlayerEvent::Type::SkisOff, 0});
}

double Player::turnRateAt(double sp, bool tk, bool brake) const {
  double rate = std::min(TURN_MAX, (A_TURN * skiGrip) / std::max(sp, 1.0));   // (Phase 7: the skis' grip, player.js this.ski)
  if (tk) rate *= TUCK_TURN;
  if (brake && sp > 3) rate *= SKID_TURN;
  return rate;
}

// ---------------------------------------------------------------- tick
void Player::fixedUpdate(double h, const PlayerControls& c) {
  time_ += h;
  prevPos = pos;
  if (mode == PlayerMode::Sit) return;   // (the seat is moved by the lift)
  if (mode == PlayerMode::Ski) skiTick(h, c);
  else if (mode == PlayerMode::Walk) walkTick(h, c);
  else fallTick(h);
  double sp = speed();
  if (mode == PlayerMode::Ski && !air) distance += sp * h;
  topSpeed = std::max(topSpeed, mode == PlayerMode::Ski ? sp : 0.0);
}

void Player::skiTick(double h, const PlayerControls& c) {
  bool live = !c.frozen;
  double steerIn = live ? clamp(c.steer, -1, 1) : 0;
  bool left = steerIn > 0.5, right = steerIn < -0.5;
  heldL_ = left ? heldL_ + h : 0;
  heldR_ = right ? heldR_ + h : 0;
  updatePop(h, c);
  if (air) {
    // (no freestyle tricks in Phase 1: A / D keep steering the skis a little, carried into the landing)
    steerToward(steerIn, h);
    double vh = std::hypot(vel.x, vel.z);
    airSteer_ = clamp(airSteer_ + steer * turnRateAt(vh, false, false) * h, -AIR_STEER_MAX, AIR_STEER_MAX);
    heading = airHeading_ + airSteer_;
  } else steerToward(steerIn, h);
  ctl_.steer = steer;
  ctl_.steerIn = steerIn;
  ctl_.brake = live && c.back;
  ctl_.go = live && c.front && !c.back;
  ctl_.tuck = ctl_.go;
  ctl_.move = steerIn != 0 || (live && c.front);
  skiStep(h);
}

void Player::steerToward(double target, double dt) {
  double tau = std::fabs(target) < std::fabs(steer) || target * steer < 0 ? STEER_TAU_OFF : STEER_TAU;
  steer += (target - steer) * (1 - std::exp(-dt / tau));
  if (target == 0 && std::fabs(steer) < 1e-3) steer = 0;
}

void Player::updatePop(double h, const PlayerControls& c) {
  if (c.frozen) { charging = false; charge = 0; return; }
  bool canPop = !air || (airTime < COYOTE && !popped_);
  if (c.jumpPressed && canPop) { charging = true; charge = 0; }
  if (!charging) return;
  charge = std::min(1.0, charge + h / CHARGE_TIME);
  if (c.jumpReleased || !c.jumpDown) {
    if (canPop && c.jumpReleased) pop(charge);
    charging = false; charge = 0;
  } else if (air && airTime >= COYOTE) { charging = false; charge = 0; }
}

void Player::pop(double ch) {
  dvec3 n = air ? lastGroundNormal_ : normal;
  double imp = POP_MIN + (POP_MAX - POP_MIN) * std::pow(ch, 0.85);
  vel += n * imp;
  parked = false;
  if (!air) { pos += n * 0.03; takeoff(true); }
  else airEnd_ = airTime + predictAirLeft();
  popped_ = true;
  popT_ = 0;
  fovKick_ = std::max(fovKick_, 0.4 + ch * 0.6);
  events.push_back({PlayerEvent::Type::Pop, float(ch)});
}

dvec3 Player::surfNormal(double x, double z, double h0) {
  const double e = 0.35;
  double hxp = world_.groundHeight(x + e, z), hxm = world_.groundHeight(x - e, z);
  double hzp = world_.groundHeight(x, z + e), hzm = world_.groundHeight(x, z - e);
  double ax = hxp - h0, bx = h0 - hxm, az = hzp - h0, bz = h0 - hzm;
  double ny = std::max(0.05, normal.y);
  double px = (-normal.x / ny) * e, pz = (-normal.z / ny) * e;
  double dx = std::fabs(ax - bx) > 0.045 ? (std::fabs(ax - px) < std::fabs(bx - px) ? ax : bx) / e : (ax + bx) / (2 * e);
  double dz = std::fabs(az - bz) > 0.045 ? (std::fabs(az - pz) < std::fabs(bz - pz) ? az : bz) / e : (az + bz) / (2 * e);
  return glm::normalize(dvec3(-dx, 1, -dz));
}

void Player::skiStep(double h) {
  if (ballistic) { airStep(h); return; }
  dvec3& p = pos; dvec3& v = vel; const dvec3 n = normal;
  if (hold) { v = dvec3(0); return; }
  double sp = glm::length(v);
  if (parked) {
    if (ctl_.move || sp > V_HOLD) parked = false;
    else { v = dvec3(0); return; }
  }
  const double ice = 1.0;
  bool brake = ctl_.brake;
  bool tk = ctl_.tuck && sp > W_PUSH_V - 1;
  heading += ctl_.steer * turnRateAt(sp, tk, brake) * h;
  double sx = std::sin(heading), sz = std::cos(heading);
  dvec3 f = glm::normalize(dvec3(sx, -(n.x * sx + n.z * sz) / std::max(0.05, n.y), sz));
  dvec3 lat = glm::cross(n, f);
  dvec3 a = dvec3(0, -G, 0) + n * (G * n.y);
  double push = 0;
  if (!brake && ctl_.go && sp < W_PUSH_V)
    push = PUSH_A * std::max(0.0, 1 - sp / W_PUSH_V) * (1 - smoothstep(PUSH_UP0, PUSH_UP1, f.y));
  if (launch_ > 0) {
    launch_ = brake ? 0 : launch_ - h;
    push = std::max(push, LAUNCH_A * std::max(0.0, 1 - sp / LAUNCH_V));
  }
  if (sp < V_HOLD) {
    double pull = glm::dot(a, f), gl = glm::length(a);
    bool downhill = pull > G_GO && pull > COS_GO * gl;
    if (!downhill && !(push > 0.3 && pull + push > 0.1)) { v = dvec3(0); brakeStop(h, brake); return; }
  }
  if (sp > 1e-4) {
    // (Phase 7) the skis' speed (player.js this.ski.speed): less glide friction and drag
    double mult = skiSpeed;
    double cda = (tk ? CDA_TUCK : CDA_STAND + std::fabs(ctl_.steer) * 0.06) / (mult * mult);
    double carve = CARVE_DRAG * sp * std::fabs(ctl_.steer) * turnRateAt(sp, tk, false);
    a += v * (-((MU / mult) * ice * G * n.y + DRAG * cda * sp * sp + carve) / sp);
  }
  if (push) a += f * push;
  v += a * h;
  double grip = A_GRIP * skiGrip * (0.3 + 0.7 * std::min(1.0, ice));
  double vL = glm::dot(v, lat);
  v += lat * (-sign(vL) * std::min(std::fabs(vL), grip * h));
  if (brake) {
    double s1 = glm::length(v);
    if (s1 < BRAKE_HOLD_V) v = dvec3(0);
    else {
      double dec = lerp(BRAKE_LOW, BRAKE_HIGH, smoothstep(5, 11, s1)) * (0.35 + 0.65 * std::min(1.0, ice));
      v *= std::max(0.0, s1 - dec * h) / s1;
    }
  }
  v -= n * glm::dot(v, n);
  brakeStop(h, brake);
  p += v * h;
  followGround(h);
  if (mode == PlayerMode::Ski && !ballistic) collide(sp, p.y);
}

void Player::brakeStop(double h, bool brake) {
  if (brake && glm::dot(vel, vel) < 0.01) {
    brakeStopT_ += h;
    if (brakeStopT_ > 0.25) parked = true;
  } else brakeStopT_ = 0;
}

bool Player::onGroomedRun(double x, double z) const {
  CorridorHit c = world_.corridorAt(x, z);
  return c.any && c.groomed && c.d < 3;
}

void Player::followGround(double h) {
  dvec3& p = pos; dvec3& v = vel;
  double gy = world_.groundHeight(p.x, p.z, p.y + 0.05);
  double gap = p.y - gy;
  if (gap > 0 && 2 * gap > (G * normal.y + STICK) * h * h && !(gap < 0.6 && onGroomedRun(p.x, p.z))) { liftOff(h); return; }
  p.y = gy;
  normal = surfNormal(p.x, p.z, gy);
  double vn = glm::dot(v, normal), s = glm::length(v);
  v -= normal * vn;
  double t = glm::length(v);
  if (vn < -3) {
    if (t > 1e-6) v *= std::max(0.0, t - IMPACT_FRICTION * std::max(0.0, -vn - IMPACT_FREE)) / t;
    absorbImpact(-vn);
    if (-vn > CRASH_IMPACT && !onGroomedRun(p.x, p.z)) crash(rnd01() < 0.5 ? -1 : 1, FallState::Kind::Tumble, true);
  } else if (t > 1e-6) v *= s / t;
}

void Player::liftOff(double h) {
  ballistic = true;
  liftT_ = 0;
  lastGroundNormal_ = normal;
  if (pos.y - world_.groundHeight(pos.x, pos.z, pos.y) > 0.18) takeoff(false);
}

void Player::takeoff(bool isPop) {
  air = true;
  ballistic = true;
  parked = false;
  airTime = isPop ? 0 : liftT_;
  popped_ = isPop;
  if (isPop) lastGroundNormal_ = normal;
  heading += yawFx; yawFx = 0; yawFxV = 0;
  flip = 0;
  airHeading_ = heading; airSteer_ = 0;
  double vh = std::hypot(vel.x, vel.z);
  airTravel_ = vh > 0.7 ? std::atan2(vel.x, vel.z) : heading;
  airEnd_ = airTime + predictAirLeft();
}

double Player::predictAirLeft() {
  for (double t = 0.05; t <= 4; t += 0.05) {
    double y = pos.y + vel.y * t - 0.5 * G * t * t;
    if (y <= world_.groundHeight(pos.x + vel.x * t, pos.z + vel.z * t, y + 0.5)) return t;
  }
  return 4;
}

void Player::airStep(double h) {
  dvec3& p = pos; dvec3& v = vel;
  if (air) airTime += h; else liftT_ += h;
  v.y -= G * h;
  if (!air) v.y -= STICK * h;
  double sp = glm::length(v);
  v *= std::max(0.0, 1 - DRAG * (CDA_AIR / (skiSpeed * skiSpeed)) * sp * h);
  p += v * h;
  double gy = world_.groundHeight(p.x, p.z, p.y);
  if (p.y <= gy) { if (air) land(gy); else reattach(gy); return; }
  if (!air && (p.y - gy > 0.18 || liftT_ > 0.35)) takeoff(false);
  collide(sp, p.y, p.y - gy);
}

void Player::reattach(double gy) {
  ballistic = false;
  pos.y = gy;
  normal = surfNormal(pos.x, pos.z, gy);
  double vn = glm::dot(vel, normal), s = glm::length(vel);
  vel -= normal * vn;
  double t = glm::length(vel);
  if (vn < -3) {
    if (t > 1e-6) vel *= std::max(0.0, t - IMPACT_FRICTION * std::max(0.0, -vn - IMPACT_FREE)) / t;
    absorbImpact(-vn);
  } else if (t > 1e-6 && vn > 0) vel *= s / t;
}

void Player::land(double gy) {
  pos.y = gy;
  normal = surfNormal(pos.x, pos.z, gy);
  double impact = std::max(0.0, -glm::dot(vel, normal));
  vel -= normal * glm::dot(vel, normal);
  double vh = std::hypot(vel.x, vel.z);
  double travel = vh > 0.7 ? std::atan2(vel.x, vel.z) : heading;
  double yawErr = wrapPi(airHeading_ - travel);
  double yaw = std::fabs(yawErr);
  bool sw = yaw > PI / 2;
  double yawOff = sw ? PI - yaw : yaw;
  air = false;
  ballistic = false;
  prevVelYaw_ = travel;
  bool crashed = (yawOff > SKETCHY_YAW && vh > 5) || impact > CRASH_IMPACT;
  if (crashed) {
    FallState::Kind kind = yawOff > SKETCHY_YAW ? FallState::Kind::Roll : impact > 16 ? FallState::Kind::Tumble : FallState::Kind::Roll;
    crash(int(sign(yawErr)) ? int(sign(yawErr)) : (rnd01() < 0.5 ? -1 : 1), kind, true);
    return;
  }
  double s = glm::length(vel);
  double ns = std::max(0.0, s - IMPACT_FRICTION * std::max(0.0, impact - IMPACT_FREE));
  ns *= 1 - 0.5 * std::pow(std::sin(yawOff), 2);
  if (impact > 12 || yawOff > 15 * DEG) ns *= 0.92; // sketchy
  if (sw) ns *= 0.94;
  if (s > 1e-6) vel *= ns / s;
  heading = travel + airSteer_;
  airSteer_ = 0;
  yawFx = sw ? 0 : yawErr; yawFxV = 0;
  flip = wrapPi(flip);
  absorbImpact(impact);
}

void Player::absorbImpact(double impact) {
  absorbV += std::min(14.0, impact * 1.3);
  camDipV_ -= std::min(5.0, impact * 0.32);
  shake_ = std::max(shake_, clamp((impact - 5) / 10, 0, 0.7));
  if (impact > 1.5) events.push_back({PlayerEvent::Type::Land, float(clamp((impact - 1.5) / 11, 0, 1))});
}

// ---------------------------------------------------------------- crashes
void Player::crash(int side, FallState::Kind kind, bool ski, double flipAngle, double pitchVel) {
  if (mode == PlayerMode::Fall) return;
  double sp = glm::length(vel), vh = std::hypot(vel.x, vel.z);
  bool bump = ski && sp < 60 / 3.6; // (player.js: a ski wipeout under 60 km/h is only the fall)
  mode = PlayerMode::Fall;
  fallSide = side ? side : (rnd01() < 0.5 ? -1 : 1);
  fallAir_ = air || ballistic;
  air = ballistic = parked = false;
  charging = false; charge = 0;
  FallState& F = fall;
  F = FallState{};
  F.state = FallState::State::Tumble;
  F.kind = kind;
  F.pitch = wrapPi(flipAngle);
  F.axisHeading = vh > 1 ? std::atan2(vel.x, vel.z) : heading;
  if (kind == FallState::Kind::Tumble) {
    double dir = sign(pitchVel) != 0 ? sign(pitchVel) : 1;
    F.pitchVel = dir * std::max(std::fabs(pitchVel), clamp(sp * 0.42, 4, 11));
  } else if (kind == FallState::Kind::Roll) F.rollVel = fallSide * clamp(sp * 0.4, 3, 9);
  F.ball = kind == FallState::Kind::Slam ? 0.25 : 1;
  heading += yawFx;
  flip = yawFx = yawFxV = airSteer_ = 0;
  absorb = absorbV = 0;
  shake_ = 1;
  events.push_back({bump ? PlayerEvent::Type::Bump : PlayerEvent::Type::Crash, float(clamp(sp / 25, 0.2, 1))});
}

void Player::knockDown(int side, const dvec3& v, int kind, bool strike) {
  if (mode == PlayerMode::Fall || mode == PlayerMode::Sit) return;
  if (mode == PlayerMode::Walk && skisOn) skisOn = false;
  vel = v;
  air = true;
  crash(side, FallState::Kind(std::clamp(kind, 0, 2)), false, 0, kind == 1 ? 8 : 0);
  fallAir_ = true;
  if (!events.empty()) events.back().type = strike ? PlayerEvent::Type::Crash : PlayerEvent::Type::Bump;
}

void Player::fallTick(double dt) {
  FallState& F = fall;
  dvec3& v = vel; dvec3& p = pos;
  F.t += dt;
  if (fallAir_) {
    v.y -= G * dt;
    p += v * dt;
    double gy = world_.groundHeight(p.x, p.z, p.y);
    if (p.y <= gy) {
      p.y = gy;
      normal = surfNormal(p.x, p.z, gy);
      double imp = std::max(0.0, -glm::dot(v, normal));
      v -= normal * glm::dot(v, normal);
      v *= std::max(0.2, 1 - imp * 0.05);
      fallAir_ = false;
      shake_ = std::max(shake_, 0.8);
      events.push_back({PlayerEvent::Type::Land, float(clamp(imp / 10, 0.3, 1))});
    }
  } else {
    dvec3 a = dvec3(0, -G, 0) + normal * (G * normal.y);
    v += a * dt;
    double s = glm::length(v);
    double stop = F.state == FallState::State::Tumble ? BODY_SLIDE : BODY_SLIDE * 1.3;
    if (s > 1e-4) v *= std::max(0.0, s - stop * dt) / s;
    if (F.state == FallState::State::GetUp || (F.state == FallState::State::Lie && s < 1)) v *= std::exp(-dt * 6);
    v -= normal * glm::dot(v, normal);
    p += v * dt;
    double gy = world_.groundHeight(p.x, p.z, p.y + 0.3);
    p.y = gy;
    normal = surfNormal(p.x, p.z, gy);
    v -= normal * glm::dot(v, normal);
  }
  collide(0, p.y);
  double sp = glm::length(v);
  int side = fallSide;
  if (F.state == FallState::State::Tumble) {
    bool settled = true;
    if (F.kind == FallState::Kind::Tumble) {
      if (!F.hasPitchTarget && (std::fabs(F.pitchVel) < 3.2 || (sp < 3 && F.t > 0.5))) {
        double rest = F.pitch + (F.pitchVel * std::fabs(F.pitchVel)) / (2 * 7);
        F.pitchTarget = std::round(rest / TAU) * TAU; F.hasPitchTarget = true;
      }
      if (!F.hasPitchTarget) {
        F.pitchVel *= std::exp(-dt * (fallAir_ ? 0.2 : 0.9));
        F.pitch += F.pitchVel * dt;
        settled = false;
      } else {
        springStep(F.pitch, F.pitchVel, F.pitchTarget, 6, dt);
        if (!F.hasRollTarget) { F.rollTarget = side * PI / 2; F.hasRollTarget = true; }
        settled = std::fabs(F.pitch - F.pitchTarget) < 0.05 && std::fabs(F.pitchVel) < 0.4;
      }
    } else if (F.kind == FallState::Kind::Roll) {
      if (!F.hasRollTarget && (std::fabs(F.rollVel) < 3 || (sp < 3 && F.t > 0.5))) {
        double rest = F.roll + (F.rollVel * std::fabs(F.rollVel)) / (2 * 7);
        F.rollTarget = std::round((rest - side * PI / 2) / TAU) * TAU + side * PI / 2; F.hasRollTarget = true;
      }
      if (!F.hasRollTarget) {
        F.rollVel *= std::exp(-dt * (fallAir_ ? 0.2 : 0.9));
        F.roll += F.rollVel * dt;
        settled = false;
      }
    } else if (!F.hasRollTarget) { F.rollTarget = side * PI / 2; F.hasRollTarget = true; }
    if (F.hasRollTarget) {
      springStep(F.roll, F.rollVel, F.rollTarget, F.kind == FallState::Kind::Slam ? 5.5 : 5, dt);
      settled = settled && std::fabs(F.roll - F.rollTarget) < 0.06 && std::fabs(F.rollVel) < 0.5;
    }
    bool spinning = std::fabs(F.pitchVel) + std::fabs(F.rollVel) > 3 && F.kind != FallState::Kind::Slam;
    F.ball = lerp(F.ball, spinning ? 1 : 0, 1 - std::exp(-dt * (spinning ? 8 : 3)));
    if ((settled && sp < 1.5 && F.t > 0.6 && !fallAir_) || F.t > 6) {
      F.state = FallState::State::Lie; F.lieT = 0;
      F.pitch -= std::round(F.pitch / TAU) * TAU; F.pitchVel = 0;
      F.roll = F.roll - std::round((F.roll - side * PI / 2) / TAU) * TAU; F.rollVel = 0;
      if (std::fabs(F.roll - side * PI / 2) > 0.2) F.roll = side * PI / 2;
      F.rollRest = F.roll;
    }
  } else if (F.state == FallState::State::Lie) {
    F.lieT += dt;
    F.ball = lerp(F.ball, 0, 1 - std::exp(-dt * 4));
    F.pitch *= std::exp(-dt * 5);
    if ((F.lieT > 0.55 && sp < 0.6) || F.lieT > 2.5) { F.state = FallState::State::GetUp; F.getUp = 0; }
  } else if (F.state == FallState::State::GetUp) {
    F.getUp = std::min(1.0, F.getUp + dt / GETUP_TIME);
    F.ball = lerp(F.ball, 0, 1 - std::exp(-dt * 6));
    F.pitch *= std::exp(-dt * 6);
    F.roll = F.rollRest * (1 - smoothstep(0, 0.62, F.getUp));
    if (F.getUp >= 1) {
      mode = skisOn ? PlayerMode::Ski : PlayerMode::Walk;
      vel = dvec3(0);
      air = ballistic = false; steer = edge = lean = 0;
      fall = FallState{};
      crouch = 0.45;
      parked = true;
    }
  }
}

// ---------------------------------------------------------------- walking
void Player::walkTick(double dt, const PlayerControls& c) {
  bool live = !c.frozen;
  double fw = live ? c.moveY : 0, sd = live ? c.moveX : 0;
  double yaw = view == View::First ? heading + lookYaw_ : camYaw_;
  dvec3 cf = view == View::First ? dvec3(std::sin(yaw), 0, std::cos(yaw)) : dvec3(-std::sin(yaw), 0, -std::cos(yaw));
  dvec3 cr = glm::cross(cf, dvec3(0, 1, 0));
  dvec3 dir = cf * fw + cr * sd;
  dvec3& p = pos;
  double feetY = p.y - footJumpY;
  double gx = (world_.height(p.x + 1, p.z) - world_.height(p.x - 1, p.z)) / 2;
  double gz = (world_.height(p.x, p.z + 1) - world_.height(p.x, p.z - 1)) / 2;
  double slope = std::hypot(gx, gz);
  double ux = slope > 1e-6 ? gx / slope : 0, uz = slope > 1e-6 ? gz / slope : 0;
  bool blocked = false;
  double dl = glm::length(dir);
  bool sprinting = live && dl > 0 && c.sprint;
  if (dl > 1e-3) {
    double mag = std::min(1.0, dl);
    dir /= dl;
    double want = std::atan2(dir.x, dir.z);
    double target = FOOT_SPEED * (sprinting ? SPRINT_K : 1) * mag;
    double up = dir.x * ux + dir.z * uz;
    if (up > 0 && slope > WALK_FULL) {
      double k = smoothstep(WALK_FULL, WALK_MAX, slope);
      dir.x -= ux * up * k; dir.z -= uz * up * k;
      target *= 1 - 0.4 * k * up;
      blocked = k > 0.97 && up > 0.6;
    }
    if (view != View::First) heading = approachAngleDamp(heading, want, dt * 10);
    vel = glm::mix(vel, dir * target, 1 - std::exp(-dt * 8));
  } else vel *= std::exp(-dt * 10);
  if (blocked) {
    if (steepT_ == 0) walkSlip_ = 0.55;
    steepT_ += dt; steepOkT_ = 0;
    if (steepT_ > 0.3 && !steepWarned_) { steepWarned_ = true; events.push_back({PlayerEvent::Type::TooSteep, 0}); }
  } else {
    steepT_ = 0;
    steepOkT_ += dt;
    if (steepOkT_ > 4) steepWarned_ = false;
  }
  if (view == View::First) { heading += lookYaw_; lookYaw_ = 0; }
  vel.y = 0;
  p += vel * dt;
  if (walkSlip_ > 0.01) { p.x -= ux * walkSlip_ * dt; p.z -= uz * walkSlip_ * dt; walkSlip_ *= std::exp(-dt * 4); }
  else walkSlip_ = 0;
  if (live && c.jumpPressed && !footAir_) { footJumpV_ = 4.4; footAir_ = true; }
  double ground = world_.groundHeight(p.x, p.z, feetY);
  if (footAir_) {
    footJumpY += footJumpV_ * dt;
    footJumpV_ -= 9.81 * dt;
    if (footJumpY <= 0) { footJumpY = 0; footAir_ = false; shake_ = 0.15; events.push_back({PlayerEvent::Type::Step, 1}); }
  }
  p.y = ground + footJumpY;
  collide(0, p.y + 0.02);
  footT_ += std::hypot(vel.x, vel.z) * dt;
  if (footT_ > 1.3) { footT_ = 0; events.push_back({PlayerEvent::Type::Step, 0.5f}); }
}

// ---------------------------------------------------------------- collisions
void Player::collide(double speed, double feetY, double above) {
  if (!scenery_) return;
  dvec3& p = pos;
  const double R = 0.35;
  const std::vector<int>* near = scenery_->hasResort() ? scenery_->collidersNear(p.x, p.z) : nullptr;
  size_t n = scenery_->hasResort() ? (near ? near->size() : 0) : scenery_->colliders().size();
  auto test = [&](const Collider& c) {
    if (c.top < 1e29 ? feetY > c.top : above > 2.5) return;
    double reach = (c.r >= 0 ? c.r : std::max(c.hw, c.hd)) + R;
    if (std::fabs(p.x - c.x) > reach || std::fabs(p.z - c.z) > reach) return;
    if (c.r >= 0) {
      double dx = p.x - c.x, dz = p.z - c.z, d = std::hypot(dx, dz);
      if (d < c.r + R) {
        double nx = dx / (d > 0 ? d : 1), nz = dz / (d > 0 ? d : 1);
        p.x = c.x + nx * (c.r + R); p.z = c.z + nz * (c.r + R);
        bounce(nx, nz, speed, c.soft);
      }
    } else {
      double cs = std::cos(-c.rot), sn = std::sin(-c.rot);
      double lx = (p.x - c.x) * cs - (p.z - c.z) * sn, lz = (p.x - c.x) * sn + (p.z - c.z) * cs;
      double ox = c.hw + R - std::fabs(lx), oz = c.hd + R - std::fabs(lz);
      if (ox > 0 && oz > 0) {
        double nlx = 0, nlz = 0;
        if (ox < oz) nlx = lx >= 0 ? 1 : -1; else nlz = lz >= 0 ? 1 : -1;
        double push = std::min(ox, oz);
        double c2 = std::cos(c.rot), s2 = std::sin(c.rot);
        double nx = nlx * c2 - nlz * s2, nz = nlx * s2 + nlz * c2;
        p.x += nx * push; p.z += nz * push;
        bounce(nx, nz, speed, c.soft);
      }
    }
  };
  for (size_t ci = 0; ci < n; ci++) test(scenery_->colliders()[near ? size_t((*near)[ci]) : ci]);
  for (const Collider& c : scenery_->dynamic) test(c);   // (Phase 3: vehicles)
  // rocks (player.js: vegetation.collide's rocks from BIG_ROCK up stop you, a jump clears their top; the lower ones are
  // skied over)
  if (const Rock* k = scenery_->rockAt(p.x, p.z, R, 2.6)) {
    if (!(feetY > double(k->y) + 0.75 * k->s)) {
      double dx = p.x - k->x, dz = p.z - k->z, d = std::hypot(dx, dz);
      if (d == 0) d = 1;
      p.x = k->x + dx / d * (k->r + R + 0.01); p.z = k->z + dz / d * (k->r + R + 0.01);
      bounce(dx / d, dz / d, speed, false);
    }
  }
  // trees: the trunk stops you; the boughs are a soft bump (player.js)
  if (above < 2.5) {
    if (const Tree* t = scenery_->treeAt(p.x, p.z, R, false)) {
      double dx = p.x - t->x, dz = p.z - t->z, d = std::hypot(dx, dz);
      if (d == 0) d = 1;
      p.x = t->x + dx / d * (t->trunk + R + 0.01); p.z = t->z + dz / d * (t->trunk + R + 0.01);
      bounce(dx / d, dz / d, speed, false);
    } else if (const Tree* t2 = scenery_->treeAt(p.x, p.z, R, true)) {
      double dx = p.x - t2->x, dz = p.z - t2->z, d = std::hypot(dx, dz);
      if (d == 0) d = 1;
      p.x = t2->x + dx / d * (t2->crown + R + 0.01); p.z = t2->z + dz / d * (t2->crown + R + 0.01);
      bounce(dx / d, dz / d, speed, true);
    }
  }
}

void Player::bounce(double nx, double nz, double speed, bool soft) {
  double vn = vel.x * nx + vel.z * nz;
  if (vn < 0 && soft) {
    double hard = -vn;
    vel.x -= nx * vn * 1.25; vel.z -= nz * vn * 1.25;
    vel *= std::max(0.45, 1 - hard * 0.035);
    if (hard > 3) { shake_ = std::max(shake_, std::min(0.5, hard / 16)); events.push_back({PlayerEvent::Type::Bump, float(std::min(1.0, hard / 14))}); }
    return;
  }
  if (vn < 0) {
    if (mode == PlayerMode::Ski && -vn > CRASH_HIT) {
      double hard = -vn;
      vel.x -= nx * vn * 1.3; vel.z -= nz * vn * 1.3;
      vel *= 0.3;
      crash(rnd01() < 0.5 ? -1 : 1, hard > 12 ? FallState::Kind::Roll : FallState::Kind::Slam, true);
    } else { vel.x -= nx * vn; vel.z -= nz * vn; }
  }
}

// ---------------------------------------------------------------- per frame: animation targets + camera
void Player::animateSki(double dt) {
  dvec3 v = vel;
  double sp = glm::length(v), vh = std::hypot(v.x, v.z);
  double velYaw = vh > 0.5 ? std::atan2(v.x, v.z) : heading;
  double turn = !air && vh > 1 ? wrapPi(velYaw - prevVelYaw_) / std::max(dt, 1e-4) : 0;
  prevVelYaw_ = velYaw;
  turnRate_ = lerp(turnRate_, clamp(turn, -4, 4), 1 - std::exp(-dt * 12));
  double aLat = vh * turnRate_;
  double inclT = air ? 0 : clamp(-std::atan2(aLat, G) * 0.85 - steer * 0.1 * smoothstep(1, 6, vh), -0.95, 0.95);
  bool brake = ctl_.brake && !air;
  double plowT = brake ? 1 - smoothstep(6, 9, sp) : 0;
  double skidT = brake ? smoothstep(4.5, 9, sp) : 0;
  plow = lerp(plow, plowT, 1 - std::exp(-dt * 6));
  if (skidT > 0.05 && skidAmt_ < 0.05) skidSide_ = std::fabs(steer) > 0.2 ? sign(steer) : lastTurnSide_;
  else if (brake && std::fabs(steer) > 0.3) skidSide_ = sign(steer);
  skidAmt_ = lerp(skidAmt_, skidT, 1 - std::exp(-dt * (skidT > skidAmt_ ? 7 : 5)));
  skidYaw = lerp(skidYaw, skidSide_ * 1.05 * skidT, 1 - std::exp(-dt * 7));
  if (skidAmt_ > 0.05) inclT = lerp(inclT, -sign(skidYaw) * 0.45, skidAmt_);
  edge = lerp(edge, inclT, 1 - std::exp(-dt * 10));
  lean = clamp(edge / 0.8, -1, 1);
  double slip = !air && vh > 1.5 ? std::fabs(std::sin(wrapPi(velYaw - heading))) : 0;
  sideslip = lerp(sideslip, std::max(std::max(slip * 1.3, skidAmt_ * 0.9), plow * 0.4), 1 - std::exp(-dt * 12));
  tuck = ctl_.tuck && sp > W_PUSH_V - 1 && !air;
  popT_ += dt;
  double crouchT = tuck ? 0.21 : brake ? 0.3 : 0.16 + std::fabs(steer) * 0.07 + std::fabs(edge) * 0.06;
  if (charging && !air) crouchT = 0.3 + 0.62 * charge;
  if (air) crouchT = 0.32;
  bool extend = popT_ < 0.16;
  if (extend) crouchT = -0.15;
  crouch = lerp(crouch, crouchT, 1 - std::exp(-dt * (extend ? 26 : charging ? 9 : 7)));
  absorbV += (-60 * absorb - 15.5 * absorbV) * dt;
  absorb = clamp(absorb + absorbV * dt, 0, 0.8);
  if (absorb == 0 && absorbV < 0) absorbV = 0;
  if (yawFx != 0 && !air) {
    springStep(yawFx, yawFxV, 0, 8.5, dt);
    if (std::fabs(yawFx) < 0.002 && std::fabs(yawFxV) < 0.02) { yawFx = 0; yawFxV = 0; }
  }
  // pole plants (player.js): at turn initiation, or rhythmic double-poling when pushing off; holding W at speed now
  // and then a double-pole push
  double sg = sign(std::round(steer * 1.5));
  if (sg != 0 && sg != lastSteerSign_ && sp > 3 && !air && !tuck && skidAmt_ < 0.3) polePlants.push_back(int8_t(sg > 0 ? 0 : 1));
  lastSteerSign_ = sg;
  if (sg != 0) lastTurnSide_ = sg;
  bool launching = launch_ > 0 && sp < LAUNCH_V;
  bool pushing = (ctl_.go && sp < W_PUSH_V - 1) || launching;
  if (pushing && !air && !ctl_.brake && !parked) {
    skatePhase_ += dt * (launching ? 2.3 : 1.6);
    if (skatePhase_ > 1) { skatePhase_ = 0; polePlants.push_back(0); polePlants.push_back(1); }
  } else skatePhase_ = 0.7;
  if (tuck && !air && sp < 14 && !parked && !ctl_.brake) {
    tuckPoleT_ -= dt;
    if (tuckPoleT_ <= 0) { tuckPoleT_ = 1.7 + rnd01() * 1.1; polePlants.push_back(0); polePlants.push_back(1); }
  } else tuckPoleT_ = 0.5;
}

void Player::frameUpdate(double dt, double alpha, const PlayerFrameControls& f, const PlayerControls& c) {
  if (f.toggleView) view = view == View::Third ? View::First : View::Third;
  if (f.toggleSkis && !c.frozen && hasSkis && (mode == PlayerMode::Walk || (mode == PlayerMode::Ski && !air && speed() < 2)))
    setSkisOn(!skisOn);
  const double sens = 0.0022;
  if (view == View::First) {
    lookYaw_ -= f.lookX * sens;
    lookPitch_ = clamp(lookPitch_ - f.lookY * sens, -1.3, 1.2);
    if (mode == PlayerMode::Ski) lookYaw_ = clamp(lookYaw_, -2.0, 2.0);
  } else {
    camYaw_ -= f.lookX * sens;
    camPitch_ = clamp(camPitch_ - f.lookY * sens, -1.2, 0.6);
    camDist_ = clamp(camDist_ - f.wheel * 0.5, 2.2, 12);
  }
  renderPos = mode == PlayerMode::Sit ? pos : glm::mix(prevPos, pos, alpha);
  if (mode == PlayerMode::Ski) animateSki(dt);
  updateCamera(dt, f);
}

void Player::updateCamera(double dt, const PlayerFrameControls& f) {
  double sp = speed();
  camDipV_ += (-90 * camDip_ - 15 * camDipV_) * dt;
  camDip_ = clamp(camDip_ + camDipV_ * dt, -0.9, 0.5);
  shake_ = std::max(0.0, shake_ - dt * 2.5);
  fovKick_ = std::max(0.0, fovKick_ - dt * 2.5);
  double longAir = air && airTime > 0.25 ? 1 : 0;
  airBlend_ = lerp(airBlend_, longAir, 1 - std::exp(-dt * (longAir ? 2.5 : 4)));
  double fast = mode == PlayerMode::Ski && !air ? smoothstep(15, 36, sp) : 0;
  double vh = std::hypot(vel.x, vel.z);
  const bool sit = mode == PlayerMode::Sit;
  if (vh > 1.5 && !sit) travelYaw_ = dampAngle(travelYaw_, std::atan2(vel.x, vel.z), dt * (air ? 3 : 6));
  else if (mode != PlayerMode::Fall) travelYaw_ = dampAngle(travelYaw_, heading, dt * 4);
  camShake_ = f.camShake;
  // first person: a wipeout pulls the camera out of your head to watch the tumble from behind (third-person camera);
  // you're back in your eyes when you're up again
  updateFpCrash();
  if (f.lookX != 0 || f.lookY != 0) followNow_ = false;
  if (view == View::First && !fpCrash_) { updateFirstPerson(dt, f, sp); return; }
  if (mode != PlayerMode::Walk && (followNow_ || f.now - f.lastLook > 1.2)) {
    double d = wrapPi(travelYaw_ + PI - camYaw_);
    double rate = sit ? 2.2 : air ? 1.3 : mode == PlayerMode::Fall ? 0.8 : 2.0 + fast * 1.5;
    camYaw_ += d * (1 - std::exp(-dt * rate));
    camPitch_ = lerp(camPitch_, -0.16 - airBlend_ * 0.1 - fast * 0.03, 1 - std::exp(-dt * 1.5));
  }
  bool skiing = mode == PlayerMode::Ski;
  double ahead = skiing ? std::min(1.3, vh * 0.045) : 0;
  dvec3 a(vel.x, 0, vel.z);
  if (vh > 0.1) a *= ahead / vh;
  camLook_ = glm::mix(camLook_, a, 1 - std::exp(-dt * 4));
  double focusH = sit ? 0.6 : mode == PlayerMode::Fall ? 0.85 : 1.45 - (skiing ? clamp(crouch, 0, 1) * 0.25 : 0);
  double fy = renderPos.y + focusH;
  if (!camFocusInit_ || std::fabs(camFocusY_ - fy) > 40) { camFocusY_ = fy; camFocusInit_ = true; }
  camFocusY_ = lerp(camFocusY_, fy, 1 - std::exp(-dt * (sit ? 60 : air ? 9 : 14)));
  camFocusY_ = clamp(camFocusY_, fy - 2.5, fy + 2.5);
  camFocus_ = dvec3(renderPos.x + camLook_.x, camFocusY_ + camDip_ * 0.5, renderPos.z + camLook_.z);
  double dist = (sit ? std::max(camDist_, 8.0) : camDist_) + clamp(sp - 12, 0, 25) * 0.04 + airBlend_ * 0.9 + (mode == PlayerMode::Fall ? 0.6 : 0);
  dvec3 desired(camFocus_.x + std::sin(camYaw_) * std::cos(camPitch_) * dist, camFocus_.y - std::sin(camPitch_) * dist + 0.3,
                camFocus_.z + std::cos(camYaw_) * std::cos(camPitch_) * dist);
  double gy = world_.groundHeight(desired.x, desired.z) + 0.5;
  if (desired.y < gy) desired.y = gy;
  double mx = (desired.x + camFocus_.x) / 2, mz = (desired.z + camFocus_.z) / 2, my = (desired.y + camFocus_.y) / 2;
  double gm = world_.groundHeight(mx, mz) + 0.35;
  if (my < gm) desired.y += (gm - my) * 2;
  // riding a lift (possibly fast-forwarded): follow tightly so the view never trails the cabin
  camPos_ = glm::mix(camPos_, desired, 1 - std::exp(-dt * (sit ? 60 : 12)));
  double fov = f.fovSetting + clamp(sp - 10, 0, 30) * 0.4 + fovKick_ * 2 + airBlend_ * 2;
  camFov_ = lerp(camFov_, fov, 1 - std::exp(-dt * 3));
}

void Player::cameraFor(Camera& cam) const {
  double t = time_;
  double fast = mode == PlayerMode::Ski && !air ? smoothstep(15, 36, speed()) : 0;
  double vib = camShake_ ? fast * 0.009 + shake_ * 0.05 : 0;
  dvec3 jit((std::sin(t * 57) * 0.6 + std::sin(t * 31.7 + 1) * 0.4) * vib, (std::sin(t * 49 + 2) * 0.6 + std::sin(t * 23.3) * 0.4) * vib,
            (std::sin(t * 43 + 4) * 0.6 + std::sin(t * 37.1 + 3) * 0.4) * vib);
  cam.fovY = float(camFov_);
  if (view == View::First && !fpCrash_) {
    // (the helmet cam: its own buzz and roll, no third-person jitter; the camera's frame straight from the quaternion)
    cam.nearZ = float(FP_NEAR);
    cam.pos = camPos_;
    cam.basis = mat3(glm::mat3_cast(glm::quat(fpQ_)));
  } else {
    cam.nearZ = 0.1f;
    dvec3 eye = camPos_ + jit + dvec3(0, camDip_, 0);
    cam.lookAt(eye, camFocus_);
  }
}

void Player::noteCamera(const Camera& cam) {
  lastCamP_ = cam.pos;
  lastCamQ_ = glm::dquat(glm::quat_cast(cam.basis));
}

// player.js updateFpCrash: first person, wiping out: the third-person camera takes over for the fall, starting just
// behind your head and pulling out to watch the tumble; when you're up again the first-person view eases back in.
// (Picked up off the snow by the rescue helicopter's winch you stay in view too.)
void Player::updateFpCrash() {
  bool on = view == View::First && (mode == PlayerMode::Fall || (fpCrash_ && mode == PlayerMode::Sit));
  if (on == fpCrash_) return;
  fpCrash_ = on;
  if (on) {
    const dvec3 c = lastCamP_;
    double vh = std::hypot(vel.x, vel.z);
    travelYaw_ = vh > 1.5 ? std::atan2(vel.x, vel.z) : heading;
    camPos_ = dvec3(c.x - std::sin(travelYaw_) * 0.8, c.y + 0.3, c.z - std::cos(travelYaw_) * 0.8);
    camYaw_ = travelYaw_ + PI; camPitch_ = -0.22;
    camFocusInit_ = false; camLook_ = dvec3(0); followNow_ = true;
  } else fpCam_.mode = 99;   // (a mode change: the view eases over)
}

// player.js updateFirstPerson: a helmet cam. Skiing: the eyes of your own (visible) body over the boots, so looking
// down shows your legs on the bindings. On foot and seated: the eyes of the walking / sitting body. The eye is the
// posed head, smoothed relative to the feet (no lag at speed, no jitter from the pose).
void Player::updateFirstPerson(double dt, const PlayerFrameControls& f, double sp) {
  FpCam& S = fpCam_;
  const double h = clamp(dt, 0, 0.05);
  const bool skiing = mode == PlayerMode::Ski, sit = mode == PlayerMode::Sit;
  S.t += h;
  // a change of mode (back up after a wipeout, clicking into the skis, sitting down) would jump the view: ease over
  if (S.mode != int(mode)) {
    if (S.mode != -1) { S.fromQ = lastCamQ_; S.fromP = lastCamP_; S.blend = 0; }
    S.mode = int(mode);
  }
  // ---- the eye: your own head as posed, relative to the feet, smoothed (springs)
  dvec3 tgt = fpRig.ok ? fpRig.eyeOff : dvec3(0, FP_EYE_H, 0);
  if (glm::dot(tgt, tgt) > 9) tgt = dvec3(0, FP_EYE_H, 0);   // (no pose yet)
  if (!S.init || glm::dot(tgt - S.off, tgt - S.off) > 2.25) { S.off = tgt; S.offV = dvec3(0); S.init = true; }
  const double wH = skiing ? 40 : sit ? 18 : 16, wV = skiing ? 32 : sit ? 18 : 13;
  spring(S.off.x, S.offV.x, tgt.x, wH, h);
  spring(S.off.y, S.offV.y, tgt.y, wV, h);
  spring(S.off.z, S.offV.z, tgt.z, wH, h);
  // never more than a couple of centimetres behind the head: the eye stays in front of the (collapsed) head
  dvec3 lag = S.off - tgt;
  const double maxLag = skiing ? 0.02 : 0.04;
  if (glm::dot(lag, lag) > maxLag * maxLag) S.off = tgt + lag * (maxLag / glm::length(lag));
  dvec3 eye = renderPos + S.off;
  eye.y += camDip_ * 0.3;
  // the head goes with the hands: a pole push dips it a little forward and down
  if (skiing) {
    double push = 0;
    for (double pt : fpRig.plantT) if (pt < 1) push = std::max(push, sstep(0, 0.25, pt) * (1 - sstep(0.35, 0.85, pt)));
    eye.y -= 0.03 * push;
    eye.x += std::sin(heading) * 0.04 * push; eye.z += std::cos(heading) * 0.04 * push;
  }
  // ---- where you look: the skis' heading, a little ahead into a turn, plus the mouse
  const double yaw0 = heading + (skiing ? yawFx : 0);
  // looking down tips the head forward over the chest: the eyes come forward and down a little
  const double nod = sstep(0.45, 1.4, -(fpBase_ + lookPitch_));
  if (nod > 0) { double yl = yaw0 + lookYaw_; eye.x += std::sin(yl) * 0.085 * nod; eye.z += std::cos(yl) * 0.085 * nod; eye.y -= 0.03 * nod; }
  const double leadT = skiing && !air ? clamp(turnRate_ * FP_LEAD, -FP_LEAD_MAX, FP_LEAD_MAX) * sstep(3, 9, sp) : 0;
  spring(S.lead, S.leadV, leadT, 6.5, h);
  // the pitch of the snow along the way you're going (look down a steep run), in the air the flight path
  double slope = 0;
  if (skiing) {
    double fx = std::sin(yaw0), fz = std::cos(yaw0);
    const dvec3& n = normal;
    const dvec3& v = vel;
    slope = air ? 0.7 * clamp(std::atan2(v.y, std::max(2.0, std::hypot(v.x, v.z))), -0.75, 0.45) : std::atan2(-(n.x * fx + n.z * fz), n.y);
  }
  fpSlope_ = lerp(fpSlope_, slope, 1 - std::exp(-h * (air ? 2.5 : 3)));
  // base look-down eases in when you click into the skis, out when you walk
  fpBase_ = lerp(fpBase_, skiing ? FP_PITCH + FP_SLOPE_PITCH * fpSlope_ : 0, 1 - std::exp(-h * 4));
  double pitch = fpBase_ + lookPitch_ - absorb * 0.2;
  if (skiing && popT_ < 0.25) pitch += 0.05 * std::sin((popT_ / 0.25) * PI);   // the pop lifts the head
  // the head banks a little into the carve (never more than a few degrees: a steady horizon)
  const double bankT = skiing && !air ? clamp(-edge * FP_BANK, -FP_BANK_MAX, FP_BANK_MAX) : 0;
  spring(S.roll, S.rollV, bankT, 5.5, h);
  const double roll = S.roll;
  pitch = clamp(pitch, -1.25, 1.3);
  // looking down, the eye goes forward and a little down with the head, so the camera is never inside the collar
  if (pitch < -0.55) {
    double k = sstep(-0.55, -1.25, pitch), fy = yaw0 + S.lead + lookYaw_;
    eye.x += std::sin(fy) * 0.16 * k; eye.z += std::cos(fy) * 0.16 * k; eye.y -= 0.05 * k;
  }
  // speed: a fine buzz through the skis (more when skidding), and the shake of hard landings
  const double fast = skiing && !air ? sstep(14, 34, sp) : 0;
  const double chatter = skiing && !air ? clamp(sideslip, 0, 1) * sstep(5, 14, sp) : 0;
  const double amp = f.camShake ? fast * 0.0022 + chatter * 0.0035 + shake_ * 0.014 : 0;
  const double t = S.t;
  auto buzz = [&](double a, double b, double c) { return (std::sin(t * a + c) * 0.6 + std::sin(t * b + c * 1.7) * 0.4) * amp; };
  glm::dquat q = eulerYXZ(pitch + buzz(71, 43.7, 0.3), yaw0 + S.lead + lookYaw_ + PI + buzz(53, 31.3, 1.9) * 0.5, roll + buzz(59, 37.1, 4.1) * 0.7);
  // flips: the helmet cam goes round with you, about the body's center (the rig turns the body the same way)
  const double fl = skiing ? flip : 0;
  if (fl != 0 && fpRig.hasFlipC) {
    const double hd = airTravel_;
    const dvec3 C = renderPos + fpRig.flipCOff;
    const glm::dquat fq = three::axisAngle(dvec3(-std::cos(hd), 0, std::sin(hd)), -fl);
    q = three::mul(fq, q);
    eye = three::applyQ(eye - C, fq) + C;
  }
  // ease over a mode change (rotations; positions only when they didn't jump: a teleport or the crash camera)
  if (S.blend < 1) {
    S.blend = std::min(1.0, S.blend + h / 0.3);
    const double k = sstep(0, 1, S.blend);
    q = three::slerp(S.fromQ, q, k);
    if (glm::dot(S.fromP - eye, S.fromP - eye) < 4) eye = S.fromP + (eye - S.fromP) * k;
  }
  camPos_ = eye;
  fpQ_ = q;
  const double fov = FP_FOV + (f.fovSetting - 65) + clamp(sp - 10, 0, 30) * FP_FOV_SPEED + fovKick_ * 2.5;
  camFov_ = lerp(camFov_, fov, 1 - std::exp(-h * 3));
  // when not dragging the mouse, the view slowly re-centers on the skis while skiing
  if (skiing && f.now - f.lastLook > 1.5) {
    lookYaw_ *= std::exp(-dt * 1.5);
    lookPitch_ *= std::exp(-dt * 1.0);
  }
}

} // namespace sl
