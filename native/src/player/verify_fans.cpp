// `ski_legacy --verify-poses`: the crowd people (player/fans_rig, a port of world/fans.js) against the JavaScript.
// tools/ref_poses.mjs bakes the eight fan_* characters with the game's own FanKit in Node (real three.js) and writes
// fans_ref.json: per character the rest skeleton, the hands' axes and grip, the legs' bind look, the body's heights,
// every keyframe (each bone's rotation + the hips' position), the carry, the jacket's recolour key and the three LOD
// geometries (vertex / index counts, the summed skin weights per bone after the arm rework, the recolour mask, a sample
// of vertices); the village's 56 people as townsfolk.js makes them (characters, sizes, personalities, colours) and
// one person of each character replaying a scripted timeline of pose inputs (standing, walking, stopping, talking, a
// phone, pointing, the watch, hands held / on the hips, the skis on the shoulder), every 0.25 s each bone's
// model-space rotation / position and the carried prop's matrix. Here the same is baked / replayed in C++ and compared
// bone by bone. Pass: under 1 degree everywhere, positions within 5 mm, the same counts, characters and colours.
#include "player/fans_rig.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <fstream>
#include <sstream>

namespace sl {
using namespace three;
using namespace fans;

namespace {
struct Mulberry32 {
  uint32_t a;
  double operator()() {
    a += 0x6d2b79f5u;
    uint32_t t = a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return double(t ^ (t >> 14)) / 4294967296.0;
  }
};
double num(const nlohmann::json& j) { return j.is_number() ? j.get<double>() : std::nan(""); }
V3 v3(const nlohmann::json& a) { return V3(num(a[0]), num(a[1]), num(a[2])); }
Q q4(const float* x) { return Q(x[3], x[0], x[1], x[2]); }
Q q4(const nlohmann::json& a, size_t o = 0) { return Q(num(a[o + 3]), num(a[o]), num(a[o + 1]), num(a[o + 2])); }
bool readBytes(const std::string& path, std::vector<uint8_t>& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return !out.empty();
}
} // namespace

int verifyFans(AssetManager& assets, const std::string& refPath) {
  std::ifstream f(refPath, std::ios::binary);
  if (!f) { SL_ERROR("verify-poses: no fans reference %s (run: node native/tools/ref_poses.mjs)", refPath.c_str()); return 2; }
  std::stringstream ss;
  ss << f.rdbuf();
  auto J = nlohmann::json::parse(ss.str(), nullptr, false);
  if (J.is_discarded()) { SL_ERROR("verify-poses: bad fans JSON"); return 2; }
  bool ok = true;
  // ---- the kits
  std::vector<std::shared_ptr<FanKit>> kits;
  double kfAll = 0, kfPosAll = 0, restAll = 0, geoAll = 0, wAll = 0;
  int countMismatch = 0;
  for (auto& JK : J["kits"]) {
    const std::string name = JK["name"].get<std::string>();
    std::vector<uint8_t> bytes;
    auto kit = std::make_shared<FanKit>();
    if (!readBytes(assets.modelPath(name), bytes) || !kit->build(name, bytes)) { SL_ERROR("verify-poses: %s could not be built", name.c_str()); return 2; }
    kits.push_back(kit);
    const FanKit& k = *kit;
    double rest = 0, restP = 0, kf = 0, kfPos = 0, misc = 0, wsum = 0, geo = 0, nrm = 0, wt = 0;
    int bad = 0;
    std::string kfWhere;
    for (int i = 0; i < NBA; i++) if (k.parent[i] != JK["parent"][size_t(i)].get<int>()) bad++;
    for (int i = 0; i < NBA * 3; i++) restP = std::max({restP, std::fabs(k.P0[size_t(i)] - num(JK["P0"][size_t(i)])) * 1000, std::fabs(k.O[size_t(i)] - num(JK["O"][size_t(i)])) * 1000});
    for (int i = 0; i < NBA; i++) rest = std::max(rest, angleDeg(q4(&k.Q0[size_t(i * 4)]), q4(JK["Q0"], size_t(i * 4))));
    for (int s = 0; s < 2; s++) {
      const auto& h = JK["hand"][size_t(s)];
      if (h.is_null() != !k.hand[s].ok) { bad++; continue; }
      if (h.is_null()) continue;
      misc = std::max({misc, glm::length(k.hand[s].f - v3(h["f"])) * 57.3, glm::length(k.hand[s].n - v3(h["n"])) * 57.3});
      restP = std::max({restP, glm::length(k.hand[s].grip - v3(h["grip"])) * 1000, std::fabs(k.hand[s].len - num(h["len"])) * 1000});
    }
    restP = std::max({restP, glm::length(k.G - v3(JK["G"])) * 1000, glm::length(k.gripLocal - v3(JK["gripLocal"])) * 1000, std::fabs(k.armLen - num(JK["armLen"])) * 1000,
                      std::fabs(k.hipY - num(JK["hipY"])) * 1000, std::fabs(k.headY - num(JK["headY"])) * 1000, std::fabs(k.height - num(JK["height"])) * 1000});
    misc = std::max(misc, std::fabs(k.postureFix - num(JK["postureFix"])) * 57.3);
    for (int l = 0; l < 2; l++) {
      const auto& L = JK["legInfo"][size_t(l)];
      restP = std::max({restP, std::fabs(k.legInfo[l].L - num(L[0])) * 1000, std::fabs(k.legInfo[l].d - num(L[1])) * 1000});
      if (k.legInfo[l].back != (L[2].get<int>() != 0)) bad++;
    }
    double baseD = 0;
    if (JK["base"].is_null() != !k.hasBase) bad++;
    else if (k.hasBase) for (int c = 0; c < 4; c++) baseD = std::max(baseD, std::fabs(k.base[c] - num(JK["base"][size_t(c)])));
    for (int key = 0; key < NK; key++) {
      for (int i = 0; i < NBA; i++) {
        double a = angleDeg(q4(&k.kq[(size_t(key) * NBA + size_t(i)) * 4]), q4(JK["kq"], (size_t(key) * NBA + size_t(i)) * 4));
        if (a > kf) { kf = a; char buf[96]; std::snprintf(buf, sizeof buf, "key %d %s", key, BONE_NAMES[i]); kfWhere = buf; }
      }
      for (int c = 0; c < 3; c++) kfPos = std::max(kfPos, std::fabs(k.kh[size_t(key) * 3 + size_t(c)] - num(JK["kh"][size_t(key) * 3 + size_t(c)])) * 1000);
    }
    if (JK["carryRel"].is_null() == k.hasCarry) bad++;
    else if (k.hasCarry) {
      kf = std::max(kf, angleDeg(q4(k.carryRel.data()), q4(JK["carryRel"])));
      kfPos = std::max(kfPos, glm::length(k.carryAnchor - v3(JK["carryAnchor"])) * 1000);
    }
    // the geometries
    for (int l = 0; l < 3; l++) {
      const auto& JL = JK["lods"][size_t(l)];
      const FanKit::Geo& g = k.geos[l];
      if (g.P.size() / 3 != JL["vertices"].get<size_t>() || g.idx.size() != JL["indices"].get<size_t>()) { countMismatch++; continue; }
      double sum[NB] = {}, mask = 0;
      for (size_t i = 0; i < g.Bn.size() / 4; i++) { for (int c = 0; c < 4; c++) sum[int(g.Bn[i * 4 + size_t(c)])] += g.Wt[i * 4 + size_t(c)]; mask += g.Info[i * 3 + 1]; }
      for (int b = 0; b < NB; b++) wsum = std::max(wsum, std::fabs(sum[b] - num(JL["sum"][size_t(b)])));
      wsum = std::max(wsum, std::fabs(mask - num(JL["mask"])));
      for (auto& S : JL["sample"]) {
        size_t i = S[0].get<size_t>();
        geo = std::max(geo, glm::length(V3(g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]) - v3(S[1])) * 1000);
        nrm = std::max(nrm, glm::length(V3(g.N[i * 3], g.N[i * 3 + 1], g.N[i * 3 + 2]) - v3(S[2])) * 57.3);
        for (int c = 0; c < 4; c++) {
          double jw = num(S[4][size_t(c)]);
          if (jw > 0.02 && int(g.Bn[i * 4 + size_t(c)]) != S[3][size_t(c)].get<int>()) bad++;
          wt = std::max(wt, std::fabs(g.Wt[i * 4 + size_t(c)] - jw));
        }
        for (int c = 0; c < 3; c++) wt = std::max(wt, std::fabs(g.Info[i * 3 + size_t(c)] - num(S[5][size_t(c)])));
      }
    }
    SL_INFO("  %-10s keyframes max %6.3f deg (%s), hips %5.2f mm | rest %6.3f deg %5.2f mm, hands %5.3f deg | weights: sums %.4f, sample %.5f, "
            "positions %.2f mm, normals %.3f deg | jacket key %s %.5f | baked in %.0f ms%s",
            name.c_str(), kf, kfWhere.c_str(), kfPos, rest, restP, misc, wsum, wt, geo, nrm, k.hasBase ? "yes" : "none", baseD, k.bakeMs, bad ? " MISMATCH" : "");
    if (bad || kf >= 1 || kfPos >= 5 || rest >= 1 || restP >= 5 || misc >= 1 || wsum > 0.5 || wt > 0.01 || geo >= 5 || nrm >= 1 || baseD > 1e-4) ok = false;
    kfAll = std::max(kfAll, kf); kfPosAll = std::max(kfPosAll, kfPos); restAll = std::max({restAll, rest, misc}); geoAll = std::max({geoAll, geo, restP}); wAll = std::max({wAll, wt, wsum / 100});
  }
  if (countMismatch) { SL_ERROR("  geometry: %d LODs with other vertex / index counts", countMismatch); ok = false; }

  // ---- the crowds: the village's people (mulberry32(6612)), one of each character (mulberry32(99))
  auto crowdCheck = [&](const nlohmann::json& JP, FanCrowd& c, const char* what) {
    int diff = 0;
    double d = 0;
    for (int i = 0; i < c.n && size_t(i) < JP.size(); i++) {
      const auto& P = JP[size_t(i)];
      if (c.kit[size_t(i)] != P["kit"].get<int>() || c.calm[size_t(i)] != P["calm"].get<int>() || c.style[size_t(i)] != P["style"].get<int>() ||
          c.jumper[size_t(i)] != P["jumper"].get<int>()) diff++;
      d = std::max({d, std::fabs(c.scl[size_t(i) * 2] - num(P["scl"][0])), std::fabs(c.scl[size_t(i) * 2 + 1] - num(P["scl"][1])), std::fabs(c.energy[size_t(i)] - num(P["energy"])),
                    std::fabs(c.phase[size_t(i)] - num(P["phase"])), std::fabs(c.rate[size_t(i)] - num(P["rate"])), std::fabs(c.lookY[size_t(i)] - num(P["lookY"]))});
      for (int k = 0; k < 8; k++) d = std::max(d, std::fabs(c.palC[size_t(i) * 8 + size_t(k)] - num(P["pal"][size_t(k)])));
    }
    SL_INFO("  crowd %-8s %d people: %d with another character / calm pose / style, sizes / personalities / colours max diff %.2g", what, c.n, diff, d);
    if (diff || d > 1e-5) ok = false;
  };
  Mulberry32 rv{6612};
  FanCrowd village;
  village.init(kits, 56, [&]() { return rv(); });
  crowdCheck(J["village"], village, "village");
  Mulberry32 r8{99};
  FanCrowd crowd;
  crowd.init(kits, 8, [&]() { return r8(); }, {0, 1, 2, 3, 4, 5, 6, 7});
  crowd.calm[2] = HOLD; crowd.calm[3] = POCKET; crowd.calm[4] = 0;
  crowdCheck(J["crowd"], crowd, "people");

  // ---- the posed timelines
  double tlAll = 0, tlPosAll = 0, propAll = 0, lookAll = 0;
  for (auto& T : J["timelines"]) {
    const int i = T["person"].get<int>();
    const size_t u = size_t(i);
    crowd.lookY[u] = 0; crowd.lookP[u] = 0;
    size_t si = 0;
    const auto& S = T["samples"];
    double worst = 0, worstPos = 0, worstProp = 0, worstLook = 0;
    std::string where;
    for (size_t fi = 0; fi < T["frames"].size() && si < S.size(); fi++) {
      const auto& F = T["frames"][fi];
      crowd.D.walk[u] = float(num(F[2])); crowd.D.wph[u] = float(num(F[3])); crowd.D.talk[u] = float(num(F[4])); crowd.D.hold[u] = uint8_t(F[5].get<int>());
      crowd.D.holdW[u] = float(num(F[6])); crowd.D.carry[u] = uint8_t(F[7].get<int>()); crowd.D.lookY[u] = float(num(F[8])); crowd.D.lookP[u] = float(num(F[9]));
      crowd.poseDyn(i, num(F[0]), num(F[1]));
      if (S[si]["frame"].get<size_t>() != fi) continue;
      const auto& s = S[si++];
      for (int b = 0; b < NBA; b++) {
        double a = angleDeg(q4(&crowd.W[b * 4]), q4(s["W"], size_t(b * 4)));
        if (a > worst) { worst = a; char buf[96]; std::snprintf(buf, sizeof buf, "%s at %.2f s", BONE_NAMES[b], num(F[0])); where = buf; }
        worstPos = std::max(worstPos, glm::length(V3(crowd.Pw[b * 3], crowd.Pw[b * 3 + 1], crowd.Pw[b * 3 + 2]) - V3(num(s["P"][size_t(b * 3)]), num(s["P"][size_t(b * 3 + 1)]), num(s["P"][size_t(b * 3 + 2)]))) * 1000);
      }
      const float* pr = crowd.row(i) + PROP * 12;
      for (int c = 0; c < 12; c++) worstProp = std::max(worstProp, std::fabs(pr[c] - num(s["prop"][size_t(c)])) * ((c % 4) == 3 ? 1000 : 57.3));
      worstLook = std::max({worstLook, std::fabs(crowd.lookY[u] - num(s["look"][0])) * 57.3, std::fabs(crowd.lookP[u] - num(s["look"][1])) * 57.3});
    }
    SL_INFO("  person %d (%-10s) bones max %6.3f deg (%s), pos %5.2f mm | carried skis %6.3f (deg / mm) | head look %.4f deg", i, kits[crowd.kit[u]]->name.c_str(), worst,
            where.c_str(), worstPos, worstProp, worstLook);
    tlAll = std::max(tlAll, worst); tlPosAll = std::max(tlPosAll, worstPos); propAll = std::max(propAll, worstProp); lookAll = std::max(lookAll, worstLook);
  }
  if (tlAll >= 1 || tlPosAll >= 5 || propAll >= 5 || lookAll >= 1 || J["timelines"].size() != 8) ok = false;
  SL_INFO("verify-poses: fans: keyframes max %.3f deg, %.2f mm; rest / hands %.3f deg, %.2f mm; weights %.5f; posed people max %.3f deg, %.2f mm, "
          "carried skis %.3f, head look %.4f deg -> %s", kfAll, kfPosAll, restAll, geoAll, wAll, tlAll, tlPosAll, propAll, lookAll, ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}

} // namespace sl
