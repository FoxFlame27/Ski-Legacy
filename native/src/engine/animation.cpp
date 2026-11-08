#include "engine/model.h"
#include <algorithm>

namespace sl {

void Model::restPose(Pose& p) const {
  size_t n = nodes.size();
  p.t.resize(n); p.r.resize(n); p.s.resize(n);
  for (size_t i = 0; i < n; i++) { p.t[i] = nodes[i].t; p.r[i] = nodes[i].r; p.s[i] = nodes[i].s; }
}

void Model::finishPose(Pose& p) const {
  size_t n = nodes.size();
  p.global.resize(n);
  // nodes are stored parents-first (AssetManager sorts them), so one pass suffices
  for (size_t i = 0; i < n; i++) {
    mat4 local = glm::translate(mat4(1), p.t[i]) * glm::mat4_cast(p.r[i]) * glm::scale(mat4(1), p.s[i]);
    p.global[i] = nodes[i].parent >= 0 ? p.global[size_t(nodes[i].parent)] * local : local;
  }
  if (!skins.empty()) {
    const Skin& sk = skins[0];
    p.joints.resize(sk.joints.size());
    for (size_t j = 0; j < sk.joints.size(); j++) p.joints[j] = p.global[size_t(sk.joints[j])] * sk.inverseBind[j];
  }
}

mat4 Model::fitTransform(float size, int axis, bool centerY) const {
  vec3 dim = bmax - bmin;
  float ext = axis == 3 ? std::max(dim.x, dim.z) : dim[axis];
  float s = ext > 1e-6f ? size / ext : 1.f;
  vec3 c = (bmin + bmax) * 0.5f;
  vec3 off(-c.x, centerY ? -c.y : -bmin.y, -c.z);
  return glm::scale(mat4(1), vec3(s)) * glm::translate(mat4(1), off);
}

std::vector<int> bindClip(const Model& target, const AnimClip& clip) {
  std::vector<int> out;
  out.reserve(clip.channels.size());
  for (auto& ch : clip.channels) out.push_back(target.findNode(ch.node));
  return out;
}

void sampleClip(const Model& target, const AnimClip& clip, float t, float w, Pose& pose, const std::vector<int>& nodesOf) {
  if (clip.duration > 0) { t = std::fmod(t, clip.duration); if (t < 0) t += clip.duration; }
  for (size_t c = 0; c < clip.channels.size(); c++) {
    int node = nodesOf[c];
    if (node < 0) continue;
    const AnimChannel& ch = clip.channels[c];
    const auto& T = ch.times;
    if (T.empty()) continue;
    size_t k1 = size_t(std::upper_bound(T.begin(), T.end(), t) - T.begin());
    size_t k0 = k1 == 0 ? 0 : k1 - 1;
    if (k1 >= T.size()) k1 = T.size() - 1;
    float a = (k1 == k0 || ch.step) ? 0.f : (t - T[k0]) / std::max(1e-6f, T[k1] - T[k0]);
    a = std::clamp(a, 0.f, 1.f);
    const float* v = ch.values.data();
    if (ch.path == AnimChannel::Path::R) {
      quat q0(v[k0 * 4 + 3], v[k0 * 4], v[k0 * 4 + 1], v[k0 * 4 + 2]);
      quat q1(v[k1 * 4 + 3], v[k1 * 4], v[k1 * 4 + 1], v[k1 * 4 + 2]);
      quat q = glm::slerp(q0, q1, a);
      pose.r[size_t(node)] = w >= 1 ? q : glm::slerp(pose.r[size_t(node)], q, w);
    } else {
      vec3 p0(v[k0 * 3], v[k0 * 3 + 1], v[k0 * 3 + 2]), p1(v[k1 * 3], v[k1 * 3 + 1], v[k1 * 3 + 2]);
      vec3 p = glm::mix(p0, p1, a);
      vec3& dst = ch.path == AnimChannel::Path::T ? pose.t[size_t(node)] : pose.s[size_t(node)];
      dst = w >= 1 ? p : glm::mix(dst, p, w);
    }
  }
}

} // namespace sl
