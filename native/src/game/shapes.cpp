#include "game/shapes.h"
#include "engine/mesh_kit.h"

namespace sl {

const Model* Shapes::get(Kind k, const vec4& c, float em) {
  auto q = [](float v) { return int(std::round(v * 255)); };
  auto key = std::make_tuple(int(k), q(c.x), q(c.y), q(c.z), q(c.w), q(em / 8));
  auto it = cache_.find(key);
  if (it != cache_.end()) return it->second.get();
  Geo g;
  switch (k) {
    case Kind::Box: g = boxGeo(1, 1, 1); g.translate(0, 0.5f, 0); break;
    case Kind::Cylinder: g = cylinderGeo(1, 1, 1, 14); g.translate(0, 0.5f, 0); break;
    case Kind::Cone: g = cylinderGeo(0, 1, 1, 18, true); g.translate(0, 0.5f, 0); break;
    case Kind::Quad: g = shapeGeo({vec2(-0.5f, -0.5f), vec2(0.5f, -0.5f), vec2(0.5f, 0.5f), vec2(-0.5f, 0.5f)}); break;
    case Kind::Sphere: {
      // a low-poly UV sphere
      const int R = 12, S = 8;
      for (int j = 0; j <= S; j++)
        for (int i = 0; i <= R; i++) {
          float th = float(PI) * j / S, ph = float(TAU) * i / R;
          vec3 p(std::sin(th) * std::cos(ph), std::cos(th), std::sin(th) * std::sin(ph));
          g.pos.push_back(p); g.nor.push_back(p); g.uv.push_back(vec2(float(i) / R, float(j) / S));
        }
      for (int j = 0; j < S; j++)
        for (int i = 0; i < R; i++) {
          uint32_t a = uint32_t(j * (R + 1) + i), b = a + 1, cc = a + R + 1, d = cc + 1;
          g.idx.insert(g.idx.end(), {a, cc, b, b, cc, d});
        }
      break;
    }
  }
  if (g.col.size() != g.pos.size()) g.col.assign(g.pos.size(), vec3(1));
  Material m;
  m.baseColor = c;
  m.metallic = 0; m.roughness = 0.8f;
  m.emissive = vec3(c) * em;
  m.doubleSided = k == Kind::Quad || k == Kind::Cone || c.w < 1;
  if (c.w < 1) m.alpha = Material::Alpha::Blend;
  auto model = buildModel(*dev_, {{std::move(g), m}}, "shape");
  cache_[key] = model;
  return model.get();
}

void Shapes::oriented(Renderer& r, Kind k, const dvec3& origin, const mat4& local, const vec4& c, float em, bool shadow) {
  if (const Model* m = get(k, c, em)) r.submitModel(*m, origin, local, nullptr, shadow && c.w >= 1);
}

void Shapes::box(Renderer& r, const dvec3& base, double yaw, const vec3& size, const vec4& c, float em, bool shadow) {
  mat4 L = glm::rotate(mat4(1), float(yaw), vec3(0, 1, 0)) * glm::scale(mat4(1), size);
  oriented(r, Kind::Box, base, L, c, em, shadow);
}

void Shapes::cylinder(Renderer& r, const dvec3& base, double radius, double h, const vec4& c, float em, bool shadow) {
  oriented(r, Kind::Cylinder, base, glm::scale(mat4(1), vec3(float(radius), float(h), float(radius))), c, em, shadow);
}

void Shapes::sphere(Renderer& r, const dvec3& c, double radius, const vec4& col, float em) {
  oriented(r, Kind::Sphere, c, glm::scale(mat4(1), vec3(float(radius))), col, em, false);
}

void Shapes::beam(Renderer& r, const dvec3& tip, const dvec3& to, double radius, const vec4& c, float em) {
  // a cone with its tip at `tip` opening toward `to` (the unit cone: tip at y 1, base at y 0)
  dvec3 d = to - tip;
  double L = glm::length(d);
  if (L < 1e-3) return;
  vec3 dir = vec3(d / L);
  vec3 down(0, -1, 0);
  vec3 ax = glm::cross(down, dir);
  float sn = glm::length(ax), cs = glm::dot(down, dir);
  quat q = sn < 1e-5f ? (cs > 0 ? quat(1, 0, 0, 0) : glm::angleAxis(float(PI), vec3(1, 0, 0))) : glm::angleAxis(std::atan2(sn, cs), ax / sn);
  mat4 M = glm::mat4_cast(q) * glm::scale(mat4(1), vec3(float(radius), float(L), float(radius))) * glm::translate(mat4(1), vec3(0, -1, 0));
  // (the cone's tip, y 1 -> translated to 0, rotated so -y points along dir)
  oriented(r, Kind::Cone, tip, M, c, em, false);
}

} // namespace sl
