// THE WERKSTATT · GARAGE (src/game/werkstatt.js): the repair garage beside the Autohaus. The building is the web
// game's own (exported by export_rooms.mjs: larch on a stone plinth, the open bay with the yellow repair box, the
// workshop half, the board on the gable, the apron). Repair as there: drive your car into the box and stop, or walk to
// the workbench with your car standing in the box: E pays (the flat fee, carrental.js repairCost), the car is held
// REPAIR_S seconds while the card's bar runs, then behind a fade the damage is gone. The card bottom left (the tow
// yard card's brush style): the damage and the price, "Drive into the yellow box", "Stop the car", the progress.
#pragma once
#include "engine/ui.h"
#include "game/play.h"
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sl {
class Renderer;
struct Collider;

class Werkstatt {
public:
  explicit Werkstatt(PlayCtx& c) : c_(c) {}
  bool available() const;
  /// main.js findInteraction (also while you drive): E to repair your car in the box. true: the prompt is this one's
  bool interact(std::string& prompt, bool pressed);
  void update(double dt);
  void draw(Renderer& r, const dvec3& cam);
  void fillColliders(std::vector<Collider>& out) const;
  void hud(Ui& ui, float u);
  /// a repair under way: the car is held (drive.js servicing)
  bool servicing() const { return job_.on; }
  /// pays for the repair of the car with `plate` (the server's price in multiplayer): done(ok, fee)
  std::function<void(const std::string& plate, int fee, std::function<void(bool ok, int fee)> done)> pay;
  /// the repair itself: the car's damage gone (the save's entry too)
  std::function<void(const std::string& plate)> repaired;
  /// (tests) the frame: garage (lx, lz) -> world
  dvec3 world(double lx, double lz) const;

private:
  struct Car { int idx = -1; bool driving = false; double damage = 0, speed = 0; };
  Car carInBay() const;
  bool inBox(double x, double z) const;
  bool inside(double x, double z, double pad) const;
  int fee(double damage) const;
  PlayCtx& c_;
  std::shared_ptr<Model> model_;
  struct Job { bool on = false; double t = 0; int fee = 0; std::string plate, label; bool fading = false; } job_;
  bool paying_ = false;
};

} // namespace sl
