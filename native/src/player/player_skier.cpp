// The player's body: player.js's feed of the skier rig (update(): the rig state from the controller, every frame),
// the models (main.js makeRig: your character's _rigged / _anims, the equipped skis, the poles) and drawing.
#include "player/skier_rig.h"
#include "player/outfits.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "player/player.h"
#include "world/world.h"
#include <unordered_map>

namespace sl {
using namespace three;

namespace {
std::unordered_map<std::string, std::shared_ptr<RigModel>>& rigModels() { static std::unordered_map<std::string, std::shared_ptr<RigModel>> m; return m; }
std::unordered_map<std::string, std::shared_ptr<RigGear>>& rigGears() { static std::unordered_map<std::string, std::shared_ptr<RigGear>> m; return m; }
} // namespace

std::shared_ptr<RigModel> rigModel(AssetManager& assets, const std::string& charId, const SkierRig::Ground& ground, const std::string& fileIn,
                                   const std::string& animsIn) {
  const std::string file = fileIn.empty() ? charId + "_rigged" : fileIn, animsName = animsIn == "-" ? charId + "_anims" : animsIn;
  auto& cache = rigModels();
  auto it = cache.find(charId);
  if (it != cache.end()) return it->second;
  ModelLoadOptions oc;
  oc.maxTextureSize = 1024;
  oc.keepCpu = true;   // (the measurements read the skinned vertices; the outfits the albedo)
  auto body = assets.loadFile(assets.modelPath(file), file + "#rig", oc);
  ModelLoadOptions oa;
  oa.maxTextureSize = 16;
  std::shared_ptr<Model> anims = animsName.empty() ? nullptr : assets.model(animsName, oa);
  auto m = std::make_shared<RigModel>();
  if (!body || !m->build(body, anims.get(), [&](double x, double z, double y) { return ground(x, z, y); })) {
    SL_WARN("rig: %s could not be built", charId.c_str());
    cache[charId] = nullptr;
    return nullptr;
  }
  SL_INFO("rig %s: %zu bones, legs %.3f m, arms %.3f m, hips +-%.3f, back %.3f / seat %.3f, clips %s", charId.c_str(), m->bones.size(), m->legLen, m->armLen,
          m->hipHalfW, m->backDepth, m->seatDepth, m->hasClips ? "idle / walk / run" : "none");
  cache[charId] = m;
  return m;
}

std::shared_ptr<RigGear> rigGear(AssetManager& assets, const std::string& skiModel, bool poles) {
  std::string key = skiModel + (poles ? "|poles" : "");
  auto& cache = rigGears();
  auto it = cache.find(key);
  if (it != cache.end()) return it->second;
  ModelLoadOptions o;
  o.maxTextureSize = 512;
  o.keepCpu = true;
  std::shared_ptr<Model> ski = skiModel.empty() ? nullptr : assets.loadFile(assets.modelPath(skiModel), skiModel + "#rig", o);
  if (!ski && !skiModel.empty()) ski = assets.loadFile(assets.modelPath("ski_rental"), "ski_rental#rig", o);
  std::shared_ptr<Model> pole = poles ? assets.model("ski_pole", ModelLoadOptions{}) : nullptr;
  auto g = std::make_shared<RigGear>();
  g->build(ski, pole);
  cache[key] = g;
  return g;
}

bool PlayerSkier::load(AssetManager& assets, const std::string& colour, const std::string& skiModel) {
  // (measured at the village plaza, like the JS's first rig at the origin)
  auto m = rigModel(assets, "skier_" + colour, [](double, double, double) { return 0.0; });
  if (!m) return false;
  model_ = m;
  gear_ = rigGear(assets, skiModel, true);
  rig = SkierRig();
  rig.init(model_, gear_, true, true, [](double, double, double) { return 0.0; });
  gen_++;
  dressed_.reset();
  lookKey_.clear();
  return true;
}

// player.js update(): the rig state, every frame
void PlayerSkier::update(double dt, Player& p, World& world) {
  if (!rig.ready()) return;
  rig.setGround([&world](double x, double z, double y) { return world.groundHeight(x, z, y); });
  RigState& st = state;
  st = RigState{};
  const double sp = p.speed();
  // skis on the feet or strapped to the back (setSkisOn), shown when owned; a gondola's rack takes them while riding
  rig.setCarry(p.hasSkis && !p.skisOn);
  bool skisShown = p.hasSkis && (p.mode != PlayerMode::Sit || skisInRide || sled);
  rig.setSkisVisible(skisShown);
  if (p.teleportCount != lastTeleport_) { lastTeleport_ = p.teleportCount; rig.snapPose(); }
  switch (p.mode) {
    case PlayerMode::Walk: st.mode = sp > 0.1 ? RigMode::Walk : RigMode::Idle; break;
    case PlayerMode::Ski: st.mode = RigMode::Ski; break;
    case PlayerMode::Fall: st.mode = RigMode::Fall; break;
    case PlayerMode::Sit: st.mode = RigMode::Sit; break;
  }
  st.heading = p.heading + (p.mode == PlayerMode::Ski ? p.yawFx : 0);
  st.crouch = three::clamp(p.crouch + p.absorb, -0.2, 1.1);
  st.lean = p.lean; st.hasEdge = true; st.edge = p.edge; st.tuck = p.tuck; st.plow = p.plow; st.skid = p.skidYaw;
  st.speed = sp;
  st.hasNormal = true;
  st.normal = p.air ? UP : normalize(V3(p.normal));
  st.air = p.air;
  st.flip = p.mode == PlayerMode::Ski ? p.flip : 0;
  st.hasFlipHeading = true; st.flipHeading = p.airTravel();
  // (no tricks in the port: the grab and the spin arms ease out as after a touchdown)
  grabVis_ = std::max(0.0, grabVis_ - dt / 0.12);
  spinVis_ *= std::exp(-dt * 12);
  st.grab = p.mode == PlayerMode::Ski ? grabVis_ : 0;
  st.spinVel = p.mode == PlayerMode::Ski ? spinVis_ : 0;
  st.charge = p.charging && !p.air ? p.charge : 0;
  const bool fp = p.view == Player::View::First && p.mode != PlayerMode::Fall;
  st.lookYaw = fp ? p.lookYaw() * 0.5 : 0;
  st.lookPitch = fp ? p.lookPitch() * 0.4 : 0;
  st.hasSeat = p.mode == PlayerMode::Sit;
  st.seat = V3(p.renderPos);
  if (p.mode == PlayerMode::Sit && sled) { st.hasSled = true; st.sled = sledShape; }
  st.carry = p.hasSkis && !p.skisOn;
  st.airY = p.mode == PlayerMode::Walk ? p.footJumpY : 0;
  st.fallT = p.fall.t / 0.6; st.fallSide = p.fallSide;
  st.hasFall = p.mode == PlayerMode::Fall;
  st.fall.ball = p.fall.ball; st.fall.getUp = p.fall.getUp; st.fall.pitch = p.fall.pitch; st.fall.roll = p.fall.roll;
  st.hasFallHeading = true; st.fallHeading = p.fall.axisHeading;
  st.fallAir = p.mode == PlayerMode::Fall && p.fallAir();
  st.fp = fp ? 1 : 0;
  rig.setHeadHidden(fp);
  // the pole plants the controller asked for (startPolePlant: the root is where the rig stood last frame)
  for (int8_t side : p.polePlants) {
    V3 fw(std::sin(p.heading), 0, std::cos(p.heading));
    rig.startPolePlant(side, fw, glm::cross(fw, UP));
  }
  p.polePlants.clear();
  if (showcase) {   // (showcase.js update: the athletic ski stance, skis on, no poles, looking about)
    showT_ += dt;
    RigState sc;
    sc.mode = RigMode::Ski; sc.heading = p.heading; sc.crouch = 0.15; sc.hasNormal = true; sc.normal = UP;
    sc.lookYaw = std::sin(showT_ * 0.35) * 0.25;
    st = sc;
    rig.setCarry(false);
    rig.setSkisVisible(p.hasSkis);
    rig.setHeadHidden(false);
  }
  rig.polesHidden = showcase;
  rig.rootPos = V3(p.renderPos);
  rig.update(dt, st);
  rig.writePose(pose_);
}

void PlayerSkier::submit(Renderer& r, bool hideBody) const {
  if (!rig.ready()) return;
  const dvec3 o(rig.rootPos);
  mat4 B = mat4(compose(V3(0), yaw(rig.rootHeading), V3(1)));
  const Model& body = dressed_ ? *dressed_ : *model_->body;
  if (!hideBody && rig.bodyVisible) r.submitModel(body, o, B, &pose_, true);
  if (!rig.gearVisible) return;
  if (rig.hasSkis())
    for (int s = 0; s < 2; s++) {
      if (!rig.skis[s].visible) continue;
      mat4 L = mat4(compose(rig.skis[s].p - V3(o), rig.skis[s].q, V3(1)) * gear_->skiFit);
      r.submitModel(*gear_->ski, o, L, nullptr, true);
    }
  if (rig.hasPoles() && !hideBody)
    for (int s = 0; s < 2; s++) {
      if (!rig.poles[s].visible) continue;
      mat4 L = mat4(compose(rig.poles[s].p - V3(o), rig.poles[s].q, V3(1)) * gear_->poleFit);
      r.submitModel(*gear_->pole, o, L, nullptr, true);
    }
}

void PlayerSkier::applyOutfit(gfx::Device& dev, const vec4& jacket, const vec4& trousers, const vec4& helmet) {
  // (the game's old call: base colours only) -> the catalogue item of that colour is not known here: the colours as a
  // look with the base as its own accent
  OutfitLook L;
  auto hex = [](const vec4& c) { return (uint32_t(std::lround(c.x * 255)) << 16) | (uint32_t(std::lround(c.y * 255)) << 8) | uint32_t(std::lround(c.z * 255)); };
  if (jacket.w > 0) { L.jacket = true; L.jBase = L.jAccent = hex(jacket); }
  if (trousers.w > 0) { L.trousers = true; L.tBase = L.tAccent = hex(trousers); }
  if (helmet.w > 0) { L.helmet = true; L.hColor = hex(helmet); }
  dev_ = &dev;
  if (L.key() == lookKey_) return;
  lookKey_ = L.key();
  for (auto& t : outfitTex_) dev.destroy(t);
  outfitTex_.clear();
  dressed_ = model_ ? dressModel(dev, *model_, L, outfitTex_) : nullptr;
}

void PlayerSkier::applyOutfitIds(gfx::Device& dev, const std::string& jacket, const std::string& trousers, const std::string& helmet, const std::string& lens) {
  OutfitLook L = outfitLookOf(jacket, trousers, helmet, lens);
  if (L.key() == lookKey_ && (dressed_ || !L.any())) return;
  lookKey_ = L.key();
  for (auto& t : outfitTex_) dev.destroy(t);
  outfitTex_.clear();
  dressed_ = model_ ? dressModel(dev, *model_, L, outfitTex_) : nullptr;
  if (model_ && L.any())
    SL_INFO("outfit: %s wears %s%s%s%s -> %s (zones: %s)", model_->name.c_str(), jacket.empty() ? "" : (jacket + " ").c_str(), trousers.empty() ? "" : (trousers + " ").c_str(),
            helmet.empty() ? "" : (helmet + " ").c_str(), lens.c_str(), dressed_ ? "baked" : "the original", outfitZonesInfo(*model_).c_str());
}

} // namespace sl
