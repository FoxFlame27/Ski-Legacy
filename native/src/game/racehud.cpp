#include "game/racehud.h"
#include "core/prompts.h"
#include "game/play.h"
#include "game/ui_widgets.h"
#include "platform/platform.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace sl {
using namespace ui_color;

namespace {
const float PIf = 3.14159265f;
const char* ordSuffix(int n) {
  int t = n % 100;
  if (t >= 11 && t <= 13) return "TH";
  switch (n % 10) { case 1: return "ST"; case 2: return "ND"; case 3: return "RD"; default: return "TH"; }
}
std::string fmtDelta(double d) { char b[32]; std::snprintf(b, sizeof b, "%s%.2f", d < 0 ? "\xE2\x88\x92" : "+", std::fabs(d)); return b; }
std::string fmtGap(double g) {
  if (!std::isfinite(g) || g < 0.005) return "\xE2\x80\x94";
  if (g < 60) { char b[32]; std::snprintf(b, sizeof b, "+%.2f", g); return b; }
  return "+" + fmtRaceTime(g);
}
float easeOut(double t) { float e = float(std::clamp(t, 0.0, 1.0)); return 1 - std::pow(1 - e, 3.f); }
/// text on a baseline (CSS align-items: baseline rows)
float baseText(Ui& ui, float x, float base, float size, UiFont f, const vec4& c, const std::string& s, UiAlign al = UiAlign::Left, float tracking = 0) {
  float top = base - ui.ascent(f) * size - (ui.lineHeight(size, f) - (ui.ascent(f) - ui.descent(f)) * size) * 0.5f;
  return ui.text(x, top, size, f, c, s, al, tracking);
}
/// the baseline of a line box (top, line-height lh) for a font size
float baseOf(const Ui& ui, float top, float lh, float size, UiFont f) { return top + lh / 2 + (ui.ascent(f) + ui.descent(f)) / 2 * size; }
/// "4.82" + "KM" / "184" + "M" (racehud.js fmtDist)
void distParts(double m, std::string& num, std::string& unit) {
  char b[32];
  if (m >= 1000) { std::snprintf(b, sizeof b, "%.2f", m / 1000); unit = "KM"; } else { std::snprintf(b, sizeof b, "%d", int(std::max(0.0, std::round(m)))); unit = "M"; }
  num = b;
}
} // namespace

void drawRaceHud(Ui& ui, const RaceHudState& s, float) {
  Ui::Tabular tab(ui);
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u);
  const UiFont NUM = UiFont::CondItalic;
  // the panels slide in: the left from the left, the clock from above, the right ones from the right
  auto slide = [&](double delay) { return easeOut((s.shownFor - delay) / 0.5); };
  // ---------------------------------------------------------------- top left: the position, the standings
  {
    float e = slide(0);
    ui.pushAlpha(e);
    ui.pushTranslate(-40 * u * (1 - e), 0);
    float x = 28 * u, y = 24 * u;
    if (!s.trial && s.position > 0) {
      std::string n = std::to_string(s.position), tot = s.total > 0 ? "/ " + std::to_string(s.total) : "";
      float wn = ui.textWidth(n, 84 * u, NUM), ws = ui.textWidth(ordSuffix(s.position), 34 * u, NUM), wt = tot.empty() ? 0 : 12 * u + ui.textWidth(tot, 30 * u, NUM);
      float lw = ui.textWidth("POSITION", tXs, UiFont::BodyHeavy, 0.16f);
      float w = 22 * u + std::max(lw, wn + 2 * u + ws + wt) + 34 * u, h = 12 * u + tXs + 4 * u + 84 * u * 0.9f + 10 * u;
      uiw::paper(ui, x, y, w, h, 301, 4, 3, u);
      ui.textLH(x + 22 * u, y + 12 * u, tXs, tXs, UiFont::BodyHeavy, blueDim, "POSITION", UiAlign::Left, 0.16f);
      float base = baseOf(ui, y + 12 * u + tXs + 4 * u, 84 * u * 0.9f, 84 * u, NUM), tx = x + 22 * u;
      tx += baseText(ui, tx, base, 84 * u, NUM, blue, n) + 2 * u;
      tx += baseText(ui, tx, base, 34 * u, NUM, blue, ordSuffix(s.position));
      if (!tot.empty()) baseText(ui, tx + 12 * u, base, 30 * u, NUM, blueDim, tot);
      y += h + 10 * u;
    }
    // the compact board: six rows (the top six, or the podium and the racer ahead of you, you, the one behind)
    if (!s.trial && s.standings.size() >= 2) {
      int n = int(s.standings.size()), me = -1;
      for (int i = 0; i < n; i++) if (s.standings[size_t(i)].me) me = i;
      std::vector<int> idx;
      for (int i = 0; i < std::min(6, n); i++) idx.push_back(i);
      if (me >= 6) { int a0 = std::min(me - 1, n - 3); idx = {0, 1, 2, a0, a0 + 1, a0 + 2}; }
      const float rowH = 6 * u + std::max(20 * u, tSm * 1.2f), nameMax = 190 * u;
      float nameW = 0, gapW = 0;
      std::vector<std::string> names, gaps;
      for (int i : idx) {
        const auto& r = s.standings[size_t(i)];
        names.push_back(uiw::ellipsis(ui, r.name, tSm, UiFont::BodySemi, nameMax));
        gaps.push_back(i == 0 ? "LEAD" : fmtGap(r.gap));
        nameW = std::max(nameW, ui.textWidth(names.back(), tSm, UiFont::BodySemi));
        gapW = std::max(gapW, ui.textWidth(gaps.back(), tXs, UiFont::BodyBold, 0.04f));
      }
      float inner = std::max(210 * u - 32 * u, 12 * u + 22 * u + 8 * u + nameW + 8 * u + gapW), w = inner + 32 * u;
      float h = 8 * u + 9 * u;
      for (size_t k = 0; k < idx.size(); k++) h += rowH + (k > 0 && idx[k] - idx[k - 1] > 1 ? 7 * u : 0);
      uiw::paper(ui, x, y, w, h, 306, 4, 3, u);
      float ry = y + 8 * u, rx = x + 14 * u;
      for (size_t k = 0; k < idx.size(); k++) {
        const auto& r = s.standings[size_t(idx[k])];
        if (k > 0 && idx[k] - idx[k - 1] > 1) {
          ry += 7 * u;
          for (float dx = rx + 6 * u; dx < rx + inner - 6 * u; dx += 5 * d) ui.rect(dx, ry - 5 * u, 2 * d, 2 * d, hex(0x1546c8, 0.28f));
        }
        if (r.me) ui.brushPanel(rx - 4 * u, ry, inner + 8 * u, rowH, blue, 1);
        const vec4 ink = r.me ? white : blue;
        float base = baseOf(ui, ry, rowH, tSm, UiFont::BodySemi);
        baseText(ui, rx + 6 * u, base, 20 * u, NUM, ink, std::to_string(idx[k] + 1));
        baseText(ui, rx + 6 * u + 22 * u + 8 * u, base, tSm, UiFont::BodySemi, ink, names[k]);
        baseText(ui, rx + inner - 6 * u, base, tXs, UiFont::BodyBold, r.me ? a(white, 0.85f) : blueDim, gaps[k], UiAlign::Right, 0.04f);
        ry += rowH;
      }
    }
    ui.popTransform();
    ui.popAlpha();
  }
  // ---------------------------------------------------------------- top centre: the clock, the penalty, the split
  {
    float e = slide(0.05);
    ui.pushAlpha(e);
    ui.pushTranslate(0, -30 * u * (1 - e));
    std::string t = fmtRaceTime(std::max(0.0, s.time));
    // (tabular numerals: the panel as wide as the digits at their widest, so it does not breathe)
    float fs = 56 * u, tw = ui.textWidth(t, fs, NUM, 0.01f), w = tw + 72 * u, h = 6 * u + fs * 1.05f + 4 * u, x = W / 2 - w / 2, y = 20 * u;
    uiw::paper(ui, x, y, w, h, 303, 3, 3, u);
    ui.textLH(W / 2 - ui.textWidth(t, fs, NUM, 0.01f) / 2, y + 6 * u, fs * 1.05f, fs, NUM, blue, t, UiAlign::Left, 0.01f);
    y += h;
    if (s.penalty > 0) {
      char b[48];
      std::snprintf(b, sizeof b, "+%.2f PENALTY", s.penalty);
      float pw = ui.textWidth(b, tXs, UiFont::BodyHeavy, 0.12f) + 32 * u, ph = 6 * u + tXs * 1.4f;
      y += 6 * u;
      ui.brushPanel(W / 2 - pw / 2, y, pw, ph, ko, 1);
      ui.textLH(W / 2 - pw / 2 + 16 * u, y + 3 * u, tXs * 1.4f, tXs, UiFont::BodyHeavy, white, b, UiAlign::Left, 0.12f);
      y += ph;
    }
    if (s.split.on && s.split.age < 2.9) {
      // spIn 0.38 s (from 14u above), out after 2.6 s (0.3 s, 10u up)
      float in = easeOut(s.split.age / 0.38), out = float(std::clamp((s.split.age - 2.6) / 0.3, 0.0, 1.0));
      std::string label = "CHECKPOINT " + std::to_string(s.split.index) + (s.split.total ? "/" + std::to_string(s.split.total) : "");
      std::string name = uiw::upper(s.split.name), ts = fmtRaceTime(s.split.split), ds = s.split.hasDelta ? fmtDelta(s.split.delta) : "";
      float lw = ui.textWidth(label, tXs, UiFont::BodyHeavy, 0.16f), nw = name.empty() ? 0 : 8 * u + ui.textWidth(name, tXs, UiFont::BodyHeavy, 0.1f);
      float tw2 = ui.textWidth(ts, 30 * u, NUM), dw = ds.empty() ? 0 : 14 * u + ui.textWidth(ds, 30 * u, NUM);
      float cw = 52 * u + lw + nw + 14 * u + tw2 + dw, ch = 16 * u + 30 * u, cx = W / 2 - cw / 2, cy = y + 10 * u - 14 * u * (1 - in) - 10 * u * out;
      ui.pushAlpha(in * (1 - out));
      uiw::paper(ui, cx, cy, cw, ch, 320 + s.split.index % 7, 3, 3, u);
      float base = baseOf(ui, cy + 8 * u, 30 * u, 30 * u, NUM), tx = cx + 26 * u;
      tx += baseText(ui, tx, base, tXs, UiFont::BodyHeavy, blueDim, label, UiAlign::Left, 0.16f);
      if (!name.empty()) tx += 8 * u + baseText(ui, tx + 8 * u, base, tXs, UiFont::BodyHeavy, blue, name, UiAlign::Left, 0.1f);
      tx += 14 * u;
      tx += baseText(ui, tx, base, 30 * u, NUM, blue, ts);
      if (!ds.empty()) baseText(ui, tx + 14 * u, base, 30 * u, NUM, s.split.delta > 0 ? ko : ok, ds);
      ui.popAlpha();
    }
    ui.popTransform();
    ui.popAlpha();
  }
  // ---------------------------------------------------------------- top right: the course, checkpoint, next, to finish
  {
    float e = slide(0.1);
    ui.pushAlpha(e);
    ui.pushTranslate(40 * u * (1 - e), 0);
    std::string course = uiw::upper(s.difficulty.empty() ? s.course : s.course + " \xC2\xB7 " + s.difficulty);
    course = uiw::ellipsis(ui, course, 22 * u, NUM, 300 * u, 0.03f);
    std::string cp = std::to_string(s.checkpoint) + " / " + std::to_string(s.checkpoints), nd, nu, fd, fu;
    if (s.hasNext) distParts(s.nextDist, nd, nu);
    if (s.toFinish >= 0) distParts(s.toFinish, fd, fu); else fd = "\xE2\x80\x94";
    const float vfs = 28 * u, sfs = vfs * 0.58f, rowH = vfs, lblTr = 0.16f;
    auto valW = [&](const std::string& n, const std::string& un) { return ui.textWidth(n, vfs, NUM) + (un.empty() ? 0 : ui.textWidth(un, sfs, NUM)); };
    float need = std::max({ui.textWidth(course, 22 * u, NUM, 0.03f),
                           ui.textWidth("CHECKPOINT", tXs, UiFont::BodyHeavy, lblTr) + 18 * u + ui.textWidth(cp, vfs, NUM),
                           s.hasNext ? ui.textWidth(s.nextLabel, tXs, UiFont::BodyHeavy, lblTr) + 18 * u + 29 * u + valW(nd, nu) : 0.f,
                           ui.textWidth("TO FINISH", tXs, UiFont::BodyHeavy, lblTr) + 18 * u + valW(fd, fu)});
    float inner = std::max(250 * u - 52 * u, need), w = inner + 52 * u;
    int rows = 2 + (s.hasNext ? 1 : 0);
    float h = 12 * u + (course.empty() ? 0 : 22 * u * 1.1f + 6 * u) + float(rows) * (4 * u + rowH) + 12 * u, x = W - 28 * u - w, y = 24 * u;
    uiw::paper(ui, x, y, w, h, 304, 4, 3, u);
    float ty = y + 12 * u, lx = x + 24 * u, rx = lx + inner;
    if (!course.empty()) { ui.textLH(lx, ty, 22 * u * 1.1f, 22 * u, NUM, blue, course, UiAlign::Left, 0.03f); ty += 22 * u * 1.1f + 6 * u; }
    auto row = [&](const std::string& label, const std::string& num, const std::string& unit, bool arrow, bool gate) {
      ty += 4 * u;
      float base = baseOf(ui, ty, rowH, vfs, NUM);
      baseText(ui, lx, base, tXs, UiFont::BodyHeavy, blueDim, label, UiAlign::Left, lblTr);
      float vx = rx;
      if (!unit.empty()) vx -= baseText(ui, vx, base, sfs, NUM, blue, unit, UiAlign::Right);
      vx -= baseText(ui, vx, base, vfs, NUM, blue, num, UiAlign::Right);
      if (arrow) {
        // .rh-arrow: 20u x 22u, polygon(50% 0, 100% 52%, 66% 52%, 66% 100%, 34% 100%, 34% 52%, 0 52%), rotated to the way
        float aw = 20 * u, ah = 22 * u, cx = vx - 9 * u - aw / 2, cy = ty + rowH / 2;
        float ang = float(std::round(std::clamp(s.nextAngle, -170.0, 170.0) / 3) * 3) * PIf / 180;
        ui.pushRotate(cx, cy, ang);
        const vec4 c = gate ? red : blue;
        auto P = [&](float fx, float fy) { return vec2(cx - aw / 2 + aw * fx, cy - ah / 2 + ah * fy); };
        ui.polyAA({P(0.5f, 0), P(1, 0.52f), P(0, 0.52f)}, c);
        ui.polyAA({P(0.34f, 0.5f), P(0.66f, 0.5f), P(0.66f, 1), P(0.34f, 1)}, c);
        ui.popTransform();
      }
      ty += rowH;
    };
    row("CHECKPOINT", cp, "", false, false);
    if (s.hasNext) row(s.nextLabel, nd, nu, true, s.nextLabel == "GATE");
    row("TO FINISH", fd, fu, false, false);
    // ---- bottom right: the speedometer and the course progress
    std::string kmh = std::to_string(int(std::lround(std::fabs(s.speed) * 3.6)));
    float kw = ui.textWidth(kmh, 64 * u, NUM), uw = ui.textWidth("KM/H", tXs, UiFont::BodyHeavy, 0.14f);
    float sInner = std::max(184 * u - 58 * u, kw + 8 * u + uw), sw = sInner + 58 * u, barH = std::max(4 * d, 6 * u), sh = 8 * u + 64 * u + 8 * u + barH + 14 * u;
    float sx = W - 28 * u - sw, sy = H - 24 * u - sh;
    uiw::paper(ui, sx, sy, sw, sh, 305, 4, 3, u);
    float base = baseOf(ui, sy + 8 * u, 64 * u, 64 * u, NUM), ex = sx + 30 * u + sInner;
    baseText(ui, ex, base, tXs, UiFont::BodyHeavy, blueDim, "KM/H", UiAlign::Right, 0.14f);
    baseText(ui, ex - uw - 8 * u, base, 64 * u, NUM, blue, kmh, UiAlign::Right);
    // .rh-prog: skewX(-20deg)
    float by = sy + 8 * u + 64 * u + 8 * u, bx = sx + 30 * u, sk = barH * 0.364f;
    auto bar = [&](float w0, const vec4& c) { if (w0 > 0.5f) ui.polyAA({vec2(bx + sk / 2, by), vec2(bx + w0 + sk / 2, by), vec2(bx + w0 - sk / 2, by + barH), vec2(bx - sk / 2, by + barH)}, c); };
    bar(sInner, bluePale);
    bar(sInner * float(std::clamp(s.progress, 0.0, 1.0)), blue);
    ui.popTransform();
    ui.popAlpha();
  }
  // ---------------------------------------------------------------- 3-2-1-GO
  if (!s.countdown.empty()) {
    bool go = s.countdown == "GO";
    double dur = go ? 1.2 : 1.0, t = s.countdownAge / dur;
    if (t < 1) {
      float al, sc;
      auto lerp = [](float a0, float b0, double k) { return a0 + (b0 - a0) * float(std::clamp(k, 0.0, 1.0)); };
      if (!go) {   // cdPop: 0 (1.9) -> 16% (1) -> 70% (0.96) -> 100% (0, 0.86)
        if (t < 0.16) { al = lerp(0, 1, easeOut(t / 0.16)); sc = lerp(1.9f, 1, easeOut(t / 0.16)); }
        else if (t < 0.7) { al = 1; sc = lerp(1, 0.96f, (t - 0.16) / 0.54); }
        else { al = lerp(1, 0, (t - 0.7) / 0.3); sc = lerp(0.96f, 0.86f, (t - 0.7) / 0.3); }
      } else {     // cdGo: 0 (2.3) -> 14% (1) -> 72% (1.04) -> 100% (0, 1.3)
        if (t < 0.14) { al = lerp(0, 1, easeOut(t / 0.14)); sc = lerp(2.3f, 1, easeOut(t / 0.14)); }
        else if (t < 0.72) { al = 1; sc = lerp(1, 1.04f, (t - 0.14) / 0.58); }
        else { al = lerp(1, 0, (t - 0.72) / 0.28); sc = lerp(1.04f, 1.3f, (t - 0.72) / 0.28); }
      }
      float w = (go ? 460 : 300) * u, h = 170 * u, cx = W / 2, cy = H * 0.42f;
      ui.pushAlpha(al);
      ui.pushScale(cx, cy, sc, sc);
      Ui::Shadow sh{0, 10 * u, 26 * u, hex(0x00143c, 0.35f)};
      int n = go ? 0 : std::atoi(s.countdown.c_str());
      ui.brushStroke(cx - w / 2, cy - h / 2, w, h, go ? blue : white, go ? 811 : 800 + n, go ? 460.f : 300.f, 170, &sh);
      // 136u numerals on a 157u line, centred in the stroke less 40u on the right
      ui.textLH(cx - 20 * u, cy - h / 2, 157 * u, 136 * u, NUM, go ? white : blue, s.countdown, UiAlign::Center, go ? 0.04f : 0.f);
      ui.popTransform();
      ui.popAlpha();
    }
  }
  // ---------------------------------------------------------------- the centre banner
  if (!s.notice.empty()) {
    float in = float(std::clamp(s.noticeAge / 0.2, 0.0, 1.0)), out = s.noticeFor > 0 ? float(std::clamp((s.noticeAge - s.noticeFor) / 0.2, 0.0, 1.0)) : 0.f;
    float al = in * (1 - out);
    if (al > 0.01f) {
      size_t len = utf8Decode(s.notice).size();
      float vw = std::round(std::min(1100.f, 170.f + float(len) * 30.f)), w = std::round(vw * 0.84f) * u, h = 84 * u;
      // (the label never leaves the stroke: a long line is fitted to it)
      float fs = 46 * u, maxText = w * Ui::brushTextEnd(vw, 100) - 40 * u, tw = ui.textWidth(s.notice, fs, NUM, 0.04f);
      if (w > W - 40 * u) { w = W - 40 * u; maxText = w * Ui::brushTextEnd(vw, 100) - 40 * u; }
      if (tw > maxText) fs *= maxText / tw;
      float cx = W / 2, cy = H * 0.34f, sc = 0.9f + 0.1f * easeOut(s.noticeAge / 0.3);
      ui.pushAlpha(al);
      ui.pushScale(cx, cy, sc, sc);
      Ui::Shadow sh{0, 8 * u, 18 * u, hex(0x00143c, 0.3f)};
      ui.brushStroke(cx - w / 2, cy - h / 2, w, h, white, 900 + int(len % 7), vw, 100, &sh);
      ui.textLH(cx - w / 2 + 40 * u, cy - h / 2, h, fs, NUM, s.noticeKind == 1 ? ko : s.noticeKind == 2 ? ok : blue, s.notice, UiAlign::Left, 0.04f);
      ui.popTransform();
      ui.popAlpha();
    }
  }
  // ---------------------------------------------------------------- the intro's letterbox and lower third
  if (s.third.on) {
    const auto& T = s.third;
    float bars = easeOut(T.age / 0.55) * (1 - easeOut((T.age - T.left) / 0.4));
    if (bars > 0.002f) {
      ui.rect(0, 0, W, 84 * u * bars, hex(0x040a16));
      ui.rect(0, H - 84 * u * bars, W, 84 * u * bars, hex(0x040a16));
    }
    float in = easeOut(T.age / 0.6), out = float(std::clamp((T.age - (T.left - 0.4)) / 0.35, 0.0, 1.0));
    if (in > 0.01f && out < 0.99f) {
      std::string title = uiw::upper(T.title);
      float tfs = 56 * u, tw = ui.textWidth(title, tfs, NUM, 0.02f), statsW = 0;
      for (size_t i = 0; i < T.stats.size(); i++)
        statsW += (i ? 34 * u : 0) + std::max(ui.textWidth(T.stats[i].first, tXs, UiFont::BodyHeavy, 0.16f), ui.textWidth(uiw::upper(T.stats[i].second), 30 * u, NUM));
      float maxInner = W - 144 * u - 84 * u;
      if (tw > maxInner) { tfs *= maxInner / tw; tw = maxInner; }
      float inner = std::max({420 * u - 84 * u, tw, statsW}), w = inner + 84 * u;
      float h = 16 * u + 56 * u + (T.stats.empty() ? 0 : 12 * u + tXs + 6 * u + 30 * u) + 18 * u;
      float x = 72 * u - 80 * u * (1 - in) - 50 * u * out, y = H - 112 * u - h;
      ui.pushAlpha(in * (1 - out));
      ui.pushClip(0, 0, x + w * in + 40 * u, H);
      uiw::paper(ui, x, y, w, h, 331, 4, 3, u);
      ui.rect(x + 14 * u, y + h * 0.2f, 6 * u, h * 0.6f, red);
      ui.textLH(x + 36 * u, y + 16 * u, 56 * u, tfs, NUM, blue, title, UiAlign::Left, 0.02f);
      float sx = x + 36 * u, sy = y + 16 * u + 56 * u + 12 * u;
      for (size_t i = 0; i < T.stats.size(); i++) {
        float al = easeOut((T.age - 0.34 - 0.08 * double(i)) / 0.4);
        ui.pushAlpha(al);
        std::string v = uiw::upper(T.stats[i].second);
        ui.textLH(sx, sy, tXs, tXs, UiFont::BodyHeavy, blueDim, T.stats[i].first, UiAlign::Left, 0.16f);
        ui.textLH(sx, sy + tXs + 6 * u, 30 * u, 30 * u, NUM, blue, v);
        ui.popAlpha();
        sx += std::max(ui.textWidth(T.stats[i].first, tXs, UiFont::BodyHeavy, 0.16f), ui.textWidth(v, 30 * u, NUM)) + 34 * u;
      }
      ui.popClip();
      if (!T.kicker.empty()) {
        // .pl3-kick: the red tab over the panel's top edge
        float kal = easeOut((T.age - 0.25) / 0.5), kh = 14 * u + tXs * 1.2f, kw = ui.textWidth(T.kicker, tXs, UiFont::BodyHeavy, 0.24f) + 44 * u;
        float ky = y - kh + 6 * u + 14 * u * (1 - kal);
        ui.pushAlpha(kal);
        ui.brushPanel(x + 18 * u, ky, kw, kh, red, 1);
        ui.textLH(x + 36 * u, ky + 7 * u, tXs * 1.2f, tXs, UiFont::BodyHeavy, white, T.kicker, UiAlign::Left, 0.24f);
        ui.popAlpha();
      }
      ui.popAlpha();
    }
  }
}

// ============================================================================ the results screen
std::string frameRaceResults(Ui& ui, const UiNav& nav, const Input& in, RaceResults& r, double now) {
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u), tMd = std::max(13 * d, 15 * u);
  const UiFont NUM = UiFont::CondItalic;
  Ui::Tabular tab(ui);
  if (r.shownAt < 0) r.shownAt = now;
  const double age = now - r.shownAt;
  if (r.choices.empty()) r.choices = {{"retry", "RETRY", "R"}, {"next", "NEXT", "ENTER"}, {"menu", "MENU", "ESC"}};
  const int nc = int(r.choices.size());
  if (r.focus < 0) {
    r.focus = 0;
    for (int i = 0; i < nc; i++) if (r.choices[size_t(i)].key == "ENTER") r.focus = i;
  }
  const bool pad = nav.usingPad, dnf = r.dnf || !std::isfinite(r.time), hasMedal = !dnf && r.medal >= 1 && r.medal <= 3;
  // ---- the buttons' boxes (centred row, 18u apart)
  struct Btn { float x, y, w; std::string cap; };
  std::vector<Btn> btns(static_cast<size_t>(nc));
  const float bh = 74 * u, bfs = 34 * u;
  float bw = 0;
  for (int i = 0; i < nc; i++) {
    const auto& c = r.choices[size_t(i)];
    std::string cap = pad ? (c.key == "ENTER" ? prompts::K(in, "confirm") : c.key == "ESC" ? prompts::K(in, "cancel") : "") : c.key;
    btns[size_t(i)].cap = cap;
    btns[size_t(i)].w = uiw::brushButtonWidth(ui, 270 * u, bh, bfs, c.label, u, cap);
    bw += btns[size_t(i)].w + (i ? 18 * u : 0);
  }
  // ---- heights: the hero, the table
  std::vector<int> lineKinds;   // 0 time, 1 medal (trial), 2 new pb, 3 pb, 4 penalties, 5 points, 6 prize, 7 prize 0
  if (!dnf && !r.trial && r.place > 0) lineKinds.push_back(0);
  if (r.trial && !dnf) lineKinds.push_back(1);
  if (r.pb && !dnf) lineKinds.push_back(2); else if (r.previousBest > 0) lineKinds.push_back(3);
  if (r.penalty > 0) lineKinds.push_back(4);
  if (r.points > 0) lineKinds.push_back(5);
  const bool mult = std::fabs(r.prizeMult - 1) > 1e-6;
  if (r.prize > 0) lineKinds.push_back(6); else if (mult && !dnf && !r.trial) lineKinds.push_back(7);
  float linesH = 0;
  for (size_t i = 0; i < lineKinds.size(); i++) linesH += (i ? 10 * u : 0) + (lineKinds[i] == 2 ? 50 * u : 34 * u);
  const float heroW = 460 * u, heroH = tXs + 8 * u + 38 * u + 18 * u + 170 * u + (lineKinds.empty() ? 0 : 18 * u + linesH);
  const bool big = r.rows.size() > 8;
  const float trH = (big ? 34 : 50) * u, thH = tXs + (big ? 8 : 10) * u + 2 * d, tPad = (big ? 14 : 18) * u, tPadB = (big ? 14 : 20) * u;
  const float tableW = 560 * u, tableMax = (big ? 600 : 470) * u;
  const bool table = !r.rows.empty();
  size_t shownRows = r.rows.size();
  float tableH = tPad + thH + trH * float(shownRows) + tPadB;
  while (table && tableH > tableMax && shownRows > 1) { shownRows--; tableH -= trH; }
  const float wrapH = std::max(heroH, table ? tableH : 0.f), totalH = wrapH + 40 * u + bh;
  const float top = std::max(48 * u, (H - totalH) / 2), wrapW = heroW + (table ? 64 * u + tableW : 0), wx = (W - wrapW) / 2;
  float bx = (W - bw) / 2;
  const float byB = top + wrapH + 40 * u;
  for (int i = 0; i < nc; i++) { btns[size_t(i)].x = bx; btns[size_t(i)].y = byB; bx += btns[size_t(i)].w + 18 * u; }

  // ---- input (racehud.js results: keys held from the run are ignored for 0.6 s)
  std::string chosen;
  auto has = [&](const char* id) { for (const auto& c : r.choices) if (c.id == id) return true; return false; };
  if (nav.mouse.x >= 0 && (nav.mouseMoved || nav.click))
    for (int i = 0; i < nc; i++) if (nav.mouse.x >= btns[size_t(i)].x && nav.mouse.x <= btns[size_t(i)].x + btns[size_t(i)].w && nav.mouse.y >= byB && nav.mouse.y <= byB + bh) { r.focus = i; if (nav.click) chosen = r.choices[size_t(i)].id; }
  if (age > 0.6 && chosen.empty()) {
    if (nav.left) r.focus = (r.focus + nc - 1) % nc;
    else if (nav.right) r.focus = (r.focus + 1) % nc;
    else if (nav.confirm) chosen = r.choices[size_t(r.focus)].id;
    else if (nav.cancel || nav.menu) {
      const RaceResults::Choice* c = nullptr;
      for (const auto& q : r.choices) if (q.key == "ESC") c = &q;
      if (!c) for (const auto& q : r.choices) if (q.key == "ENTER") c = &q;
      chosen = c ? c->id : r.choices.back().id;
    } else if (!pad && has("retry")) for (platform::Key k : nav.keys) if (k == platform::Key::KeyR) chosen = "retry";
  }

  // ---- draw
  ui.pushAlpha(float(std::clamp(age / 0.35, 0.0, 1.0)));
  ui.rectGradient(0, 0, W / 2, H, hex(0x040e22, 0.86f), hex(0x040e22, 0.64f));
  ui.rectGradient(W / 2, 0, W / 2, H, hex(0x040e22, 0.64f), hex(0x040e22, 0.46f));
  auto fadeSlide = [&](double delay, double dur = 0.4) { return easeOut((age - delay) / dur); };
  // the hero, vertically centred against the table
  {
    float x = wx, y = top + (wrapH - heroH) / 2;
    std::string kick = std::string(r.trial ? "WORLD RACING" : "RACE") + (!r.difficulty.empty() && !r.trial ? " \xC2\xB7 " + uiw::upper(r.difficulty) : "") + " \xC2\xB7 RESULTS";
    float e = fadeSlide(0.05);
    ui.pushAlpha(e);
    ui.textLH(x, y + 8 * u * (1 - e), tXs, tXs, UiFont::BodyHeavy, a(white, 0.82f), kick, UiAlign::Left, 0.24f);
    ui.popAlpha();
    y += tXs + 8 * u;
    e = fadeSlide(0.1, 0.45);
    ui.pushAlpha(e);
    std::string cn = uiw::upper(r.courseName);
    float cfs = 38 * u, cwid = ui.textWidth(cn, cfs, NUM, 0.02f);
    if (cwid > heroW) cfs *= heroW / cwid;
    ui.textShadow(x, y + 8 * u * (1 - e) + (38 * u - ui.lineHeight(cfs, NUM)) / 2, cfs, NUM, cn, UiAlign::Left, 0.02f, 0, 4 * u, 20 * u, a(hex(0x000000), 0.35f));
    ui.textLH(x, y + 8 * u * (1 - e), 38 * u, cfs, NUM, white, cn, UiAlign::Left, 0.02f);
    ui.popAlpha();
    y += 38 * u + 18 * u;
    // the place on its stroke (slam: 0.55 s after 0.2 s, from 1.4)
    {
      float k = easeOut((age - 0.2) / 0.55), sc = 1.4f - 0.4f * k, pw = 440 * u, ph = 170 * u;
      ui.pushAlpha(float(std::clamp((age - 0.2) / 0.2, 0.0, 1.0)));
      ui.pushScale(x + pw / 2, y + ph / 2, sc, sc);
      Ui::Shadow sh{0, 10 * u, 24 * u, a(hex(0x000000), 0.35f)};
      ui.brushStroke(x, y, pw, ph, white, 355, 520, 200, &sh);
      const vec4 ink = dnf ? ko : blue;
      float tx = x + 46 * u;
      if (dnf) { float base = baseOf(ui, y + (ph - 140 * u) / 2 - 7 * u, 140 * u, 140 * u, NUM); baseText(ui, tx, base, 140 * u, NUM, ink, "DNF"); }
      else if (r.trial || r.place <= 0) {
        float fs = (hasMedal ? 70 : 80) * u, base = baseOf(ui, y + (ph - fs) / 2 - 7 * u, fs, fs, NUM);
        baseText(ui, tx, base, fs, NUM, ink, fmtRaceTime(r.time));
      } else {
        float base = baseOf(ui, y + (ph - 140 * u) / 2 - 7 * u, 140 * u, 140 * u, NUM);
        tx += baseText(ui, tx, base, 140 * u, NUM, ink, std::to_string(r.place)) + 4 * u;
        baseText(ui, tx, base, 56 * u, NUM, ink, ordSuffix(r.place));
      }
      if (hasMedal) {
        // medalDrop: 0.7 s after 0.55 s (from 70u above, -25 degrees)
        float mk = easeOut((age - 0.55) / 0.7), m = 104 * u, mx = x + pw - 4 * u - m, my = y + ph / 2 - 66 * u - 70 * u * (1 - mk);
        ui.pushAlpha(float(std::clamp((age - 0.55) / 0.25, 0.0, 1.0)));
        ui.pushRotate(mx + m / 2, my + m * 0.61f, -25 * PIf / 180 * (1 - mk));
        uiw::medal(ui, mx, my, m, r.medal);
        ui.popTransform();
        ui.popAlpha();
      }
      ui.popTransform();
      ui.popAlpha();
    }
    y += 170 * u + 18 * u;
    const vec4 lab = a(white, 0.75f);
    for (size_t i = 0; i < lineKinds.size(); i++) {
      int k = lineKinds[i];
      float e2 = fadeSlide(k == 2 ? 0.9 : 0.6, k == 2 ? 0.6 : 0.4);
      ui.pushAlpha(e2);
      if (k == 2) {
        // .rr-pb: the red brush chip (pbPop)
        std::string g = r.previousBest > 0 ? fmtDelta(r.time - r.previousBest) : "";
        float tw = ui.textWidth("NEW PERSONAL BEST", 30 * u, NUM, 0.04f), gw = g.empty() ? 0 : 14 * u + ui.textWidth(g, 24 * u, NUM);
        float cw = 56 * u + tw + gw, ch = 50 * u, sc = 0.6f + 0.4f * e2;
        ui.pushScale(x + cw / 2, y + ch / 2, sc, sc);
        ui.brushPanel(x, y, cw, ch, red, 1);
        float base = baseOf(ui, y + 10 * u, 30 * u, 30 * u, NUM);
        baseText(ui, x + 28 * u, base, 30 * u, NUM, white, "NEW PERSONAL BEST", UiAlign::Left, 0.04f);
        if (!g.empty()) baseText(ui, x + 28 * u + tw + 14 * u, base, 24 * u, NUM, a(white, 0.92f), g);
        ui.popTransform();
        y += ch + 10 * u;
      } else {
        std::string label, val, em;
        vec4 vc = white, ec = white;
        std::string multS;
        if (mult) { char b[32]; std::snprintf(b, sizeof b, "%g", r.prizeMult); multS = std::string(" \xC2\xB7 ") + (r.difficulty.empty() ? "" : uiw::upper(r.difficulty) + " ") + "\xC3\x97" + b; }
        switch (k) {
          case 0: label = "TIME"; val = fmtRaceTime(r.time); break;
          case 1: label = "MEDAL"; val = hasMedal ? (r.medal == 1 ? "GOLD" : r.medal == 2 ? "SILVER" : "BRONZE") : "NONE"; break;
          case 3: label = "PERSONAL BEST"; val = fmtRaceTime(r.previousBest); if (!dnf) { em = fmtDelta(r.time - r.previousBest); ec = r.time - r.previousBest > 0 ? hex(0xff9a8f) : hex(0x7cf0a8); } break;
          case 4: { char b[32]; std::snprintf(b, sizeof b, "+%.2f", r.penalty); label = "PENALTIES"; val = b; vc = hex(0xff9a8f); break; }
          case 5: label = "TRICK POINTS"; val = uiw::thousands(r.points); break;
          case 6: label = "PRIZE MONEY" + multS; val = "+$" + uiw::thousands(r.prize); vc = hex(0xffd34d); break;
          default: label = "PRIZE MONEY" + multS; val = "$0"; break;
        }
        float base = baseOf(ui, y, 34 * u, 34 * u, NUM);
        float lw = std::max(140 * u, baseText(ui, x + 8 * u * (1 - e2), base, tXs, UiFont::BodyHeavy, lab, label, UiAlign::Left, 0.18f));
        float vw = baseText(ui, x + lw + 14 * u, base, 34 * u, NUM, vc, val);
        if (!em.empty()) baseText(ui, x + lw + 14 * u + vw + 14 * u, base, 24 * u, NUM, ec, em);
        y += 34 * u + 10 * u;
      }
      ui.popAlpha();
    }
  }
  // the table
  if (table) {
    float e = easeOut((age - 0.3) / 0.5), x = wx + heroW + 64 * u, y = top + (wrapH - tableH) / 2 + 30 * u * (1 - e);
    ui.pushAlpha(e);
    Ui::Shadow sh{0, 12 * u, 28 * u, a(hex(0x000000), 0.35f)};
    ui.brushClip(x, y, tableW, tableH, white, 360, 5, 4, u, &sh);
    // columns: 52u | 1fr | 120u | 96u, gaps 10u, inside 26u + 12u of padding
    const float ix = x + 26 * u + 12 * u, iw = tableW - 76 * u, c0 = 52 * u, c2 = 120 * u, c3 = 96 * u, g = 10 * u, c1 = iw - c0 - c2 - c3 - 3 * g;
    const float x1 = ix + c0 + g, r2 = ix + c0 + g + c1 + g + c2, r3 = ix + iw;
    float ty = y + tPad;
    auto th = [&](const char* s0, float tx, UiAlign al) { ui.textLH(tx, ty, tXs, tXs, UiFont::BodyHeavy, blueDim, s0, al, 0.16f); };
    if (!r.trial) th("POS", ix, UiAlign::Left);
    th(r.trial ? "RUN" : "RACER", x1, UiAlign::Left);
    th("TIME", r2 + tXs * 0.16f, UiAlign::Right);
    th(r.trial ? "YOU" : "GAP", r3 + tXs * 0.16f, UiAlign::Right);
    ty += thH;
    ui.rect(x + 26 * u, ty - 2 * d, tableW - 52 * u, 2 * d, hex(0x1546c8, 0.12f));
    const float pfs = (big ? 22 : 30) * u, tfs = (big ? 21 : 26) * u;
    for (size_t i = 0; i < shownRows; i++) {
      const auto& row = r.rows[i];
      bool out = row.dnf || !std::isfinite(row.time);
      float re = easeOut((age - 0.48 - double(i) * (big ? 0.04 : 0.07)) / 0.4);
      ui.pushAlpha(re * (out ? 0.55f : 1.f));
      float ry = ty + trH * float(i) + 8 * u * (1 - re);
      if (row.me) ui.brushPanel(x + 26 * u - 8 * u, ry + (big ? 1 : 3) * u, tableW - 52 * u + 16 * u, trH - (big ? 2 : 6) * u, blue, 1);
      else if (i + 1 < shownRows && !r.rows[i + 1].me) ui.rect(x + 26 * u, ry + trH - d, tableW - 52 * u, d, hex(0x1546c8, 0.08f));
      const vec4 ink = row.me ? white : blue;
      ui.textLH(ix, ry, trH, pfs, NUM, ink, out ? "\xE2\x80\x94" : std::to_string(i + 1));
      ui.textLH(x1, ry, trH, tMd, UiFont::BodySemi, ink, uiw::ellipsis(ui, row.name, tMd, UiFont::BodySemi, c1));
      ui.textLH(r2, ry, trH, tfs, NUM, ink, out ? "DNF" : fmtRaceTime(row.time), UiAlign::Right);
      ui.textLH(r3, ry, trH, tSm, UiFont::BodySemi, row.me ? a(white, 0.8f) : blueDim, out ? "\xE2\x80\x94" : fmtGap(row.gap), UiAlign::Right);
      ui.popAlpha();
    }
    ui.popAlpha();
  }
  // the buttons (fadeIn 0.5 s after 1 s)
  ui.pushAlpha(float(std::clamp((age - 1.0) / 0.5, 0.0, 1.0)));
  for (int i = 0; i < nc; i++) uiw::brushButton(ui, btns[size_t(i)].x, byB, 270 * u, bh, bfs, r.choices[size_t(i)].label, 370 + i * 3, i == r.focus, u, btns[size_t(i)].cap);
  ui.popAlpha();
  ui.popAlpha();
  return chosen;
}

} // namespace sl
