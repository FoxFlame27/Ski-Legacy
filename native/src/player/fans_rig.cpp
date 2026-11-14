// fans.js FanKit / FanCrowd (the dynamic crowd's posing): see fans_rig.h.
#include "player/fans_rig.h"
#include "core/log.h"
#include "gfx/gfx.h"
#include <cgltf.h>
#include <meshoptimizer.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <queue>
#include <unordered_map>

namespace sl {
using namespace three;
using namespace fans;

namespace fans {
const char* const BONE_NAMES[NBA] = {"Hips", "Spine02", "Spine01", "Spine", "neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
                                     "RightShoulder", "RightArm", "RightForeArm", "RightHand", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg",
                                     "RightLeg", "RightFoot"};
const char* const MODELS[8] = {"fan_man", "fan_woman", "fan_elder", "fan_girl", "fan_kid", "fan_lady", "fan_teen", "fan_skier"};
const char* const JACKETS[13] = {"#b3201b", "#1c2a4a", "#2050b8", "#4f8fcf", "#d9a91d", "#d8601a", "#2c6e45",
                                 "#5a3384", "#c73a6e", "#6b1d28", "#1f7a80", "#c8261d", "#0f3d91"};
} // namespace fans

namespace {
const int UPPER[13] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13};
const int LOWER[7] = {0, 14, 15, 16, 17, 18, 19};
const V3 X_AXIS(1, 0, 0), Y_AXIS(0, 1, 0), Z_AXIS(0, 0, 1);
const V3 CARRY_REST(0, -0.045, -0.2);   // the skis' resting point on the shoulder in their own frame
V3 carryDir() { return normalize(V3(0.07, -std::tan(0.42), 1)); }
/// fans.js smoothstep(a, b, x)
double sstep(double a, double b, double x) { double t = std::max(0.0, std::min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
double jsRound(double x) { return std::floor(x + 0.5); }   // Math.round
double jsMod1(double x) { return std::fmod(x, 1.0); }      // x % 1
int boneIndex(const std::string& n) {
  for (int i = 0; i < NBA; i++) if (n == BONE_NAMES[i]) return i;
  return -1;
}
struct CfgRow { const char* name; double share, s0, s1, keep; };
const CfgRow FAN_CFG[8] = {{"fan_man", 1.1, 0.96, 1.04, 0.3},  {"fan_woman", 1.0, 0.97, 1.04, 0.3}, {"fan_elder", 0.7, 0.97, 1.03, 0.35},
                           {"fan_girl", 0.85, 0.97, 1.04, 1},  {"fan_kid", 0.35, 0.9, 1.06, 0.5},   {"fan_lady", 0.6, 0.97, 1.03, 0.35},
                           {"fan_teen", 0.75, 0.97, 1.04, 0.4}, {"fan_skier", 0.85, 0.97, 1.03, 0.3}};

// ---- the GLB, read as three's GLTFLoader reads it (normalized integers decoded in double: BufferAttribute.getX)
bool decodeMeshopt(cgltf_data* d) {
  for (cgltf_size i = 0; i < d->buffer_views_count; i++) {
    cgltf_buffer_view& bv = d->buffer_views[i];
    if (!bv.has_meshopt_compression) continue;
    cgltf_meshopt_compression& mc = bv.meshopt_compression;
    const uint8_t* src = static_cast<const uint8_t*>(mc.buffer->data) + mc.offset;
    void* dst = malloc(mc.count * mc.stride);
    int rc = -1;
    switch (mc.mode) {
      case cgltf_meshopt_compression_mode_attributes: rc = meshopt_decodeVertexBuffer(dst, mc.count, mc.stride, src, mc.size); break;
      case cgltf_meshopt_compression_mode_triangles: rc = meshopt_decodeIndexBuffer(dst, mc.count, mc.stride, src, mc.size); break;
      case cgltf_meshopt_compression_mode_indices: rc = meshopt_decodeIndexSequence(dst, mc.count, mc.stride, src, mc.size); break;
      default: break;
    }
    if (rc != 0) { free(dst); return false; }
    switch (mc.filter) {
      case cgltf_meshopt_compression_filter_octahedral: meshopt_decodeFilterOct(dst, mc.count, mc.stride); break;
      case cgltf_meshopt_compression_filter_quaternion: meshopt_decodeFilterQuat(dst, mc.count, mc.stride); break;
      case cgltf_meshopt_compression_filter_exponential: meshopt_decodeFilterExp(dst, mc.count, mc.stride); break;
      default: break;
    }
    bv.data = dst;   // (cgltf_free releases it)
  }
  return true;
}
double readComp(const cgltf_accessor* a, size_t i, int c) {
  const uint8_t* p = cgltf_buffer_view_data(a->buffer_view) + a->offset + i * a->stride;
  switch (a->component_type) {
    case cgltf_component_type_r_32f: { float v; std::memcpy(&v, p + c * 4, 4); return v; }
    case cgltf_component_type_r_16: { int16_t v; std::memcpy(&v, p + c * 2, 2); return a->normalized ? std::max(v / 32767.0, -1.0) : v; }
    case cgltf_component_type_r_16u: { uint16_t v; std::memcpy(&v, p + c * 2, 2); return a->normalized ? v / 65535.0 : v; }
    case cgltf_component_type_r_8: { int8_t v; std::memcpy(&v, p + c, 1); return a->normalized ? std::max(v / 127.0, -1.0) : v; }
    case cgltf_component_type_r_8u: { uint8_t v = p[c]; return a->normalized ? v / 255.0 : v; }
    case cgltf_component_type_r_32u: { uint32_t v; std::memcpy(&v, p + c * 4, 4); return v; }
    default: return 0;
  }
}

/// a JS Map<bone, weight> (insertion order kept: the stable sort of fans.js breaks ties by it)
struct WMap {
  std::vector<std::pair<int, double>> e;
  double get(int b) const { for (auto& x : e) if (x.first == b) return x.second; return 0; }
  bool has(int b) const { for (auto& x : e) if (x.first == b) return true; return false; }
  void set(int b, double w) { for (auto& x : e) if (x.first == b) { x.second = w; return; } e.push_back({b, w}); }
  void del(int b) { for (size_t k = 0; k < e.size(); k++) if (e[k].first == b) { e.erase(e.begin() + long(k)); return; } }
};
bool inTorso(int b) { return b == Hips || b == Spine02 || b == Spine01 || b == Spine || b == neck || b == LeftUpLeg || b == RightUpLeg; }
bool inFarArm(int b) { return b == LeftForeArm || b == LeftHand || b == RightForeArm || b == RightHand; }
const int TRUNK[4] = {Hips, Spine02, Spine01, Spine};

// fans.js separateArms: an upper-arm weight is kept only on the arm's own side of the armpit seam (geodesic distances
// over the welded mesh from the forearms / hands and from the trunk), the rest goes to the vertex's main trunk bone
void separateArms(const std::vector<float>& P, size_t n, const std::vector<uint32_t>& index, std::vector<WMap>& WB) {
  struct K { int64_t a, b, c; bool operator==(const K& o) const { return a == o.a && b == o.b && c == o.c; } };
  struct H { size_t operator()(const K& k) const { return std::hash<int64_t>()(k.a * 73856093 ^ k.b * 19349663 ^ k.c * 83492791); } };
  std::unordered_map<K, int, H> key;
  std::vector<int> wid(n), rep;
  for (size_t i = 0; i < n; i++) {
    K k{int64_t(jsRound(double(P[i * 3]) * 1e4)), int64_t(jsRound(double(P[i * 3 + 1]) * 1e4)), int64_t(jsRound(double(P[i * 3 + 2]) * 1e4))};
    auto it = key.find(k);
    int id;
    if (it == key.end()) { id = int(rep.size()); key[k] = id; rep.push_back(int(i)); } else id = it->second;
    wid[i] = id;
  }
  const size_t m = rep.size();
  std::vector<int> deg(m + 1, 0), E;
  for (size_t t = 0; t + 2 < index.size(); t += 3)
    for (int e = 0; e < 3; e++) {
      int a = wid[index[t + size_t(e)]], b = wid[index[t + size_t((e + 1) % 3)]];
      if (a != b) { E.push_back(a); E.push_back(b); deg[size_t(a)]++; deg[size_t(b)]++; }
    }
  std::vector<int> off(m + 1, 0);
  for (size_t i = 0; i < m; i++) off[i + 1] = off[i] + deg[i];
  const size_t ne = size_t(off[m]);
  std::vector<int> nb(ne), fill(off.begin(), off.begin() + long(m));
  std::vector<double> len(ne);
  for (size_t k = 0; k < E.size(); k += 2) {
    int a = E[k], b = E[k + 1];
    size_t ra = size_t(rep[size_t(a)]) * 3, rb = size_t(rep[size_t(b)]) * 3;
    double d = std::hypot(double(P[ra]) - double(P[rb]), double(P[ra + 1]) - double(P[rb + 1]), double(P[ra + 2]) - double(P[rb + 2]));
    nb[size_t(fill[size_t(a)])] = b; len[size_t(fill[size_t(a)]++)] = d;
    nb[size_t(fill[size_t(b)])] = a; len[size_t(fill[size_t(b)]++)] = d;
  }
  auto W = [&](size_t id, const int* bones, int nb_) { double s = 0; const WMap& wb = WB[size_t(rep[id])]; for (int k = 0; k < nb_; k++) s += wb.get(bones[k]); return s; };
  auto dist = [&](const std::function<bool(size_t)>& seed) {
    std::vector<double> d(m, INFINITY);
    using E2 = std::pair<double, int>;
    std::priority_queue<E2, std::vector<E2>, std::greater<E2>> heap;
    for (size_t i = 0; i < m; i++) if (seed(i)) { d[i] = 0; heap.push({0, int(i)}); }
    while (!heap.empty()) {
      auto [du, u] = heap.top();
      heap.pop();
      if (du > d[size_t(u)]) continue;
      for (int k = off[size_t(u)]; k < off[size_t(u) + 1]; k++) {
        int v = nb[size_t(k)];
        double dv = du + len[size_t(k)];
        if (dv < d[size_t(v)]) { d[size_t(v)] = dv; heap.push({dv, v}); }
      }
    }
    return d;
  };
  const std::vector<double> dT = dist([&](size_t i) { return W(i, TRUNK, 4) >= 0.9; });
  for (int side = 0; side < 2; side++) {
    const int up = side == 0 ? LeftArm : RightArm;
    const int far[2] = {side == 0 ? LeftForeArm : RightForeArm, side == 0 ? LeftHand : RightHand};
    const std::vector<double> dA = dist([&](size_t i) { return W(i, far, 2) >= 0.5; });
    for (size_t i = 0; i < n; i++) {
      WMap& wb = WB[i];
      double w = wb.get(up);
      if (!(w != 0)) continue;
      double a = dA[size_t(wid[i])], b = dT[size_t(wid[i])];
      if (!std::isfinite(b)) continue;   // no trunk on this piece: leave it
      double armness = std::isfinite(a) ? b / (a + b + 1e-6) : 0;
      double keep = sstep(0.3, 0.55, armness);
      if (keep >= 1) continue;
      int to = Spine;
      double best = -1;
      for (int tb : TRUNK) { double tw = wb.get(tb); if (tw > best) { best = tw; to = tb; } }
      if (best <= 0) to = Spine;
      wb.set(up, w * keep);
      wb.set(to, wb.get(to) + w * (1 - keep));
      if (!(wb.get(up) != 0)) wb.del(up);
    }
  }
}
// fans.js cleanWeights: a vertex is either on the body or on the arm
void cleanWeights(WMap& wb) {
  double wt = 0, wa = 0, mt = 0, ma = 0;
  int bt = -1, ba = -1;
  for (auto& [b, w] : wb.e) {
    if (inTorso(b)) { wt += w; if (w > mt) { mt = w; bt = b; } }
    else if (inFarArm(b)) { wa += w; if (w > ma) { ma = w; ba = b; } }
  }
  if (!(wt != 0) || !(wa != 0)) return;
  bool dropArm = wt >= wa;
  int to = dropArm ? bt : ba;
  double moved = 0;
  std::vector<std::pair<int, double>> keep;
  for (auto& x : wb.e) {
    if (dropArm ? inFarArm(x.first) : inTorso(x.first)) moved += x.second;
    else keep.push_back(x);
  }
  wb.e.swap(keep);
  wb.set(to, wb.get(to) + moved);
}
double angDiff(double a, double b) { double d = a - b; while (d > PI) d -= 2 * PI; while (d < -PI) d += 2 * PI; return d; }
V3 smallestEigen(const double m[3][3]) {
  const double t = m[0][0] + m[1][1] + m[2][2];
  V3 v(0.3, 0.5, 0.8);
  for (int it = 0; it < 60; it++) {
    double x = (t - m[0][0]) * v.x - m[0][1] * v.y - m[0][2] * v.z;
    double y = -m[1][0] * v.x + (t - m[1][1]) * v.y - m[1][2] * v.z;
    double z = -m[2][0] * v.x - m[2][1] * v.y + (t - m[2][2]) * v.z;
    v = normalize(V3(x, y, z));
  }
  return v;
}
double srgbToLinear(double c) { return c < 0.04045 ? c * 0.0773993808 : std::pow(c * 0.9478672986 + 0.0521327014, 2.4); }
} // namespace

// ================================================================ the scene graph (three's Object3D / Bone)
M4 FanKit::world(int n) const {
  if (ok_[size_t(n)]) return W_[size_t(n)];
  const Node& d = nodes_[size_t(n)];
  M4 m = compose(d.t, d.r, d.s);
  if (d.parent >= 0) m = world(d.parent) * m;
  W_[size_t(n)] = m;
  ok_[size_t(n)] = 1;
  return m;
}
void FanKit::setWorldQuat(int n, const Q& q) {
  Q p = wquat(nodes_[size_t(n)].parent);
  nodes_[size_t(n)].r = qnormalize(mul(conj(p), q));
  touch();
}
void FanKit::rotateWorld(int n, const V3& axis, double angle) { setWorldQuat(n, mul(axisAngle(axis, angle), wquat(n))); }
void FanKit::aimBone(int n, const V3& from, const V3& to, const V3& pivot) {
  V3 u = normalize(from - pivot), w = normalize(to - pivot);
  if (lengthSq(u) < 1e-8 || lengthSq(w) < 1e-8) return;
  Q q = fromUnitVectors(u, w);
  setWorldQuat(n, mul(q, wquat(n)));
}
// two-bone IK: the middle joint toward `pole`, then aim both bones (minimal rotations)
void FanKit::solveTwoBone(int a, int b, int c, const V3& target, const V3& pole, double maxReach) {
  V3 pa = wpos(a), pb = wpos(b), pc = wpos(c);
  double lab = glm::length(pa - pb), lcb = glm::length(pb - pc);
  V3 dir = target - pa;
  double dist = std::max(std::fabs(lab - lcb) + 1e-3, std::min(std::min(maxReach, (lab + lcb) * 0.999), glm::length(dir)));
  dir = normalize(dir);
  double cosA = std::max(-1.0, std::min(1.0, (lab * lab + dist * dist - lcb * lcb) / (2 * lab * dist)));
  double sinA = std::sqrt(1 - cosA * cosA);
  V3 pp = pole + dir * -glm::dot(pole, dir);
  if (lengthSq(pp) < 1e-8) pp = V3(0, 0, 1) + dir * -dir.z;
  pp = normalize(pp);
  V3 knee = pa + dir * (lab * cosA) + pp * (lab * sinA);
  aimBone(a, pb, knee, pa);
  V3 pb2 = wpos(b), pc2 = wpos(c);
  aimBone(b, pc2, pa + dir * dist, pb2);
}
V3 FanKit::worldToLocal(int n, const V3& p) const { return mulPoint(glm::inverse(world(n)), p); }

// ================================================================ the kit
bool FanKit::build(const std::string& nm, const std::vector<uint8_t>& glb) {
  auto t0 = std::chrono::steady_clock::now();
  name = nm;
  for (auto& c : FAN_CFG) if (name == c.name) cfg = {c.share, c.s0, c.s1, c.keep};
  cgltf_options co{};
  cgltf_data* d = nullptr;
  if (cgltf_parse(&co, glb.data(), glb.size(), &d) != cgltf_result_success) { SL_WARN("fan kit %s: bad GLB", name.c_str()); return false; }
  std::unique_ptr<cgltf_data, void (*)(cgltf_data*)> guard(d, cgltf_free);
  if (cgltf_load_buffers(&co, d, nullptr) != cgltf_result_success || !decodeMeshopt(d)) { SL_WARN("fan kit %s: GLB buffers", name.c_str()); return false; }
  // node TRS in double, as JSON.parse reads them
  auto J = nlohmann::json::parse(std::string(d->json, d->json_size), nullptr, false);
  if (J.is_discarded() || !J.contains("nodes")) return false;
  const size_t nn = d->nodes_count;
  nodes_.assign(nn, Node{});
  for (size_t i = 0; i < nn; i++) {
    const cgltf_node& c = d->nodes[i];
    Node& o = nodes_[i];
    o.name = c.name ? c.name : "";
    o.parent = c.parent ? int(c.parent - d->nodes) : -1;
    for (cgltf_size k = 0; k < c.children_count; k++) o.children.push_back(int(c.children[k] - d->nodes));
    const auto& jn = J["nodes"][i];
    if (jn.contains("translation")) o.t = V3(jn["translation"][0].get<double>(), jn["translation"][1].get<double>(), jn["translation"][2].get<double>());
    if (jn.contains("rotation")) o.r = Q(jn["rotation"][3].get<double>(), jn["rotation"][0].get<double>(), jn["rotation"][1].get<double>(), jn["rotation"][2].get<double>());
    if (jn.contains("scale")) o.s = V3(jn["scale"][0].get<double>(), jn["scale"][1].get<double>(), jn["scale"][2].get<double>());
    if (jn.contains("matrix")) {
      M4 m(1);
      for (int k = 0; k < 16; k++) m[k / 4][k % 4] = jn["matrix"][size_t(k)].get<double>();
      o.t = V3(m[3]); o.r = decomposeQ(m); o.s = decomposeS(m);
    }
    o.mesh = c.mesh ? int(c.mesh - d->meshes) : -1;
    o.skin = c.skin ? int(c.skin - d->skins) : -1;
  }
  for (cgltf_size s = 0; s < d->skins_count; s++) {
    Skin sk;
    for (cgltf_size j = 0; j < d->skins[s].joints_count; j++) {
      int n = int(d->skins[s].joints[j] - d->nodes);
      sk.joints.push_back(n);
      nodes_[size_t(n)].bone = true;
      M4 inv(1);
      if (d->skins[s].inverse_bind_matrices) {
        float f[16];
        cgltf_accessor_read_float(d->skins[s].inverse_bind_matrices, j, f, 16);
        for (int k = 0; k < 16; k++) inv[k / 4][k % 4] = f[k];
      }
      sk.inv.push_back(inv);
    }
    skins_.push_back(std::move(sk));
  }
  const cgltf_scene* scene = d->scene ? d->scene : d->scenes_count ? &d->scenes[0] : nullptr;
  if (scene) for (cgltf_size k = 0; k < scene->nodes_count; k++) roots_.push_back(int(scene->nodes[k] - d->nodes));
  else for (size_t i = 0; i < nn; i++) if (nodes_[i].parent < 0) roots_.push_back(int(i));
  W_.assign(nn, M4(1));
  ok_.assign(nn, 0);
  // traversal (three's root.traverse: pre-order): the skinned meshes (a primitive each) and the bones
  std::function<void(int)> visit = [&](int n) {
    const Node& nd = nodes_[size_t(n)];
    if (nd.bone) allBones_.push_back(n);
    if (nd.mesh >= 0 && nd.skin >= 0) {
      const cgltf_mesh& mesh = d->meshes[size_t(nd.mesh)];
      for (cgltf_size p = 0; p < mesh.primitives_count; p++) {
        const cgltf_primitive& pr = mesh.primitives[p];
        if (pr.type != cgltf_primitive_type_triangles) continue;
        Prim o;
        o.node = n; o.skin = nd.skin; o.material = pr.material ? int(pr.material - d->materials) : 0;
        const cgltf_accessor *pos = nullptr, *nor = nullptr, *uv = nullptr, *col = nullptr, *jnt = nullptr, *wgt = nullptr;
        for (cgltf_size a = 0; a < pr.attributes_count; a++) {
          const cgltf_attribute& at = pr.attributes[a];
          if (at.type == cgltf_attribute_type_position) pos = at.data;
          else if (at.type == cgltf_attribute_type_normal) nor = at.data;
          else if (at.type == cgltf_attribute_type_texcoord && at.index == 0) uv = at.data;
          else if (at.type == cgltf_attribute_type_color && at.index == 0) col = at.data;
          else if (at.type == cgltf_attribute_type_joints && at.index == 0) jnt = at.data;
          else if (at.type == cgltf_attribute_type_weights && at.index == 0) wgt = at.data;
        }
        if (!pos || !nor || !jnt || !wgt || !pr.indices) continue;
        o.count = pos->count;
        o.hasUv = uv; o.hasCol = col;
        o.pos.resize(o.count * 3); o.nor.resize(o.count * 3); o.w.resize(o.count * 4); o.j.resize(o.count * 4);
        if (uv) o.uv.resize(o.count * 2);
        if (col) o.col.resize(o.count * 3);
        for (size_t v = 0; v < o.count; v++) {
          for (int c = 0; c < 3; c++) { o.pos[v * 3 + size_t(c)] = readComp(pos, v, c); o.nor[v * 3 + size_t(c)] = readComp(nor, v, c); }
          for (int c = 0; c < 4; c++) { o.w[v * 4 + size_t(c)] = readComp(wgt, v, c); o.j[v * 4 + size_t(c)] = int(readComp(jnt, v, c)); }
          if (uv) for (int c = 0; c < 2; c++) o.uv[v * 2 + size_t(c)] = readComp(uv, v, c);
          if (col) for (int c = 0; c < 3; c++) o.col[v * 3 + size_t(c)] = readComp(col, v, c);
        }
        o.idx.resize(pr.indices->count);
        for (cgltf_size k = 0; k < pr.indices->count; k++) o.idx[k] = uint32_t(cgltf_accessor_read_index(pr.indices, k));
        prims_.push_back(std::move(o));
      }
    }
    for (int c : nd.children) visit(c);
  };
  for (int r : roots_) visit(r);
  if (prims_.empty()) { SL_WARN("fan kit %s: no skinned mesh", name.c_str()); return false; }
  // the 20 bones (the last bone of a name, as the JS's lookup), their palette parents
  std::vector<int> named(NBA, -1);
  for (int b : allBones_) { int k = boneIndex(nodes_[size_t(b)].name); if (k >= 0) named[size_t(k)] = b; }
  for (int k = 0; k < NBA; k++) if (named[size_t(k)] < 0) { SL_WARN("fan kit %s: missing bones", name.c_str()); return false; }
  bones_ = named;
  auto pal = [&](int n) {
    while (n >= 0 && !(nodes_[size_t(n)].bone && boneIndex(nodes_[size_t(n)].name) >= 0)) n = nodes_[size_t(n)].parent;
    return n >= 0 ? boneIndex(nodes_[size_t(n)].name) : 0;
  };
  for (int i = 0; i < NBA; i++) parent[i] = int8_t(i == 0 ? -1 : pal(nodes_[size_t(bones_[size_t(i)])].parent));
  for (int i = 1; i < NBA; i++) if (parent[i] >= i) { SL_WARN("fan kit %s: bone order", name.c_str()); return false; }
  for (int b : allBones_) restLocal_.push_back({nodes_[size_t(b)].t, nodes_[size_t(b)].r});

  // rest skeleton (model space)
  for (int i = 0; i < NBA; i++) {
    V3 p = wpos(B(i));
    Q q = wquat(B(i)), qi = conj(q);
    for (int c = 0; c < 3; c++) P0[size_t(i * 3 + c)] = float(p[c]);
    Q0[size_t(i * 4)] = float(q.x); Q0[size_t(i * 4 + 1)] = float(q.y); Q0[size_t(i * 4 + 2)] = float(q.z); Q0[size_t(i * 4 + 3)] = float(q.w);
    Q0i[size_t(i * 4)] = float(qi.x); Q0i[size_t(i * 4 + 1)] = float(qi.y); Q0i[size_t(i * 4 + 2)] = float(qi.z); Q0i[size_t(i * 4 + 3)] = float(qi.w);
  }
  for (int i = 1; i < NBA; i++) {
    int pi = parent[i];
    V3 p = V3(P0[size_t(i * 3)], P0[size_t(i * 3 + 1)], P0[size_t(i * 3 + 2)]) - V3(P0[size_t(pi * 3)], P0[size_t(pi * 3 + 1)], P0[size_t(pi * 3 + 2)]);
    p = applyQ(p, Q(Q0i[size_t(pi * 4 + 3)], Q0i[size_t(pi * 4)], Q0i[size_t(pi * 4 + 1)], Q0i[size_t(pi * 4 + 2)]));
    for (int c = 0; c < 3; c++) O[size_t(i * 3 + c)] = float(p[c]);
  }

  // the LOD geometries: the textured mesh with the most triangles, then the vertex-coloured ones
  std::vector<int> tex, vc;
  for (size_t i = 0; i < prims_.size(); i++) (prims_[i].hasUv ? tex : vc).push_back(int(i));
  auto byCount = [&](int a, int b) { return prims_[size_t(a)].idx.size() > prims_[size_t(b)].idx.size(); };
  std::stable_sort(tex.begin(), tex.end(), byCount);
  std::stable_sort(vc.begin(), vc.end(), byCount);
  if (tex.empty()) { SL_WARN("fan kit %s: no textured mesh", name.c_str()); return false; }
  const int order[3] = {tex[0], !vc.empty() ? vc[0] : tex[0], vc.size() > 1 ? vc[1] : !vc.empty() ? vc[0] : tex[0]};
  measureHands(prims_[0]);
  measureBody();
  measureLegs();
  PropGeo prop = buildProps();
  for (int l = 0; l < 3; l++) { bakeGeometry(prims_[size_t(order[l])], prop, geos[l]); lodMaterial[l] = prims_[size_t(order[l])].material; }
  height = 0;
  for (size_t i = 0; i < geos[0].nBody; i++) height = std::max(height, double(geos[0].P[i * 3 + 1]));
  jacketBase(geos[1]);
  bakeKeyframes();
  resetPose();
  bakeMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return true;
}

void FanKit::resetPose() {
  for (size_t i = 0; i < allBones_.size(); i++) { nodes_[size_t(allBones_[i])].r = restLocal_[i].second; nodes_[size_t(allBones_[i])].t = restLocal_[i].first; }
  touch();
}

std::vector<V3> FanKit::boneVerts(const Prim& m, int bone, double minW) const {
  std::vector<V3> out;
  const Skin& sk = skins_[size_t(m.skin)];
  int j = -1;
  for (size_t k = 0; k < sk.joints.size(); k++) if (sk.joints[k] == bone) { j = int(k); break; }
  if (j < 0) return out;
  // (three's attached bind mode: bindMatrixInverse = the mesh's matrixWorld^-1, bindMatrix the identity: the mesh's own
  // world cancels out)
  M4 C = world(m.node) * glm::inverse(world(m.node)) * (world(bone) * sk.inv[size_t(j)]);
  for (size_t i = 0; i < m.count; i++) {
    double w = 0;
    for (int k = 0; k < 4; k++) if (m.j[i * 4 + size_t(k)] == j) w += m.w[i * 4 + size_t(k)];
    if (w >= minW) out.push_back(mulPoint(C, V3(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2])));
  }
  return out;
}

// hand axes (finger direction, palm normal) in hand-bone space + the grip point, from the rest mesh
void FanKit::measureHands(const Prim& m) {
  for (int s = 0; s < 2; s++) {
    const double side = s == 0 ? 1 : -1;
    const int bone = B(s == 0 ? LeftHand : RightHand);
    const V3 wrist = wpos(bone);
    std::vector<V3> pts = boneVerts(m, bone, 0.5);
    hand[s] = Hand{};
    if (pts.size() < 8) continue;
    V3 c(0);
    for (auto& p : pts) c += p;
    c *= 1.0 / double(pts.size());
    std::vector<double> dd;
    for (auto& p : pts) dd.push_back(glm::length(p - wrist));
    std::sort(dd.begin(), dd.end());
    double far = dd[size_t(std::floor(double(dd.size()) * 0.6))];
    V3 tip(0);
    int nt = 0;
    for (auto& p : pts) if (glm::length(p - wrist) >= far) { tip += p; nt++; }
    tip *= 1.0 / nt;
    V3 F = normalize(tip - wrist);
    double cov[3][3] = {};
    for (auto& p : pts) { double e[3] = {p.x - c.x, p.y - c.y, p.z - c.z}; for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) cov[i][j] += e[i] * e[j]; }
    V3 Nn = smallestEigen(cov);
    Nn = normalize(Nn + F * -glm::dot(Nn, F));
    if (Nn.x * side > 0) Nn = -Nn;   // left hand (+x side): palm faces -x (inward)
    Q Qi = conj(wquat(bone));
    V3 grip = c + F * 0.01 + Nn * 0.035;
    hand[s] = {true, applyQ(F, Qi), applyQ(Nn, Qi), applyQ(grip - wrist, Qi), grip, glm::length(tip - wrist)};
  }
  G = hand[1].ok ? hand[1].gripRest : wpos(B(RightHand));
  gripLocal = hand[1].ok ? hand[1].grip : V3(0);
}

void FanKit::measureLegs() {
  for (int k = 0; k < 2; k++) {
    int u = B(k == 0 ? LeftUpLeg : RightUpLeg), l = B(k == 0 ? LeftLeg : RightLeg), f = B(k == 0 ? LeftFoot : RightFoot);
    V3 h = wpos(u), kn = wpos(l), a = wpos(f);
    double L = glm::length(h - kn) + glm::length(kn - a), dd = glm::length(h - a);
    V3 ax = normalize(a - h), off = kn - h;
    off = off + ax * -glm::dot(off, ax);
    legInfo[k] = {L, dd, off.z < -0.008};
  }
}
void FanKit::solveLeg(int k, const V3& t, double s) {
  const LegInfo& info = legInfo[k];
  int u = B(k == 0 ? LeftUpLeg : RightUpLeg), l = B(k == 0 ? LeftLeg : RightLeg), f = B(k == 0 ? LeftFoot : RightFoot);
  double d = glm::length(wpos(u) - t);
  if (info.back && d > info.d - 0.012) solveTwoBone(u, l, f, t, V3(s * 0.12, 0, -1));
  else solveTwoBone(u, l, f, t, V3(s * 0.12, 0, 1), info.back ? INFINITY : info.d);
}
void FanKit::measureBody() {
  auto P = [&](int b) { return wpos(B(b)); };
  shL = P(LeftArm); shR = P(RightArm);
  armLen = glm::length(shL - P(LeftForeArm)) + glm::length(P(LeftForeArm) - P(LeftHand));
  hipY = P(Hips).y; headY = P(Head).y; neckY = P(neck).y;
  chestY = P(Spine).y;
  V3 s0 = P(Spine02), nk = P(neck);
  postureFix = std::atan2(s0.z - nk.z, nk.y - s0.y) + 0.03;
  footL = P(LeftFoot); footR = P(RightFoot);
}

// flag (stick + cloth), cowbell (strap + bell) and the carried skis, modelled around the rest grip point
FanKit::PropGeo FanKit::buildProps() const {
  PropGeo g;
  std::vector<double> P, N, I;
  auto vtx = [&](double x, double y, double z, double nx, double ny, double nz, double kind, double a = 0, double b = 0) {
    P.push_back(G.x + x); P.push_back(G.y + y); P.push_back(G.z + z);
    N.push_back(nx); N.push_back(ny); N.push_back(nz);
    I.push_back(kind); I.push_back(a); I.push_back(b);
    return uint32_t(P.size() / 3 - 1);
  };
  auto box = [&](double y0, double y1, double w0, double d0, double w1, double d1, double kind) {
    const double c[8][3] = {{-w0, y0, -d0}, {w0, y0, -d0}, {w0, y0, d0}, {-w0, y0, d0}, {-w1, y1, -d1}, {w1, y1, -d1}, {w1, y1, d1}, {-w1, y1, d1}};
    const int faces[6][4] = {{0, 1, 5, 4}, {1, 2, 6, 5}, {2, 3, 7, 6}, {3, 0, 4, 7}, {4, 5, 6, 7}, {3, 2, 1, 0}};
    const double fn[6][3] = {{0, 0, -1}, {1, 0, 0}, {0, 0, 1}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}};
    for (int f = 0; f < 6; f++) {
      uint32_t v[4];
      for (int k = 0; k < 4; k++) { const double* q = c[faces[f][k]]; v[k] = vtx(q[0], q[1], q[2], fn[f][0], fn[f][1], fn[f][2], kind, (q[1] - y0) / (y1 - y0), 0); }
      for (uint32_t x : {v[0], v[1], v[2], v[0], v[2], v[3]}) g.idx.push_back(x);
    }
  };
  box(-0.24, 0.8, 0.012, 0.012, 0.011, 0.011, 2);   // flag stick
  const double CW = 0.6, CH = 0.4;
  const int NU = 8, NV = 3;
  const uint32_t base = uint32_t(P.size() / 3);
  for (int j = 0; j <= NV; j++) for (int i = 0; i <= NU; i++) vtx(0, 0.78 - CH + (double(j) / NV) * CH, 0.012 + (double(i) / NU) * CW, 1, 0, 0, 1, double(i) / NU, double(j) / NV);
  for (int j = 0; j < NV; j++) for (int i = 0; i < NU; i++) {
    uint32_t a = base + uint32_t(j * (NU + 1) + i), b = a + 1, c = a + NU + 1, dd = c + 1;
    for (uint32_t x : {a, c, b, b, c, dd}) g.idx.push_back(x);
  }
  box(-0.16, 0.03, 0.03, 0.007, 0.03, 0.007, 4);    // the strap
  const double R[6][3] = {{-0.4, 0.088, 0.066}, {-0.385, 0.084, 0.063}, {-0.33, 0.082, 0.06}, {-0.26, 0.074, 0.054}, {-0.2, 0.058, 0.042}, {-0.165, 0.035, 0.026}};
  const int SEG = 10;
  const double y0 = R[0][0], y1 = R[5][0];
  const uint32_t ring0 = uint32_t(P.size() / 3);
  for (int j = 0; j < 6; j++) {
    const double* r = R[j];
    const double* rp = R[std::max(0, j - 1)];
    const double* rn = R[std::min(5, j + 1)];
    double den = rn[0] - rp[0];
    double slope = (rp[1] - rn[1]) / (den != 0 ? den : 1);
    for (int i = 0; i <= SEG; i++) {
      double a = (double(i) / SEG) * PI * 2, ca = std::cos(a), sa = std::sin(a), nl = std::hypot(ca, sa, slope);
      vtx(ca * r[1], r[0], sa * r[2], ca / nl, slope / nl, sa / nl, 3, (r[0] - y0) / (y1 - y0), 0);
    }
  }
  for (int j = 0; j < 5; j++) for (int i = 0; i < SEG; i++) {
    uint32_t a = ring0 + uint32_t(j * (SEG + 1) + i), b = a + SEG + 1;
    for (uint32_t x : {a, b, a + 1, a + 1, b, b + 1}) g.idx.push_back(x);
  }
  uint32_t crown = vtx(0, y1 + 0.012, 0, 0, 1, 0, 3, 1, 0), inner = vtx(0, y0 + 0.05, 0, 0, -1, 0, 3, 0, 0);
  const uint32_t top0 = ring0 + 5 * (SEG + 1);
  for (int i = 0; i < SEG; i++) {
    for (uint32_t x : {crown, top0 + uint32_t(i) + 1, top0 + uint32_t(i)}) g.idx.push_back(x);
    for (uint32_t x : {inner, ring0 + uint32_t(i), ring0 + uint32_t(i) + 1}) g.idx.push_back(x);
  }
  // the carried skis: along +z from the hand's grip (tips 0.66 m ahead, tails 1.0 m behind)
  const double ZS[10] = {-1.0, -0.93, -0.6, -0.2, 0.0, 0.2, 0.42, 0.52, 0.6, 0.66};
  for (int sxi = 0; sxi < 2; sxi++) {
    const double sx = sxi == 0 ? 1 : -1;
    std::vector<std::array<uint32_t, 4>> ring;
    for (double z : ZS) {
      double tip = std::max(0.0, (z - 0.44) / 0.22), tail = std::max(0.0, (-0.9 - z) / 0.1);
      double ox = sx * (0.004 + 0.06 * tip * tip + 0.012 * tail), w = 0.042 * (1 - 0.25 * tip * tip), th = 0.012;
      double along = (z + 1.0) / 1.66;
      const double c[4][2] = {{ox, -w}, {ox, w}, {ox + sx * th * 2, w}, {ox + sx * th * 2, -w}};
      std::array<uint32_t, 4> rv;
      for (int k = 0; k < 4; k++) rv[size_t(k)] = vtx(c[k][0], c[k][1], z, k < 2 ? -sx : sx, 0, 0, 5, k < 2 ? 0 : 1, along);
      ring.push_back(rv);
    }
    for (size_t j = 0; j + 1 < ring.size(); j++) for (int k = 0; k < 4; k++) {
      uint32_t a = ring[j][size_t(k)], b = ring[j][size_t((k + 1) % 4)], c2 = ring[j + 1][size_t((k + 1) % 4)], dd = ring[j + 1][size_t(k)];
      if (sx > 0) for (uint32_t x : {a, dd, c2, a, c2, b}) g.idx.push_back(x);
      else for (uint32_t x : {a, b, c2, a, c2, dd}) g.idx.push_back(x);
    }
    const double BND[2][3] = {{-0.42, -0.3, 0.05}, {-0.1, 0.03, 0.045}};
    for (auto& bd : BND) {
      double z0 = bd[0], z1 = bd[1], h = bd[2];
      double x0 = sx * 0.028, x1 = sx * (0.028 + h);
      const double q[8][3] = {{x0, -0.03, z0}, {x1, -0.03, z0}, {x1, 0.03, z0}, {x0, 0.03, z0}, {x0, -0.03, z1}, {x1, -0.03, z1}, {x1, 0.03, z1}, {x0, 0.03, z1}};
      const int F[6][4] = {{0, 1, 2, 3}, {5, 4, 7, 6}, {1, 5, 6, 2}, {4, 0, 3, 7}, {3, 2, 6, 7}, {4, 5, 1, 0}};
      for (auto& f : F) {
        uint32_t v[4];
        for (int k = 0; k < 4; k++) v[k] = vtx(q[f[k]][0], q[f[k]][1], q[f[k]][2], sx, 0, 0, 6, 0, 0);
        if (sx > 0) for (uint32_t x : {v[0], v[1], v[2], v[0], v[2], v[3]}) g.idx.push_back(x);
        else for (uint32_t x : {v[0], v[2], v[1], v[0], v[3], v[2]}) g.idx.push_back(x);
      }
    }
  }
  g.P.assign(P.begin(), P.end()); g.N.assign(N.begin(), N.end()); g.I.assign(I.begin(), I.end());
  g.count = P.size() / 3;
  return g;
}

// world (model space) transform of every vertex at the bind pose, skin indices remapped to the palette
void FanKit::bakeGeometry(const Prim& m, const PropGeo& prop, Geo& out) {
  const Skin& sk = skins_[size_t(m.skin)];
  const M4 MW = world(m.node) * glm::inverse(world(m.node));   // (matrixWorld * bindMatrixInverse: attached bind mode)
  std::vector<M4> C;
  std::vector<int> map;
  for (size_t j = 0; j < sk.joints.size(); j++) {
    C.push_back(MW * (world(sk.joints[j]) * sk.inv[j]));
    int o = sk.joints[j];
    while (o >= 0 && !(nodes_[size_t(o)].bone && boneIndex(nodes_[size_t(o)].name) >= 0)) o = nodes_[size_t(o)].parent;
    map.push_back(o >= 0 ? boneIndex(nodes_[size_t(o)].name) : 0);
  }
  const size_t n = m.count, np = prop.count;
  out = Geo{};
  out.uv = m.hasUv; out.col = m.hasCol;
  out.P.assign((n + np) * 3, 0); out.N.assign((n + np) * 3, 0);
  if (out.uv) out.U.assign((n + np) * 2, 0);
  if (out.col) out.C.assign((n + np) * 3, 0);
  out.Bn.assign((n + np) * 4, 0); out.Wt.assign((n + np) * 4, 0); out.Info.assign((n + np) * 3, 0);
  std::vector<WMap> WB(n);
  for (size_t i = 0; i < n; i++) {
    V3 v(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]), nv(m.nor[i * 3], m.nor[i * 3 + 1], m.nor[i * 3 + 2]);
    V3 acc(0), accN(0);
    for (int k = 0; k < 4; k++) {
      double w = m.w[i * 4 + size_t(k)];
      if (w == 0) continue;
      int j = m.j[i * 4 + size_t(k)];
      if (j < 0 || size_t(j) >= C.size()) continue;
      acc += mulPoint(C[size_t(j)], v) * w;
      accN += glm::dmat3(C[size_t(j)]) * nv * w;
      WB[i].set(map[size_t(j)], WB[i].get(map[size_t(j)]) + w);
    }
    accN = normalize(accN);
    for (int c = 0; c < 3; c++) { out.P[i * 3 + size_t(c)] = float(acc[c]); out.N[i * 3 + size_t(c)] = float(accN[c]); }
    if (out.uv) { out.U[i * 2] = float(m.uv[i * 2]); out.U[i * 2 + 1] = float(m.uv[i * 2 + 1]); }
    if (out.col) for (int c = 0; c < 3; c++) out.C[i * 3 + size_t(c)] = float(m.col[i * 3 + size_t(c)]);
  }
  separateArms(out.P, n, m.idx, WB);
  for (size_t i = 0; i < n; i++) {
    WMap& wb = WB[i];
    cleanWeights(wb);
    std::vector<std::pair<int, double>> ent = wb.e;
    std::stable_sort(ent.begin(), ent.end(), [](const auto& a, const auto& b) { return b.second < a.second; });
    if (ent.size() > 4) ent.resize(4);
    double sum = 0;
    for (auto& e : ent) sum += e.second;
    if (!(sum != 0)) sum = 1;
    double excl = 0;
    for (size_t k = 0; k < ent.size(); k++) {
      int b = ent[k].first;
      out.Bn[i * 4 + k] = float(b);
      out.Wt[i * 4 + k] = float(ent[k].second / sum);
      if (b == Head || b == neck || b == LeftHand || b == RightHand || b == LeftFoot || b == RightFoot) excl += ent[k].second / sum;
    }
    out.Info[i * 3 + 1] = float(std::max(0.0, 1 - excl * 1.6));   // recolour mask: jacket / trousers, never face, hands, boots
  }
  for (size_t i = 0; i < np; i++) {
    for (int c = 0; c < 3; c++) {
      out.P[(n + i) * 3 + size_t(c)] = prop.P[i * 3 + size_t(c)];
      out.N[(n + i) * 3 + size_t(c)] = prop.N[i * 3 + size_t(c)];
      out.Info[(n + i) * 3 + size_t(c)] = prop.I[i * 3 + size_t(c)];
      if (out.col) out.C[(n + i) * 3 + size_t(c)] = 0.5f;
    }
    out.Bn[(n + i) * 4] = float(PROP);
    out.Wt[(n + i) * 4] = 1;
  }
  out.idx = m.idx;
  out.nBody = n;
  out.nBodyIdx = m.idx.size();
  for (uint32_t k : prop.idx) out.idx.push_back(k + uint32_t(n));
}

// dominant jacket colour (linear, from the torso of the vertex-coloured LOD): the recolour key
void FanKit::jacketBase(const Geo& geo) {
  hasBase = false;
  struct S_ { double Y, I, Q, ch, h; };
  std::vector<S_> S;
  if (geo.col) {
    const size_t cnt = geo.C.size() / 3;
    for (size_t i = 0; i < cnt; i++) {
      int b = int(geo.Bn[i * 4]);
      if (geo.Wt[i * 4] < 0.6f || !(b == Spine02 || b == Spine01 || b == LeftArm || b == RightArm || b == LeftForeArm || b == RightForeArm)) continue;
      double r = geo.C[i * 3], g = geo.C[i * 3 + 1], bl = geo.C[i * 3 + 2];
      double Y = 0.299 * r + 0.587 * g + 0.114 * bl, I = 0.596 * r - 0.274 * g - 0.322 * bl, Qv = 0.211 * r - 0.523 * g + 0.312 * bl;
      S.push_back({Y, I, Qv, std::hypot(I, Qv), std::atan2(Qv, I)});
    }
  }
  if (S.size() < 10) return;
  std::vector<S_> top;
  for (auto& o : S) if (o.ch > 0.008) top.push_back(o);
  if (top.size() < 10) return;
  size_t best = 0;
  double bh = 0;
  for (auto& s : top) {
    size_t w = 0;
    for (auto& o : top) if (std::fabs(angDiff(o.h, s.h)) < 0.35) w++;
    if (w > best) { best = w; bh = s.h; }
  }
  if (double(best) < double(S.size()) * 0.3) return;   // no clear jacket colour
  std::vector<double> chs, Ys;
  for (auto& o : top) if (std::fabs(angDiff(o.h, bh)) < 0.35) { chs.push_back(o.ch); Ys.push_back(o.Y); }
  std::sort(chs.begin(), chs.end());
  std::sort(Ys.begin(), Ys.end());
  double ch = chs[chs.size() / 2], Y = Ys[Ys.size() / 2];
  if (ch < 0.012) return;   // grey / white jacket: nothing to key on
  hasBase = true;
  base = glm::dvec4(std::cos(bh) * ch, std::sin(bh) * ch, std::max(0.01, Y), 0.87);
}

// ---------------------------------------------------------------- posing (load time)
// hand: world target of the wrist; pole: elbow direction; f / n: finger direction, palm normal (model space)
void FanKit::poseArm(int side, const V3& handT, const V3& pole, const V3* f, const V3* n, double shrug) {
  const int s = side > 0 ? 0 : 1;
  const int shB = B(side > 0 ? LeftShoulder : RightShoulder), arm = B(side > 0 ? LeftArm : RightArm), fore = B(side > 0 ? LeftForeArm : RightForeArm),
            hb = B(side > 0 ? LeftHand : RightHand);
  if (shrug != 0) rotateWorld(shB, Z_AXIS, side * shrug);
  solveTwoBone(arm, fore, hb, handT, pole);
  const Hand& H = hand[s];
  if (!H.ok || !f) return;
  // hand orientation: rotate the current finger / palm frame onto the target
  Q Hq = wquat(hb);
  V3 cf = applyQ(H.f, Hq), cn = applyQ(H.n, Hq);
  V3 F = normalize(*f), Nt = normalize(*n + F * -glm::dot(*n, F));
  M4 A(1), Bm(1);
  A[0] = glm::dvec4(cf, 0); A[1] = glm::dvec4(cn, 0); A[2] = glm::dvec4(glm::cross(cf, cn), 0);
  Bm[0] = glm::dvec4(F, 0); Bm[1] = glm::dvec4(Nt, 0); Bm[2] = glm::dvec4(glm::cross(F, Nt), 0);
  Q R = fromRotationMatrix(Bm * glm::transpose(A));
  Q target = mul(R, Hq);
  // share the wrist twist with the forearm (no candy-wrapped wrists)
  Q Wf = wquat(fore);
  Q rel = mul(conj(Wf), target);
  V3 ax = normalize(nodes_[size_t(hb)].t);
  double tw = 2 * std::atan2(rel.x * ax.x + rel.y * ax.y + rel.z * ax.z, rel.w);
  double ang = std::atan2(std::sin(tw), std::cos(tw));
  V3 axisW = normalize(wpos(hb) - wpos(fore));
  rotateWorld(fore, axisW, ang * 0.6);
  setWorldQuat(hb, target);
}
// relaxed arm hanging beside the thigh
void FanKit::hang(int side, double out, double fwd, double bend) {
  V3 s = sh(side);
  V3 t(s.x + side * (0.05 + out), s.y - armLen * (0.965 - bend), s.z + fwd);
  V3 f(0, -1, 0.12), n(-side, 0, 0.1);
  poseArm(side, t, V3(side * 0.35, 0, -1), &f, &n);
}
void FanKit::spine(double lean, double side, double twist) {
  const double L = lean + postureFix;
  const std::pair<int, double> S[3] = {{Spine02, 0.4}, {Spine01, 0.3}, {Spine, 0.3}};
  for (auto& [i, k] : S) {
    rotateWorld(B(i), X_AXIS, L * k);
    if (side != 0) rotateWorld(B(i), Z_AXIS, -side * k);
    if (twist != 0) rotateWorld(B(i), Y_AXIS, twist * k);
  }
}
void FanKit::head(double pitch, double yaw) {
  rotateWorld(B(neck), X_AXIS, -postureFix * 0.5 + pitch * 0.4);
  rotateWorld(B(Head), X_AXIS, pitch * 0.6);
  if (yaw != 0) { rotateWorld(B(neck), Y_AXIS, yaw * 0.4); rotateWorld(B(Head), Y_AXIS, yaw * 0.6); }
}
// hips offset (model space) + pelvis roll / pitch, feet planted at rest
void FanKit::legs(double dx, double dy, double dz, double roll, double pitch) {
  const int hips = B(Hips);
  if (dy > -0.03 && legInfo[0].back && legInfo[1].back) dy = 0;
  V3 feet[2] = {wpos(B(LeftFoot)), wpos(B(RightFoot))};
  feet[0].x = std::min(feet[0].x, 0.13); feet[1].x = std::max(feet[1].x, -0.13);
  Q fq[2] = {wquat(B(LeftFoot)), wquat(B(RightFoot))};
  if (dx != 0 || dy != 0 || dz != 0) {
    V3 w = wpos(hips) + V3(dx, dy, dz);
    nodes_[size_t(hips)].t = worldToLocal(nodes_[size_t(hips)].parent, w);
    touch();
  }
  if (roll != 0) rotateWorld(hips, Z_AXIS, roll);
  if (pitch != 0) rotateWorld(hips, X_AXIS, pitch);
  if (roll != 0) rotateWorld(B(Spine02), Z_AXIS, -roll * 0.9);   // keep the chest upright over a rolled pelvis
  for (int k = 0; k < 2; k++) {
    solveLeg(k, feet[k], k == 0 ? 1 : -1);
    setWorldQuat(B(k == 0 ? LeftFoot : RightFoot), fq[k]);
  }
}
// One phase p (0..1) of a walking cycle, WALK_STRIDE m per cycle (fans.js walkLegs)
double FanKit::walkLegs(double p) {
  const int hips = B(Hips);
  const double TAUv = PI * 2, S = WALK_STRIDE, duty = 0.62;
  V3 rest[2] = {wpos(B(LeftFoot)), wpos(B(RightFoot))};
  rest[0].x = std::max(0.075, std::min(0.105, rest[0].x)); rest[1].x = std::max(-0.105, std::min(-0.075, rest[1].x));
  Q fq[2] = {wquat(B(LeftFoot)), wquat(B(RightFoot))};
  auto foot = [&](double q, double& z, double& lift, double& pitch) {
    q = jsMod1(jsMod1(q) + 1);
    if (q < duty) {
      double u = q / duty;
      pitch = u < 0.16 ? -0.24 * (1 - u / 0.16) : u > 0.68 ? 0.62 * std::pow((u - 0.68) / 0.32, 1.6) : 0;
      lift = pitch > 0 ? 0.12 * std::sin(pitch) : 0.05 * std::sin(-pitch);
      z = S * duty * (0.5 - u);
      return;
    }
    double u = (q - duty) / (1 - duty), e = u * u * (3 - 2 * u);
    lift = 0.07 * (1 - u) + 0.012 * u + std::sin(u * PI) * 0.065;
    z = S * duty * (e - 0.5);
    pitch = 0.62 * std::pow(1 - e, 2) - 0.24 * e * e;
  };
  const double zc = wpos(B(LeftUpLeg)).z + 0.03 - 0.045;
  rest[0].z = rest[1].z = zc;
  const double ds = 0.5 + 0.5 * std::cos(2 * TAUv * (p - 0.06));
  const LegInfo& info = legInfo[0];
  const double reach = info.back ? info.L * 0.995 : info.d;
  const double up = std::sqrt(reach * reach - 0.045 * 0.045) + rest[0].y - wpos(B(LeftUpLeg)).y - 0.004;
  V3 w = wpos(hips) + V3(0.02 * std::sin(TAUv * (p - 0.06)), up - 0.051 * ds, 0.03);
  nodes_[size_t(hips)].t = worldToLocal(nodes_[size_t(hips)].parent, w);
  touch();
  const double yawA = -0.085 * std::cos(TAUv * p), roll = 0.032 * std::sin(TAUv * (p - 0.06));
  rotateWorld(hips, Y_AXIS, yawA);
  rotateWorld(hips, Z_AXIS, roll);
  for (int k = 0; k < 2; k++) {
    double z = 0, lift = 0, pitch = 0;
    foot(k == 0 ? p : p + 0.5, z, lift, pitch);
    solveLeg(k, rest[k] + V3(0, lift, z), k == 0 ? 1 : -1);
    setWorldQuat(B(k == 0 ? LeftFoot : RightFoot), mul(axisAngle(X_AXIS, pitch), fq[k]));
  }
  rotateWorld(B(Spine02), Z_AXIS, -roll * 0.9);
  spine(0.03, 0, 0.15 * std::cos(TAUv * p));
  return std::cos(TAUv * p);
}
void FanKit::walk(double p) {
  const double sw = walkLegs(p), A = 0.16;
  // arms against the legs (the left arm back while the left leg is forward), the elbow bending on the forward swing
  for (int s : {1, -1}) {
    double fwd = -s * A * sw;
    hang(s, 0.025, 0.03 + fwd, 0.045 + 0.085 * std::max(0.0, fwd / A));
  }
  head(0.04, -0.06 * sw);
}
FanKit::CarryLine FanKit::carryLine(const V3& s) const { return {s + V3(-0.015, 0.085 + height * 0.004, -0.035), carryDir()}; }
void FanKit::measureCarry() {
  CarryLine cl = carryLine(wpos(B(RightArm)));
  const V3 d = cl.d;
  V3 Y = normalize(V3(0, 1, 0) + d * -d.y), X = glm::cross(Y, d);
  Q R = basisQuat(X, Y, d);
  const int chest = B(Spine);
  Q cqi = conj(wquat(chest));
  Q rel = mul(cqi, R);
  carryRel = {float(rel.x), float(rel.y), float(rel.z), float(rel.w)};
  carryAnchor = applyQ(cl.anchor - wpos(chest), cqi);
  hasCarry = true;
}

void FanKit::pose(int k) {
  auto V = [](double x, double y, double z) { return V3(x, y, z); };
  const double A = armLen, top = height;
  auto upDir = [&](int s, double out, double fwd, double kk) { return sh(s) + normalize(V(s * out, 1, fwd)) * (A * kk); };
  auto arm = [&](int s, const V3& t, const V3& pole, const V3& f, const V3& n, double shrug = 0) { poseArm(s, t, pole, &f, &n, shrug); };
  auto armP = [&](int s, const V3& t, const V3& pole, double shrug = 0) { poseArm(s, t, pole, nullptr, nullptr, shrug); };
  switch (k) {
    case STAND_L: legs(0.035, -0.012, 0, 0.05); spine(0.02, -0.01); hang(1, 0.0, 0.03); hang(-1, 0.01, 0.05, 0.06); head(0.06, 0.05); break;
    case STAND_R: legs(-0.035, -0.012, 0, -0.05); spine(0.02, 0.01); hang(1, 0.01, 0.05, 0.06); hang(-1, 0.0, 0.03); head(0.06, -0.05); break;
    case HOLD:   // hands loosely together in front of the belly
      legs(0, -0.01); spine(0.03);
      for (int s : {1, -1}) arm(s, V(s * 0.045, hipY + 0.08, 0.2), V(s * 0.6, -0.4, -1), V(-s * 0.7, -0.5, 0.3), V(-s * 0.2, 0.3, -1));
      head(0.08);
      break;
    case POCKET:   // hands on the hips
      legs(0, -0.01); spine(-0.01);
      for (int s : {1, -1}) armP(s, V(sh(s).x + s * 0.02, hipY + 0.06, 0.05), V(s, -0.2, -0.5));
      head(0.02);
      break;
    case CLAP_O:
      legs(0, -0.012); spine(0.05);
      for (int s : {1, -1}) arm(s, V(s * 0.16, sh(s).y - 0.14, 0.32), V(s * 0.6, -1, -0.3), V(-s * 0.15, 0.75, 0.6), V(-s, 0, 0));
      head(-0.02);
      break;
    case CLAP_S:
      legs(0, -0.012); spine(0.06);
      for (int s : {1, -1}) arm(s, V(s * 0.04, sh(s).y - 0.12, 0.35), V(s * 0.6, -1, -0.3), V(-s * 0.05, 0.75, 0.6), V(-s, 0, 0));
      head(-0.02);
      break;
    case CLAPHI_O:
      legs(0, -0.005); spine(-0.03);
      for (int s : {1, -1}) armP(s, V(s * 0.17, top + 0.1, 0.16), V(s, -0.3, -0.4), 0.16);
      head(-0.12);
      break;
    case CLAPHI_S:
      legs(0, -0.005); spine(-0.03);
      for (int s : {1, -1}) armP(s, V(s * 0.04, top + 0.13, 0.16), V(s, -0.3, -0.4), 0.18);
      head(-0.12);
      break;
    case VUP_A:
      legs(0, -0.005); spine(-0.04);
      for (int s : {1, -1}) { V3 t = upDir(s, 0.55, 0.12, 0.9); armP(s, t, V(s, -0.2, -0.5), 0.2); }
      head(-0.18);
      break;
    case VUP_B:
      legs(0, 0); spine(-0.06);
      for (int s : {1, -1}) { V3 t = upDir(s, 0.38, 0.18, 0.98); armP(s, t, V(s, -0.2, -0.5), 0.26); }
      head(-0.22);
      break;
    case WAVE_A: legs(0.02, -0.01, 0, 0.03); spine(0, 0.02); hang(1, 0.01, 0.04); armP(-1, sh(-1) + V(-0.1, 0.44, 0.14), V(-1, -0.6, -0.2), 0.12); head(-0.04); break;
    case WAVE_B: legs(0.02, -0.01, 0, 0.03); spine(0, 0.03); hang(1, 0.01, 0.04); armP(-1, sh(-1) + V(-0.34, 0.38, 0.12), V(-1, -0.6, -0.2), 0.14); head(-0.04); break;
    case PUMP_LO: legs(0, -0.03); spine(0.06); hang(1, 0.02, 0.06, 0.08); armP(-1, sh(-1) + V(-0.06, 0.06, 0.24), V(-0.6, -1, 0), 0.05); head(0.0); break;
    case PUMP_HI: legs(0, 0); spine(-0.05); hang(1, 0.02, 0.05, 0.08); armP(-1, upDir(-1, 0.12, 0.2, 0.98), V(-1, -0.3, -0.4), 0.28); head(-0.18); break;
    case FLAG_REST: legs(-0.02, -0.01, 0, -0.03); spine(0.02); hang(1, 0.0, 0.04); armP(-1, V(sh(-1).x - 0.08, hipY + 0.12, 0.12), V(-1, -0.3, -1)); head(0.04); break;
    case FLAG_A: legs(0, -0.005); spine(-0.03, 0.03); hang(1, 0.02, 0.05); armP(-1, sh(-1) + V(-0.12, A * 0.9, 0.14), V(-1, -0.3, -0.3), 0.24); head(-0.16); break;
    case FLAG_B: legs(0, -0.005); spine(-0.03, -0.02); hang(1, 0.02, 0.05); armP(-1, sh(-1) + V(0.2, A * 0.86, 0.16), V(-1, -0.3, -0.3), 0.24); head(-0.16); break;
    case BELL_REST: legs(-0.02, -0.01, 0, -0.03); spine(0.02); hang(1, 0.0, 0.04); armP(-1, V(sh(-1).x - 0.02, hipY + 0.06, 0.16), V(-1, -0.2, -1)); head(0.05); break;
    case BELL_A: legs(0, -0.01); spine(0.0); hang(1, 0.02, 0.05); armP(-1, sh(-1) + V(-0.06, 0.3, 0.3), V(-1, -1, -0.3), 0.1); head(-0.08); break;
    case BELL_B: legs(0, -0.01); spine(0.0); hang(1, 0.02, 0.05); armP(-1, sh(-1) + V(-0.06, 0.18, 0.34), V(-1, -1, -0.3), 0.06); head(-0.08); break;
    case CROUCH: legs(0, -0.15, -0.02, 0, 0.2); spine(0.05); hang(1); hang(-1); head(-0.1); break;
    // ---- people waiting / chatting
    case TALK_A:   // explaining with the right hand: forearm up in front of the belly, palm up
      legs(0.025, -0.012, 0, 0.04); spine(0.045, 0, 0.06);
      hang(1, 0.01, 0.04, 0.05);
      arm(-1, V(sh(-1).x + 0.04, sh(-1).y - 0.29, 0.22), V(-0.7, -1, -0.5), V(0.25, 0.25, 1), V(0.3, 1, 0), 0.02);
      head(0.0, -0.04);
      break;
    case TALK_B:   // both hands open in front, palms up
      legs(0, -0.012); spine(0.05);
      for (int s : {1, -1}) arm(s, V(sh(s).x - s * 0.01, sh(s).y - 0.31, 0.21), V(s * 0.7, -1, -0.5), V(-s * 0.3, 0.15, 1), V(-s * 0.35, 1, 0));
      head(0.02);
      break;
    case TALK_C:   // the left hand
      legs(-0.025, -0.012, 0, -0.04); spine(0.045, 0, -0.06);
      hang(-1, 0.01, 0.04, 0.05);
      arm(1, V(sh(1).x - 0.04, sh(1).y - 0.29, 0.22), V(0.7, -1, -0.5), V(-0.25, 0.25, 1), V(-0.3, 1, 0), 0.02);
      head(0.0, 0.04);
      break;
    case PHONE:   // looking at a phone held in both hands in front of the chest
      legs(0.02, -0.012, 0, 0.03); spine(0.08);
      for (int s : {1, -1}) arm(s, V(s * 0.055, sh(s).y - 0.33, 0.25), V(s, -0.8, -0.4), V(-s * 0.55, 0.35, 0.75), V(-s * 0.2, 0.65, -0.5));
      head(0.45);
      break;
    case POINT:   // showing the way / the mountain with the right arm
      legs(-0.02, -0.01, 0, -0.03); spine(-0.01, 0, 0.1);
      hang(1, 0.01, 0.05);
      arm(-1, sh(-1) + V(-0.12, 0.16, 0.5), V(-1, -0.4, -0.3), V(-0.15, 0.3, 1), V(0.45, 0, 0.15), 0.08);
      head(-0.08, -0.08);
      break;
    case SHRUG:   // hands out at the sides, palms up, shoulders up
      legs(0, -0.008); spine(0.0);
      for (int s : {1, -1}) arm(s, V(sh(s).x + s * 0.2, hipY + 0.14, 0.2), V(s, -0.5, -0.5), V(s * 0.5, 0.1, 1), V(0, 1, 0), 0.12);
      head(-0.04);
      break;
    case WATCH:   // a glance at the watch on the left wrist
      legs(0.02, -0.012, 0, 0.03); spine(0.06);
      hang(-1, 0.01, 0.04, 0.05);
      arm(1, V(0.02, sh(1).y - 0.28, 0.3), V(1, -0.8, -0.2), V(-1, 0.1, 0.15), V(0, 1, 0.2));
      head(0.38, 0.12);
      break;
    case CARRY: {   // skis over the right shoulder, the hand holding them from below ~0.3 m ahead of it
      legs(0, -0.01); spine(0.03, -0.02);
      hang(1, 0.02, 0.04, 0.05);
      CarryLine cl = carryLine(sh(-1));
      V3 at = cl.anchor + cl.d * 0.42 + V(0, -0.07, 0);
      arm(-1, at, V(-1, -1, -0.2), V(0.25, 1, 0.1), V(0.4, 0.1, -1), 0.03);
      head(0.04, 0.08);
      break;
    }
    default:
      if (k >= WALK0 && k < WALK0 + NWALK) walk(double(k - WALK0) / NWALK);
      break;
  }
}

void FanKit::bakeKeyframes() {
  kq.assign(size_t(NK) * NBA * 4, 0);
  kh.assign(size_t(NK) * 3, 0);
  float restL[NBA * 4];
  for (int k = -1; k < NK; k++) {
    resetPose();
    if (k >= 0) pose(k);
    for (int i = 0; i < NBA; i++) {
      Q q = wquat(B(i));
      if (i > 0) q = mul(conj(wquat(B(parent[i]))), q);
      if (k < 0) { restL[i * 4] = float(q.x); restL[i * 4 + 1] = float(q.y); restL[i * 4 + 2] = float(q.z); restL[i * 4 + 3] = float(q.w); continue; }
      // same hemisphere as the rest pose (blends are plain normalized sums)
      double d = q.x * restL[i * 4] + q.y * restL[i * 4 + 1] + q.z * restL[i * 4 + 2] + q.w * restL[i * 4 + 3];
      if (d < 0) q = Q(-q.w, -q.x, -q.y, -q.z);
      float* o = &kq[(size_t(k) * NBA + size_t(i)) * 4];
      o[0] = float(q.x); o[1] = float(q.y); o[2] = float(q.z); o[3] = float(q.w);
    }
    if (k >= 0) { V3 p = wpos(B(0)); for (int c = 0; c < 3; c++) kh[size_t(k) * 3 + size_t(c)] = float(p[c]); }
    if (k == CARRY) measureCarry();
  }
}

// ---------------------------------------------------------------- GPU models
void FanKit::upload(gfx::Device& dev, const Model* textured) {
  // one skinned primitive per LOD: pos, normal, uv, 4 palette bones, 4 weights, colour, the recolour mask (20 floats)
  auto build = [&](const std::vector<float>& vb, const std::vector<uint32_t>& ib, const Material& mat, bool color, const char* nm) {
    auto M = std::make_shared<Model>();
    M->name = name + nm;
    sl::Node nd;
    nd.name = M->name; nd.mesh = 0; nd.skin = 0;
    M->nodes.push_back(nd);
    M->roots.push_back(0);
    sl::Skin sk;
    for (int b = 0; b < NB; b++) { sk.joints.push_back(0); sk.inverseBind.push_back(mat4(1)); }
    M->skins.push_back(sk);
    Primitive p;
    p.vbo = dev.createBuffer(gfx::BufferUsage::Vertex, vb.data(), vb.size() * sizeof(float));
    p.ibo = dev.createBuffer(gfx::BufferUsage::Index, ib.data(), ib.size() * sizeof(uint32_t));
    const uint32_t st = 20 * sizeof(float);
    std::vector<gfx::VertexAttrib> at = {{0, 0, 3, gfx::AttribType::Float, false, 0, st},  {1, 0, 3, gfx::AttribType::Float, false, 12, st},
                                         {2, 0, 2, gfx::AttribType::Float, false, 24, st}, {3, 0, 4, gfx::AttribType::Float, false, 32, st},
                                         {4, 0, 4, gfx::AttribType::Float, false, 48, st}, {7, 0, 3, gfx::AttribType::Float, false, 64, st},
                                         {8, 0, 1, gfx::AttribType::Float, false, 76, st}};
    p.input = dev.createVertexInput(at, {p.vbo}, p.ibo);
    p.lods.push_back({0, uint32_t(ib.size())});
    p.material = 0;
    p.skinned = true;
    p.stride = st;
    p.hasColor = color;
    for (size_t v = 0; v < vb.size() / 20; v++) { vec3 q(vb[v * 20], vb[v * 20 + 1], vb[v * 20 + 2]); p.bmin = glm::min(p.bmin, q); p.bmax = glm::max(p.bmax, q); }
    Mesh mesh;
    mesh.name = M->name;
    mesh.primitives.push_back(p);
    M->meshes.push_back(mesh);
    M->materials.push_back(mat);
    M->bmin = p.bmin; M->bmax = p.bmax;
    return M;
  };
  for (int l = 0; l < 3; l++) {
    const Geo& g = geos[l];
    std::vector<float> vb(g.nBody * 20, 0.f);
    for (size_t i = 0; i < g.nBody; i++) {
      float* o = &vb[i * 20];
      for (int c = 0; c < 3; c++) { o[c] = g.P[i * 3 + size_t(c)]; o[3 + c] = g.N[i * 3 + size_t(c)]; }
      if (g.uv) { o[6] = g.U[i * 2]; o[7] = g.U[i * 2 + 1]; }
      for (int c = 0; c < 4; c++) { o[8 + c] = g.Bn[i * 4 + size_t(c)]; o[12 + c] = g.Wt[i * 4 + size_t(c)]; }
      if (g.col) for (int c = 0; c < 3; c++) o[16 + c] = g.C[i * 3 + size_t(c)];
      else o[16] = o[17] = o[18] = 1;
      o[19] = g.Info[i * 3 + 1];
    }
    std::vector<uint32_t> ib(g.idx.begin(), g.idx.begin() + long(g.nBodyIdx));
    Material mat;
    // (fans.js: LOD 0 the textured material, LODs 1 / 2 the vertex-coloured one without maps)
    if (textured && !textured->materials.empty()) {
      mat = textured->materials[size_t(std::min<int>(lodMaterial[l], int(textured->materials.size()) - 1))];
    }
    if (l > 0) { mat.baseTex = {}; mat.normalTex = {}; mat.baseImage = -1; }
    mat.vertexColor = l > 0 && g.col;
    mat.fanBase = hasBase ? vec4(float(base.x), float(base.y), float(base.z), float(base.w)) : vec4(0, 0, 0, 1);
    lod[l] = build(vb, ib, mat, g.col, l == 0 ? "#fan0" : l == 1 ? "#fan1" : "#fan2");
  }
  // the carried skis (kinds 5 / 6 of buildProps): the shader's colours baked per scheme into vertex colours, the
  // segments split where the top sheet's band starts / ends (the shape there is a straight prism: no change to it)
  const float SA[6][3] = {{0.015f, 0.015f, 0.015f}, {0.5f, 0.02f, 0.02f}, {0.78f, 0.78f, 0.78f}, {0.015f, 0.08f, 0.36f}, {0.7f, 0.45f, 0.0f}, {0.02f, 0.22f, 0.08f}};
  const float SB[6][3] = {{0.55f, 0.02f, 0.02f}, {0.8f, 0.8f, 0.8f}, {0.015f, 0.08f, 0.36f}, {0.8f, 0.8f, 0.8f}, {0.015f, 0.015f, 0.015f}, {0.8f, 0.8f, 0.8f}};
  for (int scheme = 0; scheme < 6; scheme++) {
    std::vector<float> vb, vbB;
    std::vector<uint32_t> ib, ibB;
    auto vtx = [&](std::vector<float>& V, double x, double y, double z, double nx, double ny, double nz, vec3 col) {
      float o[20] = {float(G.x + x), float(G.y + y), float(G.z + z), float(nx), float(ny), float(nz), 0, 0, float(PROP), 0, 0, 0, 1, 0, 0, 0, col.x, col.y, col.z, 0};
      V.insert(V.end(), o, o + 20);
      return uint32_t(V.size() / 20 - 1);
    };
    const double ZS[12] = {-1.0, -0.93, -0.6, -0.336, -0.2, -0.004, 0.0, 0.2, 0.42, 0.52, 0.6, 0.66};
    for (int sxi = 0; sxi < 2; sxi++) {
      const double sx = sxi == 0 ? 1 : -1;
      auto corners = [&](double z, double c[4][2]) {
        double tip = std::max(0.0, (z - 0.44) / 0.22), tail = std::max(0.0, (-0.9 - z) / 0.1);
        double ox = sx * (0.004 + 0.06 * tip * tip + 0.012 * tail), w = 0.042 * (1 - 0.25 * tip * tip), th = 0.012;
        const double cc[4][2] = {{ox, -w}, {ox, w}, {ox + sx * th * 2, w}, {ox + sx * th * 2, -w}};
        std::memcpy(c, cc, sizeof cc);
      };
      for (int j = 0; j + 1 < 12; j++) {
        const double za = ZS[j], zb = ZS[j + 1], mid = ((za + zb) / 2 + 1.0) / 1.66;
        const bool band = mid >= 0.4 && mid <= 0.6;
        vec3 X = band ? vec3(SB[scheme][0], SB[scheme][1], SB[scheme][2]) : vec3(SA[scheme][0], SA[scheme][1], SA[scheme][2]);
        double ca[4][2], cb[4][2];
        corners(za, ca); corners(zb, cb);
        uint32_t ra[4], rb[4];
        for (int k = 0; k < 4; k++) {
          vec3 col = glm::mix(vec3(0.02f), X, k < 2 ? 0.f : 1.f);
          ra[k] = vtx(vb, ca[k][0], ca[k][1], za, k < 2 ? -sx : sx, 0, 0, col);
          rb[k] = vtx(vb, cb[k][0], cb[k][1], zb, k < 2 ? -sx : sx, 0, 0, col);
        }
        for (int k = 0; k < 4; k++) {
          uint32_t a = ra[k], b = ra[(k + 1) % 4], c2 = rb[(k + 1) % 4], d = rb[k];
          if (sx > 0) for (uint32_t x : {a, d, c2, a, c2, b}) ib.push_back(x);
          else for (uint32_t x : {a, b, c2, a, c2, d}) ib.push_back(x);
        }
      }
      const double BND[2][3] = {{-0.42, -0.3, 0.05}, {-0.1, 0.03, 0.045}};
      for (auto& bd : BND) {
        double z0 = bd[0], z1 = bd[1], h = bd[2];
        double x0 = sx * 0.028, x1 = sx * (0.028 + h);
        const double q[8][3] = {{x0, -0.03, z0}, {x1, -0.03, z0}, {x1, 0.03, z0}, {x0, 0.03, z0}, {x0, -0.03, z1}, {x1, -0.03, z1}, {x1, 0.03, z1}, {x0, 0.03, z1}};
        const int F[6][4] = {{0, 1, 2, 3}, {5, 4, 7, 6}, {1, 5, 6, 2}, {4, 0, 3, 7}, {3, 2, 6, 7}, {4, 5, 1, 0}};
        for (auto& f : F) {
          uint32_t v[4];
          for (int k = 0; k < 4; k++) v[k] = vtx(vbB, q[f[k]][0], q[f[k]][1], q[f[k]][2], sx, 0, 0, vec3(1));
          if (sx > 0) for (uint32_t x : {v[0], v[1], v[2], v[0], v[2], v[3]}) ibB.push_back(x);
          else for (uint32_t x : {v[0], v[2], v[1], v[0], v[3], v[2]}) ibB.push_back(x);
        }
      }
    }
    Material ms;
    ms.vertexColor = true; ms.metallic = 0.1f; ms.roughness = 0.35f; ms.doubleSided = true; ms.shading = 3; ms.name = "fan_skis";
    auto M = build(vb, ib, ms, true, "#skis");
    Material mb;
    mb.baseColor = vec4(0.05f, 0.05f, 0.055f, 1); mb.metallic = 0.5f; mb.roughness = 0.35f; mb.doubleSided = true; mb.shading = 3; mb.name = "fan_bindings";
    auto Bm = build(vbB, ibB, mb, false, "#bindings");
    // one model, two primitives (skis, bindings)
    Primitive pb = Bm->meshes[0].primitives[0];
    pb.material = 1;
    M->meshes[0].primitives.push_back(pb);
    M->materials.push_back(mb);
    M->bmin = glm::min(M->bmin, Bm->bmin); M->bmax = glm::max(M->bmax, Bm->bmax);
    skis[scheme] = M;
  }
}

// ================================================================ posing (fans.js blendN / blend4 / composeRow)
namespace fans {
void blendN(const float* kq, int b, const int* ks, const float* ws, int nk, float* out) {
  double x = 0, y = 0, z = 0, w = 0;
  for (int k = 0; k < nk; k++) {
    const float* q = &kq[(size_t(ks[k]) * NBA + size_t(b)) * 4];
    const double wk = ws[k];
    x += q[0] * wk; y += q[1] * wk; z += q[2] * wk; w += q[3] * wk;
  }
  double l = std::sqrt(x * x + y * y + z * z + w * w);
  if (!(l != 0)) l = 1;
  out[0] = float(x / l); out[1] = float(y / l); out[2] = float(z / l); out[3] = float(w / l);
}
void blend4(const float* kq, int b, int k0, double w0, int k1, double w1, int k2, double w2, int k3, double w3, float* out) {
  double x = 0, y = 0, z = 0, w = 0;
  auto add = [&](int k, double wk) {
    if (!(wk > 0)) return;
    const float* q = &kq[(size_t(k) * NBA + size_t(b)) * 4];
    x += q[0] * wk; y += q[1] * wk; z += q[2] * wk; w += q[3] * wk;
  };
  add(k0, w0); add(k1, w1); add(k2, w2); add(k3, w3);
  double l = std::sqrt(x * x + y * y + z * z + w * w);
  if (!(l != 0)) l = 1;
  out[0] = float(x / l); out[1] = float(y / l); out[2] = float(z / l); out[3] = float(w / l);
}
namespace {
void writeSkin(float* pal, double x, double y, double z, double w, double px, double py, double pz, double rx, double ry, double rz) {
  const double xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const double m00 = 1 - 2 * (yy + zz), m01 = 2 * (xy - wz), m02 = 2 * (xz + wy);
  const double m10 = 2 * (xy + wz), m11 = 1 - 2 * (xx + zz), m12 = 2 * (yz - wx);
  const double m20 = 2 * (xz - wy), m21 = 2 * (yz + wx), m22 = 1 - 2 * (xx + yy);
  pal[0] = float(m00); pal[1] = float(m01); pal[2] = float(m02); pal[3] = float(px - (m00 * rx + m01 * ry + m02 * rz));
  pal[4] = float(m10); pal[5] = float(m11); pal[6] = float(m12); pal[7] = float(py - (m10 * rx + m11 * ry + m12 * rz));
  pal[8] = float(m20); pal[9] = float(m21); pal[10] = float(m22); pal[11] = float(pz - (m20 * rx + m21 * ry + m22 * rz));
}
} // namespace
// chain the local rotations into model-space bones and write the skinning matrices (3 rows of 4 each)
void composeRow(const FanKit& kit, const float* L, double hx, double hy, double hz, double lookY, double lookP, const float* pq, bool carry,
                float* pal, float* W, float* Pw) {
  const int8_t* par = kit.parent;
  const float *O = kit.O.data(), *P0 = kit.P0.data(), *Q0i = kit.Q0i.data();
  for (int b = 0; b < NBA; b++) {
    const int bo = b * 4;
    const double lx = L[bo], ly = L[bo + 1], lz = L[bo + 2], lw = L[bo + 3];
    double wx, wy, wz, ww, px, py, pz;
    if (b == 0) { wx = lx; wy = ly; wz = lz; ww = lw; px = hx; py = hy; pz = hz; }
    else {
      const int p = par[b] * 4;
      const double ax = W[p], ay = W[p + 1], az = W[p + 2], aw = W[p + 3];
      wx = aw * lx + ax * lw + ay * lz - az * ly;
      wy = aw * ly - ax * lz + ay * lw + az * lx;
      wz = aw * lz + ax * ly - ay * lx + az * lw;
      ww = aw * lw - ax * lx - ay * ly - az * lz;
      // position: parent + parent rotation * offset
      const int oo = b * 3;
      const double vx = O[oo], vy = O[oo + 1], vz = O[oo + 2];
      const double tx = 2 * (ay * vz - az * vy), ty = 2 * (az * vx - ax * vz), tz = 2 * (ax * vy - ay * vx);
      const int pp = par[b] * 3;
      px = Pw[pp] + vx + aw * tx + (ay * tz - az * ty);
      py = Pw[pp + 1] + vy + aw * ty + (az * tx - ax * tz);
      pz = Pw[pp + 2] + vz + aw * tz + (ax * ty - ay * tx);
      const double share = b == 3 ? 0.15 : b == 4 ? 0.4 : b == 5 ? 0.5 : 0;   // LOOK_SPLIT: chest, neck, head
      if (share != 0) {   // pre-rotate about the model's up (yaw) and right (pitch) axes, around this joint
        const double a = lookY * share * 0.5, c = lookP * share * 0.5;
        const double sy = std::sin(a), cy = std::cos(a), sp = std::sin(c), cp = std::cos(c);
        const double qx = cy * sp, qy = sy * cp, qz = -sy * sp, qw = cy * cp;   // Ry * Rx
        const double nx = qw * wx + qx * ww + qy * wz - qz * wy;
        const double ny = qw * wy - qx * wz + qy * ww + qz * wx;
        const double nz = qw * wz + qx * wy - qy * wx + qz * ww;
        const double nw = qw * ww - qx * wx - qy * wy - qz * wz;
        wx = nx; wy = ny; wz = nz; ww = nw;
      }
    }
    W[bo] = float(wx); W[bo + 1] = float(wy); W[bo + 2] = float(wz); W[bo + 3] = float(ww);
    Pw[b * 3] = float(px); Pw[b * 3 + 1] = float(py); Pw[b * 3 + 2] = float(pz);
    // skin: R = W * Q0^-1, t = P - R * P0
    const double bx = Q0i[bo], by = Q0i[bo + 1], bz = Q0i[bo + 2], bw = Q0i[bo + 3];
    writeSkin(pal + b * 12, ww * bx + wx * bw + wy * bz - wz * by, ww * by - wx * bz + wy * bw + wz * bx, ww * bz + wx * by - wy * bx + wz * bw,
              ww * bw - wx * bx - wy * by - wz * bz, px, py, pz, P0[b * 3], P0[b * 3 + 1], P0[b * 3 + 2]);
  }
  // the prop: at the right hand's grip, its own orientation
  const int h = RightHand * 4;
  const double ax = W[h], ay = W[h + 1], az = W[h + 2], aw = W[h + 3];
  const V3 g = kit.gripLocal;
  const double tx = 2 * (ay * g.z - az * g.y), ty = 2 * (az * g.x - ax * g.z), tz = 2 * (ax * g.y - ay * g.x);
  const double gx = Pw[RightHand * 3] + g.x + aw * tx + (ay * tz - az * ty);
  const double gy = Pw[RightHand * 3 + 1] + g.y + aw * ty + (az * tx - ax * tz);
  const double gz = Pw[RightHand * 3 + 2] + g.z + aw * tz + (ax * ty - ay * tx);
  if (carry && kit.hasCarry) {
    // carried skis: rigid on the posed chest (rotation = chest * carryRel, resting point on the shoulder)
    const int c = Spine * 4;
    const double cx = W[c], cy = W[c + 1], cz = W[c + 2], cw = W[c + 3];
    const float* r = kit.carryRel.data();
    const double qx = cw * r[0] + cx * r[3] + cy * r[2] - cz * r[1], qy = cw * r[1] - cx * r[2] + cy * r[3] + cz * r[0];
    const double qz = cw * r[2] + cx * r[1] - cy * r[0] + cz * r[3], qw = cw * r[3] - cx * r[0] - cy * r[1] - cz * r[2];
    auto rot = [](double qx2, double qy2, double qz2, double qw2, const V3& v, int k) {   // component k of quaternion * v
      const double ux = 2 * (qy2 * v.z - qz2 * v.y), uy = 2 * (qz2 * v.x - qx2 * v.z), uz = 2 * (qx2 * v.y - qy2 * v.x);
      return k == 0 ? v.x + qw2 * ux + (qy2 * uz - qz2 * uy) : k == 1 ? v.y + qw2 * uy + (qz2 * ux - qx2 * uz) : v.z + qw2 * uz + (qx2 * uy - qy2 * ux);
    };
    const V3 A = kit.carryAnchor;
    const int S = Spine * 3;
    const double ax2 = Pw[S] + rot(cx, cy, cz, cw, A, 0), ay2 = Pw[S + 1] + rot(cx, cy, cz, cw, A, 1), az2 = Pw[S + 2] + rot(cx, cy, cz, cw, A, 2);
    const double tx2 = ax2 - rot(qx, qy, qz, qw, CARRY_REST, 0), ty2 = ay2 - rot(qx, qy, qz, qw, CARRY_REST, 1), tz2 = az2 - rot(qx, qy, qz, qw, CARRY_REST, 2);
    writeSkin(pal + PROP * 12, qx, qy, qz, qw, tx2, ty2, tz2, kit.G.x, kit.G.y, kit.G.z);
  } else if (pq) writeSkin(pal + PROP * 12, pq[0], pq[1], pq[2], pq[3], gx, gy, gz, kit.G.x, kit.G.y, kit.G.z);
  else writeSkin(pal + PROP * 12, 0, 0, 0, 1, gx, gy, gz, kit.G.x, kit.G.y, kit.G.z);
}
mat4 skinMatrix(const float* r) {
  mat4 m(1);
  for (int row = 0; row < 3; row++) for (int col = 0; col < 4; col++) m[col][row] = r[row * 4 + col];
  return m;
}
} // namespace fans

// ================================================================ FanCrowd (the dynamic crowd)
void FanCrowd::init(const std::vector<std::shared_ptr<FanKit>>& kitsIn, int count, const Rnd& rnd, const std::vector<int>& kitOf) {
  kits = kitsIn;
  n = count;
  const size_t N = size_t(n);
  kit.assign(N, 0); calm.assign(N, 0); style.assign(N, 0); jumper.assign(N, 0);
  scl.assign(N * 2, 1); mat.assign(N * 16, 0); pos.assign(N * 3, 0); yaw.assign(N, 0);
  energy.assign(N, 0); phase.assign(N, 0); rate.assign(N, 1); thresh.assign(N, 0); lookY.assign(N, 0); lookP.assign(N, 0); e.assign(N, 0);
  palC.assign(N * 8, 0);
  D.alpha.assign(N, 1); D.walk.assign(N, 0); D.wph.assign(N, 0); D.talk.assign(N, 0); D.holdW.assign(N, 0); D.lookY.assign(N, 0); D.lookP.assign(N, 0);
  D.hold.assign(N, 0); D.carry.assign(N, 0);
  lod.assign(N, -1); next.assign(N, -1); fade.assign(N, 1); dist.assign(N, 1e9f);
  inView.assign(N, 0); stale.assign(N, 1); rag.assign(N, 0);
  pal.assign(N * NB * 12, 0);
  if (kits.empty()) return;
  double tot = 0;
  for (auto& k : kits) tot += k->cfg.share;
  // the spots of a dynamic crowd all start at the origin (townsfolk.js / railpeople.js: setPlace moves them)
  enum { CLAP, CLAPHI, VUP, WAVE, PUMP, FLAG, BELL };
  for (size_t i = 0; i < N; i++) {
    int k = 0;
    for (int tries = 0; tries < 4; tries++) {
      double r = rnd() * tot;
      k = 0;
      while (k < int(kits.size()) - 1 && r > kits[size_t(k)]->cfg.share) { r -= kits[size_t(k)]->cfg.share; k++; }
      bool twin = false;
      for (size_t j = i >= 8 ? i - 8 : 0; j < i && !twin; j++) if (kit[j] == k) twin = true;   // (every spot at the origin: < 2.6 m)
      if (!twin) break;
    }
    if (i < kitOf.size() && kitOf[i] >= 0) k = kitOf[i];
    kit[i] = uint8_t(k);
    const FanKit& K = *kits[size_t(k)];
    const double sc = K.cfg.s0 + rnd() * (K.cfg.s1 - K.cfg.s0);
    const double sy = sc * (0.98 + rnd() * 0.04);
    scl[i * 2] = float(sc); scl[i * 2 + 1] = float(sy);
    setPlace(int(i), 0, 0, 0, 0);
    energy[i] = float(0.35 + rnd() * 0.65);
    phase[i] = float(rnd() * PI * 2);
    rate[i] = float(0.88 + rnd() * 0.26);
    thresh[i] = float(0.03 + rnd() * 0.42);
    jumper[i] = K.name != "fan_elder" && rnd() < (K.name == "fan_kid" ? 0.5 : 0.16) ? 1 : 0;
    const double freeV = 0.5;
    rnd();   // (pr: the spots' prop is fixed: none)
    int prop = 0;
    int st;
    {
      const int opts[8] = {CLAP, CLAP, CLAP, CLAPHI, PUMP, WAVE, VUP, VUP};
      st = opts[int(std::floor(rnd() * 8))];
      if (st == VUP && freeV < 0.85) st = CLAPHI;
    }
    style[i] = uint8_t(st);
    calm[i] = uint8_t(rnd() < 0.25 ? int(HOLD) : rnd() < 0.15 ? int(POCKET) : 0);
    float* o = &palC[i * 8];
    if (!K.hasBase || rnd() < K.cfg.keep) { o[0] = -1; o[1] = 0; o[2] = 0; }
    else {
      const char* hex = JACKETS[int(std::floor(rnd() * 13))];
      unsigned v = unsigned(std::strtoul(hex + 1, nullptr, 16));
      // (THREE.Color.set(hex) already takes it to linear; fans.js converts once more: as the JS does it)
      double c3[3] = {double((v >> 16) & 255) / 255, double((v >> 8) & 255) / 255, double(v & 255) / 255};
      for (int c = 0; c < 3; c++) o[c] = float(srgbToLinear(srgbToLinear(c3[c])));
    }
    o[3] = float(prop);
    o[4] = float(std::floor(rnd() * 7)); o[5] = float(rnd() * 6.28); o[6] = 0; o[7] = float(std::floor(rnd() * 6));
    lookY[i] = float((rnd() - 0.5) * 0.4);
  }
}

void FanCrowd::setPlace(int i, double x, double y, double z, double yw) {
  float* m = &mat[size_t(i) * 16];
  const double sx = scl[size_t(i) * 2], sy = scl[size_t(i) * 2 + 1], c = std::cos(yw), s = std::sin(yw);
  m[0] = float(c * sx); m[1] = 0; m[2] = float(-s * sx); m[3] = 0;
  m[4] = 0; m[5] = float(sy); m[6] = 0; m[7] = 0;
  m[8] = float(s * sx); m[9] = 0; m[10] = float(c * sx); m[11] = 0;
  m[12] = float(x); m[13] = float(y); m[14] = float(z); m[15] = 1;
  pos[size_t(i) * 3] = float(x); pos[size_t(i) * 3 + 1] = float(y + 1); pos[size_t(i) * 3 + 2] = float(z);
  yaw[size_t(i)] = float(yw);
}

// one moving person's skeleton: legs walking (two neighbouring baked phases of the cycle) or standing (weight shifting
// from leg to leg), arms swinging / at rest / gesturing while talking / holding something, the head turned where the
// simulation wants it (with small glances and nods of its own)
void FanCrowd::poseDyn(int i, double t, double dt) {
  const size_t u = size_t(i);
  const FanKit& K = *kits[kit[u]];
  const float* kq = K.kq.data();
  const float* kh = K.kh.data();
  const double ph = phase[u], tt = t * double(rate[u]);
  const double walk = D.walk[u], stand = 1 - walk;
  const double wp = jsMod1(jsMod1(D.wph[u]) + 1) * NWALK;
  const int j0 = int(std::floor(wp)) % NWALK, j1 = (j0 + 1) % NWALK;
  const double f = wp - std::floor(wp);
  const double ws = 0.5 + 0.5 * std::sin(tt * 0.52 + ph), wsS = ws * ws * (3 - 2 * ws);
  int ks[12];
  float wsv[12];
  int nk = 0;
  auto add = [&](int k, double w) { if (w > 0.001 && nk < 12) { ks[nk] = k; wsv[nk] = float(w); nk++; } };
  // lower body
  add(WALK0 + j0, walk * (1 - f)); add(WALK0 + j1, walk * f);
  add(STAND_L, stand * (1 - wsS)); add(STAND_R, stand * wsS);
  for (int b : LOWER) blendN(kq, b, ks, wsv, nk, &L[b * 4]);
  double hx = 0, hy = 0, hz = 0, sw = 0;
  for (int k = 0; k < nk; k++) { const int o = ks[k] * 3; const double w = wsv[k]; hx += kh[o] * w; hy += kh[o + 1] * w; hz += kh[o + 2] * w; sw += w; }
  hx /= sw; hy /= sw; hz /= sw;
  // upper body
  const int hold = D.hold[u];
  const double holdW = hold ? double(D.holdW[u]) : 0, freeW = 1 - holdW;
  const double talk = D.talk[u] * stand;
  nk = 0;
  add(WALK0 + j0, walk * (1 - f) * freeW); add(WALK0 + j1, walk * f * freeW);
  const int calmK = calm[u];
  const double calmW = stand * freeW * (1 - talk * 0.85);
  add(calmK ? calmK : int(STAND_L), calmW * (calmK ? 1 : 1 - wsS));
  if (!calmK) add(STAND_R, calmW * wsS);
  if (talk > 0.001) {
    // gestures come and go in their own rhythm (a speaker's hands are seldom still, a listener's seldom move)
    const double g1 = std::pow(std::max(0.0, std::sin(tt * 0.83 + ph * 3.1)), 2), g2 = std::pow(std::max(0.0, std::sin(tt * 0.61 + ph * 5.3 + 2)), 2);
    const double g3 = std::pow(std::max(0.0, std::sin(tt * 1.07 + ph * 7.7 + 4)), 2), g4 = std::pow(std::max(0.0, std::sin(tt * 0.37 + ph * 2.3 + 1)), 6) * 0.7;
    const double gs = g1 + g2 + g3 + g4 + 0.5, k = talk * stand * freeW * 0.85 / gs;
    add(TALK_A, g1 * k); add(TALK_B, g2 * k); add(TALK_C, g3 * k); add(SHRUG, g4 * k);
    if (nk < 12) { wsv[nk] = float(0.5 * k); ks[nk] = calmK ? calmK : int(STAND_L); nk++; }
  }
  if (holdW > 0.001) add(hold, holdW);
  if (nk == 0) add(STAND_L, 1);
  const bool carry = D.carry[u] != 0;
  for (int b : UPPER) {
    if (carry && (b == RightShoulder || b == RightArm || b == RightForeArm || b == RightHand)) blend4(kq, b, CARRY, 1, 0, 0, 0, 0, 0, 0, &L[b * 4]);
    else blendN(kq, b, ks, wsv, nk, &L[b * 4]);
  }
  // head: where the simulation looks, small glances while standing, nods while in a conversation
  const double ly = D.lookY[u] + stand * (std::sin(tt * 0.31 + ph * 1.7) * 0.22 + std::sin(tt * 0.13 + ph * 4.1) * 0.18) * (1 - D.talk[u] * 0.7);
  double lp = D.lookP[u];
  if (D.talk[u] > 0.02) lp += 0.16 * std::pow(std::max(0.0, std::sin(tt * 2.3 + ph * 3)), 8) * (1.2 - talk);
  const double kL = std::min(1.0, dt * 4);
  lookY[u] = float(lookY[u] + (ly - lookY[u]) * kL);
  lookP[u] = float(lookP[u] + (lp - lookP[u]) * kL);
  palC[u * 8 + 3] = carry ? 3.f : 0.f;   // (the skis show with the carry)
  composeRow(K, L, hx, hy, hz, lookY[u], lookP[u], nullptr, carry, &pal[u * NB * 12], W, Pw);
}

} // namespace sl
