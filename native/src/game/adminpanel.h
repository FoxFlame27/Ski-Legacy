// "Admin · new" (src/ui/adminnew.js + adminnew.css / admin.css, Oct 31 2026: "an admin panel, 'new', only for
// Icey27"), with the old panel's free camera it reuses (src/ui/admin.js startFly / stopFly / update / dropHere).
//
// F10 or Ctrl+Shift+A opens it, Esc / F10 / Ctrl+Shift+A closes it; for anyone but the account Icey27 the keys do
// nothing at all (multiplayer: the name you are logged in with; single player: this computer's saved multiplayer
// account, net/session.js loadAccount). (Native: a controller opens it from the pause menu, ADMIN, shown to Icey27
// only: the JS has no controller binding for it.)
//   PLAYER / YOU   money (give / take; multiplayer: anyone by name, online or not, and everyone online, offline too
//                  when ticked), out of prison / the police chase called off / cars out of the tow yard, kick, reset a
//                  player's progress (the name typed again), the FREE CAMERA switch, the result line
//   WORLD / TIME & WEATHER   the clock (a slider, dawn / noon / dusk / night) and the eleven weathers; the server
//                  message banner for everyone (multiplayer)
//   PLAYERS ONLINE (multiplayer: name, money, where, PRISON / WANTED / TOW YARD / INSIDE; GO TO, BRING) and TELEPORT
//                  (the village, the chalet village, the Autohaus, the medical centre, the police station, every
//                  gondola's summit)
// Multiplayer: every action is an 'admin' request the server checks against the login (server.js adminOp / adminNew)
// and applies to its own records, so nothing reverts. Single player: your own game.
// FREE CAMERA (V, or the switch): W A S D / arrows fly where you look, Space / E up, C / Q down, Shift x6, the wheel
// sets the speed, T drops you on the snow under the camera, Esc back to the panel, V off; a controller: the left stick
// flies, the right stick looks, the bottom button / the left button up / down, RT fast, B back. The game is blocked
// meanwhile and the world streams round the camera; your skier stays where it was.
// Keyboard, mouse and controller all work in the panel: the arrows / D-pad / stick move the focus between the
// controls (left / right along a row), Enter / A uses one, Esc / B closes; LB / RB jump between the columns; the mouse
// hovers, clicks, drags the slider and scrolls the lists; a controller sets an amount with left / right (1,000 a step)
// and picks a player from the list for the name.
#pragma once
#include "core/input.h"
#include "core/math.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/menus.h"
#include <nlohmann/json.hpp>
#include <functional>
#include <string>
#include <vector>

namespace sl {

struct AdminHost {
  using Json = nlohmann::json;
  std::function<bool()> online;                                  // in a multiplayer world
  std::function<std::string()> account;                          // the logged-in name, else the saved account's ("")
  std::function<int()> worldId;
  std::function<int64_t()> money;
  std::function<void(int64_t delta)> addMoney;                   // single player: your balance (save + HUD)
  std::function<double()> hour;
  std::function<void(double)> setHour;                           // the game's clock (single player: the save's too)
  std::function<int()> weather;
  std::function<void(int w)> setWeather;                         // setWeather + held 5 min
  std::function<bool(const std::string& what)> releaseLocal;     // 'jail' | 'chase' | 'impound': done here
  std::function<std::string()> teleportRefusal;                  // "" when you can be moved
  std::function<void(double x, double z, double heading, const std::string& label)> teleport;   // the fade, moved, streamed
  struct Place { std::string label, sub; double x = 0, z = 0, heading = 0; };
  std::function<std::vector<Place>()> places;
  std::function<std::string()> camRefusal;                       // "" when the free camera may start
  std::function<void(double x, double z, double heading)> drop;  // T: your skier onto the snow under the camera
  std::function<double(double x, double z)> ground;
  std::function<void(const std::string& text, int kind)> flash;  // 0 good, 1 bad, 2 gold
  std::function<void(const char* name)> sound;
  std::function<void(const std::string& op, Json data, std::function<void(bool, const Json&, const std::string&)>)> op;
  std::function<void(double hour, const std::string& weather)> clock;   // (multiplayer) shown at once
  std::function<void(bool on)> relativeMouse;
  std::function<float()> sensitivity;
};

class AdminPanel {
public:
  AdminPanel(Menus& menus, Ui& ui, platform::Platform& plat, Input& input, AdminHost host)
      : menus_(menus), ui_(ui), plat_(plat), in_(input), h_(std::move(host)) {}
  /// the account is Icey27's (else nothing of this exists)
  bool allowed() const;
  bool isOpen() const { return menus_.customOpen("adminnew"); }
  bool flying() const { return fly_.on; }
  /// the HUD steps aside (admin.css: body.admin-open / admin-flying)
  bool hidesHud() const { return isOpen() || flying(); }
  /// a text field has the keys (game.cpp: the OS's text input on meanwhile)
  bool typing() const { return isOpen() && focusField_ >= 0 && !in_.usingGamepad(); }
  /// F10 / Ctrl+Shift+A, V: in the game (no menu open); canOpen: started, not paused, no other panel, no transition
  void gameKeys(const platform::Events& ev, bool canOpen);
  void toggle();
  bool open();
  void close();
  /// per frame after the game placed the camera: the free camera takes the view (dt: real seconds)
  void camera(Camera& cam, const platform::Events& ev, double dt);
  bool camStart();
  void camOff(const std::string& msg = "");

  // ---- (SKI_LEGACY_DEBUG=admintest) the panel driven as a player would: keys, a controller, the mouse, typed text
  struct TestHooks {
    std::function<dvec3()> playerPos;
    std::function<std::string()> banner;          // the server message last shown
    std::function<std::string()> serverWeather;   // (multiplayer) the world's weather
    std::function<double()> serverHour;           // (multiplayer) the world's clock (-1 none)
    std::function<void(const std::string& name)> shot;
    std::function<void(platform::Key k)> key;     // a real key press through the OS's event queue
  };
  /// one step a frame; true when done (ok: every check passed). Runs in single player and in multiplayer.
  bool test(double now, const TestHooks& t, bool& ok);

private:
  UiNav injected_;
  bool inject_ = false;
  int tStep_ = -1, tF_ = 0;
  double tT0_ = 0;
  int64_t tMoney_ = 0;
  dvec3 tPos_{0};
  bool tBusy_ = false;
  struct Item {
    std::string key;
    float x = 0, y = 0, w = 0, h = 0;
    int col = 0;                         // 0 the left column, 1 the players, 2 the teleports
    std::function<void()> act;
    std::function<void(int)> adjust;     // left / right on a slider / an amount (controller)
    std::function<void(float)> drag;     // the slider under the mouse (0..1)
    int field = -1;                      // a text field
  };
  enum Field { F_AMOUNT, F_ALL, F_NAME, F_CONFIRM, F_MSG, F_COUNT };
  void frame(const UiNav& nav, double dt, double now);
  void camFrame(const UiNav& nav);
  void input(const UiNav& nav, double now);
  void draw(double now);
  void move(int dx, int dy);
  void act(const std::string& a);
  void say(const std::string& text, bool bad = false);
  std::string name();
  std::string me() const;
  void refreshPlayers();
  void give(int sign);
  void giveAll(int sign);
  void setHour(double h);
  void setWeather(int w);
  void release(const std::string& what);
  void kick();
  void reset();
  void broadcast();
  void tpPlayer(const std::string& name, bool here);
  void teleport(const AdminHost::Place& p);
  void serverError(const std::string& op, const std::string& code);
  int itemAt(vec2 p) const;
  void ensureVisible(const Item& it);

  Menus& menus_;
  Ui& ui_;
  platform::Platform& plat_;
  Input& in_;
  AdminHost h_;
  std::vector<Item> items_;
  std::string focusKey_;
  int focusField_ = -1;
  std::string fields_[F_COUNT];
  std::string result_;
  bool resultBad_ = false, confirming_ = false, offline_ = false;
  struct Player { std::string name; int64_t money = 0; bool hasPos = false; double x = 0, z = 0; bool jailed = false, wanted = false, impound = false, inside = false; };
  std::vector<Player> players_;
  std::vector<AdminHost::Place> places_;
  double openT_ = 0, plT_ = 0, hourSentT_ = -1;
  double pendingHour_ = -1;
  bool dragging_ = false;
  std::string dragKey_;
  // the scrolling boxes: the left column, the players, the teleports (px; target and eased)
  float scroll_[3] = {0, 0, 0}, scrollT_[3] = {0, 0, 0}, boxY_[3] = {0, 0, 0}, boxH_[3] = {0, 0, 0}, boxX_[3] = {0, 0, 0}, boxW_[3] = {0, 0, 0}, content_[3] = {0, 0, 0};
  bool scrollToFocus_ = true;
  float u_ = 1;
  // the free camera
  struct Fly { bool on = false; dvec3 pos{0}; float yaw = 0, pitch = 0, speed = 14; bool back = false; } fly_;
  dvec3 camPos_{0};
  vec3 camFwd_{0, 0, -1};
  bool flyFromPanel_ = false;
};

} // namespace sl
