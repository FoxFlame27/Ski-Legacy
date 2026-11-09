#include "game/races.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/economy.h"
#include "game/hud.h"
#include "game/menus.h"
#include "game/people.h"
#include "game/shapes.h"
#include "game/weather.h"
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
// freeworld.js AI_LEVELS / bots.js DIFFICULTY (paces of the 14 AI racers)
const char* AI_KEY[4] = {"easy", "medium", "hard", "superhard"};
const char* AI_LABEL[4] = {"Easy", "Medium", "Hard", "Superhard"};
const double AI_MULT[4] = {0.6, 1, 1.6, 2.5};
const double PACE[4][14] = {
  {1.16, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.36, 1.39, 1.42, 1.45, 1.48, 1.51, 1.55},
  {1.04, 1.06, 1.08, 1.1, 1.12, 1.14, 1.16, 1.18, 1.2, 1.22, 1.24, 1.26, 1.28, 1.3},
  {0.99, 1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1, 1.11, 1.13},
  {0.95, 0.96, 0.97, 0.98, 0.99, 1.0, 1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.08},
};
const double PRIZE_SHARE[3] = {1, 0.4, 0.15};
const double BUS_SHARE[3] = {1, 0.7, 0.5};
const char* BOT_NAMES[14] = {"L. Meier", "S. Brunner", "A. Rossi", "M. Dubois", "J. Kofler", "E. Lindqvist", "T. Haugen", "K. Sato", "N. Weber", "P. Moreau", "F. Gruber", "C. Bianchi", "O. Berg", "R. Steiner"};
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
  const Prof* prof = nullptr;
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
  struct Bot { int kind; double s, lat, latT, v, pace, finishT, phase, parkLat, stopS; bool done; std::string name; std::vector<double> splits; };
  std::vector<Bot> bots;
  int respawns = 0;
  double fadeT = -1;
};

Races::Races(PlayCtx& c) : c_(c) {}
Races::~Races() = default;

const Races::Prof& Races::profile(const Course& c) {
  for (auto& [k, p] : profs_) if (k == &c) return p;
  // bots.js simulateRun, condensed: the speed a racer can carry (lateral grip in the bends, gravity down the grade,
  // air drag) in a forward pass, braking room for the bends in a backward pass; the run's time is then scaled to the
  // course's reference time (courses.js REF_TIMES: par / 1.08; the bus races' par is 1.5 x the AI's ideal run)
  Prof p;
  const CourseLine& L = c.line;
  int n = L.n;
  std::vector<double> cap(static_cast<size_t>(n)), v(static_cast<size_t>(n));
  const double aLat = 17.5, g = 9.81;
  for (int i = 0; i < n; i++) {
    double k = std::fabs(L.K.empty() ? 0.0 : double(L.K[size_t(i)]));
    cap[size_t(i)] = std::min(36.0, k > 1e-5 ? std::sqrt(aLat / k) : 36.0);
  }
  v[0] = 3;
  for (int i = 1; i < n; i++) {
    double grade = (L.Y[size_t(i - 1)] - L.Y[size_t(i)]) / L.ds;
    double vp = v[size_t(i - 1)];
    double a = g * grade * 0.92 - 0.0035 * vp * vp - 0.4;
    v[size_t(i)] = std::min(cap[size_t(i)], std::sqrt(std::max(4.0, vp * vp + 2 * a * L.ds)));
  }
  for (int i = n - 2; i >= 0; i--) v[size_t(i)] = std::min(v[size_t(i)], std::sqrt(v[size_t(i) + 1] * v[size_t(i) + 1] + 2 * 6.0 * L.ds));
  double fin = c.finish.s > 0 ? c.finish.s : L.length(), s0 = c.start.s;
  p.t0 = 0;
  for (int i = 0; i + 1 < n; i++) {
    double s = i * L.ds;
    if (s < s0 || s >= fin) continue;
    p.t0 += L.ds / std::max(2.0, v[size_t(i)]);
  }
  p.ref = c.bus ? c.par / 1.5 : c.par > 0 ? c.par / 1.08 : p.t0;
  if (p.ref <= 0) p.ref = p.t0;
  p.v.assign(v.begin(), v.end());
  profs_.push_back({&c, std::move(p)});
  return profs_.back().second;
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
  s->prof = &profile(co);
  s->ai = co.bus ? 0 : ai;
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
  }
  // the field: abreast beside you, a second row behind (session.js gridSlots)
  if (!practice) {
    Mulberry32 rng(uint32_t(std::hash<std::string>{}(co.id)) ^ uint32_t(c_.now * 1000));
    for (int i = 0; i < FIELD_BOTS; i++) {
      Session::Bot b{};
      int row = i < 8 ? 0 : 1, k = row ? i - 8 : i;
      double side = (k % 2 ? -1 : 1) * (GRID_FIRST + (k / 2) * GRID_SPACING);
      b.s = s0 - row * GRID_ROW;
      b.lat = std::clamp(side, -L.width(s0) + 1.2, L.width(s0) - 1.2);
      b.latT = b.lat * 0.3;
      b.pace = PACE[s->ai][i] * (0.985 + rng.next() * 0.03);
      b.kind = c_.people && !c_.people->skierKinds.empty() ? c_.people->skierKinds[size_t(i) % c_.people->skierKinds.size()] : 0;
      b.phase = rng.next() * 10;
      b.name = BOT_NAMES[i];
      b.finishT = -1;
      s->bots.push_back(b);
    }
  }
  s_ = std::move(s);
  if (teleport && c_.fade) c_.fade();
  dvec3 sp = L.point(s0, 0);
  c_.player->setSkisOn(true);
  c_.player->teleport(sp.x, sp.z, co.start.heading);
  c_.player->setSkisOn(true);
  s_->prevS = s0; s_->progS = s0;
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
  for (auto& b : s.bots) ahead += b.done && b.finishT < s.finalTime;
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
    double t = b.done ? b.finishT : s.clock + (s.c->finish.s - b.s) / std::max(4.0, b.v);
    rows.push_back({b.name, t, false});
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
  double scaleRef = s.prof->ref;
  for (auto& b : s.bots) {
    b.phase += dt;
    if (s.st == Session::St::Grid) continue;
    if (!b.done) {
      int i = std::clamp(int(b.s / L.ds), 0, L.n - 1);
      double vt = s.prof->v[size_t(i)] * s.prof->t0 / (scaleRef * b.pace);
      b.v += (vt - b.v) * std::min(1.0, dt * 2.5);
      double ns = b.s + b.v * dt;
      // checkpoints' splits
      for (size_t k = 1; k < c.checkpoints.size(); k++) if (b.s < c.checkpoints[k].s && ns >= c.checkpoints[k].s) b.splits.push_back(s.clock);
      if (ns >= c.finish.s) { b.done = true; b.finishT = s.clock - (ns - c.finish.s) / std::max(1.0, b.v); b.parkLat = (int(&b - s.bots.data()) % 7 - 3) * 2.6; b.stopS = c.finish.s + 25 + (int(&b - s.bots.data()) % 4) * 4; }
      b.s = ns;
      // a racing line: weaving across the track with the bends
      if (std::fmod(b.phase, 3.0) < dt) b.latT = std::sin(b.phase * 0.7 + b.pace * 10) * L.width(b.s) * 0.45;
      b.lat += (b.latT - b.lat) * std::min(1.0, dt * 0.8);
    } else {
      b.v = std::max(0.0, b.v - FINISH_BRAKE * dt);
      b.s = std::min(b.stopS, b.s + b.v * dt);
      b.lat += (b.parkLat - b.lat) * std::min(1.0, dt);
    }
  }
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
        for (auto& b : s.bots) if (b.splits.size() >= size_t(s.nextCp)) best = std::min(best, b.splits[size_t(s.nextCp - 1)]);
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
        s.penalty = double(s.missed.size()) * GATE_PENALTY;
        s.notice = "MISSED GATE  +0.50 \xC2\xB7 AIM FOR THE GREEN"; s.noticeT = c_.now; s.noticeBad = true;
        sounds.push_back("miss");
      } else sounds.push_back("gate");
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
    for (auto& b : s.bots) fieldHome = fieldHome && (b.done || (c.finish.s - b.s) / std::max(4.0, b.v) > 12);
    if ((s.t >= s.resultsAt && fieldHome) || s.t >= s.resultsAt + RESULTS_MAX_WAIT) showResults();
  }
  s.prevS = pr.s; s.prevLat = pr.lat;
}

// ---------------------------------------------------------------- people, 3D, HUD
void Races::addPeople(People& people, const dvec3& cam) const {
  if (s_) {
    const Session& s = *s_;
    const CourseLine& L = s.c->line;
    for (const auto& b : s.bots) {
      dvec3 p = L.point(b.s, b.lat);
      if (glm::length(p - cam) > 300) continue;
      Person q;
      q.kind = b.kind; q.pos = p; q.pos.y = c_.world->height(p.x, p.z);
      q.yaw = L.heading(b.s);
      q.anim = s.st == Session::St::Grid || b.v < 1 ? PAnim::Idle : b.v > 15 ? PAnim::Tuck : PAnim::Ski;
      q.skis = true; q.phase = b.phase;
      q.lean = float(clamp((L.K.empty() ? 0 : L.sAt(L.K, b.s)) * b.v * b.v * 0.04, -0.5, 0.5));
      people.add(q);
    }
  }
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
  // the next slalom gate's green bar (gatebars.js): a glowing bar between its poles
  if (s_ && s_->st == Session::St::Race && s_->nextGate < int(s_->c->gates.size())) {
    const CourseGate& g = s_->c->gates[size_t(s_->nextGate)];
    dvec3 a(g.x, g.y, g.z), b(g.x + g.nx * g.side * 5, g.y, g.z + g.nz * g.side * 5);
    b.y = c_.world->height(b.x, b.z);
    if (glm::length(a - cam) < 400) {
      dvec3 m = (a + b) * 0.5;
      double yaw = std::atan2(b.x - a.x, b.z - a.z);
      sh.box(r, m + dvec3(0, 1.6, 0), yaw, vec3(0.08f, 0.08f, float(glm::length(b - a))), vec4(0.2f, 1, 0.3f, 1), 4, false);
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
    for (auto& b : s.bots) pos += b.done ? (s.st < Session::St::Finished || b.finishT < s.finalTime) : b.s > myS && s.st < Session::St::Finished;
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
