// The shared context of the Phase 5 gameplay systems (races, jobs and the taxi, the police / prison / impound, the
// rescue and the hospital, the chalets and build mode, the people, the weather): references to the game's parts and
// the services game.cpp gives them (money, flashes, teleports, the waypoint). Each system is a class with
// interact() (the prompt where you stand; E acts), update(), the people / 3D it adds and its own HUD.
#pragma once
#include "core/input.h"
#include "core/math.h"
#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace sl {
namespace platform { class Platform; }
namespace gfx { class Device; }
class World; class Scenery; class Transport; class Player; class Drive; class Traffic; class Save; class Menus; class Hud;
class People; class PeopleSim; class Shapes; class Lifts; class Weather; class AssetManager; class Ui;
struct PlayData;

struct PlayCtx {
  platform::Platform* plat = nullptr;
  World* world = nullptr;
  Scenery* scenery = nullptr;
  Transport* transport = nullptr;
  Player* player = nullptr;
  Drive* drive = nullptr;
  Traffic* traffic = nullptr;
  Save* save = nullptr;
  Menus* menus = nullptr;
  Input* input = nullptr;
  Hud* hud = nullptr;
  People* people = nullptr;
  PeopleSim* folk = nullptr;
  Shapes* shapes = nullptr;
  Lifts* lifts = nullptr;
  Weather* weather = nullptr;
  AssetManager* assets = nullptr;
  gfx::Device* dev = nullptr;
  const PlayData* data = nullptr;
  std::vector<std::pair<std::string, std::vector<dvec2>>> pistes;   // layout.pistes: name, polyline
  double now = 0;               // simulation time (s)
  bool autotest = false;
  bool driving = false;         // in your car (game.cpp rideKind == Car)
  bool riding = false;          // a lift, bus or train
  // services
  std::function<void(const std::string& text, int kind)> flash;     // 0 good, 1 bad, 2 gold
  std::function<bool(int64_t amount)> spend;                        // refused when short ("Not enough money")
  std::function<void(int64_t amount)> earn;
  std::function<void(int64_t amount)> charge;                       // a bill (even into the red)
  std::function<std::string(int64_t v)> money;                      // "$1,250"
  std::function<void(double x, double z, double heading, bool skis)> teleport;
  std::function<void(double x, double z, const std::string& label)> mark;   // the HUD's waypoint (trail map mark)
  std::function<void()> unmark;
  std::function<void()> fade;                                       // a short fade to dark (covers a teleport)
  std::string K(Action a) const;
};

/// "$1,234"
std::string fmtMoney(int64_t v);
/// "1:23.45"
std::string fmtRaceTime(double t);
/// "1st", "2nd"...
std::string ordinal(int n);

} // namespace sl
