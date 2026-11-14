// OpenGL 4.1 core backend of gfx::Device (desktop: macOS caps at 4.1, so nothing newer is used: no DSA, no
// glTexStorage requirement, no compute; explicit uniform block bindings are set from the API side).
#include "gfx/gfx.h"
#include "core/log.h"

#include <glad/glad.h>
#include <algorithm>
#include <unordered_map>

namespace sl::gfx {

namespace {
struct GLTex { GLuint id = 0; GLenum target = GL_TEXTURE_2D; size_t bytes = 0; };
struct GLRT { GLuint fbo = 0; Texture color, depth; int w = 0, h = 0; GLuint rbColor = 0, rbDepth = 0; int samples = 1; };
struct GLProg { GLuint id = 0; std::unordered_map<std::string, GLint> locs; std::string name; };

GLenum attribType(AttribType t) {
  switch (t) {
    case AttribType::Float: return GL_FLOAT;
    case AttribType::UByte: return GL_UNSIGNED_BYTE;
    case AttribType::UShort: return GL_UNSIGNED_SHORT;
    case AttribType::Short: return GL_SHORT;
    case AttribType::Byte: return GL_BYTE;
  }
  return GL_FLOAT;
}

void texFormat(TexFormat f, GLint& internal, GLenum& format, GLenum& type) {
  internal = GL_RGBA8; format = GL_RGBA; type = GL_UNSIGNED_BYTE;
  switch (f) {
    case TexFormat::RGBA8: internal = GL_RGBA8; format = GL_RGBA; type = GL_UNSIGNED_BYTE; break;
    case TexFormat::SRGBA8: internal = GL_SRGB8_ALPHA8; format = GL_RGBA; type = GL_UNSIGNED_BYTE; break;
    case TexFormat::RGBA16F: internal = GL_RGBA16F; format = GL_RGBA; type = GL_HALF_FLOAT; break;
    case TexFormat::R8: internal = GL_R8; format = GL_RED; type = GL_UNSIGNED_BYTE; break;
    case TexFormat::Depth24: internal = GL_DEPTH_COMPONENT24; format = GL_DEPTH_COMPONENT; type = GL_UNSIGNED_INT; break;
    case TexFormat::Depth32F: internal = GL_DEPTH_COMPONENT32F; format = GL_DEPTH_COMPONENT; type = GL_FLOAT; break;
    case TexFormat::R16F: internal = GL_R16F; format = GL_RED; type = GL_HALF_FLOAT; break;
    case TexFormat::RG16F: internal = GL_RG16F; format = GL_RG; type = GL_HALF_FLOAT; break;
    case TexFormat::R11G11B10F: internal = GL_R11F_G11F_B10F; format = GL_RGB; type = GL_HALF_FLOAT; break;
    case TexFormat::RG8: internal = GL_RG8; format = GL_RG; type = GL_UNSIGNED_BYTE; break;
  }
}
} // namespace

class GLDevice final : public Device {
public:
  GLDevice() {
    info_.api = "OpenGL";
    info_.renderer = reinterpret_cast<const char*>(glGetString(GL_RENDERER));
    info_.version = reinterpret_cast<const char*>(glGetString(GL_VERSION));
    if (GLAD_GL_EXT_texture_filter_anisotropic || GLAD_GL_ARB_texture_filter_anisotropic) {
      GLfloat m = 1;
      glGetFloatv(GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT, &m);
      info_.maxAnisotropy = int(m);
    }
    // (Phase 7) block compression (S3TC / BC1-3, and its sRGB variants)
    GLint ne = 0;
    glGetIntegerv(GL_NUM_EXTENSIONS, &ne);
    for (GLint i = 0; i < ne; i++) {
      const char* e = reinterpret_cast<const char*>(glGetStringi(GL_EXTENSIONS, GLuint(i)));
      if (!e) continue;
      std::string x = e;
      if (x == "GL_EXT_texture_compression_s3tc") s3tc_ = true;
      if (x == "GL_EXT_texture_sRGB" || x == "GL_EXT_texture_compression_s3tc_srgb") s3tcSrgb_ = true;
    }
    glEnable(GL_TEXTURE_CUBE_MAP_SEAMLESS);
    GLint ms = 1, mt = 4096;
    glGetIntegerv(GL_MAX_SAMPLES, &ms);
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &mt);
    info_.maxSamples = ms; info_.maxTextureSize = mt;
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
  }
  ~GLDevice() override {
    for (auto& [k, v] : vaos_) glDeleteVertexArrays(1, &v);
    for (auto& [k, t] : texs_) glDeleteTextures(1, &t.id);
    for (auto& [k, b] : bufs_) glDeleteBuffers(1, &b);
    for (auto& [k, p] : progs_) glDeleteProgram(p.id);
    for (auto& [k, r] : rts_) glDeleteFramebuffers(1, &r.fbo);
  }
  const DeviceInfo& info() const override { return info_; }

  Buffer createBuffer(BufferUsage usage, const void* data, size_t bytes, bool dynamic) override {
    GLuint b = 0;
    glGenBuffers(1, &b);
    GLenum target = usage == BufferUsage::Index ? GL_ELEMENT_ARRAY_BUFFER : usage == BufferUsage::Uniform ? GL_UNIFORM_BUFFER : GL_ARRAY_BUFFER;
    if (target == GL_ELEMENT_ARRAY_BUFFER) glBindVertexArray(0);
    glBindBuffer(target, b);
    glBufferData(target, GLsizeiptr(bytes), data, dynamic ? GL_DYNAMIC_DRAW : GL_STATIC_DRAW);
    glBindBuffer(target, 0);
    uint32_t h = next_++;
    bufs_[h] = b;
    bufTarget_[h] = target;
    bufSize_[h] = bytes;
    bufBytes_ += bytes;
    return Buffer{h};
  }
  void updateBuffer(Buffer b, const void* data, size_t bytes, size_t offset) override {
    GLenum t = bufTarget_[b.id];
    if (t == GL_ELEMENT_ARRAY_BUFFER) glBindVertexArray(0);
    glBindBuffer(t, bufs_[b.id]);
    glBufferSubData(t, GLintptr(offset), GLsizeiptr(bytes), data);
    glBindBuffer(t, 0);
  }
  void replaceBuffer(Buffer b, const void* data, size_t bytes) override {
    GLenum t = bufTarget_[b.id];
    if (t == GL_ELEMENT_ARRAY_BUFFER) glBindVertexArray(0);
    glBindBuffer(t, bufs_[b.id]);
    if (bytes > bufSize_[b.id]) { bufBytes_ += bytes - bufSize_[b.id]; bufSize_[b.id] = bytes; }
    glBufferData(t, GLsizeiptr(bufSize_[b.id]), nullptr, GL_DYNAMIC_DRAW); // orphan
    if (bytes) glBufferSubData(t, 0, GLsizeiptr(bytes), data);
    glBindBuffer(t, 0);
  }
  void destroy(Buffer b) override {
    auto it = bufs_.find(b.id);
    if (it == bufs_.end()) return;
    glDeleteBuffers(1, &it->second);
    bufBytes_ -= std::min(bufBytes_, bufSize_[b.id]);
    bufSize_.erase(b.id);
    bufTarget_.erase(b.id);
    bufs_.erase(it);
  }

  Texture createTexture(const TextureDesc& d, const void* pixels) override {
    GLuint t = 0;
    glGenTextures(1, &t);
    glBindTexture(GL_TEXTURE_2D, t);
    GLint internal; GLenum format, type;
    texFormat(d.format, internal, format, type);
    glTexImage2D(GL_TEXTURE_2D, 0, internal, d.width, d.height, 0, format, type, pixels);
    bool mips = d.mipmaps && d.filter == Filter::Trilinear;
    if (mips) glGenerateMipmap(GL_TEXTURE_2D);
    GLint minF = d.filter == Filter::Nearest ? GL_NEAREST : mips ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR;
    GLint magF = d.filter == Filter::Nearest ? GL_NEAREST : GL_LINEAR;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, minF);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, magF);
    GLint wrap = d.wrap == Wrap::Repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap);
    if (mips && info_.maxAnisotropy > 1 && d.anisotropy > 1)
      glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY_EXT, std::min(d.anisotropy, float(info_.maxAnisotropy)));
    if (d.depthCompare) {
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_COMPARE_REF_TO_TEXTURE);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_FUNC, GL_LEQUAL);
    }
    glBindTexture(GL_TEXTURE_2D, 0);
    uint32_t h = next_++;
    size_t bpp = d.format == TexFormat::RGBA16F ? 8 : d.format == TexFormat::R8 ? 1 : (d.format == TexFormat::R16F || d.format == TexFormat::RG8) ? 2 : 4;
    size_t bytes = size_t(d.width) * d.height * bpp * (mips ? 4 : 3) / 3;
    texs_[h] = {t, GL_TEXTURE_2D, bytes};
    texBytes_ += bytes;
    return Texture{h};
  }
  bool supportsBC(bool srgb) const override { return s3tc_ && (!srgb || s3tcSrgb_); }
  Texture createCompressedTexture(const TextureDesc& d, bool bc3, bool srgb, const std::vector<std::vector<uint8_t>>& levels) override {
    // GL_COMPRESSED_(SRGB_)RGB(A)_S3TC_DXT1 / DXT5 (EXT_texture_compression_s3tc, EXT_texture_sRGB)
    GLenum fmt = bc3 ? (srgb ? 0x8C4F : 0x83F3) : (srgb ? 0x8C4C : 0x83F0);
    GLuint t = 0;
    glGenTextures(1, &t);
    glBindTexture(GL_TEXTURE_2D, t);
    size_t bytes = 0;
    int w = d.width, h = d.height;
    for (size_t l = 0; l < levels.size(); l++) {
      glCompressedTexImage2D(GL_TEXTURE_2D, GLint(l), fmt, w, h, 0, GLsizei(levels[l].size()), levels[l].data());
      bytes += levels[l].size();
      w = std::max(1, w / 2); h = std::max(1, h / 2);
    }
    bool mips = levels.size() > 1;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, GLint(levels.size()) - 1);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, d.filter == Filter::Nearest ? GL_NEAREST : mips ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, d.filter == Filter::Nearest ? GL_NEAREST : GL_LINEAR);
    GLint wrap = d.wrap == Wrap::Repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap);
    if (mips && info_.maxAnisotropy > 1 && d.anisotropy > 1)
      glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY_EXT, std::min(d.anisotropy, float(info_.maxAnisotropy)));
    glBindTexture(GL_TEXTURE_2D, 0);
    uint32_t hnd = next_++;
    texs_[hnd] = {t, GL_TEXTURE_2D, bytes};
    texBytes_ += bytes;
    return Texture{hnd};
  }
  void destroy(Texture t) override {
    auto it = texs_.find(t.id);
    if (it == texs_.end()) return;
    glDeleteTextures(1, &it->second.id);
    texBytes_ -= std::min(texBytes_, it->second.bytes);
    texs_.erase(it);
  }

  Program createProgram(const char* name, const std::string& vs, const std::string& fs) override {
    auto compile = [&](GLenum type, const std::string& src) -> GLuint {
      GLuint s = glCreateShader(type);
      const char* p = src.c_str();
      glShaderSource(s, 1, &p, nullptr);
      glCompileShader(s);
      GLint ok = 0;
      glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
      if (!ok) {
        char log[4096];
        glGetShaderInfoLog(s, sizeof log, nullptr, log);
        SL_ERROR("shader '%s' (%s): %s", name, type == GL_VERTEX_SHADER ? "vs" : "fs", log);
        glDeleteShader(s);
        return 0;
      }
      return s;
    };
    GLuint v = compile(GL_VERTEX_SHADER, vs), f = compile(GL_FRAGMENT_SHADER, fs);
    if (!v || !f) return Program{};
    GLuint p = glCreateProgram();
    glAttachShader(p, v);
    glAttachShader(p, f);
    glLinkProgram(p);
    glDeleteShader(v);
    glDeleteShader(f);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
      char log[4096];
      glGetProgramInfoLog(p, sizeof log, nullptr, log);
      SL_ERROR("program '%s' link: %s", name, log);
      glDeleteProgram(p);
      return Program{};
    }
    uint32_t h = next_++;
    progs_[h] = GLProg{p, {}, name};
    return Program{h};
  }
  void destroy(Program p) override {
    auto it = progs_.find(p.id);
    if (it == progs_.end()) return;
    glDeleteProgram(it->second.id);
    progs_.erase(it);
  }

  VertexInput createVertexInput(const std::vector<VertexAttrib>& attribs, const std::vector<Buffer>& buffers,
                                Buffer index) override {
    GLuint vao = 0;
    glGenVertexArrays(1, &vao);
    glBindVertexArray(vao);
    for (const auto& a : attribs) {
      glBindBuffer(GL_ARRAY_BUFFER, bufs_[buffers[a.buffer].id]);
      glEnableVertexAttribArray(a.location);
      glVertexAttribPointer(a.location, a.components, attribType(a.type), a.normalized ? GL_TRUE : GL_FALSE,
                            GLsizei(a.stride), reinterpret_cast<const void*>(uintptr_t(a.offset)));
      glVertexAttribDivisor(a.location, a.perInstance ? 1 : 0);
    }
    if (index) glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, bufs_[index.id]);
    glBindVertexArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    uint32_t h = next_++;
    vaos_[h] = vao;
    return VertexInput{h};
  }
  void destroy(VertexInput v) override {
    auto it = vaos_.find(v.id);
    if (it == vaos_.end()) return;
    glDeleteVertexArrays(1, &it->second);
    vaos_.erase(it);
  }

  RenderTarget createRenderTarget(int w, int h, bool withColor, TexFormat color, bool withDepth, TexFormat depth,
                                  bool depthCompare) override {
    GLRT rt;
    rt.w = w; rt.h = h;
    glGenFramebuffers(1, &rt.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, rt.fbo);
    if (withColor) {
      TextureDesc d; d.width = w; d.height = h; d.format = color; d.filter = Filter::Linear; d.wrap = Wrap::Clamp; d.mipmaps = false;
      rt.color = createTexture(d, nullptr);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texs_[rt.color.id].id, 0);
    } else {
      glDrawBuffer(GL_NONE);
      glReadBuffer(GL_NONE);
    }
    if (withDepth) {
      TextureDesc d; d.width = w; d.height = h; d.format = depth; d.filter = Filter::Linear; d.wrap = Wrap::Clamp;
      d.mipmaps = false; d.depthCompare = depthCompare;
      rt.depth = createTexture(d, nullptr);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, texs_[rt.depth.id].id, 0);
    }
    GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (st != GL_FRAMEBUFFER_COMPLETE) SL_ERROR("framebuffer incomplete: 0x%x", st);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    uint32_t hd = next_++;
    rts_[hd] = rt;
    return RenderTarget{hd};
  }
  RenderTarget createRenderTargetMS(int w, int h, int samples, TexFormat color, TexFormat depth) override {
    GLRT rt;
    rt.w = w; rt.h = h; rt.samples = samples;
    glGenFramebuffers(1, &rt.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, rt.fbo);
    GLint ci, di; GLenum f, t;
    texFormat(color, ci, f, t);
    texFormat(depth, di, f, t);
    glGenRenderbuffers(1, &rt.rbColor);
    glBindRenderbuffer(GL_RENDERBUFFER, rt.rbColor);
    glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, GLenum(ci), w, h);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rt.rbColor);
    glGenRenderbuffers(1, &rt.rbDepth);
    glBindRenderbuffer(GL_RENDERBUFFER, rt.rbDepth);
    glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, GLenum(di), w, h);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, rt.rbDepth);
    glBindRenderbuffer(GL_RENDERBUFFER, 0);
    GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (st != GL_FRAMEBUFFER_COMPLETE) SL_ERROR("multisampled framebuffer incomplete: 0x%x", st);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    size_t bytes = size_t(w) * h * size_t(samples) * ((color == TexFormat::RGBA16F ? 8 : 4) + 4);
    rtBytes_[next_] = bytes;
    texBytes_ += bytes;
    uint32_t hd = next_++;
    rts_[hd] = rt;
    return RenderTarget{hd};
  }
  void resolve(RenderTarget src, RenderTarget dst, int w, int h, bool color, bool depth) override {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, src ? rts_[src.id].fbo : 0);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, dst ? rts_[dst.id].fbo : 0);
    if (color) glBlitFramebuffer(0, 0, w, h, 0, 0, w, h, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    if (depth) glBlitFramebuffer(0, 0, w, h, 0, 0, w, h, GL_DEPTH_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
  }
  void generateMipmaps(Texture t) override {
    auto it = texs_.find(t.id);
    if (it == texs_.end()) return;
    glBindTexture(GL_TEXTURE_2D, it->second.id);
    glGenerateMipmap(GL_TEXTURE_2D);
    glBindTexture(GL_TEXTURE_2D, 0);
  }
  void setSampling(Texture t, Filter f, Wrap w, float aniso) override {
    auto it = texs_.find(t.id);
    if (it == texs_.end()) return;
    glBindTexture(GL_TEXTURE_2D, it->second.id);
    GLint minF = f == Filter::Nearest ? GL_NEAREST : f == Filter::Trilinear ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, minF);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, f == Filter::Nearest ? GL_NEAREST : GL_LINEAR);
    GLint wr = w == Wrap::Repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wr);
    if (info_.maxAnisotropy > 1)
      glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY_EXT, std::max(1.f, std::min(aniso, float(info_.maxAnisotropy))));
    glBindTexture(GL_TEXTURE_2D, 0);
  }
  void setViewport(int x, int y, int w, int h, bool scissor) override {
    glViewport(x, y, w, h);
    if (scissor) { glEnable(GL_SCISSOR_TEST); glScissor(x, y, w, h); } else glDisable(GL_SCISSOR_TEST);
  }
  Texture renderTargetColor(RenderTarget rt) const override { auto it = rts_.find(rt.id); return it == rts_.end() ? Texture{} : it->second.color; }
  Texture renderTargetDepth(RenderTarget rt) const override { auto it = rts_.find(rt.id); return it == rts_.end() ? Texture{} : it->second.depth; }
  void destroy(RenderTarget rt) override {
    auto it = rts_.find(rt.id);
    if (it == rts_.end()) return;
    destroy(it->second.color);
    destroy(it->second.depth);
    if (it->second.rbColor) glDeleteRenderbuffers(1, &it->second.rbColor);
    if (it->second.rbDepth) glDeleteRenderbuffers(1, &it->second.rbDepth);
    if (auto b = rtBytes_.find(rt.id); b != rtBytes_.end()) { texBytes_ -= std::min(texBytes_, b->second); rtBytes_.erase(b); }
    glDeleteFramebuffers(1, &it->second.fbo);
    rts_.erase(it);
  }

  void bindRenderTarget(RenderTarget rt, int w, int h) override {
    glBindFramebuffer(GL_FRAMEBUFFER, rt ? rts_[rt.id].fbo : 0);
    glViewport(0, 0, w, h);
    glDisable(GL_SCISSOR_TEST);
  }
  void clear(float r, float g, float b, float a, bool color, bool depth) override {
    GLbitfield m = 0;
    if (color) { glClearColor(r, g, b, a); glColorMask(1, 1, 1, 1); m |= GL_COLOR_BUFFER_BIT; }
    if (depth) { glDepthMask(GL_TRUE); glClearDepth(1.0); m |= GL_DEPTH_BUFFER_BIT; }
    glClear(m);
    state_.depthWrite = true; state_.colorWrite = true;
  }
  void setPipeline(const PipelineState& s) override {
    if (s.depth == DepthTest::Off) glDisable(GL_DEPTH_TEST);
    else { glEnable(GL_DEPTH_TEST); glDepthFunc(s.depth == DepthTest::Less ? GL_LESS : GL_LEQUAL); }
    glDepthMask(s.depthWrite ? GL_TRUE : GL_FALSE);
    if (s.cull == Cull::None) glDisable(GL_CULL_FACE);
    else { glEnable(GL_CULL_FACE); glCullFace(s.cull == Cull::Back ? GL_BACK : GL_FRONT); }
    switch (s.blend) {
      case Blend::Opaque: glDisable(GL_BLEND); break;
      case Blend::Alpha: glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA); break;
      case Blend::Additive: glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE); break;
      case Blend::Max: glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE); break;
      case Blend::Multiply: glEnable(GL_BLEND); glBlendFunc(GL_ZERO, GL_SRC_COLOR); break;
      case Blend::Premul: glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA); break;
    }
    glBlendEquation(s.blend == Blend::Max ? GL_MAX : GL_FUNC_ADD);
    if (s.alphaToCoverage) glEnable(GL_SAMPLE_ALPHA_TO_COVERAGE); else glDisable(GL_SAMPLE_ALPHA_TO_COVERAGE);
    GLboolean cw = s.colorWrite ? GL_TRUE : GL_FALSE;
    glColorMask(cw, cw, cw, cw);
    if (s.depthBiasFactor != 0 || s.depthBiasUnits != 0) {
      glEnable(GL_POLYGON_OFFSET_FILL);
      glPolygonOffset(s.depthBiasFactor, s.depthBiasUnits);
    } else glDisable(GL_POLYGON_OFFSET_FILL);
    state_ = s;
  }
  void useProgram(Program p) override {
    cur_ = p.id ? &progs_[p.id] : nullptr;
    glUseProgram(cur_ ? cur_->id : 0);
  }
  void bindTexture(int unit, Texture t) override {
    glActiveTexture(GL_TEXTURE0 + unit);
    auto it = texs_.find(t.id);
    glBindTexture(GL_TEXTURE_2D, it == texs_.end() ? 0 : it->second.id);
  }
  void bindUniformBuffer(int binding, Buffer b) override { glBindBufferBase(GL_UNIFORM_BUFFER, binding, bufs_[b.id]); }

  void setInt(const char* n, int v) override { if (GLint l = loc(n); l >= 0) glUniform1i(l, v); }
  void setFloat(const char* n, float v) override { if (GLint l = loc(n); l >= 0) glUniform1f(l, v); }
  void setVec2(const char* n, const float* v) override { if (GLint l = loc(n); l >= 0) glUniform2fv(l, 1, v); }
  void setVec3(const char* n, const float* v) override { if (GLint l = loc(n); l >= 0) glUniform3fv(l, 1, v); }
  void setVec4(const char* n, const float* v) override { if (GLint l = loc(n); l >= 0) glUniform4fv(l, 1, v); }
  void setMat4(const char* n, const float* m, int count) override { if (GLint l = loc(n); l >= 0) glUniformMatrix4fv(l, count, GL_FALSE, m); }
  void setUniformBlock(const char* n, int binding) override {
    if (!cur_) return;
    GLuint idx = glGetUniformBlockIndex(cur_->id, n);
    if (idx != GL_INVALID_INDEX) glUniformBlockBinding(cur_->id, idx, GLuint(binding));
  }

  void draw(VertexInput v, uint32_t count, uint32_t first) override {
    glBindVertexArray(vaos_[v.id]);
    glDrawArrays(GL_TRIANGLES, GLint(first), GLsizei(count));
    draws_++;
    tris_ += count / 3;
  }
  void drawIndexed(VertexInput v, IndexType t, uint32_t count, uint32_t first, uint32_t instances) override {
    glBindVertexArray(vaos_[v.id]);
    GLenum it = t == IndexType::U16 ? GL_UNSIGNED_SHORT : GL_UNSIGNED_INT;
    const void* off = reinterpret_cast<const void*>(uintptr_t(first) * (t == IndexType::U16 ? 2 : 4));
    if (instances == 1) glDrawElements(GL_TRIANGLES, GLsizei(count), it, off);
    else glDrawElementsInstanced(GL_TRIANGLES, GLsizei(count), it, off, GLsizei(instances));
    draws_++;
    tris_ += uint64_t(count / 3) * instances;
  }
  void readPixels(int w, int h, std::vector<uint8_t>& rgba) override {
    rgba.resize(size_t(w) * h * 4);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
  }
  uint32_t drawCallsThisFrame() const override { return draws_; }
  void resetFrameStats() override { draws_ = 0; tris_ = 0; }
  uint64_t trianglesThisFrame() const override { return tris_; }
  size_t textureBytes() const override { return texBytes_; }
  size_t bufferBytes() const override { return bufBytes_; }

private:
  GLint loc(const char* n) {
    if (!cur_) return -1;
    auto it = cur_->locs.find(n);
    if (it != cur_->locs.end()) return it->second;
    GLint l = glGetUniformLocation(cur_->id, n);
    cur_->locs.emplace(n, l);
    return l;
  }

  DeviceInfo info_;
  uint32_t next_ = 1;
  std::unordered_map<uint32_t, GLuint> bufs_, vaos_;
  std::unordered_map<uint32_t, GLenum> bufTarget_;
  std::unordered_map<uint32_t, size_t> bufSize_;
  std::unordered_map<uint32_t, GLTex> texs_;
  std::unordered_map<uint32_t, GLProg> progs_;
  std::unordered_map<uint32_t, GLRT> rts_;
  std::unordered_map<uint32_t, size_t> rtBytes_;
  GLProg* cur_ = nullptr;
  PipelineState state_;
  uint32_t draws_ = 0;
  uint64_t tris_ = 0;
  size_t texBytes_ = 0, bufBytes_ = 0;
public:
  bool s3tc_ = false, s3tcSrgb_ = false;
};

std::unique_ptr<Device> createGLDevice(GetProc loader) {
  if (!gladLoadGLLoader(reinterpret_cast<GLADloadproc>(loader))) {
    SL_ERROR("could not load OpenGL functions");
    return nullptr;
  }
  if (!GLAD_GL_VERSION_4_1) SL_WARN("OpenGL 4.1 not reported; continuing (%d.%d)", GLVersion.major, GLVersion.minor);
  return std::make_unique<GLDevice>();
}

} // namespace sl::gfx
