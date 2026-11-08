#include "game/jobs.h"
#include "core/log.h"
#include "core/noise.h"
#include "engine/renderer.h"
#include "engine/ui.h"
#include "game/drive.h"
#include "game/economy.h"
#include "game/menus.h"
#include "game/people.h"
#include "game/shapes.h"
#include "player/player.h"
#include "world/transport.h"
#include "world/world.h"
#include <nlohmann/json.hpp>
#include <algorithm>

namespace sl {

// the catalogue's RNG: mulberry32 over hashStr (catalog.js), so the offers are the web game's
struct Rng { Mulberry32 m; explicit Rng(uint32_t s) : m(s) {} double operator()() { return m.next(); } };

namespace {
uint32_t hashStr(const std::string& s) {
  uint32_t h = 2166136261u;
  for (uint32_t cp : utf8Decode(s)) {
    if (cp >= 0x10000) {   // (charCodeAt: UTF-16 code units)
      uint32_t v = cp - 0x10000;
      for (uint32_t u : {0xD800u + (v >> 10), 0xDC00u + (v & 0x3ff)}) { h ^= u; h *= 16777619u; }
    } else { h ^= cp; h *= 16777619u; }
  }
  return h;
}
const char* GUESTS[16] = {"Anna", "Lukas", "Sofia", "Henrik", "Chlo\xC3\xA9", "Matteo", "Mia", "Jonas", "Elsa", "Tom", "Nina", "Yuki", "Priya", "Ben", "Lea", "Marta"};
const char* CHARS[6] = {"skier_blue", "skier_red", "skier_green", "skier_orange", "skier_black", "skier_purple"};
struct Skill { const char* id; double vmax, factor; const char* text; };
const Skill SKILLS[3] = {{"beginner", 9.5, 0.7, "new to skiing"}, {"steady", 13, 0.82, "a careful skier"}, {"strong", 17, 0.95, "a strong skier in a hurry"}};
struct Cargo { const char* key; const char* pack; const char* noun; const char* title; std::vector<std::string> kinds, from; const char* pool; bool perishable, toVillage; const char* crash; const char* late; };
const Cargo CARGO[9] = {
  {"fondue", "food", "fondue cheese", "Fondue cheese", {"hut"}, {"village"}, "supplies", false, false, "The cheese took a tumble \xC2\xB7 the kitchen sent for more", "Too late \xC2\xB7 the kitchen made do without the cheese"},
  {"bread", "food", "bread", "Fresh bread", {"hut"}, {"village", "hut"}, "supplies", false, false, "The bread got squashed in the tumble", "Too late \xC2\xB7 the bread went stale"},
  {"cocoa", "food", "hot chocolate", "Hot chocolate", {"lift", "patrol", "race", "park"}, {"hut", "top"}, "supplies", true, false, "The hot chocolate got cold", "The hot chocolate got cold"},
  {"mail", "mail", "mail bag", "Mail bag", {"board"}, {"hut", "top"}, "supplies", false, true, "The mail bag burst in the tumble \xC2\xB7 the postman will sort it out", "Too late \xC2\xB7 the post already left"},
  {"firstaid", "patrol", "first-aid kit", "First-aid kit", {"patrol"}, {"village", "hut", "top"}, "service", false, false, "The first-aid kit was lost in the tumble", "Too late \xC2\xB7 the patrol borrowed a kit"},
  {"radio", "patrol", "radio batteries", "Radio batteries", {"patrol"}, {"village", "hut", "top"}, "service", false, false, "The batteries scattered in the snow", "Too late \xC2\xB7 the radios went flat"},
  {"part", "tools", "spare part", "Spare part", {"lift"}, {"village", "hut", "top"}, "service", false, false, "The spare part is somewhere in the snow now", "Too late \xC2\xB7 maintenance found a spare"},
  {"bibs", "race", "race bibs", "Race bibs", {"race"}, {"village", "hut", "top"}, "service", false, false, "The bibs scattered across the slope", "Too late \xC2\xB7 the race started without bibs"},
  {"shovels", "tools", "shovels", "Park shovels", {"park"}, {"village", "hut", "top"}, "service", false, false, "The shovels went flying \xC2\xB7 the crew will manage", "Too late \xC2\xB7 the crew borrowed shovels"},
};
const Cargo* cargoOf(const std::string& k) { for (auto& c : CARGO) if (k == c.key) return &c; return nullptr; }
const char* roleChar(const std::string& r) {
  if (r == "patrol" || r == "starter") return "skier_black";
  if (r == "operator") return "skier_orange";
  if (r == "crew") return "skier_purple";
  if (r == "chef") return "skier_green";
  return nullptr;
}
bool has(const std::vector<std::string>& v, const std::string& s) { return std::find(v.begin(), v.end(), s) != v.end(); }
double round10(double v) { return std::round(v / 10) * 10; }
double round15(double v) { return std::ceil(v / 15) * 15; }
std::string shortOf(const JobDest& d) {
  if (d.kind == "board") return d.hubId == "village" ? "the village" : d.place;
  if (d.kind == "patrol") return d.peak + " patrol";
  if (d.kind == "lift") return d.lift + (d.top ? " top" : " base");
  if (d.kind == "race") return d.race + " start";
  return d.label;
}
std::string charFor(Rng& rnd, const std::string& role) {
  if (const char* w = roleChar(role)) return w;
  return CHARS[size_t(std::floor(rnd() * 6)) % 6];
}
// taxi.js TARIFF
constexpr double FLAG = 60, PER_KM = 180, CLIMB = 15, FARE_MIN = 150, FARE_MAX = 2200, PICK_R = 16, DROP_R = 20, STOP_V = 1.6;
constexpr double HAND_R = 3.2, HELP_R = 3.0, ARRIVE_R = 5, DOWN_R = 22, DOWN_GUEST_R = 34, TOW_VMAX = 19, TOW_ROUGH = 6, BOARD_R = 2.6;
} // namespace

Jobs::Jobs(PlayCtx& c) : c_(c) {}

int Jobs::done() const {
  const nlohmann::json& sj = c_.save->data("jobs");
  return sj.value("done", 0);
}

// ---------------------------------------------------------------- the router (jobs/sites.js Router)
double Jobs::direct(double ax, double az, double bx, double bz) const {
  double d = std::hypot(bx - ax, bz - az);
  if (d < 1) return 0;
  double dh = c_.world->height(bx, bz) - c_.world->height(ax, az);
  if (dh < -0.06 * d - 10) return d * 1.35 / 10 + 10;
  if (dh < 0.04 * d + 8) return d < 200 ? d / 2.5 : 80 + (d - 200) / 5;
  return d / 1.2 + dh * 3;
}
double Jobs::estimate(double ax, double az, double bx, double bz) const {
  double best = direct(ax, az, bx, bz);
  for (const RouterLift& l : c_.data->routerLifts) {
    double ride = l.len / (l.gondola ? 12 : 4.5) + 25;
    best = std::min(best, direct(ax, az, l.bottom.x, l.bottom.y) + ride + direct(l.topExit.x, l.topExit.y, bx, bz));
    if (l.gondola) best = std::min(best, direct(ax, az, l.top.x, l.top.y) + ride + direct(l.bottomExit.x, l.bottomExit.y, bx, bz));
  }
  return best;
}

bool Jobs::descentFor(const JobSpot& s, JobDest& out) const {
  double h0 = c_.world->height(s.x, s.z);
  bool hasEnd = false;
  dvec2 end(0);
  for (auto& [name, pts] : c_.pistes)
    if (name == s.piste && pts.size() > 1) {
      dvec2 a = pts.front(), b = pts.back();
      end = c_.world->height(a.x, a.y) < c_.world->height(b.x, b.y) ? a : b;
      hasEnd = true;
      break;
    }
  const JobDest* best = nullptr;
  double bs = 1e30;
  for (const JobDest& d : c_.data->dests) {
    bool ok = (d.kind == "lift" && !d.top) || (d.kind == "board" && d.hubId == "village") || d.kind == "hut";
    if (!ok) continue;
    double dist = std::hypot(d.x - s.x, d.z - s.z), dh = c_.world->height(d.x, d.z) - h0;
    if (dist < 120 || dist > 2600 || dh > -25 || dh > -0.06 * dist - 10) continue;
    double score = dist + (hasEnd ? std::hypot(d.x - end.x, d.z - end.y) * 1.5 : 0);
    if (score < bs) { bs = score; best = &d; }
  }
  if (!best) return false;
  out = *best;
  if (best->kind == "board") { out.label = "Legacy Village"; out.to = "Legacy Village"; }
  return true;
}

// ---------------------------------------------------------------- catalog.js generateOffers
std::unique_ptr<Jobs::Offer> Jobs::makeOffer(const JobHub& hub, const std::string& type, int slot, Rng& rnd) {
  const PlayData& D = *c_.data;
  auto pickIdx = [&](size_t n) { return size_t(std::floor(rnd() * double(n))) % n; };
  auto est = [&](double x, double z) { return estimate(hub.fx, hub.fz, x, z); };
  if (type == "delivery") {
    std::string pool = slot == 0 ? "supplies" : "service";
    std::vector<std::pair<const Cargo*, const JobDest*>> cands;
    for (const Cargo& cg : CARGO) {
      if (pool != cg.pool || !has(cg.from, hub.kind)) continue;
      for (const JobDest& d : D.dests) {
        if (!has(cg.kinds, d.kind) || d.id == "board:" + hub.id) continue;
        if (d.kind == "board" && (!cg.toVillage || d.hubId != "village")) continue;
        if (hub.hut && d.kind == "hut" && d.place == hub.name) continue;
        if (std::hypot(d.x - hub.fx, d.z - hub.fz) < 100) continue;
        cands.push_back({&cg, &d});
      }
    }
    if (cands.empty()) return nullptr;
    for (int t = 0; t < 14; t++) {
      auto [cg, d] = cands[pickIdx(cands.size())];
      double e = est(d->x, d->z);
      if (e < 45 || e > (cg->perishable ? 300 : 540)) continue;
      auto o = std::make_unique<Offer>();
      o->type = "delivery"; o->cargo = cg->key;
      o->reward = int(round10(clamp(60 + e * 2.4 + (cg->perishable ? 60 : 0), 200, 1300)));
      o->dest = *d;
      if (d->npc) o->guestChar = charFor(rnd, d->role);
      o->title = std::string(cg->title) + " to " + shortOf(*d); o->shortT = cg->title;
      o->client = d->kind == "hut" ? d->place + " kitchen" : cg->key == std::string("firstaid") || cg->key == std::string("radio") ? "Ski patrol" : cg->key == std::string("part") ? "Lift maintenance" : cg->key == std::string("bibs") ? "Race office" : cg->key == std::string("shovels") ? "Park crew" : hub.name;
      o->brief = std::string("Bring the ") + cg->noun + " to " + (d->to.empty() ? shortOf(*d) : d->to) + ".";
      o->bonus = int(round10(o->reward * 0.3)); o->est = int(std::round(e));
      o->par = int(std::round(e * (cg->perishable ? 0.8 : 0.9))); o->limit = int(round15(e * (cg->perishable ? 1.35 : 1.7) + 45));
      return o;
    }
    return nullptr;
  }
  if (type == "rescue") {
    std::vector<const JobSpot*> near;
    for (const JobSpot& s : D.spots) { double d = std::hypot(s.x - hub.fx, s.z - hub.fz); if (d < 3200 && d > 150) near.push_back(&s); }
    if (near.empty()) return nullptr;
    for (int t = 0; t < 14; t++) {
      const JobSpot& s = *near[pickIdx(near.size())];
      double e = est(s.x, s.z);
      if (e < 50 || e > 480) continue;
      JobDest down;
      if (!descentFor(s, down)) continue;
      double eDown = estimate(s.x, s.z, down.x, down.z);
      if (eDown > 420) continue;
      std::string variant = rnd() < 0.6 ? "injured" : "stuck";
      std::string name = GUESTS[pickIdx(16)];
      auto o = std::make_unique<Offer>();
      o->type = "rescue"; o->variant = variant;
      o->reward = int(round10(clamp((200 + e * 2.6 + eDown * 3) * (variant == "injured" ? 1.25 : 1), 500, 2200)));
      o->title = variant == "injured" ? "Skier down \xC2\xB7 " + s.piste : "Stuck in the snow \xC2\xB7 " + s.piste;
      o->shortT = variant == "injured" ? "Skier down" : "Stuck skier";
      o->client = "Ski patrol";
      o->brief = variant == "injured" ? name + " went down beside the " + s.piste + " piste and hurt a knee. Get there fast, load them into the rescue sled and tow it down to " + down.to + ". Ski smoothly: a crash ends the rescue."
                                      : name + ", a beginner, came out of their skis in deep snow beside the " + s.piste + " piste. Help them back up and lead them down to " + down.to + ".";
      o->bonus = int(round10(o->reward * 0.25)); o->est = int(std::round(e)); o->estDown = int(std::round(eDown));
      o->par = int(std::round(e * 0.9)); o->limit = int(round15(e * 1.55 + 60));
      o->hasSpot = true; o->spot = s;
      o->spotSide = rnd() < 0.5 ? -1 : 1;
      o->guestChar = charFor(rnd, "guest");
      o->guestName = name;
      o->dest.kind = "spot"; o->dest.label = variant == "injured" ? "Injured skier" : "Stuck skier"; o->dest.x = s.x; o->dest.z = s.z;
      o->down = down;
      return o;
    }
    return nullptr;
  }
  if (type == "escort") {
    std::vector<const JobDest*> cands;
    for (const JobDest& d : D.dests) {
      if (!(d.kind == "hut" || d.kind == "board" || d.kind == "park")) continue;
      if (d.id == "board:" + hub.id || (hub.hut && d.kind == "hut" && d.place == hub.name) || std::hypot(d.x - hub.fx, d.z - hub.fz) <= 250) continue;
      cands.push_back(&d);
    }
    if (cands.empty()) return nullptr;
    for (int t = 0; t < 14; t++) {
      const JobDest& d = *cands[pickIdx(cands.size())];
      double e = est(d.x, d.z);
      if (e < 90 || e > 600) continue;
      const Skill& S = SKILLS[pickIdx(3)];
      std::string name = GUESTS[pickIdx(16)];
      double eg = e / S.factor;
      auto o = std::make_unique<Offer>();
      o->type = "escort"; o->skill = S.id; o->guestName = name;
      o->reward = int(round10(clamp(150 + eg * 2.5, 400, 1600)));
      std::string to = d.kind == "board" && d.hubId == "village" ? "Legacy Village" : d.kind == "board" ? d.place : d.to;
      o->title = "Guide " + name + " to " + shortOf(d); o->shortT = "Guiding " + name; o->client = "Ski school";
      o->brief = name + " is " + S.text + " and wants to get to " + to + ". Lead the way and keep " + name + " close: they follow your tracks at their own pace.";
      o->bonus = int(round10(o->reward * 0.3)); o->est = int(std::round(eg)); o->par = int(std::round(eg * 0.95)); o->limit = int(round15(eg * 1.7 + 90));
      o->guestChar = charFor(rnd, "guest");
      o->dest = d;
      return o;
    }
    return nullptr;
  }
  return nullptr;
}

std::vector<Jobs::Offer> Jobs::offers(const JobHub& hub) {
  nlohmann::json& sj = c_.save->data("jobs");
  int day = c_.save->day;
  if (sj.value("day", 0) != day) { sj["day"] = day; sj["gens"] = nlohmann::json::object(); }
  nlohmann::json& gens = sj["gens"];
  if (!gens.is_object()) gens = nlohmann::json::object();
  std::vector<Offer> out;
  for (int slot = 0; slot < 3; slot++) {
    int gen = gens.contains(hub.id) && gens[hub.id].is_array() && gens[hub.id].size() > size_t(slot) ? gens[hub.id][size_t(slot)].get<int>() : 0;
    std::string id = hub.id + "|" + std::to_string(day) + "|" + std::to_string(slot) + "|" + std::to_string(gen);
    Rng rnd(hashStr(id));
    double r = rnd();
    std::vector<std::string> order = slot == 0 ? std::vector<std::string>{"delivery"} : slot == 1 ? std::vector<std::string>{"rescue", "delivery"}
                                   : r < 0.55 ? std::vector<std::string>{"escort", "delivery"} : std::vector<std::string>{"delivery", "escort"};
    std::unique_ptr<Offer> o;
    for (auto& t : order) { o = makeOffer(hub, t, slot, rnd); if (o) break; }
    if (!o) continue;
    o->id = id; o->board = hub.id; o->slot = slot; o->gen = gen;
    out.push_back(*o);
  }
  return out;
}

// ---------------------------------------------------------------- boards, taking a job
void Jobs::openBoard(const JobHub& hub) {
  Dialog d;
  d.kicker = "Job board \xC2\xB7 " + hub.name;
  d.title = "Jobs";
  std::string hid = hub.id;
  d.rebuild = [this, hid](Dialog& D) {
    const JobHub* h = nullptr;
    for (auto& x : c_.data->hubs) if (x.id == hid) h = &x;
    if (!h) return;
    D.options.clear();
    if (job_) D.say = "You are on a job: " + job_->title + ". Finish it first (or drop it here).";
    else D.say = "Odd jobs round the resort. They pay well, quick and careful earns a tip.";
    if (!job_)
      for (const Offer& o : offers(*h)) {
        DialogOption op;
        op.label = o.title;
        op.sub = o.client + " \xC2\xB7 " + std::to_string(std::max(1, int(std::round((o.limit + o.estDown * 1.5) / 60.0)))) + " min" + (o.bonus ? " \xC2\xB7 + up to " + fmtMoney(o.bonus) + " tip" : "");
        op.state = fmtMoney(o.reward);
        Offer copy = o;
        op.act = [this, copy]() { accept(copy); };
        D.options.push_back(op);
      }
    else {
      DialogOption dr; dr.label = "Drop the job"; dr.sub = job_->title;
      dr.act = [this]() { drop(); c_.flash("Job dropped", 0); };
      D.options.push_back(dr);
    }
    // the TAXI note (taxi.js: only with a car of your own)
    DialogOption tx;
    bool car = !c_.save->garage.empty();
    tx.label = taxiOn_ ? "TAXI \xC2\xB7 end your shift" : "TAXI \xC2\xB7 drive fares in your car";
    tx.sub = car ? "Flag fall $60 + $180 a km \xC2\xB7 tips for quick, smooth rides" : "Needs a car of your own (the Autohaus)";
    tx.disabled = !car || (job_ && !taxiOn_);
    tx.act = [this]() { if (taxiOn_) endTaxi("Shift ended"); else startTaxi(); };
    D.options.push_back(tx);
    DialogOption n; n.label = "Close"; n.secondary = true;
    D.options.push_back(n);
  };
  c_.menus->openDialog(d);
}

bool Jobs::accept(const Offer& o) {
  if (job_) return false;
  job_ = std::make_unique<Offer>(o);
  elapsed_ = 0; phase_ = 0; roughT_ = 0; lostT_ = 0;
  trail_.clear();
  guestPos_ = c_.player->pos; guestYaw_ = c_.player->heading; guestV_ = 0;
  nlohmann::json& sj = c_.save->data("jobs");
  sj["v"] = 1;
  sj["active"] = {{"id", o.id}, {"type", o.type}, {"title", o.title}, {"reward", o.reward}, {"board", o.board}, {"slot", o.slot}, {"day", c_.save->day}};
  c_.save->markDirty();
  c_.flash("Job taken \xC2\xB7 " + o.shortT, 0);
  if (c_.mark) c_.mark(o.dest.x, o.dest.z, o.dest.label.empty() ? shortOf(o.dest) : o.dest.label);
  SL_INFO("jobs: took '%s' (%s, $%d, limit %d s, to %s at %.0f, %.0f)", o.title.c_str(), o.type.c_str(), o.reward, o.limit, o.dest.label.c_str(), o.dest.x, o.dest.z);
  return true;
}

void Jobs::endJob() {
  if (!job_) return;
  nlohmann::json& sj = c_.save->data("jobs");
  if (sj.value("day", 0) == c_.save->day) {
    nlohmann::json& g = sj["gens"][job_->board];
    if (!g.is_array() || g.size() < 3) g = {0, 0, 0};
    g[size_t(job_->slot)] = g[size_t(job_->slot)].get<int>() + 1;
  }
  sj["active"] = nullptr;
  job_.reset();
  if (c_.unmark) c_.unmark();
  c_.save->markDirty();
}

void Jobs::complete() {
  int tip = 0;
  if (job_->bonus && job_->par) {
    double k = elapsed_ <= job_->par ? 1 : clamp((job_->limit - elapsed_) / std::max(1.0, double(job_->limit - job_->par)), 0, 1);
    tip = int(std::round(job_->bonus * k / 5) * 5);
  }
  int total = job_->reward + tip;
  nlohmann::json& sj = c_.save->data("jobs");
  sj["done"] = sj.value("done", 0) + 1;
  sj["earned"] = sj.value("earned", 0) + total;
  std::string pay = tip ? fmtMoney(job_->reward) + " + " + fmtMoney(tip) + " tip" : "+" + fmtMoney(total);
  std::string text = job_->type == "delivery" ? "Delivered \xC2\xB7 " + pay : job_->type == "rescue" ? job_->guestName + " is safe at " + shortOf(job_->down) + " \xC2\xB7 " + pay : job_->guestName + " arrived \xC2\xB7 " + pay;
  SL_INFO("jobs: done '%s' in %.0f s: $%d", job_->title.c_str(), elapsed_, total);
  endJob();
  c_.earn(total);
  c_.flash(text, 2);
}

void Jobs::fail(const std::string& reason) {
  if (!job_) return;
  std::string text = "Job cancelled";
  if (job_->type == "delivery") { const Cargo* cg = cargoOf(job_->cargo); text = !cg ? text : reason == "late" ? cg->late : reason == "crash" ? cg->crash : std::string("Job dropped \xC2\xB7 someone else took the ") + cg->noun; }
  else if (job_->type == "rescue") text = phase_ == 1 ? (reason == "crash" ? "Rescue failed \xC2\xB7 you crashed" : reason == "late" ? "Too slow \xC2\xB7 the ski patrol took " + job_->guestName + " down" : reason == "rough" ? "Too rough a ride for " + job_->guestName + " \xC2\xB7 the ski patrol took over" : "The ski patrol took over the rescue")
                                              : reason == "late" ? "The ski patrol reached the skier first" : reason == "crash" ? "You took a tumble yourself \xC2\xB7 the patrol has it covered" : "The ski patrol took over the rescue";
  else if (job_->type == "escort") text = reason == "late" ? job_->guestName + " gave up and took the ski bus" : reason == "lost" ? job_->guestName + " lost sight of you and headed back" : job_->guestName + " made it down safely on their own";
  nlohmann::json& sj = c_.save->data("jobs");
  sj["failed"] = sj.value("failed", 0) + 1;
  endJob();
  c_.flash(text, 1);
}

void Jobs::drop() { if (job_) fail("dropped"); }
void Jobs::onCrash() {
  if (!job_) return;
  if (job_->type == "delivery" || (job_->type == "rescue" && phase_ == 1)) fail("crash");
}

dvec3 Jobs::destPoint() const {
  if (!job_) return dvec3(0);
  if (job_->type == "rescue" && phase_ == 1) return dvec3(job_->down.x, 0, job_->down.z);
  return dvec3(job_->dest.x, 0, job_->dest.z);
}

bool Jobs::interact(std::string& prompt, bool pressed) {
  if (!c_.data) return false;
  const dvec3& p = c_.player->pos;
  // a job's own spot first: the hand-over, the skier in the snow
  if (job_) {
    dvec3 d = destPoint();
    double dist = std::hypot(p.x - d.x, p.z - d.z);
    if (job_->type == "delivery" && dist < HAND_R + (job_->dest.npc ? 0 : 0.4)) {
      prompt = "Hand over the " + std::string(cargoOf(job_->cargo) ? cargoOf(job_->cargo)->noun : "parcel");
      if (pressed) complete();
      return true;
    }
    if (job_->type == "rescue" && phase_ == 0 && dist < HELP_R + 1) {
      prompt = job_->variant == "injured" ? "Load " + job_->guestName + " into the rescue sled" : "Help " + job_->guestName + " up";
      if (pressed) {
        phase_ = 1;
        guestPos_ = dvec3(job_->spot.x, c_.world->height(job_->spot.x, job_->spot.z), job_->spot.z);
        sledPos_ = guestPos_;
        trail_.clear();
        if (c_.mark) c_.mark(job_->down.x, job_->down.z, shortOf(job_->down));
        c_.flash(job_->variant == "injured" ? "Tow the akja down to " + shortOf(job_->down) + " \xC2\xB7 ski smoothly" : "Lead " + job_->guestName + " down to " + shortOf(job_->down), 0);
      }
      return true;
    }
  }
  for (const JobHub& h : c_.data->hubs) {
    if (std::hypot(p.x - h.fx, p.z - h.fz) < BOARD_R) {
      prompt = "Job board \xC2\xB7 " + h.name;
      if (pressed) openBoard(h);
      return true;
    }
  }
  return false;
}

void Jobs::update(double dt) {
  // ---- the taxi
  if (taxiOn_) {
    Drive& dr = *c_.drive;
    if (fare_.stage == Fare::Stage::None && c_.now >= nextFareT_ && !c_.data->taxi.empty()) {
      // the dispatcher: a pickup among the nearer places (not right here), the destination well away from it
      const dvec3 p = c_.driving ? dr.pos() : c_.player->pos;
      std::vector<int> nearI;
      for (size_t i = 0; i < c_.data->taxi.size(); i++) { double d = std::hypot(c_.data->taxi[i].x - p.x, c_.data->taxi[i].z - p.z); if (d > 120 && d < 2500) nearI.push_back(int(i)); }
      if (nearI.empty()) for (size_t i = 0; i < c_.data->taxi.size(); i++) nearI.push_back(int(i));
      std::sort(nearI.begin(), nearI.end(), [&](int a, int b) { return std::hypot(c_.data->taxi[size_t(a)].x - p.x, c_.data->taxi[size_t(a)].z - p.z) < std::hypot(c_.data->taxi[size_t(b)].x - p.x, c_.data->taxi[size_t(b)].z - p.z); });
      int from = nearI[size_t(rnd() * std::min<size_t>(4, nearI.size())) % nearI.size()];
      int to = -1;
      for (int t = 0; t < 20 && to < 0; t++) { int k = int(rnd() * c_.data->taxi.size()) % int(c_.data->taxi.size()); const auto& a = c_.data->taxi[size_t(from)]; const auto& b = c_.data->taxi[size_t(k)]; if (k != from && std::hypot(a.x - b.x, a.z - b.z) > 900) to = k; }
      if (to < 0) to = (from + 1) % int(c_.data->taxi.size());
      fare_ = Fare{};
      fare_.stage = Fare::Stage::Waiting; fare_.from = from; fare_.to = to;
      fare_.name = GUESTS[size_t(rnd() * 16) % 16];
      const auto& a = c_.data->taxi[size_t(from)];
      fare_.walkPos = dvec3(a.sx, c_.world->height(a.sx, a.sz), a.sz);
      if (c_.mark) c_.mark(a.x, a.z, "Taxi: " + fare_.name);
      c_.flash("Dispatch: " + fare_.name + " is waiting at " + a.name, 0);
    }
    if (fare_.stage != Fare::Stage::None && fare_.from >= 0) {
      const auto& A = c_.data->taxi[size_t(fare_.from)];
      const auto& B = c_.data->taxi[size_t(fare_.to)];
      fare_.t += dt;
      dvec3 cp = dr.pos();
      bool stopped = c_.driving && dr.speed() < STOP_V;
      if (fare_.stage == Fare::Stage::Waiting) {
        if (stopped && std::hypot(cp.x - fare_.walkPos.x, cp.z - fare_.walkPos.z) < PICK_R) { fare_.stage = Fare::Stage::Boarding; fare_.t = 0; say_ = "Hi! Thanks for coming."; sayT_ = c_.now; }
        else if (fare_.t > 420) { c_.flash(fare_.name + " gave up waiting and took the bus", 1); fare_ = Fare{}; nextFareT_ = c_.now + 8; }
      } else if (fare_.stage == Fare::Stage::Boarding) {
        // walking round the car to the back door
        dvec3 door = cp + dvec3(std::cos(dr.yaw()) * -1.4, 0, -std::sin(dr.yaw()) * -1.4);
        dvec3 d = door - fare_.walkPos;
        double L = glm::length(dvec2(d.x, d.z));
        if (L > 0.4) { fare_.walkPos += d / std::max(L, 1e-6) * std::min(L, 1.5 * dt); fare_.walkPos.y = c_.world->groundHeight(fare_.walkPos.x, fare_.walkPos.z, fare_.walkPos.y + 1); }
        if (L <= 0.4 || fare_.t > 12) {
          fare_.stage = Fare::Stage::Aboard; fare_.rideT = 0; fare_.startY = cp.y;
          double km = std::hypot(A.x - B.x, A.z - B.z) * 1.3 / 1000;
          fare_.km = km;
          fare_.limit = std::round((km * 1000 / 12.5 + 25) * 1.6 + 45);
          say_ = B.name + ", please."; sayT_ = c_.now;
          if (c_.mark) c_.mark(B.x, B.z, B.name);
        }
      } else if (fare_.stage == Fare::Stage::Aboard) {
        fare_.rideT += dt;
        if (!fare_.late && fare_.rideT > fare_.limit) { fare_.late = true; say_ = "We are late. I said I was in a hurry!"; sayT_ = c_.now; }
        if (!c_.driving) {
          if (std::hypot(c_.player->pos.x - B.x, c_.player->pos.z - B.z) > DROP_R * 2) { c_.flash(fare_.name + ": You are leaving me HERE? Forget the fare.", 1); fare_ = Fare{}; nextFareT_ = c_.now + 10; }
        } else if (stopped && std::hypot(cp.x - B.x, cp.z - B.z) < DROP_R) {
          double climb = std::max(0.0, c_.world->height(B.x, B.z) - c_.world->height(A.x, A.z));
          double fare = clamp(FLAG + PER_KM * fare_.km + CLIMB * climb / 100, FARE_MIN, FARE_MAX);
          double tip = 0;
          if (fare_.crash) fare *= 0.5;
          else if (fare_.late) fare *= 0.75;
          else {
            if (fare_.rideT < fare_.limit * 0.7) tip += fare * 0.1;
            if (fare_.knocks == 0) tip += fare * 0.1;
          }
          int total = int(std::round((fare + tip) / 5) * 5);
          nlohmann::json& sj = c_.save->data("jobs");
          sj["done"] = sj.value("done", 0) + 1; sj["earned"] = sj.value("earned", 0) + total;
          nlohmann::json& tx = c_.save->data("taxi");
          tx["fares"] = tx.value("fares", 0) + 1; tx["earned"] = tx.value("earned", 0) + total;
          c_.earn(total);
          const char* line = fare_.crash ? "You crashed! I am not paying full fare." : fare_.late ? "That took forever..." : tip > fare * 0.15 ? "Wow, you got me there fast! And so smooth!" : tip > 0 ? "Thanks, smooth ride!" : "Thanks for the ride.";
          c_.flash(fare_.name + ": " + line + "  +" + fmtMoney(total), 2);
          SL_INFO("taxi: fare %s -> %s, %.1f km, %.0f s: $%d", A.name.c_str(), B.name.c_str(), fare_.km, fare_.rideT, total);
          fare_.stage = Fare::Stage::Leaving; fare_.t = 0;
          fare_.walkPos = cp + dvec3(std::cos(dr.yaw()) * -1.4, 0, -std::sin(dr.yaw()) * -1.4);
          nextFareT_ = c_.now + 6;
          if (c_.unmark) c_.unmark();
        }
      } else if (fare_.stage == Fare::Stage::Leaving) {
        fare_.walkPos.x += std::sin(fare_.t) * 0.0 + 1.2 * dt;
        fare_.walkPos.y = c_.world->groundHeight(fare_.walkPos.x, fare_.walkPos.z, fare_.walkPos.y + 1);
        if (fare_.t > 8) fare_ = Fare{};
      }
    }
  }
  // ---- the job
  if (!job_) return;
  Player& pl = *c_.player;
  elapsed_ += dt;
  if (elapsed_ > job_->limit + (phase_ == 1 ? job_->estDown * 1.5 : 0)) { fail("late"); return; }
  if (job_->type == "escort" || (job_->type == "rescue" && phase_ == 1)) {
    // the guest skis your tracks (jobs/actors.js Follower, condensed): your trail every 2 m, at their own pace
    if (trail_.empty() || glm::length(pl.pos - trail_.back()) > 2) trail_.push_back(pl.pos);
    if (trail_.size() > 400) trail_.erase(trail_.begin());
    double vmax = 13;
    for (auto& s : SKILLS) if (job_->skill == s.id) vmax = s.vmax;
    if (job_->type == "rescue") vmax = job_->variant == "injured" ? 40 : 9.5;
    if (job_->type == "rescue" && job_->variant == "injured") {
      // the akja on its rope behind you (TOW_ROPE 3.4 m)
      dvec3 back = pl.pos - dvec3(std::sin(pl.heading), 0, std::cos(pl.heading)) * 3.4;
      sledPos_ = glm::mix(sledPos_, back, std::min(1.0, dt * 6));
      sledPos_.y = c_.world->groundHeight(sledPos_.x, sledPos_.z, pl.pos.y + 1);
      guestPos_ = sledPos_;
      roughT_ = pl.speed() > TOW_VMAX ? roughT_ + dt : std::max(0.0, roughT_ - dt);
      if (roughT_ > TOW_ROUGH) { fail("rough"); return; }
    } else {
      // walk the trail toward you
      size_t k = 0;
      double bd = 1e18;
      for (size_t i = 0; i < trail_.size(); i++) { double d = glm::length(trail_[i] - guestPos_); if (d < bd) { bd = d; k = i; } }
      dvec3 tgt = k + 1 < trail_.size() ? trail_[k + 1] : pl.pos;
      dvec3 d = tgt - guestPos_;
      double L = glm::length(dvec2(d.x, d.z));
      double gap = glm::length(pl.pos - guestPos_);
      double want = gap > 6 ? vmax : gap * 0.5;
      guestV_ += (want - guestV_) * std::min(1.0, dt * 1.5);
      if (L > 0.01) { guestPos_ += dvec3(d.x, 0, d.z) / L * std::min(L, guestV_ * dt); guestYaw_ = std::atan2(d.x, d.z); }
      guestPos_.y = c_.world->groundHeight(guestPos_.x, guestPos_.z, guestPos_.y + 1.5);
      lostT_ = gap > 150 ? lostT_ + dt : 0;
      if (lostT_ > 20) { fail("lost"); return; }
    }
    dvec3 d = destPoint();
    double dist = std::hypot(pl.pos.x - d.x, pl.pos.z - d.z), gdist = std::hypot(guestPos_.x - d.x, guestPos_.z - d.z);
    if (job_->type == "escort" && dist < ARRIVE_R + 2 && gdist < DOWN_GUEST_R) { complete(); return; }
    if (job_->type == "rescue" && dist < DOWN_R && gdist < DOWN_GUEST_R) { complete(); return; }
  }
}

void Jobs::addPeople(People& people, const dvec3& cam) const {
  auto kindOf = [&](const std::string& ch) { int k = people.kind(ch); return k >= 0 ? k : people.skierKinds.empty() ? 0 : people.skierKinds[0]; };
  if (job_) {
    if (job_->type == "delivery" && job_->dest.npc) {
      Person p; p.kind = kindOf(job_->guestChar.empty() ? "skier_green" : job_->guestChar);
      p.pos = dvec3(job_->dest.x, c_.world->height(job_->dest.x, job_->dest.z), job_->dest.z); p.yaw = job_->dest.yaw; p.anim = PAnim::Idle; p.phase = c_.now;
      if (glm::length(p.pos - cam) < 250) people.add(p);
    }
    if (job_->type == "rescue") {
      Person p; p.kind = kindOf(job_->guestChar);
      if (phase_ == 0) { p.pos = dvec3(job_->spot.x, c_.world->height(job_->spot.x, job_->spot.z), job_->spot.z); p.yaw = job_->spot.heading; p.anim = job_->variant == "injured" ? PAnim::Lie : PAnim::Sit; }
      else { p.pos = guestPos_; p.yaw = c_.player->heading; p.anim = job_->variant == "injured" ? PAnim::Lie : PAnim::Ski; p.skis = job_->variant != "injured"; if (job_->variant == "injured") p.pos.y += 0.25; }
      if (glm::length(p.pos - cam) < 300) people.add(p);
    }
    if (job_->type == "escort") {
      Person p; p.kind = kindOf(job_->guestChar); p.pos = guestPos_; p.yaw = guestYaw_;
      bool walk = c_.player->mode == PlayerMode::Walk;
      p.anim = guestV_ < 0.5 ? PAnim::Idle : walk ? PAnim::Walk : PAnim::Ski; p.skis = !walk; p.phase = c_.now;
      people.add(p);
    }
  }
  if (taxiOn_ && (fare_.stage == Fare::Stage::Waiting || fare_.stage == Fare::Stage::Boarding || fare_.stage == Fare::Stage::Leaving) && !people.fanKinds.empty()) {
    Person p; p.kind = people.fanKinds[size_t(fare_.from + 3) % people.fanKinds.size()];
    p.pos = fare_.walkPos;
    p.anim = fare_.stage == Fare::Stage::Waiting ? PAnim::Wave : PAnim::Walk; p.phase = c_.now * 1.3;
    p.yaw = fare_.stage == Fare::Stage::Waiting ? std::atan2(c_.player->pos.x - p.pos.x, c_.player->pos.z - p.pos.z) : 0;
    people.add(p);
  }
}

void Jobs::draw(Renderer& r, const dvec3& cam, const Model* board) {
  if (!c_.data) return;
  if (board) {
    static mat4 fit = board->fitTransform(1.62f, 0);
    for (const JobHub& h : c_.data->hubs) {
      dvec3 p(h.x, c_.world->height(h.x, h.z), h.z);
      if (glm::length(p - cam) > 400 || !r.visible(p - dvec3(1.5, 0, 1.5), p + dvec3(1.5, 2.5, 1.5))) continue;
      r.submitModel(*board, p, glm::rotate(mat4(1), float(h.yaw), vec3(0, 1, 0)) * fit, nullptr, glm::length(p - cam) < 80);
    }
  }
  Shapes& sh = *c_.shapes;
  if (job_) {
    // the parcel on your back (props.js packGeometry: the cargo's colours)
    if (job_->type == "delivery" && c_.player->mode != PlayerMode::Sit) {
      const Player& pl = *c_.player;
      dvec3 back = pl.renderPos + dvec3(-std::sin(pl.heading) * 0.22, 1.25, -std::cos(pl.heading) * 0.22);
      const Cargo* cg = cargoOf(job_->cargo);
      std::string pk = cg ? cg->pack : "food";
      vec4 col = pk == "mail" ? vec4(0.79f, 0.45f, 0.008f, 1) : pk == "patrol" ? vec4(0.56f, 0.025f, 0.016f, 1) : pk == "tools" ? vec4(0.04f, 0.05f, 0.065f, 1) : pk == "race" ? vec4(0.015f, 0.11f, 0.67f, 1) : vec4(0.58f, 0.03f, 0.013f, 1);
      sh.box(r, back - dvec3(0, 0.2, 0), pl.heading, vec3(0.31f, 0.4f, 0.15f), col);
    }
    // the destination ring and a soft glow pillar (props.js makeRing / makeGlint)
    dvec3 d = destPoint();
    d.y = c_.world->height(d.x, d.z);
    if (glm::length(d - cam) < 900) sh.cylinder(r, d, 1.2, 30, vec4(1.0f, 0.75f, 0.2f, 0.22f), 2.5f, false);
    if (job_->type == "rescue" && phase_ == 0) {   // the crossed skis and the red akja beside the casualty
      dvec3 s(job_->spot.x, c_.world->height(job_->spot.x, job_->spot.z), job_->spot.z);
      sh.box(r, s + dvec3(1.6, 0, 0.5), 0.6, vec3(0.08f, 1.7f, 0.04f), vec4(0.7f, 0.05f, 0.05f, 1));
      sh.box(r, s + dvec3(1.6, 0, 0.5), -0.6, vec3(0.08f, 1.7f, 0.04f), vec4(0.7f, 0.05f, 0.05f, 1));
    }
    if (job_->type == "rescue" && phase_ == 1 && job_->variant == "injured") sh.box(r, sledPos_, c_.player->heading, vec3(0.7f, 0.3f, 2.1f), vec4(0.75f, 0.06f, 0.04f, 1));
  }
  if (taxiOn_ && fare_.stage == Fare::Stage::Aboard && fare_.to >= 0) {
    const auto& B = c_.data->taxi[size_t(fare_.to)];
    dvec3 d(B.x, c_.world->height(B.x, B.z), B.z);
    if (glm::length(d - cam) < 1500) sh.cylinder(r, d, 2.0, 40, vec4(1.0f, 0.85f, 0.1f, 0.22f), 2.5f, false);
  }
}

std::string Jobs::objective() const {
  if (job_) {
    int left = int(std::max(0.0, job_->limit + (phase_ == 1 ? job_->estDown * 1.5 : 0) - elapsed_));
    char t[32]; std::snprintf(t, sizeof t, "%d:%02d", left / 60, left % 60);
    std::string where = job_->type == "rescue" && phase_ == 1 ? shortOf(job_->down) : job_->dest.label.empty() ? shortOf(job_->dest) : shortOf(job_->dest);
    return job_->shortT + " \xC2\xB7 " + where + " \xC2\xB7 " + t;
  }
  if (taxiOn_) {
    if (fare_.stage == Fare::Stage::Waiting) return "Taxi \xC2\xB7 pick up " + fare_.name + " at " + c_.data->taxi[size_t(fare_.from)].name;
    if (fare_.stage == Fare::Stage::Aboard) {
      int left = int(std::max(0.0, fare_.limit - fare_.rideT));
      char t[32]; std::snprintf(t, sizeof t, "%d:%02d", left / 60, left % 60);
      return "Taxi \xC2\xB7 " + fare_.name + " to " + c_.data->taxi[size_t(fare_.to)].name + " \xC2\xB7 " + t;
    }
    return "Taxi \xC2\xB7 on duty \xC2\xB7 " + c_.K(Action::Duty) + " ends the shift";
  }
  return "";
}

void Jobs::hud(Ui& ui, float u) {
  if (!say_.empty() && c_.now - sayT_ < 3.5) {
    float W = float(ui.width()), H = float(ui.height());
    ui.text(W / 2, H * 0.72f, 18 * u, UiFont::CondItalic, ui_color::white, "\xE2\x80\x9C" + say_ + "\xE2\x80\x9D", UiAlign::Center);
  }
}

// ---------------------------------------------------------------- the taxi
void Jobs::startTaxi() {
  if (c_.save->garage.empty()) { c_.flash("You need a car of your own for the taxi (the Autohaus)", 1); return; }
  if (job_) { c_.flash("Finish your job first", 1); return; }
  taxiOn_ = true;
  fare_ = Fare{};
  nextFareT_ = c_.now + 2;
  c_.flash("On duty \xC2\xB7 LEGACY TAXI \xC2\xB7 get in your car and wait for the dispatcher", 0);
}
void Jobs::endTaxi(const char* why) {
  if (!taxiOn_) return;
  taxiOn_ = false;
  if (fare_.stage == Fare::Stage::Aboard) c_.flash(fare_.name + " gets out without paying", 1);
  fare_ = Fare{};
  if (c_.unmark) c_.unmark();
  c_.flash(std::string("Taxi \xC2\xB7 ") + why, 0);
}
void Jobs::onCarKnock(bool crash) {
  if (fare_.stage != Fare::Stage::Aboard) return;
  fare_.knocks++;
  if (crash) fare_.crash = true;
  say_ = crash ? "Are you trying to kill me?!" : "Hey, careful!"; sayT_ = c_.now;
}
void Jobs::policeChase() {
  if (taxiOn_ && (fare_.stage == Fare::Stage::Aboard || fare_.stage == Fare::Stage::Boarding)) {
    c_.flash(fare_.name + ": Police?! Let me out, NOW!", 1);
    fare_ = Fare{};
    nextFareT_ = c_.now + 60;
  }
}

} // namespace sl
