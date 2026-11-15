#include "game/hospital_ward.h"
#include "core/log.h"
#include "engine/asset_manager.h"
#include "engine/mesh_kit.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/economy.h"
#include "game/play_data.h"
#include "game/shapes.h"
#include "player/player.h"
#include "world/world.h"

namespace sl {

namespace {
// hospitalroom.js: the inside of the walls (the house is 15 x 12 m outside, its walls 0.2 m thick), the ceiling; the
// way out; the beds (their heads to the back wall), the cabinet / chair side of each; a patient's hips
constexpr struct { double x0 = -7.3, x1 = 7.3, z0 = -5.8, z1 = 5.8, H = 3.1; } IN;
constexpr double EXIT_X = 0, EXIT_Z = IN.z1 - 0.15;
constexpr int CAB_SIDE[4] = {1, -1, 1, -1};
constexpr double HIPS_Z = IN.z0 + 1.0, BED_TOP = 0.61;
constexpr double WAKE_S = 5.6;   // the eyes opening (hospitalroom.js wake: the lids 3.6 s, the haze 5.2 s)

std::string fmtClock(double s) {
  int v = int(std::max(0.0, std::ceil(s)));
  char b[16];
  std::snprintf(b, sizeof b, "%d:%02d", v / 60, v % 60);
  return b;
}
// CSS ease-in-out (cubic-bezier(0.42, 0, 0.58, 1)) and ease-out (0, 0, 0.58, 1): y at x
double bezier(double x, double x1, double y1, double x2, double y2) {
  double lo = 0, hi = 1, t = x;
  for (int i = 0; i < 24; i++) {
    t = (lo + hi) / 2;
    double bx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
    if (bx < x) lo = t; else hi = t;
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
}
// @keyframes hw-top (translateY in lid heights, the bottom lid mirrored): each stretch eased in and out
double lidShift(double t) {
  static const double K[6][2] = {{0, 0}, {0.16, 0.30}, {0.24, 0.02}, {0.44, 0.62}, {0.52, 0.14}, {1, 1.12}};
  double x = clamp(t / 3.6, 0.0, 1.0);
  for (int i = 0; i < 5; i++) if (x <= K[i + 1][0]) {
    double u = (x - K[i][0]) / (K[i + 1][0] - K[i][0]);
    return K[i][1] + (K[i + 1][1] - K[i][1]) * bezier(u, 0.42, 0, 0.58, 1);
  }
  return 1.12;
}
} // namespace

HospitalWard::HospitalWard(PlayCtx& c, Interiors& rooms) : c_(c), rooms_(rooms) {}

void HospitalWard::load(AssetManager& assets, std::shared_ptr<Model> mesh) {
  mesh_ = std::move(mesh);
  const PlayData* D = c_.data;
  if (!D || !D->ward || !mesh_) { SL_WARN("hospital ward: no data (node native/tools/export_resort.mjs)"); return; }
  const nlohmann::json& j = *D->ward;
  auto m34 = [](const nlohmann::json& a) {
    mat4 M(1);
    if (a.is_array() && a.size() == 12) for (int r = 0; r < 3; r++) for (int cc = 0; cc < 4; cc++) M[cc][r] = a[size_t(r * 4 + cc)].get<float>();
    return M;
  };
  ModelLoadOptions o;
  o.maxTextureSize = 1024;
  for (auto& p : j["props"]) {
    auto m = assets.model(p.value("model", std::string()), o);
    if (m) furn_.push_back({m, m34(p["m"])});
  }
  for (auto& p : j["panes"]) panes_.push_back({m34(p["m"]), p.value("w", 1.f), p.value("h", 1.f)});
  for (auto& q : j["obstacles"]) if (q.size() == 4) obstacles_.push_back({q[0].get<double>(), q[1].get<double>(), q[2].get<double>(), q[3].get<double>()});
  for (auto& ch : j["chairs"]) chairs_.push_back({ch.value("x", 0.0), ch.value("z", 0.0), ch.value("yaw", 0.0), ch.value("y", 0.47), ch.value("bed", 0)});
  for (auto& b : j["beds"]) beds_.push_back(b.get<double>());
  for (auto& b : j["bedTops"]) bedTops_.push_back(b.get<double>());
  if (beds_.size() != 4) beds_ = {-6.0, -2.0, 2.0, 6.0};
  bedTops_.resize(beds_.size(), BED_TOP);
  stay_ = j.value("stay", 20.0);
  if (j.contains("door")) { door_ = dvec3(j["door"].value("x", 0.0), 0, j["door"].value("z", 0.0)); doorYaw_ = j["door"].value("yaw", 0.0); hasDoor_ = true; }
  ok_ = true;
  SL_INFO("hospital ward: %zu models, %zu panes, %zu obstacles, %zu chairs, the door outside at (%.1f, %.1f)", furn_.size(), panes_.size(), obstacles_.size(), chairs_.size(), door_.x, door_.z);
}

// the Interiors' room replaced by the game's own (the exported mesh and furniture, the walker's walls and obstacles)
void HospitalWard::build() {
  rooms_.boxes.clear(); rooms_.props.clear();
  rooms_.halfX = vec2(float(IN.x1)); rooms_.halfZ = vec2(float(IN.z1));
  rooms_.ceiling = IN.H;
  rooms_.exitLocal = dvec3(EXIT_X, 0, EXIT_Z);
  rooms_.lightTint = vec3(1.0f, 0.94f, 0.86f);
  rooms_.props.push_back({mesh_, mat4(1), dvec3(0), 0, false, vec2(0), false});
  for (const Furn& f : furn_) rooms_.props.push_back({f.model, f.m, dvec3(0), 0, false, vec2(0), false});
  auto solid = [&](double x0, double x1, double z0, double z1) {
    Interiors::Box b;
    b.c = vec3(float((x0 + x1) / 2), 1.0f, float((z0 + z1) / 2)); b.h = vec3(float((x1 - x0) / 2), 1.0f, float((z1 - z0) / 2));
    b.yaw = 0; b.col = vec4(0); b.solid = true; b.emissive = false;
    rooms_.boxes.push_back(b);
  };
  const double T = 0.4;
  solid(IN.x0 - T, IN.x1 + T, IN.z0 - T, IN.z0); solid(IN.x0 - T, IN.x1 + T, IN.z1, IN.z1 + T);
  solid(IN.x0 - T, IN.x0, IN.z0, IN.z1); solid(IN.x1, IN.x1 + T, IN.z0, IN.z1);
  for (auto& q : obstacles_) solid(q[0], q[1], q[2], q[3]);
  rooms_.rebuild();
}

bool HospitalWard::admit(double seconds) {
  if (!ok_ || !hasDoor_) return false;
  if (rooms_.inside()) rooms_.leave();
  // (you are at the door outside, behind the fade: the windows' view first, then into the bed)
  pending_ = Role::Patient; pendingSeconds_ = seconds;
  capture_ = 0; captureWait_ = 0; armed_ = false;
  c_.player->skisOn = false;
  return true;
}

bool HospitalWard::visit() {
  if (!ok_ || !hasDoor_ || rooms_.inside() || pending_ != Role::None) return false;
  if (c_.fade) c_.fade();
  c_.player->setSkisOn(false);
  pending_ = Role::Visitor;
  capture_ = 0; captureWait_ = 0; armed_ = false;
  return true;
}

// into the room: lying in your bed (admit), or in at the front doors (visit)
void HospitalWard::enterNow() {
  Role r = pending_;
  pending_ = Role::None; capture_ = 99; armed_ = false;
  if (r == Role::None) return;
  Player& p = *c_.player;
  rooms_.enter(Interiors::Room::Hospital, [this]() { outside(); });
  build();
  seat_ = -1; discharged_ = false;
  if (r == Role::Patient) {
    role_ = Role::Patient; bed_ = 1;
    left_ = std::max(5.0, pendingSeconds_ < 0 ? stay_ : pendingSeconds_);
    notified_ = false; third_ = false;
    yaw_ = 0; pitch_ = -0.3; tpYaw_ = PI; tpPitch_ = -0.45;   // (looking down along yourself to your feet)
    wakeT_ = 0; flashT_ = 1.6; hasEye_ = false;
    update(0, false);
    SL_INFO("hospital ward: admitted to bed %d for %.0f s", bed_ + 1, left_);
  } else {
    role_ = Role::Visitor; wakeT_ = -1;
    // in at the front doors, facing the room
    dvec3 w = rooms_.toWorld(EXIT_X, 0, EXIT_Z - 0.9);
    p.teleport(w.x, w.z, PI);
    p.pos.y = w.y; p.prevPos = p.renderPos = p.pos;
  }
}

// ---------------------------------------------------------------- the windows' view
namespace {
// the walls' outward normals in the room's frame (back, front, left, right) and the camera's right for each
const dvec3 SIDE_N[4] = {{0, 0, -1}, {0, 0, 1}, {-1, 0, 0}, {1, 0, 0}};
const dvec3 SIDE_R[4] = {{1, 0, 0}, {-1, 0, 0}, {0, 0, -1}, {0, 0, 1}};
constexpr double VIEW_EYE = 1.6;
// the photographs: each wall (60 deg up and down: its windows), and the glass doors again, closer (you walk up to them)
constexpr int NV = 5;
constexpr struct { int side; double fov; bool door; } VIEWS[NV] = {{0, 60, false}, {1, 60, false}, {2, 60, false}, {3, 60, false}, {1, 34, true}};
}

bool HospitalWard::captureCamera(Camera& cam, bool covered) {
  armed_ = false;
  if (pending_ == Role::None || capture_ < 0 || capture_ >= NV || !covered) return false;
  // the room's frame outdoors: the house (its door 2.2 m out from the front on x = 0: hospitalroom.js setupOutside)
  const double s = std::sin(doorYaw_), c = std::cos(doorYaw_);
  auto dirW = [&](const dvec3& l) { return dvec3(c * l.x + s * l.z, l.y, -s * l.x + c * l.z); };
  const dvec3 house = door_ - dirW(dvec3(0, 0, IN.z1 + 0.2 + 2.2));
  const double y0 = c_.world->groundHeight(door_.x, door_.z);
  const int side = VIEWS[capture_].side;
  const dvec3& n = SIDE_N[side];
  const dvec3 l = n * ((side < 2 ? IN.z1 + 0.2 : IN.x1 + 0.2) + 1.2);   // (1.2 m out from that wall)
  dvec3 eye = house + dirW(l);
  eye.y = y0 + 1.8;
  cam.lookAt(eye, eye + dirW(n));
  cam.fovY = float(VIEWS[capture_].fov); cam.nearZ = 0.3f;
  armed_ = true;
  return true;
}

void HospitalWard::captured(Renderer& r) {
  if (!armed_) return;
  armed_ = false;
  std::vector<uint8_t> px;
  r.readPixels(px);
  int W = r.width(), H = r.height();
  if (c_.dev && W > 8 && H > 8 && px.size() >= size_t(W) * H * 4) {
    // box-filtered down to ~1024 wide (the panes are small on the screen)
    int k = std::max(1, (W + 1023) / 1024), w2 = W / k, h2 = H / k;
    std::vector<uint8_t> o(size_t(w2) * h2 * 4);
    for (int y = 0; y < h2; y++) for (int x = 0; x < w2; x++) {
      unsigned acc[3] = {0, 0, 0};
      for (int j = 0; j < k; j++) for (int i = 0; i < k; i++) { const uint8_t* q = &px[(size_t(y * k + j) * W + (x * k + i)) * 4]; acc[0] += q[0]; acc[1] += q[1]; acc[2] += q[2]; }
      uint8_t* d = &o[(size_t(y) * w2 + x) * 4];
      for (int ch = 0; ch < 3; ch++) d[ch] = uint8_t(acc[ch] / unsigned(k * k));
      d[3] = 255;
    }
    gfx::TextureDesc d;
    d.width = w2; d.height = h2; d.format = gfx::TexFormat::SRGBA8; d.wrap = gfx::Wrap::Clamp;
    gfx::Texture tex = c_.dev->createTexture(d, o.data());
    const float tanV = float(std::tan(VIEWS[capture_].fov * DEG / 2)), tanH = tanV * float(W) / float(H);
    buildPanes(capture_, tanH, tanV);
    if (paneModel_[capture_]) for (Material& m : paneModel_[capture_]->materials) m.emissiveTex = tex;
  }
  viewDay_ = 1 - float(clamp(double(c_.night), 0.0, 1.0));
  SL_INFO("hospital ward: window view %d photographed (%d x %d)", capture_, W, H);
  if (++capture_ >= NV) enterNow();
}

// one wall's panes as a mesh, each showing its part of that side's photograph (by direction from the room's middle)
void HospitalWard::buildPanes(int view, float tanH, float tanV) {
  const int side = VIEWS[view].side;
  paneModel_[view].reset();
  Geo g;
  const dvec3 n = SIDE_N[side], rt = SIDE_R[side], E(0, VIEW_EYE, 0);
  const int NX = 8, NY = 6;
  for (const Pane& p : panes_) {
    dvec3 pn = dvec3(vec3(p.m * vec4(0, 0, 1, 0)));
    if (glm::dot(pn, n) > -0.7 || (p.w > 2.0f) != VIEWS[view].door) continue;   // (this wall's panes face into the room: against its outward normal)
    uint32_t base = uint32_t(g.pos.size());
    for (int j = 0; j <= NY; j++) for (int i = 0; i <= NX; i++) {
      vec4 lp((float(i) / NX - 0.5f) * p.w, (float(j) / NY - 0.5f) * p.h, 0, 1);
      dvec3 P = dvec3(vec3(p.m * lp)), d = P - E;
      double zc = std::max(0.2, glm::dot(d, n));
      g.pos.push_back(vec3(P)); g.nor.push_back(vec3(pn)); g.col.push_back(vec3(1));
      g.uv.push_back(vec2(float(0.5 + 0.5 * glm::dot(d, rt) / (zc * tanH)), float(0.5 + 0.5 * d.y / (zc * tanV))));
    }
    for (int j = 0; j < NY; j++) for (int i = 0; i < NX; i++) {
      uint32_t a = base + uint32_t(j * (NX + 1) + i), b = a + 1, c2 = a + uint32_t(NX + 1), d2 = c2 + 1;
      g.idx.insert(g.idx.end(), {a, b, d2, a, d2, c2});
    }
  }
  if (g.idx.empty() || !c_.dev) return;
  Material m;
  m.baseColor = vec4(0, 0, 0, 1); m.roughness = 1; m.metallic = 0; m.doubleSided = true;
  m.emissive = vec3(1.0f);
  paneModel_[view] = buildModel(*c_.dev, {{std::move(g), m}}, "ward_panes");
}

// out of the door: the forecourt, 2 m out from the glass doors, facing away from them
void HospitalWard::outside() {
  bool wasPatient = discharged_;
  role_ = Role::None; seat_ = -1; left_ = 0; wakeT_ = -1; flashT_ = -1; discharged_ = false;
  if (hasDoor_) c_.teleport(door_.x, door_.z, doorYaw_, false);
  if (wasPatient) c_.flash("Get well soon \xC2\xB7 ARZT \xC2\xB7 MEDICAL CENTRE", 0);
}

// out of bed: standing beside it on the chair's side, looking along the ward
void HospitalWard::getUp() {
  if (role_ != Role::Patient || left_ > 0) return;
  Player& p = *c_.player;
  int cs = CAB_SIDE[bed_ & 3];
  role_ = Role::Visitor; discharged_ = true; seat_ = -1;
  dvec3 w = rooms_.toWorld(beds_[size_t(bed_)] + cs * 0.95, 0, IN.z0 + 2.35);
  p.mode = PlayerMode::Walk;
  p.fall = FallState{};
  p.teleport(w.x, w.z, cs > 0 ? 0.6 : -0.6);
  p.pos.y = w.y; p.prevPos = p.renderPos = p.pos;
  p.view = Player::View::First;
  c_.flash("Discharged \xC2\xB7 the way out: the glass doors past reception", 0);
}

double HospitalWard::deck(double x, double z) const {
  if (role_ != Role::Patient) return std::nan("");
  dvec3 l = rooms_.toLocal(dvec3(x, 0, z));
  if (std::fabs(l.x - beds_[size_t(bed_)]) > 0.6 || l.z < IN.z0 - 0.2 || l.z > IN.z0 + 3.0) return std::nan("");
  return rooms_.toWorld(0, bedTops_[size_t(bed_)] + 0.04, 0).y;
}

void HospitalWard::update(double dt, bool input) {
  if (pending_ != Role::None) {   // (waiting for the dark moment of the fade to photograph the windows' view; never for long)
    captureWait_ += dt;
    if (captureWait_ > 1.2) enterNow();
    return;
  }
  if (role_ == Role::None) return;
  // (thrown out of the room from elsewhere: back to the menu, a teleport)
  if (rooms_.room() != Interiors::Room::Hospital) { role_ = Role::None; seat_ = -1; wakeT_ = -1; return; }
  Player& p = *c_.player;
  t_ += dt;
  if (wakeT_ >= 0) wakeT_ += dt;
  if (flashT_ >= 0 && (flashT_ -= dt) < 0) c_.flash("You wake up in the medical centre \xC2\xB7 rest a moment", 0);
  const double sens = 0.0022 * std::max(0.2, c_.save ? c_.save->setting("sensitivity", 1) : 1.0);
  if (role_ == Role::Patient) {
    if (left_ > 0) {
      left_ -= dt;
      if (left_ <= 0) { left_ = 0; c_.flash("You feel fit again \xC2\xB7 press " + c_.K(Action::Interact) + " to get up", 0); }
    }
    if (input && c_.input) {
      Input& in = *c_.input;
      third_ = p.view == Player::View::Third;   // (the game's view toggle: from beside the bed)
      if (third_) {
        tpYaw_ = clamp(tpYaw_ - in.lookX() * sens, PI - 1.5, PI + 1.5);
        tpPitch_ = clamp(tpPitch_ - in.lookY() * sens, -1.2, -0.08);
      } else {
        // lying back on the pillow: the head turns, the body stays; down far enough to see yourself
        yaw_ = clamp(yaw_ - in.lookX() * sens, -1.35, 1.35);
        pitch_ = clamp(pitch_ - in.lookY() * sens, -1.1, 0.95);
      }
    }
    // your own body lying in your bed: flat on the back, the head on the pillow toward the wall (poseBody)
    dvec3 w = rooms_.toWorld(beds_[size_t(bed_)], bedTops_[size_t(bed_)] + 0.04, HIPS_Z);
    p.mode = PlayerMode::Fall;
    p.pos = p.prevPos = p.renderPos = w;
    p.vel = dvec3(0); p.heading = 0; p.normal = dvec3(0, 1, 0);
    p.air = p.ballistic = false;
    FallState& F = p.fall;
    F.state = FallState::State::Lie; F.kind = FallState::Kind::Slam; F.t = 1; F.lieT = 0; F.getUp = 0; F.ball = 0;
    F.axisHeading = 0; F.pitch = -PI / 2; F.pitchVel = 0; F.hasPitchTarget = false; F.roll = F.rollRest = 0; F.rollVel = 0; F.rollTarget = 0; F.hasRollTarget = true;
    p.fallSide = 1;
  } else if (seat_ >= 0 && input && c_.input) {
    yaw_ -= c_.input->lookX() * sens;
    pitch_ = clamp(pitch_ - c_.input->lookY() * sens, -1.3, 1.2);
  }
}

bool HospitalWard::mpPose(dvec3& pos, double& yaw, bool& patient) const {
  if (role_ == Role::Patient && size_t(bed_) < beds_.size()) { pos = rooms_.toWorld(beds_[size_t(bed_)], bedTops_[size_t(bed_)], HIPS_Z); yaw = 0; patient = true; return true; }
  if (role_ != Role::None && seat_ >= 0) { const Chair& ch = chairs_[size_t(seat_)]; pos = rooms_.toWorld(ch.x, ch.y, ch.z); yaw = ch.yaw; patient = false; return true; }
  return false;
}

dvec3 HospitalWard::patientSpot(double worldX) const {
  const double lx = rooms_.toLocal(dvec3(worldX, 0, 0)).x;
  size_t bed = 0;
  double bd = 1e300;
  for (size_t i = 0; i < beds_.size(); i++) if (std::fabs(lx - beds_[i]) < bd) { bd = std::fabs(lx - beds_[i]); bed = i; }
  if (beds_.empty()) return rooms_.toWorld(lx, BED_TOP + 0.04, HIPS_Z);
  return rooms_.toWorld(beds_[bed], bedTops_[bed] + 0.04, HIPS_Z);
}

bool HospitalWard::seat(dvec3& pos, dvec3& fwd) const {
  if (role_ == Role::None || seat_ < 0) return false;
  const Chair& ch = chairs_[size_t(seat_)];
  pos = rooms_.toWorld(ch.x, ch.y, ch.z);
  fwd = dvec3(std::sin(ch.yaw), 0, std::cos(ch.yaw));
  return true;
}

bool HospitalWard::camera(Camera& cam) const {
  if (role_ == Role::None) return false;
  if (role_ == Role::Patient) {
    double bx = beds_[size_t(bed_)], top = bedTops_[size_t(bed_)];
    if (third_) {   // beside the bed, looking at you lying in it
      dvec3 c = hasEye_ ? rooms_.toLocal(body_) : dvec3(bx, top + 0.3, HIPS_Z - 0.2);
      double cp = tpPitch_;
      dvec3 e(c.x - std::sin(tpYaw_) * std::cos(cp) * 2.3, c.y - std::sin(cp) * 2.3, c.z - std::cos(tpYaw_) * std::cos(cp) * 2.3);
      e.x = clamp(e.x, IN.x0 + 0.2, IN.x1 - 0.2); e.y = clamp(e.y, 0.4, IN.H - 0.15); e.z = clamp(e.z, IN.z0 + 0.2, 1.8 - 0.2);
      cam.lookAt(rooms_.toWorld(e.x, e.y, e.z), rooms_.toWorld(c.x, c.y, c.z));
    } else {
      // the eyes: over the head on the pillow, lifted clear of the chest, looking down the body to the feet; a slow breath
      dvec3 e = hasEye_ ? rooms_.toLocal(eye_) : dvec3(bx, top + 0.724, IN.z0 + 0.487);
      e.y += std::sin(t_ * 1.3) * 0.006;
      dvec3 dir(std::sin(yaw_) * std::cos(pitch_), std::sin(pitch_), std::cos(yaw_) * std::cos(pitch_));
      dvec3 we = rooms_.toWorld(e.x, e.y, e.z);
      cam.lookAt(we, we + dir);
    }
    cam.fovY = 70; cam.nearZ = 0.05f;
    return true;
  }
  if (seat_ >= 0) {
    const Chair& ch = chairs_[size_t(seat_)];
    dvec3 we = rooms_.toWorld(ch.x - std::sin(ch.yaw) * 0.08, ch.y + 0.72, ch.z - std::cos(ch.yaw) * 0.08);
    dvec3 dir(std::sin(yaw_) * std::cos(pitch_), std::sin(pitch_), std::cos(yaw_) * std::cos(pitch_));
    cam.lookAt(we, we + dir);
    cam.fovY = 70; cam.nearZ = 0.05f;
    return true;
  }
  return false;
}

bool HospitalWard::interact(std::string& prompt, bool pressed) {
  if (!ok_) return false;
  Player& p = *c_.player;
  if (pending_ != Role::None) return true;
  if (role_ == Role::None) {
    // E at the front door outside: visit
    if (!hasDoor_ || rooms_.inside() || p.mode == PlayerMode::Sit || p.mode == PlayerMode::Fall) return false;
    if (std::hypot(p.pos.x - door_.x, p.pos.z - door_.z) < 2.6) {
      prompt = "Visit the medical centre";
      if (pressed) visit();
      return true;
    }
    return false;
  }
  if (role_ == Role::Patient) {
    if (left_ > 0) { prompt = "Resting \xC2\xB7 " + fmtClock(left_); if (pressed) c_.flash("Stay in bed a little longer \xC2\xB7 " + fmtClock(left_), 1); }
    else { prompt = "Get up"; if (pressed) getUp(); }
    return true;
  }
  if (seat_ >= 0) {
    prompt = "Stand up";
    if (pressed) {
      const Chair ch = chairs_[size_t(seat_)];
      seat_ = -1;
      dvec3 w = rooms_.toWorld(ch.x + std::sin(ch.yaw) * -0.55, 0, ch.z + std::cos(ch.yaw) * -0.55 + 0.25);
      p.standUp(w.x, w.z, ch.yaw);
      p.pos.y = w.y; p.prevPos = p.renderPos = p.pos;
      p.view = Player::View::First;
    }
    return true;
  }
  dvec3 l = rooms_.toLocal(p.pos);
  double look = p.heading + p.lookYaw();
  dvec3 dir(std::sin(look), 0, std::cos(look));
  // the way out
  double dx = EXIT_X - l.x, dz = EXIT_Z - l.z, d = std::hypot(dx, dz);
  if (d < 2.0 && (dx * dir.x + dz * dir.z) / std::max(d, 1e-3) > 0.3) {
    prompt = "Leave the medical centre";
    if (pressed) { if (c_.fade) c_.fade(); rooms_.leave(); }
    return true;
  }
  // a visitor's chair
  int best = -1;
  double bd = 1.25;
  for (size_t i = 0; i < chairs_.size(); i++) {
    double cx = chairs_[i].x - l.x, cz = chairs_[i].z - l.z, cd = std::hypot(cx, cz);
    if (cd < bd && (cx * dir.x + cz * dir.z) / std::max(cd, 1e-3) > 0.2) { bd = cd; best = int(i); }
  }
  if (best >= 0) {
    prompt = "Sit down";
    if (pressed) {
      seat_ = best;
      const Chair& ch = chairs_[size_t(best)];
      yaw_ = ch.yaw; pitch_ = -0.1;
      p.sitOn(rooms_.toWorld(ch.x, ch.y, ch.z), dvec3(std::sin(ch.yaw), 0, std::cos(ch.yaw)));
    }
    return true;
  }
  return false;
}

std::string HospitalWard::objective() const {
  if (role_ == Role::None) return "";
  if (role_ == Role::Patient)
    return (left_ > 0 ? "Recovering in bed " + std::to_string(bed_ + 1) + " \xC2\xB7 " + fmtClock(left_) : "Fit again \xC2\xB7 press " + c_.K(Action::Interact) + " to get up") + " \xC2\xB7 " + c_.K(Action::View) + ": view";
  if (seat_ >= 0) return "Sitting by the bed \xC2\xB7 " + c_.K(Action::Interact) + " to stand up";
  return "Medical centre \xC2\xB7 visit a patient in the ward, the way out: the glass doors";
}

// the windows' and the glass doors' panes: the daylight outside (liveportal.js's soft day / night sky)
void HospitalWard::draw(Renderer& r) {
  if (role_ == Role::None || !c_.shapes) return;
  float day = 1 - float(std::round(clamp(double(c_.night), 0.0, 1.0) * 16) / 16);
  vec3 sky = glm::mix(vec3(0.03f, 0.04f, 0.08f), vec3(1), day) * vec3(0.80f, 0.90f, 1.12f);
  dvec3 o = rooms_.toWorld(0, 0, 0);
  // (the photographs are of the moment you came in: dusk falling or day breaking while you are inside dims / lifts them)
  const float gain = std::round(clamp((0.06 + 0.94 * day) / (0.06 + 0.94 * viewDay_), 0.1, 4.0) * 16) / 16;
  for (int k = 0; k < NV; k++) if (paneModel_[k]) for (Material& m : paneModel_[k]->materials) m.emissive = vec3(gain);
  for (int k = 0; k < NV; k++) if (paneModel_[k] && paneModel_[k]->materials[0].emissiveTex) r.submitModel(*paneModel_[k], o, mat4(1), nullptr, false);
  // (no photograph for a wall: the soft day / night sky)
  for (const Pane& p : panes_) {
    dvec3 pn = dvec3(vec3(p.m * vec4(0, 0, 1, 0)));
    int side = pn.z > 0.7 ? 0 : pn.z < -0.7 ? 1 : pn.x > 0.7 ? 2 : 3;
    if (p.w > 2.0f) side = 4;
    if (paneModel_[side] && paneModel_[side]->materials[0].emissiveTex) continue;
    c_.shapes->oriented(r, Shapes::Kind::Quad, o, p.m * glm::scale(mat4(1), vec3(p.w, p.h, 1)), vec4(sky * 0.25f, 1), 3.2f * (0.15f + 0.85f * day), false);
  }
}

void HospitalWard::hud(Ui& ui, float u) {
  if (role_ == Role::None) return;
  using namespace ui_color;
  float W = float(ui.width()), H = float(ui.height());
  // ---- the stay card (bottom left, the tow yard card's place and brush style)
  if (role_ == Role::Patient) {
    bool fit = left_ <= 0;
    std::string head = fit ? "FIT AGAIN" : "RECOVERING", big = fit ? "" : fmtClock(left_);
    std::string sub = fit ? "Press " + c_.K(Action::Interact) + " to get up and walk out" : "Medical centre \xC2\xB7 bed " + std::to_string(bed_ + 1) + " \xC2\xB7 rest until you are fit";
    float hs = 20 * u, ts = 52 * u, ss = 15 * u;
    float tw = std::max(std::max(ui.textWidth(sub, ss, UiFont::BodyBold), ui.textWidth(big, ts, UiFont::CondSemiItalic)), ui.textWidth(head, hs, UiFont::CondSemiItalic, 0.08f));
    float w = std::max(300 * u, tw + 54 * u), h = (12 + 24 + 52 + 4 + 20 + 14) * u, x = 22 * u, y = H - 92 * u - h;
    Ui::Shadow sh{0, 6 * u, 14 * u, hex(0x00143c, 0.28f)};
    ui.brushPanel(x, y, w, h, white, 0, &sh);
    ui.text(x + 24 * u, y + 12 * u, hs, UiFont::CondSemiItalic, fit ? hex(0x1f9d55) : hex(0xd8283a), head, UiAlign::Left, 0.08f);
    if (fit) {   // the tick
      float cx = x + 26 * u, cy = y + 64 * u;
      ui.polyline({vec2(cx, cy), vec2(cx + 11 * u, cy + 12 * u), vec2(cx + 31 * u, cy - 14 * u)}, 6 * u, blue);
    } else ui.text(x + 24 * u, y + 36 * u, ts, UiFont::CondSemiItalic, blue, big);
    ui.text(x + 24 * u, y + 94 * u, ss, UiFont::BodyBold, blueDim, sub);
  }
  // ---- the eyes opening: dark lids part, blink, open; the room swims into focus
  if (wakeT_ >= 0 && wakeT_ < WAKE_S) {
    // the haze (no blur here: a warm veil thinning out, 5.2 s ease-out)
    double hx = clamp(wakeT_ / 5.2, 0.0, 1.0), he = bezier(hx, 0, 0, 0.58, 1);
    double hazeA = he < 0.6 ? 1 - (he / 0.6) * 0.2 : 0.8 * (1 - (he - 0.6) / 0.4);
    ui.rect(0, 0, W, H, vec4(1.0f, 0.925f, 0.84f, float(0.30 * hazeA)));
    double sh = lidShift(wakeT_);
    if (sh < 1.115) {
      const float lw = W * 1.3f, lh = H * 0.56f, lx = -W * 0.15f, ry = lh * 0.38f;
      const vec4 dark(0.016f, 0.008f, 0.009f, 1);
      for (int s = 0; s < 2; s++) {
        // (top lid: down from the top edge, its lower edge an arc; the bottom one mirrored)
        float off = float(sh) * lh;
        std::vector<vec2> pts;
        auto P = [&](float px, float py) { pts.push_back(s == 0 ? vec2(px, py - off) : vec2(px, H - py + off)); };
        P(lx + lw * 0.5f, 0);
        P(lx, 0); P(lx, lh - ry);
        for (int k = 0; k <= 24; k++) { float a = float(PI) * (1 - k / 24.f); P(lx + lw * 0.5f + std::cos(a) * lw * 0.5f, lh - ry + std::sin(a) * ry); }
        P(lx + lw, 0);
        ui.poly(pts, dark);
      }
    }
  }
  (void)W;
}

void HospitalWard::reset() {
  pending_ = Role::None; capture_ = 99; armed_ = false;
  role_ = Role::None; seat_ = -1; left_ = 0; wakeT_ = -1; flashT_ = -1; discharged_ = false;
}

} // namespace sl
