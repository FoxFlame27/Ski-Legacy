// The railways (Phase 3): the Wolkenspitzbahn (railway.js / railroute.js: two trains of RAIL_UNITS two-car units
// shuttling on the timetable, crossing on the passing loop, stopping at the halts; boarding at a station's door, the
// timetable jumped so a train stands at the platform, riding in the leading car, getting off at a halt or at the end)
// and the Legacy Express (express.js / expressroute.js: PER_DIR trains each way round the double-track ring on the
// segment timetable (dwell, run, dwell...), boarding at any station for a chosen destination: a train is brought in,
// you ride to it, Space x FAST). The cars: the Meshy body (rail_car2, stretched as train.js does) on the procedural
// underframe and bogies; the far LOD the exported `lo` mesh.
#pragma once
#include "game/vehicles.h"

namespace sl {
struct FontSet;
namespace gfx { class Device; }
class People;

struct TrainRide { bool on = false; dvec3 seat{0}, fwd{0, 0, 1}; std::string hint, stop; bool atStop = false, arrived = false; dvec3 exit{0}; double speed = 0;
                   dvec3 trainPos{0}; double trainYaw = 0;
                   // (railway.js / express.js seat view) the car you sit in (its frame leans with the track) and your
                   // seat in it (the seat's surface, the way it faces)
                   glm::dmat4 car{1}; dvec3 seatLocal{0}; double seatYaw = 0; };

/// the chase camera's state (railway.js / express.js this.chase): the orbit, its smoothed offset from the train
struct TrainChase { double yaw = 0, pitch = 0.18, dist = 34, hold = 0, fov = -1; bool has = false, underground = false; dvec3 off{0}; };

class Railway {
public:
  /// (railway.js applyCamera, outside) behind the train; in a tunnel / a cutting it follows the track (train_views.cpp)
  bool chaseCamera(Camera& cam, double dt, float lookX, float lookY, float wheel);
  bool chaseUnderground() const { return chase_.underground; }
  /// the tunnel's lamps near the train you ride as light pools on the lining, the track and the train (railtrack.js /
  /// expresstrack.js: a lamp at the crown every 18 m / 24 m, the lining lit by them where the daylight does not reach)
  void tunnelLights(Renderer& r) const;
  void resetChase() { chase_ = TrainChase{}; }
  std::vector<dvec3> departures;   // (Phase 7, audio) trains that left a station since the game last took them
  Railway(World& w, Transport& t, VehicleModels& m) : world_(w), t_(t), models_(m) {}
  void init();
  void update(double dt, bool fast, const dvec3& viewer);
  void addDraw(VehicleDraw& draw, const dvec3& cam) const;
  void fillColliders(std::vector<Collider>& out, const dvec3& near) const;
  /// the station whose door p is at (railway.js interaction: 9 m), -1 if none
  int stationNear(const dvec3& p) const;
  std::string label(int st, bool down) const;
  bool board(int st, bool up);
  TrainRide ride() const;
  bool leaveAtStop(dvec3& exit);
  void abort() { ride_.on = false; }
  bool riding() const { return ride_.on; }
  bool rideUp() const { return ride_.up; }
  double cycle() const { return t_.rail.cycle; }
  bool insideView = false;   // the seat view: the car you ride in drawn with its cabin
  /// (Phase 6, transit.js) multiplayer: the line's shared timeline (s: the server clock + its speed-up, 'train|rail');
  /// set, the trains run on it, nobody jumps the timetable, and you board only a train standing at the platform
  std::function<double()> mpTime;
  int rideTrain() const { return ride_.on ? ride_.train : -1; }
  /// (multiplayer) a train stands at station `st` going your way (board() would take you): check before paying
  bool trainReady(int st, bool up) const;
  /// (debug: mplive) where car `car` of train `train` is drawn now
  int trainCount() const { return int(trains_.size()); }
  dvec3 debugCarPos(int train, int car) const { glm::dmat4 M(1); carMatrix(train, car, M); return dvec3(M[3]); }
  int seatCount() const { return ncars_ * 48; }
  /// (railway.js windowAt) the stretch of the cycle (u0, dur) a train stands at station `id` with its doors open,
  /// about to leave up / down (scanned off the timetable in 0.25 s steps); false: none
  bool windowAt(const std::string& id, bool up, double& u0, double& dur) const;
  /// (railway.js seatWorldAt) where seat n (every car's seats in turn) of train `train` is now, the way it faces
  bool seatWorld(int train, int n, dvec3& pos, double& yaw) const;
  /// (debug trainfar: the trains from outside at a distance) a train's car, its speed
  void carPose(int train, int car, glm::dmat4& M) const { carMatrix(train, car, M); }
  double trainSpeed(int train) const { return trains_[size_t(train)].st.speed; }
  /// (railway.js seatPassengers / showPassengers) the skiers riding along in the car you sit in (the seat view)
  void addPeople(People& people) const;

private:
  struct State { double s = 0; int dir = 0; double speed = 0; int at = -1; std::string leg; };
  State trainState(double t, double phase) const;
  double tripS(double t) const;
  double speedAt(double s) const;
  double boardingU(int st, int dir) const;
  double haltArrival(const std::string& id) const;
  dvec3 trackPoint(double s, bool loop) const;
  void carMatrix(int train, int k, glm::dmat4& M) const;
  [[maybe_unused]] World& world_;
  Transport& t_;
  VehicleModels& models_;
  double t_now_ = 0;
  struct Train { double phase; State st; };
  std::vector<Train> trains_;
  int ncars_ = 4;
  struct Ride { bool on = false; int train = 0, car = 0, from = -1, dest = -1; bool up = true, departed = false, exitSent = false; } ride_;
  TrainChase chase_;
};

class Express {
public:
  std::vector<dvec3> departures;   // (Phase 7, audio)
  Express(World& w, Transport& t, VehicleModels& m) : world_(w), t_(t), models_(m) {}
  void init();
  void update(double dt, bool fast, const dvec3& viewer);
  void addDraw(VehicleDraw& draw, const dvec3& cam) const;
  void fillColliders(std::vector<Collider>& out, const dvec3& near) const;
  int stationNear(const dvec3& p) const;
  const Transport::Station& station(int i) const { return t_.express.stations[size_t(i)]; }
  size_t stationCount() const { return t_.express.stations.size(); }
  /// board at station `from` for `to` (the quicker way round): a train is brought in and waits for you
  bool board(int from, int to);
  TrainRide ride() const;
  void abort() { ride_.on = false; walk_.on = false; }
  bool riding() const { return ride_.on; }
  double rideTime(int a, int b, int dir) const;
  // ---- the cameras and the walk through the car (express.js; train_views.cpp)
  bool chaseCamera(Camera& cam, double dt, float lookX, float lookY, float wheel);
  /// the camera beside the line (R a second time); false where there is no spot (a tunnel): the chase camera then
  bool tracksideCamera(Camera& cam, double dt);
  bool chaseUnderground() const { return chase_.underground; }
  /// the tunnel's lamps near the train you ride as light pools on the lining, the track and the train (railtrack.js /
  /// expresstrack.js: a lamp at the crown every 18 m / 24 m, the lining lit by them where the daylight does not reach)
  void tunnelLights(Renderer& r) const;
  void resetViews() { chase_ = TrainChase{0, 0.16, 46}; spot_.on = false; walk_.on = false; seat_ = -1; }
  void standUp(bool firstPerson);
  bool sitDown();
  bool walking() const { return ride_.on && walk_.on; }
  bool walkFirstPerson() const { return walk_.first; }
  int nearestFreeSeat() const;
  /// one frame of walking: forward / sideways (-1..1, relative to the camera), Shift
  void walkStep(double dt, double fwd, double side, bool run);
  /// your feet on the car's floor (world), your heading, speed; shown: third person
  bool walker(dvec3& feet, double& heading, double& speed, bool& shown) const;
  bool walkCamera(Camera& cam, double dt, float lookX, float lookY, float wheel, bool toggleView);
  /// (debug traintest) the walker put at a place in the car, the camera's orbit
  void debugWalk(double x, double z, double yaw, double camYaw, double camPitch) { walk_.x = x; walk_.z = z; walk_.yaw = yaw; walk_.camYaw = camYaw; walk_.camPitch = camPitch; walk_.camT = -1; }
  bool atStop() const { return ride_.on && ride_.departed && trains_[size_t(ride_.train)].st.at >= 0 && !ride_.exitSent; }
  bool insideView = false;
  /// (Phase 6) multiplayer: each direction on its shared timeline (s; 'express|e' up, 'express|w' down)
  std::function<double(int dir)> mpTime;
  /// the train you ride as the server's vehicle id ('express-e0'...), "" when not riding
  std::string rideVehicle() const;
  /// (debug: mplive) where car `car` of train `train` is drawn now; how far along its line it is
  double debugS(int train) const { return trains_[size_t(train)].st.s; }
  double debugU(int train) const { return u(train); }
  double loopOf(int dir) const { return way(dir).loop; }
  int trainDir(int train) const { return trains_[size_t(train)].dir; }
  /// (debug: mplive) the timetable one way: its loop, each segment's start and length, the profile's samples
  std::string debugTt(int dir) const {
    const Way& w = way(dir);
    std::string o = "loop " + std::to_string(w.loop) + " n " + std::to_string(Tm_.size()) + " Tm[n] " + std::to_string(Tm_.empty() ? 0.0 : Tm_.back()) + ":";
    for (const Seg& g : w.segs) o += " " + std::to_string(int(g.dwell)) + "/" + std::to_string(g.ia) + "-" + std::to_string(g.ib) + "@" + std::to_string(g.t0).substr(0, 7) + "+" + std::to_string(g.dur).substr(0, 6);
    return o;
  }
  int trainCount() const { return int(trains_.size()); }
  dvec3 debugCarPos(int train, int car) const { glm::dmat4 M(1); carMatrix(train, car, M); return dvec3(M[3]); }
  /// (express.js seatWorldAt) where seat n (48 a car) of the train with the server's id `id` ('express-e0'...) is now
  bool seatWorld(const std::string& id, int n, dvec3& pos, double& yaw) const;
  int rideDir() const { return ride_.on ? trains_[size_t(ride_.train)].dir : 0; }
  void carPose(int train, int car, glm::dmat4& M) const { carMatrix(train, car, M); }
  double trainSpeed(int train) const { return trains_[size_t(train)].st.speed; }
  /// (multiplayer) a train for `to` stands at `from` for 4 s more: check before paying
  bool trainReady(int from, int to) const;
  /// express.js drawInfo(): the cabin's info screens (over the cab door and on the rear wall) show the trip you ride:
  /// LEGACY EXPRESS -> the destination, the speed, NEXT STOP / NOW / DEPARTING, the line with its stops (the part
  /// behind you red). A 512 x 128 canvas redrawn when the next stop, the speed (5 km/h steps) or the stop changes.
  void drawInfo(gfx::Device& dev, const FontSet& fonts);
  const std::string& infoKey() const { return infoKey_; }
  /// (express.js copyPassengers) the Wolkenspitzbahn's seated skiers, in the cabin you ride in
  void addPeople(People& people) const;

private:
  struct Seg { bool dwell; int st, a, b, ia, ib; double t0, dur; };
  struct Way { int dir; std::vector<Seg> segs; double loop = 0; };
  struct State { double s = 0, speed = 0, u = 0, left = 0; int at = -1, next = -1, seg = 0; };
  State trainState(const Way& w, double u) const;
  const Way& way(int dir) const { return dir > 0 ? up_ : down_; }
  double u(int k) const;
  void carMatrix(int k, int car, glm::dmat4& M) const;
  [[maybe_unused]] World& world_;
  Transport& t_;
  VehicleModels& models_;
  std::vector<double> Tm_;
  std::vector<int> idx_;
  Way up_, down_;
  double t_now_ = 0, off_[2] = {0, 0};
  struct Train { int dir; double phase; State st; };
  std::vector<Train> trains_;
  struct Ride { bool on = false; int train = 0, from = -1, to = -1; bool departed = false, exitSent = false; } ride_;
  std::string infoKey_;
  int infoMat_ = -1;   // the cabin's info screen material (-2: none)
  gfx::Texture infoTex_{};
  TrainChase chase_{0, 0.16, 46};
  struct Spot { bool on = false; double x = 0, y = 0, z = 0, s = 0, blocked = 0; bool fresh = false; } spot_;
  int spotN_ = 0, seat_ = -1;       // seat_: the seat you sat down on after a walk (-1: the one you boarded into)
  double timeScale_ = 1;
  struct WalkBox { double x0, x1, z0, z1; };
  std::vector<WalkBox> walkBoxes_;
  struct Walk { bool on = false, first = false; double x = 0, z = 0, yaw = 0, speed = 0, camYaw = 0, camPitch = -0.18, lookPitch = 0, dist = 2.2, camT = -1; } walk_;
  dvec3 trackAt(double s, int d, dvec2* dir = nullptr) const;
  bool pickSpot(const dvec3& target);
  void buildWalkBoxes();
  void walkMove(double dx, double dz);
};

} // namespace sl
