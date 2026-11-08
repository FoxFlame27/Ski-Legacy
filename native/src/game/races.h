// RACES (Phase 5): the World Racing courses on the mountains (modes/parkour/freeworld.js: E at a start house opens the
// race card), the ski bus's three free races (modes/race/busraces.js: the boards beside the stops, every finisher paid),
// the RACING stand in Legacy Village (game/racestand.js + ui/racestand.js: any course, just for fun, teleported to its
// start), practice runs (alone, no prize), and the race itself (modes/race/session.js condensed): the grid and the
// 3-2-1-GO countdown (frozen), the timer, checkpoints with splits against the fastest racer, slalom gates (missed:
// +0.5 s), the B-nets bouncing you back into the track, respawns at the last checkpoint (wipeout, stuck, off course,
// fallen below the track), the AI field (bots.js condensed: a speed profile from the course's own curvature and grade,
// scaled to the course's reference time x each racer's pace of the chosen field), the finish (time, place), the
// results card, the records (records.js: best, medal by time, best place per field, splits, runs) and the prize money
// (freeworld.js prizeFor / busracedefs.js busRacePrize); after the OK you are back in Legacy Village (modes.js
// exitFree). The race guide (game/raceguide.js) points you to a race near the stop you got off at. The crowd stands at
// a course's finish while you are near it (crowds.js).
#pragma once
#include "game/play.h"
#include "game/play_data.h"
#include <memory>
#include <string>
#include <vector>

namespace sl {
class Renderer;
struct Person;

class Races {
public:
  explicit Races(PlayCtx& c);
  ~Races();
  /// the prompt where you stand (a start house, a race board, the RACING stand); E opens the card. True if it applies.
  bool interact(std::string& prompt, bool pressed);
  /// start a race on `c`: ai 0..3 (easy .. superhard), forMoney (the start house / bus race: entry + prize), practice
  bool start(const Course& c, int ai, bool forMoney, bool practice, bool teleport);
  void update(double dt);
  bool active() const { return bool(s_); }
  bool frozen() const;                     // the grid / countdown: the player is held
  bool finished() const;
  void abort();                            // (pause RETURN TO VILLAGE, arrested...)
  void addPeople(People& people, const dvec3& cam) const;
  void draw(Renderer& r, const dvec3& cam);
  void hud(Ui& ui, float u);
  std::string objective() const;
  /// off a ride at a stop: guide to a race near it (raceguide.js guideFrom)
  void guideFrom(const dvec3& p, const std::string& stop);
  /// (autotest) the session's state and the results' OK
  double raceTime() const;
  int place() const;
  bool resultsUp() const;
  void confirmResults();
  const Course* courseById(const std::string& id) const { return c_.data ? c_.data->course(id) : nullptr; }
  double progress() const;   // metres down the course
  std::vector<std::string> lastRows;   // the results' rows (autotest log)
private:
  struct Prof { std::vector<float> v; double t0 = 0, ref = 60; };
  const Prof& profile(const Course& c);
  void openCard(const Course& c, bool fromStand);
  void openStand();
  void respawn(const char* why);
  void finishPlayer();
  void showResults();
  struct Session;
  PlayCtx& c_;
  std::vector<std::pair<const Course*, Prof>> profs_;
  std::unique_ptr<Session> s_;
  // the guide
  struct Guide { bool on = false; dvec3 target{0}; std::string label; double t = 0, d0 = 0; } guide_;
  double nearCheckT_ = 0;
  const Course* nearCourse_ = nullptr;
};

} // namespace sl
