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
      g.fillStyle(DESIGNS[d].bar); g.fillRect(0, 214, 512, 42);
      g.fillStyle(DESIGNS[d].fg);
      g.font("700 96px Barlow");
      g.textAlign("center"); g.textBaseline("middle");
      g.save(); g.translate(256, 110); g.setTransform(1, 0, -0.18f, 1, 256, 110);   // (the italic lean of the arena banners)
      g.fillText(DESIGNS[d].text, 0, 0);
      g.restore();
      Material m;
      m.baseTex = canvasTexture(dev, g);
      m.roughness = 0.9f; m.metallic = 0; m.doubleSided = true;
      for (int k = 0; k < 8; k++) {
        float w = float(CLOTH_W / 8);
        segs_[d][k] = buildModel(dev, {{quadGeo(0, w, float(-CLOTH_H), 0, k / 8.f, (k + 1) / 8.f), m}}, "flag");
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
  // carconfig.js: a Swiss-style plate, white with a black rim and black lettering
  Canvas2D g(256, 56, fonts_);
  g.fillStyle("#f4f4f0"); g.fillRect(0, 0, 256, 56);
  g.strokeStyle("#111111"); g.lineWidth(4); g.strokeRect(3, 3, 250, 50);
  g.fillStyle("#111111"); g.font("700 40px Barlow"); g.textAlign("center"); g.textBaseline("middle");
  g.fillText(text, 128, 30);
  Material m;
  m.baseTex = canvasTexture(*dev_, g);
  m.roughness = 0.5f; m.metallic = 0;
  auto model = buildModel(*dev_, {{quadGeo(-0.26f, 0.26f, -0.056f, 0.056f, 0, 1), m}}, "plate");
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
  const Model* headGlow = shapes.get(Shapes::Kind::Quad, vec4(1, 0.96f, 0.86f, 1), 30.f);
  const Model* tailGlow = shapes.get(Shapes::Kind::Quad, vec4(0.9f, 0.05f, 0.03f, 1), 6.f);
  const Model* brakeGlow = shapes.get(Shapes::Kind::Quad, vec4(1, 0.08f, 0.05f, 1), 16.f);
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
      for (float sx : {-1.f, 1.f}) {
        glm::dmat4 G = c.M * glm::translate(glm::dmat4(1), dvec3(sx * F.x, F.y, F.z + 0.02)) * glm::scale(glm::dmat4(1), dvec3(0.24, 0.1, 1));
        vd.add(headGlow, G, 0);
      }
    }
    if ((c.lights || c.brake) && d < 220)
      for (float sx : {-1.f, 1.f}) {
        glm::dmat4 G = c.M * glm::translate(glm::dmat4(1), dvec3(sx * R.x, R.y, R.z - 0.02)) * glm::rotate(glm::dmat4(1), PI, dvec3(0, 1, 0)) *
                       glm::scale(glm::dmat4(1), dvec3(0.22, 0.08, 1));
        vd.add(c.brake ? brakeGlow : tailGlow, G, 0);
      }
    if (!c.plate.empty() && d < 22) {
      const Model* pm = plateModel(c.plate);
      double L2 = c.vm->size.z * 0.5;
      vd.add(pm, c.M * glm::translate(glm::dmat4(1), dvec3(0, 0.42, L2 + 0.03)), 0);
      vd.add(pm, c.M * glm::translate(glm::dmat4(1), dvec3(0, 0.62, -L2 - 0.03)) * glm::rotate(glm::dmat4(1), PI, dvec3(0, 1, 0)), 0);
      nPlates_++;
    }
  }
  // ---- snowmaking: each running gun's plume (snowmaking.js's particle maths, on the CPU; one instanced draw)
  if (!running_.empty()) {
    const Model* flake = puff_ ? puff_.get() : shapes.get(Shapes::Kind::Quad, vec4(0.95f, 0.97f, 1.0f, 0.5f), 0.35f);
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
        double sz = (0.2 + 1.6 * smoothstep(0.0, 1.0, age)) * smoothstep(0.0, 0.05, age) * (1 - smoothstep(0.7, 1.0, age));
        if (sz < 0.02) continue;
        glm::dmat4 M(1);
        M[0] = glm::dvec4(dvec3(cam.basis[0]) * sz, 0);
        M[1] = glm::dvec4(dvec3(cam.basis[1]) * sz, 0);
        M[2] = glm::dvec4(dvec3(cam.basis[2]) * sz, 0);
        M[3] = glm::dvec4(p, 1);
        vd.add(flake, M, 0);
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
        for (float sx : {-1.f, 1.f}) vd.add(headGlow, M * glm::translate(glm::dmat4(1), dvec3(sx * 0.8, 2.3, 3.75)) * glm::scale(glm::dmat4(1), dvec3(0.3, 0.16, 1)), 0);
      }
    }
}

} // namespace sl
