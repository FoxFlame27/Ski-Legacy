// The view through a walk-in room's windows, live, as the web game's (game/liveportal.js; interior.js renderPortal,
// chaletroom.js, carrentalroom.js, prison.js, hospitalroom.js): the room is a scene of its own, standing at a quiet
// spot far from the resort; every frame your camera is carried to where the room stands outdoors (the same eye, the
// same direction, the same field of view), the world is drawn from there first (Renderer::endPortal: the house you
// are in left out), and the window planes show that picture by their place on the screen: a hole in the wall onto the
// world, parallax and all, with the traffic, the people, the lifts, the snowfall and the hour as they are out there.
// While you are inside, the world is streamed and simulated round the house (focus()), not round the quiet spot.
// Drawn only while a window is in view and some of its glass was on the screen a few frames ago (an occlusion query on
// the glass: a window behind a wall costs nothing), at 0.75 of the frame's 3D resolution (the web game's chalets,
// station and ward: 40 % every third frame), with a lighter world than outdoors: only the trees, rocks and props in
// the windows' part of the view, the firs past ~150 m as impostors, the coarse terrain grid (the forest round a chalet,
// tens of millions of triangles uncut, made this pass cost 60-100 ms of GPU time). That is the High, Ultra and Super
// Ultra presets; below them
// (misty) no world is drawn for the glass: it is a grey, misty pane seen from inside, the soft light of the hour
// coming through it, brighter at the top, a little frost round its edges.
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
  /// a window plane in the room's frame (x across, y up, centred), its size
  struct Pane { mat4 m{1}; float w = 1, h = 1; };
  /// where the room stands outdoors: the room's frame in the world (rigid), how near the view out starts, and the box
  /// (the room's frame: centre, half extents; none: half.x = 0) the house fills, left out of the view
  struct Place { glm::dmat4 frame{1}; float nearZ = 0.1f; dvec3 boxC{0}; vec3 boxH{0}; };
  /// the place for eyes at `eye` (the room's frame): the police station's two wings stand in different spots
  using Where = std::function<Place(const dvec3& eye)>;

  explicit WindowView(PlayCtx& c) : c_(c) {}
  ~WindowView() { clear(); }
  /// the room you are going into: its window planes, where it stands, the glass's tint (the web rooms' uTint)
  void begin(std::vector<Pane> panes, Where where, const vec3& tint = vec3(0.888f, 0.913f, 0.930f));
  void clear();
  /// a room with windows is being walked
  bool walked() const { return bool(where_) && !panes_.empty(); }
  /// ... and its windows show the world live (not misty)
  bool live() const { return walked() && !misty; }
  /// the presets below High: the glass is misty, no view of the world (set once at start: a preset change restarts)
  bool misty = false;
  /// where the world is streamed and simulated round while you are inside: the room's middle, outdoors
  dvec3 focus() const { return focus_; }
  /// game loop, once the room's camera is known: the same camera where the room stands outdoors
  void carry(const Camera& cam, const dvec3& origin);
  const Camera& camera() const { return out_; }
  /// is a window in this camera's view (the world is drawn a second time only then); rect: the part of the screen the
  /// windows in view cover (NDC x0, y0, x1, y1)
  bool inView(const Camera& cam, const dvec3& origin, vec4* rect = nullptr) const;
  /// the world's pass for the windows: begins (the house's box to the renderer) and ends; in between the game draws
  /// the world from camera()
  void beginOutdoors(Renderer& r);
  void endOutdoors(Renderer& r);
  bool outdoors() const { return outdoors_; }
  /// is the world to be drawn for the windows this frame (every other frame; at once when the windows' part of the
  /// screen, `rect`, has left the last picture's); rect: grown by a margin, the part to draw
  bool due(vec4& rect);
  /// what the world's pass for the windows took this time (ms, the CPU's side of it): the slower, the rarer
  void took(double ms) { cost_ += (ms - cost_) * 0.2; }
  /// the room's camera the picture is drawn for (with the renderer's aspect), and the renderer told of it each frame
  void drawnFor(const Camera& roomCam);
  void bindView(Renderer& r, const Camera& roomCam) const;
  /// the glass, in the room at `origin`; mirror: once more under the floor (the Autohaus's polished tiles)
  void draw(Renderer& r, const dvec3& origin, bool mirror = false);
  /// the world's pass every `rate`-th frame (begin: 3, as the web game's chalets, station and ward; the shop and the
  /// Autohaus, all glass at the front, 2); more while it is slow
  int rate = 3;
  /// the world's exposure against the room's (the picture is shown in the room's frame); misty: 1 / the room's
  float gain = 1;

private:
  void build();
  PlayCtx& c_;
  std::vector<Pane> panes_;
  Where where_;
  Place place_;
  vec3 tint_{1};
  dvec3 focus_{0};
  Camera out_;
  std::shared_ptr<Model> mesh_, flip_;
  bool outdoors_ = false, has_ = false;
  int tick_ = 0;
  double cost_ = 0;
  vec4 rect_{0};
  mat4 vp_{1};
  dvec3 eye_{0};
};

} // namespace sl
