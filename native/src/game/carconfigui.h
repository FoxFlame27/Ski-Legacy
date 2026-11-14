// The AUTOHAUS configurator (src/ui/carrental.js + carrental.css, the data of src/game/carconfig.js): the outfit
// designer's layout (shopui.*) with the car's own bits: the four numbered steps PAINT / WHEELS / PLATE / SUMMARY, the
// paint swatches by finish, the rim swatches, the number plate you type on (RANDOM gives a local one), the summary
// with the bill, the terms and MY CARS (take one out, SELL: click twice), and the card: the step's title, the bill,
// YOUR MONEY, BACK and NEXT / BUY $N / NOT ENOUGH MONEY / GARAGE FULL / PLATE TAKEN.
// Only the UI layer: what a purchase does is the caller's (buy / takeOut / sell); preview(cfg, step) and drag(dx, dy)
// are the hooks for a showroom's live car (the walk-in Autohaus), optional.
#pragma once
#include "engine/ui.h"
#include "game/menus.h"
#include <functional>
#include <string>
#include <vector>

namespace sl {

struct CarPaint { const char* id; const char* label; uint32_t hex; int finish; };   // finish: 0 solid, 1 metallic, 2 pearl, 3 matte
struct CarRim { const char* id; const char* label; uint32_t hex; int cost; };
const std::vector<CarPaint>& carPaints();
const std::vector<CarRim>& carRims();
const CarPaint& carPaintOf(const std::string& id);
const CarRim& carRimOf(const std::string& id);
const char* carFinishLabel(int finish);
int carFinishCost(int finish);
constexpr int CAR_PLATE_COST = 1000;

struct CarCfg {
  std::string id, paint = "white", rims = "orig", plate;
  bool custom = false;   // your own text on the plate
};
/// what a config costs over the car's list price (finish, rims, a custom plate)
int carExtras(const CarCfg& c);
/// "VS 123456": two canton letters and up to six digits
std::string randomCarPlate(uint32_t seed);
/// what you may type on a plate: 1 to 8 letters / digits (spaces and hyphens between)
std::string cleanCarPlate(const std::string& s);

struct CarCfgView {
  // ---- what it shows (the caller fills these; refresh() keeps money / garage current each frame)
  std::string carLabel;
  int carPrice = 0;
  CarCfg cfg;
  int step = 0;                    // 0 paint, 1 wheels, 2 plate, 3 summary
  long long money = 0;
  int owned = 0, garageMax = 10;   // your cars of this model; the garage's size
  int wreckFee = 2000, towFee = 1500, repairFull = 500;
  std::string interactKey = "E";
  struct Mine { std::string id, plate, label, paint; int value = 0; bool out = false; };
  std::vector<Mine> garage;
  std::function<void(CarCfgView&)> refresh;
  std::function<void(const CarCfg&, int total)> buy;      // (the screen has closed)
  std::function<void(const std::string& plate)> takeOut, sell;
  std::function<void(const CarCfg&, int step)> preview;   // every change: the showroom's car follows
  std::function<void(float dx, float dy)> drag;           // dragging right of the column: turn the car
  std::function<void(const std::string&)> flashBad;
  std::function<void(const char* sound)> sound;
  std::function<void()> closed;
  // ---- state
  bool typing = false, selAll = false;   // the plate field has the keys (game.cpp: text input on meanwhile)
  std::string sellArm;
  float scroll = 0, scrollTarget = 0;
  double openedAt = -1, nopeAt = -10, swapAt = -10, lastClickAt = -10;
  int lastClickRow = -1, frames = 0, shownStep = -1;
  bool reveal = true, dragging = false;
  vec2 lastMouse{0};
  std::string actLabel;            // (autotest) the main button's words
};
/// one frame: input, then drawing; false once it closed
bool frameCarConfig(Ui& ui, const UiNav& nav, const Input& in, CarCfgView& v, double dt, double now);

} // namespace sl
