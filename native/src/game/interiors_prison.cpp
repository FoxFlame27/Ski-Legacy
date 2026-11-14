// The police station inside as the web game builds and walks it (src/game/prison.js PrisonRoom, exported by
// export_rooms.mjs): the cell block (three cells behind the bars, the corridor) and the front office beyond the barred
// gate (the reception counter, the benches, the front door), in the room's own frame. You are in it as a prisoner
// (PrisonRoom.place 'jailed': shut in your cell, between its walls and the bars) or as a visitor (in at the front
// door; the corridor and the office, never behind the bars); what you bump into: the room's boxes (prison.js walk).
#include "game/interiors.h"
#include "game/play_data.h"
#include "player/player.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>

namespace sl {

namespace {
constexpr double BODY = 0.3;   // the C++ walker's own radius (prison.js: 0.26)
Collider rectC(const dvec3& o, double x0, double x1, double z0, double z1) {
  Collider c;
  c.x = o.x + (x0 + x1) / 2; c.z = o.z + (z0 + z1) / 2; c.hw = std::max(0.01, (x1 - x0) / 2); c.hd = std::max(0.01, (z1 - z0) / 2); c.rot = 0;
  return c;
}
}

void Interiors::setPrisonRole(bool jailed, int cell) { prJailed_ = jailed; prCell_ = cell; }

void Interiors::buildPrisonExported() {
  const PrisonDef& d = c_.data->prisonDef;
  pr_ = &d;
  halfX = vec2(20); halfZ = vec2(9);
  ceiling = 3.3;
  shell_ = c_.roomModel("prison");
  look_ = &c_.data->prisonRoom;
  prCell_ = std::clamp(prCell_, 0, int(d.cells.size()) - 1);
  const double R = d.radius, cx = d.cells[size_t(prCell_)];
  // PrisonRoom.place: where your feet stay (the centre of the body)
  if (prJailed_) {
    prBounds_[0] = cx - d.cellW / 2 + 0.1 + R; prBounds_[1] = cx + d.cellW / 2 - 0.1 - R; prBounds_[2] = d.roomZ0 + R; prBounds_[3] = d.bars - 0.05 - R;
    spawnLocal = dvec3(cx + 0.4, 0, -1.4); spawnYaw = 0.15;
  } else {
    prBounds_[0] = d.roomX0 + R; prBounds_[1] = d.frontX1 - R; prBounds_[2] = d.bars + 0.3 + R; prBounds_[3] = d.frontZ1 - R;
    spawnLocal = dvec3(d.exitX - 0.9, 0, d.exitZ); spawnYaw = -PI / 2;
  }
  exitLocal = dvec3(d.exitX, 0, d.exitZ);
  prGuardYaw_ = 0; prT_ = 0;
  lightTint = vec3(0.92f, 0.96f, 1.0f);
}

void Interiors::prisonColliders(std::vector<Collider>& out) const {
  const PrisonDef& d = *pr_;
  const dvec3 o(origin_.x, 0, origin_.z);
  const double* B = prBounds_;
  out.push_back(rectC(o, B[0] - BODY - 2, B[0] - BODY, B[2] - 3, B[3] + 3)); out.push_back(rectC(o, B[1] + BODY, B[1] + BODY + 2, B[2] - 3, B[3] + 3));
  out.push_back(rectC(o, B[0] - 3, B[1] + 3, B[2] - BODY - 2, B[2] - BODY)); out.push_back(rectC(o, B[0] - 3, B[1] + 3, B[3] + BODY, B[3] + BODY + 2));
  // (the boxes stop your centre d.radius short of them: here your body's own radius does)
  const double k = BODY - d.radius;
  for (const auto& b : d.boxes) {
    if (b[1] < B[0] - 1 || b[0] > B[1] + 1 || b[3] < B[2] - 1 || b[2] > B[3] + 1) continue;
    out.push_back(rectC(o, b[0] + k, b[1] - k, b[2] + k, b[3] - k));
  }
}

void Interiors::prisonStep(double dt) {
  if (!pr_) return;
  prT_ += dt;
  // prison.js update: the guard, idle at his desk, an eye on whoever comes within 6 m
  if (pr_->hasGuard) {
    const dvec3 p = toLocal(c_.player->pos);
    const bool near = std::hypot(p.x - pr_->guardX, p.z - pr_->guardZ) < 6;
    const double want = near ? std::atan2(p.x - pr_->guardX, p.z - pr_->guardZ) : 0;
    prGuardYaw_ += std::atan2(std::sin(want - prGuardYaw_), std::cos(want - prGuardYaw_)) * (1 - std::exp(-dt * 3));
  }
}

// prison.js update: the way out in front of a visitor (within 2 m, looking its way), your cell's door (within 1.5 m)
int Interiors::prisonTarget(const dvec3& eye, const vec3& dir) const {
  if (!pr_) return 0;
  const PrisonDef& d = *pr_;
  const dvec3 p = toLocal(eye);
  if (!prJailed_) {
    const double dx = d.exitX - p.x, dz = d.exitZ - p.z, dd = std::hypot(dx, dz);
    return dd < 2.0 && dd > 1e-6 && (dx * double(dir.x) + dz * double(dir.z)) / dd > 0.4 ? 1 : 0;
  }
  if (size_t(prCell_) < d.cellDoors.size() && std::hypot(d.cellDoors[size_t(prCell_)].x - p.x, d.cellDoors[size_t(prCell_)].y - p.z) < 1.5) return 2;
  return 0;
}

bool Interiors::prisonGuard(dvec3& pos, double& yaw) const {
  if (!pr_ || !pr_->hasGuard) return false;
  pos = toWorld(pr_->guardX, 0, pr_->guardZ);
  yaw = prGuardYaw_;
  return true;
}

} // namespace sl
