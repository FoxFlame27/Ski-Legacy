// SKI_LEGACY_DEBUG=uitest: the UI screens that need a situation to show up (a race under way, its results...), drawn
// from sample states so they can be compared with the web game's screenshots without playing up to them.
#include "game/uitest.h"
#include "game/racehud.h"
#include "game/carconfigui.h"
#include "game/popups.h"
#include "game/policehud.h"
#include "game/buildmenu.h"
#include "game/shopui.h"
#include "game/jobboardui.h"
#include <cmath>

namespace sl {

const std::vector<std::string>& uiTestScreens() {
  static const std::vector<std::string> names = {"racehud", "race_count3", "race_go", "race_notice", "car_paint", "car_wheels", "car_plate", "car_sum", "car_full", "race_third", "race_podium", "race_sting", "race_replay", "race_trick", "race_trick_free", "race_results", "race_results15", "race_results_dnf", "police_pursuit", "police_pullover", "police_search", "police_slam", "police_busted", "build", "build_deny", "shop", "shop_broke", "jobboard", "jobboard_detail", "jobboard_current", "racestand", "dialog", "dialog_long", "menu_pause", "menu_controls", "menu_stats", "menu_settings", "menu_play", "menu_mp"};
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
  } else if (name == "race_trick" || name == "race_trick_free") {
    static Popups pp;
    static std::string forName;
    if (forName != name) {
      forName = name;
      pp = Popups();
      if (name == "race_trick") pp.trick("360 Mute Grab", 1250, 4300, 0, now - 0.7);
      else { pp.trick("Switch Double Backflip Japan Grab", 0, 0, 2, now - 0.7); pp.best("PERSONAL BEST", "Top speed", "112", "KM/H", now - 0.7); }
    }
    if (name == "race_trick") { RaceHudState h = hudState(); h.standings.clear(); drawRaceHud(ui, h); }
    pp.draw(ui, name == "race_trick", now);
  } else if (name == "race_podium") {
    RaceHudState h = hudState();
    h.time = 70.5; h.penalty = 0;
    h.third.on = true; h.third.bars = false; h.third.kicker = "PODIUM \xC2\xB7 HARD"; h.third.title = "Legacy World Downhill"; h.third.age = 2; h.third.left = 9;
    h.third.rows = {{1, "L. Meier", "1:09.32", false}, {2, "A. Brunner", "1:09.74", false}, {3, "You", "1:10.50", true}};
    drawRaceHud(ui, h);
  } else if (name == "race_sting") {
    drawStinger(ui, "REPLAY", 0.42);
  } else if (name == "race_replay") {
    RaceHudState h;
    h.third.on = true; h.third.age = 3; h.third.left = 99; h.third.title = ""; h.shownFor = -1;
    ui.rect(0, 0, float(ui.width()), 84 * ui.cssU(), ui_color::hex(0x040a16)); ui.rect(0, float(ui.height()) - 84 * ui.cssU(), float(ui.width()), 84 * ui.cssU(), ui_color::hex(0x040a16));
    drawReplayBadge(ui, "1:09.32", true, 2, now);
  } else if (name.rfind("car_", 0) == 0) {
    static CarCfgView cv;
    static std::string forName;
    if (forName != name) {
      forName = name;
      cv = CarCfgView();
      cv.carLabel = "VW Golf GTI"; cv.carPrice = 11250; cv.cfg.id = "car_golf"; cv.cfg.plate = "OW 57514"; cv.money = 500;
      cv.drag = [](float, float) {};
      if (name == "car_wheels") { cv.step = 1; cv.cfg.paint = "violet"; cv.cfg.rims = "gold"; cv.money = 1234567; }
      if (name == "car_plate") { cv.step = 2; cv.cfg.plate = "SKI-L3GY"; cv.cfg.custom = true; }
      if (name == "car_sum") { cv.step = 3; cv.cfg.paint = "sand"; cv.cfg.rims = "bronze"; cv.cfg.custom = true; cv.cfg.plate = "LEGACY 1"; cv.money = 250000; }
      if (name == "car_full") {
        cv.step = 3; cv.money = 90000; cv.owned = 1; cv.garageMax = 2;
        cv.garage = {{"car_golf", "VS 482211", "VW Golf GTI", "red", 5600, true}, {"car_x", "ZH 90211", "Mercedes-Benz G 63 AMG Brabus 800 Widestar", "mgrey", 152500, false}};
        cv.sellArm = "ZH 90211";
      }
      cv.openedAt = now - 3; cv.swapAt = now - 3; cv.shownStep = cv.step; cv.frames = 5;
      if (name == "car_plate") { cv.typing = true; cv.selAll = false; }
    }
    UiNav nv = nav;
    nv.confirm = nv.cancel = nv.menu = nv.click = nv.up = nv.down = nv.left = nv.right = nv.tabPrev = nv.tabNext = false; nv.keys.clear(); nv.text.clear();
    if (name == "car_full") cv.scrollTarget = cv.scroll = 1e5f;
    frameCarConfig(ui, nv, in, cv, 0.016, now);
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
    S.thumbs = buildThumbs();   // (loaded by the chalets; the sample cards borrow the first twelve renders)
    for (int i = 0; i < 12; i++) S.items.push_back({S.thumbs && size_t(i) < S.thumbs->ids.size() ? S.thumbs->ids[size_t(i)] : "i" + std::to_string(i), nm[i], i < 6 ? "living" : i < 10 ? "kitchen" : "bedroom", pr[i]});
    S.hand = S.items[1].id; S.look = true;
    S.status = "Click to buy \xC2\xB7 $2,400";
    if (name == "build_deny") { S.hand = S.denyId = S.items[4].id; S.denyAge = 0.1; S.status = "It doesn't fit there"; S.statusBad = true; }
    drawBuildMenu(ui, S, in);
  }
  else if (name.rfind("shop", 0) == 0) {
    static ShopView v;
    static std::string vFor;
    if (vFor != name) {
      vFor = name;
      v = ShopView();
      v.title = "Outfits"; v.tabs = {{"JACKETS", "JACKET"}, {"TROUSERS", "TROUSERS"}, {"HELMETS", "HELMET"}, {"GOGGLES", "GOGGLE LENS"}, {"KITS", "FULL KIT"}};
      v.money = 500;
      v.rows = {{"", "Original", "The original piece, free", 0, true, true, 0, 0, 0, {}}, {"a", "Glacier Blue", "Two-tone", 400, false, false, 1, 0x1f6fd1, 0xf2f5f8, {}},
                {"b", "Racing Red", "Two-tone", 400, false, false, 1, 0xd0202e, 0xf2f5f8, {}}, {"c", "Forest Green", "Two-tone", 350, false, false, 1, 0x2f6b3d, 0xe3b23c, {}},
                {"d", "Lagoon Teal with a name far too long for its row", "Two-tone", 500, false, false, 1, 0x0f9aa0, 0xf2f5f8, {}}, {"e", "Sunset Orange", "Two-tone", 1450000, false, false, 1, 0xff6a1a, 0x1d2a44, {}},
                {"f", "Arctic White", "Two-tone", 550, true, false, 1, 0xf1f4f7, 0x23303f, {}}, {"g", "Chrome Dome", "Chrome finish", 900, false, false, 2, 0xc0c8d0, 0, {}}, {"h", "Fire Mirror", "Mirror coating", 700, false, false, 3, 0xff6a1a, 0, {}}};
      v.focus = name == "shop_broke" ? 5 : 2;
      if (name == "shop_broke") v.rows[5].notes = {"This jacket has no second colour panel, so it takes the main colour only"};
      v.openedAt = now - 3; v.swapAt = now - 3;
    }
    UiNav quiet;
    quiet.mouse = vec2(-1);
    frameShop(ui, quiet, in, v, 0.016, now);
  }
  else if (name.rfind("jobboard", 0) == 0) {
    static JobBoardView v;
    static std::string vFor;
    if (vFor != name) {
      vFor = name;
      v = JobBoardView();
      v.place = "Legacy Village";
      JobNote a0; a0.id = "a"; a0.type = "delivery"; a0.title = "Fondue cheese to Sonnenkopf H\xC3\xBCtte"; a0.client = "Sonnenkopf H\xC3\xBCtte \xC2\xB7 the chef";
      a0.brief = "We ran out of Gruy\xC3\xA8re before the lunch rush. Bring this wheel up to the chef by the door of Sonnenkopf H\xC3\xBCtte."; a0.reward = 1130; a0.bonus = 300; a0.minutes = "14 min"; a0.diff = 2;
      JobNote b0; b0.id = "b"; b0.type = "rescue"; b0.title = "Skier down \xC2\xB7 Hasenweg"; b0.client = "Ski patrol";
      b0.brief = "Marta went down beside the Hasenweg piste and hurt a knee. Get there fast (look for the crossed skis and the red jacket), load her into the rescue sled and tow it down to the patrol hut without shaking her about."; b0.reward = 2200; b0.bonus = 500; b0.minutes = "16 min"; b0.diff = 2;
      JobNote c0; c0.id = "c"; c0.type = "escort"; c0.title = "Guide Yuki to Adlerhorn H\xC3\xBCtte"; c0.client = "Ski school";
      c0.brief = "Yuki is new to skiing and wants to get to Adlerhorn H\xC3\xBCtte. Lead the way and keep Yuki close: they follow your line."; c0.reward = 1190000; c0.bonus = 200; c0.minutes = "13 min"; c0.diff = 3;
      JobNote t0; t0.id = "taxi"; t0.type = "taxi"; t0.title = "Legacy Taxi \xC2\xB7 drive fares"; t0.client = "Legacy Taxi dispatch";
      t0.brief = "Drive guests round the resort in your own car. Buy a car at the Autohaus first, then come back."; t0.payText = "$150\xE2\x80\x93" "1,500"; t0.bonus = 1; t0.tipText = "up to 25%"; t0.minutes = "per fare"; t0.diff = 1;
      t0.locked = true; t0.lockText = "Buy a car at the Autohaus first"; t0.takeText = "BUY A CAR FIRST";
      v.offers = {a0, b0, c0, t0};
      if (name == "jobboard_detail") { v.detail = 1; v.detailAt = now - 2; }
      if (name == "jobboard_current") { v.hasCurrent = true; v.current = a0; v.current.status = "Cheese \xC2\xB7 Sonnenkopf H\xC3\xBCtte \xC2\xB7 9:42"; v.offers = {b0, c0, t0}; }
      v.openedAt = now - 3;
    }
    UiNav quiet;
    quiet.mouse = vec2(-1);
    frameJobBoard(ui, quiet, in, v, 0.016, now);
  }
  else if (name == "racestand") {
    static RaceStandView v;
    if (v.courses.empty()) {
      v.courses = {{"Sunny Meadow", "A gentle giant slalom over open meadows: the place to learn the gates.", "Easy", 1480, 78.1, 310, 2, 2},
                   {"Black Forest Giant Slalom", "Fast gates between the firs, with two blind crests.", "Medium", 2350, -1, 520, 0, 0},
                   {"Legacy World Downhill", "The World Cup downhill: almost 7 km and 1,400 m of vertical. Forest, cliffs, a tunnel, a gorge bridge and a frozen lake.", "Hard", 6706, -1, 1450, 1, 1},
                   {"Glacier Super-G", "Wide, fast and icy.", "Hard", 3900, -1, 880, 0, 0}, {"Ice Canyon", "A bobsleigh run for skis.", "Expert", 2900, -1, 760, 14, 0},
                   {"Floodlight Slalom", "Short, steep, under the lights.", "Medium", 620, -1, 190, 0, 0}, {"Big Air Line", "Kickers, one after the other.", "Easy", 1100, -1, 260, 0, 0}};
      v.i = 2; v.diff = 2; v.openedAt = now - 3;
    }
    UiNav quiet;
    quiet.mouse = vec2(-1);
    frameRaceStand(ui, quiet, in, v, 0.016, now);
  }
  (void)age;
}

} // namespace sl
