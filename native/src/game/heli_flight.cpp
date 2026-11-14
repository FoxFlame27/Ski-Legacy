#include "game/heli_flight.h"
#include <algorithm>
#include <cmath>

namespace sl {

using namespace heli;

namespace {
constexpr double G = 9.81;
constexpr double LOOK[4] = {0.5, 1.0, 1.8, 3.0};   // look-out times ahead (s)

// critically damped spring toward `to`
void spring(double& x, double& v, double to, double w, double dt) {
  double d = x - to, e = std::exp(-w * dt), c = v + w * d;
  x = to + (d + c * dt) * e;
  v = (v - c * w * dt) * e;
}
} // namespace

void HeliFlight::place(double x, double z, double yaw_, const GroundFn& ground) {
  yaw = yaw_; yawRate = 0; u = 0; accel = 0;
  vel = dvec3(0);
  landed = true; steep = false;
  pos = dvec3(x, 0, z);
  settle(ground, 1);
  pitch = landPitch; roll = landRoll; pitchV = rollV = 0;
  updateQuat();
}

// ground under the skids: heights at the four skid ends -> resting height + attitude
double HeliFlight::settle(const GroundFn& ground, double k) {
  double fx = std::sin(yaw), fz = std::cos(yaw), lx = fz, lz = -fx;   // forward, left
  double hl = fr.skidL / 2, hw = fr.skidW / 2, z0 = fr.skidZ;
  auto h = [&](double a, double b) { return ground(pos.x + fx * a + lx * b, pos.z + fz * a + lz * b); };
  double fl = h(z0 + hl, hw), frr = h(z0 + hl, -hw), bl = h(z0 - hl, hw), br = h(z0 - hl, -hw);
  double front = (fl + frr) / 2, back = (bl + br) / 2, left = (fl + bl) / 2, right = (frr + br) / 2;
  landPitch = clamp(std::atan2(back - front, fr.skidL), -0.3, 0.3);    // nose down when the ground falls ahead
  landRoll = clamp(std::atan2(left - right, fr.skidW), -0.3, 0.3);     // right side down when it falls to the right
  double rest = std::max(std::max(fl, frr), std::max(bl, br)) - 0.04 * std::fabs(landPitch + landRoll);
  double y = std::max((front + back) / 2, rest - 0.12) + fr.cgH;
  pos.y += (y - pos.y) * k;
  groundY = (front + back) / 2;
  return std::max(std::fabs(back - front) / fr.skidL, std::fabs(left - right) / fr.skidW);
}

void HeliFlight::step(double dt, const HeliCtl& ctl, const GroundFn& ground, double power) {
  groundFn = ground;
  int n = std::max(1, int(std::ceil(dt / (1.0 / 60) - 1e-9)));
  for (int i = 0; i < n; i++) sub(dt / n, ctl, ground, power);
  updateQuat();
}

void HeliFlight::sub(double dt, const HeliCtl& ctl, const GroundFn& ground, double power) {
  t += dt;
  dvec3& p = pos; dvec3& v = vel;
  double sp = std::hypot(v.x, v.z);
  double lift = power >= POWER ? ctl.lift : std::min(0.0, ctl.lift);

  if (landed) {
    // on the skids: nothing turns or slides; Space with the rotor up to speed lifts off
    yawRate *= std::exp(-dt * 10); u = 0;
    v.x *= std::exp(-dt * 8); v.z *= std::exp(-dt * 8); v.y = 0;
    double st = settle(ground, 1 - std::exp(-dt * 12));
    agl = 0;
    springAttitude(dt, landPitch, landRoll, 9);
    if (lift > 0.05) { landed = false; v.y = 1.2; p.y += 0.05; }
    else if (st > LAND_SLOPE * 1.25) { landed = false; steep = true; v.y = 0.8; }
    return;
  }

  // ---- yaw: pedal turns in the hover, wide banked turns at speed
  double rate = TURN + (TURN_FAST - TURN) * smooth(4, 50, sp);
  yawRate += (ctl.turn * rate - yawRate) * (1 - std::exp(-dt / TURN_TAU));
  yaw = heli::wrapPi(yaw + yawRate * dt);

  // ---- forward airspeed
  double u0 = u, uu = u;
  if (ctl.fwd > 0) uu += ACC * ctl.fwd * (1 - 0.65 * std::pow(std::max(0.0, uu) / MAX_FWD, 2)) * dt;
  else if (ctl.fwd < 0) uu += (uu > 0 ? -BRAKE : -BACK_ACC) * -ctl.fwd * dt;
  else uu -= sign(uu) * std::min(std::fabs(uu), (COAST + DRAG * uu * uu) * dt);
  uu = clamp(uu, -MAX_BACK, MAX_FWD);

  // ---- vertical: commanded climb / sink, the ceiling and the ground cushion
  double g0 = ground(p.x, p.z);
  groundY = g0;
  double aglNow = p.y - fr.cgH - g0;
  double vyT = lift > 0 ? CLIMB * lift : lift < 0 ? SINK * lift : 0;   // (the autopilot may sink a little faster than -1)
  if (aglNow > AGL_MAX - 80) vyT = std::min(vyT, (AGL_MAX - aglNow) * 0.12);
  if (vyT < 0 && aglNow < 9) vyT = std::max(vyT, -(0.45 + aglNow * 0.7));   // ground cushion: touch down gently

  // ---- look-out: climb over what's ahead of the nose (and brake when it rises faster than we can climb). Slow, the
  // clearance shrinks to nothing so you can still set down anywhere.
  double fx = std::sin(yaw), fz = std::cos(yaw);
  double need = -1e300, needT = 1;
  double clear = clamp((sp - 4) * 0.25, 0.0, 12.0);
  for (double tt : LOOK) {
    if (sp * tt < 3) continue;
    double y = ground(p.x + v.x * tt + fx * fr.nose[0], p.z + v.z * tt + fz * fr.nose[0]) + fr.cgH - fr.nose[1] + clear * std::min(1.0, tt);
    double vy = (y - p.y) / tt;
    if (vy > need) { need = vy; needT = tt; }
  }
  // near field: a slope rising right in front of the nose or under the rotor ahead -> stop and climb
  if (uu > 0 || sp > 0.5) {
    double yN = ground(p.x + fx * (fr.nose[0] + 2.5), p.z + fz * (fr.nose[0] + 2.5)) + fr.cgH - fr.nose[1] + 0.8;
    double yR = ground(p.x + fx * (fr.rotor[0] + 1.5), p.z + fz * (fr.rotor[0] + 1.5)) + fr.cgH - fr.rotor[1] + 1.2;
    double y = std::max(yN, yR);
    if (y > p.y - 0.5) {
      double vy = std::min(7.0, (y - p.y + 0.5) * 2.5 + 1.5);
      if (vy > need) { need = vy; needT = 0.5; }
      if (uu > 0) uu = std::max(0.0, uu - BRAKE * 1.6 * dt);
    }
  }
  climbAssist = 0;
  double vAcc = std::fabs(vyT) < std::fabs(v.y) && vyT * v.y >= 0 ? V_STOP : V_ACC;
  if (need > vyT) {
    climbAssist = clamp(need / 10, 0.0, 1.0);
    vyT = std::min(need, 18.0);
    vAcc = 16 + 10 / needT;
    if (need > 14) uu -= BRAKE * clamp((need - 14) / 8, 0.0, 1.6) * dt * sign(uu);
  }
  // a slope too steep to settle on: hold a low hover over it instead
  bool stp = aglNow < 3 && sp < 4 ? slopeAt(ground) > LAND_SLOPE : false;
  steep = stp;
  if (stp) vyT = std::max(vyT, (1.1 - aglNow) * 2);
  // somewhere the skids may not go (trees, buildings, nets, lift lines): stay above it
  if (hold > 0 && aglNow < hold + 2) vyT = std::max(vyT, (hold - aglNow) * 1.2);
  v.y += clamp(vyT - v.y, -vAcc * dt, vAcc * dt);

  // ---- horizontal: the path follows the nose with a little drift
  u = uu;
  double k = 1 - std::exp(-dt * DRIFT);
  v.x += (fx * uu - v.x) * k; v.z += (fz * uu - v.z) * k;
  accel += ((uu - u0) / dt - accel) * (1 - std::exp(-dt * 6));

  p += v * dt;

  // ---- contact: no part of the airframe (skids, nose, tail, rotor tips) goes into the snow, at any height and speed
  double g1 = ground(p.x, p.z), skids = g1 + fr.cgH;
  double floor = std::max(skids, hullFloor(ground));
  if (p.y <= floor) {
    // ran into a face (not a touchdown): the speed into it goes, so it stops against the slope and climbs
    if (floor - p.y > 0.25 && sp > 3) {
      double kk = std::exp(-dt * 8);
      v.x *= kk; v.z *= kk; if (u > 0) u *= kk;
    }
    p.y = floor;
    if (v.y < 0) v.y = 0;
    // settle onto the skids when slow and not climbing (never on a steep slope, nor while the nose, tail or rotor
    // would touch the hillside first)
    if (lift <= 0.05 && sp < 5 && !steep && !(hold > 0) && floor - skids < 0.5) {
      landed = true; u = 0; yawRate = 0;
      settle(ground, 0);
    }
  }
  agl = std::max(0.0, p.y - fr.cgH - g1);

  // ---- attitude: nose down to speed up, flare to brake, bank into turns, a slight hover wobble
  double sp2 = std::hypot(v.x, v.z);
  double pitchT = 0.0022 * uu + 0.022 * accel;
  double rollT = -std::atan(clamp(sp2 * yawRate / G, -0.6, 0.6));
  double lat = v.x * fz - v.z * fx;   // drift to the left (+)
  rollT -= clamp(lat * 0.025, -0.12, 0.12);
  double air = smooth(0.2, 3, agl);
  pitchT = clamp(pitchT, -0.3, 0.34) + (0.006 * std::sin(t * 1.3) + 0.004 * std::sin(t * 2.9 + 1)) * air;
  rollT = clamp(rollT, -0.55, 0.55) + (0.008 * std::sin(t * 1.1 + 2) + 0.004 * std::sin(t * 3.3)) * air;
  // just above the snow the skids level with it
  if (agl < 1.2) { settle(ground, 0); pitchT += (landPitch - pitchT) * (1 - agl / 1.2); rollT += (landRoll - rollT) * (1 - agl / 1.2); }
  springAttitude(dt, pitchT, rollT, 4.2);
}

void HeliFlight::clampTerrain(const GroundFn& ground) {
  if (landed) return;
  double floor = std::max(ground(pos.x, pos.z) + fr.cgH, hullFloor(ground));
  if (pos.y < floor) { pos.y = floor; if (vel.y < 0) vel.y = 0; }
}

void HeliFlight::springAttitude(double dt, double pitchT, double rollT, double w) {
  spring(pitch, pitchV, pitchT, w, dt);
  spring(roll, rollV, rollT, w, dt);
}

// lowest centre-of-mass height at which nose, tail, stabilizer and rotor tips all clear the snow
double HeliFlight::hullFloor(const GroundFn& ground) const {
  double c = fr.cgH, fx = std::sin(yaw), fz = std::cos(yaw);
  auto at = [&](double a, double b, double up) { return ground(pos.x + fx * a + fz * b, pos.z + fz * a - fx * b) + c - up; };
  double y = std::max(std::max(at(fr.nose[0], 0, fr.nose[1]), at(fr.tail[0], 0, fr.tail[1])), std::max(at(fr.stab[0], fr.stab[1], fr.stab[2]), at(fr.stab[0], -fr.stab[1], fr.stab[2])));
  double r = fr.rotor[0];
  for (int k = 0; k < 6; k++) {
    double a = yaw + (k * PI) / 3;
    y = std::max(y, ground(pos.x + std::sin(a) * r, pos.z + std::cos(a) * r) + c - fr.rotor[1]);
  }
  return y;
}

double HeliFlight::slopeAt(const GroundFn& ground) const {
  const double e = 2.5;
  double gx = (ground(pos.x + e, pos.z) - ground(pos.x - e, pos.z)) / (2 * e), gz = (ground(pos.x, pos.z + e) - ground(pos.x, pos.z - e)) / (2 * e);
  return std::hypot(gx, gz);
}

void HeliFlight::updateQuat() {
  // THREE.Euler(pitch, yaw, roll, 'YXZ'): q = qY(yaw) * qX(pitch) * qZ(roll)
  quat = glm::angleAxis(yaw, dvec3(0, 1, 0)) * glm::angleAxis(pitch, dvec3(1, 0, 0)) * glm::angleAxis(roll, dvec3(0, 0, 1));
}

// ---------------------------------------------------------------- the autopilot
namespace {
constexpr double CLIMB_RATE = 13, STEP = 20;
struct Ahead { double y = -1e300, u = 1e300; };
// The autopilot's look-out: the ground every 20 m along the track to the goal (and along where it is actually
// heading) out to 250..600 m; the height to hold so it passes ~90 m over every ridge, tapering to 35 m over the last
// stretch; u: the most airspeed that still leaves time to climb over the highest point ahead (~13 m/s up).
Ahead terrainAhead(const HeliFlight& f, double gx, double gz, double d) {
  Ahead T;
  const GroundFn& gr = f.groundFn;
  if (!gr) return T;
  const dvec3& p = f.pos;
  double sp = std::hypot(f.vel.x, f.vel.z);
  double range = clamp(sp * 7, 250.0, 600.0);
  auto need = [&](double x, double z, double s, double left) {
    double y = gr(x, z) + f.fr.cgH + 35 + std::min(55.0, std::max(0.0, left - 30) * 0.3);
    if (y > T.y) T.y = y;
    double rise = y - p.y;
    if (rise > 0) T.u = std::min(T.u, std::max(9.0, (CLIMB_RATE * s) / rise));
  };
  if (d > 30) {
    double ux = (gx - p.x) / d, uz = (gz - p.z) / d;
    for (double s = STEP; s <= range && d - s > 30; s += STEP) need(p.x + ux * s, p.z + uz * s, s, d - s);
  }
  // where it is heading now (turning toward the goal, the path is not yet on the track)
  if (sp > 4 && d > 60) {
    double vx = f.vel.x / sp, vz = f.vel.z / sp, r = std::min(std::min(range, sp * 4), d - 30);
    for (double s = STEP; s <= r; s += STEP) {
      double x = p.x + vx * s, z = p.z + vz * s;
      need(x, z, s, std::hypot(gx - x, gz - z));
    }
  }
  return T;
}
} // namespace

void heliAutopilot(const HeliFlight& f, const HeliGoal& goal, HeliCtl& out) {
  const dvec3& p = f.pos;
  double dx = goal.x - p.x, dz = goal.z - p.z, d = std::hypot(dx, dz);
  double stop = goal.stop;
  double yD = goal.hasY ? goal.y : f.groundY + f.fr.cgH + (goal.hasAgl ? goal.agl : 30);
  // terrain look-ahead: never below the hills ahead (and the trees on them) on the way to the goal
  Ahead T = terrainAhead(f, goal.x, goal.z, d);
  yD = std::max(yD, T.y);
  // speed: cruise, slowing down so we can stop at the goal (v^2 = 2 a s); the path lags the nose a little: start
  // braking that much earlier; slower still when a ridge ahead needs more climb than there is room for
  double lead = std::hypot(f.vel.x, f.vel.z) * 0.6;
  double uD = d < stop ? 0 : std::min(std::min(goal.speed, T.u), std::sqrt(2 * goal.decel * std::max(0.0, d - stop - lead)) + 0.4);
  // there: hold the spot and turn to the parking heading
  double want = d < stop && goal.hasYaw ? goal.yaw : std::atan2(dx, dz);
  double err = heli::wrapPi(want - f.yaw);
  out.turn = clamp(err * 2.4, -1.0, 1.0);
  // only push forward when roughly facing the goal
  double facing = std::cos(err);
  out.fwd = clamp((uD * std::max(0.0, facing) - f.u) * 0.6, -1.0, 1.0);
  out.lift = clamp((yD - p.y) * 0.18, -1.0, 1.0);
}

HeliCtl HeliHomePilot::update(const HeliFlight& f, double dt) {
  HeliCtl o;
  t += dt;
  double d = std::hypot(pad.x - f.pos.x, pad.z - f.pos.z);
  double padY = pad.y + f.fr.cgH;
  HeliGoal g;
  g.x = pad.x; g.z = pad.z; g.speed = 80; g.stop = 0.7; g.decel = 2.2;
  if (phase == Phase::Depart) {
    // the skier is still right below: hover a moment, then lift straight up, turning for home
    o.fwd = -f.u * 0.4;
    o.turn = t < 0 ? 0 : clamp(heli::wrapPi(std::atan2(pad.x - f.pos.x, pad.z - f.pos.z) - f.yaw) * 2, -1.0, 1.0);
    o.lift = t < 0 ? 0 : 1;
    if (t > 0 && f.agl > 16) phase = Phase::Transit;
    return o;
  }
  if (phase == Phase::Transit) {
    // a glide path down to the pad (1:5.5), never below 35 m over whatever is underneath
    g.hasY = true; g.y = std::max(f.groundY + f.fr.cgH + 35, padY + 20 + std::max(0.0, d - 150) / 5.5);
    // high above the path (a ridge pushed us up): slow down so the descent still ends over the pad
    double high = f.pos.y - g.y;
    g.speed = high > 25 ? clamp((12 * std::max(0.0, d - 120)) / high, 18.0, 80.0) : 80; g.stop = 0.7; g.decel = 4.5;
    heliAutopilot(f, g, o);
    if (d < 0.9 && f.speed() < 0.6) phase = Phase::Align;
    return o;
  }
  if (phase == Phase::Align) {
    g.hasAgl = true; g.agl = 18; g.hasYaw = true; g.yaw = pad.yaw; g.stop = 4;
    heliAutopilot(f, g, o);
    if (std::fabs(heli::wrapPi(pad.yaw - f.yaw)) < 0.04) phase = Phase::Down;
    return o;
  }
  if (phase == Phase::Down) {
    g.hasY = true; g.y = padY - 1; g.hasYaw = true; g.yaw = pad.yaw; g.stop = 4;
    heliAutopilot(f, g, o);
    o.lift = clamp((padY - 1 - f.pos.y) * 0.05, -1.3, 0.0);   // a brisk descent, the ground cushion sets it down
    if (f.landed) phase = Phase::Landed;
    return o;
  }
  return o;
}

} // namespace sl
