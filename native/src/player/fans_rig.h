// The crowd people: a port of src/world/fans.js — the eight Meshy townsfolk / spectator characters (fan_*.glb) with
// their own procedural motion (no canned clips), as the web game draws its village people (townsfolk.js), its station
// people (railpeople.js) and its race spectators (crowds.js).
//
// FanKit (fans.js FanKit), built once per character from the GLB itself:
//  - the rest skeleton of the 20 animated bones (model space: metres, feet at y = 0, facing +z, the character's left
//    = +x), the hands' finger / palm axes and grip point measured from the skinned mesh, the legs' bind look (Meshy
//    knees behind or in front of the leg line), the body's heights, the posture fix
//  - the keyframes: every pose of fans.js bakeKeyframes posed on the three-style scene graph with its two-bone IK
//    (relaxed stances on either leg, hands held, the cheering poses, a crouch, the twelve phases of the walking cycle,
//    talking with the hands, a phone, pointing, a shrug, a glance at the watch, skis carried over the right shoulder),
//    stored as each bone's rotation relative to its palette parent + the hips' position (Float32, as the JS)
//  - the three LOD geometries (the textured mesh near, the vertex-coloured stand-ins further out) baked to model space
//    with the skin weights reworked like the JS (separateArms: the jacket's sides under the armpits back to the trunk by
//    geodesic distance over the welded mesh; cleanWeights: a vertex is on the body or on the arm), the recolour mask
//    (jacket / trousers, never face, hands, boots), the jacket's own colour (jacketBase: the recolour key) and the
//    hand-held props (the carried skis)
// Posing (fans.js blendN / blend4 / poseDyn / composeRow): a person's skeleton is a normalized quaternion blend of a
// few keyframes, chained into model-space bones with the head turn split over chest / neck / head, written as the
// skinning matrices (3 x 4) the shader uses; the carried skis ride on the posed chest.
// Same constants, operation for operation in double precision with three's maths (player/three_math.h) and the JS's
// Float32 storage where the JS has Float32Arrays: `--verify-poses` compares every keyframe, the bake and posed
// timelines bone by bone against the JS (native/tools/ref_poses.mjs -> fans_ref.json).
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include "player/three_math.h"
#include <array>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sl {
class AssetManager;
namespace gfx { class Device; }

namespace fans {
constexpr int NBA = 20;          // animated bones
constexpr int PROP = NBA;        // + one bone for the hand-held prop
constexpr int NB = NBA + 1;
constexpr int NWALK = 12;        // phases of the walking cycle
constexpr double WALK_STRIDE = 1.16;   // m covered by one walking cycle (two steps)
enum Key : int {
  STAND_L, STAND_R, HOLD, CLAP_O, CLAP_S, CLAPHI_O, CLAPHI_S, VUP_A, VUP_B, WAVE_A, WAVE_B, PUMP_LO, PUMP_HI, FLAG_REST, FLAG_A,
  FLAG_B, BELL_REST, BELL_A, BELL_B, CROUCH, POCKET, WALK0, TALK_A = WALK0 + NWALK, TALK_B, TALK_C, PHONE, POINT, SHRUG, WATCH,
  CARRY, NK
};
enum Bone : int {
  Hips, Spine02, Spine01, Spine, neck, Head, LeftShoulder, LeftArm, LeftForeArm, LeftHand, RightShoulder, RightArm, RightForeArm,
  RightHand, LeftUpLeg, LeftLeg, LeftFoot, RightUpLeg, RightLeg, RightFoot
};
extern const char* const BONE_NAMES[NBA];
extern const char* const MODELS[8];   // FAN_MODELS
/// fans.js JACKETS (sRGB)
extern const char* const JACKETS[13];
} // namespace fans

/// fans.js FanKit: one character's skeleton, keyframes, baked geometry and (after upload) its GPU models.
class FanKit {
public:
  using V3 = three::V3;
  using Q = three::Q;
  /// Bakes everything from the GLB's bytes (fans.js FanKit constructor). False (and a log line) when the model lacks
  /// the bones / a skinned mesh.
  bool build(const std::string& name, const std::vector<uint8_t>& glb);
  /// The GPU models: the three LODs (materials from `textured`: the same GLB loaded by the AssetManager, its textures)
  /// and the carried skis in their six colour schemes.
  void upload(gfx::Device& dev, const Model* textured);

  std::string name;
  struct Cfg { double share = 1, s0 = 0.97, s1 = 1.03, keep = 0.3; } cfg;
  int8_t parent[fans::NBA] = {};
  std::array<float, fans::NBA * 3> P0{}, O{};
  std::array<float, fans::NBA * 4> Q0{}, Q0i{};
  struct Hand { bool ok = false; V3 f{0}, n{0}, grip{0}, gripRest{0}; double len = 0; } hand[2];
  V3 G{0}, gripLocal{0};
  V3 shL{0}, shR{0}, footL{0}, footR{0};
  double armLen = 0, hipY = 0, headY = 0, neckY = 0, chestY = 0, postureFix = 0, height = 0;
  struct LegInfo { double L = 0, d = 0; bool back = false; } legInfo[2];
  bool hasBase = false;
  glm::dvec4 base{0, 0, 0, 1};               // jacketBase (I, Q, luma, cos threshold)
  std::vector<float> kq, kh;                 // keyframes: NK x NBA quaternions (x, y, z, w), NK hips positions
  bool hasCarry = false;
  std::array<float, 4> carryRel{0, 0, 0, 1};
  V3 carryAnchor{0};
  /// a baked LOD: positions / normals (model space), uv (textured), colours (vertex-coloured), 4 palette bones +
  /// weights, aInfo (kind, mask / prop u, prop v); body vertices first (nBody), then the props
  struct Geo {
    std::vector<float> P, N, U, C, Bn, Wt, Info;
    std::vector<uint32_t> idx;
    size_t nBody = 0, nBodyIdx = 0;
    bool uv = false, col = false;
  };
  Geo geos[3];
  int lodMaterial[3] = {0, 1, 1};           // the GLB material of each LOD's primitive
  double bakeMs = 0;
  // GPU
  std::shared_ptr<Model> lod[3];
  std::shared_ptr<Model> skis[6];

private:
  struct Node { std::string name; int parent = -1; std::vector<int> children; V3 t{0}, s{1}; Q r{1, 0, 0, 0}; bool bone = false; int mesh = -1, skin = -1; };
  struct Prim {   // a SkinnedMesh (one glTF primitive): its vertex data as three reads it (normalized ints decoded in double)
    int node = -1, skin = -1, material = 0;
    std::vector<double> pos, nor, uv, col, w;
    std::vector<int> j;
    std::vector<uint32_t> idx;
    bool hasUv = false, hasCol = false;
    size_t count = 0;
  };
  struct Skin { std::vector<int> joints; std::vector<three::M4> inv; };
  std::vector<Node> nodes_;
  std::vector<int> roots_;
  std::vector<Prim> prims_;
  std::vector<Skin> skins_;
  std::vector<int> bones_;              // the 20 animated bones (node index)
  std::vector<int> allBones_;
  std::vector<std::pair<V3, Q>> restLocal_;
  mutable std::vector<three::M4> W_;
  mutable std::vector<uint8_t> ok_;
  // scene graph (three's Object3D, matrices always up to date as the JS keeps them)
  three::M4 world(int n) const;
  void touch() const { std::fill(ok_.begin(), ok_.end(), 0); }
  V3 wpos(int n) const { return V3(world(n)[3]); }
  Q wquat(int n) const { return three::qnormalize(three::decomposeQ(world(n))); }
  void setWorldQuat(int n, const Q& q);
  void rotateWorld(int n, const V3& axis, double angle);
  void aimBone(int n, const V3& from, const V3& to, const V3& pivot);
  void solveTwoBone(int a, int b, int c, const V3& target, const V3& pole, double maxReach = INFINITY);
  V3 worldToLocal(int n, const V3& p) const;
  int B(int i) const { return bones_[size_t(i)]; }
  // FanKit's methods
  void measureHands(const Prim& m);
  std::vector<V3> boneVerts(const Prim& m, int bone, double minW) const;
  void measureLegs();
  void solveLeg(int k, const V3& t, double s);
  void measureBody();
  struct PropGeo { std::vector<float> P, N, I; std::vector<uint32_t> idx; size_t count = 0; };
  PropGeo buildProps() const;
  void bakeGeometry(const Prim& m, const PropGeo& prop, Geo& out);
  void jacketBase(const Geo& g);
  void resetPose();
  void poseArm(int side, const V3& hand, const V3& pole, const V3* f, const V3* n, double shrug = 0);
  V3 sh(int side) const { return wpos(B(side > 0 ? fans::LeftArm : fans::RightArm)); }
  void hang(int side, double out = 0.0, double fwd = 0.04, double bend = 0.04);
  void spine(double lean = 0, double side = 0, double twist = 0);
  void head(double pitch = 0, double yaw = 0);
  void legs(double dx = 0, double dy = 0, double dz = 0, double roll = 0, double pitch = 0);
  double walkLegs(double p);
  void walk(double p);
  struct CarryLine { V3 anchor, d; };
  CarryLine carryLine(const V3& sh) const;
  void measureCarry();
  void pose(int k);
  void bakeKeyframes();
};

/// (`--verify-poses`) the fans against the JS reference (fans_ref.json from tools/ref_poses.mjs): 0 pass, 1 fail, 2 missing
int verifyFans(AssetManager& assets, const std::string& refPath);

namespace fans {
/// fans.js blendN: normalized weighted sum of nk keyframe quaternions of bone b (out: 4 floats)
void blendN(const float* kq, int b, const int* ks, const float* ws, int nk, float* out);
/// fans.js blend4
void blend4(const float* kq, int b, int k0, double w0, int k1, double w1, int k2, double w2, int k3, double w3, float* out);
/// fans.js composeRow: locals L (NB x 4) -> the row of skinning matrices pal (NB x 12, rows of 3 x 4); W / Pw: the
/// model-space bone rotations / positions (scratch, read by the checks). carry: the carried skis on the chest.
void composeRow(const FanKit& kit, const float* L, double hx, double hy, double hz, double lookY, double lookP, const float* pq,
                bool carry, float* pal, float* W, float* Pw);
/// one row of the palette -> a column-major skinning matrix
mat4 skinMatrix(const float* row12);
} // namespace fans

/// The moving people of one crowd (fans.js FanCrowd with `dynamic`): per person the character, scale, personality,
/// colours, place and the pose inputs a simulation sets each frame; poseDyn turns them into the person's skeleton.
class FanCrowd {
public:
  using Rnd = std::function<double()>;
  /// fans.js FanCrowd constructor (the dynamic crowd's share of it), drawing from rnd in the JS's order: n people at
  /// the given spots (y = ground), `kitOf` >= 0 forces a character
  void init(const std::vector<std::shared_ptr<FanKit>>& kits, int n, const Rnd& rnd, const std::vector<int>& kitOf = {});
  int n = 0;
  std::vector<std::shared_ptr<FanKit>> kits;
  // per person (fans.js typed arrays: Float32 where the JS has Float32Array)
  std::vector<uint8_t> kit, calm, style, jumper;
  std::vector<float> scl, mat, pos, yaw, energy, phase, rate, thresh, lookY, lookP, e;
  std::vector<float> palC;            // per person 8 constants (fans.js pal row's last two texels): jacket rgb / -1, prop, flag, flutter phase, flutter, ski colours
  // the dynamic inputs (FanCrowd.dyn)
  struct Dyn { std::vector<float> alpha, walk, wph, talk, holdW, lookY, lookP; std::vector<uint8_t> hold, carry; } D;
  // LOD state
  std::vector<int8_t> lod, next;
  std::vector<float> fade, dist;
  std::vector<uint8_t> inView, stale, rag;
  int frame = 0;
  // palette (per person NB x 12 floats) + scratch
  std::vector<float> pal;
  float L[fans::NB * 4] = {}, W[fans::NB * 4] = {}, Pw[fans::NB * 3] = {};
  /// fans.js setPlace: feet at (x, y, z), facing yaw
  void setPlace(int i, double x, double y, double z, double yaw);
  /// fans.js poseDyn: person i's skeleton into its palette row
  void poseDyn(int i, double t, double dt);
  const float* row(int i) const { return &pal[size_t(i) * fans::NB * 12]; }
};

} // namespace sl
