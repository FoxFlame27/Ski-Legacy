// Shared protocol constants (mirrors server/lib/server.js). See docs/multiplayer.md.
export const PROTO = 1;
export const MAX_PLAYERS = 50;

// presence state enum (row[9])
export const ST = { walk: 0, ski: 1, drive: 2, ride: 3, sit: 4, fly: 5, fall: 6 };
export const ST_NAMES = ['walk', 'ski', 'drive', 'ride', 'sit', 'fly', 'fall'];

// presence flag bits (row[12])
// (lights: a car's headlights / a helicopter's rotor at flight power; car: driving a car, x/y/z/yaw = the car's pose;
// wreck: your car crashing (drive.js crash: rolling over, sliding to a stop; lean = its roll); sled: driving a snowmobile (state drive), x/y/z/yaw = the snowmobile's pose on the snow, crouch / lean its pitch / roll)
export const F = { air: 1, tuck: 2, skisOn: 4, carry: 8, hasSkis: 16, moving: 32, lights: 64, car: 128, sled: 1 << 23, wreck: 1 << 24, paused: 1 << 25 }; // (paused: in the pause menu, a PAUSED label over them)
// A wipeout (state fall: thrown by a car, a crash, lying in the snow for the rescue): crouch = the body's pitch
// (somersault), lean = its roll; the flags (with the ski bits): F.air = still flying from the throw, bit 8 = went over
// to the left, bits 9-12 the tuck (0..15), 13-17 the get-up (0..31), 18-22 the tumble axis relative to yaw (1/32 turns)
export function fallFlags(side, air, ball, up, axis) {
  const q = (v, n) => Math.round(Math.min(1, Math.max(0, v || 0)) * n);
  const a = Math.round((Math.atan2(Math.sin(axis || 0), Math.cos(axis || 0)) / (Math.PI * 2)) * 32) & 31;
  return (air ? F.air : 0) | (side < 0 ? 256 : 0) | (q(ball, 15) << 9) | (q(up, 31) << 13) | (a << 18);
}
export function fallDecode(flags, out) {
  out.side = flags & 256 ? -1 : 1; out.air = !!(flags & F.air);
  out.ball = ((flags >> 9) & 15) / 15; out.getUp = ((flags >> 13) & 31) / 31;
  out.axis = (((flags >> 18) & 31) / 32) * Math.PI * 2;
  return out;
}

// presence row as received: [pid, ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags, vehicle, interior]
export const R = { pid: 0, ts: 1, x: 2, y: 3, z: 4, yaw: 5, vx: 6, vy: 7, vz: 8, st: 9, crouch: 10, lean: 11, flags: 12, veh: 13, int: 14 };

// interior ids carried in presence (null outdoors). Chalets: `chalet:${id}`.
export const INTERIOR = { skishop: 'skishop', carrental: 'carrental', chalet: (id) => `chalet:${id}` };

// server error codes -> words for the player
export const ERR_TEXT = {
  name_taken: 'That name is taken. Pick another one.',
  name_invalid: 'Names are 3-16 letters, digits, spaces, _ or -.',
  bad_login: 'This name is stored with a different key. Pick a new name.',
  proto: 'The server runs a different version. Update the game.',
  rate: 'Too many tries. Wait a moment.',
  money: 'Not enough money.',
  full: 'No free seat.',
  no_permission: 'The owner has not allowed it.',
  owner_away: 'The owner is not here.',
  taken: 'Somebody already owns it.',
  plate_taken: 'That plate is taken.',
  not_yet: 'Not available yet.',
  timeout: 'No answer.',
  pending: 'Still waiting for an answer.',
  already_renting: 'You already have a helicopter out.',
  offline: 'Not connected to the server.',
  owned: 'You already own one.',
  no_car: 'That car is not yours.',
  garage_full: 'Your garage is full. Sell a car first (MY CARS).',
  race_full: 'Race full (21/21) · wait for the next race, or do a Practice race (no prize).',
  in_race: 'You are in a race already.',
};
