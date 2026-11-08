#include "game/people.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "world/scenery.h"
#include "world/world.h"
#include <algorithm>

namespace sl {

namespace {
// rotate a bone about an axis given in model space (skier_rig.cpp bend)
void bendPose(const Model& m, Pose& pose, int b, const vec3& axis, float angle) {
  if (b < 0 || angle == 0) return;
  int par = m.nodes[size_t(b)].parent;
  quat pg(1, 0, 0, 0);
  if (par >= 0) {
    mat3 g(pose.global[size_t(par)]);
    g[0] = glm::normalize(g[0]); g[1] = glm::normalize(g[1]); g[2] = glm::normalize(g[2]);
    pg = glm::normalize(glm::quat_cast(g));
  }
  quat d = glm::angleAxis(angle, glm::normalize(axis));
  pose.r[size_t(b)] = glm::normalize(glm::inverse(pg) * d * pg * pose.r[size_t(b)]);
  m.finishPose(pose);
}
const char* SKIERS[] = {"skier_orange", "skier_black", "skier_purple", "skier_green", "skier_red", "skier_blue"};
const char* FANS[] = {"fan_man", "fan_woman", "fan_elder", "fan_girl", "fan_kid", "fan_lady", "fan_teen", "fan_skier"};
} // namespace

bool People::load(AssetManager& assets) {
  ModelLoadOptions o;
  o.maxTextureSize = 512;
  o.lodRatios = {0.25f};
  anims_ = assets.model("skier_red_anims", o);
  ski_ = assets.model("ski_carver", ModelLoadOptions{});
  if (ski_) skiFit_ = glm::rotate(mat4(1), float(-PI / 2), vec3(0, 1, 0)) * ski_->fitTransform(1.7f, 0, true);
  auto addKind = [&](const std::string& name, const std::string& file, float h) {
    auto m = assets.model(file, o);
    if (!m) return -1;
    Kind k;
    k.name = name; k.model = m; k.height = h;
    k.fit = m->fitTransform(h, 1);
    kinds_.push_back(std::move(k));
    buildPoses(kinds_.back(), anims_.get());
    return int(kinds_.size()) - 1;
  };
  for (const char* s : SKIERS) { int k = addKind(s, std::string(s) + "_rigged", 1.78f); if (k >= 0) skierKinds.push_back(k); }
  for (const char* f : FANS) { int k = addKind(f, f, std::string(f) == "fan_kid" ? 1.3f : std::string(f) == "fan_girl" ? 1.55f : 1.74f); if (k >= 0) fanKinds.push_back(k); }
  officer = addKind("police_officer", "police_officer_rigged", 1.82f);
  if (officer >= 0) {   // (his own clips when they bind better)
    auto oa = assets.model("police_officer_anims", o);
    if (oa) buildPoses(kinds_[size_t(officer)], oa.get());
  }
  if (fanKinds.empty()) fanKinds = skierKinds;
  SL_INFO("people: %zu characters (%zu skiers, %zu townsfolk%s)", kinds_.size(), skierKinds.size(), fanKinds.size(), officer >= 0 ? ", the police officer" : "");
  return !kinds_.empty();
}

int People::kind(const std::string& name) const {
  for (size_t i = 0; i < kinds_.size(); i++) if (kinds_[i].name == name) return int(i);
  return -1;
}

void People::buildPoses(Kind& k, const Model* src) {
  const Model& m = *k.model;
  const AnimClip* idle = src ? src->findClip("Idle") : nullptr;
  const AnimClip* walk = src ? src->findClip("Casual_Walk") : nullptr;
  const AnimClip* run = src ? src->findClip("Run_02") : nullptr;
  auto bound = [&](const AnimClip* c, std::vector<int>& map) {
    if (!c) return false;
    map = bindClip(m, *c);
    int n = 0;
    for (int v : map) n += v >= 0;
    return n > 8;
  };
  std::vector<int> mi, mw, mr;
  bool hi = bound(idle, mi), hw = bound(walk, mw), hr = bound(run, mr);
  if (src && !hi && !hw) return;   // (another skeleton: keep what we had)
  for (auto& v : k.poses) v.clear();
  auto make = [&](const AnimClip* c, const std::vector<int>& map, bool ok, float t) {
    Pose p;
    m.restPose(p);
    if (ok && c) sampleClip(m, *c, t, 1.f, p, map);
    else if (hi && idle) sampleClip(m, *idle, 0, 1.f, p, mi);
    m.finishPose(p);
    return p;
  };
  for (int i = 0; i < 6; i++) k.poses[size_t(PAnim::Idle)].push_back(make(idle, mi, hi, idle ? idle->duration * i / 6.f : 0));
  for (int i = 0; i < 12; i++) k.poses[size_t(PAnim::Walk)].push_back(make(walk, mw, hw, walk ? walk->duration * i / 12.f : 0));
  for (int i = 0; i < 8; i++) k.poses[size_t(PAnim::Run)].push_back(make(run, mr, hr, run ? run->duration * i / 8.f : 0));
  int upL = m.findNode("LeftUpLeg"), upR = m.findNode("RightUpLeg"), legL = m.findNode("LeftLeg"), legR = m.findNode("RightLeg");
  int footL = m.findNode("LeftFoot"), footR = m.findNode("RightFoot"), sp = m.findNode("Spine01"), sp1 = m.findNode("Spine02");
  int armL = m.findNode("LeftArm"), armR = m.findNode("RightArm"), foreR = m.findNode("RightForeArm");
  auto crouch = [&](float c, bool tuck) {
    Pose p = make(idle, mi, hi, 0);
    float a = 0.35f + 0.9f * c, knee = 0.55f + 1.3f * c, lean = 0.25f + 0.55f * c + (tuck ? 0.45f : 0.f);
    bendPose(m, p, upL, vec3(1, 0, 0), -a); bendPose(m, p, upR, vec3(1, 0, 0), -a);
    bendPose(m, p, legL, vec3(1, 0, 0), knee); bendPose(m, p, legR, vec3(1, 0, 0), knee);
    bendPose(m, p, footL, vec3(1, 0, 0), -(knee - a) * 0.8f); bendPose(m, p, footR, vec3(1, 0, 0), -(knee - a) * 0.8f);
    bendPose(m, p, sp, vec3(1, 0, 0), lean * 0.6f); bendPose(m, p, sp1, vec3(1, 0, 0), lean * 0.4f);
    float arm = tuck ? 1.1f : 0.55f;
    bendPose(m, p, armL, vec3(1, 0, 0), -arm); bendPose(m, p, armR, vec3(1, 0, 0), -arm);
    return p;
  };
  k.poses[size_t(PAnim::Ski)].push_back(crouch(0.25f, false));
  k.poses[size_t(PAnim::Tuck)].push_back(crouch(0.9f, true));
  {
    Pose p = make(idle, mi, hi, 0);
    bendPose(m, p, upL, vec3(1, 0, 0), -1.5f); bendPose(m, p, upR, vec3(1, 0, 0), -1.5f);
    bendPose(m, p, legL, vec3(1, 0, 0), 1.5f); bendPose(m, p, legR, vec3(1, 0, 0), 1.5f);
    k.poses[size_t(PAnim::Sit)].push_back(p);
  }
  k.poses[size_t(PAnim::Lie)].push_back(make(idle, mi, hi, 0));
  for (int i = 0; i < 4; i++) {   // waving (the taxi's passenger hailing you, the officer flagging you down)
    Pose p = make(idle, mi, hi, 0);
    bendPose(m, p, armR, vec3(0, 0, 1), -2.3f + 0.35f * std::sin(float(i) / 4 * float(TAU)));
    bendPose(m, p, foreR, vec3(0, 0, 1), -0.4f);
    k.poses[size_t(PAnim::Wave)].push_back(p);
  }
}

void People::submit(Renderer& r, const dvec3& cam, int maxDraw, double view) {
  drawn_ = 0;
  std::vector<std::pair<double, size_t>> order;
  order.reserve(list_.size());
  for (size_t i = 0; i < list_.size(); i++) {
    const Person& p = list_[i];
    if (p.kind < 0 || p.kind >= int(kinds_.size())) continue;
    double d = glm::length(p.pos - cam);
    if (d > view) continue;
    if (!r.visible(p.pos - dvec3(1, 0, 1), p.pos + dvec3(1, 2.2, 1))) continue;
    order.push_back({d, i});
  }
  std::sort(order.begin(), order.end());
  if (int(order.size()) > maxDraw) order.resize(size_t(maxDraw));
  for (auto& [d, i] : order) {
    const Person& p = list_[i];
    Kind& k = kinds_[size_t(p.kind)];
    auto& set = k.poses[size_t(p.anim)];
    if (set.empty()) continue;
    size_t n = set.size();
    double ph = p.anim == PAnim::Idle ? p.phase / 1.2 : p.phase;
    size_t b = size_t(std::floor((ph - std::floor(ph)) * double(n))) % n;
    mat4 L = glm::rotate(mat4(1), float(p.yaw), vec3(0, 1, 0));
    if (p.anim == PAnim::Lie) L = L * glm::translate(mat4(1), vec3(0, 0.15f, 0)) * glm::rotate(mat4(1), float(-PI / 2), vec3(1, 0, 0)) * glm::translate(mat4(1), vec3(0, -0.15f, -0.9f));
    if (p.lean != 0) L = L * glm::rotate(mat4(1), p.lean, vec3(0, 0, 1));
    if (p.anim == PAnim::Sit) L = L * glm::translate(mat4(1), vec3(0, -0.45f, 0));
    L = L * glm::scale(mat4(1), vec3(p.scale)) * k.fit;
    r.submitModel(*k.model, p.pos, L, &set[b], d < 40, d > 35 ? 1 : 0);
    if (p.skis && ski_ && d < 90) {
      for (int s = 0; s < 2; s++) {
        mat4 S = glm::rotate(mat4(1), float(p.yaw), vec3(0, 1, 0)) * glm::translate(mat4(1), vec3(s ? 0.13f : -0.13f, 0.02f, 0.05f)) * skiFit_;
        r.submitModel(*ski_, p.pos, S, nullptr, d < 40);
      }
    }
    drawn_++;
  }
}

// ---------------------------------------------------------------- the townsfolk and the resort's skiers
namespace {
const double HOTELS[8][2] = {{62, 34}, {-74, 44}, {100, -34}, {-108, -60}, {22, 92}, {-36, 108}, {118, 70}, {-128, 22}};
constexpr double SIM = 420, SKI_R = 650;
} // namespace

void PeopleSim::init(World& world, const std::vector<std::vector<dvec2>>& pistes, int fans, int skiers) {
  world_ = &world;
  // townsfolk.js places: the hotels' doors (7.4 m in front, toward the plaza), the ski shop, the gondola approach, the
  // market stalls, the fire pit, the Christmas tree ring, the trail map, the bus stop
  for (auto& h : HOTELS) { double l = std::hypot(h[0], h[1]); places_.push_back({h[0] - h[0] / l * 12.5, h[1] - h[1] / l * 12.5, 0}); }
  places_.push_back({-36.5, -15.5, 0});           // the ski shop's door
  places_.push_back({0, -53, 2});                 // the gondola
  for (int i = 0; i < 3; i++) places_.push_back({27.5 + i * 0.5, 4 + i * 7.2, 1});   // the market (in front of the stalls)
  places_.push_back({19.5, 12, 1});               // the fire pit
  for (int i = 0; i < 6; i++) { double a = i * TAU / 6; places_.push_back({std::cos(a) * 15, -4 + std::sin(a) * 15, 1}); }   // round the tree
  places_.push_back({12.5, -21, 1});              // the trail map / job board
  places_.push_back({8, 46, 1});                  // the bus stop
  pistes_ = pistes;
  for (auto& p : pistes_) {
    // downhill along the polyline: flip it so it starts at the top
    if (p.size() > 1 && world.height(p.front().x, p.front().y) < world.height(p.back().x, p.back().y)) std::reverse(p.begin(), p.end());
    std::vector<double> c{0};
    for (size_t i = 1; i < p.size(); i++) c.push_back(c.back() + glm::length(p[i] - p[i - 1]));
    cum_.push_back(std::move(c));
  }
  for (int i = 0; i < fans; i++) {
    Folk f;
    const Place& pl = places_[size_t(rnd() * places_.size()) % places_.size()];
    f.pos = dvec3(pl.x + (rnd() - 0.5) * 6, 0, pl.z + (rnd() - 0.5) * 6);
    f.pos.y = world.height(f.pos.x, f.pos.z);
    f.v = 1.1 + rnd() * 0.5; f.phase = rnd(); f.scale = float(0.95 + rnd() * 0.08);
    f.kind = fanKinds_.empty() ? 0 : fanKinds_[size_t(rnd() * fanKinds_.size()) % fanKinds_.size()];
    f.wait = rnd() * 8;
    folk_.push_back(f);
  }
  for (int i = 0; i < skiers; i++) { Folk f; f.skier = true; f.active = false; f.v = 7 + rnd() * 7; folk_.push_back(f); }
}

void PeopleSim::pick(Folk& f) {
  // somewhere else on the plaza (not right where they are)
  for (int t = 0; t < 6; t++) {
    int k = int(rnd() * places_.size()) % int(places_.size());
    if (std::hypot(places_[size_t(k)].x - f.pos.x, places_[size_t(k)].z - f.pos.z) > 12) { f.target = k; return; }
  }
  f.target = 0;
}

void PeopleSim::update(double dt, const dvec3& cam, double night, const Scenery* scenery) {
  if (!world_) return;
  night_ = night;
  int nAct = 0;
  for (size_t i = 0; i < folk_.size(); i++) {
    Folk& f = folk_[i];
    if (f.downT > 0) {   // knocked over: thrown, lies a while, gets up
      f.downT -= dt;
      f.pos.x += f.vx * dt; f.pos.z += f.vz * dt;
      f.vx *= std::exp(-dt * 3); f.vz *= std::exp(-dt * 3);
      f.pos.y = world_->groundHeight(f.pos.x, f.pos.z, f.pos.y + 1);
      continue;
    }
    if (f.skier) {
      if (!f.active || glm::length(dvec2(f.pos.x - cam.x, f.pos.z - cam.z)) > SKI_R + 100) {
        // (re)spawn on a piste near the camera, out of the way of the line it skis
        f.active = false;
        if (pistes_.empty() || rnd() > 0.05) continue;
        int pi = int(rnd() * pistes_.size()) % int(pistes_.size());
        auto& P = pistes_[size_t(pi)];
        auto& C = cum_[size_t(pi)];
        if (P.size() < 3) continue;
        size_t k = size_t(rnd() * (P.size() - 2));
        if (glm::length(P[k] - dvec2(cam.x, cam.z)) > SKI_R) continue;
        f.piste = pi; f.s = C[k]; f.lat = (rnd() - 0.5) * 18; f.active = true; f.phase = rnd() * 10;
        f.kind = skierKinds_.empty() ? 0 : skierKinds_[size_t(rnd() * skierKinds_.size()) % skierKinds_.size()];
      }
      auto& P = pistes_[size_t(f.piste)];
      auto& C = cum_[size_t(f.piste)];
      f.s += f.v * dt;
      f.phase += dt;
      if (f.s >= C.back() - 2) { f.active = false; continue; }
      size_t k = size_t(std::upper_bound(C.begin(), C.end(), f.s) - C.begin());
      k = std::clamp<size_t>(k, 1, P.size() - 1);
      double t = (f.s - C[k - 1]) / std::max(1e-6, C[k] - C[k - 1]);
      dvec2 a = P[k - 1], b = P[k], d = glm::normalize(b - a + dvec2(1e-9));
      double weave = f.lat + std::sin(f.phase * 0.9) * 6;   // linked turns across the piste
      dvec2 q = a + (b - a) * t + dvec2(-d.y, d.x) * weave;
      f.yaw = std::atan2(d.x, d.y) + std::cos(f.phase * 0.9) * 0.5;
      f.pos = dvec3(q.x, world_->height(q.x, q.y), q.y);
      nAct++;
      continue;
    }
    double dc = glm::length(dvec2(f.pos.x - cam.x, f.pos.z - cam.z));
    f.active = dc < SIM && (night < 0.5 || (i % 3) == 0);   // (fewer people out at night)
    if (!f.active) continue;
    nAct++;
    if (f.wait > 0) { f.wait -= dt; f.phase += dt; continue; }
    if (f.target < 0) pick(f);
    const Place& pl = places_[size_t(f.target)];
    double dx = pl.x - f.pos.x, dz = pl.z - f.pos.z, d = std::hypot(dx, dz);
    if (d < 1.2) { f.target = -1; f.wait = pl.kind == 1 ? 6 + rnd() * 18 : 1 + rnd() * 3; continue; }
    f.yaw = dampAngle(f.yaw, std::atan2(dx, dz), dt * 5);
    f.pos.x += std::sin(f.yaw) * f.v * dt; f.pos.z += std::cos(f.yaw) * f.v * dt;
    f.phase += f.v * dt / 1.16;   // fans.js WALK_STRIDE
    // round the buildings, lamps, stalls (the colliders near: pushed out of boxes and circles)
    if (scenery) if (const std::vector<int>* near = scenery->collidersNear(f.pos.x, f.pos.z)) {
      for (int ci : *near) {
        const Collider& c = scenery->colliders()[size_t(ci)];
        if (c.r >= 0) {
          double ex = f.pos.x - c.x, ez = f.pos.z - c.z, e = std::hypot(ex, ez), R = c.r + 0.35;
          if (e < R && e > 1e-6) { f.pos.x = c.x + ex / e * R; f.pos.z = c.z + ez / e * R; }
        } else {
          double cs = std::cos(-c.rot), sn = std::sin(-c.rot);
          double lx = (f.pos.x - c.x) * cs - (f.pos.z - c.z) * sn, lz = (f.pos.x - c.x) * sn + (f.pos.z - c.z) * cs;
          double ox = c.hw + 0.35 - std::fabs(lx), oz = c.hd + 0.35 - std::fabs(lz);
          if (ox > 0 && oz > 0) {
            if (ox < oz) lx += lx >= 0 ? ox : -ox; else lz += lz >= 0 ? oz : -oz;
            double c2 = std::cos(c.rot), s2 = std::sin(c.rot);
            f.pos.x = c.x + lx * c2 - lz * s2; f.pos.z = c.z + lx * s2 + lz * c2;
            f.yaw += 0.6;   // (and turn along it)
          }
        }
      }
    }
    f.pos.y = world_->groundHeight(f.pos.x, f.pos.z, f.pos.y + 1);
  }
  (void)nAct;
}

void PeopleSim::add(People& people, const dvec3& cam) const {
  for (const Folk& f : folk_) {
    if (!f.active && f.downT <= 0) continue;
    if (glm::length(f.pos - cam) > 260) continue;
    Person p;
    p.kind = f.kind; p.pos = f.pos; p.yaw = f.yaw; p.scale = f.scale;
    if (f.downT > 0) p.anim = f.downT > 1.2 ? PAnim::Lie : PAnim::Idle;
    else if (f.skier) { p.anim = PAnim::Ski; p.skis = true; p.lean = float(-std::cos(f.phase * 0.9) * 0.25); }
    else if (f.wait > 0) { p.anim = PAnim::Idle; p.phase = f.phase; }
    else { p.anim = PAnim::Walk; p.phase = f.phase; }
    people.add(p);
  }
}

void PeopleSim::near(const dvec3& p, double r, std::vector<int>& out) const {
  out.clear();
  for (size_t i = 0; i < folk_.size(); i++) {
    const Folk& f = folk_[i];
    if ((!f.active && !f.skier) || f.downT > 0 || (f.skier && !f.active)) continue;
    if (std::hypot(f.pos.x - p.x, f.pos.z - p.z) < r && std::fabs(f.pos.y - p.y) < 3) out.push_back(int(i));
  }
}

void PeopleSim::knock(int i, double vx, double vz) {
  Folk& f = folk_[size_t(i)];
  f.downT = 6; f.vx = vx; f.vz = vz; f.wait = 0;
  knocked++;
}

} // namespace sl
