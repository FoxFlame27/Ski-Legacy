// The multiplayer session (see mp_session.h): session.js with the native game's glue.
#include "game/mp_session.h"
#include "core/log.h"
#include "game/economy.h"
#include "platform/platform.h"
#include <algorithm>
#include <chrono>
#include <cmath>

namespace sl {

namespace {
const char* ACCOUNTS_FILE = "ski-legacy-mp-accounts.json";
constexpr double PUSH_DELAY = 1.5;   // s: profile changes are pushed this long after the last save write
constexpr double DELAY = 120, MAX_DELAY = 400, EXTRAPOLATE = 250;   // ms (remote.js)
int64_t jnum(const Json& j, const char* k, int64_t def = 0) {
  auto it = j.find(k);
  return it != j.end() && it->is_number() ? int64_t(std::llround(it->get<double>())) : def;
}
double jdbl(const Json& j, const char* k, double def = 0) {
  auto it = j.find(k);
  return it != j.end() && it->is_number() ? it->get<double>() : def;
}
std::string jstr(const Json& j, const char* k, const std::string& def = "") {
  auto it = j.find(k);
  return it != j.end() && it->is_string() ? it->get<std::string>() : def;
}
}

// ---------------------------------------------------------------- remote players: the presence ring (remote.js Remote)
double RemotePlayer::delay() const {
  return std::min(MAX_DELAY, std::max(DELAY, (lag < 0 ? 0 : lag) + std::max(90.0, gap * 1.15 + lagDev * 2.5)));
}

void RemotePlayer::push(const Json& row, double now) {
  if (!row.is_array() || row.size() < 13) return;
  double ts = row[net::R::ts].is_number() ? row[net::R::ts].get<double>() : 0;
  if (ts <= lastTs) return;   // (out of order / duplicate)
  if (lastTs > 0) { double g = std::min(400.0, ts - lastTs); gap = g > gap ? gap * 0.7 + g * 0.3 : gap * 0.97 + g * 0.03; }
  lastTs = ts;
  double l = std::max(0.0, now - ts);
  if (lag < 0) lag = l;
  else { lagDev = lagDev * 0.92 + std::fabs(l - lag) * 0.08; lag = lag * 0.92 + l * 0.08; }
  head = (head + 1) % RING;
  Snap& s = ring[head];
  for (int i = 0; i < 12; i++) s.v[i] = row[size_t(i + 1)].is_number() ? row[size_t(i + 1)].get<double>() : 0;
  s.veh = row.size() > 13 && row[13].is_string() ? row[13].get<std::string>() : "";
  s.interior = row.size() > 14 && row[14].is_string() ? row[14].get<std::string>() : "";
  if (count < RING) count++;
}

// ---------------------------------------------------------------- lifecycle
Multiplayer::Multiplayer(MpHost h) : host(std::move(h)) {}
Multiplayer::~Multiplayer() { if (active_) leave(); }

double Multiplayer::clockSeconds() const {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------- the account (per server URL)
void Multiplayer::loadAccounts() {
  if (accountsLoaded_) return;
  accountsLoaded_ = true;
  std::vector<uint8_t> b;
  if (host.plat && host.plat->readSave(ACCOUNTS_FILE, b) && !b.empty()) {
    Json j = Json::parse(b.begin(), b.end(), nullptr, false);
    if (j.is_object()) accounts_ = j;
  }
}
std::optional<Multiplayer::Account> Multiplayer::account() const {
  const_cast<Multiplayer*>(this)->loadAccounts();
  auto it = accounts_.find(url);
  if (it == accounts_.end() || !it->is_object()) return std::nullopt;
  Account a{jstr(*it, "name"), jstr(*it, "token")};
  if (a.name.empty() || a.token.empty()) return std::nullopt;
  return a;
}
void Multiplayer::storeAccount(const std::optional<Account>& a) {
  loadAccounts();
  if (a) accounts_[url] = Json{{"name", a->name}, {"token", a->token}};
  else accounts_.erase(url);
  if (host.plat) { std::string s = accounts_.dump(); host.plat->writeSave(ACCOUNTS_FILE, std::vector<uint8_t>(s.begin(), s.end())); }
}
void Multiplayer::forgetAccount() { storeAccount(std::nullopt); }

void Multiplayer::connectThen(std::function<void(bool, const std::string&)> next) {
  if (net.isOpen()) { next(true, ""); return; }
  statusLine_ = "Connecting to " + url + "...";
  net.connect(url, [next](bool ok, const std::string& err) { next(ok, err); });
}

void Multiplayer::registerName(const std::string& raw, std::function<void(bool, const std::string&)> done) {
  std::string nm = raw;
  while (!nm.empty() && nm.front() == ' ') nm.erase(nm.begin());
  while (!nm.empty() && nm.back() == ' ') nm.pop_back();
  if (!net::validName(nm)) { done(false, net::errText("name_invalid")); return; }
  busy_ = true;
  connectThen([this, nm, done](bool ok, const std::string& err) {
    if (!ok) { busy_ = false; statusLine_ = err; done(false, err); return; }
    net.request("register", Json{{"name", nm}}, [this, done](const net::NetResult& r) {
      busy_ = false;
      if (!r.ok) { statusLine_ = net::errText(r.err); done(false, statusLine_); return; }
      storeAccount(Account{jstr(r.d, "name"), jstr(r.d, "token")});
      statusLine_ = "Registered as " + jstr(r.d, "name");
      SL_INFO("mp: registered %s", jstr(r.d, "name").c_str());
      done(true, jstr(r.d, "name"));
    });
  });
}

Json Multiplayer::look() const {
  const Save& s = *host.save;
  Json o = s.outfits.equipped.contains(s.character) ? s.outfits.equipped[s.character] : Json(nullptr);
  return Json{{"c", s.character}, {"o", o}, {"s", s.skis.empty() ? std::string("rental") : s.skis}};
}

void Multiplayer::start(std::function<void(bool, const std::string&)> done) {
  auto acc = account();
  if (!acc) { done(false, net::errText("no_account")); return; }
  busy_ = true;
  connectThen([this, acc = *acc, done](bool ok, const std::string& err) {
    if (!ok) { busy_ = false; statusLine_ = err; done(false, err); return; }
    statusLine_ = "Logging in as " + acc.name + "...";
    Json d{{"v", net::PROTO}, {"name", acc.name}, {"token", acc.token}, {"look", look()}};
    if (host.plots) { auto p = host.plots(); if (!p.empty()) d["plots"] = p; }
    if (host.transitFingerprint) d["tt"] = host.transitFingerprint();
    net.request("login", d, [this, done](const net::NetResult& r) {
      busy_ = false;
      if (!r.ok) {
        if (r.err == "bad_login") forgetAccount();   // (the server has no such name / key: pick a name again)
        statusLine_ = net::errText(r.err);
        net.close("login failed");
        done(false, statusLine_);
        return;
      }
      enter(r.d);
      done(true, "");
    });
  });
}

void Multiplayer::accountOp(const std::string& t, Json extra, std::function<void(const net::NetResult&)> done) {
  auto acc = account();
  if (!acc) { net::NetResult r; r.err = "no_account"; done(r); return; }
  bool own = !active_ && !net.isOpen();
  extra["name"] = acc->name;
  extra["token"] = acc->token;
  connectThen([this, t, extra, own, done](bool ok, const std::string& err) {
    if (!ok) { net::NetResult r; r.err = err; done(r); return; }
    net.request(t, extra, [this, own, done](const net::NetResult& r) {
      if (own) net.close("account");
      done(r);
    });
  });
}

void Multiplayer::renameAccount(const std::string& newName, std::function<void(bool, const std::string&)> done) {
  accountOp("accountRename", Json{{"newName", newName}}, [this, done](const net::NetResult& r) {
    if (!r.ok) { done(false, net::errText(r.err) + (r.err == "rename_wait" && r.d.contains("days") ? " (" + std::to_string(jnum(r.d, "days")) + " days left)" : "")); return; }
    storeAccount(Account{jstr(r.d, "name"), jstr(r.d, "token")});
    if (active_) { name = jstr(r.d, "name"); net.reconnect("renamed"); }   // ('reopen' -> relogin as the new name)
    done(true, jstr(r.d, "name"));
  });
}

void Multiplayer::deleteAccount(const std::string& confirm, std::function<void(bool, const std::string&)> done) {
  accountOp("accountDelete", Json{{"confirm", confirm}}, [this, done](const net::NetResult& r) {
    if (!r.ok) { done(false, net::errText(r.err)); return; }
    forgetAccount();
    if (active_) lost("Your account was deleted.");
    done(true, "");
  });
}

// ---------------------------------------------------------------- entering the world
void Multiplayer::enter(const Json& d) {
  active_ = true;
  resumed = false;
  name = jstr(d, "name");
  pid = int(jnum(d, "pid"));
  catalog = d.value("catalog", Json::object());
  chaletOwners.clear();
  if (d.contains("chalets") && d["chalets"].is_object())
    for (auto& [k, v] : d["chalets"].items()) if (v.is_string()) chaletOwners[std::atoi(k.c_str())] = v.get<std::string>();
  jailBoard = d.value("jailBoard", Json::array());
  guests.clear();
  if (d.contains("guests") && d["guests"].is_array()) for (auto& g : d["guests"]) if (g.is_string()) guests.push_back(g.get<std::string>());
  byeReason_.clear();
  applyProfile(d.value("profile", Json::object()));
  const Json cp = d.value("chaletPlot", Json::object());
  chaletPlot = cp.contains("id") && cp["id"].is_number() ? int(cp["id"].get<double>()) : -1;
  chaletWaiting = cp.value("waiting", false);
  setWorld(d.value("world", Json::object()));
  if (auto day = dayNow()) host.save->day = *day;
  bind();
  if (host.setAI) host.setAI(false);
  // multiplayer: the save holds the server profile, never written over the single-player save; only the device
  // settings go into the stored file (economy.js writeSave)
  host.save->mpWrite = [this](Save& s) {
    pushT_ = pushT_ < 0 ? PUSH_DELAY : pushT_;
    std::vector<uint8_t> b;
    Json stored;
    if (host.plat && host.plat->readSave(s.fileName(), b) && !b.empty()) stored = Json::parse(b.begin(), b.end(), nullptr, false);
    if (!stored.is_object() && spSave_.is_object()) stored = spSave_;
    if (!stored.is_object()) return true;
    Json now = s.toJson();
    bool changed = false;
    for (const char* k : kDevicePrefs) if (now.contains(k) && (!stored.contains(k) || stored[k] != now[k])) { stored[k] = now[k]; changed = true; }
    for (auto& [k, v] : s.settings.items()) if (!stored.contains(k) || stored[k] != v) { stored[k] = v; changed = true; }
    if (changed && host.plat) { std::string out = stored.dump(); host.plat->writeSave(s.fileName(), std::vector<uint8_t>(out.begin(), out.end())); }
    return true;
  };
  if (host.applySave) host.applySave();
  net.send("look", look());
  push(true);
  statusLine_ = "Online \xC2\xB7 world " + std::to_string(worldId);
  SL_INFO("mp: logged in as %s (pid %d), world %d with %zu other player(s), $%lld", name.c_str(), pid, worldId, players.size(), (long long)host.save->money);
}

void Multiplayer::addPlayer(const Json& p) {
  int id = int(jnum(p, "pid"));
  if (id == pid || id <= 0) return;
  RemotePlayer& r = players[id];
  r = RemotePlayer{};
  r.pid = id;
  r.name = jstr(p, "name", "?");
  r.look = p.value("look", Json());
  r.vehs = p.contains("vehs") && p["vehs"].is_object() ? p["vehs"] : Json::object();
  r.parked = p.contains("parked") && p["parked"].is_array() ? p["parked"] : Json::array();
  r.chalet = p.contains("chalet") && p["chalet"].is_number() ? int(p["chalet"].get<double>()) : -1;
  if (p.contains("pres") && p["pres"].is_array()) r.push(p["pres"], net.serverNow());
}

void Multiplayer::setWorld(const Json& w) {
  worldId = int(jnum(w, "id"));
  worldMax = int(jnum(w, "max", net::MAX_PLAYERS));
  clock_ = w.value("clock", Json::object());
  players.clear();
  if (w.contains("players") && w["players"].is_array()) for (auto& p : w["players"]) addPlayer(p);
  seats.clear();
  if (w.contains("seats") && w["seats"].is_array())
    for (auto& s : w["seats"]) seats[jstr(s, "k") + "|" + jstr(s, "v")] = s.value("occ", Json::array());
  warps.clear();
  if (w.contains("warps") && w["warps"].is_array()) for (auto& x : w["warps"]) warps[jstr(x, "key")] = x;
}

void Multiplayer::unbind() {
  for (int h : handlers_) net.off(h);
  handlers_.clear();
}

void Multiplayer::bind() {
  unbind();
  auto on = [this](const char* t, net::NetClient::Handler fn) { handlers_.push_back(net.on(t, std::move(fn))); };
  on("P", [this](const Json& rows) {
    if (!rows.is_array()) return;
    double now = net.serverNow();
    for (auto& row : rows) {
      if (!row.is_array() || row.empty() || !row[0].is_number()) continue;
      auto it = players.find(int(row[0].get<double>()));
      if (it != players.end()) { it->second.push(row, now); rowsReceived++; }
    }
  });
  on("join", [this](const Json& p) { addPlayer(p); flash(jstr(p, "name") + " joined", 0); });
  on("leave", [this](const Json& p) { players.erase(int(jnum(p, "pid"))); flash(jstr(p, "name") + " left", 0); });
  on("look", [this](const Json& d) { auto it = players.find(int(jnum(d, "pid"))); if (it != players.end()) it->second.look = d.value("look", Json()); });
  on("clock", [this](const Json& d) { clock_ = d; });
  on("chalet", [this](const Json& d) {
    int id = int(jnum(d, "id", -1));
    if (d.contains("owner") && d["owner"].is_string()) chaletOwners[id] = d["owner"].get<std::string>(); else chaletOwners.erase(id);
  });
  on("chaletPlaced", [this](const Json& d) {
    chaletPlot = int(jnum(d, "id", -1)); chaletWaiting = false;
    nlohmann::json& ch = host.save->data("chalet");
    if (ch.is_object() && !ch.empty()) ch["id"] = chaletPlot;
    flash("Your chalet is back", 0);
  });
  on("guests", [this](const Json& d) {
    if (jstr(d, "kind") != "chaletVisit") return;
    guests.clear();
    if (d.contains("names") && d["names"].is_array()) for (auto& g : d["names"]) if (g.is_string()) guests.push_back(g.get<std::string>());
  });
  on("adminTp", [this](const Json& d) { if (host.adminTp && d.contains("x") && d.contains("z")) host.adminTp(jdbl(d, "x"), jdbl(d, "z"), jdbl(d, "yaw"), jstr(d, "to")); });
  on("money", [this](const Json& d) {
    if (!d.contains("v")) return;
    int64_t delta = jnum(d, "delta");
    setServerMoney(jnum(d, "v"));
    if (delta != 0) { host.save->lastDelta = delta; host.save->lastDeltaAt = host.save->clock; }
  });
  on("seats", [this](const Json& d) {
    std::string k = jstr(d, "k") + "|" + jstr(d, "v");
    Json occ = d.value("occ", Json::array());
    if (occ.is_array() && !occ.empty()) seats[k] = occ; else seats.erase(k);
  });
  on("skip", [this](const Json& d) { skips[jstr(d, "k") + "|" + jstr(d, "v")] = d; });
  on("warp", [this](const Json& d) { warps[jstr(d, "key")] = d; });
  on("permAsk", [this](const Json& d) {
    PermAsk a;
    a.rid = int(jnum(d, "rid"));
    a.kind = jstr(d, "kind");
    a.from = jstr(d, "from");
    a.text = a.kind == "carRide" ? "Allow " + a.from + " to get in your car?" : a.from + " wants to visit your chalet";
    a.until = clockSeconds() + jdbl(d, "timeoutMs", 30000) / 1000.0;
    asks.push_back(a);
  });
  on("permClosed", [this](const Json& d) {
    int rid = int(jnum(d, "rid"));
    asks.erase(std::remove_if(asks.begin(), asks.end(), [&](const PermAsk& a) { return a.rid == rid; }), asks.end());
  });
  on("permRevoked", [this](const Json& d) {
    flash(jstr(d, "kind") == "carRide" ? jstr(d, "owner") + " took back the car ride" : jstr(d, "owner") + " took back the chalet visit", 1);
  });
  on("kickInterior", [this](const Json& d) { interior_.clear(); if (host.onKickInterior) host.onKickInterior(jstr(d, "interior")); });
  on("seatLost", [this](const Json& d) {
    if (jstr(d, "k") == "car" && ride.on) { ride = CarRide{}; mySeat.clear(); }
    if (host.onSeatLost) host.onSeatLost(d);
  });
  on("jailBoard", [this](const Json& d) { jailBoard = d.value("top", Json::array()); });
  on("arrested", [this](const Json& d) {
    if (ride.on) { ride = CarRide{}; mySeat.clear(); }
    if (d.contains("jailUntil")) profile["jailUntil"] = d["jailUntil"];
    if (host.onArrested) host.onArrested(d);
  });
  for (const char* t : {"adminMsg", "adminNote", "adminRelease"}) {
    std::string tt = t;
    on(t, [this, tt](const Json& d) {
      if (tt == "adminMsg") { banner = jstr(d, "text"); bannerFrom = jstr(d, "from"); bannerUntil = clockSeconds() + 8; }
      else if (tt == "adminNote") chat.push_back(Line{"server", jstr(d, "text"), clockSeconds(), true});
      else flash("An admin released you (" + jstr(d, "what") + ")", 0);
    });
  }
  on("chat", [this](const Json& d) {
    chat.push_back(Line{jstr(d, "name"), jstr(d, "text"), clockSeconds(), false});
    while (chat.size() > 8) chat.pop_front();
  });
  on("veh", [this](const Json& d) {
    auto it = players.find(int(jnum(d, "pid")));
    if (it == players.end()) return;
    std::string k = jstr(d, "k");
    if (d.contains("veh") && d["veh"].is_object()) it->second.vehs[k] = d["veh"]; else it->second.vehs.erase(k);
  });
  on("parked", [this](const Json& d) {
    auto it = players.find(int(jnum(d, "pid")));
    if (it != players.end()) it->second.parked = d.contains("cars") && d["cars"].is_array() ? d["cars"] : Json::array();
  });
  on("bye", [this](const Json& d) { byeReason_ = jstr(d, "reason"); });
  on("reopen", [this](const Json&) { relogin(); });
  on("lost", [this](const Json& d) {
    std::string why = jstr(d, "reason");
    lost(why == "kicked" || byeReason_ == "kicked" ? "You were kicked from the server."
         : why == "replaced" || byeReason_ == "replaced" ? "You logged in somewhere else."
         : byeReason_ == "restart" ? "The server is restarting. Try again in a moment." : "Lost the connection to the server.");
  });
}

void Multiplayer::relogin() {
  auto acc = account();
  if (!acc || !active_) return;
  Json d{{"v", net::PROTO}, {"name", acc->name}, {"token", acc->token}, {"look", look()}};
  if (host.plots) { auto p = host.plots(); if (!p.empty()) d["plots"] = p; }
  if (host.transitFingerprint) d["tt"] = host.transitFingerprint();
  net.request("login", d, [this](const net::NetResult& r) {
    if (!r.ok) {
      // the account itself is refused (bad token, another version): back to the menu; anything else: try again
      if (r.err == "bad_login" || r.err == "proto" || !active_) lost(net::errText(r.err));
      else { SL_WARN("mp: login after reconnect: %s", r.err.c_str()); net.reconnect("relogin"); }
      return;
    }
    pid = int(jnum(r.d, "pid"));
    name = jstr(r.d, "name", name);
    byeReason_.clear();
    chaletOwners.clear();
    if (r.d.contains("chalets") && r.d["chalets"].is_object())
      for (auto& [k, v] : r.d["chalets"].items()) if (v.is_string()) chaletOwners[std::atoi(k.c_str())] = v.get<std::string>();
    if (r.d.contains("profile")) setServerMoney(jnum(r.d["profile"], "money", moneyServer_));
    setWorld(r.d.value("world", Json::object()));
    resumed = r.d.value("resumed", false);
    if (!interior_.empty()) { std::string want = interior_; net.request("enter", Json{{"interior", want}}, [this](const net::NetResult& e) { if (!e.ok) interior_.clear(); }); }
    if (!resumed) { ride = CarRide{}; mySeat.clear(); carSentAny_ = false; keptSig_.clear(); }
    flash(resumed ? "Reconnected" : "Reconnected \xC2\xB7 back in the world", 0);
    net.emit("relogin", r.d);
    SL_INFO("mp: reconnected (%s), world %d, pid %d", resumed ? "resumed" : "new session", worldId, pid);
  });
}

void Multiplayer::lost(const std::string& reason) {
  if (!active_) return;
  leave();
  statusLine_ = reason;
  if (host.onLost) host.onLost(reason);
}

void Multiplayer::leave() {
  if (!active_) return;
  pushT_ = -1;
  push(false, true);
  unbind();
  net.close("leave");
  players.clear();
  active_ = false;
  name.clear(); pid = 0; worldId = 0;
  profile = Json::object();
  interior_.clear(); entering_ = false;
  seats.clear(); warps.clear(); skips.clear(); asks.clear(); guests.clear(); chaletOwners.clear();
  ride = CarRide{}; mySeat.clear(); skipKey_.clear();
  carSentAny_ = false; keptSig_.clear();
  banner.clear(); chat.clear();
  host.save->mpWrite = nullptr;
  restoreSave();
  if (host.setAI) host.setAI(true);
  if (host.applySave) host.applySave();
  statusLine_ = "Left multiplayer";
  SL_INFO("mp: left multiplayer");
}

// ---------------------------------------------------------------- the save swap
void Multiplayer::applyProfile(const Json& p) {
  Save& s = *host.save;
  spSave_ = s.toJson();
  profile = p;
  s.money = jnum(p, "money", 500);
  s.owned.clear();
  if (p.contains("owned") && p["owned"].is_array()) for (auto& o : p["owned"]) if (o.is_string()) s.owned.push_back(o.get<std::string>());
  s.skis = jstr(p, "skis");
  s.outfits.owned.clear();
  s.outfits.equipped = Json::object();
  if (p.contains("outfits") && p["outfits"].is_object()) {
    const Json& o = p["outfits"];
    if (o.contains("owned") && o["owned"].is_array()) for (auto& id : o["owned"]) if (id.is_string()) s.outfits.owned.push_back(id.get<std::string>());
    if (o.contains("equipped") && o["equipped"].is_object()) s.outfits.equipped = o["equipped"];
  }
  s.data("chalet") = p.contains("chalet") && p["chalet"].is_object() ? p["chalet"] : Json::object();
  // your garage (cars[0]: the one out), its damage (the server keeps 0..1; the save a percentage), the tow yard
  s.garage.clear();
  s.rentalPlate.clear();
  Json impound = Json::array();
  if (p.contains("cars") && p["cars"].is_array()) {
    for (auto& c : p["cars"]) {
      if (!c.is_object()) continue;
      Save::Car car;
      car.id = jstr(c, "id"); car.plate = jstr(c, "plate"); car.paint = jstr(c, "paint", "white");
      car.price = int(jnum(c, "price")); car.damage = jdbl(c, "damage") * 100; car.custom = c.value("custom", false);
      s.garage.push_back(car);
      if (c.contains("impound") && c["impound"].is_object()) impound.push_back({{"plate", car.plate}, {"day", s.day + 1}, {"until", jdbl(c["impound"], "until")}});
    }
    if (!s.garage.empty()) s.rentalPlate = s.garage[0].plate;
  }
  s.data("impound", Json::array()) = impound;
  const Json st = p.value("stats", Json::object());
  s.stats.races = int(jnum(st, "races")); s.stats.wins = int(jnum(st, "wins"));
  s.stats.topSpeed = jdbl(st, "topSpeed"); s.stats.distance = jdbl(st, "distance"); s.stats.earned = jdbl(st, "earned");
  s.stats.longestJump = jdbl(st, "longestJump"); s.stats.bestAir = jdbl(st, "bestAir");
  s.data("records") = p.contains("records") && p["records"].is_object() ? p["records"] : Json::object();
  s.data("secrets", Json::array()) = p.contains("secrets") && p["secrets"].is_array() ? p["secrets"] : Json::array();
  s.dayPass = int(jnum(p, "dayPass", -1));
  s.tickets = int(jnum(p, "tickets"));
  s.data("pos") = p.contains("pos") && p["pos"].is_object() ? p["pos"] : Json::object();
  s.data("jail") = Json::object();
  if (p.contains("jailUntil") && p["jailUntil"].is_number()) {
    double left = (p["jailUntil"].get<double>() - net.serverNow()) / 1000;
    if (left > 1) s.data("jail") = {{"left", left}, {"reason", jstr(p, "jailReason", "Arrested")}};
  }
  if (p.contains("character") && p["character"].is_string()) {
    std::string ch = p["character"].get<std::string>();
    if (ch == "skier_red" || ch == "skier_blue") s.character = ch;   // (the character picked in the menu otherwise)
  }
  moneyServer_ = s.money;
  moneyPending_ = 0;
  expected_ = s.money;
  pushed_.clear();
}

void Multiplayer::restoreSave() {
  if (!spSave_.is_object()) return;
  Save& s = *host.save;
  Json keep = Json::object();
  Json now = s.toJson();
  for (const char* k : kDevicePrefs) if (now.contains(k)) keep[k] = now[k];   // (this machine's settings changed online stay)
  for (auto& [k, v] : s.settings.items()) keep[k] = v;
  Json back = spSave_;
  for (auto& [k, v] : keep.items()) back[k] = v;
  s.fromJson(back);
  spSave_ = Json();
}

// the parts of the profile the player owns (no money, nothing bought), pushed when they change
void Multiplayer::push(bool force, bool last) {
  if (!active_ || !net.isOpen()) return;
  Save& s = *host.save;
  auto send = [&](const std::string& key, const Json& value) {
    std::string j = value.dump();
    if (!force && pushed_[key] == j) return;
    pushed_[key] = j;
    if (last) { net.send("profileSet", Json{{"key", key}, {"value", value}}); return; }
    net.request("profileSet", Json{{"key", key}, {"value", value}}, [this, key, j](const net::NetResult& r) {
      if (!r.ok) { if (pushed_[key] == j) pushed_.erase(key); SL_WARN("mp: profile %s: %s", key.c_str(), r.err.c_str()); }
    });
  };
  send("character", s.character);
  if (!s.skis.empty() && s.ownsSki(s.skis)) send("skis", s.skis);
  send("outfitsEquipped", s.outfits.equipped);
  const nlohmann::json& ch = s.data("chalet");
  if (ch.is_object() && ch.value("owned", false) && profile.contains("chalet") && profile["chalet"].is_object()) send("chalet", ch);
  send("stats", Json{{"topSpeed", s.stats.topSpeed}, {"distance", std::round(s.stats.distance)}, {"longestJump", s.stats.longestJump}, {"bestAir", s.stats.bestAir}});
  send("records", s.data("records"));
  send("secrets", s.data("secrets", Json::array()));
  send("dayPass", s.dayPass);
  send("tickets", std::clamp(s.tickets, 0, 999));
}

// ---------------------------------------------------------------- the clock
std::optional<double> Multiplayer::hourNow() const {
  if (!clock_.is_object() || !clock_.contains("hour")) return std::nullopt;
  double now = net.serverNow(), dayMs = jdbl(clock_, "dayMs", 16 * 60 * 1000);
  double h = jdbl(clock_, "hour") + (now - jdbl(clock_, "at", now)) / dayMs * 24;
  return std::fmod(std::fmod(h, 24.0) + 24.0, 24.0);
}
std::optional<int> Multiplayer::dayNow() const {
  if (!clock_.is_object() || !clock_.contains("day")) return std::nullopt;
  double now = net.serverNow(), dayMs = jdbl(clock_, "dayMs", 16 * 60 * 1000);
  return int(jnum(clock_, "day")) + int(std::floor((jdbl(clock_, "hour") + (now - jdbl(clock_, "at", now)) / dayMs * 24) / 24));
}
std::string Multiplayer::weather() const { return jstr(clock_, "weather"); }
std::string Multiplayer::upcomingWeather() const { return jstr(clock_, "upcoming"); }
double Multiplayer::upcomingIn() const { return clock_.contains("nextAt") ? std::max(0.0, (jdbl(clock_, "nextAt") - net.serverNow()) / 1000) : -1; }
double Multiplayer::lineTime(const std::string& key) const {
  double now = net.serverNow();
  auto it = warps.find(key);
  if (it == warps.end()) return now;
  return now + jdbl(it->second, "off") + (jdbl(it->second, "rate", 1) - 1) * (now - jdbl(it->second, "since", now));
}

// ---------------------------------------------------------------- money: the server's number wins
void Multiplayer::setServerMoney(int64_t v) {
  moneyServer_ = v;
  expected_ = v - moneyPending_;
  host.save->money = expected_;
}

void Multiplayer::guardMoney() {
  Save& s = *host.save;
  if (s.money == expected_) return;
  if (s.money > expected_) { s.money = expected_; return; }   // (a rise that did not come from the server: undone)
  int64_t amount = expected_ - s.money;
  expected_ = s.money;
  moneyPending_ += amount;
  net.request("spend", Json{{"amount", amount}, {"reason", "game"}}, [this, amount](const net::NetResult& r) {
    moneyPending_ -= amount;
    if (r.ok) setServerMoney(jnum(r.d, "money", moneyServer_));
    else { setServerMoney(jnum(r.d, "money", moneyServer_)); if (r.err == "money") flash("Not enough money (server)", 1); }
  });
}

void Multiplayer::buy(const std::string& kind, Json data, std::function<void(bool, const Json&)> done) {
  guardMoney();
  data["kind"] = kind;
  net.request("buy", data, [this, done](const net::NetResult& r) {
    if (r.d.contains("money") && r.d["money"].is_number()) setServerMoney(jnum(r.d, "money"));
    if (!r.ok) {
      std::string msg = r.err == "taken" ? jstr(r.d, "owner", "Somebody") + " already owns it"
                      : r.err == "plate_taken" ? "The plate " + jstr(r.d, "plate") + " is taken"
                      : r.err == "garage_full" ? "Your garage is full (" + std::to_string(jnum(r.d, "max", 10)) + " cars) \xC2\xB7 sell one first (MY CARS)"
                      : r.err == "one_each" ? (chaletWaiting ? "You own a chalet \xC2\xB7 it comes back when a plot is free" : "One chalet each") : net::errText(r.err);
      flash(msg, 1);
    }
    done(r.ok, r.d);
  });
}

void Multiplayer::earn(int64_t amount, const std::string& source, std::function<void(bool)> done) {
  net.request("earn", Json{{"amount", amount}, {"source", source}}, [this, amount, done](const net::NetResult& r) {
    if (r.d.contains("money")) setServerMoney(jnum(r.d, "money"));
    if (r.ok) { host.save->lastDelta = amount; host.save->lastDeltaAt = host.save->clock; host.save->stats.earned += double(amount); }
    else flash("Payout refused \xC2\xB7 " + (r.err == "cap" ? std::string("hourly limit reached") : net::errText(r.err)), 1);
    if (done) done(r.ok);
  });
}

void Multiplayer::carSell(const std::string& plate, std::function<void(bool, const Json&)> done) {
  guardMoney();
  net.request("carSell", Json{{"plate", plate}}, [this, done](const net::NetResult& r) {
    if (r.d.contains("money")) setServerMoney(jnum(r.d, "money"));
    if (r.ok && r.d.contains("cars")) profile["cars"] = r.d["cars"];
    if (!r.ok) flash("Could not sell it \xC2\xB7 " + net::errText(r.err), 1);
    done(r.ok, r.d);
  });
}
void Multiplayer::carSwitch(const std::string& plate, std::function<void(bool, const Json&)> done) {
  net.request("carSwitch", Json{{"plate", plate}}, [this, done](const net::NetResult& r) {
    if (r.ok && r.d.contains("cars")) profile["cars"] = r.d["cars"];
    if (!r.ok) flash("Could not swap cars \xC2\xB7 " + net::errText(r.err), 1);
    done(r.ok, r.d);
  });
}
void Multiplayer::carRepair(double damage, const std::string& plate, std::function<void(bool, const Json&)> done) {
  guardMoney();
  net.request("carRepair", Json{{"damage", std::clamp(damage, 0.0, 1.0)}, {"plate", plate}}, [this, done](const net::NetResult& r) {
    if (r.d.contains("money")) setServerMoney(jnum(r.d, "money"));
    if (!r.ok) flash(r.err == "money" ? "Not enough money for the repair" : r.err == "busy" ? "The tow truck has your car" : "Could not repair it \xC2\xB7 " + net::errText(r.err), 1);
    done(r.ok, r.d);
  });
}
void Multiplayer::carDamage(const std::string& plate, double damage) {
  net.request("carDamage", Json{{"plate", plate}, {"damage", std::clamp(damage, 0.0, 1.0)}, {"dents", Json::array()}}, [](const net::NetResult&) {});
}
void Multiplayer::tow(const std::string& kind, const dvec3& home, double yaw, int bay, std::function<void(bool, const Json&)> done) {
  guardMoney();
  net.request("tow", Json{{"kind", kind}, {"home", {home.x, home.y, home.z, yaw}}, {"bay", bay}}, [this, done](const net::NetResult& r) {
    if (r.d.contains("money")) setServerMoney(jnum(r.d, "money"));
    if (done) done(r.ok, r.d);
  });
}
void Multiplayer::towDone() { net.request("towDone", Json::object(), [](const net::NetResult&) {}); }
void Multiplayer::jail(double seconds, const std::string& reason) {
  net.request("jail", Json{{"seconds", std::clamp(seconds, 1.0, 300.0)}, {"reason", reason.substr(0, 80)}}, [this](const net::NetResult& r) {
    if (r.ok && r.d.contains("jailUntil")) profile["jailUntil"] = r.d["jailUntil"];
  });
}
void Multiplayer::policeArrest(bool onFoot) {
  net.request("policeArrest", Json{{"foot", onFoot}}, [this](const net::NetResult& r) {
    if (r.ok && r.d.contains("passengers") && r.d["passengers"].is_array() && !r.d["passengers"].empty()) {
      std::string list;
      for (auto& n : r.d["passengers"]) if (n.is_string()) list += (list.empty() ? "" : ", ") + n.get<std::string>();
      flash(list + " arrested with you", 1);
    }
  });
}
void Multiplayer::chaletFurniture(int id, std::function<void(bool, const Json&)> done) {
  net.request("chaletFurniture", Json{{"id", id}}, [done](const net::NetResult& r) {
    done(r.ok, r.ok && r.d.contains("chalet") && r.d["chalet"].is_object() ? r.d["chalet"].value("furniture", Json::array()) : Json::array());
  });
}

// ---------------------------------------------------------------- interiors, permissions, seats
void Multiplayer::setInterior(const std::string& id, std::function<void(bool)> done) {
  if (id == interior_) { if (done) done(true); return; }
  net.request("enter", Json{{"interior", id.empty() ? Json(nullptr) : Json(id)}}, [this, id, done](const net::NetResult& r) {
    if (r.ok) interior_ = id;
    if (done) done(r.ok);
  });
}

void Multiplayer::ask(const std::string& kind, const std::string& to, int ref, std::function<void(bool, const std::string&)> done) {
  Json d{{"kind", kind}};
  if (!to.empty()) d["to"] = to;
  if (ref >= 0) d["ref"] = ref;
  net.request("perm", d, [done](const net::NetResult& r) {
    if (!r.ok) { done(false, net::errText(r.err)); return; }
    bool allow = r.d.value("allow", false);
    done(allow, allow ? "" : jstr(r.d, "reason") == "timeout" ? "No answer" : "Not allowed");
  }, 40);
}

void Multiplayer::answerPerm(int rid, bool allow) {
  asks.erase(std::remove_if(asks.begin(), asks.end(), [&](const PermAsk& a) { return a.rid == rid; }), asks.end());
  net.request("permAnswer", Json{{"rid", rid}, {"allow", allow}}, [](const net::NetResult&) {});
}

void Multiplayer::revokeGuest(const std::string& guest, const std::string& kind) {
  net.request("permRevoke", Json{{"kind", kind}, {"guest", guest}}, [this, guest](const net::NetResult& r) { if (r.ok) flash(guest + " has to leave", 0); });
}

void Multiplayer::claimSeat(const std::string& k, const std::string& v, int n, std::function<void(bool, const Json&)> done, int seat) {
  Json d{{"k", k}, {"v", v}};
  if (n > 0) d["n"] = n;
  if (seat >= 0) d["seat"] = seat;
  net.request("seatClaim", d, [this, k, done](const net::NetResult& r) {
    if (r.ok) mySeat = k + "|" + jstr(r.d, "v");
    if (done) done(r.ok, r.ok ? r.d : Json{{"err", r.err}, {"n", jnum(r.d, "n")}, {"taken", jnum(r.d, "taken")}});
  });
}

void Multiplayer::releaseSeat() {
  if (mySeat.empty() && !ride.on) return;
  mySeat.clear();
  skipKey_.clear();
  ride = CarRide{};
  net.request("seatRelease", Json::object(), [](const net::NetResult&) {});
}

void Multiplayer::holdSkip(const std::string& k, const std::string& v, bool on, double rate, const std::string& line) {
  std::string key = k + "|" + v;
  if (key == skipKey_ && on == skipOn_) return;   // (only changes are sent)
  skipKey_ = key; skipOn_ = on;
  Json d{{"k", k}, {"v", v}, {"on", on}, {"rate", rate}};
  if (!line.empty()) d["line"] = line;
  net.request("skip", d, [](const net::NetResult&) {});
}

int Multiplayer::carNear(const dvec3& p, double reach, std::string& owner) const {
  int best = -1;
  double bd = reach;
  for (auto& [id, r] : players) {
    if (!r.ok || !r.vehs.contains("car") || !r.vehs["car"].is_object()) continue;
    dvec3 c = r.pos;
    const Json& v = r.vehs["car"];
    bool driving = (r.flags & net::F::car) != 0;
    if (!driving) {
      if (!v.contains("at") || !v["at"].is_array() || v["at"].size() < 4) continue;
      c = dvec3(v["at"][0].get<double>(), v["at"][1].get<double>(), v["at"][2].get<double>());
    }
    double d = std::hypot(c.x - p.x, c.z - p.z) - 2.3;
    if (d < bd) { bd = d; best = id; owner = r.name; }
  }
  return best;
}

bool Multiplayer::rideSeat(dvec3& pos, dvec3& fwd) const {
  if (!ride.on) return false;
  auto it = players.find(ride.pid);
  if (it == players.end() || !it->second.ok) return false;
  const RemotePlayer& r = it->second;
  dvec3 c = r.sm;
  double yaw = r.smYaw;
  if (!(r.flags & net::F::car) && r.vehs.contains("car") && r.vehs["car"].contains("at") && r.vehs["car"]["at"].is_array()) {
    const Json& a = r.vehs["car"]["at"];
    c = dvec3(a[0].get<double>(), a[1].get<double>(), a[2].get<double>());
    yaw = a[3].get<double>();
  }
  // the seats (carpeople.js, condensed): 1 front passenger, 2.. the back row
  double side = ride.seat == 1 ? -0.42 : ride.seat == 2 ? 0.42 : ride.seat == 3 ? -0.42 : 0.0;
  double along = ride.seat <= 1 ? 0.15 : -0.75;
  dvec3 f(std::sin(yaw), 0, std::cos(yaw)), rt(f.z, 0, -f.x);
  pos = c + f * along + rt * side + dvec3(0, 0.45, 0);
  fwd = f;
  return true;
}

// ---------------------------------------------------------------- your car as everyone sees it
void Multiplayer::reportCar(const CarReport& c) {
  if (!active_ || !net.isOpen()) return;
  bool tell = !carSentAny_ || c.has != carSent_.has || c.driving != carSent_.driving || c.wreck != carSent_.wreck || c.plate != carSent_.plate;
  if (!tell && c.has && !c.driving && std::hypot(c.pos.x - carSent_.pos.x, c.pos.z - carSent_.pos.z) > 0.5) tell = true;
  if (!tell) return;
  bool had = carSentAny_ && carSent_.has;
  carSent_ = c;
  carSentAny_ = true;
  if (!c.has) { if (had) net.request("veh", Json{{"k", "car"}, {"off", true}}, [](const net::NetResult&) {}); return; }
  Json m{{"k", "car"}};
  if (!c.driving) m["at"] = {c.pos.x, c.pos.y, c.pos.z, c.yaw};
  if (c.wreck) m["wreck"] = true;
  net.request("veh", m, [](const net::NetResult&) {});
}

void Multiplayer::reportKept(const std::vector<Kept>& list) {
  if (!active_ || !net.isOpen()) return;
  std::string sig;
  Json cars = Json::array();
  for (const Kept& k : list) {
    sig += k.plate + "@" + std::to_string(std::lround(k.pos.x * 2)) + "," + std::to_string(std::lround(k.pos.z * 2)) + "," + std::to_string(std::lround(k.yaw * 20)) + (k.wreck ? "w;" : ";");
    Json e{{"plate", k.plate}, {"at", {k.pos.x, k.pos.y, k.pos.z, k.yaw}}};
    if (k.wreck) e["wreck"] = true;
    cars.push_back(e);
  }
  if (sig == keptSig_) return;
  keptSig_ = sig;
  net.request("parked", Json{{"cars", cars}}, [this](const net::NetResult& r) { if (!r.ok) keptSig_.clear(); });
}

void Multiplayer::sendChat(const std::string& text) {
  if (text.empty() || !active_) return;
  net.request("chat", Json{{"text", text.substr(0, 200)}}, [this](const net::NetResult& r) { if (!r.ok) flash("Chat \xC2\xB7 " + net::errText(r.err), 1); });
}

// ---------------------------------------------------------------- every frame
void Multiplayer::sendPresence() {
  MpPose& p = pose_;
  p = MpPose{};
  if (host.pose) host.pose(p);
  if (p.hold) return;
  if (p.interior != interior_) {
    // into / out of an interior: the server approves it first (a chalet needs its owner's yes); until then nothing
    // goes out (nobody sees you outdoors at the interior's coordinates)
    if (!entering_) {
      entering_ = true;
      std::string want = p.interior;
      setInterior(want, [this, want](bool ok) { entering_ = false; if (!ok && host.onKickInterior) host.onKickInterior(want); });
    }
    return;
  }
  if (paused_) { p.vx = p.vy = p.vz = 0; p.lean = 0; if (p.st != int(net::St::Fall)) { p.crouch = 0; p.flags &= ~(net::F::air | net::F::tuck); } p.flags |= net::F::paused; }
  auto r2 = [](double v) { return std::round(v * 1000) / 1000; };
  Json row = Json::array({std::llround(net.serverNow()), r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.vx), r2(p.vy), r2(p.vz), p.st, r2(p.crouch), r2(p.lean), p.flags});
  net.sendPresence(row);
  presenceSent++;
}

void Multiplayer::updateRemotes() {
  double now = net.serverNow();
  for (auto& [id, r] : players) {
    if (r.count == 0) { r.ok = false; continue; }
    if (r.dly < 0) r.dly = r.delay();
    r.dly += (r.delay() - r.dly) * 0.05;   // (eased: a change of the delay never makes them jump)
    double t = now - r.dly;
    // the two snapshots either side of t (newest first in the ring)
    const RemotePlayer::Snap* a = nullptr;
    const RemotePlayer::Snap* b = nullptr;
    for (int k = 0; k < r.count; k++) {
      const RemotePlayer::Snap& s = r.slot(k);
      if (s.v[0] <= t) { a = &s; b = k > 0 ? &r.slot(k - 1) : nullptr; break; }
    }
    const RemotePlayer::Snap& newest = r.slot(0);
    double x, y, z, yaw, crouch, lean, vx, vy, vz;
    const RemotePlayer::Snap* use = a ? a : &r.slot(r.count - 1);
    if (a && b) {
      double f = std::clamp((t - a->v[0]) / std::max(1.0, b->v[0] - a->v[0]), 0.0, 1.0);
      auto L = [&](int i) { return a->v[i] + (b->v[i] - a->v[i]) * f; };
      x = L(1); y = L(2); z = L(3); vx = L(5); vy = L(6); vz = L(7); crouch = L(9); lean = L(10);
      yaw = a->v[4] + wrapPi(b->v[4] - a->v[4]) * f;
      if (f > 0.5) use = b;
    } else {
      // past the newest: a short extrapolation along its velocity
      double ex = std::clamp((t - newest.v[0]) / 1000, 0.0, EXTRAPOLATE / 1000);
      if (!a) ex = 0;
      x = newest.v[1] + newest.v[5] * ex; y = newest.v[2] + newest.v[6] * ex; z = newest.v[3] + newest.v[7] * ex;
      vx = newest.v[5]; vy = newest.v[6]; vz = newest.v[7]; yaw = newest.v[4]; crouch = newest.v[9]; lean = newest.v[10];
      use = &newest;
    }
    r.pos = dvec3(x, y, z); r.vel = dvec3(vx, vy, vz); r.yaw = yaw; r.crouch = crouch; r.lean = lean;
    r.st = int(use->v[8]); r.flags = uint32_t(int64_t(use->v[11])); r.veh = use->veh; r.interior = use->interior;
    r.ok = true;
    // the drawn pose: eased toward the sample (a resent row after a hitch is not a jump), snapping when far
    if (!r.smOk || glm::length(r.sm - r.pos) > 8) { r.sm = r.pos; r.smYaw = r.yaw; r.smOk = true; }
    else { r.sm += (r.pos - r.sm) * 0.5; r.smYaw += wrapPi(r.yaw - r.smYaw) * 0.5; }
  }
}

void Multiplayer::update(double dt, bool paused) {
  paused_ = paused;
  net.update();
  if (!active_) return;
  // the day of the world clock
  if (auto day = dayNow(); day && host.save->day != *day) host.save->day = *day;
  guardMoney();
  if (pushT_ >= 0 && (pushT_ -= dt) <= 0) { pushT_ = -1; push(); }
  // presence at 12 Hz
  sendAcc_ += dt;
  if (sendAcc_ >= 1 / net::SEND_HZ && net.isOpen()) { sendAcc_ = 0; sendPresence(); }
  updateRemotes();
  // an owner's prompt that ran out
  double now = clockSeconds();
  while (!asks.empty() && asks.front().until < now) asks.pop_front();
  while (!chat.empty() && now - chat.front().at > 20) chat.pop_front();
  const std::string& st = net.status();
  statusLine_ = st == "reconnecting" ? "MULTIPLAYER \xC2\xB7 reconnecting..."
              : name + " \xC2\xB7 WORLD " + std::to_string(worldId) + " \xC2\xB7 " + std::to_string(players.size() + 1) + "/" + std::to_string(worldMax) + " PLAYERS";
}

} // namespace sl
