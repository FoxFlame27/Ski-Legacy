#include "game/hud.h"
#include "core/prompts.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace sl {
using namespace ui_color;

static std::string fmtMoney(int64_t v) {
  std::string s = std::to_string(v < 0 ? -v : v), o;
  for (size_t i = 0; i < s.size(); i++) { if (i && (s.size() - i) % 3 == 0) o += ','; o += s[i]; }
  return (v < 0 ? "-" : "") + o;
}

void Hud::flash(const std::string& text, Flash kind, double now, double ms) {
  if (text.empty()) return;
  flashText_ = text; flashKind_ = kind; flashAt_ = now;
  // (the user: "make all notifications stay longer": at least 5.5 s, the longer ones 2.25x)
  flashUntil_ = now + std::max(5.5, ms * 2.25 / 1000.0);
}

void Hud::controlsHint(double now, double secs) { hintAt_ = now; hintUntil_ = now + secs; }

void Hud::draw(Ui& ui, const HudFrame& f, Save& save, const Input& in, double now) {
  float W = float(ui.width()), H = float(ui.height());
  float s = float(save.setting("hudScale", 1)) * std::clamp(H / 760.f, 0.75f, 2.5f);
  float m = 22 * s;
  bool showInfo = save.settingOn("showInfo"), showMoney = save.settingOn("showMoney"), showSpeedo = save.settingOn("showSpeedo");
  auto pill = [&](float x, float y, float w, float h, int variant) {
    ui.shadow(x + 2 * s, y + 3 * s, w - 4 * s, h - 4 * s, 6 * s, 10 * s, 0.22f);
    ui.brushPanel(x, y, w, h, white, variant);
  };
  // ---- info (top left): location, clock · weather, forecast, objective
  if (showInfo) {
    char clk[32];
    int hh = int(f.hour) % 24, mm = int((f.hour - std::floor(f.hour)) * 60);
    if (save.settingOn("clock12")) std::snprintf(clk, sizeof clk, "%d:%02d %s", hh % 12 ? hh % 12 : 12, mm, hh < 12 ? "AM" : "PM");
    else std::snprintf(clk, sizeof clk, "%02d:%02d", hh, mm);
    std::string line2 = std::string(clk) + " \xC2\xB7 " + f.weather;
    float w1 = ui.textWidth(f.location, 22 * s, UiFont::CondItalic), w2 = ui.textWidth(line2, 12 * s, UiFont::Body);
    float w = std::max({190 * s, w1, w2}) + 40 * s, h = 62 * s;
    float ow = 0, oh = 0;
    if (!f.objective.empty()) { ow = std::min(280 * s, ui.textWidth(f.objective, 12.5f * s, UiFont::Body)); oh = 24 * s; w = std::max(w, ow + 54 * s); }
    if (save.settingOn("showForecast") && !f.forecast.empty()) h += 13 * s;
    pill(m, 20 * s, w, h + oh, 0);
    float x = m + 18 * s, y = 20 * s + 10 * s;
    ui.text(x, y, 22 * s, UiFont::CondItalic, blue, f.location);
    y += 26 * s;
    ui.text(x, y, 12 * s, UiFont::Body, blueDim, line2);
    y += 15 * s;
    if (save.settingOn("showForecast") && !f.forecast.empty()) { ui.text(x, y, 10 * s, UiFont::Body, a(blueDim, 0.62f), f.forecast); y += 13 * s; }
    if (!f.objective.empty()) {
      ui.rect(x, y + 4 * s, w - 40 * s, 1, a(blue, 0.18f));
      ui.circle(x + 3 * s, y + 15 * s, 3 * s, red);
      ui.textFit(x + 12 * s, y + 8 * s, 280 * s, 12.5f * s, UiFont::Body, blue, f.objective);
    }
  }
  // ---- waypoint (top centre)
  if (f.waypoint) {
    char d[64];
    if (f.wpDist < 1000) std::snprintf(d, sizeof d, "%.0f m", f.wpDist); else std::snprintf(d, sizeof d, "%.1f km", f.wpDist / 1000);
    std::string t = f.wpLabel + " \xC2\xB7 " + d;
    float tw = ui.textWidth(t, 18 * s, UiFont::CondItalic), w = tw + 70 * s, h = 36 * s, x = W / 2 - w / 2, y = 20 * s;
    pill(x, y, w, h, 0);
    vec2 c(x + 24 * s, y + h / 2);
    float ang = float(f.wpAngle);
    auto R = [&](vec2 p) { return c + vec2(p.x * std::cos(ang) - p.y * std::sin(ang), p.x * std::sin(ang) + p.y * std::cos(ang)); };
    ui.tri(R(vec2(0, -10 * s)), R(vec2(7 * s, 8 * s)), R(vec2(0, 4 * s)), red);
    ui.tri(R(vec2(0, -10 * s)), R(vec2(0, 4 * s)), R(vec2(-7 * s, 8 * s)), red);
    ui.text(x + 44 * s, y + (h - ui.lineHeight(18 * s, UiFont::CondItalic)) / 2, 18 * s, UiFont::CondItalic, blue, t);
  }
  // ---- flash (below the top)
  if (now < flashUntil_ && !flashText_.empty()) {
    float k = float(std::min({1.0, (now - flashAt_) / 0.25, (flashUntil_ - now) / 0.25}));
    float fs = 20 * s * (save.settingStr("flashSize", "m") == "s" ? 0.85f : save.settingStr("flashSize", "m") == "l" ? 1.2f : 1.f);
    float maxW = std::min(W * 0.92f, 860 * s);
    float tw = std::min(maxW - 52 * s, ui.textWidth(flashText_, fs, UiFont::CondItalic));
    float w = tw + 52 * s, h = 42 * s, x = W / 2 - w / 2, y = (f.waypoint ? 66 : 60) * s;
    ui.shadow(x, y, w, h, 6 * s, 10 * s, 0.22f * k);
    ui.brushPanel(x, y, w, h, a(white, k), 1);
    vec4 col = flashKind_ == Flash::Bad ? ko : flashKind_ == Flash::Gold ? gold : blue;
    ui.textFit(W / 2, y + (h - ui.lineHeight(fs, UiFont::CondItalic)) / 2, tw, fs, UiFont::CondItalic, a(col, k), flashText_, UiAlign::Center);
  }
  // ---- money (bottom left)
  float moneyTop = H - m;
  if (showMoney) {
    std::string v = fmtMoney(save.money);
    float cw = ui.textWidth("$", 26 * s, UiFont::CondItalic), vw = ui.textWidth(v, 34 * s, UiFont::CondItalic);
    float w = cw + vw + 50 * s, h = 52 * s, x = m, y = H - m - h;
    moneyTop = y;
    pill(x, y, w, h, 0);
    ui.text(x + 20 * s, y + 10 * s, 26 * s, UiFont::CondItalic, red, "$");
    ui.text(x + 22 * s + cw, y + (h - ui.lineHeight(34 * s, UiFont::CondItalic)) / 2, 34 * s, UiFont::CondItalic, blue, v);
    double age = save.clock - save.lastDeltaAt;
    if (save.lastDelta != 0 && age >= 0 && age < 1.9) {
      float k = float(std::min(1.0, (1.9 - age) / 0.3));
      std::string d = (save.lastDelta > 0 ? "+" : "\xE2\x88\x92") + fmtMoney(save.lastDelta > 0 ? save.lastDelta : -save.lastDelta);
      ui.text(x + w + 10 * s, y + (h - ui.lineHeight(20 * s, UiFont::CondItalic)) / 2, 20 * s, UiFont::CondItalic, a(save.lastDelta > 0 ? ok : ko, k), d);
    }
  }
  // ---- the controls hint card (bottom left, above the money): once per save
  if (save.tutorial && hintAt_ < 0 && !hintSeen_) controlsHint(now);
  if (hintAt_ >= 0 && now - hintAt_ > 3 && f.speed > 2) hintUntil_ = std::min(hintUntil_, now + 0.6);
  if (hintAt_ >= 0 && now - hintAt_ > 6 && save.tutorial) { save.tutorial = false; save.markDirty(); }
  if (hintAt_ >= 0 && now < hintUntil_) {
    hintSeen_ = true;
    float k = float(std::min(1.0, (hintUntil_ - now) / 0.6));
    bool pad = in.usingGamepad();
    platform::PadFamily fam = in.padFamily();
    auto L = [&](Action a) { return prompts::bindLabel(in, a, pad, fam); };
    std::string steer = pad ? "L STICK" : L(Action::Left) + " " + L(Action::Right);
    std::string fwd = pad ? "L STICK \xE2\x86\x91\xE2\x86\x93" : L(Action::Forward) + " " + L(Action::Back);
    std::vector<std::pair<std::string, std::string>> rows = {
      {steer, "Steer"}, {fwd, "Go / tuck \xC2\xB7 brake"}, {L(Action::Jump), "Hold, release to jump"}, {L(Action::Skis), "Skis on / off"},
      {L(Action::Interact), "Interact \xC2\xB7 lifts, shops, cars"}, {L(Action::Map), "Trail map"}, {L(Action::Pause), "Pause \xC2\xB7 all controls"}};
    float rh = 24 * s, w = 300 * s, h = 40 * s + rh * float(rows.size()), x = m, y = moneyTop - 14 * s - h;
    ui.shadow(x, y, w, h, 6 * s, 10 * s, 0.22f * k);
    ui.brushPanel(x, y, w, h, a(white, 0.96f * k), 0);
    ui.text(x + 18 * s, y + 12 * s, 11 * s, UiFont::Body, a(red, k), "CONTROLS");
    float yy = y + 32 * s;
    for (const auto& [keys, what] : rows) {
      float kx = x + 18 * s;
      // (several labels separated by spaces: one cap each, except stick words)
      if (keys.rfind("L STICK", 0) == 0) kx += ui.keycap(kx, yy, 19 * s, keys);
      else {
        size_t p0 = 0;
        while (p0 <= keys.size()) {
          size_t p1 = keys.find(' ', p0);
          std::string kk = keys.substr(p0, p1 == std::string::npos ? std::string::npos : p1 - p0);
          if (!kk.empty()) kx += ui.keycap(kx, yy, 19 * s, kk) + 3 * s;
          if (p1 == std::string::npos) break;
          p0 = p1 + 1;
        }
      }
      ui.text(std::max(kx + 8 * s, x + 118 * s), yy + (19 * s - ui.lineHeight(12.5f * s, UiFont::Body)) / 2, 12.5f * s, UiFont::Body, a(blue, k), what);
      yy += rh;
    }
  }
  // ---- speedometer (bottom right)
  if (showSpeedo && f.speedo) {
    bool mph = save.settingStr("speedUnit", "kmh") == "mph";
    char v[16];
    std::snprintf(v, sizeof v, "%d", int(std::round(f.speed * (mph ? 2.23694 : 3.6))));
    float vw = ui.textWidth(v, 46 * s, UiFont::CondItalic), uw = ui.textWidth(mph ? "MPH" : "KM/H", 12 * s, UiFont::CondBold);
    float sw = f.skiName.empty() ? 0 : ui.textWidth(f.skiName, 12 * s, UiFont::CondBold);
    float w = std::max({120 * s, vw + uw + 10 * s, sw}) + 48 * s, h = (f.skiName.empty() ? 62 : 78) * s, x = W - m - w, y = H - m - h;
    pill(x, y, w, h, 0);
    ui.text(x + w - 26 * s, y + 6 * s, 46 * s, UiFont::CondItalic, blue, v, UiAlign::Right);
    float base = x + w - 26 * s - vw;
    ui.text(base - 6 * s, y + 34 * s, 12 * s, UiFont::CondBold, blueDim, mph ? "MPH" : "KM/H", UiAlign::Right);
    if (!f.skiName.empty()) ui.text(x + w - 26 * s, y + 58 * s, 12 * s, UiFont::CondBold, blueDim, f.skiName, UiAlign::Right);
  }
  // ---- prompt (bottom centre) with its keycap
  if (!f.prompt.empty()) {
    float kh = 24 * s, kw = ui.keycapWidth(kh, f.promptKey), tw = ui.textWidth(f.prompt, 14 * s, UiFont::CondBold);
    float w = kw + tw + 46 * s, h = 40 * s, x = W / 2 - w / 2, y = H - 84 * s - h;
    pill(x, y, w, h, 1);
    ui.keycap(x + 14 * s, y + (h - kh) / 2, kh, f.promptKey);
    ui.text(x + 24 * s + kw, y + (h - ui.lineHeight(16 * s, UiFont::CondBold)) / 2, 16 * s, UiFont::CondBold, blue, f.prompt);
  }
  // ---- ride hint (bottom centre, low)
  if (!f.rideHint.empty()) {
    float tw = ui.textWidth(f.rideHint, 14 * s, UiFont::CondBold), w = tw + 44 * s, h = 32 * s, x = W / 2 - w / 2, y = H - 28 * s - h;
    pill(x, y, w, h, 0);
    ui.text(W / 2, y + (h - ui.lineHeight(14 * s, UiFont::CondBold)) / 2, 14 * s, UiFont::CondBold, blue, f.rideHint, UiAlign::Center);
  }
  if (save.settingOn("showFps")) {
    char b[32];
    std::snprintf(b, sizeof b, "%.0f FPS", f.fps);
    ui.text(W - m, 20 * s, 13 * s, UiFont::CondBold, a(white, 0.85f), b, UiAlign::Right);
  }
}

} // namespace sl
