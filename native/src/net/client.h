// Phase 6: the connection to the multiplayer server, a port of src/net/client.js. One WebSocket (net/websocket.h), an
// event emitter for the server's { t, d } frames, requests with ids answered by { t: 'res', id, ok, d | err },
// clock sync (ping / pong every 2 s, the best of the last 10 samples by round trip, small corrections eased in),
// automatic reconnects with the same backoff (0.3, 1, 2, 3, 5 s ... for up to 120 s, then 'lost'), and the liveness
// check (nothing from the server for 20 s: reconnect). Everything runs on the game thread from update().
//
//   net.on("seats", [](const Json& d) { ... });                   // server events
//   net.send("look", {{"c", ...}});                               // fire and forget (false when not connected)
//   net.request("seatClaim", d, [](const NetResult& r) { ... });  // r.ok, r.d, r.err ('full', 'money', 'timeout', 'offline' ...)
//   net.serverNow()                                               // ms on the server's clock
// Local events: "open", "close" ({code, reason}), "status" ({s}), "lost" ({reason}), "reopen", "relogin".
#pragma once
#include "net/websocket.h"
#include <nlohmann/json.hpp>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace sl::net {

using Json = nlohmann::json;

struct NetResult {
  bool ok = false;
  Json d;               // the answer (ok), or the refusal's data (e.g. { money })
  std::string err;      // the server's error code, or 'timeout' / 'offline'
};

class NetClient {
public:
  using Handler = std::function<void(const Json&)>;
  using Reply = std::function<void(const NetResult&)>;

  NetClient();
  ~NetClient();

  // events
  int on(const std::string& t, Handler fn);
  void off(int id);
  void emit(const std::string& t, const Json& d);

  // sending
  bool isOpen() const { return ws_ && ws_->isOpen() && opened_; }
  bool send(const std::string& t, const Json& d);
  void request(const std::string& t, const Json& d, Reply cb, double timeoutS = 10);
  /// a presence row (protocol.h): sent as-is while the socket is not backed up
  void sendPresence(const Json& row);

  // clock
  double serverNow() const;   // ms
  double rtt() const { return rtt_; }
  bool synced() const { return synced_; }

  // connection
  /// opens the socket; `done(ok, error)` once it is open or could not be opened (then no reconnects)
  void connect(const std::string& url, std::function<void(bool, const std::string&)> done = {});
  /// the socket is open but useless (a login after a reconnect timed out): drop it and reconnect
  void reconnect(const std::string& why = "retry");
  /// for good (LEAVE MULTIPLAYER): close code 1000, the server removes the player at once
  void close(const std::string& reason = "leave");
  /// the frame: socket events, request timeouts, pings, the liveness check, reconnect timers
  void update();
  const std::string& status() const { return status_; }
  const std::string& url() const { return url_; }

  /// (tests) drop the socket as if the network went away (no close frame: the server holds the player for a minute)
  void simulateDrop();

private:
  double nowMs() const;        // monotonic ms
  void openSocket();
  void dropSocket();
  void onDrop(int code, const std::string& reason);
  void retry();
  void setStatus(const std::string& s);
  void ping();
  void onPong(const Json& d);
  void failPending(const std::string& code);

  struct Pending { Reply cb; double due = 0, start = 0, timeout = 0; };
  std::unique_ptr<WebSocket> ws_;
  std::map<std::string, std::map<int, Handler>> handlers_;
  std::map<int, std::string> handlerType_;
  int nextHandler_ = 1;
  std::map<int, Pending> pending_;
  int nextId_ = 1;
  std::string url_, status_ = "off";
  bool opened_ = false, wantOpen_ = false, hasOffset_ = false, synced_ = false;
  int tries_ = 0;
  double offset_ = 0, rtt_ = 0;
  std::vector<std::pair<double, double>> samples_;   // [rtt, offset]
  double nextPing_ = 0, lastMsg_ = 0, lastCheck_ = 0, downSince_ = 0, retryAt_ = -1;
  int pingBurst_ = 0;
  std::function<void(bool, const std::string&)> connectDone_;
  bool dispatching_ = false;
};

} // namespace sl::net
