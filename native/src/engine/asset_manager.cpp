#define CGLTF_IMPLEMENTATION
#include <cgltf.h>
#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_STDIO
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#include <stb_image.h>

#include "engine/asset_manager.h"
#include "engine/texcompress.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"

#include <meshoptimizer.h>
#include <webp/decode.h>
#include <cctype>
#include <cstring>
#include <future>
#include <map>
#include <cstdlib>
#include <cstring>
#include <functional>

namespace sl {

namespace {
struct Image { int w = 0, h = 0; std::vector<uint8_t> rgba; std::vector<std::vector<uint8_t>> levels; bool bc3 = false; };

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
  auto m = loadFile(paths_.model(name), name, opt);
  cache_[name] = m;
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
  for (cgltf_size i = 0; i < d->materials_count; i++) {
    const cgltf_material& m = d->materials[i];
    if (m.pbr_metallic_roughness.base_color_texture.texture) srgb[size_t(m.pbr_metallic_roughness.base_color_texture.texture - d->textures)] = true;
    if (m.emissive_texture.texture) srgb[size_t(m.emissive_texture.texture - d->textures)] = true;
  }
  {
    std::vector<std::future<Image>> jobs;
    for (cgltf_size i = 0; i < d->textures_count; i++) {
      const cgltf_texture& t = d->textures[i];
      const cgltf_image* img = t.has_webp && t.webp_image ? t.webp_image : t.image;
      int cap = std::min(opt.maxTextureSize, textureCap);
      bool bc = compressTextures && dev_.supportsBC(srgb[i]) && !opt.keepCpu;
      jobs.push_back(std::async(std::launch::async, [img, cap, bc]() {
        Image im;
        if (!img || !img->buffer_view) return im;
        const uint8_t* data = cgltf_buffer_view_data(img->buffer_view);
        if (!data || !decodeImage(data, img->buffer_view->size, img->mime_type, im)) return Image{};
        downsample(im, cap);
        if (bc && im.w >= 4 && im.h >= 4) compressBC(im.rgba.data(), im.w, im.h, im.levels, im.bc3);   // (on the worker too)
        return im;
      }));
    }
    for (cgltf_size i = 0; i < d->textures_count; i++) {
      Image im = jobs[i].get();
      if (im.w == 0) { SL_WARN("%s: texture %zu not decoded", name.c_str(), size_t(i)); continue; }
      gfx::TextureDesc td;
      td.width = im.w; td.height = im.h;
      td.format = srgb[i] ? gfx::TexFormat::SRGBA8 : gfx::TexFormat::RGBA8;
      td.anisotropy = 8;
      if (!im.levels.empty()) {
        texOf[i] = dev_.createCompressedTexture(td, im.bc3, srgb[i], im.levels);
        for (auto& l : im.levels) texBytes_ += l.size();
      } else {
        texOf[i] = dev_.createTexture(td, im.rgba.data());
        texBytes_ += size_t(im.w) * im.h * 4 * 4 / 3;
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
    o.normalTex = tex(m.normal_texture);
    o.normalScale = m.normal_texture.scale;
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
      const int stride = skinned ? 16 : 8;
      std::vector<float> vb(n * stride);
      Primitive op;
      for (size_t v = 0; v < n; v++) {
        float* o = &vb[v * stride];
        o[0] = P[v * 3]; o[1] = P[v * 3 + 1]; o[2] = P[v * 3 + 2];
        o[3] = Nn[v * 3]; o[4] = Nn[v * 3 + 1]; o[5] = Nn[v * 3 + 2];
        o[6] = U[v * 2]; o[7] = U[v * 2 + 1];
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
      for (float ratio : opt.lodRatios) {
        if (skinned) break;
        size_t target = size_t(double(idx.size() / 3) * ratio) * 3;
        if (target < 36) target = 36;
        std::vector<uint32_t> lod(idx.size());
        // topology-preserving first (keeps branch cards whole); the sloppy simplifier only where that cannot reach
        // the budget (far LODs of the trees' branch soup)
        size_t cnt = meshopt_simplify(lod.data(), idx.data(), idx.size(), P.data(), n, sizeof(float) * 3, target, 0.05f, 0, nullptr);
        if (cnt > target * 3 / 2)
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
  SL_INFO("model %-20s %6zu tris, %zu nodes, %zu clips, %zu textures", name.c_str(), tris, model->nodes.size(), model->clips.size(), size_t(d->textures_count));
  return model;
}

} // namespace sl
