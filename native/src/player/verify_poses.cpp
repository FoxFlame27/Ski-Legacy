// `ski_legacy --verify-poses [ref.json]`: the skier rig against the JavaScript one. tools/ref_poses.mjs builds the
// game's SkierRig in Node (real three.js), replays timelines (standing, walking, running, carrying, skiing, carving
// with pole plants, tuck, snowplough, hockey stop, a jump, a flip with grabs, crashes, seated on a chair / bench / car
// seat / snowmobile) on a test plane and writes every frame's input with every bone's local rotation / position (and
// the skis' and poles' transforms) every 0.25 s. Here the same inputs go through the C++ rig; every bone is compared.
// Pass: under 1 degree everywhere, positions within 5 mm.
#include "player/skier_rig.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <fstream>
#include <sstream>

namespace sl {
using namespace three;

namespace {
struct Mulberry {
  uint32_t s;
  double operator()() {
    s += 0x6d2b79f5u;
    uint32_t t = s;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return double(t ^ (t >> 14)) / 4294967296.0;
  }
};
V3 v3(const nlohmann::json& a) { return V3(a[0].get<double>(), a[1].get<double>(), a[2].get<double>()); }
RigState stateOf(const nlohmann::json& s) {
  RigState st;
  std::string m = s.value("mode", std::string("idle"));
  st.mode = m == "walk" ? RigMode::Walk : m == "ski" ? RigMode::Ski : m == "fall" ? RigMode::Fall : m == "sit" ? RigMode::Sit : RigMode::Idle;
  st.heading = s.value("heading", 0.0); st.speed = s.value("speed", 0.0); st.crouch = s.value("crouch", 0.0); st.lean = s.value("lean", 0.0);
  if (s.contains("edge")) { st.hasEdge = true; st.edge = s["edge"].get<double>(); }
  st.tuck = s.value("tuck", false); st.plow = s.value("plow", 0.0); st.skid = s.value("skid", 0.0);
  if (s.contains("normal") && s["normal"].is_array()) { st.hasNormal = true; st.normal = v3(s["normal"]); }
  st.air = s.value("air", false); st.flip = s.value("flip", 0.0);
  if (s.contains("flipHeading")) { st.hasFlipHeading = true; st.flipHeading = s["flipHeading"].get<double>(); }
  st.grab = s.value("grab", 0.0);
  std::string gt = s.value("grabType", std::string());
  st.grabType = gt == "mute" ? GrabType::Mute : gt == "safety" ? GrabType::Safety : gt == "japan" ? GrabType::Japan : GrabType::None;
  st.spinVel = s.value("spinVel", 0.0); st.charge = s.value("charge", 0.0);
  if (s.contains("fall") && s["fall"].is_object()) {
    st.hasFall = true;
    auto& f = s["fall"];
    st.fall.ball = f.value("ball", 0.0); st.fall.getUp = f.value("getUp", 0.0); st.fall.pitch = f.value("pitch", 0.0); st.fall.roll = f.value("roll", 0.0);
  }
  st.fallSide = s.value("fallSide", 1);
  if (s.contains("fallHeading")) { st.hasFallHeading = true; st.fallHeading = s["fallHeading"].get<double>(); }
  st.fallAir = s.value("fallAir", false); st.fallT = s.value("fallT", 0.0); st.flail = s.value("flail", 0.0);
  st.lookYaw = s.value("lookYaw", 0.0); st.lookPitch = s.value("lookPitch", 0.0);
  if (s.contains("seat") && s["seat"].is_array()) { st.hasSeat = true; st.seat = v3(s["seat"]); }
  if (s.contains("bench") && s["bench"].is_object()) {
    st.hasBench = true;
    auto& b = s["bench"];
    auto num = [&](const char* k) { return b.contains(k) && b[k].is_number() ? b[k].get<double>() : std::nan(""); };
    st.bench.back = num("back"); st.bench.front = num("front"); st.bench.floorY = num("floorY");
    st.bench.recline = b.value("recline", 0.0); st.bench.legsOut = b.value("legs", std::string()) == "out";
  }
  if (s.contains("sled") && s["sled"].is_object()) {
    st.hasSled = true;
    auto& d = s["sled"];
    auto xyz = [](const nlohmann::json& o) { return V3(o.value("x", 0.0), o.value("y", 0.0), o.value("z", 0.0)); };
    st.sled.grip = xyz(d["grip"]); st.sled.foot = xyz(d["foot"]); st.sled.pivot = d.value("pivot", 0.0); st.sled.turn = d.value("turn", 0.0); st.sled.steer = d.value("steer", 0.0);
  }
  st.carry = s.value("carry", false); st.airY = s.value("airY", 0.0);
  if (s.contains("fp")) st.fp = s["fp"].get<bool>() ? 1 : 0;
  return st;
}
} // namespace

int verifyPoses(AssetManager& assets, const std::string& refPath) {
  std::ifstream f(refPath, std::ios::binary);
  if (!f) { SL_ERROR("verify-poses: no reference %s (run: node native/tools/ref_poses.mjs)", refPath.c_str()); return 2; }
  std::stringstream ss;
  ss << f.rdbuf();
  auto J = nlohmann::json::parse(ss.str(), nullptr, false);
  if (J.is_discarded()) { SL_ERROR("verify-poses: bad JSON"); return 2; }
  const double ga = J["ground"]["a"].get<double>(), gb = J["ground"]["b"].get<double>(), gc = J["ground"]["c"].get<double>();
  SkierRig::Ground ground = [=](double x, double z, double) { return ga * x + gb * z + gc; };
  std::string ch = J.value("char", std::string("skier_red"));
  Mulberry first{12345};
  // (the first rig of a model measures it: the JS's first constructor ran with the same random sequence)
  ModelLoadOptions oc;
  oc.maxTextureSize = 64;
  oc.keepCpu = true;
  auto body = assets.loadFile(assets.modelPath(ch + "_rigged"), ch + "_rigged#verify", oc);
  auto anims = assets.model(ch + "_anims", ModelLoadOptions{});
  auto M = std::make_shared<RigModel>();
  if (!body || !M->build(body, anims.get(), [&](double x, double z, double y) { return ground(x, z, y); }, [&]() { return first(); })) {
    SL_ERROR("verify-poses: %s could not be built", ch.c_str());
    return 2;
  }
  auto G = rigGear(assets, "ski_rental", true);
  std::vector<int> nodeOf;
  for (auto& n : J["bones"]) nodeOf.push_back(M->body->findNode(n.get<std::string>()));
  double worstAll = 0, worstPosAll = 0, worstGearAll = 0, worstGearPosAll = 0;
  int visMismatch = 0, modesAll = 0;
  double timingAll = 0;
  SL_INFO("verify-poses: %s, %zu bones, %zu timelines (reference %s)", ch.c_str(), nodeOf.size(), J["timelines"].size(), refPath.c_str());
  for (auto& T : J["timelines"]) {
    Mulberry rnd{12345};
    SkierRig rig;
    rig.random = [&]() { return rnd(); };
    rig.init(M, G, true, true, ground);
    rig.setPhases(0.3, 10, 4.5, 7);
    rnd.s = 777;
    rig.setSkisVisible(true);
    rig.setCarry(T.value("carry", false));
    const auto& frames = T["frames"];
    const auto& samples = T["samples"];
    size_t si = 0;
    double worst = 0, worstPos = 0, worstGear = 0, worstGearPos = 0, worstClip = 0, worstW = 0, worstBlend = 0;
    int modeMismatch = 0;
    std::string worstWhere;
    for (size_t fi = 0; fi < frames.size() && si < samples.size(); fi++) {
      const auto& F = frames[fi];
      RigState st = stateOf(F["st"]);
      rig.rootPos = v3(F["pos"]);
      if (F.contains("plant") && F["plant"].is_array()) {
        V3 fw(std::sin(st.heading), 0, std::cos(st.heading)), r = glm::cross(fw, UP);
        for (auto& side : F["plant"]) rig.startPolePlant(side.get<int>(), fw, r);
      }
      rig.update(F["dt"].get<double>(), st);
      const auto& S = samples[si];
      if (S["frame"].get<size_t>() != fi) continue;
      si++;
      double tSec = double(fi + 1) * F["dt"].get<double>();
      for (size_t b = 0; b < nodeOf.size(); b++) {
        int n = nodeOf[b];
        if (n < 0) continue;
        const auto& q = S["q"][b];
        Q jq(q[3].get<double>(), q[0].get<double>(), q[1].get<double>(), q[2].get<double>());
        double a = angleDeg(jq, rig.localR(n));
        if (a > worst) { worst = a; char buf[128]; std::snprintf(buf, sizeof buf, "%s at %.2f s", M->body->nodes[size_t(n)].name.c_str(), tSec); worstWhere = buf; }
        V3 jp = v3(S["p"][b]);
        worstPos = std::max(worstPos, glm::length(jp - rig.localT(n)) * 10);   // (cm under the armature: mm)
      }
      if (S.contains("clips") && S["clips"].is_array())
        for (int k = 0; k < 3; k++) {
          const auto& c = S["clips"][size_t(k)];
          if (!c.is_array()) continue;
          double dtc = std::fabs(c[0].get<double>() - rig.clipTime(k)), dw = std::fabs(c[1].get<double>() - rig.clipWeight(k));
          worstClip = std::max(worstClip, dtc); worstW = std::max(worstW, dw);
        }
      if (S.value("mode", std::string()) != rig.modeName()) modeMismatch++;
      worstBlend = std::max(worstBlend, std::fabs(S.value("blend", 1.0) - rig.blendT()));
      V3 root = v3(S["root"]);
      worstPos = std::max(worstPos, glm::length(root - rig.rootPos) * 1000);
      for (int g = 0; g < 4; g++) {
        const auto& R = S["gear"][size_t(g)];
        const SkierRig::GearObj& o = g < 2 ? rig.skis[g] : rig.poles[g - 2];
        bool vis = o.visible && rig.gearVisible;
        if (vis != (R[7].get<int>() != 0)) visMismatch++;
        if (!vis) continue;
        V3 p(R[0].get<double>(), R[1].get<double>(), R[2].get<double>());
        Q q(R[6].get<double>(), R[3].get<double>(), R[4].get<double>(), R[5].get<double>());
        worstGearPos = std::max(worstGearPos, glm::length(p - (o.p - rig.rootPos)) * 1000);
        worstGear = std::max(worstGear, angleDeg(q, o.q));
      }
    }
    SL_INFO("  %-16s bones max %6.3f deg (%s), pos %6.2f mm | skis/poles %6.3f deg %6.2f mm | clip time %.4f s, weight %.4f, blend %.4f, mode %s",
            T["name"].get<std::string>().c_str(), worst, worstWhere.c_str(), worstPos, worstGear, worstGearPos, worstClip, worstW, worstBlend, modeMismatch ? "MISMATCH" : "ok");
    timingAll = std::max({timingAll, worstClip, worstW, worstBlend});
    modesAll += modeMismatch;
    worstAll = std::max(worstAll, worst); worstPosAll = std::max(worstPosAll, worstPos);
    worstGearAll = std::max(worstGearAll, worstGear); worstGearPosAll = std::max(worstGearPosAll, worstGearPos);
  }
  bool ok = worstAll < 1.0 && worstGearAll < 1.0 && worstPosAll < 5 && worstGearPosAll < 5 && visMismatch == 0 && timingAll < 1e-3 && modesAll == 0;
  SL_INFO("verify-poses: bones max %.3f deg, %.2f mm; skis / poles max %.3f deg, %.2f mm; %d visibility mismatches; timing (clip times, blend "
          "weights, mode blends) max %.5f, %d mode mismatches -> %s", worstAll, worstPosAll, worstGearAll, worstGearPosAll, visMismatch, timingAll, modesAll, ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}

} // namespace sl
