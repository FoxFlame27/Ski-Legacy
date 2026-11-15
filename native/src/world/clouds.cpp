// atmosphere.js's cloud scenery, the CPU side (see clouds.h).
#include "world/clouds.h"
#include "core/noise.h"
#include "engine/cloud_shapes.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <numeric>

namespace sl {
namespace {
constexpr double BANK_CELL = 1500, BANK_R = 16500;    // anchored clouds: placement grid + reach
constexpr double RING_CELL = 2500, RING_R = 16500;    // the cloud sea round the backdrop's peaks
constexpr double DRIFT_CELL = 3200, DRIFT_R = 17000;  // free-drifting cumulus above the peaks
constexpr int MAX_RECORDS = 900, MAX_CARDS = 420;
constexpr double RESORT_X = 0, RESORT_Z = -1150, RESORT_R = 2300;   // the village + pistes stay clear of cloud banks
constexpr int K_SEA = 0, K_BANK = 1, K_WISP = 2, K_HIGH = 3, K_RING = 4;
constexpr float NaNf = std::numeric_limits<float>::quiet_NaN();
inline int modN(int a, int n) { int m = a % n; return m < 0 ? m + n : m; }
} // namespace

float CloudScenery::tmapGet(int I, int J) const {
  if (tmap_.empty()) return NaNf;
  const int N = TMAP_N, t = modN(J, N) * N + modN(I, N);
  return tmapKey_[size_t(t) * 2] == I && tmapKey_[size_t(t) * 2 + 1] == J ? tmap_[size_t(t)] : NaNf;
}

double CloudScenery::heightAt(double x, double z) const {
  const double fx = x / TMAP_CELL, fz = z / TMAP_CELL;
  const int I = int(std::floor(fx)), J = int(std::floor(fz));
  const double tx = fx - I, tz = fz - J;
  const double a = tmapGet(I, J), b = tmapGet(I + 1, J), c = tmapGet(I, J + 1), d = tmapGet(I + 1, J + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

// 128 x 128 cells of 300 m round the camera, world cell (I, J) at texel (I mod N, J mod N) (atmosphere.js
// fillTerrainMap; here the whole window on a worker thread whenever the camera has moved 8 cells on)
void CloudScenery::startMap(const World& world, int ci, int cj) {
  const World* w = &world;
  job_ = std::async(std::launch::async, [w, ci, cj]() {
    const int N = TMAP_N, x0 = ci - N / 2, z0 = cj - N / 2;
    MapJob m{ci, cj, std::vector<float>(size_t(N) * N), std::vector<int32_t>(size_t(N) * N * 2)};
    for (int t = 0; t < N * N; t++) {
      const int ti = t % N, tj = t / N;
      const int I = x0 + modN(ti - x0, N), J = z0 + modN(tj - z0, N);
      m.h[size_t(t)] = float(w->height(I * TMAP_CELL, J * TMAP_CELL, TMAP_CELL));
      m.key[size_t(t) * 2] = I; m.key[size_t(t) * 2 + 1] = J;
    }
    return m;
  });
}

// What cloud lives in grid cell (ci, cj)? A cloud-sea patch on a valley floor, a cumulus bank leaning on a flank, or
// an orographic wisp clinging to a ridge. False while the map has no data there.
bool CloudScenery::analyseCell(int ci, int cj, double x, double z, float out[12]) const {
  const double hc = heightAt(x, z);
  if (hc != hc) return false;
  double lo = hc, hi = hc, aLo = 0;
  const double a0 = hash2(ci, cj, 503) * 6.28;
  for (int k = 0; k < 6; k++) {
    const double a = a0 + k * 1.047, h = heightAt(x + std::cos(a) * 1400, z + std::sin(a) * 1400);
    if (h != h) return false;
    if (h < lo) { lo = h; aLo = a; }
    if (h > hi) hi = h;
  }
  const double rel = (hc - lo) / std::max(60.0, hi - lo);   // 0 valley floor .. 1 ridge top
  const double r1 = hash2(ci, cj, 504), r3 = hash2(ci, cj, 506);
  int kind, cell;
  double w, shift;
  if (rel < 0.38) { kind = K_SEA; cell = r3 < 0.42 ? 5 : r3 < 0.84 ? 6 : 2; w = 2600 + r1 * 1400; shift = 0.3; }
  else if (rel < 0.72) { kind = K_BANK; cell = int(std::floor(r3 * 4.99)); w = 1900 + r1 * 1300; shift = 0.62; }
  else { kind = K_WISP; cell = 7; w = 1500 + r1 * 1100; shift = 0.45; }
  // stand the card over lower ground toward the valley: it fills the valley and leans on the flank
  const double px = x + std::cos(aLo) * 1400 * shift, pz = z + std::sin(aLo) * 1400 * shift;
  double hp = heightAt(px, pz);
  if (hp != hp) hp = hc;
  // wisps hang in front of the face, between the valley and the crest
  const double y = kind == K_WISP ? lerp(hp, hc, 0.55) : lo;
  const float r[12] = {float(px), float(pz), float(kind), float(cell), hash2(ci, cj, 508) < 0.5 ? 1.f : -1.f, float(w), float(hash2(ci, cj, 507)), float(y), float(hp), float(hi), float(r1), 0};
  std::copy(r, r + 12, out);
  return true;
}

void CloudScenery::placeBanks(double cx, double cz) {
  const double G = BANK_CELL;
  const int R = int(std::ceil(BANK_R / G)), ci0 = int(std::floor(cx / G)), cj0 = int(std::floor(cz / G));
  const double R2 = BANK_R * BANK_R;
  if (bankCache_.size() > 5000) bankCache_.clear();
  int n = 0;
  float* rec = rec_.data();
  for (int j = -R; j <= R; j++)
    for (int i = -R; i <= R; i++) {
      if (n >= MAX_RECORDS - 140) break;
      const int ci = ci0 + i, cj = cj0 + j;
      const int64_t key = int64_t(ci) * 262144 + cj;
      auto it = bankCache_.find(key);
      if (it == bankCache_.end()) {
        const double x = (ci + 0.15 + 0.7 * hash2(ci, cj, 501)) * G, z = (cj + 0.15 + 0.7 * hash2(ci, cj, 502)) * G;
        if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > R2) continue;
        std::vector<float> c(12);
        if (!analyseCell(ci, cj, x, z, c.data())) continue;   // no terrain data there yet: retried on the next placement
        it = bankCache_.emplace(key, std::move(c)).first;
      } else if ((it->second[0] - cx) * (it->second[0] - cx) + (it->second[1] - cz) * (it->second[1] - cz) > R2) continue;
      std::copy(it->second.begin(), it->second.end(), rec + n * 12);
      n++;
    }
  // the cloud sea at the backdrop's level: billowy relief on its flat sea, hiding the peaks' feet
  const double RG = RING_CELL;
  const int RR = int(std::ceil(RING_R / RG)), ri0 = int(std::floor(cx / RG)), rj0 = int(std::floor(cz / RG));
  for (int j = -RR; j <= RR; j++)
    for (int i = -RR; i <= RR; i++) {
      if (n >= MAX_RECORDS - 140) break;
      const int ci = ri0 + i, cj = rj0 + j;
      const double x = (ci + 0.1 + 0.8 * hash2(ci, cj, 521)) * RG, z = (cj + 0.1 + 0.8 * hash2(ci, cj, 522)) * RG;
      const double d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 > RING_R * RING_R || d2 < 5000.0 * 5000.0) continue;
      const double r1 = hash2(ci, cj, 523), r3 = hash2(ci, cj, 526);
      float* o = rec + n * 12;
      o[0] = float(x); o[1] = float(z); o[2] = K_RING; o[3] = float(r3 < 0.62 ? (r3 < 0.31 ? 5 : 6) : int(std::floor(r1 * 4)));
      o[4] = hash2(ci, cj, 525) < 0.5 ? 1.f : -1.f; o[5] = float(3200 + r1 * 1800); o[6] = float(hash2(ci, cj, 524));
      o[7] = 0; o[8] = 0; o[9] = 0; o[10] = float(hash2(ci, cj, 527)); o[11] = 0;
      n++;
    }
  recAnchored_ = n;
  placeDrifters(cx, cz);
}

// High cumulus (cloudy weather): not tied to terrain, they drift with the wind. Cells are picked round (camera -
// drift) so a cloud never jumps when the drift grows.
void CloudScenery::placeDrifters(double camX, double camZ) {
  const double cx = camX - drift_.x, cz = camZ - drift_.y;
  driftAt_ = dvec2(cx, cz);
  recCount_ = driftLayer(recAnchored_, cx, cz, DRIFT_CELL, DRIFT_R, K_HIGH, 600);
  order_.resize(size_t(recCount_));
  std::iota(order_.begin(), order_.end(), 0);
  sortTick_ = 7;   // re-sorted on the next update
}

int CloudScenery::driftLayer(int n, double cx, double cz, double G, double Rm, int kind, int seed) {
  float* rec = rec_.data();
  const int R = int(std::ceil(Rm / G)), ci0 = int(std::floor(cx / G)), cj0 = int(std::floor(cz / G));
  for (int j = -R; j <= R; j++)
    for (int i = -R; i <= R; i++) {
      if (n >= MAX_RECORDS) return n;
      const int ci = ci0 + i, cj = cj0 + j;
      if (hash2(ci, cj, seed) > 0.7) continue;
      const double x = (ci + 0.1 + 0.8 * hash2(ci, cj, seed + 1)) * G, z = (cj + 0.1 + 0.8 * hash2(ci, cj, seed + 2)) * G;
      if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > Rm * Rm) continue;
      const double r1 = hash2(ci, cj, seed + 3);
      float* o = rec + n * 12;
      o[0] = float(x); o[1] = float(z); o[2] = float(kind);
      o[3] = float(std::floor(hash2(ci, cj, seed + 4) * 4.99));
      o[4] = hash2(ci, cj, seed + 5) < 0.5 ? 1.f : -1.f;
      o[5] = float(2200 + r1 * 1600);
      o[6] = float(hash2(ci, cj, seed + 6)); o[7] = 0; o[8] = 0; o[9] = 0;
      o[10] = float(r1); o[11] = 1;   // drifts with the wind
      n++;
    }
  return n;
}

void CloudScenery::update(double dt, const World& world, const dvec3& cam, const Wx& wx, float fogDensity, float fogFalloff, int cap, bool now) {
  if (rec_.empty()) { rec_.assign(size_t(MAX_RECORDS) * 12, 0.f); key_.assign(MAX_RECORDS, 0); }
  time_ += dt;
  if (villageY_ > 1e29) villageY_ = world.height(0, 0);
  frame.tmapDirty = false;
  // the terrain map: re-centred every 2.4 km (on a worker; the first one waited for at load)
  {
    const int N = TMAP_N, ci = int(std::floor(cam.x / TMAP_CELL)), cj = int(std::floor(cam.z / TMAP_CELL));
    const int moved = std::max(std::abs(ci - tmapCX_), std::abs(cj - tmapCZ_));
    if (!job_.valid() && moved >= 8) startMap(world, ci, cj);
    if (job_.valid() && (now || tmap_.empty() || job_.wait_for(std::chrono::seconds(0)) == std::future_status::ready)) {
      MapJob m = job_.get();
      tmap_ = std::move(m.h); tmapKey_ = std::move(m.key);
      tmapCX_ = m.ci; tmapCZ_ = m.cj;
      frame.tmap = tmap_; frame.tmapDirty = true;
      banksDirty_ = true;   // fresh terrain data -> re-place the clouds
      if (std::max(std::abs(ci - tmapCX_), std::abs(cj - tmapCZ_)) >= N / 4) regional_ = 1e30;   // (a teleport)
    }
  }
  // the regional ground level (the overcast deck and the high clouds follow the land, which keeps descending forever
  // down the Legacy Valley)
  {
    double s = 0; int c = 0;
    for (int j = -2; j <= 2; j++)
      for (int i = -2; i <= 2; i++) { const double h = heightAt(cam.x + i * 1800, cam.z + j * 1800); if (h == h) { s += h; c++; } }
    if (c) regional_ = regional_ > 1e29 ? s / c : lerp(regional_, s / c, std::min(1.0, dt * 1.2));
  }

  // ---- the overcast deck: only in real cloud; low ceiling in snow, higher when merely cloudy; the sea of clouds
  // sinks it into the valley below the village, sunny above it
  const double sea = wx.sea;
  const double cover = clamp(lerp(wx.cloud * 0.95 + wx.snow * 0.1 - 0.06, 0.86, sea) + std::sin(time_ * 0.002) * 0.05, 0, 0.92);
  const double seaH = villageY_ - 110 + std::sin(time_ * 0.0015) * 12;
  const double reg = regional_ > 1e29 ? 0.0 : regional_;
  const double cloudH = lerp(reg + 400 + wx.cloud * 160 - wx.snow * 230 + std::sin(time_ * 0.0015) * 60, seaH, sea);
  hasInversion = sea > 0.01; inversionY = seaH + 78;
  frame.cover = float(cover); frame.cloudH = float(cloudH);
  frame.lean = cap < 200;
  // from above, a flat deck reads as a white sheet: it thins out and the billowy cards take over
  frame.deckAbove = float(1 - 0.8 * (1 - 0.6 * sea) * smoothstep(cloudH + 110, cloudH + 500, cam.y));
  const double inside = 1 - smoothstep(15, 70, std::fabs(cam.y - (cloudH + 39)));
  cloudInside = float(inside * cover * smoothstep(0.3, 0.8, std::max(wx.cloud, sea)));   // whiteout only in real cloud

  // ---- the impostors: a slow steady drift for the free clouds (föhn / blizzard: they race past)
  const double wa = 0.7 + std::sin(time_ * 0.0007) * 0.5, dv = 3.2 * (1 + 4 * wx.wind);
  drift_.x += std::cos(wa) * dv * dt; drift_.y += std::sin(wa) * dv * dt;
  frame.drift = drift_;
  if (banksDirty_ || std::hypot(cam.x - banksAt_.x, cam.z - banksAt_.y) > 450) {
    banksDirty_ = false;
    banksAt_ = dvec2(cam.x, cam.z);
    placeBanks(cam.x, cam.z);
  } else if (std::hypot(cam.x - drift_.x - driftAt_.x, cam.z - drift_.y - driftAt_.y) > 450) {
    placeDrifters(cam.x, cam.z);   // the wind carried the free clouds on: refill upwind
  }

  const double cl = wx.cloud, sn = wx.snow, mi = wx.mist;
  const double fogBank = std::max(0.0, mi - 0.2);   // real mist (not the morning haze every clear day has)
  const double covSea = clamp(0.47 + cl * 0.18 + fogBank * 0.5 + sea * 0.25, 0, 0.97);
  const double covBank = clamp(0.24 + cl * 0.36 - fogBank * 0.3, 0, 0.9);
  const double covWisp = clamp(0.2 + cl * 0.2 + fogBank * 0.4, 0, 0.8);
  const double covRing = clamp(0.56 + cl * 0.2 + fogBank * 0.4, 0, 0.97);
  // cumulus above the peaks: cloudy days only, kept far out (9 km+) so they stand on the horizon
  const double covHigh = clamp(std::max(0.0, cl - 0.2) * 0.7 - sn * 0.6, 0, 0.45);
  const double highNear = 9000;
  // clear weather keeps the player's surroundings open; bad weather brings the banks in
  const double nearR = lerp(lerp(4000, 2400, smoothstep(0.15, 0.7, cl)), 1800, sn);
  // the backdrop's cloud-sea level (Backdrop.update: valley baseline + level, kept below the eye)
  const double bz = cam.z - 200, baseY = bz > 0 ? -0.17 * bz * smoothstep(0, 450, bz) : 0;
  const double seaY = baseY + std::min(380 + cl * 420 + mi * 220 + sn * 200, cam.y - baseY - 260);
  const double lift = cl * 260 - mi * 140;                  // cloudy: higher tops, mist: hugging the floors
  const float storm = float(clamp(sn * 0.7 + cl * 0.2, 0, 0.85));   // darker, flatter clouds in bad weather
  const double regY = regional_ > 1e29 ? cam.y : regional_;
  // anchored banks wander slowly (~1 m/s) round their valleys; free clouds drift on with the wind
  const double ax = std::sin(time_ * 0.0021) * 420, az = std::cos(time_ * 0.0017) * 420;
  // the height fog seen from the camera (fog.js): cards that would be fully fogged are skipped
  const double fogB = fogFalloff, fogK = fogDensity * std::exp(-std::max(cam.y, 0.0) * fogB);
  const float* rec = rec_.data();
  const int nRec = recCount_;
  if ((sortTick_ = (sortTick_ + 1) & 7) == 0) {   // far -> near (the order changes slowly: every few frames)
    for (int i = 0; i < nRec; i++) {
      const float* o = rec + i * 12;
      const bool f = o[11] > 0;
      const double x = o[0] + (f ? drift_.x : ax), z = o[1] + (f ? drift_.y : az);
      key_[size_t(i)] = (x - cam.x) * (x - cam.x) + (z - cam.z) * (z - cam.z);
    }
    std::stable_sort(order_.begin(), order_.end(), [&](int a, int b) { return key_[size_t(a)] > key_[size_t(b)]; });
  }
  const auto& CELLS = cloudShapes();
  std::vector<CloudCard>& out = frame.cards;
  out.clear();
  for (int k = 0; k < nRec && int(out.size()) < MAX_CARDS; k++) {
    const float* o = rec + order_[size_t(k)] * 12;
    const int kind = int(o[2]);
    const double rank = o[6], r1 = o[10];
    const double cov = kind == K_SEA ? covSea : kind == K_BANK ? covBank : kind == K_WISP ? covWisp : kind == K_HIGH ? covHigh : covRing;
    double op = clamp((cov - rank) * 12, 0, 1);   // more cover -> more clouds fade in, ranked
    if (op <= 0.002) continue;
    const bool f = o[11] > 0;
    const double x = o[0] + (f ? drift_.x : ax), z = o[1] + (f ? drift_.y : az);
    const double dist = std::sqrt((x - cam.x) * (x - cam.x) + (z - cam.z) * (z - cam.z));
    const double w = o[5], lo = o[7], hp = o[8], hi = o[9];
    const int cell = int(o[3]);
    const double topF = CELLS[size_t(cell)].top;
    double base, top, soft;
    if (kind == K_SEA) {          // valley fill: tops a few hundred metres over the floor, ridges poke out
      base = hp - 70;
      top = std::min(std::max(hp + 260, lo + 300 + r1 * 260 + lift), std::max(hi - 60, hp + 200));
      soft = 140;
      op *= smoothstep(nearR - 1400, nearR, dist);
    } else if (kind == K_BANK) {  // cumulus leaning on a flank
      base = hp - 70;
      top = std::min(hp + w * (0.17 + 0.09 * r1) + lift * 1.2, hi + 220);
      soft = 170;
      op *= smoothstep(nearR - 1400, nearR, dist);
    } else if (kind == K_WISP) {  // a thin veil in front of a face, only at a distance
      const double y = lo + lift * 0.5;
      base = y - 0.36 * 620; top = base + topF * 620; soft = 110;
      const double wispNear = std::max(nearR, 5200.0);
      op *= smoothstep(wispNear - 1400, wispNear + 600, dist) * 0.6;
    } else if (kind == K_RING) {  // relief on the backdrop's cloud sea
      base = seaY - 150 - 90 * r1;
      top = seaY + 80 + 300 * o[10] + lift * 0.4;
      soft = 160;
      op *= smoothstep(6500, 8800, dist);
    } else {                      // K_HIGH: fair-weather / cloudy cumulus above the peaks
      base = regY + lerp(950, 1250, cl) + r1 * 600 - sn * 300; top = base + w * 0.32; soft = 1;
      op *= smoothstep(highNear - 1200, highNear, dist);
    }
    const double reach = kind == K_HIGH ? DRIFT_R : BANK_R;
    op *= 1 - smoothstep(reach - 3500, reach - 300, dist);
    op *= smoothstep(w * 0.5, w * 0.95, dist);   // big cards never come close (a flat card at arm's length would show)
    if (kind != K_HIGH) op *= smoothstep(RESORT_R, RESORT_R + 900, std::hypot(x - RESORT_X, z - RESORT_Z));   // the resort stays clear
    if (op <= 0.002) continue;
    const double H = clamp((top - base) / topF, 0.18 * w, 0.62 * w);
    // fogged out (thick snow / mist; the shader fades cards by 93 % fog)? skipped (checked at its upper part)
    const double dy = base + H * 0.8 - cam.y, by = dy * fogB;
    if (fogK * std::sqrt(dist * dist + dy * dy) * (std::fabs(by) > 1e-4 ? (1 - std::exp(-by)) / by : 1) > 2.7) continue;
    CloudCard cd;
    cd.pos = dvec3(x, base, z); cd.mirror = o[4];
    cd.b = vec4(float(w), float(H), float(cell), float(op));
    cd.c = vec4(float(soft), storm, CELLS[size_t(cell)].trim, kind == K_RING ? 1.f : 0.f);
    out.push_back(cd);
  }
  // the preset's cap: the cards run far -> near, so the farthest (smallest, most hazed) give way -- except the ring
  // on the distant cloud sea (it hides the line where the real terrain ends): the far valley banks go first
  cap = std::min(MAX_CARDS, cap);
  int n = int(out.size());
  if (n > cap) {
    int drop = n - cap, w = 0;
    for (int r = 0; r < n; r++) {
      if (drop > 0 && out[size_t(r)].c.w != 1) { drop--; continue; }
      out[size_t(w++)] = out[size_t(r)];
    }
    n = w; out.resize(size_t(n));
  }
  if (n > cap) out.erase(out.begin(), out.begin() + (n - cap));
}

} // namespace sl
