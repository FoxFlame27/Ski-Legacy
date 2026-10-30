// Regenerates server/lib/catalog.json from the game's own price tables (run from the repo root after a price
// change: `node server/tools/gen-catalog.mjs`). The server reads only the JSON, so the VPS never needs the client
// source. server/test.mjs checks the JSON is still in step with the client when the client source is present.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { register } from 'node:module';

// the client modules import their stylesheets (Vite): load those as empty modules here
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, ctx, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, ctx);
}`));

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'src');
const imp = (p) => import(path.join(src, p));

export async function buildCatalog() {
  const { SKIS, PRICES } = await imp('game/economy.js');
  const { FINISH, PAINTS, INTERIORS, RIMS, PLATE_COST } = await imp('game/carconfig.js');
  const { RENTALS, WRECK_FEE, WRECK_RATE, WRECK_MIN, SELL_SHARE, GARAGE_MAX } = await imp('game/carrental.js');
  const { OUTFIT_ITEMS, OUTFIT_KITS } = await imp('game/outfits.js');
  const { CHALET_PRICE } = await imp('game/chalets.js');
  const { HELI_PRICE } = await imp('game/heli.js');
  const fw = await imp('modes/parkour/freeworld.js');
  await fw.registerFreeWorldCourses();
  const { BUS_RACE_DEFS, BUS_PRIZE } = await imp('modes/race/busracedefs.js'); // (the ski bus's free races)
  return {
    skis: Object.fromEntries(SKIS.map((s) => [s.id, { price: s.price, rent: !!s.rent }])),
    prices: { ...PRICES, heli: HELI_PRICE },
    chalet: { price: CHALET_PRICE, count: 18 },
    cars: Object.fromEntries(RENTALS.map((c) => [c.id, c.price])),
    paints: Object.fromEntries(PAINTS.map((p) => [p.id, FINISH[p.finish].cost])),
    interiors: Object.fromEntries(INTERIORS.map((i) => [i.id, i.cost])),
    rims: Object.fromEntries(RIMS.map((r) => [r.id, r.cost])),
    plateCost: PLATE_COST,
    wreckFee: WRECK_FEE, // (the tow truck: a car towed off a road; server.tow)
    wreckRate: WRECK_RATE, wreckMin: WRECK_MIN, // (a wreck: the repair bill, this share of the car's list price, at least wreckMin)
    carSell: SELL_SHARE, // (AUTOHAUS: a car sold back, this share of what you paid; server.carSell)
    garageMax: GARAGE_MAX, // (AUTOHAUS: the cars one player can own, the same model more than once too; server buy: garage_full)
    outfits: Object.fromEntries([...OUTFIT_ITEMS, ...OUTFIT_KITS].map((o) => [o.id, o.price || 0])), // (kits too: owning a kit owns its pieces 'kit_x.jacket')
    races: Object.fromEntries([
      ...fw.freeCourses().map((e) => [e.id, { name: e.name, reward: e.reward, entry: e.D.entry }]),
      // the bus races: free entry, one racer may start one (need 1), prizes by place with someone behind you, else by
      // the time against par (ms); server.finishRace
      ...BUS_RACE_DEFS.map((d) => [d.id, { name: d.name, reward: d.reward, entry: 0, bus: true, need: 1, par: d.par * 1000, shares: BUS_PRIZE.shares, parShare: BUS_PRIZE.parShare, rest: BUS_PRIZE.rest }]),
    ]),
    prizeShare: fw.PRIZE_SHARE,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cat = await buildCatalog();
  writeFileSync(path.join(here, '..', 'lib', 'catalog.json'), JSON.stringify(cat, null, 1) + '\n');
  console.log('catalog.json written:', Object.keys(cat).map((k) => `${k} ${typeof cat[k] === 'object' ? Object.keys(cat[k]).length : cat[k]}`).join(', '));
}
