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
#include <functional>
#include <string>

namespace sl {
class Multiplayer;
class People;
class VehicleDraw;
class VehicleModels;
class Ui;
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
  void addPeople(const Multiplayer& mp, People& people, const dvec3& cam, const std::string& interior, double dt);
  void addDraw(const Multiplayer& mp, VehicleDraw& vd, const VehicleModels& vm, const Model* sled, const glm::mat4& sledFit,
               const dvec3& cam, const std::string& interior) const;
  /// the name cards, the pill, the prompt, the banner, chat (W x H pixels, u = the HUD scale)
  void hud(Ui& ui, const Multiplayer& mp, const Camera& cam, int W, int H, float u, bool nameTags, const std::string& interior,
           const std::string& allowKey, const std::string& denyKey) const;
  /// the chat line being typed (Enter opens it in the game; "" closed)
  bool chatOpen = false;
  std::string chatText;
private:
  struct Anim { double phase = 0; };
  mutable std::vector<std::pair<int, double>> phases_;
};

} // namespace sl
