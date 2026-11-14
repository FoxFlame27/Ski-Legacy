// RACES (Phase 5): the World Racing courses on the mountains (modes/parkour/freeworld.js: E at a start house opens the
// race card), the ski bus's three free races (modes/race/busraces.js: the boards beside the stops, every finisher paid),
// the RACING stand in Legacy Village (game/racestand.js + ui/racestand.js: any course, just for fun, teleported to its
// start), practice runs (alone, no prize), and the race itself (modes/race/session.js condensed): the grid and the
// 3-2-1-GO countdown (frozen), the timer, checkpoints with splits against the fastest racer, slalom gates (missed:
// +0.5 s), the B-nets bouncing you back into the track, respawns at the last checkpoint (wipeout, stuck, off course,
// fallen below the track), the AI field (game/race_bots: bots.js ported, each racer on its own racing line with its
// own physics, race craft and rig; the grid, the traffic snapshot, the rubber band, the racers' separation, the
// shoulder contact with you and the parking lanes after the line as session.js), the finish (time, place), the
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
namespace racebots { class Track; }

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
  /// (Phase 7) what to hear, taken by the game each frame: count:3 count:2 count:1 go checkpoint miss finish:<place|record|practice> medal:<gold|silver|bronze> results
  std::vector<std::string> sounds;
  /// (autotest) the AI field's motion: the largest sideways step of a racer in one frame beyond what its lateral speed
  /// allows (m; 0 = continuous), the largest lateral speed seen (m/s), how many racers are drawn
  double botJump = 0, botLatV = 0;
  int botsDrawn = 0;
private:
  racebots::Track& trackOf(const Course& c);
  void updateBots(double dt);
  void botSeparation();
  void botContact();
  void drawBots(Renderer& r, const dvec3& cam);
  void openCard(const Course& c, bool fromStand);
  void openStand();
  void respawn(const char* why);
  void finishPlayer();
  void showResults();
  struct Session;
  PlayCtx& c_;
  std::vector<std::pair<const Course*, std::unique_ptr<racebots::Track>>> tracks_;
  double animDt_ = 0;
  std::unique_ptr<Session> s_;
  // the guide
  struct Guide { bool on = false; dvec3 target{0}; std::string label; double t = 0, d0 = 0; } guide_;
  double nearCheckT_ = 0;
  int lastCount_ = 0;
  const Course* nearCourse_ = nullptr;
};

} // namespace sl
