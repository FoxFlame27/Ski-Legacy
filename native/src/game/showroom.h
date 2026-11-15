// The AUTOHAUS showroom's own life (src/game/carrentalroom.js + carrental.js), on the room export_rooms.mjs captures
// (Interiors::Room::Autohaus draws its shell and walks it):
//   the cars      on their turntables where carrentalshell.js LAYOUT puts them, each in its display paint with a plate
//                 (setPlates: a random canton plate); the only cars for sale (none stand outside)
//   configurator  carrentalroom.js configure / orbit / cfgCamera: E at a car opens ui/carrental.js (game/carconfigui)
//                 on THAT car: its paint, rims and plate follow every click, the camera swings round it per step
//                 (SHOT: paint, rims, plate, summary), drifts slowly, drag turns it; the car framed right of the panel
//   the salesman  turns to you when you come close or talk; his tip (recommend): a gold arrow bobbing over the car of
//                 the day and a ring round it (guide), gone when you press E at it or after 45 s
//   sliding doors open as you come near them and on the way in (setDoors, eased)
//   the floor     the web game's dark stone tiles lie 80 % opaque over a Reflector: here the hall and the cars are drawn
//                 a second time mirrored under the floor, and the tiles over them
//   the windows   the web game renders the real world live through the glass (carrentalroom.js renderPortal): here
//                 too (game/window_view: the camera carried to the hall in the village, the hall itself left out),
//                 and once more upside down in the polished floor, as the web game's Reflector shows it
//   outside       the three tow trucks (towtruck.js buildTowTruck) parked in their TOW bays in the yard; the cars on
//                 show seen through the glass, in their display paints
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "game/carconfigui.h"
#include "game/play.h"
#include "game/play_data.h"
#include "game/vehicles.h"
#include "game/window_view.h"
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sl {
class Interiors;
class SceneFx;
struct Collider;

class Showroom {
public:
  Showroom(PlayCtx& c, Interiors& rooms, VehicleModels& models, WindowView& win) : c_(c), rooms_(rooms), models_(models), win_(win) {}
  /// in the showroom (the exported room is the one you are in)
  bool inside() const;
  /// per frame while inside: the doors, the salesman, the marker; `talking`: a panel is open (the configurator, his
  /// talk); `configOpen`: the configurator is the panel (else a preview left over ends)
  void update(double dt, bool talking, bool configOpen);
  // ---- the configurator's live car (CarCfgView::preview / drag)
  void configure(const CarCfg& cfg, int step);
  void orbit(float dx, float dy);
  void endConfigure();
  bool configuring() const { return cfg_.on; }
  /// the configurator's camera (call after the game's own camera when configuring())
  void camera(Camera& cam, double dt);
  // ---- the salesman's tip
  struct Tip { std::string id, label; int price = 0; bool up = false; };
  /// a car of the day (never the same twice in a row), the marker on it; false with no cars
  bool recommend(uint32_t rnd, Tip& out);
  void guide(const std::string& id);   // "" : off
  const std::string& guided() const { return guideId_; }
  /// the paint a car on show stands in (carrental.js openCard: the configurator starts from it)
  std::string displayPaint(const std::string& id) const;
  // ---- drawing
  /// inside: the cars, their plates, the doors, the marker, the windows' view, the mirrored hall under the floor
  void draw(Renderer& r, SceneFx& sfx, gfx::Device& dev, const Camera& cam);
  /// outside: the tow trucks in their bays, the cars on show behind the glass (near the hall only)
  void drawOutside(Renderer& r, gfx::Device& dev, const dvec3& cam);
  // ---- going in: the windows get their view of the village (carrental.js: room.setWorld), then `enter` runs
  void requestEnter(std::function<void()> enter);
  void fillColliders(std::vector<Collider>& out, const dvec3& near) const;
  /// where you stand to go in (carrental.js door: 1.3 m in front of the sliding doors) and the way out (toward the road)
  bool doorSpot(dvec3& p, dvec2& out) const;
  int carsShown() const { return shown_; }
  double doorOpen() const { return doorT_; }

private:
  struct Cfg {
    bool on = false, dragged = false, snap = true;
    int car = -1, step = 0;
    CarCfg cfg;
    double yaw = 0.8, pitch = 0.2, dist = 5.5;
    dvec3 pos{0}, at{0};
  };
  const RoomDef* def() const;
  std::shared_ptr<Model> twoSided(const std::shared_ptr<Model>& m);
  const Model* twoSided(const Model* m);
  std::shared_ptr<Model> part(const std::string& key);
  PlayCtx& c_;
  Interiors& rooms_;
  VehicleModels& models_;
  WindowView& win_;
  Cfg cfg_;
  bool was_ = false;
  double doorT_ = 0, clerkYaw_ = 0, t_ = 0;
  std::string guideId_, lastTip_;
  double guideT_ = 0, arrowYaw_ = 0;
  int shown_ = 0;
  std::unordered_map<const Model*, std::shared_ptr<Model>> two_;
  std::unordered_map<std::string, std::shared_ptr<Model>> parts_;
  std::shared_ptr<Model> floor_, truck_;
  bool truckTried_ = false;
  VehicleDraw vd_;
};

} // namespace sl
