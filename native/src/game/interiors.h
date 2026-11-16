// Interiors (Phase 5): the rooms the web game renders as their own scenes (post.setView) — the prison's cell block
// (game/prison.js + prisoncell.js: the corridor, three barred cells, the guard post, the visiting desk), the medical
// centre's ward (hospitalroom.js: four beds, the lobby), your chalet's ground floor (chaletroom.js on chaletplan.js's
// walls). Here a room is built from boxes and the game's furniture GLBs at a quiet spot far from the resort, with its
// own floor (a World deck while you are inside), walls as colliders, indoor light, and the first-person view; the
// outside world is not drawn while you are in.
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/play.h"
#include "game/play_data.h"
#include "world/scenery.h"
#include <cmath>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sl {
class People;
struct RoomDef;
struct ChaletRoomDef;
struct PrisonDef;

class Interiors {
public:
  enum class Room : uint8_t { None, Prison, Hospital, Chalet, Shop, Autohaus };
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
  /// (the rooms exported from the web game: the ski shop) what the view's centre is on within 6 m (interior.js: the
  /// ray from your eyes at the displays, the door, the clerk, the outfits corner), null if nothing
  const RoomDef::Hit* aim(const dvec3& eye, const vec3& dir, double reach = 6) const;
  /// where to stand to aim at a thing (kind, id): 1.7 m in front of it in the room, facing it (autotest)
  bool aimSpot(const std::string& kind, const std::string& id, dvec3& stand, double& yaw) const;
  /// the room's own people (the shop clerk behind the counter)
  void addPeople(People& people) const;
  /// the clerk's heading when the room's logic turns him (a conversation); NaN: as the room was built
  double clerkYaw = std::nan("");
  /// index.html #crosshair: the white dot in the middle of the view while you walk a room
  static void crosshair(Ui& ui);
  /// the exported room you are in (its cars on show...), null outside one; upstairs (the showroom's mezzanine)?
  const RoomDef* def() const { return def_; }
  bool upstairs() const { return level_ == 2; }
  /// (game/showroom) the exported room's model (the floor's reflection draws it a second time)
  std::shared_ptr<Model> roomMesh() const { return def_ ? mesh_ : nullptr; }
  // ---- inside a chalet as chaletroom.js builds it (interiors_chalet.cpp)
  bool chaletExported() const { return ch_ != nullptr; }
  /// per frame: the floor you are on (the stair between them), the doors swinging, a shut door you walk into opens
  void chaletStep(double dt);
  /// the door in front of you (chaletroom.js update): 0 none, 1 the front door (the way out), 2 open it, 3 close it
  int chaletDoor(const dvec3& eye, const vec3& dir, int& which) const;
  void chaletUse(int which);
  std::string chaletRoomName() const;
  /// 0 the ground floor, 1 on the stair, 2 upstairs
  int chaletLevel() const { return chLevel_; }
  // ---- the police station as prison.js builds it (interiors_prison.cpp)
  bool prisonExported() const { return pr_ != nullptr; }
  /// who you are in it the next time it is entered: shut in cell `cell`, or a visitor in at the front door
  void setPrisonRole(bool jailed, int cell = 1);
  bool prisonJailed() const { return prJailed_; }
  void prisonStep(double dt);
  /// what is in front of you: 0 nothing, 1 the way out (a visitor), 2 your cell's door (locked)
  int prisonTarget(const dvec3& eye, const vec3& dir) const;
  /// the guard at his desk: where, which way he looks (he watches whoever comes near)
  bool prisonGuard(dvec3& pos, double& yaw) const;
  /// the lamps you bought, switched on (the house frame; power): they light the rooms with the built-in ones
  struct LampAt { dvec3 p; double power; };
  std::vector<LampAt> furnitureLamps;
  /// a room walked as the web game walks it: your eyes 1.62 m over the floor you stand on, a 70 degree view
  void camera(Camera& cam) const;
  /// (tests) a fixed view in such a room: where you stand (its frame), the way you look (the web room's yaw / pitch);
  /// level (the chalet): 0 the ground floor, 1 the stair, 2 upstairs
  void debugLook(double x, double z, double yaw, double pitch, int level = -1);
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
  void buildExported(const RoomDef& d, const std::string& id);
  void wallSeg(double ax, double az, double bx, double bz, double t, double y0, double y1, const vec4& col);
  PlayCtx& c_;
  Room room_ = Room::None;
  dvec3 origin_{-21000, 0, -21000};
  double floorY_ = 0;
  std::shared_ptr<Model> mesh_;
  std::shared_ptr<Model> meshLit_;   // (an exported room's parts that cast no shadow: the shop's walls, floor, ceiling)
  const RoomDef* def_ = nullptr;         // an exported room's data while you are in it
  const RoomDef* look_ = nullptr;        // a room walked on the C++'s own walls, drawn as the web game's exported model
  std::shared_ptr<Model> shell_;
  bool dbg_ = false;
  double dbgYaw_ = 0, dbgPitch_ = 0;
  const PrisonDef* pr_ = nullptr;
  bool prJailed_ = false;
  int prCell_ = 1;
  double prBounds_[4] = {0, 0, 0, 0}, prGuardYaw_ = 0, prT_ = 0;
  void buildPrisonExported();
  void prisonColliders(std::vector<Collider>& out) const;
  const ChaletRoomDef* ch_ = nullptr;
  struct DoorSt { double angle = 0, target = 0; std::shared_ptr<Model> model; };
  std::vector<DoorSt> chDoors_;
  int chLevel_ = 0;
  dvec3 chPrev_{0};
  double chEye_ = 0;
  void buildChaletExported();
  double chaletDeck(double lx, double lz) const;
  void chaletColliders(std::vector<Collider>& out) const;
  void chaletDraw(Renderer& r);
  Lighting chaletLighting(const Lighting& outside) const;
  float roleScale(const RoomDef::Light& l) const;   // (the web room's updateLight: daylight, lanterns, the fire)
  mutable float day_ = 1, cloud_ = 0;
  mutable int level_ = 0;                // (carrentalroom.js walk) 0 the ground floor, 1 on the stair, 2 upstairs
  std::vector<Collider> walls_;          // its own collision (room-local)
  std::function<void()> onLeave_;
  std::vector<std::pair<std::string, std::shared_ptr<Model>>> cache_;
  int prevView_ = 0;
};

} // namespace sl
