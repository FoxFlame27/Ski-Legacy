#include "game/cardamage.h"
#include "engine/renderer.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace sl {

Dent& addDent(std::vector<Dent>& list, double dirX, double dirZ, double hard, const vec3& size, double seed) {
  const double hw = size.x / 2, hl = size.z / 2, l0 = std::hypot(dirX, dirZ), l = l0 > 0 ? l0 : 1, ux = dirX / l, uz = dirZ / l;
  // (the point on the car's outline in that direction, at bumper / wing height)
  const double s = std::min(hw / std::max(1e-3, std::fabs(ux)), hl / std::max(1e-3, std::fabs(uz)));
  Dent d;
  d.x = float(ux * s); d.y = float(std::min(0.62, double(size.y) * 0.42)); d.z = float(uz * s);
  d.ux = float(ux); d.uz = float(uz);
  d.r = float(0.42 + 0.5 * hard); d.depth = float(0.05 + 0.17 * hard); d.seed = float(seed);
  list.push_back(d);
  if (list.size() > DENTS_MAX) list.erase(list.begin());
  return list.back();
}

nlohmann::json packDents(const std::vector<Dent>& list) {
  auto r2 = [](float v) { return std::round(double(v) * 100) / 100; };
  nlohmann::json a = nlohmann::json::array();
  const size_t from = list.size() > DENTS_MAX ? list.size() - DENTS_MAX : 0;
  for (size_t i = from; i < list.size(); i++) {
    const Dent& D = list[i];
    a.push_back({r2(D.x), r2(D.y), r2(D.z), r2(D.r), r2(D.depth), std::round(double(D.seed) * 10) / 10});
  }
  return a;
}

std::vector<Dent> unpackDents(const nlohmann::json& j) {
  std::vector<Dent> out;
  if (!j.is_array()) return out;
  const size_t from = j.size() > DENTS_MAX ? j.size() - DENTS_MAX : 0;
  for (size_t i = from; i < j.size(); i++) {
    const auto& a = j[i];
    if (!a.is_array() || a.size() < 6) continue;
    double v[6];
    bool ok = true;
    for (size_t k = 0; k < 6; k++) { ok = ok && a[k].is_number(); if (ok) { v[k] = a[k].get<double>(); ok = std::isfinite(v[k]) && std::fabs(v[k]) <= 100; } }
    if (!ok) continue;
    const double l0 = std::hypot(v[0], v[2]), l = l0 > 0 ? l0 : 1;
    Dent d;
    d.x = float(v[0]); d.y = float(v[1]); d.z = float(v[2]); d.ux = float(v[0] / l); d.uz = float(v[2] / l);
    d.r = float(std::clamp(v[3], 0.1, 1.2)); d.depth = float(std::clamp(v[4], 0.0, 0.3)); d.seed = float(v[5]);
    out.push_back(d);
  }
  return out;
}

uint64_t dentSig(const std::vector<Dent>& list) {
  uint64_t h = 1469598103934665603ull ^ list.size();
  for (const Dent& d : list) { uint32_t b; float s = d.seed + d.x * 7 + d.z * 13 + d.depth * 101; std::memcpy(&b, &s, 4); h = (h ^ b) * 1099511628211ull; }
  return list.empty() ? 0 : h;
}

void dentVertex(const Dent& D, vec3& p, vec3& n) {
  const float R = D.r, R2 = R * R;
  const float x = p.x, y = p.y, z = p.z, dx = x - D.x, dy = (y - D.y) * 1.3f, dz = z - D.z, q = dx * dx + dy * dy + dz * dz;
  if (q >= R2) return;
  const float f = 1 - q / R2, w = f * f;   // (a smooth bowl, deepest at the impact)
  // a crumple, not a perfect bowl: a little noise in it
  const float nz = 0.75f + 0.25f * std::sin(x * 23 + D.seed) * std::sin(y * 19 + z * 17 + D.seed * 0.7f);
  static const float X = [] { const char* e = std::getenv("SKI_LEGACY_DENTX"); return e ? float(std::atof(e)) : 1.f; }();   // (debug: exaggerated)
  const float k = D.depth * w * nz * X;
  p = vec3(x - D.ux * k, y - k * 0.25f, z - D.uz * k);
  // the shading of the dent: the normal tipped toward the dent's middle (its slope), more where it is steepest
  const float tip = std::min(0.9f, (D.depth * 4 * f) / R);
  vec3 to(-dx, -dy, -dz);
  const float tl = glm::length(to);
  if (tl > 1e-6f) to /= tl;
  vec3 m = n + to * (tip * std::sqrt(q) / R);
  const float ml = glm::length(m);
  if (ml > 1e-6f) n = m / ml;
}

bool lampSmashed(const Dent& D, const vec3& c, float radius) {
  // (one lamp mesh is both sides of the car: smashed only when the hit is at its end and hard)
  const bool sameEnd = (c.z > 0) == (D.z > 0) && std::fabs(D.z) > 1.2f;
  if (!sameEnd || D.depth < 0.1f) return false;
  return glm::length(c - vec3(D.x, D.y, D.z)) <= D.r + radius;
}
bool lampSmashed(const std::vector<Dent>* list, const vec3& c, float radius) {
  if (!list) return false;
  for (const Dent& D : *list) if (lampSmashed(D, c, radius)) return true;
  return false;
}

// ------------------------------------------------------------------------------------ carlights.js Smoke
void CarSmoke::update(double dt, bool emit, const dvec3& at, const dvec3& cam, const dvec3& fwd, double windX, double windZ) {
  dt = std::min(dt, 0.1);
  if (!(dt > 0)) return;
  t_ += dt;
  // the car's velocity, from how far the bonnet moved (a jump of 5 m+ is a teleport: no trail across it)
  if (emit) {
    bool jump = true;
    if (hasPrev_) {
      const dvec3 d = at - prev_;
      if (glm::dot(d, d) < 25) { const double k = 1 - std::exp(-dt * 10); carV_ += (d / dt - carV_) * k; jump = false; }
    }
    if (jump) { carV_ = dvec3(0); prev_ = at; }
  }
  const bool near = emit && glm::dot(at - cam, at - cam) < 160.0 * 160.0;
  if (near) {
    const double k = rate, inten = std::min(1.0, k / 6), heavy = std::clamp((k - 4) / 2, 0.0, 1.0);
    // more puffs on the move (the same steam spread along the way: a continuous trail, not dots)
    const double sp = std::hypot(carV_.x, carV_.z), more = 1 + std::min(1.5, sp / 8);
    acc_ += dt * (4 + k * 4.4) * more;   // (a wisp: still a steady stream, only fainter)
    accD_ += dt * heavy * 2 * more;
    const int ns = int(std::floor(acc_)), nd = int(std::floor(accD_)), n = ns + nd;
    acc_ -= ns; accD_ -= nd;
    // spread along the way the car moved this frame (a fast car: an even trail, not clumps per frame)
    for (int i = 0; i < n; i++) {
      const double u = double(i + 1) / n, back = (1 - u) * dt;
      spawn(prev_ + (at - prev_) * u, i >= ns, inten, fwd, back, sp);
    }
  }
  if (emit) { prev_ = at; hasPrev_ = true; } else hasPrev_ = false;
  // ---- step: buoyancy, eddies, drag toward the moving air
  const double wx = windX * 0.55, wz = windZ * 0.55, T = t_;
  live_ = 0;
  for (P& q : ps_) {
    if (q.age >= q.life) continue;
    const double age = (q.age += dt);
    if (age >= q.life) continue;
    live_++;
    const double f = age / q.life, ph = q.seed;
    const bool smoke = q.dark > 0.3;
    // buoyancy: hot steam / smoke rises on its heat, which it loses as it mixes with the cold air
    q.v.y += (smoke ? 1.6 * std::exp(-age / 1.4) : 2.0 * std::exp(-age / 0.5)) * dt;
    // eddies: a smooth, slowly changing flow round the puff (stronger as the plume grows and slows)
    const double x = q.p.x, y = q.p.y, z = q.p.z, ta = 0.25 + 0.8 * f;
    const double tx = (std::sin(y * 1.7 + T * 1.3 + ph) + 0.6 * std::sin(z * 1.1 - T * 0.9 + ph * 2.1)) * ta;
    const double ty = (std::sin(x * 1.3 + T * 1.1 + ph * 1.3) + 0.5 * std::sin(z * 2.1 + T * 1.7)) * ta * 0.4;
    const double tz = (std::sin(x * 1.5 - T * 1.2 + ph * 0.7) + 0.6 * std::sin(y * 1.2 + T * 0.8 + ph)) * ta;
    const double kd = 1 - std::exp(-dt * (smoke ? 1.1 : 1.6)), kv = 1 - std::exp(-dt * 1.0);
    q.v.x += (wx + tx - q.v.x) * kd; q.v.y += (ty - q.v.y) * kv; q.v.z += (wz + tz - q.v.z) * kd;
    q.p += q.v * dt;
    if (q.p.y < q.floor) { q.p.y = q.floor; if (q.v.y < 0) q.v.y = 0; }
    q.rot += q.spin * dt; q.spin *= std::exp(-dt * 0.4);
  }
}

void CarSmoke::spawn(const dvec3& at0, bool smoke, double inten, const dvec3& fwd, double back, double sp) {
  int i = -1;
  for (int k = 0; k < MAX; k++) { const int j = (next_ + k) % MAX; if (ps_[j].age >= ps_[j].life) { i = j; break; } }
  if (i < 0) return;   // (the pool is full: never cut a puff off mid-air)
  next_ = (i + 1) % MAX;
  P& q = ps_[i];
  dvec3 at = at0;
  // anywhere along the seams at the back of the bonnet / round the grille
  const double a = (rnd() - 0.5) * 0.9, b = (rnd() - 0.5) * 0.5;
  if (fwd.x != 0 || fwd.z != 0) { at.x += fwd.z * a + fwd.x * b; at.z += -fwd.x * a + fwd.z * b; } else { at.x += a; at.z += b; }
  const dvec3 cv = carV_;
  const double keep = 0.5;   // (the rest of the car's speed: the air over it takes the puff)
  q.p = at;
  if (!smoke) {
    q.v = dvec3(cv.x * keep + (rnd() - 0.5) * 0.6, cv.y * keep + (1.3 + rnd() * 1.3) * (0.6 + 0.4 * inten), cv.z * keep + (rnd() - 0.5) * 0.6);
    q.life = 1.1 + rnd() * 1.0; q.s0 = 0.2 + rnd() * 0.15 + std::min(0.5, sp * 0.03); q.s1 = (1.0 + rnd() * 0.8) * (0.65 + 0.35 * inten);
    q.a0 = (0.62 + rnd() * 0.25) * (0.3 + 0.7 * inten) / (1 + sp * 0.03); q.dark = rnd() * 0.06;
  } else {
    q.v = dvec3(cv.x * keep + (rnd() - 0.5) * 0.4, cv.y * keep + 0.7 + rnd() * 0.6, cv.z * keep + (rnd() - 0.5) * 0.4);
    q.life = 3.2 + rnd() * 1.8; q.s0 = 0.35 + rnd() * 0.2; q.s1 = 2.0 + rnd() * 1.2;
    q.a0 = 0.26 + rnd() * 0.12; q.dark = 0.45 + rnd() * 0.35;
  }
  q.age = back; q.floor = at.y - 0.12;
  q.p += q.v * back;
  q.rot = rnd() * PI * 2; q.spin = (rnd() - 0.5) * 1.1; q.seed = rnd() * 100;
}

void CarSmoke::draw(Renderer& r) const {
  for (const P& q : ps_) {
    if (q.age >= q.life) continue;
    const double age = q.age, f = age / q.life;
    const bool smoke = q.dark > 0.3;
    // it grows as it mixes in (fast at first), fades in at the seam and thins out (steam quickly, smoke slowly)
    const double grow = 1 - std::exp(-age * (smoke ? 0.8 : 1.7));
    const double size = q.s0 + (q.s1 - q.s0) * grow;
    const double fin = std::min(1.0, age / (smoke ? 0.45 : 0.14)), fout = std::pow(1 - f, smoke ? 1.3 : 1.7);
    // (ageing: the thin parts go first, carlights.js vErode)
    const double erode = smoke ? f * 0.4 : 0.02 + f * 0.5;
    const vec3 alb = glm::mix(vec3(0.94f, 0.95f, 0.96f), vec3(0.17f, 0.165f, 0.16f), float(q.dark));
    Particle p;
    p.pos = q.p;
    p.size = float(size * 0.5);   // (the JS quad's width is the puff's size: the renderer's is its half width)
    p.color = vec4(alb, float(q.a0 * fin * fout * (1 - erode * 0.6)));
    p.rot = float(q.rot);
    p.soft = 0.35f;
    p.kind = 0;
    p.seed = float(std::fmod(q.seed, 1.0) + 0.001);
    r.addParticle(p);
  }
}

void CarSmoke::clear() {
  for (P& q : ps_) q.age = 1e9;
  acc_ = accD_ = 0; hasPrev_ = false; live_ = 0;
}

} // namespace sl
