// The shared context of the Phase 5 gameplay systems (races, jobs and the taxi, the police / prison / impound, the
// rescue and the hospital, the chalets and build mode, the people, the weather): references to the game's parts and
// the services game.cpp gives them (money, flashes, teleports, the waypoint). Each system is a class with
// interact() (the prompt where you stand; E acts), update(), the people / 3D it adds and its own HUD.
#pragma once
#include "core/input.h"
#include "core/math.h"
#include <nlohmann/json.hpp>
#include <functional>
#include <string>
#include <utility>
#include <vector>

#include "engine/model.h"
namespace sl {
namespace platform { class Platform; }
namespace gfx { class Device; }
class World; class Scenery; class Transport; class Player; class Drive; class Traffic; class Save; class Menus; class Hud;
class People; class PeopleSim; class PlayerSkier; class Shapes; class Lifts; class Weather; class AssetManager; class Ui;
struct PlayData;

struct PlayCtx {
  platform::Platform* plat = nullptr;
  World* world = nullptr;
  class SnowTrails* trails = nullptr;   // the snow's marks and spray (a race's AI racers leave theirs: snowfx.js skierFX)
  Scenery* scenery = nullptr;
  Transport* transport = nullptr;
  Player* player = nullptr;
  PlayerSkier* skier = nullptr;   // your rig (a race's podium / replay poses it: presentation/cinecam.js)
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
  float night = 0;              // village.js nightUniform: 0 by day .. 1 at night (lamps)
  double hour = 10;             // the game's clock (sky.js env.hour, 0 .. 24)
  float snowing = 0;            // how hard it snows, 0..1 (the helicopter's landing light beam shows in it)
  // services
  std::function<void(const std::string& text, int kind)> flash;     // 0 good, 1 bad, 2 gold
  std::function<bool(int64_t amount)> spend;                        // refused when short ("Not enough money")
  std::function<void(int64_t amount)> earn;
  std::function<void(int64_t amount)> charge;                       // a bill (even into the red)
  std::function<std::string(int64_t v)> money;                      // "$1,250"
  std::function<void(double x, double z, double heading, bool skis)> teleport;
  std::function<void(double x, double z, const std::string& label)> mark;   // the HUD's waypoint (trail map mark)
  std::function<void()> unmark;
  std::function<std::shared_ptr<Model>(const std::string& id)> roomModel;   // a walk-in room's exported model (Resort::roomModel)
  std::function<void()> fade;                                       // a short fade to dark (covers a teleport)
  /// presentation.slowMo({ scale, easeIn, hold, easeOut, reason }) / presentation.cancel() (game/presentation.h)
  std::function<bool(double scale, double easeIn, double hold, double easeOut, const char* reason)> slowMo;
  std::function<void()> slowCancel;
  std::function<bool()> covered;                                    // a transition still covers the screen (the race intro waits for the reveal)
  std::function<void(const std::string& label)> titleCard;         // the branded title card over a move ("RACE \xC2\xB7 Ice Canyon")
  // (Phase 6) multiplayer: the server is authoritative (net/session.js); unset in single player
  bool online = false;                                              // multiplayer: the server is authoritative
  int mpPid = 0;                                                    // your player id in the world (multiplayer)
  std::function<void(int64_t amount, const std::string& source)> earnFrom;   // payouts by source ('job', 'sell')
  std::function<void(const std::string& race)> raceSolo;            // a practice race at the server
  std::function<void(double time, bool dnf)> raceFinished;          // your finish, at the line
  /// (session.js raceJoin / the queue) a race with the other players in the world: join its queue; its state
  std::function<void(const std::string& race)> raceJoin;
  std::function<void()> raceLeave;
  struct RaceQueue { int n = 0; double startIn = -1; bool mine = false; int max = 14; double wait = 30; };   // (server.js RACE_MAX, the join window)
  std::function<RaceQueue(const std::string& race)> raceQueue;
  /// the other racers of the race you are in: name, time (s; < 0 still racing), dnf; and your prize from the server's
  /// result (-1: not in yet)
  struct RaceRival { std::string name; double time = -1; bool dnf = false; };
  std::function<std::vector<RaceRival>()> raceRivals;
  std::function<int()> racePrize;
  std::function<std::string(int plot)> chaletOwner;                 // another player's chalet ("" none)
  std::function<void(int plot, const std::string& name, std::function<void(bool)> done)> buyChalet;
  std::function<void(int plot, const std::string& owner, std::function<void(bool, const nlohmann::json& furniture)> done)> visitChalet;
  std::function<void(double seconds, const std::string& reason, bool onFoot)> onJail;   // a sentence starts
  std::string K(Action a) const;
};

/// "$1,234"
std::string fmtMoney(int64_t v);
/// "1:23.45"
std::string fmtRaceTime(double t);
/// "1st", "2nd"...
std::string ordinal(int n);

} // namespace sl
