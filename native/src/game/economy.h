// The economy and the save game (src/game/economy.js, the prices of carrental.js / rescue.js / railway.js /
// express.js, core/settings.js's SETTING_DEFAULTS, outfits.js's catalogue).
//
// The save is the web game's JSON save in spirit: the same keys (money, skis, owned, character, dayPass, tickets, day,
// hour, stats, records, quality, sensitivity, tutorial, outfits, binds, garage, rescues and the flat device settings),
// written through Platform::writeSave as "ski-legacy-save-v1.json" (atomic). Keys this port does not know are kept
// as they were (a save moved over from the web game keeps its chalets, jobs...). Autosave every 60 s and on every
// purchase / settings change.
#pragma once
#include <nlohmann/json.hpp>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace sl {
namespace platform { class Platform; }

struct SkiDef { const char* id; const char* name; const char* model; int price; bool rent; double speed, grip; const char* desc; };
extern const SkiDef kSkis[];
extern const size_t kSkiCount;
const SkiDef* skiById(const std::string& id);
extern const char* const kGearYouOwn[6];

struct OutfitDef { const char* id; const char* slot; const char* name; int price; uint32_t base, accent; const char* note; };
extern const OutfitDef kOutfits[];
extern const size_t kOutfitCount;
const OutfitDef* outfitById(const std::string& id);

/// economy.js PRICES
struct Prices { static constexpr int gondola = 50, chair = 20, dayPass = 150, hotChocolate = 8; };
/// carrental.js: one flat repair price scaled by the damage, the tow, a car left on a road, selling back
constexpr int WRECK_FEE = 1500, REPAIR_FEE = 500, PARK_TOW_FEE = 500, GARAGE_MAX = 10;
constexpr double SELL_SHARE = 0.5;
/// $500 x the damage share in $5 steps, at least $5 (carrental.js repairCost)
int repairCost(double frac);
inline int wreckFee() { return WRECK_FEE + repairCost(1); }
/// rescue.js: $300, +$25 per earlier rescue, at most $1,000
constexpr int RESCUE_FEE_BASE = 300, RESCUE_FEE_STEP = 25, RESCUE_FEE_MAX = 1000;

/// economy.js DEVICE_PREFS: this machine's settings, not progress (besides every SETTINGS key): kept in the
/// single-player save while multiplayer has swapped the save for the server profile (Phase 6)
inline constexpr const char* kDevicePrefs[] = {"quality", "qualitySet", "qualityCap", "sensitivity", "volume", "binds"};

/// core/settings.js SETTING_DEFAULTS (+ the menu's volume / sensitivity)
nlohmann::json settingDefaults();

class Save {
public:
  explicit Save(std::string fileName = "ski-legacy-save-v1.json") : file_(std::move(fileName)) { reset(); }
  void reset();                                        // a new save (economy.js `save` defaults)
  bool load(platform::Platform& p);                    // false: no save yet (defaults kept)
  bool write(platform::Platform& p);                   // writeSave()
  /// (Phase 6) while multiplayer runs, write() calls this instead: the profile lives on the server, only the device
  /// settings go into the stored file, and the session pushes the parts the player owns (economy.js writeSave)
  std::function<bool(Save&)> mpWrite;
  void markDirty() { dirty_ = true; }
  /// (Phase 5) the web save's other keys in their JSON shape (records, jobs, chalet, policeRecord, impound, jail...):
  /// the entry (created as `def` when missing or of another type); written back with the save
  nlohmann::json& data(const std::string& key, const nlohmann::json& def = nlohmann::json::object()) {
    auto it = extra_.find(key);
    if (it == extra_.end() || it->type() != def.type()) { extra_[key] = def; return extra_[key]; }
    return *it;
  }
  /// autosave: writes when dirty and `interval` seconds have passed
  void tick(platform::Platform& p, double now, double interval = 60);
  const std::string& fileName() const { return file_; }
  nlohmann::json toJson() const;
  void fromJson(const nlohmann::json& j);

  // ---- progress (economy.js save)
  int64_t money = 500;
  std::string skis;                  // equipped ski id ("" = none yet: rent at the shop)
  std::vector<std::string> owned;
  std::string character = "skier_blue";
  bool characterChosen = false;
  int dayPass = -1, tickets = 0, day = 1;
  double hour = 9.5;
  struct Stats { int races = 0, wins = 0; double topSpeed = 0, distance = 0, earned = 0, longestJump = 0, bestAir = 0; } stats;
  int rescues = 0;
  bool tutorial = true;
  std::string quality;               // "" = not chosen (the --quality / default preset)
  struct Outfits { std::vector<std::string> owned; nlohmann::json equipped = nlohmann::json::object(); } outfits;
  struct Car { std::string id, plate, paint = "factory"; int price = 0; double damage = 0; bool custom = false; };
  std::vector<Car> garage;           // carrental.js save.garage (your cars; damage: this port's percentage)
  std::string rentalPlate;           // save.rental: the one out
  nlohmann::json binds = nlohmann::json::object();      // the CONTROLS screen's rebinding ({ kb, pad })
  nlohmann::json settings = nlohmann::json::object();   // the flat device settings (DEVICE_PREFS), defaults filled in

  // ---- helpers
  bool hasPass() const { return dayPass == day; }
  bool ownsSki(const std::string& id) const;
  bool ownsOutfit(const std::string& id) const;
  int rescueFee() const;
  double setting(const char* key, double def = 0) const;
  bool settingOn(const char* key) const;
  std::string settingStr(const char* key, const char* def = "") const;
  template <class T> void set(const char* key, const T& v) { settings[key] = v; dirty_ = true; }
  /// money moves (the HUD shows the delta): spend() refuses when short (unless `force`, as the rescue bill)
  bool spend(int64_t amount, bool force = false);
  void earn(int64_t amount);
  int64_t lastDelta = 0;
  double lastDeltaAt = -1e9;
  double clock = 0;                  // set by the game each frame (for lastDeltaAt)

private:
  std::string file_;
  nlohmann::json extra_ = nlohmann::json::object();     // keys this port does not use, written back as they were
  bool dirty_ = false;
  double lastWrite_ = 0;
};

} // namespace sl
