// Phase 6: the multiplayer session, a port of src/net/session.js (with the parts of remote.js, carride.js, transit.js
// and ui.js the native game needs): everything between MULTIPLAYER in the menu and LEAVE MULTIPLAYER.
//
//  - the account: your unique name and the secret token the server issued at registration, kept per server URL in the
//    platform's save area ("ski-legacy-mp-accounts.json", the JS game's localStorage 'ski-legacy-mp-accounts')
//  - start(): connect, log in ({ v, name, token, look, plots, tt }), join the world the server picks (the fullest one
//    with room, up to 50), swap the server profile into the save (the single-player save is set aside untouched and
//    comes back on leave(); the device settings stay), switch the AI systems off, the other players' avatars
//  - update(): presence out at 12 Hz (protocol.h rows), the remote players (RemotePlayers: buffered interpolation on the
//    server's clock), the world clock and weather, the money guard (any drop of save.money is a 'spend' the server
//    checks; a rise that did not come from the server is undone), the profile pushes (profileSet), your car's 'veh'
//    record and your other cars' 'parked' list, interiors ('enter'), permission prompts, the admin banner, chat
//  - the server-authoritative purchases and payouts: buy skis / outfit / car / chalet, sell / switch a car, repair,
//    the tow, earn (jobs), jail and the accomplice arrest, seats on shared transport, car rides
//  - reconnects: the server holds you for a minute; a login on the new socket resumes (same world, pid, seat...)
#pragma once
#include "core/math.h"
#include "net/client.h"
#include "net/protocol.h"
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace sl {
class Save;
namespace platform { class Platform; }
using Json = nlohmann::json;

/// your presence (main.js mpPose), filled by the game ~12 times a second
struct MpPose {
  double x = 0, y = 0, z = 0, yaw = 0, vx = 0, vy = 0, vz = 0, crouch = 0, lean = 0;
  int st = 0;
  uint32_t flags = 0;
  std::string interior;   // "" outdoors; skishop, carrental, prison, hospital, chalet:<id>
  bool hold = false;      // a door fading: nothing goes out this time
};

/// what the game gives the session (session.js constructor's `c`)
struct MpHost {
  Save* save = nullptr;
  platform::Platform* plat = nullptr;
  std::function<void(const std::string&, int kind)> flash;    // 0 good, 1 bad, 2 gold
  std::function<void(MpPose&)> pose;
  std::function<void(bool on)> setAI;                         // traffic, the decorative parked cars, the race field
  std::function<void()> applySave;                            // the save was swapped: skis, character, garage, jail...
  std::function<void(const std::string& why)> onLost;         // back at the menu
  std::function<void(const std::string& interior)> onKickInterior;
  std::function<void(double x, double z, double yaw, const std::string& to)> adminTp;
  std::function<void(const Json& d)> onArrested;              // the driver you rode with was caught: you go to jail too
  std::function<void(const Json& d)> onSeatLost;              // the server took your seat (the owner left / took it back)
  std::function<std::vector<int>()> plots;                    // the chalet plots' ids (the server learns them from us)
  std::function<std::string()> transitFingerprint;            // the timetables' version (transit.js fingerprint)
};

/// one other player, as received (presence ring) and as drawn (interpolated)
struct RemotePlayer {
  int pid = 0;
  std::string name;
  Json look;              // { c: character, o: outfit, s: skis }
  Json vehs = Json::object();   // their vehicles: car { k, cfg, at? }, sled { k, at? }, ...
  Json parked = Json::array();  // their other cars parked in the world [{ plate, cfg, at, tilt?, wreck? }]
  int chalet = -1;        // their chalet's plot (-1 none)
  struct Snap { double v[12]; std::string veh, interior; };   // ts, x, y, z, yaw, vx, vy, vz, st, crouch, lean, flags
  static constexpr int RING = 16;
  Snap ring[RING];
  int count = 0, head = -1;
  double lastTs = 0, lag = -1, lagDev = 0, gap = 90, dly = -1;
  // the drawn state (update)
  bool ok = false;
  dvec3 pos{0}, vel{0};
  double yaw = 0, crouch = 0, lean = 0;
  int st = 0;
  uint32_t flags = 0;
  std::string veh, interior;
  dvec3 sm{0};
  double smYaw = 0;
  bool smOk = false;
  double animPhase = 0;
  double delay() const;
  void push(const Json& row, double now);
  const Snap& slot(int k) const { return ring[(head - k + RING * 2) % RING]; }
};

class Multiplayer {
public:
  explicit Multiplayer(MpHost host);
  ~Multiplayer();
  net::NetClient net;
  MpHost host;

  // ---- account
  struct Account { std::string name, token; };
  std::string url = net::kDefaultServerUrl;
  std::optional<Account> account() const;
  void forgetAccount();
  /// first launch: a unique name (the server issues the token); done(ok, words)
  void registerName(const std::string& name, std::function<void(bool, const std::string&)> done);
  /// log in with the stored account and enter the world; done(ok, words)
  void start(std::function<void(bool, const std::string&)> done);
  /// back to single player: the local save returns exactly as it was (close code 1000: the server lets you go at once)
  void leave();
  /// SETTINGS · Account: rename (once every 15 days) / delete, token-checked by the server (lib/accounts.js)
  void renameAccount(const std::string& newName, std::function<void(bool, const std::string&)> done);
  void deleteAccount(const std::string& confirm, std::function<void(bool, const std::string&)> done);

  bool active() const { return active_; }
  bool connecting() const { return busy_; }
  const std::string& statusLine() const { return statusLine_; }

  // ---- the frame
  /// network events, presence out, the clock, the money guard, pushes (call every frame, also when not active)
  void update(double dt, bool paused);

  // ---- the world
  std::string name;
  int pid = 0;
  int worldId = 0, worldMax = net::MAX_PLAYERS;
  std::map<int, RemotePlayer> players;     // everyone else in the world
  Json profile = Json::object(), catalog = Json::object();
  std::map<int, std::string> chaletOwners; // plot id -> owner name (every world: the global registry)
  int chaletPlot = -1;
  bool chaletWaiting = false;
  std::vector<std::string> guests;         // your chalet's guest list
  Json jailBoard = Json::array();
  std::map<std::string, Json> seats;       // 'kind|id' -> [[seat, pid], ...]
  std::map<std::string, Json> warps;       // 'kind|line' -> { off, rate, since }
  std::map<std::string, Json> skips;       // 'kind|id' -> { holding, aboard, active }

  // ---- the shared clock and weather
  std::optional<double> hourNow() const;
  std::optional<int> dayNow() const;
  std::string weather() const;
  std::string upcomingWeather() const;
  double upcomingIn() const;               // s until the forecast comes (-1 unknown)
  /// ms on a line's shared timeline (server clock + its speed-up: the trains' timetables)
  double lineTime(const std::string& key) const;

  // ---- money and purchases (the server's number wins)
  void setServerMoney(int64_t v);
  void guardMoney();
  void buy(const std::string& kind, Json data, std::function<void(bool, const Json&)> done);
  void earn(int64_t amount, const std::string& source, std::function<void(bool)> done = {});
  void carSell(const std::string& plate, std::function<void(bool, const Json&)> done);
  void carSwitch(const std::string& plate, std::function<void(bool, const Json&)> done);
  void carRepair(double damage, const std::string& plate, std::function<void(bool, const Json&)> done);
  void carDamage(const std::string& plate, double damage);
  void tow(const std::string& kind, const dvec3& home, double yaw, int bay, std::function<void(bool, const Json&)> done);
  void towDone();
  void jail(double seconds, const std::string& reason);
  void policeArrest(bool onFoot);
  void chaletFurniture(int id, std::function<void(bool, const Json&)> done);

  // ---- interiors, permissions, seats
  void setInterior(const std::string& id, std::function<void(bool)> done);
  const std::string& interior() const { return interior_; }
  /// ask an owner: kind 'carRide' (to: name) or 'chaletVisit' (ref: plot); done(allow, words)
  void ask(const std::string& kind, const std::string& to, int ref, std::function<void(bool, const std::string&)> done);
  struct PermAsk { int rid = 0; std::string text, kind, from; double until = 0; };
  std::deque<PermAsk> asks;                // owners' prompts waiting for Y / N (the HUD shows the first)
  void answerPerm(int rid, bool allow);
  void revokeGuest(const std::string& guest, const std::string& kind = "chaletVisit");
  void claimSeat(const std::string& k, const std::string& v, int n, std::function<void(bool, const Json&)> done, int seat = -1);
  void releaseSeat();
  void holdSkip(const std::string& k, const std::string& v, bool on, double rate, const std::string& line = "");
  std::string mySeat;                      // 'kind|id' claimed ("" none)
  /// riding in someone's car: { owner, pid, seat }
  struct CarRide { std::string owner; int pid = 0, seat = 0; bool on = false; } ride;
  /// the nearest other player's car within reach (pos), for "Ask <owner> for a ride"; -1 none
  int carNear(const dvec3& p, double reach, std::string& owner) const;
  /// a seat of another player's car in the world (the car as drawn): out pos / fwd
  bool rideSeat(dvec3& pos, dvec3& fwd) const;

  // ---- your car(s) as everyone sees them (carride.js frame / keptFrame)
  struct CarReport { bool has = false, driving = false, wreck = false; dvec3 pos{0}; double yaw = 0; std::string plate; };
  void reportCar(const CarReport& c);
  struct Kept { std::string plate; dvec3 pos; double yaw; bool wreck = false; };
  void reportKept(const std::vector<Kept>& list);

  // ---- messages
  struct Line { std::string from, text; double at = 0; bool admin = false; };
  std::deque<Line> chat;                   // chat lines and server notes (the last few, shown for a while)
  std::string banner, bannerFrom;          // the admin's banner across the top
  double bannerUntil = 0;
  void sendChat(const std::string& text);
  double clockSeconds() const;             // a monotonic clock for the HUD timers (s)

  // ---- tests
  int presenceSent = 0;
  int rowsReceived = 0;
  bool resumed = false;

private:
  void enter(const Json& d);
  void setWorld(const Json& w);
  void bind();
  void unbind();
  void relogin();
  void lost(const std::string& reason);
  void applyProfile(const Json& p);
  void restoreSave();
  void push(bool force = false, bool last = false);
  void addPlayer(const Json& p);
  void sendPresence();
  void updateRemotes();
  Json look() const;
  void loadAccounts();
  void storeAccount(const std::optional<Account>& a);
  void flash(const std::string& t, int k) const { if (host.flash) host.flash(t, k); }
  void connectThen(std::function<void(bool, const std::string&)> next);
  void accountOp(const std::string& t, Json extra, std::function<void(const net::NetResult&)> done);

  bool active_ = false, busy_ = false;
  std::string statusLine_;
  Json accounts_ = Json::object();
  bool accountsLoaded_ = false;
  std::vector<int> handlers_;
  Json spSave_;                            // the single-player save, set aside while online
  Json clock_;                             // { hour, at, day, dayMs, weather, upcoming, nextAt }
  int64_t moneyServer_ = 0, moneyPending_ = 0, expected_ = 0;
  std::map<std::string, std::string> pushed_;
  double pushT_ = -1, sendAcc_ = 0;
  std::string interior_;
  bool entering_ = false;
  std::string byeReason_;
  MpPose pose_;
  std::string skipKey_;
  bool skipOn_ = false;
  CarReport carSent_;
  bool carSentAny_ = false;
  double carCheckT_ = 0;
  std::string keptSig_;
  bool paused_ = false;
};

} // namespace sl
