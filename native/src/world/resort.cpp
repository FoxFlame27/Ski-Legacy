#include "world/resort.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "engine/texcompress.h"
#include "gfx/gfx.h"
#include "platform/platform.h"
#include "world/gondola_station.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <zstd.h>

namespace sl {

namespace {
constexpr double PROP_CELL = 512;

// base64 + zlib (the cobble texture's alpha plane): inflate is done with a tiny stored/fixed/dynamic decoder
std::vector<uint8_t> b64(const std::string& s) {
  std::vector<uint8_t> out;
  int val = 0, bits = -8;
  for (char c : s) {
    int d = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1;
    if (d < 0) continue;
    val = (val << 6) + d; bits += 6;
    if (bits >= 0) { out.push_back(uint8_t((val >> bits) & 0xff)); bits -= 8; }
  }
  return out;
}
// minimal zlib inflate (RFC 1950/1951)
struct Inflate {
  const uint8_t* p; size_t n, pos = 0; uint32_t bitbuf = 0; int bitcnt = 0;
  std::vector<uint8_t> out;
  int bit() { if (!bitcnt) { if (pos >= n) return 0; bitbuf = p[pos++]; bitcnt = 8; } int b = bitbuf & 1; bitbuf >>= 1; bitcnt--; return b; }
  int bits(int k) { int v = 0; for (int i = 0; i < k; i++) v |= bit() << i; return v; }
  struct Huff { std::vector<int> count, sym; };
  static Huff build(const int* len, int n) {
    Huff h; h.count.assign(16, 0); h.sym.assign(size_t(n), 0);
    for (int i = 0; i < n; i++) h.count[size_t(len[i])]++;
    h.count[0] = 0;
    std::vector<int> offs(16, 0);
    for (int i = 1; i < 16; i++) offs[size_t(i)] = offs[size_t(i) - 1] + h.count[size_t(i) - 1];
    for (int i = 0; i < n; i++) if (len[i]) h.sym[size_t(offs[size_t(len[i])]++)] = i;
    return h;
  }
  int decode(const Huff& h) {
    int code = 0, first = 0, index = 0;
    for (int len = 1; len < 16; len++) {
      code |= bit();
      int count = h.count[size_t(len)];
      if (code - count < first) return h.sym[size_t(index + (code - first))];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    return -1;
  }
  bool codes(const Huff& lit, const Huff& dist) {
    static const int lbase[] = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
    static const int lext[] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
    static const int dbase[] = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
    static const int dext[] = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};
    for (;;) {
      int s = decode(lit);
      if (s < 0) return false;
      if (s < 256) out.push_back(uint8_t(s));
      else if (s == 256) return true;
      else {
        s -= 257;
        if (s >= 29) return false;
        int len = lbase[s] + bits(lext[s]);
        int ds = decode(dist);
        if (ds < 0 || ds >= 30) return false;
        size_t d = size_t(dbase[ds] + bits(dext[ds]));
        if (d > out.size()) return false;
        for (int i = 0; i < len; i++) out.push_back(out[out.size() - d]);
      }
    }
  }
  bool run() {
    pos = 2;   // zlib header
    int last;
    do {
      last = bit();
      int type = bits(2);
      if (type == 0) {
        bitcnt = 0;
        if (pos + 4 > n) return false;
        int len = p[pos] | (p[pos + 1] << 8);
        pos += 4;
        for (int i = 0; i < len && pos < n; i++) out.push_back(p[pos++]);
      } else if (type == 1) {
        int l[288 + 30];
        for (int i = 0; i < 144; i++) l[i] = 8;
        for (int i = 144; i < 256; i++) l[i] = 9;
        for (int i = 256; i < 280; i++) l[i] = 7;
        for (int i = 280; i < 288; i++) l[i] = 8;
        for (int i = 0; i < 30; i++) l[288 + i] = 5;
        if (!codes(build(l, 288), build(l + 288, 30))) return false;
      } else if (type == 2) {
        int nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        static const int order[19] = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};
        int lengths[320] = {0};
        for (int i = 0; i < ncode; i++) lengths[order[i]] = bits(3);
        Huff lencode = build(lengths, 19);
        int idx = 0;
        while (idx < nlen + ndist) {
          int sym = decode(lencode);
          if (sym < 0) return false;
          if (sym < 16) lengths[idx++] = sym;
          else {
            int len = 0, rep;
            if (sym == 16) { if (!idx) return false; len = lengths[idx - 1]; rep = 3 + bits(2); }
            else if (sym == 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            while (rep-- && idx < nlen + ndist) lengths[idx++] = len;
          }
        }
        if (!codes(build(lengths, nlen), build(lengths + nlen, ndist))) return false;
      } else return false;
    } while (!last);
    return true;
  }
};

gfx::Texture replayCanvas(gfx::Device& dev, const nlohmann::json& c, const FontSet& fonts, int cap, bool compress) {
  Canvas2D g(c.value("w", 300), c.value("h", 150), &fonts);
  auto F = [](const nlohmann::json& a, size_t i, float d = 0) { return i < a.size() && a[i].is_number() ? a[i].get<float>() : d; };
  // (a canvas recorded `exact` (the trail map on the village's notice board) is replayed with the rest of the canvas
  // API it uses: line caps, dashes, putImageData's pixels and the fonts it names, as the browser draws them)
  const bool exact = c.value("exact", false);
  g.systemFonts(exact);
  for (auto& op : c["ops"]) {
    if (!op.is_array() || op.empty()) continue;
    const std::string n = op[0].get<std::string>();
    if (n == "set") {
      const std::string k = op[1].get<std::string>();
      const auto& v = op[2];
      if (k == "fillStyle" && v.is_string()) g.fillStyle(v.get<std::string>());
      else if (k == "strokeStyle" && v.is_string()) g.strokeStyle(v.get<std::string>());
      else if (k == "lineWidth" && v.is_number()) g.lineWidth(v.get<float>());
      else if (k == "globalAlpha" && v.is_number()) g.globalAlpha(v.get<float>());
      else if (k == "font" && v.is_string()) g.font(v.get<std::string>());
      else if (k == "textAlign" && v.is_string()) g.textAlign(v.get<std::string>());
      else if (k == "textBaseline" && v.is_string()) g.textBaseline(v.get<std::string>());
      else if (k == "lineCap" && v.is_string() && exact) g.lineCap(v.get<std::string>());
    } else if (n == "setLineDash" && exact && op.size() >= 2 && op[1].is_array()) {
      std::vector<float> d;
      for (auto& x : op[1]) if (x.is_number()) d.push_back(x.get<float>());
      g.setLineDash(std::move(d));
    } else if (n == "fillRect") g.fillRect(F(op, 1), F(op, 2), F(op, 3), F(op, 4));
    else if (n == "strokeRect") g.strokeRect(F(op, 1), F(op, 2), F(op, 3), F(op, 4));
    else if (n == "clearRect") g.clearRect(F(op, 1), F(op, 2), F(op, 3), F(op, 4));
    else if (n == "fillText" && op.size() >= 4) g.fillText(op[1].is_string() ? op[1].get<std::string>() : op[1].dump(), F(op, 2), F(op, 3));
    else if (n == "beginPath") g.beginPath();
    else if (n == "closePath") g.closePath();
    else if (n == "moveTo") g.moveTo(F(op, 1), F(op, 2));
    else if (n == "lineTo") g.lineTo(F(op, 1), F(op, 2));
    else if (n == "rect") g.rect(F(op, 1), F(op, 2), F(op, 3), F(op, 4));
    else if (n == "roundRect") {
      float r = op.size() > 5 ? (op[5].is_array() && !op[5].empty() ? op[5][0].get<float>() : F(op, 5)) : 0;
      g.roundRect(F(op, 1), F(op, 2), F(op, 3), F(op, 4), r);
    } else if (n == "arc") g.arc(F(op, 1), F(op, 2), F(op, 3), F(op, 4), F(op, 5), op.size() > 6 && op[6].is_boolean() && op[6].get<bool>());
    else if (n == "arcTo") g.arcTo(F(op, 1), F(op, 2), F(op, 3), F(op, 4), F(op, 5));
    else if (n == "ellipse") g.ellipse(F(op, 1), F(op, 2), F(op, 3), F(op, 4), F(op, 5), F(op, 6), F(op, 7), op.size() > 8 && op[8].is_boolean() && op[8].get<bool>());
    else if (n == "quadraticCurveTo") g.quadraticCurveTo(F(op, 1), F(op, 2), F(op, 3), F(op, 4));
    else if (n == "bezierCurveTo") g.bezierCurveTo(F(op, 1), F(op, 2), F(op, 3), F(op, 4), F(op, 5), F(op, 6));
    else if (n == "fill") g.fill();
    else if (n == "stroke") g.stroke();
    else if (n == "clip") g.clip();
    else if (n == "save") g.save();
    else if (n == "restore") g.restore();
    else if (n == "translate") g.translate(F(op, 1), F(op, 2));
    else if (n == "rotate") g.rotate(F(op, 1));
    else if (n == "scale") g.scale(F(op, 1), F(op, 2, F(op, 1)));
    else if (n == "setTransform" && op.size() >= 7) g.setTransform(F(op, 1), F(op, 2), F(op, 3), F(op, 4), F(op, 5), F(op, 6));
    else if (n == "resetTransform") g.setTransform(1, 0, 0, 1, 0, 0);
    else if (n == "putAlpha" && op.size() >= 6) {
      auto z = b64(op[5].get<std::string>());
      Inflate inf{z.data(), z.size()};
      if (inf.run()) g.putAlpha(int(F(op, 1)), int(F(op, 2)), int(F(op, 3)), int(F(op, 4)), inf.out);
    } else if (n == "putImage" && exact && op.size() >= 6 && op[5].is_string()) {
      auto z = b64(op[5].get<std::string>());
      Inflate inf{z.data(), z.size()};
      if (inf.run()) g.putImage(int(F(op, 1)), int(F(op, 2)), int(F(op, 3)), int(F(op, 4)), inf.out);
    }
  }
  const auto& px = g.pixels();
  int W = g.width(), H = g.height();
  std::vector<uint8_t> flip(px.size());   // (CanvasTexture flipY)
  for (int y = 0; y < H; y++) std::memcpy(&flip[size_t(y) * W * 4], &px[size_t(H - 1 - y) * W * 4], size_t(W) * 4);
  // (Phase 7) the quality preset's texture cap (512 on Switch): box-halved until it fits
  while ((W > cap || H > cap) && W > 1 && H > 1) {
    int w2 = W / 2, h2 = H / 2;
    std::vector<uint8_t> o(size_t(w2) * h2 * 4);
    for (int y = 0; y < h2; y++) for (int x = 0; x < w2; x++) for (int k = 0; k < 4; k++)
      o[(size_t(y) * w2 + x) * 4 + k] = uint8_t((flip[(size_t(2 * y) * W + 2 * x) * 4 + k] + flip[(size_t(2 * y) * W + 2 * x + 1) * 4 + k] +
                                                 flip[(size_t(2 * y + 1) * W + 2 * x) * 4 + k] + flip[(size_t(2 * y + 1) * W + 2 * x + 1) * 4 + k] + 2) / 4);
    flip.swap(o); W = w2; H = h2;
  }
  gfx::TextureDesc d;
  d.width = W; d.height = H; d.format = gfx::TexFormat::SRGBA8; d.anisotropy = exact ? 16 : 8;   // (village.js: the map's anisotropy 16)
  if (compress && W >= 4 && H >= 4 && dev.supportsBC(true)) {   // (Phase 7, the switch preset: BC1 / BC3)
    std::vector<std::vector<uint8_t>> levels;
    bool bc3 = false;
    compressBC(flip.data(), W, H, levels, bc3);
    return dev.createCompressedTexture(d, bc3, true, levels);
  }
  return dev.createTexture(d, flip.data());
}

glm::dmat4 mat34(const nlohmann::json& a) {
  glm::dmat4 m(1);
  for (int r = 0; r < 3; r++) for (int c = 0; c < 4; c++) m[c][r] = a[size_t(r * 4 + c)].get<double>();
  return m;
}
// an instance list: inline (`inst`: rows of 12) or in the bin (`instOff` / `instN`: float32 x 12 each)
std::vector<glm::dmat4> instList(const nlohmann::json& e, const std::vector<uint8_t>& bin) {
  std::vector<glm::dmat4> out;
  if (e.contains("inst")) { for (auto& a : e["inst"]) out.push_back(mat34(a)); return out; }
  size_t off = e.value("instOff", size_t(0)), n = e.value("instN", size_t(0));
  if (off + n * 48 > bin.size()) return out;
  const float* f = reinterpret_cast<const float*>(bin.data() + off);
  for (size_t i = 0; i < n; i++, f += 12) {
    glm::dmat4 m(1);
    for (int r = 0; r < 3; r++) for (int c = 0; c < 4; c++) m[c][r] = f[r * 4 + c];
    out.push_back(m);
  }
  return out;
}

std::shared_ptr<Model> modelFromBin(gfx::Device& dev, const uint8_t* bin, size_t binSize, const nlohmann::json& m, const Material& mat,
                                    dvec3* bmin = nullptr, dvec3* bmax = nullptr) {
  size_t verts = m["verts"], tris = m["tris"], vOff = m["vOff"], iOff = m["iOff"];
  bool i16 = m.value("i16", false);
  if (vOff + verts * 28 > binSize || iOff + tris * 3 * (i16 ? 2 : 4) > binSize || !verts || !tris) return nullptr;
  auto model = std::make_shared<Model>();
  Primitive p;
  // 28 bytes a vertex (export_resort.mjs packGeo): position f32 x3, normal i8 x3, uv f32 x2, colour u8 x3 (sqrt)
  for (size_t i = 0; i < verts; i++) {
    vec3 q;
    std::memcpy(&q, bin + vOff + i * 28, 12);
    p.bmin = glm::min(p.bmin, q); p.bmax = glm::max(p.bmax, q);
  }
  std::vector<uint32_t> idx(tris * 3);
  if (i16) { const uint16_t* s16 = reinterpret_cast<const uint16_t*>(bin + iOff); for (size_t i = 0; i < idx.size(); i++) idx[i] = s16[i]; }
  else std::memcpy(idx.data(), bin + iOff, idx.size() * 4);
  p.stride = 28; p.hasColor = true; p.packed = true;
  p.vbo = dev.createBuffer(gfx::BufferUsage::Vertex, bin + vOff, verts * 28);
  p.ibo = dev.createBuffer(gfx::BufferUsage::Index, idx.data(), idx.size() * 4);
  p.lods.push_back({0, uint32_t(idx.size())});
  const uint32_t st = 28;
  p.input = dev.createVertexInput({{0, 0, 3, gfx::AttribType::Float, false, 0, st}, {1, 0, 3, gfx::AttribType::Byte, true, 12, st},
                                   {2, 0, 2, gfx::AttribType::Float, false, 16, st}, {7, 0, 3, gfx::AttribType::UByte, true, 24, st}},
                                  {p.vbo}, p.ibo);
  p.material = 0;
  model->materials.push_back(mat);
  model->materials.back().colorSqrt = true;
  model->bmin = p.bmin; model->bmax = p.bmax;
  if (bmin) *bmin = dvec3(p.bmin);
  if (bmax) *bmax = dvec3(p.bmax);
  Mesh mesh;
  mesh.primitives.push_back(std::move(p));
  model->meshes.push_back(std::move(mesh));
  Node n; n.mesh = 0;
  model->nodes.push_back(n);
  model->roots.push_back(0);
  return model;
}
} // namespace

bool Resort::load(platform::Platform& plat, const AssetPaths& paths, Scenery& scenery) {
  { std::vector<uint8_t> f; if (plat.readFile(paths.data("fonts/barlow-condensed-500.ttf"), f)) fonts_.regular.load(std::move(f)); }
  { std::vector<uint8_t> f; if (plat.readFile(paths.data("fonts/barlow-condensed-700.ttf"), f)) fonts_.bold.load(std::move(f)); }
  std::vector<Collider> cols;
  size_t nSurf = 0;
  if (!loadPack(plat, paths, "resort", cols, nSurf)) return false;
  size_t nResort = nProps_;
  if (!loadPack(plat, paths, "transport", cols, nSurf)) SL_WARN("transport: native/data/transport.json missing (Phase 3 data; node native/tools/export_resort.mjs)");
  if (!loadPack(plat, paths, "play", cols, nSurf)) SL_WARN("play: native/data/play.json missing (Phase 5 data; node native/tools/export_resort.mjs)");
  scenery.setColliders(std::move(cols));
  SL_INFO("resort + transport: %zu props (%zu resort), %zu mesh chunks, %zu gondola stations, %zu colliders, %zu surfaces", nProps_, nResort, chunks_.size(),
          stations_.size(), scenery.colliders().size(), nSurf);
  return true;
}

const nlohmann::json* Resort::playData() const {
  if (!pjson_ || !pjson_->contains("play")) return nullptr;
  return &(*pjson_)["play"];
}

const nlohmann::json* Resort::transportNet() const {
  if (!tjson_ || !tjson_->contains("net")) return nullptr;
  return &(*tjson_)["net"];
}

std::shared_ptr<Model> Resort::transportModel(const nlohmann::json& parts) {
  auto model = std::make_shared<Model>();
  Mesh mesh;
  for (auto& p : parts) {
    int mi = p["mat"];
    auto m = modelFromBin(dev_, tbin_.data(), tbin_.size(), p, mi >= 0 && size_t(mi) < tmats_.size() ? tmats_[size_t(mi)] : Material{});
    if (!m) continue;
    Primitive pr = std::move(m->meshes[0].primitives[0]);
    pr.material = int(model->materials.size());
    model->materials.push_back(m->materials[0]);
    model->bmin = glm::min(model->bmin, pr.bmin); model->bmax = glm::max(model->bmax, pr.bmax);
    mesh.primitives.push_back(std::move(pr));
  }
  if (mesh.primitives.empty()) return nullptr;
  model->meshes.push_back(std::move(mesh));
  Node n; n.mesh = 0;
  model->nodes.push_back(n);
  model->roots.push_back(0);
  return model;
}

bool Resort::loadPack(platform::Platform& plat, const AssetPaths& paths, const std::string& name, std::vector<Collider>& cols, size_t& nSurf) {
  auto jp = std::make_shared<nlohmann::json>();
  std::vector<uint8_t> jb, bin;
  if (!paths.readData(plat, name + ".json", jb) || !paths.readData(plat, name + ".bin", bin)) {
    SL_WARN("%s: native/data/%s.json / .bin missing (node native/tools/export_resort.mjs)", name.c_str(), name.c_str());
    return false;
  }
  *jp = nlohmann::json::parse(jb.begin(), jb.end(), nullptr, false);
  nlohmann::json& j = *jp;
  if (j.is_discarded()) return false;
  jb.clear(); jb.shrink_to_fit();
  size_t props0 = nProps_, chunks0 = chunks_.size(), cols0 = cols.size();

  ModelLoadOptions mo;
  mo.maxTextureSize = 1024;
  mo.lodRatios = {0.08f};   // a light copy for props seen from afar

  // ---- canvas textures (on demand) and materials
  std::map<int, gfx::Texture> canvasTex;
  auto canvas = [&](const nlohmann::json& ref) -> gfx::Texture {
    if (!ref.is_object()) return {};
    int id = ref["canvas"];
    auto it = canvasTex.find(id);
    if (it != canvasTex.end()) return it->second;
    gfx::Texture t;
    auto c = j["canvases"].find(std::to_string(id));
    if (c != j["canvases"].end()) t = replayCanvas(dev_, *c, fonts_, std::min(textureCap, 2048), compressTextures);
    canvasTex[id] = t;
    return t;
  };
  std::vector<Material> mats;
  for (auto& m : j["materials"]) {
    Material M;
    if (m["glb"].is_object()) {
      auto gm = assets_.model(m["glb"]["model"].get<std::string>(), mo);
      int idx = m["glb"]["index"];
      if (gm && idx >= 0 && size_t(idx) < gm->materials.size()) M = gm->materials[size_t(idx)];
    } else {
      auto& c = m["color"];
      M.baseColor = vec4(c[0].get<float>(), c[1].get<float>(), c[2].get<float>(), m.value("opacity", 1.f));
      M.roughness = m.value("rough", 0.8f);
      M.metallic = m.value("metal", 0.f);
      M.baseTex = canvas(m["map"]);
    }
    M.doubleSided = m.value("double", false) || M.doubleSided;
    M.vertexColor = m.value("vc", false);
    auto& e = m["emissive"];
    M.emissive = vec3(e[0].get<float>(), e[1].get<float>(), e[2].get<float>());
    M.emissiveTex = canvas(m["emissiveMap"]);
    if (m["night"].is_array()) { float d = m["night"][0], n = m["night"][1]; M.emissiveNight = vec2(d, n - d); }
    float ne = m.value("nightEmissive", 0.f);
    if (ne > 0) { M.emissive = vec3(1); M.emissiveNight = vec2(0, ne); }
    M.glow = m.value("glow", 0.f);
    if (m.value("alphaTest", 0.f) > 0) { M.alpha = Material::Alpha::Mask; M.alphaCutoff = m["alphaTest"]; }
    else if (m.value("transparent", false)) M.alpha = Material::Alpha::Blend;
    if (m.value("basic", false)) { M.roughness = 1; M.metallic = 0; }
    mats.push_back(M);
  }
  auto matAt = [&](int i) { return i >= 0 && size_t(i) < mats.size() ? mats[size_t(i)] : Material{}; };

  // ---- instanced sets (GLB props and repeated procedural pieces), split into 512 m cells
  auto addSet = [&](std::shared_ptr<Model> model, const std::vector<glm::dmat4>& inst, float glow, bool shadow) {
    if (!model) return;
    if (glow > 0) { auto m2 = std::make_shared<Model>(*model); for (auto& mt : m2->materials) mt.glow = glow; model = m2; }
    if (model->name == "lamp_post") {   // (Phase 7) the head: the top of the bounds, over the box's centre
      vec3 c = (model->bmin + model->bmax) * 0.5f;
      for (const glm::dmat4& M : inst) lamps_.push_back(dvec3(M * glm::dvec4(c.x, model->bmax.y * 0.96, c.z, 1)));
    }
    if (model->name == "snow_cannon") for (const glm::dmat4& M : inst) cannons_.push_back(M);
    PropSet ps;
    ps.model = model;
    ps.shadow = shadow;
    vec3 dim = model->bmax - model->bmin;
    std::map<int64_t, size_t> cellOf;
    for (const glm::dmat4& M : inst) {
      double sc = std::cbrt(std::fabs(glm::determinant(glm::dmat3(M))));
      ps.radius = std::max(ps.radius, float(glm::length(dim) * 0.5 * sc));
      int64_t cx = int64_t(std::floor(M[3][0] / PROP_CELL)), cz = int64_t(std::floor(M[3][2] / PROP_CELL));
      int64_t k = (cx << 32) ^ (cz & 0xffffffff);
      auto it = cellOf.find(k);
      if (it == cellOf.end()) {
        it = cellOf.emplace(k, ps.cells.size()).first;
        ps.cells.emplace_back();
        ps.cells.back().origin = dvec3((double(cx) + 0.5) * PROP_CELL, M[3][1], (double(cz) + 0.5) * PROP_CELL);
      }
      Cell& c = ps.cells[it->second];
      c.inst.push_back(M);
      c.bmin = glm::min(c.bmin, dvec3(M[3])); c.bmax = glm::max(c.bmax, dvec3(M[3]));
      nProps_++;
    }
    for (Cell& c : ps.cells) {
      c.radius = ps.radius;
      for (auto& b : c.lod) b.init(dev_, *model, uint32_t(c.inst.size()));
    }
    props_.push_back(std::move(ps));
  };
  for (auto& p : j["props"]) addSet(assets_.model(p["model"].get<std::string>(), mo), instList(p, bin), p.value("glow", 0.f), true);
  for (auto& m : j["instanced"]) addSet(modelFromBin(dev_, bin.data(), bin.size(), m, matAt(m["mat"])), instList(m, bin), 0, true);

  // ---- baked procedural meshes
  // (Phase 7) kept packed on the CPU and uploaded when the camera comes near (streamChunks)
  for (auto& m : j["meshes"]) {
    Chunk c;
    Material M = matAt(m["mat"]);
    size_t verts = m["verts"], tris = m["tris"], vOff = m["vOff"], iOff = m["iOff"];
    bool i16 = m.value("i16", false);
    size_t ib = tris * 3 * (i16 ? 2 : 4);
    if (vOff + verts * 28 > bin.size() || iOff + ib > bin.size() || !verts || !tris) continue;
    vec3 mn(1e30f), mx(-1e30f);
    for (size_t i = 0; i < verts; i++) { vec3 q; std::memcpy(&q, bin.data() + vOff + i * 28, 12); mn = glm::min(mn, q); mx = glm::max(mx, q); }
    c.origin = dvec3(m["origin"][0].get<double>(), m["origin"][1].get<double>(), m["origin"][2].get<double>());
    c.bmin = c.origin + dvec3(mn); c.bmax = c.origin + dvec3(mx);
    c.shadow = M.alpha != Material::Alpha::Blend;
    c.mat = M; c.verts = verts; c.tris = tris; c.i16 = i16; c.raw = verts * 28 + ib;
    std::vector<uint8_t> rawb(c.raw);
    std::memcpy(rawb.data(), bin.data() + vOff, verts * 28);
    std::memcpy(rawb.data() + verts * 28, bin.data() + iOff, ib);
    c.packed.resize(ZSTD_compressBound(c.raw));
    size_t n = ZSTD_compress(c.packed.data(), c.packed.size(), rawb.data(), rawb.size(), 1);
    if (ZSTD_isError(n)) continue;
    c.packed.resize(n);
    c.packed.shrink_to_fit();
    stream_.packedBytes += n; stream_.rawBytes += c.raw;
    chunks_.push_back(std::move(c));
  }
  stream_.chunks = chunks_.size();

  // ---- the gondola stations (gondolastation.js, built here)
  for (auto& s : j["stations"]) {
    GondolaStationParams p;
    p.mid = s["kind"] == "mid";
    p.top = s.value("top", false);
    p.x = s["x"]; p.y = s["y"]; p.z = s["z"]; p.yaw = s["yaw"];
    p.mx = s.value("mx", 1);
    p.side = s["side"]; p.ropeY = s["ropeY"]; p.carH = s["carH"];
    p.name = s.value("name", std::string()); p.place = s.value("place", std::string());
    p.up = s.value("up", std::string()); p.down = s.value("down", std::string());
    for (auto& r : s["rope"]) {
      float a = r[0].is_number() ? r[0].get<float>() : std::nanf(""), b = r[1].is_number() ? r[1].get<float>() : std::nanf("");
      p.rope.push_back(vec2(a, b));
    }
    auto m = buildGondolaStation(dev_, world_, fonts_, p);
    if (!m) continue;
    Placed pl;
    pl.model = m;
    pl.pos = dvec3(p.x, p.y, p.z);
    pl.local = glm::rotate(mat4(1), float(p.yaw), vec3(0, 1, 0));
    pl.radius = glm::length(m->bmax - m->bmin) * 0.5f + 2;
    stations_.push_back(pl);
  }

  // ---- lifts, colliders, walkable surfaces
  if (j.contains("lifts")) lifts_.load(dev_, assets_, j["lifts"]);
  for (auto& c : j["colliders"]) {
    Collider k;
    k.x = c["x"]; k.z = c["z"];
    if (c.contains("r")) k.r = c["r"];
    else { k.hw = c["hw"]; k.hd = c["hd"]; k.rot = c.value("rot", 0.0); }
    if (c.contains("top")) k.top = c["top"];
    k.soft = c.value("soft", 0) != 0;
    k.rail = c.value("rail", 0) != 0;
    k.brk = c.value("brk", 0.0);
    k.lamp = c.value("lamp", 0) != 0;
    cols.push_back(k);
  }
  for (auto& s : j["surfaces"]) {
    SampledSurface S;
    S.x0 = s["x0"]; S.z0 = s["z0"]; S.step = s["step"]; S.nx = s["nx"]; S.nz = s["nz"]; S.base = s["base"];
    size_t off = s["off"], n = size_t(S.nx) * size_t(S.nz);
    if (off + n * 2 > bin.size()) continue;
    S.h.resize(n);
    std::memcpy(S.h.data(), bin.data() + off, n * 2);
    world_.addSurface(std::move(S));
    nSurf++;
  }
  SL_INFO("%s: %zu props, %zu mesh chunks, %zu canvases, %zu colliders", name.c_str(), nProps_ - props0, chunks_.size() - chunks0, canvasTex.size(), cols.size() - cols0);
  if (name == "transport") { tjson_ = jp; tbin_ = std::move(bin); tmats_ = mats; }
  if (name == "play") { pjson_ = jp; pbin_ = std::move(bin); }
  return true;
}

void Resort::releaseLoadData() {
  tjson_.reset(); pjson_.reset();
  std::vector<uint8_t>().swap(tbin_);
  std::vector<uint8_t>().swap(pbin_);
  std::vector<Material>().swap(tmats_);
}

void Resort::rebuild(const dvec3& cam) {
  lastBuild_ = cam;
  std::vector<MatrixInstanceBatch::Inst> l0, l1;
  for (PropSet& ps : props_) {
    double nearD = std::max(150.0, double(ps.radius) * 12) * lodScale, farD = std::max(900.0, double(ps.radius) * 120) * lodScale;
    for (Cell& c : ps.cells) {
      l0.clear(); l1.clear();
      for (const glm::dmat4& M : c.inst) {
        double d = glm::length(dvec3(M[3]) - cam);
        if (d > farD) continue;
        (d < nearD ? l0 : l1).push_back(MatrixInstanceBatch::pack(M, c.origin));
      }
      c.lod[0].upload(dev_, l0);
      c.lod[1].upload(dev_, l1);
    }
  }
}

void Resort::update(double dt, const dvec3& cam) {
  (void)dt;   // (the lifts are moved by the game before the rider is seated: Lifts::update)
  if (glm::length(cam - lastBuild_) > 8) rebuild(cam);
  streamChunks(cam, false);
}

// (Phase 7) chunks within loadRadius uploaded (nearest first, up to ~6 MB a frame unless `all`), past +400 m released
void Resort::streamChunks(const dvec3& cam, bool all) {
  const double inR = loadRadius(), outR = inR + 400;
  std::vector<std::pair<double, size_t>> want;
  for (size_t i = 0; i < chunks_.size(); i++) {
    Chunk& c = chunks_[i];
    double d = glm::length(glm::clamp(cam, c.bmin, c.bmax) - cam);
    if (c.model && d > outR) {
      for (auto& mesh : c.model->meshes)
        for (auto& p : mesh.primitives) { dev_.destroy(p.input); dev_.destroy(p.vbo); dev_.destroy(p.ibo); }
      c.model.reset();
      stream_.loaded--; stream_.gpuBytes -= c.verts * 28 + c.tris * 12; stream_.releases++;
    } else if (!c.model && d < inR) want.push_back({d, i});
  }
  std::sort(want.begin(), want.end());
  size_t budget = all ? SIZE_MAX : size_t(6) << 20, spent = 0;
  std::vector<uint8_t> raw;
  for (auto& [d, i] : want) {
    Chunk& c = chunks_[i];
    if (spent > budget) break;
    raw.resize(c.raw);
    if (ZSTD_isError(ZSTD_decompress(raw.data(), raw.size(), c.packed.data(), c.packed.size()))) continue;
    nlohmann::json m = {{"verts", c.verts}, {"tris", c.tris}, {"vOff", 0}, {"iOff", c.verts * 28}, {"i16", c.i16}};
    c.model = modelFromBin(dev_, raw.data(), raw.size(), m, c.mat);
    if (!c.model) continue;
    spent += c.raw;
    stream_.loaded++; stream_.gpuBytes += c.verts * 28 + c.tris * 12; stream_.uploads++;
  }
}

void Resort::submit(Renderer& r, bool props, bool meshes) {
  const dvec3 cam = r.camera().pos;
  if (props) for (const PropSet& ps : props_)
    for (const Cell& c : ps.cells) {
      dvec3 e(c.radius);
      dvec3 mn = c.bmin - e, mx = c.bmax + e;
      bool vis = r.visible(mn, mx), cast = ps.shadow && r.castsShadow(mn, mx);
      if (!vis && !cast) continue;
      if (c.lod[0].count()) r.submitInstances(c.lod[0], c.origin, 0, cast);
      if (c.lod[1].count() && vis) r.submitInstances(c.lod[1], c.origin, 1, false);
    }
  if (meshes) {
    for (const Chunk& c : chunks_) {
      if (!c.model) continue;
      dvec3 q = glm::clamp(cam, c.bmin, c.bmax);
      double d = glm::length(q - cam);
      if (d > 1800 * lodScale) continue;
      bool vis = r.visible(c.bmin, c.bmax), cast = c.shadow && d < 300 && r.castsShadow(c.bmin, c.bmax);
      if (!vis && !cast) continue;
      r.submitModel(*c.model, c.origin, mat4(1), nullptr, cast, 0, vis);
    }
    for (const Placed& p : stations_) {
      double d = glm::length(p.pos - cam);
      if (d > 3000 * lodScale) continue;
      dvec3 ext(p.radius);
      bool vis = r.visible(p.pos - ext, p.pos + ext), cast = r.castsShadow(p.pos - ext, p.pos + ext);
      if (!vis && !cast) continue;
      r.submitModel(*p.model, p.pos, p.local, nullptr, cast, 0, vis);
    }
  }
  lifts_.submit(r, cam);
}

} // namespace sl
