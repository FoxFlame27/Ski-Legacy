#include "game/race_bots.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {
namespace racebots {

namespace {
constexpr double G = 9.81;
constexpr double CAL_H = 1.0 / 60;          // step of the headless 1D simulations (calibration)
constexpr double AIR = 0.5 * 1.15 / 80;     // 0.5 * air density / mass: drag acceleration = AIR * CdA * v^2
constexpr double ABSORB_H = 0.25;           // drop below the ballistic path (m) the legs soak up without taking off
constexpr double LOOK_T = 0.1;              // take-off look-ahead (s): an edge launches, a gentle crest is absorbed
constexpr double SHARP = 30;                // m/s^2: the snow must fall away at least this much faster than gravity
constexpr double EDGE = 0.9;                // closest a skier's centre gets to a barrier (m)
constexpr double V_MIN = 1.6;               // racers never stall below this (skating / herringbone)
constexpr double RUNOUT = 90;               // run-out modelled past the finish line (m)
constexpr double INF = 1e18;
// player.js-equivalent physics of the reference run (bots.js PLAYER_PHYS) and the calibration ski (REF_SKI, GEAR_SHARE)
struct { double mu = 0.04, cdaTuck = 0.2, cdaUp = 0.48, aGrip = 21, tuckA = 13.5, push = 2.6, pushMax = 9, brake = 7, reaction = 0.15, refScale = 1; } const PLAYER_PHYS{};
constexpr double REF_SKI_SPEED = 1.03, REF_SKI_GRIP = 1.08, GEAR_SHARE = 0.5;

const char* BOT_NAMES[16] = {
  "Lukas Brunner", "Sofia Moretti", "Henrik Lund", "Chlo\xC3\xA9 Martin", "Matteo Rossi", "Anna Keller",
  "Jonas Berg", "Mia Novak", "Kai Tanaka", "Elsa Lindqvist", "Tom Fischer", "Nina Hofer",
  "Lena Vogt", "Arno Kristiansen", "Julia Sauer", "Pierre Lambert",
};

const Difficulty DIFFS[4] = {
  {"easy", "Easy", {1.16, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.36, 1.39, 1.42, 1.45, 1.48, 1.51, 1.55}, 13.5, {0.3, 0.6}, 5.5, 15,
   {0.32, 0.62}, {2.3, 2.8}, 5, 1.0 / 30, 1, 0, 1.07},
  {"medium", "Medium", {1.04, 1.06, 1.08, 1.1, 1.12, 1.14, 1.16, 1.18, 1.2, 1.22, 1.24, 1.26, 1.28, 1.3}, 17.5, {0.6, 0.85}, 9, 13,
   {0.18, 0.4}, {2.7, 3.2}, 6, 1.0 / 55, 0.75, 0, 1.07},
  {"hard", "Hard", {0.99, 1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1, 1.11, 1.13}, 21, {0.82, 1.0}, 12, 11,
   {0.08, 0.22}, {3.1, 3.6}, 7, 1.0 / 110, 0.55, 0, 1.07},
  {"superhard", "Superhard", {0.958, 0.964, 0.97, 0.975, 0.98, 0.985, 0.99, 0.995, 1.0, 1.005, 1.01, 1.017, 1.025, 1.035}, 23, {0.94, 1.0}, 13.5, 10,
   {0.05, 0.12}, {3.4, 3.9}, 7.5, 1.0 / 260, 0.4, 0.6, 1.1},
};

inline double wrap(double a) { return a - TAU * std::floor((a + PI) / TAU); }
inline double lerpAngle(double a, double b, double t) { return a + wrap(b - a) * t; }
inline double clampd(double v, double a, double b) { return v < a ? a : v > b ? b : v; }
inline double lerp(double a, double b, double t) { return a + (b - a) * t; }
inline double smoothst(double a, double b, double x) { double t = clampd((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
inline double ek(double h, double r) { return 1 - std::exp(-h * r); }
inline double sgn(double x) { return x > 0 ? 1.0 : x < 0 ? -1.0 : 0.0; }
inline double normFriction(double v) { return std::isfinite(v) && v > 0 ? clampd(v, 0.05, 2) : 1; }
inline double gripOf(double fr) { return 0.3 + 0.7 * std::min(1.0, fr); }

// box smoothing in place: `passes` passes of a (2r+1)-tap box filter
void smooth(std::vector<double>& a, int r, int passes) {
  const int n = int(a.size());
  std::vector<double> tmp(a.size());
  for (int p = 0; p < passes; p++) {
    for (int i = 0; i < n; i++) {
      double s = 0;
      int c = 0;
      for (int k = -r; k <= r; k++) { int j = i + k; if (j >= 0 && j < n) { s += a[size_t(j)]; c++; } }
      tmp[size_t(i)] = s / c;
    }
    a = tmp;
  }
}

// fraction of speed lost absorbing a landing of the given impact speed (m/s)
inline double landingLoss(double impact) { return clampd((impact - 2.5) * 0.012, 0, 0.18); }

// One step of a skier along a planned line using a ground profile: follows the snow, takes off where the ground falls
// away faster than gravity can follow (beyond what the legs absorb), flies ballistically and lands on the profile.
// Returns the landing impact (m/s) when it lands this step.
template <class Accel>
double flightStep(const Track& tr, const std::vector<float>& prof, const std::vector<float>& pf, SimState& st, double h, Accel* accel) {
  const double f = tr.sample(pf, st.s);
  if (!st.air) {
    const double cosA = 1 / std::sqrt(1 + st.tanA * st.tanA);
    const double dh = st.v * cosA * h;
    const double sN = st.s + dh / f;
    const double gN = tr.prof(prof, sN);
    const double yb = st.y + st.vy * h - 0.5 * G * h * h;
    // the snow falls away from the ballistic path: take off at a real edge, absorb small changes
    if (gN < yb - 0.5 * SHARP * h * h && st.v > 6) {
      const double gF = tr.prof(prof, st.s + (st.v * cosA * LOOK_T) / f);
      if (gF < st.y + st.vy * LOOK_T - 0.5 * G * LOOK_T * LOOK_T - ABSORB_H) {
        st.air = true; st.vh = st.v * cosA; st.vy -= G * h; st.y = yb; st.s = sN;
        return 0;
      }
    }
    const double dy = gN - st.y;
    st.tanA = dy / std::max(1e-4, dh);
    const double v2 = st.v * st.v - 2 * G * dy;
    st.v = v2 > 0 ? std::sqrt(v2) : 0;
    if (accel) st.v = std::max(V_MIN, st.v + (*accel)(st, cosA) * h);
    st.vy = dy / h; st.y = gN; st.s = sN;
    return 0;
  }
  st.vy -= G * h;
  st.y += st.vy * h;
  st.s += (st.vh * h) / f;
  const double gN = tr.prof(prof, st.s);
  if (st.y > gN) return 0;
  const double tanB = (tr.prof(prof, st.s + 0.5) - tr.prof(prof, st.s - 0.5)) / f;
  const double cb = 1 / std::sqrt(1 + tanB * tanB), sb = tanB * cb;
  const double along = st.vh * cb + st.vy * sb, perp = -st.vh * sb + st.vy * cb;
  const double impact = std::max(0.0, -perp);
  st.v = std::max(V_MIN, along) * (1 - landingLoss(impact));
  st.y = gN; st.vy = st.v * sb; st.tanA = tanB; st.air = false;
  return impact;
}

// put a 1D skier state on the snow at st.s, moving with the local slope (no spurious take-off)
void settle(const Track& tr, const std::vector<float>& prof, const std::vector<float>& pf, SimState& st) {
  st.y = tr.prof(prof, st.s);
  st.tanA = (tr.prof(prof, st.s + 0.5) - tr.prof(prof, st.s - 0.5)) / tr.sample(pf, st.s);
  st.vy = st.v * st.tanA / std::sqrt(1 + st.tanA * st.tanA);
  st.air = false;
}

// landing impact for a take-off at speed v from just before a lip
double landingImpact(const Track& tr, const std::vector<float>& prof, const std::vector<float>& pf, double s, double v) {
  SimState st;
  st.s = s; st.v = v;
  settle(tr, prof, pf, st);
  for (int k = 0; k < 900; k++) {
    const bool wasAir = st.air;
    const double imp = flightStep<double(const SimState&, double)>(tr, prof, pf, st, CAL_H, nullptr);
    if (wasAir && !st.air) return imp;
    if (!st.air && k > 40) return 0;   // rolled it
    st.v = std::max(st.v, v * 0.5);
  }
  return 99;
}

// longitudinal acceleration other than gravity (gravity comes exactly from height changes)
double longAccel(const Params& P, double v, double cosA, double fr, bool tuck, double vcap, bool pushing, double dragMul) {
  const double cda = tuck ? P.cdaTuck : P.cdaUp;
  double a = -P.mu * fr * G * cosA - AIR * cda * dragMul * v * v;
  if (pushing) a += P.push * std::max(0.0, 1 - v / P.pushMax);
  if (v > vcap) a -= std::min(P.brake * gripOf(fr), (v - vcap) * 3 + 0.4);
  return a;
}

// physics of an ideal player run on the racing line: carving at the edge-grip limit, tucked whenever the turn allows
// it, player-equivalent snow and drag for the player's skis
struct RefRun { Path path; Params P; };
void referenceParams(const Track& tr, double mult, double grip, RefRun& R) {
  R.path = tr.pathOf(tr.raceLat);
  Params& P = R.P;
  P.mu = PLAYER_PHYS.mu / mult; P.cdaTuck = PLAYER_PHYS.cdaTuck; P.cdaUp = PLAYER_PHYS.cdaUp; P.dragMul = 1 / (mult * mult);
  P.aLat = PLAYER_PHYS.aGrip * grip; P.brake = PLAYER_PHYS.brake; P.push = PLAYER_PHYS.push; P.pushMax = PLAYER_PHYS.pushMax;
  P.reaction = PLAYER_PHYS.reaction; P.tuckA = PLAYER_PHYS.tuckA * grip; P.tuckV = 4; P.prof = &tr.profRace; P.path = &R.path;
  P.vmax = speedProfile(tr, R.path, P);
}

bool laneFree(const std::vector<Racer>& racers, const void* self, const Racer* except, double selfS, double lat, double ahead) {
  for (const Racer& o : racers) {
    if (o.self == self || &o == except) continue;
    const double ds = o.s - selfS;
    if (ds > -2.5 && ds < ahead + 6 && std::fabs(o.lat - lat) < 1.35) return false;
  }
  return true;
}
} // namespace

const Difficulty& difficulty(int ai) { return DIFFS[std::clamp(ai, 0, 3)]; }

// ---------------------------------------------------------------- track model
Track::Track(const Course& c, World& w) : course(c), world(w) {
  const CourseLine& L = c.line;
  n = L.n;
  s0 = 0;
  lineEnd = (n - 1) * DS;
  finishS = c.finish.s > 0 ? c.finish.s : c.length > 0 ? c.length : lineEnd;
  const size_t N = size_t(n);
  X.resize(N); Z.resize(N); Y.resize(N); W.resize(N); B.assign(N, 0); H.resize(N); K.assign(N, 0); NX.resize(N); NZ.resize(N); F.assign(N, 1);
  for (size_t i = 0; i < N; i++) {
    X[i] = L.X[i]; Z[i] = L.Z[i]; Y[i] = L.Y[i];
    W[i] = std::max(1.2, double(L.W.empty() ? 8.f : L.W[i]));
    if (!L.B.empty()) B[i] = L.B[i];
    if (!L.F.empty()) F[i] = normFriction(L.F[i]);
  }
  // heading + curvature from the geometry itself (independent of the course's own conventions)
  for (int i = 0; i < n; i++) {
    const size_t a = size_t(std::max(0, i - 1)), b = size_t(std::min(n - 1, i + 1));
    H[size_t(i)] = std::atan2(X[b] - X[a], Z[b] - Z[a]);
  }
  for (int i = 1; i < n - 1; i++) K[size_t(i)] = wrap(H[size_t(i) + 1] - H[size_t(i) - 1]) / (2 * DS);
  smooth(K, 2, 3);
  for (size_t i = 0; i < N; i++) { NX[i] = std::cos(H[i]); NZ[i] = -std::sin(H[i]); }
  gradeEnd = (Y[N - 1] - Y[N - 2]) / DS;
  gradeStart = (Y[1] - Y[0]) / DS;
  buildBounds();
  raceLat = computeRacingLine();
  centerLat.assign(N, 0);
  // ground profiles (1 m) for the 1D simulations: the snow is planar across the track (banked), so a centreline
  // profile and one 60% out to the left give any line's profile by linear interpolation
  profCenter = buildProfile(centerLat);
  sideLat.resize(N);
  for (size_t i = 0; i < N; i++) sideLat[i] = 0.6 * W[i];
  profSide = buildProfile(sideLat);
  profRace = profileFor(raceLat);
  findJumps();
}

Frame& Track::frame(double s, Frame& out) const {
  const double u = (s - s0) / DS;
  int i;
  double f, ext = 0;
  if (u < 0) { i = 0; f = 0; ext = u * DS; } else if (u >= n - 1) { i = n - 2; f = 1; ext = (u - (n - 1)) * DS; } else { i = int(std::floor(u)); f = u - i; }
  const size_t a = size_t(i), k = a + 1;
  const double h = lerpAngle(H[a], H[k], f);
  out.s = s; out.i = i; out.f = f; out.h = h;
  out.x = X[a] + (X[k] - X[a]) * f + std::sin(h) * ext;
  out.z = Z[a] + (Z[k] - Z[a]) * f + std::cos(h) * ext;
  out.y = Y[a] + (Y[k] - Y[a]) * f + ext * (ext > 0 ? gradeEnd : gradeStart);
  out.w = W[a] + (W[k] - W[a]) * f;
  out.bank = B[a] + (B[k] - B[a]) * f;
  out.k = ext != 0 ? 0 : K[a] + (K[k] - K[a]) * f;
  out.fr = F[a] + (F[k] - F[a]) * f;
  out.nx = std::cos(h); out.nz = -std::sin(h);
  return out;
}

double Track::sample(const std::vector<double>& a, double s) const {
  const double u = clampd((s - s0) / DS, 0, n - 1.000001);
  const int i = int(std::floor(u));
  const double f = u - i;
  return a[size_t(i)] + (a[size_t(std::min(n - 1, i + 1))] - a[size_t(i)]) * f;
}
double Track::sample(const std::vector<float>& a, double s) const {
  const double u = clampd((s - s0) / DS, 0, n - 1.000001);
  const int i = int(std::floor(u));
  const double f = u - i;
  return a[size_t(i)] + (double(a[size_t(std::min(n - 1, i + 1))]) - a[size_t(i)]) * f;
}
double Track::prof(const std::vector<float>& p, double s) const {
  const double u = clampd(s - s0, 0, double(p.size()) - 1.000001);
  const int i = int(std::floor(u));
  const double f = u - i;
  return p[size_t(i)] + (double(p[size_t(i) + 1]) - p[size_t(i)]) * f;
}

// Lateral window [lo, hi] a skier must hold from s over the next `ahead` metres (gates). Stops at the first window
// that conflicts (alternating slalom gates): the nearest one counts.
void Track::window(double s, double ahead, double& l0, double& h0) const {
  double a = sample(lo, s) - 0.5, b = sample(hi, s) + 0.5;
  for (int k = 1; k <= 6; k++) {
    const double q = s + (ahead * k) / 6;
    const double l = std::max(a, sample(lo, q) - 0.5), h = std::min(b, sample(hi, q) + 0.5);
    if (l > h) break;
    a = l; b = h;
  }
  l0 = a; h0 = b;
}

// ground a skier rides at (x, z): terrain or walkable surfaces
double Track::ground(double x, double z, double yHint, double lineY) const {
  const double g = world.groundHeight(x, z, yHint);
  // safety net against geometry overhead (a tunnel roof carved as terrain): stay on the track
  if (g > lineY + 8 && yHint < g - 2) return lineY;
  return g;
}

// lateral bounds of the racing line, narrowed at gates
void Track::buildBounds() {
  const size_t N = size_t(n);
  lo.resize(N); hi.resize(N); C.assign(N, 0);
  const double m = 1.4;
  for (size_t i = 0; i < N; i++) {
    lo[i] = -W[i] + m; hi[i] = W[i] - m;
    if (lo[i] > hi[i]) lo[i] = hi[i] = 0;
  }
  // C = where the line is constrained (gates): every racer commits to the racing line there
  auto limit = [&](double a0, double a1, double a, double b) {
    for (int i = std::max(0, int(std::floor((a0 - s0) / DS))); i <= std::min(n - 1, int(std::ceil((a1 - s0) / DS))); i++) {
      const size_t I = size_t(i);
      const double l = std::max(lo[I], a), h = std::min(hi[I], b);
      if (l <= h) { lo[I] = l; hi[I] = h; } else { lo[I] = hi[I] = clampd((a + b) / 2, -W[I] + EDGE, W[I] - EDGE); }
      C[I] = 1;
    }
  };
  // (the course's kickers and rollers that don't span the track, bots.js probeRamp: the C++ courses have no narrow
  // ramp surfaces to line up for)
  gates.clear();
  Frame fr;
  for (const CourseGate& g : course.gates) {
    if (!std::isfinite(g.x) || !std::isfinite(g.z)) continue;
    const double s = g.s;
    frame(s, fr);
    const double latA = (g.x - fr.x) * fr.nx + (g.z - fr.z) * fr.nz;
    const double side = g.side ? g.side : 1;
    // the second pole sits `side` * width along the course's lateral axis
    const double wd = g.width > 0 ? g.width : 5, bx = g.x + g.nx * side * wd, bz = g.z + g.nz * side * wd;
    const double latB = (bx - fr.x) * fr.nx + (bz - fr.z) * fr.nz;
    // dir: which way the opening runs from the turning pole (left-positive), span: its width
    Gate gate{s, latA, latB, sgn(latB - latA) != 0 ? sgn(latB - latA) : 1.0, std::fabs(latB - latA), std::min(latA, latB), std::max(latA, latB)};
    gates.push_back(gate);
    limit(s - 3, s + 3, gate.lo + 1.1, gate.hi - 1.1);
  }
  std::sort(gates.begin(), gates.end(), [](const Gate& a, const Gate& b) { return a.s < b.s; });
  // spread the commitment ~40 m around each constrained stretch
  for (size_t i = 0; i < N; i++) C[i] = C[i] > 0 ? 1 : 0;
  const std::vector<double> peak = C;
  smooth(C, 10, 2);
  for (size_t i = 0; i < N; i++) C[i] = std::max(peak[i], std::min(1.0, C[i] * 2.5));
}

// Minimum-curvature racing line inside [lo, hi] ("elastic band", coarse to fine): outside on the way in, apex on the
// inside, outside on the way out; chicanes get straightened.
std::vector<double> Track::computeRacingLine() const {
  std::vector<double> lat(size_t(n), 0.0);
  for (int k : {32, 16, 8, 4, 2, 1}) {
    const int iters = k >= 8 ? 24 : 36;
    if (n <= 2 * k) continue;
    for (int it = 0; it < iters; it++) {
      for (int i = k; i < n - k; i++) {
        const size_t a = size_t(i - k), b = size_t(i + k), I = size_t(i);
        const double mx = 0.5 * (X[a] + NX[a] * lat[a] + X[b] + NX[b] * lat[b]);
        const double mz = 0.5 * (Z[a] + NZ[a] * lat[a] + Z[b] + NZ[b] * lat[b]);
        const double t = (mx - X[I]) * NX[I] + (mz - Z[I]) * NZ[I];
        const double v = lat[I] + 0.7 * (t - lat[I]);
        lat[I] = v < lo[I] ? lo[I] : v > hi[I] ? hi[I] : v;
      }
    }
  }
  smooth(lat, 2, 2);
  for (size_t i = 0; i < size_t(n); i++) lat[i] = clampd(lat[i], lo[i], hi[i]);
  return lat;
}

// planned lateral offsets of one skier: blend of racing line and centreline plus a personal lane, committed to the
// racing line through gates
std::vector<double> Track::planFor(double q, double bias) const {
  std::vector<double> out(static_cast<size_t>(n));
  for (size_t i = 0; i < size_t(n); i++) {
    const double c = C[i], qi = q + (1 - q) * c;
    out[i] = clampd(raceLat[i] * qi + bias * (1 - c), lo[i], hi[i]);
  }
  smooth(out, 1, 1);
  for (size_t i = 0; i < size_t(n); i++) out[i] = clampd(out[i], lo[i], hi[i]);
  return out;
}

// signed curvature (left +) and path factor (path length per metre of course) of a planned line
Path Track::pathOf(const std::vector<double>& plan) const {
  const size_t N = size_t(n);
  std::vector<double> PX(N), PZ(N);
  for (size_t i = 0; i < N; i++) { PX[i] = X[i] + NX[i] * plan[i]; PZ[i] = Z[i] + NZ[i] * plan[i]; }
  Path p;
  p.k.assign(N, 0); p.pf.assign(N, 1);
  for (size_t i = 2; i + 2 < N; i++) {
    const double ax = PX[i] - PX[i - 2], az = PZ[i] - PZ[i - 2], bx = PX[i + 2] - PX[i], bz = PZ[i + 2] - PZ[i];
    const double cross = ax * bz - az * bx;
    const double la = std::hypot(ax, az), lb = std::hypot(bx, bz), lc = std::hypot(PX[i + 2] - PX[i - 2], PZ[i + 2] - PZ[i - 2]);
    p.k[i] = la * lb * lc > 1e-9 ? (-2 * cross) / (la * lb * lc) : 0;
  }
  smooth(p.k, 1, 2);
  for (size_t i = 0; i + 1 < N; i++) p.pf[i] = float(std::max(0.3, std::hypot(PX[i + 1] - PX[i], PZ[i + 1] - PZ[i]) / DS));
  p.pf[N - 1] = p.pf[N - 2];
  return p;
}

std::vector<float> Track::profileFor(const std::vector<double>& plan) const {
  const std::vector<float>& a = profCenter;
  const std::vector<float>& b = profSide;
  std::vector<float> out(a.size());
  for (size_t j = 0; j < a.size(); j++) {
    const double s = s0 + double(j);
    const double k = sample(plan, s) / std::max(0.5, sample(sideLat, s));
    out[j] = float(a[j] + (double(b[j]) - a[j]) * k);
  }
  return out;
}

// ground height every 1 m along a planned line
std::vector<float> Track::buildProfile(const std::vector<double>& plan) const {
  const int m = int(std::ceil(finishS + RUNOUT - s0)) + 2;
  std::vector<float> p(static_cast<size_t>(m));
  Frame fr;
  double hint = Y[0] + 1.5;
  for (int j = 0; j < m; j++) {
    const double s = s0 + j;
    frame(s, fr);
    const double lat = sample(plan, s);
    const double g = ground(fr.x + fr.nx * lat, fr.z + fr.nz * lat, hint, fr.y);
    p[size_t(j)] = float(g);
    hint = g + 1.0;
  }
  return p;
}

// take-off points along the racing line (where the ground falls away from a fast skier) and the fastest take-off
// speed that still lands softly (speed check before big lips)
void Track::findJumps() {
  jumps.clear();
  RefRun R;
  referenceParams(*this, 1, 1, R);
  std::vector<Jump> found;
  double airT = 0, launchS = 0;
  bool was = false;
  simulateRun(*this, R.P, [&](const SimState& st, double, bool) {
    if (st.air && !was) { launchS = st.s; airT = 0; }
    if (st.air) airT += CAL_H;
    if (!st.air && was && airT > 0.3) found.push_back({launchS, airT, 0, false});
    was = st.air;
  });
  for (Jump& j : found) {
    double cap = 0;
    bool okSeen = false;
    for (double v = 8; v <= 46; v += 2) {
      const double impact = landingImpact(*this, profRace, R.path.pf, j.s - 1.5, v);
      if (impact <= 9) { okSeen = true; cap = v; } else if (okSeen) break;
    }
    j.hasCap = okSeen && cap < 46;
    j.cap = cap;
  }
  jumps = found;
}

// ---------------------------------------------------------------- 1D simulation
// Speed limit profile of one skier: cornering limit sqrt(aLat * R) (bank and ice aware), jump speed checks, then a
// backward pass so it brakes in time (braking is weaker on steep downhill pitches).
std::vector<float> speedProfile(const Track& tr, const Path& path, const Params& P) {
  const int n = tr.n;
  std::vector<float> vlim(static_cast<size_t>(n)), vmax(static_cast<size_t>(n));
  for (size_t i = 0; i < size_t(n); i++) {
    const double k = std::fabs(path.k[i]);
    double a = P.aLat * gripOf(tr.F[i]);
    const double bank = tr.B[i];
    if (std::fabs(bank) > 0.01 && k > 1e-4) {
      const bool into = (bank > 0 && path.k[i] < 0) || (bank < 0 && path.k[i] > 0);   // + bank leans right
      a += (into ? 0.9 : -0.4) * G * std::tan(std::min(0.6, std::fabs(bank)));
    }
    vlim[i] = float(k > 1e-5 ? std::sqrt(std::max(4.0, a) / k) : 80);
  }
  for (const Track::Jump& j : tr.jumps) {
    if (!j.hasCap) continue;
    const int i = int(std::round((j.s - tr.s0) / DS));
    for (int d = -1; d <= 0; d++) if (i + d >= 0 && i + d < n) vlim[size_t(i + d)] = std::min(vlim[size_t(i + d)], float(j.cap));
  }
  vmax[size_t(n) - 1] = vlim[size_t(n) - 1];
  const std::vector<float>& prof = tr.profCenter;
  for (int i = n - 2; i >= 0; i--) {
    const size_t I = size_t(i);
    const double d = DS * path.pf[I];
    const double s = tr.s0 + i * DS;
    const double drop = (tr.prof(prof, s) - tr.prof(prof, s + DS)) / d;
    const double dec = std::max(1.2, P.brake * gripOf(tr.F[I]) - G * drop);
    vmax[I] = float(std::min(double(vlim[I]), std::sqrt(double(vmax[I + 1]) * vmax[I + 1] + 2 * dec * d)));
  }
  return vmax;
}

double simulateRun(const Track& tr, const Params& P, const std::function<void(const SimState&, double, bool)>& trace) {
  const std::vector<float>& prof = *P.prof;
  const std::vector<float>& pf = P.path->pf;
  SimState st;
  st.s = tr.s0;
  settle(tr, prof, pf, st);
  double t = 0;
  bool tuck = false;
  auto accel = [&](const SimState& q, double cosA) {
    const double fr = tr.sample(tr.F, q.s);
    const double vcap = tr.sample(P.vmax, q.s);
    const double k = std::fabs(tr.sample(P.path->k, q.s));
    tuck = q.v > P.tuckV && q.v * q.v * k < P.tuckA && q.v <= vcap + 0.3;
    // skating / double-poling whenever slower than the push speed (start, flats), like the player
    return longAccel(P, q.v, cosA, fr, tuck, vcap, q.v < P.pushMax, P.dragMul);
  };
  t += P.reaction;
  double prevS = st.s;
  int guard = 0;
  const double fin = tr.finishS;
  while (st.s < fin && guard++ < 400000) {
    prevS = st.s;
    flightStep(tr, prof, pf, st, CAL_H, &accel);
    if (st.air) st.vh *= 1 - AIR * P.cdaUp * P.dragMul * st.vh * CAL_H;
    t += CAL_H;
    if (trace) trace(st, t, tuck);
  }
  // interpolate the crossing within the last step
  const double over = st.s - fin, span = st.s - prevS;
  return guard >= 400000 ? 9999 : t - (span > 1e-6 ? (over / span) * CAL_H : 0);
}

double referenceTime(const Track& tr, double skiSpeed, double skiGrip) {
  RefRun R;
  referenceParams(tr, skiSpeed > 0 ? skiSpeed : 1, skiGrip > 0 ? skiGrip : 1, R);
  return simulateRun(tr, R.P) * PLAYER_PHYS.refScale;
}

// ---------------------------------------------------------------- the field
namespace {
void paramsAt(const Track& tr, const Difficulty& D, const Spec& sp, double cornerK, double dragK, double muK, double reaction, double push, double p, Params& P) {
  P.mu = (PLAYER_PHYS.mu / 1.06) * muK; P.cdaTuck = 0.2; P.cdaUp = 0.42; P.dragMul = dragK / (p * p);
  P.aLat = D.aLat * cornerK * p * p; P.brake = D.brake; P.push = push; P.pushMax = 9.5; P.reaction = reaction;
  P.tuckA = D.tuckA; P.tuckV = D.tuckV; P.prof = &sp.prof; P.path = &sp.path; P.pace = p;
  P.vmax = speedProfile(tr, sp.path, P);
}
} // namespace

// The AI field for a race: names, abilities, racing lines and physics, calibrated so each bot's clean run lands on its
// difficulty target relative to the reference (ideal player) run. The reference skier rides a ski between the
// player's and the 'sport' ski (calibrationSki), so better skis keep GEAR_SHARE of their raw advantage.
Field createField(const Track& tr, int ai, int count, uint32_t seed, double playerSkiSpeed, double playerSkiGrip) {
  const Difficulty& D = difficulty(ai);
  Mulberry32 rnd(seed);
  Field F;
  const double sp = std::isfinite(playerSkiSpeed) && playerSkiSpeed > 0 ? playerSkiSpeed : 1, gr = std::isfinite(playerSkiGrip) && playerSkiGrip > 0 ? playerSkiGrip : 1;
  F.refTime = referenceTime(tr, lerp(REF_SKI_SPEED, sp, GEAR_SHARE), lerp(REF_SKI_GRIP, gr, GEAR_SHARE));
  std::vector<std::string> names(BOT_NAMES, BOT_NAMES + 16);
  for (int i = int(names.size()) - 1; i > 0; i--) { const int j = int(std::floor(rnd.next() * (i + 1))); std::swap(names[size_t(i)], names[size_t(j)]); }
  // `count` target paces spread over the difficulty's range (fieldPaces), fastest first, then shuffled
  std::vector<double> paces;
  if (count == 14) paces.assign(D.pace, D.pace + 14);
  else for (int i = 0; i < count; i++) {
    const double u = count > 1 ? (double(i) / (count - 1)) * 13 : 0;
    const int k = std::min(12, int(std::floor(u)));
    paces.push_back(D.pace[k] + (D.pace[k + 1] - D.pace[k]) * (u - k));
  }
  for (int i = int(paces.size()) - 1; i > 0; i--) { const int j = int(std::floor(rnd.next() * (i + 1))); std::swap(paces[size_t(i)], paces[size_t(j)]); }
  // personal lanes around the racing line: a big field spreads across the piste instead of queueing single file on
  // one line (the lanes close in through gates, see planFor)
  const double spread = count > 6 ? 3.6 : 1.6;
  for (int i = 0; i < count; i++) {
    auto S = std::make_unique<Spec>();
    Spec& spc = *S;
    spc.index = i;
    spc.ab.cornering = rnd.next(); spc.ab.gliding = rnd.next(); spc.ab.start = rnd.next(); spc.ab.consistency = rnd.next();
    if (ai == 2) spc.ab.consistency = 0.35 + spc.ab.consistency * 0.65;   // pros don't fall apart
    if (D.consistency > 0) spc.ab.consistency = D.consistency + spc.ab.consistency * (1 - D.consistency);   // (superhard: nor do the elite)
    spc.lineQ = lerp(D.lineQ[0], D.lineQ[1], rnd.next());
    spc.bias = (rnd.next() - 0.5) * spread;
    spc.plan = tr.planFor(spc.lineQ, spc.bias);
    spc.path = tr.pathOf(spc.plan);
    spc.prof = tr.profileFor(spc.plan);
    spc.name = names[size_t(i) % names.size()];
    spc.targetPace = paces[size_t(i) % paces.size()] * (0.995 + rnd.next() * 0.01);
    spc.mistakeRate = D.mistakes * lerp(1.5, 0.5, spc.ab.consistency);
    spc.severity = D.severity * lerp(1.25, 0.7, spc.ab.consistency);
    spc.seed = uint32_t(std::floor(rnd.next() * 1e9));
    const double cornerK = lerp(0.88, 1.12, spc.ab.cornering), dragK = lerp(1.06, 0.94, spc.ab.gliding), muK = lerp(1.04, 0.96, spc.ab.gliding);
    const double reaction = lerp(D.reaction[1], D.reaction[0], spc.ab.start), push = lerp(D.push[0], D.push[1], spc.ab.start);
    // calibrate the pace so the clean run hits the target time (12 halvings: ~0.02% of the pace)
    const double target = F.refTime * spc.targetPace;
    double lo = 0.3, hi = D.paceMax;   // (an Easy field rides well below its full potential)
    Params P;
    for (int it = 0; it < 12; it++) {
      const double p = (lo + hi) / 2;
      paramsAt(tr, D, spc, cornerK, dragK, muK, reaction, push, p, P);
      const double t = simulateRun(tr, P);
      if (t > target) lo = p; else hi = p;
    }
    paramsAt(tr, D, spc, cornerK, dragK, muK, reaction, push, (lo + hi) / 2, spc.P);
    // the clean run's time at every ~4 m (cleanTab: s, t pairs): the results project unfinished bots from it
    std::vector<double>& tab = spc.cleanTab;
    spc.cleanTime = simulateRun(tr, spc.P, [&](const SimState& st, double t, bool) { if (tab.size() < 2 || st.s - tab[tab.size() - 2] >= 4) { tab.push_back(st.s); tab.push_back(t); } });
    spc.targetTime = target;
    F.specs.push_back(std::move(S));
  }
  return F;
}

// ---------------------------------------------------------------- aistate.js
Style makeRacerStyle(uint32_t seed) {
  Mulberry32 r(seed ? seed : 1);
  auto u = [&](double a, double b) { return a + (b - a) * r.next(); };
  Style S;
  S.seed = seed;
  // relaxed cruiser (0) .. aggressive racer (1)
  S.agg = u(0.35, 1);
  const double agg = S.agg;
  S.crouch = lerp(-0.03, 0.07, agg) + u(-0.02, 0.02);
  S.lean = lerp(0.8, 1.08, agg) * u(0.96, 1.04);
  S.edgeRate = lerp(7, 12, agg);
  S.stance = u(-0.006, 0.026);
  S.armF = lerp(-0.03, 0.055, agg) + u(-0.015, 0.015);
  S.armU = lerp(-0.025, 0.035, agg) + u(-0.015, 0.015);
  S.armO = (1 - agg) * 0.03 + u(-0.01, 0.04);
  S.plantThr = u(1.8, 4.5); S.plantDelay = u(0, 0.09);
  S.plantReach = lerp(0.75, 1.25, agg) * u(0.9, 1.1);
  S.plantDur = lerp(1.15, 0.85, agg) * u(0.92, 1.08);
  S.plantProb = lerp(0.6, 1, agg);
  S.pushEvery = u(0.5, 0.68);
  S.tuckV = lerp(16, 11.5, agg) + u(-0.5, 0.5);
  S.sway = u(0.7, 1.4);
  S.look = u(0.08, 0.22);
  S.plow = 0;
  return S;
}

void AiAnim::init(SkierRig* rig, const Style& st) {
  rig_ = rig; S_ = st;
  if (rig) {   // stance, arm carriage, pole plants, sway (SkierRig.poseSki)
    rig->hasStyle = true;
    rig->style.sway = st.sway; rig->style.stance = st.stance; rig->style.plantDur = st.plantDur; rig->style.plantReach = st.plantReach;
    rig->style.armF = st.armF; rig->style.armU = st.armU; rig->style.armO = st.armO;
  }
  rnd_ = Mulberry32(st.seed * 31u + 11u);
  st_ = RigState();
  st_.mode = RigMode::Ski; st_.crouch = 0.2;
  reset();
}

void AiAnim::reset() {
  edge_ = 0; lean_ = 0; crouch_ = 0.2 + S_.crouch; plow_ = S_.plow; skid_ = 0;
  absorb_ = 0; absorbV_ = 0; hasPrevH_ = false; rate_ = 0; side_ = 0; pending_ = false;
  pushT_ = 0.1; pushAge_ = 9; tuckPoleT_ = 0.8 + rnd_.next(); wasAir_ = false; popT_ = 9;
  t_ = rnd_.next() * 50; look_ = 0; sideslip = 0;
}

const RigState& AiAnim::update(double dt, const Motion& m) {
  const Style& S = S_;
  const double h = clampd(dt, 0, 0.25);
  t_ += h;
  const double sp = std::max(0.0, m.speed);
  const bool air = m.air;
  // lateral acceleration: the caller's
  if (!hasPrevH_ || h <= 0) { prevH_ = m.heading; hasPrevH_ = true; }
  const double rate = h > 0 ? wrapPi(m.heading - prevH_) / h : 0;
  prevH_ = m.heading;
  rate_ += (clampd(rate, -4, 4) - rate_) * ek(h, 10);
  const double aLat = air ? 0 : m.aLat;
  const double brake = air ? 0 : clampd(m.brake, 0, 1);
  // ---- snowplough: none for a racer (the caller's wedge is 0)
  plow_ += (0 - plow_) * ek(h, 6);
  // ---- skid: the caller's (mistakes, finish stops)
  skid_ = m.skidYaw;
  // ---- inclination like the player's, x the style's lean; leaning back against a hockey stop
  double edgeT = air ? 0 : clampd(-std::atan2(aLat, G) * 0.85 * S.lean + m.edgeAdd, -0.95, 0.95);
  const double hockey = clampd(std::fabs(skid_) / 1.05, 0, 1);
  if (hockey > 0.05) edgeT += (-sgn(skid_) * 0.45 - edgeT) * hockey;
  edgeT *= 1 - 0.55 * plow_;
  edge_ += (edgeT - edge_) * ek(h, S.edgeRate);
  lean_ = clampd(edge_ / 0.8, -1, 1);
  // ---- crouch (the player's ranges, see player.js animateSki)
  const three::V3& n = m.normal;
  const double pitch = std::hypot(n.x, n.z) / std::max(0.3, n.y);
  const bool tuck = !air && !m.waiting && !m.stopped && m.tuck;
  double crouchT = 0.16 + S.crouch + std::fabs(edge_) * 0.13 + 0.035 * smoothst(8, 20, sp) + 0.03 * smoothst(0.2, 0.55, pitch);
  if (tuck) crouchT = 0.21 + S.crouch * 0.5;
  crouchT = lerp(crouchT, 0.3 + S.crouch * 0.5, brake);
  if (air && !wasAir_) popT_ = 0;   // the lip: legs extend
  popT_ += h;
  if (air) crouchT = 0.32;
  crouchT += m.pre;
  const bool extend = popT_ < 0.16;
  if (extend) crouchT = -0.15;
  if (m.waiting) crouchT = m.waiting == 2 ? 0.46 + S.crouch * 0.5 : 0.24 + S.crouch * 0.5;
  else if (m.stopped) crouchT = 0.13 + S.crouch * 0.3;
  // a double-pole stroke folds the body a little as the arms push
  pushAge_ += h;
  const double pushEnv = pushAge_ < 0.55 ? std::sin((pushAge_ / 0.55) * PI) : 0;
  crouchT += 0.09 * pushEnv * (S.agg * 0.6 + 0.4);
  crouch_ += (crouchT - crouch_) * ek(h, extend ? 26 : 7);
  // landings: the legs soak up the impact (the player's spring, sub-stepped for reduced-rate solves)
  if (m.land > 0) absorbV_ += std::min(14.0, m.land * 1.3);
  {
    const int nS = std::max(1, int(std::ceil(h * 90)));
    const double hs = h / nS;
    for (int k = 0; k < nS; k++) {
      absorbV_ += (-60 * absorb_ - 15.5 * absorbV_) * hs;
      absorb_ = clampd(absorb_ + absorbV_ * hs, 0, 0.8);
      if (absorb_ == 0 && absorbV_ < 0) absorbV_ = 0;
    }
  }
  // ---- poles
  if (rig_ && rig_->hasPoles()) {
    const three::V3 f(std::sin(m.heading), 0, std::cos(m.heading)), rt = glm::cross(f, three::UP);
    // a plant at each new turn: the inside pole (turning left -> left pole), as the new turn's edges bite
    const double thr = S.plantThr;
    const int side = std::fabs(aLat) > thr ? int(sgn(aLat)) : std::fabs(aLat) < thr * 0.45 ? 0 : side_;
    if (side != 0 && side != side_ && sp > 3 && !air && !tuck && std::fabs(skid_) < 0.3 && !m.waiting && rnd_.next() < S.plantProb) {
      pending_ = true; pendingSide_ = side; pendingT_ = S.plantDelay;
    }
    side_ = side;
    if (pending_ && (pendingT_ -= h) <= 0) {
      if (!air) rig_->startPolePlant(pendingSide_ > 0 ? 0 : 1, f, rt);
      pending_ = false;
    }
    // double-pole pushes: getting going (start, flats, after a stop), and now and then in a slow tuck
    if (m.push && !air && !m.waiting && sp < 9.5) {
      pushT_ -= h;
      if (pushT_ <= 0) {
        pushT_ = S.pushEvery * (1 + 0.04 * sp);
        rig_->startPolePlant(0, f, rt); rig_->startPolePlant(1, f, rt);
        pushAge_ = 0;
      }
    } else pushT_ = std::min(pushT_, 0.12);   // the first push comes right away
    if (tuck && !air && sp < 15 && brake < 0.05) {
      tuckPoleT_ -= h;
      if (tuckPoleT_ <= 0) {
        tuckPoleT_ = 1.6 + rnd_.next() * 1.4;
        rig_->startPolePlant(0, f, rt); rig_->startPolePlant(1, f, rt);
        pushAge_ = 0;
      }
    } else tuckPoleT_ = 0.6 + rnd_.next() * 0.8;
  }
  // ---- head: a little into the turn; waiting in a start area it looks about now and then
  double lookT = clampd((aLat / std::max(sp, 4.0)) * S.look * 4, -0.3, 0.3);
  if (m.waiting == 1) lookT = 0.35 * std::sin(t_ * 0.37) * smoothst(0.2, 0.7, std::fabs(std::sin(t_ * 0.13)));
  look_ += (lookT - look_) * ek(h, 3);
  wasAir_ = air;
  // snow FX: skidding, the wedge, carving
  sideslip = std::max({std::fabs(skid_) * 0.9, plow_ * 0.4, 0.04 + std::fabs(lean_) * 0.08});

  st_.mode = RigMode::Ski;
  st_.heading = m.heading;
  st_.speed = sp;
  st_.crouch = clampd(crouch_ + absorb_, -0.2, 1.1);
  st_.hasEdge = true; st_.edge = edge_;
  st_.lean = lean_;
  st_.tuck = tuck;
  st_.plow = plow_;
  st_.skid = skid_;
  st_.hasNormal = true; st_.normal = air ? three::UP : n;
  st_.air = air;
  st_.lookYaw = look_;
  return st_;
}

// ---------------------------------------------------------------- live AI racer
BotRacer::BotRacer(const Spec& sp, const Track& tr) : spec(sp), track(tr), name(sp.name), rnd_(sp.seed) {
  style_ = makeRacerStyle(sp.seed);
  reset(0, 0);
}

// put the bot on its grid slot (s, lateral left-positive) before the start
void BotRacer::reset(double s_, double lat_, int attempt) {
  const Track& tr = track;
  rnd_ = Mulberry32(spec.seed + uint32_t(attempt) * 7919u);   // fresh mistakes on every attempt
  s = s_; lat = lat_; latVel = 0; v = 0; vh = 0; vy = 0; tanA = 0;
  t = 0; started = false; running = false;
  air = false; airT = 0; finished = false; finishTime = -1; stopped = false;
  laneOff = lat - tr.sample(spec.plan, s);
  hasPass = false; passTarget = nullptr; passT = 0; repel = 0; followCap = INF; draft = 0;
  mistake = Mistake(); mistakeOff = 0; mistakes = 0; rb = 1; rbTarget = 1;
  tuck = false; tuckHold = 0; lean = 0; edge = 0; crouchImp = 0; wobble = 0; wob = 0; pushing = false; braking = false;
  skidYaw = 0; skid = 0; sRate = 0; hasPrevTravel = false; aLat = 0;
  acc = 0; animAcc = 1; normalT = 0;
  parkLat = 0;
  landPending = 0; landImpact = 0; wasAirF = false;
  cpNext = 1; splits.clear(); parked = false; parkRank = 0;
  tr.frame(s, fr_);
  const double x = fr_.x + fr_.nx * lat, z = fr_.z + fr_.nz * lat;
  y = tr.ground(x, z, fr_.y + 2, fr_.y);
  travel = fr_.h;
  heading = fr_.h;
  pos = dvec3(x, y, z);
  vel = dvec3(0);
  if (rigOk) { anim_.init(&R.rig, style_); R.rig.rootPos = three::V3(pos); R.rig.snapPose(); R.posed = false; }
}

// shift the racer by a world-space offset (contact resolution); converted into course coordinates
void BotRacer::nudge(double dx, double dz) {
  track.frame(s, fr2_);
  s += dx * std::sin(fr2_.h) + dz * std::cos(fr2_.h);
  lat += dx * fr2_.nx + dz * fr2_.nz;
  const double w = std::max(0.0, track.halfWidth(s) - EDGE);
  lat = clampd(lat, -w, w);
  pos.x += dx; pos.z += dz;
}

// shoulder contact with another racer: shift sideways by `dlat` (left +, kept inside the track) and, for the one
// behind, give up a little speed. The world position follows at once.
void BotRacer::bump(double dlat, double dv) {
  track.frame(s, fr2_);
  const double w = std::max(0.0, fr2_.w - EDGE);
  const double l = clampd(lat + dlat, -w, w);
  pos.x += fr2_.nx * (l - lat); pos.z += fr2_.nz * (l - lat);
  lat = l;
  if (dv > 0) v = std::max(finished ? 0.0 : V_MIN, v - dv);
}

// ---- race craft, once per frame: traffic, overtaking, side-by-side spacing, mistakes, rubber band
void BotRacer::decide(double dt, const std::vector<Racer>& racers) {
  if (!running) { followCap = INF; repel = 0; return; }
  if (finished) { decideFinished(racers); return; }
  const Track& tr = track;
  // grid lanes merge onto the racing lines over the first seconds (slower in a big field: it strings out along the
  // course before everyone converges on the line)
  if (started) laneOff *= std::exp(-dt / (racers.size() > 8 ? 6.0 : 3.5));
  // traffic ahead in my lane
  const Racer* block = nullptr;
  double bestDs = 14;
  draft = 0;
  for (const Racer& o : racers) {
    if (o.self == this) continue;
    const double ds = o.s - s, dl = std::fabs(o.lat - lat);
    if (ds > 0.4 && ds < bestDs && dl < 1.5) { block = &o; bestDs = ds; }
    if (ds > 1.5 && ds < 9 && dl < 1.0) draft = std::max(draft, 1 - (ds - 1.5) / 7.5);
  }
  const double w = std::max(0.0, tr.halfWidth(s + bestDs) - EDGE);
  // no overtaking through slalom gates: hold the line and wait
  const bool committed = tr.sample(tr.C, s + v * 0.8) > 0.3;
  if (hasPass) {
    // keep the passing lane until clear ahead of the overtaken racer
    passT += dt;
    const Racer* o = nullptr;
    for (const Racer& q : racers) if (q.self == passTarget) o = &q;
    if (!o || committed || o->s < s - 3.5 || passT > 6 || std::fabs(o->lat - passLat) > 2.6) { hasPass = false; passTarget = nullptr; }
  }
  followCap = INF;
  const double pace = std::min(tr.sample(spec.P.vmax, s) * rb, v + 2.5);
  if (block && !hasPass && pace > block->v + 0.3 && !air && !committed) {
    const double plan = tr.sample(spec.plan, s + 10) + laneOff;
    const double gap = 1.95;
    double wlo, whi;
    tr.window(s, bestDs + v * 1.5, wlo, whi);
    double best = 0;
    bool any = false;
    for (double l : {block->lat + gap, block->lat - gap}) {
      if (!(std::fabs(l) <= w && l >= wlo && l <= whi && laneFree(racers, this, block, s, l, bestDs))) continue;
      if (!any || std::fabs(l - plan) < std::fabs(best - plan)) best = l;
      any = true;
    }
    if (any) { hasPass = true; passLat = best; passTarget = block->self; passT = 0; }
    else if (bestDs < 6) followCap = block->v + 0.15 + (bestDs - 3) * 0.3;   // tuck in behind and wait for a gap
  } else if (block && committed && bestDs < 6) {
    followCap = block->v + 0.15 + (bestDs - 3) * 0.3;
  }
  // never side-by-side closer than ~1.25 m
  double rep = 0;
  for (const Racer& o : racers) {
    if (o.self == this) continue;
    const double ds = std::fabs(o.s - s), dl = lat - o.lat;
    if (ds < 2.8 && std::fabs(dl) < 1.25) rep += (dl >= 0 ? 1 : -1) * (1.25 - std::fabs(dl)) * 1.6;
  }
  repel = clampd(rep, -2, 2);
  // mistakes: small, rarer for consistent racers, never in the air or in the last stretch
  if (mistake.on) {
    mistake.t += dt;
    if (mistake.t > mistake.dur) mistake.on = false;
  } else if (started && t > 3 && !air && s < tr.finishS - 60 && rnd_.next() < dt * spec.mistakeRate) {
    startMistake();
  }
  mistakeOff = 0;
  if (mistake.on && mistake.type == 2) {
    const double env = std::sin(std::min(1.0, mistake.t / mistake.dur) * PI);
    const double k = tr.sample(spec.path.k, s + 8);
    mistakeOff = -(k != 0 ? sgn(k) : 1.0) * mistake.mag * env;   // drift to the outside of the turn
  }
  // mild rubber band (set by the session): +-3% so races stay close
  rb += (clampd(rbTarget, 0.97, 1.03) - rb) * std::min(1.0, dt / 2);
}

// After the line: no racing, but keep clear of everyone in the finish area (incl. the player). Racers ahead in my
// lane push me aside early enough for a stopping skier to slide past them.
void BotRacer::decideFinished(const std::vector<Racer>& racers) {
  followCap = INF;
  hasPass = false; passTarget = nullptr;
  double rep = 0;
  const double reach = 2.8 + v * 0.6;
  for (const Racer& o : racers) {
    if (o.self == this) continue;
    const double ds = o.s - s, dl = lat - o.lat;
    if (ds > -2.8 && ds < reach && std::fabs(dl) < 1.6) rep += (dl >= 0 ? 1 : -1) * (1.6 - std::fabs(dl)) * 1.8;
  }
  repel = clampd(rep, -2.5, 2.5);
}

void BotRacer::startMistake() {
  const double r = rnd_.next(), sev = spec.severity;
  const double k = std::fabs(track.sample(spec.path.k, s + 10));
  int type = r < 0.4 ? 0 : r < 0.7 ? 1 : 2;
  if (type == 2 && k < 1.0 / 400) type = 1;
  const double k2 = 0.55 + 0.45 * std::min(1.0, sev);   // milder, shorter mistakes for the better racers
  const double dur = (type == 0 ? 0.45 + rnd_.next() * 0.5 : type == 2 ? 1.3 + rnd_.next() : 1.2 + rnd_.next() * 1.4) * k2;
  mistake.type = type; mistake.t = 0; mistake.dur = dur; mistake.on = true;
  mistake.mag = (type == 2 ? 1.3 + rnd_.next() * 1.2 : 1) * sev;
  mistake.side = rnd_.next() < 0.5 ? -1 : 1;
  mistakes++;
}

void BotRacer::update(double dt, const std::vector<Racer>& racers) {
  decide(dt, racers);
  acc += dt;
  int k = 0;
  while (acc >= SIM_H && k < 14) { step(SIM_H); acc -= SIM_H; k++; }
  if (k >= 14) acc = 0;
  // derived world state
  track.frame(s, fr_);
  const double nx = fr_.x + fr_.nx * lat, nz = fr_.z + fr_.nz * lat;
  if (dt > 0) vel = dvec3((nx - pos.x) / dt, (y - pos.y) / dt, (nz - pos.z) / dt);
  if (glm::dot(vel, vel) > 70.0 * 70.0) vel = dvec3(0);
  pos = dvec3(nx, y, nz);
}

// ---- one fixed physics step
void BotRacer::step(double h) {
  const Track& tr = track;
  const Params& P = spec.P;
  if (!running) return;
  t += h;
  if (!started) {
    if (t < P.reaction) return;
    started = true;
  }
  Frame& fr = fr_;
  tr.frame(s, fr);
  const double wE = std::max(0.0, fr.w - EDGE);
  const bool fin = finished;
  // ---- lateral: follow the plan (feed-forward + correction), passing lanes, spacing, mistakes
  if (!air) {
    double target, ff = 0;
    if (fin) target = parkLat;
    else if (hasPass) target = passLat;
    else {
      const double sa = s + v * 0.08;   // a touch of anticipation for the steering lag
      ff = ((tr.sample(spec.plan, sa + 1) - tr.sample(spec.plan, sa - 1)) / 2) * sRate;
      target = tr.sample(spec.plan, sa) + laneOff + mistakeOff;
    }
    target += repel;
    if (!fin) {
      double wlo, whi;
      tr.window(s, std::max(6.0, v * 1.2), wlo, whi);
      target = clampd(target, wlo, whi);
    }
    target = clampd(target, -wE, wE);
    const double want = ff + (target - lat) * (fin ? 0.8 : 1.7);
    // lateral agility: up to ~27 degrees off the fall line, as quick as the edges allow
    const double maxV = fin ? std::min(4.0, v * 0.45) : std::min(12.0, 0.5 * v + 0.5);
    const double aMax = std::max(9.0, P.aLat * gripOf(fr.fr) * 1.15) * h;
    latVel = clampd(latVel + clampd(want - latVel, -aMax, aMax), -maxV, maxV);
  }
  const double pfac = std::max(0.3, 1 - fr.k * lat);
  if (!air) {
    // ---- on the snow
    const double vF = std::sqrt(std::max(0.0001, v * v - latVel * latVel));
    const double cosA = 1 / std::sqrt(1 + tanA * tanA);
    double vcap = std::min(tr.sample(P.vmax, s) * rb, followCap);
    double extra = 0;
    const Mistake& m = mistake;
    if (m.on && m.type == 0) extra = 2.6 * m.mag;
    else if (m.on && m.type == 2) extra = 0.7 * m.mag;
    if (fin) {
      // hockey stop in the finish area; glide on while still far from the parking lane (turn out first, then stop),
      // hard stop right before the closing boards
      vcap = 0;
      const bool far = std::fabs(parkLat - lat) > 1.2 && s < tr.lineEnd - 45;
      extra = s > tr.lineEnd - 8 ? 12 : far ? 2.5 : v > 14 ? 6 : 8;
    }
    const double k = std::fabs(tr.sample(spec.path.k, s));
    const bool tuckWant = !fin && v > P.tuckV && v * v * k < P.tuckA && v <= vcap + 0.3 && !(m.on && (m.type == 1 || m.type == 0));
    tuckHold -= h;
    if (tuckWant != tuck && tuckHold <= 0) { tuck = tuckWant; tuckHold = 0.7; }
    const bool push = !fin && v < P.pushMax;   // skate / double-pole out of the start and across flats
    pushing = push;
    const double dragMul = (P.dragMul / (rb * rb)) * (1 - 0.1 * draft);
    const double a = (fin ? -P.mu * G : longAccel(P, v, cosA, fr.fr, tuck, vcap, push, dragMul)) - extra;
    braking = !fin && v > vcap + 0.2;
    const double dh = vF * cosA * h;
    sRate = dh / h / pfac;
    s += dh / pfac;
    lat += latVel * h;
    if (std::fabs(lat) > wE) { lat = clampd(lat, -wE, wE); latVel *= 0.3; }
    tr.frame(s, fr);
    const double x = fr.x + fr.nx * lat, z = fr.z + fr.nz * lat;
    const double gN = tr.ground(x, z, y + 0.5, fr.y);
    const double yb = y + vy * h - 0.5 * G * h * h;
    bool launch = false;
    if (gN < yb - 0.5 * SHARP * h * h && v > 6) {
      // the snow falls away from the ballistic path: real edge (lip, cliff, big crest) or absorbable?
      const double look = vF * cosA * LOOK_T;
      tr.frame(s + (look - dh) / pfac, fr2_);
      const double latL = clampd(lat + latVel * (LOOK_T - h), -wE, wE);
      const double gF = tr.ground(fr2_.x + fr2_.nx * latL, fr2_.z + fr2_.nz * latL, y + 0.5, fr2_.y);
      launch = gF < y + vy * LOOK_T - 0.5 * G * LOOK_T * LOOK_T - ABSORB_H;
    }
    if (launch) {
      // take off
      air = true; airT = 0; vh = vF * cosA; vy -= G * h; y = yb;
      crouchImp = std::max(crouchImp, -0.15);   // extend (pop) at the lip
    } else {
      const double dy = gN - y;
      tanA = dy / std::max(1e-4, dh);
      const double v2 = v * v - 2 * G * dy;
      v = v2 > 0 ? std::sqrt(v2) : 0;
      v += a * h;
      v = fin ? std::max(0.0, v) : std::max(V_MIN, v);
      vy = dy / h;
      y = gN;
    }
  } else {
    // ---- in the air: ballistic with drag, lateral drift kept
    airT += h;
    const double spd = std::hypot(vh, vy);
    const double drag = AIR * P.cdaUp * P.dragMul * spd;
    vh -= drag * vh * h;
    vy -= (G + drag * vy) * h;
    y += vy * h;
    const double ds = (vh * h) / pfac;
    s += ds;
    sRate = ds / h;
    lat = clampd(lat + latVel * h, -wE, wE);
    tr.frame(s, fr);
    const double x = fr.x + fr.nx * lat, z = fr.z + fr.nz * lat;
    const double gN = tr.ground(x, z, y, fr.y);
    if (y <= gN) {
      // landing: keep the speed along the slope (measured along the flight path), absorb the rest
      const double dl = latVel * (0.4 / std::max(2.0, vh));
      tr.frame(s - 0.4 / pfac, fr2_);
      const double xa = fr2_.x + fr2_.nx * (lat - dl), za = fr2_.z + fr2_.nz * (lat - dl);
      const double ga = tr.ground(xa, za, gN + 0.5, fr2_.y);
      tr.frame(s + 0.4 / pfac, fr2_);
      const double xb = fr2_.x + fr2_.nx * (lat + dl), zb = fr2_.z + fr2_.nz * (lat + dl);
      const double gb = tr.ground(xb, zb, gN + 0.5, fr2_.y);
      const double tanB = (gb - ga) / std::max(0.2, std::hypot(xb - xa, zb - za));
      const double cb = 1 / std::sqrt(1 + tanB * tanB), sb = tanB * cb;
      const double along = vh * cb + vy * sb, perp = -vh * sb + vy * cb;
      const double impact = std::max(0.0, -perp);
      v = std::max(V_MIN, std::hypot(std::max(0.0, along), latVel)) * (1 - landingLoss(impact));
      y = gN; vy = v * sb; tanA = tanB; air = false;
      onLand(impact);
    }
  }
  // ---- finish line
  if (!fin && s >= tr.finishS) {
    const double over = s - tr.finishS;
    finishTime = t - (sRate > 0.5 ? over / sRate : 0);
    finished = true;
    mistake.on = false;
  }
  if (fin && v < 0.05) { v = 0; stopped = true; }
}

void BotRacer::onLand(double impact) {
  landImpact = impact;
  crouchImp = std::max(crouchImp, clampd(impact / 9, 0.12, 0.6));
  // sketchy landings for the less consistent racers
  const double sev = spec.severity;
  if (impact > 4 && rnd_.next() < clampd(0.08 + (impact - 4) * 0.04, 0, 0.5) * sev) {
    v *= 1 - 0.05 * sev;
    wobble = 0.8;
  }
}

// Lateral lane to stop in after the finish. Finishers spread out to the sides of the finish area, clear of the middle
// (where later finishers ski out) and of every lane in `avoid` (the player's ski-out lane, lanes of racers already
// parked), preferring a lane close to where they cross.
void BotRacer::setParking(int rank, const std::vector<double>& avoid, bool hasCross, double cross) {
  const Track& tr = track;
  const double w = std::max(0.0, std::min(tr.halfWidth(tr.finishS + 30), tr.halfWidth(tr.finishS + 50)) - 1.5);
  const double side = rank % 2 ? 1 : -1;
  double best = 0, bestScore = -INF;
  for (int k = 0; k < 6; k++) {
    const double l = 3.6 + k * 2.4;
    if (l > w && k > 0) break;
    for (double sd : {side, -side}) {
      const double lane = clampd(sd * l, -w, w);
      double dmin = 9;
      for (double a : avoid) if (std::isfinite(a)) dmin = std::min(dmin, std::fabs(lane - a));
      double score = 10 * std::min(dmin, 2.6) + (std::fabs(lane) >= 5.5 ? 4 : 0) - 0.35 * std::fabs(lane - lat) + (sd == side ? 0.2 : 0);
      if (hasCross && (lat - cross) * (lane - cross) < 0) score -= 12;   // would cut across
      if (score > bestScore) { bestScore = score; best = lane; }
    }
  }
  parkLat = best;
}

// ---- animation: the skier rig posed from this racer's own motion
void BotRacer::animate(double dt, double viewD, bool countdown, bool show, double stepT, bool fxOn) {
  fx.due = false;
  viewDist = viewD;
  // travel direction & lateral acceleration (lean)
  const Frame& fr = fr_;
  const double trv = fr.h + std::atan2(latVel, std::max(0.5, sRate * std::max(0.3, 1 - fr.k * lat)));
  if (!hasPrevTravel || dt <= 0) { prevTravel = trv; hasPrevTravel = true; }
  const double rate = dt > 0 ? wrap(trv - prevTravel) / dt : 0;
  prevTravel = trv;
  const bool visAir = air && airT > 0.1;
  const double aLatT = started && !visAir ? clampd(rate * v, -40, 40) : 0;
  aLat += (aLatT - aLat) * std::min(1.0, dt * 9);
  // skid / hockey-stop yaw: skis and legs turned across the travel direction (the rig's `skid`)
  double skidT = 0;
  if (mistake.on && mistake.type == 0) skidT = 0.45 * mistake.side * std::sin(std::min(1.0, mistake.t / mistake.dur) * PI);
  if (finished && v < 16) skidT = (parkLat >= 0 ? 1 : -1) * clampd((16 - v) / 9, 0, 1) * 1.05;
  if (braking) skidT += clampd(aLat / 30, -0.25, 0.25);
  skidYaw += (skidT - skidYaw) * std::min(1.0, dt * 7);
  // inclination like the player: -atan(aLat / g) * 0.9, leaning back against a hockey stop
  wobble = std::max(0.0, wobble - dt);
  wob = wobble > 0 ? std::sin(t * 19) * 0.25 * wobble : 0;
  double edgeT = visAir ? 0 : clampd(-std::atan2(aLat, G) * 0.9 + wob, -0.95, 0.95);
  const double hockey = clampd(std::fabs(skidYaw) / 1.05, 0, 1);
  if (hockey > 0.05) edgeT += (-sgn(skidYaw) * 0.45 - edgeT) * hockey;
  edge += (edgeT - edge) * std::min(1.0, dt * 8);
  lean = clampd(edge / 0.8, -1, 1);
  heading = trv;
  travel = trv;
  skid = clampd(std::fabs(skidYaw) * 1.2 + (braking ? 0.35 : 0), 0, 1);
  crouchImp += (0 - crouchImp) * std::min(1.0, dt * 3);
  // a landing since the last frame: the legs soak it up at the next pose solve
  if (wasAirF && !air) landPending = std::max(landPending, landImpact > 0 ? landImpact : 3.0);
  wasAirF = air;
  if (!rigOk) return;
  visible = show;
  if (!show) { animAcc = 1; return; }   // solve a fresh pose the moment it shows again
  // level of detail: the pose is solved at full rate nearby, at a lower rate further out; in between, the posed
  // skier (body, skis and poles) is carried along rigidly every frame
  animAcc += dt;
  SkierRig& rig = R.rig;
  if (animAcc < stepT && R.posed) {
    // (bots.js carryPose: the body follows its root; skis and poles live in world space, shifted with it)
    const three::V3 d = three::V3(pos) - rig.rootPos;
    rig.rootPos = three::V3(pos);
    for (int k = 0; k < 2; k++) { rig.skis[k].p += d; rig.poles[k].p += d; }
    return;
  }
  const double adt = animAcc;
  animAcc = 0;
  // compression before a lip
  double pre = 0;
  for (const Track::Jump& j : track.jumps) {
    const double tt = (j.s - s) / std::max(4.0, v);
    if (tt > 0 && tt < 0.5) pre = std::max(pre, 0.28 * (1 - tt / 0.5));
  }
  if (visAir) normal = three::UP;
  else if (viewD < 160 || (normalT -= adt) <= 0) {
    normal = three::normalize(three::V3(track.world.groundNormal(pos.x, pos.z, y + 0.5)));
    normalT = 0.4;
  }
  Motion mo;
  mo.heading = heading; mo.speed = v; mo.normal = normal; mo.air = visAir;
  mo.aLat = started ? aLat : 0; mo.edgeAdd = wob; mo.skidYaw = skidYaw;
  mo.brake = braking || (finished && v > 1) ? 1 : 0;
  mo.tuck = tuck && started;
  mo.push = pushing && started && !finished;
  mo.pre = pre;
  mo.land = landPending; landPending = 0;
  mo.waiting = !running || !started ? (countdown ? 2 : 1) : 0;
  mo.stopped = finished && stopped;
  mo.camDist = viewD;
  rig.rootPos = three::V3(pos);
  const RigState& ast = anim_.update(adt, mo);
  recCrouch = ast.crouch; recTuck = ast.tuck;   // (bots.js this.anim = A.st: the replay records its crouch / tuck)
  rig.update(std::min(adt, 0.25), ast);
  rig.fx.clear();
  R.pose_();
  // ski tracks + spray (throttled to ~30 Hz so the shared trail buffer isn't flooded)
  if (fxOn && viewD < 140) {
    fxAcc += adt;
    if (fxAcc >= 1.0 / 30) {
      fx = {true, !visAir && started, v, std::max(0.04 + std::fabs(lean) * 0.08 + skid * 0.55, anim_.sideslip), lean, fxAcc};
      fxAcc = 0;
    }
  }
}

// projected finish time for the results if the bot is still racing: the clean run's time from here to the line
double BotRacer::projectFinish() const {
  if (finished) return finishTime;
  const std::vector<double>& tab = spec.cleanTab;
  const double T = spec.cleanTime;
  if (tab.size() >= 4) {
    if (!started) return T;
    size_t lo = 0, hi = tab.size() / 2 - 1;
    if (s <= tab[0]) return t + (T - tab[1]);
    if (s >= tab[hi * 2]) return t + std::max(0.0, T - tab[hi * 2 + 1]);
    while (hi - lo > 1) { const size_t m = (lo + hi) >> 1; if (tab[m * 2] <= s) lo = m; else hi = m; }
    const double sa = tab[lo * 2], sb = tab[hi * 2], k = sb > sa ? (s - sa) / (sb - sa) : 0;
    return t + std::max(0.0, T - (tab[lo * 2 + 1] + (tab[hi * 2 + 1] - tab[lo * 2 + 1]) * k));
  }
  return t + (track.finishS - s) / std::max(4.0, v);
}

} // namespace racebots
} // namespace sl
