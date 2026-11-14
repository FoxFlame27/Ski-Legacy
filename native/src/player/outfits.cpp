// outfits.js, ported (see outfits.h). Float32Array storage in the JS is mirrored with float here where it changes
// the numbers (the clustering's samples and centres, the region fractions), so the zones come out as the JS's.
#include "player/outfits.h"
#include "core/log.h"
#include "player/skier_rig.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <unordered_map>

namespace sl {
using three::V3;

namespace {
// ---------------------------------------------------------------- colour math (OKLab)
double srgbToLin(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
double linToSrgb(double c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1 / 2.4) - 0.055; }
struct Lut { float v[256]; Lut() { for (int i = 0; i < 256; i++) v[i] = float(srgbToLin(i / 255.0)); } };
const Lut SRGB_LUT;
void linToLab(double r, double g, double b, double out[3]) {
  double l = std::cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  double m = std::cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  double s = std::cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}
void labToLin(double L, double a, double b, double out[3]) {
  double l = std::pow(L + 0.3963377774 * a + 0.2158037573 * b, 3), m = std::pow(L - 0.1055613458 * a - 0.0638541728 * b, 3),
         s = std::pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}
void hexToLab(uint32_t v, double out[3]) { linToLab(SRGB_LUT.v[(v >> 16) & 255], SRGB_LUT.v[(v >> 8) & 255], SRGB_LUT.v[v & 255], out); }
constexpr double WL = 0.42;

// ---------------------------------------------------------------- body parts
enum { G_HEAD, G_NECK, G_TORSO, G_ARM, G_HAND, G_HIPS, G_LEG, G_FOOT, NG };
int boneGroup(std::string n) {
  for (auto& c : n) c = char(std::tolower(unsigned(c)));
  auto has = [&](const char* k) { return n.find(k) != std::string::npos; };
  if (has("hand") || has("thumb") || has("index") || has("middle") || has("ring") || has("pinky") || has("finger")) return G_HAND;
  if (has("foot") || has("toe")) return G_FOOT;
  if (has("head")) return G_HEAD;
  if (has("neck")) return G_NECK;
  if (has("forearm") || has("arm")) return G_ARM;
  if (has("upleg") || has("leg") || has("thigh") || has("knee") || has("calf") || has("shin")) return G_LEG;
  if (has("hips") || has("pelvis")) return G_HIPS;
  return G_TORSO;
}
constexpr int MAX_CLUSTERS = 12;

struct Rng { uint32_t s; double operator()() { s = s * 1664525u + 1013904223u; return double(s) / 4294967296.0; } };

struct Px { const uint8_t* d; int w, h; };
void sampleLin(const Px& px, double u, double v, double out[3]) {
  const int W = px.w, H = px.h;
  double x = std::min(W - 1.001, std::max(0.0, (u - std::floor(u)) * W - 0.5)), y = std::min(H - 1.001, std::max(0.0, (v - std::floor(v)) * H - 0.5));
  int x0 = int(x), y0 = int(y);
  double fx = x - x0, fy = y - y0;
  size_t i00 = (size_t(y0) * W + x0) * 4, i10 = i00 + 4, i01 = i00 + size_t(W) * 4, i11 = i01 + 4;
  for (int c = 0; c < 3; c++) {
    double a = double(SRGB_LUT.v[px.d[i00 + c]]) * (1 - fx) + double(SRGB_LUT.v[px.d[i10 + c]]) * fx;
    double b = double(SRGB_LUT.v[px.d[i01 + c]]) * (1 - fx) + double(SRGB_LUT.v[px.d[i11 + c]]) * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

struct KM { std::vector<float> C; double inertia = 0; };
KM kmeans(const std::vector<float>& Q, int n, int K, int iters, uint32_t seed) {
  Rng r{seed};
  KM km;
  km.C.assign(size_t(K) * 3, 0.f);
  std::vector<float> d2(size_t(n), INFINITY);
  int pick = int(std::floor(r() * n));
  for (int k = 0; k < K; k++) {
    km.C[size_t(k) * 3] = Q[size_t(pick) * 3]; km.C[size_t(k) * 3 + 1] = Q[size_t(pick) * 3 + 1]; km.C[size_t(k) * 3 + 2] = Q[size_t(pick) * 3 + 2];
    double sum = 0;
    for (int i = 0; i < n; i++) {
      double dx = double(Q[size_t(i) * 3]) - km.C[size_t(k) * 3], dy = double(Q[size_t(i) * 3 + 1]) - km.C[size_t(k) * 3 + 1], dz = double(Q[size_t(i) * 3 + 2]) - km.C[size_t(k) * 3 + 2];
      d2[size_t(i)] = float(std::min(double(d2[size_t(i)]), dx * dx + dy * dy + dz * dz));
      sum += d2[size_t(i)];
    }
    double t = r() * sum;
    pick = n - 1;
    for (int i = 0; i < n; i++) { t -= d2[size_t(i)]; if (t <= 0) { pick = i; break; } }
  }
  std::vector<double> S(size_t(K) * 4);
  for (int it = 0; it <= iters; it++) {
    std::fill(S.begin(), S.end(), 0.0);
    km.inertia = 0;
    for (int i = 0; i < n; i++) {
      int best = 0;
      double bd = INFINITY;
      for (int k = 0; k < K; k++) {
        double dx = double(Q[size_t(i) * 3]) - km.C[size_t(k) * 3], dy = double(Q[size_t(i) * 3 + 1]) - km.C[size_t(k) * 3 + 1], dz = double(Q[size_t(i) * 3 + 2]) - km.C[size_t(k) * 3 + 2];
        double dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) { bd = dd; best = k; }
      }
      km.inertia += bd;
      S[size_t(best) * 4] += Q[size_t(i) * 3]; S[size_t(best) * 4 + 1] += Q[size_t(i) * 3 + 1]; S[size_t(best) * 4 + 2] += Q[size_t(i) * 3 + 2]; S[size_t(best) * 4 + 3]++;
    }
    if (it == iters) break;
    for (int k = 0; k < K; k++) {
      if (S[size_t(k) * 4 + 3] == 0) continue;
      for (int c = 0; c < 3; c++) km.C[size_t(k) * 3 + size_t(c)] = float(S[size_t(k) * 4 + size_t(c)] / S[size_t(k) * 4 + 3]);
    }
  }
  return km;
}
int nearest(const std::vector<float>& C, int K, const double q[3]) {
  int best = 0;
  double bd = INFINITY;
  for (int k = 0; k < K; k++) {
    double dx = q[0] - C[size_t(k) * 3], dy = q[1] - C[size_t(k) * 3 + 1], dz = q[2] - C[size_t(k) * 3 + 2];
    double dd = dx * dx + dy * dy + dz * dz;
    if (dd < bd) { bd = dd; best = k; }
  }
  return best;
}

// an insertion-ordered set of cluster ids (JS Set)
struct ISet {
  std::vector<int> v;
  bool has(int k) const { return std::find(v.begin(), v.end(), k) != v.end(); }
  void add(int k) { if (!has(k)) v.push_back(k); }
  size_t size() const { return v.size(); }
};
} // namespace

// ---------------------------------------------------------------- the zones
struct OutfitZones {
  int K = 0;
  std::vector<float> C, rad;
  std::vector<std::array<double, 4>> mean;
  double yWaist = 0, yNeck = 0;
  bool hasLens = false;
  struct { double x0, x1, y0, y1, z0; } lensBox{};
  std::vector<int> J1, J2, T1, T2, H, L, specJ, specT, blend;
  double ref[6][4] = {};
  bool has[6] = {};
  // per vertex: ofZone (jacket, trousers, helmet) 0 / 255, ofPos (bind-pose position)
  std::vector<uint8_t> zone;
  std::vector<float> pos;
};

namespace {
std::shared_ptr<OutfitZones> analyze(const RigModel& rig) {
  const Model& md = *rig.body;
  if (rig.skinPrim < 0 || md.skins.empty()) return nullptr;
  const Primitive& prim = md.meshes[size_t(rig.skinMesh)].primitives[size_t(rig.skinPrim)];
  if (!prim.cpuVerts || !prim.cpuIdx) return nullptr;
  const Material& mat = md.materials[size_t(std::max(0, prim.material))];
  if (mat.baseImage < 0 || size_t(mat.baseImage) >= md.images.size() || !md.images[size_t(mat.baseImage)]) return nullptr;
  const CpuImage& img = *md.images[size_t(mat.baseImage)];
  // readPixels: box-filtered to 512 x 512
  const int SZ = 512;
  std::vector<uint8_t> pxd(size_t(SZ) * SZ * 4);
  {
    double fx = double(img.w) / SZ, fy = double(img.h) / SZ;
    for (int y = 0; y < SZ; y++) {
      int y0 = int(std::floor(y * fy)), y1 = std::max(y0 + 1, int(std::floor((y + 1) * fy)));
      for (int x = 0; x < SZ; x++) {
        int x0 = int(std::floor(x * fx)), x1 = std::max(x0 + 1, int(std::floor((x + 1) * fx)));
        double r = 0, g = 0, b = 0;
        for (int yy = y0; yy < y1; yy++) for (int xx = x0; xx < x1; xx++) { const uint8_t* k = &img.rgba[(size_t(yy) * img.w + xx) * 4]; r += k[0]; g += k[1]; b += k[2]; }
        double n = double((y1 - y0) * (x1 - x0));
        uint8_t* o = &pxd[(size_t(y) * SZ + x) * 4];
        o[0] = uint8_t(std::lround(r / n)); o[1] = uint8_t(std::lround(g / n)); o[2] = uint8_t(std::lround(b / n)); o[3] = 255;
      }
    }
  }
  Px px{pxd.data(), SZ, SZ};
  // rest pose: skinning matrices and joints (relative to the root)
  const Skin& sk = md.skins[0];
  size_t nn = md.nodes.size();
  std::vector<glm::dmat4> Wn(nn);
  for (size_t i = 0; i < nn; i++) {
    const Node& n = md.nodes[i];
    glm::dmat4 Lm = three::compose(V3(n.t), three::Q(n.r.w, n.r.x, n.r.y, n.r.z), V3(n.s));
    Wn[i] = n.parent >= 0 ? Wn[size_t(n.parent)] * Lm : Lm;
  }
  std::vector<glm::dmat4> B(sk.joints.size());
  std::vector<int> groups(sk.joints.size());
  for (size_t j = 0; j < sk.joints.size(); j++) { B[j] = Wn[size_t(sk.joints[j])] * glm::dmat4(sk.inverseBind[j]); groups[j] = boneGroup(md.nodes[size_t(sk.joints[j])].name); }
  auto jointY = [&](const char* name, double& out) { int n = md.findNode(name); if (n < 0) return false; out = Wn[size_t(n)][3].y; return true; };
  const std::vector<float>& V = *prim.cpuVerts;
  const std::vector<uint32_t>& tri = *prim.cpuIdx;
  const size_t N = V.size() / 16;
  // bindData
  std::vector<float> P(N * 3), GW(N * NG, 0.f);
  for (size_t i = 0; i < N; i++) {
    const float* q = &V[i * 16];
    V3 v(q[0], q[1], q[2]), o(0);
    double gw[NG] = {};
    for (int k = 0; k < 4; k++) {
      double w = q[12 + k];
      if (!w) continue;
      size_t j = size_t(q[8 + k]);
      o += three::mulPoint(B[j], v) * w;
      gw[groups[j]] += w;
    }
    P[i * 3] = float(o.x); P[i * 3 + 1] = float(o.y); P[i * 3 + 2] = float(o.z);
    for (int g = 0; g < NG; g++) GW[i * NG + size_t(g)] = float(gw[g]);
  }
  const size_t T = tri.size() / 3;
  double yTop = -INFINITY;
  for (size_t i = 0; i < N; i++) yTop = std::max(yTop, double(P[i * 3 + 1]));
  double yHips = yTop * 0.54, yHead = yTop * 0.85, zHead = 0, tmp;
  if (jointY("Hips", tmp)) yHips = tmp;
  if (jointY("Head", tmp)) yHead = tmp;
  { int n = md.findNode("Head"); if (n >= 0) zHead = Wn[size_t(n)][3].z; }
  (void)zHead;
  // ---- area-weighted surface samples
  std::vector<float> area(T);
  double total = 0;
  for (size_t t = 0; t < T; t++) {
    size_t a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    double ux = double(P[b]) - P[a], uy = double(P[b + 1]) - P[a + 1], uz = double(P[b + 2]) - P[a + 2];
    double vx = double(P[c]) - P[a], vy = double(P[c + 1]) - P[a + 1], vz = double(P[c + 2]) - P[a + 2];
    double cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area[t] = float(0.5 * std::sqrt(cx * cx + cy * cy + cz * cz));
    total += area[t];
  }
  Rng r{777};
  const double samples = 60000, per = samples / total;
  std::vector<uint8_t> perTri(T);
  size_t S = 0;
  for (size_t t = 0; t < T; t++) {
    double head = P[tri[t * 3] * 3 + 1] > yHead - 0.06 ? 3 : 1;
    perTri[t] = uint8_t(std::min(255.0, std::floor(area[t] * per * head + r())));
    S += perTri[t];
  }
  std::vector<float> Qs(S * 3), SL(S * 3), SP(S * 3), SG(S * NG);
  double lin[3], lab[3];
  for (size_t t = 0, i = 0; t < T; t++) {
    size_t ia = tri[t * 3], ib = tri[t * 3 + 1], ic = tri[t * 3 + 2];
    double ua = V[ia * 16 + 6], ub = V[ib * 16 + 6], uc = V[ic * 16 + 6], va = V[ia * 16 + 7], vb = V[ib * 16 + 7], vc = V[ic * 16 + 7];
    for (int n = perTri[t]; n > 0; n--, i++) {
      double s1 = r(), s2 = r();
      if (s1 + s2 > 1) { s1 = 1 - s1; s2 = 1 - s2; }
      double w0 = 1 - s1 - s2;
      sampleLin(px, ua * w0 + ub * s1 + uc * s2, va * w0 + vb * s1 + vc * s2, lin);
      linToLab(lin[0], lin[1], lin[2], lab);
      Qs[i * 3] = float(lab[0] * WL); Qs[i * 3 + 1] = float(lab[1]); Qs[i * 3 + 2] = float(lab[2]);
      SL[i * 3] = float(lab[0]); SL[i * 3 + 1] = float(lab[1]); SL[i * 3 + 2] = float(lab[2]);
      for (int k = 0; k < 3; k++) SP[i * 3 + size_t(k)] = float(double(P[ia * 3 + size_t(k)]) * w0 + double(P[ib * 3 + size_t(k)]) * s1 + double(P[ic * 3 + size_t(k)]) * s2);
      for (int k = 0; k < NG; k++) SG[i * NG + size_t(k)] = float(double(GW[ia * NG + size_t(k)]) * w0 + double(GW[ib * NG + size_t(k)]) * s1 + double(GW[ic * NG + size_t(k)]) * s2);
    }
  }
  const int K = 10;
  size_t stride = std::max<size_t>(1, size_t(std::floor(double(S) / 16000)));
  std::vector<float> sub;
  int ns = 0;
  for (size_t i = 0; i < S; i += stride, ns++) { sub.push_back(Qs[i * 3]); sub.push_back(Qs[i * 3 + 1]); sub.push_back(Qs[i * 3 + 2]); }
  std::vector<float> C;
  double bestI = INFINITY;
  for (uint32_t seed : {12345u, 777u, 4242u}) {
    KM km = kmeans(sub, ns, K, 10, seed);
    if (km.inertia < bestI) { bestI = km.inertia; C = km.C; }
  }
  std::vector<int16_t> cl(S);
  for (size_t i = 0; i < S; i++) { double q[3] = {Qs[i * 3], Qs[i * 3 + 1], Qs[i * 3 + 2]}; cl[i] = int16_t(nearest(C, K, q)); }
  // ---- per-cluster stats per region
  double yKnee, yl = yHips * 0.55, yr = 0;
  jointY("LeftLeg", yl); jointY("RightLeg", yr);
  yKnee = std::max(yl, yr);
  std::vector<int8_t> part(S, 0);
  for (size_t i = 0; i < S; i++) {
    double y = SP[i * 3 + 1];
    auto gw = [&](int k) { return SG[i * NG + size_t(k)]; };
    if (gw(G_HAND) > 0.5) part[i] = 4;
    else if (gw(G_FOOT) > 0.5) part[i] = 5;
    else if (y > yTop - 0.07) part[i] = 6;
    else if (y > yHead + 0.02) part[i] = 3;
    else if (gw(G_ARM) > 0.5 || (y > yHips + 0.06 && y < yHead - 0.04)) part[i] = 1;
    else if (gw(G_LEG) > 0.5 && y < yHips - 0.08) part[i] = 2;
  }
  const int NP = 7;
  std::vector<std::vector<float>> frac(NP, std::vector<float>(K, 0.f));
  std::vector<float> cnt(NP, 0.f);
  std::vector<std::array<double, 4>> mean(K, {0, 0, 0, 0});
  for (size_t i = 0; i < S; i++) {
    frac[size_t(part[i])][size_t(cl[i])]++; cnt[size_t(part[i])]++;
    auto& m = mean[size_t(cl[i])]; m[0] += SL[i * 3]; m[1] += SL[i * 3 + 1]; m[2] += SL[i * 3 + 2]; m[3]++;
  }
  for (int p = 0; p < NP; p++) for (int k = 0; k < K; k++) frac[size_t(p)][size_t(k)] = float(double(frac[size_t(p)][size_t(k)]) / std::max(1.0, double(cnt[size_t(p)])));
  for (auto& m : mean) if (m[3] != 0) { m[0] /= m[3]; m[1] /= m[3]; m[2] /= m[3]; }
  auto chroma = [&](int k) { return std::hypot(mean[size_t(k)][1], mean[size_t(k)][2]); };
  auto dist = [&](int a, int b) { return std::sqrt(std::pow(double(C[size_t(a) * 3]) - C[size_t(b) * 3], 2) + std::pow(double(C[size_t(a) * 3 + 1]) - C[size_t(b) * 3 + 1], 2) + std::pow(double(C[size_t(a) * 3 + 2]) - C[size_t(b) * 3 + 2], 2)); };
  ISet skin;
  for (int k = 0; k < K; k++) {
    double L = mean[size_t(k)][0], a = mean[size_t(k)][1], b = mean[size_t(k)][2], h = std::atan2(b, a) * 180 / PI, c = chroma(k);
    double onHead = frac[3][size_t(k)] + double(frac[6][size_t(k)]) * 0.5, onBody = double(frac[1][size_t(k)]) + frac[2][size_t(k)];
    if (L > 0.5 && L < 0.9 && c > 0.035 && c < 0.12 && h > 18 && h < 80 && onHead > onBody * 2) skin.add(k);
  }
  auto neutral = [&](int k) { return chroma(k) < 0.03; };
  auto darkNeutral = [&](int k) { return mean[size_t(k)][0] < 0.33 && chroma(k) < 0.02; };
  auto hueGap = [&](int a, int b) { double d = std::fabs(std::atan2(mean[size_t(a)][2], mean[size_t(a)][1]) - std::atan2(mean[size_t(b)][2], mean[size_t(b)][1])); return std::min(d, PI * 2 - d); };
  const double MERGE = 0.06;
  auto cl2 = [&](int k) { return chroma(k) / std::max(mean[size_t(k)][0], 0.05); };
  auto shadeOf = [&](int k, int seed, double loose) {
    if (neutral(k) || neutral(seed)) return neutral(k) && neutral(seed) && std::min(mean[size_t(k)][0], mean[size_t(seed)][0]) >= std::max(mean[size_t(k)][0], mean[size_t(seed)][0]) * 0.7 / loose;
    double ratio = cl2(k) / cl2(seed);
    return hueGap(k, seed) < 0.35 * loose && ratio > 0.65 / loose && ratio < 1.55 * loose;
  };
  auto grow = [&](int seed, const std::vector<int>& pool, const ISet& taken, const std::vector<float>& f, double rr) {
    ISet set;
    set.add(seed);
    bool added = true;
    while (added) {
      added = false;
      for (int k : pool) {
        if (set.has(k) || taken.has(k) || f[size_t(k)] < 0.01f) continue;
        bool ok = shadeOf(k, seed, 1);
        if (!ok && shadeOf(k, seed, 1.3)) for (int m : set.v) if (dist(k, m) < rr) { ok = true; break; }
        if (ok) { set.add(k); added = true; }
      }
    }
    return set;
  };
  auto orderOf = [&](const std::vector<float>& f) {
    std::vector<int> o;
    for (int k = 0; k < K; k++) if (!skin.has(k)) o.push_back(k);
    std::stable_sort(o.begin(), o.end(), [&](int a, int b) { return f[size_t(b)] < f[size_t(a)]; });
    return o;
  };
  auto base = [&](int p) {
    const auto& f = frac[size_t(p)];
    std::vector<int> order = orderOf(f);
    if (order.empty() || f[size_t(order[0])] < 0.12f) return ISet{};
    return grow(order[0], order, ISet{}, f, MERGE);
  };
  auto accent = [&](int p, ISet& P1, const ISet& other) {
    const auto& f = frac[size_t(p)];
    std::vector<int> order = orderOf(f);
    if (P1.v.empty()) return ISet{};
    int primary = P1.v[0];
    bool hardware = chroma(primary) > 0.05 || mean[size_t(primary)][0] < 0.4;
    auto pureBlack = [&](int k) { return mean[size_t(k)][0] < 0.27 && chroma(k) < 0.012; };
    std::vector<int> cand;
    for (int k : order)
      if (!P1.has(k) && !other.has(k) && !(pureBlack(k) && hardware) && !(p == 2 && frac[5][size_t(k)] >= 0.25f && f[size_t(k)] < 0.2f)
          && !(chroma(k) >= 0.05 && !neutral(primary) && hueGap(k, primary) < 0.45) && (f[size_t(k)] >= 0.06f || (f[size_t(k)] >= 0.015f && chroma(k) >= 0.08)))
        cand.push_back(k);
    if (cand.empty()) return ISet{};
    ISet taken = P1;
    for (int k : other.v) taken.add(k);
    ISet P2 = grow(cand[0], order, taken, f, MERGE);
    if (neutral(primary) && neutral(cand[0])) {
      for (int k : order) {
        if (P1.has(k) || P2.has(k) || f[size_t(k)] < 0.01f || !neutral(k)) continue;
        double L = mean[size_t(k)][0], L1 = mean[size_t(primary)][0], L2 = mean[size_t(cand[0])][0];
        if ((L - L1) * (L - L2) <= 0) (std::fabs(L - L1) <= std::fabs(L - L2) ? P1 : P2).add(k);
      }
    }
    return P2;
  };
  auto minus = [](const ISet& a, const ISet& b) { ISet o; for (int k : a.v) if (!b.has(k)) o.add(k); return o; };
  ISet J1 = base(1), T1 = base(2);
  ISet J2 = accent(1, J1, minus(T1, J1)), T2 = accent(2, T1, minus(J1, T1));
  // helmet: the crown's colour and its darker / lighter folds anywhere on the head
  ISet H0 = base(6);
  ISet garmentOnly;
  for (int k : J1.v) if (frac[6][size_t(k)] < 0.05f) garmentOnly.add(k);
  for (int k : T1.v) if (frac[6][size_t(k)] < 0.05f) garmentOnly.add(k);
  ISet helmet;
  if (H0.size()) {
    std::vector<int> pool;
    for (int k = 0; k < K; k++) if (!skin.has(k) && !garmentOnly.has(k) && double(frac[3][size_t(k)]) + frac[6][size_t(k)] >= 0.03) pool.push_back(k);
    std::vector<float> f36(K);
    for (int k = 0; k < K; k++) f36[size_t(k)] = frac[3][size_t(k)] + frac[6][size_t(k)];
    helmet = grow(H0.v[0], pool, ISet{}, f36, 0.08);
  }
  if (helmet.size())
    for (int k = 0; k < K; k++) {
      if (helmet.has(k) || skin.has(k) || darkNeutral(k) || garmentOnly.has(k)) continue;
      if (frac[6][size_t(k)] >= 0.08f) helmet.v.push_back(k);
    }
  // goggle lens, found in a front view of the head
  double zFront = -INFINITY;
  for (size_t i = 0; i < S; i++) if (SP[i * 3 + 1] > yHead + 0.03 && part[i] != 4) zFront = std::max(zFront, double(SP[i * 3 + 2]));
  const double FC = 0.006, gy0 = yHead - 0.04, hScale = yTop / 1.78;
  const int GX = 40, GY = int(std::ceil((yTop - gy0) / FC)) + 1;
  std::vector<float> fz(size_t(GX) * GY, -INFINITY);
  std::vector<int16_t> fk(size_t(GX) * GY, -1);
  for (size_t i = 0; i < S; i++) {
    double x = SP[i * 3], y = SP[i * 3 + 1], zz = SP[i * 3 + 2];
    if (y < gy0 || std::fabs(x) >= 0.12 || part[i] == 4 || zz < zFront - 0.09) continue;
    size_t c = size_t(std::floor((x + 0.12) / FC) + std::floor((y - gy0) / FC) * GX);
    if (zz > fz[c]) { fz[c] = float(zz); fk[c] = cl[i]; }
  }
  std::vector<float> fc(K, 0.f);
  double fn = 0;
  for (size_t c = 0; c < fk.size(); c++) { if (fk[c] < 0) continue; fc[size_t(fk[c])]++; fn++; }
  for (int k = 0; k < K; k++) fc[size_t(k)] = float(double(fc[size_t(k)]) / std::max(1.0, fn));
  ISet hSet;
  for (int k : helmet.v) hSet.add(k);
  std::vector<int> lensPool;
  for (int k = 0; k < K; k++) if (!hSet.has(k) && mean[size_t(k)][0] > 0.25 && mean[size_t(k)][0] < 0.97 && !darkNeutral(k) && fc[size_t(k)] > 0.005f) lensPool.push_back(k);
  std::vector<float> rowAll(size_t(GY), 0.f);
  for (size_t c = 0; c < fk.size(); c++) if (fk[c] >= 0) rowAll[c / GX]++;
  std::vector<int> lens;
  double best = 0, lensY = 0;
  int lensLo = 0, lensHi = 0;
  bool haveRows = false;
  std::vector<std::string> seen;
  for (int k : lensPool) {
    ISet famS = grow(k, lensPool, ISet{}, fc, 0.12);
    std::vector<int> fam = famS.v;
    std::sort(fam.begin(), fam.end());
    std::string key;
    for (int m : fam) key += std::to_string(m) + ",";
    if (std::find(seen.begin(), seen.end(), key) != seen.end()) continue;
    seen.push_back(key);
    std::vector<uint8_t> inFam(K, 0);
    for (int m : fam) inFam[size_t(m)] = 1;
    std::vector<float> rowF(size_t(GY), 0.f);
    for (size_t c = 0; c < fk.size(); c++) if (fk[c] >= 0 && inFam[size_t(fk[c])]) rowF[c / GX]++;
    auto share = [&](int rr) { return rowAll[size_t(rr)] > 3 ? double(rowF[size_t(rr)]) / rowAll[size_t(rr)] : 0.0; };
    for (int hw : {8, 10, 12}) {
      for (int r0 = 0; r0 + hw <= GY; r0++) {
        double yc = gy0 + (r0 + hw / 2.0) * FC;
        if (yc < yTop - 0.19 * hScale || yc > yTop - 0.12 * hScale) continue;
        double nF = 0, nS = 0, nA = 0, zs = 0, xMin = 1, xMax = -1;
        for (int rr = r0; rr < r0 + hw; rr++) for (int cx = 0; cx < GX; cx++) {
          int kk = fk[size_t(rr) * GX + size_t(cx)];
          if (kk < 0) continue;
          nA++;
          if (!inFam[size_t(kk)]) continue;
          nF++; zs += fz[size_t(rr) * GX + size_t(cx)];
          if (skin.has(kk)) nS++;
          double x = -0.12 + (cx + 0.5) * FC; xMin = std::min(xMin, x); xMax = std::max(xMax, x);
        }
        if (nF - nS < 20 || nF - nS < nA * 0.12 || xMax - xMin < 0.07 || zs / nF < zFront - 0.07) continue;
        double mc = 0;
        for (int m : fam) mc = std::max(mc, chroma(m));
        double score = (nF / nA) * (0.6 + std::min(1.0, mc * 6));
        if (score > best * 1.001) {
          best = score; lens = fam;
          int lo = r0, hi = r0 + hw - 1;
          while (hi - lo + 1 < 17) {
            bool up = hi + 1 < GY && share(hi + 1) >= 0.15, dn = lo > 0 && share(lo - 1) >= 0.15;
            if (!up && !dn) break;
            if (up) hi++;
            if (dn && hi - lo + 1 < 17) lo--;
          }
          lensLo = lo; lensHi = hi; haveRows = true; lensY = gy0 + (lo + hi + 1) * FC / 2;
        }
      }
    }
  }
  (void)lensY;
  auto inL = [&](int k) { return std::find(lens.begin(), lens.end(), k) != lens.end(); };
  if (!lens.empty() && haveRows) {
    std::vector<double> inBand(K, 0);
    double nb = 0;
    for (int rr = lensLo; rr <= lensHi; rr++) for (int cx = 0; cx < GX; cx++) { int kk = fk[size_t(rr) * GX + size_t(cx)]; if (kk >= 0) { inBand[size_t(kk)]++; nb++; } }
    std::vector<int> l2;
    for (int k : lens) if (!skin.has(k) || inBand[size_t(k)] >= nb * 0.25) l2.push_back(k);
    lens = l2;
    int seed = lens.empty() ? -1 : lens[0];
    for (int k : lens) if (!skin.has(k)) { seed = k; break; }
    if (seed >= 0)
      for (int k : lensPool) if (!inL(k) && !skin.has(k) && inBand[size_t(k)] >= nb * 0.05 && (chroma(k) >= 0.04 || shadeOf(k, seed, 1.5))) lens.push_back(k);
    for (int k : hSet.v) if (!inL(k) && inBand[size_t(k)] >= nb * 0.25) lens.push_back(k);
    double a = 0, b2 = 0;
    for (int k : lens) { a += inBand[size_t(k)]; b2 += skin.has(k) ? 0 : inBand[size_t(k)]; }
    if (a < nb * 0.28 || b2 < nb * 0.15) lens.clear();
  }
  auto Z = std::make_shared<OutfitZones>();
  if (!lens.empty()) {
    double x1 = 0, z0 = INFINITY;
    for (int rr = lensLo; rr <= lensHi; rr++) for (int cx = 0; cx < GX; cx++) {
      size_t c = size_t(rr) * GX + size_t(cx);
      if (!inL(fk[c])) continue;
      x1 = std::max(x1, std::fabs(-0.12 + (cx + 0.5) * FC));
      z0 = std::min(z0, double(fz[c]));
    }
    Z->hasLens = true;
    Z->lensBox = {-std::min(0.115, x1 + 0.01), std::min(0.115, x1 + 0.01), gy0 + lensLo * FC - 0.004, gy0 + (lensHi + 1) * FC + 0.004, z0 - 0.025};
  }
  // J/T split for colours both garments share
  ISet jSet = J1, tSet = T1;
  for (int k : J2.v) jSet.add(k);
  for (int k : T2.v) tSet.add(k);
  int tSeed = T1.v.empty() ? -1 : T1.v[0];
  std::vector<float> bins(48, 0.f);
  for (size_t i = 0; i < S; i++) {
    double y = SP[i * 3 + 1];
    int b2 = int(std::floor((y - (yHips - 0.25)) / 0.02));
    if (b2 < 0 || b2 >= 24 || part[i] == 4 || SG[i * NG + G_ARM] > 0.5) continue;
    int k = cl[i];
    if (k == tSeed && !J1.has(k)) bins[size_t(b2) * 2 + 1]++;
    else if (J1.has(k) && k != tSeed) bins[size_t(b2) * 2]++;
  }
  double yWaist = yHips + 0.04;
  for (int b2 = 23; b2 >= 0; b2--) {
    double nJ = bins[size_t(b2) * 2], nT = bins[size_t(b2) * 2 + 1];
    if (nT > 20 && nT > nJ) { yWaist = yHips - 0.25 + (b2 + 1) * 0.02; break; }
  }
  yWaist = std::min(yHips + 0.1, std::max(yHips - 0.2, yWaist));
  // tall boots
  ISet bootOnly;
  for (int k = 0; k < K; k++) if (frac[5][size_t(k)] >= 0.08f && !tSet.has(k) && !skin.has(k)) bootOnly.add(k);
  const double CELL = 0.035;
  std::unordered_map<int64_t, std::array<int, 2>> grid;
  auto cellKey = [&](double x, double y, double z) { return int64_t(std::floor(x / CELL) + 512) + int64_t(std::floor(y / CELL) + 512) * 1024 + int64_t(std::floor(z / CELL) + 512) * 1048576; };
  for (size_t i = 0; i < S; i++) {
    if (SP[i * 3 + 1] > yKnee + 0.05) continue;
    auto& c = grid[cellKey(SP[i * 3], SP[i * 3 + 1], SP[i * 3 + 2])];
    c[0]++;
    if (bootOnly.has(cl[i])) c[1]++;
  }
  auto bootish = [&](double x, double y, double z) {
    if (!bootOnly.size() || y > yKnee) return false;
    double n = 0, b2 = 0;
    for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
      auto it = grid.find(cellKey(x + dx * CELL, y + dy * CELL, z + dz * CELL));
      if (it != grid.end()) { n += it->second[0]; b2 += it->second[1]; }
    }
    return n > 6 && b2 / n >= 0.2;
  };
  const double yNeck = yHead;
  // cluster spread
  std::vector<float> rad(K, 0.f), rc(K, 0.f);
  for (size_t i = 0; i < S; i++) {
    int k = cl[i];
    rad[size_t(k)] = float(double(rad[size_t(k)]) + std::pow(double(Qs[i * 3]) - C[size_t(k) * 3], 2) + std::pow(double(Qs[i * 3 + 1]) - C[size_t(k) * 3 + 1], 2) + std::pow(double(Qs[i * 3 + 2]) - C[size_t(k) * 3 + 2], 2));
    rc[size_t(k)]++;
  }
  for (int k = 0; k < K; k++) rad[size_t(k)] = float(std::sqrt(double(rad[size_t(k)]) / std::max(1.0, double(rc[size_t(k)]))));
  Z->K = K; Z->C = C; Z->rad = rad; Z->mean = mean; Z->yWaist = yWaist; Z->yNeck = yNeck;
  Z->J1 = J1.v; Z->J2 = J2.v; Z->T1 = T1.v; Z->T2 = T2.v; Z->H = helmet.v; Z->L = lens;
  Z->has[0] = !J1.v.empty(); Z->has[1] = !J2.v.empty(); Z->has[2] = !T1.v.empty(); Z->has[3] = !T2.v.empty(); Z->has[4] = !helmet.v.empty(); Z->has[5] = !lens.empty();
  const std::vector<int>* roles[6] = {&Z->J1, &Z->J2, &Z->T1, &Z->T2, &Z->H, &Z->L};
  const std::vector<int>* const* roles_ = roles;
  for (int z = 0; z < 6; z++) {
    double w = 0, L = 0, A = 0, Bq = 0, Cc = 0;
    for (int k : *roles[z]) { w += rc[size_t(k)]; L += mean[size_t(k)][0] * rc[size_t(k)]; A += mean[size_t(k)][1] * rc[size_t(k)]; Bq += mean[size_t(k)][2] * rc[size_t(k)]; Cc += chroma(k) * rc[size_t(k)]; }
    if (w != 0) { Z->ref[z][0] = L / w; Z->ref[z][1] = A / w; Z->ref[z][2] = Bq / w; Z->ref[z][3] = Cc / w; } else { Z->ref[z][0] = 0.5; }
  }
  auto inV = [](const std::vector<int>& v, int k) { return std::find(v.begin(), v.end(), k) != v.end(); };
  // specks
  for (int p : {1, 2}) {
    std::vector<int> own = p == 1 ? jSet.v : tSet.v;
    if (own.empty()) continue;
    for (int k = 0; k < K; k++) {
      if (inV(own, k) || skin.has(k) || inV(lens, k)) continue;
      if (neutral(k) && mean[size_t(k)][0] >= 0.72 && frac[size_t(p)][size_t(k)] > 0 && frac[size_t(p)][size_t(k)] < 0.015f) (p == 1 ? Z->specJ : Z->specT).push_back(k);
    }
  }
  // anti-aliased edges between two garment colours
  {
    std::vector<int> garments[2] = {jSet.v, tSet.v};
    ISet roleOf;
    for (int z = 0; z < 6; z++) for (int k : *roles[z]) roleOf.add(k);
    for (int k = 0; k < K; k++) {
      double mx = std::max({double(frac[3][size_t(k)]), double(frac[4][size_t(k)]), double(frac[5][size_t(k)]), double(frac[6][size_t(k)]), double(fc[size_t(k)])});
      if (roleOf.has(k) || skin.has(k) || inV(Z->specJ, k) || inV(Z->specT, k) || mx > 0.08) continue;
      for (int g = 0; g < 2; g++) {
        int p = g + 1;
        if (frac[size_t(p)][size_t(k)] > 0.05f) continue;
        bool hit = false;
        for (int a : garments[g]) for (int b : garments[g]) {
          if (a >= b) continue;
          double ab = dist(a, b);
          if (ab < 0.08) continue;
          double t = ((double(C[size_t(k) * 3]) - C[size_t(a) * 3]) * (double(C[size_t(b) * 3]) - C[size_t(a) * 3]) + (double(C[size_t(k) * 3 + 1]) - C[size_t(a) * 3 + 1]) * (double(C[size_t(b) * 3 + 1]) - C[size_t(a) * 3 + 1])
                      + (double(C[size_t(k) * 3 + 2]) - C[size_t(a) * 3 + 2]) * (double(C[size_t(b) * 3 + 2]) - C[size_t(a) * 3 + 2])) / (ab * ab);
          double dx = double(C[size_t(k) * 3]) - C[size_t(a) * 3] - t * (double(C[size_t(b) * 3]) - C[size_t(a) * 3]);
          double dy = double(C[size_t(k) * 3 + 1]) - C[size_t(a) * 3 + 1] - t * (double(C[size_t(b) * 3 + 1]) - C[size_t(a) * 3 + 1]);
          double dz = double(C[size_t(k) * 3 + 2]) - C[size_t(a) * 3 + 2] - t * (double(C[size_t(b) * 3 + 2]) - C[size_t(a) * 3 + 2]);
          if (t > 0.15 && t < 0.85 && std::sqrt(dx * dx + dy * dy + dz * dz) < 0.3 * ab) hit = true;
        }
        if (hit && !inV(Z->blend, k)) Z->blend.push_back(k);
      }
    }
  }
  // the face: never a garment
  struct { double x, y0, y1, z0; } face{0.085, yHead + 0.01, Z->hasLens ? Z->lensBox.y1 : yTop - 0.07, zFront - 0.08};
  ISet crownJ;
  for (int k : jSet.v) if (frac[6][size_t(k)] > 0.05f) crownJ.add(k);
  ISet gloveC, bootC;
  for (int k = 0; k < K; k++) { if (frac[4][size_t(k)] >= 0.12f) gloveC.add(k); if (frac[5][size_t(k)] >= 0.12f) bootC.add(k); }
  if (std::getenv("SL_OUTFIT_DEBUG")) {   // (outfits.js analyzeZones({ debug: true }): the same listing)
    for (int k = 0; k < K; k++) {
      const auto& m = mean[size_t(k)];
      double lin2[3];
      labToLin(m[0], m[1], m[2], lin2);
      int hx = 0;
      for (int c = 0; c < 3; c++) hx = hx * 256 + int(std::lround(std::clamp(linToSrgb(std::max(0.0, lin2[c])), 0.0, 1.0) * 255));
      std::string roles;
      const char* rn[6] = {"J1", "J2", "T1", "T2", "H", "L"};
      for (int z = 0; z < 6; z++) if (std::find(roles_[z]->begin(), roles_[z]->end(), k) != roles_[z]->end()) roles += std::string(roles.empty() ? "" : ",") + rn[z];
      if (skin.has(k)) roles += std::string(roles.empty() ? "" : ",") + "skin";
      if (std::find(Z->blend.begin(), Z->blend.end(), k) != Z->blend.end()) roles += std::string(roles.empty() ? "" : ",") + "blend";
      SL_INFO("  c%d #%06x L%.2f C%.3f h%4.0f r%.3f | J %4.1f T %4.1f head %4.1f crown %4.1f hand %4.1f foot %4.1f eyes %4.1f  %s", k, hx, m[0], chroma(k),
              std::atan2(m[2], m[1]) * 180 / PI, double(rad[size_t(k)]), frac[1][size_t(k)] * 100.0, frac[2][size_t(k)] * 100.0, frac[3][size_t(k)] * 100.0,
              frac[6][size_t(k)] * 100.0, frac[4][size_t(k)] * 100.0, frac[5][size_t(k)] * 100.0, fc[size_t(k)] * 100.0, roles.c_str());
    }
    SL_INFO("  yHips %.3f yWaist %.3f yHead %.3f yTop %.3f", yHips, yWaist, yHead, yTop);
  }
  // ---- vertexZones
  Z->zone.assign(N * 4, 0);
  Z->pos.assign(N * 3, 0.f);
  ISet Hc;
  for (int k : helmet.v) Hc.add(k);
  for (size_t i = 0; i < N; i++) {
    sampleLin(px, V[i * 16 + 6], V[i * 16 + 7], lin);
    linToLab(lin[0], lin[1], lin[2], lab);
    double q[3] = {lab[0] * WL, lab[1], lab[2]};
    int k = nearest(C, K, q);
    double y = P[i * 3 + 1];
    bool hand = GW[i * NG + G_HAND] > 0.5, foot = GW[i * NG + G_FOOT] > 0.5, arm = GW[i * NG + G_ARM] > 0.5;
    int eJ = 0, eT = 0, eH = 0;
    bool onFace = std::fabs(P[i * 3]) < face.x && y > face.y0 && y < face.y1 && P[i * 3 + 2] > face.z0;
    if (onFace) {}
    else if (y > yNeck - 0.1 && J2.has(k) && !Hc.has(k)) {}
    else if (hand) { if (jSet.has(k) && !gloveC.has(k)) eJ = 1; }
    else if (foot) { if (tSet.has(k) && !bootC.has(k)) eT = 1; }
    else if (y > yNeck - 0.02) { eH = 1; if (jSet.has(k) && !crownJ.has(k) && y < yTop - 0.06) eJ = 1; }
    else {
      if (arm || y > yWaist) { eJ = 1; if (!arm && y < yWaist + 0.06 && tSet.has(k) && !jSet.has(k)) eT = 1; }
      else {
        eT = bootish(P[i * 3], y, P[i * 3 + 2]) ? 0 : 1;
        if (y > yKnee && jSet.has(k) && !tSet.has(k)) eJ = 1;
      }
      if (y > yNeck - 0.15 && Hc.has(k)) eH = 1;
    }
    Z->zone[i * 4] = uint8_t(eJ * 255); Z->zone[i * 4 + 1] = uint8_t(eT * 255); Z->zone[i * 4 + 2] = uint8_t(eH * 255);
    Z->pos[i * 3] = P[i * 3]; Z->pos[i * 3 + 1] = float(y); Z->pos[i * 3 + 2] = P[i * 3 + 2];
  }
  return Z;
}

// ---------------------------------------------------------------- the recolour (OF_MAIN, per texel)
struct Uni {
  double C[MAX_CLUSTERS][4] = {}, role[MAX_CLUSTERS][4] = {}, ref[6][4] = {}, tgt[6][4] = {}, split[4] = {}, lens0[3] = {}, lens1[3] = {}, pbr[4] = {0.5, 0, 0.1, 0}, pbrOn[2] = {};
};
float f32(double x) { return float(x); }   // (GLSL floats)
void ofLab(const double c[3], double out[3]) {
  double l = std::cbrt(std::max(0.0, 0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]));
  double m = std::cbrt(std::max(0.0, 0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]));
  double s = std::cbrt(std::max(0.0, 0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]));
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}
double smoothstep(double a, double b, double x) { double t = std::clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3 - 2 * t); }
double stepf(double edge, double x) { return x < edge ? 0 : 1; }
void ofRecolor(const double lab[3], const double ref[4], const double tgt[3], double out[3]) {
  double r = std::max(lab[0], 0.0) / std::max(ref[0], 0.02);
  double g = tgt[0] > ref[0] ? std::clamp(std::pow(ref[0] / std::max(tgt[0], 0.02), 0.75), 0.3, 1.0) : 0.85;
  double L = std::clamp(tgt[0] * std::pow(r, g), 0.0, 1.0);
  double detail = 1.0 + (std::clamp((std::hypot(lab[1], lab[2]) / std::max(lab[0], 0.05)) / std::max(ref[3] / std::max(ref[0], 0.05), 1e-3), 0.6, 1.4) - 1.0) * smoothstep(0.03, 0.06, ref[3]);
  double k = std::clamp(L / std::max(tgt[0], 0.02), 0.0, 1.25) * detail;
  out[0] = L; out[1] = tgt[1] * k; out[2] = tgt[2] * k;
}
struct TexelOut { double rgb[3]; double sum, mh, ml, dark; };
void ofMain(const Uni& U, const double inRgb[3], const double zone[3], const double bp[3], TexelOut& o) {
  o.rgb[0] = inRgb[0]; o.rgb[1] = inRgb[1]; o.rgb[2] = inRgb[2];
  o.sum = o.mh = o.ml = o.dark = 0;
  double c[3] = {std::max(inRgb[0], 0.0), std::max(inRgb[1], 0.0), std::max(inRgb[2], 0.0)}, lab[3];
  ofLab(c, lab);
  double q[3] = {lab[0] * 0.42, lab[1], lab[2]};
  double d2[MAX_CLUSTERS], dmin = 1e9, rNear = 0.05;
  for (int k = 0; k < MAX_CLUSTERS; k++) {
    double dx = q[0] - U.C[k][0], dy = q[1] - U.C[k][1], dz = q[2] - U.C[k][2];
    d2[k] = U.C[k][3] > 0 ? dx * dx + dy * dy + dz * dz : 1e9;
    if (d2[k] < dmin) { dmin = d2[k]; rNear = U.C[k][3]; }
  }
  double pG[4] = {}, pHL[2] = {}, pS[2] = {}, ps = 0;
  for (int k = 0; k < MAX_CLUSTERS; k++) {
    double w = std::exp(-(d2[k] - dmin) * 1600.0);
    const double* r = U.role[k];
    ps += w;
    pG[0] += w * stepf(0.5, r[0]) * stepf(r[0], 1.5); pG[1] += w * stepf(1.5, r[0]) * stepf(r[0], 2.5);
    pG[2] += w * stepf(0.5, r[1]) * stepf(r[1], 1.5); pG[3] += w * stepf(1.5, r[1]) * stepf(r[1], 2.5);
    pHL[0] += w * stepf(0.5, r[2]); pHL[1] += w * stepf(0.5, r[3]);
    pS[0] += w * stepf(2.5, r[0]); pS[1] += w * stepf(2.5, r[1]);
  }
  for (double& v : pG) v /= ps;
  pHL[0] /= ps; pHL[1] /= ps; pS[0] /= ps; pS[1] /= ps;
  double keep = 1.0 - smoothstep(2.5 * rNear + 0.1, 3.5 * rNear + 0.18, std::sqrt(dmin));
  double e[3] = {smoothstep(0, 0.3, zone[0]), smoothstep(0, 0.3, zone[1]), smoothstep(0, 0.3, zone[2])};
  double inLens = U.split[2] * stepf(U.lens0[0], bp[0]) * stepf(bp[0], U.lens1[0]) * stepf(U.lens0[1], bp[1]) * stepf(bp[1], U.lens1[1]) * stepf(U.lens0[2], bp[2]);
  pG[0] += pS[0] * (1.0 - e[1]); pG[2] += pS[1] * (1.0 - e[0]);
  double cJ = e[0] * (pG[0] + pG[1]), cT = e[1] * (pG[2] + pG[3]), cH = e[2] * pHL[0], cL = inLens * pHL[1];
  double up = smoothstep(U.split[0] - 0.004, U.split[0] + 0.004, bp[1]);
  double hd = smoothstep(U.split[1] - 0.004, U.split[1] + 0.004, bp[1]);
  double ov = std::min(cJ, cT); cJ -= ov * (1.0 - up); cT -= ov * up;
  ov = std::min(cJ, cL); cJ -= ov * inLens; cL -= ov * (1.0 - inLens);
  ov = std::min(cH, cL); cH -= ov * inLens; cL -= ov * (1.0 - inLens);
  ov = std::min(cJ, cH); cJ -= ov * hd; cH -= ov * (1.0 - hd);
  double mJ1 = cJ * pG[0] / std::max(pG[0] + pG[1], 1e-4), mT1 = cT * pG[2] / std::max(pG[2] + pG[3], 1e-4);
  double m[6] = {mJ1 * U.tgt[0][3], (cJ - mJ1) * U.tgt[1][3], mT1 * U.tgt[2][3], (cT - mT1) * U.tgt[3][3], cH * U.tgt[4][3], cL * U.tgt[5][3]};
  double raw = m[0] + m[1] + m[2] + m[3] + m[4] + m[5];
  double sc = keep / std::max(1.0, raw);
  for (double& v : m) v *= sc;
  o.sum = raw * sc;
  double acc[3] = {lab[0] * (1.0 - o.sum), lab[1] * (1.0 - o.sum), lab[2] * (1.0 - o.sum)};
  for (int z = 0; z < 6; z++) {
    if (m[z] <= 0) continue;
    double rr[3];
    ofRecolor(lab, U.ref[z], U.tgt[z], rr);
    for (int i = 0; i < 3; i++) acc[i] += m[z] * rr[i];
  }
  if (o.sum > 0) {
    double lin[3];
    labToLin(acc[0], acc[1], acc[2], lin);
    for (int i = 0; i < 3; i++) o.rgb[i] = std::max(lin[i], 0.0);
  }
  o.mh = m[4]; o.ml = m[5];
  o.dark = m[0] * std::clamp((U.ref[0][0] - U.tgt[0][0]) * 2.5, 0.0, 1.0) + m[1] * std::clamp((U.ref[1][0] - U.tgt[1][0]) * 2.5, 0.0, 1.0)
         + m[2] * std::clamp((U.ref[2][0] - U.tgt[2][0]) * 2.5, 0.0, 1.0) + m[3] * std::clamp((U.ref[3][0] - U.tgt[3][0]) * 2.5, 0.0, 1.0);
}

Uni uniformsFor(const OutfitZones& Z, const OutfitLook& look) {
  Uni U;
  auto inV = [](const std::vector<int>& v, int k) { return std::find(v.begin(), v.end(), k) != v.end(); };
  for (int k = 0; k < Z.K && k < MAX_CLUSTERS; k++) {
    U.C[k][0] = Z.C[size_t(k) * 3]; U.C[k][1] = Z.C[size_t(k) * 3 + 1]; U.C[k][2] = Z.C[size_t(k) * 3 + 2];
    U.C[k][3] = inV(Z.blend, k) ? 0 : std::max(0.004, double(Z.rad[size_t(k)]));
    U.role[k][0] = inV(Z.J1, k) ? 1 : inV(Z.J2, k) ? 2 : inV(Z.specJ, k) ? 3 : 0;
    U.role[k][1] = inV(Z.T1, k) ? 1 : inV(Z.T2, k) ? 2 : inV(Z.specT, k) ? 3 : 0;
    U.role[k][2] = inV(Z.H, k) ? 1 : 0;
    U.role[k][3] = inV(Z.L, k) ? 1 : 0;
  }
  for (int z = 0; z < 6; z++) for (int i = 0; i < 4; i++) U.ref[z][i] = f32(Z.ref[z][i]);
  U.split[0] = Z.yWaist; U.split[1] = Z.yNeck; U.split[2] = Z.hasLens ? 1 : 0;
  if (Z.hasLens) { U.lens0[0] = Z.lensBox.x0; U.lens0[1] = Z.lensBox.y0; U.lens0[2] = Z.lensBox.z0; U.lens1[0] = Z.lensBox.x1; U.lens1[1] = Z.lensBox.y1; U.lens1[2] = 9; }
  auto put = [&](int i, bool on, uint32_t hex) { if (on) { double l[3]; hexToLab(hex, l); U.tgt[i][0] = l[0]; U.tgt[i][1] = l[1]; U.tgt[i][2] = l[2]; U.tgt[i][3] = 1; } };
  put(0, look.jacket, look.jBase); put(1, look.jacket, look.jAccent); put(2, look.trousers, look.tBase); put(3, look.trousers, look.tAccent);
  put(4, look.helmet, look.hColor); put(5, look.lens, look.lTint);
  double fin[2] = {0.2, 0};
  if (look.finish == "matte") { fin[0] = 0.82; } else if (look.finish == "satin") { fin[0] = 0.5; } else if (look.finish == "chrome") { fin[0] = 0.16; fin[1] = 0.85; }
  double m = std::clamp(look.mirror, 0.0, 1.0);
  U.pbr[0] = fin[0]; U.pbr[1] = fin[1]; U.pbr[2] = 0.05 + 0.03 * m; U.pbr[3] = 0.88 * m;
  U.pbrOn[0] = look.helmet ? 1 : 0; U.pbrOn[1] = look.lens ? 1 : 0;
  return U;
}

std::unordered_map<const RigModel*, std::shared_ptr<OutfitZones>>& zoneCache() { static std::unordered_map<const RigModel*, std::shared_ptr<OutfitZones>> m; return m; }
} // namespace

std::shared_ptr<OutfitZones> outfitZones(const RigModel& rig) {
  auto& c = zoneCache();
  auto it = c.find(&rig);
  if (it != c.end()) return it->second;
  auto z = analyze(rig);
  c[&rig] = z;
  if (z) SL_INFO("outfits: %s zones: jacket %s%s, trousers %s%s, helmet %s, lens %s (waist %.3f, neck %.3f)", rig.name.c_str(), z->has[0] ? "yes" : "no",
                 z->has[1] ? " + accent" : "", z->has[2] ? "yes" : "no", z->has[3] ? " + accent" : "", z->has[4] ? "yes" : "no", z->has[5] ? "yes" : "no", z->yWaist, z->yNeck);
  return z;
}

std::string outfitZonesInfo(const RigModel& rig) {
  auto z = outfitZones(rig);
  if (!z) return "none";
  std::string s;
  const char* n[6] = {"jacket", "jacketAccent", "trousers", "trousersAccent", "helmet", "lens"};
  for (int i = 0; i < 6; i++) if (z->has[i]) s += std::string(s.empty() ? "" : " ") + n[i];
  return s;
}

// ---------------------------------------------------------------- the bake (bakeLook)
std::shared_ptr<Model> dressModel(gfx::Device& dev, const RigModel& rig, const OutfitLook& look, std::vector<gfx::Texture>& owned) {
  if (!look.any()) return nullptr;
  auto Z = outfitZones(rig);
  if (!Z) return nullptr;
  const Model& md = *rig.body;
  const Primitive& prim = md.meshes[size_t(rig.skinMesh)].primitives[size_t(rig.skinPrim)];
  int mi = std::max(0, prim.material);
  const Material& mat = md.materials[size_t(mi)];
  const CpuImage& alb = *md.images[size_t(mat.baseImage)];
  const CpuImage* rm = mat.mrImage >= 0 && size_t(mat.mrImage) < md.images.size() ? md.images[size_t(mat.mrImage)].get() : nullptr;
  const Uni U = uniformsFor(*Z, look);
  const std::vector<float>& V = *prim.cpuVerts;
  const std::vector<uint32_t>& I = *prim.cpuIdx;
  const int BAKE = 1024, AUX = 512, PAD = 6;
  // texel sources (the material's maps, bilinear like the GPU's sampler at the texel centre)
  auto sampleImg = [](const CpuImage& im, double u, double v, double out[4], bool srgb) {
    double x = u * im.w - 0.5, y = v * im.h - 0.5;
    int x0 = int(std::floor(x)), y0 = int(std::floor(y));
    double fx = x - x0, fy = y - y0;
    auto at = [&](int xx, int yy, int c) {
      xx = ((xx % im.w) + im.w) % im.w; yy = ((yy % im.h) + im.h) % im.h;   // (repeat wrapping)
      uint8_t b = im.rgba[(size_t(yy) * im.w + xx) * 4 + size_t(c)];
      return srgb && c < 3 ? double(SRGB_LUT.v[b]) : b / 255.0;
    };
    for (int c = 0; c < 4; c++)
      out[c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
  };
  for (int pass = 0; pass < 2; pass++) {
    const int size = pass == 0 ? BAKE : AUX;
    std::vector<float> out(size_t(size) * size * 4, 0.f);   // rgb + alpha (island)
    for (size_t t = 0; t + 2 < I.size(); t += 3) {
      size_t ix[3] = {I[t], I[t + 1], I[t + 2]};
      double X[3], Y[3];
      for (int k = 0; k < 3; k++) { X[k] = V[ix[k] * 16 + 6] * size; Y[k] = V[ix[k] * 16 + 7] * size; }
      double area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
      if (std::fabs(area) < 1e-12) continue;
      int x0 = std::max(0, int(std::floor(std::min({X[0], X[1], X[2]})))), x1 = std::min(size - 1, int(std::ceil(std::max({X[0], X[1], X[2]}))));
      int y0 = std::max(0, int(std::floor(std::min({Y[0], Y[1], Y[2]})))), y1 = std::min(size - 1, int(std::ceil(std::max({Y[0], Y[1], Y[2]}))));
      for (int y = y0; y <= y1; y++)
        for (int x = x0; x <= x1; x++) {
          double sx = x + 0.5, sy = y + 0.5;
          double w0 = ((X[1] - sx) * (Y[2] - sy) - (X[2] - sx) * (Y[1] - sy)) / area;
          double w1 = ((X[2] - sx) * (Y[0] - sy) - (X[0] - sx) * (Y[2] - sy)) / area;
          double w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          double w[3] = {w0, w1, w2}, zone[3] = {0, 0, 0}, bp[3] = {0, 0, 0}, u = 0, v = 0;
          for (int k = 0; k < 3; k++) {
            for (int c = 0; c < 3; c++) { zone[c] += w[k] * Z->zone[ix[k] * 4 + size_t(c)] / 255.0; bp[c] += w[k] * Z->pos[ix[k] * 3 + size_t(c)]; }
            u += w[k] * V[ix[k] * 16 + 6]; v += w[k] * V[ix[k] * 16 + 7];
          }
          double a[4];
          sampleImg(alb, u, v, a, true);
          double in[3] = {a[0] * mat.baseColor.x, a[1] * mat.baseColor.y, a[2] * mat.baseColor.z};
          TexelOut o;
          ofMain(U, in, zone, bp, o);
          float* px = &out[(size_t(y) * size + x) * 4];
          if (pass == 0) { px[0] = float(o.rgb[0]); px[1] = float(o.rgb[1]); px[2] = float(o.rgb[2]); }
          else {
            double f[2] = {mat.roughness, mat.metallic};
            if (rm) { double s[4]; sampleImg(*rm, u, v, s, false); f[0] *= s[1]; f[1] *= s[2]; }
            double rough = f[0], metal = f[1];
            rough = rough + (std::max(rough, 0.72) - rough) * o.dark;
            rough = rough + (U.pbr[0] - rough) * (o.mh * U.pbrOn[0]);
            metal = metal + (U.pbr[1] - metal) * (o.mh * U.pbrOn[0]);
            rough = rough + (U.pbr[2] - rough) * (o.ml * U.pbrOn[1]);
            metal = metal + (U.pbr[3] - metal) * (o.ml * U.pbrOn[1]);
            px[0] = 1; px[1] = float(std::clamp(rough, 0.0, 1.0)); px[2] = float(std::clamp(metal, 0.0, 1.0));
          }
          px[3] = 1;
        }
    }
    // pad the islands (the nearest island texel within PAD), the original elsewhere
    std::vector<uint8_t> img(size_t(size) * size * 4);
    for (int y = 0; y < size; y++)
      for (int x = 0; x < size; x++) {
        const float* c = &out[(size_t(y) * size + x) * 4];
        if (c[3] < 0.5f) {
          for (int r = 1; r <= PAD && c[3] < 0.5f; r++)
            for (int k = 0; k < 8; k++) {
              double ang = k * 0.7853982;
              int sx = std::clamp(int(std::floor(x + 0.5 + std::cos(ang) * r)), 0, size - 1), sy = std::clamp(int(std::floor(y + 0.5 + std::sin(ang) * r)), 0, size - 1);
              const float* s = &out[(size_t(sy) * size + sx) * 4];
              if (s[3] > 0.5f) { c = s; break; }
            }
        }
        uint8_t* o = &img[(size_t(y) * size + x) * 4];
        double rgb[3];
        if (c[3] > 0.5f) { rgb[0] = c[0]; rgb[1] = c[1]; rgb[2] = c[2]; }
        else {
          double s[4];
          if (pass == 0) { sampleImg(alb, (x + 0.5) / size, (y + 0.5) / size, s, true); rgb[0] = s[0] * mat.baseColor.x; rgb[1] = s[1] * mat.baseColor.y; rgb[2] = s[2] * mat.baseColor.z; }
          else {
            double f[2] = {mat.roughness, mat.metallic};
            if (rm) { sampleImg(*rm, (x + 0.5) / size, (y + 0.5) / size, s, false); f[0] *= s[1]; f[1] *= s[2]; }
            rgb[0] = 1; rgb[1] = f[0]; rgb[2] = f[1];
          }
        }
        for (int i = 0; i < 3; i++) o[i] = uint8_t(std::lround(std::clamp(pass == 0 ? linToSrgb(std::clamp(rgb[i], 0.0, 1.0)) : rgb[i], 0.0, 1.0) * 255));
        o[3] = 255;
      }
    gfx::TextureDesc d;
    d.width = size; d.height = size; d.format = pass == 0 ? gfx::TexFormat::SRGBA8 : gfx::TexFormat::RGBA8; d.anisotropy = 8;
    owned.push_back(dev.createTexture(d, img.data()));
  }
  auto dressed = std::make_shared<Model>(md);
  dressed->images.clear();
  Material& m = dressed->materials[size_t(mi)];
  m.baseTex = owned[owned.size() - 2];
  m.mrTex = owned.back();
  m.baseColor = vec4(1, 1, 1, m.baseColor.w);
  m.roughness = 1; m.metallic = 1;
  return dressed;
}

// ---------------------------------------------------------------- the catalogue (outfits.js OUTFIT_ITEMS, OUTFIT_KITS)
namespace {
struct Item { const char* id; const char* slot; uint32_t a, b; const char* finish; double mirror; };
const Item ITEMS[] = {
  {"j_glacier", "jacket", 0x1f6fd1, 0xf2f5f8, nullptr, 1}, {"j_racing", "jacket", 0xd0202e, 0xf2f5f8, nullptr, 1}, {"j_forest", "jacket", 0x2f6b3d, 0xe3b23c, nullptr, 1},
  {"j_teal", "jacket", 0x0f9aa0, 0xf2f5f8, nullptr, 1}, {"j_sunset", "jacket", 0xff6a1a, 0x1d2a44, nullptr, 1}, {"j_arctic", "jacket", 0xf1f4f7, 0x23303f, nullptr, 1},
  {"j_midnight", "jacket", 0x1b1d22, 0xd42a35, nullptr, 1}, {"j_rose", "jacket", 0xf06ea8, 0xffffff, nullptr, 1}, {"j_volt", "jacket", 0xecd51a, 0x1b1d22, nullptr, 1},
  {"j_violet", "jacket", 0x6b2fd0, 0x34e0d6, nullptr, 1}, {"j_retro", "jacket", 0x1c2b4f, 0xff7a1a, nullptr, 1}, {"j_mint", "jacket", 0x7fdcbf, 0x2a2f36, nullptr, 1},
  {"t_black", "trousers", 0x1b1c1f, 0x3a3d44, nullptr, 1}, {"t_charcoal", "trousers", 0x3a3f47, 0x1b1c1f, nullptr, 1}, {"t_navy", "trousers", 0x1d2a4a, 0xc9ced6, nullptr, 1},
  {"t_olive", "trousers", 0x4f5a35, 0x2a2f1f, nullptr, 1}, {"t_sand", "trousers", 0xb9986c, 0x5a4632, nullptr, 1}, {"t_snow", "trousers", 0xeef1f4, 0xc4cad3, nullptr, 1},
  {"t_red", "trousers", 0xc81e2c, 0x1b1c1f, nullptr, 1}, {"t_sky", "trousers", 0x5aa8e6, 0xffffff, nullptr, 1},
  {"h_matteblack", "helmet", 0x1c1d20, 0, "matte", 1}, {"h_white", "helmet", 0xf4f5f7, 0, "gloss", 1}, {"h_olive", "helmet", 0x4d5a33, 0, "matte", 1},
  {"h_navy", "helmet", 0x1f2d55, 0, "matte", 1}, {"h_red", "helmet", 0xd0202e, 0, "gloss", 1}, {"h_neon", "helmet", 0xe8f01c, 0, "gloss", 1},
  {"h_silver", "helmet", 0xc9ccd2, 0, "chrome", 1}, {"h_gold", "helmet", 0xd9a93a, 0, "chrome", 1},
  {"l_clear", "lens", 0xdfe8ee, 0, nullptr, 0}, {"l_smoke", "lens", 0x3a3d44, 0, nullptr, 0.35}, {"l_rose", "lens", 0xff7aa8, 0, nullptr, 0.5},
  {"l_ice", "lens", 0x45b0ff, 0, nullptr, 1}, {"l_fire", "lens", 0xff3b1f, 0, nullptr, 1}, {"l_emerald", "lens", 0x21c26b, 0, nullptr, 1},
  {"l_violet", "lens", 0x8a5cff, 0, nullptr, 1}, {"l_gold", "lens", 0xffb02a, 0, nullptr, 1},
};
struct Kit { const char* id; uint32_t ja, jb, ta, tb, h; const char* finish; uint32_t lt; double mirror; };
const Kit KITS[] = {
  {"kit_alpine", 0xd0202e, 0xffffff, 0x1b1c1f, 0xd0202e, 0xd0202e, "gloss", 0x3a3d44, 0.35}, {"kit_forest", 0x2f5a3e, 0x1b1d22, 0x2c3036, 0x1b1d22, 0xc9501f, "matte", 0xff6a2a, 1},
  {"kit_park", 0x4a23a6, 0x2cc6c8, 0x1b1d26, 0x2cc6c8, 0x7a1f96, "matte", 0x2fd6d0, 1}, {"kit_downhill", 0xf2541e, 0x1f2643, 0xf2541e, 0x1f2643, 0x1f2a4d, "gloss", 0xff4f9a, 1},
  {"kit_glacier", 0xf3f6f9, 0x7fc8f0, 0xf3f6f9, 0x7fc8f0, 0xf4f6f8, "gloss", 0x45b0ff, 1}, {"kit_mono", 0x1c1d21, 0xf2f3f5, 0x1c1d21, 0xf2f3f5, 0xf4f5f7, "gloss", 0x2a2d33, 0.4},
  {"kit_night", 0x121317, 0xe0182c, 0x121317, 0xe0182c, 0x141518, "matte", 0xff3b1f, 1}, {"kit_gold", 0xdcab35, 0x111214, 0x111214, 0xdcab35, 0xe0b246, "chrome", 0xffb02a, 1},
};
} // namespace

std::string OutfitLook::key() const {
  char b[256];
  std::snprintf(b, sizeof b, "%d%06x%06x|%d%06x%06x|%d%06x%s|%d%06x%.2f", jacket, jBase, jAccent, trousers, tBase, tAccent, helmet, hColor, finish.c_str(), lens, lTint, mirror);
  return b;
}

OutfitLook outfitLookOf(const std::string& jacket, const std::string& trousers, const std::string& helmet, const std::string& lens) {
  OutfitLook L;
  auto resolve = [&](const std::string& id, const char* slot) {
    if (id.empty()) return;
    std::string s = slot;
    for (const Item& it : ITEMS) {
      if (id != it.id || s != it.slot) continue;
      if (s == "jacket") { L.jacket = true; L.jBase = it.a; L.jAccent = it.b; }
      else if (s == "trousers") { L.trousers = true; L.tBase = it.a; L.tAccent = it.b; }
      else if (s == "helmet") { L.helmet = true; L.hColor = it.a; L.finish = it.finish ? it.finish : "gloss"; }
      else { L.lens = true; L.lTint = it.a; L.mirror = it.mirror; }
      return;
    }
    size_t dot = id.find('.');
    if (dot == std::string::npos || id.substr(dot + 1) != s) return;
    std::string kid = id.substr(0, dot);
    for (const Kit& k : KITS) {
      if (kid != k.id) continue;
      if (s == "jacket") { L.jacket = true; L.jBase = k.ja; L.jAccent = k.jb; }
      else if (s == "trousers") { L.trousers = true; L.tBase = k.ta; L.tAccent = k.tb; }
      else if (s == "helmet") { L.helmet = true; L.hColor = k.h; L.finish = k.finish; }
      else { L.lens = true; L.lTint = k.lt; L.mirror = k.mirror; }
    }
  };
  resolve(jacket, "jacket"); resolve(trousers, "trousers"); resolve(helmet, "helmet"); resolve(lens, "lens");
  return L;
}

} // namespace sl
