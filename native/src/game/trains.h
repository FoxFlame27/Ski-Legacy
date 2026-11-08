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

struct TrainRide { bool on = false; dvec3 seat{0}, fwd{0, 0, 1}; std::string hint, stop; bool atStop = false, arrived = false; dvec3 exit{0}; double speed = 0;
                   dvec3 trainPos{0}; double trainYaw = 0; };

class Railway {
public:
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
  double cycle() const { return t_.rail.cycle; }
  bool insideView = false;   // the seat view: the car you ride in drawn with its cabin
  /// (Phase 6, transit.js) multiplayer: the line's shared timeline (s: the server clock + its speed-up, 'train|rail');
  /// set, the trains run on it, nobody jumps the timetable, and you board only a train standing at the platform
  std::function<double()> mpTime;
  int rideTrain() const { return ride_.on ? ride_.train : -1; }
  /// (multiplayer) a train stands at station `st` going your way (board() would take you): check before paying
  bool trainReady(int st, bool up) const;
  int seatCount() const { return ncars_ * 48; }

private:
  struct State { double s = 0; int dir = 0; double speed = 0; int at = -1; std::string leg; };
  State trainState(double t, double phase) const;
  double tripS(double t) const;
  double speedAt(double s) const;
  double boardingU(int st, int dir) const;
  double haltArrival(const std::string& id) const;
  dvec3 trackPoint(double s, bool loop) const;
  void carMatrix(int train, int k, glm::dmat4& M) const;
  World& world_;
  Transport& t_;
  VehicleModels& models_;
  double t_now_ = 0;
  struct Train { double phase; State st; };
  std::vector<Train> trains_;
  int ncars_ = 4;
  struct Ride { bool on = false; int train = 0, car = 0, from = -1, dest = -1; bool up = true, departed = false, exitSent = false; } ride_;
};

class Express {
public:
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
  void abort() { ride_.on = false; }
  bool riding() const { return ride_.on; }
  double rideTime(int a, int b, int dir) const;
  bool insideView = false;
  /// (Phase 6) multiplayer: each direction on its shared timeline (s; 'express|e' up, 'express|w' down)
  std::function<double(int dir)> mpTime;
  /// the train you ride as the server's vehicle id ('express-e0'...), "" when not riding
  std::string rideVehicle() const;
  int rideDir() const { return ride_.on ? trains_[size_t(ride_.train)].dir : 0; }
  /// (multiplayer) a train for `to` stands at `from` for 4 s more: check before paying
  bool trainReady(int from, int to) const;

private:
  struct Seg { bool dwell; int st, a, b, ia, ib; double t0, dur; };
  struct Way { int dir; std::vector<Seg> segs; double loop = 0; };
  struct State { double s = 0, speed = 0, u = 0, left = 0; int at = -1, next = -1, seg = 0; };
  State trainState(const Way& w, double u) const;
  const Way& way(int dir) const { return dir > 0 ? up_ : down_; }
  double u(int k) const;
  void carMatrix(int k, int car, glm::dmat4& M) const;
  World& world_;
  Transport& t_;
  VehicleModels& models_;
  std::vector<double> Tm_;
  std::vector<int> idx_;
  Way up_, down_;
  double t_now_ = 0, off_[2] = {0, 0};
  struct Train { int dir; double phase; State st; };
  std::vector<Train> trains_;
  struct Ride { bool on = false; int train = 0, from = -1, to = -1; bool departed = false, exitSent = false; } ride_;
};

} // namespace sl
