// Sitting in a car (see car_seat.h): carpeople.js and seatpose.js, operation for operation, on the skier rig.
#include "player/car_seat.h"
#include "player/skier_rig.h"
#include <cstring>

namespace sl {
using namespace three;

namespace {
// carpeople.js SEATS (the _full entries: drive.js's full-detail models; the C++ draws one model per car, matched by name)
const CarSeats SEATS[] = {
  {"car_vw_golf_gti", true, {4.30, 1.47}, {0.919, 0.297}, {0.35, 0.436, -0.209, -0.44}, false, {0, 0, 0}, true, {0.37, 0.461, -1.085, -0.5}, {0.21, 0.22}, {1.40, 1.37}},
  {"car_vw_golf_gti_full", false, {4.30, 1.49}, {0.922, 0.306}, {0.35, 0.45, -0.21, -0.44}, false, {0, 0, 0}, true, {0.37, 0.473, -1.08, -0.5}, {0.277, 0.24}, {1.40, 1.39}},
  {"car_bmw_x3", true, {4.70, 1.68}, {1.065, 0.307}, {0.373, 0.632, -0.238, -0.44}, false, {0, 0, 0}, true, {0.38, 0.631, -1.079, -0.37}, {0.40, 0.39}, {1.60, 1.59}},
  {"car_audi_rs6", true, {5.00, 1.50}, {0.916, 0.469}, {0.381, 0.432, 0.0, -0.57}, true, {0.407, -0.10, -0.43}, true, {0.38, 0.455, -0.986, -0.37}, {0.295, 0.23}, {1.377, 1.38}},
  {"car_tesla_m3", true, {4.70, 1.46}, {0.811, 0.607}, {0.47, 0.395, -0.105, -0.17}, false, {0, 0, 0}, true, {0.38, 0.394, -0.97, -0.17}, {0.28, 0.27}, {1.37, 1.37}},
  {"car_tesla_m3_full", false, {4.70, 1.46}, {0.914, 0.668}, {0.47, 0.395, -0.105, -0.17}, false, {0, 0, 0}, true, {0.38, 0.394, -0.97, -0.17}, {0.28, 0.27}, {1.37, 1.37}},
  {"car_mercedes_sls", true, {4.64, 1.26}, {0.768, -0.095}, {0.43, 0.29, -0.675, -0.32}, false, {0, 0, 0}, false, {0, 0, 0, 0}, {0.20, 0.20}, {1.17, 1.15}},
  {"car_porsche_taycan", true, {4.96, 1.36}, {0.834, 0.352}, {0.37, 0.37, -0.255, -0.27}, false, {0, 0, 0}, true, {0.38, 0.47, -1.08, -0.4}, {0.25, 0.24}, {1.28, 1.22}},
  {"car_lamborghini_huracan", true, {4.52, 1.18}, {0.779, 0.359}, {0.37, 0.27, -0.24, -0.5}, false, {0, 0, 0}, false, {0, 0, 0, 0}, {0.18, 0.18}, {1.15, 1.10}},
  {"car_toyota_gr_yaris", true, {3.99, 1.44}, {0.918, 0.277}, {0.35, 0.47, -0.26, -0.47}, false, {0, 0, 0}, true, {0.38, 0.54, -1.085, -0.35}, {0.25, 0.23}, {1.40, 1.37}},
  {"car_audi_etron_gt", true, {4.96, 1.38}, {0.918, 0.402}, {0.37, 0.36, -0.255, -0.37}, false, {0, 0, 0}, true, {0.38, 0.475, -0.995, -0.5}, {0.26, 0.25}, {1.30, 1.28}},
  {"car_mercedes_gls", true, {5.20, 1.86}, {1.156, 0.625}, {0.42, 0.79, -0.01, -0.4}, false, {0, 0, 0}, true, {0.42, 0.73, -1.16, -0.33}, {0.50, 0.49}, {1.66, 1.77}},
};
constexpr double DEPTH = 0.13, DEPTH_U = 0.11;   // hip joint / shoulder joints to the backrest
constexpr double RECLINE = 0.2;
constexpr double ROOF_GAP = 0.02, SINK_MAX = 0.12, LEAN = 0.6, LEAN_HARD = 0.9;
constexpr double SOLE = 0.2;
const V3 FWD(0, 0, 1), RIGHT(-1, 0, 0);

// a seat s ([cushion y, backrest z, lean]) as an array view
struct S3 { double y, z, lean; };
S3 frontOf(const CarSeats& S) { return {S.d[1], S.d[2], S.d[3]}; }
S3 passOf(const CarSeats& S) { return S.hasP ? S3{S.p[0], S.p[1], S.p[2]} : frontOf(S); }
S3 rearOf(const CarSeats& S) { return {S.r[1], S.r[2], S.r[3]}; }
// hipAt: a seat's hip joint (car frame) for someone whose hip joint is hipY above the seat surface
V3 hipAt(double x, const S3& s, double hipY) { return V3(x, s.y - 0.01 + SEAT_LIFT + hipY, s.z + s.lean * (hipY - 0.15) + DEPTH); }
// originAt: where a baked figure's seat point goes on a seat s at x (its back against the backrest where it touches first)
V3 originAt(double x, const S3& s, const V3& hip, const V3* chest) {
  auto back = [&](double h) { return s.z + s.lean * (h - 0.15); };
  double oz = std::max(back(hip.y) + DEPTH - hip.z, chest ? back(chest->y) + DEPTH_U - chest->z : -std::numeric_limits<double>::infinity());
  return V3(x - hip.x, s.y - 0.01 + SEAT_LIFT, oz);
}
// THREE.Quaternion.setFromEuler (order 'YXZ')
Q eulerYXZ(double x, double y, double z) {
  double c1 = std::cos(x / 2), c2 = std::cos(y / 2), c3 = std::cos(z / 2), s1 = std::sin(x / 2), s2 = std::sin(y / 2), s3 = std::sin(z / 2);
  return Q(c1 * c2 * c3 + s1 * s2 * s3, s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3);
}
V3 toLocal(const glm::dmat4* g, const V3& v) { return g ? V3(glm::inverse(*g) * glm::dvec4(v, 1)) : v; }
V3 toWorld(const glm::dmat4* g, const V3& v) { return g ? V3(*g * glm::dvec4(v, 1)) : v; }
} // namespace

const CarSeats* carSeatsFor(const std::string& model) {
  for (const CarSeats& s : SEATS) if (model == s.name) return &s;
  return nullptr;
}

CarTemplate CarTemplate::of(const CarSeats* S, double sizeY) {
  CarTemplate t;
  t.S = S;
  t.sizeY = sizeY;
  if (S) { t.steering = true; t.steerC = V3(S->d[0], S->wheel[0], S->wheel[1]); }
  return t;
}

bool carSeatHip(const CarTemplate& t, double hipY, double reach, V3& out) {
  if (!t.S) return false;
  out = hipAt(t.S->d[0], frontOf(*t.S), hipY);
  if (reach != 0 && t.steering) out.z = std::max(out.z, t.steerC.z - reach);
  return true;
}

int carSeatPoints(const CarTemplate& t, V3 out[4]) {
  if (!t.S) return 0;
  const CarSeats& S = *t.S;
  // (taxi.js carSeats pt: on the cushion (SEAT_LIFT), the hip 0.1 over it, DEPTH ahead of the backrest)
  auto pt = [](double x, const S3& s) { return V3(x, s.y - 0.01 + SEAT_LIFT, s.z + s.lean * (0.1 - 0.15) + 0.13); };
  int n = 0;
  out[n++] = pt(S.d[0], frontOf(S));
  out[n++] = pt(-S.d[0], passOf(S));
  if (S.hasR) { out[n++] = pt(S.r[0], rearOf(S)); out[n++] = pt(-S.r[0], rearOf(S)); }
  return n;
}

// ------------------------------------------------------------------- skinned vertices (SkinnedMesh.getVertexPosition)
size_t SkierRig::skinnedCount() const {
  const RigModel& R = *M_;
  if (R.skinPrim < 0) return 0;
  const auto& V = R.body->meshes[size_t(R.skinMesh)].primitives[size_t(R.skinPrim)].cpuVerts;
  return V ? V->size() / 16 : 0;
}
V3 SkierRig::skinnedVertex(size_t i) const {
  const RigModel& R = *M_;
  const Skin& sk = R.body->skins[0];
  const float* q = &(*R.body->meshes[size_t(R.skinMesh)].primitives[size_t(R.skinPrim)].cpuVerts)[i * 16];
  V3 v(q[0], q[1], q[2]), o(0);
  for (int k = 0; k < 4; k++) {
    double w = q[12 + k];
    if (!w) continue;
    size_t j = size_t(q[8 + k]);
    o += mulPoint(W(sk.joints[j]) * glm::dmat4(sk.inverseBind[j]), v) * w;
  }
  return o;
}

// ------------------------------------------------------------------- carpeople.js
void SkierRig::carTwoBone(int a, int b, int c, const V3& target, const V3& pole) {
  if (a < 0 || b < 0 || c < 0) return;
  V3 pa = wpos(a), pb = wpos(b), pc = wpos(c);
  double lab = glm::distance(pa, pb), lbc = glm::distance(pb, pc);
  V3 dir = target - pa;
  double d = std::min(std::max(glm::length(dir), std::fabs(lab - lbc) + 1e-3), lab + lbc - 1e-3);
  dir = normalize(dir);
  double cosA = (lab * lab + d * d - lbc * lbc) / (2 * lab * d), sinA = std::sqrt(std::max(0.0, 1 - cosA * cosA));
  V3 pd = normalize(pole + dir * (-glm::dot(pole, dir)));
  V3 mid = pa + dir * (lab * cosA) + pd * (lab * sinA);
  aimBone(a, pb, mid, pa);
  aimBone(b, wpos(c), pa + dir * d, wpos(b));
}

void SkierRig::leanBack(const V3& Rt, double rec, double neck, double head) {
  const int* b = M_->b;
  auto rotW = [&](int bone, double angle) { if (bone >= 0 && angle != 0) rotateWorld(bone, Rt, angle); };
  rotW(b[RigModel::spine0], rec * 0.55); rotW(b[RigModel::spine1], rec * 0.45); rotW(b[RigModel::neck], neck); rotW(b[RigModel::head], head);
}

double SkierRig::underRoof(const glm::dmat4* g, const CarTemplate* t, int seat, bool wheel) {
  const int* b = M_->b;
  const int head = b[RigModel::head], hips = b[RigModel::hips], lUp = b[RigModel::lUp], rUp = b[RigModel::rUp];
  if (head < 0 || hips < 0 || b[RigModel::spine0] < 0 || lUp < 0 || rUp < 0 || !t) return 0;
  const CarSeats* S = t->S;
  const bool front = seat < 2;
  const double roof = S ? (front ? S->roof[0] : S->roof[1]) : t->sizeY - 0.05;
  // headTopOf: the crown's vertices (within 6 cm of the highest, in the root's frame), as points in the head bone's
  // frame, a few dozen; once per rig, not while the head is folded away
  if (!headTopDone_) {
    if (s_[size_t(head)].x < 0.5 || skinnedCount() == 0) return 0;
    Q iq = conj(rootQ_);
    size_t n = skinnedCount();
    std::vector<V3> Wv(n);
    std::vector<double> Y(n);
    double best = -std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < n; i++) { Wv[i] = skinnedVertex(i); Y[i] = applyQ(Wv[i], iq).y; best = std::max(best, Y[i]); }
    std::vector<size_t> pts;
    for (size_t i = 0; i < n; i++) if (Y[i] > best - 0.06) pts.push_back(i);
    size_t step = std::max<size_t>(1, pts.size() / 48);
    M4 hinv = glm::inverse(W(head));
    for (size_t k = 0; k < pts.size(); k++) if (k % step == 0) headTop_.push_back(mulPoint(hinv, Wv[pts[k]]));
    headTopDone_ = true;
  }
  if (headTop_.empty()) return 0;
  Q gq = g ? decomposeQ(*g) : Q(1, 0, 0, 0);
  V3 Rt = applyQ(V3(-1, 0, 0), gq), U = applyQ(V3(0, 1, 0), gq);
  V3 top = headTop_[0];
  auto over = [&]() {
    double y = -std::numeric_limits<double>::infinity();
    M4 H = W(head);
    for (const V3& q : headTop_) { double h = toLocal(g, mulPoint(H, q)).y; if (h > y) { y = h; top = q; } }
    return y - (roof - ROOF_GAP);
  };
  auto hipMid = [&]() { return (wpos(lUp) + wpos(rUp)) * 0.5; };
  double ex = over(), leant = 0, sunk = 0;
  if (ex <= 0) return 0;
  const bool hasFl = S != nullptr;
  const double fl = S ? (front ? S->floor[0] : S->floor[1]) : 0;
  const double sinkMax = std::min(SINK_MAX, !hasFl ? SEAT_LIFT : std::max(0.0, toLocal(g, hipMid()).y - (fl + SOLE - 0.045)));
  const int lArm = b[RigModel::lArm], rArm = b[RigModel::rArm];
  auto shoulders = [&]() { return lArm >= 0 && rArm >= 0 ? toLocal(g, (wpos(lArm) + wpos(rArm)) * 0.5).z : 0.0; };
  const double sh0 = wheel ? shoulders() : 0;
  auto leanTo = [&](double mx) {
    for (int k = 0; k < 8 && ex > 0.002 && leant < mx - 1e-3; k++) {
      V3 T = toLocal(g, mulPoint(W(head), top)) - toLocal(g, hipMid());
      double r = std::hypot(T.y, T.z), a0 = std::atan2(-T.z, T.y);
      double a = std::min(mx - leant, std::max(0.01, 1.5 * (std::acos(std::max(-1.0, std::min(1.0, (T.y - ex) / r))) - a0)));
      leant += a;
      V3 hc = hipMid();
      Q q = axisAngle(Rt, a * 0.4);
      V3 hp = applyQ(wpos(hips) - hc, q) + hc;
      setWorldQuat(hips, mul(q, wquat(hips)));
      setWorldPos(hips, hp);
      leanBack(Rt, a * 0.6, -a * 0.65, -a * 0.35);
      ex = over();
    }
  };
  auto sinkTo = [&](double mx) {
    double s = std::min(mx - sunk, ex);
    if (s <= 0) return;
    sunk += s;
    setWorldPos(hips, wpos(hips) + U * (-s));
    ex = over();
  };
  leanTo(wheel ? 0 : LEAN);
  sinkTo(wheel ? sinkMax : std::min(SEAT_LIFT, sinkMax));
  leanTo(LEAN_HARD);
  sinkTo(sinkMax);
  if (wheel) {
    double dz = sh0 - shoulders();
    if (dz > 0) setWorldPos(hips, wpos(hips) + applyQ(V3(0, 0, 1), gq) * dz);
  }
  return std::max(0.0, ex);
}

void SkierRig::seatLegs(const glm::dmat4* g, const CarTemplate* t, int seat, const SeatLegsOpt& o) {
  const RigModel& R = *M_;
  const int* b = R.b;
  if (b[RigModel::hips] < 0 || b[RigModel::lUp] < 0 || b[RigModel::rUp] < 0 || b[RigModel::lLeg] < 0 || b[RigModel::rLeg] < 0 ||
      b[RigModel::lFoot] < 0 || b[RigModel::rFoot] < 0)
    return;
  // (the head under this car's roof first: underRoof; o.roof false: done already)
  if (t && o.roof) underRoof(g, t, seat, false);
  Q gq = g ? decomposeQ(*g) : Q(1, 0, 0, 0);
  const CarSeats* S = t ? t->S : nullptr;
  const bool front = seat < 2;
  const bool hasFloor = o.hasFloor || S;
  const double floor = o.hasFloor ? o.floor : S ? (front ? S->floor[0] : S->floor[1]) : 0;
  const double Lt = glm::distance(wpos(b[RigModel::lUp]), wpos(b[RigModel::lLeg])), Ls = glm::distance(wpos(b[RigModel::lLeg]), wpos(b[RigModel::lFoot]));
  // (the steering wheel rim's lowest point, the driver's knees a hand under it)
  const bool hasW = o.driver && t && t->steering;
  const double Wy = hasW ? t->steerC.y - t->rimR * std::cos(t->tilt) : 0;
  for (int i = 0; i < 2; i++) {
    const int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    const double side = i == 0 ? 1 : -1;   // (+x: the figure's left)
    V3 J = toLocal(g, wpos(up));
    double dy = std::min(0.5, std::max(-0.05, hasFloor ? J.y - floor - SOLE : 0.15));
    double rise = std::max(0.06, std::min(0.2, hasW ? Wy - 0.07 - J.y : 0.2));
    double phi = front ? 0.6 : 0.35;
    phi = std::max(phi, std::acos(std::min(1.0, (rise + dy) / Ls)));
    phi = std::min(phi, 1.25);
    double th = std::asin(std::min(0.6, std::max(-0.8, (dy - Ls * std::cos(phi)) / Lt)));
    V3 K(J.x + side * 0.02, J.y - Lt * std::sin(th), J.z + Lt * std::cos(th));
    V3 T(K.x + side * 0.01, K.y - Ls * std::cos(phi), K.z + Ls * std::sin(phi));
    V3 P = -((J + T) * 0.5 - K);
    if (g) { T = toWorld(g, T); P = applyQ(P, gq); }
    carTwoBone(up, leg, foot, T, P);
    // the boot: ahead along the car, toes up about half the shin's slope
    if (R.body->nodes[size_t(foot)].parent >= 0) {
      double pitch = -phi * 0.5 + 0.08 - (o.driver && i == 1 ? 0.12 : 0);
      setWorldQuat(foot, mul(mul(gq, eulerYXZ(pitch, -side * 0.07, 0)), R.footRest[i]));
    }
  }
  if (!o.hands || b[RigModel::lArm] < 0 || b[RigModel::rArm] < 0) return;
  // the hands resting on the thighs as they are now, the elbows out and back, palms down (as skier.js poseSit)
  V3 U = applyQ(V3(0, 1, 0), gq);
  for (int i = 0; i < 2; i++) {
    const int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    const int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg];
    if (fore < 0 || hand < 0) continue;
    const double side = i == 0 ? 1 : -1;
    V3 Jw = wpos(up), Kw = wpos(leg);
    V3 tgt = vlerp(Jw, Kw, 0.55) + U * 0.1;
    carTwoBone(arm, fore, hand, tgt, applyQ(normalize(V3(side, -1, -0.4)), gq));
    aimHand(i, normalize(Kw - Jw) + U * (-0.2), -U);
  }
}

// ------------------------------------------------------------------- seatpose.js poseSeated
void SkierRig::poseSeated(SeatedKind kind, double look, double rnd) {
  const RigModel& R = *M_;
  const int* b = R.b;
  if (b[RigModel::hips] < 0) return;
  auto rotW = [&](int bone, const V3& axis, double angle) { if (bone >= 0 && angle != 0) rotateWorld(bone, axis, angle); };
  // slouch: the pelvis a touch forward, the back leaning into the backrest, the neck bringing the eyes level again
  V3 hip = wpos(b[RigModel::hips]) + FWD * 0.035 + UP * (-0.012);
  setWorldPos(b[RigModel::hips], hip);
  double slouch = 0.07 + rnd * 0.06;
  rotW(b[RigModel::spine0], RIGHT, slouch * 0.55);
  rotW(b[RigModel::spine1], RIGHT, slouch * 0.45);
  rotW(b[RigModel::neck], RIGHT, -slouch * 0.6);
  // legs: feet flat on the floor in front of the seat, knees a little apart
  double seatY = hip.y - 0.1 + 0.012;
  for (int i = 0; i < 2; i++) {
    const int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    double side = i == 0 ? -1 : 1;
    V3 ankle = V3(0, seatY - 0.41, 0) + FWD * (0.39 + (rnd - 0.5) * 0.08 + (i ? 0.03 : -0.02)) + RIGHT * (side * (0.11 + rnd * 0.05));
    carTwoBone(up, leg, foot, ankle, FWD + RIGHT * (side * 0.25) + UP * 0.3);
    if (foot >= 0) setWorldQuat(foot, mul(axisAngle(RIGHT, -0.04), R.footRest[i]));
  }
  // arms
  V3 chest = (wpos(b[RigModel::lArm]) + wpos(b[RigModel::rArm])) * 0.5;
  auto thigh = [&](int i, double t) {
    V3 up = wpos(b[i == 0 ? RigModel::lUp : RigModel::rUp]), kn = wpos(b[i == 0 ? RigModel::lLeg : RigModel::rLeg]);
    return vlerp(up, kn, t) + UP * 0.085;
  };
  auto target = [&](int i) {
    double side = i == 0 ? -1 : 1;
    if (kind == SeatedKind::Lap) return vlerp(thigh(0, 0.42), thigh(1, 0.42), 0.5) + RIGHT * (side * 0.04) + UP * 0.01;
    if (kind == SeatedKind::Crossed) return chest + UP * (-0.26 + (i ? 0.025 : 0)) + FWD * (0.19 + (i ? 0.03 : 0)) + RIGHT * (-side * 0.12);
    if (kind == SeatedKind::Phone) return chest + UP * (-0.2) + FWD * 0.3 + RIGHT * (side * 0.035);
    return thigh(i, 0.55 + rnd * 0.15) + RIGHT * (side * 0.015);
  };
  auto pole = [&](int i) {
    double side = i == 0 ? -1 : 1;
    if (kind == SeatedKind::Crossed) return normalize(RIGHT * side + UP * (-0.4) + FWD * 0.1);
    if (kind == SeatedKind::Phone) return normalize(RIGHT * (side * 0.6) + UP * (-1.0) + FWD * (-0.15));
    return normalize(RIGHT * (side * 0.7) + UP * (-1.0) + FWD * (-0.5));
  };
  relaxShoulders();
  for (int i = 0; i < 2; i++) {
    const int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    carTwoBone(arm, fore, hand, target(i), pole(i));
    if (hand >= 0 && fore >= 0) setWorldQuat(hand, wquat(fore));   // a straight, relaxed wrist
  }
  // the head: turned, bowed a little (over the phone: more)
  double bow = kind == SeatedKind::Phone ? 0.42 : 0.08 + rnd * 0.08;
  rotW(b[RigModel::neck], UP, look * 0.35);
  rotW(b[RigModel::head], UP, look * 0.65);
  V3 yawRight = applyAxisAngle(RIGHT, UP, look);
  rotW(b[RigModel::head], yawRight, -bow);
}

// ------------------------------------------------------------------- carpeople.js bakeOne + fill (live)
void SkierRig::poseCarFigure(const CarSeatRef& c) {
  const RigModel& R = *M_;
  const int* b = R.b;
  const bool driver = c.driver;
  const CarSeats* bS = driver ? c.t.S : nullptr;   // (a passenger is baked once for any car: no seat hints)
  const bool fitted = !driver || bS;
  // leant back into the backrest (a driver as far as that car's seat leans), the neck and head level the eyes again
  double rec = !fitted ? 0 : bS ? std::min(0.3, std::max(0.02, std::atan(-bS->d[3]) - 0.15)) : RECLINE;
  if (rec != 0) leanBack(RIGHT, rec, -rec * 0.6, -rec * 0.3);
  const bool odd = c.look % 2 != 0;
  poseSeated(driver ? SeatedKind::Thighs : odd ? SeatedKind::Lap : SeatedKind::Thighs, driver ? 0 : odd ? 0.35 : -0.25, 0.35);
  const V3 hip = wpos(b[RigModel::hips]);
  const bool hasChest = b[RigModel::lArm] >= 0 && b[RigModel::rArm] >= 0;
  const V3 chest = hasChest ? (wpos(b[RigModel::lArm]) + wpos(b[RigModel::rArm])) * 0.5 : V3(0);
  V3 O(0);
  if (bS) O = originAt(bS->d[0], frontOf(*bS), hip, hasChest ? &chest : nullptr);
  // legs to the floor ahead (knees bent, heels on that model's floor, feet flat; a passenger: an average car's floor,
  // ~0.2 m under the cushion), so no boot pokes out under the car
  SeatLegsOpt lo;
  lo.driver = driver; lo.hasFloor = true; lo.floor = bS ? bS->floor[0] - O.y : -0.19 - SEAT_LIFT;
  seatLegs(nullptr, nullptr, driver ? 0 : 1, lo);
  const V3 eye = wpos(b[RigModel::head]) + V3(0, 0.09, 0.08);
  if (driver) {
    // hands on the wheel at ten to two: this model's wheel where it is from the seat, else below and ahead of the eye
    const double tilt = 0.38;
    V3 wc = bS ? V3(bS->d[0], bS->wheel[0], bS->wheel[1]) - O : eye + V3(0, -0.27, 0.6);
    V3 wUp(0, std::cos(tilt), std::sin(tilt));
    relaxShoulders();
    for (int i = 0; i < 2; i++) {
      const int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
      double side = i == 0 ? 1 : -1;
      V3 tgt = wc + V3(1, 0, 0) * (side * 0.15) + wUp * 0.07 + FWD * (-0.03);
      carTwoBone(arm, fore, hand, tgt, normalize(V3(side * 0.7, -1, -0.25)));
      if (hand >= 0 && fore >= 0) setWorldQuat(hand, wquat(fore));
    }
  }
  // the figure's head top (its baked mesh's bounding box: once per figure and look)
  const int key = (driver ? 1000 : 0) + int(bS ? bS - SEATS : 99) * 4 + (c.look & 3);
  if (carFig.key != key) {
    double top = -std::numeric_limits<double>::infinity();
    for (size_t i = 0, n = skinnedCount(); i < n; i++) top = std::max(top, skinnedVertex(i).y);
    carFig.top = std::isfinite(top) ? top : 1.2;
    carFig.key = key;
  }
  carFig.hip = hip; carFig.chest = chest; carFig.hasChest = hasChest; carFig.eye = eye;
  carFig.O = carFigureOrigin(c);
}

// fill(): a figure on its seat, its head under the roof (fillByEye without seat hints: by the driver's eye)
V3 SkierRig::carFigureOrigin(const CarSeatRef& c) const {
  const CarSeats* S = c.t.S;
  V3 O;
  if (S) {
    S3 s = c.seat == 0 ? frontOf(*S) : c.seat == 1 ? passOf(*S) : S->hasR ? rearOf(*S) : passOf(*S);
    double roof = c.seat < 2 ? S->roof[0] : S->roof[1];
    O = originAt(c.x, s, carFig.hip, carFig.hasChest ? &carFig.chest : nullptr);
    O.y -= std::min(0.05, std::max(0.0, O.y + carFig.top - (roof - 0.03)));
  } else {
    // the figure's eye at the car's driver's eye (mirrored for a passenger, 0.86 m back for the back seat), lower if its
    // head would go through the roof
    double roof = c.t.sizeY - 0.05;
    V3 E(c.x, 0.45 + SEAT_EYE_Y - (c.seat == 1 ? 0.02 : c.seat >= 2 ? 0.04 : 0), -0.2 + SEAT_EYE_Z + (c.seat == 1 ? 0.02 : c.seat >= 2 ? -0.86 : 0));
    double sink = std::max(0.0, E.y + (carFig.top - carFig.eye.y) - roof);
    O = V3(E.x - carFig.eye.x, E.y - carFig.eye.y - sink, E.z - carFig.eye.z);
  }
  return O;
}

// ------------------------------------------------------------------- drive.js placeRig
V3 SkierRig::placeDriver(const glm::dmat4& g, const CarTemplate& t, double steer, bool inside) {
  const RigModel& R = *M_;
  const int* b = R.b;
  Q gq = decomposeQ(g);
  setRootQuat(gq);
  // your own arms (first person folds them away for the ski view model) and, inside, no head before the eye
  for (int a : {b[RigModel::lArm], b[RigModel::rArm]}) if (a >= 0 && s_[size_t(a)].x != 1) { s_[size_t(a)] = V3(1); touch(a); }
  if (b[RigModel::head] >= 0) { s_[size_t(b[RigModel::head])] = V3(inside ? 0.001 : 1); touch(b[RigModel::head]); }
  // leant back toward this car's backrest: the torso turned from how the rig sits to ~60 % of the backrest's lean, the
  // neck in line with it, the head level
  const CarSeats* seat = t.S;
  V3 tv = toLocal(&g, wpos(b[RigModel::neck] >= 0 ? b[RigModel::neck] : b[RigModel::head])) - toLocal(&g, wpos(b[RigModel::hips]));
  double want = 0.6 * std::atan(seat ? -seat->d[3] : 0.4), cur = std::atan2(-tv.z, tv.y), rec = clamp(want - cur, 0, 0.6);
  leanBack(applyQ(V3(-1, 0, 0), gq), rec, 0.25, -(rec + 0.25) * 0.85);
  // (the chase view: the head top under this car's roof; inside the head is folded away)
  if (!inside) underRoof(&g, &t, 0, true);
  V3 seatP = toLocal(&g, rootPos);
  V3 c = t.steering ? t.steerC : seatP + V3(0, SEAT_EYE_Y, SEAT_EYE_Z) + V3(0, -0.27, 0.6);
  double tilt = t.steering ? t.tilt : 0.38, ca = std::cos(tilt), sa = std::sin(tilt), rr = (t.steering ? t.rimR : 0.185) * 0.97;
  double turn = clamp(steer * 3, -1.75, 1.75);   // (the wheel's own angle)
  // the wheel's frame (car space): A along the column (away from you), U up its face, +x to your left
  V3 A(0, -sa, ca), U(0, ca, sa);
  for (int i = 0; i < 2; i++) {
    const int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    double side = i == 0 ? 1 : -1, phi = side * 1.05 + turn;
    // the grip on the rim (ten to two, turning with it); the wrist a hand's length short of it, toward you
    V3 radial = V3(std::sin(phi), 0, 0) + U * std::cos(phi);
    V3 grip = c + radial * rr;
    V3 wrist = toWorld(&g, grip + A * (-0.075) + radial * 0.035);
    carTwoBone(arm, fore, hand, wrist, applyQ(normalize(V3(side * 0.7, -1, -0.3)), gq));
    // fingers over the rim and round it (forward and in), the palm on the rim
    V3 fingers = applyQ(normalize(A * 0.8 + radial * (-0.45)), gq);
    V3 palm = applyQ(normalize(radial * (-0.75) + A * 0.35), gq);
    aimHand(i, fingers, palm);
  }
  // the legs: bent at the knee into the footwell, the heels on this car's floor, the right foot on the throttle
  SeatLegsOpt lo;
  lo.driver = true; lo.roof = false;
  seatLegs(&g, &t, 0, lo);
  // your eyes (the camera inside), in the car's frame: ahead of and above the head joint
  return toLocal(&g, wpos(b[RigModel::head]) + applyQ(V3(0, 0.09, 0.085), gq));
}

} // namespace sl
