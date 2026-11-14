// Inside a chalet as the web game builds it (src/game/chaletroom.js ChaletRoom, exported by export_rooms.mjs): the
// house with both floors, walked as chaletroom.js walks it: the wall segments of the floor you are on, the fixtures,
// the stair between the floors (a floor of its own while you are on it), the stairwell's rail upstairs, the roof's
// slope along the long sides, the hinged doors (E or walking into one opens it away from you, its leaf solid wherever
// it stands; the front door leads out), the built-in lamps' warm pools of light round you, the fill by the hour.
#include "engine/mesh_kit.h"
#include "game/interiors.h"
#include "game/play_data.h"
#include "player/player.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr float CH_AMBIENT = 0.72f, CH_LAMP = 2.6f;   // the web room's fill / lamp pool in the renderer's units
Collider segCollider(const dvec3& o, double ax, double az, double bx, double bz, double half) {
  Collider c;
  const double dx = bx - ax, dz = bz - az;
  c.x = o.x + (ax + bx) / 2; c.z = o.z + (az + bz) / 2;
  c.hw = half; c.hd = std::hypot(dx, dz) / 2; c.rot = -std::atan2(dx, dz);
  return c;
}
Collider rectCollider(const dvec3& o, double x0, double x1, double z0, double z1) {
  Collider c;
  c.x = o.x + (x0 + x1) / 2; c.z = o.z + (z0 + z1) / 2; c.hw = (x1 - x0) / 2; c.hd = (z1 - z0) / 2; c.rot = 0;
  return c;
}
}

void Interiors::buildChaletExported() {
  const ChaletRoomDef& d = c_.data->chaletRoom;
  ch_ = &d;
  halfX = vec2(float(d.IX)); halfZ = vec2(float(d.IZ));
  ceiling = d.GC - d.G;
  mesh_ = c_.roomModel("chalet");
  chDoors_.assign(d.doors.size(), DoorSt{});
  for (size_t i = 0; i < d.doors.size(); i++) chDoors_[i].model = c_.roomModel(d.doors[i].key);
  chLevel_ = 0;
  // chaletroom.js enter(): in the hall just inside the front door, facing in; every inner door shut
  spawnLocal = dvec3(d.doorX - d.doorNx * 0.5, 0, d.doorZ);
  spawnYaw = std::atan2(-d.doorNx, -d.doorNz);
  exitLocal = dvec3(d.doorX + d.doorNx * 0.3, 0, d.doorZ);
  chPrev_ = spawnLocal;
  chEye_ = floorY_ + d.eye;
  lightTint = vec3(1.0f, 0.84f, 0.62f);
}

double Interiors::chaletDeck(double, double lz) const {
  const ChaletRoomDef& d = *ch_;
  if (chLevel_ == 2) return floorY_ + d.FL - d.G;
  if (chLevel_ == 1) return floorY_ + d.rise * clamp(std::ceil((lz - d.stair[2]) / d.run - 1e-6), 0.0, double(d.steps));   // (chaletplan.js stairY)
  return floorY_;
}

void Interiors::chaletStep(double dt) {
  if (!ch_) return;
  const ChaletRoomDef& d = *ch_;
  Player& pl = *c_.player;
  const dvec3 p = toLocal(pl.pos), q = chPrev_;
  const double* S = d.stair; const double* H = d.hole;
  // chaletroom.js walk(): the floor you are on
  if (chLevel_ == 0 && q.z <= S[2] && p.z > S[2] && p.x > S[0] + 0.05 && p.x < S[1] - 0.05) chLevel_ = 1;
  if (chLevel_ == 1) { if (p.z < S[2]) chLevel_ = 0; else if (p.z > S[3]) chLevel_ = 2; }
  else if (chLevel_ == 2 && q.z >= H[3] && p.z < H[3] && p.x > H[0] + 0.05 && p.x < H[1] - 0.05) chLevel_ = 1;
  chPrev_ = p;
  chEye_ += (pl.renderPos.y + d.eye - chEye_) * (1 - std::exp(-dt * 14));
  // the doors swing (2.6 rad/s); walking into a shut one opens it away from you (not the front door)
  const dvec3 v = pl.vel;
  for (size_t i = 0; i < d.doors.size(); i++) {
    const ChaletRoomDef::Door& D = d.doors[i];
    DoorSt& st = chDoors_[i];
    if (chLevel_ != 1 && !D.front && D.up == (chLevel_ == 2) && std::fabs(st.target) < 0.01 && std::fabs(st.angle) < 0.05 && v.x * v.x + v.z * v.z > 0.3) {
      const double ex = D.ux * (D.w - 0.04), ez = D.uz * (D.w - 0.04), l2 = ex * ex + ez * ez;
      const double t = clamp(((p.x - D.hx) * ex + (p.z - D.hz) * ez) / l2, 0.0, 1.0), dx = p.x - (D.hx + ex * t), dz = p.z - (D.hz + ez * t);
      if (std::hypot(dx, dz) < d.radius + 0.14 && t > 0.15 && t < 0.85 && v.x * dx + v.z * dz < 0) chaletUse(int(i));
    }
    const double dd = st.target - st.angle, step = 2.6 * dt;
    st.angle += std::fabs(dd) < step ? dd : (dd > 0 ? step : -step);
  }
}

// (Door.toggle: open away from you / close; the front door: always into the hall)
void Interiors::chaletUse(int which) {
  if (!ch_ || which < 0 || size_t(which) >= chDoors_.size()) return;
  const ChaletRoomDef::Door& D = ch_->doors[size_t(which)];
  DoorSt& st = chDoors_[size_t(which)];
  if (std::fabs(st.target) > 0.01) { st.target = 0; return; }
  const dvec3 p = toLocal(c_.player->pos);
  const double side = (p.x - D.hx) * D.nx + (p.z - D.hz) * D.nz;
  st.target = D.front ? D.inward : side > 0 ? -1.55 : 1.55;
}

// chaletroom.js update(): a door you look at within 2.5 m, else the nearest doorway you stand in
int Interiors::chaletDoor(const dvec3& eye, const vec3& dir, int& which) const {
  which = -1;
  if (!ch_) return 0;
  const ChaletRoomDef& d = *ch_;
  const dvec3 o = toLocal(eye) + dvec3(0, d.G, 0), dr(dir);   // (the house frame)
  double best = 2.5;
  for (size_t i = 0; i < d.doors.size(); i++) {
    const ChaletRoomDef::Door& D = d.doors[i];
    const double a = chDoors_[i].angle, c = std::cos(a), s = std::sin(a);
    const dvec3 along(D.ux * c + D.nx * s, 0, D.uz * c + D.nz * s), nrm(-along.z, 0, along.x), h(D.hx, D.y0, D.hz);
    const double dn = glm::dot(dr, nrm);
    if (std::fabs(dn) < 1e-6) continue;
    const double t = glm::dot(h - o, nrm) / dn;
    if (t <= 0 || t >= best) continue;
    const dvec3 hit = o + dr * t;
    const double u = glm::dot(hit - h, along);
    if (u < 0 || u > D.w || hit.y < D.y0 || hit.y > D.y0 + D.h) continue;
    best = t; which = int(i);
  }
  if (which < 0 && chLevel_ != 1) {
    const dvec3 p = toLocal(c_.player->pos);
    double bd = 0.9;
    for (size_t i = 0; i < d.doors.size(); i++) {
      const ChaletRoomDef::Door& D = d.doors[i];
      if (D.up != (chLevel_ == 2)) continue;
      const double dd = std::hypot(p.x - (D.hx + D.ux * D.w / 2), p.z - (D.hz + D.uz * D.w / 2)) - (D.front ? 0.5 : 0);
      if (dd < bd) { bd = dd; which = int(i); }
    }
  }
  if (which < 0) return 0;
  if (d.doors[size_t(which)].front) return 1;
  return std::fabs(chDoors_[size_t(which)].target) < 0.01 ? 2 : 3;
}

std::string Interiors::chaletRoomName() const {
  if (!ch_) return "";
  if (chLevel_ == 1) return "Stairs";
  const dvec3 p = toLocal(c_.player->pos);
  for (const ChaletRoomDef::Rm& r : ch_->rooms) {
    if (r.up != (chLevel_ == 2)) continue;
    for (const Rect2& q : r.rects) if (p.x >= q.x0 && p.x <= q.x1 && p.z >= q.z0 && p.z <= q.z1) return r.name;
  }
  return "Chalet";
}

void Interiors::chaletColliders(std::vector<Collider>& out) const {
  const ChaletRoomDef& d = *ch_;
  const dvec3 o(origin_.x, 0, origin_.z);
  const double* S = d.stair; const double* H = d.hole;
  // the house's inner faces
  out.push_back(rectCollider(o, -d.IX - 1, -d.IX, -d.IZ - 1, d.IZ + 1)); out.push_back(rectCollider(o, d.IX, d.IX + 1, -d.IZ - 1, d.IZ + 1));
  out.push_back(rectCollider(o, -d.IX - 1, d.IX + 1, -d.IZ - 1, -d.IZ)); out.push_back(rectCollider(o, -d.IX - 1, d.IX + 1, d.IZ, d.IZ + 1));
  if (chLevel_ == 1) {   // on the stair: between its sides
    out.push_back(rectCollider(o, S[0] - 0.3, S[0], S[2] - 0.4, S[3] + 0.4));
    out.push_back(rectCollider(o, S[1], S[1] + 0.3, S[2] - 0.4, S[3] + 0.4));
    return;
  }
  const int lv = chLevel_ == 2 ? 1 : 0;
  for (const auto& s : d.solid[lv]) out.push_back(segCollider(o, s.ax, s.az, s.bx, s.bz, s.half));
  for (const auto& c : d.round[lv]) { Collider k; k.x = o.x + c.x; k.z = o.z + c.z; k.r = c.r; out.push_back(k); }
  for (const auto& b : d.boxes[lv]) { Collider k; k.x = o.x + b.x; k.z = o.z + b.z; k.hw = b.hw; k.hd = b.hd; k.rot = b.rot; out.push_back(k); }
  for (size_t i = 0; i < d.doors.size(); i++) {
    const ChaletRoomDef::Door& D = d.doors[i];
    if (D.up != (lv == 1)) continue;
    const double a = chDoors_[i].angle, c = std::cos(a), s = std::sin(a);
    out.push_back(segCollider(o, D.hx, D.hz, D.hx + (D.ux * c + D.nx * s) * (D.w - 0.04), D.hz + (D.uz * c + D.nz * s) * (D.w - 0.04), 0.035));
  }
  if (lv == 0) {
    // the stair's sides, its footprint from the side (you step on at its foot)
    for (const auto& s : d.solid[2]) out.push_back(segCollider(o, s.ax, s.az, s.bx, s.bz, s.half));
    out.push_back(rectCollider(o, S[0], S[1], S[2] + 0.36, S[3]));
  } else {
    // the stairwell (you step down at its head), the roof coming down along the long sides outside the dormers
    out.push_back(rectCollider(o, H[0], H[1], H[2], H[3] - 0.36));
    for (int sx = -1; sx <= 1; sx += 2) {
      out.push_back(rectCollider(o, sx > 0 ? 3.0 + 0.28 : -d.IX - 1, sx > 0 ? d.IX + 1 : -3.0 - 0.28, -d.IZ - 1, d.dormerZ0));
      out.push_back(rectCollider(o, sx > 0 ? 3.0 + 0.28 : -d.IX - 1, sx > 0 ? d.IX + 1 : -3.0 - 0.28, d.dormerZ1, d.IZ + 1));
    }
  }
}

void Interiors::chaletDraw(Renderer& r) {
  const ChaletRoomDef& d = *ch_;
  const dvec3 o = toWorld(0, -d.G, 0);   // (the house frame's origin: the ground outside)
  if (mesh_) r.submitModel(*mesh_, o, mat4(1), nullptr, true);
  for (size_t i = 0; i < d.doors.size(); i++) {
    const ChaletRoomDef::Door& D = d.doors[i];
    if (!chDoors_[i].model) continue;
    // (Door.update: pivot.rotation.y = base - angle * k)
    r.submitModel(*chDoors_[i].model, o + dvec3(D.hx, D.y0, D.hz), glm::rotate(mat4(1), float(D.base - chDoors_[i].angle * D.k), vec3(0, 1, 0)), nullptr, true);
  }
  // chaletroom.js tick(): the light pool: six warm lights at the lamps nearest your eyes (the built-in ones and the
  // ones you bought), the ones on the other floor ranked 6 m further
  const dvec3 eye = toLocal(c_.player->renderPos) + dvec3(0, d.G + d.eye, 0);
  const bool up = eye.y > (d.G + d.FL) / 2 + 0.6;
  struct Rank { dvec3 p; double power, dist; };
  std::vector<Rank> all;
  for (const auto& l : d.lamps) all.push_back({dvec3(l.x, l.y, l.z), l.power, std::hypot(l.x - eye.x, (l.y - eye.y) * 1.5, l.z - eye.z) + (l.up == up ? 0 : 6)});
  for (const LampAt& l : furnitureLamps) { const bool lu = l.p.y > (d.G + d.FL) / 2 + 0.6; all.push_back({l.p, l.power, std::hypot(l.p.x - eye.x, (l.p.y - eye.y) * 1.5, l.p.z - eye.z) + (lu == up ? 0 : 6)}); }
  std::sort(all.begin(), all.end(), [](const Rank& a, const Rank& b) { return a.dist < b.dist; });
  const vec3 warm = hexColor("#ffb46b");
  for (size_t i = 0; i < all.size() && i < 6; i++) {
    PointLight q;
    q.pos = o + all[i].p - dvec3(0, 0.08, 0);
    q.color = warm * float(std::min(6.0, 7.5 * all[i].power * (1 - 0.25 * double(day_)))) * CH_LAMP;
    q.range = 7.5f;
    r.addLight(q);
  }
  for (const Prop& p : props) {
    if (!p.model) continue;
    r.submitModel(*p.model, toWorld(p.local.x, p.local.y, p.local.z), glm::rotate(mat4(1), float(p.yaw), vec3(0, 1, 0)) * p.fit, nullptr, true);
  }
}

// chaletroom.js tick(): the fill: cool daylight by day (through the windows), a warm glow at night (never pitch dark)
Lighting Interiors::chaletLighting(const Lighting& outside) const {
  Lighting L = outside;
  const double h = c_.hour;
  const float day = float(clamp((h - 6.5) / 1.5, 0.0, 1.0) * clamp((19 - h) / 1.5, 0.0, 1.0));
  day_ = day;
  const vec3 amb(0.15f + 0.43f * day, 0.13f + 0.49f * day, 0.11f + 0.6f * day);
  L.sunDir = glm::normalize(vec3(0.3f, 0.9f, 0.2f));
  L.sunColor = amb; L.sunIntensity = 0;
  L.sky = amb * CH_AMBIENT; L.ground = amb * CH_AMBIENT * 0.8f;
  L.fogDensity = 0;
  L.night = 1;
  L.interior = true;
  return L;
}

} // namespace sl
