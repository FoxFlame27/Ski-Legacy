#include "game/showroom.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "game/interiors.h"
#include "game/scenefx.h"
#include "engine/mesh_kit.h"
#include "player/player.h"
#include "world/scenery.h"
#include "world/transport.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
// carrentalroom.js SHOT: where the configurator's camera looks from, per step (round the car from its nose, pitch, how far)
constexpr double SHOT[4][3] = {{1.05, 0.24, 5.4}, {1.45, 0.06, 4.6}, {PI - 0.3, 0.12, 4.8}, {0.6, 0.22, 5.8}};
// carrental.js YARD.tow: the three TOW bays (lot frame: x, their z), towtruck.js: the truck's box (HALF_W, HALF_L x TRUCK_SCALE)
constexpr double TOW_X = 7.6, TOW_Z[3] = {3.4, 6.9, 10.4}, TRUCK_S = 5.25 / 4.5, TRUCK_HW = 1.17 * TRUCK_S, TRUCK_HL = 3.3 * TRUCK_S;
// carrentalshell.js LAYOUT / carrental.js YARD: the hall's middle in the lot's frame, its depth, the door's x
constexpr double HALL_Z = -7.9, HALL_D = 17.5;
// the windows' view: where the photographs are taken from in the hall (the room's frame: the middle, 4 m behind it, at
// eye height), the three sides (out of the glass front, out of the left and the right wall), each camera's field of
// view and how far its near plane lies (just outside that wall)
const dvec3 VIEW_EYE(0, 1.62, -4);
constexpr int NV = 3;
const dvec3 VIEW_N[NV] = {dvec3(0, 0, 1), dvec3(-1, 0, 0), dvec3(1, 0, 0)};
constexpr double VIEW_FOV[NV] = {72, 60, 60}, VIEW_NEAR[NV] = {HALL_D / 2 + 4 + 0.5, 16 + 0.65, 16 + 0.65};
// a display car's plate (carconfig.js setPlates: a random canton plate each): the same one every time for a model
std::string showPlate(const std::string& id) {
  static const char* CANTONS[] = {"VS", "GR", "BE", "UR", "OW", "TI", "ZH", "LU"};
  uint32_t h = 2166136261u;
  for (char ch : id) h = (h ^ uint8_t(ch)) * 16777619u;
  return std::string(CANTONS[(h >> 5) % 8]) + " " + std::to_string(1000 + (h >> 9) % 899000);
}
} // namespace

const RoomDef* Showroom::def() const { return rooms_.room() == Interiors::Room::Autohaus ? rooms_.def() : nullptr; }
bool Showroom::inside() const { return def() != nullptr; }

std::shared_ptr<Model> Showroom::part(const std::string& key) {
  if (key.empty() || !c_.roomModel) return nullptr;
  auto it = parts_.find(key);
  if (it != parts_.end()) return it->second;
  return parts_[key] = c_.roomModel(key);
}

// A model drawn mirrored (the floor's reflection): its triangles wind the other way round, so every material is drawn
// from both sides (the shader lights the side you see)
std::shared_ptr<Model> Showroom::twoSided(const std::shared_ptr<Model>& m) {
  if (!m) return nullptr;
  auto it = two_.find(m.get());
  if (it != two_.end()) return it->second;
  auto c = std::make_shared<Model>(*m);
  for (Material& q : c->materials) q.doubleSided = true;
  for (Material& q : c->lodMaterials) q.doubleSided = true;
  return two_[m.get()] = c;
}
const Model* Showroom::twoSided(const Model* m) {
  if (!m) return nullptr;
  auto it = two_.find(m);
  if (it != two_.end()) return it->second.get();
  auto c = std::make_shared<Model>(*m);
  for (Material& q : c->materials) q.doubleSided = true;
  for (Material& q : c->lodMaterials) q.doubleSided = true;
  two_[m] = c;
  return c.get();
}

std::string Showroom::displayPaint(const std::string& id) const {
  if (const RoomDef* d = def()) for (const RoomDef::Car& c : d->cars) if (c.id == id) return c.paintId;
  return "white";
}

// ---------------------------------------------------------------- per frame
void Showroom::update(double dt, bool talking, bool configOpen) {
  if (pending_) { wait_ += dt; if (wait_ > 1.2) finishEnter(); }   // (no dark moment to photograph in: in anyway)
  const RoomDef* d = def();
  if (!d) { was_ = false; if (cfg_.on) endConfigure(); guideId_.clear(); return; }
  const dvec3 p = rooms_.toLocal(c_.player->pos);
  if (!was_) {   // (carrentalroom.js enter: the doors open behind you, the salesman square to the room)
    was_ = true; doorT_ = 1; clerkYaw_ = d->clerkYaw; cfg_ = Cfg{}; guideId_.clear(); t_ = 0;
  }
  t_ += dt;
  if (cfg_.on && !configOpen) endConfigure();
  // the salesman: idle behind the desk, turning to you when you come close or while you talk
  if (d->hasClerk) {
    const bool near = talking || std::hypot(p.x - d->clerkX, p.z - d->clerkZ) < 6;
    const double want = near ? std::atan2(p.x - d->clerkX, p.z - d->clerkZ) : d->clerkYaw;
    clerkYaw_ += wrapPi(want - clerkYaw_) * (1 - std::exp(-dt * 4));
    rooms_.clerkYaw = clerkYaw_;
  }
  // the sliding doors: open as you come near them (and on the way in)
  if (!cfg_.on) {
    const bool nearDoor = !rooms_.upstairs() && p.y < 0.5 && std::fabs(p.x - d->door[0]) < 2.6 && p.z > d->D / 2 - 3.2;
    doorT_ += ((nearDoor ? 1.0 : 0.0) - doorT_) * (1 - std::exp(-dt * 5));
  }
  // the marker: it gives up after a while
  if (!guideId_.empty()) {
    guideT_ += dt; arrowYaw_ += dt * 1.6;
    if (guideT_ > 45) guideId_.clear();
  }
}

// ---------------------------------------------------------------- the salesman's tip
void Showroom::guide(const std::string& id) { guideId_ = id; guideT_ = 0; }

bool Showroom::recommend(uint32_t rnd, Tip& out) {
  const RoomDef* d = def();
  if (!d || d->cars.empty()) return false;
  std::vector<const RoomDef::Car*> pool;
  for (const RoomDef::Car& c : d->cars) if (d->cars.size() < 2 || c.id != lastTip_) pool.push_back(&c);
  const RoomDef::Car& c = *pool[rnd % pool.size()];
  lastTip_ = c.id;
  out.id = c.id; out.label = c.label; out.price = c.price; out.up = c.up;
  guide(c.id);
  return true;
}

// ---------------------------------------------------------------- the configurator's car and camera
void Showroom::configure(const CarCfg& cfg, int step) {
  const RoomDef* d = def();
  if (!d) return;
  int k = -1;
  for (size_t i = 0; i < d->cars.size(); i++) if (d->cars[i].id == cfg.id) { k = int(i); break; }
  if (k < 0) return;
  const bool first = !cfg_.on || cfg_.car != k;
  cfg_.on = true; cfg_.car = k; cfg_.cfg = cfg; cfg_.step = std::clamp(step, 0, 3);
  // (configure: every call puts the camera on the step's shot; dragging starts from there again)
  const double* s = SHOT[cfg_.step];
  cfg_.yaw = s[0]; cfg_.pitch = s[1]; cfg_.dist = s[2];
  if (first) cfg_.snap = true;
  guideId_.clear();
}

void Showroom::orbit(float dx, float dy) {
  if (!cfg_.on) return;
  cfg_.yaw -= dx; cfg_.pitch = clamp(cfg_.pitch + double(dy), 0.02, 0.75); cfg_.dragged = true;
}

void Showroom::endConfigure() { cfg_ = Cfg{}; }

void Showroom::camera(Camera& cam, double dt) {
  const RoomDef* d = def();
  if (!d) return;
  if (!cfg_.on || cfg_.car < 0 || size_t(cfg_.car) >= d->cars.size()) { cam.fovY = 70; return; }   // (on foot: carrentalroom.js's 70 degrees)
  const RoomDef::Car& T = d->cars[size_t(cfg_.car)];
  if (!cfg_.dragged) cfg_.yaw += dt * 0.06;   // (a slow drift round it)
  const double a = T.yaw + cfg_.yaw, y0 = T.up ? T.y : 0;
  dvec3 pos(T.x + std::sin(a) * cfg_.dist * std::cos(cfg_.pitch), y0 + (T.up ? 0 : 0.16) + 0.7 + std::sin(cfg_.pitch) * cfg_.dist, T.z + std::cos(a) * cfg_.dist * std::cos(cfg_.pitch));
  pos.x = clamp(pos.x, -d->W / 2 + 0.4, d->W / 2 - 0.4); pos.z = clamp(pos.z, -d->D / 2 + 0.4, d->D / 2 - 0.4);
  if (T.up) pos.y = std::max(y0 + 0.4, std::min(pos.y, d->H + d->RISE * std::max(0.0, 1 - std::fabs(pos.x) / (d->W / 2)) - 0.5));   // (under the roof: ceilingAt)
  else if (pos.z < d->MZ + 0.3) pos.y = std::min(pos.y, d->FL - 0.5);   // (under the mezzanine: below its floor)
  const dvec3 look(T.x, y0 + (cfg_.step == 1 ? 0.5 : 0.75), T.z);
  if (cfg_.snap) { cfg_.pos = pos; cfg_.at = look; cfg_.snap = false; }
  else { const double k = 1 - std::exp(-dt * 5); cfg_.pos += (pos - cfg_.pos) * k; cfg_.at += (look - cfg_.at) * k; }
  cam.fovY = 45; cam.nearZ = 0.05f;
  // (cfgCamera frames the car right of the panel: setViewOffset(W, H, -0.2 W, 0): what the camera looks at lands 0.4 of
  // the half width right of the middle. The camera here has no view offset: it is turned left by that much instead)
  const double shift = std::atan(0.4 * std::tan(double(cam.fovY) * DEG / 2) * double(cam.aspect));
  const dvec3 f = cfg_.at - cfg_.pos;
  const double cs = std::cos(shift), sn = std::sin(shift);
  const dvec3 f2(f.x * cs + f.z * sn, f.y, -f.x * sn + f.z * cs);
  cam.lookAt(rooms_.toWorld(cfg_.pos.x, cfg_.pos.y, cfg_.pos.z), rooms_.toWorld(cfg_.pos.x + f2.x, cfg_.pos.y + f2.y, cfg_.pos.z + f2.z));
}

// ---------------------------------------------------------------- drawing
void Showroom::draw(Renderer& r, SceneFx& sfx, gfx::Device& dev, const Camera& cam) {
  VehicleDraw& vd = vd_;
  const RoomDef* d = def();
  shown_ = 0;
  if (!d) return;
  const dvec3 o = rooms_.toWorld(0, 0, 0);
  const glm::dmat4 O = glm::translate(glm::dmat4(1), o);
  // the floor's reflection: everything once more, upside down under the floor (only with the floor's own tiles to lay
  // over it; from upstairs the mezzanine hides most of it, the same)
  if (!floor_ && !d->floorModel.empty()) floor_ = part(d->floorModel);
  const bool mirror = bool(floor_);
  const glm::dmat4 FLIP = O * glm::scale(glm::dmat4(1), dvec3(1, -1, 1));
  vd.begin();
  for (size_t i = 0; i < d->cars.size(); i++) {
    const RoomDef::Car& c = d->cars[i];
    const VehicleModel* vm = models_.car(c.id);
    if (!vm || !vm->ok()) continue;
    vec4 paint = c.paint;
    std::string plate = showPlate(c.id);
    // (the web game's display cars keep their models' own metal under the hall's bright environment map; this renderer
    // lights a room without one, where a bare metal body turns dark: they stand in their paint's finish, as a car you buy)
    vm = models_.dressed(vm, carPaintOf(c.paintId).finish, "orig");
    if (cfg_.on && cfg_.car == int(i)) {   // (your car, live: its paint, rims and plate as you click them)
      paint = paintColor(cfg_.cfg.paint);
      vm = models_.dressed(vm, carPaintOf(cfg_.cfg.paint).finish, cfg_.cfg.rims);
      if (!cfg_.cfg.plate.empty()) plate = cfg_.cfg.plate;
    }
    vd.addCar(*vm, O * c.M, 0, paint);
    CarPose pose;
    pose.vm = vm; pose.M = O * c.M; pose.plate = plate;
    sfx.plates(vd, pose);
    if (mirror) {
      if (vm->split()) {
        vd.add(twoSided(vm->body.get()), FLIP * c.M, 0, paint);
        for (const auto& w : vm->wheels) vd.add(twoSided(w.model.get()), FLIP * c.M * glm::translate(glm::dmat4(1), dvec3(w.c)), 0, paint);
      } else vd.add(twoSided(vm->model.get()), FLIP * c.M * glm::dmat4(vm->fit), 0, paint);
    }
    shown_++;
  }
  vd.submit(r, dev, cam.pos);
  // the sliding doors' leaves (setDoors: smoothstep of the eased t)
  const double open = doorT_ * doorT_ * (3 - 2 * doorT_);
  for (const RoomDef::Leaf& l : d->doors)
    if (auto m = part(l.model)) r.submitModel(*m, rooms_.toWorld(l.p.x + l.dir * l.slide * open, l.p.y, l.p.z), mat4(1), nullptr, false);
  // the salesman's marker over the car of the day
  if (!guideId_.empty())
    for (const RoomDef::Car& c : d->cars) {
      if (c.id != guideId_) continue;
      const double y0 = c.up ? c.y : 0, h = c.up ? 1.9 : c.z < d->MZ + 1 ? 1.75 : 2.2;   // (under the mezzanine: lower)
      if (auto m = part(d->markerArrow))
        r.submitModel(*m, rooms_.toWorld(c.x, y0 + 0.2 + h + std::sin(guideT_ * 3) * 0.12, c.z), glm::rotate(mat4(1), float(arrowYaw_), vec3(0, 1, 0)), nullptr, false);
      if (auto m = part(d->markerRing))
        r.submitModel(*m, rooms_.toWorld(c.x, y0 + 0.2, c.z), glm::scale(mat4(1), vec3(c.up ? 1.05f : 1.12f, 1, c.up ? 1.05f : 1.12f)), nullptr, false);
    }
  // the windows: the world photographed as you came in (none yet: a pale winter sky)
  if (!d->panes.empty() && !pane_[0]) for (int v = 0; v < NV; v++) buildPanes(v, 1, 1, gfx::Texture{});
  for (int v = 0; v < NV; v++) if (pane_[v]) {
    r.submitModel(*pane_[v], o, mat4(1), nullptr, false);
    if (mirror) r.submitModel(*pane_[v], o, glm::scale(mat4(1), vec3(1, -1, 1)), nullptr, false);
  }
  if (mirror) {
    if (auto room = twoSided(rooms_.roomMesh())) r.submitModel(*room, o, glm::scale(mat4(1), vec3(1, -1, 1)), nullptr, false);
    r.submitModel(*floor_, o, mat4(1), nullptr, false);
  }
}

// ---------------------------------------------------------------- the windows' view
dvec3 Showroom::hallToWorld(const dvec3& l) const {
  const Transport* t = c_.transport;
  const double fx = t->autohausDir.x, fz = t->autohausDir.y, lz = l.z + HALL_Z;
  return dvec3(t->autohaus.x + fz * l.x + fx * lz, t->autohaus.y + l.y, t->autohaus.z - fx * l.x + fz * lz);
}

void Showroom::requestEnter(std::function<void()> enter) {
  pending_ = std::move(enter);
  const bool can = c_.transport && c_.transport->hasAutohaus && c_.data && !c_.data->autohaus.panes.empty();
  capture_ = can ? 0 : 99; wait_ = 0; armed_ = false;
  if (!can) finishEnter();
}

void Showroom::finishEnter() {
  auto f = std::move(pending_);
  pending_ = nullptr; capture_ = 99; armed_ = false;
  if (f) f();
}

bool Showroom::captureCamera(Camera& cam, bool covered) {
  armed_ = false;
  if (!pending_ || capture_ < 0 || capture_ >= NV || !covered) return false;
  const dvec3 eye = hallToWorld(VIEW_EYE), to = hallToWorld(VIEW_EYE + VIEW_N[capture_]);
  cam.lookAt(eye, to);
  cam.fovY = float(VIEW_FOV[capture_]); cam.nearZ = float(VIEW_NEAR[capture_]);   // (the hall's own walls, glass and cars: in front of the near plane)
  armed_ = true;
  return true;
}

void Showroom::captured(Renderer& r) {
  if (!armed_) return;
  armed_ = false;
  std::vector<uint8_t> px;
  r.readPixels(px);
  const int W = r.width(), H = r.height();
  if (c_.dev && W > 8 && H > 8 && px.size() >= size_t(W) * size_t(H) * 4) {
    // box-filtered down to at most 2048 wide (the glass front fills the screen when you look out)
    const int k = std::max(1, (W + 2047) / 2048), w2 = W / k, h2 = H / k;
    std::vector<uint8_t> o(size_t(w2) * size_t(h2) * 4);
    for (int y = 0; y < h2; y++) for (int x = 0; x < w2; x++) {
      unsigned acc[3] = {0, 0, 0};
      for (int j = 0; j < k; j++) for (int i = 0; i < k; i++) { const uint8_t* q = &px[(size_t(y * k + j) * size_t(W) + size_t(x * k + i)) * 4]; acc[0] += q[0]; acc[1] += q[1]; acc[2] += q[2]; }
      uint8_t* q = &o[(size_t(y) * size_t(w2) + size_t(x)) * 4];
      for (int ch = 0; ch < 3; ch++) q[ch] = uint8_t(acc[ch] / unsigned(k * k));
      q[3] = 255;
    }
    gfx::TextureDesc td;
    td.width = w2; td.height = h2; td.format = gfx::TexFormat::SRGBA8; td.wrap = gfx::Wrap::Clamp;
    gfx::Texture tex = c_.dev->createTexture(td, o.data());
    const float tanV = float(std::tan(VIEW_FOV[capture_] * DEG / 2)), tanH = tanV * float(W) / float(H);
    buildPanes(capture_, tanH, tanV, tex);
  }
  SL_INFO("Autohaus: window view %d photographed (%d x %d)", capture_, W, H);
  if (++capture_ >= NV) finishEnter();
}

// One side's window planes as a mesh showing that side's photograph: by direction from where it was taken (the planes
// stand square to the camera: the mapping is flat)
void Showroom::buildPanes(int view, float tanH, float tanV, gfx::Texture tex) {
  const RoomDef* d = c_.data && c_.data->autohaus.ok ? &c_.data->autohaus : nullptr;
  if (!d || !c_.dev) return;
  if (paneTex_[view]) { c_.dev->destroy(paneTex_[view]); paneTex_[view] = gfx::Texture{}; }
  pane_[view].reset();
  const dvec3 n = VIEW_N[view], rt = glm::cross(n, dvec3(0, 1, 0));
  Geo g;
  for (const RoomDef::Pane& p : d->panes) {
    const dvec3 pn = dvec3(p.M * glm::dvec4(0, 0, 1, 0));
    if (glm::dot(pn, n) > -0.7) continue;   // (this side's planes face into the room: against its way out)
    const uint32_t base = uint32_t(g.pos.size());
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
      const dvec3 P = dvec3(p.M * glm::dvec4((i - 0.5) * p.w, (j - 0.5) * p.h, 0, 1)), q = P - VIEW_EYE;
      const double zc = std::max(0.2, glm::dot(q, n));
      g.pos.push_back(vec3(P)); g.nor.push_back(vec3(pn)); g.col.push_back(vec3(1));
      g.uv.push_back(vec2(float(0.5 + 0.5 * glm::dot(q, rt) / (zc * double(tanH))), float(0.5 + 0.5 * q.y / (zc * double(tanV)))));
    }
    g.idx.insert(g.idx.end(), {base, base + 1, base + 3, base, base + 3, base + 2});
  }
  if (g.idx.empty()) return;
  Material m;
  m.baseColor = vec4(0, 0, 0, 1); m.roughness = 1; m.metallic = 0; m.doubleSided = true;
  // (carrentalroom.js PORTAL_FRAG: the view x (0.94, 0.96, 0.97), a clean glass's faint cool tint; no view: a pale sky)
  m.emissive = tex ? vec3(0.94f, 0.96f, 0.97f) : vec3(0.62f, 0.72f, 0.84f);
  if (tex) m.emissiveTex = tex;
  paneTex_[view] = tex;
  pane_[view] = buildModel(*c_.dev, {{std::move(g), m}}, "autohaus_panes");
}

// ---------------------------------------------------------------- outside: the door, the tow trucks
bool Showroom::doorSpot(dvec3& p, dvec2& out) const {
  const Transport* t = c_.transport;
  const RoomDef* d = c_.data && c_.data->autohaus.ok ? &c_.data->autohaus : nullptr;
  if (!t || !t->hasAutohaus || !d) return false;
  const double fx = t->autohausDir.x, fz = t->autohausDir.y, lx = d->door[0], lz = HALL_Z + HALL_D / 2 + 1.3;
  p = dvec3(t->autohaus.x + fz * lx + fx * lz, t->autohaus.y, t->autohaus.z - fx * lx + fz * lz);
  out = dvec2(fx, fz);
  return true;
}

void Showroom::drawOutside(Renderer& r, gfx::Device& dev, const dvec3& cam) {
  const Transport* t = c_.transport;
  const double dist = t && t->hasAutohaus ? glm::length(dvec2(cam.x - t->autohaus.x, cam.z - t->autohaus.z)) : 1e9;
  if (dist > 420) return;
  // the cars on show behind the glass (carrental.js buildOutside showCar: where they stand inside, in their paints)
  if (const RoomDef* d = c_.data && c_.data->autohaus.ok && dist < 260 ? &c_.data->autohaus : nullptr) {
    const double fx0 = t->autohausDir.x, fz0 = t->autohausDir.y;
    const glm::dmat4 H = glm::translate(glm::dmat4(1), dvec3(t->autohaus)) * glm::rotate(glm::dmat4(1), std::atan2(fx0, fz0), dvec3(0, 1, 0)) * glm::translate(glm::dmat4(1), dvec3(0, 0, HALL_Z));
    vd_.begin();
    for (const RoomDef::Car& c : d->cars)
      if (const VehicleModel* vm = models_.dressed(models_.car(c.id), carPaintOf(c.paintId).finish, "orig")) vd_.addCar(*vm, H * c.M, dist < 70 ? 0 : 1, c.paint);
    vd_.submit(r, dev, cam);
  }
  if (!truckTried_) { truckTried_ = true; truck_ = c_.roomModel ? c_.roomModel("towtruck") : nullptr; if (!truck_) SL_WARN("Autohaus: no tow truck model in the play pack"); }
  if (!truck_) return;
  const double fx = t->autohausDir.x, fz = t->autohausDir.y, yaw = std::atan2(fx, fz) + PI / 2;
  for (double lz : TOW_Z) {
    const double x = t->autohaus.x + fz * TOW_X + fx * lz, z = t->autohaus.z - fx * TOW_X + fz * lz;
    r.submitModel(*truck_, dvec3(x, c_.world->height(x, z) + 0.02, z), glm::rotate(mat4(1), float(yaw), vec3(0, 1, 0)), nullptr, true);
  }
}

void Showroom::fillColliders(std::vector<Collider>& out, const dvec3& near) const {
  const Transport* t = c_.transport;
  if (!t || !t->hasAutohaus || !truck_ || glm::length(dvec2(near.x - t->autohaus.x, near.z - t->autohaus.z)) > 120) return;
  const double fx = t->autohausDir.x, fz = t->autohausDir.y, yaw = std::atan2(fx, fz) + PI / 2;
  for (double lz : TOW_Z) {
    Collider c;
    c.x = t->autohaus.x + fz * TOW_X + fx * lz; c.z = t->autohaus.z - fx * TOW_X + fz * lz;
    c.hw = TRUCK_HW; c.hd = TRUCK_HL; c.rot = -yaw;
    out.push_back(c);
  }
}

} // namespace sl
