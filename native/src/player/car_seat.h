// Sitting in a car: src/game/carpeople.js (SEATS, seatsFor, seatHip, leanBack, underRoof, seatLegs, the traffic's
// seated figures) and src/world/seatpose.js (poseSeated), ported for the skier rig (player/skier_rig.h: the functions
// themselves are SkierRig members, in car_seat.cpp).
//
// Every seated person in a car goes through seatLegs (Oct 31 2026, the user: "you still don't sit properly on a
// chair"): the thighs out of the seat rising a little to the knees, the shins down and forward into the footwell, the
// heels on that car's floor, the boots nearly flat (the driver's right on the throttle). The rig's own 'sit' pose is a
// chairlift pose (legs dangling 0.36 m under the seat): in a car that put the boots through the floor, under the sill.
// Used for the traffic's people (People: CarSeatRef::Figure, the bake carpeople.js does, live), you at the wheel
// (PlayerSkier: drive.js placeRig), the taxi's fare and the other players in cars (CarSeatRef::Seated: taxi.js posePax,
// remote.js carLegs).
#pragma once
#include "player/three_math.h"
#include <glm/glm.hpp>
#include <string>

namespace sl {

/// carpeople.js SEATS: per car model, measured from the fitted templates (car frame: +x the driver's side (left), +z
/// forward, y up from the ground): d the driver's seat [centre x, cushion top y under the hips, the backrest's front z
/// 0.15 m above the cushion, its lean back (z per metre up)], p the front passenger's [y, z, lean] when it differs
/// (x mirrored), r the rear outboard seats [x, y, z, lean], floor (in front of the front / rear seats), roof (inside,
/// above them), wheel the steering wheel's centre [y, z].
struct CarSeats {
  const char* name;
  bool traffic;
  double size[2], wheel[2], d[4];
  bool hasP; double p[3];
  bool hasR; double r[4];
  double floor[2], roof[2];
};
/// the seat hints of a car model (by its model name: the C++ has one model per car, carpeople.js matches the templates
/// by size and steering wheel), or null
const CarSeats* carSeatsFor(const std::string& model);
/// (m) how much higher a rig sits in a car seat than its plain 'sit' pose puts it (carpeople.js SEAT_LIFT)
constexpr double SEAT_LIFT = 0.06;
/// a seated skier's eye above (y) and ahead of (z) the seat point it sits on (carpeople.js SEAT_EYE, as the bake measures
/// it on the first look)
constexpr double SEAT_EYE_Y = 0.78, SEAT_EYE_Z = 0.04;

/// What seatLegs / underRoof know about the car (carpeople.js `t`, the template): its seats, its height (the roof without
/// seat hints) and its steering wheel (cars.js t.steering; the C++ has no measured wheel: SEATS' wheel centre, the
/// default column tilt and rim radius).
struct CarTemplate {
  const CarSeats* S = nullptr;
  double sizeY = 1.5;
  bool steering = false;
  three::V3 steerC{0};
  double tilt = 0.38, rimR = 0.185;
  /// from the seat hints (the steering wheel at the driver's x)
  static CarTemplate of(const CarSeats* S, double sizeY);
};

/// carpeople.js seatHip(t, hipY, reach): the driver's hip joint in the car's frame, false without seat hints
bool carSeatHip(const CarTemplate& t, double hipY, double reach, three::V3& out);
/// taxi.js carSeats(t): the seat points (car frame) of the driver, the front passenger, the rear left / right (2 or 4)
int carSeatPoints(const CarTemplate& t, three::V3 out[4]);
/// taxi.js paxSeat: the taxi's fare sits behind the front passenger (a two-seater: beside you)
inline int taxiPaxSeat(int n) { return n > 3 ? 3 : 1; }

/// A person seated in a car (game/people.h Person::car)
struct CarSeatRef {
  enum How : uint8_t { None, Figure, Seated };
  How how = None;
  glm::dmat4 car{1};        // the car's frame (car -> world: nose +z, wheels on y 0)
  CarTemplate t;
  int seat = 0;             // 0 the driver, 1 the front passenger, 2.. the back
  bool driver = false;
  int look = 0;             // (Figure) carpeople.js LOOKS index: the passengers' hands (lap / thighs) and head turn
  double x = 0;             // (Figure) the seat's x: the driver's side +, the passenger's -
};

} // namespace sl
