// Port of src/world/gondolastation.js (see gondola_station.h). Kept close to the JavaScript, line for line, so the two
// can be compared; RoundedBoxGeometry's few-centimetre bevels are plain boxes here.
#include "world/gondola_station.h"
#include "engine/canvas2d.h"
#include "engine/mesh_kit.h"
#include "gfx/gfx.h"
#include "world/world.h"
#include <algorithm>
#include <cmath>
#include <functional>

namespace sl {

namespace {
constexpr float DECK = 4.35f, W2 = 6.5f, LANE = 1.3f, ROOF_T = 0.38f;
constexpr float MID_WL = 7.2f, MID_WR = 5.8f, MID_HL = 10, STAIR_W = 1.6f;
enum { BASE = 0, METAL = 1, GLASS = 2, LIGHT = 3 };

struct Colors {
  vec3 stone = hexColor("#77736c"), laneFloor = hexColor("#5f615f"), conc = hexColor("#a8a9a5"), pave = hexColor("#c2c2bd"),
       yellow = hexColor("#f1c40a"), wood = hexColor("#b07f4f"), snow = hexColor("#f3f6fa"), steel = hexColor("#cdd2d7"),
       white = hexColor("#e9ecee"), anth = hexColor("#30353b"), blue = hexColor("#1546c8"), rubber = hexColor("#202326"),
       dark = hexColor("#1d2126");
};
const Colors& C() { static Colors c; return c; }

float smooth(float t) { return t * t * (3 - 2 * t); }
using F1 = std::function<float(float)>;

struct Quads { std::vector<vec3> pos, nor; std::vector<vec2> uv; };
const int SIGN_W = 1024, SIGN_H = 384, NAME_H = 170, MID_EXTRA_H = 192;
const vec4 UV_NAME(0, 1 - float(NAME_H) / SIGN_H, 1, 1), UV_TICKETS(0, 0, 0.5f, 0.5f), UV_ENTRANCE(0.5f, 0, 1, 0.5f);

void signQuad(Quads& q, vec3 c, vec3 n, float w, float h, vec4 uv) {
  float rx = n.z, rz = -n.x;
  auto p = [&](float sx, float sy) { return vec3(c.x + rx * sx * w / 2, c.y + sy * h / 2, c.z + rz * sx * w / 2); };
  vec3 a = p(-1, -1), b = p(1, -1), cc = p(1, 1), d = p(-1, 1);
  q.pos.insert(q.pos.end(), {a, b, cc, a, cc, d});
  for (int i = 0; i < 6; i++) q.nor.push_back(vec3(n.x, 0, n.z));
  q.uv.insert(q.uv.end(), {vec2(uv.x, uv.y), vec2(uv.z, uv.y), vec2(uv.z, uv.w), vec2(uv.x, uv.y), vec2(uv.z, uv.w), vec2(uv.x, uv.w)});
}

std::string upper(const std::string& s) {
  std::string o = s;
  for (size_t i = 0; i < o.size(); i++) {
    uint8_t c = uint8_t(o[i]);
    if (c >= 'a' && c <= 'z') o[i] = char(c - 32);
    else if (c == 0xc3 && i + 1 < o.size() && uint8_t(o[i + 1]) >= 0xa0 && uint8_t(o[i + 1]) <= 0xbe && uint8_t(o[i + 1]) != 0xb7) { o[i + 1] = char(uint8_t(o[i + 1]) - 0x20); i++; }
  }
  return o;
}

// signMaterial: the station's canvas (name board, TICKETS, ENTRANCE; the mid-station's next-cabin screen under it)
gfx::Texture signTexture(gfx::Device& dev, const FontSet& fonts, const std::string& name, const std::string& sub, bool midExtra,
                         const std::string& up, const std::string& down) {
  Canvas2D g(SIGN_W, SIGN_H + (midExtra ? MID_EXTRA_H : 0), &fonts);
  auto font = [&](int w, float px) { g.font(std::to_string(w) + " " + std::to_string(int(px)) + "px Barlow"); };
  auto fit = [&](const std::string& t, int w, float px, float max) { float s = px; font(w, s); while (g.measureText(t) > max && s > 18) { s -= 2; font(w, s); } return s; };
  g.fillStyle("#1d2126"); g.fillRect(0, 0, SIGN_W, NAME_H);
  g.fillStyle("#1546c8"); g.fillRect(0, 0, NAME_H, NAME_H);
  g.strokeStyle("#ffffff"); g.lineWidth(7);
  g.beginPath(); g.moveTo(18, 46); g.lineTo(152, 30); g.stroke();
  g.beginPath(); g.moveTo(85, 38); g.lineTo(85, 66); g.stroke();
  g.fillStyle("#ffffff");
  g.beginPath(); g.roundRect(46, 66, 78, 76, 14); g.fill();
  g.fillStyle("#1546c8"); g.fillRect(56, 78, 58, 26);
  g.fillStyle("#ffffff"); g.textBaseline("alphabetic"); g.textAlign("left");
  std::string N = upper(name), S = upper(sub);
  fit(N, 700, 82, SIGN_W - NAME_H - 60);
  g.fillText(N, NAME_H + 34, 104);
  g.fillStyle("#a9bfd6");
  fit(S, 500, 34, SIGN_W - NAME_H - 60);
  g.fillText(S, NAME_H + 36, 150);
  g.fillStyle("#1546c8"); g.fillRect(NAME_H, NAME_H - 6, SIGN_W - NAME_H, 6);
  const char* labels[2] = {"TICKETS", "ENTRANCE"};
  const char* bgs[2] = {"#1546c8", "#1d2126"};
  for (int k = 0; k < 2; k++) {
    float x0 = k ? SIGN_W / 2.f : 0;
    g.fillStyle(bgs[k]); g.fillRect(x0, SIGN_H - 192, SIGN_W / 2.f, 192);
    g.fillStyle("#ffffff"); g.textAlign("center");
    fit(labels[k], 700, 80, SIGN_W / 2.f - 60);
    g.fillText(labels[k], x0 + SIGN_W / 4.f, SIGN_H - 192 + 124);
  }
  if (midExtra) {   // drawMidExtra
    const float y0 = SIGN_H;
    g.fillStyle("#0b1016"); g.fillRect(0, y0, 384, 192);
    g.textAlign("left"); g.textBaseline("alphabetic");
    g.fillStyle("#f1c40a"); font(700, 26); g.fillText("NEXT CABIN", 20, y0 + 40);
    g.fillStyle("#ffffff");
    const std::string lbl[2] = {"\xe2\x96\xb2 " + (up.empty() ? std::string("Summit") : up), "\xe2\x96\xbc " + (down.empty() ? std::string("Valley") : down)};
    const char* t[2] = {"0:40", "1:10"};
    for (int k = 0; k < 2; k++) {
      float y = y0 + 96 + k * 60;
      fit(lbl[k], 600, 30, 250); g.fillText(lbl[k], 20, y);
      font(700, 30); g.fillStyle("#39c463"); g.fillText(t[k], 290, y); g.fillStyle("#ffffff");
    }
  }
  // (CanvasTexture flipY: the first row uploaded is the canvas's bottom)
  const auto& px = g.pixels();
  int W = g.width(), H = g.height();
  std::vector<uint8_t> flip(px.size());
  for (int y = 0; y < H; y++) std::copy_n(&px[size_t(H - 1 - y) * W * 4], size_t(W) * 4, &flip[size_t(y) * W * 4]);
  gfx::TextureDesc d;
  d.width = W; d.height = H; d.format = gfx::TexFormat::SRGBA8; d.wrap = gfx::Wrap::Clamp; d.anisotropy = 8;
  return dev.createTexture(d, flip.data());
}

struct Mats { Material base, metal, glass, light, sign; };
Mats materials() {
  Mats m;
  m.base.baseColor = vec4(1); m.base.roughness = 0.84f; m.base.metallic = 0; m.base.vertexColor = true;
  m.metal.baseColor = vec4(1); m.metal.roughness = 0.34f; m.metal.metallic = 0.72f; m.metal.vertexColor = true;
  m.glass.baseColor = vec4(hexColor("#9dbdcc"), 0.3f); m.glass.roughness = 0.04f; m.glass.metallic = 0.05f;
  m.glass.alpha = Material::Alpha::Blend; m.glass.doubleSided = true;
  m.light.baseColor = vec4(hexColor("#fff8ee"), 1); m.light.roughness = 0.5f; m.light.metallic = 0;
  m.light.emissive = hexColor("#ffecc8") * 2.4f; m.light.emissiveNight = vec2(0.3f, 0.7f);
  m.sign.baseColor = vec4(1); m.sign.roughness = 0.45f; m.sign.metallic = 0.1f; m.sign.emissive = vec3(1);
  m.sign.emissiveNight = vec2(0.12f, 0.58f);
  return m;
}

// the roof of a station hall: timber soffit, white fascias and sections, snow on top (hallRoof)
float roofEaves(float rMax) { return std::max(9.4f, rMax + 2.0f); }
float portalHeader(float ropeY, float rMax) { return std::max(ropeY + 1.35f, rMax + 1.25f); }
void hallRoof(MeshKit& K, float Wr, const F1& roofTop, const F1& roofBot, float zr0, float zr1) {
  const Colors& c = C();
  K.sheet(BASE, -Wr, Wr, zr0, zr1, 28, 1, [&](float x, float) { return roofBot(x); }, c.wood, true);
  for (float sx : {-1.f, 1.f}) K.box(METAL, sx * Wr - 0.06f, sx * Wr, roofBot(Wr) - 0.02f, roofTop(Wr) + 0.01f, zr0, zr1, c.white);
  const int n = 14;
  std::vector<vec2> top, bot;
  for (int i = 0; i <= n; i++) { float x = -Wr + (2 * Wr * i) / n; top.push_back(vec2(x, roofTop(x) + 0.01f)); bot.insert(bot.begin(), vec2(x, roofBot(x) - 0.02f)); }
  std::vector<vec2> section = top;
  section.insert(section.end(), bot.begin(), bot.end());
  K.shapeZ(METAL, section, zr1, c.white);
  K.add(METAL, shapeGeo(section).rotateY(float(PI)).translate(0, 0, zr0), c.white);
  int nz = std::max(10, int(std::lround((zr1 - zr0) / 1.6f)));
  K.sheet(BASE, -Wr - 0.04f, Wr + 0.04f, zr0 - 0.04f, zr1 + 0.04f, 40, nz, [&](float x, float z) {
    float d = std::min({Wr - std::fabs(x), z - zr0, zr1 - z}), xr = std::clamp(x, -Wr, Wr);
    if (d <= 0.02f) return roofTop(xr) - 0.035f;
    return roofTop(xr) + 0.05f + 0.24f * smooth(std::min(1.f, d / 0.8f)) + 0.025f * std::sin(x * 1.7f + z * 0.9f) * std::min(1.f, d);
  }, c.snow);
}
void downlights(MeshKit& K, const F1& roofBot, float z) {
  for (float x : {-4.5f, -2.25f, 0.f, 2.25f, 4.5f}) K.add(LIGHT, cylinderGeo(0.13f, 0.13f, 0.04f, 12).translate(x, roofBot(x) - 0.02f, z), C().white);
}
void conveyors(MeshKit& K, float s, float ropeY, const F1& roofBot, float z0, float z1) {
  const Colors& c = C();
  float yr = ropeY + 0.5f, ycv = ropeY + 1.0f;
  for (float sx : {-1.f, 1.f}) {
    float x = sx * s;
    K.box(METAL, x - 0.06f, x + 0.06f, yr - 0.1f, yr + 0.1f, z0, z1, c.steel);
    K.box(METAL, x - 0.22f, x + 0.22f, ycv - 0.18f, ycv + 0.18f, z0, z1, c.anth);
    for (float z = z0 + 0.8f; z < z1; z += 3) K.bar(METAL, vec3(x, ycv + 0.18f, z), vec3(x, roofBot(x) - 0.2f, z), 0.1f, c.steel);
    for (float z = z0 + 0.4f; z < z1 - 0.2f; z += 0.9f) K.add(METAL, cylinderGeo(0.17f, 0.17f, 0.12f, 10).rotateZ(float(PI / 2)).translate(x, ycv - 0.3f, z), c.rubber);
  }
}

std::shared_ptr<Model> assemble(gfx::Device& dev, MeshKit& K, int mx, const Quads& q, gfx::Texture signTex) {
  Mats M = materials();
  std::vector<std::pair<Geo, Material>> parts;
  const Material* mats[4] = {&M.base, &M.metal, &M.glass, &M.light};
  for (int k = 0; k < 4; k++) parts.push_back({K.merge(k, mx < 0), *mats[k]});
  if (signTex && !q.pos.empty()) {
    Geo g;
    g.pos = q.pos; g.nor = q.nor; g.uv = q.uv;
    for (size_t i = 0; i < q.pos.size(); i++) g.idx.push_back(uint32_t(i));
    M.sign.baseTex = signTex; M.sign.emissiveTex = signTex;
    parts.push_back({g, M.sign});
  }
  return buildModel(dev, parts, "gondola_station");
}

float ropeAt(const GondolaStationParams& p, float z, int lane) {
  if (p.rope.empty()) return p.ropeY;
  float z0 = p.mid ? -13.f : 0.f, f = (z - z0) / 0.5f;
  int i = std::clamp(int(std::floor(f)), 0, int(p.rope.size()) - 1), j = std::min(i + 1, int(p.rope.size()) - 1);
  float t = std::clamp(f - i, 0.f, 1.f);
  float a = p.rope[size_t(i)][lane], b = p.rope[size_t(j)][lane];
  if (!std::isfinite(a)) return b;
  if (!std::isfinite(b)) return a;
  return a + (b - a) * t;
}

// ---------------------------------------------------------------- the end stations
std::shared_ptr<Model> endStation(gfx::Device& dev, const World& world, const FontSet& fonts, const GondolaStationParams& o) {
  const Colors& c = C();
  const bool top = o.top;
  const float ZB = top ? -10.8f : -11.4f, ZF = top ? 5.6f : 6.2f, RISE = top ? 1.0f : 1.25f;
  const float s = o.side, ropeY = o.ropeY, carH = o.carH, Ro = s + LANE, Ri = s - LANE;
  const double cy = std::cos(o.yaw), sy = std::sin(o.yaw);
  const int mx = o.mx;
  auto toW = [&](float x, float z) { double X = x * mx; return dvec2(o.x + X * cy + z * sy, o.z - X * sy + z * cy); };
  auto gAt = [&](float x, float z) { dvec2 q = toW(x, z); return float(world.height(q.x, q.y) - o.y); };

  float rMax = ropeY, rMin = ropeY, zFlat = ZF - 0.4f;
  for (float z = 0; z <= ZF + 2.6f; z += 0.5f) {
    float a = ropeAt(o, z, 0), b = ropeAt(o, z, 1);
    rMax = std::max({rMax, a, b});
    if (z <= ZF + 0.5f) rMin = std::min({rMin, a, b});
    if (std::max(std::fabs(a - ropeY), std::fabs(b - ropeY)) > 0.25f) zFlat = std::min(zFlat, z - 0.5f);
  }
  zFlat = std::max(1.5f, zFlat);
  const float lf = std::clamp(rMin - carH - 0.5f, 0.4f, DECK - 1.1f);

  const float zs0 = ZB + 0.5f, zs1 = ZB + 2.7f, zd = (zs0 + zs1) / 2;
  const float gd = std::clamp(gAt(-W2 - 1.4f, zd), -6.f, DECK - 1.2f);
  const float xs0 = -W2 + 1.0f, run = std::clamp((DECK - gd) / 0.6f, 4.f, 2 * W2 - 2.6f), xt = xs0 + run;
  float gMin = std::min(gd, 0.f);
  for (float gx : {-W2, 0.f, W2}) for (float gz : {ZB, (ZB + ZF) / 2, ZF}) gMin = std::min(gMin, gAt(gx, gz));
  const float yb = gMin - 0.8f;

  const float Wr = W2 + 0.6f, R = RISE, E = roofEaves(rMax);
  F1 roofTop = [=](float x) { return E + R * (1 - (x / Wr) * (x / Wr)); };
  F1 roofBot = [=](float x) { return roofTop(x) - ROOF_T; };
  const float zr0 = ZB - 0.6f, zr1 = ZF + 1.4f;
  const float pt = portalHeader(ropeY, rMax);
  auto curve = [&](float x0, float x1, float dy) { std::vector<vec2> out; for (int i = 0; i <= 14; i++) { float x = x0 + (x1 - x0) * i / 14; out.push_back(vec2(x, roofBot(x) - dy)); } return out; };
  auto arc = [](float r, float from, float to) { std::vector<vec2> out; for (int i = 0; i <= 18; i++) { float t = from + (to - from) * i / 18; out.push_back(vec2(r * std::cos(t), -r * std::sin(t))); } return out; };
  auto cat = [](std::vector<vec2> a, const std::vector<vec2>& b) { a.insert(a.end(), b.begin(), b.end()); return a; };

  MeshKit K(4);
  // plinth, deck, channels, stair
  std::vector<vec2> notch = {{-W2, zs0}, {xt, zs0}, {xt, zs1}, {-W2, zs1}};
  K.slab(BASE, cat(cat({{W2, ZF}, {W2, ZB}, {-W2, ZB}}, notch), {{-W2, ZF}}), yb, lf, c.stone, c.laneFloor);
  K.slab(BASE, cat(cat(cat(cat({{W2, ZF}, {W2, ZB}, {-W2, ZB}}, notch), {{-W2, ZF}, {-Ro, ZF}}), arc(Ro, float(PI), 0)), {{Ro, ZF}}), lf, DECK, c.conc, c.pave);
  K.slab(BASE, cat(cat({{Ri, ZF}}, arc(Ri, 0, float(PI))), {{-Ri, ZF}}), lf, DECK, c.conc, c.pave);
  for (float sx : {-1.f, 1.f}) K.box(BASE, sx * W2 - 0.03f, sx * W2 + 0.03f, lf - 0.08f, lf - 0.02f, sx < 0 ? zs1 : ZB, ZF, c.dark);
  K.box(BASE, -W2, W2, lf - 0.08f, lf - 0.02f, ZB - 0.03f, ZB + 0.03f, c.dark);
  const float rise = DECK - gd;
  const int nSteps = std::max(3, int(std::lround(rise / 0.175f)));
  const float dxs = run / nSteps;
  K.box(BASE, -W2, xs0, yb, gd, zs0 + 0.01f, zs1 - 0.01f, c.conc, &c.pave);
  for (int i = 0; i < nSteps; i++) K.box(BASE, xs0 + i * dxs, xs0 + (i + 1) * dxs, yb, gd + (rise * (i + 1)) / nSteps, zs0 + 0.01f, zs1 - 0.01f, c.conc, &c.pave);
  for (float z : {zs0 + 0.09f, zs1 - 0.09f}) K.bar(METAL, vec3(xs0, gd + 0.95f, z), vec3(xt, DECK + 0.95f, z), 0.05f, c.steel, true);
  const float doorH = std::min(2.6f, DECK - gd - 0.3f);
  K.box(BASE, -W2, -W2 + 0.4f, gd + doorH, DECK, zs0, zs1, c.conc);
  for (float z : {zs0 + 0.05f, zs1 - 0.05f}) K.box(METAL, -W2 - 0.02f, -W2 + 0.14f, gd, gd + doorH, z - 0.05f, z + 0.05f, c.anth);
  K.box(METAL, -W2 - 0.02f, -W2 + 0.14f, gd + doorH - 0.1f, gd + doorH, zs0, zs1, c.anth);
  K.vquad(GLASS, -W2 + 0.2f, zs0 + 0.05f, -W2 + 0.2f, zs0 + 0.55f, gd, gd + doorH - 0.1f, c.white);
  K.vquad(GLASS, -W2 + 0.2f, zs1 - 0.55f, -W2 + 0.2f, zs1 - 0.05f, gd, gd + doorH - 0.1f, c.white);
  const float canY = std::min(gd + doorH + 0.25f, DECK - 0.35f);
  K.box(METAL, -W2 - 1.4f, -W2, canY, canY + 0.14f, zs0 - 0.5f, zs1 + 0.5f, c.white);
  K.box(BASE, -W2 - 1.36f, -W2, canY + 0.14f, canY + 0.24f, zs0 - 0.46f, zs1 + 0.46f, c.snow);
  K.box(LIGHT, -W2 - 1.1f, -W2 - 0.9f, canY - 0.02f, canY, zs0, zs1, c.white);
  const bool tickets = !top && gd + 3.25f < DECK - 1.05f;
  if (tickets) {
    float t0 = ZB + 3.6f, t1 = ZB + 8.6f;
    K.box(METAL, -W2 - 0.02f, -W2 + 0.02f, gd + 0.85f, gd + 2.45f, t0 - 0.08f, t1 + 0.08f, c.anth);
    K.vquad(GLASS, -W2 - 0.06f, t0, -W2 - 0.06f, t1, gd + 0.9f, gd + 2.4f, c.white);
    K.box(METAL, -W2 - 0.35f, -W2, gd + 0.95f, gd + 1.0f, t0, t1, c.steel);
    K.box(LIGHT, -W2 - 0.09f, -W2 - 0.04f, gd + 2.33f, gd + 2.38f, t0 + 0.1f, t1 - 0.1f, c.white);
    for (int k = 0; k <= 4; k++) K.box(METAL, -W2 - 0.09f, -W2 - 0.03f, gd + 0.9f, gd + 2.4f, t0 + ((t1 - t0) * k) / 4 - 0.03f, t0 + ((t1 - t0) * k) / 4 + 0.03f, c.anth);
  }
  for (auto [z0, z1] : {std::pair<float, float>{ZB + 3, ZB + 6}, {-2.5f, 0.5f}}) {
    K.box(METAL, W2 - 0.02f, W2 + 0.02f, 0.5f, 2.3f, z0, z1, c.dark);
    for (int k = 0; k < 7; k++) K.box(METAL, W2, W2 + 0.07f, 0.62f + k * 0.25f, 0.68f + k * 0.25f, z0 + 0.05f, z1 - 0.05f, c.anth);
  }

  // the platform
  for (float sx : {-1.f, 1.f}) {
    K.box(BASE, sx * (Ro + 0.3f), sx * (Ro + 0.45f), DECK, DECK + 0.012f, 0, ZF - 0.25f, c.yellow);
    K.box(BASE, sx * (Ri - 0.45f), sx * (Ri - 0.3f), DECK, DECK + 0.012f, 0, ZF - 0.25f, c.yellow);
  }
  K.ring(BASE, Ro + 0.3f, Ro + 0.45f, DECK + 0.012f, c.yellow);
  K.ring(BASE, Ri - 0.45f, Ri - 0.3f, DECK + 0.012f, c.yellow);
  const float rb = Ro + 0.1f, yb0 = DECK + 0.08f, yb1 = DECK + 1.0f;
  for (int k = 0; k < 8; k++) {
    float t0 = float(PI) * k / 8, t1 = float(PI) * (k + 1) / 8;
    K.vquad(GLASS, rb * std::cos(t0), -rb * std::sin(t0), rb * std::cos(t1), -rb * std::sin(t1), yb0, yb1, c.white);
    K.bar(METAL, vec3(rb * std::cos(t0), DECK, -rb * std::sin(t0)), vec3(rb * std::cos(t0), yb1 + 0.04f, -rb * std::sin(t0)), 0.05f, c.steel, true);
  }
  K.arcTube(METAL, rb, 0.03f, yb1 + 0.04f, c.steel);
  for (float sx : {-1.f, 1.f}) {
    float x = sx * rb;
    K.bar(METAL, vec3(x, DECK, 0), vec3(x, yb1 + 0.04f, 0), 0.05f, c.steel, true);
    K.vquad(GLASS, x, 3.7f, x, ZF - 0.25f, yb0, yb1, c.white);
    for (float z = 3.7f; z <= ZF - 0.2f; z += std::max(1.f, (ZF - 3.95f) / 2)) K.bar(METAL, vec3(x, DECK, z), vec3(x, yb1 + 0.04f, z), 0.05f, c.steel, true);
    K.bar(METAL, vec3(x, yb1 + 0.04f, 3.7f), vec3(x, yb1 + 0.04f, ZF - 0.25f), 0.06f, c.steel, true);
    for (float z : {0.2f, 3.6f}) K.box(METAL, x - 0.09f, x + 0.09f, DECK, DECK + 1.15f, z - 0.09f, z + 0.09f, c.yellow);
    K.box(LIGHT, x - 0.095f, x + 0.095f, DECK + 1.15f, DECK + 1.17f, 0.13f, 0.27f, c.white);
    for (auto [z0, z1] : {std::pair<float, float>{0.3f, 1.88f}, {1.92f, 3.5f}}) {
      K.vquad(GLASS, x, z0, x, z1, DECK + 0.25f, DECK + 0.95f, c.white);
      K.box(METAL, x - 0.03f, x + 0.03f, DECK + 0.93f, DECK + 0.99f, z0, z1, c.yellow);
    }
  }
  K.box(METAL, -0.45f, 0.45f, DECK, DECK + 1.05f, 0.6f, 1.3f, c.anth);
  K.box(LIGHT, -0.35f, 0.35f, DECK + 1.05f, DECK + 1.07f, 0.7f, 1.2f, c.white);
  K.box(METAL, -0.08f, 0.08f, DECK, DECK + 1.3f, 2.4f, 2.56f, c.yellow);
  const float bx0 = -W2 + 0.4f, bx1 = -W2 + 3.4f, bz0 = ZB + 3.1f, bz1 = ZB + 6.0f, bh = DECK + 2.7f;
  K.box(METAL, bx0, bx1, DECK, DECK + 0.95f, bz0, bz1, c.anth);
  const float cab[4][4] = {{bx0, bz0, bx1, bz0}, {bx1, bz0, bx1, bz1}, {bx1, bz1, bx0, bz1}, {bx0, bz1, bx0, bz0}};
  for (auto& w : cab) K.vquad(GLASS, w[0], w[1], w[2], w[3], DECK + 0.95f, bh, c.white);
  for (auto [x, z] : {std::pair<float, float>{bx0, bz0}, {bx1, bz0}, {bx1, bz1}, {bx0, bz1}}) K.box(METAL, x - 0.06f, x + 0.06f, DECK + 0.9f, bh, z - 0.06f, z + 0.06f, c.anth);
  K.box(METAL, bx0 - 0.2f, bx1 + 0.2f, bh, bh + 0.2f, bz0 - 0.2f, bz1 + 0.2f, c.white);
  K.box(METAL, bx0 - 0.21f, bx1 + 0.21f, bh + 0.02f, bh + 0.1f, bz0 - 0.21f, bz1 + 0.21f, c.blue);
  K.box(LIGHT, bx0 + 0.4f, bx1 - 0.4f, bh - 0.03f, bh, (bz0 + bz1) / 2 - 0.05f, (bz0 + bz1) / 2 + 0.05f, c.white);
  K.box(METAL, bx0 + 0.1f, bx1 - 0.1f, DECK + 0.95f, DECK + 1.0f, bz1 - 0.6f, bz1 - 0.1f, c.steel);
  const float zt = -6.2f;
  if (!top) for (int i = 0; i < 7; i++) {
    float x = -2.6f + i * 1.25f;
    K.box(METAL, x - 0.11f, x + 0.11f, DECK, DECK + 1.0f, zt - 0.45f, zt + 0.45f, c.anth);
    K.box(LIGHT, x - 0.07f, x + 0.07f, DECK + 1.0f, DECK + 1.015f, zt - 0.3f, zt + 0.1f, c.white);
    K.vquad(GLASS, x + 0.14f, zt - 0.35f, x + 0.14f, zt + 0.3f, DECK + 0.45f, DECK + 0.98f, c.white);
  }
  K.vquad(GLASS, -W2 + 0.2f, zs1 + 0.06f, xt, zs1 + 0.06f, DECK + 0.08f, DECK + 1.0f, c.white);
  K.bar(METAL, vec3(-W2 + 0.2f, DECK + 1.03f, zs1 + 0.06f), vec3(xt, DECK + 1.03f, zs1 + 0.06f), 0.06f, c.steel, true);
  K.bar(METAL, vec3(xt, DECK, zs1 + 0.06f), vec3(xt, DECK + 1.03f, zs1 + 0.06f), 0.05f, c.steel, true);

  // the hall: frames, glass, roof
  const int nb = std::max(4, int(std::lround((ZF - ZB - 0.4f) / 4.2f)));
  std::vector<float> zc;
  for (int i = 0; i <= nb; i++) zc.push_back(ZB + 0.2f + ((ZF - ZB - 0.4f) * i) / nb);
  const float xc = W2 - 0.2f, yW = roofBot(W2 - 0.08f) - 0.02f;
  for (float z : zc) {
    for (float sx : {-1.f, 1.f}) K.box(METAL, sx * xc - 0.15f, sx * xc + 0.15f, DECK, roofBot(xc), z - 0.15f, z + 0.15f, c.steel);
    for (int k = 0; k < 10; k++) {
      float x0 = -xc + (2 * xc * k) / 10, x1 = -xc + (2 * xc * (k + 1)) / 10;
      K.bar(METAL, vec3(x0, roofBot(x0) - 0.13f, z), vec3(x1, roofBot(x1) - 0.13f, z), 0.2f, c.steel);
    }
  }
  for (float sx : {-1.f, 1.f}) {
    float x = sx * (W2 - 0.08f);
    for (int i = 0; i < nb; i++) {
      float z0 = zc[size_t(i)] + 0.15f, z1 = zc[size_t(i) + 1] - 0.15f, zm = (z0 + z1) / 2;
      K.vquad(GLASS, x, z0, x, z1, DECK + 0.1f, yW, c.white);
      K.box(METAL, x - 0.04f, x + 0.04f, DECK + 0.02f, yW, zm - 0.04f, zm + 0.04f, c.anth);
    }
    for (float y : {DECK + 0.1f, DECK + 1.1f, yW - 0.04f}) K.box(METAL, x - 0.05f, x + 0.05f, y - 0.04f, y + 0.04f, zc[0], zc[size_t(nb)], c.anth);
  }
  const float zg0 = ZB + 0.12f;
  K.shapeZ(GLASS, cat({{-W2, DECK + 0.1f}, {W2, DECK + 0.1f}}, curve(W2, -W2, 0.02f)), zg0, c.white);
  for (int k = 1; k < 6; k++) { float x = -W2 + (2 * W2 * k) / 6; K.box(METAL, x - 0.04f, x + 0.04f, DECK, roofBot(x) - 0.02f, zg0 - 0.04f, zg0 + 0.04f, c.anth); }
  for (float y : {DECK + 0.1f, DECK + 1.1f}) K.box(METAL, -W2, W2, y - 0.04f, y + 0.04f, zg0 - 0.05f, zg0 + 0.05f, c.anth);
  const float zg1 = ZF - 0.12f, xa = Ro + 0.15f;
  for (float sx : {-1.f, 1.f}) {
    std::vector<vec2> pts = cat({{xa, DECK + 0.1f}, {W2, DECK + 0.1f}}, curve(W2, xa, 0.02f));
    if (sx < 0) for (auto& p : pts) p.x = -p.x;
    K.shapeZ(GLASS, pts, zg1, c.white);
    K.box(METAL, sx * (Ro + 0.12f) - 0.15f, sx * (Ro + 0.12f) + 0.15f, DECK, pt, zg1 - 0.15f, zg1 + 0.15f, c.steel);
    float xm2 = W2 * 0.5f + xa * 0.5f;
    K.box(METAL, sx * xm2 - 0.04f, sx * xm2 + 0.04f, DECK, roofBot(xm2), zg1 - 0.04f, zg1 + 0.04f, c.anth);
    K.box(METAL, sx * xa, sx * W2, DECK + 1.06f, DECK + 1.14f, zg1 - 0.05f, zg1 + 0.05f, c.anth);
  }
  if (roofBot(xa) - 0.1f > pt + 0.45f) K.shapeZ(GLASS, cat({{-xa, pt + 0.4f}, {xa, pt + 0.4f}}, curve(xa, -xa, 0.02f)), zg1, c.white);
  K.box(METAL, -W2, W2, pt, pt + 0.4f, ZF - 0.35f, ZF + 0.05f, c.blue);
  K.box(LIGHT, -Ro, Ro, pt - 0.02f, pt, ZF - 0.2f, ZF - 0.1f, c.white);
  K.bar(METAL, vec3(-Ri + 0.15f, DECK + 0.95f, ZF - 0.15f), vec3(Ri - 0.15f, DECK + 0.95f, ZF - 0.15f), 0.06f, c.steel, true);
  for (float x : {-Ri + 0.15f, Ri - 0.15f}) K.bar(METAL, vec3(x, DECK, ZF - 0.15f), vec3(x, DECK + 0.98f, ZF - 0.15f), 0.05f, c.steel, true);
  hallRoof(K, Wr, roofTop, roofBot, zr0, zr1);
  for (float x : {-xc + 0.8f, -1.1f, 1.1f, xc - 0.8f}) K.box(LIGHT, x - 0.05f, x + 0.05f, roofBot(x) - 0.05f, roofBot(x) - 0.015f, ZB + 0.4f, ZF + 1.1f, c.white);
  downlights(K, roofBot, ZF + 0.8f);

  // the cable loop: guide rail, tyre conveyor
  const float yr = ropeY + 0.5f, ycv = ropeY + 1.0f;
  conveyors(K, s, ropeY, roofBot, 0, zFlat);
  K.arcTube(METAL, s, 0.08f, yr, c.steel);
  K.arcTube(METAL, s, 0.22f, ycv, c.anth, 4);
  for (float t : {float(PI / 4), float(PI / 2), float(3 * PI / 4)}) {
    float x = s * std::cos(t), z = -s * std::sin(t);
    K.bar(METAL, vec3(x, ycv + 0.18f, z), vec3(x, roofBot(x) - 0.2f, z), 0.1f, c.steel);
  }
  const float sh = std::min(1.0f, roofBot(3.3f) - pt - 0.55f), rb3 = roofBot(3.3f);
  if (sh > 0.4f) {
    K.box(METAL, -sh * 3 - 0.1f, sh * 3 + 0.1f, pt + 0.4f, pt + 0.5f + sh, ZF - 0.12f, ZF + 0.05f, c.dark);
    K.box(METAL, -sh * 3 - 0.1f, sh * 3 + 0.1f, rb3 - 0.4f - sh, rb3 - 0.3f, ZB - 0.05f, ZB + 0.12f, c.dark);
  }

  // the signs (in the mirrored frame, so the letters read the right way round)
  std::string place = o.place;
  if (place.rfind("the ", 0) == 0 || place.rfind("The ", 0) == 0) place = place.substr(4);
  std::string lower = place;
  for (auto& ch : lower) ch = char(std::tolower(uint8_t(ch)));
  std::string sub = std::string(top ? "Summit station" : "Valley station") + (!place.empty() && lower != "summit" ? " \xc2\xb7 " + place : "");
  Quads q;
  auto X = [&](float x) { return x * mx; };
  if (sh > 0.4f) {
    signQuad(q, vec3(0, pt + 0.45f + sh / 2, ZF + 0.07f), vec3(0, 0, 1), sh * 6, sh, UV_NAME);
    signQuad(q, vec3(0, rb3 - 0.35f - sh / 2, ZB - 0.07f), vec3(0, 0, -1), sh * 6, sh, UV_NAME);
  }
  signQuad(q, vec3(X(-W2 - 0.04f), DECK - 0.55f, ZB + 6.5f), vec3(float(-mx), 0, 0), 5.4f, 0.9f, UV_NAME);
  signQuad(q, vec3(X(W2 + 0.04f), DECK - 0.55f, (ZB + ZF) / 2), vec3(float(mx), 0, 0), 5.4f, 0.9f, UV_NAME);
  if (canY + 0.95f < DECK - 0.1f) signQuad(q, vec3(X(-W2 - 0.04f), canY + 0.6f, zd), vec3(float(-mx), 0, 0), 1.8f, 0.675f, UV_ENTRANCE);
  if (tickets) signQuad(q, vec3(X(-W2 - 0.04f), gd + 2.85f, ZB + 6.1f), vec3(float(-mx), 0, 0), 1.6f, 0.6f, UV_TICKETS);
  gfx::Texture tex = signTexture(dev, fonts, o.name.empty() ? "Gondola" : o.name, sub, false, "", "");
  return assemble(dev, K, mx, q, tex);
}

// ---------------------------------------------------------------- the mid-station
std::shared_ptr<Model> midStation(gfx::Device& dev, const World& world, const FontSet& fonts, const GondolaStationParams& o) {
  const Colors& c = C();
  const float s = o.side, ropeY = o.ropeY, carH = o.carH, WL = MID_WL, WR = MID_WR, HL = MID_HL, Ro = s + LANE, Ri = s - LANE;
  const int mx = o.mx < 0 ? -1 : 1;
  const double cy = std::cos(o.yaw), sy = std::sin(o.yaw);
  auto toW = [&](float x, float z) { double X = x * mx; return dvec2(o.x + X * cy + z * sy, o.z - X * sy + z * cy); };
  auto gAt = [&](float x, float z) { dvec2 q = toW(x, z); return float(world.height(q.x, q.y) - o.y); };

  float rMax = ropeY, rMin = ropeY, zF = HL - 0.4f, zB = -HL + 0.4f;
  for (float z = 0; z <= HL + 2.6f; z += 0.5f)
    for (float sg : {1.f, -1.f}) {
      float a = ropeAt(o, sg * z, 0), b = ropeAt(o, sg * z, 1);
      if (!std::isfinite(a) || !std::isfinite(b)) continue;
      rMax = std::max({rMax, a, b});
      if (z <= HL + 0.5f) rMin = std::min({rMin, a, b});
      if (std::max(std::fabs(a - ropeY), std::fabs(b - ropeY)) > 0.25f) {
        if (sg > 0) zF = std::min(zF, z - 0.5f); else zB = std::max(zB, 0.5f - z);
      }
    }
  zF = std::max(1.5f, zF); zB = std::min(-1.5f, zB);
  const float lf = std::clamp(rMin - carH - 0.5f, 0.4f, DECK - 1.1f);

  const int nb = std::max(4, int(std::lround((2 * HL - 0.4f) / 4.2f)));
  std::vector<float> zc;
  for (int i = 0; i <= nb; i++) zc.push_back(-HL + 0.2f + ((2 * HL - 0.4f) * i) / nb);
  const float dc = (zc[size_t(nb - 2)] + zc[size_t(nb - 1)]) / 2, d0 = dc - 0.9f, d1 = dc + 0.9f, doorH = 2.5f;

  const float xo = -WL - STAIR_W, xi = -WL, xm = (xo + xi) / 2, LAND0 = d0 - 0.25f, LAND1 = d1 + 0.2f;
  const float gd = std::clamp(gAt(xm, LAND0 - 7.4f), -3.f, DECK - 1.2f);
  const float rise = DECK - gd;
  const int nSteps = std::max(3, int(std::lround(rise / 0.175f)));
  const float rr = rise / nSteps, dzs = 0.29f, run = nSteps * dzs, zFoot = LAND0 - run;
  float gMin = std::min(gd, 0.f);
  for (float gx : {-WL, 0.f, WR, xo}) for (float gz : {-HL, -HL / 2, 0.f, HL / 2, HL, zFoot}) gMin = std::min(gMin, gAt(gx, gz));
  const float yb = gMin - 0.8f;

  const float xc0 = (WR - WL) / 2, Wr = (WL + WR) / 2 + 0.45f, R = 1.0f, E = roofEaves(rMax);
  F1 roofTop = [=](float x) { float u = (x - xc0) / Wr; return E + R * (1 - u * u); };
  F1 roofBot = [=](float x) { return roofTop(x) - ROOF_T; };
  const float zr1 = HL + 0.9f, zr0 = -zr1;
  const float pt = portalHeader(ropeY, rMax);
  auto curve = [&](float x0, float x1, float dy) { std::vector<vec2> out; for (int i = 0; i <= 14; i++) { float x = x0 + (x1 - x0) * i / 14; out.push_back(vec2(x, roofBot(x) - dy)); } return out; };
  auto cat = [](std::vector<vec2> a, const std::vector<vec2>& b) { a.insert(a.end(), b.begin(), b.end()); return a; };

  MeshKit K(4);
  auto bench = [&](float x0, float x1, float z0, float z1, float y0, int back) {
    K.box(BASE, x0, x1, y0 + 0.42f, y0 + 0.47f, z0, z1, c.wood);
    for (float z : {z0 + 0.25f, z1 - 0.25f}) K.box(METAL, x0 + 0.04f, x1 - 0.04f, y0, y0 + 0.42f, z - 0.03f, z + 0.03f, c.anth);
    if (back) { float xb = back < 0 ? x0 : x1 - 0.05f; K.box(BASE, xb, xb + 0.05f, y0 + 0.55f, y0 + 0.88f, z0, z1, c.wood); }
  };

  // plinth, deck, channels
  K.box(BASE, -WL, WR, yb, lf, -HL, HL, c.stone, &c.laneFloor);
  for (auto [x0, x1] : {std::pair<float, float>{Ro, WR}, {-WL, -Ro}, {-Ri, Ri}}) K.box(BASE, x0, x1, lf, DECK, -HL, HL, c.conc, &c.pave);
  for (float x : {-WL, WR}) K.box(BASE, x - 0.03f, x + 0.03f, lf - 0.08f, lf - 0.02f, -HL - 0.03f, HL + 0.03f, c.dark);
  for (float sz : {-1.f, 1.f}) K.box(BASE, -WL - 0.03f, WR + 0.03f, lf - 0.08f, lf - 0.02f, sz * HL - 0.03f, sz * HL + 0.03f, c.dark);
  for (auto [z0, z1] : {std::pair<float, float>{-8.2f, -5.2f}, {5.2f, 8.2f}}) {
    K.box(METAL, WR - 0.02f, WR + 0.02f, 0.5f, 2.3f, z0, z1, c.dark);
    for (int k = 0; k < 7; k++) K.box(METAL, WR, WR + 0.07f, 0.62f + k * 0.25f, 0.68f + k * 0.25f, z0 + 0.05f, z1 - 0.05f, c.anth);
  }

  // the outside stair
  K.box(BASE, xo, xi, yb, DECK, LAND0, LAND1, c.stone, &c.pave);
  for (int k = 0; k < nSteps; k++) K.box(BASE, xo, xi - 0.01f, yb, gd + rr * (k + 1), zFoot + k * dzs, std::min(LAND0, zFoot + (k + 1) * dzs + 0.005f), c.conc, &c.pave);
  const float xg = xo + 0.06f, yh = 0.95f;
  K.quad(GLASS, vec3(xg, gd + 0.1f, zFoot + 0.15f), vec3(xg, DECK + 0.1f, LAND0), vec3(xg, DECK + 1.0f, LAND0), vec3(xg, gd + 1.0f, zFoot + 0.15f), c.white);
  K.vquad(GLASS, xg, LAND0, xg, LAND1 - 0.06f, DECK + 0.08f, DECK + 1.0f, c.white);
  K.vquad(GLASS, xg, LAND1 - 0.06f, xi, LAND1 - 0.06f, DECK + 0.08f, DECK + 1.0f, c.white);
  K.bar(METAL, vec3(xg, gd + yh + 0.08f, zFoot + 0.15f), vec3(xg, DECK + yh + 0.08f, LAND0), 0.06f, c.steel, true);
  K.bar(METAL, vec3(xg, DECK + yh + 0.08f, LAND0), vec3(xg, DECK + yh + 0.08f, LAND1 - 0.06f), 0.06f, c.steel, true);
  K.bar(METAL, vec3(xg, DECK + yh + 0.08f, LAND1 - 0.06f), vec3(xi, DECK + yh + 0.08f, LAND1 - 0.06f), 0.06f, c.steel, true);
  for (int k = 0; k <= 3; k++) { float t = k / 3.f, z = zFoot + 0.15f + (LAND0 - zFoot - 0.15f) * t, y = gd + (DECK - gd) * t; K.bar(METAL, vec3(xg, y, z), vec3(xg, y + yh + 0.08f, z), 0.05f, c.steel, true); }
  K.bar(METAL, vec3(xg, DECK, LAND1 - 0.06f), vec3(xg, DECK + yh + 0.08f, LAND1 - 0.06f), 0.05f, c.steel, true);
  K.bar(METAL, vec3(xi - 0.09f, gd + 0.9f, zFoot), vec3(xi - 0.09f, DECK + 0.9f, LAND0), 0.05f, c.steel, true);
  const float canY = DECK + 2.75f;
  K.box(METAL, xo - 0.25f, xi, canY, canY + 0.14f, LAND0 - 0.5f, LAND1 + 0.3f, c.white);
  K.box(BASE, xo - 0.21f, xi, canY + 0.14f, canY + 0.24f, LAND0 - 0.46f, LAND1 + 0.26f, c.snow);
  K.box(LIGHT, xo + 0.5f, xo + 0.7f, canY - 0.02f, canY, LAND0, LAND1 - 0.2f, c.white);
  for (float z : {d0, d1}) K.box(METAL, -WL - 0.02f, -WL + 0.14f, DECK, DECK + doorH, z - 0.05f, z + 0.05f, c.anth);
  K.box(METAL, -WL - 0.02f, -WL + 0.14f, DECK + doorH - 0.1f, DECK + doorH, d0 + 0.05f, d1 - 0.05f, c.anth);
  K.vquad(GLASS, -WL + 0.2f, d0 + 0.05f, -WL + 0.2f, d0 + 0.5f, DECK, DECK + doorH - 0.1f, c.white);
  K.vquad(GLASS, -WL + 0.2f, d1 - 0.5f, -WL + 0.2f, d1 - 0.05f, DECK, DECK + doorH - 0.1f, c.white);
  const float rz0 = -HL + 0.6f, rz1 = std::min(zFoot - 3.0f, rz0 + 2.0f), rg = gAt(-WL - 0.4f, (rz0 + rz1) / 2) - 0.05f;
  if (rz1 - rz0 > 0.8f) {
    const float x0 = -WL - 0.7f, x1 = -WL - 0.15f;
    for (float z : {rz0, rz1}) K.box(METAL, x0, x0 + 0.06f, rg, rg + 1.3f, z - 0.03f, z + 0.03f, c.anth);
    for (float y : {0.5f, 1.25f}) K.box(METAL, x0, x0 + 0.06f, rg + y, rg + y + 0.05f, rz0, rz1, c.steel);
    const vec3 cols[6] = {hexColor("#b3262b"), c.blue, c.yellow, c.dark, c.white, c.steel};
    int n = int(std::floor((rz1 - rz0 - 0.2f) / 0.26f));
    for (int i = 0; i < n; i++) {
      float z = rz0 + 0.18f + i * 0.26f;
      for (float dz : {0.f, 0.08f}) K.bar(BASE, vec3(x1, rg + 0.07f, z + dz), vec3(x0 + 0.09f, rg + 1.75f, z + dz), 0.07f, cols[i % 6]);
    }
  }

  // the platforms
  const float zl = HL - 0.25f;
  for (float sx : {-1.f, 1.f}) {
    K.box(BASE, sx * (Ro + 0.3f), sx * (Ro + 0.45f), DECK, DECK + 0.025f, -zl, zl, c.yellow);
    K.box(BASE, sx * (Ri - 0.45f), sx * (Ri - 0.3f), DECK, DECK + 0.025f, -zl, zl, c.yellow);
  }
  const float rb = Ro + 0.1f, yb0 = DECK + 0.08f, yb1 = DECK + 1.0f, zg = 3.6f, ze = HL - 0.3f;
  for (float sx : {-1.f, 1.f}) {
    float x = sx * rb;
    for (auto [z0, z1] : {std::pair<float, float>{-ze, -zg - 0.1f}, {zg + 0.1f, ze}}) {
      K.vquad(GLASS, x, z0, x, z1, yb0, yb1, c.white);
      int n = std::max(1, int(std::lround((z1 - z0) / 2)));
      for (int k = 0; k <= n; k++) { float z = z0 + ((z1 - z0) * k) / n; K.bar(METAL, vec3(x, DECK, z), vec3(x, yb1 + 0.04f, z), 0.05f, c.steel, true); }
      K.bar(METAL, vec3(x, yb1 + 0.04f, z0), vec3(x, yb1 + 0.04f, z1), 0.06f, c.steel, true);
    }
    for (float z : {-zg + 0.1f, 0.f, zg - 0.1f}) {
      K.box(METAL, x - 0.09f, x + 0.09f, DECK, DECK + 1.15f, z - 0.09f, z + 0.09f, c.yellow);
      K.box(LIGHT, x - 0.095f, x + 0.095f, DECK + 1.15f, DECK + 1.17f, z - 0.07f, z + 0.07f, c.white);
    }
    for (auto [z0, z1] : {std::pair<float, float>{-zg + 0.2f, -1.77f}, {-1.73f, -0.1f}, {0.1f, 1.73f}, {1.77f, zg - 0.2f}}) {
      K.vquad(GLASS, x, z0, x, z1, DECK + 0.25f, DECK + 0.95f, c.white);
      K.box(METAL, x - 0.03f, x + 0.03f, DECK + 0.93f, DECK + 0.99f, z0, z1, c.yellow);
    }
  }
  for (float sz : {-1.f, 1.f}) {
    float z = sz * (HL - 0.15f);
    K.bar(METAL, vec3(-Ri + 0.15f, DECK + 0.95f, z), vec3(Ri - 0.15f, DECK + 0.95f, z), 0.06f, c.steel, true);
    for (float x : {-Ri + 0.15f, Ri - 0.15f}) K.bar(METAL, vec3(x, DECK, z), vec3(x, DECK + 0.98f, z), 0.05f, c.steel, true);
  }
  const float bx = Ri - 0.85f, bz = 1.7f, bh = DECK + 2.6f;
  K.box(METAL, -bx, bx, DECK, DECK + 0.95f, -bz, bz, c.anth);
  const float cab[4][4] = {{-bx, -bz, bx, -bz}, {bx, -bz, bx, bz}, {bx, bz, -bx, bz}, {-bx, bz, -bx, -bz}};
  for (auto& w : cab) K.vquad(GLASS, w[0], w[1], w[2], w[3], DECK + 0.95f, bh, c.white);
  for (auto [x, z] : {std::pair<float, float>{-bx, -bz}, {bx, -bz}, {bx, bz}, {-bx, bz}}) K.box(METAL, x - 0.06f, x + 0.06f, DECK + 0.9f, bh, z - 0.06f, z + 0.06f, c.anth);
  K.box(METAL, -bx - 0.2f, bx + 0.2f, bh, bh + 0.2f, -bz - 0.2f, bz + 0.2f, c.white);
  K.box(METAL, -bx - 0.23f, bx + 0.23f, bh + 0.03f, bh + 0.11f, -bz - 0.23f, bz + 0.23f, c.blue);
  K.box(LIGHT, -0.05f, 0.05f, bh - 0.03f, bh, -bz + 0.4f, bz - 0.4f, c.white);
  for (float sx : {-1.f, 1.f}) K.box(METAL, sx * (bx - 0.5f) - 0.4f, sx * (bx - 0.5f) + 0.4f, DECK + 0.95f, DECK + 1.0f, -bz + 0.2f, bz - 0.2f, c.steel);
  for (float sz : {-1.f, 1.f}) K.box(METAL, -0.08f, 0.08f, DECK, DECK + 1.3f, sz * (bz + 1.2f) - 0.08f, sz * (bz + 1.2f) + 0.08f, c.yellow);
  const float xw = -WL + 0.36f, bz0 = -HL + 1.2f, bz1 = bz0 + 3.4f;
  bench(xw, xw + 0.48f, bz0, bz1, DECK, -1);
  const float xq = -rb - 1.4f, zq0 = -3.2f, zq1 = 0.6f;
  for (int k = 0; k <= 3; k++) { float z = zq0 + ((zq1 - zq0) * k) / 3; K.bar(METAL, vec3(xq, DECK, z), vec3(xq, DECK + 0.95f, z), 0.06f, c.steel, true); }
  K.box(METAL, xq - 0.02f, xq + 0.02f, DECK + 0.82f, DECK + 0.9f, zq0, zq1, c.yellow);
  const float xsc = (-WL + 0.3f - rb) / 2, ysc = DECK + 2.75f;
  const float screens[2] = {-4.9f, 1.2f};
  for (float z : screens) {
    K.box(METAL, xsc - 0.7f, xsc + 0.7f, ysc - 0.37f, ysc + 0.37f, z - 0.05f, z + 0.05f, c.dark);
    for (float dx : {-0.5f, 0.5f}) K.bar(METAL, vec3(xsc + dx, ysc + 0.37f, z), vec3(xsc + dx, roofBot(xsc + dx) - 0.12f, z), 0.03f, c.steel, true);
  }
  for (float z : {-HL + 1.4f, -6.4f, -3.2f, -0.6f, 2.6f, HL - 2.4f}) {
    K.bar(METAL, vec3(xsc, roofBot(xsc) - 0.12f, z), vec3(xsc, DECK + 3.36f, z), 0.025f, c.anth, true);
    K.add(METAL, cylinderGeo(0.1f, 0.26f, 0.24f, 14, true).translate(xsc, DECK + 3.24f, z), c.anth);
    K.add(LIGHT, cylinderGeo(0.2f, 0.2f, 0.02f, 14).translate(xsc, DECK + 3.13f, z), c.white);
  }

  // the hall: frames, glass, roof
  const float xcL = -WL + 0.2f, xcR = WR - 0.2f;
  for (float z : zc) {
    for (float x : {xcL, xcR}) K.box(METAL, x - 0.15f, x + 0.15f, DECK, roofBot(x), z - 0.15f, z + 0.15f, c.steel);
    for (int k = 0; k < 10; k++) {
      float x0 = xcL + ((xcR - xcL) * k) / 10, x1 = xcL + ((xcR - xcL) * (k + 1)) / 10;
      K.bar(METAL, vec3(x0, roofBot(x0) - 0.13f, z), vec3(x1, roofBot(x1) - 0.13f, z), 0.2f, c.steel);
    }
  }
  auto cutDoor = [&](float z0, float z1, float sx) {
    std::vector<std::pair<float, float>> out;
    if (sx > 0 || z1 <= d0 - 0.1f || z0 >= d1 + 0.1f) { out.push_back({z0, z1}); return out; }
    if (d0 - 0.1f - z0 > 0.2f) out.push_back({z0, d0 - 0.1f});
    if (z1 - (d1 + 0.1f) > 0.2f) out.push_back({d1 + 0.1f, z1});
    return out;
  };
  for (float sx : {-1.f, 1.f}) {
    float x = sx < 0 ? -WL + 0.08f : WR - 0.08f, yW = roofBot(x) - 0.02f;
    for (int i = 0; i < nb; i++) {
      float z0 = zc[size_t(i)] + 0.15f, z1 = zc[size_t(i) + 1] - 0.15f, zm = (z0 + z1) / 2;
      for (auto [a, b] : cutDoor(z0, z1, sx)) K.vquad(GLASS, x, a, x, b, DECK + 0.1f, yW, c.white);
      if (sx > 0 || zm < d0 - 0.1f || zm > d1 + 0.1f) K.box(METAL, x - 0.04f, x + 0.04f, DECK + 0.02f, yW - 0.04f, zm - 0.04f, zm + 0.04f, c.anth);
    }
    for (float y : {DECK + 0.1f, DECK + 1.1f}) for (auto [a, b] : cutDoor(zc[0], zc[size_t(nb)], sx)) K.box(METAL, x - 0.05f, x + 0.05f, y - 0.04f, y + 0.04f, a, b, c.anth);
    K.box(METAL, x - 0.05f, x + 0.05f, yW - 0.08f, yW, zc[0], zc[size_t(nb)], c.anth);
    if (sx < 0 && DECK + doorH < yW - 0.3f) K.vquad(GLASS, x, d0 - 0.1f, x, d1 + 0.1f, DECK + doorH, yW - 0.08f, c.white);
  }
  const float xa = Ro + 0.15f;
  for (float sz : {-1.f, 1.f}) {
    float zg1 = sz * (HL - 0.12f);
    for (float sx : {-1.f, 1.f}) {
      float Ws = sx < 0 ? WL : WR, xmu = sx * (Ws + xa) / 2;
      K.shapeZ(GLASS, cat({{sx * xa, DECK + 0.1f}, {sx * Ws, DECK + 0.1f}}, curve(sx * Ws, sx * xa, 0.02f)), zg1, c.white);
      K.box(METAL, sx * (Ro + 0.12f) - 0.15f, sx * (Ro + 0.12f) + 0.15f, DECK, pt, zg1 - 0.15f, zg1 + 0.15f, c.steel);
      K.box(METAL, xmu - 0.04f, xmu + 0.04f, DECK, roofBot(xmu), zg1 - 0.04f, zg1 + 0.04f, c.anth);
      K.box(METAL, sx * xa, sx * Ws, DECK + 1.06f, DECK + 1.14f, zg1 - 0.05f, zg1 + 0.05f, c.anth);
    }
    if (std::min(roofBot(-xa), roofBot(xa)) - 0.1f > pt + 0.45f) K.shapeZ(GLASS, cat({{-xa, pt + 0.4f}, {xa, pt + 0.4f}}, curve(xa, -xa, 0.02f)), zg1, c.white);
    float zA = sz * (HL - 0.35f), zBm = sz * (HL + 0.05f);
    K.box(METAL, -WL, WR, pt, pt + 0.4f, std::min(zA, zBm), std::max(zA, zBm), c.blue);
    K.box(LIGHT, -Ro, Ro, pt - 0.02f, pt, sz * (HL - 0.15f) - 0.05f, sz * (HL - 0.15f) + 0.05f, c.white);
  }
  {
    MeshKit KR(4);
    hallRoof(KR, Wr, [&](float x) { return roofTop(x + xc0); }, [&](float x) { return roofBot(x + xc0); }, zr0, zr1);
    for (int k = 0; k < 4; k++) for (Geo& g : KR.parts()[size_t(k)]) { g.translate(xc0, 0, 0); K.parts()[size_t(k)].push_back(std::move(g)); }
  }
  for (float x : {xcL + 0.8f, xc0 - 1.1f, xc0 + 1.1f, xcR - 0.8f}) K.box(LIGHT, x - 0.05f, x + 0.05f, roofBot(x) - 0.05f, roofBot(x) - 0.015f, zr0 + 0.3f, zr1 - 0.3f, c.white);
  for (float sz : {-1.f, 1.f}) downlights(K, roofBot, sz * (HL + 0.6f));
  conveyors(K, s, ropeY, roofBot, zB, zF);
  const float sh = std::min(1.0f, std::min(roofBot(xc0 - 3.2f), roofBot(xc0 + 3.2f)) - pt - 0.55f);
  if (sh > 0.4f) for (float sz : {-1.f, 1.f}) {
    float z0 = sz * (HL - 0.12f), z1 = sz * (HL + 0.05f);
    K.box(METAL, xc0 - sh * 3 - 0.1f, xc0 + sh * 3 + 0.1f, pt + 0.4f, pt + 0.5f + sh, std::min(z0, z1), std::max(z0, z1), c.dark);
  }

  // the signs and screens
  Quads q;
  auto X = [&](float x) { return x * mx; };
  const float TOT = float(SIGN_H + MID_EXTRA_H), ks = SIGN_H / TOT;
  auto uvS = [&](vec4 u) { return vec4(u.x, 1 - (1 - u.y) * ks, u.z, 1 - (1 - u.w) * ks); };
  auto uvP = [&](vec4 r) { return vec4(r.x / SIGN_W, 1 - r.w / TOT, r.z / SIGN_W, 1 - r.y / TOT); };
  if (sh > 0.4f) for (float sz : {-1.f, 1.f}) signQuad(q, vec3(X(xc0), pt + 0.45f + sh / 2, sz * (HL + 0.07f)), vec3(0, 0, sz), sh * 6, sh, uvS(UV_NAME));
  const float zSign = std::max(-HL + 2.5f, std::min(zFoot + 1.0f, (zFoot - HL) / 2 + 0.5f));
  signQuad(q, vec3(X(-WL - 0.04f), DECK - 0.55f, zSign), vec3(float(-mx), 0, 0), 4.4f, 0.733f, uvS(UV_NAME));
  signQuad(q, vec3(X(WR + 0.04f), DECK - 0.55f, 0), vec3(float(mx), 0, 0), 5.4f, 0.9f, uvS(UV_NAME));
  signQuad(q, vec3(X(xo - 0.04f), DECK - 1.0f, (LAND0 + LAND1) / 2), vec3(float(-mx), 0, 0), 1.8f, 0.675f, uvS(UV_ENTRANCE));
  for (float z : screens) for (float sz : {-1.f, 1.f}) signQuad(q, vec3(X(xsc), ysc, z + sz * 0.055f), vec3(0, 0, sz), 1.3f, 0.65f, uvP(vec4(0, 384, 384, 576)));
  std::string place = o.place.empty() ? "Mid-station" : o.place, lower = place;
  for (auto& ch : lower) ch = char(std::tolower(uint8_t(ch)));
  std::string sub = lower.find("mid-station") != std::string::npos || lower.find("midstation") != std::string::npos ? place : "Mid-station \xc2\xb7 " + place;
  gfx::Texture tex = signTexture(dev, fonts, o.name.empty() ? "Gondola" : o.name, sub, true, o.up, o.down);
  return assemble(dev, K, mx, q, tex);
}
} // namespace

std::shared_ptr<Model> buildGondolaStation(gfx::Device& dev, const World& world, const FontSet& fonts, const GondolaStationParams& p) {
  return p.mid ? midStation(dev, world, fonts, p) : endStation(dev, world, fonts, p);
}

} // namespace sl
