#include "game/carconfigui.h"
#include "core/prompts.h"
#include "game/ui_widgets.h"
#include "platform/platform.h"
#include <algorithm>
#include <cmath>

namespace sl {
using namespace ui_color;

const std::vector<CarPaint>& carPaints() {
  static const std::vector<CarPaint> P = {
    {"white", "Alpine White", 0xf2f2f0, 0}, {"black", "Night Black", 0x15171a, 0}, {"red", "Tornado Red", 0xa8161c, 0}, {"yellow", "Racing Yellow", 0xe2b81c, 0},
    {"orange", "Arizona Orange", 0xd0611c, 0}, {"kingfisher", "Kingfisher Blue", 0x1f68ad, 0}, {"lime", "Lime Green", 0x78ad2a, 0},
    {"silver", "Glacier Silver", 0xb2b7bd, 1}, {"graphite", "Graphite Grey", 0x464a50, 1}, {"blue", "Midnight Blue", 0x1d2b50, 1}, {"green", "Forest Green", 0x2a4636, 1},
    {"burgundy", "Burgundy", 0x5e1622, 1}, {"bronze", "Bronze", 0x8a5a2e, 1}, {"ice", "Ice Blue", 0x8fb1c8, 1},
    {"pearlwhite", "Pearl White", 0xefebe2, 2}, {"violet", "Velvet Violet", 0x4a2a5e, 2},
    {"mblack", "Matte Black", 0x1c1d1f, 3}, {"mgrey", "Matte Nardo Grey", 0x6a6d70, 3}, {"army", "Matte Army Green", 0x4a5238, 3}, {"sand", "Matte Desert Sand", 0xb49a72, 3}};
  return P;
}
const std::vector<CarRim>& carRims() {
  static const std::vector<CarRim> R = {{"orig", "Factory alloys", 0xffffff, 0}, {"black", "Gloss black", 0x1b1c1e, 1000}, {"gunmetal", "Gunmetal", 0x5a5e64, 1000},
                                        {"bronze", "Bronze", 0x9a6a36, 1500}, {"gold", "Gold", 0xd0a650, 1500}, {"red", "Red", 0xa01a1e, 1500}};
  return R;
}
const CarPaint& carPaintOf(const std::string& id) { for (const CarPaint& p : carPaints()) if (id == p.id) return p; return carPaints()[0]; }
const CarRim& carRimOf(const std::string& id) { for (const CarRim& r : carRims()) if (id == r.id) return r; return carRims()[0]; }
const char* carFinishLabel(int f) { static const char* L[4] = {"Solid", "Metallic", "Pearl", "Matte"}; return L[std::clamp(f, 0, 3)]; }
int carFinishCost(int f) { static const int C[4] = {0, 1500, 2500, 3500}; return C[std::clamp(f, 0, 3)]; }
int carExtras(const CarCfg& c) { return carFinishCost(carPaintOf(c.paint).finish) + carRimOf(c.rims).cost + (c.custom ? CAR_PLATE_COST : 0); }
std::string randomCarPlate(uint32_t seed) {
  static const char* CANTONS[8] = {"VS", "GR", "BE", "UR", "OW", "TI", "ZH", "LU"};
  uint32_t h = seed * 2654435761u + 0x9e3779b9u;
  h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
  return std::string(CANTONS[h & 7]) + " " + std::to_string(1000 + (h >> 3) % 899000);
}
std::string cleanCarPlate(const std::string& s) {
  std::string o;
  for (char ch : s) {
    char c = char(std::toupper(static_cast<unsigned char>(ch)));
    bool ok = (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ' ' || c == '-';
    if (!ok) continue;
    if (o.empty() && (c == ' ' || c == '-')) continue;
    if (c == ' ' && !o.empty() && o.back() == ' ') continue;
    if (o.size() < 8) o += c;
  }
  return o;
}

namespace {
float easeOut(double t) { float e = float(std::clamp(t, 0.0, 1.0)); return 1 - std::pow(1 - e, 3.f); }
std::string money(long long v) { return "$" + uiw::thousands(v); }
std::string plus(int v) { return v ? "+" + money(v) : std::string("Included"); }
const char* STEP_LABEL[4] = {"PAINT", "WHEELS", "PLATE", "SUMMARY"};
const char* STEP_ONE[4] = {"PAINT", "WHEELS", "NUMBER PLATE", "YOUR CAR"};

// .cr-sw-paint: a painted ball: the gloss highlight, the flake gradient of a metallic, a pearl's sheen, matte flat
void paintSwatch(Ui& ui, float cx, float cy, float s, const CarPaint& p, float u) {
  const float r = s / 2;
  ui.boxShadow(cx - r, cy - r, s, s, r, 0, 2 * u, 5 * u, hex(0x00143c, 0.3f));
  ui.circle(cx, cy, r + 2 * u, a(white, 0.8f));
  ui.circle(cx, cy, r, hex(p.hex));
  if (p.finish == 1 || p.finish == 2) {
    // linear-gradient(150deg, light, dark): a light cap up left, a shade down right
    ui.pushClip(cx - r, cy - r, s, s);
    ui.circle(cx - r * 0.35f, cy - r * 0.45f, r * 0.9f, p.finish == 2 ? hex(0xffdcf0, 0.22f) : a(white, 0.2f));
    ui.popClip();
  }
  // inset 0 -4u 6u rgba(0, 0, 0, 0.3): the shade under the ball
  ui.arc(cx, cy, r - 1.5f * u, 0.5f, 2.64f, 3 * u, a(hex(0x000000), p.finish == 3 ? 0.08f : 0.13f));
  if (p.finish != 3) {
    ui.circle(cx - s * 0.16f, cy - s * 0.2f, s * 0.16f, a(white, 0.28f));
    ui.circle(cx - s * 0.16f, cy - s * 0.2f, s * 0.09f, a(white, 0.8f));
  }
}
// .cr-sw-rim: the tyre, the rim in its colour, the hub
void rimSwatch(Ui& ui, float cx, float cy, float s, uint32_t c, float u) {
  const float r = s / 2;
  ui.boxShadow(cx - r, cy - r, s, s, r, 0, 2 * u, 5 * u, hex(0x00143c, 0.3f));
  ui.circle(cx, cy, r, hex(0x2a2a2a));
  ui.circle(cx, cy, r * 0.7f, hex(0x111111));
  ui.circle(cx, cy, r * 0.52f, hex(c));
  ui.circle(cx, cy, r * 0.14f, hex(0x222222));
}
// .cr-ch: the shields at the plate's ends (the Swiss cross; the canton's: red and white halves)
void shield(Ui& ui, float x, float y, float w, float h, bool canton) {
  auto shape = [&](float x0, float x1, const vec4& c) {
    // polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%), cut to [x0, x1]
    std::vector<vec2> p;
    auto yAt = [&](float px) { float t = std::fabs((px - x) / w - 0.5f) * 2; return y + h * (1 - 0.4f * t); };
    p.push_back({x0, y}); p.push_back({x1, y}); p.push_back({x1, yAt(x1)});
    if (x0 < x + w / 2 && x1 > x + w / 2) p.push_back({x + w / 2, y + h});
    p.push_back({x0, yAt(x0)});
    ui.polyAA(p, c);
  };
  if (canton) { shape(x, x + w / 2, hex(0xd52b1e)); shape(x + w / 2, x + w, hex(0xf2f2f2)); return; }
  shape(x, x + w, hex(0xd52b1e));
  ui.rect(x + w * 0.39f, y + h * 0.42f - h * 0.3f + h * 0.12f, w * 0.22f, h * 0.6f * 0.8f, white);
  ui.rect(x + w * 0.18f, y + h * 0.42f - h * 0.1f + h * 0.02f, w * 0.64f, h * 0.2f, white);
}
} // namespace

bool frameCarConfig(Ui& ui, const UiNav& nav, const Input& in, CarCfgView& v, double dt, double now) {
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width()), H = float(ui.height());
  const float tXs = std::max(11 * d, 11 * u), tMd = std::max(13 * d, 15 * u);
  const UiFont NUM = UiFont::CondItalic;
  Ui::Tabular tab(ui);
  if (v.openedAt < 0) {
    v.openedAt = now;
    if (v.cfg.plate.empty()) v.cfg.plate = randomCarPlate(uint32_t(now * 1000) + 17u);
    if (v.preview) v.preview(v.cfg, v.step);
  }
  if (v.refresh) v.refresh(v);
  v.step = std::clamp(v.step, 0, 3);
  if (v.shownStep != v.step) {   // (a new step: its list from the top, the plate takes the keys)
    v.shownStep = v.step; v.scroll = v.scrollTarget = 0; v.reveal = true; v.swapAt = now;
    v.typing = v.step == 2 && !nav.usingPad; v.selAll = v.typing;
    v.sellArm.clear();
  }
  const double age = now - v.openedAt;
  const auto& PAINTS = carPaints();
  const auto& RIMS = carRims();
  const bool last = v.step == 3;
  auto plateKey = [](const std::string& p) { std::string k; for (char c : p) if (c != ' ' && c != '-') k += char(std::toupper(static_cast<unsigned char>(c))); return k; };
  bool plateTaken = false;
  for (const auto& g : v.garage) if (plateKey(g.plate) == plateKey(v.cfg.plate)) plateTaken = true;
  const int extras = carExtras(v.cfg), total = v.carPrice + extras;
  const bool full = int(v.garage.size()) >= v.garageMax, broke = v.money < total;
  const bool ready = !(last && (full || broke || plateTaken));

  // ---- layout (.os-col / .cr-col: left 64u, top 34u, bottom 70u, 560u wide)
  const float colX = 64 * u, colW = std::min(560 * u, W - 96 * u), top = 34 * u, bottom = H - 70 * u;
  const float headH = 90 * u + 6 * u + tMd * 1.35f + 12 * u;
  const float tabsY = top + headH, tabH = 44 * u, tabGap = 8 * u, tabW = (colW - 3 * tabGap) / 4, listY = tabsY + tabH + 14 * u;
  const float btnH = 74 * u;
  const float detH = 16 * u + tXs + 7 * u + 36 * u * 0.95f + 10 * u + (tXs * 1.2f + 5 * u + 30 * u) + 12 * u + btnH + 18 * u;
  const float detY = bottom - detH, listH = std::max(60 * u, detY - 10 * u - listY);
  const float rowW = colW - 16 * u - 14 * u, rowH = 54 * u, rowGap = 8 * u;
  // the detail card's buttons: BACK (from the second step), the main stroke takes the rest of the row
  const float actY = detY + detH - 18 * u - btnH, actX = colX + 28 * u, actRight = colX + colW - 28 * u;
  const float backW = v.step ? std::max(116 * u, 40 * u + ui.textWidth("BACK", 34 * u, NUM, 0.06f) + 34 * u) : 0;
  const float mainX = actX + (v.step ? backW + 12 * u : 0), mainW = std::max(120 * u, actRight - mainX);
  v.actLabel = last ? (full ? "GARAGE FULL" : plateTaken ? "PLATE TAKEN" : broke ? "NOT ENOUGH MONEY" : std::string("BUY") + (v.owned ? " ANOTHER" : "") + " \xC2\xB7 " + money(total)) : "NEXT";

  // the step's rows (paint: grouped by finish; wheels), each with its y in the list
  struct Row { std::string id, name, sub, price, group; float y = 0; };
  std::vector<Row> rows;
  float contentH = 0;
  int on = -1;
  if (v.step == 0 || v.step == 1) {
    float y = 2 * u;
    std::string lastG;
    if (v.step == 0) for (const CarPaint& p : PAINTS) {
      Row r; r.id = p.id; r.name = p.label; r.sub = carFinishLabel(p.finish); r.price = plus(carFinishCost(p.finish));
      if (lastG != r.sub) { lastG = r.sub; r.group = uiw::upper(r.sub); y += 6 * u + tXs - 2 * u + rowGap; }
      r.y = y; y += rowH + rowGap;
      if (v.cfg.paint == r.id) on = int(rows.size());
      rows.push_back(r);
    }
    else for (const CarRim& rm : RIMS) {
      Row r; r.id = rm.id; r.name = rm.label; r.sub = r.id == "orig" ? "The car's own alloys" : "Painted alloys, tyres stay black"; r.price = plus(rm.cost);
      r.y = y; y += rowH + rowGap;
      if (v.cfg.rims == r.id) on = int(rows.size());
      rows.push_back(r);
    }
    contentH = y - rowGap + 22 * u;
    if (on < 0) on = 0;
  }
  const int n = int(rows.size());
  // the plate step's pieces
  const float plW = std::min(470 * u, colW), plH = 104 * u, plY = listY + 10 * u;
  const float rndY = plY + plH + 14 * u, rndH = 50 * u, rndW = std::max(170 * u, 26 * u + ui.textWidth("RANDOM", 24 * u, NUM, 0.06f) + 40 * u);
  // the summary: its card's rows, the terms, MY CARS
  const float sumX = colX, sumW = colW - 16 * u, sumRowH = 10 * u + 11 * u + 2 * u + 22 * u * 1.05f + 1.5f * u;
  std::vector<std::string> terms;
  std::vector<int> termStart;
  float sumH = 0, garY = 0, garH = 0;
  if (last) {
    const std::string T[3] = {
      "Yours for good \xC2\xB7 it waits in your bay at the Autohaus \xC2\xB7 " + v.interactKey + " to drive",
      "Up to " + std::to_string(v.garageMax) + " cars, the same model more than once too \xC2\xB7 each its own plate \xC2\xB7 one out at a time (MY CARS: pick which) \xC2\xB7 sell one back for half what you paid",
      "Dents and damage: the Werkstatt next door repairs it \xC2\xB7 priced by the damage: from $5 for a scratch up to " + money(v.repairFull) + " \xC2\xB7 Wreck it: " + money(v.wreckFee) + " (tow " + money(v.towFee) +
        " + repair " + money(v.repairFull) + ") \xC2\xB7 the tow truck brings it back repaired \xC2\xB7 rammed off by the police: not repaired, it is gone"};
    for (const std::string& t : T) { termStart.push_back(int(terms.size())); for (const std::string& l : uiw::wrap(ui, t, tXs, UiFont::BodyMed, sumW - 48 * u - 18 * u)) terms.push_back(l); }
    sumH = 14 * u + 4 * (sumRowH + 6 * u) + 6 * u + 40 * u + 6 * u + 4 * u + float(terms.size()) * tXs * 1.45f + 16 * u;
    garY = 2 * u + sumH + rowGap + 10 * u;
    if (!v.garage.empty()) garH = 14 * u + tXs + 6 * u + float(v.garage.size()) * (sumRowH + 6 * u) + 10 * u;
    contentH = (v.garage.empty() ? 2 * u + sumH : garY + garH) + 22 * u;
  }
  const float maxScroll = std::max(0.f, contentH - listH);

  // ---- input (carrental.js key(); the key that opened it is not its first choice)
  auto snd = [&](const char* s) { if (v.sound) v.sound(s); };
  auto changed = [&]() { if (v.preview) v.preview(v.cfg, v.step); v.swapAt = now; };
  auto go = [&](int i) { i = std::clamp(i, 0, 3); if (i == v.step) return; v.step = i; snd("tick"); if (v.preview) v.preview(v.cfg, v.step); };
  auto pick = [&](int i) {
    if (i < 0 || i >= n) return;
    std::string& key = v.step == 0 ? v.cfg.paint : v.cfg.rims;
    if (key == rows[size_t(i)].id) return;
    key = rows[size_t(i)].id; on = i; v.reveal = true; snd("tick"); changed();
  };
  bool closeNow = false, bought = false;
  auto rent = [&]() {
    if (full) { v.nopeAt = now; snd("error"); if (v.flashBad) v.flashBad("Your garage is full (" + std::to_string(v.garageMax) + " cars) \xC2\xB7 sell one first (MY CARS)"); return; }
    if (plateTaken) { v.nopeAt = now; snd("error"); go(2); return; }
    if (broke) { v.nopeAt = now; snd("error"); return; }
    bought = true;
  };
  auto next = [&]() { if (v.step < 3) go(v.step + 1); else rent(); };
  auto randomPlate = [&]() { v.cfg.plate = randomCarPlate(uint32_t(now * 1000) ^ uint32_t(v.frames * 7919)); v.cfg.custom = false; v.selAll = v.typing; snd("tick"); changed(); };
  v.frames++;
  const int stepWas = v.step;
  if (v.frames > 1) {
    bool esc = false, enter = false, blur = false, back = false;
    for (platform::Key k : nav.keys) {
      if (k == platform::Key::Escape) esc = true;
      if (k == platform::Key::Enter) enter = true;
      if (k == platform::Key::ArrowUp || k == platform::Key::ArrowDown || k == platform::Key::Tab) blur = true;
      if (k == platform::Key::Backspace) back = true;
    }
    if (v.typing && !nav.usingPad) {
      // the field takes what you type (W A S D and Backspace are text here, not steps)
      if (esc) closeNow = true;
      else if (enter) { v.typing = false; next(); }
      else if (blur) v.typing = false;
      else {
        std::string t = v.cfg.plate;
        bool edit = false;
        if (back) { if (v.selAll) t.clear(); else if (!t.empty()) t.pop_back(); edit = true; }
        if (!nav.text.empty()) { t = cleanCarPlate((v.selAll ? std::string() : t) + nav.text); edit = true; }
        if (edit) {
          v.selAll = false;
          if (!plateKey(t).empty() || back) { v.cfg.plate = t; v.cfg.custom = true; changed(); }
        }
      }
    } else if (nav.cancel || nav.menu) closeNow = true;
    else if (nav.up && n) pick((on + n - 1) % n);
    else if (nav.down && n) pick((on + 1) % n);
    else if (last && (nav.up || nav.down)) v.scrollTarget += (nav.down ? 1.f : -1.f) * (sumRowH + 6 * u) * 2;   // (the summary: the keys scroll it to MY CARS)
    else if (nav.left || nav.tabPrev) go(v.step - 1);
    else if (nav.right || nav.tabNext) go(v.step + 1);
    else if (nav.confirm) next();
  }
  auto inside = [&](float rx, float ry, float rw, float rh) { return nav.mouse.x >= rx && nav.mouse.x <= rx + rw && nav.mouse.y >= ry && nav.mouse.y <= ry + rh; };
  const bool mouseOk = nav.mouse.x >= 0 && !nav.usingPad;
  const bool inList = mouseOk && inside(colX - 16 * u, listY, colW + 32 * u, listH);
  int hoverRow = -1, hoverTab = -1, hoverSum = -1, hoverCar = -1, hoverSell = -1;
  for (int i = 0; i < 4; i++) if (mouseOk && inside(colX + float(i) * (tabW + tabGap), tabsY, tabW, tabH)) hoverTab = i;
  if (inList) for (int i = 0; i < n; i++) { float ry = listY + rows[size_t(i)].y - v.scroll; if (nav.mouse.y >= ry && nav.mouse.y <= ry + rowH && nav.mouse.x <= colX + rowW + 12 * u) hoverRow = i; }
  auto sellRect = [&](int i, float& sx, float& sy, float& sw, float& sh, std::string& label) {
    const auto& g = v.garage[size_t(i)];
    label = v.sellArm == g.plate ? "SURE? +" + money(g.value) : "SELL";
    sw = ui.textWidth(label, 14 * u, NUM, 0.08f) + 18 * u; sh = 14 * u + 8 * u;
    sx = sumX + sumW - 24 * u - sw;
    sy = listY + garY + 14 * u + tXs + 6 * u + float(i) * (sumRowH + 6 * u) - v.scroll + (sumRowH - sh) / 2;
  };
  if (last && inList) {
    for (int k = 1; k < 4; k++) { float ry = listY + 2 * u + 14 * u + float(k) * (sumRowH + 6 * u) - v.scroll; if (inside(sumX + 24 * u, ry, sumW - 48 * u, sumRowH)) hoverSum = k - 1; }
    for (int i = 0; i < int(v.garage.size()); i++) {
      float sx, sy, sw, sh; std::string lb;
      sellRect(i, sx, sy, sw, sh, lb);
      float ry = listY + garY + 14 * u + tXs + 6 * u + float(i) * (sumRowH + 6 * u) - v.scroll;
      if (inside(sx, sy, sw, sh)) hoverSell = i;
      else if (inside(sumX + 24 * u, ry, sumW - 48 * u, sumRowH)) hoverCar = i;
    }
  }
  const bool hoverMain = mouseOk && inside(mainX, actY, mainW, btnH), hoverBack = v.step > 0 && mouseOk && inside(actX, actY, backW, btnH);
  const bool hoverPlate = v.step == 2 && mouseOk && inside(colX, plY, plW, plH), hoverRnd = v.step == 2 && mouseOk && inside(colX, rndY, rndW, rndH);
  if (nav.wheel != 0 && inList) v.scrollTarget = std::clamp(v.scrollTarget - nav.wheel * 48 * u, 0.f, maxScroll);
  if (std::fabs(nav.stickR.y) > 0.2f) v.scrollTarget = std::clamp(v.scrollTarget + nav.stickR.y * float(dt) * 900 * u, 0.f, maxScroll);
  std::string doTakeOut, doSell;
  if (nav.click && mouseOk && v.frames > 1 && stepWas == v.step) {
    if (hoverTab >= 0) go(hoverTab);
    else if (hoverMain) next();
    else if (hoverBack) go(v.step - 1);
    else if (hoverRow >= 0) {
      if (hoverRow == v.lastClickRow && now - v.lastClickAt < 0.4 && hoverRow == on) next();   // (dblclick: the next step)
      else pick(hoverRow);
      v.lastClickRow = hoverRow; v.lastClickAt = now;
    }
    else if (hoverRnd) randomPlate();
    else if (hoverPlate) { v.typing = true; v.selAll = true; }
    else if (hoverSum >= 0) go(hoverSum);
    else if (hoverSell >= 0) {
      const auto& g = v.garage[size_t(hoverSell)];
      if (v.sellArm != g.plate) { v.sellArm = g.plate; snd("tick"); } else doSell = g.plate;
    }
    else if (hoverCar >= 0) {
      const auto& g = v.garage[size_t(hoverCar)];
      if (g.out) { v.nopeAt = now; snd("error"); } else doTakeOut = g.plate;
    }
    else if (v.step == 2) v.typing = false;
  }
  // dragging right of the column turns the car
  if (mouseOk && nav.mouseDown && nav.mouse.x > W * 0.5f) {
    if (v.dragging && v.drag) v.drag((nav.mouse.x - v.lastMouse.x) / d * 0.008f, (nav.mouse.y - v.lastMouse.y) / d * 0.006f);
    v.dragging = true; v.lastMouse = nav.mouse;
  } else v.dragging = false;
  if (closeNow || bought || !doTakeOut.empty() || !doSell.empty()) {
    v.typing = false;
    CarCfg c = v.cfg;
    auto closed = v.closed;
    auto buy = v.buy; auto takeOut = v.takeOut; auto sell = v.sell;
    if (closed) closed();
    if (bought && buy) buy(c, total);
    else if (!doTakeOut.empty() && takeOut) takeOut(doTakeOut);
    else if (!doSell.empty() && sell) sell(doSell);
    return false;
  }
  if (stepWas != v.step) return true;   // (the new step is laid out next frame)
  if (v.reveal && n) {   // (scrollIntoView: nearest)
    v.reveal = false;
    float ry = rows[size_t(on)].y;
    if (ry < v.scrollTarget + 24 * u) v.scrollTarget = ry - (rows[size_t(on)].group.empty() ? 2 * u : 6 * u + tXs + 6 * u + 2 * u);
    else if (ry + rowH > v.scrollTarget + listH - 30 * u) v.scrollTarget = ry + rowH - listH + 30 * u;
  }
  v.scrollTarget = std::clamp(v.scrollTarget, 0.f, maxScroll);
  v.scroll = std::clamp(v.scroll, 0.f, maxScroll);
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
    // the title and its line (.menu-title 330u wide, brushSVG(4327, 360, 100); .menu-sub)
    Ui::Shadow sh{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
    ui.brushStroke(colX, top, std::min(330 * u, colW), 90 * u, white, 4327, 360, 100, &sh);
    ui.textLH(colX + 40 * u, top, 90 * u, 44 * u, NUM, blue, "AUTOHAUS", UiAlign::Left, 0.04f);
    const std::string sub = "Build your car \xC2\xB7 yours for good";
    float sy = top + 90 * u + 6 * u, lh = tMd * 1.35f;
    ui.textShadow(colX + 12 * u, sy + (lh - ui.lineHeight(tMd, UiFont::BodySemi)) / 2, tMd, UiFont::BodySemi, sub, UiAlign::Left, 0.02f, 0, d, 8 * d, hex(0x000a1e, 0.6f));
    ui.textLH(colX + 12 * u, sy, lh, tMd, UiFont::BodySemi, a(white, 0.92f), sub, UiAlign::Left, 0.02f);
  }
  // the steps (.cr-steps: four equal brush tabs, the number small before the word; red once done)
  for (int i = 0; i < 4; i++) {
    float tx = colX + float(i) * (tabW + tabGap);
    bool cur = i == v.step, done = i < v.step;
    float fs = 19 * u, nfs = fs * 0.72f, nw = ui.textWidth(std::to_string(i + 1), nfs, UiFont::CondBold) + 5 * u, lw = ui.textWidth(STEP_LABEL[i], fs, NUM, 0.05f);
    if (nw + lw > tabW - 12 * u) { float k = (tabW - 12 * u) / (nw + lw); fs *= k; nfs *= k; nw *= k; lw *= k; }
    ui.brushPanel(tx, tabsY, tabW, tabH, cur ? blue : a(white, hoverTab == i ? 1.f : 0.88f), 1);
    float x0 = tx + (tabW - nw - lw) / 2;
    ui.textLH(x0, tabsY, tabH, nfs, UiFont::CondBold, done ? red : a(cur ? white : blue, 0.6f), std::to_string(i + 1));
    ui.textLH(x0 + nw, tabsY, tabH, fs, NUM, cur ? white : blue, STEP_LABEL[i], UiAlign::Left, 0.05f);
  }
  // the list (fading out over its last 34u, as the web's mask)
  ui.pushClip(0, listY, colX + colW + 40 * u, listH);
  auto fadeAt = [&](float yMid) { return std::clamp((listY + listH - yMid) / (34 * u), 0.f, 1.f); };
  if (n) {
    for (int i = 0; i < n; i++) {
      const Row& r = rows[size_t(i)];
      float ry = listY + r.y - v.scroll;
      if (!r.group.empty()) {
        float gy = ry - rowGap + 2 * u - tXs;
        if (gy + tXs > listY && gy < listY + listH) {
          ui.pushAlpha(fadeAt(gy + tXs / 2));
          ui.textShadow(colX + 4 * u, gy + (tXs - ui.lineHeight(tXs, UiFont::BodyHeavy)) / 2, tXs, UiFont::BodyHeavy, r.group, UiAlign::Left, 0.18f, 0, d, 6 * d, a(hex(0x000000), 0.5f));
          ui.textLH(colX + 4 * u, gy, tXs, tXs, UiFont::BodyHeavy, white, r.group, UiAlign::Left, 0.18f);
          ui.popAlpha();
        }
      }
      if (ry + rowH < listY || ry > listY + listH) continue;
      bool sel = i == on, hv = hoverRow == i && !sel;
      float rin = easeOut((now - v.swapAt + 0.3 - 0.04 - 0.022 * double(i)) / 0.45);
      if (now - v.openedAt < 1.5) rin = easeOut((now - v.openedAt - 0.04 - 0.022 * double(i)) / 0.45);
      float rx = colX + (sel ? 12 * u : hv ? 6 * u : 0) - 40 * u * (1 - rin);
      ui.pushAlpha(fadeAt(ry + rowH * 0.5f) * rin);
      if (sel) ui.rect(rx - 12 * u, ry + rowH * 0.2f, 6 * u, rowH * 0.6f, red);
      ui.brushClip(rx, ry, rowW, rowH, sel ? blue : a(white, hv ? 1.f : 0.92f), 600 + i * 7, 4, 3, u);
      if (ry >= listY - 1 && ry + rowH <= listY + listH + 1) {
        if (v.step == 0) paintSwatch(ui, rx + 16 * u + 18 * u, ry + rowH / 2, 36 * u, PAINTS[size_t(i)], u);
        else rimSwatch(ui, rx + 16 * u + 18 * u, ry + rowH / 2, 36 * u, i == 0 ? 0xc9ced4 : RIMS[size_t(i)].hex, u);
      }
      float tx = rx + 16 * u + 36 * u + 14 * u, right = rx + rowW - 22 * u;
      float pw = ui.textLH(right, ry, rowH, 24 * u, NUM, sel ? white : blue, r.price, UiAlign::Right), avail = right - pw - 14 * u - tx;
      float blockH = 24 * u + 4 * u + tXs * 1.25f, by = ry + (rowH - blockH) / 2;
      ui.textLH(tx, by, 24 * u, 24 * u, NUM, sel ? white : blue, uiw::ellipsis(ui, uiw::upper(r.name), 24 * u, NUM, avail, 0.02f), UiAlign::Left, 0.02f);
      ui.textLH(tx, by + 24 * u + 4 * u, tXs * 1.25f, tXs, UiFont::BodyMed, sel ? a(white, 0.82f) : blueDim, uiw::ellipsis(ui, r.sub, tXs, UiFont::BodyMed, avail));
      ui.popAlpha();
    }
  } else if (v.step == 2) {
    // the plate: white, black condensed letters, the shields at its ends; you type straight on it
    ui.boxShadow(colX, plY, plW, plH, 10 * u, 0, 10 * u, 24 * u, hex(0x000e2c, 0.4f));
    ui.roundRect(colX, plY, plW, plH, 10 * u, hex(0x111111));
    ui.roundRect(colX + 4 * u, plY + 4 * u, plW - 8 * u, plH - 8 * u, 6 * u, hex(0xf7f7f4));
    shield(ui, colX + 18 * u, plY + (plH - 38 * u) / 2, 30 * u, 38 * u, false);
    shield(ui, colX + plW - 18 * u - 30 * u, plY + (plH - 38 * u) / 2, 30 * u, 38 * u, true);
    {
      const float fieldX = colX + 18 * u + 30 * u + 10 * u, fieldW = plW - 2 * (18 * u + 30 * u + 10 * u);
      float fs = 68 * u, tw = ui.textWidth(v.cfg.plate, fs, UiFont::CondBold, 0.04f);
      if (tw > fieldW) { fs *= fieldW / tw; tw = fieldW; }
      float cx = fieldX + fieldW / 2;
      if (v.typing && v.selAll && !v.cfg.plate.empty()) ui.rect(cx - tw / 2 - 2 * u, plY + (plH - 68 * u * 1.1f) / 2, tw + 4 * u, 68 * u * 1.1f, hex(0xb4d5fe));
      ui.textLH(cx + fs * 0.02f, plY, plH, fs, UiFont::CondBold, hex(0x121212), v.cfg.plate, UiAlign::Center, 0.04f);
      if (v.typing && !v.selAll && std::fmod(now, 1.0) < 0.55) ui.rect(cx + tw / 2 + 2 * u, plY + (plH - fs * 0.86f) / 2, std::max(d, 2 * u), fs * 0.86f, red);
    }
    {
      Ui::Shadow sh{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
      ui.brushStroke(colX + (hoverRnd ? 6 * u : 0), rndY, rndW, rndH, bluePale, 391, 220, 60, &sh);
      ui.textLH(colX + (hoverRnd ? 6 * u : 0) + 26 * u, rndY, rndH, 24 * u, NUM, blue, "RANDOM", UiAlign::Left, 0.06f);
      std::string note = plateTaken ? v.cfg.plate + " is already on one of your cars \xC2\xB7 type another" : v.cfg.custom ? "Your own text \xC2\xB7 " + plus(CAR_PLATE_COST) : "A random local plate \xC2\xB7 included";
      const UiFont nf = plateTaken ? UiFont::BodyBold : UiFont::BodySemi;
      float nx = colX + rndW + 16 * u, navail = colX + colW - nx;
      std::vector<std::string> nl = uiw::wrap(ui, note, tXs, nf, navail);
      float ny = rndY + (rndH - float(nl.size()) * tXs * 1.3f) / 2;
      for (const std::string& l : nl) {
        ui.textShadow(nx, ny + (tXs * 1.3f - ui.lineHeight(tXs, nf)) / 2, tXs, nf, l, UiAlign::Left, 0, 0, d, 6 * d, a(hex(0x000000), 0.6f));
        ui.textLH(nx, ny, tXs * 1.3f, tXs, nf, plateTaken ? hex(0xff9a8f) : white, l);
        ny += tXs * 1.3f;
      }
      float py = rndY + rndH + 14 * u + 8 * u;
      for (const std::string& l : uiw::wrap(ui, nav.usingPad ? "RANDOM gives another local plate. Your own text: on a keyboard." : "Type your own: 1 to 8 letters and digits. It goes on the front and the back.", tXs, UiFont::BodyMed, colW)) {
        ui.textShadow(colX, py + (tXs * 1.4f - ui.lineHeight(tXs, UiFont::BodyMed)) / 2, tXs, UiFont::BodyMed, l, UiAlign::Left, 0, 0, d, 6 * d, a(hex(0x000000), 0.6f));
        ui.textLH(colX, py, tXs * 1.4f, tXs, UiFont::BodyMed, a(white, 0.85f), l);
        py += tXs * 1.4f;
      }
    }
  } else {
    // the summary: every choice and what it costs; the terms; MY CARS
    const CarPaint& p = carPaintOf(v.cfg.paint);
    const float cy0 = listY + 2 * u - v.scroll, lx = sumX + 24 * u, rx = sumX + sumW - 24 * u;
    ui.brushClip(sumX, cy0, sumW, sumH, a(white, 0.94f), 733, 4, 3, u);
    auto line = [&](float y, const std::string& small, const std::string& name, const std::string& price, const CarPaint* sw, bool hover, bool mine, float rightPad) {
      const vec4 ink = hover ? red : blue;
      float tx = lx;
      if (sw) { if (y >= listY && y + sumRowH <= listY + listH) paintSwatch(ui, lx + 13 * u, y + sumRowH / 2, 26 * u, *sw, u); tx += 26 * u + 12 * u; }
      float pw = price.empty() ? 0 : ui.textLH(rx - rightPad, y, sumRowH - 1.5f * u, 20 * u, NUM, ink, price, UiAlign::Right, 0);
      float avail = rx - rightPad - pw - 12 * u - tx;
      ui.textLH(tx, y + 5 * u, 11 * u, 11 * u, UiFont::BodyHeavy, mine ? red : blueDim, uiw::ellipsis(ui, small, 11 * u, UiFont::BodyHeavy, avail, 0.16f), UiAlign::Left, 0.16f);
      ui.textLH(tx, y + 5 * u + 13 * u, 22 * u * 1.05f, 22 * u, NUM, ink, uiw::ellipsis(ui, uiw::upper(name), 22 * u, NUM, avail), UiAlign::Left);
      if (y + sumRowH > listY + 2 * u && y + sumRowH < listY + listH) ui.dashPath({vec2(lx, y + sumRowH - 0.75f * u), vec2(rx, y + sumRowH - 0.75f * u)}, std::max(d, 1.5f * u), hex(0x1546c8, 0.18f), 5 * u, 4 * u);
    };
    float y = cy0 + 14 * u;
    line(y, "CAR", v.carLabel, money(v.carPrice), nullptr, false, false, 0); y += sumRowH + 6 * u;
    line(y, "PAINT", std::string(p.label) + " \xC2\xB7 " + carFinishLabel(p.finish), plus(carFinishCost(p.finish)), &p, hoverSum == 0, false, 0); y += sumRowH + 6 * u;
    line(y, "WHEELS", carRimOf(v.cfg.rims).label, plus(carRimOf(v.cfg.rims).cost), nullptr, hoverSum == 1, false, 0); y += sumRowH + 6 * u;
    line(y, "PLATE", v.cfg.plate, v.cfg.custom ? plus(CAR_PLATE_COST) : "Included", nullptr, hoverSum == 2, false, 0); y += sumRowH + 6 * u;
    y += 6 * u;
    {
      float tw = ui.textLH(rx, y, 40 * u, 40 * u, NUM, red, money(total), UiAlign::Right, 0.08f);
      (void)tw;
      ui.textLH(lx, y + 40 * u - 24 * u, 20 * u, 20 * u, NUM, blue, "TOTAL", UiAlign::Left, 0.08f);
      y += 40 * u + 6 * u + 4 * u;
    }
    for (size_t i = 0; i < terms.size(); i++) {
      if (std::find(termStart.begin(), termStart.end(), int(i)) != termStart.end()) ui.circle(lx + 7 * u, y + tXs * 0.725f, std::max(d, 2 * u), blueDim);
      ui.textLH(lx + 18 * u, y, tXs * 1.45f, tXs, UiFont::BodyMed, blueDim, terms[i]);
      y += tXs * 1.45f;
    }
    if (!v.garage.empty()) {
      float gy = listY + garY - v.scroll;
      ui.brushClip(sumX, gy, sumW, garH, a(white, 0.94f), 741, 4, 3, u);
      float hx = lx + ui.textLH(lx, gy + 14 * u, tXs, tXs, UiFont::BodyHeavy, blueDim, "MY CARS \xC2\xB7 ", UiAlign::Left, 0.18f);
      ui.textLH(hx, gy + 14 * u, tXs, tXs, UiFont::BodyHeavy, red, std::to_string(v.garage.size()) + " / " + std::to_string(v.garageMax), UiAlign::Left, 0.18f);
      for (int i = 0; i < int(v.garage.size()); i++) {
        const auto& g = v.garage[size_t(i)];
        const CarPaint& gp = carPaintOf(g.paint);
        float ry = gy + 14 * u + tXs + 6 * u + float(i) * (sumRowH + 6 * u);
        float sx, sy, sw, sh; std::string lb;
        sellRect(i, sx, sy, sw, sh, lb);
        const std::string what = g.out ? "IN YOUR BAY" : "TAKE OUT";
        float ww = ui.textWidth(what, 15 * u, NUM, 0.08f);
        line(ry, g.plate + " \xC2\xB7 " + gp.label + " \xC2\xB7 RESALE " + money(g.value), g.label, "", &gp, hoverCar == i, g.id == v.cfg.id, sw + 12 * u + ww);
        ui.textLH(sx - 12 * u, ry, sumRowH - 1.5f * u, 15 * u, NUM, hoverCar == i ? red : blue, what, UiAlign::Right, 0.08f);
        bool armed = v.sellArm == g.plate, hs = hoverSell == i;
        if (armed) ui.roundRect(sx, sy, sw, sh, 3 * u, red);
        else ui.roundRectStroke(sx, sy, sw, sh, 3 * u, std::max(d, 1.5f * u), hs ? red : hex(0x1546c8, 0.35f));
        ui.textLH(sx + sw / 2 + 14 * u * 0.04f, sy, sh, 14 * u, NUM, armed ? white : hs ? red : blue, lb, UiAlign::Center, 0.08f);
      }
    }
    // (the web's mask: the list's last 34u fade out)
    (void)fadeAt;
  }
  ui.popClip();
  // the card: the step, its title, the bill and your money, BACK + NEXT / BUY
  {
    Ui::Shadow sh{0, 10 * u, 24 * u, hex(0x000e2c, 0.35f)};
    ui.brushClip(colX, detY, colW, detH, white, 517, 5, 4, u, &sh);
    const float sw2 = easeOut((now - v.swapAt) / 0.3), tx = colX + 28 * u, right = colX + colW - 28 * u;
    float ty = detY + 16 * u;
    ui.pushAlpha(0.35f + 0.65f * sw2);
    std::string kick = uiw::upper(v.carLabel) + (v.owned ? " \xC2\xB7 YOU HAVE " + std::to_string(v.owned) : "") + " \xC2\xB7 STEP " + std::to_string(v.step + 1) + " OF 4 \xC2\xB7 " + STEP_ONE[v.step];
    {
      // (one line: a long one is set a little smaller before it is cut)
      float kw = ui.textWidth(kick, tXs, UiFont::BodyHeavy, 0.18f), kfs = tXs * std::clamp((right - tx) / std::max(1.f, kw), 0.78f, 1.f);
      ui.textLH(tx, ty, tXs, kfs, UiFont::BodyHeavy, red, uiw::ellipsis(ui, kick, kfs, UiFont::BodyHeavy, right - tx, 0.18f), UiAlign::Left, 0.18f);
    }
    ty += tXs + 7 * u;
    std::string title = v.step == 0 ? carPaintOf(v.cfg.paint).label : v.step == 1 ? carRimOf(v.cfg.rims).label : v.step == 2 ? v.cfg.plate : v.carLabel;
    ui.textLH(tx, ty, 36 * u * 0.95f, 36 * u, NUM, blue, uiw::ellipsis(ui, uiw::upper(title), 36 * u, NUM, right - tx, 0.01f), UiAlign::Left, 0.01f);
    ty += 36 * u * 0.95f + 10 * u;
    ui.popAlpha();
    // .cr-bill: the car and its extras over the total (red), YOUR MONEY right
    std::string m = money(v.money);
    float mw = std::max(ui.textWidth(m, 30 * u, NUM), ui.textWidth("YOUR MONEY", tXs, UiFont::BodyHeavy, 0.16f));
    ui.textLH(right + tXs * 0.16f, ty, tXs * 1.2f, tXs, UiFont::BodyHeavy, blueDim, "YOUR MONEY", UiAlign::Right, 0.16f);
    ui.textLH(right, ty + tXs * 1.2f + 5 * u, 30 * u, 30 * u, NUM, blue, m, UiAlign::Right);
    std::string bill = v.carLabel + " " + money(v.carPrice) + (extras ? " \xC2\xB7 extras " + money(extras) : "");
    ui.textLH(tx, ty, tXs * 1.2f, tXs, UiFont::BodyBold, blueDim, uiw::ellipsis(ui, bill, tXs, UiFont::BodyBold, right - mw - 16 * u - tx, 0.06f), UiAlign::Left, 0.06f);
    ui.textLH(tx, ty + tXs * 1.2f + 5 * u, 30 * u, 30 * u, NUM, red, money(total));
    // BACK
    Ui::Shadow bs{0, 6 * u, 14 * u, a(hex(0x000000), 0.25f)};
    if (v.step) {
      float bx = actX + (hoverBack ? 6 * u : 0);
      ui.brushStroke(bx, actY, backW, btnH, bluePale, 379, 120, 74, &bs);
      ui.textLH(bx + 40 * u, actY, btnH, 34 * u, NUM, blue, "BACK", UiAlign::Left, 0.06f);
    }
    // the main stroke: blue (red on the last step) when a press does something, pale otherwise; the label fits it
    float bx = mainX + (hoverMain && ready ? 6 * u : 0);
    if (now - v.nopeAt < 0.38) bx += 6 * u * std::sin(float((now - v.nopeAt) / 0.38) * 4 * 3.14159265f);
    ui.brushStroke(bx, actY, mainW, btnH, ready ? (last ? hex(0xc8261c) : blue) : bluePale, 377, 300, 74, &bs);
    const vec4 ink = ready ? white : blueDim;
    const float padL = 40 * u, textMax = mainW - padL - 46 * u;
    if (last) {
      float fs = 34 * u, tw = ui.textWidth(v.actLabel, fs, NUM, 0.06f);
      if (tw > textMax) fs *= textMax / tw;
      ui.textLH(bx + padL, actY, btnH, fs, NUM, ink, v.actLabel, UiAlign::Left, 0.06f);
    } else {
      // NEXT with the step it leads to small underneath
      float bh = 34 * u + 3 * u + 13 * u, by = actY + (btnH - bh) / 2;
      ui.textLH(bx + padL, by, 34 * u, 34 * u, NUM, ink, "NEXT", UiAlign::Left, 0.06f);
      ui.textLH(bx + padL, by + 34 * u + 3 * u, 13 * u, 13 * u, UiFont::BodyHeavy, a(ink, 0.8f), STEP_LABEL[v.step + 1], UiAlign::Left, 0.18f);
    }
  }
  ui.popTransform();
  ui.popAlpha();
  // the hints (.os-foot)
  {
    std::vector<uiw::Hint> hs;
    if (nav.usingPad) { hs.push_back({{prompts::K(in, "leftright")}, "STEP"}); hs.push_back({{prompts::K(in, "updown")}, "CHOOSE"}); }
    else { hs.push_back({{"\xE2\x86\x90", "\xE2\x86\x92"}, "STEP"}); hs.push_back({{"\xE2\x86\x91", "\xE2\x86\x93"}, "CHOOSE"}); }
    hs.push_back({{prompts::K(in, "confirm")}, "NEXT \xC2\xB7 BUY"});
    hs.push_back({{prompts::K(in, "cancel")}, "CLOSE"});
    if (!nav.usingPad && v.drag) hs.push_back({{}, "DRAG TO TURN"});
    uiw::hints(ui, colX, H - 24 * u - ui.kcHeight(u), u, hs, a(white, 0.88f), a(white, 0.88f), W - 20 * u);
  }
  ui.popAlpha();
  return true;
}

} // namespace sl
