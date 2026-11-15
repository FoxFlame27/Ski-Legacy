// "Admin · new" (ui/adminnew.js) and the free camera (ui/admin.js): see adminpanel.h.
#include "game/adminpanel.h"
#include "core/log.h"
#include "core/prompts.h"
#include "game/weather.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>

namespace sl {
using namespace ui_color;
using Json = nlohmann::json;
using platform::Key;

namespace {
const char* ADMIN_NAME = "icey27";   // (the name key; the server's ADMIN_KEYS is what counts in multiplayer)
std::string lower(std::string s) { for (char& c : s) c = char(std::tolower(static_cast<unsigned char>(c))); return s; }
std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t"), b = s.find_last_not_of(" \t");
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}
std::string upper(std::string s) { for (char& c : s) c = char(std::toupper(static_cast<unsigned char>(c))); return s; }
std::string thousands(int64_t v) {
  std::string d = std::to_string(v < 0 ? -v : v), out;
  for (size_t i = 0; i < d.size(); i++) { if (i && (d.size() - i) % 3 == 0) out += ','; out += d[i]; }
  return out;
}
/// adminnew.js money(): "-$1,234" / "$1,234"
std::string money(int64_t v) { return std::string(v < 0 ? "-" : "") + "$" + thousands(v); }
std::string hhmm(double h) {
  char b[16];
  std::snprintf(b, sizeof b, "%02d:%02d", int(std::floor(h)), int(std::floor(std::fmod(h, 1.0) * 60)));
  return b;
}
/// adminnew.js ERR: the server's refusals in words
std::string errText(const std::string& code) {
  static const std::pair<const char*, const char*> E[] = {
    {"forbidden", "not allowed (Icey27 only)"}, {"rate", "too fast, wait a moment"}, {"no_player", "no player by that name"},
    {"not_online", "not online"}, {"self", "not on yourself"}, {"other_world", "in another world"}, {"no_position", "no position yet"},
    {"inside", "inside a building"}, {"bad_amount", "bad amount"}, {"bad_value", "bad value"}, {"confirm", "type the name again to confirm"},
    {"bad_op", "the server needs an update"}, {"unknown_type", "the server needs an update"}};
  for (auto& e : E) if (code == e.first) return e.second;
  return code.empty() ? "refused" : code;
}
int64_t digitsOf(const std::string& s) {
  int64_t v = 0; bool any = false;
  for (char c : s) if (c >= '0' && c <= '9') { any = true; if (v < 100000000000LL) v = v * 10 + (c - '0'); }
  return any ? v : 0;
}
} // namespace

bool AdminPanel::allowed() const {
  const std::string n = h_.account ? lower(trim(h_.account())) : std::string();
  return !n.empty() && n == ADMIN_NAME;
}
std::string AdminPanel::me() const {
  std::string n = h_.account ? trim(h_.account()) : std::string();
  return n.empty() ? "Icey27" : n;
}

// ------------------------------------------------------------------ open / close
void AdminPanel::gameKeys(const platform::Events& ev, bool canOpen) {
  if (!allowed()) return;   // (anyone else: nothing at all)
  const bool ctrl = plat_.keyDown(Key::ControlLeft) || plat_.keyDown(Key::ControlRight);
  const bool shift = plat_.keyDown(Key::ShiftLeft) || plat_.keyDown(Key::ShiftRight);
  const bool alt = plat_.keyDown(Key::AltLeft) || plat_.keyDown(Key::AltRight) || plat_.keyDown(Key::MetaLeft) || plat_.keyDown(Key::MetaRight);
  for (Key k : ev.pressed) {
    if (k == Key::F10 || (k == Key::KeyA && ctrl && shift)) { if (canOpen) toggle(); return; }
    // V: the free camera (V is free in the game; not while racing / in a menu: canOpen)
    if (k == Key::KeyV && !ctrl && !shift && !alt && canOpen) { camStart(); return; }
  }
}

void AdminPanel::toggle() {
  if (isOpen()) { close(); return; }
  if (fly_.on) { camOff(); open(); return; }   // (F10 while the free camera is on: back to the panel)
  open();
}

bool AdminPanel::open() {
  if (isOpen() || !allowed()) return false;
  confirming_ = false;
  openT_ = 0; plT_ = 0;
  places_ = h_.places ? h_.places() : std::vector<AdminHost::Place>{};
  scrollToFocus_ = true;
  for (int i = 0; i < 3; i++) scroll_[i] = scrollT_[i] = 0;
  items_.clear();
  focusKey_.clear();
  dragging_ = false;
  menus_.openCustom([this](const UiNav& nav, double dt, double now) { frame(nav, dt, now); }, "adminnew");
  if (h_.relativeMouse) h_.relativeMouse(false);
  if (h_.sound) h_.sound("click");
  refreshPlayers();
  return true;
}

void AdminPanel::close() {
  if (!isOpen()) return;
  menus_.close();
  focusField_ = -1;
  if (h_.relativeMouse) h_.relativeMouse(true);
}

// ------------------------------------------------------------------ the server
void AdminPanel::serverError(const std::string& op, const std::string& code) { say(op + " \xC2\xB7 " + errText(code), true); }

void AdminPanel::say(const std::string& text, bool bad) {
  result_ = text; resultBad_ = bad;
  if (bad && h_.sound) h_.sound("error");
}

std::string AdminPanel::name() { return trim(fields_[F_NAME]); }

void AdminPanel::refreshPlayers() {
  if (!h_.online || !h_.online() || !h_.op) { players_.clear(); return; }
  h_.op("players", Json::object(), [this](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError("players", err); return; }
    players_.clear();
    if (d.contains("players") && d["players"].is_array())
      for (const Json& p : d["players"]) {
        if (!p.is_object()) continue;
        Player q;
        q.name = p.value("name", std::string());
        q.money = p.contains("money") && p["money"].is_number() ? p["money"].get<int64_t>() : 0;
        if (p.contains("pos") && p["pos"].is_array() && p["pos"].size() >= 3) { q.hasPos = true; q.x = p["pos"][0].get<double>(); q.z = p["pos"][2].get<double>(); }
        q.jailed = p.value("jailed", false); q.wanted = p.value("wanted", false); q.impound = p.value("impound", false);
        q.inside = p.contains("inside") && !p["inside"].is_null() && !(p["inside"].is_string() && p["inside"].get<std::string>().empty());
        players_.push_back(q);
      }
  });
}

// ------------------------------------------------------------------ actions
void AdminPanel::give(int sign) {
  const int64_t raw = digitsOf(fields_[F_AMOUNT]);
  if (raw <= 0) { say("Enter an amount", true); return; }
  const int64_t amount = sign * std::min<int64_t>(10000000, raw);
  if (!h_.online || !h_.online()) {   // (single player: your own money)
    const int64_t m = h_.money ? h_.money() : 0, v = std::max(std::min<int64_t>(m, 0), std::min<int64_t>(99999999, m + amount)), delta = v - m;
    if (h_.addMoney) h_.addMoney(delta);
    if (h_.sound) h_.sound("cash");
    say(std::string(delta >= 0 ? "Gave " : "Took ") + money(delta < 0 ? -delta : delta) + " \xC2\xB7 you have " + money(v));
    return;
  }
  std::string n = name();
  if (n.empty()) n = me();
  h_.op("give", Json{{"name", n}, {"amount", amount}}, [this](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError("give", err); return; }
    if (h_.sound) h_.sound("cash");
    const int64_t delta = d.value("delta", int64_t(0)), bal = d.value("balance", int64_t(0));
    say(std::string(delta >= 0 ? "Gave " : "Took ") + money(delta < 0 ? -delta : delta) + (delta >= 0 ? " to " : " from ") + d.value("name", std::string("?")) +
        " \xC2\xB7 now " + money(bal) + (d.value("online", false) ? "" : " (offline)"));
    refreshPlayers();
  });
}

void AdminPanel::giveAll(int sign) {
  const int64_t raw = digitsOf(fields_[F_ALL]);
  if (raw <= 0) { say("Enter an amount for everyone", true); return; }
  h_.op("giveAll", Json{{"amount", sign * std::min<int64_t>(10000000, raw)}, {"offline", offline_}}, [this, sign, raw](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError("giveAll", err); return; }
    if (h_.sound) h_.sound("cash");
    const int n = d.value("n", 0), off = d.value("offline", 0);
    say(std::string(sign > 0 ? "Gave " : "Took ") + money(raw) + (sign > 0 ? " to " : " from ") + std::to_string(n) + " player" + (n == 1 ? "" : "s") + " online" +
        (off ? " and " + std::to_string(off) + " offline" : std::string()));
    refreshPlayers();
  });
}

void AdminPanel::setHour(double hr) {
  hr = std::fmod(std::fmod(hr, 24.0) + 24.0, 24.0);
  if (h_.setHour) h_.setHour(hr);
  if (!h_.online || !h_.online()) return;
  if (h_.clock) h_.clock(hr, "");   // (the sky follows at once; the server's 'clock' confirms it)
  pendingHour_ = hr;                // (sent at most every 250 ms: frame())
}

void AdminPanel::setWeather(int w) {
  if (w < 0 || w >= Weather::N) return;
  if (h_.setWeather) h_.setWeather(w);
  const std::string id = Weather::def(w).id, label = Weather::def(w).label;
  if (!h_.online || !h_.online()) { say("Weather \xC2\xB7 " + label); return; }
  if (h_.clock) h_.clock(-1, id);
  h_.op("weather", Json{{"w", id}}, [this, label](bool ok, const Json&, const std::string& err) {
    if (!ok) { serverError("weather", err); return; }
    say("Weather \xC2\xB7 " + label + " for everyone in your world (5 min)");
  });
}

void AdminPanel::release(const std::string& what) {
  const std::string label = what == "jail" ? "out of prison" : what == "chase" ? "chase called off" : "car out of the tow yard";
  if (!h_.online || !h_.online()) {
    const bool done = h_.releaseLocal && h_.releaseLocal(what);
    say(done ? "You \xC2\xB7 " + label : "Nothing to release", !done);
    return;
  }
  const std::string n = name();
  if (n.empty()) { say("Type or pick a player name first", true); return; }
  h_.op("release", Json{{"name", n}, {"what", what}}, [this, label](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError("release", err); return; }
    say(d.value("name", std::string("?")) + " \xC2\xB7 " + label + (d.value("was", false) ? "" : " (there was nothing to release)") + (d.value("online", false) ? "" : " (offline)"));
    refreshPlayers();
  });
}

void AdminPanel::kick() {
  const std::string n = name();
  if (n.empty()) { say("Type or pick a player name first", true); return; }
  h_.op("kick", Json{{"name", n}}, [this](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError("kick", err); return; }
    say(d.value("kicked", std::string("?")) + " was kicked");
    refreshPlayers();
  });
}

void AdminPanel::reset() {
  const std::string n = name();
  if (n.empty()) { say("Type or pick a player name first", true); return; }
  if (!confirming_) { confirming_ = true; fields_[F_CONFIRM].clear(); focusKey_ = "f:confirm"; scrollToFocus_ = true; return; }
  const std::string confirm = fields_[F_CONFIRM];
  confirming_ = false;
  focusKey_ = "reset";
  h_.op("reset", Json{{"name", n}, {"confirm", confirm}}, [this](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError("reset", err); return; }
    say(d.value("name", std::string("?")) + "'s progress was reset" + (d.value("online", false) ? " (kicked: they start fresh when they join)" : ""));
    refreshPlayers();
  });
}

void AdminPanel::broadcast() {
  const std::string text = trim(fields_[F_MSG]);
  if (text.empty()) { say("Type a message first", true); return; }
  h_.op("say", Json{{"text", text}}, [this](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError("say", err); return; }
    fields_[F_MSG].clear();
    const int n = d.value("n", 0);
    say("Message sent to " + std::to_string(n) + " player" + (n == 1 ? "" : "s"));
  });
}

void AdminPanel::tpPlayer(const std::string& who, bool here) {
  h_.op(here ? "tpHere" : "tpTo", Json{{"name", who}}, [this, here](bool ok, const Json& d, const std::string& err) {
    if (!ok) { serverError(here ? "tpHere" : "tpTo", err); return; }
    if (here) { say(d.value("moved", std::string("?")) + " is on the way to you"); return; }
    const double yaw = d.value("yaw", 0.0), off = 1.8;
    AdminHost::Place p{"Next to " + d.value("to", std::string("?")), "", d.value("x", 0.0) - std::sin(yaw) * off, d.value("z", 0.0) - std::cos(yaw) * off, yaw};
    teleport(p);
  });
}

void AdminPanel::teleport(const AdminHost::Place& p) {
  const std::string why = h_.teleportRefusal ? h_.teleportRefusal() : std::string();
  if (!why.empty()) { say(why, true); return; }
  close();
  if (h_.teleport) h_.teleport(p.x, p.z, p.heading, p.label + (p.sub.empty() ? "" : " \xC2\xB7 " + p.sub));
  if (h_.online && h_.online() && h_.op) h_.op("tp", Json{{"x", p.x}, {"z", p.z}, {"label", p.label.substr(0, 60)}}, [](bool, const Json&, const std::string&) {});   // (logged)
}

void AdminPanel::act(const std::string& a) {
  if (h_.sound) h_.sound("click");
  if (a == "give") return give(1);
  if (a == "take") return give(-1);
  if (a == "giveall") return giveAll(1);
  if (a == "takeall") return giveAll(-1);
  if (a == "offline") { offline_ = !offline_; return; }
  if (a == "cam") { if (fly_.on) camOff("Free camera off"); else camStart(); return; }
  if (a.rfind("rel:", 0) == 0) return release(a.substr(4));
  if (a == "kick") return kick();
  if (a == "reset") return reset();
  if (a == "noreset") { confirming_ = false; focusKey_ = "reset"; return; }
  if (a == "say") return broadcast();
  if (a.rfind("h:", 0) == 0) return setHour(std::atof(a.c_str() + 2));
  if (a.rfind("w:", 0) == 0) return setWeather(std::atoi(a.c_str() + 2));
}

// ------------------------------------------------------------------ the free camera (admin.js startFly / update)
bool AdminPanel::camStart() {
  if (!allowed() || fly_.on) return false;
  const std::string why = h_.camRefusal ? h_.camRefusal() : std::string();
  if (!why.empty()) { if (h_.flash) h_.flash(why, 1); say(why, true); return false; }
  flyFromPanel_ = isOpen();
  if (isOpen()) menus_.close();
  fly_.on = true;
  fly_.pos = camPos_;
  const vec3 f = glm::normalize(camFwd_);
  fly_.pitch = std::asin(std::clamp(f.y, -1.f, 1.f));
  fly_.yaw = std::atan2(-f.x, -f.z);
  // the game is blocked meanwhile (a screen of our own: the hint strip; it takes Esc / V / T)
  menus_.openCustom([this](const UiNav& nav, double, double) { camFrame(nav); }, "admincam");
  if (h_.relativeMouse) h_.relativeMouse(true);
  return true;
}

void AdminPanel::camOff(const std::string& msg) {
  if (!fly_.on) return;
  fly_.on = false;
  if (menus_.customOpen("admincam")) menus_.close();
  if (!msg.empty() && h_.flash) h_.flash(msg, 0);
  if (h_.relativeMouse) h_.relativeMouse(true);
}

void AdminPanel::camFrame(const UiNav& navIn) {
  const UiNav nav = inject_ ? injected_ : navIn;
  inject_ = false;
  u_ = ui_.cssU();
  if (!allowed()) { camOff("Free camera off \xC2\xB7 Icey27 only"); return; }
  bool back = false, off = false, drop = false, panel = false;
  const bool ctrl = plat_.keyDown(Key::ControlLeft) || plat_.keyDown(Key::ControlRight);
  const bool shift = plat_.keyDown(Key::ShiftLeft) || plat_.keyDown(Key::ShiftRight);
  for (Key k : nav.keys) {
    if (k == Key::Escape) back = true;
    else if (k == Key::KeyV) off = true;
    else if (k == Key::KeyT) drop = true;
    else if (k == Key::F10 || (k == Key::KeyA && ctrl && shift)) panel = true;
  }
  if (nav.usingPad && (nav.cancel || nav.menu)) back = true;   // (B / Menu: back)
  if (drop) {   // admin.js dropHere: your skier onto the snow under the camera, facing where you look
    const double x = fly_.pos.x, z = fly_.pos.z, head = fly_.yaw + PI;
    camOff();
    if (h_.drop) h_.drop(x, z, head);
    return;
  }
  if (off) { camOff("Free camera off"); return; }
  if (back || panel) { camOff(); open(); return; }
  // the hint strip at the bottom (admin.js flyHint): the device in use
  const float W = float(ui_.width()), H = float(ui_.height()), d = ui_.dpr();
  const float xs = std::max(11 * d, 11 * u_), sm = std::max(12 * d, 13 * u_);
  struct Part { std::vector<std::string> caps; std::string text; };
  std::vector<Part> parts;
  if (nav.usingPad) {
    parts = {{{prompts::K(in_, "move")}, "fly"}, {{prompts::K(in_, "jump"), prompts::K(in_, "pickup")}, "up \xC2\xB7 down"}, {{prompts::K(in_, "sprint")}, "fast"}, {{prompts::K(in_, "cancel")}, "back"}};
  } else {
    parts = {{{"W", "A", "S", "D"}, "fly"}, {{"SPACE", "C"}, "up \xC2\xB7 down"}, {{"SHIFT"}, "fast"}, {{"T"}, "drop here"}, {{"ESC"}, "back"}, {{"V"}, "off"}};
  }
  const float gap = 18 * u_, padX = 30 * u_, padY = 12 * u_, kh = ui_.kcHeight(u_);
  float w = ui_.textWidth("FREE CAMERA", xs, UiFont::BodyHeavy, 0.18f);
  for (const Part& p : parts) {
    w += gap;
    for (size_t i = 0; i < p.caps.size(); i++) w += ui_.kcWidth(u_, p.caps[i]) + 4 * u_ + (p.caps.size() == 2 && i == 0 ? ui_.textWidth(" / ", sm, UiFont::BodySemi) : 0);
    w += ui_.textWidth(p.text, sm, UiFont::BodySemi);
  }
  w += padX * 2;
  const float h = std::max(kh, sm) + padY * 2, x0 = (W - w) / 2, y0 = H - 34 * u_ - h;
  Ui::Shadow sh{0, 6 * d, 14 * d, hex(0x00143c, 0.28f)};
  ui_.brushClip(x0, y0, w, h, white, 77, 4, 3, u_, &sh);
  float x = x0 + padX, cy = y0 + h / 2;
  x += ui_.textLH(x, cy - xs / 2, xs, xs, UiFont::BodyHeavy, red, "FREE CAMERA", UiAlign::Left, 0.18f);
  for (const Part& p : parts) {
    x += gap;
    for (size_t i = 0; i < p.caps.size(); i++) {
      x += ui_.kc(x, cy - kh / 2, u_, p.caps[i], blue, ice, a(blue, 0.42f)) + 4 * u_;
      if (p.caps.size() == 2 && i == 0) x += ui_.textLH(x, cy - sm / 2, sm, sm, UiFont::BodySemi, blue, " / ");
    }
    x += ui_.textLH(x, cy - sm / 2, sm, sm, UiFont::BodySemi, blue, p.text);
  }
}

void AdminPanel::camera(Camera& cam, const platform::Events& ev, double dt) {
  if (!fly_.on) { camPos_ = cam.pos; camFwd_ = cam.forward(); return; }
  if (!menus_.customOpen("admincam")) { fly_.on = false; return; }   // (something else took the screen)
  Fly& f = fly_;
  const float sens = 0.0022f * (h_.sensitivity ? h_.sensitivity() : 1.f);
  f.yaw -= ev.mouseDX * sens;
  f.pitch = std::clamp(f.pitch - ev.mouseDY * sens, -1.5f, 1.5f);
  auto kd = [&](Key k) { return plat_.keyDown(k); };
  float fw = float((kd(Key::KeyW) || kd(Key::ArrowUp) ? 1 : 0) - (kd(Key::KeyS) || kd(Key::ArrowDown) ? 1 : 0));
  float st = float((kd(Key::KeyD) || kd(Key::ArrowRight) ? 1 : 0) - (kd(Key::KeyA) || kd(Key::ArrowLeft) ? 1 : 0));
  float up = float((kd(Key::Space) || kd(Key::KeyE) ? 1 : 0) - (kd(Key::KeyC) || kd(Key::KeyQ) ? 1 : 0));
  bool fast = kd(Key::ShiftLeft) || kd(Key::ShiftRight);
  if (in_.padConnected()) {   // (the controller: left stick flies, right stick looks, jump / pick up up · down, sprint fast)
    const platform::GamepadState& g = in_.padState();
    auto dz = [](float v) { return std::fabs(v) < 0.15f ? 0.f : v; };
    fw += -dz(g.leftY); st += dz(g.leftX);
    f.yaw -= dz(g.rightX) * 2.4f * float(dt);
    f.pitch = std::clamp(f.pitch - dz(g.rightY) * 1.8f * float(dt), -1.5f, 1.5f);
    const int ju = in_.pad[size_t(Action::Jump)], pk = in_.pad[size_t(Action::Pickup)], sp = in_.pad[size_t(Action::Sprint)];
    if (ju >= 0 && g.buttons[ju] > 0.5f) up += 1;
    if (pk >= 0 && g.buttons[pk] > 0.5f) up -= 1;
    if (sp >= 0 && g.buttons[sp] > 0.5f) fast = true;
  }
  fw = std::clamp(fw, -1.f, 1.f); st = std::clamp(st, -1.f, 1.f); up = std::clamp(up, -1.f, 1.f);
  if (ev.wheel != 0) f.speed = std::clamp(f.speed * (ev.wheel > 0 ? 1.2f : 1 / 1.2f), 3.f, 120.f);
  const float cy = std::cos(f.yaw), sy = std::sin(f.yaw), cp = std::cos(f.pitch), sp = std::sin(f.pitch);
  // the camera looks down -Z: forward = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch)
  const double v = double(f.speed) * (fast ? 6 : 1) * dt;
  f.pos.x += double(-sy * cp * fw + cy * st) * v;
  f.pos.y += double(sp * fw + up) * v;
  f.pos.z += double(-cy * cp * fw - sy * st) * v;
  const double ground = (h_.ground ? h_.ground(f.pos.x, f.pos.z) : -1e9) + 1.2;
  if (f.pos.y < ground) f.pos.y = ground;
  const dvec3 fwd(-sy * cp, sp, -cy * cp);
  cam.lookAt(f.pos, f.pos + fwd);
  cam.fovY = 65;
}

// ------------------------------------------------------------------ the panel: input
int AdminPanel::itemAt(vec2 p) const {
  for (int i = int(items_.size()) - 1; i >= 0; i--) {
    const Item& it = items_[size_t(i)];
    const int c = it.col;
    if (p.y < boxY_[c] || p.y > boxY_[c] + boxH_[c] || p.x < boxX_[c] || p.x > boxX_[c] + boxW_[c]) continue;   // (clipped away)
    if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) return i;
  }
  return -1;
}

void AdminPanel::ensureVisible(const Item& it) {
  const int c = it.col;
  const float rel = it.y - boxY_[c];   // on screen, relative to the box's top (with this frame's scroll)
  const float maxS = std::max(0.f, content_[c] - boxH_[c]), m = 12 * u_;
  if (rel < m) scrollT_[c] = std::clamp(scroll_[c] + rel - m, 0.f, maxS);
  else if (rel + it.h > boxH_[c] - m) scrollT_[c] = std::clamp(scroll_[c] + rel + it.h - boxH_[c] + m, 0.f, maxS);
}

void AdminPanel::move(int dx, int dy) {
  int cur = -1;
  for (size_t i = 0; i < items_.size(); i++) if (items_[i].key == focusKey_) cur = int(i);
  if (cur < 0) { if (!items_.empty()) focusKey_ = items_[0].key; return; }
  const Item& a = items_[size_t(cur)];
  const float ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const bool aRight = a.col > 0;
  int best = -1;
  float bestS = 1e30f;
  for (size_t i = 0; i < items_.size(); i++) {
    if (int(i) == cur) continue;
    const Item& b = items_[i];
    const float bx = b.x + b.w / 2, by = b.y + b.h / 2;
    float s;
    if (dy != 0) {   // up / down: the same side, the next row, nearest across
      if ((b.col > 0) != aRight) continue;
      const float d = (by - ay) * float(dy);
      if (d < std::max(4.f, std::min(a.h, b.h) * 0.4f)) continue;
      s = d + std::fabs(bx - ax) * 0.35f;
    } else {         // left / right: the same row (overlapping vertically), then across to the other column
      const float d = (bx - ax) * float(dx);
      if (d < 4) continue;
      const float ov = std::min(a.y + a.h, b.y + b.h) - std::max(a.y, b.y);
      if (ov > std::min(a.h, b.h) * 0.3f) s = d;
      else if ((b.col > 0) != aRight) s = 4000 + std::fabs(by - ay) * 2 + d * 0.1f;   // (into the other column at that height)
      else continue;
    }
    if (s < bestS) { bestS = s; best = int(i); }
  }
  if (best >= 0) { focusKey_ = items_[size_t(best)].key; scrollToFocus_ = true; if (h_.sound) h_.sound("tick"); }
}

void AdminPanel::input(const UiNav& nav, double now) {
  (void)now;
  auto has = [&](Key k) { return std::find(nav.keys.begin(), nav.keys.end(), k) != nav.keys.end(); };
  const bool ctrl = plat_.keyDown(Key::ControlLeft) || plat_.keyDown(Key::ControlRight);
  const bool shift = plat_.keyDown(Key::ShiftLeft) || plat_.keyDown(Key::ShiftRight);
  if (has(Key::F10) || (has(Key::KeyA) && ctrl && shift)) { close(); return; }
  if (!allowed()) { close(); return; }
  int fi = -1;
  for (size_t i = 0; i < items_.size(); i++) if (items_[i].key == focusKey_) fi = int(i);
  const bool pad = nav.usingPad;
  const int fld = fi >= 0 ? items_[size_t(fi)].field : -1;
  focusField_ = fld;
  UiNav n = nav;
  if (fld >= 0 && !pad) {
    // the focused field takes the typed text (the OS's, in the keyboard's layout; else letters from the keys); only
    // the arrows move on, Enter does the field's action, Esc closes
    const bool digits = fld == F_AMOUNT || fld == F_ALL;
    const size_t maxc = fld == F_MSG ? 140 : (fld == F_NAME || fld == F_CONFIRM) ? 16 : 12;
    std::string typed;
    if (plat_.textInputActive()) typed = nav.text;
    else
      for (Key k : nav.keys) {
        const int ki = int(k);
        if (ki >= int(Key::KeyA) && ki <= int(Key::KeyZ)) typed += char((shift ? 'A' : 'a') + (ki - int(Key::KeyA)));
        else if (ki >= int(Key::Digit0) && ki <= int(Key::Digit9)) typed += char('0' + (ki - int(Key::Digit0)));
        else if (k == Key::Space) typed += ' ';
      }
    if (digits) { std::string t; for (char c : typed) if (c >= '0' && c <= '9') t += c; typed = t; }
    if (!typed.empty()) textAppend(fields_[fld], typed, maxc, false);
    if (has(Key::Backspace) || std::find(nav.keys.begin(), nav.keys.end(), Key::Backspace) != nav.keys.end()) textBackspace(fields_[fld]);
    n.up = has(Key::ArrowUp); n.down = has(Key::ArrowDown); n.left = has(Key::ArrowLeft); n.right = has(Key::ArrowRight);
    n.confirm = has(Key::Enter); n.cancel = has(Key::Escape); n.tabPrev = n.tabNext = false;
  } else if (!pad) {
    n.cancel = has(Key::Escape);   // (Backspace does not close it: only Esc, as the JS)
  }
  if (n.cancel) { close(); return; }
  // the mouse: hover focuses, a click uses, the slider drags, the wheel scrolls the box under it
  if (nav.mouse.x >= 0) {
    const int hi = itemAt(nav.mouse);
    if (nav.mouseMoved && hi >= 0 && !dragging_ && items_[size_t(hi)].key != focusKey_) { focusKey_ = items_[size_t(hi)].key; scrollToFocus_ = false; }
    if (nav.click) {
      if (hi >= 0) {
        Item& it = items_[size_t(hi)];
        focusKey_ = it.key; scrollToFocus_ = false;
        if (it.drag) { dragging_ = true; dragKey_ = it.key; }
        else if (it.field < 0 && it.act) it.act();
      } else if (fld >= 0) focusKey_.clear();   // (a click elsewhere: the field lets go)
    }
    if (dragging_) {
      if (!nav.mouseDown && !nav.click) dragging_ = false;
      else for (Item& it : items_) if (it.key == dragKey_ && it.drag) it.drag(std::clamp((nav.mouse.x - it.x) / std::max(1.f, it.w), 0.f, 1.f));
    }
    if (nav.wheel != 0)
      for (int c = 0; c < 3; c++)
        if (nav.mouse.x >= boxX_[c] && nav.mouse.x <= boxX_[c] + boxW_[c] && nav.mouse.y >= boxY_[c] && nav.mouse.y <= boxY_[c] + boxH_[c])
          scrollT_[c] = std::clamp(scrollT_[c] - nav.wheel * 60 * u_, 0.f, std::max(0.f, content_[c] - boxH_[c]));
  }
  // keys / the controller: move, adjust, use
  if (n.up) move(0, -1);
  if (n.down) move(0, 1);
  if (n.left || n.right) {
    const int d = n.left ? -1 : 1;
    Item* it = nullptr;
    for (Item& x : items_) if (x.key == focusKey_) it = &x;
    if (it && it->adjust && (it->field < 0 || pad)) it->adjust(d);
    else move(d, 0);
  }
  if (n.tabPrev || n.tabNext) {   // LB / RB: the left column <-> the right one
    int cur = -1;
    for (size_t i = 0; i < items_.size(); i++) if (items_[i].key == focusKey_) cur = int(i);
    const bool right = cur >= 0 && items_[size_t(cur)].col > 0;
    for (const Item& it : items_) if ((it.col > 0) != right) { focusKey_ = it.key; scrollToFocus_ = true; break; }
  }
  if (n.confirm) {
    for (Item& it : items_) {
      if (it.key != focusKey_) continue;
      if (it.field >= 0) {   // (data-enter: the field's action)
        if (it.field == F_AMOUNT) act("give");
        else if (it.field == F_ALL) act("giveall");
        else if (it.field == F_CONFIRM) act("reset");
        else if (it.field == F_MSG) act("say");
      } else if (it.act) it.act();
      break;
    }
  }
  // the right stick scrolls the box of the focused control
  if (std::fabs(nav.stickR.y) > 0.2f) {
    int c = 0;
    for (const Item& it : items_) if (it.key == focusKey_) c = it.col;
    scrollT_[c] = std::clamp(scrollT_[c] + nav.stickR.y * 18 * u_, 0.f, std::max(0.f, content_[c] - boxH_[c]));
  }
}

// ------------------------------------------------------------------ the panel: the frame
void AdminPanel::frame(const UiNav& navIn, double dt, double now) {
  const UiNav nav = inject_ ? injected_ : navIn;
  inject_ = false;
  u_ = ui_.cssU();
  openT_ += dt;
  input(nav, now);
  if (!isOpen()) return;
  // live: the players every 3 s; the clock sent at most every 250 ms (adminnew.js setHour)
  plT_ += dt;
  if (plT_ >= 3) { plT_ = 0; refreshPlayers(); }
  if (pendingHour_ >= 0 && (hourSentT_ < 0 || now - hourSentT_ > 0.25) && h_.op && h_.online && h_.online()) {
    const double v = pendingHour_;
    pendingHour_ = -1; hourSentT_ = now;
    h_.op("time", Json{{"hour", v}}, [this, v](bool ok, const Json&, const std::string& err) {
      if (!ok) serverError("time", err); else say("Time \xC2\xB7 " + hhmm(v) + " for everyone in your world");
    });
  }
  for (int c = 0; c < 3; c++) scroll_[c] += (scrollT_[c] - scroll_[c]) * float(1 - std::exp(-dt * 14));
  draw(now);
}

void AdminPanel::draw(double now) {
  const float W = float(ui_.width()), H = float(ui_.height()), d = ui_.dpr(), u = u_;
  const float xs = std::max(11 * d, 11 * u), sm = std::max(12 * d, 13 * u), md = std::max(13 * d, 15 * u), px = d;
  const bool mp = h_.online && h_.online();
  const float fade = float(std::min(1.0, openT_ / 0.25));
  ui_.pushAlpha(fade);
  // .ad-shade: the dark-blue shade over the game, heavier on the left
  ui_.gradientGrid(0, 0, W, H, 16, 1, [&](float fx, float) {
    float al = fx < 0.48f ? 0.74f + (0.5f - 0.74f) * fx / 0.48f : 0.5f + (0.34f - 0.5f) * (fx - 0.48f) / 0.52f;
    return vec4(vec3(shade), al);
  });
  std::vector<Item> items;
  auto focused = [&](const std::string& k) { return k == focusKey_; };
  const vec4 paperC(1, 1, 1, 0.95f), line = hex(0x1546c8, 0.12f);
  Ui::Shadow panelSh{0, 10 * u, 24 * u, hex(0x000e2c, 0.3f)};

  // ---- controls (x = their left, y = their top; they return their width)
  const float segH = sm + 12 * u + 4 * px;
  auto segW = [&](const std::string& l) { return ui_.textWidth(l, sm, UiFont::BodyBold) + 22 * u + 4 * px; };
  auto seg = [&](float x, float y, const std::string& label, bool on, const std::string& key, int col, std::function<void()> f) {
    const float w = segW(label);
    const bool foc = focused(key);
    if (on) ui_.roundRect(x, y, w, segH, 5 * u, blue);
    ui_.roundRectStroke(x, y, w, segH, 5 * u, 2 * px, foc ? red : blue);
    if (foc && !on) ui_.roundRect(x + 2 * px, y + 2 * px, w - 4 * px, segH - 4 * px, 4 * u, hex(0x1546c8, 0.1f));
    ui_.textLH(x + w / 2, y, segH, sm, UiFont::BodyBold, on ? white : blue, label, UiAlign::Center);
    Item it; it.key = key; it.x = x; it.y = y; it.w = w; it.h = segH; it.col = col; it.act = std::move(f);
    items.push_back(std::move(it));
    return w;
  };
  // .ad-btn (blue), .an-alt (outlined), .an-danger (red); .an-sm the small ones of the player rows
  auto btnSize = [&](const std::string& l, bool small) {
    const float fs = (small ? 15 : 20) * u;
    return vec2(ui_.textWidth(l, fs, UiFont::CondItalic, 0.06f) + (small ? 20 : 32) * u + 4 * px, fs + (small ? 8 : 12) * u + 4 * px);
  };
  auto btn = [&](float x, float y, const std::string& label, int style, bool small, const std::string& key, int col, std::function<void()> f) {
    const vec2 s = btnSize(label, small);
    const float fs = (small ? 15 : 20) * u;
    const bool foc = focused(key);
    const vec4 fill = style == 1 ? (foc ? hex(0x1546c8, 0.1f) : vec4(0)) : style == 2 ? red : (foc ? hex(0x0f3aa8) : blue);
    const vec4 edge = style == 2 ? red : blue;
    if (fill.w > 0) ui_.roundRect(x, y, s.x, s.y, 5 * u, fill);
    ui_.roundRectStroke(x, y, s.x, s.y, 5 * u, 2 * px, edge);
    if (foc) ui_.roundRectStroke(x - 3 * px, y - 3 * px, s.x + 6 * px, s.y + 6 * px, 7 * u, 2 * px, red);
    ui_.textLH(x + s.x / 2, y, s.y, fs, UiFont::CondItalic, style == 1 ? blue : white, label, UiAlign::Center, 0.06f);
    Item it; it.key = key; it.x = x; it.y = y; it.w = s.x; it.h = s.y; it.col = col; it.act = std::move(f);
    items.push_back(std::move(it));
    return s.x;
  };
  // .ad-amount: a text field (ice, a blue border when focused, the caret blinking)
  auto field = [&](float x, float y, float w, float fsU, int f, const std::string& placeholder, const std::string& key, int col, std::function<void(int)> adjust = {}) {
    const float fs = fsU * u, h = fs + 10 * u + 4 * px;
    const bool foc = focused(key);
    ui_.roundRect(x, y, w, h, 5 * u, foc ? white : ice);
    ui_.roundRectStroke(x, y, w, h, 5 * u, 2 * px, foc ? blue : hex(0x1546c8, 0.5f));
    ui_.pushClip(x + 2 * px, y, w - 4 * px, h);
    const std::string& s = fields_[f];
    if (s.empty()) ui_.textLH(x + 10 * u, y, h, fs, UiFont::CondItalic, hex(0x1546c8, 0.35f), placeholder, UiAlign::Left, 0.02f);
    float tw = s.empty() ? 0 : ui_.textWidth(s, fs, UiFont::CondItalic, 0.02f);
    const float shift = std::max(0.f, tw - (w - 24 * u));
    if (!s.empty()) ui_.textLH(x + 10 * u - shift, y, h, fs, UiFont::CondItalic, blue, s, UiAlign::Left, 0.02f);
    if (foc && !in_.usingGamepad() && std::fmod(now, 1.0) < 0.55) ui_.rect(x + 10 * u + tw - shift + 2 * px, y + (h - fs) / 2, std::max(px, 2 * u), fs, blue);
    ui_.popClip();
    Item it; it.key = key; it.x = x; it.y = y; it.w = w; it.h = h; it.col = col; it.field = f; it.adjust = std::move(adjust);
    items.push_back(std::move(it));
    return w;
  };
  auto amountAdjust = [&](int f) { return [this, f](int dd) { int64_t v = std::max<int64_t>(0, digitsOf(fields_[f]) + dd * 1000); fields_[f] = v > 0 ? std::to_string(v) : std::string(); }; };

  // ================================================================ the left column (scrolls)
  const float colX = 64 * u, colW = 520 * u, top = 34 * u, bottom = H - 34 * u;
  boxX_[0] = colX - 20 * u; boxW_[0] = colW + 40 * u; boxY_[0] = top; boxH_[0] = bottom - top;
  ui_.pushClip(boxX_[0], top - 20 * u, boxW_[0], bottom - top + 40 * u);
  float y = top - scroll_[0];
  {   // .menu-head: the brush title "ADMIN · NEW" and the line under it
    const float tw = std::round(330 * 0.9f) * u, th = 90 * u;
    Ui::Shadow tsh{0, 6 * u, 14 * u, hex(0x000000, 0.25f)};
    ui_.brushStroke(colX, y, tw, th, white, 2710, 330, 100, &tsh);
    ui_.textLH(colX + 40 * u, y, th, 44 * u, UiFont::CondItalic, blue, "ADMIN \xC2\xB7 NEW", UiAlign::Left, 0.04f);
    y += th + 6 * u;
    float x = colX + 12 * u;
    const vec4 wc = a(white, 0.92f);
    auto sub = [&](const std::string& s) {
      ui_.textShadow(x, y + md * 0.075f, md, UiFont::BodySemi, s, UiAlign::Left, 0.02f, 0, d, 8 * d, hex(0x000a1e, 0.6f));
      x += ui_.textLH(x, y, md * 1.35f, md, UiFont::BodySemi, wc, s, UiAlign::Left, 0.02f);
    };
    auto dot = [&]() { x += 6 * u; ui_.circle(x + 2.5f * u, y + md * 0.675f, 2.5f * u, a(white, 0.6f)); x += 5 * u + 6 * u; };
    sub(me()); dot();
    sub(mp ? "World " + (h_.worldId ? std::to_string(h_.worldId()) : std::string("?")) + " \xC2\xB7 applied by the server" : "Single player \xC2\xB7 your own game");
    dot();
    const float kh = ui_.kcHeight(u), ky = y + (md * 1.35f - kh) / 2;
    if (!in_.usingGamepad()) { x += ui_.kc(x, ky, u, "F10", white) + 4 * u; sub(" or "); x += 4 * u; }
    x += ui_.kc(x, ky, u, prompts::K(in_, "cancel"), white) + 6 * u;
    sub("to close");
    y += md * 1.35f + 6 * u + 12 * u;
  }
  const float pIn = 28 * u, innerX = colX + pIn, innerR = colX + colW - pIn, rowGap = 12 * u;
  // a panel: its rows are laid out first (heights), drawn after its paper
  struct Row { std::string label; float h; std::function<void(float y, float h)> draw; bool topAlign = false; std::string bold; };
  auto panel = [&](int seed, const std::string& head, std::vector<Row>& rows) {
    float h = 12 * u + xs + 4 * u;
    for (const Row& r : rows) h += r.h;
    h += 12 * u;
    ui_.brushClip(colX, y, colW, h, paperC, seed, 5, 4, u, &panelSh);
    float yy = y + 12 * u;
    ui_.textLH(innerX, yy, xs, xs, UiFont::BodyHeavy, red, head, UiAlign::Left, 0.18f);
    yy += xs + 4 * u;
    for (size_t i = 0; i < rows.size(); i++) {
      const Row& r = rows[i];
      if (!r.label.empty() || !r.bold.empty()) {
        float lx = innerX;
        const float ly = r.topAlign ? yy + 3 * u + 6 * u : yy + (r.h - sm * 1.25f) / 2;
        if (!r.label.empty()) lx += ui_.textLH(lx, ly, sm * 1.25f, sm, UiFont::BodySemi, blue, r.label);
        if (!r.bold.empty()) ui_.textLH(lx + 8 * u, ly + (sm * 1.25f - 24 * u) / 2, 24 * u, 24 * u, UiFont::CondItalic, blue, r.bold);
      }
      r.draw(yy, r.h);
      if (i + 1 < rows.size()) ui_.rect(innerX, yy + r.h - px, innerR - innerX, px, line);
      yy += r.h;
    }
    y += h + rowGap;
  };
  auto rowH = [&](float ctrlH) { return std::max(36 * u, ctrlH + 6 * u); };
  const float fldH = 22 * u + 10 * u + 4 * px, btnH = btnSize("X", false).y;

  // ---- PLAYER / YOU
  {
    std::vector<Row> rows;
    if (mp) {
      rows.push_back({"Name", rowH(20 * u + 10 * u + 4 * px), [&](float yy, float hh) {
        const float fh = 20 * u + 10 * u + 4 * px;
        field(innerR - 230 * u, yy + (hh - fh) / 2, 230 * u, 20, F_NAME, "Player name", "f:name", 0, [this](int dd) {
          if (players_.empty()) return;   // (a controller: left / right goes through the players online)
          int i = -1;
          for (size_t k = 0; k < players_.size(); k++) if (lower(players_[k].name) == lower(name())) i = int(k);
          i = ((i + dd) % int(players_.size()) + int(players_.size())) % int(players_.size());
          fields_[F_NAME] = players_[size_t(i)].name;
        });
      }});
    } else {
      rows.push_back({"Balance", rowH(26 * u), [&](float yy, float hh) {
        ui_.textLH(innerR, yy + (hh - 26 * u) / 2, 26 * u, 26 * u, UiFont::CondItalic, blue, money(h_.money ? h_.money() : 0), UiAlign::Right);
      }});
    }
    rows.push_back({"Money", rowH(std::max(fldH, btnH)), [&](float yy, float hh) {
      const float wT = btnSize("TAKE", false).x, wG = btnSize("GIVE", false).x, wF = 130 * u;
      float x = innerR - wT - wG - wF - 16 * u;
      field(x, yy + (hh - fldH) / 2, wF, 22, F_AMOUNT, "Amount", "f:amount", 0, amountAdjust(F_AMOUNT));
      x += wF + 8 * u;
      x += btn(x, yy + (hh - btnH) / 2, "GIVE", 0, false, "give", 0, [this] { act("give"); }) + 8 * u;
      btn(x, yy + (hh - btnH) / 2, "TAKE", 1, false, "take", 0, [this] { act("take"); });
    }});
    if (mp) {
      rows.push_back({"Everyone", rowH(std::max(fldH, btnH)), [&](float yy, float hh) {
        const float wT = btnSize("TAKE", false).x, wG = btnSize("GIVE ALL", false).x, wF = 130 * u;
        float x = innerR - wT - wG - wF - 16 * u;
        field(x, yy + (hh - fldH) / 2, wF, 22, F_ALL, "Amount", "f:all", 0, amountAdjust(F_ALL));
        x += wF + 8 * u;
        x += btn(x, yy + (hh - btnH) / 2, "GIVE ALL", 0, false, "giveall", 0, [this] { act("giveall"); }) + 8 * u;
        btn(x, yy + (hh - btnH) / 2, "TAKE", 1, false, "takeall", 0, [this] { act("takeall"); });
      }});
      rows.push_back({"", std::max(24 * u, xs + 10 * u), [&](float yy, float hh) {   // .an-check: including offline players
        const std::string l = "including offline players";
        const float bw = 14 * u, tw = ui_.textWidth(l, xs, UiFont::BodySemi), x = innerR - tw - bw - 6 * u, cy = yy + hh / 2;
        const bool foc = focused("offline");
        ui_.roundRect(x, cy - bw / 2, bw, bw, 3 * u, offline_ ? blue : white);
        ui_.roundRectStroke(x, cy - bw / 2, bw, bw, 3 * u, 1.5f * px, foc ? red : blue);
        if (offline_) { ui_.line(vec2(x + bw * 0.22f, cy), vec2(x + bw * 0.42f, cy + bw * 0.22f), 2 * px, white); ui_.line(vec2(x + bw * 0.42f, cy + bw * 0.22f), vec2(x + bw * 0.8f, cy - bw * 0.25f), 2 * px, white); }
        ui_.textLH(x + bw + 6 * u, cy - xs / 2, xs, xs, UiFont::BodySemi, foc ? blue : blueDim, l);
        Item it; it.key = "offline"; it.x = x; it.y = cy - bw / 2 - 4 * u; it.w = bw + 6 * u + tw; it.h = bw + 8 * u; it.col = 0; it.act = [this] { act("offline"); };
        items.push_back(std::move(it));
      }});
    }
    rows.push_back({"Release", rowH(segH), [&](float yy, float hh) {
      const std::pair<const char*, const char*> R[3] = {{"Prison", "rel:jail"}, {"Police chase", "rel:chase"}, {"Tow yard", "rel:impound"}};
      float total = 0;
      for (auto& r : R) total += segW(r.first);
      float x = innerR - total - 8 * u;
      for (auto& r : R) { const std::string k = r.second; x += seg(x, yy + (hh - segH) / 2, r.first, false, k, 0, [this, k] { act(k); }) + 4 * u; }
    }});
    if (mp) {
      rows.push_back({"Kick", rowH(btnH), [&](float yy, float hh) {
        btn(innerR - btnSize("KICK", false).x, yy + (hh - btnH) / 2, "KICK", 1, false, "kick", 0, [this] { act("kick"); });
      }});
      rows.push_back({"Progress", rowH(std::max(fldH, btnH)), [&](float yy, float hh) {
        if (confirming_) {
          const float wC = btnSize("CANCEL", false).x, wR = btnSize("RESET", false).x, wF = 230 * u, fh = 20 * u + 10 * u + 4 * px;
          float x = innerR - wC - wR - wF - 16 * u;
          field(x, yy + (hh - fh) / 2, wF, 20, F_CONFIRM, "Type the name again", "f:confirm", 0);
          x += wF + 8 * u;
          x += btn(x, yy + (hh - btnH) / 2, "RESET", 2, false, "reset", 0, [this] { act("reset"); }) + 8 * u;
          btn(x, yy + (hh - btnH) / 2, "CANCEL", 1, false, "noreset", 0, [this] { act("noreset"); });
        } else btn(innerR - btnSize("RESET\xE2\x80\xA6", false).x, yy + (hh - btnH) / 2, "RESET\xE2\x80\xA6", 2, false, "reset", 0, [this] { act("reset"); });
      }});
    }
    {   // the free camera switch (.an-switch) and its V
      const float swH = 26 * u + 8 * u + 4 * px;   // (the label: .mp-row b, italic 700 26u)
      Row r{"Free camera", rowH(swH), [&](float yy, float hh) {
        if (!in_.usingGamepad()) ui_.kc(innerX + ui_.textWidth("Free camera", sm, UiFont::BodySemi) + 8 * u, yy + (hh - ui_.kcHeight(u)) / 2, u, "V", blue);
        const bool on = fly_.on, foc = focused("cam");
        const float fs = 26 * u, tw = ui_.textWidth(on ? "ON" : "OFF", fs, UiFont::CondItalic, 0.14f), w = 4 * u + 18 * u + 8 * u + tw + 10 * u + 4 * px;
        const float x = innerR - w, sy = yy + (hh - swH) / 2;
        if (on) ui_.roundRect(x, sy, w, swH, swH / 2, blue);
        ui_.roundRectStroke(x, sy, w, swH, swH / 2, 2 * px, foc ? red : blue);
        ui_.circle(x + 2 * px + 4 * u + 9 * u + (on ? 2 * u : 0), sy + swH / 2, 9 * u, on ? white : hex(0x1546c8, 0.35f));
        ui_.textLH(x + 2 * px + 4 * u + 18 * u + 8 * u, sy, swH, fs, UiFont::CondItalic, on ? white : blue, on ? "ON" : "OFF", UiAlign::Left, 0.14f);
        Item it; it.key = "cam"; it.x = x; it.y = sy; it.w = w; it.h = swH; it.col = 0; it.act = [this] { act("cam"); };
        items.push_back(std::move(it));
      }};
      rows.push_back(std::move(r));
    }
    rows.push_back({"", std::max(26 * u, xs * 1.3f * 2 + 6 * u), [&](float yy, float hh) {   // .an-result
      (void)hh;
      ui_.textWrapped(innerX, yy + 6 * u, innerR - innerX, xs, UiFont::BodySemi, resultBad_ ? red : blue, result_, 1.3f);
    }});
    panel(2711, mp ? "PLAYER" : "YOU", rows);
  }
  // ---- WORLD / TIME & WEATHER
  {
    std::vector<Row> rows;
    const double hr = h_.hour ? h_.hour() : 12;
    Row tr{"Time", rowH(24 * u), [&](float yy, float hh) {
      // .ad-hour: a range 0 .. 23.99 (250u): the track, the filled part, the thumb
      const float w = 250 * u, x = innerR - w, cy = yy + hh / 2, f = float(std::clamp(hr / 23.99, 0.0, 1.0));
      const bool foc = focused("hour");
      ui_.roundRect(x, cy - 3 * px, w, 6 * px, 3 * px, hex(0xc9d6f5));
      ui_.roundRect(x, cy - 3 * px, w * f, 6 * px, 3 * px, blue);
      ui_.circle(x + w * f, cy, 8 * px, blue);
      if (foc) ui_.ring(x + w * f, cy, 11 * px, 2 * px, red);
      Item it; it.key = "hour"; it.x = x - 8 * px; it.y = cy - 12 * px; it.w = w + 16 * px; it.h = 24 * px; it.col = 0;
      it.drag = [this](float t) { setHour(double(t) * 23.99); };
      it.adjust = [this, hr](int dd) { setHour(std::round((hr + dd * 0.25) * 4) / 4); };
      items.push_back(std::move(it));
    }};
    tr.bold = hhmm(hr);
    rows.push_back(std::move(tr));
    rows.push_back({"Jump to", rowH(segH), [&](float yy, float hh) {
      const std::pair<const char*, const char*> J[4] = {{"Dawn", "h:7"}, {"Noon", "h:12"}, {"Dusk", "h:17.6"}, {"Night", "h:22"}};
      float total = 0;
      for (auto& j : J) total += segW(j.first) + 4 * u;
      float x = innerR - total + 4 * u;
      for (auto& j : J) { const std::string k = j.second; x += seg(x, yy + (hh - segH) / 2, j.first, false, k, 0, [this, k] { act(k); }) + 4 * u; }
    }});
    {   // the weathers: a wrapping row of segments, right-aligned lines (.seg flex-wrap)
      const float avail = innerR - innerX - ui_.textWidth("Weather", sm, UiFont::BodySemi) - 12 * u;
      std::vector<std::vector<int>> lines(1);
      float lw = 0;
      for (int w = 0; w < Weather::N; w++) {
        const float bw = segW(Weather::def(w).label) + 4 * u;
        if (lw + bw > avail && !lines.back().empty()) { lines.emplace_back(); lw = 0; }
        lines.back().push_back(w); lw += bw;
      }
      const int cur = h_.weather ? h_.weather() : -1;
      const float hh = float(lines.size()) * (segH + 4 * u) - 4 * u + 6 * u;
      Row r{"Weather", std::max(36 * u, hh), [&, lines, cur](float yy, float) {
        float ly = yy + 3 * u;
        for (const auto& ln : lines) {
          float total = 0;
          for (int w : ln) total += segW(Weather::def(w).label) + 4 * u;
          float x = innerR - total + 4 * u;
          for (int w : ln) { const std::string k = "w:" + std::to_string(w); x += seg(x, ly, Weather::def(w).label, w == cur, k, 0, [this, k] { act(k); }) + 4 * u; }
          ly += segH + 4 * u;
        }
      }};
      r.topAlign = true;
      rows.push_back(std::move(r));
    }
    if (mp) {
      rows.push_back({"Message", rowH(std::max(18 * u + 10 * u + 4 * px, btnH)), [&](float yy, float hh) {
        const float wS = btnSize("SEND", false).x, wF = 260 * u, fh = 18 * u + 10 * u + 4 * px;
        float x = innerR - wS - wF - 8 * u;
        field(x, yy + (hh - fh) / 2, wF, 18, F_MSG, "To everyone on the server", "f:msg", 0);
        btn(x + wF + 8 * u, yy + (hh - btnH) / 2, "SEND", 0, false, "say", 0, [this] { act("say"); });
      }});
    }
    panel(2712, mp ? "WORLD" : "TIME & WEATHER", rows);
  }
  content_[0] = y + scroll_[0] - top;
  ui_.popClip();

  // ================================================================ the right column: players, teleports
  const float rx = colX + colW + 34 * u, rw = std::min(540 * u, W - 64 * u - rx), rTop = top + 132 * u, rH = bottom - rTop;
  if (rw > 120 * u) {
    const float headH = 12 * u + xs + 4 * u;
    // players: up to 46 % of the column
    float plH = mp ? 0.f : 60 * u;
    if (mp) { plH = std::max(60 * u, float(players_.size()) * 58 * u); if (players_.empty()) plH = 60 * u; }
    const float plPanel = std::min(rH * 0.46f, headH + plH + 16 * u);
    const float tpPanel = std::max(200 * u, rH - plPanel - 12 * u);
    // a list box: paper, head, rows in a clip with the fade at the bottom
    auto listPanel = [&](int seed, float py, float ph, const std::string& head, int c, const std::function<float(float y)>& rowsFn) {
      ui_.brushClip(rx, py, rw, ph, paperC, seed, 5, 4, u, &panelSh);
      ui_.textLH(rx + pIn, py + 12 * u, xs, xs, UiFont::BodyHeavy, red, head, UiAlign::Left, 0.18f);
      boxX_[c] = rx + pIn - 10 * u; boxW_[c] = rw - 2 * pIn + 20 * u; boxY_[c] = py + headH; boxH_[c] = ph - headH - 16 * u;
      ui_.pushClip(boxX_[c], boxY_[c], boxW_[c], boxH_[c]);
      const float used = rowsFn(boxY_[c] - scroll_[c]);
      ui_.popClip();
      content_[c] = used;
      if (used > boxH_[c]) ui_.rectGradient(boxX_[c], boxY_[c] + boxH_[c] - 26 * u, boxW_[c], 26 * u, vec4(1, 1, 1, 0), paperC, false);
    };
    listPanel(2713, rTop, plPanel, "PLAYERS ONLINE", 1, [&](float y0) {
      float yy = y0;
      const float L = rx + pIn, R = rx + rw - pIn;
      if (!mp || players_.empty()) {
        ui_.textLH(L + 8 * u, yy + 10 * u, xs * 1.3f, xs, UiFont::BodySemi, blueDim, mp ? "Nobody online in your world" : "Single player \xC2\xB7 your own game only");
        return xs * 1.3f + 20 * u;
      }
      const std::string meL = lower(me());
      for (size_t i = 0; i < players_.size(); i++) {
        const Player& p = players_[i];
        const bool self = lower(p.name) == meL;
        const float rh = 23 * u * 1.15f + 3 * u + xs + 12 * u;
        ui_.rect(L, yy, R - L, px, line);
        const std::string kp = "pick:" + p.name;
        const bool foc = focused(kp);
        float actW = 0;
        if (!self) actW = btnSize("GO TO", true).x + btnSize("BRING", true).x + 6 * u + 10 * u;
        if (foc) { ui_.rectGradient(L, yy, R - L - actW, rh, hex(0x1546c8, 0.1f), hex(0x1546c8, 0), true); ui_.rect(L, yy, 4 * u, rh, red); }
        float nx = L + 8 * u;
        nx += ui_.textLH(nx, yy + 6 * u, 23 * u * 1.15f, 23 * u, UiFont::CondItalic, blue, upper(p.name), UiAlign::Left, 0.02f);
        if (self) ui_.textLH(nx + 5 * u, yy + 6 * u, 23 * u * 1.15f, xs, UiFont::BodySemi, blueDim, "(you)");
        float mx = L + 8 * u;
        const float my = yy + 6 * u + 23 * u * 1.15f + 3 * u;
        {
          Ui::Tabular tab(ui_);
          mx += ui_.textLH(mx, my, xs, xs, UiFont::BodySemi, blueDim, money(p.money));
          mx += 6 * u; ui_.circle(mx + 2 * u, my + xs / 2, 2 * u, hex(0x1546c8, 0.4f)); mx += 4 * u + 6 * u;
          char pos[48];
          if (p.hasPos) std::snprintf(pos, sizeof pos, "%d, %d", int(std::lround(p.x)), int(std::lround(p.z))); else std::snprintf(pos, sizeof pos, "\xE2\x80\x94");
          mx += ui_.textLH(mx, my, xs, xs, UiFont::BodySemi, blueDim, pos);
        }
        auto tag = [&](const char* t) {
          const float fs = 11 * u, tw = ui_.textWidth(t, fs, UiFont::BodyHeavy, 0.12f) + 12 * u;
          mx += 6 * u;
          ui_.roundRect(mx, my - 2 * u, tw, fs + 4 * u, 3 * u, red);
          ui_.textLH(mx + 6 * u, my - 2 * u, fs + 4 * u, fs, UiFont::BodyHeavy, white, t, UiAlign::Left, 0.12f);
          mx += tw;
        };
        if (p.jailed) tag("PRISON");
        if (p.wanted) tag("WANTED");
        if (p.impound) tag("TOW YARD");
        if (p.inside) tag("INSIDE");
        Item it; it.key = kp; it.x = L; it.y = yy; it.w = R - L - actW; it.h = rh; it.col = 1;
        const std::string nm = p.name;
        it.act = [this, nm] { fields_[F_NAME] = nm; if (h_.sound) h_.sound("click"); };
        items.push_back(std::move(it));
        if (!self) {
          const float bh = btnSize("GO TO", true).y;
          float bx = R - btnSize("GO TO", true).x - btnSize("BRING", true).x - 6 * u;
          bx += btn(bx, yy + (rh - bh) / 2, "GO TO", 0, true, "go:" + nm, 1, [this, nm] { if (h_.sound) h_.sound("click"); tpPlayer(nm, false); }) + 6 * u;
          btn(bx, yy + (rh - bh) / 2, "BRING", 0, true, "bring:" + nm, 1, [this, nm] { if (h_.sound) h_.sound("click"); tpPlayer(nm, true); });
        }
        yy += rh;
      }
      return yy - y0;
    });
    listPanel(2714, rTop + plPanel + 12 * u, tpPanel, "TELEPORT", 2, [&](float y0) {
      float yy = y0;
      const float L = rx + pIn, R = rx + rw - pIn;
      for (size_t i = 0; i < places_.size(); i++) {
        const AdminHost::Place& p = places_[i];
        const std::string k = "tp:" + std::to_string(i);
        const bool foc = focused(k);
        const float rh = 23 * u * 1.15f + 12 * u, sh = foc ? 4 * u : 0;
        ui_.rect(L, yy, R - L, px, line);
        if (foc) { ui_.rectGradient(L, yy, R - L, rh, hex(0x1546c8, 0.1f), hex(0x1546c8, 0), true); ui_.rect(L, yy, 4 * u, rh, red); }
        const float subW = std::min(ui_.textWidth(p.sub, xs, UiFont::BodySemi), (R - L) * 0.52f);
        ui_.pushClip(L, yy, R - L - subW - 14 * u, rh);
        ui_.textLH(L + 10 * u + sh, yy + 6 * u, 23 * u * 1.15f, 23 * u, UiFont::CondItalic, blue, upper(p.label), UiAlign::Left, 0.02f);
        ui_.popClip();
        ui_.textLH(R - 10 * u + sh, yy + 6 * u + (23 * u * 1.15f - xs) * 0.75f, xs, xs, UiFont::BodySemi, blueDim, p.sub, UiAlign::Right);
        Item it; it.key = k; it.x = L; it.y = yy; it.w = R - L; it.h = rh; it.col = 2;
        const AdminHost::Place pl = p;
        it.act = [this, pl] { teleport(pl); };
        items.push_back(std::move(it));
        yy += rh;
      }
      return yy - y0 + 10 * u;
    });
  } else { boxH_[1] = boxH_[2] = 0; }
  ui_.popAlpha();

  items_ = std::move(items);
  // the focus: kept by its key (the layout changes as the players come and go); else the first control
  int fi = -1;
  for (size_t i = 0; i < items_.size(); i++) if (items_[i].key == focusKey_) fi = int(i);
  if (fi < 0 && !items_.empty() && !(focusKey_.empty() && openT_ > 0.2 && !in_.usingGamepad() && focusField_ >= 0)) {
    if (focusKey_.rfind("pick:", 0) == 0 || focusKey_.rfind("go:", 0) == 0 || focusKey_.rfind("bring:", 0) == 0) {   // (a player left)
      for (size_t i = 0; i < items_.size(); i++) if (items_[i].col == 1) { fi = int(i); break; }
    }
    if (fi < 0) fi = 0;
    focusKey_ = items_[size_t(fi)].key;
  }
  focusField_ = fi >= 0 ? items_[size_t(fi)].field : -1;
  if (fi >= 0 && scrollToFocus_) { ensureVisible(items_[size_t(fi)]); scrollToFocus_ = false; }
}


// ------------------------------------------------------------------ (SKI_LEGACY_DEBUG=admintest)
bool AdminPanel::test(double now, const TestHooks& t, bool& ok) {
  auto log = [&](bool c, const std::string& what) { SL_INFO("[admintest] %s -> %s", what.c_str(), c ? "ok" : "FAILED"); if (!c) ok = false; };
  auto next = [&]() { tStep_++; tF_ = 0; tT0_ = now; tBusy_ = false; };
  auto el = [&]() { return now - tT0_; };
  auto centre = [&](const std::string& key, vec2& c) {
    for (const Item& it : items_) if (it.key == key) { c = vec2(it.x + it.w / 2, it.y + it.h / 2); return true; }
    return false;
  };
  auto injectKeys = [&](std::vector<Key> keys, const std::string& text = "") { UiNav n; n.mouse = vec2(-1); n.keys = std::move(keys); n.text = text; injected_ = n; inject_ = true; };
  auto injectPad = [&](bool up, bool down, bool left, bool right, bool confirm) {
    UiNav n; n.mouse = vec2(-1); n.usingPad = true; n.up = up; n.down = down; n.left = left; n.right = right; n.confirm = confirm; injected_ = n; inject_ = true;
  };
  auto click = [&](const std::string& key) {
    vec2 c;
    if (!centre(key, c)) return false;
    UiNav n; n.mouse = c; n.mouseMoved = true; n.click = true; n.mouseDown = true; injected_ = n; inject_ = true;
    return true;
  };
  const bool mp = h_.online && h_.online();
  if (tStep_ < 0) { tStep_ = 0; tT0_ = now; ok = true; }
  tF_++;
  if (!allowed()) {   // anyone else: F10 does nothing at all
    if (tStep_ == 0) { if (tF_ == 2) t.key(Key::F10); if (tF_ == 20) { log(!isOpen() && !menus_.isOpen(), "not Icey27 ('" + (h_.account ? h_.account() : std::string()) + "'): F10 opens nothing"); return true; } }
    return false;
  }
  const int64_t m = h_.money ? h_.money() : 0;
  switch (tStep_) {
    case 0:   // F10, a real key through the OS's queue
      if (tF_ == 2) { tMoney_ = m; t.key(Key::F10); }
      if (tF_ == 30) { log(isOpen(), std::string("F10 opens ADMIN \xC2\xB7 NEW (") + (mp ? "multiplayer" : "single player") + ", as " + me() + ")"); if (!isOpen()) return true; next(); }
      break;
    case 1:
      if (!tBusy_ && el() > 1.0) { tBusy_ = true; t.shot("admin_panel"); }
      if (tBusy_ && el() > (mp ? 2.5 : 1.2)) {
        log(places_.size() >= 5, "teleports listed: " + std::to_string(places_.size()));
        for (const auto& p : places_) SL_INFO("[admintest]   %s \xC2\xB7 %s (%.2f, %.2f) heading %.3f", p.label.c_str(), p.sub.c_str(), p.x, p.z, p.heading);
        if (mp) {
          bool meIn = false;
          for (const Player& p : players_) meIn = meIn || lower(p.name) == lower(me());
          log(meIn, "players online listed: " + std::to_string(players_.size()) + " (you among them)");
        }
        next();
      }
      break;
    case 2:   // the keyboard: the amount typed, Enter gives it (to you)
      if (tF_ == 2) { tMoney_ = m; focusKey_ = "f:amount"; fields_[F_AMOUNT].clear(); }
      if (tF_ == 4) injectKeys({Key::Digit2, Key::Digit5, Key::Digit0, Key::Digit0}, "2500");
      if (tF_ == 6) { log(fields_[F_AMOUNT] == "2500", "typed the amount: '" + fields_[F_AMOUNT] + "'"); injectKeys({Key::Enter}); }
      if (tF_ > 8 && (m == tMoney_ + 2500 || el() > 6)) { log(m == tMoney_ + 2500, "Enter: GIVE $2,500 -> money " + money(tMoney_) + " -> " + money(m) + " \xC2\xB7 '" + result_ + "'"); next(); }
      break;
    case 3:   // a controller: left / right sets the amount, A gives it
      if (tF_ == 2) { tMoney_ = m; focusKey_ = "f:amount"; fields_[F_AMOUNT].clear(); }
      if (tF_ == 4 || tF_ == 6) injectPad(false, false, false, true, false);
      if (tF_ == 8) { log(fields_[F_AMOUNT] == "2000", "controller: right, right -> amount '" + fields_[F_AMOUNT] + "'"); injectPad(false, false, false, false, true); }
      if (tF_ > 10 && (m == tMoney_ + 2000 || el() > 6)) { log(m == tMoney_ + 2000, "controller: A on the amount gives it -> " + money(m)); next(); }
      break;
    case 4:   // the controller moves the focus: down from the amount, the next row
      if (tF_ == 2) focusKey_ = "f:amount";
      if (tF_ == 4) injectPad(false, true, false, false, false);
      if (tF_ == 6) { log(!focusKey_.empty() && focusKey_ != "f:amount", "controller: down moves the focus (to '" + focusKey_ + "')"); next(); }
      break;
    case 5:   // the mouse: Night
      if (tF_ == 2 && !click("h:22")) { log(false, "the Night button"); next(); break; }
      if (tF_ > 4 && el() > (mp ? 1.5 : 0.2)) {
        const double hr = h_.hour ? h_.hour() : -1, sh = mp && t.serverHour ? t.serverHour() : hr;
        log(std::fabs(hr - 22) < 0.2 && std::fabs(sh - 22) < 0.2, "mouse: Night -> the clock " + hhmm(hr) + (mp ? " (the world's " + hhmm(sh) + ")" : ""));
        next();
      }
      break;
    case 6: {   // the controller: a weather
      const int heavy = Weather::byId("heavy");
      if (tF_ == 2) focusKey_ = "w:" + std::to_string(heavy);
      if (tF_ == 4) injectPad(false, false, false, false, true);
      if (tF_ > 6 && el() > (mp ? 1.5 : 0.2)) {
        const bool here = h_.weather && h_.weather() == heavy, srv = !mp || (t.serverWeather && t.serverWeather() == "heavy");
        log(here && srv, std::string("controller: Heavy snow -> the weather here ") + (here ? "ok" : "no") + (mp ? std::string(", the world's '") + (t.serverWeather ? t.serverWeather() : "") + "'" : ""));
        next();
      }
      break;
    }
    case 7:   // the server message (multiplayer): typed, Enter sends it, the banner comes back
      if (!mp) { next(); break; }
      if (tF_ == 2) { focusKey_ = "f:msg"; fields_[F_MSG].clear(); }
      if (tF_ == 4) injectKeys({}, "Hello from Icey27");
      if (tF_ == 5 && fields_[F_MSG].empty()) fields_[F_MSG] = "Hello from Icey27";   // (no OS text input in the test: the field as typed)
      if (tF_ == 6) injectKeys({Key::Enter});
      if (tF_ > 8 && ((t.banner && t.banner() == "Hello from Icey27") || el() > 6)) { log(t.banner && t.banner() == "Hello from Icey27", "message: SEND -> the banner '" + (t.banner ? t.banner() : std::string()) + "'"); next(); }
      break;
    case 8:   // release (multiplayer: yourself by name)
      if (tF_ == 2) { if (mp) fields_[F_NAME] = me(); result_.clear(); click("rel:jail"); }
      if (tF_ > 4 && (!result_.empty() || el() > 6)) {
        log(mp ? result_.find("out of prison") != std::string::npos : result_ == "Nothing to release", "Release \xC2\xB7 Prison -> '" + result_ + "'");
        next();
      }
      break;
    case 9:   // the free camera: its switch (the mouse), then T drops you under it
      if (tF_ == 2 && !click("cam")) { log(false, "the free camera switch"); next(); break; }
      if (tF_ == 6) { log(flying() && !isOpen(), "the switch starts the free camera (the panel closes)"); fly_.pos += dvec3(30, 25, -40); }   // (moved as W A S D would)
      if (tF_ == 12) t.shot("admin_fly");
      if (tF_ == 14) { tPos_ = fly_.pos; injectKeys({Key::KeyT}); }
      if (tF_ == 20) {
        const dvec3 p = t.playerPos();
        log(!flying() && std::hypot(p.x - tPos_.x, p.z - tPos_.z) < 3, "T drops you under the camera (" + std::to_string(int(std::hypot(p.x - tPos_.x, p.z - tPos_.z))) + " m off)");
        next();
      }
      break;
    case 10:   // F10 again; a teleport chosen with the controller
      if (tF_ == 2) t.key(Key::F10);
      if (tF_ == 20) { if (!isOpen()) { log(false, "F10 reopens it"); next(); break; } focusKey_ = "tp:0"; }
      if (tF_ == 22) injectPad(false, false, false, false, true);
      if (tF_ == 40) {
        const dvec3 p = t.playerPos();
        log(!isOpen() && std::hypot(p.x - 4, p.z - 34) < 3, "controller: TELEPORT \xC2\xB7 Legacy Village -> at the plaza");
        next();
      }
      break;
    case 11:   // F10 opens, Esc closes
      if (tF_ == 2) t.key(Key::F10);
      if (tF_ == 20) { log(isOpen(), "open again"); injectKeys({Key::Escape}); }
      if (tF_ == 24) { log(!isOpen(), "Esc closes it"); next(); }
      break;
    case 12:   // the pause menu's ADMIN (the way in with a controller)
      if (tF_ == 2) { menus_.inGame = true; menus_.open(Menus::Screen::Pause); }
      if (tF_ == 6) {
        const bool listed = menus_.focusLabel("ADMIN");
        log(listed, "the pause menu lists ADMIN");
        if (listed && menus_.hooks.admin) menus_.hooks.admin();
      }
      if (tF_ == 10) { log(isOpen(), "ADMIN in the pause menu opens the panel"); if (!mp) close(); next(); }
      break;
    case 13: {   // (multiplayer, another player online) GO TO them with the mouse, BRING them with the controller
      std::string other;
      for (const Player& p : players_) if (lower(p.name) != lower(me()) && p.hasPos) other = p.name;
      if (!mp || other.empty()) { if (mp) SL_INFO("[admintest] (nobody else online: GO TO / BRING not tried)"); close(); next(); break; }
      if (tF_ == 2) { tPos_ = t.playerPos(); if (!click("go:" + other)) { log(false, "GO TO " + other); close(); next(); } }
      if (tF_ == 60) {
        const dvec3 p = t.playerPos();
        double ox = 0, oz = 0;
        for (const Player& q : players_) if (q.name == other) { ox = q.x; oz = q.z; }
        log(!isOpen() && std::hypot(p.x - ox, p.z - oz) < 12, "mouse: GO TO " + other + " -> " + std::to_string(int(std::hypot(p.x - ox, p.z - oz))) + " m from them");
        open();
      }
      if (tF_ == 80) { result_.clear(); focusKey_ = "bring:" + other; injectPad(false, false, false, false, true); }
      if (tF_ > 82 && (!result_.empty() || el() > 8)) { log(result_.find("on the way to you") != std::string::npos, "controller: BRING " + other + " -> '" + result_ + "'"); close(); next(); }
      break;
    }
    default:
      return true;
  }
  return false;
}

} // namespace sl
