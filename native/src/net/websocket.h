// Phase 6: a small RFC 6455 WebSocket client (text frames, ping / pong, close codes) over net::Stream, for the game's
// Node server (`ws` on the other side; JSON text frames, no compression). One worker thread per connection does the
// blocking work (DNS, connect, the TLS and HTTP handshakes, reads, writes); the game thread only queues frames and
// polls events, so a slow network never stalls a frame. wss:// is TLS (mbedTLS on desktop), ws:// plain TCP (local
// servers). Also a one-shot HTTP GET (the server's /health) on the same streams.
#pragma once
#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace sl::net {

struct Url {
  bool tls = false;
  std::string host, path = "/";
  int port = 0;
  /// "ws://127.0.0.1:8787/ws", "wss://host/ws", "http(s)://host/health"; false if it is none of those
  bool parse(const std::string& s);
};

class WebSocket {
public:
  struct Event {
    enum class Type { Open, Text, Close } type = Type::Text;
    std::string text;   // Text: the message; Close: the reason (or what failed)
    int code = 0;       // Close: the close code (1006: dropped without a close frame / could not connect)
    bool opened = false;// Close: whether it had been open
  };
  WebSocket() = default;
  ~WebSocket();
  WebSocket(const WebSocket&) = delete;
  WebSocket& operator=(const WebSocket&) = delete;

  /// starts connecting (false if the URL is not ws:// / wss://)
  bool open(const std::string& url, int timeoutMs = 10000);
  /// queues a text frame (dropped when not open)
  void send(std::string text);
  /// a close frame with `code` (1000: leaving on purpose), then the socket ends; no more events after this
  void close(int code = 1000, const std::string& reason = "");
  /// the next event, if any (game thread)
  bool poll(Event& e);
  /// isOpen(); buffered(): bytes queued but not yet written (presence is skipped while this is high, as client.js does
  /// with bufferedAmount)

  bool isOpen() const { return st_->open.load(); }
  size_t buffered() const { return st_->buffered.load(); }

private:
  // shared with the worker thread, which is detached when the socket object goes: destroying a WebSocket never
  // waits for a slow DNS lookup or connect (the thread finishes on its own and frees this)
  struct State {
    std::mutex m;
    std::deque<Event> in;
    std::deque<std::string> out;
    std::atomic<bool> open{false}, quit{false}, closing{false}, silent{false};
    std::atomic<size_t> buffered{0};
    int closeCode = 1000;
    std::string closeReason;
    void push(Event e);
  };
  static void run(std::shared_ptr<State> st, Url u, int timeoutMs);
  std::shared_ptr<State> st_ = std::make_shared<State>();
  bool started_ = false;
};

/// A one-shot HTTP GET on a worker thread (the server's /health for the multiplayer screen).
class HttpGet {
public:
  ~HttpGet();
  void start(const std::string& url, int timeoutMs = 6000);
  bool done() const { return done_.load(); }
  bool busy() const { return th_.joinable() && !done_.load(); }
  int status = 0;          // HTTP status (0: no answer)
  std::string body, error;
private:
  std::thread th_;
  std::atomic<bool> done_{false};
};

} // namespace sl::net
