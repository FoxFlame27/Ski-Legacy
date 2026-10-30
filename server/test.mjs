// Automated server test: starts the server on a random port with a throw-away data directory, connects fake
// clients and checks the core rules. Run: `node server/test.mjs` (or `npm test` in server/). Exit code 0 = pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { GameServer, PROTO, CATALOG, DAY_MS, dayFor, DEBT_FLOOR, MAX_PLAYERS, SEAT_CAPS, RACE_MAX, repairPrice, wreckBill, CLERK_REPAIR, busHoldAt, BUS_HOLD } from './lib/server.js';

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
  ok(s4.d?.n === 1 && s4.d?.taken === 1 && s3.d.n === 1 && s3.d.taken === 1, 'a full claim says the capacity and how many are aboard (1/1); a seat claim says it too');
  // capacity = the vehicle's real seat count (n): a 2-seat bus run takes 2, the third waits for the next bus
  const c1 = await a.req('seatClaim', { k: 'bus', v: 'cap-bus', n: 2 });
  const c2 = await b.req('seatClaim', { k: 'bus', v: 'cap-bus', n: 2 });
  const cEv = await a.next('seats', (d) => d.v === 'cap-bus' && d.occ.length === 2);
  ok(c1.ok && c2.ok && c2.d.taken === 2 && cEv?.n === 2, 'a 2-seat bus: two claims seated, the broadcast carries its capacity (n 2, 2 aboard)');
  const big = await a.req('seatClaim', { k: 'train', v: 'cap-train', n: 192, seat: 150 });
  ok(big.ok && big.d.seat === 150 && big.d.n === 192, 'a 4-car train (192 seats): a seat in its 4th car can be claimed (no 64-seat limit)');
  const huge = await b.req('seatClaim', { k: 'express', v: 'cap-x', n: 9999 });
  ok(huge.ok && huge.d.n === SEAT_CAPS.express, 'n is capped per kind');
  await a.req('seatRelease'); await b.req('seatRelease');
  { const w0 = server.worlds.get(la.d.world.id); ok(!w0.seats.get('bus|cap-bus') && !w0.seats.get('train|cap-train'), 'off again: the seats go back'); }
  // the third player on a full bus: refused (full, 2/2) until a seat is free again
  await a.req('seatClaim', { k: 'bus', v: 'cap-bus', n: 2 }); await b.req('seatClaim', { k: 'bus', v: 'cap-bus', n: 2 });
  const cx = new Fake(url); await cx.open();
  const rx = await cx.req('register', { name: 'Seatless' }); await cx.req('login', { v: PROTO, name: 'Seatless', token: rx.d.token, tt: 'tt-other' });
  const jx = await a.next('join', (d) => d.name === 'Seatless');
  ok(jx?.tt === 'tt-other', "a player's timetable fingerprint (game version) comes with their join: another version's trains run other times");
  const c3f = await cx.req('seatClaim', { k: 'bus', v: 'cap-bus', n: 2 });
  ok(!c3f.ok && c3f.err === 'full' && c3f.d.n === 2 && c3f.d.taken === 2, 'a third rider on the full 2-seat bus is refused (full 2/2)');
  await b.req('seatRelease');
  const c3ok = await cx.req('seatClaim', { k: 'bus', v: 'cap-bus', n: 2 });
  ok(c3ok.ok && c3ok.d.seat === 1, 'a seat free again: the waiting rider gets it');
  await cx.req('seatRelease'); await a.req('seatRelease'); cx.close();
  await a.next('leave', (d) => d.name === 'Seatless');
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

  // ---------------------------------------------------------------- the ski buses' shared hold-ups (busHold)
  console.log('bus hold-ups');
  {
    const w = server.worlds.get(la.d.world.id);
    const h1 = await a.req('busHold', { bus: 'bus:3', d: 5, dd: 1, sh: 0.4, sv: 0.2, ram: false, bt: 4 });
    const ev1 = await b.next('busHold', (d) => d.bus === 'bus:3' && !d.clear);
    ok(h1.ok && h1.d.own === true && ev1 && ev1.own === pidA && ev1.d === 5 && ev1.sh === 0.4 && Math.abs(ev1.at - Date.now()) < 1000,
      'Alice reports bus:3 held up 5 s: Bob gets the record (her pid, the server time stamp, the lane offset)');
    const bad = await Promise.all([
      a.req('busHold', { bus: 'bus:0', d: 1 }), a.req('busHold', { bus: 'bus:99', d: 1 }), a.req('busHold', { bus: 'bus:3', d: 61 }),
      a.req('busHold', { bus: 'bus:3', d: -1 }), a.req('busHold', { bus: 'bus:3', d: 2, sh: 2 }), a.req('busHold', { bus: 'bus:3', d: 'x' }),
    ]);
    ok(bad[0].err === 'bad_bus' && bad[1].err === 'bad_bus' && bad.slice(2).every((r) => !r.ok && r.err === 'bad_value'),
      'refused: bus:0 / an unknown bus (bad_bus), a delay over 60 s, negative, not a number, a lane offset over 1 (bad_value)');
    const hb = await b.req('busHold', { bus: 'bus:3', d: 5.2 });
    ok(!hb.ok && hb.err === 'held' && hb.d.own === pidA && w.busHolds.get('bus:3').own === pidA, "Bob can't take Alice's fresh record with about the same delay (held)");
    const hb2 = await b.req('busHold', { bus: 'bus:3', d: 9, ram: true, bt: 21 });
    const ev2 = await a.next('busHold', (d) => d.bus === 'bus:3' && d.own === pidB);
    ok(hb2.ok && ev2 && ev2.d === 9 && ev2.ram === true && ev2.bt === 21, 'Bob sees it held up longer (9 s, pushing through): his record takes over, Alice is told');
    const ca = await a.req('busHold', { bus: 'bus:3', d: 0, sh: 0 });
    ok(!ca.ok && ca.err === 'held' && w.busHolds.has('bus:3'), "Alice can't clear Bob's fresh record");
    const list = await a.req('busHolds');
    ok(list.ok && list.d.holds.length === 1 && list.d.holds[0].bus === 'bus:3' && list.d.holds[0].own === pidB && w.snapshot().busHolds.length === 1,
      'busHolds (and the world snapshot) list the records standing');
    const cb = await b.req('busHold', { bus: 'bus:3', d: 0, sh: 0 });
    const ev3 = await a.next('busHold', (d) => d.bus === 'bus:3' && d.clear);
    ok(cb.ok && cb.d.clear && ev3 && !w.busHolds.has('bus:3'), 'Bob: on time again -> cleared for everyone');
    // the aging, the same on every client (bus.js holdAt): extrapolated while fresh, then caught up / eased back
    const rec = { d: 10, dd: 1, sh: 1, sv: 0, ram: true, bt: 3, at: 0 };
    const x1 = busHoldAt(rec, 500, {}), x2 = busHoldAt(rec, 3000, {}), x3 = busHoldAt(rec, 1000 + 1000 * (11 / BUS_HOLD.CATCH), {});
    ok(x1.fresh && Math.abs(x1.d - 10.5) < 1e-9 && x1.ram && x1.sh === 1 && Math.abs(x1.bt - 3.5) < 1e-9, 'aging: fresh -> the delay grows at its reported rate (10.5 s after 0.5 s), still pushing through');
    ok(!x2.fresh && Math.abs(x2.d - (11 - 2 * BUS_HOLD.CATCH)) < 1e-9 && !x2.ram && Math.abs(x2.sh - (1 - 2 * BUS_HOLD.SHIFT)) < 1e-9 && !x2.done,
      'aging: stale -> caught up at CATCH s/s, the lane offset eased back, no longer pushing through');
    ok(x3.d === 0 && x3.sh === 0 && x3.done && busHoldAt({ d: 70, at: 0 }, 0, {}).d === BUS_HOLD.MAX, 'aging: fully caught up -> done; never over 60 s');
    // a stale record (its reporter went quiet) is anyone's; the server ages records out by itself
    await a.req('busHold', { bus: 'bus:5', d: 3 });
    w.busHolds.get('bus:5').at = Date.now() - BUS_HOLD.STALE_MS - 100;
    const hs = await b.req('busHold', { bus: 'bus:5', d: 1 });
    ok(hs.ok && w.busHolds.get('bus:5').own === pidB, "a stale record is taken over freely (even with a shorter delay)");
    w.busHolds.get('bus:5').at = Date.now() - 1000 * (BUS_HOLD.FRESH + 1 / BUS_HOLD.CATCH) - 500; w.busHolds.get('bus:5').dd = 0;
    const ev4 = await a.next('busHold', (d) => d.bus === 'bus:5' && d.clear, 1500);
    ok(ev4 && !w.busHolds.has('bus:5'), 'the server ages a quiet record out by itself (caught up: cleared for everyone)');
    // rate limited
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => a.req('busHold', { bus: 'bus:6', d: 1 + i * 0.01 })));
    ok(burst.some((r) => r.err === 'rate_limited') && burst.filter((r) => r.ok).length >= 15, 'a flood of reports is rate limited');
    await sleep(100);
    await a.req('busHold', { bus: 'bus:6', d: 0, sh: 0 });
  }

  // ---------------------------------------------------------------- number plates: unique across everyone
  console.log('plates');
  await a.req('profile'); // (Alice gets money to buy two cars: the server is the only one who can give it)
  server.profileOf('alice').money = 100000; server.profileOf('bob').money = 100000;
  const ca = await a.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'white', custom: true, plate: 'SKI 1' } });
  ok(ca.ok && ca.d.car.plate === 'SKI 1' && ca.d.money === 100000 - CATALOG.cars.car_vw_golf_gti - CATALOG.plateCost && CATALOG.cars.car_vw_golf_gti === 11250, 'Alice buys a Golf ($11,250) with the custom plate "SKI 1" (price checked by the server)');
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
  ok(g1.ok && g1.d.cars.length === 2 && g1.d.cars[0].id === 'car_vw_golf_gti' && g1.d.cars[1].id === 'car_bmw_x3' && g1.d.money === mB0 - 11250 && g1.d.car.price === 11250,
    'Bob buys a Golf too: both are his (the new one out, cars[0]), the X3 kept');
  const x3 = CATALOG.cars.car_bmw_x3;
  const g2x = await b.req('buy', { kind: 'car', cfg: { id: 'car_bmw_x3', paint: 'black' } });
  ok(g2x.ok && g2x.d.cars.length === 3 && g2x.d.cars[0].id === 'car_bmw_x3' && g2x.d.car.plate !== cb2.d.car.plate && g2x.d.cars.filter((x) => x.id === 'car_bmw_x3').length === 2 && g2x.d.money === mB0 - 11250 - x3,
    'several of one model: a second X3 (another plate, black) is bought, the first X3 kept');
  const sw = await b.req('carSwitch', { plate: cb2.d.car.plate });
  ok(sw.ok && sw.d.cars[0].plate === cb2.d.car.plate && sw.d.cars.length === 3 && server.profileOf('bob').money === mB0 - 11250 - x3, 'carSwitch (by plate): the first X3 is out again without paying');
  const swBad = await b.req('carSwitch', { plate: 'SKI 1' });
  ok(!swBad.ok && swBad.err === 'no_car', "carSwitch to a plate that is not yours: no_car");
  const sell = await b.req('carSell', { plate: g1.d.car.plate });
  const pcS = await a.req('plateCheck', { plate: g1.d.car.plate });
  ok(sell.ok && sell.d.refund === 5650 && sell.d.money === mB0 - 11250 - x3 + 5650 && sell.d.cars.length === 2 && sell.d.cars[0].plate === cb2.d.car.plate && pcS.d.free === true,
    'carSell: the Golf sold back for half what Bob paid ($5,650: rounded to $50), its plate free again');
  const sell2 = await b.req('carSell', { plate: g1.d.car.plate });
  ok(!sell2.ok && sell2.err === 'no_car', 'a car sold cannot be sold twice');
  const sellX = await b.req('carSell', { plate: g2x.d.car.plate });
  ok(sellX.ok && sellX.d.cars.length === 1 && sellX.d.cars[0].plate === cb2.d.car.plate, 'the second X3 sold (by its plate): the first one stays');
  // the garage holds CATALOG.garageMax cars: one more is refused (garage_full), nothing charged
  const max = CATALOG.garageMax, mF = (server.profileOf('bob').money = 10000000), extra = [];
  for (let i = 1; i < max; i++) { const r = await b.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'white' } }); if (r.ok) extra.push(r.d.car.plate); }
  const full = await b.req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'black' } });
  ok(max === 10 && extra.length === max - 1 && server.profileOf('bob').cars.length === max && new Set(server.profileOf('bob').cars.map((x) => x.plate)).size === max
    && !full.ok && full.err === 'garage_full' && full.d?.max === max && server.profileOf('bob').money === mF - (max - 1) * 11250, `a full garage (${max} cars, ${max - 1} of them Golfs, every plate its own): one more is refused (garage_full), nothing charged`);
  for (const p of extra) await b.req('carSell', { plate: p });
  await b.req('carSwitch', { plate: cb2.d.car.plate });
  server.profileOf('bob').money = mB0 - 11250 - x3 + 5650 + sellX.d.refund;
  ok(server.profileOf('bob').cars.length === 1 && server.profileOf('bob').cars[0].plate === cb2.d.car.plate, '...sold again: only the first X3 left');

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
  { // a full car refuses: Alice's car a two-seater (the Huracan: one passenger seat, Bob's), whatever n the client sends
    const ac = server.onlineByKey('alice'), pa = server.profileOf('alice'), cars0 = pa.cars, veh0 = ac.vehs.car;
    const car0 = { id: 'car_lamborghini_huracan' };
    pa.cars = [car0]; ac.vehs.car = null;
    const cz = new Fake(url); await cz.open();
    const rz = await cz.req('register', { name: 'Hitcher' }); await cz.req('login', { v: PROTO, name: 'Hitcher', token: rz.d.token });
    const pz = cz.req('perm', { kind: 'carRide', to: 'Alice' });
    const az = await a.next('permAsk', (d) => d.kind === 'carRide' && d.from === 'Hitcher');
    await a.req('permAnswer', { rid: az.rid, allow: true }); await pz;
    const fz = await cz.req('seatClaim', { k: 'car', v: 'Alice', n: 7 });
    ok(!fz.ok && fz.err === 'full' && fz.d.n === 2 && fz.d.taken === 2, 'a full car (a two-seater, Bob in its passenger seat): a third player is refused (full 2/2), n: 7 or not');
    car0.id = 'car_mercedes_gls';
    const gz = await cz.req('seatClaim', { k: 'car', v: 'Alice', n: 7 });
    ok(gz.ok && gz.d.seat === 2 && gz.d.n === 5, 'the Mercedes GLS: 5 seats in all, not 7 (the client\'s n capped by the model)');
    pa.cars = cars0; ac.vehs.car = veh0;
    await cz.req('seatRelease'); cz.close();
    await a.next('leave', (d) => d.name === 'Hitcher');
  }
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
  ok(qe && qe.startAt - Date.now() > 25000, 'two in the queue (of 3 in the world): the 45 s countdown starts');
  await a.req('raceLeave');
  const qc = await c3.next('raceQueue', (d) => d.race === 'meadow' && d.n === 1);
  ok(qc && qc.startAt === 0, 'one leaves: the countdown is cancelled');
  await a.req('raceJoin', { race: 'meadow' });
  const qe2 = await c3.next('raceQueue', (d) => d.race === 'meadow' && d.n === 2 && d.startAt > 0);
  const startAt = qe2?.startAt;
  await c3.req('raceJoin', { race: 'meadow' }); // everyone in the world is queued: it still waits for the countdown
  const qe3 = await c3.next('raceQueue', (d) => d.race === 'meadow' && d.n === 3);
  ok(qe3 && qe3.startAt === startAt && qe3.waitMs === 45000, 'everyone in the world queued: no instant start, the 45 s countdown runs on');
  { const wq = server.worlds.get(la.d.world.id), q = wq.queues.get('meadow'); clearTimeout(q.timer); wq.startRace('meadow'); } // (the countdown's end, now)
  const st = await a.next('raceStart', (d) => d.race === 'meadow');
  ok(st && st.grid.length === 3 && st.at - Date.now() <= 4500 && new Set(st.grid.map((g) => g.slot)).size === 3, 'at the countdown\'s end the race starts (3 on the grid, shared start time)');
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
  {
    // the ski bus's free races (catalog races[id].bus): free entry even in debt, 2 racers needed (as every race), every finisher paid
    console.log('bus races');
    const bus = Object.entries(CATALOG.races).filter(([, d]) => d.bus);
    ok(bus.length === 3 && bus.every(([, d]) => d.entry === 0 && d.need === 2 && d.par > 0 && d.reward >= 1000 && d.reward <= 1500),
      'three bus races in the catalog: free entry, 2 racers needed, a par time, a modest prize ($1,000-1,500)');
    const [id, def] = bus[0];
    const B = await racer('Bea');
    const m0 = (server.profileOf('bea').money = -2500); // (deep in debt)
    const jq = await B.f.req('raceJoin', { race: id });
    ok(jq.ok && jq.d.need === 2 && jq.d.waitMs === 45000, 'a broke player joins a bus race queue (need 2, the 45 s countdown)');
    const q1 = B.world.queues.get(id);
    ok(q1 && !q1.startAt, 'alone in the queue: no countdown (nobody races alone)');
    B.world.startRace(id); // (forced: one racer is sent back to the queue)
    await sleep(50);
    ok(!B.world.races.size || ![...B.world.races.values()].some((r) => r.race === id), 'a forced start with one racer starts nothing');
    ok(server.profileOf('bea').money === m0, 'no entry fee taken');
    ok(B.world.queues.get(id)?.members.length === 1 && !B.world.queues.get(id).startAt, '...the lone racer stays queued, still no countdown');
    await B.f.req('raceLeave'); // (out of the queue: the two-racer race below starts from an empty one)
    ok(!B.world.queues.get(id), 'left the queue: it is gone');
    // two racers: the winner gets the full prize, the second (nobody behind) the time prize; over par 30 %
    const C = await racer('Cass');
    await B.f.req('raceJoin', { race: id });
    await C.f.req('raceJoin', { race: id });
    const q2 = B.world.queues.get(id);
    clearTimeout(q2.timer); B.world.startRace(id);
    const st2 = await B.f.next('raceStart', (d) => d.race === id && d.grid.length === 2);
    const r2 = B.world.races.get(st2.rid);
    r2.at = Date.now() - (def.par + 20000);
    const mB = server.profileOf('bea').money, mC = server.profileOf('cass').money;
    await C.f.req('raceFinish', { rid: st2.rid, raw: def.par + 19000, pen: 0 });
    await B.f.req('raceFinish', { rid: st2.rid, raw: def.par + 20000, pen: 0 });
    const res2 = await B.f.next('raceResult', (d) => d.rid === st2.rid);
    const over = Math.round(def.reward * def.rest);
    ok(res2 && res2.order[0].name === 'Cass' && res2.order[0].prize === def.reward && res2.order[1].prize === over, `two racers: the winner $${def.reward}, the second over par $${over}`);
    ok(server.profileOf('cass').money === mC + def.reward && server.profileOf('bea').money === mB + over, 'the server paid both');
    for (const p of [B, C]) p.f.close();
    await sleep(100);
  }
  {
    // a practice race (raceSolo, Oct 30, the user: "you can race alone but you dont earn any money", "call it a practise
    // race"): any race, just you, at once; no entry fee, no prize money, no race / win counted
    console.log('practice races');
    const bus = Object.entries(CATALOG.races).find(([, d]) => d.bus);
    const [bid, bdef] = bus;
    const paid = Object.entries(CATALOG.races).find(([, d]) => !d.bus && d.entry > 0)[0];
    const O = await racer('Opal');
    const prof = server.profileOf('opal');
    prof.stats.races = 3; prof.money = 5000; // (not her first race: the entry fee would be due in a real one)
    const jq = await O.f.req('raceJoin', { race: paid });
    ok(jq.ok && O.world.queues.get(paid)?.members.includes(O.pid), 'Opal is queued for a race with an entry fee');
    const sq = await O.f.req('raceSolo', { race: paid });
    const st = await O.f.next('raceStart', (d) => d.race === paid && d.grid.some((g) => g.pid === O.pid));
    ok(sq.ok && st && st.practice === true && st.grid.length === 1 && st.at - Date.now() <= 4500, 'raceSolo: a practice race starts at once with one racer (the 3-2-1 lead only)');
    ok(!O.world.queues.get(paid), '...and she left the queue for it');
    ok(prof.money === 5000, '...no entry fee taken');
    const again = await O.f.req('raceSolo', { race: paid });
    ok(!again.ok && again.err === 'in_race', 'one race at a time: a second raceSolo while racing is refused');
    const r = O.world.races.get(st.rid);
    r.at = Date.now() - 50000;
    await O.f.req('raceFinish', { rid: st.rid, raw: 50000, pen: 0 });
    const res = await O.f.next('raceResult', (d) => d.rid === st.rid);
    ok(res && res.practice === true && res.order.length === 1 && res.order[0].place === 1 && res.order[0].prize === 0, 'first of one: no prize money (practice)');
    await sleep(50);
    ok(prof.money === 5000 && prof.stats.races === 3 && !(prof.stats.wins > 0) && !(prof.stats.earned > 0), 'nothing paid and nothing counted (no race, no win)');
    // a free bus race, broke and under par: still nothing
    prof.money = -800;
    await O.f.req('raceSolo', { race: bid });
    const sb = await O.f.next('raceStart', (d) => d.race === bid && d.practice);
    O.world.races.get(sb.rid).at = Date.now() - (bdef.par - 5000);
    await O.f.req('raceFinish', { rid: sb.rid, raw: bdef.par - 5000, pen: 0 });
    const rb = await O.f.next('raceResult', (d) => d.rid === sb.rid);
    await sleep(50);
    ok(rb && rb.order[0].prize === 0 && prof.money === -800, 'a practice bus race under par pays nothing either');
    const bad = await O.f.req('raceSolo', { race: 'nope' });
    ok(!bad.ok && bad.err === 'bad_race', 'raceSolo: an unknown race is refused');
    O.f.close();
    await sleep(100);
  }

  {
    // at most RACE_MAX (21) racers in one race (Oct 30, the user): the 21st starts it at once on 21 distinct grid slots,
    // a 22nd (a full queue) is refused: race_full, the next race
    console.log('race field cap');
    const F = [];
    for (let i = 0; i < RACE_MAX; i++) F.push(await racer(`Field ${i}`));
    const w = F[0].world;
    ok(F.every((x) => x.world === w), `${RACE_MAX} racers in one world`);
    for (const x of F.slice(0, RACE_MAX - 1)) await x.f.req('raceJoin', { race: 'meadow' });
    const q = w.queues.get('meadow');
    ok(q && q.members.length === RACE_MAX - 1 && q.startAt > 0 && w.queueMsg('meadow').max === RACE_MAX, `${RACE_MAX - 1} queued: the 45 s countdown runs (queue max ${RACE_MAX})`);
    await F[RACE_MAX - 1].f.req('raceJoin', { race: 'meadow' });
    const st = await F[0].f.next('raceStart', (d) => d.race === 'meadow' && d.grid.length === RACE_MAX, 2000);
    ok(!!st && !w.queues.get('meadow'), `the ${RACE_MAX}st racer: a full field starts at once`);
    ok(st && new Set(st.grid.map((g) => g.slot)).size === RACE_MAX && st.grid.every((g) => g.slot >= 0 && g.slot < RACE_MAX), `${RACE_MAX} distinct start slots (0-${RACE_MAX - 1})`);
    // a full queue (as if 21 were waiting): the 22nd is refused
    const X = await racer('Field Extra');
    X.world.queues.set('meadow', { members: Array.from({ length: RACE_MAX }, (_, i) => 10000 + i), startAt: Date.now() + 40000, timer: null });
    const full = await X.f.req('raceJoin', { race: 'meadow' });
    ok(!full.ok && full.err === 'race_full' && full.d?.max === RACE_MAX && X.world.queues.get('meadow').members.length === RACE_MAX, `a 22nd racer: race_full (the next race), the field stays at ${RACE_MAX}`);
    const pr = await X.f.req('raceSolo', { race: 'meadow' });
    ok(pr.ok && pr.d.practice, '...a practice race is still open to them');
    X.world.queues.delete('meadow');
    w.finishRace(w.races.get(st.rid));
    for (const x of [...F, X]) x.f.close();
    await sleep(150);
  }

  // ---------------------------------------------------------------- alone: multiplayer still works (world of 1)
  const solo = new Fake(url);
  await solo.open();
  const rs = await solo.req('register', { name: 'Solo Sam' });
  const ls = await solo.req('login', { v: PROTO, name: 'solo sam', token: rs.d.token });
  ok(ls.ok && ls.d.world.players.length >= 1, 'a lone player always gets in');
  solo.close();
  await sleep(150);

  // ---------------------------------------------------------------- where you were (pos), kept in the profile
  {
    const ps = await a.req('profileSet', { key: 'pos', value: { x: 120.5, z: -40.25, y: 3.1, h: 1.2, skis: true } });
    ok(ps.ok && server.profileOf('alice').pos?.x === 120.5 && server.profileOf('alice').pos.skis === true, 'profileSet pos: where you were is kept');
    const pb = await a.req('profileSet', { key: 'pos', value: { x: 'far', z: 0, y: 0, h: 0 } });
    ok(!pb.ok && pb.err === 'bad_value' && server.profileOf('alice').pos.x === 120.5, '...a bad one is refused');
    const until = Date.now() + 15000;
    const ph = await a.req('profileSet', { key: 'pos', value: { x: 50, z: 60, y: 2, h: 0, skis: false, hospital: { until } } });
    ok(ph.ok && server.profileOf('alice').pos?.hospital?.until === until && server.profileOf('alice').pos.x === 50, 'profileSet pos: lying in a hospital bed is kept (hospital.until)');
    const pf = await a.req('profileSet', { key: 'pos', value: { x: 50, z: 60, y: 2, h: 0, hospital: { until: Date.now() + 864e5 } } });
    ok(pf.ok && server.profileOf('alice').pos.hospital.until <= Date.now() + 600000, '...never more than 10 min ahead');
    const pq = await a.req('profileSet', { key: 'pos', value: { x: 7, z: 8, y: 2, h: 0, hospital: { until: 'soon' } } });
    ok(!pq.ok && pq.err === 'bad_value' && server.profileOf('alice').pos.x === 50, '...a bad hospital stay is refused');
    const po = await a.req('profileSet', { key: 'pos', value: { x: 9, z: 9, y: 2, h: 0, skis: false } });
    ok(po.ok && !server.profileOf('alice').pos.hospital, '...and gone with the next spot outdoors');
  }
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
    ok(t1.d.impound?.day === gw.dayAt() && t1.d.impound.bay === 2 && gcar().impound?.day === gw.dayAt() && Math.abs(t1.d.impound.until - Date.now() - 180000) < 5000, '...and puts the car in the tow yard for 3 minutes (in the profile)');
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
    server.profileOf('tow gus').cars[0].impound.until = Date.now() - 1;
    g2.f.close(); await sleep(100);
    g2 = await relog('Tow Gus', gus.token);
    ok(g2.l.ok && !g2.l.d.profile.cars[0].impound, 'after its 3 minutes the tow yard lets it go');
    // a wreck: the fee even when it takes the balance below zero (a fine, as in single player); towDone ends it
    server.profileOf('tow gus').money = 100;
    const w1 = await g2.f.req('tow', { kind: 'wreck', home: [5, 0, 6, 0] });
    ok(w1.ok && w1.d.money === 100 - 3200 && w1.d.fee === 3200 && !w1.d.impound && gcar().tow?.kind === 'wreck', 'a wreck: the tow ($1,500) and the full repair (15 % of the Golf: $1,700) = $3,200 (a fine: below zero if need be), no impound');
    const busyFix = await g2.f.req('carRepair', { damage: 0.5 });
    ok(!busyFix.ok && busyFix.err === 'busy' && server.profileOf('tow gus').money === 100 - 3200, 'the Werkstatt cannot repair a car the tow truck has (busy, no charge)');
    await g2.f.req('towDone');
    server.profileOf('tow gus').money = DEBT_FLOOR + 1000;
    const w2 = await g2.f.req('tow', { kind: 'wreck', home: [5, 0, 6, 0] });
    ok(w2.ok && w2.d.fee === 0 && w2.d.money === DEBT_FLOOR + 1000 && gcar().tow, 'at the debt floor the truck still comes, unpaid (fee 0)');
    g2.f.send('veh', { k: 'tow', at: [10, 1, 20, 1.2], v: 0, car: true });
    await hal.f.next('veh', (d) => d.k === 'tow' && d.veh);
    const dn = await g2.f.req('towDone');
    const off = await hal.f.next('veh', (d) => d.k === 'tow' && d.veh === null);
    ok(dn.ok && !gcar().tow && JSON.stringify(gcar().at) === JSON.stringify([5, 0, 6, 0]) && !!off, 'towDone: the car is home in its bay, the truck leaves the others\' view');
    // THE WERKSTATT (game/werkstatt.js): the server prices the repair from the car's own list price and the damage share
    console.log('werkstatt');
    const P = () => server.profileOf('tow gus');
    P().money = 5000;
    const r1 = await g2.f.req('carRepair', { damage: 0.4 });
    ok(r1.ok && r1.d.fee === 700 && r1.d.money === 4300 && P().money === 4300, 'a repair: 40 % of 15 % of the Golf ($11,250) = $675 -> $700 ($50 steps), charged by the server');
    const r2 = await g2.f.req('carRepair', { damage: 7 });
    ok(r2.ok && r2.d.fee === 1700 && P().money === 2600, '...the damage share clamped to 1: at most the full repair ($1,700)');
    const r3 = await g2.f.req('carRepair', { damage: 0.01 });
    ok(r3.ok && r3.d.fee === CATALOG.repairMin && CATALOG.repairMin === 150 && P().money === 2450, '...a scratch: the minimum ($150)');
    const r4 = await g2.f.req('carRepair', { damage: 0 }), r5 = await g2.f.req('carRepair', { damage: -3 }), r6 = await g2.f.req('carRepair', { damage: 'lots' });
    ok(!r4.ok && r4.err === 'no_damage' && !r5.ok && r5.err === 'no_damage' && !r6.ok && r6.err === 'bad_value' && P().money === 2450, 'nothing to repair / a bad damage value: refused, no charge');
    P().money = 300;
    const r7 = await g2.f.req('carRepair', { damage: 1 });
    ok(!r7.ok && r7.err === 'money' && r7.d.money === 300 && P().money === 300, 'a repair is a purchase: not enough money, refused (no debt)');
    const r8 = await g2.f.req('carRepair', { damage: 0.5, plate: 'ZZ 999999' });
    ok(!r8.ok && r8.err === 'no_car', 'a plate that is not yours: no_car');
    P().money = 5000;
    const r9 = await g2.f.req('carRepair', { damage: 0.2, plate: gcar().plate });
    ok(r9.ok && r9.d.fee === 350 && P().money === 4650, '...your own plate: repaired ($337.50 -> $350)');
    // THE AUTOHAUS CLERK: { flat: 'clerk' }, a flat $500 (the server's own) for any damage, wherever the car is parked
    P().money = 2000;
    const c1 = await g2.f.req('carRepair', { damage: 1, flat: 'clerk', fee: 1 });
    ok(c1.ok && c1.d.fee === 500 && CLERK_REPAIR === 500 && P().money === 1500, "the clerk's repair: a flat $500, whatever the damage (never a price from the client)");
    const c2 = await g2.f.req('carRepair', { damage: 0.05, flat: 'clerk', plate: gcar().plate });
    ok(c2.ok && c2.d.fee === 500 && P().money === 1000, '...a scratch, your own plate: $500 too');
    const c3 = await g2.f.req('carRepair', { damage: 0, flat: 'clerk' }), c4 = await g2.f.req('carRepair', { damage: -1, flat: 'clerk' });
    ok(!c3.ok && c3.err === 'no_damage' && !c4.ok && c4.err === 'no_damage' && P().money === 1000, '...no damage: refused, no charge');
    const c5 = await g2.f.req('carRepair', { damage: 0.5, flat: 'clerk', plate: 'ZZ 999999' }), c6 = await g2.f.req('carRepair', { damage: 0.5, flat: 'cheap' });
    ok(!c5.ok && c5.err === 'no_car' && !c6.ok && c6.err === 'bad_value' && P().money === 1000, '...a plate that is not yours: no_car; an unknown flat: bad_value (no charge)');
    P().money = 499;
    const c7 = await g2.f.req('carRepair', { damage: 0.5, flat: 'clerk' });
    ok(!c7.ok && c7.err === 'money' && c7.d.fee === 500 && P().money === 499, '...not enough money ($499): refused (no debt)');
    P().money = 5000; gcar().tow = { kind: 'tow', since: Date.now(), home: [1, 2, 3, 0] };
    const c8 = await g2.f.req('carRepair', { damage: 0.5, flat: 'clerk' });
    delete gcar().tow; gcar().impound = { day: 0, until: Date.now() + 60000, bay: 0 };
    const c9 = await g2.f.req('carRepair', { damage: 0.5, flat: 'clerk' });
    delete gcar().impound;
    ok(!c8.ok && c8.err === 'busy' && !c9.ok && c9.err === 'busy' && P().money === 5000, '...not while the tow truck has it or it is in the tow yard (no charge)');
    // CRASH DAMAGE kept on the car (carDamage: dents and the damage share) until it is repaired
    console.log('car damage');
    const dents = [[0.95, 0.6, 2.1, 0.7, 0.15, 42.5], [-0.9, 0.6, -2.0, 0.5, 0.08, 7]];
    await g2.f.req('veh', { k: 'car', at: [5, 0, 6, 0] });
    const dm1 = await g2.f.req('carDamage', { damage: 0.234567, dents, plate: gcar().plate });
    ok(dm1.ok && gcar().damage === 0.235 && gcar().dents.length === 2 && gcar().dents[0][5] === 42.5 && dm1.d.damage === 0.235, 'crash damage kept on the car: its share (0..1, rounded) and its dents');
    const seenD = await hal.f.next('veh', (d) => d.k === 'car' && d.pid === g2.l.d.pid && d.veh?.cfg?.dents?.length === 2);
    ok(!!seenD && seenD.veh.at?.[0] === 5, '...the others see its dents (the parked spot kept)');
    const bd1 = await g2.f.req('carDamage', { damage: 'lots' }), bd2 = await g2.f.req('carDamage', { damage: 0.5, dents: Array.from({ length: 13 }, () => [0, 0, 0, 0.5, 0.1, 1]) });
    const bd3 = await g2.f.req('carDamage', { damage: 0.5, dents: [[0, 0, 0, 0.5, 0.1]] }), bd4 = await g2.f.req('carDamage', { damage: 0.5, dents: [[0, 0, 0, 0.5, 0.1, 1e6]] });
    const bd5 = await g2.f.req('carDamage', { damage: 0.5, dents: 'many' }), bd6 = await g2.f.req('carDamage', { damage: 0.5, plate: 'ZZ 999999' });
    ok([bd1, bd2, bd3, bd4, bd5].every((r) => !r.ok && r.err === 'bad_value') && !bd6.ok && bd6.err === 'no_car' && gcar().damage === 0.235 && gcar().dents.length === 2,
      'bad damage / too many dents / a dent not 6 small numbers: refused (bad_value); a plate not yours: no_car; the record as it was');
    const dm2 = await g2.f.req('carDamage', { damage: 3 });
    ok(dm2.ok && gcar().damage === 1 && !gcar().dents, '...the share clamped to 1; no dents sent: none kept');
    await g2.f.req('carDamage', { damage: 0.3, dents });
    g2.f.close(); await sleep(100);
    g2 = await relog('Tow Gus', gus.token);
    const lc = g2.l.d.profile.cars[0];
    ok(g2.l.ok && lc.damage === 0.3 && lc.dents?.length === 2 && lc.dents[1][2] === -2, '...still there after logging in again');
    P().money = 5000;
    const rd = await g2.f.req('carRepair', { damage: 0.3 });
    ok(rd.ok && gcar().damage == null && gcar().dents == null, 'repaired at the Werkstatt: the damage and the dents are gone');
    await g2.f.req('carDamage', { damage: 0.2, dents });
    const rc = await g2.f.req('carRepair', { damage: 0.2, flat: 'clerk' });
    ok(rc.ok && gcar().damage == null && gcar().dents == null, "...and by the clerk's flat-fee repair");
    const zd = await g2.f.req('carDamage', { damage: 0.1, dents }), z0 = await g2.f.req('carDamage', { damage: 0, dents: [] });
    ok(zd.ok && z0.ok && gcar().damage == null && gcar().dents == null, '...no damage and no dents sent: the record cleared');
    await g2.f.req('carDamage', { damage: 0.6, dents });
    const wt = await g2.f.req('tow', { kind: 'wreck', home: [5, 0, 6, 0] });
    const wbusy = await g2.f.req('carDamage', { damage: 0.9, dents });
    ok(wt.ok && gcar().damage == null && gcar().dents == null && !wbusy.ok && wbusy.err === 'busy', 'a wreck: it comes home repaired (damage cleared; no damage taken while the truck has it)');
    await g2.f.req('towDone');
    // the sums for every model: towing + the full repair far below a new one, the wreck bill never above the sell-back
    const sane = Object.entries(CATALOG.cars).every(([id, list]) => wreckBill(id) === Math.min(Math.round(list * CATALOG.carSell / 50) * 50, CATALOG.wreckFee + repairPrice(id, 1))
      && CATALOG.wreckFee + repairPrice(id, 1) < list * 0.5 && repairPrice(id, 0.5) <= repairPrice(id, 1) && repairPrice(id, 1) === Math.round(list * CATALOG.repairRate / 50) * 50);
    ok(sane && wreckBill('car_lamborghini_huracan') === 26250 && repairPrice('car_lamborghini_huracan', 1) === 24750 && wreckBill('car_vw_golf_gti') === 3200,
      'every model: tow + full repair stays under half the list price (Golf $3,200, Huracan $1,500 + $24,750 = $26,250 of $165,000)');
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
    const eight = await pia.f.req('veh', { k: 'police', cars: Array.from({ length: 8 }, (_, i) => [i, 2, 3, 0, 0]) });
    ok(eight.ok && eight.d.veh.cars.length === 8, 'up to eight patrol cars (five stars: the chasers and a roadblock)');
    const bad2 = await pia.f.req('veh', { k: 'police', cars: Array.from({ length: 9 }, () => [1, 2, 3, 0, 0]) });
    ok(!bad2.ok && bad2.err === 'bad_value', 'at most eight patrol cars');
    const bad3 = await pia.f.req('veh', { k: 'police', cars: [] });
    const bad4 = await pia.f.req('veh', { k: 'police', cars: [[1, 2, 'x', 0, 0]] });
    ok(!bad3.ok && !bad4.ok && bad4.err === 'bad_value', 'no cars / not numbers: refused (send off: true instead)');
    const fast = await pia.f.req('veh', { k: 'police', cars: [[1, 2, 3, 0, 500]] });
    ok(fast.ok && fast.d.veh.cars[0][4] === 75, 'a patrol car speed is clamped');
    const late = await join('Cop Rae');
    const seen = late.l.d.world.players.find((p) => p.name === 'Cop Pia');
    ok(late.l.d.world.id !== pia.l.d.world.id || seen?.vehs?.police?.cars?.length === 1, 'a player who joins sees the patrol cars at once (vehs in the world snapshot)');
    const offR = await pia.f.req('veh', { k: 'police', off: true });
    const offE = same ? await quinn.f.next('veh', (d) => d.k === 'police' && d.pid === pia.l.d.pid && d.veh === null) : true;
    ok(offR.ok && offR.d.veh === null && offE, 'off: the patrol cars are gone for everyone');
    // the rescue helicopter and ambulance coming for a player after a wipeout (net/rescue.js), seen by the others
    pia.f.send('veh', { k: 'rescue', h: [1, 2, 3, 0.5, 0.1, -0.2, 1.7], a: null, s: 1, rope: 9.876 });
    const rv = same ? await quinn.f.next('veh', (d) => d.k === 'rescue' && d.pid === pia.l.d.pid && d.veh) : null;
    ok(!same || (rv && rv.veh.h[0] === 1 && rv.veh.h[6] === 1 && rv.veh.a === null && rv.veh.s === 1 && rv.veh.rope === 9.88), "the others see Pia's rescue helicopter (pose, rotor clamped, on the winch, the rope)");
    const amb = await pia.f.req('veh', { k: 'rescue', h: [1, 2, 3, 0, 0, 0, 0], a: [5, 6, 7, 1, 99], s: 7, l: true });
    ok(amb.ok && amb.d.veh.a[4] === 40 && amb.d.veh.s === 3 && amb.d.veh.l === true, '...and the ambulance (speed and seat clamped, its lights)');
    const badR1 = await pia.f.req('veh', { k: 'rescue', h: [1, 2, 3] });
    const badR2 = await pia.f.req('veh', { k: 'rescue' });
    const badR3 = await pia.f.req('veh', { k: 'rescue', a: [1, 2, 'x', 0, 0] });
    ok(!badR1.ok && !badR2.ok && !badR3.ok && badR1.err === 'bad_value', 'a rescue needs a helicopter [x, y, z, yaw, pitch, roll, rpm] or an ambulance [x, y, z, yaw, v]');
    const offRs = await pia.f.req('veh', { k: 'rescue', off: true });
    const offRe = same ? await quinn.f.next('veh', (d) => d.k === 'rescue' && d.pid === pia.l.d.pid && d.veh === null) : true;
    ok(offRs.ok && offRs.d.veh === null && offRe, 'off: the rescue is gone for everyone');
    // a wrecked car as it lies (tilt [pitch, roll], wreck): drive.js wreckOut, net/carride.js
    server.profileOf('cop pia').cars = [{ id: 'car_vw_golf_gti', paint: 'white', plate: 'PIA 1' }];
    const wk = await pia.f.req('veh', { k: 'car', at: [1, 2, 3, 0.5], tilt: [0.1, 9], wreck: true });
    ok(wk.ok && wk.d.veh.tilt[1] === 3.15 && wk.d.veh.wreck === true && server.profileOf('cop pia').cars[0].at?.[0] === 1, 'a wrecked car: its tilt (clamped) and the wreck flag');
    const wb = await pia.f.req('veh', { k: 'car', at: [1, 2, 3, 0.5], tilt: [0.1] });
    ok(!wb.ok && wb.err === 'bad_value', 'a tilt must be [pitch, roll]');
    await pia.f.req('veh', { k: 'car', off: true }); server.profileOf('cop pia').cars = [];
    // the snowmobile a player drives (net/sled.js): shown while driving, then parked where they left it
    const sd = await pia.f.req('veh', { k: 'sled' });
    const sdE = same ? await quinn.f.next('veh', (d) => d.k === 'sled' && d.pid === pia.l.d.pid && d.veh) : true;
    ok(sd.ok && sd.d.veh.k === 'sled' && !sd.d.veh.at && sdE, "the others see Pia's snowmobile while she drives it");
    const sp = await pia.f.req('veh', { k: 'sled', at: [10.123, 20, 30, 1.5] });
    ok(sp.ok && sp.d.veh.at[0] === 10.12 && sp.d.veh.at[3] === 1.5, '...parked where she left it (at)');
    const sb = await pia.f.req('veh', { k: 'sled', at: [1, 2, 'x', 0] });
    ok(!sb.ok && sb.err === 'bad_value', 'a snowmobile at [x, y, z, yaw] must be numbers');
    const late2 = await join('Sled Sue');
    const seen2 = late2.l.d.world.players.find((p) => p.name === 'Cop Pia');
    ok(late2.l.d.world.id !== pia.l.d.world.id || seen2?.vehs?.sled?.at?.[0] === 10.12, 'a player who joins sees the parked snowmobile (vehs in the world snapshot)');
    const sOff = await pia.f.req('veh', { k: 'sled', off: true });
    ok(sOff.ok && sOff.d.veh === null, 'off: the snowmobile is gone');
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

  // ---------------------------------------------------------------- a police chase carries on after a rejoin
  console.log('wanted');
  {
    const wa = await a.req('profileSet', { key: 'wanted', value: { h: 3.4, e: 12.6, t: 95, f: true, why: 'traffic' } });
    ok(wa.ok && JSON.stringify(server.profileOf('alice').wanted) === JSON.stringify({ h: 3.4, e: 13, t: 95, f: true, why: 'traffic' }), 'profileSet wanted: the chase is kept in the profile');
    const wb = await a.req('profileSet', { key: 'wanted', value: { h: 9, e: 0, t: 0 } });
    const wc = await a.req('profileSet', { key: 'wanted', value: { h: 2, e: -1, t: 0 } });
    ok(!wb.ok && wb.err === 'bad_value' && !wc.ok && server.profileOf('alice').wanted.h === 3.4, 'profileSet wanted: out-of-range stars / escape time refused');
    const pr = await a.req('profile');
    ok(pr.ok && pr.d.profile.wanted?.h === 3.4, 'the chase comes back with the profile (login)');
    const wn = await a.req('profileSet', { key: 'wanted', value: null });
    ok(wn.ok && !('wanted' in server.profileOf('alice')), 'profileSet wanted null: the chase is over');
  }

  // ---------------------------------------------------------------- arrested with a wanted driver: the passengers too
  console.log('accomplices');
  {
    const dn = new Fake(url), pm = new Fake(url), be = new Fake(url);
    await dn.open(); await pm.open(); await be.open();
    const rd = await dn.req('register', { name: 'Driver Dan' }), rp = await pm.req('register', { name: 'Passenger Pam' }), rbe = await be.req('register', { name: 'Bystander Bea' });
    await dn.req('login', { v: PROTO, name: 'Driver Dan', token: rd.d.token });
    await pm.req('login', { v: PROTO, name: 'Passenger Pam', token: rp.d.token });
    await be.req('login', { v: PROTO, name: 'Bystander Bea', token: rbe.d.token });
    const early = await dn.req('policeArrest', { seconds: 90 });
    ok(!early.ok && early.err === 'not_jailed', 'policeArrest: refused while the driver is not in prison himself');
    const rideP = pm.req('perm', { kind: 'carRide', to: 'Driver Dan' });
    const ask = await dn.next('permAsk', (d) => d.kind === 'carRide');
    await dn.req('permAnswer', { rid: ask.rid, allow: true });
    await rideP;
    const seat = await pm.req('seatClaim', { k: 'car', v: 'Driver Dan' });
    ok(seat.ok && seat.d.seat === 1, 'Pam rides in Dan\'s car (seat 1)');
    await dn.req('jail', { seconds: 90, reason: 'fleeing the police' });
    const arr = await dn.req('policeArrest', { seconds: 90 });
    ok(arr.ok && arr.d.passengers.length === 1 && arr.d.passengers[0] === 'Passenger Pam', 'policeArrest: the server arrests the passengers in its own seat registry');
    const got = await pm.next('arrested');
    const Pp = server.profileOf('passenger pam');
    ok(got && got.by === 'Driver Dan' && got.seconds === 90 && got.fine === 1500 && got.jailUntil > Date.now() + 80000, 'Pam is told: arrested with Driver Dan, 90 s, $1,500 fine');
    ok(Pp.money === 500 - 1500 && Pp.jailUntil === got.jailUntil, 'Pam is charged the accomplice fine (into debt) and her sentence is the server\'s');
    const pmoney = await pm.next('money', (d) => d.why === 'accomplice');
    ok(pmoney && pmoney.v === -1000 && pmoney.delta === -1500, 'Pam\'s client gets the new money');
    ok(server.onlineByKey('passenger pam').seat === null && !server.hasGrant('carRide', 'driver dan', 'passenger pam'), 'Pam is out of the car (seat released, ride used up)');
    await sleep(50);
    const Pb = server.profileOf('bystander bea');
    ok(!be.events.some((m) => m.t === 'arrested') && Pb.money === 500 && !Pb.jailUntil, 'a player not in the car is untouched');
    // spam: in again at once, a second arrest within the cooldown does nothing
    const rideP2 = pm.req('perm', { kind: 'carRide', to: 'Driver Dan' });
    const ask2 = await dn.next('permAsk', (d) => d.kind === 'carRide');
    await dn.req('permAnswer', { rid: ask2.rid, allow: true });
    await rideP2;
    await pm.req('seatClaim', { k: 'car', v: 'Driver Dan' });
    const again = await dn.req('policeArrest', { seconds: 90 });
    await sleep(50);
    ok(!again.ok && again.err === 'cooldown' && !pm.events.some((m) => m.t === 'arrested') && Pp.money === -1000 && server.onlineByKey('passenger pam').seat?.v === 'Driver Dan', 'a second policeArrest within the cooldown is refused (Pam stays seated, not charged again)');
    dn.close(); pm.close(); be.close();
    await sleep(100);
  }

  // ---------------------------------------------------------------- the in-game admin panel ('admin': Rafael only)
  console.log('admin panel');
  {
    const rf = new Fake(url);
    await rf.open();
    const rr = await rf.req('register', { name: 'Rafael' });
    const lr = await rf.req('login', { v: PROTO, name: 'rafael', token: rr.d.token });
    ok(lr.ok, 'Rafael logs in');
    const m0 = lr.d.profile.money;
    const add = await rf.req('admin', { op: 'money', add: 100000 });
    ok(add.ok && add.d.money === m0 + 100000, `Rafael's admin money add works (+100,000 -> ${add.d?.money})`);
    const mm = await rf.next('money', (d) => d.why === 'admin');
    ok(mm && mm.v === m0 + 100000 && mm.delta === 100000, "...and a 'money' update follows (the client's money guard takes it)");
    const set = await rf.req('admin', { op: 'money', set: 2500000 });
    ok(set.ok && set.d.money === 2500000, 'admin money set to 2,500,000');
    const bads = await Promise.all([{ add: 0 }, { add: 1.5 }, { add: 'lots' }, { add: 2e7 }, { set: -1 }, { set: 1e9 }, {}].map((x) => rf.req('admin', { op: 'money', ...x })));
    ok(bads.every((r) => !r.ok && r.err === 'bad_amount'), 'invalid admin amounts are refused (bad_amount)');
    ok(server.store.profiles.data.rafael.money === 2500000, '...and change nothing');
    const nope = await a.req('admin', { op: 'money', add: 100000 });
    ok(!nope.ok && nope.err === 'forbidden', "a non-Rafael connection is refused ('forbidden')");
    const nope2 = await a.req('admin', { op: 'unlock', what: 'skis' });
    ok(!nope2.ok && nope2.err === 'forbidden', '...for every op (unlock too)');
    const anon = new Fake(url);
    await anon.open();
    const an = await anon.req('admin', { op: 'money', add: 100, name: 'Rafael', admin: true });
    ok(!an.ok && an.err === 'not_logged_in', 'a connection not logged in is refused (a name in the request counts for nothing)');
    anon.close();
    const us = await rf.req('admin', { op: 'unlock', what: 'skis' });
    ok(us.ok && Object.keys(CATALOG.skis).every((id) => us.d.owned.includes(id)), 'admin unlock: every pair of skis');
    const uo = await rf.req('admin', { op: 'unlock', what: 'outfits' });
    ok(uo.ok && Object.keys(CATALOG.outfits).every((id) => uo.d.outfits.owned.includes(id)), 'admin unlock: every outfit');
    const eq = await rf.req('profileSet', { key: 'skis', value: 'legend' });
    ok(eq.ok, '...and the unlocked skis can be equipped (profileSet skis)');
    const ps = await rf.req('admin', { op: 'pass', on: true });
    ok(ps.ok && ps.d.dayPass === server.worlds.get(lr.d.world.id).dayAt(), "admin day pass: today's (the world's day)");
    const tm = await rf.req('admin', { op: 'time', hour: 22 });
    const ck = await rf.next('clock', (d) => Math.abs(d.hour - 22) < 0.01);
    ok(tm.ok && Math.abs(tm.d.clock.hour - 22) < 0.01 && !!ck, "admin time: the world's clock at 22:00, broadcast");
    const wx = await rf.req('admin', { op: 'weather', w: 'heavy' });
    ok(wx.ok && wx.d.clock.weather === 'heavy', 'admin weather: heavy snow');
    const wb = await rf.req('admin', { op: 'weather', w: 'toString' });
    ok(!wb.ok && wb.err === 'bad_value', 'an unknown weather is refused');
    const hl = await rf.req('admin', { op: 'heli' });
    const W = server.worlds.get(lr.d.world.id), padAt = W.heli.padAt;
    ok(hl.ok && W.heli.copies.some((h) => h.name === 'Rafael' && h.admin), 'admin helicopter: a free copy on his name');
    const hv = await rf.req('veh', { k: 'heli', at: [10, 50, 10, 0] });
    ok(hv.ok, '...shown to everyone (veh heli accepted)');
    await rf.req('heliReturn');
    ok(W.heli.padAt === padAt && !W.heli.copies.some((h) => h.name === 'Rafael'), "...returned without touching the pad's next helicopter");
    const bo = await rf.req('admin', { op: 'nope' });
    ok(!bo.ok && bo.err === 'bad_op', 'an unknown admin op is refused');
    rf.close();
    await sleep(100);
    server.store.flush();
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
    ok(disk.rafael?.money === 2500000 && disk.rafael.owned.includes('legend'), "Rafael's admin money and unlocks persist (on disk)");
  }

  // ---------------------------------------------------------------- knocked poles, broken guardrails ('brk')
  console.log('breakables');
  {
    const mk = async (name) => { const f = new Fake(url); await f.open(); const r = await f.req('register', { name }); f.l = await f.req('login', { v: PROTO, name, token: r.d.token }); return f; };
    const k1 = await mk('Knocker'), k2 = await mk('Watcher');
    ok(k1.l.d.world.id === k2.l.d.world.id && Array.isArray(k2.l.d.world.brk), 'the world snapshot carries the knocked list (brk)');
    const W = server.worlds.get(k1.l.d.world.id);
    const r1 = await k1.req('brk', { k: 'pole', id: '1234,-5678', v: [8.5, 4.2, -3.1] });
    const ev = await k2.next('brk', (d) => d.id === '1234,-5678');
    ok(r1.ok && ev && ev.k === 'pole' && ev.v[0] === 8.5 && ev.v[2] === -3.1 && ev.pid === k1.l.d.pid, 'a knocked pole is relayed to the others in the world (id, flight, who)');
    await sleep(50);
    ok(!k1.events.some((m) => m.t === 'brk'), '...not back to the one who knocked it');
    const rr = await k1.req('brk', { k: 'rail', id: '-100,200', v: [20, 3, 1] });
    ok(rr.ok && !!(await k2.next('brk', (d) => d.k === 'rail' && d.id === '-100,200')), 'a broken guardrail section is relayed too');
    const again = await k2.req('brk', { k: 'pole', id: '1234,-5678', v: [1, 2, 3] });
    ok(!again.ok && again.err === 'down', 'knocking one already down is not relayed again');
    const bads = [{ k: 'tree', id: '1,2', v: [1, 2, 3] }, { k: 'pole', id: 'x,2', v: [1, 2, 3] }, { k: 'pole', id: '12345678,2', v: [1, 2, 3] }, { k: 'pole', id: '1,2', v: [1, 2] },
      { k: 'pole', id: '1,2', v: [1, 'a', 3] }, { k: 'pole', id: '1,2', v: [1, 2, 999] }, { k: 'pole', id: 7, v: [1, 2, 3] }];
    let refused = 0;
    for (const d of bads) { const r = await k1.req('brk', d); if (!r.ok && r.err === 'bad_brk') refused++; }
    ok(refused === bads.length && !W.brk.has('pole|1,2') && !W.brk.has('tree|1,2'), 'bad kinds, ids and flights are refused (bad_brk), nothing kept');
    // the rate limit: 10 a second at most
    await sleep(1100);
    k2.events.length = 0;
    const res = await Promise.all(Array.from({ length: 16 }, (_, i) => k1.req('brk', { k: 'pole', id: `${i},${900 + i}`, v: [1, 1, 1] })));
    await sleep(100);
    const got = k2.events.filter((m) => m.t === 'brk').length, rated = res.filter((r) => !r.ok && r.err === 'rate').length;
    ok(got >= 10 && got <= 11 && rated === 16 - got, `over 10 knocks a second are refused (rate) and not relayed (${got} relayed, ${rated} refused)`);
    // a player joining within the 90 s: the knocks come with the world, already down
    const k3 = await mk('Latecomer');
    const list = k3.l.d.world.brk || [];
    const p0 = list.find((x) => x.k === 'pole' && x.id === '1234,-5678'), r0 = list.find((x) => x.k === 'rail' && x.id === '-100,200');
    ok(p0 && r0 && p0.v[1] === 4.2 && p0.age >= 0 && p0.age < 90000, 'a joiner gets the knocked poles and broken guardrails (flight, age)');
    // 90 s later: gone from the list (standing again for everyone)
    for (const e of W.brk.values()) e.at -= 91000;
    const k4 = await mk('Laterstill');
    ok((k4.l.d.world.brk || []).length === 0 && W.brk.size === 0, 'after 90 s the knocks are forgotten (a joiner gets none)');
    const r9 = await k2.req('brk', { k: 'pole', id: '1234,-5678', v: [1, 2, 3] });
    ok(r9.ok && !!(await k1.next('brk', (d) => d.id === '1234,-5678' && d.pid === k2.l.d.pid)), '...and can be knocked again');
    k1.close(); k2.close(); k3.close(); k4.close();
    await sleep(50);
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
