// Weather (src/world/sky.js's weather states, Phase 5): clear, snow flurries, cloudy, light / heavy snow, misty,
// blizzard, föhn, wet snow, freezing fog, the sea of clouds; NEXT's progression (each holds 80-180 s, a blizzard
// 60-120 s), the forecast ("Later: Blizzard"), the eased snow / cloud / mist / wind / clear-air / wet / frost / sea
// values (~20 s transitions) and what they do: the overcast deck greying the sky gradient by the hour's light level,
// whiter fog in snow and mist (sky.js's fog formula: a blizzard a little thicker than heavy snow, freezing fog thick and
// low, föhn crystal clear), the sun dimmed behind cloud, a sideways gust on the skis, icy roads after heavy snow, and
// the falling snow itself (snowfx.js: flakes in a box round the camera, blown sideways in a blizzard).
#pragma once
#include "core/math.h"
#include "engine/renderer.h"
#include "game/shapes.h"
#include "game/vehicles.h"
#include <algorithm>
#include <string>

namespace sl {

class Weather {
public:
  static constexpr int N = 11;
  struct Def { const char* id; const char* label; float snow, cloud, mist, wind, clear, wet, frost, sea; };
  static const Def& def(int i);
  static int byId(const std::string& id);
  void init(unsigned seed, bool frozen);
  /// per frame (dt real seconds); camY for the sea of clouds
  void update(double dt);
  /// the time-of-day lighting with the weather over it (sky.js update: the overcast deck, fog, the sun behind cloud)
  void apply(Lighting& L, double sunH) const;
  /// the falling snow round the camera
  void drawSnow(Renderer& r, VehicleDraw& vd, gfx::Device& dev, Shapes& shapes, const Camera& cam, double dt, bool indoors);
  void set(int w);   // setWeather (the forecast moves on)
  /// (Phase 6) multiplayer: the world's weather from the server's clock, its forecast and when it comes (s)
  void serverSet(int w, int next, double in) { if (w >= 0) set(w); if (next >= 0 && next < N) next_ = next; timer = std::max(0.0, in) + 5; }
  int current() const { return cur_; }
  std::string label() const { return def(cur_).label; }
  std::string forecast() const;   // "Later: Blizzard" or ""
  double snow = 0, cloud = 0, mist = 0, wind = 0, clearAir = 0, wet = 0, frost = 0, sea = 0, icy = 0;
  double gustX = 0, gustZ = 0;     // m/s^2 sideways push on the skis
  double timer = 75;               // s until the weather moves on
  bool frozen = false;             // (autotest / a race: held)
  int changes = 0;
private:
  int pick(int w);
  double rnd() { seed_ = seed_ * 1664525u + 1013904223u; return double(seed_ >> 8) / double(1u << 24); }
  int cur_ = 0, next_ = 0;
  unsigned seed_ = 1;
  double gustT_ = 0;
  struct Flake { vec3 p; float s; };
  std::vector<Flake> flakes_;
};

} // namespace sl
