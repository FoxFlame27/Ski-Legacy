#include "game/outfitshop.h"
#include "game/economy.h"
#include "game/menus.h"
#include "game/shoproom.h"
#include <algorithm>

namespace sl {

namespace {
const char* const SLOTS[4] = {"jacket", "trousers", "helmet", "lens"};
const char* const SLOT_NAMES[4] = {"Jacket", "Trousers", "Helmet", "Lens"};
const char* const TAB_SLOT[5] = {"jacket", "trousers", "helmet", "lens", "kit"};
int slotIndex(const std::string& s) { for (int i = 0; i < 4; i++) if (s == SLOTS[i]) return i; return -1; }
bool has(const std::string& zones, const char* z) {
  size_t p = 0;
  const std::string w = z;
  while ((p = zones.find(w, p)) != std::string::npos) {
    const bool a = p == 0 || zones[p - 1] == ' ', b = p + w.size() == zones.size() || zones[p + w.size()] == ' ';
    if (a && b) return true;
    p += w.size();
  }
  return false;
}
}

OutfitShop::OutfitShop(PlayCtx& c, Ui& ui, ShopRoom& room) : c_(c), ui_(ui), room_(room) {}

// outfits.js getEquipped: the item ids a character wears (only what is owned; null = the skier's own piece)
std::string OutfitShop::equipped(const std::string& slot) const {
  const Save& s = *c_.save;
  if (!s.outfits.equipped.is_object() || !s.outfits.equipped.contains(s.character)) return "";
  const auto& e = s.outfits.equipped[s.character];
  if (!e.is_object() || !e.contains(slot) || !e[slot].is_string()) return "";
  const std::string id = e[slot].get<std::string>();
  return s.ownsOutfit(id) ? id : std::string();
}

bool OutfitShop::owned(const Row& r) const { return r.id.empty() || c_.save->ownsOutfit(r.slot == "kit" ? r.id + ".jacket" : r.id); }

bool OutfitShop::worn(const Row& r) const {
  if (r.slot == "kit") { for (const char* s : SLOTS) if (equipped(s) != r.id + "." + s) return false; return true; }
  return equipped(r.slot) == r.id;
}

// outfitshop.js rows(): the original piece first (not for kits), the pieces of the kits you own, then the catalogue
void OutfitShop::rows(ShopView& v) {
  rows_.clear();
  v.rows.clear();
  v.money = c_.save->money;
  const std::string slot = TAB_SLOT[std::clamp(v.tab, 0, 4)];
  const std::string zs = zones ? zones() : std::string();
  auto push = [&](const Row& r, ShopRow q) {
    q.id = r.id;
    q.owned = owned(r); q.worn = worn(r);
    rows_.push_back(r);
    v.rows.push_back(std::move(q));
  };
  if (slot == "kit") {
    for (size_t i = 0; i < kOutfitKitCount; i++) {
      const OutfitKit& k = kOutfitKits[i];
      ShopRow q;
      q.name = k.name; q.sub = k.desc; q.price = k.price;
      q.swatch = 5; q.stripes = {k.jBase, k.jAccent, k.tBase, k.helmet, k.lens};
      q.notes.push_back("Jacket, trousers, helmet and lens. Each piece can be worn on its own once bought");
      push({k.id, "kit"}, std::move(q));
    }
    return;
  }
  const int si = slotIndex(slot);
  auto note = [&](ShopRow& q, bool accent) {
    if (zs.empty() || zs == "none") return;
    if (slot == "lens" && !has(zs, "lens")) q.notes.push_back("Your skier wears no goggles, so the lens does not show");
    else if (slot == "jacket" && accent && !has(zs, "jacketAccent")) q.notes.push_back("This jacket has no second colour panel, so it takes the main colour only");
  };
  { ShopRow q; q.name = "Original"; q.sub = "The original piece, free"; q.swatch = 0; push({"", slot}, std::move(q)); }
  for (size_t i = 0; i < kOutfitKitCount; i++) {
    const OutfitKit& k = kOutfitKits[i];
    if (!c_.save->ownsOutfit(std::string(k.id) + ".jacket")) continue;
    ShopRow q;
    q.name = std::string(k.name) + " " + SLOT_NAMES[si]; q.sub = std::string("From the ") + k.name + " kit"; q.price = k.price;
    if (si == 0) { q.swatch = 1; q.a = k.jBase; q.b = k.jAccent; }
    else if (si == 1) { q.swatch = 1; q.a = k.tBase; q.b = k.tAccent; }
    else if (si == 2) { q.swatch = 2; q.a = k.helmet; }
    else { q.swatch = 3; q.a = k.lens; }
    note(q, si == 0 && k.jAccent != k.jBase);
    push({std::string(k.id) + "." + slot, slot}, std::move(q));
  }
  for (size_t i = 0; i < kOutfitCount; i++) {
    const OutfitDef& it = kOutfits[i];
    if (slot != it.slot) continue;
    ShopRow q;
    q.name = it.name; q.sub = it.note; q.price = it.price;
    q.swatch = si == 2 ? 2 : si == 3 ? 3 : 1; q.a = it.base; q.b = it.accent;
    note(q, it.accent != it.base);
    push({it.id, slot}, std::move(q));
  }
}

void OutfitShop::wear(const Row& r) {
  Save& s = *c_.save;
  if (!s.outfits.equipped.is_object()) s.outfits.equipped = nlohmann::json::object();
  nlohmann::json& e = s.outfits.equipped[s.character];
  if (!e.is_object()) e = {{"jacket", nullptr}, {"trousers", nullptr}, {"helmet", nullptr}, {"lens", nullptr}};
  if (r.slot == "kit") for (const char* sl : SLOTS) e[sl] = r.id + "." + sl;
  else if (r.id.empty()) e[r.slot] = nullptr;
  else e[r.slot] = r.id;
  if (c_.plat) s.write(*c_.plat);
  if (onEquip) onEquip();
  rows(view_);
}

// outfitshop.js act(): wearing it: nothing; not yours: bought (the server's sale in multiplayer), then worn
void OutfitShop::act(int row) {
  if (row < 0 || size_t(row) >= rows_.size()) return;
  const Row r = rows_[size_t(row)];
  const ShopRow q = view_.rows[size_t(row)];
  if (worn(r)) return;
  if (!owned(r)) {
    if (buying_) return;
    if (c_.online && buyHook) {
      if (c_.save->money < q.price) { c_.flash("Not enough money (" + c_.money(q.price) + " needed)", 1); return; }
      buying_ = true;
      const bool sent = buyHook(r.id, q.price, [this, r, q](bool ok) {
        buying_ = false;
        if (!ok || !open_) return;
        c_.flash(q.name + " bought", 2);
        wear(r);
      });
      if (sent) return;
      buying_ = false;
    }
    if (!c_.spend(q.price)) return;   // (spend() shows "Not enough money")
    c_.save->outfits.owned.push_back(r.id);
    c_.flash(q.name + " bought", 2);
  }
  wear(r);
}

void OutfitShop::open() {
  if (open_ || !c_.menus) return;
  open_ = true;
  view_ = ShopView();
  view_.tabs = {{"JACKETS", "JACKET"}, {"TROUSERS", "TROUSERS"}, {"HELMETS", "HELMET"}, {"GOGGLES", "GOGGLE LENS"}, {"KITS", "FULL KIT"}};
  view_.rebuild = [this](ShopView& v) { rows(v); };
  view_.act = [this](ShopView&, int row) { act(row); };
  view_.drag = [this](float dx) { room_.spin(double(dx) * 0.012); };
  view_.dragHint = "DRAG TO TURN";
  view_.fitTabs = false;
  // (start on the row of what you wear)
  rows(view_);
  for (size_t i = 0; i < view_.rows.size(); i++) if (view_.rows[i].worn) { view_.focus = int(i); break; }
  room_.outfitView(true);
  c_.menus->openCustom([this](const UiNav& nv, double dt, double now) {
    if (!frameShop(ui_, nv, *c_.input, view_, dt, now)) { close(); return; }
    if (!view_.rows.empty()) c_.menus->customFocus = view_.rows[size_t(view_.focus)].name;
  }, "shop");
}

void OutfitShop::close() {
  if (!open_) return;
  open_ = false;
  if (c_.menus && c_.menus->customOpen("shop")) c_.menus->close();
  room_.outfitView(false);
}

bool OutfitShop::preview(std::array<std::string, 4>& ids) const {
  if (!open_) return false;
  for (int i = 0; i < 4; i++) ids[size_t(i)] = equipped(SLOTS[i]);
  if (view_.focus >= 0 && size_t(view_.focus) < rows_.size()) {
    const Row& r = rows_[size_t(view_.focus)];
    if (r.slot == "kit") for (int i = 0; i < 4; i++) ids[size_t(i)] = r.id + "." + SLOTS[i];
    else if (int si = slotIndex(r.slot); si >= 0) ids[size_t(si)] = r.id;
  }
  return true;
}

bool OutfitShop::focus(int tab, const std::string& name) {
  view_.tab = std::clamp(tab, 0, 4);
  rows(view_);
  for (size_t i = 0; i < view_.rows.size(); i++) if (view_.rows[i].name == name) { view_.focus = int(i); view_.reveal = true; return true; }
  return false;
}

} // namespace sl
