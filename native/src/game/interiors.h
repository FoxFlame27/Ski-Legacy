// Interiors (Phase 5): the rooms the web game renders as their own scenes (post.setView) — the prison's cell block
// (game/prison.js + prisoncell.js: the corridor, three barred cells, the guard post, the visiting desk), the medical
// centre's ward (hospitalroom.js: four beds, the lobby), your chalet's ground floor (chaletroom.js on chaletplan.js's
// walls). Here a room is built from boxes and the game's furniture GLBs at a quiet spot far from the resort, with its
// own floor (a World deck while you are inside), walls as colliders, indoor light, and the first-person view; the
// outside world is not drawn while you are in.
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "game/play.h"
#include "world/scenery.h"
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sl {

class Interiors {
public:
  enum class Room : uint8_t { None, Prison, Hospital, Chalet };
  explicit Interiors(PlayCtx& c);
  /// builds the room and puts you in at its spawn (first person); `onLeave` runs when you walk out (E at the door)
  void enter(Room r, std::function<void()> onLeave = {});
  void leave();                        // out (runs onLeave)
  bool inside() const { return room_ != Room::None; }
  Room room() const { return room_; }
  double deck(double x, double z) const;          // the floor under (x, z) while inside, else NaN
  void fillColliders(std::vector<Collider>& out) const;
  void draw(Renderer& r);
  Lighting lighting(const Lighting& outside) const;
  /// room-local (x right, y up from the floor, z) <-> world
  dvec3 toWorld(double lx, double ly, double lz) const { return dvec3(origin_.x + lx, floorY_ + ly, origin_.z + lz); }
  dvec3 toLocal(const dvec3& w) const { return dvec3(w.x - origin_.x, w.y - floorY_, w.z - origin_.z); }
  /// the door you leave by (room-local) and whether you stand at it
  bool atExit(const dvec3& p) const;
  // building blocks (rebuilt on enter; the chalet adds its furniture through these)
  struct Box { vec3 c, h; float yaw; vec4 col; bool solid, emissive; };
  struct Prop { std::shared_ptr<Model> model; mat4 fit{1}; dvec3 local{0}; double yaw = 0; bool solid = true; vec2 half{0.4f}; bool lamp = false; };
  std::vector<Box> boxes;
  std::vector<Prop> props;
  void rebuild();                      // the merged mesh after boxes changed
  std::shared_ptr<Model> model(const std::string& file, float size, int axis);   // a GLB, cached
  vec2 halfX{5}, halfZ{5};             // the room's bounds (local, the floor's extent)
  dvec3 exitLocal{0}, spawnLocal{0};
  double spawnYaw = 0, ceiling = 3;
  vec3 lightTint{1.0f, 0.86f, 0.68f};
  float lightLevel = 1;
private:
  void buildPrison();
  void buildHospital();
  void buildChalet();
  void wallSeg(double ax, double az, double bx, double bz, double t, double y0, double y1, const vec4& col);
  PlayCtx& c_;
  Room room_ = Room::None;
  dvec3 origin_{-21000, 0, -21000};
  double floorY_ = 0;
  std::shared_ptr<Model> mesh_;
  std::function<void()> onLeave_;
  std::vector<std::pair<std::string, std::shared_ptr<Model>>> cache_;
  int prevView_ = 0;
};

} // namespace sl
