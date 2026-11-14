// First person on skis: the view model of gloved hands holding their poles (skier.js buildFpView / updateFpView),
// carried in the camera's frame. Each glove and its pole are one rigid piece (no IK); in the rest pose (FP_POSE) the
// arms and poles are fixed to the camera; a pole push (the rig's plant timer, one pole or both) pulls each whole arm
// straight back along the body and returns it. They come up into the picture as they appear (clicking into the skis,
// getting up after a fall), lift a little with a landing (the head's own bump spring, plus the absorb) and buzz with
// the speed, more on rough off-piste snow than on a groomed run, and when skidding. The meshes: player_skier.cpp.
#include "player/skier_rig.h"

namespace sl {
using namespace three;

namespace {
// skier.js FP_POSE: the fist (x, y, z) and the elbow its forearm runs off toward (ex, ey, ez), camera frame (x right,
// y up, -z ahead; the left hand mirrored)
constexpr double FP_X = 0.235, FP_Y = -0.255, FP_Z = -0.44, FP_EX = 0.33, FP_EY = -0.72, FP_EZ = 0.08;
// FP_PULL: how far the whole arm is pulled back (+z) and down (-y) at the stroke's peak
constexpr double FP_PULL_Y = 0.04, FP_PULL_Z = 0.12;
const V3 FP_WRIST(0.024, -0.012, -0.068);   // the wrist joint in the fist's frame
// push weight over the rig's plant timer (0..1 over 0.55 s): pulled back quickly, then returned
double fpPush(double t) { return smoothT(t, 0, 0.3) * (1 - smoothT(t, 0.4, 0.95)); }
// exact critically damped spring step of x (velocity v) toward t at angular frequency w (stable at any h)
void springTo(V3& x, V3& v, const V3& t, double w, double h) {
  double e = std::exp(-w * h);
  for (int k = 0; k < 3; k++) {
    double d = x[k] - t[k], c = v[k] + w * d;
    x[k] = t[k] + (d + c * h) * e;
    v[k] = (v[k] - c * w * h) * e;
  }
}
V3 clampLength(const V3& v, double mx) { double l = glm::length(v); return l > mx ? v * (mx / l) : v; }   // (Vector3.clampLength(0, max))
} // namespace

void SkierRig::updateFpView(double dt, const V3& camPos, const Q& camQ, const FpViewState& st, bool armsLoaded) {
  FpView& S = fpView;
  const bool show = fp_ && hasPoles_ && st.skiing && !fpGearHidden_ && (!hasSkis_ || skis[0].visible);
  if (!show) { if (S.built) { S.visible = false; S.raise = 0; S.init = false; } return; }
  if (!S.built) { S = FpView{}; S.built = true; }
  const double h = clamp(dt, 0, 0.05);
  S.visible = true;
  S.arms = armsLoaded;
  S.pos = camPos;
  S.quat = camQ;
  S.t += h;
  if (!S.init) {
    S.init = true; S.q = camQ; S.e = camPos; S.ev = V3(0); S.acc = V3(0);
    S.lag = V3(0); S.lagV = V3(0); S.w = V3(0);
    for (FpHand& H : S.hands) H.init = false;
  }
  S.raise = std::min(1.0, S.raise + h / 0.4);
  const double rise = 1 - S.raise * S.raise * (3 - 2 * S.raise);
  // ---- inertia: the head's turn rate and acceleration in its own frame (the shared bump spring)
  if (h > 1e-4) {
    Q dq = mul(conj(S.q), camQ);
    if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
    const double k = 2 / h;
    S.w = vlerp(S.w, V3(clamp(dq.x * k, -6, 6), clamp(dq.y * k, -6, 6), clamp(dq.z * k, -6, 6)), ek(h, 14));
    V3 vel = (camPos - S.e) / h;
    V3 acc = (vel - S.ev) / h;
    if (lengthSq(vel) > 2500 || lengthSq(S.ev) > 2500) acc = V3(0);   // (a teleport, not a motion)
    S.ev = vel;
    acc = clampLength(applyQ(acc, conj(camQ)), 60);
    S.acc = vlerp(S.acc, acc, ek(h, 25));
    // spring-damper on the shared hand offset, driven by the head's acceleration (bumps, landings, edge sets)
    const double W = 12, Z = 0.55, g = 0.08;
    const V3 a = S.acc;
    S.lagV.x += (-W * W * S.lag.x - 2 * Z * W * S.lagV.x - a.x * g) * h;
    S.lagV.y += (-W * W * S.lag.y - 2 * Z * W * S.lagV.y - a.y * g) * h;
    S.lagV.z += (-W * W * S.lag.z - 2 * Z * W * S.lagV.z - a.z * g) * h;
    S.lag = clampLength(S.lag + S.lagV * h, 0.07);
  }
  S.q = camQ; S.e = camPos;
  for (int i = 0; i < 2; i++) {
    const double s = i == 0 ? -1 : 1, pt = plant_[i].t;
    FpHand& H = S.hands[i];
    const double push = pt < 1 ? fpPush(pt) : 0;
    // ---- where the hand wants to be (camera frame): the rest pose, pulled back
    const V3 T(s * FP_X, FP_Y - FP_PULL_Y * push, FP_Z + FP_PULL_Z * push);
    if (!H.init) { H.init = true; H.p = T; H.v = V3(0); }
    springTo(H.p, H.v, T, 18, h);
    H.p.x = s * FP_X;   // (never sideways, not even through the spring)
    V3 p = H.p;
    p.y -= 0.32 * rise; p.z += 0.06 * rise;
    // a landing lifts them, and a buzz through the poles that grows with speed (rough snow, skidding)
    const double land = clamp(-S.lag.y * 0.9, -0.025, 0.05) + 0.03 * st.absorb;
    const double amp = st.air ? 0 : smoothT(st.speed, 2, 24) * (0.0012 + 0.0042 * st.rough) + 0.0025 * clamp(st.brake, 0, 1);
    const double tt = S.t + i * 0.37;
    p.y += land + amp * (std::sin(tt * 61) * 0.6 + std::sin(tt * 37.3 + 1.1) * 0.4);
    p.z += amp * 0.5 * std::sin(tt * 47.1 + 2.3);
    H.rootP = p;
    // ---- the fist's orientation: fixed, from the rest pose (the pole angled back, the forearm toward the elbow)
    const V3 D = normalize(V3(s * 0.2, -0.95, 0.24));
    const V3 Y = -D;
    V3 Zb = S.arms ? -(V3(s * FP_EX, FP_EY, FP_EZ) - V3(s * FP_X, FP_Y, FP_Z)) : V3(-s * 0.28, -0.2, -1);
    Zb = normalize(Zb + Y * (-glm::dot(Zb, Y)));
    const V3 X = glm::cross(Y, Zb);
    H.rootQ = basisQuat(X, Y, Zb);
    H.d = D;
    // the cuff (procedural fists only): at the wrist, toward the elbow, which moves back with the hand
    V3 wrist = FP_WRIST;
    wrist.x *= -s;   // (the right fist is mirrored)
    wrist = applyQ(wrist, H.rootQ) + p;
    const V3 elbow = normalize(V3(s * FP_EX, FP_EY, FP_EZ) + (p - V3(s * FP_X, FP_Y, FP_Z)) - wrist);
    H.cuffP = wrist;
    H.cuffQ = fromUnitVectors(UP, elbow);
  }
}

} // namespace sl
