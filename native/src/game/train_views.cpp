// The trains' cameras and the walk through the Legacy Express (src/world/railway.js / express.js applyCamera,
// trackside, pickSpot, updateWalk, standUp, sitDown, walkCamera, walkBoxes, walkMove), operation for operation:
//   chase      behind the train (the mouse swings it round, the wheel zooms). In a tunnel, a cutting or behind a
//              shoulder the orbit would sit in the rock: there it follows the track just behind the last car, 4.6 m
//              over the rail in the tube (rigid: on the tube's axis whatever the curve), a little higher in a cutting,
//              and stays so 1.2 s after the way is clear again (no flicking)
//   trackside  (the Express, R a second time) a camera beside the line ahead of the train, as for a railway film: it
//              waits on the embankment (beside a viaduct: out from the deck), follows the train going by with a long
//              lens, wider as it passes, then moves on ahead; in a tunnel: the chase camera
//   walking    (the Express) E stands you up into the aisle beside your seat and sits you down on the nearest free seat
//              within 1.6 m (at a stop on the way E gets you off, so there it is F); you walk in the car's own frame
//              (W A S D relative to the camera, Shift faster), sliding along the seat pairs, the tables, the glass
//              screens and the walls, from the rear wall to the cab door; R: third person (an orbit pulled in to stay
//              inside the car) / first person
#include "game/trains.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
bool inSpans(const std::vector<Span>& list, double s, double margin, double ringLen) {
  for (const Span& t : list) {
    if (s > t.s0 + margin && s < t.s1 - margin) return true;
    if (ringLen > 0 && s - ringLen > t.s0 + margin && s - ringLen < t.s1 - margin) return true;
  }
  return false;
}
// the shared part of both chase cameras: `want` the orbit's offset from the target, `back` where the camera goes when it
// has to follow the track (already at its height); returns the camera's place
void applyChase(TrainChase& C, Camera& cam, const dvec3& target, dvec3 want, bool follow, bool rigid, const dvec3& back, double dt, double fov0) {
  const double k6 = 1 - std::exp(-dt * 6);
  if (follow) { want = back - target; C.yaw *= 1 - k6; }
  if (!C.has || rigid) { C.off = want; C.has = true; }
  else C.off += (want - C.off) * (1 - std::exp(-dt * 5));
  cam.lookAt(target + C.off, target);
  C.fov = C.fov < 0 ? fov0 : C.fov + (fov0 - C.fov) * k6;
  cam.fovY = float(C.fov); cam.nearZ = 0.1f;
}
} // namespace

// ---------------------------------------------------------------- the Wolkenspitzbahn's chase camera
bool Railway::chaseCamera(Camera& cam, double dt, float lookX, float lookY, float wheel) {
  if (!ride_.on) return false;
  TrainChase& C = chase_;
  C.yaw -= double(lookX) * 0.0022;
  C.pitch = clamp(C.pitch - double(lookY) * 0.0022, -0.15, 0.9);
  C.dist = clamp(C.dist + double(wheel) * 2, 14, 70);
  const State& st = trains_[size_t(ride_.train)].st;
  const auto& R = t_.rail;
  const double s = st.s, dirSign = st.dir > 0 ? 1 : st.dir < 0 ? -1 : (ride_.up ? 1 : -1);
  const bool onLoop = st.dir < 0 && s > R.loop.s0 && s < R.loop.s1;
  const dvec3 target = trackPoint(s, onLoop) + dvec3(0, 2.2, 0);
  const Line::P f = R.line.at(s);
  const double heading = std::atan2(f.dx, f.dz) + (dirSign < 0 ? PI : 0) + PI + C.yaw, cp = std::cos(C.pitch);
  const dvec3 want(std::sin(heading) * cp * C.dist, std::sin(C.pitch) * C.dist + 2, std::cos(heading) * cp * C.dist);
  const bool tunnelNear = inSpans(R.tunnels, s, -60, 0);
  bool follow = tunnelNear;
  for (int i = 1; i <= 10 && !follow; i++) {   // (any terrain in the way: the whole sight line, the camera with room for the near plane)
    const dvec3 p = target + want * (i / 10.0);
    if (world_.height(p.x, p.z) > p.y - (i == 10 ? 3 : 2)) follow = true;
  }
  if (follow) C.hold = 1.2; else if (C.hold > 0) { C.hold -= dt; follow = true; }
  bool rigid = false;
  dvec3 back(0);
  if (follow) {
    const double pitch = R.car.len + R.car.gap, halfLen = (ncars_ - 1) / 2.0 * pitch + R.car.half, camS = s - dirSign * (halfLen + 10);
    const bool inTube = inSpans(R.tunnels, camS, -4, 0) || inSpans(R.tunnels, s, 0, 0);
    back = trackPoint(clamp(camS, 0, R.line.length), onLoop) + dvec3(0, inTube || tunnelNear ? 4.6 : 7.5, 0);
    rigid = inTube;
  }
  C.underground = follow && (tunnelNear || rigid);
  applyChase(C, cam, target, want, follow, rigid, back, dt, 60);
  return true;
}

// ---------------------------------------------------------------- the tunnels' lamps
namespace {
// the lamps of the tunnel round `s` (every `every` m from its mouth), the nearest `n` to `mid`: (arc length, daylight there)
template <class Place>
void tubeLamps(Renderer& r, const std::vector<Span>& tunnels, double s, double mid, double every, double ringLen, int n, float power, float range, Place place) {
  for (const Span& t0 : tunnels) {
    for (double shift : {0.0, ringLen}) {
      if (shift > 0 && ringLen <= 0) continue;
      const Span t{t0.s0 + shift, t0.s1 + shift, t0.end};
      for (double q : {s, s + ringLen}) {
        if (q < t.s0 - 80 || q > t.s1 + 80) continue;
        const double m = mid + (q - s), k0 = std::round((m - t.s0) / every);
        for (int i = -n / 2; i <= n / 2; i++) {
          const double ls = t.s0 + (k0 + i) * every;
          if (ls < t.s0 + 2 || ls > t.s1 - (t.end ? -1e9 : 2)) continue;
          PointLight l;
          l.pos = place(ls); l.color = vec3(1.0f, 0.93f, 0.82f) * power; l.range = range;
          r.addLight(l);
        }
        return;
      }
    }
  }
}
} // namespace

void Railway::tunnelLights(Renderer& r) const {
  if (!ride_.on) return;
  const State& st = trains_[size_t(ride_.train)].st;
  const double dirSign = st.dir > 0 ? 1 : st.dir < 0 ? -1 : (ride_.up ? 1 : -1);
  const bool onLoop = st.dir < 0 && st.s > t_.rail.loop.s0 && st.s < t_.rail.loop.s1;
  const double L = t_.rail.line.length;
  tubeLamps(r, t_.rail.tunnels, st.s, st.s - dirSign * 20, 18, 0, 6, 26.f, 24.f,
            [&](double ls) { return trackPoint(clamp(ls, 0, L), onLoop) + dvec3(0, 4.7, 0); });
}

void Express::tunnelLights(Renderer& r) const {
  if (!ride_.on) return;
  const Train& tr = trains_[size_t(ride_.train)];
  const double L = t_.express.line.length, s = t_.express.line.wrap(tr.st.s);
  tubeLamps(r, t_.express.tunnels, s, s - tr.dir * 30, 24, L, 6, 42.f, 32.f,
            [&](double ls) { const Line::P p = t_.express.line.at(t_.express.line.wrap(ls)); return dvec3(p.x, p.y + 6.3, p.z); });
}

// ---------------------------------------------------------------- the Legacy Express's chase camera
dvec3 Express::trackAt(double s, int d, dvec2* dir) const {
  const Line::P p = t_.express.line.at(t_.express.line.wrap(s));
  const double off = t_.express.trackOff * d;
  if (dir) *dir = dvec2(p.dx, p.dz);
  return dvec3(p.x - p.dz * off, p.y, p.z + p.dx * off);
}

bool Express::chaseCamera(Camera& cam, double dt, float lookX, float lookY, float wheel) {
  if (!ride_.on) return false;
  TrainChase& C = chase_;
  const auto& E = t_.express;
  const Train& tr = trains_[size_t(ride_.train)];
  const double pitchLen = t_.rail.car.len + t_.rail.car.gap, L = E.line.length;
  C.yaw -= double(lookX) * 0.0022;
  C.pitch = clamp(C.pitch - double(lookY) * 0.0022, -0.15, 0.9);
  C.dist = clamp(C.dist + double(wheel) * 2.5, 18, 110);
  const int d = tr.dir;
  const double s = E.line.wrap(tr.st.s);
  dvec2 dir;
  const dvec3 p = trackAt(s, d, &dir), target = p + dvec3(0, 2.2, 0);
  const double heading = std::atan2(dir.x * d, dir.y * d) + PI + C.yaw, cp = std::cos(C.pitch);
  const dvec3 want(std::sin(heading) * cp * C.dist, std::sin(C.pitch) * C.dist + 2, std::cos(heading) * cp * C.dist);
  const bool tunnelNear = inSpans(E.tunnels, s, -70, L);
  bool follow = tunnelNear;
  for (int i = 1; i <= 10 && !follow; i++) {
    const dvec3 q = target + want * (i / 10.0);
    if (world_.height(q.x, q.z) > q.y - (i == 10 ? 3 : 2)) follow = true;
  }
  if (follow) C.hold = 1.2; else if (C.hold > 0) { C.hold -= dt; follow = true; }
  bool rigid = false;
  dvec3 back(0);
  if (follow) {
    const double camS = E.line.wrap(s - d * (2 * pitchLen + 12));
    const bool inTube = inSpans(E.tunnels, camS, -4, L) || inSpans(E.tunnels, s, 0, L);
    back = trackAt(camS, d) + dvec3(0, inTube || tunnelNear ? 4.6 : 8, 0);
    rigid = inTube;
  }
  C.underground = follow && (tunnelNear || rigid);
  applyChase(C, cam, target, want, follow, rigid, back, dt, 58);
  return true;
}

// ---------------------------------------------------------------- the Express's trackside camera
bool Express::pickSpot(const dvec3& target) {
  const auto& E = t_.express;
  const Train& tr = trains_[size_t(ride_.train)];
  const int d = tr.dir;
  const double L = E.line.length, s0 = E.line.wrap(tr.st.s);
  spotN_++;
  const double ahead0 = 170 + std::min(4.0, timeScale_) * 60;
  for (int k = 0; k < 10; k++) {
    const double s = E.line.wrap(s0 + d * (ahead0 + k * 45));
    if (inSpans(E.tunnels, s, -25, L)) continue;
    const bool bridge = inSpans(E.bridges, s, 8, L);
    const int side = (spotN_ + k) % 2 ? 1 : -1;
    dvec2 dir;
    const dvec3 q = trackAt(s, d, &dir);
    const double rx = -dir.y * d * side, rz = dir.x * d * side;
    const double lat = bridge ? 34 + (k % 3) * 8 : 14 + ((spotN_ + k) % 3) * 7;
    const double x = q.x + rx * lat - dir.x * d * 25, z = q.z + rz * lat - dir.y * d * 25;   // (a little back toward the train)
    const double g = world_.height(x, z);
    const double y = bridge ? std::max(g + 3, q.y - 4) : std::max(g + 1.7 + (k % 2) * 3, q.y + 0.8);
    // the train in view now and where it passes
    bool clear = true;
    for (const dvec3& tx : {target, dvec3(q.x, q.y + 2, q.z)})
      for (int i = 1; i < 10 && clear; i++) { const double f = i / 10.0, px = x + (tx.x - x) * f, pz = z + (tx.z - z) * f; if (world_.height(px, pz) > y + (tx.y - y) * f - 0.6) clear = false; }
    if (clear) { spot_ = Spot{true, x, y, z, s, 0, true}; return true; }
  }
  spot_.on = false;
  return false;
}

bool Express::tracksideCamera(Camera& cam, double dt) {
  if (!ride_.on) return false;
  const auto& E = t_.express;
  const Train& tr = trains_[size_t(ride_.train)];
  const int d = tr.dir;
  const double L = E.line.length, s = E.line.wrap(tr.st.s), pitchLen = t_.rail.car.len + t_.rail.car.gap;
  if (inSpans(E.tunnels, s, -40, L)) { spot_.on = false; return false; }
  const dvec3 target = trackAt(s + d * 1.2 * pitchLen, d) + dvec3(0, 2.4, 0);
  auto wrapS = [&](double v) { return std::fmod(std::fmod(v, L) + L, L); };
  const bool passed = spot_.on && (wrapS((spot_.s - s) * d + L / 2) - L / 2) < -(2 * pitchLen + 25);
  if (spot_.on && !passed) {   // (the view blocked for a moment: a new spot)
    bool blocked = false;
    for (int i = 1; i < 8 && !blocked; i++) { const double k = i / 8.0, x = spot_.x + (target.x - spot_.x) * k, z = spot_.z + (target.z - spot_.z) * k; if (world_.height(x, z) > spot_.y + (target.y - spot_.y) * k - 0.5) blocked = true; }
    spot_.blocked = blocked ? spot_.blocked + dt : 0;
  }
  if (!spot_.on || passed || spot_.blocked > 0.6 || std::hypot(spot_.x - target.x, spot_.z - target.z) > 1100) pickSpot(target);
  if (!spot_.on) return false;
  const dvec3 eye(spot_.x, spot_.y, spot_.z);
  cam.lookAt(eye, target);
  cam.nearZ = 0.2f;
  // a long lens far off, wider as it passes (the set about a third of the frame)
  const double dist = glm::length(eye - target), want = clamp(2 * std::atan(30 / std::max(1.0, dist)) / DEG, 16, 62);
  chase_.fov = spot_.fresh || chase_.fov < 0 ? want : chase_.fov + (want - chase_.fov) * (1 - std::exp(-dt * 4));
  spot_.fresh = false;
  cam.fovY = float(chase_.fov);
  chase_.has = false;   // (back to the chase camera: its orbit starts afresh)
  return true;
}

// ---------------------------------------------------------------- walking about in the Express
namespace {
constexpr double WALK_R = 0.2, WALK_SPEED = 1.6, WALK_EYE = 1.6;
}

void Express::buildWalkBoxes() {
  walkBoxes_.clear();
  const auto& R = t_.rail;
  const auto& C = R.cabin;
  // a seat pair: its cushions, back and pedestal (the back at z - 0.3 face, the cushion's front edge ~0.22 ahead)
  struct Pair { double xa = 1e9, xb = -1e9, z = 0, face = 1; };
  std::vector<Pair> pairs;
  for (const vec4& st : R.seats) {
    const double sx = st.x > 0 ? 1 : -1, face = std::fabs(st.w) < 0.1 ? 1 : -1;
    Pair* p = nullptr;
    for (Pair& q : pairs) if ((q.xa > 0 ? 1 : -1) == sx && std::fabs(q.z - double(st.z)) < 0.005) { p = &q; break; }
    if (!p) { pairs.push_back(Pair{double(st.x), double(st.x), double(st.z), face}); continue; }
    p->xa = std::min(p->xa, double(st.x)); p->xb = std::max(p->xb, double(st.x));
  }
  for (const Pair& p : pairs) {
    const double xa = p.xa - 0.25, xb = p.xb + 0.25, za = p.z - p.face * 0.36, zb = p.z + p.face * 0.2;
    walkBoxes_.push_back({std::max(xa, -C.HW), std::min(xb, C.HW), std::min(za, zb), std::max(za, zb)});
  }
  // the tables at every bay's windows (expressinterior.js: 0.44 x 0.56 at x +-(W - 0.24), mid-bay)
  for (int b = 0; b < C.BAYS_N; b++) for (double s : {1.0, -1.0}) {
    const double z = C.BAYS_Z0 + b * C.BAY + C.BAY / 2, x = s * (C.W - 0.24);
    walkBoxes_.push_back({x - 0.22, x + 0.22, z - 0.28, z + 0.28});
  }
  // the glass screens beside the vestibules (train.js: 0.6 wide from the wall, 0.75 in from each door)
  for (double dz : {4.1, -7.05}) for (double s : {1.0, -1.0}) {
    const double z = dz + (dz > 0 ? -0.75 : 0.75), xi = s * (C.W - 0.6), xo = s * C.W;
    walkBoxes_.push_back({std::min(xi, xo), std::max(xi, xo), z - 0.03, z + 0.03});
  }
}

void Express::walkMove(double dx, double dz) {
  Walk& w = walk_;
  const auto& R = t_.rail;
  const double x0 = -(R.cabin.W - 0.04), x1 = R.cabin.W - 0.04, z0 = -R.car.half + 0.16, z1 = R.cabin.cabZ - 0.05, r = WALK_R;
  const int n = std::max(1, int(std::ceil(std::hypot(dx, dz) / 0.08)));
  for (int i = 0; i < n; i++) {
    w.x += dx / n; w.z += dz / n;
    for (int it = 0; it < 2; it++) for (const WalkBox& b : walkBoxes_) {
      const double cx = clamp(w.x, b.x0, b.x1), cz = clamp(w.z, b.z0, b.z1), ex = w.x - cx, ez = w.z - cz, d2 = ex * ex + ez * ez;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) { const double d = std::sqrt(d2), k = (r - d) / d; w.x += ex * k; w.z += ez * k; }
      else {   // (the centre inside the box: out of the nearest side)
        const double o[4][2] = {{b.x0 - r - w.x, 0}, {b.x1 + r - w.x, 0}, {0, b.z0 - r - w.z}, {0, b.z1 + r - w.z}};
        int best = 0;
        for (int k = 1; k < 4; k++) if (std::fabs(o[k][0] + o[k][1]) < std::fabs(o[best][0] + o[best][1])) best = k;
        w.x += o[best][0]; w.z += o[best][1];
      }
    }
    w.x = clamp(w.x, x0 + r, x1 - r); w.z = clamp(w.z, z0 + r, z1 - r);
  }
}

void Express::standUp(bool firstPerson) {
  if (!ride_.on || walk_.on) return;
  if (walkBoxes_.empty()) buildWalkBoxes();
  const auto& R = t_.rail;
  const vec4 st = seat_ >= 0 && size_t(seat_) < R.seats.size() ? R.seats[size_t(seat_)] : vec4(R.seat, float(R.seatYaw));
  // into the aisle beside your seat, facing the way the seat faces
  walk_ = Walk{};
  walk_.on = true; walk_.x = 0; walk_.z = st.z; walk_.yaw = st.w; walk_.camYaw = double(st.w) + PI; walk_.camPitch = -0.18; walk_.first = firstPerson; walk_.dist = 2.2;
  walkMove(0, 0);
}

int Express::nearestFreeSeat() const {
  if (!walk_.on) return -1;
  const auto& R = t_.rail;
  int best = -1;
  double bd = 1.6 * 1.6;   // (within reach: 1.6 m)
  for (size_t k = 0; k < R.seats.size(); k++) {
    bool taken = false;
    if (!mpTime && !R.passengers.empty()) for (const auto& q : R.passengers[0]) taken = taken || q.seat == int(k);
    if (taken && int(k) != seat_) continue;
    const double d = (double(R.seats[k].x) - walk_.x) * (double(R.seats[k].x) - walk_.x) + (double(R.seats[k].z) - walk_.z) * (double(R.seats[k].z) - walk_.z);
    if (d < bd) { bd = d; best = int(k); }
  }
  return best;
}

bool Express::sitDown() {
  const int k = nearestFreeSeat();
  if (!walk_.on || k < 0) return false;
  seat_ = k;
  walk_.on = false;
  return true;
}

void Express::walkStep(double dt, double fwd, double side, bool run) {
  Walk& w = walk_;
  if (!w.on) return;
  const double look = w.first ? w.yaw : w.camYaw + PI;   // (forward: where you look / away from the camera)
  double mx = std::sin(look) * fwd - std::cos(look) * side, mz = std::cos(look) * fwd + std::sin(look) * side;
  const double ml = std::hypot(mx, mz), want = ml > 1e-6 ? WALK_SPEED * (run ? 1.5 : 1) : 0;
  w.speed += (want - w.speed) * (1 - std::exp(-dt * 10));
  if (ml > 1e-6) {
    mx /= ml; mz /= ml;
    const double x0 = w.x, z0 = w.z;
    walkMove(mx * w.speed * dt, mz * w.speed * dt);
    if (!w.first) w.yaw += wrapPi(std::atan2(mx, mz) - w.yaw) * (1 - std::exp(-dt * 12));
    if (dt > 0) w.speed = std::min(w.speed, std::hypot(w.x - x0, w.z - z0) / dt);   // (against a wall: the legs stop)
  }
}

bool Express::walker(dvec3& feet, double& heading, double& speed, bool& shown) const {
  if (!ride_.on || !walk_.on) return false;
  glm::dmat4 M;
  carMatrix(ride_.train, 0, M);
  feet = dvec3(M * glm::dvec4(walk_.x, t_.rail.car.floor, walk_.z, 1));
  const dvec3 f = dvec3(M * glm::dvec4(std::sin(walk_.yaw), 0, std::cos(walk_.yaw), 0));
  heading = std::atan2(f.x, f.z); speed = walk_.speed; shown = !walk_.first;
  return true;
}

bool Express::walkCamera(Camera& cam, double dt, float lookX, float lookY, float wheel, bool toggleView) {
  if (!ride_.on || !walk_.on) return false;
  Walk& w = walk_;
  const auto& R = t_.rail;
  if (toggleView) w.first = !w.first;
  const double F = R.car.floor, sens = 0.0022;
  dvec3 eye, dir;
  if (w.first) {
    w.yaw -= double(lookX) * sens;
    w.lookPitch = clamp(w.lookPitch - double(lookY) * sens, -1.2, 1.1);
    eye = dvec3(w.x + std::sin(w.yaw) * 0.08, F + WALK_EYE, w.z + std::cos(w.yaw) * 0.08);
    dir = dvec3(std::sin(w.yaw) * std::cos(w.lookPitch), std::sin(w.lookPitch), std::cos(w.yaw) * std::cos(w.lookPitch));
  } else {
    w.camYaw -= double(lookX) * sens;
    w.camPitch = clamp(w.camPitch - double(lookY) * sens, -0.9, 0.5);
    w.dist = clamp(w.dist + double(wheel) * 0.25, 0.8, 2.6);
    const dvec3 focus(w.x, F + 1.45, w.z);
    const double cp = std::cos(w.camPitch);
    const dvec3 off(std::sin(w.camYaw) * cp, -std::sin(w.camPitch), std::cos(w.camYaw) * cp);
    // pulled in at the walls, the ceiling and the end walls (a ray from your head out of the car's inner box)
    const double XW = R.cabin.W - 0.1, z0 = -R.car.half + 0.16, z1 = R.cabin.cabZ - 0.05;
    double t = w.dist;
    if (std::fabs(off.x) > 1e-4) t = std::min(t, std::max(0.3, ((off.x > 0 ? XW : -XW) - focus.x) / off.x));
    if (off.y > 1e-4) t = std::min(t, std::max(0.3, (R.cabin.CEIL_Y - 0.08 - focus.y) / off.y));
    if (off.y < -1e-4) t = std::min(t, std::max(0.3, (F + 0.25 - focus.y) / off.y));
    if (off.z > 1e-4) t = std::min(t, std::max(0.3, (z1 - 0.05 - focus.z) / off.z));
    if (off.z < -1e-4) t = std::min(t, std::max(0.3, (z0 + 0.05 - focus.z) / off.z));
    w.camT = w.camT < 0 ? t : std::min(t, w.camT + (t - w.camT) * (1 - std::exp(-dt * 6)));   // (in at once, back out softly)
    eye = focus + off * w.camT;
    dir = -off;
  }
  glm::dmat4 M;
  carMatrix(ride_.train, 0, M);
  const dvec3 e = dvec3(M * glm::dvec4(eye, 1)), dw = glm::normalize(dvec3(M * glm::dvec4(dir, 0)));
  cam.lookAt(e, e + dw, vec3(glm::normalize(dvec3(M * glm::dvec4(0, 1, 0, 0)))));
  chase_.fov = chase_.fov < 0 ? 70 : chase_.fov + (70 - chase_.fov) * (1 - std::exp(-dt * 6));
  cam.fovY = float(chase_.fov); cam.nearZ = 0.05f;
  return true;
}

} // namespace sl
