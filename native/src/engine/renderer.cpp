#include "engine/renderer.h"
#include "engine/shaders.h"
#include "core/log.h"
#include <algorithm>
#include <chrono>
#include <cstdlib>

#define STB_EASY_FONT_IMPLEMENTATION
#include <stb_easy_font.h>
#include <cstring>
#include <cmath>

namespace sl {

// texture units (every sampler name has its own unit: no two sampler types ever share one)
enum Unit : int { U_BASE = 0, U_MR = 1, U_NORMAL = 2, U_NOISE = 3, U_EMISSIVE = 4, U_SHADOW = 5, U_ENV = 6, U_TRAIL = 7,
                  U_DETAIL = 8, U_SNOW = 9, U_ROCK = 10, U_SKYNOISE = 11, U_DEPTH = 12, U_BLOOM = 13, U_AO = 14 };

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
  // the packed 28-byte layout (resort.bin's meshes, mesh_kit models)
  if (p.packed)
    return {{0, 0, 3, gfx::AttribType::Float, false, 0, st}, {1, 0, 3, gfx::AttribType::Byte, true, 12, st},
            {2, 0, 2, gfx::AttribType::Float, false, 16, st}, {7, 0, 3, gfx::AttribType::UByte, true, 24, st}};
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
  // (one vertex input per primitive in NODE order, as submitInstances walks them)
  for (auto& node : m.nodes) {
    if (node.mesh < 0) continue;
    const Mesh& mesh = m.meshes[size_t(node.mesh)];
    for (auto& p : mesh.primitives) {
      const uint32_t is = sizeof(Inst);
      auto a = baseAttribs(p);
      a.push_back({9, 1, 4, gfx::AttribType::Float, false, 0, is, true});
      a.push_back({10, 1, 4, gfx::AttribType::Float, false, 16, is, true});
      a.push_back({11, 1, 4, gfx::AttribType::Float, false, 32, is, true});
      a.push_back({12, 1, 4, gfx::AttribType::Float, false, 48, is, true});
      inputs_.push_back(d.createVertexInput(a, {p.vbo, buf_}, p.ibo));
    }
  }
}
void MatrixInstanceBatch::upload(gfx::Device& d, const std::vector<Inst>& inst) {
  count_ = uint32_t(std::min<size_t>(inst.size(), capacity_));
  if (count_) d.replaceBuffer(buf_, inst.data(), count_ * sizeof(Inst));
}
MatrixInstanceBatch::Inst MatrixInstanceBatch::pack(const glm::dmat4& w, const dvec3& o, const vec4& tint) {
  return {vec4(float(w[0][0]), float(w[1][0]), float(w[2][0]), float(w[3][0] - o.x)),
          vec4(float(w[0][1]), float(w[1][1]), float(w[2][1]), float(w[3][1] - o.y)),
          vec4(float(w[0][2]), float(w[1][2]), float(w[2][2]), float(w[3][2] - o.z)), tint};
}
void InstanceBatch::upload(gfx::Device& d, const std::vector<Inst>& inst) {
  count_ = uint32_t(std::min<size_t>(inst.size(), capacity_));
  d.replaceBuffer(buf_, inst.data(), count_ * sizeof(Inst));
}
void ImpostorBatch::init(gfx::Device& d, uint32_t capacity) {
  capacity_ = std::max(1u, capacity);
  const float q[8] = {-1, 0, 1, 0, 1, 1, -1, 1};
  const uint16_t ix[6] = {0, 1, 2, 0, 2, 3};
  quad_ = d.createBuffer(gfx::BufferUsage::Vertex, q, sizeof q);
  idx_ = d.createBuffer(gfx::BufferUsage::Index, ix, sizeof ix);
  buf_ = d.createBuffer(gfx::BufferUsage::Vertex, nullptr, sizeof(Inst) * capacity_, true);
  vi_ = d.createVertexInput({{0, 0, 2, gfx::AttribType::Float, false, 0, 8}, {1, 1, 4, gfx::AttribType::Float, false, 0, 32, true},
                             {2, 1, 4, gfx::AttribType::Float, false, 16, 32, true}}, {quad_, buf_}, idx_);
}
void ImpostorBatch::upload(gfx::Device& d, const std::vector<Inst>& inst) {
  count_ = uint32_t(std::min<size_t>(inst.size(), capacity_));
  if (count_) d.replaceBuffer(buf_, inst.data(), count_ * sizeof(Inst));
}

// ---------------------------------------------------------------- set-up
gfx::Program Renderer::build(const char* name, const char* defines, const char* vs, const char* fs, bool lit, const char* extra) {
  char head[512];
  std::snprintf(head, sizeof head, "#version 410 core\n%s\n%s%s#define SL_MAX_LIGHTS %d\n#define SL_FX %d\n#define SL_CASCADES %d\n#define TERRAIN_DETAIL %d\n",
                defines, set_.lowShaders ? "#define SL_LOW 1\n" : "", set_.msaa > 1 ? "#define SL_A2C 1\n" : "", set_.lowShaders ? 4 : 16, set_.fx, std::max(1, nCasc_), set_.terrainDetail);
  std::string h = std::string(head) + shaders::kCommon;
  std::string fsrc = h + (lit ? shaders::kLighting : "") + (extra ? extra : "") + fs;
  gfx::Program p = dev_->createProgram(name, h + vs, fsrc);
  if (p) {
    dev_->useProgram(p);
    dev_->setUniformBlock("Frame", 0);
    dev_->setUniformBlock("Lights", 1);
    dev_->setInt("uBase", U_BASE); dev_->setInt("uMR", U_MR); dev_->setInt("uNormalMap", U_NORMAL); dev_->setInt("uNoise", U_NOISE);
    dev_->setInt("uEmissiveMap", U_EMISSIVE); dev_->setInt("uShadowMap", U_SHADOW); dev_->setInt("uEnvMap", U_ENV);
    dev_->setInt("uTrailMap", U_TRAIL); dev_->setInt("uDetail", U_DETAIL); dev_->setInt("uSnowTex", U_SNOW); dev_->setInt("uRockTex", U_ROCK);
    dev_->setInt("uSkyNoise", U_SKYNOISE); dev_->setInt("uDepth", U_DEPTH); dev_->setInt("uBloom", U_BLOOM); dev_->setInt("uAO", U_AO);
    dev_->setInt("uHdr", 0); dev_->setInt("uSrc", 0);
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

// sky.js makeSkyNoise: tileable value-noise fbm (R, G independent, B ridged) for cirrus, the overcast deck, clouds
void Renderer::makeSkyNoise() {
  const int S = 128, U = 4, OCT = 5;
  auto lattice = [](int seed, int n) {
    std::vector<float> g(size_t(n) * n);
    double x = seed * 7919.0 + 104729.0;
    for (auto& v : g) { x = std::fmod(x * 48271.0, 2147483647.0); v = float(std::fmod(x, 100000.0) / 100000.0); }
    return g;
  };
  auto sample = [](const std::vector<float>& g, int n, double x, double y) {
    int xi = int(std::floor(x)), yi = int(std::floor(y));
    double fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    auto at = [&](int i, int j) { return g[size_t(((j % n) + n) % n * n + ((i % n) + n) % n)]; };
    double a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  std::vector<std::vector<float>> layers[3];
  const int seeds[3] = {1, 40, 80};
  for (int ch = 0; ch < 3; ch++) for (int o = 0; o < OCT; o++) layers[ch].push_back(lattice(seeds[ch] + o, U << o));
  std::vector<uint8_t> px(size_t(S) * S * 4);
  for (int j = 0; j < S; j++) for (int i = 0; i < S; i++) {
    double x = double(i) / S * U, y = double(j) / S * U;
    size_t o4 = (size_t(j) * S + i) * 4;
    for (int ch = 0; ch < 3; ch++) {
      double s = 0, amp = 0.5, norm = 0;
      for (int o = 0; o < OCT; o++) {
        double v = sample(layers[ch][size_t(o)], U << o, x * (1 << o), y * (1 << o));
        if (ch == 2) v = 1 - std::fabs(v * 2 - 1);
        s += amp * v; norm += amp; amp *= 0.5;
      }
      px[o4 + size_t(ch)] = uint8_t(std::lround(s / norm * 255));
    }
    px[o4 + 3] = 255;
  }
  gfx::TextureDesc d;
  d.width = d.height = S;
  d.anisotropy = 4;
  skyNoise_ = dev_->createTexture(d, px.data());
}

// meshylook.js makeDetailTexture: tileable grain (RG slope, B roughness variation)
void Renderer::makeDetailTexture() {
  const int N = 256;
  uint32_t seed = 0x9e3779b9u;
  auto rnd = [&]() {
    seed += 0x6d2b79f5u;
    uint32_t t = (seed ^ (seed >> 15)) * (1u | seed);
    t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
    return double((t ^ (t >> 14))) / 4294967296.0;
  };
  auto octave = [&](std::vector<double>& out, int period, double amp) {
    std::vector<double> lat(size_t(period) * period);
    for (auto& v : lat) v = rnd();
    double cell = double(N) / period;
    for (int y = 0; y < N; y++) {
      double fy = y / cell; int y0 = int(std::floor(fy)); double ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      size_t r0 = size_t(y0 % period) * period, r1 = size_t((y0 + 1) % period) * period;
      for (int x = 0; x < N; x++) {
        double fx = x / cell; int x0 = int(std::floor(fx)); double tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        size_t c0 = size_t(x0 % period), c1 = size_t((x0 + 1) % period);
        double a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        double b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[size_t(y) * N + x] += (a + (b - a) * sy) * amp;
      }
    }
  };
  std::vector<double> h(size_t(N) * N, 0), r(size_t(N) * N, 0);
  octave(h, 4, 0.35); octave(h, 16, 0.3); octave(h, 64, 0.22); octave(h, 128, 0.13);
  octave(r, 8, 0.5); octave(r, 32, 0.3); octave(r, 128, 0.2);
  std::vector<double> gx(size_t(N) * N), gy(size_t(N) * N);
  double rms = 0, rMin = 1e9, rMax = -1e9;
  for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) {
    size_t i = size_t(y) * N + x;
    gx[i] = h[size_t(y) * N + (x + 1) % N] - h[size_t(y) * N + (x + N - 1) % N];
    gy[i] = h[size_t((y + 1) % N) * N + x] - h[size_t((y + N - 1) % N) * N + x];
    rms += gx[i] * gx[i] + gy[i] * gy[i];
    rMin = std::min(rMin, r[i]); rMax = std::max(rMax, r[i]);
  }
  double k = 0.35 / std::sqrt(rms / (2.0 * N * N) + 1e-12);
  std::vector<uint8_t> d(size_t(N) * N * 4);
  for (size_t i = 0; i < size_t(N) * N; i++) {
    d[i * 4] = uint8_t(std::lround(std::clamp(0.5 + 0.5 * gx[i] * k, 0.0, 1.0) * 255));
    d[i * 4 + 1] = uint8_t(std::lround(std::clamp(0.5 + 0.5 * gy[i] * k, 0.0, 1.0) * 255));
    d[i * 4 + 2] = uint8_t(std::lround((r[i] - rMin) / std::max(1e-9, rMax - rMin) * 255));
    d[i * 4 + 3] = 255;
  }
  gfx::TextureDesc td;
  td.width = td.height = N;
  td.anisotropy = 8;
  detail_ = dev_->createTexture(td, d.data());
}

// the 2048 px snow / rock detail maps, baked on the GPU once (periodic noise, mip-mapped, maximum anisotropy)
void Renderer::bakeTextures() {
  int S = set_.detailTex;
  if (S <= 0) { snowTex_ = rockTex_ = flatN_; return; }
  auto bake = [&](const char* name, const char* fs, gfx::RenderTarget& rt, gfx::Texture& tex) {
    gfx::Program p = build(name, "", shaders::kFullscreenVS, fs, false, shaders::kBakeCommon);
    if (!p) { tex = flatN_; return; }
    rt = dev_->createRenderTarget(S, S, true, gfx::TexFormat::RGBA8, false, gfx::TexFormat::Depth24);
    dev_->bindRenderTarget(rt, S, S);
    gfx::PipelineState ps;
    ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None;
    dev_->setPipeline(ps);
    dev_->useProgram(p);
    dev_->setFloat("uSize", float(S));
    dev_->draw(emptyVi_, 3);
    tex = dev_->renderTargetColor(rt);
    dev_->generateMipmaps(tex);
    dev_->setSampling(tex, gfx::Filter::Trilinear, gfx::Wrap::Repeat, float(dev_->info().maxAnisotropy));
    dev_->destroy(p);
  };
  bake("bake_snow", shaders::kBakeSnowFS, snowRT_, snowTex_);
  bake("bake_rock", shaders::kBakeRockFS, rockRT_, rockTex_);
  dev_->bindRenderTarget({}, w_, h_);
}

bool Renderer::init(gfx::Device& dev, const RenderSettings& s) {
  dev_ = &dev;
  set_ = s;
  // (dev: SKI_LEGACY_GFX=noao,noshafts,noclouds,nomsaa,nofxaa,nobloom,notrails,nodetail,cascades=N,fx=N switches the
  // look's parts off for profiling / comparisons)
  if (const char* g = std::getenv("SKI_LEGACY_GFX")) {
    std::string o = g;
    auto has = [&](const char* k) { return o.find(k) != std::string::npos; };
    if (has("noao")) set_.ao = 0;
    if (has("noshafts")) set_.shafts = false;
    if (has("nomsaa")) set_.msaa = 1;
    if (has("nofxaa")) { set_.fxaa = false; set_.sharpen = 0; }
    if (has("notrails")) set_.trailSize = 0;
    if (has("nodetail")) set_.detailTex = 0;
    if (has("noclouds")) noClouds_ = true;
    if (has("nobloom")) bloomOn = false;
    if (auto p = o.find("cascades="); p != std::string::npos) set_.cascades = std::atoi(o.c_str() + p + 9);
    if (auto p = o.find("fx="); p != std::string::npos) set_.fx = std::atoi(o.c_str() + p + 3);
  }
  set_.cascades = std::clamp(set_.cascades, 1, 4);
  nCasc_ = set_.cascades;
  set_.msaa = std::clamp(set_.msaa, 1, std::max(1, dev.info().maxSamples));
  set_.fx = std::clamp(set_.fx, 0, 4);
  if (set_.lowShaders) { set_.ao = 0; set_.shafts = false; }
  set_.maxLights = std::clamp(set_.maxLights, 0, 16);
  emptyVi_ = dev.createVertexInput({}, {}, {});
  mesh_ = build("mesh", "", shaders::kMeshVS, shaders::kMeshFS, true);
  meshSkin_ = build("mesh_skinned", "#define SKINNED 1", shaders::kMeshVS, shaders::kMeshFS, true);
  meshInst_ = build("mesh_instanced", "#define INSTANCED 1", shaders::kMeshVS, shaders::kMeshFS, true);
  meshInstM_ = build("mesh_instmat", "#define INSTMAT 1", shaders::kMeshVS, shaders::kMeshFS, true);
  depthInstM_ = build("depth_instmat", "#define INSTMAT 1", shaders::kMeshVS, shaders::kDepthFS, false);
  terrain_ = build("terrain", "", shaders::kTerrainVS, shaders::kTerrainFS, true);
  depthMesh_ = build("depth_mesh", "", shaders::kMeshVS, shaders::kDepthFS, false);
  depthSkin_ = build("depth_skinned", "#define SKINNED 1", shaders::kMeshVS, shaders::kDepthFS, false);
  depthInst_ = build("depth_instanced", "#define INSTANCED 1", shaders::kMeshVS, shaders::kDepthFS, false);
  depthTerrain_ = build("depth_terrain", "", shaders::kTerrainVS, shaders::kDepthTerrainFS, false);
  sky_ = build("sky", "", shaders::kFullscreenVS, shaders::kSkyFS, true, shaders::kSkyCommon);
  env_p_ = build("env", "", shaders::kFullscreenVS, shaders::kEnvFS, false);
  hud_ = build("hud", "", shaders::kHudVS, shaders::kHudFS, false);
  bloomDown_ = build("bloom_down", "", shaders::kFullscreenVS, shaders::kBloomDownFS, false);
  bloomUp_ = build("bloom_up", "", shaders::kFullscreenVS, shaders::kBloomUpFS, false);
  ao_ = build("gtao", "", shaders::kFullscreenVS, shaders::kAoFS, false, shaders::kDepthCommon);
  aoBlur_ = build("gtao_blur", "", shaders::kFullscreenVS, shaders::kAoBlurFS, false);
  final_ = build("final", "", shaders::kFullscreenVS, shaders::kFinalFS, false);
  fxaa_ = build("fxaa", "", shaders::kFullscreenVS, shaders::kFxaaFS, false);
  stamp_ = build("trail_stamp", "", shaders::kStampVS, shaders::kStampFS, false);
  trailFade_ = build("trail_fade", "", shaders::kFullscreenVS, shaders::kTrailFadeFS, false);
  particle_ = build("particles", "", shaders::kParticleVS, shaders::kParticleFS, true);
  impostor_ = build("impostors", "", shaders::kImpostorVS, shaders::kImpostorFS, true);
  clouds_ = set_.fx >= 2 && !set_.lowShaders ? build("clouds", "", shaders::kFullscreenVS, shaders::kCloudFS, true, shaders::kSkyCommon) : gfx::Program{};
  glare_ = set_.fx >= 2 ? build("sun_glare", "", shaders::kGlareVS, shaders::kGlareFS, false) : gfx::Program{};
  {   // sunglare.js makeRays: 8 long primaries, 8 short secondaries, 16 fine streaks, jittered
    const float LEN[3][2] = {{0.12f, 0.2f}, {0.06f, 0.1f}, {0.08f, 0.18f}}, WID[3][2] = {{0.016f, 0.024f}, {0.013f, 0.018f}, {0.0045f, 0.0065f}};
    const float INT[3][2] = {{1.4f, 2.0f}, {1.0f, 1.3f}, {0.35f, 0.55f}};
    const int TIER[4] = {0, 2, 1, 2};
    double seed = 11;
    auto rnd = [&]() { seed = std::fmod(seed * 16807, 2147483647.0); return float(seed / 2147483647.0); };
    const float SP = float(2 * PI / 32);
    for (int i = 0; i < 32; i++) {
      int t = TIER[i % 4];
      float a = 0.3f + i * SP + (rnd() - 0.5f) * SP * 0.5f;
      float len = LEN[t][0] + rnd() * (LEN[t][1] - LEN[t][0]), wid = WID[t][0] + rnd() * (WID[t][1] - WID[t][0]);
      rays_[i] = vec4(std::cos(a), std::sin(a), len, wid);
      rayI_[i] = INT[t][0] + rnd() * (INT[t][1] - INT[t][0]);
    }
  }
  if (!mesh_ || !meshSkin_ || !meshInst_ || !meshInstM_ || !depthInstM_ || !terrain_ || !depthMesh_ || !depthSkin_ || !depthInst_ ||
      !depthTerrain_ || !sky_ || !env_p_ || !hud_ || !bloomDown_ || !bloomUp_ || !ao_ || !aoBlur_ || !final_ || !fxaa_ || !stamp_ ||
      !trailFade_ || !particle_ || !impostor_) return false;
  lightsUbo_ = dev.createBuffer(gfx::BufferUsage::Uniform, nullptr, 16 + 48 * 16, true);
  frameUbo_ = dev.createBuffer(gfx::BufferUsage::Uniform, nullptr, 4096, true);
  for (auto& b : shadowUbo_) b = dev.createBuffer(gfx::BufferUsage::Uniform, nullptr, 4096, true);
  hudVbo_ = dev.createBuffer(gfx::BufferUsage::Vertex, nullptr, 1 << 16, true);
  hudVi_ = dev.createVertexInput({{0, 0, 2, gfx::AttribType::Float, false, 0, 24}, {1, 0, 4, gfx::AttribType::Float, false, 8, 24}}, {hudVbo_}, {});
  // the shadow atlas: cascades in a 2 x 2 (or 2 x 1) grid
  int cols = nCasc_ > 1 ? 2 : 1, rows = nCasc_ > 2 ? 2 : 1;
  int S = std::min(set_.shadowSize, dev.info().maxTextureSize / cols);
  set_.shadowSize = S;
  atlasW_ = S * cols; atlasH_ = S * rows;
  shadow_ = dev.createRenderTarget(atlasW_, atlasH_, false, gfx::TexFormat::RGBA8, true, gfx::TexFormat::Depth24, true);
  for (int c = 0; c < 4; c++) casc_[c].rect = vec4(float(c % cols) / cols, float(c / cols) / rows, 1.f / cols, 1.f / rows);
  uint8_t w[16] = {255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255};
  uint8_t fl[16] = {128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255}, bk[16] = {0};
  // (the stand-ins sample like the models' own maps: one sampler state, fewer shader variants on software GL)
  gfx::TextureDesc td; td.width = td.height = 2; td.mipmaps = true; td.filter = gfx::Filter::Trilinear; td.anisotropy = 8;
  white_ = dev.createTexture(td, w);
  flatN_ = dev.createTexture(td, fl);
  blackTex_ = dev.createTexture(td, bk);
  makeNoiseTexture();
  makeSkyNoise();
  makeDetailTexture();
  bakeTextures();
  // the environment map (equirectangular, mips = roughness)
  int E = std::max(32, set_.envSize);
  env_ = dev.createRenderTarget(E, E / 2, true, gfx::TexFormat::RGBA16F, false, gfx::TexFormat::Depth24);
  // the trail map
  if (set_.trailSize > 0) {
    trail_ = dev.createRenderTarget(set_.trailSize, set_.trailSize, true, gfx::TexFormat::RGBA16F, false, gfx::TexFormat::Depth24);
    dev.setSampling(dev.renderTargetColor(trail_), gfx::Filter::Linear, gfx::Wrap::Repeat, 1);
    dev.bindRenderTarget(trail_, set_.trailSize, set_.trailSize);
    dev.clear(0, 0, 0, 0, true, false);
    const float q[8] = {-1, -1, 1, -1, 1, 1, -1, 1};
    const uint16_t ix[6] = {0, 1, 2, 0, 2, 3};
    stampQuad_ = dev.createBuffer(gfx::BufferUsage::Vertex, q, sizeof q);
    stampIdx_ = dev.createBuffer(gfx::BufferUsage::Index, ix, sizeof ix);
    stampVbo_ = dev.createBuffer(gfx::BufferUsage::Vertex, nullptr, 48 * 1024, true);
    stampVi_ = dev.createVertexInput({{0, 0, 2, gfx::AttribType::Float, false, 0, 8}, {1, 1, 4, gfx::AttribType::Float, false, 0, 48, true},
                                      {2, 1, 4, gfx::AttribType::Float, false, 16, 48, true}, {3, 1, 4, gfx::AttribType::Float, false, 32, 48, true}},
                                     {stampQuad_, stampVbo_}, stampIdx_);
  } else trail_ = {};
  {
    const float q[8] = {-1, -1, 1, -1, 1, 1, -1, 1};
    const uint16_t ix[6] = {0, 1, 2, 0, 2, 3};
    if (!stampQuad_) { stampQuad_ = dev.createBuffer(gfx::BufferUsage::Vertex, q, sizeof q); stampIdx_ = dev.createBuffer(gfx::BufferUsage::Index, ix, sizeof ix); }
    partVbo_ = dev.createBuffer(gfx::BufferUsage::Vertex, nullptr, 48 * 4096, true);
    partVi_ = dev.createVertexInput({{0, 0, 2, gfx::AttribType::Float, false, 0, 8}, {1, 1, 4, gfx::AttribType::Float, false, 0, 48, true},
                                     {2, 1, 4, gfx::AttribType::Float, false, 16, 48, true}, {3, 1, 4, gfx::AttribType::Float, false, 32, 48, true}},
                                    {stampQuad_, partVbo_}, stampIdx_);
  }
  SL_INFO("renderer: fx %d, %d shadow cascade(s) of %d px (atlas %dx%d) to %.0f m, MSAA %dx, AO %d, shafts %s, %s, detail maps %d px, trail map %d px over %.0f m",
          set_.fx, nCasc_, S, atlasW_, atlasH_, double(set_.shadowRange), set_.msaa, set_.ao, set_.shafts ? "on" : "off",
          set_.toneMap == 1 ? "PBR Neutral" : "ACES", set_.detailTex, set_.trailSize, double(set_.trailRange));
  return true;
}

void Renderer::resize(int w, int h) {
  w_ = std::max(1, w); h_ = std::max(1, h);
  int rw = std::max(1, int(w_ * set_.renderScale)), rh = std::max(1, int(h_ * set_.renderScale));
  if (hdr_ && rw == rw_ && rh == rh_ && ldr_) return;
  if (hdr_) dev_->destroy(hdr_);
  if (msaa_) dev_->destroy(msaa_);
  if (depthCopy_) dev_->destroy(depthCopy_);
  if (ldr_) dev_->destroy(ldr_);
  rw_ = rw; rh_ = rh;
  hdr_ = dev_->createRenderTarget(rw_, rh_, true, gfx::TexFormat::RGBA16F, true, gfx::TexFormat::Depth24);
  depthCopy_ = dev_->createRenderTarget(rw_, rh_, false, gfx::TexFormat::RGBA8, true, gfx::TexFormat::Depth24);
  dev_->setSampling(dev_->renderTargetDepth(depthCopy_), gfx::Filter::Nearest, gfx::Wrap::Clamp, 1);
  // (post.js msaaFor: the 8x presets fall back to 4x past ~6 MP: the extra samples cost a lot there for little)
  int samples = set_.msaa > 4 && double(rw_) * rh_ > 6.2e6 ? 4 : set_.msaa;
  msaa_ = samples > 1 ? dev_->createRenderTargetMS(rw_, rh_, samples, gfx::TexFormat::RGBA16F, gfx::TexFormat::Depth24) : gfx::RenderTarget{};
  ldr_ = dev_->createRenderTarget(w_, h_, true, gfx::TexFormat::RGBA8, false, gfx::TexFormat::Depth24);
  // the bloom chain from half resolution down to ~8 px
  for (auto& b : bloom_) dev_->destroy(b);
  bloom_.clear(); bloomSize_.clear();
  int bw = std::max(1, rw_ / 2), bh = std::max(1, rh_ / 2);
  for (int i = 0; i < 7 && bw >= 8 && bh >= 8; i++) {
    bloom_.push_back(dev_->createRenderTarget(bw, bh, true, gfx::TexFormat::RGBA16F, false, gfx::TexFormat::Depth24));
    bloomSize_.push_back({bw, bh});
    bw /= 2; bh /= 2;
  }
  if (aoRaw_) { dev_->destroy(aoRaw_); dev_->destroy(aoTex_); aoRaw_ = aoTex_ = {}; }
  if (set_.ao > 0 || set_.shafts) {
    float k = set_.ao >= 2 ? 1.f : 0.5f;
    aw_ = std::max(1, int(rw_ * k)); ah_ = std::max(1, int(rh_ * k));
    aoRaw_ = dev_->createRenderTarget(aw_, ah_, true, gfx::TexFormat::RGBA16F, false, gfx::TexFormat::Depth24);
    aoTex_ = dev_->createRenderTarget(aw_, ah_, true, gfx::TexFormat::RGBA16F, false, gfx::TexFormat::Depth24);
    dev_->setSampling(dev_->renderTargetColor(aoRaw_), gfx::Filter::Nearest, gfx::Wrap::Clamp, 1);
  }
}

// the frame's lights: the strongest near the camera (and in view) first, up to maxLights
void Renderer::uploadLights() {
  struct Cand { float score; const PointLight* l; };
  std::vector<Cand> c;
  c.reserve(lights_.size());
  for (const PointLight& l : lights_) {
    float d = float(glm::length(l.pos - cam_.pos));
    if (d > l.range + 400) continue;
    dvec3 e(l.range);
    if (!visible(l.pos - e, l.pos + e)) continue;
    float lum = l.color.x * 0.3f + l.color.y * 0.6f + l.color.z * 0.1f;
    c.push_back({lum * l.range / (d + l.range * 0.5f + 1), &l});
  }
  std::sort(c.begin(), c.end(), [](const Cand& a, const Cand& b) { return a.score > b.score; });
  int n = std::min<int>(int(c.size()), set_.maxLights);
  std::vector<vec4> buf(1 + 48, vec4(0));
  buf[0] = vec4(float(n), 0, 0, 0);
  for (int i = 0; i < n; i++) {
    const PointLight& l = *c[size_t(i)].l;
    buf[size_t(1 + i * 3)] = vec4(vec3(l.pos - cam_.pos), l.range);
    buf[size_t(2 + i * 3)] = vec4(l.color, l.cosOuter);
    buf[size_t(3 + i * 3)] = vec4(glm::normalize(l.dir + vec3(0, 1e-6f, 0)), l.cosInner);
  }
  dev_->updateBuffer(lightsUbo_, buf.data(), buf.size() * sizeof(vec4));
  lightsUsed_ = n;
}

// ---------------------------------------------------------------- the sky model (sky.js Environment.update)
struct FrameBlock {
  mat4 viewProj, view, proj, shadowMat[4];
  vec4 cascadeEnd, cascadeTexel, cascadeRect[4];
  vec4 camPos, camFwd, sunDir, sunColor, hemiSky, hemiGround, fogColor, fogParams;
  vec4 skyZenith, skyMid, skyHorizon, skyGlow, skyHalo, skyHaloBroad, skyDisc, skyBelt, moonGlow, skyWisp, moonDir, trueSun;
  vec4 sh[9];
  vec4 misc, misc2, trail, screen, envGround, cloud;
};

namespace {
const double KEYS[7] = {-0.35, -0.16, -0.05, 0.02, 0.10, 0.24, 0.45};
const vec3 HALO[7] = {{0, 0, 0}, {0, 0, 0}, {0.5f, 0.12f, 0.03f}, {3.0f, 1.0f, 0.25f}, {2.6f, 1.6f, 0.7f}, {1.2f, 1.6f, 2.4f}, {0.15f, 1.3f, 5.2f}};
const vec3 DISC[7] = {{1, 0.3f, 0.1f}, {1, 0.3f, 0.1f}, {1, 0.32f, 0.1f}, {1.0f, 0.42f, 0.14f}, {1.0f, 0.7f, 0.42f}, {1.0f, 0.9f, 0.76f}, {1.0f, 0.97f, 0.93f}};
const vec3 AMB[7] = {{0.10f, 0.14f, 0.28f}, {0.18f, 0.22f, 0.45f}, {0.42f, 0.36f, 0.62f}, {0.52f, 0.48f, 0.78f}, {0.46f, 0.56f, 0.92f}, {0.40f, 0.58f, 1.0f}, {0.38f, 0.58f, 1.0f}};
const float ENVI[7] = {0.6f, 0.8f, 0.9f, 0.95f, 1.0f, 1.0f, 1.0f};
const vec3 OVER_HOR{0.700f, 0.820f, 0.990f}, WARM_TINT{1.25f, 0.95f, 0.78f};
double sstep(double a, double b, double x) { double t = std::clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3 - 2 * t); }
float lum(const vec3& c) { return c.x * 0.2126f + c.y * 0.7152f + c.z * 0.0722f; }
vec3 desat(const vec3& c, float s) { float l = lum(c); return vec3(l) + (c - vec3(l)) * s; }
float fsat(float x) { return std::clamp(x, 0.f, 1.f); }
float fsmooth(float a, float b, float x) { float t = fsat((x - a) / (b - a)); return t * t * (3 - 2 * t); }
// (native) the sky as a light source. sky.js lit the world with the palette's own colours (desaturated to 70 %), but
// the palette is graded for display: in linear light the cobalt zenith is ~7x bluer than red (the IBL's zenith
// (0.23, 0.60, 1.66)), so as the only light in the shade it turned shaded snow saturated blue, dark wood navy, and
// ACES skewed the rest toward purple. A clear sky lights like ~11000 K daylight: the palette's brightness with a
// light, unsaturated blue (luminance 1), toward a near-neutral grey under an overcast; the sun / glow keep their hue.
const vec3 SKY_LIGHT{0.86f, 1.015f, 1.266f}, SKY_LIGHT_HOR{0.92f, 1.01f, 1.12f}, OVERCAST_LIGHT{0.97f, 1.0f, 1.05f};
vec3 skyLight(const vec3& c, const vec3& tint, float overcast) { return glm::mix(tint, OVERCAST_LIGHT, overcast) * lum(c); }
} // namespace

void Renderer::computeSky(const Lighting& L, FrameBlock& fb) {
  vec3 sun = glm::length(L.trueSun) > 0.5f ? glm::normalize(L.trueSun) : glm::normalize(L.sunDir);
  double h = sun.y;
  int i = 0;
  while (i < 5 && h > KEYS[i + 1]) i++;
  float f = float(sstep(KEYS[i], KEYS[i + 1], h));
  auto pal = [&](const vec3* a) { return glm::mix(a[i], a[i + 1], f); };
  float overcast = std::clamp(L.overcast, 0.f, 1.f), clearSky = 1 - overcast;
  float dayF = float(sstep(-0.08, 0.12, h)), nightF = float(1 - sstep(-0.18, 0.02, h));
  float lightLevel = float(0.035 + (1 - 0.035) * sstep(-0.2, 0.3, h));
  float warmO = float(sstep(-0.12, 0.02, h) * (1 - sstep(0.05, 0.3, h)));
  vec3 grey = glm::mix(vec3(1), WARM_TINT, warmO * 0.6f) * (lightLevel * (1 - 0.18f * L.snow));
  float dusk = float(sstep(-0.12, 0.0, h) * (1 - sstep(0.04, 0.25, h)));
  float discVis = float(sstep(-0.03, 0.02, h)) * clearSky * clearSky * clearSky;
  float sunVisible = float(sstep(-0.02, 0.03, h)) * std::pow(clearSky, 1.5f) * (1 - std::min(1.f, L.mist + L.frost * 0.3f) * 0.6f);
  bool useMoon = glm::dot(glm::normalize(L.sunDir), sun) < 0.999f;
  float keyI = L.sunIntensity * L.ambientScale;
  float sc = L.interior ? 0.f : 1.f;
  fb.skyZenith = vec4(L.zenith, dusk * clearSky);
  fb.skyMid = vec4(L.mid, 16.f + (4.5f - 16.f) * overcast);
  fb.skyHorizon = vec4(L.horizon, clearSky * clearSky * (1 - nightF) * 0.9f);
  fb.skyGlow = vec4(L.glow, overcast);
  fb.skyHalo = vec4(pal(HALO) * (clearSky * clearSky), set_.fx >= 2 ? clearSky * float(sstep(0.1, 0.0, h) * (1 - sstep(-0.06, -0.16, h))) : 0.f);
  fb.skyHaloBroad = vec4(OVER_HOR * grey * (0.45f * overcast * float(sstep(-0.02, 0.1, h))), set_.fx >= 2 ? clearSky * float(sstep(0.02, 0.25, h)) : 0.f);
  fb.skyDisc = vec4(pal(DISC) * (float(30 + 40 * sstep(0.0, 0.3, h)) * discVis), 1.f);
  fb.skyBelt = vec4(vec3(1.0f, 0.6f, 0.66f) * (lum(L.horizon) * 0.45f), nightF * (1 - overcast));
  vec3 md = glm::length(L.moonDir) > 0.5f ? glm::normalize(L.moonDir) : vec3(0, -1, 0);
  fb.moonGlow = vec4(vec3(0.05f, 0.075f, 0.13f) * (nightF * (1 - overcast * 0.85f) * float(sstep(-0.1, 0.15, md.y))), nightF * (1 - overcast * 0.9f));
  float cover = set_.fx >= 1 && !noClouds_ ? std::clamp(0.17f + L.cloud * 0.72f + L.snow * 0.1f, 0.f, 0.92f) * (1 - L.clearAir * 0.8f) : 0.f;
  fb.skyWisp = vec4(glm::mix(L.horizon, L.glow, 0.35f) * 0.55f + vec3(0.35f * dayF), cover * sc);
  fb.moonDir = vec4(md, nightF);
  fb.trueSun = vec4(sun, dayF * sunVisible);
  // the key light and the ambient: three's HemisphereLight + the IBL (envI) as sky.js sets them
  vec3 hemiC = skyLight(glm::mix(pal(AMB), vec3(0.62f, 0.68f, 0.78f) * (0.15f + 0.85f * dayF), overcast * 0.7f), SKY_LIGHT, overcast);
  vec3 hemiG = glm::mix(hemiC, vec3(0.75f, 0.78f, 0.85f), 0.5f) * 0.6f;
  float hemiI = (0.04f + 0.08f * dayF) * (1 + 1.6f * overcast) * L.ambientScale;
  float envI = (ENVI[i] + (ENVI[i + 1] - ENVI[i]) * f) * (1 + 0.12f * overcast) * L.ambientScale * sc;
  if (L.interior) {
    fb.hemiSky = vec4(L.sky * float(PI), 0);
    fb.hemiGround = vec4(L.ground * float(PI), 1);
  } else {
    fb.hemiSky = vec4(hemiC * hemiI, envI);
    fb.hemiGround = vec4(hemiG * hemiI, std::max(0.05f, sunVisible));
  }
  vec3 key = L.sunColor * keyI;
  envZenith_ = skyLight(glm::mix(L.zenith, L.mid, 0.8f), SKY_LIGHT, overcast) * 1.8f;
  envHorizon_ = skyLight(glm::mix(L.horizon, L.mid, 0.3f), SKY_LIGHT_HOR, overcast) * 0.35f;
  // the ground below: sunlit snow (albedo ~0.85, most of the ground round you) and the sky it reflects. sky.js took
  // 30-40 % of it: the walls, eaves and cars in the shade then saw mostly blue sky; the bright warm-white bounce off
  // the snowfield is what keeps shaded facades neutral in a real snowy valley (the same on every preset)
  float bounce = keyI * std::max(glm::normalize(L.sunDir).y, 0.f) * 0.85f / float(PI);
  vec3 envGround = L.sunColor * (bounce * 0.75f) + envZenith_ * 0.25f;
  envSun_ = useMoon ? vec3(0) : L.sunColor * (keyI * 0.05f);
  envGlow_ = set_.fx >= 1 ? L.glow * (clearSky * (0.08f + 0.45f * dusk) * dayF) : vec3(0);
  fb.envGround = vec4(envGround, L.mist);
  sunCol_ = key;
  {
    float low = 1.f - float(sstep(0.1, 0.5, h));
    glareCore_ = L.interior ? vec3(0) : pal(DISC) * (sunVisible * (0.45f + 0.55f * low) * float(sstep(-0.02, 0.03, h)));
  }
  // irradiance of the environment as L2 spherical harmonics (the same function the env map draws)
  vec4 sh[9];
  for (auto& s : sh) s = vec4(0);
  if (envI > 0) {
    const int NU = 32, NV = 16;
    double wsum = 0;
    for (int v = 0; v < NV; v++) {
      double th = (v + 0.5) / NV * PI, st = std::sin(th);
      for (int u = 0; u < NU; u++) {
        double ph = (u + 0.5) / NU * 2 * PI;
        vec3 d(float(st * std::sin(ph)), float(std::cos(th)), float(-st * std::cos(ph)));
        float e = d.y;
        vec3 col = glm::mix(envHorizon_, envZenith_, fsmooth(0.f, 0.65f, e));
        vec2 dh = glm::normalize(vec2(d.x, d.z) + vec2(1e-6f)), shd = glm::normalize(vec2(sun.x, sun.z) + vec2(1e-6f));
        float az = glm::dot(dh, shd) * 0.5f + 0.5f;
        col += envGlow_ * (az * az * az) * std::exp(-std::max(e, 0.f) * 6.f);
        col = glm::mix(col, envGround, fsmooth(0.03f, -0.2f, e));
        float c = std::max(glm::dot(d, sun), 0.f);
        col += envSun_ * (c * c * c * 0.35f + std::pow(c, 24.f) * 0.8f);
        float w = float(st);
        wsum += w;
        float Y[9] = {0.282095f, 0.488603f * d.y, 0.488603f * d.z, 0.488603f * d.x, 1.092548f * d.x * d.y, 1.092548f * d.y * d.z,
                      0.315392f * (3 * d.z * d.z - 1), 1.092548f * d.x * d.z, 0.546274f * (d.x * d.x - d.y * d.y)};
        for (int k = 0; k < 9; k++) sh[k] += vec4(col * (Y[k] * w), 0);
      }
    }
    float norm = float(4 * PI / wsum);
    for (int k = 0; k < 9; k++) fb.sh[k] = sh[k] * norm;
  } else for (int k = 0; k < 9; k++) fb.sh[k] = vec4(0);
}

// ---------------------------------------------------------------- shadows: cascades fitted to the view
void Renderer::fitCascades(const dvec3& focus) {
  vec3 ld = glm::normalize(light_.sunDir);
  vec3 upv = std::fabs(ld.y) > 0.99f ? vec3(0, 0, 1) : vec3(0, 1, 0);
  vec3 lx = glm::normalize(glm::cross(upv, ld)), ly = glm::cross(ld, lx);
  int S = set_.shadowSize;
  // night: the moon's shadows only matter close by (sky.js halves the frustum)
  float range = set_.shadowRange * (1.f - 0.4f * light_.night);
  auto place = [&](Cascade& c, const dvec3& centerW, double R) {
    double texel = 2 * R / S;
    double fx = glm::dot(dvec3(lx), centerW), fy = glm::dot(dvec3(ly), centerW), fz = glm::dot(dvec3(ld), centerW);
    fx = std::floor(fx / texel) * texel; fy = std::floor(fy / texel) * texel;
    dvec3 cw = dvec3(lx) * fx + dvec3(ly) * fy + dvec3(ld) * fz;
    vec3 center = vec3(cw - cam_.pos);
    float back = float(R) + 2500.f;
    mat4 lview = glm::lookAt(center + ld * back, center, upv);
    mat4 lproj = glm::ortho(float(-R), float(R), float(-R), float(R), 0.5f, back + float(R) + 300.f);
    c.view = lview;
    c.viewProj = lproj * lview;
    c.radius = float(R);
    c.texel = float(texel);
  };
  if (nCasc_ == 1) {
    place(casc_[0], focus, range);
    casc_[0].end = range * 1.15f;
    return;
  }
  float tx = std::tan(glm::radians(cam_.fovY) * 0.5f) * cam_.aspect, ty = std::tan(glm::radians(cam_.fovY) * 0.5f);
  float k2 = tx * tx + ty * ty;
  float n = cam_.nearZ, lambda = 0.82f;
  float prev = n;
  vec3 fwd = cam_.forward();
  for (int c = 0; c < nCasc_; c++) {
    float t = float(c + 1) / nCasc_;
    float fLog = n * std::pow(range / n, t), fLin = n + (range - n) * t;
    float fEnd = lambda * fLog + (1 - lambda) * fLin;
    if (c == 0) fEnd = std::max(fEnd, 9.f);
    float nn = prev, ff = fEnd;
    float cd = std::min(ff, (ff + nn) * (1 + k2) * 0.5f);
    float R = std::sqrt((ff - cd) * (ff - cd) + ff * ff * k2);
    R = std::ceil(R * 4.f) / 4.f;   // (a stable size: the texel grid never changes while turning)
    place(casc_[c], cam_.pos + dvec3(fwd) * double(cd), R);
    casc_[c].end = fEnd;
    prev = fEnd * 0.9f;
  }
}

bool Renderer::inCascade(const Item& it, int c) const {
  if (it.sphere.w < 0) {
    if (it.kind == Item::Kind::Instanced) return c <= 1;
    if (it.kind == Item::Kind::InstMat) return c == 0 || (c == 1 && nCasc_ >= 3);
    return true;
  }
  // far cascades skip the small casters (sub-texel there anyway)
  if (c >= 1 && it.kind != Item::Kind::Terrain && it.sphere.w < casc_[c].radius * 0.012f) return false;
  vec3 l = vec3(casc_[c].view * vec4(vec3(it.sphere), 1));
  float r = casc_[c].radius + it.sphere.w;
  return std::fabs(l.x) <= r && std::fabs(l.y) <= r;
}

// ---------------------------------------------------------------- frame
void Renderer::beginFrame(const Camera& cam, const Lighting& L, const dvec3& focus) {
  cam_ = cam;
  cam_.aspect = float(w_) / float(h_);
  light_ = L;
  items_.clear();
  lights_.clear();
  hudVerts_.clear();
  stamps_.clear();
  particles_.clear();
  // the clock (clouds, wind, twinkle)
  {
    double now = std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    if (lastClock_ >= 0) time_ += std::min(0.25, now - lastClock_);
    lastClock_ = now;
  }
  viewProj_ = cam_.proj() * cam_.view();
  mat4 m = glm::transpose(viewProj_);
  planes_[0] = m[3] + m[0]; planes_[1] = m[3] - m[0]; planes_[2] = m[3] + m[1];
  planes_[3] = m[3] - m[1]; planes_[4] = m[3] + m[2]; planes_[5] = m[3] - m[2];
  fitCascades(focus);

  FrameBlock fb{};
  fb.viewProj = viewProj_;
  fb.view = cam_.view();
  fb.proj = cam_.proj();
  mat4 bias = glm::translate(mat4(1), vec3(0.5f)) * glm::scale(mat4(1), vec3(0.5f));
  for (int c = 0; c < 4; c++) {
    int cc = std::min(c, nCasc_ - 1);
    const vec4& r = casc_[cc].rect;
    mat4 atlas = glm::translate(mat4(1), vec3(r.x, r.y, 0)) * glm::scale(mat4(1), vec3(r.z, r.w, 1));
    fb.shadowMat[c] = atlas * bias * casc_[cc].viewProj;
    fb.cascadeRect[c] = r;
    fb.cascadeEnd[c] = c < nCasc_ ? casc_[c].end : 0.f;
    fb.cascadeTexel[c] = casc_[cc].texel;
  }
  vec3 ld = glm::normalize(L.sunDir);
  fb.camPos = vec4(vec3(cam_.pos), float(time_));
  fb.camFwd = vec4(cam_.forward(), std::tan(glm::radians(cam_.fovY) * 0.5f));
  fb.sunDir = vec4(ld, (shadowsOn && L.sunIntensity > 0.01f) ? 1.f : 0.f);
  bool moon = glm::length(L.trueSun) > 0.5f && glm::dot(ld, glm::normalize(L.trueSun)) < 0.999f;
  fb.sunColor = vec4(L.sunColor * (L.sunIntensity * L.ambientScale), moon ? 0.f : 1.f);
  // (native) the haze as it lights the far terrain: the palette's fog (the sky below the horizon, graded for display:
  // ~10x bluer than red by day, navy at night) at 40 % of its saturation, so distance reads as a light blue-grey
  // aerial perspective and the night haze as dark grey-blue instead of tinting every far slope saturated blue
  fb.fogColor = vec4(desat(L.fog, 0.4f), 1);
  fb.fogParams = vec4(L.fogDensity, L.fogFalloff, 1.0f / float(atlasW_), L.exposure);
  computeSky(L, fb);
  fb.misc = vec4(L.night, L.snowCover, float(set_.fx), L.icy);
  fb.misc2 = vec4(1.f, float(time_) * (1.f + L.wind * 1.5f), L.snow, set_.trailSize > 0 && !L.interior ? 1.f : 0.f);
  // the trail map's window: its centre moves in steps of 1/16 of the map (the strips it leaves are cleared)
  if (set_.trailSize > 0) {
    double S = set_.trailRange, step = S / 16;
    dvec2 c(std::floor(trailFocus_.x / step + 0.5) * step, std::floor(trailFocus_.z / step + 0.5) * step);
    if (trailCenter_.x > 1e17) trailCenter_ = c;
    fb.trail = vec4(float(trailCenter_.x), float(trailCenter_.y), float(1.0 / S), float(S / set_.trailSize));
  }
  fb.screen = vec4(float(rw_), float(rh_), 1.f / float(rw_), 1.f / float(rh_));
  float wind = 1 + L.wind * 3;
  fb.cloud = vec4(2900.f, 4100.f, 7.f * wind, 2.6f * wind);
  {   // atmosphere.js: the sea of clouds' level follows the valley baseline, kept 260 m below the eye
    double bz = cam_.pos.z - 200, baseY = bz > 0 ? -0.17 * bz * sstep(0, 450, bz) : 0;
    double seaY = baseY + std::min(380.0 + L.cloud * 420 + L.mist * 220 + L.snow * 200, cam_.pos.y - baseY - 260);
    float cl = L.cloud, nearR = float((4000 + (2400 - 4000) * sstep(0.15, 0.7, cl)) * (1 - L.snow) + 1800 * L.snow);
    float cover = std::clamp(0.3f + cl * 0.35f + L.mist * 0.3f, 0.f, 0.9f) * (1 - L.clearAir);
    cloudLow_ = vec4(float(seaY - 220), float(seaY + 260), cover, nearR);
  }
  dev_->updateBuffer(frameUbo_, &fb, sizeof fb);
  for (int c = 0; c < nCasc_; c++) {
    FrameBlock sb = fb;
    sb.viewProj = casc_[c].viewProj;
    dev_->updateBuffer(shadowUbo_[c], &sb, sizeof sb);
  }
  // the sun on the screen (shafts)
  shaftsK_ = 0;
  if (set_.shafts && !L.interior) {
    vec3 s = glm::length(L.trueSun) > 0.5f ? glm::normalize(L.trueSun) : ld;
    vec4 p = viewProj_ * vec4(s * 1000.f, 1);
    if (p.w > 0.05f) {
      vec2 ndc = vec2(p) / p.w;
      sunUV_ = ndc * 0.5f + 0.5f;
      float vis = fb.trueSun.w * (1 - L.night);
      shaftsK_ = vis * (1 - fsmooth(0.9f, 1.6f, std::max(std::fabs(ndc.x), std::fabs(ndc.y)))) * (moon ? 0.f : 1.f);
    }
  }
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
  for (int c = 0; c < nCasc_; c++) {
    vec2 lo(1e30f), hi(-1e30f);
    for (int k = 0; k < 8; k++) {
      vec3 p((k & 1) ? mx.x : mn.x, (k & 2) ? mx.y : mn.y, (k & 4) ? mx.z : mn.z);
      vec3 l = vec3(casc_[c].view * vec4(p, 1));
      lo = glm::min(lo, vec2(l)); hi = glm::max(hi, vec2(l));
    }
    float R = casc_[c].radius;
    if (hi.x > -R && lo.x < R && hi.y > -R && lo.y < R) return true;
  }
  return false;
}

static vec4 boundsSphere(const mat4& M, const vec3& bmin, const vec3& bmax) {
  if (bmin.x > bmax.x) return vec4(0, 0, 0, -1);
  vec3 c = vec3(M * vec4((bmin + bmax) * 0.5f, 1));
  float s = std::max({glm::length(vec3(M[0])), glm::length(vec3(M[1])), glm::length(vec3(M[2]))});
  return vec4(c, glm::length(bmax - bmin) * 0.5f * s);
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
      const auto& SL = p.lods[size_t(std::min<int>(lod + 1, int(p.lods.size()) - 1))];
      it.sFirst = SL.first; it.sCount = SL.count;
      it.mat = &m.materials[size_t(std::max(0, p.material))];
      it.skinned = p.skinned && pose && !pose->joints.empty();
      it.joints = it.skinned ? &pose->joints : nullptr;
      it.model = it.skinned ? rel : rel * (pose && pose->global.size() == m.nodes.size() ? pose->global[i] : mat4(1));
      if (!it.skinned && !pose) {
        mat4 g(1);
        for (int k = int(i); k >= 0; k = m.nodes[size_t(k)].parent) {
          const Node& q = m.nodes[size_t(k)];
          g = glm::translate(mat4(1), q.t) * glm::mat4_cast(q.r) * glm::scale(mat4(1), q.s) * g;
        }
        it.model = rel * g;
      }
      it.sphere = it.skinned ? vec4(vec3(rel[3]), 2.5f) : boundsSphere(it.model, p.bmin, p.bmax);
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
  float height = std::max(0.1f, (m.bmax.y - m.bmin.y) * glm::length(vec3(fit[1])));
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
      it.sFirst = L.first; it.sCount = L.count;
      it.mat = &m.materials[size_t(std::max(0, p.material))];
      it.model = fit * g;
      it.shadow = castShadow;
      it.height = height;
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
      it.sFirst = L.first; it.sCount = L.count;
      it.mat = matOverride ? matOverride : &m.materials[size_t(std::max(0, p.material))];
      it.model = g;
      it.origin = o;
      it.shadow = castShadow && it.mat->alpha != Material::Alpha::Blend;
      items_.push_back(it);
    }
  }
}

void Renderer::submitTerrain(gfx::VertexInput vi, uint32_t indexCount, const dvec3& origin, bool castShadow, bool visible,
                             const dvec3& bmin, const dvec3& bmax) {
  Item it{};
  it.kind = Item::Kind::Terrain;
  it.vi = vi; it.count = indexCount;
  it.origin = vec3(origin - cam_.pos);
  it.shadow = castShadow;
  it.main = visible;
  if (bmax.x > bmin.x) {
    vec3 c = vec3((bmin + bmax) * 0.5 - cam_.pos);
    it.sphere = vec4(c, float(glm::length(bmax - bmin) * 0.5));
  }
  items_.push_back(it);
}

void Renderer::submitImpostors(const ImpostorBatch& b, bool castShadow) {
  if (!b.count()) return;
  Item it{};
  it.kind = Item::Kind::Impostor;
  it.vi = b.input(); it.count = 6; it.instances = b.count();
  it.shadow = castShadow;
  items_.push_back(it);
}

void Renderer::setMaterial(const Material& m, bool pine, float height) {
  dev_->bindTexture(U_BASE, m.baseTex ? m.baseTex : white_);
  dev_->bindTexture(U_MR, m.mrTex ? m.mrTex : white_);
  dev_->bindTexture(U_NORMAL, m.normalTex ? m.normalTex : flatN_);
  dev_->setVec4("uBaseColor", glm::value_ptr(m.baseColor));
  vec4 mat(m.metallic, m.roughness, m.normalScale, m.alpha == Material::Alpha::Mask ? m.alphaCutoff : -1.f);
  dev_->setVec4("uMat", glm::value_ptr(mat));
  vec4 flags(m.baseTex ? 1.f : 0.f, m.mrTex ? 1.f : 0.f, m.normalTex ? 1.f : 0.f, m.doubleSided ? 1.f : 0.f);
  dev_->setVec4("uFlags", glm::value_ptr(flags));
  vec3 em = m.emissive * (m.emissiveNight.x + m.emissiveNight.y * light_.night);
  dev_->setVec3("uEmissive", glm::value_ptr(em));
  dev_->bindTexture(U_EMISSIVE, m.emissiveTex ? m.emissiveTex : white_);
  vec4 f2(m.vertexColor ? 1.f : 0.f, m.emissiveTex ? 1.f : 0.f, m.glow, m.colorSqrt ? 1.f : 0.f);
  dev_->setVec4("uFlags2", glm::value_ptr(f2));
  // shading kind: pine (vegetation.js), Meshy detail (meshylook.js), glass
  int kind = 0;
  if (pine || m.shading == 1) kind = 1;
  else if (m.shading == 4) kind = 4;   // (the mountains' rocks: world/scenery)
  else if (m.alpha == Material::Alpha::Blend && m.roughness < 0.6f) kind = 3;
  else if (m.shading == 2 || (m.shading == 0 && m.baseTex && m.alpha != Material::Alpha::Blend && m.paint == 0 &&
                              (m.name.empty() || m.name.rfind("Material_", 0) == 0))) kind = 2;
  static const float STR[5] = {0, 0.35f, 0.45f, 0.5f, 0.5f}, FAR[5] = {1, 16, 22, 28, 34};
  vec4 f3(float(m.paint), float(kind), height, m.lumNorm);
  dev_->setVec4("uFlags3", glm::value_ptr(f3));
  vec4 f4(m.paint == 1 && set_.fx >= 1 ? 1.f : m.clearcoat, kind == 2 ? STR[set_.fx] : 0.f, FAR[set_.fx], 0.f);
  dev_->setVec4("uFlags4", glm::value_ptr(f4));
  dev_->setVec4("uFanBase", glm::value_ptr(m.fanBase));   // (fans.js crowd people: recolour, screen-door fade)
  dev_->setVec4("uFanCol", glm::value_ptr(m.fanCol));
}

void Renderer::drawItem(const Item& it, bool shadowPass, gfx::PipelineState& ps, gfx::Program& cur) {
  auto use = [&](gfx::Program p) { if (p.id != cur.id) { dev_->useProgram(p); cur = p; } };
  if (it.kind == Item::Kind::Terrain) {
    use(shadowPass ? depthTerrain_ : terrain_);
    ps.cull = shadowPass ? gfx::Cull::None : gfx::Cull::Back;
    ps.alphaToCoverage = false;
    dev_->setPipeline(ps);
    dev_->setVec3("uOrigin", glm::value_ptr(it.origin));
    dev_->drawIndexed(it.vi, gfx::IndexType::U32, it.count);
    return;
  }
  if (it.kind == Item::Kind::Impostor) {
    if (shadowPass) return;
    use(impostor_);
    ps.cull = gfx::Cull::None;
    ps.alphaToCoverage = false;
    dev_->setPipeline(ps);
    dev_->drawIndexed(it.vi, gfx::IndexType::U16, 6, 0, it.instances);
    return;
  }
  gfx::Program p = it.kind == Item::Kind::Instanced ? (shadowPass ? depthInst_ : meshInst_)
                 : it.kind == Item::Kind::InstMat ? (shadowPass ? depthInstM_ : meshInstM_)
                 : it.skinned ? (shadowPass ? depthSkin_ : meshSkin_) : (shadowPass ? depthMesh_ : mesh_);
  use(p);
  bool pine = it.kind == Item::Kind::Instanced && it.mat->shading == 1;
  if (!shadowPass) {
    setMaterial(*it.mat, pine, it.height);
    ps.cull = it.mat->doubleSided ? gfx::Cull::None : gfx::Cull::Back;
    ps.alphaToCoverage = set_.msaa > 1 && it.mat->alpha == Material::Alpha::Mask;
  } else {
    // alpha-tested foliage casts its shape
    dev_->bindTexture(U_BASE, it.mat->baseTex ? it.mat->baseTex : white_);
    vec4 mat(0, 0, 0, it.mat->alpha == Material::Alpha::Mask ? it.mat->alphaCutoff : -1.f);
    dev_->setVec4("uMat", glm::value_ptr(mat));
    vec4 flags(it.mat->baseTex ? 1.f : 0.f, 0, 0, 0);
    dev_->setVec4("uFlags", glm::value_ptr(flags));
    dev_->setVec4("uBaseColor", glm::value_ptr(it.mat->baseColor));
    ps.cull = gfx::Cull::None;
  }
  if (shadowPass) {
    vec4 f3(0, pine ? 1.f : 0.f, it.height, 1.f);
    dev_->setVec4("uFlags3", glm::value_ptr(f3));
  }
  dev_->setPipeline(ps);
  dev_->setMat4("uModel", glm::value_ptr(it.model));
  if (it.kind == Item::Kind::InstMat) dev_->setVec3("uInstOrigin", glm::value_ptr(it.origin));
  if (it.skinned && it.joints) dev_->setMat4("uJoints[0]", glm::value_ptr((*it.joints)[0]), int(std::min<size_t>(64, it.joints->size())));
  if (shadowPass && it.sCount) dev_->drawIndexed(it.vi, gfx::IndexType::U32, it.sCount, it.sFirst, it.instances);
  else dev_->drawIndexed(it.vi, gfx::IndexType::U32, it.count, it.first, it.instances);
}

void Renderer::drawItems(bool shadowPass, int cascade) {
  gfx::PipelineState ps;
  if (shadowPass) { ps.colorWrite = false; ps.cull = gfx::Cull::None; ps.depthBiasFactor = 1.4f; ps.depthBiasUnits = 2.f; }
  gfx::Program cur{};
  // terrain first (largest occluder), then opaque meshes, impostors, then (main pass) the transparent ones back to front
  blend_.clear();
  for (int pass = 0; pass < 3; pass++)
    for (const Item& it : items_) {
      if (shadowPass ? !it.shadow : !it.main) continue;
      int want = it.kind == Item::Kind::Terrain ? 0 : it.kind == Item::Kind::Impostor ? 2 : 1;
      if (pass != want) continue;
      if (shadowPass && !inCascade(it, cascade)) continue;
      if (it.mat && it.mat->alpha == Material::Alpha::Blend) { if (!shadowPass) blend_.push_back(&it); continue; }
      drawItem(it, shadowPass, ps, cur);
    }
}

void Renderer::trailPass() {
  if (!trail_) return;
  const int T = set_.trailSize;
  const double S = set_.trailRange;
  dev_->bindRenderTarget(trail_, T, T);
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None;
  struct SI { vec4 a, b, c; };
  std::vector<SI> inst;
  auto emit = [&](double cu, double cv, vec2 dir, float hAlong, float hAcross, float kind, float strength, float along, float extra, float seed) {
    // centre in map uv (wrapped), copies across the wrap edges
    double u = cu - std::floor(cu), v = cv - std::floor(cv);
    float ext = std::max(hAlong, hAcross) * 1.5f;
    for (int dy = -1; dy <= 1; dy++)
      for (int dx = -1; dx <= 1; dx++) {
        double uu = u + dx, vv = v + dy;
        if (uu + ext < 0 || uu - ext > 1 || vv + ext < 0 || vv - ext > 1) continue;
        inst.push_back({vec4(float(uu), float(vv), hAlong, hAcross), vec4(dir, kind, strength), vec4(along, float(S), extra, seed)});
      }
  };
  // clear the strips the window left behind
  {
    double step = S / 16;
    dvec2 c(std::floor(trailFocus_.x / step + 0.5) * step, std::floor(trailFocus_.z / step + 0.5) * step);
    if (c != trailCenter_) {
      dvec2 o = trailCenter_;
      if (std::fabs(c.x - o.x) >= S || std::fabs(c.y - o.y) >= S) { dev_->clear(0, 0, 0, 0, true, false); }
      else {
        // x strip: world x between the old and the new far edges, all z
        if (c.x != o.x) {
          double x0 = c.x > o.x ? o.x + S / 2 : c.x - S / 2, x1 = c.x > o.x ? c.x + S / 2 : o.x - S / 2;
          emit((x0 + x1) / 2 / S, c.y / S, vec2(0, 1), 0.5f + 0.01f, float((x1 - x0) / 2 / S), 5, 1, 0, 0, 0);
        }
        if (c.y != o.y) {
          double z0 = c.y > o.y ? o.y + S / 2 : c.y - S / 2, z1 = c.y > o.y ? c.y + S / 2 : o.y - S / 2;
          emit(c.x / S, (z0 + z1) / 2 / S, vec2(1, 0), 0.5f + 0.01f, float((z1 - z0) / 2 / S), 5, 1, 0, 0, 0);
        }
      }
      trailCenter_ = c;
    }
  }
  if (!inst.empty()) {
    ps.blend = gfx::Blend::Opaque;
    dev_->setPipeline(ps);
    dev_->useProgram(stamp_);
    dev_->replaceBuffer(stampVbo_, inst.data(), inst.size() * sizeof(SI));
    dev_->drawIndexed(stampVi_, gfx::IndexType::U16, 6, 0, uint32_t(inst.size()));
    inst.clear();
  }
  // fade: the snow settles and the wind fills the tracks over minutes (faster in a snowfall)
  trailFadeT_ += 1.0 / 60.0;
  if (trailFadeT_ > 0.5) {
    float k = std::pow(0.5f, float(trailFadeT_) / (180.f * (1.f - 0.8f * std::min(1.f, light_.snow))));
    trailFadeT_ = 0;
    ps.blend = gfx::Blend::Multiply;
    dev_->setPipeline(ps);
    dev_->useProgram(trailFade_);
    vec4 f(k, k, k, std::pow(k, 3.f));
    dev_->setVec4("uFade", glm::value_ptr(f));
    dev_->draw(emptyVi_, 3);
  }
  for (const TrailStamp& s : stamps_) {
    if (std::fabs(s.pos.x - trailCenter_.x) > S / 2 + 2 || std::fabs(s.pos.y - trailCenter_.y) > S / 2 + 2) continue;
    float hx = s.halfAcross / float(S), ha = s.halfAlong / float(S);
    vec2 d = glm::length(s.dir) > 1e-4f ? glm::normalize(s.dir) : vec2(0, 1);
    emit(s.pos.x / S, s.pos.y / S, d, ha, hx, float(s.kind), s.strength, s.along, s.extra, s.seed);
  }
  if (!inst.empty()) {
    ps.blend = gfx::Blend::Max;
    dev_->setPipeline(ps);
    dev_->useProgram(stamp_);
    const size_t maxN = 48 * 1024 / sizeof(SI);
    for (size_t i = 0; i < inst.size(); i += maxN) {
      size_t n = std::min(maxN, inst.size() - i);
      dev_->replaceBuffer(stampVbo_, inst.data() + i, n * sizeof(SI));
      dev_->drawIndexed(stampVi_, gfx::IndexType::U16, 6, 0, uint32_t(n));
    }
  }
}

void Renderer::envPass() {
  int E = std::max(32, set_.envSize);
  dev_->bindRenderTarget(env_, E, E / 2);
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None;
  dev_->setPipeline(ps);
  dev_->useProgram(env_p_);
  dev_->setVec3("uEnvZenith", glm::value_ptr(envZenith_));
  dev_->setVec3("uEnvHorizon", glm::value_ptr(envHorizon_));
  dev_->setVec3("uEnvSun", glm::value_ptr(envSun_));
  dev_->setVec3("uEnvGlow", glm::value_ptr(envGlow_));
  dev_->draw(emptyVi_, 3);
  gfx::Texture t = dev_->renderTargetColor(env_);
  dev_->generateMipmaps(t);
  static bool sampled = false;
  if (!sampled) { dev_->setSampling(t, gfx::Filter::Trilinear, gfx::Wrap::Repeat, 1); sampled = true; }
}

void Renderer::particlePass() {
  if (particles_.empty()) return;
  struct PI { vec4 a, b, c; };
  std::vector<PI> inst;
  inst.reserve(particles_.size());
  // back to front
  std::sort(particles_.begin(), particles_.end(), [&](const Particle& a, const Particle& b) {
    dvec3 da = a.pos - cam_.pos, db = b.pos - cam_.pos; return glm::dot(da, da) > glm::dot(db, db); });
  for (const Particle& p : particles_) inst.push_back({vec4(vec3(p.pos - cam_.pos), p.size), p.color, vec4(p.rot, p.soft, 0, 0)});
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::LessEqual; ps.depthWrite = false; ps.cull = gfx::Cull::None; ps.blend = gfx::Blend::Premul;
  dev_->setPipeline(ps);
  dev_->useProgram(particle_);
  vec2 nf(cam_.nearZ, cam_.farZ);
  dev_->setVec2("uNearFar", glm::value_ptr(nf));
  const size_t maxN = 4096;
  for (size_t i = 0; i < inst.size(); i += maxN) {
    size_t n = std::min(maxN, inst.size() - i);
    dev_->replaceBuffer(partVbo_, inst.data() + i, n * sizeof(PI));
    dev_->drawIndexed(partVi_, gfx::IndexType::U16, 6, 0, uint32_t(n));
  }
}

void Renderer::cloudPass() {
  if (!clouds_ || light_.interior || noClouds_) return;
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None; ps.blend = gfx::Blend::Premul;
  dev_->setPipeline(ps);
  dev_->useProgram(clouds_);
  mat4 inv = glm::inverse(viewProj_);
  dev_->setMat4("uInvViewProj", glm::value_ptr(inv));
  vec2 nf(cam_.nearZ, cam_.farZ);
  dev_->setVec2("uNearFar", glm::value_ptr(nf));
  dev_->setVec4("uCloudLow", glm::value_ptr(cloudLow_));
  dev_->draw(emptyVi_, 3);
}

void Renderer::glarePass() {
  if (!glare_ || glm::length(glareCore_) < 1e-4f) return;
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None; ps.blend = gfx::Blend::Additive;
  dev_->setPipeline(ps);
  dev_->useProgram(glare_);
  dev_->setFloat("uSize", 0.9f);
  for (int i = 0; i < 32; i++) {
    char n[32];
    std::snprintf(n, sizeof n, "uRays[%d]", i); dev_->setVec4(n, glm::value_ptr(rays_[i]));
    std::snprintf(n, sizeof n, "uRayI[%d]", i); dev_->setFloat(n, rayI_[i]);
  }
  dev_->setVec3("uCore", glm::value_ptr(glareCore_));
  vec3 tint(0.75f, 0.9f, 1.0f);
  dev_->setVec3("uHaloTint", glm::value_ptr(tint));
  vec3 f = cam_.forward();
  dev_->setFloat("uRot", std::atan2(f.x, f.z) * 0.35f + cam_.roll);
  dev_->drawIndexed(partVi_, gfx::IndexType::U16, 6, 0, 1);
}

void Renderer::aoPass() {
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None;
  dev_->bindRenderTarget(aoRaw_, aw_, ah_);
  dev_->setPipeline(ps);
  dev_->useProgram(ao_);
  mat4 P = cam_.proj();
  vec2 nf(cam_.nearZ, cam_.farZ), ip(1.f / P[0][0], 1.f / P[1][1]), ft(1.f / float(rw_), 1.f / float(rh_));
  dev_->setVec2("uNearFar", glm::value_ptr(nf));
  dev_->setVec2("uInvProj", glm::value_ptr(ip));
  dev_->setVec2("uFullTexel", glm::value_ptr(ft));
  dev_->setFloat("uRadius", 1.6f);
  dev_->setFloat("uIntensity", 1.25f);
  dev_->setFloat("uProjScale", P[1][1] * float(rh_) * 0.5f);
  dev_->setFloat("uMaxPx", 110.f * float(rh_) / 1080.f * 1.5f);
  dev_->setFloat("uDirs", set_.ao > 0 ? float(set_.aoDirs) : 0.f);
  dev_->setFloat("uSteps", float(set_.aoSteps));
  dev_->setVec2("uSunUV", glm::value_ptr(sunUV_));
  dev_->setFloat("uShafts", shaftsK_);
  dev_->draw(emptyVi_, 3);
  dev_->bindRenderTarget(aoTex_, aw_, ah_);
  dev_->useProgram(aoBlur_);
  dev_->bindTexture(U_AO, dev_->renderTargetColor(aoRaw_));
  vec2 t(1.f / float(aw_), 1.f / float(ah_));
  dev_->setVec2("uTexel", glm::value_ptr(t));
  dev_->draw(emptyVi_, 3);
}

void Renderer::bloomPass() {
  if (bloom_.empty()) return;
  gfx::PipelineState ps;
  ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None;
  dev_->useProgram(bloomDown_);
  dev_->setFloat("uThreshold", bloomThreshold);
  gfx::Texture src = dev_->renderTargetColor(hdr_);
  vec2 texel(1.f / float(rw_), 1.f / float(rh_));
  for (size_t i = 0; i < bloom_.size(); i++) {
    dev_->bindRenderTarget(bloom_[i], bloomSize_[i].first, bloomSize_[i].second);
    dev_->setPipeline(ps);
    dev_->bindTexture(0, src);
    dev_->setVec2("uTexel", glm::value_ptr(texel));
    dev_->setFloat("uFirst", i == 0 ? 1.f : 0.f);
    dev_->draw(emptyVi_, 3);
    src = dev_->renderTargetColor(bloom_[i]);
    texel = vec2(1.f / float(bloomSize_[i].first), 1.f / float(bloomSize_[i].second));
  }
  dev_->useProgram(bloomUp_);
  ps.blend = gfx::Blend::Additive;
  dev_->setFloat("uRadius", set_.bloomRadius);
  for (int i = int(bloom_.size()) - 1; i > 0; i--) {
    dev_->bindRenderTarget(bloom_[size_t(i - 1)], bloomSize_[size_t(i - 1)].first, bloomSize_[size_t(i - 1)].second);
    dev_->setPipeline(ps);
    dev_->bindTexture(0, dev_->renderTargetColor(bloom_[size_t(i)]));
    vec2 t(1.f / float(bloomSize_[size_t(i)].first), 1.f / float(bloomSize_[size_t(i)].second));
    dev_->setVec2("uTexel", glm::value_ptr(t));
    dev_->draw(emptyVi_, 3);
  }
}

void Renderer::endFrame() {
  dev_->resetFrameStats();
  uploadLights();
  dev_->bindUniformBuffer(1, lightsUbo_);
  trailPass();
  envPass();
  // shadow cascades
  dev_->bindRenderTarget(shadow_, atlasW_, atlasH_);
  dev_->clear(0, 0, 0, 0, false, true);
  if (shadowsOn && light_.sunIntensity > 0.01f) {
    for (int c = 0; c < nCasc_; c++) {
      const vec4& r = casc_[c].rect;
      dev_->setViewport(int(r.x * float(atlasW_)), int(r.y * float(atlasH_)), int(r.z * float(atlasW_)), int(r.w * float(atlasH_)), true);
      dev_->bindUniformBuffer(0, shadowUbo_[c]);
      drawItems(true, c);
    }
  }
  // main pass (HDR, multisampled on the high presets)
  gfx::RenderTarget main = msaa_ ? msaa_ : hdr_;
  dev_->bindRenderTarget(main, rw_, rh_);
  dev_->clear(0, 0, 0, 1, true, true);
  dev_->bindUniformBuffer(0, frameUbo_);
  dev_->bindTexture(U_SHADOW, dev_->renderTargetDepth(shadow_));
  dev_->bindTexture(U_NOISE, noise_);
  dev_->bindTexture(U_ENV, dev_->renderTargetColor(env_));
  dev_->bindTexture(U_TRAIL, trail_ ? dev_->renderTargetColor(trail_) : blackTex_);
  dev_->bindTexture(U_DETAIL, detail_);
  dev_->bindTexture(U_SNOW, snowTex_);
  dev_->bindTexture(U_ROCK, rockTex_);
  dev_->bindTexture(U_SKYNOISE, skyNoise_);
  drawItems(false, 0);
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
  // transparent meshes, back to front
  if (!blend_.empty()) {
    auto dist = [](const Item* it) { vec3 c = it->kind == Item::Kind::InstMat ? it->origin : vec3(it->model[3]); return glm::dot(c, c); };
    std::sort(blend_.begin(), blend_.end(), [&](const Item* a, const Item* b) { return dist(a) > dist(b); });
    gfx::PipelineState ps;
    ps.blend = gfx::Blend::Alpha;
    ps.depthWrite = false;
    gfx::Program cur{};
    for (const Item* it : blend_) {
      // (fans.js contact shades: the snow under the crowd people multiplied toward a sky-lit blue, offset toward the camera)
      const bool shade = it->mat && it->mat->fanBase.w < -0.5f;
      ps.blend = shade ? gfx::Blend::Multiply : gfx::Blend::Alpha;
      ps.depthBiasFactor = shade ? -2.f : 0.f;
      ps.depthBiasUnits = shade ? -4.f : 0.f;
      drawItem(*it, false, ps, cur);
    }
  }
  // resolve; the depth copy the post passes and the particles read
  if (msaa_) dev_->resolve(msaa_, hdr_, rw_, rh_, true, true);
  dev_->resolve(hdr_, depthCopy_, rw_, rh_, false, true);
  dev_->bindRenderTarget(hdr_, rw_, rh_);
  dev_->bindTexture(U_DEPTH, dev_->renderTargetDepth(depthCopy_));
  cloudPass();
  particlePass();
  glarePass();
  bool ao = aoRaw_ && (set_.ao > 0 || shaftsK_ > 0.001f);
  if (ao) aoPass();
  bool bloom = bloomOn && bloomStrength > 0;
  if (bloom) bloomPass();
  // final: tone map + grade (into the LDR target when FXAA / sharpening follow)
  bool aa = set_.fxaa || set_.sharpen > 0;
  if (aa) dev_->bindRenderTarget(ldr_, w_, h_); else dev_->bindRenderTarget({}, w_, h_);
  {
    gfx::PipelineState ps;
    ps.depth = gfx::DepthTest::Off; ps.depthWrite = false; ps.cull = gfx::Cull::None;
    dev_->setPipeline(ps);
    dev_->useProgram(final_);
    dev_->bindTexture(0, dev_->renderTargetColor(hdr_));
    dev_->bindTexture(U_BLOOM, bloom && !bloom_.empty() ? dev_->renderTargetColor(bloom_[0]) : blackTex_);
    dev_->bindTexture(U_AO, ao ? dev_->renderTargetColor(aoTex_) : white_);
    dev_->setFloat("uExposure", light_.exposure);
    dev_->setInt("uToneMap", light_.toneMap >= 0 ? light_.toneMap : set_.toneMap);
    vec4 p1(bloom ? bloomStrength * 0.42f : 0.f, fx.vignette, fx.streaks, fx.flash);
    vec4 p2(fx.hit, float(time_), ao && set_.ao > 0 ? 0.85f : 0.f, ao ? shaftsK_ * 0.07f : 0.f);
    vec4 p3(float(set_.grade), float(w_) / float(h_), set_.fx >= 1 ? 1.f : 0.f, aa ? 1.f : 0.f);
    dev_->setVec4("uPost", glm::value_ptr(p1));
    dev_->setVec4("uPost2", glm::value_ptr(p2));
    dev_->setVec4("uPost3", glm::value_ptr(p3));
    dev_->setVec3("uSunCol", glm::value_ptr(sunCol_));
    dev_->draw(emptyVi_, 3);
    if (aa) {
      dev_->bindRenderTarget({}, w_, h_);
      dev_->setPipeline(ps);
      dev_->useProgram(fxaa_);
      dev_->bindTexture(0, dev_->renderTargetColor(ldr_));
      vec2 t(1.f / float(w_), 1.f / float(h_));
      dev_->setVec2("uTexel", glm::value_ptr(t));
      dev_->setFloat("uSharpen", set_.sharpen);
      dev_->setFloat("uAA", set_.fxaa ? 1.f : 0.f);
      dev_->draw(emptyVi_, 3);
    }
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
  lastTris_ = dev_->trianglesThisFrame();
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
