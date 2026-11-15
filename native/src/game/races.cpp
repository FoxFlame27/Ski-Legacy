#include "game/races.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/mesh_kit.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/economy.h"
#include "game/hud.h"
#include "game/menus.h"
#include "game/people.h"
#include "game/racehud.h"
#include "game/jobboardui.h"
#include "game/race_bots.h"
#include "world/snowtrails.h"
#include <cctype>
#include <cstring>
#include <cstdlib>
#include "game/race_cine.h"
#include "core/prompts.h"
#include "player/skier_rig.h"
#include "game/shapes.h"
#include "game/weather.h"
#include "platform/platform.h"
#include "player/player.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>

namespace sl {

namespace {
constexpr double PHOTO_GAP = 0.3;       // s between the player and a rival at the line = photo finish
constexpr double INTRO_LEAD_IN = 0.7;   // s on the grid before the "3" after the intro (the camera is already behind the racer)
constexpr double LEAD_IN = 1.4, GATE_PENALTY = 0.5, GATE_FLAG = 0.75, GATE_TOL = 4, RESULTS_DELAY = 2.6, RESULTS_MAX_WAIT = 6;
constexpr double STUCK_TIME = 5, STUCK_PROGRESS = 3, OFF_MARGIN = 9, OFF_TIME = 1.5, FAR_MARGIN = 40, FAR_TIME = 0.8, FALL_BELOW = 7, FALL_TIME = 0.35;
constexpr double RESPAWN_SPEED = 8, FINISH_BRAKE = 9, START_R = 24, BOARD_R = 3.0, STAND_R = 3.0;
constexpr double GRID_FIRST = 3.1, GRID_SPACING = 2.4, GRID_ROW = 2.4;
constexpr int FIELD_BOTS = 14;
// freeworld.js AI_LEVELS (the prize multipliers); the fields themselves: race_bots (bots.js DIFFICULTY)
const char* AI_KEY[4] = {"easy", "medium", "hard", "superhard"};
const char* AI_LABEL[4] = {"Easy", "Medium", "Hard", "Superhard"};
const double AI_MULT[4] = {0.6, 1, 1.6, 2.5};
// session.js: the grid keeps HOUSE_HALF / HOUSE_REACH clear of the start house; the AI field's level of detail (every
// frame within LOD_FULL, 30 Hz poses within LOD_HALF, 15 Hz beyond; off screen: not drawn unless closer than LOD_KEEP);
// BOT_SEP: m between two AI racers' centres (shoulder to shoulder, poles out)
// (HOUSE_REACH: session.js keeps 2.6 m of the house record clear, or, with the course meshes, the cells its real
// triangles cover: the racers behind the front row stand beside the house, not in its open front: 2.8 m here)
constexpr double GRID_GAP = 2.3, GRID_EDGE = 1.2, HOUSE_HALF = 3.7, HOUSE_REACH = 2.8;
constexpr double LOD_FULL = 30, LOD_HALF = 70, LOD_KEEP = 12, LOD_GONE = 900, BOT_SEP = 1.15;
constexpr int FX_MAX = 6;                       // snow FX (spray, tracks) for the nearest FX_MAX racers
constexpr double FAR_IN = 150, FAR_OUT = 135;   // m (farbots.js): rig -> stand-in beyond FAR_IN, back to the rig inside FAR_OUT
// farbots.js: suit colours of the racer outfits (the figure's parts times the racer's colour, as the instance colour)
const std::pair<const char*, const char*> FAR_SUIT[6] = {{"skier_blue", "#1f5ad6"}, {"skier_red", "#d7263d"}, {"skier_green", "#2a9d4f"}, {"skier_orange", "#f08a24"}, {"skier_black", "#22252b"}, {"skier_purple", "#7b2cbf"}};
const char* FAR_FALLBACK[10] = {"#d7263d", "#1546c8", "#f6ae2d", "#2a9d8f", "#ffffff", "#111111", "#e76f51", "#7b2cbf", "#ff6b9a", "#3a86ff"};
// farbots.js figure(): a racer in a tuck-ish stance (skis, bent legs, the torso pitched forward, the helmet; facing +Z),
// six boxes, lit like a MeshLambertMaterial, no shadow
std::shared_ptr<Model> farFigure(gfx::Device& dev, const vec3& suit) {
  Geo all;
  auto box = [&](float w, float h, float d, float x, float y, float z, const char* hex, float rx = 0) {
    Geo g = boxGeo(w, h, d);
    if (rx != 0) g.rotateX(rx);
    g.translate(x, y, z);
    g.col.assign(g.pos.size(), hexColor(hex) * suit);
    all.append(g);
  };
  box(0.09f, 0.03f, 1.75f, -0.12f, 0.02f, 0.12f, "#30343c"); box(0.09f, 0.03f, 1.75f, 0.12f, 0.02f, 0.12f, "#30343c");
  box(0.13f, 0.62f, 0.16f, -0.12f, 0.36f, 0.1f, "#ffffff", -0.35f); box(0.13f, 0.62f, 0.16f, 0.12f, 0.36f, 0.1f, "#ffffff", -0.35f);
  box(0.42f, 0.58f, 0.3f, 0, 0.95f, 0.2f, "#ffffff", 0.55f);
  box(0.24f, 0.25f, 0.26f, 0, 1.27f, 0.45f, "#eef1f5");
  Material m;
  m.baseColor = vec4(1); m.roughness = 1; m.metallic = 0; m.vertexColor = true;
  return buildModel(dev, {{std::move(all), m}}, "far-racer");
}
const char* BOT_CHARS[6] = {"skier_orange", "skier_black", "skier_purple", "skier_red", "skier_blue", "skier_green"};
// gatebars.js: the ribbon's lower and upper edge above the snow (knee high), short of each pole, m per stripe pair
constexpr double BAR_LOW = 0.36, BAR_HIGH = 0.68, BAR_INSET = 0.05, BAR_STRIPE = 0.9;
const char* BAR_COLORS[4] = {"#29d36a", "#8e959e", "#ff3b30", "#5dff8f"};   // ahead, passed, missed, next
// the barrier-tape texture (gatebars.js tapeTexture): white with pale diagonal stripes and darker hems, 128 x 32
gfx::Texture tapeTexture(gfx::Device& dev) {
  const int W = 128, H = 32;
  std::vector<uint8_t> px(size_t(W) * H * 4);
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++) {
      // (canvas row y from the top; the parallelograms (X, 32) (X + 32, 0) (X + 64, 0) (X + 32, 32) every 64 px)
      const int k = ((x + y) % 64 + 64) % 64;
      const bool stripe = k >= 32;
      const bool hem = y < 3 || y >= 29;
      const uint8_t c[3] = {uint8_t(hem ? 0x7f : stripe ? 0xc4 : 0xff), uint8_t(hem ? 0x8c : stripe ? 0xd2 : 0xff), uint8_t(hem ? 0x82 : stripe ? 0xc6 : 0xff)};
      uint8_t* q = &px[(size_t(H - 1 - y) * W + x) * 4];   // (CanvasTexture flipY: the first row uploaded is the canvas's bottom)
      q[0] = c[0]; q[1] = c[1]; q[2] = c[2]; q[3] = 255;
    }
  gfx::TextureDesc d;
  d.width = W; d.height = H; d.format = gfx::TexFormat::SRGBA8; d.wrap = gfx::Wrap::Repeat; d.anisotropy = 8;
  return dev.createTexture(d, px.data());
}
uint32_t hashStr(const std::string& str) {
  uint32_t h = 2166136261u;
  for (unsigned char ch : str) { h ^= ch; h *= 16777619u; }
  return h;
}
const double PRIZE_SHARE[3] = {1, 0.4, 0.15};
const double BUS_SHARE[3] = {1, 0.7, 0.5};
int prizeFor(const Course& c, int ai) { return int(std::round(c.reward * AI_MULT[std::clamp(ai, 0, 3)] / 50.0) * 50); }
int aiIndex(const std::string& k) { for (int i = 0; i < 4; i++) if (k == AI_KEY[i]) return i; return 1; }
const char* medalForTime(double t, const Course& c) {
  if (c.gold > 0 && t <= c.gold) return "gold";
  if (c.silver > 0 && t <= c.silver) return "silver";
  if (c.bronze > 0 && t <= c.bronze) return "bronze";
  return nullptr;
}
std::string uiwUpper(std::string t) { for (char& ch : t) ch = char(std::toupper(static_cast<unsigned char>(ch))); return t; }
int medalRank(const nlohmann::json& m) { if (!m.is_string()) return 0; std::string s = m; return s == "gold" ? 3 : s == "silver" ? 2 : s == "bronze" ? 1 : 0; }
} // namespace

struct Races::Session {
  const Course* c = nullptr;
  int ai = 1;
  bool forMoney = false, practice = false, stand = false;
  bool mp = false;   // (startMp) a race with the other players: the server's start, ranking and prize
  enum class St { Grid, Race, Finished, Results, Done } st = St::Grid;
  double t = 0, clock = 0, penalty = 0;
  int nextCp = 1, lastCp = 0, nextGate = 0;
  double prevS = 0, prevLat = 0, progS = 0, progT = 0, offT = 0, fellT = 0, crashT = -1, wrongT = 0;
  std::vector<int> missed;
  std::vector<double> splits;
  double finalTime = 0, rawTime = 0, resultsAt = 0, finishT = 0;
  int place = 0, prize = 0;
  std::string notice;
  double noticeT = -1;
  bool noticeBad = false;
  struct Gate { double s, latA, dir, span; };
  std::vector<Gate> gates;
  // the AI field (race_bots): the course model, the calibrated racers, the traffic snapshot (bots + you)
  racebots::Track* track = nullptr;
  racebots::Field field;
  std::vector<std::unique_ptr<racebots::BotRacer>> bots;
  std::vector<std::shared_ptr<Model>> farModel;   // (farbots.js: one stand-in figure per racer, in its suit's colour)
  std::vector<racebots::Racer> racers;
  std::vector<double> avoid;
  int parkCount = 0;
  double platL = 0, pSpeed = 0;   // your lateral (left +) and speed, for the racers
  bool went = false;
  // gatebars.js: a glowing green ribbon strung between the two flags of every gate; the next gate's ribbon pulses,
  // once you are through a gate its ribbon turns grey, a missed one turns red. The states are merged meshes.
  struct Bar { dvec3 a, b; double len; int state; };   // state 0 ahead, 1 passed, 2 missed
  std::vector<Bar> bars;
  bool barsDirty = true;
  int barsNext = -2;
  dvec3 barOrigin{0};
  std::shared_ptr<Model> barModel[3], barNext[4];
  gfx::Texture tape;
  int respawns = 0;
  double fadeT = -1;
  // the race HUD (ui/racehud.js): when the panels came up, the last checkpoint's split card, the results screen
  double shownAt = 0, prevBest = -1;
  bool pb = false;
  struct Sp { bool on = false; int index = 0; double split = 0, delta = 0, at = 0; bool hasDelta = false; std::string name; } sp;
  RaceResults res;
  // the broadcast presentation (session.js): every racer into the replay buffer; the podium before the results; WATCH
  // REPLAY behind the brush stinger and back to the results
  std::unique_ptr<racecine::ReplayBuffer> rep;
  std::unique_ptr<racecine::Podium> podium;
  std::unique_ptr<racecine::ReplayDirector> replay;
  bool podiumDone = false, replayEnding = false, camOn = false, hasResults = false;
  racecine::CineCam cam;
  double cineT = 0;        // real s since this cinematic began (keys held from before: ignored for 0.4 s)
  double podiumHideT = -1; // when the podium's lower third and bars went (SKIP, or the results came up)
  double stingT = -1;      // s into the stinger (-1: none)
  int stingThen = 0;       // behind it, once the strokes cover the screen: 1 the replay starts, 2 it ends
  double lbox = 0;         // the letterbox bars, 0..1
  // the intro (presentation/intro.js): the field waits in the start gate while the camera flies the course
  std::unique_ptr<racecine::CourseIntro> intro;
  bool introRan = false, introInput = false, courseCalled = false, introL3 = false;
  double camBlend = 0;       // the intro's hand-over to the gameplay camera
  bool photoDone = false;    // (one photo finish per attempt)
  double fovCarry = 0, camDt = 0;   // the field of view the camera had last frame (the gameplay camera eases from it)
  double introL3Hide = -1;   // (c_.now) when the intro's lower third went: L3_OUT, or SKIP
};

Races::Races(PlayCtx& c) : c_(c) {}
Races::~Races() = default;

racebots::Track& Races::trackOf(const Course& c) {
  for (auto& [k, t] : tracks_) if (k == &c) return *t;
  tracks_.push_back({&c, std::make_unique<racebots::Track>(c, *c_.world)});
  return *tracks_.back().second;
}

bool Races::nightCourse() const { return s_ && s_->c->night; }
bool Races::frozen() const { return s_ && s_->st == Session::St::Grid; }
bool Races::introPlaying() const { return s_ && s_->intro; }
bool Races::finished() const { return s_ && (s_->st == Session::St::Finished || s_->st == Session::St::Results); }
bool Races::resultsUp() const { return s_ && s_->st == Session::St::Results; }
double Races::raceTime() const { return s_ ? (s_->st >= Session::St::Finished ? s_->finalTime : s_->clock) : 0; }
int Races::place() const { return s_ ? s_->place : 0; }
double Races::progress() const { return s_ ? s_->prevS - s_->c->start.s : 0; }
double Races::progressS() const { return s_ ? s_->prevS : 0; }
int Races::gatesPassed() const { return s_ ? s_->nextGate : 0; }

void Races::abort() {
  if (!s_) return;
  if (c_.slowCancel) c_.slowCancel();
  endCine();
  s_.reset();
  if (c_.weather) c_.weather->frozen = c_.autotest;
}

// ---------------------------------------------------------------- the race card, the stand
void Races::openCard(const Course& co, bool fromStand) {
  Dialog d;
  const Course* cp = &co;
  // (Phase 6, main.js mpCourseInteraction) multiplayer: the race with the other players in the world (the queue: the
  // server starts it for everyone at once), or alone: against the AI field for the course's prize (the user, Nov 2026:
  // a race with only you pays like in single player), or a practice run
  if (c_.online && !fromStand && c_.raceJoin) {
    const PlayCtx::RaceQueue q = c_.raceQueue ? c_.raceQueue(co.id) : PlayCtx::RaceQueue{};
    d.kicker = co.bus ? "Free race \xC2\xB7 ski bus \xC2\xB7 multiplayer" : "World Racing \xC2\xB7 multiplayer";
    d.title = co.name;
    if (q.mine) d.say = "You are in the queue (" + std::to_string(q.n) + "/" + std::to_string(q.max) + " in" + (q.startIn >= 0 ? ", the race starts in " + std::to_string(int(std::ceil(q.startIn))) + " s" : std::string(", it starts once a second racer joins")) + ").";
    else d.say = "Race the other players (at least 2, up to " + std::to_string(q.max) + "; the others have " + std::to_string(int(std::lround(q.wait))) + " s to join after the second racer, then it starts for everyone together), or alone against the AI field." + (q.n ? " " + std::to_string(q.n) + "/" + std::to_string(q.max) + " waiting" + (q.startIn >= 0 ? ", starts in " + std::to_string(int(std::ceil(q.startIn))) + " s" : std::string()) + "." : std::string());
    if (q.mine) {
      DialogOption o; o.label = "Leave the race queue"; o.sub = "you stay here"; o.price = 0;
      o.act = [this]() { if (c_.raceLeave) c_.raceLeave(); c_.flash("Left the race queue", 0); };
      d.options.push_back(o);
    } else {
      DialogOption o; o.label = "Join race (other players \xC2\xB7 prize)";
      o.sub = std::string(co.bus ? "free entry \xC2\xB7 " : "") + "up to " + fmtMoney(co.reward) + (q.n ? " \xC2\xB7 " + std::to_string(q.n) + "/14 waiting" : std::string(" \xC2\xB7 needs a 2nd racer"));
      o.price = 0;
      o.disabled = q.n >= 14;
      o.act = [this, cp]() { c_.raceJoin(cp->id); };
      d.options.push_back(o);
      if (!co.bus) {
        int ai = aiIndex(co.ai);
        DialogOption a; a.label = std::string("Race the AI field alone \xC2\xB7 ") + AI_LABEL[ai];
        a.sub = "14 AI racers \xC2\xB7 1st " + fmtMoney(prizeFor(co, ai)) + ", 2nd " + fmtMoney(int64_t(std::round(prizeFor(co, ai) * 0.4))); a.price = co.entry;
        a.disabled = c_.save->money < co.entry;
        a.act = [this, cp, ai]() { start(*cp, ai, true, false, false); };
        d.options.push_back(a);
      } else {
        DialogOption a; a.label = "Race the field alone"; a.sub = "Free entry \xC2\xB7 every finisher is paid \xC2\xB7 win " + fmtMoney(co.reward); a.price = 0;
        a.act = [this, cp]() { start(*cp, 0, true, false, true); };
        d.options.push_back(a);
      }
      DialogOption pr; pr.label = "Practice race (no prize)"; pr.sub = "free \xC2\xB7 just you \xC2\xB7 starts at once"; pr.price = 0;
      pr.act = [this, cp]() { start(*cp, 0, false, true, cp->bus); };
      d.options.push_back(pr);
    }
    DialogOption n; n.label = "Not now"; n.secondary = true;
    d.options.push_back(n);
    c_.menus->openDialog(d);
    return;
  }
  d.kicker = co.bus ? "Free race \xC2\xB7 ski bus" : fromStand ? "RACING \xC2\xB7 just for fun \xC2\xB7 no prize money" : "World Racing \xC2\xB7 " + co.diff;
  d.title = co.name;
  d.rebuild = [this, cp, fromStand](Dialog& D) {
    const Course& c = *cp;
    char b[256];
    std::snprintf(b, sizeof b, "%.1f km \xC2\xB7 %d m drop \xC2\xB7 par %s", c.length / 1000, c.drop, fmtRaceTime(c.par).c_str());
    D.say = (c.tagline.empty() ? std::string() : c.tagline + "  ") + b;
    const nlohmann::json& rec = c_.save->data("records")[c.id];
    if (rec.is_object() && rec.contains("best") && rec["best"].is_number()) D.say += " \xC2\xB7 your best " + fmtRaceTime(rec["best"].get<double>());
    D.options.clear();
    if (c.bus) {
      DialogOption o;
      o.label = "Race the field"; o.sub = "Free entry \xC2\xB7 every finisher is paid \xC2\xB7 win " + fmtMoney(c.reward); o.price = 0;
      o.act = [this, cp]() { start(*cp, 0, true, false, true); };
      D.options.push_back(o);
    } else {
      // (the field is the course's own rating: a HARD course is raced against the hard field, no choice to make)
      int def = aiIndex(c.ai);
      {
        std::string dl;
        for (char ch : c.diff) dl += char(std::tolower(static_cast<unsigned char>(ch)));
        if (dl.find("super") != std::string::npos || dl.find("expert") != std::string::npos || dl.find("extreme") != std::string::npos) def = 3;
        else if (dl.find("hard") != std::string::npos || dl.find("difficult") != std::string::npos) def = 2;
        else if (dl.find("medium") != std::string::npos || dl.find("intermediate") != std::string::npos) def = 1;
        else if (dl.find("easy") != std::string::npos || dl.find("beginner") != std::string::npos) def = 0;
      }
      for (int ai = def; ai <= def; ai++) {
        DialogOption o;
        o.label = std::string("Race \xC2\xB7 ") + AI_LABEL[ai] + " field";
        if (fromStand) { o.sub = "14 AI racers \xC2\xB7 just for fun"; o.price = 0; }
        else { o.sub = "14 AI racers \xC2\xB7 1st " + fmtMoney(prizeFor(c, ai)) + ", 2nd " + fmtMoney(int64_t(std::round(prizeFor(c, ai) * 0.4))); o.price = c.entry; }
        o.disabled = !fromStand && c_.save->money < c.entry;
        o.act = [this, cp, ai, fromStand]() { start(*cp, ai, !fromStand, false, fromStand); };
        D.options.push_back(o);
      }
    }
    DialogOption pr;
    pr.label = "Practice run"; pr.sub = "Alone on the course \xC2\xB7 no prize"; pr.price = 0;
    pr.act = [this, cp, fromStand]() { start(*cp, 0, false, true, fromStand || cp->bus); };
    D.options.push_back(pr);
    DialogOption n; n.label = "Not now"; n.secondary = true;
    D.options.push_back(n);
  };
  c_.menus->openDialog(d);
}

std::vector<Races::RecordRow> Races::records() const {
  std::vector<RecordRow> out;
  if (!c_.data) return out;
  for (const Course& c : c_.data->courses) {
    RecordRow r;
    r.name = c.name;
    const nlohmann::json& rec = c_.save->data("records")[c.id];
    if (rec.is_object()) {
      if (rec.contains("best") && rec["best"].is_number()) r.best = rec["best"].get<double>();
      int mr = medalRank(rec.contains("medal") ? rec["medal"] : nlohmann::json());
      r.medal = mr ? 4 - mr : 0;
    }
    out.push_back(std::move(r));
  }
  return out;
}

void Races::openStand() {
  // the RACING stand's board (ui/racestand.js): any course against the 14 AI, just for fun
  stand_ = RaceStandView();
  for (const Course& c : c_.data->courses) {
    RaceStandView::C q;
    const nlohmann::json& rec = c_.save->data("records")[c.id];
    q.name = c.name; q.tagline = c.tagline; q.level = c.diff; q.length = c.length; q.drop = c.drop;
    if (rec.is_object()) {
      if (rec.contains("bestRace") && rec["bestRace"].is_number()) q.bestPlace = rec["bestRace"].get<int>();
      if (rec.contains("best") && rec["best"].is_number()) q.best = rec["best"].get<double>();
      q.medal = medalRank(rec.contains("raceMedal") ? rec["raceMedal"] : nlohmann::json()) ? 4 - medalRank(rec["raceMedal"]) : 0;
    }
    stand_.courses.push_back(std::move(q));
  }
  stand_.i = std::clamp(standCourse_, 0, std::max(0, int(stand_.courses.size()) - 1)); stand_.diff = standDiff_;
  Menus* M = c_.menus;
  stand_.closed = [M]() { M->close(); };
  stand_.start = [this](int ci, int df) {
    standCourse_ = ci; standDiff_ = df;
    if (ci >= 0 && size_t(ci) < c_.data->courses.size()) start(c_.data->courses[size_t(ci)], df, false, false, true);
  };
  M->openCustom([this](const UiNav& nav, double dt, double now) {
    if (!ui_) return;
    if (!frameRaceStand(*ui_, nav, *c_.input, stand_, dt, now)) { if (c_.menus->customOpen("racestand")) c_.menus->close(); return; }
    c_.menus->customFocus = stand_.courses.empty() ? "" : stand_.courses[size_t(stand_.i)].name;
  }, "racestand");
  M->customFocusLabel = [this](const std::string& label) { for (size_t i = 0; i < stand_.courses.size(); i++) if (stand_.courses[i].name == label) { stand_.i = int(i); return true; } return false; };
}

bool Races::interact(std::string& prompt, bool pressed) {
  if (s_ || !c_.data) return false;
  const dvec3& p = c_.player->pos;
  if (c_.data->hasStand && std::hypot(p.x - c_.data->standX, p.z - c_.data->standZ) < STAND_R + 1) {
    prompt = "RACING \xC2\xB7 race the AI just for fun";
    if (pressed) openStand();
    return true;
  }
  auto atStart = [&](const Course& c) { return std::hypot(p.x - c.start.x, p.z - c.start.z) < START_R && std::fabs(p.y - c.start.y) < 12; };
  for (const Course& c : c_.data->courses)
    if (atStart(c)) {
      prompt = c.name + " \xC2\xB7 race (" + c.diff + ", 1st " + fmtMoney(c.reward) + ")";
      if (pressed) openCard(c, false);
      return true;
    }
  for (const Course& c : c_.data->busRaces) {
    bool board = c.hasBoard && std::hypot(p.x - c.boardX, p.z - c.boardZ) < BOARD_R;
    if (board || atStart(c)) {
      prompt = "FREE RACE \xC2\xB7 " + c.name + " (win " + fmtMoney(c.reward) + ")";
      if (pressed) openCard(c, false);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- the session
bool Races::start(const Course& co, int ai, bool forMoney, bool practice, bool teleport) {
  // (Phase 6) multiplayer: a practice race (session.js raceSolo: just you, no entry fee, no prize, nothing counted;
  // the server's queues for 2+ racers are not ported yet)
  // (Nov 2026, the user: "you don't earn any money if you do a race with only 1 person": a race alone against the AI
  // field pays its prize like in single player; the server hears of it as a practice race (raceSolo: the others see
  // you on the course), the entry fee and the prize go through the server's money (spend / earn))
  if (c_.online && !noField_) { if (practice) ai = 0; if (c_.raceSolo) c_.raceSolo(co.id); }
  if (forMoney && !co.bus && co.entry > 0 && !c_.spend(co.entry)) return false;
  auto s = std::make_unique<Session>();
  s->c = &co;
  s->shownAt = c_.now;
  s->ai = co.bus ? aiIndex(co.ai) : ai;   // (the bus races: their own field, main.js difficulty: e.D.ai)
  s->forMoney = forMoney && !practice;
  s->practice = practice;
  s->stand = !forMoney && !practice;
  const CourseLine& L = co.line;
  double s0 = co.start.s;
  // the gates: between the turning pole and the outer pole 5 m on the gate's side (bots.js)
  for (const CourseGate& g : co.gates) {
    double latA = L.project(g.x, g.z, g.s, 30).lat;
    double latB = L.project(g.x + g.nx * g.side * 5, g.z + g.nz * g.side * 5, g.s, 30).lat;
    if (std::fabs(latB) > L.width(g.s) + 0.5) latB = latA - (latB - latA);
    s->gates.push_back({g.s, latA, latB >= latA ? 1.0 : -1.0, std::fabs(latB - latA)});
    // (session.js buildGateBars: from the turning pole to the pole `width` along the gate's axis, on the drawn snow)
    const double wd = g.width > 0 ? g.width : 5, bx = g.x + g.nx * g.side * wd, bz = g.z + g.nz * g.side * wd;
    const double dx = bx - g.x, dz = bz - g.z, len0 = std::hypot(dx, dz), len = len0 > 0 ? len0 : 1, ux = dx / len, uz = dz / len;
    const double x0 = g.x + ux * BAR_INSET, z0 = g.z + uz * BAR_INSET, x1 = bx - ux * BAR_INSET, z1 = bz - uz * BAR_INSET;
    s->bars.push_back({dvec3(x0, c_.world->meshHeight(x0, z0), z0), dvec3(x1, c_.world->meshHeight(x1, z1), z1), len, 0});
  }
  // the field (session.js spawnBots: the same rivals on every retry) on the start grid (gridSlots): slot 0 is you at
  // the start wand; the racers line up abreast on both sides like a ski-cross start and in staggered rows behind
  // where the track is too narrow, clear of the start house, each other and the barriers
  s->mp = noField_;
  if (noField_) s->stand = false;
  if (!practice && !noField_) {
    racebots::Track& tr = trackOf(co);
    s->track = &tr;
    const double tField = c_.plat ? c_.plat->timeSeconds() : 0;
    s->field = racebots::createField(tr, s->ai, FIELD_BOTS, hashStr(co.id + ":" + AI_KEY[s->ai]), c_.player->skiSpeed, c_.player->skiGrip);
    SL_INFO("race: the %s field of %d on %s: reference run %.2f s, %d line samples, finish at %.0f m, %zu take-offs, calibrated in %.2f s", AI_KEY[s->ai], FIELD_BOTS, co.name.c_str(),
            s->field.refTime, tr.n, tr.finishS, tr.jumps.size(), (c_.plat ? c_.plat->timeSeconds() : 0) - tField);
    struct Slot { double s, lat; };
    std::vector<Slot> slots{{s0, 0}};
    const size_t want = s->field.specs.size() + 1;
    const double side = hashStr(co.id) & 1 ? 1 : -1;   // which side an odd racer out stands on
    auto fits = [&](double q, double lat) {
      if (std::fabs(lat) > tr.halfWidth(q) - GRID_EDGE) return false;
      if (co.houseS > -1e8 && std::fabs(q - co.houseS) < HOUSE_REACH && std::fabs(lat) < HOUSE_HALF) return false;
      for (const Slot& o : slots) if (std::hypot(o.s - q, o.lat - lat) < GRID_GAP) return false;
      return true;
    };
    for (int row = 0; row < 10 && slots.size() < want; row++) {
      // lanes of a row, nearest the centre first: even rows 0, 3.1, 5.5 ... (you own 0 in the front row), odd rows in
      // the gaps of the row in front: 1.55, 4.3, 6.7 ...
      std::vector<double> lanes;
      if (row % 2) { lanes.push_back(GRID_FIRST / 2); for (double l = GRID_FIRST + GRID_SPACING / 2; l < 30; l += GRID_SPACING) lanes.push_back(l); }
      else { if (row > 0) lanes.push_back(0); for (double l = GRID_FIRST; l < 30; l += GRID_SPACING) lanes.push_back(l); }
      const double q = s0 - row * GRID_ROW;
      for (double l : lanes)
        for (double lat : {side * l, -side * l}) {
          if (slots.size() >= want) break;
          if (fits(q, lat)) slots.push_back({q, lat});
          if (l == 0) break;
        }
    }
    // a track too narrow for the whole field: the rest queue up behind on the centre line
    for (int k = 1; slots.size() < want; k++) slots.push_back({s0 - (10 + k) * GRID_ROW, 0});
    // outfits: rotate the racer characters, avoiding your own look where possible
    std::vector<int> chars;
    if (c_.people) {
      for (const char* n : BOT_CHARS) { int k = c_.people->kind(n); if (k >= 0 && c_.save->character != n) chars.push_back(k); }
      if (chars.empty()) chars = c_.people->skierKinds;
    }
    for (size_t i = 0; i < s->field.specs.size(); i++) {
      auto b = std::make_unique<racebots::BotRacer>(*s->field.specs[i], tr);
      if (!chars.empty()) {
        b->kind = chars[i % chars.size()];
        const PeopleKind& K = c_.people->kindOf(b->kind);
        if (K.rig) {
          World* w = c_.world;
          // (main.js: the race field skis with poles, makeRig(c, s, { poles: true, ai: true }))
          b->R.kind = b->kind; b->R.gear = 3;
          b->R.rig.init(K.rig, c_.people->gear(3), true, true, [w](double x, double z, double y) { return w->groundHeight(x, z, y); });
          b->R.rig.setCarry(false);
          b->R.rig.setSkisVisible(true);
          b->rigOk = true;
        }
      }
      b->reset(slots[i + 1].s, slots[i + 1].lat, 0);
      SL_INFO("race: field %2zu %-18s target %.2f s, clean run %.2f s, pace %.4f, grid s %.1f lat %+.2f", i, b->name.c_str(), b->spec.targetTime, b->spec.cleanTime, b->spec.P.pace, b->s, b->lat);
      // (farbots.js: SUIT[char] || FALLBACK[i % 10])
      {
        const char* hex = FAR_FALLBACK[i % 10];
        if (b->kind >= 0 && c_.people) for (const auto& [n, h] : FAR_SUIT) if (c_.people->kindOf(b->kind).name == n) hex = h;
        s->farModel.push_back(c_.dev ? farFigure(*c_.dev, hexColor(hex)) : nullptr);
      }
      s->bots.push_back(std::move(b));
    }
  }
  if (s_) endCine();
  if (c_.slowCancel) c_.slowCancel();   // (session.js reset: presentation.cancel())
  // (session.js: every racer is recorded, 30 Hz, the last 60 s)
  if (c_.skier) s->rep = std::make_unique<racecine::ReplayBuffer>(int(s->bots.size()) + 1);
  s_ = std::move(s);
  // (modes.js start: the title card `RACE · <course>` covers the move to the start)
  if (teleport) { if (c_.titleCard) c_.titleCard("RACE \xC2\xB7 " + co.name); else if (c_.fade) c_.fade(); }
  dvec3 sp = L.point(s0, 0);
  c_.player->setSkisOn(true);
  c_.player->teleport(sp.x, sp.z, co.start.heading);
  c_.player->setSkisOn(true);
  s_->prevS = s0; s_->progS = s0;
  botJump = botLatV = 0;
  updateBots(0.0001);   // (the first frame of the field: it stands on the grid right away)
  // (session.js start: the intro on the first start of a session; else the announcer names the course right away)
  beginIntro();
  if (!s_->intro) { s_->courseCalled = true; sounds.push_back("announce:" + co.id); }
  if (c_.weather) c_.weather->frozen = true;   // (session.js: the weather is held for the race)
  if (c_.unmark) c_.unmark();
  guide_.on = false;
  c_.save->stats.races++;
  c_.save->markDirty();
  c_.flash(co.name + (practice ? " \xC2\xB7 practice run" : s_->stand ? " \xC2\xB7 just for fun" : std::string(" \xC2\xB7 ") + (co.bus ? "free race" : AI_LABEL[s_->ai]) ), 0);
  return true;
}

bool Races::mpRace() const { return s_ && s_->mp; }

void Races::debugSkip(double toFinish) {
  if (!s_ || s_->st != Session::St::Race) return;
  Session& s = *s_;
  const Course& c = *s.c;
  const double q = std::max(s.prevS, c.finish.s - toFinish);
  while (s.nextCp < int(c.checkpoints.size()) && c.checkpoints[size_t(s.nextCp)].s <= q) { s.splits.push_back(std::round(s.clock * 1000) / 1000); s.lastCp = s.nextCp++; }
  while (s.nextGate < int(s.gates.size()) && s.gates[size_t(s.nextGate)].s <= q) s.nextGate++;
  const dvec3 p = c.line.point(q, 0);
  const double h = c.line.heading(q);
  c_.player->teleport(p.x, p.z, h);
  c_.player->setSkisOn(true);
  c_.player->vel = dvec3(std::sin(h), 0, std::cos(h)) * 15.0;
  s.prevS = s.progS = q; s.progT = s.clock;
  SL_INFO("race: (debug) skipped on to s %.0f, %.0f m before the finish", q, c.finish.s - q);
}

bool Races::startMp(const Course& co, int slot, double secondsToGo, bool practice) {
  if (s_) abort();
  noField_ = true;
  const bool ok = start(co, 0, false, practice, true);
  noField_ = false;
  if (!ok || !s_) return false;
  Session& s = *s_;
  s.mp = true; s.stand = false;
  // (main.js mpRaceStart: grid { slot, n }) your place on the grid: abreast in rows of five behind the start wand
  static const double LANE[5] = {0, GRID_FIRST, -GRID_FIRST, 2 * GRID_FIRST, -2 * GRID_FIRST};
  const int row = std::max(0, slot) / 5;
  const double q = co.start.s - row * GRID_ROW * 2;
  const double hw = std::max(0.0, co.line.width(q) - GRID_EDGE);
  const double lat = std::clamp(LANE[std::max(0, slot) % 5], -hw, hw);
  const dvec3 sp = co.line.point(q, lat);
  c_.player->teleport(sp.x, sp.z, co.start.heading);
  c_.player->setSkisOn(true);
  s.prevS = s.progS = q;
  // (session.js syncGo) the 3-2-1-GO ends at the server's start: the same moment for everyone in the race
  const double goAt = LEAD_IN + 3;
  s.t = goAt - std::max(0.0, secondsToGo);
  SL_INFO("race: multiplayer race on %s: slot %d (s %.1f, lat %+.1f), GO in %.2f s%s", co.name.c_str(), slot, q, lat, secondsToGo, practice ? " (practice)" : "");
  return true;
}

void Races::respawn(const char* why) {
  Session& s = *s_;
  const Course& c = *s.c;
  double cs = (s.lastCp > 0 && s.lastCp < int(c.checkpoints.size()) ? c.checkpoints[size_t(s.lastCp)].s : c.start.s) + 2;   // (session.js respawnNow: cp.s + 2)
  dvec3 p = c.line.point(cs, 0);
  double h = c.line.heading(cs);
  if (c_.fade) c_.fade();
  c_.player->setSkisOn(true);
  c_.player->teleport(p.x, p.z, h);
  c_.player->setSkisOn(true);
  c_.player->vel = dvec3(std::sin(h), 0, std::cos(h)) * RESPAWN_SPEED;
  s.prevS = cs; s.progS = cs; s.progT = s.clock; s.offT = s.fellT = 0; s.crashT = -1;
  // gates behind the checkpoint stay as they were; the ones after it are taken again
  while (s.nextGate > 0 && s.gates[size_t(s.nextGate - 1)].s > cs) s.nextGate--;
  for (size_t k = size_t(s.nextGate); k < s.bars.size(); k++) s.bars[k].state = 0;   // (their ribbons green again)
  s.barsDirty = true;
  s.respawns++;
  if (s.rep) s.rep->cut(0);   // (the replay snaps over the teleport)
  s.notice = "RESPAWN"; s.noticeT = c_.now; s.noticeBad = false;   // (session.js respawnNow: notice('RESPAWN', 'info'))
  SL_INFO("race: respawn (%s) at s=%.0f (%s)", why, cs, s.lastCp > 0 && s.lastCp < int(c.checkpoints.size()) ? c.checkpoints[size_t(s.lastCp)].name.c_str() : "the start");
}

void Races::finishPlayer() {
  Session& s = *s_;
  s.st = Session::St::Finished;
  s.finalTime = s.rawTime + s.penalty;
  s.finishT = s.t;
  s.resultsAt = s.t + RESULTS_DELAY;
  // records.js submitTime: PB, medal by time, splits, runs (at the line: a quit before the results loses nothing)
  if (!s.practice) {
    nlohmann::json& recs = c_.save->data("records");
    nlohmann::json& r = recs[s.c->id];
    if (!r.is_object()) r = {{"best", nullptr}, {"medal", nullptr}, {"bestRace", nullptr}, {"raceMedal", nullptr}, {"byDifficulty", nlohmann::json::object()}, {"splits", nlohmann::json::array()}, {"runs", 0}};
    r["runs"] = r.value("runs", 0) + 1;
    if (r["best"].is_number()) s.prevBest = r["best"].get<double>();
    if (!r["best"].is_number() || s.finalTime < r["best"].get<double>()) { r["best"] = std::round(s.finalTime * 1000) / 1000; r["splits"] = s.splits; s.notice = "NEW RECORD"; s.pb = true; }
    if (const char* m = medalForTime(s.finalTime, *s.c)) if (medalRank(m) > medalRank(r["medal"])) r["medal"] = m;
    c_.save->markDirty();
  }
  int ahead = 0;
  for (auto& b : s.bots) ahead += b->finished && b->finishTime < s.finalTime;
  // (session.js: finishers heading for a lane too close to where you ski out pick another one)
  for (auto& b : s.bots)
    if (b->parked && !b->stopped && std::fabs(b->parkLat - s.platL) < 2.6) {
      s.avoid.assign(1, s.platL);
      for (auto& o : s.bots) if (o != b && o->parked) s.avoid.push_back(o->parkLat);
      b->setParking(b->parkRank ? b->parkRank : 1, s.avoid, true, s.platL);
    }
  if (s.notice != "NEW RECORD") s.notice = s.practice ? "FINISH" : ordinal(ahead + 1);
  s.noticeT = c_.now; s.noticeBad = false;
  sounds.push_back(s.practice ? std::string("finish:practice") : s.notice == "NEW RECORD" ? std::string("finish:record") : "finish:" + std::to_string(ahead + 1));
  if (!s.practice) if (const char* m = medalForTime(s.finalTime, *s.c)) sounds.push_back(std::string("medal:") + m);
}

void Races::showResults() {
  Session& s = *s_;
  s.st = Session::St::Results;
  sounds.push_back("results");
  // the order: finished racers by time; the ones still out by their projected time
  struct Row { std::string name; double t; bool you; };
  std::vector<Row> rows{{"You", s.finalTime, true}};
  for (auto& b : s.bots) {
    rows.push_back({b->name, b->projectFinish(), false});
  }
  // (session.js raceResultFor / the live board) a race with the other players: their finishes so far, the rest
  // behind them (still racing or out)
  if (s.mp && c_.raceRivals) for (const PlayCtx::RaceRival& r : c_.raceRivals()) rows.push_back({r.name + (r.dnf ? " (DNF)" : r.time < 0 ? " (racing)" : ""), r.dnf ? 1e7 : r.time < 0 ? 1e6 : r.time, false});
  std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.t < b.t; });
  for (size_t i = 0; i < rows.size(); i++) if (rows[i].you) s.place = int(i) + 1;
  int field = int(rows.size());
  if (c_.online && c_.raceFinished) c_.raceFinished(s.finalTime, false);
  if (s.mp && !s.practice && c_.racePrize) { const int pz = c_.racePrize(); if (pz > 0) s.prize = pz; }   // (the server pays; its 'money' brings it in)
  // the prize (freeworld.js prize / busracedefs.js busRacePrize) and records.js submitPlace
  if (s.forMoney) {
    if (s.c->bus) {
      bool podium = s.place >= 1 && s.place <= 3 && s.place < field;
      double share = podium ? BUS_SHARE[s.place - 1] : s.finalTime <= s.c->par ? 0.4 : 0.3;
      s.prize = int(std::round(s.c->reward * share));
    } else s.prize = s.place <= 3 ? int(std::round(prizeFor(*s.c, s.ai) * PRIZE_SHARE[s.place - 1])) : 0;
    if (s.prize > 0) c_.earn(s.prize);
  }
  if (!s.practice) {
    nlohmann::json& r = c_.save->data("records")[s.c->id];
    if (r.is_object()) {
      const char* m = s.place == 1 ? "gold" : s.place == 2 ? "silver" : s.place == 3 ? "bronze" : nullptr;
      if (m && medalRank(m) > medalRank(r["raceMedal"])) r["raceMedal"] = m;
      if (!r["bestRace"].is_number() || s.place < r["bestRace"].get<int>()) r["bestRace"] = s.place;
      nlohmann::json& bd = r["byDifficulty"];
      if (!bd.is_object()) bd = nlohmann::json::object();
      const char* k = AI_KEY[s.ai];
      if (!bd.contains(k) || !bd[k].is_number() || s.place < bd[k].get<int>()) bd[k] = s.place;
    }
    if (s.place == 1) c_.save->stats.wins++;
  }
  c_.save->markDirty();
  lastRows.clear();
  for (size_t i = 0; i < rows.size() && i < 15; i++) lastRows.push_back(ordinal(int(i) + 1) + "  " + rows[i].name + "  " + fmtRaceTime(rows[i].t));
  // the results screen (racehud.js results; an open-world race brings its one OK: you are back in Legacy Village)
  RaceResults& R = s.res;
  R = RaceResults();
  R.courseName = s.c->name;
  R.trial = s.practice;
  R.difficulty = s.practice ? "" : s.c->bus ? "Free race" : AI_LABEL[s.ai];
  R.place = s.practice ? 0 : s.place;
  R.time = s.finalTime;
  R.pb = s.pb; R.previousBest = s.prevBest; R.penalty = s.penalty;
  R.prize = s.prize;
  R.prizeMult = s.forMoney && !s.c->bus ? AI_MULT[std::clamp(s.ai, 0, 3)] : 1;
  if (s.practice) { const char* m = medalForTime(s.finalTime, *s.c); R.medal = !m ? 0 : std::string(m) == "gold" ? 1 : std::string(m) == "silver" ? 2 : 3; }
  else R.medal = s.place >= 1 && s.place <= 3 && field > 1 ? s.place : 0;
  if (!s.practice) for (size_t i = 0; i < rows.size(); i++) R.rows.push_back({rows[i].name, rows[i].t, rows[i].t - rows[0].t, rows[i].you, false});
  R.choices = {{"ok", "OK", "ENTER"}};
  // (session.js offerReplay: WATCH REPLAY in front of the screen's own buttons, with two seconds or more on tape)
  if (s.rep && s.rep->count() >= racecine::REPLAY_RATE * 2 && c_.skier) R.choices.insert(R.choices.begin(), {"replay", "WATCH REPLAY", "V"});
  s.hasResults = true;
  presentResults();
  SL_INFO("race: %s finished in %s, place %d of %d, prize $%d", s.c->name.c_str(), fmtRaceTime(s.finalTime).c_str(), s.place, field, s.prize);
  if (!s.bots.empty()) SL_INFO("race: the AI field: fastest lateral speed %.2f m/s, largest step beyond a racer's own motion %.3f m, reference run %.2f s", botLatV, botJump, s.field.refTime);
}

// The results screen (again after a replay): OK ends the run, WATCH REPLAY plays the replay and comes back here.
void Races::presentResults() {
  if (!s_ || !s_->hasResults) return;
  s_->res.focus = -1; s_->res.shownAt = -1;
  if (c_.menus->customOpen("racecine")) c_.menus->close();
  c_.menus->openCustom([this](const UiNav& nav, double, double now) {
    if (!s_ || !ui_) return;
    c_.menus->customFocus = "OK";
    const std::string choice = frameRaceResults(*ui_, nav, *c_.input, s_->res, now);
    if (choice == "replay") startReplay();
    else if (!choice.empty()) confirmResults();
  }, "results");
}

// ---------------------------------------------------------------- the broadcast presentation (session.js)
namespace {
constexpr double REPLAY_AFTER = 3.5;   // s of the ski-out recorded after the line
RigState cineState(const racecine::Sample& m, const three::V3& normal) {
  RigState st;
  st.mode = m.down ? RigMode::Fall : RigMode::Ski;
  st.heading = m.heading; st.speed = m.speed; st.crouch = m.crouch; st.lean = m.lean;
  st.hasEdge = true; st.edge = m.edge; st.tuck = m.tuck; st.plow = m.plow; st.skid = m.skid;
  st.hasNormal = true; st.normal = normal; st.air = m.air;
  st.flip = m.flip; st.hasFlipHeading = true; st.flipHeading = m.flipHeading;
  st.grab = m.grab; st.spinVel = m.spinVel; st.fallT = m.fallT; st.fallSide = m.fallSide;
  st.fp = 0; st.carry = false;
  return st;
}
} // namespace

// Every racer into the replay ring buffer at REPLAY_RATE (from GO until a little after the line).
void Races::recordReplay() {
  Session& s = *s_;
  if (!s.rep || !c_.skier || s.replay || s.clock < 0 || (s.st != Session::St::Race && s.st != Session::St::Finished)) return;
  const double T = s.clock, finishClock = s.finishT - (LEAD_IN + 3);
  if (s.st == Session::St::Finished && T > finishClock + REPLAY_AFTER) return;
  if (!s.rep->due(T)) return;
  const Player& pl = *c_.player;
  const RigState& ps = c_.skier->state;   // (player.rigState: what the rig was posed with)
  racecine::Sample m;
  m.heading = ps.heading; m.crouch = ps.crouch; m.lean = ps.lean; m.edge = ps.hasEdge ? ps.edge : ps.lean * 0.6; m.skid = ps.skid; m.plow = ps.plow;
  m.speed = ps.speed; m.flip = ps.flip; m.flipHeading = ps.flipHeading; m.grab = ps.grab; m.spinVel = ps.spinVel; m.fallT = ps.fallT; m.fallSide = ps.fallSide;
  m.tuck = ps.tuck; m.air = ps.air;
  s.rep->write(0, pl.pos, m, pl.mode == PlayerMode::Fall);
  for (size_t i = 0; i < s.bots.size(); i++) {
    const racebots::BotRacer& b = *s.bots[i];
    racecine::Sample q;
    q.heading = b.heading; q.speed = b.v; q.crouch = b.recCrouch; q.lean = b.lean; q.edge = b.edge;
    q.skid = b.skidYaw; q.tuck = b.recTuck; q.air = b.air && b.airT > 0.1; q.plow = 0;
    s.rep->write(int(i) + 1, b.pos, q, false);
  }
}

// RACE: the top three on the podium before the results (session.js startPodium / rankedRacers).
bool Races::startPodium() {
  Session& s = *s_;
  s.podiumDone = true;
  if (!c_.skier || !c_.dev || !s.track) return false;
  struct R { int track; std::string name; double time; bool me; };
  std::vector<R> list{{0, "You", s.finalTime, true}};
  for (size_t i = 0; i < s.bots.size(); i++) list.push_back({int(i) + 1, s.bots[i]->name, s.bots[i]->projectFinish(), false});
  std::stable_sort(list.begin(), list.end(), [](const R& a, const R& b) { return (std::isfinite(a.time) ? a.time : 1e300) < (std::isfinite(b.time) ? b.time : 1e300); });
  std::vector<racecine::Podium::Racer> top;
  for (size_t i = 0; i < list.size() && i < 3; i++) top.push_back({list[i].track, list[i].name, std::isfinite(list[i].time) ? fmtRaceTime(list[i].time) : "DNF", list[i].me});
  s.podium = std::make_unique<racecine::Podium>(*c_.dev, c_.plat, *c_.world, *s.track, std::move(top));
  s.cineT = 0; s.podiumHideT = -1;
  if (c_.slowCancel) c_.slowCancel();
  c_.skier->cine = PlayerSkier::Cine();
  c_.skier->cine.on = true; c_.skier->cine.visible = false; c_.skier->cine.snap = true;
  for (auto& b : s.bots) b->cinePlace = 0;
  sounds.push_back("results");   // (audio.music('results'))
  openCineInput();
  return true;
}

// Skip keys (Space / Enter, + Escape in replays), a click and the controller's confirm while a cinematic plays.
void Races::openCineInput() {
  if (c_.menus->customOpen("racecine")) return;
  if (c_.menus->dialogOpen()) c_.menus->close();
  c_.menus->openCustom([this](const UiNav& nav, double, double) {
    if (!s_) return;
    c_.menus->customFocus = "SKIP";
    Session& s = *s_;
    if (s.cineT < 0.4) return;   // (keys still held from before)
    if (nav.confirm || nav.click || (s.replay && (nav.cancel || nav.menu))) skipCine();
  }, "racecine");
}

void Races::skipCine() {
  if (!s_) return;
  Session& s = *s_;
  if (s.intro) { s.intro->skip(); return; }
  if (s.podium && s.podium->showing() && s.st == Session::St::Finished) s.podium->skip();
  else if (s.replay && s.stingT < 0) finishReplay();
}

bool Races::watchReplay() {
  if (!s_ || s_->st != Session::St::Results || s_->replay || s_->stingT >= 0) return false;
  bool can = false;
  for (const auto& c : s_->res.choices) can = can || c.id == "replay";
  if (can) startReplay();
  return can;
}

// WATCH REPLAY: the stinger sweeps across; the cut to the replay happens while it covers the screen.
void Races::startReplay() {
  Session& s = *s_;
  if (c_.menus->customOpen("results")) c_.menus->close();
  s.stingT = 0; s.stingThen = 1;
  s.cineT = 0;
  openCineInput();   // (hud.setBlocking('replay'): gameplay input off while it plays)
}

void Races::beginReplay() {
  Session& s = *s_;
  // (endCine: the podium behind the results)
  s.podium.reset();
  for (auto& b : s.bots) if (b->rigOk) { World* w = c_.world; b->R.rig.setGround([w](double x, double z, double y) { return w->groundHeight(x, z, y); }); b->R.rig.setSkisVisible(true); }
  racecine::ReplayDirector::Opt o;
  o.buffer = s.rep.get(); o.track = s.track; o.world = c_.world;
  const CourseLine* L = &s.c->line;
  o.project = [L](double x, double z, double hint) { return L->project(x, z, hint, hint < 0 ? 120 : 200).s; };
  o.finishClock = s.finishT - (LEAD_IN + 3);
  s.replay = std::make_unique<racecine::ReplayDirector>(o);
  s.replayEnding = false;
  s.cineT = 0;
  c_.skier->cine = PlayerSkier::Cine();
  c_.skier->cine.on = true; c_.skier->cine.snap = true;
  for (auto& b : s.bots) { b->cinePlace = 0; if (b->rigOk) b->R.rig.snapPose(); }
  SL_INFO("race: replay of %.1f s (race time %.2f .. %.2f)", s.replay->duration(), s.replay->time(), s.replay->time() + s.replay->duration());
}

void Races::finishReplay() {
  Session& s = *s_;
  if (!s.replay || s.replayEnding) return;
  s.replayEnding = true;
  s.stingT = 0; s.stingThen = 2;
}

// End whatever cinematic runs and hand every rig and the camera back to the game.
void Races::endCine() {
  if (!s_) return;
  Session& s = *s_;
  const bool had = s.podium || s.replay;
  if (s.intro) {   // (an intro is cut short)
    s.intro.reset(); s.introRan = true;
    if (s.introL3) { s.introL3 = false; s.introL3Hide = c_.now; }
    if (c_.skier) c_.skier->forceThird = false;
  }
  s.podium.reset(); s.replay.reset();
  s.replayEnding = false; s.camOn = false; s.stingThen = 0;
  if (c_.skier) { const bool was = c_.skier->cine.on; c_.skier->cine = PlayerSkier::Cine(); if (was) c_.skier->rig.snapPose(); }
  if (had)
    for (auto& b : s.bots) {
      b->cinePlace = -1;
      if (!b->rigOk) continue;
      World* w = c_.world;
      b->R.rig.setGround([w](double x, double z, double y) { return w->groundHeight(x, z, y); });
      b->R.rig.setSkisVisible(true);
      b->animAcc = 1;   // a fresh pose on the next animate (not the carried cinematic one)
    }
  if (c_.menus->customOpen("racecine")) c_.menus->close();
}

void Races::updateCine(double dt) {
  Session& s = *s_;
  recordReplay();
  s.cineT += dt;
  if (s.stingT >= 0) {
    const double t0 = s.stingT;
    s.stingT += dt;
    if (t0 < 0.45 && s.stingT >= 0.45) {   // (STING_COVER_MS: the strokes cover the screen)
      const int then = s.stingThen;
      s.stingThen = 0;
      if (then == 1) beginReplay();
      else if (then == 2) { endCine(); presentResults(); }
    }
    if (s.stingT >= 0.96) s.stingT = -1;
  }
  const bool barsOn = (s.podium && s.podium->showing()) || s.replay || s.intro;
  s.lbox += ((barsOn ? 1.0 : 0.0) - s.lbox) * (1 - std::exp(-dt * 9));
  if (s.podium) {
    racecine::Podium& P = *s.podium;
    const bool was = P.showing();
    const bool showing = P.update(dt);
    if (P.fired) sounds.push_back("chime");
    if (was && !showing) s.podiumHideT = P.age();
    // riders standing on their blocks, facing the camera side; everyone else steps out of the picture
    racecine::Podium* pp = &P;
    World* w = c_.world;
    auto gnd = [pp, w](double x, double z, double y) { const double h = pp->surface(x, z); return std::isnan(h) ? w->groundHeight(x, z, y) : h; };
    PlayerSkier::Cine& pc = c_.skier->cine;
    pc.on = true; pc.visible = false;
    for (auto& b : s.bots) b->cinePlace = 0;
    for (int place = 1; place <= int(P.top().size()); place++) {
      const int k = P.top()[size_t(place - 1)].track;
      const dvec3 sp = P.spot(place);
      if (k == 0) { pc.visible = true; pc.skis = false; pc.st = P.stateOf(place); pc.pos = three::V3(sp); pc.dtScale = 1; pc.ground = gnd; }
      else if (k > 0 && k <= int(s.bots.size())) {
        racebots::BotRacer& b = *s.bots[size_t(k - 1)];
        if (!b.rigOk) continue;
        SkierRig& rig = b.R.rig;
        if (b.cineShown != 1) { b.cineShown = 1; rig.setSkisVisible(false); rig.setCarry(false); rig.setGround(gnd); rig.snapPose(); }
        b.cinePlace = 1;
        rig.rootPos = three::V3(sp);
        rig.update(std::max(1e-4, dt), P.stateOf(place));
        rig.fx.clear();
        b.R.pose_();
      }
    }
    s.cam = P.cam; s.camOn = true;
    if (!showing && s.st == Session::St::Finished) showResults();   // (the results come up over the podium; the scene keeps going behind them)
  } else if (s.replay) {
    racecine::ReplayDirector& D = *s.replay;
    bool more = true;
    if (!s.replayEnding) more = D.update(dt, s.camOn ? s.cam.pos : c_.player->pos);
    const double pdt = s.replayEnding ? 1e-4 : std::max(1e-4, D.poseDt);
    for (size_t k = 0; k < D.racers.size(); k++) {
      const racecine::ReplayDirector::Out& r = D.racers[k];
      const bool show = r.ok && r.show;
      const dvec3 pos(r.st.x, r.st.y, r.st.z);
      if (k == 0) {
        PlayerSkier::Cine& pc = c_.skier->cine;
        pc.on = true; pc.visible = show; pc.skis = true; pc.ground = nullptr;
        if (show) { pc.st = cineState(r.st, r.normal); pc.pos = three::V3(pos); pc.dtScale = dt > 1e-6 ? pdt / dt : 1; }
      } else if (k - 1 < s.bots.size()) {
        racebots::BotRacer& b = *s.bots[k - 1];
        b.cinePlace = show && b.rigOk ? 1 : 0;
        b.cineShown = 0;
        if (!b.cinePlace) continue;
        b.R.rig.rootPos = three::V3(pos);
        b.R.rig.update(pdt, cineState(r.st, r.normal));
        b.R.rig.fx.clear();
        b.R.pose_();
      }
    }
    if (D.camOk) { s.cam = D.cam; s.camOn = true; }
    if (!more && !s.replayEnding) finishReplay();
  }
}

bool Races::camera(Camera& cam) const {
  if (s_ && !s_->intro && s_->fovCarry > 0) {   // (after the intro: the field of view eases on from the crane's)
    s_->fovCarry = lerp(s_->fovCarry, cam.fovY, 1 - std::exp(-s_->camDt * 3));
    if (std::fabs(s_->fovCarry - cam.fovY) < 0.05 || s_->st != Session::St::Grid) s_->fovCarry = 0; else cam.fovY = float(s_->fovCarry);
  }
  if (!s_ || !s_->camOn || !(s_->podium || s_->replay || s_->intro)) return false;
  // (cinecam.js applyCamera: `blend` mixes toward the pose the camera already has this frame, the gameplay camera;
  // player.js eases its field of view from what the camera had: cam.fov = lerp(cam.fov, fov, 1 - exp(-dt * 3)))
  const double blend = s_->intro ? s_->camBlend : 0;
  const dvec3 p0 = cam.pos;
  const mat3 b0 = cam.basis;
  const float f0 = s_->intro && s_->fovCarry > 0 ? float(lerp(s_->fovCarry, cam.fovY, 1 - std::exp(-s_->camDt * 3))) : cam.fovY;
  cam.lookAt(s_->cam.pos, s_->cam.look);
  cam.fovY = float(s_->cam.fov);
  if (blend > 0) {
    cam.pos = glm::mix(cam.pos, p0, blend);
    cam.basis = glm::mat3_cast(glm::slerp(glm::quat_cast(cam.basis), glm::quat_cast(b0), float(blend)));
    cam.fovY += (f0 - cam.fovY) * float(blend);
  }
  if (s_->intro) s_->fovCarry = cam.fovY;
  cam.nearZ = 0.1f;
  return true;
}

// ---------------------------------------------------------------- the intro (session.js beginIntro / updateIntro / endIntro)
void Races::beginIntro() {
  Session& s = *s_;
  if (!c_.skier || !s.track || std::getenv("SKI_LEGACY_NO_RACE_INTRO")) { s.introRan = false; return; }
  s.intro = std::make_unique<racecine::CourseIntro>(*s.track, *s.c, *c_.world);
  if (c_.slowCancel) c_.slowCancel();
  s.cineT = 0; s.camOn = false; s.camBlend = 0; s.introInput = false; s.introL3 = false; s.introL3Hide = -1;
  c_.skier->forceThird = true;   // (the racer is on show: first person hides the body)
  SL_INFO("race: intro, the flight ends %.0f m down the course", s.intro->sEnd() - s.c->start.s);
}

void Races::updateIntro(double dt) {
  Session& s = *s_;
  Player& pl = *c_.player;
  racecine::CourseIntro& D = *s.intro;
  // the field waits in the start gate
  pl.vel = dvec3(0);
  updateBots(dt);
  if (!s.introInput) { s.introInput = true; openCineInput(); }
  const bool holding = c_.covered && c_.covered();   // (the branded transition still covers the screen: time holds)
  if (!D.update(dt, holding, pl.pos, s.c->start.heading)) { endIntro(); return; }
  s.cam = D.cam; s.camBlend = D.blend; s.camOn = true;
  if (D.cutNow) sounds.push_back("whoosh");
  const double t = D.time();
  if (!holding && !s.introL3 && s.introL3Hide < 0 && t >= racecine::CourseIntro::L3_IN) s.introL3 = true;
  if (s.introL3 && t >= racecine::CourseIntro::L3_OUT) { s.introL3 = false; s.introL3Hide = c_.now; }
  // the announcer names the course as the crane settles behind the racer
  if (!s.courseCalled && t > D.duration() - 2.2) { s.courseCalled = true; sounds.push_back("announce:" + s.c->id); }
  // the racer is on show until the camera reaches the first-person eye
  if (c_.skier && t > D.duration() - 0.5) c_.skier->forceThird = false;
}

void Races::endIntro() {
  Session& s = *s_;
  endCine();
  s.t = LEAD_IN - INTRO_LEAD_IN;   // (clock = -(INTRO_LEAD_IN + 3))
  // skipped before the announcer named the course: name it now, with time for it before the "three"
  if (!s.courseCalled) { s.courseCalled = true; sounds.push_back("announce:" + s.c->id); s.t -= 1.2; }
  lastCount_ = 0;
  s.shownAt = c_.now;   // (the race panels slide in now)
}

std::string Races::cineStage() const {
  if (!s_) return "";
  if (s_->intro) return "intro";
  if (s_->replay) return "replay";
  if (s_->podium) return s_->podium->showing() ? "podium" : "podium-hold";
  return "";
}
std::string Races::replayShot() const { return s_ && s_->replay ? s_->replay->shotKind() : ""; }
double Races::cineAge() const { return s_ ? (s_->intro ? s_->intro->time() : s_->cineT) : 0; }

// presentation.js: the letterbox bars, the podium's lower third, the REPLAY badge, SKIP [SPACE], the stinger
void Races::hudCine(Ui& ui) {
  const Session& s = *s_;
  const bool pad = c_.input && c_.input->usingGamepad();
  const std::string key = pad && c_.input ? prompts::K(*c_.input, "confirm") : std::string("SPACE");
  float skip = 0;
  if (s.podium) skip = s.podium->showing() ? float(std::clamp((s.cineT - 0.6) / 0.4, 0.0, 1.0)) : float(std::clamp(1 - (s.podium->age() - s.podiumHideT) / 0.4, 0.0, 1.0));
  else if (s.replay) skip = float(std::clamp((s.cineT - 0.6) / 0.4, 0.0, 1.0));
  else if (s.intro) skip = float(std::clamp((s.intro->time() - racecine::CourseIntro::L3_IN - 0.6) / 0.4, 0.0, 1.0));   // (.pres-skip.on: 0.4 s after 0.6 s)
  drawCineBars(ui, float(s.lbox), skip, "SKIP", key);
  if (s.introL3 || (s.introL3Hide >= 0 && c_.now - s.introL3Hide < 0.45)) {
    // (session.js introInfo: the kicker, the course, LENGTH / DROP / RATING / WEATHER)
    const Course& c = *s.c;
    RaceHudState h;
    h.trial = true; h.shownFor = -10;   // (body.pres-cine: the race panels step aside)
    h.third.on = true; h.third.bars = false;
    if (s.introL3Hide >= 0) { h.third.age = 100 + (c_.now - s.introL3Hide); h.third.left = 100.4; }   // (.pres-l3.out)
    else { h.third.age = s.intro ? s.intro->time() - racecine::CourseIntro::L3_IN : 100; h.third.left = 1e9; }
    h.third.kicker = uiwUpper(s.practice ? std::string("PRACTICE RACE \xC2\xB7 NO PRIZE") : !s.bots.empty()
      ? std::string("RACE \xC2\xB7 ") + AI_LABEL[s.ai] + " \xC2\xB7 " + std::to_string(s.bots.size() + 1) + " RACERS" : std::string("WORLD RACING \xC2\xB7 TIME TRIAL"));
    h.third.title = c.name;
    char len[32];
    if (c.length >= 1000) std::snprintf(len, sizeof len, "%.1f", c.length / 1000); else std::snprintf(len, sizeof len, "%.0f", c.length);
    h.third.stats = {{"LENGTH", len}, {"DROP", fmtMoney(c.drop).substr(1)}};
    h.third.units = {c.length >= 1000 ? "KM" : "M", "M"};
    if (!c.difficulty.empty()) { h.third.stats.push_back({"RATING", c.difficulty}); h.third.signs = {"", "", c.difficulty}; }
    if (c_.weather && !c_.weather->label().empty()) h.third.stats.push_back({"WEATHER", c_.weather->label()});
    drawRaceHud(ui, h);
  }
  if (s.podium && (s.podium->showing() || s.podium->age() - s.podiumHideT < 0.45)) {
    // (podium.js info: PODIUM · <difficulty>, the course, the top three)
    RaceHudState h;
    h.trial = true; h.shownFor = -10;   // (body.pres-cine: the race panels step aside)
    h.third.on = true; h.third.bars = false; h.third.age = s.podium->age();
    h.third.left = s.podiumHideT >= 0 ? s.podiumHideT + 0.4 : 1e9;
    h.third.kicker = "PODIUM \xC2\xB7 " + uiwUpper(s.practice ? "Practice" : s.c->bus ? "Free race" : AI_LABEL[s.ai]);
    h.third.title = s.c->name;
    int place = 0;
    for (const auto& r : s.podium->top()) h.third.rows.push_back({++place, r.name, r.time, r.me});
    drawRaceHud(ui, h);
  }
  if (s.replay) {
    const double raw = s.rawTime;
    drawReplayBadge(ui, fmtRaceTime(clamp(s.replay->time(), 0, raw > 0 ? raw : s.replay->time())), s.replay->slow(), s.cineT, c_.now);
  }
  if (s.stingT >= 0) drawStinger(ui, "REPLAY", s.stingT);
}

void Races::confirmResults() {
  if (!s_) return;
  if (c_.slowCancel) c_.slowCancel();
  endCine();   // (the podium behind the results)
  if (c_.menus->dialogOpen()) c_.menus->close();
  s_.reset();
  if (c_.weather) c_.weather->frozen = c_.autotest;
  // (modes.js exitFree: OK and a fade, and you stand in Legacy Village)
  if (c_.fade) c_.fade();
  c_.player->setSkisOn(false);
  c_.teleport(4, 34, PI, false);
}

void Races::update(double dt) {
  // the race guide (raceguide.js update)
  if (guide_.on) {
    guide_.t += dt;
    double d = std::hypot(c_.player->pos.x - guide_.target.x, c_.player->pos.z - guide_.target.z);
    if (d < 8 || guide_.t > 180 || d > std::max(200.0, guide_.d0 * 1.5) || c_.riding || c_.driving || s_) {
      guide_.on = false;
      if (d < 8) c_.flash(guide_.label + " \xC2\xB7 " + c_.K(Action::Interact) + " to race", 0);
    }
  }
  nearCheckT_ -= dt;
  if (nearCheckT_ <= 0 && c_.data) {
    nearCheckT_ = 0.5;
    nearCourse_ = nullptr;
    double bd = 700;
    for (const Course& c : c_.data->courses) { double d = std::hypot(c_.player->pos.x - c.finish.x, c_.player->pos.z - c.finish.z); if (d < bd) { bd = d; nearCourse_ = &c; } }
  }
  if (!s_) return;
  Session& s = *s_;
  // (session.js raceResult) finished before the others: the server's prize comes with its result, once everyone is in
  // (or out); the results screen shows it as it arrives
  if (s.hasResults && s.mp && !s.practice && c_.racePrize) {
    const int pz = c_.racePrize();
    if (pz > 0 && pz != s.res.prize) { s.prize = s.res.prize = pz; SL_INFO("race: the server's prize $%d (results screen updated)", pz); }
  }
  const double cineDt = dt / std::max(0.05, timeScale);   // (session.js: updateCine(dt / max(0.05, presentation.timeScale)))
  s.camDt = cineDt;
  updateCine(cineDt);   // (the replay buffer; the podium, a replay, the stinger: real time)
  if (!s_) return;
  if (s.st == Session::St::Results) updateBots(dt);   // (the field skis out and stops behind the results card)
  if (s.st == Session::St::Results || s.st == Session::St::Done) return;
  if (s.intro) { updateIntro(dt); return; }
  const Course& c = *s.c;
  const CourseLine& L = c.line;
  Player& pl = *c_.player;
  s.t += dt;
  double goAt = LEAD_IN + 3;
  if (s.st == Session::St::Grid) {
    pl.vel = dvec3(0);
    int k = int(std::ceil(goAt - s.t));
    if (k >= 1 && k <= 3 && k != lastCount_) { lastCount_ = k; sounds.push_back("count:" + std::to_string(k)); }
    if (s.t >= goAt) { s.st = Session::St::Race; s.clock = s.t - goAt; s.progT = 0; s.notice = "GO"; s.noticeT = c_.now; s.noticeBad = false; lastCount_ = 0; sounds.push_back("go"); }
  } else s.clock = s.t - goAt;
  // ---- the AI field
  if (s.st != Session::St::Grid && !s.went) { s.went = true; for (auto& b : s.bots) b->go(); }
  updateBots(dt);
  if (s.st == Session::St::Grid) return;
  // ---- the player down the course
  CourseLine::Proj pr = L.project(pl.pos.x, pl.pos.z, s.prevS, 90);
  double w = L.width(pr.s);
  double vS = std::max(1.0, glm::length(dvec2(pl.vel.x, pl.vel.z)));
  if (s.st == Session::St::Race) {
    // checkpoints
    if (pr.s - s.prevS < 80)
      while (s.nextCp < int(c.checkpoints.size()) && pr.s >= c.checkpoints[size_t(s.nextCp)].s) {
        const CoursePt& cp = c.checkpoints[size_t(s.nextCp)];
        double split = s.clock - std::max(0.0, pr.s - cp.s) / vS + s.penalty;
        s.splits.push_back(std::round(split * 1000) / 1000);
        double best = 1e9;
        for (auto& b : s.bots) if (b->splits.size() >= size_t(s.nextCp)) best = std::min(best, b->splits[size_t(s.nextCp - 1)]);
        s.sp = {true, s.nextCp, split, best < 1e9 ? split - best : 0, c_.now, best < 1e9, cp.name};   // (racehud.js checkpoint(): the split card under the clock)
        s.lastCp = s.nextCp++;
        sounds.push_back("checkpoint");
      }
    // gates (the lateral at the gate line, between the last two frames)
    while (s.nextGate < int(s.gates.size()) && pr.s >= s.gates[size_t(s.nextGate)].s) {
      const Session::Gate& g = s.gates[size_t(s.nextGate++)];
      if (pr.s - s.prevS > 80) continue;
      double f = pr.s > s.prevS ? clamp((g.s - s.prevS) / (pr.s - s.prevS), 0, 1) : 1;
      double l = s.prevLat + (pr.lat - s.prevLat) * f;
      double u = (l - g.latA) * g.dir;
      if (u < -GATE_TOL || u > g.span + GATE_FLAG + GATE_TOL) {
        s.missed.push_back(s.nextGate - 1);
        s.bars[size_t(s.nextGate - 1)].state = 2; s.barsDirty = true;
        s.penalty = double(s.missed.size()) * GATE_PENALTY;
        s.notice = "MISSED GATE  +0.50 \xC2\xB7 AIM FOR THE GREEN"; s.noticeT = c_.now; s.noticeBad = true;
        sounds.push_back("miss");
      } else { sounds.push_back("gate"); s.bars[size_t(s.nextGate - 1)].state = 1; s.barsDirty = true; }
    }
    // A rival reaching the line within PHOTO_GAP of the player: slow motion through the finish (checkPhotoFinish).
    if (!s.photoDone && !s.bots.empty() && s.track && c_.slowMo) {
      const double fin = s.track->finishS, ttl = (fin - pr.s) / std::max(1.0, dt > 0 ? (pr.s - s.prevS) / dt : vS);
      if (ttl > 0 && ttl < 0.45)
        for (auto& b : s.bots) {
          const double bt = b->finished ? b->finishTime - s.clock : (fin - b->s) / std::max(1.0, b->v);
          if (std::fabs(bt - ttl) < PHOTO_GAP) {
            s.photoDone = true;
            const bool on = c_.slowMo(0.3, 0.12, 1.0, 0.45, "photo");
            SL_INFO("race: photo finish with %s (%.2f s apart at the line)%s", b->name.c_str(), std::fabs(bt - ttl), on ? "" : " (no slow motion: one runs / cooldown / off)");
            break;
          }
        }
    }
    // the finish line
    if (pr.s >= c.finish.s && s.prevS < c.finish.s + 5) {
      s.rawTime = s.clock - (pr.s - c.finish.s) / vS;
      finishPlayer();
    } else {
      // the B-nets: bounced back into the track (session.js barrierContact, softened)
      if (!pl.air && std::fabs(pr.lat) > w + 0.4 && std::fabs(pr.lat) < w + 6 && pl.mode == PlayerMode::Ski) {
        double h = L.heading(pr.s);
        dvec2 lv(-std::cos(h), std::sin(h));   // + lateral
        double sgn = pr.lat > 0 ? 1 : -1;
        double into = (pl.vel.x * lv.x + pl.vel.z * lv.y) * sgn;
        double push = std::fabs(pr.lat) - (w + 0.4);
        pl.pos.x -= lv.x * sgn * push; pl.pos.z -= lv.y * sgn * push;
        if (into > 0) { pl.vel.x -= lv.x * sgn * into * 1.42; pl.vel.z -= lv.y * sgn * into * 1.42; pl.vel *= 1 - std::min(0.2, into * 0.014); }
      }
      // respawns: a wipeout, stuck, off the course, fallen below it
      if (pl.mode == PlayerMode::Fall) { if (s.crashT < 0) s.crashT = s.t; if (s.t - s.crashT > 1.4) respawn("crash"); }
      else {
        if (pr.s > s.progS + STUCK_PROGRESS) { s.progS = pr.s; s.progT = s.clock; } else if (pl.air) s.progT = s.clock;
        double outBy = std::fabs(pr.lat) - w;
        bool offc = !pl.air && outBy > OFF_MARGIN;
        s.offT = offc ? s.offT + dt : std::max(0.0, s.offT - dt);
        // (session.js projectFull: the track's designed surface where you are, track.js surfaceY: the bank applied
        // across the lateral, clamped to the edges; a bus race's line lies on the terrain: busraces.js surfaceY)
        double yLine = L.sAt(L.Y, pr.s);
        if (c.bus && c_.world) { const dvec3 q = L.point(pr.s, std::clamp(pr.lat, -w, w)); yLine = c_.world->height(q.x, q.z); }
        else if (!L.B.empty()) yLine -= std::tan(L.sAt(L.B, pr.s)) * std::clamp(pr.lat, -w, w);
        bool below = pl.pos.y < yLine - FALL_BELOW && !(pl.air && pl.vel.y > 0);
        s.fellT = below ? s.fellT + dt : 0;
        if (s.clock - s.progT > STUCK_TIME) { SL_INFO("race: stuck: no %.0f m of progress in %.1f s (s %.1f, best %.1f)", STUCK_PROGRESS, s.clock - s.progT, pr.s, s.progS); respawn("stuck"); }
        else if (s.offT > (outBy > FAR_MARGIN ? FAR_TIME : OFF_TIME)) { SL_INFO("race: off course: %.1f m beyond the edge (lat %+.1f, half width %.1f) at s %.1f", outBy, pr.lat, w, pr.s); respawn("off"); }
        else if (s.fellT > FALL_TIME) { SL_INFO("race: fell: %.1f m below the track (y %.1f, track %.1f) at s %.1f", yLine - pl.pos.y, pl.pos.y, yLine, pr.s); respawn("fell"); }
        double h = L.heading(pr.s);
        double along = pl.vel.x * std::sin(h) + pl.vel.z * std::cos(h);
        s.wrongT = along < -2 ? s.wrongT + dt : std::max(0.0, s.wrongT - dt * 2);
        if (s.wrongT > 1.2 && c_.now - s.noticeT > 3) { s.notice = "WRONG WAY"; s.noticeT = c_.now; s.noticeBad = true; }
      }
    }
  } else if (s.st == Session::St::Finished) {
    // the ski-out: braking to a stop in the finish area
    double sp = glm::length(pl.vel);
    if (sp > 0.1 && pl.mode == PlayerMode::Ski) pl.vel *= std::max(0.0, sp - FINISH_BRAKE * dt) / sp;
    bool fieldHome = true;
    for (auto& b : s.bots) fieldHome = fieldHome && (b->finished || (c.finish.s - b->s) / std::max(8.0, b->v) > 12);
    // (session.js maybeShowResults: the podium first, the results after it; not in multiplayer: the other racers are
    // not ours to pose)
    if (!s.podium && ((s.t >= s.resultsAt && fieldHome) || s.t >= s.resultsAt + RESULTS_MAX_WAIT)) {
      if (c_.online || s.podiumDone || !startPodium()) showResults();
    }
  }
  s.prevS = pr.s; s.prevLat = pr.lat;
  s.platL = -pr.lat; s.pSpeed = glm::length(dvec2(pl.vel.x, pl.vel.z));
}

// ---------------------------------------------------------------- the AI field (session.js updateBots)
void Races::updateBots(double dt) {
  Session& s = *s_;
  if (s.bots.empty()) return;
  animDt_ += dt;
  const Course& c = *s.c;
  // traffic snapshot (bots + you; the bots also steer around you stopping in the finish area)
  s.racers.clear();
  for (auto& b : s.bots) s.racers.push_back({b.get(), b->s, b->lat, b->v});
  s.racers.push_back({&s, s.prevS, s.platL, s.pSpeed});
  // mild rubber band so races stay close: +-3%, after the start, until you are home
  for (auto& b : s.bots) {
    double rb = 1;
    if (s.st == Session::St::Race && s.clock > 8 && !b->finished) {
      const double gapT = (b->s - s.prevS) / std::max(12.0, (b->v + s.pSpeed) * 0.5);
      if (gapT > 1.5) rb = 1 - 0.03 * smoothstep(1.5, 7, gapT);
      else if (gapT < -1.5) rb = 1 + 0.025 * smoothstep(1.5, 7, -gapT);
    }
    b->rbTarget = rb;
  }
  for (auto& b : s.bots) {
    const dvec3 p0 = b->pos;
    const double lat0 = b->lat;
    b->update(dt, s.racers);
    // (autotest) continuity: no racer moves sideways faster than its edges allow (12 m/s at most, bots.js step)
    if (dt > 1e-3 && b->started) {
      const double dl = std::fabs(b->lat - lat0);
      botLatV = std::max(botLatV, dl / dt);
      botJump = std::max(botJump, std::max(0.0, dl - 12.5 * std::max(dt, racebots::SIM_H * 14)));
      botJump = std::max(botJump, std::max(0.0, glm::length(b->pos - p0) - 75 * dt - 0.5));
    }
  }
  if (s.st != Session::St::Grid) botSeparation();
  // splits, finishes, parking lanes in the finish area
  const bool playerHome = s.st >= Session::St::Finished;
  for (auto& b : s.bots) {
    while (b->cpNext < int(c.checkpoints.size()) && b->s >= c.checkpoints[size_t(b->cpNext)].s && b->running) {
      const CoursePt& cp = c.checkpoints[size_t(b->cpNext)];
      b->splits.push_back(b->t - std::max(0.0, b->s - cp.s) / std::max(1.0, b->sRate));
      b->cpNext++;
    }
    if (b->finished && !b->parked) {
      b->parked = true;
      b->parkRank = ++s.parkCount;
      s.avoid.clear();
      if (playerHome) s.avoid.push_back(s.platL);
      for (auto& o : s.bots) if (o != b && o->parked) s.avoid.push_back(o->parkLat);
      b->setParking(b->parkRank, s.avoid, playerHome, s.platL);
    }
  }
  if (s.st != Session::St::Grid) botContact();
}

// AI racers never ski through each other: a pair closer than BOT_SEP (course coordinates, both on the snow) is pushed
// apart sideways, half each, and the one behind checks its speed a little (a shoulder bump, as with you). Their race
// craft (race_bots decide) keeps such contacts rare; this is the safety net for a full field squeezing through gates.
void Races::botSeparation() {
  auto& B = s_->bots;
  const double R = BOT_SEP;
  for (size_t i = 0; i < B.size(); i++) {
    racebots::BotRacer& a = *B[i];
    if (!a.started) continue;
    for (size_t j = i + 1; j < B.size(); j++) {
      racebots::BotRacer& b = *B[j];
      if (!b.started) continue;
      const double ds = b.s - a.s;
      if (ds > R || ds < -R) continue;
      const double dl = b.lat - a.lat;
      if (dl > R || dl < -R || ds * ds + dl * dl >= R * R) continue;
      const double need = std::sqrt(R * R - ds * ds) - std::fabs(dl);   // lateral gap still missing
      if (!(need > 0)) continue;
      const double sg = dl > 0.01 ? 1 : dl < -0.01 ? -1 : (i + j) % 2 ? 1 : -1;
      // (sideways only while either is in the air: a hop over a roller keeps its speed)
      racebots::BotRacer& back = a.s < b.s ? a : b;
      const double cutV = (a.finished && b.finished) || a.air || b.air ? 0 : 0.25;
      a.bump(-sg * need * 0.5, &back == &a ? cutV : 0);
      b.bump(sg * need * 0.5, &back == &b ? cutV : 0);
    }
  }
}

// Soft contact between you and the bots: shoulder bumps, never a pile-up. In the finish area a finisher sliding into
// you stopped there gives way (you are never shoved around there).
void Races::botContact() {
  Session& s = *s_;
  Player& pl = *c_.player;
  if (pl.mode != PlayerMode::Ski) return;
  const double R = 0.9;
  const bool playerHome = s.st >= Session::St::Finished;
  for (auto& bp : s.bots) {
    racebots::BotRacer& b = *bp;
    const double dx = pl.pos.x - b.pos.x, dz = pl.pos.z - b.pos.z, d2 = dx * dx + dz * dz;
    if (d2 > R * R || std::fabs(pl.pos.y - b.pos.y) > 1.6) continue;
    const double d0 = std::sqrt(d2), d = d0 > 0 ? d0 : 0.01, nx = dx / d, nz = dz / d;
    if (playerHome && b.finished) {
      b.nudge(-nx * (R - d), -nz * (R - d));
      b.v *= 0.5;
      continue;
    }
    if (s.st == Session::St::Results) continue;
    pl.pos.x = b.pos.x + nx * R; pl.pos.z = b.pos.z + nz * R;
    const double vn = (pl.vel.x - b.vel.x) * nx + (pl.vel.z - b.vel.z) * nz;
    if (vn < 0) {
      pl.vel.x -= nx * vn * 1.2; pl.vel.z -= nz * vn * 1.2;
      b.v = std::max(0.0, b.v - std::min(2.0, -vn * 0.3));
    }
  }
}

// the field's rigs: the level of detail by the camera (session.js updateLOD), the poses, the draw
void Races::drawBots(Renderer& r, const dvec3& cam) {
  Session& s = *s_;
  const double dt = animDt_;
  animDt_ = 0;
  botsDrawn = botsFar = botsFx = 0;
  const bool still = s.st == Session::St::Grid;
  const bool countdown = still && !s.intro && LEAD_IN + 3 - s.t < 1;
  // session.js updateLOD: full-rate poses nearby, fewer pose solves further out, the far stand-in past FAR_IN (back
  // to the rig inside FAR_OUT), no rig for racers off screen unless close; snow FX (spray, tracks) for the nearest
  // FX_MAX racers shown within 140 m
  static const bool farNear = [] { const char* e = std::getenv("SKI_LEGACY_DEBUG"); return e && std::strstr(e, "farnear"); }();   // (debug: the stand-ins from 6 m)
  const double farIn = farNear ? 6 : FAR_IN, farOut = farNear ? 5 : FAR_OUT;
  struct Lod { double d = 0; bool view = true, show = false, fx = false; };
  std::vector<Lod> lod(s.bots.size());
  std::vector<size_t> near;
  for (size_t i = 0; i < s.bots.size(); i++) {
    racebots::BotRacer& b = *s.bots[i];
    if (b.cinePlace >= 0) continue;
    Lod& L = lod[i];
    L.d = glm::length(b.pos - cam);
    b.lodFar = i < s.farModel.size() && s.farModel[i] && L.d > (b.lodFar ? farOut : farIn);
    L.view = r.visible(b.pos - dvec3(2.4, 1.5, 2.4), b.pos + dvec3(2.4, 3.3, 2.4));
    L.show = !b.lodFar && L.d < LOD_GONE && (L.view || L.d < LOD_KEEP);
    if (L.show && L.d < 140) near.push_back(i);
  }
  if (int(near.size()) > FX_MAX) std::sort(near.begin(), near.end(), [&](size_t a, size_t q) { return lod[a].d < lod[q].d; });
  for (size_t k = 0; k < near.size() && int(k) < FX_MAX; k++) lod[near[k]].fx = true;
  for (size_t i = 0; i < s.bots.size(); i++) {
    racebots::BotRacer& b = *s.bots[i];
    if (b.cinePlace >= 0) {   // (a podium or a replay poses the rigs itself: updateCine; no stand-ins)
      if (b.cinePlace == 1 && b.rigOk && b.R.posed) { drawRig(r, b.R, c_.people->kindOf(b.kind), c_.people->gear(3).get(), 1, true); botsDrawn++; }
      continue;
    }
    const Lod& L = lod[i];
    const double d = L.d;
    const double step = still ? (d < LOD_KEEP ? 0 : 1.0 / 15) : d < LOD_FULL ? 0 : d < LOD_HALF ? 1.0 / 30 : 1.0 / 15;
    b.animate(dt, d, countdown, L.show, step, L.fx);
    // (bots.js animate: skierFX(trails, spray, fxId, rig, { grounded, speed, vel, sideslip, plow: 0, lean }, fxAcc))
    if (b.fx.due && c_.trails) { c_.trails->skier(3000 + int(i) * 4, b.pos, b.vel, b.heading, b.edge, b.fx.sideslip, b.fx.lean, b.fx.speed, b.fx.grounded); botsFx++; }
    else if (L.fx) botsFx++;
    if (b.lodFar && L.view && d < LOD_GONE) {
      // farbots.js put(): facing the heading, leaning -lean * 0.45 about the travel direction
      const glm::dquat q = glm::angleAxis(-b.lean * 0.45, dvec3(std::sin(b.heading), 0, std::cos(b.heading))) * glm::angleAxis(b.heading, dvec3(0, 1, 0));
      r.submitModel(*s.farModel[i], b.pos, mat4(glm::mat4_cast(q)), nullptr, false);
      botsFar++;
    }
    if (!L.show || !b.rigOk) continue;
    drawRig(r, b.R, c_.people->kindOf(b.kind), c_.people->gear(3).get(), 1, d < 40);
    botsDrawn++;
  }
}

// ---------------------------------------------------------------- people, 3D, HUD
void Races::addPeople(People& people, const dvec3& cam) const {
  // the crowd at the finish of the course you are near (crowds.js): both sides of the run-out
  const Course* c = s_ ? s_->c : nearCourse_;
  if (c && !c->bus && !c_.people->fanKinds.empty() && std::hypot(cam.x - c->finish.x, cam.z - c->finish.z) < 700) {
    Mulberry32 rng(uint32_t(c->line.n * 7919));
    for (int i = 0; i < 60; i++) {
      double s = c->finish.s - 110 + rng.next() * 150;
      double side = rng.next() < 0.5 ? -1 : 1;
      double lat = side * (c->line.width(s) + 3 + rng.next() * 5);
      dvec3 p = c->line.point(s, lat);
      Person q;
      q.kind = c_.people->fanKinds[size_t(i) % c_.people->fanKinds.size()];
      q.pos = dvec3(p.x, c_.world->height(p.x, p.z), p.z);
      q.yaw = c->line.heading(s) - side * PI / 2;
      q.anim = (i % 3 == 0) ? PAnim::Wave : PAnim::Idle;
      q.phase = c_.now * 0.8 + rng.next() * 5;
      people.add(q);
    }
  }
}

void Races::draw(Renderer& r, const dvec3& cam) {
  Shapes& sh = *c_.shapes;
  if (s_ && !s_->bots.empty()) drawBots(r, cam);
  if (s_ && s_->podium) s_->podium->draw(r, sh);
  // a floodlit night course (floodlights.js CourseFloodlights.write): the masts nearest the camera light the snow and
  // the racers: four lamps on a crossarm 11 m up, aimed across the run (warm pools, 45 m)
  if (s_ && s_->c->night && !s_->c->masts.empty()) {
    std::vector<std::pair<double, const Course::Mast*>> near;
    for (const Course::Mast& m : s_->c->masts) { const double d = glm::length(dvec3(m.lx, m.ly, m.lz) - cam); if (d < 600) near.push_back({d, &m}); }
    std::sort(near.begin(), near.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    if (near.size() > 10) near.resize(10);
    for (auto& [d, m] : near) {
      PointLight l;
      l.pos = dvec3(m->lx, m->ly, m->lz); l.color = vec3(1.0f, 0.83f, 0.64f) * 420.f; l.range = 46;
      l.dir = glm::normalize(vec3(float(m->ax), float(m->ay), float(m->az))); l.cosOuter = 0.42f; l.cosInner = 0.8f;
      r.addLight(l);
      // (the lamps' glass and their halo, seen from afar)
      sh.sphere(r, l.pos + dvec3(0, 0.15, 0), 0.34, vec4(1.0f, 0.9f, 0.72f, 1), 9);
    }
  }
  // the gates' ribbons (gatebars.js): every gate of the course, green ahead (the next one brighter and pulsing), grey
  // once passed, red when missed; unlit (they glow by night and stand out against the snow by day), striped like
  // barrier tape
  if (s_ && !s_->bars.empty() && c_.dev) {
    Session& s = *s_;
    const int next = s.st != Session::St::Results && s.nextGate < int(s.bars.size()) && s.bars[size_t(s.nextGate)].state == 0 ? s.nextGate : -1;
    if (s.barsDirty || next != s.barsNext) {
      s.barsDirty = false; s.barsNext = next;
      if (!s.tape) s.tape = tapeTexture(*c_.dev);
      s.barOrigin = s.bars[0].a;
      auto build = [&](int state, bool isNext, float k) -> std::shared_ptr<Model> {
        Geo g;
        for (size_t i = 0; i < s.bars.size(); i++) {
          const Session::Bar& q = s.bars[i];
          if (isNext ? int(i) != next : (q.state != state || int(i) == next)) continue;
          const vec3 a(q.a - s.barOrigin), b(q.b - s.barOrigin);
          const float L = float(std::max(0.5, q.len - 2 * BAR_INSET) / BAR_STRIPE);
          const uint32_t base = uint32_t(g.pos.size());
          const vec3 nrm = glm::normalize(glm::cross(b - a, vec3(0, 1, 0)));
          g.pos.insert(g.pos.end(), {a + vec3(0, float(BAR_LOW), 0), b + vec3(0, float(BAR_LOW), 0), a + vec3(0, float(BAR_HIGH), 0), b + vec3(0, float(BAR_HIGH), 0)});
          g.uv.insert(g.uv.end(), {vec2(0, 0), vec2(L, 0), vec2(0, 1), vec2(L, 1)});
          for (int v = 0; v < 4; v++) { g.nor.push_back(nrm); g.col.push_back(vec3(1)); }
          g.idx.insert(g.idx.end(), {base, base + 1, base + 2, base + 2, base + 1, base + 3});
        }
        if (g.idx.empty()) return nullptr;
        Material m;   // (MeshBasicMaterial: the colour x the tape, unlit: all of it emissive)
        m.baseColor = vec4(0, 0, 0, 1); m.metallic = 0; m.roughness = 1; m.doubleSided = true; m.shading = 3;
        m.emissive = hexColor(BAR_COLORS[isNext ? 3 : state]) * k;
        m.emissiveTex = s.tape;
        return buildModel(*c_.dev, {{std::move(g), m}}, "gate-bars");
      };
      for (int st = 0; st < 3; st++) s.barModel[st] = build(st, false, 1);
      for (int k = 0; k < 4; k++) s.barNext[k] = next >= 0 ? build(0, true, 0.64f + 0.12f * float(k)) : nullptr;
    }
    if (glm::length(s.barOrigin - cam) < 6000) {
      for (auto& m : s.barModel) if (m) r.submitModel(*m, s.barOrigin, mat4(1), nullptr, false);
      // (gatebars.js update: 0.82 + 0.18 sin(7 t))
      const int k = std::clamp(int(std::lround((0.82 + 0.18 * std::sin(c_.now * 7) - 0.64) / 0.12)), 0, 3);
      if (s.barNext[k]) r.submitModel(*s.barNext[k], s.barOrigin, mat4(1), nullptr, false);
    }
  }
  // the race guide: a tall soft pillar of light over the race and pennant poles on the way (raceguide.js)
  if (guide_.on) {
    dvec3 t = guide_.target;
    t.y = c_.world->height(t.x, t.z);
    sh.cylinder(r, t, 1.6, 60, vec4(1.0f, 0.62f, 0.15f, 0.28f), 3, false);
    dvec3 p = c_.player->pos;
    dvec2 d(t.x - p.x, t.z - p.z);
    double L = glm::length(d);
    if (L > 1) {
      d /= L;
      for (int i = 1; i <= 16 && i * 30 < L; i++) {
        dvec3 q(p.x + d.x * i * 30, 0, p.z + d.y * i * 30);
        q.y = c_.world->groundHeight(q.x, q.z, p.y + 50);
        sh.cylinder(r, q, 0.04, 2.2, vec4(0.9f, 0.9f, 0.9f, 1), 0, false);
        sh.box(r, q + dvec3(0, 1.75, 0), std::atan2(d.x, d.y), vec3(0.02f, 0.4f, 0.6f), vec4(1.0f, 0.5f, 0.05f, 1), 1.5f, false);
      }
    }
  }
}

std::string Races::objective() const {
  if (s_) return "";
  if (guide_.on) {
    double d = std::hypot(c_.player->pos.x - guide_.target.x, c_.player->pos.z - guide_.target.z);
    return "Race: " + guide_.label + " \xC2\xB7 follow the arrow \xC2\xB7 " + std::to_string(int(std::round(d / 10) * 10)) + " m";
  }
  return "";
}

void Races::guideFrom(const dvec3& p, const std::string& stop) {
  if (!c_.data || s_) return;
  const Course* best = nullptr;
  dvec3 tgt(0);
  double bd = 600;
  for (const Course& c : c_.data->busRaces) {
    dvec3 t = c.hasBoard ? dvec3(c.boardX, 0, c.boardZ) : dvec3(c.start.x, 0, c.start.z);
    double d = std::hypot(t.x - p.x, t.z - p.z);
    if (c.stop == stop) d *= 0.2;
    if (d < bd) { bd = d; best = &c; tgt = t; }
  }
  for (const Course& c : c_.data->courses) {
    double d = std::hypot(c.start.x - p.x, c.start.z - p.z);
    if (d < bd) { bd = d; best = &c; tgt = dvec3(c.start.x, 0, c.start.z); }
  }
  if (!best || bd < 8) return;
  guide_.on = true; guide_.target = tgt; guide_.label = best->name; guide_.t = 0;
  guide_.d0 = std::hypot(tgt.x - p.x, tgt.z - p.z);
  if (c_.mark) c_.mark(tgt.x, tgt.z, best->name);
}

void Races::hud(Ui& ui, float) {
  ui_ = &ui;
  if (!s_) return;
  const Session& s = *s_;
  if (s.st >= Session::St::Results || s.podium || s.replay || s.intro) { hudCine(ui); return; }   // (the panels step aside for the results screen and the cinematics)
  const Course& c = *s.c;
  RaceHudState h;
  h.course = c.name;
  h.difficulty = s.practice ? "PRACTICE" : c.bus ? "FREE RACE" : AI_LABEL[s.ai];
  h.trial = s.practice || s.bots.empty();
  h.time = s.st >= Session::St::Finished ? s.finalTime : std::max(0.0, s.clock) + s.penalty;
  h.shownFor = c_.now - s.shownAt;
  h.penalty = s.penalty;
  h.checkpoint = s.lastCp; h.checkpoints = std::max(0, int(c.checkpoints.size()) - 1);
  h.toFinish = std::max(0.0, c.finish.s - s.prevS);
  h.progress = c.finish.s > c.start.s ? std::clamp((s.prevS - c.start.s) / (c.finish.s - c.start.s), 0.0, 1.0) : 0;
  h.speed = glm::length(c_.player->vel);
  // what to ski for next: the gate ahead (red arrow), else the next checkpoint
  if (s.st == Session::St::Race) {
    double tx = 0, tz = 0, ts = -1;
    if (s.nextGate < int(s.gates.size()) && s.nextGate < int(c.gates.size())) { const CourseGate& g = c.gates[size_t(s.nextGate)]; tx = g.x; tz = g.z; ts = g.s; h.nextLabel = "GATE"; }
    else if (s.nextCp < int(c.checkpoints.size())) { const CoursePt& q = c.checkpoints[size_t(s.nextCp)]; tx = q.x; tz = q.z; ts = q.s; h.nextLabel = "NEXT"; }
    if (ts >= 0) {
      h.hasNext = true;
      h.nextDist = std::max(0.0, ts - s.prevS);
      double a = std::atan2(tx - c_.player->pos.x, tz - c_.player->pos.z) - c_.player->heading;
      h.nextAngle = std::atan2(std::sin(a), std::cos(a)) * 180 / PI;
    }
  }
  // the standings: the finished by their times, the rest by how far down the course they are
  if (!h.trial) {
    struct E { std::string name; double key, v; bool me; };
    std::vector<E> es;
    bool meDone = s.st >= Session::St::Finished;
    es.push_back({"You", meDone ? 1e7 - s.finalTime : s.prevS, std::max(6.0, h.speed), true});
    for (auto& b : s.bots) es.push_back({b->name, b->finished ? 1e7 - b->finishTime : b->s, std::max(6.0, b->v), false});
    std::sort(es.begin(), es.end(), [](const E& p, const E& q) { return p.key > q.key; });
    for (size_t i = 0; i < es.size(); i++) {
      double gap = es[0].key > 1e6 ? (es[i].key > 1e6 ? es[0].key - es[i].key : (c.finish.s - es[i].key) / es[i].v + std::max(0.0, s.clock - (1e7 - es[0].key))) : (es[0].key - es[i].key) / es[i].v;
      h.standings.push_back({es[i].name, std::max(0.0, gap), es[i].me});
      if (es[i].me) h.position = int(i) + 1;
    }
    h.total = int(es.size());
  }
  // the countdown, GO, the banner, the split card, the intro's lower third
  if (s.st == Session::St::Grid) {
    double left = LEAD_IN + 3 - s.t;
    if (left <= 3 && left > 0) { h.countdown = std::to_string(int(std::ceil(left))); h.countdownAge = std::ceil(left) - left; }
    h.third.on = !s.introRan; h.third.age = s.t; h.third.left = LEAD_IN + 1.2;   // (after the intro its lower third has been shown)
    h.third.kicker = s.practice ? "PRACTICE RACE" : c.bus ? "FREE RACE" : std::string("WORLD RACING \xC2\xB7 ") + uiwUpper(AI_LABEL[s.ai]);
    h.third.title = c.name;
    char km[32];
    std::snprintf(km, sizeof km, "%.1f KM", c.length / 1000);
    h.third.stats = {{"LENGTH", km}, {"DROP", fmtMoney(c.drop).substr(1) + " M"}};
    if (!h.trial) h.third.stats.push_back({"FIELD", std::to_string(s.bots.size() + 1)});
  } else if (s.t < LEAD_IN + 3 + 0.6 && !s.introRan) { h.third.on = true; h.third.age = s.t; h.third.left = LEAD_IN + 1.2; h.third.title = c.name; }
  if (!s.notice.empty()) {
    if (s.notice == "GO") { h.countdown = "GO"; h.countdownAge = c_.now - s.noticeT; }
    else { h.notice = s.notice; h.noticeAge = c_.now - s.noticeT; h.noticeFor = 2.4; h.noticeKind = s.noticeBad ? 1 : (s.st >= Session::St::Finished ? 2 : 0); }
  }
  if (s.sp.on) { h.split.on = true; h.split.index = s.sp.index; h.split.total = h.checkpoints; h.split.split = s.sp.split; h.split.delta = s.sp.delta; h.split.hasDelta = s.sp.hasDelta; h.split.name = s.sp.name; h.split.age = c_.now - s.sp.at; }
  drawRaceHud(ui, h);
  hudCine(ui);
}

} // namespace sl
