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
#include "game/cartest.h"
#include "game/traffic.h"
#include "game/trains.h"
#include "game/economy.h"
#include "game/hud.h"
#include "game/intro.h"
#include "game/transition.h"
#include "game/menus.h"
#include "game/carconfigui.h"
#include "game/popups.h"
#include "game/shopui.h"
#include "game/trailmap.h"
#include "game/uitest.h"
#include "game/play.h"
#include "game/play_data.h"
#include "game/people.h"
#include "game/shapes.h"
#include "game/weather.h"
#include "world/groundmap.h"
#include "game/interiors.h"
#include "game/outfitshop.h"
#include "game/shoproom.h"
#include "game/werkstatt.h"
#include "game/window_view.h"
#include "game/presentation.h"
#include "game/races.h"
#include "game/jobs.h"
#include "game/police.h"
#include "game/heli.h"
#include "game/hospital_ward.h"
#include "game/chalets.h"
#include "game/snowmobile.h"
#include "game/mp_session.h"
#include "game/mp_view.h"
#include "game/scenefx.h"
#include "game/showroom.h"
#include "net/websocket.h"
#include "core/prompts.h"
#include "core/perf.h"
#include "engine/ui.h"
#include "world/scenery.h"
#include "world/snowtrails.h"
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
  // the rocks (vegetation.js genCell, ported in world/scenery.cpp): the reference cells' rocks placed again here and
  // matched one by one: the same grid point (an elongated rock's extra colliders within 30 cm: their side follows the
  // slope's contour), model and collision size. Their tops follow the terrain, so they differ as `height` does: checked
  // to 0.3 m outside the courses' regions, only reported inside them: there the C++ terrain is the exported 8 m grid
  // (metres off the JS in places), so slope bands and ridges decide differently. The decisions that read the terrain
  // can flip for a rock right at a threshold: outside the regions 97 % must match.
  std::vector<uint8_t> rb;
  if (paths.readData(p, "rocks_ref.json", rb)) {
    auto rj = nlohmann::json::parse(rb.begin(), rb.end(), nullptr, false);
    size_t nJs = 0, nCpp = 0, matched = 0, nTop = 0, topOk = 0, nOut = 0, matchedOut = 0, nCppOut = 0;
    double eTop = 0, eTopReg = 0;
    int shown = 0;
    std::vector<Rock> mine;
    if (!rj.is_discarded())
      for (auto& c : rj["cells"]) {
        Scenery::cellRocks(world, nullptr, c[0].get<int64_t>(), c[1].get<int64_t>(), mine);
        nCpp += mine.size();
        for (const Rock& k : mine) if (!world.inRegion(k.x, k.z)) nCppOut++;
        std::vector<bool> used(mine.size(), false);
        for (auto& r : c[2]) {
          nJs++;
          double x = r[0], z = r[1], s = r[3], top = r[4];
          int v = r[2];
          const double tol = v < 0 ? 0.3 : 1e-3;
          const bool reg = world.inRegion(x, z);
          if (!reg) nOut++;
          bool found = false;
          for (size_t i = 0; i < mine.size(); i++) {
            const Rock& k = mine[i];
            if (used[i] || k.v != v || std::fabs(k.x - x) > tol || std::fabs(k.z - z) > tol || std::fabs(double(k.s) - s) > 1e-3) continue;
            used[i] = found = true;
            matched++;
            if (!reg) matchedOut++;
            double dt = std::fabs(double(k.y) + 0.75 * k.s - top);
            if (reg) eTopReg = std::max(eTopReg, dt);
            else { nTop++; eTop = std::max(eTop, dt); if (dt < 0.3) topOk++; }
            break;
          }
          if (!found && !reg && shown++ < 8) SL_INFO("    rock (%.2f, %.2f) model %d size %.2f: not placed by the C++", x, z, v, s);
        }
        for (size_t i = 0; i < mine.size(); i++)
          if (!used[i] && !world.inRegion(mine[i].x, mine[i].z) && shown++ < 8) SL_INFO("    rock (%.2f, %.2f) model %d size %.2f: only in the C++", mine[i].x, mine[i].z, int(mine[i].v), double(mine[i].s));
      }
    double share = nOut ? double(matchedOut) / double(nOut) : 0, topShare = nTop ? double(topOk) / double(nTop) : 0;
    SL_INFO("  rocks: %zu reference cells, %zu JS rocks, %zu C++ rocks, %zu matched (%.1f %%)", rj.is_discarded() ? size_t(0) : rj["cells"].size(),
            nJs, nCpp, matched, nJs ? 100.0 * double(matched) / double(nJs) : 0.0);
    SL_INFO("  rocks outside the courses' regions: %zu JS, %zu C++, %zu matched (%.1f %%), top within 0.3 m %zu / %zu (max %.3f m); in the regions (8 m grid) top max %.3f m",
            nOut, nCppOut, matchedOut, share * 100, topOk, nTop, eTop, eTopReg);
    bool rocksOk = nOut > 0 && share >= 0.97 && nCppOut <= nOut + nOut / 30 && topShare >= 0.97;
    if (!rocksOk) SL_WARN("  rocks: the C++ placement does not match the JS");
    ok = ok && rocksOk;
  } else SL_INFO("  rocks: no data/rocks_ref.json (node native/tools/export_rocks.mjs): not compared");
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
  L.trueSun = sun; L.moonDir = moon;   // (the renderer's sky model)
  L.zenith = mix3(ZEN); L.mid = mix3(MID); L.horizon = mix3(HOR); L.glow = mix3(GLO); L.fog = mix3(FOG);
  L.sunColor = mix3(SUN);
  L.sunIntensity = SUNI[i] + (SUNI[i + 1] - SUNI[i]) * f;
  float moonK = float(1 - smoothstep(-0.12, 0.0, h));
  if (moonK > 0 && moon.y > 0.05f && L.sunIntensity < 0.3f) {
    L.sunDir = moon;
    L.sunColor = vec3(0.68f, 0.77f, 1.0f);   // (cool moonlight, less saturated than sky.js's navy (0.5, 0.64, 1))
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

namespace {
// three.js CatmullRomCurve3(points, closed = true, 'centripetal') with getPointAt(u): the curve read by arc length
// (200 divisions, as three.js's arcLengthDivisions)
struct PanoCurve {
  std::vector<dvec3> pts;
  std::vector<double> lens;   // cumulative chord lengths at t = i / 200
  explicit PanoCurve(std::vector<dvec3> p) : pts(std::move(p)) {
    lens.push_back(0);
    dvec3 last = point(0);
    for (int i = 1; i <= 200; i++) { dvec3 c = point(i / 200.0); lens.push_back(lens.back() + glm::length(c - last)); last = c; }
  }
  dvec3 point(double t) const {
    const int l = int(pts.size());
    double p = l * t;
    int ip = int(std::floor(p));
    double w = p - ip;
    auto at = [&](int i) { return pts[size_t(((i % l) + l) % l)]; };
    dvec3 p0 = at(ip - 1), p1 = at(ip), p2 = at(ip + 1), p3 = at(ip + 2);
    // non-uniform Catmull-Rom, alpha 0.5 (three.js initNonuniformCatmullRom per axis)
    double dt0 = std::pow(glm::dot(p0 - p1, p0 - p1), 0.25), dt1 = std::pow(glm::dot(p1 - p2, p1 - p2), 0.25), dt2 = std::pow(glm::dot(p2 - p3, p2 - p3), 0.25);
    if (dt1 < 1e-4) dt1 = 1.0;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    dvec3 t1 = ((p1 - p0) / dt0 - (p2 - p0) / (dt0 + dt1) + (p2 - p1) / dt1) * dt1;
    dvec3 t2 = ((p2 - p1) / dt1 - (p3 - p1) / (dt1 + dt2) + (p3 - p2) / dt2) * dt1;
    dvec3 c0 = p1, c1 = t1, c2 = -3.0 * p1 + 3.0 * p2 - 2.0 * t1 - t2, c3 = 2.0 * p1 - 2.0 * p2 + t1 + t2;
    return c0 + c1 * w + c2 * (w * w) + c3 * (w * w * w);
  }
  dvec3 pointAt(double u) const {   // (Curve.getUtoTmapping)
    double target = u * lens.back();
    size_t hi = size_t(std::upper_bound(lens.begin(), lens.end(), target) - lens.begin());
    size_t i = hi > 0 ? hi - 1 : 0;
    if (i >= lens.size() - 1) return point(1.0);
    double seg = lens[i + 1] - lens[i], f = seg > 0 ? (target - lens[i]) / seg : 0;
    return point((double(i) + f) / double(lens.size() - 1));
  }
};
} // namespace

int runGame(const GameOptions& opt) {
  auto plat = platform::createPlatform();
  AssetPaths paths;
  if (!paths.init(*plat)) return 2;
  SL_INFO("assets: %s | data: %s", paths.publicRoot.c_str(), paths.dataRoot.c_str());

  // (Phase 4) the save: progress, settings, bindings (the autotest plays a fresh save of its own)
  bool mptest = !opt.mptest.empty();
  Save save(opt.autotest ? std::string("autotest-save.json") : mptest ? std::string("mptest-save.json") : opt.saveName);
  if (!opt.autotest && !mptest && !opt.verifyHeights) save.load(*plat);

  World world;
  world.load(*plat, paths);
  if (opt.verifyHeights) return verifyHeights(*plat, paths, world);
  if (opt.autotest) save.write(*plat);   // (a fresh autotest save on disk)
  if (mptest) { save.money = 1234; save.characterChosen = true; save.write(*plat); }   // (the single-player save the test checks comes back)

  Quality q = Quality::preset(opt.qualitySet || save.quality.empty() ? opt.quality : save.quality);
  platform::WindowDesc wd;
  wd.width = opt.width; wd.height = opt.height; wd.fullscreen = opt.fullscreen || (!opt.autotest && save.settingOn("fullscreen")); wd.vsync = opt.vsync && !opt.autotest && !mptest;
  if (!plat->createWindow(wd)) return 3;
  static platform::Platform* sPlat = plat.get();
  auto dev = gfx::createGLDevice([](const char* n) { return sPlat->glProcAddress(n); });
  if (!dev) return 3;
  SL_INFO("gfx: %s %s | %s", dev->info().api.c_str(), dev->info().version.c_str(), dev->info().renderer.c_str());

  double t0 = plat->timeSeconds();
  JobSystem jobs;
  AssetManager assets(*plat, *dev, paths);
  assets.textureCap = q.maxTexture;   // (Phase 7: 512 with the switch preset)
  assets.compressTextures = q.compressTextures;
  // (larger colour maps where block compression pays for them; without it — Apple's OpenGL has no S3TC — High and up
  // spend the memory, Balanced keeps the models' budgets)
  assets.textureScale = (q.compressTextures && dev->supportsBC(true)) || q.fx >= 2 ? q.textureScale : 1;
  assets.triangleBudget = q.triangleBudget;
  if (!opt.verifyPoses.empty()) return verifyPoses(assets, opt.verifyPoses == "@data" ? paths.dataRoot + "/poses_ref.json" : opt.verifyPoses);
  Renderer renderer;
  RenderSettings rs;
  q.renderSettings(rs);   // (the preset's look: cascades, MSAA, AO, detail maps, trails, tone mapping)
  assets.anisotropy = q.aniso;
  SL_INFO("quality: %s (textures <= %d%s, shadow map %d over %.0f m, LOD x%.2f, far %.0f m, NPCs x%.2f, %d lights%s%s)", q.name.c_str(), q.maxTexture, q.compressTextures ? (dev->supportsBC(true) ? " BC1/BC3" : " (no BC support: RGBA8)") : "", q.shadowSize, q.shadowRange, q.lodScale, q.farZ, q.npcScale, q.maxLights, q.lowShaders ? ", simplified shaders" : "", q.dynamicRes ? ", dynamic resolution" : "");
  if (!renderer.init(*dev, rs)) { SL_ERROR("renderer init failed"); return 4; }
  int dw, dh;
  plat->drawableSize(dw, dh);
  renderer.resize(dw, dh);
  if (!opt.rigShots.empty()) return rigShots(*plat, *dev, renderer, assets, opt.rigShots);

  // (Phase 4) the 2D layer (menus, HUD, trail map) and a loading screen while the world builds
  Ui ui;
  ui.init(*dev, *plat, paths);
  auto loadingFrame = [&](const char* what, const std::function<void()>& over = {}) {
    if (!over) SL_INFO("loading: %s (GPU so far: textures %.0f MB, buffers %.0f MB; RSS %.0f MB)", what, dev->textureBytes() / 1048576.0, dev->bufferBytes() / 1048576.0, plat->memoryBytes() / 1048576.0);
    plat->drawableSize(dw, dh);
    dev->bindRenderTarget({}, dw, dh);
    dev->clear(0, 0, 0, 1, true, true);   // (style.css #intro: black, as the web game boots)
    ui.begin(dw, dh);
    // (menu.js scrMain before the world is ready: the big SKI LEGACY logo, white, and the loading line)
    float u = ui.cssU();
    ui.textLH(72 * u, 50 * u, 42 * u * 0.85f, 42 * u, UiFont::CondBold, vec4(1), "SKI", UiAlign::Left, 0.5f);
    ui.textLH(72 * u, 50 * u + 42 * u * 0.85f, 104 * u * 0.85f, 104 * u, UiFont::CondBold, vec4(1), "LEGACY", UiAlign::Left, 0.03f);
    ui.textLH(72 * u + 44 * u, 266 * u, 30 * u, std::max(13 * ui.dpr(), 15 * u), UiFont::BodyMed, ui_color::a(vec4(1), 0.9f), what, UiAlign::Left, 0.06f);
    ui.ring(72 * u + 15 * u, 266 * u + 15 * u, 13.5f * u, 3 * ui.dpr(), ui_color::a(vec4(1), 0.25f));
    if (over) over();   // (the boot intro's black lifting off this screen)
    ui.end();
    plat->swapBuffers();
  };
  // (Phase 7) the audio: the samples decode on a thread while the intro plays and the world builds; the autotest runs
  // it too (SDL's dummy driver in CI: the mixer runs, nothing is heard)
  Audio audio;
  if (!audio.start(*plat, paths)) SL_WARN("audio: no output device: the game runs silent");
  // the boot intro (ui/intro.js): the SKI LEGACY logo clip, Icecold Studio; played before the world loads (loading
  // holds this thread for seconds at a time). SKI_LEGACY_DEBUG=introtest --autotest [--png out.png]: the intro only.
  {
    const char* dbgEnv = std::getenv("SKI_LEGACY_DEBUG");
    bool introTest = opt.autotest && dbgEnv && std::strstr(dbgEnv, "introtest");   // (no --png: played once, in real time)
    if (introTest || (opt.intro && opt.menu && !opt.autotest && !mptest)) {
      IntroOptions io;
      if (introTest) io.testPng = opt.png;
      if (!introTest) io.after = [&](const std::function<void()>& over) { loadingFrame("Loading the mountain...", over); };
      if (!playIntro(*plat, *dev, ui, audio, paths, io) || introTest) { audio.stop(*plat); return 0; }
    }
  }
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
  VegetationSettings vs{q.treeNear, q.treeMid, q.treeFar, q.impostorR, q.maxImpostors, q.fx >= 1 ? 2 : 1, q.rockR};
  SnowTrails trails;   // (ski grooves, footprints, tracks, spray: world/snowtrails)
  trails.init(q.sprayScale);
  Scenery scenery(*dev, world, jobs, assets, vs);
  loadingFrame("Building the resort...");
  Resort resort(*dev, world, assets);
  resort.lodScale = q.lodScale;
  resort.textureCap = q.maxTexture;
  resort.compressTextures = q.compressTextures;
  bool haveResort = resort.load(*plat, paths, scenery);
  if (!haveResort) scenery.loadVillage(*plat, paths);   // (Phase 1 placements without the resort data)
  Lifts& lifts = resort.lifts();
  // (Phase 3) the transport: roads, car parks, railways (data), the swept track, the vehicles
  Transport transport;
  if (const nlohmann::json* net = resort.transportNet()) transport.load(*net, resort.transportBin());
  if (transport.loaded()) world.roadSurface = [&](double x, double z, double mesh, double yHint) { return transport.roadSurface(world, x, z, mesh, yHint); };
  if (transport.rail.ok) world.addDeck([&](double x, double z) { return transport.railDeckHeight(x, z); });
  if (transport.express.ok) world.addDeck([&](double x, double z) { return transport.expressDeckHeight(x, z); });
  // (Phase 7) the railways thin the forest (transport.js / expressground.js addCut forest): no trees on the formations
  {
    auto bounds = [](const Line& L, double pad, dvec2& mn, dvec2& mx) {
      mn = dvec2(1e30); mx = dvec2(-1e30);
      for (int i = 0; i < L.n; i++) { mn = glm::min(mn, dvec2(L.X[size_t(i)], L.Z[size_t(i)])); mx = glm::max(mx, dvec2(L.X[size_t(i)], L.Z[size_t(i)])); }
      mn -= dvec2(pad); mx += dvec2(pad);
    };
    auto inSpan = [](const std::vector<Span>& sp, double s, double margin) { for (const Span& t : sp) if (s > t.s0 + margin && s < t.s1 - (t.end ? -1e9 : margin)) return true; return false; };
    if (transport.rail.ok) {
      World::ForestCut c;
      bounds(transport.rail.line, 20, c.bmin, c.bmax);
      c.fn = [&transport, inSpan](double x, double z, double f) {
        Line::Near n = transport.rail.line.nearest(x, z, 16);
        if (n.d > 15 || inSpan(transport.rail.tunnels, n.s, 20)) return f;
        return f * smoothstep(7, 14, n.d);
      };
      world.forestCuts.push_back(c);
    }
    if (transport.express.ok) {
      World::ForestCut c;
      bounds(transport.express.line, 24, c.bmin, c.bmax);
      double off = transport.express.trackOff;
      c.fn = [&transport, inSpan, off](double x, double z, double f) {
        Line::Near n = transport.express.line.nearest(x, z, 20);
        if (n.d > 19.9 || inSpan(transport.express.tunnels, n.s, 20)) return f;
        return f * smoothstep(off + 10, off + 20, n.d);
      };
      world.forestCuts.push_back(c);
    }
  }
  // (the rocks) vegetation.js onExpressBed / onRailBed: none on the railways' formations or the toes of their cuttings
  // (over a tunnel they may lie on its cover)
  scenery.railBed = [&transport](double x, double z, double size) {
    const double reach = 8.5 + size * 0.6;
    if (transport.express.ok) {
      Line::Near n = transport.express.line.nearest(x, z, reach + 1);
      if (n.d < reach) {
        const double L = transport.express.line.length, w = transport.express.line.wrap(n.s), m = 3.2 + 3;   // PORTAL_IN + 3
        bool tunnel = false;
        for (const Span& t : transport.express.tunnels)
          if ((w > t.s0 + m && w < t.s1 - m) || (w - L > t.s0 + m && w - L < t.s1 - m)) tunnel = true;
        if (!tunnel) return true;
      }
    }
    if (transport.rail.ok) {
      Line::Near n = transport.rail.line.nearest(x, z, reach + 1);
      if (n.d < reach) {
        for (const Span& t : transport.rail.tunnels) if (n.s > t.s0 + 20 && n.s < t.s1 - (t.end ? -1e9 : 20)) return false;
        return true;
      }
    }
    return false;
  };
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
  traffic.density = q.npcScale;
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
  PlayerSkier rig;
  auto rigColour = [&]() { return save.character == "skier_red" ? std::string("red") : std::string("blue"); };
  if (!rig.load(assets, rigColour())) SL_WARN("skier model missing: the player is invisible");
  // (Phase 4) your garage: the cars you own stand in the Autohaus car park's bays
  for (const Save::Car& c : save.garage) {
    int i = drive.addOwned(c.id, c.plate, c.damage);
    if (i < 0) SL_WARN("garage: unknown car %s", c.id.c_str());
    else drive.dress(i, c.paint, c.rims);   // (Phase 7: your car's paint; its rims)
  }
  loadingFrame("The trail map, the people, the courses...");
  TrailMap tmap;
  tmap.load(*plat, paths, world, transport, lifts);
  tmap.buildRelief(jobs, world, *dev);

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
  tmap.setPlay(&playData);
  HeliParts heliParts = loadHeliParts(resort);   // (the helicopter's parts and the ward, built from the play pack before its bin goes)
  transport.railModels = nullptr;   // (Phase 7: the packs' json / bins are not needed any more)
  resort.releaseLoadData();
  Shapes shapes;
  shapes.init(*dev);
  People people;
  people.load(assets, world);
  PeopleSim folk;
  Npcs npcs;
  folk.setKinds(people.fanKinds, people.skierKinds);
  folk.setKits(people.fanKits);   // (the townsfolk: fans.js's crowd people)
  {
    std::vector<std::vector<dvec2>> pl;
    for (auto& ps : pistes) pl.push_back(ps.pts);
    folk.init(world, pl, int((opt.autotest ? 28 : 56) * q.npcScale), std::max(2, int((opt.autotest ? 6 : 14) * q.npcScale)));
    npcs.init(people, *dev, world, pl, q);   // (npcs.js: the resort's skiers and walkers, the far skiers)
  }
  Weather weather;
  weather.init(unsigned(plat->timeSeconds() * 1000) ^ 0x5eedu, opt.autotest);
  PlayCtx pc;
  pc.plat = plat.get(); pc.world = &world; pc.scenery = &scenery; pc.transport = &transport; pc.player = &player; pc.drive = &drive; pc.traffic = &traffic;
  pc.save = &save; pc.input = &input; pc.people = &people; pc.folk = &folk; pc.shapes = &shapes; pc.lifts = &lifts; pc.weather = &weather; pc.assets = &assets;
  pc.dev = dev.get(); pc.data = &playData; pc.autotest = opt.autotest; pc.skier = &rig;
  for (auto& ps : pistes) pc.pistes.push_back({ps.name, ps.pts});
  Interiors rooms(pc);
  Showroom showroom(pc, rooms, vmodels);   // (the Autohaus: its cars, the configurator's live car, the salesman, the doors)
  WindowView windows(pc);                      // (the rooms' windows: the world photographed as you go in)
  world.addDeck([&](double x, double z) { return rooms.deck(x, z); });
  Races races(pc);
  Jobs oddJobs(pc);
  Police police(pc, rooms, windows);
  HospitalWard ward(pc, rooms);
  ShopRoom shopRoom(pc, rooms, windows, ui);   // (interior.js: the walk-in ski shop's door, podium, views)
  OutfitShop outfitShop(pc, ui, shopRoom);     // (ui/outfitshop.js: the OUTFITS corner)
  world.addDeck([&](double x, double z) { return ward.deck(x, z); });
  Heli heli(pc, ward);
  Chalets chalets(pc, rooms, windows);
  Werkstatt werk(pc);                          // (werkstatt.js: the repair garage beside the Autohaus)
  police.load(assets);
  ward.load(assets, heliParts.ward);
  heli.load(assets, heliParts);
  heliParts = HeliParts{};
  heli.openChart = [&]() {   // (heli.js openDialog: the flight planner chart, ui/travel.js)
    TrailMap::Travel T = tmap.heliTravel(save.money, heli.price());
    heli.planner(T);
    tmap.openTravel(std::move(T));
    if (!opt.autotest) plat->setRelativeMouse(false);
  };
  chalets.load(assets);
  tmap.live = [&](TrailMap::Live& L) { L.ownChalet = chalets.owned() ? chalets.ownedHouse() : -1; };
  Snowmobiles sleds(pc);
  sleds.load(assets);
  sleds.place();
  // (Phase 7) lamps' light pools, car lights and plates, snowmaking, flags, snowcats
  SceneFx sfx;
  {
    std::vector<std::vector<dvec2>> pl;
    for (auto& ps : pistes) pl.push_back(ps.pts);
    sfx.init(*dev, assets, resort, world, resort.fonts(), pl, &playData, q.npcScale, q.lodScale);
  }
  std::shared_ptr<Model> jobBoard = assets.model("job_board", ModelLoadOptions{});
  VehicleDraw snowDraw;
  Transition trans;   // the scenes between two places (transition.js): the dark dip with the logo, the title card
  bool jailResumed = false, rescueResumed = false;
  drive.gatherOthers = [&](std::vector<OtherBody>& out) {
    traffic.others(out, drive.pos());
    for (const Obb& b : busBoxes) if (std::hypot(b.x - drive.pos().x, b.z - drive.pos().z) < 20) { OtherBody o; o.box = b; o.mass = 12000; o.kind = 1; out.push_back(o); }
    police.others(out, drive.pos());
  };
  drive.onKnock = [&](const OtherBody& b, double vx, double vz, double w) {
    double kmh = glm::length(drive.vel() - dvec2(b.vx, b.vz)) * 3.6;
    audio.impact("car", float(std::min(1.0, kmh / 60)));
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
  cam.farZ = q.farZ;
  Lighting dayLight;
  dayLight.toneMap = opt.toneMap;
  double hour = opt.hour >= 0 ? std::fmod(opt.hour, 24.0) : opt.autotest ? 10.0 : std::fmod(std::max(0.0, save.hour), 24.0);
  Lighting light = timeOfDay(hour, dayLight);
  player.frameUpdate(0.016, 1, {}, {});
  player.cameraFor(cam);
  terrain.finish(cam.pos);
  scenery.finish(cam.pos);
  resort.update(0, cam.pos);
  resort.finishStreaming(cam.pos);
  SL_INFO("world ready in %.2f s: %zu terrain nodes, %zu trees in range, %zu resort props, %zu lifts, %.0f MB textures (GPU: textures %.0f MB, buffers %.0f MB; RSS %.0f MB)", plat->timeSeconds() - t0,
          terrain.nodeCount(), scenery.treesDrawn(), resort.propCount(), lifts.lines().size(), assets.textureBytes() / 1048576.0,
          dev->textureBytes() / 1048576.0, dev->bufferBytes() / 1048576.0, plat->memoryBytes() / 1048576.0);

  GroundMap groundMap;
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
  trans.init(*dev, *plat, paths);
  Menus menus(ui, save, input, *plat);
  NavBuilder navBuilder;
  bool wasUiOpen = false;
  bool started = !opt.menu || opt.autotest;   // in the game (else the main menu over the live world)
  bool showcaseOn = false;
  double showcaseYaw = PI * 0.85, menuT = 0;
  auto flash = [&](const std::string& t, Hud::Flash k) { hud.flash(t, k, simTime); if (mptest) SL_INFO("[mptest] flash: %s", t.c_str()); };
  auto fmtM = [](int64_t v) {
    std::string n = std::to_string(v < 0 ? -v : v), o;
    for (size_t i = 0; i < n.size(); i++) { if (i && (n.size() - i) % 3 == 0) o += ','; o += n[i]; }
    return (v < 0 ? "-$" : "$") + o;
  };
  // money: spend (refused when short: "Not enough money ($N needed)", economy.js spend), earn
  auto spend = [&](int64_t amount, bool force = false) {
    if (!save.spend(amount, force)) { flash("Not enough money (" + fmtM(amount) + " needed)", Hud::Flash::Bad); audio.play("error"); return false; }
    save.write(*plat);
    if (amount > 0) audio.play("cash");
    return true;
  };
  // the SETTINGS values applied (main.js onSetting); "" = all
  float fovSetting = 65;
  int fpsCap = 0;
  auto applySetting = [&](const std::string& k) {
    bool all = k.empty();
    if (all || k == "renderScale") renderer.setRenderScale(float(q.renderScale * std::clamp(save.setting("renderScale", 1), 0.5, 1.0)));
    if (all || k == "shadows") renderer.shadowsOn = save.settingOn("shadows");
    if (all || k == "bloom") renderer.bloomOn = save.settingOn("bloom");
    if (all || k == "brightness") dayLight.exposure = float(0.72 * std::clamp(save.setting("brightness", 1), 0.7, 1.3));
    if (all || k == "fpsCap") fpsCap = int(save.setting("fpsCap", 0));
    if ((all && !opt.autotest) || k == "fullscreen") { bool fs = save.settingOn("fullscreen"); if (plat->fullscreen() != fs && !opt.autotest) plat->setFullscreen(fs); }
    if (all || k == "volume" || k == "sfxVolume" || k == "musicVolume" || k == "voiceVolume")
      audio.setVolumes(float(save.setting("volume", 0.8)), float(save.setting("musicVolume", 0.7)), float(save.setting("sfxVolume", 1)), float(save.setting("voiceVolume", 0.95)));
    if (all || k == "muteUnfocused") audio.setFocused(true, save.settingOn("muteUnfocused"));
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
  // (transition.js: the dip to dark with the logo, the title card over a race's start; the autotest's moves stay
  // instant: its screenshots follow them at once)
  pc.fade = [&]() { if ((!opt.autotest || off("fadetest")) && !mptest) trans.fade(); };   // (fadetest: the debug runs with the real fades)
  pc.titleCard = [&](const std::string& label) { if (!opt.autotest && !mptest) trans.teleport(label); };
  pc.covered = [&]() { return trans.holdsFrame() || trans.covered(); };
  pc.trails = &trails;
  // presentation/index.js: slow motion on big moments (a big air, a photo finish, a police ram). The autotest keeps real
  // time (its phases count frames) unless SKI_LEGACY_DEBUG=slowmo
  Presentation pres;
  pres.enabled = !opt.autotest || off("slowmo");
  pc.slowMo = [&](double scale, double easeIn, double hold, double easeOut, const char* reason) { return pres.slowMo(scale, easeIn, hold, easeOut, reason ? reason : ""); };
  pc.slowCancel = [&]() { pres.cancel(); };
  pc.roomModel = [&](const std::string& id) { return resort.roomModel(id); };

  // ---------------------------------------------------------------- (Phase 6) multiplayer: the session and its glue
  // (the host's hooks are filled in below, once the rides and the shops exist; net/session.js's main.js context)
  Multiplayer mp{MpHost{}};
  MpView mpv;
  net::HttpGet mpHealth;
  std::string mpHealthLine;
  {
    const char* env = std::getenv("SKI_LEGACY_SERVER");
    mp.url = !opt.mptest.empty() ? opt.mptest : !opt.server.empty() ? opt.server : env && *env ? std::string(env) : std::string(net::kDefaultServerUrl);
  }
  bool aiOn = true;            // (multiplayer: no traffic, townsfolk or decorative cars: the other players instead)
  bool jailQuiet = false;      // (a sentence the server already knows: not reported again)
  int mpRaceRid = -1;
  pc.earnFrom = [&](int64_t a, const std::string& source) {
    if (mp.active()) mp.earn(a, source == "sell" ? "sell" : "job");
    else { save.earn(a); save.markDirty(); }
  };
  pc.earn = [&](int64_t a) { pc.earnFrom(a, "job"); };
  pc.raceSolo = [&](const std::string& race) {
    mpRaceRid = -1;
    mp.net.request("raceSolo", {{"race", race}}, [&](const net::NetResult& r) { if (r.ok) mpRaceRid = int(r.d.value("rid", -1)); });
  };
  pc.raceFinished = [&](double t, bool dnf) {
    if (mpRaceRid < 0) return;
    mp.net.request("raceFinish", {{"rid", mpRaceRid}, {"time", std::llround(t * 1000)}, {"raw", std::llround(t * 1000)}, {"pen", 0}, {"dnf", dnf}}, [](const net::NetResult&) {});
    mpRaceRid = -1;
  };
  pc.onJail = [&](double seconds, const std::string& reason, bool onFoot) {
    if (!mp.active() || jailQuiet) return;
    mp.jail(seconds, reason);
    mp.policeArrest(onFoot);   // (after the sentence: your passengers, and anyone who rode with you in the chase, too)
  };

  // riding a lift (main.js boardLift / leaveLift)
  Player::View viewBeforeRide = player.view;
  bool restoreView = false;
  int strikes = 0;
  double lastStrikeAt = -1e9;
  auto boardLift = [&](const Lifts::Station& st, bool up) {
    LiftLine& line = *st.line;
    // (Phase 4, main.js boardLift) skis first; a day pass or a gondola ticket, else the line's price; riding down free
    if (save.skis.empty()) { flash("Buy skis first - the ski shop in Legacy Village", Hud::Flash::Bad); return; }
    bool useTicket = !save.hasPass() && up && line.main && save.tickets > 0;
    bool free = save.hasPass() || !up || useTicket;
    int price = line.price > 0 ? line.price : line.gondola ? Prices::gondola : Prices::chair;
    if (!free && !spend(price)) return;
    if (useTicket) { save.tickets--; save.write(*plat); }
    strikes = 0;   // (a lift ride between two wipeouts: no rescue)
    if (!player.skisOn) player.setSkisOn(true);
    Seat seat = lifts.board(line, up, st.mid);
    audio.play("board");
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
  enum class Ride { None, Car, Bus, Rail, Express, Sled, Passenger } rideKind = Ride::None;   // (Passenger: in another player's car)
  int busDestSel = 0, expressDestSel = 0;
  // the route picker's choice (ui/travel.js): the stop / station it was opened at and where to (taken by the boarding code)
  struct TravelPick { int kind = 0, from = -1, to = -1; bool up = true; } travelPick;
  double rideCamYaw = 0, rideCamPitch = 0.15, rideLookT = -1e9, seatYaw = 0, seatPitch = -0.05;
  bool seatView = true;   // riding the bus / a train: the seat view (bus.js / railway.js / express.js default), R: outside
  double trainFov = -1;   // (railway.js this.fov) the trains' seat camera, eased
  int trainView = 0;      // (express.js this.view) 0 the seat, 1 outside, 2 trackside
  bool walkToggle = false;
  int trainWalk = -1;     // (debug traintest) a standing camera in the car: which
  float CABIN_LAMP = 14.f;   // the cabin lamps' strength at uCabin 1 (SKI_LEGACY_CABIN_LAMP to try another)
  if (const char* e = std::getenv("SKI_LEGACY_CABIN_LAMP")) CABIN_LAMP = float(std::atof(e));
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
  Dialog shopDlg;
  ShopView shopView;
  // a pair of skis (main.js shopAction): equip the ones you own, else rent / buy them
  std::function<void(const std::string&)> skiAction;
  skiAction = [&](const std::string& id) {
    const SkiDef* k = skiById(id);
    if (!k || save.skis == id) return;
    if (save.ownsSki(id)) { equipSkis(id); flash(std::string(k->name) + " equipped", Hud::Flash::Good); return; }
    if (mp.active()) {   // (Phase 6: the server sells it: its price, your money, your skis)
      if (save.money < k->price) { flash("Not enough money (" + fmtM(k->price) + " needed)", Hud::Flash::Bad); return; }
      mp.buy("skis", {{"id", id}}, [&, id](bool ok, const nlohmann::json& d) {
        if (!ok) return;
        save.owned.clear();
        for (auto& o : d.value("owned", nlohmann::json::array())) if (o.is_string()) save.owned.push_back(o.get<std::string>());
        if (mp.profile.is_object()) mp.profile["owned"] = d.value("owned", nlohmann::json::array());
        equipSkis(id);
        const SkiDef* k2 = skiById(id);
        flash(std::string(k2 ? k2->name : id.c_str()) + (k2 && k2->rent ? " rented" : " purchased"), Hud::Flash::Gold);
        menus.refreshDialog();
      });
      return;
    }
    if (!spend(k->price)) return;
    save.owned.push_back(id);
    equipSkis(id);
    flash(std::string(k->name) + (k->rent ? " rented" : " purchased"), Hud::Flash::Gold);
  };
  int skiShopTab = 0;
  outfitShop.zones = [&]() { return rig.zones(); };
  outfitShop.buyHook = [&](const std::string& id, int, std::function<void(bool)> done) {   // (Phase 6: bought at the server)
    if (!mp.active()) return false;
    mp.buy("outfit", {{"id", id}}, [&, done](bool ok, const nlohmann::json& d) {
      if (ok && d.contains("outfits") && d["outfits"].contains("owned")) { save.outfits.owned.clear(); for (auto& o : d["outfits"]["owned"]) if (o.is_string()) save.outfits.owned.push_back(o.get<std::string>()); }
      done(ok);
    });
    return true;
  };
  CarCfgView carCfg;   // the AUTOHAUS configurator (ui/carrental.js)
  Popups popups;   // the trick popup and the personal-best card (racehud.js trick() / best(), game/bests.js)
  auto openSkiShop = [&]() {
    Dialog d;
    d.tab = skiShopTab;
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
          o.act = [&, id]() { skiAction(id); };
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
            if (!save.ownsOutfit(id) && mp.active()) {   // (Phase 6: bought at the server, then worn)
              if (save.money < od->price) { flash("Not enough money (" + fmtM(od->price) + " needed)", Hud::Flash::Bad); return; }
              mp.buy("outfit", {{"id", id}}, [&, id, slot](bool ok, const nlohmann::json& d) {
                if (!ok) return;
                save.outfits.owned.clear();
                if (d.contains("outfits") && d["outfits"].contains("owned")) for (auto& o : d["outfits"]["owned"]) if (o.is_string()) save.outfits.owned.push_back(o.get<std::string>());
                save.outfits.equipped[save.character][slot] = id;
                save.write(*plat);
                const OutfitDef* o2 = outfitById(id);
                flash(std::string(o2 ? o2->name : id.c_str()) + " bought", Hud::Flash::Gold);
                menus.refreshDialog();
              });
              return;
            }
            if (!save.ownsOutfit(id)) { if (!spend(od->price)) return; save.outfits.owned.push_back(id); flash(std::string(od->name) + " bought", Hud::Flash::Gold); }
            save.outfits.equipped[save.character][slot] = id;
            save.write(*plat);
          };
          D.options.push_back(o);
        }
      }
    };
    // the catalogue screen (ui/outfitshop.js): the dialog's options as its rows, their acts as its purchases
    shopDlg = d;
    shopView = ShopView();
    shopView.title = "Ski Shop"; shopView.sub = "Skis and outfits \xC2\xB7 make your skier yours";
    shopView.tabs = {{"SKIS", "SKIS"}, {"JACKETS", "JACKET"}, {"TROUSERS", "TROUSERS"}, {"HELMETS", "HELMET"}, {"GOGGLES", "GOGGLE LENS"}};
    shopView.rebuild = [&](ShopView& v) {
      shopDlg.tab = v.tab;
      shopDlg.rebuild(shopDlg);
      v.money = save.money;
      v.rows.clear();
      for (const DialogOption& o : shopDlg.options) {
        ShopRow r;
        r.name = o.label; r.sub = o.sub; r.price = std::max(0, o.price);
        r.owned = !o.state.empty(); r.worn = o.state == "Equipped" || o.state == "Wearing";
        if (v.tab == 0) { r.swatch = 4; r.a = 0x1546c8; r.b = 0xff4d3d; r.wornLabel = "EQUIPPED"; r.useLabel = "EQUIP"; const SkiDef* k = nullptr; for (size_t i = 0; i < kSkiCount; i++) if (o.label == kSkis[i].name) k = &kSkis[i]; if (k && k->desc && *k->desc) r.notes.push_back(k->desc); if (k && k->rent) r.buyLabel = "RENT"; }
        else if (o.swatch == 0) r.swatch = 0;
        else { r.swatch = v.tab == 3 ? 2 : v.tab == 4 ? 3 : 1; r.a = o.swatch; r.b = o.swatch2; }
        v.rows.push_back(std::move(r));
      }
    };
    shopView.act = [&](ShopView&, int row) { if (row >= 0 && size_t(row) < shopDlg.options.size() && shopDlg.options[size_t(row)].act) { auto f = shopDlg.options[size_t(row)].act; f(); } };
    menus.openCustom([&](const UiNav& nv, double dt, double now) {
      if (shopView.openedAt >= 0 && shopView.rebuild) shopView.rebuild(shopView);   // (a purchase answered by the server: the rows follow)
      if (!frameShop(ui, nv, input, shopView, dt, now)) { menus.close(); return; }
      if (!shopView.rows.empty()) menus.customFocus = shopView.rows[size_t(shopView.focus)].name;
    }, "shop");
    menus.customFocusLabel = [&](const std::string& label) { if (shopView.openedAt < 0 && shopView.rebuild) shopView.rebuild(shopView); for (size_t i = 0; i < shopView.rows.size(); i++) if (shopView.rows[i].name == label) { shopView.focus = int(i); return true; } return false; };
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
  auto buyCar = [&](const std::string& model, const CarCfg* cfg = nullptr) -> int {
    const CarSpec* spec = transport.car(model);
    if (!spec) return -1;
    // (the configurator's choices: the paint, the rims, a plate of your own; their extras on the price)
    const std::string paint = cfg ? cfg->paint : std::string("white"), rims = cfg ? cfg->rims : std::string("orig");
    const int64_t price = int64_t(spec->price) + (cfg ? carExtras(*cfg) : 0);
    if (int(save.garage.size()) >= GARAGE_MAX) { flash("Your garage is full (" + std::to_string(GARAGE_MAX) + " cars): sell one first", Hud::Flash::Bad); return -1; }
    if (mp.active()) {   // (Phase 6, AUTOHAUS: the server prices it, issues a plate nobody has; your garage from it)
      nlohmann::json jc = {{"id", model}, {"paint", paint}, {"interior", "orig"}, {"rims", rims}};
      if (cfg && cfg->custom) { jc["plate"] = cfg->plate; jc["custom"] = true; }
      mp.buy("car", {{"cfg", jc}}, [&, model](bool ok, const nlohmann::json& d) {
        if (!ok || !d.contains("car")) return;
        Save::Car c;
        c.id = model; c.plate = d["car"].value("plate", std::string()); c.price = int(d["car"].value("price", 0)); c.paint = d["car"].value("paint", std::string("white"));
        c.rims = d["car"].value("rims", std::string("orig"));
        save.garage.insert(save.garage.begin(), c);
        save.rentalPlate = c.plate;
        if (d.contains("cars")) mp.profile["cars"] = d["cars"];
        if (int oi = drive.addOwned(model, c.plate, 0); oi >= 0) drive.dress(oi, c.paint, c.rims);
        const CarSpec* sp2 = transport.car(model);
        flash("Bought: " + (sp2 ? sp2->label : model) + " (" + c.plate + ") \xC2\xB7 it waits in your bay at the Autohaus car park", Hud::Flash::Gold);
      });
      return -1;
    }
    if (!spend(price)) return -1;
    Save::Car c;
    c.id = model; c.plate = cfg && !cfg->plate.empty() ? cfg->plate : newPlate(); c.price = int(price);
    if (cfg) { c.paint = paint; c.rims = rims; c.custom = cfg->custom; }
    save.garage.push_back(c);
    int idx = drive.addOwned(model, c.plate, 0);
    if (cfg && idx >= 0) drive.dress(idx, paint, rims);
    save.write(*plat);
    flash("Bought: " + spec->label + " (" + c.plate + ") \xC2\xB7 it waits in your bay at the Autohaus car park", Hud::Flash::Gold);
    return idx;
  };
  // selling a car back (half what you paid): MY CARS at the counter and in the configurator
  std::function<void()> garageChanged;
  auto sellCar = [&](const std::string& plate) {
    int value = 0;
    for (const Save::Car& c : save.garage) if (c.plate == plate) value = int(std::round(c.price * SELL_SHARE / 50.0)) * 50;
    if (mp.active()) {   // (Phase 6: the server buys it back: half what you paid)
      for (const auto& e : drive.parked) if (e.owned && e.plate == plate && e.driving) { flash("Get out of it first", Hud::Flash::Bad); return; }
      mp.carSell(plate, [&, plate](bool ok, const nlohmann::json& d) {
        if (!ok) return;
        drive.parked.erase(std::remove_if(drive.parked.begin(), drive.parked.end(), [&](const Drive::Parked& e) { return e.owned && e.plate == plate; }), drive.parked.end());
        save.garage.erase(std::remove_if(save.garage.begin(), save.garage.end(), [&](const Save::Car& g) { return g.plate == plate; }), save.garage.end());
        if (!save.garage.empty() && save.rentalPlate == plate) save.rentalPlate = save.garage[0].plate;
        flash("Sold for " + fmtM(d.value("refund", 0)), Hud::Flash::Gold);
        menus.refreshDialog();
      });
      return;
    }
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
  // E at a car for sale: the AUTOHAUS configurator (ui/carrental.js: PAINT, WHEELS, PLATE, SUMMARY, then BUY). Only
  // the UI layer here; in the showroom carCfg.preview / carCfg.drag drive the very car on its turntable (game/showroom:
  // carrentalroom.js configure / orbit). paint: the paint it stands in on show (carrental.js openCard)
  auto openCarConfig = [&](const std::string& model, int step, const std::string& paint = "white") {
    const CarSpec* spec = transport.car(model);
    if (!spec) return;
    carCfg = CarCfgView();
    carCfg.carLabel = spec->label; carCfg.carPrice = int(spec->price); carCfg.step = step;
    carCfg.cfg.id = model; carCfg.cfg.plate = randomCarPlate(unsigned(plat->timeSeconds() * 1000) ^ unsigned(save.garage.size() * 7919));
    carCfg.garageMax = GARAGE_MAX; carCfg.wreckFee = int(wreckFee()); carCfg.repairFull = REPAIR_FEE; carCfg.towFee = int(wreckFee()) - REPAIR_FEE;
    carCfg.interactKey = prompts::K(input, Action::Interact);
    carCfg.cfg.paint = carPaintOf(paint).id;
    if (showroom.inside()) {
      carCfg.preview = [&](const CarCfg& c, int st) { showroom.configure(c, st); };
      carCfg.drag = [&](float dx, float dy) { showroom.orbit(dx, dy); };
      showroom.configure(carCfg.cfg, step);
    }
    carCfg.refresh = [&, model](CarCfgView& v) {
      v.money = save.money; v.owned = 0; v.garage.clear();
      for (const Save::Car& c : save.garage) {
        const CarSpec* cs = transport.car(c.id);
        CarCfgView::Mine m;
        m.id = c.id; m.plate = c.plate; m.label = cs ? cs->label : c.id; m.paint = c.paint; m.value = int(std::round(c.price * SELL_SHARE / 50.0)) * 50; m.out = c.plate == save.rentalPlate;
        if (c.id == model) v.owned++;
        v.garage.push_back(m);
      }
      std::stable_partition(v.garage.begin(), v.garage.end(), [&](const CarCfgView::Mine& m) { return m.id == model; });   // (yours of this model first)
    };
    carCfg.buy = [&, model](const CarCfg& c, int) { CarCfg cc = c; buyCar(model, &cc); };
    carCfg.sell = [&](const std::string& plate) { sellCar(plate); };
    carCfg.takeOut = [&](const std::string& plate) {
      if (mp.active()) mp.carSwitch(plate, [&, plate](bool ok, const nlohmann::json&) { if (ok) save.rentalPlate = plate; });
      else { save.rentalPlate = plate; save.write(*plat); }
      flash(plate + " \xC2\xB7 it waits in your bay at the Autohaus car park", Hud::Flash::Good);
    };
    carCfg.flashBad = [&](const std::string& m) { flash(m, Hud::Flash::Bad); };
    carCfg.sound = [&](const char* snd) { audio.play(snd); };
    menus.openCustom([&](const UiNav& nv, double dt, double now) {
      if (!frameCarConfig(ui, nv, input, carCfg, dt, now)) { if (menus.customOpen("carconfig")) menus.close(); return; }
      menus.customFocus = carCfg.step == 3 && carCfg.actLabel.rfind("BUY", 0) == 0 ? std::string("Buy it") : carCfg.actLabel;
    }, "carconfig");
    menus.customFocusLabel = [&](const std::string& label) { if (label != "Buy it") return false; carCfg.step = 3; return true; };
  };
  auto openCarSale = [&](const std::string& model) {
    int mine = 0;
    for (const Save::Car& c : save.garage) mine += c.id == model;
    openCarConfig(model, mine ? 3 : 0, showroom.displayPaint(model));   // (a model you own opens on the summary: MY CARS)
  };
  auto garageEntry = [&](const std::string& plate) -> Save::Car* { for (auto& c : save.garage) if (c.plate == plate) return &c; return nullptr; };
  // MY CARS (the Autohaus counter): your garage, sell one back for half what you paid
  auto openGarage = [&]() {
    Dialog d;
    d.kicker = "Autohaus \xC2\xB7 my cars";
    d.title = "My Cars";
    d.keepOpen = true;
    d.rebuild = [&](Dialog& D) {
      D.say = save.garage.empty() ? "No cars yet: the ten for sale stand in the showroom (" + prompts::K(input, Action::Interact) + " at one to buy it)."
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
        o.act = [&, plate]() { sellCar(plate); };
        D.options.push_back(o);
      }
      DialogOption n; n.label = "Close"; n.secondary = true;
      D.options.push_back(n);
    };
    menus.openDialog(d);
  };
  // the Autohaus salesman (carrental.js clerkDialog): the car of the day (his tip: a marker over it shows the way), or
  // "Repair my car": a flat $500 for your car that is out, wherever it is parked
  auto clerkDialog = [&]() {
    constexpr int CLERK_REPAIR = 500;
    Dialog d;
    d.title = "Autohaus \xC2\xB7 Salesman";
    d.rebuild = [&](Dialog& D) {
      const Save::Car* out = nullptr;
      for (const Save::Car& c : save.garage) if (c.plate == save.rentalPlate) out = &c;
      if (!out && !save.garage.empty()) out = &save.garage[0];
      Drive::Parked* e = nullptr;
      if (out) for (auto& p : drive.parked) if (p.owned && p.plate == out->plate) e = &p;
      const CarSpec* spec = out ? transport.car(out->id) : nullptr;
      const std::string label = spec ? spec->label : std::string("car");
      const double dmg = e ? e->damage : 0;
      const int pct = dmg > 0 ? std::max(1, int(std::round(dmg))) : 0;
      std::string why;
      if (save.garage.empty()) why = "You don't own a car yet";
      else if (!e) why = "None of your cars is out";
      else if (e->wrecked) why = "Your " + label + " is with the tow truck \xC2\xB7 wait until it is home";
      else if (e->impoundDay > save.day) why = "Your " + label + " is in the tow yard \xC2\xB7 available tomorrow";
      else if (dmg <= 0) why = "Not a scratch on it \xC2\xB7 nothing to repair";
      else if (save.money < CLERK_REPAIR) why = "Not enough money";
      static const char* HELLO[] = {"Gr\xC3\xBC" "ezi! Welcome to the Autohaus. How can I help you today?", "Gr\xC3\xBC" "ezi mitenand! Looking for a new car, or is yours giving you trouble?", "Hello again! What can I do for you?"};
      D.say = e && dmg > 0 && why.empty() ? "Gr\xC3\xBC" "ezi! Your " + label + " has seen some knocks, I see. Our mechanic can fix it up for a flat " + fmtM(CLERK_REPAIR) + ", wherever it is parked."
                                          : std::string(HELLO[unsigned(simTime * 7) % 3]);
      D.options.clear();
      DialogOption tip;
      tip.label = "Car of the day"; tip.sub = "His tip from the showroom floor";
      tip.act = [&]() {
        Showroom::Tip t;
        if (!showroom.recommend(unsigned(plat->timeSeconds() * 1000), t)) return;
        const std::string price = fmtM(t.price);
        const unsigned k = unsigned(plat->timeSeconds() * 977) % 3;
        flash(k == 0 ? "Gr\xC3\xBC" "ezi! Take a look at the " + t.label + (t.up ? " upstairs" : "") + ", yours for " + price + "!"
            : k == 1 ? "Have you seen the " + t.label + (t.up ? " upstairs" : "") + "? Lovely in the snow, and only " + price + "."
                     : "Today I'd buy the " + t.label + (t.up ? ", up the stairs" : "") + ". " + price + ", and it's yours for good!", Hud::Flash::Good);
      };
      DialogOption rep;
      rep.label = "Repair my car";
      rep.sub = out ? label + " \xC2\xB7 " + out->plate + (e ? " \xC2\xB7 damage " + std::to_string(pct) + "%" : std::string()) + (why.empty() ? std::string() : " \xC2\xB7 " + why) : (why.empty() ? std::string("Your car that is out") : why);
      rep.price = CLERK_REPAIR; rep.disabled = !why.empty();
      const std::string plate = out ? out->plate : std::string();
      rep.act = [&, plate, label, dmg]() {
        auto done = [&, plate, label]() {
          for (auto& p : drive.parked) if (p.owned && p.plate == plate) p.damage = 0;
          for (auto& c : save.garage) if (c.plate == plate) c.damage = 0;
          static const char* L[] = {"Our mechanic will fix it up right away!", "Consider it done, our mechanic is on his way.", "No problem, our mechanic will have it like new in no time."};
          flash(std::string("\"") + L[unsigned(simTime * 13) % 3] + "\" \xC2\xB7 your " + label + " (" + plate + ") is repaired where it stands \xC2\xB7 paid " + fmtM(CLERK_REPAIR), Hud::Flash::Good);
        };
        if (mp.active()) { mp.carRepair(dmg / 100, plate, [done](bool ok, const nlohmann::json&) { if (ok) done(); }); return; }
        if (!spend(CLERK_REPAIR)) return;
        done();
        save.write(*plat);
      };
      DialogOption bye; bye.label = "Bye"; bye.secondary = true;
      D.options = {tip, rep, bye};
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
        if (mp.active()) {   // (Phase 6: the server prices the repair, carrental.js repairCost, and takes the money)
          double dmg = 0;
          for (auto& p : drive.parked) if (p.owned && p.plate == plate) dmg = p.damage;
          mp.carRepair(dmg / 100, plate, [&, plate](bool ok, const nlohmann::json& d) {
            if (!ok) return;
            for (auto& p : drive.parked) if (p.owned && p.plate == plate) p.damage = 0;
            if (Save::Car* c = garageEntry(plate)) c->damage = 0;
            flash("Repaired \xC2\xB7 -" + fmtM(d.value("fee", 0)), Hud::Flash::Good);
          });
          return;
        }
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
    // (main.js openHut: the hut's counter)
    d.kicker = "MOUNTAIN HUT";
    d.title = name;
    d.rebuild = [&](Dialog& D) {
      D.say = "Warm up by the stove before the next run.";
      DialogOption h;
      h.label = "Hot chocolate"; h.sub = "Hot and sweet, with whipped cream"; h.price = Prices::hotChocolate; h.disabled = save.money < Prices::hotChocolate;
      h.act = [&]() { if (spend(Prices::hotChocolate)) flash("Hot chocolate", Hud::Flash::Gold); };
      DialogOption n; n.label = "Not now"; n.secondary = true;
      D.options = {h, n};
    };
    menus.openDialog(d);
  };
  // (werkstatt.js start() / finish(): the payment (the server's in multiplayer), then the repair itself)
  werk.pay = [&](const std::string& plate, int fee, std::function<void(bool, int)> done) {
    if (mp.active()) {
      double dmg = 0;
      for (auto& p : drive.parked) if (p.owned && p.plate == plate) dmg = p.damage;
      mp.carRepair(dmg / 100, plate, [done](bool ok, const nlohmann::json& d) { done(ok, d.value("fee", 0)); });
      return;
    }
    done(spend(fee), fee);
  };
  werk.repaired = [&](const std::string& plate) {
    for (auto& p : drive.parked) if (p.owned && p.plate == plate) p.damage = 0;
    if (Save::Car* c = garageEntry(plate)) c->damage = 0;
    save.write(*plat);
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
    if (mp.active()) {   // (Phase 6: the server charges the tow + repair and records the tow; the car ends in a bay)
      double bx = 0, bz = 0, byaw = 0;
      drive.freeBay(bx, bz, byaw);
      mp.tow("wreck", dvec3(bx, world.height(bx, bz), bz), byaw, 0, {});
    } else save.spend(fee, true);
    save.write(*plat);
    tows.push_back({idx, drive.parked[size_t(idx)].plate, simTime + 20, 0, "wreck"});
    flash("Wrecked \xC2\xB7 tow + repair -" + fmtM(fee).substr(0) + " \xC2\xB7 the tow truck brings it back to the Autohaus", Hud::Flash::Bad);
  };
  double leftOnRoadT = 0;

  // autotest phases after the run: walk into a hotel (collision), then ride a gondola
  enum class AT { Menu, Ski, Collide, Lift, Drive, CarFlow, Bus, Rail, Express, Map, Race, Job, Police, Chalet, Weather, Heli, Done } at = AT::Menu;
  if (vehTest && opt.autotest) at = AT::Drive;
  if (off("cartest") && opt.autotest) at = AT::CarFlow;   // (debug: straight to the cars on the player's path)
  CarFlowTest carFlow;
  if (off("maptest") && opt.autotest) at = AT::Map;   // (debug: straight to the trail map)
  // (debug: SKI_LEGACY_DEBUG=uitest: each UI screen in turn, a screenshot of it, then quit; <png>_ui_<name>.png)
  const bool uiTest = off("uitest") && opt.autotest;
  struct UiT { int step = 0, f = 0; } uiT;
  if (uiTest) at = AT::Map;
  // (SKI_LEGACY_UISTEP=<name>: from that sample screen on; SKI_LEGACY_UIONLY=1: just that one)
  if (const char* from = std::getenv("SKI_LEGACY_UISTEP")) for (size_t i = 0; i < uiTestScreens().size(); i++) if (uiTestScreens()[i] == from) uiT.step = 11 + int(i);
  const bool uiOnly = std::getenv("SKI_LEGACY_UIONLY") != nullptr;
  if ((off("p5test") || off("racetest")) && opt.autotest) at = AT::Race;   // (debug: straight to the Phase 5 checks)
  if ((off("rescuetest") || off("ambtest") || off("wardtest") || off("helitest") || off("helicheck")) && opt.autotest) at = AT::Heli;   // (debug: the helicopter, the rescue, the ward)
  bool heliOk = true;
  const bool heliRun = at == AT::Heli;
  // (Phase 5 autotest) a race, a job, a police chase into jail, a chalet and a piece of furniture, a weather change
  bool raceOk = true, jobOk = true, policeOk = true, chaletOk = true, weatherOk = true, sledOk = true;
  struct P5T { const Course* course = nullptr; int resF = -1, jailF = -1, arrestF = -1; int64_t money0 = 0; double jail0 = 0; int done0 = 0, furn0 = 0; bool releasedChecked = false; Jobs::Offer offer; bool haveOffer = false; } t5;
  // (Phase 4 autotest) the menus, a purchase, save / reload, the trail map
  bool menuOk = true, settingOk = true, buyOk = true, saveOk = true, mapOk = true, chargeOk = true;
  int skiFrame0 = 0, menuStep = 0;
  bool atRealKeys = false, textWanted = false;   // (autotest: the menus read the real events: keys pushed through SDL)
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
    flash(save.skis.empty() ? "Welcome to Legacy Village \xC2\xB7 buy skis at the ski shop" : "Welcome back to Legacy Village", Hud::Flash::Good);
  };
  // the trail map's live markers (trailmap.js markers()): the patrol cars and the police helicopter while you are
  // wanted, the other players, the job's target, your cars (the one you drive / parked; grey while impounded)
  tmap.live = [&](TrailMap::Live& L) {
    L.ownChalet = chalets.owned() ? chalets.ownedHouse() : -1;
    for (const Police::MapMark& m : police.mapMarks()) { TrailMap::Marker k; k.x = m.x; k.z = m.z; k.kind = m.heli ? "heli" : "police"; k.flag = m.sees; L.police.push_back(k); }
    if (mp.active()) for (const auto& [pid, r] : mp.players) if (r.ok && r.interior.empty()) { TrailMap::Marker k; k.x = r.pos.x; k.z = r.pos.z; k.yaw = r.yaw; k.label = r.name; k.kind = "player"; L.players.push_back(k); }
    if (oddJobs.active() && tmap.mark.on) { TrailMap::Marker k; k.x = tmap.mark.x; k.z = tmap.mark.z; k.kind = "target"; k.label = tmap.mark.label; k.what = "Your job \xC2\xB7 follow the arrow"; L.jobs.push_back(k); }
    for (const auto& e : drive.parked) if (e.owned && !e.plate.empty()) {
      TrailMap::Marker k; k.x = e.x; k.z = e.z; k.kind = e.impoundDay > save.day ? "impound" : "car";
      k.label = (e.spec ? e.spec->label : std::string("Your car")) + (e.impoundDay > save.day ? " \xC2\xB7 impounded" : "");
      L.mine.push_back(k);
    }
  };
  // (the layer switches are remembered: trailmap.js LAYER_KEY)
  { std::string lay = save.settingStr("mapLayers", ""); for (int i = 0; i < 7 && i < int(lay.size()); i++) tmap.setLayer(i, lay[size_t(i)] != '0'); }
  menus.hooks.records = [&]() { std::vector<Menus::Hooks::Record> out; for (const auto& r : races.records()) out.push_back({r.name, r.best, r.medal}); return out; };
  menus.hooks.resume = [&]() { menus.close(); if (!opt.autotest) plat->setRelativeMouse(true); };
  menus.hooks.quit = [&]() { running = false; };
  menus.hooks.mainMenu = [&]() { heli.rescue.keep = heli.rescuing(); heli.abort(); save.write(*plat); started = false; menus.open(Menus::Screen::Main, -1); };
  menus.hooks.village = [&]() {
    menus.close();
    if (police.jailed() || police.arrestedNow()) { flash("You are serving a sentence", Hud::Flash::Bad); return; }
    if (heli.rescuing()) { flash("The rescue is under way", Hud::Flash::Bad); return; }
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
    drive.parked.erase(std::remove_if(drive.parked.begin(), drive.parked.end(), [](const Drive::Parked& e) { return e.owned && !e.driving; }), drive.parked.end());
    input.resetBindings();
    applySetting("");
    save.write(*plat);
    flash("Progress reset: a new save", Hud::Flash::Good);
  };
  menus.hooks.flash = [&](const std::string& t, int k) { flash(t, k == 1 ? Hud::Flash::Bad : k == 2 ? Hud::Flash::Gold : Hud::Flash::Good); };

  // ---------------------------------------------------------------- (Phase 6) the multiplayer session's hooks
  // the garage, the skier, the jail and the trains follow the swapped save (main.js applyMpSave)
  auto syncGarage = [&]() {
    drive.parked.erase(std::remove_if(drive.parked.begin(), drive.parked.end(), [](const Drive::Parked& e) { return e.owned && !e.driving; }), drive.parked.end());
    for (const Save::Car& c : save.garage) {
      bool have = false;
      for (const auto& e : drive.parked) have = have || (e.owned && e.plate == c.plate);
      if (!have) { int i = drive.addOwned(c.id, c.plate, c.damage); if (i >= 0) drive.dress(i, c.paint, c.rims); }
    }
    nlohmann::json& imp = save.data("impound", nlohmann::json::array());
    for (auto& r : imp) for (auto& e : drive.parked) if (e.owned && e.plate == r.value("plate", std::string())) e.impoundDay = r.value("day", 0);
  };
  mp.host.save = &save;
  mp.host.plat = plat.get();
  mp.host.flash = [&](const std::string& t, int k) { flash(t, k == 1 ? Hud::Flash::Bad : k == 2 ? Hud::Flash::Gold : Hud::Flash::Good); };
  mp.host.setAI = [&](bool on) { aiOn = on; };
  mp.host.applySave = [&]() {
    syncGarage();
    rig.load(assets, rigColour());
    player.hasSkis = !save.skis.empty();
    if (rideKind == Ride::None && player.mode != PlayerMode::Sit) player.setSkisOn(false);
    pc.online = mp.active();
    // the trains on the world's shared timelines (transit.js): every client places them from the server's clock
    if (mp.active()) {
      railway.mpTime = [&]() { return mp.lineTime("train|rail") / 1000.0; };
      express.mpTime = [&](int dir) { return mp.lineTime(dir > 0 ? "express|e" : "express|w") / 1000.0; };
    } else { railway.mpTime = nullptr; express.mpTime = nullptr; }
    // a chalet bought at the server (one each, the plot free; session.js buyChalet)
    if (mp.active()) pc.buyChalet = [&](int plot, const std::string& nm, std::function<void(bool)> done) {
      mp.buy("chalet", {{"id", plot}, {"name", nm}, {"meta", {{"plan", 2}, {"layout", 3}}}}, [&, plot, done](bool ok, const nlohmann::json& d) {
        if (ok && d.contains("chalet")) { save.data("chalet") = d["chalet"]; mp.profile["chalet"] = d["chalet"]; mp.chaletOwners[plot] = mp.name; mp.chaletPlot = plot; }
        done(ok);
      });
    };
    else pc.buyChalet = nullptr;
    // a sentence you left in (the server's jailUntil): back in the cell (here, not again by the single-player resume)
    if (mp.active()) jailResumed = true;
    const nlohmann::json& jl = save.data("jail");
    if (mp.active() && jl.value("left", 0.0) > 1 && !police.jailed()) { jailQuiet = true; police.jail(jl.value("left", 0.0), jl.value("reason", std::string("Arrested"))); jailQuiet = false; }
    if (mp.active()) {
      const nlohmann::json& pos = save.data("pos");
      if (pos.contains("x") && pos.contains("z") && pos["x"].is_number() && rideKind == Ride::None && !police.jailed()) player.teleport(pos["x"].get<double>(), pos["z"].get<double>(), pos.value("h", PI));
    }
  };
  mp.host.onLost = [&](const std::string& why) {
    if (rideKind == Ride::Passenger) { rideKind = Ride::None; player.standUp(player.pos.x + 2, player.pos.z, player.heading); }
    started = false;
    menus.inGame = false;
    menus.open(Menus::Screen::Main);
    plat->setRelativeMouse(false);
    flash(why, Hud::Flash::Bad);
  };
  mp.host.onKickInterior = [&](const std::string& id) {
    if (id.rfind("chalet:", 0) == 0 && chalets.visiting()) { rooms.leave(); flash("The owner closed the door", Hud::Flash::Bad); }
  };
  mp.host.adminTp = [&](double x, double z, double yaw, const std::string& to) {
    if (rideKind != Ride::None || rooms.inside() || races.active()) { flash("The server tried to move you to " + to + " \xC2\xB7 get out first", Hud::Flash::Bad); return; }
    player.teleport(x - std::sin(yaw) * 1.8, z - std::cos(yaw) * 1.8, yaw);
    flash("Moved next to " + to, Hud::Flash::Good);
  };
  mp.host.onArrested = [&](const nlohmann::json& d) {
    if (rideKind == Ride::Passenger) { rideKind = Ride::None; player.standUp(player.pos.x + 2, player.pos.z, player.heading); }
    std::string by = d.value("by", std::string("the driver"));
    int64_t fine = d.value("fine", 0);
    jailQuiet = true;
    police.jail(std::max(1.0, d.value("seconds", 45.0)), d.value("reason", "Arrested with " + by));
    jailQuiet = false;
    flash(by + " was caught \xC2\xB7 you're going to jail too" + (fine > 0 ? " \xC2\xB7 -" + fmtM(fine) : std::string()), Hud::Flash::Bad);
  };
  mp.host.onSeatLost = [&](const nlohmann::json& d) {
    if (d.value("k", std::string()) == "car" && rideKind == Ride::Passenger) {
      rideKind = Ride::None;
      player.standUp(player.pos.x + 2.2, player.pos.z, player.heading);
      flash("Out of " + d.value("v", std::string("the")) + "'s car", Hud::Flash::Bad);
    }
  };
  mp.host.plots = [&]() { std::vector<int> v; for (const ChaletHouse& h : playData.chalets) v.push_back(h.id); return v; };
  mp.host.transitFingerprint = []() { return std::string("native-phase6"); };
  // your presence (main.js mpPose): the car's pose while you drive, the sled's on a snowmobile, else you
  mp.host.pose = [&](MpPose& o) {
    o.x = player.pos.x; o.y = player.pos.y; o.z = player.pos.z; o.yaw = player.heading;
    o.vx = player.vel.x; o.vy = player.vel.y; o.vz = player.vel.z;
    if (rooms.inside()) {
      Interiors::Room r = rooms.room();
      o.interior = r == Interiors::Room::Prison ? "prison" : r == Interiors::Room::Hospital ? "hospital" : r == Interiors::Room::Shop ? "skishop" : r == Interiors::Room::Autohaus ? "carrental" : chalets.insidePlot() >= 0 ? "chalet:" + std::to_string(chalets.insidePlot()) : "";
      o.st = int(net::St::Walk);
      return;
    }
    if (rideKind == Ride::Car) {
      dvec3 p = drive.pos();
      dvec2 v = drive.vel();
      o.x = p.x; o.y = p.y; o.z = p.z; o.yaw = drive.yaw(); o.vx = v.x; o.vy = 0; o.vz = v.y;
      o.st = int(net::St::Drive);
      o.flags = net::F::car | (drive.lights() ? net::F::lights : 0u) | (police.wanted() ? uint32_t(std::clamp(police.stars(), 1, 5)) << net::F::W_SHIFT : 0u);
      return;
    }
    if (rideKind == Ride::Sled) {
      dvec3 p;
      double yaw;
      if (sleds.current(p, yaw)) { o.x = p.x; o.y = p.y; o.z = p.z; o.yaw = yaw; }
      o.st = int(net::St::Drive);
      o.flags = net::F::sled;
      return;
    }
    if (heli.active()) {   // (net/heli.js MpHeli.pose: flying, your row is the helicopter's pose, its pitch and roll, the rotor at flight power)
      const HeliFlight& hf = heli.flight;
      o.x = hf.pos.x; o.y = hf.pos.y; o.z = hf.pos.z; o.yaw = hf.yaw; o.vx = hf.vel.x; o.vy = hf.vel.y; o.vz = hf.vel.z;
      o.st = int(net::St::Fly); o.crouch = hf.pitch; o.lean = hf.roll; o.flags = heli.rpm > 0.6 ? net::F::lights : 0u;
      return;
    }
    if (rideKind == Ride::Passenger || rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express) { o.st = int(net::St::Ride); o.vx = o.vy = o.vz = 0; return; }
    o.st = player.mode == PlayerMode::Sit ? int(net::St::Sit) : player.mode == PlayerMode::Ski ? int(net::St::Ski) : player.mode == PlayerMode::Fall ? int(net::St::Fall) : int(net::St::Walk);
    o.crouch = player.crouch; o.lean = player.lean;
    o.flags = (player.air ? net::F::air : 0u) | (player.tuck ? net::F::tuck : 0u) | (player.skisOn ? net::F::skisOn : 0u) |
              (player.hasSkis && !player.skisOn ? net::F::carry : 0u) | (player.hasSkis ? net::F::hasSkis : 0u);
    if (player.mode == PlayerMode::Fall) {
      const FallState& F = player.fall;
      o.crouch = F.pitch; o.lean = F.roll;
      o.flags = (player.skisOn ? net::F::skisOn : 0u) | (player.hasSkis ? net::F::hasSkis : 0u) |
                net::fallFlags(player.fallSide, player.air, F.ball, F.getUp, F.axisHeading - player.heading);
    }
  };
  mpv.myCarSeat = [&](int seat, dvec3& p, double& yaw) {
    if (rideKind != Ride::Car) return false;
    yaw = drive.yaw();
    dvec3 f(std::sin(yaw), 0, std::cos(yaw)), rt(f.z, 0, -f.x);
    p = drive.pos() + f * (seat <= 1 ? 0.15 : -0.75) + rt * (seat == 1 || seat == 3 ? -0.42 : 0.42) + dvec3(0, 0.45, 0);
    return true;
  };
  // your car's frame and seats while you drive: the players riding with you, the taxi's fare (vehicles.js localCar)
  auto myCarFrame = [&](glm::dmat4& M, CarTemplate& t) {
    if (rideKind != Ride::Car || !drive.active()) return false;
    M = drive.carMatrix(); t = drive.carTemplate();
    return t.S != nullptr;
  };
  mpv.myCar = myCarFrame;
  mpv.models = &vmodels;
  // (remote.js poseOne: the other players as the game's own skier rig; vehicles.js updateRescue: their rescues)
  mpv.ground = [&](double x, double z, double y) { return world.groundHeight(x, z, y); };
  mpv.drawRescue = [&](Renderer& r, const MpView::RescueDraw& o) {
    if (o.heli) heli.drawOther(r, o.hp, o.yaw, o.pitch, o.roll, o.rpm, o.rope, o.time);
    if (o.amb) heli.rescue.amb.drawAt(r, o.ax, o.az, o.ayaw, o.lights, o.time, double(pc.night));
  };
  mpv.rescuePoint = [&](const MpView::RescueDraw& o, bool seat) { return heli.otherPoint(o.hp, o.yaw, o.pitch, o.roll, seat); };
  oddJobs.carFrame = myCarFrame;
  // the chalets of the others (MP.chalets), buying through the server, visiting with the owner's yes
  pc.chaletOwner = [&](int plot) -> std::string {
    if (!mp.active()) return "";
    auto it = mp.chaletOwners.find(plot);
    return it != mp.chaletOwners.end() && it->second != mp.name ? it->second : "";
  };
  pc.visitChalet = [&](int plot, const std::string& owner, std::function<void(bool, const nlohmann::json&)> done) {
    mp.ask("chaletVisit", "", plot, [&, plot, owner, done](bool allow, const std::string& why) {
      if (!allow) { flash(why.empty() ? owner + " did not let you in" : why, Hud::Flash::Bad); done(false, nlohmann::json::array()); return; }
      mp.chaletFurniture(plot, [&, plot, done](bool, const nlohmann::json& furniture) {
        mp.setInterior("chalet:" + std::to_string(plot), [&, furniture, done](bool ok) {
          if (!ok) flash("Not allowed in", Hud::Flash::Bad);
          done(ok, furniture);
        });
      });
    });
  };
  // the MULTIPLAYER screen
  auto healthUrl = [&]() {
    net::Url u;
    if (!u.parse(mp.url)) return std::string();
    std::string base = (u.tls ? "https://" : "http://") + (u.host.find(':') != std::string::npos ? "[" + u.host + "]" : u.host) + ":" + std::to_string(u.port);
    return base + (u.path.rfind("/ws", 0) == 0 ? "/ws/health" : "/health");
  };
  menus.mp.account = [&]() { auto a = mp.account(); return a ? a->name : std::string(); };
  menus.mp.status = [&]() { return mp.statusLine(); };
  menus.mp.server = [&]() { return mp.url; };
  menus.mp.health = [&]() {
    if (mpHealth.done() && mpHealthLine.empty()) {
      auto j = nlohmann::json::parse(mpHealth.body, nullptr, false);
      if (mpHealth.status == 200 && j.is_object())
        mpHealthLine = "Online \xC2\xB7 " + std::to_string(j.value("worlds", 0)) + (j.value("worlds", 0) == 1 ? " world \xC2\xB7 " : " worlds \xC2\xB7 ") +
                       std::to_string(j.value("players", 0)) + " players \xC2\xB7 you join the fullest world with room (up to " + std::to_string(net::MAX_PLAYERS) + ")";
      else mpHealthLine = "The server does not answer" + (mpHealth.error.empty() ? std::string() : " (" + mpHealth.error + ")");
    }
    return mpHealthLine;
  };
  menus.mp.busy = [&]() { return mp.connecting(); };
  menus.mp.online = [&]() { return mp.active(); };
  menus.mp.players = [&]() {
    std::vector<std::string> v{"World " + std::to_string(mp.worldId) + " \xC2\xB7 " + std::to_string(mp.players.size() + 1) + "/" + std::to_string(mp.worldMax)};
    v.push_back(mp.name + " (you)");
    for (auto& [id, r] : mp.players) v.push_back(r.name);
    return v;
  };
  menus.mp.opened = [&]() { if (!mpHealth.busy()) { mpHealthLine.clear(); mpHealth.start(healthUrl()); } };
  menus.mp.registerName = [&](const std::string& nm) {
    mp.registerName(nm, [&](bool ok, const std::string& msg) { if (ok) flash("Registered as " + msg + " \xC2\xB7 JOIN A WORLD", Hud::Flash::Good); });
  };
  menus.mp.forget = [&]() { mp.forgetAccount(); };
  menus.mp.closed = [&]() { if (!mp.active() && !mp.connecting()) mp.net.close("menu"); };   // (a socket left open after REGISTER)
  menus.mp.join = [&]() {
    mp.start([&](bool ok, const std::string& msg) {
      if (!ok) { flash(msg, Hud::Flash::Bad); return; }
      menus.close();
      if (showcaseOn) showcaseOn = false;
      started = true;
      if (rideKind == Ride::None && player.mode != PlayerMode::Sit && save.data("pos").empty()) { player.setSkisOn(false); player.teleport(4, 34, PI); }
      if (!opt.autotest && !mptest) plat->setRelativeMouse(true);
      flash("Multiplayer \xC2\xB7 world " + std::to_string(mp.worldId) + " \xC2\xB7 " + std::to_string(mp.players.size() + 1) + " player(s) here", Hud::Flash::Good);
    });
  };
  menus.mp.leave = [&]() {
    if (rideKind == Ride::Passenger) { rideKind = Ride::None; player.standUp(player.pos.x + 2, player.pos.z, player.heading); }
    if (rooms.inside()) rooms.leave();
    races.abort();
    mp.leave();
    started = false;
    menus.open(Menus::Screen::Main, -1);
    flash("Back to single player", Hud::Flash::Good);
  };
  {
    std::string un;
    for (char c : plat->userName()) if (std::isalnum(static_cast<unsigned char>(c))) un += c;
    if (un.size() > 10) un.resize(10);
    if (un.size() < 3) un = "Skier";
    menus.mp.suggested = un + std::to_string(10 + unsigned(plat->timeSeconds() * 1000) % 90);
  }
  // E near another player's car: ask the owner (they get Y / N), then the server seats you in it (carride.js)
  auto askRide = [&](const std::string& owner) {
    flash("Asking " + owner + " for a ride...", Hud::Flash::Good);
    mp.ask("carRide", owner, -1, [&, owner](bool allow, const std::string& why) {
      if (!allow) { flash(why.empty() ? owner + " said no" : why, Hud::Flash::Bad); return; }
      mp.claimSeat("car", owner, 5, [&, owner](bool ok, const nlohmann::json& d) {
        if (!ok) { flash(net::errText(d.value("err", std::string())), Hud::Flash::Bad); return; }
        if (rideKind != Ride::None || player.mode == PlayerMode::Sit) { mp.releaseSeat(); return; }
        int pid = -1;
        for (auto& [id, r] : mp.players) if (r.name == owner) pid = id;
        mp.ride = Multiplayer::CarRide{owner, pid, int(d.value("seat", 1)), true};
        dvec3 sp = player.pos, sf(std::sin(player.heading), 0, std::cos(player.heading));
        mp.rideSeat(sp, sf);
        player.setSkisOn(false);
        player.sitOn(sp, sf);
        rideKind = Ride::Passenger;
        flash("Riding with " + owner + " \xC2\xB7 " + prompts::K(input, Action::Interact) + " gets out", Hud::Flash::Good);
      });
    });
  };
  std::string mpSeatWant;
  double mpKeptT = 0;
  std::vector<Traffic::Car> trafficBackup;
  mp.host.setAI = [&](bool on) {
    aiOn = on;
    if (!on) { trafficBackup = traffic.list; traffic.list.clear(); }
    else if (traffic.list.empty()) traffic.list = trafficBackup;
  };
  // (Phase 6) the multiplayer check (--mptest): the menus, a fresh name, a world, presence, purchases at the server,
  // chat, a dropped connection resumed, leaving (the single-player save back)
  bool mpShowCam = false;
  int mpShowN = -1;
  dvec3 mpShowEye{0}, mpShowAt{0};
  struct MpT { int step = 0, f = 0, rq = 0; bool asked = false; double t0 = 0; bool ok = true; std::string name; int64_t m0 = 0; int sent0 = 0; bool waiting = false; nlohmann::json prof; bool got = false; } mt;
  if (mptest) {
    mp.forgetAccount();   // (only this test server's entry)
    mt.name = "Native" + std::to_string(1000 + unsigned(plat->timeSeconds() * 977) % 9000);
    menus.mp.suggested = mt.name;
  }
  if (!started) menus.open(Menus::Screen::Main);
  // (Phase 7) the audio's transitions, the CPU time per system
  Ride prevRideKind = Ride::None;
  bool railAtStop = false;
  PerfStats perf;
  bool audioOk = true, nightOk = true;
  int nightShot = -1, nightLamps = 0, nightSprays = 0, nightCars = 0, nightPlates = 0;
  auto perfMs = []() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); };
  uint32_t frameDraws = 0, maxDraws = 0;
  uint64_t frameTris = 0, maxTris = 0;
  double sumDraws = 0, sumTris = 0;
  int statFrames = 0;
  // (Phase 7) the performance report (the autotest: after the skiing and at the end)
  auto perfReport = [&](const char* what) {
    SL_INFO("[perf] %s: CPU ms per frame by system over %d frames (mean / max)", what, perf.frames());
    double total = 0;
    for (const auto& sy : perf.systems()) total += sy.n ? sy.sum / sy.n : 0;
    for (const auto& sy : perf.systems())
      SL_INFO("[perf]   %-42s %7.2f / %7.2f ms  %4.1f%%", sy.name.c_str(), sy.n ? sy.sum / sy.n : 0.0, sy.max, total > 0 ? 100.0 * (sy.n ? sy.sum / sy.n : 0.0) / total : 0.0);
    SL_INFO("[perf]   %-42s %7.2f ms", "sum", total);
    SL_INFO("[perf] draw calls %.0f mean / %u max, triangles %.0fk mean / %.0fk max (shadow pass included), %d lights", statFrames ? sumDraws / statFrames : 0.0, maxDraws,
            statFrames ? sumTris / statFrames / 1000 : 0.0, double(maxTris) / 1000, renderer.lightsUsed());
    SL_INFO("[perf] GPU memory: textures %.0f MB, buffers %.0f MB (models' textures as loaded: %.0f MB); RSS %.0f MB, peak %.0f MB",
            dev->textureBytes() / 1048576.0, dev->bufferBytes() / 1048576.0, assets.textureBytes() / 1048576.0, plat->memoryBytes() / 1048576.0, plat->peakMemoryBytes() / 1048576.0);
    Resort::StreamStats st = resort.streamStats();
    SL_INFO("[perf] streamed mesh chunks: %zu of %zu resident (%.0f MB on the GPU; all of them packed %.0f MB, %.0f MB raw), %d uploads, %d releases",
            st.loaded, st.chunks, st.gpuBytes / 1048576.0, st.packedBytes / 1048576.0, st.rawBytes / 1048576.0, st.uploads, st.releases);
    perf.reset(); sumDraws = sumTris = 0; statFrames = 0; maxDraws = 0; maxTris = 0;
  };
  std::string outfitKey;
  double shopYaw = 0;
  double shakeAmt = 0, fxFlash = 0, fxHit = 0, dynScale = 1;

  // (leaving: the worker jobs still queued or running (terrain nodes, tree cells) read the world, the transport's
  // railway lines, the forest cuts ... which are declared after the terrain and so destroyed before its destructor
  // waits for them: exit code 139 now and then. This guard is destroyed first and drains the pool)
  struct JobDrain { JobSystem& j; ~JobDrain() { while (j.pending() > 0) std::this_thread::yield(); } } jobDrain{jobs};
  while (running) {
    platform::Events ev;
    plat->pollEvents(ev);
    if (ev.quit) running = false;
    if (ev.resized) { plat->drawableSize(dw, dh); renderer.resize(dw, dh); }
    if (ev.focusLost) { input.clear(); plat->setRelativeMouse(false); audio.setFocused(false, save.settingOn("muteUnfocused")); }
    if (ev.focusGained) audio.setFocused(true, save.settingOn("muteUnfocused"));
    if (ev.toggleFullscreen && !opt.autotest) { save.set("fullscreen", !plat->fullscreen()); applySetting("fullscreen"); }   // F11 / Cmd+F
    input.update(*plat, ev);
    double now = plat->timeSeconds();
    double frameDt = opt.autotest ? (at == AT::Ski ? 1.0 / 60.0 : at == AT::Race ? 0.05 : at == AT::Heli ? 1.0 / 30.0 : 0.1) : std::min(0.25, now - last);
    last = now;
    UiNav nav = navBuilder.build(ev, *plat, input, now);
    if ((opt.autotest && !atRealKeys) || mptest) { float wheel = nav.wheel; nav = UiNav{}; nav.mouse = vec2(-1); nav.wheel = wheel; }   // (the wheel stays real: pushWheel)
    // (Phase 6) the network: events, presence out, the other players, the shared clock, the money guard
    mp.interiorOffset = rooms.inside() ? rooms.toWorld(0, 0, 0) : dvec3(0);
    mp.update(std::min(0.25, frameDt), paused);
    // (main.js: presentation.update(rawDt), dt = rawDt * presentation.timeScale: the world slows, the UI, the transitions
    // and a race's cinematics keep real time)
    const double realDt = frameDt;
    {
      Presentation::Air air;
      air.has = started; air.air = player.air; air.ski = player.mode == PlayerMode::Ski; air.frozen = races.frozen();
      air.airTime = player.airTime; air.airEnd = player.airEnd();
      pres.cinematic = !races.cineStage().empty();
      const bool was = pres.slowing();
      frameDt *= pres.update(std::min(0.05, realDt), air, paused, mp.active());
      if (pres.slowing() && !was) SL_INFO("[slowmo] %s: the world slows (air %.2f s of %.2f s predicted)", pres.reason.c_str(), player.airTime, player.airEnd());
      else if (was && !pres.slowing()) SL_INFO("[slowmo] back to full speed");
      races.timeScale = pres.timeScale;
    }
    if (opt.autotest && at == AT::Ski && off("slowtest")) {
      // (debug: SKI_LEGACY_DEBUG=slowtest,slowmo --autotest: a 14 m drop on skis = a big air: the slow motion's trigger,
      // depth, length and cooldown against presentation/index.js, then a photo finish's { 0.3, 0.12, 1.0, 0.45 })
      static int stage = 0;
      static double realT = 0, minScale = 1, expect = 0, wait = 0;
      static bool ok = true;
      auto check = [&](bool c, const char* what) { SL_INFO("[slowtest] %s -> %s", what, c ? "ok" : "FAILED"); ok = ok && c; };
      if (stage == 0 && phaseFrame == 150) { player.pos.y += 14; stage = 1; SL_INFO("[slowtest] lifted 14 m at %.1f km/h", player.speed() * 3.6); }
      else if (stage == 1 && pres.slowing()) {
        stage = 2; realT = 0; minScale = 1;
        const double left = std::max(0.0, player.airEnd() - player.airTime);
        expect = 0.18 + std::min(1.3, std::max(0.6, left * 1.6)) + 0.4;
        SL_INFO("[slowtest] big air: %.2f s into a flight predicted %.2f s -> slow for %.2f s", player.airTime, player.airEnd(), expect);
        check(pres.reason == "air" && player.airTime > 0.3 && player.airEnd() >= 1.2, "a flight predicted >= 1.2 s slows the world 0.3 s in");
      } else if (stage == 1 && phaseFrame > 400) { check(false, "no big air seen"); stage = 9; }
      if (stage == 2 || stage == 5) {
        if (pres.slowing()) { realT += std::min(0.05, realDt); minScale = std::min(minScale, pres.timeScale); }
        else {
          SL_INFO("[slowtest] %s: %.2f s of real time, the world down to x%.3f", stage == 2 ? "big air" : "photo finish", realT, minScale);
          if (stage == 2) check(std::fabs(realT - expect) < 0.04 && std::fabs(minScale - 0.35) < 0.005, "eased to x0.35 and back over easeIn 0.18 + hold + easeOut 0.4");
          else check(std::fabs(realT - 1.57) < 0.04 && std::fabs(minScale - 0.3) < 0.005, "a photo finish: x0.3 over 0.12 + 1.0 + 0.45 s");
          stage++; wait = 0;
        }
      } else if (stage == 3) {
        wait += std::min(0.05, realDt);
        if (wait >= 1.0) { check(!pres.slowMo(0.3, 0.12, 1.0, 0.45, "photo"), "none during the 1.6 s cooldown"); stage = 4; }
      } else if (stage == 4) {
        wait += std::min(0.05, realDt);
        if (wait >= 1.7) { check(pres.slowMo(0.3, 0.12, 1.0, 0.45, "photo"), "a photo finish's slow motion after the cooldown"); stage = 5; realT = 0; minScale = 1; }
      } else if (stage == 6 || stage == 9) { SL_INFO("[slowtest] %s", ok ? "PASS" : "FAIL"); stage = 10; running = false; }
    }
    pc.online = mp.active();
    if (mp.active() && started && !menus.isOpen() && !tmap.isOpen()) {
      auto pressedKey = [&](platform::Key k) { return std::find(ev.pressed.begin(), ev.pressed.end(), k) != ev.pressed.end(); };
      if (mpv.chatOpen) {   // the chat line: typed letters, Enter sends, Esc closes (the player stands still meanwhile)
        bool shift = plat->keyDown(platform::Key::ShiftLeft) || plat->keyDown(platform::Key::ShiftRight);
        bool text = plat->textInputActive();   // (the OS's text in the keyboard's layout; else letters from the keys)
        std::vector<platform::Key> keys = ev.pressed;
        keys.insert(keys.end(), ev.repeated.begin(), ev.repeated.end());
        for (platform::Key k : keys) {
          int ki = int(k);
          if (text) { if (k == platform::Key::Backspace) textBackspace(mpv.chatText); continue; }
          if (ki >= int(platform::Key::KeyA) && ki <= int(platform::Key::KeyZ)) mpv.chatText += char((shift ? 'A' : 'a') + ki - int(platform::Key::KeyA));
          else if (ki >= int(platform::Key::Digit0) && ki <= int(platform::Key::Digit9)) mpv.chatText += char('0' + ki - int(platform::Key::Digit0));
          else if (k == platform::Key::Space) mpv.chatText += ' ';
          else if (k == platform::Key::Backspace) textBackspace(mpv.chatText);
        }
        if (text) textAppend(mpv.chatText, ev.text, 120, false);
        if (mpv.chatText.size() > 120) mpv.chatText.resize(120);
        if (pressedKey(platform::Key::Enter)) { mp.sendChat(mpv.chatText); mpv.chatOpen = false; mpv.chatText.clear(); }
        else if (pressedKey(platform::Key::Escape)) { mpv.chatOpen = false; mpv.chatText.clear(); }
        input.clear(); input.holdOff();   // (the Esc that closed the chat: not also the pause menu next frame)
      } else if (pressedKey(platform::Key::Enter)) { mpv.chatOpen = true; input.clear(); }
      if (!mp.asks.empty() && !mpv.chatOpen) {   // the owner's answer: Y / N (controller: d-pad up / down)
        if (pressedKey(platform::Key::KeyY) || input.padPressed(12)) mp.answerPerm(mp.asks.front().rid, true);
        else if (pressedKey(platform::Key::KeyN) || input.padPressed(13)) mp.answerPerm(mp.asks.front().rid, false);
      }
    }

    // (Phase 4) the pause menu (Esc / Menu / +), the trail map (M / View / Minus); menus and dialogs take the input
    bool uiOpen = menus.isOpen() || tmap.isOpen() || tmap.travelOpen();
    // any menu, dialog, shop / board / picker or the map: the pointer is free (whoever opened it, from wherever)
    if (uiOpen && !opt.autotest && plat->relativeMouse()) plat->setRelativeMouse(false);
    if (started && !uiOpen && wasUiOpen) { input.clear(); input.holdOff(); }   // (the key that closed it: not also in the game)
    if (started && !uiOpen) {
      // (in every state: on foot, skiing, driving, riding; build mode is left first, as a dialog or the map closes)
      if (input.takePressed(Action::Pause)) {
        if (chalets.building()) chalets.toggleBuild();
        else { menus.inGame = true; menus.open(Menus::Screen::Pause); plat->setRelativeMouse(false); uiOpen = true; }
      }
      else if (input.takePressed(Action::Map)) { tmap.open(player.pos); plat->setRelativeMouse(false); uiOpen = true; }
      else if (!opt.autotest && (ev.mousePressed & 1) && !plat->relativeMouse() && !chalets.wantsFreeMouse()) plat->setRelativeMouse(true);
    } else if (tmap.isOpen() && !opt.autotest) {
      bool mapKey = std::find(ev.pressed.begin(), ev.pressed.end(), input.kb[size_t(Action::Map)]) != ev.pressed.end() || input.padPressed(input.pad[size_t(Action::Map)]);
      if (mapKey) tmap.close();
    }
    if (uiOpen || !started) input.clear();
    wasUiOpen = uiOpen || !started;
    // text input on only while a text field has the focus (the multiplayer name, the chat)
    if (bool wantText = menus.textFieldFocused() || (mpv.chatOpen && mp.active()) || (carCfg.typing && menus.customOpen("carconfig")); wantText != textWanted) { textWanted = wantText; plat->setTextInput(wantText); }
    paused = started && menus.isOpen() && !menus.dialogOpen();

    // (Phase 4 autotest) the main menu -> PLAY -> SINGLEPLAYER -> CHOOSE YOUR SKIER -> START; pause -> SETTINGS -> a
    // value changed -> back; the ski shop: rent skis (money goes down); save, reload, compare
    if (opt.autotest && at == AT::Menu) {
      int f = phaseFrame;
      auto expect = [&](bool ok, const char* what) { if (!ok) { menuOk = false; SL_WARN("[autotest] menu: %s (screen %d, focus '%s')", what, int(menus.screen()), menus.focusedLabel().c_str()); } };
      auto next = [&]() { menuStep++; phaseFrame = -1; input.releaseInjected(); };
      // (debug: SKI_LEGACY_DEBUG=trtest: the screen transitions at fixed moments -> <png>_tr_*.png, then quit)
      if (off("trtest")) {
        struct Shot { int kind; const char* label; double t; const char* name; };
        static const Shot shots[] = {{1, "WORLD RACING \xC2\xB7 Ice Canyon", 0.2, "tr_cover200"}, {1, "WORLD RACING \xC2\xB7 Ice Canyon", 0.45, "tr_cover450"},
                                     {1, "WORLD RACING \xC2\xB7 Ice Canyon", 0.9, "tr_card"}, {1, "Legacy World Downhill", 1.0, "tr_card_long"},
                                     {1, "RACE \xC2\xB7 Sunny Meadow", 1.37 + 0.35, "tr_reveal"}, {0, "", 0.2, "tr_fade200"}, {0, "", 0.5, "tr_fade500"}};
        const int n = int(sizeof shots / sizeof shots[0]), k = f / 3;
        if (f == 0) { started = false; menus.open(Menus::Screen::Main); }
        if (k >= n) running = false;
        else if (f % 3 == 0) {
          const Shot& sh = shots[k];
          trans.seek(1e9); trans.update(0);   // (ends the one before)
          if (sh.kind) trans.teleport(sh.label); else trans.fade();
          trans.seek(sh.t);
          if (!opt.png.empty()) pendingPng = pngVariant(opt.png, sh.name);
        }
      } else
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
          if (f == 4) { expect(menus.screen() == Menus::Screen::Pause && paused, "Esc / Menu -> the pause menu"); if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "pause"); }
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
          // the list scrolls with the wheel / trackpad (a real SDL wheel event) and stays there (the focus does not pull it back)
          static float scrolled = 0;
          if (f == 7) { scrolled = menus.scrollTarget(); if (!plat->pushWheel(3)) SL_INFO("[autotest] settings: no wheel events here"); }
          if (f == 10) {
            bool wheelOk = menus.scrollTarget() < scrolled - 1;
            SL_INFO("[autotest] settings: wheel up scrolls the list %.0f -> %.0f px -> %s", scrolled, menus.scrollTarget(), wheelOk ? "ok" : "FAILED");
            expect(wheelOk, "the wheel scrolls the settings list");
          }
          if (f == 12) nav.cancel = true;     // back to the pause menu
          if (f == 14) { expect(menus.screen() == Menus::Screen::Pause, "back -> the pause menu"); nav.cancel = true; }   // resume
          if (f == 16) { expect(!menus.isOpen() && !paused, "back again -> resumed"); next(); }
          break;
        }
        case 5: {
          // the real path: Esc as SDL key events (SDL_PushEvent -> pollEvents -> Input / UiNav, the menus reading the
          // real events), held and tapped inside one frame, with text input off and on; then the controller's Menu /
          // + on a virtual SDL controller. (Before the fix the pause menu opened and the same Esc resumed it.)
          static bool padOk = false;
          atRealKeys = true;
          auto key = [&](bool down) { if (!plat->pushKey(platform::Key::Escape, down)) expect(false, "Esc pushed through SDL"); };
          auto isPause = [&]() { return menus.screen() == Menus::Screen::Pause && paused; };
          if (f == 1) { plat->setTextInput(false); key(true); }
          if (f == 2) key(false);
          if (f == 4) expect(isPause() && !plat->textInputActive(), "Esc (SDL key event, text input off) -> the pause menu, still open");
          if (f == 5) { key(true); key(false); }   // a tap between two frames
          if (f == 7) expect(!menus.isOpen() && !paused, "Esc tap (text input off) -> resumed");
          if (f == 8) { plat->setTextInput(true); key(true); key(false); }
          if (f == 10) expect(isPause() && plat->textInputActive(), "Esc tap (text input on) -> the pause menu, still open");
          if (f == 11) key(true);
          if (f == 12) key(false);
          if (f == 14) { expect(!menus.isOpen() && !paused, "Esc (text input on) -> resumed"); plat->setTextInput(false); }
          if (f == 15) { padOk = plat->testPad(true); if (!padOk) SL_INFO("[autotest] menu: no virtual controller here (the Menu button not checked)"); }
          if (padOk) {
            if (f == 18) plat->testPadButton(9, true);
            if (f == 19) plat->testPadButton(9, false);
            // (the controller counts as the active device once seen: a real mouse moving over the test window meanwhile
            // would hand the device back to the keyboard)
            static bool padSeen = false;
            if (f >= 18 && f <= 21) padSeen = padSeen || input.usingGamepad();
            if (f == 21) expect(isPause() && padSeen, "Menu / + (virtual controller) -> the pause menu, still open");
            if (f == 22) plat->testPadButton(9, true);
            if (f == 23) plat->testPadButton(9, false);
            if (f == 25) expect(!menus.isOpen() && !paused, "Menu / + again -> resumed");
            if (f == 26) plat->testPad(false);
          }
          if (f == 28) { key(true); key(false); }   // (and the keyboard is the active device again)
          if (f == 30) expect(isPause() && !input.usingGamepad(), "Esc after the controller -> the pause menu");
          if (f == 31) { key(true); key(false); }
          if (f == 33) {
            expect(!menus.isOpen() && !paused && !plat->textInputActive(), "Esc -> resumed, text input off");
            SL_INFO("[autotest] menu: Esc as SDL key events (held, tapped; text input off / on)%s -> the pause menu opens and closes: %s",
                    padOk ? ", Menu / + on a virtual controller" : "", menuOk ? "ok" : "FAILED");
            atRealKeys = false;
            next();
          }
          break;
        }
        case 6:
          if (f == 1) { player.setSkisOn(false); player.teleport(-32.6, -16.4, std::atan2(-8.5, -2.0)); }
          input.inject(Action::Interact, f == 3 || f == 12 || f == 22 || f == 76);   // (the door: once the view is back from the clerk, 0.65 s)
          if (!playData.shop.ok) {   // (no exported room: the card, as before)
            if (f == 6) { expect(menus.dialogOpen(), "E at the ski shop opens it"); money0 = save.money; if (!menus.focusLabel("Rental Carver")) expect(false, "the rental skis in the shop"); }
            if (f == 7) nav.confirm = true;
            if (f == 9) { buyOk = save.money == money0 - kSkis[0].price && save.skis == "rental" && save.ownsSki("rental"); if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "shop"); }
            if (f == 10) nav.cancel = true;
            if (f == 12) { expect(!menus.isOpen(), "the shop closes"); next(); }
            break;
          }
          // the walk-in shop: E at the door -> inside; in front of the rental pair on the ski wall, looking at it: E rents
          // it; the clerk: E opens the shop's card; the door: E -> back outside
          if (f == 6) {
            expect(rooms.room() == Interiors::Room::Shop, "E at the ski shop's door -> inside the shop");
            money0 = save.money;
            if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "shop_in");
          }
          if (f == 8 || f == 18 || f == 30) {
            dvec3 st; double yw = 0;
            const char* kind = f == 8 ? "ski" : f == 18 ? "clerk" : "door";
            if (rooms.aimSpot(kind, f == 8 ? "rental" : "", st, yw)) { player.teleport(st.x, st.z, yw); player.pos.y = rooms.toWorld(0, 0, 0).y; }
            else expect(false, "the shop's ski wall / clerk / door");
          }
          if (f == 11) { expect(prompt.find("Rental Carver") != std::string::npos, "looking at the rental pair: its prompt"); SL_INFO("[autotest] shop: inside, looking at the ski wall: '%s'", prompt.c_str()); if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "shop"); }
          if (f == 15) {
            buyOk = save.money == money0 - kSkis[0].price && save.skis == "rental" && save.ownsSki("rental");
            SL_INFO("[autotest] shop: rented the %s: $%lld -> $%lld, skis '%s' -> %s", kSkis[0].name, (long long)money0, (long long)save.money, save.skis.c_str(), buyOk ? "ok" : "FAILED");
          }
          if (f == 21) { expect(prompt == "Talk to the shop clerk", "looking at the clerk: the prompt"); if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "shop_clerk"); }
          if (f == 25) expect(menus.customOpen("talk") && shopRoom.viewing(), "E at the clerk: the conversation (the portrait view, the card)");
          if (f == 26) nav.cancel = true;
          if (f == 75) expect(prompt == "Leave the shop", "looking at the door: the prompt");
          if (f == 80) { expect(!rooms.inside() && std::hypot(player.pos.x + 31.5, player.pos.z + 16.0) < 6, "E at the door -> back outside the shop"); next(); }
          break;
        case 7: {
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
          if (off("fpview")) player.view = Player::View::First;   // (debug: the run skied in first person: the hands on the poles)
          break;
        }
        default: break;
      }
    }
    // (Phase 6) --mptest: the main menu -> PLAY -> MULTIPLAYER -> REGISTER (a fresh name) -> JOIN A WORLD; presence for
    // a few seconds (the other players seen with --mp-peers); rental skis bought at the ski shop and a day pass at the
    // ticket seller (the money checked against the server's profile); chat; a dropped connection resumed; LEAVE
    // MULTIPLAYER (the single-player save back)
    if (mptest) {
      double el = now - mt.t0;
      mt.f++;
      auto next = [&]() { mt.step++; mt.t0 = now; mt.f = 0; mt.waiting = false; mt.asked = false; mt.got = false; mt.rq++; input.releaseInjected(); };
      auto fail = [&](const std::string& what) { mt.ok = false; SL_WARN("[mptest] FAILED: %s (screen %d, focus '%s', status '%s')", what.c_str(), int(menus.screen()), menus.focusedLabel().c_str(), mp.statusLine().c_str()); };
      // the server's own copy of the profile (one request at a time: a late answer of an earlier one is ignored)
      auto profile = [&]() {
        if (mt.asked) return;
        mt.asked = true; mt.got = false;
        int id = ++mt.rq;
        mp.net.request("profile", nlohmann::json::object(), [&, id](const net::NetResult& r) {
          if (id != mt.rq) return;
          mt.prof = r.ok ? r.d.value("profile", nlohmann::json::object()) : nlohmann::json();
          mt.got = true; mt.asked = false;
        });
      };
      switch (mt.step) {
        case 0: if (mt.t0 == 0) mt.t0 = now; if (el > 1.0) { started = false; menus.open(Menus::Screen::Main); next(); } break;
        case 1: if (el > 0.5 && menus.focusLabel("PLAY")) { nav.confirm = true; next(); } break;
        case 2: if (el > 0.5) { if (menus.screen() != Menus::Screen::PlayMode) fail("PLAY -> the play mode screen"); else if (menus.focusLabel("MULTIPLAYER")) { nav.confirm = true; next(); } } break;
        case 3:
          if (el > 0.5 && !mt.waiting) {
            if (menus.screen() != Menus::Screen::Multiplayer) { fail("MULTIPLAYER -> its screen"); next(); break; }
            SL_INFO("[mptest] MULTIPLAYER screen: server %s, %s", mp.url.c_str(), menus.mp.health().c_str());
            if (menus.focusLabel("REGISTER")) { nav.confirm = true; mt.waiting = true; }
          }
          if (mt.waiting && mp.account()) { SL_INFO("[mptest] registered '%s' (token stored for %s)", mp.account()->name.c_str(), mp.url.c_str()); next(); }
          if (el > 15) { fail("register"); next(); }
          break;
        case 4:
          if (!mt.waiting && el > 0.5) { if (menus.focusLabel("JOIN A WORLD")) { nav.confirm = true; mt.waiting = true; } }
          if (mp.active() && started) {
            SL_INFO("[mptest] joined world %d as %s (pid %d): %zu other player(s), money $%lld (server), clock %.2f h, weather %s", mp.worldId, mp.name.c_str(), mp.pid, mp.players.size(),
                    (long long)save.money, mp.hourNow().value_or(-1), mp.weather().c_str());
            if (save.money != 500) fail("a new profile's money is $500");
            mt.sent0 = mp.presenceSent;
            player.setSkisOn(false); player.teleport(6, 30, PI);
            next();
          }
          if (el > 20) { fail("join"); next(); }
          break;
        case 5:   // presence: walking about for a few seconds
          input.inject(Action::Forward, true);
          input.injectMove(std::sin(el * 0.8) * 0.6f, 1.f);
          if (el > opt.mpSeconds) {
            int sent = mp.presenceSent - mt.sent0;
            SL_INFO("[mptest] presence: %d rows sent in %.1f s (%.1f / s, %d frames), at (%.1f, %.1f, %.1f), rtt %.0f ms", sent, el, sent / el, mt.f, player.pos.x, player.pos.y, player.pos.z, mp.net.rtt());
            if (sent < 3) fail("presence rows");
            next();
          }
          break;
        case 6:   // the other players
          if (opt.mpPeers <= 0) { next(); break; }
          {
            int seen = 0;
            for (auto& [id, r] : mp.players) if (r.ok) seen++;
            if (seen >= opt.mpPeers && !mt.waiting) {
              for (auto& [id, r] : mp.players)
                SL_INFO("[mptest] remote player %s (pid %d): at (%.1f, %.1f, %.1f), state %d, flags 0x%x, look %s, %.0f m away, delay %.0f ms -> drawn", r.name.c_str(), id, r.sm.x, r.sm.y,
                        r.sm.z, r.st, r.flags, r.look.dump().c_str(), glm::length(r.sm - player.pos), r.dly);
              // stand a few metres from the first one, facing it (the screenshot shows the avatar and its name card)
              const RemotePlayer& r0 = mp.players.begin()->second;
              input.releaseInjected();
              player.teleport(r0.sm.x + 6, r0.sm.z + 6, std::atan2(-6.0, -6.0));
              mt.waiting = true; mt.t0 = now;
            } else if (mt.waiting && off("mpshow")) {
              // (debug: SKI_LEGACY_DEBUG=mpshow --mptest URL --mp-peers 1 --png out.png with native/tools/browser/mp_show_peer.mjs:
              // the peer walks without skis, with skis on its back, skis (carving, the tuck, a jump), wipes out and is
              // rescued (helicopter, winch, cabin, ambulance); the rig it is posed with is logged every second and
              // photographed every other one: out_mpshow_<s>.png)
              const RemotePlayer* rp = &mp.players.begin()->second;
              for (auto& [id, rr] : mp.players) if (rr.name.rfind("ShowPeer", 0) == 0) rp = &rr;   // (the one putting on the show)
              const RemotePlayer& r0 = *rp;
              if (!mpShowCam) { mpShowCam = true; player.teleport(4, 50, PI); mt.t0 = now; mpShowN = -1; mpShowEye = dvec3(4, world.groundHeight(4, 47) + 2.6, 47); }
              mpShowAt = dvec3(r0.sm.x * 0.5 + 2, mpShowEye.y - 1.2 + std::max(0.0, (r0.sm.y - (mpShowEye.y - 2.6)) * 0.5), r0.sm.z);
              const int sec = int(now - mt.t0);
              if (sec != mpShowN) {
                mpShowN = sec;
                SL_INFO("[mpshow] %2d s: %s at (%.1f, %.1f, %.1f) state %d flags 0x%x -> rig: %s; %d rig(s), %d rescue(s) drawn", sec, r0.name.c_str(), r0.sm.x, r0.sm.y, r0.sm.z, r0.st, r0.flags,
                        mpv.describe(r0.pid).c_str(), mpv.rigsDrawn, mpv.rescuesDrawn);
                if (sec % 2 == 1 && !opt.png.empty()) pendingPng = pngVariant(opt.png, ("mpshow_" + std::to_string(sec)).c_str());
              }
              // (your own show for the other clients: standing without skis, then from 62 s skis on and off down the plaza)
              if (sec >= 62 && sec < 78) { player.hasSkis = true; if (!player.skisOn) player.setSkisOn(true); input.inject(Action::Forward, true); }
              if (sec >= 78) { input.releaseInjected(); player.setSkisOn(false); player.hasSkis = !save.skis.empty(); mpShowCam = false; mt.step = 49; next(); }
            } else if (mt.waiting && el > 2.5) {
              if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "mp");
              mt.step = 49;   // (on to the car ride, when a peer has a car out)
              next();
            } else if (el > 40) { fail("the other player(s) never showed up (" + std::to_string(seen) + "/" + std::to_string(opt.mpPeers) + ")"); next(); }
          }
          break;
        case 50: {   // a ride in another player's car (carride.js): E "Ask <owner> for a ride", their yes, the seat, E out
          const RemotePlayer* owner = nullptr;
          for (auto& [id, r] : mp.players) if (r.vehs.contains("car") && r.vehs["car"].is_object() && r.vehs["car"].contains("at")) owner = &r;
          if (!owner) { if (el > 12) { SL_INFO("[mptest] car ride: no other player has a car out (skipped)"); mt.step = 6; next(); } break; }
          const nlohmann::json& at = owner->vehs["car"]["at"];
          double cx = at[0].get<double>(), cz = at[2].get<double>(), cyaw = at[3].get<double>();
          if (!mt.waiting) {
            mt.waiting = true; mt.t0 = now; mt.f = 1;
            player.teleport(cx + std::cos(cyaw) * 3.2, cz - std::sin(cyaw) * 3.2, cyaw - PI / 2);
            SL_INFO("[mptest] car ride: %s's %s parked at (%.1f, %.1f): walking up to it", owner->name.c_str(), owner->vehs["car"]["cfg"].value("id", std::string("?")).c_str(), cx, cz);
          }
          input.inject(Action::Interact, mt.f == 6 && rideKind == Ride::None);
          if (mt.f == 5) SL_INFO("[mptest] car ride: prompt '%s'", prompt.c_str());
          if (rideKind == Ride::Passenger && mt.prof.is_null()) {
            mt.prof = nlohmann::json::object(); mt.m0 = int64_t(now * 1000);
            SL_INFO("[mptest] car ride: seated in %s's car, seat %d (the server's registry: %s)", mp.ride.owner.c_str(), mp.ride.seat, mp.mySeat.c_str());
            if (!opt.png.empty()) pendingPng = pngVariant(opt.png, "car");
          }
          if (!mt.prof.is_null() && now * 1000 - double(mt.m0) > 3000 && rideKind == Ride::Passenger) input.inject(Action::Interact, true);
          if (!mt.prof.is_null() && rideKind == Ride::None && player.mode != PlayerMode::Sit) {
            SL_INFO("[mptest] car ride: got out at (%.1f, %.1f), seat released -> ok", player.pos.x, player.pos.z);
            mt.prof = nlohmann::json(); input.releaseInjected();
            mt.step = 6; next();
          } else if (el > 30) { fail("the car ride"); mt.prof = nlohmann::json(); mt.step = 6; next(); }
          break;
        }
        case 7:   // rental skis at the ski shop: bought at the server
          if (mt.f == 1) { input.releaseInjected(); player.setSkisOn(false); player.teleport(-32.6, -16.4, std::atan2(-8.5, -2.0)); mt.m0 = save.money; }
          input.inject(Action::Interact, mt.f == 4);
          if (el > 1.0 && mt.f > 8 && !mt.waiting) {
            // (the walk-in shop: inside, the rental pair on the ski wall, as E in front of it; without the room: the card)
            if (rooms.room() == Interiors::Room::Shop) { skiAction(kSkis[0].id); mt.waiting = true; }
            else if (shopRoom.busy()) { if (el > 6) { fail("E at the ski shop's door goes in"); next(); break; } }
            else if (!menus.dialogOpen()) { fail("E at the ski shop opens it"); next(); break; }
            else if (menus.focusLabel("Rental Carver")) { nav.confirm = true; mt.waiting = true; }
          }
          if (mt.waiting && save.skis == "rental" && !mt.got && el < 20) profile();
          if (mt.got) {
            int64_t sm = mt.prof.value("money", int64_t(-1));
            bool own = false;
            for (auto& o : mt.prof.value("owned", nlohmann::json::array())) own = own || o == "rental";
            bool ok = sm == mt.m0 - kSkis[0].price && own && save.money == sm && mt.prof.value("skis", std::string()) == "rental";
            SL_INFO("[mptest] buy: %s at the ski shop: money $%lld -> $%lld here, the server's profile: money $%lld, owned %s, skis %s -> %s", kSkis[0].name, (long long)mt.m0,
                    (long long)save.money, (long long)sm, mt.prof.value("owned", nlohmann::json::array()).dump().c_str(), mt.prof.value("skis", std::string("-")).c_str(), ok ? "ok" : "FAILED");
            if (!ok) fail("the purchase at the server");
            menus.close();
            if (rooms.inside()) rooms.leave();
            mt.prof = nlohmann::json(); mt.got = false;
            next();
          }
          if (el > 20) { fail("the ski purchase never came back"); menus.close(); if (rooms.inside()) rooms.leave(); next(); }
          break;
        case 8:   // a day pass at the ticket seller: a game charge ('spend') and the pass pushed with the profile
          if (mt.f == 1) { if (playData.hasTickets) player.teleport(playData.tickets[0], playData.tickets[1], PI); else player.teleport(15, -44, PI); mt.m0 = save.money; }
          input.inject(Action::Interact, mt.f == 4);
          if (el > 1.0 && mt.f > 8 && !mt.waiting) {
            if (!menus.dialogOpen()) { fail("E at the ticket seller opens it"); next(); break; }
            if (menus.focusLabel("Day pass")) { nav.confirm = true; mt.waiting = true; SL_INFO("[mptest] ticket seller: '%s' chosen (prompt was '%s', day %d, day pass %d)", menus.focusedLabel().c_str(), prompt.c_str(), save.day, save.dayPass); }
          }
          if (mt.waiting && el > 5 && !mt.got) { menus.close(); profile(); }
          if (mt.got) {
            int64_t sm = mt.prof.value("money", int64_t(-1));
            bool ok = sm == mt.m0 - Prices::dayPass && mt.prof.value("dayPass", -9) == save.day && save.money == sm;
            SL_INFO("[mptest] day pass: $%lld -> $%lld, the server's profile: money $%lld, dayPass %d (world day %d) -> %s", (long long)mt.m0, (long long)save.money, (long long)sm,
                    mt.prof.value("dayPass", -9), save.day, ok ? "ok" : "FAILED");
            if (!ok) fail("the day pass at the server");
            mt.prof = nlohmann::json(); mt.got = false;
            next();
          }
          if (el > 20) { fail("the day pass never came back"); menus.close(); next(); }
          break;
        case 9:   // chat: relayed to the world (us too)
          if (mt.f == 1) { mp.sendChat("hello from the native client"); mt.waiting = true; }
          {
            bool back = false;
            for (auto& l : mp.chat) back = back || (l.from == mp.name && l.text == "hello from the native client");
            if (back) { SL_INFO("[mptest] chat: sent and relayed back (%zu line(s))", mp.chat.size()); next(); }
            else if (el > 10) { fail("chat"); next(); }
          }
          break;
        case 10:   // the connection drops: the server holds us, the reconnect resumes the same player
          if (mt.f == 1) { mt.sent0 = mp.pid; mp.net.simulateDrop(); mt.waiting = true; SL_INFO("[mptest] connection dropped (no close frame): reconnecting..."); }
          if (mt.waiting && el > 1 && mp.net.isOpen() && mp.resumed && mp.pid == mt.sent0) {
            SL_INFO("[mptest] reconnected after %.1f s: resumed, world %d, pid %d, %zu other player(s), status '%s'", el, mp.worldId, mp.pid, mp.players.size(), mp.statusLine().c_str());
            next();
          }
          if (el > 25) { fail("reconnect (resumed)"); next(); }
          break;
        case 11:   // LEAVE MULTIPLAYER from the pause menu
          input.inject(Action::Pause, mt.f == 4);
          if (el > 1.0 && mt.f > 8 && !mt.waiting) {
            if (menus.screen() != Menus::Screen::Pause) { fail("the pause menu"); next(); break; }
            if (menus.focusLabel("LEAVE MULTIPLAYER")) { nav.confirm = true; mt.waiting = true; }
          }
          if (mt.waiting && el > 2.5) {
            bool ok = !mp.active() && !started && menus.screen() == Menus::Screen::Main && save.money == 1234 && !mp.net.isOpen();
            SL_INFO("[mptest] left multiplayer: back at the main menu, the single-player save back (money $%lld, expected $1234) -> %s", (long long)save.money, ok ? "ok" : "FAILED");
            if (!ok) fail("leave");
            next();
          }
          break;
        default:
          SL_INFO("[mptest] %s", mt.ok ? "PASS" : "FAIL");
          running = false;
          break;
      }
      if (mt.step < 12 && now - mt.t0 > (mpShowCam ? 110 : 60)) { fail("step " + std::to_string(mt.step) + " stuck"); next(); }
    }
    if (uiTest && at == AT::Map) {
      nav = UiNav{};
      if (uiT.step == 4) { nav.mouse = vec2(float(renderer.width()) * 0.5f, float(renderer.height()) * 0.5f + 30 * ui.dpr()); nav.mouseMoved = true; }
      else nav.mouse = vec2(-1);
      if (uiT.step == 6 && (uiT.f == 3 || uiT.f == 5)) nav.down = true;
    } else
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
          if (const char* rid = std::getenv("SKI_LEGACY_RACE")) if (const Course* rc = races.courseById(rid)) t5.course = rc;   // (debug: that course)
          if ((off("p5test") || off("racetest")) && save.skis.empty()) { save.skis = "rental"; player.hasSkis = true; }   // (debug: straight here, the ski shop skipped)
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
        if (off("raceshots") && races.active() && !opt.png.empty() && pendingPng.empty() && f % 40 == 20 && f < 1300) pendingPng = pngVariant(opt.png, ("race" + std::to_string(f / 40)).c_str());   // (debug: the race every 2 s)
        const bool raceTest = off("racetest");
        if (raceTest) {
          // (debug: SKI_LEGACY_DEBUG=racetest --autotest --png out.png: the finish played out as session.js does: the
          // podium, the results over it, WATCH REPLAY behind the stinger, every camera of the replay, the stinger, the
          // results again; out_rt_<stage>.png)
          static int stage = 0, shotN = 0;
          static double st = 0, shotT = 0;
          static std::string lastShot;
          static bool ok = true;
          const std::string cs = races.cineStage();
          const double t0 = st;
          static double wall = 0;
          const double wallNow = plat->timeSeconds(), wallDt = wall > 0 ? wallNow - wall : 0;
          wall = wallNow;
          st += stage == 2 || stage == 5 ? wallDt : frameDt;   // (the results screen animates on the wall clock)
          auto at2 = [&](double t) { return t0 < t && st >= t; };
          auto shot = [&](const std::string& n) { if (!opt.png.empty()) pendingPng = pngVariant(opt.png, ("rt_" + n).c_str()); SL_INFO("[racetest] %-16s stage '%s' %.2f s  camera (%.1f, %.1f, %.1f) fov %.1f", n.c_str(), cs.c_str(), races.cineAge(), cam.pos.x, cam.pos.y, cam.pos.z, cam.fovY); };
          auto expect = [&](bool c, const char* what) { SL_INFO("[racetest] %s -> %s", what, c ? "ok" : "FAILED"); ok = ok && c; };
          // (the intro first: presentation/intro.js, the flight down the course and the start-gate crane)
          static double introAge = -1, introSeen = 0;
          if (cs == "intro") {
            const double a0 = introAge, a1 = races.cineAge();
            if (a0 < 0) expect(races.frozen(), "the intro plays before the countdown, the field waiting in the gate");
            for (double q : {0.3, 1.2, 2.6, 4.2, 5.0, 6.0, 7.0, 8.1}) if (a0 < q && a1 >= q) { char nm[32]; std::snprintf(nm, sizeof nm, "intro_%dp%d", int(q), int(std::round(q * 10)) % 10); shot(nm); }
            introAge = a1; introSeen = a1;
          } else if (introAge >= 0) {
            introAge = -1;
            expect(std::fabs(introSeen - 8.4) < 0.11 && races.frozen() && races.raceTime() <= 0, "the intro runs 8.4 s (4.9 s flight + 3.5 s crane), then the countdown");
          }
          static int farMax = 0, fxMax = 0;
          farMax = std::max(farMax, races.botsFar); fxMax = std::max(fxMax, races.botsFx);
          static bool farShot = false;
          if (!farShot && races.botsFar >= 2 && races.raceTime() > 4 && pendingPng.empty()) { farShot = true; shot("far"); }
          if (stage == 0 && cs == "podium") {
            stage = 1; st = 0; expect(!races.resultsUp() && introSeen > 0, "the podium comes before the results");
            SL_INFO("[racetest] the field: up to %d far stand-ins (beyond 150 m), up to %d racers leaving tracks and spray", farMax, fxMax);
            expect(fxMax >= 1 && fxMax <= 6, "the nearest racers (at most 6) leave ski tracks and spray");
          }
          else if (stage == 1) {
            if (at2(0.5)) shot("podium_0p5"); if (at2(2.5)) shot("podium_2p5"); if (at2(5.5)) shot("podium_5p5");
            if (races.resultsUp()) { expect(std::fabs(st - 6.2) < 0.15 && cs == "podium-hold", "the results come up over the podium after 6.2 s"); stage = 2; st = 0; }
          } else if (stage == 2) {
            if (at2(2.5)) shot("results");
            if (at2(3.0)) { expect(races.watchReplay(), "WATCH REPLAY on the results screen"); stage = 3; st = 0; }
          } else if (stage == 3) {
            if (at2(0.2)) shot("sting_in"); if (at2(0.4)) shot("sting_cover");
            if (cs == "replay") { expect(std::fabs(st - 0.45) < 0.11, "the replay starts behind the stinger (0.45 s)"); stage = 4; st = 0; }
          } else if (stage == 4) {
            if (at2(0.25)) shot("sting_out");
            const std::string k = races.replayShot();
            if (k != lastShot) { lastShot = k; shotT = st; SL_INFO("[racetest] replay camera: %s at %.2f s", k.c_str(), st); }
            else if (st > 1 && shotT >= 0 && st - shotT >= 1.4) { shotT = -1; shot("replay" + std::to_string(shotN++) + "_" + k); }
            if (cs != "replay") { expect(st > 8 && shotN >= 4, "the replay ran through its cameras to the finish"); stage = 5; st = 0; }
          } else if (stage == 5) {
            if (at2(2.5)) { expect(races.resultsUp() && menus.customOpen("results"), "the results again after the replay"); shot("results_again"); }
            if (at2(3.0)) races.confirmResults();
            if (at2(3.4)) { expect(!races.active(), "OK ends the race"); SL_INFO("[racetest] %s", ok ? "PASS" : "FAIL"); if (!ok) raceOk = false; running = false; }
          }
        } else if (races.cineStage() == "podium" && races.cineAge() > 2) races.skipCine();   // (SKIP: the results at once)
        else if (races.cineStage() == "intro" && races.cineAge() > 2) { races.skipCine(); SL_INFO("[autotest] race: the intro skipped after %.2f s", races.cineAge()); }
        if (!raceTest && races.resultsUp() && t5.resF < 0) {
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
        if (f > (raceTest ? 6000 : 3600) && t5.resF < 0) { raceOk = false; SL_WARN("[autotest] race: not finished after %.0f s (%.0f m down)", races.raceTime(), races.progress()); races.abort(); nextPhase(AT::Job); }
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
          // (bought at the door; E again: in. The windows' photographs take a frame each: the steps after wait for them)
          const int cf = f <= 9 ? f : std::max(10, f - 14);
          if (cf == 1) { save.earn(60000); t5.money0 = save.money; player.setSkisOn(false); player.teleport(h.doorX, h.doorZ, h.yaw - PI / 2); }
          input.inject(Action::Interact, cf == 3 || cf == 9);
          if (cf == 6) { if (!menus.dialogOpen() || !menus.focusLabel("Buy this chalet")) { chaletOk = false; SL_WARN("[autotest] chalet: no sale dialog (prompt '%s')", prompt.c_str()); } }
          if (cf == 7 && chaletOk) nav.confirm = true;
          if (cf == 11) {
            bool b = chalets.owned() && rooms.room() == Interiors::Room::Chalet && save.money == t5.money0 - playData.chaletPrice;
            chaletOk = chaletOk && b;
            SL_INFO("[autotest] chalet: bought %s: $%lld -> $%lld, inside %s -> %s", h.name.c_str(), (long long)t5.money0, (long long)save.money, rooms.room() == Interiors::Room::Chalet ? "yes" : "no", b ? "ok" : "FAILED");
            t5.furn0 = chalets.furnitureCount();
          }
          input.inject(Action::Furnish, cf == 13);
          if (cf == 16) {
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
          if (cf == 17) input.inject(Action::NextItem, false);
          if (cf == 20 && !opt.png.empty()) pendingPng = pngVariant(opt.png, "build");
          // Esc (an SDL key event) in build mode: leaves build mode, no pause menu
          // the catalogue's cards under the mouse (buildmenu.js: a click takes the card in hand, again puts it down)
          // (the autotest plays on its virtual controller: the virtual mouse points; the free mouse takes the same path)
          input.inject(Action::VMouse, cf == 21);
          if (cf >= 22 && cf <= 40 && playData.furniture.size() > 2) {
            vec2 cc = chalets.cardCentre(2);
            if (cc.x >= 0) { nav.mouse = cc; chalets.setCursor(cc); }
            if (cf == 29 || cf == 37) { nav.click = true; nav.confirm = true; }
            if (cf == 33) { bool ok = chalets.hand() == playData.furniture[2].id; chaletOk = chaletOk && ok; SL_INFO("[autotest] chalet: a click on the %s card (%.0f, %.0f) -> in hand '%s' -> %s", playData.furniture[2].name.c_str(), cc.x, cc.y, chalets.hand().c_str(), ok ? "ok" : "FAILED"); }
            if (cf == 40) { bool ok = chalets.hand().empty(); chaletOk = chaletOk && ok; SL_INFO("[autotest] chalet: a click on it again -> hand '%s' -> %s", chalets.hand().c_str(), ok ? "ok" : "FAILED"); }
          }
          if (cf == 42 && !plat->pushKey(platform::Key::Escape, true)) { chaletOk = false; SL_WARN("[autotest] chalet: Esc not pushed"); }
          if (cf == 43) plat->pushKey(platform::Key::Escape, false);
          if (cf == 45) {
            bool ok = !chalets.building() && !menus.isOpen();
            if (!ok) { chaletOk = false; if (chalets.building()) chalets.toggleBuild(); if (menus.isOpen()) menus.close(); }
            SL_INFO("[autotest] chalet: Esc in build mode -> build mode left, no pause menu: %s", ok ? "ok" : "FAILED");
          }
          if (cf == 47) { dvec3 e = rooms.toWorld(playData.chaletModel.IX - 0.6, 0, playData.chaletModel.doorZ); player.teleport(e.x, e.z, PI / 2); player.pos.y = rooms.toWorld(0, 0, 0).y; }
          input.inject(Action::Interact, cf == 49);
          if (cf == 53) {
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

    // (debug: SKI_LEGACY_DEBUG=rescuetest | ambtest | wardtest | helitest with --autotest [--png out.png]: a wipeout up
    // on the mountain, the rescue helicopter comes, lands, flies you home, the ambulance, waking up in the ward,
    // getting up and out (ambtest: from the pad on; wardtest: the ward only); helitest: the heli-ski base, the flight
    // planner, a flight. A screenshot at every stage (<png>_<stage>.png), the checks logged, then it quits.)
    if (opt.autotest && at == AT::Heli) {
      static struct { int mode = -1, lastPhase = -1, n = 0, wardF = -1, look = 0, hs = 0, hsF = 0; double minGap = 1e9, yawErr = 0, slid = 0, ambYaw = 0, ambGap = 0, ambV = 0; dvec3 lay{0}; bool laid = false, stoodUp = false, landed = false; int64_t money0 = 0; } T;
      const int f = phaseFrame;
      auto shot = [&](const std::string& tag) { if (!opt.png.empty()) pendingPng = pngVariant(opt.png, tag.c_str()); };
      auto check = [&](bool ok, const std::string& what) { SL_INFO("[helitest] %s -> %s", what.c_str(), ok ? "ok" : "FAILED"); if (!ok) heliOk = false; };
      static const char* PH[] = {"none", "inbound", "settle", "pickup", "hover", "home", "arrive", "ambulance"};
      if (f == 0) { T.mode = off("helicheck") ? 4 : off("helitest") ? 3 : off("wardtest") ? 2 : off("ambtest") ? 1 : 0; input.releaseInjected(); player.hasSkis = true; if (save.skis.empty()) save.skis = "rental"; }
      if (T.mode <= 1 && T.wardF < 0) {
        if (f == 2) {   // (flat open snow by default: it lands; SKI_LEGACY_SPOT=x,z: somewhere else, e.g. a steep slope or the trees: the winch)
          double sx = -342.68, sz = -244.42;
          if (const char* e = std::getenv("SKI_LEGACY_SPOT")) std::sscanf(e, "%lf,%lf", &sx, &sz);
          player.setSkisOn(true); player.teleport(sx, sz, 0.6);
        }
        if (f == 40) {
          T.money0 = save.money;
          player.knockDown(1, dvec3(0), 0, false);
          bool ok = heli.rescueMe(false);
          check(ok && heli.rescuing(), "rescue called where you fell");
          if (T.mode == 1) heli.rescue.debugArrive();
        }
        if (f > 40) {
          const HeliFlight& fl = heli.flight;
          int ph = int(heli.rescue.phase);
          if (heli.waiting()) {
            if (!T.laid && player.fall.state == FallState::State::Lie && glm::length(player.vel) < 0.3) { T.laid = true; T.lay = player.pos; }
            if (T.laid) { T.slid = std::max(T.slid, glm::length(player.pos - T.lay)); if (player.mode != PlayerMode::Fall || player.fall.state != FallState::State::Lie) T.stoodUp = true; }
          }
          if (!heli.rescue.gone && ph != 0) {
            double gap = fl.pos.y - fl.fr.cgH - heli.ground(fl.pos.x, fl.pos.z);
            T.minGap = std::min(T.minGap, gap);
            if (fl.speed() > 15) T.yawErr = std::max(T.yawErr, std::fabs(wrapPi(std::atan2(fl.vel.x, fl.vel.z) - fl.yaw)));
          }
          if (ph == 7) {
            const Ambulance& a = heli.rescue.amb;
            if (a.v > 3) { double e = std::fabs(wrapPi(std::atan2(a.vx, a.vz) - a.yaw)); T.ambYaw = std::max(T.ambYaw, e); }
            T.ambGap = std::max(T.ambGap, std::fabs(a.y - world.groundHeight(a.x, a.z)));
            T.ambV = std::max(T.ambV, a.v);
          }
          if (ph != T.lastPhase) {
            T.lastPhase = ph; T.n++;
            SL_INFO("[helitest] f %d: %s; helicopter at (%.1f, %.1f, %.1f) yaw %.2f agl %.1f %s rpm %.2f; you %s at (%.1f, %.1f, %.1f)", f, PH[ph], fl.pos.x, fl.pos.y, fl.pos.z, fl.yaw, fl.agl, fl.landed ? "landed" : "flying", heli.rpm,
                    player.modeName(), player.pos.x, player.pos.y, player.pos.z);
            if (ph == 3) { T.landed = true; double gap = fl.pos.y - fl.fr.cgH - heli.ground(fl.pos.x, fl.pos.z); check(fl.landed && std::fabs(gap) < 0.25, "landed beside you: skids on the snow (gap " + std::to_string(gap) + " m)"); }
            if (ph == 5) check(!T.stoodUp && T.slid < 1.0, "you stayed lying where you fell until picked up (moved " + std::to_string(T.slid) + " m)");
            if (ph == 6) { double gap = fl.pos.y - fl.fr.cgH - heli.home.y; check(fl.landed && std::fabs(gap) < 0.25 && std::hypot(fl.pos.x - heli.home.x, fl.pos.z - heli.home.z) < 2, "landed on the pad (gap " + std::to_string(gap) + " m)"); }
            if (ph != 0) shot(std::string("resc_") + char('0' + T.n) + "_" + PH[ph]);
          } else if (f % 60 == 0 && ph != 0) shot(std::string("resc_") + char('0' + T.n) + "_" + PH[ph] + "_" + std::to_string(f));
          // (the long parts sped up: SPACE x4)
          input.inject(Action::Jump, (ph == 1 && heli.rescue.pt > 4) || (ph == 5 && heli.rescue.pt > 14) || (ph == 7 && heli.rescue.pt > 14));
          if (ward.inBed()) {
            input.releaseInjected();
            T.wardF = f;
            check(T.minGap > -0.15, "the helicopter never below the snow (lowest skid gap " + std::to_string(T.minGap) + " m)");
            check(T.yawErr < 0.6, "the nose along the flight path (worst " + std::to_string(T.yawErr) + " rad at speed)");
            check(T.ambYaw < 1.2 && T.ambGap < 0.8 && T.ambV > 8, "the ambulance drove nose first on the road (worst heading off its path " + std::to_string(T.ambYaw) + " rad, off the ground " + std::to_string(T.ambGap) + " m, top speed " + std::to_string(T.ambV) + " m/s)");
            check(save.money < T.money0, "the bill charged");
          } else if (ph == 0 || f > 12000) { check(false, "the rescue ended in a hospital bed"); running = false; }
        }
      }
      if (T.mode == 2 && f == 2) { player.setSkisOn(false); player.teleport(156.05, 118.08, 0); }
      if (T.mode == 2 && f == 40) { check(ward.admit(), "admitted"); T.wardF = f; }
      if (T.wardF >= 0 && T.mode != 3) {
        const int w = f - T.wardF;   // (30 frames a second)
        static const int WK[] = {4, 12, 20, 28, 36, 44, 54, 66, 80, 100, 126, 168};
        for (int k = 0; k < 12; k++) if (w == WK[k]) shot("wake_" + std::string(k < 10 ? "0" : "") + std::to_string(k));
        if (w == 200) { check(ward.inBed() && ward.recovering() && prompt.rfind("Resting", 0) == 0, "in bed, recovering (prompt '" + prompt + "', line '" + ward.objective() + "')"); shot("ward_bed"); }
        if (w == 204) { input.inject(Action::View, true); }
        if (w == 206) { input.inject(Action::View, false); }
        if (w == 230) shot("ward_third");
        if (w == 234) { input.inject(Action::View, true); }
        if (w == 236) { input.inject(Action::View, false); ward.debugFit(); }
        if (w == 270) { check(ward.inBed() && !ward.recovering() && prompt == "Get up", "fit again (prompt '" + prompt + "', line '" + ward.objective() + "')"); shot("ward_fit"); }
        input.inject(Action::Interact, w == 274 || w == 574);
        if (w == 290) { check(!ward.inBed() && ward.inside() && player.mode == PlayerMode::Walk, "got up"); shot("ward_up"); }
        struct Look { double x, z, yaw; const char* name; };
        static const Look LK[] = {{0, -1.5, PI, "ward_back"}, {0, -3, PI / 2, "ward_left"}, {0, -3, -PI / 2, "ward_right"}, {-4.6, -3.2, PI, "window_back"}, {0, 0.5, 0, "lobby"}, {0, 4.2, 0, "doors"}, {0, 4.2, PI, "from_doors"}, {5.2, 4.3, 0, "window_front"}};
        if (w >= 300 && w < 300 + 8 * 30) {
          const Look& L = LK[(w - 300) / 30];
          if ((w - 300) % 30 == 0) { dvec3 q = rooms.toWorld(L.x, 0, L.z); player.teleport(q.x, q.z, L.yaw); player.pos.y = q.y; player.prevPos = player.renderPos = player.pos; }
          if ((w - 300) % 30 == 20) shot(L.name);
        }
        if (w == 560) { dvec3 q = rooms.toWorld(0, 0, 4.6); player.teleport(q.x, q.z, 0); player.pos.y = q.y; player.prevPos = player.renderPos = player.pos; }
        if (w == 572) check(prompt == "Leave the medical centre", "at the glass doors (prompt '" + prompt + "')");
        if (w == 620) {
          check(!ward.inside() && !rooms.inside() && player.mode == PlayerMode::Walk, "out of the front doors (at " + std::to_string(player.pos.x) + ", " + std::to_string(player.pos.z) + ")");
          shot("ward_out");
        }
        if (w == 626) { SL_INFO("[helitest] %s", heliOk ? "PASS" : "FAIL"); running = false; }
      }
      // (helicheck: what a flight and a rescue do off the beaten path: no skis / no money at the desk, the chart, the
      // drop zone's smoke, your skis in the basket, jumping out of the hover with the drop, the pilot flying it home,
      // leaving it 650 m behind, calling it back from the pad, both watchdogs, a visitor's chair)
      if (T.mode == 4) {
        static struct { int s = 0, f0 = 0, n = 0; int64_t m0 = 0; } C;
        const HeliFlight& fl = heli.flight;
        const int g = f - C.f0;
        auto next = [&]() { C.s++; C.f0 = f; input.releaseInjected(); };
        auto padSpot = [&]() { double a = heli.home.yaw - PI / 2; player.setSkisOn(false); player.teleport(heli.home.x + std::sin(a) * 9, heli.home.z + std::cos(a) * 9, a + PI); };
        auto landOut = [&]() {   // (aboard on a free flight, set down on the flat open snow up the mountain, out)
          if (g == 1) { save.earn(1500); heli.debugFly(-1); heli.debugPlace(-349.3, -253.2, 5, 2.2); }
          input.inject(Action::Sprint, g > 2 && !fl.landed);
          input.inject(Action::Interact, fl.landed && heli.active() && g % 8 == 0);
          return g > 4 && !heli.active() && heli.away();
        };
        auto homeAgain = [&](const char* what) {
          if (heli.state == Heli::State::Parked && !heli.away() && fl.landed && std::hypot(fl.pos.x - heli.home.x, fl.pos.z - heli.home.z) < 2) { check(true, std::string(what) + ": back on its pad after " + std::to_string(g / 30) + " s"); return true; }
          if (g > 4500) { check(false, std::string(what) + ": back on its pad"); return true; }
          return false;
        };
        if (f % 150 == 0) SL_INFO("[helitest] f %d step %d: helicopter at (%.0f, %.0f, %.0f) agl %.1f %s state %d; you %s at (%.0f, %.0f, %.0f); prompt '%s' / '%s'", f, C.s, fl.pos.x, fl.pos.y, fl.pos.z, fl.agl, fl.landed ? "landed" : "flying",
                                  int(heli.state), player.modeName(), player.pos.x, player.pos.y, player.pos.z, prompt.c_str(), heli.hudPrompt().c_str());
        switch (C.s) {
          case 0:   // no skis: the notice
            if (g == 2) { save.skis.clear(); padSpot(); }
            input.inject(Action::Interact, g == 20);
            if (g == 28) { check(menus.dialogOpen() && !tmap.travelOpen() && !heli.active(), "without skis: the notice, no flight"); shot("hc_noskis"); }
            if (g == 30) { menus.close(); save.skis = "rental"; next(); }
            break;
          case 1:   // no money: the chart opens, FLY refuses
            if (g == 2) { save.spend(save.money - 100, true); C.m0 = save.money; }
            input.inject(Action::Interact, g == 10);
            if (g == 18) { check(tmap.travelOpen(), "the flight planner chart opens (you have $" + std::to_string(save.money) + ")"); shot("hc_broke"); }
            if (g == 28) { tmap.travelFocus("Rabenspitz"); tmap.travelChoose(); }
            if (g == 32) { check(!heli.active() && save.money == C.m0, "short of money: no flight, nothing charged"); tmap.closeTravel(); next(); }
            break;
          case 2:   // the chart, a race course in it, a flight plan
            if (g == 2) { save.earn(6000); C.m0 = save.money; }
            input.inject(Action::Interact, g == 10);
            if (g == 18) { bool race = tmap.travelFocus("Sunny Meadow"); check(tmap.travelOpen() && race, "the chart lists the race courses (Sunny Meadow)"); shot("hc_chart_race"); }
            if (g == 30) { check(tmap.travelFocus("Rabenspitz"), "Rabenspitz on the chart"); shot("hc_chart"); }
            if (g == 40) tmap.travelChoose();
            if (g == 46) {
              std::string wl; double wx = 0, wz = 0;
              bool wp = heli.waypoint(wl, wx, wz);
              check(heli.active() && save.money == C.m0 - heli.price() && wp && wl.find("Rabenspitz") != std::string::npos, "FLY: aboard, $" + std::to_string(heli.price()) + " charged, the compass on '" + wl + "'");
              if (wp) heli.debugPlace(wx - 150, wz, 30, PI / 2);   // (150 m short of the drop zone: its red smoke ahead)
              next();
            }
            break;
          case 3:   // the flare's smoke, your skis in the basket
            if (g == 300) shot("hc_flare");
            if (g == 304) { heli.debugPlace(493, -393, 4.5, 2.2); }   // (a slope too steep to land on: hover and jump)
            if (g == 340) shot("hc_basket");
            if (g == 360) { SL_INFO("[helitest] hovering %.1f m over the steep slope: '%s'", fl.agl, heli.hudPrompt().c_str()); check(heli.hudPrompt() == "Jump out and ski", "the prompt over a slope too steep to land on ('" + heli.hudPrompt() + "')"); }
            input.inject(Action::Interact, g == 362);
            if (g == 366) { check(!heli.active() && heli.state == Heli::State::Auto && player.mode == PlayerMode::Ski && player.air, "jumped out: dropping from the skid (" + std::to_string(player.pos.y - world.groundHeight(player.pos.x, player.pos.z)) + " m up), the pilot takes it home"); shot("hc_jump"); }
            if (g == 420) { check(!player.air && player.parked && player.mode == PlayerMode::Ski, "landed on the snow, standing still until you push off"); shot("hc_jumped"); next(); }
            break;
          case 4: if (g == 240) shot("hc_pilot_home"); if (homeAgain("the pilot flew it home")) { shot("hc_pilot_landed"); next(); } break;
          case 5:   // land out, walk 650 m away: it flies home by itself
            if (landOut()) { check(true, "landed out, got out: it waits (prompt '" + prompt + "')"); player.teleport(fl.pos.x + 700, fl.pos.z, 0); next(); }
            else if (g > 900) { check(false, "landed out"); next(); }
            break;
          case 6: if (g == 4) check(heli.state == Heli::State::Auto, "650 m away from it: its pilot takes off for home"); if (homeAgain("left behind")) next(); break;
          case 7:   // land out again, call it back from the pad
            if (landOut()) { padSpot(); next(); }
            else if (g > 900) { check(false, "landed out"); next(); }
            break;
          case 8:
            if (g == 12) { check(prompt.find("call the helicopter back") != std::string::npos, "at the pad while it is out ('" + prompt + "')"); shot("hc_call"); }
            input.inject(Action::Interact, g == 14);
            if (g == 20) { check(heli.state == Heli::State::Auto, "called back: on its way"); player.teleport(heli.home.x + 30, heli.home.z + 30, 0); }   // (off the pad: it waits above while somebody stands on it)
            if (g == 18) check(prompt.find("flying back") != std::string::npos, "the pad's prompt meanwhile ('" + prompt + "')");
            if (g > 20 && homeAgain("called back")) next();
            break;
          case 9:   // a rescue nobody reaches in time: the watchdog
            if (g == 2) { player.setSkisOn(true); player.teleport(-342.68, -244.42, 0.6); }
            if (g == 30) { C.m0 = save.money; player.knockDown(1, dvec3(0), 0, false); check(heli.rescueMe(false), "a rescue called"); }
            if (g == 60) heli.rescue.debugStall();
            if (g == 110) { check(ward.inBed() && !heli.rescuing() && save.money < C.m0, "not picked up in 150 s: straight to the medical centre, the bill charged"); next(); }
            break;
          case 10:  // up, a visitor's chair
            if (g == 30) ward.debugFit();
            input.inject(Action::Interact, g == 60 || g == 120 || g == 170);
            if (g == 90) { dvec3 at; double yaw = 0; bool ok = ward.debugChair(at, yaw); check(ok && !ward.inBed(), "got up"); player.teleport(at.x, at.z, yaw); player.pos.y = at.y; player.prevPos = player.renderPos = player.pos; }
            if (g == 116) check(prompt == "Sit down", "at a visitor's chair ('" + prompt + "')");
            if (g == 150) { check(ward.seated() && player.mode == PlayerMode::Sit && prompt == "Stand up", "sitting by the bed ('" + ward.objective() + "')"); shot("hc_chair"); }
            if (g == 190) { check(!ward.seated() && player.mode == PlayerMode::Walk && ward.inside(), "stood up again"); rooms.leave(); next(); }
            break;
          case 11:  // the ambulance stuck: the other watchdog
            if (g == 4) { player.setSkisOn(true); player.teleport(-342.68, -244.42, 0.6); }
            if (g == 30) { C.m0 = save.money; player.knockDown(1, dvec3(0), 0, false); check(heli.rescueMe(false), "a rescue called"); heli.rescue.debugArrive(); }
            if (g == 90) { check(heli.rescue.phase == HeliRescue::Phase::Ambulance, "in the ambulance"); heli.rescue.debugStall(); }
            if (g == 150) { check(ward.inBed() && !heli.rescuing() && save.money < C.m0, "the ambulance stuck for 45 s: straight to the medical centre, the bill charged"); next(); }
            break;
          case 12:  // leaving in the middle of a rescue and coming back: it carries on
            if (g == 4) { ward.reset(); if (rooms.inside()) rooms.leave(); }
            if (g == 8) { player.setSkisOn(true); player.teleport(-342.68, -244.42, 0.6); }
            if (g == 30) { player.knockDown(1, dvec3(0), 0, false); check(heli.rescueMe(true), "a rescue called (a vehicle's fault: free)"); }
            if (g == 50) { check(save.data("rescue").value("st", std::string()) == "wait", "kept in the save while it runs: " + save.data("rescue").dump()); heli.rescue.keep = true; heli.abort(); player.teleport(4, 34, PI); }
            if (g == 54) { check(!heli.rescuing() && save.data("rescue").value("st", std::string()) == "wait", "left (back to the menu): still in the save"); check(heli.rescue.resume() && heli.rescuing(), "back: the rescue carries on"); }
            if (g == 60) check(std::hypot(player.pos.x + 342.68, player.pos.z + 244.42) < 3 && player.mode == PlayerMode::Fall && std::hypot(fl.pos.x - player.pos.x, fl.pos.z - player.pos.z) < 300, "lying where you lay, the helicopter " + std::to_string(int(std::hypot(fl.pos.x - player.pos.x, fl.pos.z - player.pos.z))) + " m out");
            input.inject(Action::Jump, g > 60);
            if (heli.rescue.phase == HeliRescue::Phase::Home && heli.rescue.pt > 0.4) { check(true, "picked up"); heli.rescue.keep = true; heli.abort(); next(); }
            else if (g > 3000) { check(false, "picked up after coming back"); next(); }
            break;
          case 13:  // ...and from the cabin
            if (g == 2) { nlohmann::json& r = save.data("rescue"); check(r.value("st", std::string()) == "cabin" && r.contains("hp"), "aboard when you left: " + r.dump()); check(heli.rescue.resume() && heli.rescue.inCabin && !fl.landed, "back: on in the cabin, in the air"); }
            if (g == 20) { heli.rescue.debugStall(); }
            if (g == 80) { check(ward.inBed() && save.data("rescue").empty(), "over: nothing left in the save (free: no bill)"); next(); }
            break;
          case 14: {  // flying into a lift's haul rope: pushed back, never through it
            static double minGap = 1e9, cl = 0; static const LiftLine* L = nullptr;
            if (g == 4) { ward.reset(); if (rooms.inside()) rooms.leave(); }
            if (g == 8 && !lifts.lines().empty()) {
              L = &lifts.lines()[0];
              double u = L->L * 0.5, side = L->cfg.side;
              dvec3 c = L->cableAt(u, 1);
              cl = side;
              double x = L->B.x + L->dir.x * u + L->sideV.x * (side + 11), z = L->B.z + L->dir.y * u + L->sideV.y * (side + 11);
              save.earn(1500); heli.debugFly(-1);
              heli.debugPlace(x, z, 10, std::atan2(-L->sideV.x, -L->sideV.y));
              heli.flight.pos.y = c.y - 2.2;   // (the rotor disc at the rope's height)
            }
            if (L && g > 8) {
              double lat = (fl.pos.x - L->B.x) * L->sideV.x + (fl.pos.z - L->B.z) * L->sideV.y;
              minGap = std::min(minGap, lat - cl);
              input.inject(Action::Forward, g < 200);
              if (g == 120) shot("hc_rope");
              { double cy = L->cableAt(L->L * 0.5, 1).y; if (std::fabs(lat - cl) < 1.5 && cy > fl.pos.y - fl.fr.cgH - 0.3 && cy < fl.pos.y + 2.0) minGap = -1; }
              if (g == 200) { check(minGap > -0.5, "against the haul rope of " + L->name + ": pushed back or over it, never through (nearest " + std::to_string(minGap) + " m beside it; now " + std::to_string(lat - cl) + " m, " + std::to_string(fl.pos.y - L->cableAt(L->L * 0.5, 1).y) + " m above)"); heli.abort(); next(); }
            } else if (g > 10) next();
            break;
          }
          default:
            if (g == 4) { SL_INFO("[helitest] %s", heliOk ? "PASS" : "FAIL"); running = false; }
        }
      }
      if (T.mode == 3) {
        const HeliFlight& fl = heli.flight;
        if (f == 2) { save.earn(5000); player.setSkisOn(false); double a = heli.home.yaw + PI / 2; player.teleport(heli.home.x + std::sin(a) * 22, heli.home.z + std::cos(a) * 22, a + PI); }
        if (f == 30) shot("hs_pad");
        if (f == 34) { double a = heli.home.yaw + PI; player.teleport(heli.home.x + std::sin(a) * 14, heli.home.z + std::cos(a) * 14, a + PI); }
        if (f == 60) shot("hs_pad_front");
        if (f == 64) { double a = heli.home.yaw - PI / 2; player.teleport(heli.home.x + std::sin(a) * 9, heli.home.z + std::cos(a) * 9, a + PI); }
        if (f == 90) { check(prompt.rfind("Heli-ski", 0) == 0, "the pad's prompt ('" + prompt + "')"); shot("hs_prompt"); }
        input.inject(Action::Interact, f == 92 || T.hs == 6);
        if (f == 100) { check(tmap.travelOpen() && tmap.travelFocus("Rabenspitz"), "the flight planner chart opened"); shot("hs_dialog"); }
        if (f == 104) { T.money0 = save.money; tmap.travelChoose(); check(heli.active() && player.mode == PlayerMode::Sit, "aboard, at the controls"); T.hs = 1; T.hsF = f; }
        if (T.hs >= 1) {
          int g = f - T.hsF;
          if (f % 60 == 0) SL_INFO("[helitest] f %d step %d: at (%.0f, %.0f, %.0f) %.0f km/h agl %.1f rpm %.2f %s; '%s'", f, T.hs, fl.pos.x, fl.pos.y, fl.pos.z, fl.speed() * 3.6, fl.agl, heli.rpm, fl.landed ? "landed" : "flying", heli.objective().c_str());
          if (T.hs == 1) {   // the turbine spools up, lift off
            if (g == 60 || g == 150) shot("hs_spool_" + std::to_string(g / 30));
            input.inject(Action::Jump, g > 30);
            if (fl.agl > 30) { check(heli.rpm > 0.95 && !fl.landed, "lifted off"); shot("hs_climb"); input.inject(Action::Jump, false); T.hs = 2; T.hsF = f; }
            else if (g > 900) { check(false, "lifted off"); T.hs = 9; }
          } else if (T.hs == 2) {   // away: to flat open snow up the mountain (the keys steer it there)
            const double tx = -349.3, tz = -253.2;
            double d = std::hypot(tx - fl.pos.x, tz - fl.pos.z), err = wrapPi(std::atan2(tx - fl.pos.x, tz - fl.pos.z) - fl.yaw);
            double want = std::min(60.0, std::max(0.0, (d - 3) * 0.2));
            input.inject(Action::Left, err > 0.04); input.inject(Action::Right, err < -0.04);
            input.inject(Action::Forward, std::fabs(err) < 0.6 && fl.speed() < want);
            input.inject(Action::Back, fl.speed() > want + 3);
            if (g == 200) shot("hs_fly");
            if (g == 260) {
              std::string wl; double wx = 0, wz = 0;
              bool wp = heli.waypoint(wl, wx, wz);
              check(fl.speed() > 15 && wp, "flying: " + std::to_string(fl.speed() * 3.6) + " km/h, the compass on '" + wl + "'");
              check(std::fabs(wrapPi(std::atan2(fl.vel.x, fl.vel.z) - fl.yaw)) < 0.5, "the nose along the flight path");
              shot("hs_fly2");
            }
            if (d < 9 && fl.speed() < 3) { input.releaseInjected(); T.hs = 3; T.hsF = f; }
            else if (g > 3000) { input.releaseInjected(); check(false, "flew to the landing spot"); T.hs = 9; T.hsF = f; }
          } else if (T.hs == 3) {   // slow down, come down
            input.inject(Action::Back, fl.speed() > 2);
            input.inject(Action::Sprint, fl.speed() < 8);
            if (fl.landed) { input.releaseInjected(); double gap = fl.pos.y - fl.fr.cgH - heli.ground(fl.pos.x, fl.pos.z); check(std::fabs(gap) < 0.3, "set down on the snow (skid gap " + std::to_string(gap) + " m)"); T.hs = 4; T.hsF = f; }
            else if (g > 1800) { input.releaseInjected(); SL_INFO("[helitest] no landing here (%s)", heli.objective().c_str()); shot("hs_hover"); T.hs = 9; T.hsF = f; }
            if (g % 240 == 120) shot("hs_descent_" + std::to_string(g / 240));
          } else if (T.hs == 4) {
            if (g == 45) { shot("hs_landed"); T.hs = 6; T.hsF = f; }
          } else if (T.hs == 6) { T.hs = 7; T.hsF = f; }
          else if (T.hs == 7) {
            if (g == 50) { check(!heli.active() && player.mode != PlayerMode::Sit, "got out beside the helicopter"); shot("hs_out"); T.hs = 9; T.hsF = f; }
          } else if (T.hs == 9 && g > 4) { SL_INFO("[helitest] %s", heliOk ? "PASS" : "FAIL"); running = false; }
        }
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
      input.injectMove(player.air ? 0.f : -steer, sp < 20 ? 1.f : 0.f);   // (hands off in the air: A / D after a pop spin)
      // a charged jump half way: crouch for 0.4 s, release to pop (exercises take-off, air and landing)
      int jf = opt.frames / 2, sf = frame - skiFrame0;
      input.inject(Action::Jump, sf >= jf && sf < jf + 24);
      // (debug: SKI_LEGACY_DEBUG=tricktest: A pressed after the pop spins, Shift grabs -> "[autotest] trick: ..." on landing)
      if (off("tricktest") && sf >= jf + 24 && sf < jf + 24 + 90 && player.air) {
        input.inject(Action::Forward, false); input.inject(Action::Back, false);
        input.injectMove(-1.f, 0.f);
        input.inject(Action::Sprint, sf >= jf + 24 + 8);
        if (sf == jf + 24 + 22 && !opt.png.empty()) pendingPng = pngVariant(opt.png, "trick");
        if (sf % 6 == 0) SL_INFO("[autotest] air t=%.2f spin %.0f deg flip %.0f deg grab %.2f '%s'", player.airTime, player.tricks.spin * 57.2958, player.tricks.flip * 57.2958, player.tricks.grab, player.trickName().c_str());
      } else if (off("tricktest")) input.inject(Action::Sprint, false);
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
    static double cockpitHold = -9;   // (debug cockpittest: the steering held, -9: off)
    if (opt.autotest && at == AT::Drive) {
      if (phaseFrame == 0) {
        input.releaseInjected();
        // (Phase 4) a grant, then the Autohaus sale (money goes down by the car's price)
        save.earn(25000);
        int64_t before = save.money;
        testCar = buyCar("car_bmw_x3");
        const CarSpec* bmw = transport.car("car_bmw_x3");
        bool paid = testCar >= 0 && bmw && save.money == before - int64_t(bmw->price);
        chargeOk = chargeOk && heliOk && paid;
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
        // (as a driver does: no closer than a time gap behind a traffic car in the lane ahead, never into it)
        double want = 22, fx = std::sin(drive.yaw()), fz = std::cos(drive.yaw());
        for (const auto& c : traffic.list) {
          if (c.mode == Traffic::Car::Mode::Gone) continue;
          double dx = c.x - drive.pos().x, dz = c.z - drive.pos().z, ahead = dx * fx + dz * fz, side = std::fabs(dx * fz - dz * fx);
          if (ahead > 0 && ahead < 60 && side < 2.6) want = std::min(want, std::max(0.0, (ahead - 9) * 0.6));
        }
        din.throttle = drive.speed() < want ? 1.f : 0.f;
        din.brake = drive.speed() > want + 4 ? (drive.speed() > want + 10 ? 1.f : 0.5f) : 0.f;
      }
    }

    // fixed-step simulation (edge-triggered inputs are seen by the first tick of the frame)
    double pt0 = perfMs();
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
      ctl.frozen = races.frozen() || police.arrestedNow() || heli.waiting() || ward.inBed() || shopRoom.busy() || chalets.busy() || police.busy();
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
        if (cockpitHold > -5) { di.throttle = 0; di.brake = 0; di.steer = float(cockpitHold); }   // (debug cockpittest: parked, the wheel as asked)
        di.handbrake = input.down(Action::Jump);
        if (werk.servicing()) { di.throttle = 0; di.brake = 1; di.handbrake = true; }   // (the car is held while it is repaired)
        di.lookBack = input.down(Action::LookBack);
        di.horn = input.down(Action::Horn);
        drive.fixedUpdate(STEP, di, simTime);
      } else drive.fixedUpdate(STEP, DriveInput{}, simTime);
      acc -= STEP;
      simTime += STEP;
      first = false;
    }
    perf.add("sim (120 Hz physics)", perfMs() - pt0);
    PlayerFrameControls fc;
    fc.toggleView = rideKind != Ride::None ? false : input.takePressed(Action::View);
    if ((rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express) && input.takePressed(Action::View)) {
      // (express.js VIEWS: R goes round the window seat, the chase camera, the camera beside the line; walking about: your
      // eyes / the orbit round you. The Wolkenspitzbahn and the bus: seat / outside)
      if (rideKind == Ride::Express && express.walking()) walkToggle = true;
      else if (rideKind == Ride::Express) { trainView = (trainView + 1) % 3; seatView = trainView == 0; rideCamReady = false; }
      else { seatView = !seatView; rideCamReady = false; }
    }
    fc.toggleSkis = input.takePressed(Action::Skis);
    fc.lookX = paused ? 0 : input.lookX(); fc.lookY = paused ? 0 : input.lookY(); fc.wheel = input.wheel();
    fc.now = opt.autotest ? simTime : now; fc.lastLook = opt.autotest ? -1e9 : input.lastLookTime();
    fc.fovSetting = fovSetting; fc.camShake = save.settingOn("camShake");
    player.frameUpdate(frameDt, acc / STEP, fc, ctl);
    if (started && !paused && !races.active()) police.vehicleHits(frameDt, busBoxes);

    for (const PlayerEvent& e : player.events) {
      switch (e.type) {
        case PlayerEvent::Type::Crash: {
          nCrash++; audio.play("crash", 1); shakeAmt = std::max(shakeAmt, 0.9); fxHit = 1; input.rumble(*plat, 0.9f * e.amount, 0.6f * e.amount, 400);
          oddJobs.onCrash();
          if (races.active() || heli.rescuing() || rooms.inside()) break;   // (a race session owns its wipeouts: session.js)
          // main.js: you get up after the first wipeout; the second within 3 min (no lift ride between) calls the rescue
          if (simTime - lastStrikeAt > 180) strikes = 0;
          lastStrikeAt = simTime;
          if (opt.autotest) { flash("Wipeout", Hud::Flash::Bad); break; }
          if (++strikes < 2) flash("Wipeout \xC2\xB7 one more and the rescue helicopter comes", Hud::Flash::Bad);
          else {   // (main.js: heli.rescueMe at once, you stay down where you fell; else the old fade to the medical centre)
            strikes = 0; flash("Wipeout \xC2\xB7 the rescue helicopter is on its way", Hud::Flash::Bad);
            if (rideKind != Ride::None || !heli.rescueMe(false)) rescueAt = simTime + 4;
          }
          break;
        }
        case PlayerEvent::Type::Bump: audio.play("thud", e.amount * 0.6f); input.rumble(*plat, 0.4f * e.amount, 0.3f, 150); break;
        case PlayerEvent::Type::Land: nLand++; if (opt.autotest) SL_INFO("[autotest] landing (impact %.2f)", e.amount); audio.play("land", e.amount); shakeAmt = std::max(shakeAmt, 0.3 + 0.6 * e.amount); if (e.amount > 0.6f) fxFlash = 0.35 * e.amount; input.rumble(*plat, 0.3f + 0.6f * e.amount, 0.2f, 120); break;
        case PlayerEvent::Type::Spin: audio.play("spin", e.amount); break;
        case PlayerEvent::Type::Trick: {
          // (player.js reportTrick -> raceHud.trick: the trick's name, its points and how it was landed)
          const TrickResult& tr = player.lastTrick;
          if (e.amount > 0) audio.play("trick", e.amount);
          bool bailed = tr.landed == TrickResult::Landed::Crash;
          std::string line = tr.name + (bailed ? " \xC2\xB7 Bailed" : " \xC2\xB7 +" + std::to_string(tr.points) + (tr.landed == TrickResult::Landed::Sketchy ? " \xC2\xB7 Sketchy" : " \xC2\xB7 Clean"));
          popups.trick(tr.name, tr.points, tr.total, bailed ? 2 : tr.landed == TrickResult::Landed::Sketchy ? 1 : 0, simTime);
          if (opt.autotest) SL_INFO("[autotest] trick: %s", line.c_str());
          break;
        }
        case PlayerEvent::Type::Pop: if (opt.autotest) SL_INFO("[autotest] pop (charge %.2f) at %.1f km/h", e.amount, player.speed() * 3.6); audio.play("pop", e.amount); input.rumble(*plat, 0.1f, 0.2f + 0.4f * e.amount, 60); break;
        case PlayerEvent::Type::Step: audio.play("step", e.amount); break;
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
      if (h.pending && h.rescue && !heli.rescuing() && rescueAt < 0) { strikes = 0; if (rideKind != Ride::None || !heli.rescueMe(true)) rescueAt = simTime + 3;   /* (hit by a vehicle: not your fault, no fee) */ flash("Hit by a " + h.what + " at " + std::to_string(h.kmh) + " km/h \xC2\xB7 the mountain rescue is on its way", Hud::Flash::Bad); }
    }
    if (rescueAt > 0 && simTime >= rescueAt) {
      rescueAt = -1;
      if (!races.active() && !heli.rescuing()) doRescue();
    }
    // (Phase 5) the gameplay systems' frame
    pc.now = simTime;
    pc.driving = rideKind == Ride::Car;
    pc.riding = rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express || (player.mode == PlayerMode::Sit && !heli.riding() && !ward.seated());
    if (started && !rescueResumed) { rescueResumed = true; if (!opt.autotest && !mp.active()) heli.rescue.resume(); }   // (a rescue under way when you left: rescue.js resume)
    if (started && !jailResumed) {
      jailResumed = true;
      const nlohmann::json& jl = save.data("jail");
      if (!opt.autotest && jl.value("left", 0.0) > 0.5) police.jail(jl.value("left", 0.0), jl.value("reason", std::string("Arrested")));
    }
    pt0 = perfMs();
    if (started && !paused) {
      weather.update(frameDt);
      races.update(frameDt);
      oddJobs.update(frameDt);
      police.update(frameDt);
      police.peopleHits(frameDt);
      heli.update(frameDt, !menus.isOpen() && !tmap.isOpen());
      ward.update(frameDt, !menus.isOpen() && !tmap.isOpen());
      shopRoom.update(frameDt);
      werk.update(frameDt);
      rooms.chaletStep(frameDt);
      rooms.prisonStep(frameDt);
      police.setView(cam.pos, cam.forward());
      if (outfitShop.isOpen() && !menus.customOpen("shop")) outfitShop.close();
      if (police.fleeing()) { oddJobs.policeChase(); if (races.active()) police.clear("race"); }
      if (races.active() && oddJobs.active()) oddJobs.drop();
      if (input.takePressed(Action::Duty) && oddJobs.onDuty()) oddJobs.endTaxi("Shift ended");
    }
    folk.setPlayer(player.pos);
    if (aiOn) folk.update(paused ? 0 : frameDt, cam.pos, light.night, &scenery);
    npcs.off = !aiOn;
    npcs.update(paused ? 0 : frameDt, player.pos, cam.pos, 1 - light.night);
    perf.add("gameplay (races, jobs, police, people)", perfMs() - pt0);
    // the career (economy.js stats): top speed, distance skied
    if (started && player.mode == PlayerMode::Ski) {
      static double lastDist = player.distance;
      double dd = player.distance - lastDist;
      if (dd > 0 && dd < 50) save.stats.distance += dd;
      lastDist = player.distance;
      // (bests.js: a new top speed, the longest jump, the biggest air, distance milestones: one card each, a soft chime)
      if (popups.updateBests(frameDt, player.mode == PlayerMode::Ski && rideKind == Ride::None, player.speed(), player.air, player.airTime, player.pos,
                             player.lastTrick.landed == TrickResult::Landed::Crash, save, races.active(), simTime)) audio.play("gate");
      if (player.speed() > save.stats.topSpeed && player.speed() < 70) save.stats.topSpeed = player.speed();
    }

    // lifts: move the cars first, then seat the rider on the updated car (no lag); the boarding prompt
    lifts.timeScale = player.mode == PlayerMode::Sit && !paused && input.down(Action::Jump) && !heli.riding() && !ward.seated() ? 16 : 1;   // hold Space: x16 (Space climbs in the helicopter)
    lifts.update(paused ? 0 : frameDt, player.pos);
    prompt.clear(); rideLine.clear();
    bool interact = input.takePressed(Action::Interact);
    bool nextItem = input.takePressed(Action::NextItem), prevItem = input.takePressed(Action::PrevItem);
    (void)nextItem; (void)prevItem;   // (the stops' route picker takes [ ] itself now)
    bool fastHeld = !paused && input.down(Action::Jump);
    // (Phase 3) the vehicles move first, then the rider is seated on them
    double vdt = paused ? 0 : frameDt;
    pt0 = perfMs();
    busBoxes.clear();
    buses.boxes(busBoxes);
    traffic.update(vdt, player.pos, &drive, busBoxes, cam);
    if (opt.autotest && at == AT::Ski && off("werktest") && werk.available()) {
      // (debug: a damaged car of yours standing in the Werkstatt's box, you at the workbench: the prompt, E, the repair;
      // then a mountain hut's door and the ticket counter: o_werk_<n>.png, the checks logged)
      static int wf = 0, wi = -1;
      static int64_t m0 = 0;
      wf++;
      const WerkstattDef& WS = playData.werkstatt;
      auto shot = [&](const char* n) { if (!opt.png.empty()) pendingPng = pngVariant(opt.png, n); };
      if (wf == 5) {
        wi = drive.addOwned("car_vw_golf_gti", "ZZ 4711", 37);
        if (wi >= 0) { const dvec3 b = werk.world(WS.bayX, WS.bayZ); Drive::Parked& e = drive.parked[size_t(wi)]; e.x = b.x; e.z = b.z; e.y = b.y + 0.03; e.yaw = WS.yaw + PI; }
        const dvec3 w = werk.world(WS.benchX - 0.8, WS.benchZ + 1.2);
        player.setSkisOn(false); player.teleport(w.x, w.z, WS.yaw + PI * 0.75);
        save.earn(1000); m0 = save.money;
      }
      if (wf == 40) { SL_INFO("[werktest] at the workbench: prompt '%s' (car %d, damage %.0f%%)", prompt.c_str(), wi, wi >= 0 ? drive.parked[size_t(wi)].damage : -1); shot("werk_prompt"); }
      input.inject(Action::Interact, wf == 44);
      if (wf == 150) shot("werk_repairing");
      if (wf == 420) { const bool ok = wi >= 0 && drive.parked[size_t(wi)].damage == 0 && save.money == m0 - repairCost(0.37); SL_INFO("[werktest] repaired: damage %.0f%%, money $%lld -> $%lld -> %s", wi >= 0 ? drive.parked[size_t(wi)].damage : -1, (long long)m0, (long long)save.money, ok ? "ok" : "FAILED"); shot("werk_done"); }
      if (wf == 430 && !playData.hutDoors.empty()) player.teleport(playData.hutDoors[0][0], playData.hutDoors[0][1], PI);
      if (wf == 470) { SL_INFO("[werktest] at a hut's door: prompt '%s'", prompt.c_str()); shot("hut_prompt"); }
      input.inject(Action::Interact, wf == 474);
      if (wf == 500) { SL_INFO("[werktest] the hut's card: %s", menus.dialogOpen() ? "open" : "NOT OPEN"); shot("hut_card"); }
      if (wf == 502) nav.cancel = true;
      if (wf == 510 && playData.hasTickets) player.teleport(playData.tickets[0], playData.tickets[1], 0);
      if (wf == 550) { SL_INFO("[werktest] at the ticket counter: prompt '%s'", prompt.c_str()); shot("tickets_prompt"); }
      player.vel = dvec3(0);
    }
        if (opt.autotest && at == AT::Ski && (off("roomchalet") || off("roomprison")) && playData.chaletRoom.ok && playData.prisonDef.ok) {
      // (debug: inside a chalet / the police station from the web game's reference views: o_ch_<name>.png, o_po_<name>.png)
      static int rf = 0;
      rf++;
      const bool ch = off("roomchalet");
      struct Look { const char* name; int level; double x, z, yaw, pitch; };
      static const Look chL[] = {{"in_enter", 0, 3.07, -0.17, -PI / 2, -0.05}, {"in_living", 0, 1.5, -3.0, std::atan2(-1.0, -0.6), -0.05}, {"in_living2", 0, -2.5, -5.0, 0.5, -0.05}, {"in_hall", 0, 2.6, 0.2, -PI / 2, -0.05},
        {"in_door", 0, 1.5, -0.17, PI / 2, -0.05}, {"in_snug", 0, -1.5, 4.6, PI, -0.05}, {"in_bath", 0, 2.5, 2.4, 0.2, -0.05}, {"in_window", 0, -1.8, -3.5, -PI / 2, -0.05}, {"in_stair", 1, -1.3, -1.2, 0, 0.35},
        {"up_landing", 2, 0.0, 0.0, PI, -0.05}, {"up_bedA", 2, 0.5, -4.2, PI + 0.5, -0.05}, {"up_bedC", 2, 0.5, 4.2, -0.5, -0.05}, {"up_bath", 2, -2.6, 0.6, -2.4, -0.05}, {"up_window", 2, 2.0, 0.5, PI / 2, -0.05}};
      static const Look poL[] = {{"in_enter", 0, 16.05, 2.6, -PI / 2, -0.04}, {"in_office", 0, 15.5, 4.0, -2.2, -0.05}, {"in_counter", 0, 13.0, 2.6, PI, -0.05}, {"in_board", 0, 12.0, 1.5, 0, -0.05}, {"in_gate", 0, 11.5, 1.5, -PI / 2, -0.05},
        {"in_corridor", 0, 7.5, 1.6, -PI / 2, -0.05}, {"in_cells", 0, 0, 2.6, PI, -0.05}, {"in_cell_close", 0, 3.6, 0.4, PI, -0.05}, {"in_end", 0, -3.0, 1.6, -PI / 2, -0.05}, {"in_back", 0, -4.0, 1.6, PI / 2, -0.05}, {"in_exit", 0, 15.2, 2.6, PI / 2, -0.05}};
      static const Look jaL[] = {{"cell_enter", 0, 0.4, -1.4, 0.15, -0.05}, {"cell_bars", 0, 0.2, -2.6, 0, -0.05}, {"cell_back", 0, 0.0, -1.2, PI, -0.05}, {"cell_left", 0, 0.4, -2.0, -PI / 2, -0.05}, {"cell_right", 0, -0.4, -2.0, PI / 2, -0.05}, {"cell_door", 0, 0.9, -1.0, 0.3, -0.05}};
      const Look* L = ch ? chL : poL;
      const int NL = ch ? int(sizeof(chL) / sizeof(chL[0])) : int(sizeof(poL) / sizeof(poL[0])), NJ = ch ? 0 : int(sizeof(jaL) / sizeof(jaL[0])), per = 30, t0 = 30;
      auto shot = [&](const std::string& n) { if (!opt.png.empty()) pendingPng = pngVariant(opt.png, n.c_str()); SL_INFO("[roomtest] %s: prompt '%s', place '%s'", n.c_str(), prompt.c_str(), ch ? chalets.location().c_str() : police.objective().c_str()); };
      if (rf == 4) { player.setSkisOn(false); if (ch) { const ChaletHouse& h = playData.chalets[0]; player.teleport(h.doorX, h.doorZ, 0); chalets.goInside(0); } else { player.teleport(playData.prisonDef.doorX, playData.prisonDef.doorZ, 0); police.debugVisit(); } }
      const int k = (rf - t0) / per, ph = (rf - t0) % per;
      if (rf >= t0 && k < NL) { if (ph == 0) rooms.debugLook(L[k].x, L[k].z, L[k].yaw, L[k].pitch, L[k].level); if (ph == per - 2) shot(std::string(ch ? "ch_" : "po_") + L[k].name); }
      const int v = rf - t0 - NL * per;
      if (!ch && v == 2) { rooms.leave(); }
      if (!ch && v == 20) police.jail(60, "Speeding");
      const int kj = (v - 50) / per, pj = (v - 50) % per;
      if (!ch && v >= 50 && kj < NJ) { if (pj == 0) rooms.debugLook(jaL[kj].x, jaL[kj].z, jaL[kj].yaw, jaL[kj].pitch); if (pj == per - 2) shot(std::string("po_") + jaL[kj].name); }
      if (!ch && v == 50 + NJ * per + 5) police.skipJail(0.5);
      if (!ch && v == 50 + NJ * per + 90) shot("po_released");
      player.vel = dvec3(0);
    }
    if (opt.autotest && at == AT::Ski && off("roomshop") && shopRoom.available()) {
      // (debug: the ski shop from the web game's reference views (the same spots and angles), the clerk's conversation,
      // the outfit shop's tabs: o_in_<name>.png, o_talk.png, o_outfit_<tab>.png)
      static int rf = 0;
      rf++;
      struct Look { const char* name; double x, z, yaw, pitch; };
      static const Look looks[] = {{"enter", 0, 2.6, PI, -0.05}, {"wall", 0, 0.5, PI, -0.05}, {"wall_left", -3, 0.5, PI, -0.05}, {"wall_right", 3, 0.5, PI, -0.05}, {"clerk", 2.6, 1.4, PI / 2, -0.05},
                                   {"outfits", -3.6, -0.45, -PI / 2, -0.05}, {"door", 0, 0, 0, -0.05}, {"right", 0, 0, PI / 2 + 0.5, -0.05}, {"window", -4.7, 2.2, 0, -0.05}, {"ski_close", -5.2, -1.6, PI, 0.05}};
      const int NL = int(sizeof(looks) / sizeof(looks[0])), per = 30, t0 = 20;
      auto shot = [&](const std::string& n) { if (!opt.png.empty()) pendingPng = pngVariant(opt.png, n.c_str()); SL_INFO("[roomtest] %s: prompt '%s'", n.c_str(), prompt.c_str()); };
      if (rf == 4) { const RoomDef& d = playData.shop; player.setSkisOn(false); player.teleport(d.doorX + d.frontX, d.doorZ + d.frontZ, 0); shopRoom.enter(); }
      const int k = (rf - t0) / per, ph = (rf - t0) % per;
      if (rf >= t0 && k < NL) {
        const Look& L = looks[k];
        shopRoom.debugLook(L.x, L.z, L.yaw, L.pitch);
        const dvec3 w = rooms.toWorld(L.x, 0, L.z);
        if (ph == 0) { player.teleport(w.x, w.z, L.yaw); player.pos.y = w.y; }
        if (ph == per - 2) shot(std::string("in_") + L.name);
      }
      const int v = rf - t0 - NL * per;   // the views
      if (v == 0) { shopRoom.debugLook(2.6, 1.4, PI / 2, -0.05); shopRoom.talk("Shop clerk", "Ski Rental & Shop", "Gr\xC3\xBC" "ezi! You have everything except skis. The rental pair is on the left; the race skis are further along the wall."); }
      if (v == 20) shot("talk_0");
      if (v == 110) shot("talk");
      if (v == 112) nav.cancel = true;
      if (v == 200) shot("talk_after");
      if (v == 202) { shopRoom.debugLook(-3.6, -0.45, -PI / 2, -0.05); outfitShop.open(); }
      if (v == 222) shot("outfit_0");
      if (v == 320) shot("outfit_jackets");
      static const char* tabRow[5] = {"Forest Green", "Charcoal", "Gloss White", "Smoke", "Freeride Forest"};
      static const char* tabName[5] = {"jacket3", "trousers", "helmets", "goggles", "kits"};
      for (int i = 0; i < 5; i++) { if (v == 330 + i * 60) outfitShop.focus(i, tabRow[i]); if (v == 330 + i * 60 + 50) shot(std::string("outfit_") + tabName[i]); }
      if (v == 640) nav.cancel = true;
      if (v == 740) shot("outfit_closed");
      player.vel = dvec3(0);
    }
    if (opt.autotest && at == AT::Ski && ((off("roomshop") && !shopRoom.available()) || off("roomauto"))) {   // (debug: a walk-in room from a few spots, shots o_room<n>.png)
      static int rf = 0;
      rf++;
      const bool shop = off("roomshop");
      auto stand = [&](const char* kind, const char* id) { dvec3 st; double yw = 0; if (rooms.aimSpot(kind, id, st, yw)) { player.teleport(st.x, st.z, yw); player.pos.y = rooms.toWorld(0, 0, 0).y; } };
      if (rf == 4) rooms.enter(shop ? Interiors::Room::Shop : Interiors::Room::Autohaus);
      if (rf == 70) stand(shop ? "ski" : "car", shop ? "carver" : "car_bmw_x3");
      if (rf == 110) stand("clerk", "");
      if (rf == 150) stand(shop ? "outfits" : "car", shop ? "" : "car_audi_rs6");
      if (rf == 190) stand("door", "");
      if (rf > 4 && rf < 230 && rf % 40 == 28 && !opt.png.empty() && pendingPng.empty()) { pendingPng = pngVariant(opt.png, ("room" + std::to_string(rf / 40)).c_str()); SL_INFO("[roomtest] shot %d: prompt '%s'", rf / 40, prompt.c_str()); }
      player.vel = dvec3(0);
    }
    if (opt.autotest && at == AT::Ski && off("sledtest")) {   // (debug: a snowmobile driven into a parked car's side: it bounces off / stops; shots o_sled<n>.png)
      static int sf = 0;
      static dvec3 carAt(0);
      sf++;
      if (sf == 5) {
        int idx = -1;
        for (size_t i = 0; i < drive.parked.size(); i++) if (!drive.parked[i].driving) { idx = int(i); break; }
        if (idx >= 0) {
          const Drive::Parked& e = drive.parked[size_t(idx)];
          carAt = dvec3(e.x, e.y, e.z);
          // (from its nose: straight at the front of the car, 26 m out)
          const dvec3 from = carAt + dvec3(std::sin(e.yaw), 0, std::cos(e.yaw)) * 26.0;
          sleds.debugRide(dvec3(from.x, world.groundHeight(from.x, from.z, e.y + 3), from.z), e.yaw + PI);
          rideKind = Ride::Sled; rig.skisInRide = false;
          SL_INFO("[sledtest] on a snowmobile 26 m in front of the %s at (%.0f, %.0f), driving at it", e.name.c_str(), e.x, e.z);
        }
      }
      if (sf > 5 && rideKind == Ride::Sled) {
        input.inject(Action::Forward, sf < 400);
        dvec3 sp; double sy = 0;
        if (sleds.current(sp, sy) && sf % 12 == 0) SL_INFO("[sledtest] f %3d  %5.1f km/h  %5.2f m from the car's middle", sf, sleds.speed() * 3.6, std::hypot(sp.x - carAt.x, sp.z - carAt.z));
        if (sf % 45 == 30 && sf < 420 && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, ("sled" + std::to_string(sf / 45)).c_str());
      } else if (sf > 5 && sf % 60 == 0) SL_INFO("[sledtest] f %d: off the sled (thrown off: %s)", sf, player.mode == PlayerMode::Fall ? "yes" : "no");
    }
    if (opt.autotest && at == AT::Ski && off("cockpittest")) {
      // (debug: every car's cockpit (SKI_LEGACY_CAR: only that one), from the web reference shots' viewpoints: ahead,
      // down at your hands, left, right, back, the wheel turned, then the chase view: o_<car>_<view>.png)
      static const char* ALL[] = {"car_vw_golf_gti", "car_tesla_m3", "car_bmw_x3", "car_toyota_gr_yaris", "car_audi_rs6", "car_mercedes_gls", "car_audi_etron_gt",
                                  "car_porsche_taycan", "car_mercedes_sls", "car_lamborghini_huracan"};
      static int cf = 0;
      const char* want = std::getenv("SKI_LEGACY_CAR");
      const int per = 260, k = cf / per, f = cf % per, n = want ? 1 : int(sizeof ALL / sizeof ALL[0]);
      cf++;
      if (k < n) {
        const std::string model = want ? want : ALL[k], tag = model.rfind("car_", 0) == 0 ? model.substr(4) : model;
        if (f == 5) {
          if (drive.active()) { drive.stopNow(); dvec3 ex; if (drive.exit(ex)) standOff(ex, "Parked"); }
          int idx = drive.debugCar(model);
          if (idx >= 0) {
            drive.dress(idx, "white", "orig");
            if (drive.enter(idx)) {
              rideKind = Ride::Car;
              player.setSkisOn(false);
              dvec3 sp, sf;
              drive.seat(sp, sf);
              player.sitOn(sp, sf);
              drive.setCockpit(true);
              SL_INFO("[cockpittest] in the %s, the cockpit view", model.c_str());
            }
          }
        }
        struct V { int at; const char* name; double yaw, pitch; };
        static const V VIEWS[] = {{60, "fwd", 0, -0.05}, {90, "down", 0, -0.7}, {120, "left", 1.3, -0.15}, {150, "right", -1.3, -0.15}, {180, "back", 2.09, -0.1}, {212, "steer", 0, -0.45}};
        if (drive.active() && drive.cockpit()) for (const V& v : VIEWS) if (f > v.at - 30 && f <= v.at) drive.setLook(v.yaw, v.pitch);
        // (parked, as the reference shots: no throttle, the wheel turned to the left for the "steer" view)
        cockpitHold = f > 182 && f <= 212 ? 1 : 0;
        if (f == 60 && drive.active()) { const dvec3 e = drive.debugEye(); SL_INFO("[cockpittest] %s: eyeRig (%.3f, %.3f, %.3f), steer %.2f", model.c_str(), e.x, e.y, e.z, drive.debugSteer()); }
        if (f == 212 && drive.active()) SL_INFO("[cockpittest] %s: steer %.2f", model.c_str(), drive.debugSteer());
        if (f == 214) drive.setCockpit(false);
        for (const V& v : VIEWS) if (f == v.at && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, (tag + "_" + v.name).c_str());
        if (f == 252 && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, (tag + "_chase").c_str());
      }
    }
    if (opt.autotest && at == AT::Ski && off("traintest")) {
      // (debug: the trains from your seat, as the web reference shots: the Wolkenspitzbahn boarded at the valley station
      // going up, then the Legacy Express from its first station: ahead, left, right, hard left, down, up, across the
      // aisle while it stands, and out of the window 23 s later, under way: o_rail_<view>.png, o_express_<view>.png)
      static int tf = 0;
      struct V { const char* name; double yaw, pitch; };
      static const V VIEWS[] = {{"fwd", 0, -0.04}, {"left", 1.2, -0.1}, {"right", -1.2, -0.1}, {"sideL", 1.75, -0.05}, {"down", 0, -0.8}, {"up", 0.4, 0.7}, {"aisle", 0.5, -0.15}};
      const int half = 2600, ph = tf / half, f = tf % half;
      tf++;
      if (ph < 2) {
        if (f == 5) {
          if (rideKind == Ride::Rail) { railway.abort(); rideKind = Ride::None; }
          const bool ok = ph == 0 ? railway.board(0, true) : express.board(0, 1);
          if (ok) {
            rideKind = ph == 0 ? Ride::Rail : Ride::Express;
            TrainRide tr = ph == 0 ? railway.ride() : express.ride();
            player.setSkisOn(false);
            player.sitOn(tr.seat, tr.fwd);
            seatView = true; seatYaw = 0; seatPitch = -0.04; trainFov = -1;
            SL_INFO("[traintest] aboard the %s: seat (%.3f, %.3f, %.3f) yaw %.2f in its car", ph == 0 ? "Wolkenspitzbahn" : "Legacy Express", tr.seatLocal.x, tr.seatLocal.y, tr.seatLocal.z, tr.seatYaw);
          } else SL_WARN("[traintest] no train to board");
        }
        const char* tag = ph == 0 ? "rail_" : "express_";
        for (int i = 0; i < 7; i++) {
          const int at0 = 60 + i * 40;
          if (f > at0 - 38 && f <= at0) { seatYaw = VIEWS[i].yaw; seatPitch = VIEWS[i].pitch; }
          if (f == at0 && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, (std::string(tag) + VIEWS[i].name).c_str());
        }
        // (then six cameras standing in the car: along the aisle both ways, a bay, from the rear vestibule, the ceiling, the floor)
        static const char* WN[6] = {"w_fwd", "w_back", "w_bay", "w_rear", "w_ceil", "w_floor"};
        trainWalk = f > 322 && f <= 322 + 6 * 30 ? (f - 323) / 30 : -1;
        if (trainWalk >= 0 && (f - 323) % 30 == 28 && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, (std::string(tag) + WN[trainWalk]).c_str());
        if (f > 320) { seatYaw = 1.2; seatPitch = -0.1; }
        if (ph == 1) {   // (the Express: stood up, then walking down the aisle: from behind, through your eyes, from in front)
          if (f == 506) express.standUp(false);
          if (f > 506 && f <= 540) express.debugWalk(0, 3.0, PI, 0, -0.18);
          if (f == 541) walkToggle = true;
          if (f > 541 && f <= 575) express.debugWalk(0, 1.0, PI, 0, -0.18);
          if (f == 576) walkToggle = true;
          if (f > 576 && f <= 610) express.debugWalk(0, -3.0, PI, PI, -0.3);
          if (f > 610 && f <= 700 && express.walking()) input.injectMove(0, 1);   // (W for 1.5 s: down the aisle)
          if (f == 701) input.injectMove(0, 0);
          for (const auto& [at0, nm] : {std::pair<int, const char*>{538, "walk_third"}, {573, "walk_first"}, {608, "walk_front"}, {700, "walk_keys"}})
            if (f == at0 && !opt.png.empty() && pendingPng.empty()) { pendingPng = pngVariant(opt.png, (std::string(tag) + nm).c_str()); dvec3 wf; double a = 0, b = 0; bool sh = false; express.walker(wf, a, b, sh); SL_INFO("[traintest] %s: walking %d, speed %.2f, prompt '%s'", nm, int(express.walking()), b, prompt.c_str()); }
          if (f == 706) { const bool sat = express.sitDown(); SL_INFO("[traintest] sat down again: %s", sat ? "yes" : "no free seat within reach"); if (!sat) { express.debugWalk(0, 6.3, 0, PI, -0.18); express.sitDown(); } }
        }
        if (f == 1385 && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, (std::string(tag) + "moving").c_str());
        if (f == 1150) { seatView = false; trainView = ph == 1 ? 2 : 1; }   // (outside under way: the chase camera; the Express: the camera beside the line)
        if ((f == 1200 || f == 1290) && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, (std::string(tag) + (ph == 1 ? "trackside" : "chase") + (f == 1200 ? "1" : "2")).c_str());
        if (f == 1300) { seatView = true; trainView = 0; }
        // (then on with the fast-forward key until the first tunnel: the cabin by its own light)
        static bool tunnelShot[2] = {false, false};
        if (f > 1385 && !tunnelShot[ph]) {
          seatYaw = 0.6; seatPitch = -0.1;
          const TrainRide tr = ph == 0 ? railway.ride() : express.ride();
          static int under = 0;
          input.inject(Action::Jump, under < 12);   // (fast until it is well inside, then at its own speed)
          under = tr.on && world.height(tr.seat.x, tr.seat.z) > tr.seat.y + 8 ? under + 1 : 0;
          if (under == 20) { seatView = false; trainView = 1; }   // (then outside: the chase camera in the tube)
          if (under == 219) { const dvec3 l = dvec3(glm::inverse(tr.car) * glm::dvec4(cam.pos, 1)); SL_INFO("[traintest] the chase camera in the tunnel: (%.1f, %.1f, %.1f) in your car's frame, %.1f m over the ground there", l.x, l.y, l.z, cam.pos.y - world.height(cam.pos.x, cam.pos.z)); }
          if (under == 220 && !opt.png.empty() && pendingPng.empty()) { pendingPng = pngVariant(opt.png, (std::string(tag) + "tunnel_chase").c_str()); }
          if (under == 223) { seatView = true; trainView = 0; tunnelShot[ph] = true; under = 0; input.inject(Action::Jump, false); }   // (the picture is taken from the frame after it is asked for: only then back to the seat)
          if (under == 19 && !opt.png.empty() && pendingPng.empty()) { pendingPng = pngVariant(opt.png, (std::string(tag) + "tunnel").c_str()); SL_INFO("[traintest] in a tunnel: the cabin light %.2f", double(vmodels.cabinLight())); }
        }
      }
    }
    if (off("bustest")) {   // (debug: you stand in a bus's lane: it stops, waits, pulls out round you)
      dvec3 bp; double bh;
      if (buses.debugStand(bp, bh)) { player.setSkisOn(false); player.teleport(bp.x, bp.z, bh); player.vel = dvec3(0); }
      if (!opt.png.empty() && pendingPng.empty() && frame % 45 == 0 && buses.debugCam(bp, bp)) pendingPng = pngVariant(opt.png, ("bus" + std::to_string(frame / 45)).c_str());
    }
    buses.update(vdt, player.pos, &drive, &traffic, rideKind == Ride::Bus && fastHeld);
    railway.update(vdt, rideKind == Ride::Rail && fastHeld, player.pos);
    express.update(vdt, rideKind == Ride::Express && fastHeld, player.pos);
    perf.add("vehicles (traffic, buses, trains)", perfMs() - pt0);
    if (rideKind == Ride::Car) {
      DriveFrameInput dfi;
      dfi.toggleView = input.takePressed(Action::View);
      dfi.toggleLights = input.takePressed(Action::Lights);
      dfi.unstuck = input.takePressed(Action::Unstuck);
      dfi.flip = input.takePressed(Action::Furnish);
      dfi.lookX = paused ? 0 : input.lookX(); dfi.lookY = paused ? 0 : input.lookY();
      dfi.now = simTime; dfi.fovSetting = fovSetting;
      drive.frame(vdt, dfi);
      dvec3 sp, sf;
      drive.seat(sp, sf);
      player.setSeat(sp, sf);
      rideLine = drive.label() + "   " + std::to_string(int(std::round(drive.speed() * 3.6))) + " km/h";
      if (drive.speed() < 2.0) prompt = "Get out";
      dvec3 ex;
      if (interact && drive.exit(ex)) { interact = false; standOff(ex, "Parked"); }   // (E used: not also back in at once below)
      for (const VehicleEvent& e : drive.events) {
        float a = e.amount;
        switch (e.type) {
          case VehicleEvent::Type::Crash: input.rumble(*plat, 0.9f * a, 0.7f * a, 500); audio.carCrash(a); shakeAmt = std::max(shakeAmt, double(a)); fxHit = a; break;
          case VehicleEvent::Type::Knock: input.rumble(*plat, 0.6f * a, 0.5f * a, 300); audio.impact(e.text.rfind("Lamp", 0) == 0 ? "metal" : "building", a); break;
          case VehicleEvent::Type::Break: input.rumble(*plat, 0.6f * a, 0.5f * a, 300); audio.impact("metal", a); break;
          case VehicleEvent::Type::RailHit: input.rumble(*plat, 0.3f * a, 0.3f * a, 120); audio.impact("metal", a * 0.7f); break;
          case VehicleEvent::Type::Land: input.rumble(*plat, 0.3f + 0.5f * a, 0.2f, 140); if (a > 0.1f) audio.impact("snow", a * 0.7f); break;
          default: if (a > 0) { input.rumble(*plat, 0.3f * a, 0.3f * a, 120); audio.impact("snow", a * 0.5f); } break;
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
      if (rideKind == Ride::Express && !tr.arrived && !menus.isOpen()) {
        // (express.js updateWalk: E stands you up from your seat and sits you down on the nearest free one; at a stop on
        // the way, where E is for getting off, it is F; W A S D walk, relative to the camera, Shift faster)
        const bool stop = express.atStop();
        if (stop ? input.takePressed(Action::Furnish) : interact) {
          if (!stop) interact = false;
          if (express.walking()) express.sitDown(); else express.standUp(viewBeforeRide == Player::View::First);
          seatYaw = 0; seatPitch = -0.04;
        }
        if (express.walking()) { express.walkStep(frameDt, paused ? 0 : input.moveY(), paused ? 0 : input.moveX(), input.down(Action::Sprint)); seatView = true; trainView = 0; }
        if (!stop) prompt = !express.walking() ? "Stand up" : express.nearestFreeSeat() >= 0 ? "Sit down" : "";
        else rideLine += "   " + prompts::K(input, Action::Furnish) + (express.walking() ? ": sit down" : ": stand up");
      }
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
      rig.sledShape.steer = si.steer;   // (the rider's fists turn the bars: skier.js poseSled)
      if (sleds.update(vdt, si)) { rideKind = Ride::None; rig.skisInRide = true; }
      else {
        dvec3 sp, sf;
        sleds.seat(sp, sf);
        player.setSeat(sp, sf);
        rideLine = "Snowmobile   " + std::to_string(int(std::round(sleds.speed() * 3.6))) + " km/h";
        if (sleds.speed() < 1.2) prompt = "Get off";
        if (interact && sleds.getOff()) { interact = false; rideKind = Ride::None; rig.skisInRide = true; }
      }
    } else if (rideKind == Ride::Passenger) {
      // (Phase 6, carride.js) in another player's car: seated in it as it is drawn here; E gets out by your door
      dvec3 sp, sf;
      if (!mp.active() || !mp.ride.on) { rideKind = Ride::None; player.standUp(player.pos.x + 2, player.pos.z, player.heading); }
      else {
        // (vehicles.js seatWorld: the seat point of that car as it is drawn here)
        glm::dmat4 cm(1);
        CarTemplate ct;
        double roll = 0;
        three::V3 pts[4];
        int n = mpCarFrame(mp, vmodels, mp.ride.owner, cm, ct, roll) ? carSeatPoints(ct, pts) : 0;
        if (n > 0) {
          sp = dvec3(cm * glm::dvec4(pts[std::max(0, std::min(mp.ride.seat, n - 1))], 1));
          sf = glm::normalize(dvec3(cm[2][0], 0, cm[2][2]));
          player.setSeat(sp, sf);
        } else if (mp.rideSeat(sp, sf)) player.setSeat(sp, sf);
        rideLine = "Riding with " + mp.ride.owner;
        prompt = "Get out";
        if (interact) {
          interact = false;
          double h = player.heading;
          std::string owner = mp.ride.owner;
          mp.releaseSeat();
          rideKind = Ride::None;
          player.standUp(player.pos.x + std::cos(h) * 1.8, player.pos.z - std::sin(h) * 1.8, h);
          toast = "Out of " + owner + "'s car"; toastUntil = simTime + 2;
        }
      }
    } else if (heli.riding() || ward.seated()) {   // (in the helicopter: yours, the rescue's; the ambulance; a chair by a hospital bed)
      dvec3 sp, sf;
      if (heli.seat(sp, sf) || ward.seat(sp, sf)) player.setSeat(sp, sf);
      rig.skisInRide = false;
      if (heli.active()) { std::string hp; heli.interact(hp, interact); interact = false; }
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
          if (drive.active()) {
            rideKind = Ride::Car;
            if (mp.active()) for (const auto& e : drive.parked)
              if (e.driving && e.owned && !e.plate.empty() && e.plate != save.rentalPlate) {
                std::string plate = e.plate;
                mp.carSwitch(plate, [&, plate](bool ok, const nlohmann::json&) { if (ok) save.rentalPlate = plate; });
              }
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
          // E: the route picker (main.js openBusMap): every stop the bus drives to, on the map
          int k = ((busDestSel % int(dests.size())) + int(dests.size())) % int(dests.size());
          prompt = "Take the ski bus";
          if (interact && !(travelPick.kind == 1 && travelPick.from == stop)) {
            interact = false;
            TrailMap::Travel T = tmap.busTravel(stop, dests);
            for (auto& d : T.dests) { int to = d.id; d.act = [&travelPick, stop, to] { travelPick = {1, stop, to, true}; }; if (to == dests[size_t(k)]) T.focus = int(&d - T.dests.data()); }
            tmap.openTravel(std::move(T));
            plat->setRelativeMouse(false);
          }
          bool picked = travelPick.kind == 1 && travelPick.from == stop;
          if (picked) { for (size_t i = 0; i < dests.size(); i++) if (dests[i] == travelPick.to) { k = int(i); busDestSel = k; } travelPick = {}; }
          if (picked && buses.board(stop, dests[size_t(k)])) {
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
        // E: the route picker (main.js openRailMap): every other station, uphill the fare or the day pass, downhill free
        prompt = "Ride the " + transport.rail.name;
        if (interact && !(travelPick.kind == 2 && travelPick.from == rst)) {
          interact = false;
          TrailMap::Travel T = tmap.railTravel(rst, save.hasPass(), save.money);
          for (auto& d : T.dests) { bool up = d.id == 1; d.act = [&travelPick, rst, up] { travelPick = {2, rst, 0, up}; }; }
          tmap.openTravel(std::move(T));
          plat->setRelativeMouse(false);
        }
        bool railPicked = travelPick.kind == 2 && travelPick.from == rst;
        bool down = railPicked && !travelPick.up;
        if (railPicked) { travelPick = {}; interact = true; }
        if (interact && !railway.trainReady(rst, !down)) { interact = false; flash("No train at the platform \xC2\xB7 wait for the next one (multiplayer: on the shared timetable)", Hud::Flash::Bad); }
        bool railPaid = interact && (down || save.hasPass() || spend(transport.rail.price));
        if (railPaid && !railway.board(rst, !down) && !down && !save.hasPass()) save.money += transport.rail.price;   // (no train: refunded)
        else if (railPaid) {
          interact = false;
          rideKind = Ride::Rail;
          TrainRide tr = railway.ride();
          player.sitOn(tr.seat, tr.fwd);
          viewBeforeRide = player.view; restoreView = true; player.view = Player::View::Third;
          rideCamReady = false; seatView = true; seatYaw = 0; seatPitch = -0.04; trainFov = -1;   // (railway.js board: the seat view; R: outside)
          toast = transport.rail.name + (down ? std::string() : save.hasPass() ? std::string(" \xC2\xB7 Day pass") : " \xC2\xB7 -$" + std::to_string(transport.rail.price)); toastUntil = simTime + 2;
        }
      } else if (xst >= 0 && express.stationCount() > 1) {
        // E: the route picker (main.js openExpress): every other station with its race, the fare or the day pass
        int n = int(express.stationCount()) - 1;
        int k = ((expressDestSel % n) + n) % n;
        int dest = k >= xst ? k + 1 : k;
        prompt = "Ride the " + transport.express.name;
        if (interact && !(travelPick.kind == 3 && travelPick.from == xst)) {
          interact = false;
          TrailMap::Travel T = tmap.expressTravel(xst, save.hasPass(), save.money);
          for (auto& d : T.dests) {
            int to = d.id;
            d.act = [&travelPick, xst, to] { travelPick = {3, xst, to, true}; };
            if (to == dest) T.focus = int(&d - T.dests.data());
          }
          tmap.openTravel(std::move(T));
          plat->setRelativeMouse(false);
        }
        bool xPicked = travelPick.kind == 3 && travelPick.from == xst && travelPick.to >= 0;
        if (xPicked) { dest = travelPick.to; expressDestSel = dest > xst ? dest - 1 : dest; travelPick = {}; interact = true; }
        if (interact && !express.trainReady(xst, dest)) { interact = false; flash("No train at the platform \xC2\xB7 wait for the next one (multiplayer: on the shared timetable)", Hud::Flash::Bad); }
        bool xPaid = interact && (save.hasPass() || spend(transport.express.price));
        if (xPaid && !express.board(xst, dest)) { if (!save.hasPass()) save.money += transport.express.price; }
        else if (xPaid) {
          interact = false;
          rideKind = Ride::Express;
          TrainRide tr = express.ride();
          player.sitOn(tr.seat, tr.fwd);
          viewBeforeRide = player.view; restoreView = true; player.view = Player::View::Third;
          rideCamReady = false; seatView = true; trainView = 0; seatYaw = 0; seatPitch = -0.04; trainFov = -1;   // (express.js board: the seat view; R: outside, then trackside)
          toast = transport.express.name + " to " + express.station(dest).name + (save.hasPass() ? std::string(" \xC2\xB7 Day pass") : " \xC2\xB7 -$" + std::to_string(transport.express.price)); toastUntil = simTime + 2;
        }
      }
    }
    // (Phase 6) beside another player's car: ask for a ride
    if (mp.active() && started && rideKind == Ride::None && prompt.empty() && player.mode != PlayerMode::Sit && player.mode != PlayerMode::Fall && !rooms.inside()) {
      std::string owner;
      if (mp.carNear(player.pos, 2.2, owner) >= 0) {
        prompt = "Ask " + owner + " for a ride";
        if (interact) { interact = false; askRide(owner); }
      }
    }
    // (Phase 6, transit.js) a seat in the server's registry on the shared bus / train / cabin you ride (the others see
    // you seated in it; a full vehicle says so), SPACE held on a shared timeline (the line speeds up only while everyone
    // aboard holds it)
    if (mp.active()) {
      std::string k, v, line;
      int n = 0;
      double rate = 1;
      if (rideKind == Ride::Bus && buses.rideBus() >= 0) { k = "bus"; v = "bus:" + std::to_string(buses.rideBus() % 7 + 1); n = 36; rate = 8; }
      else if (rideKind == Ride::Rail && railway.rideTrain() >= 0) { k = "train"; v = "rail-" + std::to_string(railway.rideTrain()); n = railway.seatCount(); rate = 6; line = "train|rail"; }
      else if (rideKind == Ride::Express && express.riding()) { k = "express"; v = express.rideVehicle(); n = 192; rate = transport.express.fast; line = express.rideDir() > 0 ? "express|e" : "express|w"; }
      else if (rideKind == Ride::None && player.mode == PlayerMode::Sit && lifts.riding()) { v = lifts.rideVehicle(k, n); rate = 16; }
      std::string want = k.empty() || v.empty() ? std::string() : k + "|" + v;
      if (want != mpSeatWant && rideKind != Ride::Passenger) {
        mpSeatWant = want;
        if (want.empty()) mp.releaseSeat();
        else mp.claimSeat(k, v, n, [&](bool ok, const nlohmann::json& d) {
          if (!ok && d.value("err", std::string()) == "full") flash("Full (" + std::to_string(d.value("taken", 0)) + "/" + std::to_string(d.value("n", 0)) + ") \xC2\xB7 you ride standing", Hud::Flash::Bad);
        });
      }
      if (!want.empty() && !line.empty()) mp.holdSkip(k, v, fastHeld, rate, line);
    } else mpSeatWant.clear();
    // (Phase 5) the police station / the prison, the medical centre, the chalets, the races (start houses, bus race boards,
    // the RACING stand), the job boards and a job's own spots
    // the walk-in ski shop (interior.js update): what the view's centre is on: a pair of skis on the wall (rent / buy /
    // equip), the clerk, the outfits corner, the door
    if (started && rooms.room() == Interiors::Room::Shop && !menus.isOpen() && !shopRoom.viewing()) {
      if (const RoomDef::Hit* h = rooms.aim(cam.pos, cam.forward())) {
        if (h->kind == "door") { prompt = "Leave the shop"; if (interact) { interact = false; shopRoom.leave(); } }
        else if (h->kind == "clerk") {   // (main.js shopAction: the conversation look, the clerk's line)
          prompt = "Talk to the shop clerk";
          if (interact) { interact = false; shopRoom.talk("Shop clerk", "Ski Rental & Shop", player.hasSkis ? "Back for an upgrade? Faster skis glide a little quicker and hold an edge better."
                                                                                              : "Gr\xC3\xBC" "ezi! You have everything except skis. The rental pair is on the left; the race skis are further along the wall."); }
        }
        else if (h->kind == "outfits") { prompt = "Outfits \xC2\xB7 jackets, helmets, goggles"; if (interact) { interact = false; outfitShop.open(); } }
        else if (const SkiDef* sk = skiById(h->id)) {
          const bool owned = save.ownsSki(sk->id), eq = save.skis == sk->id, afford = save.money >= sk->price;
          prompt = eq ? std::string(sk->name) + " \xC2\xB7 equipped" : owned ? std::string("Equip ") + sk->name
                 : std::string(sk->rent ? "Rent " : "Buy ") + sk->name + " \xC2\xB7 " + fmtM(sk->price) + (afford ? "" : " (not enough money)");
          if (interact) { interact = false; if (!eq) skiAction(sk->id); }
        }
      }
    }
    // the Autohaus showroom (carrental.js frame / carrentalroom.js update): what the crosshair is on within 7 m: a car on
    // show (the configurator on that very car), the salesman (his talk), the door
    if (started) showroom.update(frameDt, menus.isOpen(), menus.customOpen("carconfig"));
    if (started && rooms.room() == Interiors::Room::Autohaus && !menus.isOpen()) {
      if (const RoomDef::Hit* h = rooms.aim(cam.pos, cam.forward(), 7)) {
        if (h->kind == "door") { prompt = "Leave the Autohaus"; if (interact) { interact = false; audio.play("click"); rooms.leave(); } }
        else if (h->kind == "clerk") { prompt = "Talk to the salesman"; if (interact) { interact = false; audio.play("click"); clerkDialog(); } }
        else if (h->kind == "car") {
          int mine = 0;
          for (const Save::Car& c : save.garage) mine += c.id == h->id;
          prompt = mine ? h->name + " \xC2\xB7 yours: " + std::to_string(mine) + " \xC2\xB7 buy another \xC2\xB7 take it out \xC2\xB7 sell" : "Buy " + h->name;
          if (interact) { interact = false; audio.play("click"); openCarSale(h->id); }
        }
      }
    }
    if (started && rideKind == Ride::None && prompt.empty() && player.mode != PlayerMode::Sit && player.mode != PlayerMode::Fall && !races.active() && !police.arrestedNow()) {
      std::string p5;
      bool used = police.interact(p5, interact) || heli.interact(p5, interact) || ward.interact(p5, interact) || chalets.interact(p5, interact) || races.interact(p5, interact) || oddJobs.interact(p5, interact) ||
                  sleds.interact(p5, interact);
      if (sleds.active()) { rideKind = Ride::Sled; rig.skisInRide = false; }
      if (!p5.empty()) prompt = p5;
      if (used) interact = false;
    }
    if (started && (ward.inBed() || ward.seated())) { std::string wp; if (ward.interact(wp, interact)) interact = false; prompt = wp; }   // (in your hospital bed, on a chair by one)
    if (started && !menus.isOpen() && !tmap.isOpen()) chalets.update(frameDt, cam, nav);
    // (build mode's CURSOR: the mouse free over the catalogue and the room; taken back with TAB / on leaving it)
    if (!opt.autotest && started && !menus.isOpen() && !tmap.isOpen()) {
      static bool buildFree = false;
      const bool wantFree = chalets.wantsFreeMouse();
      if (wantFree != buildFree) { buildFree = wantFree; plat->setRelativeMouse(!wantFree); }
    }
    // (Phase 4) the shops and counters on foot: the ski shop, the ticket seller, the Autohaus counter (your cars), the
    // huts; in your car at the Werkstatt: the repair
    if (werk.available()) {
      // (werkstatt.js interaction: your car in the yellow box, stopped: E repairs it (not getting out); on foot: at the workbench)
      std::string wp;
      if (started && (rideKind == Ride::Car || rideKind == Ride::None) && !menus.isOpen() && werk.interact(wp, interact)) { prompt = wp; interact = false; }
    } else if (rideKind == Ride::Car && werkstattLot && drive.speed() < 2.0 && prompt.rfind("Get out", 0) == 0) {
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
      dvec2 autoOut(0, 1);
      // (main.js enterShop: E in front of the door (village.js: 3.2 m round the point in front of it), in behind a fade;
      // without the exported room: the card)
      bool atShop = false;
      if (shopRoom.available()) { if (shopRoom.interact(prompt, interact)) interact = false; atShop = !prompt.empty(); }
      else if (near(-40, -18, 12)) { atShop = true; prompt = "Ski shop \xC2\xB7 skis and outfits"; if (interact) { interact = false; openSkiShop(); } }
      if (atShop) {}
      // (village.js / main.js: within 2.6 m of the booth's counter: 'Talk to the ticket seller')
      else if (playData.hasTickets ? near(playData.tickets[0], playData.tickets[1], playData.tickets[2]) : near(15, -50, 7.5)) { prompt = playData.hasTickets ? "Talk to the ticket seller" : "Ticket seller \xC2\xB7 day pass, gondola tickets"; if (interact) { interact = false; openTickets(); } }
      else if (dvec3 dp; transport.loaded() && (showroom.doorSpot(dp, autoOut) ? near(dp.x, dp.z, 2.6) : near(transport.autohaus.x, transport.autohaus.z, 12))) {
        // (carrental.js interaction / enter / leave: within 2.6 m of the sliding doors, through a fade into the showroom;
        // out again 0.8 m in front of them, facing the road. Without the exported room: the card)
        prompt = playData.autohaus.ok ? "Autohaus" : "Autohaus \xC2\xB7 my cars";
        if (interact) {
          interact = false;
          if (!playData.autohaus.ok) openGarage();
          else {
            const dvec3 back = dp + dvec3(autoOut.x, 0, autoOut.y) * 0.8;
            const double backYaw = std::atan2(autoOut.x, autoOut.y);
            audio.play("click");
            pc.fade();
            showroom.requestEnter([&, back, backYaw]() { rooms.enter(Interiors::Room::Autohaus, [&, back, backYaw]() { pc.fade(); player.teleport(back.x, back.z, backYaw); }); });
          }
        }
      }
      else if (!playData.hutDoors.empty()) {
        // (village.js / main.js: within 3.5 m of the spot in front of a hut's door; the card names the nearest hut)
        for (const auto& hd : playData.hutDoors) if (near(hd[0], hd[1], hd[2])) {
          prompt = "Mountain hut \xC2\xB7 hot chocolate $" + std::to_string(Prices::hotChocolate);
          if (interact) { interact = false; std::string nm = "Gipfel H\xC3\xBCtte"; double bd = 1e30; for (const Hut& h : huts) { const double dd = std::hypot(h.x - hd[0], h.z - hd[1]); if (dd < bd) { bd = dd; nm = h.name; } } openHut(nm); }
          break;
        }
      }
      else for (const Hut& h : huts) if (near(h.x, h.z, 13)) { prompt = h.name + " \xC2\xB7 hot chocolate $" + std::to_string(Prices::hotChocolate); if (interact) { interact = false; openHut(h.name); } break; }
    }
    if (rideKind == Ride::None && prompt.empty() && player.mode != PlayerMode::Sit && player.mode != PlayerMode::Fall && !lifts.lines().empty()) {
      Lifts::Station st = lifts.nearestStation(player.pos);
      if (st.line && st.dist < (st.line->gondola ? 20 : 13)) {
        prompt = stationLabel(st);
        if (st.mid) prompt += "  (" + std::string(input.down(Action::Back) ? "down" : "up") + ")";
        // a mid-station serves both ways: up by default, down while holding back (S)
        // a gondola's mid-station: the route picker (main.js openLiftMap): up (the price / the day pass) or down (free)
        if (st.mid && travelPick.kind == 4) { bool up = travelPick.up; travelPick = {}; boardLift(st, up); }
        else if (st.mid && interact) {
          int li = int(st.line - lifts.lines().data());
          TrailMap::Travel T = tmap.liftTravel(li, save.hasPass(), save.money);
          if (T.dests.empty()) boardLift(st, !input.down(Action::Back));
          else {
            for (auto& d : T.dests) { bool up = d.id == 1; d.act = [&travelPick, up] { travelPick = {4, 0, 0, up}; }; }
            tmap.openTravel(std::move(T));
            plat->setRelativeMouse(false);
          }
        }
        else if (interact) boardLift(st, st.up);
      }
    }
    if (!opt.autotest && !paused) {
      double h0 = hour;
      hour = std::fmod(hour + frameDt * 24.0 / (16 * 60), 24.0);   // sky.js DAY_SECONDS
      if (hour < h0) { save.day++; save.markDirty(); }               // (main.js: midnight, a new day: the day pass runs out)
      save.hour = hour;
    }
    if (mp.active()) {   // (Phase 6) the world's clock and weather (the server moves them on; everyone in the world shares them)
      if (auto h = mp.hourNow()) { hour = *h; save.hour = hour; }
      int w = Weather::byId(mp.weather());
      if (w >= 0 && !races.active()) weather.serverSet(w, Weather::byId(mp.upcomingWeather()), mp.upcomingIn());
    }
    if (nightShot >= 0) hour = 21.5;   // (the autotest's night shots)
    {   // (floodlights.js: a floodlit night course: night falls for the race, the hour is given back afterwards)
      static double hourBeforeRace = -1;
      if (races.nightCourse()) { if (hourBeforeRace < 0) hourBeforeRace = hour; hour = 21.5; }
      else if (hourBeforeRace >= 0) { hour = hourBeforeRace; hourBeforeRace = -1; }
    }
    light = timeOfDay(hour, dayLight);
    { double t = (hour - 12) / 12 * PI; weather.apply(light, std::sin((28 * std::cos(t) + 4) * DEG)); }
    pc.night = light.night;   // (the night outdoors: the helicopter's lamps, the ward's windows)
    pc.hour = hour;
    pc.snowing = float(weather.snow);
    if (rooms.inside()) light = rooms.lighting(light);

    // streaming + animation
    player.cameraFor(cam);
    bool camUnderground = false;   // (a train's camera in a tunnel: the tunnel's darkness, no terrain drawn over it)
    if (rideKind == Ride::Car) drive.cameraFor(cam);
    else if (rideKind == Ride::Express && express.walking()) {
      // (express.js walkCamera) walking about in the car: your eyes, or the orbit round you pulled in to stay inside it
      express.walkCamera(cam, frameDt, paused ? 0 : input.lookX(), paused ? 0 : input.lookY(), input.wheel(), walkToggle);
      walkToggle = false;
      camUnderground = world.height(cam.pos.x, cam.pos.z) > cam.pos.y + 6;
    }
    else if ((rideKind == Ride::Rail || rideKind == Ride::Express) && seatView) {
      // the trains' seat view (railway.js / express.js updateRide): a seated passenger's eye in the car's own frame (it
      // leans with the car on the grade and in the curves), 0.76 m over the seat; you look round to the side windows
      // (+-100 degrees, not back through your own backrest); turning to the side the head leans a little forward and
      // away from the pane; 72 degrees
      const TrainRide tr = rideKind == Ride::Rail ? railway.ride() : express.ride();
      float lx = paused ? 0 : input.lookX(), ly = paused ? 0 : input.lookY();
      seatYaw = clamp(seatYaw - lx * 0.0022, -1.75, 1.75); seatPitch = clamp(seatPitch - ly * 0.0022, -0.9, 1.0);
      const double turn = std::fabs(std::sin(seatYaw)), fz = std::cos(tr.seatYaw), sx = tr.seatLocal.x > 0 ? 1 : tr.seatLocal.x < 0 ? -1 : 0;
      const dvec3 eye = dvec3(tr.car * glm::dvec4(tr.seatLocal + dvec3(-sx * turn * 0.1, 0.76, (0.06 + turn * 0.12) * fz), 1));
      const double yaw = tr.seatYaw + seatYaw;
      const dvec3 dir = glm::normalize(dvec3(tr.car * glm::dvec4(std::sin(yaw) * std::cos(seatPitch), std::sin(seatPitch), std::cos(yaw) * std::cos(seatPitch), 0)));
      camUnderground = world.height(eye.x, eye.z) > eye.y + 6;
      cam.lookAt(eye, eye + dir, vec3(glm::normalize(dvec3(tr.car * glm::dvec4(0, 1, 0, 0)))));
      trainFov = trainFov < 0 ? 72 : trainFov + (72 - trainFov) * (1 - std::exp(-frameDt * 6));
      cam.fovY = float(trainFov); cam.nearZ = 0.05f;
      if (trainWalk >= 0) {   // (debug traintest: a camera standing in the car, in its frame)
        static const double W[6][6] = {{0, 2.65, -5, 0, 2.3, 6}, {0, 2.65, 5, 0, 2.2, -6}, {0.9, 2.4, 0, -1.2, 1.9, 1.5}, {0, 2.65, -7.6, 0, 2.4, 0}, {0, 2.2, 1, 0.6, 3.6, 4}, {0, 2.7, -1, 0.5, 1.0, 2}};
        const double* w = W[trainWalk % 6];
        cam.lookAt(dvec3(tr.car * glm::dvec4(w[0], w[1], w[2], 1)), dvec3(tr.car * glm::dvec4(w[3], w[4], w[5], 1)));
        cam.fovY = 72;
      }
    }
    else if (rideKind == Ride::Bus && seatView) {
      // the seat view: your eyes over the seat, the mouse looks round (+-120 degrees), easing back ahead
      float lx = paused ? 0 : input.lookX(), ly = paused ? 0 : input.lookY();
      if (lx != 0 || ly != 0) { rideLookT = simTime; seatYaw = clamp(seatYaw - lx * 0.0022, -2.09, 2.09); seatPitch = clamp(seatPitch - ly * 0.0022, -1.0, 0.6); }
      if (simTime - rideLookT > 3) { seatYaw *= std::exp(-frameDt * 1.5); seatPitch += (-0.05 - seatPitch) * (1 - std::exp(-frameDt * 1.5)); }
      if (off("seatback")) { seatYaw = 3.05; seatPitch = -0.2; rideLookT = simTime; }   // (debug: the seat view turned to look back down the cabin)
      double fy = player.heading + seatYaw;
      camUnderground = rideKind != Ride::Bus && world.height(player.pos.x, player.pos.z) > player.pos.y + 6;
      dvec3 eye = player.renderPos + dvec3(0, off("seatback") ? 1.25 : 0.78, 0);   // (debug seatback: standing up at the seat)
      cam.lookAt(eye, eye + dvec3(std::sin(fy) * std::cos(seatPitch), std::sin(seatPitch), std::cos(fy) * std::cos(seatPitch)));
      cam.fovY = 68; cam.nearZ = 0.05f;
    } else if (rideKind == Ride::Rail || rideKind == Ride::Express) {
      // (railway.js / express.js applyCamera) outside: the chase camera behind the train; in a tunnel, a cutting or
      // behind a shoulder it follows the track just behind the last car instead of sitting in the rock; the Express's
      // third view: the camera beside the line (in a tunnel: the chase camera)
      const float lx = paused ? 0 : input.lookX(), ly = paused ? 0 : input.lookY(), wh = input.wheel();
      if (rideKind == Ride::Express && trainView == 2 && express.tracksideCamera(cam, frameDt)) camUnderground = false;
      else if (rideKind == Ride::Rail) { railway.chaseCamera(cam, frameDt, lx, ly, wh); camUnderground = railway.chaseUnderground(); }
      else { express.chaseCamera(cam, frameDt, lx, ly, wh); camUnderground = express.chaseUnderground(); }
    } else if (rideKind == Ride::Bus) {
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
    heli.camera(cam);
    ward.camera(cam);
    showroom.camera(cam, frameDt);   // (the Autohaus: 70 degrees on foot; the configurator's camera round your car)
    showroom.captureCamera(cam, opt.autotest || trans.covered());   // (its windows: the village photographed behind the fade, as you go in)
    if (opt.autotest && at == AT::Ski && off("autohaus") && transport.loaded()) {
      // (debug: the Autohaus from fixed viewpoints, outside (the lot's frame: +z to the road) and in the showroom (the
      // room's frame), with the configurator's steps, the salesman's talk and his marker: o_<name>.png, the same
      // viewpoints as the web game's reference shots)
      struct V { const char* name; int where; double x, y, z, a, b, c; int act; };   // where 0: outside (eye, target), 1: inside (x, z, yaw, pitch; y: 1 upstairs), 2: the game's own camera
      static const V VIEWS[] = {
        {"out_front", 0, 0, 3.2, 30, 0, 3.5, -8, 0}, {"out_left", 0, -22, 2.2, 16, -4, 3, -4, 0}, {"out_right", 0, 24, 2.2, 15, 6, 2, 2, 0},
        {"out_door", 0, 0.2, 1.7, 9, 0, 2.2, 0, 0}, {"out_tow", 0, 16, 2.4, 13, 7.6, 1.2, 6.9, 0},
        {"in_enter0", 2, 0, 0, 0, 0, 0, 0, 1}, {"in_enter", 2, 0, 0, 0, 0, 0, 0, 0},
        {"in_doorview", 1, 0, 0, 2, 0, 0.05, 0, 0}, {"in_floor", 1, -1.5, 0, 4.5, PI, -0.45, 0, 0}, {"in_clerk", 1, 12, 0, -3.5, PI, -0.05, 0, 0},
        {"in_golf", 1, -10.8, 0, -1.6, PI, -0.2, 0, 0}, {"in_stairfoot", 1, -15.2, 0, 6.5, PI, 0.25, 0, 0}, {"in_up", 1, -6, 1, -2.2, PI + 0.5, -0.1, 0, 0},
        {"in_up2", 1, 2, 1, -2.2, PI - 0.6, -0.1, 0, 0}, {"in_updown", 1, 0, 1, -1.8, 0, -0.35, 0, 0}, {"in_guide", 1, 2.4, 0, 5.5, PI + 0.9, -0.1, 0, 2},
        {"in_clerkdialog", 1, 12, 0, -3.5, PI, -0.05, 0, 3}, {"cfg_paint", 2, 0, 0, 0, 0, 0, 0, 4}, {"cfg_paint2", 2, 0, 0, 0, 0, 0, 0, 5}, {"cfg_rims", 2, 0, 0, 0, 0, 0, 0, 6},
        {"cfg_rims2", 2, 0, 0, 0, 0, 0, 0, 7}, {"cfg_plate", 2, 0, 0, 0, 0, 0, 0, 8}, {"cfg_sum", 2, 0, 0, 0, 0, 0, 0, 9}, {"cfg_up", 2, 0, 0, 0, 0, 0, 0, 10}};
      static int af = 0;
      const int per = 44, k = af / per, f = af % per;
      af++;
      if (size_t(k) < sizeof VIEWS / sizeof VIEWS[0]) {
        const V& v = VIEWS[k];
        const double fx = transport.autohausDir.x, fz = transport.autohausDir.y;
        auto lot = [&](double lx, double ly, double lz) { return dvec3(transport.autohaus.x + fz * lx + fx * lz, transport.autohaus.y + ly, transport.autohaus.z - fx * lx + fz * lz); };
        if (f == 0) {
          if (v.where == 0) { const dvec3 q = lot(v.x, 0, v.z + 6); player.setSkisOn(false); player.teleport(q.x, q.z, 0); }
          if (v.act == 1) { save.earn(300000); showroom.requestEnter([&]() { rooms.enter(Interiors::Room::Autohaus); }); }
          if (v.act == 2) showroom.guide("car_tesla_m3");
          if (v.act == 3) { showroom.guide(""); clerkDialog(); }
          if (v.act == 4) { if (menus.isOpen()) menus.close(); const char* want = std::getenv("SKI_LEGACY_CAR"); openCarSale(want ? want : "car_vw_golf_gti"); if (std::getenv("SKI_LEGACY_PAINT")) { carCfg.cfg.paint = std::getenv("SKI_LEGACY_PAINT"); showroom.configure(carCfg.cfg, 0); } }
          if (v.act == 5) { carCfg.cfg.paint = "kingfisher"; showroom.configure(carCfg.cfg, carCfg.step); }
          if (v.act == 6) { carCfg.step = 1; showroom.configure(carCfg.cfg, 1); }
          if (v.act == 7) { carCfg.cfg.rims = "gold"; showroom.configure(carCfg.cfg, 1); }
          if (v.act == 8) { carCfg.step = 2; showroom.configure(carCfg.cfg, 2); }
          if (v.act == 9) { carCfg.step = 3; showroom.configure(carCfg.cfg, 3); }
          if (v.act == 10) { if (menus.isOpen()) menus.close(); showroom.endConfigure(); openCarSale("car_porsche_taycan"); }
        }
        if (v.where == 0) {
          cam.lookAt(lot(v.x, v.y, v.z), lot(v.a, v.b, v.c)); cam.fovY = 60;
          if (f == 1) { terrain.update(cam.pos); scenery.finish(cam.pos); resort.update(0, cam.pos); resort.finishStreaming(cam.pos); }
        } else if (v.where == 1 && rooms.def()) {
          const dvec3 st = rooms.toWorld(v.x, 0, v.z), eye = rooms.toWorld(v.x, 1.62 + (v.y > 0 ? rooms.def()->FL : 0), v.z);
          player.teleport(st.x, st.z, v.a); player.pos.y = st.y; player.vel = dvec3(0);
          cam.lookAt(eye, eye + dvec3(std::sin(v.a) * std::cos(v.b), std::sin(v.b), std::cos(v.a) * std::cos(v.b))); cam.fovY = 70;
        }
        if (f == (v.act == 1 ? 6 : per - 2) && !opt.png.empty() && pendingPng.empty()) { pendingPng = pngVariant(opt.png, v.name); SL_INFO("[autohaus] shot %s: prompt '%s', %d cars on show, doors %.2f open", v.name, prompt.c_str(), showroom.carsShown(), showroom.doorOpen()); }
      }
    }
    ward.captureCamera(cam, (opt.autotest && !off("fadetest")) || trans.covered());   // (the ward's windows: the village photographed behind the fade)
    shopRoom.camera(cam);
    rooms.camera(cam);
    windows.captureCamera(cam, (opt.autotest && !off("fadetest")) || trans.covered(), frameDt);   // (a room's windows, the same way)
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
      // main.js: the menu panorama, a slow cinematic flight round the valley and the main mountain (the village,
      // Silberhorn in the west, the Legacy main mountain, Adlerhorn in the east, back to the village): PANO_POS /
      // PANO_LOOK, closed centripetal Catmull-Rom curves read by arc length, one lap in 150 s, from titleT = 0.02
      static const PanoCurve POS({{260, 140, 320}, {-700, 260, 260}, {-1800, 520, -100}, {-1200, 950, -1400}, {300, 1050, -1300}, {1500, 700, -500}, {1200, 320, 600}});
      static const PanoCurve LOOK({{0, 700, -2350}, {-1600, 700, -900}, {-3170, 1100, -330}, {0, 1100, -2350}, {1800, 900, -900}, {3190, 1100, -800}, {0, 500, -1800}});
      double titleT = std::fmod(0.02 + menuT / 150.0, 1.0);
      dvec3 eye = POS.pointAt(titleT), look = LOOK.pointAt(titleT);
      eye.y = std::max(eye.y, world.height(eye.x, eye.z) + 110);
      cam.lookAt(eye, look);
      cam.fovY = 50; cam.nearZ = 0.2f;
    }
    if (started) races.camera(cam);   // (a race's podium / replay owns the camera: presentation/cinecam.js applyCamera)
    if (mpShowCam) { cam.lookAt(mpShowEye, mpShowAt); cam.fovY = 62; }   // (debug: mpshow, the other player's show from a fixed camera)
    if (off("carside") && started) {
      // (debug: a low side view of your car, else of the nearest traffic car with people in it: the boots under the sill)
      glm::dmat4 M(0);
      if (rideKind == Ride::Car && drive.active()) M = drive.carMatrix();
      else {
        double bd = 80;
        for (const auto& c : traffic.list)
          if ((c.mode == Traffic::Car::Mode::Road || c.mode == Traffic::Car::Mode::Knocked) && std::hypot(c.x - player.pos.x, c.z - player.pos.z) < bd) {
            bd = std::hypot(c.x - player.pos.x, c.z - player.pos.z);
            M = glm::translate(glm::dmat4(1), dvec3(c.x, c.y, c.z)) * glm::rotate(glm::dmat4(1), c.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), c.pitch, dvec3(1, 0, 0));
          }
      }
      if (M[3][3] != 0) {
        dvec3 eye = dvec3(M * glm::dvec4(2.3, 0.3, -0.2, 1)), at = dvec3(M * glm::dvec4(0, 0.4, -0.2, 1));
        cam.lookAt(eye, at);
        cam.fovY = 50; cam.nearZ = 0.05f;
      }
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
        if (Save::Car* c = garageEntry(e.plate); c && std::fabs(c->damage - e.damage) > 0.01) { c->damage = e.damage; save.markDirty(); if (mp.active()) mp.carDamage(e.plate, e.damage / 100); }
    if (off("rescuetest") && frame % 150 == 0) { nlohmann::json rm; if (heli.mpRescue(rm)) SL_INFO("[rescuetest] the row for the other players (net/rescue.js): %s", rm.dump().c_str()); }
    if (mp.active() && started) {   // (Phase 6, carride.js frame / keptFrame) your car out and your other cars parked
      Multiplayer::CarReport cr;
      std::vector<Multiplayer::Kept> kept;
      for (const auto& e : drive.parked) {
        if (!e.owned || e.plate.empty()) continue;
        bool out = e.driving || e.plate == save.rentalPlate;
        if (out && !cr.has) { cr.has = true; cr.driving = e.driving; cr.wreck = e.wrecked; cr.plate = e.plate; cr.pos = e.driving ? drive.pos() : dvec3(e.x, e.y, e.z); cr.yaw = e.driving ? drive.yaw() : e.yaw; }
        else if (!e.driving && e.impoundDay <= save.day) kept.push_back({e.plate, dvec3(e.x, e.y, e.z), e.yaw, e.wrecked});
      }
      mp.reportCar(cr);
      { nlohmann::json rm; const bool on = heli.mpRescue(rm); mp.reportRescue(on ? &rm : nullptr, frameDt); }   // (net/rescue.js: your rescue for the others)
      if ((mpKeptT += frameDt) > 0.5) { mpKeptT = 0; mp.reportKept(kept); }
    }
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
      if (mp.active()) mp.towDone();
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
            double bx, bz, byaw;
            if (drive.freeBay(bx, bz, byaw)) { e.x = bx; e.z = bz; e.yaw = byaw; e.y = world.height(bx, bz) + 0.03; }
            if (mp.active()) mp.tow("tow", dvec3(e.x, e.y, e.z), e.yaw, 0, [&](bool, const nlohmann::json&) { mp.towDone(); });   // (the server's fee and its tow yard)
            else save.spend(WRECK_FEE, true);
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
    pt0 = perfMs();
    // (debug) SKI_LEGACY_SHOTS="name:x,y,z,tx,ty,tz[,hour[,weather]];...": several fixed cameras in one run (heights
    // above the ground with SKI_LEGACY_SHOT_GROUND), each held SKI_LEGACY_SHOT_FRAMES frames (default 45) and written
    // to <png>_<name>.png; SKI_LEGACY_DEBUG=shotonly ends the run after the skiing phase, nohud hides the HUD
    if (const char* shots = std::getenv("SKI_LEGACY_SHOTS"); shots && at == AT::Ski && opt.autotest) {
      struct Shot { std::string name, weather; double v[6]; double hour; };
      static std::vector<Shot> list;
      static int per = 0, lastK = -1;
      if (per == 0) {
        per = 45;
        if (const char* e = std::getenv("SKI_LEGACY_SHOT_FRAMES")) per = std::max(2, std::atoi(e));
        std::string all = shots;
        for (size_t p0 = 0; p0 < all.size();) {
          size_t p1 = all.find(';', p0);
          if (p1 == std::string::npos) p1 = all.size();
          std::string one = all.substr(p0, p1 - p0);
          p0 = p1 + 1;
          size_t c = one.find(':');
          if (c == std::string::npos) continue;
          Shot sh{one.substr(0, c), "", {0, 0, 0, 0, 0, 0}, -1};
          char wx[32] = {0};
          int n = std::sscanf(one.c_str() + c + 1, "%lf,%lf,%lf,%lf,%lf,%lf,%lf,%31s", &sh.v[0], &sh.v[1], &sh.v[2], &sh.v[3], &sh.v[4], &sh.v[5], &sh.hour, wx);
          if (n < 6) continue;
          if (n < 7) sh.hour = -1;
          if (n >= 8) sh.weather = wx;
          list.push_back(sh);
        }
      }
      int k = std::max(0, frame - skiFrame0) / per;
      if (k < int(list.size())) {
        const Shot& sh = list[size_t(k)];
        double v[6];
        for (int i = 0; i < 6; i++) v[i] = sh.v[i];
        if (std::getenv("SKI_LEGACY_SHOT_GROUND")) { v[1] += world.height(v[0], v[2]); v[4] += world.height(v[3], v[5]); }
        if (sh.hour >= 0) hour = sh.hour;
        if (!sh.weather.empty()) weather.snap(Weather::byId(sh.weather));
        cam.lookAt(dvec3(v[0], v[1], v[2]), dvec3(v[3], v[4], v[5]));
        cam.fovY = 60;
        // (the frame's streaming below follows this camera; everything round a new one in before its first frame)
        if (k != lastK) { lastK = k; terrain.update(cam.pos); scenery.finish(cam.pos); resort.update(0, cam.pos); resort.finishStreaming(cam.pos); }
        if ((frame - skiFrame0) % per == per - 1 && !opt.png.empty()) pendingPng = pngVariant(opt.png, sh.name.c_str());
      }
    }
    terrain.update(cam.pos);
    scenery.update(cam.pos);
    resort.update(frameDt, cam.pos);
    groundMap.update(world, renderer, cam.pos, opt.autotest && frame < 3);   // (the valley mist's height map)
    perf.add("streaming (terrain, trees, resort cells)", perfMs() - pt0);
    rig.showcase = showcaseOn;
    rig.sled = rideKind == Ride::Sled;
    // (drive.js placeRig) you at the wheel: posed in the seat in the car's frame; your eyes are the cockpit camera's
    rig.car.on = rideKind == Ride::Car && drive.active();
    rig.car.passenger = false;
    if (rig.car.on) { rig.car.g = drive.carMatrix(); rig.car.t = drive.carTemplate(); rig.car.steer = drive.steerAngle(); rig.car.inside = drive.cockpit(); }
    else if (rideKind == Ride::Passenger && mp.active() && mp.ride.on) {   // (carride.js: your legs in the car's footwell)
      double roll = 0;
      rig.car.on = rig.car.passenger = mpCarFrame(mp, vmodels, mp.ride.owner, rig.car.g, rig.car.t, roll) && rig.car.t.S;
      rig.car.seat = mp.ride.seat;
    }
    rig.bed.on = ward.lying(); rig.bed.floor = ward.bedFloor(); rig.bed.hideHead = !ward.third();   // (lying in your hospital bed: hospitalroom.js poseBody)
    if (dvec3 podium; shopRoom.mannequin(podium, shopYaw)) rig.updateStanding(paused ? 0 : frameDt, podium, shopYaw, world);   // (your skier on the OUTFITS podium)
    else rig.update(paused ? 0 : frameDt, player, world);
    if (rig.bed.on) ward.setBody(dvec3(rig.rig.bedEye), dvec3(rig.rig.bedBody));
    drive.setEyeRig(rig.eyeRigOk, dvec3(rig.eyeRig));
    scenery.dynamic.clear();
    if (transport.loaded()) {
      drive.fillColliders(scenery.dynamic);
      traffic.fillColliders(scenery.dynamic);
      buses.fillColliders(scenery.dynamic);
      railway.fillColliders(scenery.dynamic, player.pos);
      express.fillColliders(scenery.dynamic, player.pos);
      police.fillColliders(scenery.dynamic);
      chalets.fillColliders(scenery.dynamic);
      werk.fillColliders(scenery.dynamic);
      sleds.fillColliders(scenery.dynamic);
    }
    rooms.fillColliders(scenery.dynamic);
    if (!rooms.inside()) showroom.fillColliders(scenery.dynamic, player.pos);   // (the tow trucks in the yard)
    heli.fillColliders(scenery.dynamic);

    // ---------------------------------------------------------------- (Phase 7) camera shake, screen effects, skis, outfit
    {
      // the equipped skis' speed / grip into the physics (player.js this.ski)
      if (const SkiDef* sk = skiById(save.skis)) { player.skiSpeed = sk->speed; player.skiGrip = sk->grip; } else player.skiSpeed = player.skiGrip = 1;
      // (main.js: player.hasSkis = !!save.skis: a new save has no skis, so none on your back and none to put on; the
      // player started with hasSkis = true in single player)
      player.hasSkis = !save.skis.empty();
      if (!player.hasSkis && player.skisOn) player.setSkisOn(false);
      // the outfit on the skier (re-applied when it or the character changes)
      if ((frame % 15 == 0 || outfitShop.isOpen()) && rig.loaded()) {
        nlohmann::json eq = save.outfits.equipped.is_object() && save.outfits.equipped.contains(save.character) ? save.outfits.equipped[save.character] : nlohmann::json();
        // (the outfit shop: the selected row tried on, on the podium's skier)
        if (std::array<std::string, 4> pv; outfitShop.preview(pv)) { eq = nlohmann::json::object(); static const char* sl[4] = {"jacket", "trousers", "helmet", "lens"}; for (size_t i = 0; i < 4; i++) if (!pv[i].empty()) eq[sl[i]] = pv[i]; }
        std::string key = std::to_string(rig.generation()) + save.character + (eq.is_object() ? eq.dump() : std::string());
        if (key != outfitKey) {
          outfitKey = key;
          auto col = [&](const char* slot) {
            if (!eq.is_object() || !eq.contains(slot) || !eq[slot].is_string()) return vec4(0);
            const OutfitDef* od = outfitById(eq[slot].get<std::string>());
            if (!od) return vec4(0);
            return vec4(float((od->base >> 16) & 255) / 255.f, float((od->base >> 8) & 255) / 255.f, float(od->base & 255) / 255.f, 1.f);
          };
          auto id = [&](const char* slot) { return eq.is_object() && eq.contains(slot) && eq[slot].is_string() ? eq[slot].get<std::string>() : std::string(); };
          (void)col;
          rig.applyOutfitIds(*dev, id("jacket"), id("trousers"), id("helmet"), id("lens"));
          if (opt.autotest) SL_INFO("[autotest] outfit applied: %s -> %s", eq.dump().c_str(), rig.dressed() ? "recoloured" : "original");
        }
      }
      // camera shake (SETTINGS): at speed on skis a fine buzz, landings / crashes / car knocks a jolt
      double sp = rideKind == Ride::Car ? drive.speed() : player.speed();
      double buzz = (player.mode == PlayerMode::Ski && !player.air && rideKind == Ride::None) || rideKind == Ride::Car || rideKind == Ride::Sled ? smoothstep(14, 32, sp) * 0.25 : 0;
      shakeAmt = std::max(0.0, shakeAmt - frameDt * 1.8);
      double sa = save.settingOn("camShake") && !paused && started ? std::min(1.0, shakeAmt + buzz) : 0;
      if (sa > 0.001) {
        double tt = simTime * 37;
        float yawJ = float(sa * 0.006 * (std::sin(tt * 1.3) + 0.6 * std::sin(tt * 2.9 + 1.7)));
        float pitJ = float(sa * 0.006 * (std::sin(tt * 1.7 + 0.4) + 0.6 * std::sin(tt * 3.3)));
        mat3 rot = mat3(glm::rotate(mat4(1), yawJ, cam.basis[1]) * glm::rotate(mat4(1), pitJ, cam.basis[0]));
        cam.basis = rot * cam.basis;
      }
      // the screen effects (SETTINGS speedFx / vignette): streaks at speed, a vignette, the flash of a hard landing,
      // the red edge of a crash
      fxFlash = std::max(0.0, fxFlash - frameDt * 2.5);
      fxHit = std::max(0.0, fxHit - frameDt * 1.2);
      renderer.fx.vignette = save.settingOn("vignette") ? 0.3f : 0.f;
      renderer.fx.streaks = save.settingOn("speedFx") && started && !paused ? float(smoothstep(18, 36, sp)) * 0.9f : 0.f;
      renderer.fx.flash = save.settingOn("speedFx") ? float(fxFlash) : 0.f;
      renderer.fx.hit = save.settingOn("vignette") ? float(fxHit) : 0.f;
      // dynamic resolution: the 3D resolution follows the frame time (switch preset: toward 30 fps; every other preset:
      // toward 60 fps), under a pixel budget per preset like the web game's (a Retina / 4K drawable is 4-8 MP: drawing
      // the 3D at that size made a MacBook crawl; the HUD and menus stay at full resolution)
      if (!opt.autotest && !mptest && started) {
        double ms = frameDt * 1000;
        bool console = q.dynamicRes;
        const std::string& qn = q.name;
        bool fast = console || qn == "super" || qn == "performance";
        // (Balanced and up stay sharp: native resolution, only a mild dip under real load; the user found the 3D blurry)
        double hi = console ? 36 : 19, lo = console ? 28 : 14.5, floorS = console ? 0.6 : fast ? 0.6 : 1.0;   // (Balanced and up: always the full resolution)
        if (ms > hi && dynScale > floorS) dynScale = std::max(floorS, dynScale - (ms > hi * 1.6 ? 0.05 : 0.02));
        else if (ms < lo && dynScale < 1.0) dynScale = std::min(1.0, dynScale + 0.005);
        double budgetMP = qn == "super" ? 1.6 : qn == "performance" ? 2.4 : qn == "switch" ? 1.0 : 1e9;
        double px = double(std::max(1, renderer.width())) * double(std::max(1, renderer.height()));
        double budgetS = std::min(1.0, std::sqrt(budgetMP * 1e6 / px));
        float want = float(q.renderScale * std::clamp(save.setting("renderScale", 1), 0.5, 1.0) * budgetS * dynScale);
        if (std::fabs(want - renderer.renderScale()) > 0.04f) renderer.setRenderScale(want);
      }
      sfx.update(paused ? 0 : frameDt, hour, light.night, weather.wind, cam.pos);
    }

    // ---------------------------------------------------------------- (Phase 7) audio: the listener, the mixes, the events
    {
      sl::ScopedTimer stAudio(perf, "audio");
      audio.setListener(cam.pos, cam.forward());
      audio.setPaused(paused);
      Audio::State as;
      as.speed = float(player.speed()); as.sideslip = float(player.sideslip); as.edge = float(std::fabs(player.edge));
      as.grounded = !player.air; as.air = player.air; as.tuck = player.tuck;
      as.skiing = player.mode == PlayerMode::Ski && rideKind == Ride::None;
      as.riding = player.mode == PlayerMode::Sit && rideKind == Ride::None && lifts.rideLine() != nullptr;
      as.altitude = float(std::max(0.0, player.pos.y)); as.snow = float(weather.snow); as.weatherWind = float(weather.wind);
      as.ice = float(std::min(1.0, weather.icy)); as.powder = player.mode == PlayerMode::Ski && !player.groomedAt(player.pos.x, player.pos.z) ? 0.8f : 0.1f;
      as.indoor = rooms.inside() || rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express || rideKind == Ride::Car;
      audio.setState(as);
      Audio::Car ac;
      ac.on = rideKind == Ride::Car;
      if (ac.on) {
        static const std::unordered_map<std::string, std::string> kSound = {{"car_bmw_x3", "i6"}, {"car_audi_rs6", "v8"}, {"car_vw_golf_gti", "gti"}, {"car_mercedes_sls", "v8"},
          {"car_lamborghini_huracan", "v10"}, {"car_toyota_gr_yaris", "i3t"}, {"car_mercedes_gls", "v8s"}};
        auto it = kSound.find(drive.carName());
        ac.profile = it != kSound.end() ? it->second : "i4";
        ac.electric = drive.electric(); ac.rpm = float(drive.rpm()); ac.load = float(drive.load()); ac.squeal = float(drive.squeal());
        ac.horn = drive.hornOn(); ac.speed = float(drive.speed()); ac.shift = drive.shifting(); ac.inside = drive.cockpit();
        ac.crank = drive.crank(); ac.firing = drive.firing();
      }
      if (rideKind == Ride::Car && prevRideKind != Ride::Car) audio.carStart(drive.electric());
      prevRideKind = rideKind;
      audio.setCar(ac);
      {
        float sp = float(sleds.speed());
        audio.setSled(rideKind == Ride::Sled, std::min(1.f, 0.15f + sp / 30), input.down(Action::Forward) ? 1.f : 0.f, sp);
      }
      dvec3 sirenP(0), amb(0), heliP(0);
      bool siren = police.sirenNear(cam.pos, sirenP);
      if (heli.sirenAt(amb) && (!siren || glm::length(amb - cam.pos) < glm::length(sirenP - cam.pos))) { siren = true; sirenP = amb; }
      audio.setSiren(siren, sirenP);
      double chopRpm = 1; bool chopIn = false;
      bool chop = heli.rotorAt(heliP, chopRpm, chopIn);
      if (chop && chopIn) heliP = cam.pos;   // (in the cabin)
      if (!chop) chop = police.heliAt(heliP);
      audio.setChopper(chop, heliP);
      // the air horns: a bus pulling out of a stop, a train leaving a station (heard within a few hundred metres)
      for (const dvec3& p : buses.departures) if (glm::length(p - cam.pos) < 400) audio.horn((int(p.x * 7) & 1) ? "bus" : "bus2", &p, 0.8f);
      buses.departures.clear();
      for (const dvec3& p : railway.departures) {
        if (glm::length(p - cam.pos) < 1500) audio.horn("train", &p);
        if (rideKind == Ride::Rail && glm::length(p - player.pos) < 60) { audio.paGong(); audio.announce(railway.rideUp() ? "rail_dep_up" : "rail_dep_down", 1.1f); }
      }
      railway.departures.clear();
      for (const dvec3& p : express.departures) {
        if (glm::length(p - cam.pos) < 1500) audio.horn("train_short", &p, 0.8f);
        if (rideKind == Ride::Express && glm::length(p - player.pos) < 120) audio.paGong();
      }
      express.departures.clear();
      if (rideKind == Ride::Rail) {   // the Wolkenspitzbahn's recorded PA: arriving at a halt / the terminus
        TrainRide tr = railway.ride();
        bool at = tr.atStop || tr.arrived;
        if (at && !railAtStop) {
          std::string k = tr.stop;
          std::transform(k.begin(), k.end(), k.begin(), [](unsigned char ch) { return char(std::tolower(ch)); });
          const char* key = k.find("wolkensee") != std::string::npos ? "rail_arr_wolkensee" : k.find("wolkenplatt") != std::string::npos ? "rail_arr_wolkenplatt" : "rail_arr_village";
          audio.paGong(); audio.announce(key, 1.1f);
        }
        railAtStop = at;
      } else railAtStop = false;
      // the race: the countdown, the gates and checkpoints, the finish (the announcer)
      for (const std::string& snd : races.sounds) {
        if (snd.rfind("count:", 0) == 0) { audio.play("beep"); audio.announce(snd.substr(6)); }
        else if (snd == "go") { audio.play("go"); audio.announce("go"); }
        else if (snd == "checkpoint") { audio.play("gate"); audio.announce("checkpoint"); }
        else if (snd == "gate") audio.play("gate");
        else if (snd == "miss") audio.play("miss");
        else if (snd == "chime") audio.play("chime");   // (podium.js fire: the confetti cannons)
        else if (snd == "whoosh") audio.play("whoosh");   // (intro.js: the cut to the start gate)
        else if (snd.rfind("announce:", 0) == 0) audio.announce(snd.substr(9));   // (session.js: the announcer names the course)
        else if (snd.rfind("finish:", 0) == 0) {
          std::string r = snd.substr(7);
          audio.play("finish");
          audio.announce(r == "record" ? "pb" : r == "1" ? "first" : r == "2" ? "second" : r == "3" ? "third" : "finish", 0.5f);
        } else if (snd.rfind("medal:", 0) == 0) audio.announce(snd.substr(6), 1.6f);
      }
      if (opt.autotest && !races.sounds.empty()) for (const auto& snd : races.sounds) SL_INFO("[autotest] race sound: %s", snd.c_str());
      races.sounds.clear();
      // the soundtrack: the menu, a race (its results), a police chase, freeride
      std::string mctx = !started ? "menu" : races.active() ? (races.resultsUp() || races.finished() ? "results" : "race") : police.wanted() ? "chase" : "freeride";
      audio.music(mctx);
      audio.update(frameDt);
    }

    // render (the autotest's walking / riding phases draw every 4th frame: llvmpipe is slow)
    bool pngVillage = opt.autotest && at == AT::Collide && phaseFrame == 59;
    bool pngRide = opt.autotest && at == AT::Lift && boarded && !ridePng && rideT >= 12;
    bool rendered = !(opt.autotest && at != AT::Ski && at != AT::Menu && at != AT::Map) || phaseFrame % (at == AT::Race ? 8 : 4) == 0 || pngVillage || pngRide || nightShot >= 0 || ward.capturing() || showroom.capturing() || windows.capturing();
    if (nightShot >= 0) {   // (the night shots' cameras: the plaza, then the snow gun nearest it)
      dvec3 eye, at2;
      if (nightShot < 16) { eye = dvec3(30, 0, 22); at2 = dvec3(-8, 0, -18); }
      else if (nightShot >= 34) {   // behind a traffic car on its road: its lights, the pool ahead, its plate
        const Traffic::Car* tc = nullptr;
        for (const auto& c : traffic.list) if (c.mode == Traffic::Car::Mode::Road) { tc = &c; break; }
        if (tc) {
          dvec3 f(std::sin(tc->yaw), 0, std::cos(tc->yaw));
          eye = dvec3(tc->x, 0, tc->z) - f * 9.0; at2 = dvec3(tc->x, 0, tc->z) + f * 12.0;
        } else { eye = dvec3(30, 0, 22); at2 = dvec3(-8, 0, -18); }
      } else {
        dvec3 gp(0), gd(0, 0, 1);
        sfx.gunNear(dvec3(0, 0, -300), gp, gd);
        dvec3 side = glm::normalize(glm::cross(gd, dvec3(0, 1, 0)));
        eye = gp + side * 22.0 - gd * 6.0; at2 = gp + gd * 14.0;
      }
      eye.y = world.height(eye.x, eye.z) + 5; at2.y = world.height(at2.x, at2.z) + 2;
      cam.lookAt(eye, at2);
      cam.fovY = 60;
      terrain.update(cam.pos);
      scenery.update(cam.pos);
      resort.update(0, cam.pos);
      resort.finishStreaming(cam.pos);
      sfx.update(0.05, hour, light.night, weather.wind, cam.pos);
    }
    if (mptest && pendingPng.empty()) rendered = false;   // (llvmpipe: the network test draws only its screenshots, so it runs at a real frame rate)
    if (const char* shot = std::getenv("SKI_LEGACY_SHOT"); shot && at == AT::Ski) {   // (debug: a fixed camera "x,y,z,tx,ty,tz")
      double v[6] = {0};
      if (std::sscanf(shot, "%lf,%lf,%lf,%lf,%lf,%lf", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) == 6) {
        if (std::getenv("SKI_LEGACY_SHOT_GROUND")) { v[1] += world.height(v[0], v[2]); v[4] += world.height(v[3], v[5]); }   // (heights above the ground)
        cam.lookAt(dvec3(v[0], v[1], v[2]), dvec3(v[3], v[4], v[5]));
        cam.fovY = 60;
        terrain.update(cam.pos);
        static bool shotReady = false;   // (the trees and rocks round the fixed camera, all in before its first frame)
        if (!shotReady) { shotReady = true; scenery.finish(cam.pos); }
        scenery.update(cam.pos);
        resort.update(0, cam.pos);
      }
    }
    if (dvec3 bc, bl; off("bustest") && buses.debugCam(bc, bl)) {   // (debug: the camera on the bus test)
      cam.lookAt(bc, bl); cam.fovY = 55;
      terrain.update(cam.pos); scenery.update(cam.pos); resort.update(0, cam.pos);
    }
    if (opt.autotest && at == AT::Ski && off("platetest")) {   // (debug: a parked car's plates close up, front and rear, by day and at night: o_plate<n>.png)
      static int pf = 0;
      pf++;
      const char* want = std::getenv("SKI_LEGACY_CAR");
      int idx = drive.debugCar(want ? want : "car_bmw_x3");
      if (idx >= 0) {
        const Drive::Parked& e = drive.parked[size_t(idx)];
        const int k = (pf / 70) % 4;   // front by day, rear by day, front at night, rear at night
        const double side = k % 2 ? -1 : 1, L2 = e.length / 2;
        const dvec3 f(std::sin(e.yaw), 0, std::cos(e.yaw)), rt(f.z, 0, -f.x);
        const dvec3 eye = dvec3(e.x, e.y + 0.85, e.z) + f * (side * (L2 + 2.4)) + rt * 0.8, look = dvec3(e.x, e.y + 0.55, e.z) + f * (side * L2);
        cam.lookAt(eye, look); cam.fovY = 38;
        if (k >= 2) hour = 21.5;
        terrain.update(cam.pos); scenery.update(cam.pos); resort.update(0, cam.pos);
        if (pf % 70 == 60 && pf < 290 && !opt.png.empty() && pendingPng.empty()) pendingPng = pngVariant(opt.png, ("plate" + std::to_string(k)).c_str());
      }
    }
    if (off("sidecam") && player.mode == PlayerMode::Sit && lifts.rideLine()) {   // (debug: look at the rider from the side)
      LiftLine* rl = lifts.rideLine();
      dvec3 sv(rl->sideV.x, 0, rl->sideV.y);
      cam.lookAt(player.renderPos + sv * 7.0 + dvec3(0, 0.5, 0), player.renderPos);
    }
    // (Phase 4) the 2D layer: HUD, menus / dialogs, the trail map (drawn after the 3D frame)
    ui.begin(renderer.width(), renderer.height());
    if (started && !off("nohud") && !tmap.isOpen() && !tmap.travelOpen() && !(uiTest && uiT.step >= 11) && (!menus.isOpen() || menus.dialogOpen())) {   // (a card dialog: over the HUD, as the web's modal; the route picker: the HUD steps aside)
      HudFrame hf;
      // (main.js hud.frame: a vehicle shows its own speed; on foot the speedometer reads 0, indoors too; it is hidden on
      // chairs and gondolas (seated, no vehicle); its label is the vehicle, else the skis ("(off)" when carried))
      hf.speed = rideKind == Ride::Car ? drive.speed() : rideKind == Ride::Bus ? buses.rideSpeed() : rideKind == Ride::Rail ? railway.ride().speed
               : rideKind == Ride::Express ? express.ride().speed : rideKind == Ride::Sled ? sleds.speed()
               : player.mode == PlayerMode::Walk || rooms.inside() ? 0.0 : player.speed();
      hf.speedo = player.mode != PlayerMode::Sit || rideKind == Ride::Car || rideKind == Ride::Sled || rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express;
      hf.hour = hour;
      hf.fps = float(fps);
      hf.prompt = menus.isOpen() ? std::string() : prompt;
      hf.promptKey = prompts::K(input, Action::Interact);
      hf.rideHint = rideKind == Ride::Car || rideKind == Ride::Sled ? std::string() : rideLine;
      if (rideKind == Ride::Car) hf.skiName = drive.label();
      else if (rideKind == Ride::Sled) hf.skiName = "Snowmobile";
      else if (rideKind == Ride::Rail) hf.skiName = "Wolkenspitzbahn";
      else if (rideKind == Ride::Express) hf.skiName = "Legacy Express";
      else if (rideKind == Ride::Bus) hf.skiName = "Ski bus";
      else if (const SkiDef* sk = player.hasSkis ? skiById(save.skis) : nullptr) hf.skiName = player.skisOn ? sk->name : sk->name + std::string(" (off)");
      // where you are (trailmap.js locationName, condensed): riding, the village, the nearest run, the backcountry
      if (rideKind == Ride::None && player.mode == PlayerMode::Sit && lifts.rideLine()) hf.location = lifts.rideLine()->name;
      else if (std::hypot(player.pos.x, player.pos.z + 20) < 260) hf.location = "Legacy Village";
      else {
        double bd = 45;
        for (const Piste& ps : pistes) for (size_t i = 0; i < ps.pts.size(); i += 2) { double d = glm::length(ps.pts[i] - dvec2(player.pos.x, player.pos.z)); if (d < bd) { bd = d; hf.location = ps.name; } }
        if (hf.location.empty()) hf.location = rideKind == Ride::Car || transport.laneDistance(player.pos.x, player.pos.z) < 6 ? "On the road" : "Backcountry";
      }
      if (save.skis.empty()) hf.objective = "Buy skis at the ski shop in Legacy Village";
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
        if (o5.empty()) o5 = heli.objective();
        if (o5.empty()) o5 = ward.objective();
        { std::string wl; double wx = 0, wz = 0;   // (flying: the compass points at the drop zone)
          if (heli.waypoint(wl, wx, wz)) { hf.waypoint = true; hf.wpLabel = wl; hf.wpDist = std::hypot(wx - player.pos.x, wz - player.pos.z); hf.wpAngle = -wrapPi(std::atan2(wx - player.pos.x, wz - player.pos.z) - std::atan2(double(cam.forward().x), double(cam.forward().z))); } }
        if (heli.active()) hf.speedo = false;   // (its own panel: heli/hud.js)
        if (o5.empty()) o5 = races.objective();
        if (o5.empty()) o5 = oddJobs.objective();
        if (o5.empty()) o5 = chalets.objective();
        if (!o5.empty()) hf.objective = o5;
        if (rooms.room() == Interiors::Room::Prison) hf.location = rooms.prisonExported() ? "Legacy Village Prison" : "Polizei \xC2\xB7 Legacy Village";
        else if (rooms.room() == Interiors::Room::Hospital) hf.location = "Medical centre";
        else if (rooms.room() == Interiors::Room::Chalet) hf.location = chalets.location();
        else if (rooms.room() == Interiors::Room::Autohaus) { hf.location = "Autohaus"; hf.objective = "Look at a car or the salesman and press " + pc.K(Action::Interact); }
        else if (rooms.room() == Interiors::Room::Shop) { hf.location = "Ski Rental & Shop"; hf.objective = player.hasSkis ? "" : "Look at a pair of skis and press " + pc.K(Action::Interact); }
        if (races.active()) { hf.waypoint = false; hf.inRace = true; }
        hf.hideHint = police.wanted() || menus.dialogOpen();   // (under a card dialog the controls card would show through its paper)
        hf.hidePrompt = menus.dialogOpen();
        hf.onlyFlash = menus.customOpen("shop") || menus.customOpen("carconfig") || menus.customOpen("talk");
      }
      hud.draw(ui, hf, save, input, simTime);
      float u5 = std::clamp(std::min(float(renderer.height()) / 800.f, float(renderer.width()) / 1280.f), 0.55f, 2.2f) * float(save.setting("hudScale", 1));
      races.hud(ui, u5);
      popups.draw(ui, races.active(), simTime);
      oddJobs.hud(ui, u5);
      police.hud(ui, u5);
      heli.hud(ui, u5);
      ward.hud(ui, u5);
      shopRoom.hud(ui, !menus.isOpen() && !tmap.isOpen());
      if ((rooms.prisonExported() || (rooms.chaletExported() && !chalets.building())) && !menus.isOpen() && !tmap.isOpen()) Interiors::crosshair(ui);
      chalets.hud(ui, u5);
      werk.hud(ui, u5);
      if (mp.active()) mpv.hud(ui, mp, cam, renderer.width(), renderer.height(), u5, save.setting("nameTags", 1) != 0, mp.interior(), "Y", "N");
    }
    menus.loading.clear();
    if (menus.isOpen() || tmap.isOpen() || tmap.travelOpen()) {   // (menu.js: a tick moving, a click choosing)
      if (nav.up || nav.down || nav.left || nav.right || nav.tabPrev || nav.tabNext) audio.play("tick");
      if (nav.confirm || nav.click || nav.cancel) audio.play("click");
    }
    // (the menus' animations run on the wall clock: simTime stops while paused, so the pause menu's buttons, which
    // fade / slide in over 0.25 s from the moment it opens, stayed invisible)
    menus.frame(nav, realDt, plat->timeSeconds());
    if (tmap.isOpen()) {
      int carIdx = -1;
      for (size_t i = 0; i < drive.parked.size(); i++) if (drive.parked[i].owned && !drive.parked[i].plate.empty() && (carIdx < 0 || drive.parked[i].driving)) carIdx = int(i);
      dvec3 carPos = carIdx >= 0 ? dvec3(drive.parked[size_t(carIdx)].x, 0, drive.parked[size_t(carIdx)].z) : dvec3(0);
      tmap.frame(ui, nav, input, frameDt, rideKind == Ride::Car ? drive.pos() : player.pos, rideKind == Ride::Car ? drive.yaw() : player.heading, carIdx >= 0 ? &carPos : nullptr);
      if (!tmap.isOpen() && started && !opt.autotest) plat->setRelativeMouse(true);
      { std::string lay; for (int i = 0; i < 7; i++) lay += tmap.layer(i) ? '1' : '0'; if (lay != save.settingStr("mapLayers", "1111111")) save.set("mapLayers", lay); }
    }
    if (uiTest && uiT.step >= 11 && uiT.step - 11 < int(uiTestScreens().size())) uiTestDraw(ui, nav, input, uiTestScreens()[size_t(uiT.step - 11)], uiT.f * frameDt, plat->timeSeconds());
    if (tmap.travelOpen()) {   // (the route picker: ui/travel.js)
      // (autotest: the picker is driven like the menus: the highlighted stop is ridden to)
      if (opt.autotest && !atRealKeys && !off("uitest") && !heliRun) tmap.travelChoose();   // (the helicopter's debug runs pick on the chart themselves)
      else tmap.frameTravel(ui, nav, input, frameDt, player.pos, player.heading);
      if (!tmap.travelOpen() && started && !opt.autotest) plat->setRelativeMouse(true);
    }
    // (main.js: getting into / out of your car, a bus, the Wolkenspitzbahn, the Legacy Express and another player's
    // car, walking into / out of a room, PLAY and back to the main menu all dip to dark: transition.fade)
    {
      static Ride prevRide = Ride::None;
      static bool prevInside = false, prevStarted = false;
      auto fades = [](Ride r) { return r == Ride::Car || r == Ride::Bus || r == Ride::Rail || r == Ride::Express || r == Ride::Passenger; };
      bool inside = rooms.inside();
      if (!opt.autotest && !mptest && ((rideKind != prevRide && (fades(rideKind) || fades(prevRide))) || inside != prevInside || started != prevStarted)) trans.fade();
      prevRide = rideKind; prevInside = inside; prevStarted = started;
    }
    // (transition.js: the scenes between two places, over everything; the old place stays on screen until covered)
    trans.draw(ui);
    renderer.holdFrame = trans.holdsFrame();
    trans.update(realDt);
    if (rendered) {
    Lighting frameLight = light;
    {   // (railway.js lateUpdate: the cabins' own light, 0.3 by day, up to 1.2 at night and in a tunnel, eased)
      static float cabinDark = 0;
      cabinDark += ((camUnderground ? 1.f : 0.f) - cabinDark) * float(1 - std::exp(-frameDt * 3));
      vmodels.setCabinLight(0.3f + 0.9f * std::max(light.night, cabinDark));
    }
    if (camUnderground) {   // railway.js lateUpdate: deep in a tunnel the sun and the sky fade out; the lamps and the cabin carry the light
      frameLight.zenith = frameLight.mid = frameLight.horizon = frameLight.glow = frameLight.fog = vec3(0.004f, 0.005f, 0.007f);
      frameLight.sunIntensity *= 0.03f; frameLight.sky *= 0.25f; frameLight.ground *= 0.25f;
      frameLight.ambientScale = 0.25f;
    }
    pt0 = perfMs();
    renderer.beginFrame(cam, frameLight, player.renderPos);
    if ((rideKind == Ride::Rail || rideKind == Ride::Express) && seatView) {
      // (train.js: the cabin lit by its own strips, every surface in its own colour x (1, 0.86, 0.68) x 0.55 x uCabin:
      // here four warm lamps along the ceiling of the car you sit in, faint by day, carrying the light in a tunnel)
      const TrainRide tr = rideKind == Ride::Rail ? railway.ride() : express.ride();
      for (double z : {-6.2, -2.1, 2.1, 6.2}) {
        PointLight l;
        l.pos = dvec3(tr.car * glm::dvec4(0, 3.05, z, 1)); l.color = vec3(1.0f, 0.86f, 0.68f) * (CABIN_LAMP * std::max(0.04f, vmodels.cabinLight() - 0.27f)); l.range = 6.5f;
        renderer.addLight(l);
      }
    }
    if (camUnderground && rideKind == Ride::Rail) railway.tunnelLights(renderer);
    else if (camUnderground && rideKind == Ride::Express) express.tunnelLights(renderer);
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
      sleds.addDraw(vdraw, cam.pos);
      if (mp.active()) mpv.addDraw(mp, vdraw, vmodels, sleds.model(), sleds.fit(), cam.pos, mp.interior());
      {   // (Phase 7) the lights, car lamps and plates, spray, flags, snowcats
        bool dark = light.night > 0.15f;
        std::vector<CarPose> poses;
        drive.carPoses(poses, cam.pos, 160, dark);
        if (aiOn) traffic.carPoses(poses, cam.pos, 160, dark);
        sfx.submit(renderer, vdraw, shapes, cam, poses);
      }
      vdraw.submit(renderer, *dev, cam.pos);
    }
    // (Phase 5) the interiors; outside the job boards, the race pieces, the police, the rescue, the chalets; the people;
    // the falling snow
    if (indoor) { rooms.draw(renderer); ward.draw(renderer); windows.draw(renderer, rooms.toWorld(0, 0, 0), cam.pos); }
    if (indoor && showroom.inside()) showroom.draw(renderer, sfx, *dev, cam);   // (the cars on show, the doors, the marker, the floor's mirror)
    else if (drawVillage) {
      showroom.drawOutside(renderer, *dev, cam.pos);
      oddJobs.draw(renderer, cam.pos, jobBoard.get());
      races.draw(renderer, cam.pos);
      police.draw(renderer, cam.pos);
      heli.draw(renderer, cam);
    }
    if (drawVillage) chalets.draw(renderer, cam.pos);
    if (drawVillage && !indoor) werk.draw(renderer, cam.pos);
    people.begin(paused ? 0 : frameDt);
    if (!indoor) {
      if (aiOn) { folk.submit(renderer, cam.pos); traffic.addPeople(people, cam.pos, people.skierKinds.empty() ? people.fanKinds : people.skierKinds); }
      if (!mp.active()) { railway.addPeople(people); express.addPeople(people); }
      {   // (express.js poseWalker: you walking in the car, on its floor, in third person)
        dvec3 wf; double wh = 0, ws = 0; bool shown = false;
        if (rideKind == Ride::Express && express.walker(wf, wh, ws, shown) && shown) {
          Person q;
          q.kind = people.kind(save.character);
          if (q.kind < 0 && !people.skierKinds.empty()) q.kind = people.skierKinds[0];
          if (q.kind >= 0) { q.pos = wf; q.yaw = wh; q.anim = ws > 0.1 ? PAnim::Walk : PAnim::Idle; q.speed = ws; people.add(q); }
        }
      }   // (the skiers riding along in your car: single player only, as railway.js)
      races.addPeople(people, cam.pos);
      oddJobs.addPeople(people, cam.pos);
    }
    rooms.addPeople(people);
    police.addPeople(people, cam.pos);
    if (mp.active()) { mpv.addPeople(mp, people, cam.pos, mp.interior(), frameDt); mpv.drawWorld(renderer, people); }
    people.submit(renderer, cam.pos, opt.autotest ? std::min(28, q.maxPeople) : q.maxPeople);
    npcs.submit(renderer, cam.pos);
    weather.drawSnow(renderer, snowDraw, *dev, shapes, cam, frameDt, indoor || camUnderground);
    // (first person: your own body stays visible below the eye, the head folded away; at the wheel too: player.js /
    // drive.js placeRig)
    bool hideRig = ((rideKind == Ride::Bus || rideKind == Ride::Rail || rideKind == Ride::Express) && seatView) || heli.hideRig() || showroom.inside();   // (the showroom is its own scene in the web game: you are not in it)
    if (rooms.chaletExported() || rooms.prisonExported()) hideRig = true;   // (the web game's rooms are walked as a camera: no body of your own)
    railway.insideView = rideKind == Ride::Rail && seatView;
    express.insideView = rideKind == Ride::Express && (seatView || express.walking());
    if (express.walking()) hideRig = true;   // (your seat is empty: you walk)
    // first person on skis: the gloves-and-poles view model rides on the camera (player.js, after the camera)
    rig.updateFpView(paused ? 0 : frameDt, cam, player, *dev, assets);
    player.noteCamera(cam);
    if (drawSkier && !ward.capturing() && !showroom.capturing() && !windows.capturing()) rig.submit(renderer, hideRig);
    if (!indoor) {   // the snow trails: you, the vehicles on the snow, the resort's people
      if (rideKind == Ride::None) trails.player(player);
      if (rideKind == Ride::Car) trails.vehicle(0, drive.pos(), drive.yaw(), 0);
      { dvec3 sp; double sy; if (sleds.current(sp, sy)) trails.vehicle(1, sp, sy, 1); }
      for (size_t i = 0; i < folk.count(); i++) {
        const dvec3& fp = folk.pos(int(i));
        double dx = fp.x - cam.pos.x, dz = fp.z - cam.pos.z;
        if (dx * dx + dz * dz < 90.0 * 90.0 && !folk.down(int(i))) trails.npc(int(i), fp, false);
      }
      trails.update(paused ? 0 : frameDt, renderer, player.renderPos, &world);
    }

    perf.add("render: scene submit (culling, batches)", perfMs() - pt0);
    pt0 = perfMs();
    dev->resetFrameStats();
    renderer.endFrame();
    ward.captured(renderer);
    showroom.captured(renderer);
    windows.captured(renderer);
    ui.end();
    perf.add("render: draw calls + post + UI", perfMs() - pt0);
    frameDraws = dev->drawCallsThisFrame(); frameTris = dev->trianglesThisFrame();
    statFrames++; sumDraws += frameDraws; sumTris += double(frameTris); maxDraws = std::max(maxDraws, frameDraws); maxTris = std::max<uint64_t>(maxTris, frameTris);
    }

    frame++;
    perf.endFrame();
    fpsN++;
    fpsT += plat->timeSeconds() - now;
    if (fpsT > 0.5 || (opt.autotest && fpsN >= 20)) { fps = fpsN / std::max(1e-6, fpsT); fpsN = 0; fpsT = 0; }
    if (mptest && !pendingPng.empty() && rendered) { writePng(renderer, pendingPng); SL_INFO("[mptest] wrote %s", pendingPng.c_str()); pendingPng.clear(); }
    if (opt.autotest) {
      if (!pendingPng.empty() && rendered) { writePng(renderer, pendingPng); pendingPng.clear(); }
      phaseFrame++;
      if (at == AT::Ski) {
        if (frame == skiFrame0 + 1) {
          perf.reset(); sumDraws = sumTris = 0; statFrames = 0; maxDraws = 0; maxTris = 0;   // (the skiing measured alone)
          // (Phase 7) the skier in a bought outfit: a Sunset Orange jacket, Navy trousers (outfits.js on the rig)
          save.outfits.owned.push_back("j_sunset"); save.outfits.owned.push_back("t_navy");
          save.outfits.equipped[save.character]["jacket"] = "j_sunset";
          save.outfits.equipped[save.character]["trousers"] = "t_navy";
        }
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
          perfReport("skiing down the run (every frame rendered)");
          if (off("fpview")) player.view = Player::View::Third;
          at = haveResort ? AT::Collide : AT::Done;
          if (off("shotonly")) at = AT::Done;
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
          at = AT::CarFlow; phaseFrame = 0; input.releaseInjected();
        }
      } else if (at == AT::CarFlow) {
        // the cars on the player's path, by real input events (game/cartest.h): buy, get in, drive, get out; the traffic
        if (phaseFrame == 1) { input.releaseInjected(); atRealKeys = true; }
        CarFlowEnv ce;
        ce.player = &player; ce.drive = &drive; ce.traffic = &traffic; ce.transport = &transport; ce.buses = &buses; ce.menus = &menus;
        ce.money = save.money; ce.garage = save.garage.size();
        ce.grant = [&](int64_t m) { save.earn(m); };
        ce.teleport = [&](double x, double z, double h) { player.setSkisOn(false); player.teleport(x, z, h); };
        ce.png = [&](const char* tag) { if (!opt.png.empty()) pendingPng = pngVariant(opt.png, tag); };
        ce.ground = [&](double x, double z) { return world.height(x, z); };
        ce.camPos = cam.pos; ce.camFwd = dvec3(cam.forward());
        ce.hasDoor = showroom.doorSpot(ce.door, ce.doorOut); ce.inShowroom = showroom.inside(); ce.configuring = showroom.configuring();
        ce.roomWorld = [&](double lx, double lz) { return rooms.toWorld(lx, 0, lz); };
        ce.spot = [&](const std::string& kind, const std::string& id, dvec3& stand, dvec3& target) {
          double yw = 0;
          if (!rooms.aimSpot(kind, id, stand, yw)) return false;
          target = stand + dvec3(std::sin(yw) * 2.4, 0.9, std::cos(yw) * 2.4);
          return true;
        };
        ce.lookAt = [&](const dvec3& t) { const dvec3 eye = player.pos + dvec3(0, 1.62, 0), d = t - eye; player.setLook(std::atan2(d.x, d.z), std::atan2(d.y, std::hypot(d.x, d.z))); };
        for (const RoomDef::Car& c : playData.autohaus.cars) if (ce.cheapest.empty() || c.price < ce.cheapestPrice) { ce.cheapest = c.id; ce.cheapestLabel = c.label; ce.cheapestPrice = c.price; }
        ce.prompt = prompt; ce.driving = rideKind == Ride::Car; ce.simTime = simTime; ce.frameDt = frameDt;
        if (phaseFrame >= 1 && (carFlow.frame(ce) || phaseFrame > 3000)) {
          if (phaseFrame > 3000) { carFlow.releaseAll(); carFlow.exitOk = false; SL_WARN("[autotest] cars: timed out"); }
          if (rideKind == Ride::Car) { drive.stopNow(); dvec3 ex; if (drive.exit(ex)) standOff(ex, "Parked"); }
          SL_INFO("[autotest] cars (the player's path): buy %s, get in %s, drive %s, controller %s, get out %s, traffic round the village %s", carFlow.buyOk ? "ok" : "FAILED",
                  carFlow.enterOk ? "ok" : "FAILED", carFlow.driveOk ? "ok" : "FAILED", carFlow.padOk ? "ok" : "FAILED", carFlow.exitOk ? "ok" : "FAILED", carFlow.trafficOk ? "ok" : "FAILED");
          atRealKeys = false;
          if (police.wanted()) { SL_INFO("[autotest] cars: the police were called meanwhile (%s): cleared for the next checks", police.status().c_str()); police.clear("autotest"); }
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
        if (phaseFrame == 6 && rideKind != want) SL_WARN("[autotest] %s: could not board (prompt '%s')", what, prompt.c_str());
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
      else if (at == AT::Map && uiTest) {
        static const char* names[] = {"map", "map_out1", "map_out2", "map_legend", "map_hover", "travel_bus", "travel_bus3", "travel_rail", "travel_express", "travel_lift", "travel_heli"};
        const int nSteps = int(sizeof names / sizeof *names);
        if (uiT.f == 0) {
          if (uiT.step == 0) { player.setSkisOn(false); player.teleport(4, 34, PI); tmap.open(dvec3(4, 0, 34)); }
          if (uiT.step == 1) tmap.setView(4, 34, 0.2);
          if (uiT.step == 2) tmap.setView(4, 34, 0.05);
          if (uiT.step == 3) { tmap.setView(4, 34, 0.75); tmap.showLegend(true); }
          if (uiT.step == 4) tmap.showLegend(false);
          if (uiT.step == 5) { tmap.close(); TrailMap::Travel T = tmap.busTravel(0, buses.destinations(0)); tmap.openTravel(std::move(T)); }
          if (uiT.step == 7) { tmap.openTravel(tmap.railTravel(0, false, save.money)); }
          if (uiT.step == 8) { tmap.openTravel(tmap.expressTravel(0, false, save.money)); }
          if (uiT.step == 9) { int li = 0; for (size_t i = 0; i < lifts.lines().size(); i++) if (lifts.lines()[i].hasMid) { li = int(i); break; } tmap.openTravel(tmap.liftTravel(li, false, save.money)); }
          if (uiT.step == 10) { tmap.openTravel(tmap.heliTravel(save.money + 5000)); }
        }
        if (uiT.f == 0 && uiT.step >= nSteps && uiT.step - nSteps < int(uiTestScreens().size())) {
          // the menus' own screens and a card dialog, opened for their shot
          const std::string& nm = uiTestScreens()[size_t(uiT.step - nSteps)];
          if (menus.isOpen()) menus.close();
          menus.inGame = true;
          if (nm == "menu_pause") menus.open(Menus::Screen::Pause);
          else if (nm == "menu_controls") menus.open(Menus::Screen::Controls);
          else if (nm == "menu_stats") menus.open(Menus::Screen::Stats);
          else if (nm == "menu_settings") menus.open(Menus::Screen::Settings);
          else if (nm == "menu_play") { menus.inGame = false; menus.open(Menus::Screen::PlayMode); }
          else if (nm == "menu_mp") { menus.inGame = false; menus.open(Menus::Screen::Multiplayer); }
          else if (nm == "dialog" || nm == "dialog_long") {
            Dialog dd;
            dd.kicker = "Ticket office \xC2\xB7 Legacy Village"; dd.title = "Lift tickets"; dd.say = "Day pass: every lift, all day. Single rides are sold at the gate too.";
            DialogOption o1; o1.label = "Day pass"; o1.sub = "every lift until the lifts close"; o1.price = 120;
            DialogOption o2; o2.label = "Single ride"; o2.sub = "one ride on any lift"; o2.price = 50;
            DialogOption o3; o3.label = nm == "dialog" ? "Ten rides" : "Sonnenkopf H\xC3\xBCtte season ticket"; o3.sub = "ten single rides, no expiry"; o3.price = nm == "dialog" ? 4000 : 4000000; o3.disabled = true;
            DialogOption o4; o4.label = "Not now"; o4.secondary = true;
            dd.options = {o1, o2, o3, o4};
            if (nm == "dialog_long") { DialogOption o5; o5.label = "Owned pass"; o5.sub = "your pass is good until midnight, enjoy the mountain"; o5.state = "Day pass active"; dd.options.insert(dd.options.begin() + 3, o5); }
            menus.openDialog(dd);
          }
        }
        uiT.f++;
        if (uiT.step >= nSteps && uiT.f < 12) uiT.f = 12;
        if (uiT.step < nSteps && uiT.f > 12 && !tmap.reliefReady() && uiT.f < 900) uiT.f = 12;
        else if (uiT.f >= 30 && rendered) {
          if (!opt.png.empty()) writePng(renderer, pngVariant(opt.png, (std::string("ui_") + (uiT.step < nSteps ? std::string(names[uiT.step]) : uiTestScreens()[size_t(uiT.step - nSteps)])).c_str()));
          uiT.step++; uiT.f = 0;
          if (uiT.step == nSteps) tmap.closeTravel();
          if (uiT.step >= nSteps + int(uiTestScreens().size()) || (uiOnly && uiT.step > nSteps)) running = false;
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
      // (Phase 7) the night shots: the plaza's lamps and flags, a snow gun spraying, then the end
      if (at == AT::Done && nightShot < 0) { nightShot = 0; SL_INFO("[autotest] night: 21:30, the plaza's lamps, flags and a snow gun"); }
      else if (at == AT::Done && nightShot >= 0) {
        nightShot++;
        nightLamps = std::max(nightLamps, sfx.lampsLit()); nightSprays = std::max(nightSprays, sfx.sprays());
        nightCars = std::max(nightCars, sfx.carLights()); nightPlates = std::max(nightPlates, sfx.plates());
        if (nightShot == 14 && !opt.png.empty()) writePng(renderer, pngVariant(opt.png, "night"));
        if (nightShot == 32 && !opt.png.empty()) writePng(renderer, pngVariant(opt.png, "spray"));
        if (nightShot == 50 && !opt.png.empty()) writePng(renderer, pngVariant(opt.png, "carlights"));
        if (nightShot == 51) {
          nightOk = nightLamps > 0 && nightSprays > 0;
          SL_INFO("[autotest] night: %d lamps lit (the plaza), %d snow guns spraying, %d car headlights, %d plates (behind a traffic car) -> %s",
                  nightLamps, nightSprays, nightCars, nightPlates, nightOk ? "ok" : "FAILED");
        }
        if (nightShot > 51) running = false;
      }
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
              raceOk && jobOk && policeOk && chaletOk && weatherOk && sledOk && carFlow.ok();
    SL_INFO("[autotest] %d frames (%.1f s simulated) in %.1f s wall: avg %.1f fps", frame, simTime, wall, frame / wall);
    SL_INFO("[autotest] ski %s, building collision %s, gondola ride %s", skiOk ? "ok" : "FAILED", collideOk ? "ok" : "FAILED", liftOk ? "ok" : "FAILED");
    SL_INFO("[autotest] drive %s, traffic %s, bus %s, Wolkenspitzbahn %s, Legacy Express %s", driveOk ? "ok" : "FAILED", trafficOk ? "ok" : "FAILED",
            busOk ? "ok" : "FAILED", railOk ? "ok" : "FAILED", expressOk ? "ok" : "FAILED");
    SL_INFO("[autotest] menus %s, settings %s, shop %s, save / reload %s, lift / car charges %s, trail map %s", menuOk ? "ok" : "FAILED", settingOk ? "ok" : "FAILED",
            buyOk ? "ok" : "FAILED", saveOk ? "ok" : "FAILED", chargeOk ? "ok" : "FAILED", mapOk ? "ok" : "FAILED");
    SL_INFO("[autotest] race + records %s, job %s, police chase + jail %s, chalet + furniture %s, weather %s, snowmobile %s (people drawn %zu)", raceOk ? "ok" : "FAILED", jobOk ? "ok" : "FAILED",
            policeOk ? "ok" : "FAILED", chaletOk ? "ok" : "FAILED", weatherOk ? "ok" : "FAILED", sledOk ? "ok" : "FAILED", people.drawn());
    // (Phase 7) the audio (with SDL's dummy driver the mixer still runs), the scene extras, the performance
    {
      Audio::Stats a = audio.stats();
      audioOk = !a.device || (a.framesMixed > 0 && a.shots > 20 && a.tracksStarted > 0 && (a.samples > 0 || a.failed > 0));
      SL_INFO("[autotest] audio: device %s, %d sound effects + %d announcer lines decoded in %.2f s (%d missing, %.1f MB PCM), %lld frames mixed, %d one-shots + %d synthesized, peak %d voices, %d music tracks started (last '%s'), peak level %.2f -> %s",
              a.device ? "open" : "none (silent)", a.samples, a.voiceLines, a.loadSeconds, a.failed, a.sampleBytes / 1048576.0, (long long)a.framesMixed, a.shots, a.synth, a.peakVoices,
              a.tracksStarted, a.track.c_str(), double(a.peak), audioOk ? "ok" : "FAILED");
      SL_INFO("[autotest] scene fx: %d lamps lit, %d car lights, %d plates, %d snow guns spraying, %d flags, %d snowcats; car wheels split: %s; outfit %s",
              sfx.lampsLit(), sfx.carLights(), sfx.plates(), sfx.sprays(), sfx.flags(), sfx.snowcats(), vmodels.car("car_bmw_x3") && vmodels.car("car_bmw_x3")->split() ? "yes" : "no",
              rig.dressed() ? "worn" : "original");
      perfReport("the rest of the run (vehicles, rides, gameplay; rendered every 4th / 8th frame)");
      SL_INFO("[perf] quality '%s': peak RSS %.0f MB (budget on Switch: well under 3 GB)", q.name.c_str(), plat->peakMemoryBytes() / 1048576.0);
      ok = ok && audioOk && nightOk;
    }
    if (heliRun) ok = heliOk;   // (the helicopter / rescue / ward debug run: its own verdict)
    SL_INFO("[autotest] %s", ok ? "PASS" : "FAIL");
    audio.stop(*plat);
    return ok ? 0 : 1;
  }
  if (mp.active()) mp.leave();   // (quitting online: the profile pushed, close code 1000)
  audio.stop(*plat);
  if (mptest) return mt.ok && mt.step >= 12 ? 0 : 1;
  return 0;
}

} // namespace sl
