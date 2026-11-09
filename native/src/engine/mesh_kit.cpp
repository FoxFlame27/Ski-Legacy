#include "engine/mesh_kit.h"
#include <cstring>
#include "gfx/gfx.h"
#include <algorithm>
#include <glm/gtx/quaternion.hpp>
#include <cmath>

namespace sl {

void Geo::append(const Geo& g) {
  uint32_t base = uint32_t(pos.size());
  pos.insert(pos.end(), g.pos.begin(), g.pos.end());
  nor.insert(nor.end(), g.nor.begin(), g.nor.end());
  uv.insert(uv.end(), g.uv.begin(), g.uv.end());
  if (g.col.size() == g.pos.size()) col.insert(col.end(), g.col.begin(), g.col.end());
  else col.insert(col.end(), g.pos.size(), vec3(1));
  for (uint32_t i : g.idx) idx.push_back(base + i);
}
void Geo::transform(const mat4& m) {
  mat3 nm = glm::transpose(glm::inverse(mat3(m)));
  for (auto& p : pos) p = vec3(m * vec4(p, 1));
  for (auto& n : nor) { vec3 q = nm * n; float l = glm::length(q); n = l > 0 ? q / l : vec3(0, 1, 0); }
  if (glm::determinant(mat3(m)) < 0) for (size_t t = 0; t + 2 < idx.size(); t += 3) std::swap(idx[t + 1], idx[t + 2]);
}
void Geo::flatNormals() {
  Geo out;
  for (size_t t = 0; t + 2 < idx.size(); t += 3) {
    vec3 a = pos[idx[t]], b = pos[idx[t + 1]], c = pos[idx[t + 2]];
    vec3 n = glm::cross(b - a, c - a);
    float l = glm::length(n);
    n = l > 0 ? n / l : vec3(0, 1, 0);
    for (int k = 0; k < 3; k++) {
      uint32_t i = idx[t + size_t(k)];
      out.pos.push_back(pos[i]); out.nor.push_back(n); out.uv.push_back(i < uv.size() ? uv[i] : vec2(0));
      if (col.size() == pos.size()) out.col.push_back(col[i]);
      out.idx.push_back(uint32_t(out.idx.size()));
    }
  }
  *this = std::move(out);
}
void Geo::smoothNormals() {
  nor.assign(pos.size(), vec3(0));
  for (size_t t = 0; t + 2 < idx.size(); t += 3) {
    vec3 a = pos[idx[t]], b = pos[idx[t + 1]], c = pos[idx[t + 2]];
    vec3 n = glm::cross(b - a, c - a);
    for (int k = 0; k < 3; k++) nor[idx[t + size_t(k)]] += n;
  }
  for (auto& n : nor) { float l = glm::length(n); n = l > 0 ? n / l : vec3(0, 1, 0); }
}

// ---------------------------------------------------------------- primitives (THREE.js layouts)
Geo boxGeo(float w, float h, float d) {
  Geo g;
  const float hx = w / 2, hy = h / 2, hz = d / 2;
  struct F { vec3 n, u, v; };
  const F faces[6] = {{{1, 0, 0}, {0, 0, -1}, {0, 1, 0}}, {{-1, 0, 0}, {0, 0, 1}, {0, 1, 0}}, {{0, 1, 0}, {1, 0, 0}, {0, 0, -1}},
                      {{0, -1, 0}, {1, 0, 0}, {0, 0, 1}},  {{0, 0, 1}, {1, 0, 0}, {0, 1, 0}},  {{0, 0, -1}, {-1, 0, 0}, {0, 1, 0}}};
  for (const F& f : faces) {
    uint32_t b = uint32_t(g.pos.size());
    vec3 half(hx, hy, hz);
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
      float su = i ? 1.f : -1.f, sv = j ? -1.f : 1.f;
      vec3 p = (f.n + f.u * su + f.v * sv) * half;
      g.pos.push_back(p); g.nor.push_back(f.n); g.uv.push_back(vec2(float(i), float(1 - j)));
    }
    g.idx.insert(g.idx.end(), {b, b + 2, b + 1, b + 2, b + 3, b + 1});
  }
  return g;
}

Geo cylinderGeo(float rt, float rb, float h, int radial, bool open) {
  Geo g;
  const float hh = h / 2, slope = (rb - rt) / h;
  for (int y = 0; y <= 1; y++) {
    float r = y == 0 ? rt : rb, py = y == 0 ? hh : -hh;
    for (int x = 0; x <= radial; x++) {
      float u = float(x) / radial, th = u * float(TAU);
      float s = std::sin(th), c = std::cos(th);
      g.pos.push_back(vec3(r * s, py, r * c));
      g.nor.push_back(glm::normalize(vec3(s, slope, c)));
      g.uv.push_back(vec2(u, 1.f - y));
    }
  }
  for (int x = 0; x < radial; x++) {
    uint32_t a = uint32_t(x), b = uint32_t(radial + 1 + x), c = b + 1, d = a + 1;
    g.idx.insert(g.idx.end(), {a, b, d, b, c, d});
  }
  if (!open) for (int top = 0; top < 2; top++) {
    float r = top ? rt : rb, py = top ? hh : -hh, sign = top ? 1.f : -1.f;
    uint32_t c0 = uint32_t(g.pos.size());
    g.pos.push_back(vec3(0, py, 0)); g.nor.push_back(vec3(0, sign, 0)); g.uv.push_back(vec2(0.5f));
    for (int x = 0; x <= radial; x++) {
      float th = float(x) / radial * float(TAU);
      g.pos.push_back(vec3(r * std::sin(th), py, r * std::cos(th))); g.nor.push_back(vec3(0, sign, 0)); g.uv.push_back(vec2(0.5f));
    }
    for (int x = 0; x < radial; x++) {
      uint32_t a = c0 + 1 + uint32_t(x), b = a + 1;
      if (top) g.idx.insert(g.idx.end(), {a, b, c0}); else g.idx.insert(g.idx.end(), {b, a, c0});
    }
  }
  return g;
}

Geo torusArcGeo(float R, float tube, int radial, int tubular, float arc) {
  Geo g;
  for (int j = 0; j <= radial; j++)
    for (int i = 0; i <= tubular; i++) {
      float u = float(i) / tubular * arc, v = float(j) / radial * float(TAU);
      vec3 p((R + tube * std::cos(v)) * std::cos(u), (R + tube * std::cos(v)) * std::sin(u), tube * std::sin(v));
      vec3 c(R * std::cos(u), R * std::sin(u), 0);
      g.pos.push_back(p); g.nor.push_back(glm::normalize(p - c)); g.uv.push_back(vec2(float(i) / tubular, float(j) / radial));
    }
  for (int j = 1; j <= radial; j++)
    for (int i = 1; i <= tubular; i++) {
      uint32_t a = uint32_t((tubular + 1) * j + i - 1), b = uint32_t((tubular + 1) * (j - 1) + i - 1), c = uint32_t((tubular + 1) * (j - 1) + i), d = uint32_t((tubular + 1) * j + i);
      g.idx.insert(g.idx.end(), {a, b, d, b, c, d});
    }
  return g;
}

Geo ringGeo(float r0, float r1, int segs, float a0, float arc) {
  Geo g;
  for (int j = 0; j <= 1; j++) {
    float r = j ? r1 : r0;
    for (int i = 0; i <= segs; i++) {
      float a = a0 + arc * i / segs;
      g.pos.push_back(vec3(r * std::cos(a), r * std::sin(a), 0)); g.nor.push_back(vec3(0, 0, 1)); g.uv.push_back(vec2(0.5f));
    }
  }
  for (int i = 0; i < segs; i++) {
    uint32_t a = uint32_t(i), b = uint32_t(segs + 1 + i), c = b + 1, d = a + 1;
    g.idx.insert(g.idx.end(), {a, b, d, b, c, d});
  }
  return g;
}

std::vector<uint32_t> triangulate(const std::vector<vec2>& in) {
  std::vector<uint32_t> out;
  size_t n = in.size();
  if (n < 3) return out;
  float A = 0;
  for (size_t i = 0; i < n; i++) A += in[i].x * in[(i + 1) % n].y - in[(i + 1) % n].x * in[i].y;
  std::vector<uint32_t> v(n);
  for (size_t i = 0; i < n; i++) v[i] = uint32_t(A > 0 ? i : n - 1 - i);   // counter-clockwise order
  auto cross = [](vec2 a, vec2 b, vec2 c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); };
  auto inside = [&](vec2 p, vec2 a, vec2 b, vec2 c) { return cross(a, b, p) > 1e-9f && cross(b, c, p) > 1e-9f && cross(c, a, p) > 1e-9f; };
  size_t guard = 0;
  while (v.size() > 3 && guard++ < n * n) {
    bool cut = false;
    for (size_t i = 0; i < v.size(); i++) {
      uint32_t ia = v[(i + v.size() - 1) % v.size()], ib = v[i], ic = v[(i + 1) % v.size()];
      vec2 a = in[ia], b = in[ib], c = in[ic];
      float cr = cross(a, b, c);
      if (cr <= 1e-9f) { if (std::fabs(cr) <= 1e-9f && glm::dot(b - a, c - b) >= 0) { v.erase(v.begin() + long(i)); cut = true; break; } continue; }
      bool ear = true;
      for (uint32_t k : v) if (k != ia && k != ib && k != ic && inside(in[k], a, b, c)) { ear = false; break; }
      if (!ear) continue;
      out.insert(out.end(), {ia, ib, ic});
      v.erase(v.begin() + long(i));
      cut = true;
      break;
    }
    if (!cut) break;   // degenerate: give up on the rest
  }
  if (v.size() == 3) out.insert(out.end(), {v[0], v[1], v[2]});
  return out;
}

Geo shapeGeo(const std::vector<vec2>& pts) {
  Geo g;
  for (auto& p : pts) { g.pos.push_back(vec3(p, 0)); g.nor.push_back(vec3(0, 0, 1)); g.uv.push_back(p); }
  g.idx = triangulate(pts);
  return g;
}

vec3 hexColor(const char* hex) {
  auto h = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 0; };
  if (!hex || hex[0] != '#') return vec3(1);
  auto lin = [](float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); };
  float r = (h(hex[1]) * 16 + h(hex[2])) / 255.f, g = (h(hex[3]) * 16 + h(hex[4])) / 255.f, b = (h(hex[5]) * 16 + h(hex[6])) / 255.f;
  return vec3(lin(r), lin(g), lin(b));
}

// ---------------------------------------------------------------- kit
Geo& MeshKit::add(int kind, Geo g, const vec3& col, const vec3* top) {
  if (g.nor.size() != g.pos.size()) g.smoothNormals();
  g.uv.resize(g.pos.size(), vec2(0));
  g.col.resize(g.pos.size());
  for (size_t i = 0; i < g.pos.size(); i++) g.col[i] = top && g.nor[i].y > 0.6f ? *top : col;
  parts_[size_t(kind)].push_back(std::move(g));
  return parts_[size_t(kind)].back();
}
void MeshKit::box(int kind, float x0, float x1, float y0, float y1, float z0, float z1, const vec3& col, const vec3* top) {
  if (x1 < x0) std::swap(x0, x1);
  float w = x1 - x0, h = y1 - y0, d = z1 - z0;
  if (w <= 0 || h <= 0 || d <= 0) return;
  add(kind, boxGeo(w, h, d).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), col, top);
}
void MeshKit::bar(int kind, vec3 a, vec3 b, float s, const vec3& col, bool round) {
  vec3 v = b - a;
  float len = glm::length(v);
  if (len < 1e-3f) return;
  v /= len;
  Geo g = round ? cylinderGeo(s / 2, s / 2, len, 8) : boxGeo(s, len, s);
  quat q = glm::rotation(vec3(0, 1, 0), v);
  g.transform(glm::translate(mat4(1), (a + b) * 0.5f) * glm::mat4_cast(q));
  add(kind, std::move(g), col);
}
void MeshKit::sheet(int kind, float x0, float x1, float z0, float z1, int nx, int nz, const std::function<float(float, float)>& f, const vec3& col, bool down) {
  Geo g;
  for (int j = 0; j <= nz; j++)
    for (int i = 0; i <= nx; i++) {
      float x = x0 + (x1 - x0) * i / nx, z = z0 + (z1 - z0) * j / nz;
      g.pos.push_back(vec3(x, f(x, z), z)); g.uv.push_back(vec2(float(i) / nx, float(j) / nz));
    }
  for (int j = 0; j < nz; j++)
    for (int i = 0; i < nx; i++) {
      uint32_t a = uint32_t(j * (nx + 1) + i), b = a + 1, c = a + uint32_t(nx + 1), d = c + 1;
      if (!down) g.idx.insert(g.idx.end(), {a, c, b, b, c, d}); else g.idx.insert(g.idx.end(), {a, b, c, b, d, c});
    }
  g.smoothNormals();
  add(kind, std::move(g), col);
}
void MeshKit::slab(int kind, const std::vector<vec2>& pts, float y0, float y1, const vec3& colSide, const vec3& colTop) {
  if (pts.size() < 3 || y1 <= y0) return;
  Geo g;
  std::vector<uint32_t> tri = triangulate(pts);
  // caps (the triangulation is counter-clockwise in (x, z) seen from +y... orient each cap by its normal)
  for (int top = 0; top < 2; top++) {
    float y = top ? y1 : y0;
    uint32_t b = uint32_t(g.pos.size());
    for (auto& p : pts) { g.pos.push_back(vec3(p.x, y, p.y)); g.nor.push_back(vec3(0, top ? 1.f : -1.f, 0)); g.uv.push_back(p); }
    for (size_t t = 0; t + 2 < tri.size(); t += 3) {
      vec3 a = g.pos[b + tri[t]], bb = g.pos[b + tri[t + 1]], c = g.pos[b + tri[t + 2]];
      float ny = glm::cross(bb - a, c - a).y;
      bool flip = top ? ny < 0 : ny > 0;
      if (!flip) g.idx.insert(g.idx.end(), {b + tri[t], b + tri[t + 1], b + tri[t + 2]});
      else g.idx.insert(g.idx.end(), {b + tri[t], b + tri[t + 2], b + tri[t + 1]});
    }
  }
  // sides (flat, facing out)
  float A = 0;
  for (size_t i = 0; i < pts.size(); i++) A += pts[i].x * pts[(i + 1) % pts.size()].y - pts[(i + 1) % pts.size()].x * pts[i].y;
  for (size_t i = 0; i < pts.size(); i++) {
    vec2 p = pts[i], q = pts[(i + 1) % pts.size()];
    vec2 e = q - p;
    float l = glm::length(e);
    if (l < 1e-6f) continue;
    // outward normal in (x, z): for a counter-clockwise (x, z) polygon (A > 0) it is (e.y, -e.x)
    vec2 n2 = A > 0 ? vec2(e.y, -e.x) / l : vec2(-e.y, e.x) / l;
    vec3 n(n2.x, 0, n2.y);
    uint32_t b = uint32_t(g.pos.size());
    g.pos.insert(g.pos.end(), {vec3(p.x, y0, p.y), vec3(q.x, y0, q.y), vec3(q.x, y1, q.y), vec3(p.x, y1, p.y)});
    g.nor.insert(g.nor.end(), 4, n);
    g.uv.insert(g.uv.end(), {vec2(0), vec2(1, 0), vec2(1), vec2(0, 1)});
    vec3 fn = glm::cross(g.pos[b + 1] - g.pos[b], g.pos[b + 2] - g.pos[b]);
    if (glm::dot(fn, n) >= 0) g.idx.insert(g.idx.end(), {b, b + 1, b + 2, b, b + 2, b + 3});
    else g.idx.insert(g.idx.end(), {b, b + 2, b + 1, b, b + 3, b + 2});
  }
  add(kind, std::move(g), colSide, &colTop);
}
void MeshKit::shapeZ(int kind, const std::vector<vec2>& pts, float z, const vec3& col) {
  add(kind, shapeGeo(pts).translate(0, 0, z), col);
}
void MeshKit::vquad(int kind, float x0, float z0, float x1, float z1, float y0, float y1, const vec3& col) {
  Geo g;
  g.pos = {{x0, y0, z0}, {x1, y0, z1}, {x1, y1, z1}, {x0, y0, z0}, {x1, y1, z1}, {x0, y1, z0}};
  g.idx = {0, 1, 2, 3, 4, 5};
  g.flatNormals();
  add(kind, std::move(g), col);
}
void MeshKit::quad(int kind, vec3 a, vec3 b, vec3 c, vec3 d, const vec3& col) {
  Geo g;
  g.pos = {a, b, c, a, c, d};
  g.idx = {0, 1, 2, 3, 4, 5};
  g.flatNormals();
  add(kind, std::move(g), col);
}
void MeshKit::ring(int kind, float r0, float r1, float y, const vec3& col) {
  add(kind, ringGeo(r0, r1, 32, 0, float(PI)).rotateX(float(-PI / 2)).translate(0, y, 0), col);
}
void MeshKit::arcTube(int kind, float r, float tube, float y, const vec3& col, int radial) {
  add(kind, torusArcGeo(r, tube, radial, 32, float(PI)).rotateX(float(-PI / 2)).translate(0, y, 0), col);
}
Geo MeshKit::merge(int kind, bool mirror) const {
  Geo g;
  for (const Geo& p : parts_[size_t(kind)]) g.append(p);
  if (mirror) g.transform(glm::scale(mat4(1), vec3(-1, 1, 1)));
  return g;
}

// ---------------------------------------------------------------- upload
std::shared_ptr<Model> buildModel(gfx::Device& dev, const std::vector<std::pair<Geo, Material>>& parts, const std::string& name) {
  auto m = std::make_shared<Model>();
  m->name = name;
  Mesh mesh;
  for (auto& [g, mat] : parts) {
    if (g.empty()) continue;
    // (Phase 7) the packed 28-byte layout (was 44 bytes of floats): position f32 x3, normal i8 x3, uv f32 x2, colour u8 x3
    // stored as sqrt (the shader squares it: colorSqrt) -- the procedural meshes (track, guardrails, stations) 36 % smaller
    constexpr uint32_t st = 28;
    std::vector<uint8_t> vb(g.pos.size() * st, 0);
    Primitive p;
    auto i8 = [](float v) { return int8_t(std::lround(std::clamp(v, -1.f, 1.f) * 127.f)); };
    auto u8 = [](float v) { return uint8_t(std::lround(std::sqrt(std::clamp(v, 0.f, 1.f)) * 255.f)); };
    for (size_t i = 0; i < g.pos.size(); i++) {
      uint8_t* o = &vb[i * st];
      vec3 n = i < g.nor.size() ? g.nor[i] : vec3(0, 1, 0);
      vec2 t = i < g.uv.size() ? g.uv[i] : vec2(0);
      vec3 c = i < g.col.size() ? g.col[i] : vec3(1);
      std::memcpy(o, &g.pos[i], 12);
      int8_t nn[3] = {i8(n.x), i8(n.y), i8(n.z)};
      std::memcpy(o + 12, nn, 3);
      std::memcpy(o + 16, &t, 8);
      o[24] = u8(c.x); o[25] = u8(c.y); o[26] = u8(c.z);
      p.bmin = glm::min(p.bmin, g.pos[i]); p.bmax = glm::max(p.bmax, g.pos[i]);
    }
    p.stride = st; p.hasColor = true; p.packed = true;
    p.vbo = dev.createBuffer(gfx::BufferUsage::Vertex, vb.data(), vb.size());
    p.ibo = dev.createBuffer(gfx::BufferUsage::Index, g.idx.data(), g.idx.size() * sizeof(uint32_t));
    p.lods.push_back({0, uint32_t(g.idx.size())});
    p.input = dev.createVertexInput({{0, 0, 3, gfx::AttribType::Float, false, 0, st}, {1, 0, 3, gfx::AttribType::Byte, true, 12, st},
                                     {2, 0, 2, gfx::AttribType::Float, false, 16, st}, {7, 0, 3, gfx::AttribType::UByte, true, 24, st}},
                                    {p.vbo}, p.ibo);
    p.material = int(m->materials.size());
    m->materials.push_back(mat);
    m->materials.back().colorSqrt = true;
    m->bmin = glm::min(m->bmin, p.bmin); m->bmax = glm::max(m->bmax, p.bmax);
    mesh.primitives.push_back(std::move(p));
  }
  m->meshes.push_back(std::move(mesh));
  Node n;
  n.name = name;
  n.mesh = 0;
  m->nodes.push_back(n);
  m->roots.push_back(0);
  return m;
}

} // namespace sl
