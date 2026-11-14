#include "game/scenefx.h"
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
  auto it = plates_.find(text);
  if (it != plates_.end()) return it->second.get();
  if (plates_.size() >= 48) {   // (a small cache: the oldest plate texture goes)
    auto old = plates_.find(plateOrder_.front());
    if (old != plates_.end()) {
      for (auto& mesh : old->second->meshes) for (auto& p : mesh.primitives) { dev_->destroy(p.input); dev_->destroy(p.vbo); dev_->destroy(p.ibo); }
      dev_->destroy(old->second->materials[0].baseTex);
      plates_.erase(old);
    }
    plateOrder_.erase(plateOrder_.begin());
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
    q.size = size * (1.f + float(std::min(dl, 160.0)) * 0.012f);   // (the glare keeps a little size with distance)
    q.color = vec4(col * power, face);
    q.soft = 0.12f;
    q.kind = 3;
    r.addParticle(q);
  };
  for (const CarPose& c : cars) {
    if (!c.vm) continue;
    double d = glm::length(dvec3(c.M[3]) - cp);
    const vec3 F = c.vm->lampF, R = c.vm->lampR;
    if (c.lights && d < 220) {
      if (d < 140 || c.mine) {
        PointLight l;
        l.pos = dvec3(c.M * glm::dvec4(0, F.y, F.z + 0.4, 1));
        l.dir = glm::normalize(vec3(glm::dmat3(c.M) * dvec3(0, -0.13, 1)));
        l.color = vec3(1.0f, 0.95f, 0.85f) * (c.mine ? 320.f : 240.f);
        l.range = c.mine ? 55.f : 42.f;
        l.cosOuter = std::cos(0.5f); l.cosInner = std::cos(0.26f);
        r.addLight(l);
        nCarLights_++;
      }
      dvec3 fwd = glm::normalize(dvec3(c.M[2]));
      for (float sx : {-1.f, 1.f}) lampGlow(dvec3(c.M * glm::dvec4(sx * F.x, F.y, F.z + 0.17, 1)), fwd, vec3(1, 0.95f, 0.84f), 0.3f, 14.f);
    }
    if ((c.lights || c.brake) && d < 220)
      for (float sx : {-1.f, 1.f})
        lampGlow(dvec3(c.M * glm::dvec4(sx * R.x, R.y, R.z - 0.12, 1)), -glm::normalize(dvec3(c.M[2])), vec3(1, 0.035f, 0.02f), c.brake ? 0.26f : 0.2f, c.brake ? 7.f : 2.4f);
    if (!c.plate.empty() && d < 45) {
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
        for (float sx : {-1.f, 1.f}) lampGlow(dvec3(M * glm::dvec4(sx * 0.8, 2.3, 3.8, 1)), glm::normalize(dvec3(M[2])), vec3(1, 0.95f, 0.84f), 0.34f, 14.f);
      }
    }
}

} // namespace sl
