// The jump on foot (native, Nov 2026). player.js lifts the walking body by footJumpY and lets the walk / idle carry on
// in the air ("you kind of just walk in the air"); here the jump has its own body language, layered over the walk:
//  - the load (Player: 0.15 s from a stand, 0.075 s off a running stride): the knees and hips bend, the torso leans
//    over the knees, the arms swing back, the heels come up at the end;
//  - the push-off: legs and ankles extend (toes pointed), the arms drive forward and up (a standing jump), or the
//    arm opposite the leading knee drives through (a running jump);
//  - the air: a standing jump tucks both knees up under the body, a running jump holds the stride (the leading knee
//    high, the trailing leg bent behind); the arms come out for balance as the climb slows;
//  - the fall: legs reach down and a little forward for the snow, the arms rise and widen the longer the drop;
//  - the landing: the knees absorb (deeper and longer for a bigger drop, less off a run), the torso folds over, the
//    arms come forward, then the layer fades back into the idle / walk / run.
// Procedural bone poses on the same rig (two-bone IK for the legs and arms), everything through critically damped
// springs so it moves like a body, not between keys. RigState::footJump off (NPCs, --verify-poses): nothing changes.
#include "player/skier_rig.h"
#include <cmath>

namespace sl {
using namespace three;

namespace {
const V3 X_AXIS(1, 0, 0), DOWN(0, -1, 0);
// smoothstep with the edges first (either order)
double ss(double e0, double e1, double x) { double t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3 - 2 * t); }
// a critically damped spring toward `target` (implicit: stable at any dt)
void spring(double& x, double& v, double target, double omega, double dt) {
  const double f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, inv = 1 / (f + hhoo);
  const double nx = (f * x + dt * v + hhoo * target) * inv, nv = (v + hoo * (target - x)) * inv;
  x = nx; v = nv;
}
void spring(V3& x, V3& v, const V3& target, double omega, double dt) {
  for (int k = 0; k < 3; k++) spring(x[k], v[k], target[k], omega, dt);
}
// the arms' targets: (forward, up, out) from the shoulder, in arm lengths
const V3 A_REST(0.06, -0.96, 0.10), A_BACK(-0.7, -0.6, 0.16), A_UP(0.55, 0.45, 0.1), A_BAL(0.3, -0.22, 0.58),
    A_FALL(0.22, 0.12, 0.78), A_LAND(0.5, -0.58, 0.26), A_RFWD(0.4, -0.2, 0.1), A_RBACK(-0.46, -0.6, 0.14),
    A_RLAND(0.38, -0.7, 0.2);
} // namespace

void SkierRig::footJumpLayer(double dt, const RigState& st, const V3& fwd, const V3& right) {
  FootJumpS& J = fj_;
  if (!st.footJump) { J.w = 0; J.init = false; return; }
  const double airY = std::max(0.0, st.airY), h = clamp(dt, 1e-4, 0.05);
  const bool air = airY > 0.004;
  if (!J.init) {
    J = FootJumpS{};
    J.init = true; J.prevY = airY; J.wasAir = air;
    for (int i = 0; i < 2; i++) { J.arm[i] = A_REST; J.armV[i] = V3(0); }
  }
  const double vyRaw = (airY - J.prevY) / h;
  J.prevY = airY;
  J.vy = air ? (J.wasAir ? J.vy + (vyRaw - J.vy) * (1 - std::exp(-h * 30)) : vyRaw) : 0;
  const double wasWind = J.wind;
  J.wind = air ? 0 : clamp(st.footWind, 0.0, 1.0);
  if (J.wind > 0 || (air && !J.wasAir)) J.run = ss(1.0, 3.2, st.speed);
  // the load begins (or a take-off without one: someone else's jump): which knee leads off the stride (the foot
  // behind pushes off)
  if ((J.wind > 0 && wasWind <= 0) || (air && !J.wasAir && wasWind <= 0)) {
    double frac = gait_.phase;
    double best = -1;
    for (const Action& a : actions_) {
      const double dur = M_->clips[a.clip].clip.duration;
      if (a.clip != 0 && a.weight > best && dur > 0) { best = a.weight; frac = a.time / dur; }
    }
    J.lead = std::fmod(frac, 1.0) < 0.5 ? 1 : -1;
    J.strideD = 0;
  }
  if (air && !J.wasAir) { J.airT = 0; J.peak = 0; J.landT = -1; }
  if (air) { J.airT += h; J.peak = std::max(J.peak, airY); }
  else if (J.wasAir) { J.landT = 0; J.landH = J.peak; J.strideD = 0; }
  else if (J.landT >= 0) J.landT += h;
  if (!air) J.strideD += std::max(0.0, st.speed) * h;
  J.wasAir = air;
  // the layer's weight: in with the load (or at once in the air: someone else's jump has no load), held through the
  // landing's absorption, then out into the walk
  const double run = J.run;
  const double hold = J.hold = lerp(0.12 + 0.1 * std::min(1.0, J.landH), 0.05, run), fade = lerp(0.34, 0.2, run);
  if (air) J.w = std::min(1.0, std::max(J.w, ss(0, 0.35, J.wind)) + h / 0.06);
  else if (J.wind > 0) J.w = std::max(J.w, ss(0, 0.35, J.wind));
  else if (J.landT >= 0) { J.w = 1 - ss(hold, hold + fade, J.landT); if (J.landT > hold + fade) J.landT = -1; }
  else J.w = 0;
  if (J.w <= 1e-3 && !air) {
    J.crouch = J.crouchV = J.tuck = J.tuckV = J.prep = J.prepV = J.point = J.pointV = J.pitch = J.pitchV = 0;
    for (int i = 0; i < 2; i++) { J.arm[i] = A_REST; J.armV[i] = V3(0); }
    return;
  }
  // the base pose (the idle / the walk clips) kept for the blend
  const RigModel& R = *M_;
  J.baseR.resize(r_.size()); J.baseT.resize(t_.size());
  for (int i : R.bones) { J.baseR[size_t(i)] = r_[size_t(i)]; J.baseT[size_t(i)] = t_[size_t(i)]; }
  setRoot(rootPos, st.heading);
  resetPose();
  poseFootJump(h, st, fwd, right);
  const double w = J.w * J.w * (3 - 2 * J.w);
  for (int i : R.bones) {
    r_[size_t(i)] = slerp(J.baseR[size_t(i)], r_[size_t(i)], w);
    t_[size_t(i)] = vlerp(J.baseT[size_t(i)], t_[size_t(i)], w);
  }
  std::fill(dirty_.begin(), dirty_.end(), uint8_t(1));
}

void SkierRig::poseFootJump(double dt, const RigState& st, const V3& fwd, const V3& right) {
  FootJumpS& J = fj_;
  const RigModel& R = *M_;
  const int* b = R.b;
  const double airY = std::max(0.0, st.airY), legL = R.legLen, run = J.run;
  const bool air = airY > 0.004;
  // time to touch down (ballistic), how far the body has dropped from the top of the jump
  const double tl = air ? (J.vy + std::sqrt(std::max(0.0, J.vy * J.vy + 19.62 * airY))) / 9.81 : 0;
  const double prepT = air && J.vy < 0 ? 1 - ss(0.1, 0.34, tl) : 0;
  const double fallK = air && J.vy < 0 ? ss(0.25, 1.1, J.peak - airY) : 0;
  // ---- the scalars: the load's crouch, the landing's absorption, the tuck, the toes, the torso's lean
  const double windE = ss(0, 1, J.wind);
  double crouchT = 0, tuckT = 0, pointT = 0, pitchT = 0;
  if (!air && J.wind > 0) {
    crouchT = windE;
    pointT = 0.55 * ss(0.65, 1.0, J.wind);
    pitchT = lerp(0.52, 0.3, run) * windE;
  } else if (air) {
    // (off a run the leading knee is already up as the foot behind leaves the snow)
    const double rise = lerp(ss(0.04, 0.2, J.airT), 1, 0.6 * run);
    tuckT = rise * (1 - prepT);
    pointT = 1 - ss(0.04, 0.2, J.airT);
    pitchT = lerp(-0.05, 0.16, tuckT) + run * 0.12 + 0.1 * prepT;
    if (J.airT <= dt * 1.5) J.tuck = std::max(J.tuck, 0.55 * run);
  }
  spring(J.crouch, J.crouchV, crouchT, air ? 26 : 30, dt);
  spring(J.tuck, J.tuckV, tuckT, 16, dt);
  spring(J.prep, J.prepV, prepT, 18, dt);
  spring(J.point, J.pointV, pointT, 24, dt);
  // the landing's absorption: a quick dip into the knees and the rise out of it, deeper for a bigger drop
  double absorb = 0;
  if (!air && J.landT >= 0) {
    const double A = clamp(0.05 + 0.2 * J.landH, 0.05, 0.3) * lerp(1, 0.6, run);
    const double tau = lerp(0.11, 0.08, run) + 0.03 * std::min(1.0, J.landH), x = J.landT / tau;
    absorb = A * x * std::exp(1 - x);
  }
  const double absorbN = absorb / 0.25;
  if (absorb > 0) pitchT = lerp(0.62, 0.35, run) * absorbN + run * 0.08;
  spring(J.pitch, J.pitchV, pitchT, absorb > 0 ? 30 : 16, dt);
  const double crouchD = std::max(0.0, J.crouch) * legL * lerp(0.27, 0.15, run) + absorb * legL;
  const double crouchN = std::min(1.0, crouchD / (legL * 0.25));
  // ---- the root and the hips
  const V3 root = rootPos;
  const double G = ground(root.x, root.z, root.y - airY + 0.4);
  V3 hip = root;
  hip.y = G + airY + R.ankleH + legL * 0.985 + R.upLegDrop - crouchD + std::max(0.0, J.point) * 0.035;
  hip = hip + fwd * (-0.08 * crouchN * (1 - run) + 0.04 * run);
  setWorldPos(b[RigModel::hips], hip);
  const double yawR = 0.1 * run * J.tuck * J.lead;
  rotateWorld(b[RigModel::hips], UP, yawR);
  rotateWorld(b[RigModel::hips], right, -J.pitch * 0.55);
  fixPosture(right);
  rotateWorld(b[RigModel::spine1], UP, -yawR * 1.6);
  rotateWorld(b[RigModel::spine1], right, -J.pitch * 0.45);
  // ---- the legs
  const double width = lerp(0.115, 0.1, run);
  for (int i = 0; i < 2; i++) {
    const int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
    const double side = i == 0 ? -1 : 1;
    const bool lead = side == J.lead;
    double toes;   // toes down (rad)
    V3 ankle;
    if (air) {
      const V3 hj = wpos(up);
      const double k = std::max(0.0, J.tuck), p = clamp(J.prep, 0.0, 1.0);
      // a standing jump: both knees up under the body; a running jump: the stride held (lead knee high, trail leg behind)
      double down = legL * (0.985 - 0.42 * k), along = legL * 0.15 * k;
      // (the trailing leg: straight behind as it pushes off, then the heel folding up behind)
      const double fold = ss(0.04, 0.3, J.airT);
      const double rDown = legL * (lead ? 0.98 - 0.44 * k : 0.98 - (0.06 + 0.4 * fold) * k), rAlong = legL * (lead ? 0.36 : -0.46 + 0.06 * fold) * k;
      down = lerp(down, rDown, run); along = lerp(along, rAlong, run);
      // reaching for the snow: legs long again, the feet a little ahead (a running landing: the lead foot ahead)
      down = lerp(down, legL * 0.965, p);
      along = lerp(along, legL * (0.07 + run * (lead ? 0.1 : -0.04)), p);
      ankle = hj + DOWN * down + fwd * along + right * (side * 0.015);
      ankle.y = std::max(ankle.y, G + R.ankleH);
      toes = 0.8 * std::max(0.0, J.point) + 0.35 * k * (1 - p) + 0.18 * p + (lead ? 0 : 0.3 * k * run);
    } else {
      // planted: the stance under the hips. Off a run the stride goes on: the foot on the snow stays where it was put
      // (it falls behind as the body travels), the other one swings through: the push-off foot and the leading knee
      // before the take-off, the leading foot landing first and the trailing one coming through after it
      const double d = J.strideD;
      double rAlong, rLift = 0;
      if (J.landT >= 0) {
        rAlong = lead ? std::max(-0.4, 0.13 - d) : std::min(0.4, -0.09 + 1.1 * d);
        if (!lead) rLift = 0.12 * std::sin(PI * clamp(d / 0.45, 0.0, 1.0));
      } else {
        rAlong = lead ? -0.25 + 2.2 * d : 0.05 - d;
        if (lead) rLift = 0.12 * std::sin(PI * clamp(d / 0.35, 0.0, 1.0));
      }
      const double along = clamp(rAlong, -0.55, 0.6) * run;
      V3 fp = root + fwd * along + right * (side * width);
      fp.y = ground(fp.x, fp.z, root.y - airY + 0.4);
      ankle = fp + UP * (R.ankleH + 0.06 * std::max(0.0, J.point) + rLift * run) + fwd * R.footFwd;
      toes = 0.5 * std::max(0.0, J.point);
    }
    solveTwoBone(up, leg, foot, ankle, normalize(fwd + right * (side * 0.1)));
    const Q fq = mul(axisAngle(UP, st.heading + side * 0.08), axisAngle(X_AXIS, toes));
    setWorldQuat(foot, mul(fq, R.footRest[i]));
  }
  // ---- the arms
  relaxShoulders(1);
  const double ascend = air && J.vy > 0 ? 1 - ss(0.4, 2.2, J.vy) : 0;
  for (int i = 0; i < 2; i++) {
    const int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    const double side = i == 0 ? -1 : 1;
    const bool fwdArm = side != J.lead;   // (running: the arm opposite the leading knee drives through)
    V3 sT, rT;   // standing jump, running jump
    if (!air && J.landT < 0) {   // the load
      sT = vlerp(A_REST, A_BACK, ss(0, 0.85, J.wind));
      rT = vlerp(A_REST, fwdArm ? A_RBACK : A_RFWD, 0.5 * ss(0, 0.85, J.wind));   // (the stride's last swing)
    } else if (air) {
      V3 top = J.vy > 0 ? vlerp(A_UP, A_BAL, ascend) : vlerp(A_BAL, A_FALL, fallK);
      sT = vlerp(top, A_LAND, 0.45 * clamp(J.prep, 0.0, 1.0));
      V3 r0 = fwdArm ? A_RFWD : A_RBACK;
      rT = J.vy > 0 ? r0 : vlerp(r0, vlerp(A_BAL, A_FALL, fallK), 0.55 * ss(0, 1, fallK + 0.4 * J.prep));
    } else {   // landed
      const bool early = J.landT < J.hold;
      sT = early ? A_LAND : A_REST;
      rT = early ? A_RLAND : A_REST;
    }
    V3 T = vlerp(sT, rT, run);
    spring(J.arm[i], J.armV[i], T, (air && J.airT < 0.2) || J.wind > 0 ? 18 : 12, dt);
    V3 a = J.arm[i];
    const double len = glm::length(a);
    if (len > 0.97) a = a * (0.97 / len);
    const V3 sh = wpos(arm);
    const double L = R.armLen;
    const V3 tgt = sh + fwd * (a.x * L) + UP * (a.y * L) + right * (side * a.z * L);
    const double upK = ss(-0.3, 0.5, a.y), fwdK = ss(0.1, 0.45, a.x) * (1 - upK);
    // (the elbows back for an arm down or behind, down and out for an arm up, down for a fist driven forward)
    V3 elbow = vlerp(-fwd + right * (side * 0.25) + DOWN * 0.15, right * (side * 0.3) + DOWN * 0.7 - fwd * 0.1, upK);
    elbow = normalize(vlerp(elbow, DOWN + right * (side * 0.35) - fwd * 0.2, fwdK));
    solveTwoBone(arm, fore, hand, tgt, elbow);
    relaxHand(i, normalize(right * (-side) + fwd * (-0.2) + DOWN * (0.3 * upK)), 0.14);
  }
  // ---- the head: the eyes kept level over the torso's lean, looking down to the landing
  rotateWorld(b[RigModel::neck], right, J.pitch * 0.45);
  rotateWorld(b[RigModel::head], right, J.pitch * 0.35 - 0.18 * clamp(J.prep, 0.0, 1.0) - 0.1 * crouchN);
  rotateWorld(b[RigModel::head], UP, st.lookYaw * 0.7 - yawR * 0.5);
  skiPosOk_ = false;
}

} // namespace sl
