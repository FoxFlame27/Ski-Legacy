// CPU geometry for procedural builders, after the `Kit` of src/world/gondolastation.js: parts with vertex colours
// (a separate colour for the faces looking up), boxes, bars, sheets f(x, z), extruded slabs, flat polygons, quads,
// rings and half tori; merged per material and uploaded as an ordinary Model (one node, one primitive per material)
// that the renderer draws like a GLB.
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include <functional>
#include <memory>
#include <vector>

namespace sl {
namespace gfx { class Device; }

struct Geo {
  std::vector<vec3> pos, nor, col;
  std::vector<vec2> uv;
  std::vector<uint32_t> idx;
  void append(const Geo& g);
  void transform(const mat4& m);
  Geo& translate(float x, float y, float z) { transform(glm::translate(mat4(1), vec3(x, y, z))); return *this; }
  Geo& rotateX(float a) { transform(glm::rotate(mat4(1), a, vec3(1, 0, 0))); return *this; }
  Geo& rotateY(float a) { transform(glm::rotate(mat4(1), a, vec3(0, 1, 0))); return *this; }
  Geo& rotateZ(float a) { transform(glm::rotate(mat4(1), a, vec3(0, 0, 1))); return *this; }
  void flatNormals();      // per-triangle normals (unshared vertices)
  void smoothNormals();    // averaged over shared vertices
  bool empty() const { return idx.empty(); }
};

// THREE.js-equivalent primitives (same layouts and orientations)
Geo boxGeo(float w, float h, float d);
Geo cylinderGeo(float rTop, float rBottom, float h, int radial, bool open = false);
Geo torusArcGeo(float r, float tube, int radial, int tubular, float arc);   // in the XY plane from angle 0 to arc
Geo ringGeo(float r0, float r1, int segs, float a0, float arc);              // in the XY plane, facing +z
Geo shapeGeo(const std::vector<vec2>& pts);                                   // a flat polygon in XY, facing +z
/// Ear-clipping triangulation of a simple polygon (either winding): triangle indices into pts.
std::vector<uint32_t> triangulate(const std::vector<vec2>& pts);

/// sRGB hex colour (#rrggbb) -> linear (THREE.Color.set with colour management)
vec3 hexColor(const char* hex);

class MeshKit {
public:
  explicit MeshKit(int kinds) : parts_(size_t(kinds)) {}
  Geo& add(int kind, Geo g, const vec3& col, const vec3* top = nullptr);
  void box(int kind, float x0, float x1, float y0, float y1, float z0, float z1, const vec3& col, const vec3* top = nullptr);
  void bar(int kind, vec3 a, vec3 b, float s, const vec3& col, bool round = false);
  void sheet(int kind, float x0, float x1, float z0, float z1, int nx, int nz, const std::function<float(float, float)>& f, const vec3& col, bool down = false);
  void slab(int kind, const std::vector<vec2>& pts, float y0, float y1, const vec3& colSide, const vec3& colTop);
  void shapeZ(int kind, const std::vector<vec2>& pts, float z, const vec3& col);
  void vquad(int kind, float x0, float z0, float x1, float z1, float y0, float y1, const vec3& col);
  void quad(int kind, vec3 a, vec3 b, vec3 c, vec3 d, const vec3& col);
  void ring(int kind, float r0, float r1, float y, const vec3& col);
  void arcTube(int kind, float r, float tube, float y, const vec3& col, int radial = 6);
  Geo merge(int kind, bool mirror) const;
  std::vector<std::vector<Geo>>& parts() { return parts_; }
private:
  std::vector<std::vector<Geo>> parts_;
};

/// Upload: one primitive per (geometry, material); vertex colours always present (white where unused).
std::shared_ptr<Model> buildModel(gfx::Device& dev, const std::vector<std::pair<Geo, Material>>& parts, const std::string& name = "kit");

} // namespace sl
