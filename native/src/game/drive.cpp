#include "game/drive.h"
#include "core/log.h"
#include "world/scenery.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr double G = 9.81;
const double RATIOS[6] = {3.6, 2.2, 1.5, 1.15, 0.92, 0.76};
constexpr double FINAL = 3.7, IDLE = 820, REDLINE = 6400;
constexpr double CRASH_V = 70 / 3.6, EXTREME_V = 150 / 3.6, KNOCK_V = 30 / 3.6;
constexpr double UNSTUCK_V = 5 / 3.6, UNSTUCK_CD = 10, REST_SLACK = 0.15;
const double RAIL_BREAK_V = 100 / 3.6, RAIL_BREAK_SIN = std::sin(15 * PI / 180);
constexpr double BREAK_V = 30 / 3.6;   // world/breakables.js: a little pole knocked flying
struct Surf { double mu, roll, rough; bool road; };
const Surf S_ROAD{1.0, 0.015, 0.1, true}, S_SHOULDER{0.72, 0.03, 0.5, false}, S_SNOW{0.58, 0.05, 1, false}, S_PISTE{0.4, 0.02, 0.4, false};

// drive.js obb(): two boxes overlapping -> normal (from B to A), depth, a contact point
struct Hit { double nx, nz, depth, px, pz; };
bool obb(const Obb& A, const Obb& B, Hit& h) {
  double axes[4][2] = {{std::sin(A.yaw), std::cos(A.yaw)}, {std::cos(A.yaw), -std::sin(A.yaw)}, {std::sin(B.yaw), std::cos(B.yaw)}, {std::cos(B.yaw), -std::sin(B.yaw)}};
  double dx = A.x - B.x, dz = A.z - B.z;
  auto rad = [](const Obb& o, double ax, double az) { return o.hd * std::fabs(std::sin(o.yaw) * ax + std::cos(o.yaw) * az) + o.hw * std::fabs(std::cos(o.yaw) * ax - std::sin(o.yaw) * az); };
  double best = 1e30;
  h.nx = h.nz = 0;
  for (auto& a : axes) {
    double dist = dx * a[0] + dz * a[1], ov = rad(A, a[0], a[1]) + rad(B, a[0], a[1]) - std::fabs(dist);
    if (ov <= 0) return false;
    if (ov < best) { best = ov; double sg = dist >= 0 ? 1 : -1; h.nx = a[0] * sg; h.nz = a[1] * sg; }
  }
  auto inside = [](const Obb& o, double x, double z) { double lx = x - o.x, lz = z - o.z; return std::fabs(lx * std::sin(o.yaw) + lz * std::cos(o.yaw)) <= o.hd && std::fabs(lx * std::cos(o.yaw) - lz * std::sin(o.yaw)) <= o.hw; };
  auto corners = [](const Obb& o, double out[4][2]) { double f[2] = {std::sin(o.yaw), std::cos(o.yaw)}, r[2] = {std::cos(o.yaw), -std::sin(o.yaw)}; int k = 0; for (int a : {-1, 1}) for (int b : {-1, 1}) { out[k][0] = o.x + f[0] * o.hd * a + r[0] * o.hw * b; out[k][1] = o.z + f[1] * o.hd * a + r[1] * o.hw * b; k++; } };
  double cA[4][2], cB[4][2];
  corners(A, cA); corners(B, cB);
  double px = 0, pz = 0; int n = 0;
  for (auto& c : cA) if (inside(B, c[0], c[1])) { px += c[0]; pz += c[1]; n++; }
  if (!n) for (auto& c : cB) if (inside(A, c[0], c[1])) { px += c[0]; pz += c[1]; n++; }
  if (!n) { px = (A.x + B.x) / 2; pz = (A.z + B.z) / 2; n = 1; }
  h.depth = best; h.px = px / n; h.pz = pz / n;
  return true;
}
// carrental.js RENTALS order (the Autohaus's cars for sale)
const char* const SALE[] = {"car_vw_golf_gti", "car_tesla_m3", "car_bmw_x3", "car_toyota_gr_yaris", "car_audi_rs6", "car_mercedes_gls", "car_audi_etron_gt",
                            "car_porsche_taycan", "car_mercedes_sls", "car_lamborghini_huracan"};
} // namespace

void Drive::init() {
  for (const auto& p : t_.parked) {
    Parked e;
    e.name = p.name; e.spec = t_.car(p.name); e.vm = models_.car(p.name);
    if (!e.spec || !e.vm) continue;
    e.x = p.pos.x; e.y = p.pos.y; e.z = p.pos.z; e.yaw = p.yaw; e.length = p.length;
    parked.push_back(e);
  }
  // the Autohaus's car park beside the hall (impound.js lays out its bays at runtime: rows along both long sides here,
  // carrental.js's 2.6 m bays): the cars for sale, nose out to the aisle
  const Lot* lot = nullptr;
  for (const Lot& L : t_.lots) if (L.impound) { lot = &L; break; }
  if (lot && lot->hw > 4 && lot->hd > 5) {
    std::vector<Bay> bays = lot->bays;
    if (bays.empty())
      for (double side : {-1.0, 1.0})
        for (double u = -lot->hw + 1.6; u <= lot->hw - 1.6; u += 2.6) {
          double v = side * (lot->hd - 2.85);
          bays.push_back({lot->x + lot->ux * u + lot->vx * v, lot->z + lot->uz * u + lot->vz * v, -lot->vx * side, -lot->vz * side});
        }
    size_t k = 0;
    for (const char* name : SALE) {
      if (k >= bays.size()) break;
      const CarSpec* spec = t_.car(name);
      const VehicleModel* vm = models_.car(name);
      if (!spec || !vm) continue;
      const Bay& b = bays[k];
      k += 2;   // (a free bay between them)
      Parked e;
      e.name = name; e.spec = spec; e.vm = vm; e.forSale = true;
      e.x = b.x; e.z = b.z; e.y = world_.height(b.x, b.z) + 0.03; e.yaw = std::atan2(b.hx, b.hz); e.length = spec->length;
      parked.push_back(e);
    }
  }
  SL_INFO("drive: %zu parked cars (%d for sale at the Autohaus)", parked.size(), int(std::count_if(parked.begin(), parked.end(), [](const Parked& p) { return p.forSale; })));
}

// ---------------------------------------------------------------- getting in
std::string Drive::prompt(const dvec3& pos, bool canUse) {
  if (d_.on || !canUse) return "";
  double bd = 1e9;
  const Parked* best = nullptr;
  for (const Parked& e : parked) {
    if (e.driving) continue;
    double dx = pos.x - e.x, dz = pos.z - e.z;
    if (std::fabs(dx) > 8 || std::fabs(dz) > 8) continue;
    double lx = dx * std::cos(e.yaw) - dz * std::sin(e.yaw), lz = dx * std::sin(e.yaw) + dz * std::cos(e.yaw);
    double d = std::hypot(std::max(0.0, std::fabs(lx) - 0.95), std::max(0.0, std::fabs(lz) - e.length / 2));
    if (d < 2.2 && d < bd) { bd = d; best = &e; }
  }
  if (!best) return "";
  if (best->wrecked) return best->spec->label + " - wrecked";
  if (best->forSale && !best->owned) {
    char b[160];
    std::snprintf(b, sizeof b, "Buy %s - $%s", best->spec->label.c_str(), [](double v) {
      std::string n = std::to_string(int64_t(v)), o;
      for (size_t i = 0; i < n.size(); i++) { if (i && (n.size() - i) % 3 == 0) o += ','; o += n[i]; }
      return o; }(best->spec->price).c_str());
    return b;
  }
  if (!best->owned) return "Buy a car at the Autohaus in Legacy Village";
  if (locked) { std::string why = locked(*best); if (!why.empty()) return why; }
  return "Drive " + best->spec->label;
}

bool Drive::interact(const dvec3& pos) {
  if (d_.on) return false;
  int bi = -1;
  double bd = 1e9;
  for (size_t i = 0; i < parked.size(); i++) {
    const Parked& e = parked[i];
    if (e.driving) continue;
    double dx = pos.x - e.x, dz = pos.z - e.z;
    double lx = dx * std::cos(e.yaw) - dz * std::sin(e.yaw), lz = dx * std::sin(e.yaw) + dz * std::cos(e.yaw);
    double d = std::hypot(std::max(0.0, std::fabs(lx) - 0.95), std::max(0.0, std::fabs(lz) - e.length / 2));
    if (d < 2.2 && d < bd) { bd = d; bi = int(i); }
  }
  if (bi < 0 || parked[size_t(bi)].wrecked) return false;
  Parked& e = parked[size_t(bi)];
  if (e.forSale && !e.owned) { buyRequest = bi; return true; }
  if (!e.owned) return false;
  if (locked && !locked(e).empty()) return false;
  return enter(bi);
}

int Drive::saleIndex(const std::string& model) const {
  for (size_t i = 0; i < parked.size(); i++) if (parked[i].forSale && parked[i].name == model) return int(i);
  return -1;
}
bool Drive::freeBay(double& x, double& z, double& yaw) const {
  const Lot* lot = nullptr;
  for (const Lot& L : t_.lots) if (L.impound) { lot = &L; break; }
  if (!lot) return false;
  std::vector<Bay> bays = lot->bays;
  if (bays.empty())
    for (double side : {-1.0, 1.0})
      for (double u = -lot->hw + 1.6; u <= lot->hw - 1.6; u += 2.6) {
        double v = side * (lot->hd - 2.85);
        bays.push_back({lot->x + lot->ux * u + lot->vx * v, lot->z + lot->uz * u + lot->vz * v, -lot->vx * side, -lot->vz * side});
      }
  // the bays the display cars leave free (every other one), then any bay nobody stands in
  for (int pass = 0; pass < 2; pass++)
    for (size_t k = 0; k < bays.size(); k++) {
      if (pass == 0 && k % 2 == 0) continue;
      const Bay& b = bays[k];
      bool taken = false;
      for (const Parked& e : parked) taken = taken || (!e.driving && std::hypot(e.x - b.x, e.z - b.z) < 2.0);
      if (taken) continue;
      x = b.x; z = b.z; yaw = std::atan2(b.hx, b.hz);
      return true;
    }
  return false;
}
int Drive::addOwned(const std::string& model, const std::string& plate, double damage) {
  const CarSpec* spec = t_.car(model);
  const VehicleModel* vm = models_.car(model);
  if (!spec || !vm) return -1;
  Parked e;
  e.name = model; e.spec = spec; e.vm = vm; e.owned = true; e.plate = plate; e.damage = damage; e.length = spec->length;
  double x = t_.autohaus.x + 6, z = t_.autohaus.z + 6, yaw = 0;
  freeBay(x, z, yaw);
  e.x = x; e.z = z; e.yaw = yaw; e.y = world_.height(x, z) + 0.03;
  parked.push_back(e);
  return int(parked.size()) - 1;
}
int Drive::nearestOwned(const dvec3& p) const {
  int bi = -1;
  double bd = 1e18;
  for (size_t i = 0; i < parked.size(); i++) if (parked[i].owned && !parked[i].wrecked) { double d = std::hypot(parked[i].x - p.x, parked[i].z - p.z); if (d < bd) { bd = d; bi = int(i); } }
  return bi;
}

bool Drive::enter(int idx) {
  if (d_.on || idx < 0 || size_t(idx) >= parked.size()) return false;
  Parked& e = parked[size_t(idx)];
  e.driving = true;
  d_ = D{};
  d_.on = true; d_.e = idx; d_.spec = e.spec;
  d_.x = e.x; d_.z = e.z; d_.y = e.y; d_.yaw = e.yaw;
  d_.wheelBase = std::max(2.4, e.length * 0.6); d_.half = e.length / 2; d_.w = e.spec->size.x;
  d_.offT = 0.6;
  camReady_ = false; lookYaw_ = 0; lookPitch_ = -0.05;
  return true;
}

bool Drive::exit(dvec3& out) {
  if (!d_.on || d_.offT > 0 || d_.crash || speed() > 2.0) return false;
  Parked& e = parked[size_t(d_.e)];
  e.x = d_.x; e.z = d_.z; e.y = world_.groundHeight(d_.x, d_.z, d_.y + 1) + 0.03; e.yaw = d_.yaw; e.driving = false;
  // drive.js exitSpot: beside the driver's door (the car's left), else the other side, behind, in front
  double fx = std::sin(d_.yaw), fz = std::cos(d_.yaw), lx = fz, lz = -fx;
  const double spots[4][2] = {{0.4, d_.w / 2 + 0.9}, {0.4, -(d_.w / 2 + 0.9)}, {-(d_.half + 1.0), 0}, {d_.half + 1.0, 0}};
  double ox = d_.x + lx * spots[0][1] + fx * spots[0][0], oz = d_.z + lz * spots[0][1] + fz * spots[0][0];
  for (auto& s : spots) {
    double x = d_.x + lx * s[1] + fx * s[0], z = d_.z + lz * s[1] + fz * s[0];
    if (clearAt(x, z, 0.4, d_.e)) { ox = x; oz = z; break; }
  }
  out = dvec3(ox, oz, d_.yaw);
  d_.on = false;
  return true;
}

void Drive::seat(dvec3& pos, dvec3& fwd) const {
  // the driver's seat (cars.js driverEye: left front, behind the wheel): ~0.37 m left of the middle, a little forward
  double fx = std::sin(d_.yaw), fz = std::cos(d_.yaw), lx = fz, lz = -fx;
  double sideOff = d_.w * 0.19, along = d_.half * 0.05;
  pos = dvec3(d_.x + lx * sideOff + fx * along, d_.y + 0.32, d_.z + lz * sideOff + fz * along);
  fwd = dvec3(fx, 0, fz);
}

bool Drive::clearAt(double x, double z, double r, int own) const {
  if (scenery_.treeAt(x, z, r, false)) return false;
  if (const auto* near = scenery_.collidersNear(x, z)) {
    for (int ci : *near) {
      const Collider& c = scenery_.colliders()[size_t(ci)];
      if (c.r >= 0) { if (std::hypot(x - c.x, z - c.z) < c.r + r) return false; }
      else {
        double cs = std::cos(-c.rot), sn = std::sin(-c.rot), lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
        if (std::fabs(lx) < c.hw + r && std::fabs(lz) < c.hd + r) return false;
      }
    }
  }
  for (size_t i = 0; i < parked.size(); i++) {
    if (int(i) == own) continue;
    const Parked& e = parked[i];
    if (std::hypot(x - e.x, z - e.z) < e.length / 2 + r) return false;
  }
  return true;
}

// ---------------------------------------------------------------- per tick (drive.js update / step)
void Drive::fixedUpdate(double h, const DriveInput& in, double now) {
  now_ = now;
  slideParked(h);
  if (!d_.on) return;
  D& d = d_;
  d.offT = std::max(0.0, d.offT - h);
  d.start += h;
  bool cranking = !d.spec->electric && d.start < 0.85, live = !d.crash;
  double thr = live && !cranking ? in.throttle : 0, brk = live ? in.brake : 0;
  double steerIn = live ? clamp(in.steer, -1, 1) : 0;
  bool hb = live && in.handbrake;
  d.horn = in.horn;
  lookBackPrev_ = in.lookBack;
  // the pedals: pressed progressively (the throttle opens over ~0.3 s, the brake bites over ~0.2 s)
  auto pd = [&](double v, double want, double up, double down) { return want > v ? std::min(want, v + up * h) : std::max(want, v - down * h); };
  d.thrP = pd(d.thrP, thr, 3.4, 7); d.brkP = pd(d.brkP, brk, 5, 10);
  double thrE = thr > 0 ? std::max(0.05, d.thrP) * thr : d.thrP > 0.02 ? d.thrP : 0, brkE = brk > 0 ? std::max(0.08, d.brkP) * brk : d.brkP > 0.02 ? d.brkP : 0;
  if (d.crash) crashStep(h);
  else step(h, thrE, brkE, steerIn, hb, thr > 0, brk > 0);
  if (!d.spec->electric && d.start < 2.4) {
    if (cranking) d.rpm = 210 + 70 * std::fabs(std::sin(d.start * 26));
    else { double k = d.start - 0.85; d.rpm = std::max(d.rpm, IDLE + 900 * std::exp(-k * 2.4) * std::min(1.0, k * 10)); }
  }
  d.load += (thr - d.load) * (1 - std::exp(-h * 9));
  d.railT = std::max(0.0, d.railT - h);
  if (d.railT <= 0) d.railSlide = 0;
  if (d.crash) { d.crashT += h; d.crashRoll += clamp(d.crashRollTo - d.crashRoll, -d.crashRate * h, d.crashRate * h); }
}

double Drive::damage() const { return d_.on ? parked[size_t(d_.e)].damage : 0; }
std::string Drive::label() const {
  if (!d_.on) return "";
  char b[200];
  int lim = t_.speedLimitAt(d_.x, d_.z);
  std::string gear = d_.gear == 'D' ? (d_.spec->electric ? "D" : "D" + std::to_string(d_.gi + 1)) : std::string(1, d_.gear);
  std::snprintf(b, sizeof b, "%s - %s%s%s", d_.spec->label.c_str(), gear.c_str(), lim ? (" - limit " + std::to_string(lim) + " km/h").c_str() : "",
                damage() > 0 ? (" - car damage " + std::to_string(int(std::round(damage()))) + "%").c_str() : "");
  return b;
}

// A bicycle model (drive.js step): front and rear axles each with a tyre gripping by its slip angle, the load moving
// with braking and acceleration, the drive and brakes per axle within each tyre's grip (friction circle), ABS-like
// brakes biased to the front, the handbrake locking the rear; the steering rack with less lock at speed; the engine
// through the automatic gears (one gear for the electric cars), engine braking, air drag setting the top speed.
void Drive::step(double dt, double thr, double brk, double steerIn, bool hb, bool thrKey, bool brkKey) {
  D& d = d_;
  const CarSpec& spec = *d.spec;
  double fx = std::sin(d.yaw), fz = std::cos(d.yaw), lx = fz, lz = -fx;
  double u = d.vx * fx + d.vz * fz, v = d.vx * lx + d.vz * lz, r = d.yawRate;
  // grip(): the ploughed tarmac, the shoulder (a cleared corridor), groomed pistes, loose snow
  Surf s = S_SNOW;
  if (t_.onTarmac(d.x, d.z)) s = S_ROAD;
  else { CorridorHit c = world_.corridorAt(d.x, d.z); if (c.any && c.d < 0) s = c.kind == CorridorKind::Lift ? S_SHOULDER : S_PISTE; }
  d.rough = s.rough;
  const double e = 1.4, h0 = world_.groundHeight(d.x, d.z, d.y + 1);
  double gx = (world_.groundHeight(d.x + e, d.z, d.y + 1) - world_.groundHeight(d.x - e, d.z, d.y + 1)) / (2 * e);
  double gz = (world_.groundHeight(d.x, d.z + e, d.y + 1) - world_.groundHeight(d.x, d.z - e, d.y + 1)) / (2 * e);
  double cosT = 1 / std::sqrt(1 + gx * gx + gz * gz);
  // gearbox: S at a standstill engages reverse, W drive
  if (std::fabs(u) < 0.4) {
    if (brkKey && !thrKey && d.gear != 'R') { d.holdR += dt; if (d.holdR > 0.25) d.gear = 'R'; }
    else d.holdR = 0;
    if (thrKey && d.gear != 'D') d.gear = 'D';
  }
  const double m = spec.mass, L = d.wheelBase;
  bool fwd = spec.drive == "fwd", rwd = spec.drive == "rwd";
  double a = L * (fwd ? 0.4 : rwd ? 0.47 : 0.46), b = L - a, hcg = 0.55, Iz = m * a * b * 1.15;
  double au = std::fabs(u), sgn = u >= 0 ? 1 : -1;
  double latOk = std::sqrt(std::max(std::pow(0.3 * s.mu * G, 2), std::pow(s.mu * G, 2) - d.la * d.la));
  double lock = clamp((L * latOk) / std::max(1.0, au * au) + 0.015, 0.03, 0.6);
  double rate = std::min((steerIn != 0 ? 4.2 : 3.6) / (1 + au / 18), std::max(lock * (steerIn != 0 ? 5.1 : 5), steerIn != 0 ? 0.32 : 0.35));
  d.steer += clamp(steerIn * lock - d.steer, -rate * dt, rate * dt);
  double delta = d.steer;
  bool held0 = false;
  if (!d.air) {
    double Wt = m * G * cosT;
    double Fzf = std::max(Wt * 0.15, (Wt * b) / L - (m * d.la * hcg) / L), Fzr = std::max(Wt * 0.15, (Wt * a) / L + (m * d.la * hcg) / L);
    double tw = std::max(1.4, d.w - 0.3), ltK = 1 - 0.06 * std::min(1.0, (std::fabs(d.lat) * hcg) / (tw * 0.5 * G));
    double mu = s.mu * ltK, capF = mu * Fzf, capR = mu * Fzr;
    double Fdrive = 0, Fbrake = 0;
    if (!s.road) thr *= 0.6;
    double x = clamp((d.rpm - 800) / 5600, 0, 1), curve = 0.62 + 0.38 * std::sin(PI * x);
    double gearK = spec.electric ? 1 : std::pow(RATIOS[d.gi] / RATIOS[0], 0.85);
    double Fmax = m * spec.accel;
    if (d.gear == 'D') {
      if (thr > 0) Fdrive = spec.electric ? std::min(Fmax, (Fmax * 0.42 * spec.top) / std::max(1.0, au)) * thr : Fmax * gearK * curve * thr * (d.shiftT > 0 ? 0.3 : 1);
      if (brk > 0) Fbrake = m * 10 * brk;
      else if (thr < 0.3 && u > 1) Fbrake = (1 - thr / 0.3) * m * (spec.electric ? 1.1 : std::min(1.6, (0.25 + 0.85 * (d.rpm / (REDLINE * spec.rev))) * clamp(std::sqrt(RATIOS[d.gi] / RATIOS[3]), 0.75, 1.5)));
    } else if (d.gear == 'R') {
      if (brk > 0) Fdrive = u > -5.5 ? -m * 3.4 * (s.road ? 1 : 0.7) : 0;
      if (thr > 0) Fbrake = m * 10;
    }
    double split = fwd ? 1 : rwd ? 0 : 0.4;
    double Fxf = Fdrive * split - Fbrake * 0.65 * sgn, Fxr = Fdrive * (1 - split) - Fbrake * 0.35 * sgn;
    double kx = 0.9 - 0.3 * std::min(1.0, std::fabs(steerIn) + std::fabs(d.steer) * 4);
    Fxf = clamp(Fxf, -kx * capF, kx * capF);
    Fxr = clamp(Fxr, -kx * capR, kx * capR);
    double latR = 1;
    if (hb && au > 0.5) { Fxr = -sgn * 0.75 * capR; latR = 0.32; }
    double uu = std::max(au, 1.5);
    double af = std::atan2(v + a * r, uu) - delta * sgn, ar = std::atan2(v - b * r, uu);
    auto tyre = [](double al) { return std::sin(1.2 * std::atan(14 * al)); };
    double kf = std::min(1.0, std::fabs(Fxf) / std::max(1.0, capF)), kr = std::min(1.0, std::fabs(Fxr) / std::max(1.0, capR));
    double kLow = clamp((au - 1) / 3, 0, 1);
    double Fyf = -capF * std::sqrt(std::max(0.0, 1 - kf * kf)) * tyre(af) * kLow;
    double Fyr = -capR * std::sqrt(std::max(0.0, 1 - kr * kr)) * latR * tyre(ar) * kLow;
    double topF = spec.electric ? Fmax * 0.42 : Fmax * std::pow(RATIOS[5] / RATIOS[0], 0.85) * 0.66;
    double drag = (topF / (spec.top * spec.top)) * u * au;
    double roll = s.roll * Wt * sgn * std::min(1.0, au / 0.5);
    double gF = -G * (gx * fx + gz * fz) * cosT * m, gL = -G * (gx * lx + gz * lz) * cosT * m;
    d.downhill = gF / (m * G) * (u >= 0 ? 1 : -1);
    double cs = std::cos(delta), sn = std::sin(delta);
    double FF = Fxf * cs - Fyf * sn + Fxr - drag - roll + gF;
    double FL = Fxf * sn + Fyf * cs + Fyr + gL;
    double u0 = u;
    u += (FF / m + r * v) * dt;
    v += (FL / m - r * u0) * dt;
    r += ((a * (Fxf * sn + Fyf * cs) - b * Fyr) / Iz) * dt;
    {   // stability assist (ESC), the handbrake mostly overriding it
      double rMax = (latOk * (s.road ? 1.3 : 1.2)) / std::max(std::fabs(u), 2.0);
      double rT = clamp((u / L) * std::tan(delta), -rMax, rMax);
      bool over = r * rT < 0 || std::fabs(r) > std::fabs(rT);
      double hbK = hb && au > 0.5 ? 0.15 : 1;
      r += (rT - r) * (1 - std::exp(-dt * (s.road ? 7 : 3.5) * (over ? 1 : s.road ? 0.8 : 0.25) * hbK));
      v = b * r + (v - b * r) * std::exp(-dt * (s.road ? 6 : 2) * hbK);
    }
    if (Fbrake > 0 && (u > 0) != (u0 > 0) && u0 != 0) u = 0;
    if (d.gear == 'P' || (d.gear == 'D' && thr <= 0 && brk > 0 && std::fabs(u) < 0.3)) { u = 0; v *= 0.5; held0 = true; }
    if (thr <= 0 && !(d.gear == 'R' && brk > 0) && std::fabs(u) < 0.5 && std::fabs(gF) < 0.6 * mu * Wt) { u = 0; v = 0; r = 0; held0 = true; }
    double kd = clamp((std::fabs(u) - 1) / 3, 0, 1);
    if (kd < 1) { double rk = (u / L) * std::tan(delta); r = rk + (r - rk) * kd; v = v * kd + rk * b * (1 - kd); }
    d.la += ((u - u0) / dt - d.la) * std::min(1.0, dt * 12);
    d.lat = FL / m;
    double slide = std::max(std::fabs(af), std::fabs(ar));
    d.squeal = s.road ? clamp((slide - 0.12) * 5 + (hb && au > 4 ? 0.4 : 0) + (kr > 0.94 && thr > 0 ? 0.3 : 0), 0, 1) : 0;
  } else r *= std::exp(-dt * 1.2);
  d.vx = fx * u + lx * v; d.vz = fz * u + lz * v; d.yawRate = r;
  d.yaw = wrapPi(d.yaw + r * dt);
  d.x += d.vx * dt; d.z += d.vz * dt;
  // vertical: follows the snow; over a crest at speed it leaves it (a small jump), never launched by a step
  double g1 = world_.groundHeight(d.x, d.z, d.y + 1);
  if (!d.air) {
    double stp = g1 - h0;
    double vyG = clamp(std::fabs(stp) > 0.3 ? d.vy * 0.5 : stp / dt, -9, 5);
    if (vyG < d.vy - G * dt - 3.2 && std::fabs(u) > 10 && stp > -1.5) { d.air = true; d.vy = clamp(d.vy, -9, 4) - G * dt; d.y += d.vy * dt; }
    else { d.y = g1; d.vy += (vyG - d.vy) * 0.5; }
  } else {
    d.vy = std::min(d.vy, 6.0) - G * dt; d.y += d.vy * dt;
    if (d.y <= g1) { events.push_back({VehicleEvent::Type::Land, float(clamp((-d.vy - 1) / 11, 0, 1)), ""}); d.pitchV += std::min(1.5, -d.vy * 0.08); d.y = g1; d.vy = 0; d.air = false; }
  }
  // engine revs and gears
  const double wr = 0.34, speedAbs = std::fabs(u);
  if (spec.electric) d.rpm = IDLE + speedAbs * 220;
  else {
    d.shiftT = std::max(0.0, d.shiftT - dt);
    double rev = spec.rev;
    auto rpmAt = [&](int gi) { return (speedAbs / wr) * RATIOS[gi] * FINAL * 60 / (2 * PI) * rev; };
    if (d.gear == 'D') {
      bool hold = thr < 0.1 && d.downhill > 0.05;
      double up = hold ? 6200 : 5800, down = hold ? 3300 : thr > 0.85 ? 2800 : 2200;
      if (rpmAt(d.gi) > up * rev && d.gi < 5) { d.gi++; d.shiftT = 0.25; }
      else if (d.gi > 0 && rpmAt(d.gi) < down * rev && rpmAt(d.gi - 1) < 6000 * rev) d.gi--;
    } else d.gi = 0;
    d.rpm = clamp(std::max(IDLE + thr * 600, rpmAt(d.gi)), IDLE, REDLINE * rev);
  }
  // at rest off the pedals the collisions may move it at most REST_SLACK from where it settled (no creeping out)
  bool pedal = (d.gear == 'D' && thrKey) || (d.gear == 'R' && brkKey);
  bool rest = held0 && !pedal && !d.air && !d.crash;
  if (!rest) d.restSet = false;
  else if (!d.restSet) { d.restSet = true; d.restX = d.x; d.restZ = d.z; }
  terrainHit(g1);
  collide(now_);
  bash(dt);
  if (d.on && rest && !d.crash && d.restSet) {
    double ox = d.x - d.restX, oz = d.z - d.restZ, o = std::hypot(ox, oz);
    if (o > REST_SLACK) { d.x = d.restX + ox / o * REST_SLACK; d.z = d.restZ + oz / o * REST_SLACK; d.vx = d.vz = 0; d.yawRate = 0; }
  }
}

// into the mountain: the ground ahead rising steeper than ~40 degrees is a wall
void Drive::terrainHit(double g1) {
  D& d = d_;
  if (d.air || d.crash) return;
  double sp = std::hypot(d.vx, d.vz);
  if (sp < KNOCK_V) return;
  double dx = d.vx / sp, dz = d.vz / sp, ahead = d.half + 0.6;
  double gA = (world_.groundHeight(d.x + dx * ahead, d.z + dz * ahead, d.y + 4) - g1) / ahead;
  if (gA < 0.85) return;
  double vin = sp * gA / std::sqrt(1 + gA * gA);
  if (vin < KNOCK_V) return;
  double nx = -dx, nz = -dz;
  d.vx += nx * vin * 1.25; d.vz += nz * vin * 1.25;
  d.vx *= 0.6; d.vz *= 0.6;
  if (vin > CRASH_V) { crash(vin, nx, nz); return; }
  knock(vin, nx, nz, now_);
}

// soft bumps: trees, colliders (buildings, nets, poles), guardrails (slid along), breakables (knocked flying)
void Drive::collide(double now) {
  D& d = d_;
  double fx = std::sin(d.yaw), fz = std::cos(d.yaw);
  double px = 0, pz = 0, rpx = 0, rpz = 0, rBest = 0;
  int n = 0, rn = 0, rK = -1, poles = 0, lamps = 0;
  bool solid = false;
  const double R = d.w / 2, sp = std::hypot(d.vx, d.vz);
  static thread_local std::vector<int> stamp;
  if (stamp.size() != t_.rails.size()) stamp.assign(t_.rails.size(), 0);
  static thread_local int stampN = 0;
  for (double k : {d.half - R, 0.0, -(d.half - R)}) {
    double cx = d.x + fx * k, cz = d.z + fz * k;
    if (const Tree* t = scenery_.treeAt(cx, cz, R, true)) {
      double dx = cx - t->x, dz = cz - t->z, l = std::hypot(dx, dz);
      if (l < 1e-6) l = 1;
      double o = R + t->crown - l;
      if (o > 0) { px += dx / l * o; pz += dz / l * o; n++; solid = true; }
    }
    // guardrails: a line you slide along
    ++stampN;
    for (int gxi = int(std::floor((cx - 1.4) / 16)); gxi <= int(std::floor((cx + 1.4) / 16)); gxi++)
      for (int gzi = int(std::floor((cz - 1.4) / 16)); gzi <= int(std::floor((cz + 1.4) / 16)); gzi++) {
        const auto* cell = t_.railsNear(gxi * 16 + 1, gzi * 16 + 1);
        if (!cell) continue;
        for (int ri : *cell) {
          Guardrail& g = t_.rails[size_t(ri)];
          if (stamp[size_t(ri)] == stampN || g.offUntil > now) continue;
          stamp[size_t(ri)] = stampN;
          double ex = g.bx - g.ax, ez = g.bz - g.az, l2 = ex * ex + ez * ez;
          if (l2 < 1e-9) l2 = 1;
          double t2 = clamp(((cx - g.ax) * ex + (cz - g.az) * ez) / l2, 0, 1), qx = g.ax + ex * t2, qz = g.az + ez * t2;
          double dx = cx - qx, dz = cz - qz, l = std::hypot(dx, dz), o = R + 0.12 - l;
          if (o > 0 && l > 1e-4) { rpx += dx / l * o; rpz += dz / l * o; rn++; if (o > rBest) { rBest = o; rK = ri; } }
        }
      }
    if (const auto* near = scenery_.collidersNear(cx, cz)) {
      for (int ci : *near) {
        const Collider& c = scenery_.colliders()[size_t(ci)];
        if (c.rail || c.downUntil > now) continue;
        double size = c.r >= 0 ? c.r : std::max(c.hw, c.hd);
        // a little pole, a sign, a street lamp (over 100 km/h): knocked flying, the car drives on (world/breakables.js)
        if (c.brk > 0 && sp > std::max(c.brk, BREAK_V)) {
          double reach = size + R, dx = c.x - cx, dz = c.z - cz;
          if (dx * dx + dz * dz < reach * reach) { c.downUntil = now + 90; poles++; if (c.lamp) lamps++; }
          continue;
        }
        if (std::fabs(c.x - cx) > size + R + 0.5 || std::fabs(c.z - cz) > size + R + 0.5) continue;
        if (c.top < 1e29 && d.y > c.top) continue;
        if (c.r >= 0) {
          double dx = cx - c.x, dz = cz - c.z, l = std::hypot(dx, dz);
          if (l < c.r + R) { px += (l > 1e-3 ? dx / l : 1) * (c.r + R - l); pz += (l > 1e-3 ? dz / l : 0) * (c.r + R - l); n++; if (!c.soft) solid = true; }
        } else {
          double cs = std::cos(-c.rot), sn = std::sin(-c.rot), lx = (cx - c.x) * cs - (cz - c.z) * sn, lz = (cx - c.x) * sn + (cz - c.z) * cs;
          double ox = c.hw + R - std::fabs(lx), oz = c.hd + R - std::fabs(lz);
          if (ox > 0 && oz > 0) {
            double nlx = 0, nlz = 0;
            if (ox < oz) nlx = lx >= 0 ? 1 : -1; else nlz = lz >= 0 ? 1 : -1;
            double c2 = std::cos(c.rot), s2 = std::sin(c.rot), o = std::min(ox, oz);
            px += (nlx * c2 - nlz * s2) * o; pz += (nlx * s2 + nlz * c2) * o; n++;
            if (!c.soft) solid = true;
          }
        }
      }
    }
  }
  if (lamps) {   // a street lamp snapped off: ~15 % of the speed gone and a small damage knock
    d.vx *= 0.85; d.vz *= 0.85; d.pitchV -= 0.1;
    Parked& e = parked[size_t(d.e)];
    e.damage = std::min(99.0, e.damage + 2 * lamps);
    shake_ = std::max(shake_, 0.3);
    events.push_back({VehicleEvent::Type::Knock, 0.55f, "Lamp post down - car damage " + std::to_string(int(e.damage)) + "%"});
  }
  if (poles) { events.push_back({VehicleEvent::Type::Bump, 0.2f, ""}); double f = std::max(0.8, 1 - 0.05 * poles); d.vx *= f; d.vz *= f; d.pitchV -= 0.05; d.rollV += (rnd() - 0.5) * 0.08; }
  if (rn) railHit(rpx, rpz, rK, now);
  if (!n || !d.on) return;
  double l = std::hypot(px, pz);
  if (l < 1e-9) l = 1;
  double nx = px / l, nz = pz / l;
  d.x += px; d.z += pz;
  double vn = d.vx * nx + d.vz * nz;
  if (solid && -vn > CRASH_V) { crash(-vn, nx, nz); return; }
  if (solid && -vn > KNOCK_V) knock(-vn, nx, nz, now);
  if (vn < 0) {
    d.vx -= nx * vn * 1.2; d.vz -= nz * vn * 1.2;
    d.vx *= 0.85; d.vz *= 0.85;
    d.yawRate *= 0.6;
    if (-vn > 2 && now - bangT_ > 0.3) { bangT_ = now; d.pitchV -= std::min(0.6, -vn * 0.04); events.push_back({VehicleEvent::Type::Bump, float(std::min(0.7, -vn / 16)), ""}); }
  }
}

// A guardrail: a glancing collision, never a dead stop; over 100 km/h and 15 degrees or more into it, it breaks
void Drive::railHit(double px, double pz, int rk, double now) {
  D& d = d_;
  double l = std::hypot(px, pz);
  if (l < 1e-6) return;
  double nx = px / l, nz = pz / l;
  const Guardrail* g = rk >= 0 ? &t_.rails[size_t(rk)] : nullptr;
  double gl = g ? std::hypot(g->bx - g->ax, g->bz - g->az) : 0;
  double gs = gl > 1e-3 && (g->az - g->bz) * nx + (g->bx - g->ax) * nz < 0 ? -1 : 1;
  double into0 = std::max(-(d.vx * nx + d.vz * nz), gl > 1e-3 ? -gs * (d.vx * (g->az - g->bz) + d.vz * (g->bx - g->ax)) / gl : -1e30), sp0 = std::hypot(d.vx, d.vz);
  auto breakNear = [&](double x, double z) {   // breakables.breakRail: the sections within ~6 m of the hit
    bool any = false;
    for (auto& q : t_.rails) {
      if (q.tunnel || q.offUntil > now) continue;
      double ex = q.bx - q.ax, ez = q.bz - q.az, l2 = ex * ex + ez * ez;
      if (l2 < 1e-9) continue;
      double t = clamp(((x - q.ax) * ex + (z - q.az) * ez) / l2, 0, 1);
      if (std::hypot(q.ax + ex * t - x, q.az + ez * t - z) < 6) { q.offUntil = now + 90; any = true; }
    }
    return any;
  };
  if (g && !g->tunnel) {
    if (d.thruSet && sp0 > KNOCK_V && d.start - d.thruT < 1.5 && std::hypot(d.x - d.thruX, d.z - d.thruZ) < 12 && breakNear(d.x, d.z)) return;
    if (sp0 > RAIL_BREAK_V && into0 > sp0 * RAIL_BREAK_SIN && breakNear(d.x, d.z)) { d.thruSet = true; d.thruX = d.x; d.thruZ = d.z; d.thruT = d.start; railBreak(into0, nx, nz); return; }
  }
  d.x += px; d.z += pz;
  double vn = d.vx * nx + d.vz * nz;
  double tx = -nz, tz = nx, vt = d.vx * tx + d.vz * tz;
  if (vt < 0) { tx = -tx; tz = -tz; vt = -vt; }
  if (vn < -0.05) {
    const double er = 0.3, mu = 0.22, into = -vn;
    double vt2 = std::max(vt * 0.35, vt - mu * (1 + er) * into);
    double vn2 = er * into + 0.4;
    d.vx = tx * vt2 + nx * vn2; d.vz = tz * vt2 + nz * vn2;
    double sp = std::hypot(d.vx, d.vz);
    if (sp > 1) {
      double fx = std::sin(d.yaw), fz = std::cos(d.yaw);
      bool back = d.vx * fx + d.vz * fz < 0;
      double travel = std::atan2(back ? -d.vx : d.vx, back ? -d.vz : d.vz), err = wrapPi(travel - d.yaw);
      d.yaw = wrapPi(d.yaw + clamp(err * 0.55, -0.35, 0.35));
      d.yawRate = d.yawRate * 0.3 + clamp(err, -1.0, 1.0) * 0.6;
    } else d.yawRate *= 0.5;
    if (into > KNOCK_V * 1.4) knock(into, nx, nz, now);
    d.rollV += (rnd() - 0.5) * std::min(0.5, into * 0.05);
    d.pitchV -= std::min(0.3, into * 0.02);
    if (into > 1.2 && now - bangT_ > 0.22) { bangT_ = now; events.push_back({VehicleEvent::Type::RailHit, float(std::min(1.0, into / 14)), ""}); }
  }
  d.railSlide = std::max(d.railSlide, vt);
  d.railT = 0.12;
}

void Drive::railBreak(double into, double nx, double nz) {
  D& d = d_;
  Parked& e = parked[size_t(d.e)];
  double add = 6 + into * 0.6;
  if (d.crash) { d.vx *= 0.64; d.vz *= 0.64; return; }
  if (into >= EXTREME_V || e.damage + add >= 100) { crash(std::max(into, CRASH_V), nx, nz); return; }
  e.damage = std::min(99.0, e.damage + add);
  knockT_ = now_;
  d.vx *= 0.64; d.vz *= 0.64;
  double side = rnd() < 0.5 ? -1 : 1;
  d.yawRate = clamp(d.yawRate + side * 0.5, -2, 2);
  d.pitchV -= 0.7; d.rollV += side * 0.4;
  shake_ = std::max(shake_, 0.7);
  events.push_back({VehicleEvent::Type::Break, 0.45f, "Through the guardrail - car damage " + std::to_string(int(e.damage)) + "%"});
}

// other cars and the buses (drive.js bash): pushed apart, an impulse when closing; the other car knocked aside
void Drive::bash(double) {
  D& d = d_;
  if (!d.on) return;
  std::vector<OtherBody> others;
  if (gatherOthers) gatherOthers(others);
  for (size_t i = 0; i < parked.size(); i++) {
    const Parked& e = parked[i];
    if (e.driving || std::fabs(e.x - d.x) > 12 || std::fabs(e.z - d.z) > 12) continue;
    OtherBody o; o.box = {e.x, e.z, e.yaw, 0.97, e.length / 2}; o.vx = e.svx; o.vz = e.svz; o.w = e.sw; o.mass = e.spec ? e.spec->mass : 1700; o.kind = 2; o.id = int(i);
    others.push_back(o);
  }
  const double m1 = d.spec->mass, I1 = (m1 * (4 * d.half * d.half + d.w * d.w)) / 12;
  Obb A{d.x, d.z, d.yaw, d.w / 2, d.half};
  double fx = std::sin(d.yaw), fz = std::cos(d.yaw);
  for (const OtherBody& B : others) {
    Hit hit;
    if (!obb(A, B.box, hit)) continue;
    double m2 = B.mass, I2 = (m2 * (4 * B.box.hd * B.box.hd + 4 * B.box.hw * B.box.hw)) / 12;
    double r1x = hit.px - d.x, r1z = hit.pz - d.z, r2x = hit.px - B.box.x, r2z = hit.pz - B.box.z;
    bool bus = B.kind == 1;
    double w2 = bus ? 0 : B.w;
    double v1x = d.vx + d.yawRate * r1z, v1z = d.vz - d.yawRate * r1x, v2x = B.vx + w2 * r2z, v2z = B.vz - w2 * r2x;
    double vn = (v1x - v2x) * hit.nx + (v1z - v2z) * hit.nz;
    bool bashed = -vn > 1.3;
    double share = bashed && !bus ? m2 / (m1 + m2) : 1;
    d.x += hit.nx * hit.depth * share; d.z += hit.nz * hit.depth * share;
    A.x = d.x; A.z = d.z;
    if (vn >= 0) continue;
    const double er = 0.28;
    double rn1 = r1z * hit.nx - r1x * hit.nz, rn2 = r2z * hit.nx - r2x * hit.nz;
    double J = (-(1 + er) * vn) / (1 / m1 + (bashed && !bus ? 1 / m2 + (rn2 * rn2) / I2 : 0) + (rn1 * rn1) / I1);
    d.vx += J / m1 * hit.nx; d.vz += J / m1 * hit.nz;
    d.yawRate += clamp(((r1z * hit.nx - r1x * hit.nz) * J) / I1, -1.5, 1.5) * 0.5;
    if (!bashed) continue;
    double hard = std::min(1.0, -vn / 12);
    if (!bus) {
      double dvx = (-J / m2) * hit.nx, dvz = (-J / m2) * hit.nz, dw = clamp((-(r2z * hit.nx - r2x * hit.nz) * J) / I2, -2.5, 2.5);
      if (B.kind == 2) { Parked& e = parked[size_t(B.id)]; e.svx = B.vx + dvx; e.svz = B.vz + dvz; e.sw = w2 + dw; e.x -= hit.nx * hit.depth * (1 - share); e.z -= hit.nz * hit.depth * (1 - share); }
      else if (onKnock) onKnock(B, B.vx + dvx, B.vz + dvz, w2 + dw);
    }
    bool headOn = std::fabs(hit.nx * fx + hit.nz * fz) > 0.6;
    if (-vn > CRASH_V && (bus || headOn)) { crash(-vn, hit.nx, hit.nz); return; }
    if (-vn > KNOCK_V) knock(-vn * (headOn ? 1 : bus ? 0.8 : 0.7), hit.nx, hit.nz, now_);
    if (now_ - bangT_ > 0.25) { bangT_ = now_; d.pitchV -= 0.25 * hard; d.rollV += (rnd() - 0.5) * 0.6 * hard; events.push_back({VehicleEvent::Type::Bump, float(0.25 + 0.6 * hard), ""}); }
  }
}

// a shoved parked car slides (and turns) to a stop on the snow (drive.js slideParked)
void Drive::slideParked(double h) {
  for (Parked& e : parked) {
    if (e.driving || (e.svx == 0 && e.svz == 0 && e.sw == 0)) continue;
    double sp = std::hypot(e.svx, e.svz), dec = 0.6 * G * h;
    if (sp > dec) { e.svx -= e.svx / sp * dec; e.svz -= e.svz / sp * dec; } else { e.svx = e.svz = 0; }
    e.sw *= std::exp(-h * 2.6);
    if (std::fabs(e.sw) < 0.04 && e.svx == 0 && e.svz == 0) e.sw = 0;
    e.x += e.svx * h; e.z += e.svz * h; e.yaw = wrapPi(e.yaw + e.sw * h);
    e.y = world_.meshHeight(e.x, e.z) + 0.03;
  }
}

void Drive::knock(double v, double nx, double nz, double now) {
  D& d = d_;
  if (!d.on || d.crash || now - knockT_ < 0.6) return;
  knockT_ = now;
  Parked& e = parked[size_t(d.e)];
  double add = 1 + (v - KNOCK_V) * 0.35;
  if (e.damage + add >= 100) { e.damage = 100; crash(CRASH_V, nx, nz); return; }
  e.damage = std::min(99.0, e.damage + add);
  shake_ = std::max(shake_, 0.35);
  events.push_back({VehicleEvent::Type::Knock, float(clamp(0.5 + (v - KNOCK_V) / 20, 0, 1)), "Knock - car damage " + std::to_string(int(e.damage)) + "%"});
}

void Drive::crash(double v, double nx, double nz) {
  D& d = d_;
  if (!d.on || d.crash) return;
  double hard = clamp((v - CRASH_V) / 14, 0, 1);
  Parked& e0 = parked[size_t(d.e)];
  e0.damage = std::min(100.0, e0.damage + (v >= EXTREME_V ? 100 : 7 + (v - CRASH_V) * 0.55));
  knockT_ = now_;
  if (e0.damage < 100) {
    d.vx = d.vx * 0.22 + nx * v * 0.12; d.vz = d.vz * 0.22 + nz * v * 0.12;
    double side = rnd() < 0.5 ? -1 : 1;
    d.yawRate = clamp(d.yawRate + side * (0.3 + hard * 0.8), -2, 2);
    d.pitchV -= 1.2 * (0.5 + hard); d.rollV += side * 0.6 * (0.4 + hard);
    shake_ = 0.75;
    events.push_back({VehicleEvent::Type::Crash, float(0.5 + 0.5 * hard), "Crash - car damage " + std::to_string(int(e0.damage)) + "%"});
    return;
  }
  // wrecked: it may roll over (fast or on a steep slope) or spin into the snow; then you are out beside it
  const double e = 1.5;
  double gx = (world_.groundHeight(d.x + e, d.z, d.y + 1) - world_.groundHeight(d.x - e, d.z, d.y + 1)) / (2 * e);
  double gz = (world_.groundHeight(d.x, d.z + e, d.y + 1) - world_.groundHeight(d.x, d.z - e, d.y + 1)) / (2 * e);
  bool steep = std::hypot(gx, gz) > 0.42, rolls = (v > 70 / 3.6 || steep) && rnd() < 0.75;
  double side = rnd() < 0.5 ? -1 : 1;
  d.crash = true; d.crashT = 0; d.crashRoll = 0; d.crashRollTo = rolls ? side * (rnd() < 0.55 ? PI / 2 : PI) : 0; d.crashRate = 3.2 + rnd() * 1.6;
  double keep = rolls ? 0.35 : 0.1;
  d.vx = d.vx * keep + nx * v * 0.12; d.vz = d.vz * keep + nz * v * 0.12;
  d.yawRate = clamp(d.yawRate + side * (0.6 + hard * 1.8), -3.2, 3.2);
  d.pitchV -= 1.6 * (0.5 + hard); d.rollV += side * 0.8 * (0.4 + hard);
  shake_ = 1;
  e0.wrecked = true;
  events.push_back({VehicleEvent::Type::Crash, 1.0f, "Crashed - the car is wrecked"});
  if (onWreck) onWreck(d.e);
}

void Drive::crashStep(double h) {
  D& d = d_;
  double sp = std::hypot(d.vx, d.vz), dec = 0.9 * G * h;
  if (sp > dec) { d.vx -= d.vx / sp * dec; d.vz -= d.vz / sp * dec; } else { d.vx = d.vz = 0; }
  d.yawRate *= std::exp(-h * 1.6);
  d.yaw = wrapPi(d.yaw + d.yawRate * h);
  d.x += d.vx * h; d.z += d.vz * h;
  d.y = world_.groundHeight(d.x, d.z, d.y + 1); d.air = false; d.vy = 0;
}

// ---------------------------------------------------------------- per frame: springs, keys, the camera
void Drive::frame(double dt, const DriveFrameInput& in) {
  if (!d_.on) return;
  D& d = d_;
  if (in.toggleLights) d.lights = !d.lights;
  if (in.toggleView) { view_ = view_ == View::Chase ? View::Cockpit : View::Chase; camReady_ = false; }
  // on its side or roof (slow, > ~70 degrees for a second): F (or U) flips it back
  double upY = std::cos(d.pitch) * std::cos(d.roll + d.crashRoll);
  d.flipT = !d.crash && upY < 0.34 && speed() < 2 ? d.flipT + dt : 0;
  if (d.flipT > 1 && (in.flip || in.unstuck)) unflip();
  else if (in.unstuck) unstuck();
  pose(dt);
  placeCamera(dt, in);
  // a wreck: the car comes to rest, then you are out beside it (the game takes you out: exit is allowed)
  if (d.crash && d.crashT > 1.9 && speed() < 1.2) { d.crash = false; d.offT = 0; d.vx = d.vz = 0; }
}

void Drive::pose(double dt) {
  D& d = d_;
  double fx = std::sin(d.yaw), fz = std::cos(d.yaw), lx = fz, lz = -fx;
  double wb = d.wheelBase / 2, tr = d.w / 2 - 0.15;
  double hFL = world_.groundHeight(d.x + fx * wb + lx * tr, d.z + fz * wb + lz * tr, d.y + 1);
  double hFR = world_.groundHeight(d.x + fx * wb - lx * tr, d.z + fz * wb - lz * tr, d.y + 1);
  double hRL = world_.groundHeight(d.x - fx * wb + lx * tr, d.z - fz * wb + lz * tr, d.y + 1);
  double hRR = world_.groundHeight(d.x - fx * wb - lx * tr, d.z - fz * wb - lz * tr, d.y + 1);
  double pitchG = std::atan2((hRL + hRR) / 2 - (hFL + hFR) / 2, wb * 2), rollG = std::atan2((hFL + hRL) / 2 - (hFR + hRR) / 2, tr * 2);
  double pitchT = clamp(d.air ? d.pitch : pitchG - clamp(d.la * 0.007, -0.06, 0.05), -0.6, 0.6);
  double yawAccel = d.yawRate * std::hypot(d.vx, d.vz);
  double rollT = clamp(d.air ? d.roll : rollG + clamp(yawAccel * 0.011, -0.07, 0.07), -0.6, 0.6);
  // springs damped near critically (sub-stepped: stable at any frame time)
  int n = std::max(1, int(std::ceil(dt / (1.0 / 120))));
  double h = dt / n;
  for (int i = 0; i < n; i++) {
    d.pitchV += ((pitchT - d.pitch) * 110 - d.pitchV * 18) * h; d.pitch += d.pitchV * h;
    d.rollV += ((rollT - d.roll) * 95 - d.rollV * 16.5) * h; d.roll += d.rollV * h;
  }
  if (!d.air) d.y = std::max(d.y, (hFL + hFR + hRL + hRR) / 4);
}

void Drive::placeCamera(double dt, const DriveFrameInput& in) {
  D& d = d_;
  double sp = speed();
  const double sens = 0.0022;
  shake_ = std::max(0.0, shake_ - dt * 1.6);
  bool lookBack = lookBackPrev_;
  (void)lookBack;
  double fx = std::sin(d.yaw), fz = std::cos(d.yaw);
  if (view_ == View::Cockpit) {
    lookYaw_ = clamp(lookYaw_ - in.lookX * sens, -2.09, 2.09);
    lookPitch_ = clamp(lookPitch_ - in.lookY * sens, -1.05, 0.5);
    double ly = lookBackPrev_ ? PI : lookYaw_;
    dvec3 seatP, fwd;
    seat(seatP, fwd);
    dvec3 eye = seatP + dvec3(0, 0.82, 0);
    eye.y = std::min(eye.y, d.y + d.spec->size.y - 0.17);
    double yaw = d.yaw + ly;
    dvec3 dir(std::sin(yaw) * std::cos(lookPitch_ + d.pitch * 0), std::sin(lookPitch_) - std::sin(d.pitch), std::cos(yaw) * std::cos(lookPitch_));
    camPos_ = eye; camLook_ = eye + dir;
    camFov_ += (72 + sp * 0.08 - camFov_) * (1 - std::exp(-dt * 4));
  } else {
    double travel = sp > 2 ? std::atan2(d.vx, d.vz) : d.yaw;
    if (!camReady_) { camYaw_ = d.yaw + PI; camPitch_ = 0.17; lastMouse_ = -1e9; }
    if (in.lookX != 0 || in.lookY != 0) { lastMouse_ = in.now; camYaw_ -= in.lookX * sens; camPitch_ = clamp(camPitch_ + in.lookY * sens, -0.08, 1.0); }
    if (lookBackPrev_ || in.now - lastMouse_ > 1.5) {
      double target = (lookBackPrev_ ? travel : travel + PI) - d.yawRate * 0.12;
      camYaw_ += wrapPi(target - camYaw_) * (1 - std::exp(-dt * (lookBackPrev_ ? 10 : 3)));
      camPitch_ += (0.17 - camPitch_) * (1 - std::exp(-dt * 2));
    }
    double dist = 5.6 + sp * 0.05, cp = std::cos(camPitch_);
    dvec3 focus(d.x, d.y + 1.25, d.z);
    dvec3 want(focus.x + std::sin(camYaw_) * cp * dist, focus.y + 0.25 + std::sin(camPitch_) * dist, focus.z + std::cos(camYaw_) * cp * dist);
    // (out of the ground; in a road tunnel the ground is the road: the camera stays in the tube)
    double gy = world_.groundHeight(want.x, want.z, d.y + 2) + 0.8;
    if (want.y < gy) want.y = gy;
    if (!camReady_) { camPos_ = want; camReady_ = true; }
    camPos_ += (want - camPos_) * (1 - std::exp(-dt * 9));
    camLook_ = focus;
    camFov_ += (62 + sp * 0.2 - camFov_) * (1 - std::exp(-dt * 3));
  }
  (void)fx; (void)fz;
  // shake: a crash (strong, dying away), rough snow at speed (a smooth wobble)
  double k = shake_ * shake_ * 0.16, kr = d.rough * std::min(1.0, sp / 25) * 0.01, tt = in.now;
  if (k > 1e-4) camPos_ += dvec3((rnd() - 0.5) * k, (rnd() - 0.5) * k, (rnd() - 0.5) * k);
  if (kr > 1e-4) camPos_ += dvec3(std::sin(tt * 19.3) * kr * 0.6, (std::sin(tt * 27.1) + std::sin(tt * 41.7 + 1.3) * 0.5) * kr, std::sin(tt * 23.9 + 0.7) * kr * 0.4);
}

// U: unstuck (slow, every 10 s): upright on the nearest clear lane of a road within 60 m, facing along it
void Drive::unstuck() {
  D& d = d_;
  if (d.crash || speed() >= UNSTUCK_V) { events.push_back({VehicleEvent::Type::Bump, 0, "Unstuck: only when stuck (stopped)"}); return; }
  if (now_ - unstuckT_ < UNSTUCK_CD) { events.push_back({VehicleEvent::Type::Bump, 0, "Unstuck again in " + std::to_string(int(std::ceil(UNSTUCK_CD - (now_ - unstuckT_)))) + " s"}); return; }
  Transport::RoadHit rh = t_.nearestRoad(d.x, d.z, 16);
  double bx = 0, bz = 0, byaw = d.yaw, bd = 1e18;
  bool found = false;
  auto tryRoad = [&](int ri, double s0) {
    const Road& r = t_.roads[size_t(ri)];
    for (double ds = 0; ds < 60; ds += 4)
      for (double sg : {1.0, -1.0}) {
        double s = clamp(s0 + sg * ds, 2, r.length - 2);
        RoadPoint p = roadAt(r, s);
        for (double dir : {1.0, -1.0}) {
          double x = p.x - p.dz * dir * 1.6, z = p.z + p.dx * dir * 1.6, yaw = std::atan2(p.dx * dir, p.dz * dir);
          double dd = std::hypot(x - d.x, z - d.z) + std::fabs(wrapPi(yaw - d.yaw)) * 2;
          if (dd < bd && clearAt(x, z, d.w / 2 + 0.15, d.e)) { bd = dd; bx = x; bz = z; byaw = yaw; found = true; }
        }
      }
  };
  if (rh.road >= 0) tryRoad(rh.road, rh.s);
  else for (size_t ri = 0; ri < t_.roads.size(); ri++) {
    const Road& r = t_.roads[ri];
    for (int i = 0; i < r.n; i += 4) if (std::hypot(r.X[size_t(i)] - d.x, r.Z[size_t(i)] - d.z) < 60) { tryRoad(int(ri), r.S[size_t(i)]); break; }
  }
  if (!found) { events.push_back({VehicleEvent::Type::Bump, 0, "No clear spot nearby"}); return; }
  unstuckT_ = now_;
  d.x = bx; d.z = bz; d.yaw = byaw;
  d.y = world_.groundHeight(bx, bz, d.y + 3) + 0.25;
  d.vx = d.vz = d.vy = 0; d.yawRate = 0; d.air = true; d.steer = 0;
  d.pitch = d.roll = d.pitchV = d.rollV = 0; d.flipT = 0; d.stuckT = 0; d.restSet = false;
  d.la = d.lat = 0; d.thrP = d.brkP = 0; d.gear = 'D'; d.gi = 0; d.railT = 0; d.railSlide = 0;
  camReady_ = false;
  events.push_back({VehicleEvent::Type::Bump, 0, "Unstuck"});
}
void Drive::unflip() {
  D& d = d_;
  d.y = world_.groundHeight(d.x, d.z, d.y + 3) + 0.25;
  d.vx = d.vz = d.vy = 0; d.yawRate = 0; d.air = true;
  d.pitch = d.roll = d.pitchV = d.rollV = 0; d.flipT = 0; d.crashRoll = d.crashRollTo = 0;
}

void Drive::addDraw(VehicleDraw& draw, const dvec3& cam) const {
  for (size_t i = 0; i < parked.size(); i++) {
    const Parked& e = parked[i];
    if (!e.vm || !e.vm->ok()) continue;
    glm::dmat4 M;
    if (d_.on && int(i) == d_.e) {
      // the car you drive: on its springs (pitch, roll), rolled over in a crash
      M = glm::translate(glm::dmat4(1), dvec3(d_.x, d_.y + 0.02, d_.z)) * glm::rotate(glm::dmat4(1), d_.yaw, dvec3(0, 1, 0)) *
          glm::rotate(glm::dmat4(1), d_.pitch, dvec3(1, 0, 0)) * glm::rotate(glm::dmat4(1), d_.roll + d_.crashRoll, dvec3(0, 0, 1));
      if (d_.crashRoll != 0) M = M * glm::translate(glm::dmat4(1), dvec3(0, std::fabs(std::sin(d_.crashRoll)) * d_.w / 2, 0));
    } else {
      double dist = std::hypot(e.x - cam.x, e.z - cam.z);
      if (dist > 400) continue;
      M = glm::translate(glm::dmat4(1), dvec3(e.x, e.y, e.z)) * glm::rotate(glm::dmat4(1), e.yaw, dvec3(0, 1, 0));
    }
    double dist = std::hypot(M[3][0] - cam.x, M[3][2] - cam.z);
    draw.add(e.vm->model.get(), M * glm::dmat4(e.vm->fit), dist < 70 ? 0 : 1);
  }
}

void Drive::fillColliders(std::vector<Collider>& out) const {
  for (size_t i = 0; i < parked.size(); i++) {
    const Parked& e = parked[i];
    Collider c;
    if (d_.on && int(i) == d_.e) continue;   // (the car you sit in)
    c.x = e.x; c.z = e.z; c.hw = 0.97; c.hd = e.length / 2; c.rot = -e.yaw; c.top = e.y + 1.6;
    out.push_back(c);
  }
}

} // namespace sl
