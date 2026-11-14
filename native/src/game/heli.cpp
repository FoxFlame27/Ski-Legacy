#include "game/heli.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/economy.h"
#include "game/hospital_ward.h"
#include "game/menus.h"
#include "game/play_data.h"
#include "game/shapes.h"
#include "player/player.h"
#include "player/skier_rig.h"
#include "world/lifts.h"
#include "world/resort.h"
#include "world/scenery.h"
#include "world/world.h"

namespace sl {

using heli::smooth;

namespace {
constexpr double JUMP_AGL = 6, JUMP_SPEED = 6, CAM_DIST = 17, IDLE_RPM = 0.6, IDLE_WAIT = 25, AWAY_RETURN = 650, LAND_AGL = 45, LAND_SPEED = 14;
dvec3 v3(const nlohmann::json& a, const dvec3& d = dvec3(0)) { return a.is_array() && a.size() == 3 ? dvec3(a[0].get<double>(), a[1].get<double>(), a[2].get<double>()) : d; }
// model.js LIGHTS (reference frame): x, y, z, r, g, b, size (m), kind (0 nav, 1 beacon, 2 beacon2, 3 strobe)
struct Lamp { float x, y, z, r, g, b, s; int kind; };
const Lamp LAMPS[] = {
  {1.84f, 2.02f, -3.25f, 1, 0.08f, 0.04f, 0.55f, 0}, {-1.84f, 2.02f, -3.25f, 0.06f, 1, 0.25f, 0.55f, 0}, {0, 2.18f, -5.32f, 1, 0.92f, 0.82f, 0.3f, 0},
  {0, 3.86f, -5.02f, 1, 0.06f, 0.03f, 0.6f, 1}, {0, 0.64f, 1.9f, 1, 0.06f, 0.03f, 0.55f, 2},
  {1.86f, 2.04f, -3.32f, 1, 1, 1, 0.75f, 3}, {-1.86f, 2.04f, -3.32f, 1, 1, 1, 0.75f, 3},
};
} // namespace

HeliParts loadHeliParts(Resort& resort) {
  HeliParts P;
  const nlohmann::json* pj = resort.playData();
  if (!pj) return P;
  if (pj->contains("heli") && (*pj)["heli"].contains("parts")) {
    const nlohmann::json& p = (*pj)["heli"]["parts"];
    auto get = [&](const char* k) { return p.contains(k) && p[k].is_array() && !p[k].empty() ? resort.playModel(p[k]) : nullptr; };
    P.body = get("body"); P.hub = get("hub"); P.blade = get("blade"); P.disc = get("disc");
    P.tailHub = get("tailHub"); P.tailBlades = get("tailBlades"); P.tailDisc = get("tailDisc");
  }
  if (pj->contains("ward") && (*pj)["ward"].contains("mesh") && !(*pj)["ward"]["mesh"].empty()) P.ward = resort.playModel((*pj)["ward"]["mesh"]);
  return P;
}

Heli::Heli(PlayCtx& c, HospitalWard& ward) : rescue(*this, c, ward), c_(c) {
  groundFn_ = [this](double x, double z) { return ground(x, z); };
}

double Heli::ground(double x, double z) const { return c_.world->groundHeight(x, z); }
double Heli::snow(double x, double z) const { return c_.world->height(x, z); }

void Heli::load(AssetManager& assets, const HeliParts& parts) {
  parts_ = parts;
  assets_ = &assets;
  const PlayData* D = c_.data;
  if (!D || !D->heli || !parts_.body) { SL_WARN("heli: no data (node native/tools/export_resort.mjs)"); return; }
  const nlohmann::json& j = *D->heli;
  price_ = j.value("price", 1500);
  padR = j.value("padR", 10.0);
  home = {j["home"].value("x", 92.0), j["home"].value("z", -128.0), j["home"].value("y", 0.0), j["home"].value("yaw", 0.0)};
  if (j.contains("hut")) hutDoor_ = dvec2(j["hut"]["door"].value("x", 0.0), j["hut"]["door"].value("z", 0.0));
  K_ = j.value("K", 9.8 / 10.5);
  const nlohmann::json& F = j["frame"];
  HeliFrame& fr = flight.fr;
  fr.cgH = F.value("cgH", 1.6); fr.skidL = F.value("skidL", 3.8); fr.skidW = F.value("skidW", 2.7); fr.skidZ = F.value("skidZ", 0.4); fr.rotorR = F.value("rotorR", 5.1);
  if (F.contains("hull")) {
    const nlohmann::json& Hh = F["hull"];
    for (int i = 0; i < 2; i++) { fr.nose[i] = Hh["nose"][size_t(i)]; fr.tail[i] = Hh["tail"][size_t(i)]; fr.rotor[i] = Hh["rotor"][size_t(i)]; }
    for (int i = 0; i < 3; i++) fr.stab[i] = Hh["stab"][size_t(i)];
  }
  const nlohmann::json& A = j["anchors"];
  anchorSeat = v3(A["seat"]); anchorDoor = v3(A["door"]); anchorBasket = v3(A["basket"]); anchorLamp = v3(A["lamp"]); anchorHub = v3(A["hub"]);
  hub_ = vec3(v3(j["hub"], dvec3(0, 4.02, 1.3))); tailHub_ = vec3(v3(j["tailHub"], dvec3(0.41, 2.25, -4.92)));
  airPos_ = vec3(v3(j["airframe"]["pos"]));
  discY_ = j.value("discY", 0.02); tailDiscX_ = j.value("tailDiscX", 0.06); bladeX_ = j.value("bladeX", 0.42);
  for (auto& z : j["zones"]) zones_.push_back({z.value("name", std::string()), std::string(), z.value("x", 0.0), z.value("z", 0.0), z.value("y", 0.0), z.value("heading", 0.0), z.value("vertical", 0), false});
  for (auto& z : j["races"]) zones_.push_back({z.value("name", std::string()), z.value("label", std::string()), z.value("x", 0.0), z.value("z", 0.0), 0, 0, 0, true});
  if (j.contains("ambulance")) rescue.amb.load(assets, j["ambulance"]);
  // (our own copies of the blades' and discs' materials: their opacity follows the rotor speed)
  for (auto* m : {&parts_.blade, &parts_.disc, &parts_.tailBlades, &parts_.tailDisc})
    if (*m) { *m = std::make_shared<Model>(**m); for (Material& mt : (*m)->materials) { mt.alpha = Material::Alpha::Blend; mt.roughness = std::max(mt.roughness, 0.62f); mt.metallic = 0; } }
  // (the blur discs are MeshBasicMaterial 0x1d2025: the same dark grey whatever the light, their painted alpha)
  for (auto* m : {&parts_.disc, &parts_.tailDisc}) if (*m) for (Material& mt : (*m)->materials) { mt.emissive = vec3(mt.baseColor) * 0.9f; mt.baseColor = vec4(0, 0, 0, mt.baseColor.w); mt.roughness = 1; mt.doubleSided = true; }
  SL_INFO("heli: blur disc texture %s, tail %s", parts_.disc && parts_.disc->materials[0].baseTex ? "ok" : "MISSING", parts_.tailDisc && parts_.tailDisc->materials[0].baseTex ? "ok" : "MISSING");
  // the downwash's puff: a soft round sprite (fx.js Puffs: opacity 0.62, lit white over a cool shade), four strengths
  if (c_.dev) {
    const int S = 64;
    std::vector<uint8_t> px(size_t(S) * S * 4);
    for (int y = 0; y < S; y++) for (int x = 0; x < S; x++) {
      float dx = (x + 0.5f) / S * 2 - 1, dy = (y + 0.5f) / S * 2 - 1, rr = std::sqrt(dx * dx + dy * dy);
      float a = 1 - float(smooth(0.2, 1.0, rr));
      float lit = float(smooth(-0.45, 0.35, -dy * 0.5));   // (lit from above, the cool shade below)
      uint8_t* q = &px[(size_t(y) * S + x) * 4];
      q[0] = uint8_t(201 + 54 * lit); q[1] = uint8_t(212 + 43 * lit); q[2] = uint8_t(230 + 25 * lit); q[3] = uint8_t(a * 255);
    }
    gfx::TextureDesc d;
    d.width = d.height = S; d.wrap = gfx::Wrap::Clamp;
    gfx::Texture tex = c_.dev->createTexture(d, px.data());
    for (int i = 0; i < 4; i++) {
      Material m;
      m.baseTex = tex;
      m.baseColor = vec4(1, 1, 1, 0.34f * (i + 0.6f) / 4.f);   // (lit by the sun here, so thinner than the web's unlit 0.62)
      m.emissive = vec3(0.10f); m.roughness = 1; m.metallic = 0; m.doubleSided = true;
      m.alpha = Material::Alpha::Blend;
      Geo g = shapeGeo({vec2(-0.5f, -0.5f), vec2(0.5f, -0.5f), vec2(0.5f, 0.5f), vec2(-0.5f, 0.5f)});
      g.uv = {vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 1)};
      puffModel_[i] = buildModel(*c_.dev, {{g, m}}, "heli_puff");
      // (the flare's smoke: lit 0xf26a4b over 0xb4402e, opacity 0.42)
      Material ms = m;
      ms.baseColor = vec4(0.88f, 0.14f, 0.07f, 0.42f * (i + 0.6f) / 4.f);
      ms.emissive = vec3(0.10f, 0.012f, 0.006f);
      smokeModel_[i] = buildModel(*c_.dev, {{g, ms}}, "heli_smoke");
    }
  }
  ok_ = true;
  streamPos = dvec3(home.x, 0, home.z);
  place();
  SL_INFO("heli: pad at (%.0f, %.0f) y %.2f yaw %.2f, %zu drop zones, ambulance %s", home.x, home.z, home.y, home.yaw, zones_.size(), rescue.amb.ok() ? "ok" : "missing");
}

void Heli::place() {
  flight.place(home.x, home.z, home.yaw, groundFn_);
  pilot.phase = HeliHomePilot::Phase::Idle;
}

bool Heli::treeNear(double x, double z, double r) const {
  return c_.scenery->treeAt(x, z, r, false) || c_.scenery->rockAt(x, z, r, 1.2);
}

namespace {
// the first collider (static, or a car / bus near you) within its own reach + pad of (x, z)
const Collider* colliderNear(const Scenery& S, double x, double z, double pad, bool dyn, const dvec2* skipA = nullptr, const dvec2* skipB = nullptr) {
  auto hit = [&](const Collider& c) {
    double size = c.r >= 0 ? c.r : std::hypot(c.hw, c.hd), reach = size + pad, dx = x - c.x, dz = z - c.z;
    return std::fabs(dx) < reach && std::fabs(dz) < reach && dx * dx + dz * dz < reach * reach;
  };
  const auto& cols = S.colliders();
  for (int ox = -1; ox <= 1; ox++) for (int oz = -1; oz <= 1; oz++) {
    const std::vector<int>* L = S.collidersNear(x + ox * 16.0, z + oz * 16.0);
    if (!L) continue;
    for (int i : *L) if (hit(cols[size_t(i)])) return &cols[size_t(i)];
  }
  if (dyn) for (const Collider& c : S.dynamic) {
    if (skipA && std::hypot(c.x - skipA->x, c.z - skipA->y) < 0.05) continue;
    if (skipB && std::hypot(c.x - skipB->x, c.z - skipB->y) < 0.05) continue;
    if (hit(c)) return &c;
  }
  return nullptr;
}
} // namespace

bool Heli::solidNear(double x, double z, double pad, bool carsToo) const { return colliderNear(*c_.scenery, x, z, pad, carsToo) != nullptr; }

bool Heli::liftLineNear(double x, double z, double d) const {
  CorridorHit h = c_.world->corridorAt(x, z);
  return h.any && h.kind == CorridorKind::Lift && h.d < d;
}

// ------------------------------------------------------------------ booking + boarding
bool Heli::rescueMe(bool free) {
  if (!ok_) return false;
  return rescue.start(free);
}

bool Heli::interact(std::string& prompt, bool pressed) {
  if (!ok_) return false;
  Player& p = *c_.player;
  if (state == State::Flying) {
    // get out (landed) / jump out (hovering low over a slope too steep to land on); its prompt is the flight HUD's
    if (pressed && jump_.ok && (spun_ || flight.landed)) { if (jump_.landed) getOut(); else jumpOut(); }
    return true;
  }
  if (state == State::Boarding || state == State::Rescue) return false;
  // parked out where you landed: climb back in (no charge, it is still your trip)
  if (state == State::Parked && away_ && std::hypot(p.pos.x - flight.pos.x, p.pos.z - flight.pos.z) < 9) {
    prompt = "Fly the helicopter";
    if (pressed) board();
    return true;
  }
  bool near = std::hypot(p.pos.x - home.x, p.pos.z - home.z) < padR + 1.5 || std::hypot(p.pos.x - hutDoor_.x, p.pos.z - hutDoor_.y) < 3.2;
  if (!near) return false;
  if (state == State::Auto) { prompt = "Heli-ski \xC2\xB7 the helicopter is flying back"; if (pressed) c_.flash("The helicopter is on its way back to the pad", 0); return true; }
  if (away_) { prompt = "Heli-ski \xC2\xB7 call the helicopter back to the pad"; if (pressed) callHome(false); return true; }
  prompt = "Heli-ski \xC2\xB7 fly to the far peaks \xC2\xB7 " + fmtMoney(price_);
  if (pressed) openDialog();
  return true;
}

void Heli::callHome(bool quiet) {
  if (state != State::Parked || !away_) return;
  away_ = false;
  state = State::Auto;
  pilot.home(home, 0.8);
  if (!quiet) c_.flash("The helicopter is on its way back to the pad", 0);
}

// The heli-ski desk (heli.js openDialog): the pilot's chart of the drop zones (ui/travel.js, TrailMap::heliTravel).
// Pick one as your flight plan (the compass and the red smoke flare lead you there) or a free flight; either way you
// fly it yourself, same price. The race courses on the mountains follow the drop zones: the helicopter's spot beside
// the start house.
void Heli::fly(const DropZone* z) {
  if (blocked && blocked()) return;
  if (state != State::Parked || away_) return;
  if (c_.spend(price_)) { plan_ = z; board(); }
}

void Heli::planner(TrailMap::Travel& T) {
  const bool broke = c_.save->money < price_;
  auto eta = [](double km) { return (40 + (km * 1000) / 42) / 60; };   // spool-up and climb, then ~150 km/h
  std::vector<TrailMap::TravelDest> out;
  TrailMap::TravelDest freeD;
  bool hasFree = false;
  for (TrailMap::TravelDest& d : T.dests) {
    if (d.id < 0) { freeD = d; hasFree = true; continue; }
    const DropZone* zn = nullptr;
    for (const DropZone& z : zones_) if (!z.race && (z.name == d.name || std::hypot(z.x - d.x, z.z - d.z) < 30)) zn = &z;
    d.act = [this, zn]() { fly(zn); };
    out.push_back(d);
  }
  std::vector<std::pair<double, const DropZone*>> races;
  for (const DropZone& z : zones_) if (z.race) races.push_back({std::hypot(z.x - home.x, z.z - home.z) / 1000, &z});
  std::sort(races.begin(), races.end());
  for (auto& [km, z] : races) {
    TrailMap::TravelDest d;
    char b[160];
    std::snprintf(b, sizeof b, "Race course \xC2\xB7 %s \xC2\xB7 %.1f km \xC2\xB7 %d min", z->label.c_str(), km, std::max(1, int(std::lround(eta(km)))));
    d.name = z->name; d.meta = b; d.tag = "RACE"; d.x = z->x; d.z = z->z; d.id = int(z - zones_.data()) + 1000;
    d.shortMoney = broke; d.disabled = broke;
    std::snprintf(b, sizeof b, "%.1f", km);
    d.plan = {{"DISTANCE", b, "KM"}, {"FLIGHT", std::to_string(std::max(1, int(std::lround(eta(km))))), "MIN"}};
    d.act = [this, z]() { fly(z); };
    out.push_back(std::move(d));
  }
  if (hasFree) { freeD.act = [this]() { fly(nullptr); }; out.push_back(std::move(freeD)); }
  T.dests = std::move(out);
}

void Heli::openDialog() {
  if (!c_.menus) return;
  if (c_.player->hasSkis && openChart) { openChart(); return; }
  Dialog d;
  d.kicker = "HELI-SKI BASE";
  d.title = "Heli-Ski";
  if (!c_.player->hasSkis) {
    d.rebuild = [](Dialog& D) {
      D.say = "You will need skis up there. Buy a pair at the ski shop in the village, then come back.";
      D.options.clear();
      DialogOption o; o.label = "OK"; o.secondary = true;
      D.options.push_back(o);
    };
    c_.menus->openDialog(d);
    return;
  }
  d.kicker = "FLIGHT PLANNER";
  d.rebuild = [this](Dialog& D) {
    bool broke = c_.save->money < price_;
    D.say = "Pick a drop zone: the compass leads the way \xC2\xB7 you are the pilot" + (broke ? " \xC2\xB7 you need " + fmtMoney(price_) + " \xC2\xB7 you have " + fmtMoney(c_.save->money) : std::string());
    D.options.clear();
    auto eta = [](double km) { return (40 + (km * 1000) / 42) / 60; };   // spool-up and climb, then ~150 km/h
    auto fly = [this](const DropZone* z) {
      if (blocked && blocked()) return;
      if (state != State::Parked || away_) return;
      if (c_.spend(price_)) { plan_ = z; board(); }
    };
    std::vector<std::pair<double, const DropZone*>> order;
    for (const DropZone& z : zones_) order.push_back({std::hypot(z.x - home.x, z.z - home.z) / 1000 + (z.race ? 1000 : 0), &z});
    std::sort(order.begin(), order.end());
    for (auto& [k, z] : order) {
      double km = std::hypot(z->x - home.x, z->z - home.z) / 1000;
      char b[160];
      if (z->race) std::snprintf(b, sizeof b, "Race course \xC2\xB7 %s \xC2\xB7 %.1f km \xC2\xB7 %d min", z->label.c_str(), km, std::max(1, int(std::round(eta(km)))));
      else std::snprintf(b, sizeof b, "%.1f km \xC2\xB7 %d min \xC2\xB7 %d m vertical", km, std::max(1, int(std::round(eta(km)))), z->vertical);
      DialogOption o;
      o.label = z->name; o.sub = b; o.price = price_; o.disabled = broke;
      if (z->race) o.state = "RACE";
      o.act = [fly, z]() { fly(z); };
      D.options.push_back(o);
    }
    DialogOption fr;
    fr.label = "Free flight"; fr.sub = "No flight plan \xC2\xB7 fly anywhere"; fr.price = price_; fr.disabled = broke;
    fr.act = [fly]() { fly(nullptr); };
    D.options.push_back(fr);
    DialogOption n; n.label = "Not now"; n.secondary = true;
    D.options.push_back(n);
  };
  c_.menus->openDialog(d);
}

void Heli::board() {
  if (state != State::Parked || (blocked && blocked())) return;
  if (c_.fade) c_.fade();
  Player& p = *c_.player;
  if (!p.skisOn) p.setSkisOn(true);
  prevView_ = int(p.view);
  p.view = Player::View::Third;
  updateSeat();
  p.sitOn(seatPos_, seatFwd_);
  loadRack();
  state = State::Flying;
  away_ = false;
  landedT_ = 0;
  spun_ = rpm >= heli::POWER;
  flights_++;
  // first shot: from behind the left shoulder, the rotor starting up
  cam.yaw = flight.yaw + PI - 0.55; cam.pitch = 0.16; cam.dist = CAM_DIST - 3; cam.lastMouse = time;
  handoff_ = 0;
  placeCamera(0, true, false);
  keysT_ = flights_ == 1 ? 16 : 9;
}

// ------------------------------------------------------------------ getting out
// Where you'd land: the snow below the right door. Is it somewhere to ski?
void Heli::checkJump() {
  const HeliFlight& f = flight;
  auto& J = jump_;
  J.ok = false; J.warn = false; J.label.clear(); J.landed = false;
  dvec3 door = f.world(anchorDoor);
  bool onPad = std::hypot(f.pos.x - home.x, f.pos.z - home.z) < padR - 2;
  J.onPad = onPad && f.landed;
  // set down anywhere else: step out beside the door
  if (f.landed && !J.onPad) { J.ok = true; J.landed = true; J.label = "Get out"; return; }
  if (f.speed() > JUMP_SPEED) return;
  if (f.agl > JUMP_AGL) {
    bool nearPad = std::hypot(f.pos.x - home.x, f.pos.z - home.z) < 60;
    if (f.agl < 40 && f.speed() < 3 && !nearPad) { J.label = "Hover lower to jump out (below 6 m)"; J.warn = false; }
    return;
  }
  if (J.onPad) { J.ok = true; J.label = "Get out"; return; }
  // flat enough to land: set it down (SHIFT) and get out instead of jumping
  if (land_.ok) return;
  const double e = 2;
  double g = std::hypot(snow(door.x + e, door.z) - snow(door.x - e, door.z), snow(door.x, door.z + e) - snow(door.x, door.z - e)) / (2 * e);
  if (g > 0.95) { J.label = "Too steep to jump out here"; J.warn = true; return; }
  if (treeNear(door.x, door.z, 1.2)) { J.label = "Trees below \xC2\xB7 find open snow"; J.warn = true; return; }
  if (solidNear(door.x, door.z, 1.2, false)) { J.label = "Too close to buildings"; J.warn = true; return; }
  J.ok = true; J.label = "Jump out and ski";
}

void Heli::jumpOut() {
  Player& p = *c_.player;
  const HeliFlight& f = flight;
  dvec3 door = f.world(anchorDoor);
  handPos_ = camPos_; handLook_ = camLook_; handFov_ = camFovNow_; handoff_ = 1.4;
  bool onPad = jump_.onPad;
  // face down the fall line (or the way the helicopter points on flat ground)
  const double e = 3;
  double gx = (snow(door.x + e, door.z) - snow(door.x - e, door.z)) / (2 * e), gz = (snow(door.x, door.z + e) - snow(door.x, door.z - e)) / (2 * e);
  double heading = std::hypot(gx, gz) > 0.05 && !onPad ? std::atan2(-gx, -gz) : f.yaw;
  p.view = Player::View(prevView_);
  p.standUp(door.x, door.z, heading);
  if (onPad) {
    // stepped out on the helipad: skis back on your shoulder, the rotor winds down
    p.setSkisOn(false);
    rackOn_ = false;
    state = State::Parked;
    c_.flash("Thanks for flying \xC2\xB7 see you on the next heli drop", 0);
  } else {
    // a drop from the skid onto the snow, skis on, ready to go: you stand still after the landing until you push off
    double gy = c_.world->groundHeight(door.x, door.z, door.y + 1), drop = std::max(0.0, f.pos.y - f.fr.cgH - gy);
    if (drop > 0.35 && p.mode == PlayerMode::Ski) { p.dropFrom(gy + drop); parkSkier_ = true; }
    else { p.parked = true; p.vel = dvec3(0); }
    rackOn_ = false;
    plan_ = nullptr;   // (the trip is over: it flies home)
    state = State::Auto;
    pilot.home(home, 1.6);
    c_.flash("Fresh powder \xC2\xB7 press " + c_.K(Action::Forward) + " to go", 2);
  }
}

// Landed out on the mountain: step out beside the right door, on skis where there is a slope to ski, on foot on the
// flat. The helicopter stays where it is, its rotor idling, until you fly on or leave it.
void Heli::getOut() {
  Player& p = *c_.player;
  HeliFlight& f = flight;
  dvec3 door = f.world(anchorDoor);
  double x = door.x - std::cos(f.yaw) * 1.6, z = door.z + std::sin(f.yaw) * 1.6;   // a step out to the right
  handPos_ = camPos_; handLook_ = camLook_; handFov_ = camFovNow_; handoff_ = 1.4;
  const double e = 3;
  double gx = (snow(x + e, z) - snow(x - e, z)) / (2 * e), gz = (snow(x, z + e) - snow(x, z - e)) / (2 * e);
  double heading = std::hypot(gx, gz) > 0.05 ? std::atan2(-gx, -gz) : std::atan2(-std::cos(f.yaw), std::sin(f.yaw));
  // (player.js isFlatHere)
  double y = ground(x, z) + 0.3;
  double fx = (c_.world->groundHeight(x + 4, z, y) - c_.world->groundHeight(x - 4, z, y)) / 8, fz = (c_.world->groundHeight(x, z + 4, y) - c_.world->groundHeight(x, z - 4, y)) / 8;
  bool flat = std::hypot(fx, fz) <= 0.045;
  p.view = Player::View(prevView_);
  p.skisOn = !flat && p.hasSkis;
  p.standUp(x, z, heading);
  if (!flat) { p.parked = true; p.vel = dvec3(0); }
  state = State::Parked;
  rackOn_ = false;
  away_ = true;
  awayT_ = 0;
  f.hold = 0;
  c_.flash(flat ? "Landed \xC2\xB7 the helicopter waits here" : "Fresh powder \xC2\xB7 press " + c_.K(Action::Forward) + " to go \xC2\xB7 the helicopter waits here", 2);
}

// End a flight at once (before teleporting to the village / the main menu): back on its pad, rotors stopped.
void Heli::abort() {
  if (!ok_) return;
  Player& p = *c_.player;
  bool seatedHere = state == State::Flying || (state == State::Rescue && (rescue.inCabin || rescue.seated));
  if (rescue.active()) rescue.cleanup();
  if (seatedHere && p.mode == PlayerMode::Sit) {
    // step out at the edge of the pad, clear of the rotor, facing the helicopter
    double a = home.yaw + PI / 2, d = padR + 3, x = home.x + std::sin(a) * d, z = home.z + std::cos(a) * d;
    p.view = Player::View(prevView_);
    p.standUp(x, z, std::atan2(home.x - x, home.z - z));
  }
  state = State::Parked;
  rackOn_ = false;
  away_ = false;
  plan_ = nullptr;
  flight.hold = 0;
  rpm = 0;
  handoff_ = 0;
  place();
}

// ------------------------------------------------------------------ per frame
void Heli::update(double dt, bool fly) {
  if (!ok_ || dt <= 0) return;
  HeliFlight& f = flight;
  Player& p = *c_.player;
  time += dt;
  camSet_ = false;
  const bool flying = state == State::Flying;

  // ---- controls: your keys, the pilot flying home, or nothing (parked)
  HeliCtl c;
  if (flying && fly && c_.input) {
    const Input& in = *c_.input;
    c.fwd = (in.down(Action::Forward) ? 1 : 0) - (in.down(Action::Back) ? 1 : 0);
    c.turn = (in.down(Action::Left) ? 1 : 0) - (in.down(Action::Right) ? 1 : 0);
    if (c.fwd == 0 && std::fabs(in.moveY()) > 0.15f) c.fwd = clamp(double(in.moveY()), -1.0, 1.0);    // (the left stick)
    if (c.turn == 0 && std::fabs(in.moveX()) > 0.15f) c.turn = clamp(-double(in.moveX()), -1.0, 1.0);
    c.lift = (in.down(Action::Jump) ? 1 : 0) - (in.down(Action::Sprint) ? 1 : 0);
  } else if (state == State::Rescue) {
    c = rescue.controls(dt);
  } else if (state == State::Auto) {
    c = pilot.update(f, dt);
    // somebody standing on the pad: wait above it
    if (pilot.phase == HeliHomePilot::Phase::Down && f.agl < 14 && p.mode != PlayerMode::Sit && std::hypot(p.pos.x - home.x, p.pos.z - home.z) < padR + 2) c.lift = std::max(c.lift, 0.0);
    if (pilot.phase == HeliHomePilot::Phase::Landed) state = State::Parked;
    // out of sight far away: it has made it home
    if (std::hypot(f.pos.x - p.pos.x, f.pos.z - p.pos.z) > 1300 && std::hypot(home.x - p.pos.x, home.z - p.pos.z) > 900) { state = State::Parked; rpm = 0; place(); }
  }

  // parked out on the mountain: it idles a while, then shuts down; once you are far away its pilot flies it home
  if (state == State::Parked && away_) {
    awayT_ += dt;
    if (std::hypot(p.pos.x - f.pos.x, p.pos.z - f.pos.z) > AWAY_RETURN) callHome(true);
  }

  // ---- turbine + rotor: spool up for a flight, idle on the skids, wind down when parked
  double want = state == State::Auto || (state == State::Rescue && !rescue.grounded()) ? 1 : 0;
  if (flying) {
    if (!f.landed || c.lift > 0.05) landedT_ = 0; else landedT_ += dt;
    if (rpm >= heli::POWER) spun_ = true;
    want = spun_ && f.landed && landedT_ > 1.2 ? IDLE_RPM : 1;
  } else if (state == State::Parked && away_ && awayT_ < IDLE_WAIT) want = IDLE_RPM;
  const bool rfast = state == State::Rescue && rescue.fast;
  double sdt = rfast ? dt * 4 : dt;   // (SPACE speeds a rescue up)
  if (want > rpm) rpm = std::min(1.0, rpm + sdt * (0.07 + 0.75 * rpm * (1.04 - rpm)));   // ~5 s to lift-off power
  else if (want < rpm) rpm = std::max(0.0, rpm - dt * (0.03 + 0.1 * rpm));

  if (state != State::Parked || !f.landed || rpm > 0) {
    // you (or its own pilot) fly into a tree, a roof, a net: it bumps off softly, nothing breaks; then the hard terrain
    // floor again (nothing of it ever goes into the hillside). Every step, every state.
    const bool solid = flying || state == State::Auto || state == State::Rescue;
    auto stepOnce = [&]() { f.step(dt, c, groundFn_, rpm); if (solid && collide(dt) > 0) f.clampTerrain(groundFn_); };
    stepOnce();
    // hold SPACE during a rescue: it all runs four times as fast (the pilot steering every step, the same checks)
    if (rfast) for (int k = 0; k < 3 && state == State::Rescue; k++) { c = rescue.controls(dt); stepOnce(); }
  }
  ctl_ = c;

  // ---- you in the cabin
  promptText_.clear(); promptKey_.clear(); promptWarn_ = false;
  if (flying) {
    updateSeat();
    // stream the world ahead of the helicopter
    double ahead = std::min(2.0, 140 / std::max(1.0, f.speed()));
    streamPos = dvec3(f.pos.x + f.vel.x * ahead, f.pos.y, f.pos.z + f.vel.z * ahead);
    // can it land here? (a few times a second; over trees, buildings, nets or a lift line it stays up)
    land_.t -= dt;
    if (land_.t <= 0) { land_.t = 0.12; landCheck(); }
    f.hold = land_.hold;
    checkJump();
    placeCamera(dt, false, fly);
    char b[96];
    if (!spun_) { std::snprintf(b, sizeof b, "Starting the turbine \xC2\xB7 rotor %d%%", int(std::round(rpm * 100))); promptText_ = b; }
    else if (f.landed) { promptText_ = jump_.ok ? "Get out \xC2\xB7 " + c_.K(Action::Jump) + " lift off" : std::string("Lift off"); promptKey_ = jump_.ok ? c_.K(Action::Interact) : c_.K(Action::Jump); }
    else if (jump_.ok) { promptText_ = jump_.label; promptKey_ = c_.K(Action::Interact); }
    else if (!land_.label.empty()) { promptText_ = land_.label; promptKey_ = land_.ok ? c_.K(Action::Sprint) : std::string(); promptWarn_ = land_.warn; }
    else if (!jump_.label.empty()) { promptText_ = jump_.label; promptWarn_ = jump_.warn; }
    if (keysT_ > 0) keysT_ -= dt;
  } else if (state == State::Rescue) {
    f.hold = 0;
    rescue.after(dt, fly && c_.input && c_.input->down(Action::Jump));
  } else { streamPos = p.pos; f.hold = 0; }

  // after the drop from the skid: once on the snow, stand still until you push off
  if (parkSkier_) {
    if (p.mode != PlayerMode::Ski) parkSkier_ = false;
    else if (!p.air) { p.parked = true; p.vel = dvec3(0); parkSkier_ = false; }
  }
  if (handoff_ > 0) handoff_ = std::max(0.0, handoff_ - dt);

  updateWash(dt);
  updateSmoke(dt);
  lampOn_ += ((rpm > 0.6 && !f.landed ? 1 : 0) - lampOn_) * (1 - std::exp(-dt * 6));
  // ---- rotors: spin (model.js update: the main rotor clockwise seen from above)
  angle_ = std::fmod(angle_ - rpm * 26 * dt, TAU);
  tailAngle_ = std::fmod(tailAngle_ + rpm * 120 * dt, TAU);
}

// fx.js SmokeFlare: red smoke rising from a flare in the snow on your drop zone and drifting downwind (a beacon you
// can spot from far away): a thin column at the flare spreading into a wide, faint plume
void Heli::updateSmoke(double dt) {
  const DropZone* zone = active() ? targetZone(0) : nullptr;
  flareOn_ = zone && std::hypot(zone->x - flight.pos.x, zone->z - flight.pos.z) < 4500;
  if (flareOn_) {
    if (smoke_.empty()) smoke_.resize(80);
    flareAt_ = dvec3(zone->x, snow(zone->x, zone->z), zone->z);
    smokeAcc_ += dt * 6.5;
    while (smokeAcc_ >= 1) {
      smokeAcc_ -= 1;
      Puff& p = smoke_[smokeNext_];
      smokeNext_ = (smokeNext_ + 1) % smoke_.size();
      p.p = flareAt_ + dvec3((rnd() - 0.5) * 0.4, 0.3, (rnd() - 0.5) * 0.4);
      p.v = dvec3(0, 2.8, 0);
      p.s0 = 0.8 + rnd() * 0.4; p.s1 = 10 + rnd() * 5; p.life = 9 + rnd() * 4; p.age = 0;
    }
  }
  // (the pad's breeze: pad.js update, its steady part)
  const dvec3 wind(2.2, 0, 1.2);
  const double kd = std::exp(-dt * 0.25), kr = std::exp(-dt * 0.1);
  for (Puff& p : smoke_) {
    if ((p.age += dt) > p.life) continue;
    double f = p.age / p.life;
    p.v.x = p.v.x * kd + wind.x * (1 - kd) * f; p.v.z = p.v.z * kd + wind.z * (1 - kd) * f; p.v.y *= kr;
    p.p += p.v * dt;
  }
}

// model.js loadRack: your own skis and poles in the side basket while you ride
void Heli::loadRack() {
  rackOn_ = false;
  if (!assets_ || !c_.player->hasSkis) return;
  const SkiDef* sk = skiById(c_.save->skis);
  gear_ = rigGear(*assets_, sk ? sk->model : "ski_rental", true);
  rackOn_ = gear_ && gear_->ski;
}

void Heli::debugPlace(double x, double z, double agl, double yaw) {
  flight.place(x, z, yaw, groundFn_);
  flight.landed = false;
  flight.pos.y = ground(x, z) + flight.fr.cgH + agl;
  flight.updateQuat();
  rpm = 1; spun_ = true;
}

// heli/collide.js: soft collisions while it flies (you or its pilot): trees, buildings / lift stations and towers /
// nets / posts (the colliders, each given a height), cars. Nothing breaks: it is pushed back out a little at a time,
// its speed into the obstacle is taken away (a small bounce) and the airspeed you asked for eases off while you keep
// pushing against it. (The terrain is the flight model's job.) Returns 0 (clear) .. 1 (pushed hard this frame).
double Heli::collide(double dt) {
  HeliFlight& f = flight;
  if (f.landed || dt <= 0 || f.agl > 60) return 0;
  constexpr double ROTOR_R = 5.1, ROTOR_UP = 2.2, BODY_R = 2.0, BODY_UP = 1.3, TAIL_R = 1.0, TAIL_BACK = 4.6;
  const dvec3 p = f.pos;
  const double fx = std::sin(f.yaw), fz = std::cos(f.yaw);
  // the parts tested against each obstacle: x, z, radius, y
  const double parts[4][4] = {{p.x, p.z, ROTOR_R, p.y + ROTOR_UP}, {p.x, p.z, BODY_R, p.y + BODY_UP}, {p.x, p.z, BODY_R, p.y - f.fr.cgH + 0.2}, {p.x - fx * TAIL_BACK, p.z - fz * TAIL_BACK, TAIL_R, p.y + 0.6}};
  dvec3 acc(0);
  int n = 0;
  // push from a vertical obstacle at (ox, oz), from y0 (radius r0) up to y1 (radius r1)
  auto vertical = [&](double ox, double oz, double y0, double y1, double r0, double r1) {
    for (const auto& q : parts) {
      if (q[3] < y0 || q[3] > y1) continue;
      double r = r0 + ((r1 - r0) * (q[3] - y0)) / std::max(0.01, y1 - y0);
      double dx = q[0] - ox, dz = q[1] - oz;
      if (std::fabs(dx) > q[2] + r || std::fabs(dz) > q[2] + r) continue;
      double d = std::hypot(dx, dz), over = q[2] + r - d;
      if (over <= 0) continue;
      acc.x += (d > 1e-3 ? dx / d : 1) * over; acc.z += (d > 1e-3 ? dz / d : 0) * over; n++;
    }
  };
  const Scenery& S = *c_.scenery;
  // trees: a trunk, then a cone of branches up to the top
  if (f.agl < 40) {
    const Tree* seen[4] = {nullptr, nullptr, nullptr, nullptr};
    for (int i = 0; i < 4; i++) {
      const Tree* t = S.treeAt(parts[i][0], parts[i][1], parts[i][2] + 1.5, true);
      bool dup = false;
      for (int j = 0; j < i; j++) if (seen[j] == t) dup = true;
      seen[i] = t;
      if (!t || dup) continue;
      double crown = t->y + t->s * 0.12;
      vertical(t->x, t->z, t->y, crown, t->trunk, t->trunk);
      vertical(t->x, t->z, crown, t->y + t->s, t->s * 0.21, 0.25);
    }
  }
  // buildings, stations, nets, posts, cars (not the helicopter's own parked colliders: it is flying)
  if (f.agl < 30) {
    auto one = [&](const Collider& c, bool car) {
      double size = c.r >= 0 ? c.r : std::max(c.hw, c.hd), reach = size + ROTOR_R + 1;
      if (std::fabs(p.x - c.x) > reach || std::fabs(p.z - c.z) > reach) return;
      double g = ground(c.x, c.z);
      // a collider's height above the snow (they only carry a footprint): nets, posts and signs are low, lift towers tall
      double h = c.top < 1e29 ? c.top - g : c.soft ? 3.4 : size >= 4 ? std::min(18.0, 6 + size * 0.9) : size >= 1.5 ? 9 : size >= 0.95 ? 22 : 4.5;
      if (car) h += 0.5;
      if (c.r >= 0) { vertical(c.x, c.z, g - 1, g + h, c.r, c.r); return; }
      // an oriented box from the snow up to its height; building colliders are drawn in from the walls (you walk
      // under the eaves), so for the rotor they grow back out
      double cs = std::cos(-c.rot), sn = std::sin(-c.rot);
      bool big = !c.soft && std::min(c.hw, c.hd) > 1.5;
      double hw = big ? c.hw * 1.2 + 0.6 : c.hw, hd = big ? c.hd * 1.2 + 0.6 : c.hd;
      for (const auto& q : parts) {
        if (q[3] < g - 1 || q[3] > g + h) continue;
        double lx = (q[0] - c.x) * cs - (q[1] - c.z) * sn, lz = (q[0] - c.x) * sn + (q[1] - c.z) * cs;
        double ox = hw + q[2] - std::fabs(lx), oz = hd + q[2] - std::fabs(lz);
        if (ox <= 0 || oz <= 0) continue;
        double nlx = 0, nlz = 0;
        if (ox < oz) nlx = lx < 0 ? -1 : 1; else nlz = lz < 0 ? -1 : 1;
        double push = std::min(ox, oz), c2 = std::cos(c.rot), s2 = std::sin(c.rot);
        acc.x += (nlx * c2 - nlz * s2) * push; acc.z += (nlx * s2 + nlz * c2) * push; n++;
      }
    };
    const auto& cols = S.colliders();
    std::vector<int> done;
    for (int ox = -1; ox <= 1; ox++) for (int oz = -1; oz <= 1; oz++) {
      const std::vector<int>* L = S.collidersNear(p.x + ox * 14.0, p.z + oz * 14.0);
      if (!L) continue;
      for (int i : *L) { if (std::find(done.begin(), done.end(), i) != done.end()) continue; done.push_back(i); one(cols[size_t(i)], false); }
    }
    for (const Collider& c : S.dynamic) {
      // (its own cabin / tail colliders from the moment before it lifted off)
      if (c.r > 0 && (std::hypot(c.x - (p.x + fx * 0.9), c.z - (p.z + fz * 0.9)) < 0.8 || std::hypot(c.x - (p.x - fx * 4.6), c.z - (p.z - fz * 4.6)) < 0.8)) continue;
      one(c, true);
    }
  }
  // lift towers and haul ropes (both directions)
  if (c_.lifts) for (const LiftLine& l : c_.lifts->lines()) {
    double bx = p.x - l.B.x, bz = p.z - l.B.z;
    double u = bx * l.dir.x + bz * l.dir.y;
    if (u < -8 || u > l.L + 8) continue;
    double lat = bx * l.sideV.x + bz * l.sideV.y, side = l.cfg.side;
    if (std::fabs(lat) > side + ROTOR_R + 2) continue;
    for (const dvec2& tw : l.supports) {
      double tx = l.B.x + l.dir.x * tw.x, tz = l.B.z + l.dir.y * tw.x;
      vertical(tx, tz, ground(tx, tz) - 1, tw.y + 1.5, 0.9, 0.9);
    }
    if (u < 0 || u > l.L) continue;
    // the ropes: horizontal lines across the helicopter's path (pushed sideways, or up / down when that is less)
    for (int sd = -1; sd <= 1; sd += 2) {
      double cy = l.cableAt(u, sd).y, cl = sd * side;
      for (const auto& q : parts) {
        double dl = lat - cl, over = q[2] - std::fabs(dl), dy = q[3] - cy, overY = (q[2] == ROTOR_R ? 0.45 : 1.2) - std::fabs(dy);
        if (over <= 0 || overY <= 0) continue;
        if (overY < over) { acc.y += (dy < 0 ? -1 : 1) * overY; n++; }
        else { double s = dl < 0 ? -1 : 1; acc.x += l.sideV.x * s * over; acc.z += l.sideV.y * s * over; n++; }
      }
    }
  }
  if (!n) return 0;
  // push out softly (part of the overlap each frame), take away the speed into the obstacle (+ a small bounce)
  double len = glm::length(acc);
  if (len < 1e-9) return 0;
  const double k = std::min(1.0, dt * 14), step = std::min(len * k, 1.2);
  const dvec3 nrm = acc / len;
  f.pos += nrm * step;
  double vn = glm::dot(f.vel, nrm);
  if (vn < 0) f.vel -= nrm * (vn * 1.25);
  // still pushing the nose into it: the commanded airspeed eases off (you stop against it rather than grind)
  double into = fx * nrm.x + fz * nrm.z;
  if (into < -0.2 && f.u > 0) f.u *= std::exp(-dt * 7 * -into);
  if (into > 0.2 && f.u < 0) f.u *= std::exp(-dt * 7 * into);
  return std::min(1.0, len);
}

// ------------------------------------------------------------------ landing anywhere
// The spot under the helicopter: flat enough for the skids and clear of trees, buildings, nets and lift lines?
void Heli::landCheck() {
  const HeliFlight& f = flight;
  auto& L = land_;
  L.ok = false; L.warn = true; L.label.clear(); L.hold = 0; L.pad = false;
  if (f.landed || f.agl > LAND_AGL || f.speed() > LAND_SPEED) { L.warn = false; return; }
  double x = f.pos.x, z = f.pos.z, fx = std::sin(f.yaw), fz = std::cos(f.yaw);
  if (std::hypot(x - home.x, z - home.z) < padR + 3) { L.ok = true; L.pad = true; L.warn = false; L.label = "Land on the helipad"; return; }
  // trees (and big boulders) under the rotor disc or the tail: stay above the treetops
  const Scenery& S = *c_.scenery;
  double R = f.fr.rotorR + 2.5;
  if (S.treeAt(x + fx * 1.2, z + fz * 1.2, R, false) || S.treeAt(x - fx * 4.6, z - fz * 4.6, 3, false)) { L.label = "Trees below \xC2\xB7 find open snow"; L.hold = 20; return; }
  if (S.rockAt(x + fx * 1.2, z + fz * 1.2, R, 1.2) || S.rockAt(x - fx * 4.6, z - fz * 4.6, 3, 1.2)) { L.label = "Rocks below \xC2\xB7 find open snow"; L.hold = 4; return; }
  // buildings, lift stations and towers, safety nets, signs (the colliders), cars and the bus
  if (const Collider* c = colliderNear(S, x, z, f.fr.rotorR + 1.5, true)) {
    double size = c->r >= 0 ? c->r : std::hypot(c->hw, c->hd);
    bool dyn = c >= S.dynamic.data() && c < S.dynamic.data() + S.dynamic.size();
    L.label = c->soft ? "Safety nets below" : dyn ? "Cars below \xC2\xB7 find open snow" : size > 1.5 ? "Too close to buildings" : "Obstacles below \xC2\xB7 find open snow";
    L.hold = c->soft ? 5 : dyn ? (size > 5 ? 6 : 4.5) : size > 1.5 ? 14 : 4;
    return;
  }
  // a lift line (cables overhead) or a cleared lift strip
  if (liftLineNear(x, z, 3)) { L.label = "Lift line below"; L.hold = 16; return; }
  // the slope under the skids
  double slope = std::max(f.slopeAt(groundFn_), skidSlope());
  if (slope > heli::LAND_SLOPE) { L.label = f.agl > JUMP_AGL ? "Too steep to land \xC2\xB7 hover low to jump out" : "Too steep to land"; return; }
  L.ok = true; L.warn = false; L.label = "Land here";
}

// steepest tilt the skids would take on the snow right below (front-back and side to side)
double Heli::skidSlope() const {
  const HeliFlight& f = flight;
  double fx = std::sin(f.yaw), fz = std::cos(f.yaw), lx = fz, lz = -fx;
  double hl = f.fr.skidL / 2 + 0.6, hw = f.fr.skidW / 2 + 0.4, z0 = f.fr.skidZ;
  auto h = [&](double a, double b) { return ground(f.pos.x + fx * a + lx * b, f.pos.z + fz * a + lz * b); };
  double fl = h(z0 + hl, hw), fr = h(z0 + hl, -hw), bl = h(z0 - hl, hw), br = h(z0 - hl, -hw);
  return std::max(std::fabs((bl + br) - (fl + fr)) / 2 / (hl * 2), std::fabs((fl + bl) - (fr + br)) / 2 / (hw * 2));
}

// the cabin's seat (and where the skier's body goes) in the world
void Heli::updateSeat() {
  seatPos_ = flight.world(anchorSeat);
  seatFwd_ = dvec3(std::sin(flight.yaw), 0, std::cos(flight.yaw));
}

bool Heli::seat(dvec3& pos, dvec3& fwd) const {
  if (state == State::Flying) { pos = seatPos_; fwd = seatFwd_; return true; }
  if (state == State::Rescue && rescue.seated) { pos = rescue.seatPos; fwd = rescue.seatFwd; return true; }
  if (state == State::Rescue && rescue.inCabin) {
    // the front passenger seat (left of the pilot's): you ride there, the rescue pilot flies
    pos = flight.world(dvec3(-anchorSeat.x, anchorSeat.y, anchorSeat.z));
    fwd = dvec3(std::sin(flight.yaw), 0, std::cos(flight.yaw));
    return true;
  }
  return false;
}

// chase camera: behind and above, the mouse to look around (it drifts back behind when you let go)
void Heli::placeCamera(double dt, bool snap, bool input) {
  const HeliFlight& f = flight;
  Cam& C = cam;
  if (input && c_.input) {
    const Input& in = *c_.input;
    const double sens = 0.0022 * std::max(0.2, c_.save ? c_.save->setting("sensitivity", 1) : 1.0);
    if (in.lookX() != 0 || in.lookY() != 0) C.lastMouse = time;
    C.yaw -= in.lookX() * sens;
    C.pitch = clamp(C.pitch + in.lookY() * sens, -0.15, 1.2);
    if (in.wheel() != 0) C.dist = clamp(C.dist - in.wheel() * 1.5, 9.0, 45.0);
  }
  if (time - C.lastMouse > 1.5 && !snap) {
    double behind = f.yaw + PI;
    C.yaw += heli::wrapPi(behind - C.yaw) * (1 - std::exp(-dt * 1.6));
    C.pitch += (0.2 + std::min(0.12, f.agl * 0.002) - C.pitch) * (1 - std::exp(-dt * 1.2));
  }
  double dist = C.dist + f.speed() * 0.07;
  dvec3 focus = f.pos + dvec3(f.vel.x * 0.12, 1.1, f.vel.z * 0.12);
  double cp = std::cos(C.pitch);
  dvec3 pos(focus.x + std::sin(C.yaw) * cp * dist, focus.y + std::sin(C.pitch) * dist, focus.z + std::cos(C.yaw) * cp * dist);
  double gy = snow(pos.x, pos.z) + 1.6;
  if (pos.y < gy) pos.y = gy;
  // rotor buzz + a little turbulence at speed
  double vib = 0.008 * rpm + 0.012 * smooth(30, 60, f.speed());
  pos += dvec3(std::sin(time * 61) * vib, std::sin(time * 53 + 1) * vib, std::sin(time * 47 + 2) * vib);
  camPos_ = pos;
  camLook_ = focus + dvec3(std::sin(f.yaw), 0, std::cos(f.yaw)) * 3.0;
  double fov = 62 + f.speed() * 0.12;
  C.fov = snap ? fov : C.fov + (fov - C.fov) * (1 - std::exp(-dt * 3));
  camFovNow_ = C.fov;
  camSet_ = true;
}

bool Heli::camera(Camera& out) const {
  if (!ok_) return false;
  if (state == State::Rescue && rescue.camOn) {
    out.lookAt(rescue.camPos, rescue.camLook);
    out.fovY = float(rescue.camFov); out.nearZ = 0.1f;
    return true;
  }
  if (camSet_ && (state == State::Flying || state == State::Rescue)) {
    out.lookAt(camPos_, camLook_);
    out.fovY = float(camFovNow_); out.nearZ = 0.1f;
    return true;
  }
  if (handoff_ > 0) {   // the blend back to the skier's camera after getting out
    double k = smooth(0, 1, 1 - handoff_ / 1.4);
    dvec3 look = out.pos + dvec3(out.forward()) * 12.0;
    out.lookAt(glm::mix(handPos_, out.pos, k), glm::mix(handLook_, look, k));
    out.fovY = float(out.fovY + (handFov_ - out.fovY) * (1 - k));
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ the compass, the HUD line
const DropZone* Heli::targetZone(double skip) const {
  const dvec3& p = flight.pos;
  if (plan_ && (skip == 0 || std::hypot(plan_->x - p.x, plan_->z - p.z) >= skip)) return plan_;
  const DropZone* best = nullptr;
  double bd = 1e9;
  for (const DropZone& z : zones_) {
    if (z.race) continue;
    double d = std::hypot(z.x - p.x, z.z - p.z);
    if (d >= skip && d < bd) { bd = d; best = &z; }
  }
  return best;
}

bool Heli::waypoint(std::string& label, double& x, double& z) const {
  if (!active()) return false;
  const DropZone* zn = targetZone(250);
  if (!zn) return false;
  label = "Drop zone \xC2\xB7 " + zn->name; x = zn->x; z = zn->z;
  return true;
}

std::string Heli::objective() const {
  if (state == State::Rescue) return rescue.hudLine();
  if (!active()) return "";
  return "Set down on flat open snow (" + c_.K(Action::Sprint) + "), or hover low over a steep slope and jump out (" + c_.K(Action::Interact) + ")";
}

bool Heli::rotorAt(dvec3& out, double& rpmOut, bool& inside) const {
  if (!ok_ || rpm < 0.02 || (state == State::Rescue && rescue.gone)) return false;
  out = flight.pos; rpmOut = rpm; inside = active() || rescue.aboard();
  return true;
}
bool Heli::sirenAt(dvec3& out) const {
  if (state != State::Rescue || !rescue.amb.visible) return false;
  if (rescue.phase != HeliRescue::Phase::Arrive && rescue.phase != HeliRescue::Phase::Ambulance) return false;
  out = rescue.amb.pos();
  return true;
}

void Heli::fillColliders(std::vector<Collider>& out) const {
  if (!ok_) return;
  const HeliFlight& f = flight;
  // solid only while it stands still somewhere (parked, or set down by the rescue: nobody walks through it)
  bool still = (state == State::Parked || state == State::Rescue) && f.landed && !(state == State::Rescue && rescue.gone);
  if (still) {
    double fx = std::sin(f.yaw), fz = std::cos(f.yaw);
    Collider a; a.x = f.pos.x + fx * 0.9; a.z = f.pos.z + fz * 0.9; a.r = 2.1; out.push_back(a);
    Collider b; b.x = f.pos.x - fx * 4.6; b.z = f.pos.z - fz * 4.6; b.r = 0.7; out.push_back(b);
  }
  rescue.amb.fillColliders(out);
}

// heli/fx.js Downwash: a cloud of powder blown out from under the rotor when it is close to the snow (strength: rotor
// speed x how close the rotor is to the snow; only a dusting over the cleared helipad), left behind as it moves
void Heli::updateWash(double dt) {
  const HeliFlight& f = flight;
  dvec3 hub = f.world(anchorHub);
  hub.y = ground(hub.x, hub.z);
  double k = rpm * rpm * (1 - smooth(1.5, 19, f.agl));
  if (state == State::Rescue && rescue.gone) k = 0;
  if (k > 0.02) {
    if (puffs_.empty()) puffs_.resize(300);
    double pad = std::hypot(hub.x - home.x, hub.z - home.z) < padR ? 1 : 0;
    double amount = k * (1 - 0.8 * pad);
    puffAcc_ += dt * 105 * amount;
    while (puffAcc_ >= 1) {
      puffAcc_ -= 1;
      double a = rnd() * TAU, r = f.fr.rotorR * (0.2 + rnd() * 0.75), out = (6 + rnd() * 9) * (0.45 + 0.55 * k);
      Puff& p = puffs_[puffNext_];
      puffNext_ = (puffNext_ + 1) % puffs_.size();
      p.p = dvec3(hub.x + std::cos(a) * r, hub.y + 0.5 + rnd() * 0.9, hub.z + std::sin(a) * r);
      p.v = dvec3(std::cos(a) * out + f.vel.x * 0.3, 0.8 + rnd() * 3.2 * k, std::sin(a) * out + f.vel.z * 0.3);
      p.s0 = 1.8 + rnd() * 2.2; p.s1 = p.s0 * (2.8 + rnd() * 1.8); p.life = 1.8 + rnd() * 1.8; p.age = 0;
    }
  }
  const double kd = std::exp(-dt * 1.1), kr = std::exp(-dt * 0.6);
  for (Puff& p : puffs_) {
    if ((p.age += dt) > p.life) continue;
    p.v.x *= kd; p.v.z *= kd; p.v.y *= kr;
    p.p += p.v * dt;
  }
}

// ------------------------------------------------------------------ drawing
void Heli::draw(Renderer& r, const Camera& camera) {
  if (!ok_) return;
  const dvec3 camP = camera.pos;
  // the downwash's puffs: soft round sprites facing the camera, growing and thinning out
  bool anyPuff = false;
  puffDraw_.begin();
  if (!puffs_.empty() && puffModel_[0] && c_.dev) {
    bool any = false;
    for (const Puff& p : puffs_) {
      if (p.age > p.life) continue;
      double fl = p.age / p.life, sz = p.s0 + (p.s1 - p.s0) * (1 - (1 - fl) * (1 - fl));
      // (never a white wall right in front of the lens)
      double al = std::min(1.0, p.age * 5) * (1 - fl) * (1 - fl) * smooth(2, 10, glm::length(p.p - camP));
      int b = int(al * 4);
      if (al < 0.04) continue;
      glm::dmat4 M(1);
      M[0] = glm::dvec4(dvec3(camera.basis[0]) * sz, 0);
      M[1] = glm::dvec4(dvec3(camera.basis[1]) * sz, 0);
      M[2] = glm::dvec4(dvec3(camera.basis[2]) * sz, 0);
      M[3] = glm::dvec4(p.p, 1);
      puffDraw_.add(puffModel_[std::clamp(b, 0, 3)].get(), M, 0);
      any = true;
    }
    if (any) anyPuff = true;
  }
  // the drop zone's red smoke and the flare's flickering glow on the snow
  if (!smoke_.empty() && smokeModel_[0] && c_.dev) {
    bool any = false;
    for (const Puff& p : smoke_) {
      if (p.age > p.life) continue;
      double fl = p.age / p.life, sz = p.s0 + (p.s1 - p.s0) * (1 - (1 - fl) * (1 - fl));
      double al = std::min(1.0, p.age * 5) * (1 - fl) * (1 - fl) * smooth(2, 10, glm::length(p.p - camP));
      if (al < 0.04) continue;
      glm::dmat4 M(1);
      M[0] = glm::dvec4(dvec3(camera.basis[0]) * sz, 0);
      M[1] = glm::dvec4(dvec3(camera.basis[1]) * sz, 0);
      M[2] = glm::dvec4(dvec3(camera.basis[2]) * sz, 0);
      M[3] = glm::dvec4(p.p, 1);
      puffDraw_.add(smokeModel_[std::clamp(int(al * 4), 0, 3)].get(), M, 0);
      any = true;
    }
    if (any) anyPuff = true;
  }
  if (anyPuff) puffDraw_.submit(r, *c_.dev, camP);
  if (flareOn_ && c_.shapes) {
    double k = 5 + std::sin(time * 23) * 1.2 + std::sin(time * 37 + 1) * 0.8;
    c_.shapes->sphere(r, flareAt_ + dvec3(0, 0.25, 0), 0.22, vec4(1.0f, 0.32f, 0.12f, 1), float(std::round(k)));
  }
  rescue.draw(r, camP);
  if (state == State::Rescue && rescue.gone) return;   // (gone after the hand-over to the ambulance)
  const HeliFlight& f = flight;
  if (glm::length(f.pos - camP) > 6000) return;
  const mat4 R = mat4(glm::mat4_cast(glm::quat(f.quat)));
  r.submitModel(*parts_.body, f.pos, R, nullptr, true);
  // the airframe's frame (model.js: reference units, K m each, its centre of mass at the root's origin)
  const mat4 A = R * glm::translate(mat4(1), airPos_) * glm::scale(mat4(1), vec3(float(K_)));
  const double blur = smooth(0.28, 0.9, rpm);
  const float droop = float(-0.045 + 0.07 * smooth(0.2, 1, rpm));
  const mat4 spin = A * glm::translate(mat4(1), hub_) * glm::rotate(mat4(1), float(angle_), vec3(0, 1, 0));
  if (parts_.hub) r.submitModel(*parts_.hub, f.pos, spin, nullptr, true);
  if (parts_.blade) {
    for (Material& m : parts_.blade->materials) m.baseColor.w = float(1 - 0.72 * blur);
    for (int i = 0; i < 4; i++) {
      mat4 M = spin * glm::rotate(mat4(1), float(i * PI / 2), vec3(0, 1, 0)) * glm::translate(mat4(1), vec3(float(bladeX_), 0, 0)) * glm::rotate(mat4(1), droop, vec3(0, 0, 1));
      r.submitModel(*parts_.blade, f.pos, M, nullptr, rpm < 0.45);   // (a spinning rotor casts no crisp blade shadows)
    }
  }
  if (parts_.disc && blur > 0.01) {
    for (Material& m : parts_.disc->materials) { m.baseColor.w = float(0.78 * blur); m.doubleSided = true; }
    r.submitModel(*parts_.disc, f.pos, A * glm::translate(mat4(1), hub_ + vec3(0, float(discY_), 0)) * glm::rotate(mat4(1), float(angle_), vec3(0, 1, 0)), nullptr, false);
  }
  const mat4 tspin = A * glm::translate(mat4(1), tailHub_) * glm::rotate(mat4(1), float(tailAngle_), vec3(1, 0, 0));
  if (parts_.tailHub) r.submitModel(*parts_.tailHub, f.pos, tspin, nullptr, true);
  const double tOp = 1 - smooth(0.2, 0.6, rpm);
  if (parts_.tailBlades && tOp > 0.02) {
    for (Material& m : parts_.tailBlades->materials) m.baseColor.w = float(tOp);
    r.submitModel(*parts_.tailBlades, f.pos, tspin, nullptr, rpm < 0.45);
  }
  if (parts_.tailDisc && rpm > 0.12) {
    for (Material& m : parts_.tailDisc->materials) { m.baseColor.w = float(0.7 * smooth(0.15, 0.55, rpm)); m.doubleSided = true; }
    r.submitModel(*parts_.tailDisc, f.pos, A * glm::translate(mat4(1), tailHub_ + vec3(float(tailDiscX_), 0, 0)) * glm::rotate(mat4(1), float(tailAngle_), vec3(1, 0, 0)), nullptr, false);
  }
  // ---- the landing light (model.js updateLamp): on at night whenever it flies; the beam under the nose (LAMP_TILT
  // below it), marched to the snow, and its pool there (a spot light on the snow)
  {
    const double night = c_.night;
    const double lit = lampOn_ * night;
    if (lit > 0.02 && c_.shapes) {
      const double LAMP_TILT = 0.62;
      dvec3 lamp = f.world(anchorLamp), dir = f.quat * dvec3(0, -std::sin(LAMP_TILT), std::cos(LAMP_TILT));
      double far = 160, len = far;
      for (double s = 2; s <= far; s += s < 30 ? 2 : 5) { dvec3 q = lamp + dir * s; if (q.y <= ground(q.x, q.z)) { len = s; break; } }
      c_.shapes->sphere(r, lamp, 0.07, vec4(1, 0.93f, 0.8f, 1), 9);
      c_.shapes->beam(r, lamp, lamp + dir * len, len * std::tan(0.3), vec4(1.0f, 0.94f, 0.82f, float(std::round(lit * (0.05 + 0.1 * c_.snowing) * std::min(1.0, 25 / len) * 100) / 100 + 0.01)), 0.05f);
      PointLight L;
      L.pos = lamp; L.dir = vec3(dir);
      L.color = vec3(1.0f, 0.93f, 0.8f) * float(lit * 1.25 * clamp(len * len * 1.5, 300.0, 6000.0));   // (the pool as bright from 40 m up as from 10)
      L.range = float(len * 1.35 + 12);
      L.cosOuter = float(std::cos(0.36)); L.cosInner = float(std::cos(0.08));
      r.addLight(L);
    }
  }
  // ---- your skis and poles riding in the basket
  if (rackOn_ && gear_ && (state == State::Flying || (state == State::Rescue && (rescue.inCabin || rescue.attached)))) {
    const mat4 B = R * glm::translate(mat4(1), vec3(anchorBasket) + vec3(0, -0.1f, 0));
    for (int s = -1; s <= 1; s += 2) {
      r.submitModel(*gear_->ski, f.pos, B * glm::translate(mat4(1), vec3(s * 0.075f, 0.018f, 0)) * glm::rotate(mat4(1), s * 0.05f, vec3(0, 0, 1)) * mat4(gear_->skiFit), nullptr, true);
      if (gear_->pole) r.submitModel(*gear_->pole, f.pos, B * glm::translate(mat4(1), vec3(s * 0.06f, 0.08f, -0.62f)) * glm::rotate(mat4(1), float(-PI / 2), vec3(1, 0, 0)) * mat4(gear_->poleFit), nullptr, true);
    }
  }
  // lamps: nav lights steady, beacons pulse, strobes double-flash (model.js update)
  if (rpm > 0.05 && c_.shapes && glm::length(f.pos - camP) < 1500) {
    const double night = std::round(double(c_.night) * 8) / 8, day = 0.4 + 0.6 * night;
    auto beat = [&](double period, double width, double phase) { double x = std::fmod(time + phase + period * 4, period) / period; return x < width ? 1.0 : 0.0; };
    for (const Lamp& L : LAMPS) {
      double k = 0;
      if (L.kind == 0) k = 3.2 * day;
      else if (L.kind == 1 || L.kind == 2) k = 5 * day * std::max(beat(1.1, 0.13, L.kind == 2 ? 0.55 : 0), 0.05);
      else k = 12 * day * std::max(beat(1.6, 0.04, 0), beat(1.6, 0.04, -0.12));
      if (k < 0.3) continue;
      dvec3 wp = f.pos + dvec3(vec3(A * vec4(L.x, L.y, L.z, 1)));
      c_.shapes->sphere(r, wp, 0.03 + 0.014 * L.s, vec4(L.r, L.g, L.b, 1), float(std::min(k, 6.0)));
    }
  }
}

// ------------------------------------------------------------------ the flight HUD (heli/hud.js)
void Heli::hud(Ui& ui, float u) {
  if (!ok_ || state != State::Flying) return;
  using namespace ui_color;
  const HeliFlight& f = flight;
  float W = float(ui.width()), H = float(ui.height());
  Ui::Shadow sh{0, 6 * u, 14 * u, hex(0x00143c, 0.28f)};
  // speed + height above the snow bottom-right where the speedometer sits, the rotor gauge while it spools up
  bool spool = rpm < 0.995;
  float pw = 214 * u, ph = (spool ? 150 : 124) * u, px = W - 22 * u - pw, py = H - 22 * u - ph;
  ui.brushPanel(px, py, pw, ph, white, 0, &sh);
  ui.rect(px + 16 * u, py + ph * 0.32f, 5 * u, ph * 0.36f, red);
  float right = px + pw - 28 * u, unitW = 44 * u;
  char b[32];
  std::snprintf(b, sizeof b, "%d", int(std::round(f.speed() * 3.6)));
  ui.text(right - unitW - 8 * u, py + 8 * u, 56 * u, UiFont::CondSemiItalic, blue, b, UiAlign::Right);
  ui.text(right - unitW, py + 40 * u, 11 * u, UiFont::BodyHeavy, blueDim, "KM/H", UiAlign::Left, 0.14f);
  std::snprintf(b, sizeof b, "%d", int(std::max(0.0, std::round(f.agl))));
  float aw = ui.text(right - unitW - 8 * u, py + 68 * u, 40 * u, UiFont::CondSemiItalic, blue, b, UiAlign::Right);
  ui.text(right - unitW, py + 88 * u, 11 * u, UiFont::BodyHeavy, blueDim, "M ALT", UiAlign::Left, 0.14f);
  if (std::fabs(f.vel.y) > 0.8) {   // the climb / sink arrow
    float ax = right - unitW - 8 * u - aw - 12 * u, ay = py + 90 * u;
    if (f.vel.y > 0) ui.tri(vec2(ax - 6 * u, ay + 4 * u), vec2(ax + 6 * u, ay + 4 * u), vec2(ax, ay - 5 * u), ui_color::ok);
    else ui.tri(vec2(ax - 6 * u, ay - 5 * u), vec2(ax + 6 * u, ay - 5 * u), vec2(ax, ay + 4 * u), red);
  }
  if (spool) {
    float bx = px + 40 * u, by = py + 124 * u;
    ui.text(bx, by - 5 * u, 11 * u, UiFont::BodyHeavy, blueDim, "ROTOR", UiAlign::Left, 0.14f);
    float x0 = bx + 58 * u, bw = right - x0;
    ui.rect(x0, by, bw, 6 * u, bluePale);
    ui.rect(x0, by, bw * float(rpm), 6 * u, red);
  }
  // the prompt bottom-centre
  if (!promptText_.empty()) {
    float ts = 14 * u, tw = ui.textWidth(promptText_, ts, UiFont::BodyBold);
    float kw = promptKey_.empty() ? 0 : ui.keycapWidth(26 * u, promptKey_) + 10 * u;
    float w = tw + kw + (promptKey_.empty() ? 44 : 34) * u, h = 44 * u, x = W * 0.5f - w * 0.5f, y = H - 84 * u - h;
    ui.brushPanel(x, y, w, h, white, 1, &sh);
    float cx = x + (promptKey_.empty() ? 22 : 12) * u;
    if (!promptKey_.empty()) cx += ui.keycap(cx, y + 9 * u, 26 * u, promptKey_, true) + 10 * u;
    ui.text(cx, y + (h - ui.lineHeight(ts, UiFont::BodyBold)) * 0.5f, ts, UiFont::BodyBold, promptWarn_ ? ko : blue, promptText_);
  }
  // the controls card bottom-left for the first seconds of a flight
  if (keysT_ > 0) {
    const std::pair<std::string, const char*> rows[] = {
      {c_.K(Action::Forward) + " " + c_.K(Action::Back), "Speed up \xC2\xB7 slow down"}, {c_.K(Action::Left) + " " + c_.K(Action::Right), "Turn"},
      {c_.K(Action::Jump), "Climb"}, {c_.K(Action::Sprint), "Descend \xC2\xB7 land on flat snow"}, {"MOUSE", "Look around"},
      {c_.K(Action::Interact), "Get out \xC2\xB7 or jump out hovering low"}};
    float a = float(clamp(keysT_ / 0.6, 0.0, 1.0));
    float cw = 330 * u, chh = (40 + 24 * 6) * u, cx = 22 * u - (1 - a) * 24 * u, cy = H - 92 * u - chh;
    ui.pushAlpha(a);
    ui.brushPanel(cx, cy, cw, chh, white, 1, &sh);
    ui.text(cx + 20 * u, cy + 10 * u, 15 * u, UiFont::CondItalic, red, "HELICOPTER", UiAlign::Left, 0.08f);
    for (int i = 0; i < 6; i++) {
      float ry = cy + (36 + 24 * i) * u;
      ui.text(cx + 20 * u, ry, 12.5f * u, UiFont::BodyHeavy, blue, rows[i].first);
      ui.text(cx + 118 * u, ry, 12.5f * u, UiFont::BodySemi, blueDim, rows[i].second);
    }
    ui.popAlpha();
  }
}

} // namespace sl
