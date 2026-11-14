#include "game/window_view.h"
#include "core/log.h"
#include "engine/mesh_kit.h"
#include "game/shapes.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace sl {

namespace {
constexpr int NX = 12, NY = 6;          // a pane's grid (the mapping is a projection: a few quads follow it closely)
constexpr uint32_t STRIDE = 28;         // buildModel's packed vertex: position, normal, uv at byte 16, colour
}

void WindowView::clear() {
  if (c_.dev) {
    for (gfx::Texture t : tex_) if (t.id) c_.dev->destroy(t);
    for (Mesh& me : meshes_) if (me.model) for (auto& mesh : me.model->meshes) for (Primitive& p : mesh.primitives) { c_.dev->destroy(p.input); c_.dev->destroy(p.vbo); c_.dev->destroy(p.ibo); }
  }
  tex_.clear(); tanH_.clear(); tanV_.clear();
  meshes_.clear(); shots_.clear(); panes_.clear();
  pending_ = armed_ = false;
  done_ = nullptr;
  lastEye_ = dvec3(1e30);
}

void WindowView::begin(std::vector<Shot> shots, std::vector<Pane> panes, std::function<void()> done) {
  clear();
  shots_ = std::move(shots); panes_ = std::move(panes);
  tex_.assign(shots_.size(), gfx::Texture{}); tanH_.assign(shots_.size(), 1.f); tanV_.assign(shots_.size(), 1.f);
  done_ = std::move(done);
  capture_ = 0; wait_ = 0;
  pending_ = true;
  if (shots_.empty() || panes_.empty()) finish();
}

void WindowView::finish() {
  pending_ = armed_ = false;
  build();
  auto f = std::move(done_);
  done_ = nullptr;
  if (f) f();
}

bool WindowView::captureCamera(Camera& cam, bool covered, double dt) {
  armed_ = false;
  if (!pending_) return false;
  if (!covered) {   // (no fade to hide behind: go in without the photographs)
    wait_ += dt;
    if (wait_ > 1.2) finish();
    return false;
  }
  if (capture_ >= int(shots_.size())) { finish(); return false; }
  const Shot& s = shots_[size_t(capture_)];
  cam.lookAt(s.eye, s.eye + s.dir);
  const float tanH = std::tan(s.halfAngle * float(DEG));
  cam.fovY = 2 * std::atan(tanH / std::max(0.5f, cam.aspect)) / float(DEG);
  cam.nearZ = s.nearZ;
  armed_ = true;
  return true;
}

void WindowView::captured(Renderer& r) {
  if (!armed_) return;
  armed_ = false;
  std::vector<uint8_t> px;
  r.readPixels(px);
  const int W = r.width(), H = r.height();
  if (c_.dev && W > 8 && H > 8 && px.size() >= size_t(W) * size_t(H) * 4 && capture_ < int(shots_.size())) {
    // (box-filtered down to at most 2048 across)
    const int k = std::max(1, (W + 2047) / 2048), w2 = W / k, h2 = H / k;
    std::vector<uint8_t> o(size_t(w2) * size_t(h2) * 4);
    for (int y = 0; y < h2; y++) for (int x = 0; x < w2; x++) {
      unsigned acc[3] = {0, 0, 0};
      for (int j = 0; j < k; j++) for (int i = 0; i < k; i++) { const uint8_t* q = &px[(size_t(y * k + j) * size_t(W) + size_t(x * k + i)) * 4]; acc[0] += q[0]; acc[1] += q[1]; acc[2] += q[2]; }
      uint8_t* d = &o[(size_t(y) * size_t(w2) + size_t(x)) * 4];
      for (int ch = 0; ch < 3; ch++) d[ch] = uint8_t(acc[ch] / unsigned(k * k));
      d[3] = 255;
    }
    gfx::TextureDesc d;
    d.width = w2; d.height = h2; d.format = gfx::TexFormat::SRGBA8; d.wrap = gfx::Wrap::Clamp;
    tex_[size_t(capture_)] = c_.dev->createTexture(d, o.data());
    tanH_[size_t(capture_)] = std::tan(shots_[size_t(capture_)].halfAngle * float(DEG));
    tanV_[size_t(capture_)] = tanH_[size_t(capture_)] * float(H) / float(W);
  }
  SL_INFO("window view: photograph %d of %zu taken (%d x %d)", capture_ + 1, shots_.size(), W, H);
  if (++capture_ >= int(shots_.size())) finish();
}

// one mesh per photograph: its panes as grids (their texture coordinates are set from the eye in draw)
void WindowView::build() {
  meshes_.clear();
  if (!c_.dev) return;
  for (size_t s = 0; s < shots_.size(); s++) {
    if (!tex_[s].id) continue;
    Geo g;
    for (const Pane& p : panes_) {
      if (p.shot != int(s)) continue;
      const vec3 n = glm::normalize(vec3(p.m * vec4(0, 0, 1, 0)));
      const uint32_t base = uint32_t(g.pos.size());
      for (int j = 0; j <= NY; j++) for (int i = 0; i <= NX; i++) {
        g.pos.push_back(vec3(p.m * vec4((float(i) / NX - 0.5f) * p.w, (float(j) / NY - 0.5f) * p.h, 0, 1)));
        g.nor.push_back(n); g.col.push_back(vec3(1)); g.uv.push_back(vec2(0.5f));
      }
      for (int j = 0; j < NY; j++) for (int i = 0; i < NX; i++) {
        const uint32_t a = base + uint32_t(j * (NX + 1) + i), b = a + 1, c2 = a + uint32_t(NX + 1), d2 = c2 + 1;
        g.idx.insert(g.idx.end(), {a, b, d2, a, d2, c2});
      }
    }
    if (g.idx.empty()) continue;
    Material m;
    m.baseColor = vec4(0, 0, 0, 1); m.roughness = 1; m.metallic = 0; m.doubleSided = true;
    m.emissive = vec3(shots_[s].gain); m.emissiveTex = tex_[s];
    Mesh me;
    me.pos = g.pos; me.shot = int(s);
    me.model = buildModel(*c_.dev, {{g, m}}, "window_view");
    // (the vertex buffer as buildModel packs it, kept to rewrite the texture coordinates)
    me.vb.assign(g.pos.size() * STRIDE, 0);
    for (size_t i = 0; i < g.pos.size(); i++) {
      uint8_t* o = &me.vb[i * STRIDE];
      std::memcpy(o, &g.pos[i], 12);
      const int8_t nn[3] = {int8_t(std::lround(g.nor[i].x * 127.f)), int8_t(std::lround(g.nor[i].y * 127.f)), int8_t(std::lround(g.nor[i].z * 127.f))};
      std::memcpy(o + 12, nn, 3);
      o[24] = o[25] = o[26] = 255;
    }
    meshes_.push_back(std::move(me));
  }
  lastEye_ = dvec3(1e30);
}

void WindowView::draw(Renderer& r, const dvec3& origin, const dvec3& eye) {
  // (no photograph: the soft day / night sky of liveportal.js)
  if (c_.shapes) {
    const float day = 1 - float(std::round(std::clamp(double(c_.night), 0.0, 1.0) * 16) / 16);
    const vec3 sky = glm::mix(vec3(0.03f, 0.04f, 0.08f), vec3(1), day) * vec3(0.80f, 0.90f, 1.12f);
    for (const Pane& p : panes_) {
      if (p.shot >= 0 && p.shot < int(tex_.size()) && tex_[size_t(p.shot)].id) continue;
      c_.shapes->oriented(r, Shapes::Kind::Quad, origin, p.m * glm::scale(mat4(1), vec3(p.w, p.h, 1)), vec4(sky * 0.25f, 1), 3.2f * (0.15f + 0.85f * day), false);
    }
  }
  if (meshes_.empty() || !c_.dev) return;
  const dvec3 E = eye - origin;
  if (glm::length(E - lastEye_) > 0.02) {
    lastEye_ = E;
    for (Mesh& me : meshes_) {
      const Shot& s = shots_[size_t(me.shot)];
      const dvec3 n = glm::normalize(dvec3(s.local)), rt = glm::normalize(glm::cross(n, dvec3(0, 1, 0)));
      const double tH = tanH_[size_t(me.shot)], tV = tanV_[size_t(me.shot)];
      for (size_t i = 0; i < me.pos.size(); i++) {
        // (the ray from your eye through the glass meets the scene on a plane `depth` beyond it; from the photograph's
        // own eye that point lies along d)
        dvec3 d = dvec3(me.pos[i]) - E;
        const double dn = glm::dot(d, n);
        if (s.depth > 0 && dn > 0.02) d = dvec3(me.pos[i]) + d * (double(s.depth) / dn) - dvec3(s.eyeLocal);
        const double zc = std::max(0.05, glm::dot(d, n));
        const vec2 uv(float(0.5 + 0.5 * glm::dot(d, rt) / (zc * tH)), float(0.5 + 0.5 * d.y / (zc * tV)));
        std::memcpy(&me.vb[i * STRIDE + 16], &uv, 8);
      }
      if (me.model && !me.model->meshes.empty() && !me.model->meshes[0].primitives.empty())
        c_.dev->updateBuffer(me.model->meshes[0].primitives[0].vbo, me.vb.data(), me.vb.size());
    }
  }
  for (const Mesh& me : meshes_) if (me.model) r.submitModel(*me.model, origin, mat4(1), nullptr, false);
}

} // namespace sl
