// Phase 6: the multiplayer protocol's constants, mirroring src/net/protocol.js and server/lib/server.js exactly (see
// docs/multiplayer.md). Wire format: JSON text frames { t, d, id? }; answers { t: 'res', id, ok, d | err }.
#pragma once
#include <cmath>
#include <cstdint>
#include <string>

namespace sl::net {

constexpr int PROTO = 1;
constexpr int MAX_PLAYERS = 50;      // a world's size (server.js MAX_PLAYERS; it was 15 once)
constexpr double SEND_HZ = 12;       // presence rows a second (session.js)
/// the game's server (src/net/config.js DEFAULT_SERVER_URL): Caddy on the VPS terminates TLS and proxies /ws
inline const char* kDefaultServerUrl = "wss://138-199-163-183.sslip.io/ws";

/// presence state (row[9])
enum class St : int { Walk = 0, Ski = 1, Drive = 2, Ride = 3, Sit = 4, Fly = 5, Fall = 6 };

/// presence flag bits (row[12])
namespace F {
constexpr uint32_t air = 1, tuck = 2, skisOn = 4, carry = 8, hasSkis = 16, moving = 32, lights = 64, car = 128;
constexpr uint32_t flying = 1u << 22;          // the admin's fly mode (the server strips it from anyone else)
constexpr uint32_t sled = 1u << 23, wreck = 1u << 24, paused = 1u << 25;
constexpr uint32_t wanted = 7u << 26, wSearch = 1u << 29, wArrest = 1u << 30;
constexpr int W_SHIFT = 26;
}

/// presence row as received: [pid, ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags, vehicle, interior]
/// (sent: the same without pid, vehicle and interior: the server stamps those from its own records)
namespace R { constexpr int pid = 0, ts = 1, x = 2, y = 3, z = 4, yaw = 5, vx = 6, vy = 7, vz = 8, st = 9, crouch = 10, lean = 11, flags = 12, veh = 13, interior = 14; }

/// a wipeout's flags (state Fall): air, side (bit 8), tuck 0..15 (bits 9-12), get-up 0..31 (13-17), tumble axis relative
/// to yaw in 1/32 turns (18-22)
inline uint32_t fallFlags(int side, bool air, double ball, double up, double axis) {
  auto q = [](double v, int n) { return uint32_t(std::lround(std::fmin(1.0, std::fmax(0.0, v)) * n)); };
  uint32_t a = uint32_t(int(std::lround(std::atan2(std::sin(axis), std::cos(axis)) / (2 * 3.14159265358979323846) * 32)) & 31);
  return (air ? F::air : 0u) | (side < 0 ? 256u : 0u) | (q(ball, 15) << 9) | (q(up, 31) << 13) | (a << 18);
}
struct FallInfo { int side = 1; bool air = false; double ball = 0, getUp = 0, axis = 0; };
inline FallInfo fallDecode(uint32_t flags) {
  FallInfo o;
  o.side = flags & 256 ? -1 : 1;
  o.air = flags & F::air;
  o.ball = ((flags >> 9) & 15) / 15.0;
  o.getUp = ((flags >> 13) & 31) / 31.0;
  o.axis = (((flags >> 18) & 31) / 32.0) * 2 * 3.14159265358979323846;
  return o;
}

/// the server's error codes in words (protocol.js ERR_TEXT); unknown codes come back as they are
inline std::string errText(const std::string& code) {
  static const struct { const char* k; const char* v; } T[] = {
    {"name_taken", "That name is taken. Pick another one."},
    {"name_invalid", "Names are 3-16 letters, digits, spaces, _ or -."},
    {"bad_login", "This name is stored with a different key. Pick a new name."},
    {"proto", "The server runs a different version. Update the game."},
    {"rate", "Too many tries. Wait a moment."},
    {"money", "Not enough money."},
    {"full", "No free seat."},
    {"no_permission", "The owner has not allowed it."},
    {"owner_away", "The owner is not here."},
    {"taken", "Somebody already owns it."},
    {"plate_taken", "That plate is taken."},
    {"not_yet", "Not available yet."},
    {"timeout", "No answer."},
    {"pending", "Still waiting for an answer."},
    {"already_renting", "You already have a helicopter out."},
    {"offline", "Not connected to the server."},
    {"owned", "You already own one."},
    {"no_car", "That car is not yours."},
    {"garage_full", "Your garage is full. Sell a car first (MY CARS)."},
    {"race_full", "Race full (21/21) \xC2\xB7 wait for the next race, or do a Practice race (no prize)."},
    {"in_race", "You are in a race already."},
    {"name_reserved", "That name is reserved. Pick another one."},
    {"same_name", "That is already your name."},
    {"rename_wait", "You can rename only once every 15 days."},
    {"not_yours", "You can only change your own account."},
    {"confirm", "Type your name exactly to confirm."},
    {"no_account", "No multiplayer account on this device yet."},
  };
  for (auto& e : T) if (code == e.k) return e.v;
  return code.empty() ? std::string("Something went wrong") : code;
}

/// server.js validName: 3-16 of letters, digits, space, _ or -, with at least one letter or digit (after trimming)
inline bool validName(const std::string& s) {
  if (s.size() < 3 || s.size() > 16) return false;
  bool alnum = false;
  for (char c : s) {
    bool an = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    if (!an && c != ' ' && c != '_' && c != '-') return false;
    alnum = alnum || an;
  }
  return alnum;
}

} // namespace sl::net
