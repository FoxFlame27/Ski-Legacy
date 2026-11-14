// The police HUD (src/game/police.js: #police-hud, #police-slam / #police-flash, #busted):
//   the WANTED box  bottom left over the money pill (the controls hint steps aside): the blinking red / blue light
//                   bar, the five stars (blinking while they search) over WANTED, the CHASE clock, the state chips
//                   (PULL OVER / PURSUIT / SEARCHING / HIDING..., ROADBLOCK, AIR UNIT, TYRES FLAT), the status line on
//                   its brush (red while it is hot), the tip under it, the helicopter's line, the radio chatter, and
//                   LOSE THEM: the escape clock, its bar, a little patrol car per car after you and how near they are
//   the slam        a big tilted red word for a hit (PIT!) with a red flash round the screen's edge
//   ARRESTED        the full-screen moment: the red word slams in (1.6 -> 1, an overshoot, a shake), the line under
//                   it, red / blue lights pulsing at the screen's edges, fading after 2.9 s
#pragma once
#include "engine/ui.h"
#include <string>

namespace sl {

struct PoliceHudState {
  std::string t;                 // the chase clock "1:23"
  int stars = 1, cars = 0;
  bool search = false, gain = false, hot = false, air = false;
  std::string state, stateCls;   // the chip (stateCls: "hot" / "lost" / "")
  std::string rb, tyres;         // ROADBLOCK · 120 M / 2 TYRES FLAT ("" hides)
  std::string msg, tip, heli, heliCls, radio;
  double radioAge = 10;          // s since the radio line came in (it types in)
  std::string esc, escOf;        // "0:12" and "/ 0:30 · out of sight" ("" hides the escape part)
  double frac = 0;
  std::string near;
  double shownFor = 10;          // s since the box came up (it slides in)
  double now = 0;                // for the blinking
};
/// draws the box; returns its top edge (drawable px) so other bottom-left cards can stack over it
float drawPoliceHud(Ui& ui, const PoliceHudState& s);
/// the big word on a hit: k 0..1 the flash's strength, age s since it started
void drawPoliceSlam(Ui& ui, const std::string& text, const std::string& sub, double age, double k);
/// the ARRESTED moment (bustedBanner): age s since it started (over after ~3.5 s)
void drawBusted(Ui& ui, const std::string& word, const std::string& sub, double age);

} // namespace sl
