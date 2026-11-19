#include "game/cartest.h"
#include "core/log.h"
#include "game/buses.h"
#include "game/drive.h"
#include "game/menus.h"
#include "game/traffic.h"
#include "player/player.h"
#include "world/transport.h"
#include <algorithm>
#include <cmath>
#if __has_include(<SDL.h>)
#include <SDL.h>
#define SL_CARTEST_SDL 1
#endif

namespace sl {
using platform::Key;

namespace {
constexpr double VILLAGE_X = 4, VILLAGE_Z = 34;   // the plaza (main.js spawn)
// a world point's z in the showroom's own frame (the room's axes are the world's)
double stand_local_z(const CarFlowEnv& e, const dvec3& w) { return w.z - e.roomWorld(0, 0).z; }
#ifdef SL_CARTEST_SDL
SDL_Scancode scancodeOf(Key k) {
  if (int(k) >= int(Key::KeyA) && int(k) <= int(Key::KeyZ)) return SDL_Scancode(SDL_SCANCODE_A + (int(k) - int(Key::KeyA)));
  switch (k) {
    case Key::Space: return SDL_SCANCODE_SPACE;
    case Key::Enter: return SDL_SCANCODE_RETURN;
    case Key::Escape: return SDL_SCANCODE_ESCAPE;
    case Key::ShiftLeft: return SDL_SCANCODE_LSHIFT;
    case Key::ArrowUp: return SDL_SCANCODE_UP;
    case Key::ArrowDown: return SDL_SCANCODE_DOWN;
    case Key::ArrowLeft: return SDL_SCANCODE_LEFT;
    case Key::ArrowRight: return SDL_SCANCODE_RIGHT;
    default: return SDL_SCANCODE_UNKNOWN;
  }
}
SDL_Joystick* g_padJoy = nullptr;
SDL_GameController* g_pad = nullptr;
#endif
} // namespace

// ---------------------------------------------------------------- the input events
void CarFlowTest::key(Key k, bool down) {
  auto it = std::find(held_.begin(), held_.end(), k);
  if (down == (it != held_.end())) return;   // (no repeats: as the platform sees a held key)
  if (down) held_.push_back(k); else held_.erase(it);
#ifdef SL_CARTEST_SDL
  SDL_Event ev;
  SDL_zero(ev);
  ev.type = down ? SDL_KEYDOWN : SDL_KEYUP;
  ev.key.state = down ? SDL_PRESSED : SDL_RELEASED;
  ev.key.keysym.scancode = scancodeOf(k);
  ev.key.keysym.sym = SDL_GetKeyFromScancode(ev.key.keysym.scancode);
  ev.key.timestamp = SDL_GetTicks();
  if (SDL_Window* w = SDL_GetKeyboardFocus()) ev.key.windowID = SDL_GetWindowID(w);
  SDL_PushEvent(&ev);
#endif
}
void CarFlowTest::releaseAll() {
  std::vector<Key> h = held_;
  for (Key k : h) key(k, false);
  tapUp_.clear();
  if (padIndex_ >= 0) { for (int a = 0; a < 6; a++) padAxis(a, 0); for (int b = 0; b < 15; b++) padButton(b, false); }
}
// an SDL virtual game controller (SDL_JoystickAttachVirtualEx): the platform sees it as any controller plugged in
bool CarFlowTest::pad(bool on) {
#ifdef SL_CARTEST_SDL
  if (on && padIndex_ < 0) {
    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");   // (xvfb: no window has the focus)
    SDL_VirtualJoystickDesc desc;
    SDL_zero(desc);
    desc.version = SDL_VIRTUAL_JOYSTICK_DESC_VERSION;
    desc.type = SDL_JOYSTICK_TYPE_GAMECONTROLLER;
    desc.naxes = SDL_CONTROLLER_AXIS_MAX;
    desc.nbuttons = 15;
    desc.axis_mask = (1u << SDL_CONTROLLER_AXIS_MAX) - 1;
    desc.button_mask = (1u << 15) - 1;
    desc.name = "Ski Legacy test controller";
    padIndex_ = SDL_JoystickAttachVirtualEx(&desc);
    if (padIndex_ < 0) { SL_WARN("[autotest] cars: no virtual controller (%s)", SDL_GetError()); return false; }
    g_pad = SDL_GameControllerOpen(padIndex_);
    g_padJoy = g_pad ? SDL_GameControllerGetJoystick(g_pad) : SDL_JoystickOpen(padIndex_);
    return g_padJoy != nullptr;
  }
  if (!on && padIndex_ >= 0) {
    if (g_pad) SDL_GameControllerClose(g_pad); else if (g_padJoy) SDL_JoystickClose(g_padJoy);
    g_pad = nullptr; g_padJoy = nullptr;
    SDL_JoystickDetachVirtual(padIndex_);
    padIndex_ = -1;
  }
  return true;
#else
  (void)on;
  return false;
#endif
}
void CarFlowTest::padAxis(int axis, float v) {
#ifdef SL_CARTEST_SDL
  if (!g_padJoy) return;
  int idx = axis;
  if (g_pad) { SDL_GameControllerButtonBind b = SDL_GameControllerGetBindForAxis(g_pad, SDL_GameControllerAxis(axis)); if (b.bindType == SDL_CONTROLLER_BINDTYPE_AXIS) idx = b.value.axis; }
  SDL_JoystickSetVirtualAxis(g_padJoy, idx, Sint16(std::clamp(v, -1.f, 1.f) * 32767));
#else
  (void)axis; (void)v;
#endif
}
void CarFlowTest::padButton(int btn, bool down) {
#ifdef SL_CARTEST_SDL
  if (!g_padJoy) return;
  int idx = btn;
  if (g_pad) { SDL_GameControllerButtonBind b = SDL_GameControllerGetBindForButton(g_pad, SDL_GameControllerButton(btn)); if (b.bindType == SDL_CONTROLLER_BINDTYPE_BUTTON) idx = b.value.button; }
  SDL_JoystickSetVirtualButton(g_padJoy, idx, down ? 1 : 0);
#else
  (void)btn; (void)down;
#endif
}

// walking: the movement keys relative to where the camera looks (player.js: W is away from the camera)
bool CarFlowTest::walkTo(CarFlowEnv& e, double x, double z, double r, bool run) {
  const dvec3& p = e.player->pos;
  double dx = x - p.x, dz = z - p.z, d = std::hypot(dx, dz);
  if (d < r) { key(Key::KeyW, false); key(Key::KeyS, false); key(Key::KeyA, false); key(Key::KeyD, false); key(Key::ShiftLeft, false); return true; }
  dvec3 cf = glm::normalize(dvec3(e.camFwd.x, 0, e.camFwd.z) + dvec3(1e-9, 0, 0)), cr(-cf.z, 0, cf.x);
  // (walked into something for 2 s: a step to the side for a second, as a player goes round it)
  if (glm::length(dvec2(p.x - walkFrom_.x, p.z - walkFrom_.z)) > 1.0) { walkFrom_ = p; walkT_ = 0; }
  walkT_ += e.frameDt;
  if (walkT_ > 2.0) { dx = -dz * side_; dz = (x - p.x) * side_; d = std::hypot(dx, dz); }
  if (walkT_ > 3.0) { walkT_ = 0; walkFrom_ = p; side_ = -side_; }
  double fw = (dx * cf.x + dz * cf.z) / d, sd = (dx * cr.x + dz * cr.z) / d;
  key(Key::KeyW, fw > 0.38); key(Key::KeyS, fw < -0.38);
  key(Key::KeyD, sd > 0.38); key(Key::KeyA, sd < -0.38);
  key(Key::ShiftLeft, run && d > 6);
  return false;
}
// steering with A / D toward a point (bang-bang with a small dead band, as a player taps the keys)
void CarFlowTest::steerTo(CarFlowEnv& e, double x, double z) {
  dvec3 p = e.drive->pos();
  double err = wrapPi(std::atan2(x - p.x, z - p.z) - e.drive->yaw());
  key(Key::KeyA, err > 0.04);
  key(Key::KeyD, err < -0.04);
}

bool CarFlowTest::frame(CarFlowEnv& e) {
  for (Key k : tapUp_) key(k, false);   // (a tap: down one frame, up the next)
  tapUp_.clear();
  t_ += e.frameDt;
  n_++;
  Drive& dr = *e.drive;
  Player& pl = *e.player;
  auto fail = [&](bool& flag, const char* what) {
    flag = false; SL_WARN("[autotest] cars: %s -> FAILED", what); releaseAll(); pad(false);
    if (e.menus->dialogOpen()) e.menus->close();
    go(St::Village);
  };
  switch (st_) {
    case St::Setup: {
      // the cheapest car on show in the Autohaus (carrental.js RENTALS: the Golf GTI), money granted to afford it
      if (e.cheapest.empty() || !e.hasDoor) { fail(buyOk, "no showroom / no car for sale at the Autohaus"); break; }
      model_ = e.cheapest;
      price_ = e.cheapestPrice;
      e.grant(price_ + std::max<int64_t>(0, -e.money));   // (the price granted: the purchase leaves the money as it was)
      // on foot from the plaza if it is near, else from the road side of the yard, 40 m out from the sliding doors
      double dv = std::hypot(e.door.x - VILLAGE_X, e.door.z - VILLAGE_Z);
      double sx = VILLAGE_X, sz = VILLAGE_Z;
      // (the native village's Autohaus on the Dorfstrasse: the plaza's buildings stand between, so from the road too)
      if (dv > 60) { const double out = dv > 260 ? 40 : 22; sx = e.door.x + e.doorOut.x * out; sz = e.door.z + e.doorOut.y * out; }
      e.teleport(sx, sz, std::atan2(e.door.x - sx, e.door.z - sz));
      start_ = dvec3(sx, 0, sz);
      SL_INFO("[autotest] cars: the cheapest for sale is the %s ($%lld), in the showroom; the Autohaus door at (%.1f, %.1f), %.0f m from the plaza; walking from (%.1f, %.1f) with $%lld",
              e.cheapestLabel.c_str(), (long long)price_, e.door.x, e.door.z, dv, sx, sz, (long long)(std::max<int64_t>(0, e.money) + price_));
      go(St::WalkToDoor);
      break;
    }
    case St::WalkToDoor: {
      bool there = e.prompt == "Autohaus";
      if (n_ % 20 == 0) SL_INFO("[autotest] cars: walking t=%4.1fs at (%.1f, %.1f), %.1f m to the Autohaus door, prompt '%s'", t_, pl.pos.x, pl.pos.z, std::hypot(e.door.x - pl.pos.x, e.door.z - pl.pos.z), e.prompt.c_str());
      if (there) { walkTo(e, pl.pos.x, pl.pos.z, 1, false); SL_INFO("[autotest] cars: at the sliding doors after %.1f s on foot: '%s'", t_, e.prompt.c_str()); go(St::EnterHall); break; }
      walkTo(e, e.door.x, e.door.z, 0.3, true);
      if (t_ > 120) fail(buyOk, "walking to the Autohaus door took over 2 minutes");
      break;
    }
    case St::EnterHall:
      if (n_ == 2) tap(Key::KeyE);
      if (n_ == 8) {
        if (!e.inShowroom) { fail(buyOk, ("E at the Autohaus door: not inside (prompt '" + e.prompt + "')").c_str()); break; }
        dvec3 stand, target;
        if (!e.spot("car", model_, stand, target)) { fail(buyOk, "the cheapest car is not on show"); break; }
        // the way round the cars on their turntables (carrentalshell.js LAYOUT.spots: the Golf stands at the back on
        // the left, under the mezzanine): along the front aisle, through the gap in the middle row, along the back aisle
        path_ = {e.roomWorld(-6.4, 2.6), e.roomWorld(-6.4, stand_local_z(e, stand)), stand};
        wp_ = 0; aim_ = target;
        SL_INFO("[autotest] cars: E -> in the showroom at (%.1f, %.1f); the %s stands %.1f m away", pl.pos.x, pl.pos.z, e.cheapestLabel.c_str(), std::hypot(stand.x - pl.pos.x, stand.z - pl.pos.z));
        go(St::WalkToSale);
      }
      break;
    case St::WalkToSale: {
      if (wp_ < int(path_.size())) {
        const dvec3& w = path_[size_t(wp_)];
        if (walkTo(e, w.x, w.z, wp_ + 1 == int(path_.size()) ? 0.35 : 0.6, false)) wp_++;
        if (n_ % 20 == 0) SL_INFO("[autotest] cars: in the showroom t=%4.1fs, waypoint %d, %.1f m to go", t_, wp_, std::hypot(w.x - pl.pos.x, w.z - pl.pos.z));
      } else {
        e.lookAt(aim_);   // (the mouse: the crosshair on the car)
        bool there = e.prompt.find(e.cheapestLabel) != std::string::npos;
        if (there && n_ > 3) { money0_ = e.money; garage0_ = e.garage; SL_INFO("[autotest] cars: looking at the %s after %.1f s in the showroom: '%s'", e.cheapestLabel.c_str(), t_, e.prompt.c_str()); go(St::OpenSale); break; }
      }
      if (t_ > 90) fail(buyOk, ("walking to the car on show took over 90 s (prompt '" + e.prompt + "')").c_str());
      break;
    }
    case St::OpenSale:
      if (n_ == 2) tap(Key::KeyE);
      if (n_ == 6) {
        if (!e.menus->dialogOpen()) { fail(buyOk, ("E at the car on show opened no configurator (prompt '" + e.prompt + "')").c_str()); break; }
        SL_INFO("[autotest] cars: E -> the configurator is open on the car (the camera on its turntable: %s), focus on '%s'", e.configuring ? "yes" : "NO", e.menus->focusedLabel().c_str());
        if (!e.configuring) { fail(buyOk, "the configurator did not take the showroom's car"); break; }
        e.png("config");
        go(St::ConfirmBuy);
      }
      break;
    case St::ConfirmBuy:
      // (the menus read their keys on the frames they draw: the autotest draws every 4th, so the taps come 5 frames apart)
      if (e.menus->dialogOpen() && e.menus->focusedLabel() != "Buy it") { if (n_ % 5 == 1) e.menus->focusLabel("Buy it"); if (n_ > 40) { fail(buyOk, "no 'Buy it' on the configurator's summary"); } break; }   // (straight to its summary)
      if (e.menus->dialogOpen() && n_ < 40) { if (n_ % 5 == 1) tap(Key::Enter); break; }
      {
        bool paid = e.money == money0_ - price_ && e.garage == garage0_ + 1;
        own_ = -1;
        for (size_t i = 0; i < dr.parked.size(); i++) if (dr.parked[i].owned && dr.parked[i].name == model_) own_ = int(i);
        SL_INFO("[autotest] cars: Enter on 'Buy it': $%lld -> $%lld (price $%lld), garage %zu -> %zu, configurator %s -> %s", (long long)money0_, (long long)e.money, (long long)price_, garage0_, e.garage,
                e.menus->dialogOpen() ? "still open" : "closed", paid && own_ >= 0 ? "ok" : "FAILED");
        if (!paid || own_ < 0) { fail(buyOk, "the purchase"); break; }
        // back the way you came, to the sliding doors
        dvec3 stand, target;
        if (!e.spot("door", "", stand, target)) { fail(buyOk, "no door to leave the showroom by"); break; }
        path_ = {e.roomWorld(-6.4, stand_local_z(e, pl.pos)), e.roomWorld(-6.4, 2.6), stand};
        wp_ = 0; aim_ = target;
        go(St::LeaveHall);
      }
      break;
    case St::LeaveHall: {
      if (wp_ < int(path_.size())) {
        const dvec3& w = path_[size_t(wp_)];
        // (the view turned along the way: W is where you look)
        if (n_ < 3) e.lookAt(dvec3(w.x, pl.pos.y + 1.5, w.z));
        if (walkTo(e, w.x, w.z, wp_ + 1 == int(path_.size()) ? 0.35 : 0.6, false)) wp_++;
      } else if (e.inShowroom) {
        e.lookAt(aim_);
        if (e.prompt == "Leave the Autohaus" && n_ % 6 == 0) tap(Key::KeyE);
      } else {
        SL_INFO("[autotest] cars: E at the sliding doors -> outside again at (%.1f, %.1f) after %.1f s", pl.pos.x, pl.pos.z, t_);
        go(St::WalkToCar);
        break;
      }
      if (t_ > 90) fail(buyOk, ("leaving the showroom took over 90 s (prompt '" + e.prompt + "')").c_str());
      break;
    }
    case St::WalkToCar: {
      const Drive::Parked& c = dr.parked[size_t(own_)];
      bool there = e.prompt.rfind("Drive ", 0) == 0;
      if (n_ % 20 == 0) SL_INFO("[autotest] cars: to my car t=%4.1fs, %.1f m, prompt '%s'", t_, std::hypot(c.x - pl.pos.x, c.z - pl.pos.z), e.prompt.c_str());
      if (there) { walkTo(e, pl.pos.x, pl.pos.z, 1, false); SL_INFO("[autotest] cars: beside my %s in its bay at (%.1f, %.1f): '%s'", c.spec->label.c_str(), c.x, c.z, e.prompt.c_str()); go(St::GetIn); break; }
      double tx = c.x + std::sin(c.yaw) * (c.length / 2 + 1.2), tz = c.z + std::cos(c.yaw) * (c.length / 2 + 1.2);
      walkTo(e, tx, tz, 0.3, true);
      if (t_ > 90) fail(enterOk, "walking to my car took over 90 s");
      break;
    }
    case St::GetIn:
      if (n_ == 2) tap(Key::KeyE);
      if (n_ == 6) {
        if (!e.driving) { fail(enterOk, ("E beside my car: not in it (prompt '" + e.prompt + "')").c_str()); break; }
        SL_INFO("[autotest] cars: E -> in the %s ('%s')", dr.parked[size_t(own_)].spec->label.c_str(), dr.label().c_str());
        start_ = dr.pos(); last_ = start_; top_ = 0; dist_ = 0;
        // out of the car park: its exit, then the road it leads to (the longer way along it)
        road_ = -1;
        go(St::Drive);
      }
      break;
    case St::Drive: {
      // hold W 10 s, steering with A / D: across the car park to its exit, then along the right-hand lane of the road
      dvec3 p = dr.pos();
      dist_ += glm::length(dvec2(p.x - last_.x, p.z - last_.z));
      last_ = p;
      top_ = std::max(top_, dr.speed());
      if (road_ < 0) {
        Transport::RoadHit rh = e.transport->nearestRoad(p.x, p.z, 40);
        if (rh.road >= 0) {
          const Road& r = e.transport->roads[size_t(rh.road)];
          RoadPoint q = roadAt(r, rh.s);
          int dir = std::sin(dr.yaw()) * q.dx + std::cos(dr.yaw()) * q.dz >= 0 ? 1 : -1;
          if (dir > 0 ? r.length - rh.s < 200 : rh.s < 200) dir = -dir;
          if (r.village) dir = -1;   // (the Dorfstrasse: on toward the valley road it leaves from, not to its dead end)
          road_ = rh.road * 2 + (dir > 0 ? 1 : 0);
          SL_INFO("[autotest] cars: heading for road %d (%.0f m long, %s) at s=%.0f", rh.road, r.length, r.access ? "access" : "main", rh.s);
          // (the drive is a check of the car, not of the traffic: a car that happens to stand at the yard's exit would block it)
          if (e.traffic) e.traffic->clearNear(dr.pos(), 120, 40);
        }
      }
      if (road_ >= 0) {
        const Road& r = e.transport->roads[size_t(road_ / 2)];
        int dir = road_ % 2 ? 1 : -1;
        Transport::RoadHit rh = e.transport->nearestRoad(p.x, p.z, 60);
        double s = rh.s;
        if (rh.road != road_ / 2) {   // (still in the car park: the nearest point of that road)
          double bd = 1e18;
          for (int i = 0; i < r.n; i++) { double d = std::hypot(r.X[size_t(i)] - p.x, r.Z[size_t(i)] - p.z); if (d < bd) { bd = d; s = r.S[size_t(i)]; } }
        }
        double ahead = 8 + dr.speed() * 0.9;
        // (the Dorfstrasse's end at the bus terminus: on along the exported road it meets there, away from the junction)
        if (r.village && dir < 0 && s < ahead + 4) {
          const RoadPoint a = roadAt(r, 0);
          int best = -1; double bs = 0, bd = 25;
          for (size_t k = 0; k < e.transport->roads.size(); k++) {
            const Road& o = e.transport->roads[k];
            if (o.village || o.n < 2) continue;
            for (double os : {0.0, o.length}) { const RoadPoint b = roadAt(o, os); const double d = std::hypot(b.x - a.x, b.z - a.z); if (d < bd) { bd = d; best = int(k); bs = os; } }
          }
          if (best >= 0) { road_ = best * 2 + (bs == 0 ? 1 : 0); SL_INFO("[autotest] cars: the Dorfstrasse's end: on along road %d", best); break; }
        }
        RoadPoint q = roadAt(r, std::clamp(s + dir * ahead, 1.0, r.length - 1));
        steerTo(e, q.x - q.dz * dir * 1.6, q.z + q.dx * dir * 1.6);   // (the right-hand lane)
      }
      key(Key::KeyW, true);
      if (n_ % 10 == 0) SL_INFO("[autotest] cars: W held t=%4.1fs  %5.1f km/h  %s  at (%.1f, %.1f)", t_, dr.speed() * 3.6, dr.label().c_str(), p.x, p.z);
      if (!e.driving) { fail(driveOk, "thrown out of the car while driving"); break; }
      if (t_ >= 10) {
        key(Key::KeyW, false); key(Key::KeyA, false); key(Key::KeyD, false);
        bool ok = top_ > 40 / 3.6 && dist_ > 40;
        SL_INFO("[autotest] cars: W held 10 s: %.0f m, top %.1f km/h, damage %.0f%% -> %s", dist_, top_ * 3.6, dr.damage(), ok ? "ok" : "FAILED");
        if (!ok) driveOk = false;
        e.png("cars");
        go(St::Stop);
      }
      break;
    }
    case St::Stop:
      key(Key::KeyS, dr.speed() > 0.3);
      if (dr.speed() <= 0.3 && n_ > 2) { key(Key::KeyS, false); go(St::GetOut); }
      if (t_ > 15) { fail(exitOk, "S did not stop the car in 15 s"); }
      break;
    case St::GetOut:
      if (n_ == 2) {
        if (e.prompt.rfind("Get out", 0) != 0) SL_WARN("[autotest] cars: stopped, prompt '%s'", e.prompt.c_str());
        tap(Key::KeyE);
      }
      if (n_ == 6) {
        bool out = !e.driving && pl.mode != PlayerMode::Sit;
        SL_INFO("[autotest] cars: E at a standstill -> %s at (%.1f, %.1f) -> %s", out ? "out of the car" : "still in it", pl.pos.x, pl.pos.z, out ? "ok" : "FAILED");
        if (!out) { fail(exitOk, "getting out"); break; }
        go(St::PadIn);
      }
      break;
    // ---- the same with a controller: X (the left button) in, RT throttle, the left stick, LT brake, X out
    case St::PadIn:
      if (n_ == 1 && !pad(true)) { SL_WARN("[autotest] cars: no virtual controller here: the controller drive skipped"); go(St::Village); break; }
      if (n_ == 8) padButton(2 /*X: the left button*/, true);
      if (n_ == 9) padButton(2 /*X: the left button*/, false);
      if (n_ == 14) {
        if (!e.driving) { fail(padOk, ("controller X beside my car: not in it (prompt '" + e.prompt + "')").c_str()); break; }
        SL_INFO("[autotest] cars: controller X -> in the car again");
        padTop_ = 0; last_ = dr.pos(); dist_ = 0; road_ = -1;
        go(St::PadDrive);
      }
      break;
    case St::PadDrive: {
      dvec3 p = dr.pos();
      dist_ += glm::length(dvec2(p.x - last_.x, p.z - last_.z));
      last_ = p;
      padTop_ = std::max(padTop_, dr.speed());
      padAxis(5 /*right trigger*/, 1.f);
      // the left stick toward the road ahead (analog)
      Transport::RoadHit rh = e.transport->nearestRoad(p.x, p.z, 40);
      double steer = 0;
      if (rh.road >= 0) {
        const Road& r = e.transport->roads[size_t(rh.road)];
        RoadPoint q = roadAt(r, rh.s);
        int dir = std::sin(dr.yaw()) * q.dx + std::cos(dr.yaw()) * q.dz >= 0 ? 1 : -1;
        RoadPoint a = roadAt(r, std::clamp(rh.s + dir * (8 + dr.speed() * 0.9), 1.0, r.length - 1));
        double tx = a.x - a.dz * dir * 1.6, tz = a.z + a.dx * dir * 1.6;
        steer = std::clamp(wrapPi(std::atan2(tx - p.x, tz - p.z) - dr.yaw()) * 2.0, -1.0, 1.0);
      }
      padAxis(0 /*left x*/, float(-steer));   // (stick right = steer right)
      if (n_ % 10 == 0) {
        // (the nearest traffic car: what stopped it, when something did)
        double nd = 1e9; int ni = -1, np = 0;
        if (e.traffic) for (size_t i = 0; i < e.traffic->list.size(); i++) { const auto& c = e.traffic->list[i]; if (c.mode == Traffic::Car::Mode::Gone) continue; const double d = std::hypot(c.x - p.x, c.z - p.z); if (d < nd) { nd = d; ni = int(i); np = c.pass; } }
        SL_INFO("[autotest] cars: RT held t=%4.1fs  %5.1f km/h  stick %.2f  %s  at (%.1f, %.1f)  nearest traffic car %d %.1f m (pass %d)", t_, dr.speed() * 3.6, -steer, dr.label().c_str(), p.x, p.z, ni, nd, np);
      }
      if (!e.driving) { fail(padOk, "out of the car while driving with the controller"); break; }
      if (t_ >= 5) {
        padAxis(5, 0); padAxis(0, 0);
        // (the throttle and the stick work when it got going: it may then meet a bus standing at the stop ahead or a car,
        // and stop there, as it should; Nov 19: the bus at the town hall stop took it at 25 km/h)
        bool ok = padTop_ > 20 / 3.6 && (dist_ > 20 || padTop_ > 24 / 3.6);
        SL_INFO("[autotest] cars: RT held 5 s: %.0f m, top %.1f km/h -> %s", dist_, padTop_ * 3.6, ok ? "ok" : "FAILED");
        if (!ok) padOk = false;
        go(St::PadStop);
      }
      break;
    }
    case St::PadStop:
      padAxis(4 /*left trigger*/, dr.speed() > 0.3 ? 1.f : 0.f);
      if (dr.speed() <= 0.3 && n_ > 2) { padAxis(4, 0); go(St::PadOut); }
      if (t_ > 15) fail(padOk, "LT did not stop the car in 15 s");
      break;
    case St::PadOut:
      if (n_ == 3) padButton(2 /*X: the left button*/, true);
      if (n_ == 4) padButton(2 /*X: the left button*/, false);
      if (n_ == 8) {
        bool out = !e.driving;
        SL_INFO("[autotest] cars: controller X at a standstill -> %s -> %s", out ? "out of the car" : "still in it", out ? "ok" : "FAILED");
        if (!out) padOk = false;
        pad(false);
        go(St::Village);
      }
      break;
    // ---- the traffic round the village: 30 s on the plaza
    case St::Village:
      if (n_ == 1) {
        releaseAll();
        if (e.driving) { SL_WARN("[autotest] cars: still driving, the traffic check skipped"); go(St::Done); break; }
        e.teleport(VILLAGE_X, VILLAGE_Z, 3.14159265358979);
        seen_.assign(e.traffic->list.size(), Seen{});
        int road = 0, parked = 0, gone = 0, near = 0;
        for (const auto& c : e.traffic->list) {
          road += c.mode == Traffic::Car::Mode::Road; parked += c.mode == Traffic::Car::Mode::Parked; gone += c.mode == Traffic::Car::Mode::Gone;
          near += c.mode != Traffic::Car::Mode::Gone && std::hypot(c.x - VILLAGE_X, c.z - VILLAGE_Z) < 300;
        }
        SL_INFO("[autotest] cars: on the plaza: traffic %zu cars (%d on the roads, %d parked, %d gone), %d within 300 m", e.traffic->list.size(), road, parked, gone, near);
      }
      if (n_ >= 2) go(St::Traffic);
      break;
    case St::Traffic: {
      int drawn = 0;
      for (size_t k = 0; k < e.traffic->list.size() && k < seen_.size(); k++) {
        const auto& c = e.traffic->list[k];
        Seen& s = seen_[k];
        bool near = c.mode == Traffic::Car::Mode::Road && std::hypot(c.x - VILLAGE_X, c.z - VILLAGE_Z) < 300;
        if (c.mode != Traffic::Car::Mode::Gone && std::hypot(c.x - e.camPos.x, c.z - e.camPos.z) < 300) { drawn++; s.drawn = true; }
        if (!near) { s.odo0 = -1; continue; }
        if (s.odo0 < 0) s.odo0 = c.odo;
        s.moved = std::max(s.moved, c.odo - s.odo0);
      }
      busesNear_ = 0;
      std::vector<Obb> boxes;
      e.buses->boxes(boxes);
      for (const Obb& b : boxes) busesNear_ += std::hypot(b.x - VILLAGE_X, b.z - VILLAGE_Z) < 300;
      if (n_ % 50 == 0) SL_INFO("[autotest] cars: plaza t=%4.1fs: %d traffic cars drawn round you, %d moving, %d buses within 300 m", t_, drawn, e.traffic->movingCount(), busesNear_);
      if (t_ >= 30) {
        int moving = 0, drawnEver = 0;
        for (const Seen& s : seen_) { moving += s.moved > 15; drawnEver += s.drawn; }
        parkedNear_ = 0;
        for (const auto& p : dr.parked) parkedNear_ += !p.owned && std::hypot(p.x - VILLAGE_X, p.z - VILLAGE_Z) < 300;
        trafficOk = moving >= 3;
        SL_INFO("[autotest] cars: 30 s on the plaza: %d traffic cars drove 15+ m within 300 m of it (%d drawn), %d parked cars, %d buses there -> %s", moving, drawnEver, parkedNear_, busesNear_,
                trafficOk ? "ok" : "FAILED");
        go(St::Shot);
      }
      break;
    }
    case St::Shot: {
      // a look at the nearest car driving there (its driver at the wheel): from 7 m off its left side, kept beside it
      if (n_ == 1) {
        shotCar_ = -1;
        double bd = 1e18;
        for (size_t k = 0; k < e.traffic->list.size(); k++) {
          const auto& c = e.traffic->list[k];
          double d = std::hypot(c.x - VILLAGE_X, c.z - VILLAGE_Z);
          if (c.mode == Traffic::Car::Mode::Road && c.v > 3 && d < bd) { bd = d; shotCar_ = int(k); }
        }
        if (shotCar_ < 0) { go(St::Done); break; }
      }
      const auto& c = e.traffic->list[size_t(shotCar_)];
      double lx = std::cos(c.yaw), lz = -std::sin(c.yaw);   // (its left: the driver's side)
      double px = c.x + lx * 5.5 + std::sin(c.yaw) * 3, pz = c.z + lz * 5.5 + std::cos(c.yaw) * 3;
      e.teleport(px, pz, std::atan2(c.x - px, c.z - pz));
      if (n_ == 6) {
        SL_INFO("[autotest] cars: a look at the %s driving at %.0f km/h, %d people in the cars near the camera", c.name.c_str(), c.v * 3.6, e.traffic->peopleShown);
        e.png("traffic");
      }
      if (n_ >= 10) go(St::Done);
      break;
    }
    case St::Done:
      releaseAll();
      if (e.menus->dialogOpen()) e.menus->close();
      // (the test's own tidying: the car it bought back in a bay of the Autohaus car park, not left on a road to be towed
      // while the later checks run)
      if (own_ >= 0 && size_t(own_) < dr.parked.size() && !dr.parked[size_t(own_)].driving && e.ground) {
        Drive::Parked& c = dr.parked[size_t(own_)];
        double x, z, yaw;
        if (dr.freeBay(x, z, yaw)) { c.x = x; c.z = z; c.yaw = yaw; c.y = e.ground(x, z) + 0.03; }
      }
      return true;
  }
  return false;
}

} // namespace sl
