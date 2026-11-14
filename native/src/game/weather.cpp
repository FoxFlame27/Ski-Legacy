#include "game/weather.h"
#include "core/noise.h"
#include <cstdlib>

namespace sl {

namespace {
// sky.js WEATHER
const Weather::Def DEFS[Weather::N] = {
  {"clear", "Clear", 0, 0, 0.1f, 0, 0, 0, 0, 0},
  {"flurries", "Snow flurries", 0.34f, 0.3f, 0.15f, 0, 0, 0, 0, 0},
  {"cloudy", "Cloudy", 0, 0.7f, 0.25f, 0, 0, 0, 0, 0},
  {"light", "Light snow", 0.55f, 0.75f, 0.3f, 0, 0, 0, 0, 0},
  {"heavy", "Heavy snow", 1, 1, 0.45f, 0, 0, 0, 0, 0},
  {"mist", "Misty", 0, 0.45f, 1, 0, 0, 0, 0, 0},
  {"blizzard", "Blizzard", 0.9f, 1, 0.5f, 1, 0, 0, 0, 0},
  {"foehn", "F\xC3\xB6hn", 0, 0.06f, 0, 0.6f, 1, 0, 0, 0},
  {"sleet", "Wet snow", 0.45f, 0.85f, 0.35f, 0, 0, 1, 0, 0},
  {"fog", "Freezing fog / Raureif", 0, 0.4f, 1, 0, 0, 0, 1, 0},
  {"inversion", "Sea of clouds", 0, 0, 0.12f, 0, 0, 0, 0, 1},
};
// sky.js NEXT (indices into DEFS)
const std::vector<int> NEXT[Weather::N] = {
  {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 5, 5, 5, 7, 10},
  {0, 0, 3, 1, 2},
  {3, 0, 1, 4, 0, 2, 3, 0, 1, 8},
  {4, 2, 1, 3, 2, 4, 2, 1, 3, 8},
  {3, 2, 3, 6},
  {0, 1, 2, 0, 1, 2, 0, 1, 2, 9},
  {4, 3},
  {0, 0, 2},
  {3, 2, 2},
  {5, 2, 0},
  {0, 0, 5},
};
const vec3 OVER_TOP(0.330f, 0.400f, 0.505f), OVER_HOR(0.700f, 0.820f, 0.990f), OVER_FOG(0.520f, 0.640f, 0.820f);
const vec3 WARM_TINT(1.25f, 0.95f, 0.78f), MIST_FOG(0.62f, 0.78f, 1.02f);
bool icyWx(int w) { return w == 4 || w == 6 || w == 8 || w == 9; }
} // namespace

const Weather::Def& Weather::def(int i) { return DEFS[std::clamp(i, 0, N - 1)]; }
int Weather::byId(const std::string& id) { for (int i = 0; i < N; i++) if (id == DEFS[i].id) return i; return -1; }

void Weather::init(unsigned seed, bool fz) {
  seed_ = seed ? seed : 1;
  frozen = fz;
  cur_ = 0; next_ = pick(0); timer = 75;
  // (dev / screenshots: SKI_LEGACY_WEATHER=mist|fog|heavy|... starts in that weather, settled and held)
  if (const char* e = std::getenv("SKI_LEGACY_WEATHER")) snap(byId(e));
}

void Weather::snap(int w) {
  if (w < 0 || w >= N) return;
  const Def& W = DEFS[w];
  if (w != cur_) { cur_ = w; next_ = pick(w); }
  frozen = true;
  snow = W.snow; cloud = W.cloud; mist = W.mist; wind = W.wind; clearAir = W.clear; wet = W.wet; frost = W.frost; sea = W.sea;
}

int Weather::pick(int w) { const auto& o = NEXT[w]; return o[size_t(rnd() * double(o.size())) % o.size()]; }

void Weather::set(int w) {
  if (w < 0 || w >= N || w == cur_) return;
  cur_ = w;
  next_ = pick(w);
  changes++;
}

std::string Weather::forecast() const {
  if (frozen || next_ == cur_ || timer > 600) return "";
  return std::string("Later: ") + DEFS[next_].label;
}

void Weather::update(double dt) {
  if (!frozen) {
    timer -= dt;
    if (timer <= 0) {
      const auto& o = NEXT[cur_];
      int nx = std::find(o.begin(), o.end(), next_) != o.end() ? next_ : pick(cur_);   // (the forecast comes true)
      set(nx);
      timer = nx == 6 ? 60 + rnd() * 60 : 80 + rnd() * 100;
    }
  }
  const Def& W = DEFS[cur_];
  double k = std::min(1.0, dt * 0.06);   // ~20 s transitions
  snow += (W.snow - snow) * k; cloud += (W.cloud - cloud) * k; mist += (W.mist - mist) * k; wind += (W.wind - wind) * k;
  clearAir += (W.clear - clearAir) * k; wet += (W.wet - wet) * k; frost += (W.frost - frost) * k * 0.5; sea += (W.sea - sea) * k;
  if (icyWx(cur_)) icy = std::min(1.0, icy + dt / 40); else icy = std::max(0.0, icy - dt / 240);
  gustT_ += dt;
  double gust = wind * std::max(0.0, 0.55 + 0.45 * std::sin(gustT_ * 0.9) * std::sin(gustT_ * 0.37 + 1.3)) * 0.3;
  gustX = gust * 0.93; gustZ = gust * 0.37;
}

void Weather::apply(Lighting& L, double sunH) const {
  double overcast = std::max(snow, cloud * 0.85);
  double clearSky = 1 - overcast;
  double lightLevel = lerp(0.035, 1, smoothstep(-0.2, 0.3, sunH));
  double warmO = smoothstep(-0.12, 0.02, sunH) * (1 - smoothstep(0.05, 0.3, sunH));
  vec3 grey = glm::mix(vec3(1), WARM_TINT, float(warmO * 0.6)) * float(lightLevel * lerp(1, 0.82, snow));
  float oc = float(overcast * 0.94);
  L.zenith = glm::mix(L.zenith, OVER_TOP * grey, oc);
  L.mid = glm::mix(L.mid, glm::mix(OVER_TOP, OVER_HOR, 0.5f) * grey, oc);
  L.horizon = glm::mix(L.horizon, OVER_HOR * grey, oc);
  L.glow = glm::mix(L.glow, OVER_HOR * grey, oc);
  L.fog = glm::mix(L.fog, OVER_FOG * grey, oc);
  double whiteout = std::min(1.0, mist * 0.55 + snow * 0.5) * lightLevel;
  L.fog = glm::mix(L.fog, MIST_FOG * grey, float(whiteout * 0.6));
  double night = 1 - smoothstep(-0.18, 0.02, sunH);
  L.fogDensity = float((lerp(0.000034, 0.0013, snow * snow) + mist * mist * 0.0016 + night * 0.00003 + wind * snow * 0.00025 + frost * 0.0006) * (1 - clearAir * 0.45));
  L.fogFalloff = float(lerp(0.00045, 0.00025, overcast));
  L.sunIntensity *= float(lerp(1, 0.17, overcast));
  float sl = glm::length(L.sky);
  L.sky = glm::mix(L.sky, vec3(0.62f, 0.68f, 0.78f) * sl * 1.1f, float(overcast * 0.7));
  L.sky *= float(lerp(1, 1.5, overcast));
  (void)clearSky;
  // (the renderer's sky model: sky.js's clouds, halo, sun disc and IBL from the weather)
  L.overcast = float(overcast); L.snow = float(snow); L.mist = float(mist); L.cloud = float(cloud); L.wind = float(wind);
  L.icy = float(icy); L.frost = float(frost); L.clearAir = float(clearAir); L.snowCover = float(std::max(snow, cloud * 0.2));
}

void Weather::drawSnow(Renderer& r, VehicleDraw& vd, gfx::Device& dev, Shapes& shapes, const Camera& cam, double dt, bool indoors) {
  (void)vd; (void)dev; (void)shapes;
  // atmosphere.js update: the air the flakes ride (the wind swings round slowly, more in heavy snow; a blizzard
  // drives it sideways at ~9 m/s; sleet below the rain line falls four times as fast), accumulated as a drift the
  // renderer's GPU flakes are offset by
  snowT_ += dt;
  double wt = snowT_ * 0.05;
  double rain = wet * (1 - smoothstep(70.0, 150.0, cam.pos.y));   // (the village stands at y ~ 0)
  dvec2 w(1.5 + std::sin(wt) * 2.5 * snow + 1 + wind * 8.5, 0.6 + std::cos(wt * 0.7) * 1.5 + wind * 3.4);
  double fall = 1 + 2.8 * rain + 0.4 * wind;
  snowOff_ += dvec3(w.x, fall, w.y) * dt;
  Snowfall s;
  s.amount = indoors ? 0.f : float(snow);
  s.rain = float(rain);
  s.time = float(std::fmod(snowT_, 3600.0));
  s.drift = vec3(float(std::fmod(snowOff_.x, 2944.0)), float(std::fmod(snowOff_.y, 2944.0)), float(std::fmod(snowOff_.z, 2944.0)));
  s.vel = vec3(float(w.x), float(-fall), float(w.y));
  r.setSnowfall(s);
}

} // namespace sl
