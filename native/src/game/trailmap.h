// The trail map (src/ui/trailmap.js, condensed): the resort as a piste map in the house style.
// The relief is shaded from the terrain itself (trailmap.js buildTile: hillshade lit from the north-west, snow white to
// pale blue, rock grey-blue on steep faces, forest a light blue-green, faint contour lines), computed once on worker
// threads at two detail levels (the whole network, and the resort's core). Over it: the roads (valley grey, scenic
// amber), the car parks (P), the Wolkenspitzbahn and the Legacy Express (violet, dashed in tunnels), the pistes in
// their grade colours with their names zoomed in, the lifts with their names, huts, bus stops, the shops and
// services (ski shop, tickets, Autohaus, Werkstatt, medical centre), your car, and you (position + heading).
// Controls: drag / left stick = move, wheel / + - / triggers = zoom, R / Y = back to you, click = mark a place (the
// HUD's waypoint points there; click again clears), M / Esc / B = close.
#pragma once
#include "core/math.h"
#include "engine/ui.h"
#include "game/menus.h"
#include <atomic>
#include <memory>
#include <string>
#include <vector>

namespace sl {
class AssetPaths;
class JobSystem;
class World;
class Transport;
class Lifts;
namespace platform { class Platform; }

class TrailMap {
public:
  ~TrailMap();
  void load(platform::Platform& p, const AssetPaths& paths, const World& world, const Transport& t, Lifts& lifts);
  /// starts the relief on the job system (returns at once; ready() when done)
  void buildRelief(JobSystem& jobs, const World& world, gfx::Device& dev);
  bool reliefReady() const;
  void open(const dvec3& at);
  void close() { open_ = false; }
  bool isOpen() const { return open_; }
  /// input + drawing; returns false when it closed itself (cancel)
  bool frame(Ui& ui, const UiNav& nav, const Input& in, double dt, const dvec3& you, double heading, const dvec3* car);
  struct Mark { bool on = false; double x = 0, z = 0; std::string label; } mark;
  std::string hover;
  int drawnItems = 0;               // (autotest) what the last frame drew

private:
  struct Poly { std::vector<dvec2> pts; int kind = 0; std::string name; int diff = 0; };
  struct Place { double x, z; int kind; std::string name; };   // kind: 0 hut, 1 stop, 2 station, 3 service, 4 parking, 5 peak
  vec2 toScreen(double x, double z) const;
  dvec2 toWorld(vec2 s) const;
  void uploadRelief(gfx::Device& dev);

  std::vector<Poly> pistes_, lifts_, roads_, rails_;
  std::vector<std::vector<bool>> railTunnel_;
  std::vector<Place> places_;
  dvec2 bmin_{-6000}, bmax_{6000};
  // relief: two levels (0 = all, 1 = the core)
  struct Relief { dvec2 x0{0}; double size = 1; int n = 0; std::vector<uint8_t> px; std::atomic<int> rowsLeft{0}; };
  struct Shared { Relief rel[2]; };
  std::shared_ptr<Shared> sh_;          // (shared with the worker jobs: they may outlive the map at quit)
  gfx::Texture tex_[2];
  gfx::Device* dev_ = nullptr;
  bool open_ = false;
  double cx_ = 0, cz_ = 0, s_ = 0.2;   // view centre (m) and scale (px per m)
  vec2 drag_{-1}, dragStart_{-1};
  bool dragged_ = false;
  float W_ = 1, H_ = 1;
};

} // namespace sl
