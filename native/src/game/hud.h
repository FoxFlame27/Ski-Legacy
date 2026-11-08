// The HUD (src/ui/hud.js + style.css's house style): white brush-paper pills with blue italic lettering.
//   top left      location (Barlow Condensed italic), clock and weather, the objective line (red bullet)
//   top centre    the waypoint arrow and distance (a trail-map mark), the flash messages below it
//   bottom left   money ($ in red; the last change fades beside it), the controls hint card above it (once per save)
//   bottom right  speedometer (km/h or mph) and the skis / car you are on
//   bottom centre the interaction prompt with its keycap (the key or button in use), the ride hint
// SETTINGS: HUD full / minimal / off (showSpeedo, showInfo, showMoney, showForecast), HUD size, speed unit, 12 / 24 h
// clock, show FPS.
#pragma once
#include "core/input.h"
#include "engine/ui.h"
#include "game/economy.h"
#include <string>
#include <vector>

namespace sl {

struct HudFrame {
  double speed = 0;                 // m/s
  bool speedo = true;               // (hidden while riding a lift / train)
  std::string location, weather = "Clear", forecast, skiName;
  double hour = 10;
  std::string prompt, promptKey;    // promptKey: the keycap label (K('interact'))
  std::string objective;
  bool waypoint = false;
  double wpAngle = 0, wpDist = 0;   // angle relative to the view (rad, + = right)
  std::string wpLabel;
  std::string rideHint;
  float fps = 0;
};

class Hud {
public:
  enum class Flash { Good, Bad, Gold };
  void flash(const std::string& text, Flash kind, double now, double ms = 1800);
  /// the controls hint card (hud.js controlsHint): up for `secs`, fades once you set off
  void controlsHint(double now, double secs = 15);
  void draw(Ui& ui, const HudFrame& f, Save& save, const Input& in, double now);
  std::string lastFlash() const { return flashText_; }
private:
  std::string flashText_;
  Flash flashKind_ = Flash::Good;
  double flashUntil_ = -1, flashAt_ = -1, hintAt_ = -1, hintUntil_ = -1;
  bool hintSeen_ = false;
};

} // namespace sl
