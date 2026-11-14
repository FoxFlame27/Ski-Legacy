// `ski_legacy --verify-poses [ref.json]`: the skier rig against the JavaScript one. tools/ref_poses.mjs builds the
// game's SkierRig in Node (real three.js), replays timelines (standing, walking, running, carrying, skiing, carving
// with pole plants, tuck, snowplough, hockey stop, a jump, a flip with grabs, crashes, seated on a chair / bench / car
// seat / snowmobile) on a test plane and writes every frame's input with every bone's local rotation / position (and
// the skis' and poles' transforms) every 0.25 s. Here the same inputs go through the C++ rig; every bone is compared.
// Pass: under 1 degree everywhere, positions within 5 mm.
#include "player/skier_rig.h"
#include "player/fans_rig.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include <glm/gtc/type_ptr.hpp>
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
  double fpPosAll = 0, fpRotAll = 0, rootQAll = 0, carAll = 0;   // (first-person hands mm / deg, the root's rotation deg, car seats mm)
  int visMismatch = 0, modesAll = 0, scaleMismatch = 0, fpVisMismatch = 0;
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
    double fpPos = 0, fpRot = 0, rootQd = 0, carD = 0, topD = 0;
    bool fpT = false, carT = false;
    V3 eyeRig(0);
    int modeMismatch = 0;
    std::string worstWhere;
    for (size_t fi = 0; fi < frames.size() && si < samples.size(); fi++) {
      const auto& F = frames[fi];
      RigState st = stateOf(F["st"]);
      rig.rootPos = v3(F["pos"]);
      const bool hasCar = F.contains("car") && F["car"].is_object();
      const bool figure = hasCar && F["car"].value("kind", std::string()) == "figure";
      if (figure) rig.rootPos = V3(0);
      if (F.value("snap", false)) rig.snapPose();
      if (F.contains("plant") && F["plant"].is_array()) {
        V3 fw(std::sin(st.heading), 0, std::cos(st.heading)), r = glm::cross(fw, UP);
        for (auto& side : F["plant"]) rig.startPolePlant(side.get<int>(), fw, r);
      }
      rig.update(F["dt"].get<double>(), st);
      // the first-person view model after the camera (player.js: rig.updateFpView with fpViewState)
      if (F.contains("fpv") && F["fpv"].is_object()) {
        const auto& fv = F["fpv"];
        const auto& c = fv["cam"];
        SkierRig::FpViewState o;
        o.skiing = fv.value("skiing", false); o.air = fv.value("air", false);
        o.speed = fv.value("speed", 0.0); o.absorb = fv.value("absorb", 0.0); o.brake = fv.value("brake", 0.0); o.rough = fv.value("rough", 0.5);
        rig.updateFpView(F["dt"].get<double>(), V3(c[0].get<double>(), c[1].get<double>(), c[2].get<double>()),
                         Q(c[6].get<double>(), c[3].get<double>(), c[4].get<double>(), c[5].get<double>()), o, true);
        fpT = true;
      }
      // in a car: seatLegs (the taxi's fare, another player), placeRig (you at the wheel), the traffic's figures
      if (hasCar) {
        const auto& C = F["car"];
        carT = true;
        const CarTemplate tp = CarTemplate::of(carSeatsFor(C.value("model", std::string())), C.value("sizeY", 1.5));
        glm::dmat4 g(1);
        if (C.contains("g") && C["g"].is_array()) { double e[16]; for (int k = 0; k < 16; k++) e[k] = C["g"][size_t(k)].get<double>(); g = glm::make_mat4(e); }
        std::string kind = C.value("kind", std::string());
        if (kind == "legs") {
          SkierRig::SeatLegsOpt o;
          o.driver = C.value("driver", false); o.hands = C.value("hands", false);
          rig.seatLegs(&g, &tp, C.value("seat", 0), o);
        } else if (kind == "driver") {
          eyeRig = rig.placeDriver(g, tp, C.value("steer", 0.0), C.value("inside", false));
        } else if (figure && fi + 1 == frames.size()) {
          CarSeatRef cr;
          cr.how = CarSeatRef::Figure; cr.t = tp; cr.driver = C.value("driver", false); cr.look = C.value("look", 0); cr.seat = 0; cr.x = tp.S ? tp.S->d[0] : 0.36;
          rig.poseCarFigure(cr);
        }
      }
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
      // the head / arms folded away, the body's visibility, the root's rotation
      if (S.contains("scale")) {
        const int sb[3] = {M->b[RigModel::head], M->b[RigModel::lArm], M->b[RigModel::rArm]};
        for (int k = 0; k < 3; k++) {
          if (std::fabs(S["scale"][size_t(k)].get<double>() - rig.localScale(sb[k]).x) > 1e-6) scaleMismatch++;
        }
        if ((S.value("body", 1) != 0) != rig.bodyVisible) visMismatch++;
        const auto& rq = S["rootQ"];
        rootQd = std::max(rootQd, angleDeg(Q(rq[3].get<double>(), rq[0].get<double>(), rq[1].get<double>(), rq[2].get<double>()), rig.rootQuat()));
      }
      if (S.contains("fpv") && S["fpv"].is_object()) {
        const auto& fv = S["fpv"];
        if ((fv.value("vis", 0) != 0) != rig.fpView.visible) fpVisMismatch++;
        if (rig.fpView.visible && fv["hands"].is_array())
          for (size_t h = 0; h < 2 && h < fv["hands"].size(); h++) {
            const auto& a = fv["hands"][h];
            const SkierRig::FpHand& H = rig.fpView.hands[h];
            auto at = [&](int k) { return a[size_t(k)].get<double>(); };
            fpPos = std::max({fpPos, glm::length(V3(at(0), at(1), at(2)) - H.rootP) * 1000, glm::length(V3(at(7), at(8), at(9)) - H.cuffP) * 1000});
            fpRot = std::max({fpRot, angleDeg(Q(at(6), at(3), at(4), at(5)), H.rootQ), angleDeg(Q(at(13), at(10), at(11), at(12)), H.cuffQ)});
          }
      }
      if (S.contains("extra") && S["extra"].is_object()) {
        const auto& X = S["extra"];
        if (X.contains("eyeRig") && X["eyeRig"].is_array()) carD = std::max(carD, glm::length(v3(X["eyeRig"]) - eyeRig) * 1000);
        if (X.contains("O") && X["O"].is_array()) {
          const auto& C = F["car"];
          const CarTemplate tp = CarTemplate::of(carSeatsFor(C.value("model", std::string())), C.value("sizeY", 1.5));
          const bool drv = C.value("driver", false);
          topD = std::max(topD, std::fabs(X["top"].get<double>() - rig.carFig.top) * 1000);   // (the JS bakes a simplified mesh: its top)
          carD = std::max(carD, glm::length(v3(X["hip"]) - rig.carFig.hip) * 1000);
          for (size_t k = 0; k < X["O"].size() && tp.S; k++) {
            CarSeatRef cr;
            cr.how = CarSeatRef::Figure; cr.t = tp; cr.driver = drv; cr.look = C.value("look", 0);
            const int seats[4] = {0, 1, 2, 2};
            const double xs[4] = {tp.S->d[0], -tp.S->d[0], tp.S->r[0], -tp.S->r[0]};
            cr.seat = seats[k]; cr.x = xs[k];
            carD = std::max(carD, glm::length(v3(X["O"][k]) - rig.carFigureOrigin(cr)) * 1000);
          }
        }
      }
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
    if (fpT) SL_INFO("  %-16s first-person hands and poles max %.3f mm, %.3f deg", "", fpPos, fpRot);
    if (carT) SL_INFO("  %-16s in the car: root %.3f deg, eyes / figure placement %.2f mm (head top vs the baked mesh's %.1f mm)", "", rootQd, carD, topD);
    fpPosAll = std::max(fpPosAll, fpPos); fpRotAll = std::max(fpRotAll, fpRot); rootQAll = std::max(rootQAll, rootQd); carAll = std::max(carAll, carD);
    timingAll = std::max({timingAll, worstClip, worstW, worstBlend});
    modesAll += modeMismatch;
    worstAll = std::max(worstAll, worst); worstPosAll = std::max(worstPosAll, worstPos);
    worstGearAll = std::max(worstGearAll, worstGear); worstGearPosAll = std::max(worstGearPosAll, worstGearPos);
  }
  bool ok = worstAll < 1.0 && worstGearAll < 1.0 && worstPosAll < 5 && worstGearPosAll < 5 && visMismatch == 0 && timingAll < 1e-3 && modesAll == 0 &&
            scaleMismatch == 0 && fpVisMismatch == 0 && fpPosAll < 5 && fpRotAll < 1.0 && rootQAll < 1.0 && carAll < 5;
  SL_INFO("verify-poses: first person: hands / poles max %.3f mm, %.3f deg, %d view-model visibility and %d folded head / arm mismatches; "
          "in a car: the root max %.3f deg, eyes / figure placement max %.2f mm", fpPosAll, fpRotAll, fpVisMismatch, scaleMismatch, rootQAll, carAll);
  SL_INFO("verify-poses: bones max %.3f deg, %.2f mm; skis / poles max %.3f deg, %.2f mm; %d visibility mismatches; timing (clip times, blend "
          "weights, mode blends) max %.5f, %d mode mismatches -> %s", worstAll, worstPosAll, worstGearAll, worstGearPosAll, visMismatch, timingAll, modesAll, ok ? "PASS" : "FAIL");
  // the crowd people (player/fans_rig, world/fans.js): fans_ref.json beside the skier's reference
  const size_t slash = refPath.find_last_of("/\\");
  const int fansRc = verifyFans(assets, (slash == std::string::npos ? std::string() : refPath.substr(0, slash + 1)) + "fans_ref.json");
  SL_INFO("verify-poses: skier %s, crowd people %s", ok ? "PASS" : "FAIL", fansRc == 0 ? "PASS" : "FAIL");
  return ok && fansRc == 0 ? 0 : 1;
}

} // namespace sl
