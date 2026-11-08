// The desktop Stream (net/stream.h): BSD sockets (Linux, macOS) / Winsock (Windows), non-blocking with poll(), and
// mbedTLS for wss:// (TLS 1.2 / 1.3, the certificate chain and the host name verified). The CA certificates: the file
// in SSL_CERT_FILE, the system bundle (the usual Linux / BSD / macOS paths), the Windows "ROOT" store, and always the
// two Let's Encrypt roots (ca_roots.h) the game's server needs. A Switch build replaces this file (nn::socket, nn::ssl).
#include "net/stream.h"
#include "net/ca_roots.h"
#include <mbedtls/base64.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/sha1.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>
#include <psa/crypto.h>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <wincrypt.h>
using sock_t = SOCKET;
static constexpr sock_t kBad = INVALID_SOCKET;
static int lastErr() { return WSAGetLastError(); }
static bool wouldBlock(int e) { return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS || e == WSAEINTR; }
static void closeSock(sock_t s) { closesocket(s); }
static int pollSock(WSAPOLLFD* p, int ms) { return WSAPoll(p, 1, ms); }
using pollfd_t = WSAPOLLFD;
#else
#include <cerrno>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
using sock_t = int;
static constexpr sock_t kBad = -1;
static int lastErr() { return errno; }
static bool wouldBlock(int e) { return e == EAGAIN || e == EWOULDBLOCK || e == EINPROGRESS || e == EINTR; }
static void closeSock(sock_t s) { ::close(s); }
static int pollSock(pollfd* p, int ms) { return ::poll(p, 1, ms); }
using pollfd_t = pollfd;
#endif
#if defined(MSG_NOSIGNAL)
static constexpr int kSendFlags = MSG_NOSIGNAL;
#else
static constexpr int kSendFlags = 0;
#endif

namespace sl::net {
namespace {

using Clock = std::chrono::steady_clock;
int msLeft(Clock::time_point until) {
  auto d = std::chrono::duration_cast<std::chrono::milliseconds>(until - Clock::now()).count();
  return d < 0 ? 0 : int(d);
}

// ---------------------------------------------------------------- process-wide: sockets, PSA, the CA chain
struct Global {
  std::once_flag once;
  mbedtls_x509_crt ca;
  int caCount = 0;
  std::mutex rngMutex;
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context drbg;
  bool rngOk = false;
};
Global& global() {
  static Global g;
  std::call_once(g.once, [] {
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
    psa_crypto_init();   // (TLS 1.3 runs on PSA crypto)
    mbedtls_x509_crt_init(&g.ca);
    auto file = [&](const char* path) {
      if (!path || !*path) return;
      int before = 0;
      for (const mbedtls_x509_crt* c = &g.ca; c && c->raw.p; c = c->next) before++;
      if (mbedtls_x509_crt_parse_file(&g.ca, path) >= 0) {
        int after = 0;
        for (const mbedtls_x509_crt* c = &g.ca; c && c->raw.p; c = c->next) after++;
        g.caCount += after - before;
      }
    };
    file(std::getenv("SSL_CERT_FILE"));
    if (g.caCount == 0) {
      static const char* paths[] = {"/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem",
                                    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", "/etc/ssl/cert.pem", "/usr/local/etc/openssl/cert.pem",
                                    "/opt/homebrew/etc/openssl@3/cert.pem"};
      for (const char* p : paths) { file(p); if (g.caCount > 0) break; }
    }
#ifdef _WIN32
    if (HCERTSTORE store = CertOpenSystemStoreA(0, "ROOT")) {
      for (PCCERT_CONTEXT c = nullptr; (c = CertEnumCertificatesInStore(store, c)) != nullptr;)
        if (mbedtls_x509_crt_parse_der(&g.ca, c->pbCertEncoded, c->cbCertEncoded) == 0) g.caCount++;
      CertCloseStore(store, 0);
    }
#endif
    if (mbedtls_x509_crt_parse(&g.ca, reinterpret_cast<const unsigned char*>(kLetsEncryptRoots), sizeof kLetsEncryptRoots) >= 0) g.caCount += 2;
    mbedtls_entropy_init(&g.entropy);
    mbedtls_ctr_drbg_init(&g.drbg);
    static const char pers[] = "ski-legacy-net";
    g.rngOk = mbedtls_ctr_drbg_seed(&g.drbg, mbedtls_entropy_func, &g.entropy, reinterpret_cast<const unsigned char*>(pers), sizeof pers - 1) == 0;
  });
  return g;
}

std::string tlsError(int ret) {
  char b[160];
  mbedtls_strerror(ret, b, sizeof b);
  return b;
}

// ---------------------------------------------------------------- one connection
class SocketStream final : public Stream {
public:
  SocketStream() {
    mbedtls_ssl_init(&ssl_);
    mbedtls_ssl_config_init(&conf_);
    mbedtls_entropy_init(&entropy_);
    mbedtls_ctr_drbg_init(&drbg_);
  }
  ~SocketStream() override {
    close();
    mbedtls_ssl_free(&ssl_);
    mbedtls_ssl_config_free(&conf_);
    mbedtls_ctr_drbg_free(&drbg_);
    mbedtls_entropy_free(&entropy_);
  }

  bool connect(const std::string& host, int port, bool tls, int timeoutMs, std::string& err) override {
    Global& g = global();
    auto until = Clock::now() + std::chrono::milliseconds(timeoutMs);
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    std::string ps = std::to_string(port);
    if (int e = getaddrinfo(host.c_str(), ps.c_str(), &hints, &res); e != 0 || !res) { err = "Could not find the server (" + host + ")"; return false; }
    for (addrinfo* a = res; a && s_ == kBad; a = a->ai_next) {
      sock_t s = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
      if (s == kBad) continue;
      setNonBlocking(s);
      int r = ::connect(s, a->ai_addr, int(a->ai_addrlen));
      if (r != 0 && !wouldBlock(lastErr())) { closeSock(s); continue; }
      if (r != 0) {
        pollfd_t p{};
        p.fd = s;
        p.events = POLLOUT;
        if (pollSock(&p, msLeft(until)) <= 0) { closeSock(s); continue; }
        int so = 0;
        socklen_t sl = sizeof so;
        getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&so), &sl);
        if (so != 0) { closeSock(s); continue; }
      }
      s_ = s;
    }
    freeaddrinfo(res);
    if (s_ == kBad) { err = "Could not reach the server (" + host + ":" + ps + ")"; return false; }
    int one = 1;
    setsockopt(s_, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof one);
#ifdef SO_NOSIGPIPE
    setsockopt(s_, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
    if (!tls) return true;
    // TLS: the certificate chain against the CA bundle, the host name against the certificate
    static const char pers[] = "ski-legacy-tls";
    int ret = mbedtls_ctr_drbg_seed(&drbg_, mbedtls_entropy_func, &entropy_, reinterpret_cast<const unsigned char*>(pers), sizeof pers - 1);
    if (ret == 0) ret = mbedtls_ssl_config_defaults(&conf_, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
    if (ret != 0) { err = "TLS setup failed: " + tlsError(ret); close(); return false; }
    mbedtls_ssl_conf_authmode(&conf_, MBEDTLS_SSL_VERIFY_REQUIRED);
    mbedtls_ssl_conf_ca_chain(&conf_, &g.ca, nullptr);
    mbedtls_ssl_conf_rng(&conf_, mbedtls_ctr_drbg_random, &drbg_);
    if ((ret = mbedtls_ssl_setup(&ssl_, &conf_)) != 0 || (ret = mbedtls_ssl_set_hostname(&ssl_, host.c_str())) != 0) { err = "TLS setup failed: " + tlsError(ret); close(); return false; }
    mbedtls_ssl_set_bio(&ssl_, this, &SocketStream::bioSend, &SocketStream::bioRecv, nullptr);
    tls_ = true;
    for (;;) {
      ret = mbedtls_ssl_handshake(&ssl_);
      if (ret == 0) break;
      if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) {
        if (msLeft(until) <= 0 || !waitFor(ret == MBEDTLS_ERR_SSL_WANT_READ ? POLLIN : POLLOUT, msLeft(until))) { err = "TLS handshake timed out"; close(); return false; }
        continue;
      }
      uint32_t flags = mbedtls_ssl_get_verify_result(&ssl_);
      if (flags != 0 && flags != uint32_t(-1)) {
        char vb[256];
        mbedtls_x509_crt_verify_info(vb, sizeof vb, "", flags);
        err = std::string("The server's certificate was refused: ") + vb + (g.caCount ? "" : " (no CA certificates found)");
      } else err = "TLS handshake failed: " + tlsError(ret);
      close();
      return false;
    }
    return true;
  }

  int read(uint8_t* buf, size_t n, int timeoutMs) override {
    if (s_ == kBad) return -1;
    if (tls_) {
      if (mbedtls_ssl_get_bytes_avail(&ssl_) == 0 && !waitFor(POLLIN, timeoutMs)) return dead_ ? -1 : 0;
      for (int tries = 0; tries < 4; tries++) {
        int r = mbedtls_ssl_read(&ssl_, buf, n);
        if (r > 0) return r;
        if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return 0;
        if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) continue;   // (TLS 1.3: a ticket, not data)
        return -1;   // (0: closed; MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY; an error)
      }
      return 0;
    }
    if (!waitFor(POLLIN, timeoutMs)) return dead_ ? -1 : 0;
    auto r = ::recv(s_, reinterpret_cast<char*>(buf), int(n), 0);
    if (r > 0) return int(r);
    if (r < 0 && wouldBlock(lastErr())) return 0;
    return -1;
  }

  bool writeAll(const uint8_t* p, size_t n) override {
    if (s_ == kBad) return false;
    auto until = Clock::now() + std::chrono::seconds(10);
    while (n > 0) {
      if (tls_) {
        int r = mbedtls_ssl_write(&ssl_, p, n);
        if (r > 0) { p += r; n -= size_t(r); continue; }
        if ((r == MBEDTLS_ERR_SSL_WANT_WRITE || r == MBEDTLS_ERR_SSL_WANT_READ) && msLeft(until) > 0) { waitFor(r == MBEDTLS_ERR_SSL_WANT_READ ? POLLIN : POLLOUT, 50); continue; }
        return false;
      }
      auto r = ::send(s_, reinterpret_cast<const char*>(p), int(n), kSendFlags);
      if (r > 0) { p += r; n -= size_t(r); continue; }
      if (r < 0 && wouldBlock(lastErr()) && msLeft(until) > 0) { waitFor(POLLOUT, 50); continue; }
      return false;
    }
    return true;
  }

  void close() override {
    if (s_ == kBad) return;
    if (tls_ && !dead_) mbedtls_ssl_close_notify(&ssl_);
    closeSock(s_);
    s_ = kBad;
    tls_ = false;
  }

private:
  static void setNonBlocking(sock_t s) {
#ifdef _WIN32
    u_long nb = 1;
    ioctlsocket(s, FIONBIO, &nb);
#else
    fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) | O_NONBLOCK);
#endif
  }
  bool waitFor(short ev, int ms) {
    pollfd_t p{};
    p.fd = s_;
    p.events = ev;
    int r = pollSock(&p, ms);
    if (r < 0) { dead_ = true; return false; }
    if (r > 0 && (p.revents & (POLLERR | POLLNVAL))) { dead_ = true; return false; }
    return r > 0;   // (POLLHUP with data left still reads; the read then sees the end)
  }
  static int bioSend(void* ctx, const unsigned char* buf, size_t len) {
    auto* self = static_cast<SocketStream*>(ctx);
    auto r = ::send(self->s_, reinterpret_cast<const char*>(buf), int(len), kSendFlags);
    if (r >= 0) return int(r);
    return wouldBlock(lastErr()) ? MBEDTLS_ERR_SSL_WANT_WRITE : MBEDTLS_ERR_NET_SEND_FAILED;
  }
  static int bioRecv(void* ctx, unsigned char* buf, size_t len) {
    auto* self = static_cast<SocketStream*>(ctx);
    auto r = ::recv(self->s_, reinterpret_cast<char*>(buf), int(len), 0);
    if (r > 0) return int(r);
    if (r == 0) { self->dead_ = true; return MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY; }
    if (wouldBlock(lastErr())) return MBEDTLS_ERR_SSL_WANT_READ;
    self->dead_ = true;
    return MBEDTLS_ERR_NET_RECV_FAILED;
  }

  sock_t s_ = kBad;
  bool tls_ = false, dead_ = false;
  mbedtls_ssl_context ssl_;
  mbedtls_ssl_config conf_;
  mbedtls_entropy_context entropy_;
  mbedtls_ctr_drbg_context drbg_;
};

} // namespace

std::unique_ptr<Stream> createStream() { return std::make_unique<SocketStream>(); }

void randomBytes(uint8_t* out, size_t n) {
  Global& g = global();
  std::lock_guard<std::mutex> lock(g.rngMutex);
  if (g.rngOk && mbedtls_ctr_drbg_random(&g.drbg, out, n) == 0) return;
  static uint64_t x = uint64_t(Clock::now().time_since_epoch().count()) | 1;   // (no entropy source: still unique per run)
  for (size_t i = 0; i < n; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; out[i] = uint8_t(x); }
}

std::string base64(const uint8_t* p, size_t n) {
  std::string out(4 * ((n + 2) / 3) + 1, '\0');
  size_t olen = 0;
  mbedtls_base64_encode(reinterpret_cast<unsigned char*>(out.data()), out.size(), &olen, p, n);
  out.resize(olen);
  return out;
}

std::string sha1Base64(const std::string& s) {
  unsigned char h[20];
  mbedtls_sha1(reinterpret_cast<const unsigned char*>(s.data()), s.size(), h);
  return base64(h, sizeof h);
}

} // namespace sl::net
