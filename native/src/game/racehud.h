// The race HUD and the results screen (src/ui/racehud.js + style.css RACE HUD / RACE RESULTS, src/ui/presentation.js'
// lower third): white brush panels with blue italic condensed numerals, everything in --u.
//   panels     POSITION (3 RD / 15) with the live standings under it (six rows: the top six, or the podium and your
//              neighbourhood), the clock top centre with the penalty chip and the checkpoint split card, the course /
//              CHECKPOINT / NEXT (an arrow pointing the way, red for a gate) / TO FINISH panel top right, the
//              speedometer with the course progress bottom right
//   overlays   the 3-2-1-GO numerals on their paint strokes, the centre banner (WRONG WAY, RESPAWN...), the intro's
//              lower third (the course, its stats) under the letterbox bars
//   results    RACE · HARD · RESULTS, the course, the place on its stroke with the medal, TIME / NEW PERSONAL BEST /
//              PERSONAL BEST / PENALTIES / PRIZE MONEY, the ranking table (POS RACER TIME GAP, you on the blue brush,
//              DNF rows dimmed; a field over 8 gets the compact rows) and the brush buttons (RETRY R / NEXT ENTER /
//              MENU ESC, or the open-world races' single OK); left / right / A D choose, Enter / Space confirm, Esc, R
#pragma once
#include "engine/ui.h"
#include "game/menus.h"
#include <string>
#include <vector>

namespace sl {

struct RaceHudState {
  std::string course, difficulty;
  bool trial = false;                    // a practice run: no position panel
  double time = 0;
  int position = 0, total = 0;
  int checkpoint = 0, checkpoints = 0;
  bool hasNext = false;
  std::string nextLabel = "NEXT";        // NEXT / GATE
  double nextDist = 0, nextAngle = 0;    // m, degrees relative to the view (0 = ahead)
  double toFinish = -1, progress = 0;    // m, 0..1
  double speed = 0;                      // m/s
  double penalty = 0;
  struct Row { std::string name; double gap = 0; bool me = false; };
  std::vector<Row> standings;            // in order
  double shownFor = 10;                  // s since the panels came up (their slide-in)
  // overlays
  std::string countdown;                 // "3" "2" "1" "GO" ("" none)
  double countdownAge = 0;               // s since this numeral came up
  struct Split { bool on = false; int index = 0, total = 0; double split = 0, delta = 0; bool hasDelta = false; std::string name; double age = 0; } split;
  std::string notice;
  int noticeKind = 0;                    // 0 info, 1 bad, 2 good
  double noticeAge = 0, noticeFor = 1.8;
  // the intro's lower third (presentation.js lowerThird)
  struct Third { bool on = false; std::string kicker, title; std::vector<std::pair<std::string, std::string>> stats; double age = 0, left = 9;
                 struct Row { int place = 0; std::string name, time; bool me = false; }; std::vector<Row> rows;   // the podium: the top 3
                 bool bars = true; } third;
};
void drawRaceHud(Ui& ui, const RaceHudState& s, float hudScale = 1);
/// presentation.js sting(): three brush strokes sweep across (blue, white with the label, red); 0.9 s, covered 36-60 %
void drawStinger(Ui& ui, const std::string& label, double age);
/// presentation.js badge(): the REPLAY badge under the top bar (a blinking red dot, the word, the replay's clock, SLOW MOTION)
void drawReplayBadge(Ui& ui, const std::string& time, bool slow, double age, double now);

struct RaceResults {
  std::string courseName, difficulty;
  bool trial = false;
  struct Row { std::string name; double time = 0, gap = 0; bool me = false, dnf = false; };
  std::vector<Row> rows;
  int place = 0;
  double time = 0;
  bool dnf = false;
  int medal = 0;                         // 0 none, 1 gold, 2 silver, 3 bronze
  bool pb = false;
  double previousBest = -1, penalty = 0, prizeMult = 1;
  long long prize = 0, points = 0;
  struct Choice { std::string id, label, key; };   // key: R / ENTER / ESC
  std::vector<Choice> choices;
  // state
  int focus = -1;
  double shownAt = -1;
};
/// one frame of the results screen: input, then drawing; returns the chosen id ("" while it is up)
std::string frameRaceResults(Ui& ui, const UiNav& nav, const Input& in, RaceResults& r, double now);

} // namespace sl
