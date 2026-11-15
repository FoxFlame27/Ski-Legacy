// The job board up close (src/ui/jobboard.js + jobboard.css): a wooden frame with a cork face and a header plank
// (JOBS · place); the day's jobs pinned on it as tilted paper notes (the kind with its icon, the title, the brief,
// the pay + TIP, the time, how hard); a note lifts when you point at it, a click takes it off the board as a bigger
// card (client, the full brief, Pay / Tip / Time / Difficulty, TAKE THE JOB / BACK). Your current job hangs there as a
// yellow note with the YOUR JOB stamp, CANCEL JOB and KEEP GOING. A locked note (the taxi without a car) is greyed out
// with its reason stamped on it. Arrows / the D-pad pick a note or a button, Enter presses it, Esc backs out of the
// card, then closes; a click beside the board closes it.
#pragma once
#include "engine/ui.h"
#include "game/menus.h"
#include <functional>
#include <string>
#include <vector>

namespace sl {

struct JobNote {
  std::string id, type, title, brief, client, payText, tipText, minutes, lockText, takeText, status;
  int reward = 0, bonus = 0, diff = 2;   // diff 1 easy, 2 medium, 3 hard
  bool locked = false;
};
struct JobBoardView {
  std::string place;
  std::vector<JobNote> offers;
  bool hasCurrent = false;
  JobNote current;
  std::function<void(int offer)> take;
  std::function<void()> cancel, closed;
  // state
  int focus = -1;          // with a current job: 0 CANCEL JOB, 1 KEEP GOING, then the notes; else the notes
  int detail = -1, dFocus = 0;
  double openedAt = -1, detailAt = 0;
};
// The RACING stand (src/ui/racestand.js + racestand.css): the same frame and cork; the courses on a paper note on the
// left (number, name, tagline, the level's sign, your best place), the picked course as a card on the right (kicker,
// name, tagline, Length / Drop / Level / Best, the AI difficulty switch, the JUST FOR FUN stamp, START RACE / CLOSE).
// Up / down pick the course, left / right the difficulty, Enter starts, Esc closes.
struct RaceStandView {
  struct C { std::string name, tagline, level; double length = 0, best = -1; int drop = 0, bestPlace = 0, medal = 0; };
  std::vector<C> courses;
  int i = 0, diff = 1;       // diff: 0 easy, 1 medium, 2 hard, 3 superhard
  std::function<void(int course, int diff)> start;
  std::function<void()> closed;
  // state
  double openedAt = -1;
  float scroll = 0, scrollTarget = 0;
  bool reveal = true;
  int frames = 0;
};
bool frameRaceStand(Ui& ui, const UiNav& nav, const Input& in, RaceStandView& v, double dt, double now);

/// one frame: input, then drawing; false once it closed
bool frameJobBoard(Ui& ui, const UiNav& nav, const Input& in, JobBoardView& v, double dt, double now);

/// .diff-sign: the piste-style sign of a course's level (a green disc, a blue square, a black diamond, ringed red for Expert)
void drawDiffSign(Ui& ui, float cx, float cy, const std::string& level, float u);

} // namespace sl
