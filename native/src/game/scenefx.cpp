#include "game/scenefx.h"
#include <cstdlib>
#include <cstring>
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/canvas2d.h"
#include "engine/mesh_kit.h"
#include "game/play_data.h"
#include "game/shapes.h"
#include "world/resort.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace sl {

namespace {
constexpr double MAST_H = 9, CLOTH_W = 2.6, CLOTH_H = 1.55;
constexpr int SPRAY_N = 140, MAX_GUNS = 5;
constexpr double SPRAY_RANGE = 330, LIFE = 3.6;
// flags.js DESIGNS: background, lettering, bar
struct Design { const char *bg, *fg, *text, *bar; };
const Design DESIGNS[4] = {{"#1546c8", "#ffffff", "SKI LEGACY", "#e2231a"}, {"#ffffff", "#1546c8", "SKI LEGACY", "#1546c8"},
                           {"#d9221c", "#ffffff", "LEGACY", "#ffffff"}, {"#1d2533", "#ffffff", "WORLD CUP", "#e2231a"}};
uint32_t rng = 0x9E3779B9u;
float frand() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return float(rng & 0xffffff) / float(0x1000000); }
gfx::Texture canvasTexture(gfx::Device& dev, const Canvas2D& g) {
  const auto& px = g.pixels();
  int W = g.width(), H = g.height();
  std::vector<uint8_t> flip(px.size());
  for (int y = 0; y < H; y++) std::memcpy(&flip[size_t(y) * W * 4], &px[size_t(H - 1 - y) * W * 4], size_t(W) * 4);
  gfx::TextureDesc d;
  d.width = W; d.height = H; d.format = gfx::TexFormat::SRGBA8; d.anisotropy = 4; d.wrap = gfx::Wrap::Clamp;
  return dev.createTexture(d, flip.data());
}
// a quad in x [x0, x1], y [y0, y1] facing +z with uv [u0, u1] x [0, 1]
Geo quadGeo(float x0, float x1, float y0, float y1, float u0, float u1) {
  Geo g;
  g.pos = {vec3(x0, y0, 0), vec3(x1, y0, 0), vec3(x1, y1, 0), vec3(x0, y1, 0)};
  g.nor.assign(4, vec3(0, 0, 1));
  g.uv = {vec2(u0, 0), vec2(u1, 0), vec2(u1, 1), vec2(u0, 1)};
  g.col.assign(4, vec3(1));
  g.idx = {0, 1, 2, 0, 2, 3};
  return g;
}
} // namespace

void SceneFx::init(gfx::Device& dev, AssetManager& assets, const Resort& resort, World& world, const FontSet& fonts,
                   const std::vector<std::vector<dvec2>>& pistes, const PlayData* play, float npcScale, float lodScale) {
  dev_ = &dev; world_ = &world; fonts_ = &fonts; lodScale_ = lodScale;
  lamps_ = resort.lamps();
  for (const glm::dmat4& M : resort.cannons()) {
    dvec3 fwd = dvec3(M[2]);
    fwd.y = 0;
    double l = glm::length(fwd);
    fwd = l > 1e-6 ? fwd / l : dvec3(0, 0, 1);
    double sc = std::cbrt(std::fabs(glm::determinant(glm::dmat3(M))));
    guns_.push_back({dvec3(M[3]) + dvec3(0, 1.9 * sc, 0) + fwd * 0.6 * sc, glm::normalize(fwd + dvec3(0, 0.38, 0))});
  }
  {   // the spray's particle: a soft round puff (radial alpha), blended
    const int S = 32;
    std::vector<uint8_t> px(size_t(S) * S * 4);
    for (int y = 0; y < S; y++)
      for (int x = 0; x < S; x++) {
        float dx = (x + 0.5f) / S * 2 - 1, dy = (y + 0.5f) / S * 2 - 1, r = std::sqrt(dx * dx + dy * dy);
        float a = std::clamp(1 - r, 0.f, 1.f);
        uint8_t* q = &px[(size_t(y) * S + x) * 4];
        q[0] = q[1] = q[2] = 255; q[3] = uint8_t(a * a * 255);
      }
    gfx::TextureDesc d;
    d.width = d.height = S; d.wrap = gfx::Wrap::Clamp;
    Material m;
    m.baseTex = dev.createTexture(d, px.data());
    m.baseColor = vec4(0.95f, 0.97f, 1.0f, 0.55f);
    m.emissive = vec3(0.12f); m.roughness = 1; m.metallic = 0; m.doubleSided = true;
    m.alpha = Material::Alpha::Blend;
    puff_ = buildModel(dev, {{quadGeo(-0.5f, 0.5f, -0.5f, 0.5f, 0, 1), m}}, "puff");
  }
  int n = std::max(50, int(SPRAY_N * std::min(1.f, npcScale * 1.4f)));
  for (int i = 0; i < n; i++) seeds_.push_back({frand(), frand(), frand(), frand()});

  // ---- flags: the plaza's row of three (flags.js: west of the tree, the row across the radius), each World Cup finish
  {
    double a = -0.7, r = 25, x = std::sin(a) * r, z = -6 - std::cos(a) * r;
    for (int k = 0; k < 3; k++) { double o = (k - 1) * 3.2; masts_.push_back({dvec3(x + std::cos(a) * o, 0, z + std::sin(a) * o), k}); }
    if (play)
      for (const Course& c : play->courses) {
        if (c.bus) continue;
        double h = c.finish.heading, dx = std::sin(h), dz = std::cos(h), off = c.line.width(c.finish.s) + 5.8;
        for (int side : {1, -1}) masts_.push_back({dvec3(c.finish.x - dx * 14 - dz * side * off, 0, c.finish.z - dz * 14 + dx * side * off), side > 0 ? 3 : 0});
      }
    for (auto& m : masts_) m.pos.y = world.height(m.pos.x, m.pos.z);
    for (int d = 0; d < 4; d++) {
      Canvas2D g(512, 256, &fonts);
      g.fillStyle(DESIGNS[d].bg); g.fillRect(0, 0, 512, 256);
      // (flags.js flagAtlas: a stripe in the bar colour and the lettering's colour along the bottom)
      g.fillStyle(DESIGNS[d].bar); g.fillRect(0, 205, 512, 18);
      g.fillStyle(DESIGNS[d].fg); g.fillRect(0, 223, 512, 33);
      g.font("700 96px Barlow");
      g.textAlign("center"); g.textBaseline("middle");
      g.save(); g.translate(256, 110); g.setTransform(1, 0, -0.18f, 1, 256, 110);   // (the italic lean of the arena banners)
      g.fillText(DESIGNS[d].text, 0, 0);
      g.restore();
      Material m;
      m.baseTex = canvasTexture(dev, g);
      m.roughness = 0.9f; m.metallic = 0; m.doubleSided = false;
      // (two-sided banners: the back is printed the right way round too, so the lettering reads from the lifts and
      // the runs' side of the plaza as well as from the square; a single mirrored cloth read backwards from there)
      for (int k = 0; k < 8; k++) {
        float w = float(CLOTH_W / 8);
        Geo front = quadGeo(0, w, float(-CLOTH_H), 0, k / 8.f, (k + 1) / 8.f);
        Geo back = quadGeo(0, w, float(-CLOTH_H), 0, 1 - k / 8.f, 1 - (k + 1) / 8.f);
        back.nor.assign(4, vec3(0, 0, -1));
        back.idx = {0, 2, 1, 0, 3, 2};
        segs_[d][k] = buildModel(dev, {{front, m}, {back, m}}, "flag");
      }
    }
  }

  // ---- snowcats: one per run picked, out at night
  ModelLoadOptions mo;
  mo.maxTextureSize = 1024;
  mo.lodRatios = {0.15f};
  catModel_ = assets.model("snowcat", mo);
  if (catModel_) {
    vec3 ext = catModel_->bmax - catModel_->bmin;
    catFit_ = catModel_->fitTransform(7.6f, 3);
    if (ext.x > ext.z) catFit_ = glm::rotate(mat4(1), -float(PI) / 2, vec3(0, 1, 0)) * catFit_;   // (long axis along +z)
    int nc = std::max(1, int(std::round(3 * npcScale)));
    std::vector<size_t> idx;
    for (size_t i = 0; i < pistes.size(); i++) if (pistes[i].size() > 40) idx.push_back(i);
    for (int k = 0; k < nc && !idx.empty(); k++) {
      Cat c;
      c.path = pistes[idx[(size_t(k) * idx.size()) / size_t(nc)]];
      for (size_t i = 1; i < c.path.size(); i++) c.len += glm::length(c.path[i] - c.path[i - 1]);
      c.s = c.len * (0.2 + 0.25 * k);
      c.dir = k % 2 ? -1 : 1;
      cats_.push_back(std::move(c));
    }
  }
  SL_INFO("scene fx: %zu lamps, %zu snow guns, %zu flag masts, %zu snowcats", lamps_.size(), guns_.size(), masts_.size(), cats_.size());
}

void SceneFx::update(double dt, double hour, float night, double wind, const dvec3& cam) {
  plateFrame_++;
  t_ += dt; hour_ = hour; night_ = night; wind_ = wind; cam_ = cam;
  // the snow guns running: at dusk and at night, the ones nearest you (snowmaking.js)
  running_.clear();
  if (night > 0.25f) {
    std::vector<std::pair<double, int>> near;
    double R = SPRAY_RANGE * std::max(0.6f, lodScale_);
    for (size_t i = 0; i < guns_.size(); i++) { double d = glm::length(guns_[i].pos - cam); if (d < R) near.push_back({d, int(i)}); }
    std::sort(near.begin(), near.end());
    for (size_t k = 0; k < near.size() && k < size_t(MAX_GUNS); k++) running_.push_back(near[k].second);
  }
  // the groomers: up and down their runs at night, parked at the bottom by day
  bool working = night > 0.2f;
  for (Cat& c : cats_) {
    if (working) {
      c.s += c.dir * 2.8 * dt;
      if (c.s > c.len) { c.s = c.len; c.dir = -1; }
      if (c.s < 0) { c.s = 0; c.dir = 1; }
    }
    double s = working ? c.s : c.len - 6;
    double acc = 0;
    size_t i = 1;
    for (; i < c.path.size(); i++) { double l = glm::length(c.path[i] - c.path[i - 1]); if (acc + l >= s) break; acc += l; }
    i = std::min(i, c.path.size() - 1);
    dvec2 a = c.path[i - 1], b = c.path[i];
    double l = std::max(1e-6, glm::length(b - a)), f = std::clamp((s - acc) / l, 0.0, 1.0);
    dvec2 p = a + (b - a) * f;
    dvec2 dir = (b - a) / l * (working ? c.dir : 1.0);
    double y = world_->height(p.x, p.y);
    double yf = world_->height(p.x + dir.x * 3, p.y + dir.y * 3);
    c.pos = dvec3(p.x, y, p.y);
    c.yaw = std::atan2(dir.x, dir.y);
    c.pitch = -std::atan2(yf - y, 3.0);
  }
}

const Model* SceneFx::plateModel(const std::string& text) {
  plateUsed_[text] = plateFrame_;
  auto it = plates_.find(text);
  if (it != plates_.end()) return it->second.get();
  if (plates_.size() >= 48) {   // (a small cache: the oldest plate texture goes, never one drawn this frame: it is
    // already in this frame's vehicle batches, and freeing it crashed the draw; with more plates in view it grows)
    for (size_t i = 0; i < plateOrder_.size(); i++) {
      const std::string key = plateOrder_[i];
      if (plateUsed_[key] == plateFrame_) continue;
      auto old = plates_.find(key);
      if (old != plates_.end()) {
        for (auto& mesh : old->second->meshes) for (auto& p : mesh.primitives) { dev_->destroy(p.input); dev_->destroy(p.vbo); dev_->destroy(p.ibo); }
        dev_->destroy(old->second->materials[0].baseTex);
        plates_.erase(old);
      }
      plateUsed_.erase(key);
      plateOrder_.erase(plateOrder_.begin() + long(i));
      break;
    }
  }
  // carconfig.js plateTexture: 1024 x 220: the white reflective plate with its thin black rim, the shields (the Swiss
  // cross left, the canton's red / white halves right), the text black and condensed, as wide as it fits
  const float W = 1024, H = 220;
  Canvas2D g(int(W), int(H), fonts_);
  g.fillStyle("#f7f7f4"); g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, 22); g.fill();
  g.lineWidth(7); g.strokeStyle("#111"); g.beginPath(); g.roundRect(14, 14, W - 28, H - 28, 16); g.stroke();
  auto shield = [&](float x, const char* fillA, const char* fillB, bool cross) {
    const float cy = H / 2;
    auto path = [&]() { g.beginPath(); g.moveTo(x - 34, cy - 46); g.lineTo(x + 34, cy - 46); g.lineTo(x + 34, cy + 8); g.quadraticCurveTo(x + 34, cy + 40, x, cy + 52); g.quadraticCurveTo(x - 34, cy + 40, x - 34, cy + 8); g.closePath(); };
    path();
    g.fillStyle(fillA); g.fill();
    if (fillB) { g.save(); g.clip(); g.fillStyle(fillB); g.fillRect(x, cy - 50, 40, 110); g.restore(); path(); }
    g.lineWidth(3); g.strokeStyle("#222"); g.stroke();
    if (cross) { g.fillStyle("#fff"); g.fillRect(x - 7, cy - 26, 14, 48); g.fillRect(x - 22, cy - 9, 44, 14); }
  };
  shield(70, "#d52b1e", nullptr, true);
  shield(W - 70, "#d52b1e", "#f4f4f4", false);
  g.fillStyle("#121212"); g.textAlign("center"); g.textBaseline("middle");
  int size = 170;
  g.font("700 170px \"Barlow Condensed\"");
  const float room = W - 260, tw = g.measureText(text);
  if (tw > room) { size = int(std::floor(float(size) * room / tw)); g.font("700 " + std::to_string(size) + "px \"Barlow Condensed\""); }
  g.fillText(text, W / 2, H / 2 + 8);
  Material m;
  m.baseTex = canvasTexture(*dev_, g);
  m.roughness = 0.5f; m.metallic = 0;
  // (reflective: at night it reads as lit, as in the web game)
  m.emissive = vec3(1); m.emissiveTex = m.baseTex; m.emissiveNight = vec2(0, 0.5f);
  // (PLATE_W x PLATE_H: an EU plate, 520 x 110 mm)
  auto model = buildModel(*dev_, {{quadGeo(-0.26f, 0.26f, -0.055f, 0.055f, 0, 1), m}}, "plate");
  plates_[text] = model;
  plateOrder_.push_back(text);
  return model.get();
}

// The lamps of a car model, once: an emission-only overlay model per exported lamp part (the car's own triangles,
// glowing through the GLB material's base colour map), and carlights.js halos(): a sprite per lamp, a little out
// from its lens (tail, the third brake light as one bar, head, reversing: its own lamps or the inner part of the tails).
const SceneFx::CarLamps& SceneFx::lampsFor(const VehicleModel& vm) {
  auto it = carLamps_.find(&vm);
  if (it != carLamps_.end()) return it->second;
  CarLamps L;
  static const char* KINDS[10] = {"head", "high", "drl", "tail", "third", "brake", "rev", "ind", "lensF", "lensR"};
  auto kindOf = [](const std::string& k) { for (int i = 0; i < 10; i++) if (k == KINDS[i]) return i; return -1; };
  const CarSpec& s = *vm.spec;
  bool hasInd = false;
  for (const CarSpec::LampPart& p : s.lampParts) {
    int kind = kindOf(p.kind);
    if (kind < 0) continue;
    if (kind == 2) L.hasDrl = true;
    if (kind == 7) hasInd = true;   // (the indicators: lit only as hazards, on a crashed / knocked car or a wreck)
    Geo g;
    size_t n = p.pos.size() / 3;
    g.pos.resize(n); g.nor.assign(n, vec3(0, 1, 0)); g.uv.resize(n); g.col.assign(n, vec3(1));
    for (size_t i = 0; i < n; i++) { g.pos[i] = vec3(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]); g.uv[i] = vec2(p.uv[i * 2], p.uv[i * 2 + 1]); }
    g.idx = p.idx;
    Material m;
    m.baseColor = vec4(0, 0, 0, 1); m.metallic = 0; m.roughness = 1;
    m.emissive = vec3(1);
    if (p.map && p.mat >= 0 && size_t(p.mat) < vm.matTex.size()) m.emissiveTex = vm.matTex[size_t(p.mat)];
    m.shading = 5; m.additive = true; m.alpha = Material::Alpha::Blend; m.doubleSided = true;
    // (the JS lights the lamp's own material: see-through lamp glass shows its opacity's share of the emission,
    // which the boost makes up for; added on top here, so the share is applied to the boost)
    L.parts.push_back({kind, p.tier, p.boost * p.alpha, buildModel(*dev_, {{g, m}}, "lamp")});
  }
  auto cl = [](float v, float a, float b) { return std::min(b, std::max(a, v)); };
  auto out = [](const CarSpec::LampAnchor& a) { return a.c.z > 0 ? a.size.z / 2 + 0.05f : -a.size.z / 2 - 0.05f; };
  const std::vector<CarSpec::LampAnchor>* tails = nullptr;
  bool ownRev = false;
  for (const auto& [k, list] : s.lampHalo) { if (k == "tail") tails = &list; if (k == "rev" && !list.empty()) ownRev = true; }
  for (const auto& [k, list] : s.lampHalo) {
    if (list.empty()) continue;
    if (k == "tail") for (const auto& a : list) L.halos.push_back({3, vec3(a.c.x, a.c.y, a.c.z + out(a)), cl(a.size.x * 1.5f, 0.42f, 0.85f), cl(a.size.y * 2.4f, 0.3f, 0.6f), a.c.z >= 0 ? 1.f : -1.f});
    else if (k == "third") {
      vec3 mn(1e9f), mx(-1e9f);
      for (const auto& a : list) { mn = glm::min(mn, a.c - a.size * 0.5f); mx = glm::max(mx, a.c + a.size * 0.5f); }
      L.halos.push_back({4, vec3((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z - 0.05f), cl((mx.x - mn.x) * 1.6f, 0.4f, 0.9f), 0.24f, -1.f});
    } else if (k == "head") {
      float z = -1e9f, y = 0;
      for (const auto& a : list) {
        L.halos.push_back({0, vec3(a.c.x, a.c.y, a.c.z + out(a)), cl(a.size.x * 1.2f, 0.3f, 0.6f), cl(a.size.y * 2, 0.22f, 0.4f), a.c.z >= 0 ? 1.f : -1.f});
        z = std::max(z, a.c.z + a.size.z / 2); y += a.c.y;
      }
      L.hasHead = true; L.headZ = z; L.headY = y / float(list.size());
    } else if (k == "rev") for (const auto& a : list) L.halos.push_back({6, vec3(a.c.x, a.c.y, a.c.z + out(a)), 0.4f, 0.3f, a.c.z >= 0 ? 1.f : -1.f});
  }
  if (!ownRev && tails) for (const auto& a : *tails) L.halos.push_back({6, vec3(a.c.x * 0.72f, a.c.y - a.size.y * 0.12f, a.c.z + out(a) - 0.01f), 0.36f, 0.26f, -1.f});
  // the indicators' halos (carlights.js halos: 'ind'): at the model's own amber lamps (a side repeater shows from
  // anywhere: dir 0), else at the outer edge of the head / tail lamps
  {
    const float hl = vm.size.z * 0.5f;
    const std::vector<CarSpec::LampAnchor>* ind = nullptr;
    const std::vector<CarSpec::LampAnchor>* heads = nullptr;
    for (const auto& [k, list] : s.lampHalo) { if (k == "ind") ind = &list; if (k == "head") heads = &list; }
    auto has = [&](float sign) { if (ind) for (const auto& a : *ind) if (a.c.z * sign > hl * 0.45f) return true; return false; };
    auto sgn = [](float v) { return v > 0 ? 1.f : v < 0 ? -1.f : 0.f; };
    if (ind) for (const auto& a : *ind) { const bool end = std::fabs(a.c.z) > hl * 0.45f; const float z = a.c.z + (end ? out(a) : 0.f); L.halos.push_back({7, vec3(a.c.x, a.c.y, z), 0.32f, 0.24f, std::fabs(z) <= hl * 0.45f ? 0.f : z >= 0 ? 1.f : -1.f}); }
    if (!has(1) && heads) for (const auto& a : *heads) L.halos.push_back({7, vec3(a.c.x + sgn(a.c.x) * a.size.x * 0.4f, a.c.y, a.c.z + out(a) + 0.01f), 0.34f, 0.26f, a.c.z + out(a) + 0.01f >= 0 ? 1.f : -1.f});
    if (!has(-1) && tails) for (const auto& a : *tails) L.halos.push_back({7, vec3(a.c.x + sgn(a.c.x) * a.size.x * 0.4f, a.c.y, a.c.z + out(a) - 0.01f), 0.34f, 0.26f, a.c.z + out(a) - 0.01f >= 0 ? 1.f : -1.f});
    L.indF = hasInd && has(1); L.indR = hasInd && has(-1);
  }
  return carLamps_.emplace(&vm, std::move(L)).first->second;
}

void SceneFx::plates(VehicleDraw& vd, const CarPose& c) {
  if (!c.vm || c.plate.empty()) return;
  const Model* pm = plateModel(c.plate);
  if (c.vm->hasPlates) {   // (where carconfig.js puts them on this model: front and rear, none where it has none)
    // (12 mm out along its face: the models keep their own blank plate pieces where ours goes; cars.js drops them)
    for (const glm::dmat4& P : c.vm->plates) vd.add(pm, c.M * P * glm::translate(glm::dmat4(1), dvec3(0, 0, 0.012)), 0);
  } else {
    double L2 = c.vm->size.z * 0.5;
    vd.add(pm, c.M * glm::translate(glm::dmat4(1), dvec3(0, 0.42, L2 + 0.03)), 0);
    vd.add(pm, c.M * glm::translate(glm::dmat4(1), dvec3(0, 0.62, -L2 - 0.03)) * glm::rotate(glm::dmat4(1), PI, dvec3(0, 1, 0)), 0);
  }
  nPlates_++;
}

void SceneFx::submit(Renderer& r, VehicleDraw& vd, Shapes& shapes, const Camera& cam, const std::vector<CarPose>& cars) {
  nSprays_ = 0; nLamps_ = 0; nCarLights_ = 0; nPlates_ = 0;
  const dvec3 cp = cam.pos;
  // ---- the lamp posts' light pools
  if (night_ > 0.2f)
    for (const dvec3& p : lamps_)
      if (glm::length(p - cp) < 260 * std::max(0.6f, lodScale_)) {
        PointLight l;
        l.pos = p; l.color = vec3(1.0f, 0.78f, 0.52f) * 55.f * night_; l.range = 17;
        r.addLight(l);
        nLamps_++;
      }
  // ---- cars: headlights (spots onto the road), the lamps' glow, tail lights, number plates
  // (carlights.js: a soft halo per lamp, additive, never a lit slab: the renderer's glow particles are round, fade
  // into the bodywork they touch (soft depth) and only show from the side the lamp shines to)
  (void)shapes;
  auto lampGlow = [&](const dvec3& p, const dvec3& dir, const vec3& col, float size, float power) {
    dvec3 toCam = cp - p;
    double dl = glm::length(toCam);
    if (dl < 1e-3) return;
    float face = float(smoothstep(-0.05, 0.35, glm::dot(dir, toCam / dl)));
    if (face <= 0.01f) return;
    Particle q;
    q.pos = p;
    q.size = size;
    q.seed = 0.7f;
    q.color = vec4(col, power * face * face);
    q.soft = 0.12f;
    q.kind = 3;
    r.addParticle(q);
  };
  // carlights.js K: emissive intensity per lamp tier (core: the LED / DRL emitters, tex: the textured lamp graphics,
  // plain lenses) and its colours; lampsOn's sums per kind
  static const float K_HEAD[3] = {6, 3, 1.5f}, K_HIGH[3] = {0.9f, 0.5f, 0.3f}, K_DAYH[3] = {2, 0.6f, 0.35f}, K_DRL[3] = {3.2f, 1.4f, 1},
                     K_TAIL[3] = {0.8f, 1, 0.65f}, K_BRAKE[3] = {1.4f, 1.6f, 1.3f}, K_THIRD[3] = {2.2f, 2.4f, 2}, K_REV[3] = {3, 2, 1.4f};
  const vec3 C_HEAD(1, 0.93f, 0.82f), C_DRL(0.9f, 0.95f, 1), C_RED(1, 0.006f, 0), C_REV(0.95f, 0.97f, 1), C_AMBER(1, 0.36f, 0.015f);
  static const float K_IND[3] = {2.6f, 2.2f, 1.8f};
  const float dk = std::round((0.3f + 0.7f * night_) * 10) / 10;
  // (dev / screenshots: SKI_LEGACY_DEBUG=lamptest lights every car's lamps at night, every other one braking, every
  // third reversing; lampday the daytime running lights; the nearest cars' places are logged once)
  static const int lampTest = [] { const char* e = std::getenv("SKI_LEGACY_DEBUG"); return !e ? 0 : std::strstr(e, "haznight") ? 4 : std::strstr(e, "haztest") ? 3 : std::strstr(e, "lampday") ? 2 : std::strstr(e, "lamptest") ? 1 : 0; }();
  static int lampLogged = 0;
  size_t carIdx = 0;
  for (CarPose c : cars) {
    if (!c.vm) continue;
    carIdx++;
    if (lampTest == 1) { c.lights = true; c.brake = carIdx % 2 == 0; c.reverse = carIdx % 3 == 0; c.live = true; }
    else if (lampTest == 2) { c.lights = false; c.live = true; c.brake = carIdx % 2 == 0; }
    else if (lampTest >= 3) { c.hazard = true; c.lights = lampTest == 4; c.brake = false; }   // (haztest / haznight: every car a wreck, the blink held on)
    double d = glm::length(dvec3(c.M[3]) - cp);
    if (lampTest && lampLogged < 12 && d < 400) { lampLogged++; SL_INFO("lamptest: car %s at (%.1f, %.1f, %.1f), nose toward (%.2f, %.2f)%s", c.vm->spec ? c.vm->spec->name.c_str() : "?", c.M[3][0], c.M[3][1], c.M[3][2], c.M[2][0], c.M[2][2], c.vm->spec && c.vm->spec->hasLamps() ? "" : " (no exported lamps)"); }
    const vec3 F = c.vm->lampF, R = c.vm->lampR;
    const bool own = c.vm->spec && c.vm->spec->hasLamps();
    // (lampsOn(inst, head, tail, brake, { drl, reverse }): low beams and tails on together at night / with the
    // switch, the daytime running lights on a running car otherwise)
    const float head = c.lights ? 1.f : 0.f, bk = c.brake ? 1.f : 0.f, rv = c.reverse ? 1.f : 0.f;
    // (opts.hazard: the blink, 380 ms on / 380 ms off, the same for every car; the tails stay on dim, no DRL)
    const int haz = c.hazard ? (lampTest >= 3 ? 1 : int(std::floor(t_ * 1000.0 / 380.0)) % 2) : -1;
    const float tail = haz >= 0 ? std::max(head, 0.55f) : head;
    const float drl = haz < 0 && (c.live || c.brake) && !c.lights ? 1.f : 0.f;
    const bool any = head > 0 || bk > 0 || rv > 0 || drl > 0 || haz >= 0;
    if (c.lights && d < 220 && (d < 140 || c.mine)) {
      PointLight l;
      const CarLamps* cl = own ? &lampsFor(*c.vm) : nullptr;
      float hz = cl && cl->hasHead ? cl->headZ : F.z, hy = cl && cl->hasHead ? cl->headY : F.y;
      l.pos = dvec3(c.M * glm::dvec4(0, hy, hz + 0.25, 1));
      l.dir = glm::normalize(vec3(glm::dmat3(c.M) * dvec3(0, -0.13, 1)));
      l.color = vec3(1.0f, 0.95f, 0.85f) * (c.mine ? 320.f : 240.f);
      l.range = c.mine ? 55.f : 42.f;
      l.cosOuter = std::cos(0.5f); l.cosInner = std::cos(0.26f);
      r.addLight(l);
      nCarLights_++;
    }
    if (own && any && d < 220) {
      const CarLamps& L = lampsFor(*c.vm);
      const float dayH = L.hasDrl ? 0.f : drl;
      // the lamps' own graphics light up (the same triangles as the JS, the same intensities)
      if (d < 160)
        for (const LampModel& p : L.parts) {
          vec3 col = C_RED;
          float k = 0;
          int t = p.tier;
          switch (p.kind) {
            case 0: col = C_HEAD; k = head * K_HEAD[t] + dayH * K_DAYH[t]; break;
            case 1: col = C_HEAD; k = head * K_HIGH[t]; break;
            case 2: col = C_DRL; k = std::max(drl, head * 0.75f) * K_DRL[t]; break;
            case 3: k = tail * K_TAIL[t] + bk * K_BRAKE[t]; break;
            case 4: case 5: k = bk * K_THIRD[t]; break;
            case 6: col = C_REV; k = rv * K_REV[t]; break;
            case 7: col = C_AMBER; k = haz > 0 ? K_IND[t] : 0.f; break;
            case 8: if (haz > 0 && !L.indF) { col = C_AMBER; k = 1.2f; } else { col = C_HEAD; k = head * 0.22f + dayH * 0.05f; } break;
            case 9: if (haz > 0 && !L.indR) { col = C_AMBER; k = 1.2f; } else k = tail * 0.3f + bk * 0.75f; break;
            default: break;
          }
          k *= p.boost;
          if (k > 0.004f && p.model) vd.add(p.model.get(), c.M, 0, vec4(col * k, 1));
        }
      // the halos: the soft glow round each lit lamp, only from in front of it (carlights.js halos / haloFacing)
      for (const LampHalo& h : L.halos) {
        float o = 0;
        vec3 col(1, 0.04f, 0.01f);
        switch (h.kind) {
          case 3: o = (tail * 0.16f + bk * 0.5f) * dk; break;
          case 4: o = bk * 0.45f * dk; break;
          case 0: o = (head * 0.3f + dayH * 0.06f + (L.hasDrl ? drl * 0.04f : 0.f)) * dk; col = vec3(1, 0.88f, 0.7f); break;
          case 6: o = rv * 0.42f * dk; col = vec3(0.85f, 0.9f, 1); break;
          case 7: o = haz > 0 ? 0.6f * (0.45f + 0.55f * dk) : 0.f; col = vec3(1, 0.42f, 0.04f); break;
          default: break;
        }
        o = std::min(1.f, o);
        if (o <= 0.004f) continue;
        dvec3 p = dvec3(c.M * glm::dvec4(h.p, 1));
        dvec3 toEye = cp - p;
        double dl = glm::length(toEye);
        if (dl < 1e-3) continue;
        toEye /= dl;
        dvec3 axis = glm::normalize(dvec3(c.M[2])) * double(h.dir);
        float face = h.dir == 0 ? 1.f : float(smoothstep(0.17, 0.6, glm::dot(axis, toEye)));   // (LAMP_DIR 0: a side repeater, always)
        if (face < 0.003f) continue;
        Particle q;
        q.pos = p + toEye * 0.1;
        q.size = h.sx * 0.5f;
        q.seed = h.sy / std::max(h.sx, 1e-3f);
        q.color = vec4(col, o * face * face);
        q.soft = 0.1f;
        q.kind = 3;
        r.addParticle(q);
      }
    } else if (!own) {
      // (no exported lamps for this model: a halo at the nose and tail)
      if (c.lights && d < 220) {
        dvec3 fwd = glm::normalize(dvec3(c.M[2]));
        for (float sx : {-1.f, 1.f}) lampGlow(dvec3(c.M * glm::dvec4(sx * F.x, F.y, F.z + 0.17, 1)), fwd, vec3(1, 0.88f, 0.7f), 0.25f, 0.3f * dk);
      }
      if ((c.lights || c.brake) && d < 220)
        for (float sx : {-1.f, 1.f})
          lampGlow(dvec3(c.M * glm::dvec4(sx * R.x, R.y, R.z - 0.12, 1)), -glm::normalize(dvec3(c.M[2])), vec3(1, 0.04f, 0.01f), 0.3f, (0.16f + (c.brake ? 0.5f : 0.f)) * dk);
    }
    if (!c.plate.empty() && d < 45) plates(vd, c);
  }
  // ---- snowmaking: each running gun's plume (snowmaking.js's particle maths, on the CPU; one instanced draw)
  if (!running_.empty()) {
    dvec3 windV(2.6 * (0.6 + wind_), 0, 0.7 * (0.6 + wind_));
    for (int gi : running_) {
      const Gun& g = guns_[size_t(gi)];
      dvec3 side = glm::normalize(glm::cross(g.dir, dvec3(0, 1, 0)));
      dvec3 up = glm::normalize(glm::cross(side, g.dir));
      for (const Seed& s : seeds_) {
        double age = std::fmod(t_ / LIFE + s.a + gi * 0.37, 1.0), t = age * LIFE;
        double a = s.b * TAU, rr = std::sqrt(s.c) * 0.2;
        dvec3 v0 = glm::normalize(g.dir + side * (std::cos(a) * rr) + up * (std::sin(a) * rr)) * (13.0 + s.d * 7.0);
        const double k = 1.05;
        dvec3 wander(std::fmod(s.b * 13.7, 1.0) - 0.5, std::fmod(s.c * 7.31, 1.0) - 0.62, std::fmod(s.d * 11.1, 1.0) - 0.5);
        dvec3 p = g.pos + v0 * ((1 - std::exp(-k * t)) / k) + dvec3(0, -0.45, 0) * (t * t) + windV * (t * t * 0.5 * 0.15) + wander * (t * 2.4);
        // (snowmaking.js: a point 0.55 -> 4.2 m across that fades in at once and out over the last 70 % of its life;
        // here a lit, noise-edged powder puff, soft against the snow it settles on)
        double dia = 0.55 + (4.2 - 0.55) * smoothstep(0.0, 1.0, age);
        double al = smoothstep(0.0, 0.05, age) * (1 - smoothstep(0.3, 1.0, age)) * (1 - smoothstep(180.0, SPRAY_RANGE, glm::length(p - cp)));
        if (al < 0.01) continue;
        Particle q;
        q.pos = p;
        q.size = float(dia * 0.5);
        q.color = vec4(0.93f, 0.95f, 0.98f, float(al * 0.3));
        q.rot = float(s.a * 6.28 + t * (s.b - 0.5) * 0.6);
        q.soft = 0.8f;
        q.seed = s.c + float(gi) * 0.17f;
        q.kind = 2;
        r.addParticle(q);
      }
      nSprays_++;
    }
  }
  // ---- flags: masts and their cloths streaming downwind, rippling
  {
    const dvec2 W = glm::normalize(dvec2(2.6, 0.7));
    double base = std::atan2(-W.y, W.x);
    double amp = 0.16 + 0.35 * std::min(1.0, wind_);
    for (size_t i = 0; i < masts_.size(); i++) {
      const Mast& m = masts_[i];
      if (glm::length(m.pos - cp) > 900 * lodScale_) continue;
      shapes.cylinder(r, m.pos, 0.07, MAST_H, vec4(0.85f, 0.87f, 0.9f, 1));
      dvec3 p = m.pos + dvec3(0, MAST_H - 0.12, 0);
      for (int k = 0; k < 8; k++) {
        double yaw = base + amp * std::sin(t_ * (3.1 + 0.4 * std::min(1.0, wind_)) - k * 0.9 + double(i) * 1.3) * (0.3 + k / 7.0);
        glm::dmat4 M = glm::translate(glm::dmat4(1), p) * glm::rotate(glm::dmat4(1), yaw, dvec3(0, 1, 0));
        vd.add(segs_[m.design][k].get(), M, 0);
        p += dvec3(std::cos(yaw), 0, -std::sin(yaw)) * (CLOTH_W / 8);
      }
    }
  }
  // ---- snowcats (headlights at night)
  if (catModel_)
    for (const Cat& c : cats_) {
      double d = glm::length(c.pos - cp);
      if (d > 1500 * lodScale_) continue;
      glm::dmat4 M = glm::translate(glm::dmat4(1), c.pos) * glm::rotate(glm::dmat4(1), c.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), c.pitch, dvec3(1, 0, 0));
      vd.add(catModel_.get(), M * glm::dmat4(catFit_), d < 120 ? 0 : 1);
      if (night_ > 0.2f) {
        PointLight l;
        l.pos = dvec3(M * glm::dvec4(0, 2.4, 3.6, 1));
        l.dir = glm::normalize(vec3(glm::dmat3(M) * dvec3(0, -0.3, 1)));
        l.color = vec3(1.0f, 0.97f, 0.9f) * 380.f; l.range = 50;
        l.cosOuter = std::cos(0.6f); l.cosInner = std::cos(0.3f);
        r.addLight(l);
        for (float sx : {-1.f, 1.f}) lampGlow(dvec3(M * glm::dvec4(sx * 0.8, 2.3, 3.8, 1)), glm::normalize(dvec3(M[2])), vec3(1, 0.88f, 0.7f), 0.3f, 0.45f);
      }
    }
}

} // namespace sl
