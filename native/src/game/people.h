// People (Phase 5): every person the game draws besides you — townsfolk on the plaza (world/townsfolk.js), skiers on
// the pistes, the crowds at a course's finish (crowds.js), the job people (jobs/actors.js), the taxi's passengers, the
// race field (modes/race/bots.js), the police officers and the doctors. The rigged Meshy characters (the six skier_*
// colours with their _anims clips, the eight fan_* townsfolk, police_officer) are posed from a small set of shared poses
// built once per character (idle and walking / running cycles in phases, a skiing crouch, a tuck, seated, lying), so a
// person costs one skinned draw and no posing per frame; the nearest MAX within VIEW m are drawn, the far ones with the
// lighter meshoptimizer LOD. (fans.js composes every fan's skeleton per frame on the GPU: here the shared phases.)
// PeopleSim keeps the village and resort people walking between places (peoplesim.js condensed).
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {
class AssetManager;
class Renderer;
class World;
class Scenery;

enum class PAnim : uint8_t { Idle, Walk, Run, Ski, Tuck, Sit, Lie, Wave, Count };

struct Person {
  int kind = 0;
  dvec3 pos{0};
  double yaw = 0;        // facing (atan2(dx, dz))
  PAnim anim = PAnim::Idle;
  double phase = 0;      // cycles (walk / run), seconds (idle)
  float scale = 1;
  bool skis = false, pack = false;
  float lean = 0;        // skiing: into the turn (rad)
};

class People {
public:
  bool load(AssetManager& assets);
  int kind(const std::string& name) const;     // skier_red ... fan_man ... police_officer (-1 if missing)
  int kindCount() const { return int(kinds_.size()); }
  const std::string& kindName(int k) const { return kinds_[size_t(k)].name; }
  std::vector<int> fanKinds, skierKinds;
  int officer = -1;
  void begin() { list_.clear(); }
  void add(const Person& p) { list_.push_back(p); }
  size_t count() const { return list_.size(); }
  /// draws the nearest `maxDraw` within `view` m (shadows within 40 m)
  void submit(Renderer& r, const dvec3& cam, int maxDraw = 48, double view = 220);
  size_t drawn() const { return drawn_; }
private:
  struct Kind {
    std::string name;
    std::shared_ptr<Model> model;
    mat4 fit{1};
    float height = 1.75f;
    std::vector<Pose> poses[size_t(PAnim::Count)];
  };
  void buildPoses(Kind& k, const Model* animSrc);
  std::vector<Kind> kinds_;
  std::shared_ptr<Model> anims_, ski_, pack_;
  mat4 skiFit_{1};
  std::vector<Person> list_;
  size_t drawn_ = 0;
};

/// The townsfolk and the resort's skiers: people walking between places round the plaza (the hotels' doors, the ski
/// shop, the gondola, the market, the fire pit, the tree, the bus stop), standing in groups, and skiers going down the
/// pistes near you. Only simulated within SIM m of the camera; fewer at night.
class PeopleSim {
public:
  struct Place { double x, z; int kind; };     // kind 0 door, 1 stall / sight (stand a while), 2 the gondola
  void init(World& world, const std::vector<std::vector<dvec2>>& pistes, int fans, int skiers);
  void update(double dt, const dvec3& cam, double night, const Scenery* scenery);
  void add(People& people, const dvec3& cam) const;
  /// people near a point (peoplehits.js: knocked down by your car): index list
  void near(const dvec3& p, double r, std::vector<int>& out) const;
  /// knock person i (thrown along v, lies a while, then gets up)
  void knock(int i, double vx, double vz);
  size_t count() const { return folk_.size(); }
  const dvec3& pos(int i) const { return folk_[size_t(i)].pos; }
  bool down(int i) const { return folk_[size_t(i)].downT > 0; }
  int knocked = 0;
private:
  struct Folk {
    int kind = 0;
    dvec3 pos{0};
    double yaw = 0, v = 1.3, phase = 0, wait = 0, downT = 0, vx = 0, vz = 0;
    int target = -1, piste = -1;
    double s = 0, lat = 0;      // skiers: along their piste
    bool skier = false, active = true;
    float scale = 1;
  };
  void pick(Folk& f);
  World* world_ = nullptr;
  std::vector<Place> places_;
  std::vector<std::vector<dvec2>> pistes_;
  std::vector<std::vector<double>> cum_;
  std::vector<Folk> folk_;
  std::vector<int> fanKinds_, skierKinds_;
  unsigned seed_ = 4242;
  double rnd() { seed_ = seed_ * 1664525u + 1013904223u; return double(seed_ >> 8) / double(1u << 24); }
  double night_ = 0;
  friend class People;
public:
  void setKinds(const std::vector<int>& fans, const std::vector<int>& skiers) { fanKinds_ = fans; skierKinds_ = skiers; }
};

} // namespace sl
