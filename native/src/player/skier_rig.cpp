#include "player/skier_rig.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "player/player.h"
#include "world/world.h"
#include "gfx/gfx.h"
#include <algorithm>
#include <cmath>

namespace sl {

bool SkierRig::load(AssetManager& assets, const std::string& colour) {
  ModelLoadOptions o;
  o.maxTextureSize = 1024;
  ModelLoadOptions oc;
  oc.maxTextureSize = 1024;
  oc.keepCpu = true;   // (Phase 7: the outfits recolour the albedo per zone)
  // (its own copy, not the cache's: the townsfolk load the same skiers without the CPU data at 512)
  body_ = assets.loadFile(assets.modelPath("skier_" + colour + "_rigged"), "skier_" + colour + "_rigged", oc);
  gen_++;
  pole_ = assets.model("ski_pole", o);
  if (pole_) poleFit_ = pole_->fitTransform(1.2f, 1);
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
  handL_ = body_->findNode("LeftHand"); handR_ = body_->findNode("RightHand");
  body_->restPose(pose_);
  body_->finishPose(pose_);
  buildZones();
  return true;
}

// (Phase 7) the garment zones on the albedo: each vertex by its dominant bone (outfits.js analyzeZones does a colour
// clustering on top of this; the bones alone separate jacket / trousers / helmet well on these Meshy skiers)
void SkierRig::buildZones() {
  dressed_.reset();
  zone_.clear();
  if (!body_ || body_->skins.empty() || body_->materials.empty()) return;
  int img = body_->materials[0].baseImage;
  if (img < 0 || size_t(img) >= body_->images.size() || !body_->images[size_t(img)]) return;
  const CpuImage& im = *body_->images[size_t(img)];
  const Skin& sk = body_->skins[0];
  // the bones' positions in the mesh's (bind) space
  std::vector<vec3> jp(sk.joints.size());
  std::vector<int> cls(sk.joints.size(), 0);
  float hipsY = 0, headY = 1e9f, footY = -1e9f;
  for (size_t j = 0; j < sk.joints.size(); j++) {
    jp[j] = vec3(glm::inverse(sk.inverseBind[j])[3]);
    const std::string& n = body_->nodes[size_t(sk.joints[j])].name;
    auto has = [&](const char* k) { return n.find(k) != std::string::npos; };
    if (has("Hand") || has("Finger") || has("Thumb")) cls[j] = 0;
    else if (has("Head")) { cls[j] = 3; headY = std::min(headY, jp[j].y); }
    else if (has("Foot") || has("Toe")) { cls[j] = 0; footY = std::max(footY, jp[j].y); }
    else if (has("UpLeg") || has("Leg")) cls[j] = 2;
    else if (has("Hips")) { cls[j] = 4; hipsY = jp[j].y; }
    else if (has("Spine") || has("Neck") || has("Shoulder") || has("Arm")) cls[j] = 1;
  }
  zw_ = im.w; zh_ = im.h; zImage_ = img;
  zone_.assign(size_t(zw_) * zh_, 0);
  for (const Mesh& mesh : body_->meshes)
    for (const Primitive& p : mesh.primitives) {
      if (!p.cpuVerts || !p.cpuIdx || !p.skinned || p.material != 0) continue;
      const auto& V = *p.cpuVerts;
      const auto& I = *p.cpuIdx;
      size_t nv = V.size() / 16;
      std::vector<uint8_t> vz(nv, 0);
      for (size_t v = 0; v < nv; v++) {
        const float* q = &V[v * 16];
        int best = 0;
        for (int k = 1; k < 4; k++) if (q[12 + k] > q[12 + best]) best = k;
        size_t j = std::min(size_t(q[8 + best]), cls.size() - 1);
        int c = cls[j];
        float y = q[1];
        if (c == 4) c = y > hipsY + 0.04f ? 1 : 2;                 // the hips: the jacket's hem above, the trousers below
        if (c == 3 && y < headY + 0.07f) c = 0;                    // the face stays (the helmet: the top of the head)
        if (c == 2 && y < footY + 0.1f) c = 0;                     // the boots stay
        vz[v] = uint8_t(c);
      }
      for (size_t t = 0; t + 2 < I.size(); t += 3) {
        uint32_t a = I[t], b = I[t + 1], c = I[t + 2];
        uint8_t z = vz[a] == vz[b] || vz[a] == vz[c] ? vz[a] : vz[b] == vz[c] ? vz[b] : vz[a];
        if (!z) continue;
        vec2 P[3] = {vec2(V[a * 16 + 6], V[a * 16 + 7]), vec2(V[b * 16 + 6], V[b * 16 + 7]), vec2(V[c * 16 + 6], V[c * 16 + 7])};
        for (auto& q : P) { q.x = (q.x - std::floor(q.x)) * zw_; q.y = (q.y - std::floor(q.y)) * zh_; }
        int x0 = std::max(0, int(std::floor(std::min({P[0].x, P[1].x, P[2].x})))), x1 = std::min(zw_ - 1, int(std::ceil(std::max({P[0].x, P[1].x, P[2].x}))));
        int y0 = std::max(0, int(std::floor(std::min({P[0].y, P[1].y, P[2].y})))), y1 = std::min(zh_ - 1, int(std::ceil(std::max({P[0].y, P[1].y, P[2].y}))));
        if ((x1 - x0) * (y1 - y0) > zw_ * zh_ / 4) continue;   // (a seam wrapping round the atlas)
        float area = (P[1].x - P[0].x) * (P[2].y - P[0].y) - (P[2].x - P[0].x) * (P[1].y - P[0].y);
        if (std::fabs(area) < 1e-9f) continue;
        for (int y = y0; y <= y1; y++)
          for (int x = x0; x <= x1; x++) {
            vec2 s(x + 0.5f, y + 0.5f);
            float w0 = ((P[1].x - s.x) * (P[2].y - s.y) - (P[2].x - s.x) * (P[1].y - s.y)) / area;
            float w1 = ((P[2].x - s.x) * (P[0].y - s.y) - (P[0].x - s.x) * (P[2].y - s.y)) / area;
            float w2 = 1 - w0 - w1;
            if (w0 >= -0.02f && w1 >= -0.02f && w2 >= -0.02f) zone_[size_t(y) * zw_ + x] = z;
          }
      }
    }
  // each zone's median luminance (the shading is kept relative to it)
  for (int z = 1; z <= 3; z++) {
    int hist[256] = {0}, n = 0;
    for (size_t i = 0; i < zone_.size(); i++)
      if (zone_[i] == z) { const uint8_t* px = &im.rgba[i * 4]; hist[(px[0] * 77 + px[1] * 150 + px[2] * 29) >> 8]++; n++; }
    int acc = 0, m = 128;
    for (int k = 0; k < 256; k++) { acc += hist[k]; if (acc * 2 >= n) { m = k; break; } }
    median_[z] = std::max(8, m) / 255.f;
  }
  {
    size_t cnt[4] = {0, 0, 0, 0};
    for (uint8_t z : zone_) cnt[z & 3]++;
    SL_INFO("skier %s: outfit zones on its %dx%d albedo: jacket %.0f%%, trousers %.0f%%, helmet %.0f%%", body_->name.c_str(), zw_, zh_,
            100.0 * cnt[1] / zone_.size(), 100.0 * cnt[2] / zone_.size(), 100.0 * cnt[3] / zone_.size());
  }
  for (Mesh& mesh : body_->meshes) for (Primitive& p : mesh.primitives) { p.cpuVerts.reset(); p.cpuIdx.reset(); }   // (the image stays)
}

void SkierRig::applyOutfit(gfx::Device& dev, const vec4& jacket, const vec4& trousers, const vec4& helmet) {
  if (zone_.empty() || zImage_ < 0) return;
  if (outfitTex_) { dev.destroy(gfx::Texture{outfitTex_}); outfitTex_ = 0; }
  if (jacket.w <= 0 && trousers.w <= 0 && helmet.w <= 0) { dressed_.reset(); return; }
  const CpuImage& im = *body_->images[size_t(zImage_)];
  std::vector<uint8_t> px = im.rgba;
  const vec4 tgt[4] = {vec4(0), jacket, trousers, helmet};
  for (size_t i = 0; i < zone_.size(); i++) {
    int z = zone_[i];
    if (!z || tgt[z].w <= 0) continue;
    uint8_t* q = &px[i * 4];
    float lum = (q[0] * 0.3f + q[1] * 0.59f + q[2] * 0.11f) / 255.f;
    float k = std::clamp(lum / median_[z], 0.3f, 1.7f);
    for (int c = 0; c < 3; c++) q[c] = uint8_t(std::clamp(tgt[z][c] * k * 255.f, 0.f, 255.f));
  }
  gfx::TextureDesc d;
  d.width = im.w; d.height = im.h; d.format = gfx::TexFormat::SRGBA8; d.anisotropy = 8;
  outfitTex_ = dev.createTexture(d, px.data()).id;
  dressed_ = std::make_shared<Model>(*body_);
  dressed_->images.clear();
  dressed_->materials[0].baseTex = gfx::Texture{outfitTex_};
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
  // (Phase 7) the poles in the hands while skiing: from the fist down to a tip planted beside and a little behind the
  // boots (skier.js holds them so; no pole plants yet)
  polesVisible_ = pole_ && ski && p.skisOn && handL_ >= 0 && handR_ >= 0;
  if (polesVisible_) {
    for (int s = 0; s < 2; s++) {
      int hand = s == 0 ? handL_ : handR_;
      float side = s == 0 ? 1.f : -1.f;
      vec3 hp = vec3(body_M_ * pose_.global[size_t(hand)][3]);
      vec3 tip = vec3(M * vec4(side * 0.42f, 0.02f - (p.air ? -0.25f : 0.f), -0.28f - 0.25f * float(clamp(p.crouch, 0, 1)), 1));
      vec3 y = hp - tip;
      float len = glm::length(y) + 0.1f;
      y = glm::normalize(y);
      vec3 fwd = vec3(M * vec4(0, 0, 1, 0));
      vec3 x = glm::normalize(glm::cross(y, fwd) + vec3(1e-6f, 0, 0));
      vec3 z = glm::cross(x, y);
      poleM_[s] = mat4(vec4(x, 0), vec4(y, 0), vec4(z, 0), vec4(tip, 1)) * glm::scale(mat4(1), vec3(1, len / 1.2f, 1)) * poleFit_;
    }
  }
  (void)world;
}

void SkierRig::submit(Renderer& r, bool hideBody) const {
  if (!body_) return;
  if (!hideBody) r.submitModel(dressed_ ? *dressed_ : *body_, origin_, body_M_, &pose_, true);
  if (skisVisible_) for (int s = 0; s < 2; s++) r.submitModel(*ski_, origin_, skiM_[s], nullptr, true);
  if (polesVisible_ && !hideBody) for (int s = 0; s < 2; s++) r.submitModel(*pole_, origin_, poleM_[s], nullptr, true);
}

} // namespace sl
