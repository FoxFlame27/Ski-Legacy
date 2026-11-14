// The first-person view model's meshes (skier.js fpArmTemplate / buildFpArm / fpArmMaterial / fpPoleGeometry): Meshy's
// gloved hand and forearm (driving_hand_c, a left fist closed round a bar; the right arm its mirror image) with the
// pole through the fist, read into the fist's frame; glove and sleeve recoloured (your character's gloves, your jacket)
// over the model's own shading. The rig poses them (SkierRig::updateFpView); drawn here.
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include "player/skier_rig.h"
#include <memory>

namespace sl {
class AssetManager;
class Renderer;

class FpHands {
public:
  /// loads the arm (driving_hand_c) and builds the pole; false: no arm (the poles are still drawn)
  bool load(gfx::Device& dev, AssetManager& assets);
  bool loaded() const { return tried_; }
  bool armsLoaded() const { return bool(arm_[0]); }
  /// the glove's and the sleeve's colour (linear): the recoloured textures rebuilt when they change
  void setColours(const vec3& glove, const vec3& sleeve);
  void submit(Renderer& r, const SkierRig::FpView& v) const;

private:
  gfx::Device* dev_ = nullptr;
  bool tried_ = false;
  std::shared_ptr<Model> src_;                 // the GLB (its normal / roughness maps)
  std::shared_ptr<Model> arm_[2];              // glove part (aSleeve < cut) / sleeve part (with the sleeve's cap)
  std::shared_ptr<Model> pole_;
  std::shared_ptr<CpuImage> img_;              // the base colour texture (sRGB, CPU)
  double ref_[2] = {0.01, 0.01};               // the texture's median luminance under the glove / the sleeve
  vec3 glove_{-1}, sleeve_{-1};
  gfx::Texture tex_[2];
};

/// skier.js fpRigColour: the main colour of a character's own texture where one bone carries the skin (the commonest
/// colour, linear), false if it has none
bool fpRigColour(const RigModel& rig, int bone, vec3& out);

} // namespace sl
