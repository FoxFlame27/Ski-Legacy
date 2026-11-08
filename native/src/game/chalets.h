// THE CHALET VILLAGE and BUILD MODE (Phase 5: game/chalets.js, chaletroom.js, game/build/*: catalog.js, placement.js,
// buildmode.js; core/gamepad.js's virtual mouse).
//   Outside     the 18 chalets on their terraces up the Chaletweg (chalet.glb near, chalet_lo.glb further), each by
//               its plan's frame; E at a front door: buy it ($50,000, yours for good, one each), have a look inside,
//               or (yours) go in
//   Inside      the ground floor of chaletplan.js (its walls split at the windows and doors, the stair), your
//               furniture where you put it (save.chalet.furniture, the house frame), the front door leads out
//   Build mode  the furnish button (F / the top button) opens the catalogue on the right (the six rooms' tabs,
//               every piece of catalog.js with its price): [ ] (d-pad left / right) browse, the item in hand follows
//               the centre dot (or the cursor: the left stick click turns the controller's VIRTUAL MOUSE on, the
//               left stick moves it, confirm clicks) as a blue blueprint ghost (red when it doesn't fit: placement.js
//               onFloor / boxesOverlap / boxHitsWall on a 0.25 m grid; wall items hang on the wall you point at,
//               ceiling lamps from the ceiling), R turns it 90 degrees (the wheel 15), Space / click buys and places
//               it, Q picks a placed piece up to move it, X sells it back for half, E toggles a lamp, Backspace (d-pad
//               down) empties your hand
#pragma once
#include "game/interiors.h"
#include "game/play.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {
class Renderer;
struct FurnitureDef;
struct UiNav;

class Chalets {
public:
  Chalets(PlayCtx& c, Interiors& rooms);
  void load(AssetManager& assets);
  bool interact(std::string& prompt, bool pressed);
  /// build mode's input (game.cpp: every frame while inside your chalet; the nav for the mouse / virtual mouse)
  void update(double dt, const Camera& cam, const UiNav& nav);
  void draw(Renderer& r, const dvec3& cam);
  void hud(Ui& ui, float u);
  bool owned() const;
  int ownedHouse() const;
  bool inside() const { return rooms_.room() == Interiors::Room::Chalet; }
  bool building() const { return build_; }
  bool vmouse() const { return vmouse_; }
  bool buy(int house);
  void goInside(int house);
  void toggleBuild();
  /// place catalogue item `id` at room-local (x, z), turned rot (rad): bought, saved -> true (autotest / placement)
  bool place(const std::string& id, double lx, double lz, double rot);
  int furnitureCount() const;
  int houseNear(const dvec3& p, double r) const;
  std::string objective() const;
  /// (Phase 6) the plot id of the chalet you are in (-1 outside): the presence's interior 'chalet:<id>'
  int insidePlot() const;
  bool visiting() const { return visiting_ && inside(); }
private:
  struct Fit { std::shared_ptr<Model> model; mat4 local{1}; vec3 dims{1}; };
  const Fit* fitFor(const FurnitureDef& d);
  void rebuildFurniture();
  bool valid(const FurnitureDef& d, double x, double z, double rot, int skip, double& y) const;
  void sell(int i);
  PlayCtx& c_;
  Interiors& rooms_;
  std::shared_ptr<Model> hi_, lo_;
  mat4 houseLocal_{1};
  std::vector<std::pair<std::string, Fit>> fits_;
  int insideHouse_ = -1;
  bool build_ = false, vmouse_ = false;
  bool visiting_ = false;                       // (Phase 6) in another player's chalet
  nlohmann::json guestFurniture_ = nlohmann::json::array();
  int cat_ = 0, item_ = 0;
  std::string hand_;           // the item in hand ("" none)
  double rot_ = 0;
  bool ghostOk_ = false, ghostOn_ = false;
  dvec3 ghost_{0};
  int hover_ = -1, moving_ = -1;
  vec2 cursor_{-1};
  std::string tip_;
};

} // namespace sl
