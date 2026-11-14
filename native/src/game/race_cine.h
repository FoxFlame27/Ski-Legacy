// The race's broadcast presentation (src/game/presentation/replay.js, podium.js, cinecam.js; driven by
// modes/race/session.js): the replay ring buffer every racer is written into at 30 Hz (the last 60 s), the TV director
// that plays the end of the run back (trackside / heli / chase cameras, the finish camera for the last seconds, slow
// motion through the finish and the big airs), and the podium in the finish run-out (the blue plinth, the three white
// blocks with their red trim and blue 1 / 2 / 3, the confetti cannons, the snow kicked up, the slow orbit).
// The classes are rig-agnostic: they hand back where every racer stands and its rig state; races.cpp poses the rigs.
#pragma once
#include "core/math.h"
#include "core/noise.h"
#include "engine/model.h"
#include "player/skier_rig.h"
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace sl {
class World;
class Renderer;
class Shapes;
namespace gfx { class Device; }
namespace platform { class Platform; }
namespace racebots { class Track; }

namespace racecine {

constexpr int REPLAY_RATE = 30;
constexpr int F_TUCK = 1, F_AIR = 2, F_FALL = 4, F_CUT = 8;

/// cinecam.js applyCamera: where the game camera stands, what it looks at, its vertical FOV (degrees)
struct CineCam { dvec3 pos{0}, look{0}; double fov = 40; };

/// one racer at a replayed moment (ReplayBuffer.sample's out: a rig state + x, y, z, down = wiped out)
struct Sample {
  double x = 0, y = 0, z = 0, heading = 0, crouch = 0, lean = 0, edge = 0, skid = 0, plow = 0, speed = 0;
  double flip = 0, flipHeading = 0, grab = 0, spinVel = 0, fallT = 0;
  int fallSide = 1;
  bool tuck = false, air = false, down = false;
};

class ReplayBuffer {
public:
  explicit ReplayBuffer(int tracks, double seconds = 60, int rate = REPLAY_RATE);
  void reset();
  int tracks() const { return tracks_; }
  int count() const { return count_; }
  double first() const { return count_ ? time_[size_t(phys(0))] : 0; }
  double last() const { return count_ ? time_[size_t(phys(count_ - 1))] : 0; }
  /// the next sample of a track follows a teleport (respawn): playback snaps instead of sliding
  void cut(int track = 0) { cutNext_[size_t(track)] = 1; }
  /// open a new sample at race time T when one is due; then write() each track
  bool due(double T);
  void write(int k, const dvec3& pos, const Sample& st, bool fall = false);
  bool sample(int k, double t, Sample& out) const;
  /// [t0, t1] spans of track k with a flag set, at least `min` s long
  std::vector<std::pair<double, double>> spans(int k, int flag, double t0, double t1, double min = 0) const;
private:
  int phys(int i) const { return (head_ - count_ + i + cap_ * 2) % cap_; }
  int find(double t) const;
  int rate_, tracks_, cap_, head_ = 0, count_ = 0, slot_ = 0;
  double nextT_ = -1e300;
  std::vector<double> time_;
  std::vector<std::vector<float>> data_;
  std::vector<uint8_t> cutNext_;
};

class ReplayDirector {
public:
  struct Opt {
    const ReplayBuffer* buffer = nullptr;
    const racebots::Track* track = nullptr;
    World* world = nullptr;
    std::function<double(double x, double z, double hint)> project;   // -> s (hint < 0: anywhere)
    double finishClock = std::nan("");   // race time the player crossed the line (NaN: none)
    double length = 20;                  // s played back
  };
  explicit ReplayDirector(const Opt& o);
  /// per frame (real dt): advance, every racer's pose, the shot. False at the end.
  bool update(double dt, const dvec3& camPos);
  double duration() const { return t1_ - t0_; }
  double time() const { return t_; }
  bool slow() const { return slow_; }
  bool done() const { return done_; }
  double poseDt = 0;   // dt x the playback rate: what the rigs are posed with
  struct Out { bool ok = false, show = false; Sample st; three::V3 normal{0, 1, 0}; };
  std::vector<Out> racers;   // same order as the buffer's tracks (0 = the player)
  CineCam cam;
  bool camOk = false;
  std::string shotKind() const;
private:
  struct Shot { int kind = -1; double t0 = 0, max = 0, s = 0, side = 1, yaw = 0; int frames = 0; dvec3 pos{0}; };   // kind 0 trackside, 1 heli, 2 chase, 3 finish
  double rate(double t) const;
  void frame(double dt, const Sample& me);
  bool shotOver(const Shot& sh) const;
  Shot makeShot(const Sample& me);
  Shot makeFinish();
  Opt o_;
  double t0_ = 0, t1_ = 0, t_ = 0, fc_ = 0, ps_ = 0, side_ = 1, fov_ = 40;
  bool done_ = false, hasPs_ = false, hasShot_ = false, slow_ = false;
  std::vector<std::pair<double, double>> airs_;
  Shot shot_;
  int shotN_ = 0;
  dvec3 camPos_{0}, camLook_{0}, focus_{0};
};

class Podium {
public:
  struct Racer { int track = -1; std::string name, time; bool me = false; };   // track: 0 the player, k + 1 a bot (-1: nobody)
  Podium(gfx::Device& dev, platform::Platform* plat, World& world, const racebots::Track& track, std::vector<Racer> top);
  /// per frame (real dt): the riders' poses, the confetti, the camera. True while the skippable part runs.
  bool update(double dt);
  void skip() { if (phase_ == 0) phase_ = 1; }
  bool showing() const { return phase_ == 0; }
  double age() const { return t_; }
  void draw(Renderer& r, Shapes& shapes);
  /// the standing spot of a place (1..3), the rider's rig state there
  dvec3 spot(int place) const { return spots_[place]; }
  RigState stateOf(int place) const;
  /// the blocks and the plinth are walkable while the podium stands (world.addSurface in the JS): the height at (x, z)
  /// or NaN off them
  double surface(double x, double z) const;
  const std::vector<Racer>& top() const { return top_; }
  CineCam cam;
  bool fired = false;   // (the cannons went off this frame: the chime)
private:
  void fire(double t);
  void updateConfetti(double dt, double t);
  void updateCamera(double t);
  World& world_;
  std::vector<Racer> top_;
  double t_ = 0, heading_ = 0;
  int phase_ = 0;   // 0 show (skippable), 1 hold (behind the results)
  dvec3 base_{0}, fwd_{0}, right_{0}, spots_[4];
  std::shared_ptr<Model> model_;
  struct Conf { dvec3 p{0}, v{0}; vec3 ax{0, 1, 0}; double a = 0, w = 0, ph = 0, born = 1e300; };
  std::vector<Conf> cf_;
  struct Puff { dvec3 p, v; double life, maxLife, size; };
  std::vector<Puff> puffs_;
  Mulberry32 rnd_{20261114};
};

inline double ease(double t) { const double x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * x * (x * (x * 6 - 15) + 10); }

} // namespace racecine
} // namespace sl
