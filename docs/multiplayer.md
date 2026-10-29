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
| `heliRent` / `heliReturn` | – | `{id, money}` · `not_yet {waitMs}`, `money`, `already_renting` |
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
- `flags` is `F`: `air 1, tuck 2, skisOn 4, carry 8, hasSkis 16`.

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
  shared GO.
- **Finish.** The session's result goes to `raceFinish`.
- **Results.** The server ranks the finishers and pays `reward × [1, 0.4, 0.15]`. It closes the race when everyone
  has finished, when an entrant leaves (counted as DNF), or 10 minutes after the start.

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
multiplayer.remotes                       // RemotePlayers: .players (Map pid -> Remote {name, pos, yaw, state, veh, interior, rig}), .byName(name)
multiplayer.sendLook()                    // after a character / outfit / skis change (main.js already calls it)
```

**Money.** Keep calling `spend(amount)` as in singleplayer. The money guard (`session.guardMoney`) handles it:

- any drop of `save.money` is sent as a checked `spend`;
- any rise that did not come from the server is undone.

Anything that grants ownership must use `multiplayer.buy(...)` instead of `spend` and a write to `save`. The ski
shop's skis, outfits, chalets and the rental car already do. The helicopter must switch to `heliRent`.

## Hooks for wave 2 (not done yet)

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

### Helicopter copies

- **Server side, done.** The `heli` state and `heliRent` are in place: `padAt` is when the pad next has a
  helicopter, which is 5 minutes after the last rental or immediately after a return.
- **Client side.**
  - Spawn a parked copy at the pad when `serverNow() ≥ padAt`.
  - Render the other players' rented copies from their presence (`state` fly).
  - Replace `spend(HELI_PRICE)` with `heliRent()`.

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

### Car passengers

- **Server side, done.** `perm {kind:'carRide', to}` sends the owner the Y/N prompt (`MpUI.ask`). After a yes,
  `seatClaim {k:'car', v: ownerName}` gives seat 1 (front) and then 2 and up (back). The owner holds seat 0.
- **Client side.**
  - Render each player's car from presence: `state` drive, and `veh` `car:Owner:0`.
  - Add the "ask the owner" prompt near a remote car.
  - Seat the passenger.
- **Profile.** The car config is in `MP.profile.cars[0]`. A wave-2 request to fetch another player's car config,
  or a look field for it, is still needed.

### Shared car rental and ski shop interiors

- **Done.**
  - The interior id is in presence (`skishop`, `carrental`, `chalet:N`).
  - `RemotePlayers` renders only the players in the same interior, in `mpScene(id)`.
  - Purchases go through the server.
- **To polish.**
  - The avatars stand at camera height minus 1.6 m and face the camera's direction.
  - Outfit previews are not shared.
  - The clerk dialogs are per client.

### Plate uniqueness UI

The car rental's rent goes through `multiplayer.rentCar(cfg)`: a taken custom plate is refused (`plate_taken`), and
a random plate is reissued if it is taken. The configurator should call `plateCheck` while the player types and
show the result.

### Race polish

- Use the grid `slot` from `raceStart`; everyone currently starts from the same gate position.
- Show the other racers' times from `raceProgress`.
- Add a results card from `raceResult`.

### Day counter

`save.day`, which the day pass uses, is still counted locally. Derive it from the world clock.
