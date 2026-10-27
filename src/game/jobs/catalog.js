// Job catalogue: the offers pinned on each board (three per board, the same all game day, a slot is
// re-pinned when its job is done, failed or dropped), with their story, pay, par time and time limit.
// Offers are plain data (they live in the save while a job is under way) and fully deterministic:
// board + day + slot + how many times that slot was re-pinned.
import { mulberry32 } from '../../core/noise.js';
import { world } from '../../world/world.js';
import { ITEMS } from './props.js';

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const round5 = (v) => Math.round(v / 5) * 5;
const round15 = (v) => Math.ceil(v / 15) * 15;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pickOne = (arr, rnd) => arr[Math.floor(rnd() * arr.length) % arr.length];

export const GUESTS = ['Anna', 'Lukas', 'Sofia', 'Henrik', 'Chloé', 'Matteo', 'Mia', 'Jonas', 'Elsa', 'Tom', 'Nina', 'Yuki', 'Priya', 'Ben', 'Lea', 'Marta'];
export const SKILLS = {
  beginner: { vmax: 9.5, factor: 0.7, plow: true, text: 'new to skiing' },
  steady: { vmax: 13, factor: 0.82, plow: false, text: 'a careful skier' },
  strong: { vmax: 17, factor: 0.95, plow: false, text: 'a strong skier in a hurry' },
};
// who stands where (a ski patroller in red, the lift crew in orange...) when that model exists
// (never the two player bodies, skier_red / skier_blue: a player in stock clothes would meet a twin)
const ROLE_CHAR = { patrol: 'skier_black', operator: 'skier_orange', starter: 'skier_black', crew: 'skier_purple', chef: 'skier_green' };

// Deliveries. kinds: destination kinds it goes to; from: board kinds that hand it out.
// `supplies` are pinned in slot 0, `service` runs in slot 2, so two deliveries never repeat.
export const CARGO = {
  fondue: {
    pack: 'food', noun: 'fondue cheese', title: 'Fondue cheese', kinds: ['hut'], from: ['village'], pool: 'supplies',
    client: (d) => `${d.place} kitchen`,
    brief: (d) => `We ran out of Gruyère before the lunch rush. Bring this wheel up to the chef by the door of ${d.place}.`,
    crash: 'The cheese took a tumble · the kitchen sent for more', late: 'Too late · the kitchen made do without the cheese',
  },
  bread: {
    pack: 'food', noun: 'bread', title: 'Fresh bread', kinds: ['hut'], from: ['village', 'hut'], pool: 'supplies',
    client: () => 'Village bakery',
    brief: (d) => `Warm loaves for ${d.place}. Hand them to the chef at the door while they are fresh.`,
    crash: 'The bread got squashed in the tumble', late: 'Too late · the bread went stale',
  },
  cocoa: {
    pack: 'food', noun: 'hot chocolate', title: 'Hot chocolate', kinds: ['lift', 'patrol', 'race', 'park'], from: ['hut', 'top'], pool: 'supplies', perishable: true,
    client: (d, hub) => (hub.kind === 'hut' ? `${hub.name} kitchen` : 'Summit café'),
    brief: (d) => `A flask of hot chocolate for ${d.whoAt}. It cools fast, so no stopping for photos.`,
    crash: 'The hot chocolate got cold', late: 'The hot chocolate got cold',
  },
  mail: {
    pack: 'mail', noun: 'mail bag', title: 'Mail bag', kinds: ['board'], from: ['hut', 'top'], pool: 'supplies', toVillage: true,
    client: (d, hub) => `${hub.name} post`,
    brief: () => 'Postcards and letters from the summit guests. Drop the bag at the job board in the village.',
    crash: 'The mail bag burst in the tumble · the postman will sort it out', late: 'Too late · the post already left',
  },
  firstaid: {
    pack: 'patrol', noun: 'first-aid kit', title: 'First-aid kit', kinds: ['patrol'], from: ['village', 'hut', 'top'], pool: 'service',
    client: () => 'Ski patrol',
    brief: (d) => `The patrol at ${d.place} is short of bandages. Bring them this kit.`,
    crash: 'The first-aid kit was lost in the tumble', late: 'Too late · the patrol borrowed a kit',
  },
  radio: {
    pack: 'patrol', noun: 'radio batteries', title: 'Radio batteries', kinds: ['patrol'], from: ['village', 'hut', 'top'], pool: 'service',
    client: () => 'Ski patrol',
    brief: (d) => `The radios at ${d.place} are nearly flat. Take them these batteries.`,
    crash: 'The batteries scattered in the snow', late: 'Too late · the radios went flat',
  },
  part: {
    pack: 'tools', noun: 'spare part', title: 'Spare part', kinds: ['lift'], from: ['village', 'hut', 'top'], pool: 'service',
    client: () => 'Lift maintenance',
    brief: (d) => `The ${d.lift} needs a spare grip bolt. Hand it to the operator at the ${d.top ? 'top' : 'base'} station.`,
    crash: 'The spare part is somewhere in the snow now', late: 'Too late · maintenance found a spare',
  },
  bibs: {
    pack: 'race', noun: 'race bibs', title: 'Race bibs', kinds: ['race'], from: ['village', 'hut', 'top'], pool: 'service',
    client: () => 'Race office',
    brief: (d) => `The ${d.race} starts soon and the bibs are still here. Bring them to the starter.`,
    crash: 'The bibs scattered across the slope', late: 'Too late · the race started without bibs',
  },
  shovels: {
    pack: 'tools', noun: 'shovels', title: 'Park shovels', kinds: ['park'], from: ['village', 'hut', 'top'], pool: 'service',
    client: () => 'Park crew',
    brief: () => 'The park crew needs shovels to shape the kickers. Bring these to the Legacy Park drop-in.',
    crash: 'The shovels went flying · the crew will manage', late: 'Too late · the crew borrowed shovels',
  },
};
const WHO_AT = { operator: (d) => `the operator at ${d.place}`, patrol: (d) => `the patrol at ${d.place}`, starter: (d) => `the starter at ${d.place}`, crew: () => 'the park crew', chef: (d) => `the chef at ${d.place}` };

// ------------------------------------------------------------------ offers
// ctx: { sites, est(a, b) -> seconds, chars: [available character ids], canRig }
export function generateOffers(ctx, hub, day, gens = []) {
  const out = [];
  for (let slot = 0; slot < 3; slot++) {
    const gen = gens[slot] || 0;
    const rnd = mulberry32(hashStr(`${hub.id}|${day}|${slot}|${gen}`));
    const order = slotTypes(slot, rnd, ctx);
    let offer = null;
    for (const type of order) {
      offer = makeOffer(ctx, hub, type, slot, rnd);
      if (offer) break;
    }
    if (!offer) continue;
    offer.id = `${hub.id}|${day}|${slot}|${gen}`;
    offer.board = hub.id; offer.slot = slot; offer.gen = gen; offer.day = day;
    out.push(offer);
  }
  return out;
}

// Each slot owns its job types, so two slots never pin the same job and re-pinning one slot never
// changes the others: 0 = supplies run, 1 = rescue or lost & found, 2 = guide or service run.
function slotTypes(slot, rnd, ctx) {
  const r = rnd();
  if (slot === 0) return ['delivery'];
  if (slot === 1) return r < 0.55 ? ['rescue', 'lost'] : ['lost', 'rescue'];
  return ctx.canRig && r < 0.55 ? ['escort', 'delivery'] : ['delivery', 'escort'];
}

// up to `tries` random candidates; the first one `accept` takes
function pick(list, rnd, accept, tries = 14) {
  if (!list.length) return null;
  for (let i = 0; i < tries; i++) {
    const c = list[Math.floor(rnd() * list.length) % list.length];
    const r = accept(c);
    if (r) return r;
  }
  return null;
}

function charFor(ctx, rnd, role) {
  const chars = ctx.chars;
  if (!chars.length) return null;
  const want = ROLE_CHAR[role];
  return want && chars.includes(want) ? want : pickOne(chars, rnd);
}

const hyp = Math.hypot;

function makeOffer(ctx, hub, type, slot, rnd) {
  const { sites } = ctx;
  const from = hub.front;
  if (type === 'delivery') {
    const pool = slot === 0 ? 'supplies' : 'service';
    const cands = [];
    for (const [key, c] of Object.entries(CARGO)) {
      if (c.pool !== pool || !c.from.includes(hub.kind)) continue;
      for (const d of sites.dests) {
        if (!c.kinds.includes(d.kind) || d.id === `board:${hub.id}`) continue;
        if (d.kind === 'board' && (!c.toVillage || d.hubId !== 'village')) continue;
        if (hub.hut && d.kind === 'hut' && d.place === hub.name) continue;
        if (hyp(d.x - from.x, d.z - from.z) < 100) continue;
        cands.push([key, d]);
      }
    }
    return pick(cands, rnd, ([key, d]) => {
      const c = CARGO[key];
      const est = ctx.est(from, d);
      if (est < 45 || est > (c.perishable ? 300 : 540)) return null;
      const reward = round5(clamp(35 + est * 0.22 + (c.perishable ? 15 : 0), 40, 150));
      const dest = { ...destData(d), char: d.npc ? charFor(ctx, rnd, d.role) : null };
      return {
        type: 'delivery', cargo: key, pack: c.pack,
        title: `${c.title} to ${shortOf(d)}`, short: c.title,
        client: c.client(d, hub), brief: c.brief({ ...d, whoAt: WHO_AT[d.role]?.(d) || d.to }),
        reward, bonus: round5(reward * 0.35), est: Math.round(est),
        par: Math.round(est * (c.perishable ? 0.8 : 0.9)), limit: round15(est * (c.perishable ? 1.35 : 1.7) + 45),
        dest,
      };
    });
  }
  if (type === 'rescue') {
    const near = sites.spots.filter((s) => hyp(s.x - from.x, s.z - from.z) < 3200 && hyp(s.x - from.x, s.z - from.z) > 150);
    return pick(near, rnd, (s) => {
      const est = ctx.est(from, s);
      if (est < 50 || est > 480) return null;
      // once you reach them they ski down with you: to the lift, hut or village at the bottom
      const down = descentFor(sites, s);
      if (!down) return null;
      const estDown = ctx.est(s, down);
      if (estDown > 420) return null;
      const reward = round5(clamp(70 + est * 0.22 + estDown * 0.3, 90, 240));
      const variant = rnd() < 0.6 ? 'injured' : 'stuck';
      const name = pickOne(GUESTS, rnd);
      return {
        type: 'rescue', variant,
        title: variant === 'injured' ? `Skier down · ${s.piste}` : `Stuck in the snow · ${s.piste}`, short: variant === 'injured' ? 'Skier down' : 'Stuck skier',
        client: 'Ski patrol',
        brief: variant === 'injured'
          ? `${name} went down beside the ${s.piste} piste and hurt a knee. Get there fast (look for the crossed skis), help them up and ski them down to ${down.to}. Stay close, and don't crash: a fall ends the rescue.`
          : `${name}, a beginner, came out of their skis in deep snow beside the ${s.piste} piste. Help them back up and lead them down to ${down.to}. Take it easy: a fall ends the rescue.`,
        reward, bonus: round5(reward * 0.25), est: Math.round(est), estDown: Math.round(estDown), par: Math.round(est * 0.9), limit: round15(est * 1.55 + 60),
        spot: { x: s.x, z: s.z, heading: s.heading, side: rnd() < 0.5 ? -1 : 1, edge: s.side, piste: s.piste, char: charFor(ctx, rnd, 'guest'), name },
        dest: { kind: 'spot', label: variant === 'injured' ? 'Injured skier' : 'Stuck skier', short: `the ${s.piste} piste`, x: s.x, z: s.z },
        down,
      };
    });
  }
  if (type === 'lost') {
    const near = sites.areas.filter((a) => hyp(a.x - from.x, a.z - from.z) < 3200 && hyp(a.x - from.x, a.z - from.z) > 60);
    const items = Object.keys(ITEMS);
    return pick(near, rnd, (a) => {
      const est = ctx.est(from, a) + ctx.est(a, from);
      if (est > 720) return null;
      const spot = sites.itemSpot(a, rnd);
      if (!spot) return null;
      const item = pickOne(items, rnd), noun = ITEMS[item].noun, guest = pickOne(GUESTS, rnd);
      // the round trip plus a minute or two of searching: paid like the other jobs per minute
      const reward = round5(clamp(30 + est * 0.36, 50, 190));
      return {
        type: 'lost', item, noun, guest,
        title: `Lost ${noun} · ${a.label}`, short: `Lost ${noun}`,
        client: 'Guest services',
        brief: `${guest} lost their ${noun} near ${a.place}. Search the area (it may glint in the sun) and bring it back to this board. A quick find earns a tip.`,
        reward, bonus: round5(reward * 0.25), est: Math.round(est), par: Math.round(est * 1.2 + 60), limit: round15(est * 2 + 300),
        area: { x: a.x, z: a.z, r: a.r, label: a.label, place: a.place }, itemPos: spot,
        dest: { kind: 'board', hubId: hub.id, label: `Job board · ${hub.name}`, short: hub.kind === 'village' ? 'the village' : hub.name, x: hub.front.x, z: hub.front.z, place: hub.place },
      };
    });
  }
  if (type === 'escort') {
    if (!ctx.canRig) return null;
    const cands = sites.escortDests.filter((d) => d.id !== `board:${hub.id}` && !(hub.hut && d.kind === 'hut' && d.place === hub.name) && hyp(d.x - from.x, d.z - from.z) > 250);
    return pick(cands, rnd, (d) => {
      const est = ctx.est(from, d);
      if (est < 90 || est > 600) return null;
      const skill = pickOne(Object.keys(SKILLS), rnd), S = SKILLS[skill], name = pickOne(GUESTS, rnd);
      const estG = est / S.factor;
      const reward = round5(clamp(85 + estG * 0.2, 90, 190));
      const to = d.kind === 'board' && d.hubId === 'village' ? 'Legacy Village' : d.kind === 'board' ? d.place : d.to;
      return {
        type: 'escort', title: `Guide ${name} to ${shortOf(d)}`, short: `Guiding ${name}`,
        client: 'Ski school',
        brief: `${name} is ${S.text} and wants to get to ${to}. Lead the way and keep ${name} close: they follow your tracks at their own pace. Quick and safe earns a tip.`,
        reward, bonus: round5(reward * 0.3), est: Math.round(estG), par: Math.round(estG * 0.95), limit: round15(estG * 1.7 + 90),
        guest: { name, skill, char: charFor(ctx, rnd, 'guest'), ski: skill === 'strong' ? 'pro' : skill === 'steady' ? 'sport' : 'rental' },
        dest: destData(d),
      };
    });
  }
  return null;
}

// the destination fields an offer keeps (plain data for the save)
function destData(d) {
  const o = { kind: d.kind, id: d.id, label: d.label, short: shortOf(d), to: d.to, place: d.place, x: d.x, z: d.z, yaw: d.yaw || 0, npc: !!d.npc, role: d.role || null };
  if (d.hubId) o.hubId = d.hubId;
  return o;
}

// Where a rescued skier is taken: the lift base, hut or village at the bottom of their piste (else the
// nearest of them well below the spot), reached by skiing down. Plain data for the save.
export function descentFor(sites, spot) {
  if (!sites || !spot) return null;
  const h0 = world.height(spot.x, spot.z);
  if (!Number.isFinite(h0)) return null;
  // the low end of the piste they were skiing
  let end = null;
  const p = spot.piste ? sites.layout?.pistes?.find((q) => q.name === spot.piste) : null;
  if (p?.pts?.length > 1) {
    const a = p.pts[0], b = p.pts[p.pts.length - 1];
    const [x, z] = world.height(a[0], a[1]) < world.height(b[0], b[1]) ? a : b;
    end = { x, z };
  }
  let best = null, bs = Infinity;
  for (const d of sites.dests || []) {
    const ok = (d.kind === 'lift' && !d.top) || (d.kind === 'board' && d.hubId === 'village') || d.kind === 'hut';
    if (!ok) continue;
    const dist = hyp(d.x - spot.x, d.z - spot.z), dh = world.height(d.x, d.z) - h0;
    if (dist < 120 || dist > 2600 || dh > -25 || dh > -0.06 * dist - 10) continue; // well below: skied down to
    const score = dist + (end ? hyp(d.x - end.x, d.z - end.z) * 1.5 : 0);
    if (score < bs) { bs = score; best = d; }
  }
  if (!best) return null;
  const village = best.kind === 'board';
  return {
    kind: best.kind, id: best.id, x: best.x, z: best.z,
    label: village ? 'Legacy Village' : best.label,
    short: village ? 'the village' : shortOf(best),
    to: village ? 'Legacy Village' : best.to,
  };
}

// short destination name for titles
export function shortOf(d) {
  if (d.kind === 'board') return d.hubId === 'village' ? 'the village' : d.place;
  if (d.kind === 'patrol') return `${d.peak} patrol`;
  if (d.kind === 'lift') return `${d.lift} ${d.top ? 'top' : 'base'}`;
  if (d.kind === 'race') return `${d.race} start`;
  return d.label;
}

// polite failure messages
export function failText(job, reason) {
  if (job.type === 'delivery') {
    const c = CARGO[job.cargo];
    if (!c) return 'Job cancelled';
    if (reason === 'late') return c.late;
    if (reason === 'crash') return c.crash;
    return c.perishable ? c.late : `Job dropped · someone else took the ${c.noun}`; // ski bus, a race session
  }
  if (job.type === 'rescue') {
    const n = job.spot?.name || 'the skier';
    if (job.phase === 'down') {
      if (reason === 'crash') return 'Rescue failed · you crashed';
      if (reason === 'late') return `Too slow · the ski patrol took ${n} down`;
      if (reason === 'lost') return `${n} lost you · the ski patrol took over`;
      return 'The ski patrol took over the rescue';
    }
    if (reason === 'late') return 'The ski patrol reached the skier first';
    return reason === 'crash' ? 'You took a tumble yourself · the patrol has it covered' : 'The ski patrol took over the rescue';
  }
  if (job.type === 'escort') {
    const n = job.guest?.name || 'Your guest';
    if (reason === 'late') return `${n} gave up and took the ski bus`;
    if (reason === 'lost') return `${n} lost sight of you and headed back`;
    return `${n} made it down safely on their own`;
  }
  if (job.type === 'lost') return `The guest gave up on their ${job.noun || 'things'}`;
  return 'Job cancelled';
}

export function successText(job, total, tip) {
  const pay = tip ? `$${job.reward} + $${tip} tip` : `+$${total}`;
  if (job.type === 'delivery') return `Delivered · ${pay}`;
  if (job.type === 'rescue') {
    if (job.phase === 'down') return `${job.spot?.name || 'The skier'} is safe at ${job.down?.short || 'the bottom'} · ${pay}`;
    return job.variant === 'injured' ? `Patrol is on the way · ${pay}` : `Back on their skis · ${pay}`;
  }
  if (job.type === 'lost') return `${job.guest || 'The guest'} is thrilled · ${pay}`;
  if (job.type === 'escort') return `${job.guest?.name || 'Your guest'} arrived · ${pay}`;
  return `Job done · ${pay}`;
}

export function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}
