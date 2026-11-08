#include "game/economy.h"
#include "core/log.h"
#include "platform/platform.h"
#include <algorithm>
#include <cmath>

namespace sl {

// economy.js SKIS
const SkiDef kSkis[] = {
  {"rental", "Rental Carver", "ski_rental", 50, true, 1.0, 1.0, "Basic rental skis. Forgiving and slow-ish. Returned at the end of your stay."},
  {"cruiser", "Pistenfuchs 165", "ski_pistenfuchs", 300, false, 1.015, 1.05, "All-mountain carver with a slight rocker tip. Easy to turn, a touch quicker than the rentals."},
  {"sport", "Sport All-Mountain 170", "ski_sport", 800, false, 1.03, 1.08, "Lively all-mountain ski. +3% glide speed, better edge hold."},
  {"park", "Twin Tip Park 168", "ski_park", 1000, false, 1.02, 1.1, "Twin-tip freestyle ski for the park. Pops off kickers, lands switch."},
  {"powder", "Powder Hound 184", "ski_powder", 1200, false, 1.03, 1.12, "Wide freeride ski. Floats off-piste and stays calm at speed."},
  {"touring", "Summit Touring 176", "ski_touring", 1600, false, 1.04, 1.1, "Light touring ski. Quick and nimble everywhere on the mountain."},
  {"carver", "Slalom Carver SL", "ski_carver", 2200, false, 1.045, 1.2, "Short-radius slalom ski. Bites hard on every turn."},
  {"pro", "World Cup GS Pro", "ski_pro", 3000, false, 1.06, 1.16, "Race-stock giant slalom ski. +6% speed, razor edges."},
  {"gs", "Giant Slalom R30", "ski_gs", 4000, false, 1.07, 1.18, "World Cup giant slalom ski. Fast and stable through long turns."},
  {"superg", "Super-G Arrow", "ski_superg", 5500, false, 1.085, 1.2, "Long super-G race ski built for pure speed."},
  {"elite", "Legacy Elite Downhill", "ski_elite", 8000, false, 1.1, 1.22, "Hand-built downhill weapon. +10% speed, unmatched stability."},
  {"legend", "Legacy Gold Edition", "ski_legend", 12000, false, 1.12, 1.25, "The ultimate ski. +12% speed and perfect edge grip."},
};
const size_t kSkiCount = sizeof(kSkis) / sizeof(kSkis[0]);
const char* const kGearYouOwn[6] = {"Helmet", "Goggles", "Ski jacket", "Ski pants", "Gloves", "Ski boots"};

const SkiDef* skiById(const std::string& id) {
  for (const SkiDef& s : kSkis) if (id == s.id) return &s;
  return nullptr;
}

// outfits.js OUTFIT_ITEMS (jackets, trousers, helmets, lenses; the kits are left out)
const OutfitDef kOutfits[] = {
  {"j_glacier", "jacket", "Glacier Blue", 400, 0x1f6fd1, 0xf2f5f8, "Two-tone"}, {"j_racing", "jacket", "Racing Red", 400, 0xd0202e, 0xf2f5f8, "Two-tone"},
  {"j_forest", "jacket", "Forest Green", 350, 0x2f6b3d, 0xe3b23c, "Two-tone"}, {"j_teal", "jacket", "Lagoon Teal", 500, 0x0f9aa0, 0xf2f5f8, "Two-tone"},
  {"j_sunset", "jacket", "Sunset Orange", 450, 0xff6a1a, 0x1d2a44, "Two-tone"}, {"j_arctic", "jacket", "Arctic White", 550, 0xf1f4f7, 0x23303f, "Two-tone"},
  {"j_midnight", "jacket", "Midnight Black", 550, 0x1b1d22, 0xd42a35, "Two-tone"}, {"j_rose", "jacket", "Powder Pink", 600, 0xf06ea8, 0xffffff, "Two-tone"},
  {"j_volt", "jacket", "Volt Yellow", 650, 0xecd51a, 0x1b1d22, "Two-tone"}, {"j_violet", "jacket", "Ultra Violet", 650, 0x6b2fd0, 0x34e0d6, "Two-tone"},
  {"j_retro", "jacket", "Retro Navy", 850, 0x1c2b4f, 0xff7a1a, "Two-tone"}, {"j_mint", "jacket", "Mint Charcoal", 850, 0x7fdcbf, 0x2a2f36, "Two-tone"},
  {"t_black", "trousers", "Black", 250, 0x1b1c1f, 0x3a3d44, "Two-tone"}, {"t_charcoal", "trousers", "Charcoal", 250, 0x3a3f47, 0x1b1c1f, "Two-tone"},
  {"t_navy", "trousers", "Navy", 300, 0x1d2a4a, 0xc9ced6, "Two-tone"}, {"t_olive", "trousers", "Olive", 300, 0x4f5a35, 0x2a2f1f, "Two-tone"},
  {"t_sand", "trousers", "Sand", 300, 0xb9986c, 0x5a4632, "Two-tone"}, {"t_snow", "trousers", "Snow White", 350, 0xeef1f4, 0xc4cad3, "Two-tone"},
  {"t_red", "trousers", "Race Red", 400, 0xc81e2c, 0x1b1c1f, "Two-tone"}, {"t_sky", "trousers", "Sky Blue", 400, 0x5aa8e6, 0xffffff, "Two-tone"},
  {"h_matteblack", "helmet", "Matte Black", 200, 0x1c1d20, 0x1c1d20, "Matte finish"}, {"h_white", "helmet", "Gloss White", 250, 0xf4f5f7, 0xf4f5f7, "Gloss finish"},
  {"h_olive", "helmet", "Matte Olive", 300, 0x4d5a33, 0x4d5a33, "Matte finish"}, {"h_navy", "helmet", "Matte Navy", 300, 0x1f2d55, 0x1f2d55, "Matte finish"},
  {"h_red", "helmet", "Gloss Red", 350, 0xd0202e, 0xd0202e, "Gloss finish"}, {"h_neon", "helmet", "Neon Yellow", 400, 0xe8f01c, 0xe8f01c, "Gloss finish"},
  {"h_silver", "helmet", "Chrome Silver", 700, 0xc9ccd2, 0xc9ccd2, "Chrome finish"}, {"h_gold", "helmet", "Gold Chrome", 1200, 0xd9a93a, 0xd9a93a, "Chrome finish"},
  {"l_clear", "lens", "Clear", 150, 0xdfe8ee, 0xdfe8ee, "Clear lens"}, {"l_smoke", "lens", "Smoke", 200, 0x3a3d44, 0x3a3d44, "Tinted lens"},
  {"l_rose", "lens", "Rose", 300, 0xff7aa8, 0xff7aa8, "Tinted lens"}, {"l_ice", "lens", "Ice Blue Mirror", 400, 0x45b0ff, 0x45b0ff, "Mirror coating"},
  {"l_fire", "lens", "Fire Red Mirror", 400, 0xff3b1f, 0xff3b1f, "Mirror coating"}, {"l_emerald", "lens", "Emerald Mirror", 450, 0x21c26b, 0x21c26b, "Mirror coating"},
  {"l_violet", "lens", "Violet Mirror", 450, 0x8a5cff, 0x8a5cff, "Mirror coating"}, {"l_gold", "lens", "Gold Mirror", 550, 0xffb02a, 0xffb02a, "Mirror coating"},
};
const size_t kOutfitCount = sizeof(kOutfits) / sizeof(kOutfits[0]);
const OutfitDef* outfitById(const std::string& id) {
  for (const OutfitDef& o : kOutfits) if (id == o.id) return &o;
  return nullptr;
}

int repairCost(double frac) {
  if (!(frac > 0)) return 0;
  return std::min(REPAIR_FEE, std::max(5, int(std::round(REPAIR_FEE * std::min(1.0, frac) / 5.0)) * 5));
}

nlohmann::json settingDefaults() {
  return nlohmann::json{
    {"renderScale", 1.0}, {"shadows", true}, {"bloom", true}, {"fog", 1.0}, {"brightness", 1.0}, {"fpsCap", 0},
    {"musicVolume", 0.7}, {"sfxVolume", 1.0}, {"voiceVolume", 0.95}, {"muteUnfocused", false},
    {"invertY", false}, {"vibration", true}, {"padSens", 1.0},
    {"fov", 65.0}, {"camShake", true}, {"speedFx", true}, {"vignette", true}, {"defaultView", "third"},
    {"speedUnit", "kmh"}, {"clock12", false}, {"showSpeedo", true}, {"showInfo", true}, {"showMoney", true}, {"showForecast", true},
    {"showFps", false}, {"hudScale", 1.0}, {"flashSize", "m"}, {"nameTags", true},
    {"volume", 0.8}, {"sensitivity", 1.0}, {"fullscreen", false}};
}

// keys stored at the top level of the save that are device settings (DEVICE_PREFS + SETTING_KEYS)
static bool isSettingKey(const std::string& k) {
  static const nlohmann::json d = settingDefaults();
  return d.contains(k);
}

void Save::reset() {
  money = 500; skis.clear(); owned.clear(); character = "skier_blue"; characterChosen = false;
  dayPass = -1; tickets = 0; day = 1; hour = 9.5; stats = Stats{}; rescues = 0; tutorial = true; quality.clear();
  outfits = Outfits{}; garage.clear(); rentalPlate.clear();
  binds = nlohmann::json::object();
  settings = settingDefaults();
  extra_ = nlohmann::json::object();
  dirty_ = false;
}

bool Save::ownsSki(const std::string& id) const { return std::find(owned.begin(), owned.end(), id) != owned.end(); }
bool Save::ownsOutfit(const std::string& id) const { return std::find(outfits.owned.begin(), outfits.owned.end(), id) != outfits.owned.end(); }
int Save::rescueFee() const { return std::min(RESCUE_FEE_MAX, RESCUE_FEE_BASE + RESCUE_FEE_STEP * std::max(0, rescues)); }
double Save::setting(const char* key, double def) const {
  auto it = settings.find(key);
  if (it == settings.end()) return def;
  if (it->is_boolean()) return it->get<bool>() ? 1 : 0;
  return it->is_number() ? it->get<double>() : def;
}
bool Save::settingOn(const char* key) const { return setting(key, 0) != 0; }
std::string Save::settingStr(const char* key, const char* def) const {
  auto it = settings.find(key);
  return it != settings.end() && it->is_string() ? it->get<std::string>() : std::string(def);
}

bool Save::spend(int64_t amount, bool force) {
  if (amount <= 0) return true;
  if (!force && money < amount) return false;
  money -= amount;
  lastDelta = -amount; lastDeltaAt = clock;
  dirty_ = true;
  return true;
}
void Save::earn(int64_t amount) {
  if (amount <= 0) return;
  money += amount;
  stats.earned += double(amount);
  lastDelta = amount; lastDeltaAt = clock;
  dirty_ = true;
}

nlohmann::json Save::toJson() const {
  nlohmann::json j = extra_;
  j["money"] = money;
  j["skis"] = skis.empty() ? nlohmann::json(nullptr) : nlohmann::json(skis);
  j["owned"] = owned;
  j["character"] = character;
  if (characterChosen) j["characterChosen"] = true;
  j["dayPass"] = dayPass; j["tickets"] = tickets; j["day"] = day; j["hour"] = hour;
  j["stats"] = {{"races", stats.races}, {"wins", stats.wins}, {"topSpeed", stats.topSpeed}, {"distance", stats.distance}, {"earned", stats.earned},
                {"longestJump", stats.longestJump}, {"bestAir", stats.bestAir}};
  if (!j.contains("raceBest")) j["raceBest"] = nlohmann::json::object();
  if (!j.contains("records")) j["records"] = nlohmann::json::object();
  j["quality"] = quality.empty() ? nlohmann::json(nullptr) : nlohmann::json(quality);
  j["tutorial"] = tutorial;
  j["rescues"] = rescues;
  j["outfits"] = {{"owned", outfits.owned}, {"equipped", outfits.equipped}};
  nlohmann::json g = nlohmann::json::array();
  for (const Car& c : garage) g.push_back({{"id", c.id}, {"paint", c.paint}, {"interior", "standard"}, {"rims", "standard"}, {"plate", c.plate}, {"custom", c.custom}, {"price", c.price}, {"damage", c.damage}});
  j["garage"] = g;
  j["rental"] = nlohmann::json(nullptr);
  for (const Car& c : garage) if (c.plate == rentalPlate) j["rental"] = g[size_t(&c - garage.data())];
  j["binds"] = binds;
  for (auto& [k, v] : settings.items()) j[k] = v;
  j["layoutVersion"] = 2;
  return j;
}

void Save::fromJson(const nlohmann::json& s) {
  reset();
  if (!s.is_object()) return;
  auto num = [&](const char* k, auto def) { auto it = s.find(k); return it != s.end() && it->is_number() ? it->get<decltype(def)>() : def; };
  auto str = [&](const char* k, const std::string& def) { auto it = s.find(k); return it != s.end() && it->is_string() ? it->get<std::string>() : def; };
  money = num("money", int64_t(500));
  skis = str("skis", "");
  if (s.contains("owned") && s["owned"].is_array()) for (auto& o : s["owned"]) if (o.is_string()) owned.push_back(o.get<std::string>());
  character = str("character", "skier_blue");
  if (character != "skier_red" && character != "skier_blue") character = "skier_blue";   // (characters.js migrateCharacter, condensed)
  characterChosen = s.value("characterChosen", false);
  dayPass = num("dayPass", -1); tickets = num("tickets", 0); day = std::max(1, num("day", 1)); hour = num("hour", 9.5);
  if (s.contains("stats") && s["stats"].is_object()) {
    const auto& t = s["stats"];
    stats.races = t.value("races", 0); stats.wins = t.value("wins", 0); stats.topSpeed = t.value("topSpeed", 0.0); stats.distance = t.value("distance", 0.0);
    stats.earned = t.value("earned", 0.0); stats.longestJump = t.value("longestJump", 0.0); stats.bestAir = t.value("bestAir", 0.0);
  }
  rescues = num("rescues", 0);
  tutorial = s.value("tutorial", true);
  quality = str("quality", "");
  if (s.contains("outfits") && s["outfits"].is_object()) {   // (economy.js cleanOutfits)
    const auto& o = s["outfits"];
    if (o.contains("owned") && o["owned"].is_array()) for (auto& id : o["owned"]) if (id.is_string() && !ownsOutfit(id.get<std::string>())) outfits.owned.push_back(id.get<std::string>());
    if (o.contains("equipped") && o["equipped"].is_object()) outfits.equipped = o["equipped"];
  }
  if (s.contains("garage") && s["garage"].is_array())
    for (auto& c : s["garage"]) {
      if (!c.is_object() || !c.contains("id") || !c["id"].is_string() || c.value("free", false) || c.value("admin", false)) continue;
      Car car;
      car.id = c["id"]; car.plate = c.value("plate", std::string()); car.paint = c.value("paint", std::string("factory"));
      car.price = c.contains("price") && c["price"].is_number() ? c["price"].get<int>() : 0; car.damage = c.value("damage", 0.0); car.custom = c.value("custom", false);
      if (car.id == "car_dacia_duster") car.id = "car_vw_golf_gti";   // (carrental.js RETIRED)
      if (car.plate.empty()) car.plate = "SL " + std::to_string(1000 + garage.size() * 37 % 9000);
      bool dup = false;
      for (const Car& g : garage) dup = dup || g.plate == car.plate;
      if (!dup && int(garage.size()) < GARAGE_MAX) garage.push_back(car);
    }
  if (s.contains("rental") && s["rental"].is_object()) rentalPlate = s["rental"].value("plate", std::string());
  if (s.contains("binds") && s["binds"].is_object()) binds = s["binds"];
  for (auto& [k, v] : s.items()) if (isSettingKey(k) && !v.is_null()) settings[k] = v;
  if (s.contains("sensitivity") && s["sensitivity"].is_number()) settings["sensitivity"] = s["sensitivity"];
  static const char* mine[] = {"money", "skis", "owned", "character", "characterChosen", "dayPass", "tickets", "day", "hour", "stats", "rescues",
                               "tutorial", "quality", "outfits", "garage", "rental", "binds", "layoutVersion"};
  for (auto& [k, v] : s.items()) {
    bool known = isSettingKey(k);
    for (const char* m : mine) known = known || k == m;
    if (!known) extra_[k] = v;
  }
}

bool Save::load(platform::Platform& p) {
  std::vector<uint8_t> b;
  if (!p.readSave(file_, b) || b.empty()) return false;
  auto j = nlohmann::json::parse(b.begin(), b.end(), nullptr, false);
  if (j.is_discarded() || !j.is_object()) { SL_WARN("save %s: unreadable, starting a new one", file_.c_str()); return false; }
  fromJson(j);
  SL_INFO("save: loaded %s ($%lld, day %d, %zu skis, %zu cars)", file_.c_str(), (long long)money, day, owned.size(), garage.size());
  return true;
}

bool Save::write(platform::Platform& p) {
  if (mpWrite) { dirty_ = false; lastWrite_ = clock; return mpWrite(*this); }
  std::string s = toJson().dump();
  bool ok = p.writeSave(file_, std::vector<uint8_t>(s.begin(), s.end()));
  if (ok) { dirty_ = false; lastWrite_ = clock; }
  else SL_WARN("save: could not write %s", file_.c_str());
  return ok;
}

void Save::tick(platform::Platform& p, double now, double interval) {
  clock = now;
  if (dirty_ && now - lastWrite_ >= interval) write(p);
}

} // namespace sl
