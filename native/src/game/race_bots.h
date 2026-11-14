// Race AI: a port of src/modes/race/bots.js (course model, racing line, skiing physics and race craft of the AI
// racers) and of src/player/aistate.js (AISkierAnim: the rig's state from how the AI skier actually moves).
//
// Every bot rides a computed racing line (corners cut within the track width), with its speed set by the real snow
// under it: gravity from the actual height change (exact energy), snow friction (ice via the course's friction), air
// drag (tucked on fast straights), a cornering limit v <= sqrt(aLat * R) (banked turns allow more), look-ahead braking
// and ballistic flight off lips with a landing absorb. Each bot has its own abilities (cornering, gliding, start
// reaction, consistency); the field of a difficulty is calibrated against a reference run of an ideal player on the
// same course, so Easy / Medium / Hard / Superhard feel the same on every course. The physics run at a fixed 120 Hz
// step; the world position follows continuously every frame (lateral speed capped by the edges' grip: a racer steers
// across the piste, it never jumps sideways), overtaking lanes, side-by-side spacing, small mistakes, a mild rubber
// band, the hockey stop into a parking lane after the line.
//
// Lateral offsets in this module are LEFT-positive (heading h: forward (sin h, cos h), left (cos h, -sin h)); the
// course's own lateral (CourseLine::point / project) is right-positive.
#pragma once
#include "core/math.h"
#include "core/noise.h"
#include "game/people.h"
#include "game/play_data.h"
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sl {
class World;
class Renderer;

namespace racebots {

constexpr double DS = 2;              // track sample spacing (m)
constexpr double SIM_H = 1.0 / 120;   // fixed physics step of the bots (s)

/// bots.js DIFFICULTY
struct Difficulty {
  const char* key; const char* label;
  double pace[14];
  double aLat, lineQ[2], tuckA, tuckV, reaction[2], push[2], brake, mistakes, severity;
  double consistency, paceMax;
};
const Difficulty& difficulty(int ai);   // 0 easy .. 3 superhard

struct Frame { double s = 0, h = 0, x = 0, z = 0, y = 0, w = 8, bank = 0, k = 0, fr = 1, nx = 1, nz = 0, f = 0; int i = 0; };
struct Path { std::vector<double> k; std::vector<float> pf; };
struct Params {
  double mu = 0.04, cdaTuck = 0.2, cdaUp = 0.42, dragMul = 1, aLat = 17.5, brake = 6, push = 2.6, pushMax = 9, reaction = 0.15, tuckA = 9, tuckV = 13, pace = 1;
  const std::vector<float>* prof = nullptr;
  const Path* path = nullptr;
  std::vector<float> vmax;
};

/// bots.js Track
class Track {
public:
  Track(const Course& c, World& w);
  const Course& course;
  World& world;
  int n = 0;
  double s0 = 0, lineEnd = 0, finishS = 0, gradeEnd = 0, gradeStart = 0;
  std::vector<double> X, Z, Y, W, B, H, K, NX, NZ, F, lo, hi, C, raceLat, centerLat, sideLat;
  std::vector<float> profCenter, profSide, profRace;
  struct Gate { double s, latA, latB, dir, span, lo, hi; };
  std::vector<Gate> gates;
  struct Jump { double s, air, cap; bool hasCap; };
  std::vector<Jump> jumps;

  Frame& frame(double s, Frame& out) const;
  double sample(const std::vector<double>& a, double s) const;
  double sample(const std::vector<float>& a, double s) const;
  double prof(const std::vector<float>& p, double s) const;
  double halfWidth(double s) const { return sample(W, s); }
  void window(double s, double ahead, double& lo, double& hi) const;
  double ground(double x, double z, double yHint, double lineY) const;
  std::vector<double> planFor(double q, double bias) const;
  Path pathOf(const std::vector<double>& plan) const;
  std::vector<float> profileFor(const std::vector<double>& plan) const;
private:
  void buildBounds();
  std::vector<double> computeRacingLine() const;
  std::vector<float> buildProfile(const std::vector<double>& plan) const;
  void findJumps();
};

struct SimState { double s = 0, v = 0, y = 0, vy = 0, vh = 0, tanA = 0; bool air = false; };
std::vector<float> speedProfile(const Track& tr, const Path& path, const Params& P);
/// headless run of a skier along its plan (no traffic, no mistakes) -> finish time (s from GO)
double simulateRun(const Track& tr, const Params& P, const std::function<void(const SimState&, double t, bool tuck)>& trace = nullptr);
/// clean run time of an ideal player (tucked where possible, racing line) on skis { speed, grip }
double referenceTime(const Track& tr, double skiSpeed, double skiGrip);

/// one racer of the field (bots.js createField's spec)
struct Spec {
  int index = 0;
  std::string name;
  struct { double cornering, gliding, start, consistency; } ab{};
  double lineQ = 0.7, bias = 0, targetPace = 1, mistakeRate = 0, severity = 1, cleanTime = 0, targetTime = 0;
  uint32_t seed = 1;
  std::vector<double> plan;
  Path path;
  std::vector<float> prof;
  Params P;
  std::vector<double> cleanTab;   // (s, t) pairs every ~4 m of the clean run
};
struct Field { std::vector<std::unique_ptr<Spec>> specs; double refTime = 0; };
Field createField(const Track& tr, int ai, int count, uint32_t seed, double playerSkiSpeed, double playerSkiGrip);

/// aistate.js makeStyle(seed, 'racer')
struct Style {
  double agg = 0.6, crouch = 0, lean = 1, edgeRate = 9, stance = 0, armF = 0, armU = 0, armO = 0, plantThr = 3, plantDelay = 0.04;
  double plantReach = 1, plantDur = 1, plantProb = 0.8, pushEvery = 0.6, tuckV = 13, sway = 1, look = 0.15, plow = 0;
  uint32_t seed = 1;
};
Style makeRacerStyle(uint32_t seed);

/// what a racer does this pose solve (aistate.js update's m)
struct Motion {
  double heading = 0, speed = 0, aLat = 0, edgeAdd = 0, skidYaw = 0, brake = 0, pre = 0, land = 0, camDist = 0;
  three::V3 normal{0, 1, 0};
  bool air = false, tuck = false, push = false, stopped = false;
  int waiting = 0;
};

/// aistate.js AISkierAnim (the racer's branch: the caller gives aLat, the skid yaw, the tuck and the landings)
class AiAnim {
public:
  void init(SkierRig* rig, const Style& st);
  void reset();
  const RigState& update(double dt, const Motion& m);
  double sideslip = 0;
private:
  SkierRig* rig_ = nullptr;
  Style S_;
  Mulberry32 rnd_{1};
  RigState st_;
  double edge_ = 0, lean_ = 0, crouch_ = 0.2, plow_ = 0, skid_ = 0, absorb_ = 0, absorbV_ = 0, prevH_ = 0, rate_ = 0;
  double pushT_ = 0.1, pushAge_ = 9, tuckPoleT_ = 1, popT_ = 9, t_ = 0, look_ = 0, pendingT_ = 0;
  int side_ = 0, pendingSide_ = 0;
  bool hasPrevH_ = false, wasAir_ = false, pending_ = false;
};

/// the traffic snapshot the racers decide on (bots and the player)
struct Racer { const void* self = nullptr; double s = 0, lat = 0, v = 0; };

/// bots.js BotRacer
class BotRacer {
public:
  BotRacer(const Spec& spec, const Track& tr);
  const Spec& spec;
  const Track& track;
  std::string name;
  // ---- the rig (people.h): one per racer, its own skeleton and smoothing state
  RigInst R;
  int kind = -1;
  bool rigOk = false;

  void reset(double s, double lat, int attempt = 0);
  void go() { running = true; t = 0; }
  void nudge(double dx, double dz);
  void bump(double dlat, double dv = 0);
  /// per frame: race craft, then the fixed-step physics (animate() afterwards)
  void update(double dt, const std::vector<Racer>& racers);
  void setParking(int rank, const std::vector<double>& avoid, bool hasCross, double cross);
  /// show: drawn at all; step: seconds between pose solves (the session's level of detail)
  void animate(double dt, double viewDist, bool countdown, bool show, double step);
  double projectFinish() const;

  // ---- state (bots.js names)
  double s = 0, lat = 0, latVel = 0, v = 0, vh = 0, vy = 0, tanA = 0, y = 0, t = 0;
  bool started = false, running = false, air = false, finished = false, stopped = false;
  double airT = 0, finishTime = -1, laneOff = 0, passLat = 0, passT = 0, repel = 0, followCap = 1e18, draft = 0;
  bool hasPass = false;
  const void* passTarget = nullptr;
  struct Mistake { int type = 0; double t = 0, dur = 0, mag = 0, side = 1; bool on = false; } mistake;   // type 0 skid, 1 upright, 2 wide
  double mistakeOff = 0, rb = 1, rbTarget = 1;
  int mistakes = 0;
  bool tuck = false, pushing = false, braking = false;
  double tuckHold = 0, lean = 0, edge = 0, crouchImp = 0, wobble = 0, wob = 0, skidYaw = 0, skid = 0, sRate = 0, prevTravel = 0, aLat = 0;
  bool hasPrevTravel = false;
  double acc = 0, animAcc = 0, normalT = 0, parkLat = 0, landImpact = 0, landPending = 0;
  bool wasAirF = false, visible = true;
  double heading = 0, travel = 0;
  dvec3 pos{0}, vel{0};
  three::V3 normal{0, 1, 0};
  // ---- the session's bookkeeping
  int cpNext = 1, parkRank = 0;
  bool parked = false;
  std::vector<double> splits;
  double viewDist = 0;
private:
  void decide(double dt, const std::vector<Racer>& racers);
  void decideFinished(const std::vector<Racer>& racers);
  void startMistake();
  void step(double h);
  void onLand(double impact);
  Mulberry32 rnd_;
  Frame fr_, fr2_;
  AiAnim anim_;
  Style style_;
};

} // namespace racebots
} // namespace sl
