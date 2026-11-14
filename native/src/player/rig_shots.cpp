// `ski_legacy --rig-shots out.png`: the characters on their own (no world), for checking them by eye: your skier
// through the skier rig's poses (standing, walking, running, carving, the tuck, a snowplough, in the air, crashed,
// seated on a chair / a bench / a snowmobile), the outfit bake, and every other character (the six skiers, the eight
// townsfolk, the police officer) standing, walking and skiing, posed by their own rigs. Writes out_<name>.png.
#include "player/skier_rig.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "engine/renderer.h"
#include "game/people.h"
#include "player/outfits.h"
#include "platform/platform.h"
#include <stb_image_write.h>
#include <cstring>

namespace sl {
using namespace three;

int rigShots(platform::Platform& plat, gfx::Device& dev, Renderer& renderer, AssetManager& assets, const std::string& png) {
  auto ground = [](double, double, double) { return 0.0; };
  // a snowy floor
  Geo g = boxGeo(60, 0.2f, 60);
  g.translate(0, -0.1f, 0);
  g.col.assign(g.pos.size(), vec3(0.86f, 0.89f, 0.95f));
  Material fm; fm.metallic = 0; fm.roughness = 0.9f; fm.vertexColor = true;
  auto floor = buildModel(dev, {{std::move(g), fm}}, "floor");
  auto shot = [&](const std::string& tag, const dvec3& eye, const dvec3& at, const std::function<void(Renderer&)>& draw) {
    int dw, dh;
    plat.drawableSize(dw, dh);
    renderer.resize(dw, dh);
    Camera cam;
    cam.lookAt(eye, at);
    cam.fovY = 40; cam.nearZ = 0.05f; cam.aspect = float(dw) / float(std::max(1, dh));
    Lighting L;
    renderer.beginFrame(cam, L, at);
    renderer.submitModel(*floor, dvec3(0), mat4(1), nullptr, false);
    draw(renderer);
    renderer.endFrame();
    std::vector<uint8_t> px;
    renderer.readPixels(px);
    std::vector<uint8_t> fl(px.size());
    for (int y = 0; y < dh; y++) std::memcpy(&fl[size_t(y) * dw * 4], &px[size_t(dh - 1 - y) * dw * 4], size_t(dw) * 4);
    size_t dot = png.rfind('.');
    std::string out = (dot == std::string::npos ? png : png.substr(0, dot)) + "_" + tag + ".png";
    if (stbi_write_png(out.c_str(), dw, dh, 4, fl.data(), dw * 4)) SL_INFO("rig-shots: wrote %s", out.c_str());
    plat.swapBuffers();
  };
  // ---- your skier through the poses
  for (const char* ch : {"skier_red", "skier_blue"}) {
    auto M = rigModel(assets, ch, ground);
    auto G = rigGear(assets, "ski_rental", true);
    if (!M) continue;
    PeopleKind K;
    K.rig = M; K.draw = M->body;
    struct P { const char* name; RigState st; bool carry; double secs; double speed; };
    std::vector<P> poses;
    auto mk = [&](const char* n, RigMode m, double speed, bool carry, double secs, std::function<void(RigState&)> f = nullptr) {
      P p; p.name = n; p.st.mode = m; p.st.speed = speed; p.carry = carry; p.secs = secs; p.speed = speed;
      if (f) f(p.st);
      poses.push_back(p);
    };
    mk("idle", RigMode::Idle, 0, true, 3);
    mk("walk", RigMode::Walk, 1.4, true, 1.3);
    mk("run", RigMode::Walk, 4, true, 1.1);
    mk("ski", RigMode::Ski, 10, false, 1, [](RigState& s) { s.crouch = 0.2; s.hasEdge = true; });
    mk("carve", RigMode::Ski, 15, false, 1.2, [](RigState& s) { s.crouch = 0.28; s.hasEdge = true; s.edge = 0.8; s.lean = 1; });
    mk("tuck", RigMode::Ski, 22, false, 1.2, [](RigState& s) { s.crouch = 0.21; s.tuck = true; s.hasEdge = true; });
    mk("plow", RigMode::Ski, 4, false, 1.2, [](RigState& s) { s.crouch = 0.3; s.plow = 1; s.hasEdge = true; });
    mk("crash", RigMode::Fall, 0, false, 2, [](RigState& s) { s.hasFall = true; s.fall.roll = PI / 2; s.fallSide = 1; });
    mk("chair", RigMode::Sit, 0, false, 1, [](RigState& s) { s.hasSeat = true; s.seat = V3(1.6 * 3.5, 1.4, 0); });
    mk("bench", RigMode::Sit, 0, false, 1, [](RigState& s) { s.hasSeat = true; s.seat = V3(1.6 * 4.5, 0.48, 0); s.hasBench = true; s.bench.back = -0.3; s.bench.front = 0.26; s.bench.floorY = 0; s.bench.recline = 0.15; });
    mk("sled", RigMode::Sit, 0, true, 1, [](RigState& s) { s.hasSeat = true; s.seat = V3(1.6 * 5.5, 0.75, 0); s.hasSled = true; s.sled.grip = V3(0.32, 0.3, 0.62); s.sled.foot = V3(0.24, -0.42, 0.22); s.sled.pivot = 0.55; s.sled.turn = 0.45; s.sled.steer = 0.4; });
    std::vector<RigInst> R(poses.size());
    for (size_t i = 0; i < poses.size(); i++) {
      R[i].rig.init(M, G, true, true, ground);
      R[i].rig.setSkisVisible(true);
      R[i].rig.setCarry(poses[i].carry);
      double x = (double(i) - double(poses.size() - 1) / 2) * 1.6;
      RigState st = poses[i].st;
      st.heading = 0.5;
      int n = int(poses[i].secs * 60);
      for (int f = 0; f < n; f++) {
        V3 fw(std::sin(st.heading), 0, std::cos(st.heading));
        // (walking / skiing: moving along the heading, then placed back at its spot for the picture)
        R[i].rig.rootPos = st.hasSeat ? st.seat : V3(x, 0, 0) + fw * (poses[i].speed * f / 60.0 - poses[i].speed * n / 60.0);
        R[i].rig.update(1 / 60.0, st);
      }
      R[i].pose_();
    }
    shot(std::string(ch) + "_poses", dvec3(0, 2.2, 13), dvec3(0, 0.8, 0), [&](Renderer& r) { for (auto& x : R) drawRig(r, x, K, G.get(), 1, true); });
    for (size_t i = 0; i < poses.size(); i++) {
      dvec3 c(R[i].rig.rootPos);
      shot(std::string(ch) + "_" + poses[i].name, c + dvec3(2.6, 1.5, 3.2), c + dvec3(0, 0.85, 0), [&](Renderer& r) { drawRig(r, R[i], K, G.get(), 1, true); });
    }
    // the outfit of the autotest (and a full kit)
    for (int look = 0; look < 2; look++) {
      std::vector<gfx::Texture> tex;
      OutfitLook Lk = look == 0 ? outfitLookOf("j_sunset", "t_navy", "", "") : outfitLookOf("kit_gold.jacket", "kit_gold.trousers", "kit_gold.helmet", "kit_gold.lens");
      auto dressed = dressModel(dev, *M, Lk, tex);
      PeopleKind D = K;
      if (dressed) D.draw = dressed;
      // (the poses must outlive the frame: the renderer keeps pointers to their joints until endFrame)
      RigInst x, y;
      x.rig.init(M, G, true, true, ground);
      x.rig.setCarry(true);
      for (int f = 0; f < 120; f++) { RigState st; st.mode = RigMode::Idle; st.heading = 0.3; x.rig.update(1 / 60.0, st); }
      x.pose_();
      y.rig.init(M, G, true, true, ground);
      y.rig.setCarry(true);
      y.rig.setSkisVisible(false);
      for (int f = 0; f < 120; f++) { RigState st; st.mode = RigMode::Idle; st.heading = 0.3 + PI; y.rig.rootPos = V3(1.4, 0, -0.6); y.rig.update(1 / 60.0, st); }
      y.pose_();
      shot(std::string(ch) + (look == 0 ? "_outfit" : "_kit"), dvec3(1.2, 1.4, 3.4), dvec3(0.5, 0.95, 0), [&](Renderer& r) {
        drawRig(r, x, D, G.get(), 1, true);
        drawRig(r, y, D, G.get(), 1, true);
      });
      for (auto& t : tex) dev.destroy(t);
    }
  }
  // ---- everyone else
  {
    const char* names[] = {"skier_blue", "skier_red", "skier_green", "skier_orange", "skier_black", "skier_purple", "fan_man", "fan_woman", "fan_elder", "fan_girl", "fan_kid", "fan_lady", "fan_teen", "fan_skier", "police_officer"};
    auto G = rigGear(assets, "ski_rental", false);
    std::vector<RigInst> R;
    std::vector<PeopleKind> Ks;
    for (int row = 0; row < 3; row++)
      for (int i = 0; i < 15; i++) {
        std::string n = names[i];
        bool fan = n.rfind("fan_", 0) == 0;
        auto M = rigModel(assets, n, ground, fan ? n : std::string(), fan ? std::string() : std::string("-"));
        if (!M) continue;
        PeopleKind K;
        K.rig = M;
        auto d = std::make_shared<Model>(*M->body);
        for (Mesh& m : d->meshes) if (m.primitives.size() > 1) m.primitives.resize(1);
        K.draw = d;
        RigInst x;
        x.rig.init(M, G, true, false, ground);
        bool ski = row == 2 && !fan;
        x.rig.setSkisVisible(ski);
        RigState st;
        st.mode = row == 0 ? RigMode::Idle : row == 1 ? RigMode::Walk : (ski ? RigMode::Ski : RigMode::Walk);
        st.speed = row == 0 ? 0 : row == 1 ? 1.3 : ski ? 9 : 3.5;
        st.lean = ski ? 0.5 : 0; st.crouch = ski ? 0.42 : 0;
        st.heading = 0.4;
        double x0 = (i - 7) * 1.2, z0 = -row * 2.5;
        for (int f = 0; f < 90; f++) {
          V3 fw(std::sin(st.heading), 0, std::cos(st.heading));
          x.rig.rootPos = V3(x0, 0, z0) + fw * (st.speed * (f - 90) / 60.0);
          x.rig.update(1 / 60.0, st);
        }
        x.pose_();
        R.push_back(std::move(x));
        Ks.push_back(K);
      }
    shot("everyone", dvec3(0, 3.5, 14), dvec3(0, 0.6, -2.5), [&](Renderer& r) { for (size_t i = 0; i < R.size(); i++) drawRig(r, R[i], Ks[i], G.get(), 1, true); });
    shot("everyone_near", dvec3(-4, 1.6, 4.2), dvec3(-4, 0.9, 0), [&](Renderer& r) { for (size_t i = 0; i < R.size(); i++) drawRig(r, R[i], Ks[i], G.get(), 1, true); });
    shot("everyone_near2", dvec3(4.5, 1.6, 4.2), dvec3(4.5, 0.9, 0), [&](Renderer& r) { for (size_t i = 0; i < R.size(); i++) drawRig(r, R[i], Ks[i], G.get(), 1, true); });
  }
  return 0;
}

} // namespace sl
