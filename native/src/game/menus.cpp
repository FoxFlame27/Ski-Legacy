#include "game/menus.h"
#include "core/prompts.h"
#include "platform/platform.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace sl {
using namespace ui_color;
using platform::Key;
using platform::PadFamily;

namespace {
std::string fmtMoney(int64_t v) {
  std::string s = std::to_string(v < 0 ? -v : v), o;
  for (size_t i = 0; i < s.size(); i++) { if (i && (s.size() - i) % 3 == 0) o += ','; o += s[i]; }
  return (v < 0 ? "-" : "") + o;
}
std::string upper(std::string s) { for (char& c : s) c = char(std::toupper(static_cast<unsigned char>(c))); return s; }
int seedOf(const std::string& s) { int h = 7; for (char c : s) h = (h * 31 + c) % 997; return h; }

// menu.js SET_ROWS
struct SetRow {
  const char* key;      // nullptr: a section header (label)
  const char* label;
  char kind;            // 'q' quality, 'r' range, 't' toggle, 'c' choice, 'k' controls, 'h' hud mode, 'x' screen fx
  double min, max, step;
  const char* fmt;      // 'p' percent, 'x' multiplier, 'd' degrees
  std::vector<std::pair<nlohmann::json, std::string>> opts;
};
const std::vector<SetRow>& setRows() {
  static const std::vector<SetRow> rows = {
    {nullptr, "GRAPHICS", 0, 0, 0, 0, nullptr, {}},
    {"quality", "Graphics preset", 'q', 0, 0, 0, nullptr, {}},
    {"renderScale", "Render scale", 'r', 0.5, 1, 0.05, "p", {}},
    {"shadows", "Shadows", 't', 0, 0, 0, nullptr, {}},
    {"brightness", "Brightness", 'r', 0.7, 1.3, 0.05, "p", {}},
    {"fpsCap", "Frame rate limit", 'c', 0, 0, 0, nullptr, {{30, "30"}, {60, "60"}, {0, "Unlimited"}}},
    {"fullscreen", "Fullscreen", 't', 0, 0, 0, nullptr, {}},
    {nullptr, "AUDIO", 0, 0, 0, 0, nullptr, {}},
    {"volume", "Master volume", 'r', 0, 1, 0.05, "p", {}},
    {"musicVolume", "Music", 'r', 0, 1, 0.05, "p", {}},
    {"sfxVolume", "Sound effects", 'r', 0, 1, 0.05, "p", {}},
    {"muteUnfocused", "Mute in background", 't', 0, 0, 0, nullptr, {}},
    {nullptr, "CONTROLS", 0, 0, 0, 0, nullptr, {}},
    {"controls", "Keyboard & controller buttons", 'k', 0, 0, 0, nullptr, {}},
    {"sensitivity", "Mouse sensitivity", 'r', 0.3, 2.5, 0.1, "x", {}},
    {"padSens", "Controller look sensitivity", 'r', 0.3, 2.5, 0.1, "x", {}},
    {"invertY", "Invert look up / down", 't', 0, 0, 0, nullptr, {}},
    {"vibration", "Controller vibration", 't', 0, 0, 0, nullptr, {}},
    {nullptr, "CAMERA", 0, 0, 0, 0, nullptr, {}},
    {"fov", "Field of view", 'r', 50, 95, 1, "d", {}},
    {"defaultView", "Starting view", 'c', 0, 0, 0, nullptr, {{"third", "Third person"}, {"first", "First person"}}},
    {"camShake", "Camera shake", 't', 0, 0, 0, nullptr, {}},
    {"screenFx", "Screen effects (speed streaks, vignette)", 'x', 0, 0, 0, nullptr, {}},
    {nullptr, "HUD", 0, 0, 0, 0, nullptr, {}},
    {"hudMode", "HUD", 'h', 0, 0, 0, nullptr, {{"full", "Full"}, {"min", "Minimal"}, {"off", "Off"}}},
    {"hudScale", "HUD size", 'r', 0.8, 1.3, 0.05, "p", {}},
    {"speedUnit", "Speed unit", 'c', 0, 0, 0, nullptr, {{"kmh", "km/h"}, {"mph", "mph"}}},
    {"clock12", "Clock", 'c', 0, 0, 0, nullptr, {{false, "24-hour"}, {true, "12-hour"}}},
    {"nameTags", "Player names (multiplayer)", 't', 0, 0, 0, nullptr, {}},
    {"showFps", "Show FPS", 't', 0, 0, 0, nullptr, {}},
  };
  return rows;
}
const char* QUALITY_ORDER[] = {"super", "performance", "balanced", "high", "ultra", "superultra"};
const char* QUALITY_LABELS[] = {"Super Performance", "Performance", "Balanced", "High", "Ultra", "Super Ultra"};
const char* HUD_KEYS[] = {"showSpeedo", "showInfo", "showMoney", "showForecast"};
} // namespace

// ---------------------------------------------------------------- input
UiNav NavBuilder::build(const platform::Events& ev, platform::Platform& p, const Input& in, double now) {
  UiNav n;
  auto pressed = [&](Key k) { return std::find(ev.pressed.begin(), ev.pressed.end(), k) != ev.pressed.end(); };
  auto repeated = [&](Key k) { return std::find(ev.repeated.begin(), ev.repeated.end(), k) != ev.repeated.end(); };
  auto kp = [&](Key a, Key b) { return pressed(a) || pressed(b) || repeated(a) || repeated(b); };
  n.up = kp(Key::ArrowUp, Key::KeyW); n.down = kp(Key::ArrowDown, Key::KeyS);
  n.left = kp(Key::ArrowLeft, Key::KeyA); n.right = kp(Key::ArrowRight, Key::KeyD);
  n.confirm = pressed(Key::Enter) || pressed(Key::Space);
  n.cancel = pressed(Key::Escape) || pressed(Key::Backspace);
  n.menu = pressed(Key::Escape);
  n.tabPrev = pressed(Key::KeyQ); n.tabNext = pressed(Key::KeyE);
  n.keys = ev.pressed;
  n.wheel = ev.wheel;
  n.mouse = vec2(ev.mouseX, ev.mouseY);
  n.mouseMoved = ev.mouseMoved;
  n.click = (ev.mousePressed & 1) != 0;
  n.mouseDown = (ev.mouseButtons & 1) != 0;
  n.rightClick = (ev.mousePressed & 2) != 0;
  n.usingPad = in.usingGamepad();
  bool kz = p.keyDown(Key::KeyE) || p.keyDown(Key::BracketRight), ko = p.keyDown(Key::KeyQ) || p.keyDown(Key::BracketLeft);
  n.zoomIn = kz ? 1.f : 0.f; n.zoomOut = ko ? 1.f : 0.f;
  if (in.padConnected()) {
    const auto& g = in.padState();
    PadFamily f = in.padFamily();
    for (int b = 0; b < platform::kPadButtons; b++) if (in.padPressed(b)) { n.padButton = b; break; }
    if (in.padPressed(prompts::confirmButton(f))) n.confirm = true;
    if (in.padPressed(prompts::backButton(f))) n.cancel = true;
    if (in.padPressed(9)) n.menu = n.cancel = true;   // (Menu / Options / +: back out, resume from the pause menu)
    if (in.padPressed(4)) n.tabPrev = true;
    if (in.padPressed(5)) n.tabNext = true;
    n.stickL = vec2(g.leftX, g.leftY);
    n.stickR = vec2(g.rightX, g.rightY);
    n.zoomIn = std::max(n.zoomIn, g.buttons[7]);
    n.zoomOut = std::max(n.zoomOut, g.buttons[6]);
    // the D-pad and the left stick step through lists, repeating while held (0.38 s, then every 0.09 s)
    bool held[4] = {g.buttons[12] > 0.5f || g.leftY < -0.55f, g.buttons[13] > 0.5f || g.leftY > 0.55f,
                    g.buttons[14] > 0.5f || g.leftX < -0.55f, g.buttons[15] > 0.5f || g.leftX > 0.55f};
    bool* out[4] = {&n.up, &n.down, &n.left, &n.right};
    for (int d = 0; d < 4; d++) {
      if (!held[d]) { heldSince_[d] = -1; continue; }
      if (heldSince_[d] < 0) { heldSince_[d] = now; lastRep_[d] = now; *out[d] = true; }
      else if (now - heldSince_[d] > 0.38 && now - lastRep_[d] > 0.09) { lastRep_[d] = now; *out[d] = true; }
    }
  }
  return n;
}

// ---------------------------------------------------------------- navigation
void Menus::open(Screen s, int dir) {
  if (s == Screen::Showcase && hooks.showcase) hooks.showcase(true);
  else if (screen_ == Screen::Showcase && s != Screen::Showcase && hooks.showcase) hooks.showcase(false);
  if (s == Screen::Main) inGame = false;
  screen_ = s;
  dir_ = dir;
  focus_ = 0; focusPrev_ = -1;
  scroll_ = scrollTarget_ = 0;
  enterT_ = t_;
  captureAction_ = -1;
  ctlStatus_.clear();
  if (s == Screen::Showcase) chi_ = save_.character == "skier_red" ? 0 : 1;
  if (s == Screen::Multiplayer && mp.opened) mp.opened();
  if (s == Screen::Settings) {
    // start on the first row, the quality row
    focus_ = 0;
  }
}
void Menus::close() {
  if (screen_ == Screen::Showcase && hooks.showcase) hooks.showcase(false);
  screen_ = Screen::None;
  items_.clear();
}
void Menus::openDialog(Dialog d) {
  dialog_ = std::move(d);
  if (dialog_.rebuild) dialog_.rebuild(dialog_);
  open(Screen::Dialog);
}

void Menus::setFocus(int i) {
  int n = int(items_.size());
  if (!n) { focus_ = 0; return; }
  focus_ = ((i % n) + n) % n;
}

std::string Menus::focusedLabel() const { return focus_ >= 0 && focus_ < int(items_.size()) ? items_[size_t(focus_)].label : ""; }
bool Menus::focusLabel(const std::string& label) {
  for (size_t i = 0; i < items_.size(); i++) if (items_[i].label == label) { focus_ = int(i); return true; }
  return false;
}

void Menus::back() {
  switch (screen_) {
    case Screen::PlayMode: open(Screen::Main, -1); break;
    case Screen::Showcase: open(inGame ? Screen::Settings : Screen::PlayMode, -1); break;
    case Screen::Controls: open(ctlBack_ != Screen::None ? ctlBack_ : inGame ? Screen::Pause : Screen::Main, -1); break;
    case Screen::Stats: case Screen::Settings: open(inGame ? Screen::Pause : Screen::Main, -1); break;
    case Screen::Pause: if (hooks.resume) hooks.resume(); break;
    case Screen::Dialog: close(); break;
    case Screen::Confirm: open(confirmBack_, -1); break;
    case Screen::Multiplayer: if (mp.closed) mp.closed(); open(Screen::PlayMode, -1); break;
    default: break;
  }
}

void Menus::handle(const UiNav& nav) {
  int n = int(items_.size());
  auto hit = [&](vec2 m) -> int {
    for (int i = n - 1; i >= 0; i--) {
      const Item& it = items_[size_t(i)];
      if (m.x >= it.x && m.x <= it.x + it.w && m.y >= it.y && m.y <= it.y + it.h) {
        if (it.inList && (m.y < listTop_ || m.y > listTop_ + listH_)) continue;   // (scrolled out of the list)
        return i;
      }
    }
    return -1;
  };
  if (nav.mouse.x >= 0 && (nav.mouseMoved || nav.click)) { int h = hit(nav.mouse); if (h >= 0 && !items_[size_t(h)].disabled) focus_ = h; }
  if (nav.click && nav.mouse.x >= 0) {
    int h = hit(nav.mouse);
    if (h >= 0 && !items_[size_t(h)].disabled) {
      Item it = items_[size_t(h)];
      if (it.clickAt) it.clickAt(nav.mouse.x);
      else if (it.activate) it.activate();
      return;
    }
  }
  if (nav.wheel != 0 && listH_ > 0) scrollTarget_ = std::clamp(scrollTarget_ - nav.wheel * 70 * u_, 0.f, std::max(0.f, contentH_ - listH_));
  if (!n) { if (nav.cancel) back(); return; }
  focus_ = std::clamp(focus_, 0, n - 1);
  auto move = [&](int d) {
    int i = focus_;
    for (int k = 0; k < n; k++) { i = ((i + d) % n + n) % n; if (!items_[size_t(i)].disabled) break; }
    focus_ = i;
  };
  if (nav.up) move(-1);
  else if (nav.down) move(1);
  else if (nav.left || nav.right) {
    const Item& it = items_[size_t(focus_)];
    if (it.adjust) { auto f = it.adjust; f(nav.left ? -1 : 1); }
    else move(nav.left ? -1 : 1);
  } else if (nav.confirm) {
    const Item& it = items_[size_t(focus_)];
    if (!it.disabled && it.activate) { auto f = it.activate; f(); }
  } else if (nav.cancel) back();
}

// ---------------------------------------------------------------- drawing helpers
void Menus::drawShade(int mode) {
  float W = float(ui_.width()), H = float(ui_.height());
  if (mode == 1) ui_.rect(0, 0, W, H, a(shade, 0.62f));
  else if (mode == 2) ui_.rectGradient(0, 0, W * 0.6f, H, a(shade, 0.55f), a(shade, 0.0f));
  else ui_.rectGradient(0, 0, W, H, a(shade, 0.8f), a(shade, 0.12f));
}

void Menus::drawLogo(bool big) {
  float s = (big ? 1.f : 0.62f) * u_, x = 110 * u_, y = (big ? 56 : 30) * u_;
  // SKI LEGACY in the house style: a white stroke, LEGACY in blue italic, a red underline
  ui_.brushStroke(x - 20 * s, y, 480 * s, 120 * s, white, 77);
  ui_.text(x + 6 * s, y + 8 * s, 34 * s, UiFont::CondHeavy, red, "SKI");
  ui_.text(x + 4 * s, y + 30 * s, 84 * s, UiFont::CondHeavy, blue, "LEGACY");
}

void Menus::drawHints(const std::vector<std::pair<std::string, std::string>>& hints) {
  float x = 110 * u_, y = float(ui_.height()) - 52 * u_, h = std::max(17.f, 22 * u_), fs = std::max(11.f, 13 * u_);
  for (const auto& [k, label] : hints) {
    if (input_.usingGamepad() && (label.rfind("Drag", 0) == 0 || label.rfind("Click", 0) == 0)) continue;
    std::string cap;
    if (k == "updown") cap = prompts::K(input_, "updown");
    else if (k == "leftright") cap = prompts::K(input_, "leftright");
    else if (k == "enter") cap = prompts::K(input_, "confirm");
    else if (k == "esc") cap = prompts::K(input_, "cancel");
    else if (k == "tabs") cap = input_.usingGamepad() ? std::string(prompts::padGlyph(4, input_.padFamily())) + " " + prompts::padGlyph(5, input_.padFamily()) : "Q E";
    if (!cap.empty()) {
      // (arrows as two caps on the keyboard)
      if (!input_.usingGamepad() && (k == "updown" || k == "leftright")) {
        x += ui_.keycap(x, y, h, k == "updown" ? "\xE2\x86\x91" : "\xE2\x86\x90") + 3 * u_;
        x += ui_.keycap(x, y, h, k == "updown" ? "\xE2\x86\x93" : "\xE2\x86\x92") + 6 * u_;
      } else x += ui_.keycap(x, y, h, cap) + 6 * u_;
    }
    x += ui_.text(x, y + (h - ui_.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::Body, a(white, 0.92f), upper(label)) + 22 * u_;
  }
}

void Menus::heading(float x, float y, const std::string& title, const std::string& sub) {
  float w = std::min(760.f, 150.f + float(title.size()) * 26.f) * u_ * 0.9f, h = 90 * u_;
  float tw = ui_.textWidth(title, 44 * u_, UiFont::CondItalic) + 40 * u_ + h * 0.7f;
  w = std::max(w, tw);
  ui_.brushStroke(x, y, w, h, white, seedOf(title));
  ui_.text(x + 40 * u_, y + (h - ui_.lineHeight(44 * u_, UiFont::CondItalic)) / 2, 44 * u_, UiFont::CondItalic, blue, title);
  if (!sub.empty()) ui_.textWrapped(x + 12 * u_, y + h + 6 * u_, 820 * u_, std::max(13.f, 15 * u_), UiFont::Body, a(white, 0.92f), sub);
}

bool Menus::button(float x, float y, float minW, float h, float fs, const std::string& label, int seed, std::function<void()> act, bool disabled) {
  int idx = int(items_.size());
  bool foc = idx == focus_;
  float tw = ui_.textWidth(label, fs, UiFont::CondItalic);
  float w = std::max(minW, tw + 46 * u_ * (h / (82 * u_)) + h * 0.9f);
  float ox = foc ? 14 * u_ : 0;
  // slide in from the side on entering a screen
  float k = float(std::clamp((t_ - enterT_ - 0.04 * idx) / 0.25, 0.0, 1.0));
  float ease = 1 - (1 - k) * (1 - k) * (1 - k);
  ox += (1 - ease) * -40 * u_ * float(dir_);
  float alpha = ease * (disabled ? 0.55f : 1.f);
  if (foc) ui_.rect(x - 16 * u_, y + h * 0.3f, 6 * u_, h * 0.4f, a(red, alpha));
  ui_.brushStroke(x + ox, y, w * (foc ? 1.05f : 1.f), h, a(white, alpha), seed);
  ui_.text(x + ox + 46 * u_ * (h / (82 * u_)), y + (h - ui_.lineHeight(fs, UiFont::CondItalic)) / 2, fs, UiFont::CondItalic, a(blue, alpha), label);
  Item it;
  it.x = x; it.y = y; it.w = w; it.h = h; it.label = label; it.activate = std::move(act); it.disabled = disabled;
  items_.push_back(std::move(it));
  return foc;
}

void Menus::panel(float x, float y, float w, float h) {
  ui_.shadow(x, y, w, h, 6 * u_, 14 * u_, 0.28f);
  // brushClip-like ragged paper: a rect with jagged top / bottom strips
  ui_.rect(x, y + 6 * u_, w, h - 12 * u_, a(white, 0.96f));
  std::vector<vec2> topEdge, botEdge;
  const int NX = 14;
  unsigned s = unsigned(int(x) * 7 + int(w));
  auto rnd = [&]() { s = s * 1103515245u + 12345u; return float((s >> 8) & 0xffff) / 65535.f; };
  for (int i = 0; i < NX; i++) {
    float x0 = x + w * float(i) / NX, x1 = x + w * float(i + 1) / NX;
    float t0 = y + rnd() * 6 * u_, t1 = y + rnd() * 6 * u_;
    ui_.tri(vec2(x0, t0), vec2(x1, t1), vec2(x1, y + 6 * u_), a(white, 0.96f));
    ui_.tri(vec2(x0, t0), vec2(x1, y + 6 * u_), vec2(x0, y + 6 * u_), a(white, 0.96f));
    float b0 = y + h - rnd() * 6 * u_, b1 = y + h - rnd() * 6 * u_;
    ui_.tri(vec2(x0, y + h - 6 * u_), vec2(x1, y + h - 6 * u_), vec2(x1, b1), a(white, 0.96f));
    ui_.tri(vec2(x0, y + h - 6 * u_), vec2(x1, b1), vec2(x0, b0), a(white, 0.96f));
  }
}

// ---------------------------------------------------------------- the frame
void Menus::frame(const UiNav& nav, double dt, double now) {
  t_ = now;
  u_ = std::clamp(std::min(float(ui_.height()) / 800.f, float(ui_.width()) / 1280.f), 0.55f, 2.2f);
  if (screen_ == Screen::None) return;
  // the previous frame's items take this frame's input (immediate mode: drawn, then hit-tested next frame)
  if (screen_ == Screen::Controls && captureAction_ >= 0) controlsCapture(nav);
  else if (screen_ == Screen::Showcase && (nav.left || nav.right)) pickChar(chi_ + (nav.left ? -1 : 1));
  else if (screen_ == Screen::Controls && (nav.left || nav.right) && focus_ < int(items_.size()) && items_[size_t(focus_)].label.rfind("bind:", 0) == 0) ctlCol_ = nav.left ? 0 : 1;
  else if (screen_ == Screen::Dialog && (nav.tabPrev || nav.tabNext) && !dialog_.tabs.empty()) {
    int n = int(dialog_.tabs.size());
    dialog_.tab = ((dialog_.tab + (nav.tabNext ? 1 : -1)) % n + n) % n;
    if (dialog_.rebuild) dialog_.rebuild(dialog_);
    focus_ = 0; scroll_ = scrollTarget_ = 0;
  } else if (screen_ == Screen::Pause && nav.menu) { if (hooks.resume) hooks.resume(); }
  else if (screen_ == Screen::Multiplayer) {
    // the name field takes the typed letters (W A S D, Space and Backspace are text there, not navigation)
    UiNav n2 = nav;
    bool field = focus_ == 0 && mp.account && mp.account().empty();
    if (field) {
      bool shift = plat_.keyDown(platform::Key::ShiftLeft) || plat_.keyDown(platform::Key::ShiftRight);
      for (platform::Key k : nav.keys) {
        int ki = int(k);
        char c = 0;
        if (ki >= int(platform::Key::KeyA) && ki <= int(platform::Key::KeyZ)) c = char((shift ? 'A' : 'a') + (ki - int(platform::Key::KeyA)));
        else if (ki >= int(platform::Key::Digit0) && ki <= int(platform::Key::Digit9)) c = char('0' + (ki - int(platform::Key::Digit0)));
        else if (k == platform::Key::Space) c = ' ';
        if (c) { if (nameField_.size() < 16) nameField_ += c; n2.up = n2.down = n2.left = n2.right = n2.confirm = false; n2.tabPrev = n2.tabNext = false; }
        if (k == platform::Key::Backspace) { if (!nameField_.empty()) nameField_.pop_back(); n2.cancel = false; }
      }
    }
    handle(n2);
  } else handle(nav);
  if (screen_ == Screen::None) return;
  scroll_ += (scrollTarget_ - scroll_) * float(1 - std::exp(-dt * 14));
  items_.clear();
  listH_ = 0;
  switch (screen_) {
    case Screen::Main: scrMain(); break;
    case Screen::PlayMode: scrPlayMode(); break;
    case Screen::Showcase: scrShowcase(nav, dt); break;
    case Screen::Pause: scrPause(); break;
    case Screen::Stats: scrStats(); break;
    case Screen::Settings: scrSettings(); break;
    case Screen::Controls: scrControls(); break;
    case Screen::Dialog: scrDialog(); break;
    case Screen::Confirm: scrConfirm(); break;
    case Screen::Multiplayer: scrMultiplayer(nav); break;
    default: break;
  }
  if (!items_.empty()) focus_ = std::clamp(focus_, 0, int(items_.size()) - 1);
}

void Menus::scrMain() {
  drawShade(0);
  drawLogo(true);
  float x = 110 * u_, y = 300 * u_;
  if (!loading.empty()) {
    float r = 16 * u_, cx = x + r, cy = y + r;
    for (int i = 0; i < 8; i++) {
      float ang = float(t_ * 5) + float(i) * 0.785f;
      ui_.circle(cx + std::cos(ang) * r, cy + std::sin(ang) * r, 3.5f * u_, a(white, 0.25f + 0.09f * float(i)));
    }
    ui_.text(x + 2 * r + 16 * u_, cy - 10 * u_, 17 * u_, UiFont::Body, white, loading);
    return;
  }
  button(x, y, 430 * u_, 100 * u_, 54 * u_, "PLAY", 3, [this] { open(Screen::PlayMode); });
  y += 106 * u_;
  button(x, y, 360 * u_, 82 * u_, 40 * u_, "CONTROLS", 31, [this] { ctlBack_ = Screen::None; open(Screen::Controls); });
  y += 88 * u_;
  button(x, y, 360 * u_, 82 * u_, 40 * u_, "STATS", 7, [this] { open(Screen::Stats); });
  y += 88 * u_;
  button(x, y, 360 * u_, 82 * u_, 40 * u_, "SETTINGS", 11, [this] { open(Screen::Settings); });
  y += 98 * u_;
  button(x, y, 250 * u_, 62 * u_, 28 * u_, "QUIT", 13, [this] { if (hooks.quit) hooks.quit(); });
  drawHints({{"updown", "Select"}, {"enter", "Confirm"}});
}

void Menus::scrPlayMode() {
  drawShade(0);
  drawLogo(true);
  float x = 110 * u_, y = 300 * u_;
  auto single = [this] {
    if (save_.characterChosen) { if (hooks.start) hooks.start(); }
    else open(Screen::Showcase);
  };
  button(x, y, 430 * u_, 100 * u_, 54 * u_, "SINGLEPLAYER", 41, single);
  y += 106 * u_;
  button(x, y, 430 * u_, 100 * u_, 54 * u_, "MULTIPLAYER", 43, [this] {
    if (!save_.characterChosen) save_.characterChosen = true;   // (the skier you play: SETTINGS -> Skier changes it)
    open(Screen::Multiplayer);
  });
  y += 116 * u_;
  button(x, y, 250 * u_, 62 * u_, 28 * u_, "BACK", 13, [this] { back(); });
  drawHints({{"updown", "Select"}, {"enter", "Confirm"}, {"esc", "Back"}});
}

// (Phase 6) MULTIPLAYER: the server, its worlds, your account; JOIN A WORLD logs in (the server picks the world: the
// fullest one with room, up to 50 players)
void Menus::scrMultiplayer(const UiNav& nav) {
  (void)nav;
  drawShade(2);
  drawLogo(false);
  float x = 110 * u_, y = 150 * u_;
  std::string acc = mp.account ? mp.account() : "";
  bool busy = mp.busy && mp.busy();
  heading(x, y, "MULTIPLAYER", "Ski with everyone in your world Â· up to 50 players a world Â· the server keeps your money, cars and chalet");
  float py = y + 150 * u_, pw = 560 * u_, ph = 196 * u_;
  panel(x, py, pw, ph);
  float fs = std::max(12.f, 15 * u_);
  ui_.text(x + 30 * u_, py + 18 * u_, std::max(11.f, 11 * u_), UiFont::Body, red, "SERVER");
  ui_.textFit(x + 30 * u_, py + 36 * u_, pw - 60 * u_, fs, UiFont::Body, blue, mp.server ? mp.server() : "");
  std::string h = mp.health ? mp.health() : "";
  ui_.textFit(x + 30 * u_, py + 60 * u_, pw - 60 * u_, fs, UiFont::Body, blueDim, h.empty() ? "Checking the worlds..." : h);
  ui_.text(x + 30 * u_, py + 92 * u_, std::max(11.f, 11 * u_), UiFont::Body, red, acc.empty() ? "PICK A NAME" : "YOUR NAME");
  if (acc.empty()) {
    if (!nameFieldInit_) { nameField_ = mp.suggested; nameFieldInit_ = true; }
    bool foc = focus_ == 0;
    float fx = x + 30 * u_, fy = py + 112 * u_, fw = pw - 60 * u_, fh = 46 * u_;
    ui_.roundRect(fx, fy, fw, fh, 6 * u_, a(blue, foc ? 0.12f : 0.06f));
    ui_.roundRectStroke(fx, fy, fw, fh, 6 * u_, 2, foc ? blue : a(blue, 0.4f));
    bool caret = foc && std::fmod(t_, 1.0) < 0.55;
    ui_.text(fx + 14 * u_, fy + (fh - ui_.lineHeight(26 * u_, UiFont::CondItalic)) / 2, 26 * u_, UiFont::CondItalic, blue, nameField_ + (caret ? "|" : ""));
    Item it;
    it.x = fx; it.y = fy; it.w = fw; it.h = fh; it.label = "name";
    it.activate = [this] { if (mp.registerName) mp.registerName(nameField_); };
    items_.push_back(it);
  } else ui_.text(x + 30 * u_, py + 112 * u_, 34 * u_, UiFont::CondItalic, blue, acc);
  std::string st = mp.status ? mp.status() : "";
  if (!st.empty()) ui_.textWrapped(x + 30 * u_, py + 164 * u_, pw - 60 * u_, std::max(11.f, 13 * u_), UiFont::Body, busy ? blueDim : ko, st);
  float by = py + ph + 26 * u_;
  if (acc.empty()) {
    button(x, by, 430 * u_, 90 * u_, 48 * u_, busy ? "REGISTERING..." : "REGISTER", 47, [this] { if (mp.registerName) mp.registerName(nameField_); }, busy);
    by += 96 * u_;
  } else {
    button(x, by, 430 * u_, 90 * u_, 48 * u_, busy ? "JOINING..." : "JOIN A WORLD", 47, [this] { if (mp.join) mp.join(); }, busy);
    by += 96 * u_;
    button(x, by, 360 * u_, 70 * u_, 34 * u_, "USE ANOTHER NAME", 29, [this] { if (mp.forget) mp.forget(); nameFieldInit_ = false; }, busy);
    by += 82 * u_;
  }
  button(x, by, 250 * u_, 62 * u_, 28 * u_, "BACK", 13, [this] { back(); });
  drawHints({{"updown", "Select"}, {"enter", acc.empty() ? "Register" : "Join"}, {"esc", "Back"}});
}

void Menus::pickChar(int i) {
  i = std::clamp(i, 0, 1);
  if (i == chi_) return;
  chi_ = i;
  save_.character = i == 0 ? "skier_red" : "skier_blue";
  if (hooks.character) hooks.character(save_.character);
}

void Menus::scrShowcase(const UiNav& nav, double dt) {
  drawShade(2);
  drawLogo(false);
  float x = 110 * u_, y = 150 * u_;
  heading(x, y, "CHOOSE YOUR SKIER", inGame ? "Change your skier" : "Free ride \xC2\xB7 the open resort");
  // drag across the free area (or the right stick) turns the skier
  if (nav.mouseDown && nav.mouse.x > float(ui_.width()) * 0.45f) {
    if (dragLast_.x >= 0 && hooks.spin) hooks.spin((nav.mouse.x - dragLast_.x) * 0.012f);
    dragLast_ = nav.mouse;
  } else dragLast_ = vec2(-1);
  if (std::fabs(nav.stickR.x) > 0.2f && hooks.spin) hooks.spin(nav.stickR.x * float(dt) * 3.f);
  float py = y + 150 * u_, pw = 470 * u_, ph = 150 * u_;
  panel(x, py, pw, ph);
  // MAN / WOMAN (seg-brush)
  const char* labels[2] = {"MAN", "WOMAN"};
  float bx = x + 30 * u_, bw = 190 * u_, bh = 54 * u_;
  for (int i = 0; i < 2; i++) {
    float xx = bx + float(i) * (bw + 20 * u_);
    bool on = i == chi_;
    ui_.brushStroke(xx, py + 22 * u_, bw, bh, on ? blue : a(blue, 0.12f), 140 + i);
    ui_.text(xx + 30 * u_, py + 22 * u_ + (bh - ui_.lineHeight(30 * u_, UiFont::CondItalic)) / 2, 30 * u_, UiFont::CondItalic, on ? white : blue, labels[i]);
    Item it;
    it.x = xx; it.y = py + 22 * u_; it.w = bw; it.h = bh; it.label = labels[i];
    it.activate = [this, i] { pickChar(i); };
    it.adjust = [this](int d) { pickChar(chi_ + d); };
    items_.push_back(it);
  }
  ui_.textWrapped(x + 30 * u_, py + 92 * u_, pw - 60 * u_, std::max(12.f, 14 * u_), UiFont::Body, blueDim,
                  "Customize your look in the ski shop: jackets, trousers, helmets and goggles.");
  float sy = float(ui_.height()) - 190 * u_;
  button(x, sy, 430 * u_, 100 * u_, 54 * u_, "START", 17, [this] {
    save_.characterChosen = true;
    save_.markDirty();
    if (inGame) { open(Screen::Settings, -1); return; }
    if (hooks.start) hooks.start();
  });
  if (t_ - enterT_ < 0.05) focus_ = 2;   // (START is focused by default: Enter starts)
  drawHints({{"leftright", "Man / woman"}, {"enter", "Start"}, {"esc", "Back"}, {"", "Drag to rotate"}});
}

void Menus::scrPause() {
  drawShade(0);
  drawLogo(false);
  float x = 110 * u_, y = 170 * u_, h = 70 * u_, step = 76 * u_;
  button(x, y, 430 * u_, 88 * u_, 46 * u_, "RESUME", 5, [this] { if (hooks.resume) hooks.resume(); });
  y += 94 * u_;
  button(x, y, 360 * u_, h, 36 * u_, "CONTROLS", 31, [this] { ctlBack_ = Screen::None; open(Screen::Controls); }); y += step;
  button(x, y, 360 * u_, h, 36 * u_, "STATS", 7, [this] { open(Screen::Stats); }); y += step;
  button(x, y, 360 * u_, h, 36 * u_, "SETTINGS", 11, [this] { open(Screen::Settings); }); y += step;
  bool online = mp.online && mp.online();
  if (online) { button(x, y, 500 * u_, h, 36 * u_, "LEAVE MULTIPLAYER", 23, [this] { if (mp.leave) mp.leave(); }); y += step; }
  else { button(x, y, 360 * u_, h, 36 * u_, "MAIN MENU", 23, [this] { if (hooks.mainMenu) hooks.mainMenu(); }); y += step; }
  button(x, y, 500 * u_, h, 36 * u_, "RETURN TO VILLAGE", 19, [this] { if (hooks.village) hooks.village(); }); y += step + 8 * u_;
  button(x, y, 250 * u_, 62 * u_, 28 * u_, "QUIT GAME", 13, [this] { if (hooks.quit) hooks.quit(); });
  if (online && mp.players) {   // (the world's players: session.js status pill, as a list)
    std::vector<std::string> names = mp.players();
    float px = float(ui_.width()) - 420 * u_, py = 170 * u_, pw = 330 * u_, rh = 30 * u_;
    float ph = 60 * u_ + rh * float(std::min<size_t>(names.size(), 16));
    panel(px, py, pw, ph);
    ui_.text(px + 24 * u_, py + 16 * u_, std::max(11.f, 12 * u_), UiFont::Body, red, names.empty() ? "ONLINE" : upper(names[0]));
    for (size_t i = 1; i < names.size() && i < 17; i++)
      ui_.textFit(px + 24 * u_, py + 22 * u_ + rh * float(i), pw - 48 * u_, std::max(13.f, 18 * u_), UiFont::CondItalic, blue, names[i]);
  }
  drawHints({{"updown", "Select"}, {"enter", "Confirm"}, {"esc", "Resume"}});
}

void Menus::scrStats() {
  drawShade(0);
  drawLogo(false);
  float x = 110 * u_, y = 110 * u_;
  heading(x, y, "STATS", "Your career on the mountain");
  const auto& st = save_.stats;
  const SkiDef* ski = skiById(save_.skis);
  char b[64];
  std::vector<std::pair<std::string, std::string>> rows;
  rows.push_back({"Money", "$" + fmtMoney(save_.money)});
  rows.push_back({"Races won", std::to_string(st.wins) + " / " + std::to_string(st.races)});
  std::snprintf(b, sizeof b, "%.0f km/h", st.topSpeed * 3.6); rows.push_back({"Top speed", b});
  std::snprintf(b, sizeof b, "%.0f m", st.longestJump); rows.push_back({"Longest jump", st.longestJump >= 1 ? b : "\xE2\x80\x94"});
  std::snprintf(b, sizeof b, "%.1f s", st.bestAir); rows.push_back({"Biggest air", st.bestAir >= 0.1 ? b : "\xE2\x80\x94"});
  std::snprintf(b, sizeof b, "%.1f km", st.distance / 1000); rows.push_back({"Distance skied", b});
  rows.push_back({"Prize money", "$" + fmtMoney(int64_t(st.earned))});
  rows.push_back({"Skis", ski ? ski->name : "None yet"});
  rows.push_back({"Cars", std::to_string(save_.garage.size())});
  rows.push_back({"Day", std::to_string(save_.day)});
  float py = y + 150 * u_, pw = 470 * u_, rh = 44 * u_, ph = 50 * u_ + rh * float(rows.size());
  panel(x, py, pw, ph);
  ui_.text(x + 30 * u_, py + 18 * u_, std::max(11.f, 11 * u_), UiFont::Body, red, "CAREER");
  float ry = py + 40 * u_;
  for (const auto& [k, v] : rows) {
    ui_.text(x + 30 * u_, ry + (rh - ui_.lineHeight(15 * u_, UiFont::Body)) / 2, 15 * u_, UiFont::Body, blue, k);
    ui_.text(x + pw - 30 * u_, ry + (rh - ui_.lineHeight(26 * u_, UiFont::CondItalic)) / 2, 26 * u_, UiFont::CondItalic, blue, v, UiAlign::Right);
    ui_.rect(x + 30 * u_, ry + rh - 1, pw - 60 * u_, 1, a(blue, 0.12f));
    ry += rh;
  }
  float qx = x + pw + 30 * u_;
  if (qx + pw < float(ui_.width())) {
    panel(qx, py, pw, 160 * u_);
    ui_.text(qx + 30 * u_, py + 18 * u_, std::max(11.f, 11 * u_), UiFont::Body, red, "COURSE RECORDS");
    ui_.textWrapped(qx + 30 * u_, py + 48 * u_, pw - 60 * u_, 15 * u_, UiFont::Body, blueDim, "No times yet: the World Racing courses and the resort races come with Phase 5.");
  }
  drawHints({{"esc", "Back"}});
}

// ---------------------------------------------------------------- SETTINGS
void Menus::scrSettings() {
  drawShade(0);
  float x = 110 * u_, y = 50 * u_;
  heading(x, y, "SETTINGS", "Performance runs smoothest on laptops, Super Performance on handhelds \xC2\xB7 the graphics preset applies the next time the game starts");
  float py = y + 160 * u_, pw = std::min(700 * u_, float(ui_.width()) - x - 40 * u_), ph = float(ui_.height()) - py - 80 * u_;
  panel(x, py, pw, ph);
  listTop_ = py + 14 * u_; listH_ = ph - 28 * u_;
  ui_.pushClip(x, listTop_, pw, listH_);
  float rx = x + 30 * u_, rw = pw - 60 * u_, ry = listTop_ - scroll_, rowH = 52 * u_, fs = 15 * u_, sfs = std::max(12.f, 13 * u_);
  float segH = 30 * u_;
  auto rowBg = [&](float yy, bool foc) {
    if (foc) { ui_.rectGradient(rx - 14 * u_, yy, rw + 28 * u_, rowH, a(blue, 0.09f), a(blue, 0)); ui_.rect(rx - 14 * u_, yy, 4 * u_, rowH, red); }
    ui_.rect(rx, yy + rowH - 1, rw, 1, a(blue, 0.1f));
  };
  // a segmented control (right aligned); returns the button x positions
  auto seg = [&](float yy, const std::vector<std::string>& labels, int on, std::vector<float>& xs) {
    float total = 0;
    std::vector<float> ws;
    for (const auto& l : labels) { ws.push_back(ui_.textWidth(l, sfs, UiFont::Body) + 24 * u_); total += ws.back() + 6 * u_; }
    float bx = rx + rw - total + 6 * u_, by = yy + (rowH - segH) / 2;
    xs.clear();
    for (size_t i = 0; i < labels.size(); i++) {
      xs.push_back(bx);
      if (int(i) == on) ui_.roundRect(bx, by, ws[i], segH, 5 * u_, blue);
      else ui_.roundRectStroke(bx, by, ws[i], segH, 5 * u_, 2, blue);
      ui_.text(bx + ws[i] / 2, by + (segH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::Body, int(i) == on ? white : blue, labels[i], UiAlign::Center);
      bx += ws[i] + 6 * u_;
    }
    xs.push_back(bx);
  };
  auto applyKey = [this](const std::string& k) { save_.markDirty(); if (hooks.setting) hooks.setting(k); };
  for (const SetRow& r : setRows()) {
    if (!r.key) {
      ry += 14 * u_;
      ui_.text(rx, ry, std::max(11.f, 11 * u_), UiFont::Body, red, r.label);
      ui_.rect(rx, ry + 22 * u_, rw, 2, a(blue, 0.18f));
      ry += 30 * u_;
      continue;
    }
    std::string key = r.key;
    bool foc = int(items_.size()) == focus_;
    rowBg(ry, foc);
    ui_.text(rx, ry + (rowH - ui_.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::Body, blue, r.label);
    Item it;
    it.x = rx - 14 * u_; it.y = ry; it.w = rw + 28 * u_; it.h = rowH; it.label = key; it.inList = true;
    if (r.kind == 'q') {
      std::string q = save_.quality.empty() ? "balanced" : save_.quality;
      if (q == "low") q = "performance"; else if (q == "medium") q = "balanced";
      int qi = 2;
      for (int i = 0; i < 6; i++) if (q == QUALITY_ORDER[i]) qi = i;
      // (six presets: one selector with arrows instead of the web's wrapping row)
      std::string lbl = QUALITY_LABELS[qi];
      float lw = 190 * u_, bx = rx + rw - lw, by = ry + (rowH - segH) / 2;
      ui_.roundRect(bx, by, lw, segH, 5 * u_, blue);
      ui_.text(bx + 14 * u_, by + (segH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::Body, white, "\xE2\x86\x90");
      ui_.text(bx + lw - 14 * u_, by + (segH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::Body, white, "\xE2\x86\x92", UiAlign::Right);
      ui_.text(bx + lw / 2, by + (segH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::Body, white, lbl, UiAlign::Center);
      auto set = [this, qi, applyKey](int d) {
        int n = std::clamp(qi + d, 0, 5);
        if (n == qi) return;
        save_.quality = QUALITY_ORDER[n];
        applyKey("quality");
      };
      it.adjust = set;
      it.activate = [set] { set(1); };
      it.clickAt = [set, bx, lw](float mx) { set(mx < bx + lw / 2 ? -1 : 1); };
    } else if (r.kind == 'r') {
      double v = save_.setting(r.key, r.min);
      float tw = 230 * u_, tx = rx + rw - tw - 60 * u_, ty = ry + rowH / 2;
      float f = float((v - r.min) / (r.max - r.min));
      ui_.roundRect(tx, ty - 3 * u_, tw, 6 * u_, 3 * u_, a(blue, 0.2f));
      ui_.roundRect(tx, ty - 3 * u_, tw * f, 6 * u_, 3 * u_, blue);
      ui_.circle(tx + tw * f, ty, 8 * u_, blue);
      ui_.circle(tx + tw * f, ty, 4 * u_, white);
      char b[32];
      if (r.fmt[0] == 'p') std::snprintf(b, sizeof b, "%d%%", int(std::round(v * 100)));
      else if (r.fmt[0] == 'x') std::snprintf(b, sizeof b, "%.1fx", v);
      else std::snprintf(b, sizeof b, "%d\xC2\xB0", int(std::round(v)));
      ui_.text(rx + rw, ry + (rowH - ui_.lineHeight(22 * u_, UiFont::CondItalic)) / 2, 22 * u_, UiFont::CondItalic, blue, b, UiAlign::Right);
      double mn = r.min, mx = r.max, st = r.step;
      it.adjust = [this, key, v, mn, mx, st, applyKey](int d) {
        double n = std::clamp(std::round((v + d * st) / st) * st, mn, mx);
        save_.settings[key] = n; applyKey(key);
      };
      it.clickAt = [this, key, tx, tw, mn, mx, st, applyKey](float px) {
        if (px < tx - 10 * u_ || px > tx + tw + 10 * u_) return;
        double n = std::clamp(mn + std::round((mx - mn) * std::clamp((px - tx) / tw, 0.f, 1.f) / st) * st, mn, mx);
        save_.settings[key] = n; applyKey(key);
      };
    } else if (r.kind == 't' || r.kind == 'c' || r.kind == 'h' || r.kind == 'x') {
      std::vector<std::pair<nlohmann::json, std::string>> opts = r.kind == 't' || r.kind == 'x' ? std::vector<std::pair<nlohmann::json, std::string>>{{false, "Off"}, {true, "On"}} : r.opts;
      int on = 0;
      if (r.kind == 'h') {
        int cnt = 0;
        for (const char* k : HUD_KEYS) cnt += save_.settingOn(k) ? 1 : 0;
        on = cnt == 4 ? 0 : cnt > 0 ? 1 : 2;
      } else if (r.kind == 'x') on = save_.settingOn("speedFx") || save_.settingOn("vignette") ? 1 : 0;
      else {
        const nlohmann::json& cur = save_.settings.contains(key) ? save_.settings[key] : nlohmann::json();
        for (size_t i = 0; i < opts.size(); i++) {
          const auto& ov = opts[i].first;
          bool eq = ov.is_boolean() ? (cur.is_boolean() && cur.get<bool>() == ov.get<bool>()) || (cur.is_number() && (cur.get<double>() != 0) == ov.get<bool>())
                                    : ov.is_number() ? cur.is_number() && cur.get<double>() == ov.get<double>() : cur == ov;
          if (eq) on = int(i);
        }
      }
      std::vector<std::string> labels;
      for (auto& o : opts) labels.push_back(o.second);
      std::vector<float> xs;
      seg(ry, labels, on, xs);
      char kind = r.kind;
      auto pick = [this, key, opts, kind, applyKey](int i) {
        i = std::clamp(i, 0, int(opts.size()) - 1);
        if (kind == 'h') {
          static const bool modes[3][4] = {{true, true, true, true}, {true, true, false, false}, {false, false, false, false}};
          for (int k = 0; k < 4; k++) save_.settings[HUD_KEYS[k]] = modes[i][k];
        } else if (kind == 'x') { save_.settings["speedFx"] = i == 1; save_.settings["vignette"] = i == 1; }
        else save_.settings[key] = opts[size_t(i)].first;
        applyKey(key);
      };
      it.adjust = [pick, on](int d) { pick(on + d); };
      it.activate = [pick, on, opts] { pick((on + 1) % int(opts.size())); };
      it.clickAt = [pick, xs](float px) { for (size_t i = 0; i + 1 < xs.size(); i++) if (px >= xs[i] && px < xs[i + 1]) { pick(int(i)); return; } };
    } else if (r.kind == 'k') {
      std::vector<float> xs;
      seg(ry, {"Change controls"}, -1, xs);
      it.activate = [this] { ctlBack_ = Screen::Settings; open(Screen::Controls); };
    }
    items_.push_back(it);
    ry += rowH;
  }
  // PLAYER
  ry += 14 * u_;
  ui_.text(rx, ry, std::max(11.f, 11 * u_), UiFont::Body, red, "PLAYER");
  ui_.rect(rx, ry + 22 * u_, rw, 2, a(blue, 0.18f));
  ry += 30 * u_;
  auto actionRow = [&](const std::string& label, const std::string& btn, bool danger, std::function<void()> act, const std::string& id) {
    bool foc = int(items_.size()) == focus_;
    rowBg(ry, foc);
    ui_.text(rx, ry + (rowH - ui_.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::Body, blue, label);
    float bw = ui_.textWidth(btn, sfs, UiFont::Body) + 24 * u_, bx = rx + rw - bw, by = ry + (rowH - segH) / 2;
    ui_.roundRectStroke(bx, by, bw, segH, 5 * u_, 2, danger ? ko : blue);
    ui_.text(bx + bw / 2, by + (segH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::Body, danger ? ko : blue, btn, UiAlign::Center);
    Item it;
    it.x = rx - 14 * u_; it.y = ry; it.w = rw + 28 * u_; it.h = rowH; it.label = id; it.activate = std::move(act); it.inList = true;
    items_.push_back(it);
    ry += rowH;
  };
  actionRow("Skier", "Change skier", false, [this] { open(Screen::Showcase); }, "skier");
  {
    std::string acc = mp.account ? mp.account() : "";
    actionRow("Account", acc.empty() ? "Signed in as " + plat_.userName() : "Multiplayer: " + acc, false, [this, acc] {
      if (hooks.flash) hooks.flash(acc.empty() ? "This save is on this device Â· PLAY -> MULTIPLAYER registers a name on the server" : "Your multiplayer name on this device: " + acc, 0);
    }, "account");
  }
  actionRow("Progress", "Reset all progress", true, [this] {
    confirmText_ = "Reset all progress? Money, skis, cars and stats start over.";
    confirmYes_ = [this] { if (hooks.resetProgress) hooks.resetProgress(); open(Screen::Settings, -1); };
    confirmBack_ = Screen::Settings;
    open(Screen::Confirm);
  }, "reset");
  ui_.popClip();
  contentH_ = ry + scroll_ - listTop_ + 10 * u_;
  // keep the focused row in view
  if (focus_ >= 0 && focus_ < int(items_.size())) {
    const Item& f = items_[size_t(focus_)];
    float top = f.y + scroll_ - listTop_;
    if (top < scrollTarget_) scrollTarget_ = std::max(0.f, top - 40 * u_);
    else if (top + f.h > scrollTarget_ + listH_) scrollTarget_ = std::min(std::max(0.f, contentH_ - listH_), top + f.h - listH_ + 20 * u_);
  }
  drawHints({{"updown", "Select"}, {"leftright", "Adjust"}, {"enter", "Apply"}, {"esc", "Back"}});
}

// ---------------------------------------------------------------- CONTROLS
void Menus::storeBinds() {
  save_.binds = input_.bindingsJson();
  save_.markDirty();
  if (hooks.bindingsChanged) hooks.bindingsChanged();
}

void Menus::controlsCapture(const UiNav& nav) {
  Action a = Action(captureAction_);
  if (captureCol_ == 0) {
    for (Key k : nav.keys) {
      if (k == Key::Escape) { captureAction_ = -1; ctlStatus_ = "Cancelled"; ctlStatusBad_ = false; return; }
      Key old = input_.kb[size_t(a)];
      for (size_t i = 0; i < kActionCount; i++) if (int(i) != captureAction_ && input_.kb[i] == k) input_.kb[i] = old;   // (a key taken: swapped)
      input_.kb[size_t(a)] = k;
      ctlStatus_ = std::string(actionInfo(a).label) + ": " + prompts::keyLabel(k);
      ctlStatusBad_ = false;
      captureAction_ = -1;
      storeBinds();
      return;
    }
  } else {
    if (!nav.keys.empty() && nav.keys[0] == Key::Escape) { captureAction_ = -1; ctlStatus_ = "Cancelled"; return; }
    if (nav.padButton >= 0 && t_ - captureT_ > 0.2) {
      int b = nav.padButton;
      if (b == 16) { ctlStatus_ = "The Home / guide button belongs to the system"; ctlStatusBad_ = true; return; }
      input_.pad[size_t(a)] = b;
      ctlStatus_ = std::string(actionInfo(a).label) + ": " + prompts::padGlyph(b, ctlFamily_);
      ctlStatusBad_ = false;
      captureAction_ = -1;
      storeBinds();
      return;
    }
  }
  if (t_ - captureT_ > 8) { captureAction_ = -1; ctlStatus_ = "Timed out"; ctlStatusBad_ = true; }
}

void Menus::scrControls() {
  drawShade(1);
  float x = 70 * u_, y = 30 * u_;
  heading(x, y, "CONTROLS", "Keyboard, mouse and controller \xC2\xB7 Xbox, PlayStation and Switch \xC2\xB7 select a key or button to change it");
  if (!ctlFamilyPicked_) ctlFamily_ = input_.padConnected() ? input_.padFamily() : ctlFamily_;
  float py = y + 150 * u_, ph = float(ui_.height()) - py - 80 * u_;
  float pw = std::min(700 * u_, float(ui_.width()) * 0.56f), refW = float(ui_.width()) - x - pw - 60 * u_;
  panel(x, py, pw, ph);
  listTop_ = py + 14 * u_; listH_ = ph - 50 * u_;
  ui_.pushClip(x, listTop_, pw, listH_);
  float rx = x + 26 * u_, rw = pw - 52 * u_, ry = listTop_ - scroll_, rowH = 40 * u_, fs = std::max(12.f, 13.5f * u_), sfs = std::max(11.f, 12.5f * u_);
  float colKb = rx + rw * 0.56f, colPad = rx + rw * 0.79f, cellW = rw * 0.2f, cellH = 28 * u_;
  // the controller family (the connected one, or pick one to preview)
  {
    bool foc = int(items_.size()) == focus_;
    if (foc) { ui_.rectGradient(rx - 12 * u_, ry, rw + 24 * u_, rowH + 10 * u_, a(blue, 0.09f), a(blue, 0)); ui_.rect(rx - 12 * u_, ry, 4 * u_, rowH + 10 * u_, red); }
    ui_.text(rx, ry + 6 * u_, fs, UiFont::Body, blue, "Controller");
    ui_.text(rx, ry + 6 * u_ + fs * 1.25f, sfs * 0.9f, UiFont::Body, blueDim, input_.padConnected() ? "Connected" : "None connected \xC2\xB7 preview");
    const char* fams[3] = {"Xbox", "PlayStation", "Switch"};
    float bx = rx + rw, segH = 28 * u_;
    std::vector<float> xs(4);
    float ws[3];
    for (int i = 2; i >= 0; i--) { ws[i] = ui_.textWidth(fams[i], sfs, UiFont::Body) + 20 * u_; bx -= ws[i] + 6 * u_; xs[size_t(i)] = bx; }
    xs[3] = rx + rw;
    for (int i = 0; i < 3; i++) {
      bool on = int(ctlFamily_) == i;
      if (on) ui_.roundRect(xs[size_t(i)], ry + 8 * u_, ws[i], segH, 5 * u_, blue); else ui_.roundRectStroke(xs[size_t(i)], ry + 8 * u_, ws[i], segH, 5 * u_, 2, blue);
      ui_.text(xs[size_t(i)] + ws[i] / 2, ry + 8 * u_ + (segH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::Body, on ? white : blue, fams[i], UiAlign::Center);
    }
    Item it;
    it.x = rx - 12 * u_; it.y = ry; it.w = rw + 24 * u_; it.h = rowH + 10 * u_; it.label = "family"; it.inList = true;
    auto pickF = [this](int i) { ctlFamily_ = PadFamily(std::clamp(i, 0, 2)); ctlFamilyPicked_ = true; };
    it.adjust = [this, pickF](int d) { pickF(int(ctlFamily_) + d); };
    it.activate = [this, pickF] { pickF((int(ctlFamily_) + 1) % 3); };
    it.clickAt = [pickF, xs](float px) { for (int i = 0; i < 3; i++) if (px >= xs[size_t(i)] && px < xs[size_t(i) + 1]) pickF(i); };
    items_.push_back(it);
    ry += rowH + 16 * u_;
  }
  ui_.text(rx, ry, std::max(10.f, 10.5f * u_), UiFont::Body, red, "ACTION");
  ui_.text(colKb, ry, std::max(10.f, 10.5f * u_), UiFont::Body, red, "KEYBOARD");
  ui_.text(colPad, ry, std::max(10.f, 10.5f * u_), UiFont::Body, red, "CONTROLLER");
  ry += 22 * u_;
  std::string lastG;
  for (size_t i = 0; i < kActionCount; i++) {
    const ActionInfo& ai = actionInfo(Action(i));
    if (lastG != ai.group) {
      lastG = ai.group;
      ry += 8 * u_;
      ui_.text(rx, ry, std::max(10.f, 11 * u_), UiFont::Body, red, lastG == "MENUS" ? "MENUS & SCREENS" : lastG);
      ui_.rect(rx, ry + 20 * u_, rw, 2, a(blue, 0.18f));
      ry += 26 * u_;
    }
    bool foc = int(items_.size()) == focus_;
    if (foc) { ui_.rectGradient(rx - 12 * u_, ry, rw + 24 * u_, rowH, a(blue, 0.09f), a(blue, 0)); ui_.rect(rx - 12 * u_, ry, 4 * u_, rowH, red); }
    ui_.textFit(rx, ry + (rowH - ui_.lineHeight(fs, UiFont::Body)) / 2, colKb - rx - 10 * u_, fs, UiFont::Body, blue, ai.label);
    bool stick = i <= size_t(Action::Right);
    bool capKb = captureAction_ == int(i) && captureCol_ == 0, capPad = captureAction_ == int(i) && captureCol_ == 1;
    std::string kb = ai.padOnly ? "\xE2\x80\x94" : capKb ? "Press a key" : prompts::keyLabel(input_.kb[i]);
    std::string pd = stick ? "Left stick" : capPad ? "Press a button" : input_.pad[i] < 0 ? "\xE2\x80\x94" : prompts::padGlyph(input_.pad[i], ctlFamily_);
    for (int c = 0; c < 2; c++) {
      float cx = c == 0 ? colKb : colPad;
      bool fixed = c == 0 ? ai.padOnly : stick;
      bool sel = foc && ctlCol_ == c && !fixed;
      bool cap = c == 0 ? capKb : capPad;
      float by = ry + (rowH - cellH) / 2;
      if (cap) ui_.roundRect(cx, by, cellW, cellH, 5 * u_, a(red, 0.9f));
      else if (sel) ui_.roundRect(cx, by, cellW, cellH, 5 * u_, blue);
      else if (!fixed) ui_.roundRectStroke(cx, by, cellW, cellH, 5 * u_, 2, a(blue, 0.6f));
      const std::string& lbl = c == 0 ? kb : pd;
      vec4 col = cap || sel ? white : fixed ? a(blue, 0.45f) : blue;
      bool shape = !cap && c == 1 && ctlFamily_ == PadFamily::PlayStation && input_.pad[i] >= 0 && input_.pad[i] <= 3 && !stick;
      if (shape) ui_.keycap(cx + cellW / 2 - cellH * 0.45f, by + cellH * 0.08f, cellH * 0.84f, lbl, sel);
      else ui_.textFit(cx + cellW / 2, by + (cellH - ui_.lineHeight(sfs, UiFont::Body)) / 2, cellW - 8 * u_, sfs, UiFont::Body, col, lbl, UiAlign::Center);
    }
    Item it;
    it.x = rx - 12 * u_; it.y = ry; it.w = rw + 24 * u_; it.h = rowH; it.label = std::string("bind:") + ai.id; it.inList = true;
    bool padOnly = ai.padOnly;
    it.activate = [this, i, padOnly, stick] {
      if ((ctlCol_ == 0 && padOnly) || (ctlCol_ == 1 && stick)) { ctlStatus_ = ctlCol_ == 1 ? "The left stick always moves" : "Controller only"; ctlStatusBad_ = true; return; }
      captureAction_ = int(i); captureCol_ = ctlCol_; captureT_ = t_;
      ctlStatus_ = ctlCol_ == 0 ? std::string("Press a key for ") + actionInfo(Action(i)).label + " \xC2\xB7 ESC cancels"
                                : std::string("Press a controller button for ") + actionInfo(Action(i)).label;
      ctlStatusBad_ = false;
    };
    float ckb = colKb, cpad = colPad, cw = cellW;
    it.clickAt = [this, ckb, cpad, cw, i, padOnly, stick](float px) {
      if (px >= ckb && px <= ckb + cw) ctlCol_ = 0;
      else if (px >= cpad && px <= cpad + cw) ctlCol_ = 1;
      else return;
      if ((ctlCol_ == 0 && padOnly) || (ctlCol_ == 1 && stick)) return;
      captureAction_ = int(i); captureCol_ = ctlCol_; captureT_ = t_;
      ctlStatus_ = ctlCol_ == 0 ? "Press a key \xC2\xB7 ESC cancels" : "Press a controller button";
    };
    items_.push_back(it);
    ry += rowH;
  }
  // defaults
  {
    ry += 10 * u_;
    bool foc = int(items_.size()) == focus_;
    if (foc) { ui_.rectGradient(rx - 12 * u_, ry, rw + 24 * u_, rowH, a(blue, 0.09f), a(blue, 0)); ui_.rect(rx - 12 * u_, ry, 4 * u_, rowH, red); }
    ui_.text(rx, ry + (rowH - ui_.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::Body, blue, "Defaults");
    const char* lb[2] = {"Reset keyboard", "Reset controller"};
    float bw[2] = {ui_.textWidth(lb[0], sfs, UiFont::Body) + 20 * u_, ui_.textWidth(lb[1], sfs, UiFont::Body) + 20 * u_};
    float bx1 = rx + rw - bw[1], bx0 = bx1 - 6 * u_ - bw[0];
    for (int c = 0; c < 2; c++) {
      float bx = c == 0 ? bx0 : bx1;
      bool sel = foc && ctlCol_ == c;
      if (sel) ui_.roundRect(bx, ry + 6 * u_, bw[c], cellH, 5 * u_, blue); else ui_.roundRectStroke(bx, ry + 6 * u_, bw[c], cellH, 5 * u_, 2, blue);
      ui_.text(bx + bw[c] / 2, ry + 6 * u_ + (cellH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::Body, sel ? white : blue, lb[c], UiAlign::Center);
    }
    auto reset = [this](int c) {
      for (size_t i = 0; i < kActionCount; i++) { if (c == 0) input_.kb[i] = Input::defaultKey(Action(i)); else input_.pad[i] = Input::defaultPad(Action(i)); }
      ctlStatus_ = c == 0 ? "Keyboard reset to the defaults" : "Controller reset to the defaults";
      ctlStatusBad_ = false;
      storeBinds();
    };
    Item it;
    it.x = rx - 12 * u_; it.y = ry; it.w = rw + 24 * u_; it.h = rowH; it.label = "resets"; it.inList = true;
    it.adjust = [this](int d) { ctlCol_ = d < 0 ? 0 : 1; };
    it.activate = [this, reset] { reset(ctlCol_); };
    it.clickAt = [this, reset, bx0, bx1](float px) { if (px >= bx1) { ctlCol_ = 1; reset(1); } else if (px >= bx0) { ctlCol_ = 0; reset(0); } };
    items_.push_back(it);
    ry += rowH;
  }
  ui_.popClip();
  contentH_ = ry + scroll_ - listTop_ + 10 * u_;
  if (focus_ >= 0 && focus_ < int(items_.size())) {
    const Item& f = items_[size_t(focus_)];
    float top = f.y + scroll_ - listTop_;
    if (top < scrollTarget_) scrollTarget_ = std::max(0.f, top - 50 * u_);
    else if (top + f.h > scrollTarget_ + listH_) scrollTarget_ = std::min(std::max(0.f, contentH_ - listH_), top + f.h - listH_ + 20 * u_);
  }
  if (!ctlStatus_.empty()) ui_.text(rx, py + ph - 30 * u_, sfs, UiFont::Body, ctlStatusBad_ ? ko : blue, ctlStatus_);
  // the reference (what each control does), when there is room
  if (refW > 300 * u_) {
    float qx = x + pw + 30 * u_;
    panel(qx, py, refW, ph);
    float qy = py + 22 * u_, qx0 = qx + 24 * u_, qw = refW - 48 * u_;
    ui_.text(qx0, qy, std::max(10.f, 10.5f * u_), UiFont::Body, red, "KEYBOARD");
    ui_.text(qx0 + qw * 0.3f, qy, std::max(10.f, 10.5f * u_), UiFont::Body, red, prompts::familyName(ctlFamily_));
    qy += 24 * u_;
    struct Ref { const char* group; Action a; const char* what; };
    static const Ref refs[] = {
      {"ON THE SNOW", Action::Left, "Steer left / right"}, {nullptr, Action::Forward, "Pole on, tuck for speed"}, {nullptr, Action::Back, "Brake (snowplow, hockey stop)"},
      {nullptr, Action::Jump, "Hold to crouch, release to jump"},
      {"DRIVING", Action::Forward, "Accelerate"}, {nullptr, Action::Back, "Brake, then reverse"}, {nullptr, Action::Jump, "Handbrake"}, {nullptr, Action::Horn, "Horn"},
      {nullptr, Action::LookBack, "Look back"}, {nullptr, Action::View, "Chase / cockpit camera"}, {nullptr, Action::Unstuck, "Unstuck the car"}, {nullptr, Action::Furnish, "Flip the car back"},
      {"GENERAL", Action::Interact, "Interact"}, {nullptr, Action::View, "First / third person"}, {nullptr, Action::Skis, "Skis on / off"}, {nullptr, Action::Map, "Trail map"},
      {nullptr, Action::Pause, "Pause menu"},
    };
    float kh = std::max(15.f, 19 * u_);
    ui_.pushClip(qx, py + 10 * u_, refW, ph - 20 * u_);
    for (const Ref& r : refs) {
      if (r.group) { qy += 6 * u_; ui_.text(qx0, qy, std::max(10.f, 10.5f * u_), UiFont::Body, red, r.group); qy += 20 * u_; }
      std::string k = prompts::bindLabel(input_, r.a, false, ctlFamily_), p = prompts::bindLabel(input_, r.a, true, ctlFamily_);
      if (r.a == Action::Left) { k = prompts::keyLabel(input_.kb[size_t(Action::Left)]) + " " + prompts::keyLabel(input_.kb[size_t(Action::Right)]); p = "L STICK"; }
      ui_.keycap(qx0, qy, kh, k);
      ui_.keycap(qx0 + qw * 0.3f, qy, kh, p);
      ui_.textFit(qx0 + qw * 0.58f, qy + (kh - ui_.lineHeight(sfs, UiFont::Body)) / 2, qw * 0.42f, sfs, UiFont::Body, blue, r.what);
      qy += kh + 7 * u_;
    }
    ui_.popClip();
  }
  drawHints({{"updown", "Select"}, {"leftright", "Keyboard / controller"}, {"enter", "Change"}, {"esc", "Back"}});
}

// ---------------------------------------------------------------- the card dialog
void Menus::scrDialog() {
  drawShade(0);
  float x = 110 * u_, y = 70 * u_, cw = std::min(640 * u_, float(ui_.width()) - x - 40 * u_);
  if (!dialog_.kicker.empty()) { ui_.text(x + 6 * u_, y - 26 * u_, std::max(11.f, 12 * u_), UiFont::Body, a(white, 0.85f), upper(dialog_.kicker)); }
  // the title as a white brush strip (hud.js .card h2)
  float th = 62 * u_, tw = ui_.textWidth(dialog_.title, 36 * u_, UiFont::CondItalic) + 72 * u_;
  ui_.shadow(x, y, tw, th, 4 * u_, 10 * u_, 0.25f);
  ui_.brushPanel(x, y, tw, th, white, 0);
  ui_.text(x + 26 * u_, y + (th - ui_.lineHeight(36 * u_, UiFont::CondItalic)) / 2, 36 * u_, UiFont::CondItalic, blue, dialog_.title);
  y += th + 14 * u_;
  if (!dialog_.say.empty()) y += ui_.textWrapped(x + 4 * u_, y, cw, std::max(13.f, 16 * u_), UiFont::Body, white, dialog_.say) + 10 * u_;
  // tabs
  if (!dialog_.tabs.empty()) {
    float bx = x, segH = 32 * u_, sfs = std::max(12.f, 14 * u_);
    for (size_t i = 0; i < dialog_.tabs.size(); i++) {
      float bw = ui_.textWidth(dialog_.tabs[i], sfs, UiFont::CondBold) + 26 * u_;
      bool on = int(i) == dialog_.tab;
      ui_.roundRect(bx, y, bw, segH, 5 * u_, on ? white : a(white, 0.18f));
      ui_.text(bx + bw / 2, y + (segH - ui_.lineHeight(sfs, UiFont::CondBold)) / 2, sfs, UiFont::CondBold, on ? blue : white, dialog_.tabs[i], UiAlign::Center);
      bx += bw + 6 * u_;
    }
    std::string tcap = input_.usingGamepad() ? std::string(prompts::padGlyph(4, input_.padFamily())) + " " + prompts::padGlyph(5, input_.padFamily()) : "Q E";
    ui_.keycap(bx + 8 * u_, y + 5 * u_, segH - 10 * u_, tcap);
    y += segH + 12 * u_;
  }
  std::vector<size_t> main, second;
  for (size_t i = 0; i < dialog_.options.size(); i++) (dialog_.options[i].secondary ? second : main).push_back(i);
  float cardH = 66 * u_, gap = 8 * u_;
  float bottom = float(ui_.height()) - 80 * u_ - (second.empty() ? 0 : 74 * u_);
  listTop_ = y; listH_ = std::max(cardH, bottom - y);
  contentH_ = float(main.size()) * (cardH + gap);
  ui_.pushClip(0, listTop_ - 2, float(ui_.width()), listH_ + 4);
  float cy = y - scroll_;
  auto choose = [this](size_t oi) {
    DialogOption o = dialog_.options[oi];
    if (o.disabled) return;
    bool keep = dialog_.keepOpen && !o.secondary;
    if (!keep) close();
    if (o.act) o.act();
    if (keep && screen_ == Screen::Dialog && dialog_.rebuild) dialog_.rebuild(dialog_);
  };
  for (size_t k : main) {
    const DialogOption& o = dialog_.options[k];
    bool foc = int(items_.size()) == focus_;
    float ox = foc ? 10 * u_ : 0;
    float alpha = o.disabled ? 0.55f : 1.f;
    if (cy + cardH < listTop_ - 2 || cy > listTop_ + listH_ + 2) { cy += cardH + gap; Item skip; skip.x = x; skip.y = cy - cardH - gap; skip.w = cw; skip.h = cardH; skip.label = o.label; skip.inList = true;
      skip.activate = [choose, k] { choose(k); }; items_.push_back(skip); continue; }
    bool inside = cy >= listTop_ - 1 && cy + cardH <= listTop_ + listH_ + 1;
    if (inside) { ui_.shadow(x + ox, cy, cw, cardH, 4 * u_, 8 * u_, 0.2f); ui_.brushPanel(x + ox, cy, cw, cardH, foc ? white : ice, int(k % 2)); }
    else ui_.roundRect(x + ox, cy + 3 * u_, cw, cardH - 6 * u_, 3 * u_, foc ? white : ice);   // (half scrolled out: clipped)
    if (foc) ui_.rect(x - 12 * u_, cy + cardH * 0.25f, 5 * u_, cardH * 0.5f, red);
    float tx = x + ox + 22 * u_;
    if (o.swatch) {
      ui_.roundRect(tx, cy + cardH / 2 - 18 * u_, 36 * u_, 36 * u_, 6 * u_, hex(o.swatch, alpha));
      if (o.swatch2 && o.swatch2 != o.swatch) ui_.tri(vec2(tx + 36 * u_, cy + cardH / 2 - 18 * u_), vec2(tx + 36 * u_, cy + cardH / 2 + 18 * u_), vec2(tx, cy + cardH / 2 + 18 * u_), hex(o.swatch2, alpha));
      tx += 50 * u_;
    }
    float chipW = 0;
    std::string chip = o.state.empty() ? (o.price > 0 ? "$" + fmtMoney(o.price) : o.price == 0 ? "FREE" : "") : upper(o.state);
    if (!chip.empty()) {
      float cfs = o.state.empty() && o.price > 0 ? 26 * u_ : std::max(12.f, 13 * u_);
      UiFont cf = o.state.empty() && o.price > 0 ? UiFont::CondItalic : UiFont::CondBold;
      chipW = ui_.textWidth(chip, cfs, cf) + 26 * u_;
      bool shortMoney = o.price > 0 && o.state.empty() && save_.money < o.price;
      vec4 cc = shortMoney ? ko : o.state.empty() ? blue : ok;
      float chx = x + ox + cw - 22 * u_ - chipW, chh = 34 * u_;
      if (o.state.empty()) ui_.text(chx + chipW / 2, cy + (cardH - ui_.lineHeight(cfs, cf)) / 2, cfs, cf, a(cc, alpha), chip, UiAlign::Center);
      else { ui_.roundRect(chx, cy + (cardH - chh) / 2, chipW, chh, chh / 2, a(cc, 0.15f)); ui_.text(chx + chipW / 2, cy + (cardH - ui_.lineHeight(cfs, cf)) / 2, cfs, cf, a(cc, alpha), chip, UiAlign::Center); }
    }
    float labW = cw - (tx - x - ox) - chipW - 34 * u_;
    if (o.sub.empty()) ui_.textFit(tx, cy + (cardH - ui_.lineHeight(24 * u_, UiFont::CondItalic)) / 2, labW, 24 * u_, UiFont::CondItalic, a(blue, alpha), o.label);
    else {
      ui_.textFit(tx, cy + 9 * u_, labW, 24 * u_, UiFont::CondItalic, a(blue, alpha), o.label);
      ui_.textFit(tx, cy + 38 * u_, labW, std::max(11.f, 12.5f * u_), UiFont::Body, a(blueDim, alpha), o.sub);
    }
    Item it;
    it.x = x; it.y = cy; it.w = cw + 10 * u_; it.h = cardH; it.label = o.label; it.inList = true;
    it.activate = [choose, k] { choose(k); };
    items_.push_back(it);
    cy += cardH + gap;
  }
  ui_.popClip();
  if (focus_ >= 0 && focus_ < int(items_.size())) {
    const Item& f = items_[size_t(focus_)];
    float top = f.y + scroll_ - listTop_;
    if (top < scrollTarget_) scrollTarget_ = std::max(0.f, top - 10 * u_);
    else if (top + f.h > scrollTarget_ + listH_) scrollTarget_ = std::min(std::max(0.f, contentH_ - listH_), top + f.h - listH_ + 10 * u_);
  }
  float sy = listTop_ + std::min(listH_, contentH_) + 12 * u_;
  float sx = x;
  for (size_t k : second) {
    const DialogOption& o = dialog_.options[k];
    float before = float(items_.size());
    button(sx, sy, 200 * u_, 58 * u_, 26 * u_, upper(o.label), 13 + int(k), [choose, k] { choose(k); });
    items_.back().y = sy; items_.back().h = 58 * u_;
    sx += items_.back().w + 16 * u_;
    (void)before;
  }
  // the money you have (bottom right of the card)
  ui_.text(x + cw, listTop_ - 30 * u_, 22 * u_, UiFont::CondItalic, white, "$" + fmtMoney(save_.money), UiAlign::Right);
  drawHints(dialog_.tabs.empty() ? std::vector<std::pair<std::string, std::string>>{{"updown", "Select"}, {"enter", "Choose"}, {"esc", "Close"}}
                                 : std::vector<std::pair<std::string, std::string>>{{"updown", "Select"}, {"tabs", "Tabs"}, {"enter", "Buy / wear"}, {"esc", "Close"}});
}

void Menus::scrConfirm() {
  drawShade(1);
  float x = 110 * u_, y = 220 * u_;
  heading(x, y, "ARE YOU SURE?", confirmText_);
  y += 190 * u_;
  button(x, y, 300 * u_, 74 * u_, 34 * u_, "NO, KEEP IT", 13, [this] { open(confirmBack_, -1); });
  y += 84 * u_;
  button(x, y, 300 * u_, 74 * u_, 34 * u_, "YES, RESET", 29, [this] { auto f = confirmYes_; if (f) f(); });
  drawHints({{"updown", "Select"}, {"enter", "Confirm"}, {"esc", "Back"}});
}

} // namespace sl
