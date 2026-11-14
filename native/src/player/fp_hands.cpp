// The first-person view model's meshes: see fp_hands.h. skier.js buildFpArm / fpArmMaterial / fpPoleGeometry.
#include "player/fp_hands.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "engine/renderer.h"
#include <algorithm>
#include <glm/gtc/packing.hpp>

namespace sl {
using three::V3;

namespace {
constexpr double FP_ARM_CUT = 0.5;   // glove -> sleeve along the arm, as a share of its length from the knuckles
double srgbLin(double c) { c /= 255; return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
// the image drawn into a 256 x 256 canvas (skier.js: getImageData of the texture drawn at 256 px)
std::vector<uint8_t> canvas256(const CpuImage& im) {
  const int S = 256;
  std::vector<uint8_t> out(size_t(S) * S * 4, 0);
  if (im.w <= 0 || im.h <= 0) return out;
  for (int y = 0; y < S; y++)
    for (int x = 0; x < S; x++) {
      int x0 = x * im.w / S, x1 = std::max(x0 + 1, (x + 1) * im.w / S), y0 = y * im.h / S, y1 = std::max(y0 + 1, (y + 1) * im.h / S);
      double acc[4] = {0, 0, 0, 0};
      int n = 0;
      for (int yy = y0; yy < y1 && yy < im.h; yy++)
        for (int xx = x0; xx < x1 && xx < im.w; xx++) {
          const uint8_t* p = &im.rgba[(size_t(yy) * size_t(im.w) + size_t(xx)) * 4];
          for (int k = 0; k < 4; k++) acc[k] += p[k];
          n++;
        }
      for (int k = 0; k < 4; k++) out[(size_t(y) * S + size_t(x)) * 4 + size_t(k)] = uint8_t(std::lround(acc[k] / std::max(1, n)));
    }
  return out;
}
const uint8_t* px256(const std::vector<uint8_t>& c, double u, double v) {
  const int S = 256;
  int x = std::clamp(int(std::floor(u * S)), 0, S - 1), y = std::clamp(int(std::floor(v * S)), 0, S - 1);   // (flipY false)
  return &c[(size_t(y) * S + size_t(x)) * 4];
}

// THREE.LatheGeometry(points, segments): the profile turned about +Y, three's normals
Geo latheGeo(const std::vector<vec2>& pts, int segs) {
  Geo g;
  const size_t n = pts.size();
  std::vector<vec3> init;
  vec3 prev(0);
  for (size_t j = 0; j < n; j++) {
    if (j == 0) {
      float dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      vec3 nn(dy, -dx, 0);
      prev = nn;
      init.push_back(glm::normalize(nn));
    } else if (j == n - 1) {
      init.push_back(prev);
    } else {
      float dx = pts[j + 1].x - pts[j].x, dy = pts[j + 1].y - pts[j].y;
      vec3 cur(dy, -dx, 0);
      init.push_back(glm::normalize(cur + prev));
      prev = cur;
    }
  }
  for (int i = 0; i <= segs; i++) {
    float phi = float(i) / float(segs) * 6.2831853f, s = std::sin(phi), c = std::cos(phi);
    for (size_t j = 0; j < n; j++) {
      g.pos.push_back(vec3(pts[j].x * s, pts[j].y, pts[j].x * c));
      g.uv.push_back(vec2(float(i) / float(segs), float(j) / float(n - 1)));
      vec3 nn(init[j].x * s, init[j].y, init[j].x * c);
      g.nor.push_back(glm::length(nn) > 0 ? glm::normalize(nn) : vec3(0, 1, 0));
    }
  }
  for (int i = 0; i < segs; i++)
    for (size_t j = 0; j + 1 < n; j++) {
      uint32_t base = uint32_t(j + size_t(i) * n), a = base, b = base + uint32_t(n), c = base + uint32_t(n) + 1, d = base + 1;
      g.idx.insert(g.idx.end(), {a, b, d, c, d, b});
    }
  return g;
}
Material fpMaterial(const char* hex, float rough, float metal) {
  Material m;
  m.baseColor = vec4(hexColor(hex), 1);
  m.roughness = rough; m.metallic = metal;
  m.shading = 3;
  return m;
}
} // namespace

bool fpRigColour(const RigModel& rig, int bone, vec3& out) {
  const Model& md = *rig.body;
  if (rig.skinPrim < 0 || bone < 0) return false;
  const Primitive& P = md.meshes[size_t(rig.skinMesh)].primitives[size_t(rig.skinPrim)];
  if (P.material < 0 || !P.cpuVerts) return false;
  const Material& mat = md.materials[size_t(P.material)];
  if (mat.baseImage < 0 || size_t(mat.baseImage) >= md.images.size() || !md.images[size_t(mat.baseImage)]) return false;
  const std::vector<uint8_t> px = canvas256(*md.images[size_t(mat.baseImage)]);
  const Skin& sk = md.skins[0];
  int bi = -1;
  for (size_t j = 0; j < sk.joints.size(); j++) if (sk.joints[j] == bone) bi = int(j);
  if (bi < 0) return false;
  struct Bin { int key, n; double r, g, b; };
  std::vector<Bin> bins;
  const std::vector<float>& V = *P.cpuVerts;
  for (size_t i = 0, nv = V.size() / 16; i < nv; i++) {
    const float* q = &V[i * 16];
    double w = 0;
    for (int j = 0; j < 4; j++) if (int(q[8 + j]) == bi) w += q[12 + j];
    if (w < 0.6) continue;
    const uint8_t* p = px256(px, q[6], q[7]);
    int kb = ((p[0] >> 5) << 6) | ((p[1] >> 5) << 3) | (p[2] >> 5);
    auto it = std::find_if(bins.begin(), bins.end(), [&](const Bin& B) { return B.key == kb; });
    if (it == bins.end()) { bins.push_back({kb, 0, 0, 0, 0}); it = bins.end() - 1; }
    it->n++; it->r += srgbLin(p[0]); it->g += srgbLin(p[1]); it->b += srgbLin(p[2]);
  }
  const Bin* best = nullptr;
  for (const Bin& B : bins) if (!best || B.n > best->n) best = &B;
  if (!best || best->n <= 8) return false;
  out = vec3(float(best->r / best->n), float(best->g / best->n), float(best->b / best->n));
  return true;
}

bool FpHands::load(gfx::Device& dev, AssetManager& assets) {
  dev_ = &dev;
  tried_ = true;
  // ---- the pole (fpPoleGeometry): a moulded grip with finger ridges and a rounded knob with an accent ring, a slim
  // alloy shaft with dark bands, a small basket and a steel tip. Origin in the middle of the grip, shaft down -Y.
  {
    const std::vector<vec2> prof = {
      {0.0001f, -0.142f}, {0.0089f, -0.142f}, {0.0175f, -0.12f}, {0.0212f, -0.103f}, {0.0196f, -0.088f}, {0.0168f, -0.062f},
      {0.0178f, -0.042f}, {0.0168f, -0.021f}, {0.0178f, 0.0f}, {0.0168f, 0.021f}, {0.018f, 0.04f}, {0.0192f, 0.055f},
      {0.0228f, 0.066f}, {0.0238f, 0.076f}, {0.0222f, 0.087f}, {0.0165f, 0.094f}, {0.008f, 0.0975f}, {0.0001f, 0.098f}};
    Geo dark = latheGeo(prof, 28);
    Geo ring = torusArcGeo(0.0232f, 0.0033f, 8, 32, 6.2831853f); ring.rotateX(1.5707963f); ring.translate(0, 0.0705f, 0);
    Geo shaft = cylinderGeo(0.0088f, 0.0066f, 1.0f, 14, true); shaft.translate(0, -0.642f, 0);
    auto band = [](float y, float len, float r) { Geo g = cylinderGeo(r, r, len, 14, true); g.translate(0, y, 0); return g; };
    Geo basket = cylinderGeo(0.048f, 0.044f, 0.007f, 24, false); basket.translate(0, -1.065f, 0);
    Geo rim = torusArcGeo(0.048f, 0.0035f, 6, 28, 6.2831853f); rim.rotateX(1.5707963f); rim.translate(0, -1.062f, 0);
    Geo tip = cylinderGeo(0, 0.0062f, 0.05f, 10, false); tip.rotateX(3.1415927f); tip.translate(0, -1.167f, 0);
    dark.append(band(-0.3f, 0.13f, 0.0094f)); dark.append(band(-1.02f, 0.06f, 0.0078f)); dark.append(basket); dark.append(rim);
    pole_ = buildModel(dev, {{dark, fpMaterial("#1c1e23", 0.72f, 0)}, {ring, fpMaterial("#e2b21e", 0.42f, 0)},
                             {shaft, fpMaterial("#d6dde5", 0.3f, 0.55f)}, {tip, fpMaterial("#8d949c", 0.28f, 0.85f)}}, "fp-pole");
  }
  // ---- the arm (buildFpArm)
  ModelLoadOptions o;
  o.keepCpu = true;
  o.maxTextureSize = 1024;
  src_ = assets.loadFile(assets.modelPath("driving_hand_c"), "driving_hand_c#fp", o);
  if (!src_) { SL_WARN("first-person arm: driving_hand_c missing (the poles alone)"); return false; }
  const Model& md = *src_;
  int ni = -1;
  for (size_t i = 0; i < md.nodes.size() && ni < 0; i++) if (md.nodes[i].mesh >= 0) ni = int(i);
  if (ni < 0 || md.meshes[size_t(md.nodes[size_t(ni)].mesh)].primitives.empty()) return false;
  const Primitive& P = md.meshes[size_t(md.nodes[size_t(ni)].mesh)].primitives[0];
  if (!P.cpuVerts || !P.cpuIdx) return false;
  // the mesh's world matrix (its node and the parents')
  glm::dmat4 MW(1);
  for (int k = ni; k >= 0; k = md.nodes[size_t(k)].parent) {
    const Node& nd = md.nodes[size_t(k)];
    MW = three::compose(V3(nd.t), three::Q(nd.r.w, nd.r.x, nd.r.y, nd.r.z), V3(nd.s)) * MW;
  }
  const glm::dmat3 NM = glm::transpose(glm::inverse(glm::dmat3(MW)));
  const std::vector<float>& CV = *P.cpuVerts;
  const size_t n = CV.size() / 8;
  std::vector<V3> pos(n), nor(n);
  std::vector<glm::dvec2> uv(n);
  for (size_t i = 0; i < n; i++) {
    const float* q = &CV[i * 8];
    pos[i] = three::mulPoint(MW, V3(q[0], q[1], q[2]));
    nor[i] = three::normalize(NM * V3(q[3], q[4], q[5]));
    uv[i] = glm::dvec2(q[6], q[7]);
  }
  // grip axis (toward the thumb) and forearm (fist -> sleeve) in the model, as game/drive.js measured them
  const V3 Gm(-1, 0, 0), Fm = three::normalize(V3(0.65, 0.42, -0.63));
  double lo = 1e30, hi = -1e30;
  V3 bmin(1e30), bmax(-1e30);
  for (const V3& v : pos) { double d = glm::dot(v, Fm); lo = std::min(lo, d); hi = std::max(hi, d); bmin = glm::min(bmin, v); bmax = glm::max(bmax, v); }
  const V3 cc = (bmin + bmax) * 0.5;
  const double L = hi - lo;
  const V3 hole = cc + Fm * (lo + L * 0.16 - glm::dot(cc, Fm));
  // per vertex its share of the length from the knuckles; the sleeve's open end (its last 3 %) for the cap
  std::vector<double> sl(n);
  V3 end(0);
  int ne = 0;
  bool hasCapUv = false;
  glm::dvec2 capUv(0.5);
  for (size_t i = 0; i < n; i++) {
    double t = (glm::dot(pos[i], Fm) - lo) / L;
    sl[i] = t;
    if (t > 0.97) { end += pos[i]; ne++; }
    if (!hasCapUv && t > 0.74 && t < 0.76) { capUv = uv[i]; hasCapUv = true; }
  }
  std::vector<V3> P2 = pos, N2 = nor;
  std::vector<glm::dvec2> U2 = uv;
  std::vector<double> S2 = sl;
  std::vector<uint32_t> I2(P.cpuIdx->begin(), P.cpuIdx->end());
  if (ne > 8) {
    end *= 1.0 / ne;
    double r = 0;
    for (size_t i = 0; i < n; i++) if ((glm::dot(pos[i], Fm) - lo) / L > 0.97) r += glm::distance(pos[i], end);
    // CircleGeometry((r / ne) * 1.08, 20), facing +z, turned to face along the arm, a hair inside the end
    const double rad = (r / ne) * 1.08;
    const glm::dmat4 CM = three::compose(end + Fm * (-L * 0.012), three::fromUnitVectors(V3(0, 0, 1), Fm), V3(1));
    const uint32_t c0 = uint32_t(P2.size());
    P2.push_back(three::mulPoint(CM, V3(0)));
    for (int s = 0; s <= 20; s++) { double a = s / 20.0 * 2 * PI; P2.push_back(three::mulPoint(CM, V3(rad * std::cos(a), rad * std::sin(a), 0))); }
    for (int s = 0; s <= 21; s++) { N2.push_back(Fm); U2.push_back(capUv); S2.push_back(1); }
    for (uint32_t s = 1; s <= 20; s++) I2.insert(I2.end(), {c0 + s, c0 + s + 1, c0});
  }
  // into the fist's frame: +Y up the pole, +Z knuckles, +X back of the hand, the grip hole at the origin, 0.42 m long
  const V3 zm = -three::normalize(Fm + Gm * (-glm::dot(Fm, Gm))), xm = glm::cross(Gm, zm);
  const double k = 0.42 / L;
  glm::dmat3 B(xm, Gm, zm);
  const glm::dmat3 BT = glm::transpose(B);
  for (size_t i = 0; i < P2.size(); i++) { P2[i] = BT * (P2[i] - hole) * k; N2[i] = three::normalize(BT * N2[i]); }
  // the texture's median luminance under the glove and under the sleeve (the shading reference)
  const Material& m0 = md.materials[size_t(std::max(0, P.material))];
  if (m0.baseImage >= 0 && size_t(m0.baseImage) < md.images.size() && md.images[size_t(m0.baseImage)]) {
    img_ = md.images[size_t(m0.baseImage)];
    const std::vector<uint8_t> px = canvas256(*img_);
    std::vector<double> lists[2];
    for (size_t i = 0; i < n; i++) {
      if (std::fabs(sl[i] - FP_ARM_CUT) <= 0.02) continue;
      const uint8_t* p = px256(px, uv[i].x, uv[i].y);
      lists[sl[i] > FP_ARM_CUT ? 1 : 0].push_back(0.2126 * srgbLin(p[0]) + 0.7152 * srgbLin(p[1]) + 0.0722 * srgbLin(p[2]));
    }
    for (int j = 0; j < 2; j++)
      if (lists[j].size() > 50) { std::sort(lists[j].begin(), lists[j].end()); ref_[j] = std::max(1e-3, lists[j][lists[j].size() >> 1]); }
  }
  // glove | sleeve: split at FP_ARM_CUT (the shader's crisp seam: a triangle across it is cut in two)
  Geo part[2];
  auto vert = [&](Geo& g, const V3& p, const V3& nn, const glm::dvec2& t) {
    g.pos.push_back(vec3(p)); g.nor.push_back(vec3(three::normalize(nn))); g.uv.push_back(vec2(t));
    g.idx.push_back(uint32_t(g.pos.size() - 1));
  };
  struct PV { V3 p, n; glm::dvec2 t; double s; };
  for (size_t f = 0; f + 2 < I2.size(); f += 3) {
    PV v[3];
    for (int c = 0; c < 3; c++) { uint32_t q = I2[f + size_t(c)]; v[c] = {P2[q], N2[q], U2[q], S2[q]}; }
    for (int side = 0; side < 2; side++) {
      auto in = [&](const PV& a) { return side == 0 ? a.s < FP_ARM_CUT : a.s >= FP_ARM_CUT; };
      std::vector<PV> poly;
      for (int c = 0; c < 3; c++) {
        const PV &a = v[c], &b = v[(c + 1) % 3];
        if (in(a)) poly.push_back(a);
        if (in(a) != in(b)) {
          double t = (FP_ARM_CUT - a.s) / (b.s - a.s);
          poly.push_back({a.p + (b.p - a.p) * t, a.n + (b.n - a.n) * t, a.t + (b.t - a.t) * t, FP_ARM_CUT});
        }
      }
      for (size_t c = 1; c + 1 < poly.size(); c++) { vert(part[side], poly[0].p, poly[0].n, poly[0].t); vert(part[side], poly[c].p, poly[c].n, poly[c].t); vert(part[side], poly[c + 1].p, poly[c + 1].n, poly[c + 1].t); }
    }
  }
  for (int j = 0; j < 2; j++) {
    Material m;
    m.doubleSided = true;
    m.metallic = 0;
    m.roughness = m0.mrTex ? 1.f : 0.78f;
    m.mrTex = m0.mrTex; m.normalTex = m0.normalTex; m.normalScale = m0.normalScale;
    m.shading = 3;
    arm_[j] = buildModel(dev, {{part[j], m}}, j ? "fp-sleeve" : "fp-glove");
  }
  SL_INFO("first-person arms: driving_hand_c, %zu vertices, %.3f m read into the fist's frame (glove %zu / sleeve %zu triangles), shading reference %.3f / %.3f",
          n, L, part[0].idx.size() / 3, part[1].idx.size() / 3, ref_[0], ref_[1]);
  return true;
}

// fpArmMaterial's shader, baked per texel for each part: the glove / sleeve colour times the texture's luminance against
// its median (every seam, fold and stitch kept), the reflective piping and the press stud in their own colours
void FpHands::setColours(const vec3& glove, const vec3& sleeve) {
  if (!dev_ || !img_ || !arm_[0]) return;
  if (glm::all(glm::lessThan(glm::abs(glove - glove_), vec3(1e-4f))) && glm::all(glm::lessThan(glm::abs(sleeve - sleeve_), vec3(1e-4f)))) return;
  glove_ = glove; sleeve_ = sleeve;
  const CpuImage& im = *img_;
  for (int j = 0; j < 2; j++) {
    const vec3 col = j ? sleeve : glove;
    const double ex = j ? 0.85 : 0.6, ref = std::max(ref_[j], 1e-4);
    std::vector<uint16_t> px(size_t(im.w) * size_t(im.h) * 4);
    for (size_t i = 0, N = size_t(im.w) * size_t(im.h); i < N; i++) {
      const uint8_t* s = &im.rgba[i * 4];
      double lin[3] = {srgbLin(s[0]), srgbLin(s[1]), srgbLin(s[2])};
      double rel = (0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]) / ref;
      double trim = three::smoothstep(rel, 6.0, 14.0);
      double kk = std::clamp(std::pow(rel, ex), 0.35, 1.9);
      for (int c = 0; c < 3; c++) px[i * 4 + size_t(c)] = glm::packHalf1x16(float(col[c] * kk + (lin[c] - col[c] * kk) * trim));
      px[i * 4 + 3] = glm::packHalf1x16(float(s[3]) / 255.f);
    }
    if (tex_[j]) dev_->destroy(tex_[j]);
    gfx::TextureDesc d;
    d.width = im.w; d.height = im.h; d.format = gfx::TexFormat::RGBA16F; d.mipmaps = true; d.anisotropy = 8;
    tex_[j] = dev_->createTexture(d, px.data());
    arm_[j]->materials[0].baseTex = tex_[j];
  }
}

void FpHands::submit(Renderer& r, const SkierRig::FpView& v) const {
  if (!v.visible || !pole_) return;
  for (int i = 0; i < 2; i++) {
    const SkierRig::FpHand& H = v.hands[i];
    const glm::dmat4 base = three::compose(V3(0), v.quat, V3(1)) * three::compose(H.rootP, H.rootQ, V3(1));
    // (the poles are turned about their own axis: the mirror image of the right one is the same pole)
    r.submitModel(*pole_, v.pos, mat4(base), nullptr, false);
    if (!v.arms || !arm_[0]) continue;
    const mat4 M = mat4(base * glm::scale(glm::dmat4(1), V3(i == 1 ? -1 : 1, 1, 1)));
    for (int j = 0; j < 2; j++) if (arm_[j]) r.submitModel(*arm_[j], v.pos, M, nullptr, false);
  }
}

} // namespace sl
