#include "game/vehicles.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "game/carconfigui.h"
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

static void splitWheels(gfx::Device& dev, VehicleModel& vm, const CarSpec* steerSpec);

void VehicleModels::load(gfx::Device& dev, AssetManager& assets, Transport& t, Resort& resort) {
  ModelLoadOptions mo;
  mo.maxTextureSize = 512;   // (the cars carry dozens of textures each: memory budget)
  mo.lodRatios = {0.12f};   // the traffic's far version (cars.js farMesh: a few thousand triangles)
  ModelLoadOptions mc;
  mc.maxTextureSize = 512;
  mc.lodRatios.push_back(0.12f);
  mc.keepCpu = true;        // (Phase 7: the wheels are split off, then the CPU copy is dropped)
  dev_ = &dev; assets_ = &assets; t_ = &t;
  int nSplit = 0;
  for (const CarSpec& s : t.cars) {
    auto base = assets.model(s.name, mc);
    if (!base) continue;
    auto m = withHidden(base, s.hide);
    for (const auto& g : s.glass) if (g.i >= 0 && size_t(g.i) < m->materials.size()) { Material gm = glassMat(g.red, g.clear); gm.name = m->materials[size_t(g.i)].name; m->materials[size_t(g.i)] = gm; }
    VehicleModel vm;
    vm.model = m; vm.fit = s.fit; vm.size = s.size;
    vm.hasPlates = s.hasPlates; vm.plates = s.plates;
    vm.spec = &s;
    for (const Material& bm : base->materials) vm.matTex.push_back(bm.baseTex);
    vm.lampF = vec3(s.size.x * 0.36f, 0.68f, s.size.z * 0.5f - 0.15f);
    vm.lampR = vec3(s.size.x * 0.36f, 0.85f, -s.size.z * 0.5f + 0.1f);
    if (s.hasSteer) { vm.steerKnown = true; vm.steerC = s.steerC; vm.steerTilt = s.steerTilt; vm.steerRimR = s.steerRimR; }
    splitWheels(dev, vm, &s);
    nSplit += vm.split();
    for (auto& mesh : base->meshes) for (auto& p : mesh.primitives) { p.cpuVerts.reset(); p.cpuIdx.reset(); }
    base->images.clear(); m->images.clear();
    for (auto& mesh : m->meshes) for (auto& p : mesh.primitives) { p.cpuVerts.reset(); p.cpuIdx.reset(); }
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
    // (the railcar's body as train.js draws it: the whole mesh with its 2048 px paint out to where the far version takes
    // over (railway.js 220 m, express.js NEAR 420 m). No simplified copy: the Meshy atlas is thousands of UV islands,
    // an edge-collapsed shell smears the red / white livery across them and dents the body)
    ModelLoadOptions mr;
    mr.maxTextureSize = 2048; mr.colorTextureSize = 2048;
    if (t.rail.hasBody) if (auto b = assets.model("rail_car2", mr)) {
      rail.body.model = b; rail.body.fit = t.rail.bodyFit;
      // (Phase 7) the Legacy Express's blue livery: the same body, its red repainted per instance (livery mode)
      auto e = std::make_shared<Model>(*b);
      for (auto& mt : e->materials) mt.paint = 2;
      rail.express.model = e; rail.express.fit = t.rail.bodyFit;
    }
    if (t.railModels) {
      auto& rm = *t.railModels;
      if (rm.contains("cabin")) rail.cabin = resort.transportModel(rm["cabin"]);
      if (rm.contains("cabinExpress")) rail.cabinExpress = resort.transportModel(rm["cabinExpress"]);
      // (train.js materials(): the cabin is plain MeshStandardMaterial, its surfaces' texture its own (the baked
      // cabinPatch maps), no Meshy detail layer: that layer's triplanar grain bumped the walls like plaster and crinkled
      // the grab rails. The panes seen from inside, glassIn, are a standard lit surface too: 13 % of a pale blue with
      // the sun's glint and the sky's reflection at that 13 %, not the renderer's glass (whose Fresnel turns the pane
      // opaque at a glance). Two of them between you and the line ahead, the cab partition and the windscreen)
      for (Model* cm : {rail.cabin.get(), rail.cabinExpress.get()})
        if (cm) for (Material& q : cm->materials) if (q.shading == 0 && q.name.empty()) q.shading = 7;
      // (the cabins' light strips: their own emission, brighter at night and in a tunnel; setCabinLight)
      for (Model* cm : {rail.cabin.get(), rail.cabinExpress.get()})
        if (cm) for (size_t i = 0; i < cm->materials.size(); i++) {
          const Material& q = cm->materials[i];
          if (q.alpha != Material::Alpha::Blend && !q.emissiveTex && q.emissive.x + q.emissive.y + q.emissive.z > 0.01f) cabinMats_.push_back({cm, i, q.emissive});
        }
      setCabinLight(0.3f);
      if (rm.contains("frame")) rail.frame = resort.transportModel(rm["frame"]);
      if (rm.contains("bogie")) rail.bogie = resort.transportModel(rm["bogie"]);
      if (rm.contains("lo")) rail.lo = resort.transportModel(rm["lo"]);
      if (rail.lo) {   // (express.js: the far version in the Express's livery too, paintMat)
        rail.loExpress = std::make_shared<Model>(*rail.lo);
        for (auto& mt : rail.loExpress->materials) mt.paint = 2;
      }
    }
  }
  (void)dev;
  SL_INFO("vehicles: %d of %zu car models with their wheels split off (rolling / steering)", nSplit, cars_.size());
  SL_INFO("vehicles: %zu car models, bus %s, railcar body %s / cabin %s / frame %s / bogie %s", cars_.size(), bus.ok() ? "ok" : "missing",
          rail.body.ok() ? "ok" : "-", rail.cabin ? "ok" : "-", rail.frame ? "ok" : "-", rail.bogie ? "ok" : "-");
}

const VehicleModel* VehicleModels::full(const std::string& baseName) {
  auto it = full_.find(baseName);
  if (it != full_.end()) return it->second.ok() ? &it->second : nullptr;
  VehicleModel vm;
  if (t_ && assets_ && dev_)
    for (const CarSpec& s : t_->carsFull) {
      if (s.kind != baseName) continue;
      ModelLoadOptions mc;
      mc.maxTextureSize = 1024;   // (seen from the driver's seat)
      mc.keepCpu = true;
      auto base = assets_->model(s.name, mc);
      if (!base) break;
      auto m = withHidden(base, s.hide);
      for (const auto& g : s.glass) if (g.i >= 0 && size_t(g.i) < m->materials.size()) { Material gm = glassMat(g.red, g.clear); gm.name = m->materials[size_t(g.i)].name; m->materials[size_t(g.i)] = gm; }
      vm.model = m; vm.fit = s.fit; vm.size = s.size;
      if (const VehicleModel* b = car(baseName)) { vm.hasPlates = b->hasPlates; vm.plates = b->plates; vm.lampF = b->lampF; vm.lampR = b->lampR; }
      if (s.hasSteer) { vm.steerKnown = true; vm.steerC = s.steerC; vm.steerTilt = s.steerTilt; vm.steerRimR = s.steerRimR; }
      splitWheels(*dev_, vm, &s);
      for (auto& mesh : base->meshes) for (auto& p : mesh.primitives) { p.cpuVerts.reset(); p.cpuIdx.reset(); }
      base->images.clear(); m->images.clear();
      for (auto& mesh : m->meshes) for (auto& p : mesh.primitives) { p.cpuVerts.reset(); p.cpuIdx.reset(); }
      break;
    }
  full_[baseName] = vm;
  auto& r = full_[baseName];
  return r.ok() ? &r : nullptr;
}

void VehicleModels::setCabinLight(float k) {
  if (std::fabs(k - cabinK_) < 0.004f) return;
  cabinK_ = k;
  for (const CabinMat& c : cabinMats_) c.model->materials[c.i].emissive = c.lamp * (0.8f + 3.2f * k);
}

const VehicleModel* VehicleModels::dressed(const VehicleModel* vm, int finish, const std::string& rims) const {
  if (!vm) return nullptr;
  if (auto b = rimBase_.find(vm); b != rimBase_.end()) vm = b->second;   // (a dressed one: from its factory model again)
  const CarRim& rim = carRimOf(rims);
  const bool ownRims = std::string(rim.id) == "orig" || !vm->split();
  if (finish < 0 && ownRims) return vm;
  finish = std::min(finish, 3);
  const std::string key = std::to_string(reinterpret_cast<uintptr_t>(vm)) + ":" + std::to_string(finish) + ":" + (ownRims ? "orig" : rim.id);
  auto it = rimmed_.find(key);
  if (it != rimmed_.end()) return it->second.get();
  auto out = std::make_unique<VehicleModel>(*vm);
  if (finish >= 0) {
    // carconfig.js FINISH: solid, metallic, pearl, matte: roughness, metalness, clear coat
    static const float FIN[4][3] = {{0.3f, 0.25f, 1}, {0.24f, 0.72f, 1}, {0.18f, 0.5f, 1}, {0.66f, 0.12f, 0}};
    auto paint = [&](const std::shared_ptr<Model>& src) -> std::shared_ptr<Model> {
      if (!src) return src;
      auto m = std::make_shared<Model>(*src);
      for (auto* list : {&m->materials, &m->lodMaterials})
        for (Material& q : *list) if (q.paint == 1) { q.roughness = FIN[finish][0]; q.metallic = FIN[finish][1]; q.clearcoat = FIN[finish][2]; }
      return m;
    };
    out->model = paint(vm->model);
    out->body = paint(vm->body);
  }
  if (!ownRims) {
    const vec3 tint((rim.hex >> 16 & 255) / 255.f, (rim.hex >> 8 & 255) / 255.f, (rim.hex & 255) / 255.f);
    const vec3 lin(std::pow(tint.x, 2.2f), std::pow(tint.y, 2.2f), std::pow(tint.z, 2.2f));
    const bool black = std::string(rim.id) == "black";
    auto tyre = [](std::string n) {   // (dressCar: /tire|tyre|rubber|disk|disc|rotor|brake|break|calip|callip/i)
      std::transform(n.begin(), n.end(), n.begin(), [](unsigned char ch) { return char(std::tolower(ch)); });
      for (const char* k : {"tire", "tyre", "rubber", "disk", "disc", "rotor", "brake", "break", "calip", "callip"}) if (n.find(k) != std::string::npos) return true;
      return false;
    };
    for (auto& w : out->wheels) {
      if (!w.model) continue;
      auto m = std::make_shared<Model>(*w.model);
      for (Material& q : m->materials) {
        if (tyre(q.name)) continue;
        q.baseColor = vec4(vec3(q.baseColor) * lin, q.baseColor.w);
        if (black) q.roughness = std::min(q.roughness, 0.3f);
      }
      w.model = m;
    }
  }
  const VehicleModel* r = out.get();
  rimBase_[r] = vm;
  rimmed_[key] = std::move(out);
  return r;
}

const VehicleModel* VehicleModels::car(const std::string& name) const {
  auto it = cars_.find(name);
  return it == cars_.end() ? nullptr : &it->second;
}

void VehicleDraw::add(const Model* m, const glm::dmat4& M, int lod, const vec4& tint) {
  if (!m) return;
  batches_[m].inst[std::clamp(lod, 0, 1)].push_back({M, tint});
}

// carconfig.js RIMS: the tint multiplied over the wheels' metal (linear; a = 0: the factory alloys, 0.5: gloss black,
// its roughness capped at 0.3, 1: the others)
vec4 rimColor(const std::string& id) {
  static const std::pair<const char*, const char*> R[] = {{"black", "#1b1c1e"}, {"gunmetal", "#5a5e64"}, {"bronze", "#9a6a36"}, {"gold", "#d0a650"}, {"red", "#a01a1e"}};
  for (auto& [k, hex] : R) if (id == k) return vec4(hexColor(hex), id == "black" ? 0.5f : 1.f);
  return vec4(1, 1, 1, 0);
}

void VehicleDraw::addCar(const VehicleModel& vm, const glm::dmat4& M, int lod, const vec4& tint, double spin, double steer, double wheelTurn, const vec4& rim) {
  if (!vm.ok()) return;
  if (lod > 0 || !vm.split()) { add(vm.model.get(), M * glm::dmat4(vm.fit), lod, tint); return; }
  add(vm.body.get(), M, 0, tint);
  if (vm.steer) {
    glm::dmat4 S = M * glm::translate(glm::dmat4(1), dvec3(vm.steerC));
    if (wheelTurn != 0) S = S * glm::rotate(glm::dmat4(1), wheelTurn, glm::normalize(dvec3(vm.steerAxis)));
    add(vm.steer.get(), S, 0, tint);
  }
  for (const auto& w : vm.wheels) {
    glm::dmat4 W = M * glm::translate(glm::dmat4(1), dvec3(w.c));
    if (w.front && steer != 0) W = W * glm::rotate(glm::dmat4(1), steer, dvec3(0, 1, 0));
    if (spin != 0) W = W * glm::rotate(glm::dmat4(1), spin * (0.34 / std::max(0.2f, w.r)), dvec3(1, 0, 0));
    add(w.model.get(), W, 0, rim);   // (the rims' own tint: the wheels carry no body paint, splitWheels keeps that on the body)
  }
}

vec4 paintColor(const std::string& id) {
  static const std::pair<const char*, const char*> P[] = {
    {"white", "#f2f2f0"}, {"black", "#15171a"}, {"red", "#a8161c"}, {"yellow", "#e2b81c"}, {"orange", "#d0611c"}, {"kingfisher", "#1f68ad"},
    {"lime", "#78ad2a"}, {"silver", "#b2b7bd"}, {"graphite", "#464a50"}, {"blue", "#1d2b50"}, {"green", "#2a4636"}, {"burgundy", "#5e1622"},
    {"bronze", "#8a5a2e"}, {"ice", "#8fb1c8"}, {"pearlwhite", "#efebe2"}, {"violet", "#4a2a5e"}, {"mblack", "#1c1d1f"}, {"mgrey", "#6a6d70"},
    {"army", "#4a5238"}, {"sand", "#b49a72"}};
  for (auto& [k, hex] : P) if (id == k) return vec4(hexColor(hex), 1);
  return vec4(1, 1, 1, 0);
}
vec4 paintForIndex(uint32_t k) {
  // the colours real cars come in (whites, blacks and greys most), a few bright ones
  static const char* T[] = {"white", "black", "silver", "graphite", "white", "blue", "black", "red", "silver", "kingfisher", "graphite", "white",
                            "green", "ice", "burgundy", "mgrey", "yellow", "pearlwhite", "orange", "bronze"};
  uint32_t h = k * 2654435761u;
  return paintColor(T[(h >> 16) % (sizeof T / sizeof *T)]);
}

// (Phase 7) cars.js splitWheels, condensed: the wheels' centres from the meshes / materials named like wheels (per
// quadrant of the fitted car), else from where the body touches the ground; every triangle inside a wheel's cylinder
// (round its axle, x) goes to that wheel, the rest (and the paint: the arches) stays the body.
static void splitWheels(gfx::Device& dev, VehicleModel& vm, const CarSpec* steerSpec) {
  const Model& m = *vm.model;
  struct Tri { vec3 p[3], n[3]; vec2 uv[3]; uint64_t key[3]; int mat; bool named; };   // key: the source vertex (shared ones stay shared)
  std::vector<Tri> tris;
  Pose rest;
  m.restPose(rest);
  m.finishPose(rest);
  auto lower = [](std::string s) { for (auto& ch : s) ch = char(std::tolower(uint8_t(ch))); return s; };
  auto isWheel = [&](const std::string& s0) {
    std::string s = lower(s0);
    if (s.find("steer") != std::string::npos || s.find("int_") != std::string::npos || s.find("interior") != std::string::npos || s.find("seat") != std::string::npos ||
        s.find("trim") != std::string::npos) return false;
    for (const char* k : {"wheel", "tire", "tyre", "rim", "brake", "break", "disk", "disc", "hub"})
      if (s.find(k) != std::string::npos) { if (std::string(k) == "rim" && s.find("trim") != std::string::npos) continue; return true; }
    return false;
  };
  uint64_t primNo = 0;
  for (size_t ni = 0; ni < m.nodes.size(); ni++) {
    const Node& nd = m.nodes[ni];
    if (nd.mesh < 0) continue;
    mat4 G = vm.fit * rest.global[ni];
    if (std::fabs(glm::determinant(mat3(G))) < 1e-12f) continue;   // (hidden: zero scale)
    mat3 N = glm::transpose(glm::inverse(mat3(G)));
    const Mesh& mesh = m.meshes[size_t(nd.mesh)];
    for (const Primitive& p : mesh.primitives) {
      if (!p.cpuVerts || !p.cpuIdx) return;
      const auto& V = *p.cpuVerts;
      const auto& I = *p.cpuIdx;
      int mi = std::max(0, p.material);
      bool named = isWheel(nd.name) || isWheel(mesh.name) || (size_t(mi) < m.materials.size() && isWheel(m.materials[size_t(mi)].name));
      primNo++;
      for (size_t t = 0; t + 2 < I.size(); t += 3) {
        Tri tr;
        tr.mat = mi; tr.named = named;
        for (int k = 0; k < 3; k++) {
          tr.key[k] = (primNo << 32) | I[t + size_t(k)];
          const float* v = &V[size_t(I[t + size_t(k)]) * (p.skinned ? 16 : 8)];
          tr.p[k] = vec3(G * vec4(v[0], v[1], v[2], 1));
          tr.n[k] = glm::normalize(N * vec3(v[3], v[4], v[5]) + vec3(1e-9f));
          tr.uv[k] = vec2(v[6], v[7]);
        }
        tris.push_back(tr);
      }
    }
  }
  if (tris.empty()) return;
  float W = vm.size.x, L = vm.size.z;
  struct Wh { vec3 mn{1e30f}, mx{-1e30f}; int n = 0; vec3 c{0}; float r = 0, hw = 0; bool ok = false; };
  Wh q[4];   // 0 FR (+x? no: by sign) quadrants: bit 0 x > 0, bit 1 z > 0 (front)
  for (const Tri& t : tris) if (t.named)
    for (int k = 0; k < 3; k++) {
      const vec3& p = t.p[k];
      if (p.y > 1.0f || std::fabs(p.x) < W * 0.2f || std::fabs(p.z) < L * 0.15f) continue;
      Wh& w = q[(p.x > 0 ? 1 : 0) | (p.z > 0 ? 2 : 0)];
      w.mn = glm::min(w.mn, p); w.mx = glm::max(w.mx, p); w.n++;
    }
  for (int i = 0; i < 4; i++) {
    Wh& w = q[i];
    if (w.n > 8) {
      w.c = (w.mn + w.mx) * 0.5f;
      w.r = std::max(w.mx.y - w.mn.y, w.mx.z - w.mn.z) * 0.5f;
      w.hw = (w.mx.x - w.mn.x) * 0.5f;
      w.ok = w.r > 0.2f && w.r < 0.6f && std::fabs(w.c.y - w.r) < 0.25f && w.hw < 0.45f;
    }
  }
  bool allNamed = q[0].ok && q[1].ok && q[2].ok && q[3].ok;
  if (!allNamed) {
    // from the ground contact: the lowest geometry at each corner
    for (int i = 0; i < 4; i++) { q[i] = Wh{}; }
    for (const Tri& t : tris)
      for (int k = 0; k < 3; k++) {
        const vec3& p = t.p[k];
        if (p.y > 0.06f || std::fabs(p.x) < W * 0.22f || std::fabs(p.z) < L * 0.12f) continue;
        Wh& w = q[(p.x > 0 ? 1 : 0) | (p.z > 0 ? 2 : 0)];
        w.mn = glm::min(w.mn, p); w.mx = glm::max(w.mx, p); w.n++;
      }
    for (int i = 0; i < 4; i++) {
      Wh& w = q[i];
      if (w.n < 3 || w.mx.z - w.mn.z > 0.8f) return;   // (no clear contact patch: keep the car whole)
      w.r = std::clamp(0.33f * L / 4.6f, 0.29f, 0.42f);
      w.c = vec3((w.mn.x + w.mx.x) * 0.5f - (i & 1 ? 0.1f : -0.1f), w.r, (w.mn.z + w.mx.z) * 0.5f);
      w.hw = 0.16f;
      w.ok = true;
    }
  }
  // the steering wheel's triangles (the web game's own pick, exported as their middles: cars.js splitWheels): found
  // again here by where they are (2 mm cells, within 0.6 mm)
  const CarSpec* sp = steerSpec;
  std::unordered_multimap<uint64_t, vec3> steerAt;
  auto cell = [](const vec3& p, int dx, int dy, int dz) {
    const int64_t x = int64_t(std::floor(p.x * 500.f)) + dx, y = int64_t(std::floor(p.y * 500.f)) + dy, z = int64_t(std::floor(p.z * 500.f)) + dz;
    return (uint64_t(x & 0x1fffff) << 42) | (uint64_t(y & 0x1fffff) << 21) | uint64_t(z & 0x1fffff);
  };
  if (sp && sp->hasSteer)
    for (size_t i = 0; i + 2 < sp->steerTris.size(); i += 3) { const vec3 p(sp->steerTris[i], sp->steerTris[i + 1], sp->steerTris[i + 2]); steerAt.emplace(cell(p, 0, 0, 0), p); }
  auto isSteer = [&](const vec3& c) {
    if (steerAt.empty()) return false;
    for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
      auto r = steerAt.equal_range(cell(c, dx, dy, dz));
      for (auto it = r.first; it != r.second; ++it) if (glm::length(it->second - c) < 0.0006f) return true;
    }
    return false;
  };
  // split the triangles
  std::vector<std::vector<Geo>> parts(6, std::vector<Geo>(m.materials.size()));
  std::vector<std::vector<std::unordered_map<uint64_t, uint32_t>>> seen(6, std::vector<std::unordered_map<uint64_t, uint32_t>>(m.materials.size()));
  size_t nSteer = 0;
  for (const Tri& t : tris) {
    vec3 cen = (t.p[0] + t.p[1] + t.p[2]) / 3.f;
    int part = 4;
    bool paint = size_t(t.mat) < m.materials.size() && m.materials[size_t(t.mat)].paint == 1;
    if (isSteer(cen)) { part = 5; nSteer++; }
    else if (!paint)
      for (int i = 0; i < 4; i++) {
        const Wh& w = q[i];
        if (std::fabs(cen.x - w.c.x) < w.hw + 0.06f && std::hypot(cen.y - w.c.y, cen.z - w.c.z) < w.r + 0.03f) { part = i; break; }
      }
    Geo& g = parts[size_t(part)][size_t(t.mat)];
    auto& sn = seen[size_t(part)][size_t(t.mat)];
    vec3 off = part < 4 ? q[part].c : part == 5 ? sp->steerC : vec3(0);
    for (int k = 0; k < 3; k++) {
      auto [it, fresh] = sn.emplace(t.key[k], uint32_t(g.pos.size()));
      if (fresh) { g.pos.push_back(t.p[k] - off); g.nor.push_back(t.n[k]); g.uv.push_back(t.uv[k]); g.col.push_back(vec3(1)); }
      g.idx.push_back(it->second);
    }
  }
  auto build = [&](int part) -> std::shared_ptr<Model> {
    std::vector<std::pair<Geo, Material>> ps;
    for (size_t mi = 0; mi < parts[size_t(part)].size(); mi++) {
      Geo& g = parts[size_t(part)][mi];
      if (g.empty()) continue;
      Material mt = m.materials[mi];
      mt.vertexColor = false;
      if (part < 4 && mt.paint == 0) {
        // (carconfig.js dressCar: a wheel's metal takes the rim colour; tyres, discs and calipers keep their own)
        const std::string n = lower(mt.name);
        bool keep = false;
        for (const char* k : {"tire", "tyre", "rubber", "disk", "disc", "rotor", "brake", "break", "calip", "callip"}) keep = keep || n.find(k) != std::string::npos;
        if (!keep) mt.paint = 3;
        if (part == 0 && std::getenv("SKI_LEGACY_RIMS")) SL_INFO("rims: %s wheel material '%s' -> %s", m.name.c_str(), mt.name.c_str(), keep ? "kept" : "rim");
      }
      ps.push_back({std::move(g), mt});
    }
    return ps.empty() ? nullptr : buildModel(dev, ps, m.name + (part < 4 ? "_wheel" : part == 5 ? "_steer" : "_body"));
  };
  std::vector<VehicleModel::Wheel> wheels;
  for (int i = 0; i < 4; i++) {
    auto wm = build(i);
    if (!wm) return;
    wheels.push_back({wm, q[i].c, q[i].r, (i & 2) != 0});
  }
  vm.body = build(4);
  if (vm.body) vm.wheels = std::move(wheels);
  if (vm.body && nSteer > 0) { vm.steer = build(5); vm.steerAxis = sp->steerAxis; }
  if (sp && sp->hasSteer) SL_INFO("vehicles: %s steering wheel: %zu of %zu triangles found", m.name.c_str(), nSteer, sp->steerTris.size() / 3);
  // the lamps: at the nose / tail, at the wheels' track, a little above the axles
  float tx = (std::fabs(q[2].c.x) + std::fabs(q[3].c.x)) * 0.5f;
  vm.lampF = vec3(tx * 0.85f, q[2].r * 2.0f, L * 0.5f - 0.15f);
  vm.lampR = vec3(tx * 0.9f, q[0].r * 2.5f, -L * 0.5f + 0.1f);
}

void VehicleDraw::submit(Renderer& r, gfx::Device& dev, const dvec3& cam) {
  // a model nothing drew this frame loses its batch at once: models come and go (a car dressed in a new paint / rims,
  // another player's car, a LOD) and a new one can be allocated at a freed one's address; a batch kept under that key
  // still held the old model's buffers (the crash in submitInstances)
  for (auto it = batches_.begin(); it != batches_.end();) {
    if (it->second.inst[0].empty() && it->second.inst[1].empty()) it = batches_.erase(it); else ++it;
  }
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
      // (each instance on its own: in view, or casting into a shadow cascade. The fleet's bounding box spans the map,
      // so every car and railcar used to be drawn every frame, most of them behind the camera)
      pk.clear();
      const dvec3 e(14);
      bool cast = false;
      for (const auto& [M, tint] : list) {
        const dvec3 c(M[3]);
        const bool cs = l == 0 && r.castsShadow(c - e, c + e);
        if (!cs && !r.visible(c - e, c + e)) continue;
        cast = cast || cs;
        pk.push_back(MatrixInstanceBatch::pack(M, cam, tint));
      }
      if (pk.empty()) { b.gpu[l].upload(dev, pk); continue; }
      b.gpu[l].upload(dev, pk);
      r.submitInstances(b.gpu[l], cam, l, cast);
    }
  }
}

} // namespace sl
