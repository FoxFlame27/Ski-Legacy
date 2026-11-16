#include "game/werkstatt.h"
#include "engine/renderer.h"
#include "game/drive.h"
#include "game/economy.h"
#include "game/play_data.h"
#include "player/player.h"
#include "world/scenery.h"
#include <algorithm>
#include <cmath>

namespace sl {
using namespace ui_color;

bool Werkstatt::available() const { return c_.data && c_.data->werkstatt.ok; }

dvec3 Werkstatt::world(double lx, double lz) const {
  const WerkstattDef& S = c_.data->werkstatt;
  return dvec3(S.x + S.ax * lx + S.fx * lz, S.at.y, S.z + S.az * lx + S.fz * lz);
}

// werkstatt.js carInBay / inside: the garage frame of a world point
bool Werkstatt::inBox(double x, double z) const {
  const WerkstattDef& S = c_.data->werkstatt;
  const double dx = x - S.x, dz = z - S.z, lx = dx * S.ax + dz * S.az, lz = dx * S.fx + dz * S.fz;
  return std::fabs(lx - S.bayX) < S.bayHw + 0.35 && std::fabs(lz - S.bayZ) < S.bayHl + 0.3;
}
bool Werkstatt::inside(double x, double z, double pad) const {
  const WerkstattDef& S = c_.data->werkstatt;
  const double dx = x - S.x, dz = z - S.z, lx = dx * S.ax + dz * S.az, lz = dx * S.fx + dz * S.fz;
  return std::fabs(lx) < S.IW + pad && std::fabs(lz) < S.ID + pad;
}

int Werkstatt::fee(double damage) const { return repairCost(std::clamp(damage / 100, 0.0, 1.0)); }

// your car in the box: the one you drive, else one of yours standing there
Werkstatt::Car Werkstatt::carInBay() const {
  Car out;
  const Drive& D = *c_.drive;
  for (size_t i = 0; i < D.parked.size(); i++) {
    const Drive::Parked& e = D.parked[i];
    if (!e.owned || e.wrecked) continue;
    if (e.driving && c_.driving) { const dvec3 p = D.pos(); if (inBox(p.x, p.z)) { out.idx = int(i); out.driving = true; out.damage = D.damage(); out.speed = D.speed(); } return out; }
  }
  if (c_.driving) return out;
  for (size_t i = 0; i < D.parked.size(); i++) {
    const Drive::Parked& e = D.parked[i];
    if (e.owned && !e.wrecked && !e.driving && inBox(e.x, e.z)) { out.idx = int(i); out.damage = e.damage; return out; }
  }
  return out;
}

bool Werkstatt::interact(std::string& prompt, bool pressed) {
  if (!available() || !c_.drive || job_.on || paying_) return false;
  const WerkstattDef& S = c_.data->werkstatt;
  const Car car = carInBay();
  if (car.idx < 0) return false;
  if (car.driving) { if (car.speed > 0.6) return false; }
  else {
    // on foot: at the workbench (the mechanic's place), your car standing in the box
    const dvec3& p = c_.player->pos;
    const double dx = p.x - S.x, dz = p.z - S.z, lx = dx * S.ax + dz * S.az, lz = dx * S.fx + dz * S.fz;
    if (std::hypot(lx - S.benchX, lz - (S.benchZ + 0.6)) > 2.2) return false;
  }
  const double frac = std::clamp(car.damage / 100, 0.0, 1.0);
  if (frac <= 0) return false;
  const int f = fee(car.damage), pct = std::max(1, int(std::lround(frac * 100)));
  prompt = "Repair \xC2\xB7 " + (f ? c_.money(f) : std::string("free")) + " \xC2\xB7 damage " + std::to_string(pct) + "%";
  if (!pressed) return true;
  const Drive::Parked& e = c_.drive->parked[size_t(car.idx)];
  const std::string plate = e.plate, label = e.spec ? e.spec->label : std::string("car");
  auto start = [this, plate, label](bool ok, int paid) {
    paying_ = false;
    if (!ok) return;
    job_ = Job{};
    job_.on = true; job_.fee = paid; job_.plate = plate; job_.label = label;
  };
  if (f > 0 && pay) { paying_ = true; pay(plate, f, start); }
  else start(true, 0);
  return true;
}

void Werkstatt::update(double dt) {
  if (!job_.on) return;
  job_.t += dt;
  const double S = c_.data->werkstatt.repairS;
  // werkstatt.js finish(): behind a fade the dents come out, the lamps are new, damage 0
  if (job_.t >= S && !job_.fading) { job_.fading = true; if (c_.fade) c_.fade(); }
  if (job_.t >= S + 0.3) {
    if (repaired) repaired(job_.plate);
    c_.flash("Your " + job_.label + " is repaired \xC2\xB7 as good as new" + (job_.fee ? " \xC2\xB7 paid " + c_.money(job_.fee) : std::string()), 0);
    job_ = Job{};
  }
}

void Werkstatt::draw(Renderer& r, const dvec3& cam) {
  if (!available()) return;
  if (!model_ && c_.roomModel) model_ = c_.roomModel("werkstatt");
  const dvec3& at = c_.data->werkstatt.at;
  const double d = glm::length(at - cam);
  if (model_ && d < 1800 && r.visible(at - dvec3(16, 3, 16), at + dvec3(16, 10, 16))) r.submitModel(*model_, at, glm::rotate(mat4(1), float(c_.data->werkstatt.atRot), vec3(0, 1, 0)), nullptr, d < 300);
}

void Werkstatt::fillColliders(std::vector<Collider>& out) const {
  if (!available()) return;
  const WerkstattDef& S = c_.data->werkstatt;
  const dvec3 p = c_.driving && c_.drive ? c_.drive->pos() : c_.player->pos;
  if (std::fabs(p.x - S.x) > 60 || std::fabs(p.z - S.z) > 60) return;
  for (const PrisonDef::Col& q : S.colliders) {
    Collider c;
    c.x = q.x; c.z = q.z;
    if (q.r >= 0) c.r = q.r; else { c.hw = q.hw; c.hd = q.hd; c.rot = q.rot; }
    out.push_back(c);
  }
}

// werkstatt.js hudFrame / card (#werk-card): bottom left, the tow yard card's place and brush style
void Werkstatt::hud(Ui& ui, float u) {
  if (!available() || !c_.drive) return;
  std::string head = "WERKSTATT \xC2\xB7 GARAGE", main, sub;
  float bar = -1;
  if (job_.on) {
    const double k = std::clamp(job_.t / c_.data->werkstatt.repairS, 0.0, 1.0);
    main = "Repairing\xE2\x80\xA6 " + std::to_string(int(std::lround(k * 100))) + "%";
    sub = "Your " + job_.label + " \xC2\xB7 panel beating \xC2\xB7 new lamps \xC2\xB7 paint";
    bar = float(k);
  } else if (paying_) main = "Paying\xE2\x80\xA6";
  else {
    const Car car = carInBay();
    const Drive& D = *c_.drive;
    int here = car.idx;
    double damage = car.damage;
    if (here < 0 && c_.driving) { const dvec3 p = D.pos(); if (inside(p.x, p.z, 0.5)) for (size_t i = 0; i < D.parked.size(); i++) if (D.parked[i].driving && D.parked[i].owned) { here = int(i); damage = D.damage(); } }
    const bool onFoot = !c_.driving && car.idx >= 0 && inside(c_.player->pos.x, c_.player->pos.z, 0.3);
    if (here < 0 || !(c_.driving || onFoot)) return;
    const Drive::Parked& e = D.parked[size_t(here)];
    const std::string label = e.spec ? e.spec->label : std::string("car");
    const double frac = std::clamp(damage / 100, 0.0, 1.0);
    const int f = fee(damage);
    const std::string how = frac <= 0 ? std::string() : "Damage " + std::to_string(std::max(1, int(std::lround(frac * 100)))) + "%";
    if (frac <= 0) { main = "No damage"; sub = "Your " + label + " is as good as new \xC2\xB7 nothing to repair"; }
    else if (car.idx < 0) { main = "Drive into the yellow box"; sub = "Repair: " + c_.money(f) + " \xC2\xB7 " + how; }
    else if (c_.driving && D.speed() > 0.6) { main = "Stop the car"; sub = "Repair: " + c_.money(f) + " \xC2\xB7 " + how; }
    else { head = "WERKSTATT \xC2\xB7 " + label; main = "Repair " + (f ? c_.money(f) : std::string("free")) + " \xC2\xB7 " + c_.K(Action::Interact) + (c_.driving ? "" : " at the workbench"); sub = how; }
  }
  // #werk-card: 430u wide, padding 12u 30u 14u 24u; head 18u amber, main 34u, sub 14.5u, the bar 10u
  const float H = float(ui.height());
  const float hs = 18 * u, ms = 34 * u, ss = 14.5f * u, w = 430 * u;
  const float h = 12 * u + hs * 1.15f + ms * 1.05f + (sub.empty() ? 0 : 4 * u + ss * 1.3f) + (bar >= 0 ? 8 * u + 10 * u : 0) + 14 * u;
  const float x = 22 * ui.dpr(), y = H - 92 * ui.dpr() - h;
  Ui::Shadow sh{0, 6 * ui.dpr(), 14 * ui.dpr(), hex(0x00143c, 0.28f)};
  ui.brushPanel(x, y, w, h, white, 0, &sh);
  float ty = y + 12 * u;
  ui.textLH(x + 24 * u, ty, hs * 1.15f, hs, UiFont::CondItalic, hex(0xd98a00), head, UiAlign::Left, 0.08f);
  ty += hs * 1.15f;
  Ui::Tabular tab(ui);
  ui.textLH(x + 24 * u, ty, ms * 1.05f, ms, UiFont::CondItalic, blue, main);
  ty += ms * 1.05f;
  if (!sub.empty()) { ty += 4 * u; ui.textLH(x + 24 * u, ty, ss * 1.3f, ss, UiFont::BodyBold, blueDim, sub); ty += ss * 1.3f; }
  if (bar >= 0) { ty += 8 * u; ui.rect(x + 24 * u, ty, w - 54 * u, 10 * u, hex(0xdfe6f7)); ui.rect(x + 24 * u, ty, (w - 54 * u) * bar, 10 * u, blue); }
}

} // namespace sl
