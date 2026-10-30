# Multiplayer

This document covers the multiplayer foundation: the server, the client networking layer, the protocol and the
hooks for the next wave of features. Singleplayer is unchanged whenever `isMP()` is false.

## Overview

| Piece | Where | What it does |
|---|---|---|
| Server | `server/` (Node 20+, `ws` only) | Accounts with unique names, the multiplayer saves, worlds of up to 50 players, the presence relay, and the shared registries. See `server/README.md` for deploy, logs and running it locally. |
| Mode flag | `src/net/mode.js` | `MP` and `isMP()`. The module has no imports, so any file can use it without an import cycle. |
| Server URL | `src/net/config.js` | `wss://138-199-163-183.sslip.io/ws`. Override it with `?mp=ws://localhost:8787/ws`. |
| Connection | `src/net/client.js` | The singleton `net`: an event emitter, requests that return promises, clock sync and reconnects. |
| Session | `src/net/session.js` | Login, the save swap, presence, the money guard, purchases, permissions, races and the transport helpers. It lives at `window.__game.multiplayer` (`main.js` holds it as `multiplayer`). |
| Remote players | `src/net/remote.js` | The avatars (the game's own skier rig and outfit), snapshot interpolation and name tags. |
| Remote vehicles | `src/net/vehicles.js` | The other players' cars and helicopter copies, the owner tags on parked ones, and the seat each avatar sits in. |
| Your car / rides | `src/net/carride.js` | Your car shown to everyone (and put back where you left it), "Ask <owner> for a ride", riding as a passenger. |
| Shared transport | `src/net/transit.js` | The trains, the express, the gondolas and chairlifts on the shared timelines; boarding waits for the real vehicle and claims a seat; seats go back when you get off; SPACE through `holdSkip`; the other riders' seats as drawn here. |
| Helicopter pad | `src/net/heli.js` | The pad's copy (shown when the server has one), renting through the server, returning, your copy shown to everyone. |
| Your snowmobile | `src/net/sled.js` | The snowmobile you drive shown to everyone: your presence row is its pose (`F.sled`), `veh {k:'sled', at}` where you left it. |
| Overlays | `src/net/ui.js` | The status pill, the race line, the speed-up line and the Y/N permission prompt. |
| Menu | `src/ui/menu.js` | PLAY offers SINGLEPLAYER or MULTIPLAYER. On the first multiplayer launch it asks for a name, then shows connecting, an error, or the world. |

### Flow

1. PLAY → MULTIPLAYER, then character select if you have not picked a character yet.
2. On the first launch only, the player types a name. `register` returns a secret token. The token is stored in
   `localStorage['ski-legacy-mp-accounts'][serverUrl]`.
3. `login {name, token}` puts the player in the fullest world that is not full, or creates a new one. A world
   with one player is fine.
4. The session swaps the server profile into `save`:
   - The singleplayer save is set aside, untouched, and `writeSave()` stops writing to localStorage.
   - Every AI system is switched off.
   - The player starts in Legacy Village.
5. The game ends multiplayer and restores the singleplayer save exactly as it was when any of these happens:
   - LEAVE MULTIPLAYER in the pause menu;
   - any return to the main menu;
   - a connection that cannot be restored. The menu then shows the reason.

### What is off in multiplayer (guarded by `isMP()` / `setAIOn(false)` in `main.js`)

- Traffic (`traffic.setOff`), including the drivers in the cars.
- The resort's skiers, walkers and villagers, and the far skiers (`npcs.setOff`).
- The crowds and fans (`crowds.group` is hidden and not updated).
- The snowcats (`snowcats.setOff`).
- The people waiting at the rail stations and the seated train passengers (`railway.noPassengers`,
  `express.noPassengers`).
- The AI race field. `modes.botCount = 0`, and races go through the server queue.
- The admin panel (`AdminPanel.refusal`).
- RESTART in a race.
- "Reset all progress".
- Saving where you were (`save.pos`).

The bus, trains, gondolas, chairlifts, helicopter and tow truck stay. Jobs and their NPCs stay as well, and job
pay goes through the server.

## Server rules

The server is authoritative for all of the following.

**Names**
- 3–16 characters from `[A-Za-z0-9_ -]`, with at least one letter or digit.
- Unique forever and case-insensitive. A name is bound to its token, and only a sha256 hash of the token is stored.
- At most 5 new names per IP address per hour.

**Money**
- The client never sets money.
- `spend` is checked against the balance.
- `earn` is accepted only from the `job` source (at most $6,000 per payout), the `secret` source (at most
  $10,000) and the `sell` source (furniture sold back in build mode: half its price, at most $2,000), and at most
  $60,000 per hour in total per account (a new login does not reset it).
- Race prizes are computed and paid by the server.
- Purchases use the server's prices in `server/lib/catalog.json`, which is generated from the game's own tables.
  `npm test` fails if the catalog drifts from the game.

**Uniqueness**
- Each player owns at most one chalet, for good (`profile.chalet`: its furniture and layout; `profile.chalet.id` is
  the plot it last stood on).
- A chalet **plot** (ids 0–63; the village has 18) is held only while its owner is online, across all worlds
  (`server.chalets`: plot → online owner). See **Chalet plots** below.
- Number plates are unique across all players. The plate key ignores spaces and hyphens, so `SKI 1` and `ski-1`
  are the same plate.
- AUTOHAUS (was the car rental): cars are bought for good. A player's profile `cars` is their garage (up to
  `catalog.garageMax` (10) cars, the same model more than once too: every car is told apart by its plate, each with
  the `price` paid; a buy beyond the cap: `garage_full {max}`); `cars[0]` is the one out (in their bay, shown to the others).
  `carSwitch` puts another owned car out for free; `carSell` sells one back for `catalog.carSell` (half) of what was
  paid and frees its plate; `carReturn` (a car wrecked by a police ram: not repaired) takes it out of the garage.
  A wreck's repair bill is `catalog.wreckRate` (10 %) of the car's list price, at least `catalog.wreckMin`; a car
  towed off a road pays the flat `catalog.wreckFee`.

**Profile fields the client may set** (`profileSet`, checked against a whitelist)

| Key | Rule |
|---|---|
| `character` | Any character. |
| `skis` | Must be owned. |
| `outfitsEquipped` | Must be owned. Owning a kit owns its pieces. |
| `chalet` | Furniture and layout of your own chalet; `id`, `owned` and `name` stay the server's. |
| `stats` | Only `topSpeed`, `longestJump` and `bestAir` (which only go up) and `distance`. |
| `records`, `secrets`, `dayPass`, `tickets` | Size-capped. |

**Worlds and connections**
- At most 50 players per world.
- **Grace period.** A connection that drops (code 1006, a heartbeat timeout, a proxy restart: anything but a
  deliberate close 1000 / 1001 / 1005 or a kick) keeps its player for 60 s from the last message (`GRACE_MS`):
  world slot, pid, seat, chalet plot, car, helicopter copy, grants and race entry. A login within that time resumes
  that player on the new socket (`login` answers `resumed: true`); the others never see a leave or join. After
  the grace period the player leaves for real.
- A reconnect after that, within 2 minutes, returns to the same world if it has room.
- Logging in while the name is online (another device) resumes it there; the old socket receives
  `bye {reason:'replaced'}` and close code 4001.
- The client (`net/client.js`) reconnects by itself with backoff (0.3 s to 5 s) for up to 2 minutes, logs in again
  and carries on where it was. Only 4001 or LEAVE MULTIPLAYER stops it. A socket that says nothing for 20 s is
  treated as dead, unless the check itself ran late (a main-thread hitch or a background tab proves nothing).
  Likewise a request's 10 s timeout that fires late waits a little longer (up to 40 s): its answer may be queued
  behind the hitch (on a slow machine, a login during the terrain load failed with "No answer.").

**Limits**
- General messages: 80 per second with a burst of 240. Over the limit a request is refused with `rate` (no debt:
  the limit recovers at once). Only a flood (over 400 refused in 10 s) is kicked, with code 1008, and the client
  reconnects.
- Presence: 30 per second with a burst of 60; extra frames are dropped.
- Frames are at most 256 KiB.
- A WebSocket ping goes out every 15 s; the browser answers it itself. A connection with no pong and no message for
  45 s is ended, and then gets the grace period. When a player leaves for real, the server releases their seat,
  race queue entry, helicopter copy, permission grants and chalet plot.
- Kicks and drops are logged: `kick <name>: <reason>`, `[drop] <name>: …`, `[-] <name>: no reconnect within the
  grace period`, `[+] <name> reconnected …`.

**Admin (the server machine only).** HTTP on the game port from 127.0.0.1, never through the proxy (a request with
`x-forwarded-for` is refused, 403): `/admin/players` (every account: name, money, online), `/admin/give?name=&amount=`
(online: `money {why:'gift'}` at once), `/admin/giveall?amount=`, `/admin/tp?name=&to=` (`adminTp {x, y, z, yaw, to}`;
the client refuses it while driving, flying, riding a train, the express, a bus, a sled or someone's car, inside, or
racing), `/admin/kick?name=` (`bye {reason:'kicked'}`, close 4001: no automatic reconnect; they may join again).

## The wire protocol

Messages are JSON text frames.

| Direction | Shape |
|---|---|
| Client → server | `{t, d, id?}`. A message with an `id` is a request. |
| Server → client | `{t, d}`, or a reply `{t:'res', id, ok:true, d}` / `{t:'res', id, ok:false, err, d?}`. |

On the client, `net.request(t, d)` resolves with `d`. On a refusal it throws an `Error` whose `.code` is `err` and
whose `.data` is `d`.

### Client → server

| t | d | Reply / effect |
|---|---|---|
| `ping` | `{c}` | `pong {c, s: serverMs}` (clock sync; `net` does this every 2 s) |
| `register` | `{name}` | `{name, token}` · errors `name_taken`, `name_invalid`, `rate` |
| `login` | `{v: 1, name, token, look?, plots?}` | `{proto, name, pid, now, profile, world, chalets: {plot: owner}, chaletPlot: {id, waiting, moved}, catalog}` · `bad_login`, `proto`. `plots`: the village's house plot ids (the server adopts a list of exactly `catalog.chalet.count` distinct ids 0–63; `catalog.chalet.plots` wins if it exists). |
| `p` | presence row (below) | relayed to the world at 15 Hz in `P` |
| `look` | `{c: characterId, o: outfit, s: skiId}` | broadcast `look {pid, look}` |
| `enter` | `{interior: id \| null}` | approved interior. `chalet:N` needs ownership, an unowned chalet, or a `chaletVisit` grant (single use: consumed when you leave) · `no_permission` |
| `jail` | `{seconds: 1–300, reason}` | `{jailUntil, reason, now}`: you are jailed until server time `jailUntil` (in the profile with `jailReason`; a new sentence never shortens the one you serve, at most 300 s from now). While jailed, `enter` anything but `'prison'` is refused with `jailed {jailUntil}` (3 s of slack for the client's clock). A login before `jailUntil` gets it in `profile` (the game puts you back in the cell for the rest); a login after it clears it · `bad_value` |
| `seatClaim` | `{k, v, n?, seat?}` | `{seat, v}`: the lowest free seat (or `seat` if it is free) · `full`, `no_permission`, `owner_away` |
| `seatRelease` | – | broadcast `seats` |
| `skip` | `{k, v, on, rate?, line?}` | the speed-up hold (below) · `not_aboard` |
| `heliRent` / `heliReturn` | – | `{id, money}` · `not_yet {waitMs}`, `money`, `already_renting` / `not_renting` |
| `veh` | `{k: 'car' \| 'heli', at?: [x, y, z, yaw], off?: true}` (a car also `tilt?: [pitch, roll]`, `wreck?: true`: a wreck as it lies, on its side or roof, dented and steaming; not stored) · `{k: 'tow', at, v, car}` (your tow truck on a job, ~6/s, not stored) · `{k: 'police', cars: [[x, y, z, yaw, v], ...]}` (the 1-2 patrol cars chasing you, game/police.js, ~6/s, not stored) · `{k: 'rescue', h: [x, y, z, yaw, pitch, roll, rpm] \| null, a: [x, y, z, yaw, v] \| null, s: 0-3, rope, l}` (the rescue helicopter / ambulance coming for you after a wipeout, net/rescue.js, ~6/s, not stored; s: 0 in the snow, 1 on the winch, 2 in the cabin, 3 in the ambulance) · `{k: 'sled', at?: [x, y, z, yaw]}` (the snowmobile you drive, net/sled.js: no `at` while you drive it, `at` where you left it; not stored) | `{veh}`: the vehicle you show (below), broadcast `veh` · `no_car`, `not_renting`, `bad_vehicle`, `bad_value` |
| `tow` | `{kind: 'wreck' \| 'tow', home: [x, y, z, yaw], bay?}` | `{money, fee, impound: {day, bay} \| null, at}`: the server's fee (`catalog.wreckFee`, once per tow; like a fine it may go below zero, down to `DEBT_FLOOR`; deeper, the truck still comes and `fee` is 0); the car's spot becomes `home`; `tow` also impounds it until the next world day · `no_car`, `busy`, `bad_kind`, `bad_value` |
| `towDone` | – | the tow record ends (the truck unloaded your car); your truck leaves the others' view |
| `raceJoin` / `raceLeave` | `{race}` (a course id) | queue state · `in_race`, `bad_race` |
| `raceFinish` | `{rid, raw: ms, pen: ms, time: ms \| null, dnf?}`, sent at the line | `{time}`. `raw` (the clock) is trusted only within 3 s of the server's own measurement since GO, else the server's time counts; `pen` (gate penalties) is added. Older clients send `time` only. |
| `raceProgress` | `{rid, gate, s}` (gates passed, metres along the course), twice a second | the live board; the furthest point is kept for a racer who drops out |
| `perm` | `{kind: 'carRide', to: name}` / `{kind: 'chaletVisit', ref: chaletId}` | resolves when the owner answers: `{allow, owner, kind, ref}` (30 s timeout → `allow:false, reason:'timeout'`) · `owner_away`, `pending`, `no_owner` |
| `permAnswer` | `{rid, allow}` | the owner's answer |
| `permRevoke` | `{kind, guest}` (grants are single use: one boarding of the car or one visit to the chalet; consumed on getting out / leaving, or after 60 s unused, then ask again) | the guest gets `permRevoked`, and is kicked from the car or chalet; the owner gets `guests` |
| `chaletFurniture` | `{id}` (a plot) | `{id, owner, chalet: {furniture, plan, layout}}` for its owner or a guest they let in · `no_owner`, `no_permission` |
| `spend` | `{amount, reason}` | `{money}` · `money`, `bad_amount` |
| `earn` | `{amount, source: 'job' \| 'secret' \| 'sell'}` | `{money}` · `rejected`, `cap` |
| `buy` | `{kind: 'skis' \| 'outfit', id}` · `{kind: 'chalet', id, name, meta}` · `{kind: 'car', cfg: {id, paint, interior, rims, plate, custom}}` (car: `{money, car, price, cars}`; several, the same model too, each its own plate; at most `catalog.garageMax`) | `{money, ...}` · `money`, `owned`, `taken {owner}`, `one_each`, `plate_taken {plate}`, `bad_plate`, `garage_full {max}` |
| `carReturn` | `{plate}` | `{cars}`: the car is gone from your garage (a police wreck), its plate free · `no_car` |
| `carSwitch` | `{plate}` | `{cars}`: that owned car is out (`cars[0]`, in your bay), no charge · `no_car` |
| `carSell` | `{plate}` | `{money, refund, cars}`: sold back for `catalog.carSell` of its price, plate free · `no_car`, `busy` (being towed) |
| `plateCheck` | `{plate}` | `{plate, free, mine}` |
| `plateIssue` | – | `{plate}` (a random free plate, not reserved; `buy` checks again) |
| `profileSet` | `{key, value}` | see the whitelist above |
| `profile` | – | `{profile}` |
| `chat` | `{text}` (≤ 200 characters) | broadcast `chat {pid, name, text}` (a hook; there is no UI yet) |

### Server → client events

| t | d |
|---|---|
| `P` | `[row, ...]`: the presence rows that changed since the last tick (15 Hz) |
| `join` / `leave` | `{pid, name, look, pres, interior, chalet}` / `{pid, name}` |
| `look` | `{pid, look}` |
| `clock` | `{hour, day, at, dayMs, weather}`. The hour at server time `at` advances 24 h per `dayMs` (16 min); `day` is the day at `at`, +1 at every midnight. The weather changes every 80–180 s. |
| `money` | `{v, why, delta}`: a server-side change, such as a race prize |
| `chalet` | `{id, owner}`: a chalet placed on plot `id`; `owner: null`: the plot is free again (its owner left). Sent to every world. |
| `chaletPlaced` | `{id}`: you were waiting for a plot; your chalet now stands on `id` |
| `guests` | `{kind: 'chaletVisit', names}`: the owner's guest list (sent when it changes) |
| `seats` | `{k, v, occ: [[seat, pid], ...]}` |
| `skip` | `{k, v, holding, aboard, active}` |
| `warp` | `{key: 'kind\|line', off, rate, since}` |
| `heli` | `{copies: [{id, name, since}], padAt, copyMs}` |
| `veh` | `{pid, k: 'car' \| 'heli' \| 'tow' \| 'police' \| 'rescue' \| 'sled', veh: {k, cfg?, id?, at?, v?, car?, cars?, h?, a?, s?, rope?, l?} \| null}` (also `vehs: {car, heli, tow, police, rescue, sled}` in `join` and the world snapshot) |
| `permAsk` | `{rid, kind, from, pid, ref, timeoutMs}` (to the owner) |
| `permClosed` / `permRevoked` / `kickInterior` / `seatLost` | the prompt went away / a grant was taken back / you must leave that interior / you were taken out of a car |
| `raceQueue` | `{race, n, names, startAt (0 = waiting for players), need: 2, waitMs}` |
| `raceStart` | `{rid, race, at (server ms of GO), grid: [{pid, name, slot}]}` |
| `raceProgress` / `raceResult` | `{rid, pid, name, time, dnf}` (a finish or a DNF) / `{rid, race, order: [{pid, name, place, time, prize, dnf, left, gate, s}]}`: every racer, distinct places |
| `raceBoard` | `{rid, race, rows: [{pid, name, place, time, dnf, left, gate, s, off}]}` twice a second while a race runs (`off`: connection dropped, held) |
| `bye` | `{reason: 'replaced' \| 'restart' \| 'shutdown'}` |

### Presence rows

The client sends about 12 per second and leaves no allocation per frame. Each row is:

`[ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags]`

- `ts` is the server time from `net.serverNow()`.
- `state` is `ST` from `protocol.js`: `walk 0, ski 1, drive 2, ride 3, sit 4, fly 5, fall 6`.
  In `fall` (a wipeout: a crash, thrown by a car or bus, lying there for the rescue) `crouch` is the body's pitch,
  `lean` its roll, and `flags` carry the tuck, the get-up, the side, the tumble axis and still-in-the-air
  (`protocol.js` `fallFlags` / `fallDecode`); the others pose the tumble from them (`net/remote.js` `fallPose`).
- `flags` is `F`: `air 1, tuck 2, skisOn 4, carry 8, hasSkis 16, moving 32, lights 64, car 128, sled 1<<23, wreck 1<<24`.
- **Driving a snowmobile** (`F.sled`, state `drive`, net/sled.js): `x/y/z/yaw` is the snowmobile's pose on the snow,
  `crouch` its pitch, `lean` its roll, `F.lights` its headlight. The others draw it (`vehicles.js updateSled`) and seat
  the rider astride it; parked, `veh {k:'sled', at}` keeps it where it was left (the parked ones round the resort are
  each client's own).
- **Driving your car** (`F.car`): `x/y/z/yaw` is the car's pose, `vx/vz` its velocity, `crouch` the steering angle,
  `lean` the body's roll, `F.lights` the headlights. Crashing (`F.wreck`, drive.js crash): `lean` includes the roll-over
  and `x/y/z` is the car's origin as it lies, so the others turn the car the same way (the driver hidden once it is
  over on its side); then `veh {k:'car', at, tilt, wreck}` keeps the wreck where it lies until the tow truck loads it.
- **Flying a helicopter** (`state` fly): `x/y/z/yaw` is the helicopter's pose, `crouch` its pitch, `lean` its roll,
  `F.lights` the rotor at flight power.
- **Riding in someone's car** (`state` ride, vehicle `car:Owner:seat`): `x/y/z` is your seat; the other clients seat
  you in that seat of the owner's car as they draw it.
- **Inside the ski shop, the car rental, a chalet or the prison**: the room's walker position (`pos`: y is the feet,
  on the stairs and the upper floors too), `yaw` and walking `vel` (zero while paused), not its camera (the camera
  swings off to the outfit preview, the clerk or the configured car). Sitting on your chalet's furniture
  (`seating.chalet.seat`): `state` sit at the seat. The others stand the avatar's feet on that height
  (`remote.js onFloor`), not on the world's terrain under the interior's coordinates.
- **Sitting** (benches, deck chairs, lifts: `state` sit) the others pose the seated rig at `x/y/z`, facing `yaw`.
  A remote standing still (paused with ESC, a stalled row) stands idle: the gait's speed never exceeds how fast the
  avatar really moves on your screen.

The server prepends the pid and appends the vehicle and interior from its own records:

`[pid, ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags, 'kind:id:seat' | 0, interiorId | 0]`

While seated, `x/y/z` is the seat position (`player.pos` is the seat). Inside an interior, the position is in that
interior's own scene and coordinates (its walker; without one, its camera minus 1.6 m). The game sends no presence until the server has approved the
interior change.

### The shared clock

`net.serverNow()` returns `performance.now() + offset`. The offset is the best (lowest-RTT) of the last 10 ping
samples. Small corrections ease in; jumps over 250 ms snap. Everything time-driven uses it:

- the world hour and weather (`multiplayer.hourNow()`; the session sets `env.hour` and the weather every frame);
- remote interpolation;
- the race start;
- the transport timelines (`multiplayer.lineTime(key)`).

### Speed-up on shared transport

Each line has one timeline:

`lineTime = serverNow + off + (rate − 1) × (serverNow − since)`

- A vehicle warps at the `rate` its riders send (use the singleplayer SPACE rate of that vehicle) only while every
  player seated in it holds SPACE. A player alone aboard warps it on their own.
- The whole line's timeline shifts with it. All clients compute every vehicle on that line from the same numbers,
  so the vehicles never desync.
- When the warp ends, the gained time stays in `off`.
- Several vehicles warping one line use the highest rate.
- Pass `line` to group the vehicles that share a timetable, for example all buses of one route. Leave it out to
  give each vehicle its own timeline.
- Your own helicopter ride or rescue, with only you aboard, keeps its local SPACE speed-up and needs none of this.

### Races

- **Queue.** E at a course's start house in multiplayer calls `raceJoin`.
- **Countdown.** It starts when 2 or more players are queued and lasts 45 s (more can join meanwhile).
  - A join during the countdown does not reset it.
  - If the queue drops below 2, the countdown is cancelled.
- **Immediate start.** Only a full field (50 queued) starts at once (with a 4 s lead); otherwise the 45 s countdown
  always runs, even when everyone in the world is queued.
- **Entry.** The server charges the entry fee at the start; the first race is free, as in singleplayer.
- **Start.** The client runs the normal race session with `bots: 0` and `syncGo`, so the countdown ends at the
  shared GO. Each racer stands on their own `slot` of the session's start grid (`grid: {slot, n}`: abreast, then in
  staggered rows), so nobody overlaps.
- **Live board.** Each client sends `raceProgress` (gate index + metres along the course) twice a second; the
  server broadcasts `raceBoard`: finishers by time, then everyone else by progress. The race session shows it in
  its own standings panel and POSITION (`n / field`); `MpUI`'s board is only for a racer without a session.
- **Finish.** The session sends `raceFinish` at the line (not at the results screen: the server checks the time
  against its own clock).
- **Giving up.** A racer with no race session for the race (left it from the pause menu, or it could not start
  on their screen because another session was on) sends a DNF (`session.updateBoard`), so nobody waits for them
  and they can queue again at once (otherwise `raceJoin` answers `in_race` until the race closes).
- **Dropouts.** A racer whose connection drops is held for the grace period (shown as reconnecting) and carries
  on after a reconnect. Gone for good (or LEAVE MULTIPLAYER): DNF, placed behind the finishers by how far they
  got. Back while the race still runs (a later login): the DNF is undone and they carry on.
- **Results.** The server is the single source of truth. It closes the race when everyone left in it has
  finished, 60 s after the first finisher (`RACE_AFTER_FIRST_MS`), or 10 minutes after the start. Every racer gets
  a distinct place: finishers by time (equal times: who was home first), then the rest by progress. Prize money
  `reward × [1, 0.4, 0.15]` by place, paid once per racer, to finishers only. The race session waits for
  `raceResult` (up to 75 s, the live standings stay up) and its own results screen shows the server's places,
  times and prizes (no podium). If the session is gone, the results card (`MpUI.results`) shows them instead. A
  result missed during a reconnect comes with the login (`lastRace`).

The HUD line shows `RACE QUEUE · 1/2 · waiting for players`, `… starting in 23s`, or `RACE · GO in 3s`.

## Client API for feature agents

```js
import { isMP, MP } from '../net/mode.js';
import { net } from '../net/client.js';
// the session object: main.js `multiplayer` (window.__game.multiplayer)

net.on('seats', (d) => {});            // any server event, see the table above; returns an unsubscribe fn
net.send('look', {...});               // fire and forget
await net.request('seatClaim', {...}); // request -> promise (throws Error with .code / .data)
net.serverNow();                       // the shared clock (ms)
net.on('relogin', fn);                 // reconnected (d.resumed: the server held everything; else seats, holds, permissions are gone): claim again

MP.active, MP.name, MP.pid, MP.world.players (Map pid -> {pid, name, chalet}), MP.profile, MP.catalog
MP.chalets   // {chaletId: ownerName} in every world
MP.seats     // Map 'kind|id' -> [[seat, pid], ...]
MP.warps     // Map 'kind|line' -> {off, rate, since}
MP.skip      // Map 'kind|id' -> {holding, aboard, active}
MP.heli      // {copies, padAt, copyMs}
MP.queues    // Map raceId -> {n, names, startAt}

multiplayer.claimSeat(k, v, {n, seat})    // -> {seat, v} | null (flashes the reason)
multiplayer.releaseSeat()
multiplayer.seatsOf(k, v)
multiplayer.holdSkip(k, v, holding, {rate, line})   // call every frame while seated; only changes are sent
multiplayer.skipLine(k, v)                // 'Hold SPACE to speed up (2/3 holding)' or ''
multiplayer.ui.setSkip(text)              // show it under the status pill
multiplayer.lineTime('bus|line1')         // the line's timeline in ms
multiplayer.hourNow() / dayNow()          // the world's hour / in-game day
multiplayer.transit                       // MpTransit (net/transit.js): railGate / expressGate / liftGate / busGate, seat(k, v, n, out)
multiplayer.attachTransit({railway, express, lifts, skibus, player, expressRate})   // main.js, once
multiplayer.chaletFurniture(plot)         // -> the owner's furniture (as their guest) | null
multiplayer.revokeGuest(name)             // permRevoke chaletVisit (the guest list's SEND OUT)
multiplayer.guests                        // your chalet's guest list (names)
multiplayer.heliRent() / heliReturn()
multiplayer.ask('carRide', {to: name}) / ask('chaletVisit', {ref: id})   // -> {allow}
multiplayer.setInterior(id | null)        // -> bool (the session also does this by itself from mpPose)
multiplayer.buy(kind, data) / buySkis / buyOutfit / buyChalet(h) / rentCar(cfg) / carEnded(cfg)
multiplayer.earn(amount, 'job' | 'secret')
multiplayer.raceJoin(id) / raceLeave()
multiplayer.remotes                       // RemotePlayers: .players (Map pid -> Remote {name, pos, yaw, state, veh, vcar, vheli, interior, rig}), .byName(name)
multiplayer.vehicles                      // RemoteVehicles: .cars (Map pid -> drawn car {group, t, x, z, yaw, posed}), carOf(pid), seatFor(remote, out)
multiplayer.carInteraction(pos)           // main.js findInteraction: "Ask <owner> for a ride"
multiplayer.late(dt, input)               // main.js after drive.update: riders in your car, you in theirs (E out)
multiplayer.plateCheck(plate) / plateIssue()   // -> {plate, free, mine} / a free plate (the configurator)
multiplayer.raceOthers()                  // the other racers who finished, as race-session rows
multiplayer.sendLook()                    // after a character / outfit / skis change (main.js already calls it)
```

**Money.** Keep calling `spend(amount)` as in singleplayer. The money guard (`session.guardMoney`) handles it:

- any drop of `save.money` is sent as a checked `spend`;
- any rise that did not come from the server is undone.

Anything that grants ownership must use `multiplayer.buy(...)` instead of `spend` and a write to `save`. The ski
shop's skis, outfits, chalets, the rental car and the helicopter (`heliRent`) do.

## Wave 2

### Shared trains, express, gondolas, chairlifts and buses (done)

`net/transit.js` (`multiplayer.transit`). Everyone in a world sees the same vehicle in the same place, and rides it
together, each in their own seat.

| System | Kind · vehicle ids | Timeline (`MP.warps` key) | Seats (`n`) | SPACE rate |
|---|---|---|---|---|
| Wolkenspitzbahn (`railway.js`) | `train` · `rail-0`, `rail-1` | `train\|rail` (both trains: one timetable) | `train.seatCount` (numbered through its cars) | ×6 |
| Legacy Express (`express.js`) | `express` · `express-e0..3`, `express-w0..3` | `express\|e` / `express\|w` (a direction each) | the lead car's seats (`express.seatCount`) | ×10 |
| Gondolas / chairlifts (`lifts.js`) | `gondola` / `chair` · `L<line>-<car>` (`line.mpId`: the lift's index) | `gondola\|L<line>` / `chair\|L<line>` | gondola 6 (two benches of 3), chair from the model's width | ×16 |
| Ski buses (`bus/bus.js` fleet) | `bus` · `bus:1..7` (`bus:0`, single player's own bus, is out of the game) | `bus\|R<round>` (each round, `route.mpLine`) | `line.seatCount` (bus:0's seat layout) | ×8 |

- **Timeline.** In multiplayer each system has an `mp` hook (`railway.mp`, `express.mp`, `lifts.mp`, set by
  `transit.start()` on entering, cleared on leaving) and places every vehicle from its line's time
  (`lineTime(key) / 1000`) instead of its own clock: the railway's `t`, the express's `u(train)` per direction, each
  lift's `placeAt(T)` (car k is where a car leaving s = 0 is after T + k/n of the loop's time: the same time gaps
  `spreadByTime` sets up). Nothing moves a vehicle for one player: the trains do not stop for you on the track, the
  express does not bring or hold a train, boarding does not shift the timetable, and Enter (skip to your stop) is off.
- **Buses.** `BusLine.setMp(hook)`: every fleet bus stands exactly where its round's timetable has it
  (`fleetTarget` on the round's shared time; nothing drives itself or overtakes), and `bus:0` is hidden. You ride a
  fleet bus on its round (`mpNextBus(from, to)`: a bus that stands at your stop and reaches your stop later on this
  way or the next) and get off when it stands at your stop; bus:0's cabin (seats, interior) is drawn in its place for
  you (`mpPose`), the fleet bus itself is hidden on your screen only.
- **Waiting.** Boarding goes through a gate in `main.js` (`railGate` / `expressGate` / `liftGate` / `busGate`):
  - Wolkenspitzbahn: if no train stands at your platform for your way (`railway.nextAt(station, up)`, off the
    timetable's boarding windows), you wait on the platform: "next train in 42 s" under the status pill. Walking off
    the platform (14 m) gives up. Every client runs the same timetable off `train|rail` (railroute.js `trainState`:
    both trains stop at both halts, Wolkensee and Adlerwald, both ways, and cross on the passing loop between them;
    the cycle `CYCLE` ≈ 691 s, a train every ~5.8 min), so a halt is the same window for everyone; E at a halt gets
    you off (`railway.leaveAtStop`) and the seat goes back as on arrival.
  - Express: its own platform wait (`express.waitFor` / `waiting`), unchanged, but a train can only be boarded with
    at least 4 s of its stop left.
  - Lifts: a seat in the next cabin or chair coming round is claimed at once; you board when it reaches the boarding
    point ("Your cabin comes in 2 s"). In multiplayer the cabins and chairs crawl through the bottom and top stations
    as they do through a mid-station (`LiftLine.setDwell`, on while `lifts.mp` is set; `speedAt`, `placeAt` and the
    countdown all use it), so the one you wait for visibly comes in and you get in once it has come round to the
    boarding point (or while it is still crawling out of the station).
  - Buses: you wait at the stop (25 m) for the next bus that goes your way ("Ski bus to X · next bus in 3 min"); it
    can be boarded with at least 4 s of its halt left. No round serving the trip: "No bus goes from A to B".
- **Seats.** When the vehicle is in, the gate claims a seat (`seatClaim {k, v, n, seat}`, `seat`: the one single
  player gives you, else the lowest free one) and only then boards (and charges the fare): the system takes the seat
  through `mpPick`. A full vehicle says "Full · wait for the next one" and is skipped. The seat goes back
  (`seatRelease`) as soon as you are off by any way; after a reconnect it is claimed again.
- **The other riders.** Their presence row carries `kind:id:seat` (the server's seat registry). `vehicles.seatFor`
  asks `transit.seat(k, v, n, out)` for that seat in the vehicle as drawn here (`railway.seatWorldAt`,
  `express.seatWorldAt`, `line.seatInto`, `busLine.seatWorldAt`), so they sit in it without lag (the presence position is the fallback).
- **Speed-up.** While you ride, `holdSkip(k, v, SPACE held, {rate, line})` every frame (only changes are sent); the
  pill shows `skipLine` ("Hold SPACE to speed up (2/3 holding)"). Alone aboard, SPACE works at once. Your own
  helicopter keeps its local SPACE.

### Helicopter copies (done)

- **The pad** (`net/heli.js`, `heli.mp` hooks in `game/heli.js`): the pad's helicopter is shown, solid and bookable
  only while `serverNow() ≥ padAt`. Otherwise the pad is empty and E says "the helicopter is out · next one in N min".
  When the server makes a copy available, it appears on the pad ("A helicopter is waiting at the helipad" when you
  are within 400 m).
- **Renting.** FLY calls `heliRent` (the server's price) instead of the local `spend`; the flight starts on its answer.
- **Returning.** When your helicopter is back on its pad (its pilot flew it home, or the flight was aborted),
  `heliReturn` is sent and the pad has a helicopter again for everyone.
- **Yours, seen by everyone.** Flying, your presence row is its pose (above). Parked out on the mountain:
  `veh {k:'heli', at}`. On its way home on its own: `veh {k:'heli', off:true}`.
- **Theirs** (`net/vehicles.js`): a `HeliModel` per renter, flying with their presence (pitch, roll, the rotor
  spinning up), or parked at `at` with "<name>'s helicopter" above it. Their avatar sits in the pilot's seat.

### Chalet plots (done)

Owning a chalet is for good; the plot it stands on is held only while you are online.

- **Leaving.** Your chalet leaves the world with you: `chalet {id, owner: null}` to everyone, guests inside are shown
  out, and the plot is for sale to anyone (`buy` checks only that no online owner holds it).
- **Coming back.** At login (`placeChalet`) your chalet goes back onto its old plot if it is free, else onto the free
  plot nearest it by id (`chaletPlot.moved`: "Your old plot was taken · your chalet is now Chalet 7"). The furniture
  is the owner's (`profile.chalet.furniture`), so it moves with the chalet. `profile.chalet.id` follows the plot.
- **No plot free.** `chaletPlot.waiting`: "Every chalet plot is taken · your chalet comes back when one is free". The
  next plot to free up goes to the owners waiting, first come first served (`chaletPlaced {id}`). While you wait,
  `save.chalet.id` is null (you own it, it is just not placed).
- **Logging in again** from elsewhere (`replaced`) keeps your plot.

### Chalet owner name tags and visiting (done)

- **Name tags** (`game/ownertags.js`, which already put your gold name over your own chalet): in multiplayer every
  placed chalet carries "<owner>'s chalet": yours in gold, the others' in the players' blue (hidden beyond 320 m and
  indoors). Single player is unchanged.
- **Visiting.** On the owner's Y, `mpVisitChalet` fetches the owner's furniture (`chaletFurniture`) into
  `chalets.guestFurniture`; build mode (`guestView`) shows it, to look at only. A chalet with no owner online shows
  empty.
- **Guest list.** Inside your own chalet with guests, the status pill lists them, each with SEND OUT (TAB frees the
  mouse): `permRevoke`, the guest is shown out (`kickInterior`). The list comes from the server (`guests`).

Also:

- `MP.chalets` holds the placed chalets (plot → online owner).
- `chalets.mp.ownerOf` already keeps a chalet that someone else owns off the market. It shows
  "Chalet 3 · Alice's chalet · ask to visit".
- E asks the owner: `mpVisitChalet` in `main.js`. On Y the guest enters with `chalets.viewing`. On
  `kickInterior` (the owner took the visit back, or left), `mpKickInterior` takes them out.

### Car passengers and everyone's cars (done)

- **Your car, seen by everyone** (`net/carride.js`): `veh {k:'car', at}` while it is parked (sent when it comes, goes,
  or stands somewhere new; checked once a second), `veh {k:'car'}` while you drive it (your presence row is then its
  pose). The server takes the look (model, paint, trim, rims, plate) from your profile, never from the client, and
  keeps the parked spot in `profile.cars[0].at`.
- **Leaving and coming back.** When you leave, your car (and helicopter) leaves everyone's view with you (`leave`).
  When you come back, your car is put back at `at` if that spot is free (`drive.clearAt` and no other player's car
  within 4.5 m); otherwise beside it, at the nearest free car park bay, or it stays in the rental's yard.
- **Owner tags.** A parked, empty car carries "<owner>'s car" above it, for everyone including the owner (hidden
  while it is driven, beyond 130 m, and indoors).
- **Their cars** (`net/vehicles.js`): built once per car from the same templates as the rental (`carTemplate`,
  `carInstance`, `dressCar`): the front wheels steer, the wheels roll, the lamps follow their headlights and the night.
- **Rides.** Within 2.2 m of another player's car (one moving at walking pace at most), E says "Ask <owner> for a
  ride". The owner gets "Allow <name> to get in your car?" (Y / N, 30 s). Allowed, `seatClaim {k:'car', v: owner,
  n: seats}` gives seat 1 (front passenger) or 2+ (the back). The passenger sits in that seat (`carSeats(t)`:
  carpeople.js's measured seats; 0 driver, 1 front passenger, 2/3 rear outboard, 4 rear middle, 5/6 the GLS's third
  row) of the car as it is drawn on their screen; R switches between first person from the seat and the chase view;
  E gets out by that seat's door. A `seatLost` (the owner took it back or left), a car gone for 1.5 s, or anything
  else moving you (a race start, a teleport) ends the ride.
- **Riders in your car.** Their avatars are posed after your car moved that frame (`remotes.late`), so they never
  lag it. The owner does not claim seat 0; `F.car` in the presence row marks the driver.
- **Not done.** Other players' cars have no colliders (you walk and drive through them).

### Shared car rental and ski shop interiors (done)

- The avatars in the ski shop and the car rental stand where their owner walks (the room's `pos`, on the right floor
  of the rental's mezzanine), face where they look and walk while they move; their name tags show indoors too.
- Outfit previews and the clerk dialogs are per client.

### Prison (done)

- `game/prison.js`: the village police station (its lot is planned last with the roads: `busRoads.prison`) and its
  interior, interior id `'prison'`: a visitor corridor along three cells behind bars. Jailed, you are in cell
  `pid % 3`; visitors (E at the station's door, "Visit the prison") walk the corridor. Everyone in `'prison'` sees
  everyone else there (`remote.js`), so visitors see the prisoners through the bars.
- `prison.jail(seconds, reason)` sends `jail`; the countdown runs on `net.serverNow()` against `jailUntil`. Leaving
  multiplayer while jailed is allowed: the next login (profile `jailUntil` in the future) puts you back in the cell.
  No admin panel, teleports, race starts or vehicles while jailed.

### Plate uniqueness UI (done)

In multiplayer the configurator's PLATE step checks what you type with `plateCheck` (280 ms after the last key) and
shows "<plate> is taken · type another"; RENT then says PLATE TAKEN and takes you back to the plate. RANDOM, and the
plate a new configuration starts with, come from `plateIssue` (a plate nobody has). `buy` checks again.

### Race polish (done)

See **Races** above: the grid slots, the live board, the results card.

### Day counter (done)

In multiplayer `save.day` (the day pass, the jobs) is the world clock's day: `clock.day` + the midnights since
`clock.at` (`multiplayer.dayNow()`, set every frame; `main.js` no longer counts days in multiplayer). Day 1 is
`DAY_EPOCH` (Oct 1 2026) and every world starts on the global day `dayFor(now)`, so a day pass is the same day in
every world.

### Tow truck (done)

- **Yours still runs** (`game/towtruck.js`; nothing in it checks `isMP()`, and it needs no traffic). It fetches only
  your own car and steers round the other players' cars (the shared colliders with `mp: true`) and the players on
  foot (`truck.mp.others`, set by `net/tow.js`). It ignores the other players' trucks (their colliders carry
  `tow: true`), so every client's truck keeps the one TOW bay.
- **Seen by everyone** (`net/tow.js`): while it is out, `veh {k:'tow', at, v, car}` about 6 times a second; `off`
  once it is parked. `net/vehicles.js updateTow` draws it with the same model (`buildTowTruck`), beacons flashing,
  eased toward the last pose run on at its speed; it is not drawn over your own parked truck in the TOW bay. With
  `car`, the owner's car rides on its bed (`bedLocal`); the owner sends that car without a spot meanwhile
  (`carride.js`: like driving). Your wreck stays your shown car until the truck has it (`carRental.towed`).
- **Fees.** `carrental.js wrecked` and `impound.js tow` call `carRental.mp.tow(kind, home, bay)` (the `tow` request)
  instead of taking the fee off the save.
- **Impound.** The day is the world's (`save.day` is set from the clock before the rental is placed); the server keeps
  `profile.cars[0].impound {day, bay}` and the login maps it into `save.impound`, so the car comes back locked in its
  impound bay (a bay with no other player's car in it) and `putBack` leaves it there. Others see it there with the
  owner's tag. The server lifts it at a login on a later world day.
- **Drops.** The tow sets the car's spot (`at`) to where the tow ends at once and ignores spots sent while it runs;
  a player gone mid-tow (or a restart) has the record ended there (`settleCar` on leaving and at login).

