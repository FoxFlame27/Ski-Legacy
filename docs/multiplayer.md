# Multiplayer

This document covers the multiplayer foundation: the server, the client networking layer, the protocol and the
hooks for the next wave of features. Singleplayer is unchanged whenever `isMP()` is false.

## Overview

| Piece | Where | What it does |
|---|---|---|
| Server | `server/` (Node 20+, `ws` only) | Accounts with unique names, the multiplayer saves, worlds of up to 15 players, the presence relay, and the shared registries. See `server/README.md` for deploy, logs and running it locally. |
| Mode flag | `src/net/mode.js` | `MP` and `isMP()`. The module has no imports, so any file can use it without an import cycle. |
| Server URL | `src/net/config.js` | `wss://138-199-163-183.sslip.io/ws`. Override it with `?mp=ws://localhost:8787/ws`. |
| Connection | `src/net/client.js` | The singleton `net`: an event emitter, requests that return promises, clock sync and reconnects. |
| Session | `src/net/session.js` | Login, the save swap, presence, the money guard, purchases, permissions, races and the transport helpers. It lives at `window.__game.multiplayer` (`main.js` holds it as `multiplayer`). |
| Remote players | `src/net/remote.js` | The avatars (the game's own skier rig and outfit), snapshot interpolation and name tags. |
| Remote vehicles | `src/net/vehicles.js` | The other players' cars and helicopter copies, the owner tags on parked ones, and the seat each avatar sits in. |
| Your car / rides | `src/net/carride.js` | Your car shown to everyone (and put back where you left it), "Ask <owner> for a ride", riding as a passenger. |
| Helicopter pad | `src/net/heli.js` | The pad's copy (shown when the server has one), renting through the server, returning, your copy shown to everyone. |
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
- `earn` is accepted only from the `job` source (at most $6,000 per payout) and the `secret` source (at most
  $10,000), and at most $60,000 per hour in total.
- Race prizes are computed and paid by the server.
- Purchases use the server's prices in `server/lib/catalog.json`, which is generated from the game's own tables.
  `npm test` fails if the catalog drifts from the game.

**Uniqueness**
- Each chalet (ids 0–63, 18 exist) has at most one owner across all worlds, and each player owns at most one chalet.
- Number plates are unique across all players. The plate key ignores spaces and hyphens, so `SKI 1` and `ski-1`
  are the same plate.
- Each player has one rental car at a time. Renting another car returns the old one and frees its plate.

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
- At most 15 players per world.
- A reconnect within 2 minutes returns to the same world if it has room.
- Logging in a second time replaces the first connection, which receives `bye {reason:'replaced'}`.

**Limits**
- General messages: 60 per second with a burst of 120. Far over the limit closes the connection with code 1008.
- Presence: 25 per second; extra frames are dropped.
- Frames are at most 64 KiB.
- A WebSocket ping goes out every 10 s. A client that misses a ping is dropped. On disconnect the server releases
  the player's seat, race queue entry, helicopter copy and permission grants.

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
| `login` | `{v: 1, name, token, look?}` | `{proto, name, pid, now, profile, world, chalets: {id: owner}, catalog}` · `bad_login`, `proto` |
| `p` | presence row (below) | relayed to the world at 15 Hz in `P` |
| `look` | `{c: characterId, o: outfit, s: skiId}` | broadcast `look {pid, look}` |
| `enter` | `{interior: id \| null}` | approved interior. `chalet:N` needs ownership, an unowned chalet, or a `chaletVisit` grant · `no_permission` |
| `seatClaim` | `{k, v, n?, seat?}` | `{seat, v}`: the lowest free seat (or `seat` if it is free) · `full`, `no_permission`, `owner_away` |
| `seatRelease` | – | broadcast `seats` |
| `skip` | `{k, v, on, rate?, line?}` | the speed-up hold (below) · `not_aboard` |
| `heliRent` / `heliReturn` | – | `{id, money}` · `not_yet {waitMs}`, `money`, `already_renting` / `not_renting` |
| `veh` | `{k: 'car' \| 'heli', at?: [x, y, z, yaw], off?: true}` | `{veh}`: the vehicle you show (below), broadcast `veh` · `no_car`, `not_renting`, `bad_vehicle`, `bad_value` |
| `raceJoin` / `raceLeave` | `{race}` (a course id) | queue state · `in_race`, `bad_race` |
| `raceFinish` | `{rid, time: ms \| null, dnf?}` | `{time}`. The time is trusted only within 3 s of the server's own measurement. |
| `perm` | `{kind: 'carRide', to: name}` / `{kind: 'chaletVisit', ref: chaletId}` | resolves when the owner answers: `{allow, owner, kind, ref}` (30 s timeout → `allow:false, reason:'timeout'`) · `owner_away`, `pending`, `no_owner` |
| `permAnswer` | `{rid, allow}` | the owner's answer |
| `permRevoke` | `{kind, guest}` | the guest gets `permRevoked`, and is kicked from the car or chalet |
| `spend` | `{amount, reason}` | `{money}` · `money`, `bad_amount` |
| `earn` | `{amount, source: 'job' \| 'secret'}` | `{money}` · `rejected`, `cap` |
| `buy` | `{kind: 'skis' \| 'outfit', id}` · `{kind: 'chalet', id, name, meta}` · `{kind: 'car', cfg: {id, paint, interior, rims, plate, custom}}` | `{money, ...}` · `money`, `owned`, `taken {owner}`, `one_each`, `plate_taken {plate}`, `bad_plate` |
| `carReturn` | `{plate}` | frees the plate |
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
| `clock` | `{hour, at, dayMs, weather}`. The hour at server time `at` advances 24 h per `dayMs` (16 min). The weather changes every 80–180 s. |
| `money` | `{v, why, delta}`: a server-side change, such as a race prize |
| `chalet` | `{id, owner}` (sent to every world) |
| `seats` | `{k, v, occ: [[seat, pid], ...]}` |
| `skip` | `{k, v, holding, aboard, active}` |
| `warp` | `{key: 'kind\|line', off, rate, since}` |
| `heli` | `{copies: [{id, name, since}], padAt, copyMs}` |
| `veh` | `{pid, k: 'car' \| 'heli', veh: {k, cfg?, id?, at?} \| null}` (also `vehs: {car, heli}` in `join` and the world snapshot) |
| `permAsk` | `{rid, kind, from, pid, ref, timeoutMs}` (to the owner) |
| `permClosed` / `permRevoked` / `kickInterior` / `seatLost` | the prompt went away / a grant was taken back / you must leave that interior / you were taken out of a car |
| `raceQueue` | `{race, n, names, startAt (0 = waiting for players), need: 2, waitMs}` |
| `raceStart` | `{rid, race, at (server ms of GO), grid: [{pid, name, slot}]}` |
| `raceProgress` / `raceResult` | `{rid, pid, name, time, dnf}` / `{rid, race, order: [{pid, name, place, time, prize, dnf?}]}` |
| `bye` | `{reason: 'replaced' \| 'restart' \| 'shutdown'}` |

### Presence rows

The client sends about 12 per second and leaves no allocation per frame. Each row is:

`[ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags]`

- `ts` is the server time from `net.serverNow()`.
- `state` is `ST` from `protocol.js`: `walk 0, ski 1, drive 2, ride 3, sit 4, fly 5, fall 6`.
- `flags` is `F`: `air 1, tuck 2, skisOn 4, carry 8, hasSkis 16, moving 32, lights 64, car 128`.
- **Driving your car** (`F.car`): `x/y/z/yaw` is the car's pose, `vx/vz` its velocity, `crouch` the steering angle,
  `F.lights` the headlights.
- **Flying a helicopter** (`state` fly): `x/y/z/yaw` is the helicopter's pose, `crouch` its pitch, `lean` its roll,
  `F.lights` the rotor at flight power.
- **Riding in someone's car** (`state` ride, vehicle `car:Owner:seat`): `x/y/z` is your seat; the other clients seat
  you in that seat of the owner's car as they draw it.
- **Inside the ski shop or the car rental**: the room's walker position (`pos`, floor height), `yaw` and walking
  `vel`, not its camera (the camera swings off to the outfit preview, the clerk or the configured car).

The server prepends the pid and appends the vehicle and interior from its own records:

`[pid, ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags, 'kind:id:seat' | 0, interiorId | 0]`

While seated, `x/y/z` is the seat position (`player.pos` is the seat). Inside an interior, the position is that
interior's own camera in its own scene, minus 1.6 m. The game sends no presence until the server has approved the
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
- **Countdown.** It starts when 2 or more players are queued and lasts 30 s.
  - A join during the countdown does not reset it.
  - If the queue drops below 2, the countdown is cancelled.
- **Immediate start.** The race starts at once (with a 4 s lead) when 15 players are queued, or when everyone in
  the world is queued and that is at least 2.
- **Entry.** The server charges the entry fee at the start; the first race is free, as in singleplayer.
- **Start.** The client runs the normal race session with `bots: 0` and `syncGo`, so the countdown ends at the
  shared GO. Each racer stands on their own `slot` of the session's start grid (`grid: {slot, n}`: abreast, then in
  staggered rows), so nobody overlaps.
- **Live board.** Under the status pill: every racer in race order, finished racers by time first, then everyone
  still racing by how far down the course they are (`track.nearestS`, twice a second).
- **Finish.** The session's result goes to `raceFinish`.
- **Results.** The server ranks the finishers and pays `reward × [1, 0.4, 0.15]`. It closes the race when everyone
  has finished, when an entrant leaves (counted as DNF), or 10 minutes after the start. The race's own results
  screen lists the racers who finished before you (`raceProgress`); `raceResult` then opens the results card
  (`MpUI.results`): everyone's place, time and prize money, from the server (click or 20 s closes it).

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
net.on('relogin', fn);                 // reconnected: seats, holds and permissions are gone, claim them again

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
multiplayer.hourNow()
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

### Shared bus, train, express and gondola seats

The speed-up server side is done. The client side is not:

- **Seats.** Call `claimSeat('bus', vehicleId, {n: seats})` when boarding and `releaseSeat()` when getting off.
  Sit the player in the seat it returns. Remote riders already render seated at their presence position
  (`state` ride or sit), which is right once the vehicles are on the shared timeline.
- **Timeline.** Drive the timetables from `multiplayer.lineTime(key)` instead of local time, so every client sees
  the same vehicle in the same place. The bus is `skibus.js` / `bus/bus.js`, the trains `railway.js` /
  `express.js`, the gondolas and chairlifts `lifts.js`.
- **Waiting.** Waiting for the bus must stay real: no teleport.
- **Speed-up.** Replace the local `input.down('Space')` fast-forward with `holdSkip(...)` plus `lineTime`, and show
  `skipLine` with `ui.setSkip`.

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

### Chalet owner name tags and visiting

What exists:

- `MP.chalets` holds the owners.
- `chalets.mp.ownerOf` already keeps a chalet that someone else owns off the market. It shows
  "Chalet 3 · Alice's chalet · ask to visit".
- E asks the owner: `mpVisitChalet` in `main.js`. On Y the guest enters with `chalets.viewing`. On
  `kickInterior` (the owner took the visit back), `mpKickInterior` takes them out.

To do:

- the name tag above each chalet;
- the owner's list of guests and `permRevoke`;
- the visitor's view of the owner's furniture. The server only stores it per profile; a `chaletFurniture`
  request does not exist yet.

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

### Plate uniqueness UI (done)

In multiplayer the configurator's PLATE step checks what you type with `plateCheck` (280 ms after the last key) and
shows "<plate> is taken · type another"; RENT then says PLATE TAKEN and takes you back to the plate. RANDOM, and the
plate a new configuration starts with, come from `plateIssue` (a plate nobody has). `buy` checks again.

### Race polish (done)

See **Races** above: the grid slots, the live board, the results card.

### Day counter

`save.day`, which the day pass uses, is still counted locally. Derive it from the world clock.
