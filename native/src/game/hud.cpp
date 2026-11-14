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

// Everything below is style.css's HUD in CSS px (x s: the display's pixel ratio times SETTINGS · HUD size, the CSS
// zoom on #info / #waypoint / #money / #speedo / #prompt): white paper pills (clip-path --brush-a / --brush-b) with
// filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)), blue lettering.
void Hud::draw(Ui& ui, const HudFrame& f, Save& save, const Input& in, double now) {
  float W = float(ui.width()), H = float(ui.height());
  const float d = ui.dpr();
  const float s = float(std::clamp(save.setting("hudScale", 1), 0.5, 2.0)) * d;
  bool showInfo = save.settingOn("showInfo"), showMoney = save.settingOn("showMoney"), showSpeedo = save.settingOn("showSpeedo");
  const vec4 shadowCol = hex(0x00143c, 0.28f);
  auto pill = [&](float x, float y, float w, float h, int variant, float k, float alpha = 1) {
    Ui::Shadow sh{0, 6 * k, 14 * k, a(shadowCol, alpha)};
    ui.brushPanel(x, y, w, h, a(white, alpha), variant, &sh);
  };
  // line-height: normal (the font's ascent + descent)
  auto normalLH = [&](float size, UiFont fnt) { return (ui.ascent(fnt) - ui.descent(fnt)) * size; };

  // ---- #info (top left): location, clock · weather, the forecast line, the objective
  if (showInfo) {
    char clk[32];
    int hh = int(f.hour) % 24, mm = int((f.hour - std::floor(f.hour)) * 60);
    if (save.settingOn("clock12")) std::snprintf(clk, sizeof clk, "%d:%02d %s", hh % 12 ? hh % 12 : 12, mm, hh < 12 ? "AM" : "PM");
    else std::snprintf(clk, sizeof clk, "%02d:%02d", hh, mm);
    std::string line2 = std::string(clk) + " \xC2\xB7 " + f.weather;
    bool fc = save.settingOn("showForecast") && !f.forecast.empty();
    const UiFont fLoc = UiFont::CondItalic, fClk = UiFont::BodySemi;
    float locS = 22 * s, clkS = 12 * s, fcS = 10 * s, objS = 12.5f * s;
    float locLH = normalLH(locS, fLoc), clkLH = normalLH(clkS, fClk), fcLH = normalLH(fcS, UiFont::Body);
    float cw = std::max(ui.textWidth(f.location, locS, fLoc, 0.02f), ui.textWidth(line2, clkS, fClk));
    if (fc) cw = std::max(cw, ui.textWidth(f.forecast, fcS, UiFont::Body));
    // #objective: max-width 280px, the 6px dot and an 8px gap, then the text (line-height 1.45, wraps)
    std::vector<std::string> objLines;
    float objW = 0;
    if (!f.objective.empty()) {
      float maxT = (280 - 14) * s;
      std::string line, word;
      auto push = [&]() { if (!line.empty()) { objW = std::max(objW, ui.textWidth(line, objS, fClk)); objLines.push_back(line); line.clear(); } };
      for (size_t i = 0; i <= f.objective.size(); i++) {
        char ch = i < f.objective.size() ? f.objective[i] : ' ';
        if (ch != ' ') { word += ch; continue; }
        if (word.empty()) continue;
        std::string cand = line.empty() ? word : line + " " + word;
        if (!line.empty() && ui.textWidth(cand, objS, fClk) > maxT) { push(); line = word; } else line = cand;
        word.clear();
      }
      push();
      cw = std::max(cw, objW + 14 * s);
    }
    float w = std::max(190 * s, cw + 40 * s);
    float h = 12 * s + locLH + 2 * s + clkLH + (fc ? 1 * s + fcLH : 0) + 12 * s;
    if (!objLines.empty()) h += 16 * s + 1 * s + objS * 1.45f * float(objLines.size());
    float x0 = 22 * s, y0 = 20 * s;
    pill(x0, y0, w, h, 0, s);
    float x = x0 + 18 * s, y = y0 + 12 * s;
    ui.textLH(x, y, locLH, locS, fLoc, blue, f.location, UiAlign::Left, 0.02f);
    y += locLH + 2 * s;
    ui.textLH(x, y, clkLH, clkS, fClk, blueDim, line2);
    y += clkLH;
    if (fc) { y += 1 * s; ui.textLH(x, y, fcLH, fcS, UiFont::Body, a(blue, 0.62f), f.forecast); y += fcLH; }
    if (!objLines.empty()) {
      y += 8 * s;
      ui.rect(x, y, w - 40 * s, 1 * s, hex(0x1546c8, 0.18f));
      y += 1 * s + 8 * s;
      float lh = objS * 1.45f;
      // (the dot sits on the first line's baseline, 1px up: align-items baseline, translateY(-1px))
      float base = y + (lh - (ui.ascent(fClk) - ui.descent(fClk)) * objS) * 0.5f + ui.ascent(fClk) * objS;
      ui.circle(x + 3 * s, base - 4 * s, 3 * s, red);
      for (const std::string& l : objLines) { ui.textLH(x + 14 * s, y, lh, objS, fClk, blue, l); y += lh; }
    }
  }

  // ---- #waypoint (top centre): the red arrow turned toward the mark, "label · 412 m"
  if (f.waypoint) {
    char dd[64];
    if (f.wpDist < 1000) std::snprintf(dd, sizeof dd, "%.0f m", std::round(f.wpDist)); else std::snprintf(dd, sizeof dd, "%.1f km", f.wpDist / 1000);
    std::string t = f.wpLabel + " \xC2\xB7 " + dd;
    const UiFont fw = UiFont::CondSemiItalic;
    float fs = 18 * s, lh = std::max(16 * s, normalLH(fs, fw));
    float tw = ui.textWidth(t, fs, fw, 0.03f), w = 16 * s + 16 * s + 8 * s + tw + 22 * s, h = 8 * s + lh + 8 * s, x = W / 2 - w / 2, y = 20 * s;
    pill(x, y, w, h, 0, s);
    vec2 c(x + 16 * s + 8 * s, y + h / 2);
    float ang = float(std::round(f.wpAngle * 180 / 3.14159265) * 3.14159265 / 180);
    auto R = [&](float px, float py) { px = (px - 8) * s; py = (py - 8) * s; return c + vec2(px * std::cos(ang) - py * std::sin(ang), px * std::sin(ang) + py * std::cos(ang)); };
    // the svg path M8 1.5 L13.5 13 L8 10.2 L2.5 13 Z
    ui.tri(R(8, 1.5f), R(13.5f, 13), R(8, 10.2f), red);
    ui.tri(R(8, 1.5f), R(8, 10.2f), R(2.5f, 13), red);
    ui.textLH(x + 16 * s + 16 * s + 8 * s, y + 8 * s, lh, fs, fw, blue, t, UiAlign::Left, 0.03f);
  }

  // ---- #flash (top 66px, centred): opacity 0.25 s in / out; one line while it fits, then it wraps (max min(92vw, 860px))
  if (now < flashUntil_ + 0.25 && !flashText_.empty()) {
    float k = float(std::clamp(std::min((now - flashAt_) / 0.25, (flashUntil_ + 0.25 - now) / 0.25), 0.0, 1.0));
    std::string fsz = save.settingStr("flashSize", "m");
    const UiFont ff = UiFont::CondSemiItalic;
    float fs = 20 * d * (fsz == "s" ? 0.85f : fsz == "l" ? 1.2f : 1.f), lh = normalLH(fs, ff);
    float maxW = std::min(W * 0.92f, 860 * d), maxT = maxW - 52 * d;
    std::vector<std::string> lines;
    {
      std::string line, word;
      for (size_t i = 0; i <= flashText_.size(); i++) {
        char ch = i < flashText_.size() ? flashText_[i] : ' ';
        if (ch != ' ') { word += ch; continue; }
        if (word.empty()) continue;
        std::string cand = line.empty() ? word : line + " " + word;
        if (!line.empty() && ui.textWidth(cand, fs, ff, 0.03f) > maxT) { lines.push_back(line); line = word; } else line = cand;
        word.clear();
      }
      if (!line.empty()) lines.push_back(line);
    }
    float tw = 0;
    for (auto& l : lines) tw = std::max(tw, std::min(maxT, ui.textWidth(l, fs, ff, 0.03f)));
    float w = tw + 52 * d, h = 18 * d + lh * float(lines.size()), x = W / 2 - w / 2, y = 66 * d;
    pill(x, y, w, h, 1, d, k);
    vec4 col = flashKind_ == Flash::Bad ? ko : flashKind_ == Flash::Gold ? gold : blue;
    float yy = y + 9 * d;
    for (auto& l : lines) { ui.textLH(W / 2, yy, lh, fs, ff, a(col, k), l, UiAlign::Center, 0.03f); yy += lh; }
  }

  // ---- #money (bottom left): "$" red 26px, the amount 34px, the last change beside it (18px, 1.6 s)
  if (showMoney) {
    const UiFont fm = UiFont::CondSemiItalic;
    std::string v = fmtMoney(save.money);
    float cs = 26 * s, vs = 34 * s, ds = 18 * s;
    float cw = ui.textWidth("$", cs, fm, 0.02f), vw = ui.textWidth(v, vs, fm, 0.02f);
    std::string dl;
    if (save.lastDelta != 0) dl = (save.lastDelta > 0 ? "+" : "\xE2\x88\x92") + fmtMoney(save.lastDelta > 0 ? save.lastDelta : -save.lastDelta);
    float dw = dl.empty() ? 0 : 10 * s + ui.textWidth(dl, ds, fm, 0.02f);
    float lh = normalLH(vs, fm);
    float w = 20 * s + cw + 2 * s + 2 * s + vw + dw + 26 * s, h = 6 * s + lh + 6 * s, x = 22 * s, y = H - 22 * s - h;
    pill(x, y, w, h, 0, s);
    // (display: flex, align-items: baseline: every part on the amount's baseline)
    float base = y + 6 * s + (lh - (ui.ascent(fm) - ui.descent(fm)) * vs) * 0.5f + ui.ascent(fm) * vs;
    auto onBase = [&](float px, float size, const vec4& c, const std::string& t) {
      float top = base - ui.ascent(fm) * size - (ui.lineHeight(size, fm) - (ui.ascent(fm) - ui.descent(fm)) * size) * 0.5f;
      return ui.text(px, top, size, fm, c, t, UiAlign::Left, 0.02f);
    };
    float px = x + 20 * s;
    px += onBase(px, cs, red, "$") + 2 * s + 2 * s;
    px += onBase(px, vs, blue, v);
    double age = save.clock - save.lastDeltaAt;
    if (!dl.empty() && age >= 0 && age < 1.9) {
      float k = float(std::clamp(std::min(age / 0.3, (1.9 - age) / 0.3), 0.0, 1.0));
      onBase(px + 10 * s, ds, a(save.lastDelta > 0 ? hex(0x63e29a) : hex(0xff6f6f), k), dl);
    }
  }

  // ---- the controls hint card (hud.js controlsHint, style.css .ch-card): bottom left, once per save
  if (save.tutorial && hintAt_ < 0 && !hintSeen_) controlsHint(now);
  if (hintAt_ >= 0 && now - hintAt_ > 3 && f.speed > 2) hintUntil_ = std::min(hintUntil_, now + 0.6);
  if (hintAt_ >= 0 && now - hintAt_ > 6 && save.tutorial) { save.tutorial = false; save.markDirty(); }
  if (hintAt_ >= 0 && now < hintUntil_) {
    hintSeen_ = true;
    float u = ui.cssU();
    // in 0.6 s after 0.8 s (hintIn: from -30u), out over 0.6 s (-24u)
    double tin = (now - hintAt_ - 0.8) / 0.6;
    float kin = float(std::clamp(tin, 0.0, 1.0)), kout = float(std::clamp((hintUntil_ - now) / 0.6, 0.0, 1.0));
    kin = 1 - (1 - kin) * (1 - kin) * (1 - kin);
    float k = std::min(kin, kout), slide = -30 * u * (1 - kin) - 24 * u * (1 - kout);
    bool pad = in.usingGamepad();
    platform::PadFamily fam = in.padFamily();
    auto L = [&](Action ac) { return prompts::bindLabel(in, ac, pad, fam); };
    std::vector<std::string> steer = pad ? std::vector<std::string>{"L STICK"} : std::vector<std::string>{L(Action::Left), L(Action::Right)};
    std::vector<std::string> fwd = pad ? std::vector<std::string>{"L STICK \xE2\x86\x91\xE2\x86\x93"} : std::vector<std::string>{L(Action::Forward), L(Action::Back)};
    struct Row { std::vector<std::string> keys; std::string label, what; bool air = false; };
    std::vector<Row> rows = {{steer, "", "Steer"}, {fwd, "", "Go / tuck \xC2\xB7 brake"}, {{L(Action::Jump)}, "", "Hold, release to jump"},
                             {{}, "IN THE AIR", "", true}, {{L(Action::Map)}, "", "Trail map"}, {{L(Action::Pause)}, "", "Pause \xC2\xB7 all controls"}};
    float xs = std::max(11 * d, 11 * u), sm = std::max(12 * d, 13 * u);
    const vec4 kfg = a(blue, k), kbg = a(ice, k), kbd = hex(0x1546c8, 0.42f * k);
    auto keysW = [&](const std::vector<std::string>& ks) { float w = 0; for (auto& kk : ks) w += ui.kcWidth(u, kk) + 4 * u; return ks.empty() ? 0 : w - 4 * u; };
    float spinW = ui.textWidth(" spin ", sm, UiFont::BodySemi), flipW = ui.textWidth(" flip ", sm, UiFont::BodySemi), grabW = ui.textWidth(" grab", sm, UiFont::BodySemi);
    float dotW = 4 * d + 6 * u;
    std::vector<std::string> grab = {L(Action::Sprint)};
    float airW = keysW(steer) + spinW + dotW + keysW(fwd) + flipW + dotW + keysW(grab) + grabW + 5 * u * 6;
    float col1 = ui.textWidth("IN THE AIR", xs, UiFont::BodyHeavy, 0.12f), col2 = airW;
    for (auto& r : rows) if (!r.air) { col1 = std::max(col1, keysW(r.keys)); col2 = std::max(col2, ui.textWidth(r.what, sm, UiFont::BodySemi)); }
    float kh = ui.kcHeight(u), rowH = std::max(kh, sm * 1.25f);
    float headH = xs, w = 24 * u + col1 + 14 * u + col2 + 30 * u;
    float h = 16 * u + headH + 2 * u + 7 * u + float(rows.size()) * rowH + float(rows.size() - 1) * 7 * u + 18 * u;
    float x = 22 * d + slide, y = H - 92 * d - h;
    static const std::vector<vec4> clip = {
      {0, 0, 0, 3}, {0.17f, 0, 0, 0}, {0.39f, 0, 0, 4}, {0.63f, 0, 0, 1}, {0.86f, 0, 0, 4}, {1, 0, 0, 0}, {1, -3, 0.36f, 0}, {1, 0, 0.70f, 0},
      {1, -2, 1, 0}, {0.74f, 0, 1, -4}, {0.49f, 0, 1, 0}, {0.24f, 0, 1, -3}, {0, 0, 1, 0}, {0, 3, 0.62f, 0}, {0, 0, 0.28f, 0}};
    std::vector<vec4> pts = clip;
    for (auto& p : pts) { p.y *= u; p.w *= u; }
    Ui::Shadow sh{0, 6 * d, 14 * d, a(shadowCol, k)};
    ui.clipPoly(x, y, w, h, a(white, k), pts, 0xC4C4, &sh);
    float yy = y + 16 * u;
    ui.textLH(x + 24 * u, yy, headH, xs, UiFont::BodyHeavy, a(red, k), "CONTROLS", UiAlign::Left, 0.18f);
    yy += headH + 2 * u + 7 * u;
    for (auto& r : rows) {
      float kx = x + 24 * u, ky = yy + (rowH - kh) / 2;
      auto caps = [&](const std::vector<std::string>& ks, float px) {
        for (auto& kk : ks) px += ui.kc(px, ky, u, kk, kfg, kbg, kbd) + 4 * u;
        return ks.empty() ? px : px - 4 * u;
      };
      float tx = x + 24 * u + col1 + 14 * u;
      if (r.air) {
        ui.textLH(kx, yy, rowH, xs, UiFont::BodyHeavy, a(blueDim, k), r.label, UiAlign::Left, 0.12f);
        float px = tx;
        auto word = [&](const char* t) { px += 5 * u; px += ui.textLH(px, yy, rowH, sm, UiFont::BodySemi, a(blue, k), t); };
        auto dot = [&]() { px += 5 * u + 3 * u; ui.circle(px + 2 * d, yy + rowH / 2, 2 * d, hex(0x1546c8, 0.4f * k)); px += 4 * d + 3 * u; };
        px = caps(steer, px + 1 * u); word("spin"); dot();
        px = caps(fwd, px + 5 * u + 1 * u); word("flip"); dot();
        px = caps(grab, px + 5 * u + 1 * u); word("grab");
      } else {
        caps(r.keys, kx);
        ui.textLH(tx, yy, rowH, sm, UiFont::BodySemi, a(blue, k), r.what);
      }
      yy += rowH + 7 * u;
    }
  }

  // ---- #speedo (bottom right): the speed (46px, line-height 1) with its unit, the skis / vehicle below
  if (showSpeedo && f.speedo) {
    bool mph = save.settingStr("speedUnit", "kmh") == "mph";
    char v[16];
    std::snprintf(v, sizeof v, "%d", int(std::round(f.speed * (mph ? 2.23694 : 3.6))));
    const UiFont fv = UiFont::CondSemiItalic;
    float vs = 46 * s, us = 12 * s, ns = 11 * s;
    const char* unit = mph ? "MPH" : "KM/H";
    float vw = ui.textWidth(v, vs, fv), uw = ui.textWidth(unit, us, UiFont::BodyBold, 0.08f);
    float sw = f.skiName.empty() ? 0 : ui.textWidth(f.skiName, ns, UiFont::BodyBold, 0.04f);
    float nameLH = normalLH(ns, UiFont::BodyBold);
    float lineW = vw + 4 * s + uw;
    float w = std::max(120 * s, std::max(lineW, sw) + 48 * s);
    float h = 8 * s + vs + (f.skiName.empty() ? 0 : 4 * s + nameLH) + 10 * s, x = W - 22 * s - w, y = H - 22 * s - h;
    pill(x, y, w, h, 0, s);
    float right = x + w - 22 * s;
    // the line box (line-height 1 for the number): its baseline, the unit on it
    float base = y + 8 * s + (vs - (ui.ascent(fv) - ui.descent(fv)) * vs) * 0.5f + ui.ascent(fv) * vs;
    auto onBase = [&](float px, float size, UiFont fnt, const vec4& c, const std::string& t, UiAlign al, float tr) {
      float top = base - ui.ascent(fnt) * size - (ui.lineHeight(size, fnt) - (ui.ascent(fnt) - ui.descent(fnt)) * size) * 0.5f;
      ui.text(px, top, size, fnt, c, t, al, tr);
    };
    onBase(right, us, UiFont::BodyBold, blueDim, unit, UiAlign::Right, 0.08f);
    onBase(right - uw - 4 * s, vs, fv, blue, v, UiAlign::Right, 0);
    if (!f.skiName.empty()) ui.textLH(right, y + 8 * s + vs + 4 * s, nameLH, ns, UiFont::BodyBold, blueDim, f.skiName, UiAlign::Right, 0.04f);
  }

  // ---- #prompt (bottom 84px, centred): the key (a blue 26px cap) and the action, 700 14px
  if (!f.prompt.empty()) {
    const UiFont fp = UiFont::BodyBold;
    float ks = 13 * s, kh = 26 * s;
    float kw = std::max(26 * s, ui.textWidth(f.promptKey, ks, UiFont::BodyBold) + 14 * s), tw = ui.textWidth(f.prompt, 14 * s, fp);
    float w = 12 * s + kw + 10 * s + tw + 22 * s, h = 9 * s + kh + 9 * s, x = W / 2 - w / 2, y = H - 84 * s - h;
    pill(x, y, w, h, 1, s);
    ui.roundRect(x + 12 * s, y + 9 * s, kw, kh, 7 * s, blue);
    ui.textLH(x + 12 * s + kw / 2, y + 9 * s, kh, ks, UiFont::BodyBold, white, f.promptKey, UiAlign::Center);
    ui.textLH(x + 12 * s + kw + 10 * s, y + 9 * s, kh, 14 * s, fp, blue, f.prompt);
  }

  // ---- #ride-hint (bottom 28px, centred): 700 13px on a --brush-a pill
  if (!f.rideHint.empty()) {
    float fs = 13 * d, lh = normalLH(fs, UiFont::BodyBold);
    float tw = ui.textWidth(f.rideHint, fs, UiFont::BodyBold), w = tw + 44 * d, h = lh + 14 * d, x = W / 2 - w / 2, y = H - 28 * d - h;
    pill(x, y, w, h, 0, d);
    ui.textLH(W / 2, y + 7 * d, lh, fs, UiFont::BodyBold, blue, f.rideHint, UiAlign::Center);
  }

  // ---- #fps-counter (top 6px, centred): white 700 11px on a dark rounded chip
  if (save.settingOn("showFps")) {
    char b[32];
    std::snprintf(b, sizeof b, "%.0f FPS", f.fps);
    float fs = 11 * d, tw = ui.textWidth(b, fs, UiFont::BodyBold, 0.04f), w = tw + 16 * d, h = fs * 1.3f + 4 * d, x = W / 2 - w / 2, y = 6 * d;
    ui.roundRect(x, y, w, h, 6 * d, hex(0x000e2c, 0.55f));
    ui.textLH(x + 8 * d, y + 2 * d, fs * 1.3f, fs, UiFont::BodyBold, white, b, UiAlign::Left, 0.04f);
  }
}

} // namespace sl
