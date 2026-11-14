// The chalet build mode's catalogue (src/ui/buildmenu.js + buildmenu.css): a column on the right in the menus' brush
// style: the FURNISH stroke, "Your chalet" and your money, the rooms as brush tabs, the catalogue as brush-paper cards
// two abreast under each room's heading (the one in hand painted blue with the red marker, a price you cannot pay in
// red, a shake and a red flash when a purchase is refused), the status strip (what is in hand / why it does not fit),
// and along the bottom the mode chip (CURSOR / LOOK AROUND / AIM / MOUSE) with the key hints.
#pragma once
#include "core/input.h"
#include "engine/ui.h"
#include <string>
#include <utility>
#include <vector>

namespace sl {
namespace gfx { class Device; }
namespace platform { class Platform; }

/// The catalogue's thumbnails: the web game's own renders of every model (furniture.js renderThumbs: 160 x 120, its
/// lights, camera and tone mapping), packed by native/tools/browser/render_thumbs.mjs into public/ui/
/// furniture_thumbs.webp (+ .json: the ids in atlas order).
struct BuildThumbs { gfx::Texture tex{}; int cols = 8, w = 160, h = 120, texW = 0, texH = 0; std::vector<std::string> ids; };
/// loaded once (null when the atlas is missing: the plates stay empty, as the web game's while its renders are pending)
const BuildThumbs* buildThumbs(gfx::Device* dev = nullptr, platform::Platform* plat = nullptr);

struct BuildMenuState {
  const BuildThumbs* thumbs = nullptr;
  long long money = 0;
  std::vector<std::pair<std::string, std::string>> categories;   // id, name
  struct Item { std::string id, name, category; int price = 0; };
  std::vector<Item> items;
  std::string hand;                 // the id in hand ("" none)
  std::string status;
  bool statusBad = false;
  float scroll = 0;                 // px (the list)
  std::string denyId;               // the card that shakes (a refused purchase); "" just the red flash
  double denyAge = 10;              // s since the refusal
  bool pad = false, vmouse = false, look = true;
  vec2 pointer{-1};                 // the mouse / the virtual mouse (drawable px; -1: none)
  double shownFor = 10;
};
struct BuildMenuLayout {
  bool over = false;                // the pointer is on the column
  int card = -1, tab = -1;          // what it is on (item index / category index)
  float maxScroll = 0, viewH = 0;
  std::vector<float> catTop;        // each room's heading in the list (px from its top)
  std::vector<std::pair<float, float>> itemSpan;   // each item's top and bottom in the list
  std::vector<vec2> cardCentre;     // each item's card on the screen (drawable px; x < 0: scrolled out)
};
BuildMenuLayout drawBuildMenu(Ui& ui, const BuildMenuState& s, const Input& in);

} // namespace sl
