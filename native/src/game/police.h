// POLICE (Phase 5, game/police.js condensed), the PRISON (prison.js), getting hit by vehicles (vehiclehits.js) and
// knocking people over (peoplehits.js).
//   Wanted       hitting a car or a person with your car at 25+ km/h (or a patrol car at 15+), speeding hard past
//                the police station: the WANTED level (1-5 stars: called, fleeing, then up with the time they have
//                you in sight, every patrol car you hit); each level brings more patrol cars (police.js LEVELS: cars,
//                road speed, ram gaps, sight, the time to lose them)
//   Patrol cars  car1.glb in the POLIZEI livery with the flashing roof bar, spawned out of sight 260-420 m away on
//                the roads (behind you), along the roads while far, straight at you when close, ramming you while you
//                flee (the impacts are drive.js's: knocks, crashes, damage)
//   Helicopter   at 3+ stars or 45 s into fleeing: heli_body.glb 72 m up with its searchlight on you; while it sees
//                you the escape clock stops (a road tunnel hides you)
//   Pull over    stop (< 3 km/h for 3 s) with them within 40 m: the officer walks to your window: the fine ($1,000
//                +$500 for every earlier one), or drive off (fleeing)
//   Escape       out of every patrol car's sight (line of sight through the terrain, their range) and the
//                helicopter's: SEARCHING after 2.5 s, escaped after the level's time (x2.2 on foot)
//   Arrest       boxed in (two cars within 12 m for 10 s), stopped while fleeing, caught on foot by the officer
//                (he runs 6.9 m/s): the ARRESTED banner, the fine ($3,000 +$1,000 each time), 45 s in a cell
//   Prison       the cell behind the bars ("In prison · 0:45"), released out of the station's door; E at the door
//                visits it (the visitors' book: a local leaderboard of jail visits, arrests and fines)
//   Hits         a car / bus / patrol car into you on foot or on skis: under 35 km/h just knocked over (a bump),
//                35-45 km/h a strike (two: the rescue helicopter), 45+ km/h the rescue at once; your car into the
//                village's people: thrown along your line, they lie a while and get up, a fine ($12 per km/h)
#pragma once
#include "game/interiors.h"
#include "game/window_view.h"
#include "game/play.h"
#include "game/vehicles.h"
#include <array>
#include <memory>
#include <string>
#include <vector>

namespace sl {
class Renderer;
class People;
class Shapes;
struct OtherBody;
class Interiors;

class Police {
public:
  Police(PlayCtx& c, Interiors& rooms, WindowView& win);
  void load(AssetManager& assets);
  // ---- triggers
  void callFor(const std::string& why, double kmh);          // a hit with your car at kmh closing speed
  void hitCop(int unit, double kmh);                          // your car into a patrol car
  bool wanted() const { return wanted_; }
  /// (trail map, police.js mapMarkers) the patrol cars while you are wanted, the helicopter while it is out
  struct MapMark { double x, z; bool heli, sees; };
  std::vector<MapMark> mapMarks() const;
  int stars() const { return wanted_ ? std::clamp(int(heat_), 1, 5) : 0; }
  bool fleeing() const { return fleeing_; }
  bool arrestedNow() const { return arrestT_ >= 0; }
  void clear(const char* why);                                // wanted cleared (escaped, fined, jailed)
  /// (multiplayer, the user's rule) riding in another player's car: `stars` their wanted level (0: not wanted, -1: not
  /// aboard, -2: their row unknown this frame). Aboard a wanted car you are wanted with them at their level (the
  /// WANTED box; their patrol cars chase the car, none of yours); out of it you stay wanted on your own, at that level,
  /// until you escape or are caught; still aboard when they get away, you got away with them.
  void passenger(int stars, const std::string& driver);
  bool passengerWanted() const { return rideMirror_; }
  /// (police.js chaseSnap / resume, multiplayer: the profile's 'wanted') a chase under way: heat, escape time, chase
  /// time, fleeing; false when not wanted. resume() carries one on at the next login.
  bool snapshot(double& heat, double& esc, double& t, bool& fleeing) const;
  void resume(double heat, double esc, double t, bool fleeing);
  void update(double dt);
  /// patrol cars as bodies for drive.js bash (kind 3) and for the player's collisions
  void others(std::vector<OtherBody>& out, const dvec3& near) const;
  void knockUnit(int id, double vx, double vz);
  void fillColliders(std::vector<Collider>& out) const;
  void addDraw(VehicleDraw& vd, const dvec3& cam) const;
  /// (multiplayer, police.js netFrame) your patrol cars for the other players: [x, y, z, yaw, v] each (8 at most)
  std::vector<std::array<double, 5>> mpCars() const;
  /// (net/vehicles.js updatePolice) another player's patrol car, drawn with the same model at pos (on the ground)
  void addDrawAt(VehicleDraw& vd, const dvec3& pos, double yaw, double dist) const;
  /// the patrol cars' number plates (police.js buildPoliceCar: setPlates(inst, C.t, policePlate())): the cars near the
  /// camera as poses for SceneFx::plates
  void carPoses(std::vector<CarPose>& out, const dvec3& cam) const;
  void draw(Renderer& r, const dvec3& cam);
  void addPeople(People& p, const dvec3& cam) const;
  void hud(Ui& ui, float u);
  bool interact(std::string& prompt, bool pressed);           // the station's door: visit; inside: leave
  // ---- the prison
  void jail(double seconds, const std::string& reason);
  bool jailed() const { return jailLeft_ > 0; }
  /// (the view this frame: what you look at inside the station)
  void setView(const dvec3& eye, const vec3& dir) { camPos_ = eye; camDir_ = dir; }
  /// going in (the fade, the windows' photographs): you stand still
  bool busy() const { return entering_; }
  /// (tests) in as a visitor
  void debugVisit() { if (!rooms_.inside() && !entering_) enterStation(false); }
  double jailLeft() const { return jailLeft_; }
  std::string objective() const;
  // ---- vehicle hits (vehiclehits.js) and people hits (peoplehits.js)
  struct Hit { bool pending = false; bool strike = false, rescue = false; int kmh = 0; std::string what; };
  void vehicleHits(double dt, const std::vector<Obb>& buses);
  void peopleHits(double dt);
  Hit takeHit() { Hit h = hit_; hit_ = Hit{}; return h; }
  int arrests() const;
  // (autotest)
  size_t units() const { return units_.size(); }
  /// (debug, poltest) the nearest officer running after you on foot: his distance (-1: none), the fine's card up
  double footGap() const;
  bool fineAsked() const { return fineOpen_; }
  std::string status() const;
  bool heliUp() const { return heli_.on; }
  /// (Phase 7, audio) the nearest patrol car sounding its siren (in a chase) and the helicopter
  bool sirenNear(const dvec3& p, dvec3& out) const {
    double best = 1e18;
    for (const Unit& u : units_) if (wanted_ && !u.leaving) { double d = glm::length(u.pos - p); if (d < best) { best = d; out = u.pos; } }
    return best < 1e17;
  }
  bool heliAt(dvec3& out) const { if (!heli_.on) return false; out = heli_.pos; return true; }
  void skipJail(double left) { if (jailLeft_ > left) jailLeft_ = left; }
private:
  struct Unit {
    dvec3 pos{0};
    double yaw = 0, v = 0, ramT = 0, kvx = 0, kvz = 0, flash = 0;
    int road = -1, dir = 1;
    double s = 0, bestD = 1e18, stuckT = 0;
    bool stopped = false, leaving = false;
    std::string plate;   // (police.js policePlate: a Swiss plate of its own for every patrol car built)
    // its officer on foot
    bool out = false;
    dvec3 off{0};
    double offYaw = 0, offT = 0, offBest = 1e18;   // (offBest: the nearest he got to you, running after you)
    int offState = 0;   // 0 in the car, 1 walking to your window, 2 at the window (the fine), 3 running after you, 4 back
  };
  void spawnUnit();
  bool canSee(const Unit& u, const dvec3& p, double range) const;
  void arrest(const char* how);
  void driveUnit(Unit& u, double dt, const dvec3& target, double want);
  void openFine();
  PlayCtx& c_;
  Interiors& rooms_;
  WindowView& win_;
  void enterStation(bool jailed);   // in behind the fade (the windows photographed on the way)
  std::shared_ptr<Model> outside_;  // the station outdoors as prisonoutside.js builds it (exported)
  bool entering_ = false;
  dvec3 camPos_{0};
  vec3 camDir_{0, 0, 1};
  std::shared_ptr<Model> car_, heliModel_, station_;
  mat4 carFit_{1}, heliFit_{1}, stationFit_{1};
  bool car1_ = false;   // car_ is car1 (police.js car1Template), not the fallback model
  /// the patrol car's fit: car1 as the web game's car template fits it (Transport::policeFit), else measured here
  glm::dmat4 carFit() const;
  std::vector<Unit> units_;
  bool rideMirror_ = false;
  std::string rideDriver_;
  double logT_ = 0;
  bool wanted_ = false, fleeing_ = false, searching_ = false, spotted_ = false, pulled_ = false, fineOpen_ = false;
  // (the fine: the card open (our dialog), when you got in / out of the car last (police.js _swapT: getting out is not
  // running off), when the card was dismissed (opened again))
  bool fineCard_ = false, wasDriving_ = false;
  double swapT_ = -1e9, fineShutT_ = -1;
  void flee(bool dropOfficers);
  double coolUntil_ = -1e9;   // (police.js cool / cooldownS: no new chase for 6 s after one ends (a fine paid, escaped))
  double footAgainT_ = 0;   // (police.js footT: after an officer gave up on foot, s before the next one gets out)
  double hitT_ = -1e9, copHitT_ = -1e9;   // (police.js w.hitT / w.copHitT: the same hit's next frames add no heat)
  double heat_ = 0, wantedT_ = 0, seenT_ = 0, unseenT_ = 0, escT_ = 0, stopT_ = 0, reachT_ = -1, holdT_ = 0, reinT_ = 0, arrestT_ = -1, fleeT_ = 0;
  dvec3 lastSeen_{0};
  std::string arrestHow_;
  struct Heli { bool on = false; dvec3 pos{0}, vel{0}; double yaw = 0, rotor = 0; bool sees = false; double hideT = 0; } heli_;
  // the prison
  double jailLeft_ = 0, jailTotal_ = 0, saveT_ = 0;
  std::string jailReason_;
  bool visiting_ = false;
  // hits
  Hit hit_;
  double safeUntil_ = -1e9, fineT_ = -1e9, speedT_ = 0;
  std::vector<dvec2> busPrev_;
  std::vector<int> nearTmp_;
  std::string radio_;
  // the big word on the screen for a moment (police.js slam): the text, the line under it, the flash's strength
  std::string slamText_, slamSub_;
  double slamAt_ = -100, slamK_ = 0;
  double slowT_ = -100;   // (police.js slowT: the last slow-motion hit; TUNING.slowMoS = 5 s between two)
  // (police.js unit(k) builds patrol car k once and keeps it, policePlate() giving it the next plate; plateN 0 went to
  // the car parked at the station, built with the world): the plate of each unit slot
  int plateN_ = 1;
  std::vector<std::string> slotPlates_;
  mutable VehicleModel plateVm_;   // (the plates' places on the patrol car: Transport::policePlates)
  int prevStars_ = 0;
  void slam(const std::string& text, const std::string& sub, double k) { slamText_ = text; slamSub_ = sub; slamK_ = k; slamAt_ = c_.now; }
  double radioT_ = -1;
  unsigned seed_ = 31337;
  double rnd() { seed_ = seed_ * 1664525u + 1013904223u; return double(seed_ >> 8) / double(1u << 24); }
};

} // namespace sl
