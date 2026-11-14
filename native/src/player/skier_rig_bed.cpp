// A patient lying in a hospital bed (src/game/hospitalroom.js bedArms + trunkBottom): after the rig's fall pose (flat
// on the back: pitch -90 deg, which sprawls the limbs out as on the snow and leaves the trunk reclined ~30 deg about
// the hips) everything is placed from the mattress the body lies on: the trunk turned about the hips to a whisker over
// level and set on the mattress by its lowest point (measured once on the rig's skin), the head tipped up a little
// onto the pillow, the wrists on the mattress beside the hips with the elbows out and a touch up, the legs straight
// along the bed within their reach, the heels on the mattress, the toes up.
#include "player/skier_rig.h"
#include <cmath>

namespace sl {
using namespace three;

// How far the lowest point of the lying rig's trunk (its skin on the hips, the spine and the shoulders: the seat and
// the back) is above (+) / below (-) its hips joint, in its pose now.
double SkierRig::trunkBottom() const {
  const RigModel& R = *M_;
  if (R.skinMesh < 0 || R.skinPrim < 0 || R.body->skins.empty()) return std::nan("");
  const Primitive& pr = R.body->meshes[size_t(R.skinMesh)].primitives[size_t(R.skinPrim)];
  if (!pr.cpuVerts) return std::nan("");
  const Skin& sk = R.body->skins[0];
  const int set[] = {R.b[RigModel::hips], R.b[RigModel::spine0], R.b[RigModel::spine1], R.b[RigModel::spine2], R.b[RigModel::lSh], R.b[RigModel::rSh]};
  const size_t n = pr.cpuVerts->size() / 16;
  double lo = 1e300;
  for (size_t i = 0; i < n; i++) {
    const float* q = &(*pr.cpuVerts)[i * 16];
    int bi = -1; float bw = 0;
    for (int k = 0; k < 4; k++) if (q[12 + k] > bw) { bw = q[12 + k]; bi = int(q[8 + k]); }
    if (bi < 0 || size_t(bi) >= sk.joints.size()) continue;
    int node = sk.joints[size_t(bi)];
    bool in = false;
    for (int s : set) if (s == node) in = true;
    if (!in) continue;
    double y = skinnedVertex(i).y;
    if (y < lo) lo = y;
  }
  return lo > 1e299 ? std::nan("") : lo - wpos(R.b[RigModel::hips]).y;
}

void SkierRig::bedPose(double floor) {
  const RigModel& R = *M_;
  const int* b = R.b;
  // (the surface the body rests on: the fall pose's floor less the 2 cm it sinks in)
  const double surf = floor - 0.02;
  {
    V3 hp = wpos(b[RigModel::hips]), u = normalize(wpos(b[RigModel::neck]) - hp), uh(u.x, 0, u.z);
    if (lengthSq(uh) > 1e-6) {
      uh = normalize(uh) * std::cos(0.12) + UP * std::sin(0.12);
      setWorldQuat(b[RigModel::hips], mul(fromUnitVectors(u, uh), wquat(b[RigModel::hips])));
    }
    if (std::isnan(bedBack_)) { bedBack_ = trunkBottom(); if (std::isnan(bedBack_)) bedBack_ = -0.13; }
    hp.y = surf + 0.01 - bedBack_;
    setWorldPos(b[RigModel::hips], hp);
  }
  const V3 hip = wpos(b[RigModel::hips]), ls = wpos(b[RigModel::lArm]), rs = wpos(b[RigModel::rArm]);
  const V3 right = normalize(rs - ls);                       // (the body's right)
  const V3 down = normalize(hip - (ls + rs) * 0.5);           // shoulders -> hips
  V3 front = UP - down * glm::dot(UP, down);
  front = lengthSq(front) < 1e-6 ? V3(0, 1, 0) : normalize(front);
  V3 downH(down.x, 0, down.z);
  downH = lengthSq(downH) < 1e-6 ? V3(0, 0, 1) : normalize(downH);
  // the head tipped up a little (the chin toward the chest), resting on the pillow, looking down along the body
  {
    const V3 ax = normalize(glm::cross(front, down));
    const std::pair<int, double> tip[] = {{b[RigModel::spine2], 0.12}, {b[RigModel::neck], 0.45}};
    for (auto& [bn, a] : tip) if (bn >= 0) setWorldQuat(bn, mul(axisAngle(ax, a), wquat(bn)));
  }
  // the arms by the side: the wrists on the mattress beside the hips (never further than the arm reaches), the elbows
  // out to the side and a little up
  const double side = std::max(0.24, R.hipHalfW + 0.08);
  for (int i = 0; i < 2; i++) {
    const double s = i == 0 ? -1 : 1;
    const int arm = b[i == 0 ? RigModel::lArm : RigModel::rArm], fore = b[i == 0 ? RigModel::lFore : RigModel::rFore], hand = b[i == 0 ? RigModel::lHand : RigModel::rHand];
    if (fore < 0 || hand < 0) continue;
    const V3 sh = wpos(arm);
    const double reach = 0.97 * (glm::distance(sh, wpos(fore)) + glm::distance(wpos(fore), wpos(hand)));
    V3 t = hip + right * (s * side) + downH * 0.02;
    t.y = surf + 0.04;
    V3 d = t - sh;
    const double dy = d.y;
    d.y = 0;
    const double dh = std::sqrt(std::max(0.0, reach * reach - dy * dy));   // (in reach: pulled in toward the shoulder, the height kept)
    if (glm::length(d) > dh) { d = normalize(d) * dh; t = V3(sh.x + d.x, t.y, sh.z + d.z); }
    carTwoBone(arm, fore, hand, t, right * s + front * 0.35);
    // the hand flat on the sheet, the palm down, the fingers toward the feet
    aimHand(i, normalize(downH + right * (s * 0.15)), V3(0, -1, 0));
  }
  // the legs straight out along the bed, side by side: each ankle as far down the bed as the leg reaches (a whisker
  // short of it, so the knee never locks), at the heel's height on the mattress; the knees toward the ceiling; the toes up
  {
    // the turn from standing (the bind frame: the body's left +x, up +y, front +z) to lying
    const Q qf = basisQuat(normalize(glm::cross(front, down)), down * -1.0, front);
    for (int i = 0; i < 2; i++) {
      const double s = i == 0 ? -1 : 1;
      const int up = b[i == 0 ? RigModel::lUp : RigModel::rUp], leg = b[i == 0 ? RigModel::lLeg : RigModel::rLeg], foot = b[i == 0 ? RigModel::lFoot : RigModel::rFoot];
      if (up < 0 || leg < 0 || foot < 0) continue;
      const V3 pu = wpos(up);
      const double reach = 0.985 * (glm::distance(pu, wpos(leg)) + glm::distance(wpos(leg), wpos(foot)));
      const double dy = surf + 0.1 - pu.y, dl = 0.02;   // (the ankle 10 cm over the mattress: the heel and the calf on it; a touch apart)
      const double along = std::sqrt(std::max(0.0, reach * reach - dy * dy - dl * dl));
      V3 t = pu + downH * along + right * (s * dl);
      t.y = surf + 0.1;
      carTwoBone(up, leg, foot, t, front);
      setWorldQuat(foot, mul(qf, R.footRest[i]));
    }
  }
  // the eyes: over the head on the pillow, lifted clear of the chest, looking down the body to the feet (poseBody)
  {
    const V3 h = wpos(b[RigModel::head]), hipP = wpos(b[RigModel::hips]);
    V3 dn(hipP.x - h.x, 0, hipP.z - h.z);
    dn = lengthSq(dn) < 1e-6 ? V3(0, 0, 1) : normalize(dn);   // (head -> feet, level)
    const double chest = b[RigModel::spine2] >= 0 ? wpos(b[RigModel::spine2]).y : h.y;
    bedEye = h + dn * -0.04;
    bedEye.y = std::max(h.y + 0.16, chest + 0.24);
    bedBody = hipP + UP * 0.12;
  }
}

} // namespace sl
