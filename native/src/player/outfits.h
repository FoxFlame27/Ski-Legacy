// Outfits: a port of src/game/outfits.js. The Meshy skiers' baked albedo recoloured per garment (jacket + accent,
// trousers + accent, helmet, goggle lens) keeping every fold, seam and baked shadow of the original texture.
// The zones are found once per character model exactly like the JS (analyzeZones: area-weighted surface samples of
// the albedo clustered in OKLab with the same seeded k-means, a role per cluster and body region from the skinned bind
// pose, the goggle lens found in a front view of the head, the waist / neck splits, tall boots, specks and blend
// clusters; vertexZones: where each garment may be, per vertex). A look is then baked once into the albedo and a
// roughness / metalness map in UV space (outfits.js bakeLook: the recolour shader per texel of the UV islands,
// islands padded by 6 texels, the original elsewhere) — here on the CPU, the same per-texel maths.
#pragma once
#include "core/math.h"
#include "engine/model.h"
#include <memory>
#include <string>
#include <vector>


namespace sl {
struct RigModel;

/// A look (outfits.js outfitLook): sRGB hex colours, null slots keep the original.
struct OutfitLook {
  bool jacket = false, trousers = false, helmet = false, lens = false;
  uint32_t jBase = 0, jAccent = 0, tBase = 0, tAccent = 0, hColor = 0, lTint = 0;
  std::string finish = "gloss";
  double mirror = 1;
  bool any() const { return jacket || trousers || helmet || lens; }
  std::string key() const;
};
/// The look of the equipped item ids (save.outfits.equipped[char]: { jacket, trousers, helmet, lens }); catalogue
/// items, kits' pieces ('kit_gold.jacket').
OutfitLook outfitLookOf(const std::string& jacket, const std::string& trousers, const std::string& helmet, const std::string& lens);

struct OutfitZones;
/// The model's garment zones (analysed once, cached per model); null when it cannot be recoloured.
std::shared_ptr<OutfitZones> outfitZones(const RigModel& rig);
/// The model `body` dressed in `look`: a copy of it wearing the baked albedo + roughness / metalness maps (null: none).
std::shared_ptr<Model> dressModel(gfx::Device& dev, const RigModel& rig, const OutfitLook& look, std::vector<gfx::Texture>& owned);
/// zone summary for the log (has jacket / accent / trousers / accent / helmet / lens)
std::string outfitZonesInfo(const RigModel& rig);

} // namespace sl
