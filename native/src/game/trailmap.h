// The trail map (src/ui/trailmap.js, ported whole): the resort as a piste map in the house style.
// A white paper sheet over the dimmed game: the TRAIL MAP stroke, "You are here · <place>", the layer switches (Pistes &
// lifts, Races, Roads & car parks, Buses & train, Places, Jobs, Mine), the Legend button and its panel, the scale bar,
// the tooltip of what you point at and the hint row. The relief underneath is shaded from the terrain itself
// (trailmap.js buildTile: hillshade lit from the north-west, snow white to pale blue, rock grey-blue on steep faces,
// forest a light blue-green, faint contour lines) in tiles at three detail levels, computed on the worker threads while
// the map is open (coarse ones first) and kept for the session. Over it, as the JS draws them: the roads (valley grey,
// scenic amber, tunnels dashed with portal marks, roundabouts, the car parks, the road names along them), the village,
// the chalet village, Legacy Park, the pistes in their grade colours with number badges, the Legacy Express (violet,
// dashed in tunnels) and its stations, the race tapes with pins, finishes and cards, the lifts (chairlift ticks,
// gondola cabins, stations, names along the line), the Wolkenspitzbahn, and every place as an icon in the one style
// (placed by priority, folded into "+n" where they would overlap; labels never overlap), your car, the mark, you.
// Controls: drag / left stick / arrows = move, wheel / trackpad / Q E / triggers = zoom (about the pointer), double
// click = zoom in, R / Y = back to you, point = info, click = mark a place (the HUD's waypoint points there; click it
// again to clear), M / Esc / B / a click outside the sheet = close.
#pragma once
#include "core/math.h"
#include "engine/ui.h"
#include "game/menus.h"
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sl {
class AssetPaths;
class JobSystem;
class World;
class Transport;
class Lifts;
struct PlayData;
namespace platform { class Platform; }

class TrailMap {
public:
  TrailMap();
  ~TrailMap();
  void load(platform::Platform& p, const AssetPaths& paths, const World& world, const Transport& t, Lifts& lifts);
  /// the races, job boards, the police station, the chalets (play.json)
  void setPlay(const PlayData* play);
  /// the relief is built on the job system while the map is open
  void buildRelief(JobSystem& jobs, const World& world, gfx::Device& dev);
  /// every relief tile the view wants is there
  bool reliefReady() const;
  void open(const dvec3& at);
  void close();
  bool isOpen() const { return open_; }
  /// input + drawing; returns false when it closed itself (cancel)
  bool frame(Ui& ui, const UiNav& nav, const Input& in, double dt, const dvec3& you, double heading, const dvec3* car);
  struct Mark { bool on = false; double x = 0, z = 0; std::string label; } mark;
  std::string hover;
  int drawnItems = 0;               // (autotest) what the last frame drew
  /// the other systems' markers (trailmap.js markers()): filled by the game each frame the map is open
  struct Marker { double x = 0, z = 0; std::string kind, label, what; double r = 0, yaw = 0; bool flag = false; };
  struct Live { std::vector<Marker> jobs, mine, police, players, secrets; int ownChalet = -1; };
  std::function<void(Live&)> live;
  /// a layer switch (0 pistes, 1 races, 2 roads, 3 transit, 4 places, 5 jobs, 6 mine)
  bool layer(int i) const;
  void setLayer(int i, bool on);
  /// (autotest / uitest) the view: centre (m) and zoom (CSS px per m); the legend
  void setView(double x, double z, double s);
  void showLegend(bool on);

  // ---------------------------------------------------------------- the route picker (src/ui/travel.js RoutePicker)
  // Where E at a ski bus stop, a railway station or a Legacy Express station takes you: the line on the house-style map
  // (the relief, pistes and lifts quiet underneath), its stops, where you are, and the destinations as a list beside
  // it. The arrows / W S / the D-pad / [ ] or the pointer highlight a stop (the route there lights up), Enter / click
  // rides there, 1-9 pick directly, Esc cancels.
  struct TravelDest {
    std::string name, meta, tag;          // tag: FREE / DAY PASS (a chip instead of the price)
    double x = 0, z = 0;
    int id = -1;                          // the caller's handle: the stop / station index (the railway: 1 up, 0 down)
    std::vector<dvec2> path;              // the trip on the map
    int price = -1;                       // $ (-1: none)
    bool shortMoney = false, transfer = false, disabled = false;
    uint32_t color = 0;                   // a race destination: its difficulty colour (a pin in the list)
    std::string race;                     // course id (the Express: joined to its race on the map)
    std::function<void()> act;
    // the plan card under the list (the Express): a name in a colour and up to three cells (label, value, small unit)
    std::string planName;
    uint32_t planColor = 0;
    struct Cell { std::string k, v, unit; };
    std::vector<Cell> plan;
  };
  struct TravelStop { std::string name; double x = 0, z = 0; std::string course; };
  struct Travel {
    std::string title, kicker, subPre, subBold, subPost, listHead;
    int lineStyle = 0;                    // 0 bus, 1 rail, 2 lift, 3 express
    std::vector<std::vector<dvec3>> lines;   // x, z, tunnel (0 / 1)
    std::vector<TravelStop> stops;
    TravelStop from;
    std::vector<TravelDest> dests;
    std::string go = "RIDE";
    std::function<std::string(const TravelDest&)> goLabel;
    std::function<void()> onCancel;
    int focus = 0;
  };
  /// the ski bus from stop `from` (transport stop index) to each of `dests`; the game adds each destination's act
  Travel busTravel(int from, const std::vector<int>& dests) const;
  /// the Wolkenspitzbahn from station `st`: every other station, up (the fare / the day pass) or down (free)
  Travel railTravel(int st, bool pass, long long money) const;
  /// a gondola's mid-station (lift index in Lifts::lines()): the line with its three stations, up (the price / the day
  /// pass) or down (free); each destination's id: 1 up, 0 down
  Travel liftTravel(int line, bool pass, long long money) const;
  /// the Legacy Express from station `st`: every other station with its race; the races first, nearest first
  Travel expressTravel(int st, bool pass, long long money) const;
  void openTravel(Travel t);
  bool travelOpen() const;
  void closeTravel();
  /// input + drawing; false once it closed (a ride chosen, or cancelled)
  bool frameTravel(Ui& ui, const UiNav& nav, const Input& in, double dt, const dvec3& you, double heading);
  /// (autotest) the highlighted destination, highlighting one by its name, riding there
  std::string travelFocused() const;
  bool travelFocus(const std::string& name);
  void travelChoose();

private:
  struct Impl;
  std::unique_ptr<Impl> m_;
  bool open_ = false;
};

} // namespace sl
