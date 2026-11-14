// heli/ambulance.js: the ambulance that meets the rescue helicopter at the village pad. It waits beside the pad, you
// are carried in, and it drives you with its lights flashing to the medical centre's door along the Rettungsweg (the
// way Ambulance.plan + setPath made from the pad: exported, its corners rounded). It follows the way's centre line
// with a lateral offset it eases in and out of (never sideways: it steers onto it as it drives), looking ahead
// (10 m + 1.8 s) for what is in the way (the cars, the bus, anything solid near you: the scenery's moving colliders),
// picks the free line within the road nearest where it is, slows for what it can't get round in time and waits behind
// what blocks the whole road.
#include "game/heli.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "game/shapes.h"
#include "world/scenery.h"
#include "world/transport.h"
#include "world/world.h"

namespace sl {

namespace {
constexpr double LEN = 5.9, HW = 1.1, VMAX = 24, ROAD_HALF = Transport::ROAD_HALF;
constexpr double LAT_HARD = ROAD_HALF - HW - 0.25, LAT_SOFT = ROAD_HALF + 0.55 - HW, SCAN = 45;
}

void Ambulance::load(AssetManager& assets, const nlohmann::json& j) {
  ModelLoadOptions o;
  o.maxTextureSize = 1024;
  model_ = assets.model("ambulance", o);
  if (!model_) return;
  // (assets.js fitModel as the game made it: the Meshy van is modelled along x, turned so the cab leads toward +z)
  if (j.contains("fit") && j["fit"].size() == 16) { float m[16]; for (size_t i = 0; i < 16; i++) m[i] = j["fit"][i].get<float>(); fit_ = glm::make_mat4(m); }
  else fit_ = model_->fitTransform(float(LEN), 2);
  if (j.contains("size") && j["size"].size() == 3) size_ = vec3(j["size"][0].get<float>(), j["size"][1].get<float>(), j["size"][2].get<float>());
  for (auto& l : j["lights"]) lights_.push_back({vec3(l["p"][0].get<float>(), l["p"][1].get<float>(), l["p"][2].get<float>()), l.value("red", false)});
  parkX_ = j["park"].value("x", 0.0); parkZ_ = j["park"].value("z", 0.0); parkYaw_ = j["park"].value("yaw", 0.0);
  for (auto& p : j["path"]) route_.push_back(dvec2(p[0].get<double>(), p[1].get<double>()));
  if (j.contains("goal")) { goal = dvec2(j["goal"].value("x", 0.0), j["goal"].value("z", 0.0)); }
}

void Ambulance::park(double px, double pz, double pyaw) {
  if (!ok()) return;
  x = px; z = pz; yaw = pyaw; s_ = 0; v = 0; t_ = 0; vx = vz = 0;
  hasPath_ = false; hasGoal = false; arrived = false;
  lat_ = latT_ = q_ = wait_ = scanT_ = 0; obs_.clear();
  rider = false;
  place();
  visible = true;
  lightK_[0] = lightK_[1] = 0.15;
}

// the way out: the exported path (from where it waits beside the pad to the drop-off by the medical centre's door)
void Ambulance::plan() {
  pts_.clear();
  pts_.push_back(dvec2(x, z));
  for (size_t i = 1; i < route_.size(); i++) if (glm::length(route_[i] - pts_.back()) > 0.3) pts_.push_back(route_[i]);
  if (pts_.size() < 2) pts_.push_back(pts_[0] + dvec2(std::sin(yaw), std::cos(yaw)) * 8.0);
  size_t n = pts_.size();
  S_.assign(n, 0); TX_.assign(n, 0); TZ_.assign(n, 1);
  for (size_t k = 0; k < n; k++) {
    if (k) S_[k] = S_[k - 1] + glm::length(pts_[k] - pts_[k - 1]);
    size_t j = std::min(n - 1, k + 1), i = j - 1;
    double l = glm::length(pts_[j] - pts_[i]);
    if (l < 1e-9) l = 1;
    TX_[k] = (pts_[j].x - pts_[i].x) / l; TZ_[k] = (pts_[j].y - pts_[i].y) / l;
  }
  length_ = S_[n - 1];
  goal = pts_[n - 1]; hasGoal = true;
  hasPath_ = true;
  s_ = 0; iSeg_ = 0; lat_ = latT_ = q_ = wait_ = scanT_ = 0; obs_.clear();
}

// a point on the path at arc length s (the heading tx, tz; past either end: straight on)
Ambulance::At Ambulance::at(double s) const {
  int n = int(pts_.size());
  int i = std::clamp(iSeg_, 0, n - 2);
  while (i < n - 2 && S_[size_t(i) + 1] < s) i++;
  while (i > 0 && S_[size_t(i)] > s) i--;
  double tx = TX_[size_t(i)], tz = TZ_[size_t(i)];
  return {pts_[size_t(i)].x + tx * (s - S_[size_t(i)]), pts_[size_t(i)].y + tz * (s - S_[size_t(i)]), tx, tz, i};
}

// what is around it (every 0.1 s): boxes within SCAN m, each laid on the path ahead: s (along), lat (across, + to the
// left), across / along (half extents)
void Ambulance::scan() {
  obs_.clear();
  if (!c_.scenery) return;
  int n = int(pts_.size());
  for (const Collider& c : c_.scenery->dynamic) {
    if (!(std::fabs(c.x - x) < SCAN && std::fabs(c.z - z) < SCAN)) continue;
    if (std::hypot(c.x - x, c.z - z) < 0.6) continue;   // (itself)
    double axx = 1, axz = 0, hw, hd;
    if (c.r >= 0) { hw = hd = c.r; }
    else { axx = std::cos(c.rot); axz = std::sin(c.rot); hw = c.hw > 0 ? c.hw : 0.3; hd = c.hd > 0 ? c.hd : 0.3; }
    double bd = 1e18, bs = 0, bl = 0; int bi = 0;
    int i0 = std::max(0, iSeg_ - 2);
    for (int i = i0; i < n - 1 && S_[size_t(i)] < s_ + 55; i++) {
      double ax = pts_[size_t(i)].x, az = pts_[size_t(i)].y, tx = TX_[size_t(i)], tz = TZ_[size_t(i)], L = S_[size_t(i) + 1] - S_[size_t(i)];
      double t = (c.x - ax) * tx + (c.z - az) * tz;
      if (i < n - 2) t = std::min(t, L);   // (past the last point: straight on)
      if (i > i0) t = std::max(t, 0.0);    // (behind the first one looked at: behind the van, not beside it)
      double lx = ax + tx * t, lz = az + tz * t, dd = std::hypot(c.x - lx, c.z - lz);
      if (dd < bd) { bd = dd; bs = S_[size_t(i)] + t; bl = (c.x - lx) * -tz + (c.z - lz) * tx; bi = i; }
    }
    if (bd > ROAD_HALF + 9) continue;
    double tx = TX_[size_t(bi)], tz = TZ_[size_t(bi)], nx = -tz, nz = tx, azx = -axz, azz = axx;
    Obs b;
    b.s = bs; b.lat = bl; b.person = c.r >= 0 && c.r < 0.6;
    b.across = hw * std::fabs(axx * nx + axz * nz) + hd * std::fabs(azx * nx + azz * nz);
    b.along = hw * std::fabs(axx * tx + axz * tz) + hd * std::fabs(azx * tx + azz * tz);
    b.vAlong = 0;
    obs_.push_back(b);
  }
}

/// Drive on toward the medical centre (dt already sped up with SPACE); stops at the end of the way, `arrived`.
void Ambulance::drive(double dt) {
  if (!ok()) return;
  if (!hasPath_) plan();
  if (!(dt > 0)) return;
  t_ += dt;
  const double s = s_, left = length_ - s, v0 = v;
  if ((scanT_ -= dt) <= 0) { scanT_ = 0.1; scan(); }
  // the line it may take: across the road (onto the shoulder only when it must), easing in to the middle over the last
  // ~14 m (the drop-off box at the door); squeezing past (closer, further out) after waiting a while
  const double squeeze = wait_ > 3 ? 1 : 0, taper = clamp((left - 2) / 12, 0.0, 1.0);
  const double hard = LAT_HARD * taper, soft = (LAT_SOFT + squeeze * 0.5) * taper;
  const double look = std::min(left + 1, 10 + v0 * 1.8), gapM = squeeze > 0 ? 0.15 : 0.45;
  // the free line nearest where it is (then nearer the middle), from the edges of what is in the way
  std::vector<double> cand = {0, latT_, lat_, -hard, hard, -soft, soft};
  for (const Obs& o : obs_) {
    if (o.s + o.along < s - LEN / 2 - 0.5 || o.s - o.along > s + look) continue;
    double pad = HW + o.across + gapM + (o.person ? 0.35 : 0);
    cand.push_back(o.lat - pad - 0.05); cand.push_back(o.lat + pad + 0.05);
  }
  bool free = false;
  double best = 0, bc = 1e18;
  for (double c0 : cand) {
    double c = clamp(c0, -soft, soft);
    bool okc = true;
    for (const Obs& o : obs_) {
      if (o.s + o.along < s - LEN / 2 - 0.5 || o.s - o.along > s + look) continue;
      if (std::fabs(c - o.lat) < HW + o.across + gapM + (o.person ? 0.35 : 0)) { okc = false; break; }
    }
    if (!okc) continue;
    double cost = std::fabs(c - lat_) + std::fabs(c) * 0.5 + std::fabs(c - latT_) * 0.3 + (std::fabs(c) > hard + 0.01 ? 1.5 + std::fabs(c) : 0);
    if (cost < bc) { bc = cost; best = c; free = true; }
  }
  latT_ = free ? best : clamp(latT_, -soft, soft);
  // steering onto it: a heading off the road's (q, tan of the angle) that turns only as it drives, straightened out in
  // time to arrive on the line (a smooth S, never crabbing)
  const double err = latT_ - lat_, qMax = v0 < 6 ? 0.36 : 0.22;
  const double qDes = clamp(err / std::max(3.5, v0 * 0.85), -qMax, qMax);
  // speed: the road's bends, the door, and whatever it would still run into on the line it is steering for
  double vT = std::min(VMAX, std::sqrt(2 * 3.5 * std::max(0.0, left - 0.5)) + 0.3);
  {
    At a = at(s), b = at(std::min(length_, s + 14));
    double ang = std::acos(clamp(a.tx * b.tx + a.tz * b.tz, -1.0, 1.0));
    if (ang > 0.05) vT = std::min(vT, std::sqrt(3.4 * 14 / ang) + 2);
  }
  const double shift = std::max(4.0, std::fabs(err) / qMax + 3);
  double gapMin = 1e18;
  for (const Obs& o : obs_) {
    if (o.s + o.along < s - LEN / 2 + 0.3 || o.s - o.along > s + look + 6) continue;
    double lp = lat_ + err * clamp((o.s - s) / shift, 0.0, 1.0);   // (where it will be across the road when it gets there)
    if (std::fabs(lp - o.lat) >= HW + o.across + (squeeze > 0 ? 0.1 : 0.3)) continue;
    double gap = o.s - o.along - s - LEN / 2 - (o.person ? 2.5 : 1.8);
    gapMin = std::min(gapMin, gap);
    vT = std::min(vT, gap <= 0 ? std::max(0.0, std::min(o.vAlong, 2.0)) : std::max(0.0, o.vAlong) + std::sqrt(2 * 5 * gap));
  }
  if (free && std::fabs(err) > 0.15 && gapMin > 0.6) vT = std::max(vT, 1.8);   // (creeping round it, never stuck waiting for room to swing out)
  v = clamp(v0 + clamp(vT - v0, -8 * dt, 4.5 * dt), 0.0, VMAX);
  wait_ = v < 0.3 && vT < 0.5 ? wait_ + dt : 0;
  // (something that won't move at the door: it pulls up where it is)
  if (wait_ > 8 && left < 25) { arrived = true; v = 0; }
  const double ds = v * dt;
  q_ += clamp(qDes - q_, -(0.07 * ds + 0.25 * dt), 0.07 * ds + 0.25 * dt);
  if (std::fabs(latT_ - lat_) < 0.02 && std::fabs(qDes) < 0.01) q_ *= std::max(0.0, 1 - dt * 3);
  lat_ = clamp(lat_ + q_ * ds, -soft - 0.3, soft + 0.3);
  if (taper < 1) lat_ *= 1 - (1 - taper) * std::min(1.0, dt * 2);   // (into the middle at the door)
  s_ = std::min(length_, s + ds);
  if (length_ - s_ < 0.6) { arrived = true; v = 0; }
  At a = at(s_);
  iSeg_ = a.i;
  const double px = x, pz = z;
  x = a.x - a.tz * lat_; z = a.z + a.tx * lat_;
  vx = (x - px) / dt; vz = (z - pz) / dt;
  double want = std::atan2(a.tx - a.tz * q_, a.tz + a.tx * q_);
  yaw += heli::wrapPi(want - yaw) * std::min(1.0, dt * 6);
  place();
  flash(0, 0);
}

/// The roof lights: blue and red, two quick flashes each, alternating (bright at night, readable by day).
void Ambulance::flash(double dt, double night) {
  if (!ok()) return;
  t_ += dt;
  double ph = std::fmod(t_ * 2.2, 1.0), k = 3.5 + night * 3;
  auto on = [&](int i) { double q = std::fmod(ph + i * 0.5, 1.0); return q < 0.1 || (q > 0.18 && q < 0.28) ? k : 0.15; };
  lightK_[0] = on(0); lightK_[1] = on(1);
}

// on the snow, tilted with it
void Ambulance::place() {
  World& W = *c_.world;
  double fx = std::sin(yaw), fz = std::cos(yaw);
  double f = W.groundHeight(x + fx * 2, z + fz * 2), b = W.groundHeight(x - fx * 2, z - fz * 2);
  double l = W.groundHeight(x + fz * 0.9, z - fx * 0.9), r = W.groundHeight(x - fz * 0.9, z + fx * 0.9);
  y = std::max(std::max(f, b), std::max(l, r)) - 0.03;
  pitch_ = std::atan2(b - f, 4.0); roll_ = std::atan2(l - r, 1.8);
}

void Ambulance::draw(Renderer& r, const dvec3& cam) const {
  if (!ok() || !visible) return;
  dvec3 p(x, y, z);
  if (glm::length(p - cam) > 1500) return;
  // THREE.Euler(pitch, yaw, roll, 'YXZ')
  mat4 R = glm::rotate(mat4(1), float(yaw), vec3(0, 1, 0)) * glm::rotate(mat4(1), float(pitch_), vec3(1, 0, 0)) * glm::rotate(mat4(1), float(roll_), vec3(0, 0, 1));
  r.submitModel(*model_, p, R * fit_, nullptr, true);
  // the flashing light-bar segments on the roof: blue on the left, red on the right
  if (c_.shapes) for (const Light& L : lights_) {
    double k = lightK_[L.red ? 1 : 0];
    vec4 col = L.red ? vec4(1.0f, 0.023f, 0.01f, 1) : vec4(0.028f, 0.147f, 1.0f, 1);
    mat4 M = R * glm::translate(mat4(1), L.p - vec3(0, 0.065f, 0)) * glm::scale(mat4(1), vec3(0.42f, 0.13f, 0.2f));
    c_.shapes->oriented(r, Shapes::Kind::Box, p, M, col, float(k > 1 ? k * 2.2 : 0.15), false);
  }
}

void Ambulance::fillColliders(std::vector<Collider>& out) const {
  if (!ok() || !visible || rider) return;
  Collider c;
  c.x = x; c.z = z; c.hw = HW - 0.05; c.hd = LEN / 2; c.rot = -yaw; c.top = y + 2.7;
  out.push_back(c);
}

} // namespace sl
