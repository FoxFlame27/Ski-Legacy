#define CGLTF_IMPLEMENTATION
#include <cgltf.h>
#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_STDIO
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#include <stb_image.h>

#include "engine/asset_manager.h"
#include <unordered_map>
#include "engine/texcompress.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"

#include <meshoptimizer.h>
#include <webp/decode.h>
#include <cctype>
#include <cstring>
#include <future>
#include <filesystem>
#include <thread>
#include <fstream>
#include <map>
#include <cstdlib>
#include <cstring>
#include <functional>

namespace sl {

namespace {
struct Image { int w = 0, h = 0; std::vector<uint8_t> rgba; std::vector<std::vector<uint8_t>> levels; bool bc3 = false, bc5 = false; };

// ---- the block-compressed textures' disk cache: compressing a model's maps on the CPU is the slow part of the load
// (a 4096 px colour map is ~1 s); the result is kept per (image bytes, size cap, format) under the save folder, so
// only the first start pays for it
uint64_t fnv64(const uint8_t* p, size_t n, uint64_t h = 1469598103934665603ull) {
  for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ull; }
  return h;
}
constexpr uint32_t kTexCacheMagic = 0x53544331;   // 'STC1'
bool texCacheRead(const std::string& file, Image& im) {
  std::ifstream f(std::filesystem::path(file), std::ios::binary);
  if (!f) return false;
  uint32_t hd[6] = {};
  if (!f.read(reinterpret_cast<char*>(hd), sizeof hd) || hd[0] != kTexCacheMagic || hd[5] > 20) return false;
  Image o; o.w = int(hd[1]); o.h = int(hd[2]); o.bc3 = hd[3] & 1; o.bc5 = (hd[3] & 2) != 0;
  o.levels.resize(hd[5]);
  for (auto& l : o.levels) {
    uint32_t n = 0;
    if (!f.read(reinterpret_cast<char*>(&n), 4) || n > (64u << 20)) return false;
    l.resize(n);
    if (!f.read(reinterpret_cast<char*>(l.data()), std::streamsize(n))) return false;
  }
  if (o.levels.empty()) return false;
  im.w = o.w; im.h = o.h; im.bc3 = o.bc3; im.bc5 = o.bc5; im.levels = std::move(o.levels);
  return true;
}
void texCacheWrite(const std::string& file, const Image& im) {
  std::error_code ec;
  std::filesystem::create_directories(std::filesystem::path(file).parent_path(), ec);
  const std::string tmp = file + ".tmp" + std::to_string(std::hash<std::thread::id>{}(std::this_thread::get_id()));
  {
    std::ofstream f(std::filesystem::path(tmp), std::ios::binary);
    if (!f) return;
    uint32_t hd[6] = {kTexCacheMagic, uint32_t(im.w), uint32_t(im.h), uint32_t((im.bc3 ? 1 : 0) | (im.bc5 ? 2 : 0)), 0, uint32_t(im.levels.size())};
    f.write(reinterpret_cast<const char*>(hd), sizeof hd);
    for (const auto& l : im.levels) { uint32_t n = uint32_t(l.size()); f.write(reinterpret_cast<const char*>(&n), 4); f.write(reinterpret_cast<const char*>(l.data()), std::streamsize(n)); }
    if (!f) { f.close(); std::filesystem::remove(std::filesystem::path(tmp), ec); return; }
  }
  std::filesystem::rename(std::filesystem::path(tmp), std::filesystem::path(file), ec);
}

bool decodeImage(const uint8_t* data, size_t size, const char* mime, Image& out) {
  bool webp = (mime && std::string(mime) == "image/webp") || (size > 12 && std::memcmp(data, "RIFF", 4) == 0 && std::memcmp(data + 8, "WEBP", 4) == 0);
  if (webp) {
    int w = 0, h = 0;
    uint8_t* px = WebPDecodeRGBA(data, size, &w, &h);
    if (!px) return false;
    out.w = w; out.h = h;
    out.rgba.assign(px, px + size_t(w) * h * 4);
    WebPFree(px);
    return true;
  }
  int w, h, c;
  stbi_uc* px = stbi_load_from_memory(data, int(size), &w, &h, &c, 4);
  if (!px) return false;
  out.w = w; out.h = h;
  out.rgba.assign(px, px + size_t(w) * h * 4);
  stbi_image_free(px);
  return true;
}

void downsample(Image& im, int maxSize) {
  while (im.w > maxSize || im.h > maxSize) {
    int w = std::max(1, im.w / 2), h = std::max(1, im.h / 2);
    std::vector<uint8_t> o(size_t(w) * h * 4);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) for (int c = 0; c < 4; c++) {
      int sx = std::min(im.w - 1, x * 2), sy = std::min(im.h - 1, y * 2);
      int sx1 = std::min(im.w - 1, sx + 1), sy1 = std::min(im.h - 1, sy + 1);
      int s = im.rgba[(size_t(sy) * im.w + sx) * 4 + c] + im.rgba[(size_t(sy) * im.w + sx1) * 4 + c] +
              im.rgba[(size_t(sy1) * im.w + sx) * 4 + c] + im.rgba[(size_t(sy1) * im.w + sx1) * 4 + c];
      o[(size_t(y) * w + x) * 4 + c] = uint8_t((s + 2) / 4);
    }
    im.w = w; im.h = h; im.rgba.swap(o);
  }
}

/// EXT_meshopt_compression: decode every compressed buffer view into memory cgltf then reads through bv->data.
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
    if (rc != 0) { free(dst); SL_ERROR("meshopt decode failed (%d)", rc); return false; }
    switch (mc.filter) {
      case cgltf_meshopt_compression_filter_octahedral: meshopt_decodeFilterOct(dst, mc.count, mc.stride); break;
      case cgltf_meshopt_compression_filter_quaternion: meshopt_decodeFilterQuat(dst, mc.count, mc.stride); break;
      case cgltf_meshopt_compression_filter_exponential: meshopt_decodeFilterExp(dst, mc.count, mc.stride); break;
      default: break;
    }
    bv.data = dst; // cgltf_free releases it
  }
  return true;
}

std::vector<float> unpack(const cgltf_accessor* a, int comps) {
  std::vector<float> out(a->count * size_t(comps));
  if (cgltf_num_components(a->type) == cgltf_size(comps)) cgltf_accessor_unpack_floats(a, out.data(), out.size());
  else for (cgltf_size i = 0; i < a->count; i++) cgltf_accessor_read_float(a, i, &out[i * comps], comps);
  return out;
}
} // namespace

std::string AssetManager::modelPath(const std::string& name) const { return paths_.model(name); }

std::shared_ptr<Model> AssetManager::model(const std::string& name, const ModelLoadOptions& opt) {
  auto it = cache_.find(name);
  if (it != cache_.end()) return it->second;
  const std::string tagBefore = dev_.memTag("model " + name);
  const double t0 = p_.timeSeconds();
  auto m = loadFile(paths_.model(name), name, opt);
  dev_.memTag(tagBefore);
  const double ms = (p_.timeSeconds() - t0) * 1000;
  lateLoadMs += ms;
  if (logLateLoads) SL_INFO("[hitch] model '%s' loaded on the main thread during play: %.1f ms", name.c_str(), ms);
  cache_[name] = m;
  if (onLoaded) onLoaded();   // (the loading screen keeps turning between the models)
  return m;
}

std::shared_ptr<Model> AssetManager::loadFile(const std::string& path, const std::string& name, const ModelLoadOptions& opt) {
  std::vector<uint8_t> bytes;
  if (!p_.readFile(path, bytes)) { SL_ERROR("model not found: %s", path.c_str()); return nullptr; }
  cgltf_options co{};
  cgltf_data* d = nullptr;
  if (cgltf_parse(&co, bytes.data(), bytes.size(), &d) != cgltf_result_success) { SL_ERROR("bad glTF: %s", path.c_str()); return nullptr; }
  std::unique_ptr<cgltf_data, void (*)(cgltf_data*)> guard(d, cgltf_free);
  if (cgltf_load_buffers(&co, d, path.c_str()) != cgltf_result_success) { SL_ERROR("glTF buffers: %s", path.c_str()); return nullptr; }
  if (!decodeMeshopt(d)) return nullptr;

  auto model = std::make_shared<Model>();
  model->name = name;
  auto nodeIndex = [&](const cgltf_node* n) { return int(n - d->nodes); };

  // ---- nodes, ordered parents first (Model::finishPose relies on it)
  std::vector<int> order, remap(d->nodes_count, -1);
  std::function<void(const cgltf_node*)> visit = [&](const cgltf_node* n) {
    remap[size_t(nodeIndex(n))] = int(order.size());
    order.push_back(nodeIndex(n));
    for (cgltf_size c = 0; c < n->children_count; c++) visit(n->children[c]);
  };
  for (cgltf_size i = 0; i < d->nodes_count; i++) if (!d->nodes[i].parent) visit(&d->nodes[i]);
  model->nodes.resize(order.size());
  for (size_t k = 0; k < order.size(); k++) {
    const cgltf_node& n = d->nodes[size_t(order[k])];
    Node& o = model->nodes[k];
    o.name = n.name ? n.name : "";
    o.parent = n.parent ? remap[size_t(nodeIndex(n.parent))] : -1;
    if (o.parent < 0) model->roots.push_back(int(k));
    else model->nodes[size_t(o.parent)].children.push_back(int(k));
    if (n.has_matrix) {
      mat4 m = glm::make_mat4(n.matrix);
      o.t = vec3(m[3]);
      o.s = vec3(glm::length(vec3(m[0])), glm::length(vec3(m[1])), glm::length(vec3(m[2])));
      o.r = glm::quat_cast(mat3(vec3(m[0]) / o.s.x, vec3(m[1]) / o.s.y, vec3(m[2]) / o.s.z));
    } else {
      if (n.has_translation) o.t = vec3(n.translation[0], n.translation[1], n.translation[2]);
      if (n.has_rotation) o.r = quat(n.rotation[3], n.rotation[0], n.rotation[1], n.rotation[2]);
      if (n.has_scale) o.s = vec3(n.scale[0], n.scale[1], n.scale[2]);
    }
    o.mesh = n.mesh ? int(n.mesh - d->meshes) : -1;
    o.skin = n.skin ? int(n.skin - d->skins) : -1;
  }

  // ---- textures (decoded in parallel)
  std::vector<gfx::Texture> texOf(d->textures_count);
  std::vector<bool> srgb(d->textures_count, false);
  std::vector<bool> isNormal(d->textures_count, false);
  for (cgltf_size i = 0; i < d->materials_count; i++) {
    const cgltf_material& m = d->materials[i];
    if (m.normal_texture.texture) isNormal[size_t(m.normal_texture.texture - d->textures)] = true;
    if (m.pbr_metallic_roughness.base_color_texture.texture) srgb[size_t(m.pbr_metallic_roughness.base_color_texture.texture - d->textures)] = true;
    if (m.emissive_texture.texture) srgb[size_t(m.emissive_texture.texture - d->textures)] = true;
  }
  std::vector<std::shared_ptr<CpuImage>> lodImg;
  const bool lodCol = opt.lodVertexColor && (!opt.lodRatios.empty() || !opt.lodCluster.empty());
  {
    std::vector<std::future<Image>> jobs;
    for (cgltf_size i = 0; i < d->textures_count; i++) {
      const cgltf_texture& t = d->textures[i];
      const cgltf_image* img = t.has_webp && t.webp_image ? t.webp_image : t.image;
      // the size cap: the model's own budget x the preset's scale for the colour maps (what the eye reads as sharp or
      // blurry); normal / roughness maps keep the model's budget. Block compression (1/8 - 1/4 of the memory) pays
      // for the larger colour maps; normal maps stay uncompressed (BC1 blocks show in the highlights)
      int cap = std::min(srgb[i] ? std::max(opt.colorTextureSize, opt.maxTextureSize * std::max(1, textureScale)) : opt.maxTextureSize, textureCap);
      bool bc = compressTextures && dev_.supportsBC(srgb[i]) && !isNormal[i];   // (keepCpu too: the CPU copy is the RGBA kept beside the blocks)
      // (normal maps: BC5, two channels at 8 bits a pixel, the shader rebuilds z; not one that is a colour map as well)
      bool bc5 = compressTextures && dev_.supportsRG() && isNormal[i] && !srgb[i];
      const bool needRgba = lodCol || opt.keepCpu;   // (the LODs' colours / the outfits read the pixels)
      const std::string cacheRoot = (bc || bc5) && !texCacheDir.empty() ? texCacheDir : std::string();
      jobs.push_back(std::async(std::launch::async, [img, cap, bc, bc5, needRgba, cacheRoot]() {
        Image im;
        if (!img || !img->buffer_view) return im;
        const uint8_t* data = cgltf_buffer_view_data(img->buffer_view);
        if (!data) return Image{};
        std::string cacheFile;
        if (!cacheRoot.empty()) {
          uint64_t h = fnv64(data, img->buffer_view->size);
          const int key[3] = {cap, bc ? 1 : 0, bc5 ? 1 : 0};
          h = fnv64(reinterpret_cast<const uint8_t*>(key), sizeof key, h);
          char nm[40]; std::snprintf(nm, sizeof nm, "%016llx.bc", (unsigned long long)h);
          cacheFile = cacheRoot + nm;
          if (!needRgba && texCacheRead(cacheFile, im)) return im;   // (the blocks from an earlier start: no decode at all)
        }
        if (!decodeImage(data, img->buffer_view->size, img->mime_type, im)) return Image{};
        downsample(im, cap);
        if (!cacheFile.empty() && needRgba) { Image c; if (texCacheRead(cacheFile, c) && c.w == im.w && c.h == im.h) { im.levels = std::move(c.levels); im.bc3 = c.bc3; im.bc5 = c.bc5; return im; } }
        if (bc && im.w >= 4 && im.h >= 4) compressBC(im.rgba.data(), im.w, im.h, im.levels, im.bc3);   // (on the worker too)
        if (bc5 && im.w >= 4 && im.h >= 4) { compressBC5(im.rgba.data(), im.w, im.h, im.levels); im.bc5 = true; }
        if (!cacheFile.empty() && !im.levels.empty()) texCacheWrite(cacheFile, im);
        return im;
      }));
    }
    for (cgltf_size i = 0; i < d->textures_count; i++) {
      Image im = jobs[i].get();
      if (im.w == 0) { SL_WARN("%s: texture %zu not decoded", name.c_str(), size_t(i)); continue; }
      gfx::TextureDesc td;
      td.width = im.w; td.height = im.h;
      td.format = srgb[i] ? gfx::TexFormat::SRGBA8 : gfx::TexFormat::RGBA8;
      td.anisotropy = anisotropy;
      if (!im.levels.empty()) {
        texOf[i] = im.bc5 ? dev_.createCompressedTextureRG(td, im.levels) : dev_.createCompressedTexture(td, im.bc3, srgb[i], im.levels);
        for (auto& l : im.levels) texBytes_ += l.size();
      } else {
        texOf[i] = dev_.createTexture(td, im.rgba.data());
        texBytes_ += size_t(im.w) * im.h * 4 * 4 / 3;
      }
      if (lodCol) {   // (the LODs' vertex colours are sampled from it below)
        if (lodImg.size() < d->textures_count) lodImg.resize(d->textures_count);
        auto ci = std::make_shared<CpuImage>();
        ci->w = im.w; ci->h = im.h; ci->rgba = im.rgba;
        lodImg[i] = ci;
      }
      if (opt.keepCpu) {   // (Phase 7: the skier's outfits recolour its albedo)
        if (model->images.size() < d->textures_count) model->images.resize(d->textures_count);
        auto ci = std::make_shared<CpuImage>();
        ci->w = im.w; ci->h = im.h; ci->rgba = std::move(im.rgba);
        model->images[i] = ci;
      }
    }
  }
  auto tex = [&](const cgltf_texture_view& v) { return v.texture ? texOf[size_t(v.texture - d->textures)] : gfx::Texture{}; };

  // ---- materials
  for (cgltf_size i = 0; i < d->materials_count; i++) {
    const cgltf_material& m = d->materials[i];
    Material o;
    const auto& pbr = m.pbr_metallic_roughness;
    o.baseColor = vec4(pbr.base_color_factor[0], pbr.base_color_factor[1], pbr.base_color_factor[2], pbr.base_color_factor[3]);
    o.metallic = pbr.metallic_factor; o.roughness = pbr.roughness_factor;
    o.baseTex = tex(pbr.base_color_texture);
    if (pbr.base_color_texture.texture) o.baseImage = int(pbr.base_color_texture.texture - d->textures);
    o.mrTex = tex(pbr.metallic_roughness_texture);
    if (pbr.metallic_roughness_texture.texture) o.mrImage = int(pbr.metallic_roughness_texture.texture - d->textures);
    o.normalTex = tex(m.normal_texture);
    o.normalScale = m.normal_texture.scale;
    o.glbEmissiveTex = tex(m.emissive_texture);
    if (!opt.ignoreEmissive) { o.emissive = vec3(m.emissive_factor[0], m.emissive_factor[1], m.emissive_factor[2]); o.emissiveTex = tex(m.emissive_texture); }
    o.doubleSided = m.double_sided;
    o.alpha = m.alpha_mode == cgltf_alpha_mode_mask ? Material::Alpha::Mask : m.alpha_mode == cgltf_alpha_mode_blend ? Material::Alpha::Blend : Material::Alpha::Opaque;
    o.alphaCutoff = m.alpha_cutoff;
    o.name = m.name ? m.name : "";
    // (Phase 7) car paint: the instance's colour replaces it (cars.js: the materials named like paint)
    { std::string n = o.name; for (auto& ch : n) ch = char(std::tolower(uint8_t(ch))); if (n.find("paint") != std::string::npos) o.paint = 1; }
    model->materials.push_back(o);
  }
  if (model->materials.empty()) model->materials.push_back(Material{});
  // (lodVertexColor) the LODs' materials: the vertex colour for the base map, the metal / roughness maps' means
  if (lodCol)
    for (cgltf_size i = 0; i < d->materials_count; i++) {
      Material o = model->materials[i];
      const auto& pbr = d->materials[i].pbr_metallic_roughness;
      if (pbr.base_color_texture.texture && size_t(pbr.base_color_texture.texture - d->textures) < lodImg.size() && lodImg[size_t(pbr.base_color_texture.texture - d->textures)]) {
        if (pbr.metallic_roughness_texture.texture && size_t(pbr.metallic_roughness_texture.texture - d->textures) < lodImg.size())
          if (auto mr = lodImg[size_t(pbr.metallic_roughness_texture.texture - d->textures)]) {
            double g = 0, b = 0;
            size_t n = size_t(mr->w) * size_t(mr->h);
            for (size_t k = 0; k < n; k++) { g += mr->rgba[k * 4 + 1]; b += mr->rgba[k * 4 + 2]; }
            o.roughness *= float(g / double(std::max<size_t>(1, n)) / 255.0);
            o.metallic *= float(b / double(std::max<size_t>(1, n)) / 255.0);
          }
        o.baseTex = {}; o.mrTex = {}; o.normalTex = {}; o.emissiveTex = {};
        o.vertexColor = true; o.colorSqrt = false; o.shading = 3;
        // (no colour map left: nothing to alpha-test; opaque, no alpha to coverage, no discard: hidden-surface removal)
        if (o.alpha == Material::Alpha::Mask && o.baseColor.w >= o.alphaCutoff) o.alpha = Material::Alpha::Opaque;
      }
      model->lodMaterials.push_back(o);
    }

  // ---- skins
  for (cgltf_size si = 0; si < d->skins_count; si++) {
    const cgltf_skin& s = d->skins[si];
    Skin o;
    for (cgltf_size j = 0; j < s.joints_count; j++) o.joints.push_back(remap[size_t(nodeIndex(s.joints[j]))]);
    o.inverseBind.assign(s.joints_count, mat4(1));
    if (s.inverse_bind_matrices)
      for (cgltf_size j = 0; j < s.joints_count; j++) cgltf_accessor_read_float(s.inverse_bind_matrices, j, glm::value_ptr(o.inverseBind[j]), 16);
    model->skins.push_back(o);
  }

  Pose rest;
  model->restPose(rest);
  model->finishPose(rest);

  // (Phase 7) the triangle budget (the switch preset's mesh LOD bias): the whole model simplified to it
  double triRatio = 1;
  if (triangleBudget > 0) {
    size_t total = 0;
    for (cgltf_size mi = 0; mi < d->meshes_count; mi++)
      for (cgltf_size pi = 0; pi < d->meshes[mi].primitives_count; pi++) {
        const cgltf_primitive& pr = d->meshes[mi].primitives[pi];
        if (pr.type == cgltf_primitive_type_triangles) total += (pr.indices ? pr.indices->count : (pr.attributes_count ? pr.attributes[0].data->count : 0)) / 3;
      }
    if (total > size_t(triangleBudget)) triRatio = double(triangleBudget) / double(total);
  }
  // ---- meshes: one interleaved float vertex buffer per primitive
  for (cgltf_size mi = 0; mi < d->meshes_count; mi++) {
    const cgltf_mesh& mesh = d->meshes[mi];
    Mesh om;
    om.name = mesh.name ? mesh.name : "";
    for (cgltf_size pi = 0; pi < mesh.primitives_count; pi++) {
      const cgltf_primitive& pr = mesh.primitives[pi];
      if (pr.type != cgltf_primitive_type_triangles) continue;
      const cgltf_accessor *pos = nullptr, *nor = nullptr, *uv = nullptr, *jnt = nullptr, *wgt = nullptr;
      for (cgltf_size a = 0; a < pr.attributes_count; a++) {
        const cgltf_attribute& at = pr.attributes[a];
        if (at.type == cgltf_attribute_type_position) pos = at.data;
        else if (at.type == cgltf_attribute_type_normal) nor = at.data;
        else if (at.type == cgltf_attribute_type_texcoord && at.index == 0) uv = at.data;
        else if (at.type == cgltf_attribute_type_joints && at.index == 0) jnt = at.data;
        else if (at.type == cgltf_attribute_type_weights && at.index == 0) wgt = at.data;
      }
      if (!pos) continue;
      size_t n = pos->count;
      bool skinned = jnt && wgt;
      std::vector<float> P = unpack(pos, 3), Nn = nor ? unpack(nor, 3) : std::vector<float>(n * 3, 0.f),
                         U = uv ? unpack(uv, 2) : std::vector<float>(n * 2, 0.f);
      std::vector<float> J, W;
      if (skinned) { J = unpack(jnt, 4); W = unpack(wgt, 4); }
      // (lodVertexColor) a colour per vertex from the base colour map: each vertex samples a little inside its
      // triangles (off the island's edge, where the atlas bleeds), linear light
      std::vector<float> C;
      if (lodCol && !skinned && uv && pr.material && pr.material->pbr_metallic_roughness.base_color_texture.texture) {
        size_t ti = size_t(pr.material->pbr_metallic_roughness.base_color_texture.texture - d->textures);
        if (ti < lodImg.size() && lodImg[ti]) {
          const CpuImage& im = *lodImg[ti];
          static float toLin[256];
          static bool lutReady = false;
          if (!lutReady) { for (int k = 0; k < 256; k++) { float c = float(k) / 255.f; toLin[k] = c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); } lutReady = true; }
          std::vector<uint32_t> ix;
          if (pr.indices) { ix.resize(pr.indices->count); cgltf_accessor_unpack_indices(pr.indices, ix.data(), 4, ix.size()); }
          else { ix.resize(n); for (size_t v = 0; v < n; v++) ix[v] = uint32_t(v); }
          C.assign(n * 3, 0.f);
          std::vector<float> cnt(n, 0.f);
          auto wrap = [](float t) { return t - std::floor(t); };
          for (size_t t = 0; t + 2 < ix.size(); t += 3) {
            float cu = (U[ix[t] * 2] + U[ix[t + 1] * 2] + U[ix[t + 2] * 2]) / 3, cv = (U[ix[t] * 2 + 1] + U[ix[t + 1] * 2 + 1] + U[ix[t + 2] * 2 + 1]) / 3;
            for (int k = 0; k < 3; k++) {
              uint32_t v = ix[t + size_t(k)];
              float u = U[v * 2] + (cu - U[v * 2]) * 0.4f, w = U[v * 2 + 1] + (cv - U[v * 2 + 1]) * 0.4f;
              int x = std::min(im.w - 1, int(wrap(u) * float(im.w))), y = std::min(im.h - 1, int(wrap(w) * float(im.h)));
              const uint8_t* q = &im.rgba[(size_t(y) * size_t(im.w) + size_t(x)) * 4];
              C[v * 3] += toLin[q[0]]; C[v * 3 + 1] += toLin[q[1]]; C[v * 3 + 2] += toLin[q[2]];
              cnt[v] += 1;
            }
          }
          for (size_t v = 0; v < n; v++) { float k = cnt[v] > 0 ? 1.f / cnt[v] : 0.f; C[v * 3] *= k; C[v * 3 + 1] *= k; C[v * 3 + 2] *= k; }
        }
      }
      const bool hasCol = !C.empty();
      const int stride = skinned ? 16 : hasCol ? 11 : 8;
      std::vector<float> vb(n * stride);
      Primitive op;
      for (size_t v = 0; v < n; v++) {
        float* o = &vb[v * stride];
        o[0] = P[v * 3]; o[1] = P[v * 3 + 1]; o[2] = P[v * 3 + 2];
        o[3] = Nn[v * 3]; o[4] = Nn[v * 3 + 1]; o[5] = Nn[v * 3 + 2];
        o[6] = U[v * 2]; o[7] = U[v * 2 + 1];
        if (hasCol) { o[8] = C[v * 3]; o[9] = C[v * 3 + 1]; o[10] = C[v * 3 + 2]; }
        if (skinned) {
          float ws = W[v * 4] + W[v * 4 + 1] + W[v * 4 + 2] + W[v * 4 + 3];
          for (int k = 0; k < 4; k++) { o[8 + k] = J[v * 4 + k]; o[12 + k] = ws > 0 ? W[v * 4 + k] / ws : (k == 0 ? 1.f : 0.f); }
        }
        vec3 bp(o[0], o[1], o[2]);
        if (skinned && !rest.joints.empty()) {
          vec4 acc(0);
          for (int k = 0; k < 4; k++) {
            size_t ji = std::min(size_t(o[8 + k]), rest.joints.size() - 1);
            acc += o[12 + k] * (rest.joints[ji] * vec4(bp, 1));
          }
          bp = vec3(acc);
        }
        op.bmin = glm::min(op.bmin, bp);
        op.bmax = glm::max(op.bmax, bp);
      }
      std::vector<uint32_t> idx;
      if (pr.indices) { idx.resize(pr.indices->count); cgltf_accessor_unpack_indices(pr.indices, idx.data(), 4, idx.size()); }
      else { idx.resize(n); for (size_t v = 0; v < n; v++) idx[v] = uint32_t(v); }
      // (Phase 7) over the triangle budget: LOD 0 simplified, then only the vertices still used kept
      if (triRatio < 1 && !skinned && idx.size() > 300) {
        size_t target = std::max<size_t>(36, size_t(double(idx.size() / 3) * triRatio) * 3);
        std::vector<uint32_t> s(idx.size());
        size_t cnt = meshopt_simplify(s.data(), idx.data(), idx.size(), P.data(), n, sizeof(float) * 3, target, 0.02f, 0, nullptr);
        if (cnt > target * 3 / 2) cnt = meshopt_simplifySloppy(s.data(), idx.data(), idx.size(), P.data(), n, sizeof(float) * 3, target, 0.05f, nullptr);
        if (cnt > 0 && cnt < idx.size()) {
          s.resize(cnt);
          std::vector<uint32_t> remap(n);
          size_t nu = meshopt_optimizeVertexFetchRemap(remap.data(), s.data(), s.size(), n);
          std::vector<float> vb2(nu * size_t(stride)), P2(nu * 3);
          meshopt_remapVertexBuffer(vb2.data(), vb.data(), n, sizeof(float) * size_t(stride), remap.data());
          meshopt_remapVertexBuffer(P2.data(), P.data(), n, sizeof(float) * 3, remap.data());
          meshopt_remapIndexBuffer(s.data(), s.data(), s.size(), remap.data());
          vb.swap(vb2); P.swap(P2); idx.swap(s); n = nu;
        }
      }
      // LODs: same vertices, simplified index ranges appended
      std::vector<uint32_t> all = idx;
      op.lods.push_back({0, uint32_t(idx.size())});
      // (lodCluster) vertex clustering: new vertices (the cells' means) appended to the vertex buffer
      if (hasCol && !opt.lodCluster.empty()) {
        const float height = std::max(1e-6f, op.bmax.y - op.bmin.y);
        for (float frac : opt.lodCluster) {
          const float cell = std::max(1e-6f, frac * height);
          struct Acc { double p[3] = {0, 0, 0}, nn[3] = {0, 0, 0}, c[3] = {0, 0, 0}; float u = 0, v = 0; uint32_t cnt = 0; };
          std::unordered_map<uint64_t, uint32_t> cells;
          std::vector<Acc> acc;
          std::vector<uint32_t> remap(n);
          for (size_t v = 0; v < n; v++) {
            const float* o = &vb[v * size_t(stride)];
            // snow (bright, unsaturated) and needles / bark never share a cell: the snow on the branches stays white
            float hi = std::max({o[8], o[9], o[10]}), lo = std::min({o[8], o[9], o[10]});
            uint64_t cls = (hi > 0.12f && lo > 0.6f * hi) ? 1 : 0;
            auto q = [&](float x) { return uint64_t(int64_t(std::floor(x / cell)) + 1048576) & 0xFFFFF; };
            uint64_t key = q(o[0]) | (q(o[1]) << 20) | (q(o[2]) << 40) | (cls << 60);
            auto it = cells.find(key);
            uint32_t id;
            if (it == cells.end()) { id = uint32_t(acc.size()); cells.emplace(key, id); acc.emplace_back(); acc.back().u = o[6]; acc.back().v = o[7]; }
            else id = it->second;
            Acc& a = acc[id];
            for (int k = 0; k < 3; k++) { a.p[k] += o[k]; a.nn[k] += o[3 + k]; a.c[k] += o[8 + k]; }
            a.cnt++;
            remap[v] = id;
          }
          std::vector<uint32_t> tris;
          std::unordered_map<uint64_t, uint8_t> seen;
          for (size_t t = 0; t + 2 < idx.size(); t += 3) {
            uint32_t a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
            if (a == b || b == c || a == c) continue;
            uint32_t s3[3] = {a, b, c};
            std::sort(s3, s3 + 3);
            uint64_t k = (uint64_t(s3[0]) * 2097152u + s3[1]) * 2097152u + s3[2];
            if (!seen.emplace(k, uint8_t(1)).second) continue;
            tris.push_back(a); tris.push_back(b); tris.push_back(c);
          }
          if (tris.empty() || tris.size() >= op.lods.back().count) continue;
          const uint32_t base = uint32_t(vb.size() / size_t(stride));
          vb.resize(vb.size() + acc.size() * size_t(stride));
          for (size_t i = 0; i < acc.size(); i++) {
            const Acc& a = acc[i];
            float* o = &vb[(size_t(base) + i) * size_t(stride)];
            const double k = 1.0 / double(a.cnt);
            for (int j = 0; j < 3; j++) { o[j] = float(a.p[j] * k); o[8 + j] = float(a.c[j] * k); }
            double nl = std::sqrt(a.nn[0] * a.nn[0] + a.nn[1] * a.nn[1] + a.nn[2] * a.nn[2]);
            if (nl > 1e-4) { o[3] = float(a.nn[0] / nl); o[4] = float(a.nn[1] / nl); o[5] = float(a.nn[2] / nl); } else { o[3] = 0; o[4] = 1; o[5] = 0; }
            o[6] = a.u; o[7] = a.v;
          }
          op.lods.push_back({uint32_t(all.size()), uint32_t(tris.size())});
          for (uint32_t t : tris) all.push_back(t + base);
        }
      }
      for (float ratio : opt.lodRatios) {
        if (skinned || (hasCol && !opt.lodCluster.empty())) break;
        size_t target = size_t(double(idx.size() / 3) * ratio) * 3;
        if (target < 36) target = 36;
        std::vector<uint32_t> lod(idx.size());
        // topology-preserving first (keeps branch cards whole); the sloppy simplifier only where that cannot reach
        // the budget (far LODs of the trees' branch soup)
        size_t cnt;
        if (hasCol) {   // (the colours steer the collapses: windows, stripes and trim keep their edges)
          const float cw[3] = {0.6f, 0.6f, 0.6f};
          cnt = meshopt_simplifyWithAttributes(lod.data(), idx.data(), idx.size(), P.data(), n, sizeof(float) * 3, &vb[8], sizeof(float) * size_t(stride), cw, 3, nullptr, target, 0.05f, 0, nullptr);
        } else cnt = meshopt_simplify(lod.data(), idx.data(), idx.size(), P.data(), n, sizeof(float) * 3, target, 0.05f, 0, nullptr);
        if (cnt > target * 3 / 2 && opt.lodSloppy)
          cnt = meshopt_simplifySloppy(lod.data(), idx.data(), idx.size(), P.data(), n, sizeof(float) * 3, target, 1e-1f, nullptr);
        if (cnt == 0 || cnt >= op.lods.back().count) continue;
        op.lods.push_back({uint32_t(all.size()), uint32_t(cnt)});
        all.insert(all.end(), lod.begin(), lod.begin() + long(cnt));
      }
      op.vbo = dev_.createBuffer(gfx::BufferUsage::Vertex, vb.data(), vb.size() * sizeof(float));
      op.ibo = dev_.createBuffer(gfx::BufferUsage::Index, all.data(), all.size() * sizeof(uint32_t));
      uint32_t st = uint32_t(stride * sizeof(float));
      std::vector<gfx::VertexAttrib> at = {
        {0, 0, 3, gfx::AttribType::Float, false, 0, st}, {1, 0, 3, gfx::AttribType::Float, false, 12, st},
        {2, 0, 2, gfx::AttribType::Float, false, 24, st}};
      if (skinned) { at.push_back({3, 0, 4, gfx::AttribType::Float, false, 32, st}); at.push_back({4, 0, 4, gfx::AttribType::Float, false, 48, st}); }
      if (hasCol) { at.push_back({7, 0, 3, gfx::AttribType::Float, false, 32, st}); op.hasColor = true; }
      op.stride = st;
      op.input = dev_.createVertexInput(at, {op.vbo}, op.ibo);
      op.material = pr.material ? int(pr.material - d->materials) : 0;
      op.skinned = skinned;
      if (opt.keepCpu) {
        op.cpuVerts = std::make_shared<std::vector<float>>(vb);
        op.cpuIdx = std::make_shared<std::vector<uint32_t>>(idx);
      }
      om.primitives.push_back(op);
    }
    model->meshes.push_back(std::move(om));
  }

  // ---- animations (targets by node name: clips retarget onto other models with the same skeleton)
  for (cgltf_size ai = 0; ai < d->animations_count; ai++) {
    const cgltf_animation& a = d->animations[ai];
    AnimClip clip;
    clip.name = a.name ? a.name : "clip" + std::to_string(ai);
    for (cgltf_size c = 0; c < a.channels_count; c++) {
      const cgltf_animation_channel& ch = a.channels[c];
      if (!ch.target_node || !ch.sampler) continue;
      AnimChannel oc;
      oc.node = ch.target_node->name ? ch.target_node->name : "";
      if (ch.target_path == cgltf_animation_path_type_translation) oc.path = AnimChannel::Path::T;
      else if (ch.target_path == cgltf_animation_path_type_rotation) oc.path = AnimChannel::Path::R;
      else if (ch.target_path == cgltf_animation_path_type_scale) oc.path = AnimChannel::Path::S;
      else continue;
      oc.step = ch.sampler->interpolation == cgltf_interpolation_type_step;
      bool cubic = ch.sampler->interpolation == cgltf_interpolation_type_cubic_spline;
      oc.times = unpack(ch.sampler->input, 1);
      int comps = oc.path == AnimChannel::Path::R ? 4 : 3;
      std::vector<float> vals = unpack(ch.sampler->output, comps);
      if (cubic) { // keep the value of each (in-tangent, value, out-tangent) triple
        std::vector<float> v2(oc.times.size() * comps);
        for (size_t k = 0; k < oc.times.size(); k++) for (int q = 0; q < comps; q++) v2[k * comps + q] = vals[(k * 3 + 1) * comps + q];
        vals.swap(v2);
      }
      oc.values = std::move(vals);
      if (!oc.times.empty()) clip.duration = std::max(clip.duration, oc.times.back());
      clip.channels.push_back(std::move(oc));
    }
    model->clips.push_back(std::move(clip));
  }

  // ---- rest pose bounds (mesh nodes; skinned primitives were skinned with the rest pose above)
  Pose pose;
  model->restPose(pose);
  model->finishPose(pose);
  for (size_t i = 0; i < model->nodes.size(); i++) {
    const Node& nd = model->nodes[i];
    if (nd.mesh < 0) continue;
    mat4 m = nd.skin >= 0 ? mat4(1) : pose.global[i];
    for (auto& pr : model->meshes[size_t(nd.mesh)].primitives)
      for (int c = 0; c < 8; c++) {
        vec3 p((c & 1) ? pr.bmax.x : pr.bmin.x, (c & 2) ? pr.bmax.y : pr.bmin.y, (c & 4) ? pr.bmax.z : pr.bmin.z);
        vec3 w = vec3(m * vec4(p, 1));
        model->bmin = glm::min(model->bmin, w);
        model->bmax = glm::max(model->bmax, w);
      }
  }
  size_t tris = 0;
  for (auto& m : model->meshes) for (auto& p : m.primitives) tris += p.lods[0].count / 3;
  std::string lodInfo;
  if (!model->meshes.empty() && !model->meshes[0].primitives.empty())
    for (size_t l = 1; l < model->meshes[0].primitives[0].lods.size(); l++) lodInfo += (l == 1 ? ", LODs " : " / ") + std::to_string(model->meshes[0].primitives[0].lods[l].count / 3);
  SL_INFO("model %-20s %6zu tris, %zu nodes, %zu clips, %zu textures%s", name.c_str(), tris, model->nodes.size(), model->clips.size(), size_t(d->textures_count), lodInfo.c_str());
  return model;
}

bool decodeImageRGBA(const std::vector<uint8_t>& file, int& w, int& h, std::vector<uint8_t>& rgba) {
  Image im;
  if (file.empty() || !decodeImage(file.data(), file.size(), nullptr, im)) return false;
  w = im.w; h = im.h;
  rgba = std::move(im.rgba);
  return true;
}

} // namespace sl
