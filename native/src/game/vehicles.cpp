#include "game/vehicles.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "world/resort.h"
#include <nlohmann/json.hpp>
#include <algorithm>

namespace sl {

namespace {
// cars.js carTemplate: real glass turned plain tinted glass (no transmission pass), tail-light glass red, lamps clear
Material glassMat(bool red, bool clear) {
  Material m;
  m.baseColor = vec4(hexColor(red ? "#7a0c0c" : clear ? "#c9d0d8" : "#161d24"), red ? 0.7f : clear ? 0.45f : 0.42f);
  m.roughness = 0.06f; m.metallic = 0.15f;
  m.alpha = Material::Alpha::Blend;
  m.doubleSided = true;
  return m;
}
std::shared_ptr<Model> withHidden(const std::shared_ptr<Model>& base, const std::vector<std::string>& hide) {
  auto m = std::make_shared<Model>(*base);
  // (hidden by a zero scale: the instanced draw keeps one vertex input per primitive in node order)
  for (auto& n : m->nodes) for (auto& h : hide) if (n.name == h) n.s = vec3(0);
  return m;
}
} // namespace

void VehicleModels::load(gfx::Device& dev, AssetManager& assets, Transport& t, Resort& resort) {
  ModelLoadOptions mo;
  mo.maxTextureSize = 512;   // (the cars carry dozens of textures each: memory budget)
  mo.lodRatios = {0.12f};   // the traffic's far version (cars.js farMesh: a few thousand triangles)
  for (const CarSpec& s : t.cars) {
    auto base = assets.model(s.name, mo);
    if (!base) continue;
    auto m = withHidden(base, s.hide);
    for (const auto& g : s.glass) if (g.i >= 0 && size_t(g.i) < m->materials.size()) m->materials[size_t(g.i)] = glassMat(g.red, g.clear);
    VehicleModel vm;
    vm.model = m; vm.fit = s.fit; vm.size = s.size;
    cars_[s.name] = vm;
  }
  if (t.bus.ok) {
    if (auto base = assets.model(t.bus.model, mo)) {
      auto m = std::make_shared<Model>(*base);
      // bus.js buildMicruss: its glass dark tinted from outside, its white paint post-bus yellow (micrussPaint)
      for (int i : t.busGlass) if (i >= 0 && size_t(i) < m->materials.size()) {
        Material g = glassMat(false, false);
        g.baseColor = vec4(hexColor("#0e151b"), 0.82f); g.metallic = 0.3f;
        m->materials[size_t(i)] = g;
      }
      for (int i : t.busPaint) if (i >= 0 && size_t(i) < m->materials.size()) {
        Material& p = m->materials[size_t(i)];
        p.baseColor = vec4(hexColor("#f2c200"), 1) * vec4(1.15f, 1.15f, 1.15f, 1);
        p.metallic = std::min(p.metallic, 0.3f);
      }
      bus.model = m; bus.fit = t.bus.fit; bus.size = vec3(float(t.bus.width), 3.0f, float(t.bus.len));
    }
  }
  if (t.rail.ok) {
    if (t.rail.hasBody) if (auto b = assets.model("rail_car2", mo)) { rail.body.model = b; rail.body.fit = t.rail.bodyFit; }
    if (t.railModels) {
      auto& rm = *t.railModels;
      if (rm.contains("cabin")) rail.cabin = resort.transportModel(rm["cabin"]);
      if (rm.contains("frame")) rail.frame = resort.transportModel(rm["frame"]);
      if (rm.contains("bogie")) rail.bogie = resort.transportModel(rm["bogie"]);
      if (rm.contains("lo")) rail.lo = resort.transportModel(rm["lo"]);
    }
  }
  (void)dev;
  SL_INFO("vehicles: %zu car models, bus %s, railcar body %s / cabin %s / frame %s / bogie %s", cars_.size(), bus.ok() ? "ok" : "missing",
          rail.body.ok() ? "ok" : "-", rail.cabin ? "ok" : "-", rail.frame ? "ok" : "-", rail.bogie ? "ok" : "-");
}

const VehicleModel* VehicleModels::car(const std::string& name) const {
  auto it = cars_.find(name);
  return it == cars_.end() ? nullptr : &it->second;
}

void VehicleDraw::add(const Model* m, const glm::dmat4& M, int lod) {
  if (!m) return;
  batches_[m].inst[std::clamp(lod, 0, 1)].push_back(M);
}

void VehicleDraw::submit(Renderer& r, gfx::Device& dev, const dvec3& cam) {
  std::vector<MatrixInstanceBatch::Inst> pk;
  for (auto& [m, b] : batches_) {
    for (int l = 0; l < 2; l++) {
      auto& list = b.inst[l];
      if (list.empty()) continue;
      if (list.size() > b.cap[l]) {
        b.cap[l] = uint32_t(std::max<size_t>(16, list.size() * 2));
        b.gpu[l] = MatrixInstanceBatch();
        b.gpu[l].init(dev, *m, b.cap[l]);
      }
      pk.clear();
      dvec3 mn(1e30), mx(-1e30);
      for (const auto& M : list) { pk.push_back(MatrixInstanceBatch::pack(M, cam)); mn = glm::min(mn, dvec3(M[3])); mx = glm::max(mx, dvec3(M[3])); }
      b.gpu[l].upload(dev, pk);
      dvec3 e(12);
      bool cast = l == 0 && r.castsShadow(mn - e, mx + e);
      if (!r.visible(mn - e, mx + e) && !cast) continue;
      r.submitInstances(b.gpu[l], cam, l, cast);
    }
  }
}

} // namespace sl
