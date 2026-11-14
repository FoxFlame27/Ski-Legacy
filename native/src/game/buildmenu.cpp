#include "game/buildmenu.h"
#include "core/prompts.h"
#include "game/ui_widgets.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "platform/platform.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>

namespace sl {
using namespace ui_color;

const BuildThumbs* buildThumbs(gfx::Device* dev, platform::Platform* plat) {
  static BuildThumbs T;
  static int state = 0;   // 0 not tried, 1 loaded, 2 missing
  if (state == 0 && dev && plat) {
    state = 2;
    AssetPaths paths;
    std::vector<uint8_t> file, meta, rgba;
    int w = 0, h = 0;
    if (paths.init(*plat) && plat->readFile(paths.publicRoot + "/ui/furniture_thumbs.webp", file) && plat->readFile(paths.publicRoot + "/ui/furniture_thumbs.json", meta) &&
        decodeImageRGBA(file, w, h, rgba) && w > 1 && h > 1) {
      nlohmann::json j = nlohmann::json::parse(meta.begin(), meta.end(), nullptr, false);
      if (j.is_object() && j.contains("ids") && j["ids"].is_array()) {
        T.cols = j.value("cols", 8); T.w = j.value("w", 160); T.h = j.value("h", 120); T.texW = w; T.texH = h;
        for (const auto& id : j["ids"]) T.ids.push_back(id.is_string() ? id.get<std::string>() : std::string());
        gfx::TextureDesc d;
        d.width = w; d.height = h; d.format = gfx::TexFormat::RGBA8; d.filter = gfx::Filter::Trilinear; d.wrap = gfx::Wrap::Clamp; d.mipmaps = false;
        T.tex = dev->createTexture(d, rgba.data());
        state = 1;
      }
    }
    if (state != 1) SL_WARN("build menu: public/ui/furniture_thumbs.webp / .json missing (node native/tools/browser/render_thumbs.mjs): empty plates");
  }
  return state == 1 ? &T : nullptr;
}

BuildMenuLayout drawBuildMenu(Ui& ui, const BuildMenuState& s, const Input& in) {
  BuildMenuLayout L;
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u), tMd = std::max(13 * d, 15 * u);
  const UiFont NUM = UiFont::CondItalic;
  Ui::Tabular tab(ui);
  // #build-menu: right 28u, top 24u, bottom 64u, 430u wide (at least 250 px, at most the window less 32 px)
  const float w = std::min(std::max(430 * u, 250 * d), W - 32 * d), x = W - 28 * u - w, top = 24 * u, bottom = H - 64 * u;
  const float e = float(std::clamp(s.shownFor / 0.35, 0.0, 1.0)), ease = 1 - std::pow(1 - e, 3.f);
  const vec2 p = s.pointer;
  auto inside = [&](float rx, float ry, float rw, float rh) { return p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh; };
  L.over = p.x >= 0 && inside(x - 8 * u, top, w + 16 * u, bottom - top);
  ui.pushAlpha(ease);
  ui.pushTranslate(0, 8 * u * (1 - ease));
  float y = top;
  // the title, "Your chalet" and the money
  {
    Ui::Shadow sh{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
    ui.brushStroke(x, y, 230 * u, 70 * u, white, 7123, 250, 80, &sh);
    ui.textLH(x + 40 * u, y, 70 * u, 36 * u, NUM, blue, "FURNISH", UiAlign::Left, 0.04f);
    y += 70 * u + 4 * u;
    const vec4 shc = a(hex(0x000000), 0.55f);
    float lh = std::max(tMd * 1.3f, 28 * u);
    ui.textShadow(x + 12 * u, y + (lh - ui.lineHeight(tMd, UiFont::BodySemi)) / 2, tMd, UiFont::BodySemi, "Your chalet", UiAlign::Left, 0, 0, d, 8 * d, shc);
    ui.textLH(x + 12 * u, y, lh, tMd, UiFont::BodySemi, a(white, 0.92f), "Your chalet");
    std::string m = "$" + uiw::thousands(s.money);
    ui.textShadow(x + w - 8 * u, y + (lh - ui.lineHeight(28 * u, NUM)) / 2, 28 * u, NUM, m, UiAlign::Right, 0, 0, d, 8 * d, shc);
    ui.textLH(x + w - 8 * u, y, lh, 28 * u, NUM, white, m, UiAlign::Right);
    y += lh + 10 * u;
  }
  // the list's geometry first (the tab of the room at the top of the scrolled list is the one painted blue)
  const float gridGap = 10 * u, cardW = (w - 8 * u - gridGap) / 2, thumbH = (cardW - 20 * u) * 0.75f, cardH = 8 * u + thumbH + 7 * u + 19 * u + 3 * u + 19 * u + 10 * u;
  struct Card { int item; float cx, cy; };
  std::vector<Card> cards;
  L.itemSpan.assign(s.items.size(), {0.f, 0.f});
  L.cardCentre.assign(s.items.size(), vec2(-1));
  float ly = 2 * u;
  for (size_t c = 0; c < s.categories.size(); c++) {
    ly += 14 * u;
    L.catTop.push_back(ly);
    ly += tXs + 8 * u;
    int k = 0;
    for (size_t i = 0; i < s.items.size(); i++) {
      if (s.items[i].category != s.categories[c].first) continue;
      float cy = ly + float(k / 2) * (cardH + gridGap);
      cards.push_back({int(i), 2 * u + float(k % 2) * (cardW + gridGap), cy});
      L.itemSpan[i] = {cy, cy + cardH};
      k++;
    }
    if (k) ly += float((k + 1) / 2) * (cardH + gridGap) - gridGap;
  }
  const float contentH = ly + 26 * u;
  int curCat = 0;
  for (size_t c = 0; c < L.catTop.size(); c++) if (L.catTop[c] - 14 * u <= s.scroll + 8 * u) curCat = int(c);
  // the rooms' tabs (.seg-brush: brush-b chips, the current room's blue), wrapping
  {
    float tx = x, th = 36 * u;
    for (size_t c = 0; c < s.categories.size(); c++) {
      std::string t = s.categories[c].second;
      float tw = ui.textWidth(t, 18 * u, NUM, 0.05f) + 26 * u;
      if (tx > x && tx + tw > x + w) { tx = x; y += th + 6 * u; }
      bool on = int(c) == curCat, hv = inside(tx, y, tw, th);
      if (hv) L.tab = int(c);
      ui.brushPanel(tx, y, tw, th, on ? blue : a(white, hv ? 1.f : 0.88f), 1);
      ui.textLH(tx + 13 * u, y, th, 18 * u, NUM, on ? white : blue, t, UiAlign::Left, 0.05f);
      tx += tw + 6 * u;
    }
    y += th + 10 * u;
  }
  // the status strip's height (it sits under the list)
  std::vector<std::string> stL;
  if (!s.status.empty()) stL = uiw::wrap(ui, s.status, tSm, UiFont::BodyBold, w - 36 * u);
  const float stH = stL.empty() ? 0 : 8 * u + 20 * u + float(stL.size()) * tSm * 1.3f;
  const float listY = y, listH = std::max(40 * u, bottom - stH - listY);
  L.viewH = listH; L.maxScroll = std::max(0.f, contentH - listH);
  const float scroll = std::clamp(s.scroll, 0.f, L.maxScroll);
  // the list
  ui.pushClip(x - 12 * u, listY, w + 24 * u, listH);
  for (size_t c = 0; c < s.categories.size(); c++) {
    float hy = listY + L.catTop[c] - scroll;
    if (hy > listY + listH || hy + tXs < listY) continue;
    ui.rect(x + 6 * u, hy + tXs / 2 - 2 * u, 14 * u, 4 * u, red);
    std::string t = s.categories[c].second;
    ui.textShadow(x + 28 * u, hy + (tXs - ui.lineHeight(tXs, UiFont::BodyHeavy)) / 2, tXs, UiFont::BodyHeavy, t, UiAlign::Left, 0.18f, 0, d, 6 * d, a(hex(0x000000), 0.6f));
    ui.textLH(x + 28 * u, hy, tXs, tXs, UiFont::BodyHeavy, white, t, UiAlign::Left, 0.18f);
  }
  for (const Card& c : cards) {
    const auto& it = s.items[size_t(c.item)];
    float cx = x + c.cx, cy = listY + c.cy - scroll;
    if (cy > listY + listH || cy + cardH < listY) continue;
    bool sel = it.id == s.hand, hv = L.over && p.y >= listY && p.y <= listY + listH && inside(cx, cy, cardW, cardH), shortM = s.money < it.price;
    if (hv) L.card = c.item;
    if (cy >= listY && cy + cardH <= listY + listH) L.cardCentre[size_t(c.item)] = vec2(cx + cardW / 2, cy + cardH / 2);
    float dx = 0;
    vec4 paper = sel ? blue : a(white, hv ? 1.f : 0.92f);
    if (it.id == s.denyId && s.denyAge < 0.55) {
      // bm-deny: a shake (-6u, 6u, -3u), the paper red for a moment
      float q = float(s.denyAge / 0.55);
      dx = (q < 0.2f ? -6 * q / 0.2f : q < 0.45f ? -6 + 12 * (q - 0.2f) / 0.25f : q < 0.7f ? 6 - 9 * (q - 0.45f) / 0.25f : -3 * (1 - (q - 0.7f) / 0.3f)) * u;
      if (q < 0.35f) paper = red;
    }
    ui.pushTranslate(dx, hv && !sel ? -3 * u : 0);
    if (sel) ui.rect(cx - 6 * u, cy + cardH * 0.18f, 6 * u, cardH * 0.64f, red);
    ui.brushClip(cx, cy, cardW, cardH, paper, 700 + c.item, 3, 4, u);
    // the thumbnail's plate: radial-gradient(ellipse at 50% 60%, ice (white when selected), blue-pale)
    {
      float tx = cx + 10 * u, ty = cy + 8 * u, tw = cardW - 20 * u;
      const vec4 c0 = sel ? white : ice, c1 = bluePale;
      ui.roundRect(tx, ty, tw, thumbH, 4 * u, c1);
      ui.pushClip(tx + 2 * u, ty + 2 * u, tw - 4 * u, thumbH - 4 * u);
      ui.gradientGrid(tx, ty, tw, thumbH, 8, 6, [&](float fx, float fy) {
        float r = std::min(1.f, std::hypot((fx - 0.5f) / 0.5f, (fy - 0.6f) / 0.6f) / 1.2f);
        return c0 + (c1 - c0) * r;
      });
      ui.popClip();
      // img.bm-thumb: the model's own render (furniture.js renderThumbs), object-fit: contain in the 4:3 plate
      if (const BuildThumbs* T = s.thumbs) {
        int k = -1;
        for (size_t i = 0; i < T->ids.size(); i++) if (T->ids[i] == it.id) { k = int(i); break; }
        if (k >= 0 && T->texW > 0) {
          const float x0 = float((k % T->cols) * T->w), y0 = float((k / T->cols) * T->h);
          ui.image(T->tex, tx, ty, tw, thumbH, vec2((x0 + 0.5f) / float(T->texW), (y0 + 0.5f) / float(T->texH)),
                   vec2((x0 + float(T->w) - 0.5f) / float(T->texW), (y0 + float(T->h) - 0.5f) / float(T->texH)));
        }
      }
    }
    float ny = cy + 8 * u + thumbH + 7 * u;
    ui.textLH(cx + 10 * u, ny, 19 * u, 19 * u, NUM, sel ? white : blue, uiw::ellipsis(ui, uiw::upper(it.name), 19 * u, NUM, cardW - 20 * u, 0.02f), UiAlign::Left, 0.02f);
    ui.textLH(cx + 10 * u, ny + 19 * u + 3 * u, 19 * u, 19 * u, NUM, shortM ? (sel ? hex(0xffb3ad) : ko) : sel ? a(white, 0.85f) : blueDim, "$" + uiw::thousands(it.price));
    ui.popTransform();
  }
  ui.popClip();
  // the status strip
  if (!stL.empty()) {
    float sy = listY + listH + 8 * u, sh2 = 20 * u + float(stL.size()) * tSm * 1.3f;
    Ui::Shadow sh{0, 8 * u, 18 * u, hex(0x000e2c, 0.3f)};
    ui.brushClip(x, sy, w, sh2, s.statusBad ? ko : white, 911, 4, 4, u, &sh);
    float ty = sy + 10 * u;
    for (const std::string& l : stL) { ui.textLH(x + 18 * u, ty, tSm * 1.3f, tSm, UiFont::BodyBold, s.statusBad ? white : blue, l); ty += tSm * 1.3f; }
  }
  ui.popTransform();
  ui.popAlpha();
  // #build-foot: the mode chip and the key hints, between the money pill and the column (wrapping upward)
  {
    using uiw::Hint;
    auto K = [&](const char* id) { return prompts::K(in, id); };
    std::string mode = s.pad && s.vmouse ? "MOUSE" : s.pad ? "AIM" : s.look ? "LOOK AROUND" : "CURSOR";
    std::vector<Hint> hs;
    if (s.pad && s.vmouse) hs = {{{K("vmouse")}, "MOUSE OFF"}, {{K("move")}, "POINT"}, {{K("confirm")}, "CLICK \xC2\xB7 BUY & PLACE"}, {{K("cancel")}, "EMPTY HAND"}, {{K("look")}, "LOOK"}, {{K("view")}, "ROTATE"},
                                 {{K("pickup")}, "MOVE"}, {{K("alt")}, "SELL 50%"}, {{K("map")}, "DONE"}};
    else {
      if (s.pad) hs.push_back({{K("vmouse")}, "MOUSE ON"});
      hs.push_back({{K("move")}, "WALK"});
      hs.push_back({{K("prevItem"), K("nextItem")}, "BROWSE"});
      hs.push_back({{s.pad ? K("jump") : std::string("CLICK")}, "BUY & PLACE"});
      hs.push_back({s.pad ? std::vector<std::string>{K("view")} : std::vector<std::string>{K("view"), "WHEEL"}, "ROTATE"});
      hs.push_back({{K("pickup")}, "MOVE"});
      hs.push_back({{K("alt")}, "SELL 50%"});
      hs.push_back({{K("restart")}, "EMPTY HAND"});
      hs.push_back({{s.pad ? K("map") : K("furnish")}, "DONE"});
    }
    const float left = 340 * u, right = W - 480 * u, kh = ui.kcHeight(u), chipH = 14 * u + 18 * u, rowH = std::max(kh, chipH), fs = tXs, gap = std::max(4 * d, 6 * u);
    float chipW = ui.textWidth(mode, 18 * u, NUM, 0.06f) + 28 * u;
    auto hintW = [&](const Hint& h) { float hw = ui.textWidth(h.label, fs, UiFont::BodySemi, 0.1f); for (size_t i = 0; i < h.caps.size(); i++) hw += ui.kcWidth(u, h.caps[i]) + (i + 1 < h.caps.size() ? 4 * u : gap); return hw; };
    // rows (flex-wrap), then drawn from the bottom row up
    std::vector<std::vector<int>> rows(1);
    float rx = left + chipW + 22 * u;
    for (size_t i = 0; i < hs.size(); i++) {
      float hw = hintW(hs[i]);
      if (rx + hw > std::max(right, left + chipW + 200 * u) && !rows.back().empty()) { rows.emplace_back(); rx = left; }
      rows.back().push_back(int(i));
      rx += hw + 22 * u;
    }
    float ry = H - 22 * u - float(rows.size()) * rowH - float(rows.size() - 1) * 10 * u;
    for (size_t r = 0; r < rows.size(); r++) {
      float hx = left;
      if (r == 0) {
        ui.brushClip(hx, ry + (rowH - chipH) / 2, chipW, chipH, s.look && !s.pad ? red : blue, 321, 4, 4, u);
        ui.textLH(hx + 14 * u, ry + (rowH - chipH) / 2, chipH, 18 * u, NUM, white, mode, UiAlign::Left, 0.06f);
        hx += chipW + 22 * u;
      }
      std::vector<Hint> rowH2;
      for (int i : rows[r]) rowH2.push_back(hs[size_t(i)]);
      uiw::hints(ui, hx, ry + (rowH - kh) / 2, u, rowH2, a(white, 0.92f), a(white, 0.92f));
      ry += rowH + 10 * u;
    }
  }
  // #build-flash: a red vignette for a refused purchase (0.4 s)
  if (s.denyAge < 0.4) {
    float al = float(1 - s.denyAge / 0.4);
    ui.gradientGrid(0, 0, W, H, 16, 10, [&](float fx, float fy) {
      float r = std::min(1.f, std::hypot((fx - 0.5f) * 2, (fy - 0.5f) * 2) / 1.414f);
      return vec4(0.816f, 0.204f, 0.173f, 0.55f * std::clamp((r - 0.4f) / 0.6f, 0.f, 1.f) * al);
    });
  }
  return L;
}

} // namespace sl
