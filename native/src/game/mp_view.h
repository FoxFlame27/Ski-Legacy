// Phase 6: the other players as they are drawn (remote.js / vehicles.js, condensed) and the multiplayer overlays (ui.js):
//  - each remote player as the game's character for their look (People: skiing with skis on, the tuck, walking /
//    running by their speed, seated on a lift / bus / train / in a car, lying after a wipeout), only while you are in
//    the same interior as they are (outdoors: none); their car (the model and plate from their 'veh' record) driven
//    (their presence row is the car's pose) or parked, their other cars parked in the world, their snowmobile; the
//    players riding in YOUR car sit in its seats
//  - a name card over each head within 150 m (PAUSED / WANTED stars), the status pill (name · world · players), the
//    owner's prompt ("Allow Bob to get in your car?" Y / N), the admin's banner, chat and server notes
#pragma once
#include "core/math.h"
#include "player/car_seat.h"
#include "game/people.h"
#include <functional>
#include <string>
#include <unordered_map>

namespace sl {
class Multiplayer;
class Renderer;
class VehicleDraw;
class VehicleModels;
class Ui;
class AssetManager;
struct Model;
struct Camera;

/// (vehicles.js seatFor) a player's car as it is drawn here (driven: their presence row; else parked where they left it):
/// its frame, its seats and its roll (rolled over > 0.6: they are hidden inside it); false if none
bool mpCarFrame(const Multiplayer& mp, const VehicleModels& vm, const std::string& owner, glm::dmat4& car, CarTemplate& t, double& roll);

class MpView {
public:
  /// your car's seat `seat` (1 front passenger, 2.. back) in the world, for the players riding with you
  std::function<bool(int seat, dvec3& pos, double& yaw)> myCarSeat;
  /// (vehicles.js localCar) your car's frame and seats, for the players riding with you (false: not driving)
  std::function<bool(glm::dmat4& car, CarTemplate& t)> myCar;
  /// the car models (their sizes: the seats, the roof)
  const VehicleModels* models = nullptr;
  /// (remote.js ensureRig: makeRig(look.c, look.s) + applyOutfit(look.o)) set both and each player's rig wears their own
  /// outfit (the baked look of player/outfits) and rides / carries their own ski model; unset: the character as it is
  /// with rental skis
  AssetManager* assets = nullptr;
  /// (hospitalroom.js patientSpot) the hospital bed a patient at world x lies in: another player lying in the ward
  /// (state fall inside the hospital) is posed on it exactly as you lie in yours (posePatient)
  std::function<dvec3(double worldX)> patientSpot;
  /// (net/transit.js seat) seat n of the shared vehicle v (kind k: gondola / chair / train / express / bus) as it is drawn
  /// here: the players riding it sit in it without lag; false: unknown (they are drawn where their own rows put them)
  std::function<bool(const std::string& k, const std::string& v, int n, dvec3& pos, double& yaw)> transitSeat;
  gfx::Device* dev = nullptr;
  ~MpView();
  void addPeople(const Multiplayer& mp, People& people, const dvec3& cam, const std::string& interior, double dt);
  void addDraw(const Multiplayer& mp, VehicleDraw& vd, const VehicleModels& vm, const Model* sled, const glm::mat4& sledFit,
               const dvec3& cam, const std::string& interior) const;
  /// the name cards, the pill, the prompt, the banner, chat (W x H pixels, u = the HUD scale)
  void hud(Ui& ui, const Multiplayer& mp, const Camera& cam, int W, int H, float u, bool nameTags, const std::string& interior,
           const std::string& allowKey, const std::string& denyKey) const;
  /// the chat line being typed (Enter opens it in the game; "" closed)
  bool chatOpen = false;
  std::string chatText;

  // ---- remote.js poseOne: each player on foot / on skis / seated / tumbling is the game's own skier rig (SkierRig, the
  // racers' kit: skis and poles), posed from their presence; set `ground` (world.groundHeight) to turn it on
  std::function<double(double, double, double)> ground;
  /// (net/vehicles.js updateRescue) another player's rescue as it is drawn here: the helicopter (eased toward its rows,
  /// led along its velocity), its winch rope, the ambulance; the game draws it with its own helicopter / ambulance
  struct RescueDraw { bool heli = false; dvec3 hp{0}; double yaw = 0, pitch = 0, roll = 0, rpm = 0, rope = 0, time = 0; bool amb = false; double ax = 0, az = 0, ayaw = 0; bool lights = false; };
  std::function<void(Renderer&, const RescueDraw&)> drawRescue;
  /// (net/vehicles.js updateTow / updatePolice) another player's tow truck out on a job ('veh' tow { at, v }) and the
  /// patrol cars chasing them ('veh' police { cars: [x, y, z, yaw, v] }): each eased toward its last pose run on at its
  /// speed; drawn with the game's own models (pos on the ground)
  std::function<void(Renderer&, const dvec3& pos, double yaw)> drawTow;
  std::function<void(VehicleDraw&, const dvec3& pos, double yaw, double dist)> drawPolice;
  int towsDrawn = 0;
  mutable int policeDrawn = 0;
  /// a point of that helicopter in the world: its door arm (seat false) or its cabin seat (vehicles.js rescueSeat)
  std::function<dvec3(const RescueDraw&, bool seat)> rescuePoint;
  /// after addPeople: the rigs and the rescues into the frame
  void drawWorld(Renderer& r, People& people);
  /// (mptest) how many players are drawn as rigs this frame, how many rescues (helicopter / ambulance) are shown
  int rigsDrawn = 0, rescuesDrawn = 0;
  /// (mptest) where addPeople left each player this frame: "pid:hidden / nokind / ambulance / figure / rig"
  std::string trace;
  /// (mptest) the rig state a player was last posed with ("" none): "ski crouch 0.20 lean -0.31 skis carry ..."
  std::string describe(int pid) const;
private:
  struct Anim { double phase = 0; };
  mutable std::vector<std::pair<int, double>> phases_;
  struct Av { std::string skiId, outfitKey; std::shared_ptr<Model> dressed; std::vector<gfx::Texture> tex; std::shared_ptr<RigGear> gear;
              RigInst R; int kind = -1, skis = -1, carry = -1; bool built = false, snap = true, mHas = false; double animAcc = 0, mx = 0, mz = 0, mspd = 0, dist = 0; uint64_t frame = 0; RigState st; };
  std::unordered_map<int, Av> avs_;
  uint64_t frame_ = 1;
  struct Resc { int seq = -1; double age = 0, t = 0, rpm = 0, ambT = 0, clock = 0;
                struct { double x = 0, y = 0, z = 0, yaw = 0, pitch = 0, roll = 0, tx = 0, ty = 0, tz = 0, tyaw = 0, tp = 0, tr = 0, vx = 0, vy = 0, vz = 0, at = 0; bool posed = false; } h;
                struct { double x = 0, z = 0, yaw = 0, tx = 0, tz = 0, tyaw = 0, tv = 0; bool posed = false; } a;
                RescueDraw out; bool show = false; };
  std::unordered_map<int, Resc> rescues_;
  // (remote.js attach: the name card is a child of the rig's root, 2.15 m up) where each player's rig stands as drawn
  // this frame: on foot, on the winch hook, in the cabin's seat, in a hospital bed; none in a car
  struct Tag { int pid = 0; dvec3 at{0}; double d = 0; bool paused = false; };
  std::vector<Tag> tags_;
  std::vector<RescueDraw> helis_;
  struct Eased { double x = 0, y = 0, z = 0, yaw = 0, tx = 0, ty = 0, tz = 0, tyaw = 0, tv = 0, age = 0; bool posed = false, show = false; };
  struct Tow { std::string ref; Eased w; };
  struct Cops { std::string ref; std::vector<Eased> cars; };
  std::unordered_map<int, Tow> tows_;
  std::unordered_map<int, Cops> police_;
  void updateChasers(const Multiplayer& mp, const dvec3& cam, bool outdoors, double dt);   // (the helicopters they fly / left parked, this frame)
  double flyT_ = 0;
  void freeAv(Av& a);
  void dress(Av& a, const struct RemotePlayer& r, People& people, int kind);
  void poseRig(const struct RemotePlayer& r, People& people, int kind, const dvec3& cam, double dt, const dvec3* seatAt = nullptr, double seatYaw = 0);
  bool updateRescue(const struct RemotePlayer& r, double dt, const dvec3& cam, bool outdoors, int& s, dvec3& seat, double& seatYaw);
};

} // namespace sl
