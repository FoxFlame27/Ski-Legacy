// heli/rescue.js: mountain rescue instead of the wipeout fade. After a crash you stay down in the snow and the
// helicopter comes for you: it flies in from its pad (from far away it is already on its way when the shot opens),
// then either lands on flat open snow beside you (a fade, and you are in the cabin) or, over trees or a slope too steep
// to land on, hovers above you and winches you up. Then it flies you home to the pad (a chase camera, the mouse looks
// around, hold SPACE to speed it all up), lands, and the ambulance waiting at the pad drives you to the medical centre
// (a shot by the pad, then the camera follows it), where you wake up in a hospital bed (game/hospital_ward). Only the
// wait for the pick-up is timed; once you are aboard a watchdog steps in when the helicopter or the ambulance stops
// getting closer, and even then you come round at the medical centre.
#include "game/heli.h"
#include "core/log.h"
#include "engine/renderer.h"
#include "game/economy.h"
#include "game/hospital_ward.h"
#include "game/play_data.h"
#include "game/shapes.h"
#include "player/player.h"
#include "world/scenery.h"
#include "world/world.h"
#include <ctime>

namespace sl {

using heli::smooth;

namespace {
constexpr double LIMIT = 150;        // game seconds to pick you up before giving up (straight to the medical centre)
constexpr double STUCK = 45;         // game seconds without getting any closer (helicopter home, ambulance)
constexpr double FAR = 1500;         // farther than this, the helicopter starts the shot already on its way...
constexpr double START_D = 800;      // ...this far out
constexpr double HOVER_AGL = 12, HOVER_TREES = 27;   // winch hover heights above the snow (m)
constexpr double ROPE_DOWN = 2.6, ROPE_UP = 4.2;     // winch times (s)
} // namespace

HeliRescue::HeliRescue(Heli& h, PlayCtx& c, HospitalWard& ward) : amb(c), h_(h), c_(c), ward_(ward) {}

std::string HeliRescue::hudLine() const {
  switch (phase) {
    case Phase::Inbound: return "Rescue helicopter on its way \xC2\xB7 hold " + c_.K(Action::Jump) + " to speed up";
    case Phase::Settle: case Phase::Pickup: return "The rescue helicopter is landing beside you";
    case Phase::Hover: return attached ? "Hold on \xC2\xB7 winching you up" : "The rescue helicopter is lowering the winch";
    case Phase::Home: case Phase::Arrive: return "Flying back to Legacy Village \xC2\xB7 hold " + c_.K(Action::Jump) + " to speed up";
    case Phase::Ambulance: return "Ambulance to the medical centre \xC2\xB7 " + fmtMoney(c_.save->rescueFee()) + " \xC2\xB7 hold " + c_.K(Action::Jump) + " to speed up";
    default: return "";
  }
}

/// Start a rescue for the player lying where they crashed. false: not possible here (the caller uses the old fade).
bool HeliRescue::start(bool free_, bool near) {
  Player& p = *c_.player;
  HeliFlight& f = h_.flight;
  if (phase != Phase::None && h_.state != Heli::State::Rescue) { cleanup(); }   // (a rescue left half-done never blocks the next one)
  if (phase != Phase::None || h_.state == Heli::State::Flying || h_.state == Heli::State::Boarding) { SL_WARN("rescue: helicopter busy"); return false; }
  // under a tunnel lid or inside a cave: no way to reach you from the air
  if (c_.world->height(p.pos.x, p.pos.z) - p.pos.y > 2.5) return false;
  free = free_;   // (knocked over by a vehicle: not your fault, no fee)
  t = 0; pt = 0; fast = false; spot_ = Spot{}; attached = false; inCabin = false; seated = false; shot_.ready = false; camOn = false;
  hasShotAt_ = hasChase_ = false; sirenOff_ = false; leaving = false; boarding = false; liftT = -1; gone = false; watch_ = {};
  h_.away_ = false;
  t0_ = double(std::time(nullptr)); pick_ = p.pos; persistT_ = 0; persistSt_.clear();
  // where the helicopter starts: its pad, or wherever it is now; from far away it is already on the way
  double d = std::hypot(f.pos.x - p.pos.x, f.pos.z - p.pos.z);
  if (d > FAR || near) {   // (near: a rescue carried on after you came back, so it is with you in moments)
    const double R = near ? 260 : START_D;
    double ux = d > 1 ? (f.pos.x - p.pos.x) / d : 0, uz = d > 1 ? (f.pos.z - p.pos.z) / d : 1;
    double x = p.pos.x + ux * R, z = p.pos.z + uz * R, yaw = std::atan2(-ux, -uz);
    f.place(x, z, yaw, h_.groundFn());
    double top = h_.ground(x, z);
    for (int k = 1; k <= 8; k++) top = std::max(top, h_.ground(x - ux * R * k / 8, z - uz * R * k / 8));
    f.landed = false;
    f.pos.y = std::max(h_.ground(x, z) + f.fr.cgH + 60, top + f.fr.cgH + 45);
    f.u = 38; f.vel = dvec3(std::sin(yaw) * 38, 0, std::cos(yaw) * 38);
    f.updateQuat();
    h_.rpm = 1;
  }
  h_.pilot.phase = HeliHomePilot::Phase::Idle;
  h_.state = Heli::State::Rescue;
  phase = Phase::Inbound;
  // the ambulance waits beside the pad (side of the pad, facing out)
  amb.parkAtPad();
  c_.flash("Rescue helicopter on its way", 0);
  SL_INFO("rescue: called at (%.0f, %.0f, %.0f), the helicopter %.0f m away", p.pos.x, p.pos.y, p.pos.z, d);
  return true;
}

// where you come out: the medical centre's door (facing it), else beside the pad
dvec3 HeliRescue::door(double& heading) const {
  const Site H = c_.data ? c_.data->hospital : Site{};
  if (H.ok) { heading = std::atan2(-H.dirx, -H.dirz); return dvec3(H.ex + H.dirx * 2, 0, H.ez + H.dirz * 2); }
  double a = h_.home.yaw + PI / 2, d = h_.padR + 3, x = h_.home.x + std::sin(a) * d, z = h_.home.z + std::cos(a) * d;
  heading = std::atan2(h_.home.x - x, h_.home.z - z);
  return dvec3(x, 0, z);
}

// ------------------------------------------------------------------ kept across leaving and coming back
// (rescue.js persistStep / plan / resume / settle: "if you leave while being rescued and you rejoin, the rescue should
// continue, not be abandoned") While it runs the save's `rescue` = { st: 'wait' (down in the snow) | 'winch' | 'cabin'
// (aboard, flying home) | 'amb' (in the ambulance), x, y, z (where you lay), t0 (s: when it began), free, hp [x, y, z,
// yaw] (aboard: the helicopter) }, written on every change of stage and every 3 s; gone once it is over (charge) or
// given up (cleanup). Back in the game: down in the snow or on the winch, the helicopter comes for you again from
// 260 m; aboard, on in the cabin; in the ambulance, straight into a hospital bed; more than 600 s since it began, all
// over: out at the medical centre's door. The fee is only ever taken once.
const char* HeliRescue::stage() const {
  if (phase == Phase::Ambulance) return "amb";
  if (inCabin || phase == Phase::Home || phase == Phase::Arrive) return "cabin";
  return attached || phase == Phase::Hover ? "winch" : "wait";
}

void HeliRescue::persist(double dt) {
  if (phase == Phase::None || !c_.save) return;
  std::string st = stage();
  if (st == persistSt_ && (persistT_ -= dt) > 0) return;
  persistSt_ = st; persistT_ = 3;
  const HeliFlight& f = h_.flight;
  nlohmann::json r = {{"st", st}, {"x", pick_.x}, {"y", pick_.y}, {"z", pick_.z}, {"t0", t0_}, {"free", free}};
  if (st == "cabin") r["hp"] = {f.pos.x, f.pos.y, f.pos.z, f.yaw};
  c_.save->data("rescue") = r;
  c_.save->markDirty();
}

void HeliRescue::forget() {
  persistSt_.clear();
  if (!c_.save) return;
  nlohmann::json& r = c_.save->data("rescue");
  if (r.is_object() && r.empty()) return;
  r = nlohmann::json::object();
  c_.save->markDirty();
}

bool HeliRescue::resume() {
  if (!c_.save || phase != Phase::None) return false;
  const nlohmann::json rec = c_.save->data("rescue");
  if (!rec.is_object() || !rec.contains("st") || !rec["st"].is_string() || !rec.contains("x") || !rec.contains("z")) return false;
  const std::string st = rec["st"];
  const double now = double(std::time(nullptr)), t0 = rec.value("t0", now);
  Player& p = *c_.player;
  free = rec.value("free", false);
  const bool late = now - t0 > 600;
  SL_INFO("rescue: one was under way when you left (%s, %.0f s ago%s)", st.c_str(), now - t0, late ? ": over" : "");
  if (!late && (st == "wait" || st == "winch")) {
    // down in the snow where you lay, the helicopter close by
    p.setSkisOn(true);
    c_.teleport(rec.value("x", 0.0), rec.value("z", 0.0), p.heading, true);
    if (start(free, true)) { t0_ = t0; c_.flash("Rescue continues \xC2\xB7 the helicopter is on its way", 0); return true; }
  } else if (!late && st == "cabin" && rec.contains("hp") && rec["hp"].is_array() && rec["hp"].size() == 4) {
    const double x = rec["hp"][0], y = rec["hp"][1], z = rec["hp"][2], yaw = rec["hp"][3];
    c_.teleport(x, z, yaw, false);
    if (start(free, false)) {
      HeliFlight& f = h_.flight;
      f.place(x, z, yaw, h_.groundFn());
      f.landed = false;
      f.pos.y = std::max(y, h_.ground(x, z) + f.fr.cgH + 40);
      f.u = 30; f.vel = dvec3(std::sin(yaw) * 30, 0, std::cos(yaw) * 30);
      f.updateQuat();
      h_.rpm = 1;
      t0_ = t0;
      pick_ = dvec3(rec.value("x", x), rec.value("y", 0.0), rec.value("z", z));
      intoCabin();
      c_.flash("Rescue continues \xC2\xB7 flying you back to Legacy Village", 0);
      return true;
    }
  }
  // (the rest of it at once: into a hospital bed, else out at the medical centre's door; the bill, once)
  forget();
  double heading = 0;
  dvec3 D = door(heading);
  p.setSkisOn(false);
  c_.teleport(D.x, D.z, heading, false);
  bool inBed = !late && ward_.admit();
  charge(inBed ? "Rescue continues \xC2\xB7 the ambulance brought you to the medical centre" : "Rescued while you were away \xC2\xB7 treated at the medical centre and released");
  return true;
}

// ------------------------------------------------------------------ the flight
HeliCtl HeliRescue::controls(double dt) {
  HeliFlight& f = h_.flight;
  const Player& p = *c_.player;
  HeliCtl o;
  HeliGoal g;
  g.stop = 0.8; g.decel = 3.9; g.speed = 72;
  if (phase == Phase::Inbound) {
    // toward you (once you have stopped sliding and it is close, toward the pick-up spot it picked)
    if (!spot_.ok && settled() && std::hypot(f.pos.x - p.pos.x, f.pos.z - p.pos.z) < 320) spot_ = pickSpot();
    double tx = spot_.ok ? spot_.x : p.pos.x, tz = spot_.ok ? spot_.z : p.pos.z;
    double ty = spot_.ok ? spot_.y : h_.ground(tx, tz);
    double d = std::hypot(tx - f.pos.x, tz - f.pos.z);
    g.x = tx; g.z = tz;
    // a glide path that ends 20 m above the spot, never below 35 m over what is underneath
    g.hasY = true; g.y = std::max(f.groundY + f.fr.cgH + 35, ty + f.fr.cgH + 20 + std::max(0.0, d - 150) / 5.5);
    if (spot_.ok && !spot_.land) g.y = std::max(g.y, spot_.hoverY);
    double high = f.pos.y - g.y;
    g.speed = high > 25 ? clamp((12 * std::max(0.0, d - 120)) / high, 15.0, 72.0) : 72;
    heliAutopilot(f, g, o);
    if (spot_.ok && d < 1.2 && f.speed() < 0.9) go(spot_.land ? Phase::Settle : Phase::Hover);
    return o;
  }
  const Spot& s = spot_;
  if (phase == Phase::Settle) {
    // turn to the parking heading at 16 m, then down (the ground cushion sets it on the snow)
    g.x = s.x; g.z = s.z; g.hasYaw = true; g.yaw = s.yaw; g.stop = 1.5;   // (right over the spot it checked)
    bool aligned = std::fabs(heli::wrapPi(s.yaw - f.yaw)) < 0.06;
    if (!aligned && pt < 8) { g.hasAgl = true; g.agl = 16; heliAutopilot(f, g, o); return o; }
    g.hasY = true; g.y = s.y + f.fr.cgH - 1;
    heliAutopilot(f, g, o);
    o.lift = clamp((s.y + f.fr.cgH - 1 - f.pos.y) * 0.05, -1.3, 0.0);
    if (f.landed) go(Phase::Pickup);
    // could not get down there after all: winch instead
    else if (pt > 16) { spot_ = pickWinch(); go(Phase::Hover); }
    return o;
  }
  if (phase == Phase::Pickup) return o;   // on the skids, waiting for you
  if (phase == Phase::Hover) {
    g.x = s.hx; g.z = s.hz; g.hasY = true; g.y = s.hoverY; g.hasYaw = true; g.yaw = s.yaw; g.stop = 6;
    heliAutopilot(f, g, o);
    return o;
  }
  if (phase == Phase::Ambulance) {
    // once you are handed over it lifts off, climbs away over the pad for a few seconds and is gone
    if (gone || liftT < 0) return o;
    const HeliPad& L = h_.home;
    g.x = L.x + std::sin(L.yaw) * 400; g.z = L.z + std::cos(L.yaw) * 400;
    g.hasY = true; g.y = std::max(f.groundY + f.fr.cgH + 25, L.y + f.fr.cgH + 90); g.speed = 40; g.stop = 2;
    heliAutopilot(f, g, o);
    if (liftT < 1.2) { o.fwd = 0; o.turn = 0; o.lift = 1; }   // (straight up off the skids first)
    return o;
  }
  if (phase == Phase::Home || phase == Phase::Arrive) {
    o = h_.pilot.update(f, dt);
    if (phase == Phase::Home && h_.pilot.phase == HeliHomePilot::Phase::Landed) go(Phase::Arrive);
    return o;
  }
  return o;
}

bool HeliRescue::settled() const {
  const Player& p = *c_.player;
  return p.mode != PlayerMode::Fall || (p.fall.state != FallState::State::Tumble && glm::length(p.vel) < 1.5);
}

// Where to pick you up: lying in the trees or on a slope too steep to land on, the winch from above; otherwise flat
// open snow within ~35 m (it lands, the door facing you), else the winch after all.
HeliRescue::Spot HeliRescue::pickSpot() const {
  const dvec3 p = c_.player->pos;
  const double rotorR = h_.flight.fr.rotorR;
  auto G = [&](double x, double z) { return h_.ground(x, z); };
  const double e0 = 3;
  double here = std::hypot(G(p.x + e0, p.z) - G(p.x - e0, p.z), G(p.x, p.z + e0) - G(p.x, p.z - e0)) / (2 * e0);
  if (h_.treeNear(p.x, p.z, 7) || here > 0.3) return pickWinch();
  auto okAt = [&](double x, double z) {
    const double e = 2.5, e2 = 5.5;
    double slope = std::hypot(G(x + e, z) - G(x - e, z), G(x, z + e) - G(x, z - e)) / (2 * e);
    double slope2 = std::hypot(G(x + e2, z) - G(x - e2, z), G(x, z + e2) - G(x, z - e2)) / (2 * e2);
    if (slope > 0.24 || slope2 > 0.24) return false;
    if (h_.treeNear(x, z, rotorR + 3)) return false;
    if (h_.solidNear(x, z, rotorR + 2, false)) return false;
    if (h_.liftLineNear(x, z, 4)) return false;
    return true;
  };
  for (double r : {11.0, 15.0, 20.0, 26.0, 33.0}) {
    for (int k = 0; k < 12; k++) {
      double a = (k / 12.0) * TAU + r * 0.37;
      double x = p.x + std::cos(a) * r, z = p.z + std::sin(a) * r;
      if (!okAt(x, z)) continue;
      // the right-hand door toward you: right of yaw is (-cos yaw, sin yaw)
      double dx = p.x - x, dz = p.z - z;
      Spot s; s.ok = true; s.land = true; s.x = x; s.z = z; s.y = G(x, z); s.yaw = std::atan2(dz, -dx);
      return s;
    }
  }
  return pickWinch();
}

// the winch: hover with the door above you, high enough to clear the trees around
HeliRescue::Spot HeliRescue::pickWinch() const {
  const dvec3 p = c_.player->pos;
  const double rotorR = h_.flight.fr.rotorR;
  bool trees = h_.treeNear(p.x, p.z, rotorR + 4);
  double yaw = h_.flight.yaw;
  // the door is ~1.4 m right of the centre: put the centre that far to the left of you
  double hx = p.x + std::cos(yaw) * 1.4, hz = p.z - std::sin(yaw) * 1.4;
  double top = h_.ground(p.x, p.z);
  for (int k = 0; k < 8; k++) { double a = (k / 8.0) * TAU; top = std::max(top, h_.ground(hx + std::cos(a) * rotorR, hz + std::sin(a) * rotorR)); }
  double y = h_.ground(p.x, p.z);
  Spot s; s.ok = true; s.land = false; s.x = hx; s.z = hz; s.hx = hx; s.hz = hz; s.y = y; s.yaw = yaw;
  s.hoverY = std::max(y + (trees ? HOVER_TREES : HOVER_AGL), top + 6) + h_.flight.fr.cgH;
  return s;
}

// ------------------------------------------------------------------ you, the rope, the camera
void HeliRescue::after(double dt, bool fastKey) {
  Player& p = *c_.player;
  HeliFlight& f = h_.flight;
  fast = fastKey;
  persist(dt);
  if (!attached && !inCabin && phase != Phase::Ambulance) pick_ = p.pos;   // (where you lay: a rejoin picks you up there)
  double sdt = dt * (fast ? 4 : 1);   // (SPACE: the waits and the winch run faster too)
  t += sdt; pt += sdt;
  camOn = false;
  // aboard: a watchdog on the progress toward the pad / the medical centre (no clock on the ride itself)
  if (phase == Phase::Home || phase == Phase::Ambulance) {
    dvec3 P = phase == Phase::Home ? f.pos : amb.pos();
    double tx = phase == Phase::Home ? h_.home.x : amb.hasGoal ? amb.goal.x : P.x, tz = phase == Phase::Home ? h_.home.z : amb.hasGoal ? amb.goal.y : P.z;
    double d = std::hypot(P.x - tx, P.z - tz);
    if (watch_.phase != phase || d < watch_.best - 1) { watch_.phase = phase; watch_.best = d; watch_.t = 0; }
    else if ((watch_.t += sdt) > STUCK) { SL_WARN("rescue: stuck, straight to the medical centre"); fail(); return; }
  }
  // the ambulance's lights from the moment you land at the pad until the screen goes black
  if (amb.ok() && phase == Phase::Arrive) amb.flash(sdt, c_.night);
  // in the ambulance: it drives you all the way to the medical centre's door (a shot by the pad watches it set off,
  // then the camera follows it); there you are treated and released
  if (phase == Phase::Ambulance) {
    if (liftT >= 0 && !gone && (liftT += sdt) > 5) {   // gone after the hand-over: back on its pad unseen, the rotor stopped
      gone = true;
      h_.rpm = 0;
      f.place(h_.home.x, h_.home.z, h_.home.yaw, h_.groundFn());
      h_.pilot.phase = HeliHomePilot::Phase::Idle;
    }
    amb.drive(sdt);
    amb.flash(0, c_.night);
    seatPos = amb.pos() + dvec3(0, 1.2, 0);
    seatFwd = dvec3(std::sin(amb.yaw), 0, std::cos(amb.yaw));
    h_.streamPos = seatPos;
    if (pt < 4) ambShot(dt); else ambChase(dt);
    camOn = true;
    if (amb.arrived) {   // at the medical centre: carried in (a fade), treated
      if (c_.fade) c_.fade();
      release();
    }
    return;
  }
  if (!inCabin && !attached && t > LIMIT) { SL_WARN("rescue: not picked up in time"); fail(); return; }
  // stay down in the snow until you are picked up (the fall's own get-up waits)
  if (!attached && !inCabin) {
    if (p.mode == PlayerMode::Fall && p.fall.state == FallState::State::Lie) p.fall.lieT = std::min(p.fall.lieT, 0.1);
    if (p.mode == PlayerMode::Fall && p.fall.state == FallState::State::GetUp) { p.fall.state = FallState::State::Lie; p.fall.getUp = 0; p.fall.lieT = 0; p.fall.roll = p.fall.rollRest; }
    if (p.mode == PlayerMode::Ski || p.mode == PlayerMode::Walk) {
      // (already back on your feet when the rescue was called: down again, lying still: rescue.js lieDown)
      p.vel = dvec3(0);
      p.mode = PlayerMode::Fall;
      p.fall = FallState{};
      p.fall.t = 1; p.fall.state = FallState::State::Lie; p.fall.kind = FallState::Kind::Slam;
      p.fall.roll = p.fall.rollRest = p.fall.rollTarget = p.fallSide * PI / 2; p.fall.hasRollTarget = true;
      p.parked = false;
    }
  }
  if (phase == Phase::Pickup && !boarding && pt > 0.8) {
    boarding = true;
    if (c_.fade) c_.fade();
    intoCabin();
    boarding = false;
  }
  if (phase == Phase::Hover) winch(sdt);
  if (phase == Phase::Arrive && pt > 0.6 && !leaving) finish();
  // you in the cabin: on the seat, moving with it
  if (inCabin) {
    double ahead = std::min(2.0, 140 / std::max(1.0, f.speed()));
    h_.streamPos = dvec3(f.pos.x + f.vel.x * ahead, f.pos.y, f.pos.z + f.vel.z * ahead);
    h_.placeCamera(dt, false, true);
  } else if (phase != Phase::Ambulance && phase != Phase::None) {
    h_.streamPos = p.pos;
    // while you are still tumbling the crash camera keeps you; then the shot from the snow
    if (settled()) { groundShot(dt); camOn = true; }
  }
}

// From the snow beside you, low, looking past you at the helicopter coming in (and up at it overhead).
void HeliRescue::groundShot(double dt) {
  const HeliFlight& f = h_.flight;
  auto& S = shot_;
  const dvec3 me = c_.player->pos;
  // (on the winch the shot stays down where you lay, watching you go up)
  const dvec3 p = attached && hasLieAt_ ? lieAt_ : me;
  const double back = attached ? 12 : 7;
  double dx = f.pos.x - p.x, dz = f.pos.z - p.z;
  double d = std::hypot(dx, dz);
  if (d < 1e-9) d = 1;
  dx /= d; dz /= d;
  if (!S.ready) { S.dx = dx; S.dz = dz; }
  // the side of the shot is fixed once it starts (no swinging round as the helicopter passes overhead)
  if (d > 40) { S.dx += (dx - S.dx) * (1 - std::exp(-dt * 0.8)); S.dz += (dz - S.dz) * (1 - std::exp(-dt * 0.8)); }
  double l = std::hypot(S.dx, S.dz);
  if (l < 1e-9) l = 1;
  double ax = S.dx / l, az = S.dz / l;
  dvec3 want(p.x - ax * back - az * 3.2, 0, p.z - az * back + ax * 3.2);
  want.y = std::max(h_.snow(want.x, want.z) + 1.7, p.y + 1.1);
  // look between you and the helicopter (both in the frame)
  dvec3 toP = glm::normalize(dvec3(me.x, me.y + 0.6, me.z) - want);
  dvec3 toH = glm::normalize(f.pos - want);
  dvec3 look = glm::normalize(glm::mix(toP, toH, d < 60 ? 0.62 : 0.45)) + want;
  if (!S.ready) { S.pos = want; S.look = look; S.ready = true; camFov = 58; }
  S.pos = glm::mix(S.pos, want, 1 - std::exp(-dt * 2.5));
  S.look = glm::mix(S.look, look, 1 - std::exp(-dt * 3));
  camPos = S.pos; camLook = S.look;
  camFov += (58 - camFov) * (1 - std::exp(-dt * 3));
}

// the winch: the rope comes down, you clip in, you go up into the cabin
void HeliRescue::winch(double dt) {
  Player& p = *c_.player;
  dvec3 doorP = h_.flight.world(h_.anchorDoor);
  doorP.y += 1.0;
  ropeTop_ = doorP;
  double groundY = attached ? lieAt_.y : p.pos.y;
  double full = std::max(0.5, doorP.y - groundY - 0.9);
  if (!attached) {
    if (pt < 2.5) { ropeOn_ = false; return; }   // settling into the hover
    ropeLen_ = std::min(full, ropeLen_ + (full / ROPE_DOWN) * dt);
    if (ropeLen_ >= full - 0.05) {
      attached = true; winchT_ = 0;
      lieAt_ = p.pos; hasLieAt_ = true;
      seatPos = p.pos;
      seatFwd = dvec3(std::sin(h_.flight.yaw), 0, std::cos(h_.flight.yaw));
      p.sitOn(seatPos, seatFwd);
      seated = true;
    }
  } else {
    winchT_ += dt;
    double k = smooth(0, ROPE_UP, winchT_);
    ropeLen_ = std::max(0.3, full * (1 - k));
    // you hang under the hook, swinging a little
    double sw = std::sin(winchT_ * 2.1) * 0.12 * (1 - k);
    seatPos = dvec3(doorP.x + sw, doorP.y - ropeLen_ - 0.9, doorP.z + sw * 0.6);
    if (winchT_ >= ROPE_UP) { ropeOn_ = false; intoCabin(); return; }
  }
  ropeOn_ = true;
}

// in the cabin, the pilot turns for home
void HeliRescue::intoCabin() {
  if (phase == Phase::None) return;
  Player& p = *c_.player;
  h_.prevView_ = int(p.view);
  p.view = Player::View::Third;
  p.setSkisOn(false);
  seated = false; attached = false;
  inCabin = true;
  dvec3 sp, sf;
  h_.seat(sp, sf);
  p.sitOn(sp, sf);
  h_.loadRack();
  // first shot of the ride: behind the left shoulder
  h_.cam.yaw = h_.flight.yaw + PI - 0.6; h_.cam.pitch = 0.2; h_.cam.dist = 19; h_.cam.lastMouse = h_.time;
  h_.placeCamera(0, true, false);
  h_.pilot.home(h_.home, 1.0);
  go(Phase::Home);
  c_.flash("Picked up \xC2\xB7 flying you back to Legacy Village", 0);
}

// landed on the pad: a short fade, you're carried into the ambulance waiting by the pad
void HeliRescue::finish() {
  Player& p = *c_.player;
  if (!amb.ok()) { if (c_.fade) c_.fade(); release(); return; }
  if (c_.fade) c_.fade();
  inCabin = false;
  seatPos = amb.pos() + dvec3(0, 1.2, 0);
  seatFwd = dvec3(std::sin(amb.yaw), 0, std::cos(amb.yaw));
  seated = true;
  p.sitOn(seatPos, seatFwd);
  amb.rider = true;   // (you're in it: its collider never pushes you off your seat)
  amb.plan();
  hasShotAt_ = false; hasChase_ = false;
  liftT = 0; gone = false;   // (the helicopter lifts off now and is gone in a few seconds)
  go(Phase::Ambulance);
}

// a fixed shot by the pad, low, panning after the ambulance as it drives away
void HeliRescue::ambShot(double dt) {
  dvec3 a = amb.pos();
  if (!hasShotAt_) {
    double y = amb.yaw, sx = a.x + std::cos(y) * 10 + std::sin(y) * 7, sz = a.z - std::sin(y) * 10 + std::cos(y) * 7;
    shotAt_ = dvec3(sx, h_.snow(sx, sz) + 2.3, sz);
    hasShotAt_ = true;
  }
  camPos = shotAt_;
  camLook = dvec3(a.x, a.y + 1.4, a.z);
  camFov += (46 - camFov) * (1 - std::exp(-dt * 2));
}

// the camera follows the ambulance, behind and above it
void HeliRescue::ambChase(double dt) {
  dvec3 a = amb.pos();
  double fx = std::sin(amb.yaw), fz = std::cos(amb.yaw);
  dvec3 want(a.x - fx * 13, 0, a.z - fz * 13);
  want.y = std::max(a.y + 4.8, h_.snow(want.x, want.z) + 2);
  if (!hasChase_) { chase_ = hasShotAt_ ? shotAt_ : want; hasChase_ = true; }
  chase_ = glm::mix(chase_, want, 1 - std::exp(-dt * 2.2));
  camPos = chase_;
  camLook = dvec3(a.x + fx * 5, a.y + 1.3, a.z + fz * 5);
  camFov += (55 - camFov) * (1 - std::exp(-dt * 2));
}

// out of the ambulance at the medical centre: into a hospital bed (else out of its door, the bill paid)
void HeliRescue::release() {
  Player& p = *c_.player;
  sirenOff_ = true;
  double heading = 0;
  dvec3 D = door(heading);
  p.view = Player::View(h_.prevView_);
  p.skisOn = false;
  p.standUp(D.x, D.z, heading);
  bool wasFree = free;
  cleanup();
  free = wasFree;
  h_.state = Heli::State::Parked;
  // (hospitalroom.js: you wake up in a hospital bed, behind this fade)
  bool inBed = ward_.admit();
  charge(inBed ? "Brought to the medical centre" : "Treated at the medical centre and released");
}

// the ambulance fee, straight off your balance (it can go below zero: shops, lifts and passes then refuse)
void HeliRescue::charge(const std::string& what) {
  int fee = c_.save->rescueFee();
  forget();   // (over: nothing left to carry on)
  if (free) { free = false; c_.flash(what + " \xC2\xB7 free: it was not your fault", 0); return; }
  c_.charge(fee);
  c_.save->rescues++;
  c_.save->markDirty();
  c_.flash(what + " \xC2\xB7 -" + fmtMoney(fee) + " \xC2\xB7 the next one costs " + fmtMoney(c_.save->rescueFee()), 1);
}

/// Give up: a fade, and you come round at the medical centre.
void HeliRescue::fail() {
  if (failing_) return;
  failing_ = true;
  if (c_.fade) c_.fade();
  bool wasFree = free;
  h_.abort();   // (ends the rescue too, puts the helicopter back on its pad)
  free = wasFree;
  release();
  failing_ = false;
}

/// End the rescue (Heli::abort / release).
void HeliRescue::cleanup() {
  // (given up or ended from outside: forgotten; back to the main menu it is kept for when you play on: keep)
  if (keep) keep = false; else if (phase != Phase::None) forget();
  if (liftT >= 0 || gone) {   // (it had left after the hand-over: back on its pad, shown again)
    liftT = -1; gone = false;
    h_.rpm = 0;
    h_.place();
  }
  ropeOn_ = false;
  h_.rackOn_ = false;
  amb.hide();
  sirenOff_ = false;
  phase = Phase::None; spot_ = Spot{}; attached = false; inCabin = false; seated = false;
  boarding = false; leaving = false; ropeLen_ = 0; shot_.ready = false; watch_ = {}; hasChase_ = false; hasShotAt_ = false; hasLieAt_ = false;
  camOn = false; fast = false;
}

void HeliRescue::draw(Renderer& r, const dvec3& cam) const {
  amb.draw(r, cam);
  // the rope from the door arm down to the hook
  if (ropeOn_ && c_.shapes) c_.shapes->cylinder(r, ropeTop_ - dvec3(0, ropeLen_, 0), 0.02, ropeLen_, vec4(0.017f, 0.02f, 0.025f, 1), 0, false);
}

// net/rescue.js RescueMp.frame: the rescue's pose for the other players (about 6 times a second while it runs)
bool Heli::mpRescue(nlohmann::json& msg) const {
  const HeliRescue& R = rescue;
  if (state != State::Rescue || !R.active()) return false;
  auto r2 = [](double v) { return std::round((std::isfinite(v) ? v : 0) * 100) / 100; };
  const HeliFlight& f = flight;
  // (where you are: 0 down in the snow, 1 on the winch, 2 in the cabin, 3 in the ambulance)
  const int s = R.phase == HeliRescue::Phase::Ambulance && R.seated ? 3 : R.inCabin ? 2 : R.seated ? 1 : 0;
  msg = nlohmann::json{{"k", "rescue"}, {"s", s}};
  // (gone after handing you to the ambulance: null, the others drop it at once)
  if (!R.gone) msg["h"] = {r2(f.pos.x), r2(f.pos.y), r2(f.pos.z), r2(f.yaw), r2(f.pitch), r2(f.roll), r2(std::min(1.0, std::max(0.0, rpm)))};
  else msg["h"] = nullptr;
  if (R.amb.ok() && R.amb.visible) msg["a"] = {r2(R.amb.x), r2(R.amb.y), r2(R.amb.z), r2(R.amb.yaw), r2(std::max(-40.0, std::min(40.0, R.amb.v)))};
  else msg["a"] = nullptr;
  msg["rope"] = R.ropeOn_ ? r2(R.ropeLen_) : 0.0;
  msg["l"] = R.phase == HeliRescue::Phase::Arrive || R.phase == HeliRescue::Phase::Ambulance;
  return !(msg["h"].is_null() && msg["a"].is_null());
}

dvec3 Heli::otherPoint(const dvec3& pos, double yaw, double pitch, double roll, bool seat) const {
  const glm::dquat q = glm::angleAxis(yaw, dvec3(0, 1, 0)) * glm::angleAxis(pitch, dvec3(1, 0, 0)) * glm::angleAxis(roll, dvec3(0, 0, 1));
  return pos + q * (seat ? anchorSeat : anchorDoor);
}

// net/vehicles.js updateRescue: their helicopter (model.js: the airframe, the rotors by their rpm) and its winch rope
void Heli::drawOther(Renderer& r, const dvec3& pos, double yaw, double pitch, double roll, double orpm, double rope, double otime) {
  if (!ok_ || !parts_.body) return;
  const glm::dquat q = glm::angleAxis(yaw, dvec3(0, 1, 0)) * glm::angleAxis(pitch, dvec3(1, 0, 0)) * glm::angleAxis(roll, dvec3(0, 0, 1));
  const mat4 R = mat4(glm::mat4_cast(glm::quat(q)));
  r.submitModel(*parts_.body, pos, R, nullptr, true);
  const mat4 A = R * glm::translate(mat4(1), airPos_) * glm::scale(mat4(1), vec3(float(K_)));
  auto sm = [](double a, double b, double x) { double t = std::clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3 - 2 * t); };
  const double blur = sm(0.28, 0.9, orpm), ang = otime * 38 * orpm, tang = otime * 150 * orpm;
  const float droop = float(-0.045 + 0.07 * sm(0.2, 1, orpm));
  const mat4 spin = A * glm::translate(mat4(1), hub_) * glm::rotate(mat4(1), float(ang), vec3(0, 1, 0));
  if (parts_.hub) r.submitModel(*parts_.hub, pos, spin, nullptr, true);
  if (parts_.blade)
    for (int i = 0; i < 4; i++) {
      mat4 M = spin * glm::rotate(mat4(1), float(i * PI / 2), vec3(0, 1, 0)) * glm::translate(mat4(1), vec3(float(bladeX_), 0, 0)) * glm::rotate(mat4(1), droop, vec3(0, 0, 1));
      r.submitModel(*parts_.blade, pos, M, nullptr, orpm < 0.45);
    }
  if (parts_.disc && blur > 0.01) r.submitModel(*parts_.disc, pos, A * glm::translate(mat4(1), hub_ + vec3(0, float(discY_), 0)) * glm::rotate(mat4(1), float(ang), vec3(0, 1, 0)), nullptr, false);
  const mat4 tspin = A * glm::translate(mat4(1), tailHub_) * glm::rotate(mat4(1), float(tang), vec3(1, 0, 0));
  if (parts_.tailHub) r.submitModel(*parts_.tailHub, pos, tspin, nullptr, true);
  if (parts_.tailBlades && orpm < 0.4) r.submitModel(*parts_.tailBlades, pos, tspin, nullptr, true);
  if (parts_.tailDisc && orpm > 0.12) r.submitModel(*parts_.tailDisc, pos, A * glm::translate(mat4(1), tailHub_ + vec3(float(tailDiscX_), 0, 0)) * glm::rotate(mat4(1), float(tang), vec3(1, 0, 0)), nullptr, false);
  // the winch rope from the door arm down to the hook (rescue.js winch)
  if (rope > 0.1 && c_.shapes) {
    const dvec3 top = pos + q * anchorDoor + dvec3(0, 1.0, 0);
    c_.shapes->cylinder(r, top - dvec3(0, rope, 0), 0.02, rope, vec4(0.017f, 0.02f, 0.025f, 1), 0, false);
  }
}

} // namespace sl

/// (debug: ambtest) straight to the pad, landed, you in the cabin
void sl::HeliRescue::debugArrive() {
  if (phase == Phase::None) return;
  h_.flight.place(h_.home.x, h_.home.z, h_.home.yaw, h_.groundFn());
  h_.rpm = 1;
  intoCabin();
  h_.pilot.phase = HeliHomePilot::Phase::Landed;
  go(Phase::Arrive);
}

/// (debug) the watchdog: as if it had not got any closer for STUCK seconds / the pick-up had taken LIMIT seconds
void sl::HeliRescue::debugStall() {
  if (phase == Phase::Home || phase == Phase::Ambulance) { watch_.phase = phase; watch_.best = -1e18; watch_.t = STUCK; }
  else t = LIMIT + 1;
}
