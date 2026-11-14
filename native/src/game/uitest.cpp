// SKI_LEGACY_DEBUG=uitest: the UI screens that need a situation to show up (a race under way, its results...), drawn
// from sample states so they can be compared with the web game's screenshots without playing up to them.
#include "game/uitest.h"
#include "game/racehud.h"
#include "game/policehud.h"
#include "game/buildmenu.h"
#include <cmath>

namespace sl {

const std::vector<std::string>& uiTestScreens() {
  static const std::vector<std::string> names = {"racehud", "race_count3", "race_go", "race_notice", "race_third", "race_results", "race_results15", "race_results_dnf", "police_pursuit", "police_pullover", "police_search", "police_slam", "police_busted", "build", "build_deny"};
  return names;
}

void uiTestDraw(Ui& ui, const UiNav& nav, const Input& in, const std::string& name, double age, double now) {
  static RaceResults res;
  static std::string resFor;
  auto hudState = [&]() {
    RaceHudState h;
    h.course = "Legacy World Downhill"; h.difficulty = "HARD";
    h.time = 41.32; h.position = 3; h.total = 15; h.checkpoint = 2; h.checkpoints = 6;
    h.hasNext = true; h.nextLabel = "GATE"; h.nextDist = 184; h.nextAngle = -24;
    h.toFinish = 4820; h.progress = 0.28; h.speed = 27.4; h.penalty = 0.5;
    h.standings = {{"L. Meier", 0, false}, {"A. Brunner", 0.42, false}, {"You", 1.18, true}, {"K. Oberhofer", 2.6, false}, {"T. Sonnleitner-Hutter", 3.31, false}, {"M. Egger", 5.02, false}, {"F. Huber", 7.9, false}};
    return h;
  };
  if (name == "racehud") {
    RaceHudState h = hudState();
    h.split = {true, 2, 6, 41.32, -0.84, true, "Ice Bridge", 0.9};
    drawRaceHud(ui, h);
  } else if (name == "race_count3" || name == "race_go") {
    RaceHudState h = hudState();
    h.time = 0; h.penalty = 0; h.position = 12; h.standings.clear();
    h.countdown = name == "race_go" ? "GO" : "3"; h.countdownAge = 0.35;
    drawRaceHud(ui, h);
  } else if (name == "race_notice") {
    RaceHudState h = hudState();
    h.notice = "WRONG WAY"; h.noticeKind = 1; h.noticeAge = 0.6; h.noticeFor = 0;
    h.position = 14; h.standings.clear();
    for (int i = 0; i < 15; i++) h.standings.push_back({i == 13 ? "You" : "Racer " + std::to_string(i + 1), i * 1.37, i == 13});
    drawRaceHud(ui, h);
  } else if (name == "race_third") {
    RaceHudState h = hudState();
    h.time = 0; h.penalty = 0; h.standings.clear(); h.position = 0;
    h.third = {true, "WORLD RACING \xC2\xB7 HARD", "Legacy World Downhill", {{"LENGTH", "6.7 KM"}, {"DROP", "1,450 M"}, {"FIELD", "15"}}, 1.5, 9};
    drawRaceHud(ui, h);
  } else if (name.rfind("race_results", 0) == 0) {
    if (resFor != name) {
      resFor = name;
      res = RaceResults();
      res.courseName = "Legacy World Downhill";
      if (name == "race_results") {
        res.difficulty = "Hard"; res.place = 3; res.time = 70.5; res.medal = 2; res.pb = true; res.previousBest = 71.34; res.penalty = 0.5; res.prize = 1880; res.prizeMult = 1.5;
        res.rows = {{"L. Meier", 69.32, 0, false, false}, {"A. Brunner", 69.74, 0.42, false, false}, {"You", 70.5, 1.18, true, false}, {"K. Oberhofer", 71.92, 2.6, false, false},
                    {"T. Sonnleitner-Hutter", 72.63, 3.31, false, false}, {"M. Egger", 74.34, 5.02, false, false}, {"F. Huber", 77.2, 7.9, false, false}, {"S. Gruber", NAN, NAN, false, true}};
      } else if (name == "race_results15") {
        static const char* nm[14] = {"L. Meier", "A. Brunner", "K. Oberhofer", "T. Sonnleitner-Hutter", "M. Egger", "F. Huber", "S. Gruber", "P. Wolf", "J. Lang", "R. Moser", "D. Hofer", "N. Bauer", "C. Pichler", "E. Steiner"};
        res.difficulty = "Superhard"; res.place = 1; res.time = 222.7; res.medal = 1; res.previousBest = 220.1; res.prize = 11750; res.prizeMult = 2.5;
        for (int i = 0; i < 15; i++) res.rows.push_back({i == 0 ? "You" : nm[i - 1], 222.7 + i * 1.37, i * 1.37, i == 0, false});
        res.choices = {{"ok", "OK", "ENTER"}};
      } else {
        res.difficulty = "Medium"; res.place = 0; res.time = NAN; res.dnf = true; res.previousBest = 71.34;
        res.rows = {{"L. Meier", 69.32, 0, false, false}, {"A very long racer name that will not fit the column", 69.74, 0.42, false, false}, {"You", NAN, NAN, true, true}};
      }
      res.shownAt = now - 3;
    }
    frameRaceResults(ui, nav, in, res, now);
  }
  else if (name.rfind("police_", 0) == 0) {
    PoliceHudState H;
    H.now = now; H.t = "1:23"; H.stars = 3; H.cars = 3;
    if (name == "police_pullover") {
      H.stars = 1; H.cars = 1; H.t = "0:07"; H.state = "PULL OVER";
      H.msg = "Police \xC2\xB7 pull over";
      H.tip = "Pull over at the side of the road and stop.\nStay put and you only pay the $250 fine.\nDrive off and they'll chase you \xC2\xB7 jail if caught.";
      H.radio = "All units: speeding \xC2\xB7 suspect in a car near Legacy Village"; H.near = "SEEN \xC2\xB7 45 M";
    } else if (name == "police_search") {
      H.search = H.gain = true; H.state = "SEARCHING"; H.stateCls = "lost"; H.air = true; H.tyres = "2 TYRES FLAT"; H.rb = "ROADBLOCK \xC2\xB7 120 M";
      H.msg = "They lost you \xC2\xB7 stay out of sight"; H.tip = "Stay hidden until the bar fills to escape.";
      H.heli = "The helicopter is searching the area"; H.heliCls = "lost";
      H.esc = "0:18"; H.escOf = "/ 0:30 \xC2\xB7 out of sight"; H.frac = 0.6; H.near = "LOST YOU \xC2\xB7 215 M"; H.cars = 5; H.stars = 5;
    } else {
      H.hot = true; H.state = "PURSUIT"; H.stateCls = "hot"; H.air = true;
      H.msg = "You're fleeing \xC2\xB7 escape or you'll be arrested"; H.tip = "Break their line of sight to escape.";
      H.heli = "Police helicopter is tracking you"; H.radio = "Suspect fleeing north-east on the Panoramastrasse!";
      H.esc = "0:04"; H.escOf = "/ 0:30 \xC2\xB7 out of sight"; H.frac = 0.13; H.near = "SEEN \xC2\xB7 35 M";
    }
    if (name != "police_busted") drawPoliceHud(ui, H);
    if (name == "police_slam") drawPoliceSlam(ui, "PIT!", "THEY SPUN YOU ROUND", 0.45, 0.8);
    if (name == "police_busted") drawBusted(ui, "ARRESTED", "You were caught by the police", 1.1);
  }
  else if (name.rfind("build", 0) == 0) {
    BuildMenuState S;
    S.money = 10970;
    S.categories = {{"living", "Living room"}, {"kitchen", "Kitchen"}, {"bedroom", "Bedroom"}, {"bath", "Bathroom"}, {"decor", "Decor"}, {"lights", "Lights"}};
    static const char* nm[] = {"Wingback Armchair", "Three-Seater Sofa", "Coffee Table", "Bookshelf with a very long name", "Fireplace", "TV Bench", "Dining Table", "Dining Chair", "Kitchen Island", "Fridge", "Double Bed", "Wardrobe"};
    static const int pr[] = {900, 2400, 650, 1200, 14500, 800, 1900, 350, 5200, 2100, 3600, 2900};
    for (int i = 0; i < 12; i++) S.items.push_back({"i" + std::to_string(i), nm[i], i < 6 ? "living" : i < 10 ? "kitchen" : "bedroom", pr[i]});
    S.hand = "i1"; S.look = true;
    S.status = "Click to buy \xC2\xB7 $2,400";
    if (name == "build_deny") { S.hand = "i4"; S.denyId = "i4"; S.denyAge = 0.1; S.status = "It doesn't fit there"; S.statusBad = true; }
    drawBuildMenu(ui, S, in);
  }
  (void)age;
}

} // namespace sl
