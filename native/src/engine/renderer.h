// Scene renderer on top of gfx::Device.
//   shadow pass  one directional shadow map fitted round the player (texel-snapped, PCF 3x3)
//   main pass    HDR target: terrain (snow / rock shading), PBR meshes (static, skinned, instanced), sky gradient
//   post         ACES filmic (three.js) or Khronos Neutral tone mapping, sRGB encode
//   HUD          text (stb_easy_font) and rectangles in pixels
// Everything is drawn camera-relative (the camera sits at the origin), so far from the village nothing jitters.
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include "gfx/gfx.h"
#include <string>
#include <vector>

namespace sl {

struct Camera {
  dvec3 pos{0};
  float yaw = 0, pitch = 0, roll = 0;   // yaw 0 looks toward +Z ... set via lookAt()
  mat3 basis{1};                        // columns: right, up, back (camera space)
  float fovY = 65, nearZ = 0.1f, farZ = 30000, aspect = 16.f / 9.f;
  void lookAt(const dvec3& eye, const dvec3& target, const vec3& up = vec3(0, 1, 0));
  mat4 view() const;                    // rotation only (camera-relative)
  mat4 proj() const;
  vec3 forward() const { return -basis[2]; }
};

struct Lighting {
  vec3 sunDir = glm::normalize(vec3(-0.35f, 0.42f, 0.84f));
  vec3 sunColor{1.0f, 0.93f, 0.82f};
  float sunIntensity = 6.0f;
  vec3 sky{0.26f, 0.42f, 0.78f}, ground{0.42f, 0.44f, 0.50f};
  vec3 fog{0.1633f, 0.4992f, 1.6117f};
  vec3 zenith{0.0313f, 0.0583f, 0.2011f}, mid{0.0417f, 0.3990f, 1.4235f}, horizon{0.3156f, 1.5195f, 5.2906f}, glow{0.4458f, 2.1394f, 6.6786f};
  float fogDensity = 0.000034f, fogFalloff = 0.00045f;
  float exposure = 0.72f;
  int toneMap = 0;  // 0 ACES, 1 Neutral
  float night = 0;  // village.js nightUniform: 0 by day .. 1 at night (lamps, lit windows, signs)
};

struct RenderSettings {
  int shadowSize = 2048;
  float shadowRange = 90;   // half extent of the shadow box (m)
  float renderScale = 1.0f; // 3D resolution scale (dynamic resolution on console)
  bool lowShaders = false;  // (Phase 7) SL_LOW: single-tap shadows, no far normal maps, no glints
  int maxLights = 16;       // point / spot lights a frame (<= 16)
};

/// (Phase 7) a lamp's or a headlight's light: point (cosOuter < -1.5) or spot (dir, cones)
struct PointLight {
  dvec3 pos{0};
  vec3 color{1};            // linear rgb x intensity
  float range = 15;
  vec3 dir{0, -1, 0};
  float cosOuter = -2, cosInner = -2;
};
/// (Phase 7, SETTINGS: screen effects) the post pass's extras
struct ScreenFx { float vignette = 0, streaks = 0, flash = 0, hit = 0; };

/// A batch of instances of one model (trees): per instance vec4(x, y, z, scale) + vec4(yaw, 0, 0, 0).
class InstanceBatch {
public:
  struct Inst { vec4 posScale; vec4 rot; };
  void init(gfx::Device& d, const Model& m, uint32_t capacity);
  void upload(gfx::Device& d, const std::vector<Inst>& inst);
  uint32_t count() const { return count_; }
  const Model* model() const { return model_; }
  const std::vector<gfx::VertexInput>& inputs() const { return inputs_; }
private:
  const Model* model_ = nullptr;
  gfx::Buffer buf_;
  std::vector<gfx::VertexInput> inputs_;  // per primitive (mesh order)
  uint32_t count_ = 0, capacity_ = 0;
};

/// Instances of one model with full 3x4 world matrices (props, lift towers, cabins): per instance three rows, the
/// translation relative to the batch origin (double precision on the CPU, camera-relative on the GPU).
class MatrixInstanceBatch {
public:
  struct Inst { vec4 r0, r1, r2, tint{1, 1, 1, 0}; };   // tint: (Phase 7) paint / livery colour, a = 0: none
  void init(gfx::Device& d, const Model& m, uint32_t capacity);
  void upload(gfx::Device& d, const std::vector<Inst>& inst);
  uint32_t count() const { return count_; }
  const Model* model() const { return model_; }
  const std::vector<gfx::VertexInput>& inputs() const { return inputs_; }
  static Inst pack(const glm::dmat4& world, const dvec3& origin, const vec4& tint = vec4(1, 1, 1, 0));
private:
  const Model* model_ = nullptr;
  gfx::Buffer buf_;
  std::vector<gfx::VertexInput> inputs_;
  uint32_t count_ = 0, capacity_ = 0;
};

class Renderer {
public:
  bool init(gfx::Device& dev, const RenderSettings& s);
  void resize(int w, int h);
  /// (SETTINGS) 3D resolution scale and the sun's shadows, live
  void setRenderScale(float s) { set_.renderScale = s; resize(w_, h_); }
  float renderScale() const { return set_.renderScale; }
  bool shadowsOn = true;
  // (Phase 7) SETTINGS: bloom; the screen effects; lights for this frame (call between beginFrame and endFrame)
  bool bloomOn = true;
  float bloomStrength = 0.13f, bloomThreshold = 3.0f;
  ScreenFx fx;
  void addLight(const PointLight& l) { lights_.push_back(l); }
  int lightsUsed() const { return lightsUsed_; }
  uint64_t triangles() const { return lastTris_; }
  int width() const { return w_; }
  int height() const { return h_; }
  gfx::Texture noiseTexture() const { return noise_; }
  gfx::Device& device() { return *dev_; }

  void beginFrame(const Camera& cam, const Lighting& light, const dvec3& shadowFocus);
  /// A model at world transform (origin + local matrix). pose: skinning (nullptr = rest).
  void submitModel(const Model& m, const dvec3& origin, const mat4& local, const Pose* pose, bool castShadow, int lod = 0, bool visible = true);
  void submitInstances(const InstanceBatch& b, const mat4& fit, int lod, bool castShadow);
  /// Matrix instances (origin: the batch's origin the instance translations are relative to). matOverride: draw
  /// every primitive with this material instead (a prop's night glow).
  void submitInstances(const MatrixInstanceBatch& b, const dvec3& origin, int lod, bool castShadow, const Material* matOverride = nullptr);
  void submitTerrain(gfx::VertexInput vi, uint32_t indexCount, const dvec3& origin, bool castShadow, bool visible = true);
  /// Frustum test of a world-space box (for the caller's culling).
  bool visible(const dvec3& bmin, const dvec3& bmax) const;
  /// Whether a world-space box can cast into the shadow map (overlaps the light's ortho box).
  bool castsShadow(const dvec3& bmin, const dvec3& bmax) const;

  // HUD (pixels, origin top-left)
  void hudText(float x, float y, float scale, const vec4& color, const std::string& text);
  void hudRect(float x, float y, float w, float h, const vec4& color);
  static float hudTextWidth(const std::string& text, float scale);

  void endFrame();
  void readPixels(std::vector<uint8_t>& rgba) { dev_->readPixels(w_, h_, rgba); }
  uint32_t drawCalls() const { return lastDraws_; }
  const Camera& camera() const { return cam_; }

private:
  struct Item {
    enum class Kind : uint8_t { Mesh, Instanced, InstMat, Terrain } kind;
    gfx::VertexInput vi;
    uint32_t first = 0, count = 0, instances = 1;
    const Material* mat = nullptr;
    const std::vector<mat4>* joints = nullptr;
    bool skinned = false, shadow = false, main = true;
    mat4 model{1};
    vec3 origin{0};
  };
  void drawItems(bool shadowPass);
  void drawItem(const Item& it, bool shadowPass, gfx::PipelineState& ps, gfx::Program& cur);
  void setMaterial(const Material& m);
  void makeNoiseTexture();
  gfx::Program build(const char* name, const char* defines, const char* vs, const char* fs, bool lit);

  gfx::Device* dev_ = nullptr;
  RenderSettings set_;
  int w_ = 1, h_ = 1, rw_ = 1, rh_ = 1;
  gfx::RenderTarget hdr_, shadow_, bloomA_, bloomB_;
  gfx::Buffer frameUbo_, shadowUbo_, hudVbo_, lightsUbo_;
  gfx::Program bloom_;
  int bw_ = 1, bh_ = 1;
  std::vector<PointLight> lights_;
  int lightsUsed_ = 0;
  uint64_t lastTris_ = 0;
  void uploadLights();
  void bloomPass();
  gfx::VertexInput hudVi_, emptyVi_;
  gfx::Program mesh_, meshSkin_, meshInst_, meshInstM_, terrain_, depthMesh_, depthSkin_, depthInst_, depthInstM_, depthTerrain_, sky_, post_, hud_;
  gfx::Texture noise_, white_;
  std::vector<Item> items_;
  std::vector<const Item*> blend_;
  std::vector<float> hudVerts_;
  Camera cam_;
  Lighting light_;
  mat4 viewProj_{1}, lightView_{1};
  float shadowR_ = 80;
  vec4 planes_[6];
  uint32_t lastDraws_ = 0;
};

} // namespace sl
