// RFC 6455 client: the HTTP/1.1 upgrade (Sec-WebSocket-Key / Accept checked), masked client frames, fragmented
// messages, ping -> pong, the close handshake (code + reason), and 1006 for a connection that just dropped.
#include "net/websocket.h"
#include "net/stream.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <vector>

namespace sl::net {

bool Url::parse(const std::string& s) {
  size_t p = s.find("://");
  if (p == std::string::npos) return false;
  std::string scheme = s.substr(0, p);
  for (char& c : scheme) c = char(std::tolower(static_cast<unsigned char>(c)));
  if (scheme == "ws" || scheme == "http") tls = false;
  else if (scheme == "wss" || scheme == "https") tls = true;
  else return false;
  std::string rest = s.substr(p + 3);
  size_t slash = rest.find('/');
  std::string hp = slash == std::string::npos ? rest : rest.substr(0, slash);
  path = slash == std::string::npos ? "/" : rest.substr(slash);
  port = tls ? 443 : 80;
  if (!hp.empty() && hp[0] == '[') {   // [::1]:8787
    size_t e = hp.find(']');
    if (e == std::string::npos) return false;
    host = hp.substr(1, e - 1);
    if (e + 1 < hp.size() && hp[e + 1] == ':') port = std::atoi(hp.c_str() + e + 2);
  } else {
    size_t c = hp.rfind(':');
    host = c == std::string::npos ? hp : hp.substr(0, c);
    if (c != std::string::npos) port = std::atoi(hp.c_str() + c + 1);
  }
  return !host.empty() && port > 0 && port < 65536;
}

namespace {
// reads up to the end of the HTTP header block; `extra` gets anything after it
bool readHeaders(Stream& s, std::string& head, std::string& extra, int timeoutMs, const std::atomic<bool>& quit) {
  auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  uint8_t buf[2048];
  std::string acc;
  while (!quit.load() && std::chrono::steady_clock::now() < until) {
    int n = s.read(buf, sizeof buf, 50);
    if (n < 0) return false;
    acc.append(reinterpret_cast<char*>(buf), size_t(n));
    size_t e = acc.find("\r\n\r\n");
    if (e != std::string::npos) { head = acc.substr(0, e + 2); extra = acc.substr(e + 4); return true; }
    if (acc.size() > 65536) return false;
  }
  return false;
}
std::string lower(std::string s) { for (char& c : s) c = char(std::tolower(static_cast<unsigned char>(c))); return s; }
std::string header(const std::string& head, const std::string& name) {
  std::string l = lower(head), key = "\r\n" + lower(name) + ":";
  size_t p = l.find(key);
  if (p == std::string::npos) return "";
  p += key.size();
  size_t e = head.find("\r\n", p);
  std::string v = head.substr(p, e == std::string::npos ? std::string::npos : e - p);
  while (!v.empty() && (v.front() == ' ' || v.front() == '\t')) v.erase(v.begin());
  while (!v.empty() && (v.back() == ' ' || v.back() == '\t')) v.pop_back();
  return v;
}
std::string hostHeader(const Url& u) {
  bool v6 = u.host.find(':') != std::string::npos;
  std::string h = v6 ? "[" + u.host + "]" : u.host;
  if (u.port != (u.tls ? 443 : 80)) h += ":" + std::to_string(u.port);
  return h;
}
} // namespace

// ---------------------------------------------------------------- WebSocket
namespace {
bool writeFrame(Stream& s, int opcode, const std::string& payload) {
  std::vector<uint8_t> f;
  f.reserve(payload.size() + 14);
  f.push_back(uint8_t(0x80 | opcode));
  size_t n = payload.size();
  if (n < 126) f.push_back(uint8_t(0x80 | n));
  else if (n < 65536) { f.push_back(0x80 | 126); f.push_back(uint8_t(n >> 8)); f.push_back(uint8_t(n)); }
  else { f.push_back(0x80 | 127); for (int i = 7; i >= 0; i--) f.push_back(uint8_t(uint64_t(n) >> (8 * i))); }
  uint8_t mask[4];
  randomBytes(mask, 4);
  f.insert(f.end(), mask, mask + 4);
  for (size_t i = 0; i < n; i++) f.push_back(uint8_t(payload[i]) ^ mask[i & 3]);
  return s.writeAll(f.data(), f.size());
}
} // namespace

WebSocket::~WebSocket() {
  if (!st_->closing.load()) close(1001, "going away");
  st_->quit = true;
}

bool WebSocket::open(const std::string& url, int timeoutMs) {
  Url u;
  if (!u.parse(url) || started_) return false;
  started_ = true;
  std::thread(&WebSocket::run, st_, u, timeoutMs).detach();
  return true;
}

void WebSocket::send(std::string text) {
  if (!st_->open.load() || st_->closing.load()) return;
  std::lock_guard<std::mutex> l(st_->m);
  st_->buffered += text.size();
  st_->out.push_back(std::move(text));
}

void WebSocket::close(int code, const std::string& reason) {
  {
    std::lock_guard<std::mutex> l(st_->m);
    st_->closeCode = code;
    st_->closeReason = reason.substr(0, 120);
  }
  st_->silent = true;
  st_->closing = true;
}

bool WebSocket::poll(Event& e) {
  std::lock_guard<std::mutex> l(st_->m);
  if (st_->in.empty()) return false;
  e = std::move(st_->in.front());
  st_->in.pop_front();
  return true;
}

void WebSocket::State::push(Event e) {
  if (silent.load()) return;
  std::lock_guard<std::mutex> l(m);
  in.push_back(std::move(e));
}

void WebSocket::run(std::shared_ptr<State> st, Url u, int timeoutMs) {
  auto s = createStream();
  std::string err;
  Event ev;
  if (!s->connect(u.host, u.port, u.tls, timeoutMs, err)) { ev.type = Event::Type::Close; ev.code = 1006; ev.text = err; st->push(ev); return; }
  // the upgrade
  uint8_t keyRaw[16];
  randomBytes(keyRaw, sizeof keyRaw);
  std::string key = base64(keyRaw, sizeof keyRaw);
  std::string req = "GET " + u.path + " HTTP/1.1\r\nHost: " + hostHeader(u) + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                    "\r\nSec-WebSocket-Version: 13\r\nUser-Agent: SkiLegacyNative/0.6\r\n\r\n";
  std::string head, rest;
  if (!s->writeAll(reinterpret_cast<const uint8_t*>(req.data()), req.size()) || !readHeaders(*s, head, rest, timeoutMs, st->quit)) {
    ev.type = Event::Type::Close; ev.code = 1006; ev.text = "No answer from the server"; st->push(ev); return;
  }
  int status = 0;
  std::sscanf(head.c_str(), "HTTP/%*s %d", &status);
  if (status != 101 || header(head, "Sec-WebSocket-Accept") != sha1Base64(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")) {
    ev.type = Event::Type::Close; ev.code = 1006; ev.text = status ? "The server refused the connection (HTTP " + std::to_string(status) + ")" : "Not a WebSocket server";
    st->push(ev); return;
  }
  st->open = true;
  ev.type = Event::Type::Open;
  st->push(ev);

  std::vector<uint8_t> buf(rest.begin(), rest.end());
  std::string message;      // a fragmented text message being assembled
  bool inText = false;
  int closeCode = 1006;
  std::string closeWhy;
  bool sentClose = false, gotClose = false;
  auto closeSentAt = std::chrono::steady_clock::now();
  uint8_t rb[16384];
  for (;;) {
    // what the game queued
    std::deque<std::string> out;
    {
      std::lock_guard<std::mutex> l(st->m);
      out.swap(st->out);
    }
    bool ok = true;
    for (auto& t : out) { if (ok) ok = writeFrame(*s, 1, t); st->buffered -= t.size(); }
    if (!ok) break;
    if ((st->closing.load() || st->quit.load()) && !sentClose) {
      std::string p;
      int code;
      { std::lock_guard<std::mutex> l(st->m); code = st->closeCode; p = st->closeReason; }
      std::string payload{char((code >> 8) & 0xff), char(code & 0xff)};
      payload += p;
      writeFrame(*s, 8, payload);
      sentClose = true;
      closeSentAt = std::chrono::steady_clock::now();
      closeCode = code; closeWhy = p;
    }
    if (sentClose && (gotClose || std::chrono::steady_clock::now() - closeSentAt > std::chrono::milliseconds(1500))) break;
    // what came in
    int n = s->read(rb, sizeof rb, 10);
    if (n < 0) { if (!sentClose) { closeCode = 1006; closeWhy = "Connection lost"; } break; }
    buf.insert(buf.end(), rb, rb + n);
    // whole frames
    bool stop = false;
    for (;;) {
      if (buf.size() < 2) break;
      bool fin = buf[0] & 0x80;
      int op = buf[0] & 0x0f;
      bool masked = buf[1] & 0x80;
      uint64_t len = buf[1] & 0x7f;
      size_t hp = 2;
      if (len == 126) { if (buf.size() < 4) break; len = (uint64_t(buf[2]) << 8) | buf[3]; hp = 4; }
      else if (len == 127) { if (buf.size() < 10) break; len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | buf[2 + size_t(i)]; hp = 10; }
      uint8_t mk[4] = {0, 0, 0, 0};
      if (masked) { if (buf.size() < hp + 4) break; std::memcpy(mk, &buf[hp], 4); hp += 4; }
      if (len > (16u << 20)) { closeCode = 1009; closeWhy = "Message too big"; stop = true; break; }
      if (buf.size() < hp + len) break;
      std::string pl(reinterpret_cast<char*>(&buf[hp]), size_t(len));
      if (masked) for (size_t i = 0; i < pl.size(); i++) pl[i] = char(uint8_t(pl[i]) ^ mk[i & 3]);
      buf.erase(buf.begin(), buf.begin() + long(hp + len));
      if (op == 1 || (op == 0 && inText)) {
        if (op == 1) message.clear();
        message += pl;
        inText = !fin;
        if (fin) { Event t; t.type = Event::Type::Text; t.text = std::move(message); message.clear(); st->push(std::move(t)); }
      } else if (op == 8) {
        gotClose = true;
        int code = pl.size() >= 2 ? (uint8_t(pl[0]) << 8) | uint8_t(pl[1]) : 1005;
        if (!sentClose) {
          writeFrame(*s, 8, pl.substr(0, 2));
          sentClose = true;
          closeCode = code;
          closeWhy = pl.size() > 2 ? pl.substr(2) : "";
        }
        stop = true;
        break;
      } else if (op == 9) writeFrame(*s, 10, pl);   // ping -> pong (the server's heartbeat)
      // (op 2 binary, 10 pong: ignored)
    }
    if (stop) break;
  }
  st->open = false;
  s->close();
  Event c;
  c.type = Event::Type::Close;
  c.code = closeCode;
  c.text = closeWhy;
  c.opened = true;
  st->push(c);
}

// ---------------------------------------------------------------- HttpGet
HttpGet::~HttpGet() { if (th_.joinable()) th_.join(); }

void HttpGet::start(const std::string& url, int timeoutMs) {
  if (th_.joinable()) th_.join();
  done_ = false; status = 0; body.clear(); error.clear();
  th_ = std::thread([this, url, timeoutMs] {
    Url u;
    if (!u.parse(url)) { error = "bad URL"; done_ = true; return; }
    auto s = createStream();
    std::string err;
    if (!s->connect(u.host, u.port, u.tls, timeoutMs, err)) { error = err; done_ = true; return; }
    std::string req = "GET " + u.path + " HTTP/1.1\r\nHost: " + hostHeader(u) + "\r\nConnection: close\r\nUser-Agent: SkiLegacyNative/0.6\r\n\r\n";
    std::atomic<bool> never{false};
    std::string head, rest;
    if (!s->writeAll(reinterpret_cast<const uint8_t*>(req.data()), req.size()) || !readHeaders(*s, head, rest, timeoutMs, never)) { error = "No answer"; done_ = true; return; }
    std::sscanf(head.c_str(), "HTTP/%*s %d", &status);
    size_t want = std::string::npos;
    std::string cl = header(head, "Content-Length");
    if (!cl.empty()) want = size_t(std::atol(cl.c_str()));
    body = rest;
    uint8_t b[4096];
    auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while ((want == std::string::npos || body.size() < want) && std::chrono::steady_clock::now() < until) {
      int n = s->read(b, sizeof b, 50);
      if (n < 0) break;
      body.append(reinterpret_cast<char*>(b), size_t(n));
    }
    s->close();
    if (lower(header(head, "Transfer-Encoding")).find("chunked") != std::string::npos) {   // (Node answers chunked)
      std::string out;
      size_t p = 0;
      while (p < body.size()) {
        size_t e = body.find("\r\n", p);
        if (e == std::string::npos) break;
        size_t n = std::strtoul(body.substr(p, e - p).c_str(), nullptr, 16);
        if (n == 0 || e + 2 + n > body.size()) break;
        out += body.substr(e + 2, n);
        p = e + 2 + n + 2;
      }
      body = out;
    }
    done_ = true;
  });
}

} // namespace sl::net
