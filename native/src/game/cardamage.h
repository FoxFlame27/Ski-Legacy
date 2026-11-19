// Crash damage you can see: a port of src/game/cardamage.js (the dents) and carlights.js Smoke (the steam / smoke from
// the bonnet). Every knock leaves a dent where it hit (the body pushed in round the impact, a crumple of a few cm to
// ~20 cm, wider and deeper the harder the hit; the panel's shading follows the dent), the lamps at that corner smashed
// (dark, they never light again), and from 40 % on steam from the bonnet (drive.js). Kept on the car (in its own
// frame): every look of it (the parked one, the driven one, the full-detail cockpit one) carries the same dents, until
// it is towed and repaired. The dents work on any model: the body's own vertices are moved (a dented copy of the
// body per car, VehicleModels::dented), not per-model data.
#pragma once
#include "core/math.h"
#include <nlohmann/json.hpp>
#include <vector>

namespace sl {

struct Particle;
class Renderer;

/// a dent (car frame: x right, y up, z nose): the point on the outline it hit, the way in (ux, uz: the impact's
/// direction from the car's middle), its radius and depth (m), the seed of its crumple
struct Dent { float x = 0, y = 0, z = 0, ux = 0, uz = 1, r = 0.5f, depth = 0.05f, seed = 0; };
constexpr size_t DENTS_MAX = 12;

/// cardamage.js addDent: a dent on a car of size `size` (x width, y height, z length) where the impact came from
/// (dirX, dirZ: car frame, from its middle), how hard (0..1); seed 0..100 (Math.random() * 100). The last 12 kept.
Dent& addDent(std::vector<Dent>& list, double dirX, double dirZ, double hard, const vec3& size, double seed);
/// cardamage.js packDents / unpackDents: [[x, y, z, r, depth, seed], ...] (cm-rounded; the save, the server)
nlohmann::json packDents(const std::vector<Dent>& list);
std::vector<Dent> unpackDents(const nlohmann::json& j);
/// a signature of a dent list (its length and seeds): a dented copy is rebuilt when it changes
uint64_t dentSig(const std::vector<Dent>& list);
/// cardamage.js dentInstance on one vertex (car frame): the position pushed in, the normal tipped toward the dent's
/// middle (the panel's shading follows it); every dent in turn
void dentVertex(const Dent& D, vec3& p, vec3& n);
/// cardamage.js dentInstance's lamps: a lamp lens (its bounding sphere, car frame) smashed by dent D (the hit at its
/// end of the car and hard, near enough)
bool lampSmashed(const Dent& D, const vec3& center, float radius);
bool lampSmashed(const std::vector<Dent>* list, const vec3& center, float radius);

/// carlights.js Smoke: steam (and smoke) rising from a damaged / crashed car's bonnet, simulated with buoyancy, eddies,
/// the wind and the car's motion; drawn as the renderer's lit puffs (only near the camera). rate: how hard it steams
/// (~1 a faint wisp, 6 the wrecked plume, which has dark smoke in it too).
class CarSmoke {
public:
  double rate = 6;
  /// every frame: emit (at: the bonnet, world) or not (what is in the air drifts away), the camera, the car's forward
  /// (world, unit; zero: unknown), the wind (atmosphere.js windUniform: m/s, x / z)
  void update(double dt, bool emit, const dvec3& at, const dvec3& cam, const dvec3& fwd, double windX, double windZ);
  void draw(Renderer& r) const;
  void clear();
  bool any() const { return live_ > 0; }
  int live() const { return live_; }
private:
  static constexpr int MAX = 96;
  struct P { dvec3 p{0}, v{0}; double age = 1e9, life = 1, s0 = 0, s1 = 0, rot = 0, spin = 0, dark = 0, a0 = 0, floor = 0, seed = 0; };
  void spawn(const dvec3& at, bool smoke, double inten, const dvec3& fwd, double back, double sp);
  P ps_[MAX];
  double acc_ = 0, accD_ = 0, t_ = 0;
  int next_ = 0, live_ = 0;
  dvec3 prev_{0}, carV_{0};
  bool hasPrev_ = false;
  uint32_t seed_ = 0x9e3779b9u;
  double rnd() { seed_ ^= seed_ << 13; seed_ ^= seed_ >> 17; seed_ ^= seed_ << 5; return double(seed_ & 0xffffff) / double(0x1000000); }
};

} // namespace sl
