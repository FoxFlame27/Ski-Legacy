// The townsfolk (people.h PeopleSim): world/townsfolk.js's Village on world/peoplesim.js's simulation, drawn and posed
// as world/fans.js's dynamic crowd (player/fans_rig.h FanCrowd: the same keyframes, blends, LODs, fades, jacket colours,
// posing rate).
//
// The village (townsfolk.js Village): someone comes out of a door with something to do (a plan: off to the gondola with
// the skis on the shoulder, back from the slopes, the market, the shop, the bus, a stroll), a list of stops (a stall,
// the fire pit, the tree, the trail map, the ticket booth, the shop's window, the bus stop's waiting area), walking the
// plaza's path ring round the Christmas tree between them; a third bring a friend along (side by side, stopping
// together, talking); people standing at the same place chat now and then; at the last stop they go in through a door
// (or fade where they stand). Fewer at night; while the camera is away (260 m) the village sleeps, and coming back
// after a minute it is set again with people already on their way.
// The people (peoplesim.js PeopleSim): each follows its waypoints at its own pace (turning at most 4.2 rad/s, slowing
// for the last metres and in tight turns, stepping round the people in front, the player, the lamps, stalls, signs and
// walls: not near the door it walks through), stands facing somewhere, holds a phone / hands / points, talks, looks at
// what it's there for, fades in at a door and out where it goes in; standing people never overlap; thrown by a car
// (the rigid throw: a ballistic arc somersaulting, a bounce, tumbling on the snow, lying, getting up).
// The places come from the web game's own build (village.js / layout.js / roads.js stopWaitArea, measured by running
// them: the shop's door and front, the ticket booth's counter, the village lifts' bases, the bus stop's waiting area).
#include "game/people.h"
#include "player/fans_rig.h"
#include "core/log.h"
#include "engine/renderer.h"
#include "world/scenery.h"
#include "world/world.h"
#include <algorithm>
#include <deque>
#include <random>
#include <unordered_map>

namespace sl {
using namespace fans;

namespace {
constexpr double VIEW = 170, LOD_NEAR = 18, LOD_MID = 50, LOD_FADE = 0.4;   // townsfolk.js VIEW, LOD; fans.js LOD_FADE
const dvec2 C(0, -4);
constexpr double RING = 15;   // the path ring round the Christmas tree (decor.js)
const double HOTELS[8][2] = {{62, 34}, {-74, 44}, {100, -34}, {-108, -60}, {22, 92}, {-36, 108}, {118, 70}, {-128, 22}};
const double MARKET[3][2] = {{30, 4}, {30.5, 11.2}, {31, 18.4}};
const dvec2 FIRE(22, 12);
// (measured in the web game's build: village.js shopDoor / shopFront / booth.counter / booth.front, layout.js's village
// lifts' bottoms and directions, the plaza's bus stop and roads.js stopWaitArea for it)
const dvec2 SHOP_DOOR(-34.863552, -16.97271), SHOP_FRONT(0.980581, 0.196116);
const dvec2 BOOTH_COUNTER(14.082882, -47.554353), BOOTH_FRONT(-0.351123, 0.936329);
const double VILLAGE_LIFTS[2][4] = {{100, 0, 0.968827, -0.247737}, {-75, 84, -0.991091, -0.133185}};
const dvec2 WAIT_AREA(9.632381, 57.089685);
constexpr double WAIT_FACE = 2.677568;
const dvec2 WAIT_ROAD(12.944254327584426, 50.47217098805306), WAIT_DIR(0.8942586741513289, 0.44755047056740704);
constexpr double ROAD_HALF = 3.4;
constexpr double G = 9.81, BODY_C = 0.9, THICK = 0.15;

double wrapA(double a) { a = std::fmod(a, TAU); return a > PI ? a - TAU : a < -PI ? a + TAU : a; }
double angC(double x, double z) { return std::atan2(z - C.y, x - C.x); }
double sstep(double a, double b, double x) { double t = std::max(0.0, std::min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
double clampd(double x, double a, double b) { return std::max(a, std::min(b, x)); }
double jsRound(double x) { return std::floor(x + 0.5); }
double signOr1(double x) { return x > 0 ? 1 : x < 0 ? -1 : 1; }
double restH(double c, double a, double r) { double u = std::fabs(std::cos(a) * std::cos(r)); return c * u + THICK * (1 - u); }

struct TownRng {
  uint32_t a;
  double operator()() {
    a += 0x6d2b79f5u;
    uint32_t t = a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return double(t ^ (t >> 14)) / 4294967296.0;
  }
};

enum DoorKind { HOTEL = 1, SHOP = 2, GONDOLA = 4 };
struct Door { int kind = HOTEL; dvec2 in{0}, out{0}; double w = 1; };
struct LookAt { double x = 0, z = 0, y = 0; bool hasY = false; };
struct Stop {
  int door = -1;            // >= 0: go in through this door (the plan's end)
  dvec2 at{0};
  double face = 0;
  int hold = 0;
  bool hasLook = false;
  LookAt look;
  double dur = 0;
  bool chat = false;
};
enum class St : uint8_t { Off, Walk, Stop, Gone };
enum class Arrive : uint8_t { None, Door, Stop };
enum Plan { SKI, BACK, MARKET_P, SHOP_P, BUS, STROLL };

struct Obst { double x, z, r, hw, hd, rot, reach; };
// the closest point of a collider to (x, z): direction away from it, distance outside its surface (negative inside)
void away(const Obst& c, double x, double z, double& ux, double& uz, double& d) {
  if (c.r >= 0) {
    double dx = x - c.x, dz = z - c.z, l = std::hypot(dx, dz);
    if (!(l != 0)) l = 1e-6;
    ux = dx / l; uz = dz / l; d = l - c.r;
    return;
  }
  const double cs = std::cos(-c.rot), sn = std::sin(-c.rot), dx = x - c.x, dz = z - c.z;
  const double lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  const double qx = clampd(lx, -c.hw, c.hw), qz = clampd(lz, -c.hd, c.hd);
  double ex = lx - qx, ez = lz - qz;
  d = std::hypot(ex, ez);
  if (d < 1e-6) {   // inside: out through the nearest side
    double ox = c.hw - std::fabs(lx), oz = c.hd - std::fabs(lz);
    if (ox < oz) { ex = signOr1(lx); ez = 0; d = -ox; } else { ex = 0; ez = signOr1(lz); d = -oz; }
  } else { ex /= d; ez /= d; }
  ux = ex * cs + ez * sn; uz = -ex * sn + ez * cs;
}
// rotate the 3x3 part of the column-major matrix at m by angle a about the horizontal axis (kx, 0, kz), lifted a
// little as it lies down (peoplesim.js tilt)
void tilt(float* m, double kx, double kz, double a, double lift = 0.06) {
  const double c = std::cos(a), s = std::sin(a), Cc = 1 - c;
  for (int col = 0; col < 3; col++) {
    float* j = m + col * 4;
    const double vx = j[0], vy = j[1], vz = j[2], kv = kx * vx + kz * vz;
    j[0] = float(vx * c - kz * vy * s + kx * kv * Cc);
    j[1] = float(vy * c + (kz * vx - kx * vz) * s);
    j[2] = float(vz * c + kx * vy * s + kz * kv * Cc);
  }
  m[13] = float(m[13] + lift * std::fabs(s));
}
} // namespace

// ================================================================ the state
struct PeopleSim::Impl {
  struct Down {
    double t = 0, dx = 0, dz = 0, vx = 0, vz = 0, c = 0.9, h = 0.9, vy = 0, a = 0, w = 0, r = 0, rw = 0, aT = 0, lie = 2, up = 1.35, lt = 0, aLie = 0;
    bool hasAT = false;
    enum S : uint8_t { Fly, Tumble, Lie, Up } state = Fly;
  };
  struct Folk {
    int i = 0;
    double x = 0, y = 0, z = 0, yaw = 0, v = 0, vmax = 1.25;
    std::vector<dvec2> path;
    bool hasPath = false;
    int pi = 0, pathGen = 0;
    Arrive arrive = Arrive::None;
    Stop arriveStop;
    double alpha = 0, fadeTo = 0, fadeRate = 2.2;
    bool hasFace = false;
    double face = 0;
    bool hasLook = false;
    LookAt look;
    double talkTo = 0;
    int hold = 0, holdTo = 0, carry = 0;
    St state = St::Off;
    double until = 0;
    int plan = STROLL;
    std::deque<Stop> todo;
    bool hasStop = false;
    Stop stop;
    bool onStage = false;
    bool hasGhost = false;
    dvec2 ghostAt{0};
    int tgGen = -1, tgIdx = -1;
    double bestD = INFINITY, stuck = 0;
    bool down = false;
    Down dn;
    bool hasG = false;
    double gx = 0, gz = 0;
  };
  World* world = nullptr;
  std::vector<std::shared_ptr<FanKit>> kits;
  FanCrowd crowd;
  std::vector<Folk> P;
  TownRng rnd{6612};
  std::mt19937 mrand{20261114u};   // (Math.random)
  double random() { return std::uniform_real_distribution<double>(0, 1)(mrand); }
  std::vector<Door> doors;
  int shop = -1, gondola = -1;
  dvec2 shopIn{0}, shopOut{0}, shopWindow{0};
  double shopFace = 0;
  dvec2 boothAt{0};
  double boothFace = 0;
  // the village's clocks: Townsfolk.time (the crowd's posing), Village.time (the plans)
  double ttime = 0, vtime = 0, spawnT = 0, idleFor = 1e9;
  bool active = false, awake = false;
  int frame = 0;
  double lastDt = 0;
  dvec3 center{0}, bcenter{0};
  std::vector<Obst> obst;
  std::unordered_map<int64_t, std::vector<int>> grid;
  bool gridBuilt = false;
  dvec2 player{1e9};
  bool hasPlayer = false;
  // drawing
  struct Look { std::shared_ptr<Model> lod[3], skis; Pose pose; };
  std::vector<Look> looks;
  bool visible = false;
  struct Entry { int i, l; float f; };
  std::vector<Entry> draws;
  // the contact shades (fans.js blobGeometry / blobMaterial: a soft ellipse under every person, one instanced draw)
  std::shared_ptr<Model> blob;
  MatrixInstanceBatch blobs;
  uint32_t blobCap = 0;
  std::vector<MatrixInstanceBatch::Inst> blobInst;
  void buildBlob(gfx::Device& dev) {
    // PlaneGeometry(1, 1) rotated -90 degrees about x: a unit square on the ground, uv 0..1, facing up
    const float V[4][8] = {{-0.5f, 0, -0.5f, 0, 1, 0, 0, 1}, {0.5f, 0, -0.5f, 0, 1, 0, 1, 1}, {-0.5f, 0, 0.5f, 0, 1, 0, 0, 0}, {0.5f, 0, 0.5f, 0, 1, 0, 1, 0}};
    const uint32_t ix[6] = {0, 2, 1, 2, 3, 1};
    auto M = std::make_shared<Model>();
    M->name = "fan-contact";
    Node nd;
    nd.name = M->name; nd.mesh = 0;
    M->nodes.push_back(nd);
    M->roots.push_back(0);
    Primitive p;
    p.vbo = dev.createBuffer(gfx::BufferUsage::Vertex, V, sizeof V);
    p.ibo = dev.createBuffer(gfx::BufferUsage::Index, ix, sizeof ix);
    const uint32_t st = 8 * sizeof(float);
    p.input = dev.createVertexInput({{0, 0, 3, gfx::AttribType::Float, false, 0, st}, {1, 0, 3, gfx::AttribType::Float, false, 12, st},
                                     {2, 0, 2, gfx::AttribType::Float, false, 24, st}}, {p.vbo}, p.ibo);
    p.lods.push_back({0, 6});
    p.material = 0;
    p.bmin = vec3(-0.5f, 0, -0.5f); p.bmax = vec3(0.5f, 0, 0.5f);
    Mesh mesh;
    mesh.primitives.push_back(p);
    M->meshes.push_back(mesh);
    Material m;
    m.alpha = Material::Alpha::Blend; m.doubleSided = true; m.metallic = 0; m.roughness = 1; m.name = "fan-contact";
    m.fanBase = vec4(0.1f, 0.13f, 0.22f, -1);   // (the shade's tint; w < 0: the contact shade)
    m.fanCol = vec4(0.9f, 0, 0, 1);             // (blobMaterial(shadows ? 0.6 : 0.9): the village's crowd casts none)
    M->materials.push_back(m);
    M->bmin = p.bmin; M->bmax = p.bmax;
    blob = M;
  }

  double groundY(double x, double z) const { return world ? world->height(x, z) : 0.0; }
  const std::vector<int>* cell(double x, double z) const {
    if (grid.empty()) return nullptr;
    auto it = grid.find(int64_t(std::floor(x / 8)) * 65536 + int64_t(std::floor(z / 8)));
    return it == grid.end() ? nullptr : &it->second;
  }

  // ---------------------------------------------------------------- peoplesim.js
  void spawnP(Folk& p, double x, double z, double yaw, bool shown, double vmax) {
    p.x = x; p.z = z; p.yaw = yaw; p.v = 0;
    p.y = groundY(x, z); p.gx = x; p.gz = z; p.hasG = true;
    p.alpha = shown ? 1 : 0; p.fadeTo = 1; p.onStage = true; p.down = false;
    p.hasPath = false; p.path.clear(); p.arrive = Arrive::None; p.hasFace = false; p.hasLook = false; p.talkTo = 0; p.holdTo = 0; p.hasGhost = false; p.carry = 0;
    if (vmax > 0) p.vmax = vmax;
    const size_t i = size_t(p.i);
    crowd.D.walk[i] = 0; crowd.D.talk[i] = 0; crowd.D.holdW[i] = 0; crowd.D.wph[i] = float(random());
    crowd.lookY[i] = 0; crowd.lookP[i] = 0;
  }
  void setPath(Folk& p, std::vector<dvec2> pts, Arrive a, const Stop* st = nullptr) {
    p.path = std::move(pts); p.hasPath = true; p.pi = 0; p.pathGen++; p.arrive = a; p.hasFace = false; p.talkTo = 0;
    if (st) p.arriveStop = *st;
  }
  void hide(Folk& p, double rate) { p.fadeTo = 0; p.fadeRate = rate; }
  void arrived(Folk& p) {
    Arrive a = p.arrive;
    p.arrive = Arrive::None;
    if (a == Arrive::Door) { hide(p, 1.8); p.state = St::Gone; }
    else if (a == Arrive::Stop) {
      const Stop& s = p.arriveStop;
      p.state = St::Stop; p.hasFace = true; p.face = s.face; p.hasLook = s.hasLook; p.look = s.look;
      if (s.hold) { p.hold = s.hold; p.holdTo = 1; }
      p.until = vtime + s.dur; p.stop = s; p.hasStop = true;
    }
  }
  // the pose inputs of somebody on the snow: no walking, talking, holding, looking about
  void calm(Folk& p, double dt) {
    const size_t i = size_t(p.i);
    auto& D = crowd.D;
    D.alpha[i] = float(p.alpha);
    const double k = std::min(1.0, dt * 7);
    D.walk[i] = float(D.walk[i] - D.walk[i] * k); D.talk[i] = float(D.talk[i] - D.talk[i] * k); D.holdW[i] = float(D.holdW[i] - D.holdW[i] * k);
    D.lookY[i] = 0; D.lookP[i] = 0;
  }
  // a body sliding / flying into a wall (the obstacles): out of it, the speed into it gone (and half the rest)
  double wallStop(Folk& p, Down& V) {
    double hit = 0;
    if (!(V.vx != 0 || V.vz != 0)) return hit;
    if (const auto* cl = cell(p.x, p.z))
      for (int oi : *cl) {
        const Obst& ob = obst[size_t(oi)];
        if (std::fabs(p.x - ob.x) > ob.reach || std::fabs(p.z - ob.z) > ob.reach) continue;
        double ux, uz, d;
        away(ob, p.x, p.z, ux, uz, d);
        if (d >= 0.35) continue;
        p.x += ux * (0.35 - d); p.z += uz * (0.35 - d);
        const double vn = V.vx * ux + V.vz * uz;
        if (vn < 0) { V.vx -= ux * vn * 1.2; V.vz -= uz * vn * 1.2; V.vx *= 0.5; V.vz *= 0.5; hit = std::max(hit, -vn); }
      }
    return hit;
  }
  // thrown by a vehicle (peoplesim.js updateThrown)
  void updateThrown(Folk& p, double dt) {
    Down& K = p.dn;
    const size_t i = size_t(p.i);
    float* m = &crowd.mat[i * 16];
    const double c = K.c;
    const double gy = groundY(p.x, p.z);
    if (K.state == Down::Up) {
      const double u = std::min(1.0, K.lt / K.up);
      K.lt += dt;
      const double a = K.aLie * (1 - u * u * (3 - 2 * u));
      p.y = gy; p.gx = p.x; p.gz = p.z; p.hasG = true;
      crowd.setPlace(p.i, p.x, p.y, p.z, p.yaw);
      if (std::fabs(a) > 1e-3) tilt(m, K.dz, -K.dx, a);
      calm(p, dt);
      if (u >= 1) { p.down = false; p.stuck = 0; }
      return;
    }
    if (K.state == Down::Fly) {
      K.vy -= G * dt; K.h += K.vy * dt;
      K.a += K.w * dt; K.r += K.rw * dt;
      p.x += K.vx * dt; p.z += K.vz * dt;
      const double floor = restH(c, K.a, K.r);
      if (K.h <= floor) {
        const double imp = -K.vy, k = imp > 3 ? 0.6 : 0.8;
        K.h = floor;
        K.vx *= k; K.vz *= k; K.w *= 0.5; K.rw *= 0.5;
        if (imp > 2.5) K.vy = imp * 0.3;   // a bounce
        else { K.vy = 0; K.state = Down::Tumble; K.w = K.w * 0.6 + std::min(9.0, std::hypot(K.vx, K.vz) * 1.2); K.lt = 0; }
      }
    } else {
      K.lt += dt;
      const double s = std::hypot(K.vx, K.vz);
      if (s > 1e-4) { const double k = std::max(0.0, s - 7.5 * dt) / s; K.vx *= k; K.vz *= k; }
      p.x += K.vx * dt; p.z += K.vz * dt;
      if (K.state == Down::Tumble) {
        if (!K.hasAT && (std::fabs(K.w) < 3 || (s < 2 && K.lt > 0.5))) {
          const double rest = K.a + (K.w * std::fabs(K.w)) / 14;
          K.aT = jsRound((rest - PI / 2) / PI) * PI + PI / 2; K.hasAT = true;
        }
        if (!K.hasAT) { K.w *= std::exp(-dt * (s < 1.5 ? 3 : 0.9)); K.a += K.w * dt; }
        else { const double d = K.a - K.aT, e = std::exp(-6 * dt), q = K.w + 6 * d; K.a = K.aT + (d + q * dt) * e; K.w = (K.w - q * 6 * dt) * e; }
        const double rT = jsRound(K.r / TAU) * TAU, dr = K.r - rT, er = std::exp(-5 * dt), qr = K.rw + 5 * dr;
        K.r = rT + (dr + qr * dt) * er; K.rw = (K.rw - qr * 5 * dt) * er;
        if ((K.hasAT && std::fabs(K.a - K.aT) < 0.05 && std::fabs(K.w) < 0.4 && std::fabs(K.r - rT) < 0.05 && s < 0.3) || K.lt > 5) {
          K.state = Down::Lie; K.lt = 0; K.vx = 0; K.vz = 0;
          K.a = K.hasAT ? K.aT : K.a;
          K.a -= jsRound(K.a / TAU) * TAU;
          if (std::fabs(std::fabs(K.a) - PI / 2) > 0.3) K.a = (K.a > 0 ? 1 : K.a < 0 ? -1 : 1) * PI / 2;
          K.r = 0; K.w = 0; K.rw = 0;
        }
      } else if (K.lt > K.lie) {
        // getting up about the feet: the body's centre is half a body from them, toward the head
        const double sa = std::sin(K.a);
        p.x -= K.dx * sa * c; p.z -= K.dz * sa * c;
        K.aLie = 1.45 * (sa > 0 ? 1 : sa < 0 ? -1 : 1);
        K.state = Down::Up; K.lt = 0;
        updateThrown(p, 0);
        return;
      }
      K.h = restH(c, K.a, K.r);
    }
    wallStop(p, K);
    const double g2 = groundY(p.x, p.z);
    crowd.setPlace(p.i, p.x, g2, p.z, p.yaw);
    tilt(m, K.dz, -K.dx, K.a, 0);
    if (K.r != 0) tilt(m, K.dx, K.dz, K.r, 0);
    const double sy = crowd.scl[i * 2 + 1] != 0 ? double(crowd.scl[i * 2 + 1]) : 1, k = c / sy;
    m[12] = float(p.x - m[4] * k); m[13] = float(g2 + K.h - m[5] * k); m[14] = float(p.z - m[6] * k);
    p.y = g2; p.gx = p.x; p.gz = p.z; p.hasG = true;
    calm(p, dt);
  }
  void simUpdate(double dt) {
    const int n = int(P.size());
    auto& D = crowd.D;
    for (int a = 0; a < n; a++) {
      Folk& p = P[size_t(a)];
      if (!p.onStage) continue;
      if (p.alpha != p.fadeTo) {
        const double s = dt * p.fadeRate;
        p.alpha = p.fadeTo > p.alpha ? std::min(p.fadeTo, p.alpha + s) : std::max(p.fadeTo, p.alpha - s);
        if (p.alpha <= 0 && p.fadeTo <= 0) { p.onStage = false; p.hasPath = false; p.v = 0; p.down = false; D.alpha[size_t(p.i)] = 0; continue; }
      }
      if (p.down) { updateThrown(p, dt); continue; }
      double ax = 0, az = 0;   // avoidance
      if (p.hasPath) {
        // the people close in front (walking) push the heading aside; standing people are walked round
        for (int b = 0; b < n; b++) {
          if (b == a) continue;
          const Folk& q = P[size_t(b)];
          if (!q.onStage || q.alpha < 0.3) continue;
          const double dx = p.x - q.x, dz = p.z - q.z, d2 = dx * dx + dz * dz;
          if (d2 > 2.6 || d2 < 1e-6) continue;
          const double fx = std::sin(p.yaw), fz = std::cos(p.yaw);
          if (-(dx * fx + dz * fz) < -0.2) continue;   // behind me
          const double d = std::sqrt(d2), k = (1.6 - d) / (d * 1.6) * (q.hasPath ? 0.7 : 1.2);
          ax += dx * k; az += dz * k;
        }
        // the player (walking people step round you)
        if (hasPlayer) {
          const double dx = p.x - player.x, dz = p.z - player.y, d2 = dx * dx + dz * dz;
          if (d2 < 4 && d2 > 1e-6 && (dx * std::sin(p.yaw) + dz * std::cos(p.yaw)) < 0.3) { const double d = std::sqrt(d2), k = (2 - d) / (d * 2) * 1.4; ax += dx * k; az += dz * k; }
        }
        // lamps, benches, stalls, buildings: steer round them (not near the door the person walks through)
        const bool ghost = p.hasGhost && std::pow(p.x - p.ghostAt.x, 2) + std::pow(p.z - p.ghostAt.y, 2) < 16;
        if (!ghost)
          if (const auto* cl = cell(p.x, p.z))
            for (int oi : *cl) {
              const Obst& c = obst[size_t(oi)];
              if (std::fabs(p.x - c.x) > c.reach || std::fabs(p.z - c.z) > c.reach) continue;
              double ux, uz, d;
              away(c, p.x, p.z, ux, uz, d);
              if (d > 1.3) continue;
              if ((ux * std::sin(p.yaw) + uz * std::cos(p.yaw)) > 0.5 && d > 0.5) continue;   // (behind: walking away from it)
              const double k = (1.3 - std::max(0.0, d)) * 1.1;
              ax += ux * k; az += uz * k;
            }
        const dvec2 tg = p.path[size_t(p.pi)];
        const double dx = tg.x - p.x, dz = tg.y - p.z, d = std::hypot(dx, dz);
        const bool last = p.pi == int(p.path.size()) - 1;
        // (no headway for 2 s - somebody stands on the spot, a corner: count it as reached)
        if (p.tgGen != p.pathGen || p.tgIdx != p.pi || d < p.bestD - 0.05) { p.tgGen = p.pathGen; p.tgIdx = p.pi; p.bestD = d; p.stuck = 0; }
        else p.stuck += dt;
        if (d < (last ? 0.06 : 0.5) || p.stuck > 2) {
          p.stuck = 0;
          if (!last) p.pi++;
          else { p.hasPath = false; arrived(p); }
        } else {
          const double ux = dx / d + ax * 0.8, uz = dz / d + az * 0.8;
          const double want = std::atan2(ux, uz), err = wrapA(want - p.yaw);
          p.yaw = wrapA(p.yaw + std::max(-dt * 4.2, std::min(dt * 4.2, err)));
          const double vWant = (last ? std::min(p.vmax, 0.18 + d * 1.25) : p.vmax) * std::max(0.15, std::cos(err));
          p.v += std::max(-dt * 2.6, std::min(dt * 1.5, vWant - p.v));
          p.x += std::sin(p.yaw) * p.v * dt; p.z += std::cos(p.yaw) * p.v * dt;
        }
      }
      if (!p.hasPath) {
        p.v = std::max(0.0, p.v - dt * 3);
        if (p.v > 0) { p.x += std::sin(p.yaw) * p.v * dt; p.z += std::cos(p.yaw) * p.v * dt; }
        if (p.hasFace) { const double err = wrapA(p.face - p.yaw); p.yaw = wrapA(p.yaw + std::max(-dt * 1.9, std::min(dt * 1.9, err))); }
        // standing people never overlap (a soft push apart)
        for (int b = a + 1; b < n; b++) {
          Folk& q = P[size_t(b)];
          if (!q.onStage || q.hasPath) continue;
          const double dx = p.x - q.x, dz = p.z - q.z, d2 = dx * dx + dz * dz;
          if (d2 > 0.3 || d2 < 1e-6) continue;
          const double d = std::sqrt(d2), push = (0.55 - d) * 0.5 * std::min(1.0, dt * 3) / d;
          p.x += dx * push; p.z += dz * push; q.x -= dx * push; q.z -= dz * push;
        }
      }
      // never inside a lamp post, a bench, a wall (unless walking through a door)
      if (!(p.hasGhost && std::pow(p.x - p.ghostAt.x, 2) + std::pow(p.z - p.ghostAt.y, 2) < 16))
        if (const auto* cl = cell(p.x, p.z))
          for (int oi : *cl) {
            const Obst& c = obst[size_t(oi)];
            if (std::fabs(p.x - c.x) > c.reach || std::fabs(p.z - c.z) > c.reach) continue;
            double ux, uz, d;
            away(c, p.x, p.z, ux, uz, d);
            if (d < 0.32) { const double k = std::min(0.32 - d, 0.12); p.x += ux * k; p.z += uz * k; }
          }
      if (!p.hasG || std::pow(p.x - p.gx, 2) + std::pow(p.z - p.gz, 2) > 0.04) { p.y = groundY(p.x, p.z); p.gx = p.x; p.gz = p.z; p.hasG = true; }
      // ---- pose inputs
      const size_t i = size_t(p.i);
      crowd.setPlace(p.i, p.x, p.y, p.z, p.yaw);
      D.alpha[i] = float(p.alpha);
      const double wt = std::min(1.0, p.v / 0.75);
      D.walk[i] = float(D.walk[i] + (wt - D.walk[i]) * std::min(1.0, dt * 7));
      D.wph[i] = float(std::fmod(D.wph[i] + (p.v * dt) / WALK_STRIDE, 1.0));
      D.talk[i] = float(D.talk[i] + (p.talkTo - D.talk[i]) * std::min(1.0, dt * 1.6));
      // a held pose: ease out before switching to another one
      if (p.holdTo && D.hold[i] != p.hold && D.holdW[i] < 0.02f) D.hold[i] = uint8_t(p.hold);
      const double hw = p.holdTo && D.hold[i] == p.hold ? 1 : 0;
      D.holdW[i] = float(D.holdW[i] + (hw - D.holdW[i]) * std::min(1.0, dt * 2.2));
      D.carry[i] = uint8_t(p.carry);
      double ly = 0, lp = 0.02;
      if (p.hasLook) {
        ly = wrapA(std::atan2(p.look.x - p.x, p.look.z - p.z) - p.yaw);
        ly = std::max(-1.15, std::min(1.15, ly));
        if (p.look.hasY) lp = std::max(-0.35, std::min(0.4, -std::atan2(p.look.y - p.y - 1.55, std::hypot(p.look.x - p.x, p.look.z - p.z))));
      }
      D.lookY[i] = float(ly * (1 - D.walk[i] * 0.6)); D.lookP[i] = float(lp);
    }
  }

  // ---------------------------------------------------------------- townsfolk.js Village
  dvec2 ringPt(double a, double lane) const { return dvec2(C.x + std::cos(a) * (RING + lane), C.y + std::sin(a) * (RING + lane)); }
  std::vector<dvec2> route(const dvec2& from, const dvec2& to) {
    const double lane = (rnd() - 0.5) * 1.8;
    const double a0 = angC(from.x, from.y), a1 = angC(to.x, to.y);
    const double r0 = std::hypot(from.x - C.x, from.y - C.y), r1 = std::hypot(to.x - C.x, to.y - C.y);
    std::vector<dvec2> pts;
    // (inside the ring or right beside it: straight there)
    if (std::fabs(wrapA(a1 - a0)) < 0.5 || (r0 < RING + 4 && r1 < RING + 4 && std::fabs(wrapA(a1 - a0)) < 1.2)) { pts.push_back(to); return pts; }
    if (r0 > RING + 2) pts.push_back(ringPt(a0, lane));
    const double da = wrapA(a1 - a0);
    const int steps = std::max(1, int(std::ceil(std::fabs(da) / 0.3)));
    for (int k = 1; k < steps; k++) pts.push_back(ringPt(a0 + (da * k) / steps, lane));
    if (r1 > RING + 2) pts.push_back(ringPt(a1, lane));
    pts.push_back(to);
    return pts;
  }
  int pickDoor(int kinds) {
    std::vector<int> list;
    double tot = 0;
    for (size_t d = 0; d < doors.size(); d++) if (doors[d].kind & kinds) { list.push_back(int(d)); tot += doors[d].w; }
    double r = rnd() * tot;
    for (int d : list) { r -= doors[size_t(d)].w; if (r <= 0) return d; }
    return list.empty() ? 0 : list[0];
  }
  Folk* freeP() { for (auto& p : P) if (!p.onStage) return &p; return nullptr; }
  int onStageCount() const { int k = 0; for (auto& p : P) if (p.onStage && p.fadeTo > 0) k++; return k; }

  // a plan as a list of stops (the last one: where the person leaves)
  std::deque<Stop> agenda(int plan) {
    std::deque<Stop> out;
    auto tree = [&]() {
      Stop s;
      const double a = rnd() * PI * 2, r = 4.2 + rnd() * 1.6, x = C.x + std::cos(a) * r, z = C.y + std::sin(a) * r;
      s.at = dvec2(x, z); s.face = std::atan2(C.x - x, C.y - z);
      s.hasLook = true; s.look = {C.x, C.y, groundY(0, -4) + 7, true};
      s.hold = rnd() < 0.5 ? int(PHONE) : 0;
      s.dur = 6 + rnd() * 8;
      return s;
    };
    auto stall = [&]() {
      Stop s;
      const double* m = MARKET[int(std::floor(rnd() * 3))];
      const double z = m[1] + (rnd() - 0.5) * 2.4;
      s.at = dvec2(m[0] - 2.7, z); s.face = PI / 2;
      s.hold = rnd() < 0.4 ? int(HOLD) : 0;
      s.dur = 10 + rnd() * 14; s.chat = true;
      return s;
    };
    auto fire = [&]() {
      Stop s;
      const double a = rnd() * PI * 2, r = 1.7 + rnd() * 0.5, x = FIRE.x + std::cos(a) * r, z = FIRE.y + std::sin(a) * r;
      s.at = dvec2(x, z); s.face = std::atan2(FIRE.x - x, FIRE.y - z); s.hold = HOLD;
      s.dur = 14 + rnd() * 20; s.chat = true;
      return s;
    };
    auto map = [&]() {
      Stop s;
      const double x = 8 + (rnd() - 0.5) * 2.2;
      const double z = -21.6 + rnd() * 0.8;
      s.at = dvec2(x, z); s.face = PI;
      s.hold = rnd() < 0.5 ? int(POINT) : 0;
      s.hasLook = true; s.look = {8, -24, groundY(8, -24) + 1.8, true};
      s.dur = 6 + rnd() * 6;
      return s;
    };
    auto booth = [&]() { Stop s; s.at = boothAt; s.face = boothFace; s.dur = 5 + rnd() * 5; return s; };
    auto window = [&]() {
      Stop s;
      const double x = shopWindow.x + (rnd() - 0.5) * 1.5;
      const double z = shopWindow.y + (rnd() - 0.5) * 1.5;
      s.at = dvec2(x, z); s.face = shopFace; s.dur = 5 + rnd() * 8;
      return s;
    };
    auto busWait = [&]() {
      Stop s;
      // roads.js stopWaitArea pick(rnd): beside the road (the sign and the bench kept clear)
      const double rx = -WAIT_DIR.y, rz = WAIT_DIR.x;
      dvec2 at(WAIT_ROAD.x + rx * (ROAD_HALF + 5), WAIT_ROAD.y + rz * (ROAD_HALF + 5));
      for (int k = 0; k < 16; k++) {
        const double u = (rnd() - 0.5) * 10;
        const double v = ROAD_HALF + 2 + rnd() * 4;
        if (std::fabs(u) < 3 && v < ROAD_HALF + 4.4) continue;
        at = dvec2(WAIT_ROAD.x + WAIT_DIR.x * u + rx * v, WAIT_ROAD.y + WAIT_DIR.y * u + rz * v);
        break;
      }
      s.at = at; s.face = WAIT_FACE + (rnd() - 0.5) * 1.2;
      s.hold = rnd() < 0.45 ? int(PHONE) : 0;
      s.dur = 30 + rnd() * 60; s.chat = true;
      return s;
    };
    auto leave = [&](int kinds) { Stop s; s.door = pickDoor(kinds); return s; };
    if (plan == SKI) {
      if (rnd() < 0.35) out.push_back(map());
      if (rnd() < 0.3) out.push_back(booth());
      Stop s;
      s.door = rnd() < 0.75 ? gondola : pickDoor(GONDOLA);
      out.push_back(s);
    } else if (plan == BACK) {
      if (rnd() < 0.3) out.push_back(fire());
      out.push_back(leave(rnd() < 0.7 ? HOTEL : SHOP));
    } else if (plan == MARKET_P) {
      out.push_back(stall());
      if (rnd() < 0.6) out.push_back(stall());
      if (rnd() < 0.7) out.push_back(fire());
      if (rnd() < 0.3) out.push_back(tree());
      out.push_back(leave(HOTEL | GONDOLA));   // ('bus' doors: none)
    } else if (plan == SHOP_P) {
      out.push_back(window());
      Stop s;
      s.door = shop;
      out.push_back(s);
    } else if (plan == BUS) {
      out.push_back(busWait());
      out.push_back(leave(HOTEL));
    } else {
      out.push_back(tree());
      if (rnd() < 0.5) out.push_back(rnd() < 0.5 ? map() : stall());
      out.push_back(leave(HOTEL | SHOP | GONDOLA));
    }
    return out;
  }
  // to the next stop of the plan
  void next(Folk& p, const dvec2* from = nullptr) {
    if (p.todo.empty()) { hide(p, 1.5); p.state = St::Gone; return; }
    Stop stop = p.todo.front();
    p.todo.pop_front();
    p.state = St::Walk; p.holdTo = 0; p.hasLook = false; p.talkTo = 0; p.hasFace = false;
    const dvec2 here = from ? *from : dvec2(p.x, p.z);
    std::vector<dvec2> pts;
    if (from) pts.push_back(*from);
    if (stop.door >= 0) {
      const Door& d = doors[size_t(stop.door)];
      for (auto& q : route(here, d.out)) pts.push_back(q);
      pts.push_back(d.in);
      setPath(p, std::move(pts), Arrive::Door);
      p.hasGhost = true; p.ghostAt = d.in;   // (into the building through its door)
      return;
    }
    for (auto& q : route(here, stop.at)) pts.push_back(q);
    if (!from) p.hasGhost = false;
    setPath(p, std::move(pts), Arrive::Stop, &stop);
  }
  // someone comes out of a door with something to do
  void spawn(bool shown) {
    Folk* pp = freeP();
    if (!pp) return;
    Folk& p = *pp;
    const double r = rnd();
    int from, plan;
    if (r < 0.26) { from = pickDoor(HOTEL | SHOP); plan = SKI; }            // off to the gondola, skis on the shoulder
    else if (r < 0.42) { from = pickDoor(GONDOLA); plan = BACK; }          // back from the slopes
    else if (r < 0.62) { from = pickDoor(HOTEL | GONDOLA); plan = MARKET_P; }
    else if (r < 0.74) { from = pickDoor(HOTEL | GONDOLA); plan = SHOP_P; }
    else if (r < 0.84) { from = pickDoor(HOTEL | SHOP | GONDOLA); plan = BUS; }
    else { from = pickDoor(HOTEL | SHOP | GONDOLA); plan = STROLL; }
    const Door fd = doors[size_t(from)];
    const dvec2 at = fd.in;
    const double sx = at.x + (rnd() - 0.5) * 0.8;
    const double sz = at.y + (rnd() - 0.5) * 0.8;
    const double vmax = 1.15 + rnd() * 0.25;
    spawnP(p, sx, sz, std::atan2(fd.out.x - at.x, fd.out.y - at.y), false, vmax);
    p.plan = plan; p.carry = plan == SKI || plan == BACK ? 1 : 0;
    p.hasGhost = true; p.ghostAt = fd.in;   // (walking out of the building)
    p.todo = agenda(plan);
    p.state = St::Walk;
    // a friend along (a third of them): the same plan, side by side, stopping together (and talking: chats())
    Folk* mate = nullptr;
    if (plan != SKI && plan != BACK && rnd() < 0.35 && (mate = freeP())) {
      const double ox = (rnd() < 0.5 ? 1 : -1) * 0.85;
      spawnP(*mate, p.x + ox * 0.6, p.z + ox * 0.6, p.yaw, false, p.vmax);
      mate->plan = plan; mate->hasGhost = true; mate->ghostAt = fd.in; mate->state = St::Walk;
      mate->todo.clear();
      for (Stop st : p.todo) {
        if (st.door < 0) { st.at = dvec2(st.at.x + ox, st.at.y + ox * 0.5); st.chat = true; }
        mate->todo.push_back(st);
      }
      for (auto& st : p.todo) if (st.door < 0) st.chat = true;
    }
    next(p, &fd.out);
    if (mate) { const dvec2 o2(fd.out.x + 0.7, fd.out.y + 0.7); next(*mate, &o2); }
    if (shown) {
      // stage set: somewhere along the way already
      const int k0 = int(std::floor(rnd() * double(p.hasPath && !p.path.empty() ? p.path.size() : 1)));
      for (Folk* q : {&p, mate}) {
        if (!q) continue;
        q->alpha = 1;
        if (q->hasPath && q->path.size() > 1) {
          const int k = std::min(k0, int(q->path.size()) - 1);
          const dvec2 w = q->path[size_t(k)];
          q->x = w.x + (q == mate ? 0.8 : 0); q->z = w.y;
          q->pi = std::min(k + 1, int(q->path.size()) - 1);
        }
      }
    }
  }
  // people standing at the same place (fire pit, stall, bus stop) talk now and then
  void chats() {
    for (auto& p : P) {
      if (!p.onStage || p.state != St::Stop || !p.hasStop || !p.stop.chat) { if (p.state != St::Stop) p.talkTo = 0; continue; }
      const Folk* mate = nullptr;
      double best = 9;
      for (const auto& q : P) {
        if (&q == &p || !q.onStage || q.state != St::Stop) continue;
        const double d = std::pow(q.x - p.x, 2) + std::pow(q.z - p.z, 2);
        if (d < best) { best = d; mate = &q; }
      }
      if (!mate) { p.talkTo = 0; continue; }
      // turn toward the other one; whoever's turn it is talks with the hands
      p.hasFace = true;
      p.face = std::atan2(mate->x - p.x, mate->z - p.z) * 0.7 + p.stop.face * 0.3;
      p.hasLook = true; p.look = {mate->x, mate->z, 0, false};
      p.talkTo = std::sin(vtime * 0.35 + p.i * 1.7) > 0.2 ? 1 : 0.2;
    }
  }
  void villageUpdate(double dt, double night) {
    vtime += dt;
    const int want = int(jsRound(double(P.size()) * (0.78 - 0.5 * night)));
    if (!active) {
      active = true;
      if (idleFor > 60) for (int k = 0; k < want * 0.8; k++) spawn(true);
    }
    idleFor = 0;
    spawnT -= dt;
    if (spawnT <= 0) { spawnT = 1.2 + rnd() * 2.5; if (onStageCount() < want) spawn(false); }
    for (auto& p : P) {
      if (!p.onStage) continue;
      if (p.state == St::Stop && vtime > p.until) { p.holdTo = 0; next(p); }
    }
    if (++frame % 10 == 0) chats();
    simUpdate(dt);
  }
};

// ================================================================ PeopleSim
PeopleSim::PeopleSim() : I_(std::make_unique<Impl>()) {}
PeopleSim::~PeopleSim() = default;

void PeopleSim::setKits(const std::vector<std::shared_ptr<FanKit>>& kits) { I_->kits = kits; }

void PeopleSim::init(World& world, const std::vector<std::vector<dvec2>>&, int fans, int) {
  Impl& S = *I_;
  S.world = &world;
  pos_.clear();
  if (S.kits.empty() || fans <= 0) { SL_WARN("townsfolk: no crowd characters"); return; }
  // the doors (townsfolk.js Village: the hotels face the plaza, their door on the front ~7 m from the middle)
  for (auto& h : HOTELS) {
    const double x = h[0], z = h[1], l = std::hypot(x, z);
    S.doors.push_back({HOTEL, dvec2(x - (x / l) * 7.4, z - (z / l) * 7.4), dvec2(x - (x / l) * 12.5, z - (z / l) * 12.5), 1});
  }
  S.shopIn = SHOP_DOOR - SHOP_FRONT * 1.4; S.shopOut = SHOP_DOOR + SHOP_FRONT * 1.6;
  S.shopFace = std::atan2(-SHOP_FRONT.x, -SHOP_FRONT.y);
  S.shopWindow = dvec2(SHOP_DOOR.x + SHOP_FRONT.x * 1.5 + SHOP_FRONT.y * 2.4, SHOP_DOOR.y + SHOP_FRONT.y * 1.5 - SHOP_FRONT.x * 2.4);
  S.shop = int(S.doors.size());
  S.doors.push_back({SHOP, S.shopIn, S.shopOut, 1.4});
  S.gondola = int(S.doors.size());
  S.doors.push_back({GONDOLA, dvec2(0, -62), dvec2(0, -53), 2});
  for (auto& l : VILLAGE_LIFTS) S.doors.push_back({GONDOLA, dvec2(l[0] - l[2] * 9, l[1] - l[3] * 9), dvec2(l[0] - l[2] * 16, l[1] - l[3] * 16), 1});
  S.boothAt = BOOTH_COUNTER + BOOTH_FRONT * 0.5;
  S.boothFace = std::atan2(-BOOTH_FRONT.x, -BOOTH_FRONT.y);
  S.center = dvec3(0, world.height(0, -4), -4);
  S.bcenter = dvec3(0, world.height(0, 0), 0);
  // the crowd (fans.js FanCrowd, dynamic): its people's characters, sizes, personalities and colours from the same
  // mulberry32(6612) draws as townsfolk.js's
  S.crowd.init(S.kits, fans, [&S]() { return S.rnd(); });
  S.P.resize(size_t(fans));
  for (int i = 0; i < fans; i++) { S.P[size_t(i)].i = i; S.crowd.D.alpha[size_t(i)] = 0; }
  S.looks.resize(size_t(fans));
  pos_.assign(size_t(fans), dvec3(1e9));
  SL_INFO("townsfolk: %d crowd people (%zu characters), %zu doors", fans, S.kits.size(), S.doors.size());
}

void PeopleSim::update(double dt, const dvec3& cam, double night, const Scenery* scenery) {
  Impl& S = *I_;
  if (!S.world || S.P.empty()) return;
  if (!S.gridBuilt && scenery) {
    // obstacles near the plaza (lamps, benches, stalls, signs, racks, buildings) for walking round them (8 m cells)
    S.gridBuilt = true;
    for (const Collider& c : scenery->colliders()) {
      if (std::fabs(c.x) >= 170 || std::fabs(c.z) >= 170) continue;
      Obst o{c.x, c.z, c.r, c.hw, c.hd, c.rot, (c.r >= 0 ? c.r : std::hypot(c.hw, c.hd)) + 1.6};
      const int idx = int(S.obst.size());
      S.obst.push_back(o);
      for (int64_t i = int64_t(std::floor((o.x - o.reach) / 8)); i <= int64_t(std::floor((o.x + o.reach) / 8)); i++)
        for (int64_t j = int64_t(std::floor((o.z - o.reach) / 8)); j <= int64_t(std::floor((o.z + o.reach) / 8)); j++) S.grid[i * 65536 + j].push_back(idx);
    }
  }
  S.player = player_; S.hasPlayer = hasPlayer_;
  S.lastDt = dt;
  S.ttime = std::fmod(S.ttime + dt, 3600.0);
  const double nightK = clampd(night, 0, 1);
  S.awake = std::hypot(cam.x - S.center.x, cam.z - S.center.z) < 260 && cam.y < S.center.y + 400;
  if (S.awake) { if (dt > 0) S.villageUpdate(dt, nightK); }
  else { S.visible = false; S.idleFor += dt; S.active = false; }
  for (size_t i = 0; i < S.P.size(); i++) {
    const Impl::Folk& p = S.P[i];
    pos_[i] = p.onStage ? dvec3(p.x, p.y, p.z) : dvec3(1e9);
  }
}

void PeopleSim::submit(Renderer& r, const dvec3& cam) {
  Impl& S = *I_;
  drawn_ = 0;
  if (!S.awake || S.P.empty()) { S.visible = false; return; }
  FanCrowd& c = S.crowd;
  const double dt = S.lastDt;
  // fans.js FanCrowd.update: the crowd's bounds (the village: 150 m round the plaza) in reach
  const dvec3 sc = S.bcenter + dvec3(0, 1, 0);
  if (glm::length(cam - sc) >= VIEW + 150 || !r.visible(sc - dvec3(150), sc + dvec3(150))) { S.visible = false; return; }
  if (!S.visible) { S.visible = true; std::fill(c.stale.begin(), c.stale.end(), 1); }
  c.frame++;
  S.draws.clear();
  for (int i = 0; i < c.n; i++) {
    const size_t u = size_t(i);
    const dvec3 pp(c.pos[u * 3], c.pos[u * 3 + 1], c.pos[u * 3 + 2]);
    const double d = glm::length(pp - cam);
    c.dist[u] = float(d);
    const double a = c.D.alpha[u];   // (people off stage are not drawn; walking on / off they fade in and out)
    const double edge = (1 - sstep(VIEW * 0.86, VIEW, d)) * a;
    if (edge <= 0.002) { c.lod[u] = -1; c.next[u] = -1; c.fade[u] = 1; c.inView[u] = 0; continue; }
    const int cur = c.lod[u];
    const int want = cur < 0 ? (d < LOD_NEAR ? 0 : d < LOD_MID ? 1 : 2)
                              : (d < LOD_NEAR - (cur == 0 ? -2 : 2) ? 0 : d < LOD_MID - (cur <= 1 ? -3 : 3) ? 1 : 2);
    if (cur < 0) { c.lod[u] = int8_t(want); c.fade[u] = 1; }
    else if (c.fade[u] >= 1 && want != cur) { c.next[u] = int8_t(want); c.fade[u] = 0; }
    if (c.fade[u] < 1) {
      c.fade[u] = float(c.fade[u] + dt / LOD_FADE);
      if (c.fade[u] >= 1) { c.lod[u] = c.next[u]; c.next[u] = -1; c.fade[u] = 1; }
    }
    // off screen: keeps its LOD state, not drawn (nor posed: re-posed when it comes into view)
    if (!r.visible(pp - dvec3(1.5), pp + dvec3(1.5))) { c.inView[u] = 0; continue; }
    c.inView[u] = 1;
    if (c.fade[u] < 1 && a >= 1) {
      const float f = c.fade[u];
      S.draws.push_back({i, c.lod[u], -f - 2});   // outgoing LOD: where the dither is >= f
      S.draws.push_back({i, c.next[u], f});       // incoming LOD: where it is < f
    } else S.draws.push_back({i, c.lod[u], edge >= 1 ? 1.f : float(edge)});
  }
  // poses (people walking or talking every frame near, every 2nd / 3rd further out)
  for (int i = 0; i < c.n; i++) {
    const size_t u = size_t(i);
    if (c.lod[u] < 0 || c.rag[u]) continue;
    if (!c.inView[u]) { c.stale[u] = 1; continue; }
    const int l = c.lod[u];
    const bool busy = c.D.walk[u] > 0.02f || c.D.talk[u] > 0.04f || (c.D.holdW[u] > 0.02f && c.D.holdW[u] < 0.98f);
    const int every = (l == 0 ? 1 : l == 1 ? 2 : c.dist[u] > 110 ? 4 : 3) * (busy ? 1 : 2);
    if (c.stale[u] || (c.frame + i) % every == 0) { c.poseDyn(i, S.ttime, dt * every); c.stale[u] = 0; }
  }
  // draw: per person its LODs' models (its jacket colour, the fade), the carried skis
  int last = -1;
  for (size_t e = 0; e < S.draws.size(); e++) {
    const auto& D = S.draws[e];
    const size_t u = size_t(D.i);
    const FanKit& K = *c.kits[c.kit[u]];
    Impl::Look& L = S.looks[u];
    if (!L.lod[D.l] && K.lod[D.l]) {
      L.lod[D.l] = std::make_shared<Model>(*K.lod[D.l]);
      for (auto& m : L.lod[D.l]->materials) m.fanCol = vec4(c.palC[u * 8], c.palC[u * 8 + 1], c.palC[u * 8 + 2], 1);
    }
    if (!L.lod[D.l]) continue;
    if (D.i != last) {
      L.pose.joints.resize(NB);
      for (int b = 0; b < NB; b++) L.pose.joints[size_t(b)] = skinMatrix(c.row(D.i) + b * 12);
    }
    const float* m = &c.mat[u * 16];
    mat4 local(1);
    for (int col = 0; col < 3; col++) local[col] = vec4(m[col * 4], m[col * 4 + 1], m[col * 4 + 2], 0);
    const dvec3 origin(m[12], m[13], m[14]);
    L.lod[D.l]->materials[0].fanCol.w = D.f;
    r.submitModel(*L.lod[D.l], origin, local, &L.pose, false);
    // the carried skis (shown in every LOD: one draw, solid through a cross-fade)
    const bool crossing = e + 1 < S.draws.size() && S.draws[e + 1].i == D.i;
    if (D.i != last && c.palC[u * 8 + 3] > 2.5f) {
      const int sch = std::min(5, std::max(0, int(c.palC[u * 8 + 7])));
      if (!L.skis && K.skis[sch]) L.skis = std::make_shared<Model>(*K.skis[sch]);
      if (L.skis) {
        for (auto& mm : L.skis->materials) mm.fanCol = vec4(-1, 0, 0, crossing ? 1.f : D.f);
        r.submitModel(*L.skis, origin, local, &L.pose, false);
      }
    }
    if (D.i != last) drawn_++;
    last = D.i;
  }
  // contact shades follow the people (shrinking as they fade out; none under the ones off stage)
  if (!S.blob) S.buildBlob(r.device());
  S.blobInst.clear();
  for (int i = 0; i < c.n; i++) {
    const size_t u = size_t(i);
    const double a = c.lod[u] < 0 ? 0 : double(c.D.alpha[u]);
    if (a <= 0) continue;
    const float* m = &c.mat[u * 16];
    const double sx = c.scl[u * 2] != 0 ? double(c.scl[u * 2]) : 1, k = c.scl[u * 2] * a, cs = m[0] / sx, sn = m[8] / sx;
    glm::dmat4 B(1);
    B[0] = glm::dvec4(1.3 * k * cs, 0, -1.3 * k * sn, 0);
    B[1] = glm::dvec4(0, a, 0, 0);
    B[2] = glm::dvec4(k * sn, 0, k * cs, 0);
    B[3] = glm::dvec4(m[12], double(m[13]) + 0.025, m[14], 1);
    S.blobInst.push_back(MatrixInstanceBatch::pack(B, S.bcenter));
  }
  if (!S.blobInst.empty() && S.blob) {
    if (S.blobInst.size() > S.blobCap) {
      S.blobCap = uint32_t(std::max<size_t>(64, S.blobInst.size()));
      S.blobs = MatrixInstanceBatch();
      S.blobs.init(r.device(), *S.blob, S.blobCap);
    }
    S.blobs.upload(r.device(), S.blobInst);
    r.submitInstances(S.blobs, S.bcenter, 0, false);
  }
}

void PeopleSim::near(const dvec3& p, double r, std::vector<int>& out) const {
  out.clear();
  const Impl& S = *I_;
  if (!S.awake) return;
  for (size_t i = 0; i < S.P.size(); i++) {
    const Impl::Folk& f = S.P[i];
    if (!f.onStage || f.alpha <= 0.5 || f.down) continue;
    if (std::fabs(f.x - p.x) < r && std::fabs(f.z - p.z) < r && std::fabs(f.y - p.y) < 3) out.push_back(int(i));
  }
}

bool PeopleSim::down(int i) const { return I_->P[size_t(i)].down; }

// peoplehits.js knockPerson (a vehicle) -> PeopleSim.knock with launchFor's throw (the rigid figure: no rig to pose it)
void PeopleSim::knock(int i, double vx, double vz) {
  Impl& S = *I_;
  if (i < 0 || size_t(i) >= S.P.size()) return;
  Impl::Folk& p = S.P[size_t(i)];
  const double speed = std::hypot(vx, vz);
  const double dx = speed > 1e-6 ? vx / speed : 0, dz = speed > 1e-6 ? vz / speed : 1;
  // launchFor(speed): apex 0.3 m at 15 km/h, 1.9 at 50, 3.4 at 90+; a backward somersault with a twist
  const double kmh = speed * 3.6, R = S.random();
  Impl::Down K;
  K.vy = std::sqrt(2 * G * clampd((kmh - 8) * 0.045, 0, 3.4));
  const double vh = std::min(10.0, 1.2 + speed * 0.36);
  K.w = -clampd(speed * 0.3, 2, 8) * (0.8 + S.random() * 0.4);
  K.rw = (S.random() - 0.5) * clampd(speed * 0.15, 0.5, 3);
  K.lie = kmh < 25 ? 1.6 + R * 0.8 : 2.2 + clampd((kmh - 25) / 50, 0, 1) * 0.8 + R * 0.6;
  K.up = kmh < 25 ? 1.35 : kmh < 60 ? 1.8 : 2.4;
  K.c = BODY_C * (S.crowd.scl[size_t(i) * 2 + 1] != 0 ? double(S.crowd.scl[size_t(i) * 2 + 1]) : 1);
  K.h = K.c; K.dx = dx; K.dz = dz; K.vx = dx * vh; K.vz = dz * vh; K.state = Impl::Down::Fly;
  p.dn = K;
  p.down = true;
  p.v = 0;
  knocked++;
}

} // namespace sl
