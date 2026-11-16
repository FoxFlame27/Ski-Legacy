// Scene renderer on top of gfx::Device.
//   trails       the snow trail map (a camera-following toroidal height map the skis, boots, tracks and tyres press
//                into; world/snowtrails feeds it), faded over minutes
//   environment  the sky's radiance (sky.js ENV_FRAG) into a mip-mapped equirectangular map + its irradiance as
//                spherical harmonics (image-based lighting, refreshed with the time of day and the weather)
//   shadows      1-4 cascades fitted to the view (stable: bounding spheres, texel-snapped), one atlas, soft PCF
//   main pass    HDR (MSAA on the high presets, alpha to coverage on foliage): terrain (terrain.js's snow / rock +
//                high-res detail + trails), PBR meshes (static, skinned, instanced; pines, car paint, glass, the
//                Meshy detail layer), far forest impostors, the sky (sky.js + stars, moon, a ray-marched cumulus
//                layer), sorted transparent meshes; resolved, then soft lit particles (snow spray)
//   post         GTAO + sun shafts (reduced resolution, depth-aware), mip-chain bloom, PBR Neutral / ACES and the
//                broadcast grade (post.js), FXAA + contrast-adaptive sharpening, dither
//   HUD          text (stb_easy_font) and rectangles in pixels
// Everything is drawn camera-relative (the camera sits at the origin), so far from the village nothing jitters.
#pragma once
#include "core/math.h"
#include "engine/cloud_shapes.h"
#include "engine/model.h"
#include "gfx/gfx.h"
#include <string>
#include <vector>

namespace sl {

struct Camera {
  dvec3 pos{0};
  float yaw = 0, pitch = 0, roll = 0;   // yaw 0 looks toward +Z ... set via lookAt()
  mat3 basis{1};                        // columns: right, up, back (camera space)
  float fovY = 65, nearZ = 0.1f, farZ = 30000, aspect = 16.f / 9.f;
  void lookAt(const dvec3& eye, const dvec3& target, const vec3& up = vec3(0, 1, 0));
  mat4 view() const;                    // rotation only (camera-relative)
  mat4 proj() const;
  vec3 forward() const { return -basis[2]; }
};

struct Lighting {
  vec3 sunDir = glm::normalize(vec3(-0.35f, 0.42f, 0.84f));   // the key light: the sun, or the moon at night
  vec3 sunColor{1.0f, 0.93f, 0.82f};
  float sunIntensity = 6.0f;
  vec3 sky{0.26f, 0.42f, 0.78f}, ground{0.42f, 0.44f, 0.50f};   // (interiors: their ambient; outdoors the sky model's)
  vec3 fog{0.1633f, 0.4992f, 1.6117f};
  vec3 zenith{0.0313f, 0.0583f, 0.2011f}, mid{0.0417f, 0.3990f, 1.4235f}, horizon{0.3156f, 1.5195f, 5.2906f}, glow{0.4458f, 2.1394f, 6.6786f};
  float fogDensity = 0.000034f, fogFalloff = 0.00045f;
  float exposure = 0.72f;
  int toneMap = -1; // -1 the preset's, 0 ACES, 1 Neutral
  float night = 0;  // village.js nightUniform: 0 by day .. 1 at night (lamps, lit windows, signs)
  // the sky model (sky.js Environment.update) needs the sun itself and the weather; the defaults: a clear day
  vec3 trueSun{0};          // the sun's direction even at night (0: = sunDir)
  vec3 moonDir{0, -1, 0};
  float overcast = 0, snow = 0, mist = 0.1f, cloud = 0, snowCover = 0, wind = 0, icy = 0, frost = 0, clearAir = 0;
  float ambientScale = 1;   // tunnels: the sky light fades (railway.js)
  bool interior = false;    // inside a building: sky / ground above are the room's ambient, no sky IBL
  // (an interior) the web room's scene.environment, three's RoomEnvironment (a neutral grey studio) at its
  // environmentIntensity: the room's reflections and part of its diffuse light this neutral radiance (0: the room's
  // own warm light round you, ROOM_ENV of the ambient)
  float roomEnv = 0;
};

struct RenderSettings {
  int shadowSize = 2048;    // per cascade
  float shadowRange = 90;   // shadows end here (m; one cascade: half extent of the box round the focus)
  int cascades = 1;         // 1-4
  float renderScale = 1.0f; // 3D resolution scale (dynamic resolution on console)
  bool lowShaders = false;  // SL_LOW: single-tap shadows, no far normal maps, no glints
  int maxLights = 16;       // point / spot lights a frame (<= 16)
  int fx = 1;               // the web game's quality.fx realism tier (0..4)
  int terrainDetail = 1;    // terrain.js TERRAIN_DETAIL (0..2)
  int msaa = 1;             // samples
  int ao = 0;               // 0 off, 1 half resolution, 2 full
  int aoDirs = 2, aoSteps = 6;
  bool shafts = false;
  bool fxaa = true;
  float sharpen = 0.2f;
  int toneMap = 0;          // the preset's: 0 ACES, 1 PBR Neutral
  int grade = 2;
  int detailTex = 2048;     // the baked snow / rock maps (0: none)
  int trailSize = 1024;     // trail map texels (0: no trails)
  float trailRange = 96;    // m across
  int envSize = 256;
  float bloomRadius = 1.0f;
  bool pcss = false;        // contact-hardening soft sun shadows (needs fx >= 3)
};

/// a lamp's or a headlight's light: point (cosOuter < -1.5) or spot (dir, cones)
struct PointLight {
  dvec3 pos{0};
  vec3 color{1};            // linear rgb x intensity
  float range = 15;
  vec3 dir{0, -1, 0};
  float cosOuter = -2, cosInner = -2;
};
/// (SETTINGS: screen effects) the post pass's extras
struct ScreenFx { float vignette = 0, streaks = 0, flash = 0, hit = 0; };

/// A depression pressed into the snow (world/snowtrails): kind 0 ski groove, 1 boot print, 2 snowmobile track,
/// 3 tyre, 4 a mound of thrown snow. Sizes in metres; along = distance along the track (keeps tread continuous).
struct TrailStamp {
  dvec2 pos{0};
  vec2 dir{0, 1};
  float halfAlong = 0.5f, halfAcross = 0.1f;
  uint8_t kind = 0;
  float strength = 1, along = 0, extra = 0.05f, seed = 0;
};
/// A soft lit particle (snow spray, powder): world position, size (m), albedo + opacity.
struct Particle { dvec3 pos{0}; float size = 0.2f; vec4 color{1}; float rot = 0, soft = 0.3f; float kind = 0, seed = 0; };   // kind 0: a powder puff, 1: a clump, 2: a snow gun's mist, 3: a lamp's glow (additive; color = radiance, a = strength)
/// the snowfall (the renderer's GPU flakes): amount 0..1, the air's accumulated drift and velocity, rain 0..1 (sleet), time
struct Snowfall { float amount = 0, rain = 0, time = 0; vec3 drift{0}, vel{0, -1, 0}; };

/// A batch of instances of one model (trees): per instance vec4(x, y, z, scale) + vec4(yaw, 0, 0, 0).
class InstanceBatch {
public:
  struct Inst { vec4 posScale; vec4 rot; };
  void init(gfx::Device& d, const Model& m, uint32_t capacity);
  void upload(gfx::Device& d, const std::vector<Inst>& inst);
  uint32_t count() const { return count_; }
  const Model* model() const { return model_; }
  const std::vector<gfx::VertexInput>& inputs() const { return inputs_; }
private:
  const Model* model_ = nullptr;
  gfx::Buffer buf_;
  std::vector<gfx::VertexInput> inputs_;  // per primitive (mesh order)
  uint32_t count_ = 0, capacity_ = 0;
};

/// Far forest impostors: per instance vec4(x, y, z, height) + vec4(seed, type, fade start, fade length).
class ImpostorBatch {
public:
  struct Inst { vec4 a, b; };
  void init(gfx::Device& d, uint32_t capacity);
  void upload(gfx::Device& d, const std::vector<Inst>& inst);
  uint32_t count() const { return count_; }
  gfx::VertexInput input() const { return vi_; }
private:
  gfx::Buffer quad_, idx_, buf_;
  gfx::VertexInput vi_;
  uint32_t count_ = 0, capacity_ = 0;
};

/// Instances of one model with full 3x4 world matrices (props, lift towers, cabins): per instance three rows, the
/// translation relative to the batch origin (double precision on the CPU, camera-relative on the GPU).
class MatrixInstanceBatch {
public:
  struct Inst { vec4 r0, r1, r2, tint{1, 1, 1, 0}; };   // tint: paint / livery colour, a = 0: none
  void init(gfx::Device& d, const Model& m, uint32_t capacity);
  void upload(gfx::Device& d, const std::vector<Inst>& inst);
  /// frees its buffer and vertex inputs (init again to reuse it)
  void release(gfx::Device& d);
  uint32_t count() const { return count_; }
  const Model* model() const { return model_; }
  const std::vector<gfx::VertexInput>& inputs() const { return inputs_; }
  static Inst pack(const glm::dmat4& world, const dvec3& origin, const vec4& tint = vec4(1, 1, 1, 0));
private:
  const Model* model_ = nullptr;
  gfx::Buffer buf_;
  std::vector<gfx::VertexInput> inputs_;
  uint32_t count_ = 0, capacity_ = 0;
};

class Renderer {
public:
  bool init(gfx::Device& dev, const RenderSettings& s);
  void resize(int w, int h);
  /// (SETTINGS) 3D resolution scale and the sun's shadows, live
  void setRenderScale(float s) { set_.renderScale = s; resize(w_, h_); }
  float renderScale() const { return set_.renderScale; }
  bool shadowsOn = true;
  // SETTINGS: bloom; the screen effects; lights for this frame (call between beginFrame and endFrame)
  bool bloomOn = true;
  float bloomStrength = 0.13f, bloomThreshold = 3.0f;
  ScreenFx fx;
  void addLight(const PointLight& l) { lights_.push_back(l); }
  int lightsUsed() const { return lightsUsed_; }
  uint64_t triangles() const { return lastTris_; }
  int width() const { return w_; }
  int height() const { return h_; }
  gfx::Texture noiseTexture() const { return noise_; }
  gfx::Device& device() { return *dev_; }
  const RenderSettings& settings() const { return set_; }

  void beginFrame(const Camera& cam, const Lighting& light, const dvec3& shadowFocus);
  /// A model at world transform (origin + local matrix). pose: skinning (nullptr = rest).
  void submitModel(const Model& m, const dvec3& origin, const mat4& local, const Pose* pose, bool castShadow, int lod = 0, bool visible = true);
  /// visible: drawn in the main pass; cascade >= 0: casts into that shadow cascade only (a list culled to it)
  void submitInstances(const InstanceBatch& b, const mat4& fit, int lod, bool castShadow, bool visible = true, int cascade = -1);
  /// Matrix instances (origin: the batch's origin the instance translations are relative to). matOverride: draw
  /// every primitive with this material instead (a prop's night glow).
  void submitInstances(const MatrixInstanceBatch& b, const dvec3& origin, int lod, bool castShadow, const Material* matOverride = nullptr, bool visible = true, int cascade = -1);
  void submitTerrain(gfx::VertexInput vi, uint32_t indexCount, const dvec3& origin, bool castShadow, bool visible = true,
                     const dvec3& bmin = dvec3(0), const dvec3& bmax = dvec3(0), uint32_t firstIndex = 0);
  void submitImpostors(const ImpostorBatch& b, bool castShadow);
  /// the snow trails (world/snowtrails): stamps drawn into the trail map this frame, the map's centre
  void trailStamp(const TrailStamp& s) { if (set_.trailSize > 0) stamps_.push_back(s); }
  void trailFocus(const dvec3& p) { trailFocus_ = p; }
  /// (the valley mist) the ground's height round the camera: n x n samples (row z, column x) over `span` metres
  /// centred on `center` (world xz). world/groundmap keeps it up to date.
  void setGroundMap(const std::vector<float>& heights, int n, const dvec2& center, double span);
  bool wantsGroundMap() const { return bool(mist_); }
  bool trailsOn() const { return set_.trailSize > 0; }
  void addParticle(const Particle& p) { particles_.push_back(p); }
  void setSnowfall(const Snowfall& s) { snowfall_ = s; }
  /// atmosphere.js's cloud scenery for this frame (world/clouds): the cumulus cards, the overcast deck, the height map
  void setClouds(const CloudFrame& f);
  int snowFlakes() const { return snowN_; }
  /// Frustum test of a world-space box (for the caller's culling).
  bool visible(const dvec3& bmin, const dvec3& bmax) const;
  /// Whether a world-space box can cast into the shadow map (overlaps one of the cascades).
  bool castsShadow(const dvec3& bmin, const dvec3& bmax) const;
  /// per-instance culling of the forests' lists (camera-relative sphere): in the view frustum; in shadow cascade c's box
  bool sphereVisible(const vec3& c, float r) const {
    for (const vec4& p : planes_) if (p.x * c.x + p.y * c.y + p.z * c.z + p.w < -r) return false;
    return true;
  }
  bool sphereInCascade(const vec3& c, float r, int k) const {
    if (k >= nCasc_) return false;
    const mat4& V = casc_[k].view;
    const float lx = V[0][0] * c.x + V[1][0] * c.y + V[2][0] * c.z + V[3][0], ly = V[0][1] * c.x + V[1][1] * c.y + V[2][1] * c.z + V[3][1];
    const float R = casc_[k].radius + r;
    return std::fabs(lx) <= R && std::fabs(ly) <= R;
  }
  int shadowCascades() const { return inPortal_ ? std::min(nCasc_, 1) : nCasc_; }

  // HUD (pixels, origin top-left)
  void hudText(float x, float y, float scale, const vec4& color, const std::string& text);
  void hudRect(float x, float y, float w, float h, const vec4& color);
  static float hudTextWidth(const std::string& text, float scale);

  void endFrame();
  /// A second view in the same frame (the rooms' windows: game/window_view, the web game's liveportal.js): what was
  /// submitted since beginFrame is drawn as the world seen from that camera into the portal target (HDR, at
  /// portalScale of the 3D resolution, with its own depth and mist targets: between setPortalRect and endPortal the
  /// renderer works at that size; no AO, bloom or tone map: the frame it is shown in does those, once). The frame then
  /// starts over with beginFrame. A material of shading 9 shows the target by the pixel's place on the screen.
  void endPortal();
  gfx::Texture portalTexture() const { return portal_ ? dev_->renderTargetColor(portal_) : gfx::Texture{}; }
  /// what is submitted while this is on is drawn last in the main pass under an occlusion query (a room's windows):
  /// windowsSeen() says whether any pixel of it was on the screen a few frames ago (-1: no answer yet)
  bool occlusionTag = false;
  int windowsSeen() const { return occSeen_; }
  /// the portal picture's size against the 3D resolution (liveportal.js: 0.4 in the chalets, the station and the ward;
  /// here 0.75: at half the mountains' ridges and the roofs stair-stepped through the glass, and the pass is not bound by
  /// its pixels)
  float portalScale = 0.75f;
  /// the portal view leaves out what stands inside this box (the house you are in, seen from within): its centre, half
  /// extents and heading; until the next endPortal
  void setClipBox(const dvec3& centre, const vec3& half, double yaw) { clipC_ = centre; clipH_ = half; clipYaw_ = yaw; }
  /// the part of the screen the windows cover (NDC x0, y0, x1, y1), set before the portal's beginFrame: only what is
  /// seen through it is submitted and drawn; until the next endPortal
  void setPortalRect(const vec4& ndc) { portalRect_ = ndc; portalNext_ = true; }
  /// the camera the portal picture was drawn for (its view-projection, camera-relative, in the frame the windows are
  /// drawn in) and how far the eye has moved since: the glass shows the picture by direction (set before beginFrame)
  void setPortalView(const mat4& vp, const vec3& moved) { portalVP_ = vp; portalEye_ = moved; }
  /// shows the last frame again instead of drawing the scene (a screen transition covering a move: transition.js
  /// awaits the move behind its cover; here the old place stays on screen until it is covered)
  bool holdFrame = false;
  void readPixels(std::vector<uint8_t>& rgba) { dev_->readPixels(w_, h_, rgba); }
  uint32_t drawCalls() const { return lastDraws_; }
  const Camera& camera() const { return cam_; }
  const Lighting& lighting() const { return light_; }

private:
  struct Item {
    enum class Kind : uint8_t { Mesh, Instanced, InstMat, Terrain, Impostor } kind;
    gfx::VertexInput vi;
    uint32_t first = 0, count = 0, instances = 1;
    uint32_t sFirst = 0, sCount = 0;   // the shadow pass's (coarser) LOD
    const Material* mat = nullptr;
    const std::vector<mat4>* joints = nullptr;
    bool skinned = false, shadow = false, main = true, occl = false;
    mat4 model{1};
    vec3 origin{0};
    vec4 sphere{0, 0, 0, -1};   // camera-relative bounds (w < 0: unknown) for the per-cascade culling
    int8_t cascade = -1;        // >= 0: cast into this cascade only (its instances were culled to it)
    float height = 1;           // (pines) model height for the sway
  };
  struct Cascade { mat4 viewProj{1}, view{1}; float radius = 1, end = 1, texel = 1; vec4 rect{0, 0, 1, 1}; };
  void drawItems(bool shadowPass, int cascade);
  void drawItem(const Item& it, bool shadowPass, gfx::PipelineState& ps, gfx::Program& cur);
  /// the alpha-tested instanced foliage (the forests): depth first, then lit with GL_EQUAL (prezFoliage)
  bool prezItem(const Item& it) const;
  void drawPrepass(const Item& it, gfx::PipelineState& ps, gfx::Program& cur);
  void setMaterial(const Material& m, bool pine, float height);
  void makeNoiseTexture();
  void makeSkyNoise();
  void makeDetailTexture();
  void bakeTextures();
  void computeSky(const Lighting& L, struct FrameBlock& fb);
  void fitCascades(const dvec3& focus);
  void envPass();
  void trailPass();
  void particlePass();
  void glarePass();
  // atmosphere.js's clouds: the baked noise and impostor atlas (two RGBA8 maps), the toroidal terrain map, the cards
  // and the overcast deck, drawn at the end of the main pass
  void bakeClouds();
  void cloudPass();
  bool noClouds_ = false;
  int dbgW_ = 0, dbgH_ = 0;   // (dev: SKI_LEGACY_GFX=res=2560x1440: the 3D drawn at this size whatever the window: profiling a display not attached)
  bool dbgAoView_ = false;   // (dev: SKI_LEGACY_GFX=aoview: the AO term alone, grey)
  bool dbgNoRoomAo_ = false, dbgNoGrain_ = false, dbgNoPlank_ = false;   // (dev: SKI_LEGACY_GFX=noroomao,nograin,noplank)
  // the forests' depth prepass: their alpha-tested crowns (discard / alpha to coverage) defeated the GPU's hidden-
  // surface removal, every overlapping crown was shaded in full; SKI_LEGACY_GFX=noprez for A/B runs
  bool prez_ = true, dbgNoPine_ = false;
  gfx::Program cardP_, deckP_;
  gfx::RenderTarget cloudNoiseRT_, atlasRT_[2];
  gfx::Texture cloudTerrain_;
  gfx::Buffer cloudQuad_, cloudIdx_, cardBuf_;
  gfx::VertexInput cardVi_, deckVi_;
  std::vector<CloudCard> cards_;
  std::vector<vec4> cardData_;
  float deckCover_ = 0, deckH_ = 620, deckAbove_ = 1;
  bool deckLean_ = false;
  dvec2 deckDrift_{0};
  vec3 cSun_{0}, cSky_{0}, cGnd_{0};
  vec4 rays_[32]; float rayI_[32];
  vec3 glareCore_{0};
  void aoPass();
  // the ambient occlusion's level this frame: the preset's, or in a room (below High: no AO outdoors) a half-resolution
  // pass of its own: the corners, the floor under the racks and shelves, the gaps between the planks
  int aoLevel() const { return set_.ao > 0 ? set_.ao : light_.interior && !set_.lowShaders && !dbgNoRoomAo_ ? 1 : 0; }
  void ensureAo();
  gfx::Program build(const char* name, const char* defines, const char* vs, const char* fs, bool lit, const char* extra = nullptr);
  bool inCascade(const Item& it, int c) const;

  gfx::Device* dev_ = nullptr;
  RenderSettings set_;
  int w_ = 1, h_ = 1, rw_ = 1, rh_ = 1;
  bool frameDrawn_ = false;   // the targets hold a finished frame (holdFrame)
  gfx::RenderTarget hdr_, msaa_, depthCopy_, shadow_, ldr_, env_, envRoom_, aoRaw_, aoTex_, trail_, portal_;
  int pw_ = 0, ph_ = 0, portalIdle_ = 0;
  // (the portal's own small targets, swapped in for hdr_ / depthCopy_ / the mist's while its view is drawn)
  gfx::RenderTarget pDepth_, pMist_, pMist2_;
  int pBaseW_ = 0, pBaseH_ = 0, pmw_ = 0, pmh_ = 0;
  bool portalNext_ = false, inPortal_ = false;
  // (the windows' occlusion queries: a ring of 4 frames; state 0 none drawn, 1 waiting for the GPU)
  int occFrame_ = 0, occSeen_ = -1, occState_[4] = {0, 0, 0, 0};
  void readOcclusion();
  void swapPortalTargets();
  void freePortal();
  vec4 portalRect_{-1, -1, 1, 1};
  mat4 portalVP_{1};
  vec3 portalEye_{0};
  dvec3 clipC_{0}; vec3 clipH_{0}; double clipYaw_ = 0;
  void scenePasses(bool portal);
  std::vector<gfx::RenderTarget> bloom_;
  std::vector<std::pair<int, int>> bloomSize_;
  int aw_ = 1, ah_ = 1, atlasW_ = 1, atlasH_ = 1;
  gfx::Buffer frameUbo_, shadowUbo_[4], hudVbo_, lightsUbo_, stampVbo_, stampQuad_, stampIdx_, partVbo_;
  gfx::VertexInput stampVi_, partVi_;
  gfx::Program glare_, bloomDown_, bloomUp_, ao_, aoBlur_, final_, fxaa_, env_p_, stamp_, trailFade_, particle_, impostor_, depthImp_;
  std::vector<PointLight> lights_;
  std::vector<TrailStamp> stamps_;
  std::vector<Particle> particles_;
  dvec3 trailFocus_{0};
  dvec2 trailCenter_{1e18};
  double trailFadeT_ = 0;
  int lightsUsed_ = 0;
  uint64_t lastTris_ = 0;
  void uploadLights();
  void bloomPass();
  gfx::VertexInput hudVi_, emptyVi_;
  gfx::Program mesh_, meshOpq_, meshSkin_, meshInst_, meshPine_, meshInstEq_, preInst_, meshInstMOpq_, meshInstM_, terrain_, depthMesh_, depthSkin_, depthInst_, depthInstM_, depthTerrain_, sky_, hud_;
  gfx::Texture noise_, white_, flatN_, skyNoise_, detail_, snowTex_, rockTex_, blackTex_;
  gfx::RenderTarget snowRT_, rockRT_;
  // the valley mist: half-resolution target, the ground height map (R16F, mip-mapped)
  gfx::Program mist_, mistUp_, mistBlur_;
  gfx::RenderTarget mistRT_, mistRT2_;
  gfx::Texture groundTex_;
  vec4 groundMap_{0}, mistP_{0}, mistP2_{0};
  int mw_ = 0, mh_ = 0;
  void mistPass();
  // the snowfall: one instanced draw of seeded quads
  gfx::Program snow_;
  gfx::Buffer snowSeeds_;
  gfx::VertexInput snowVi_;
  int snowN_ = 0, crystalN_ = 0;
  Snowfall snowfall_;
  void snowPass();
  std::vector<Item> items_;
  std::vector<const Item*> blend_;
  std::vector<float> hudVerts_;
  Camera cam_;
  Lighting light_;
  mat4 viewProj_{1};
  Cascade casc_[4];
  int nCasc_ = 1;
  vec4 planes_[6];
  uint32_t lastDraws_ = 0;
  const Material* lastMat_ = nullptr;   // (drawItem: the material the draw before set, skipped when the next one's is the same)
  bool lastPine_ = false;
  float lastHeight_ = 0;
  double time_ = 0, lastClock_ = -1, windPhase_ = 0, frameClockDt_ = 0;
  dvec2 mistDrift_{0};
  bool noMist_ = false;
  vec3 envZenith_{0}, envHorizon_{0}, envSun_{0}, envGlow_{0}, roomEnvZ_{0}, roomEnvH_{0};   // (roomEnv: an interior's own reflection)
  vec2 sunUV_{0};
  float shaftsK_ = 0;
  vec3 sunCol_{0};
};

} // namespace sl
