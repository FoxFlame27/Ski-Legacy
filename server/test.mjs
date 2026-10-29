// Automated server test: starts the server on a random port with a throw-away data directory, connects fake
// clients and checks the core rules. Run: `node server/test.mjs` (or `npm test` in server/). Exit code 0 = pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { GameServer, PROTO, CATALOG, DAY_MS, dayFor } from './lib/server.js';

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
  server.profileOf('alice').money = 20000; server.profileOf('bob').money = 20000;
  const ca = await a.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'white', custom: true, plate: 'SKI 1' } });
  ok(ca.ok && ca.d.car.plate === 'SKI 1' && ca.d.money === 20000 - 1200 - 100, 'Alice rents a Golf with the custom plate "SKI 1" (price checked by the server)');
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

  // ---------------------------------------------------------------- alone: multiplayer still works (world of 1)
  const solo = new Fake(url);
  await solo.open();
  const rs = await solo.req('register', { name: 'Solo Sam' });
  const ls = await solo.req('login', { v: PROTO, name: 'solo sam', token: rs.d.token });
  ok(ls.ok && ls.d.world.players.length >= 1, 'a lone player always gets in');
  solo.close();
  await sleep(150);

  // ---------------------------------------------------------------- 15 per world: the 16th player opens world 2
  console.log('worlds');
  const crowd = [];
  const used = server.worlds.get(la.d.world.id).size; // (Alice and Bob)
  for (let i = 0; i < 16 - used; i++) {
    const f = new Fake(url); await f.open();
    const r = await f.req('register', { name: `Skier ${i}` });
    const l = await f.req('login', { v: PROTO, name: `Skier ${i}`, token: r.d.token });
    crowd.push({ f, world: l.d.world.id });
  }
  const w1 = la.d.world.id;
  ok(crowd.slice(0, 15 - used).every((c) => c.world === w1) && crowd[crowd.length - 1].world !== w1, 'world 1 fills to 15, the 16th player gets a new world');
  ok(server.worlds.get(w1).size === 15, 'world 1 has exactly 15 players');
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
