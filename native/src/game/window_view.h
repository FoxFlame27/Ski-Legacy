// The view through a walk-in room's windows. The web game renders the world outside live into the glass, from the
// matching spot outdoors (game/liveportal.js: interior.js renderPortal, chaletroom.js, prison.js): your camera carried
// to where the house stands. Here the world is photographed as you go in, behind the fade's dark moment (as the
// medical centre's ward does: hospital_ward.cpp): one frame per wall with windows, taken from just outside it. The
// glass then shows its part of that photograph by the direction you look through it, from where your eyes are (the
// pane's texture coordinates follow you: walk to a window and look along the street).
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "game/play.h"
#include <functional>
#include <memory>
#include <vector>

namespace sl {

class WindowView {
public:
  /// a pane in the room's frame: its plane (x across, y up, centred), its size, which photograph it shows
  struct Pane { mat4 m{1}; float w = 1, h = 1; int shot = 0; };
  /// a photograph: taken at `eye` looking along `dir` (the world), which is the point `eyeLocal` and the direction
  /// `local` in the room's frame (level: the wall's outward normal); the horizontal half angle in degrees; nearZ: what
  /// is nearer is left out (the house's own walls round the camera); depth: how far beyond the glass the scene is
  /// taken to lie when your eyes are not where the photograph was taken (0: far away)
  struct Shot { dvec3 eye{0}, dir{0, 0, 1}; vec3 local{0, 0, 1}, eyeLocal{0}; float halfAngle = 56, nearZ = 0.3f, depth = 0, gain = 1; };

  explicit WindowView(PlayCtx& c) : c_(c) {}
  ~WindowView() { clear(); }
  /// photographs `shots` (one frame each, while the screen is covered), then calls `done` (also when it cannot)
  void begin(std::vector<Shot> shots, std::vector<Pane> panes, std::function<void()> done);
  bool pending() const { return pending_; }
  /// game loop: this frame's camera is a photograph's (true) while the screen is `covered`; waits 1.2 s for that at most
  bool captureCamera(Camera& cam, bool covered, double dt);
  bool capturing() const { return armed_; }
  void captured(Renderer& r);
  /// the glass, in the room at `origin`, seen from `eye` (the world)
  void draw(Renderer& r, const dvec3& origin, const dvec3& eye);
  void clear();

private:
  void finish();
  void build();
  PlayCtx& c_;
  std::vector<Shot> shots_;
  std::vector<Pane> panes_;
  std::vector<gfx::Texture> tex_;
  std::vector<float> tanH_, tanV_;
  struct Mesh { std::shared_ptr<Model> model; std::vector<uint8_t> vb; std::vector<vec3> pos; int shot = 0; };
  std::vector<Mesh> meshes_;
  std::function<void()> done_;
  bool pending_ = false, armed_ = false;
  int capture_ = 0;
  double wait_ = 0;
  dvec3 lastEye_{1e30};
};

} // namespace sl
