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
  enum class Alpha : uint8_t { Opaque, Mask, Blend } alpha = Alpha::Opaque;
};

/// One draw: a vertex range + index ranges per level of detail (LOD 0 = full; more from meshoptimizer's simplifier).
struct Primitive {
  gfx::VertexInput input;
  gfx::Buffer vbo, ibo;
  struct Lod { uint32_t first = 0, count = 0; };
  std::vector<Lod> lods;
  int material = -1;
  bool skinned = false;
  vec3 bmin{1e30f}, bmax{-1e30f};   // in the mesh's own space
};

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
