#include "world/snowtrails.h"
#include "player/player.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

void SnowTrails::player(const Player& p) {
  havePlayer_ = true;
  pin_.pos = p.pos; pin_.vel = p.vel; pin_.heading = p.heading;
  pin_.mode = int(p.mode); pin_.air = p.air || p.footJumpY > 0.05; pin_.skis = p.skisOn;
  pin_.edge = p.edge; pin_.plow = p.plow; pin_.sideslip = p.sideslip; pin_.lean = p.lean; pin_.speed = p.speed();
}

// a groove segment from the line's last mark to p (the segments overlap a little: one continuous line)
void SnowTrails::groove(Track& t, const dvec2& p, float hw, float strength, float widen, uint8_t kind, float segLen) {
  if (!t.on || t.last.x > 1e17) { t.last = p; t.on = true; return; }
  dvec2 d = p - t.last;
  double len = glm::length(d);
  if (len < segLen) return;
  if (len > 6) { t.last = p; return; }   // (a teleport / a jump in position)
  TrailStamp s;
  s.pos = (p + t.last) * 0.5;
  s.dir = vec2(float(d.x / len), float(d.y / len));
  s.halfAlong = float(len * 0.5 + hw * 0.6);
  s.kind = kind;
  s.strength = std::clamp(strength, 0.f, 1.f);
  s.along = float(t.along + len * 0.5);
  s.seed = rnd() * 100;
  if (kind == 0) { s.extra = hw * widen; s.halfAcross = hw * widen * 2.1f; }
  else { s.extra = hw; s.halfAcross = hw * 1.5f; }
  pending_.push_back(s);
  t.along += len;
  t.last = p;
}

void SnowTrails::footprint(const dvec2& p, double yaw, float strength, float scale) {
  TrailStamp s;
  s.pos = p;
  s.dir = vec2(float(std::sin(yaw)), float(std::cos(yaw)));
  s.halfAlong = 0.155f * scale; s.halfAcross = 0.1f * scale;
  s.kind = 1;
  s.strength = strength;
  s.seed = rnd() * 100;
  pending_.push_back(s);
}

void SnowTrails::emitSpray(const dvec3& at, const dvec3& vel, int n, float size, float speed, float up) {
  n = int(float(n) * spray_ + rnd());
  for (int i = 0; i < n && sparks_.size() < 3000; i++) {
    dvec3 v = vel * double(0.6f + 0.5f * rnd());
    v += dvec3((rnd() - 0.5f) * speed, up * (0.5f + rnd()), (rnd() - 0.5f) * speed);
    sparks_.push_back({at + dvec3((rnd() - 0.5f) * 0.3f, rnd() * 0.15f, (rnd() - 0.5f) * 0.3f), v, 0.5f + rnd() * 0.9f, 0,
                       size * (0.6f + 0.8f * rnd()), rnd() * 6.28f, 0.35f + 0.4f * rnd()});
  }
}

void SnowTrails::vehicle(int id, const dvec3& pos, double yaw, int kind) {
  Mover& m = movers_[id | (1 << 24)];
  m.seen = time_;
  m.prev = m.init ? m.pos : pos;
  m.pos = pos; m.yaw = yaw; m.init = true;
  dvec2 f(std::sin(yaw), std::cos(yaw)), r(f.y, -f.x);
  dvec2 c(pos.x, pos.z);
  if (kind == 1) {
    // snowmobile: the track under the seat, the two front skis
    groove(m.t[0], c - f * 0.9, 0.24f, 0.9f, 1.f, 2, 0.3f);
    groove(m.t[1], c + f * 0.95 + r * 0.48, 0.05f, 0.7f, 1.f, 0, 0.25f);
    groove(m.t[2], c + f * 0.95 - r * 0.48, 0.05f, 0.7f, 1.f, 0, 0.25f);
    double sp = glm::length(m.pos - m.prev) * 60;
    if (sp > 3) emitSpray(pos - dvec3(f.x, 0, f.y) * 1.6 + dvec3(0, 0.2, 0), dvec3(-f.x, 0.4, -f.y) * (sp * 0.25), int(sp * 0.25), 0.18f, 1.5f, 1.6f);
  } else {
    groove(m.t[0], c + r * 0.78 - f * 0.2, 0.105f, 0.6f, 1.f, 3, 0.3f);
    groove(m.t[1], c - r * 0.78 - f * 0.2, 0.105f, 0.6f, 1.f, 3, 0.3f);
  }
}

void SnowTrails::npc(int id, const dvec3& pos, bool skis) {
  Mover& m = movers_[id];
  m.seen = time_;
  m.npcSkis = skis;
  if (!m.init) { m.pos = m.prev = pos; m.init = true; m.fresh = false; return; }
  m.pos = pos;
  m.fresh = true;
}

void SnowTrails::stepNpc(Mover& m, double dt) {
  dvec3 pos = m.pos;
  dvec2 d(pos.x - m.prev.x, pos.z - m.prev.z);
  m.prev = pos;
  double len = glm::length(d);
  if (len > 5) { for (auto& t : m.t) t.on = false; return; }
  double sp = dt > 1e-4 ? len / dt : 0;
  if (len > 1e-4) m.yaw = std::atan2(d.x, d.y);
  dvec2 f(std::sin(m.yaw), std::cos(m.yaw)), r(f.y, -f.x), c(pos.x, pos.z);
  if (m.npcSkis || sp > 3.2) {
    groove(m.t[0], c + r * 0.1, 0.045f, 0.75f, 1.f, 0);
    groove(m.t[1], c - r * 0.1, 0.045f, 0.75f, 1.f, 0);
  } else if (len > 0.002) {
    m.stepAcc += len;
    if (m.stepAcc > 0.68) {
      m.stepAcc = 0;
      m.foot ^= 1;
      footprint(c + r * (m.foot ? 0.11 : -0.11), m.yaw, 0.85f);
    }
  }
}

void SnowTrails::update(double dt, Renderer& r, const dvec3& focus, const World* world) {
  time_ += dt;
  r.trailFocus(focus);
  if (havePlayer_) {
    havePlayer_ = false;
    const PlayerIn& P = pin_;
    Mover& m = you_;
    m.prev = m.init ? m.pos : P.pos;
    m.pos = P.pos; m.init = true;
    dvec2 f(std::sin(P.heading), std::cos(P.heading)), rt(f.y, -f.x), c(P.pos.x, P.pos.z);
    dvec3 v = P.vel;
    double sp = P.speed;
    bool onSnow = !P.air;
    const int SKI = 1, WALK = 0, FALL = 2;
    if (P.mode == SKI && P.skis && onSnow) {
      // the skis point along the heading; skidding (sideslip) turns them across the travel: a wide scrape
      double slide = std::clamp(std::fabs(P.sideslip) * 1.6 + P.plow * 0.8, 0.0, 1.0);
      float edge = float(std::clamp(std::fabs(P.edge), 0.0, 1.0));
      float depth = std::clamp(0.45f + edge * 0.55f - float(slide) * 0.35f, 0.15f, 1.f) * float(std::min(1.0, 0.4 + sp * 0.15));
      float widen = 1.f + float(slide) * 3.5f;
      double stance = 0.1 + P.plow * 0.12;
      // (a snowplough: the skis splay into a V, their tails apart)
      groove(m.t[0], c + rt * stance, 0.048f, depth, widen, 0, 0.18f);
      groove(m.t[1], c - rt * stance, 0.048f, depth, widen, 0, 0.18f);
      m.t[2].on = m.t[3].on = false;
      // spray: off the downhill edges in a hard carve, a fan in a hockey stop / skid
      float carveK = edge * float(std::clamp((sp - 6) / 14, 0.0, 1.0));
      float skidK = float(slide * std::clamp((sp - 3) / 10, 0.0, 1.0));
      double side = P.lean >= 0 ? 1 : -1;
      dvec3 out = dvec3(rt.x, 0, rt.y) * side;
      if (carveK > 0.05) emitSpray(P.pos + out * 0.25 - dvec3(f.x, 0, f.y) * 0.5, v * 0.35 + out * (2.0 + carveK * 3.0), int(carveK * 5 + 0.5), 0.12f, 1.2f, 1.4f + carveK * 1.5f);
      if (skidK > 0.05) {
        dvec3 dir = glm::length(v) > 0.1 ? glm::normalize(v) : dvec3(f.x, 0, f.y);
        emitSpray(P.pos + dir * 0.5, dir * (sp * 0.55) + out * 1.5, int(skidK * 10 + 0.5), 0.16f, 2.2f, 1.6f + skidK * 1.2f);
        if (rnd() < skidK * 0.4f) {   // the thrown snow piles up downhill
          TrailStamp s;
          s.pos = dvec2(P.pos.x + dir.x * (1.2 + rnd()), P.pos.z + dir.z * (1.2 + rnd()));
          s.halfAlong = s.halfAcross = 0.25f + 0.35f * rnd();
          s.kind = 4; s.strength = 0.6f * skidK; s.seed = rnd() * 100;
          pending_.push_back(s);
        }
      }
      if (wasAir_) {   // landing: a crater of compressed snow, powder thrown up
        TrailStamp s;
        s.pos = c; s.dir = vec2(f); s.halfAlong = 0.55f; s.halfAcross = 0.5f; s.kind = 0; s.extra = 0.22f; s.strength = 0.8f; s.seed = rnd() * 100;
        pending_.push_back(s);
        emitSpray(P.pos, v * 0.3, 24, 0.22f, 3.0f, 1.8f);
      }
    } else if (P.mode == WALK && onSnow) {
      m.t[0].on = m.t[1].on = false;
      dvec2 d(P.pos.x - m.prev.x, P.pos.z - m.prev.z);
      double len = glm::length(d);
      if (len < 3) {
        m.stepAcc += len;
        double stride = sp > 3.5 ? 1.05 : 0.7;
        if (m.stepAcc > stride) {
          m.stepAcc = 0;
          m.foot ^= 1;
          double yaw = len > 1e-3 ? std::atan2(d.x, d.y) : P.heading;
          dvec2 ff(std::sin(yaw), std::cos(yaw)), rr(ff.y, -ff.x);
          footprint(c + rr * (m.foot ? 0.11 : -0.11) + ff * 0.05, yaw, sp > 3.5 ? 1.f : 0.85f);
          if (sp > 3.5) emitSpray(P.pos + dvec3(ff.x, 0, ff.y) * 0.1, dvec3(ff.x, 0.3, ff.y) * 1.2, 2, 0.06f, 0.6f, 0.8f);
        }
      }
    } else if (P.mode == FALL && onSnow) {
      if (fallT_ < 0 || time_ - fallT_ > 0.25) {   // the body ploughs a sitzmark
        fallT_ = time_;
        TrailStamp s;
        s.pos = c; s.dir = vec2(f); s.halfAlong = 0.9f; s.halfAcross = 0.6f; s.kind = 0; s.extra = 0.28f; s.strength = 0.7f; s.seed = rnd() * 100;
        pending_.push_back(s);
        if (sp > 2) emitSpray(P.pos, v * 0.4, 6, 0.2f, 2.f, 1.2f);
      }
      m.t[0].on = m.t[1].on = false;
    } else {
      m.t[0].on = m.t[1].on = false;
    }
    wasAir_ = P.air && P.mode == SKI;
  }
  for (auto& [id, m] : movers_) if (id < (1 << 24) && m.fresh) { stepNpc(m, dt); m.fresh = false; }
  // forget movers not seen for a while
  for (auto it = movers_.begin(); it != movers_.end();) {
    if (time_ - it->second.seen > 2) it = movers_.erase(it); else ++it;
  }
  for (const TrailStamp& s : pending_) r.trailStamp(s);
  pending_.clear();
  // spray: ballistic with drag, it puffs out and fades; lit by the renderer
  const float g = 9.81f;
  for (size_t i = 0; i < sparks_.size();) {
    Spark& s = sparks_[i];
    s.age += float(dt);
    if (s.age >= s.life) { sparks_[i] = sparks_.back(); sparks_.pop_back(); continue; }
    double drag = std::exp(-2.2 * dt);
    s.v = s.v * drag;
    s.v.y -= g * 0.55 * dt;
    s.p += s.v * dt;
    if (world) {
      double gy = world->height(s.p.x, s.p.z);
      if (s.p.y < gy + 0.03) { s.p.y = gy + 0.03; s.v.y = std::fabs(s.v.y) * 0.1; s.v.x *= 0.5; s.v.z *= 0.5; }
    }
    float k = s.age / s.life;
    Particle p;
    p.pos = s.p;
    p.size = s.size * (1.f + k * 2.2f);
    p.color = vec4(0.9f, 0.93f, 0.97f, s.alpha * (1.f - k) * (1.f - k) * std::min(1.f, s.age * 12.f));
    p.rot = s.rot + k;
    p.soft = 0.25f;
    r.addParticle(p);
    i++;
  }
}

} // namespace sl
