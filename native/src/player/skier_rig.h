// The player's body: the rigged skier GLB (skier_<colour>_rigged.glb) animated with the clips of its _anims.glb
// (Idle, Casual_Walk, Run_02; retargeted by bone name), plus a procedural skiing stance on top (crouch, knee and hip
// flexion, forward lean, inclination into the turn, landing absorption), the tumble of a crash, and a pair of skis.
// skier.js poses every bone procedurally; Phase 1 keeps it to these layers.
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include <memory>

namespace sl {
class AssetManager;
class Renderer;
class Player;
class World;

class SkierRig {
public:
  bool load(AssetManager& assets, const std::string& colour = "red");
  void update(double dt, const Player& p, World& world);
  void submit(Renderer& r, bool hideBody) const;
  bool loaded() const { return bool(body_); }

private:
  void bend(int bone, const vec3& modelAxis, float angle);
  std::shared_ptr<Model> body_, anims_, ski_;
  const AnimClip *idle_ = nullptr, *walk_ = nullptr, *run_ = nullptr;
  std::vector<int> idleMap_, walkMap_, runMap_;
  Pose pose_;
  mat4 fit_{1}, skiFit_{1};
  int hips_ = -1, upL_ = -1, upR_ = -1, legL_ = -1, legR_ = -1, spine_ = -1, spine1_ = -1, armL_ = -1, armR_ = -1, footL_ = -1, footR_ = -1;
  double t_ = 0, wWalk_ = 0, wRun_ = 0, walkPhase_ = 0;
  dvec3 origin_{0};
  mat4 body_M_{1}, skiM_[2];
  bool skisVisible_ = false;
};

} // namespace sl
