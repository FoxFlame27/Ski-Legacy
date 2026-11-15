#include "game/breakfx.h"
#include "engine/audio.h"
#include "engine/renderer.h"
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

// breakables.js knock: off the bumper, a kick up, a tumble
void BreakFx::launch(Piece& e, double vx, double vz, bool lamp) {
  const double sp = std::hypot(vx, vz), k = std::min(1.0, 16 / std::max(sp, 1e-3)) * 1.05;   // (never faster than ~17 m/s)
  e.p = e.P0;
  if (lamp) e.v = dvec3(vx * k * 0.7 + (rnd() - 0.5), std::min(3.2, 1 + sp * 0.07), vz * k * 0.7 + (rnd() - 0.5));   // (a heavy cast-iron post)
  else e.v = dvec3(vx * k + (rnd() - 0.5) * 1.5, std::min(7.0, 2 + sp * 0.3), vz * k + (rnd() - 0.5) * 1.5);
  dvec3 a(vz, 0, -vx);
  a = glm::length(a) > 1e-6 ? glm::normalize(a) : dvec3(1, 0, 0);
  e.w = a * ((4 + rnd() * 5) * (lamp ? 0.5 : 1));
  e.w.y += (rnd() - 0.5) * (lamp ? 1.5 : 4);
  e.q = glm::dquat(1, 0, 0, 0);
}

void BreakFx::knockCollider(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam) {
  const auto& cols = scenery_.colliders();
  if (idx < 0 || size_t(idx) >= cols.size()) return;
  const Collider& c = cols[size_t(idx)];
  if (pieces_.size() >= MAX_DOWN) { restore(pieces_.front()); pieces_.pop_front(); }
  Piece e;
  Resort::KnockedProp kp;
  const double size = c.r >= 0 ? c.r : std::max(c.hw, c.hd);
  e.prop = resort_.knockProp(c.x, c.z, std::max(0.9, size + 0.6), 3.5, kp);
  e.col = idx;
  e.standAt = now + RESPAWN;
  if (e.prop >= 0 && kp.model) {
    e.model = kp.model; e.M0 = kp.M;
    // its height from the model's box in the world (a pole 1.5 m, a lamp 3.6 m)
    const vec3 lo = kp.model->bmin, hi = kp.model->bmax;
    double y0 = 1e30, y1 = -1e30;
    for (int q = 0; q < 8; q++) {
      const glm::dvec4 w = kp.M * glm::dvec4((q & 1) ? hi.x : lo.x, (q & 2) ? hi.y : lo.y, (q & 4) ? hi.z : lo.z, 1);
      y0 = std::min(y0, w.y); y1 = std::max(y1, w.y);
    }
    e.h = std::max(0.3, y1 - y0);
    e.P0 = dvec3(kp.M[3][0], (y0 + y1) / 2, kp.M[3][2]);
  } else {
    e.h = c.lamp ? 3.6 : 1.5;
    e.P0 = dvec3(c.x, world_.meshHeight(c.x, c.z) + e.h / 2, c.z);
  }
  launch(e, vx, vz, c.lamp);
  if (audio) {
    // (the clack, quieter far from the camera; a street lamp: its lantern's glass shattering just after)
    const double d = std::hypot(cam.x - c.x, cam.z - c.z), sp = std::hypot(vx, vz);
    const float amt = float(0.5 * std::min(1.0, 0.35 + sp / 25) * std::max(0.0, 1 - d / 80));
    if (amt > 0.03f) {
      audio->impact("metal", amt, &e.P0);
      if (c.lamp) { Audio::Shot s; s.vol = 0.3f + 0.5f * amt; s.rate = float(1.1 + rnd() * 0.2); audio->shot("glass", s); }
    }
  }
  pieces_.push_back(std::move(e));
}

void BreakFx::breakRail(int idx, double vx, double vz, double now, Audio* audio, const dvec3& cam) {
  if (idx < 0 || size_t(idx) >= t_.rails.size()) return;
  const Guardrail& g = t_.rails[size_t(idx)];
  for (const Piece& o : pieces_) if (o.rail == idx) return;
  if (pieces_.size() >= MAX_DOWN) { restore(pieces_.front()); pieces_.pop_front(); }
  Piece e;
  e.rail = idx;
  e.standAt = g.offUntil > now ? g.offUntil : now + RESPAWN;
  dvec3 o(0);
  if (g.seg >= 0) e.model = rails_.sectionModel(t_, g.seg, o);
  if (!e.model) return;
  e.M0 = glm::translate(glm::dmat4(1), o);
  e.P0 = o + dvec3(0, 0.5, 0);
  e.h = 1.0;
  // (breakables.js breakRail: the car's velocity x 0.7 and a little scatter)
  launch(e, vx * 0.7 + (rnd() - 0.5) * 2, vz * 0.7 + (rnd() - 0.5) * 2, false);
  if (audio) {
    const double d = std::hypot(cam.x - o.x, cam.z - o.z);
    const float amt = float(std::min(1.0, 0.35 + std::hypot(vx, vz) / 25) * std::max(0.0, 1 - d / 80));
    if (amt > 0.03f) audio->impact("metal", amt, &e.P0);
  }
  pieces_.push_back(std::move(e));
}

void BreakFx::restore(Piece& e) {
  if (e.prop >= 0) resort_.standProp(e.prop);
  e.prop = -1;
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
      const dvec3 at = e.rail >= 0 ? e.P0 : dvec3(e.M0[3]);
      const dvec3 d = at - cam.pos;
      const double dist = glm::length(d);
      const bool seen = dist < NEAR || (dist < 300 && glm::dot(glm::normalize(d), dvec3(fwd)) > 0.55);
      if (!seen || now >= e.standAt + GROW_AFTER) { restore(e); pieces_.erase(pieces_.begin() + std::ptrdiff_t(i)); continue; }
      if (e.col >= 0) scenery_.colliders()[size_t(e.col)].downUntil = now + 1;
      if (e.rail >= 0) t_.rails[size_t(e.rail)].offUntil = now + 1;
    }
    i++;
    if (e.rest >= 2) continue;
    // breakables.js fly: gravity, the tumble, a bounce off the snow (its lower end); then turned flat, settling
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
}

void BreakFx::submit(Renderer& r) const {
  for (const Piece& e : pieces_) {
    if (!e.model) continue;
    const dvec3 ext(e.h + 1);
    const bool vis = r.visible(e.p - ext, e.p + ext);
    // world = T(p) R(q) T(-P0) M0: camera-relative round p
    const glm::dmat4 L = glm::mat4_cast(e.q) * glm::translate(glm::dmat4(1), -e.P0) * e.M0;
    r.submitModel(*e.model, e.p, mat4(L), nullptr, true, 0, vis);
  }
}

} // namespace sl
