// What a car knocks down, drawn (world/breakables.js): drive.cpp already takes the collider out of the way (a pole, a
// sign, a street lamp over 100 km/h: Collider::downUntil) or the guardrail line (Guardrail::offUntil, 90 s). Here the
// knocked prop is hidden where it stood (Resort::knockProp), a copy of it (or of the broken guardrail section: the bent
// beam, RailSweep::sectionModel) flies off the bumper (the car's velocity, a kick up, a tumble), bounces on the snow
// two or three times, turns flat and lies there; the clack (audio impact 'metal', the lamp's glass); after the 90 s,
// once you are 25 m away or not looking that way (or 2 minutes later anyway), it stands where it was again: the copy
// gone, the prop and its collider back (breakables.js update / restore).
#pragma once
#include "core/math.h"
#include "world/resort.h"
#include <deque>
#include <memory>

namespace sl {
class Renderer;
class World;
class Scenery;
class Transport;
class RailSweep;
class Audio;
struct Camera;

class BreakFx {
public:
  BreakFx(World& w, Scenery& s, Transport& t, Resort& r, RailSweep& rs) : world_(w), scenery_(s), t_(t), resort_(r), rails_(rs) {}
  /// a collider knocked (index into Scenery::colliders) / a guardrail section broken through, with the car's velocity
  void knockCollider(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam);
  void breakRail(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam);
  void update(double dt, double now, const Camera& cam);
  void submit(Renderer& r) const;
  int flying() const;
  int down() const { return int(pieces_.size()); }

private:
  struct Piece {
    std::shared_ptr<Model> model;
    glm::dmat4 M0{1};     // its world matrix where it stood
    dvec3 P0{0};          // its middle then (the pivot)
    dvec3 p{0}, v{0}, w{0};
    glm::dquat q{1, 0, 0, 0}, qT{1, 0, 0, 0};
    double h = 1.5, t = 0, standAt = 0;
    int rest = 0, bounces = 0;
    int64_t prop = -1;    // Resort::knockProp's handle (a prop hidden)
    int col = -1, rail = -1;
  };
  void launch(Piece& e, double vx, double vz, bool lamp);
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
