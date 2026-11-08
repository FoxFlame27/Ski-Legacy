// client.js in C++ (see client.h).
#include "net/client.h"
#include <algorithm>
#include <chrono>
#include <cmath>

namespace sl::net {

namespace {
constexpr double PING_EVERY = 2000, STALE_MS = 20000, GIVE_UP_MS = 120000;
constexpr double BACKOFF[] = {300, 1000, 2000, 3000, 5000};
}

NetClient::NetClient() = default;
NetClient::~NetClient() { if (ws_) ws_->close(1001, "quit"); }

double NetClient::nowMs() const {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
double NetClient::serverNow() const {
  if (hasOffset_) return nowMs() + offset_;
  // (before the first pong: the system clock, which is the server's give or take NTP)
  return double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

// ---------------------------------------------------------------- events
int NetClient::on(const std::string& t, Handler fn) {
  int id = nextHandler_++;
  handlers_[t][id] = std::move(fn);
  handlerType_[id] = t;
  return id;
}
void NetClient::off(int id) {
  auto it = handlerType_.find(id);
  if (it == handlerType_.end()) return;
  auto h = handlers_.find(it->second);
  if (h != handlers_.end()) h->second.erase(id);
  handlerType_.erase(it);
}
void NetClient::emit(const std::string& t, const Json& d) {
  auto h = handlers_.find(t);
  if (h == handlers_.end() || h->second.empty()) return;
  std::vector<int> ids;
  for (auto& [id, fn] : h->second) ids.push_back(id);
  for (int id : ids) {   // (a handler may unsubscribe itself or others: looked up again each time)
    auto h2 = handlers_.find(t);
    if (h2 == handlers_.end()) return;
    auto f = h2->second.find(id);
    if (f == h2->second.end()) continue;
    Handler fn = f->second;
    try { fn(d); } catch (const std::exception&) { /* a handler's bad JSON access: ignored, as client.js catches */ }
  }
}

// ---------------------------------------------------------------- sending
bool NetClient::send(const std::string& t, const Json& d) {
  if (!isOpen()) return false;
  ws_->send(Json{{"t", t}, {"d", d}}.dump());
  return true;
}

void NetClient::request(const std::string& t, const Json& d, Reply cb, double timeoutS) {
  if (!isOpen()) {
    if (cb) { NetResult r; r.err = "offline"; cb(r); }
    return;
  }
  int id = nextId_++;
  double now = nowMs();
  pending_[id] = Pending{std::move(cb), now + timeoutS * 1000, now, timeoutS * 1000};
  ws_->send(Json{{"t", t}, {"d", d}, {"id", id}}.dump());
}

void NetClient::sendPresence(const Json& row) {
  if (isOpen() && ws_->buffered() < 65536) ws_->send(Json{{"t", "p"}, {"d", row}}.dump());
}

// ---------------------------------------------------------------- clock
void NetClient::ping() { send("ping", Json{{"c", nowMs()}}); }

void NetClient::onPong(const Json& d) {
  if (!d.is_object() || !d.contains("c") || !d.contains("s") || !d["c"].is_number() || !d["s"].is_number()) return;
  double now = nowMs(), c = d["c"].get<double>(), rtt = now - c;
  if (!(rtt >= 0) || rtt > 10000) return;
  double off = d["s"].get<double>() - (c + rtt / 2);
  // a sample that overlaps none of the kept ones: the clock jumped (a laptop that slept): start over from it
  bool none = !samples_.empty() && std::all_of(samples_.begin(), samples_.end(), [&](auto& s) { return std::fabs(s.second - off) > (s.first + rtt) / 2 + 25; });
  if (none) samples_.clear();
  samples_.push_back({rtt, off});
  if (samples_.size() > 10) samples_.erase(samples_.begin());
  auto best = samples_.front();
  for (auto& s : samples_) if (s.first < best.first) best = s;
  double target = best.second;
  offset_ = !synced_ || std::fabs(target - offset_) > 250 ? target : offset_ + (target - offset_) * 0.2;   // (small corrections ease in)
  rtt_ = rtt;
  synced_ = hasOffset_ = true;
}

// ---------------------------------------------------------------- connection
void NetClient::setStatus(const std::string& s) {
  if (s == status_) return;
  status_ = s;
  emit("status", Json{{"s", s}});
}

void NetClient::connect(const std::string& url, std::function<void(bool, const std::string&)> done) {
  url_ = url;
  wantOpen_ = true;
  tries_ = 0;
  downSince_ = 0;
  connectDone_ = std::move(done);
  openSocket();
}

void NetClient::openSocket() {
  retryAt_ = -1;
  setStatus(tries_ ? "reconnecting" : "connecting");
  if (ws_) ws_->close(4000, "stale");
  ws_ = std::make_unique<WebSocket>();
  opened_ = false;
  if (!ws_->open(url_)) {
    ws_.reset();
    if (tries_ || downSince_ > 0) { retry(); return; }
    wantOpen_ = false;
    setStatus("off");
    if (auto f = std::move(connectDone_)) { connectDone_ = nullptr; f(false, "Not a ws:// or wss:// address: " + url_); }
  }
}

void NetClient::dropSocket() {
  if (ws_) { ws_->close(4000, "stale"); ws_.reset(); }   // (4000: not a deliberate close: the server holds the player)
  opened_ = false;
  failPending("offline");
}

void NetClient::failPending(const std::string& code) {
  auto p = std::move(pending_);
  pending_.clear();
  for (auto& [id, q] : p) if (q.cb) { NetResult r; r.err = code; q.cb(r); }
}

void NetClient::onDrop(int code, const std::string& reason) {
  dropSocket();
  emit("close", Json{{"code", code}, {"reason", reason}});
  if (!wantOpen_ || code == 4001) {
    wantOpen_ = false;
    setStatus("off");
    if (code == 4001) emit("lost", Json{{"reason", reason.empty() ? "replaced" : reason}});
    return;
  }
  if (downSince_ <= 0) downSince_ = nowMs();
  retry();
}

void NetClient::retry() {
  if (!wantOpen_) return;
  if (nowMs() - downSince_ > GIVE_UP_MS) { wantOpen_ = false; setStatus("off"); emit("lost", Json{{"reason", "Connection lost"}}); return; }
  double wait = BACKOFF[std::min(tries_++, 4)];
  setStatus("reconnecting");
  retryAt_ = nowMs() + wait;
}

void NetClient::reconnect(const std::string& why) { if (ws_ && wantOpen_) onDrop(4000, why); }

void NetClient::simulateDrop() { if (ws_ && wantOpen_) onDrop(1006, "test drop"); }

void NetClient::close(const std::string& reason) {
  wantOpen_ = false;
  retryAt_ = -1;
  downSince_ = 0;
  tries_ = 0;
  if (ws_) { ws_->close(1000, reason); ws_.reset(); }
  opened_ = false;
  failPending("offline");
  connectDone_ = nullptr;
  setStatus("off");
}

void NetClient::update() {
  if (dispatching_) return;
  dispatching_ = true;
  double now = nowMs();
  // the socket's events
  WebSocket::Event e;
  while (ws_ && ws_->poll(e)) {
    if (e.type == WebSocket::Event::Type::Open) {
      opened_ = true;
      bool again = tries_ > 0 || downSince_ > 0;
      tries_ = 0;
      downSince_ = 0;
      samples_.clear();
      synced_ = false;
      lastMsg_ = lastCheck_ = now;
      setStatus("open");
      pingBurst_ = 5;   // (five quick pings for the clock, then one every 2 s)
      nextPing_ = now;
      emit("open", Json::object());
      if (again) emit("reopen", Json::object());
      if (auto f = std::move(connectDone_)) { connectDone_ = nullptr; f(true, ""); }
    } else if (e.type == WebSocket::Event::Type::Text) {
      lastMsg_ = now;
      Json m = Json::parse(e.text, nullptr, false);
      if (m.is_discarded() || !m.is_object() || !m.contains("t") || !m["t"].is_string()) continue;
      std::string t = m["t"].get<std::string>();
      Json d = m.contains("d") ? m["d"] : Json();
      if (t == "res") {
        int id = m.contains("id") && m["id"].is_number_integer() ? m["id"].get<int>() : -1;
        auto it = pending_.find(id);
        if (it == pending_.end()) continue;
        Reply cb = std::move(it->second.cb);
        pending_.erase(it);
        NetResult r;
        r.ok = m.value("ok", false);
        r.d = d.is_null() ? Json::object() : d;
        if (!r.ok) r.err = m.contains("err") && m["err"].is_string() ? m["err"].get<std::string>() : "error";
        if (cb) cb(r);
      } else if (t == "pong") onPong(d);
      else emit(t, d);
    } else {   // Close
      if (!opened_ && tries_ == 0 && downSince_ <= 0) {
        // the first connect failed: no reconnects (the menu shows why)
        ws_.reset();
        wantOpen_ = false;
        setStatus("off");
        if (auto f = std::move(connectDone_)) { connectDone_ = nullptr; f(false, e.text.empty() ? "Could not reach the server" : e.text); }
      } else onDrop(e.code, e.text);
      break;
    }
  }
  now = nowMs();
  // pings and the liveness check (nothing at all from the server for 20 s: the socket is dead)
  if (isOpen() && now >= nextPing_) {
    ping();
    if (pingBurst_ > 0) { pingBurst_--; nextPing_ = now + 120; }
    else {
      nextPing_ = now + PING_EVERY;
      bool late = now - lastCheck_ > PING_EVERY * 2 + 1000;   // (this check itself ran late: the game was busy, not the network)
      lastCheck_ = now;
      if (!late && now - lastMsg_ > STALE_MS) reconnect("stale");
    }
  }
  // request timeouts (a frame loop that stalled a while proves nothing: such a request gets 2 s more, up to 4x)
  std::vector<int> due;
  for (auto& [id, p] : pending_) if (now >= p.due) due.push_back(id);
  for (int id : due) {
    auto it = pending_.find(id);
    if (it == pending_.end()) continue;
    if (now - it->second.due > 1000 && now - it->second.start < it->second.timeout * 4) { it->second.due = now + 2000; continue; }
    Reply cb = std::move(it->second.cb);
    pending_.erase(it);
    if (cb) { NetResult r; r.err = "timeout"; cb(r); }
  }
  // a reconnect due
  if (retryAt_ >= 0 && now >= retryAt_ && wantOpen_) openSocket();
  dispatching_ = false;
}

} // namespace sl::net
