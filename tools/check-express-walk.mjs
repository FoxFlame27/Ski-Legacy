// Checks walking about inside the Legacy Express's car (src/world/express.js: walkBoxes / walkMove), without a browser
// (user Oct 31 2026: "walk around inside the Legacy Express while it drives"): node tools/check-express-walk.mjs
//  -> the aisle clear its whole length, the rear wall to the cab door; never through a seat pair, a table or a wall;
//     standing up from every seat lands you clear in the aisle; every seat reachable to sit down (within 1.6 m).
import { buildCar, CAR, CABIN } from '../src/world/train.js';
import { walkBoxes, walkMove, WALK } from '../src/world/express.js';

const car = buildCar({ express: true });
const seats = car.seats, boxes = walkBoxes(seats), fails = [];
const ok = (c, msg) => { if (!c) fails.push(msg); };
const inBox = (w) => boxes.find((b) => Math.hypot(w.x - Math.max(b.x0, Math.min(b.x1, w.x)), w.z - Math.max(b.z0, Math.min(b.z1, w.z))) < WALK.r - 0.01);
console.log(`${seats.length} seats, ${boxes.length} boxes (${boxes.filter((b) => b.kind === 'seat').length} seat pairs)`);
// nothing in the aisle
for (const b of boxes) ok(b.x0 >= CAR.aisle - 0.02 || b.x1 <= -CAR.aisle + 0.02, `${b.kind} box in the aisle: x ${b.x0.toFixed(2)}..${b.x1.toFixed(2)}`);
// down the aisle, end to end
const w = { x: 0, z: 0 };
for (let i = 0; i < 400; i++) walkMove(w, 0, 0.05, boxes);
const front = w.z;
for (let i = 0; i < 800; i++) walkMove(w, 0, -0.05, boxes);
console.log(`aisle: z ${w.z.toFixed(2)} .. ${front.toFixed(2)} (rear wall ${(-CAR.half + 0.12).toFixed(2)}, cab door ${CAR.cabZ.toFixed(2)})`);
ok(front > CAR.cabZ - 0.4 && w.z < -CAR.half + 0.6, 'the aisle walks the whole car');
// random walks: never inside a box or out through the walls
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let k = 0; k < 40; k++) {
  const p = { x: 0, z: -7 + rnd() * 13 };
  walkMove(p, 0, 0, boxes);
  for (let i = 0; i < 300; i++) {
    walkMove(p, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3, boxes);
    const b = inBox(p);
    if (b) { ok(false, `inside a ${b.kind} at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`); break; }
    if (Math.abs(p.x) > CABIN.W - WALK.r + 1e-3 || p.z < WALK.z0 || p.z > WALK.z1) { ok(false, `out of the car at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`); break; }
  }
}
// standing up from each seat (into the aisle beside it) and sitting down again
for (const st of seats) {
  const p = walkMove({ x: 0, z: st.pos.z }, 0, 0, boxes);
  ok(!inBox(p) && Math.abs(p.z - st.pos.z) < 0.05, `standing up from seat at ${st.pos.x.toFixed(2)}, ${st.pos.z.toFixed(2)}`);
  ok(Math.hypot(st.pos.x - p.x, st.pos.z - p.z) < 1.6, `seat at ${st.pos.x.toFixed(2)}, ${st.pos.z.toFixed(2)} out of reach from the aisle`);
}
if (fails.length) { console.log('FAIL\n ' + [...new Set(fails)].slice(0, 20).join('\n ')); process.exit(1); }
console.log('OK');
