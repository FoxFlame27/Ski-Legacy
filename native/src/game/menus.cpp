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
int seedOf(const std::string& s) { int h = 17; for (char c : s) h = (h * 31 + static_cast<unsigned char>(c)) % 9973; return h; }   // (menu.js seedOf)

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
    {"bloom", "Bloom", 't', 0, 0, 0, nullptr, {}},
    {"brightness", "Brightness", 'r', 0.7, 1.3, 0.05, "p", {}},
    {"fpsCap", "Frame rate limit", 'c', 0, 0, 0, nullptr, {{30, "30"}, {60, "60"}, {0, "Unlimited"}}},
    {"fullscreen", "Fullscreen", 't', 0, 0, 0, nullptr, {}},
    {nullptr, "AUDIO", 0, 0, 0, 0, nullptr, {}},
    {"volume", "Master volume", 'r', 0, 1, 0.05, "p", {}},
    {"musicVolume", "Music", 'r', 0, 1, 0.05, "p", {}},
    {"sfxVolume", "Sound effects", 'r', 0, 1, 0.05, "p", {}},
    {"voiceVolume", "Announcer", 'r', 0, 1, 0.05, "p", {}},
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
// (Phase 7) "switch": the Nintendo Switch budget (engine/quality.h), first in the row
const char* QUALITY_ORDER[] = {"switch", "super", "performance", "balanced", "high", "ultra", "superultra"};
const char* QUALITY_LABELS[] = {"Switch (handheld)", "Super Performance", "Performance", "Balanced", "High", "Ultra", "Super Ultra"};
constexpr int kQualityCount = 7;
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
  n.text = ev.text;
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
  focusScroll_ = true;
  thumbDrag_ = false;
  enterT_ = t_;
  // opened by the game (Esc / Menu -> PAUSE, E -> a shop) rather than from inside frame(): the key or button that
  // opened it is still in this frame's UiNav, and must not also act on the new screen (Esc would resume the pause
  // menu it just opened: the pause menu never stayed open)
  if (!inFrame_) freshOpen_ = true;
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
  for (size_t i = 0; i < items_.size(); i++) if (items_[i].label == label) { focus_ = int(i); focusScroll_ = true; return true; }
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
  // the list's scrollbar (style.css .set-scroll: a thin thumb down the right edge): drag it, or click the track to page
  float maxScroll = std::max(0.f, contentH_ - listH_);
  if (listH_ > 0 && maxScroll > 0) {
    float d = ui_.dpr(), tx = listRight_ - 8 * d;
    float th = std::max(24 * d, listH_ * listH_ / contentH_), ty = listTop_ + (listH_ - th) * (scroll_ / maxScroll);
    bool onTrack = nav.mouse.x >= tx - 4 * d && nav.mouse.x <= listRight_ + 4 * d && nav.mouse.y >= listTop_ && nav.mouse.y <= listTop_ + listH_;
    if (nav.click && onTrack) {
      if (nav.mouse.y >= ty && nav.mouse.y <= ty + th) { thumbDrag_ = true; thumbGrabY_ = nav.mouse.y; thumbGrabScroll_ = scroll_; }
      else scrollTarget_ = std::clamp(scrollTarget_ + (nav.mouse.y < ty ? -listH_ : listH_) * 0.9f, 0.f, maxScroll);
      return;
    }
    if (thumbDrag_) {
      if (!nav.mouseDown) thumbDrag_ = false;
      else { scrollTarget_ = scroll_ = std::clamp(thumbGrabScroll_ + (nav.mouse.y - thumbGrabY_) * (maxScroll / std::max(1.f, listH_ - th)), 0.f, maxScroll); return; }
    }
  } else thumbDrag_ = false;
  // the wheel / trackpad (SDL's precise delta: a wheel notch is 1, a trackpad gives fractions) scrolls the list; the
  // focus stays where it is (a hover does not pull the list back)
  if (nav.wheel != 0 && listH_ > 0) scrollTarget_ = std::clamp(scrollTarget_ - nav.wheel * 48 * u_, 0.f, maxScroll);
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
  if (!n) { if (nav.cancel) back(); return; }
  focus_ = std::clamp(focus_, 0, n - 1);
  auto move = [&](int d) {
    int i = focus_;
    for (int k = 0; k < n; k++) { i = ((i + d) % n + n) % n; if (!items_[size_t(i)].disabled) break; }
    focus_ = i;
    focusScroll_ = true;
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
  // style.css .shade-left / .shade-full / .shade-show (and #menu.paused .shade-left): gradients of rgb(4, 14, 34)
  float W = float(ui_.width()), H = float(ui_.height());
  auto stops = [](float t, std::initializer_list<std::pair<float, float>> st) {
    float prevT = 0, prevA = st.begin()->second;
    for (auto& [pt, pa] : st) { if (t <= pt) return pt > prevT ? prevA + (pa - prevA) * (t - prevT) / (pt - prevT) : pa; prevT = pt; prevA = pa; }
    return prevA;
  };
  if (mode == 1) {   // full: radial (ellipse 80% 70% at 50% 56%) .12 -> .58, + bottom .45 -> 0 at 40%
    ui_.gradientGrid(0, 0, W, H, 24, 18, [&](float fx, float fy) {
      float rx = (fx - 0.5f) / 0.8f, ry = (fy - 0.56f) / 0.7f;
      // (the ending shape reaches the farthest corner: the gradient ray is normalised to it)
      float far = std::sqrt((0.5f / 0.8f) * (0.5f / 0.8f) + (0.56f / 0.7f) * (0.56f / 0.7f));
      float r = std::min(1.f, std::sqrt(rx * rx + ry * ry) / far);
      float a1 = 0.12f + (0.58f - 0.12f) * r, a2 = stops(1 - fy, {{0, 0.45f}, {0.4f, 0}});
      return vec4(vec3(shade), a1 + a2 * (1 - a1));
    });
  } else if (mode == 2) {   // show: left .66 / .24 at 36% / 0 at 54%, + bottom .42 -> 0 at 32%
    ui_.gradientGrid(0, 0, W, H, 24, 12, [&](float fx, float fy) {
      float a1 = stops(fx, {{0, 0.66f}, {0.36f, 0.24f}, {0.54f, 0}}), a2 = stops(1 - fy, {{0, 0.42f}, {0.32f, 0}});
      return vec4(vec3(shade), a1 + a2 * (1 - a1));
    });
  } else if (mode == 3) {   // paused: .72 / .38 at 45% / rgba(0,0,0,.08) from 72%
    ui_.gradientGrid(0, 0, W, H, 24, 1, [&](float fx, float) {
      float al = stops(fx, {{0, 0.72f}, {0.45f, 0.38f}, {0.72f, 0.08f}});
      vec3 c = fx < 0.45f ? vec3(shade) : glm::mix(vec3(shade), vec3(0), std::clamp((fx - 0.45f) / 0.27f, 0.f, 1.f));
      return vec4(c, al);
    });
  } else {           // left: .6 / .2 at 44% / 0 at 66%
    ui_.gradientGrid(0, 0, W, H, 24, 1, [&](float fx, float) { return vec4(vec3(shade), stops(fx, {{0, 0.6f}, {0.44f, 0.2f}, {0.66f, 0}})); });
  }
}

void Menus::drawLogo(bool big) {
  // .menu-logo (main / pause): white Barlow 700, SKI 42u (letter-spacing 0.5em) over LEGACY 104u, line-height 0.85,
  // text-shadow 0 6u 30u rgba(0,0,0,.45); elsewhere the .menu-mark top right (SKI 17u, LEGACY 38u, opacity 0.92)
  const vec4 sh = a(hex(0x000000), 0.45f);
  if (big) {
    float x = 72 * u_, y = 50 * u_, s1 = 42 * u_, s2 = 104 * u_;
    float y2 = y + s1 * 0.85f;
    ui_.textShadow(x, y + (s1 * 0.85f - ui_.lineHeight(s1, UiFont::CondBold)) / 2, s1, UiFont::CondBold, "SKI", UiAlign::Left, 0.5f, 0, 6 * u_, 30 * u_, sh);
    ui_.textShadow(x, y2 + (s2 * 0.85f - ui_.lineHeight(s2, UiFont::CondBold)) / 2, s2, UiFont::CondBold, "LEGACY", UiAlign::Left, 0.03f, 0, 6 * u_, 30 * u_, sh);
    ui_.textLH(x, y, s1 * 0.85f, s1, UiFont::CondBold, white, "SKI", UiAlign::Left, 0.5f);
    ui_.textLH(x, y2, s2 * 0.85f, s2, UiFont::CondBold, white, "LEGACY", UiAlign::Left, 0.03f);
  } else {
    float s1 = 17 * u_, s2 = 38 * u_, d = ui_.dpr();
    float w1 = ui_.textWidth("SKI", s1, UiFont::CondBold, 0.45f), w2 = ui_.textWidth("LEGACY", s2, UiFont::CondBold, 0.03f);
    float right = float(ui_.width()) - 72 * u_, x2 = right - w2, x1 = x2 - 10 * u_ - w1;
    float top = 54 * u_, lh2 = ui_.lineHeight(s2, UiFont::CondBold);
    float base = top + (lh2 - (ui_.ascent(UiFont::CondBold) - ui_.descent(UiFont::CondBold)) * s2) * 0.5f + ui_.ascent(UiFont::CondBold) * s2;
    float y1 = base - ui_.ascent(UiFont::CondBold) * s1 - (ui_.lineHeight(s1, UiFont::CondBold) - (ui_.ascent(UiFont::CondBold) - ui_.descent(UiFont::CondBold)) * s1) * 0.5f;
    ui_.textShadow(x1, y1, s1, UiFont::CondBold, "SKI", UiAlign::Left, 0.45f, 0, 2 * d, 14 * d, sh);
    ui_.textShadow(x2, top, s2, UiFont::CondBold, "LEGACY", UiAlign::Left, 0.03f, 0, 2 * d, 14 * d, sh);
    ui_.text(x1, y1, s1, UiFont::CondBold, a(white, 0.92f), "SKI", UiAlign::Left, 0.45f);
    ui_.text(x2, top, s2, UiFont::CondBold, a(white, 0.92f), "LEGACY", UiAlign::Left, 0.03f);
  }
}

void Menus::drawHints(const std::vector<std::pair<std::string, std::string>>& hints) {
  // .menu-foot: left / right 72u, bottom 30u; 600 t-xs Inter, white .85, text-shadow 0 1px 6px rgba(0,0,0,.5); each
  // hint a .kc (outlined in the text colour) and its label (letter-spacing 0.1em, uppercase), 22u apart; the credit right
  const float d = ui_.dpr(), fs = std::max(11 * d, 11 * u_), kh = ui_.kcHeight(u_);
  const vec4 col = a(white, 0.85f), shc = a(hex(0x000000), 0.5f);
  float cy = float(ui_.height()) - 30 * u_ - kh / 2, x = 72 * u_, ty = cy - ui_.lineHeight(fs, UiFont::BodySemi) / 2;
  float gap = std::max(4 * d, 6 * u_);
  for (const auto& [k, label] : hints) {
    if (input_.usingGamepad() && (label.rfind("Drag", 0) == 0 || label.rfind("Click", 0) == 0)) continue;
    std::vector<std::string> caps;
    bool pad = input_.usingGamepad();
    if (k == "updown") { if (pad) caps = {prompts::K(input_, "updown")}; else caps = {"\xE2\x86\x91", "\xE2\x86\x93"}; }
    else if (k == "leftright") { if (pad) caps = {prompts::K(input_, "leftright")}; else caps = {"\xE2\x86\x90", "\xE2\x86\x92"}; }
    else if (k == "enter") caps = {prompts::K(input_, "confirm")};
    else if (k == "esc") caps = {prompts::K(input_, "cancel")};
    else if (k == "tabs") caps = {pad ? std::string(prompts::padGlyph(4, input_.padFamily())) + " " + prompts::padGlyph(5, input_.padFamily()) : "Q E"};
    for (size_t i = 0; i < caps.size(); i++) x += ui_.kc(x, cy - kh / 2, u_, caps[i], col) + (i + 1 < caps.size() ? 4 * u_ : gap);
    std::string t = upper(label);
    ui_.textShadow(x, ty, fs, UiFont::BodySemi, t, UiAlign::Left, 0.1f, 0, d, 6 * d, shc);
    x += ui_.text(x, ty, fs, UiFont::BodySemi, col, t, UiAlign::Left, 0.1f) + 22 * u_;
  }
  float rx = float(ui_.width()) - 72 * u_;
  ui_.textShadow(rx, ty, fs, UiFont::BodySemi, "Icecold Studio", UiAlign::Right, 0.1f, 0, d, 6 * d, shc);
  ui_.text(rx, ty, fs, UiFont::BodySemi, col, "Icecold Studio", UiAlign::Right, 0.1f);
}

void Menus::heading(float x, float y, const std::string& title, const std::string& sub) {
  // .menu-title: brushSVG(seedOf(title), w, 100) at round(w * 0.9)u x 90u, w = min(760, 150 + 26 per letter); the
  // title italic 700 44u (letter-spacing 0.04em) from 40u; .menu-sub 600 t-md / 1.35, white .92, below it
  float vw = std::round(std::min(760.f, 150.f + float(title.size()) * 26.f)), w = std::round(vw * 0.9f) * u_, h = 90 * u_;
  Ui::Shadow sh{0, 6 * u_, 14 * u_, a(hex(0x000000), 0.25f)};
  ui_.brushStroke(x, y, w, h, white, seedOf(title), vw, 100, &sh);
  ui_.textLH(x + 40 * u_, y, h, 44 * u_, UiFont::CondItalic, blue, title, UiAlign::Left, 0.04f);
  if (!sub.empty()) {
    float fs = std::max(13 * ui_.dpr(), 15 * u_);
    ui_.textShadow(x + 12 * u_, y + h + 6 * u_ + fs * 0.075f, fs, UiFont::BodySemi, sub, UiAlign::Left, 0.02f, 0, ui_.dpr(), 8 * ui_.dpr(), hex(0x000a1e, 0.6f));
    ui_.textLH(x + 12 * u_, y + h + 6 * u_, fs * 1.35f, fs, UiFont::BodySemi, a(white, 0.92f), sub, UiAlign::Left, 0.02f);
  }
}

bool Menus::button(float x, float y, float minW, float h, float fs, const std::string& label, int seed, std::function<void()> act, bool disabled) {
  // .brush-btn: a 420 x 96 paint stroke stretched to the label (padding-left 46u, padding-right 66u at 82u; scaled with
  // the height for the big / small / compact sizes), italic 700 Barlow, letter-spacing 0.06em, filter: drop-shadow(0 6u
  // 14u rgba(0,0,0,.25)); focused: translateX(14u) rotate(-1deg), the stroke scaleX(1.05), a red bar at -16u
  int idx = int(items_.size());
  bool foc = idx == focus_;
  float k = h / (82 * u_);
  float padL = (h > 95 * u_ ? 46 : h < 64 * u_ ? 38 : h < 76 * u_ && h > 72 * u_ ? 40 : 46) * u_;
  float padR = (h > 95 * u_ ? 80 : h < 64 * u_ ? 50 : 66 * std::min(1.f, k)) * u_;
  (void)k;
  float tw = ui_.textWidth(label, fs, UiFont::CondItalic, 0.06f);
  float w = std::max(minW, padL + tw + padR);
  // brushIn: 0.55 s after a 70 + 60 i ms stagger (from -60u, revealed left to right)
  double t = (t_ - enterT_ - 0.07 - 0.06 * idx) / 0.55;
  float e = float(std::clamp(t, 0.0, 1.0));
  e = 1 - std::pow(1 - e, 4.f);
  float alpha = e * (disabled ? 0.55f : 1.f);
  if (alpha <= 0.002f) { Item it; it.x = x; it.y = y; it.w = w; it.h = h; it.label = label; it.activate = std::move(act); it.disabled = disabled; items_.push_back(std::move(it)); return foc; }
  float ox = (1 - e) * -60 * u_;
  ui_.pushTranslate(ox + (foc ? 14 * u_ : 0), 0);
  if (foc) ui_.pushRotate(x + w / 2, y + h / 2, -1.f * 3.14159265f / 180.f);
  if (foc) ui_.rect(x - 16 * u_, y + h * 0.3f, 6 * u_, h * 0.4f, a(red, alpha));
  Ui::Shadow sh{0, 6 * u_, 14 * u_, a(hex(0x000000), 0.25f)};
  float sw = w * (foc ? 1.05f : 1.f);
  ui_.pushClip(x - 40 * u_, y - 40 * u_, (sw + 80 * u_) * e, h + 80 * u_);
  ui_.brushStroke(x, y, sw, h, a(white, alpha), seed, 420, 96, &sh);
  ui_.popClip();
  ui_.textLH(x + padL, y, h, fs, UiFont::CondItalic, a(blue, alpha), label, UiAlign::Left, 0.06f);
  if (foc) ui_.popTransform();
  ui_.popTransform();
  Item it;
  it.x = x; it.y = y; it.w = w; it.h = h; it.label = label; it.activate = std::move(act); it.disabled = disabled;
  items_.push_back(std::move(it));
  return foc;
}

void Menus::panel(float x, float y, float w, float h) {
  // .menu-panel: rgba(255,255,255,.95) paper, menu.js brushClip(seed, 5, 4), drop-shadow(0 10u 24u rgba(0,14,44,.3))
  Ui::Shadow sh{0, 10 * u_, 24 * u_, hex(0x000e2c, 0.3f)};
  ui_.brushClip(x, y, w, h, a(white, 0.95f), 150 + int(x / std::max(1.f, u_)) % 7, 5, 4, u_, &sh);
}

void Menus::drawScrollbar() {
  // .set-scroll scrollbar: thin, rgba(21, 70, 200, .45) thumb, rounded
  float maxScroll = std::max(0.f, contentH_ - listH_);
  if (listH_ <= 0 || maxScroll <= 0) return;
  float d = ui_.dpr(), th = std::max(24 * d, listH_ * listH_ / contentH_), ty = listTop_ + (listH_ - th) * std::clamp(scroll_ / maxScroll, 0.f, 1.f);
  ui_.roundRect(listRight_ - 7 * d, ty, 6 * d, th, 3 * d, hex(0x1546c8, thumbDrag_ ? 0.65f : 0.45f));
}

// ---------------------------------------------------------------- the frame
bool Menus::textFieldFocused() const {
  return screen_ == Screen::Multiplayer && focus_ == 0 && mp.account && mp.account().empty();
}

void Menus::frame(const UiNav& navIn, double dt, double now) {
  t_ = now;
  u_ = ui_.cssU();   // (style.css --u: 1 CSS px on a 1280 x 800 window, x the display's pixel ratio)
  struct InFrame { bool& f; explicit InFrame(bool& b) : f(b) { f = true; } ~InFrame() { f = false; } } guard(inFrame_);
  // the frame a screen was opened from outside: its presses are not this screen's (the pointer still hovers)
  bool fresh = freshOpen_;
  freshOpen_ = false;
  UiNav quiet;
  if (fresh) {
    quiet.mouse = navIn.mouse; quiet.mouseDown = navIn.mouseDown; quiet.usingPad = navIn.usingPad;
    quiet.stickL = navIn.stickL; quiet.stickR = navIn.stickR;
  }
  const UiNav& nav = fresh ? quiet : navIn;
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
      // with text input on (game.cpp turns it on while this field has the focus) the letters come from the OS in the
      // keyboard's layout (QWERTZ, AZERTY, dead keys); without it (a platform with no text input), from the keys
      bool text = plat_.textInputActive();
      for (platform::Key k : nav.keys) {
        int ki = int(k);
        char c = 0;
        if (ki >= int(platform::Key::KeyA) && ki <= int(platform::Key::KeyZ)) c = char((shift ? 'A' : 'a') + (ki - int(platform::Key::KeyA)));
        else if (ki >= int(platform::Key::Digit0) && ki <= int(platform::Key::Digit9)) c = char('0' + (ki - int(platform::Key::Digit0)));
        else if (k == platform::Key::Space) c = ' ';
        if (c) { if (!text) textAppend(nameField_, std::string(1, c), 16, true); n2.up = n2.down = n2.left = n2.right = n2.confirm = false; n2.tabPrev = n2.tabNext = false; }
        if (k == platform::Key::Backspace) { textBackspace(nameField_); n2.cancel = false; }
      }
      if (text) textAppend(nameField_, nav.text, 16, true);
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
  float x = 72 * u_, y = 226 * u_;
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
  y += 98 * u_;   // (.small: margin-top 10u)
  button(x, y, 250 * u_, 62 * u_, 28 * u_, "QUIT", 13, [this] { if (hooks.quit) hooks.quit(); });
  drawHints({{"updown", "Select"}, {"enter", "Confirm"}});
}

void Menus::scrPlayMode() {
  drawShade(0);
  drawLogo(true);
  float x = 72 * u_, y = 226 * u_;
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
  y += 116 * u_;   // (.small: margin-top 10u)
  button(x, y, 250 * u_, 62 * u_, 28 * u_, "BACK", 13, [this] { back(); });
  drawHints({{"updown", "Select"}, {"enter", "Confirm"}, {"esc", "Back"}});
}

// (Phase 6) MULTIPLAYER: the server, its worlds, your account; JOIN A WORLD logs in (the server picks the world: the
// fullest one with room, up to 50 players)
void Menus::scrMultiplayer(const UiNav& nav) {
  (void)nav;
  drawShade(0);
  drawLogo(false);
  float x = 72 * u_, y = 46 * u_;
  std::string acc = mp.account ? mp.account() : "";
  bool busy = mp.busy && mp.busy();
  heading(x, y, "MULTIPLAYER", "Ski with everyone in your world \xC2\xB7 up to 50 players a world \xC2\xB7 the server keeps your money, cars and chalet");
  float py = y + 90 * u_ + 6 * u_ + std::max(13 * ui_.dpr(), 15 * u_) * 1.35f + 20 * u_, pw = 560 * u_, ph = 196 * u_;
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
  // menu.js scrShowcase: the head, the .sc-panel (420u, brushClip(140, 6, 4)) with the MAN / WOMAN brush switch and
  // the note, START below it
  drawShade(2);
  drawLogo(false);
  const float d = ui_.dpr(), tmd = std::max(13 * d, 15 * u_), tsm = std::max(12 * d, 13 * u_);
  float x = 72 * u_, y = 46 * u_;
  heading(x, y, "CHOOSE YOUR SKIER", inGame ? "Change your skier" : "Free ride \xC2\xB7 the open resort");
  // drag across the free area (or the right stick) turns the skier
  if (nav.mouseDown && nav.mouse.x > 520 * u_) {
    if (dragLast_.x >= 0 && hooks.spin) hooks.spin((nav.mouse.x - dragLast_.x) * 0.012f);
    dragLast_ = nav.mouse;
  } else dragLast_ = vec2(-1);
  if (std::fabs(nav.stickR.x) > 0.2f && hooks.spin) hooks.spin(nav.stickR.x * float(dt) * 3.f);
  float py = y + 90 * u_ + 6 * u_ + tmd * 1.35f + 20 * u_, pw = 420 * u_;
  const char* note = "Customize your look in the ski shop: jackets, trousers, helmets and goggles.";
  float noteW = pw - 64 * u_;
  // (the note's height: wrapped at its width, line-height 1.45)
  int noteLines = 1;
  {
    std::string line, word, ns = note;
    for (size_t i = 0; i <= ns.size(); i++) {
      char ch = i < ns.size() ? ns[i] : ' ';
      if (ch != ' ') { word += ch; continue; }
      if (word.empty()) continue;
      std::string cand = line.empty() ? word : line + " " + word;
      if (!line.empty() && ui_.textWidth(cand, tsm, UiFont::BodyMed) > noteW) { noteLines++; line = word; } else line = cand;
      word.clear();
    }
  }
  float bh = 84 * u_, ph = 22 * u_ + bh + 26 * u_ + tsm * 1.45f * float(noteLines) + 28 * u_;
  float e = float(std::clamp((t_ - enterT_ - 0.13) / 0.55, 0.0, 1.0));
  e = 1 - std::pow(1 - e, 4.f);
  ui_.pushAlpha(e); ui_.pushTranslate(-40 * u_ * (1 - e), 0);
  Ui::Shadow sh{0, 10 * u_, 24 * u_, hex(0x000e2c, 0.35f)};
  ui_.brushClip(x, py, pw, ph, white, 140, 6, 4, u_, &sh);
  const char* labels[2] = {"MAN", "WOMAN"};
  float bx = x + 34 * u_, bw = (pw - 64 * u_ - 10 * u_) / 2, by = py + 22 * u_;
  for (int i = 0; i < 2; i++) {
    float xx = bx + float(i) * (bw + 10 * u_);
    bool on = i == chi_;
    ui_.brushPanel(xx, by, bw, bh, on ? blue : bluePale, 1);
    ui_.textLH(xx + bw / 2, by, bh, 46 * u_, UiFont::CondItalic, on ? white : blue, labels[i], UiAlign::Center, 0.06f);
    if (on) ui_.rect(xx + bw / 2 - 24 * u_, by + bh + 8 * u_, 48 * u_, 5 * u_, red);
    Item it;
    it.x = xx; it.y = by; it.w = bw; it.h = bh; it.label = labels[i];
    it.activate = [this, i] { pickChar(i); };
    it.adjust = [this](int dd) { pickChar(chi_ + dd); };
    items_.push_back(it);
  }
  ui_.textWrapped(x + 34 * u_, by + bh + 26 * u_ + tsm * 0.125f, noteW, tsm, UiFont::BodyMed, blueDim, note, 1.45f);
  ui_.popTransform(); ui_.popAlpha();
  float sy = py + ph + 24 * u_;
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
  // menu.js scrPause: a .compact column (70u buttons, RESUME 88u, QUIT GAME 58u); more than five rows: the small logo
  // and padding-top 116u (.tight)
  bool online = mp.online && mp.online();
  drawShade(3);
  drawLogo(false);
  float x = 72 * u_, y = 116 * u_, h = 70 * u_, step = 76 * u_;
  button(x, y, 430 * u_, 88 * u_, 48 * u_, "RESUME", 5, [this] { if (hooks.resume) hooks.resume(); });
  y += 94 * u_;
  button(x, y, 360 * u_, h, 36 * u_, "CONTROLS", 31, [this] { ctlBack_ = Screen::None; open(Screen::Controls); }); y += step;
  button(x, y, 360 * u_, h, 36 * u_, "STATS", 7, [this] { open(Screen::Stats); }); y += step;
  button(x, y, 360 * u_, h, 36 * u_, "SETTINGS", 11, [this] { open(Screen::Settings); }); y += step;
  if (online) { button(x, y, 500 * u_, h, 36 * u_, "LEAVE MULTIPLAYER", 23, [this] { if (mp.leave) mp.leave(); }); y += step; }
  else { button(x, y, 360 * u_, h, 36 * u_, "MAIN MENU", 23, [this] { if (hooks.mainMenu) hooks.mainMenu(); }); y += step; }
  button(x, y, 500 * u_, h, 36 * u_, "RETURN TO VILLAGE", 19, [this] { if (hooks.village) hooks.village(); }); y += step + 10 * u_;
  button(x, y, 250 * u_, 58 * u_, 27 * u_, "QUIT GAME", 13, [this] { if (hooks.quit) hooks.quit(); });
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
  // menu.js scrStats: two .menu-panel (470u, 36u apart): CAREER rows (600 t-md label, italic 700 26u value) and the
  // course records
  drawShade(0);
  drawLogo(false);
  const float d = ui_.dpr(), tmd = std::max(13 * d, 15 * u_), txs = std::max(11 * d, 11 * u_), tsm = std::max(12 * d, 13 * u_);
  float x = 72 * u_, y = 46 * u_;
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
  rows.push_back({"Day", std::to_string(save_.day)});
  float py = y + 90 * u_ + 6 * u_ + tmd * 1.35f + 20 * u_, pw = 470 * u_;
  float rowH = std::max(46 * u_, 12 * u_ + 26 * u_), headH = txs + 8 * u_;
  float ph = 18 * u_ + headH + rowH * float(rows.size()) + 20 * u_;
  // slideIn: 0.5 s after the stagger (from -40u, faded)
  auto slide = [&](int i) { float e = float(std::clamp((t_ - enterT_ - 0.07 - 0.06 * i) / 0.5, 0.0, 1.0)); return 1 - std::pow(1 - e, 4.f); };
  const vec4 line12 = hex(0x1546c8, 0.12f);
  Ui::Shadow sh{0, 10 * u_, 24 * u_, hex(0x000e2c, 0.3f)};
  {
    float e = slide(1);
    ui_.pushAlpha(e); ui_.pushTranslate(-40 * u_ * (1 - e), 0);
    ui_.brushClip(x, py, pw, ph, a(white, 0.95f), 150, 5, 4, u_, &sh);
    float ry = py + 18 * u_;
    ui_.textLH(x + 30 * u_, ry, txs, txs, UiFont::BodyHeavy, red, "CAREER", UiAlign::Left, 0.18f);
    ry += headH;
    for (size_t i = 0; i < rows.size(); i++) {
      ui_.textLH(x + 30 * u_, ry, rowH, tmd, UiFont::BodySemi, blue, rows[i].first);
      ui_.textLH(x + pw - 30 * u_, ry, rowH, 26 * u_, UiFont::CondItalic, blue, rows[i].second, UiAlign::Right);
      if (i + 1 < rows.size()) ui_.rect(x + 30 * u_, ry + rowH - d, pw - 60 * u_, d, line12);
      ry += rowH;
    }
    ui_.popTransform(); ui_.popAlpha();
  }
  float qx = x + pw + 36 * u_;
  if (qx + pw < float(ui_.width())) {
    float e = slide(2);
    ui_.pushAlpha(e); ui_.pushTranslate(-40 * u_ * (1 - e), 0);
    float qh = 18 * u_ + headH + rowH + 20 * u_;
    ui_.brushClip(qx, py, pw, qh, a(white, 0.95f), 151, 5, 4, u_, &sh);
    ui_.textLH(qx + 30 * u_, py + 18 * u_, txs, txs, UiFont::BodyHeavy, red, "COURSE RECORDS", UiAlign::Left, 0.18f);
    ui_.textLH(qx + 30 * u_, py + 18 * u_ + headH, rowH, tsm, UiFont::BodySemi, blueDim, "No time yet: race at the RACING stand in Legacy Village");
    ui_.popTransform(); ui_.popAlpha();
  }
  drawHints({{"esc", "Back"}});
}

// ---------------------------------------------------------------- SETTINGS
void Menus::scrSettings() {
  // menu.js scrSettings + style.css .menu-panel.settings.set-main / .set-scroll / .mp-row / .seg / .set-range
  drawShade(0);
  drawLogo(false);
  const float d = ui_.dpr(), W = float(ui_.width()), H = float(ui_.height());
  const float tsm = std::max(12 * d, 13 * u_), txs = std::max(11 * d, 11 * u_), tmd = std::max(13 * d, 15 * u_);
  float x = 72 * u_, y = 46 * u_;
  heading(x, y, "SETTINGS", "Performance runs smoothest on laptops, Super Performance on handhelds \xC2\xB7 the graphics preset applies the next time the game starts");
  float py = y + 90 * u_ + 6 * u_ + tmd * 1.35f + 20 * u_;
  float pw = std::min(700 * u_, W - x - 40 * u_), ph = std::max(120 * u_, H - 92 * u_ - py);
  {
    Ui::Shadow sh{0, 10 * u_, 24 * u_, hex(0x000e2c, 0.3f)};
    ui_.brushClip(x, py, pw, ph, a(white, 0.95f), 160, 5, 4, u_, &sh);
  }
  // the scroll box: the panel's content (padding 18u 18u 20u 30u) widened 14u each side
  listTop_ = py + 18 * u_; listH_ = ph - 38 * u_; listRight_ = x + pw - 18 * u_ + 14 * u_;
  float rx = x + 30 * u_, rw = pw - 30 * u_ - 18 * u_ - 12 * u_;   // the rows' content box (the scroll box's padding 14u / 26u)
  float bx0 = rx - 14 * u_, bw = rw + 28 * u_;                       // the rows' box (margin 0 -14u)
  ui_.pushClip(x, listTop_, pw, listH_);
  float ry = listTop_ - scroll_;
  bool firstHead = true;
  const vec4 line12 = hex(0x1546c8, 0.12f), line18 = hex(0x1546c8, 0.18f);
  auto head = [&](const char* label) {
    float top = firstHead ? 4 * u_ : 18 * u_;
    firstHead = false;
    ui_.textLH(rx, ry + top, txs, txs, UiFont::BodyHeavy, red, label, UiAlign::Left, 0.18f);
    ry += top + txs + 6 * u_;
    ui_.rect(rx, ry, rw, 2 * d, line18);
    ry += 2 * d;
  };
  // .seg button: padding 6u 10u, 2px border, radius 5u, 700 t-sm / 1
  const float segH = 12 * u_ + tsm + 4 * d;
  auto segW = [&](const std::string& l) { return ui_.textWidth(l, tsm, UiFont::BodyBold) + 20 * u_ + 4 * d; };
  // lays out right-aligned buttons wrapping within maxW; returns the height; xs / ys / ws the boxes
  struct Box { float x, y, w; };
  auto segLayout = [&](const std::vector<std::string>& labels, float maxW, std::vector<Box>& boxes) {
    boxes.clear();
    std::vector<std::vector<size_t>> lines(1);
    float lw = 0;
    for (size_t i = 0; i < labels.size(); i++) {
      float w = segW(labels[i]);
      if (!lines.back().empty() && lw + 4 * u_ + w > maxW) { lines.emplace_back(); lw = 0; }
      lw += (lines.back().empty() ? 0 : 4 * u_) + w;
      lines.back().push_back(i);
    }
    boxes.resize(labels.size());
    for (size_t li = 0; li < lines.size(); li++) {
      float tot = 0;
      for (size_t k = 0; k < lines[li].size(); k++) tot += segW(labels[lines[li][k]]) + (k ? 4 * u_ : 0);
      float bx = rx + rw - tot;
      for (size_t i : lines[li]) { float w = segW(labels[i]); boxes[i] = {bx, float(li) * (segH + 4 * u_), w}; bx += w + 4 * u_; }
    }
    return float(lines.size()) * segH + float(lines.size() - 1) * 4 * u_;
  };
  auto segDraw = [&](const std::vector<std::string>& labels, const std::vector<Box>& boxes, float top, int on, bool danger = false) {
    for (size_t i = 0; i < labels.size(); i++) {
      const Box& bxx = boxes[i];
      vec4 c = danger ? ko : blue;
      if (int(i) == on) ui_.roundRect(bxx.x, top + bxx.y, bxx.w, segH, 5 * u_, c);
      ui_.roundRectStroke(bxx.x, top + bxx.y, bxx.w, segH, 5 * u_, 2 * d, c);
      ui_.textLH(bxx.x + bxx.w / 2, top + bxx.y, segH, tsm, UiFont::BodyBold, int(i) == on ? white : c, labels[i], UiAlign::Center);
    }
  };
  // one .mp-row: the label (600 t-sm / 1.25, wrapping into labelW) and the control of height ctrlH on the right
  auto row = [&](const std::string& label, float labelW, float ctrlH, bool foc) {
    std::vector<std::string> lines;
    {
      std::string line, word;
      for (size_t i = 0; i <= label.size(); i++) {
        char ch = i < label.size() ? label[i] : ' ';
        if (ch != ' ') { word += ch; continue; }
        if (word.empty()) continue;
        std::string cand = line.empty() ? word : line + " " + word;
        if (!line.empty() && ui_.textWidth(cand, tsm, UiFont::BodySemi) > labelW) { lines.push_back(line); line = word; } else line = cand;
        word.clear();
      }
      if (!line.empty()) lines.push_back(line);
    }
    float lh = tsm * 1.25f, labH = lh * float(lines.size());
    float h = std::max(42 * u_, 10 * u_ + std::max(labH, ctrlH));
    if (foc) {
      ui_.gradientGrid(bx0, ry, bw, h, 8, 1, [](float fx, float) { return vec4(0.082f, 0.275f, 0.784f, 0.09f * (1 - fx)); });
      ui_.rect(bx0, ry, 4 * u_, h, red);
    }
    float ly = ry + (h - labH) / 2;
    for (auto& l : lines) { ui_.textLH(rx, ly, lh, tsm, UiFont::BodySemi, blue, l); ly += lh; }
    ui_.rect(bx0, ry + h - d, bw, d, line12);
    return h;
  };
  auto applyKey = [this](const std::string& k) { save_.markDirty(); if (hooks.setting) hooks.setting(k); };
  for (const SetRow& r : setRows()) {
    if (!r.key) { head(r.label); continue; }
    std::string key = r.key;
    bool foc = int(items_.size()) == focus_;
    Item it;
    it.label = key; it.inList = true;
    float rowTop = ry, h = 0;
    if (r.kind == 'q') {
      std::string q = save_.quality.empty() ? "balanced" : save_.quality;
      if (q == "low") q = "performance"; else if (q == "medium") q = "balanced";
      int qi = 3;
      for (int i = 0; i < kQualityCount; i++) if (q == QUALITY_ORDER[i]) qi = i;
      std::vector<std::string> labels(QUALITY_LABELS, QUALITY_LABELS + kQualityCount);
      std::vector<Box> boxes;
      float sh = segLayout(labels, rw - 160 * u_, boxes);
      h = row(r.label, 140 * u_, sh, foc);
      float top = rowTop + (h - sh) / 2;
      segDraw(labels, boxes, top, qi);
      auto set = [this, qi, applyKey](int i) {
        int n = std::clamp(i, 0, kQualityCount - 1);
        if (n == qi) return;
        save_.quality = QUALITY_ORDER[n];
        applyKey("quality");
      };
      it.adjust = [set, qi](int dd) { set(qi + dd); };
      it.activate = [set, qi] { set(qi + 1 < kQualityCount ? qi + 1 : 0); };
      std::vector<vec4> hits;
      for (auto& bxx : boxes) hits.push_back(vec4(bxx.x, top + bxx.y, bxx.w, segH));
      it.clickAt = [set, hits](float mx) { for (size_t i = 0; i < hits.size(); i++) if (mx >= hits[i].x && mx <= hits[i].x + hits[i].z) { set(int(i)); return; } };
    } else if (r.kind == 'r') {
      double v = save_.setting(r.key, r.min);
      char b[32];
      if (r.fmt[0] == 'p') std::snprintf(b, sizeof b, "%d%%", int(std::round(v * 100)));
      else if (r.fmt[0] == 'x') std::snprintf(b, sizeof b, "%.1fx", v);
      else std::snprintf(b, sizeof b, "%d\xC2\xB0", int(std::round(v)));
      float emW = std::max(48 * u_, ui_.textWidth(b, tsm, UiFont::BodyBold)), tw = 200 * u_;
      float ctrlH = 16 * d;
      h = row(r.label, rw - tw - 10 * u_ - emW - 16 * u_, ctrlH, foc);
      float cy = rowTop + h / 2, tx = rx + rw - emW - 10 * u_ - tw;
      // input[type=range] with accent-color: a rounded track (the done part blue), a round blue thumb
      float f = float(std::clamp((v - r.min) / (r.max - r.min), 0.0, 1.0)), th = 8 * d, kr = 8 * d;
      float kx = tx + kr + (tw - 2 * kr) * f;
      ui_.roundRect(tx, cy - th / 2, tw, th, th / 2, hex(0xefefef));
      ui_.roundRectStroke(tx, cy - th / 2, tw, th, th / 2, 1 * d, hex(0xb2b2b2));
      ui_.roundRect(tx, cy - th / 2, kx - tx, th, th / 2, blue);
      ui_.circle(kx, cy, kr, blue);
      ui_.textLH(rx + rw, cy - tsm / 2, tsm, tsm, UiFont::BodyBold, blueDim, b, UiAlign::Right);
      double mn = r.min, mx = r.max, st = r.step;
      it.adjust = [this, key, v, mn, mx, st, applyKey](int dd) {
        double n = std::clamp(std::round((v + dd * st) / st) * st, mn, mx);
        save_.settings[key] = n; applyKey(key);
      };
      it.clickAt = [this, key, tx, tw, kr, mn, mx, st, applyKey](float px) {
        if (px < tx - 10 * u_ || px > tx + tw + 10 * u_) return;
        double n = std::clamp(mn + std::round((mx - mn) * std::clamp((px - tx - kr) / (tw - 2 * kr), 0.f, 1.f) / st) * st, mn, mx);
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
      std::vector<Box> boxes;
      float sh = segLayout(labels, rw * 0.7f, boxes);
      float segTot = boxes.empty() ? 0 : rx + rw - boxes[0].x;
      h = row(r.label, rw - segTot - 16 * u_, sh, foc);
      float top = rowTop + (h - sh) / 2;
      segDraw(labels, boxes, top, on);
      char kind = r.kind;
      auto pick = [this, key, opts, kind, applyKey](int i) {
        i = ((i % int(opts.size())) + int(opts.size())) % int(opts.size());
        if (kind == 'h') {
          static const bool modes[3][4] = {{true, true, true, true}, {true, true, false, false}, {false, false, false, false}};
          for (int k = 0; k < 4; k++) save_.settings[HUD_KEYS[k]] = modes[i][k];
        } else if (kind == 'x') { save_.settings["speedFx"] = i == 1; save_.settings["vignette"] = i == 1; }
        else save_.settings[key] = opts[size_t(i)].first;
        applyKey(key);
      };
      it.adjust = [pick, on](int dd) { pick(on + dd); };
      it.activate = [pick, on] { pick(on + 1); };
      std::vector<vec4> hits;
      for (auto& bxx : boxes) hits.push_back(vec4(bxx.x, top + bxx.y, bxx.w, segH));
      it.clickAt = [pick, hits](float mx) { for (size_t i = 0; i < hits.size(); i++) if (mx >= hits[i].x && mx <= hits[i].x + hits[i].z) { pick(int(i)); return; } };
    } else if (r.kind == 'k') {
      std::vector<Box> boxes;
      std::vector<std::string> labels = {"Change controls"};
      float sh = segLayout(labels, rw, boxes);
      h = row(r.label, rw - boxes[0].w - 16 * u_, sh, foc);
      segDraw(labels, boxes, rowTop + (h - sh) / 2, -1);
      it.activate = [this] { ctlBack_ = Screen::Settings; open(Screen::Controls); };
    }
    it.x = bx0; it.y = rowTop; it.w = bw; it.h = h;
    items_.push_back(it);
    ry += h;
  }
  // PLAYER
  head("PLAYER");
  auto actionRow = [&](const std::string& label, const std::string& btn, bool danger, std::function<void()> act, const std::string& id) {
    bool foc = int(items_.size()) == focus_;
    std::vector<Box> boxes;
    std::vector<std::string> labels = {btn};
    float sh = segLayout(labels, rw, boxes);
    float rowTop = ry, h = row(label, rw - boxes[0].w - 16 * u_, sh, foc);
    segDraw(labels, boxes, rowTop + (h - sh) / 2, -1, danger);
    Item it;
    it.x = bx0; it.y = rowTop; it.w = bw; it.h = h; it.label = id; it.activate = std::move(act); it.inList = true;
    items_.push_back(it);
    ry += h;
  };
  actionRow("Skier", "Change skier", false, [this] { open(Screen::Showcase); }, "skier");
  {
    std::string acc = mp.account ? mp.account() : "";
    actionRow("Account", acc.empty() ? "Signed in as " + plat_.userName() : "Multiplayer: " + acc, false, [this, acc] {
      if (hooks.flash) hooks.flash(acc.empty() ? "This save is on this device \xC2\xB7 PLAY -> MULTIPLAYER registers a name on the server" : "Your multiplayer name on this device: " + acc, 0);
    }, "account");
  }
  actionRow("Progress", "Reset all progress", true, [this] {
    confirmText_ = "Reset all progress? Money, skis, cars and stats start over.";
    confirmYes_ = [this] { if (hooks.resetProgress) hooks.resetProgress(); open(Screen::Settings, -1); };
    confirmBack_ = Screen::Settings;
    open(Screen::Confirm);
  }, "reset");
  ui_.popClip();
  contentH_ = ry + scroll_ - listTop_;
  drawScrollbar();
  // keep the focused row in view (moved by keys / buttons only: the wheel and a hover leave the list where it is)
  if (focusScroll_ && focus_ >= 0 && focus_ < int(items_.size())) {
    focusScroll_ = false;
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
  drawLogo(false);
  float x = 72 * u_, y = 46 * u_;
  heading(x, y, "CONTROLS", "Keyboard, mouse and controller \xC2\xB7 Xbox, PlayStation and Switch \xC2\xB7 select a key or button to change it");
  if (!ctlFamilyPicked_) ctlFamily_ = input_.padConnected() ? input_.padFamily() : ctlFamily_;
  float py = y + 90 * u_ + 6 * u_ + std::max(13 * ui_.dpr(), 15 * u_) * 1.35f + 20 * u_, ph = float(ui_.height()) - py - 92 * u_;
  float pw = std::min(660 * u_, float(ui_.width()) * 0.56f), refW = std::min(460 * u_, float(ui_.width()) - x - pw - 22 * u_ - 40 * u_);
  {
    Ui::Shadow sh{0, 10 * u_, 24 * u_, hex(0x000e2c, 0.3f)};
    ui_.brushClip(x, py, pw, ph, a(white, 0.95f), 170, 5, 4, u_, &sh);
  }
  listTop_ = py + 14 * u_; listH_ = ph - 50 * u_; listRight_ = x + pw - 6 * u_;
  ui_.pushClip(x, listTop_, pw, listH_);
  float rx = x + 26 * u_, rw = pw - 52 * u_, ry = listTop_ - scroll_, rowH = 40 * u_, fs = std::max(12.f, 13.5f * u_), sfs = std::max(11.f, 12.5f * u_);
  float colKb = rx + rw * 0.56f, colPad = rx + rw * 0.79f, cellW = rw * 0.2f, cellH = 28 * u_;
  // the controller family (the connected one, or pick one to preview)
  {
    bool foc = int(items_.size()) == focus_;
    if (foc) { ui_.rectGradient(rx - 12 * u_, ry, rw + 24 * u_, rowH + 10 * u_, a(blue, 0.09f), a(blue, 0)); ui_.rect(rx - 12 * u_, ry, 4 * u_, rowH + 10 * u_, red); }
    ui_.text(rx, ry + 6 * u_, fs, UiFont::BodySemi, blue, "Controller");
    ui_.text(rx, ry + 6 * u_ + fs * 1.25f, sfs * 0.9f, UiFont::BodySemi, blueDim, input_.padConnected() ? "Connected" : "None connected \xC2\xB7 preview");
    const char* fams[3] = {"Xbox", "PlayStation", "Switch"};
    float bx = rx + rw, segH = 28 * u_;
    std::vector<float> xs(4);
    float ws[3];
    for (int i = 2; i >= 0; i--) { ws[i] = ui_.textWidth(fams[i], sfs, UiFont::Body) + 20 * u_; bx -= ws[i] + 6 * u_; xs[size_t(i)] = bx; }
    xs[3] = rx + rw;
    for (int i = 0; i < 3; i++) {
      bool on = int(ctlFamily_) == i;
      if (on) ui_.roundRect(xs[size_t(i)], ry + 8 * u_, ws[i], segH, 5 * u_, blue); else ui_.roundRectStroke(xs[size_t(i)], ry + 8 * u_, ws[i], segH, 5 * u_, 2, blue);
      ui_.text(xs[size_t(i)] + ws[i] / 2, ry + 8 * u_ + (segH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::BodySemi, on ? white : blue, fams[i], UiAlign::Center);
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
  ui_.text(rx, ry, std::max(10.f, 10.5f * u_), UiFont::BodySemi, red, "ACTION");
  ui_.text(colKb, ry, std::max(10.f, 10.5f * u_), UiFont::BodySemi, red, "KEYBOARD");
  ui_.text(colPad, ry, std::max(10.f, 10.5f * u_), UiFont::BodySemi, red, "CONTROLLER");
  ry += 22 * u_;
  std::string lastG;
  for (size_t i = 0; i < kActionCount; i++) {
    const ActionInfo& ai = actionInfo(Action(i));
    if (lastG != ai.group) {
      lastG = ai.group;
      ry += 8 * u_;
      ui_.text(rx, ry, std::max(10.f, 11 * u_), UiFont::BodySemi, red, lastG == "MENUS" ? "MENUS & SCREENS" : lastG);
      ui_.rect(rx, ry + 20 * u_, rw, 2, a(blue, 0.18f));
      ry += 26 * u_;
    }
    bool foc = int(items_.size()) == focus_;
    if (foc) { ui_.rectGradient(rx - 12 * u_, ry, rw + 24 * u_, rowH, a(blue, 0.09f), a(blue, 0)); ui_.rect(rx - 12 * u_, ry, 4 * u_, rowH, red); }
    ui_.textFit(rx, ry + (rowH - ui_.lineHeight(fs, UiFont::Body)) / 2, colKb - rx - 10 * u_, fs, UiFont::BodySemi, blue, ai.label);
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
      if (shape) ui_.kc(cx + cellW / 2 - ui_.kcWidth(u_, lbl) / 2, by + (cellH - ui_.kcHeight(u_)) / 2, u_, lbl, sel ? white : blue, vec4(0), sel ? white : hex(0x1546c8, 0.42f));
      else ui_.textFit(cx + cellW / 2, by + (cellH - ui_.lineHeight(sfs, UiFont::Body)) / 2, cellW - 8 * u_, sfs, UiFont::BodySemi, col, lbl, UiAlign::Center);
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
    ui_.text(rx, ry + (rowH - ui_.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::BodySemi, blue, "Defaults");
    const char* lb[2] = {"Reset keyboard", "Reset controller"};
    float bw[2] = {ui_.textWidth(lb[0], sfs, UiFont::Body) + 20 * u_, ui_.textWidth(lb[1], sfs, UiFont::Body) + 20 * u_};
    float bx1 = rx + rw - bw[1], bx0 = bx1 - 6 * u_ - bw[0];
    for (int c = 0; c < 2; c++) {
      float bx = c == 0 ? bx0 : bx1;
      bool sel = foc && ctlCol_ == c;
      if (sel) ui_.roundRect(bx, ry + 6 * u_, bw[c], cellH, 5 * u_, blue); else ui_.roundRectStroke(bx, ry + 6 * u_, bw[c], cellH, 5 * u_, 2, blue);
      ui_.text(bx + bw[c] / 2, ry + 6 * u_ + (cellH - ui_.lineHeight(sfs, UiFont::Body)) / 2, sfs, UiFont::BodySemi, sel ? white : blue, lb[c], UiAlign::Center);
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
  drawScrollbar();
  if (focusScroll_ && focus_ >= 0 && focus_ < int(items_.size())) {
    focusScroll_ = false;
    const Item& f = items_[size_t(focus_)];
    float top = f.y + scroll_ - listTop_;
    if (top < scrollTarget_) scrollTarget_ = std::max(0.f, top - 50 * u_);
    else if (top + f.h > scrollTarget_ + listH_) scrollTarget_ = std::min(std::max(0.f, contentH_ - listH_), top + f.h - listH_ + 20 * u_);
  }
  if (!ctlStatus_.empty()) ui_.text(rx, py + ph - 30 * u_, sfs, UiFont::BodySemi, ctlStatusBad_ ? ko : blue, ctlStatus_);
  // the reference (what each control does), when there is room
  if (refW > 300 * u_) {
    float qx = x + pw + 22 * u_;
    {
      Ui::Shadow sh{0, 10 * u_, 24 * u_, hex(0x000e2c, 0.3f)};
      ui_.brushClip(qx, py, refW, ph, a(white, 0.95f), 171, 5, 4, u_, &sh);
    }
    float qy = py + 22 * u_, qx0 = qx + 24 * u_, qw = refW - 48 * u_;
    ui_.text(qx0, qy, std::max(10.f, 10.5f * u_), UiFont::BodySemi, red, "KEYBOARD");
    ui_.text(qx0 + qw * 0.3f, qy, std::max(10.f, 10.5f * u_), UiFont::BodySemi, red, prompts::familyName(ctlFamily_));
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
    float kh = ui_.kcHeight(u_);
    ui_.pushClip(qx, py + 10 * u_, refW, ph - 20 * u_);
    for (const Ref& r : refs) {
      if (r.group) { qy += 6 * u_; ui_.text(qx0, qy, std::max(10.f, 10.5f * u_), UiFont::BodySemi, red, r.group); qy += 20 * u_; }
      std::string k = prompts::bindLabel(input_, r.a, false, ctlFamily_), p = prompts::bindLabel(input_, r.a, true, ctlFamily_);
      if (r.a == Action::Left) { k = prompts::keyLabel(input_.kb[size_t(Action::Left)]) + " " + prompts::keyLabel(input_.kb[size_t(Action::Right)]); p = "L STICK"; }
      ui_.kc(qx0, qy, u_, k, blue, ice, hex(0x1546c8, 0.42f));
      ui_.kc(qx0 + qw * 0.3f, qy, u_, p, blue, ice, hex(0x1546c8, 0.42f));
      ui_.textFit(qx0 + qw * 0.58f, qy + (kh - ui_.lineHeight(sfs, UiFont::Body)) / 2, qw * 0.42f, sfs, UiFont::BodySemi, blue, r.what);
      qy += kh + 7 * u_;
    }
    ui_.popClip();
  }
  drawHints({{"updown", "Select"}, {"leftright", "Keyboard / controller"}, {"enter", "Change"}, {"esc", "Back"}});
}

// ---------------------------------------------------------------- the card dialog
void Menus::scrDialog() {
  // hud.js dialog + travel.css (the card dialog): over the .modal shade, centred: the kicker, the title stroke
  // (brushSVG(len * 7 + 3, w, 100)), the line, the option cards (262u x 196u paper, brushClip(60 + 5 i, 6, 4)) and the
  // secondary buttons with the key hints. Long lists (a shop's racks, tabs, colours) stack as wide rows (#panel.talk).
  const float d = ui_.dpr(), W = float(ui_.width()), H = float(ui_.height());
  const float txs = std::max(11 * d, 11 * u_), tsm = std::max(12 * d, 13 * u_), sayS = std::max(14 * d, 17 * u_);
  // .modal: linear-gradient(90deg, rgba(4,14,34,.78) 0%, .55 55%, .35 100%)
  ui_.gradientGrid(0, 0, W, H, 16, 1, [](float fx, float) {
    float al = fx < 0.55f ? 0.78f + (0.55f - 0.78f) * fx / 0.55f : 0.55f + (0.35f - 0.55f) * (fx - 0.55f) / 0.45f;
    return vec4(0.016f, 0.055f, 0.133f, al);
  });
  std::vector<size_t> main, second;
  bool swatches = false;
  for (size_t i = 0; i < dialog_.options.size(); i++) { (dialog_.options[i].secondary ? second : main).push_back(i); swatches |= dialog_.options[i].swatch != 0; }
  bool cards = dialog_.tabs.empty() && !swatches && main.size() <= 4;
  float hostW = std::min(900 * u_, W * 0.94f), x = (W - hostW) / 2 + 8 * u_, cw = hostW - 16 * u_;
  // -- heights first (the block is centred vertically)
  std::string title = upper(dialog_.title);
  float tvw = std::max(220.f, std::round(float(title.size()) * 26 + 110)), tW = std::round(tvw * 0.92f) * u_, tH = 96 * u_;
  float kickH = dialog_.kicker.empty() ? 0 : txs + 6 * u_;
  // the line (wrapped to 720u)
  float sayW = std::min(720 * u_, cw - 14 * u_);
  float sayH = 0;
  if (!dialog_.say.empty()) {
    int n = 1;
    std::string line, word;
    for (size_t i = 0; i <= dialog_.say.size(); i++) {
      char ch = i < dialog_.say.size() ? dialog_.say[i] : ' ';
      if (ch == '\n') { n++; line.clear(); continue; }
      if (ch != ' ') { word += ch; continue; }
      if (word.empty()) continue;
      std::string cand = line.empty() ? word : line + " " + word;
      if (!line.empty() && ui_.textWidth(cand, sayS, UiFont::BodyMed) > sayW) { n++; line = word; } else line = cand;
      word.clear();
    }
    sayH = 10 * u_ + sayS * 1.45f * float(n) + 22 * u_;
  } else sayH = 10 * u_;
  float tabsH = dialog_.tabs.empty() ? 0 : 54 * u_ + 18 * u_;
  float cardW = 262 * u_, cardH = 196 * u_, gap = 22 * u_, rowH = 74 * u_, rowGap = 10 * u_;
  int perRow = std::max(1, int((cw - 10 * u_ + gap) / (cardW + gap)));
  float listFull = cards ? float((int(main.size()) + perRow - 1) / perRow) * (cardH + gap) - gap : float(main.size()) * (rowH + rowGap) - rowGap;
  float footH = 26 * u_ + 54 * u_;
  float maxList = std::max(rowH, H - 2 * 40 * u_ - (kickH + tH + sayH + tabsH + footH) - 20 * u_);
  float listVis = std::min(listFull, maxList);
  float total = 10 * u_ + kickH + tH + sayH + tabsH + listVis + footH + 10 * u_;
  float y = std::max(20 * u_, (H - total) / 2) + 10 * u_;
  // -- the kicker, the title, the line
  if (!dialog_.kicker.empty()) {
    ui_.rect(x + 14 * u_, y + txs / 2 - 2 * u_, 22 * u_, 4 * u_, red);
    std::string k = upper(dialog_.kicker);
    ui_.textShadow(x + 46 * u_, y, txs, UiFont::BodyHeavy, k, UiAlign::Left, 0.2f, 0, d, 6 * d, hex(0x000a1e, 0.55f));
    ui_.textLH(x + 46 * u_, y, txs, txs, UiFont::BodyHeavy, white, k, UiAlign::Left, 0.2f);
    y += kickH;
  }
  {
    Ui::Shadow sh{0, 6 * u_, 14 * u_, a(hex(0x000000), 0.28f)};
    ui_.brushStroke(x, y, tW, tH, white, int(dialog_.title.size()) * 7 + 3, tvw, 100, &sh);
    ui_.textLH(x + 40 * u_, y, tH, 50 * u_, UiFont::CondItalic, blue, title, UiAlign::Left, 0.03f);
    y += tH;
  }
  if (!dialog_.say.empty()) {
    // (wrapped to 720u, line-height 1.45, text-shadow 0 1px 8px rgba(0, 10, 30, .6))
    std::vector<std::string> lines;
    std::string line, word;
    for (size_t i = 0; i <= dialog_.say.size(); i++) {
      char ch = i < dialog_.say.size() ? dialog_.say[i] : ' ';
      if (ch == '\n') { if (!word.empty()) { line += (line.empty() ? "" : " ") + word; word.clear(); } lines.push_back(line); line.clear(); continue; }
      if (ch != ' ') { word += ch; continue; }
      if (word.empty()) continue;
      std::string cand = line.empty() ? word : line + " " + word;
      if (!line.empty() && ui_.textWidth(cand, sayS, UiFont::BodyMed) > sayW) { lines.push_back(line); line = word; } else line = cand;
      word.clear();
    }
    if (!line.empty()) lines.push_back(line);
    float ly = y + 10 * u_;
    for (auto& l : lines) {
      float ty = ly + (sayS * 1.45f - ui_.lineHeight(sayS, UiFont::BodyMed)) / 2;
      ui_.textShadow(x + 14 * u_, ty, sayS, UiFont::BodyMed, l, UiAlign::Left, 0, 0, d, 8 * d, hex(0x000a1e, 0.6f));
      ui_.text(x + 14 * u_, ty, sayS, UiFont::BodyMed, white, l);
      ly += sayS * 1.45f;
    }
    y += sayH;
  } else y += sayH;
  // -- tabs (the outfit racks): the .seg-brush switch, Q / E
  if (!dialog_.tabs.empty()) {
    float bx = x + 10 * u_;
    for (size_t i = 0; i < dialog_.tabs.size(); i++) {
      std::string t = upper(dialog_.tabs[i]);
      float bw = ui_.textWidth(t, 26 * u_, UiFont::CondItalic, 0.05f) + 52 * u_;
      bool on = int(i) == dialog_.tab;
      ui_.brushPanel(bx, y, bw, 54 * u_, on ? blue : a(white, 0.88f), 1);
      ui_.textLH(bx + bw / 2, y, 54 * u_, 26 * u_, UiFont::CondItalic, on ? white : blue, t, UiAlign::Center, 0.05f);
      bx += bw + 8 * u_;
    }
    std::string tcap = input_.usingGamepad() ? std::string(prompts::padGlyph(4, input_.padFamily())) + " " + prompts::padGlyph(5, input_.padFamily()) : "Q E";
    ui_.kc(bx + 10 * u_, y + 27 * u_ - ui_.kcHeight(u_) / 2, u_, tcap, a(white, 0.88f), vec4(0), a(white, 0.7f));
    y += tabsH;
  }
  // -- the options
  listTop_ = y - 12 * u_; listH_ = listVis + 24 * u_; listRight_ = x + cw; contentH_ = listFull + 24 * u_;
  ui_.pushClip(0, listTop_, W, listH_);
  auto choose = [this](size_t oi) {
    DialogOption o = dialog_.options[oi];
    if (o.disabled) return;
    bool keep = dialog_.keepOpen && !o.secondary;
    if (!keep) close();
    if (o.act) o.act();
    if (keep && screen_ == Screen::Dialog && dialog_.rebuild) dialog_.rebuild(dialog_);
  };
  const vec4 kcBorder = hex(0x1546c8, 0.35f);
  for (size_t n = 0; n < main.size(); n++) {
    size_t k = main[n];
    const DialogOption& o = dialog_.options[k];
    bool foc = int(items_.size()) == focus_;
    float ox, oy, ow, oh;
    if (cards) { ox = x + 10 * u_ + float(int(n) % perRow) * (cardW + gap); oy = y + float(int(n) / perRow) * (cardH + gap) - scroll_; ow = cardW; oh = cardH; }
    else { ox = x; oy = y + float(n) * (rowH + rowGap) - scroll_; ow = cw; oh = rowH; }
    Item it;
    it.x = ox; it.y = oy; it.w = ow; it.h = oh; it.label = o.label; it.inList = true;
    it.activate = [choose, k] { choose(k); };
    items_.push_back(it);
    if (oy + oh < listTop_ - 40 * u_ || oy > listTop_ + listH_ + 40 * u_) continue;
    // riseIn: 0.5 s after 80 + 60 n ms (from 30u below, faded); focused: lifted 10u (a row: 8u right)
    float e = float(std::clamp((t_ - enterT_ - 0.08 - 0.06 * double(n)) / 0.5, 0.0, 1.0));
    e = 1 - std::pow(1 - e, 4.f);
    float dx = !cards && foc ? 8 * u_ : 0, dy = (cards && foc ? -10 * u_ : 0) + 30 * u_ * (1 - e);
    ui_.pushAlpha(e);
    ui_.pushTranslate(dx, dy);
    Ui::Shadow sh = o.disabled ? Ui::Shadow{0, 8 * u_, 16 * u_, hex(0x000e2c, 0.3f)} : foc ? Ui::Shadow{0, 20 * u_, 32 * u_, hex(0x000e2c, 0.5f)} : Ui::Shadow{0, 12 * u_, 24 * u_, hex(0x000e2c, 0.38f)};
    ui_.brushClip(ox, oy, ow, oh, a(white, o.disabled ? 0.72f : 1.f), 60 + int(k) * 5, 6, 4, u_, &sh);
    float ta = o.disabled ? 0.55f : 1.f;
    // the chip: a price ($ small and red) or a state (a brush-b chip)
    std::string state = upper(o.state);
    int64_t price = o.price;
    if (price == 0 && state.empty()) { state = "FREE"; price = -1; }
    bool shortMoney = o.disabled && state.empty() && price > 0 && save_.money < price;
    std::string num = (price > 0 && state.empty()) ? fmtMoney(price) : "";
    float priceS = (cards ? 40 : 30) * u_;
    auto drawFoot = [&](float fx, float fy, float fh) {   // fy: the foot line's top, fh its height; returns the width
      float w = 0;
      if (!num.empty()) {
        float base = fy + fh / 2 + priceS * 0.36f;
        float s1 = priceS * 0.55f, wd = ui_.textWidth("$", s1, UiFont::CondItalic, 0.01f);
        auto top = [&](float size) { return base - ui_.ascent(UiFont::CondItalic) * size - (ui_.lineHeight(size, UiFont::CondItalic) - (ui_.ascent(UiFont::CondItalic) - ui_.descent(UiFont::CondItalic)) * size) * 0.5f; };
        ui_.text(fx, top(s1), s1, UiFont::CondItalic, a(red, ta), "$", UiAlign::Left, 0.01f);
        w = wd + priceS * 0.08f;
        w += ui_.text(fx + w, top(priceS), priceS, UiFont::CondItalic, a(blue, ta), num, UiAlign::Left, 0.01f);
      } else if (!state.empty()) {
        float cs = 20 * u_, chW = ui_.textWidth(state, cs, UiFont::CondItalic, 0.08f) + 28 * u_, chH = cs + 10 * u_;
        ui_.brushPanel(fx, fy + (fh - chH) / 2, chW, chH, state == "FREE" ? ok : blue, 1);
        ui_.textLH(fx + 12 * u_, fy + (fh - chH) / 2, chH, cs, UiFont::CondItalic, white, state, UiAlign::Left, 0.08f);
        w = chW;
      }
      if (shortMoney) {
        std::string note = "YOU HAVE $" + fmtMoney(save_.money);
        ui_.textLH(fx + w + (w > 0 ? 12 * u_ : 0), fy + (fh - txs * 1.2f) / 2, txs * 1.2f, txs, UiFont::BodyHeavy, ko, note, UiAlign::Left, 0.12f);
      }
      return w;
    };
    std::string kcl = std::to_string(n + 1);
    if (cards) {
      if (!input_.usingGamepad()) ui_.kc(ox + ow - 22 * u_ - ui_.kcWidth(u_, kcl), oy + 18 * u_, u_, kcl, blueDim, vec4(0), kcBorder);
      float ty = oy + 20 * u_ + 14 * u_;
      float avail = ow - 52 * u_ - 26 * u_;
      ui_.textFit(ox + 26 * u_, ty, avail, 36 * u_, UiFont::CondItalic, a(blue, ta), upper(o.label), UiAlign::Left, 0.02f);
      ty += 36 * u_ * 1.2f;
      if (!o.sub.empty()) {
        std::string sub = o.sub;
        sub[0] = char(std::toupper(static_cast<unsigned char>(sub[0])));
        ui_.textWrapped(ox + 26 * u_, ty + 8 * u_ + tsm * 0.1f, ow - 52 * u_, tsm, UiFont::BodyMed, a(blueDim, ta), sub, 1.4f);
      }
      float fh = std::max(40 * u_, txs * 1.2f);
      drawFoot(ox + 26 * u_, oy + oh - 24 * u_ - fh, fh);
      ui_.rect(ox + 26 * u_, oy + oh - 12 * u_ - 4 * u_, (foc ? 90 : 30) * u_, 4 * u_, o.disabled ? hex(0x1546c8, 0.25f) : red);
    } else {
      float px = ox + 24 * u_;
      if (!input_.usingGamepad() && n < 9) px += ui_.kc(px, oy + (oh - ui_.kcHeight(u_)) / 2, u_, kcl, blueDim, vec4(0), kcBorder) + 14 * u_;
      if (o.swatch) {
        float sw = 36 * u_, sy = oy + (oh - sw) / 2;
        ui_.roundRect(px, sy, sw, sw, 6 * u_, hex(o.swatch, ta));
        if (o.swatch2 && o.swatch2 != o.swatch) ui_.tri(vec2(px + sw, sy), vec2(px + sw, sy + sw), vec2(px, sy + sw), hex(o.swatch2, ta));
        px += sw + 14 * u_;
      }
      // the foot on the right
      float footW = 0;
      {
        float s1 = priceS * 0.55f;
        if (!num.empty()) footW = ui_.textWidth("$", s1, UiFont::CondItalic, 0.01f) + priceS * 0.08f + ui_.textWidth(num, priceS, UiFont::CondItalic, 0.01f);
        else if (!state.empty()) footW = ui_.textWidth(state, 20 * u_, UiFont::CondItalic, 0.08f) + 28 * u_;
        if (shortMoney) footW += 12 * u_ + ui_.textWidth("YOU HAVE $" + fmtMoney(save_.money), txs, UiFont::BodyHeavy, 0.12f);
      }
      float fx = ox + ow - 24 * u_ - footW;
      drawFoot(fx, oy, oh);
      float avail = fx - 14 * u_ - px;
      float titleS = 28 * u_;
      if (o.sub.empty()) ui_.textFit(px, oy + (oh - ui_.lineHeight(titleS, UiFont::CondItalic)) / 2, avail, titleS, UiFont::CondItalic, a(blue, ta), upper(o.label), UiAlign::Left, 0.02f);
      else {
        float blockH = titleS + 4 * u_ + tsm * 1.4f, by = oy + (oh - blockH) / 2;
        ui_.textFit(px, by - titleS * 0.1f, avail, titleS, UiFont::CondItalic, a(blue, ta), upper(o.label), UiAlign::Left, 0.02f);
        std::string sub = o.sub;
        sub[0] = char(std::toupper(static_cast<unsigned char>(sub[0])));
        ui_.textFit(px, by + titleS + 4 * u_ + tsm * 0.1f, avail, tsm, UiFont::BodyMed, a(blueDim, ta), sub);
      }
    }
    ui_.popTransform();
    ui_.popAlpha();
  }
  ui_.popClip();
  drawScrollbar();
  if (focusScroll_ && focus_ >= 0 && focus_ < int(items_.size())) {
    focusScroll_ = false;
    const Item& f = items_[size_t(focus_)];
    float top = f.y + scroll_ - listTop_;
    if (top < scrollTarget_) scrollTarget_ = std::max(0.f, top - 12 * u_);
    else if (top + f.h > scrollTarget_ + listH_) scrollTarget_ = std::min(std::max(0.f, contentH_ - listH_), top + f.h - listH_ + 12 * u_);
  }
  // -- the foot: the secondary buttons (.dlg-sec) and the key hints
  float fy = listTop_ + listH_ - 12 * u_ + 26 * u_, fx = x + 12 * u_;
  for (size_t k : second) {
    const DialogOption& o = dialog_.options[k];
    bool foc = int(items_.size()) == focus_;
    std::string l = upper(o.label);
    float bw = ui_.textWidth(l, 26 * u_, UiFont::CondItalic, 0.05f) + 58 * u_, bh = 54 * u_;
    float dx = foc ? 8 * u_ : 0;
    if (foc) ui_.rect(fx - 12 * u_ + dx, fy + bh * 0.3f, 5 * u_, bh * 0.4f, red);
    Ui::Shadow sh{0, 6 * u_, 12 * u_, a(hex(0x000000), 0.25f)};
    ui_.brushPanel(fx + dx, fy, bw, bh, white, 1, &sh);
    ui_.textLH(fx + dx + 24 * u_, fy, bh, 26 * u_, UiFont::CondItalic, a(blue, o.disabled ? 0.55f : 1.f), l, UiAlign::Left, 0.05f);
    Item it;
    it.x = fx; it.y = fy; it.w = bw; it.h = bh; it.label = o.label; it.disabled = o.disabled;
    it.activate = [choose, k] { choose(k); };
    items_.push_back(it);
    fx += bw + 18 * u_;
  }
  {
    // .dlg-hints: 600 t-xs, white .88, the caps outlined in white .7
    const vec4 col = a(white, 0.88f), bc = a(white, 0.7f), shc = a(hex(0x000000), 0.5f);
    float kh = ui_.kcHeight(u_), cy = fy + 27 * u_, ty = cy - ui_.lineHeight(txs, UiFont::BodySemi) / 2;
    float gap6 = std::max(4 * d, 6 * u_);
    std::vector<std::pair<std::vector<std::string>, std::string>> hs;
    bool pad = input_.usingGamepad();
    if (main.size() > 1) hs.push_back({pad ? std::vector<std::string>{prompts::K(input_, "leftright")} : std::vector<std::string>{"\xE2\x86\x90", "\xE2\x86\x92"}, "CHOOSE"});
    if (!dialog_.tabs.empty()) hs.push_back({{pad ? std::string(prompts::padGlyph(4, input_.padFamily())) + " " + prompts::padGlyph(5, input_.padFamily()) : "Q E"}, "TABS"});
    if (!main.empty()) hs.push_back({{prompts::K(input_, "confirm")}, "SELECT"});
    hs.push_back({{prompts::K(input_, "cancel")}, "CLOSE"});
    for (auto& [caps, label] : hs) {
      for (size_t i = 0; i < caps.size(); i++) fx += ui_.kc(fx, cy - kh / 2, u_, caps[i], col, vec4(0), bc) + (i + 1 < caps.size() ? 4 * u_ : gap6);
      ui_.textShadow(fx, ty, txs, UiFont::BodySemi, label, UiAlign::Left, 0.1f, 0, d, 6 * d, shc);
      fx += ui_.text(fx, ty, txs, UiFont::BodySemi, col, label, UiAlign::Left, 0.1f) + 20 * u_;
    }
  }
}

void Menus::scrConfirm() {
  drawShade(1);
  drawLogo(false);
  float x = 72 * u_, y = 226 * u_;
  heading(x, y, "ARE YOU SURE?", confirmText_);
  y += 190 * u_;
  button(x, y, 300 * u_, 74 * u_, 34 * u_, "NO, KEEP IT", 13, [this] { open(confirmBack_, -1); });
  y += 84 * u_;
  button(x, y, 300 * u_, 74 * u_, 34 * u_, "YES, RESET", 29, [this] { auto f = confirmYes_; if (f) f(); });
  drawHints({{"updown", "Select"}, {"enter", "Confirm"}, {"esc", "Back"}});
}

} // namespace sl
