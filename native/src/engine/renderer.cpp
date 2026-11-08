#include "engine/renderer.h"
#include "engine/shaders.h"
#include "core/log.h"
#include <algorithm>

#define STB_EASY_FONT_IMPLEMENTATION
#include <stb_easy_font.h>
#include <cstring>
#include <cmath>

namespace sl {

// ---------------------------------------------------------------- camera
void Camera::lookAt(const dvec3& eye, const dvec3& target, const vec3& up) {
  pos = eye;
  vec3 back = glm::normalize(vec3(eye - target));
  vec3 right = glm::normalize(glm::cross(up, back));
  if (!std::isfinite(right.x)) right = vec3(1, 0, 0);
  vec3 u = glm::cross(back, right);
  basis = mat3(right, u, back);
}
mat4 Camera::view() const { return mat4(glm::transpose(basis)); }
mat4 Camera::proj() const { return glm::perspective(glm::radians(fovY), aspect, nearZ, farZ); }

// ---------------------------------------------------------------- instances
static std::vector<gfx::VertexAttrib> baseAttribs(const Primitive& p) {
  const uint32_t st = p.stride;
  std::vector<gfx::VertexAttrib> a = {{0, 0, 3, gfx::AttribType::Float, false, 0, st}, {1, 0, 3, gfx::AttribType::Float, false, 12, st},
                                      {2, 0, 2, gfx::AttribType::Float, false, 24, st}};
  if (p.hasColor) a.push_back({7, 0, 3, gfx::AttribType::Float, false, 32, st});
  return a;
}
void InstanceBatch::init(gfx::Device& d, const Model& m, uint32_t capacity) {
  model_ = &m;
  capacity_ = capacity;
  buf_ = d.createBuffer(gfx::BufferUsage::Vertex, nullptr, sizeof(Inst) * capacity, true);
  for (auto& mesh : m.meshes)
    for (auto& p : mesh.primitives) {
      const uint32_t is = sizeof(Inst);
      auto a = baseAttribs(p);
      a.push_back({5, 1, 4, gfx::AttribType::Float, false, 0, is, true});
      a.push_back({6, 1, 4, gfx::AttribType::Float, false, 16, is, true});
      inputs_.push_back(d.createVertexInput(a, {p.vbo, buf_}, p.ibo));
    }
}
void MatrixInstanceBatch::init(gfx::Device& d, const Model& m, uint32_t capacity) {
  model_ = &m;
  capacity_ = std::max(1u, capacity);
  buf_ = d.createBuffer(gfx::BufferUsage::Vertex, nullptr, sizeof(Inst) * capacity_, true);
  // (one vertex input per primitive in NODE order, as submitInstances walks them: a model whose nodes reference its
  // meshes out of order, or share one, drew a primitive with another node's buffers before)
  for (auto& node : m.nodes) {
    if (node.mesh < 0) continue;
    const Mesh& mesh = m.meshes[size_t(node.mesh)];
    for (auto& p : mesh.primitives) {
      const uint32_t is = sizeof(Inst);
      auto a = baseAttribs(p);
      a.push_back({9, 1, 4, gfx::AttribType::Float, false, 0, is, true});
      a.push_back({10, 1, 4, gfx::AttribType::Float, false, 16, is, true});
      a.push_back({11, 1, 4, gfx::AttribType::Float, false, 32, is, true});
      inputs_.push_back(d.createVertexInput(a, {p.vbo, buf_}, p.ibo));
    }
  }
}
void MatrixInstanceBatch::upload(gfx::Device& d, const std::vector<Inst>& inst) {
  count_ = uint32_t(std::min<size_t>(inst.size(), capacity_));
  if (count_) d.replaceBuffer(buf_, inst.data(), count_ * sizeof(Inst));
}
MatrixInstanceBatch::Inst MatrixInstanceBatch::pack(const glm::dmat4& w, const dvec3& o) {
  return {vec4(float(w[0][0]), float(w[1][0]), float(w[2][0]), float(w[3][0] - o.x)),
          vec4(float(w[0][1]), float(w[1][1]), float(w[2][1]), float(w[3][1] - o.y)),
          vec4(float(w[0][2]), float(w[1][2]), float(w[2][2]), float(w[3][2] - o.z))};
}
void InstanceBatch::upload(gfx::Device& d, const std::vector<Inst>& inst) {
  count_ = uint32_t(std::min<size_t>(inst.size(), capacity_));
  d.replaceBuffer(buf_, inst.data(), count_ * sizeof(Inst));
}

// ---------------------------------------------------------------- set-up
gfx::Program Renderer::build(const char* name, const char* defines, const char* vs, const char* fs, bool lit) {
  std::string head = std::string("#version 410 core\n") + defines + "\n" + shaders::kCommon;
  std::string fsrc = head + (lit ? shaders::kLighting : "") + fs;
  gfx::Program p = dev_->createProgram(name, head + vs, fsrc);
  if (p) {
    dev_->useProgram(p);
    dev_->setUniformBlock("Frame", 0);
    dev_->setInt("uBase", 0); dev_->setInt("uMR", 1); dev_->setInt("uNormalMap", 2);
    dev_->setInt("uShadowMap", 5); dev_->setInt("uNoise", 3); dev_->setInt("uHdr", 0); dev_->setInt("uEmissiveMap", 4);
  }
  return p;
}

// terrain.js makeNoiseTexture: tileable value-noise fbm (R), its gradient (GB) and a second fbm (A)
void Renderer::makeNoiseTexture() {
  const int S = 256, U = 8;
  auto lattice = [](int seed, int period) {
    std::vector<float> g(size_t(period) * period);
    double x = seed * 9301.0 + 49297.0;
    for (auto& v : g) { x = std::fmod(x * 233280 + 49297, 2147483647.0); v = float(std::fmod(x, 10000.0) / 10000.0); }
    return g;
  };
  auto sample = [](const std::vector<float>& g, int period, double x, double y) {
    int xi = int(std::floor(x)), yi = int(std::floor(y));
    double fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    auto at = [&](int i, int j) { return g[size_t(((j % period + period) % period) * period + ((i % period + period) % period))]; };
    double a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  std::vector<std::vector<float>> A, B;
  for (int o = 0; o < 5; o++) { A.push_back(lattice(1 + o, U << o)); B.push_back(lattice(50 + o, U << o)); }
  auto fbm = [&](const std::vector<std::vector<float>>& c, double x, double y) {
    double s = 0, amp = 0.5, norm = 0;
    for (int o = 0; o < 5; o++) { s += amp * sample(c[size_t(o)], U << o, x * (1 << o), y * (1 << o)); norm += amp; amp *= 0.5; }
    return s / norm;
  };
  std::vector<float> fa(size_t(S) * S);
  std::vector<uint8_t> px(size_t(S) * S * 4);
  for (int j = 0; j < S; j++) for (int i = 0; i < S; i++) {
    double x = double(i) / S * U, y = double(j) / S * U;
    fa[size_t(j) * S + i] = float(fbm(A, x, y));
    px[(size_t(j) * S + i) * 4 + 3] = uint8_t(std::lround(fbm(B, x, y) * 255));
  }
  double k = double(S) / U;
  for (int j = 0; j < S; j++) for (int i = 0; i < S; i++) {
    double dx = (fa[size_t(j) * S + (i + 1) % S] - fa[size_t(j) * S + (i - 1 + S) % S]) * k / 2;
    double dy = (fa[size_t((j + 1) % S) * S + i] - fa[size_t((j - 1 + S) % S) * S + i]) * k / 2;
    size_t o = (size_t(j) * S + i) * 4;
    px[o] = uint8_t(std::lround(fa[size_t(j) * S + i] * 255));
    px[o + 1] = uint8_t(std::lround(std::clamp(0.5 + dx / 6, 0.0, 1.0) * 255));
    px[o + 2] = uint8_t(std::lround(std::clamp(0.5 + dy / 6, 0.0, 1.0) * 255));
  }
  gfx::TextureDesc d;
  d.width = d.height = S;
  d.anisotropy = 4;
  noise_ = dev_->createTexture(d, px.data());
}

bool Renderer::init(gfx::Device& dev, const RenderSettings& s) {
  dev_ = &dev;
  set_ = s;
  mesh_ = build("mesh", "", shaders::kMeshVS, shaders::kMeshFS, true);
  meshSkin_ = build("mesh_skinned", "#define SKINNED 1", shaders::kMeshVS, shaders::kMeshFS, true);
  meshInst_ = build("mesh_instanced", "#define INSTANCED 1", shaders::kMeshVS, shaders::kMeshFS, true);
  meshInstM_ = build("mesh_instmat", "#define INSTMAT 1", shaders::kMeshVS, shaders::kMeshFS, true);
  depthInstM_ = build("depth_instmat", "#define INSTMAT 1", shaders::kMeshVS, shaders::kDepthFS, false);
  terrain_ = build("terrain", "", shaders::kTerrainVS, shaders::kTerrainFS, true);
  depthMesh_ = build("depth_mesh", "", shaders::kMeshVS, shaders::kDepthFS, false);
  depthSkin_ = build("depth_skinned", "#define SKINNED 1", shaders::kMeshVS, shaders::kDepthFS, false);
  depthInst_ = build("depth_instanced", "#define INSTANCED 1", shaders::kMeshVS, shaders::kDepthFS, false);
  depthTerrain_ = build("depth_terrain", "", shaders::kTerrainVS, shaders::kDepthFS, false);
  sky_ = build("sky", "", shaders::kSkyVS, shaders::kSkyFS, false);
  post_ = build("post", "", shaders::kPostVS, shaders::kPostFS, false);
  hud_ = build("hud", "", shaders::kHudVS, shaders::kHudFS, false);
  if (!mesh_ || !meshSkin_ || !meshInst_ || !meshInstM_ || !depthInstM_ || !terrain_ || !depthMesh_ || !depthSkin_ || !depthInst_ || !depthTerrain_ || !sky_ || !post_ || !hud_) return false;
  frameUbo_ = dev.createBuffer(gfx::BufferUsage::Uniform, nullptr, 512, true);
  shadowUbo_ = dev.createBuffer(gfx::BufferUsage::Uniform, nullptr, 512, true);
  hudVbo_ = dev.createBuffer(gfx::BufferUsage::Vertex, nullptr, 1 << 16, true);
  hudVi_ = dev.createVertexInput({{0, 0, 2, gfx::AttribType::Float, false, 0, 24}, {1, 0, 4, gfx::AttribType::Float, false, 8, 24}}, {hudVbo_}, {});
  emptyVi_ = dev.createVertexInput({}, {}, {});
  shadow_ = dev.createRenderTarget(s.shadowSize, s.shadowSize, false, gfx::TexFormat::RGBA8, true, gfx::TexFormat::Depth24, true);
  uint8_t w[4] = {255, 255, 255, 255};
  gfx::TextureDesc td; td.mipmaps = false; td.filter = gfx::Filter::Nearest;
  white_ = dev.createTexture(td, w);
  makeNoiseTexture();
  return true;
}

void Renderer::resize(int w, int h) {
  w_ = std::max(1, w); h_ = std::max(1, h);
  int rw = std::max(1, int(w_ * set_.renderScale)), rh = std::max(1, int(h_ * set_.renderScale));
  if (hdr_ && rw == rw_ && rh == rh_) return;
  if (hdr_) dev_->destroy(hdr_);
  rw_ = rw; rh_ = rh;
  hdr_ = dev_->createRenderTarget(rw_, rh_, true, gfx::TexFormat::RGBA16F, true, gfx::TexFormat::Depth24);
}

// ---------------------------------------------------------------- frame
namespace {
struct FrameBlock {
  mat4 viewProj, shadowMat;
  vec4 camPos, sunDir, sunColor, sky, ground, fog, fogParams, zenith, mid, horizon, glow, misc;
};
} // namespace

void Renderer::beginFrame(const Camera& cam, const Lighting& L, const dvec3& focus) {
  cam_ = cam;
  cam_.aspect = float(w_) / float(h_);
  light_ = L;
  items_.clear();
  hudVerts_.clear();
  viewProj_ = cam_.proj() * cam_.view();
  // frustum planes (Gribb-Hartmann) for culling camera-relative boxes
  mat4 m = glm::transpose(viewProj_);
  planes_[0] = m[3] + m[0]; planes_[1] = m[3] - m[0]; planes_[2] = m[3] + m[1];
  planes_[3] = m[3] - m[1]; planes_[4] = m[3] + m[2]; planes_[5] = m[3] - m[2];

  // shadow camera: ortho box round the focus, texel-snapped in light space (world coordinates, double precision)
  vec3 ld = glm::normalize(L.sunDir);
  vec3 lx = glm::normalize(glm::cross(vec3(0, 1, 0), ld)), ly = glm::cross(ld, lx);
  double R = set_.shadowRange, texel = 2 * R / set_.shadowSize;
  double fx = glm::dot(dvec3(lx), focus), fy = glm::dot(dvec3(ly), focus), fz = glm::dot(dvec3(ld), focus);
  fx = std::floor(fx / texel) * texel; fy = std::floor(fy / texel) * texel;
  dvec3 centerW = dvec3(lx) * fx + dvec3(ly) * fy + dvec3(ld) * fz;
  vec3 center = vec3(centerW - cam_.pos);
  mat4 lview = glm::lookAt(center + ld * 1500.f, center, vec3(0, 1, 0));
  mat4 lproj = glm::ortho(float(-R), float(R), float(-R), float(R), 1.f, 3000.f);
  mat4 lvp = lproj * lview;
  lightView_ = lview;
  shadowR_ = float(R);
  mat4 bias = glm::translate(mat4(1), vec3(0.5f)) * glm::scale(mat4(1), vec3(0.5f));

  FrameBlock fb{};
  fb.viewProj = viewProj_;
  fb.shadowMat = bias * lvp;
  fb.camPos = vec4(vec3(cam_.pos), 0);
  fb.sunDir = vec4(ld, 1);
  fb.sunColor = vec4(L.sunColor * L.sunIntensity, 0);
  fb.sky = vec4(L.sky, 0); fb.ground = vec4(L.ground, 0); fb.fog = vec4(L.fog, 0);
  fb.fogParams = vec4(L.fogDensity, L.fogFalloff, 1.0f / set_.shadowSize, L.exposure);
  fb.zenith = vec4(L.zenith, 0); fb.mid = vec4(L.mid, 0); fb.horizon = vec4(L.horizon, 0); fb.glow = vec4(L.glow, 0);
  fb.misc = vec4(L.night, 0, 0, 0);
  fb.sunDir.w = L.sunIntensity > 0.01f ? 1.f : 0.f;
  dev_->updateBuffer(frameUbo_, &fb, sizeof fb);
  FrameBlock sb = fb;
  sb.viewProj = lvp;
  dev_->updateBuffer(shadowUbo_, &sb, sizeof sb);
}

bool Renderer::visible(const dvec3& bmin, const dvec3& bmax) const {
  vec3 mn = vec3(bmin - cam_.pos), mx = vec3(bmax - cam_.pos);
  for (const vec4& p : planes_) {
    vec3 v(p.x > 0 ? mx.x : mn.x, p.y > 0 ? mx.y : mn.y, p.z > 0 ? mx.z : mn.z);
    if (p.x * v.x + p.y * v.y + p.z * v.z + p.w < 0) return false;
  }
  return true;
}

bool Renderer::castsShadow(const dvec3& bmin, const dvec3& bmax) const {
  vec3 mn = vec3(bmin - cam_.pos), mx = vec3(bmax - cam_.pos);
  vec2 lo(1e30f), hi(-1e30f);
  for (int c = 0; c < 8; c++) {
    vec3 p((c & 1) ? mx.x : mn.x, (c & 2) ? mx.y : mn.y, (c & 4) ? mx.z : mn.z);
    vec3 l = vec3(lightView_ * vec4(p, 1));
    lo = glm::min(lo, vec2(l)); hi = glm::max(hi, vec2(l));
  }
  return hi.x > -shadowR_ && lo.x < shadowR_ && hi.y > -shadowR_ && lo.y < shadowR_;
}

void Renderer::submitModel(const Model& m, const dvec3& origin, const mat4& local, const Pose* pose, bool castShadow, int lod, bool visible) {
  mat4 rel = glm::translate(mat4(1), vec3(origin - cam_.pos)) * local;
  for (size_t i = 0; i < m.nodes.size(); i++) {
    const Node& n = m.nodes[i];
    if (n.mesh < 0) continue;
    for (const Primitive& p : m.meshes[size_t(n.mesh)].primitives) {
      Item it{};
      it.kind = Item::Kind::Mesh;
      it.vi = p.input;
      const auto& L = p.lods[size_t(std::min<int>(lod, int(p.lods.size()) - 1))];
      it.first = L.first; it.count = L.count;
      it.mat = &m.materials[size_t(std::max(0, p.material))];
      it.skinned = p.skinned && pose && !pose->joints.empty();
      it.joints = it.skinned ? &pose->joints : nullptr;
      // skinned: joint matrices already place the mesh in model space (the node's own transform is ignored)
      it.model = it.skinned ? rel : rel * (pose && pose->global.size() == m.nodes.size() ? pose->global[i] : mat4(1));
      if (!it.skinned && !pose) {
        // static: node global from the rest pose (computed once per draw: models here are tiny hierarchies)
        mat4 g(1);
        for (int k = int(i); k >= 0; k = m.nodes[size_t(k)].parent) {
          const Node& q = m.nodes[size_t(k)];
          g = glm::translate(mat4(1), q.t) * glm::mat4_cast(q.r) * glm::scale(mat4(1), q.s) * g;
        }
        it.model = rel * g;
      }
      it.shadow = castShadow;
      it.main = visible;
      items_.push_back(it);
    }
  }
}

void Renderer::submitInstances(const InstanceBatch& b, const mat4& fit, int lod, bool castShadow) {
  if (!b.count() || !b.model()) return;
  const Model& m = *b.model();
  size_t k = 0;
  for (size_t i = 0; i < m.nodes.size(); i++) {
    if (m.nodes[i].mesh < 0) continue;
    mat4 g(1);
    for (int q = int(i); q >= 0; q = m.nodes[size_t(q)].parent) {
      const Node& nd = m.nodes[size_t(q)];
      g = glm::translate(mat4(1), nd.t) * glm::mat4_cast(nd.r) * glm::scale(mat4(1), nd.s) * g;
    }
    for (const Primitive& p : m.meshes[size_t(m.nodes[i].mesh)].primitives) {
      if (k >= b.inputs().size()) break;
      Item it{};
      it.kind = Item::Kind::Instanced;
      it.vi = b.inputs()[k++];
      const auto& L = p.lods[size_t(std::min<int>(lod, int(p.lods.size()) - 1))];
      it.first = L.first; it.count = L.count; it.instances = b.count();
      it.mat = &m.materials[size_t(std::max(0, p.material))];
      it.model = fit * g;
      it.shadow = castShadow;
      items_.push_back(it);
    }
  }
}

void Renderer::submitInstances(const MatrixInstanceBatch& b, const dvec3& origin, int lod, bool castShadow, const Material* matOverride) {
  if (!b.count() || !b.model()) return;
  const Model& m = *b.model();
  size_t k = 0;
  vec3 o = vec3(origin - cam_.pos);
  for (size_t i = 0; i < m.nodes.size(); i++) {
    if (m.nodes[i].mesh < 0) continue;
    mat4 g(1);
    for (int q = int(i); q >= 0; q = m.nodes[size_t(q)].parent) {
      const Node& nd = m.nodes[size_t(q)];
      g = glm::translate(mat4(1), nd.t) * glm::mat4_cast(nd.r) * glm::scale(mat4(1), nd.s) * g;
    }
    for (const Primitive& p : m.meshes[size_t(m.nodes[i].mesh)].primitives) {
      if (k >= b.inputs().size()) break;
      Item it{};
      it.kind = Item::Kind::InstMat;
      it.vi = b.inputs()[k++];
      const auto& L = p.lods[size_t(std::min<int>(lod, int(p.lods.size()) - 1))];
      it.first = L.first; it.count = L.count; it.instances = b.count();
      it.mat = matOverride ? matOverride : &m.materials[size_t(std::max(0, p.material))];
      it.model = g;
      it.origin = o;
      it.shadow = castShadow && it.mat->alpha != Material::Alpha::Blend;
      items_.push_back(it);
    }
  }
}

void Renderer::submitTerrain(gfx::VertexInput vi, uint32_t indexCount, const dvec3& origin, bool castShadow, bool visible) {
  Item it{};
  it.kind = Item::Kind::Terrain;
  it.vi = vi; it.count = indexCount;
  it.origin = vec3(origin - cam_.pos);
  it.shadow = castShadow;
  it.main = visible;
  items_.push_back(it);
}

void Renderer::setMaterial(const Material& m) {
  dev_->bindTexture(0, m.baseTex ? m.baseTex : white_);
  dev_->bindTexture(1, m.mrTex ? m.mrTex : white_);
  dev_->bindTexture(2, m.normalTex ? m.normalTex : white_);
  dev_->setVec4("uBaseColor", glm::value_ptr(m.baseColor));
  vec4 mat(m.metallic, m.roughness, m.normalScale, m.alpha == Material::Alpha::Mask ? m.alphaCutoff : -1.f);
  dev_->setVec4("uMat", glm::value_ptr(mat));
  vec4 flags(m.baseTex ? 1.f : 0.f, m.mrTex ? 1.f : 0.f, m.normalTex ? 1.f : 0.f, m.doubleSided ? 1.f : 0.f);
  dev_->setVec4("uFlags", glm::value_ptr(flags));
  vec3 em = m.emissive * (m.emissiveNight.x + m.emissiveNight.y * light_.night);
  dev_->setVec3("uEmissive", glm::value_ptr(em));
  dev_->bindTexture(4, m.emissiveTex ? m.emissiveTex : white_);
  vec4 f2(m.vertexColor ? 1.f : 0.f, m.emissiveTex ? 1.f : 0.f, m.glow, m.colorSqrt ? 1.f : 0.f);
  dev_->setVec4("uFlags2", glm::value_ptr(f2));
}

void Renderer::drawItem(const Item& it, bool shadowPass, gfx::PipelineState& ps, gfx::Program& cur) {
  auto use = [&](gfx::Program p) { if (p.id != cur.id) { dev_->useProgram(p); cur = p; } };
  if (it.kind == Item::Kind::Terrain) {
    use(shadowPass ? depthTerrain_ : terrain_);
    if (!shadowPass) { dev_->bindTexture(3, noise_); }
    ps.cull = shadowPass ? gfx::Cull::None : gfx::Cull::Back;
    dev_->setPipeline(ps);
    dev_->setVec3("uOrigin", glm::value_ptr(it.origin));
    dev_->drawIndexed(it.vi, gfx::IndexType::U32, it.count);
    return;
  }
  gfx::Program p = it.kind == Item::Kind::Instanced ? (shadowPass ? depthInst_ : meshInst_)
                 : it.kind == Item::Kind::InstMat ? (shadowPass ? depthInstM_ : meshInstM_)
                 : it.skinned ? (shadowPass ? depthSkin_ : meshSkin_) : (shadowPass ? depthMesh_ : mesh_);
  use(p);
  if (!shadowPass) {
    setMaterial(*it.mat);
    ps.cull = it.mat->doubleSided ? gfx::Cull::None : gfx::Cull::Back;
  }
  dev_->setPipeline(ps);
  dev_->setMat4("uModel", glm::value_ptr(it.model));
  if (it.kind == Item::Kind::InstMat) dev_->setVec3("uInstOrigin", glm::value_ptr(it.origin));
  if (it.skinned && it.joints) dev_->setMat4("uJoints[0]", glm::value_ptr((*it.joints)[0]), int(std::min<size_t>(64, it.joints->size())));
  dev_->drawIndexed(it.vi, gfx::IndexType::U32, it.count, it.first, it.instances);
}

void Renderer::drawItems(bool shadowPass) {
  gfx::PipelineState ps;
  if (shadowPass) { ps.colorWrite = false; ps.cull = gfx::Cull::None; ps.depthBiasFactor = 1.6f; ps.depthBiasUnits = 2.f; }
  gfx::Program cur{};
  // terrain first (largest occluder), then opaque meshes, then (main pass) the transparent ones back to front
  blend_.clear();
  for (int pass = 0; pass < 2; pass++)
    for (const Item& it : items_) {
      if (shadowPass ? !it.shadow : !it.main) continue;
      bool terr = it.kind == Item::Kind::Terrain;
      if ((pass == 0) != terr) continue;
      if (!terr && it.mat && it.mat->alpha == Material::Alpha::Blend) { if (!shadowPass) blend_.push_back(&it); continue; }
      drawItem(it, shadowPass, ps, cur);
    }
  if (shadowPass || blend_.empty()) return;
  auto dist = [](const Item* it) { vec3 c = it->kind == Item::Kind::InstMat ? it->origin : vec3(it->model[3]); return glm::dot(c, c); };
  std::sort(blend_.begin(), blend_.end(), [&](const Item* a, const Item* b) { return dist(a) > dist(b); });
  ps.blend = gfx::Blend::Alpha;
  ps.depthWrite = false;
  for (const Item* it : blend_) drawItem(*it, false, ps, cur);
}

void Renderer::endFrame() {
  dev_->resetFrameStats();
  // shadow map
  dev_->bindRenderTarget(shadow_, set_.shadowSize, set_.shadowSize);
  dev_->clear(0, 0, 0, 0, false, true);
  dev_->bindUniformBuffer(0, shadowUbo_);
  drawItems(true);

  // main pass (HDR)
  dev_->bindRenderTarget(hdr_, rw_, rh_);
  dev_->clear(0, 0, 0, 1, true, true);
  dev_->bindUniformBuffer(0, frameUbo_);
  dev_->bindTexture(5, dev_->renderTargetDepth(shadow_));
  drawItems(false);
  // sky behind everything
  {
    gfx::PipelineState ps;
    ps.depth = gfx::DepthTest::LessEqual; ps.depthWrite = false; ps.cull = gfx::Cull::None;
    dev_->setPipeline(ps);
    dev_->useProgram(sky_);
    mat4 inv = glm::inverse(viewProj_);
    dev_->setMat4("uInvViewProj", glm::value_ptr(inv));
    dev_->draw(emptyVi_, 3);
  }
  // tone map to the window
  dev_->bindRenderTarget({}, w_, h_);
  {
    gfx::PipelineState ps;
    ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None;
    dev_->setPipeline(ps);
    dev_->useProgram(post_);
    dev_->bindTexture(0, dev_->renderTargetColor(hdr_));
    dev_->setFloat("uExposure", light_.exposure);
    dev_->setInt("uToneMap", light_.toneMap);
    dev_->draw(emptyVi_, 3);
  }
  // HUD
  if (!hudVerts_.empty()) {
    gfx::PipelineState ps;
    ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None; ps.blend = gfx::Blend::Alpha;
    dev_->setPipeline(ps);
    dev_->useProgram(hud_);
    vec2 scr = vec2(float(w_), float(h_));
    dev_->setVec2("uScreen", glm::value_ptr(scr));
    dev_->replaceBuffer(hudVbo_, hudVerts_.data(), hudVerts_.size() * sizeof(float));
    dev_->draw(hudVi_, uint32_t(hudVerts_.size() / 6));
  }
  lastDraws_ = dev_->drawCallsThisFrame();
}

// ---------------------------------------------------------------- HUD
void Renderer::hudRect(float x, float y, float w, float h, const vec4& c) {
  const float v[6][2] = {{x, y}, {x + w, y}, {x + w, y + h}, {x, y}, {x + w, y + h}, {x, y + h}};
  for (auto& p : v) { hudVerts_.insert(hudVerts_.end(), {p[0], p[1], c.x, c.y, c.z, c.w}); }
}

void Renderer::hudText(float x, float y, float scale, const vec4& c, const std::string& text) {
  static char buf[60000];
  int quads = stb_easy_font_print(0, 0, const_cast<char*>(text.c_str()), nullptr, buf, sizeof buf);
  const float* q = reinterpret_cast<const float*>(buf);
  // stb_easy_font vertex: x, y, z, color (4 bytes) = 16 bytes; 4 vertices per quad
  for (int i = 0; i < quads; i++) {
    const float* v0 = q + i * 16;
    float px[4], py[4];
    for (int k = 0; k < 4; k++) { px[k] = x + v0[k * 4] * scale; py[k] = y + v0[k * 4 + 1] * scale; }
    const int tri[6] = {0, 1, 2, 0, 2, 3};
    for (int t : tri) hudVerts_.insert(hudVerts_.end(), {px[t], py[t], c.x, c.y, c.z, c.w});
  }
}

float Renderer::hudTextWidth(const std::string& text, float scale) {
  return float(stb_easy_font_width(const_cast<char*>(text.c_str()))) * scale;
}

} // namespace sl
