// The skier rig: a port of src/player/skier.js (SkierRig) — the procedurally animated Meshy character every skier in
// the game is (you, the resort's skiers and walkers, the race field, the police officer, the job people).
//
// Same as the JS, operation for operation, in double precision and three.js's own math (player/three_math.h): every
// frame the skeleton is reset to the bind (A-)pose and built again by the mode's poser — on foot the Meshy clips
// (Idle / Casual_Walk / Run_02 of the character's _anims.glb) through an AnimationMixer emulation (weights normalised,
// time scale from the ground speed, the hips' root motion stripped) and the hand-tuned standing pose; skiing the
// stance, carving inclination with angulation and counter-rotation, the edge-change spring, the body-on-a-spring
// inertia, tuck, snowplough, hockey stop, the jump phases (load, pop, air, landing prep), grabs, spins, flips about the
// centre of mass, pole plants and the poles swinging from the wrist straps; crashes (the tucked ball, lying, getting
// up, laid on the snow by a ground solver that bounces); seated on a chair, a bench / car seat or astride a
// snowmobile; the skis on the feet or strapped to the back. Mode changes blend over 0.3 s (smoothstep) from a snapshot.
// The same constants, blend times, bone names and axis conventions: `--verify-poses` replays the JS reference
// timelines (tools/ref_poses.mjs) and compares every bone.
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
class Renderer;
namespace platform { class Platform; }
class Player;
class World;
enum class PlayerMode : uint8_t;

enum class RigMode : uint8_t { Idle, Walk, Ski, Fall, Sit };
enum class GrabType : uint8_t { None, Mute, Safety, Japan };

/// skier.js update(dt, st): the state a caller poses the rig with (NPCs leave most of it at the defaults)
struct RigState {
  RigMode mode = RigMode::Idle;
  double heading = 0, speed = 0, crouch = 0, lean = 0;
  bool hasEdge = false; double edge = 0;          // (st.edge undefined: lean * 0.6)
  bool tuck = false;
  double plow = 0, skid = 0;
  bool hasNormal = false; three::V3 normal{0, 1, 0};
  bool air = false;
  double flip = 0;
  bool hasFlipHeading = false; double flipHeading = 0;
  double grab = 0; GrabType grabType = GrabType::None;
  double spinVel = 0, charge = 0;
  bool hasFall = false;
  struct Fall { double ball = 0, getUp = 0, pitch = 0, roll = 0; } fall;
  int fallSide = 1;
  bool hasFallHeading = false; double fallHeading = 0;
  bool fallAir = false;
  double fallT = 0, flail = 0;
  double lookYaw = 0, lookPitch = 0;
  bool hasSeat = false; three::V3 seat{0};
  /// a bench / a chair / a car or train seat (seating.js): along the facing from the seat point (m); NaN = none
  bool hasBench = false;
  struct Bench { double back = std::nan(""), front = std::nan(""), floorY = std::nan(""), recline = 0; bool legsOut = false; } bench;
  /// astride a snowmobile (snowmobile.js): seat-relative grip / foot (x left, y up, z forward), steering column
  bool hasSled = false;
  struct Sled { three::V3 grip{0}, foot{0}; double pivot = 0, turn = 0, steer = 0; } sled;
  bool carry = false;
  double airY = 0;
  int fp = -1;   // -1: undefined (NPCs), 0 / 1 (the player)
};

/// Per character model: the skeleton, its measurements (skier.js BODY_CACHE + the constructor's rest-pose values) and
/// the clips. Shared by every rig of that character.
struct RigModel {
  std::shared_ptr<Model> body;
  std::string name;
  std::vector<int> bones;                     // three's allBones: the skin's joints in traversal order
  std::vector<std::vector<int>> below;        // per node: itself and every node under it
  int skinPrim = -1, skinMesh = -1;           // the skinned primitive the measurements read
  enum B { hips, spine0, spine1, spine2, neck, head, lSh, rSh, lArm, lFore, lHand, rArm, rFore, rHand, lUp, lLeg, lFoot, rUp, rLeg, rFoot, NB };
  int b[NB];
  // rest-pose measurements (root at the origin, unrotated)
  three::V3 hipRest{0};
  double ankleH = 0, hipDrop = 0, hipHalfW = 0.17, legLen = 0, thighLen = 0, shinLen = 0, shoulderW = 0, armLen = 0, hipWidth = 0;
  double upLegDrop = 0, footFwd = 0, armRaise = 0, postureFix = 0, backDepth = 0.2, seatDepth = 0.2;
  three::Q footRest[2], footRestInv[2];
  struct Hand { bool ok = false; three::V3 dir{0}, normal{0}; } hand[2];
  three::V3 eyeOffset{0, 0.08, 0.07};
  // clips (skier.js setupClips): idle, walk, run
  struct Clip { AnimClip clip; std::vector<int> node; double speed = 0; bool ok = false; };
  Clip clips[3];
  bool hasClips = false;
  /// (skier.js measureCarry / measureHips / measureHand need the skinned vertices: keepCpu at load)
  bool build(std::shared_ptr<Model> body, const Model* anims, const std::function<double(double, double, double)>& ground,
             const std::function<double()>& random = nullptr);
};

/// The ski / pole models oriented like skier.js makeSki (fileFrameSki) / makePole (fitModel, grip at the origin).
struct RigGear {
  std::shared_ptr<Model> ski, pole;
  glm::dmat4 skiFit{1}, poleFit{1};   // model -> the ski's / pole's own frame (node globals included for the ski)
  void build(std::shared_ptr<Model> ski, std::shared_ptr<Model> pole);
};

class SkierRig {
public:
  using Ground = std::function<double(double x, double z, double yHint)>;
  SkierRig() = default;
  /// (skier.js constructor) a rig of `model` with `gear` (skis: may be null; poles: may be null)
  void init(std::shared_ptr<RigModel> model, std::shared_ptr<RigGear> gear, bool skis, bool poles, Ground ground);
  bool ready() const { return bool(M_); }
  void setGround(Ground g) { ground_ = std::move(g); }
  /// (--verify-poses) the constructor's random phases, as the JS reference sets them
  void setPhases(double gaitPhase, double gaitT, double idleT, double skT) { gait_.phase = gaitPhase; gait_.t = gaitT; idle_.t = idleT; sk_.t = skT; }
  const RigModel& model() const { return *M_; }

  // ---- skier.js API
  void update(double dt, const RigState& st);
  void startPolePlant(int side, const three::V3& fwd, const three::V3& right);
  void snapPose();
  void setCarry(bool c) { carry_ = c; }
  void setSkisVisible(bool v);
  void setHeadHidden(bool h) { headHidden_ = h; }
  bool polesHidden = false;
  /// random source (Math.random): the verify mode feeds the JS sequence
  std::function<double()> random;
  /// AI skiers' seeded style (aistate.js makeStyle; null = the player's own stance)
  struct Style { double sway = 1, stance = 0, plantDur = 1, plantReach = 1, armF = 0, armU = 0, armO = 0; };
  bool hasStyle = false; Style style;
  three::V3 rootPos{0};        // the root (feet) position: set before update (poseFootClips moves it onto the ground)
  double rootHeading = 0;

  // ---- results
  three::V3 eyeStable{0};
  three::V3 eyeWorld() const;
  /// local TRS of bone / node i (three's bone.position / quaternion / scale)
  const three::V3& localT(int i) const { return t_[size_t(i)]; }
  const three::Q& localR(int i) const { return r_[size_t(i)]; }
  three::M4 worldMatrix(int i) const { return W(i); }
  /// the clips' playback (k: idle / walk / run): the mixer action's time and the blend weight (skier.js clips[k])
  double clipTime(int k) const { for (auto& a : actions_) if (a.clip == k) return a.time; return -1; }
  double clipWeight(int k) const { return clipW_[k]; }
  const char* modeName() const { static const char* n[] = {"foot", "move", "sit", "ski", "fall"}; return n[int(mode_)]; }
  double blendT() const { return blend_; }
  struct GearObj { three::V3 p{0}; three::Q q{1, 0, 0, 0}; bool visible = true; };
  GearObj skis[2], poles[2];
  bool hasSkis() const { return hasSkis_; }
  bool hasPoles() const { return hasPoles_; }
  bool gearVisible = true, bodyVisible = true;
  /// the pose for drawing (model space floats: Pose::global / joints); body matrix = translate(rootPos) * rotY(heading)
  void writePose(Pose& out) const;
  /// one-shot effects (skierFX: 'land' | 'pole' | 'impact' | 'crash' | 'slide')
  struct Fx { int type; three::V3 p; double amount; };
  std::vector<Fx> fx;
  enum FxType { FxLand, FxPole, FxImpact, FxCrash, FxSlide };

private:
  using V3 = three::V3; using Q = three::Q; using M4 = three::M4;
  // scene graph
  M4 W(int i) const;
  V3 wpos(int i) const { return V3(W(i)[3]); }
  Q wquat(int i) const { return three::decomposeQ(W(i)); }
  void touch(int i) const;
  void setLocalR(int i, const Q& q) { r_[size_t(i)] = q; touch(i); }
  void setLocalT(int i, const V3& p) { t_[size_t(i)] = p; touch(i); }
  void setWorldQuat(int bone, const Q& q);
  void rotateWorld(int bone, const V3& axis, double angle);
  V3 worldToLocal(int node, const V3& p) const { return V3(glm::inverse(W(node)) * glm::dvec4(p, 1)); }
  void setWorldPos(int bone, const V3& p) { setLocalT(bone, worldToLocal(M_->body->nodes[size_t(bone)].parent, p)); }
  void setRoot(const V3& p, double heading);
  void aimBone(int bone, const V3& from, const V3& to, const V3& pivot);
  void solveTwoBone(int a, int b, int c, const V3& target, const V3& pole);
  double ground(double x, double z, double y) const { return ground_(x, z, y); }

  void resetPose();
  void poseFootClips(double dt, const RigState& st);
  void poseFootClassic(double dt, const RigState& st, const V3& fwd, const V3& right);
  void poseSit(double dt, const RigState& st, const V3& fwd, const V3& right);
  void poseSled(double dt, const RigState& st, const V3& fwd, const V3& right);
  void poseBench(double dt, const RigState& st, const V3& fwd, const V3& right);
  void poseSki(double dt, const RigState& st, const V3& fwd, const V3& right);
  void poseFall(double dt, const RigState& st, const V3& fwd, const V3& right);
  void placeFallen(double dt, const RigState& st);
  void flipBody(const RigState& st);
  void rotateBody(const Q& q, const V3& C, bool gear);
  Q skiQuat(const V3& fwd, const V3& n, double edge) const;
  void placeOnBack(const V3& fwd);
  void updateGear(double dt, const RigState& st, const V3& fwd, const V3& right);
  bool poleUnder(const V3& grip, const V3& dir) const;
  void relaxShoulders(double amount = 1);
  void fixPosture(const V3& right);
  void aimHand(int i, const V3& dir, const V3& palm);
  void relaxHand(int i, const V3& palm, double curl = 0.12);
  void pushFx(int type, const V3& p, double amount) { if (fx.size() < 24) fx.push_back({type, p, amount}); }
  double rnd() { return random ? random() : rnd01(); }
  double rnd01();

  std::shared_ptr<RigModel> M_;
  std::shared_ptr<RigGear> G_;
  Ground ground_;
  bool hasSkis_ = false, hasPoles_ = false;
  // the skeleton (locals) and its lazily updated world matrices
  std::vector<V3> t_, s_;
  std::vector<Q> r_;
  mutable std::vector<M4> W_;
  mutable std::vector<uint8_t> dirty_;
  M4 rootM_{1};
  // skier.js state
  enum class Mode : uint8_t { Foot, Move, Sit, Ski, Fall } mode_ = Mode::Foot, prevMode_ = Mode::Foot;
  double blend_ = 1;
  struct Snap { Q q; V3 p; };
  std::vector<Snap> snapshot_;
  struct Plant { double t = 1; V3 tip{0}; bool rel = false; } plant_[2];
  bool headHidden_ = false, carry_ = false, fp_ = false, fpGearHidden_ = false, benchGearHidden_ = false, snapNext_ = false;
  double time_ = 0;
  int frame_ = 0;
  Q skiQ_[2];
  V3 skiPos_[2];
  bool skiPosOk_ = false;
  struct { Q q; V3 p; bool valid = false; } hipsBase_;
  double fallLift_ = 0, fallLiftV_ = 0, airW_ = 0;
  struct { double phase = 0, move = 0, run = 0, t = 0; } gait_;
  struct { double w = 0, side = 1, t = 5; } idle_;
  struct ArmS { double F = 0.26, U = -0.36, O = 0.2, vF = 0, vU = 0, vO = 0; } armS_[2];
  struct Sk {
    double inc = 0, incV = 0, trans = 0, cr = 0.2, tk = 0, plow = 0, skid = 0, twist = 0, y = 0, vy = 0, o = 0, ov = 0;
    double chg = 0, popT = 9, popS = 0, airT = 0, prep = 0, t = 0, spd = 0;
    bool wasAir = false, init = false, armInit = false;
    int frame = -10;
  } sk_;
  V3 torsoF_{0, 0, 1}, torsoR_{-1, 0, 0};
  V3 poleDir_[2] = {V3(0, -1, 0), V3(0, -1, 0)};
  bool poleDirOk_ = false;
  // the mixer (three's AnimationMixer, as skier.js drives it)
  struct Binding { int node; int path; double buf[5][4]; double cum = 0; };   // buf: incoming, accu0, accu1, orig, work
  struct Action { int clip; double time = 0, timeScale = 1, weight = 0; std::vector<int> bind; };
  std::vector<Binding> bindings_;
  std::vector<Action> actions_;
  double clipW_[3] = {0, 1, 0};
  int accuIndex_ = 0;
  bool mixerOk_ = false;
  void setupMixer();
  void mixerUpdate(double dt);
  unsigned rngState_ = 0x9e3779b9u;
  friend struct RigModel;
};

/// The player's body (game.cpp's): a SkierRig of your character, fed from Player exactly as player.js does, plus the
/// outfits (outfits.js baked looks) and the skis / poles models.
class PlayerSkier {
public:
  bool load(AssetManager& assets, const std::string& colour = "red", const std::string& skiModel = "ski_rental");
  void update(double dt, Player& p, World& world);
  void submit(Renderer& r, bool hideBody) const;
  bool loaded() const { return rig.ready(); }
  bool skisInRide = true;   // riding: skis on the feet (a chairlift) or in the cabin's outside rack (a gondola: hidden)
  /// (outfits.js) the shop's garments: jacket base / accent, trousers base / accent, helmet, lens (sRGB 0..1, a = 0:
  /// the original piece). Baked once into the albedo (UV space, like the JS bake), the texture's shading kept.
  void applyOutfit(gfx::Device& dev, const vec4& jacket, const vec4& trousers, const vec4& helmet);
  /// outfits.js applyOutfit(rig, charId, getEquipped(...)): the equipped item ids per slot ("" = the original)
  void applyOutfitIds(gfx::Device& dev, const std::string& jacket, const std::string& trousers, const std::string& helmet, const std::string& lens);
  /// (showcase.js) the skier select's skier: the athletic ski stance on its skis, looking about, no poles
  bool showcase = false;
  int generation() const { return gen_; }
  bool dressed() const { return bool(dressed_); }
  bool polesVisible() const { return rig.hasPoles() && rig.poles[0].visible && rig.gearVisible; }
  SkierRig rig;
  RigState state;
  /// (snowmobile.js) the seat's shape while astride one; set by the game
  bool sled = false;
  RigState::Sled sledShape{three::V3(0.4, 0.67, 0.49), three::V3(0.33, -0.21, 0.27), 0.46, 0.2, 0};   // (snowmobile.js RIDER)
private:
  std::shared_ptr<RigModel> model_;
  std::shared_ptr<RigGear> gear_;
  std::shared_ptr<Model> dressed_;
  std::vector<gfx::Texture> outfitTex_;
  std::string lookKey_;
  gfx::Device* dev_ = nullptr;
  double showT_ = 0;
  Pose pose_;
  int gen_ = 0;
  double grabVis_ = 0, spinVis_ = 0;
  int lastTeleport_ = -1;
};

/// Rig models / gear shared by every rig of a character (loaded once: keepCpu for the measurements).
/// charId: skier_red ... (file / anims default to <charId>_rigged / <charId>_anims; anims "" = no clips: fan_*)
std::shared_ptr<RigModel> rigModel(AssetManager& assets, const std::string& charId, const SkierRig::Ground& ground,
                                   const std::string& file = std::string(), const std::string& anims = std::string("-"));
std::shared_ptr<RigGear> rigGear(AssetManager& assets, const std::string& skiModel, bool poles);

/// `ski_legacy --verify-poses [ref.json]`: replays the JS reference timelines and compares bone by bone.
int verifyPoses(AssetManager& assets, const std::string& refPath);
/// `ski_legacy --rig-shots out.png`: the characters posed on their own (out_<what>.png), for checking by eye.
int rigShots(platform::Platform& plat, gfx::Device& dev, Renderer& renderer, AssetManager& assets, const std::string& png);

} // namespace sl
