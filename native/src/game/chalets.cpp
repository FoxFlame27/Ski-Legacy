#include "game/chalets.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/asset_manager.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/economy.h"
#include "game/menus.h"
#include "game/play_data.h"
#include "game/shapes.h"
#include "player/player.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>

namespace sl {

namespace {
constexpr double REACH = 6, GRID = 0.25, DOOR_R = 2.6;
int uiW = 1280, uiH = 720;
double snap(double v, double g = GRID) { return std::round(v / g) * g; }
// placement.js: oriented footprints { x, z, hw, hd, rot } (rot about +y, model front +z)
struct Foot { double x, z, hw, hd, rot; };
void corners(const Foot& f, double out[4][2]) {
  double c = std::cos(f.rot), s = std::sin(f.rot);
  double ux[2] = {c, -s}, uz[2] = {s, c};
  int k = 0;
  for (auto [a, b] : {std::pair{1, 1}, {1, -1}, {-1, -1}, {-1, 1}}) { out[k][0] = f.x + ux[0] * f.hw * a + uz[0] * f.hd * b; out[k][1] = f.z + ux[1] * f.hw * a + uz[1] * f.hd * b; k++; }
}
bool overlap(const Foot& a, const Foot& b, double tol = 0.01) {
  double ca[4][2], cb[4][2];
  corners(a, ca); corners(b, cb);
  for (const Foot* f : {&a, &b}) {
    double c = std::cos(f->rot), s = std::sin(f->rot);
    double axes[2][2] = {{c, -s}, {s, c}};
    for (auto& ax : axes) {
      double a0 = 1e30, a1 = -1e30, b0 = 1e30, b1 = -1e30;
      for (auto& p : ca) { double v = p[0] * ax[0] + p[1] * ax[1]; a0 = std::min(a0, v); a1 = std::max(a1, v); }
      for (auto& p : cb) { double v = p[0] * ax[0] + p[1] * ax[1]; b0 = std::min(b0, v); b1 = std::max(b1, v); }
      if (a1 - tol <= b0 || b1 - tol <= a0) return false;
    }
  }
  return true;
}
bool hitsWall(const Foot& f, const ChaletWall& w, double tol = 0.01) {
  double c = std::cos(f.rot), s = std::sin(f.rot);
  auto loc = [&](double x, double z) { double dx = x - f.x, dz = z - f.z; return std::pair{dx * c + dz * -s, dx * s + dz * c}; };
  auto [px, pz] = loc(w.ax, w.az);
  auto [qx, qz] = loc(w.bx, w.bz);
  double h = w.t / 2 - tol, ex = f.hw + h, ez = f.hd + h, t0 = 0, t1 = 1;
  double P[2][3] = {{px, qx - px, ex}, {pz, qz - pz, ez}};
  for (auto& q : P) {
    double p = q[0], d = q[1], e = q[2];
    if (std::fabs(d) < 1e-9) { if (p < -e || p > e) return false; continue; }
    double a = (-e - p) / d, b = (e - p) / d;
    if (a > b) std::swap(a, b);
    t0 = std::max(t0, a); t1 = std::min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}
} // namespace

Chalets::Chalets(PlayCtx& c, Interiors& rooms) : c_(c), rooms_(rooms) {}

void Chalets::load(AssetManager& assets) {
  ModelLoadOptions o;
  o.maxTextureSize = 1024;
  hi_ = assets.model("chalet", o);
  lo_ = assets.model("chalet_lo", o);
  if (c_.data) {
    const auto& M = c_.data->chaletModel;
    double S = M.scale;
    houseLocal_ = glm::scale(mat4(1), vec3(float(S))) * glm::translate(mat4(1), vec3(float(-M.x), float(-M.y), float(-M.z)));
  }
}

bool Chalets::owned() const { return ownedHouse() >= 0; }
int Chalets::insidePlot() const { return inside() && insideHouse_ >= 0 ? c_.data->chalets[size_t(insideHouse_)].id : -1; }
int Chalets::ownedHouse() const {
  const nlohmann::json& ch = c_.save->data("chalet");
  if (!ch.is_object() || !ch.value("owned", false) || !ch.contains("id")) return -1;
  int id = ch["id"].is_number() ? ch["id"].get<int>() : -1;
  for (size_t i = 0; i < c_.data->chalets.size(); i++) if (c_.data->chalets[i].id == id) return int(i);
  return -1;
}
int Chalets::furnitureCount() const {
  const nlohmann::json& ch = c_.save->data("chalet");
  return ch.contains("furniture") && ch["furniture"].is_array() ? int(ch["furniture"].size()) : 0;
}

int Chalets::houseNear(const dvec3& p, double r) const {
  for (size_t i = 0; i < c_.data->chalets.size(); i++) {
    const ChaletHouse& h = c_.data->chalets[i];
    if (std::hypot(p.x - h.doorX, p.z - h.doorZ) < r) return int(i);
  }
  return -1;
}

bool Chalets::buy(int i) {
  if (i < 0 || owned()) return false;
  if (c_.buyChalet) {   // (Phase 6) multiplayer: the server sells it (one each, the plot free) and takes the money
    const ChaletHouse& h = c_.data->chalets[size_t(i)];
    c_.buyChalet(h.id, h.name, [this, i](bool ok) {
      if (!ok) return;
      c_.flash(c_.data->chalets[size_t(i)].name + " is yours \xC2\xB7 unfurnished: " + c_.K(Action::Furnish) + " inside to furnish it", 2);
      goInside(i);
    });
    return false;
  }
  if (!c_.spend(c_.data->chaletPrice)) return false;
  const ChaletHouse& h = c_.data->chalets[size_t(i)];
  nlohmann::json& ch = c_.save->data("chalet");
  ch = {{"id", h.id}, {"name", h.name}, {"owned", true}, {"since", c_.save->day}, {"furniture", nlohmann::json::array()}, {"layout", 3}, {"plan", 2}};
  c_.save->markDirty();
  c_.flash(h.name + " is yours \xC2\xB7 unfurnished: " + c_.K(Action::Furnish) + " inside to furnish it", 2);
  SL_INFO("chalets: bought %s for $%d", h.name.c_str(), c_.data->chaletPrice);
  return true;
}

void Chalets::goInside(int i) {
  if (i < 0) return;
  const ChaletHouse& h = c_.data->chalets[size_t(i)];
  insideHouse_ = i;
  if (c_.fade) c_.fade();
  double ox = h.doorX + std::cos(h.yaw) * 1.5 * 0 + std::sin(h.yaw + PI / 2) * 1.2, oz = h.doorZ + std::cos(h.yaw + PI / 2) * 1.2;
  double heading = h.yaw + PI / 2;
  rooms_.enter(Interiors::Room::Chalet, [this, ox, oz, heading]() { build_ = false; vmouse_ = false; insideHouse_ = -1; visiting_ = false; if (c_.fade) c_.fade(); c_.teleport(ox, oz, heading, false); });
  rebuildFurniture();
}

const Chalets::Fit* Chalets::fitFor(const FurnitureDef& d) {
  for (auto& [k, f] : fits_) if (k == d.id) return &f;
  Fit f;
  ModelLoadOptions o;
  o.maxTextureSize = 512;
  f.model = c_.assets->model("furniture/" + d.id, o);
  vec3 raw = f.model ? f.model->bmax - f.model->bmin : d.size;
  vec3 mid = f.model ? (f.model->bmax + f.model->bmin) * 0.5f : vec3(0);
  float mny = f.model ? f.model->bmin.y : 0;
  // placement.js fitScales: lay a rug modelled standing up flat, turn it when its long side is the other way, height exact
  float dx = raw.x, dy = raw.y, dz = raw.z, w = d.size.x, h = d.size.y, dd = d.size.z;
  bool layFlat = d.flat && dy > dz * 2;
  if (layFlat) std::swap(dy, dz);
  bool turn = (w > dd * 1.3f && dz > dx * 1.3f) || (dd > w * 1.3f && dx > dz * 1.3f);
  if (turn) std::swap(dx, dz);
  vec3 sc;
  if (d.flat) { float s = std::sqrt((w / std::max(dx, 1e-3f)) * (dd / std::max(dz, 1e-3f))); sc = vec3(s, std::min(s, h / std::max(dy, 1e-3f)), s); }
  else {
    float sy = h / std::max(dy, 1e-3f);
    auto cl = [&](float v) { return std::min(sy * 1.3f, std::max(sy * 0.77f, v)); };
    float sz = d.place == "wall" ? std::min(cl(dd / std::max(dz, 1e-3f)), dd / std::max(dz, 1e-3f)) : cl(dd / std::max(dz, 1e-3f));
    sc = vec3(cl(w / std::max(dx, 1e-3f)), sy, sz);
  }
  mat4 R(1);
  if (turn) R = glm::rotate(mat4(1), float(PI / 2), vec3(0, 1, 0));
  if (layFlat) R = R * glm::rotate(mat4(1), float(-PI / 2), vec3(1, 0, 0));
  // centre on x / z, the bottom on y 0 after the rotations; wall items: the back against the wall (z 0)
  vec3 mn(1e30f), mx(-1e30f);
  vec3 b0 = f.model ? f.model->bmin : -d.size * 0.5f, b1 = f.model ? f.model->bmax : d.size * 0.5f;
  for (int k = 0; k < 8; k++) { vec3 p((k & 1) ? b1.x : b0.x, (k & 2) ? b1.y : b0.y, (k & 4) ? b1.z : b0.z); vec3 q = vec3(R * vec4(p, 1)); mn = glm::min(mn, q); mx = glm::max(mx, q); }
  vec3 c = (mn + mx) * 0.5f;
  float zoff = d.place == "wall" ? -mn.z : -c.z;
  f.local = glm::scale(mat4(1), sc) * glm::translate(mat4(1), vec3(-c.x, -mn.y, zoff)) * R;
  f.dims = (mx - mn) * sc;
  (void)mid; (void)mny;
  fits_.push_back({d.id, f});
  return &fits_.back().second;
}

void Chalets::rebuildFurniture() {
  if (!inside()) return;
  // the room's own props stay; the furniture is re-added from the save
  rooms_.props.clear();
  const nlohmann::json& own = c_.save->data("chalet");
  nlohmann::json guest = {{"furniture", guestFurniture_}};
  const nlohmann::json& ch = visiting_ ? guest : own;   // (Phase 6: visiting, the owner's furniture)
  if (!ch.contains("furniture") || !ch["furniture"].is_array()) return;
  double G = c_.data->chaletPlan.floorY;
  int idx = 0;
  for (auto& r : ch["furniture"]) {
    const FurnitureDef* d = c_.data->furnitureById(r.value("id", std::string()));
    if (!d || idx == moving_) { idx++; continue; }
    const Fit* f = fitFor(*d);
    Interiors::Prop p;
    p.model = f->model; p.fit = f->local;
    p.local = dvec3(r.value("x", 0.0), r.value("y", G) - G, r.value("z", 0.0));
    p.yaw = r.value("rot", 0.0);
    p.solid = !d->flat && d->place == "floor" && !d->small;
    p.half = vec2(f->dims.x / 2, f->dims.z / 2);
    p.lamp = d->light > 0;
    rooms_.props.push_back(p);
    idx++;
  }
}

bool Chalets::valid(const FurnitureDef& d, double x, double z, double rot, int skip, double& y) const {
  const auto& P = c_.data->chaletPlan;
  auto it = std::find_if(fits_.begin(), fits_.end(), [&](auto& e) { return e.first == d.id; });
  vec3 dims = it != fits_.end() ? it->second.dims : d.size;
  y = d.place == "wall" ? d.mount : d.place == "ceiling" ? rooms_.ceiling - dims.y : 0;
  Foot f{x, z, dims.x / 2, dims.z / 2, rot};
  if (d.place == "wall") return true;   // (hung on the wall the ray found)
  double cs[4][2];
  corners(f, cs);
  auto onFloor = [&](double px, double pz) { for (const Rect2& r : P.rects) if (px >= r.x0 - 0.02 && px <= r.x1 + 0.02 && pz >= r.z0 - 0.02 && pz <= r.z1 + 0.02) return true; return false; };
  if (!onFloor(x, z)) return false;
  for (auto& c : cs) if (!onFloor(c[0], c[1])) return false;
  if (d.place == "ceiling") return true;
  for (const ChaletWall& w : P.walls) if (w.y0 - P.floorY < dims.y && hitsWall(f, w)) return false;
  for (const Rect2& b : P.blocks) { Foot bf{(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, (b.x1 - b.x0) / 2, (b.z1 - b.z0) / 2, 0}; if (overlap(f, bf)) return false; }
  if (d.flat) return true;
  const nlohmann::json& ch = c_.save->data("chalet");
  int i = 0;
  if (ch.contains("furniture"))
    for (auto& r : ch["furniture"]) {
      if (i++ == skip) continue;
      const FurnitureDef* o = c_.data->furnitureById(r.value("id", std::string()));
      if (!o || o->flat || o->place != "floor") continue;
      auto jt = std::find_if(fits_.begin(), fits_.end(), [&](auto& e) { return e.first == o->id; });
      vec3 od = jt != fits_.end() ? jt->second.dims : o->size;
      if (overlap(f, Foot{r.value("x", 0.0), r.value("z", 0.0), od.x / 2, od.z / 2, r.value("rot", 0.0)})) {
        if (d.small) { y = od.y; return true; }   // (small decor sits on top of furniture)
        return false;
      }
    }
  return true;
}

bool Chalets::place(const std::string& id, double lx, double lz, double rot) {
  const FurnitureDef* d = c_.data->furnitureById(id);
  if (!d || !owned()) return false;
  fitFor(*d);
  double y = 0;
  if (!valid(*d, lx, lz, rot, moving_, y)) return false;
  nlohmann::json& ch = c_.save->data("chalet");
  if (!ch["furniture"].is_array()) ch["furniture"] = nlohmann::json::array();
  double G = c_.data->chaletPlan.floorY;
  nlohmann::json rec = {{"id", id}, {"x", std::round(lx * 1000) / 1000}, {"y", std::round((y + G) * 1000) / 1000}, {"z", std::round(lz * 1000) / 1000}, {"rot", std::round(rot * 1000) / 1000}};
  if (d->light > 0) rec["on"] = true;
  if (moving_ >= 0 && moving_ < int(ch["furniture"].size())) { ch["furniture"][size_t(moving_)] = rec; moving_ = -1; }
  else {
    if (!c_.spend(d->price)) return false;
    ch["furniture"].push_back(rec);
  }
  c_.save->markDirty();
  rebuildFurniture();
  c_.flash(d->name + " placed", 2);
  return true;
}

void Chalets::sell(int i) {
  nlohmann::json& ch = c_.save->data("chalet");
  if (!ch["furniture"].is_array() || i < 0 || i >= int(ch["furniture"].size())) return;
  const FurnitureDef* d = c_.data->furnitureById(ch["furniture"][size_t(i)].value("id", std::string()));
  int refund = d ? int(std::round(d->price * c_.data->sellRefund)) : 0;
  ch["furniture"].erase(size_t(i));
  if (c_.earnFrom) c_.earnFrom(refund, "sell"); else c_.earn(refund);
  c_.save->markDirty();
  rebuildFurniture();
  c_.flash((d ? d->name : std::string("Furniture")) + " sold \xC2\xB7 +" + fmtMoney(refund), 0);
}

void Chalets::toggleBuild() {
  if (!inside() || ownedHouse() != insideHouse_) return;
  build_ = !build_;
  hand_.clear(); moving_ = -1; vmouse_ = false;
  if (build_) c_.flash("BUILD MODE \xC2\xB7 " + c_.K(Action::PrevItem) + " / " + c_.K(Action::NextItem) + " browse \xC2\xB7 " + c_.K(Action::Jump) + " place \xC2\xB7 " + c_.K(Action::Pickup) + " move \xC2\xB7 " + c_.K(Action::Alt) + " sell", 0);
  rebuildFurniture();
}

bool Chalets::interact(std::string& prompt, bool pressed) {
  if (!c_.data || c_.data->chalets.empty()) return false;
  if (inside()) {
    if (build_) return false;
    if (rooms_.atExit(c_.player->pos)) { prompt = "Leave the chalet"; if (pressed) rooms_.leave(); return true; }
    if (ownedHouse() == insideHouse_) { prompt = "Furnish \xC2\xB7 " + c_.K(Action::Furnish); return false; }
    return false;
  }
  if (rooms_.inside()) return false;
  int i = houseNear(c_.player->pos, DOOR_R);
  if (i < 0) return false;
  const ChaletHouse& h = c_.data->chalets[size_t(i)];
  int mine = ownedHouse();
  if (mine == i) { prompt = h.name + " \xC2\xB7 go inside"; if (pressed) goInside(i); return true; }
  // (Phase 6) another player's chalet: ask them (they get Y / N), then in you go with their furniture
  std::string other = c_.chaletOwner ? c_.chaletOwner(h.id) : "";
  if (!other.empty()) {
    prompt = other + "'s chalet \xC2\xB7 ask to visit";
    if (pressed && c_.visitChalet) {
      c_.flash("Asking " + other + " to let you in...", 0);
      c_.visitChalet(h.id, other, [this, i](bool ok, const nlohmann::json& furniture) {
        if (!ok) return;
        guestFurniture_ = furniture.is_array() ? furniture : nlohmann::json::array();
        visiting_ = true;
        goInside(i);
      });
    }
    return true;
  }
  if (mine >= 0) { prompt = h.name; if (pressed) c_.flash("You already own " + c_.data->chalets[size_t(mine)].name + " (one each)", 1); return true; }
  prompt = h.name + " for sale \xC2\xB7 " + fmtMoney(c_.data->chaletPrice);
  if (pressed) {
    Dialog d;
    d.kicker = "Chalet village \xC2\xB7 " + fmtMoney(c_.data->chaletPrice);
    d.title = h.name;
    d.say = "Two storeys under a snowy roof, a garden inside its picket fence, a private parking space. Yours for good.";
    DialogOption b; b.label = "Buy this chalet"; b.sub = "Yours for good \xC2\xB7 unfurnished: you furnish it yourself"; b.price = c_.data->chaletPrice;
    b.disabled = c_.save->money < c_.data->chaletPrice;
    b.act = [this, i]() { if (buy(i)) goInside(i); };
    DialogOption l; l.label = "Have a look inside"; l.act = [this, i]() { goInside(i); };
    DialogOption n; n.label = "Not now"; n.secondary = true;
    d.options = {b, l, n};
    c_.menus->openDialog(d);
  }
  return true;
}

void Chalets::update(double, const Camera& cam, const UiNav& nav) {
  ghostOn_ = false; hover_ = -1;
  if (!inside()) { build_ = false; return; }
  Input& in = *c_.input;
  if (in.takePressed(Action::Furnish)) toggleBuild();
  if (!build_) return;
  const PlayData& D = *c_.data;
  // the catalogue: [ ] browse (across the rooms' tabs)
  std::vector<const FurnitureDef*> items;
  auto catItems = [&](int ci) { std::vector<const FurnitureDef*> v; for (auto& f : D.furniture) if (ci < int(D.categories.size()) && f.category == D.categories[size_t(ci)].first) v.push_back(&f); return v; };
  items = catItems(cat_);
  if (in.takePressed(Action::NextItem)) { if (++item_ >= int(items.size())) { item_ = 0; cat_ = (cat_ + 1) % std::max<int>(1, int(D.categories.size())); } items = catItems(cat_); if (!items.empty()) hand_ = items[size_t(item_)]->id; moving_ = -1; }
  if (in.takePressed(Action::PrevItem)) { if (--item_ < 0) { cat_ = (cat_ + int(D.categories.size()) - 1) % std::max<int>(1, int(D.categories.size())); items = catItems(cat_); item_ = std::max(0, int(items.size()) - 1); } items = catItems(cat_); if (!items.empty()) hand_ = items[size_t(item_)]->id; moving_ = -1; }
  if (in.takePressed(Action::Restart)) { hand_.clear(); if (moving_ >= 0) { moving_ = -1; rebuildFurniture(); } }
  if (in.takePressed(Action::VMouse)) { vmouse_ = !vmouse_; cursor_ = vec2(float(uiW) / 2, float(uiH) / 2); }
  if (in.takePressed(Action::View)) rot_ += PI / 2;
  if (nav.wheel != 0) rot_ += sign(nav.wheel) * 15 * DEG;
  // the aim: the centre dot, or the cursor (the mouse when free, the virtual mouse's left stick)
  if (vmouse_) { cursor_ += vec2(in.moveX(), -in.moveY()) * 9.f; cursor_ = glm::clamp(cursor_, vec2(0), vec2(float(uiW), float(uiH))); }
  vec3 fwd = cam.forward();
  if (vmouse_) {
    float tx = std::tan(cam.fovY * float(DEG) / 2);
    float nx = (2 * cursor_.x / float(uiW) - 1) * tx * cam.aspect, ny = (1 - 2 * cursor_.y / float(uiH)) * tx;
    fwd = glm::normalize(fwd + cam.basis[0] * nx + cam.basis[1] * ny);
  }
  dvec3 o = rooms_.toLocal(cam.pos);
  dvec3 d(fwd);
  // the floor point under the aim, within reach
  bool hit = d.y < -0.05;
  double t = hit ? -o.y / d.y : 0;
  if (t > REACH) hit = false;
  dvec3 fp = o + d * t;
  // hovering a placed piece
  const nlohmann::json& ch = c_.save->data("chalet");
  if (hit && ch.contains("furniture") && ch["furniture"].is_array()) {
    double bd = 0.9;
    int i = 0;
    for (auto& r : ch["furniture"]) { double dd = std::hypot(r.value("x", 0.0) - fp.x, r.value("z", 0.0) - fp.z); if (dd < bd && i != moving_) { bd = dd; hover_ = i; } i++; }
  }
  bool click = in.takePressed(Action::Jump) || (vmouse_ && nav.confirm) || (!vmouse_ && nav.click);
  if (hand_.empty() && hover_ >= 0) {
    if (in.takePressed(Action::Alt)) { sell(hover_); return; }
    if (in.takePressed(Action::Pickup)) { moving_ = hover_; hand_ = ch["furniture"][size_t(hover_)].value("id", std::string()); rot_ = ch["furniture"][size_t(hover_)].value("rot", 0.0); rebuildFurniture(); return; }
    if (in.takePressed(Action::Interact)) {
      nlohmann::json& rec = c_.save->data("chalet")["furniture"][size_t(hover_)];
      if (rec.contains("on")) { rec["on"] = !rec.value("on", true); c_.save->markDirty(); }
    }
  }
  if (hand_.empty()) return;
  const FurnitureDef* fd = D.furnitureById(hand_);
  if (!fd) { hand_.clear(); return; }
  fitFor(*fd);
  double gx = snap(fp.x), gz = snap(fp.z), rot = rot_;
  if (fd->place == "wall") {
    // the wall the aim points at (placement.js rayWall): flush on its face, at the item's mount height
    double best = REACH;
    bool any = false;
    for (const ChaletWall& w : D.chaletPlan.walls) {
      double ex = w.bx - w.ax, ez = w.bz - w.az, L = std::hypot(ex, ez);
      if (L < 1e-6) continue;
      double nx = -ez / L, nz = ex / L;
      if ((o.x - w.ax) * nx + (o.z - w.az) * nz < 0) { nx = -nx; nz = -nz; }
      double ax = w.ax + nx * w.t / 2, az = w.az + nz * w.t / 2;
      double dn = d.x * nx + d.z * nz;
      if (dn >= -1e-6) continue;
      double tt = ((ax - o.x) * nx + (az - o.z) * nz) / dn;
      if (tt < 0 || tt > best) continue;
      double hx = o.x + d.x * tt, hz = o.z + d.z * tt;
      double s = ((hx - ax) * ex + (hz - az) * ez) / (L * L);
      if (s < 0 || s > 1) continue;
      best = tt; any = true; gx = hx; gz = hz; rot = std::atan2(nx, nz);
    }
    if (!any) return;
    hit = true;
  }
  if (!hit) return;
  double y = 0;
  ghostOk_ = valid(*fd, gx, gz, rot, moving_, y);
  ghostOn_ = true;
  ghost_ = dvec3(gx, y, gz);
  if (fd->place == "wall") rot_ = rot;
  if (click) {
    if (!ghostOk_) { c_.flash("It doesn't fit there", 1); return; }
    if (place(hand_, gx, gz, rot) && moving_ < 0 && c_.save->money < fd->price) hand_.clear();
  }
}

void Chalets::draw(Renderer& r, const dvec3& cam) {
  if (!c_.data) return;
  if (!rooms_.inside()) {
    // the chalets (chalet.glb on the ones you are near, the low-poly one on the rest)
    for (const ChaletHouse& h : c_.data->chalets) {
      dvec3 p(h.x, h.y, h.z);
      double d = glm::length(p - cam);
      if (d > 1800 || !r.visible(p - dvec3(8, 0, 8), p + dvec3(8, 12, 8))) continue;
      const Model* m = d < 60 && hi_ ? hi_.get() : lo_ ? lo_.get() : hi_.get();
      if (!m) continue;
      r.submitModel(*m, p, glm::rotate(mat4(1), float(h.yaw), vec3(0, 1, 0)) * houseLocal_, nullptr, d < 300, d > 200 ? 1 : 0);
    }
    return;
  }
  if (!inside()) return;
  Shapes& sh = *c_.shapes;
  // lamps that are on glow at their bulb
  const nlohmann::json& ch = c_.save->data("chalet");
  if (ch.contains("furniture") && ch["furniture"].is_array()) {
    double G = c_.data->chaletPlan.floorY;
    for (auto& rec : ch["furniture"]) {
      const FurnitureDef* d = c_.data->furnitureById(rec.value("id", std::string()));
      if (!d || d->light <= 0 || !rec.value("on", true)) continue;
      auto it = std::find_if(fits_.begin(), fits_.end(), [&](auto& e) { return e.first == d->id; });
      vec3 dims = it != fits_.end() ? it->second.dims : d->size;
      double by = d->place == "ceiling" ? dims.y * (1 - d->light) : dims.y * d->light;
      sh.sphere(r, rooms_.toWorld(rec.value("x", 0.0), rec.value("y", G) - G + by, rec.value("z", 0.0)), 0.06, vec4(1, 0.85f, 0.55f, 1), 12);
    }
  }
  // the blueprint ghost (blueprint.js: blue, red when it doesn't fit)
  if (build_ && ghostOn_) {
    const FurnitureDef* fd = c_.data->furnitureById(hand_);
    if (fd) {
      const Fit* f = fitFor(*fd);
      vec4 col = ghostOk_ ? vec4(0.2f, 0.5f, 1, 0.4f) : vec4(1, 0.15f, 0.1f, 0.4f);
      dvec3 w = rooms_.toWorld(ghost_.x, ghost_.y, ghost_.z);
      mat4 L = glm::rotate(mat4(1), float(fd->place == "wall" ? rot_ : rot_), vec3(0, 1, 0)) * glm::translate(mat4(1), vec3(0, 0, fd->place == "wall" ? f->dims.z / 2 : 0)) * glm::scale(mat4(1), f->dims) * glm::translate(mat4(1), vec3(-0.5f, 0, -0.5f)) * glm::translate(mat4(1), vec3(0.5f, 0, 0.5f));
      sh.oriented(r, Shapes::Kind::Box, w, L, col, 1.5f, false);
      if (f->model) r.submitModel(*f->model, w, glm::rotate(mat4(1), float(rot_), vec3(0, 1, 0)) * f->local, nullptr, false);
    }
  }
  if (build_ && hover_ >= 0 && hand_.empty() && ch.contains("furniture")) {
    const auto& rec = ch["furniture"][size_t(hover_)];
    double G = c_.data->chaletPlan.floorY;
    sh.cylinder(r, rooms_.toWorld(rec.value("x", 0.0), rec.value("y", G) - G, rec.value("z", 0.0)), 0.6, 0.03, vec4(1, 0.8f, 0.2f, 0.6f), 2, false);
  }
}

void Chalets::hud(Ui& ui, float u) {
  uiW = ui.width(); uiH = ui.height();
  if (!build_ || !inside()) return;
  const PlayData& D = *c_.data;
  float W = float(ui.width()), H = float(ui.height());
  float pw = 300 * u, x = W - pw - 18 * u, y = 90 * u;
  ui.brushPanel(x, y, pw, H - 200 * u, ui_color::a(ui_color::paper, 0.95f), 3);
  ui.text(x + 16 * u, y + 10 * u, 15 * u, UiFont::CondBold, ui_color::red, "BUILD MODE \xC2\xB7 " + fmtMoney(c_.save->money));
  if (!D.categories.empty()) ui.text(x + 16 * u, y + 32 * u, 26 * u, UiFont::CondHeavy, ui_color::blue, D.categories[size_t(cat_ % int(D.categories.size()))].second);
  float iy = y + 70 * u;
  int k = 0;
  for (auto& f : D.furniture) {
    if (D.categories.empty() || f.category != D.categories[size_t(cat_ % int(D.categories.size()))].first) continue;
    bool sel = f.id == hand_;
    if (sel) ui.roundRect(x + 10 * u, iy - 2 * u, pw - 20 * u, 24 * u, 6 * u, ui_color::a(ui_color::bluePale, 1));
    ui.textFit(x + 18 * u, iy, pw - 110 * u, 16 * u, sel ? UiFont::CondBold : UiFont::Cond, ui_color::navy, f.name);
    ui.text(x + pw - 18 * u, iy, 16 * u, UiFont::CondBold, c_.save->money >= f.price ? ui_color::ok : ui_color::ko, fmtMoney(f.price), UiAlign::Right);
    iy += 26 * u;
    if (++k > 16) break;
  }
  ui.textWrapped(x + 16 * u, H - 230 * u, pw - 32 * u, 13 * u, UiFont::Body, ui_color::navy,
                 c_.K(Action::PrevItem) + " " + c_.K(Action::NextItem) + " browse \xC2\xB7 " + c_.K(Action::Jump) + " place \xC2\xB7 " + c_.K(Action::View) + " turn \xC2\xB7 " + c_.K(Action::Pickup) + " move \xC2\xB7 " + c_.K(Action::Alt) + " sell \xC2\xB7 " +
                 c_.K(Action::Restart) + " empty hand \xC2\xB7 " + c_.K(Action::VMouse) + " virtual mouse \xC2\xB7 " + c_.K(Action::Furnish) + " done");
  // the centre dot / the cursor
  if (vmouse_) { ui.circle(cursor_.x, cursor_.y, 7 * u, ui_color::white); ui.circle(cursor_.x, cursor_.y, 4 * u, ui_color::blue); }
  else ui.circle(W / 2, H / 2, 3.5f * u, ghostOn_ && !ghostOk_ ? ui_color::red : ui_color::white);
}

std::string Chalets::objective() const {
  if (build_) return "Furnishing " + (insideHouse_ >= 0 ? c_.data->chalets[size_t(insideHouse_)].name : std::string("your chalet")) + " \xC2\xB7 " + std::to_string(furnitureCount()) + " pieces";
  return "";
}

} // namespace sl
