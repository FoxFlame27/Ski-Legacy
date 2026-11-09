// The player's body: the rigged skier GLB (skier_<colour>_rigged.glb) animated with the clips of its _anims.glb
// (Idle, Casual_Walk, Run_02; retargeted by bone name), plus a procedural skiing stance on top (crouch, knee and hip
// flexion, forward lean, inclination into the turn, landing absorption), the tumble of a crash, and a pair of skis.
// skier.js poses every bone procedurally; Phase 1 keeps it to these layers.
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include <memory>
#include <vector>

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
  bool skisInRide = true;   // riding: skis on the feet (a chairlift) or in the cabin's outside rack (a gondola: hidden)
  /// (Phase 7, outfits.js condensed) the shop's garments on the skier: its baked albedo recoloured per zone (jacket:
  /// the torso and arms, trousers: the hips and legs, helmet: the top of the head; zones from the skin weights), the
  /// texture's own shading kept (luminance against the zone's median). rgb sRGB 0..1, a = 0: the original piece.
  void applyOutfit(gfx::Device& dev, const vec4& jacket, const vec4& trousers, const vec4& helmet);
  bool polesVisible() const { return polesVisible_; }
  int generation() const { return gen_; }   // bumped by every load (the outfit is applied again)
  bool dressed() const { return bool(dressed_); }

private:
  void bend(int bone, const vec3& modelAxis, float angle);
  void buildZones();
  std::shared_ptr<Model> pole_, dressed_;
  mat4 poleFit_{1}, poleM_[2];
  bool polesVisible_ = false;
  int handL_ = -1, handR_ = -1;
  std::vector<uint8_t> zone_;
  int zw_ = 0, zh_ = 0, zImage_ = -1;
  float median_[4] = {0.5f, 0.5f, 0.5f, 0.5f};
  uint32_t outfitTex_ = 0;
  int gen_ = 0;
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
