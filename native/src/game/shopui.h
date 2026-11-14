// The walk-in shop's catalogue screen (src/ui/outfitshop.js + outfitshop.css): the menus' brush paper over the dimmed
// left of the view: the title stroke and its line, the categories as brush tabs, the catalogue as paper strips (a
// swatch, the name, a note, the price or OWNED / WEARING; the selected one painted blue with the red marker), the
// selected item's card (kicker, name, notes, the BUY $N / WEAR / WEARING stroke and YOUR MONEY) and the key hints.
// Left / right switch the category, up / down choose, Enter / Space / E buy or wear, Esc closes; the mouse clicks a
// tab, a row (twice: buy / wear) or the stroke, the wheel / right stick scroll.
#pragma once
#include "engine/ui.h"
#include "game/menus.h"
#include <functional>
#include <string>
#include <vector>

namespace sl {

struct ShopRow {
  std::string id, name, sub;
  int price = 0;
  bool owned = false, worn = false;
  int swatch = 0;                   // 0 the original (a dashed tile), 1 two-tone, 2 helmet, 3 lens, 4 skis
  uint32_t a = 0, b = 0;
  std::vector<std::string> notes;   // lines on the detail card
  std::string wornLabel = "WEARING", useLabel = "WEAR", ownedLabel = "OWNED", buyLabel = "BUY";
};
struct ShopView {
  std::string title = "OUTFITS", sub = "Make your skier yours";
  int titleSeed = 4321;
  struct Tab { std::string label, one; };   // JACKETS / JACKET
  std::vector<Tab> tabs;
  int tab = 0, focus = 0;
  std::vector<ShopRow> rows;
  long long money = 0;
  std::function<void(ShopView&)> rebuild;   // fills rows (and money) for `tab`; called on open, a tab change, after act
  std::function<void(ShopView&, int row)> act;
  std::function<void()> closed;
  // state
  float scroll = 0, scrollTarget = 0;
  double openedAt = -1, popAt = -10, nopeAt = -10, swapAt = -10, lastClickAt = -10;
  int lastClickRow = -1;
  bool reveal = true;
  int frames = 0;                   // (the press that opened the shop is not its first choice: the menus quiet that frame)
};
/// one frame: input, then drawing; false once it closed
bool frameShop(Ui& ui, const UiNav& nav, const Input& in, ShopView& v, double dt, double now);

} // namespace sl
