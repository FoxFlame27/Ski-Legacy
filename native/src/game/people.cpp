#include "game/people.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "engine/quality.h"
#include "engine/renderer.h"
#include "world/scenery.h"
#include "world/world.h"
#include <algorithm>

namespace sl {
using three::V3;

namespace {
// characters.js SKIER_MODELS (this order picks the NPCs' looks: npcs.js makeSkier(k) -> others[k % 6])
const char* SKIERS[] = {"skier_blue", "skier_red", "skier_green", "skier_orange", "skier_black", "skier_purple"};
const char* FANS[] = {"fan_man", "fan_woman", "fan_elder", "fan_girl", "fan_kid", "fan_lady", "fan_teen", "fan_skier"};
constexpr double G = 9.81;
double clampd(double x, double a, double b) { return std::max(a, std::min(b, x)); }
double lerpd(double a, double b, double t) { return a + (b - a) * t; }
} // namespace

// ---------------------------------------------------------------- drawing a rig
void drawRig(Renderer& r, const RigInst& R, const PeopleKind& K, const RigGear* gear, double scale, bool shadow) {
  if (!R.posed || !K.draw) return;
  const SkierRig& g = R.rig;
  const dvec3 o(g.rootPos);
  const mat4 S = glm::scale(mat4(1), vec3(float(scale)));
  if (g.bodyVisible) r.submitModel(*K.draw, o, S * mat4(three::compose(V3(0), three::yaw(g.rootHeading), V3(1))), &R.pose, shadow);
  if (!gear || !g.gearVisible) return;
  if (g.hasSkis() && gear->ski)
    for (int s = 0; s < 2; s++)
      if (g.skis[s].visible) r.submitModel(*gear->ski, o, S * mat4(three::compose(g.skis[s].p - V3(o), g.skis[s].q, V3(1)) * gear->skiFit), nullptr, shadow);
  if (g.hasPoles() && gear->pole)
    for (int s = 0; s < 2; s++)
      if (g.poles[s].visible) r.submitModel(*gear->pole, o, S * mat4(three::compose(g.poles[s].p - V3(o), g.poles[s].q, V3(1)) * gear->poleFit), nullptr, shadow);
}

// ---------------------------------------------------------------- People
bool People::load(AssetManager& assets, World& world) {
  world_ = &world;
  auto flat = [](double, double, double) { return 0.0; };
  gears_ = {rigGear(assets, "ski_rental", false), rigGear(assets, "ski_sport", false), rigGear(assets, "ski_pro", false), rigGear(assets, "ski_rental", true)};
  auto addKind = [&](const std::string& name, const std::string& file, const std::string& anims, bool skier) {
    auto rm = rigModel(assets, name, flat, file, anims);
    if (!rm) return -1;
    PeopleKind k;
    k.name = name; k.rig = rm; k.skier = skier;
    // the fans' GLBs carry their vertex-coloured LODs as further primitives of the one skinned mesh (fans.js draws the
    // textured one near): only the first primitive of each mesh is drawn
    auto d = std::make_shared<Model>(*rm->body);
    for (Mesh& m : d->meshes) if (m.primitives.size() > 1) m.primitives.resize(1);
    k.draw = d;
    kinds_.push_back(std::move(k));
    return int(kinds_.size()) - 1;
  };
  for (const char* s : SKIERS) { int k = addKind(s, std::string(s) + "_rigged", std::string(s) + "_anims", true); if (k >= 0) skierKinds.push_back(k); }
  for (const char* f : FANS) { int k = addKind(f, f, "", false); if (k >= 0) fanKinds.push_back(k); }
  officer = addKind("police_officer", "police_officer_rigged", "police_officer_anims", true);
  if (fanKinds.empty()) fanKinds = skierKinds;
  SL_INFO("people: %zu characters (%zu skiers, %zu townsfolk%s), one skier rig each", kinds_.size(), skierKinds.size(), fanKinds.size(), officer >= 0 ? ", the police officer" : "");
  return !kinds_.empty();
}

int People::kind(const std::string& name) const {
  for (size_t i = 0; i < kinds_.size(); i++) if (kinds_[i].name == name) return int(i);
  return -1;
}

void People::submit(Renderer& r, const dvec3& cam, int maxDraw, double view) {
  frame_++;
  drawn_ = 0;
  std::vector<std::pair<double, size_t>> order;
  order.reserve(list_.size());
  for (size_t i = 0; i < list_.size(); i++) {
    const Person& p = list_[i];
    if (p.kind < 0 || p.kind >= int(kinds_.size())) continue;
    double d = glm::length(p.pos - cam);
    if (d > view) continue;
    if (!r.visible(p.pos - dvec3(1.5, 0.5, 1.5), p.pos + dvec3(1.5, 2.4, 1.5))) continue;
    order.push_back({d, i});
  }
  std::sort(order.begin(), order.end());
  if (int(order.size()) > maxDraw) order.resize(size_t(maxDraw));
  for (auto& s : slots_) s->used = false;
  const double dt = std::max(1e-4, dt_);
  for (auto& [d, i] : order) {
    const Person& p = list_[i];
    const PeopleKind& K = kinds_[size_t(p.kind)];
    // the rig this person had last frame: same character, close by
    Slot* best = nullptr;
    double bd = 2.5 + 40 * dt;
    for (auto& s : slots_) {
      if (s->used || s->R.kind != p.kind || s->seen < frame_ - 3) continue;
      double e = glm::length(s->last - p.pos);
      if (e < bd) { bd = e; best = s.get(); }
    }
    bool fresh = false;
    if (!best) {
      for (auto& s : slots_) if (!s->used && s->seen < frame_ - 3 && (!best || s->seen < best->seen)) best = s.get();
      if (!best) { slots_.push_back(std::make_unique<Slot>()); best = slots_.back().get(); }
      fresh = true;
    }
    Slot& S = *best;
    int gear = p.poles ? 3 : p.kind % 3;   // (stable per character: rental / sport / pro skis)
    if (fresh || S.R.kind != p.kind || S.gear != gear) {
      S.R.kind = p.kind; S.gear = gear;
      S.R.rig = SkierRig();
      World* w = world_;
      S.R.rig.init(K.rig, gears_[size_t(gear)], true, p.poles, [w](double x, double z, double y) { return w ? w->groundHeight(x, z, y) : 0.0; });
      S.R.animAcc = 1;
      S.speed = 0;
      S.last = p.pos;
    }
    if (fresh) S.R.rig.snapPose();
    S.used = true;
    double measured = std::hypot(p.pos.x - S.last.x, p.pos.z - S.last.z) / dt;
    if (fresh || measured > 60) measured = 0;
    S.speed = p.speed >= 0 ? p.speed : lerpd(S.speed, measured, 1 - std::exp(-dt * 8));
    S.last = p.pos;
    S.seen = frame_;
    // the rig state for what the person does
    RigState st;
    st.heading = p.yaw;
    SkierRig& rig = S.R.rig;
    rig.setCarry(p.pack);
    rig.setSkisVisible(p.skis || p.pack);
    switch (p.anim) {
      case PAnim::Idle: case PAnim::Wave: st.mode = RigMode::Idle; break;
      case PAnim::Walk: st.mode = RigMode::Walk; st.speed = S.speed > 0.2 ? S.speed : 1.3; break;
      case PAnim::Run: st.mode = RigMode::Walk; st.speed = S.speed > 0.2 ? S.speed : 3.6; break;
      case PAnim::Ski: case PAnim::Tuck:
        st.mode = RigMode::Ski; st.speed = S.speed > 0.2 ? S.speed : 8;
        st.lean = p.lean; st.crouch = p.anim == PAnim::Tuck ? 0.21 : 0.3 + std::fabs(p.lean) * 0.25; st.tuck = p.anim == PAnim::Tuck;
        st.hasNormal = true; st.normal = world_ ? three::normalize(V3(world_->groundNormal(p.pos.x, p.pos.z, p.pos.y + 0.5))) : three::UP;
        break;
      case PAnim::Sit: st.mode = RigMode::Sit; st.hasSeat = true; st.seat = V3(p.pos) + three::UP * 0.45; break;
      case PAnim::Lie:
        st.mode = RigMode::Fall; st.hasFall = true; st.fall.roll = PI / 2; st.fallSide = 1;
        st.hasNormal = true; st.normal = three::UP;
        break;
      default: break;
    }
    // animation LOD (npcs.js): posed every frame near, at a lower rate further off
    S.R.animAcc += dt;
    if (d < animNear || S.R.animAcc > (d < animNear * 2.5 ? 0.06 : 0.12) || !S.R.posed) {
      rig.rootPos = V3(p.pos);
      rig.update(std::min(S.R.animAcc, 0.25), st);
      S.R.pose_();
      S.R.animAcc = 0;
    }
    RigInst& R = S.R;
    R.rig.rootPos = V3(p.pos);   // (the body moves on between the poses; the bones keep the last one)
    drawRig(r, R, K, gears_[size_t(S.gear)].get(), p.scale, d < 40);
    drawn_++;
  }
}

// ---------------------------------------------------------------- npcs.js: the resort's skiers and walkers
namespace {
std::vector<dvec2> resample(const std::vector<dvec2>& pts, double step) {
  std::vector<dvec2> out;
  for (size_t i = 0; i + 1 < pts.size(); i++) {
    dvec2 a = pts[i], b = pts[i + 1];
    double l = std::hypot(b.x - a.x, b.y - a.y);
    for (double t = 0; t < l; t += step) out.push_back(a + (b - a) * (t / l));
  }
  return out;
}
const double HOTELS[8][2] = {{62, 34}, {-74, 44}, {100, -34}, {-108, -60}, {22, 92}, {-36, 108}, {118, 70}, {-128, 22}};
const dvec2 RING_C(0, -4);
constexpr double RING = 15;
double wrapA(double a) { a = std::fmod(a, PI * 2); return a > PI ? a - PI * 2 : a < -PI ? a + PI * 2 : a; }
// townsfolk.js places (village.js: the shop faces the plaza; its door ~6 m in front of its centre)
const dvec2 SHOP_OUT(-32.5, -16.5), GONDOLA_OUT(0, -53), MAP_AT(8, -21.6);
dvec2 hotelOut(int i) { double x = HOTELS[i][0], z = HOTELS[i][1], l = std::hypot(x, z); return dvec2(x - x / l * 12.5, z - z / l * 12.5); }
const char* JACKETS[] = {"#d7263d", "#1546c8", "#f6ae2d", "#2a9d8f", "#ffffff", "#111111", "#e76f51", "#7b2cbf", "#ff6b9a", "#3a86ff"};
constexpr double FAR_NEAR = 160, FAR_FADE = 50;
} // namespace

void Npcs::init(People& people, gfx::Device& dev, World& world, const std::vector<std::vector<dvec2>>& pistes, const Quality& q) {
  people_ = &people; world_ = &world; dev_ = &dev;
  qSkiers_ = q.npcSkiers; qWalkers_ = q.npcWalkers; animNear_ = q.animNear;
  people.animNear = q.animNear;
  for (auto& p : pistes) paths_.push_back(resample(p, 1));
  for (auto& p : pistes) { auto r = resample(p, 2); if (r.size() > 60) farPaths_.push_back(std::move(r)); }
  // the far figures: skis, legs (dark), jacket (tinted per instance), helmet; one model per jacket colour
  for (int c = 0; c < 10; c++) {
    vec3 tint = glm::mix(hexColor(JACKETS[c]), vec3(1), 0.15f);
    Geo all;
    auto box = [&](float w, float h, float d, float x, float y, float z, const char* col) {
      Geo g = boxGeo(w, h, d);
      g.translate(x, y, z);
      g.col.assign(g.pos.size(), hexColor(col) * tint);
      all.append(g);
    };
    box(0.09f, 0.03f, 1.65f, -0.11f, 0.02f, 0.1f, "#30343c"); box(0.09f, 0.03f, 1.65f, 0.11f, 0.02f, 0.1f, "#30343c");
    box(0.13f, 0.78f, 0.16f, -0.11f, 0.42f, 0.04f, "#1d2230"); box(0.13f, 0.78f, 0.16f, 0.11f, 0.42f, 0.04f, "#1d2230");
    box(0.44f, 0.62f, 0.3f, 0, 1.12f, 0.12f, "#ffffff");
    box(0.22f, 0.24f, 0.24f, 0, 1.55f, 0.2f, "#e8ecf2");
    Material m;
    m.metallic = 0; m.roughness = 1; m.vertexColor = true;
    farModels_.push_back(buildModel(dev, {{std::move(all), m}}, "far-skier"));
  }
  farBatches_.resize(10); farInst_.resize(10); farCap_.assign(10, 0);
  int n = int(std::round(60 + 5 * qSkiers_));
  for (int i = 0; i < n && !farPaths_.empty(); i++) { Far f; f.colour = i % 10; spawnFar(f, true); far_.push_back(f); }
  SL_INFO("npcs: up to %d skiers on the pistes, %d walkers in the village, %zu far skiers (animNear %.0f m)", qSkiers_, qWalkers_, far_.size(), animNear_);
}

void Npcs::spawnFar(Far& o, bool anywhere) {
  o.path = int(rnd() * double(farPaths_.size())) % int(farPaths_.size());
  double len = double(farPaths_[size_t(o.path)].size());
  o.u = (anywhere ? rnd() * 0.9 : rnd() * 0.3) * (len - 4);
  o.v = 4 + rnd() * 5; o.amp = 3 + rnd() * 7; o.wave = 22 + rnd() * 26; o.phase = rnd() * 6.28;
  o.heading = 0;
}

std::unique_ptr<RigInst> Npcs::takeRig(int k, int& gear) {
  std::unique_ptr<RigInst> r;
  gear = k % 3;
  if (!pool_.empty()) { r = std::move(pool_.back()); pool_.pop_back(); gear = r->gear; return r; }
  const auto& sk = people_->skierKinds;
  if (sk.empty()) return nullptr;
  r = std::make_unique<RigInst>();
  int kind = sk[size_t(k) % sk.size()];
  r->kind = kind; r->gear = gear;
  World* w = world_;
  // (makeSkier: makeRig(others[k % 6], ['rental', 'sport', 'pro'][k % 3]): no poles)
  r->rig.init(people_->kindOf(kind).rig, people_->gear(gear), true, false, [w](double x, double z, double y) { return w->groundHeight(x, z, y); });
  return r;
}
void Npcs::releaseRig(std::unique_ptr<RigInst> r) { if (r && pool_.size() < 16) pool_.push_back(std::move(r)); }

void Npcs::spawnSkier(const dvec3& p) {
  for (int tries = 0; tries < 30; tries++) {
    if (paths_.empty()) return;
    int pi = int(rnd() * double(paths_.size())) % int(paths_.size());
    const auto& path = paths_[size_t(pi)];
    if (path.size() < 100) continue;
    size_t u = size_t(std::floor(rnd() * double(path.size() - 60)));
    dvec2 q = path[u];
    double d = std::hypot(q.x - p.x, q.y - p.z);
    if (d < 70 || d > 450) continue;
    int k = int(skiers_.size() + walkers_.size());
    Skier s;
    s.R = takeRig(k, s.gear);
    if (!s.R) return;
    s.R->rig.setSkisVisible(true);
    s.R->rig.setCarry(false);
    double style = rnd();
    s.path = pi; s.u = double(u); s.v = 3 + rnd() * 4; s.amp = 4 + rnd() * 8; s.wave = 26 + rnd() * 30;
    s.phase = rnd() * 6.28; s.maxV = 7 + style * 9;
    s.pos = dvec3(q.x, world_->height(q.x, q.y), q.y);
    skiers_.push_back(std::move(s));
    return;
  }
}

std::vector<dvec2> Npcs::route(const dvec2& from, const dvec2& to) {
  double lane = (rnd() - 0.5) * 1.8;
  auto ang = [](const dvec2& p) { return std::atan2(p.y - RING_C.y, p.x - RING_C.x); };
  auto ringPt = [&](double a) { return dvec2(RING_C.x + std::cos(a) * (RING + lane), RING_C.y + std::sin(a) * (RING + lane)); };
  double a0 = ang(from), a1 = ang(to);
  double r0 = glm::length(from - RING_C), r1 = glm::length(to - RING_C);
  std::vector<dvec2> pts;
  if (std::fabs(wrapA(a1 - a0)) < 0.5 || (r0 < RING + 4 && r1 < RING + 4 && std::fabs(wrapA(a1 - a0)) < 1.2)) { pts.push_back(to); return pts; }
  if (r0 > RING + 2) pts.push_back(ringPt(a0));
  double da = wrapA(a1 - a0);
  int steps = std::max(1, int(std::ceil(std::fabs(da) / 0.3)));
  for (int k = 1; k < steps; k++) pts.push_back(ringPt(a0 + da * k / steps));
  if (r1 > RING + 2) pts.push_back(ringPt(a1));
  pts.push_back(to);
  return pts;
}

void Npcs::ensureWalkers(const dvec3& p) {
  bool inVillage = std::hypot(p.x, p.z) < 500;
  if (inVillage && walkers_.empty()) {
    for (int i = 0; i < qWalkers_; i++) {
      Walker w;
      int gear = 0;
      w.R = takeRig(i + 3, gear);
      if (!w.R) return;
      bool carry = i % 2 == 0;
      w.R->rig.setSkisVisible(carry);
      w.R->rig.setCarry(carry);
      double a = rnd() * 6.28, r = 14 + rnd() * 2;
      w.pos = dvec3(std::cos(a) * r, 0, std::sin(a) * r - 4);
      w.wait = rnd() * 4; w.heading = rnd() * 6.28; w.speed = 0; w.carry = carry;
      walkers_.push_back(std::move(w));
    }
  } else if (!inVillage && !walkers_.empty()) {
    for (auto& w : walkers_) releaseRig(std::move(w.R));
    walkers_.clear();
  }
}

void Npcs::update(double dt, const dvec3& playerPos, const dvec3& camPos, double dayFactor) {
  dayFactor_ = dayFactor;
  cam_ = camPos;
  if (off) {
    for (auto& s : skiers_) releaseRig(std::move(s.R));
    for (auto& w : walkers_) releaseRig(std::move(w.R));
    skiers_.clear(); walkers_.clear();
    return;
  }
  if (dt <= 0) return;
  ensureWalkers(playerPos);
  // ---- the far skiers
  for (auto& o : far_) {
    if (o.path < 0) continue;
    o.u += (o.v * dt) / 2;
    if (o.u >= double(farPaths_[size_t(o.path)].size()) - 3) spawnFar(o, false);
  }
  int want = int(std::round(std::min(maxSkiers, qSkiers_) * (0.25 + 0.75 * dayFactor)));
  logT_ += dt;
  if (logT_ > 10) {
    logT_ = 0;
    double nearest = 1e9;
    for (auto& s : skiers_) nearest = std::min(nearest, glm::length(s.pos - playerPos));
    SL_INFO("npcs: %zu skiers on the pistes (want %d, nearest %.0f m), %zu walkers, %zu drawn", skiers_.size(), want, skiers_.empty() ? 0.0 : nearest, walkers_.size(), drawn_);
  }
  spawnTimer_ -= dt;
  if (int(skiers_.size()) < want && spawnTimer_ <= 0) { spawnTimer_ = 1.5; spawnSkier(playerPos); }
  for (int i = int(skiers_.size()) - 1; i >= 0; i--) {
    Skier& s = skiers_[size_t(i)];
    const auto& P = paths_[size_t(s.path)];
    size_t iu = size_t(std::floor(s.u));
    double dP = glm::length(s.pos - playerPos);
    if (iu + 3 >= P.size() || dP > 650 || (int(skiers_.size()) > want && dP > 200)) {
      releaseRig(std::move(s.R));
      skiers_.erase(skiers_.begin() + i);
      continue;
    }
    dvec2 a = P[iu], b = P[std::min(P.size() - 1, iu + 4)];
    double ha = world_->height(a.x, a.y), hb = world_->height(b.x, b.y);
    double slope = (ha - hb) / 4;
    double accel = G * slope / std::sqrt(1 + slope * slope) - 0.06 * G - 0.004 * s.v * s.v;
    s.v = clampd(s.v + accel * dt, 2.5, s.maxV);
    double prevLat = std::sin(s.u / s.wave * 6.283 + s.phase) * s.amp;
    s.u += s.v * dt * 0.92;
    double lat = std::sin(s.u / s.wave * 6.283 + s.phase) * s.amp;
    size_t i0 = size_t(std::floor(s.u));
    double f = s.u - double(i0);
    dvec2 c0 = P[std::min(i0, P.size() - 1)], c1 = P[std::min(P.size() - 1, i0 + 1)];
    double tx = c1.x - c0.x, tz = c1.y - c0.y, tl = std::hypot(tx, tz);
    if (tl == 0) tl = 1;
    double nx = -tz / tl, nz = tx / tl;
    double x = lerpd(c0.x, c1.x, f) + nx * lat, z = lerpd(c0.y, c1.y, f) + nz * lat;
    double dlat = (lat - prevLat) / std::max(1e-3, s.v * dt * 0.92);
    double heading = std::atan2(tx / tl + nx * dlat, tz / tl + nz * dlat);
    double prevH = s.heading;
    s.heading = heading;
    double dh = heading - prevH;
    dh = std::atan2(std::sin(dh), std::cos(dh));
    s.lean = lerpd(s.lean, clampd((-dh / std::max(dt, 1e-3)) * s.v * 0.08, -1, 1), std::min(1.0, dt * 4));
    dvec3 np(x, world_->height(x, z), z);
    s.vel = (np - s.pos) / std::max(dt, 1e-3);
    if (glm::length(s.vel) > 40) s.vel = dvec3(0);
    s.pos = np;
    double turn = sign(std::round(s.lean * 2));
    if (turn != 0 && turn != s.lastTurn) {
      V3 fw(std::sin(s.heading), 0, std::cos(s.heading));
      s.R->rig.startPolePlant(turn < 0 ? 0 : 1, fw, glm::cross(fw, three::UP));
    }
    s.lastTurn = turn;
    double d = glm::length(s.pos - playerPos);
    s.R->animAcc += dt;
    s.R->rig.rootPos = V3(np);
    if (d < animNear_ || s.R->animAcc > (d < animNear_ * 2.5 ? 0.06 : 0.12)) {
      RigState st;
      st.mode = RigMode::Ski; st.heading = s.heading; st.crouch = 0.3 + std::fabs(s.lean) * 0.25; st.lean = s.lean; st.speed = s.v;
      st.hasNormal = true; st.normal = three::normalize(V3(world_->groundNormal(x, z)));
      s.R->rig.update(s.R->animAcc, st);
      s.R->pose_();
      s.R->animAcc = 0;
    }
  }
  for (auto& w : walkers_) {
    if (!w.hasTarget) {
      w.wait -= dt;
      w.speed = lerpd(w.speed, 0, std::min(1.0, dt * 6));
      if (w.wait <= 0) {
        std::vector<dvec2> opts;
        if (w.carry) { opts = {GONDOLA_OUT, SHOP_OUT, MAP_AT}; for (int h = 0; h < 8; h++) opts.push_back(hotelOut(h)); }
        else { opts = {SHOP_OUT, dvec2(26.5, 6 + rnd() * 10), MAP_AT, GONDOLA_OUT}; for (int h = 0; h < 8; h++) opts.push_back(hotelOut(h)); }
        dvec2 to = opts[size_t(rnd() * double(opts.size())) % opts.size()];
        w.route = route(dvec2(w.pos.x, w.pos.z), to);
        w.target = w.route.front();
        w.route.erase(w.route.begin());
        w.hasTarget = true;
      }
    } else {
      double dx = w.target.x - w.pos.x, dz = w.target.y - w.pos.z, dd = std::hypot(dx, dz);
      if (dd < (!w.route.empty() ? 1.6 : 1)) {
        if (!w.route.empty()) { w.target = w.route.front(); w.route.erase(w.route.begin()); }
        else { w.hasTarget = false; w.wait = 2 + rnd() * 6; }
      } else {
        double want2 = std::atan2(dx, dz);
        double dh = want2 - w.heading;
        dh = std::atan2(std::sin(dh), std::cos(dh));
        w.heading += dh * std::min(1.0, dt * 4);
        w.speed = lerpd(w.speed, 1.35, std::min(1.0, dt * 3));
        w.pos.x += std::sin(w.heading) * w.speed * dt;
        w.pos.z += std::cos(w.heading) * w.speed * dt;
      }
    }
    w.pos.y = world_->height(w.pos.x, w.pos.z);
    double wd = glm::length(w.pos - playerPos);
    w.R->animAcc += dt;
    w.R->rig.rootPos = V3(w.pos);
    if (wd < animNear_ || w.R->animAcc > (wd < animNear_ * 2.5 ? 0.06 : 0.12)) {
      RigState st;
      st.mode = w.speed > 0.1 ? RigMode::Walk : RigMode::Idle; st.heading = w.heading; st.speed = w.speed;
      st.hasNormal = true;
      w.R->rig.update(w.R->animAcc, st);
      w.R->pose_();
      w.R->animAcc = 0;
    }
  }
}

void Npcs::near(const dvec3& p, double r, std::vector<dvec3>& out) const {
  for (auto& s : skiers_) if (std::fabs(s.pos.x - p.x) < r && std::fabs(s.pos.z - p.z) < r) out.push_back(s.pos);
  for (auto& w : walkers_) if (std::fabs(w.pos.x - p.x) < r && std::fabs(w.pos.z - p.z) < r) out.push_back(w.pos);
}

void Npcs::submit(Renderer& r, const dvec3& cam) {
  drawn_ = 0;
  if (off) return;
  auto drawOne = [&](const RigInst& R, int gear) {
    const dvec3 p(R.rig.rootPos);
    double d = glm::length(p - cam);
    if (d > 400 || !R.posed) return;
    if (!r.visible(p - dvec3(1.5, 0.5, 1.5), p + dvec3(1.5, 2.4, 1.5))) return;
    drawRig(r, R, people_->kindOf(R.kind), people_->gear(gear).get(), 1, d < 40);
    drawn_++;
  };
  for (auto& s : skiers_) if (s.R) drawOne(*s.R, s.R->gear);
  for (auto& w : walkers_) if (w.R) drawOne(*w.R, w.R->gear);
  // the far skiers (hidden near the camera, where the rigs are; fewer out at night)
  int active = int(std::round(double(far_.size()) * (0.2 + 0.8 * dayFactor_)));
  for (auto& L : farInst_) L.clear();
  dvec3 mn(1e30), mx(-1e30);
  for (size_t i = 0; i < far_.size(); i++) {
    Far& o = far_[i];
    if (o.path < 0) continue;
    const auto& P = farPaths_[size_t(o.path)];
    size_t i0 = size_t(std::min(std::max(0.0, std::floor(o.u)), double(P.size() - 2)));
    double f = clampd(o.u - double(i0), 0, 1);
    dvec2 c0 = P[i0], c1 = P[i0 + 1];
    double tx = c1.x - c0.x, tz = c1.y - c0.y, tl = std::hypot(tx, tz);
    if (tl == 0) tl = 1;
    double nx = -tz / tl, nz = tx / tl;
    double ph = (o.u * 2) / o.wave * 6.283 + o.phase, lat = std::sin(ph) * o.amp, dl = std::cos(ph) * o.amp * 6.283 / o.wave;
    double x = c0.x + tx * f + nx * lat, z = c0.y + tz * f + nz * lat, y = world_->height(x, z);
    double d = glm::length(dvec3(x, y, z) - cam);
    double k = int(i) >= active ? 0 : clampd((d - FAR_NEAR) / FAR_FADE, 0, 1);
    o.heading = std::atan2(tx / tl + nx * dl * 0.5, tz / tl + nz * dl * 0.5);
    if (k <= 0) continue;
    V3 fw(std::sin(o.heading), 0, std::cos(o.heading));
    three::Q q = three::mul(three::axisAngle(fw, -std::cos(ph) * 0.35), three::axisAngle(three::UP, o.heading));
    glm::dmat4 M = three::compose(V3(x, y, z), q, V3(k * 1.05));
    farInst_[size_t(o.colour)].push_back(MatrixInstanceBatch::pack(M, cam));
    mn = glm::min(mn, dvec3(x, y, z)); mx = glm::max(mx, dvec3(x, y, z));
  }
  for (size_t c = 0; c < farInst_.size(); c++) {
    auto& L = farInst_[c];
    if (L.empty() || !farModels_[c]) continue;
    if (L.size() > farCap_[c]) {
      farCap_[c] = uint32_t(std::max<size_t>(32, L.size() * 2));
      farBatches_[c] = MatrixInstanceBatch();
      farBatches_[c].init(*dev_, *farModels_[c], farCap_[c]);
    }
    farBatches_[c].upload(*dev_, L);
    r.submitInstances(farBatches_[c], cam, 0, false);
  }
}

// ---------------------------------------------------------------- the townsfolk
namespace {
constexpr double SIM = 420;
} // namespace

void PeopleSim::init(World& world, const std::vector<std::vector<dvec2>>&, int fans, int) {
  world_ = &world;
  // townsfolk.js places: the hotels' doors (toward the plaza), the ski shop, the gondola approach, the market stalls,
  // the fire pit, the Christmas tree ring, the trail map, the bus stop
  for (int h = 0; h < 8; h++) { dvec2 o = hotelOut(h); places_.push_back({o.x, o.y, 0}); }
  places_.push_back({SHOP_OUT.x, SHOP_OUT.y, 0});
  places_.push_back({0, -53, 2});
  for (int i = 0; i < 3; i++) places_.push_back({27.5 + i * 0.5, 4 + i * 7.2, 1});
  places_.push_back({19.5, 12, 1});
  for (int i = 0; i < 6; i++) { double a = i * TAU / 6; places_.push_back({std::cos(a) * 15, -4 + std::sin(a) * 15, 1}); }
  places_.push_back({MAP_AT.x, MAP_AT.y + 0.6, 1});
  places_.push_back({8, 46, 1});
  for (int i = 0; i < fans; i++) {
    Folk f;
    const Place& pl = places_[size_t(rnd() * double(places_.size())) % places_.size()];
    f.pos = dvec3(pl.x + (rnd() - 0.5) * 6, 0, pl.z + (rnd() - 0.5) * 6);
    f.pos.y = world.height(f.pos.x, f.pos.z);
    f.v = 1.15 + rnd() * 0.25; f.phase = rnd(); f.scale = float(0.96 + rnd() * 0.08);   // (townsfolk.js vmax; fans.js FAN_CFG scale)
    f.kind = fanKinds_.empty() ? 0 : fanKinds_[size_t(rnd() * double(fanKinds_.size())) % fanKinds_.size()];
    f.wait = rnd() * 8;
    f.yaw = rnd() * TAU;
    folk_.push_back(f);
  }
}

void PeopleSim::pick(Folk& f) {
  for (int t = 0; t < 6; t++) {
    int k = int(rnd() * double(places_.size())) % int(places_.size());
    if (std::hypot(places_[size_t(k)].x - f.pos.x, places_[size_t(k)].z - f.pos.z) > 12) { f.target = k; return; }
  }
  f.target = 0;
}

void PeopleSim::update(double dt, const dvec3& cam, double night, const Scenery* scenery) {
  if (!world_) return;
  night_ = night;
  for (size_t i = 0; i < folk_.size(); i++) {
    Folk& f = folk_[i];
    if (f.downT > 0) {   // knocked over: thrown, lies a while, gets up
      f.downT -= dt;
      f.pos.x += f.vx * dt; f.pos.z += f.vz * dt;
      f.vx *= std::exp(-dt * 3); f.vz *= std::exp(-dt * 3);
      f.pos.y = world_->groundHeight(f.pos.x, f.pos.z, f.pos.y + 1);
      continue;
    }
    double dc = glm::length(dvec2(f.pos.x - cam.x, f.pos.z - cam.z));
    f.active = dc < SIM && (night < 0.5 || (i % 3) == 0);   // (fewer people out at night)
    if (!f.active) continue;
    if (f.wait > 0) { f.wait -= dt; f.phase += dt; f.speed = lerpd(f.speed, 0, std::min(1.0, dt * 6)); continue; }
    if (f.target < 0) pick(f);
    const Place& pl = places_[size_t(f.target)];
    double dx = pl.x - f.pos.x, dz = pl.z - f.pos.z, d = std::hypot(dx, dz);
    if (d < 1.2) { f.target = -1; f.wait = pl.kind == 1 ? 6 + rnd() * 18 : 1 + rnd() * 3; continue; }
    f.yaw = dampAngle(f.yaw, std::atan2(dx, dz), dt * 5);
    f.speed = lerpd(f.speed, f.v, std::min(1.0, dt * 3));
    f.pos.x += std::sin(f.yaw) * f.speed * dt; f.pos.z += std::cos(f.yaw) * f.speed * dt;
    // round the buildings, lamps, stalls (the colliders near: pushed out of boxes and circles)
    if (scenery) if (const std::vector<int>* nearC = scenery->collidersNear(f.pos.x, f.pos.z)) {
      for (int ci : *nearC) {
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
}

void PeopleSim::add(People& people, const dvec3& cam) const {
  for (const Folk& f : folk_) {
    if (!f.active && f.downT <= 0) continue;
    if (glm::length(f.pos - cam) > 260) continue;
    Person p;
    p.kind = f.kind; p.pos = f.pos; p.yaw = f.yaw; p.scale = f.scale;
    if (f.downT > 0) p.anim = f.downT > 1.2 ? PAnim::Lie : PAnim::Idle;
    else if (f.speed > 0.1) { p.anim = PAnim::Walk; p.speed = f.speed; }
    else p.anim = PAnim::Idle;
    people.add(p);
  }
}

void PeopleSim::near(const dvec3& p, double r, std::vector<int>& out) const {
  out.clear();
  for (size_t i = 0; i < folk_.size(); i++) {
    const Folk& f = folk_[i];
    if (!f.active || f.downT > 0) continue;
    if (std::hypot(f.pos.x - p.x, f.pos.z - p.z) < r && std::fabs(f.pos.y - p.y) < 3) out.push_back(int(i));
  }
}

void PeopleSim::knock(int i, double vx, double vz) {
  Folk& f = folk_[size_t(i)];
  f.downT = 6; f.vx = vx; f.vz = vz; f.wait = 0;
  knocked++;
}

} // namespace sl
