#include "game/game.h"

#include "core/assets_path.h"
#include "core/input.h"
#include "core/jobs.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/audio.h"
#include "engine/quality.h"
#include "engine/renderer.h"
#include "gfx/gfx.h"
#include "platform/platform.h"
#include "player/player.h"
#include "player/skier_rig.h"
#include "world/scenery.h"
#include "world/terrain.h"
#include "world/world.h"

#include <nlohmann/json.hpp>
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <algorithm>

namespace sl {

namespace {
constexpr double STEP = 1.0 / 120.0;   // simulation tick (player.js SUBSTEP)
constexpr double ALT0 = 1245;          // village altitude above sea level (signs)

struct Piste { std::string name; int diff = 0; std::string peak; std::vector<dvec2> pts; };

std::vector<Piste> loadPistes(platform::Platform& p, const AssetPaths& paths) {
  std::vector<Piste> out;
  std::vector<uint8_t> b;
  if (!p.readFile(paths.data("world.json"), b)) return out;
  auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
  if (j.is_discarded()) return out;
  for (auto& q : j["layout"]["pistes"]) {
    Piste ps;
    ps.name = q["name"]; ps.diff = q["diff"];
    ps.peak = q["peak"].is_string() ? q["peak"].get<std::string>() : "";
    for (auto& pt : q["pts"]) ps.pts.push_back(dvec2(pt[0].get<double>(), pt[1].get<double>()));
    out.push_back(std::move(ps));
  }
  return out;
}

const char* padLabel(platform::PadFamily f, int button) {
  static const char* xbox[] = {"A", "B", "X", "Y", "LB", "RB", "LT", "RT", "VIEW", "MENU", "LS", "RS", "UP", "DOWN", "LEFT", "RIGHT", "XBOX"};
  static const char* ps[] = {"CROSS", "CIRCLE", "SQUARE", "TRIANGLE", "L1", "R1", "L2", "R2", "SHARE", "OPTIONS", "L3", "R3", "UP", "DOWN", "LEFT", "RIGHT", "PS"};
  static const char* sw[] = {"B", "A", "Y", "X", "L", "R", "ZL", "ZR", "-", "+", "LS", "RS", "UP", "DOWN", "LEFT", "RIGHT", "HOME"};
  if (button < 0 || button > 16) return "?";
  return f == platform::PadFamily::PlayStation ? ps[button] : f == platform::PadFamily::Switch ? sw[button] : xbox[button];
}

int verifyHeights(platform::Platform& p, const AssetPaths& paths, World& world) {
  std::vector<uint8_t> b;
  if (!p.readFile(paths.data("world.json"), b)) return 2;
  auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
  double e[6] = {0};
  const char* names[6] = {"baseHeight(spacing 0)", "baseHeight(spacing 8)", "baseHeight(spacing 64)", "height", "meshHeight", "forest"};
  for (auto& r : j["refs"]) {
    double x = r[0], z = r[1];
    double h = world.height(x, z);
    double slope = std::hypot(world.height(x + 1, z) - h, world.height(x, z + 1) - h);
    double v[6] = {world.baseHeight(x, z, 0), world.baseHeight(x, z, 8), world.baseHeight(x, z, 64), h, world.meshHeight(x, z), world.forest(x, z, h, slope)};
    for (int k = 0; k < 6; k++) e[k] = std::max(e[k], std::fabs(v[k] - r[2 + k].get<double>()));
  }
  SL_INFO("verify-heights: %zu reference points from the JavaScript world", j["refs"].size());
  for (int k = 0; k < 6; k++) SL_INFO("  max |C++ - JS| %-24s %.4f %s", names[k], e[k], k == 5 ? "" : "m");
  bool ok = e[0] < 0.05 && e[3] < 0.25;
  SL_INFO("verify-heights: %s", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
} // namespace

int runGame(const GameOptions& opt) {
  auto plat = platform::createPlatform();
  AssetPaths paths;
  if (!paths.init(*plat)) return 2;
  SL_INFO("assets: %s | data: %s", paths.publicRoot.c_str(), paths.dataRoot.c_str());

  World world;
  world.load(*plat, paths);
  if (opt.verifyHeights) return verifyHeights(*plat, paths, world);

  Quality q = Quality::preset(opt.quality);
  platform::WindowDesc wd;
  wd.width = opt.width; wd.height = opt.height; wd.fullscreen = opt.fullscreen; wd.vsync = opt.vsync && !opt.autotest;
  if (!plat->createWindow(wd)) return 3;
  static platform::Platform* sPlat = plat.get();
  auto dev = gfx::createGLDevice([](const char* n) { return sPlat->glProcAddress(n); });
  if (!dev) return 3;
  SL_INFO("gfx: %s %s | %s", dev->info().api.c_str(), dev->info().version.c_str(), dev->info().renderer.c_str());

  double t0 = plat->timeSeconds();
  JobSystem jobs;
  AssetManager assets(*plat, *dev, paths);
  Renderer renderer;
  RenderSettings rs;
  rs.shadowSize = q.shadowSize; rs.shadowRange = q.shadowRange; rs.renderScale = q.renderScale;
  if (!renderer.init(*dev, rs)) { SL_ERROR("renderer init failed"); return 4; }
  int dw, dh;
  plat->drawableSize(dw, dh);
  renderer.resize(dw, dh);

  Input input;
  if (!opt.bindings.empty()) {
    std::vector<uint8_t> b;
    if (plat->readFile(opt.bindings, b)) {
      auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
      if (!j.is_discarded()) input.applyBindings(j.contains("binds") ? j["binds"] : j);
    }
  }

  Terrain terrain(*dev, world, jobs, q.terrainLodK);
  VegetationSettings vs{q.treeNear, q.treeMid, q.treeFar};
  Scenery scenery(*dev, world, jobs, assets, vs);
  scenery.loadVillage(*plat, paths);
  Player player(world, &scenery);
  SkierRig rig;
  if (!rig.load(assets)) SL_WARN("skier model missing: the player is invisible");
  Audio audio;
  if (!opt.autotest) audio.start(*plat);

  // spawn: the village plaza (main.js), or the top of a run on the Legacy face
  std::vector<Piste> pistes = loadPistes(*plat, paths);
  const Piste* run = nullptr;
  for (auto& ps : pistes) if (ps.peak == "legacy" && ps.pts.size() > 20) { run = &ps; break; }
  if (!run && !pistes.empty()) run = &pistes[0];
  bool onPiste = (opt.spawn == "piste" || (opt.autotest && opt.spawn.empty())) && run;
  if (onPiste) {
    dvec2 a = run->pts[3], b = run->pts[8];
    player.teleport(a.x, a.y, std::atan2(b.x - a.x, b.y - a.y));
    player.setSkisOn(true);
    SL_INFO("spawn: top of %s (%.0f, %.0f), %.0f m", run->name.c_str(), a.x, a.y, player.pos.y + ALT0);
  } else player.teleport(4, 34, PI);

  Camera cam;
  cam.farZ = 30000;
  Lighting light;
  light.toneMap = opt.toneMap;
  player.frameUpdate(0.016, 1, {}, {});
  player.cameraFor(cam);
  terrain.finish(cam.pos);
  scenery.finish(cam.pos);
  SL_INFO("world ready in %.2f s: %zu terrain nodes, %zu trees in range, %.0f MB textures", plat->timeSeconds() - t0,
          terrain.nodeCount(), scenery.treesDrawn(), assets.textureBytes() / 1048576.0);

  // profiling toggles: SKI_LEGACY_DEBUG=noterrain,notrees,novillage,noskier
  std::string dbg = std::getenv("SKI_LEGACY_DEBUG") ? std::getenv("SKI_LEGACY_DEBUG") : "";
  auto off = [&](const char* k) { return dbg.find(k) != std::string::npos; };
  bool drawTerrain = !off("noterrain"), drawTrees = !off("notrees"), drawVillage = !off("novillage"), drawSkier = !off("noskier");
  bool running = true, paused = false;
  double acc = 0, last = plat->timeSeconds(), fpsT = 0, fps = 0, simTime = 0;
  int fpsN = 0, frame = 0;
  double startT = plat->timeSeconds(), hintUntil = 12;
  std::string toast;
  double toastUntil = 0;
  int nCrash = 0, nLand = 0;
  double maxSpeed = 0;
  dvec3 startPos = player.pos;
  PlayerControls ctl;

  while (running) {
    platform::Events ev;
    plat->pollEvents(ev);
    if (ev.quit) running = false;
    if (ev.resized) { plat->drawableSize(dw, dh); renderer.resize(dw, dh); }
    if (ev.focusLost) { input.clear(); plat->setRelativeMouse(false); }
    input.update(*plat, ev);
    double now = plat->timeSeconds();
    double frameDt = opt.autotest ? 1.0 / 60.0 : std::min(0.25, now - last);
    last = now;

    if (input.takePressed(Action::Pause)) {
      paused = !paused;
      plat->setRelativeMouse(!paused);
    }

    // autotest pilot: tuck down the run, steering toward a point 35 m ahead on its line
    if (opt.autotest && run && onPiste) {
      size_t best = 0;
      double bd = 1e18;
      for (size_t i = 0; i < run->pts.size(); i++) {
        double d = glm::length(run->pts[i] - dvec2(player.pos.x, player.pos.z));
        if (d < bd) { bd = d; best = i; }
      }
      size_t k = best;
      double along = 0;
      while (k + 1 < run->pts.size() && along < 35) { along += glm::length(run->pts[k + 1] - run->pts[k]); k++; }
      dvec2 tgt = run->pts[k];
      double want = std::atan2(tgt.x - player.pos.x, tgt.y - player.pos.z);
      double err = wrapPi(want - player.heading);
      float steer = float(clamp(err * 2.5, -1, 1));
      double sp = player.speed();
      input.inject(Action::Forward, sp < 20);
      input.inject(Action::Back, sp > 27);
      input.injectMove(-steer, sp < 20 ? 1.f : 0.f);
      // a charged jump half way: crouch for 0.4 s, release to pop (exercises take-off, air and landing)
      int jf = opt.frames / 2;
      input.inject(Action::Jump, frame >= jf && frame < jf + 24);
    }

    // fixed-step simulation (edge-triggered inputs are seen by the first tick of the frame)
    if (!paused) acc += frameDt;
    bool first = true;
    while (acc >= STEP) {
      ctl.steer = -input.moveX();
      ctl.front = input.down(Action::Forward) || input.moveY() > 0.5f;
      ctl.back = input.down(Action::Back) || input.down(Action::Brake) || input.moveY() < -0.5f;
      ctl.grab = input.down(Action::Sprint);
      ctl.sprint = input.down(Action::Sprint);
      ctl.moveX = input.moveX(); ctl.moveY = input.moveY();
      ctl.jumpDown = input.down(Action::Jump);
      ctl.jumpPressed = first && input.takePressed(Action::Jump);
      ctl.jumpReleased = first && input.takeReleased(Action::Jump);
      player.fixedUpdate(STEP, ctl);
      acc -= STEP;
      simTime += STEP;
      first = false;
    }
    PlayerFrameControls fc;
    fc.toggleView = input.takePressed(Action::View);
    fc.toggleSkis = input.takePressed(Action::Skis);
    fc.lookX = paused ? 0 : input.lookX(); fc.lookY = paused ? 0 : input.lookY(); fc.wheel = input.wheel();
    fc.now = opt.autotest ? simTime : now; fc.lastLook = opt.autotest ? -1e9 : input.lastLookTime();
    player.frameUpdate(frameDt, acc / STEP, fc, ctl);

    for (const PlayerEvent& e : player.events) {
      switch (e.type) {
        case PlayerEvent::Type::Crash: nCrash++; audio.thud(1); input.rumble(*plat, 0.9f * e.amount, 0.6f * e.amount, 400); toast = "WIPEOUT"; toastUntil = simTime + 2; break;
        case PlayerEvent::Type::Bump: audio.thud(e.amount * 0.6f); input.rumble(*plat, 0.4f * e.amount, 0.3f, 150); break;
        case PlayerEvent::Type::Land: nLand++; if (opt.autotest) SL_INFO("[autotest] landing (impact %.2f)", e.amount); audio.thud(e.amount * 0.7f); input.rumble(*plat, 0.3f + 0.6f * e.amount, 0.2f, 120); break;
        case PlayerEvent::Type::Pop: if (opt.autotest) SL_INFO("[autotest] pop (charge %.2f) at %.1f km/h", e.amount, player.speed() * 3.6); input.rumble(*plat, 0.1f, 0.2f + 0.4f * e.amount, 60); break;
        case PlayerEvent::Type::TooSteep: toast = "Too steep to walk up - take a lift"; toastUntil = simTime + 2.5; break;
        case PlayerEvent::Type::SkisOn: toast = "Skis on"; toastUntil = simTime + 1.2; break;
        case PlayerEvent::Type::SkisOff: toast = "Skis off"; toastUntil = simTime + 1.2; break;
        default: break;
      }
    }
    player.events.clear();
    maxSpeed = std::max(maxSpeed, player.speed());
    audio.setSki(float(player.speed()), float(std::fabs(player.edge)), float(player.sideslip), player.air, player.mode == PlayerMode::Ski);

    // streaming + animation
    player.cameraFor(cam);
    terrain.update(cam.pos);
    scenery.update(cam.pos);
    rig.update(frameDt, player, world);

    // render
    renderer.beginFrame(cam, light, player.renderPos);
    if (drawTerrain) terrain.submit(renderer);
    scenery.submit(renderer, drawTrees, drawVillage);
    if (drawSkier) rig.submit(renderer, player.view == Player::View::First && player.mode != PlayerMode::Fall);

    // HUD
    {
      float W = float(renderer.width()), H = float(renderer.height()), s = std::max(1.f, H / 360.f);
      char buf[256];
      double kmh = player.speed() * 3.6;
      std::snprintf(buf, sizeof buf, "%3.0f km/h", kmh);
      renderer.hudRect(12 * s, H - 46 * s, 150 * s, 36 * s, vec4(0, 0, 0, 0.35f));
      renderer.hudText(18 * s, H - 42 * s, 2.6f * s, vec4(1), buf);
      std::snprintf(buf, sizeof buf, "%s  %4.0f m", player.modeName(), player.pos.y + ALT0);
      renderer.hudText(18 * s, H - 19 * s, 1.0f * s, vec4(0.85f, 0.92f, 1, 1), buf);
      std::snprintf(buf, sizeof buf, "%.0f fps  %u draws", fps, renderer.drawCalls());
      renderer.hudText(W - Renderer::hudTextWidth(buf, 1.f * s) - 10 * s, H - 16 * s, 1.f * s, vec4(1, 1, 1, 0.8f), buf);
      if (simTime < hintUntil || paused) {
        bool pad = input.usingGamepad();
        auto F = input.padFamily();
        std::string hint = pad
          ? std::string("Left stick move/steer   ") + padLabel(F, input.pad[size_t(Action::Jump)]) + " jump   " +
            padLabel(F, input.pad[size_t(Action::Skis)]) + " skis on/off   " + padLabel(F, input.pad[size_t(Action::Brake)]) + " brake   " +
            padLabel(F, input.pad[size_t(Action::View)]) + " view"
          : "WASD move / steer   W tuck   S brake   SPACE jump (hold to charge)   G skis on/off   R view   ESC pause";
        renderer.hudRect(8 * s, 6 * s, Renderer::hudTextWidth(hint, s) + 12 * s, 14 * s, vec4(0, 0, 0, 0.35f));
        renderer.hudText(14 * s, 9 * s, 1.f * s, vec4(1), hint);
      }
      if (paused) {
        renderer.hudRect(0, 0, W, H, vec4(0.02f, 0.05f, 0.12f, 0.45f));
        renderer.hudText(W / 2 - Renderer::hudTextWidth("PAUSED", 4 * s) / 2, H / 2 - 20 * s, 4 * s, vec4(1), "PAUSED");
      }
      if (simTime < toastUntil && !toast.empty())
        renderer.hudText(W / 2 - Renderer::hudTextWidth(toast, 2 * s) / 2, H * 0.3f, 2 * s, vec4(1, 0.95f, 0.8f, 1), toast);
    }
    renderer.endFrame();

    frame++;
    fpsN++;
    fpsT += plat->timeSeconds() - now;
    if (fpsT > 0.5 || (opt.autotest && fpsN >= 20)) { fps = fpsN / std::max(1e-6, fpsT); fpsN = 0; fpsT = 0; }
    if (opt.autotest) {
      if (frame % 100 == 0 || frame == 1)
        SL_INFO("[autotest] frame %4d  t=%5.2fs  pos=(%8.1f, %7.1f, %8.1f)  speed=%5.1f km/h  %-5s  fps=%5.1f  terrain=%zu trees=%zu draws=%u",
                frame, simTime, player.pos.x, player.pos.y, player.pos.z, player.speed() * 3.6, player.modeName(), fps,
                terrain.nodeCount(), scenery.treesDrawn(), renderer.drawCalls());
      if (frame >= opt.frames) {
        if (!opt.png.empty()) {
          std::vector<uint8_t> px;
          renderer.readPixels(px);
          int w = renderer.width(), h = renderer.height();
          std::vector<uint8_t> flipped(px.size());
          for (int y = 0; y < h; y++) std::memcpy(&flipped[size_t(y) * w * 4], &px[size_t(h - 1 - y) * w * 4], size_t(w) * 4);
          if (stbi_write_png(opt.png.c_str(), w, h, 4, flipped.data(), w * 4)) SL_INFO("[autotest] wrote %s", opt.png.c_str());
        }
        running = false;
      }
    }
    plat->swapBuffers();
  }

  if (opt.autotest) {
    double wall = plat->timeSeconds() - startT;
    double dist = glm::length(dvec2(player.pos.x - startPos.x, player.pos.z - startPos.z));
    double drop = startPos.y - player.pos.y;
    bool finite = std::isfinite(player.pos.x) && std::isfinite(player.pos.y) && std::isfinite(player.pos.z);
    bool ok = finite && (onPiste ? player.distance > 50 && drop > 5 : true);
    SL_INFO("[autotest] %d frames (%.1f s simulated) in %.1f s wall: avg %.1f fps", frame, simTime, wall, frame / wall);
    SL_INFO("[autotest] skied %.0f m along the run (%.0f m from the start), dropped %.0f m, top speed %.1f km/h, final %.1f km/h, %d landings, %d crashes, mode %s",
            player.distance, dist, drop, maxSpeed * 3.6, player.speed() * 3.6, nLand, nCrash, player.modeName());
    SL_INFO("[autotest] %s", ok ? "PASS" : "FAIL");
    audio.stop(*plat);
    return ok ? 0 : 1;
  }
  audio.stop(*plat);
  return 0;
}

} // namespace sl
