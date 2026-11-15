// What a car knocks down, drawn (world/breakables.js): drive.cpp already takes the collider out of the way (a pole, a
// sign, a street lamp over 100 km/h: Collider::downUntil) or the guardrail line (Guardrail::offUntil, 90 s). Here the
// knocked prop is hidden where it stood (Resort::knockProp), a copy of it (or of the broken guardrail section: the bent
// beam, RailSweep::sectionModel) flies off the bumper (the car's velocity, a kick up, a tumble), bounces on the snow
// two or three times, turns flat and lies there; the clack (audio impact 'metal', the lamp's glass); after the 90 s,
// once you are 25 m away or not looking that way (or 2 minutes later anyway), it stands where it was again: the copy
// gone, the prop and its collider back (breakables.js update / restore).
// A sign or a pole is drawn as instances of its own (export_resort.mjs brkInst: its post, its panel, its tip, each an
// instance of its kind's set; Resort::breakParts): every part hidden, the copy built of them all. The traffic's cars
// knock them too (sweepCars, breakables.js update: theirs stay local); multiplayer: your knocks go out ('brk'
// { k: 'pole' | 'rail', id: the spot (10 cm), v: the flight }), another player's come in (remote) and are flown the same.
#pragma once
#include "core/math.h"
#include "world/resort.h"
#include <deque>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sl {
class Renderer;
class World;
class Scenery;
class Transport;
class RailSweep;
class Audio;
class Traffic;
struct Camera;

class BreakFx {
public:
  BreakFx(World& w, Scenery& s, Transport& t, Resort& r, RailSweep& rs) : world_(w), scenery_(s), t_(t), resort_(r), rails_(rs) {}
  /// a collider knocked (index into Scenery::colliders) / a guardrail section broken through, with the car's velocity
  void knockCollider(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam);
  void breakRail(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam);
  void update(double dt, double now, const Camera& cam);
  /// (breakables.js update) the traffic's cars knock the poles they run into (both ends of each car, 1 m reach)
  struct Mover { double x, z, yaw, v; };
  void sweepCars(const std::vector<Mover>& cars, double now, Audio* audio, const dvec3& cam);
  void sweepTraffic(const Traffic& traffic, double now, Audio* audio, const dvec3& cam);
  /// (multiplayer) your knocks to send ('brk' { k, id, v }), at most 10 a second; set `net` to collect them
  struct NetKnock { std::string k, id; dvec3 v; };
  bool net = false;
  std::vector<NetKnock> outbox;
  /// another player's knock (age: s since): the same pole / section down here, the same flight. -> true if knocked
  bool remote(const std::string& k, const std::string& id, const dvec3& v, double age, double now);
  void submit(Renderer& r) const;
  int flying() const;
  int down() const { return int(pieces_.size()); }

private:
  struct Part { std::shared_ptr<Model> model; glm::dmat4 M0{1}; };   // (each drawn part and its world matrix where it stood)
  struct Piece {
    std::vector<Part> parts;
    std::vector<int64_t> props;   // Resort handles (the parts hidden)
    dvec3 P0{0};          // its middle then (the pivot)
    dvec3 p{0}, v{0}, w{0};
    glm::dquat q{1, 0, 0, 0}, qT{1, 0, 0, 0};
    double h = 1.5, t = 0, standAt = 0;
    int rest = 0, bounces = 0;
    int col = -1, rail = -1;
  };
  void launch(Piece& e, double vx, double vz, bool lamp, const dvec3* fv = nullptr);
  void fly(Piece& e, double dt);
  void emit(const Piece& e, double now);
  std::string poleId(int col) const;
  std::string railId(int rail) const;
  bool knock(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam, const dvec3* fv);
  bool rail(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam, const dvec3* fv);
  std::unordered_map<std::string, int> poleIds_, railIds_;
  double netTok_ = 10, netT_ = 0;
  bool quiet_ = false;
  std::vector<Mover> movers_;
  void restore(Piece& e);
  World& world_;
  Scenery& scenery_;
  Transport& t_;
  Resort& resort_;
  RailSweep& rails_;
  std::deque<Piece> pieces_;
  uint32_t seed_ = 0x9e3779b9u;
  double rnd();
};

} // namespace sl
