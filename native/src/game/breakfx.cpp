#include "game/breakfx.h"
#include "engine/audio.h"
#include "engine/renderer.h"
#include "game/traffic.h"
#include "world/rail_sweep.h"
#include "world/scenery.h"
#include "world/transport.h"
#include "world/world.h"

#include <glm/gtc/quaternion.hpp>
#include <cmath>

namespace sl {

namespace {
constexpr double RESPAWN = 90, GROW_AFTER = 120, NEAR = 25, GRAVITY = 9.81;
constexpr size_t MAX_DOWN = 30;
}

double BreakFx::rnd() { seed_ ^= seed_ << 13; seed_ ^= seed_ >> 17; seed_ ^= seed_ << 5; return (seed_ & 0xffffff) / double(0x1000000); }

int BreakFx::flying() const { int n = 0; for (const Piece& e : pieces_) n += e.rest < 2; return n; }

// breakables.js knock: off the bumper, a kick up, a tumble (fv: the flight given, another player's knock)
void BreakFx::launch(Piece& e, double vx, double vz, bool lamp, const dvec3* fv) {
  const double sp = std::hypot(vx, vz), k = std::min(1.0, 16 / std::max(sp, 1e-3)) * 1.05;   // (never faster than ~17 m/s)
  e.p = e.P0;
  if (fv) { e.v = *fv; vx = fv->x; vz = fv->z; }
  else if (lamp) e.v = dvec3(vx * k * 0.7 + (rnd() - 0.5), std::min(3.2, 1 + sp * 0.07), vz * k * 0.7 + (rnd() - 0.5));   // (a heavy cast-iron post)
  else e.v = dvec3(vx * k + (rnd() - 0.5) * 1.5, std::min(7.0, 2 + sp * 0.3), vz * k + (rnd() - 0.5) * 1.5);
  dvec3 a(vz, 0, -vx);
  a = glm::length(a) > 1e-6 ? glm::normalize(a) : dvec3(1, 0, 0);
  e.w = a * ((4 + rnd() * 5) * (lamp ? 0.5 : 1));
  e.w.y += (rnd() - 0.5) * (lamp ? 1.5 : 4);
  e.q = glm::dquat(1, 0, 0, 0);
}

namespace {
// (breakables.js spotId: x, z rounded to 10 cm, the same on every client)
std::string spotId(double x, double z) { return std::to_string(int64_t(std::llround(x * 10))) + "," + std::to_string(int64_t(std::llround(z * 10))); }
}

std::string BreakFx::poleId(int col) const {
  const Resort::BreakParts* bp = resort_.breakParts(col);
  if (bp && !bp->nid.empty()) return bp->nid;
  const Collider& c = scenery_.colliders()[size_t(col)];
  return spotId(c.x, c.z);
}

std::string BreakFx::railId(int ri) const {
  const Guardrail& g = t_.rails[size_t(ri)];
  return spotId((g.ax + g.bx) / 2, (g.az + g.bz) / 2);
}

// (breakables.js emit) your knock to the server, at most 10 a second (the rest stay yours alone)
void BreakFx::emit(const Piece& e, double now) {
  if (!net || quiet_) return;
  netTok_ = std::min(10.0, netTok_ + (now - netT_) * 10); netT_ = now;
  if (netTok_ < 1) return;
  netTok_ -= 1;
  const auto r = [](double v) { return std::round(v * 100) / 100; };
  outbox.push_back({e.rail >= 0 ? "rail" : "pole", e.rail >= 0 ? railId(e.rail) : poleId(e.col), dvec3(r(e.v.x), r(e.v.y), r(e.v.z))});
}

void BreakFx::knockCollider(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam) { knock(idx, vx, vz, now, audio, cam, nullptr); }

bool BreakFx::knock(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam, const dvec3* fv) {
  const auto& cols = scenery_.colliders();
  if (idx < 0 || size_t(idx) >= cols.size()) return false;
  for (const Piece& o : pieces_) if (o.col == idx) return false;
  const Collider& c = cols[size_t(idx)];
  if (pieces_.size() >= MAX_DOWN) { restore(pieces_.front()); pieces_.pop_front(); }
  Piece e;
  // its drawn parts hidden where they stood: its own instances (a sign's post and panels, a pole and its tip), a GLB
  // part found at the collider (a lamp post, a bus stop sign: the placed prop there)
  std::vector<Resort::KnockedProp> kps;
  const Resort::BreakParts* bp = resort_.breakParts(idx);
  if (bp) resort_.hideParts(*bp, kps);
  if (!bp || bp->prop) {
    Resort::KnockedProp kp;
    const double size = c.r >= 0 ? c.r : std::max(c.hw, c.hd);
    if (resort_.knockProp(c.x, c.z, std::max(0.9, size + 0.6), 3.5, kp) >= 0 && kp.model) kps.push_back(std::move(kp));
  }
  e.col = idx;
  e.standAt = now + RESPAWN;
  double y0 = 1e30, y1 = -1e30;
  for (const Resort::KnockedProp& kp : kps) {
    e.props.push_back(kp.handle);
    if (!kp.model) continue;
    e.parts.push_back({kp.model, kp.M});
    // its height from the parts' boxes in the world (a pole 1.5 m, a sign 2.5 m, a lamp 3.6 m)
    const vec3 lo = kp.model->bmin, hi = kp.model->bmax;
    for (int q = 0; q < 8; q++) {
      const glm::dvec4 w = kp.M * glm::dvec4((q & 1) ? hi.x : lo.x, (q & 2) ? hi.y : lo.y, (q & 4) ? hi.z : lo.z, 1);
      y0 = std::min(y0, w.y); y1 = std::max(y1, w.y);
    }
  }
  if (y1 > y0) {
    e.h = std::max(0.3, y1 - y0);
    e.P0 = dvec3(c.x, (y0 + y1) / 2, c.z);
  } else {
    e.h = c.lamp ? 3.6 : 1.5;
    e.P0 = dvec3(c.x, world_.meshHeight(c.x, c.z) + e.h / 2, c.z);
  }
  launch(e, vx, vz, c.lamp, fv);
  if (audio) {
    // (the clack, quieter far from the camera; a street lamp: its lantern's glass shattering just after)
    const double d = std::hypot(cam.x - c.x, cam.z - c.z), sp = std::hypot(vx, vz);
    const float amt = float(0.5 * std::min(1.0, 0.35 + sp / 25) * std::max(0.0, 1 - d / 80));
    if (amt > 0.03f) {
      audio->impact("metal", amt, &e.P0);
      if (c.lamp) { Audio::Shot s; s.vol = 0.3f + 0.5f * amt; s.rate = float(1.1 + rnd() * 0.2); audio->shot("glass", s); }
    }
  }
  emit(e, now);
  pieces_.push_back(std::move(e));
  return true;
}

void BreakFx::breakRail(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam) { rail(idx, vx, vz, now, audio, cam, nullptr); }

bool BreakFx::rail(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam, const dvec3* fv) {
  if (idx < 0 || size_t(idx) >= t_.rails.size()) return false;
  const Guardrail& g = t_.rails[size_t(idx)];
  for (const Piece& o : pieces_) if (o.rail == idx) return false;
  dvec3 o(0);
  std::shared_ptr<Model> m;
  if (g.seg >= 0) m = rails_.sectionModel(t_, g.seg, o);
  if (!m) return false;
  if (pieces_.size() >= MAX_DOWN) { restore(pieces_.front()); pieces_.pop_front(); }
  Piece e;
  e.rail = idx;
  e.standAt = g.offUntil > now ? g.offUntil : now + RESPAWN;
  e.parts.push_back({m, glm::translate(glm::dmat4(1), o)});
  e.P0 = o + dvec3(0, 0.5, 0);
  e.h = 1.0;
  // (breakables.js breakRail: the car's velocity x 0.7 and a little scatter)
  launch(e, vx * 0.7 + (rnd() - 0.5) * 2, vz * 0.7 + (rnd() - 0.5) * 2, false, fv);
  if (audio) {
    const double d = std::hypot(cam.x - o.x, cam.z - o.z);
    const float amt = float(std::min(1.0, 0.35 + std::hypot(vx, vz) / 25) * std::max(0.0, 1 - d / 80));
    if (amt > 0.03f) audio->impact("metal", amt, &e.P0);
  }
  emit(e, now);
  pieces_.push_back(std::move(e));
  return true;
}

// (breakables.js update: the traffic's cars, both ends of each, 1 m reach; their knocks stay local)
void BreakFx::sweepCars(const std::vector<Mover>& cars, double now, Audio* audio, const dvec3& cam) {
  constexpr double BREAK_V = 8 / 3.6;
  quiet_ = true;
  for (const Mover& m : cars) {
    if (!(std::fabs(m.v) > BREAK_V)) continue;
    const double fx = std::sin(m.yaw), fz = std::cos(m.yaw), vx = fx * m.v, vz = fz * m.v, sp2 = vx * vx + vz * vz;
    for (int end : {1, -1}) {
      const double x = m.x + fx * 1.4 * end, z = m.z + fz * 1.4 * end;
      const auto* near = scenery_.collidersNear(x, z);
      if (!near) continue;
      for (int ci : *near) {
        const Collider& c = scenery_.colliders()[size_t(ci)];
        if (c.brk <= 0 || c.rail || c.downUntil > now || sp2 <= c.brk * c.brk) continue;
        const double reach = 1.0 + (c.r >= 0 ? c.r : std::max(c.hw, c.hd)), dx = c.x - x, dz = c.z - z;
        if (dx * dx + dz * dz >= reach * reach) continue;
        if (knock(ci, vx, vz, now, audio, cam, nullptr)) c.downUntil = now + RESPAWN;
      }
    }
  }
  quiet_ = false;
}

void BreakFx::sweepTraffic(const Traffic& traffic, double now, Audio* audio, const dvec3& cam) {
  static thread_local std::vector<Traffic::CarView> views;
  views.clear();
  traffic.cars(views);
  movers_.clear();
  for (const Traffic::CarView& v : views) movers_.push_back({v.pos.x, v.pos.z, v.yaw, v.v});
  sweepCars(movers_, now, audio, cam);
}

// (breakables.js remote / lookup) another player's knock: the pole at that spot (or its neighbours, a rounding edge)
bool BreakFx::remote(const std::string& k, const std::string& id, const dvec3& v, double age, double now) {
  if (age >= RESPAWN || !std::isfinite(v.x) || !std::isfinite(v.y) || !std::isfinite(v.z)) return false;
  const size_t comma = id.find(',');
  if (comma == std::string::npos) return false;
  int64_t x = 0, z = 0;
  try { x = std::stoll(id.substr(0, comma)); z = std::stoll(id.substr(comma + 1)); } catch (...) { return false; }
  const bool isRail = k == "rail";
  auto& map = isRail ? railIds_ : poleIds_;
  if (map.empty()) {
    if (isRail) { for (size_t i = 0; i < t_.rails.size(); i++) if (t_.rails[i].seg >= 0) map.emplace(railId(int(i)), int(i)); }
    else for (size_t i = 0; i < scenery_.colliders().size(); i++) if (scenery_.colliders()[i].brk > 0) map.emplace(poleId(int(i)), int(i));
  }
  int hit = -1;
  for (int q = 0; q < 9 && hit < 0; q++) {
    const int dx = q == 0 ? 0 : (q - 1) % 3 - 1, dz = q == 0 ? 0 : (q - 1) / 3 - 1;
    auto it = map.find(std::to_string(x + dx) + "," + std::to_string(z + dz));
    if (it != map.end()) hit = it->second;
  }
  if (hit < 0) return false;
  const double t0 = now - age;
  quiet_ = true;
  bool ok = false;
  if (isRail) {
    Guardrail& g = t_.rails[size_t(hit)];
    if (g.offUntil <= now) { g.offUntil = t0 + RESPAWN; ok = rail(hit, v.x, v.z, t0, nullptr, dvec3(1e9), &v); if (!ok) g.offUntil = -1; }
  } else {
    const Collider& c = scenery_.colliders()[size_t(hit)];
    if (c.downUntil <= now) { c.downUntil = t0 + RESPAWN; ok = knock(hit, v.x, v.z, t0, nullptr, dvec3(1e9), &v); if (!ok) c.downUntil = -1; }
  }
  quiet_ = false;
  if (ok && age > 0) {   // (knocked a while ago: where it flew to by now)
    Piece& e = pieces_.back();
    for (double t = 0; t < std::min(age, 8.0) && e.rest < 2; t += 1.0 / 30) { e.t = t; fly(e, 1.0 / 30); }
    e.t = age;
  }
  return ok;
}

void BreakFx::restore(Piece& e) {
  for (int64_t h : e.props) resort_.standProp(h);
  e.props.clear();
  if (e.col >= 0 && size_t(e.col) < scenery_.colliders().size()) scenery_.colliders()[size_t(e.col)].downUntil = -1;
  if (e.rail >= 0 && size_t(e.rail) < t_.rails.size()) t_.rails[size_t(e.rail)].offUntil = -1;
}

void BreakFx::update(double dt, double now, const Camera& cam) {
  const vec3 fwd = cam.forward();
  for (size_t i = 0; i < pieces_.size();) {
    Piece& e = pieces_[i];
    e.t += dt;
    // back after 90 s once you are 25 m away or not looking that way (or 2 minutes later anyway); its collider / the
    // guardrail line stays down until then (drive.cpp's own 90 s are held off while it waits)
    if (now >= e.standAt) {
      const dvec3 at = e.P0;
      const dvec3 d = at - cam.pos;
      const double dist = glm::length(d);
      const bool seen = dist < NEAR || (dist < 300 && glm::dot(glm::normalize(d), dvec3(fwd)) > 0.55);
      if (!seen || now >= e.standAt + GROW_AFTER) { restore(e); pieces_.erase(pieces_.begin() + std::ptrdiff_t(i)); continue; }
      if (e.col >= 0) scenery_.colliders()[size_t(e.col)].downUntil = now + 1;
      if (e.rail >= 0) t_.rails[size_t(e.rail)].offUntil = now + 1;
    }
    i++;
    if (e.rest < 2) fly(e, dt);
  }
}

// breakables.js fly: one step of the flight / settling
void BreakFx::fly(Piece& e, double dt) {
  // (gravity, the tumble, a bounce off the snow (its lower end); then turned flat, settling)
  const dvec3 up = e.q * dvec3(0, 1, 0);
  if (e.rest == 0) {
    e.v.y -= GRAVITY * dt;
    e.p += e.v * dt;
    const double wl = glm::length(e.w);
    if (wl > 1e-4) e.q = glm::angleAxis(wl * dt, e.w / wl) * e.q;
    const double gy = world_.meshHeight(e.p.x, e.p.z), low = e.p.y - std::fabs(up.y) * e.h * 0.5 - 0.04;
    if (low < gy) {
      e.p.y += gy - low;
      if (e.v.y < 0) {
        e.bounces++;
        e.v.y = -e.v.y * 0.35; e.v.x *= 0.55; e.v.z *= 0.55; e.w *= 0.45;
        if (e.bounces >= 3 || e.v.y < 1.0) e.rest = 1;
      }
    }
    if (e.t > 6) e.rest = 1;
    if (e.rest == 1) {   // lay it down: its long axis turned flat (keeping its roll)
      dvec3 h(up.x, 0, up.z);
      if (glm::dot(h, h) < 1e-4) h = dvec3(e.v.x != 0 ? e.v.x : 1, 0, e.v.z);
      h = glm::normalize(h);
      const dvec3 u = glm::normalize(up), ax = glm::cross(u, h);
      const double sa = glm::length(ax), ang = std::atan2(sa, glm::dot(u, h));
      e.qT = (sa > 1e-6 ? glm::angleAxis(ang, ax / sa) : glm::dquat(1, 0, 0, 0)) * e.q;
    }
  } else {
    const double f = std::min(1.0, dt * 6);
    e.v.x *= 1 - f * 0.6; e.v.z *= 1 - f * 0.6;
    e.p.x += e.v.x * dt; e.p.z += e.v.z * dt;
    e.q = glm::slerp(e.q, e.qT, f);
    // (lying: its middle a little over the snow, half its thickness; the guardrail's beam on its side)
    const double gy = world_.meshHeight(e.p.x, e.p.z) + 0.05 + (e.rail >= 0 ? 0.15 : 0.08);
    e.p.y += (gy - e.p.y) * f;
    if (std::fabs(glm::dot(e.q, e.qT)) > 0.99995 && std::fabs(gy - e.p.y) < 0.01) { e.q = e.qT; e.p.y = gy; e.rest = 2; }
  }
}

void BreakFx::submit(Renderer& r) const {
  for (const Piece& e : pieces_) {
    if (e.parts.empty()) continue;
    const dvec3 ext(e.h + 1);
    const bool vis = r.visible(e.p - ext, e.p + ext);
    // world = T(p) R(q) T(-P0) M0, each part: camera-relative round p
    const glm::dmat4 R = glm::mat4_cast(e.q) * glm::translate(glm::dmat4(1), -e.P0);
    for (const Part& q : e.parts) r.submitModel(*q.model, e.p, mat4(R * q.M0), nullptr, true, 0, vis);
  }
}

} // namespace sl
