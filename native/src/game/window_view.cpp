#include "game/window_view.h"
#include "core/log.h"
#include "engine/mesh_kit.h"
#include "game/shapes.h"
#include <algorithm>
#include <cmath>

namespace sl {

void WindowView::clear() {
  if (c_.dev) for (auto* m : {&mesh_, &flip_}) if (*m) for (auto& mesh : (*m)->meshes) for (Primitive& p : mesh.primitives) { c_.dev->destroy(p.input); c_.dev->destroy(p.vbo); c_.dev->destroy(p.ibo); }
  mesh_.reset(); flip_.reset();
  panes_.clear();
  where_ = nullptr;
  outdoors_ = has_ = false;
  rect_ = vec4(0); tick_ = 0;
}

void WindowView::begin(std::vector<Pane> panes, Where where, const vec3& tint) {
  clear();
  panes_ = std::move(panes); where_ = std::move(where); tint_ = tint; rate = 3;
  if (!walked()) { clear(); return; }
  place_ = where_(dvec3(0, 1.6, 0));
  focus_ = dvec3(place_.frame * glm::dvec4(0, 1.6, 0, 1));
  out_ = Camera{};
  out_.pos = focus_;
  build();
  if (misty) SL_INFO("window view: %zu panes, misty", panes_.size());
  else SL_INFO("window view: %zu panes, live, the room stands at %.1f %.1f %.1f", panes_.size(), focus_.x, focus_.y, focus_.z);
}

// every pane as a quad of one mesh: the material (shading 9) shows the portal target by the pixel's place on the screen
// (misty: metallic 1, the frosted pane; its vertex colour carries the pane's size in metres for the frost round the edges)
void WindowView::build() {
  if (!c_.dev) return;
  Geo g;
  for (const Pane& p : panes_) {
    const vec3 n = glm::normalize(vec3(p.m * vec4(0, 0, 1, 0)));
    const uint32_t b = uint32_t(g.pos.size());
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
      g.pos.push_back(vec3(p.m * vec4((float(i) - 0.5f) * p.w, (float(j) - 0.5f) * p.h, 0, 1)));
      g.nor.push_back(n); g.col.push_back(vec3(p.w, p.h, 0)); g.uv.push_back(vec2(float(i), float(j)));
    }
    g.idx.insert(g.idx.end(), {b, b + 1, b + 3, b, b + 3, b + 2});
  }
  if (g.idx.empty()) return;
  Material m;
  m.baseColor = vec4(0, 0, 0, 1); m.roughness = 1; m.metallic = misty ? 1.f : 0.f; m.doubleSided = true;
  m.shading = 9; m.emissive = tint_;
  mesh_ = buildModel(*c_.dev, {{g, m}}, "window_view");
  // (a polished floor's mirror image of the glass: the web game's Reflector draws the room from below, where the
  // planes show the picture by their place in that image: upside down on the screen)
  m.normalScale = -1;
  flip_ = buildModel(*c_.dev, {{g, m}}, "window_view_mirror");
}

void WindowView::carry(const Camera& cam, const dvec3& origin) {
  if (!live()) return;
  const dvec3 eye = cam.pos - origin;
  place_ = where_(eye);
  const glm::dmat4& F = place_.frame;
  out_ = cam;
  out_.pos = dvec3(F * glm::dvec4(eye, 1));
  out_.basis = mat3(glm::dmat3(F) * glm::dmat3(cam.basis));
  out_.nearZ = place_.nearZ; out_.farZ = 30000;
  focus_ = dvec3(F * glm::dvec4(0, 1.6, 0, 1));
}

bool WindowView::inView(const Camera& cam, const dvec3& origin, vec4* rect) const {
  if (!live()) return false;
  const mat4 vp = cam.proj() * cam.view();
  const vec3 o = vec3(origin - cam.pos);
  bool any = false;
  vec4 r(1, 1, -1, -1);
  for (const Pane& p : panes_) {
    int out[6] = {0, 0, 0, 0, 0, 0};
    vec4 q[4];
    for (int k = 0; k < 4; k++) {
      q[k] = vp * vec4(o + vec3(p.m * vec4((float(k & 1) - 0.5f) * p.w, (float(k >> 1) - 0.5f) * p.h, 0, 1)), 1);
      out[0] += q[k].x < -q[k].w; out[1] += q[k].x > q[k].w; out[2] += q[k].y < -q[k].w; out[3] += q[k].y > q[k].w; out[4] += q[k].z < -q[k].w; out[5] += q[k].z > q[k].w;
    }
    if (std::any_of(out, out + 6, [](int n) { return n == 4; })) continue;
    any = true;
    // (its part of the screen: a corner behind the eye, the whole screen)
    for (const vec4& c : q) {
      if (c.w < 0.05f) { r = vec4(-1, -1, 1, 1); break; }
      const vec2 s = vec2(c) / c.w;
      r = vec4(std::min(r.x, s.x), std::min(r.y, s.y), std::max(r.z, s.x), std::max(r.w, s.y));
    }
  }
  if (rect) *rect = vec4(std::max(r.x, -1.f), std::max(r.y, -1.f), std::min(r.z, 1.f), std::min(r.w, 1.f));
  return any;
}

bool WindowView::due(vec4& rect) {
  constexpr float M = 0.1f;   // (the margin: a turn of the head between two pictures stays inside it)
  const bool inside = rect.x >= rect_.x && rect.y >= rect_.y && rect.z <= rect_.z && rect.w <= rect_.w;
  rect = vec4(std::max(-1.f, rect.x - M), std::max(-1.f, rect.y - M), std::min(1.f, rect.z + M), std::min(1.f, rect.w + M));
  // (every other frame; every third / fourth while the world's pass costs more: liveportal.js draws its view every
  // third frame and switches it off when slow; here it only slows down)
  const int every = std::clamp(rate + int(cost_ / 5.0), rate, rate + 3);   // (a costly view (the shop's village behind the counter) slows down sooner)
  if (has_ && inside && ++tick_ < every) return false;
  tick_ = 0; rect_ = rect;
  return true;
}

void WindowView::drawnFor(const Camera& roomCam) { vp_ = roomCam.proj() * roomCam.view(); eye_ = roomCam.pos; }

void WindowView::bindView(Renderer& r, const Camera& roomCam) const { r.setPortalView(vp_, vec3(roomCam.pos - eye_)); }

void WindowView::beginOutdoors(Renderer& r) {
  outdoors_ = true;
  if (place_.boxH.x > 0) {
    const glm::dmat4& F = place_.frame;
    r.setClipBox(dvec3(F * glm::dvec4(place_.boxC, 1)), place_.boxH, std::atan2(F[2][0], F[2][2]));
  }
}

void WindowView::endOutdoors(Renderer& r) {
  r.endPortal();
  outdoors_ = false;
  has_ = bool(r.portalTexture());
}

// the misty pane's light (display-referred, before the room's exposure): bright cool grey by day, warmer and dimmer
// at dusk and dawn, a dark blue-grey at night
static vec3 mistyLight(double hour, float night) {
  const double h = std::fmod(std::fmod(hour, 24.0) + 24.0, 24.0);
  const float dusk = float(std::max(std::exp(-std::pow((h - 17.6) / 1.1, 2.0)), std::exp(-std::pow((h - 7.2) / 0.9, 2.0))));
  const float n = std::clamp(night, 0.f, 1.f);
  vec3 c = glm::mix(vec3(0.46f, 0.50f, 0.56f), vec3(0.62f, 0.46f, 0.36f) * 0.55f, dusk * (1 - n));
  return glm::mix(c, vec3(0.035f, 0.045f, 0.075f), n);
}

void WindowView::draw(Renderer& r, const dvec3& origin, bool mirror) {
  const mat4 M = mirror ? glm::scale(mat4(1), vec3(1, -1, 1)) : mat4(1);
  const std::shared_ptr<Model>& model = mirror ? flip_ : mesh_;
  if (misty && walked() && model) {
    const vec3 c = mistyLight(c_.hour, c_.night) * gain * (mirror ? 0.6f : 1.f);
    for (Material& m : model->materials) m.emissive = c;
    r.submitModel(*model, origin, M, nullptr, false);
    return;
  }
  if (!live()) return;
  if (has_ && model && r.portalTexture()) {
    for (Material& m : model->materials) { m.emissiveTex = r.portalTexture(); m.emissive = tint_ * gain; }
    r.occlusionTag = true;   // (is any of the glass on the screen: else the next pictures are not drawn)
    r.submitModel(*model, origin, M, nullptr, false);
    r.occlusionTag = false;
    return;
  }
  // (no view yet, or none in this frame: the soft day / night sky of liveportal.js)
  if (!c_.shapes) return;
  const float day = 1 - float(std::round(std::clamp(double(c_.night), 0.0, 1.0) * 16) / 16);
  const vec3 sky = glm::mix(vec3(0.03f, 0.04f, 0.08f), vec3(1), day) * vec3(0.80f, 0.90f, 1.12f);
  for (const Pane& p : panes_)
    c_.shapes->oriented(r, Shapes::Kind::Quad, origin, M * p.m * glm::scale(mat4(1), vec3(p.w, p.h, 1)), vec4(sky * 0.25f, 1), 3.2f * (0.15f + 0.85f * day), false);
}

} // namespace sl
