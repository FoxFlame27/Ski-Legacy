// Phase 6, the network layer's bottom: a byte stream to a host (TCP, optionally TLS), used by the WebSocket client
// (net/websocket.h) from its worker thread.
//
// This is the one file pair a console port replaces: the desktop implementation (socket_stream.cpp) is BSD sockets /
// Winsock with mbedTLS for TLS (certificates: the system's bundle where there is one, else the two Let's Encrypt roots
// built in, since the game's server uses a Let's Encrypt certificate). A Nintendo Switch build implements the same
// interface on nn::socket (or NEX's transport) with nn::ssl (the system's certificate store), and nothing above it
// changes. Nothing outside net/ includes a socket or TLS header.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace sl::net {

class Stream {
public:
  virtual ~Stream() = default;
  /// Connects (DNS, TCP, then the TLS handshake with certificate and host name checks when `tls`). Blocking, at most
  /// `timeoutMs`; on failure `err` says why.
  virtual bool connect(const std::string& host, int port, bool tls, int timeoutMs, std::string& err) = 0;
  /// Reads what is there: > 0 bytes, 0 nothing within `timeoutMs`, -1 closed or failed.
  virtual int read(uint8_t* buf, size_t n, int timeoutMs) = 0;
  /// Writes all of it (blocking); false if the connection failed.
  virtual bool writeAll(const uint8_t* p, size_t n) = 0;
  virtual void close() = 0;
};

/// The platform's stream (desktop: sockets + mbedTLS).
std::unique_ptr<Stream> createStream();

/// Fills `out` with `n` random bytes (the WebSocket key and frame masks; the TLS DRBG on desktop).
void randomBytes(uint8_t* out, size_t n);

/// SHA-1 + base64 for the WebSocket handshake (RFC 6455 Sec-WebSocket-Accept).
std::string sha1Base64(const std::string& s);
std::string base64(const uint8_t* p, size_t n);

} // namespace sl::net
