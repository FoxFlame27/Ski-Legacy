#include "player/skier_rig.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "player/player.h"
#include "world/world.h"

namespace sl {

bool SkierRig::load(AssetManager& assets, const std::string& colour) {
  ModelLoadOptions o;
  o.maxTextureSize = 1024;
  body_ = assets.model("skier_" + colour + "_rigged", o);
  anims_ = assets.model("skier_" + colour + "_anims", o);
  ski_ = assets.model("ski_carver", o);
  if (!body_) return false;
  if (anims_) {
    idle_ = anims_->findClip("Idle");
    walk_ = anims_->findClip("Casual_Walk");
    run_ = anims_->findClip("Run_02");
    if (idle_) idleMap_ = bindClip(*body_, *idle_);
    if (walk_) walkMap_ = bindClip(*body_, *walk_);
    if (run_) runMap_ = bindClip(*body_, *run_);
  }
  fit_ = body_->fitTransform(1.78f, 1);   // a 1.78 m skier, feet on the ground
  if (ski_) skiFit_ = glm::rotate(mat4(1), float(-PI / 2), vec3(0, 1, 0)) * ski_->fitTransform(1.7f, 0, true);
  hips_ = body_->findNode("Hips"); spine_ = body_->findNode("Spine01"); spine1_ = body_->findNode("Spine02");
  upL_ = body_->findNode("LeftUpLeg"); upR_ = body_->findNode("RightUpLeg");
  legL_ = body_->findNode("LeftLeg"); legR_ = body_->findNode("RightLeg");
  armL_ = body_->findNode("LeftArm"); armR_ = body_->findNode("RightArm");
  footL_ = body_->findNode("LeftFoot"); footR_ = body_->findNode("RightFoot");
  body_->restPose(pose_);
  body_->finishPose(pose_);
  return true;
}

// rotate a bone about an axis given in model space (the rig's own local axes do not matter)
void SkierRig::bend(int b, const vec3& axis, float angle) {
  if (b < 0 || angle == 0) return;
  int par = body_->nodes[size_t(b)].parent;
  quat pg(1, 0, 0, 0);
  if (par >= 0) {
    mat3 m(pose_.global[size_t(par)]);
    m[0] = glm::normalize(m[0]); m[1] = glm::normalize(m[1]); m[2] = glm::normalize(m[2]);
    pg = glm::normalize(glm::quat_cast(m));
  }
  quat d = glm::angleAxis(angle, glm::normalize(axis));
  pose_.r[size_t(b)] = glm::normalize(glm::inverse(pg) * d * pg * pose_.r[size_t(b)]);
  body_->finishPose(pose_);
}

void SkierRig::update(double dt, const Player& p, World& world) {
  if (!body_) return;
  t_ += dt;
  double sp = p.speed();
  bool walking = p.mode == PlayerMode::Walk && sp > 0.1 && p.footJumpY == 0;
  double wantRun = walking && sp > 5.0 ? 1 : 0, wantWalk = walking && !wantRun ? 1 : 0;
  wWalk_ = lerp(wWalk_, wantWalk, damp(dt * 8));
  wRun_ = lerp(wRun_, wantRun, damp(dt * 8));
  walkPhase_ += dt * (wantRun ? sp / 6.3 : std::max(0.6, sp / 1.45));

  body_->restPose(pose_);
  if (idle_) sampleClip(*body_, *idle_, float(t_), 1.f, pose_, idleMap_);
  if (walk_ && wWalk_ > 0.01) sampleClip(*body_, *walk_, float(walkPhase_ * walk_->duration / 1.0), float(wWalk_), pose_, walkMap_);
  if (run_ && wRun_ > 0.01) sampleClip(*body_, *run_, float(walkPhase_ * run_->duration / 1.0), float(wRun_), pose_, runMap_);
  body_->finishPose(pose_);

  // procedural skiing stance (model space: the character faces +Z, +X is its left)
  bool ski = p.mode == PlayerMode::Ski;
  if (ski) {
    float c = float(clamp(p.crouch + p.absorb, -0.2, 1.1));
    float a = 0.35f + 0.9f * c;            // hip flexion
    float knee = 0.55f + 1.3f * c;
    float lean = 0.25f + 0.55f * c + (p.tuck ? 0.45f : 0.f);
    bend(upL_, vec3(1, 0, 0), -a); bend(upR_, vec3(1, 0, 0), -a);
    bend(legL_, vec3(1, 0, 0), knee); bend(legR_, vec3(1, 0, 0), knee);
    bend(footL_, vec3(1, 0, 0), -(knee - a) * 0.8f); bend(footR_, vec3(1, 0, 0), -(knee - a) * 0.8f);
    bend(spine_, vec3(1, 0, 0), lean * 0.6f); bend(spine1_, vec3(1, 0, 0), lean * 0.4f);
    // arms forward, as if holding poles
    float arm = p.tuck ? 1.1f : 0.55f;
    bend(armL_, vec3(1, 0, 0), -arm); bend(armR_, vec3(1, 0, 0), -arm);
    bend(armL_, vec3(0, 0, 1), -0.35f); bend(armR_, vec3(0, 0, 1), 0.35f);
  }
  // seated on a chair / a cabin's bench: thighs forward, knees bent, hands on the lap
  const bool sit = p.mode == PlayerMode::Sit;
  if (sit) {
    bend(upL_, vec3(1, 0, 0), -1.45f); bend(upR_, vec3(1, 0, 0), -1.45f);
    bend(legL_, vec3(1, 0, 0), 1.4f); bend(legR_, vec3(1, 0, 0), 1.4f);
    bend(spine_, vec3(1, 0, 0), -0.08f);
    bend(armL_, vec3(1, 0, 0), -0.45f); bend(armR_, vec3(1, 0, 0), -0.45f);
    bend(armL_, vec3(0, 0, 1), -0.25f); bend(armR_, vec3(0, 0, 1), 0.25f);
  }
  // keep the feet on the ground after bending the legs (seated: the hips on the seat)
  float footY = 0;
  if (sit && hips_ >= 0) footY = vec3(fit_ * pose_.global[size_t(hips_)][3]).y - 0.12f;
  else if (footL_ >= 0 && footR_ >= 0) {
    vec3 fl = vec3(fit_ * pose_.global[size_t(footL_)][3]), fr = vec3(fit_ * pose_.global[size_t(footR_)][3]);
    Pose rest;
    body_->restPose(rest);
    body_->finishPose(rest);
    vec3 rl = vec3(fit_ * rest.global[size_t(footL_)][3]);
    footY = std::min(fl.y, fr.y) - rl.y;
  }

  // body transform: position, heading, inclination into the turn, crash tumble
  origin_ = p.renderPos;
  dvec3 n = p.normal;
  float heading = float(p.heading + (ski ? p.yawFx : 0));
  mat4 M(1);
  if (p.mode == PlayerMode::Fall) {
    const FallState& F = p.fall;
    float ax = float(F.axisHeading);
    float drop = 0.85f * float(std::max(std::fabs(std::sin(F.roll)), std::fabs(std::sin(F.pitch)) * 0.6 + 0.0));
    M = glm::translate(mat4(1), vec3(0, 0.9f - drop * 0.75f, 0)) * glm::rotate(mat4(1), ax, vec3(0, 1, 0)) *
        glm::rotate(mat4(1), float(F.pitch), vec3(1, 0, 0)) * glm::rotate(mat4(1), float(F.roll), vec3(0, 0, 1)) *
        glm::translate(mat4(1), vec3(0, -0.9f, 0)) * glm::rotate(mat4(1), heading - ax, vec3(0, 1, 0));
  } else {
    M = glm::rotate(mat4(1), heading, vec3(0, 1, 0));
    if (ski) M = M * glm::rotate(mat4(1), float(p.edge), vec3(0, 0, 1));
  }
  body_M_ = M * glm::translate(mat4(1), vec3(0, -footY, 0)) * fit_;

  // skis: under the feet, on the snow, along the heading (+ the hockey-stop skid), edged a little into the turn
  skisVisible_ = ski_ && (ski || p.mode == PlayerMode::Fall || (sit && skisInRide)) && p.skisOn;
  if (skisVisible_ && sit) {
    // on the feet, level, along the seat's heading
    for (int s = 0; s < 2; s++) {
      int foot = s == 0 ? footL_ : footR_;
      vec3 fp = foot >= 0 ? vec3(body_M_ * pose_.global[size_t(foot)][3]) : vec3(s == 0 ? 0.13f : -0.13f, -0.5f, 0.5f);
      skiM_[s] = glm::translate(mat4(1), fp + vec3(0, -0.08f, 0)) * glm::rotate(mat4(1), heading, vec3(0, 1, 0)) *
                 glm::translate(mat4(1), vec3(0, 0, 0.12f)) * skiFit_;
    }
  } else if (skisVisible_) {
    vec3 up = glm::normalize(vec3(n));
    if (p.air) up = vec3(0, 1, 0);
    float yaw = float(p.heading + p.skidYaw * 0.8);
    vec3 fwd(std::sin(yaw), 0, std::cos(yaw));
    vec3 right = glm::normalize(glm::cross(fwd, up));   // toward the skier's right? (fwd x up = right-hand side)
    fwd = glm::normalize(glm::cross(up, right));
    mat4 frame(vec4(-right, 0), vec4(up, 0), vec4(fwd, 0), vec4(0, 0, 0, 1));  // columns: +X = left, +Y up, +Z forward
    for (int s = 0; s < 2; s++) {
      float side = s == 0 ? 1.f : -1.f;  // left, right
      float plowYaw = float(p.plow) * 0.3f * side;
      float lift = p.air ? 0.25f + float(clamp(p.crouch, 0, 1)) * 0.2f : 0.f;
      skiM_[s] = frame * glm::translate(mat4(1), vec3(side * 0.13f, 0.03f + lift, 0.05f)) *
                 glm::rotate(mat4(1), plowYaw, vec3(0, 1, 0)) * glm::rotate(mat4(1), float(p.edge) * 0.7f, vec3(0, 0, 1)) * skiFit_;
    }
  }
  (void)world;
}

void SkierRig::submit(Renderer& r, bool hideBody) const {
  if (!body_) return;
  if (!hideBody) r.submitModel(*body_, origin_, body_M_, &pose_, true);
  if (skisVisible_) for (int s = 0; s < 2; s++) r.submitModel(*ski_, origin_, skiM_[s], nullptr, true);
}

} // namespace sl
