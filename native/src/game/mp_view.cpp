// The other players drawn, and the multiplayer overlays (see mp_view.h).
#include "game/mp_view.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/mp_session.h"
#include "game/people.h"
#include "game/vehicles.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr double TAG_FAR = 150, HIDE_FAR = 2500;
using namespace ui_color;

std::string str(const Json& j, const char* k) { auto it = j.find(k); return it != j.end() && it->is_string() ? it->get<std::string>() : ""; }
bool atOf(const Json& v, dvec3& p, double& yaw) {
  if (!v.is_object() || !v.contains("at") || !v["at"].is_array() || v["at"].size() < 4) return false;
  const Json& a = v["at"];
  for (int i = 0; i < 4; i++) if (!a[size_t(i)].is_number()) return false;
  p = dvec3(a[0].get<double>(), a[1].get<double>(), a[2].get<double>());
  yaw = a[3].get<double>();
  return true;
}
// "car:Owner:1" -> kind, owner, seat
bool parseVeh(const std::string& v, std::string& k, std::string& owner, int& seat) {
  size_t a = v.find(':'), b = v.rfind(':');
  if (a == std::string::npos || b == a) return false;
  k = v.substr(0, a); owner = v.substr(a + 1, b - a - 1); seat = std::atoi(v.c_str() + b + 1);
  return true;
}
bool visible(const RemotePlayer& r, const std::string& interior, const dvec3& cam) {
  if (!r.ok || r.interior != interior) return false;
  return std::hypot(r.sm.x - cam.x, r.sm.z - cam.z) < HIDE_FAR;
}
} // namespace

bool mpCarFrame(const Multiplayer& mp, const VehicleModels& vm, const std::string& owner, glm::dmat4& car, CarTemplate& t, double& roll) {
  for (const auto& [id, r] : mp.players) {
    if (r.name != owner || !r.vehs.contains("car") || !r.vehs["car"].is_object()) continue;
    const Json& v = r.vehs["car"];
    const std::string model = str(v.value("cfg", Json::object()), "id");
    const VehicleModel* m = vm.car(model);
    if (!m || !m->ok()) return false;
    dvec3 p;
    double yaw;
    roll = 0;
    if (r.ok && (r.flags & net::F::car) && r.interior.empty()) { p = r.sm; yaw = r.smYaw; roll = std::clamp(r.lean, -3.2, 3.2); }
    else if (!atOf(v, p, yaw)) return false;
    // (as addDraw draws it)
    car = glm::translate(glm::dmat4(1), p + dvec3(0, 0.02, 0)) * glm::rotate(glm::dmat4(1), yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), roll, dvec3(0, 0, 1));
    t = CarTemplate::of(carSeatsFor(model), double(m->size.y));
    return true;
  }
  return false;
}

void MpView::addPeople(const Multiplayer& mp, People& people, const dvec3& cam, const std::string& interior, double dt) {
  int fallback = people.kind("skier_blue");
  for (const auto& [id, r] : mp.players) {
    if (!visible(r, interior, cam)) continue;
    std::string ch = r.look.is_object() ? str(r.look, "c") : "";
    int kind = ch.empty() ? -1 : people.kind(ch);
    if (kind < 0) kind = fallback;
    if (kind < 0) continue;
    // their walk / ski cycle: advanced by their own speed here
    auto it = std::find_if(phases_.begin(), phases_.end(), [&](auto& e) { return e.first == id; });
    if (it == phases_.end()) { phases_.push_back({id, 0.0}); it = phases_.end() - 1; }
    double spd = std::hypot(r.vel.x, r.vel.z);
    Person p;
    p.kind = kind;
    p.pos = r.sm;
    p.yaw = r.smYaw;
    p.skis = (r.flags & net::F::skisOn) != 0;
    p.lean = float(std::clamp(r.lean, -0.8, 0.8));
    std::string vk, owner;
    int seat = 0;
    bool inVeh = !r.veh.empty() && parseVeh(r.veh, vk, owner, seat);
    switch (net::St(r.st)) {
      case net::St::Ski: p.anim = (r.flags & net::F::tuck) ? PAnim::Tuck : PAnim::Ski; it->second += dt; break;
      case net::St::Sit: case net::St::Ride: p.anim = PAnim::Sit; p.skis = p.skis && vk != "car" && vk != "bus" && vk != "train" && vk != "express"; break;
      case net::St::Drive:
        p.anim = PAnim::Sit; p.skis = false; break;     // (at the wheel of their car (below), or astride a snowmobile)
      case net::St::Fall: p.anim = PAnim::Lie; break;
      case net::St::Fly: p.anim = PAnim::Idle; break;
      default:
        p.anim = spd > 4.5 ? PAnim::Run : spd > 0.35 ? PAnim::Walk : PAnim::Idle;
        it->second += p.anim == PAnim::Idle ? dt : spd * dt / (p.anim == PAnim::Run ? 2.2 : 1.16);
        break;
    }
    p.phase = it->second;
    // (vehicles.js seatFor) in a car: at the wheel of their own, riding with someone, riding in YOUR car (in its seat as
    // it is drawn here: no lag): the seat point of that car, the legs into its footwell (remote.js carLegs: seatLegs)
    std::string carOwner;
    int carSeat = 0;
    if (inVeh && vk == "car") { carOwner = owner; carSeat = seat; }
    else if (net::St(r.st) == net::St::Drive && (r.flags & net::F::car)) carOwner = r.name;
    if (!carOwner.empty()) {
      glm::dmat4 M(1);
      CarTemplate ct;
      double roll = 0;
      bool ok = carOwner == mp.name ? myCar && myCar(M, ct) : models && mpCarFrame(mp, *models, carOwner, M, ct, roll);
      if (!ok && carOwner == mp.name && myCarSeat) {   // (a car without seat hints)
        dvec3 sp;
        double yaw;
        if (myCarSeat(seat, sp, yaw)) { p.pos = sp; p.yaw = yaw; p.anim = PAnim::Sit; p.skis = false; }
      }
      if (!ok && net::St(r.st) == net::St::Drive) continue;   // (their car not drawn here: nothing to sit in)
      if (ok && std::fabs(roll) > 0.6) continue;              // (rolled over: inside the car, as on their screen)
      three::V3 pts[4];
      int n = ok ? carSeatPoints(ct, pts) : 0;
      if (n > 0) {
        int s = std::max(0, std::min(carSeat, n - 1));
        p.pos = dvec3(M * glm::dvec4(pts[s], 1));
        p.yaw = std::atan2(M[2][0], M[2][2]);
        p.anim = PAnim::Sit; p.skis = false;
        p.car.how = CarSeatRef::Seated; p.car.car = M; p.car.t = ct; p.car.seat = carSeat; p.car.driver = carSeat == 0;
      }
    }
    people.add(p);
  }
}

void MpView::addDraw(const Multiplayer& mp, VehicleDraw& vd, const VehicleModels& vm, const Model* sled, const glm::mat4& sledFit,
                     const dvec3& cam, const std::string& interior) const {
  if (!interior.empty()) return;   // (cars and sleds are outdoors)
  auto car = [&](const Json& cfg, const dvec3& p, double yaw, double roll) {
    const VehicleModel* m = vm.car(str(cfg, "id"));
    if (!m || !m->ok()) return;
    double d = std::hypot(p.x - cam.x, p.z - cam.z);
    if (d > 500) return;
    glm::dmat4 M = glm::translate(glm::dmat4(1), p + dvec3(0, 0.02, 0)) * glm::rotate(glm::dmat4(1), yaw, dvec3(0, 1, 0)) *
                   glm::rotate(glm::dmat4(1), roll, dvec3(0, 0, 1));
    vd.addCar(*m, M, d < 70 ? 0 : 1, paintColor(str(cfg, "paint")));   // (Phase 7: their paint)
  };
  for (const auto& [id, r] : mp.players) {
    // their car: driven (the presence row is its pose) or parked where they left it
    if (r.vehs.contains("car") && r.vehs["car"].is_object()) {
      const Json& v = r.vehs["car"];
      const Json cfg = v.value("cfg", Json::object());
      dvec3 p;
      double yaw;
      if (r.ok && (r.flags & net::F::car) && r.interior.empty()) car(cfg, r.sm, r.smYaw, std::clamp(r.lean, -3.2, 3.2));
      else if (atOf(v, p, yaw)) car(cfg, p, yaw, 0);
    }
    // their other cars parked in the world
    if (r.parked.is_array())
      for (const Json& e : r.parked) {
        dvec3 p;
        double yaw;
        if (atOf(e, p, yaw)) car(e.value("cfg", Json::object()), p, yaw, 0);
      }
    // their snowmobile
    if (sled) {
      dvec3 p;
      double yaw;
      bool on = r.ok && (r.flags & net::F::sled) && r.interior.empty();
      if (on) { p = r.sm; yaw = r.smYaw; }
      if (on || (r.vehs.contains("sled") && atOf(r.vehs["sled"], p, yaw))) {
        double d = glm::length(p - cam);
        if (d < 380) vd.add(sled, glm::translate(glm::dmat4(1), p) * glm::rotate(glm::dmat4(1), yaw, dvec3(0, 1, 0)) * glm::dmat4(sledFit), d > 60 ? 1 : 0);
      }
    }
  }
}

void MpView::hud(Ui& ui, const Multiplayer& mp, const Camera& cam, int W, int H, float u, bool nameTags, const std::string& interior,
                 const std::string& allowKey, const std::string& denyKey) const {
  // ---- the name cards over the heads
  if (nameTags) {
    Camera c = cam;
    c.aspect = float(W) / float(std::max(1, H));
    mat4 VP = c.proj() * c.view();
    for (const auto& [id, r] : mp.players) {
      if (!r.ok || r.interior != interior) continue;
      double d = glm::length(r.sm - cam.pos);
      if (d > TAG_FAR) continue;
      bool inCar = (r.flags & net::F::car) != 0;
      dvec3 head = r.sm + dvec3(0, inCar ? 2.1 : (r.st == int(net::St::Fall) ? 0.7 : 2.05), 0);
      vec4 cl = VP * vec4(vec3(head - cam.pos), 1);
      if (cl.w <= 0.1f) continue;
      float sx = (cl.x / cl.w * 0.5f + 0.5f) * float(W), sy = (1 - (cl.y / cl.w * 0.5f + 0.5f)) * float(H);
      if (sx < -200 || sx > float(W) + 200 || sy < -50 || sy > float(H) + 50) continue;
      std::string label = r.name;
      bool paused = (r.flags & net::F::paused) != 0;
      int stars = inCar ? int((r.flags & net::F::wanted) >> net::F::W_SHIFT) : 0;
      if (paused) label = "II  " + label;
      if (stars > 0) label += "  " + std::string(size_t(stars), '*');
      float fs = std::max(12.f, 18 * u * float(std::clamp(40.0 / std::max(d, 1.0), 0.75, 1.15)));
      float tw = ui.textWidth(label, fs, UiFont::CondItalic), pw = tw + 30 * u, ph = fs * 1.5f;
      float x0 = sx - pw / 2, y0 = sy - ph;
      float alpha = float(std::clamp((TAG_FAR - d) / 30.0, 0.0, 1.0));
      ui.shadow(x0, y0, pw, ph, 3 * u, 6 * u, 0.2f * alpha);
      ui.rect(x0, y0, pw, ph, vec4(paused ? vec3(0.086f, 0.118f, 0.18f) : vec3(1), 0.93f * alpha));
      ui.rect(x0, y0, 5 * u, ph, vec4(vec3(stars > 0 ? ko : paused ? vec4(0.58f, 0.64f, 0.72f, 1) : blue), alpha));
      ui.text(x0 + 15 * u, y0 + (ph - ui.lineHeight(fs, UiFont::CondItalic)) / 2, fs, UiFont::CondItalic, vec4(vec3(paused ? white : stars > 0 ? ko : blue), alpha), label);
    }
  }
  // ---- the status pill (top right, under the money)
  {
    std::string s = mp.statusLine();
    bool bad = mp.net.status() == "reconnecting";
    float fs = std::max(12.f, 15 * u), tw = ui.textWidth(s, fs, UiFont::CondItalic), pw = tw + 24 * u, ph = fs * 1.6f;
    float x0 = float(W) - pw - 18 * u, y0 = 128 * u;
    ui.rect(x0, y0, pw, ph, a(white, 0.92f));
    ui.text(x0 + 12 * u, y0 + (ph - ui.lineHeight(fs, UiFont::CondItalic)) / 2, fs, UiFont::CondItalic, bad ? ko : blue, s);
    if (!mp.guests.empty()) {
      std::string g = "GUESTS: ";
      for (size_t i = 0; i < mp.guests.size(); i++) g += (i ? ", " : "") + mp.guests[i];
      float gw = ui.textWidth(g, fs * 0.85f, UiFont::Body) + 24 * u;
      ui.rect(float(W) - gw - 18 * u, y0 + ph + 6 * u, gw, ph, a(white, 0.85f));
      ui.text(float(W) - gw - 6 * u, y0 + ph + 6 * u + (ph - ui.lineHeight(fs * 0.85f, UiFont::Body)) / 2, fs * 0.85f, UiFont::Body, navy, g);
    }
  }
  // ---- the owner's prompt
  if (!mp.asks.empty()) {
    const auto& q = mp.asks.front();
    float pw = 440 * u, ph = 104 * u, x0 = (float(W) - pw) / 2, y0 = 90 * u;
    ui.shadow(x0, y0, pw, ph, 6 * u, 14 * u, 0.25f);
    ui.rect(x0, y0, pw, ph, white);
    ui.textFit(x0 + pw / 2, y0 + 14 * u, pw - 30 * u, 24 * u, UiFont::CondItalic, blue, q.text, UiAlign::Center);
    std::string keys = allowKey + " allow  \xC2\xB7  " + denyKey + " deny";
    ui.text(x0 + pw / 2, y0 + 52 * u, 17 * u, UiFont::Body, navy, keys, UiAlign::Center);
    double left = std::clamp((q.until - mp.clockSeconds()) / 30.0, 0.0, 1.0);
    ui.rect(x0 + 20 * u, y0 + ph - 14 * u, (pw - 40 * u) * float(left), 3 * u, blue);
  }
  // ---- the admin's banner
  if (!mp.banner.empty() && mp.clockSeconds() < mp.bannerUntil) {
    std::string t = mp.banner + (mp.bannerFrom.empty() ? "" : "  \xE2\x80\x94 " + mp.bannerFrom);
    float fs = 26 * u, pw = std::min(float(W) - 40 * u, ui.textWidth(t, fs, UiFont::CondItalic) + 60 * u), ph = 54 * u;
    float x0 = (float(W) - pw) / 2, y0 = 22 * u;
    ui.shadow(x0, y0, pw, ph, 4 * u, 10 * u, 0.3f);
    ui.rect(x0, y0, pw, ph, ko);
    ui.textFit(x0 + pw / 2, y0 + (ph - ui.lineHeight(fs, UiFont::CondItalic)) / 2, pw - 30 * u, fs, UiFont::CondItalic, white, t, UiAlign::Center);
  }
  // ---- chat and server notes (bottom left, above the hints), the line being typed
  {
    float fs = std::max(12.f, 15 * u), lh = fs * 1.45f, x0 = 24 * u;
    float y = float(H) - 200 * u;
    if (chatOpen) {
      std::string t = "Say: " + chatText + "|";
      float pw = std::max(320 * u, ui.textWidth(t, fs, UiFont::Body) + 24 * u);
      ui.rect(x0, y, pw, lh, a(navy, 0.85f));
      ui.text(x0 + 10 * u, y + (lh - ui.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::Body, white, t);
    }
    y -= 6 * u;
    double now = mp.clockSeconds();
    int n = 0;
    for (auto it = mp.chat.rbegin(); it != mp.chat.rend() && n < 6; ++it, ++n) {
      std::string t = it->admin ? "[server] " + it->text : it->from + ": " + it->text;
      float alpha = float(std::clamp((20 - (now - it->at)) / 3, 0.0, 1.0));
      y -= lh;
      float pw = ui.textWidth(t, fs, UiFont::Body) + 20 * u;
      ui.rect(x0, y, pw, lh, a(navy, 0.55f * alpha));
      ui.text(x0 + 10 * u, y + (lh - ui.lineHeight(fs, UiFont::Body)) / 2, fs, UiFont::Body, a(it->admin ? vec4(1, 0.85f, 0.4f, 1) : white, alpha), t);
    }
  }
}

} // namespace sl
