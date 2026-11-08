#include "game/game.h"

#include "core/assets_path.h"
#include "core/input.h"
#include "core/jobs.h"
#include "core/noise.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/audio.h"
#include "engine/quality.h"
#include "engine/renderer.h"
#include "gfx/gfx.h"
#include "platform/platform.h"
#include "player/player.h"
#include "player/skier_rig.h"
#include "world/resort.h"
#include "world/rail_sweep.h"
#include "world/transport.h"
#include "game/buses.h"
#include "game/drive.h"
#include "game/traffic.h"
#include "game/trains.h"
#include "game/economy.h"
#include "game/hud.h"
#include "game/menus.h"
#include "game/trailmap.h"
#include "game/play.h"
#include "game/play_data.h"
#include "game/people.h"
#include "game/shapes.h"
#include "game/weather.h"
#include "game/interiors.h"
#include "game/races.h"
#include "game/jobs.h"
#include "game/police.h"
#include "game/rescue.h"
#include "game/chalets.h"
#include "game/snowmobile.h"
#include "core/prompts.h"
#include "engine/ui.h"
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
#include <chrono>
#include <thread>
#include <unordered_map>

namespace sl {

namespace {
constexpr double STEP = 1.0 / 120.0;   // simulation tick (player.js SUBSTEP)
constexpr double ALT0 = 1245;          // village altitude above sea level (signs)

struct Piste { std::string name; int diff = 0; std::string peak; std::vector<dvec2> pts; };

std::vector<Piste> loadPistes(platform::Platform& p, const AssetPaths& paths) {
  std::vector<Piste> out;
  std::vector<uint8_t> b;
  if (!paths.readData(p, "world.json", b)) return out;
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


int verifyHeights(platform::Platform& p, const AssetPaths& paths, World& world) {
  std::vector<uint8_t> b;
  if (!paths.readData(p, "world.json", b)) return 2;
  auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
  double e[6] = {0}, eReg[3] = {0}, sumReg = 0;
  int nReg = 0;
  const char* names[6] = {"baseHeight(spacing 0)", "baseHeight(spacing 8)", "baseHeight(spacing 64)", "height", "meshHeight", "forest"};
  for (auto& r : j["refs"]) {
    double x = r[0], z = r[1];
    double h = world.height(x, z);
    double slope = std::hypot(world.height(x + 1, z) - h, world.height(x, z + 1) - h);
    double v[6] = {world.baseHeight(x, z, 0), world.baseHeight(x, z, 8), world.baseHeight(x, z, 64), h, world.meshHeight(x, z), world.forest(x, z, h, slope)};
    // (Phase 3: points inside a World Racing course's region are compared on their own: the regions come as an 8 m grid)
    bool inReg = r.size() > 8 && r[8].get<int>() != 0;
    for (int k = 0; k < 6; k++) {
      double d = std::fabs(v[k] - r[2 + k].get<double>());
      if (inReg && k >= 3) { eReg[k - 3] = std::max(eReg[k - 3], d); if (k == 3) { sumReg += d; nReg++; } }
      else e[k] = std::max(e[k], d);
    }
  }
  SL_INFO("verify-heights: %zu reference points from the JavaScript world (%d in the courses' regions)", j["refs"].size(), nReg);
  for (int k = 0; k < 6; k++) SL_INFO("  max |C++ - JS| %-24s %.4f %s", names[k], e[k], k == 5 ? "" : "m");
  if (nReg) SL_INFO("  in the regions (8 m grid): height max %.3f m, mean %.3f m; meshHeight max %.3f m; forest max %.3f", eReg[0], sumReg / nReg, eReg[1], eReg[2]);
  bool ok = e[0] < 0.05 && e[3] < 0.25;
  SL_INFO("verify-heights: %s", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
// sky.js time-of-day palette: keyframes by the sun's height (night, blue hour, dusk, sunset, low sun, golden, day)
Lighting timeOfDay(double hour, const Lighting& day) {
  static const double KEYS[7] = {-0.35, -0.16, -0.05, 0.02, 0.10, 0.24, 0.45};
  static const vec3 ZEN[7] = {{0.0140f, 0.0260f, 0.0750f}, {0.0125f, 0.0226f, 0.0634f}, {0.0175f, 0.0309f, 0.1006f}, {0.0225f, 0.0430f, 0.1477f}, {0.0273f, 0.0529f, 0.1691f}, {0.0313f, 0.0587f, 0.1947f}, {0.0313f, 0.0583f, 0.2011f}};
  static const vec3 MID[7] = {{0.0200f, 0.0380f, 0.1000f}, {0.0311f, 0.0493f, 0.1741f}, {0.0533f, 0.0927f, 0.3012f}, {0.0681f, 0.1781f, 0.5578f}, {0.0386f, 0.2363f, 0.8628f}, {0.0131f, 0.2700f, 1.1346f}, {0.0417f, 0.3990f, 1.4235f}};
  static const vec3 HOR[7] = {{0.0300f, 0.0520f, 0.1250f}, {0.0592f, 0.0795f, 0.2081f}, {0.1917f, 0.1697f, 0.3356f}, {0.5128f, 0.3552f, 0.5701f}, {0.5074f, 0.7318f, 1.5213f}, {0.5204f, 1.1992f, 2.9277f}, {0.3156f, 1.5195f, 5.2906f}};
  static const vec3 GLO[7] = {{0.0300f, 0.0520f, 0.1250f}, {0.0858f, 0.0915f, 0.2319f}, {0.8592f, 0.2017f, 0.0988f}, {1.8594f, 0.3212f, 0.0924f}, {3.1807f, 0.8578f, 0.2631f}, {2.8088f, 2.1991f, 0.9815f}, {0.4458f, 2.1394f, 6.6786f}};
  static const vec3 FOG[7] = {{0.0240f, 0.0400f, 0.0980f}, {0.0402f, 0.0541f, 0.1289f}, {0.1188f, 0.1224f, 0.2646f}, {0.2309f, 0.2254f, 0.4413f}, {0.2708f, 0.3673f, 0.8300f}, {0.2162f, 0.4526f, 1.2098f}, {0.1633f, 0.4992f, 1.6117f}};
  static const vec3 SUN[7] = {{1, 0.4f, 0.2f}, {1, 0.4f, 0.2f}, {1, 0.42f, 0.2f}, {1.0f, 0.48f, 0.24f}, {1.0f, 0.68f, 0.42f}, {1.0f, 0.84f, 0.64f}, {1.0f, 0.93f, 0.82f}};
  static const float SUNI[7] = {0, 0, 0, 1.4f, 4.0f, 5.4f, 6.0f};
  static const vec3 AMB[7] = {{0.10f, 0.14f, 0.28f}, {0.18f, 0.22f, 0.45f}, {0.42f, 0.36f, 0.62f}, {0.52f, 0.48f, 0.78f}, {0.46f, 0.56f, 0.92f}, {0.40f, 0.58f, 1.0f}, {0.38f, 0.58f, 1.0f}};
  Lighting L = day;
  double t = (hour - 12) / 12 * PI, elev = (28 * std::cos(t) + 4) * DEG;
  vec3 sun = glm::normalize(vec3(float(std::sin(t) * std::cos(elev)), float(std::sin(elev)), float(std::cos(t) * std::cos(elev))));
  double h = sun.y;
  int i = 0;
  while (i < 5 && h > KEYS[i + 1]) i++;
  float f = float(smoothstep(KEYS[i], KEYS[i + 1], h));
  auto mix3 = [&](const vec3* a) { return glm::mix(a[i], a[i + 1], f); };
  L.sunDir = h > 0.02 ? sun : glm::normalize(vec3(sun.x, 0.02f, sun.z));
  // after dusk the moon lights the snow (sky.js moonDir): a faint cold key light with shadows
  double mt = t + PI, melev = (42 * std::cos(mt) + 8) * DEG;
  vec3 moon = glm::normalize(vec3(float(std::sin(mt) * std::cos(melev) * 0.8), float(std::sin(melev)), float(std::cos(mt) * std::cos(melev) * 0.8 - 0.3)));
  L.zenith = mix3(ZEN); L.mid = mix3(MID); L.horizon = mix3(HOR); L.glow = mix3(GLO); L.fog = mix3(FOG);
  L.sunColor = mix3(SUN);
  L.sunIntensity = SUNI[i] + (SUNI[i + 1] - SUNI[i]) * f;
  float moonK = float(1 - smoothstep(-0.12, 0.0, h));
  if (moonK > 0 && moon.y > 0.05f && L.sunIntensity < 0.3f) {
    L.sunDir = moon;
    L.sunColor = vec3(0.55f, 0.66f, 1.0f);
    L.sunIntensity = 0.35f * moonK;
  }
  float level = float(lerp(0.035, 1, smoothstep(-0.2, 0.3, h)));
  vec3 amb = mix3(AMB) / AMB[6];
  L.sky = day.sky * amb * level;
  L.ground = day.ground * level * (0.4f + 0.6f * float(smoothstep(-0.1, 0.2, h)));
  double dayF = smoothstep(-0.08, 0.12, h), nightF = 1 - smoothstep(-0.18, 0.02, h);
  L.night = float(std::max(nightF, (1 - dayF) * 0.6));   // village.js nightUniform
  return L;
}

// the boarding prompt for a station (main.js interaction())
std::string stationLabel(const Lifts::Station& st) {
  const LiftLine& l = *st.line;
  if (st.mid) return l.mid.name + " - " + l.name;
  if (st.up) return "Ride " + l.name;
  return "Ride " + (l.gondola ? std::string() : l.name + " ") + "down to " + (!l.bottomName.empty() ? l.bottomName : l.main ? "the village" : "the valley");
}

void writePng(Renderer& renderer, const std::string& path) {
  std::vector<uint8_t> px;
  renderer.readPixels(px);
  int w = renderer.width(), h = renderer.height();
  std::vector<uint8_t> flipped(px.size());
  for (int y = 0; y < h; y++) std::memcpy(&flipped[size_t(y) * w * 4], &px[size_t(h - 1 - y) * w * 4], size_t(w) * 4);
  if (stbi_write_png(path.c_str(), w, h, 4, flipped.data(), w * 4)) SL_INFO("[autotest] wrote %s", path.c_str());
}
std::string pngVariant(const std::string& png, const char* tag) {
  size_t dot = png.rfind('.');
  return dot == std::string::npos ? png + "_" + tag : png.substr(0, dot) + "_" + tag + png.substr(dot);
}
} // namespace

int runGame(const GameOptions& opt) {
  auto plat = platform::createPlatform();
  AssetPaths paths;
  if (!paths.init(*plat)) return 2;
  SL_INFO("assets: %s | data: %s", paths.publicRoot.c_str(), paths.dataRoot.c_str());

  // (Phase 4) the save: progress, settings, bindings (the autotest plays a fresh save of its own)
  Save save(opt.autotest ? std::string("autotest-save.json") : opt.saveName);
  if (!opt.autotest && !opt.verifyHeights) save.load(*plat);

  World world;
  world.load(*plat, paths);
  if (opt.verifyHeights) return verifyHeights(*plat, paths, world);
  if (opt.autotest) save.write(*plat);   // (a fresh autotest save on disk)

  Quality q = Quality::preset(opt.qualitySet || save.quality.empty() ? opt.quality : save.quality);
  platform::WindowDesc wd;
  wd.width = opt.width; wd.height = opt.height; wd.fullscreen = opt.fullscreen || (!opt.autotest && save.settingOn("fullscreen")); wd.vsync = opt.vsync && !opt.autotest;
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

  // (Phase 4) the 2D layer (menus, HUD, trail map) and a loading screen while the world builds
  Ui ui;
  ui.init(*dev, *plat, paths);
  auto loadingFrame = [&](const char* what) {
    plat->drawableSize(dw, dh);
    dev->bindRenderTarget({}, dw, dh);
    dev->clear(0.016f, 0.055f, 0.133f, 1, true, true);
    ui.begin(dw, dh);
    float u = std::clamp(std::min(float(dh) / 800.f, float(dw) / 1280.f), 0.55f, 2.2f);
    ui.rectGradient(0, 0, float(dw), float(dh), vec4(0.06f, 0.16f, 0.42f, 1), vec4(0.016f, 0.055f, 0.133f, 1), false);
    ui.brushStroke(90 * u, 56 * u, 480 * u, 120 * u, vec4(1), 77);
    ui.text(116 * u, 64 * u, 34 * u, UiFont::CondHeavy, ui_color::red, "SKI");
    ui.text(114 * u, 86 * u, 84 * u, UiFont::CondHeavy, ui_color::blue, "LEGACY");
    ui.text(110 * u, 320 * u, 17 * u, UiFont::Body, vec4(1), what);
    ui.end();
    plat->swapBuffers();
  };
  loadingFrame("Loading the mountain...");

  Input input;
  if (save.binds.is_object() && !save.binds.empty()) input.applyBindings(save.binds);
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
  loadingFrame("Building the resort...");
  Resort resort(*dev, world, assets);
  bool haveResort = resort.load(*plat, paths, scenery);
  if (!haveResort) scenery.loadVillage(*plat, paths);   // (Phase 1 placements without the resort data)
  Lifts& lifts = resort.lifts();
  // (Phase 3) the transport: roads, car parks, railways (data), the swept track, the vehicles
  Transport transport;
  if (const nlohmann::json* net = resort.transportNet()) transport.load(*net, resort.transportBin());
  if (transport.loaded()) world.roadSurface = [&](double x, double z, double mesh, double yHint) { return transport.roadSurface(world, x, z, mesh, yHint); };
  if (transport.rail.ok) world.addDeck([&](double x, double z) { return transport.railDeckHeight(x, z); });
  if (transport.express.ok) world.addDeck([&](double x, double z) { return transport.expressDeckHeight(x, z); });
  loadingFrame("Laying the roads and the railways...");
  RailSweep sweep;
  sweep.build(*dev, transport);
  sweep.buildGuardrails(*dev, transport, world);
  VehicleModels vmodels;
  vmodels.load(*dev, assets, transport, resort);
  Drive drive(world, scenery, transport, vmodels);
  Traffic traffic(world, transport, vmodels);
  BusLine buses(world, transport, vmodels);
  Railway railway(world, transport, vmodels);
  Express express(world, transport, vmodels);
  if (transport.loaded()) { drive.init(); traffic.init(); buses.init(); }
  railway.init();
  express.init();
  std::vector<Obb> busBoxes;
  drive.gatherOthers = [&](std::vector<OtherBody>& out) {
    traffic.others(out, drive.pos());
    for (const Obb& b : busBoxes) if (std::hypot(b.x - drive.pos().x, b.z - drive.pos().z) < 20) { OtherBody o; o.box = b; o.mass = 12000; o.kind = 1; out.push_back(o); }
  };
  drive.onKnock = [&](const OtherBody& b, double vx, double vz, double w) { if (b.kind == 0) traffic.knock(b.id, vx, vz, w); };
  VehicleDraw vdraw;
  Player player(world, &scenery);
  SkierRig rig;
  auto rigColour = [&]() { return save.character == "skier_red" ? std::string("red") : std::string("blue"); };
  if (!rig.load(assets, rigColour())) SL_WARN("skier model missing: the player is invisible");
  // (Phase 4) your garage: the cars you own stand in the Autohaus car park's bays
  for (const Save::Car& c : save.garage) {
    int i = drive.addOwned(c.id, c.plate, c.damage);
    if (i < 0) SL_WARN("garage: unknown car %s", c.id.c_str());
  }
  TrailMap tmap;
  tmap.load(*plat, paths, world, transport, lifts);
  tmap.buildRelief(jobs, world, *dev);
  Audio audio;
  if (!opt.autotest) audio.start(*plat);

  // spawn: the village plaza (main.js), or the top of a run on the Legacy face
  std::vector<Piste> pistes = loadPistes(*plat, paths);
  struct Hut { std::string name; double x, z; };
  std::vector<Hut> huts;
  {
    std::vector<uint8_t> b;
    if (paths.readData(*plat, "world.json", b)) {
      auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
      if (!j.is_discarded() && j.contains("layout")) for (auto& h : j["layout"]["huts"]) huts.push_back({h.value("name", std::string("Mountain hut")), h.value("x", 0.0), h.value("z", 0.0)});
    }
  }
  // ---------------------------------------------------------------- (Phase 5) races, jobs, police, rescue, chalets, people, weather
  PlayData playData;
  if (const nlohmann::json* pj = resort.playData()) playData.load(*pj, resort.playBin());
  Shapes shapes;
  shapes.init(*dev);
  People people;
  people.load(assets);
  PeopleSim folk;
  folk.setKinds(people.fanKinds, people.skierKinds);
  {
    std::vector<std::vector<dvec2>> pl;
    for (auto& ps : pistes) pl.push_back(ps.pts);
    folk.init(world, pl, opt.autotest ? 28 : 56, opt.autotest ? 6 : 14);
  }
  Weather weather;
  weather.init(unsigned(plat->timeSeconds() * 1000) ^ 0x5eedu, opt.autotest);
  PlayCtx pc;
  pc.plat = plat.get(); pc.world = &world; pc.scenery = &scenery; pc.transport = &transport; pc.player = &player; pc.drive = &drive; pc.traffic = &traffic;
  pc.save = &save; pc.input = &input; pc.people = &people; pc.folk = &folk; pc.shapes = &shapes; pc.lifts = &lifts; pc.weather = &weather; pc.assets = &assets;
  pc.dev = dev.get(); pc.data = &playData; pc.autotest = opt.autotest;
  for (auto& ps : pistes) pc.pistes.push_back({ps.name, ps.pts});
  Interiors rooms(pc);
  world.addDeck([&](double x, double z) { return rooms.deck(x, z); });
  Races races(pc);
  Jobs oddJobs(pc);
  Police police(pc, rooms);
  Rescue rescue(pc, rooms);
  Chalets chalets(pc, rooms);
  police.load(assets);
  rescue.load(assets);
  chalets.load(assets);
  Snowmobiles sleds(pc);
  sleds.load(assets);
  sleds.place();
  std::shared_ptr<Model> jobBoard = assets.model("job_board", ModelLoadOptions{});
  VehicleDraw snowDraw;
  double fadeT = -1;   // a short fade to dark covering a teleport (transition.js)
  bool jailResumed = false;
  drive.gatherOthers = [&](std::vector<OtherBody>& out) {
    traffic.others(out, drive.pos());
    for (const Obb& b : busBoxes) if (std::hypot(b.x - drive.pos().x, b.z - drive.pos().z) < 20) { OtherBody o; o.box = b; o.mass = 12000; o.kind = 1; out.push_back(o); }
    police.others(out, drive.pos());
  };
  drive.onKnock = [&](const OtherBody& b, double vx, double vz, double w) {
    double kmh = glm::length(drive.vel() - dvec2(b.vx, b.vz)) * 3.6;
    if (b.kind == 0) { traffic.knock(b.id, vx, vz, w); if (!races.active()) police.callFor("a car was rammed", kmh); }
    else if (b.kind == 3) { police.knockUnit(b.id, vx, vz); police.hitCop(b.id, kmh); }
    else if (b.kind == 2 && !races.active()) police.callFor("a parked car was hit", kmh);
  };
  // (impound.js) a car of yours towed to the impound row: locked until the next game day
  drive.locked = [&](const Drive::Parked& e) -> std::string { return e.impoundDay > save.day ? "Impounded \xC2\xB7 available tomorrow at the Autohaus car park" : ""; };
  {
    nlohmann::json& imp = save.data("impound", nlohmann::json::array());
    for (auto& r : imp) for (auto& e : drive.parked) if (e.owned && e.plate == r.value("plate", std::string())) e.impoundDay = r.value("day", 0);
  }
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
  Lighting dayLight;
  dayLight.toneMap = opt.toneMap;
  double hour = opt.hour >= 0 ? std::fmod(opt.hour, 24.0) : opt.autotest ? 10.0 : std::fmod(std::max(0.0, save.hour), 24.0);
  Lighting light = timeOfDay(hour, dayLight);
  player.frameUpdate(0.016, 1, {}, {});
  player.cameraFor(cam);
  terrain.finish(cam.pos);
  scenery.finish(cam.pos);
  resort.update(0, cam.pos);
  SL_INFO("world ready in %.2f s: %zu terrain nodes, %zu trees in range, %zu resort props, %zu lifts, %.0f MB textures", plat->timeSeconds() - t0,
          terrain.nodeCount(), scenery.treesDrawn(), resort.propCount(), lifts.lines().size(), assets.textureBytes() / 1048576.0);

  // profiling toggles: SKI_LEGACY_DEBUG=noterrain,notrees,novillage,noskier
  std::string dbg = std::getenv("SKI_LEGACY_DEBUG") ? std::getenv("SKI_LEGACY_DEBUG") : "";
  auto off = [&](const char* k) { return dbg.find(k) != std::string::npos; };
  bool drawTerrain = !off("noterrain"), drawTrees = !off("notrees"), drawVillage = !off("novillage"), drawSkier = !off("noskier");
  bool running = true, paused = false;
  bool vehTest = off("vehtest");   // (debug: the autotest starts with the Phase 3 vehicles)
  double acc = 0, last = plat->timeSeconds(), fpsT = 0, fps = 0, simTime = 0;
  int fpsN = 0, frame = 0;
  double startT = plat->timeSeconds();
  std::string toast;
  double toastUntil = 0, toastShownUntil = 0;
  int nCrash = 0, nLand = 0;
  double maxSpeed = 0;
  dvec3 startPos = player.pos;
  PlayerControls ctl;

  // ---------------------------------------------------------------- (Phase 4) menus, HUD, economy
  Hud hud;
  Menus menus(ui, save, input, *plat);
  NavBuilder navBuilder;
  bool wasUiOpen = false;
  bool started = !opt.menu || opt.autotest;   // in the game (else the main menu over the live world)
  bool showcaseOn = false;
  double showcaseYaw = PI * 0.85, menuT = 0;
  auto flash = [&](const std::string& t, Hud::Flash k) { hud.flash(t, k, simTime); };
  auto fmtM = [](int64_t v) {
    std::string n = std::to_string(v < 0 ? -v : v), o;
    for (size_t i = 0; i < n.size(); i++) { if (i && (n.size() - i) % 3 == 0) o += ','; o += n[i]; }
    return (v < 0 ? "-$" : "$") + o;
  };
  // money: spend (refused when short: "Not enough money ($N needed)", economy.js spend), earn
  auto spend = [&](int64_t amount, bool force = false) {
    if (!save.spend(amount, force)) { flash("Not enough money (" + fmtM(amount) + " needed)", Hud::Flash::Bad); return false; }
    save.write(*plat);
    return true;
  };
  // the SETTINGS values applied (main.js onSetting); "" = all
  float fovSetting = 65;
  int fpsCap = 0;
  auto applySetting = [&](const std::string& k) {
    bool all = k.empty();
    if (all || k == "renderScale") renderer.setRenderScale(float(q.renderScale * std::clamp(save.setting("renderScale", 1), 0.5, 1.0)));
    if (all || k == "shadows") renderer.shadowsOn = save.settingOn("shadows");
    if (all || k == "brightness") dayLight.exposure = float(0.72 * std::clamp(save.setting("brightness", 1), 0.7, 1.3));
    if (all || k == "fpsCap") fpsCap = int(save.setting("fpsCap", 0));
    if ((all && !opt.autotest) || k == "fullscreen") { bool fs = save.settingOn("fullscreen"); if (plat->fullscreen() != fs && !opt.autotest) plat->setFullscreen(fs); }
    if (all || k == "volume" || k == "sfxVolume") audio.masterVolume = float(std::clamp(save.setting("volume", 0.8), 0.0, 1.0) * std::clamp(save.setting("sfxVolume", 1), 0.0, 1.0));
    if (all || k == "sensitivity") input.mouseSens = float(save.setting("sensitivity", 1));
    if (all || k == "padSens") input.padSens = float(save.setting("padSens", 1));
    if (all || k == "invertY") input.invertY = save.settingOn("invertY");
    if (all || k == "vibration") input.vibration = save.settingOn("vibration");
    if (all || k == "fov") fovSetting = float(save.setting("fov", 65));
    if (k == "quality") flash("Graphics preset saved: it applies the next time the game starts", Hud::Flash::Good);
    if (!all) save.write(*plat);
  };
  applySetting("");
  if (save.settingStr("defaultView", "third") == "first") player.view = Player::View::First;
  // (Phase 5) the services the gameplay systems use
  pc.menus = &menus; pc.hud = &hud;
  pc.flash = [&](const std::string& t, int k) { flash(t, k == 1 ? Hud::Flash::Bad : k == 2 ? Hud::Flash::Gold : Hud::Flash::Good); };
  pc.spend = [&](int64_t a) { return spend(a); };
  pc.earn = [&](int64_t a) { save.earn(a); save.markDirty(); };
  pc.charge = [&](int64_t a) { save.spend(a, true); save.markDirty(); };
  pc.money = [&](int64_t v) { return fmtM(v); };
  pc.teleport = [&](double x, double z, double h, bool skis) { player.setSkisOn(skis); player.teleport(x, z, h); };
  pc.mark = [&](double x, double z, const std::string& l) { tmap.mark.on = true; tmap.mark.x = x; tmap.mark.z = z; tmap.mark.label = l; };
  pc.unmark = [&]() { tmap.mark.on = false; };
  pc.fade = [&]() { fadeT = 0; };

  // riding a lift (main.js boardLift / leaveLift)
  Player::View viewBeforeRide = player.view;
  bool restoreView = false;
  int strikes = 0;
  double lastStrikeAt = -1e9;
  auto boardLift = [&](const Lifts::Station& st, bool up) {
    LiftLine& line = *st.line;
    // (Phase 4, main.js boardLift) skis first; a day pass or a gondola ticket, else the line's price; riding down free
    if (save.skis.empty()) { flash("Rent skis first - the ski shop in Legacy Village", Hud::Flash::Bad); return; }
    bool useTicket = !save.hasPass() && up && line.main && save.tickets > 0;
    bool free = save.hasPass() || !up || useTicket;
    int price = line.price > 0 ? line.price : line.gondola ? Prices::gondola : Prices::chair;
    if (!free && !spend(price)) return;
    if (useTicket) { save.tickets--; save.write(*plat); }
    strikes = 0;   // (a lift ride between two wipeouts: no rescue)
    if (!player.skisOn) player.setSkisOn(true);
    Seat seat = lifts.board(line, up, st.mid);
    player.sitOn(seat.pos, seat.fwd);
    // skis ride in the gondola's outside rack; on chairlifts they stay on your feet; gondolas are ridden in 3rd person
    rig.skisInRide = !line.gondola;
    if (line.gondola) { viewBeforeRide = player.view; restoreView = true; player.view = Player::View::Third; }
    toast = free ? line.name + (save.hasPass() ? " \xC2\xB7 Day pass" : useTicket ? " \xC2\xB7 ticket" : "") : line.name + " \xC2\xB7 -$" + std::to_string(price);
    toastUntil = simTime + 2;
  };
  auto leaveLift = [&](const LiftExit& e, const std::string& stop) {
    player.standUp(e.x, e.z, e.heading);
    rig.skisInRide = true;
    if (restoreView) { player.view = viewBeforeRide; restoreView = false; }
    lifts.timeScale = 1;
    toast = stop.empty() ? "Arrived" : "Off at " + stop;
    toastUntil = simTime + 2;
  };
  std::string prompt, rideLine;
  // (Phase 3) what you ride: a car (you drive), a ski bus, the Wolkenspitzbahn, the Legacy Express
  enum class Ride { None, Car, Bus, Rail, Express, Sled } rideKind = Ride::None;
  int busDestSel = 0, expressDestSel = 0;
  double rideCamYaw = 0, rideCamPitch = 0.15, rideLookT = -1e9, seatYaw = 0, seatPitch = -0.05;
  bool seatView = true;   // riding the bus / a train: the seat view (bus.js / railway.js / express.js default), R: outside
  dvec3 rideCamPos{0};
  bool rideCamReady = false;
  auto standOff = [&](const dvec3& e, const std::string& what) {   // (x, z, heading)
    player.standUp(e.x, e.y, e.z);
    rig.skisInRide = true;
    if (restoreView) { player.view = viewBeforeRide; restoreView = false; }
    rideKind = Ride::None;
    toast = what; toastUntil = simTime + 2.5;
  };

  // ---------------------------------------------------------------- (Phase 4) the shops and counters (card dialogs)
  auto equipSkis = [&](const std::string& id) {
    save.skis = id;
    save.write(*plat);
  };
  // the ski shop (main.js shopAction / outfitshop.js, simplified to one card dialog with tabs)
  auto openSkiShop = [&]() {
    Dialog d;
    d.kicker = "Ski Rental & Shop \xC2\xB7 Legacy Village";
    d.title = "Ski Shop";
    d.tabs = {"SKIS", "JACKETS", "TROUSERS", "HELMETS", "GOGGLES"};
    d.keepOpen = true;
    d.rebuild = [&](Dialog& D) {
      D.options.clear();
      static const char* slots[5] = {"", "jacket", "trousers", "helmet", "lens"};
      if (D.tab == 0) {
        D.say = save.skis.empty() ? "Gr\xC3\xBC" "ezi! You have everything except skis: the rental pair, or something faster."
                                  : "Back for an upgrade? Faster skis glide a little quicker and hold an edge better.";
        for (size_t i = 0; i < kSkiCount; i++) {
          const SkiDef& sk = kSkis[i];
          DialogOption o;
          bool has = save.ownsSki(sk.id), eq = save.skis == sk.id;
          int pct = int(std::round((sk.speed - 1) * 100));
          o.label = sk.name;
          o.sub = (pct ? "+" + std::to_string(pct) + "% speed" : std::string("Standard speed")) + " \xC2\xB7 " + std::to_string(int(std::round(sk.grip * 100))) + "% grip";
          if (eq) o.state = "Equipped";
          else if (has) o.state = "Owned \xC2\xB7 equip";
          else o.price = sk.price;
          o.disabled = !has && save.money < sk.price;
          std::string id = sk.id;
          o.act = [&, id]() {
            const SkiDef* k = skiById(id);
            if (!k || save.skis == id) return;
            if (save.ownsSki(id)) { equipSkis(id); flash(std::string(k->name) + " equipped", Hud::Flash::Good); return; }
            if (!spend(k->price)) return;
            save.owned.push_back(id);
            equipSkis(id);
            flash(std::string(k->name) + (k->rent ? " rented" : " purchased"), Hud::Flash::Gold);
          };
          D.options.push_back(o);
        }
      } else {
        std::string slot = slots[D.tab];
        D.say = "Buy once, wear it on the man and the woman (each keeps its own look).";
        nlohmann::json& eq = save.outfits.equipped[save.character];
        if (!eq.is_object()) eq = nlohmann::json::object();
        std::string cur = eq.contains(slot) && eq[slot].is_string() ? eq[slot].get<std::string>() : "";
        DialogOption orig;
        orig.label = "Original"; orig.sub = "The original piece, free"; orig.state = cur.empty() ? "Wearing" : "Free";
        orig.act = [&, slot]() { save.outfits.equipped[save.character][slot] = nullptr; save.write(*plat); };
        D.options.push_back(orig);
        for (size_t i = 0; i < kOutfitCount; i++) {
          const OutfitDef& it = kOutfits[i];
          if (slot != it.slot) continue;
          DialogOption o;
          bool has = save.ownsOutfit(it.id);
          o.label = it.name; o.sub = it.note; o.swatch = it.base; o.swatch2 = it.accent;
          if (cur == it.id) o.state = "Wearing";
          else if (has) o.state = "Owned \xC2\xB7 wear";
          else o.price = it.price;
          o.disabled = !has && save.money < it.price;
          std::string id = it.id;
          o.act = [&, id, slot]() {
            const OutfitDef* od = outfitById(id);
            if (!od) return;
            if (!save.ownsOutfit(id)) { if (!spend(od->price)) return; save.outfits.owned.push_back(id); flash(std::string(od->name) + " bought", Hud::Flash::Gold); }
            save.outfits.equipped[save.character][slot] = id;
            save.write(*plat);
          };
          D.options.push_back(o);
        }
      }
      DialogOption close; close.label = "Close"; close.secondary = true;
      D.options.push_back(close);
    };
    menus.openDialog(d);
  };
  // the ticket seller (main.js talkToSeller)
  auto openTickets = [&]() {
    Dialog d;
    d.kicker = "Ticket seller \xC2\xB7 Legacy Gondola";
    d.title = "Lift Tickets";
    d.rebuild = [&](Dialog& D) {
      bool pass = save.hasPass();
      D.say = pass ? "Your day pass is good until midnight. Enjoy the mountain!" : "Gr\xC3\xBC" "ezi! Where are you headed today?";
      D.options.clear();
      DialogOption a;
      a.label = "Day pass"; a.sub = pass ? "Unlimited rides until midnight" : "Unlimited rides today: every lift, the Wolkenspitzbahn and the Express";
      if (pass) a.state = "Active"; else a.price = Prices::dayPass;
      a.disabled = pass || save.money < Prices::dayPass;
      a.act = [&]() { if (spend(Prices::dayPass)) { save.dayPass = save.day; save.write(*plat); flash("Day pass active", Hud::Flash::Gold); } };
      DialogOption b;
      b.label = "Gondola ticket"; b.sub = "One ride to the summit" + (save.tickets > 0 ? " \xC2\xB7 you have " + std::to_string(save.tickets) : std::string());
      if (pass) b.state = "Day pass"; else b.price = Prices::gondola;
      b.disabled = pass || save.money < Prices::gondola;
      b.act = [&]() { if (spend(Prices::gondola)) { save.tickets++; save.write(*plat); flash("Gondola ticket bought", Hud::Flash::Gold); } };
      DialogOption c; c.label = "Nothing, thanks"; c.secondary = true;
      D.options = {a, b, c};
    };
    menus.openDialog(d);
  };
  auto newPlate = [&]() {
    static const char* L = "ABCDEFGHJKLMNPRSTUVWXYZ";
    unsigned v = unsigned(plat->timeSeconds() * 1000) ^ unsigned(save.garage.size() * 7919);
    std::string p = "SL ";
    p += L[v % 23]; p += L[(v / 23) % 23]; p += " " + std::to_string(100 + (v / 529) % 900);
    return p;
  };
  // buying a car at the Autohaus (carrental.js: your garage, up to GARAGE_MAX cars; it waits in your bay)
  auto buyCar = [&](const std::string& model) -> int {
    const CarSpec* spec = transport.car(model);
    if (!spec) return -1;
    if (int(save.garage.size()) >= GARAGE_MAX) { flash("Your garage is full (" + std::to_string(GARAGE_MAX) + " cars): sell one first", Hud::Flash::Bad); return -1; }
    if (!spend(int64_t(spec->price))) return -1;
    Save::Car c;
    c.id = model; c.plate = newPlate(); c.price = int(spec->price);
    save.garage.push_back(c);
    int idx = drive.addOwned(model, c.plate, 0);
    save.write(*plat);
    flash("Bought: " + spec->label + " (" + c.plate + ") \xC2\xB7 it waits in your bay at the Autohaus car park", Hud::Flash::Gold);
    return idx;
  };
  auto openCarSale = [&](int idx) {
    if (idx < 0 || size_t(idx) >= drive.parked.size()) return;
    std::string model = drive.parked[size_t(idx)].name;
    Dialog d;
    d.kicker = "Autohaus \xC2\xB7 Legacy Village";
    d.title = drive.parked[size_t(idx)].spec->label;
    d.rebuild = [&, model](Dialog& D) {
      const CarSpec* spec = transport.car(model);
      D.say = (spec ? spec->label : model) + " \xC2\xB7 yours for good: it waits in your bay at the Autohaus car park, " + prompts::K(input, Action::Interact) +
              " to drive. Dents: the Werkstatt next door, priced by the damage. A wreck: " + fmtM(wreckFee()) + " (tow + repair).";
      D.options.clear();
      DialogOption b;
      b.label = "Buy it"; b.sub = std::to_string(save.garage.size()) + " of " + std::to_string(GARAGE_MAX) + " cars in your garage";
      b.price = spec ? int(spec->price) : 0;
      b.disabled = !spec || save.money < int64_t(spec->price) || int(save.garage.size()) >= GARAGE_MAX;
      b.act = [&, model]() { buyCar(model); };
      DialogOption n; n.label = "Not now"; n.secondary = true;
      D.options = {b, n};
    };
    menus.openDialog(d);
  };
  auto garageEntry = [&](const std::string& plate) -> Save::Car* { for (auto& c : save.garage) if (c.plate == plate) return &c; return nullptr; };
  // MY CARS (the Autohaus counter): your garage, sell one back for half what you paid
  auto openGarage = [&]() {
    Dialog d;
    d.kicker = "Autohaus \xC2\xB7 my cars";
    d.title = "My Cars";
    d.keepOpen = true;
    d.rebuild = [&](Dialog& D) {
      D.say = save.garage.empty() ? "No cars yet: the ten for sale stand in the car park out front (" + prompts::K(input, Action::Interact) + " at one to buy it)."
                                  : "Your cars wait in the Autohaus car park. Sell one back for half what you paid.";
      D.options.clear();
      for (const Save::Car& c : save.garage) {
        const CarSpec* spec = transport.car(c.id);
        DialogOption o;
        int value = int(std::round(c.price * SELL_SHARE / 50.0)) * 50;
        o.label = (spec ? spec->label : c.id) + " \xC2\xB7 " + c.plate;
        o.sub = "Damage " + std::to_string(int(std::round(c.damage))) + "% \xC2\xB7 sell back for " + fmtM(value);
        for (const auto& e : drive.parked) if (e.owned && e.plate == c.plate && e.impoundDay > save.day) o.sub += " \xC2\xB7 IMPOUNDED: available tomorrow (the fee is paid)";
        o.state = "Sell " + fmtM(value);
        std::string plate = c.plate;
        o.act = [&, plate, value]() {
          for (size_t i = 0; i < drive.parked.size(); i++)
            if (drive.parked[i].owned && drive.parked[i].plate == plate) {
              if (drive.parked[i].driving) { flash("Get out of it first", Hud::Flash::Bad); return; }
              drive.parked.erase(drive.parked.begin() + long(i));
              break;
            }
          save.garage.erase(std::remove_if(save.garage.begin(), save.garage.end(), [&](const Save::Car& g) { return g.plate == plate; }), save.garage.end());
          save.earn(value);
          save.write(*plat);
          flash("Sold for " + fmtM(value), Hud::Flash::Gold);
        };
        D.options.push_back(o);
      }
      DialogOption n; n.label = "Close"; n.secondary = true;
      D.options.push_back(n);
    };
    menus.openDialog(d);
  };
  // the WERKSTATT (werkstatt.js): priced by the damage (carrental.js repairCost)
  auto openWerkstatt = [&](int idx) {
    if (idx < 0 || size_t(idx) >= drive.parked.size()) return;
    std::string plate = drive.parked[size_t(idx)].plate;
    Dialog d;
    d.kicker = "Werkstatt \xC2\xB7 repairs";
    d.title = "Werkstatt";
    d.rebuild = [&, plate](Dialog& D) {
      Drive::Parked* e = nullptr;
      for (auto& p : drive.parked) if (p.owned && p.plate == plate) e = &p;
      double dmg = e ? e->damage : 0;
      int fee = repairCost(dmg / 100);
      D.say = dmg > 0 ? "Your " + (e ? e->spec->label : std::string("car")) + " has " + std::to_string(int(std::round(dmg))) + "% damage. We fix it while you wait."
                      : "Nothing to repair: she's as good as new.";
      D.options.clear();
      DialogOption r;
      r.label = "Repair it"; r.sub = "Every dent and scratch \xC2\xB7 from $5 up to " + fmtM(REPAIR_FEE);
      r.price = fee; r.disabled = fee <= 0 || save.money < fee;
      r.act = [&, plate, fee]() {
        if (!spend(fee)) return;
        for (auto& p : drive.parked) if (p.owned && p.plate == plate) p.damage = 0;
        if (Save::Car* c = garageEntry(plate)) c->damage = 0;
        save.write(*plat);
        flash("Repaired \xC2\xB7 -" + fmtM(fee).substr(0), Hud::Flash::Good);
      };
      DialogOption n; n.label = "Not now"; n.secondary = true;
      D.options = {r, n};
    };
    menus.openDialog(d);
  };
  auto openHut = [&](const std::string& name) {
    Dialog d;
    d.kicker = "Mountain hut";
    d.title = name;
    d.rebuild = [&](Dialog& D) {
      D.say = "Warm up for a minute. The view is free.";
      DialogOption h;
      h.label = "Hot chocolate"; h.sub = "With cream"; h.price = Prices::hotChocolate; h.disabled = save.money < Prices::hotChocolate;
      h.act = [&]() { if (spend(Prices::hotChocolate)) flash("Hot chocolate", Hud::Flash::Gold); };
      DialogOption n; n.label = "Nothing, thanks"; n.secondary = true;
      D.options = {h, n};
    };
    menus.openDialog(d);
  };
  // the medical centre's door (rescue.js: the ambulance brings you there; the bill even into the red)
  const Lot* medical = nullptr;
  const Lot* werkstattLot = nullptr;
  for (const Lot& L : transport.lots) { if (L.hospital) medical = &L; if (L.name == "Werkstatt") werkstattLot = &L; }
  double rescueAt = -1;
  auto doRescue = [&]() {
    int fee = save.rescueFee();
    if (rideKind != Ride::None || player.mode == PlayerMode::Sit) return;
    double x = medical ? (medical->ex != 0 ? medical->ex : medical->x) : 4, z = medical ? (medical->ez != 0 ? medical->ez : medical->z) : 34;
    player.setSkisOn(false);
    player.teleport(x, z, 0);
    save.spend(fee, true);
    save.rescues++;
    save.write(*plat);
    flash("Mountain rescue \xC2\xB7 treated at the medical centre \xC2\xB7 -" + fmtM(fee).substr(0), Hud::Flash::Bad);
  };
  // your wreck: the tow truck takes it back to the Autohaus repaired (carrental.js wreckFee: tow + repair)
  struct Tow { int plateIdx; std::string plate; double at; int fee; std::string why; };
  std::vector<Tow> tows;
  drive.onWreck = [&](int idx) {
    if (idx < 0 || size_t(idx) >= drive.parked.size() || !drive.parked[size_t(idx)].owned) return;
    int fee = wreckFee();
    save.spend(fee, true);
    save.write(*plat);
    tows.push_back({idx, drive.parked[size_t(idx)].plate, simTime + 20, 0, "wreck"});
    flash("Wrecked \xC2\xB7 tow + repair -" + fmtM(fee).substr(0) + " \xC2\xB7 the tow truck brings it back to the Autohaus", Hud::Flash::Bad);
  };
  double leftOnRoadT = 0;

  // autotest phases after the run: walk into a hotel (collision), then ride a gondola
  enum class AT { Menu, Ski, Collide, Lift, Drive, Bus, Rail, Express, Map, Race, Job, Police, Chalet, Weather, Done } at = AT::Menu;
  if (vehTest && opt.autotest) at = AT::Drive;
  if (off("maptest") && opt.autotest) at = AT::Map;   // (debug: straight to the trail map)
  if (off("p5test") && opt.autotest) at = AT::Race;   // (debug: straight to the Phase 5 checks)
  // (Phase 5 autotest) a race, a job, a police chase into jail, a chalet and a piece of furniture, a weather change
  bool raceOk = true, jobOk = true, policeOk = true, chaletOk = true, weatherOk = true, sledOk = true;
  struct P5T { const Course* course = nullptr; int resF = -1, jailF = -1, arrestF = -1; int64_t money0 = 0; double jail0 = 0; int done0 = 0, furn0 = 0; bool releasedChecked = false; Jobs::Offer offer; bool haveOffer = false; } t5;
  // (Phase 4 autotest) the menus, a purchase, save / reload, the trail map
  bool menuOk = true, settingOk = true, buyOk = true, saveOk = true, mapOk = true, chargeOk = true;
  int skiFrame0 = 0, menuStep = 0;
  std::string pendingPng;
  int64_t money0 = 0, liftMoney0 = 0;
  dvec3 spawnPos = player.pos;
  double spawnHeading = player.heading;
  int phaseFrame = 0;
  bool skiOk = true, collideOk = true, liftOk = true, driveOk = true, trafficOk = true, busOk = true, railOk = true, expressOk = true;
  // (Phase 3 autotest) drive 20 s on a road; a traffic car follows its lane; ride the bus, the Wolkenspitzbahn, the Express
  int testCar = -1;
  double driveT = 0, driveTop = 0, driveDist = 0, driveMaxSink = 0;
  dvec3 driveStart{0}, drivePrev{0};
  int testRoad = -1;
  std::vector<dvec3> traffic0;
  double rideTest = 0;
  dvec3 ridePos0{0};
  bool rideBoarded = false;
  double skiDist = 0, skiDrop = 0, skiDistStart = 0;
  const Collider* hotel = nullptr;
  dvec3 walkStart{0};
  LiftLine* testLine = nullptr;
  double rideT = 0, rideP0 = 0, rideP1 = 0;
  bool boarded = false, gotOff = false, ridePng = false;
  LiftExit expectExit;
  std::string offAt;

  // ---------------------------------------------------------------- (Phase 4) the menus' hooks
  menus.hooks.start = [&]() {
    menus.close();
    if (showcaseOn) { showcaseOn = false; player.teleport(4, 34, PI); }
    started = true;
    if (!opt.autotest) plat->setRelativeMouse(true);
    flash(save.skis.empty() ? "Welcome to Legacy Village \xC2\xB7 rent skis at the ski shop" : "Welcome back to Legacy Village", Hud::Flash::Good);
  };
  menus.hooks.resume = [&]() { menus.close(); if (!opt.autotest) plat->setRelativeMouse(true); };
  menus.hooks.quit = [&]() { running = false; };
  menus.hooks.mainMenu = [&]() { save.write(*plat); started = false; menus.open(Menus::Screen::Main, -1); };
  menus.hooks.village = [&]() {
    menus.close();
    if (police.jailed() || police.arrestedNow()) { flash("You are serving a sentence", Hud::Flash::Bad); return; }
    if (rescue.active()) { flash("The rescue is under way", Hud::Flash::Bad); return; }
    if (rooms.inside()) rooms.leave();
    races.abort();
    if (rideKind == Ride::None && player.mode != PlayerMode::Sit) { player.setSkisOn(false); player.teleport(4, 34, PI); flash("Back in Legacy Village", Hud::Flash::Good); }
    else flash("Get off first", Hud::Flash::Bad);
  };
  menus.hooks.setting = [&](const std::string& k) { applySetting(k); };
  menus.hooks.character = [&](const std::string&) { rig.load(assets, rigColour()); save.markDirty(); };
  menus.hooks.showcase = [&](bool on) {
    showcaseOn = on;
    if (on && rideKind == Ride::None && player.mode != PlayerMode::Sit) {
      player.setSkisOn(false);
      player.teleport(4, 34, PI);
      showcaseYaw = std::atan2(-3.4, -1.2) + 0.35;   // (facing the camera, a little turned)
    }
  };
  menus.hooks.spin = [&](float d) { showcaseYaw += d; };
  menus.hooks.bindingsChanged = [&]() { save.write(*plat); };
  menus.hooks.resetProgress = [&]() {
    save.reset();
    drive.parked.erase(std::remove_if(drive.parked.begin(), drive.parked.end(), [](const Drive::Parked& e) { return e.owned && !e.forSale && !e.driving; }), drive.parked.end());
    input.resetBindings();
    applySetting("");
    save.write(*plat);
    flash("Progress reset: a new save", Hud::Flash::Good);
  };
  menus.hooks.flash = [&](const std::string& t, int k) { flash(t, k == 1 ? Hud::Flash::Bad : k == 2 ? Hud::Flash::Gold : Hud::Flash::Good); };
  if (!started) menus.open(Menus::Screen::Main);

  while (running) {
    platform::Events ev;
    plat->pollEvents(ev);
    if (ev.quit) running = false;
    if (ev.resized) { plat->drawableSize(dw, dh); renderer.resize(dw, dh); }
    if (ev.focusLost) { input.clear(); plat->setRelativeMouse(false); }
    input.update(*plat, ev);
    double now = plat->timeSeconds();
    double frameDt = opt.autotest ? (at == AT::Ski ? 1.0 / 60.0 : at == AT::Race ? 0.05 : 0.1) : std::min(0.25, now - last);
    last = now;
    UiNav nav = navBuilder.build(ev, *plat, input, now);
    if (opt.autotest) { nav = UiNav{}; nav.mouse = vec2(-1); }

    // (Phase 4) the pause menu (Esc / Menu / +), the trail map (M / View / Minus); menus and dialogs take the input
    bool uiOpen = menus.isOpen() || tmap.isOpen();
    if (started && !uiOpen && wasUiOpen) { input.clear(); input.holdOff(); }   // (the key that closed it: not also in the game)
    if (started && !uiOpen) {
      if (input.takePressed(Action::Pause)) { menus.inGame = true; menus.open(Menus::Screen::Pause); plat->setRelativeMouse(false); uiOpen = true; }
      else if (input.takePressed(Action::Map)) { tmap.open(player.pos); plat->setRelativeMouse(false); uiOpen = true; }
      else if (!opt.autotest && (ev.mousePressed & 1) && !plat->relativeMouse()) plat->setRelativeMouse(true);
    } else if (tmap.isOpen() && !opt.autotest) {
      bool mapKey = std::find(ev.pressed.begin(), ev.pressed.end(), input.kb[size_t(Action::Map)]) != ev.pressed.end() || input.padPressed(input.pad[size_t(Action::Map)]);
      if (mapKey) tmap.close();
    }
    if (uiOpen || !started) input.clear();
    wasUiOpen = uiOpen || !started;
    paused = started && menus.isOpen() && !menus.dialogOpen();

    // (Phase 4 autotest) the main menu -> PLAY -> SINGLEPLAYER -> CHOOSE YOUR SKIER -> START; pause -> SETTINGS -> a
    // value changed -> back; the ski shop: rent skis (money goes down); save, reload, compare
    if (opt.autotest && at == AT::Menu) {
      int f = phaseFrame;
      auto expect = [&](bool ok, const char* what) { if (!ok) { menuOk = false; SL_WARN("[autotest] menu: %s (screen %d, focus '%s')", what, int(menus.screen()), menus.focusedLabel().c_str()); } };
      auto next = [&]() { menuStep++; phaseFrame = -1; input.releaseInjected(); };
      switch (menuStep) {
        case 0:
          if (f == 0) { started = false; menus.open(Menus::Screen::Main); }
          if (f == 8) { expect(menus.screen() == Menus::Screen::Main && menus.focusedLabel() == "PLAY", "main menu with PLAY focused"); if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "menu"); }
          if (f == 9) nav.confirm = true;
          if (f == 11) { expect(menus.screen() == Menus::Screen::PlayMode, "PLAY -> the play mode screen"); next(); }
          break;
        case 1:
          if (f == 3) nav.confirm = true;   // SINGLEPLAYER
          if (f == 5) { expect(menus.screen() == Menus::Screen::Showcase, "SINGLEPLAYER -> CHOOSE YOUR SKIER (first time)"); next(); }
          break;
        case 2:
          if (f == 3) nav.left = true;      // MAN
          if (f == 5) { expect(save.character == "skier_red", "left picks MAN"); nav.right = true; }   // WOMAN
          if (f == 9 && !opt.png.empty()) pendingPng = pngVariant(opt.png, "showcase");
          if (f == 10) { expect(save.character == "skier_blue" && menus.focusedLabel() == "START", "right picks WOMAN, START focused"); nav.confirm = true; }
          if (f == 12) {
            expect(started && !menus.isOpen() && save.characterChosen, "START -> in the game");
            SL_INFO("[autotest] menu: main menu -> PLAY -> SINGLEPLAYER -> CHOOSE YOUR SKIER (MAN, WOMAN) -> START: %s", menuOk ? "ok" : "FAILED");
            next();
          }
          break;
        case 3:
          input.inject(Action::Pause, f == 2);
          if (f == 4) { expect(menus.screen() == Menus::Screen::Pause && paused, "Esc / Menu -> the pause menu"); }
          if (f == 5 || f == 6 || f == 7) nav.down = true;   // RESUME -> CONTROLS -> STATS -> SETTINGS
          if (f == 9) { expect(menus.focusedLabel() == "SETTINGS", "SETTINGS focused"); nav.confirm = true; }
          if (f == 11) { expect(menus.screen() == Menus::Screen::Settings, "SETTINGS opens"); next(); }
          break;
        case 4: {
          static double before = 0;
          if (f == 3) { menus.focusLabel("hudScale"); before = save.setting("hudScale", 1); }
          if (f == 4) nav.right = true;
          if (f == 6) {
            double after = save.setting("hudScale", 1);
            settingOk = std::fabs(after - (before + 0.05)) < 1e-6;
            SL_INFO("[autotest] settings: HUD size %.0f%% -> %.0f%% (right on the focused row) -> %s", before * 100, after * 100, settingOk ? "ok" : "FAILED");
            if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "settings");
          }
          if (f == 7) nav.cancel = true;     // back to the pause menu
          if (f == 9) { expect(menus.screen() == Menus::Screen::Pause, "back -> the pause menu"); nav.cancel = true; }   // resume
          if (f == 11) { expect(!menus.isOpen() && !paused, "back again -> resumed"); next(); }
          break;
        }
        case 5:
          if (f == 1) { player.setSkisOn(false); player.teleport(-31.5, -16.0, std::atan2(-8.5, -2.0)); }
          input.inject(Action::Interact, f == 3);
          if (f == 6) {
            expect(menus.dialogOpen(), "E at the ski shop opens it");
            money0 = save.money;
            if (!menus.focusLabel("Rental Carver")) expect(false, "the rental skis in the shop");
          }
          if (f == 7) nav.confirm = true;
          if (f == 9) {
            buyOk = save.money == money0 - kSkis[0].price && save.skis == "rental" && save.ownsSki("rental");
            SL_INFO("[autotest] shop: rented the %s: $%lld -> $%lld, skis '%s' -> %s", kSkis[0].name, (long long)money0, (long long)save.money, save.skis.c_str(), buyOk ? "ok" : "FAILED");
            if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "shop");
          }
          if (f == 10) nav.cancel = true;
          if (f == 12) { expect(!menus.isOpen(), "the shop closes"); next(); }
          break;
        case 6: {
          // save, read it back into a second save and into the game's own, compare
          bool w = save.write(*plat);
          Save s2(save.fileName());
          bool l = s2.load(*plat);
          int64_t m = save.money;
          double hs = save.setting("hudScale", 1);
          bool l2 = save.load(*plat);
          saveOk = w && l && l2 && s2.money == m && save.money == m && s2.skis == "rental" && std::fabs(s2.setting("hudScale", 1) - hs) < 1e-9 && s2.characterChosen;
          SL_INFO("[autotest] save: wrote %s, reloaded: money $%lld (expected $%lld), skis '%s', HUD size %.2f, character %s -> %s", save.fileName().c_str(),
                  (long long)s2.money, (long long)m, s2.skis.c_str(), s2.setting("hudScale", 1), s2.character.c_str(), saveOk ? "ok" : "FAILED");
          applySetting("");
          // on to the run
          player.teleport(spawnPos.x, spawnPos.z, spawnHeading);
          player.setSkisOn(true);
          startPos = player.pos;
          skiDistStart = player.distance;
          maxSpeed = 0;
          input.releaseInjected();
          at = AT::Ski; phaseFrame = -1; skiFrame0 = frame + 1;
          break;
        }
        default: break;
      }
    }
    if (opt.autotest && at == AT::Map) {
      if (phaseFrame == 1 && rideKind == Ride::None) { player.setSkisOn(false); player.teleport(4, 34, PI); }   // (back in the village: the map opens on you)
      input.inject(Action::Map, phaseFrame == 2);
      if (phaseFrame >= 6 && phaseFrame < 12) nav.zoomIn = 1;
      if (phaseFrame == 30) nav.cancel = true;
    }

    // (Phase 5 autotest) a race (start -> finish -> records), a job (taken at the village board, delivered: paid), a police
    // chase (wanted, the officer catches you on foot: ARRESTED, the jail timer, released), a chalet bought and a piece of
    // furniture placed, a weather change
    if (opt.autotest && (at == AT::Race || at == AT::Job || at == AT::Police || at == AT::Chalet || at == AT::Weather)) {
      int f = phaseFrame;
      auto nextPhase = [&](AT a) { at = a; phaseFrame = -1; input.releaseInjected(); };
      if (at == AT::Race) {
        if (f == 0) {
          input.releaseInjected();
          t5.course = nullptr;
          for (const Course& c : playData.courses) if (!t5.course || c.length < t5.course->length) t5.course = &c;
          if (t5.course) {
            save.earn(2000);
            t5.money0 = save.money;
            raceOk = races.start(*t5.course, 1, true, false, true);
            SL_INFO("[autotest] race: %s (%s, %.0f m, %d m drop, par %.1f s, entry $%d, %zu gates, %zu checkpoints) -> %s", t5.course->name.c_str(), t5.course->diff.c_str(),
                    t5.course->length, t5.course->drop, t5.course->par, t5.course->entry, t5.course->gates.size(), t5.course->checkpoints.size(), raceOk ? "started" : "FAILED");
          } else { raceOk = false; SL_WARN("[autotest] race: no course (play.json)"); }
        }
        if (t5.course && races.active() && !races.finished() && !races.frozen()) {
          const CourseLine& L = t5.course->line;
          CourseLine::Proj pr = L.project(player.pos.x, player.pos.z, races.progress() + t5.course->start.s, 120);
          dvec3 tgt = L.point(std::min(L.length(), pr.s + 26), 0);
          double err = wrapPi(std::atan2(tgt.x - player.pos.x, tgt.z - player.pos.z) - player.heading);
          float steer = float(clamp(err * 2.4, -1, 1));
          double sp = player.speed();
          input.inject(Action::Forward, sp < 19);
          input.inject(Action::Back, sp > 25 || (std::fabs(err) > 0.7 && sp > 12));
          input.injectMove(-steer, sp < 19 ? 1.f : 0.f);
          if (f % 100 == 0) SL_INFO("[autotest] race t=%6.2fs  %5.0f m down the course  %5.1f km/h  lat %5.1f", races.raceTime(), races.progress(), sp * 3.6, pr.lat);
        } else if (races.finished()) input.releaseInjected();
        if (races.resultsUp() && t5.resF < 0) {
          t5.resF = f;
          SL_INFO("[autotest] race: finished in %s, place %d, money $%lld -> $%lld", fmtRaceTime(races.raceTime()).c_str(), races.place(), (long long)t5.money0, (long long)save.money);
          for (auto& row : races.lastRows) SL_INFO("[autotest]   %s", row.c_str());
          if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "race");
        }
        if (t5.resF >= 0 && f == t5.resF + 8) {
          const nlohmann::json& rec = save.data("records")[t5.course->id];
          bool recOk = rec.is_object() && rec.contains("best") && rec["best"].is_number() && rec.value("runs", 0) >= 1 && rec.contains("bestRace") && rec["bestRace"].is_number();
          save.write(*plat);
          Save s2(save.fileName());
          bool reload = s2.load(*plat) && s2.data("records").contains(t5.course->id);
          raceOk = raceOk && recOk && reload;
          SL_INFO("[autotest] race: records[%s] = %s, in the save file %s -> %s", t5.course->id.c_str(), rec.dump().c_str(), reload ? "yes" : "NO", raceOk ? "ok" : "FAILED");
          races.confirmResults();
        }
        if (t5.resF >= 0 && f == t5.resF + 12) {
          bool home = std::hypot(player.pos.x - 4, player.pos.z - 34) < 30 && !races.active();
          raceOk = raceOk && home;
          SL_INFO("[autotest] race: OK -> back in Legacy Village (%.0f, %.0f) %s", player.pos.x, player.pos.z, home ? "ok" : "FAILED");
          nextPhase(AT::Job);
        }
        if (f > 3600 && t5.resF < 0) { raceOk = false; SL_WARN("[autotest] race: not finished after %.0f s (%.0f m down)", races.raceTime(), races.progress()); races.abort(); nextPhase(AT::Job); }
      } else if (at == AT::Job) {
        const JobHub* hub = nullptr;
        for (auto& h : playData.hubs) if (h.id == "village") hub = &h;
        if (!hub && !playData.hubs.empty()) hub = &playData.hubs[0];
        if (!hub) { jobOk = false; SL_WARN("[autotest] job: no job board"); nextPhase(AT::Police); }
        else {
          if (f == 1) { player.setSkisOn(false); player.teleport(hub->fx + std::sin(hub->yaw) * 0.8, hub->fz + std::cos(hub->yaw) * 0.8, hub->yaw + PI); t5.money0 = save.money; t5.done0 = oddJobs.done(); }
          input.inject(Action::Interact, f == 3);
          if (f == 6) {
            auto offers = oddJobs.offers(*hub);
            t5.haveOffer = false;
            for (auto& o : offers) if (o.type == "delivery") { t5.offer = o; t5.haveOffer = true; break; }
            if (!menus.dialogOpen() || !t5.haveOffer) { jobOk = false; SL_WARN("[autotest] job: the board did not open / no delivery (prompt '%s', %zu offers)", prompt.c_str(), offers.size()); }
            else {
              for (auto& o : offers) SL_INFO("[autotest] job board %s: %s \xC2\xB7 %s \xC2\xB7 $%d (+%d tip) \xC2\xB7 limit %d s", hub->name.c_str(), o.title.c_str(), o.type.c_str(), o.reward, o.bonus, o.limit);
              if (!menus.focusLabel(t5.offer.title)) { jobOk = false; SL_WARN("[autotest] job: offer not on the board"); }
            }
          }
          if (f == 7 && jobOk) nav.confirm = true;
          if (f == 8 && !opt.png.empty()) pendingPng = pngVariant(opt.png, "job");
          if (f == 9) {
            if (!oddJobs.active()) { jobOk = false; SL_WARN("[autotest] job: not taken"); nextPhase(AT::Police); }
            else { const auto& d = oddJobs.current()->dest; player.teleport(d.x + 1.2, d.z + 0.6, 0); SL_INFO("[autotest] job: taken '%s', at the destination (%.1f, %.1f)", oddJobs.current()->title.c_str(), d.x, d.z); }
          }
          input.inject(Action::Interact, f == 12);
          if (f == 15) {
            int64_t gain = save.money - t5.money0;
            jobOk = jobOk && !oddJobs.active() && oddJobs.done() == t5.done0 + 1 && gain >= t5.offer.reward;
            SL_INFO("[autotest] job: delivered (prompt was '%s'): money $%lld -> $%lld (+%lld; reward $%d + tip), jobs done %d -> %d -> %s", prompt.c_str(), (long long)t5.money0, (long long)save.money,
                    (long long)gain, t5.offer.reward, t5.done0, oddJobs.done(), jobOk ? "ok" : "FAILED");
            nextPhase(AT::Police);
          }
        }
      } else if (at == AT::Police) {
        if (f == 1) {
          // on foot beside the valley road below the village, then a patrol car rammed (wanted, fleeing at once)
          dvec3 at0(4, 0, 34);
          Transport::RoadHit h = transport.nearestRoad(40, 120, 200);
          if (h.road >= 0) { RoadPoint q = roadAt(transport.roads[size_t(h.road)], h.s); at0 = dvec3(q.x - q.dz * 7, 0, q.z + q.dx * 7); }
          player.setSkisOn(false);
          player.teleport(at0.x, at0.z, 0);
          police.hitCop(0, 40);
          SL_INFO("[autotest] police: wanted (%s) at (%.0f, %.0f)", police.status().c_str(), at0.x, at0.z);
        }
        if (f > 1 && f % 40 == 0 && t5.arrestF < 0) SL_INFO("[autotest] police t=%4.1fs  %s, %zu patrol cars%s", f * frameDt, police.status().c_str(), police.units(), police.heliUp() ? ", the helicopter" : "");
        if (police.arrestedNow() && t5.arrestF < 0) { t5.arrestF = f; SL_INFO("[autotest] police: ARRESTED after %.1f s", f * frameDt); }
        if (t5.arrestF >= 0 && f == t5.arrestF + 8 && !opt.png.empty()) pendingPng = pngVariant(opt.png, "police");
        if (police.jailed() && t5.jailF < 0) { t5.jailF = f; t5.jail0 = police.jailLeft(); SL_INFO("[autotest] police: in prison, %.0f s (%s)", t5.jail0, police.objective().c_str()); }
        if (t5.jailF >= 0 && f == t5.jailF + 32 && !opt.png.empty()) pendingPng = pngVariant(opt.png, "jail");
        if (t5.jailF >= 0 && f == t5.jailF + 40) {
          double left = police.jailLeft();
          bool tick = left < t5.jail0 - 3 && left > 0 && rooms.room() == Interiors::Room::Prison;
          policeOk = policeOk && tick && t5.jail0 >= 44;
          SL_INFO("[autotest] police: jail timer %.1f s -> %.1f s, in the cell %s -> %s", t5.jail0, left, rooms.room() == Interiors::Room::Prison ? "yes" : "NO", tick ? "ok" : "FAILED");
        }
        if (t5.jailF >= 0 && f == t5.jailF + 42) police.skipJail(0.3);
        if (t5.jailF >= 0 && f == t5.jailF + 50) {
          bool out = !police.jailed() && !rooms.inside() && playData.prison.ok && std::hypot(player.pos.x - playData.prison.x, player.pos.z - playData.prison.z) < 40;
          policeOk = policeOk && out;
          const nlohmann::json& r = save.data("policeRecord");
          SL_INFO("[autotest] police: released outside the station (%.0f, %.0f) %s; record %s -> %s", player.pos.x, player.pos.z, out ? "ok" : "FAILED", r.dump().c_str(), policeOk ? "ok" : "FAILED");
          nextPhase(AT::Chalet);
        }
        if (f > 1400 && t5.jailF < 0) { policeOk = false; SL_WARN("[autotest] police: no arrest (%s, %zu units)", police.status().c_str(), police.units()); police.clear("autotest"); nextPhase(AT::Chalet); }
      } else if (at == AT::Chalet) {
        if (playData.chalets.empty()) { chaletOk = false; SL_WARN("[autotest] chalet: no chalets"); nextPhase(AT::Weather); }
        else {
          const ChaletHouse& h = playData.chalets[0];
          if (f == 1) { save.earn(60000); t5.money0 = save.money; player.setSkisOn(false); player.teleport(h.doorX, h.doorZ, h.yaw - PI / 2); }
          input.inject(Action::Interact, f == 3);
          if (f == 6) { if (!menus.dialogOpen() || !menus.focusLabel("Buy this chalet")) { chaletOk = false; SL_WARN("[autotest] chalet: no sale dialog (prompt '%s')", prompt.c_str()); } }
          if (f == 7 && chaletOk) nav.confirm = true;
          if (f == 11) {
            bool b = chalets.owned() && rooms.room() == Interiors::Room::Chalet && save.money == t5.money0 - playData.chaletPrice;
            chaletOk = chaletOk && b;
            SL_INFO("[autotest] chalet: bought %s: $%lld -> $%lld, inside %s -> %s", h.name.c_str(), (long long)t5.money0, (long long)save.money, rooms.room() == Interiors::Room::Chalet ? "yes" : "no", b ? "ok" : "FAILED");
            t5.furn0 = chalets.furnitureCount();
          }
          input.inject(Action::Furnish, f == 13);
          if (f == 16) {
            if (!chalets.building()) { chaletOk = false; SL_WARN("[autotest] chalet: build mode did not open"); }
            int64_t m0 = save.money;
            bool placed = false;
            double px = 0, pz = 0;
            for (const Rect2& r : playData.chaletPlan.rects) {
              for (double x = r.x0 + 0.75; x < r.x1 - 0.5 && !placed; x += 0.5)
                for (double z = r.z0 + 0.75; z < r.z1 - 0.5 && !placed; z += 0.5)
                  if (chalets.place("armchair", x, z, 0)) { placed = true; px = x; pz = z; }
              if (placed) break;
            }
            const FurnitureDef* fd = playData.furnitureById("armchair");
            bool ok = placed && chalets.furnitureCount() == t5.furn0 + 1 && fd && save.money == m0 - fd->price;
            chaletOk = chaletOk && ok;
            SL_INFO("[autotest] chalet: build mode, placed the %s at (%.2f, %.2f): $%lld -> $%lld, %d pieces -> %s", fd ? fd->name.c_str() : "?", px, pz, (long long)m0, (long long)save.money, chalets.furnitureCount(), ok ? "ok" : "FAILED");
            input.inject(Action::NextItem, true);
          }
          if (f == 17) input.inject(Action::NextItem, false);
          if (f == 20 && !opt.png.empty()) pendingPng = pngVariant(opt.png, "build");
          input.inject(Action::Furnish, f == 24);
          if (f == 27) { dvec3 e = rooms.toWorld(playData.chaletModel.IX - 0.6, 0, playData.chaletModel.doorZ); player.teleport(e.x, e.z, PI / 2); player.pos.y = rooms.toWorld(0, 0, 0).y; }
          input.inject(Action::Interact, f == 29);
          if (f == 33) {
            save.write(*plat);
            Save s2(save.fileName());
            bool saved = s2.load(*plat) && s2.data("chalet").value("owned", false) && s2.data("chalet")["furniture"].size() == size_t(chalets.furnitureCount());
            bool out = !rooms.inside();
            chaletOk = chaletOk && out && saved;
            SL_INFO("[autotest] chalet: left it (%s), in the save: %s -> %s", out ? "outside" : "STILL INSIDE", s2.data("chalet").dump().substr(0, 160).c_str(), chaletOk ? "ok" : "FAILED");
            nextPhase(AT::Weather);
          }
        }
      } else if (at == AT::Weather) {
        if (f == 1) { t5.money0 = 0; SL_INFO("[autotest] weather: %s -> Heavy snow", weather.label().c_str()); weather.set(Weather::byId("heavy")); player.setSkisOn(false); player.teleport(4, 34, PI); }
        if (f == 60) {
          weatherOk = weather.label() == "Heavy snow" && weather.snow > 0.2 && weather.cloud > 0.2;
          SL_INFO("[autotest] weather: %s, snow %.2f, cloud %.2f, fog density %.6f, %d change(s) -> %s", weather.label().c_str(), weather.snow, weather.cloud, double(light.fogDensity), weather.changes, weatherOk ? "ok" : "FAILED");
          if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "weather");
        }
        // the snowmobile: on, throttle 4 s, off
        if (f == 64) {
          if (sleds.count() == 0) { sledOk = false; SL_WARN("[autotest] snowmobile: none parked"); nextPhase(AT::Done); }
          else { dvec3 sp = sleds.pos(0); t5.jail0 = 0; player.teleport(sp.x + 1.6, sp.z, 0); }
        }
        input.inject(Action::Interact, f == 66 || f == 120);
        if (f == 68) { if (rideKind != Ride::Sled) { sledOk = false; SL_WARN("[autotest] snowmobile: could not get on (prompt '%s')", prompt.c_str()); } ridePos0 = player.pos; }
        input.inject(Action::Forward, f >= 70 && f < 90);
        if (f == 90) { double moved = glm::length(dvec2(player.pos.x - ridePos0.x, player.pos.z - ridePos0.z)); sledOk = sledOk && rideKind == Ride::Sled && moved > 8 && sleds.speed() > 20 / 3.6; SL_INFO("[autotest] snowmobile: rode %.0f m in 2 s, top %.0f km/h -> %s", moved, sleds.speed() * 3.6, sledOk ? "ok" : "FAILED"); if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "sled"); }
        input.inject(Action::Back, f >= 90 && f < 118 && rideKind == Ride::Sled && sleds.speed() > 0.6);   // (brake to a stop, not on into reverse)
        if (f == 124) { if (rideKind == Ride::Sled) { sledOk = false; SL_WARN("[autotest] snowmobile: could not get off"); } nextPhase(AT::Done); }
      }
    }

    // autotest pilot: tuck down the run, steering toward a point 35 m ahead on its line
    if (opt.autotest && run && onPiste && at == AT::Ski) {
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
      int jf = opt.frames / 2, sf = frame - skiFrame0;
      input.inject(Action::Jump, sf >= jf && sf < jf + 24);
    }

    if (opt.autotest && at == AT::Collide) {
      if (phaseFrame == 0) {
        input.releaseInjected();
        // the hotel nearest (62, 34) (village.js): walk at it from the plaza side
        double bd = 1e18;
        for (const Collider& c : scenery.colliders())
          if (c.r < 0 && c.hw > 3) { double d = std::hypot(c.x - 62, c.z - 34); if (d < bd) { bd = d; hotel = &c; } }
        if (hotel) {
          dvec2 out = glm::normalize(dvec2(-hotel->x, -hotel->z));
          double R = std::max(hotel->hw, hotel->hd) + 6;
          walkStart = dvec3(hotel->x + out.x * R, 0, hotel->z + out.y * R);
          player.setSkisOn(false);
          player.teleport(walkStart.x, walkStart.z, std::atan2(-out.x, -out.y));
          walkStart = player.pos;
          SL_INFO("[autotest] collision: walking at the hotel at (%.1f, %.1f) (box %.1f x %.1f m) from %.1f m out", hotel->x, hotel->z, 2 * hotel->hw, 2 * hotel->hd, R);
        } else { collideOk = false; SL_WARN("[autotest] collision: no hotel collider"); }
      }
      input.inject(Action::Forward, true);
      input.inject(Action::Sprint, true);
      input.injectMove(0, 1);
    }
    if (opt.autotest && at == AT::Lift) {
      if (phaseFrame == 0) {
        input.releaseInjected();
        liftMoney0 = save.money;
        for (auto& l : lifts.lines()) if (l.gondola && l.hasMid && (!testLine || l.main)) testLine = &l;
        if (off("chairtest")) for (auto& l : lifts.lines()) if (!l.gondola) { testLine = &l; break; }   // (debug: ride a chairlift)
        if (!testLine) for (auto& l : lifts.lines()) if (l.gondola) { testLine = &l; break; }
        if (testLine) {
          // onto the valley station's deck, a few metres down the line from the bullwheel
          double x = testLine->bottom.x + testLine->dir.x * 4, z = testLine->bottom.z + testLine->dir.y * 4;
          player.teleport(x, z, std::atan2(testLine->dir.x, testLine->dir.y));
          player.setSkisOn(true);
          SL_INFO("[autotest] lift: teleported to the %s valley station (%.1f, %.1f, %.1f)", testLine->name.c_str(), player.pos.x, player.pos.y, player.pos.z);
        } else { liftOk = false; SL_WARN("[autotest] lift: no gondola"); }
      }
      if (testLine && !boarded && phaseFrame == 2) input.inject(Action::Interact, true);
      else input.inject(Action::Interact, false);
      // ride 30 s at line speed, then fast-forward (hold Space, x16) to the mid-station and get off there
      if (boarded && !gotOff) {
        input.inject(Action::Jump, rideT >= 30);
        if (rideT >= 30 && !rideLine.empty() && prompt.rfind("Get off", 0) == 0) input.inject(Action::Interact, true);
      }
    }

    // (Phase 3 autotest) the car: bought at the Autohaus, put on a long road, driven 20 s along its right-hand lane
    DriveInput din;
    if (opt.autotest && at == AT::Drive) {
      if (phaseFrame == 0) {
        input.releaseInjected();
        // (Phase 4) a grant, then the Autohaus sale (money goes down by the car's price)
        save.earn(25000);
        int64_t before = save.money;
        testCar = buyCar("car_bmw_x3");
        const CarSpec* bmw = transport.car("car_bmw_x3");
        bool paid = testCar >= 0 && bmw && save.money == before - int64_t(bmw->price);
        chargeOk = chargeOk && paid;
        SL_INFO("[autotest] autohaus: bought the BMW X3: $%lld -> $%lld (price $%.0f), garage %zu -> %s", (long long)before, (long long)save.money, bmw ? bmw->price : 0.0,
                save.garage.size(), paid ? "ok" : "FAILED");
        if (testCar < 0) testCar = drive.nearestOwned(player.pos);
        double bestL = 0;
        for (size_t ri = 0; ri < transport.roads.size(); ri++) {
          const Road& r = transport.roads[ri];
          if (r.access || r.depot || r.scenic || r.length < 900) continue;
          if (r.length > bestL) { bestL = r.length; testRoad = int(ri); }
        }
        if (testCar >= 0 && testRoad >= 0) {
          const Road& r = transport.roads[size_t(testRoad)];
          RoadPoint p = roadAt(r, 150);
          auto& e = drive.parked[size_t(testCar)];
          e.x = p.x - p.dz * 1.6; e.z = p.z + p.dx * 1.6; e.yaw = std::atan2(p.dx, p.dz); e.y = world.groundHeight(e.x, e.z, p.y + 1) + 0.03;
          player.setSkisOn(false);
          player.teleport(e.x + std::cos(e.yaw) * 2.6, e.z - std::sin(e.yaw) * 2.6, e.yaw);
          driveStart = dvec3(e.x, e.y, e.z); drivePrev = driveStart;
          SL_INFO("[autotest] drive: %s bought at the Autohaus, on road %d (%.0f m long) at (%.1f, %.1f, %.1f)", e.spec->label.c_str(), testRoad, r.length, e.x, e.y, e.z);
          traffic0.clear();
          for (auto& c : traffic.list) traffic0.push_back(dvec3(c.odo, c.road, c.mode == Traffic::Car::Mode::Road ? 1 : 0));
        } else { driveOk = false; SL_WARN("[autotest] drive: no car / road"); }
      }
      input.inject(Action::Interact, phaseFrame == 2);
      if (drive.active() && testRoad >= 0) {
        // steer toward a point 25 m ahead on the right-hand lane; hold ~80 km/h
        const Road& r = transport.roads[size_t(testRoad)];
        Transport::RoadHit rh = transport.nearestRoad(drive.pos().x, drive.pos().z, 30);
        double s = rh.road == testRoad ? rh.s : 150;
        RoadPoint q = roadAt(r, std::min(r.length, s + 25));
        double tx = q.x - q.dz * 1.6, tz = q.z + q.dx * 1.6;
        double err = wrapPi(std::atan2(tx - drive.pos().x, tz - drive.pos().z) - drive.yaw());
        din.steer = float(clamp(err * 2.2, -1, 1));
        din.throttle = drive.speed() < 22 ? 1.f : 0.f;
        din.brake = drive.speed() > 26 ? 0.5f : 0.f;
      }
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
      // (Phase 5) held on the grid during a race's countdown, arrested, waiting for the rescue; the virtual mouse
      // takes the left stick in build mode
      ctl.frozen = races.frozen() || police.arrestedNow() || (rescue.active() && !rescue.carried() && rooms.room() != Interiors::Room::Hospital) || rescue.inBed();
      if (chalets.vmouse()) { ctl.moveX = ctl.moveY = 0; ctl.steer = 0; ctl.front = ctl.back = false; }
      // (weather: a blizzard's gusts push the skis a little, sky.js weatherFx)
      if (player.mode == PlayerMode::Ski && !player.air && weather.wind > 0.01) { player.vel.x += weather.gustX * STEP; player.vel.z += weather.gustZ * STEP; }
      player.fixedUpdate(STEP, ctl);
      if (rideKind == Ride::Car) {
        DriveInput di = din;
        if (!opt.autotest || at != AT::Drive) {
          di.throttle = (input.down(Action::Forward) || input.down(Action::Sprint) || input.moveY() > 0.5f) ? 1.f : 0.f;
          di.brake = (input.down(Action::Back) || input.down(Action::Brake) || input.moveY() < -0.5f) ? 1.f : 0.f;
          di.steer = -input.moveX();
        }
        di.handbrake = input.down(Action::Jump);
        di.lookBack = input.down(Action::LookBack);
        di.horn = input.down(Action::Horn);
        drive.fixedUpdate(STEP, di, simTime);
      } else drive.fixedUpdate(STEP, DriveInput{}, simTime);
      acc -= STEP;
      simTime += STEP;
      first = false;
    }
    PlayerFrameControls fc;
    fc.toggleView = rideKind != Ride::None ? false : input.takePressed(Action::View);
    if ((rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express) && input.takePressed(Action::View)) { seatView = !seatView; rideCamReady = false; }
    fc.toggleSkis = input.takePressed(Action::Skis);
    fc.lookX = paused ? 0 : input.lookX(); fc.lookY = paused ? 0 : input.lookY(); fc.wheel = input.wheel();
    fc.now = opt.autotest ? simTime : now; fc.lastLook = opt.autotest ? -1e9 : input.lastLookTime();
    player.frameUpdate(frameDt, acc / STEP, fc, ctl);
    if (started && !paused && !races.active()) police.vehicleHits(frameDt, busBoxes);

    for (const PlayerEvent& e : player.events) {
      switch (e.type) {
        case PlayerEvent::Type::Crash: {
          nCrash++; audio.thud(1); input.rumble(*plat, 0.9f * e.amount, 0.6f * e.amount, 400);
          oddJobs.onCrash();
          if (races.active() || rescue.active() || rooms.inside()) break;   // (a race session owns its wipeouts: session.js)
          // main.js: you get up after the first wipeout; the second within 3 min (no lift ride between) calls the rescue
          if (simTime - lastStrikeAt > 180) strikes = 0;
          lastStrikeAt = simTime;
          if (opt.autotest) { flash("Wipeout", Hud::Flash::Bad); break; }
          if (++strikes < 2) flash("Wipeout \xC2\xB7 one more and the rescue helicopter comes", Hud::Flash::Bad);
          else { strikes = 0; rescueAt = simTime + 4; flash("Wipeout \xC2\xB7 the mountain rescue is on its way", Hud::Flash::Bad); }
          break;
        }
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
    // (Phase 5) getting hit by a vehicle at 45+ km/h: the rescue at once (vehiclehits.js); the rescue helicopter instead of the fade
    if (started && !races.active()) {
      Police::Hit h = police.takeHit();
      if (h.pending && h.rescue && !rescue.active() && rescueAt < 0) { strikes = 0; rescueAt = simTime + 3; flash("Hit by a " + h.what + " at " + std::to_string(h.kmh) + " km/h \xC2\xB7 the mountain rescue is on its way", Hud::Flash::Bad); }
    }
    if (rescueAt > 0 && simTime >= rescueAt) {
      rescueAt = -1;
      if (rideKind == Ride::None && player.mode != PlayerMode::Sit && !rooms.inside() && !races.active()) rescue.start(); else if (!races.active()) doRescue();
    }
    // (Phase 5) the gameplay systems' frame
    pc.now = simTime;
    pc.driving = rideKind == Ride::Car;
    pc.riding = rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express || (player.mode == PlayerMode::Sit && !rescue.carried());
    if (started && !jailResumed) {
      jailResumed = true;
      const nlohmann::json& jl = save.data("jail");
      if (!opt.autotest && jl.value("left", 0.0) > 0.5) police.jail(jl.value("left", 0.0), jl.value("reason", std::string("Arrested")));
    }
    if (started && !paused) {
      weather.update(frameDt);
      races.update(frameDt);
      oddJobs.update(frameDt);
      police.update(frameDt);
      police.peopleHits(frameDt);
      rescue.update(frameDt, input.down(Action::Jump));
      if (police.fleeing()) { oddJobs.policeChase(); if (races.active()) police.clear("race"); }
      if (races.active() && oddJobs.active()) oddJobs.drop();
      if (input.takePressed(Action::Duty) && oddJobs.onDuty()) oddJobs.endTaxi("Shift ended");
    }
    folk.update(paused ? 0 : frameDt, cam.pos, light.night, &scenery);
    // the career (economy.js stats): top speed, distance skied
    if (started && player.mode == PlayerMode::Ski) {
      static double lastDist = player.distance;
      double dd = player.distance - lastDist;
      if (dd > 0 && dd < 50) save.stats.distance += dd;
      lastDist = player.distance;
      if (player.speed() > save.stats.topSpeed && player.speed() < 70) save.stats.topSpeed = player.speed();
    }
    audio.setSki(float(player.speed()), float(std::fabs(player.edge)), float(player.sideslip), player.air, player.mode == PlayerMode::Ski);

    // lifts: move the cars first, then seat the rider on the updated car (no lag); the boarding prompt
    lifts.timeScale = player.mode == PlayerMode::Sit && !paused && input.down(Action::Jump) ? 16 : 1;   // hold Space: x16
    lifts.update(paused ? 0 : frameDt, player.pos);
    prompt.clear(); rideLine.clear();
    bool interact = input.takePressed(Action::Interact);
    bool nextItem = input.takePressed(Action::NextItem), prevItem = input.takePressed(Action::PrevItem);
    bool fastHeld = !paused && input.down(Action::Jump);
    // (Phase 3) the vehicles move first, then the rider is seated on them
    double vdt = paused ? 0 : frameDt;
    busBoxes.clear();
    buses.boxes(busBoxes);
    traffic.update(vdt, player.pos, &drive, busBoxes, cam.pos);
    buses.update(vdt, player.pos, &drive, &traffic, rideKind == Ride::Bus && fastHeld);
    railway.update(vdt, rideKind == Ride::Rail && fastHeld, player.pos);
    express.update(vdt, rideKind == Ride::Express && fastHeld, player.pos);
    if (rideKind == Ride::Car) {
      DriveFrameInput dfi;
      dfi.toggleView = input.takePressed(Action::View);
      dfi.toggleLights = input.takePressed(Action::Lights);
      dfi.unstuck = input.takePressed(Action::Unstuck);
      dfi.flip = input.takePressed(Action::Furnish);
      dfi.lookX = paused ? 0 : input.lookX(); dfi.lookY = paused ? 0 : input.lookY();
      dfi.now = simTime;
      drive.frame(vdt, dfi);
      dvec3 sp, sf;
      drive.seat(sp, sf);
      player.setSeat(sp, sf);
      rideLine = drive.label() + "   " + std::to_string(int(std::round(drive.speed() * 3.6))) + " km/h";
      if (drive.speed() < 2.0) prompt = "Get out";
      dvec3 ex;
      if (interact && drive.exit(ex)) standOff(ex, "Parked");
      for (const VehicleEvent& e : drive.events) {
        float a = e.amount;
        switch (e.type) {
          case VehicleEvent::Type::Crash: input.rumble(*plat, 0.9f * a, 0.7f * a, 500); audio.thud(a); break;
          case VehicleEvent::Type::Knock: case VehicleEvent::Type::Break: input.rumble(*plat, 0.6f * a, 0.5f * a, 300); audio.thud(a * 0.7f); break;
          case VehicleEvent::Type::Land: input.rumble(*plat, 0.3f + 0.5f * a, 0.2f, 140); break;
          default: if (a > 0) input.rumble(*plat, 0.3f * a, 0.3f * a, 120); break;
        }
        if (!e.text.empty()) { toast = e.text; toastUntil = simTime + 2; }
        if (e.type == VehicleEvent::Type::Knock || e.type == VehicleEvent::Type::Crash) oddJobs.onCarKnock(e.type == VehicleEvent::Type::Crash);
      }
      drive.events.clear();
    } else if (rideKind == Ride::Bus) {
      BusLine::RideState rs = buses.rideState();
      player.setSeat(rs.seat, rs.fwd);
      rideLine = rs.hint + "   hold " + prompts::K(input, Action::Jump) + " x8";
      if (rs.arrived) { std::string stopN = buses.stopName(-1); buses.abort(); standOff(rs.exit, "Off the bus at " + stopN); toast = rs.hint; races.guideFrom(player.pos, stopN); }
    } else if (rideKind == Ride::Rail || rideKind == Ride::Express) {
      TrainRide tr = rideKind == Ride::Rail ? railway.ride() : express.ride();
      player.setSeat(tr.seat, tr.fwd);
      rideLine = tr.hint + "   hold " + prompts::K(input, Action::Jump) + (rideKind == Ride::Rail ? " x6" : " x10");
      if (tr.arrived) { if (rideKind == Ride::Rail) railway.abort(); else express.abort(); standOff(tr.exit, tr.hint); races.guideFrom(player.pos, tr.stop); }
      else if (tr.atStop) {
        prompt = "Get off at " + tr.stop;
        dvec3 ex;
        if (interact && railway.leaveAtStop(ex)) { railway.abort(); standOff(ex, "Off at " + tr.stop); }
      }
    } else if (rideKind == Ride::Sled) {
      // (Phase 5) the snowmobile (snowmobile.js)
      Snowmobiles::In si;
      if (!paused) {
        si.throttle = (input.down(Action::Forward) || input.moveY() > 0.5f) ? 1.f : 0.f;
        si.brake = (input.down(Action::Back) || input.down(Action::Brake) || input.moveY() < -0.5f) ? 1.f : 0.f;
        si.steer = -input.moveX();
        si.boost = input.down(Action::Sprint);
        si.handbrake = input.down(Action::Jump);
      }
      if (sleds.update(vdt, si)) { rideKind = Ride::None; rig.skisInRide = true; }
      else {
        dvec3 sp, sf;
        sleds.seat(sp, sf);
        player.setSeat(sp, sf);
        rideLine = "Snowmobile   " + std::to_string(int(std::round(sleds.speed() * 3.6))) + " km/h";
        if (sleds.speed() < 1.2) prompt = "Get off";
        if (interact && sleds.getOff()) { interact = false; rideKind = Ride::None; rig.skisInRide = true; }
      }
    } else if (rescue.carried()) {
      dvec3 sp, sf;
      if (rescue.seat(sp, sf)) player.setSeat(sp, sf);
      rideLine = std::string("Mountain rescue   hold ") + prompts::K(input, Action::Jump) + " x4";
    } else if (player.mode == PlayerMode::Sit) {
      Lifts::RideState rs = lifts.updateRide();
      if (rs.arrived) leaveLift(rs.exit, "");
      else if (rs.riding) {
        player.setSeat(rs.seat.pos, rs.seat.fwd);
        if (rs.atStop) {
          prompt = "Get off at " + rs.stopName;
          LiftExit ex;
          if (interact && lifts.leaveAtStop(ex)) leaveLift(ex, rs.stopName);
        }
        if (lifts.rideLine()) {
          char b[160];
          std::snprintf(b, sizeof b, "%s  %3.0f%%   hold %s x16", lifts.rideLine()->name.c_str(), lifts.rideProgress() * 100,
                        prompts::K(input, Action::Jump).c_str());
          rideLine = b;
        }
      }
    }
    if (rideKind == Ride::None && player.mode != PlayerMode::Sit && player.mode != PlayerMode::Fall && transport.loaded()) {
      // a car (yours: drive; at the Autohaus: buy), a ski bus stop, a railway station, a Legacy Express station
      std::string cp = drive.prompt(player.pos, true);
      int stop = cp.empty() ? buses.stopNear(player.pos) : -1;
      int rst = cp.empty() && stop < 0 ? railway.stationNear(player.pos) : -1;
      int xst = cp.empty() && stop < 0 && rst < 0 ? express.stationNear(player.pos) : -1;
      if (!cp.empty()) {
        prompt = cp;
        if (interact && drive.interact(player.pos)) {
          interact = false;
          if (drive.buyRequest >= 0) { openCarSale(drive.buyRequest); drive.buyRequest = -1; }
          else if (drive.active()) {
            rideKind = Ride::Car;
            player.setSkisOn(false);
            dvec3 sp, sf;
            drive.seat(sp, sf);
            player.sitOn(sp, sf);
            toast = drive.label(); toastUntil = simTime + 2;
          }
        }
      } else if (stop >= 0) {
        std::vector<int> dests = buses.destinations(stop);
        if (!dests.empty()) {
          if (nextItem) busDestSel++;
          if (prevItem) busDestSel--;
          int k = ((busDestSel % int(dests.size())) + int(dests.size())) % int(dests.size());
          prompt = "Ski bus to " + buses.stopName(dests[size_t(k)]) + "   ([ ] choose)";
          if (interact && buses.board(stop, dests[size_t(k)])) {
            interact = false;
            rideKind = Ride::Bus;
            BusLine::RideState rs = buses.rideState();
            player.sitOn(rs.seat, rs.fwd);
            viewBeforeRide = player.view; restoreView = true; player.view = Player::View::Third;
            rideCamReady = false; seatView = true; seatYaw = -0.35; seatPitch = -0.05;
            toast = "Ski bus to " + buses.stopName(dests[size_t(k)]); toastUntil = simTime + 2;
          }
        }
      } else if (rst >= 0) {
        bool down = input.down(Action::Back);
        prompt = railway.label(rst, down);
        bool railPaid = interact && (down || save.hasPass() || spend(transport.rail.price));
        if (railPaid && !railway.board(rst, !down) && !down && !save.hasPass()) save.money += transport.rail.price;   // (no train: refunded)
        else if (railPaid) {
          interact = false;
          rideKind = Ride::Rail;
          TrainRide tr = railway.ride();
          player.sitOn(tr.seat, tr.fwd);
          viewBeforeRide = player.view; restoreView = true; player.view = Player::View::Third;
          rideCamReady = false; seatView = false; seatYaw = 0; seatPitch = -0.04;   // (the outside view: the cabin's seat view is R)
          toast = transport.rail.name + (down ? std::string() : save.hasPass() ? std::string(" \xC2\xB7 Day pass") : " \xC2\xB7 -$" + std::to_string(transport.rail.price)); toastUntil = simTime + 2;
        }
      } else if (xst >= 0 && express.stationCount() > 1) {
        if (nextItem) expressDestSel++;
        if (prevItem) expressDestSel--;
        int n = int(express.stationCount()) - 1;
        int k = ((expressDestSel % n) + n) % n;
        int dest = k >= xst ? k + 1 : k;
        prompt = transport.express.name + " to " + express.station(dest).name + "   ([ ] choose)";
        bool xPaid = interact && (save.hasPass() || spend(transport.express.price));
        if (xPaid && !express.board(xst, dest)) { if (!save.hasPass()) save.money += transport.express.price; }
        else if (xPaid) {
          interact = false;
          rideKind = Ride::Express;
          TrainRide tr = express.ride();
          player.sitOn(tr.seat, tr.fwd);
          viewBeforeRide = player.view; restoreView = true; player.view = Player::View::Third;
          rideCamReady = false; seatView = false; seatYaw = 0; seatPitch = -0.04;
          toast = transport.express.name + " to " + express.station(dest).name + (save.hasPass() ? std::string(" \xC2\xB7 Day pass") : " \xC2\xB7 -$" + std::to_string(transport.express.price)); toastUntil = simTime + 2;
        }
      }
    }
    // (Phase 5) the police station / the prison, the medical centre, the chalets, the races (start houses, bus race boards,
    // the RACING stand), the job boards and a job's own spots
    if (started && rideKind == Ride::None && prompt.empty() && player.mode != PlayerMode::Sit && player.mode != PlayerMode::Fall && !races.active() && !police.arrestedNow()) {
      std::string p5;
      bool used = police.interact(p5, interact) || rescue.interact(p5, interact) || chalets.interact(p5, interact) || races.interact(p5, interact) || oddJobs.interact(p5, interact) ||
                  sleds.interact(p5, interact);
      if (sleds.active()) { rideKind = Ride::Sled; rig.skisInRide = false; }
      if (!p5.empty()) prompt = p5;
      if (used) interact = false;
    }
    if (started && !menus.isOpen() && !tmap.isOpen()) chalets.update(frameDt, cam, nav);
    // (Phase 4) the shops and counters on foot: the ski shop, the ticket seller, the Autohaus counter (your cars), the
    // huts; in your car at the Werkstatt: the repair
    if (rideKind == Ride::Car && werkstattLot && drive.speed() < 2.0 && prompt.rfind("Get out", 0) == 0) {
      dvec3 cp = drive.pos();
      double wx = werkstattLot->ex != 0 ? werkstattLot->ex : werkstattLot->x, wz = werkstattLot->ez != 0 ? werkstattLot->ez : werkstattLot->z;
      if (std::hypot(cp.x - wx, cp.z - wz) < 26 || std::hypot(cp.x - werkstattLot->x, cp.z - werkstattLot->z) < 26) {
        int fee = repairCost(drive.damage() / 100);
        prompt = fee > 0 ? "Werkstatt \xC2\xB7 repair " + fmtM(fee) : "Werkstatt \xC2\xB7 nothing to repair";
        if (interact && !menus.isOpen()) {
          interact = false;
          int idx = -1;
          for (size_t i = 0; i < drive.parked.size(); i++) if (drive.parked[i].driving) idx = int(i);
          openWerkstatt(idx);
        }
      }
    }
    if (rideKind == Ride::None && prompt.empty() && player.mode != PlayerMode::Sit && player.mode != PlayerMode::Fall && started) {
      auto near = [&](double x, double z, double r) { return std::hypot(player.pos.x - x, player.pos.z - z) < r; };
      if (near(-40, -18, 12)) { prompt = "Ski shop \xC2\xB7 skis and outfits"; if (interact) { interact = false; openSkiShop(); } }
      else if (near(15, -50, 7.5)) { prompt = "Ticket seller \xC2\xB7 day pass, gondola tickets"; if (interact) { interact = false; openTickets(); } }
      else if (transport.loaded() && near(transport.autohaus.x, transport.autohaus.z, 12)) { prompt = "Autohaus \xC2\xB7 my cars"; if (interact) { interact = false; openGarage(); } }
      else for (const Hut& h : huts) if (near(h.x, h.z, 13)) { prompt = h.name + " \xC2\xB7 hot chocolate $" + std::to_string(Prices::hotChocolate); if (interact) { interact = false; openHut(h.name); } break; }
    }
    if (rideKind == Ride::None && prompt.empty() && player.mode != PlayerMode::Sit && player.mode != PlayerMode::Fall && !lifts.lines().empty()) {
      Lifts::Station st = lifts.nearestStation(player.pos);
      if (st.line && st.dist < (st.line->gondola ? 20 : 13)) {
        prompt = stationLabel(st);
        if (st.mid) prompt += "  (" + std::string(input.down(Action::Back) ? "down" : "up") + ")";
        // a mid-station serves both ways: up by default, down while holding back (S)
        if (interact) boardLift(st, st.mid ? !input.down(Action::Back) : st.up);
      }
    }
    if (!opt.autotest && !paused) {
      double h0 = hour;
      hour = std::fmod(hour + frameDt * 24.0 / (16 * 60), 24.0);   // sky.js DAY_SECONDS
      if (hour < h0) { save.day++; save.markDirty(); }               // (main.js: midnight, a new day: the day pass runs out)
      save.hour = hour;
    }
    light = timeOfDay(hour, dayLight);
    { double t = (hour - 12) / 12 * PI; weather.apply(light, std::sin((28 * std::cos(t) + 4) * DEG)); }
    if (rooms.inside()) light = rooms.lighting(light);

    // streaming + animation
    player.cameraFor(cam);
    bool camUnderground = false;   // (a train's camera in a tunnel: the tunnel's darkness, no terrain drawn over it)
    if (rideKind == Ride::Car) drive.cameraFor(cam);
    else if ((rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express) && seatView) {
      // the seat view: your eyes over the seat, the mouse looks round (+-120 degrees), easing back ahead
      float lx = paused ? 0 : input.lookX(), ly = paused ? 0 : input.lookY();
      if (lx != 0 || ly != 0) { rideLookT = simTime; seatYaw = clamp(seatYaw - lx * 0.0022, -2.09, 2.09); seatPitch = clamp(seatPitch - ly * 0.0022, -1.0, 0.6); }
      if (simTime - rideLookT > 3) { seatYaw *= std::exp(-frameDt * 1.5); seatPitch += (-0.05 - seatPitch) * (1 - std::exp(-frameDt * 1.5)); }
      double fy = player.heading + seatYaw;
      camUnderground = rideKind != Ride::Bus && world.height(player.pos.x, player.pos.z) > player.pos.y + 6;
      dvec3 eye = player.renderPos + dvec3(0, 0.78, 0);
      cam.lookAt(eye, eye + dvec3(std::sin(fy) * std::cos(seatPitch), std::sin(seatPitch), std::cos(fy) * std::cos(seatPitch)));
      cam.fovY = 68; cam.nearZ = 0.05f;
    } else if (rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express) {
      // the chase camera behind the bus / train (bus.js chase: 18 m; railway.js 34 m; express.js 46 m), the mouse
      // looks round, easing back behind after 1.5 s
      dvec3 vp;
      double vyaw, dist, h;
      if (rideKind == Ride::Bus) { vp = buses.busPos(); vyaw = buses.busYaw(); dist = 16; h = 3; }
      else { TrainRide tr = rideKind == Ride::Rail ? railway.ride() : express.ride(); vp = tr.trainPos; vyaw = tr.trainYaw; dist = rideKind == Ride::Rail ? 30 : 40; h = 4; }
      float lx = paused ? 0 : input.lookX(), ly = paused ? 0 : input.lookY();
      if (lx != 0 || ly != 0) { rideLookT = simTime; rideCamYaw -= lx * 0.0022; rideCamPitch = clamp(rideCamPitch + ly * 0.0022, -0.05, 1.0); }
      double target = vyaw + PI, pitch0 = rideKind == Ride::Bus ? 0.15 : 0.3;   // (the trains run in cuttings: from higher up)
      if (!rideCamReady) { rideCamYaw = target; rideCamPitch = pitch0; }
      if (simTime - rideLookT > 1.5) { rideCamYaw += wrapPi(target - rideCamYaw) * (1 - std::exp(-frameDt * 2.5)); rideCamPitch += (pitch0 - rideCamPitch) * (1 - std::exp(-frameDt * 2)); }
      // (in a tunnel, the mountain over the train: close behind it in the tube, never up on the mountain)
      bool tube = rideKind != Ride::Bus && world.height(vp.x, vp.z) > vp.y + 6;
      camUnderground = tube;
      if (tube) dist = 13;
      double pitch = tube ? 0.1 : rideCamPitch;
      dvec3 focus = vp + dvec3(0, tube ? 2.5 : h, 0);
      dvec3 want = focus + dvec3(std::sin(rideCamYaw) * std::cos(pitch), std::sin(pitch), std::cos(rideCamYaw) * std::cos(pitch)) * dist;
      if (!tube) want.y = std::max(want.y, world.groundHeight(want.x, want.z, vp.y + 3) + 2.5);
      if (!rideCamReady || glm::length(want - rideCamPos) > 200) { rideCamPos = want; rideCamReady = true; }
      rideCamPos += (want - rideCamPos) * (1 - std::exp(-frameDt * 8));
      cam.lookAt(rideCamPos, focus);
      cam.fovY = 62; cam.nearZ = 0.2f;
    }
    if (rescue.carried()) rescue.camera(cam);
    if (rideKind == Ride::Sled) sleds.camera(cam, frameDt);
    // (Phase 4) the main menu's slow orbit over the village; the skier showcase (the skier on the plaza, turned by a
    // drag / the right stick, the camera off to the side so the menu column stays clear)
    menuT += frameDt;
    if (showcaseOn) {
      player.heading = showcaseYaw;
      dvec3 p = player.renderPos;
      dvec3 eye = p + dvec3(-3.4, 1.35, -1.2);
      dvec3 fw = glm::normalize(dvec3(p.x - eye.x, 0, p.z - eye.z)), right(-fw.z, 0, fw.x);
      cam.lookAt(eye, p + dvec3(0, 0.95, 0) - right * 0.9);   // (the skier right of the menu column)
      cam.fovY = 40; cam.nearZ = 0.05f;
    } else if (!started) {
      double ang = menuT * 0.035 + 0.6, R = 210;
      dvec3 c(10, world.height(10, -40) + 18, -40);
      dvec3 eye = c + dvec3(std::sin(ang) * R, 0, std::cos(ang) * R);
      eye.y = std::max(c.y + 55, world.height(eye.x, eye.z) + 30);
      cam.lookAt(eye, c);
      cam.fovY = 55; cam.nearZ = 0.2f;
    }
    if (toastUntil != toastShownUntil) {   // (the old toasts go to the HUD's flash line)
      toastShownUntil = toastUntil;
      bool bad = toast.find("Crash") != std::string::npos || toast.find("Too steep") != std::string::npos || toast.find("wrecked") != std::string::npos;
      if (!toast.empty()) flash(toast, bad ? Hud::Flash::Bad : Hud::Flash::Good);
    }
    // your cars: damage into the save (each change), the tow truck's returns, a car left on a road (towed after 60 s with
    // you far away: PARK_TOW_FEE)
    for (const auto& e : drive.parked)
      if (e.owned && !e.plate.empty())
        if (Save::Car* c = garageEntry(e.plate); c && std::fabs(c->damage - e.damage) > 0.01) { c->damage = e.damage; save.markDirty(); }
    for (size_t k = 0; k < tows.size();) {
      Tow& t = tows[k];
      int idx = -1;
      for (size_t i = 0; i < drive.parked.size(); i++) if (drive.parked[i].owned && drive.parked[i].plate == t.plate) idx = int(i);
      if (idx < 0) { tows.erase(tows.begin() + long(k)); continue; }
      Drive::Parked& e = drive.parked[size_t(idx)];
      if (e.driving || simTime < t.at) { k++; continue; }
      double bx, bz, byaw;   // (back to a free bay at the Autohaus car park)
      if (drive.freeBay(bx, bz, byaw)) { e.x = bx; e.z = bz; e.yaw = byaw; e.y = world.height(bx, bz) + 0.03; }
      if (t.why == "wreck") { e.wrecked = false; e.damage = 0; if (Save::Car* c = garageEntry(e.plate)) c->damage = 0; }
      save.markDirty();
      flash("Your " + e.spec->label + " is back at the Autohaus car park" + (t.why == "wreck" ? ", repaired" : ""), Hud::Flash::Good);
      tows.erase(tows.begin() + long(k));
    }
    // (Phase 5, impound.js) your car left empty on a road or out on the snow (not in a car park, a lay-by or the chalet
    // village), you 40 m or more away for 2 minutes: the tow truck fetches it (the wreck fee) to the impound row of the
    // Autohaus car park, where it stays locked until the next game day
    if (transport.loaded() && rideKind != Ride::Car && started) {
      leftOnRoadT += frameDt;
      if (leftOnRoadT > 1) {
        leftOnRoadT = 0;
        static std::unordered_map<std::string, double> away;
        for (auto& e : drive.parked) {
          if (!e.owned || e.driving || e.wrecked || e.plate.empty() || e.impoundDay > save.day) continue;
          bool onRoad = transport.laneDistance(e.x, e.z) < 4.2;
          bool inLot = false;
          for (const Lot& L : transport.lots) inLot = inLot || std::hypot(e.x - L.x, e.z - L.z) < std::max(L.hw, L.hd) + 3;
          for (const dvec3& lb : transport.laybys) inLot = inLot || std::hypot(e.x - lb.x, e.z - lb.y) < 12;
          for (const ChaletHouse& ch : playData.chalets) inLot = inLot || std::hypot(e.x - ch.x, e.z - ch.z) < 16;
          bool offRoads = !onRoad && !inLot && transport.laneDistance(e.x, e.z) > 6;
          double& t = away[e.plate];
          if ((onRoad || offRoads) && !inLot && std::hypot(e.x - player.pos.x, e.z - player.pos.z) >= 40) t += 1; else t = 0;
          if (t >= 120) {
            t = 0;
            save.spend(WRECK_FEE, true);
            double bx, bz, byaw;
            if (drive.freeBay(bx, bz, byaw)) { e.x = bx; e.z = bz; e.yaw = byaw; e.y = world.height(bx, bz) + 0.03; }
            e.impoundDay = save.day + 1;
            nlohmann::json& imp = save.data("impound", nlohmann::json::array());
            imp.push_back({{"plate", e.plate}, {"day", e.impoundDay}});
            save.markDirty();
            flash("Your " + e.spec->label + " was towed to the impound (Autohaus car park) \xC2\xB7 -" + fmtM(WRECK_FEE) + " \xC2\xB7 available tomorrow", Hud::Flash::Bad);
          }
        }
        // (the next day: free again)
        nlohmann::json& imp = save.data("impound", nlohmann::json::array());
        for (size_t k = 0; k < imp.size();) { if (imp[k].value("day", 0) <= save.day) { imp.erase(k); save.markDirty(); } else k++; }
      }
    }
    save.clock = simTime;
    save.tick(*plat, simTime, opt.autotest ? 1e9 : 60);
    terrain.update(cam.pos);
    scenery.update(cam.pos);
    resort.update(frameDt, cam.pos);
    rig.update(frameDt, player, world);
    scenery.dynamic.clear();
    if (transport.loaded()) {
      drive.fillColliders(scenery.dynamic);
      traffic.fillColliders(scenery.dynamic);
      buses.fillColliders(scenery.dynamic);
      railway.fillColliders(scenery.dynamic, player.pos);
      express.fillColliders(scenery.dynamic, player.pos);
      police.fillColliders(scenery.dynamic);
      sleds.fillColliders(scenery.dynamic);
    }
    rooms.fillColliders(scenery.dynamic);

    // render (the autotest's walking / riding phases draw every 4th frame: llvmpipe is slow)
    bool pngVillage = opt.autotest && at == AT::Collide && phaseFrame == 59;
    bool pngRide = opt.autotest && at == AT::Lift && boarded && !ridePng && rideT >= 12;
    bool rendered = !(opt.autotest && at != AT::Ski && at != AT::Menu && at != AT::Map) || phaseFrame % (at == AT::Race ? 8 : 4) == 0 || pngVillage || pngRide;
    if (const char* shot = std::getenv("SKI_LEGACY_SHOT"); shot && at == AT::Ski) {   // (debug: a fixed camera "x,y,z,tx,ty,tz")
      double v[6] = {0};
      if (std::sscanf(shot, "%lf,%lf,%lf,%lf,%lf,%lf", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) == 6) {
        cam.lookAt(dvec3(v[0], v[1], v[2]), dvec3(v[3], v[4], v[5]));
        cam.fovY = 60;
        terrain.update(cam.pos);
        scenery.update(cam.pos);
        resort.update(0, cam.pos);
      }
    }
    if (off("sidecam") && player.mode == PlayerMode::Sit && lifts.rideLine()) {   // (debug: look at the rider from the side)
      LiftLine* rl = lifts.rideLine();
      dvec3 sv(rl->sideV.x, 0, rl->sideV.y);
      cam.lookAt(player.renderPos + sv * 7.0 + dvec3(0, 0.5, 0), player.renderPos);
    }
    // (Phase 4) the 2D layer: HUD, menus / dialogs, the trail map (drawn after the 3D frame)
    ui.begin(renderer.width(), renderer.height());
    if (started && !tmap.isOpen() && !menus.isOpen()) {
      HudFrame hf;
      hf.speed = rideKind == Ride::Car ? drive.speed() : rideKind == Ride::Bus ? buses.rideSpeed() : rideKind == Ride::Rail ? railway.ride().speed : rideKind == Ride::Express ? express.ride().speed : player.speed();
      hf.speedo = player.mode != PlayerMode::Sit || rideKind == Ride::Car || rideKind == Ride::Sled;
      if (rideKind == Ride::Sled) hf.speed = sleds.speed();
      hf.hour = hour;
      hf.fps = float(fps);
      hf.prompt = menus.isOpen() ? std::string() : prompt;
      hf.promptKey = prompts::K(input, Action::Interact);
      hf.rideHint = rideLine;
      if (rideKind == Ride::Car) hf.skiName = drive.label();
      else if (rideKind == Ride::Sled) hf.skiName = "Snowmobile";
      else if (const SkiDef* sk = skiById(save.skis)) hf.skiName = sk->name;
      // where you are (trailmap.js locationName, condensed): riding, the village, the nearest run, the backcountry
      if (rideKind == Ride::None && player.mode == PlayerMode::Sit && lifts.rideLine()) hf.location = lifts.rideLine()->name;
      else if (std::hypot(player.pos.x, player.pos.z + 20) < 260) hf.location = "Legacy Village";
      else {
        double bd = 45;
        for (const Piste& ps : pistes) for (size_t i = 0; i < ps.pts.size(); i += 2) { double d = glm::length(ps.pts[i] - dvec2(player.pos.x, player.pos.z)); if (d < bd) { bd = d; hf.location = ps.name; } }
        if (hf.location.empty()) hf.location = rideKind == Ride::Car || transport.laneDistance(player.pos.x, player.pos.z) < 6 ? "On the road" : "Backcountry";
      }
      if (save.skis.empty()) hf.objective = "Rent skis at the ski shop in Legacy Village";
      else if (!save.hasPass() && save.tickets <= 0 && save.day == 1 && save.stats.distance < 200) hf.objective = "Buy a day pass or ride a lift";
      if (tmap.mark.on) {
        hf.waypoint = true;
        hf.wpLabel = tmap.mark.label;
        hf.wpDist = std::hypot(tmap.mark.x - player.pos.x, tmap.mark.z - player.pos.z);
        double camYaw = std::atan2(double(cam.forward().x), double(cam.forward().z));
        hf.wpAngle = wrapPi(std::atan2(tmap.mark.x - player.pos.x, tmap.mark.z - player.pos.z) - camYaw);
        hf.wpAngle = -hf.wpAngle;   // (screen: + = right)
        if (hf.wpDist < 25) tmap.mark.on = false;
      }
      hf.weather = weather.label();
      hf.forecast = weather.forecast();
      {
        std::string o5 = police.objective();
        if (o5.empty()) o5 = rescue.objective();
        if (o5.empty()) o5 = races.objective();
        if (o5.empty()) o5 = oddJobs.objective();
        if (o5.empty()) o5 = chalets.objective();
        if (!o5.empty()) hf.objective = o5;
        if (rooms.room() == Interiors::Room::Prison) hf.location = "Polizei \xC2\xB7 Legacy Village";
        else if (rooms.room() == Interiors::Room::Hospital) hf.location = "Medical centre";
        else if (rooms.room() == Interiors::Room::Chalet) hf.location = "Chalet village";
        if (races.active()) hf.waypoint = false;
      }
      hud.draw(ui, hf, save, input, simTime);
      float u5 = std::clamp(std::min(float(renderer.height()) / 800.f, float(renderer.width()) / 1280.f), 0.55f, 2.2f) * float(save.setting("hudScale", 1));
      races.hud(ui, u5);
      oddJobs.hud(ui, u5);
      police.hud(ui, u5);
      rescue.hud(ui, u5);
      chalets.hud(ui, u5);
    }
    menus.loading.clear();
    menus.frame(nav, frameDt, simTime);
    if (tmap.isOpen()) {
      int carIdx = -1;
      for (size_t i = 0; i < drive.parked.size(); i++) if (drive.parked[i].owned && !drive.parked[i].plate.empty() && (carIdx < 0 || drive.parked[i].driving)) carIdx = int(i);
      dvec3 carPos = carIdx >= 0 ? dvec3(drive.parked[size_t(carIdx)].x, 0, drive.parked[size_t(carIdx)].z) : dvec3(0);
      tmap.frame(ui, nav, input, frameDt, rideKind == Ride::Car ? drive.pos() : player.pos, rideKind == Ride::Car ? drive.yaw() : player.heading, carIdx >= 0 ? &carPos : nullptr);
      if (!tmap.isOpen() && started && !opt.autotest) plat->setRelativeMouse(true);
    }
    if (fadeT >= 0) {   // (transition.js: a short fade to dark and back over a teleport)
      fadeT += frameDt;
      float a = fadeT < 0.12 ? 1.f : float(std::max(0.0, 1 - (fadeT - 0.12) / 0.45));
      ui.rect(0, 0, float(renderer.width()), float(renderer.height()), vec4(0.01f, 0.02f, 0.05f, a));
      if (fadeT > 0.6) fadeT = -1;
    }
    if (rendered) {
    Lighting frameLight = light;
    if (camUnderground) {   // railway.js lateUpdate: deep in a tunnel the sun and the sky fade out; the lamps and the cabin carry the light
      frameLight.zenith = frameLight.mid = frameLight.horizon = frameLight.glow = frameLight.fog = vec3(0.004f, 0.005f, 0.007f);
      frameLight.sunIntensity *= 0.03f; frameLight.sky *= 0.25f; frameLight.ground *= 0.25f;
    }
    renderer.beginFrame(cam, frameLight, player.renderPos);
    bool indoor = rooms.inside();
    if (drawTerrain && !camUnderground && !indoor) terrain.submit(renderer);
    if (!indoor) scenery.submit(renderer, drawTrees && !camUnderground, drawVillage && !haveResort);
    if (drawVillage && !indoor) resort.submit(renderer);
    if (drawVillage && !indoor) sweep.submit(renderer, cam.pos);
    if (drawVillage && !indoor) {
      vdraw.begin();
      drive.addDraw(vdraw, cam.pos);
      traffic.addDraw(vdraw, cam.pos);
      buses.addDraw(vdraw, cam.pos);
      railway.addDraw(vdraw, cam.pos);
      express.addDraw(vdraw, cam.pos);
      police.addDraw(vdraw, cam.pos);
      rescue.addDraw(vdraw, cam.pos);
      sleds.addDraw(vdraw, cam.pos);
      vdraw.submit(renderer, *dev, cam.pos);
    }
    // (Phase 5) the interiors; outside the job boards, the race pieces, the police, the rescue, the chalets; the people;
    // the falling snow
    if (indoor) rooms.draw(renderer);
    else if (drawVillage) {
      oddJobs.draw(renderer, cam.pos, jobBoard.get());
      races.draw(renderer, cam.pos);
      police.draw(renderer, cam.pos);
      rescue.draw(renderer, cam.pos);
    }
    if (drawVillage) chalets.draw(renderer, cam.pos);
    people.begin();
    if (!indoor) {
      folk.add(people, cam.pos);
      races.addPeople(people, cam.pos);
      oddJobs.addPeople(people, cam.pos);
    }
    police.addPeople(people, cam.pos);
    people.submit(renderer, cam.pos, opt.autotest ? 28 : 48);
    weather.drawSnow(renderer, snowDraw, *dev, shapes, cam, frameDt, indoor || camUnderground);
    bool hideRig = (player.view == Player::View::First && player.mode != PlayerMode::Fall) || (rideKind == Ride::Car && drive.cockpit()) ||
                   ((rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express) && seatView) || rescue.carried();
    railway.insideView = rideKind == Ride::Rail && seatView;
    express.insideView = rideKind == Ride::Express && seatView;
    if (drawSkier) rig.submit(renderer, hideRig);

    renderer.endFrame();
    ui.end();
    }

    frame++;
    fpsN++;
    fpsT += plat->timeSeconds() - now;
    if (fpsT > 0.5 || (opt.autotest && fpsN >= 20)) { fps = fpsN / std::max(1e-6, fpsT); fpsN = 0; fpsT = 0; }
    if (opt.autotest) {
      if (!pendingPng.empty() && rendered) { writePng(renderer, pendingPng); pendingPng.clear(); }
      phaseFrame++;
      if (at == AT::Ski) {
        if ((frame - skiFrame0) % 100 == 0 || frame == skiFrame0 + 1)
          SL_INFO("[autotest] frame %4d  t=%5.2fs  pos=(%8.1f, %7.1f, %8.1f)  speed=%5.1f km/h  %-5s  fps=%5.1f  terrain=%zu trees=%zu draws=%u",
                  frame, simTime, player.pos.x, player.pos.y, player.pos.z, player.speed() * 3.6, player.modeName(), fps,
                  terrain.nodeCount(), scenery.treesDrawn(), renderer.drawCalls());
        if (frame - skiFrame0 >= opt.frames) {
          if (!opt.png.empty()) writePng(renderer, opt.png);
          skiDist = player.distance - skiDistStart;
          skiDrop = startPos.y - player.pos.y;
          bool finite = std::isfinite(player.pos.x) && std::isfinite(player.pos.y) && std::isfinite(player.pos.z);
          skiOk = finite && (onPiste ? skiDist > 50 && skiDrop > 5 : true);
          SL_INFO("[autotest] skied %.0f m along the run (%.0f m from the start), dropped %.0f m, top speed %.1f km/h, final %.1f km/h, %d landings, %d crashes, mode %s",
                  skiDist, glm::length(dvec2(player.pos.x - startPos.x, player.pos.z - startPos.z)), skiDrop, maxSpeed * 3.6, player.speed() * 3.6, nLand, nCrash, player.modeName());
          at = haveResort ? AT::Collide : AT::Done;
          phaseFrame = 0;
        }
      } else if (at == AT::Collide) {
        if (phaseFrame >= 60 || !hotel) {
          bool inside = false;
          if (hotel) {
            double cs = std::cos(-hotel->rot), sn = std::sin(-hotel->rot);
            double lx = (player.pos.x - hotel->x) * cs - (player.pos.z - hotel->z) * sn, lz = (player.pos.x - hotel->x) * sn + (player.pos.z - hotel->z) * cs;
            inside = std::fabs(lx) < hotel->hw + 0.3 && std::fabs(lz) < hotel->hd + 0.3;
            double walked = glm::length(dvec2(player.pos.x - walkStart.x, player.pos.z - walkStart.z));
            collideOk = !inside && walked > 2;
            SL_INFO("[autotest] collision: walked %.1f m toward the hotel for 6 s, stopped at (%.1f, %.1f), %s the building -> %s", walked,
                    player.pos.x, player.pos.z, inside ? "INSIDE" : "outside", collideOk ? "blocked by its wall" : "NOT blocked");
            if (!opt.png.empty()) writePng(renderer, pngVariant(opt.png, "village"));
          }
          input.releaseInjected();
          at = AT::Lift;
          phaseFrame = 0;
        }
      } else if (at == AT::Lift) {
        if (!boarded && player.mode == PlayerMode::Sit) {
          boarded = true; rideP0 = lifts.rideProgress();
          SL_INFO("[autotest] lift: boarded %s (%s, %.0f m, %.0f m/s, %zu cabins)", testLine->name.c_str(), testLine->type.c_str(), testLine->L, testLine->cfg.speed, testLine->s.size());
          int price = testLine->price > 0 ? testLine->price : Prices::gondola;
          bool paid = save.money == liftMoney0 - price;
          chargeOk = chargeOk && paid;
          SL_INFO("[autotest] lift ticket: $%lld -> $%lld (the %s's price $%d, no day pass) -> %s", (long long)liftMoney0, (long long)save.money, testLine->name.c_str(), price, paid ? "ok" : "FAILED");
        }
        if (boarded && !gotOff) {
          if (player.mode == PlayerMode::Sit) {
            rideT += frameDt;
            rideP1 = lifts.rideProgress();
            if (phaseFrame % 25 == 0)
              SL_INFO("[autotest] ride t=%5.1fs  progress %5.1f%%  seat=(%8.1f, %7.1f, %8.1f)  x%.0f%s", rideT, rideP1 * 100,
                      player.pos.x, player.pos.y, player.pos.z, lifts.timeScale, prompt.empty() ? "" : ("  [" + prompt + "]").c_str());
            if (pngRide && rendered) { ridePng = true; if (!opt.png.empty()) writePng(renderer, pngVariant(opt.png, "ride")); }
          } else {
            gotOff = true;
            expectExit = testLine->midExit;
            double dExit = std::hypot(player.pos.x - expectExit.x, player.pos.z - expectExit.z);
            double dTop = std::hypot(player.pos.x - testLine->exitUp.x, player.pos.z - testLine->exitUp.z);
            SL_INFO("[autotest] lift: off after %.1f s riding (%.1f%% -> %.1f%%) at (%.1f, %.1f, %.1f), %.1f m from the mid-station exit, %.1f m from the top exit, mode %s",
                    rideT, rideP0 * 100, rideP1 * 100, player.pos.x, player.pos.y, player.pos.z, dExit, dTop, player.modeName());
            liftOk = rideT >= 30 && rideP1 > rideP0 && std::min(dExit, dTop) < 1.0 && player.mode != PlayerMode::Sit;
          }
        }
        if (gotOff || !testLine || phaseFrame > 900 || (!boarded && phaseFrame > 10)) {
          if (!boarded) { liftOk = false; SL_WARN("[autotest] lift: could not board (prompt '%s')", prompt.c_str()); }
          else if (!gotOff) { liftOk = false; SL_WARN("[autotest] lift: still riding after %.0f s", rideT); }
          at = transport.loaded() ? AT::Drive : AT::Done;
          phaseFrame = 0;
          input.releaseInjected();
        }
      }
      // ---- (Phase 3) driving 20 s on a road, the traffic, the bus, the Wolkenspitzbahn, the Legacy Express
      else if (at == AT::Drive) {
        if (drive.active()) {
          dvec3 p = drive.pos();
          driveT += frameDt;
          driveDist += glm::length(dvec2(p.x - drivePrev.x, p.z - drivePrev.z));
          drivePrev = p;
          driveTop = std::max(driveTop, drive.speed());
          double g = world.groundHeight(p.x, p.z, p.y + 1);
          if (!drive.air()) driveMaxSink = std::max(driveMaxSink, g - p.y);
          if (phaseFrame % 20 == 0)
            SL_INFO("[autotest] drive t=%5.1fs  pos=(%8.1f, %7.1f, %8.1f)  ground %7.1f  speed=%5.1f km/h  %s  limit %d  lane %.1f m", driveT, p.x, p.y, p.z, g,
                    drive.speed() * 3.6, drive.label().c_str(), transport.speedLimitAt(p.x, p.z), transport.laneDistance(p.x, p.z));
          if (rendered && driveT >= 12 && driveT < 12.4 && !opt.png.empty()) writePng(renderer, pngVariant(opt.png, "drive"));
        }
        if (driveT >= 20 || phaseFrame > 400 || (!drive.active() && phaseFrame > 10)) {
          bool finite = std::isfinite(drive.pos().x) && std::isfinite(drive.pos().y);
          driveOk = drive.active() && finite && driveDist > 100 && driveTop > 30 / 3.6 && driveMaxSink < 0.5;
          SL_INFO("[autotest] drive: %.0f m in %.1f s, top %.1f km/h, deepest below the ground %.2f m, damage %.0f%% -> %s", driveDist, driveT, driveTop * 3.6,
                  driveMaxSink, drive.damage(), driveOk ? "ok" : "FAILED");
          // the traffic: a car that drove along its lane meanwhile
          double moved = 0, lane = 0;
          for (size_t k = 0; k < traffic.list.size() && k < traffic0.size(); k++) {
            const auto& c = traffic.list[k];
            if (c.mode != Traffic::Car::Mode::Road) continue;
            double m = c.odo - traffic0[k].x;   // (metres driven along its lane; a car recycled meanwhile keeps its odometer)
            if (m > moved) { moved = m; lane = transport.laneDistance(c.x, c.z); }
          }
          trafficOk = moved > 50 && lane < 4.5;
          SL_INFO("[autotest] traffic: %zu cars, %d driving; the furthest moved %.0f m along its road, %.1f m off the centre line (its lane: 1.6 m) -> %s",
                  traffic.list.size(), traffic.movingCount(), moved, lane, trafficOk ? "ok" : "FAILED");
          if (drive.active()) { drive.stopNow(); dvec3 ex; if (drive.exit(ex)) standOff(ex, "Parked"); }
          at = AT::Bus; phaseFrame = 0; input.releaseInjected(); rideTest = 0; rideBoarded = false;
        }
      } else if (at == AT::Bus || at == AT::Rail || at == AT::Express) {
        const char* what = at == AT::Bus ? "bus" : at == AT::Rail ? "train" : "express";
        Ride want = at == AT::Bus ? Ride::Bus : at == AT::Rail ? Ride::Rail : Ride::Express;
        if (phaseFrame == 1) {
          dvec3 to(0);
          bool okp = false;
          if (at == AT::Bus && !transport.stops.empty()) { to = dvec3(transport.stops[0].x + 2, 0, transport.stops[0].z + 2); okp = true; }
          if (at == AT::Rail && transport.rail.ok && transport.rail.stations[0].hasBoard) { to = dvec3(transport.rail.stations[0].board.x, 0, transport.rail.stations[0].board.y); okp = true; }
          if (at == AT::Express && transport.express.ok && transport.express.stations[0].hasBoard) { to = dvec3(transport.express.stations[0].board.x, 0, transport.express.stations[0].board.y); okp = true; }
          if (okp) { player.setSkisOn(false); player.teleport(to.x, to.z, 0); SL_INFO("[autotest] %s: at (%.1f, %.1f), prompt next frame", what, to.x, to.z); }
        }
        input.inject(Action::Interact, phaseFrame == 3);
        if (phaseFrame == 4 && rideKind != want) SL_WARN("[autotest] %s: could not board (prompt '%s')", what, prompt.c_str());
        if (rideKind == want) {
          TrainRide tr;
          dvec3 vp;
          double sp;
          if (at == AT::Bus) { vp = buses.busPos(); sp = buses.rideSpeed(); }
          else { tr = at == AT::Rail ? railway.ride() : express.ride(); vp = tr.trainPos; sp = tr.speed; }
          if (!rideBoarded) { rideBoarded = true; ridePos0 = vp; SL_INFO("[autotest] %s: boarded (%s)", what, rideLine.c_str()); }
          rideTest += frameDt;
          // (the Wolkenspitzbahn waits 20 s at the valley station: then x6 after 10 s, as Space does)
          input.inject(Action::Jump, (at == AT::Rail && rideTest > 10) || (at == AT::Express && rideTest > 17));
          if (phaseFrame % 25 == 0) SL_INFO("[autotest] %s t=%5.1fs  at (%8.1f, %7.1f, %8.1f)  %5.1f km/h  seat y %.1f  [%s]", what, rideTest, vp.x, vp.y, vp.z, sp * 3.6, player.pos.y, rideLine.c_str());
          // (the seat view first, then R: the outside view)
          if (rendered && rideTest >= 11 && rideTest < 11.4 && !opt.png.empty()) writePng(renderer, pngVariant(opt.png, (std::string(what) + (seatView ? "_seat" : "")).c_str()));
          input.inject(Action::View, rideTest >= 13 && rideTest < 13.1);
          if (rendered && rideTest >= 15 && rideTest < 15.4 && !opt.png.empty()) writePng(renderer, pngVariant(opt.png, (std::string(what) + (seatView ? "_seat" : "")).c_str()));
        }
        double limit = at == AT::Rail ? 32 : 24;
        if (rideTest >= limit || phaseFrame > 600 || (phaseFrame > 6 && rideKind != want)) {
          dvec3 vp = at == AT::Bus ? buses.busPos() : at == AT::Rail ? railway.ride().trainPos : express.ride().trainPos;
          double moved = rideBoarded ? glm::length(vp - ridePos0) : 0;
          bool ok = rideBoarded && moved > (at == AT::Bus ? 25 : 60) && std::isfinite(player.pos.y);
          SL_INFO("[autotest] %s: rode %.1f s, moved %.0f m -> %s", what, rideTest, moved, ok ? "ok" : "FAILED");
          if (at == AT::Bus) busOk = ok; else if (at == AT::Rail) railOk = ok; else expressOk = ok;
          if (rideKind == want) {
            if (at == AT::Bus) buses.abort(); else if (at == AT::Rail) railway.abort(); else express.abort();
            dvec3 p = player.pos;
            standOff(dvec3(p.x + 6, p.z + 6, 0), "");
          }
          input.releaseInjected();
          at = at == AT::Bus ? AT::Rail : at == AT::Rail ? AT::Express : AT::Map;
          phaseFrame = 0; rideTest = 0; rideBoarded = false;
        }
      }
      else if (at == AT::Map) {
        // (Phase 4) the trail map: opened with the map key, relief ready, zoomed in, closed
        if (phaseFrame == 4 && !tmap.isOpen()) { mapOk = false; SL_WARN("[autotest] map: the map key did not open the trail map"); }
        if (phaseFrame == 6 && !tmap.reliefReady()) SL_INFO("[autotest] map: waiting for the relief");
        if (phaseFrame >= 6 && phaseFrame < 200 && !tmap.reliefReady()) phaseFrame = 6;   // (the relief's worker jobs)
        if (phaseFrame == 24) {
          mapOk = mapOk && tmap.isOpen() && tmap.reliefReady() && tmap.drawnItems > 40;
          SL_INFO("[autotest] map: open, relief ready %s, %d items drawn, hover '%s' -> %s", tmap.reliefReady() ? "yes" : "no", tmap.drawnItems, tmap.hover.c_str(), mapOk ? "ok" : "FAILED");
          if (!opt.png.empty() && rendered) writePng(renderer, pngVariant(opt.png, "map"));
        }
        if (phaseFrame == 33) {
          if (tmap.isOpen()) { mapOk = false; SL_WARN("[autotest] map: cancel did not close it"); }
          at = AT::Race; phaseFrame = 0;
        }
      }
      if (at == AT::Done) running = false;
    }
    if (rendered) plat->swapBuffers();
    if (fpsCap > 0 && !opt.autotest) {   // (SETTINGS: frame rate limit)
      double spent = plat->timeSeconds() - now, want = 1.0 / fpsCap;
      if (spent < want) std::this_thread::sleep_for(std::chrono::microseconds(int64_t((want - spent) * 1e6)));
    }
  }
  if (!opt.autotest) save.write(*plat);

  if (opt.autotest) {
    double wall = plat->timeSeconds() - startT;
    bool ok = skiOk && collideOk && liftOk && driveOk && trafficOk && busOk && railOk && expressOk && menuOk && settingOk && buyOk && saveOk && mapOk && chargeOk &&
              raceOk && jobOk && policeOk && chaletOk && weatherOk && sledOk;
    SL_INFO("[autotest] %d frames (%.1f s simulated) in %.1f s wall: avg %.1f fps", frame, simTime, wall, frame / wall);
    SL_INFO("[autotest] ski %s, building collision %s, gondola ride %s", skiOk ? "ok" : "FAILED", collideOk ? "ok" : "FAILED", liftOk ? "ok" : "FAILED");
    SL_INFO("[autotest] drive %s, traffic %s, bus %s, Wolkenspitzbahn %s, Legacy Express %s", driveOk ? "ok" : "FAILED", trafficOk ? "ok" : "FAILED",
            busOk ? "ok" : "FAILED", railOk ? "ok" : "FAILED", expressOk ? "ok" : "FAILED");
    SL_INFO("[autotest] menus %s, settings %s, shop %s, save / reload %s, lift / car charges %s, trail map %s", menuOk ? "ok" : "FAILED", settingOk ? "ok" : "FAILED",
            buyOk ? "ok" : "FAILED", saveOk ? "ok" : "FAILED", chargeOk ? "ok" : "FAILED", mapOk ? "ok" : "FAILED");
    SL_INFO("[autotest] race + records %s, job %s, police chase + jail %s, chalet + furniture %s, weather %s, snowmobile %s (people drawn %zu)", raceOk ? "ok" : "FAILED", jobOk ? "ok" : "FAILED",
            policeOk ? "ok" : "FAILED", chaletOk ? "ok" : "FAILED", weatherOk ? "ok" : "FAILED", sledOk ? "ok" : "FAILED", people.drawn());
    SL_INFO("[autotest] %s", ok ? "PASS" : "FAIL");
    audio.stop(*plat);
    return ok ? 0 : 1;
  }
  audio.stop(*plat);
  return 0;
}

} // namespace sl
