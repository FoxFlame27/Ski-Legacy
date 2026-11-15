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

namespace {
// bus.js railGeometry: one 4 m section in its own frame (x along 0..SEG, y up from the snow, z outward, away from the
// road): the beam a single sheet with the W profile (two waves toward the road, its valley on the spacers), C-posts at 1
// and 3 m (0.45 m in the ground) with their flanges, the spacer blocks; the amber reflector in the valley at the first
// post. Colours: the galvanised steel (galvTexture's ground #c3c8cd x the material's #e4e8ec), the road grime low down
// on the beam (its gradient over the lowest 38 %)
constexpr double SEG = 4, BEAM_LO = 0.38, BEAM_TOP = 0.68, WAVE = 0.083, RAIL_FAR = 400;
struct RailTpl { Geo galv, refl; };
const RailTpl& railTpl() {
  static RailTpl T = [] {
    RailTpl t;
    const vec3 steel = hexColor("#c3c8cd") * hexColor("#e4e8ec"), grime = hexColor("#5c5852") * hexColor("#e4e8ec");
    const int NP = 16, NX = 4;
    Geo& b = t.galv;
    for (int ix = 0; ix <= NX; ix++)
      for (int k = 0; k <= NP; k++) {
        const double q = double(k) / NP, x = double(ix) / NX * SEG;
        const double dy = BEAM_TOP - BEAM_LO, dz = -WAVE * 0.5 * 4 * PI * std::sin(4 * PI * q);
        const double l = std::hypot(dy, dz);
        b.pos.push_back(vec3(float(x), float(BEAM_LO + dy * q), float(-WAVE * (0.5 - 0.5 * std::cos(4 * PI * q)))));
        b.nor.push_back(vec3(0, float(dz / l), float(-dy / l)));
        b.uv.push_back(vec2(float(x / SEG), float(q)));
        const double g = q < 0.38 ? 0.38 * (1 - q / 0.38) : 0;
        b.col.push_back(glm::mix(steel, grime, float(g)));
      }
    for (int ix = 0; ix < NX; ix++)
      for (int k = 0; k < NP; k++) { uint32_t a = uint32_t(ix * (NP + 1) + k), c = a + NP + 1; b.idx.insert(b.idx.end(), {a, a + 1, c, a + 1, c + 1, c}); }
    auto box = [&](float w, float h, float d, float x, float y, float z) { Geo g = boxGeo(w, h, d); g.translate(x, y, z); g.col.assign(g.pos.size(), steel); return g; };
    const float mid = float((BEAM_LO + BEAM_TOP) / 2);
    for (float px : {1.f, 3.f}) {
      b.append(box(0.1f, 1.09f, 0.008f, px, 0.095f, 0.205f));            // post web (toward the road)
      b.append(box(0.008f, 1.09f, 0.055f, px - 0.046f, 0.095f, 0.235f));  // flanges
      b.append(box(0.008f, 1.09f, 0.055f, px + 0.046f, 0.095f, 0.235f));
      b.append(box(0.075f, 0.19f, 0.2f, px, mid, 0.1f));                  // spacer block
    }
    t.refl = box(0.065f, 0.07f, 0.014f, 1, mid, -0.006f);
    t.refl.col.assign(t.refl.pos.size(), vec3(1));
    return t;
  }();
  return T;
}
// bus.js BEND_GLSL railBend: the section bent along its stretch (a cubic Hermite from A to B in xz with the tangents
// TA / TB, the height linear less the terminal's sink), local z turned outward; relative to `o`
void bendInto(Geo& out, const Geo& g, const float* S, const dvec3& o) {
  const dvec2 A(S[0], S[2]), B(S[4], S[6]), TA(S[8], S[9]), TB(S[10], S[11]);
  const uint32_t b0 = uint32_t(out.pos.size());
  for (size_t i = 0; i < g.pos.size(); i++) {
    const vec3 p = g.pos[i], n = g.nor[i];
    const double t = std::clamp(double(p.x) / SEG, 0.0, 1.0), t2 = t * t, t3 = t2 * t;
    const dvec2 P = (2 * t3 - 3 * t2 + 1) * A + (t3 - 2 * t2 + t) * TA + (3 * t2 - 2 * t3) * B + (t3 - t2) * TB;
    dvec2 d = (6 * t2 - 6 * t) * A + (3 * t2 - 4 * t + 1) * TA + (6 * t - 6 * t2) * B + (3 * t2 - 2 * t) * TB;
    d /= std::max(glm::length(d), 1e-4);
    const double y = (S[1] - S[3]) + ((S[5] - S[7]) - (S[1] - S[3])) * t;
    out.pos.push_back(vec3(float(P.x - d.y * p.z - o.x), float(y + p.y - o.y), float(P.y + d.x * p.z - o.z)));
    out.nor.push_back(vec3(float(d.x * n.x - d.y * n.z), n.y, float(d.y * n.x + d.x * n.z)));
    out.uv.push_back(g.uv.empty() ? vec2(0) : g.uv[i]);
    out.col.push_back(g.col[i]);
  }
  for (uint32_t k : g.idx) out.idx.push_back(b0 + k);
}
} // namespace

void RailSweep::buildGuardrails(gfx::Device& dev, const Transport& t, const World& world) {
  (void)world;
  dev_ = &dev;
  rails_.clear();
  const size_t n = t.railSegs.size() / 12;
  // (bus.js Guardrails.build: the sections in ~200 m stretches, drawn within RAIL_FAR)
  std::map<std::pair<int, int>, size_t> at;
  for (size_t k = 0; k < n; k++) {
    const float* S = &t.railSegs[k * 12];
    auto key = std::make_pair(int(std::floor((S[0] + S[4]) / 400)), int(std::floor((S[2] + S[6]) / 400)));
    auto it = at.find(key);
    if (it == at.end()) { it = at.emplace(key, rails_.size()).first; rails_.emplace_back(); }
    rails_[it->second].segs.push_back(int(k));
  }
  railOff_.assign(n, 0);
  for (RailCell& c : rails_) {
    dvec3 sum(0);
    for (int k : c.segs) { const float* S = &t.railSegs[size_t(k) * 12]; sum += dvec3(S[0] + S[4], S[1] + S[5], S[2] + S[6]) * 0.5; }
    c.origin = sum / double(c.segs.size());
    buildRailCell(t, c);
  }
  SL_INFO("guardrails: %zu sections (bus.js railGeometry, bent as its shader bends them) in %zu stretches", n, rails_.size());
}

void RailSweep::buildRailCell(const Transport& t, RailCell& c) {
  const RailTpl& T = railTpl();
  Geo galv, refl;
  c.bmin = dvec3(1e30); c.bmax = dvec3(-1e30);
  for (int k : c.segs) {
    const float* S = &t.railSegs[size_t(k) * 12];
    c.bmin = glm::min(c.bmin, glm::min(dvec3(S[0], S[1] - 1, S[2]), dvec3(S[4], S[5] - 1, S[6])) - dvec3(1));
    c.bmax = glm::max(c.bmax, glm::max(dvec3(S[0], S[1] + 1, S[2]), dvec3(S[4], S[5] + 1, S[6])) + dvec3(1));
    if (railOff_[size_t(k)]) continue;   // (broken through: world/breakables.js hides the section)
    bendInto(galv, T.galv, S, c.origin);
    bendInto(refl, T.refl, S, c.origin);
  }
  std::vector<std::pair<Geo, Material>> parts;
  Material g;   // (bus.js: metalness 0.7, roughness 0.42, double sided)
  g.baseColor = vec4(1); g.roughness = 0.42f; g.metallic = 0.7f; g.vertexColor = true; g.doubleSided = true;
  Material r;   // (the amber reflector: #ffa21a, emissive #ff8a00 x 0.45, roughness 0.3)
  r.baseColor = vec4(hexColor("#ffa21a"), 1); r.emissive = hexColor("#ff8a00") * 0.45f; r.roughness = 0.3f;
  if (!galv.empty()) parts.push_back({std::move(galv), g});
  if (!refl.empty()) parts.push_back({std::move(refl), r});
  c.model = parts.empty() || !dev_ ? nullptr : buildModel(*dev_, parts, "guardrail");
}

void RailSweep::railsOff(const Transport& t, double now) {
  if (railOff_.empty()) return;
  // (breakables.js: a section broken through is gone until it comes back, 90 s later)
  std::vector<uint8_t> off(railOff_.size(), 0);
  for (const Guardrail& g : t.rails) if (g.seg >= 0 && size_t(g.seg) < off.size() && g.offUntil > now) off[size_t(g.seg)] = 1;
  if (off == railOff_) return;
  std::vector<uint8_t> was = railOff_;
  railOff_ = off;
  for (RailCell& c : rails_) {
    bool changed = false;
    for (int k : c.segs) if (was[size_t(k)] != off[size_t(k)]) { changed = true; break; }
    if (changed) buildRailCell(t, c);
  }
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
  for (const RailCell& c : rails_) {
    if (!c.model) continue;
    const dvec3 q = glm::clamp(cam, c.bmin, c.bmax);
    const double d = glm::length(q - cam);
    if (d > RAIL_FAR) continue;
    const bool vis = r.visible(c.bmin, c.bmax), cast = d < 250 && r.castsShadow(c.bmin, c.bmax);
    if (vis || cast) r.submitModel(*c.model, c.origin, mat4(1), nullptr, cast, 0, vis);
  }
  if (sleeper_ && dev_) {
    if (glm::length(cam - lastCam_) > 30) rebuildSleepers(cam);
    if (sleepers_.count()) r.submitInstances(sleepers_, sleeperOrigin_, 0, false);
  }
}

} // namespace sl
