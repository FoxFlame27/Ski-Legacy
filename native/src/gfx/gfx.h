// gfx: the thin rendering interface the engine draws through.
//
// It mirrors what modern explicit APIs have in common (buffers, textures, programs, vertex input layouts, render
// targets, fixed-function state, indexed / instanced draws) at the level the game needs, so that an NVN (Nintendo
// Switch) or Vulkan backend can replace the OpenGL 4.1 one (gfx/gl/) without touching the renderer above it.
// Handles are plain integers; 0 is "none". Programs are created from GLSL 410 sources today; another backend would
// take precompiled shader binaries keyed by the same program names.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sl::gfx {

struct Buffer { uint32_t id = 0; explicit operator bool() const { return id != 0; } };
struct Texture { uint32_t id = 0; explicit operator bool() const { return id != 0; } };
struct Program { uint32_t id = 0; explicit operator bool() const { return id != 0; } };
struct VertexInput { uint32_t id = 0; explicit operator bool() const { return id != 0; } };
struct RenderTarget { uint32_t id = 0; explicit operator bool() const { return id != 0; } }; // 0 = the window

enum class BufferUsage : uint8_t { Vertex, Index, Uniform };
enum class AttribType : uint8_t { Float, UByte, UShort, Short, Byte };
enum class IndexType : uint8_t { U16, U32 };
enum class TexFormat : uint8_t { RGBA8, SRGBA8, RGBA16F, R8, Depth24, Depth32F, R16F, RG16F, R11G11B10F, RG8 };
enum class Filter : uint8_t { Nearest, Linear, Trilinear };
enum class Wrap : uint8_t { Repeat, Clamp };
enum class Cull : uint8_t { None, Back, Front };
// Max: per-channel max (trail stamps); Multiply: dst * src (fades); Premul: premultiplied alpha
enum class Blend : uint8_t { Opaque, Alpha, Additive, Max, Multiply, Premul };
enum class DepthTest : uint8_t { Off, Less, LessEqual };

struct VertexAttrib {
  uint32_t location = 0;      // shader input location
  uint32_t buffer = 0;        // index into the buffers given to createVertexInput
  int components = 3;
  AttribType type = AttribType::Float;
  bool normalized = false;
  uint32_t offset = 0, stride = 0;
  bool perInstance = false;   // advances once per instance (instancing)
};

struct TextureDesc {
  int width = 1, height = 1;
  TexFormat format = TexFormat::RGBA8;
  Filter filter = Filter::Trilinear;
  Wrap wrap = Wrap::Repeat;
  bool mipmaps = true;
  float anisotropy = 4;
  bool depthCompare = false;  // shadow map sampler (sampler2DShadow)
};

struct PipelineState {
  DepthTest depth = DepthTest::Less;
  bool depthWrite = true;
  Cull cull = Cull::Back;
  Blend blend = Blend::Opaque;
  bool colorWrite = true;
  float depthBiasFactor = 0, depthBiasUnits = 0;  // polygon offset (shadow maps)
  bool alphaToCoverage = false; // MSAA: alpha-tested foliage gets smooth edges
};

struct DeviceInfo { std::string api, renderer, version; int maxAnisotropy = 1; int maxSamples = 1; int maxTextureSize = 4096; };

class Device {
public:
  virtual ~Device() = default;
  virtual const DeviceInfo& info() const = 0;

  // resources
  virtual Buffer createBuffer(BufferUsage usage, const void* data, size_t bytes, bool dynamic = false) = 0;
  virtual void updateBuffer(Buffer b, const void* data, size_t bytes, size_t offset = 0) = 0;
  /// Replace the whole contents (orphans the old storage: safe while the GPU still reads it).
  virtual void replaceBuffer(Buffer b, const void* data, size_t bytes) = 0;
  virtual void destroy(Buffer b) = 0;

  virtual Texture createTexture(const TextureDesc& d, const void* pixels) = 0;
  /// (Phase 7) a block-compressed texture: BC1 (8 bytes a 4x4 block) or BC3 (16), sRGB or linear, every mip level given
  /// (d.format / d.mipmaps are ignored). supportsBC(srgb): whether the device takes them (else upload RGBA8).
  virtual bool supportsBC(bool srgb) const = 0;
  virtual Texture createCompressedTexture(const TextureDesc& d, bool bc3, bool srgb, const std::vector<std::vector<uint8_t>>& levels) = 0;
  virtual void destroy(Texture t) = 0;

  /// GLSL 410 sources; returns 0 (and logs) on a compile / link error.
  virtual Program createProgram(const char* name, const std::string& vs, const std::string& fs) = 0;
  virtual void destroy(Program p) = 0;

  virtual VertexInput createVertexInput(const std::vector<VertexAttrib>& attribs, const std::vector<Buffer>& buffers,
                                        Buffer indexBuffer) = 0;
  virtual void destroy(VertexInput v) = 0;

  /// Off-screen target: optional colour texture (format) and depth texture. Either may be "none" via `withColor`.
  virtual RenderTarget createRenderTarget(int w, int h, bool withColor, TexFormat color, bool withDepth, TexFormat depth,
                                          bool depthCompare = false) = 0;
  /// Multisampled target (renderbuffers: not sampleable): draw into it, then resolve() into a plain target.
  virtual RenderTarget createRenderTargetMS(int w, int h, int samples, TexFormat color, TexFormat depth) = 0;
  /// Copies (resolves) colour and / or depth of src into dst (same size).
  virtual void resolve(RenderTarget src, RenderTarget dst, int w, int h, bool color, bool depth) = 0;
  /// Mip chain of a texture from its level 0 (render targets: after drawing).
  virtual void generateMipmaps(Texture t) = 0;
  /// Change a texture's sampling (filter, wrap, anisotropy); Trilinear needs mips (generateMipmaps).
  virtual void setSampling(Texture t, Filter f, Wrap w, float anisotropy) = 0;
  virtual Texture renderTargetColor(RenderTarget rt) const = 0;
  virtual Texture renderTargetDepth(RenderTarget rt) const = 0;
  virtual void destroy(RenderTarget rt) = 0;

  // frame
  virtual void bindRenderTarget(RenderTarget rt, int w, int h) = 0;
  virtual void clear(float r, float g, float b, float a, bool color, bool depth) = 0;
  /// Sub-rectangle of the bound target (shadow cascades in an atlas); scissored clears stay inside it.
  virtual void setViewport(int x, int y, int w, int h, bool scissor = false) = 0;
  virtual void setPipeline(const PipelineState& s) = 0;
  virtual void useProgram(Program p) = 0;
  virtual void bindTexture(int unit, Texture t) = 0;
  virtual void bindUniformBuffer(int binding, Buffer b) = 0;

  // uniforms of the program in use (looked up by name, cached)
  virtual void setInt(const char* name, int v) = 0;
  virtual void setFloat(const char* name, float v) = 0;
  virtual void setVec2(const char* name, const float* v) = 0;
  virtual void setVec3(const char* name, const float* v) = 0;
  virtual void setVec4(const char* name, const float* v) = 0;
  virtual void setMat4(const char* name, const float* m, int count = 1) = 0;
  virtual void setUniformBlock(const char* name, int binding) = 0;

  virtual void draw(VertexInput v, uint32_t vertexCount, uint32_t firstVertex = 0) = 0;
  virtual void drawIndexed(VertexInput v, IndexType t, uint32_t indexCount, uint32_t firstIndex = 0,
                           uint32_t instances = 1) = 0;

  /// Read back the window's pixels (RGBA8, bottom-up). For tests / screenshots.
  virtual void readPixels(int w, int h, std::vector<uint8_t>& rgba) = 0;
  virtual uint32_t drawCallsThisFrame() const = 0;
  virtual void resetFrameStats() = 0;
  // (Phase 7) the performance numbers the autotest prints: triangles drawn since the reset, GPU memory held
  virtual uint64_t trianglesThisFrame() const = 0;
  virtual size_t textureBytes() const = 0;
  virtual size_t bufferBytes() const = 0;
};

using GetProc = void* (*)(const char*);
/// Creates the OpenGL 4.1 core device on the current context. (Other backends: createNvnDevice / createVulkanDevice.)
std::unique_ptr<Device> createGLDevice(GetProc loader);

} // namespace sl::gfx
