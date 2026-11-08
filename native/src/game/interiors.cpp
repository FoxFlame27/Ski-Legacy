#include "game/interiors.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "game/play_data.h"
#include "player/player.h"
#include "world/world.h"
#include <cmath>

namespace sl {

namespace {
const vec4 PLASTER(0.78f, 0.74f, 0.66f, 1), LARCH(0.42f, 0.24f, 0.11f, 1), STONE(0.33f, 0.32f, 0.30f, 1), STEEL(0.30f, 0.32f, 0.35f, 1);
const vec4 BLOCK(0.55f, 0.56f, 0.55f, 1), OAK(0.50f, 0.33f, 0.17f, 1), LINO(0.62f, 0.66f, 0.63f, 1), WHITE(0.86f, 0.87f, 0.86f, 1), CEIL(0.80f, 0.78f, 0.72f, 1);
} // namespace

Interiors::Interiors(PlayCtx& c) : c_(c) {}

std::shared_ptr<Model> Interiors::model(const std::string& file, float, int) {
  for (auto& [n, m] : cache_) if (n == file) return m;
  ModelLoadOptions o;
  o.maxTextureSize = 512;
  auto m = c_.assets ? c_.assets->model(file, o) : nullptr;
  cache_.push_back({file, m});
  return m;
}

double Interiors::deck(double x, double z) const {
  if (room_ == Room::None) return std::nan("");
  double lx = x - origin_.x, lz = z - origin_.z;
  if (std::fabs(lx) > halfX.x + 2 || std::fabs(lz) > halfZ.x + 2) return std::nan("");
  return floorY_;
}

void Interiors::wallSeg(double ax, double az, double bx, double bz, double t, double y0, double y1, const vec4& col) {
  double L = std::hypot(bx - ax, bz - az);
  if (L < 0.01 || y1 - y0 < 0.01) return;
  Box b;
  b.c = vec3(float((ax + bx) / 2), float((y0 + y1) / 2), float((az + bz) / 2));
  b.h = vec3(float(t / 2), float((y1 - y0) / 2), float(L / 2));
  b.yaw = float(std::atan2(bx - ax, bz - az));
  b.col = col; b.solid = true; b.emissive = false;
  boxes.push_back(b);
}

void Interiors::buildPrison() {
  // prison.js ROOM / FRONT: the cell block (x -5.4 .. 9: three cells behind the bars at z -0.4) and the front office
  // (x 9 .. 17, to z 5.6), the barred gate between them, the front door at its far end (EXIT)
  halfX = vec2(11.3f); halfZ = vec2(4.8f);
  const double ox = 5.8, oz = 0.8;   // (local frame centred on the whole: the JS frame shifted)
  auto W = [&](double ax, double az, double bx, double bz, double t, double y1, const vec4& c) { wallSeg(ax - ox, az - oz, bx - ox, bz - oz, t, 0, y1, c); };
  ceiling = 3.4;
  W(-5.4, -4.0, 17.0, -4.0, 0.3, 3.6, BLOCK);
  W(-5.4, 3.6, 9.0, 3.6, 0.3, 3.3, BLOCK);
  W(9.0, 5.6, 17.0, 5.6, 0.3, 3.6, PLASTER);
  W(-5.4, -4.0, -5.4, 3.6, 0.3, 3.3, BLOCK);
  W(17.0, -4.0, 17.0, 1.9, 0.3, 3.6, PLASTER);
  W(17.0, 3.3, 17.0, 5.6, 0.3, 3.6, PLASTER);
  W(9.0, 3.6, 9.0, 5.6, 0.3, 3.6, PLASTER);
  W(9.0, -4.0, 9.0, 0.4, 0.3, 3.6, BLOCK);       // the cell block's end wall, the gate at z 0.4 .. 2.6
  for (double x : {-1.8, 1.8, 5.4}) W(x, -4.0, x, -0.4, 0.2, 3.3, BLOCK);
  // the bars: steel rods every 0.12 m along z -0.4 (the cell doors shut)
  for (double x = -5.3; x < 5.35; x += 0.12) {
    Box b; b.c = vec3(float(x - ox), 1.65f, float(-0.4 - oz)); b.h = vec3(0.012f, 1.65f, 0.012f); b.yaw = 0; b.col = STEEL; b.solid = false; b.emissive = false;
    boxes.push_back(b);
  }
  W(-5.4, -0.4, 5.4, -0.4, 0.06, 3.3, vec4(0, 0, 0, 0));   // (their collider: invisible)
  boxes.back().col = vec4(0);
  for (double z = 0.45; z < 2.6; z += 0.14) { Box b; b.c = vec3(float(9.0 - ox), 1.1f, float(z - oz)); b.h = vec3(0.012f, 1.1f, 0.012f); b.yaw = 0; b.col = STEEL; b.solid = false; b.emissive = false; boxes.push_back(b); }
  // the reception counter of stone and oak, benches, the fluorescent tubes
  { Box b; b.c = vec3(float(13 - ox), 0.55f, float(-0.55 - oz)); b.h = vec3(3.2f, 0.55f, 0.35f); b.yaw = 0; b.col = OAK; b.solid = true; b.emissive = false; boxes.push_back(b); }
  { Box b; b.c = vec3(float(13 - ox), 0.25f, float(4.9 - oz)); b.h = vec3(1.5f, 0.25f, 0.3f); b.yaw = 0; b.col = LARCH; b.solid = true; b.emissive = false; boxes.push_back(b); }
  for (double x : {-3.6, 0.0, 3.6, 13.0}) { Box b; b.c = vec3(float(x - ox), 3.15f, float(-2.0 - oz)); b.h = vec3(0.6f, 0.03f, 0.08f); b.yaw = 0; b.col = vec4(1, 1, 0.95f, 1); b.solid = false; b.emissive = true; boxes.push_back(b); }
  // floor and ceiling
  { Box b; b.c = vec3(float(5.8 - ox), -0.05f, float(0.8 - oz)); b.h = vec3(11.4f, 0.05f, 4.9f); b.yaw = 0; b.col = STONE; b.solid = false; b.emissive = false; boxes.push_back(b); }
  { Box b; b.c = vec3(float(5.8 - ox), 3.45f, float(0.8 - oz)); b.h = vec3(11.4f, 0.05f, 4.9f); b.yaw = 0; b.col = CEIL; b.solid = false; b.emissive = false; boxes.push_back(b); }
  // the cells' furniture: a bunk, a steel toilet (prisoncell.js), the guard's desk, the visiting desk
  for (double x : {-3.6, 0.0, 3.6}) {
    if (auto m = model("prison/bunk_bed", 0, 0)) props.push_back({m, m->fitTransform(2.0f, 3), dvec3(x - 0.9 - ox, 0, -3.3 - oz), PI / 2, true, vec2(1.0f, 0.45f)});
    if (auto m = model("prison/cell_toilet", 0, 0)) props.push_back({m, m->fitTransform(0.7f, 1), dvec3(x + 1.2 - ox, 0, -3.5 - oz), 0, true, vec2(0.3f)});
  }
  if (auto m = model("prison/guard_desk", 0, 0)) props.push_back({m, m->fitTransform(1.6f, 3), dvec3(7.4 - ox, 0, 2.8 - oz), PI, true, vec2(0.8f, 0.4f)});
  if (auto m = model("prison/visit_desk", 0, 0)) props.push_back({m, m->fitTransform(1.6f, 3), dvec3(-3.6 - ox, 0, 1.2 - oz), 0, true, vec2(0.8f, 0.35f)});
  exitLocal = dvec3(16.6 - ox, 0, 2.6 - oz);
  spawnLocal = dvec3(15.6 - ox, 0, 2.6 - oz);
  spawnYaw = -PI / 2;
  lightTint = vec3(0.92f, 0.96f, 1.0f);
}

void Interiors::buildHospital() {
  // hospitalroom.js: the WARD behind (z -5.8 .. 1.7) through a wide opening, the LOBBY at the front (z 1.9 .. 5.8)
  halfX = vec2(7.2f); halfZ = vec2(6.0f);
  ceiling = 3.0;
  wallSeg(-7, -5.9, 7, -5.9, 0.2, 0, 3, PLASTER);
  wallSeg(-7, 5.9, -1.2, 5.9, 0.2, 0, 3, PLASTER);
  wallSeg(1.2, 5.9, 7, 5.9, 0.2, 0, 3, PLASTER);
  wallSeg(-7.1, -5.9, -7.1, 5.9, 0.2, 0, 3, PLASTER);
  wallSeg(7.1, -5.9, 7.1, 5.9, 0.2, 0, 3, PLASTER);
  wallSeg(-7, 1.8, -2.5, 1.8, 0.15, 0, 3, LARCH);
  wallSeg(2.5, 1.8, 7, 1.8, 0.15, 0, 3, LARCH);
  { Box b; b.c = vec3(0, -0.05f, 0); b.h = vec3(7.2f, 0.05f, 6.0f); b.yaw = 0; b.col = LINO; b.solid = false; b.emissive = false; boxes.push_back(b); }
  { Box b; b.c = vec3(0, 3.05f, 0); b.h = vec3(7.2f, 0.05f, 6.0f); b.yaw = 0; b.col = WHITE; b.solid = false; b.emissive = false; boxes.push_back(b); }
  for (double x : {-5.1, -1.7, 1.7, 5.1}) {
    if (auto m = model("hospital/hospital_bed", 0, 0)) props.push_back({m, m->fitTransform(2.1f, 3), dvec3(x, 0, -4.6), PI, true, vec2(0.5f, 1.05f)});
    else { Box b; b.c = vec3(float(x), 0.3f, -4.6f); b.h = vec3(0.5f, 0.3f, 1.05f); b.yaw = 0; b.col = WHITE; b.solid = true; b.emissive = false; boxes.push_back(b); }
    if (auto m = model("hospital/bedside_cabinet", 0, 0)) props.push_back({m, m->fitTransform(0.8f, 1), dvec3(x + 0.95, 0, -5.4), PI, true, vec2(0.25f)});
    if (auto m = model("hospital/iv_stand", 0, 0)) props.push_back({m, m->fitTransform(1.9f, 1), dvec3(x - 0.9, 0, -5.2), 0, false, vec2(0.2f)});
    { Box b; b.c = vec3(float(x), 2.95f, -4.6f); b.h = vec3(0.5f, 0.03f, 0.12f); b.yaw = 0; b.col = vec4(1, 0.96f, 0.88f, 1); b.solid = false; b.emissive = true; boxes.push_back(b); }
  }
  if (auto m = model("hospital/reception_desk", 0, 0)) props.push_back({m, m->fitTransform(2.4f, 3), dvec3(-4.0, 0, 3.6), PI / 2, true, vec2(0.5f, 1.2f)});
  if (auto m = model("hospital/waiting_bench", 0, 0)) props.push_back({m, m->fitTransform(1.8f, 3), dvec3(4.5, 0, 5.2), PI, true, vec2(0.9f, 0.3f)});
  if (auto m = model("hospital/medicine_cabinet", 0, 0)) props.push_back({m, m->fitTransform(1.9f, 1), dvec3(6.6, 0, -1.0), -PI / 2, true, vec2(0.3f, 0.5f)});
  exitLocal = dvec3(0, 0, 5.5);
  spawnLocal = dvec3(-1.7 + 0.9, 0, -3.6);
  spawnYaw = 0;
  lightTint = vec3(1.0f, 0.96f, 0.9f);
}

void Interiors::buildChalet() {
  // chaletroom.js on chaletplan.js: the ground floor's walls (split at the windows and doors), oak floor, larch ceiling
  const PlayData& D = *c_.data;
  const auto& M = D.chaletModel;
  double G = D.chaletPlan.floorY;
  halfX = vec2(float(M.IX)); halfZ = vec2(float(M.IZ));
  ceiling = D.chaletPlan.ceilingY - G;
  for (const ChaletWall& w : D.chaletPlan.walls) wallSeg(w.ax, w.az, w.bx, w.bz, w.t, w.y0 - G, w.y1 - G, w.t > 0.2 ? PLASTER : vec4(0.86f, 0.80f, 0.70f, 1));
  { Box b; b.c = vec3(0, -0.05f, 0); b.h = vec3(float(M.HX), 0.05f, float(M.HZ)); b.yaw = 0; b.col = OAK; b.solid = false; b.emissive = false; boxes.push_back(b); }
  { Box b; b.c = vec3(0, float(ceiling + 0.05), 0); b.h = vec3(float(M.HX), 0.05f, float(M.HZ)); b.yaw = 0; b.col = LARCH; b.solid = false; b.emissive = false; boxes.push_back(b); }
  // the stair's run (chaletplan.js STAIR) as a block
  for (const Rect2& r : D.chaletPlan.blocks) {
    if (r.z1 - r.z0 < 2) continue;   // (the door's swing is not solid)
    Box b; b.c = vec3(float((r.x0 + r.x1) / 2), 0.8f, float((r.z0 + r.z1) / 2)); b.h = vec3(float((r.x1 - r.x0) / 2), 0.8f, float((r.z1 - r.z0) / 2)); b.yaw = 0; b.col = LARCH; b.solid = true; b.emissive = false; boxes.push_back(b);
  }
  exitLocal = dvec3(M.IX - 0.35, 0, M.doorZ);
  spawnLocal = dvec3(M.IX - 1.1, 0, M.doorZ);
  spawnYaw = -PI / 2;
  lightTint = vec3(1.0f, 0.84f, 0.62f);
}

void Interiors::rebuild() {
  std::vector<std::pair<Geo, Material>> parts;
  Geo all, glow;
  for (const Box& b : boxes) {
    if (b.col.w <= 0) continue;
    Geo g = boxGeo(2 * b.h.x, 2 * b.h.y, 2 * b.h.z);
    g.col.assign(g.pos.size(), vec3(b.col));
    g.transform(glm::translate(mat4(1), b.c) * glm::rotate(mat4(1), b.yaw, vec3(0, 1, 0)));
    (b.emissive ? glow : all).append(g);
  }
  Material m; m.metallic = 0; m.roughness = 0.85f; m.vertexColor = true;
  if (!all.empty()) parts.push_back({std::move(all), m});
  Material e = m; e.emissive = vec3(3.0f);
  if (!glow.empty()) parts.push_back({std::move(glow), e});
  mesh_.reset();
  if (!parts.empty() && c_.dev) mesh_ = buildModel(*c_.dev, parts, "interior");
}

void Interiors::enter(Room r, std::function<void()> onLeave) {
  room_ = r;
  onLeave_ = std::move(onLeave);
  boxes.clear(); props.clear();
  origin_ = dvec3(r == Room::Prison ? -21000 : r == Room::Hospital ? -21100 : -21200, 0, -21000);
  floorY_ = c_.world->height(origin_.x, origin_.z) + 80;
  if (r == Room::Prison) buildPrison();
  else if (r == Room::Hospital) buildHospital();
  else buildChalet();
  rebuild();
  c_.scenery->noTrees = true;
  Player& pl = *c_.player;
  prevView_ = int(pl.view);
  pl.setSkisOn(false);
  dvec3 sp = toWorld(spawnLocal.x, 0, spawnLocal.z);
  if (pl.mode == PlayerMode::Sit) pl.standUp(sp.x, sp.z, spawnYaw);
  pl.teleport(sp.x, sp.z, spawnYaw);
  pl.pos.y = floorY_; pl.prevPos = pl.renderPos = pl.pos;
  pl.view = Player::View::First;
}

void Interiors::leave() {
  if (room_ == Room::None) return;
  room_ = Room::None;
  c_.scenery->noTrees = false;
  c_.player->view = Player::View(prevView_);
  mesh_.reset();
  auto f = std::move(onLeave_);
  onLeave_ = nullptr;
  if (f) f();
}

bool Interiors::atExit(const dvec3& p) const {
  if (room_ == Room::None) return false;
  dvec3 l = toLocal(p);
  return std::hypot(l.x - exitLocal.x, l.z - exitLocal.z) < 1.4;
}

void Interiors::fillColliders(std::vector<Collider>& out) const {
  if (room_ == Room::None) return;
  for (const Box& b : boxes) {
    if (!b.solid) continue;
    Collider c;
    c.x = origin_.x + b.c.x; c.z = origin_.z + b.c.z;
    c.hw = b.h.x; c.hd = b.h.z; c.rot = -b.yaw;
    c.top = floorY_ + b.c.y + b.h.y;
    if (b.c.y + b.h.y < 0.25) continue;   // (floor slabs)
    if (b.c.y - b.h.y > 1.6) continue;    // (lintels over doors and windows)
    out.push_back(c);
  }
  for (const Prop& p : props) {
    if (!p.solid) continue;
    Collider c;
    c.x = origin_.x + p.local.x; c.z = origin_.z + p.local.z;
    c.hw = p.half.x; c.hd = p.half.y; c.rot = -p.yaw;
    c.top = floorY_ + 0.6;
    out.push_back(c);
  }
}

void Interiors::draw(Renderer& r) {
  if (room_ == Room::None) return;
  dvec3 o = toWorld(0, 0, 0);
  if (mesh_) r.submitModel(*mesh_, o, mat4(1), nullptr, true);
  for (const Prop& p : props) {
    if (!p.model) continue;
    dvec3 w = toWorld(p.local.x, p.local.y, p.local.z);
    r.submitModel(*p.model, w, glm::rotate(mat4(1), float(p.yaw), vec3(0, 1, 0)) * p.fit, nullptr, true);
  }
}

Lighting Interiors::lighting(const Lighting& outside) const {
  Lighting L = outside;
  L.sunDir = glm::normalize(vec3(0.3f, 0.9f, 0.2f));
  L.sunColor = lightTint;
  L.sunIntensity = 1.2f * lightLevel;
  L.sky = lightTint * 0.55f * lightLevel;
  L.ground = lightTint * 0.38f * lightLevel;
  L.fogDensity = 0;
  L.night = 1;   // (lit windows / lamps glow)
  return L;
}

} // namespace sl
