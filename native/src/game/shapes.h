// Small procedural 3D pieces the Phase 5 systems draw at run time (the job parcel, gate flags of the guide, the race
// guide's glowing pillar and pennants, the police helicopter's searchlight cone, ring markers, the snowflakes, the
// chalet's walls and the build mode's blueprint ghost): unit shapes (box, cylinder, cone, quad, sphere) built once per
// colour / emissive / opacity and drawn at any transform. Plus an instanced batch helper for many copies (snowfall).
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "game/vehicles.h"
#include <map>
#include <memory>
#include <tuple>

namespace sl {

class Shapes {
public:
  enum class Kind : uint8_t { Box, Cylinder, Cone, Quad, Sphere };
  void init(gfx::Device& dev) { dev_ = &dev; }
  /// a unit shape (box 1 x 1 x 1 on y 0..1; cylinder / cone radius 1 on y 0..1; quad 1 x 1 in XY centred, facing +z;
  /// sphere radius 1 centred) in a colour (linear rgb, alpha < 1: blended), emissive glow
  const Model* get(Kind k, const vec4& color, float emissive = 0);
  /// draw helpers: a box from its centre-bottom, a vertical cylinder, a cone from its tip (pointing down)
  void box(Renderer& r, const dvec3& base, double yaw, const vec3& size, const vec4& c, float em = 0, bool shadow = true);
  void cylinder(Renderer& r, const dvec3& base, double radius, double h, const vec4& c, float em = 0, bool shadow = true);
  void beam(Renderer& r, const dvec3& tip, const dvec3& to, double radius, const vec4& c, float em);
  void sphere(Renderer& r, const dvec3& c, double radius, const vec4& col, float em = 0);
  void oriented(Renderer& r, Kind k, const dvec3& origin, const mat4& local, const vec4& c, float em = 0, bool shadow = true);
private:
  gfx::Device* dev_ = nullptr;
  std::map<std::tuple<int, int, int, int, int, int>, std::shared_ptr<Model>> cache_;
};

} // namespace sl
