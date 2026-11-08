#include "core/input.h"
#include <nlohmann/json.hpp>
#include <cmath>
#include <algorithm>

namespace sl {
using platform::Key;

static const ActionInfo kActions[kActionCount] = {
  {"forward", "Forward · push / tuck · accelerate", "MOVE", false},
  {"back", "Back · brake / reverse", "MOVE", false},
  {"left", "Left · steer / spin", "MOVE", false},
  {"right", "Right · steer / spin", "MOVE", false},
  {"jump", "Jump (hold to crouch) · handbrake", "MOVE", false},
  {"sprint", "Sprint · grab in the air · boost", "MOVE", false},
  {"brake", "Brake (controller trigger)", "MOVE", true},
  {"interact", "Interact · get in / out", "ACTIONS", false},
  {"view", "First / third person", "ACTIONS", false},
  {"skis", "Skis on / off", "ACTIONS", false},
  {"horn", "Horn (car)", "ACTIONS", false},
  {"lights", "Headlamp · car lights", "ACTIONS", false},
  {"lookback", "Look back (car)", "ACTIONS", false},
  {"pickup", "Pick up (chalet build mode)", "ACTIONS", false},
  {"alt", "Sell (chalet build mode)", "ACTIONS", false},
  {"unstuck", "Unstuck car", "ACTIONS", false},
  {"restart", "Restart race", "ACTIONS", false},
  {"furnish", "Furnish chalet · stand up (train) · flip car", "ACTIONS", false},
  {"prevItem", "Previous furniture (build mode)", "ACTIONS", false},
  {"nextItem", "Next furniture (build mode)", "ACTIONS", false},
  {"duty", "Taxi: off duty (in your car)", "ACTIONS", false},
  {"vmouse", "Virtual mouse (chalet / menus)", "ACTIONS", true},
  {"map", "Trail map · furnish (controller, in your chalet)", "MENUS", false},
  {"pause", "Pause menu", "MENUS", false},
};
const ActionInfo& actionInfo(Action a) { return kActions[size_t(a)]; }

// bindings.js KB_DEFAULTS (the action's game code) and PAD_DEFAULTS (standard-layout button index)
static const char* const kKbDefault[kActionCount] = {
  "KeyW", "KeyS", "KeyA", "KeyD", "Space", "ShiftLeft", "", "KeyE", "KeyR", "KeyG", "KeyH", "KeyL", "KeyC", "KeyQ",
  "KeyX", "KeyU", "Backspace", "KeyF", "BracketLeft", "BracketRight", "KeyT", "", "KeyM", "Escape"};
static const int kPadDefault[kActionCount] = {
  -1, -1, -1, -1, /*jump*/ 0, /*sprint*/ 7, /*brake*/ 6, /*interact*/ 2, /*view*/ 5, /*skis*/ 3, /*horn*/ 1,
  /*lights*/ 15, /*lookback*/ 10, /*pickup*/ 4, /*alt*/ 11, /*unstuck*/ 14, /*restart*/ 13, /*furnish*/ 3,
  /*prevItem*/ 14, /*nextItem*/ 15, /*duty*/ 4, /*vmouse*/ 10, /*map*/ 8, /*pause*/ 9};

Input::Input() { resetBindings(); }

void Input::resetBindings() {
  for (size_t i = 0; i < kActionCount; i++) {
    kb[i] = platform::keyFromCode(kKbDefault[i]);
    pad[i] = kPadDefault[i];
  }
}

platform::Key Input::defaultKey(Action a) { return platform::keyFromCode(kKbDefault[size_t(a)]); }
int Input::defaultPad(Action a) { return kPadDefault[size_t(a)]; }

nlohmann::json Input::bindingsJson() const {
  nlohmann::json kbj = nlohmann::json::object(), padj = nlohmann::json::object();
  for (size_t i = 0; i < kActionCount; i++) {
    if (!kActions[i].padOnly && kb[i] != defaultKey(Action(i))) kbj[kActions[i].id] = platform::keyCode(kb[i]);
    if (pad[i] != kPadDefault[i] && pad[i] >= 0) padj[kActions[i].id] = pad[i];
  }
  return nlohmann::json{{"kb", kbj}, {"pad", padj}};
}

void Input::applyBindings(const nlohmann::json& b) {
  auto find = [](const std::string& id) -> int {
    for (size_t i = 0; i < kActionCount; i++) if (id == kActions[i].id) return int(i);
    return -1;
  };
  if (b.contains("kb") && b["kb"].is_object())
    for (auto& [id, code] : b["kb"].items()) if (int i = find(id); i >= 0 && code.is_string()) kb[i] = platform::keyFromCode(code.get<std::string>());
  if (b.contains("pad") && b["pad"].is_object())
    for (auto& [id, btn] : b["pad"].items()) if (int i = find(id); i >= 0 && btn.is_number_integer()) pad[i] = btn.get<int>();
}

void Input::setDown(size_t i, bool d) {
  if (d && !down_[i]) pressed_[i]++;
  if (!d && down_[i]) released_[i]++;
  down_[i] = d;
}

void Input::inject(Action a, bool isDown) { forced_[size_t(a)] = isDown ? 1 : 0; setDown(size_t(a), isDown); }

void Input::clear() {
  down_.fill(false); pressed_.fill(0); released_.fill(0);
  moveX_ = moveY_ = lookX_ = lookY_ = wheel_ = 0;
}

void Input::update(platform::Platform& p, const platform::Events& ev) {
  // the first connected controller that is touched becomes the active one (glyphs, rumble)
  platform::GamepadState gp{};
  bool havePad = false;
  for (int i = 0; i < p.gamepadCount(); i++) {
    platform::GamepadState s;
    p.gamepad(i, s);
    if (!s.connected) continue;
    bool touched = std::fabs(s.leftX) > 0.3f || std::fabs(s.leftY) > 0.3f || std::fabs(s.rightX) > 0.3f || std::fabs(s.rightY) > 0.3f;
    for (float v : s.buttons) touched = touched || v > 0.5f;
    if (activePad_ < 0 || (touched && i != activePad_)) activePad_ = i;
    if (i == activePad_) { gp = s; havePad = true; }
  }
  for (int k = 0; k < platform::kPadButtons; k++) prevButtons_[size_t(k)] = havePad_ ? gp_.buttons[k] : 0.f;
  havePad_ = havePad;
  gp_ = havePad ? gp : platform::GamepadState{};
  if (havePad) family_ = gp.family;
  bool anyKey = !ev.pressed.empty() || ev.mouseDX != 0 || ev.mouseDY != 0 || ev.mouseMoved || ev.mousePressed;
  bool anyPad = false;
  if (havePad) {
    for (float v : gp.buttons) anyPad = anyPad || v > 0.5f;
    anyPad = anyPad || std::fabs(gp.leftX) > 0.3f || std::fabs(gp.leftY) > 0.3f || std::fabs(gp.rightX) > 0.3f || std::fabs(gp.rightY) > 0.3f;
  }
  if (anyPad) padActive_ = true;
  else if (anyKey) padActive_ = false;

  for (size_t i = 0; i < kActionCount; i++) {
    bool d = kb[i] != Key::Unknown && p.keyDown(kb[i]);
    if (havePad && pad[i] >= 0 && pad[i] < platform::kPadButtons) d = d || gp.buttons[pad[i]] > 0.5f;
    if (forced_[i] >= 0) d = forced_[i] > 0;
    else if (holdOff_[i]) { if (d) d = false; else holdOff_[i] = false; }
    setDown(i, d);
  }
  // arrow keys move too (player.js reads both)
  auto key = [&](Key k) { return p.keyDown(k); };
  float kx = float((down(Action::Right) || key(Key::ArrowRight)) - (down(Action::Left) || key(Key::ArrowLeft)));
  float ky = float((down(Action::Forward) || key(Key::ArrowUp)) - (down(Action::Back) || key(Key::ArrowDown)));
  // left stick with a radial dead zone (0.2) rescaled to full range
  float sx = 0, sy = 0;
  if (havePad) {
    float lx = gp.leftX, ly = -gp.leftY, m = std::sqrt(lx * lx + ly * ly);
    if (m > 0.2f) { float k = std::min(1.f, (m - 0.2f) / 0.8f) / m; sx = lx * k; sy = ly * k; }
  }
  moveX_ = std::fabs(sx) > std::fabs(kx) ? sx : kx;
  moveY_ = std::fabs(sy) > std::fabs(ky) ? sy : ky;
  if (forcedMove_) { moveX_ = fmx_; moveY_ = fmy_; }
  // the stick also presses the directional actions (digital game code reads them)
  if (havePad && !forcedMove_) {
    if (sy > 0.5f) setDown(size_t(Action::Forward), true);
    if (sy < -0.5f) setDown(size_t(Action::Back), true);
    if (sx < -0.5f) setDown(size_t(Action::Left), true);
    if (sx > 0.5f) setDown(size_t(Action::Right), true);
  }
  lookX_ = ev.mouseDX * mouseSens; lookY_ = ev.mouseDY * mouseSens * (invertY ? -1.f : 1.f); wheel_ = ev.wheel;
  if (havePad) {
    auto dz = [](float v) { return std::fabs(v) < 0.15f ? 0.f : (v - (v > 0 ? 0.15f : -0.15f)) / 0.85f; };
    float rx = dz(gp.rightX), ry = dz(gp.rightY);
    lookX_ += rx * std::fabs(rx) * 18.f * padSens; // ~ mouse pixels per frame at full deflection
    lookY_ += ry * std::fabs(ry) * 12.f * padSens * (invertY ? -1.f : 1.f);
  }
  if (lookX_ != 0 || lookY_ != 0) lastLook_ = p.timeSeconds();
}

void Input::rumble(platform::Platform& p, float low, float high, uint32_t ms) {
  if (activePad_ >= 0 && vibration) p.rumble(activePad_, low, high, ms);
}

} // namespace sl
