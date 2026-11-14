#include "game/policehud.h"
#include "game/ui_widgets.h"
#include <algorithm>
#include <cmath>

namespace sl {
using namespace ui_color;

namespace {
const float PIf = 3.14159265f;
float easeOut(double t) { float e = float(std::clamp(t, 0.0, 1.0)); return 1 - std::pow(1 - e, 3.f); }
/// the star of police.js STAR (viewBox 24) in a box of side s at (x, y)
void star(Ui& ui, float x, float y, float s, const vec4& c) {
  static const float P[10][2] = {{12, 1.8f}, {15.1f, 8.4f}, {22.2f, 9.3f}, {17, 14.2f}, {18.4f, 21.3f}, {12, 17.8f}, {5.6f, 21.3f}, {7, 14.2f}, {1.8f, 9.3f}, {8.9f, 8.4f}};
  const float k = s / 24;
  vec2 ctr(x + 12 * k, y + 12.4f * k);
  for (int i = 0; i < 10; i++) {
    vec2 p0(x + P[i][0] * k, y + P[i][1] * k), p1(x + P[(i + 1) % 10][0] * k, y + P[(i + 1) % 10][1] * k);
    ui.tri(ctr, p0, p1, c);
    ui.capsule(p0, p1, 1.f, c);
  }
}
/// the little patrol car of POLICE_CAR_ICON (viewBox 26 x 13)
void carIcon(Ui& ui, float x, float y, float w, float h, const vec4& c) {
  const float kx = w / 26, ky = h / 13;
  auto P = [&](float px, float py) { return vec2(x + px * kx, y + py * ky); };
  ui.polyAA({P(2, 9.9f), P(2, 6.6f), P(7, 4.8f), P(21, 4.9f), P(24.7f, 6.2f), P(24.7f, 9.9f)}, c);   // the body
  ui.polyAA({P(7, 4.8f), P(10, 1.5f), P(17.2f, 1.1f), P(20.9f, 4.9f)}, c);                              // the cabin
  ui.polyAA({P(9.6f, 4.9f), P(11.8f, 2.4f), P(14.2f, 2.4f), P(14.2f, 4.9f)}, white);                    // the windows
  ui.polyAA({P(15.6f, 2.4f), P(17.7f, 2.4f), P(19.8f, 4.9f), P(15.6f, 4.9f)}, white);
  for (float wx : {7.f, 19.2f}) { vec2 q = P(wx, 10.4f); ui.circle(q.x, q.y, 2.6f * kx, white); ui.circle(q.x, q.y, 1.8f * kx, c); }
  ui.roundRect(x + 12.2f * kx, y, 3 * kx, 1.2f * ky, 0.4f * kx, red);                                    // the light bar
}
} // namespace

float drawPoliceHud(Ui& ui, const PoliceHudState& s) {
  // (#police-hud: zoom 0.92: every length of it, the CSS px ones too)
  const float Z = 0.92f, d = ui.dpr() * Z, u = ui.cssU() * Z, H = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u);
  const UiFont NUM = UiFont::CondItalic;
  Ui::Tabular tab(ui);
  const float w = std::max(300 * d, 390 * u), padL = 28 * u, padR = 34 * u, inner = w - padL - padR;
  const vec4 navyInk = hex(0x0d1d4a), hotC = hex(0xd0342c), lostC = hex(0x129a46);
  // ---- measure
  const float msgFs = std::max(15 * d, 20 * u), tipFs = std::max(12 * d, 15 * u), heliFs = std::max(12 * d, 14 * u), radioFs = std::max(13 * d, 16 * u);
  std::vector<std::string> msgL = uiw::wrap(ui, s.msg, msgFs, NUM, inner - 36 * u, 0.03f), tipL, radioL;
  if (msgL.size() > 2) { msgL.resize(2); msgL[1] = uiw::ellipsis(ui, msgL[1] + " \xE2\x80\xA6", msgFs, NUM, inner - 36 * u, 0.03f); }
  if (!s.tip.empty()) { tipL = uiw::wrap(ui, s.tip, tipFs, UiFont::BodyBold, inner); if (tipL.size() > 4) tipL.resize(4); }
  const float radioIcon = std::max(12 * d, 16 * u);
  if (!s.radio.empty()) { radioL = uiw::wrap(ui, s.radio, radioFs, NUM, inner - radioIcon - 7 * u, 0.02f); if (radioL.size() > 2) radioL.resize(2); }
  struct Chip { std::string t; vec4 c; bool pulse; };
  std::vector<Chip> chips;
  if (!s.state.empty()) chips.push_back({s.state, s.stateCls == "hot" ? hotC : s.stateCls == "lost" ? lostC : blue, s.stateCls == "hot"});
  if (!s.rb.empty()) chips.push_back({s.rb, hex(0xff8a1d), false});
  if (s.air) chips.push_back({"AIR UNIT", navyInk, false});
  if (!s.tyres.empty()) chips.push_back({s.tyres, hex(0xff8a1d), false});
  const float chipH = 7 * u + tXs;
  int chipRows = chips.empty() ? 0 : 1;
  { float cx = 0; for (const Chip& c : chips) { float cw = ui.textWidth(c.t, tXs, UiFont::BodyHeavy, 0.12f) + 18 * u; if (cx > 0 && cx + cw > inner) { chipRows++; cx = 0; } cx += cw + 6 * u; } }
  const float starS = std::max(17 * d, 24 * u), headH = starS + 2 * u + 56 * u * 0.88f;
  const float barH = std::max(10 * d, 16 * u), carW = std::max(26 * d, 36 * u), carH = std::max(13 * d, 18 * u);
  const bool esc = !s.esc.empty();
  float nearW = ui.textWidth(s.near, tSm, UiFont::BodyHeavy, 0.06f), carsW = s.cars > 0 ? float(s.cars) * carW + float(s.cars - 1) * 6 * u : 0;
  const bool subWrap = carsW + 10 * u + nearW > inner;
  float h = 14 * u + 8 * u + 10 * u + headH;
  if (chipRows) h += 10 * u + float(chipRows) * chipH + float(chipRows - 1) * 6 * u;
  h += 12 * u + 17 * u + float(msgL.size()) * msgFs * 1.12f;
  if (!tipL.empty()) h += 7 * u + float(tipL.size()) * tipFs * 1.2f;
  if (!s.heli.empty()) h += 7 * u + heliFs * 1.2f;
  if (!radioL.empty()) h += 9 * u + float(radioL.size()) * radioFs * 1.18f;
  if (esc) h += 14 * u + 28 * u + 6 * u + barH + 9 * u + (subWrap ? carH + 6 * u + tSm * 1.15f : std::max(carH, tSm * 1.15f));
  h += 20 * u;
  // ---- the paper (pl-in: 0.45 s from 40u to the left)
  const float e = easeOut(s.shownFor / 0.45), x = 22 * d - 40 * u * (1 - e), y = H - 92 * d - h;
  ui.pushAlpha(e);
  {
    Ui::Shadow sh{0, 6 * u, 14 * u, hex(0x00143c, 0.3f)};
    const std::vector<vec4> clip = {{0, 0, 0, 4 * u}, {0.16f, 0, 0, 0}, {0.38f, 0, 0, 5 * u}, {0.62f, 0, 0, 1 * u}, {0.85f, 0, 0, 5 * u}, {1, 0, 0, 0}, {1, -4 * u, 0.32f, 0}, {1, 0, 0.66f, 0},
                                    {1, -2 * u, 1, 0}, {0.75f, 0, 1, -5 * u}, {0.5f, 0, 1, 0}, {0.25f, 0, 1, -4 * u}, {0, 0, 1, 0}, {0, 4 * u, 0.62f, 0}, {0, 0, 0.28f, 0}};
    ui.clipPoly(x, y, w, h, white, clip, 0x90110CE, &sh);
  }
  const float lx = x + padL;
  float ty = y + 14 * u;
  // the lights: four bars, blue / red, blinking half a second apart
  {
    float bx = lx - 8 * u, bw = (inner + 16 * u - 18 * u) / 4;
    for (int i = 0; i < 4; i++) {
      bool even = i % 2 == 1;
      double ph = std::fmod(s.now + (even ? 0.25 : 0.0), 0.5) / 0.5;
      ui.brushPanel(bx + float(i) * (bw + 6 * u), ty, bw, 8 * u, a(even ? red : blue, ph < 0.5 ? 1.f : 0.15f), 1);
    }
    ty += 8 * u + 10 * u;
  }
  // the head: the stars over WANTED, the chase clock on the right
  {
    bool blink = s.search && std::fmod(s.now, 0.9) > 0.45;
    for (int i = 0; i < 5; i++) star(ui, lx + float(i) * (starS + 3 * u), ty, starS, i < s.stars ? a(blue, blink ? 0.2f : 1.f) : hex(0x1546c8, 0.15f));
    float wy = ty + starS + 2 * u;
    ui.textLH(lx, wy, 56 * u * 0.88f, 56 * u, NUM, red, "WANTED", UiAlign::Left, 0.04f);
    float cy = ty + headH - (tXs * 1.15f + 3 * u + 46 * u * 0.9f);
    ui.textLH(lx + inner + tXs * 0.12f, cy, tXs * 1.15f, tXs, UiFont::BodyHeavy, blueDim, "CHASE", UiAlign::Right, 0.12f);
    ui.textLH(lx + inner, cy + tXs * 1.15f + 3 * u, 46 * u * 0.9f, 46 * u, NUM, blue, s.t, UiAlign::Right);
    ty += headH;
  }
  if (chipRows) {
    ty += 10 * u;
    float cx = lx;
    for (const Chip& c : chips) {
      float cw = ui.textWidth(c.t, tXs, UiFont::BodyHeavy, 0.12f) + 18 * u;
      if (cx > lx && cx + cw > lx + inner) { cx = lx; ty += chipH + 6 * u; }
      float al = c.pulse ? 0.8f + 0.2f * float(std::cos(s.now / 0.7 * 2 * PIf)) : 1.f;
      ui.brushPanel(cx, ty, cw, chipH, a(c.c, al), 1);
      ui.textLH(cx + 9 * u, ty + 4 * u, tXs, tXs, UiFont::BodyHeavy, white, c.t, UiAlign::Left, 0.12f);
      cx += cw + 6 * u;
    }
    ty += chipH;
  }
  // the status line on its brush (red while it is hot), the tip, the helicopter, the radio
  {
    ty += 12 * u;
    float mh = 17 * u + float(msgL.size()) * msgFs * 1.12f;
    ui.brushPanel(lx, ty, inner, mh, s.hot ? hotC : blue, 1);
    float my = ty + 8 * u;
    for (const std::string& l : msgL) { ui.textLH(lx + 16 * u, my, msgFs * 1.12f, msgFs, NUM, white, l, UiAlign::Left, 0.03f); my += msgFs * 1.12f; }
    ty += mh;
  }
  if (!tipL.empty()) { ty += 7 * u; for (const std::string& l : tipL) { ui.textLH(lx, ty, tipFs * 1.2f, tipFs, UiFont::BodyBold, navyInk, l); ty += tipFs * 1.2f; } }
  if (!s.heli.empty()) { ty += 7 * u; ui.textLH(lx, ty, heliFs * 1.2f, heliFs, UiFont::BodyHeavy, s.heliCls == "lost" ? lostC : s.heliCls == "come" ? navyInk : hotC, s.heli, UiAlign::Left, 0.02f); ty += heliFs * 1.2f; }
  if (!radioL.empty()) {
    ty += 9 * u;
    // RADIO_ICON: an antenna mast with its arms, red, blinking
    float ix = lx, iy = ty + radioFs * 0.1f, k = radioIcon / 16;
    const vec4 rc = a(hotC, std::fmod(s.now, 0.6) < 0.3 ? 1.f : 0.15f);
    ui.rect(ix + 7 * k, iy + 1 * k, 2 * k, 14 * k, rc);
    ui.capsule(vec2(ix + 3 * k, iy + 5.4f * k), vec2(ix + 8 * k, iy + 7.6f * k), 2 * k, rc, false);
    ui.capsule(vec2(ix + 13 * k, iy + 5.4f * k), vec2(ix + 8 * k, iy + 7.6f * k), 2 * k, rc, false);
    // (pl-type: the line types in over 0.35 s)
    float reveal = float(std::clamp(s.radioAge / 0.35, 0.0, 1.0));
    ui.pushClip(lx, ty - 2 * u, (radioIcon + 7 * u + (inner - radioIcon - 7 * u) * reveal), float(radioL.size()) * radioFs * 1.18f + 4 * u);
    for (const std::string& l : radioL) { ui.textLH(lx + radioIcon + 7 * u, ty, radioFs * 1.18f, radioFs, NUM, navyInk, l, UiAlign::Left, 0.02f); ty += radioFs * 1.18f; }
    ui.popClip();
  }
  if (esc) {
    ty += 14 * u;
    float base = ty + 28 * u / 2 + (ui.ascent(NUM) + ui.descent(NUM)) / 2 * 28 * u;
    auto baseText = [&](float bx, float size, UiFont f, const vec4& c, const std::string& t, UiAlign al, float tr) {
      float top = base - ui.ascent(f) * size - (ui.lineHeight(size, f) - (ui.ascent(f) - ui.descent(f)) * size) * 0.5f;
      return ui.text(bx, top, size, f, c, t, al, tr);
    };
    baseText(lx, tXs, UiFont::BodyHeavy, blueDim, "LOSE THEM", UiAlign::Left, 0.12f);
    float ofFs = 28 * u * 0.7f, ofW = s.escOf.empty() ? 0 : ui.textWidth(" " + s.escOf, ofFs, NUM);
    // (the clock and "/ 0:30 · out of sight" never run into LOSE THEM: the small part shrinks first)
    float room = inner - ui.textWidth("LOSE THEM", tXs, UiFont::BodyHeavy, 0.12f) - 10 * u - ui.textWidth(s.esc, 28 * u, NUM);
    if (ofW > room && ofW > 0) { ofFs *= std::max(0.6f, room / ofW); ofW = ui.textWidth(" " + s.escOf, ofFs, NUM); }
    if (!s.escOf.empty()) baseText(lx + inner, ofFs, NUM, blueDim, " " + s.escOf, UiAlign::Right, 0);
    baseText(lx + inner - ofW, 28 * u, NUM, blue, s.esc, UiAlign::Right, 0);
    ty += 28 * u + 6 * u;
    ui.brushPanel(lx, ty, inner, barH, hex(0x1546c8, 0.13f), 1);
    float fw = inner * float(std::clamp(s.frac, 0.0, 1.0));
    if (fw > 1) {
      float al = s.gain ? 0.8f + 0.2f * float(std::cos(s.now / 0.9 * 2 * PIf)) : 1.f;
      ui.pushClip(lx, ty, fw, barH);
      ui.brushPanel(lx, ty, inner, barH, a(hex(0x2a60e4), al), 1);
      ui.popClip();
    }
    ty += barH + 9 * u;
    float rowH = subWrap ? carH : std::max(carH, tSm * 1.15f);
    for (int i = 0; i < s.cars; i++) carIcon(ui, lx + float(i) * (carW + 6 * u), ty + (rowH - carH) / 2, carW, carH, blue);
    if (subWrap) ty += carH + 6 * u;
    ui.textLH(lx + inner + tSm * 0.06f, ty, subWrap ? tSm * 1.15f : rowH, tSm, UiFont::BodyHeavy, s.gain ? lostC : hotC, s.near, UiAlign::Right, 0.06f);
  }
  ui.popAlpha();
  return y;
}

void drawPoliceSlam(Ui& ui, const std::string& text, const std::string& sub, double age, double k) {
  const double dur = 1.1 + 0.5 * k, t = age / dur;
  if (t < 0 || t >= 1) return;
  const float d = ui.dpr(), W = float(ui.width()), H = float(ui.height()), vw = W / 100;
  // the red flash round the edges: radial white .35 -> clear at 35% -> red .25 at 60% -> dark red .75 at the corners
  if (k > 0.05) {
    double fd = 0.38 + 0.52 * k;
    float fa = age < fd ? float(std::min(1.0, 0.35 + 0.65 * k) * (1 - easeOut(age / fd))) : 0.f;
    if (fa > 0.004f) ui.gradientGrid(0, 0, W, H, 20, 14, [&](float fx, float fy) {
      float r = std::min(1.f, std::hypot((fx - 0.5f) * 2, (fy - 0.5f) * 2) / 1.414f);
      if (r < 0.35f) return vec4(1, 1, 1, 0.35f * (1 - r / 0.35f) * fa);
      if (r < 0.6f) return vec4(0.78f, 0.08f, 0.08f, 0.25f * (r - 0.35f) / 0.25f * fa);
      float q = (r - 0.6f) / 0.4f;
      return vec4(0.78f - 0.15f * q, 0.08f * (1 - q), 0.08f * (1 - q), (0.25f + 0.5f * q) * fa);
    });
  }
  float al, sc, rot;
  if (t < 0.12) { float q = float(t / 0.12); al = q; sc = 2.6f - 1.68f * q; rot = -4 + 2 * q; }
  else if (t < 0.2) { float q = float((t - 0.12) / 0.08); al = 1; sc = 0.92f + 0.08f * q; rot = -2; }
  else if (t < 0.8) { float q = float((t - 0.2) / 0.6); al = 1; sc = 1 + 0.04f * q; rot = -2 * (1 - q); }
  else { float q = float((t - 0.8) / 0.2); al = 1 - q; sc = 1.04f + 0.06f * q; rot = 0; }
  const float fs = std::clamp(9 * vw, 42 * d, 120 * d), sfs = std::clamp(1.5f * vw, 13 * d, 20 * d), cx = W / 2, top = H * 0.23f;
  const float stroke = std::clamp(0.35f * vw, 2 * d, 5 * d);
  ui.pushAlpha(al);
  ui.pushScale(cx, top + fs * 0.6f, sc, sc);
  ui.pushRotate(cx, top + fs * 0.6f, rot * PIf / 180);
  float yt = top + (fs * 0.9f - ui.lineHeight(fs, UiFont::CondHeavy)) / 2;
  size_t nStars = 0;
  { std::vector<uint32_t> cps = utf8Decode(text); for (uint32_t cp : cps) nStars += cp == 0x2605; if (nStars != cps.size()) nStars = 0; }
  if (nStars) {
    // (the wanted level: the fonts have no star, so they are drawn: red in a white rim)
    const float s = fs * 0.78f, gap = fs * 0.06f, total = float(nStars) * s + float(nStars - 1) * gap;
    for (size_t i = 0; i < nStars; i++) {
      float sx = cx - total / 2 + float(i) * (s + gap), sy = top + (fs * 0.9f - s) / 2;
      star(ui, sx - stroke, sy - stroke, s + 2 * stroke, white);
      star(ui, sx, sy, s, hex(0xff3b2f));
    }
  } else {
    ui.textShadow(cx, yt, fs, UiFont::CondHeavy, text, UiAlign::Center, 0.03f, 0, 6 * d, 22 * d, hex(0x000a28, 0.45f));
    ui.textHalo(cx, yt, fs, UiFont::CondHeavy, hex(0xff3b2f), white, stroke / 2, text, UiAlign::Center, 0.03f);
  }
  if (!sub.empty()) {
    float sy = top + fs * 0.9f + sfs * 0.35f;
    ui.textShadow(cx, sy, sfs, UiFont::BodyHeavy, sub, UiAlign::Center, 0.22f, 0, 2 * d, 8 * d, hex(0x000a28, 0.7f));
    ui.text(cx, sy, sfs, UiFont::BodyHeavy, white, sub, UiAlign::Center, 0.22f);
  }
  ui.popTransform();
  ui.popTransform();
  ui.popAlpha();
}

void drawBusted(Ui& ui, const std::string& word, const std::string& sub, double age) {
  if (age < 0 || age > 3.55) return;
  const float d = ui.dpr(), W = float(ui.width()), H = float(ui.height()), vmin = std::min(W, H) / 100, vw = W / 100;
  const float all = float(std::clamp(age / 0.18, 0.0, 1.0)) * (age > 2.9 ? float(1 - std::clamp((age - 2.9) / 0.6, 0.0, 1.0)) : 1.f);
  ui.pushAlpha(all);
  // the lights at the screen's edges: red from the left, blue from the right, half a second each, six times
  if (age < 3.25) {
    bool redOn = age < 3.0 && std::fmod(age, 0.5) < 0.25, blueOn = age >= 0.25 && std::fmod(age - 0.25, 0.5) < 0.25;
    auto edge = [&](bool left, const vec3& c0, float a0, const vec3& c1, float a1) {
      ui.gradientGrid(0, 0, W, H, 24, 14, [&](float fx, float fy) {
        // radial-gradient(ellipse 120% 95% at 0% (100%) 50%, c0 a0, clear 55%) + the vignette ring (60% 70%, from 55%)
        float ex = (left ? fx : 1 - fx) / 1.2f, ey = (fy - 0.5f) / 0.95f, r = std::hypot(ex, ey);
        float g = a0 * std::max(0.f, 1 - r / 0.55f);
        float vr = std::hypot((fx - 0.5f) / 0.6f, (fy - 0.5f) / 0.7f) / 1.18f, v = a1 * std::clamp((vr - 0.55f) / 0.45f, 0.f, 1.f);
        float al = g + v * (1 - g);
        vec3 c = al > 1e-4f ? (c0 * g + c1 * v * (1 - g)) / al : c0;
        return vec4(c, al);
      });
    };
    if (redOn) edge(true, vec3(1, 0.118f, 0.118f), 0.75f, vec3(0.784f, 0, 0), 0.55f);
    if (blueOn) edge(false, vec3(0.157f, 0.353f, 1), 0.8f, vec3(0, 0.157f, 0.863f), 0.55f);
  }
  // the card: the word (bs-slam 0.5 s; bs-shake 0.42 s from 0.32 s), the line under it (from 0.38 s)
  const float fs = std::clamp(19 * vmin, 64 * d, 260 * d), sfs = std::clamp(3.1f * vmin, 16 * d, 34 * d), gap = 1.6f * vmin;
  std::string up = uiw::upper(word);
  float wordFs = fs, ww = ui.textWidth(up, wordFs, UiFont::CondHeavy, 0.04f);
  if (ww > W - 8 * vw) wordFs *= (W - 8 * vw) / ww;   // (the word never leaves the screen)
  const float maxSub = std::min(0.92f * W, 1100 * d) - 4.8f * vmin;
  std::vector<std::string> subL = uiw::wrap(ui, sub, sfs, UiFont::BodyHeavy, maxSub, 0.04f);
  float subW = 0;
  for (const std::string& l : subL) subW = std::max(subW, ui.textWidth(l, sfs, UiFont::BodyHeavy, 0.04f));
  const float subH = subL.empty() ? 0 : 1.8f * vmin + float(subL.size()) * sfs * 1.25f, wordH = wordFs * 0.9f;
  const float total = wordH + (subL.empty() ? 0 : gap + subH);
  float cx = W / 2, top = (H - total) / 2;
  if (age > 0.32 && age < 0.74) {
    static const float K[7][3] = {{0, 0, 0}, {0.15f, -1.4f, 0.6f}, {0.3f, 1.2f, -0.8f}, {0.45f, -0.9f, -0.4f}, {0.6f, 0.7f, 0.5f}, {0.8f, -0.3f, 0.2f}, {1, 0, 0}};
    float q = float((age - 0.32) / 0.42);
    for (int i = 1; i < 7; i++) if (q <= K[i][0]) { float f = (q - K[i - 1][0]) / (K[i][0] - K[i - 1][0]); cx += (K[i - 1][1] + (K[i][1] - K[i - 1][1]) * f) * vmin; top += (K[i - 1][2] + (K[i][2] - K[i - 1][2]) * f) * vmin; break; }
  }
  {
    float t = float(std::clamp(age / 0.5, 0.0, 1.0)), sc, al = std::min(1.f, t / 0.55f);
    if (t < 0.55f) sc = 1.6f - 0.66f * easeOut(t / 0.55f); else if (t < 0.78f) sc = 0.94f + 0.09f * (t - 0.55f) / 0.23f; else sc = 1.03f - 0.03f * (t - 0.78f) / 0.22f;
    const float stroke = std::max(2 * d, 0.35f * vmin);
    float yt = top + (wordH - ui.lineHeight(wordFs, UiFont::CondHeavy)) / 2;
    ui.pushAlpha(al);
    ui.pushScale(cx, top + wordH / 2, sc, sc);
    ui.textShadow(cx, yt, wordFs, UiFont::CondHeavy, up, UiAlign::Center, 0.04f, 0, 2 * vmin, 5 * vmin, a(hex(0x000000), 0.6f));
    ui.textShadow(cx, yt, wordFs, UiFont::CondHeavy, up, UiAlign::Center, 0.04f, 0, 0, 3 * vmin, hex(0xff0000, 0.85f));
    ui.textHalo(cx, yt + 1.2f * vmin, wordFs, UiFont::CondHeavy, hex(0x7a0000), hex(0x7a0000), stroke / 2, up, UiAlign::Center, 0.04f);
    ui.textHalo(cx, yt, wordFs, UiFont::CondHeavy, hex(0xff2a1f), white, stroke / 2, up, UiAlign::Center, 0.04f);
    ui.popTransform();
    ui.popAlpha();
  }
  if (!subL.empty()) {
    float e = easeOut((age - 0.38) / 0.35), sy = top + wordH + gap + 1.5f * vmin * (1 - e), bw = subW + 4.8f * vmin;
    ui.pushAlpha(e);
    ui.rect(cx - bw / 2, sy, bw, subH, hex(0x080a18, 0.72f));
    float ly = sy + 0.9f * vmin;
    for (const std::string& l : subL) { ui.textLH(cx + sfs * 0.02f, ly, sfs * 1.25f, sfs, UiFont::BodyHeavy, white, l, UiAlign::Center, 0.04f); ly += sfs * 1.25f; }
    ui.popAlpha();
  }
  ui.popAlpha();
}

} // namespace sl
