#include "game/race_cine.h"
#include "core/assets_path.h"
#include "engine/canvas2d.h"
#include "engine/mesh_kit.h"
#include "engine/renderer.h"
#include "game/play_data.h"
#include "game/race_bots.h"
#include "game/shapes.h"
#include "platform/platform.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {
namespace racecine {

namespace {
// per-sample channels (replay.js)
enum { X = 0, Y, Z, HEAD, CROUCH, LEAN, EDGE, SKID, PLOW, SPEED, FLIP, FLIPH, GRAB, SPIN, FALLT, FALLSIDE, FLAGS, STRIDE };
constexpr double RAD = 180 / PI;
double wrapAngle(double a) { return std::atan2(std::sin(a), std::cos(a)); }
double lerpAngle(double a, double b, double t) { return a + wrapAngle(b - a) * t; }
double damp(double k, double dt) { return 1 - std::exp(-k * dt); }
double frameFov(double size, double d, double lo, double hi) { return std::min(hi, std::max(lo, 2 * std::atan(size / std::max(0.5, d)) * RAD)); }
double ground(World& w, double x, double z, double yHint) { const double g = w.groundHeight(x, z, yHint); return std::isfinite(g) ? g : 0; }
void keepAbove(World& w, dvec3& p, double clear) {
  const double g = w.groundHeight(p.x, p.z, p.y + 3);
  if (std::isfinite(g) && p.y < g + clear) p.y = g + clear;
}
// replay.js: the director's shots
const int SHOT_ORDER[6] = {0, 1, 0, 2, 0, 1};   // trackside, heli, trackside, chase, trackside, heli
constexpr double FINISH_LEAD = 3.2, SLOW_FINISH = 0.32, SLOW_AIR = 0.42;
// podium.js
constexpr double SHOW = 6.2;
struct Block { double x, h; };
const Block BLOCK[4] = {{0, 0}, {0, 1.05}, {-1.78, 0.74}, {1.78, 0.5}};   // place: x (the viewer's left = -x), height
constexpr double BW = 1.66, BD = 1.7, LIFT = 0.1;
constexpr int CONFETTI = 360;
const char* CONF_COLS[6] = {"#1546c8", "#ff4d3d", "#ffffff", "#ffcb5c", "#1546c8", "#ffffff"};

// podium.js frontTexture: white, a red stripe along the top, the place in big blue italic Barlow Condensed
gfx::Texture frontTexture(gfx::Device& dev, platform::Platform* plat, int place) {
  static FontSet fonts;
  static bool tried = false;
  if (!tried && plat) {
    tried = true;
    AssetPaths paths;
    std::vector<uint8_t> f;
    if (paths.init(*plat) && plat->readFile(paths.data("fonts/barlow-condensed-700-italic.ttf"), f)) { std::vector<uint8_t> g = f; fonts.regular.load(std::move(f)); fonts.bold.load(std::move(g)); }
  }
  Canvas2D g(256, 256, &fonts);
  g.fillStyle("#f5f8fe"); g.fillRect(0, 0, 256, 256);
  g.fillStyle("#ff4d3d"); g.fillRect(0, 0, 256, 14);
  g.fillStyle("#1546c8");
  g.font("700 190px Barlow Condensed");
  g.textAlign("center");
  g.textBaseline("alphabetic");
  g.fillText(std::to_string(place), 122, 216);
  const std::vector<uint8_t>& px = g.pixels();
  std::vector<uint8_t> flip(px.size());
  for (int y = 0; y < 256; y++) std::copy(px.begin() + (255 - y) * 256 * 4, px.begin() + (256 - y) * 256 * 4, flip.begin() + y * 256 * 4);   // (CanvasTexture flipY)
  gfx::TextureDesc d;
  d.width = 256; d.height = 256; d.format = gfx::TexFormat::SRGBA8; d.wrap = gfx::Wrap::Repeat; d.anisotropy = 4;
  return dev.createTexture(d, flip.data());
}
Material paint(const char* hex, float rough, float metal) {
  Material m;
  m.baseColor = vec4(hexColor(hex), 1); m.roughness = rough; m.metallic = metal; m.shading = 3;
  return m;
}
} // namespace

// ============================================================================ recording
ReplayBuffer::ReplayBuffer(int tracks, double seconds, int rate) : rate_(rate), tracks_(tracks), cap_(int(std::ceil(seconds * rate)) + 2) {
  time_.assign(size_t(cap_), 0);
  data_.assign(size_t(tracks), std::vector<float>(size_t(cap_) * STRIDE, 0.f));
  cutNext_.assign(size_t(tracks), 0);
  reset();
}

void ReplayBuffer::reset() {
  head_ = 0; count_ = 0; nextT_ = -1e300;
  std::fill(cutNext_.begin(), cutNext_.end(), uint8_t(0));
}

bool ReplayBuffer::due(double T) {
  if (T < nextT_) return false;
  const int i = head_;
  time_[size_t(i)] = T;
  slot_ = i;
  head_ = (i + 1) % cap_;
  count_ = std::min(cap_, count_ + 1);
  nextT_ = (nextT_ < -1e299 || T - nextT_ > 0.5 ? T : nextT_) + 1.0 / rate_;
  return true;
}

void ReplayBuffer::write(int k, const dvec3& pos, const Sample& st, bool fall) {
  float* d = &data_[size_t(k)][size_t(slot_) * STRIDE];
  d[X] = float(pos.x); d[Y] = float(pos.y); d[Z] = float(pos.z);
  d[HEAD] = float(st.heading); d[CROUCH] = float(st.crouch); d[LEAN] = float(st.lean);
  d[EDGE] = float(st.edge); d[SKID] = float(st.skid); d[PLOW] = float(st.plow); d[SPEED] = float(st.speed);
  d[FLIP] = float(st.flip); d[FLIPH] = float(st.flipHeading); d[GRAB] = float(st.grab); d[SPIN] = float(st.spinVel);
  d[FALLT] = float(st.fallT); d[FALLSIDE] = float(st.fallSide ? st.fallSide : 1);
  d[FLAGS] = float((st.tuck ? F_TUCK : 0) | (st.air ? F_AIR : 0) | (fall ? F_FALL : 0) | (cutNext_[size_t(k)] ? F_CUT : 0));
  cutNext_[size_t(k)] = 0;
}

// logical index of the last sample at or before t
int ReplayBuffer::find(double t) const {
  int lo = 0, hi = count_ - 1;
  if (hi < 0) return -1;
  if (t <= time_[size_t(phys(0))]) return 0;
  if (t >= time_[size_t(phys(hi))]) return hi;
  while (hi - lo > 1) {
    const int mid = (lo + hi) >> 1;
    if (time_[size_t(phys(mid))] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

bool ReplayBuffer::sample(int k, double t, Sample& out) const {
  const int i = find(t);
  if (i < 0) return false;
  const int j = std::min(count_ - 1, i + 1);
  const int pi = phys(i), pj = phys(j);
  const float* di = &data_[size_t(k)][size_t(pi) * STRIDE];
  const float* dj = &data_[size_t(k)][size_t(pj) * STRIDE];
  const double ti = time_[size_t(pi)], tj = time_[size_t(pj)];
  double a = tj > ti ? clamp((t - ti) / (tj - ti), 0, 1) : 0;
  if (int(dj[FLAGS]) & F_CUT) a = 0;
  auto L = [&](int c) { return double(di[c]) + (double(dj[c]) - double(di[c])) * a; };
  out.x = L(X); out.y = L(Y); out.z = L(Z);
  out.heading = lerpAngle(di[HEAD], dj[HEAD], a);
  out.crouch = L(CROUCH); out.lean = L(LEAN); out.edge = L(EDGE); out.skid = L(SKID); out.plow = L(PLOW); out.speed = L(SPEED);
  out.flip = L(FLIP); out.flipHeading = lerpAngle(di[FLIPH], dj[FLIPH], a);
  out.grab = L(GRAB); out.spinVel = L(SPIN); out.fallT = L(FALLT); out.fallSide = di[FALLSIDE] < 0 ? -1 : 1;
  const int fl = int(a < 0.5 ? di[FLAGS] : dj[FLAGS]);
  out.tuck = (fl & F_TUCK) != 0; out.air = (fl & F_AIR) != 0; out.down = (fl & F_FALL) != 0;
  return true;
}

std::vector<std::pair<double, double>> ReplayBuffer::spans(int k, int flag, double t0, double t1, double min) const {
  std::vector<std::pair<double, double>> out;
  bool open = false;
  double start = 0;
  for (int i = find(t0); i >= 0 && i < count_; i++) {
    const int p = phys(i);
    const double t = time_[size_t(p)];
    if (t > t1) break;
    const bool on = (int(data_[size_t(k)][size_t(p) * STRIDE + FLAGS]) & flag) != 0;
    if (on && !open) { open = true; start = t; }
    if (!on && open) { if (t - start >= min) out.push_back({start, t}); open = false; }
  }
  if (open && t1 - start >= min) out.push_back({start, t1});
  return out;
}

// ============================================================================ playback
ReplayDirector::ReplayDirector(const Opt& o) : o_(o) {
  const ReplayBuffer& B = *o_.buffer;
  const double fc = std::isfinite(o_.finishClock) ? o_.finishClock : B.last();
  t1_ = std::min(B.last(), fc + 2.8);
  t0_ = std::max({B.first(), t1_ - (o_.length > 0 ? o_.length : 20), 0.0});
  t_ = t0_;
  done_ = t1_ - t0_ < 1;
  fc_ = fc;
  airs_ = B.spans(0, F_AIR, t0_, t1_, 0.9);
  racers.assign(size_t(B.tracks()), Out());
}

// playback speed at race time t: slow motion through the finish and big airs
double ReplayDirector::rate(double t) const {
  double r = 1;
  if (std::isfinite(o_.finishClock)) {
    const double k = smoothstep(fc_ - 1.2, fc_ - 0.6, t) * (1 - smoothstep(fc_ + 0.5, fc_ + 1.0, t));
    r = std::min(r, lerp(1, SLOW_FINISH, k));
  }
  for (const auto& [a, b] : airs_) {
    const double k = smoothstep(a, a + 0.3, t) * (1 - smoothstep(b - 0.25, b + 0.05, t));
    r = std::min(r, lerp(1, SLOW_AIR, k));
  }
  return r;
}

bool ReplayDirector::update(double dt, const dvec3& camPos) {
  if (done_) return false;
  const double rt = rate(t_);
  t_ = std::min(t1_, t_ + dt * rt);
  poseDt = dt * rt;
  slow_ = rt < 0.8;
  const ReplayBuffer& B = *o_.buffer;
  for (int k = 0; k < B.tracks(); k++) {
    Out& r = racers[size_t(k)];
    r.ok = B.sample(k, t_, r.st);
    if (!r.ok) { r.show = false; continue; }
    r.show = std::hypot(r.st.x - camPos.x, r.st.z - camPos.z) < 650;
    if (!r.show) continue;
    if (r.st.air) r.normal = three::V3(0, 1, 0);
    else r.normal = three::V3(o_.world->groundNormal(r.st.x, r.st.z, r.st.y + 0.5));
  }
  camOk = false;
  if (!racers.empty() && racers[0].ok) {
    const Sample& me = racers[0].st;
    const double s = o_.project(me.x, me.z, hasPs_ ? ps_ : -1);
    if (std::isfinite(s) && (!hasPs_ || std::fabs(s - ps_) < 200)) { ps_ = s; hasPs_ = true; }
    frame(dt, me);
    camOk = true;
  }
  if (t_ >= t1_) { done_ = true; return false; }
  return true;
}

void ReplayDirector::frame(double dt, const Sample& me) {
  const bool hasFin = std::isfinite(o_.finishClock);
  const bool nearFinish = hasFin && fc_ - t_ < FINISH_LEAD;
  if (nearFinish && !(hasShot_ && shot_.kind == 3)) { shot_ = makeFinish(); hasShot_ = true; }
  if (!hasShot_ || (shot_.kind != 3 && shotOver(shot_))) {
    // no new angle for the last moments before the finish camera
    const bool soon = hasFin && fc_ - t_ < FINISH_LEAD + 1.4;
    shot_ = soon && hasShot_ ? makeFinish() : makeShot(me);
    hasShot_ = true;
  }
  Shot& sh = shot_;
  focus_ = dvec3(me.x, me.y + (me.down ? 0.5 : 1.0), me.z);
  const double fx = std::sin(me.heading), fz = std::cos(me.heading), rx = -fz, rz = fx;
  const bool first = sh.frames++ == 0;
  if (sh.kind == 0 || sh.kind == 3) {
    camPos_ = sh.pos;
    if (first) camLook_ = focus_; else camLook_ += (focus_ - camLook_) * damp(22, dt);
    const double fov = frameFov(2.6, glm::length(camPos_ - focus_), 13, 55);
    fov_ = first ? fov : lerp(fov_, fov, damp(4, dt));
  } else if (sh.kind == 1) {
    sh.yaw = first ? std::atan2(fx, fz) : sh.yaw + wrapAngle(std::atan2(fx, fz) - sh.yaw) * damp(1.2, dt);
    const double hx = std::sin(sh.yaw), hz = std::cos(sh.yaw);
    dvec3 want(me.x - hx * 26 - hz * sh.side * 30, me.y + 24, me.z - hz * 26 + hx * sh.side * 30);
    keepAbove(*o_.world, want, 18);
    if (first) camPos_ = want; else camPos_ += (want - camPos_) * damp(2.2, dt);
    if (first) camLook_ = focus_; else camLook_ += (focus_ - camLook_) * damp(10, dt);
    const double fov = frameFov(3.2, glm::length(camPos_ - focus_), 12, 42);
    fov_ = first ? fov : lerp(fov_, fov, damp(3, dt));
  } else {   // chase
    dvec3 want(me.x - fx * 6 + rx * sh.side * 1.9, me.y + 1.5, me.z - fz * 6 + rz * sh.side * 1.9);
    keepAbove(*o_.world, want, 0.9);
    if (first) camPos_ = want; else camPos_ += (want - camPos_) * damp(6, dt);
    const dvec3 look(me.x + fx * 3, me.y + 0.9, me.z + fz * 3);
    if (first) camLook_ = look; else camLook_ += (look - camLook_) * damp(9, dt);
    fov_ = 56;
  }
  cam.pos = camPos_; cam.look = camLook_; cam.fov = fov_;
}

bool ReplayDirector::shotOver(const Shot& sh) const {
  const double age = t_ - sh.t0;
  if (sh.kind == 0) return age > sh.max || (hasPs_ && ps_ > sh.s + 14) || (age > 1.2 && glm::length(camPos_ - focus_) > 140);
  return age > sh.max;
}

ReplayDirector::Shot ReplayDirector::makeShot(const Sample& me) {
  Shot sh;
  sh.kind = SHOT_ORDER[shotN_++ % 6];
  side_ = -side_;
  sh.t0 = t_; sh.side = side_;
  if (sh.kind == 1) { sh.max = 4.2; return sh; }
  if (sh.kind == 2) { sh.max = 3.2; return sh; }
  // trackside: a camera ahead along the piste, beside the nets
  const double v = std::max(8.0, me.speed);
  const double s = (hasPs_ ? ps_ : 0) + clamp(v * 2.3, 30, 85);
  racebots::Frame fr;
  o_.track->frame(s, fr);
  // (inside the nets in tunnels / on bridges: replay.js this.tunnels)
  bool enclosed = false;
  for (const Course::Feature& f : o_.track->course.features) enclosed = enclosed || ((f.type == "tunnel" || f.type == "bridge") && s > f.s0 - 15 && s < f.s1 + 15);
  const double lat = side_ * (enclosed ? fr.w - 1.2 : fr.w + 2.5);
  dvec3 pos(fr.x + fr.nx * lat, 0, fr.z + fr.nz * lat);
  // high enough to see over the crest the skier comes over (the piste falls away below the camera)
  pos.y = enclosed ? fr.y + 2.2 : std::max(std::max(fr.y, ground(*o_.world, pos.x, pos.z, fr.y + 6)) + 3.2, (me.y != 0 ? me.y : fr.y) + 2.4);
  sh.enclosed = enclosed;
  sh.pos = pos; sh.s = s; sh.max = 4.6;
  return sh;
}

ReplayDirector::Shot ReplayDirector::makeFinish() {
  const racebots::Track& tr = *o_.track;
  racebots::Frame fr;
  tr.frame(tr.finishS + 7, fr);
  const double lat = std::max(2.0, fr.w - 2.5);
  Shot sh;
  sh.kind = 3; sh.t0 = t_; sh.max = 1e300;
  sh.pos = dvec3(fr.x + fr.nx * lat, 0, fr.z + fr.nz * lat);
  sh.pos.y = ground(*o_.world, sh.pos.x, sh.pos.z, fr.y + 6) + 1.7;
  return sh;
}

std::string ReplayDirector::shotKind() const {
  static const char* N[4] = {"trackside", "heli", "chase", "finish"};
  return hasShot_ && shot_.kind >= 0 ? N[shot_.kind] : "none";
}

// ============================================================================ the intro (presentation/intro.js)
namespace {
constexpr double REACH = 950;   // m: straight-line distance from the start the flight may go
const char* SET_PIECES[10] = {"kicker", "tabletop", "bridge", "tunnel", "lake", "slalom", "narrow", "cliff", "bank", "roller"};
}

CourseIntro::CourseIntro(const racebots::Track& tr, const Course& c, World& world) : world_(world) {
  const double s0 = std::isfinite(c.start.s) ? c.start.s : tr.s0 + 4;
  racebots::Frame st, fr, la;
  tr.frame(s0, st);
  // where the flight ends: past the first set piece within reach, else ~480 m down the course
  const Course::Feature* f = nullptr;
  for (const Course::Feature& q : c.features) {
    bool piece = false;
    for (const char* n : SET_PIECES) piece = piece || q.type == n;
    if (piece && q.s0 > s0 + 110 && q.s0 < s0 + 640 && (!f || q.s0 < f->s0)) f = &q;
  }
  double sEnd = f ? clamp((std::isfinite(f->land1) ? f->land1 : f->s1) + 40, s0 + 360, s0 + 700) : s0 + 480;
  sEnd = std::min(sEnd, tr.finishS - 40);
  while (sEnd > s0 + 250) {
    tr.frame(sEnd, fr);
    if (std::hypot(fr.x - st.x, fr.z - st.z) < REACH) break;
    sEnd -= 20;
  }
  sEnd_ = sEnd;
  // control points every ~32 m: from 80 m behind and high above the start house, descending toward the piste, weaving
  // from one side of the nets to the other
  const double sBack = s0 - 80;
  const int n = std::max(10, int(std::round((sEnd - sBack) / 32)));
  int sum = 0;
  for (unsigned char ch : c.id) sum += ch;   // (the ids are ASCII: charCodeAt)
  const double side = (sum & 1) ? 1 : -1;
  for (int i = 0; i <= n; i++) {
    const double u = double(i) / n, s = lerp(sBack, sEnd, u);
    tr.frame(s, fr);
    const double h = lerp(52, 16, smoothstep(0, 0.62, u)) + 4 * std::sin(u * PI * 2.6);
    const double lat = side * (fr.w + 12) * std::sin(u * PI * 1.35) * smoothstep(0.02, 0.3, u);
    const double x = fr.x + fr.nx * lat, z = fr.z + fr.nz * lat;
    const bool outside = std::fabs(lat) > fr.w;
    const double y = std::max(fr.y + h, ground(world_, x, z, fr.y + h + 50) + (outside ? 22 : 11));
    pathA_.push_back(dvec3(x, y, z));
    // look far down the course and a little above it: the valley and the peaks stay in frame
    tr.frame(std::min(s + 140, sEnd + 200), la);
    lookA_.push_back(dvec3(la.x, la.y + 10 + 12 * (1 - u), la.z));
  }
  // smooth the heights (terrain clearance can make neighbours jump), never below the clearance
  std::vector<double> ys;
  for (const dvec3& p : pathA_) ys.push_back(p.y);
  for (int it = 0; it < 3; it++)
    for (size_t i = 1; i + 1 < pathA_.size(); i++) pathA_[i].y = std::max(ys[i], (pathA_[i - 1].y + pathA_[i].y * 2 + pathA_[i + 1].y) / 4);
}

// three.js CatmullRomCurve3(points, false, 'centripetal').getPoint(t)
dvec3 CourseIntro::curve(const std::vector<dvec3>& pts, double t) const {
  const int l = int(pts.size());
  const double p = (l - 1) * t;
  int ip = int(std::floor(p));
  double w = p - ip;
  if (w == 0 && ip == l - 1) { ip = l - 2; w = 1; }
  const dvec3 p0 = ip > 0 ? pts[size_t(ip - 1)] : pts[0] - pts[1] + pts[0];
  const dvec3 p1 = pts[size_t(ip)], p2 = pts[size_t(ip + 1)];
  const dvec3 p3 = ip + 2 < l ? pts[size_t(ip + 2)] : pts[size_t(l - 1)] - pts[size_t(l - 2)] + pts[size_t(l - 1)];
  double dt0 = std::pow(glm::dot(p0 - p1, p0 - p1), 0.25), dt1 = std::pow(glm::dot(p1 - p2, p1 - p2), 0.25), dt2 = std::pow(glm::dot(p2 - p3, p2 - p3), 0.25);
  if (dt1 < 1e-4) dt1 = 1.0;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;
  const dvec3 t1 = ((p1 - p0) / dt0 - (p2 - p0) / (dt0 + dt1) + (p2 - p1) / dt1) * dt1;
  const dvec3 t2 = ((p2 - p1) / dt1 - (p3 - p1) / (dt1 + dt2) + (p3 - p2) / dt2) * dt1;
  const dvec3 c2 = -3.0 * p1 + 3.0 * p2 - 2.0 * t1 - t2, c3 = 2.0 * p1 - 2.0 * p2 + t1 + t2;
  return p1 + t1 * w + c2 * (w * w) + c3 * (w * w * w);
}

bool CourseIntro::update(double dt, bool holding, const dvec3& p, double h) {
  cutNow = false;
  if (done_) return false;
  if (!holding) t_ += dt;
  const double t = t_;
  if (t >= duration()) { done_ = true; return false; }
  if (t < SHOT_A) {
    // shot A: slow start out of the reveal, fast through the middle, easing into the set piece before the cut
    const double k = t / SHOT_A;
    const double u = clamp(0.22 * k + 0.78 * (k * k * (3 - 2 * k)), 0, 1);
    dvec3 pos = curve(pathA_, u);
    keepAbove(world_, pos, 6);
    cam.pos = pos; cam.look = curve(lookA_, u); cam.fov = lerp(52, 44, u);
    blend = 0;
  } else {
    if (!cut_) { cut_ = true; cutNow = true; }
    // shot B, the crane: in front of the field (looking up at the racers and the start house), up and over to one
    // side, down behind the player. (Inside the START arch, which stands 12 m below the gate.)
    const double k = (t - SHOT_A) / SHOT_B;
    const double fx = std::sin(h), fz = std::cos(h), rx = -fz, rz = fx;
    const double e = ease(k);
    const double a = lerp(0.18, PI, e), R = lerp(9.5, 7, e), side = 1, lift = std::sin(a);
    dvec3 pos(p.x + fx * R * std::cos(a) + rx * side * R * 0.55 * lift, p.y + 1.5 + 8 * lift + 0.04 * std::sin(k * 9), p.z + fz * R * std::cos(a) + rz * side * R * 0.55 * lift);
    keepAbove(world_, pos, 1.2);
    cam.pos = pos; cam.look = dvec3(p.x + fx * 1.5 * e, p.y + 1.25, p.z + fz * 1.5 * e); cam.fov = lerp(36, 52, e);
    // the last part blends into the gameplay camera (computed by the game this frame)
    blend = smoothstep(0.6, 1, k);
  }
  return true;
}

// ============================================================================ the podium
Podium::Podium(gfx::Device& dev, platform::Platform* plat, World& world, const racebots::Track& tr, std::vector<Racer> top) : world_(world), top_(std::move(top)) {
  racebots::Frame fr;
  tr.frame(tr.finishS + 7, fr);
  // the podium faces down the run-out: the camera looks back up at it, the finish arch behind
  heading_ = fr.h;
  const double fx = std::sin(fr.h), fz = std::cos(fr.h);
  fwd_ = dvec3(fx, 0, fz);
  right_ = dvec3(-fz, 0, fx);   // across the podium (the viewer's left when looking back up at it)
  double gy = -1e300;
  const double pts[5][2] = {{0, 0}, {-2.6, -0.9}, {2.6, -0.9}, {-2.6, 0.9}, {2.6, 0.9}};
  for (const auto& p : pts) gy = std::max(gy, ground(world_, fr.x + right_.x * p[0] + fx * p[1], fr.z + right_.z * p[0] + fz * p[1], fr.y + 4));
  base_ = dvec3(fr.x, gy, fr.z);
  // the model, in the podium's frame (local +z = down the run-out, toward the camera)
  std::vector<std::pair<Geo, Material>> parts;
  const Material white = paint("#f2f5fb", 0.55f, 0), blue = paint("#1546c8", 0.5f, 0.05f), red = paint("#ff4d3d", 0.5f, 0);
  { Geo g = boxGeo(float(BW * 3 + 0.9), 0.42f, float(BD + 0.7)); g.translate(0, -0.11f, 0); parts.push_back({std::move(g), blue}); }   // the blue plinth, sunk into the snow
  Geo blocks, trims;
  for (int place = 1; place <= 3; place++) {
    const Block& B = BLOCK[place];
    Geo b = boxGeo(float(BW), float(B.h), float(BD));
    b.translate(float(B.x), float(LIFT + B.h / 2), 0);
    blocks.append(b);
    Geo t = boxGeo(float(BW + 0.024), 0.06f, float(BD + 0.024));   // the red band round the top edge
    t.translate(float(B.x), float(LIFT + B.h - 0.036), 0);
    trims.append(t);
    // the front face (BoxGeometry's +z): the place on its canvas
    Geo f;
    const float x0 = float(B.x - BW / 2), x1 = float(B.x + BW / 2), y0 = float(LIFT), y1 = float(LIFT + B.h), z = float(BD / 2 + 0.002);
    f.pos = {vec3(x0, y0, z), vec3(x1, y0, z), vec3(x1, y1, z), vec3(x0, y1, z)};
    f.nor.assign(4, vec3(0, 0, 1));
    f.uv = {vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 1)};
    f.idx = {0, 1, 2, 0, 2, 3};
    Material face = paint("#ffffff", 0.6f, 0);
    face.baseTex = frontTexture(dev, plat, place);
    parts.push_back({std::move(f), face});
    const dvec3 l(B.x, LIFT + B.h, 0.05);
    spots_[place] = base_ + right_ * (-l.x) + fwd_ * l.z + dvec3(0, l.y, 0);
  }
  parts.push_back({std::move(blocks), white});
  parts.push_back({std::move(trims), red});
  model_ = buildModel(dev, parts, "race-podium");
  cf_.resize(size_t(CONFETTI));
  for (Conf& c : cf_) {
    c.ax = glm::normalize(vec3(float(rnd_.next() - 0.5), float(rnd_.next() - 0.5), float(rnd_.next() - 0.5)));
    c.a = rnd_.next() * 6; c.w = 4 + rnd_.next() * 8; c.ph = rnd_.next() * 6.28;
  }
}

// (the podium's local x in the world: rotation.y = h maps +x to (cos h, 0, -sin h) = -right_)
double Podium::surface(double x, double z) const {
  const double dx = x - base_.x, dz = z - base_.z;
  const double lx = -(dx * right_.x + dz * right_.z), lz = dx * fwd_.x + dz * fwd_.z;
  double y = std::nan("");
  if (std::fabs(lx) <= (BW * 3 + 0.9) / 2 && std::fabs(lz) <= (BD + 0.7) / 2) y = base_.y + LIFT;
  for (int place = 1; place <= 3; place++)
    if (std::fabs(lx - BLOCK[place].x) <= BW / 2 && std::fabs(lz) <= BD / 2) y = base_.y + LIFT + BLOCK[place].h;
  return y;
}

RigState Podium::stateOf(int place) const {
  RigState st;
  st.mode = RigMode::Idle;
  st.hasEdge = true; st.edge = 0;
  st.hasNormal = true; st.normal = three::V3(0, 1, 0);
  st.fp = 0;
  // a gentle sway: the winner turns a little to each side of the crowd
  st.heading = heading_ + (place == 1 ? 0.18 * std::sin(t_ * 0.7) : place == 2 ? 0.22 : -0.22);
  return st;
}

// Two cannons at the podium's sides fire up and inward; a third of the pieces rain from above.
void Podium::fire(double t) {
  const dvec3 b = base_, r = right_, f = fwd_;
  auto R = [&]() { return rnd_.next(); };
  for (int i = 0; i < CONFETTI; i++) {
    Conf& c = cf_[size_t(i)];
    const int k = i % 3;
    c.born = t + (double(i) / CONFETTI) * 0.5;
    if (k == 2) {
      const double a = (R() - 0.5) * 7, d = (R() - 0.3) * 4, h = 6 + R() * 3, a2 = (R() - 0.5) * 7, d2 = (R() - 0.3) * 4;
      c.p = dvec3(b.x + r.x * a + f.x * d, b.y + h, b.z + r.z * a2 + f.z * d2);
      c.v = dvec3(0, -0.5, 0);
    } else {
      const double s = k == 0 ? -1 : 1;
      c.p = dvec3(b.x + r.x * s * 3.4, b.y + 0.4, b.z + r.z * s * 3.4);
      const double up = 9 + R() * 4, inward = 2.2 + R() * 2.6, out = (R() - 0.3) * 2.4;
      c.v = dvec3(-r.x * s * inward + f.x * out + (R() - 0.5), up, -r.z * s * inward + f.z * out + (R() - 0.5));
    }
  }
  // snow kicked up off the blocks (snowfx.js Spray.emit(pos, vel, count, spread, size, life))
  auto emit = [&](const dvec3& pos, const dvec3& vel, int count, double spread, double size, double life) {
    for (int i = 0; i < count; i++) {
      Puff p;
      p.p = pos + dvec3((R() - 0.5) * 0.6, (R() - 0.5) * 0.6, (R() - 0.5) * 0.6);
      p.v = dvec3(vel.x + (R() - 0.5) * spread * 2, vel.y + R() * spread * 1.5, vel.z + (R() - 0.5) * spread * 2);
      p.maxLife = p.life = life * (0.6 + R() * 0.8);
      p.size = size * (0.6 + R() * 0.8);
      puffs_.push_back(p);
    }
  };
  for (int place = 1; place <= 3; place++) if (place <= int(top_.size()) && top_[size_t(place - 1)].track >= 0) emit(spots_[place], dvec3(0, 2.4, 0), 60, 1.6, 0.3, 1.4);
  for (double s : {-1.0, 1.0}) emit(dvec3(b.x + r.x * s * 3.4, b.y + 0.3, b.z + r.z * s * 3.4), dvec3(-r.x * s * 1.5, 4, -r.z * s * 1.5), 90, 1.8, 0.35, 1.6);
  fired = true;
}

void Podium::updateConfetti(double dt, double t) {
  for (Conf& c : cf_) {
    if (t < c.born) continue;
    // light pieces: strong air drag, fluttering sideways while they fall
    const double drag = std::exp(-dt * 2.6);
    c.v.x *= drag; c.v.z *= drag;
    c.v.y = c.v.y * std::exp(-dt * 1.2) - 9.8 * dt * 0.55;
    if (c.v.y < -1.4) c.v.y = -1.4;
    const double fl = std::sin(t * 3.1 + c.ph) * 0.9;
    c.p.x += (c.v.x + fl * right_.x) * dt;
    c.p.y += c.v.y * dt;
    c.p.z += (c.v.z + fl * right_.z) * dt;
    const double gy = base_.y + 0.02;
    if (c.p.y < gy) { c.p.y = gy; c.v = dvec3(0); }
    else c.a += c.w * dt;
  }
  for (size_t i = 0; i < puffs_.size();) {
    Puff& p = puffs_[i];
    p.life -= dt;
    if (p.life <= 0) { puffs_[i] = puffs_.back(); puffs_.pop_back(); continue; }
    const double dr = std::exp(-dt * 2.2);
    p.v.x *= dr; p.v.z *= dr; p.v.y = p.v.y * dr - 4.5 * dt;
    p.p += p.v * dt;
    p.size += 0.5 * dt;
    i++;
  }
}

bool Podium::update(double dt) {
  const double t0 = t_;
  t_ += dt;
  fired = false;
  if (t0 == 0) fire(0.15);
  if (phase_ == 0 && t_ >= SHOW) skip();
  updateConfetti(dt, t_);
  updateCamera(t_);
  return phase_ == 0;
}

void Podium::updateCamera(double t) {
  const dvec3 b = base_, f = fwd_, r = right_;
  const double k = ease(std::min(1.0, t / SHOW));
  // a slow orbit across the front of the podium; it keeps drifting (slower) behind the results
  const double drift = t > SHOW ? (t - SHOW) * 0.03 : 0;
  const double a = lerp(-0.62, 0.5, k) + drift;
  const double R = lerp(10.5, 8, k) - std::min(1.5, drift * 4);
  dvec3 pos(b.x + (f.x * std::cos(a) + r.x * std::sin(a)) * R, b.y + lerp(1.55, 2.3, k), b.z + (f.z * std::cos(a) + r.z * std::sin(a)) * R);
  pos.y = std::max(pos.y, ground(world_, pos.x, pos.z, pos.y + 3) + 1.2);
  dvec3 look(b.x, b.y + lerp(2.1, 1.9, smoothstep(0, 1, k)), b.z);
  // frame the podium right of centre (the lower third sits bottom left): aim a little to its left
  const double dx = look.x - pos.x, dz = look.z - pos.z, dl = std::max(1e-9, std::hypot(dx, dz));
  look.x += (dz / dl) * 2.3; look.z -= (dx / dl) * 2.3;
  cam.pos = pos; cam.look = look; cam.fov = lerp(44, 38, k);
}

void Podium::draw(Renderer& r, Shapes& shapes) {
  if (model_) r.submitModel(*model_, base_, glm::rotate(mat4(1), float(heading_), vec3(0, 1, 0)), nullptr, true);
  static vec4 cols[6];
  static bool init = false;
  if (!init) { init = true; for (int i = 0; i < 6; i++) cols[i] = vec4(hexColor(CONF_COLS[i]), 1); }
  const mat4 sc = glm::scale(mat4(1), vec3(0.09f, 0.15f, 1));
  for (int i = 0; i < CONFETTI; i++) {
    const Conf& c = cf_[size_t(i)];
    if (t_ < c.born) continue;
    shapes.oriented(r, Shapes::Kind::Quad, c.p, glm::rotate(mat4(1), float(c.a), c.ax) * sc, cols[i % 6], 0, false);
  }
  for (const Puff& p : puffs_) {
    Particle q;
    q.pos = p.p; q.size = float(p.size);
    q.color = vec4(1, 1, 1, float(std::clamp(p.life / p.maxLife, 0.0, 1.0)) * 0.8f);
    q.seed = float(p.maxLife);
    r.addParticle(q);
  }
}

} // namespace racecine
} // namespace sl
