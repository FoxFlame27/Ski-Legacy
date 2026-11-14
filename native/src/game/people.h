// People: every person the game draws besides you, all built and animated like the JS does it — the skier rig
// (player/skier_rig.h, skier.js) on each character's own rigged Meshy model, one rig per person (its own skeleton,
// skinning and smoothing state; no shared poses):
//  - People: whatever the game systems put there each frame (the race field, the job people, the taxi's passengers,
//    the police officers, the doctors, the other players): a Person says what it does (standing, walking, running,
//    skiing, the tuck, seated, lying), the rig poses it. A person keeps its rig from frame to frame (matched by
//    character and position), so the walk cycles, blends and springs run on as in the JS.
//  - Npcs (game/npcs.js): the resort's skiers carving down the pistes near you (S-turns along the piste lines, speed
//    from the slope, pole plants at each turn, fewer at night), the walkers in the village (to and from the gondola with
//    their skis on the back, the shop, the market, the trail map, the hotels, along the plaza's path ring), and the far
//    skiers all over the mountain (one instanced draw of small figures beyond 160 m), at the preset's densities
//    (quality.js npcs: skiers, walkers, animNear: the distance within which rigs are posed every frame).
//  - PeopleSim: the townsfolk on the plaza (townsfolk.js / peoplesim.js, game/townsfolk.cpp): the fan_* characters as
//    the web game's crowd people (fans.js: player/fans_rig, their own keyframed walk, stances, gestures, jacket colours,
//    LODs), coming and going between the hotels, the shop, the gondola, the market, the fire pit, the tree, the map.
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include "engine/renderer.h"
#include "player/skier_rig.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {
class AssetManager;
class Renderer;
class World;
class Scenery;
class FanKit;
struct Quality;

enum class PAnim : uint8_t { Idle, Walk, Run, Ski, Tuck, Sit, Lie, Wave, Count };

struct Person {
  int kind = 0;
  dvec3 pos{0};
  double yaw = 0;        // facing (atan2(dx, dz))
  PAnim anim = PAnim::Idle;
  double phase = 0;      // (legacy: cycles / seconds; the rig keeps its own clocks)
  float scale = 1;
  bool skis = false, pack = false;
  float lean = 0;        // skiing: into the turn (-1..1, + right, npcs.js s.lean)
  bool poles = false;    // carries poles (race bots)
  double speed = -1;     // m/s (-1: from the motion)
  /// in a car (player/car_seat.h): Figure, one of the traffic's seated people (posed as carpeople.js bakes them, placed
  /// on its seat; pos: about there); Seated, sat at the seat point pos, the legs into the footwell (taxi.js / remote.js)
  CarSeatRef car;
};

/// One character for the rigs: its rig model (bones, measurements, clips) and the model drawn (the fans' textured
/// LOD only: their vertex-coloured stand-ins are separate primitives of the same mesh)
struct PeopleKind {
  std::string name;
  std::shared_ptr<RigModel> rig;
  std::shared_ptr<Model> draw;
  bool skier = false;
};

/// A posed rig and how it is drawn (shared by People, Npcs and PeopleSim).
struct RigInst {
  SkierRig rig;
  Pose pose;
  int kind = -1, gear = 0;
  double animAcc = 0;
  bool posed = false;
  void pose_() { rig.writePose(pose); posed = true; }
};
void drawRig(Renderer& r, const RigInst& R, const PeopleKind& K, const RigGear* gear, double scale, bool shadow);

class People {
public:
  bool load(AssetManager& assets, World& world);
  int kind(const std::string& name) const;     // skier_red ... fan_man ... police_officer (-1 if missing)
  int kindCount() const { return int(kinds_.size()); }
  const std::string& kindName(int k) const { return kinds_[size_t(k)].name; }
  const PeopleKind& kindOf(int k) const { return kinds_[size_t(k)]; }
  std::vector<int> fanKinds, skierKinds;
  int officer = -1;
  /// the townsfolk's characters as fans.js bakes them (player/fans_rig: PeopleSim draws them), FAN_MODELS order
  std::vector<std::shared_ptr<FanKit>> fanKits;
  void begin(double dt = 1.0 / 60) { list_.clear(); dt_ = dt; }
  void add(const Person& p) { list_.push_back(p); }
  size_t count() const { return list_.size(); }
  /// poses and draws the nearest `maxDraw` within `view` m (shadows within 40 m)
  void submit(Renderer& r, const dvec3& cam, int maxDraw = 48, double view = 220);
  size_t drawn() const { return drawn_; }
  double animNear = 90;      // (quality.js npcs.animNear)
  std::shared_ptr<RigGear> gear(int i) const { return gears_[size_t(i)]; }
  World* world() const { return world_; }
  size_t drawnExtra = 0;      // (Npcs / PeopleSim add theirs: the autotest's count)
private:
  struct Slot { RigInst R; dvec3 last{0}; int seen = -100, gear = 0; double speed = 0; bool used = false; PAnim anim = PAnim::Idle; };
  std::vector<PeopleKind> kinds_;
  std::vector<std::shared_ptr<RigGear>> gears_;   // rental / sport / pro skis without poles, rental with poles
  std::vector<Person> list_;
  std::vector<std::unique_ptr<Slot>> slots_;
  World* world_ = nullptr;
  double dt_ = 1.0 / 60;
  int frame_ = 0;
  size_t drawn_ = 0;
};

/// npcs.js: the resort's skiers and walkers, and the far skiers.
class Npcs {
public:
  struct Path { std::vector<dvec2> p; };
  void init(People& people, gfx::Device& dev, World& world, const std::vector<std::vector<dvec2>>& pistes, const Quality& q);
  void update(double dt, const dvec3& playerPos, const dvec3& camPos, double dayFactor);
  void submit(Renderer& r, const dvec3& cam);
  bool off = false;            // (multiplayer: nobody but real players)
  size_t skiers() const { return skiers_.size(); }
  size_t walkers() const { return walkers_.size(); }
  size_t drawn() const { return drawn_; }
  int maxSkiers = 1 << 30;
  /// people near a point (the player's soft bumps): positions
  void near(const dvec3& p, double r, std::vector<dvec3>& out) const;
private:
  struct Skier {
    std::unique_ptr<RigInst> R;
    int path = -1, gear = 0;
    double u = 0, v = 3, amp = 4, wave = 26, phase = 0, maxV = 7, heading = 0, lean = 0, lastTurn = 0;
    dvec3 pos{0}, vel{0};
  };
  struct Walker {
    std::unique_ptr<RigInst> R;
    dvec3 pos{0};
    bool hasTarget = false;
    dvec2 target{0};
    std::vector<dvec2> route;
    double wait = 0, heading = 0, speed = 0;
    bool carry = false;
  };
  std::unique_ptr<RigInst> takeRig(int k, int& gear);
  void releaseRig(std::unique_ptr<RigInst> r);
  void spawnSkier(const dvec3& p);
  std::vector<dvec2> route(const dvec2& from, const dvec2& to);
  void ensureWalkers(const dvec3& p);
  People* people_ = nullptr;
  World* world_ = nullptr;
  std::vector<std::vector<dvec2>> paths_;
  std::vector<Skier> skiers_;
  std::vector<Walker> walkers_;
  std::vector<std::unique_ptr<RigInst>> pool_;
  double spawnTimer_ = 0, animNear_ = 90, logT_ = 0;
  int qSkiers_ = 10, qWalkers_ = 4;
  size_t drawn_ = 0;
  unsigned seed_ = 20261113;
  double rnd() { seed_ = seed_ * 1664525u + 1013904223u; return double(seed_ >> 8) / double(1u << 24); }
  // far skiers (npcs.js FarSkiers): one instanced batch per jacket colour
  struct Far { int path = -1; double u = 0, v = 4, amp = 3, wave = 22, phase = 0, heading = 0; int colour = 0; };
  std::vector<Far> far_;
  std::vector<std::vector<dvec2>> farPaths_;
  std::vector<std::shared_ptr<Model>> farModels_;
  std::vector<MatrixInstanceBatch> farBatches_;
  std::vector<std::vector<MatrixInstanceBatch::Inst>> farInst_;
  std::vector<uint32_t> farCap_;
  gfx::Device* dev_ = nullptr;
  double dayFactor_ = 1;
  dvec3 cam_{0};
  void spawnFar(Far& o, bool anywhere);
};

/// The townsfolk (world/townsfolk.js + peoplesim.js, drawn and posed as world/fans.js's crowd people: player/fans_rig):
/// the village's people come out of the hotels' doors, the ski shop and the gondola with something to do: skiers carry
/// their skis over the shoulder to the gondola (and back from it), others browse the market stalls, warm their hands at
/// the fire pit, stop at the Christmas tree for a photo (a phone), read the trail map and point out a run, look in the
/// shop's window, queue at the ticket booth, wait for the bus; a third come in twos and stop together, people standing
/// at the same place chat (turned to each other, the hands going); they walk the plaza's path ring at their own pace
/// (turning smoothly, slowing for the last metres, stepping round the people in front, the lamps, stalls and walls,
/// and you), fade in at a door and out where they go in. Fewer out at night. Simulated while the camera is within
/// 260 m of the plaza; drawn within 170 m (the three LODs at 18 / 50 m, cross-faded), no shadows (a soft contact shade
/// under each), posed less often further out. Knocked over by your car: thrown, tumbling, lying, getting up.
class PeopleSim {
public:
  struct Place { double x, z; int kind; };
  PeopleSim();
  ~PeopleSim();
  PeopleSim(const PeopleSim&) = delete;
  PeopleSim& operator=(const PeopleSim&) = delete;
  void setKinds(const std::vector<int>& fans, const std::vector<int>& skiers) { fanKinds_ = fans; skierKinds_ = skiers; }
  /// the crowd characters (People::fanKits)
  void setKits(const std::vector<std::shared_ptr<FanKit>>& kits);
  /// n people (townsfolk.js: 56) on the plaza
  void init(World& world, const std::vector<std::vector<dvec2>>& pistes, int fans, int skiers);
  void update(double dt, const dvec3& cam, double night, const Scenery* scenery);
  /// (the townsfolk draw themselves: submit; nothing goes through People any more)
  void add(People&, const dvec3&) const {}
  /// poses (LODs, fades, the posing rate) and draws the people in view
  void submit(Renderer& r, const dvec3& cam);
  /// walking people step round the player (peoplesim.js PeopleSim.player)
  void setPlayer(const dvec3& p) { player_ = dvec2(p.x, p.z); hasPlayer_ = true; }
  /// people near a point (peoplehits.js: knocked down by your car): index list
  void near(const dvec3& p, double r, std::vector<int>& out) const;
  /// knock person i (thrown along v, tumbling, lying a while, then getting up)
  void knock(int i, double vx, double vz);
  size_t count() const { return pos_.size(); }
  const dvec3& pos(int i) const { return pos_[size_t(i)]; }
  bool down(int i) const;
  size_t drawn() const { return drawn_; }
  int knocked = 0;
private:
  struct Impl;
  std::unique_ptr<Impl> I_;
  std::vector<dvec3> pos_;          // (on stage: the feet; off stage: far away)
  std::vector<int> fanKinds_, skierKinds_;
  dvec2 player_{1e9};
  bool hasPlayer_ = false;
  size_t drawn_ = 0;
};

} // namespace sl
