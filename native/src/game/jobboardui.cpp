#include "game/jobboardui.h"
#include "core/prompts.h"
#include "game/ui_widgets.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace sl {
using namespace ui_color;

namespace {
const float PIf = 3.14159265f;
const uint32_t PINS[4] = {0xd0342c, 0x1546c8, 0xe09a00, 0x129a46};
const float TILT[5] = {-2.2f, 1.7f, -1.2f, 2.4f, -1.8f};
const char* DIFF_LABEL[4] = {"MEDIUM", "EASY", "MEDIUM", "HARD"};
const uint32_t DIFF_COL[4] = {0x1546c8, 0x129a46, 0x1546c8, 0xd0342c};
const uint32_t INK = 0x44506a;
float easeOut(double t) { float e = float(std::clamp(t, 0.0, 1.0)); return 1 - std::pow(1 - e, 3.f); }
const char* kindName(const std::string& t) { return t == "delivery" ? "DELIVERY" : t == "rescue" ? "RESCUE" : t == "escort" ? "GUIDE" : t == "taxi" ? "TAXI" : "JOB"; }

/// jobboard.js ICONS in a 24-unit box of side s at (x, y)
void kindIcon(Ui& ui, const std::string& t, float x, float y, float s, const vec4& c) {
  const float k = s / 24, lw = 2 * k;
  auto P = [&](float px, float py) { return vec2(x + px * k, y + py * k); };
  auto L = [&](std::initializer_list<vec2> pts, bool closed = false) { ui.strokePath(std::vector<vec2>(pts), lw, c, closed); };
  if (t == "delivery") {
    L({P(3.5f, 7.5f), P(12, 3), P(20.5f, 7.5f), P(20.5f, 16.5f), P(12, 21), P(3.5f, 16.5f)}, true);
    L({P(3.5f, 7.5f), P(12, 12), P(20.5f, 7.5f)}); L({P(12, 12), P(12, 21)}); L({P(7.8f, 5.2f), P(16.2f, 9.7f)});
  } else if (t == "rescue") {
    ui.ring(x + 12 * k, y + 12 * k, 10.2f * k, lw, c);
    ui.rect(x + 10 * k, y + 6.8f * k, 4 * k, 10.4f * k, c); ui.rect(x + 6.8f * k, y + 10 * k, 10.4f * k, 4 * k, c);
  } else if (t == "escort") {
    L({P(5, 21), P(5, 3.5f)});
    ui.polyAA({P(5, 4), P(17, 4), P(14, 8), P(5, 8)}, vec4(c.x, c.y, c.z, c.w * 0.18f));
    ui.polyAA({P(5, 8), P(14, 8), P(17, 12), P(5, 12)}, vec4(c.x, c.y, c.z, c.w * 0.18f));
    L({P(5, 4), P(17, 4), P(14, 8), P(17, 12), P(5, 12)});
  } else if (t == "taxi") {
    L({P(4, 16.5f), P(4, 12), P(6, 7), P(18, 7), P(20, 12), P(20, 16.5f)}, true);
    L({P(4, 12), P(20, 12)}); L({P(9.5f, 4.5f), P(14.5f, 4.5f), P(14.5f, 7), P(9.5f, 7)}, true);
    ui.circle(x + 7.5f * k, y + 17.5f * k, 2.4f * k, c); ui.circle(x + 16.5f * k, y + 17.5f * k, 2.4f * k, c);
  }
}
void clockIcon(Ui& ui, float x, float y, float s, const vec4& c) {
  const float k = s / 24, lw = 2.4f * k;
  ui.ring(x + 12 * k, y + 12 * k, 10.2f * k, lw, c);
  ui.strokePath({vec2(x + 12 * k, y + 7 * k), vec2(x + 12 * k, y + 12 * k), vec2(x + 15 * k, y + 14 * k)}, lw, c);
}
/// .jb-pin: a glossy push pin
void pin(Ui& ui, float cx, float cy, float u, uint32_t col) {
  const float r = 9 * u;
  ui.boxShadow(cx - r, cy - r, 2 * r, 2 * r, r, 2 * u, 4 * u, 3 * u, hex(0x281000, 0.45f));
  vec4 c = hex(col), dark = vec4(c.x * 0.55f, c.y * 0.55f, c.z * 0.55f, 1);
  ui.circle(cx, cy, r, dark);
  for (int i = 1; i <= 6; i++) { float t = float(i) / 6; ui.circle(cx - r * 0.2f * t, cy - r * 0.28f * t, r * (1 - 0.62f * t), dark + (c - dark) * t); }
  ui.circle(cx - r * 0.28f, cy - r * 0.4f, r * 0.2f, a(white, 0.85f));
}
/// .jb-diff: three dots and the label; returns the width
float diffRow(Ui& ui, float x, float cy, int dlev, float u, bool draw, bool right = false) {
  dlev = std::clamp(dlev, 1, 3);
  const float fs = 10 * u, dot = 9 * u, w = 3 * dot + 3 * 4 * u + ui.textWidth(DIFF_LABEL[dlev], fs, UiFont::BodyHeavy, 0.12f);
  if (!draw) return w;
  if (right) x -= w;
  const vec4 c = hex(DIFF_COL[dlev]);
  for (int k = 1; k <= 3; k++) {
    float dx = x + float(k - 1) * (dot + 4 * u) + dot / 2;
    if (k <= dlev) ui.circle(dx, cy, dot / 2, c); else ui.ring(dx, cy, dot / 2, 1.5f * ui.dpr(), vec4(c.x, c.y, c.z, 0.55f));
  }
  ui.textLH(x + 3 * (dot + 4 * u), cy - fs / 2, fs, fs, UiFont::BodyHeavy, c, DIFF_LABEL[dlev], UiAlign::Left, 0.12f);
  return w;
}
/// .jb-btn: a 300 x 60 stroke with its label (wrapping to two lines where it must); returns the height
float jbBtn(Ui& ui, float x, float y, float w, const std::string& label, int seed, const vec4& fill, const vec4& ink, bool focus, bool disabled, float u, bool draw = true) {
  std::vector<std::string> L = uiw::wrap(ui, label, 22 * u, UiFont::CondItalic, w - 56 * u, 0.06f);
  float h = std::max(46 * u, 22 * u + float(L.size()) * 22 * u * 1.1f);
  if (!draw) return h;
  ui.pushAlpha(disabled ? 0.45f : 1.f);
  if (focus && !disabled) ui.pushTranslate(6 * u, 0);
  Ui::Shadow sh{0, 3 * u, 6 * u, hex(0x00143c, 0.22f)};
  ui.brushStroke(x, y, w, h, fill, seed, 300, 60, &sh);
  float ty = y + (h - float(L.size()) * 22 * u * 1.1f) / 2;
  for (const std::string& l : L) { ui.textLH(x + 22 * u, ty, 22 * u * 1.1f, 22 * u, UiFont::CondItalic, ink, l, UiAlign::Left, 0.06f); ty += 22 * u * 1.1f; }
  if (focus && !disabled) ui.popTransform();
  ui.popAlpha();
  return h;
}
std::string money(long long v) { return "$" + uiw::thousands(v); }
/// "$150-1,500 a fare" -> the amount whole and the rest small beside it
void payParts(const JobNote& o, std::string& amt, std::string& rest) {
  if (o.payText.empty()) { amt = money(o.reward); rest.clear(); return; }
  size_t sp = o.payText.find(' ');
  amt = o.payText.substr(0, sp);
  rest = sp == std::string::npos ? "" : o.payText.substr(sp + 1);
}

/// the board both screens hang on: the wooden frame, the header plank ("JOBS · place"), the cork face
struct BoardFrame { float bx, by, bw, bh, plankY, plankH, corkX, corkY, corkW, corkH; };
BoardFrame boardLayout(const Ui& ui, float in0) {
  const float u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  BoardFrame F;
  F.bw = std::min(1120 * u, W * 0.94f); F.bh = std::min(700 * u, H * 0.88f); F.bx = (W - F.bw) / 2; F.by = (H - F.bh) / 2 + 26 * u * (1 - in0);
  F.plankH = 16 * u + 30 * u; F.plankY = F.by + 26 * u - 6 * u;
  F.corkX = F.bx + 28 * u; F.corkY = F.plankY + F.plankH + 16 * u; F.corkW = F.bw - 56 * u; F.corkH = F.by + F.bh - 26 * u - F.corkY;
  return F;
}
void drawBoardFrame(Ui& ui, const BoardFrame& F, const std::string& bold, const std::string& rest, float in0) {
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  const UiFont NUM = UiFont::CondItalic;
  const float bx = F.bx, by = F.by, bw = F.bw, bh = F.bh, plankY = F.plankY, plankH = F.plankH, corkX = F.corkX, corkY = F.corkY, corkW = F.corkW, corkH = F.corkH;
  ui.gradientGrid(0, 0, W, H, 16, 12, [](float fx, float fy) {
    float r = std::min(1.f, std::hypot((fx - 0.5f) * 2, (fy - 0.45f) * 2) / 1.45f);
    return vec4(0.016f, 0.055f, 0.133f, 0.42f + 0.3f * r);
  });
  ui.pushAlpha(in0);
  ui.boxShadow(bx, by, bw, bh, 10 * u, 0, 30 * u, 80 * u, hex(0x000a1e, 0.55f));
  ui.roundRect(bx, by, bw, bh, 10 * u, hex(0x7e4b23));
  ui.pushClip(bx + 3 * u, by + 3 * u, bw - 6 * u, bh - 6 * u);
  ui.rectGradient(bx, by, bw, bh * 0.46f, hex(0x9b6232), hex(0x7e4b23), false);
  ui.rectGradient(bx, by + bh * 0.46f, bw, bh * 0.54f, hex(0x7e4b23), hex(0x6c3e1b), false);
  for (float gx = bx; gx < bx + bw; gx += 23 * u) { ui.rect(gx, by, 2 * u, bh, hex(0x3c1e0a, 0.16f)); ui.rect(gx + 9 * u, by, 2 * u, bh, hex(0xffdcaa, 0.06f)); }   // the larch's grain
  ui.rectGradient(bx, by + bh - 26 * u, bw, 26 * u, hex(0x281204, 0.f), hex(0x281204, 0.4f), false);
  ui.popClip();
  ui.roundRectStroke(bx, by, bw, bh, 10 * u, 3 * u, hex(0xffd6a0, 0.16f));
  for (float nx : {bx + 14.5f * u, bx + bw - 14.5f * u}) { ui.circle(nx, by + 14.5f * u + d, 4.5f * u, a(hex(0x000000), 0.4f)); ui.circle(nx, by + 14.5f * u, 4.5f * u, hex(0x8d857a)); ui.circle(nx - 1.2f * u, by + 13.2f * u, 2.2f * u, hex(0xd9d2c4)); }
  // the plank: JOBS · place
  {
    const float fs = 30 * u;
    std::string dot = " \xC2\xB7 ";
    float w0 = ui.textWidth(bold, fs, NUM, 0.08f), w1 = ui.textWidth(dot, fs, NUM, 0.08f), pfs = fs, w2 = ui.textWidth(rest, pfs, UiFont::CondSemiItalic, 0.04f);
    float maxW = bw - 56 * u - 92 * u;
    if (w0 + w1 + w2 > maxW && w2 > 0) { pfs *= std::max(0.5f, (maxW - w0 - w1) / w2); w2 = ui.textWidth(rest, pfs, UiFont::CondSemiItalic, 0.04f); }
    float pw = w0 + w1 + w2 + 92 * u, px = bx + (bw - pw) / 2;
    ui.boxShadow(px, plankY, pw, plankH, 4 * u, 0, 6 * u, 12 * u, hex(0x140800, 0.4f));
    ui.roundRect(px, plankY, pw, plankH, 4 * u, hex(0x45260f));
    ui.pushClip(px + u, plankY + u, pw - 2 * u, plankH - 2 * u);
    ui.rectGradient(px, plankY, pw, plankH, hex(0x5b3418), hex(0x45260f), false);
    for (float gx = px; gx < px + pw; gx += 13 * u) ui.rect(gx, plankY, 1.5f * u, plankH, hex(0x281406, 0.18f));
    ui.rect(px, plankY, pw, 2 * u, hex(0xffd296, 0.14f));
    ui.popClip();
    float tx = px + 46 * u;
    auto shadowed = [&](const std::string& t, float size, UiFont f, const vec4& c, float tr) {
      float yy = plankY + (plankH - ui.lineHeight(size, f)) / 2;
      ui.text(tx, yy + 2 * d, size, f, hex(0x140800, 0.5f), t, UiAlign::Left, tr);
      float w = ui.text(tx, yy, size, f, c, t, UiAlign::Left, tr);
      tx += w;
    };
    shadowed(bold, fs, NUM, white, 0.08f); shadowed(dot, fs, NUM, hex(0xf6ead4), 0.08f); shadowed(rest, pfs, UiFont::CondSemiItalic, hex(0xf2c88c), 0.04f);
  }
  // the cork face with its grain of dots
  {
    ui.roundRect(corkX, corkY, corkW, corkH, 4 * u, hex(0xc4935c));
    ui.pushClip(corkX, corkY, corkW, corkH);
    ui.rectGradient(corkX, corkY, corkW, corkH, hex(0xffeccd, 0.12f), hex(0x46240a, 0.16f), false);
    struct Layer { float step, ox, oy, r; uint32_t c; float al; };
    const Layer layers[3] = {{7, 0, 0, 1.2f, 0x603412, 0.36f}, {11, 3, 5, 1.2f, 0xffe8c4, 0.28f}, {17, 8, 2, 1.7f, 0x784218, 0.24f}};
    for (const Layer& ly : layers)
      for (float yy = corkY + ly.oy * d; yy < corkY + corkH; yy += ly.step * d)
        for (float xx = corkX + ly.ox * d; xx < corkX + corkW; xx += ly.step * d) ui.rect(xx - ly.r * d * 0.5f, yy - ly.r * d * 0.5f, ly.r * d, ly.r * d, hex(ly.c, ly.al));
    ui.rectGradient(corkX, corkY, corkW, 14 * u, hex(0x321804, 0.45f), hex(0x321804, 0.f), false);
    ui.popClip();
    ui.roundRectStroke(corkX, corkY, corkW, corkH, 4 * u, 2 * u, hex(0x3c1e08, 0.4f));
  }
}
struct HintPart { std::string t; bool key; };
void boardHint(Ui& ui, const BoardFrame& F, const std::vector<HintPart>& parts) {
  const float d = ui.dpr(), u = ui.cssU(), tXs = std::max(11 * d, 11 * u);
  float w = 0;
  for (const HintPart& p : parts) w += ui.textWidth(p.t, tXs, UiFont::BodyBold, 0.14f) + (p.key ? 12 * u + 6 * u : 6 * u);
  float x = F.bx + (F.bw - w) / 2, y = F.by + F.bh - 6 * u - tXs - 4 * u;
  for (const HintPart& p : parts) {
    float tw = ui.textWidth(p.t, tXs, UiFont::BodyBold, 0.14f);
    if (p.key) { ui.roundRect(x, y - 2 * u, tw + 12 * u, tXs + 4 * u + 4 * u, 3 * u, hex(0xfff0dc, 0.18f)); ui.textLH(x + 6 * u, y, tXs + 4 * u, tXs, UiFont::BodyBold, white, p.t, UiAlign::Left, 0.14f); x += tw + 12 * u + 6 * u; }
    else { ui.textLH(x, y, tXs + 4 * u, tXs, UiFont::BodyBold, hex(0xffe8c8, 0.75f), p.t, UiAlign::Left, 0.14f); x += tw + 6 * u; }
  }
}
} // namespace

bool frameJobBoard(Ui& ui, const UiNav& nav, const Input& in, JobBoardView& v, double, double now) {
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  (void)H;
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u);
  const UiFont NUM = UiFont::CondItalic;
  if (v.openedAt < 0) v.openedAt = now;
  const double age = now - v.openedAt;
  const int nOff = int(v.offers.size()), base = v.hasCurrent ? 2 : 0, nFocus = base + nOff;
  const bool busy = v.hasCurrent;
  if (v.focus < 0 || v.focus >= nFocus) v.focus = nFocus ? (v.hasCurrent ? 1 : 0) : -1;
  // ---- the board, the plank, the cork
  const float in0 = easeOut(age / 0.32);
  const BoardFrame F = boardLayout(ui, in0);
  const float bw = F.bw, bh = F.bh, bx = F.bx, by = F.by, corkX = F.corkX, corkY = F.corkY, corkW = F.corkW, corkH = F.corkH;
  // ---- the notes' boxes (flex: nowrap, each 282u wide where there is room, never under 200u; centred)
  struct Box { float x, y, w, h, rot; };
  const float gap = 30 * u, avail = corkW - 60 * u;
  const int nAll = nOff + (v.hasCurrent ? 1 : 0);
  float noteW = 282 * u, curW = 310 * u;
  if (nAll > 0) {
    float want = float(nOff) * noteW + (v.hasCurrent ? curW : 0) + float(nAll - 1) * gap;
    if (want > avail) { float k = (avail - float(nAll - 1) * gap) / (want - float(nAll - 1) * gap); noteW = std::max(std::min(200 * u, avail / std::max(1, nAll)), noteW * k); curW = std::max(std::min(200 * u, avail / std::max(1, nAll)), curW * k); }
  }
  struct NoteLayout { std::vector<std::string> title, brief, lock; std::string amt, rest; bool footWrap = false; float h = 0; };
  auto layNote = [&](const JobNote& o, float w, bool current) {
    NoteLayout L;
    const float iw = w - 48 * u, briefFs = std::max(12 * d, 14 * u);
    L.title = uiw::wrap(ui, o.title, 31 * u, NUM, iw, 0.01f);
    float h = 30 * u;
    if (o.locked && !current) { L.lock = uiw::wrap(ui, uiw::upper(o.lockText.empty() ? "Locked" : o.lockText), tXs, UiFont::BodyHeavy, iw - 4 * u, 0.06f); h += -18 * u + 6 * u + float(L.lock.size()) * tXs * 1.2f + 2 * u + 8 * u; }
    h += std::max(20 * u, tXs) + 8 * u + float(L.title.size()) * 31 * u * 1.02f;
    if (current) {
      if (!o.client.empty()) h += 8 * u + tSm;
      L.brief = uiw::wrap(ui, o.status, tSm, UiFont::BodyBold, iw);
      h += 8 * u + float(L.brief.size()) * tSm * 1.35f;
      h += 8 * u + jbBtn(ui, 0, 0, iw, "CANCEL JOB", 77, red, white, false, false, u, false) + 8 * u + jbBtn(ui, 0, 0, iw, "KEEP GOING", 78, white, blue, false, false, u, false);
    } else {
      L.brief = uiw::wrap(ui, o.brief, briefFs, UiFont::BodyMed, iw);
      if (L.brief.size() > 5) { L.brief.resize(5); L.brief[4] = uiw::ellipsis(ui, L.brief[4] + " \xE2\x80\xA6", briefFs, UiFont::BodyMed, iw); }   // (-webkit-line-clamp: 5)
      h += 8 * u + float(L.brief.size()) * briefFs * 1.42f;
      payParts(o, L.amt, L.rest);
      float payW = ui.textWidth(L.amt, 38 * u, NUM) + (L.rest.empty() ? 0 : 6 * u + ui.textWidth(L.rest, 17 * u, NUM, 0.02f)) + (o.bonus ? 4 * u + ui.textWidth("+ TIP", tXs, UiFont::BodyBold, 0.06f) : 0);
      float sideW = std::max(14 * u + 4 * u + ui.textWidth(o.minutes, tSm, UiFont::BodyBold), diffRow(ui, 0, 0, o.diff, u, false));
      L.footWrap = payW + 8 * u + sideW > iw;   // (the time and difficulty go under the pay, still right)
      float sideH = tSm + 5 * u + 10 * u;
      h += 8 * u + 1.5f * u + 8 * u + (L.footWrap ? 38 * u * 0.95f + 6 * u + sideH : std::max(38 * u * 0.95f, sideH));
    }
    h += 20 * u;
    L.h = std::max(340 * u, h);
    return L;
  };
  std::vector<NoteLayout> lay;
  std::vector<Box> boxes;
  NoteLayout curLay;
  Box curBox{};
  {
    float total = float(nOff) * noteW + (v.hasCurrent ? curW : 0) + float(std::max(0, nAll - 1)) * gap, x = corkX + (corkW - total) / 2;
    const float cy = corkY + 30 * u + (corkH - 70 * u) / 2 + 3 * u;
    if (v.hasCurrent) { curLay = layNote(v.current, curW, true); curBox = {x, cy - curLay.h / 2, curW, curLay.h, -1.4f}; x += curW + gap; }
    for (int i = 0; i < nOff; i++) { lay.push_back(layNote(v.offers[size_t(i)], noteW, false)); boxes.push_back({x, cy - lay.back().h / 2, noteW, lay.back().h, TILT[i % 5]}); x += noteW + gap; }
  }
  // the card (a note taken off the board)
  const bool detail = v.detail >= 0 && v.detail < nOff;
  const JobNote* dn = detail ? &v.offers[size_t(v.detail)] : nullptr;
  const float cardW = std::min(520 * u, W * 0.86f), cardIW = cardW - 80 * u;
  std::vector<std::string> dTitle, dBrief, dWarn;
  float cardH = 0, takeH = 0, backH = 0, factsH = 0;
  std::string takeLabel;
  std::vector<std::pair<std::string, std::string>> facts;
  std::vector<float> factX, factY;
  const bool dLocked = dn && !busy && dn->locked, dOff = dn && (busy || dLocked);
  if (dn) {
    dTitle = uiw::wrap(ui, dn->title, 38 * u, NUM, cardIW, 0.01f);
    dBrief = uiw::wrap(ui, dn->brief, 15 * u, UiFont::BodyMed, cardIW);
    if (busy) dWarn = uiw::wrap(ui, "You are already on a job: finish it or cancel it first.", tSm, UiFont::BodyBold, cardIW);
    else if (dLocked) dWarn = uiw::wrap(ui, dn->lockText.empty() ? "Not available yet" : dn->lockText, tSm, UiFont::BodyBold, cardIW);
    facts = {{"PAY", dn->payText.empty() ? money(dn->reward) : dn->payText}, {"TIP", !dn->tipText.empty() ? dn->tipText : dn->bonus ? "up to " + money(dn->bonus) : "\xE2\x80\x94"}, {"TIME", dn->minutes}, {"DIFFICULTY", ""}};
    // .jb-facts: flex-wrap, space-between
    std::vector<float> fw;
    for (size_t i = 0; i < facts.size(); i++) fw.push_back(std::max(ui.textWidth(facts[i].first, 10 * u, UiFont::BodyHeavy, 0.14f), i == 3 ? diffRow(ui, 0, 0, dn->diff, u, false) : ui.textWidth(facts[i].second, 26 * u, NUM, 0.01f)));
    const float rowH = 10 * u + 4 * u + 26 * u;
    size_t i0 = 0;
    float fy = 0;
    factX.assign(4, 0); factY.assign(4, 0);
    while (i0 < facts.size()) {
      size_t i1 = i0;
      float used = 0;
      while (i1 < facts.size() && (i1 == i0 || used + 10 * u + fw[i1] <= cardIW)) { used += (i1 > i0 ? 10 * u : 0) + fw[i1]; i1++; }
      float extra = i1 - i0 > 1 ? (cardIW - used) / float(i1 - i0 - 1) : 0, fx = 0;
      for (size_t k = i0; k < i1; k++) { factX[k] = fx; factY[k] = fy; fx += fw[k] + 10 * u + extra; }
      fy += rowH + 10 * u;
      i0 = i1;
    }
    factsH = 12 * u + fy - 10 * u + 12 * u;
    takeLabel = dn->takeText.empty() ? "TAKE THE JOB" : dn->takeText;
    const float halfW = (cardIW - 14 * u) / 2;
    takeH = jbBtn(ui, 0, 0, halfW, takeLabel, 61, blue, white, false, false, u, false);
    backH = jbBtn(ui, 0, 0, halfW, "BACK", 62, white, blue, false, false, u, false);
    cardH = 36 * u + std::max(20 * u, tXs) + 12 * u + float(dTitle.size()) * 38 * u * 1.02f + 12 * u + tSm + 12 * u + float(dBrief.size()) * 15 * u * 1.42f + 12 * u + factsH
            + (dWarn.empty() ? 0 : 12 * u + float(dWarn.size()) * tSm * 1.35f) + 12 * u + 6 * u + std::max(takeH, backH) + 30 * u;
  }
  const float cardX = (W - cardW) / 2, cardY = by + (bh - cardH) / 2;

  // ---- input
  const bool mouseOk = nav.mouse.x >= 0 && !nav.usingPad;
  auto inBox = [&](const Box& b) { return mouseOk && nav.mouse.x >= b.x && nav.mouse.x <= b.x + b.w && nav.mouse.y >= b.y && nav.mouse.y <= b.y + b.h; };
  auto inRect = [&](float x, float y, float w, float h) { return mouseOk && nav.mouse.x >= x && nav.mouse.x <= x + w && nav.mouse.y >= y && nav.mouse.y <= y + h; };
  bool close = false;
  int hoverNote = -1, hoverBtn = -1;
  // the current note's buttons
  const float cbW = curW - 48 * u;
  float cbY0 = 0, cbY1 = 0, cbH0 = 0, cbH1 = 0;
  if (v.hasCurrent) {
    cbH0 = jbBtn(ui, 0, 0, cbW, "CANCEL JOB", 77, red, white, false, false, u, false); cbH1 = jbBtn(ui, 0, 0, cbW, "KEEP GOING", 78, white, blue, false, false, u, false);
    cbY1 = curBox.y + curBox.h - 20 * u - cbH1; cbY0 = cbY1 - 8 * u - cbH0;
  }
  if (!detail) {
    for (int i = 0; i < nOff; i++) if (inBox(boxes[size_t(i)])) hoverNote = i;
    if (v.hasCurrent) { if (inRect(curBox.x + 24 * u, cbY0, cbW, cbH0)) hoverBtn = 0; else if (inRect(curBox.x + 24 * u, cbY1, cbW, cbH1)) hoverBtn = 1; }
    if (nav.mouseMoved && hoverNote >= 0) v.focus = base + hoverNote;
    if (nav.mouseMoved && hoverBtn >= 0) v.focus = hoverBtn;
    int step = (nav.right || nav.down ? 1 : 0) - (nav.left || nav.up ? 1 : 0);
    if (step && nFocus) v.focus = ((v.focus + step) % nFocus + nFocus) % nFocus;
    int press = -1;
    if (nav.confirm && v.focus >= 0) press = v.focus;
    if (nav.click && mouseOk) {
      if (hoverBtn >= 0) press = hoverBtn;
      else if (hoverNote >= 0) press = base + hoverNote;
      else if (!inRect(bx, by, bw, bh)) close = true;
    }
    if (press >= 0) {
      if (v.hasCurrent && press == 0) { auto f = v.cancel; auto c2 = v.closed; if (f) f(); if (c2) c2(); return false; }
      if (v.hasCurrent && press == 1) close = true;
      else if (press >= base && !busy) { v.detail = press - base; v.dFocus = v.offers[size_t(v.detail)].locked ? 1 : 0; v.detailAt = now; }
    }
    if (nav.cancel || nav.menu) close = true;
  } else {
    const float halfW = (cardIW - 14 * u) / 2, aY = cardY + cardH - 30 * u - std::max(takeH, backH);
    int hb = inRect(cardX + 40 * u, aY, halfW, takeH) ? 0 : inRect(cardX + 40 * u + halfW + 14 * u, aY, halfW, backH) ? 1 : -1;
    if (nav.mouseMoved && hb >= 0 && !(hb == 0 && dOff)) v.dFocus = hb;
    if (nav.left || nav.right || nav.up || nav.down) v.dFocus = dOff ? 1 : 1 - v.dFocus;
    int press = nav.confirm ? v.dFocus : -1;
    if (nav.click && mouseOk && now != v.detailAt) { if (hb >= 0) press = hb; else if (!inRect(cardX, cardY, cardW, cardH)) press = 1; }
    if (nav.cancel || nav.menu) press = 1;
    if (press == 0 && !dOff) { int i = v.detail; auto f = v.take; auto c2 = v.closed; if (f) f(i); if (c2) c2(); return false; }
    if (press == 1) v.detail = -1;
  }
  if (close) { if (v.closed) v.closed(); return false; }

  // ---- draw: the shade, the frame
  ui.pushAlpha(float(std::clamp(age / 0.22, 0.0, 1.0)));
  drawBoardFrame(ui, F, "JOBS", v.place, in0);
  if (!nAll) {
    ui.textLH(corkX + corkW / 2, corkY + corkH / 2 - 26 * u * 1.2f, 26 * u * 1.2f, 26 * u, NUM, hex(0x3c1e08, 0.75f), "Nothing pinned up right now.", UiAlign::Center, 0.04f);
    ui.textLH(corkX + corkW / 2, corkY + corkH / 2, 26 * u * 1.2f, 26 * u, NUM, hex(0x3c1e08, 0.75f), "Check back later.", UiAlign::Center, 0.04f);
  }
  // ---- the notes
  auto drawNote = [&](const JobNote& o, const NoteLayout& L, const Box& b, int idx, bool current, bool lifted, double delay) {
    float e = easeOut((age - delay) / 0.42), rot = b.rot, dy = -18 * u * (1 - e), sc = 1;
    const bool grey = o.locked && !current;
    if (lifted && !busy && !current) { rot *= 0.3f; dy -= 10 * u; sc = 1.04f; }
    const float cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ui.pushAlpha(e * (grey ? 0.62f : 1.f));
    ui.pushTranslate(0, dy);
    ui.pushRotate(cx, cy, rot * PIf / 180);
    ui.pushScale(cx, cy, sc, sc);
    Ui::Shadow sh = lifted && !busy && !current ? Ui::Shadow{0, 16 * u, 16 * u, hex(0x321602, 0.38f)} : Ui::Shadow{0, 5 * u, 7 * u, hex(0x321602, 0.42f)};
    ui.brushClip(b.x, b.y, b.w, b.h, current ? hex(0xffeeb5) : hex(0xfdf9f0), current ? 91 : 31 + idx * 7, 5, 3, u, &sh);
    // (a greyed-out note: its inks in grey)
    auto ink = [&](const vec4& c) { if (!grey) return c; float g = c.x * 0.3f + c.y * 0.59f + c.z * 0.11f; return vec4(g, g, g, c.w); };
    const float ix = b.x + 24 * u, iw = b.w - 48 * u, briefFs = std::max(12 * d, 14 * u);
    float ty = b.y + 30 * u;
    if (!L.lock.empty()) {
      // .jb-lock: the reason stamped above the title (in the flow: the note grows taller)
      float lw = 0;
      for (const std::string& l : L.lock) lw = std::max(lw, ui.textWidth(l, tXs, UiFont::BodyHeavy, 0.06f));
      float lh = 6 * u + float(L.lock.size()) * tXs * 1.2f, lx = b.x + b.w - 12 * u - (lw + 16 * u), ly = ty - 18 * u;
      ui.pushRotate(lx + (lw + 16 * u) / 2, ly + lh / 2, 4 * PIf / 180);
      ui.rect(lx, ly, lw + 16 * u, lh, hex(0x3a3a3a));
      float yy = ly + 3 * u;
      for (const std::string& l : L.lock) { ui.textLH(lx + 8 * u + (lw - ui.textWidth(l, tXs, UiFont::BodyHeavy, 0.06f)) / 2, yy, tXs * 1.2f, tXs, UiFont::BodyHeavy, white, l, UiAlign::Left, 0.06f); yy += tXs * 1.2f; }
      ui.popTransform();
      ty += -18 * u + lh + 2 * u + 8 * u;
    }
    const float kindH = std::max(20 * u, tXs);
    kindIcon(ui, o.type, ix, ty + (kindH - 20 * u) / 2, 20 * u, ink(red));
    ui.textLH(ix + 27 * u, ty, kindH, tXs, UiFont::BodyHeavy, ink(red), kindName(o.type), UiAlign::Left, 0.14f);
    ty += kindH + 8 * u;
    for (const std::string& l : L.title) { ui.textLH(ix, ty, 31 * u * 1.02f, 31 * u, NUM, ink(blue), l, UiAlign::Left, 0.01f); ty += 31 * u * 1.02f; }
    if (current) {
      // the stamp, the client, the status, CANCEL JOB / KEEP GOING
      {
        float sw = ui.textWidth("YOUR JOB", 15 * u, UiFont::CondHeavy, 0.1f) + 16 * u, shh = 6 * u + 15 * u, sx = b.x + b.w - 14 * u - sw, sy = b.y + 16 * u;
        ui.pushRotate(sx + sw / 2, sy + shh / 2, 6 * PIf / 180);
        ui.roundRectStroke(sx, sy, sw, shh, 4 * u, 2.5f * u, a(red, 0.85f));
        ui.textLH(sx + 8 * u, sy, shh, 15 * u, UiFont::CondHeavy, a(red, 0.85f), "YOUR JOB", UiAlign::Left, 0.1f);
        ui.popTransform();
      }
      if (!o.client.empty()) { ty += 8 * u; ui.textLH(ix, ty, tSm, tSm, UiFont::BodyBold, hex(0x6a7590), uiw::ellipsis(ui, o.client, tSm, UiFont::BodyBold, iw), UiAlign::Left, 0.02f); ty += tSm; }
      ty += 8 * u;
      for (const std::string& l : L.brief) { ui.textLH(ix, ty, tSm * 1.35f, tSm, UiFont::BodyBold, hex(INK), l); ty += tSm * 1.35f; }
      jbBtn(ui, ix, cbY0, cbW, "CANCEL JOB", 77, hex(0xd0342c), white, !detail && v.focus == 0, false, u);
      jbBtn(ui, ix, cbY1, cbW, "KEEP GOING", 78, hex(0xe9eefb), blue, !detail && v.focus == 1, false, u);
    } else {
      ty += 8 * u;
      for (const std::string& l : L.brief) { ui.textLH(ix, ty, briefFs * 1.42f, briefFs, UiFont::BodyMed, ink(hex(INK)), l); ty += briefFs * 1.42f; }
      // the foot at the bottom: the dashed rule, the pay (+ TIP), the time and how hard on the right
      const float sideH = tSm + 5 * u + 10 * u, payH = 38 * u * 0.95f, footH = L.footWrap ? payH + 6 * u + sideH : std::max(payH, sideH);
      float fy = b.y + b.h - 20 * u - footH;
      ui.dashPath({vec2(ix, fy - 8 * u), vec2(ix + iw, fy - 8 * u)}, 1.5f * u, ink(hex(0x1546c8, 0.22f)), 4 * u, 3 * u, false);
      {
        Ui::Tabular tab(ui);
        float base = fy + (L.footWrap ? payH : footH) - 38 * u * 0.12f;   // (align-items: flex-end)
        auto baseText = [&](float x, float size, UiFont f, const vec4& c, const std::string& t, float tr) {
          float top = base - ui.ascent(f) * size - (ui.lineHeight(size, f) - (ui.ascent(f) - ui.descent(f)) * size) * 0.5f;
          return ui.text(x, top, size, f, c, t, UiAlign::Left, tr);
        };
        float px = ix;
        px += baseText(px, 38 * u, NUM, ink(blue), L.amt, 0);
        if (!L.rest.empty()) px += 6 * u + baseText(px + 6 * u, 17 * u, NUM, ink(blue), L.rest, 0.02f);
        if (o.bonus) baseText(px + 4 * u, tXs, UiFont::BodyBold, ink(ok), "+ TIP", 0.06f);
      }
      float sy = L.footWrap ? fy + payH + 6 * u : fy + footH - sideH, sr = ix + iw;
      float tw = ui.textWidth(o.minutes, tSm, UiFont::BodyBold);
      clockIcon(ui, sr - tw - 4 * u - 14 * u, sy + (tSm - 14 * u) / 2, 14 * u, ink(hex(INK)));
      ui.textLH(sr - tw, sy, tSm, tSm, UiFont::BodyBold, ink(hex(INK)), o.minutes);
      if (grey) { ui.pushAlpha(0.7f); }
      diffRow(ui, sr, sy + tSm + 5 * u + 5 * u, o.diff, u, true, true);
      if (grey) ui.popAlpha();
      if (busy) ui.brushClip(b.x, b.y, b.w, b.h, hex(0xc4935c, 0.38f), 31 + idx * 7, 5, 3, u);
    }
    pin(ui, cx, b.y + 2 * u + (lifted && !busy && !current ? 2 * u : 0), u, current ? 0xd0342c : grey ? 0x8a8a8a : PINS[idx % 4]);
    ui.popTransform(); ui.popTransform(); ui.popTransform();
    ui.popAlpha();
  };
  if (v.hasCurrent) drawNote(v.current, curLay, curBox, 0, true, false, 0);
  const int lifted = detail ? -1 : hoverNote >= 0 ? hoverNote : (!mouseOk || !nav.mouseMoved) && v.focus >= base ? v.focus - base : -1;
  for (int i = 0; i < nOff; i++) if (i != lifted) drawNote(v.offers[size_t(i)], lay[size_t(i)], boxes[size_t(i)], i, false, false, 0.06 + 0.06 * i);
  if (lifted >= 0 && lifted < nOff) drawNote(v.offers[size_t(lifted)], lay[size_t(lifted)], boxes[size_t(lifted)], lifted, false, true, 0.06 + 0.06 * lifted);
  // the hint along the bottom edge
  if (nav.usingPad) boardHint(ui, F, {{prompts::K(in, "select"), true}, {"PICK A NOTE", false}, {prompts::K(in, "confirm"), true}, {"READ IT", false}, {prompts::K(in, "cancel"), true}, {"CLOSE", false}});
  else boardHint(ui, F, {{"CLICK A NOTE TO READ IT", false}, {prompts::K(in, "cancel"), true}, {"CLOSE", false}});
  // ---- the card
  if (dn) {
    float e = easeOut((now - v.detailAt) / 0.3);
    ui.pushAlpha(e);
    ui.roundRect(bx, by, bw, bh, 10 * u, hex(0x281202, 0.35f));
    const float cx = cardX + cardW / 2, cy = cardY + cardH / 2, sc = 0.92f + 0.08f * e;
    ui.pushTranslate(0, 30 * u * (1 - e));
    ui.pushRotate(cx, cy, (-0.8f - 2.2f * (1 - e)) * PIf / 180);
    ui.pushScale(cx, cy, sc, sc);
    Ui::Shadow sh{0, 22 * u, 30 * u, hex(0x1e0c00, 0.5f)};
    ui.brushClip(cardX, cardY, cardW, cardH, hex(0xfcf8ed), 57, 7, 4, u, &sh);
    const float ix = cardX + 40 * u, kindH = std::max(20 * u, tXs);
    float ty = cardY + 36 * u;
    kindIcon(ui, dn->type, ix, ty + (kindH - 20 * u) / 2, 20 * u, red);
    ui.textLH(ix + 27 * u, ty, kindH, tXs, UiFont::BodyHeavy, red, kindName(dn->type), UiAlign::Left, 0.14f);
    ty += kindH + 12 * u;
    for (const std::string& l : dTitle) { ui.textLH(ix, ty, 38 * u * 1.02f, 38 * u, NUM, blue, l, UiAlign::Left, 0.01f); ty += 38 * u * 1.02f; }
    ty += 12 * u;
    ui.textLH(ix, ty, tSm, tSm, UiFont::BodyBold, hex(0x6a7590), uiw::ellipsis(ui, dn->client, tSm, UiFont::BodyBold, cardIW, 0.02f), UiAlign::Left, 0.02f);
    ty += tSm + 12 * u;
    for (const std::string& l : dBrief) { ui.textLH(ix, ty, 15 * u * 1.42f, 15 * u, UiFont::BodyMed, hex(0x34405a), l); ty += 15 * u * 1.42f; }
    ty += 12 * u;
    ui.dashPath({vec2(ix, ty), vec2(ix + cardIW, ty)}, 1.5f * u, hex(0x1546c8, 0.22f), 4 * u, 3 * u, false);
    ui.dashPath({vec2(ix, ty + factsH), vec2(ix + cardIW, ty + factsH)}, 1.5f * u, hex(0x1546c8, 0.22f), 4 * u, 3 * u, false);
    {
      Ui::Tabular tab(ui);
      for (size_t i = 0; i < facts.size(); i++) {
        float fx = ix + factX[i], fy = ty + 12 * u + factY[i];
        ui.textLH(fx, fy, 10 * u, 10 * u, UiFont::BodyHeavy, hex(0x8a93a8), facts[i].first, UiAlign::Left, 0.14f);
        if (i == 3) diffRow(ui, fx, fy + 10 * u + 4 * u + 13 * u, dn->diff, u, true);
        else ui.textLH(fx, fy + 10 * u + 4 * u, 26 * u, 26 * u, NUM, i == 1 ? ok : blue, facts[i].second, UiAlign::Left, 0.01f);
      }
    }
    ty += factsH;
    if (!dWarn.empty()) { ty += 12 * u; for (const std::string& l : dWarn) { ui.textLH(ix, ty, tSm * 1.35f, tSm, UiFont::BodyBold, ko, l); ty += tSm * 1.35f; } }
    const float halfW = (cardIW - 14 * u) / 2, aY = cardY + cardH - 30 * u - std::max(takeH, backH);
    jbBtn(ui, ix, aY, halfW, takeLabel, 61, blue, white, v.dFocus == 0, dOff, u);
    jbBtn(ui, ix + halfW + 14 * u, aY, halfW, "BACK", 62, hex(0xe9eefb), blue, v.dFocus == 1, false, u);
    pin(ui, cx, cardY + 11 * u, u, PINS[v.detail % 4]);
    ui.popTransform(); ui.popTransform(); ui.popTransform();
    ui.popAlpha();
  }
  ui.popAlpha();
  ui.popAlpha();
  return true;
}

// ============================================================================ the RACING stand
namespace {
/// .diff-sign: the piste-style sign of a course's level (a green disc, a blue square, a black diamond, ringed red for Expert)
void diffSign(Ui& ui, float cx, float cy, const std::string& level, float u) {
  const float d = ui.dpr(), s = std::max(9 * d, 13 * u), ring = std::max(1.5f * d, 2 * u);
  std::string l;
  for (char c : level) l += char(std::tolower(static_cast<unsigned char>(c)));
  if (l == "easy") { ui.circle(cx, cy, s / 2 + ring, white); ui.circle(cx, cy, s / 2, hex(0x1f9d4a)); return; }
  if (l == "hard" || l == "expert") {
    const float k = s * 0.86f * 0.7071f;
    auto dia = [&](float r, const vec4& c) { ui.polyAA({vec2(cx, cy - r), vec2(cx + r, cy), vec2(cx, cy + r), vec2(cx - r, cy)}, c); };
    if (l == "expert") dia(k + std::max(3 * d, 4 * u) * 1.2f, hex(0xd9221c));
    dia(k + ring * 1.2f, white); dia(k, hex(0x111111));
    return;
  }
  ui.rect(cx - s / 2 - ring, cy - s / 2 - ring, s + 2 * ring, s + 2 * ring, white);
  ui.rect(cx - s / 2, cy - s / 2, s, s, hex(0x1f5fd6));
}
std::string ordLow(int n) { int t = n % 100; return std::to_string(n) + (t >= 11 && t <= 13 ? "th" : n % 10 == 1 ? "st" : n % 10 == 2 ? "nd" : n % 10 == 3 ? "rd" : "th"); }
} // namespace

bool frameRaceStand(Ui& ui, const UiNav& nav, const Input& in, RaceStandView& v, double dt, double now) {
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u);
  const UiFont NUM = UiFont::CondItalic;
  if (v.openedAt < 0) v.openedAt = now;
  const double age = now - v.openedAt;
  const int n = int(v.courses.size());
  if (!n) { if (v.closed) v.closed(); return false; }
  v.i = std::clamp(v.i, 0, n - 1);
  const float in0 = easeOut(age / 0.32);
  const BoardFrame F = boardLayout(ui, in0);
  // the two notes share the cork 1.12 : 1 (.rs-cork: stretch, 28u apart; padding 30u 30u 40u)
  const float ax = F.corkX + 30 * u, ay = F.corkY + 30 * u + 6 * u, aw = F.corkW - 60 * u, ah = F.corkH - 70 * u - 6 * u;
  const float lw = (aw - 28 * u) * 1.12f / 2.12f, cw = aw - 28 * u - lw, lx = ax, cx0 = ax + lw + 28 * u;
  // the list's rows
  const float small = std::max(11 * d, 12 * u), rowH = 14 * u + 21 * u * 1.05f + 3 * u + small * 1.2f, rowsY = ay + 26 * u + std::max(20 * u, tXs) + 10 * u, rowsH = ay + ah - 18 * u - rowsY;
  const float contentH = float(n) * (rowH + 4 * u) - 4 * u, maxScroll = std::max(0.f, contentH - rowsH);
  // the card's buttons and the difficulty switch
  static const char* DIFFS[4] = {"EASY", "MEDIUM", "HARD", "SUPERHARD"};
  const float cix = cx0 + 30 * u, ciw = cw - 60 * u, halfW = (ciw - 14 * u) / 2;
  const float bH = std::max(jbBtn(ui, 0, 0, halfW, "START RACE", 61, blue, white, false, false, u, false), jbBtn(ui, 0, 0, halfW, "CLOSE", 62, white, blue, false, false, u, false));
  const float actY = ay + ah - 20 * u - bH;
  const RaceStandView::C& c = v.courses[size_t(v.i)];
  std::vector<std::string> title = uiw::wrap(ui, c.name, 34 * u, NUM, ciw, 0.01f), brief = uiw::wrap(ui, c.tagline, std::max(12 * d, 14 * u), UiFont::BodyMed, ciw);
  if (brief.size() > 2) { brief.resize(2); brief[1] = uiw::ellipsis(ui, brief[1] + " \xE2\x80\xA6", std::max(12 * d, 14 * u), UiFont::BodyMed, ciw); }
  const float kindH = std::max(20 * u, tXs), briefFs = std::max(12 * d, 14 * u);
  float ty0 = ay + 26 * u;
  const float titleY = ty0 + kindH + 8 * u, briefY = titleY + float(title.size()) * 34 * u * 1.02f + 8 * u, factsY = briefY + float(brief.size()) * briefFs * 1.42f + 8 * u;
  const float factsH = 18 * u + 10 * u + 4 * u + 21 * u, diffLY = factsY + factsH + 9 * u + 2 * u, diffY = diffLY + 10 * u + 9 * u, diffH = 38 * u, funY = diffY + diffH + 9 * u + 4 * u;
  const float dbw = (ciw - 18 * u) / 4;

  // ---- input (racestand.js key())
  const bool mouseOk = nav.mouse.x >= 0 && !nav.usingPad;
  auto inRect = [&](float x, float y, float w, float h) { return mouseOk && nav.mouse.x >= x && nav.mouse.x <= x + w && nav.mouse.y >= y && nav.mouse.y <= y + h; };
  int hoverRow = -1, hoverDiff = -1;
  if (inRect(lx, rowsY, lw, rowsH)) for (int k = 0; k < n; k++) { float ry = rowsY + float(k) * (rowH + 4 * u) - v.scroll; if (nav.mouse.y >= ry && nav.mouse.y <= ry + rowH) hoverRow = k; }
  for (int k = 0; k < 4; k++) if (inRect(cix + float(k) * (dbw + 6 * u), diffY, dbw, diffH)) hoverDiff = k;
  const bool hoverStart = inRect(cix, actY, halfW, bH), hoverClose = inRect(cix + halfW + 14 * u, actY, halfW, bH);
  bool close = false, start = false;
  v.frames++;
  if (v.frames > 1) {
    if (nav.cancel || nav.menu) close = true;
    else if (nav.up) { v.i = (v.i + n - 1) % n; v.reveal = true; }
    else if (nav.down) { v.i = (v.i + 1) % n; v.reveal = true; }
    else if (nav.left) v.diff = std::max(0, v.diff - 1);
    else if (nav.right) v.diff = std::min(3, v.diff + 1);
    else if (nav.confirm) start = true;
    if (nav.click && mouseOk) {
      if (hoverRow >= 0) v.i = hoverRow;
      else if (hoverDiff >= 0) v.diff = hoverDiff;
      else if (hoverStart) start = true;
      else if (hoverClose || !inRect(F.bx, F.by, F.bw, F.bh)) close = true;
    }
  }
  if (nav.wheel != 0 && inRect(lx, rowsY, lw, rowsH)) v.scrollTarget = std::clamp(v.scrollTarget - nav.wheel * 48 * u, 0.f, maxScroll);
  if (std::fabs(nav.stickR.y) > 0.2f) v.scrollTarget = std::clamp(v.scrollTarget + nav.stickR.y * float(dt) * 900 * u, 0.f, maxScroll);
  if (start) { int ci = v.i, df = v.diff; auto f = v.start; auto c2 = v.closed; if (c2) c2(); if (f) f(ci, df); return false; }
  if (close) { if (v.closed) v.closed(); return false; }
  if (v.reveal) {
    v.reveal = false;
    float ry = float(v.i) * (rowH + 4 * u);
    if (ry < v.scrollTarget) v.scrollTarget = ry; else if (ry + rowH > v.scrollTarget + rowsH) v.scrollTarget = ry + rowH - rowsH;
  }
  v.scrollTarget = std::clamp(v.scrollTarget, 0.f, maxScroll);
  v.scroll += (v.scrollTarget - v.scroll) * float(1 - std::exp(-dt * 14));

  // ---- draw
  ui.pushAlpha(float(std::clamp(age / 0.22, 0.0, 1.0)));
  drawBoardFrame(ui, F, "RACING", "just for fun", in0);
  // the list note (rotate -0.8deg)
  {
    float e = easeOut(age / 0.42);
    ui.pushAlpha(e);
    ui.pushTranslate(0, -18 * u * (1 - e));
    ui.pushRotate(lx + lw / 2, ay + ah / 2, -0.8f * PIf / 180);
    Ui::Shadow sh{0, 6 * u, 8 * u, hex(0x321602, 0.42f)};
    ui.brushClip(lx, ay, lw, ah, hex(0xfdf9f0), 31, 5, 3, u, &sh);
    ui.textLH(lx + 18 * u, ay + 26 * u, kindH, tXs, UiFont::BodyHeavy, red, "COURSES", UiAlign::Left, 0.14f);
    ui.popTransform();
    // (the rows are drawn upright: the scrolling list is clipped)
    ui.pushClip(lx, rowsY, lw + 10 * u, rowsH);
    for (int k = 0; k < n; k++) {
      const RaceStandView::C& q = v.courses[size_t(k)];
      float ry = rowsY + float(k) * (rowH + 4 * u) - v.scroll, rx = lx + 18 * u + (k == v.i ? 6 * u : 0), rw = lw - 36 * u - 4 * u;
      if (ry + rowH < rowsY || ry > rowsY + rowsH) continue;
      bool sel = k == v.i;
      if (sel) ui.roundRect(rx, ry, rw, rowH, 4 * u, blue); else if (hoverRow == k) ui.roundRect(rx, ry, rw, rowH, 4 * u, hex(0x1546c8, 0.07f));
      const vec4 ink = sel ? white : blue;
      char num[8];
      std::snprintf(num, sizeof num, "%02d", k + 1);
      ui.textLH(rx + 12 * u, ry, rowH, 22 * u, NUM, vec4(ink.x, ink.y, ink.z, 0.6f), num);
      std::string place = q.bestPlace > 0 ? ordLow(q.bestPlace) : "";
      float signW = std::max(9 * d, 13 * u) + 6 * u, lvlW = signW + (place.empty() ? 0 : 8 * u + ui.textWidth(place, 16 * u, NUM));
      float right = rx + rw - 12 * u, nx = rx + 12 * u + 30 * u + 12 * u, availW = right - lvlW - 12 * u - nx;
      if (ry >= rowsY - 1 && ry + rowH <= rowsY + rowsH + 1) diffSign(ui, right - lvlW + signW / 2, ry + rowH / 2, q.level, u);
      if (!place.empty()) ui.textLH(right, ry, rowH, 16 * u, NUM, ink, place, UiAlign::Right);
      ui.textLH(nx, ry + 7 * u, 21 * u * 1.05f, 21 * u, NUM, ink, uiw::ellipsis(ui, q.name, 21 * u, NUM, availW));
      ui.textLH(nx, ry + 7 * u + 21 * u * 1.05f + 3 * u, small * 1.2f, small, UiFont::BodySemi, sel ? a(white, 0.78f) : hex(0x6a7590), uiw::ellipsis(ui, q.tagline, small, UiFont::BodySemi, availW));
    }
    ui.popClip();
    pin(ui, lx + lw / 2, ay + 2 * u, u, 0x1546c8);
    ui.popTransform();
    ui.popAlpha();
  }
  // the card (rotate 0.7deg)
  {
    float e = easeOut((age - 0.08) / 0.42);
    ui.pushAlpha(e);
    ui.pushTranslate(0, -18 * u * (1 - e));
    ui.pushRotate(cx0 + cw / 2, ay + ah / 2, 0.7f * PIf / 180);
    Ui::Shadow sh{0, 6 * u, 8 * u, hex(0x321602, 0.42f)};
    ui.brushClip(cx0, ay, cw, ah, hex(0xfdf9f0), 57, 6, 4, u, &sh);
    char kick[64];
    std::snprintf(kick, sizeof kick, "RACE \xC2\xB7 VS 14 AI \xC2\xB7 COURSE %02d", v.i + 1);
    ui.textLH(cix, ty0, kindH, tXs, UiFont::BodyHeavy, red, kick, UiAlign::Left, 0.14f);
    float ty = titleY;
    for (const std::string& l : title) { ui.textLH(cix, ty, 34 * u * 1.02f, 34 * u, NUM, blue, l, UiAlign::Left, 0.01f); ty += 34 * u * 1.02f; }
    ty = briefY;
    for (const std::string& l : brief) { ui.textLH(cix, ty, briefFs * 1.42f, briefFs, UiFont::BodyMed, hex(INK), l); ty += briefFs * 1.42f; }
    // the facts: Length, Drop, Level, Best (space-between; dashed rules)
    ui.dashPath({vec2(cix, factsY), vec2(cix + ciw, factsY)}, 1.5f * u, hex(0x1546c8, 0.22f), 4 * u, 3 * u, false);
    ui.dashPath({vec2(cix, factsY + factsH), vec2(cix + ciw, factsY + factsH)}, 1.5f * u, hex(0x1546c8, 0.22f), 4 * u, 3 * u, false);
    {
      Ui::Tabular tab(ui);
      char lenS[32];
      if (c.length >= 1000) std::snprintf(lenS, sizeof lenS, "%.1f km", c.length / 1000); else std::snprintf(lenS, sizeof lenS, "%d m", int(std::lround(c.length)));
      std::string best = c.bestPlace > 0 ? ordLow(c.bestPlace) : c.best > 0 ? std::to_string(int(c.best) / 60) + ":" + (int(c.best) % 60 < 10 ? "0" : "") + std::to_string(int(c.best) % 60) : "\xE2\x80\x94";
      const float signW = std::max(9 * d, 13 * u) + 10 * u, medalW = c.bestPlace > 0 && c.medal ? 6 * u + 22 * u : 0;
      struct Fact { const char* k; std::string val; float w; };
      std::vector<Fact> fs = {{"LENGTH", lenS, 0}, {"DROP", std::to_string(c.drop) + " m", 0}, {"LEVEL", c.level.empty() ? "\xE2\x80\x94" : c.level, signW}, {"BEST", best, medalW}};
      float used = 0;
      for (Fact& f : fs) { f.w = std::max(ui.textWidth(f.k, 10 * u, UiFont::BodyHeavy, 0.14f), f.w + ui.textWidth(f.val, 21 * u, NUM, 0.01f)); used += f.w; }
      // (they never run past the card: where four values are too wide for it they share it evenly, fitted)
      float sp = fs.size() > 1 ? std::max(6 * u, (ciw - used) / float(fs.size() - 1)) : 0, fx = cix, k = used + 3 * 6 * u > ciw ? (ciw - 3 * 6 * u) / used : 1;
      for (size_t q = 0; q < fs.size(); q++) {
        float fy = factsY + 9 * u, wq = fs[q].w * k;
        ui.textFit(fx, fy - (ui.lineHeight(10 * u, UiFont::BodyHeavy) - 10 * u) / 2, wq, 10 * u, UiFont::BodyHeavy, hex(0x8a93a8), fs[q].k, UiAlign::Left, 0.14f);
        float vx = fx, vy = fy + 10 * u + 4 * u;
        if (q == 2 && !c.level.empty()) { diffSign(ui, vx + signW / 2 - 3 * u, vy + 21 * u / 2, c.level, u); vx += signW; }
        float tw = ui.textFit(vx, vy - (ui.lineHeight(21 * u, NUM) - 21 * u) / 2, wq - (vx - fx) - (q == 3 ? medalW : 0), 21 * u, NUM, blue, fs[q].val, UiAlign::Left, 0.01f);
        if (q == 3 && medalW > 0) uiw::medal(ui, vx + tw + 6 * u, vy + 21 * u / 2 - 22 * u * 0.72f, 22 * u, c.medal, false);
        fx += wq + (k < 1 ? 6 * u : sp);
      }
    }
    ui.textLH(cix, diffLY, 10 * u, 10 * u, UiFont::BodyHeavy, hex(0x8a93a8), "AI DIFFICULTY", UiAlign::Left, 0.14f);
    for (int k = 0; k < 4; k++) {
      float bx2 = cix + float(k) * (dbw + 6 * u);
      bool on = k == v.diff;
      if (on) ui.roundRect(bx2, diffY, dbw, diffH, 4 * u, blue);
      else { if (hoverDiff == k) ui.roundRect(bx2, diffY, dbw, diffH, 4 * u, hex(0x1546c8, 0.08f)); ui.roundRectStroke(bx2, diffY, dbw, diffH, 4 * u, 2 * u, hex(0x1546c8, 0.3f)); }
      float fs = 16 * u, tw = ui.textWidth(DIFFS[k], fs, NUM, 0.06f);
      if (tw > dbw - 12 * u) fs *= (dbw - 12 * u) / tw;
      ui.textLH(bx2 + dbw / 2 + fs * 0.03f, diffY, diffH, fs, NUM, on ? white : blue, DIFFS[k], UiAlign::Center, 0.06f);
    }
    // the stamp and the note under it (as far as there is room over the buttons)
    {
      const char* st = "JUST FOR FUN \xC2\xB7 NO PRIZE MONEY";
      float sfs = 16 * u, sw = ui.textWidth(st, sfs, UiFont::CondHeavy, 0.1f) + 16 * u;
      if (sw > ciw) { sfs *= (ciw - 16 * u) / (sw - 16 * u); sw = ciw; }
      float shh = 6 * u + sfs;
      if (funY + shh < actY - 6 * u) {
        ui.pushRotate(cix + sw / 2, funY + shh / 2, -2 * PIf / 180);
        ui.roundRectStroke(cix, funY, sw, shh, 4 * u, 2.5f * u, a(red, 0.85f));
        ui.textLH(cix + 8 * u, funY, shh, sfs, UiFont::CondHeavy, a(red, 0.85f), st, UiAlign::Left, 0.1f);
        ui.popTransform();
      }
      const float pfs = std::max(11 * d, 13 * u);
      std::vector<std::string> pl = uiw::wrap(ui, "Race 14 AI rivals on any course, as often as you like. Want prize money? Race the courses at their start houses on the mountain.", pfs, UiFont::BodySemi, ciw);
      float py = funY + shh + 6 * u;
      for (size_t q = 0; q < pl.size() && q < 3 && py + pfs * 1.35f < actY - 6 * u; q++) { ui.textLH(cix, py, pfs * 1.35f, pfs, UiFont::BodySemi, hex(INK), pl[q]); py += pfs * 1.35f; }
    }
    jbBtn(ui, cix, actY, halfW, "START RACE", 61, blue, white, hoverStart || !mouseOk, false, u);
    jbBtn(ui, cix + halfW + 14 * u, actY, halfW, "CLOSE", 62, hex(0xe9eefb), blue, hoverClose, false, u);
    pin(ui, cx0 + cw / 2, ay + 2 * u, u, 0xd0342c);
    ui.popTransform(); ui.popTransform();
    ui.popAlpha();
  }
  if (nav.usingPad) boardHint(ui, F, {{prompts::K(in, "updown"), true}, {"COURSE", false}, {prompts::K(in, "leftright"), true}, {"DIFFICULTY", false}, {prompts::K(in, "confirm"), true}, {"START", false}, {prompts::K(in, "cancel"), true}, {"CLOSE", false}});
  else boardHint(ui, F, {{"\xE2\x86\x91 \xE2\x86\x93", true}, {"COURSE", false}, {"\xE2\x86\x90 \xE2\x86\x92", true}, {"DIFFICULTY", false}, {prompts::K(in, "confirm"), true}, {"START", false}, {prompts::K(in, "cancel"), true}, {"CLOSE", false}});
  ui.popAlpha();
  ui.popAlpha();
  (void)tSm; (void)W; (void)H;
  return true;
}

} // namespace sl
