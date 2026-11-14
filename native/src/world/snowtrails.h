// Snow trails (native): what moves over the snow leaves its mark in the renderer's trail map (a camera-following
// toroidal height map the terrain shader reads for its normals, parallax, compressed snow and groove shadows):
//  - your skis: two parallel grooves that follow every carve (deeper on the edge, a wide scraped fan when you skid
//    or plough, a crater where you land, a sitzmark where you fall), boots: alternating prints with tread and a lip
//  - the snowmobiles' cleated track and skis, cars' tyres, the resort's skiers and walkers
//  - spray: snow thrown up off the edges in a carve, a hockey stop's fan, the snowmobile's rooster tail, powder on
//    a landing; soft lit particles, the thrown snow settles as small mounds
// Everything fades over minutes (sooner in a snowfall): the renderer does that on the GPU.
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include <unordered_map>
#include <vector>

namespace sl {
class Player;
class World;

class SnowTrails {
public:
  void init(float sprayScale) { spray_ = sprayScale; }
  /// per frame, before Renderer::endFrame: you (skis, boots, falls)
  void player(const Player& p);
  /// a vehicle on the snow this frame: kind 0 car / truck (four tyres), 1 snowmobile
  void vehicle(int id, const dvec3& pos, double yaw, int kind);
  /// another person (townsfolk, the resort's skiers): their motion decides skis or boots
  void npc(int id, const dvec3& pos, bool skis);
  /// stamps and spray into the renderer (focus: where the trail map is centred, usually you)
  void update(double dt, Renderer& r, const dvec3& focus, const World* world);

private:
  struct Track {   // one ski / foot / tyre line
    dvec2 last{1e18};
    double along = 0;
    bool on = false;
  };
  struct Mover {
    dvec3 pos{0}, prev{0};
    double yaw = 0, stepAcc = 0, seen = 0;
    int foot = 0;
    Track t[4];
    bool init = false, fresh = false, npcSkis = false;
  };
  void stepNpc(Mover& m, double dt);
  struct Spark { dvec3 p, v; float life, age, size, rot, alpha; };
  void groove(Track& t, const dvec2& p, float halfWidth, float strength, float widen, uint8_t kind, float segLen = 0.22f);
  void footprint(const dvec2& p, double yaw, float strength, float scale = 1);
  void emitSpray(const dvec3& at, const dvec3& vel, int n, float size, float speed, float up);

  std::vector<TrailStamp> pending_;
  std::unordered_map<int, Mover> movers_;
  Mover you_;
  std::vector<Spark> sparks_;
  float spray_ = 1;
  double time_ = 0;
  bool wasAir_ = false;
  double fallT_ = -1;
  uint32_t seed_ = 12345;
  float rnd() { seed_ = seed_ * 1664525u + 1013904223u; return float(seed_ >> 8) / float(1u << 24); }
  // this frame's inputs (decoupled from the engine headers)
  struct PlayerIn { dvec3 pos, vel; double heading; int mode; bool air, skis; double edge, plow, sideslip, lean, speed; } pin_{};
  bool havePlayer_ = false;
};

} // namespace sl
