// JOBS (Phase 5, game/jobs.js + jobs/catalog.js + jobs/sites.js's Router) and the TAXI (game/taxi.js).
//   The boards     job_board.glb where jobs/sites.js put them (the village plaza, the mountain huts, gondola tops);
//                  E reads one: three offers (the same all game day: catalog.js generateOffers ported exactly, mulberry32
//                  over hashStr(board | day | slot | re-pins), the router's travel-time estimates), plus the TAXI note
//                  (greyed out until you own a car)
//   Delivery       the parcel on your back; hand it over at a hut's door, a lift operator, a patrol post, a race start or
//                  a board (within the limit; a tip under par); a wipeout loses it
//   Rescue         a skier down beside a piste: reach them, then bring them down (an injured one in the akja towed
//                  behind you: too fast for too long is too rough; a stuck beginner follows you) to the bottom
//   Guide          a guest skis your tracks at their own pace to a hut / the village; keep them close
//   Taxi           on duty in your own car: a fare waiting at a bus stop, a lift base, a hotel, a car park; stop beside
//                  them, they get in, the meter runs (flag fall + per km + the climb), drop them at the kerb (tips for a
//                  quick and smooth ride; late: a cut; a crash: no fare); T ends the shift
// Rewards go to the economy (save.jobs: done, failed, earned, the boards' re-pins, the active job).
#pragma once
#include "game/play.h"
#include "game/play_data.h"
#include <memory>
#include <string>
#include <functional>
#include <vector>
#include "player/car_seat.h"

namespace sl {
class Renderer;
class People;
struct Model;

class Jobs {
public:
  explicit Jobs(PlayCtx& c);
  struct Offer {
    std::string id, type, title, shortT, client, brief, cargo, variant, guestName, skill;
    int reward = 0, bonus = 0, est = 0, estDown = 0, par = 0, limit = 0, slot = 0, gen = 0;
    std::string board;
    JobDest dest;          // where it goes
    bool hasSpot = false;
    JobSpot spot{};
    int spotSide = 1;
    std::string guestChar;
    JobDest down;          // rescue: where they are taken
  };
  std::vector<Offer> offers(const JobHub& hub);
  bool interact(std::string& prompt, bool pressed);
  bool accept(const Offer& o);
  void update(double dt);
  void addPeople(People& p, const dvec3& cam) const;
  void draw(Renderer& r, const dvec3& cam, const Model* board);
  void hud(Ui& ui, float u);
  std::string objective() const;
  bool active() const { return job_ != nullptr; }
  void fail(const std::string& reason);
  void drop();                       // a race / the bus / jail: the job is dropped
  void onCrash();                    // your wipeout
  // the taxi
  bool onDuty() const { return taxiOn_; }
  void startTaxi();
  void endTaxi(const char* why);
  bool fareAboard() const { return fare_.stage == Fare::Stage::Aboard; }
  void onCarKnock(bool crash);
  /// (taxi.js posePax) your car's frame and seats while you drive: the fare aboard sits in it (false: not driving)
  std::function<bool(glm::dmat4& car, CarTemplate& t)> carFrame;
  void policeChase();                // the police are after you: the fare ends
  // (autotest)
  int done() const;
  const Offer* current() const { return job_.get(); }
  double estimate(double ax, double az, double bx, double bz) const;
private:
  double direct(double ax, double az, double bx, double bz) const;
  std::unique_ptr<Offer> makeOffer(const JobHub& hub, const std::string& type, int slot, struct Rng& rnd);
  bool descentFor(const JobSpot& s, JobDest& out) const;
  void complete();
  void endJob();
  void openBoard(const JobHub& hub);
  dvec3 destPoint() const;
  PlayCtx& c_;
  std::unique_ptr<Offer> job_;
  double elapsed_ = 0, roughT_ = 0, lostT_ = 0;
  int phase_ = 0;                    // rescue: 0 reaching them, 1 on the way down
  dvec3 guestPos_{0}, sledPos_{0};
  double guestYaw_ = 0, guestV_ = 0;
  std::vector<dvec3> trail_;         // your tracks (the guest follows them)
  // taxi
  bool taxiOn_ = false;
  struct Fare {
    enum class Stage { None, Waiting, Boarding, Aboard, Leaving } stage = Stage::None;
    int from = -1, to = -1;
    std::string name;
    double t = 0, rideT = 0, limit = 0, km = 0, climb = 0, startY = 0;
    int knocks = 0;
    bool crash = false, late = false;
    dvec3 walkPos{0};
  } fare_;
  double nextFareT_ = 0;
  std::string say_;
  double sayT_ = -1;
  unsigned seed_ = 99;
  double rnd() { seed_ = seed_ * 1664525u + 1013904223u; return double(seed_ >> 8) / double(1u << 24); }
};

} // namespace sl
