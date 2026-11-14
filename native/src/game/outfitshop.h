// The outfit shop (src/ui/outfitshop.js): the OUTFITS corner of the walk-in ski shop. Jackets, trousers, helmets,
// goggle lenses and full kits for your skier; the shop's camera swings round to your skier on the podium, so every
// row you pick is tried on the real model; buy once, wear it on the man and the woman (each keeps its own look).
// The screen itself is the shop UI (shopui: frameShop); here its catalogue (rows, the kits' pieces once a kit is
// yours), what is worn / owned, buying and wearing (the save in the web game's shape), the try-on.
#pragma once
#include "game/play.h"
#include "game/shopui.h"
#include <array>
#include <functional>
#include <string>

namespace sl {
class ShopRoom;

class OutfitShop {
public:
  OutfitShop(PlayCtx& c, Ui& ui, ShopRoom& room);
  void open();
  void close();
  bool isOpen() const { return open_; }
  /// what the podium skier wears while the shop is open: the equipped set with the selected row tried on (item ids for
  /// jacket, trousers, helmet, lens; "" the original). false when closed: as equipped
  bool preview(std::array<std::string, 4>& ids) const;
  /// (multiplayer) the server sells it: buy(id, price, done(ok)) -> true (it adds the id to the save's owned list
  /// itself); false: not online, bought here
  std::function<bool(const std::string& id, int price, std::function<void(bool)> done)> buyHook;
  std::function<void()> onEquip;                 // the equipped outfit changed
  std::function<std::string()> zones;            // the skier model's garment zones ("jacket jacketAccent ... lens")
  /// the id a slot wears (outfits.js getEquipped: only what you own), "" the original
  std::string equipped(const std::string& slot) const;
  /// (tests) the selected row's name; choose a tab / a row by its name
  const ShopView& view() const { return view_; }
  bool focus(int tab, const std::string& name);

private:
  struct Row { std::string id, slot; };          // id "" = the original piece
  void rows(ShopView& v);
  void act(int row);
  void wear(const Row& r);
  bool worn(const Row& r) const;
  bool owned(const Row& r) const;
  PlayCtx& c_;
  Ui& ui_;
  ShopRoom& room_;
  ShopView view_;
  std::vector<Row> rows_;
  bool open_ = false, buying_ = false;
};

} // namespace sl
