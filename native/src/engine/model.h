// GPU-side model loaded from a glTF / GLB: node hierarchy, meshes (PBR metal/rough materials), skins, animation
// clips. Produced by AssetManager; drawn by Renderer (single instances, skinned, or instanced batches).
#pragma once
#include "core/math.h"
#include "gfx/gfx.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {

struct Material {
  vec4 baseColor{1};
  float metallic = 1, roughness = 1, normalScale = 1, alphaCutoff = 0.5f;
  vec3 emissive{0};
  gfx::Texture baseTex, mrTex, normalTex, emissiveTex;
  bool doubleSided = false;
  bool vertexColor = false;        // multiply the base colour by the vertex colour (procedural meshes)
  bool colorSqrt = false;          // the vertex colour is stored as sqrt (8-bit packed meshes): squared in the shader
  float glow = 0;                  // village.js addNightGlow: warm bright texels glow at night x this
  vec2 emissiveNight{1, 0};        // emissive x (x + y * night) (lights dim by day, signs lit at night)
  enum class Alpha : uint8_t { Opaque, Mask, Blend } alpha = Alpha::Opaque;
  std::string name;                // (Phase 7) the glTF material's name (car paint, wheels)
  int baseImage = -1;              // (Phase 7, keepCpu) index of the base colour image in Model::images
  int mrImage = -1;                // (keepCpu) index of the metallic-roughness image (the outfits' baked finish)
  uint8_t paint = 0;               // (Phase 7) 1: car paint (an instance's tint replaces the colour), 2: livery (red -> tint)
  uint8_t shading = 0;             // renderer: 0 automatic (the Meshy detail layer on Meshy materials, glass), 1 pine needles
                                   // (vegetation.js), 2 force the detail layer, 3 plain (no detail layer)
  float lumNorm = 1;               // (pines) 1 / mean needle luminance of the texture (vegetation.js uLumNorm)
  float clearcoat = 0;             // a clear coat over the base (car paint gets one on fx >= 1)
};

/// One draw: a vertex range + index ranges per level of detail (LOD 0 = full; more from meshoptimizer's simplifier).
struct Primitive {
  gfx::VertexInput input;
  gfx::Buffer vbo, ibo;
  struct Lod { uint32_t first = 0, count = 0; };
  std::vector<Lod> lods;
  int material = -1;
  bool skinned = false;
  uint32_t stride = 32;             // bytes per vertex: pos, normal, uv (+ rgb colour when hasColor)
  bool hasColor = false;
  bool packed = false;              // (Phase 7) the 28-byte layout: pos f32 x3, normal i8 x3 (+pad), uv f32 x2, colour u8 x3 sqrt (+pad)
  vec3 bmin{1e30f}, bmax{-1e30f};   // in the mesh's own space
  // (Phase 7, ModelLoadOptions::keepCpu) the vertices (pos, normal, uv: 8 floats) and LOD 0 indices on the CPU
  std::shared_ptr<std::vector<float>> cpuVerts;    // 8 floats a vertex; skinned: 16 (+ joints, weights)
  std::shared_ptr<std::vector<uint32_t>> cpuIdx;
};
/// (Phase 7, keepCpu) a decoded texture kept on the CPU (RGBA8, top row first)
struct CpuImage { int w = 0, h = 0; std::vector<uint8_t> rgba; };

struct Mesh { std::string name; std::vector<Primitive> primitives; };

struct Node {
  std::string name;
  int parent = -1;
  std::vector<int> children;
  vec3 t{0}; quat r{1, 0, 0, 0}; vec3 s{1};
  int mesh = -1, skin = -1;
};

struct Skin { std::vector<int> joints; std::vector<mat4> inverseBind; };

struct AnimChannel {
  std::string node;            // target node by name (clips retarget onto any model with the same bone names)
  enum class Path : uint8_t { T, R, S } path = Path::T;
  bool step = false;
  std::vector<float> times, values;
};
struct AnimClip { std::string name; float duration = 0; std::vector<AnimChannel> channels; };

/// Pose of a model instance: local TRS per node, then globals and skinning matrices.
struct Pose {
  std::vector<vec3> t, s;
  std::vector<quat> r;
  std::vector<mat4> global;
  std::vector<mat4> joints;    // per joint of skin 0 (global * inverse bind)
};

struct Model {
  std::string name;
  std::vector<Node> nodes;
  std::vector<int> roots;
  std::vector<Mesh> meshes;
  std::vector<Material> materials;
  std::vector<Skin> skins;
  std::vector<AnimClip> clips;
  vec3 bmin{1e30f}, bmax{-1e30f};  // bind pose bounds in model space (all mesh nodes)
  std::vector<std::shared_ptr<CpuImage>> images;   // (Phase 7, keepCpu) per glTF texture

  int findNode(const std::string& n) const {
    for (size_t i = 0; i < nodes.size(); i++) if (nodes[i].name == n) return int(i);
    return -1;
  }
  const AnimClip* findClip(const std::string& n) const {
    for (auto& c : clips) if (c.name == n) return &c;
    return nullptr;
  }
  /// The rest pose (node TRS from the file).
  void restPose(Pose& p) const;
  /// Globals + joint matrices from the locals in `p`.
  void finishPose(Pose& p) const;
  /// world.js / assets.js fitModel(): scale so the bounds' `axis` extent (0 x, 1 y, 2 z, 3 max(x, z)) is `size`,
  /// centred on x/z with the bottom on y = 0 (or centred on y too).
  mat4 fitTransform(float size, int axis, bool centerY = false) const;
};

/// Samples `clip` at time `t` (looping) into the pose, blended over what is there with weight `w`.
void sampleClip(const Model& target, const AnimClip& clip, float t, float w, Pose& pose,
                const std::vector<int>& channelNodes);
/// Node index in `target` for each channel of `clip` (-1 if absent): computed once per (model, clip).
std::vector<int> bindClip(const Model& target, const AnimClip& clip);

} // namespace sl
