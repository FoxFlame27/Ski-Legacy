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
#include "game/race_bots.h"
#include "game/shapes.h"
#include "game/weather.h"
#include "platform/platform.h"
#include "player/player.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>

namespace sl {

namespace {
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
constexpr double LOD_FULL = 30, LOD_HALF = 70, LOD_KEEP = 12, LOD_GONE = 400, BOT_SEP = 1.15;
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
int medalRank(const nlohmann::json& m) { if (!m.is_string()) return 0; std::string s = m; return s == "gold" ? 3 : s == "silver" ? 2 : s == "bronze" ? 1 : 0; }
} // namespace

struct Races::Session {
  const Course* c = nullptr;
  int ai = 1;
  bool forMoney = false, practice = false, stand = false;
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
};

Races::Races(PlayCtx& c) : c_(c) {}
Races::~Races() = default;

racebots::Track& Races::trackOf(const Course& c) {
  for (auto& [k, t] : tracks_) if (k == &c) return *t;
  tracks_.push_back({&c, std::make_unique<racebots::Track>(c, *c_.world)});
  return *tracks_.back().second;
}

bool Races::frozen() const { return s_ && s_->st == Session::St::Grid; }
bool Races::finished() const { return s_ && (s_->st == Session::St::Finished || s_->st == Session::St::Results); }
bool Races::resultsUp() const { return s_ && s_->st == Session::St::Results; }
double Races::raceTime() const { return s_ ? (s_->st >= Session::St::Finished ? s_->finalTime : s_->clock) : 0; }
int Races::place() const { return s_ ? s_->place : 0; }
double Races::progress() const { return s_ ? s_->prevS - s_->c->start.s : 0; }

void Races::abort() {
  if (!s_) return;
  s_.reset();
  if (c_.weather) c_.weather->frozen = c_.autotest;
}

// ---------------------------------------------------------------- the race card, the stand
void Races::openCard(const Course& co, bool fromStand) {
  Dialog d;
  const Course* cp = &co;
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
      int def = aiIndex(c.ai);
      for (int ai = 0; ai < 4; ai++) {
        DialogOption o;
        o.label = std::string("Race \xC2\xB7 ") + AI_LABEL[ai] + " field";
        if (fromStand) { o.sub = "14 AI racers \xC2\xB7 just for fun"; o.price = 0; }
        else { o.sub = "14 AI racers \xC2\xB7 1st " + fmtMoney(prizeFor(c, ai)) + ", 2nd " + fmtMoney(int64_t(std::round(prizeFor(c, ai) * 0.4))) + (ai == def ? " \xC2\xB7 suggested" : ""); o.price = c.entry; }
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

void Races::openStand() {
  Dialog d;
  d.kicker = "RACING \xC2\xB7 Legacy Village";
  d.title = "Racing";
  d.keepOpen = false;
  d.rebuild = [this](Dialog& D) {
    D.say = "Pick a course: you race the 14 AI there just for fun (no prize money). Races for money: at the courses' start houses and the ski bus's free races.";
    D.options.clear();
    for (const Course& c : c_.data->courses) {
      DialogOption o;
      const nlohmann::json& rec = c_.save->data("records")[c.id];
      o.label = c.name;
      o.sub = c.diff + " \xC2\xB7 " + std::to_string(int(std::round(c.length))) + " m" + (rec.is_object() && rec.contains("best") && rec["best"].is_number() ? " \xC2\xB7 best " + fmtRaceTime(rec["best"].get<double>()) : std::string());
      if (rec.is_object() && rec.contains("bestRace") && rec["bestRace"].is_number()) o.state = ordinal(rec["bestRace"].get<int>());
      const Course* cp = &c;
      o.act = [this, cp]() { openCard(*cp, true); };
      D.options.push_back(o);
    }
    DialogOption n; n.label = "Close"; n.secondary = true;
    D.options.push_back(n);
  };
  c_.menus->openDialog(d);
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
  if (c_.online) { forMoney = false; practice = true; ai = 0; if (c_.raceSolo) c_.raceSolo(co.id); }
  if (forMoney && !co.bus && co.entry > 0 && !c_.spend(co.entry)) return false;
  auto s = std::make_unique<Session>();
  s->c = &co;
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
  if (!practice) {
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
      s->bots.push_back(std::move(b));
    }
  }
  s_ = std::move(s);
  if (teleport && c_.fade) c_.fade();
  dvec3 sp = L.point(s0, 0);
  c_.player->setSkisOn(true);
  c_.player->teleport(sp.x, sp.z, co.start.heading);
  c_.player->setSkisOn(true);
  s_->prevS = s0; s_->progS = s0;
  botJump = botLatV = 0;
  updateBots(0.0001);   // (the first frame of the field: it stands on the grid right away)
  if (c_.weather) c_.weather->frozen = true;   // (session.js: the weather is held for the race)
  if (c_.unmark) c_.unmark();
  guide_.on = false;
  c_.save->stats.races++;
  c_.save->markDirty();
  c_.flash(co.name + (practice ? " \xC2\xB7 practice run" : s_->stand ? " \xC2\xB7 just for fun" : std::string(" \xC2\xB7 ") + (co.bus ? "free race" : AI_LABEL[s_->ai]) ), 0);
  return true;
}

void Races::respawn(const char* why) {
  Session& s = *s_;
  const Course& c = *s.c;
  double cs = s.lastCp > 0 && s.lastCp < int(c.checkpoints.size()) ? c.checkpoints[size_t(s.lastCp)].s : c.start.s;
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
  s.notice = std::string("BACK TO ") + (s.lastCp > 0 ? c.checkpoints[size_t(s.lastCp)].name : std::string("THE START")); s.noticeT = c_.now; s.noticeBad = true;
  SL_INFO("race: respawn (%s) at s=%.0f", why, cs);
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
    if (!r["best"].is_number() || s.finalTime < r["best"].get<double>()) { r["best"] = std::round(s.finalTime * 1000) / 1000; r["splits"] = s.splits; s.notice = "NEW RECORD"; }
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
  std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.t < b.t; });
  for (size_t i = 0; i < rows.size(); i++) if (rows[i].you) s.place = int(i) + 1;
  int field = int(rows.size());
  if (c_.online && c_.raceFinished) c_.raceFinished(s.finalTime, false);
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
  Dialog d;
  d.kicker = s.practice ? "PRACTICE RACE \xC2\xB7 NO PRIZE" : s.c->bus ? "FREE RACE \xC2\xB7 RESULTS" : s.stand ? "RACE \xC2\xB7 JUST FOR FUN" : std::string("WORLD RACING \xC2\xB7 ") + AI_LABEL[s.ai] + " field";
  d.title = s.practice ? s.c->name + " \xC2\xB7 " + fmtRaceTime(s.finalTime) : ordinal(s.place) + " \xC2\xB7 " + fmtRaceTime(s.finalTime);
  std::string say = s.c->name;
  if (s.penalty > 0) say += " \xC2\xB7 " + std::to_string(s.missed.size()) + " missed gate(s) +" + fmtRaceTime(s.penalty);
  if (const char* m = medalForTime(s.finalTime, *s.c)) say += std::string(" \xC2\xB7 ") + m + " time";
  if (s.prize > 0) say += " \xC2\xB7 prize " + fmtMoney(s.prize);
  if (!s.practice) { say += "\n"; for (size_t i = 0; i < rows.size() && i < 5; i++) say += "  " + ordinal(int(i) + 1) + " " + rows[i].name + " " + fmtRaceTime(rows[i].t); }
  d.say = say;
  DialogOption ok; ok.label = "OK"; ok.sub = "Back to Legacy Village";
  ok.act = [this]() { confirmResults(); };
  d.options = {ok};
  c_.menus->openDialog(d);
  SL_INFO("race: %s finished in %s, place %d of %d, prize $%d", s.c->name.c_str(), fmtRaceTime(s.finalTime).c_str(), s.place, field, s.prize);
  if (!s.bots.empty()) SL_INFO("race: the AI field: fastest lateral speed %.2f m/s, largest step beyond a racer's own motion %.3f m, reference run %.2f s", botLatV, botJump, s.field.refTime);
}

void Races::confirmResults() {
  if (!s_) return;
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
  if (s.st == Session::St::Results) updateBots(dt);   // (the field skis out and stops behind the results card)
  if (s.st == Session::St::Results || s.st == Session::St::Done) return;
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
        char nb[96];
        if (best < 1e9) std::snprintf(nb, sizeof nb, "%s  %s  %s%.2f", cp.name.c_str(), fmtRaceTime(split).c_str(), split - best >= 0 ? "+" : "-", std::fabs(split - best));
        else std::snprintf(nb, sizeof nb, "%s  %s", cp.name.c_str(), fmtRaceTime(split).c_str());
        s.notice = nb; s.noticeT = c_.now; s.noticeBad = best < 1e9 && split > best;
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
        double yLine = L.sAt(L.Y, pr.s);
        bool below = pl.pos.y < yLine - FALL_BELOW && !(pl.air && pl.vel.y > 0);
        s.fellT = below ? s.fellT + dt : 0;
        if (s.clock - s.progT > STUCK_TIME) respawn("stuck");
        else if (s.offT > (outBy > FAR_MARGIN ? FAR_TIME : OFF_TIME)) respawn("off");
        else if (s.fellT > FALL_TIME) respawn("fell");
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
    if ((s.t >= s.resultsAt && fieldHome) || s.t >= s.resultsAt + RESULTS_MAX_WAIT) showResults();
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
  botsDrawn = 0;
  const bool still = s.st == Session::St::Grid;
  const bool countdown = still && LEAD_IN + 3 - s.t < 1;
  for (auto& bp : s.bots) {
    racebots::BotRacer& b = *bp;
    const double d = glm::length(b.pos - cam);
    const bool view = r.visible(b.pos - dvec3(2.4, 1.5, 2.4), b.pos + dvec3(2.4, 3.3, 2.4));
    const bool show = d < LOD_GONE && (view || d < LOD_KEEP);
    const double step = still ? (d < LOD_KEEP ? 0 : 1.0 / 15) : d < LOD_FULL ? 0 : d < LOD_HALF ? 1.0 / 30 : 1.0 / 15;
    b.animate(dt, d, countdown, show, step);
    if (!show || !b.rigOk) continue;
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

void Races::hud(Ui& ui, float u) {
  if (!s_) return;
  const Session& s = *s_;
  float W = float(ui.width());
  // the race clock and position (racehud.js): top centre
  float x = W / 2, y = 18 * u;
  ui.brushPanel(x - 150 * u, y, 300 * u, 74 * u, ui_color::a(ui_color::paper, 0.92f), 1);
  ui.text(x, y + 6 * u, 15 * u, UiFont::CondBold, ui_color::red, s.c->name, UiAlign::Center);
  double t = s.st >= Session::St::Finished ? s.finalTime : std::max(0.0, s.clock) + s.penalty;
  ui.text(x, y + 24 * u, 36 * u, UiFont::CondHeavy, ui_color::blue, fmtRaceTime(t), UiAlign::Center);
  if (!s.practice && !s.bots.empty()) {
    int pos = 1;
    double myS = s.prevS;
    for (auto& b : s.bots) pos += b->finished ? (s.st < Session::St::Finished || b->finishTime < s.finalTime) : b->s > myS && s.st < Session::St::Finished;
    std::string ps = std::to_string(pos) + "/" + std::to_string(s.bots.size() + 1);
    ui.text(x + 140 * u, y + 30 * u, 22 * u, UiFont::CondBold, ui_color::navy, ps, UiAlign::Right);
  }
  if (!s.gates.empty()) ui.text(x - 140 * u, y + 34 * u, 14 * u, UiFont::Cond, ui_color::navy, "GATES " + std::to_string(s.nextGate) + "/" + std::to_string(s.gates.size()));
  // the countdown
  if (s.st == Session::St::Grid) {
    double left = LEAD_IN + 3 - s.t;
    if (left <= 3) {
      std::string n = std::to_string(int(std::ceil(left)));
      float sz = float(120 + 60 * (std::ceil(left) - left)) * u;
      ui.text(W / 2, float(ui.height()) * 0.32f, sz, UiFont::CondHeavy, ui_color::red, n, UiAlign::Center);
    }
  }
  // the notice line (splits, gates, GO, FINISH, the place)
  if (!s.notice.empty() && c_.now - s.noticeT < 2.6) {
    float a = float(1 - smoothstep(2.0, 2.6, c_.now - s.noticeT));
    bool big = s.notice == "GO" || s.notice == "FINISH" || s.notice == "NEW RECORD" || (s.notice.size() <= 4 && std::isdigit(uint8_t(s.notice[0])));
    ui.text(W / 2, float(ui.height()) * (big ? 0.3f : 0.2f), (big ? 84 : 26) * u, UiFont::CondHeavy, ui_color::a(s.noticeBad ? ui_color::red : ui_color::blue, a), s.notice, UiAlign::Center);
  }
}

} // namespace sl
