// Input mapping: physical keys / controller buttons -> game actions.
//
// Same actions and the same default bindings as the JavaScript game (src/core/bindings.js): the keyboard defaults
// (W A S D, Space, Shift, E, R, G, ...) and the controller defaults by standard-layout POSITION (bottom button jumps,
// left button interacts, RT sprints, LT brakes, RB switches the view, ...). The left stick always moves and the
// right stick always looks (not rebindable), as in the web version. Bindings can be overridden from a JSON object
// shaped like the web save's `binds` ({ "kb": { "jump": "Space" }, "pad": { "jump": 0 } }).
#pragma once
#include "platform/platform.h"
#include <array>
#include <cstdint>
#include <nlohmann/json_fwd.hpp>

namespace sl {

enum class Action : uint8_t {
  Forward, Back, Left, Right, Jump, Sprint, Brake,
  Interact, View, Skis, Horn, Lights, LookBack, Pickup, Alt, Unstuck, Restart,
  Furnish, PrevItem, NextItem, Duty, VMouse,
  Map, Pause,
  Count
};
constexpr size_t kActionCount = size_t(Action::Count);

struct ActionInfo { const char* id; const char* label; const char* group; bool padOnly; };
const ActionInfo& actionInfo(Action a);

class Input {
public:
  Input();
  /// Apply a web-style `binds` object over the defaults (unknown ids are ignored, like bindsOf()).
  void applyBindings(const nlohmann::json& binds);
  void resetBindings();

  /// Sample keyboard, mouse and controllers once per rendered frame.
  void update(platform::Platform& p, const platform::Events& ev);
  /// Forget all held state (focus lost, menus).
  void clear();
  /// (menus closing) actions held right now stay ignored until released: the key or button that closed a menu does
  /// not also jump / pause in the game
  void holdOff() { holdOff_.fill(true); }

  bool down(Action a) const { return down_[size_t(a)]; }
  /// Edge triggered: true once per press, consumed by the call (so a press is seen by exactly one fixed tick).
  bool takePressed(Action a) { bool p = pressed_[size_t(a)] > 0; pressed_[size_t(a)] = 0; return p; }
  bool takeReleased(Action a) { bool r = released_[size_t(a)] > 0; released_[size_t(a)] = 0; return r; }

  /// Movement: x = right, y = forward, each -1..1 (keys give +-1, the stick is analog with a dead zone).
  float moveX() const { return moveX_; }
  float moveY() const { return moveY_; }
  /// Look delta this frame in "mouse pixels" (the right stick is scaled to feel like the mouse).
  float lookX() const { return lookX_; }
  float lookY() const { return lookY_; }
  float wheel() const { return wheel_; }
  bool usingGamepad() const { return padActive_; }
  platform::PadFamily padFamily() const { return family_; }
  /// Last time (s) the mouse / right stick moved (the camera's auto-follow waits for it to rest).
  double lastLookTime() const { return lastLook_; }

  /// (Phase 4, menus) the active controller's raw state this frame and button edges (any button, by position)
  bool padConnected() const { return havePad_; }
  const platform::GamepadState& padState() const { return gp_; }
  bool padPressed(int b) const { return havePad_ && b >= 0 && b < platform::kPadButtons && gp_.buttons[b] > 0.5f && prevButtons_[size_t(b)] <= 0.5f; }
  bool padDown(int b) const { return havePad_ && b >= 0 && b < platform::kPadButtons && gp_.buttons[b] > 0.5f; }
  /// the current bindings as the web save's `binds` ({ kb: {...}, pad: {...} }, only what differs from the defaults)
  nlohmann::json bindingsJson() const;
  static platform::Key defaultKey(Action a);
  static int defaultPad(Action a);

  // SETTINGS (core/settings.js): mouse / controller look sensitivity, invert Y, controller vibration
  float mouseSens = 1, padSens = 1;
  bool invertY = false, vibration = true;

  /// Rumble on the active controller (no-op without one). low / high 0..1.
  void rumble(platform::Platform& p, float low, float high, uint32_t ms);

  /// Inject a synthetic state (autotest / replays): overrides the devices until cleared with releaseInjected().
  void inject(Action a, bool isDown);
  void injectMove(float x, float y) { forcedMove_ = true; fmx_ = x; fmy_ = y; moveX_ = x; moveY_ = y; }
  void releaseInjected() { forced_.fill(-1); forcedMove_ = false; }

  std::array<platform::Key, kActionCount> kb;   // keyboard binding per action (Unknown = none)
  std::array<int, kActionCount> pad;            // controller button per action (-1 = none)

private:
  void setDown(size_t i, bool d);
  std::array<bool, kActionCount> down_{}, holdOff_{};
  std::array<int, kActionCount> pressed_{}, released_{};
  std::array<int8_t, kActionCount> forced_ = filled(-1);
  bool forcedMove_ = false;
  float fmx_ = 0, fmy_ = 0;
  static std::array<int8_t, kActionCount> filled(int8_t v) { std::array<int8_t, kActionCount> a; a.fill(v); return a; }
  float moveX_ = 0, moveY_ = 0, lookX_ = 0, lookY_ = 0, wheel_ = 0;
  bool padActive_ = false, havePad_ = false;
  platform::GamepadState gp_{};
  std::array<float, platform::kPadButtons> prevButtons_{};
  int activePad_ = -1;
  platform::PadFamily family_ = platform::PadFamily::Xbox;
  double lastLook_ = -1e9;
};

} // namespace sl
