// The walk-in ski shop as the web game plays it (src/game/interior.js ShopInterior + main.js enterShop / exitShop /
// shopAction): the room itself is the exported scene (Interiors::Room::Shop); here what happens in and around it:
//   the door outdoors  E within 3.2 m of the point in front of it (village.js shopDoor): in behind a fade; the plaza is
//                      photographed for the windows on the way (WindowView); out again 2.2 m in front of the door,
//                      facing away from the shop
//   the podium         your own skier stands on the OUTFITS podium, dressed as equipped, turned a little to the room
//                      (poseMannequin); the outfit shop tries its rows on it
//   the outfit view    the camera swings from your eyes to a framing of the podium (outfitCameraPose: the skier at
//                      ~68 % of the width, the catalogue on the left) and back; a drag turns the skier
//   the clerk          E: the conversation look (talkView: a portrait across the counter, cinema bars, the card on the
//                      left: the name on a brush stroke, the role, the line, THANKS), the clerk turns to you
//   the crosshair      the white dot in the middle of the view (index.html #crosshair) while you walk the room
#pragma once
#include "engine/ui.h"
#include "game/interiors.h"
#include "game/play.h"
#include "game/window_view.h"
#include <string>

namespace sl {

class ShopRoom {
public:
  ShopRoom(PlayCtx& c, Interiors& rooms, WindowView& win, Ui& ui);
  bool available() const;
  bool inside() const { return rooms_.room() == Interiors::Room::Shop; }
  /// outdoors, on foot: at the shop's door? the prompt; pressed: in. true when the press was used
  bool interact(std::string& prompt, bool pressed);
  void enter();
  /// E at the door inside
  void leave();
  void update(double dt);
  /// the views (the outfit shop / the conversation have the camera: no walking, nothing to aim at)
  void outfitView(bool on);
  void spin(double d) { view_.spin += d; }
  void talk(const std::string& name, const std::string& role, const std::string& say);
  bool viewing() const { return view_.kind != 0; }
  /// going in (the fade, the windows' photograph) or a view has the camera: you stand still
  bool busy() const { return pending_ || view_.kind != 0; }
  /// (tests) a fixed view in the room: where you stand, the way you look (interior.js yaw / pitch)
  void debugLook(double x, double z, double yaw, double pitch) { dbg_ = true; dbgPos_ = dvec3(x, 0, z); dbgYaw_ = yaw; dbgPitch_ = pitch; }
  void camera(Camera& cam);
  /// your skier on the podium while you are in the shop: where it stands, which way it faces
  bool mannequin(dvec3& pos, double& yaw) const;
  /// the conversation's bars and the crosshair (drawn with the HUD)
  void hud(Ui& ui, bool crosshair);
  /// (tests) the swing finished
  bool viewSettled() const { return view_.kind != 0 && view_.on && view_.t >= 0.65; }

private:
  void enterNow();
  void talkEnd();
  struct View {
    int kind = 0;                 // 0 none, 1 the outfit shop, 2 a conversation
    bool on = false;
    double t = 0, spin = 0;
    dvec3 fromPos{0}, backPos{0};
    glm::dquat fromQ{1, 0, 0, 0}, backQ{1, 0, 0, 0};
    double fromFov = 70, backFov = 70;
    bool fromSet = false, backSet = false;
  } view_;
  void pose(int kind, float aspect, dvec3& pos, glm::dquat& q, double& fov) const;
  PlayCtx& c_;
  Interiors& rooms_;
  WindowView& win_;
  Ui& ui_;
  bool pending_ = false;
  double mannequinYaw_ = PI / 2 + 0.3, clerkYaw_ = -PI / 2, bars_ = 0;
  dvec3 camPos_{0};               // the camera this frame (the podium skier turns to it in the outfit view)
  std::string talkName_, talkRole_, talkSay_;
  double talkAt_ = -1;
  int talkFrames_ = 0;
  bool dbg_ = false;
  dvec3 dbgPos_{0};
  double dbgYaw_ = 0, dbgPitch_ = 0;
};

} // namespace sl
