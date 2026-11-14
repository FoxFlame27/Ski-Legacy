// skier.js SkierRig, ported operation for operation (see skier_rig.h). Comments in quotes are the JS's own.
#include "player/skier_rig.h"
#include "core/log.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace sl {
using namespace three;

namespace {
const V3 X_AXIS(1, 0, 0), DOWN(0, -1, 0);
constexpr double SKI_LENGTH = 1.68, SKI_MAX_WIDTH = 0.11, POLE_LEN = 1.25;
const char* BONE_NAMES[RigModel::NB] = {"Hips", "Spine02", "Spine01", "Spine", "neck", "Head", "LeftShoulder", "RightShoulder", "LeftArm", "LeftForeArm",
                                        "LeftHand", "RightArm", "RightForeArm", "RightHand", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot"};
// "Grabs: which hand reaches which ski (0 left, 1 right), where along it (m in front of the boot), outer (+1) or inner
// (-1) edge, how far the knees pull up, extra hip flex, skis pulled back (m), ski pitch (+ tips up) and the shoulder twist"
struct GrabPose { int hand, ski; double along, out, lift, flex, feetF, pitch, twist; };
const GrabPose GRAB_POSES[4] = {
  {1, 0, 0.14, 1, 0.42, 0.42, 0, 0.06, 0.3},          // (none: mute)
  {1, 0, 0.14, 1, 0.42, 0.42, 0, 0.06, 0.3},          // mute
  {1, 1, -0.02, 1, 0.38, 0.36, 0, 0.12, -0.12},       // safety
  {0, 1, 0.12, 1, 0.45, 0.48, -0.14, -0.28, -0.32},   // japan
};
// "Crash poses in the skier's upright frame"
struct FallPose { double hipH, hipF, flex, curl, footH, footF, footW, knee, neck; double g[3], t[3]; };
const FallPose FP_LIE = {0.8, -0.04, 0.42, 0.12, 0.06, 0.24, 0.13, 0.18, -0.05, {0.12, 0.32, 0.36}, {0.3, -0.48, 0.02}};
const FallPose FP_BALL = {0.6, -0.05, 1.05, 0.45, 0.26, 0.2, 0.12, 0.42, -0.35, {0.36, -0.44, -0.02}, {0.36, -0.44, -0.02}};
const FallPose FP_CROUCH = {0.5, -0.1, 0.95, 0.18, 0, 0.05, 0.15, 0.3, 0.25, {0.32, -0.62, 0.3}, {0.32, -0.46, 0.12}};
const FallPose FP_STAND = {0, -0.03, 0.36, 0, 0, 0, 0.13, 0.15, 0.25, {0.3, -0.36, 0.07}, {0.3, -0.36, 0.07}};
FallPose mixPose(const FallPose& a, const FallPose& b, double t) {
  FallPose o;
  o.hipH = a.hipH + (b.hipH - a.hipH) * t; o.hipF = a.hipF + (b.hipF - a.hipF) * t; o.flex = a.flex + (b.flex - a.flex) * t;
  o.curl = a.curl + (b.curl - a.curl) * t; o.footH = a.footH + (b.footH - a.footH) * t; o.footF = a.footF + (b.footF - a.footF) * t;
  o.footW = a.footW + (b.footW - a.footW) * t; o.knee = a.knee + (b.knee - a.knee) * t; o.neck = a.neck + (b.neck - a.neck) * t;
  for (int i = 0; i < 3; i++) { o.g[i] = a.g[i] + (b.g[i] - a.g[i]) * t; o.t[i] = a.t[i] + (b.t[i] - a.t[i]) * t; }
  return o;
}
inline double sgn(double x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }   // Math.sign
} // namespace

// =================================================================== the character's measurements (constructor)
namespace {
// a skeleton walker on the model alone (root at the origin): the rest pose's world matrices
struct RestGraph {
  const Model& m;
  std::vector<M4> W;
  std::vector<V3> t, s; std::vector<Q> r;
  explicit RestGraph(const Model& model) : m(model) {
    size_t n = m.nodes.size();
    t.resize(n); s.resize(n); r.resize(n); W.resize(n);
    for (size_t i = 0; i < n; i++) { t[i] = V3(m.nodes[i].t); s[i] = V3(m.nodes[i].s); r[i] = Q(m.nodes[i].r.w, m.nodes[i].r.x, m.nodes[i].r.y, m.nodes[i].r.z); }
    update();
  }
  void update() {
    for (size_t i = 0; i < m.nodes.size(); i++) {
      M4 L = compose(t[i], r[i], s[i]);
      W[i] = m.nodes[i].parent >= 0 ? W[size_t(m.nodes[i].parent)] * L : L;
    }
  }
  V3 pos(int i) const { return V3(W[size_t(i)][3]); }
};
} // namespace

bool RigModel::build(std::shared_ptr<Model> m, const Model* anims, const std::function<double(double, double, double)>& ground,
                     const std::function<double()>& random) {
  body = std::move(m);
  if (!body || body->skins.empty()) return false;
  name = body->name;
  const Model& md = *body;
  size_t n = md.nodes.size();
  for (int k = 0; k < NB; k++) b[k] = md.findNode(BONE_NAMES[k]);
  for (int k = 0; k < NB; k++) if (b[k] < 0) { SL_WARN("rig %s: no bone %s", name.c_str(), BONE_NAMES[k]); return false; }
  // the bones in three's traversal order (depth first from the roots, children in file order)
  std::vector<uint8_t> isJoint(n, 0);
  for (int j : md.skins[0].joints) isJoint[size_t(j)] = 1;
  bones.clear();
  std::function<void(int)> walk = [&](int i) {
    if (isJoint[size_t(i)]) bones.push_back(i);
    for (int c : md.nodes[size_t(i)].children) walk(c);
  };
  for (int r : md.roots) walk(r);
  below.assign(n, {});
  for (size_t i = 0; i < n; i++) {
    std::function<void(int)> add = [&](int k) { below[i].push_back(k); for (int c : md.nodes[size_t(k)].children) add(c); };
    add(int(i));
  }
  // the skinned primitive (three: the last SkinnedMesh traversed; these rigs have one)
  for (size_t ni = 0; ni < n; ni++) {
    const Node& nd = md.nodes[ni];
    if (nd.mesh < 0 || nd.skin < 0) continue;
    const Mesh& mesh = md.meshes[size_t(nd.mesh)];
    for (size_t p = 0; p < mesh.primitives.size(); p++)
      if (mesh.primitives[p].skinned && mesh.primitives[p].cpuVerts) { skinMesh = nd.mesh; skinPrim = int(p); break; }
  }
  RestGraph R(md);
  auto WP = [&](int k) { return R.pos(b[k]); };
  hipRest = WP(hips);
  ankleH = WP(lFoot).y;
  V3 lUp0 = WP(lUp);
  hipDrop = hipRest.y - lUp0.y;
  legLen = glm::distance(WP(lUp), WP(lLeg)) + glm::distance(WP(lLeg), WP(lFoot));
  thighLen = glm::distance(WP(lUp), WP(lLeg));
  shinLen = legLen - thighLen;
  footRest[0] = decomposeQ(R.W[size_t(b[lFoot])]);
  footRest[1] = decomposeQ(R.W[size_t(b[rFoot])]);
  footRestInv[0] = conj(footRest[0]); footRestInv[1] = conj(footRest[1]);
  shoulderW = glm::distance(WP(lArm), WP(rArm));
  armLen = glm::distance(WP(lArm), WP(lFore)) + glm::distance(WP(lFore), WP(lHand));
  hipWidth = std::fabs(WP(lUp).x - WP(rUp).x);
  upLegDrop = hipRest.y - WP(lUp).y;
  footFwd = WP(lFoot).z - WP(lUp).z;
  {
    V3 sh = WP(lArm), el = WP(lFore);
    armRaise = std::atan2(el.y - sh.y + glm::distance(sh, el), glm::distance(sh, el));
    V3 s0 = WP(spine0), nk = WP(neck);
    postureFix = std::atan2(s0.z - nk.z, nk.y - s0.y) + 0.06;
  }
  // skinned vertices at the bind pose (bindVertex: bone.matrixWorld * boneInverse * bindMatrix, bindMatrix = I)
  const Skin& sk = md.skins[0];
  std::vector<M4> B(sk.joints.size());
  for (size_t j = 0; j < sk.joints.size(); j++) B[j] = R.W[size_t(sk.joints[j])] * glm::dmat4(sk.inverseBind[j]);
  const std::vector<float>* V = nullptr;
  if (skinPrim >= 0) V = md.meshes[size_t(skinMesh)].primitives[size_t(skinPrim)].cpuVerts.get();
  size_t nv = V ? V->size() / 16 : 0;
  auto jointOf = [&](int node) { for (size_t j = 0; j < sk.joints.size(); j++) if (sk.joints[j] == node) return int(j); return -1; };
  auto bindVertex = [&](size_t i, const std::vector<M4>& Bm) {
    const float* q = &(*V)[i * 16];
    V3 v(q[0], q[1], q[2]), o(0);
    for (int k = 0; k < 4; k++) { double w = q[12 + k]; if (w) o += mulPoint(Bm[size_t(q[8 + k])], v) * w; }
    return o;
  };
  // measureHand: the hand's shape (fingers' direction, palm normal) in hand-bone space
  for (int h = 0; h < 2; h++) {
    int hb = b[h == 0 ? lHand : rHand], bi = jointOf(hb);
    if (!V || bi < 0) continue;
    std::vector<V3> pts;
    for (size_t i = 0; i < nv; i++) {
      const float* q = &(*V)[i * 16];
      double w = 0;
      for (int k = 0; k < 4; k++) if (int(q[8 + k]) == bi) w += q[12 + k];
      if (w > 0.6) pts.push_back(bindVertex(i, B));
    }
    if (pts.size() < 20) continue;
    V3 joint = R.pos(hb), c(0);
    for (auto& p : pts) c += p;
    c /= double(pts.size());
    double cov[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
    for (auto& p : pts) { double d[3] = {p.x - c.x, p.y - c.y, p.z - c.z}; for (int r = 0; r < 3; r++) for (int k = 0; k < 3; k++) cov[r][k] += d[r] * d[k]; }
    V3 ev[3];
    eigen3(cov, ev);
    V3 normal = ev[2];
    if (normal.z < 0) normal = -normal;
    V3 dir = normalize(c - joint);
    Q inv = conj(decomposeQ(R.W[size_t(hb)]));
    hand[h].ok = true; hand[h].dir = applyQ(dir, inv); hand[h].normal = applyQ(normal, inv);
  }
  // measureHips: hip / jacket half-width at bind pose
  hipHalfW = 0.17; backDepth = 0.2; seatDepth = 0.2;
  if (V) {
    std::vector<uint8_t> pel(sk.joints.size(), 0);
    for (int k : {hips, lUp, rUp, spine0}) { int j = jointOf(b[k]); if (j >= 0) pel[size_t(j)] = 1; }
    double wide = 0;
    for (size_t i = 0; i < nv; i++) {
      const float* q = &(*V)[i * 16];
      double wp = 0;
      for (int k = 0; k < 4; k++) if (pel[size_t(q[8 + k])]) wp += q[12 + k];
      if (wp < 0.5) continue;
      V3 v = bindVertex(i, B);
      if (v.y > hipRest.y - 0.28 && v.y < hipRest.y + 0.08) wide = std::max(wide, std::fabs(v.x - hipRest.x));
    }
    if (wide > 0.08) hipHalfW = std::min(0.3, wide);
  }
  // clips (setupClips): root motion stripped, each cycle's natural speed measured
  hasClips = false;
  if (anims) {
    const char* want[3] = {"idle", "walk", "run"};
    for (int k = 0; k < 3; k++) {
      const AnimClip* src = nullptr;
      for (const AnimClip& c : anims->clips) {
        std::string lo = c.name;
        for (auto& ch : lo) ch = char(std::tolower(unsigned(ch)));
        bool ok = k == 0 ? lo.rfind("idle", 0) == 0 : lo.find(want[k]) != std::string::npos;
        if (ok) { src = &c; break; }   // (Array.find: the first)
      }
      if (!src) continue;
      Clip& C = clips[k];
      C.clip = *src;
      C.ok = true;
      double dur = 0;
      for (auto& ch : C.clip.channels) if (!ch.times.empty()) dur = std::max(dur, double(ch.times.back()));
      C.clip.duration = float(dur);
      double speed = 0;
      for (auto& ch : C.clip.channels) {
        if (ch.path != AnimChannel::Path::T || ch.node.size() < 4 || ch.node.compare(ch.node.size() - 4, 4, "Hips") != 0) continue;
        auto& v = ch.values;
        size_t nk = v.size() / 3;
        speed = std::hypot(double(v[(nk - 1) * 3]) - v[0], double(v[(nk - 1) * 3 + 2]) - v[2]) * 0.01 / dur;
        float x0 = v[0], z0 = v[2];
        for (size_t i = 0; i < v.size(); i += 3) { v[i] = x0; v[i + 2] = z0; }
      }
      if (speed < 0.3) speed = k == 2 ? 3.6 : 1.3;
      C.speed = speed;
      C.node = bindClip(md, C.clip);
    }
    hasClips = clips[0].ok && clips[1].ok;
    if (!hasClips) for (auto& c : clips) c.ok = false;
  }
  // measureCarry: the jacket's back where carried skis rest, on the relaxed standing pose (a rig poses it)
  if (V) {
    auto self = std::shared_ptr<RigModel>(this, [](RigModel*) {});
    SkierRig rig;
    rig.random = random;
    rig.init(self, nullptr, false, false, [&](double x, double z, double y) { return ground(x, z, y); });
    rig.resetPose();
    RigState st;
    st.mode = RigMode::Idle;
    rig.poseFootClassic(0, st, V3(0, 0, 1), V3(-1, 0, 0));
    std::vector<M4> Bp(sk.joints.size());
    for (size_t j = 0; j < sk.joints.size(); j++) Bp[j] = rig.W(sk.joints[j]) * glm::dmat4(sk.inverseBind[j]);
    V3 fwd(0, 0, 1);
    V3 chest = rig.wpos(b[spine2]), hp = rig.wpos(b[hips]), neckP = rig.wpos(b[neck]), lowP = rig.wpos(b[spine0]);
    V3 up = normalize(neckP - lowP);
    V3 bk = normalize(-fwd + up * glm::dot(fwd, up));
    V3 side = normalize(glm::cross(up, bk));
    double uLow = glm::dot(lowP - chest, up) - 0.05, uTop = glm::dot(neckP - chest, up) + 0.05;
    std::vector<uint8_t> upper(sk.joints.size(), 0), pel(sk.joints.size(), 0);
    for (int k : {spine0, spine1, spine2, neck, lSh, rSh, lArm, rArm, head}) { int j = jointOf(b[k]); if (j >= 0) upper[size_t(j)] = 1; }
    for (int k : {hips, lUp, rUp, spine0}) { int j = jointOf(b[k]); if (j >= 0) pel[size_t(j)] = 1; }
    double back = 0, seat = 0;
    for (size_t i = 0; i < nv; i++) {
      const float* q = &(*V)[i * 16];
      double wu = 0, wp = 0;
      for (int k = 0; k < 4; k++) { size_t bi = size_t(q[8 + k]); double w = q[12 + k]; if (upper[bi]) wu += w; if (pel[bi]) wp += w; }
      if (wu < 0.3 && wp < 0.5) continue;
      V3 acc = bindVertex(i, Bp);
      if (wu >= 0.3) {
        V3 t = acc - chest;
        double u = glm::dot(t, up);
        if (u > uLow && u < uTop && std::fabs(glm::dot(t, side)) < 0.14) back = std::max(back, glm::dot(t, bk));
      }
      if (wp >= 0.5 && acc.y > hp.y - 0.3 && acc.y < hp.y + 0.08) {
        V3 t = acc - hp;
        if (std::fabs(glm::dot(t, side)) < 0.14) seat = std::max(seat, glm::dot(t, bk));
      }
    }
    if (back > 0.05) backDepth = std::min(0.42, back);
    if (seat > 0.05) seatDepth = std::min(0.42, seat);
  }
  return true;
}

// =================================================================== skis and poles (makeSki / makePole)
void RigGear::build(std::shared_ptr<Model> s, std::shared_ptr<Model> p) {
  ski = std::move(s); pole = std::move(p);
  if (ski) {
    // orientedSkiTemplate: the first mesh, in the file's frame (+X the length, +Y up), the tip the end that curls up more
    int mn = -1;
    for (size_t i = 0; i < ski->nodes.size() && mn < 0; i++) if (ski->nodes[i].mesh >= 0) mn = int(i);
    if (mn >= 0) {
      RestGraph R(*ski);
      M4 meshW = R.W[size_t(mn)];
      // the geometry's vertices (CPU copy) through the steps of fileFrameSki
      std::vector<V3> P;
      for (auto& pr : ski->meshes[size_t(ski->nodes[size_t(mn)].mesh)].primitives)
        if (pr.cpuVerts) { size_t st = pr.skinned ? 16 : 8; for (size_t v = 0; v + st <= pr.cpuVerts->size(); v += st) P.push_back(mulPoint(meshW, V3((*pr.cpuVerts)[v], (*pr.cpuVerts)[v + 1], (*pr.cpuVerts)[v + 2]))); break; }
      V3 up(0, 1, 0), len(1, 0, 0), wid = normalize(glm::cross(up, len));
      M4 F(1);   // makeBasis(wid, up, len).transpose(): file -> ski frame
      F[0] = glm::dvec4(wid.x, up.x, len.x, 0); F[1] = glm::dvec4(wid.y, up.y, len.y, 0); F[2] = glm::dvec4(wid.z, up.z, len.z, 0);
      auto apply = [&](const M4& m) { for (auto& v : P) v = mulPoint(m, v); };
      auto bbox = [&](V3& lo, V3& hi) { lo = V3(1e30); hi = V3(-1e30); for (auto& v : P) { lo = glm::min(lo, v); hi = glm::max(hi, v); } };
      M4 total = F * meshW;
      apply(F);
      V3 lo, hi;
      bbox(lo, hi);
      double sc = SKI_LENGTH / (hi.z - lo.z);
      M4 S = glm::scale(M4(1), V3(sc));
      apply(S); total = S * total;
      bbox(lo, hi);
      M4 T = glm::translate(M4(1), V3(-(hi.x + lo.x) / 2, 0, -(hi.z + lo.z) / 2));
      apply(T); total = T * total;
      double wide = hi.x - lo.x;   // (the bounding box before the centring: same width)
      if (wide > SKI_MAX_WIDTH) { M4 Sw = glm::scale(M4(1), V3(SKI_MAX_WIDTH / wide, 1, 1)); apply(Sw); total = Sw * total; }
      double h = SKI_LENGTH / 2, base = 1e30, tipUp = -1e30, tailUp = -1e30;
      for (auto& v : P) { double az = std::fabs(v.z) / h; if (az > 0.2 && az < 0.6) base = std::min(base, v.y); }
      if (base > 1e29) { bbox(lo, hi); base = lo.y; }
      M4 Tb = glm::translate(M4(1), V3(0, -base, 0));
      apply(Tb); total = Tb * total;
      for (auto& v : P) { double u = v.z / h; if (u > 0.93) tipUp = std::max(tipUp, v.y); else if (u < -0.93) tailUp = std::max(tailUp, v.y); }
      if (tailUp > tipUp * 1.15 + 0.004) { M4 Ry = glm::rotate(M4(1), PI, V3(0, 1, 0)); total = Ry * total; }
      skiFit = total * glm::inverse(meshW);   // (the renderer applies the node's own global)
      {
        V3 lo2(1e30), hi2(-1e30);
        double tip = -1, tail = -1;
        for (auto& v0 : P) {
          V3 v = (tailUp > tipUp * 1.15 + 0.004) ? V3(-v0.x, v0.y, -v0.z) : v0;
          lo2 = glm::min(lo2, v); hi2 = glm::max(hi2, v);
          if (v.z > 0.8) tip = std::max(tip, v.y);
          if (v.z < -0.8) tail = std::max(tail, v.y);
        }
        SL_INFO("rig skis %s: %.3f x %.3f x %.3f m (y %.4f .. %.4f), tip up %.3f, tail up %.3f", ski->name.c_str(), hi2.x - lo2.x, hi2.y - lo2.y, hi2.z - lo2.z, lo2.y, hi2.y, tip, tail);
      }
    }
  }
  if (pole) {
    // fitModel(gltf, { size: POLE_LEN, axis: 'y' }), then the grip at the origin: m.position.y = -POLE_LEN + 0.08
    RestGraph R(*pole);
    V3 lo(1e30), hi(-1e30);
    for (size_t i = 0; i < pole->nodes.size(); i++) {
      if (pole->nodes[i].mesh < 0) continue;
      for (auto& pr : pole->meshes[size_t(pole->nodes[i].mesh)].primitives)
        for (int c = 0; c < 8; c++) {
          V3 q((c & 1) ? pr.bmax.x : pr.bmin.x, (c & 2) ? pr.bmax.y : pr.bmin.y, (c & 4) ? pr.bmax.z : pr.bmin.z);
          V3 w = mulPoint(R.W[i], q);
          lo = glm::min(lo, w); hi = glm::max(hi, w);
        }
    }
    // (fitModel's group holds the clone centred on x / z, its bottom on y = 0; makePole moves the group down)
    double s = POLE_LEN / (hi.y - lo.y);
    V3 c = (lo + hi) * 0.5 * s;
    poleFit = glm::translate(M4(1), V3(-c.x, -POLE_LEN + 0.08 - lo.y * s, -c.z)) * glm::scale(M4(1), V3(s));
  }
}

// =================================================================== the rig
void SkierRig::init(std::shared_ptr<RigModel> model, std::shared_ptr<RigGear> gear, bool withSkis, bool withPoles, Ground ground) {
  M_ = std::move(model);
  G_ = std::move(gear);
  ground_ = std::move(ground);
  hasSkis_ = withSkis && G_ && G_->ski;
  hasPoles_ = withPoles && G_ && G_->pole;
  const Model& md = *M_->body;
  size_t n = md.nodes.size();
  t_.resize(n); s_.resize(n); r_.resize(n); W_.assign(n, M4(1)); dirty_.assign(n, 1);
  for (size_t i = 0; i < n; i++) { t_[i] = V3(md.nodes[i].t); s_[i] = V3(md.nodes[i].s); r_[i] = Q(md.nodes[i].r.w, md.nodes[i].r.x, md.nodes[i].r.y, md.nodes[i].r.z); }
  snapshot_.assign(n, Snap{Q(1, 0, 0, 0), V3(0)});
  rootPos = V3(0); rootHeading = 0;
  setRoot(rootPos, 0);
  // (the constructor's random phases)
  gait_.phase = rnd(); gait_.move = 0; gait_.run = 0; gait_.t = rnd() * 100;
  idle_.w = 0; idle_.side = 1; idle_.t = 4 + rnd() * 5;
  sk_ = Sk{};
  sk_.t = rnd() * 60;
  mode_ = prevMode_ = Mode::Foot;
  blend_ = 1;
  for (auto& p : plant_) p = Plant{};
  for (auto& a : armS_) a = ArmS{};
  skis[0].visible = skis[1].visible = true;
  poles[0].visible = poles[1].visible = true;
  setupMixer();
}

double SkierRig::rnd01() {
  rngState_ ^= rngState_ << 13; rngState_ ^= rngState_ >> 17; rngState_ ^= rngState_ << 5;
  return double(rngState_ >> 8) / double(1u << 24);
}

void SkierRig::setRoot(const V3& p, double heading) {
  rootPos = p; rootHeading = heading;
  rootQ_ = yaw(heading);
  rootM_ = compose(p, rootQ_, V3(1));
  std::fill(dirty_.begin(), dirty_.end(), uint8_t(1));
}
void SkierRig::setRootQuat(const Q& q) {
  rootQ_ = q;
  rootM_ = compose(rootPos, rootQ_, V3(1));
  std::fill(dirty_.begin(), dirty_.end(), uint8_t(1));
}

void SkierRig::touch(int i) const { for (int k : M_->below[size_t(i)]) dirty_[size_t(k)] = 1; }

M4 SkierRig::W(int i) const {
  if (dirty_[size_t(i)]) {
    int p = M_->body->nodes[size_t(i)].parent;
    M4 L = compose(t_[size_t(i)], r_[size_t(i)], s_[size_t(i)]);
    W_[size_t(i)] = (p >= 0 ? W(p) : rootM_) * L;
    dirty_[size_t(i)] = 0;
  }
  return W_[size_t(i)];
}

void SkierRig::setWorldQuat(int bone, const Q& q) {
  int p = M_->body->nodes[size_t(bone)].parent;
  Q pq = p >= 0 ? wquat(p) : rootQ_;
  setLocalR(bone, mul(conj(pq), q));
}
void SkierRig::rotateWorld(int bone, const V3& axis, double angle) {
  Q q2 = wquat(bone);
  setWorldQuat(bone, mul(axisAngle(axis, angle), q2));
}
void SkierRig::aimBone(int bone, const V3& from, const V3& to, const V3& pivot) {
  V3 u = normalize(from - pivot), w = normalize(to - pivot);
  if (lengthSq(u) < 1e-8 || lengthSq(w) < 1e-8) return;
  Q q = fromUnitVectors(u, w);
  setWorldQuat(bone, mul(q, wquat(bone)));
}
// "Exact two-bone IK: place the middle joint on the circle of valid positions toward `pole`, then aim the upper bone at
// it and the lower bone at the target (minimal-twist rotations)."
void SkierRig::solveTwoBone(int a, int b, int c, const V3& target, const V3& pole) {
  V3 pa = wpos(a), pb = wpos(b), pc = wpos(c);
  double lab = glm::distance(pa, pb), lcb = glm::distance(pb, pc);
  V3 dir = target - pa;
  double dist = clamp(glm::length(dir), std::fabs(lab - lcb) + 1e-3, (lab + lcb) * 0.9995);
  dir = normalize(dir);
  double cosA = clamp((lab * lab + dist * dist - lcb * lcb) / (2 * lab * dist), -1, 1);
  double sinA = std::sqrt(1 - cosA * cosA);
  V3 pp = pole + dir * (-glm::dot(pole, dir));
  if (lengthSq(pp) < 1e-8) pp = V3(0, 0, 1) + dir * (-dir.z);
  pp = normalize(pp);
  V3 knee = pa + dir * (lab * cosA) + pp * (lab * sinA);
  aimBone(a, pb, knee, pa);
  V3 pb2 = wpos(b), pc2 = wpos(c);
  V3 end = pa + dir * dist;
  aimBone(b, pc2, end, pb2);
}

void SkierRig::resetPose() {
  const Model& md = *M_->body;
  for (int i : M_->bones) {
    const Node& nd = md.nodes[size_t(i)];
    t_[size_t(i)] = V3(nd.t); s_[size_t(i)] = V3(nd.s); r_[size_t(i)] = Q(nd.r.w, nd.r.x, nd.r.y, nd.r.z);
  }
  std::fill(dirty_.begin(), dirty_.end(), uint8_t(1));
}

void SkierRig::snapPose() {
  snapNext_ = true;
  fallLift_ = 0; fallLiftV_ = 0;
  airW_ = 0;
  for (auto& p : plant_) p.t = 1;
  sk_.init = false; poleDirOk_ = false;
}

void SkierRig::setSkisVisible(bool v) {
  skis[0].visible = skis[1].visible = v;
  poles[0].visible = poles[1].visible = v && !polesHidden;
}

V3 SkierRig::eyeWorld() const { return wpos(M_->b[RigModel::head]) + applyQ(M_->eyeOffset, rootQ_); }

void SkierRig::startPolePlant(int side, const V3& fwd, const V3& right) {
  if (!hasPoles_) return;   // "a skier without poles keeps the hands in the ski stance"
  Plant& p = plant_[side];
  if (p.t < 0.6) return;
  p.t = 0; p.rel = false;
  double s = side == 0 ? 1 : -1;
  double lead = fp_ ? 0.5 : std::min(2.6, 0.5 + sk_.spd * 0.14);
  p.tip = rootPos + fwd * lead + right * (-s * (fp_ ? 0.74 : 0.46));
  p.tip.y = ground(p.tip.x, p.tip.z, rootPos.y + 0.5);
}

// ------------------------------------------------------------------- the mixer (three's AnimationMixer)
void SkierRig::setupMixer() {
  bindings_.clear(); actions_.clear();
  mixerOk_ = M_->hasClips;
  if (!mixerOk_) return;
  clipW_[0] = 0; clipW_[1] = 1; clipW_[2] = 0;   // (setupClips: w = k === 'walk' ? 1 : 0)
  for (int k = 0; k < 3; k++) {
    const RigModel::Clip& C = M_->clips[k];
    if (!C.ok) continue;
    Action a;
    a.clip = k;
    a.weight = k == 0 ? 1 : 0;
    for (size_t c = 0; c < C.clip.channels.size(); c++) {
      int node = C.node[c];
      int path = int(C.clip.channels[c].path);
      if (node < 0) { a.bind.push_back(-1); continue; }
      int bi = -1;
      for (size_t q = 0; q < bindings_.size(); q++) if (bindings_[q].node == node && bindings_[q].path == path) bi = int(q);
      if (bi < 0) {
        Binding B;
        B.node = node; B.path = path;
        std::memset(B.buf, 0, sizeof(B.buf));
        double o[4] = {0, 0, 0, 0};
        if (path == int(AnimChannel::Path::R)) { const Q& q = r_[size_t(node)]; o[0] = q.x; o[1] = q.y; o[2] = q.z; o[3] = q.w; }
        else { const V3& v = path == int(AnimChannel::Path::T) ? t_[size_t(node)] : s_[size_t(node)]; o[0] = v.x; o[1] = v.y; o[2] = v.z; }
        for (int r = 1; r <= 3; r++) std::memcpy(B.buf[r], o, sizeof(o));   // saveOriginalState
        bindings_.push_back(B);
        bi = int(bindings_.size()) - 1;
      }
      a.bind.push_back(bi);
    }
    actions_.push_back(std::move(a));
  }
}

void SkierRig::mixerUpdate(double dt) {
  accuIndex_ ^= 1;
  const int acc = 1 + accuIndex_;
  for (Action& a : actions_) {
    const RigModel::Clip& C = M_->clips[a.clip];
    double dur = C.clip.duration;
    double time = a.time + dt * a.timeScale;
    if (dur > 0 && (time >= dur || time < 0)) time -= dur * std::floor(time / dur);
    a.time = time;
    if (!(a.weight > 0)) continue;
    for (size_t c = 0; c < C.clip.channels.size(); c++) {
      int bi = a.bind[c];
      if (bi < 0) continue;
      Binding& B = bindings_[size_t(bi)];
      const AnimChannel& ch = C.clip.channels[c];
      const auto& T = ch.times;
      if (T.empty()) continue;
      const int stride = B.path == int(AnimChannel::Path::R) ? 4 : 3;
      double* in = B.buf[0];
      size_t k1 = size_t(std::upper_bound(T.begin(), T.end(), float(time)) - T.begin());
      // (three's Interpolant searches with the double time: same interval unless the time sits on a key)
      while (k1 > 0 && double(T[k1 - 1]) > time) k1--;
      while (k1 < T.size() && double(T[k1]) <= time) k1++;
      const float* v = ch.values.data();
      if (k1 == 0 || ch.step) { size_t k = k1 == 0 ? 0 : k1 - 1; for (int i = 0; i < stride; i++) in[i] = v[k * size_t(stride) + size_t(i)]; }
      else if (k1 >= T.size()) { size_t k = T.size() - 1; for (int i = 0; i < stride; i++) in[i] = v[k * size_t(stride) + size_t(i)]; }
      else {
        double t0 = T[k1 - 1], t1 = T[k1], alpha = (time - t0) / (t1 - t0);
        if (stride == 4) {
          double a0[4], a1[4];
          for (int i = 0; i < 4; i++) { a0[i] = v[(k1 - 1) * 4 + size_t(i)]; a1[i] = v[k1 * 4 + size_t(i)]; }
          slerpFlat(in, a0, a1, alpha);
        } else {
          double w1 = alpha, w0 = 1 - w1;
          for (int i = 0; i < 3; i++) in[i] = double(v[(k1 - 1) * 3 + size_t(i)]) * w0 + double(v[k1 * 3 + size_t(i)]) * w1;
        }
      }
      // accumulate
      if (B.cum == 0) { for (int i = 0; i < stride; i++) B.buf[acc][i] = in[i]; B.cum = a.weight; }
      else {
        B.cum += a.weight;
        double mix = a.weight / B.cum;
        if (stride == 4) slerpFlat(B.buf[acc], B.buf[acc], in, mix);
        else for (int i = 0; i < 3; i++) B.buf[acc][i] = B.buf[acc][i] * (1 - mix) + in[i] * mix;
      }
    }
  }
  for (Binding& B : bindings_) {
    const int stride = B.path == int(AnimChannel::Path::R) ? 4 : 3;
    double w = B.cum;
    B.cum = 0;
    if (w < 1) {
      double t = 1 - w;
      if (stride == 4) slerpFlat(B.buf[acc], B.buf[acc], B.buf[3], t);
      else for (int i = 0; i < 3; i++) B.buf[acc][i] = B.buf[acc][i] * (1 - t) + B.buf[3][i] * t;
    }
    bool changed = false;
    for (int i = 0; i < stride; i++) if (B.buf[1][i] != B.buf[2][i]) { changed = true; break; }
    if (!changed) continue;
    const double* o = B.buf[acc];
    if (stride == 4) r_[size_t(B.node)] = Q(o[3], o[0], o[1], o[2]);
    else if (B.path == int(AnimChannel::Path::T)) t_[size_t(B.node)] = V3(o[0], o[1], o[2]);
    else s_[size_t(B.node)] = V3(o[0], o[1], o[2]);
    touch(B.node);
  }
}

// ------------------------------------------------------------------- update
void SkierRig::update(double dt, const RigState& st) {
  time_ += dt;
  frame_++;
  fx.clear();
  const RigModel& R = *M_;
  bool moving = st.speed > 0.35 || (mode_ == Mode::Move && st.speed > 0.15);
  bool onFoot = st.mode == RigMode::Walk || st.mode == RigMode::Idle;
  Mode mode = onFoot ? (mixerOk_ && moving ? Mode::Move : Mode::Foot)
                     : st.mode == RigMode::Sit ? Mode::Sit : st.mode == RigMode::Ski ? Mode::Ski : Mode::Fall;
  if (mode != mode_) {
    prevMode_ = mode_;
    mode_ = mode;
    for (int i : R.bones) { snapshot_[size_t(i)].q = r_[size_t(i)]; snapshot_[size_t(i)].p = t_[size_t(i)]; }
    if (hipsBase_.valid) { snapshot_[size_t(R.b[RigModel::hips])].q = hipsBase_.q; snapshot_[size_t(R.b[RigModel::hips])].p = hipsBase_.p; }
    if (mode == Mode::Fall) { fallLift_ = 0; fallLiftV_ = 0; }
    airW_ = st.air ? 1 : 0;
    blend_ = 0;
  }
  if (snapNext_) { blend_ = 1; snapNext_ = false; }
  if (st.fp >= 0 && bool(st.fp) != fp_) { fp_ = bool(st.fp); bodyVisible = true; }
  bool hideGear = fp_ && st.mode == RigMode::Fall;
  if (hideGear != fpGearHidden_) { fpGearHidden_ = hideGear; gearVisible = !hideGear; bodyVisible = !hideGear; }
  bool benchSit = st.mode == RigMode::Sit && st.hasBench && st.hasSeat;
  if (benchSit) gearVisible = false;
  else if (benchGearHidden_) gearVisible = !fpGearHidden_;
  benchGearHidden_ = benchSit;

  V3 fwd(std::sin(st.heading), 0, std::cos(st.heading));
  V3 right = normalize(glm::cross(fwd, UP));
  setRoot(rootPos, st.heading);
  resetPose();
  if (mode == Mode::Move) poseFootClips(dt, st);
  else if (mode == Mode::Foot) poseFootClassic(dt, st, fwd, right);
  else if (mode == Mode::Sit) poseSit(dt, st, fwd, right);
  else if (mode == Mode::Ski) poseSki(dt, st, fwd, right);
  else poseFall(dt, st, fwd, right);

  if (blend_ < 1) {
    blend_ = std::min(1.0, blend_ + dt / 0.3);
    double t = blend_ * blend_ * (3 - 2 * blend_);
    for (int i : R.bones) {
      r_[size_t(i)] = three::slerp(snapshot_[size_t(i)].q, r_[size_t(i)], t);
      t_[size_t(i)] = snapshot_[size_t(i)].p + (t_[size_t(i)] - snapshot_[size_t(i)].p) * t;
    }
    std::fill(dirty_.begin(), dirty_.end(), uint8_t(1));
  }
  s_[size_t(R.b[RigModel::head])] = V3(headHidden_ ? 0.001 : 1);
  // "first person with the pole view model: the body's own arms fold away (one pair of hands, and nothing to glitch);
  // on foot too (the walk / run clips pump the forearms right in front of the eye)"
  bool armsAway = fp_ && (fpView.visible || mode_ == Mode::Move || mode_ == Mode::Foot);
  s_[size_t(R.b[RigModel::lArm])] = s_[size_t(R.b[RigModel::rArm])] = V3(armsAway ? 0.001 : 1);
  hipsBase_.q = r_[size_t(R.b[RigModel::hips])];
  hipsBase_.p = t_[size_t(R.b[RigModel::hips])];
  hipsBase_.valid = true;
  setRoot(rootPos, rootHeading);
  eyeStable = eyeWorld();
  // "...and the point a flip turns the body about (flipBody): the first-person eye goes round it too"
  if (fp_) { fpFlipC = wpos(R.b[RigModel::hips]) + UP * 0.08; hasFpFlipC = true; }
  if (mode == Mode::Fall) placeFallen(dt, st);
  updateGear(dt, st, fwd, right);
  bool polesOn = !fp_ && (!hasSkis_ || skis[0].visible) && !polesHidden;
  poles[0].visible = poles[1].visible = polesOn;
  if (mode == Mode::Ski && st.flip != 0) flipBody(st);
}

// "Lower both collarbones a little so the shoulder joint doesn't have to rotate the full way down"
void SkierRig::relaxShoulders(double amount) {
  const RigModel& R = *M_;
  int sets[2][3] = {{R.b[RigModel::lSh], R.b[RigModel::lArm], R.b[RigModel::lFore]}, {R.b[RigModel::rSh], R.b[RigModel::rArm], R.b[RigModel::rFore]}};
  for (auto& s : sets) {
    V3 a = wpos(s[1]), e = wpos(s[2]);
    V3 dir = normalize(e - a);
    V3 axis = glm::cross(dir, DOWN);
    if (lengthSq(axis) < 1e-6) continue;
    rotateWorld(s[0], normalize(axis), 0.3 * R.armRaise * amount);
  }
}
void SkierRig::fixPosture(const V3& right) {
  rotateWorld(M_->b[RigModel::spine0], right, -M_->postureFix * 0.7);
  rotateWorld(M_->b[RigModel::spine2], right, -M_->postureFix * 0.3);
}
// "Rotate the hand so its fingers point along `dir` and its palm faces `palm` (world vectors)."
void SkierRig::aimHand(int i, const V3& dir, const V3& palm) {
  const RigModel::Hand& hg = M_->hand[i];
  int hand = M_->b[i == 0 ? RigModel::lHand : RigModel::rHand];
  if (!hg.ok) return;
  Q q = wquat(hand);
  V3 d = normalize(dir);
  V3 curDir = applyQ(hg.dir, q);
  q = mul(fromUnitVectors(curDir, d), q);
  V3 n = applyQ(hg.normal, q);
  V3 pn = normalize(n + d * (-glm::dot(n, d)));
  V3 pt = normalize(palm + d * (-glm::dot(palm, d)));
  if (lengthSq(pn) > 1e-6 && lengthSq(pt) > 1e-6) {
    double ang = std::atan2(glm::dot(glm::cross(pn, pt), d), glm::dot(pn, pt));
    q = mul(axisAngle(d, ang), q);
  }
  setWorldQuat(hand, q);
}
void SkierRig::relaxHand(int i, const V3& palm, double curl) {
  int fore = M_->b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = M_->b[i == 0 ? RigModel::lHand : RigModel::rHand];
  V3 dir = normalize(wpos(hand) - wpos(fore));
  dir = normalize(dir + palm * curl);
  aimHand(i, dir, palm);
}

// ------------------------------------------------------------------- on foot
void SkierRig::poseFootClips(double dt, const RigState& st) {
  double v = std::max(0.0, st.speed);
  double r = M_->clips[2].ok ? smoothstep(v, 1.45, 1.65) : 0;
  double target[3] = {0, 1 - r, r};
  double sum = 0, k = 1 - std::exp(-dt * 8);
  for (int c = 0; c < 3; c++) if (M_->clips[c].ok) { clipW_[c] += (target[c] - clipW_[c]) * k; sum += clipW_[c]; }
  for (Action& a : actions_) {
    int c = a.clip;
    a.weight = clipW_[c] / (sum != 0 ? sum : 1);
    if (c == 1 || c == 2) a.timeScale = clamp(v / M_->clips[c].speed, c == 2 ? 0.3 : 0.5, c == 2 ? 2.6 : 1.8);
  }
  mixerUpdate(dt);
  V3 rp = rootPos;
  rp.y = ground(rp.x, rp.z, rp.y - st.airY + 0.4) + st.airY;
  rootPos = rp;   // (the root's matrix follows after the blend: nothing reads it before)
  skiPosOk_ = false;
}

void SkierRig::poseFootClassic(double dt, const RigState& st, const V3& fwd, const V3& right) {
  const RigModel& R = *M_;
  const int* b = R.b;
  double v = std::max(0.0, st.speed);
  auto& g = gait_;
  g.t += dt;
  g.move += (smoothstep(v, 0.05, 0.7) - g.move) * std::min(1.0, dt * 8);
  g.run += (smoothstep(v, 2.3, 3.6) - g.run) * std::min(1.0, dt * 5);
  const double move = g.move, run = g.run;
  const double stride = clamp(0.55 + 0.38 * v, 0.9, 2.6);
  if (move > 0.01) g.phase = std::fmod(g.phase + (v * dt) / stride, 1.0);
  const double phase = g.phase;
  const double stanceFrac = lerp(0.62, 0.38, run);
  const double lift = lerp(0.11, 0.26, run);
  const V3 root = rootPos;
  const double stand = 1 - move;
  auto& I = idle_;
  I.t -= dt;
  if (I.t <= 0) { I.side = -I.side; I.t = 5 + rnd() * 6; }
  I.w += (I.side - I.w) * (1 - std::exp(-dt * 1.3));
  const double w = I.w * stand;
  struct FP { V3 fp; double pitch, ground; } footPos[2];
  for (int i = 0; i < 2; i++) {
    double side = i == 0 ? -1 : 1;
    double p = std::fmod(phase + (i == 0 ? 0 : 0.5), 1.0);
    double along, up = 0, pitch = 0;
    double half = (stanceFrac * stride) / 2;
    if (p < stanceFrac) {
      along = half - (p / stanceFrac) * 2 * half;
      pitch = -0.25 * smoothstep(p / stanceFrac, 0.7, 1.0);
    } else {
      double q = (p - stanceFrac) / (1 - stanceFrac);
      double e = q * q * (3 - 2 * q);
      along = -half + e * 2 * half;
      up = std::sin(q * PI) * lift;
      pitch = 0.3 * std::sin(q * PI) - 0.15 * (1 - q);
    }
    along *= move; up *= move; pitch *= move;
    double fr = std::max(0.0, -side * w);
    along += 0.07 * fr; pitch -= 0.06 * fr;
    double lateral = side * lerp(0.1, 0.085, run) + side * (0.015 + 0.02 * fr) * (1 - move);
    V3 fp = root + fwd * along + right * lateral;
    double gr = ground(fp.x, fp.z, root.y - st.airY + 0.4) + st.airY;
    fp.y = gr + up;
    footPos[i] = {fp, pitch, gr};
  }
  double mid = std::cos((phase - stanceFrac / 2) * PI * 4);
  double bob = move * lerp(mid * R.legLen * 0.04, -mid * 0.03, run);
  double breathe = std::sin(g.t * 1.6) * 0.004 * (1 - move);
  double sway = std::sin(phase * PI * 2) * 0.022 * move * (1 - run) + std::sin(g.t * 0.35) * 0.012 * (1 - move);
  double groundY = std::min(footPos[0].ground, footPos[1].ground);
  V3 hip = root;
  double ext = lerp(0.996 - 0.006 * std::fabs(w), lerp(0.93, 0.87, run), move);
  hip.y = groundY + R.ankleH + R.legLen * ext + R.upLegDrop + bob + breathe;
  hip = hip + right * (sway + 0.03 * w) + fwd * (run * 0.04);
  setWorldPos(b[RigModel::hips], hip);
  double pelvisYaw = std::sin(phase * PI * 2) * lerp(0.1, 0.16, run) * move;
  rotateWorld(b[RigModel::hips], UP, pelvisYaw);
  rotateWorld(b[RigModel::hips], fwd, -sway * 1.5 - 0.05 * w);
  rotateWorld(b[RigModel::hips], UP, 0.04 * w);
  rotateWorld(b[RigModel::hips], right, -lerp(0.03, 0.2, run) * move);
  fixPosture(right);
  rotateWorld(b[RigModel::spine1], UP, -pelvisYaw * 1.6 - 0.03 * w);
  rotateWorld(b[RigModel::spine2], right, std::sin(g.t * 1.6) * 0.012 * stand);
  rotateWorld(b[RigModel::spine1], fwd, sway * 1.2 + 0.035 * w);
  for (int i = 0; i < 2; i++) {
    int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    double side = i == 0 ? -1 : 1;
    V3 ankle = footPos[i].fp + UP * R.ankleH + fwd * R.footFwd;
    solveTwoBone(up, leg, foot, ankle, normalize(fwd + right * (side * 0.08)));
    Q fq = mul(axisAngle(UP, st.heading + side * 0.08), axisAngle(X_AXIS, -footPos[i].pitch));
    setWorldQuat(foot, mul(fq, R.footRest[i]));
  }
  relaxShoulders(1 + 0.25 * stand);
  V3 hc = wpos(b[RigModel::hips]);
  for (int i = 0; i < 2; i++) {
    int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    double side = i == 0 ? -1 : 1;
    double swing = std::sin((phase + (i == 0 ? 0.5 : 0)) * PI * 2) * move;
    V3 sh = wpos(arm);
    double L = R.armLen;
    double out = R.hipHalfW + 0.045 - side * 0.012 * w;
    double hx = hc.x + right.x * side * out + fwd.x * 0.03, hz = hc.z + right.z * side * out + fwd.z * 0.03;
    double dxz = std::hypot(hx - sh.x, hz - sh.z), reach = L * 0.965;
    V3 standT(hx, sh.y - std::sqrt(std::max(0.01, reach * reach - dxz * dxz)), hz);
    standT = standT + fwd * (std::sin(g.t * 0.8 + i * 1.3) * 0.006);
    V3 walkT = sh + UP * (-L * 0.93) + right * (side * 0.035) + fwd * (0.04 + swing * 0.22 * (st.carry ? 0.4 : 1));
    V3 runT = sh + UP * (-L * (0.62 - 0.08 * std::max(0.0, swing))) + right * (side * 0.07) + fwd * (0.05 + swing * 0.15);
    V3 tgt = vlerp(vlerp(walkT, runT, run), standT, stand);
    tgt = tgt + UP * (std::sin(g.t * 1.6) * 0.004);
    V3 elbow = normalize(-fwd + right * (side * lerp(0.12, 0.3, stand)) + UP * (-0.2 * (1 - stand)));
    solveTwoBone(arm, fore, hand, tgt, elbow);
    relaxHand(i, normalize(right * (-side) + fwd * (-0.3 * stand)), 0.1 + 0.06 * stand);
  }
  double look = (1 - move) * (std::sin(g.t * 0.23) * 0.35 + std::sin(g.t * 0.61) * 0.12);
  rotateWorld(b[RigModel::head], UP, look - pelvisYaw * 0.5 + st.lookYaw * 0.7);
  rotateWorld(b[RigModel::neck], fwd, -0.025 * w);
  if (run > 0) rotateWorld(b[RigModel::neck], right, run * 0.12 * move);
  skiPosOk_ = false;
}

// ------------------------------------------------------------------- seated
void SkierRig::poseSit(double dt, const RigState& st, const V3& fwd, const V3& right) {
  const RigModel& R = *M_;
  const int* b = R.b;
  if (!st.hasSeat) return;
  if (st.hasBench) { poseBench(dt, st, fwd, right); return; }
  if (st.hasSled) { poseSled(dt, st, fwd, right); return; }
  gait_.t += dt;
  const V3 seat = st.seat;
  V3 hip = seat + UP * 0.1;
  setWorldPos(b[RigModel::hips], hip);
  fixPosture(right);
  rotateWorld(b[RigModel::spine1], right, 0.06);
  for (int i = 0; i < 2; i++) {
    int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    double side = i == 0 ? -1 : 1;
    double dangle = std::sin(gait_.t * 0.9 + i * 1.7) * 0.03;
    V3 ankle = seat + fwd * (0.46 + dangle) + UP * (-0.36) + right * (side * 0.12);
    solveTwoBone(up, leg, foot, ankle, fwd);
    setWorldQuat(foot, mul(mul(axisAngle(UP, st.heading), axisAngle(X_AXIS, 0.3)), R.footRest[i]));
  }
  for (int i = 0; i < 2; i++) {
    int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    double side = i == 0 ? -1 : 1;
    if (i == 0) relaxShoulders();
    V3 tgt = hip + fwd * 0.32 + UP * 0.12 + right * (side * 0.17);
    solveTwoBone(arm, fore, hand, tgt, normalize(right * side + UP * (-1.0) + fwd * (-0.4)));
    aimHand(i, fwd + UP * (-0.25), -UP);
  }
  rotateWorld(b[RigModel::head], UP, std::sin(gait_.t * 0.2) * 0.4 + st.lookYaw * 0.7);
}

void SkierRig::poseSled(double, const RigState& st, const V3& fwd, const V3& right) {
  const RigModel& R = *M_;
  const int* b = R.b;
  const auto& S = st.sled;
  const V3 seat = st.seat;
  V3 hip = seat + UP * 0.1;
  setWorldPos(b[RigModel::hips], hip);
  fixPosture(right);
  double steer = clamp(S.steer, -1, 1);
  rotateWorld(b[RigModel::spine1], right, -0.12);
  rotateWorld(b[RigModel::spine2], right, -0.06);
  rotateWorld(b[RigModel::spine1], fwd, -steer * 0.05);
  rotateWorld(b[RigModel::neck], right, 0.1);
  for (int i = 0; i < 2; i++) {
    int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    double side = i == 0 ? -1 : 1;
    V3 ankle = seat + right * (side * S.foot.x) + UP * S.foot.y + fwd * S.foot.z;
    V3 pole = normalize(fwd + right * (side * 0.7) + UP * 0.4);
    solveTwoBone(up, leg, foot, ankle, pole);
    setWorldQuat(foot, mul(mul(axisAngle(UP, st.heading - side * 0.15), axisAngle(X_AXIS, -0.05)), R.footRest[i]));
  }
  relaxShoulders(0.5);
  double th = steer * S.turn, c = std::cos(th), s = std::sin(th);
  for (int i = 0; i < 2; i++) {
    int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    double side = i == 0 ? -1 : 1, gx = -side * S.grip.x, gz = S.grip.z - S.pivot;
    double lx = gx * c + gz * s, lz = S.pivot - gx * s + gz * c;
    V3 tgt = seat + right * (-lx) + UP * (S.grip.y + 0.04) + fwd * (lz - 0.07);
    V3 pole = normalize(right * (side * 0.8) + UP * (-0.6) + fwd * (-0.3));
    solveTwoBone(arm, fore, hand, tgt, pole);
    V3 dir = applyAxisAngle(fwd, UP, th) + UP * (-0.45);
    aimHand(i, dir, -UP + fwd * (-0.2));
  }
  rotateWorld(b[RigModel::head], UP, st.lookYaw * 0.7);
}

void SkierRig::poseBench(double dt, const RigState& st, const V3& fwd, const V3& right) {
  const RigModel& R = *M_;
  const int* b = R.b;
  const auto& B = st.bench;
  const V3 seat = st.seat;
  gait_.t += dt;
  const double Lt = R.thighLen, Ls = R.shinLen, HY = 0.09;
  const bool out = B.legsOut;
  const bool hasBack = std::isfinite(B.back);
  const double front = std::isfinite(B.front) ? B.front : 0.24, back = hasBack ? B.back : front - 0.5;
  const double recline = clamp(B.recline, 0, 1.1);
  double gy = std::isfinite(B.floorY) ? B.floorY : seat.y - 0.45;
  V3 probe = seat + fwd * (front + 0.12);
  double gh = ground(probe.x, probe.z, gy + 0.1);
  if (std::isfinite(gh) && gh > gy - 0.5 && gh < seat.y - 0.2) gy = gh;
  const double footY = gy + R.ankleH;
  auto legAngles = [&](double dy, double& th, double& ph) {
    th = std::asin(clamp((dy - Ls * std::cos(0.12)) / Lt, -0.33, 0.45));
    ph = std::acos(clamp((dy - Lt * std::sin(th)) / Ls, 0, 1));
  };
  double th0 = 0, ph0 = 0;
  if (!out) legAngles(seat.y + HY - footY, th0, ph0);
  const double rest = back + (recline > 0.5 ? 0.04 : 0.13);
  double zJ = hasBack ? rest : -1e300;
  if (!out) {
    zJ = std::max(zJ, front + 0.04 - Lt * std::cos(th0));
    if (th0 > 0.05) zJ = std::max(zJ, front - 0.06 / std::tan(th0));
  } else if (!hasBack) zJ = front - (Lt + Ls) * 0.75;
  zJ = std::min(zJ, front - 0.07);
  const double lean = hasBack && zJ <= rest + 0.04 ? std::max(0.06, recline) : 0;
  V3 hip = seat + fwd * zJ + UP * (HY + R.upLegDrop);
  setWorldPos(b[RigModel::hips], hip);
  if (lean != 0) rotateWorld(b[RigModel::hips], right, lean * 0.3);
  fixPosture(right);
  if (lean != 0) {
    rotateWorld(b[RigModel::spine0], right, lean * 0.45);
    rotateWorld(b[RigModel::spine1], right, lean * 0.25);
    rotateWorld(b[RigModel::neck], right, -lean * 0.55);
  }
  for (int i = 0; i < 2; i++) {
    int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    double side = i == 0 ? -1 : 1;
    V3 J = wpos(up), knee, ankle, pole;
    double pitch = 0;
    if (out) {
      double reach = std::min((Lt + Ls) * 0.9, std::max(Lt, glm::dot(seat - J, fwd) + front + 0.08));
      ankle = J + fwd * reach + right * (side * 0.03);
      ankle.y = std::max(seat.y + 0.14, footY);
      pole = normalize(UP + fwd * 0.3 + right * (side * 0.25));
      pitch = -0.85;
    } else {
      double th, ph;
      legAngles(J.y - footY, th, ph);
      knee = J + fwd * (Lt * std::cos(th)) + UP * (-Lt * std::sin(th)) + right * (side * 0.025);
      ankle = knee + fwd * (Ls * std::sin(ph)) + UP * (-Ls * std::cos(ph)) + right * (side * 0.01);
      pole = normalize(knee - (J + ankle) * 0.5);
      pitch = clamp((ankle.y - footY) * 4, 0, 0.45);
    }
    solveTwoBone(up, leg, foot, ankle, pole);
    setWorldQuat(foot, mul(mul(axisAngle(UP, st.heading + side * 0.07), axisAngle(X_AXIS, pitch)), R.footRest[i]));
  }
  relaxShoulders();
  for (int i = 0; i < 2; i++) {
    int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg];
    double side = i == 0 ? -1 : 1;
    V3 J = wpos(up), K = wpos(leg);
    V3 along = normalize(K - J);
    V3 tgt = vlerp(J, K, recline > 0.5 ? 0.25 : 0.42) + UP * 0.1 + right * (-side * 0.015);
    solveTwoBone(arm, fore, hand, tgt, normalize(right * side + UP * (-1.0) + fwd * (-0.4)));
    aimHand(i, along + UP * (-0.2), -UP);
  }
  rotateWorld(b[RigModel::head], UP, std::sin(gait_.t * 0.2) * 0.35 + st.lookYaw * 0.7);
}

// ------------------------------------------------------------------- skiing
void SkierRig::poseSki(double dt, const RigState& st, const V3& fwd, const V3& right) {
  const RigModel& R = *M_;
  const int* b = R.b;
  auto& K = sk_;
  const V3 root = rootPos;
  const double h = clamp(dt, 0, 0.1);
  K.t += h;
  bool air = st.air;
  if (air && st.flip == 0 && st.grab == 0 && std::fabs(root.y - ground(root.x, root.z, root.y + 0.3)) < 0.06) air = false;
  const double spd = st.speed;
  K.spd = spd;
  const bool tuckIn = !air && st.tuck;
  const double inclT = clamp(st.hasEdge ? st.edge : st.lean * 0.6, -1, 1);
  if (!K.init || K.frame != frame_ - 1 || std::fabs(root.y - K.y) > 1.5) {
    K.init = true; K.y = root.y; K.vy = 0; K.o = 0; K.ov = 0; K.cr = st.crouch; K.tk = tuckIn ? 1 : 0; K.armInit = false;
    K.plow = st.plow; K.skid = st.skid; K.inc = inclT; K.incV = 0; K.trans = 0; K.twist = 0;
    K.wasAir = air; K.popT = 9; K.airT = air ? 1 : 0; K.prep = 0; K.chg = 0;
  }
  const double vyPrev = K.vy;
  if (h > 1e-4) K.vy += (clamp((root.y - K.y) / h, -40, 40) - K.vy) * (1 - std::exp(-h * 22));
  K.y = root.y;
  K.frame = frame_;
  // ---- jump phases
  const double charge = air ? 0 : st.charge;
  if (!air && K.chg > 0.12 && charge < 0.02) { K.popT = 0; K.popS = clamp(0.45 + K.chg * 0.6, 0, 1); }
  K.chg = charge;
  if (air && !K.wasAir) { K.airT = 0; K.prep = 0; if (K.popT > 0.3) { K.popT = 0; K.popS = 0.3; } }
  K.wasAir = air;
  K.popT += h;
  if (air) K.airT += h;
  const double popEnv = K.popT < 0.24 ? K.popS * std::sin((K.popT / 0.24) * PI) : 0;
  // ---- smoothed inputs
  K.cr += (st.crouch - K.cr) * ek(h, 14);
  K.tk += ((tuckIn ? 1 : 0) - K.tk) * ek(h, 6);
  K.plow += (st.plow - K.plow) * ek(h, 8);
  K.skid += (st.skid - K.skid) * ek(h, 14);
  if (!air) K.ov -= (K.vy - vyPrev) * 0.5;
  const int nSub = std::max(1, int(std::ceil(h * 120)));
  const double hs = h / nSub;
  for (int k = 0; k < nSub; k++) {
    K.incV += ((inclT - K.inc) * 256 - 32 * K.incV) * hs;
    K.inc += K.incV * hs;
    K.ov += (-90 * K.o - 15 * K.ov) * hs;
    K.o += K.ov * hs;
  }
  if (K.o < -0.2) { K.o = -0.2; if (K.ov < 0) K.ov = 0; } else if (K.o > 0.05) { K.o = 0.05; if (K.ov > 0) K.ov = 0; }
  K.trans += (clamp(std::fabs(K.incV) / 2.2, 0, 1) - K.trans) * ek(h, 8);

  airW_ = air ? std::min(1.0, airW_ + dt * 7) : std::max(0.0, airW_ - dt * 14);
  const double aw = airW_ * airW_ * (3 - 2 * airW_), gw = 1 - aw;
  const double grab = smoothT(st.grab, 0, 1);
  const GrabPose* gp = grab > 0.001 ? &GRAB_POSES[int(st.grabType)] : nullptr;
  const double tk = K.tk * gw;
  const double crouch = clamp(K.cr, -0.2, 1.2);
  const double cr01 = clamp(crouch, 0, 1);
  const double incl = 0.82 * std::tanh(clamp(K.inc, -1.2, 1.2) / 0.82) * gw;
  const double edgeIn = clamp(K.inc, -1.05, 1.05) * gw;
  const double lean = clamp(incl / 0.8, -1, 1), al = std::fabs(lean);
  const double skid = K.skid * gw, askid = std::min(1.0, std::fabs(skid));
  const double plow = K.plow * gw;
  const V3 n = st.hasNormal ? st.normal : UP;
  const double spin = clamp(st.spinVel / 7, -1, 1) * aw;
  const double relax = (1 - smoothT(spd, 1.5, 8)) * (1 - 0.6 * plow) * gw;
  double tl = 9;
  if (air) {
    double hgt = std::max(0.0, root.y - ground(root.x, root.z, root.y));
    tl = (K.vy + std::sqrt(K.vy * K.vy + 19.62 * hgt)) / 9.81;
  }
  K.prep += ((air && K.airT > 0.2 ? 1 - smoothT(tl, 0.12, 0.42) : 0) - K.prep) * ek(h, air ? 12 : 20);
  const double prep = K.prep * aw;
  const double tuckA = (air ? smoothT(K.airT, 0.06, 0.3) : 0) * (1 - prep);
  const double rough = std::min(1.0, std::fabs(K.ov) * 1.5);
  const Style* Y = hasStyle ? &style : nullptr;
  const double bal = (std::sin(K.t * 1.7) * 0.6 + std::sin(K.t * 2.9 + 1.3) * 0.4) * (0.01 + 0.025 * rough) * gw * (Y ? Y->sway : 1);
  V3 sf = fwd;
  if (skid != 0) sf = applyAxisAngle(sf, UP, skid);
  const V3 sr = normalize(glm::cross(sf, UP));
  // ---- skis
  const double edge = clamp(edgeIn * 1.15, -1.15, 1.15);
  for (int i = 0; i < 2; i++) {
    double s = i == 0 ? -1 : 1;
    V3 f = applyAxisAngle(sf, UP, s * 0.3 * plow);
    Q q = skiQuat(f, n, edge - s * 0.25 * plow);
    if (aw > 0) {
      Q qa = mul(skiQuat(fwd, UP, 0), axisAngle(X_AXIS, -(0.1 * (1 - prep) + (gp ? gp->pitch * grab : 0))));
      q = three::slerp(q, qa, aw);
    }
    skiQ_[i] = q;
  }
  const double stance = 0.115 + plow * 0.13 + askid * 0.05 + 0.03 * al + 0.02 * smoothT(spd, 8, 20) * (1 - plow) - 0.015 * tk + (Y ? Y->stance : 0);
  const double liftBase = 0.05 + 0.2 * tuckA + 0.06 * cr01 * (1 - prep);
  const double lift = liftBase + (gp ? std::max(0.0, gp->lift + 0.11 - liftBase) * grab : 0);
  skiPosOk_ = true;
  V3* skiPos = skiPos_;
  const double tanS = std::min(1.5, std::hypot(n.x, n.z) / std::max(0.2, n.y));
  const double drop = std::min(0.3, (stance + 0.1) * tanS + 0.05);
  for (int i = 0; i < 2; i++) {
    double s = i == 0 ? -1 : 1;
    V3 p = root + sr * (s * stance);
    p = p + sf * ((s == sgn(incl) ? 0.12 : -0.04) * al);
    double y = root.y + lift;
    if (gw > 0) {
      double g = ground(p.x, p.z, root.y + 0.3);
      y = lerp(clamp(g, root.y - drop, root.y + 0.35) + 0.035 * std::fabs(std::sin(edge)), y, aw);
    }
    p.y = y;
    if (gp) p = p + fwd * (gp->feetF * grab * aw);
    skiPos[i] = p;
  }
  // ---- hips
  const double nf = clamp(n.x * sf.x + n.z * sf.z, -0.6, 0.6);
  double hf = 1.01 - 0.2 * cr01 - 0.08 * std::max(0.0, crouch - 1) + 0.025 * relax + 0.06 * al + 0.03 * K.trans * (1 - al) + 0.05 * popEnv;
  hf = lerp(hf, 0.91, tk);
  const double hipH = R.hipRest.y * hf;
  V3 hip = root;
  const double airY = root.y + R.hipRest.y * (0.9 - 0.1 * tuckA + 0.04 * popEnv) - grab * 0.04;
  if (gw > 0) {
    double lowY = std::min(skiPos[0].y, skiPos[1].y), highY = std::max(skiPos[0].y, skiPos[1].y);
    hip.y = lowY + (highY - lowY) * 0.5;
    hip = hip + UP * (hipH * std::cos(incl)) + sr * (hipH * std::sin(incl) * 0.85);
    double back = -0.02 + 0.03 * cr01 + 0.02 * tk + 0.03 * plow + 0.03 * askid - 0.02 * relax;
    hip = hip + sf * (-back + hipH * nf * 0.72);
    hip.y += K.o;
    hip.y = lerp(hip.y, airY, aw);
  } else hip.y = airY;
  for (int i = 0; i < 2; i++) {
    double s = i == 0 ? -1 : 1;
    V3 up = applyQ(V3(0, 1, 0), skiQ_[i]);
    V3 ankle = skiPos[i] + up * (R.ankleH + 0.05);
    V3 joint = hip + UP * (-R.hipDrop) + sr * (s * R.hipHalfW);
    double d = glm::distance(joint, ankle);
    if (d > R.legLen * 0.97) hip.y -= d - R.legLen * 0.97;
  }
  setWorldPos(b[RigModel::hips], hip);
  // ---- torso
  const double flex = 0.3 + 0.22 * cr01 + 0.08 * tk + (gp ? gp->flex * grab : 0) + 0.06 * aw + 0.12 * tuckA + 0.08 * prep + charge * 0.22
    - 0.1 * relax - 0.1 * al - K.o * 1.4 + std::asin(nf) * 0.5 * gw - 0.12 * popEnv + 0.06 * askid;
  double twT = incl * 0.18;
  const double sl = std::hypot(n.x, n.z);
  if (sl > 0.03) {
    double rel = std::atan2(n.x, n.z) - st.heading;
    rel -= std::round(rel / (PI * 2)) * PI * 2;
    twT += clamp(rel, -1.4, 1.4) * 0.3 * smoothT(sl, 0.04, 0.22) * (1 - smoothT(std::fabs(rel), 1.6, 2.4));
  }
  twT *= gw * (1 - 0.6 * tk) * (1 - askid);
  K.twist += (twT - K.twist) * ek(h, 5);
  if (skid != 0) rotateWorld(b[RigModel::hips], UP, skid * 0.8);
  if (K.twist != 0) rotateWorld(b[RigModel::hips], UP, K.twist * 0.25);
  rotateWorld(b[RigModel::hips], sr, -flex);
  fixPosture(sr);
  rotateWorld(b[RigModel::hips], sf, incl * 0.8);
  rotateWorld(b[RigModel::spine1], sf, -incl * 0.42 + bal);
  rotateWorld(b[RigModel::spine2], sf, -incl * 0.1);
  rotateWorld(b[RigModel::spine1], UP, K.twist * 0.45 - skid * 0.65 + spin * 0.25 + (gp ? gp->twist * grab : 0));
  if (K.twist != 0) rotateWorld(b[RigModel::spine2], UP, K.twist * 0.3);
  rotateWorld(b[RigModel::spine1], right, -flex * 0.1 - 0.025 * tk + bal * 0.5);
  // ---- legs
  for (int i = 0; i < 2; i++) {
    int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    double s = i == 0 ? -1 : 1;
    const Q& q = skiQ_[i];
    V3 skiUp = applyQ(V3(0, 1, 0), q), skiF = applyQ(V3(0, 0, 1), q);
    V3 ankle = skiPos[i] + skiUp * (R.ankleH + 0.05) + skiF * (R.footFwd - 0.03);
    V3 pole = normalize(sf + sr * (s * (0.12 + grab * 0.45 + 0.1 * aw * (1 - prep)) + lean * 0.75 - s * plow * 0.6) + UP * (grab * 0.25 + 0.2 * tuckA * aw));
    solveTwoBone(up, leg, foot, ankle, pole);
    setWorldQuat(foot, mul(q, R.footRest[i]));
  }
  relaxShoulders(0.7);
  // ---- grab
  V3 grabOn(0);
  if (gp) {
    int k = gp->ski;
    double ss = k == 0 ? -1 : 1;
    const Q& q = skiQ_[k];
    grabOn = skiPos[k] + applyQ(V3(0, 0, 1), q) * (gp->along + R.footFwd) + applyQ(V3(1, 0, 0), q) * (-ss * gp->out * 0.055) + applyQ(V3(0, 1, 0), q) * 0.07;
    int arm = gp->hand == 0 ? b[RigModel::lArm] : b[RigModel::rArm];
    for (int it = 0; it < 3; it++) {
      V3 sh = wpos(arm), sp = wpos(b[RigModel::spine1]);
      double shrt = glm::distance(sh, grabOn) - R.armLen * 0.95;
      if (shrt <= 0.005) break;
      V3 a = sh - sp, t = grabOn - sp;
      V3 axis = glm::cross(a, t);
      if (lengthSq(axis) < 1e-8) break;
      rotateWorld(b[RigModel::spine1], normalize(axis), std::min(0.35, shrt / glm::length(a)) * grab);
    }
  }
  // chest frame
  V3 tr = wpos(b[RigModel::rArm]) - wpos(b[RigModel::lArm]);
  tr.y = 0;
  if (lengthSq(tr) < 1e-6) tr = right; else tr = normalize(tr);
  torsoR_ = tr;
  const V3 tf = glm::cross(UP, tr);
  torsoF_ = tf;
  // ---- arms
  const double armBob = clamp(-K.ov * 0.035, -0.05, 0.05) * gw;
  for (int i = 0; i < 2; i++) {
    int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    double s = i == 0 ? -1 : 1;
    Plant& pl = plant_[i];
    double t0 = pl.t;
    pl.t = std::min(1.0, pl.t + dt / (0.55 * (Y ? Y->plantDur : 1)));
    if (t0 < 0.25 && pl.t >= 0.25 && !pl.rel && !air) pushFx(FxPole, pl.tip, clamp(spd / 14, 0.25, 1));
    double plantEnv = pl.t < 1 ? std::sin(std::min(1.0, pl.t / 0.25) * PI * 0.5) * (1 - smoothT(pl.t, 0.4, 1)) : 0;
    V3 sh = wpos(arm);
    bool grabbing = gp && i == gp->hand && !fp_;
    V3 tgt = sh;
    {
      double inside = s == sgn(incl) ? al : 0, outside = s == -sgn(incl) ? al : 0;
      double L = R.armLen;
      bool poled = hasPoles_ && !fp_;
      double fpw = fp_ ? 1 : 0;
      double F = L * ((poled ? 0.5 : 0.42) + 0.06 * smoothT(spd, 4, 14) - 0.08 * relax) + plantEnv * (poled ? 0.16 * (Y ? Y->plantReach : 1) : 0) + inside * 0.08 - outside * 0.05
        - charge * 0.3 + 0.22 * popEnv + std::sin(K.t * 0.9 + i * 2.6) * 0.025 * gw;
      double U = -L * ((poled ? 0.56 : 0.6) + 0.08 * fpw + 0.06 * relax) + plantEnv * (poled ? 0.06 * (Y ? Y->plantReach : 1) : 0) + inside * 0.07 - outside * 0.02 - charge * 0.04 + 0.3 * popEnv + armBob
        + std::sin(K.t * 1.3 + i * 2.1) * 0.022 * gw;
      double O = (poled ? 0.19 : 0.16) + 0.1 * fpw + plow * 0.1 + askid * 0.12 + charge * 0.1 + 0.03 * relax + outside * 0.12 - inside * 0.03;
      if (Y) { F += Y->armF; U += Y->armU; O += Y->armO; }
      ArmS& A = armS_[i];
      if (!K.armInit) { A.F = F; A.U = U; A.O = O; A.vF = A.vU = A.vO = 0; }
      double hh = std::min(dt, 0.05);
      A.vF += ((F - A.F) * 110 - A.vF * 17) * hh; A.F += A.vF * hh;
      A.vU += ((U - A.U) * 110 - A.vU * 17) * hh; A.U += A.vU * hh;
      A.vO += ((O - A.O) * 110 - A.vO * 17) * hh; A.O += A.vO * hh;
      F = A.F; U = A.U; O = A.O;
      F += 0.03 * tk; U += 0.02 * tk; O -= 0.02 * tk;
      tgt = tgt + tf * F + UP * U + tr * (s * O);
      if (aw > 0) {
        double sw = std::fabs(spin), fr = gp && !grabbing ? grab : 0;
        double wob = std::sin(K.t * 4.2 + i * 1.7) * 0.05 * (1 - prep) * (1 - sw);
        V3 ta = sh + tf * (0.14 - sw * 0.08 - fr * 0.24 + 0.24 * prep + 0.22 * popEnv) + UP * (-0.12 + sw * 0.1 + fr * 0.14 - 0.16 * prep + wob + 0.25 * popEnv)
          + tr * (s * (0.42 + sw * 0.12 + fr * 0.16 - 0.22 * prep));
        tgt = vlerp(tgt, ta, aw);
      }
    }
    if (grabbing) tgt = vlerp(tgt, grabOn, grab);
    V3 elbow = normalize(tr * (s * (0.55 - 0.1 * tk)) + UP * (-0.75) + tf * (-0.4 + 0.15 * tk));
    solveTwoBone(arm, fore, hand, tgt, elbow);
    if (grabbing && grab > 0.5) {
      int k = gp->ski;
      double ss = k == 0 ? -1 : 1;
      const Q& q = skiQ_[k];
      V3 skiL = applyQ(V3(1, 0, 0), q), skiUp = applyQ(V3(0, 1, 0), q);
      aimHand(i, -skiUp + fwd * 0.25, skiL * (ss * gp->out));
    } else if (hasPoles_ && !fp_) {
      aimHand(i, tf + tr * (-s * 0.35) + UP * (-0.15), tr * (-s));
    } else if (fp_) {
      aimHand(i, tf * 0.25 + UP * (-1.0) + tr * (s * 0.08), tr * (-s));
    } else {
      aimHand(i, tf + UP * (-0.45) + tr * (s * 0.12), UP * (-1.0) + tr * (-s * 0.5));
    }
  }
  K.armInit = true;
  rotateWorld(b[RigModel::neck], right, flex * 0.7 + grab * 0.3);
  if (tk > 0.01) { rotateWorld(b[RigModel::neck], right, 0.2 * tk); rotateWorld(b[RigModel::head], right, 0.3 * tk); }
  if (spin != 0) rotateWorld(b[RigModel::head], UP, spin * 0.45);
  if (st.lookYaw != 0) rotateWorld(b[RigModel::head], UP, clamp(st.lookYaw, -1.2, 1.2) * 0.7);
  if (st.lookPitch != 0) rotateWorld(b[RigModel::head], right, -st.lookPitch * 0.5);
}

// ------------------------------------------------------------------- crashes
void SkierRig::poseFall(double, const RigState& st, const V3& fwd, const V3& right) {
  const RigModel& R = *M_;
  const int* b = R.b;
  const V3 root = rootPos;
  const int side = st.fallSide != 0 ? st.fallSide : 1;
  const double ball = st.hasFall ? clamp(st.fall.ball, 0, 1) : 0;
  const double g = st.hasFall ? clamp(st.fall.getUp, 0, 1) : 0;
  FallPose P = mixPose(FP_LIE, FP_BALL, ball);
  if (g > 0) {
    FallPose p2 = mixPose(P, FP_CROUCH, smoothT(g, 0, 0.62));
    FallPose stand = FP_STAND;
    stand.hipH = R.hipRest.y * 0.81;
    P = mixPose(p2, stand, smoothT(g, 0.55, 1));
  }
  V3 hip = root + UP * P.hipH + fwd * P.hipF;
  setWorldPos(b[RigModel::hips], hip);
  rotateWorld(b[RigModel::hips], right, -P.flex);
  fixPosture(right);
  rotateWorld(b[RigModel::spine1], right, -P.curl * 0.6);
  rotateWorld(b[RigModel::spine2], right, -P.curl * 0.4);
  const V3 n = st.hasNormal ? st.normal : UP;
  const Q footQ = mul(skiQuat(fwd, n, 0), axisAngle(X_AXIS, ball * 0.35));
  const double fl = clamp(st.flail, 0, 1), ft = time_;
  for (int i = 0; i < 2; i++) {
    int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    double s = i == 0 ? -1 : 1;
    V3 ankle = root + fwd * (P.footF + R.footFwd) + right * (s * P.footW);
    ankle.y = ground(ankle.x, ankle.z, root.y + 0.5);
    ankle = ankle + n * (P.footH + R.ankleH + 0.03);
    if (fl > 0.01) ankle = ankle + fwd * (std::sin(ft * 9.5 + i * 2.6) * 0.2 * fl) + UP * ((0.12 + std::sin(ft * 7.3 + i * 1.9) * 0.12) * fl) + right * (s * 0.1 * fl);
    V3 pole = normalize(fwd + right * (s * P.knee) + UP * (ball * 0.3));
    solveTwoBone(up, leg, foot, ankle, pole);
    setWorldQuat(foot, mul(footQ, R.footRest[i]));
  }
  relaxShoulders();
  for (int i = 0; i < 2; i++) {
    int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    double s = i == 0 ? -1 : 1;
    const double* a = s == side ? P.g : P.t;
    V3 sh = wpos(arm);
    V3 tgt = sh + fwd * a[0] + UP * a[1] + right * (s * a[2]);
    if (fl > 0.01) {
      double ph = ft * (10.5 + i * 2.3) + i * 2.1;
      tgt = vlerp(tgt, sh, 0.35 * fl) + UP * ((0.35 + std::sin(ph) * 0.3) * fl) + fwd * (std::cos(ph * 0.8) * 0.3 * fl) + right * (s * (0.3 + 0.15 * std::sin(ph * 1.3)) * fl);
    }
    V3 elbow = normalize(right * s + UP * (-0.6) + fwd * (-0.4));
    solveTwoBone(arm, fore, hand, tgt, elbow);
    relaxHand(i, normalize(-UP + right * (-s * 0.5)), 0.1);
  }
  rotateWorld(b[RigModel::neck], right, P.neck + (fl > 0.01 ? (std::sin(ft * 8.2) * 0.3 - 0.15) * fl : 0));
  if (fl > 0.01) rotateWorld(b[RigModel::head], fwd, std::sin(ft * 6.1 + 1) * 0.3 * fl);
  skiPosOk_ = false;
}

// "Lay the posed body onto the snow: tumble/roll rotation about the center of mass, then the lowest point (head, limbs,
// ski tips...) rests on the surface."
void SkierRig::placeFallen(double dt, const RigState& st) {
  const RigModel& R = *M_;
  const int* b = R.b;
  const V3 root = rootPos;
  const double pitch = st.hasFall ? st.fall.pitch : 0;
  const double roll = st.hasFall ? st.fall.roll : (st.fallSide != 0 ? st.fallSide : 1) * PI / 2 * smoothT(st.fallT, 0, 1);
  const double hd = st.hasFallHeading ? st.fallHeading : st.heading;
  V3 fwdT(std::sin(hd), 0, std::cos(hd)), rightT(-std::cos(hd), 0, std::sin(hd));
  Q qa = axisAngle(rightT, -pitch), qb = axisAngle(fwdT, roll);
  Q qc = mul(qb, qa);
  V3 C = wpos(b[RigModel::hips]) + UP * 0.05;
  rotateBody(qc, C, false);
  const double yHint = root.y + 0.6;
  double minC = 1e300;
  int low = -1;
  static const std::pair<int, double> PROBE[] = {{RigModel::head, 0.13}, {RigModel::neck, 0.1}, {RigModel::spine2, 0.16}, {RigModel::spine0, 0.15}, {RigModel::hips, 0.14},
    {RigModel::lUp, 0.1}, {RigModel::rUp, 0.1}, {RigModel::lLeg, 0.07}, {RigModel::rLeg, 0.07}, {RigModel::lFoot, 0.07}, {RigModel::rFoot, 0.07},
    {RigModel::lFore, 0.06}, {RigModel::rFore, 0.06}, {RigModel::lHand, 0.05}, {RigModel::rHand, 0.05}};
  for (auto& [k, r] : PROBE) {
    V3 p = wpos(b[k]);
    double c = p.y - r - ground(p.x, p.z, yHint);
    if (c < minC) { minC = c; low = b[k]; }
  }
  {
    V3 hp = wpos(b[RigModel::head]);
    V3 dir = normalize(hp - wpos(b[RigModel::neck]));
    V3 p = hp + dir * 0.17;
    double c = p.y - 0.08 - ground(p.x, p.z, yHint);
    if (c < minC) { minC = c; low = b[RigModel::head]; }
  }
  for (int i = 0; i < 2; i++) {
    if (!hasSkis_ || !skis[i].visible) continue;
    int foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    Q q = mul(wquat(foot), R.footRestInv[i]);
    V3 up = applyQ(V3(0, 1, 0), q), f = applyQ(V3(0, 0, 1), q);
    V3 rp = wpos(foot) + up * (-R.ankleH - 0.03);
    for (double e : {-SKI_LENGTH / 2, SKI_LENGTH / 2}) {
      V3 p = rp + f * e;
      double c = p.y - 0.02 - ground(p.x, p.z, yHint);
      if (c < minC) { minC = c; low = -1; }
    }
  }
  const double D = -minC - 0.02;
  if (st.fallAir) { fallLift_ = std::max(0.0, D); fallLiftV_ = 0; }
  else if (D >= fallLift_) {
    if (fallLiftV_ < -2 && low >= 0) { V3 p = wpos(low); pushFx(FxImpact, V3(p.x, p.y + D, p.z), clamp(-fallLiftV_ / 6, 0.2, 1)); }
    fallLift_ += (D - fallLift_) * (1 - std::exp(-dt * 30));
    fallLiftV_ = 0;
  } else {
    fallLiftV_ -= 9.81 * dt;
    fallLift_ = std::max(D, fallLift_ + fallLiftV_ * dt);
  }
  V3 hp = wpos(b[RigModel::hips]);
  hp.y += fallLift_;
  setWorldPos(b[RigModel::hips], hp);
}

void SkierRig::flipBody(const RigState& st) {
  const double h = st.hasFlipHeading ? st.flipHeading : st.heading;
  Q q = axisAngle(V3(-std::cos(h), 0, std::sin(h)), -st.flip);
  V3 C = wpos(M_->b[RigModel::hips]) + UP * 0.08;
  rotateBody(q, C, true);
}

void SkierRig::rotateBody(const Q& q, const V3& C, bool gear) {
  int hips = M_->b[RigModel::hips];
  V3 hp = applyQ(wpos(hips) - C, q) + C;
  Q hq = mul(q, wquat(hips));
  setWorldPos(hips, hp);
  setWorldQuat(hips, hq);
  if (gear) {
    for (auto* o : {&skis[0], &skis[1], &poles[0], &poles[1]}) {
      bool present = (o == &skis[0] || o == &skis[1]) ? hasSkis_ : hasPoles_;
      if (!present) continue;
      o->p = applyQ(o->p - C, q) + C;
      o->q = mul(q, o->q);
    }
  }
}

Q SkierRig::skiQuat(const V3& fwd, const V3& nn, double edge) const {
  V3 up = normalize(nn);
  V3 f = normalize(V3(fwd.x, -(up.x * fwd.x + up.z * fwd.z) / std::max(0.05, up.y), fwd.z));
  V3 r = normalize(glm::cross(up, f));
  Q q = basisQuat(r, up, f);
  if (edge != 0) q = mul(axisAngle(f, edge), q);
  return q;
}

// "Skis in an A-frame on the back (tips together above the head, tails apart), bases resting on the jacket"
void SkierRig::placeOnBack(const V3& fwd) {
  const RigModel& R = *M_;
  const int* b = R.b;
  V3 chest = wpos(b[RigModel::spine2]), lowP = wpos(b[RigModel::spine0]), hp = wpos(b[RigModel::hips]);
  V3 up = normalize(wpos(b[RigModel::neck]) - lowP);
  V3 back = normalize(-fwd + up * glm::dot(fwd, up));
  V3 side = normalize(glm::cross(up, back));
  double moveW = mode_ == Mode::Move ? 1 - (M_->clips[0].ok ? clipW_[0] : 0) : gait_.move;
  double runW = mode_ == Mode::Move ? (M_->clips[2].ok ? clipW_[2] : 0) : gait_.run;
  V3 top = chest + back * (R.backDepth * 0.82 + 0.035 + 0.012 * moveW);
  V3 bot = hp + back * (R.seatDepth * 0.82 + 0.04 + 0.012 * moveW);
  V3 axis = normalize(top - bot);
  if (glm::dot(axis, up) < 0.8) axis = up;
  V3 tipEnd = top + axis * 0.94;
  if (runW > 0.01) axis = applyAxisAngle(axis, side, -0.04 * runW);
  V3 face = normalize(glm::cross(side, axis));
  for (int i = 0; i < 2; i++) {
    double s = i == 0 ? 1 : -1;
    V3 tip = applyAxisAngle(axis, face, -s * 0.04);
    V3 x = -normalize(glm::cross(face, tip));
    skis[i].q = basisQuat(x, -face, tip);
    skis[i].p = tipEnd + axis * (-SKI_LENGTH / 2) + side * (s * 0.05);
  }
  if (hasPoles_)
    for (int i = 0; i < 2; i++) {
      double s = i == 0 ? 1 : -1;
      poles[i].p = tipEnd + face * 0.03 + side * (s * 0.025) + axis * (-0.58);
      poles[i].q = fromUnitVectors(V3(0, -1, 0), applyAxisAngle(-axis, face, s * 0.05));
    }
}

bool SkierRig::poleUnder(const V3& grip, const V3& dir) const {
  V3 tip = grip + dir * (POLE_LEN - 0.08);
  return tip.y < ground(tip.x, tip.z, tip.y + 0.6) + 0.05;
}

void SkierRig::updateGear(double dt, const RigState& st, const V3& fwd, const V3& right) {
  if (!hasSkis_) return;   // ("if (!this.skis.length) return": a rig without skis has no poles either)
  if (carry_ && (st.mode != RigMode::Sit || st.hasSled)) { placeOnBack(fwd); poleDirOk_ = false; return; }
  const RigModel& R = *M_;
  const int* b = R.b;
  const V3 n = st.hasNormal ? st.normal : UP;
  for (int i = 0; i < 2; i++) {
    int foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    V3 ankle = wpos(foot);
    Q q;
    if (st.mode == RigMode::Sit) {
      q = mul(skiQuat(fwd, UP, 0), axisAngle(X_AXIS, -0.35));
      skis[i].p = ankle + UP * (-R.ankleH - 0.03);
    } else if (st.mode == RigMode::Fall) {
      q = mul(wquat(foot), R.footRestInv[i]);
      skis[i].p = ankle + applyQ(V3(0, 1, 0), q) * (-R.ankleH - 0.03);
    } else if (mode_ == Mode::Ski) {
      q = skiQ_[i];
      V3 up = applyQ(V3(0, 1, 0), q), f = applyQ(V3(0, 0, 1), q);
      skis[i].p = ankle + up * (-R.ankleH - 0.04) + f * 0.03;
    } else {
      double plowYaw = st.plow * 0.3 * (i == 0 ? -1 : 1);
      V3 f = applyAxisAngle(fwd, UP, plowYaw);
      q = skiQuat(f, n, st.lean * 0.45);
      skis[i].p = ankle + n * (-R.ankleH - 0.04) + f * 0.03;
    }
    skis[i].q = q;
  }
  if (!hasPoles_) return;
  const auto& K = sk_;
  const V3 tf = torsoF_, tr = torsoR_;
  const bool skiing = st.mode == RigMode::Ski && !fp_ && mode_ == Mode::Ski;
  for (int i = 0; i < 2; i++) {
    int hand = b[i == 0 ? RigModel::lHand : RigModel::rHand], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore];
    V3 hp = wpos(hand);
    V3 hd = normalize(hp - wpos(fore));
    V3 grip = hp + hd * 0.075;
    const RigModel::Hand& hg = R.hand[i];
    if (hg.ok) {
      Q hq = wquat(hand);
      grip = hp + applyQ(hg.dir, hq) * 0.07 + applyQ(hg.normal, hq) * 0.035;
    }
    double s = i == 0 ? -1 : 1;
    V3 dir;
    Plant& pl = plant_[i];
    if (st.mode == RigMode::Sit) {
      dir = normalize(DOWN + fwd * 0.2);
    } else if (st.mode == RigMode::Fall) {
      dir = normalize(hd + fwd * (-0.4) + right * (s * 0.2));
      V3 tip = grip + dir * (POLE_LEN - 0.08);
      double gy = ground(tip.x, tip.z, rootPos.y + 0.6) + 0.03;
      if (tip.y < gy) { tip.y = gy; dir = normalize(tip - grip); }
    } else if (st.mode == RigMode::Ski && fp_) {
      // (first person: the view model's hands hold their own poles; the rig's are hidden)
      dir = normalize(fwd * (-0.45) + UP * (-0.75) + right * (s * 0.5));
    } else if (skiing) {
      dir = normalize(tf * (-0.72) + UP * (-0.68) + tr * (s * (0.22 + std::min(1.0, std::fabs(K.skid)) * 0.2 + K.plow * 0.12)));
      if (K.tk > 0.001) dir = normalize(vlerp(dir, normalize(-tf + UP * (-0.45) + tr * (s * 0.16)), K.tk * 0.25));
      bool snap = false;
      if (pl.t < 0.55 && !pl.rel && airW_ < 0.5) {
        V3 td = pl.tip - grip;
        if (pl.t > 0.25 && glm::dot(td, fwd) < -0.3) pl.rel = true;
        else {
          double r = smoothT(pl.t, 0, 0.25);
          dir = normalize(vlerp(dir, normalize(td), r));
          snap = r > 0.999;
        }
      }
      if (airW_ > 0) {
        V3 da = normalize(tf * (-0.72) + UP * (-0.55) + tr * (s * 0.3));
        if (st.grabType != GrabType::None && GRAB_POSES[int(st.grabType)].hand == i && st.grab > 0.01) {
          const GrabPose& gp = GRAB_POSES[int(st.grabType)];
          const Q& q = skiQ_[gp.ski];
          double ss = gp.ski == 0 ? -1 : 1;
          V3 along = normalize(applyQ(V3(0, 0, 1), q) * (-0.85) + applyQ(V3(1, 0, 0), q) * (-ss * 0.3) + applyQ(V3(0, 1, 0), q) * (-0.2));
          da = normalize(vlerp(da, along, clamp(st.grab, 0, 1)));
        }
        double w = airW_ * airW_ * (3 - 2 * airW_);
        dir = normalize(vlerp(dir, da, w));
      }
      V3& pd = poleDir_[i];
      if (!poleDirOk_ || snap) pd = dir;
      else pd = normalize(vlerp(pd, dir, 1 - std::exp(-dt * 16)));
      dir = pd;
      if (!snap && airW_ < 0.5 && poleUnder(grip, dir)) {
        V3 back = normalize(tf * (-0.96) + UP * 0.06 + tr * (s * 0.25));
        V3 from = dir;
        if (poleUnder(grip, back)) dir = back;
        else {
          double lo = 0, hi = 1;
          for (int it = 0; it < 4; it++) {
            double mid = (lo + hi) / 2;
            dir = normalize(vlerp(from, back, mid));
            if (poleUnder(grip, dir)) lo = mid; else hi = mid;
          }
          dir = normalize(vlerp(from, back, hi));
        }
      }
    } else if (st.tuck) {
      dir = normalize(-fwd + UP * (-0.18) + right * (s * 0.08));
    } else {
      dir = normalize(fwd * (-0.62) + UP * (-0.72) + right * (s * 0.16));
    }
    poles[i].p = grip;
    if (st.mode == RigMode::Ski && fp_) {
      V3 y = -dir, x = right * (-s);
      x = normalize(x + y * (-glm::dot(x, y)));
      poles[i].q = basisQuat(x, y, glm::cross(x, y));
    } else poles[i].q = fromUnitVectors(V3(0, -1, 0), dir);
  }
  poleDirOk_ = skiing;
}

// ------------------------------------------------------------------- drawing
void SkierRig::writePose(Pose& out) const {
  const Model& md = *M_->body;
  size_t n = md.nodes.size();
  out.t.resize(n); out.r.resize(n); out.s.resize(n);
  for (size_t i = 0; i < n; i++) {
    out.t[i] = vec3(t_[i]); out.s[i] = vec3(s_[i]);
    out.r[i] = quat(float(r_[i].w), float(r_[i].x), float(r_[i].y), float(r_[i].z));
  }
  md.finishPose(out);
}

} // namespace sl
