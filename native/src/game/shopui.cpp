#include "game/shopui.h"
#include "core/prompts.h"
#include "game/ui_widgets.h"
#include "platform/platform.h"
#include <algorithm>
#include <cmath>

namespace sl {
using namespace ui_color;

namespace {
float easeOut(double t) { float e = float(std::clamp(t, 0.0, 1.0)); return 1 - std::pow(1 - e, 3.f); }

// outfitshop.css .os-sw: the two-tone tile, the helmet dome, the lens pill, the dashed original, a pair of skis
void swatch(Ui& ui, const ShopRow& r, float x, float cy, float u, bool sel) {
  const float s = 36 * u;
  if (r.swatch == 0) {
    // .os-sw-orig: a dashed rounded tile
    float lw = std::max(1.5f * ui.dpr(), 2 * u);
    const vec4 c = sel ? a(white, 0.7f) : hex(0x1546c8, 0.45f);
    std::vector<vec2> p = {{x + lw / 2, cy - s / 2 + lw / 2}, {x + s - lw / 2, cy - s / 2 + lw / 2}, {x + s - lw / 2, cy + s / 2 - lw / 2}, {x + lw / 2, cy + s / 2 - lw / 2}, {x + lw / 2, cy - s / 2 + lw / 2}};
    ui.dashPath(p, lw, c, 4 * u, 3 * u, false);
    return;
  }
  if (r.swatch == 1) {
    // .os-sw-tone: rotate(-8deg) skewX(-6deg); linear-gradient(135deg, a 0 60%, b 60% 100%); a white inset ring
    ui.pushRotate(x + s / 2, cy, -8 * 3.14159265f / 180);
    ui.boxShadow(x, cy - s / 2, s, s, 5 * u, 0, 2 * u, 5 * u, hex(0x00143c, 0.25f));
    ui.roundRect(x, cy - s / 2, s, s, 5 * u, hex(r.a));
    // the accent: the corner beyond 60% along the 135 degree diagonal
    float k = s * 0.8f;
    ui.polyAA({vec2(x + s - 2 * u, cy + s / 2 - k), vec2(x + s - 2 * u, cy + s / 2 - 2 * u), vec2(x + s - k, cy + s / 2 - 2 * u)}, hex(r.b ? r.b : r.a));
    ui.roundRectStroke(x, cy - s / 2, s, s, 5 * u, 2 * u, a(white, 0.55f));
    ui.popTransform();
    return;
  }
  if (r.swatch == 2) {
    // .os-sw-helmet: a dome 36u x 30u with a gloss highlight
    float h = 30 * u, y = cy - s / 2 + 4 * u;
    ui.boxShadow(x, y, s, h, h / 2, 0, 2 * u, 5 * u, hex(0x00143c, 0.25f));
    ui.roundRect(x, y, s, h, h * 0.5f, hex(r.a));
    ui.roundRect(x + s * 0.12f, y + h * 0.62f, s * 0.76f, h * 0.3f, h * 0.15f, a(hex(0x000000), 0.14f));
    ui.circle(x + s * 0.34f, y + h * 0.3f, s * 0.1f, a(white, 0.7f));
    return;
  }
  if (r.swatch == 3) {
    // .os-sw-lens: a 42u x 22u pill with a dark frame
    float w = 42 * u, h = 22 * u;
    ui.boxShadow(x, cy - h / 2, w, h, h / 2, 0, 2 * u, 5 * u, hex(0x00143c, 0.25f));
    ui.roundRect(x, cy - h / 2, w, h, h / 2, hex(0x1c1f26));
    ui.roundRect(x + 3 * u, cy - h / 2 + 3 * u, w - 6 * u, h - 6 * u, h / 2 - 3 * u, hex(r.a));
    ui.capsule(vec2(x + w * 0.36f, cy + h * 0.22f), vec2(x + w * 0.52f, cy - h * 0.22f), 3 * u, a(white, 0.5f));
    return;
  }
  if (r.swatch == 5 && !r.stripes.empty()) {
    // .os-sw-kit: the kit's colours side by side in a rounded tile, rotate(-8deg)
    ui.pushRotate(x + s / 2, cy, -8 * 3.14159265f / 180);
    ui.boxShadow(x, cy - s / 2, s, s, 5 * u, 0, 2 * u, 5 * u, hex(0x00143c, 0.3f));
    const float bw = s / float(r.stripes.size());
    ui.roundRect(x, cy - s / 2, s, s, 5 * u, hex(r.stripes.front()));
    ui.roundRect(x + s - 2 * bw, cy - s / 2, 2 * bw, s, 5 * u, hex(r.stripes.back()));
    for (size_t i = 1; i + 1 < r.stripes.size(); i++) ui.rect(x + float(i) * bw, cy - s / 2, bw + 0.5f, s, hex(r.stripes[i]));
    ui.popTransform();
    return;
  }
  // skis: two tilted boards in the pair's colours
  for (int i = 0; i < 2; i++) {
    float ox = x + (i ? 20.f : 9.f) * u;
    ui.capsule(vec2(ox - 4 * u, cy + 15 * u), vec2(ox + 6 * u, cy - 15 * u), 8 * u, a(white, 0.9f));
    ui.capsule(vec2(ox - 4 * u, cy + 15 * u), vec2(ox + 6 * u, cy - 15 * u), 5.5f * u, hex(i ? (r.b ? r.b : r.a) : r.a));
  }
}
} // namespace

bool frameShop(Ui& ui, const UiNav& nav, const Input& in, ShopView& v, double dt, double now) {
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tMd = std::max(13 * d, 15 * u);
  const UiFont NUM = UiFont::CondItalic;
  Ui::Tabular tab(ui);
  if (v.openedAt < 0) { v.openedAt = now; if (v.rebuild) v.rebuild(v); v.reveal = true; }
  const double age = now - v.openedAt;
  int n = int(v.rows.size());
  v.focus = n ? std::clamp(v.focus, 0, n - 1) : 0;
  // ---- layout (.os-col: left 64u, top 34u, bottom 70u, 540u wide; on a narrow window as wide as it has)
  const float colX = 64 * u, colW = std::min(540 * u, W - 96 * u), top = 34 * u, bottom = H - 70 * u;
  const float headH = 90 * u + 6 * u + tMd * 1.35f + 12 * u;
  // the tabs: 46u high, 17u of padding, 22u type; a row that would not fit the column is scaled to it
  float tabFs = 22 * u, tabPad = 17 * u, tabsW = 0;
  for (int pass = 0; pass < 2; pass++) {
    tabsW = 0;
    for (const auto& t : v.tabs) tabsW += ui.textWidth(t.label, tabFs, NUM, 0.05f) + 2 * tabPad + 8 * u;
    tabsW -= 8 * u;
    if (tabsW <= colW || pass || !v.fitTabs) break;
    float k = colW / tabsW;
    tabFs *= k; tabPad *= k;
  }
  const float tabsY = top + headH, tabH = 46 * u, listY = tabsY + tabH + 14 * u;
  const ShopRow* cur = n ? &v.rows[size_t(v.focus)] : nullptr;
  std::vector<std::string> notes;
  if (cur) for (const std::string& nt : cur->notes) for (const std::string& l : uiw::wrap(ui, nt, tXs, UiFont::BodyMed, colW - 48 * u)) notes.push_back(l);
  const float detH = 16 * u + tXs + 7 * u + 36 * u * 0.95f + (notes.empty() ? 0 : 8 * u + float(notes.size()) * tXs * 1.4f) + 12 * u + 74 * u + 18 * u;
  const float detY = bottom - detH, listH = std::max(60 * u, detY - 10 * u - listY);
  const float rowW = colW - 16 * u - 14 * u, rowH = 60 * u, rowGap = 8 * u, contentH = 2 * u + float(n) * (rowH + rowGap) - rowGap + 22 * u;
  const float maxScroll = std::max(0.f, contentH - listH);
  const bool broke = cur && !cur->owned && v.money < cur->price, ready = cur && !cur->worn && !broke;
  std::string actLabel = !cur ? "" : cur->worn ? cur->wornLabel : cur->owned ? cur->useLabel : cur->buyLabel + " $" + uiw::thousands(cur->price);
  const float btnH = 74 * u, btnW = uiw::brushButtonWidth(ui, std::min(300 * u, colW * 0.6f), btnH, 34 * u, actLabel, u);
  const float btnX = colX + 28 * u, btnY = detY + detH - 18 * u - btnH;

  // ---- input (outfitshop.js onKey; the key that opened the shop is not its first choice)
  auto act = [&]() {
    if (!cur) return;
    if (cur->worn) return;
    if (broke) { v.nopeAt = now; if (v.act) v.act(v, v.focus); return; }   // (the purchase is refused where money is spent: its flash)
    int f = v.focus;
    if (v.act) v.act(v, f);
    if (v.rebuild) v.rebuild(v);
    v.popAt = now;
  };
  auto setTab = [&](int t) {
    int nt = int(v.tabs.size());
    if (!nt) return;
    v.tab = ((t % nt) + nt) % nt;
    if (v.rebuild) v.rebuild(v);
    v.focus = 0;
    for (size_t i = 0; i < v.rows.size(); i++) if (v.rows[i].worn) v.focus = int(i);
    v.scroll = v.scrollTarget = 0; v.reveal = true; v.swapAt = now;
  };
  bool closeNow = false;
  v.frames++;
  if (v.frames > 1) {
    if (nav.cancel || nav.menu) closeNow = true;
    else if (nav.up && n) { v.focus = (v.focus + n - 1) % n; v.reveal = true; v.swapAt = now; }
    else if (nav.down && n) { v.focus = (v.focus + 1) % n; v.reveal = true; v.swapAt = now; }
    else if (nav.left || nav.tabPrev) setTab(v.tab - 1);
    else if (nav.right || nav.tabNext) setTab(v.tab + 1);
    else if (nav.confirm) act();
    else if (!nav.usingPad) for (platform::Key k : nav.keys) if (k == platform::Key::KeyE) act();
  }
  auto inside = [&](float rx, float ry, float rw, float rh) { return nav.mouse.x >= rx && nav.mouse.x <= rx + rw && nav.mouse.y >= ry && nav.mouse.y <= ry + rh; };
  const bool mouseOk = nav.mouse.x >= 0 && !nav.usingPad;
  int hoverRow = -1, hoverTab = -1;
  if (mouseOk && inside(colX - 16 * u, listY, colW + 32 * u, listH))
    for (int i = 0; i < n; i++) { float ry = listY + 2 * u + float(i) * (rowH + rowGap) - v.scroll; if (nav.mouse.y >= ry && nav.mouse.y <= ry + rowH) hoverRow = i; }
  {
    float tx = colX;
    for (size_t i = 0; i < v.tabs.size(); i++) { float tw = ui.textWidth(v.tabs[i].label, tabFs, NUM, 0.05f) + 2 * tabPad; if (mouseOk && inside(tx, tabsY, tw, tabH)) hoverTab = int(i); tx += tw + 8 * u; }
  }
  const bool hoverBtn = mouseOk && inside(btnX, btnY, btnW, btnH);
  if (nav.wheel != 0 && mouseOk && inside(colX - 16 * u, listY, colW + 32 * u, listH)) v.scrollTarget = std::clamp(v.scrollTarget - nav.wheel * 48 * u, 0.f, maxScroll);
  if (std::fabs(nav.stickR.y) > 0.2f) v.scrollTarget = std::clamp(v.scrollTarget + nav.stickR.y * float(dt) * 900 * u, 0.f, maxScroll);
  if (nav.click && mouseOk && v.frames > 1) {
    if (hoverTab >= 0 && hoverTab != v.tab) setTab(hoverTab);
    else if (hoverBtn) act();
    else if (hoverRow >= 0) {
      if (hoverRow == v.lastClickRow && now - v.lastClickAt < 0.4 && hoverRow == v.focus) act();   // (dblclick: buy / wear)
      else if (hoverRow != v.focus) { v.focus = hoverRow; v.swapAt = now; }
      v.lastClickRow = hoverRow; v.lastClickAt = now;
    }
  }
  // (.os-drag: the right half of the screen; a drag there turns your skier)
  if (v.drag && mouseOk && nav.mouseDown && nav.mouse.x > W * 0.5f) { if (v.dragX >= 0) v.drag((nav.mouse.x - v.dragX) / d); v.dragX = nav.mouse.x; }
  else v.dragX = -1;
  if (v.drag && std::fabs(nav.stickR.x) > 0.2f) v.drag(nav.stickR.x * float(dt) * 260);
  if (closeNow) { if (v.closed) v.closed(); return false; }
  n = int(v.rows.size());
  v.focus = n ? std::clamp(v.focus, 0, n - 1) : 0;
  cur = n ? &v.rows[size_t(v.focus)] : nullptr;
  if (v.reveal && n) {   // (scrollIntoView: nearest)
    v.reveal = false;
    float ry = 2 * u + float(v.focus) * (rowH + rowGap);
    if (ry < v.scrollTarget) v.scrollTarget = ry - 2 * u;
    else if (ry + rowH > v.scrollTarget + listH - 30 * u) v.scrollTarget = ry + rowH - listH + 30 * u;
  }
  v.scrollTarget = std::clamp(v.scrollTarget, 0.f, maxScroll);
  v.scroll += (v.scrollTarget - v.scroll) * float(1 - std::exp(-dt * 14));

  // ---- draw: the shade (.os-shade), the column sliding in
  ui.pushAlpha(float(std::clamp(age / 0.3, 0.0, 1.0)));
  ui.gradientGrid(0, 0, W * 0.62f, H, 31, 1, [](float fx, float) {
    float x = fx * 0.62f, al = x < 0.34f ? 0.74f + (0.46f - 0.74f) * x / 0.34f : x < 0.54f ? 0.46f + (0.08f - 0.46f) * (x - 0.34f) / 0.2f : 0.08f * (1 - (x - 0.54f) / 0.08f);
    return vec4(0.016f, 0.055f, 0.133f, std::max(0.f, al));
  });
  const float in0 = easeOut(age / 0.45);
  ui.pushAlpha(in0);
  ui.pushTranslate(-40 * u * (1 - in0), 0);
  {
    // the title and its line (.menu-title 252u, brushSVG(4321, 280, 100); .menu-sub)
    std::string title = uiw::upper(v.title);
    float vw = std::max(280.f, std::round(float(utf8Decode(title).size()) * 26 + 98)), tw = std::round(vw * 0.9f) * u;
    Ui::Shadow sh{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
    ui.brushStroke(colX, top, tw, 90 * u, white, v.titleSeed, vw, 100, &sh);
    ui.textLH(colX + 40 * u, top, 90 * u, 44 * u, NUM, blue, title, UiAlign::Left, 0.04f);
    float sy = top + 90 * u + 6 * u, lh = tMd * 1.35f;
    ui.textShadow(colX + 12 * u, sy + (lh - ui.lineHeight(tMd, UiFont::BodySemi)) / 2, tMd, UiFont::BodySemi, v.sub, UiAlign::Left, 0.02f, 0, d, 8 * d, hex(0x000a1e, 0.6f));
    ui.textLH(colX + 12 * u, sy, lh, tMd, UiFont::BodySemi, a(white, 0.92f), v.sub, UiAlign::Left, 0.02f);
  }
  {
    float tx = colX;
    for (size_t i = 0; i < v.tabs.size(); i++) {
      float tw = ui.textWidth(v.tabs[i].label, tabFs, NUM, 0.05f) + 2 * tabPad;
      bool on = int(i) == v.tab;
      ui.brushPanel(tx, tabsY, tw, tabH, on ? blue : a(white, hoverTab == int(i) ? 1.f : 0.88f), 1);
      ui.textLH(tx + tabPad, tabsY, tabH, tabFs, NUM, on ? white : blue, v.tabs[i].label, UiAlign::Left, 0.05f);
      tx += tw + 8 * u;
    }
  }
  // the catalogue (fading out over its last 34u, as the web's mask)
  ui.pushClip(0, listY, colX + colW + 40 * u, listH);
  for (int i = 0; i < n; i++) {
    const ShopRow& r = v.rows[size_t(i)];
    float ry = listY + 2 * u + float(i) * (rowH + rowGap) - v.scroll;
    if (ry + rowH < listY || ry > listY + listH) continue;
    bool sel = i == v.focus, hv = hoverRow == i && !sel;
    float fadeB = std::clamp((listY + listH - (ry + rowH * 0.5f)) / (34 * u), 0.f, 1.f);
    float rin = easeOut((now - v.openedAt - 0.06 - 0.035 * double(i)) / 0.45);
    float rx = colX + (sel ? 12 * u : hv ? 6 * u : 0) - 40 * u * (1 - rin);
    ui.pushAlpha(fadeB * rin);
    if (sel) ui.rect(rx - 12 * u, ry + rowH * 0.2f, 6 * u, rowH * 0.6f, red);
    ui.brushClip(rx, ry, rowW, rowH, sel ? blue : a(white, hv ? 1.f : 0.92f), 600 + i * 7, 4, 3, u);
    if (ry >= listY - 1 && ry + rowH <= listY + listH + 1) swatch(ui, r, rx + 16 * u, ry + rowH / 2, u, sel);   // (its tilted shapes are not clipped: only where the row is whole)
    float sw = r.swatch == 3 ? 42 * u : 36 * u, tx = rx + 16 * u + sw + 14 * u;
    // the tag / price on the right; the name and the note take what is left (ellipsis)
    std::string tag = r.worn ? r.wornLabel : r.owned ? r.ownedLabel : "$" + uiw::thousands(r.price);
    bool price = !r.worn && !r.owned;
    float tagW = price ? ui.textWidth(tag, 24 * u, NUM) : ui.textWidth(tag, tXs, UiFont::BodyHeavy, 0.14f);
    float right = rx + rowW - 22 * u, avail = right - tagW - 14 * u - tx;
    if (price) ui.textLH(right, ry, rowH, 24 * u, NUM, sel ? white : blue, tag, UiAlign::Right);
    else ui.textLH(right + tXs * 0.14f, ry, rowH, tXs, UiFont::BodyHeavy, sel ? (r.worn ? white : a(white, 0.85f)) : r.worn ? red : blueDim, tag, UiAlign::Right, 0.14f);
    float blockH = 24 * u + (r.sub.empty() ? 0 : 4 * u + tXs * 1.25f), by = ry + (rowH - blockH) / 2;
    ui.textLH(tx, by, 24 * u, 24 * u, NUM, sel ? white : blue, uiw::ellipsis(ui, uiw::upper(r.name), 24 * u, NUM, avail, 0.02f), UiAlign::Left, 0.02f);
    if (!r.sub.empty()) ui.textLH(tx, by + 24 * u + 4 * u, tXs * 1.25f, tXs, UiFont::BodyMed, sel ? a(white, 0.82f) : blueDim, uiw::ellipsis(ui, r.sub, tXs, UiFont::BodyMed, avail));
    ui.popAlpha();
  }
  ui.popClip();
  // the selected item's card
  if (cur) {
    Ui::Shadow sh{0, 10 * u, 24 * u, hex(0x000e2c, 0.35f)};
    ui.brushClip(colX, detY, colW, detH, white, 511, 5, 4, u, &sh);
    float sw2 = easeOut((now - v.swapAt) / 0.3), ty = detY + 16 * u, tx = colX + 28 * u;
    ui.pushAlpha(0.35f + 0.65f * sw2);
    std::string kick = (v.tab < int(v.tabs.size()) ? v.tabs[size_t(v.tab)].one : std::string()) + (cur->worn ? " \xC2\xB7 " + cur->wornLabel : cur->owned ? " \xC2\xB7 " + cur->ownedLabel : "");
    ui.textLH(tx, ty, tXs, tXs, UiFont::BodyHeavy, red, kick, UiAlign::Left, 0.18f);
    ty += tXs + 7 * u;
    ui.textLH(tx, ty, 36 * u * 0.95f, 36 * u, NUM, blue, uiw::ellipsis(ui, uiw::upper(cur->name), 36 * u, NUM, colW - 56 * u, 0.01f), UiAlign::Left, 0.01f);
    ty += 36 * u * 0.95f;
    if (!notes.empty()) { ty += 8 * u; for (const std::string& l : notes) { ui.textLH(tx, ty, tXs * 1.4f, tXs, UiFont::BodyMed, blueDim, l); ty += tXs * 1.4f; } }
    ui.popAlpha();
    // the stroke: blue when a press does something (.os-act.ready), pale otherwise; osPop / osNope
    float bx = btnX, sc = 1;
    if (now - v.popAt < 0.4) sc = 1 + 0.06f * std::sin(float((now - v.popAt) / 0.4) * 3.14159265f);
    if (now - v.nopeAt < 0.38) bx += 6 * u * std::sin(float((now - v.nopeAt) / 0.38) * 4 * 3.14159265f);
    ui.pushScale(bx + btnW / 2, btnY + btnH / 2, sc, sc);
    uiw::brushButton(ui, bx, btnY, std::min(300 * u, colW * 0.6f), btnH, 34 * u, actLabel, 377, hoverBtn && ready, u, "", 1, ready ? blue : bluePale, ready ? white : blueDim);
    ui.popTransform();
    // YOUR MONEY, right
    std::string m = "$" + uiw::thousands(v.money);
    float wr = colX + colW - 28 * u, wy = btnY + (btnH - (tXs + 5 * u + 30 * u)) / 2;
    if (wr - ui.textWidth(m, 30 * u, NUM) > btnX + btnW + 10 * u) {
      ui.textLH(wr + tXs * 0.16f, wy, tXs, tXs, UiFont::BodyHeavy, blueDim, "YOUR MONEY", UiAlign::Right, 0.16f);
      ui.textLH(wr, wy + tXs + 5 * u, 30 * u, 30 * u, NUM, blue, m, UiAlign::Right);
    }
  }
  ui.popTransform();
  ui.popAlpha();
  // the hints (.os-foot)
  {
    std::vector<uiw::Hint> hs;
    if (nav.usingPad) { hs.push_back({{prompts::K(in, "leftright")}, "CATEGORY"}); hs.push_back({{prompts::K(in, "updown")}, "CHOOSE"}); }
    else { hs.push_back({{"\xE2\x86\x90", "\xE2\x86\x92"}, "CATEGORY"}); hs.push_back({{"\xE2\x86\x91", "\xE2\x86\x93"}, "CHOOSE"}); }
    hs.push_back({{prompts::K(in, "confirm")}, "BUY / WEAR"});
    hs.push_back({{prompts::K(in, "cancel")}, "CLOSE"});
    if (!v.dragHint.empty() && !nav.usingPad) hs.push_back({{}, v.dragHint});
    uiw::hints(ui, colX, H - 24 * u - ui.kcHeight(u), u, hs, a(white, 0.88f), a(white, 0.88f), W - 20 * u);
  }
  ui.popAlpha();
  return true;
}

} // namespace sl
