// (debug: SKI_LEGACY_DEBUG=villagecheck [--autotest]) the native village's own pieces (world/village.h: the buildings,
// the props as placed: walls, lamps, trees, benches, fountains, shelters, the stair; the relief; the moved sites)
// against everything they must keep clear of, every hit logged with its name and place:
//   rail     both railways (the Wolkenspitzbahn with its passing loop, the Legacy Express's two tracks): the track bed and
//            the trains' envelope plus a clearance (more along a station's platforms); not over a tunnel (but at its
//            portals)
//   road     every road (the exported ones, the bus legs, the Dorfstrasse) with its shoulder, the car parks, bus stops
//   lift     the lifts: cabins / chairs passing over (the rope's height minus the car), the towers, the stations
//   piste    inside a piste / race corridor
//   path     on a paved footpath (blocking it), the walking network running into a building / wall or up a step
//   overlap  the pieces among themselves: buildings overlapping, buildings in retaining walls, trees / lamps / benches in
//            houses or walls
//   ground   buildings sunk into the drawn ground on a side (the terrain through the floor) or floating, their doors
//            buried or hanging; small props on a step
// The three roadside sites (Autohaus, police, Werkstatt) and the heliport are checked as discs (rail / lift / piste /
// overlap). Ends with the counts by category and PASS / FAIL.
#pragma once
#include "core/log.h"
#include "world/lifts.h"
#include "world/transport.h"
#include "world/village.h"
#include "world/world.h"
#include <cmath>
#include <map>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace sl {

inline int villageCheck(World& world, Lifts& lifts, const Transport& T) {
  const Village& V = world.village();
  if (!V.loaded() || !V.data()) { SL_INFO("[villagecheck] no village"); return 0; }
  const nlohmann::json& J = *V.data();
  struct Item { std::string kind, name; double x, z, yaw, hw, hd, y, h; bool disc = false; };
  std::vector<Item> items;
  std::map<std::string, int> nByModel;
  auto kindOf = [](const std::string& m) -> std::string {
    if (m.find("retaining_wall") != std::string::npos) return "wall";
    if (m.find("lamp_post") != std::string::npos) return "lamp";
    if (m.find("pine_tree") != std::string::npos) return "tree";
    if (m.find("drift") != std::string::npos || m.find("snow_heap") != std::string::npos) return "snow";
    if (m.find("stone_stairs") != std::string::npos) return "stair";
    if (m.find("wooden_bench") != std::string::npos || m.find("fountain") != std::string::npos || m.find("bus_shelter") != std::string::npos) return "furniture";
    return "building";
  };
  // the buildings by name (their placed base height from the matching prop)
  for (const VillageBuilding& b : V.buildings()) {
    Item it{"building", b.name, b.x, b.z, b.yaw, b.w * 0.5, b.d * 0.5, 0, b.h};
    for (const auto& p : V.placed())
      if (std::fabs(p.x - b.x) < 0.01 && std::fabs(p.z - b.z) < 0.01) { it.y = p.y; it.hw = p.hw; it.hd = p.hd; it.h = p.h; }
    items.push_back(it);
  }
  for (const auto& p : V.placed()) {
    const std::string k = kindOf(p.m);
    if (k == "building") continue;
    const std::string short_ = p.m.substr(p.m.rfind('/') + 1);
    // (a tree by its trunk and the lowest boughs: the crown may overhang a path)
    const double hw = k == "tree" ? 0.6 : p.hw, hd = k == "tree" ? 0.6 : p.hd;
    items.push_back({k, short_ + " #" + std::to_string(nByModel[short_]++), p.x, p.z, p.yaw, hw, hd, p.y, p.h});
  }
  for (const auto& m : V.moves()) items.push_back({"site", m.name, m.to.x, m.to.y, 0, m.r * 0.6, m.r * 0.6, world.height(m.to.x, m.to.y), 8, true});

  std::map<std::string, int> cats;
  std::map<std::string, int> seen;   // (one line per item and category)
  int total = 0;
  auto hit = [&](const char* cat, const Item& it, const std::string& what) {
    if (seen[std::string(cat) + "|" + it.name]++) return;
    SL_INFO("[villagecheck] %-7s %-9s %-32s at (%7.1f, %7.1f): %s", cat, it.kind.c_str(), it.name.c_str(), it.x, it.z, what.c_str());
    cats[cat]++; total++;
  };
  auto fmt = [](const char* f, double a = 0, double b = 0, double c = 0) { char buf[200]; std::snprintf(buf, sizeof buf, f, a, b, c); return std::string(buf); };
  // a footprint's sample points (every ~1 m, grown by m)
  auto samples = [](const Item& it, double m) {
    std::vector<dvec2> out;
    if (it.disc) {
      const double r = it.hw + m;
      for (double a = -r; a <= r; a += 1.5) for (double b = -r; b <= r; b += 1.5) if (a * a + b * b <= r * r) out.push_back(dvec2(it.x + a, it.z + b));
      return out;
    }
    const double c = std::cos(it.yaw), s = std::sin(it.yaw), hw = it.hw + m, hd = it.hd + m;
    const int nu = std::max(1, int(std::ceil(hw * 2))), nv = std::max(1, int(std::ceil(hd * 2)));
    for (int i = 0; i <= nu; i++) for (int j = 0; j <= nv; j++) {
      const double lx = -hw + 2 * hw * i / nu, lz = -hd + 2 * hd * j / nv;
      out.push_back(dvec2(it.x + lx * c + lz * s, it.z - lx * s + lz * c));
    }
    return out;
  };
  auto inside = [](const Item& it, double x, double z, double m) {
    if (it.disc) return std::hypot(x - it.x, z - it.z) < it.hw + m;
    const double c = std::cos(it.yaw), s = std::sin(it.yaw), dx = x - it.x, dz = z - it.z;
    return std::fabs(dx * c - dz * s) < it.hw + m && std::fabs(dx * s + dz * c) < it.hd + m;
  };
  // clearances by kind: buildings keep the most room
  auto margin = [](const std::string& k, double big, double small) { return k == "building" || k == "site" ? big : small; };

  // ---------------------------------------------------------------- rail
  {
    constexpr double HW = 1.32 + 0.1;
    auto inSpan = [](const std::vector<Span>& sp, double s, double portal) { for (const Span& t : sp) if (s > t.s0 + portal && s < t.s1 - portal) return true; return false; };
    for (const Item& it : items) {
      if (it.kind == "snow") continue;
      for (int which = 0; which < 2; which++) {
        const Line* L = which == 0 ? (T.rail.ok ? &T.rail.line : nullptr) : (T.express.ok ? &T.express.line : nullptr);
        if (!L) continue;
        const double cl = margin(it.kind, 4.5, it.kind == "tree" ? 3.5 : 2.0);
        double worst = 1e9, ws = 0;
        bool station = false;
        for (const dvec2& p : samples(it, 0)) {
          Line::Near n = L->nearest(p.x, p.y, 30);
          if (n.d > 29) continue;
          const auto& tun = which == 0 ? T.rail.tunnels : T.express.tunnels;
          if (inSpan(tun, n.s, 25)) continue;
          const Line::P q = L->at(n.s);
          const double lat = (p.x - q.x) * -q.dz + (p.y - q.z) * q.dx;
          double d;
          bool st = false;
          if (which == 0) {
            const double off = T.loopOffset(n.s);
            d = std::fabs(lat);
            if (off != 0) d = std::min(d, std::fabs(lat - off));
            for (const auto& S : T.rail.stations) if (n.s > S.s0 - 10 && n.s < S.s1 + 10) st = true;
          } else {
            d = std::min(std::fabs(lat - T.express.trackOff), std::fabs(lat + T.express.trackOff));
            for (const auto& S : T.express.stations) if (std::fabs(n.s - S.s) < 130) st = true;
          }
          const double need = HW + cl + (st ? 4.0 : 0.0);
          if (d - need < worst) { worst = d - need; ws = n.s; station = st; }
        }
        if (worst < 0)
          hit("rail", it, std::string(which ? "Legacy Express" : "Wolkenspitzbahn") + (station ? " (station)" : "") + fmt(" s %.0f: %.1f m inside the track's clearance", ws, -worst));
      }
    }
  }
  // ---------------------------------------------------------------- road (roads, bus legs, lots, stops)
  {
    auto nearRoadList = [](const std::vector<Road>& rs, double x, double z) {
      double best = 1e9;
      for (const Road& r : rs) {
        if (r.X.empty()) continue;
        for (size_t i = 1; i < r.X.size(); i++) {
          const double ax = r.X[i - 1], az = r.Z[i - 1], ex = r.X[i] - ax, ez = r.Z[i] - az;
          if (std::fabs(ax - x) > 60 || std::fabs(az - z) > 60) continue;
          const double l2 = std::max(1e-9, ex * ex + ez * ez), t = std::clamp(((x - ax) * ex + (z - az) * ez) / l2, 0.0, 1.0);
          best = std::min(best, std::hypot(ax + ex * t - x, az + ez * t - z));
        }
      }
      return best;
    };
    for (const Item& it : items) {
      if (it.kind == "snow" || it.kind == "site") continue;
      // buildings: the ribbon, the shoulder and a metre; trees: the shoulder; the rest: off the ploughed width
      const double need = Transport::ROAD_HALF + (it.kind == "building" ? 3.5 : it.kind == "tree" ? 2.5 : 0.8);
      double worst = 1e9;
      for (const dvec2& p : samples(it, 0)) worst = std::min(worst, std::min(nearRoadList(T.roads, p.x, p.y), nearRoadList(T.legs, p.x, p.y)));
      if (worst < need) hit("road", it, fmt("%.1f m from a road's middle (needs %.1f)", worst, need));
      for (const Lot& L : T.lots) {
        const double m = it.kind == "building" ? 2.0 : 0.3;
        bool in = false;
        for (const dvec2& p : samples(it, 0)) {
          const double dx = p.x - L.x, dz = p.y - L.z;
          if (std::fabs(dx * L.ux + dz * L.uz) < L.hw + m && std::fabs(dx * L.vx + dz * L.vz) < L.hd + m) in = true;
        }
        if (in) hit("road", it, "in the car park '" + L.name + "'");
      }
      for (const StopInfo& s : T.stops)
        if (inside(it, s.x, s.z, it.kind == "building" ? 8.0 : 2.5)) hit("road", it, "on the bus stop '" + s.name + "'");
    }
  }
  // ---------------------------------------------------------------- lift
  for (const LiftLine& L : lifts.lines()) {
    for (const Item& it : items) {
      if (it.kind == "snow") continue;
      const double top = it.y + it.h;
      std::string why;
      for (const dvec2& p : samples(it, 0)) {
        const dvec2 rel = p - dvec2(L.bottom.x, L.bottom.z);
        const double u = glm::dot(rel, L.dir), lat = glm::dot(rel, L.sideV);
        if (u < -L.cfg.stationSize || u > L.L + L.cfg.stationSize) continue;
        // the stations
        const double hs = L.cfg.stationSize * 0.5 + 4;
        if ((std::fabs(u) < hs + 4 || std::fabs(u - L.L) < hs + 4) && std::fabs(lat) < hs) { why = fmt("in the station's room (u %.0f, across %.1f)", u, lat); break; }
        if (L.hasMid && std::fabs(u - L.mid.u) < hs + 4 && std::fabs(lat) < hs) { why = "at the mid-station"; break; }
        // the towers
        for (const dvec2& s : L.supports)
          if (s.x > 1 && s.x < L.L - 1 && std::hypot(u - s.x, lat) < 4.0) { why = fmt("on a tower (u %.0f)", s.x); break; }
        if (!why.empty()) break;
        // the cars passing over: the rope's height there (between the supports), the car hanging under it
        if (std::fabs(lat) < L.cfg.side + 2.0 + (it.kind == "building" ? 1.5 : 0.5) && L.supports.size() >= 2) {
          double rope = L.supports.front().y;
          for (size_t i = 1; i < L.supports.size(); i++)
            if (u <= L.supports[i].x) { const auto& a = L.supports[i - 1]; const auto& b = L.supports[i]; rope = a.y + (b.y - a.y) * std::clamp((u - a.x) / std::max(1e-6, b.x - a.x), 0.0, 1.0); break; }
          const double carBottom = rope - L.cfg.carH - L.cfg.seatDrop * (L.gondola ? 0 : 1) - 0.5;
          if (top > carBottom - 2.0) { why = fmt("under the line (u %.0f): its top %.1f m, the cars' bottom %.1f m", u, top, carBottom); break; }
        }
      }
      if (!why.empty()) hit("lift", it, L.name + ": " + why);
    }
  }
  // ---------------------------------------------------------------- piste
  {
    // (the pistes' and races' corridors, w their half width; not the short stubs that clear a lift base's surroundings)
    std::vector<const CorridorSeg*> segs;
    for (const CorridorSeg& c : world.corridors())
      if (c.kind != CorridorKind::Lift && std::hypot(c.bx - c.ax, c.bz - c.az) >= 5 && std::max(c.ax, c.bx) > -400 && std::min(c.ax, c.bx) < 400 &&
          std::max(c.az, c.bz) > -400 && std::min(c.az, c.bz) < 400)
        segs.push_back(&c);
    for (const Item& it : items) {
      if (it.kind == "snow") continue;
      double worst = 1e9;
      for (const dvec2& p : samples(it, 0))
        for (const CorridorSeg* c : segs) {
          const double ex = c->bx - c->ax, ez = c->bz - c->az, l2 = ex * ex + ez * ez;
          const double t = std::clamp(((p.x - c->ax) * ex + (p.y - c->az) * ez) / l2, 0.0, 1.0);
          worst = std::min(worst, std::hypot(c->ax + ex * t - p.x, c->az + ez * t - p.y) - c->w);
        }
      if (worst < -1.0) hit("piste", it, fmt("%.1f m inside a piste / race corridor", -worst));
    }
  }
  // ---------------------------------------------------------------- path
  {
    struct Street { std::string name; double w; std::vector<dvec2> p; };
    std::vector<Street> streets;
    for (const auto& s : J["paths"]) {
      Street st{s.value("name", std::string()), s.value("w", 3.0), {}};
      for (const auto& q : s["pts"]) st.p.push_back(dvec2(q[0].get<double>(), q[1].get<double>()));
      streets.push_back(st);
    }
    for (const Item& it : items) {
      if (it.kind == "snow" || it.kind == "stair" || it.kind == "site") continue;
      for (const Street& st : streets) {
        bool on = false;
        for (size_t i = 1; i < st.p.size() && !on; i++) {
          const dvec2 a = st.p[i - 1], b = st.p[i], e = b - a;
          const double L = glm::length(e);
          if (L < 1e-6) continue;
          const dvec2 d = e / L, n(-d.y, d.x);
          for (double t = 0; t <= L && !on; t += 0.7)
            for (double o = -(st.w * 0.5 - 0.4); o <= st.w * 0.5 - 0.4 + 1e-6 && !on; o += 0.5) {
              const dvec2 q = a + d * t + n * o;
              if (inside(it, q.x, q.y, it.kind == "building" ? 0.3 : 0.0)) on = true;
            }
        }
        if (on) hit("path", it, "stands on the footpath '" + st.name + "'");
      }
    }
    // the walking network: edges into buildings / walls, steps
    const auto& N = V.walkNodes();
    const auto& A = V.walkAdj();
    for (size_t a = 0; a < N.size(); a++)
      for (int bI : A[a]) {
        if (size_t(bI) < a) continue;
        const dvec2 p0 = N[a], p1 = N[size_t(bI)];
        const double L = glm::length(p1 - p0);
        double prevY = world.meshHeight(p0.x, p0.y), maxStep = 0;
        dvec2 stepAt = p0;
        std::string into;
        for (double t = 0.5; t <= L; t += 0.5) {
          const dvec2 q = p0 + (p1 - p0) * (t / L);
          const double y = world.meshHeight(q.x, q.y);
          if (std::fabs(y - prevY) > maxStep) { maxStep = std::fabs(y - prevY); stepAt = q; }
          prevY = y;
          if (into.empty())
            for (const Item& it : items)
              if ((it.kind == "building" || it.kind == "wall") && inside(it, q.x, q.y, -0.2)) { into = it.name; break; }
        }
        Item e{"walk", "edge " + std::to_string(a) + "-" + std::to_string(bI), (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, 0, 0, 0, 0, 0};
        if (!into.empty()) { hit("path", e, fmt("walk (%.1f, %.1f) -> ", p0.x, p0.y) + fmt("(%.1f, %.1f) runs into ", p1.x, p1.y) + into); }
        else if (maxStep > 0.45) { e.name += "s"; hit("path", e, fmt("walk climbs a %.2f m step at (%.1f, %.1f)", maxStep, stepAt.x, stepAt.y)); }
      }
  }
  // ---------------------------------------------------------------- overlap
  for (size_t i = 0; i < items.size(); i++) {
    const Item& a = items[i];
    if (a.kind == "snow") continue;
    for (size_t k = 0; k < items.size(); k++) {
      if (k == i) continue;
      const Item& b = items[k];
      if (b.kind != "building" && b.kind != "wall" && b.kind != "site") continue;
      if (a.kind == "wall" && b.kind == "wall") continue;
      if (a.kind == "building" && k < i && (b.kind == "building")) continue;   // (each pair once)
      if (a.kind == "site" && b.kind == "site") continue;
      if (b.kind == "site" && a.kind != "building") continue;   // (a site's own lamps / trees are the site's)
      std::string why;
      if (a.kind == "building" || a.kind == "site") {
        // footprints overlapping: any sample of one in the other (both ways)
        bool ov = false;
        for (const dvec2& p : samples(a, -0.3)) if (inside(b, p.x, p.y, -0.3)) { ov = true; break; }
        if (!ov) for (const dvec2& p : samples(b, -0.3)) if (inside(a, p.x, p.y, -0.3)) { ov = true; break; }
        if (ov) why = "overlaps " + b.name;
      } else {
        const double m = a.kind == "tree" ? 1.2 : 0.2;
        if (inside(b, a.x, a.z, m)) why = "stands in " + b.name;
      }
      if (!why.empty()) hit("overlap", a, why);
    }
  }
  // ---------------------------------------------------------------- ground
  for (const Item& it : items) {
    if (it.kind == "snow" || it.kind == "wall" || it.kind == "stair" || it.kind == "site") continue;
    double gmin = 1e30, gmax = -1e30;
    dvec2 at{0};
    const double c = std::cos(it.yaw), s = std::sin(it.yaw);
    for (int u = -2; u <= 2; u++) for (int v = -2; v <= 2; v++) {
      const double lx = u * it.hw * 0.48, lz = v * it.hd * 0.48;
      const double x = it.x + lx * c + lz * s, z = it.z - lx * s + lz * c;
      const double g = world.meshHeight(x, z);
      gmin = std::min(gmin, g);
      if (g > gmax) { gmax = g; at = dvec2(x, z); }
    }
    if (it.kind == "building") {
      // the base sits at the lowest ground (less its sink): ground more than 0.9 m over it is the terrain up a wall /
      // through the floor; lower ground than the base, a floating corner
      if (gmax - it.y > 0.9) hit("ground", it, fmt("sunk: the ground climbs %.1f m over its base (%.1f) at (%.1f, ", gmax - it.y, it.y, at.x) + fmt("%.1f)", at.y));
      if (gmin < it.y - 0.15) hit("ground", it, fmt("floats: a corner %.1f m over the ground", it.y - gmin));
      // the door (the JS layout's door: 0.42 of the depth out, 2.6 m in front)
      const double dd = it.hd * 2 * 0.5 * 0.84;
      const dvec2 door(it.x + s * (dd + 1.0), it.z + c * (dd + 1.0));
      const double gd = world.meshHeight(door.x, door.y);
      if (gd > it.y + 0.9) hit("ground", it, fmt("door buried: the ground before it %.1f m over the base", gd - it.y));
      else if (gd < it.y - 0.4) hit("ground", it, fmt("door hangs %.1f m over the ground", it.y - gd));
    } else if (it.kind != "tree" || it.hw > 0) {
      if (gmax - gmin > 0.8) hit("ground", it, fmt("on a step: the ground under it differs by %.1f m", gmax - gmin));
    }
  }
  // ---------------------------------------------------------------- the relief against the railways / exported roads / lift stations
  {
    const auto& R = J["relief"];
    const double x0 = R["x0"], z0 = R["z0"], st = R["step"];
    const int nx = R["nx"], nz = R["nz"];
    std::map<std::string, int> rh;
    for (int j = 0; j < nz; j++) for (int i = 0; i < nx; i++) {
      const double x = x0 + i * st, z = z0 + j * st, d = V.delta(x, z);
      if (std::fabs(d) < 0.3) continue;
      Item cell{"relief", "", x, z, 0, 0, 0, 0, 0};
      for (int which = 0; which < 2; which++) {
        const Line* L = which == 0 ? (T.rail.ok ? &T.rail.line : nullptr) : (T.express.ok ? &T.express.line : nullptr);
        if (!L) continue;
        Line::Near n = L->nearest(x, z, 20);
        bool deep = false;
        for (const Span& t : which == 0 ? T.rail.tunnels : T.express.tunnels) if (n.s > t.s0 + 25 && n.s < t.s1 - 25) deep = true;
        if (deep) continue;
        const double reach = which == 0 ? 6.0 : T.express.trackOff + 6.0;
        if (n.d < reach) { cell.name = fmt("cell %.0f,%.0f", x, z); hit("relief", cell, fmt("%+.1f m on the ", d) + (which ? "Legacy Express's bed" : "Wolkenspitzbahn's bed")); }
      }
      for (const Road& r : T.roads) {
        if (r.village) continue;
        for (size_t k = 0; k < r.X.size(); k += 1)
          if (std::hypot(r.X[k] - x, r.Z[k] - z) < Transport::ROAD_HALF + 1.5) { cell.name = fmt("cell %.0f,%.0f", x, z); hit("relief", cell, fmt("%+.1f m on an exported road", d)); break; }
      }
      for (const LiftLine& L : lifts.lines())
        for (const dvec3& e : {L.bottom, L.top})
          if (std::hypot(e.x - x, e.z - z) < L.cfg.stationSize * 0.5 + 2) { cell.name = fmt("cell %.0f,%.0f", x, z); hit("relief", cell, fmt("%+.1f m under ", d) + L.name + "'s station"); }
    }
  }
  for (auto& [k, v] : cats) SL_INFO("[villagecheck] %-8s %3d hits", k.c_str(), v);
  SL_INFO("[villagecheck] %s (%d hits; %zu items checked)", total ? "FAIL" : "PASS", total, items.size());
  return total;
}

} // namespace sl
