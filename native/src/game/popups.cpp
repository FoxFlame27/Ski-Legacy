#include "game/popups.h"
#include "game/economy.h"
#include "game/ui_widgets.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace sl {
using namespace ui_color;

namespace {
constexpr double KMH = 3.6, SPEED_MIN = 50 / KMH, SPEED_STEP = 2 / KMH, SPEED_SETTLE = 4 / KMH, JUMP_MIN = 10, JUMP_STEP = 1, AIR_MIN = 1.2, AIR_STEP = 0.15;
const int MILESTONES_KM[] = {5, 10, 25, 50, 100, 250, 500, 1000};
}

void Popups::trick(const std::string& name, int points, int total, int landed, double now) {
  static const char* LAND[3] = {"CLEAN", "SKETCHY", "BAILED"};
  Card c;
  c.name = uiw::upper(name); c.q = std::clamp(landed, 0, 2); c.tag = LAND[c.q];
  if (c.q != 2) { c.value = "+" + uiw::thousands(points); if (total > points) c.total = total; }
  c.at = now; c.life = 2.3; c.seed = 340 + (trickN_++ % 9);
  trick_ = c;
}

void Popups::best(const std::string& kicker, const std::string& title, const std::string& value, const std::string& unit, double now) {
  Card c;
  c.kicker = kicker; c.name = uiw::upper(title); c.value = value; c.tag = unit; c.q = 3; c.best = true;
  c.at = now; c.life = 2.8; c.seed = 360 + (trickN_++ % 9);
  best_ = c;
}

bool Popups::updateBests(double dt, bool skiing, double speed, bool airIn, double airTime, const dvec3& pos, bool crash, Save& save, bool busy, double now) {
  auto& st = save.stats;
  if (speedBest_ < 0) {
    speedBest_ = st.topSpeed;
    milestoneKm_ = 0;
    for (int km : MILESTONES_KM) if (st.distance >= km * 1000.0) milestoneKm_ = km;
  }
  cooldown_ = std::max(0.0, cooldown_ - dt);
  auto push = [&](Q q) {
    queue_.erase(std::remove_if(queue_.begin(), queue_.end(), [&](const Q& x) { return x.title == q.title; }), queue_.end());
    queue_.push_back(std::move(q));
  };
  const double sp = skiing ? speed : 0;
  // top speed: wait for the peak, then announce it once
  if (busy) { speedBest_ = std::max(speedBest_, sp); peak_ = 0; }
  else if (sp > std::max(SPEED_MIN, speedBest_ + SPEED_STEP) || (peak_ > 0 && sp > peak_)) peak_ = std::max(peak_, sp);
  else if (peak_ > 0 && sp < peak_ - SPEED_SETTLE) {
    speedBest_ = peak_;
    if (skiing) push({"PERSONAL BEST", "TOP SPEED", std::to_string(int(std::lround(peak_ * KMH))), "KM/H", 0});
    peak_ = 0;
  }
  // jumps: the distance over the snow from takeoff to landing, and the time in the air
  const bool air = skiing && airIn;
  if (air && !wasAir_) takeoff_ = dvec2(pos.x, pos.z);
  if (!air && wasAir_ && skiing && !crash) {
    double dist = std::hypot(pos.x - takeoff_.x, pos.z - takeoff_.y), t = airTime;
    if (dist > std::max(4.0, t * 40)) dist = 0;   // moved by a teleport (respawn, lift), not by a jump
    bool jumpPB = dist >= JUMP_MIN && dist >= st.longestJump + JUMP_STEP, airPB = t >= AIR_MIN && t >= st.bestAir + AIR_STEP;
    st.longestJump = std::max(st.longestJump, dist);
    st.bestAir = std::max(st.bestAir, t);
    char b[32];
    std::snprintf(b, sizeof b, "%.1f", t);
    if (jumpPB && !busy) push({"PERSONAL BEST", "LONGEST JUMP", std::to_string(int(std::lround(dist))), "M", 1.2});
    else if (airPB && !busy) push({"PERSONAL BEST", "BIGGEST AIR", b, "SEC", 1.2});
    if (jumpPB || airPB) save.markDirty();
  }
  wasAir_ = air;
  // distance milestones
  for (int km : MILESTONES_KM) if (km > milestoneKm_) {
    if (st.distance >= km * 1000.0) { milestoneKm_ = km; if (!busy) push({"MILESTONE", "DISTANCE SKIED", std::to_string(km), "KM", 0}); }
    break;
  }
  // one card at a time, a short gap between them; never during a race
  for (Q& q : queue_) q.delay = std::max(0.0, q.delay - dt);
  bool shown = false;
  if (!busy && cooldown_ <= 0 && !queue_.empty() && queue_[0].delay <= 0) {
    Q q = queue_.front();
    queue_.erase(queue_.begin());
    best(q.kicker, q.title, q.value, q.unit, now);
    cooldown_ = 3.2;
    shown = true;
  }
  if (busy) queue_.clear();
  return shown;
}

void Popups::drawCard(Ui& ui, const Card& c, float top, double now) const {
  const double age = now - c.at;
  if (age < 0 || age > c.life + 0.45) return;
  const float d = ui.dpr(), u = ui.cssU(), W = float(ui.width());
  const float tXs = std::max(11 * d, 11 * u), tSm = std::max(12 * d, 13 * u);
  const UiFont NUM = UiFont::CondItalic;
  Ui::Tabular tab(ui);
  // tpIn 0.4 s (from 60u to the right, a little overshoot), tpOut 0.4 s
  float in = float(std::clamp(age / 0.4, 0.0, 1.0)), out = float(std::clamp((age - c.life) / 0.4, 0.0, 1.0));
  float e = 1 - std::pow(1 - in, 3.f), dx = 60 * u * (1 - e) + 60 * u * out, al = std::min(1.f, in * 2) * (1 - out);
  static const uint32_t QC[4] = {0x129a46, 0xe09a00, 0xd0342c, 0x1546c8};
  const vec4 qc = hex(QC[std::clamp(c.q, 0, 3)]);
  const bool bailed = c.q == 2 && !c.best;
  const float tagFs = bailed ? tSm : tXs, tagTr = c.best ? 0.12f : 0.18f;
  // (the card is as wide as its widest line; a very long trick name is fitted to the window)
  float nameFs = 24 * u, nameW = ui.textWidth(c.name, nameFs, NUM, 0.02f), maxName = W - 56 * u - 56 * u;
  if (nameW > maxName) { nameFs *= maxName / nameW; nameW = maxName; }
  float valW = c.value.empty() ? 0 : ui.textWidth(c.value, 30 * u, NUM), tagW = ui.textWidth(c.tag, tagFs, UiFont::BodyHeavy, tagTr);
  float lineW = valW + (valW > 0 ? 10 * u : 0) + tagW;
  std::string tot = c.total >= 0 ? uiw::thousands(c.total) : "";
  float totW = tot.empty() ? 0 : ui.textWidth("SCORE", tXs, UiFont::BodyHeavy, 0.14f) + 4 * u + ui.textWidth(tot, 18 * u, NUM, 0.02f);
  float kickW = c.kicker.empty() ? 0 : ui.textWidth(c.kicker, tXs, UiFont::BodyHeavy, 0.18f);
  float inner = std::max({nameW, lineW, totW, kickW}), w = inner + 56 * u;
  float h = 9 * u + (c.kicker.empty() ? 0 : tXs + 4 * u) + 24 * u * 1.05f + 3 * u + 30 * u + (tot.empty() ? 0 : 5 * u + 18 * u) + 10 * u;
  float x = W - 28 * u - w + dx, y = top;
  ui.pushAlpha(al);
  uiw::paper(ui, x, y, w, h, c.seed, 4, 3, u);
  ui.rect(x + 12 * u, y + h * 0.22f, 5 * u, h * 0.56f, qc);
  float tx = x + 32 * u, ty = y + 9 * u;
  if (!c.kicker.empty()) { ui.textLH(tx, ty, tXs, tXs, UiFont::BodyHeavy, red, c.kicker, UiAlign::Left, 0.18f); ty += tXs + 4 * u; }
  ui.textLH(tx, ty, 24 * u * 1.05f, nameFs, NUM, blue, c.name, UiAlign::Left, 0.02f);
  ty += 24 * u * 1.05f + 3 * u;
  {
    float base = ty + 15 * u + (ui.ascent(NUM) + ui.descent(NUM)) / 2 * 30 * u;
    auto baseText = [&](float bx, float size, UiFont f, const vec4& col, const std::string& t, float tr) {
      float topY = base - ui.ascent(f) * size - (ui.lineHeight(size, f) - (ui.ascent(f) - ui.descent(f)) * size) * 0.5f;
      return ui.text(bx, topY, size, f, col, t, UiAlign::Left, tr);
    };
    float lx = tx;
    if (!c.value.empty()) lx += baseText(lx, 30 * u, NUM, blue, c.value, 0) + 10 * u;
    baseText(lx, tagFs, UiFont::BodyHeavy, c.best ? blueDim : qc, c.tag, tagTr);
    ty += 30 * u;
    if (!tot.empty()) {
      ty += 5 * u;
      base = ty + 9 * u + (ui.ascent(NUM) + ui.descent(NUM)) / 2 * 18 * u;
      float sx = tx + baseText(tx, tXs, UiFont::BodyHeavy, blueDim, "SCORE", 0.14f) + 4 * u;
      baseText(sx, 18 * u, NUM, blue, tot, 0.02f);
    }
  }
  ui.popAlpha();
}

void Popups::draw(Ui& ui, bool inRace, double now) {
  const float u = ui.cssU();
  drawCard(ui, trick_, (inRace ? 176 : 24) * u, now);
  if (!inRace) drawCard(ui, best_, 150 * u, now);
}

} // namespace sl
