// Shared protocol constants (mirrors server/lib/server.js). See docs/multiplayer.md.
export const PROTO = 1;
export const MAX_PLAYERS = 15;

// presence state enum (row[9])
export const ST = { walk: 0, ski: 1, drive: 2, ride: 3, sit: 4, fly: 5, fall: 6 };
export const ST_NAMES = ['walk', 'ski', 'drive', 'ride', 'sit', 'fly', 'fall'];

// presence flag bits (row[12])
// (lights: a car's headlights / a helicopter's rotor at flight power; car: driving a car, x/y/z/yaw = the car's pose)
export const F = { air: 1, tuck: 2, skisOn: 4, carry: 8, hasSkis: 16, moving: 32, lights: 64, car: 128 };

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
};
