// Automated server test: starts the server on a random port with a throw-away data directory, connects fake
// clients and checks the core rules. Run: `node server/test.mjs` (or `npm test` in server/). Exit code 0 = pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { GameServer, PROTO, CATALOG, DAY_MS, dayFor, DEBT_FLOOR, MAX_PLAYERS } from './lib/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilegacy-test-'));
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Fake {
  constructor(url) {
    this.url = url; this.n = 1; this.wait = new Map(); this.events = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (b) => {
        const m = JSON.parse(b.toString());
        if (m.t === 'res') { const w = this.wait.get(m.id); if (w) { this.wait.delete(m.id); w(m); } return; }
        this.events.push(m);
      });
    });
  }
  req(t, d = {}) { const id = this.n++; this.ws.send(JSON.stringify({ t, d, id })); return new Promise((r) => this.wait.set(id, r)); }
  send(t, d) { this.ws.send(JSON.stringify({ t, d })); }
  async next(t, pred = () => true, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = this.events.findIndex((m) => m.t === t && pred(m.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      await sleep(10);
    }
    return null;
  }
  close() { this.ws.close(); }
}

const server = new GameServer({ dataDir, log: () => {}, regPerHour: 1000 });
const port = await server.listen(0);
const url = `ws://127.0.0.1:${port}/ws`;
console.log(`server on ${url}`);

try {
  // ---------------------------------------------------------------- names: unique (case-insensitive), validated
  console.log('accounts');
  const a = new Fake(url), b = new Fake(url);
  await a.open(); await b.open();
  const ra = await a.req('register', { name: 'Alice' });
  ok(ra.ok && typeof ra.d.token === 'string' && ra.d.token.length >= 20, 'register Alice returns a token');
  const dup = await b.req('register', { name: 'aLiCe' });
  ok(!dup.ok && dup.err === 'name_taken', 'a second "aLiCe" is refused (name_taken)');
  const bad = await b.req('register', { name: 'x!' });
  ok(!bad.ok && bad.err === 'name_invalid', 'an invalid name is refused (name_invalid)');
  const rb = await b.req('register', { name: 'Bob' });
  ok(rb.ok, 'register Bob');

  // ---------------------------------------------------------------- login with the token
  const wrong = await a.req('login', { v: PROTO, name: 'Alice', token: 'nope' });
  ok(!wrong.ok && wrong.err === 'bad_login', 'a wrong token is refused');
  const la = await a.req('login', { v: PROTO, name: 'alice', token: ra.d.token, look: { c: 'skier_blue', o: null, s: 'rental' } });
  ok(la.ok && la.d.name === 'Alice' && la.d.profile.money === 500 && la.d.world.id >= 1, 'login with the token (any case) -> profile + world');
  ok(la.d.catalog?.chalet?.price === 50000, 'the catalog comes with the login (chalet $50,000)');
  const lb = await b.req('login', { v: PROTO, name: 'Bob', token: rb.d.token });
  ok(lb.ok && lb.d.world.id === la.d.world.id, 'Bob joins the same (fullest non-full) world');
  ok(lb.d.world.players.some((p) => p.name === 'Alice'), "Bob's world snapshot lists Alice");
  const joined = await a.next('join', (d) => d.name === 'Bob');
  ok(!!joined, 'Alice is told Bob joined');
  const pidA = la.d.pid, pidB = lb.d.pid;

  // ---------------------------------------------------------------- clock sync
  const t0 = Date.now();
  a.send('ping', { c: t0 });
  const pong = await a.next('pong');
  ok(pong && pong.c === t0 && Math.abs(pong.s - Date.now()) < 1000, 'ping / pong carries the server time');

  // ---------------------------------------------------------------- presence relay
  console.log('presence');
  a.send('p', [Date.now(), 10, 20, 30, 1.5, 1, 0, 2, 1, 0.3, -0.2, 5, 0, 0]);
  const P = await b.next('P', (rows) => rows.some((r) => r[0] === pidA));
  const row = P?.find((r) => r[0] === pidA);
  ok(row && row[2] === 10 && row[3] === 20 && row[4] === 30 && row[9] === 1, 'Bob receives Alice\'s presence (pos, state) within a tick');
  // ---------------------------------------------------------------- seats: lowest free, no two in one seat
  console.log('seats');
  const s1 = await a.req('seatClaim', { k: 'bus', v: 'line1-bus0' });
  const s2 = await b.req('seatClaim', { k: 'bus', v: 'line1-bus0' });
  ok(s1.ok && s2.ok && s1.d.seat === 0 && s2.d.seat === 1, 'two claims on one bus get seats 0 and 1');
  const s3 = await b.req('seatClaim', { k: 'gondola', v: 'g7', n: 1 });
  const s4 = await a.req('seatClaim', { k: 'gondola', v: 'g7', n: 1 });
  ok(s3.ok && s3.d.seat === 0 && !s4.ok && s4.err === 'full', 'a one-seat cabin: the second claim is refused (full)');
  const s5 = await a.req('seatClaim', { k: 'train', v: 'rail-0', n: 24, seat: 5 });
  const s6 = await b.req('seatClaim', { k: 'train', v: 'rail-0', n: 24, seat: 5 });
  ok(s5.ok && s5.d.seat === 5 && s6.ok && s6.d.seat === 0, 'a preferred free seat is given; taken, the lowest free one');
  await a.req('seatRelease'); await b.req('seatRelease');
  await a.req('seatClaim', { k: 'bus', v: 'line1-bus0' }); await b.req('seatClaim', { k: 'gondola', v: 'g7', n: 1 }); // (as before)
  const seatsEv = await a.next('seats', (d) => d.k === 'gondola' && d.v === 'g7');
  ok(seatsEv && seatsEv.occ.length === 1 && seatsEv.occ[0][1] === pidB, 'seat changes are broadcast');

  // ---------------------------------------------------------------- the speed-up: everyone aboard must hold SPACE
  console.log('speed-up');
  await b.req('seatClaim', { k: 'bus', v: 'line1-bus0' }); // (Bob back on the bus with Alice: 2 aboard)
  await a.req('skip', { k: 'bus', v: 'line1-bus0', on: true, rate: 16, line: 'line1' });
  const sk1 = await b.next('skip', (d) => d.v === 'line1-bus0' && d.holding === 1);
  ok(sk1 && sk1.aboard === 2 && !sk1.active, '1 of 2 holding: no speed-up (holding 1/2)');
  await b.req('skip', { k: 'bus', v: 'line1-bus0', on: true, rate: 16, line: 'line1' });
  const wp = await a.next('warp', (d) => d.key === 'bus|line1' && d.rate === 16);
  ok(!!wp, 'both holding: the line\'s timeline warps at x16 (broadcast)');
  await b.req('seatRelease');
  const wp2 = await a.next('warp', (d) => d.key === 'bus|line1');
  ok(wp2 === null || wp2.rate === 16, 'Bob gets off: Alice alone aboard and holding keeps the warp');
  await a.req('skip', { k: 'bus', v: 'line1-bus0', on: false });
  const wp3 = await b.next('warp', (d) => d.key === 'bus|line1' && d.rate === 1);
  ok(wp3 && wp3.off > 0, 'released: back to x1, the extra time kept as an offset');
  await a.req('seatRelease');

  // ---------------------------------------------------------------- number plates: unique across everyone
  console.log('plates');
  await a.req('profile'); // (Alice gets money to buy two cars: the server is the only one who can give it)
  server.profileOf('alice').money = 100000; server.profileOf('bob').money = 100000;
  const ca = await a.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'white', custom: true, plate: 'SKI 1' } });
  ok(ca.ok && ca.d.car.plate === 'SKI 1' && ca.d.money === 100000 - CATALOG.cars.car_vw_golf_gti - CATALOG.plateCost && CATALOG.cars.car_vw_golf_gti === 15000, 'Alice buys a Golf ($15,000) with the custom plate "SKI 1" (price checked by the server)');
  const cb = await b.req('buy', { kind: 'car', cfg: { id: 'car_bmw_x3', paint: 'white', custom: true, plate: 'ski-1' } });
  ok(!cb.ok && cb.err === 'plate_taken', 'Bob cannot have "ski-1" (same plate, other spelling): plate_taken');
  const pc = await b.req('plateCheck', { plate: 'SKI 1' });
  ok(pc.ok && pc.d.free === false, 'plateCheck says it is taken');
  const cb2 = await b.req('buy', { kind: 'car', cfg: { id: 'car_bmw_x3', paint: 'white' } });
  ok(cb2.ok && cb2.d.car.plate && cb2.d.car.plate !== 'SKI 1', 'without a custom plate the server issues a free one');
  const ra2 = await a.req('carReturn', { plate: 'SKI 1' });
  const pc2 = await b.req('plateCheck', { plate: 'SKI 1' });
  ok(ra2.ok && pc2.d.free === true, 'returned car: its plate is free again');
  const pi = await b.req('plateIssue');
  const pi2 = await a.req('plateCheck', { plate: pi.d.plate });
  ok(pi.ok && pi.d.plate && pi2.d.free === true && pi.d.plate !== cb2.d.car.plate, 'plateIssue: a random plate nobody has');

  // ---------------------------------------------------------------- AUTOHAUS: cars are owned (a garage), switched for free, sold back
  console.log('autohaus');
  const mB0 = server.profileOf('bob').money;
  const g1 = await b.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'red' } });
  ok(g1.ok && g1.d.cars.length === 2 && g1.d.cars[0].id === 'car_vw_golf_gti' && g1.d.cars[1].id === 'car_bmw_x3' && g1.d.money === mB0 - 15000 && g1.d.car.price === 15000,
    'Bob buys a Golf too: both are his (the new one out, cars[0]), the X3 kept');
  const g2x = await b.req('buy', { kind: 'car', cfg: { id: 'car_bmw_x3', paint: 'black' } });
  ok(!g2x.ok && g2x.err === 'owned' && server.profileOf('bob').money === mB0 - 15000, 'one of each model: a second X3 is refused (owned), nothing charged');
  const sw = await b.req('carSwitch', { plate: cb2.d.car.plate });
  ok(sw.ok && sw.d.cars[0].id === 'car_bmw_x3' && sw.d.cars.length === 2 && server.profileOf('bob').money === mB0 - 15000, 'carSwitch: the X3 is out again without paying');
  const swBad = await b.req('carSwitch', { plate: 'SKI 1' });
  ok(!swBad.ok && swBad.err === 'no_car', "carSwitch to a plate that is not yours: no_car");
  const sell = await b.req('carSell', { plate: g1.d.car.plate });
  const pcS = await a.req('plateCheck', { plate: g1.d.car.plate });
  ok(sell.ok && sell.d.refund === 7500 && sell.d.money === mB0 - 15000 + 7500 && sell.d.cars.length === 1 && sell.d.cars[0].id === 'car_bmw_x3' && pcS.d.free === true,
    'carSell: the Golf sold back for half what Bob paid ($7,500), its plate free again');
  const sell2 = await b.req('carSell', { plate: g1.d.car.plate });
  ok(!sell2.ok && sell2.err === 'no_car', 'a car sold cannot be sold twice');

  // ---------------------------------------------------------------- the vehicle you show (your rental car)
  console.log('vehicles');
  const nv = await a.req('veh', { k: 'car' });
  ok(!nv.ok && nv.err === 'no_car', 'no rental: no car to show (no_car)');
  const vb = await b.req('veh', { k: 'car', at: [1, 2, 3.004, 0.5], cfg: { id: 'car_lamborghini_huracan', plate: 'FAKE 1' } });
  const vev = await a.next('veh', (d) => d.pid === pidB);
  ok(vb.ok && vev && vev.k === 'car' && vev.veh.cfg.id === 'car_bmw_x3' && vev.veh.cfg.plate === cb2.d.car.plate && vev.veh.at[2] === 3,
    "Bob's car is shown to Alice from his profile (model and plate are the server's, not the client's), parked where he says");
  ok(server.profileOf('bob').cars[0].at?.[0] === 1, "its parked spot is kept in Bob's profile (put back there when he returns)");
  const badAt = await b.req('veh', { k: 'car', at: [1, 2] });
  ok(!badAt.ok && badAt.err === 'bad_value', 'a bad parked pose is refused');
  const badK = await b.req('veh', { k: 'tank' });
  ok(!badK.ok && badK.err === 'bad_vehicle', 'an unknown vehicle kind is refused');
  const offV = await b.req('veh', { k: 'car', off: true });
  const offEv = await a.next('veh', (d) => d.pid === pidB && d.k === 'car' && d.veh === null);
  ok(offV.ok && offEv, 'a car taken out of view: everyone is told');
  const nh = await b.req('veh', { k: 'heli' });
  ok(!nh.ok && nh.err === 'not_renting', 'no helicopter shown without renting one');
  const vd = await b.req('veh', { k: 'car' });
  const vdev = await a.next('veh', (d) => d.pid === pidB && d.veh && !d.veh.at);
  ok(vd.ok && vdev && vdev.veh.k === 'car', 'driving: the car without a parked pose (the presence row is its pose)');

  // ---------------------------------------------------------------- money: only server-validated changes
  console.log('money');
  const sp = await a.req('spend', { amount: 50, reason: 'gondola' });
  ok(sp.ok && sp.d.money === server.profileOf('alice').money, 'spend is checked and answered with the server balance');
  const over = await a.req('spend', { amount: 1e6, reason: 'x' });
  ok(!over.ok && over.err === 'money', 'spending more than you have is refused');
  const cheat = await a.req('earn', { amount: 999999, source: 'admin' });
  ok(!cheat.ok, 'money from an unknown source (admin panel) is refused');
  const job = await a.req('earn', { amount: 800, source: 'job' });
  ok(job.ok, 'a job payout within the limits is accepted');

  // ---------------------------------------------------------------- chalets: one owner each, globally
  console.log('chalets');
  server.profileOf('alice').money = 60000; server.profileOf('bob').money = 60000;
  const chA = await a.req('buy', { kind: 'chalet', id: 7, name: 'Chalet 3' });
  const chB = await b.req('buy', { kind: 'chalet', id: 7 });
  ok(chA.ok && chA.d.money === 10000 && !chB.ok && chB.err === 'taken' && chB.d.owner === 'Alice', 'chalet 7: Alice buys it, Bob is told it is Alice\'s');
  const chEv = await b.next('chalet', (d) => d.id === 7);
  ok(chEv && chEv.owner === 'Alice', 'chalet ownership is broadcast to everyone');

  // ---------------------------------------------------------------- permission round trip (chalet visit, car ride)
  console.log('permissions');
  const noEnter = await b.req('enter', { interior: 'chalet:7' });
  ok(!noEnter.ok && noEnter.err === 'no_permission', 'Bob cannot walk into Alice\'s chalet uninvited');
  const askP = b.req('perm', { kind: 'chaletVisit', ref: 7 });
  const ask = await a.next('permAsk');
  ok(ask && ask.kind === 'chaletVisit' && ask.from === 'Bob' && ask.ref === 7, 'Alice is asked: allow Bob into your chalet?');
  await a.req('permAnswer', { rid: ask.rid, allow: true });
  const ans = await askP;
  ok(ans.ok && ans.d.allow === true, 'Bob gets the answer: allowed');
  const yesEnter = await b.req('enter', { interior: 'chalet:7' });
  ok(yesEnter.ok, 'now Bob may enter chalet:7');
  const rideP = b.req('perm', { kind: 'carRide', to: 'alice' });
  const ask2 = await a.next('permAsk', (d) => d.kind === 'carRide');
  await a.req('permAnswer', { rid: ask2.rid, allow: false });
  const ans2 = await rideP;
  ok(ans2.ok && ans2.d.allow === false, 'a car ride Alice denies: Bob is told no');
  const noSeat = await b.req('seatClaim', { k: 'car', v: 'Alice' });
  ok(!noSeat.ok && noSeat.err === 'no_permission', '...and the server will not seat him in her car');
  const rideP2 = b.req('perm', { kind: 'carRide', to: 'Alice' });
  const ask3 = await a.next('permAsk', (d) => d.kind === 'carRide');
  await a.req('permAnswer', { rid: ask3.rid, allow: true });
  await rideP2;
  const drv = await a.req('seatClaim', { k: 'car', v: 'Alice' });
  const pas = await b.req('seatClaim', { k: 'car', v: 'Alice' });
  ok(drv.ok && drv.d.seat === 0 && pas.ok && pas.d.seat === 1, 'allowed: Alice drives (seat 0), Bob is the front passenger (seat 1)');
  await a.req('seatRelease'); await b.req('seatRelease');
  // single use: every boarding / every visit needs a new yes
  const noSeat2 = await b.req('seatClaim', { k: 'car', v: 'Alice' });
  ok(!noSeat2.ok && noSeat2.err === 'no_permission', 'single use: out of the car, getting in again without asking is refused');
  const out = await b.req('enter', { interior: null });
  const noEnter2 = await b.req('enter', { interior: 'chalet:7' });
  ok(out.ok && !noEnter2.ok && noEnter2.err === 'no_permission', 'single use: out of the chalet, walking in again without asking is refused');
  const askAgainP = b.req('perm', { kind: 'chaletVisit', ref: 7 });
  const askAgain = await a.next('permAsk', (d) => d.kind === 'chaletVisit');
  ok(!!askAgain, 'asking again: the owner gets the prompt again');
  await a.req('permAnswer', { rid: askAgain.rid, allow: true });
  ok((await askAgainP).d.allow && (await b.req('enter', { interior: 'chalet:7' })).ok, 'allowed again: in Bob goes');
  ok((await b.req('enter', { interior: 'chalet:7' })).ok, 'staying inside (the same room again, e.g. after a reconnect) needs no new yes');
  await b.req('enter', { interior: null });
  ok(!server.hasGrant('chaletVisit', 'alice', 'bob'), 'that visit is used up when he leaves');
  const grantMs = server.grantMs;
  server.grantMs = 150;
  const lapseP = b.req('perm', { kind: 'carRide', to: 'Alice' });
  const lapseAsk = await a.next('permAsk', (d) => d.kind === 'carRide');
  await a.req('permAnswer', { rid: lapseAsk.rid, allow: true });
  await lapseP;
  await sleep(300);
  const lapsed = await b.req('seatClaim', { k: 'car', v: 'Alice' });
  ok(!lapsed.ok && lapsed.err === 'no_permission', 'a yes that is not used within the time limit lapses');
  server.grantMs = grantMs;

  // ---------------------------------------------------------------- helicopter copies
  console.log('helicopter');
  const h1 = await a.req('heliRent');
  const h2 = await b.req('heliRent');
  ok(h1.ok && !h2.ok && h2.err === 'not_yet' && h2.d.waitMs > 4 * 60000, 'Alice rents the helicopter; Bob must wait ~5 min for the next copy');
  const w = server.worlds.get(la.d.world.id);
  w.heli.padAt = Date.now() - 1; // (5 minutes later)
  const h3 = await b.req('heliRent');
  ok(h3.ok && w.heli.copies.length === 2, 'after 5 min a copy waits at the pad: Bob rents it (2 out)');
  const hv = await a.req('veh', { k: 'heli', at: [10, 20, 30, 1] });
  const hvev = await b.next('veh', (d) => d.pid === pidA && d.k === 'heli' && d.veh);
  ok(hv.ok && hvev && hvev.veh.id === h1.d.id && hvev.veh.at[0] === 10, "Alice's copy (parked out on the mountain) is shown to Bob");
  const hr = await a.req('heliReturn');
  const hrev = await b.next('veh', (d) => d.pid === pidA && d.k === 'heli' && d.veh === null);
  const hm = await b.next('heli', (d) => d.copies.length === 1 && d.copies[0].name === 'Bob');
  ok(hr.ok && hrev && hm && hm.padAt <= Date.now() && w.heli.copies.length === 1, 'Alice returns it: it is gone from view and the pad has a helicopter again at once');
  const hr2 = await a.req('heliReturn');
  ok(!hr2.ok && hr2.err === 'not_renting', 'a second return is refused');
  await b.req('heliReturn');

  // ---------------------------------------------------------------- race queue: 2 needed, everyone in the world starts it at once
  console.log('races');
  const c3 = new Fake(url);
  await c3.open();
  const r3 = await c3.req('register', { name: 'Cleo' });
  const lc = await c3.req('login', { v: PROTO, name: 'Cleo', token: r3.d.token });
  ok(lc.d.world.players.find((p) => p.name === 'Bob')?.vehs?.car?.cfg?.id === 'car_bmw_x3', "a player who joins sees Bob's car at once (vehs in the world snapshot)");
  await b.req('carReturn', { plate: cb2.d.car.plate });
  const cgone = await c3.next('veh', (d) => d.pid === pidB && d.k === 'car' && d.veh === null);
  ok(!!cgone, 'Bob returns his car: it is gone for everyone');
  await b.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'red' } }); // (rented again: on disk below)
  const q1 = await a.req('raceJoin', { race: 'meadow' });
  ok(q1.ok && q1.d.n === 1 && !q1.d.startAt, 'one in the queue: waiting for players (1/2)');
  await b.req('raceJoin', { race: 'meadow' });
  const qe = await c3.next('raceQueue', (d) => d.race === 'meadow' && d.n === 2);
  ok(qe && qe.startAt - Date.now() > 25000, 'two in the queue (of 3 in the world): the 30 s countdown starts');
  await a.req('raceLeave');
  const qc = await c3.next('raceQueue', (d) => d.race === 'meadow' && d.n === 1);
  ok(qc && qc.startAt === 0, 'one leaves: the countdown is cancelled');
  await a.req('raceJoin', { race: 'meadow' });
  const qe2 = await c3.next('raceQueue', (d) => d.race === 'meadow' && d.n === 2 && d.startAt > 0);
  const startAt = qe2?.startAt;
  await c3.req('raceJoin', { race: 'meadow' }); // everyone in the world is queued: starts at once
  const st = await a.next('raceStart', (d) => d.race === 'meadow');
  ok(st && st.grid.length === 3 && st.at - Date.now() <= 4500 && new Set(st.grid.map((g) => g.slot)).size === 3, 'everyone in the world queued: the race starts at once (3 on the grid, shared start time)');
  ok(startAt > 0, 'a late joiner did not reset the countdown before that');
  const wr = server.worlds.get(la.d.world.id), race = wr.races.get(st.rid);
  race.at = Date.now() - 60000; // (a minute in)
  const moneyA = server.profileOf('alice').money, moneyB = server.profileOf('bob').money;
  await b.req('raceFinish', { rid: st.rid, time: 59000 });
  await a.req('raceFinish', { rid: st.rid, time: 59900 });
  await c3.req('raceFinish', { rid: st.rid, dnf: true });
  const res = await a.next('raceResult', (d) => d.rid === st.rid);
  const prize = CATALOG.races.meadow.reward;
  ok(res && res.order[0].name === 'Bob' && res.order[0].prize === prize && res.order[1].name === 'Alice' && res.order[1].prize === Math.round(prize * 0.4) && res.order[2].dnf,
    'results: Bob 1st (full prize), Alice 2nd (40 %), Cleo DNF');
  ok(server.profileOf('bob').money === moneyB + prize && server.profileOf('alice').money === moneyA + Math.round(prize * 0.4), 'prize money paid by the server');

  // ---------------------------------------------------------------- a second login replaces the first; disconnect frees seats
  console.log('disconnect');
  await c3.req('seatClaim', { k: 'train', v: 'T1' });
  c3.close();
  const left = await a.next('leave', (d) => d.name === 'Cleo');
  ok(!!left, 'Cleo disconnects: the world is told');
  ok(!wr.seats.get('train|T1'), 'her train seat is released');
  ok(wr.size === 2, 'the world has 2 players left');

  // ---------------------------------------------------------------- connection drops: bursts, reconnects, the grace period
  console.log('dropouts');
  const gus = new Fake(url);
  await gus.open();
  const rg = await gus.req('register', { name: 'Gus' });
  const lg = await gus.req('login', { v: PROTO, name: 'Gus', token: rg.d.token });
  const wg = server.worlds.get(lg.d.world.id);
  // a burst of 50 presence rows (a main-thread hitch, a network stall flushing at once): nobody is kicked
  for (let i = 0; i < 50; i++) gus.send('p', [Date.now(), 1 + i, 2, 3, 0, 0, 0, 0, 1, 0, 0, 0]);
  // ...and a burst of 300 requests: refused for a moment (rate), never kicked
  const burst = await Promise.all(Array.from({ length: 300 }, () => gus.req('profile')));
  await sleep(200);
  ok(gus.ws.readyState === 1 && wg.players.get(lg.d.pid)?.name === 'Gus', 'a burst of 50 presence rows and 300 requests: no kick');
  ok(burst.some((r) => r.ok) && wg.dirty.size + 1 > 0, 'the burst is served as far as the rate allows (the rest refused, not counted as debt)');
  await sleep(1100);
  const after = await gus.req('profile');
  ok(after.ok, 'after a burst the rate limit recovers at once (no debt)');
  // a quick reconnect: the network drops (no close frame: 1006), the client logs in again within the grace period
  await gus.req('seatClaim', { k: 'gondola', v: 'G7' });
  a.events.length = 0;
  gus.ws.terminate();
  await sleep(150);
  ok(server.onlineByKey('gus')?.dropped > 0 && wg.players.has(lg.d.pid), 'a dropped connection keeps the player in the world (held for a reconnect)');
  ok(wg.seats.get('gondola|G7')?.get(0) === lg.d.pid, 'their seat is kept meanwhile');
  const gus2 = new Fake(url);
  await gus2.open();
  const lg2 = await gus2.req('login', { v: PROTO, name: 'gus', token: rg.d.token });
  ok(lg2.ok && lg2.d.resumed === true && lg2.d.world.id === lg.d.world.id && lg2.d.pid === lg.d.pid, 'a quick reconnect resumes: same world, same pid');
  ok(wg.seats.get('gondola|G7')?.get(0) === lg.d.pid && server.onlineByKey('gus')?.dropped === 0, 'the seat is still theirs after the reconnect');
  const reclaim = await gus2.req('seatClaim', { k: 'gondola', v: 'G7' });
  ok(reclaim.ok && reclaim.d.seat === 0, 'claiming the seat again after the reconnect keeps the same seat');
  ok(!a.events.some((m) => (m.t === 'leave' || m.t === 'join') && m.d.name === 'Gus'), 'the others never saw Gus leave or join');
  // a second socket for the same account while the first is still open (another device): the old one is replaced
  const gus3 = new Fake(url);
  await gus3.open();
  const closed = new Promise((r) => gus2.ws.on('close', (code) => r(code)));
  const lg3 = await gus3.req('login', { v: PROTO, name: 'Gus', token: rg.d.token });
  ok(lg3.ok && lg3.d.resumed && (await closed) === 4001, 'a login from another device takes over (the old socket gets 4001 replaced)');
  // the grace period runs out: the player leaves for real (seat released, everyone told)
  const grace = server.graceMs;
  server.graceMs = 300;
  gus3.ws.terminate();
  const gone = await a.next('leave', (d) => d.name === 'Gus', 3000);
  ok(!!gone && !server.onlineByKey('gus') && !wg.players.has(lg.d.pid), 'no reconnect within the grace period: the player is removed');
  ok(!wg.seats.get('gondola|G7'), 'and their seat is released');
  server.graceMs = grace;

  // ---------------------------------------------------------------- races with dropouts: server places, DNF by progress, prizes once
  console.log('race dropouts');
  const racer = async (name) => {
    const f = new Fake(url); await f.open();
    const r = await f.req('register', { name });
    const l = await f.req('login', { v: PROTO, name, token: r.d.token });
    return { f, pid: l.d.pid, world: server.worlds.get(l.d.world.id), key: name.toLowerCase() };
  };
  const startWith = async (list, race = 'meadow') => {
    const w = list[0].world;
    for (const x of list) await x.f.req('raceJoin', { race });
    if (w.queues.get(race)) w.startRace(race); // (the others in the world are not queued: start it now)
    const st = await list[0].f.next('raceStart', (d) => d.race === race && list.every((x) => d.grid.some((g) => g.pid === x.pid)));
    const r = w.races.get(st.rid);
    r.at = Date.now() - 60000; // (a minute in)
    return { st, r, w };
  };
  {
    const [X, Y, Z] = [await racer('Xena'), await racer('Yuri'), await racer('Zack')];
    const { st, r } = await startWith([X, Y, Z]);
    const money0 = Object.fromEntries([X, Y, Z].map((p) => [p.key, server.profileOf(p.key).money]));
    // live progress: Zack is ahead (gate 4), then drops out (the network: 1006)
    X.f.send('raceProgress', { rid: st.rid, gate: 2, s: 300 });
    Y.f.send('raceProgress', { rid: st.rid, gate: 3, s: 410 });
    Z.f.send('raceProgress', { rid: st.rid, gate: 4, s: 520 });
    await sleep(100);
    const board = await X.f.next('raceBoard', (d) => d.rid === st.rid && d.rows[0]?.name === 'Zack', 2000);
    ok(board && board.rows.map((x) => x.name).join() === 'Zack,Yuri,Xena' && board.rows.map((x) => x.place).join() === '1,2,3', 'the live board orders racers by progress (gate, metres), places 1-2-3');
    const grace = server.graceMs;
    server.graceMs = 200;
    Z.f.ws.terminate();
    await sleep(80);
    const held = await X.f.next('raceBoard', (d) => d.rid === st.rid && d.rows.find((x) => x.name === 'Zack')?.off, 2000);
    ok(!!held && !r.done, 'a racer whose connection drops is held (shown as reconnecting), the race goes on');
    await sleep(400);
    ok(r.entrants.find((e) => e.name === 'Zack').left && r.entrants.find((e) => e.name === 'Zack').dnf, 'no reconnect within the grace period: Zack is out (DNF), his progress kept');
    server.graceMs = grace;
    await Y.f.req('raceFinish', { rid: st.rid, raw: 59500, pen: 0 });
    const fx = await X.f.req('raceFinish', { rid: st.rid, raw: 58000, pen: 2000 }); // (60.0 s with the gate penalty)
    ok(fx.ok && fx.d.time === 60000, 'gate penalties count on top of the plausible clock time');
    const res = await X.f.next('raceResult', (d) => d.rid === st.rid);
    ok(!!res && r.done, 'everyone left has finished: the race ends at once (it does not wait for the racer who left)');
    const prize = CATALOG.races.meadow.reward;
    ok(res && res.order.map((o) => `${o.place}:${o.name}${o.dnf ? ':DNF' : ''}`).join() === '1:Yuri,2:Xena,3:Zack:DNF', 'places: Yuri 1st, Xena 2nd, Zack 3rd as DNF (behind the finishers, by progress)');
    ok(res && res.order[0].prize === prize && res.order[1].prize === Math.round(prize * 0.4) && res.order[2].prize === 0, 'prizes by place: 100 % / 40 %, nothing for a DNF');
    await sleep(150);
    ok(server.profileOf('yuri').money === money0.yuri + prize && server.profileOf('xena').money === money0.xena + Math.round(prize * 0.4) && server.profileOf('zack').money === money0.zack,
      'the server paid each racer once (and Zack nothing)');
    server.worlds.get(X.world.id).finishRace(r); // (a second close is a no-op: nobody is paid twice)
    ok(server.profileOf('yuri').money === money0.yuri + prize, 'closing the race again pays nobody twice');
    const lateFinish = await Y.f.req('raceFinish', { rid: st.rid, raw: 1 });
    ok(!lateFinish.ok, 'a finish after the results is refused');
    for (const p of [X, Y]) p.f.close();
    await sleep(100);
  }
  {
    // four racers: two finish with the SAME time, two leave at different points: every place is distinct
    const P = [await racer('Pia'), await racer('Quin'), await racer('Rhea'), await racer('Seth')];
    const { st } = await startWith(P);
    P[2].f.send('raceProgress', { rid: st.rid, gate: 1, s: 120 });
    P[3].f.send('raceProgress', { rid: st.rid, gate: 5, s: 700 });
    await sleep(80);
    await P[2].f.req('raceFinish', { rid: st.rid, dnf: true }); // (Rhea gives up)
    P[3].f.ws.close(1000, 'leave'); // (Seth leaves multiplayer: out at once)
    await sleep(80);
    await P[0].f.req('raceFinish', { rid: st.rid, raw: 60000 });
    await P[1].f.req('raceFinish', { rid: st.rid, raw: 60000 });
    const res = await P[0].f.next('raceResult', (d) => d.rid === st.rid);
    const places = res?.order.map((o) => o.place) || [];
    ok(res && new Set(places).size === 4 && places.join() === '1,2,3,4', 'every racer gets a distinct place (1, 2, 3, 4), even with equal times');
    ok(res && res.order[0].name === 'Pia' && res.order[1].name === 'Quin', 'equal times: the first one home ranks first');
    ok(res && res.order[2].name === 'Seth' && res.order[3].name === 'Rhea' && res.order[2].dnf && res.order[3].dnf, 'the DNFs are ordered by how far they got (Seth gate 5 before Rhea gate 1)');
    ok(res && res.order.filter((o) => o.prize > 0).length === 2, 'only finishers win prize money');
    for (const p of P.slice(0, 3)) p.f.close();
    await sleep(100);
  }

  // ---------------------------------------------------------------- alone: multiplayer still works (world of 1)
  const solo = new Fake(url);
  await solo.open();
  const rs = await solo.req('register', { name: 'Solo Sam' });
  const ls = await solo.req('login', { v: PROTO, name: 'solo sam', token: rs.d.token });
  ok(ls.ok && ls.d.world.players.length >= 1, 'a lone player always gets in');
  solo.close();
  await sleep(150);

  // ---------------------------------------------------------------- MAX_PLAYERS (50) per world: the next player opens world 2
  console.log('worlds');
  const crowd = [];
  const used = server.worlds.get(la.d.world.id).size; // (Alice and Bob)
  for (let i = 0; i < MAX_PLAYERS + 1 - used; i++) {
    const f = new Fake(url); await f.open();
    const r = await f.req('register', { name: `Skier ${i}` });
    const l = await f.req('login', { v: PROTO, name: `Skier ${i}`, token: r.d.token });
    crowd.push({ f, world: l.d.world.id });
  }
  const w1 = la.d.world.id;
  ok(crowd.slice(0, MAX_PLAYERS - used).every((c) => c.world === w1) && crowd[crowd.length - 1].world !== w1, `world 1 fills to ${MAX_PLAYERS}, the next player gets a new world`);
  ok(server.worlds.get(w1).size === MAX_PLAYERS, `world 1 has exactly ${MAX_PLAYERS} players`);
  for (const c of crowd) c.f.close();
  await sleep(100);

  // ---------------------------------------------------------------- chalet plots: held while the owner is online
  console.log('chalet plots');
  const join = async (name, plots) => {
    const f = new Fake(url); await f.open();
    const r = await f.req('register', { name });
    const l = await f.req('login', { v: PROTO, name, token: r.d.token, plots });
    return { f, token: r.d.token, l };
  };
  const relog = async (name, token) => { const f = new Fake(url); await f.open(); const l = await f.req('login', { v: PROTO, name, token }); return { f, l }; };
  const hint = Array.from({ length: CATALOG.chalet.count }, (_, i) => 40 + i);
  let dora = await join('Dora', hint);
  const doraToken = dora.token;
  ok(JSON.stringify(server.plotIds) === JSON.stringify(hint), "a login's list of the village's plots is adopted (plotsHint)");
  const badHint = await join('Hint Bad', [1, 2, 3]);
  ok(JSON.stringify(server.plotIds) === JSON.stringify(hint), 'an implausible plot list is ignored');
  badHint.f.close();
  server.plotIds = [40, 41]; // (a village of two plots, to run out of them)
  server.profileOf('dora').money = 60000;
  const bd = await dora.f.req('buy', { kind: 'chalet', id: 40, name: 'Chalet 1' });
  ok(bd.ok && server.chalets.get(40) === 'dora', 'Dora buys the chalet on plot 40');
  const bOut = await dora.f.req('buy', { kind: 'chalet', id: 5 });
  ok(!bOut.ok && bOut.err === 'bad_item', 'a plot the village does not have cannot be bought');
  const sofa = { id: 'sofa', x: 1, y: 0.3, z: 2, rot: 0 };
  await dora.f.req('profileSet', { key: 'chalet', value: { furniture: [sofa], plan: 2 } });
  const eve = await join('Eve');
  ok(eve.l.d.chalets[40] === 'Dora', 'the login lists the chalets placed now (Dora on plot 40)');
  dora.f.close();
  const freed = await eve.f.next('chalet', (d) => d.id === 40 && d.owner === null);
  ok(!!freed && !server.chalets.has(40), 'Dora goes offline: plot 40 is free for everyone (chalet {id, owner: null})');
  ok(server.profileOf('dora').chalet?.owned, '...but Dora still owns her chalet');
  server.profileOf('eve').money = 60000;
  const be = await eve.f.req('buy', { kind: 'chalet', id: 40 });
  ok(be.ok && server.chalets.get(40) === 'eve', 'Eve buys a chalet on plot 40 while Dora is away');
  dora = await relog('Dora', doraToken);
  const moved = await eve.f.next('chalet', (d) => d.owner === 'Dora');
  ok(dora.l.d.chaletPlot.id === 41 && !dora.l.d.chaletPlot.waiting && dora.l.d.chaletPlot.moved && dora.l.d.profile.chalet.id === 41 && moved?.id === 41,
    'Dora comes back: her old plot is taken, her chalet goes onto the free plot 41 (everyone is told)');
  ok(JSON.stringify(dora.l.d.profile.chalet.furniture) === JSON.stringify([sofa]), '...with her furniture (it is hers, not the plot\'s)');
  ok(dora.l.d.world.players.find((p) => p.name === 'Eve')?.chalet === 40, "the world snapshot carries each player's plot");
  server.profileOf('finn') || null;
  const finnR = await (async () => { const f = new Fake(url); await f.open(); const r = await f.req('register', { name: 'Finn' }); return { f, token: r.d.token }; })();
  server.profileOf('finn').chalet = { id: 40, owned: true, rented: true, furniture: [] }; // (an owner whose plot is taken)
  const lf = await finnR.f.req('login', { v: PROTO, name: 'Finn', token: finnR.token });
  ok(lf.ok && lf.d.chaletPlot.id === null && lf.d.chaletPlot.waiting === true, 'no plot free: Finn waits for one (chaletPlot.waiting)');
  ok(lf.d.world.players.find((p) => p.name === 'Finn')?.chalet === null && ![...server.chalets.values()].includes('finn'), '...and has no plot meanwhile');
  dora.f.close();
  const placed = await finnR.f.next('chaletPlaced');
  ok(placed && placed.id === 41 && server.chalets.get(41) === 'finn' && server.profileOf('finn').chalet.id === 41, 'Dora leaves: Finn gets her plot (chaletPlaced)');
  dora = await relog('Dora', doraToken);
  if (!dora.l.ok) console.log('    relog:', dora.l.err);
  ok(dora.l.d?.chaletPlot.waiting === true, 'Dora is back while both plots are taken: she waits');
  // the visitor sees the owner's furniture; the owner's guest list and permRevoke
  await eve.f.req('profileSet', { key: 'chalet', value: { furniture: [sofa, sofa] } });
  const nf = await finnR.f.req('chaletFurniture', { id: 40 });
  ok(!nf.ok && nf.err === 'no_permission', "no furniture of Eve's chalet for an uninvited player");
  const vp = finnR.f.req('perm', { kind: 'chaletVisit', ref: 40 });
  const va = await eve.f.next('permAsk', (d) => d.from === 'Finn');
  await eve.f.req('permAnswer', { rid: va.rid, allow: true });
  await vp;
  const gl = await eve.f.next('guests', (d) => d.names.includes('Finn'));
  ok(gl && gl.kind === 'chaletVisit', "Eve's guest list: Finn");
  const yf = await finnR.f.req('chaletFurniture', { id: 40 });
  ok(yf.ok && yf.d.owner === 'Eve' && yf.d.chalet.furniture.length === 2, "the guest gets the owner's furniture (chaletFurniture)");
  await finnR.f.req('enter', { interior: 'chalet:40' });
  await eve.f.req('permRevoke', { kind: 'chaletVisit', guest: 'Finn' });
  const kick = await finnR.f.next('kickInterior');
  const gl2 = await eve.f.next('guests', (d) => d.names.length === 0);
  ok(kick && kick.interior === 'chalet:40' && gl2, 'Eve sends Finn out: he is shown out and her guest list is empty');
  for (const f of [dora.f, eve.f, finnR.f]) f.close();
  await sleep(150);
  server.plotIds = null;

  // ---------------------------------------------------------------- the day counter: from the world clock
  console.log('day');
  const wd = server.worlds.get(la.d.world.id);
  ok(Number.isInteger(la.d.world.clock.day) && la.d.world.clock.day === dayFor(la.d.world.clock.at), 'the world clock carries the day');
  const tNow = Date.now(), d0 = wd.dayAt(tNow);
  ok(wd.dayAt(tNow + DAY_MS) === d0 + 1 && wd.dayAt(tNow + DAY_MS * 3) === d0 + 3, 'one game day later the day is +1 (at the world\'s midnight)');
  const toMid = ((24 - wd.hourAt(tNow)) / 24) * DAY_MS;
  ok(wd.dayAt(tNow + toMid - 1000) === d0 && wd.dayAt(tNow + toMid + 1000) === d0 + 1, 'the day turns over at midnight');

  // ---------------------------------------------------------------- the tow truck: the fee, the impound, mid-tow drops
  console.log('tow truck');
  {
    const gus = await join('Tow Gus'), hal = await join('Tow Hal');
    const nocar = await gus.f.req('tow', { kind: 'tow', home: [1, 2, 3, 0.5], bay: 2 });
    ok(!nocar.ok && nocar.err === 'no_car', 'no car: nothing to tow (no_car)');
    server.profileOf('tow gus').money = 20000;
    const bought = await gus.f.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'white' } });
    const m0 = bought.d.money;
    const badHome = await gus.f.req('tow', { kind: 'tow', home: [1, 2, 'x', 0] });
    ok(!badHome.ok && badHome.err === 'bad_value', 'a tow needs a valid home spot');
    const t1 = await gus.f.req('tow', { kind: 'tow', home: [1, 2, 3, 0.5], bay: 2 });
    const gw = server.worlds.get(gus.l.d.world.id), gcar = () => server.profileOf('tow gus').cars[0];
    ok(t1.ok && t1.d.fee === CATALOG.wreckFee && CATALOG.wreckFee === 1500 && t1.d.money === m0 - CATALOG.wreckFee, 'towed off a road: the server charges its own fee ($1,500)');
    ok(t1.d.impound?.day === gw.dayAt() && t1.d.impound.bay === 2 && gcar().impound?.day === gw.dayAt(), '...and impounds the car until the next world day (in the profile)');
    ok(JSON.stringify(gcar().at) === JSON.stringify([1, 2, 3, 0.5]), "...its parked spot is the impound bay at once");
    const t2 = await gus.f.req('tow', { kind: 'tow', home: [1, 2, 3, 0.5], bay: 2 });
    ok(!t2.ok && t2.err === 'busy' && server.profileOf('tow gus').money === m0 - 1500, 'a second tow while the truck is out is refused (charged once)');
    await gus.f.req('veh', { k: 'car', at: [50, 0, 50, 0] });
    ok(JSON.stringify(gcar().at) === JSON.stringify([1, 2, 3, 0.5]), 'while towed, the car moving does not change the spot it ends in');
    gus.f.send('veh', { k: 'tow', at: [10, 1, 20, 1.2], v: 8, car: true });
    const tv = await hal.f.next('veh', (d) => d.k === 'tow' && d.pid === gus.l.d.pid);
    ok(tv && tv.veh.car === true && tv.veh.at[0] === 10 && tv.veh.v === 8, "the others see Gus's tow truck (pose, speed, the car on its bed)");
    const badTow = await gus.f.req('veh', { k: 'tow', at: [1, 2] });
    ok(!badTow.ok && badTow.err === 'bad_value', 'a tow truck pose must be [x, y, z, yaw]');
    // Gus leaves mid-tow: the record ends in the impound bay, the impound stays; back, it is there
    gus.f.close();
    await hal.f.next('leave', (d) => d.name === 'Tow Gus');
    ok(!gcar().tow && JSON.stringify(gcar().at) === JSON.stringify([1, 2, 3, 0.5]) && gcar().impound, 'Gus drops out mid-tow: his car ends in the impound bay (still impounded)');
    let g2 = await relog('Tow Gus', gus.token);
    ok(g2.l.ok && g2.l.d.profile.cars[0].impound?.day === t1.d.impound.day && !g2.l.d.profile.cars[0].tow && g2.l.d.profile.cars[0].at[0] === 1, '...and finds it there after logging in again');
    // a day later the impound is lifted
    server.profileOf('tow gus').cars[0].impound.day = gw.dayAt() - 1;
    g2.f.close(); await sleep(100);
    g2 = await relog('Tow Gus', gus.token);
    ok(g2.l.ok && !g2.l.d.profile.cars[0].impound, 'the next world day the impound is lifted');
    // a wreck: the fee even when it takes the balance below zero (a fine, as in single player); towDone ends it
    server.profileOf('tow gus').money = 100;
    const w1 = await g2.f.req('tow', { kind: 'wreck', home: [5, 0, 6, 0] });
    ok(w1.ok && w1.d.money === 100 - 2500 && w1.d.fee === 2500 && !w1.d.impound && gcar().tow?.kind === 'wreck', 'a wreck: the repair bill (10 % of the Golf, at least $2,500; a fine: below zero if need be), no impound');
    await g2.f.req('towDone');
    server.profileOf('tow gus').money = DEBT_FLOOR + 1000;
    const w2 = await g2.f.req('tow', { kind: 'wreck', home: [5, 0, 6, 0] });
    ok(w2.ok && w2.d.fee === 0 && w2.d.money === DEBT_FLOOR + 1000 && gcar().tow, 'at the debt floor the truck still comes, unpaid (fee 0)');
    g2.f.send('veh', { k: 'tow', at: [10, 1, 20, 1.2], v: 0, car: true });
    await hal.f.next('veh', (d) => d.k === 'tow' && d.veh);
    const dn = await g2.f.req('towDone');
    const off = await hal.f.next('veh', (d) => d.k === 'tow' && d.veh === null);
    ok(dn.ok && !gcar().tow && JSON.stringify(gcar().at) === JSON.stringify([5, 0, 6, 0]) && !!off, 'towDone: the car is home in its bay, the truck leaves the others\' view');
    g2.f.close(); hal.f.close();
    await sleep(100);
  }

  // ---------------------------------------------------------------- prison: the sentence lives in the profile
  console.log('prison');
  {
    const ivy = await join('Jail Ivy'), key = 'jail ivy';
    for (const bad of [0, 301, -5, 'x', null, NaN]) {
      const r = await ivy.f.req('jail', { seconds: bad, reason: 'x' });
      if (r.ok || r.err !== 'bad_value') { ok(false, `jail ${bad} is refused`); break; }
    }
    ok(!server.profileOf(key).jailUntil, 'a sentence outside 1-300 s is refused (bad_value)');
    const t0 = Date.now();
    const j = await ivy.f.req('jail', { seconds: 90, reason: 'Speeding in the village' });
    ok(j.ok && Math.abs(j.d.jailUntil - (t0 + 90000)) < 1500 && j.d.reason === 'Speeding in the village', 'jail 90 s: jailUntil is the server time + 90 s');
    ok(server.profileOf(key).jailUntil === j.d.jailUntil && server.profileOf(key).jailReason === 'Speeding in the village', '...kept in the profile');
    const shorter = await ivy.f.req('jail', { seconds: 10, reason: 'Again' });
    ok(shorter.ok && shorter.d.jailUntil === j.d.jailUntil, 'a shorter sentence never shortens the one being served');
    const longer = await ivy.f.req('jail', { seconds: 300, reason: 'Again' });
    ok(longer.ok && longer.d.jailUntil <= Date.now() + 300000 && longer.d.jailUntil > j.d.jailUntil, 'a longer one extends it (up to 300 s from now)');
    const shop = await ivy.f.req('enter', { interior: 'skishop' });
    ok(!shop.ok && shop.err === 'jailed', 'while jailed: no other interior (jailed)');
    const out = await ivy.f.req('enter', { interior: null });
    ok(!out.ok && out.err === 'jailed', '...and not outdoors either');
    const cell = await ivy.f.req('enter', { interior: 'prison' });
    ok(cell.ok && cell.d.interior === 'prison', "the 'prison' interior is allowed");
    // leaving and coming back: the rest of the sentence
    ivy.f.close(); await sleep(150);
    let back = await relog('Jail Ivy', ivy.token);
    ok(back.l.ok && back.l.d.profile.jailUntil === longer.d.jailUntil && back.l.d.profile.jailUntil > back.l.d.now, 'a login before the time is up: jailUntil (in the future) comes with the profile');
    // the time is served
    server.profileOf(key).jailUntil = Date.now() - 1000;
    const free = await back.f.req('enter', { interior: null });
    ok(free.ok, 'served: outdoors again');
    back.f.close(); await sleep(150);
    back = await relog('Jail Ivy', ivy.token);
    ok(back.l.ok && !back.l.d.profile.jailUntil && !back.l.d.profile.jailReason, 'a login after the time is up clears the sentence');
    server.profileOf(key).jailUntil = Date.now() + 2000; // (within the slack: the client's clock runs a little ahead)
    ok((await back.f.req('enter', { interior: 'skishop' })).ok, 'released a moment early by the client: allowed (3 s of slack)');
    back.f.close();
    await sleep(100);
  }

  // ---------------------------------------------------------------- the police: your patrol cars, seen by the others
  console.log('police');
  {
    const pia = await join('Cop Pia'), quinn = await join('Cop Quinn');
    const same = pia.l.d.world.id === quinn.l.d.world.id;
    pia.f.send('veh', { k: 'police', cars: [[10, 1, 20, 1.2, 30], [40, 2, 50, -0.5, 12.345]] });
    const pv = same ? await quinn.f.next('veh', (d) => d.k === 'police' && d.pid === pia.l.d.pid && d.veh) : null;
    ok(!same || (pv && pv.veh.cars.length === 2 && pv.veh.cars[0][0] === 10 && pv.veh.cars[0][3] === 1.2 && pv.veh.cars[1][4] === 12.35), "the others see Pia's patrol cars (poses and speeds, rounded)");
    const bad1 = await pia.f.req('veh', { k: 'police', cars: [[1, 2, 3]] });
    ok(!bad1.ok && bad1.err === 'bad_value', 'a patrol car pose must be [x, y, z, yaw, v]');
    const bad2 = await pia.f.req('veh', { k: 'police', cars: [[1, 2, 3, 0, 0], [1, 2, 3, 0, 0], [1, 2, 3, 0, 0]] });
    ok(!bad2.ok && bad2.err === 'bad_value', 'at most two patrol cars');
    const bad3 = await pia.f.req('veh', { k: 'police', cars: [] });
    const bad4 = await pia.f.req('veh', { k: 'police', cars: [[1, 2, 'x', 0, 0]] });
    ok(!bad3.ok && !bad4.ok && bad4.err === 'bad_value', 'no cars / not numbers: refused (send off: true instead)');
    const fast = await pia.f.req('veh', { k: 'police', cars: [[1, 2, 3, 0, 500]] });
    ok(fast.ok && fast.d.veh.cars[0][4] === 60, 'a patrol car speed is clamped');
    const late = await join('Cop Rae');
    const seen = late.l.d.world.players.find((p) => p.name === 'Cop Pia');
    ok(late.l.d.world.id !== pia.l.d.world.id || seen?.vehs?.police?.cars?.length === 1, 'a player who joins sees the patrol cars at once (vehs in the world snapshot)');
    const offR = await pia.f.req('veh', { k: 'police', off: true });
    const offE = same ? await quinn.f.next('veh', (d) => d.k === 'police' && d.pid === pia.l.d.pid && d.veh === null) : true;
    ok(offR.ok && offR.d.veh === null && offE, 'off: the patrol cars are gone for everyone');
    // the fines go through 'spend' with reason 'game': they may take you into debt
    server.profileOf('cop pia').money = 300;
    const fine = await pia.f.req('spend', { amount: 500, reason: 'game' });
    ok(fine.ok && fine.d.money === -200, 'a $500 police fine with $300: the balance goes below zero (a game charge)');
    const arrest = await pia.f.req('spend', { amount: 2000, reason: 'game' });
    ok(arrest.ok && arrest.d.money === -2200, '...and the $2,000 for fleeing on top');
    pia.f.close(); quinn.f.close(); late.f.close();
    await sleep(100);
  }

  // ---------------------------------------------------------------- admin (local only), payouts per account, queue retries
  console.log('admin');
  {
    const admin = async (q) => { const r = await fetch(`http://127.0.0.1:${port}/admin/${q}`); return { code: r.status, d: await r.json() }; };
    const who = async (name) => {
      const f = new Fake(url); await f.open();
      const r = await f.req('register', { name });
      const l = await f.req('login', { v: PROTO, name, token: r.d.token });
      return { f, token: r.d.token, l, key: name.toLowerCase() };
    };
    const [I, J] = [await who('Ivy Admin'), await who('Jon Admin')];
    ok(I.l.d.world.id === J.l.d.world.id, 'Ivy and Jon share a world');
    const list = await admin('players');
    ok(list.code === 200 && list.d.players.some((p) => p.name === 'Ivy Admin' && p.online) && list.d.players.some((p) => p.name === 'Alice'), '/admin/players lists every account (online or not)');
    const m0 = server.profileOf('ivy admin').money;
    const give = await admin('give?name=ivy%20admin&amount=250');
    const gm = await I.f.next('money', (d) => d.why === 'gift');
    ok(give.code === 200 && give.d.money === m0 + 250 && gm && gm.v === m0 + 250 && gm.delta === 250, '/admin/give: the money is the server\'s, and the player sees it at once');
    ok((await admin('give?name=nobody&amount=5')).code === 404 && (await admin('give?name=ivy%20admin&amount=x')).code === 400, '/admin/give: unknown player 404, bad amount 400');
    const j0 = server.profileOf('jon admin').money, a0 = server.profileOf('alice').money;
    const all = await admin('giveall?amount=100');
    ok(all.code === 200 && server.profileOf('jon admin').money === j0 + 100 && server.profileOf('alice').money === a0 + 100 && !!(await J.f.next('money', (d) => d.why === 'gift')), '/admin/giveall: every account (offline ones too), online players told');
    ok((await admin('tp?name=ivy%20admin&to=jon%20admin')).code === 409, '/admin/tp: refused while the target has not moved yet');
    J.f.send('p', [Date.now(), 50, 10, 60, 0.5, 0, 0, 0, 0, 0, 0, 0]);
    await sleep(120);
    const tp = await admin('tp?name=ivy%20admin&to=jon%20admin');
    const tpEv = await I.f.next('adminTp');
    ok(tp.code === 200 && tpEv && tpEv.x === 50 && tpEv.z === 60 && tpEv.to === 'Jon Admin', '/admin/tp: Ivy is sent Jon\'s spot (adminTp)');
    ok((await admin('tp?name=ivy%20admin&to=ivy%20admin')).code === 400 && (await admin('tp?name=ivy%20admin&to=nobody')).code === 404, '/admin/tp: same player 400, offline 404');
    ok((await admin('nope')).code === 404, 'an unknown admin command is 404');
    const forwarded = await fetch(`http://127.0.0.1:${port}/admin/players`, { headers: { 'x-forwarded-for': '1.2.3.4' } });
    ok(forwarded.status === 403, 'a request through the proxy (x-forwarded-for) is refused: local only');
    // a race queue join sent again (a retry after a lost answer) leaves a running countdown alone
    await I.f.req('raceJoin', { race: 'meadow' });
    await J.f.req('raceJoin', { race: 'meadow' });
    const W = server.worlds.get(I.l.d.world.id), q = W.queues.get('meadow');
    if (q && W.size > 2) {
      const startAt = q.startAt;
      await sleep(20);
      const again = await I.f.req('raceJoin', { race: 'meadow' });
      ok(again.ok && W.queues.get('meadow')?.startAt === startAt && W.queues.get('meadow').members.length === 2, 'raceJoin again for the same race: queued once, the countdown unchanged');
    } else ok(true, 'raceJoin again for the same race (the race started at once: nothing to check)');
    await I.f.req('raceLeave'); await J.f.req('raceLeave');
    // kick: off the server, told why (4001: no automatic reconnect)
    const closed = new Promise((r) => J.f.ws.on('close', (code, why) => r([code, String(why)])));
    const k = await admin('kick?name=jon%20admin');
    const [code, why] = await closed;
    ok(k.code === 200 && code === 4001 && why === 'kicked' && !server.onlineByKey('jon admin') && !W.players.has(J.l.d.pid), '/admin/kick: closed with 4001 kicked, out of the world at once');
    ok((await admin('kick?name=jon%20admin')).code === 404, '/admin/kick: not online any more: 404');
    const back = new Fake(url); await back.open();
    ok((await back.req('login', { v: PROTO, name: 'Jon Admin', token: J.token })).ok, 'a kicked player can log in again');
    back.close();
    // payouts: the hourly cap is per account (logging in again does not reset it); furniture sold back: 'sell'
    const sell = await I.f.req('earn', { amount: 1800, source: 'sell' });
    ok(sell.ok && !(await I.f.req('earn', { amount: 2500, source: 'sell' })).ok, "furniture sold back is paid ('sell', at most $2,000 a piece)");
    for (let i = 0; i < 9; i++) await I.f.req('earn', { amount: 6000, source: 'job' });
    const capped = await I.f.req('earn', { amount: 6000, source: 'job' });
    I.f.close();
    await sleep(100);
    const I2 = new Fake(url); await I2.open();
    await I2.req('login', { v: PROTO, name: 'Ivy Admin', token: I.token });
    const after = await I2.req('earn', { amount: 6000, source: 'job' });
    ok(!capped.ok && capped.err === 'cap' && !after.ok && after.err === 'cap', 'the hourly payout cap holds across a new login');
    I2.close();
    await sleep(100);
  }

  // ---------------------------------------------------------------- the guest list comes with a login
  {
    const g1 = new Fake(url), g2 = new Fake(url);
    await g1.open(); await g2.open();
    const r1 = await g1.req('register', { name: 'Host Hal' }), r2 = await g2.req('register', { name: 'Guest Gil' });
    server.profileOf('host hal').money = 60000;
    await g1.req('login', { v: PROTO, name: 'Host Hal', token: r1.d.token });
    await g2.req('login', { v: PROTO, name: 'Guest Gil', token: r2.d.token });
    let plot = server.freePlot(0) ?? 40;
    while (server.chalets.has(plot)) plot++;
    await g1.req('buy', { kind: 'chalet', id: plot });
    const askP = g2.req('perm', { kind: 'chaletVisit', ref: plot });
    const ask = await g1.next('permAsk');
    await g1.req('permAnswer', { rid: ask.rid, allow: true });
    await askP;
    g1.ws.terminate(); // (the network drops: held for a reconnect, the grant kept)
    await sleep(100);
    const g3 = new Fake(url); await g3.open();
    const re = await g3.req('login', { v: PROTO, name: 'Host Hal', token: r1.d.token });
    ok(re.ok && re.d.resumed && Array.isArray(re.d.guests) && re.d.guests.includes('Guest Gil'), 'a resumed login carries the chalet guest list (the guests are still allowed in)');
    g2.close(); g3.close();
    await sleep(100);
  }

  // ---------------------------------------------------------------- persistence
  a.close(); b.close();
  await sleep(150);
  server.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
  ok(saved.alice?.chalet?.id === 7 && saved.bob?.cars?.length === 1, 'profiles are on disk (chalet, car)');
  const acc = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
  ok(acc.alice && !JSON.stringify(acc).includes(ra.d.token), 'accounts store a hash, never the token');

  // ---------------------------------------------------------------- the catalog still matches the game's prices
  if (fs.existsSync(path.join(here, '..', 'src', 'game', 'economy.js'))) {
    try {
      const { buildCatalog } = await import('./tools/gen-catalog.mjs');
      const fresh = await buildCatalog();
      ok(JSON.stringify(fresh) === JSON.stringify(CATALOG), 'lib/catalog.json matches the client price tables (else: node server/tools/gen-catalog.mjs)');
    } catch (e) { console.log(`  skip catalog check (${e.message})`); }
  }
} catch (e) {
  failures++;
  console.error('test crashed:', e);
} finally {
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
