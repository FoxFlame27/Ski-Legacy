// The cloud scenery of atmosphere.js (the CPU side; the renderer bakes and draws it, engine/renderer clouds*):
//  - cumulus impostors: eight cloud shapes ray-marched once at load into a six-way-lit atlas (the renderer), drawn as
//    camera-facing cards. Banks wrap the lower flanks of the peaks and fill distant valleys (a sea of clouds below the
//    summits), orographic wisps cling to ridges, a ring of billowy banks dresses the far cloud sea, and on cloudy days
//    cumulus build above the peaks (9 km+ out). Every card fades where it meets the ground (a height map round the
//    camera: 128 x 300 m, toroidal, as atmosphere.js makeTerrainMap).
//  - the overcast deck (bad weather): four noise planes over the camera (low in snow, higher when merely cloudy; the
//    sea of clouds sinks it below the village), a whiteout when you ride through it (cloudInside).
// placeBanks / analyseCell / placeDrifters / updateImpostors / update are atmosphere.js's, line by line.
#pragma once
#include "core/math.h"
#include "engine/cloud_shapes.h"
#include "world/world.h"
#include <future>
#include <unordered_map>
#include <vector>

namespace sl {

class CloudScenery {
public:
  static constexpr int TMAP_N = 128;
  static constexpr double TMAP_CELL = 300;
  struct Wx { double snow = 0, cloud = 0, mist = 0, wind = 0, sea = 0; };
  ~CloudScenery() { if (job_.valid()) job_.wait(); }
  /// per frame: weather -> the cards and the deck (cap: the preset's quality.clouds); fog: the scene's height fog
  /// (density, falloff) the cards that would be fogged out are skipped by; now: wait for the height map (loading)
  void update(double dt, const World& world, const dvec3& cam, const Wx& wx, float fogDensity, float fogFalloff, int cap, bool now = false);
  CloudFrame frame;
  float cloudInside = 0;       // 0..1: inside the overcast deck (the caller thickens the fog: + 0.012 x this)
  bool hasInversion = false;   // the sea of clouds' deck height (sky.js inversionY) while there is one
  double inversionY = 0;
  double heightAt(double x, double z) const;   // bilinear from the map (NaN where it has no data)

private:
  void startMap(const World& world, int ci, int cj);
  void placeBanks(double cx, double cz);
  void placeDrifters(double camX, double camZ);
  int driftLayer(int n, double cx, double cz, double G, double Rm, int kind, int seed);
  bool analyseCell(int ci, int cj, double x, double z, float out[12]) const;
  float tmapGet(int I, int J) const;

  // the height map
  std::vector<float> tmap_;
  std::vector<int32_t> tmapKey_;
  int tmapCX_ = -1000000000, tmapCZ_ = -1000000000;
  bool mapFresh_ = false;
  struct MapJob { int ci, cj; std::vector<float> h; std::vector<int32_t> key; };
  std::future<MapJob> job_;
  double villageY_ = 1e30;
  double regional_ = 1e30;
  // the cloud records: x, z, kind, atlas cell, mirror, width, rank, floor, height here, top of the area, seed, drifts
  std::vector<float> rec_;
  int recCount_ = 0, recAnchored_ = 0;
  std::vector<int> order_;
  std::vector<double> key_;
  std::unordered_map<int64_t, std::vector<float>> bankCache_;   // grid cell -> analysed record (empty: none there)
  int sortTick_ = 0;
  dvec2 banksAt_{1e9}, driftAt_{1e9};
  bool banksDirty_ = true;
  dvec2 drift_{0};
  double time_ = 0;
};

} // namespace sl
