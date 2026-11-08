#include "world/rail_sweep.h"
#include "core/log.h"
#include "engine/mesh_kit.h"
#include "world/transport.h"
#include "world/world.h"
#include <map>
#include <cmath>

namespace sl {

namespace {
constexpr double CHUNK = 250, STEP = 4, SLEEPER_GAP = 0.65, SLEEPER_R = 320;
int64_t ckey(int64_t a, int64_t b) { return (a << 32) ^ (b & 0xffffffff); }

// a cross-section [(lateral u, height v)...] swept between s0 and s1 along `frame` (position + right vector), as a
// strip of quads (the section's consecutive points); flip: faces the other way (a tube's lining seen from inside)
template <class F>
void sweep(Geo& g, const std::vector<dvec2>& sec, double s0, double s1, F frame, const dvec3& o, const vec3& col, bool flip = false) {
  if (s1 - s0 < 0.2 || sec.size() < 2) return;
  int n = std::max(1, int(std::ceil((s1 - s0) / STEP)));
  uint32_t base = uint32_t(g.pos.size());
  size_t m = sec.size();
  for (int i = 0; i <= n; i++) {
    double s = s0 + (s1 - s0) * i / n;
    dvec3 p, r;
    frame(s, p, r);
    for (size_t k = 0; k < m; k++) {
      dvec3 q = p + r * sec[k].x + dvec3(0, sec[k].y, 0);
      g.pos.push_back(vec3(q - o));
      g.col.push_back(col);
      g.uv.push_back(vec2(float(sec[k].x), float(s * 0.25)));
      // normal: perpendicular to the section's edge, in the cross plane
      dvec2 e = sec[std::min(k + 1, m - 1)] - sec[k > 0 ? k - 1 : 0];
      dvec2 nn = glm::normalize(dvec2(-e.y, e.x)) * (flip ? -1.0 : 1.0);
      g.nor.push_back(vec3(glm::normalize(r * nn.x + dvec3(0, nn.y, 0))));
    }
  }
  for (int i = 0; i < n; i++)
    for (size_t k = 0; k + 1 < m; k++) {
      uint32_t a = base + uint32_t(i * m + k), b = a + 1, c = a + uint32_t(m), d = c + 1;
      if (!flip) { g.idx.insert(g.idx.end(), {a, c, b, b, c, d}); }
      else { g.idx.insert(g.idx.end(), {a, b, c, b, d, c}); }
    }
}
// a rail: a 7 cm x 15 cm box section under the rail top at lateral u
std::vector<dvec2> railSec(double u) { return {{u - 0.035, -0.15}, {u - 0.035, 0}, {u + 0.035, 0}, {u + 0.035, -0.15}}; }
struct Spans { const std::vector<Span>* v; double len; bool ring; };
bool inSpans(const std::vector<Span>& v, double s, double len, bool ring) {
  for (const Span& t : v) {
    if (s > t.s0 && s < t.s1) return true;
    if (ring && ((s - len > t.s0 && s - len < t.s1) || (s + len > t.s0 && s + len < t.s1))) return true;
  }
  return false;
}
} // namespace

void RailSweep::build(gfx::Device& dev, const Transport& t) {
  dev_ = &dev;
  Material ballast, slab, steel, lining;
  ballast.baseColor = vec4(1); ballast.roughness = 0.97f; ballast.metallic = 0; ballast.vertexColor = true;
  slab = ballast; slab.roughness = 0.85f;
  steel = ballast; steel.roughness = 0.4f; steel.metallic = 0.8f;
  lining = ballast; lining.roughness = 0.9f; lining.doubleSided = true;
  const vec3 cBallast = hexColor("#6f6a63"), cSlab = hexColor("#9a9893"), cSteel = hexColor("#77797c"), cLining = hexColor("#8f8c86");

  auto doLine = [&](const Line& L, const std::vector<Span>& tunnels, const std::vector<Span>& bridges, bool express) {
    if (L.n < 2) return;
    const double TO = express ? t.express.trackOff : 0;
    auto centre = [&](double s, dvec3& p, dvec3& r) { Line::P q = L.at(s); p = dvec3(q.x, q.y, q.z); r = dvec3(-q.dz, 0, q.dx); };
    for (double c0 = 0; c0 < L.length - 0.5; c0 += CHUNK) {
      double c1 = std::min(L.length, c0 + CHUNK);
      Line::P m = L.at((c0 + c1) / 2);
      dvec3 o(m.x, m.y, m.z);
      Geo bed, det, lin;
      // split the chunk at the tunnels' and viaducts' ends
      std::vector<double> cuts{c0, c1};
      for (const auto* list : {&tunnels, &bridges})
        for (const Span& sp : *list) for (double s : {sp.s0, sp.s1}) { if (s > c0 && s < c1) cuts.push_back(s); if (L.ring && s - L.length > c0 && s - L.length < c1) cuts.push_back(s - L.length); }
      std::sort(cuts.begin(), cuts.end());
      for (size_t k = 0; k + 1 < cuts.size(); k++) {
        double a = cuts[k], b = cuts[k + 1], mid = (a + b) / 2;
        bool tn = inSpans(tunnels, mid, L.length, L.ring), br = inSpans(bridges, mid, L.length, L.ring);
        if (express) {
          if (tn || br) {
            for (double side : {-1.0, 1.0}) sweep(bed, {{side * TO - 1.4, -0.55}, {side * TO - 1.4, -0.25}, {side * TO + 1.4, -0.25}, {side * TO + 1.4, -0.55}}, a, b, centre, o, cSlab);
            if (tn) {
              // the double-track tube (expresstrack.js TUBE: walls at TW 5.7 to TS 2.6, the vault to TC 7.0, the floor at -0.62)
              std::vector<dvec2> tube{{-5.7, -0.62}, {-5.7, 2.6}};
              for (int i = 1; i < 12; i++) { double th = PI * i / 12; tube.push_back({-5.7 * std::cos(th), 2.6 + (7.0 - 2.6) * std::sin(th)}); }
              tube.push_back({5.7, 2.6}); tube.push_back({5.7, -0.62});
              sweep(lin, tube, a, b, centre, o, cLining, true);
              sweep(lin, {{5.7, -0.62}, {-5.7, -0.62}}, a, b, centre, o, cSlab, true);
            }
          } else sweep(bed, {{-TO - 2.45, -0.74}, {-TO - 1.6, -0.30}, {TO + 1.6, -0.30}, {TO + 2.45, -0.74}}, a, b, centre, o, cBallast);
          for (double side : {-1.0, 1.0}) for (double g : {-0.5, 0.5}) sweep(det, railSec(side * TO + g), a, b, centre, o, cSteel);
        } else {
          // the Wolkenspitzbahn (railroute.js trackTop): ballast crest -0.36 to 1.55 m, shoulders to -0.74 at 2.25 m;
          // the tunnels' slab -0.42 to 1.9 m; the passing loop's second track beside it
          auto track = [&](double off) {
            auto fr = [&](double s, dvec3& p, dvec3& r) { centre(s, p, r); p += r * off; };
            (void)fr;
            return fr;
          };
          for (double which : {0.0, 1.0}) {
            if (which > 0 && (b <= t.rail.loop.s0 || a >= t.rail.loop.s1)) continue;
            double la = which > 0 ? std::max(a, t.rail.loop.s0) : a, lb = which > 0 ? std::min(b, t.rail.loop.s1) : b;
            auto fr = [&](double s, dvec3& p, dvec3& r) { centre(s, p, r); p += r * (which > 0 ? t.loopOffset(s) : 0.0); };
            if (tn) sweep(bed, {{-1.9, -0.42}, {1.9, -0.42}}, la, lb, fr, o, cSlab);
            else if (!br) sweep(bed, {{-2.25, -0.74}, {-1.55, -0.36}, {1.55, -0.36}, {2.25, -0.74}}, la, lb, fr, o, cBallast);
            for (double g : {-0.5, 0.5}) sweep(det, railSec(g), la, lb, fr, o, cSteel);
          }
          (void)track;
        }
      }
      Chunk c;
      c.origin = o;
      auto up = [&](Geo& g, const Material& mt) -> std::shared_ptr<Model> {
        if (g.empty()) return nullptr;
        std::vector<std::pair<Geo, Material>> parts;
        parts.push_back({std::move(g), mt});
        return buildModel(dev, parts, "track");
      };
      c.bed = up(bed, ballast); c.detail = up(det, steel); c.lining = up(lin, lining);
      dvec3 mn(1e30), mx(-1e30);
      for (auto* mdl : {c.bed.get(), c.detail.get(), c.lining.get()}) if (mdl) { mn = glm::min(mn, o + dvec3(mdl->bmin)); mx = glm::max(mx, o + dvec3(mdl->bmax)); }
      if (mn.x > mx.x) continue;
      c.bmin = mn; c.bmax = mx;
      chunks_.push_back(std::move(c));
    }
    // the sleepers' places (railtrack.js / expresstrack.js: ~0.65 m apart; the express ones on both tracks)
    for (double s = 0; s < L.length; s += SLEEPER_GAP) {
      Line::P q = L.at(s);
      double yaw = std::atan2(q.dx, q.dz), pitch = std::atan(q.grade);
      bool tn = inSpans(tunnels, s, L.length, L.ring);
      for (double side : express ? std::vector<double>{-1, 1} : std::vector<double>{0}) {
        double off = side * TO;
        double top = express ? -0.15 : (tn ? -0.24 : -0.24);
        sleeperSpots_.push_back({dvec3(q.x - q.dz * off, q.y + top, q.z + q.dx * off), yaw, pitch});
      }
      if (!express && s > t.rail.loop.s0 && s < t.rail.loop.s1) {
        double off = t.loopOffset(s);
        if (off > 1.2) sleeperSpots_.push_back({dvec3(q.x - q.dz * off, q.y - 0.24, q.z + q.dx * off), yaw, pitch});
      }
    }
  };
  if (t.rail.ok) doLine(t.rail.line, t.rail.tunnels, t.rail.bridges, false);
  if (t.express.ok) doLine(t.express.line, t.express.tunnels, t.express.bridges, true);
  for (size_t i = 0; i < sleeperSpots_.size(); i++) {
    int64_t k = ckey(int64_t(std::floor(sleeperSpots_[i].p.x / 128)), int64_t(std::floor(sleeperSpots_[i].p.z / 128)));
    auto it = cellIndex_.find(k);
    if (it == cellIndex_.end()) { it = cellIndex_.emplace(k, int(sleeperCells_.size())).first; sleeperCells_.emplace_back(); }
    sleeperCells_[size_t(it->second)].push_back(int(i));
  }
  {
    Geo g = boxGeo(2.4f, 0.16f, 0.26f);   // express: 2.4 m concrete sleepers; the metre gauge's look the same from a train
    g.translate(0, -0.08f, 0);
    for (auto& c : g.col) c = vec3(1);
    if (g.col.size() < g.pos.size()) g.col.assign(g.pos.size(), vec3(1));
    Material m; m.baseColor = vec4(hexColor("#8f8c86"), 1); m.roughness = 0.9f; m.metallic = 0;
    std::vector<std::pair<Geo, Material>> parts{{g, m}};
    sleeper_ = buildModel(dev, parts, "sleeper");
    if (sleeper_) sleepers_.init(dev, *sleeper_, 6000);
  }
  SL_INFO("rail sweep: %zu track chunks, %zu sleepers", chunks_.size(), sleeperSpots_.size());
}

void RailSweep::buildGuardrails(gfx::Device& dev, const Transport& t, const World& world) {
  // per 256 m cell: the beam (a W-beam's face as two bands, galvanised, double sided) 0.45-0.8 m over the ground, a
  // post every ~2 m (bus.js: posts 2 m apart, the beam's top at ~0.75 m)
  std::map<std::pair<int, int>, Geo> cells;
  const vec3 galv = hexColor("#c9ced3"), post = hexColor("#8d9196");
  size_t n = 0;
  for (const Guardrail& g : t.rails) {
    if (g.tunnel) continue;   // (the road tunnels' walls are captured meshes)
    double len = std::hypot(g.bx - g.ax, g.bz - g.az);
    if (len < 0.05) continue;
    double mx = (g.ax + g.bx) / 2, mz = (g.az + g.bz) / 2;
    auto key = std::make_pair(int(std::floor(mx / 256)), int(std::floor(mz / 256)));
    Geo& geo = cells[key];
    dvec3 o((key.first + 0.5) * 256, 0, (key.second + 0.5) * 256);
    double ya = world.height(g.ax, g.az), yb = world.height(g.bx, g.bz);
    double dx = (g.bx - g.ax) / len, dz = (g.bz - g.az) / len;
    vec3 nrm(float(-dz), 0, float(dx));
    for (auto band : {std::pair<double, double>{0.45, 0.62}, std::pair<double, double>{0.62, 0.8}}) {
      uint32_t b0 = uint32_t(geo.pos.size());
      double off = band.first < 0.6 ? 0.02 : 0;   // (the W: the lower band set back a little)
      for (int k = 0; k < 4; k++) {
        bool end = k == 1 || k == 2, top = k >= 2;
        double x = end ? g.bx : g.ax, z = end ? g.bz : g.az, y = (end ? yb : ya) + (top ? band.second : band.first);
        geo.pos.push_back(vec3(float(x + nrm.x * off - o.x), float(y), float(z + nrm.z * off - o.z)));
        geo.nor.push_back(nrm); geo.col.push_back(galv); geo.uv.push_back(vec2(0));
      }
      geo.idx.insert(geo.idx.end(), {b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3});
    }
    for (double u = 0; u < len; u += 2.0) {
      Geo p = boxGeo(0.1f, 0.85f, 0.12f);
      double x = g.ax + dx * u, z = g.az + dz * u, y = world.height(x, z);
      p.rotateY(float(std::atan2(dx, dz)));
      p.translate(float(x - nrm.x * 0.12 - o.x), float(y + 0.42), float(z - nrm.z * 0.12 - o.z));
      p.col.assign(p.pos.size(), post);
      geo.append(p);
    }
    n++;
  }
  Material m;
  m.baseColor = vec4(1); m.roughness = 0.42f; m.metallic = 0.7f; m.vertexColor = true; m.doubleSided = true;
  for (auto& [k, geo] : cells) {
    if (geo.empty()) continue;
    dvec3 o((k.first + 0.5) * 256, 0, (k.second + 0.5) * 256);
    std::vector<std::pair<Geo, Material>> parts{{std::move(geo), m}};
    Chunk c;
    c.origin = o;
    c.detail = buildModel(dev, parts, "guardrail");
    if (!c.detail) continue;
    c.bmin = o + dvec3(c.detail->bmin); c.bmax = o + dvec3(c.detail->bmax);
    chunks_.push_back(std::move(c));
  }
  SL_INFO("guardrails: %zu lines swept in %zu cells", n, cells.size());
}

void RailSweep::rebuildSleepers(const dvec3& cam) {
  lastCam_ = cam;
  sleeperOrigin_ = dvec3(std::floor(cam.x), std::floor(cam.y), std::floor(cam.z));
  std::vector<MatrixInstanceBatch::Inst> inst;
  int64_t cx = int64_t(std::floor(cam.x / 128)), cz = int64_t(std::floor(cam.z / 128));
  int R = int(std::ceil(SLEEPER_R / 128));
  for (int64_t gx = cx - R; gx <= cx + R; gx++)
    for (int64_t gz = cz - R; gz <= cz + R; gz++) {
      auto it = cellIndex_.find(ckey(gx, gz));
      if (it == cellIndex_.end()) continue;
      for (int i : sleeperCells_[size_t(it->second)]) {
        const Sleeper& sp = sleeperSpots_[size_t(i)];
        if (glm::length(sp.p - cam) > SLEEPER_R) continue;
        glm::dmat4 M = glm::translate(glm::dmat4(1), sp.p) * glm::rotate(glm::dmat4(1), sp.yaw, dvec3(0, 1, 0)) * glm::rotate(glm::dmat4(1), -sp.pitch, dvec3(1, 0, 0));
        inst.push_back(MatrixInstanceBatch::pack(M, sleeperOrigin_));
        if (inst.size() >= 6000) break;
      }
    }
  sleepers_.upload(*dev_, inst);
}

void RailSweep::submit(Renderer& r, const dvec3& cam) {
  for (const Chunk& c : chunks_) {
    dvec3 q = glm::clamp(cam, c.bmin, c.bmax);
    double d = glm::length(q - cam);
    if (d > 2600) continue;
    bool vis = r.visible(c.bmin, c.bmax), cast = d < 250 && r.castsShadow(c.bmin, c.bmax);
    if (!vis && !cast) continue;
    if (c.bed) r.submitModel(*c.bed, c.origin, mat4(1), nullptr, false, 0, vis);
    if (c.detail && d < 800) r.submitModel(*c.detail, c.origin, mat4(1), nullptr, cast, 0, vis);
    if (c.lining && d < 900) r.submitModel(*c.lining, c.origin, mat4(1), nullptr, false, 0, vis);
  }
  if (sleeper_ && dev_) {
    if (glm::length(cam - lastCam_) > 30) rebuildSleepers(cam);
    if (sleepers_.count()) r.submitInstances(sleepers_, sleeperOrigin_, 0, false);
  }
}

} // namespace sl
