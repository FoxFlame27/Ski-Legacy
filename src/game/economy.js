// Ski gear catalogue, lift prices and persistent save data.
import { migrateCharacter } from './characters.js';
import { MP } from '../net/mode.js';

export const SKIS = [
  { id: 'rental', name: 'Rental Carver', model: 'ski_rental', price: 50, rent: true, speed: 1.0, grip: 1.0, desc: 'Basic rental skis. Forgiving and slow-ish. Returned at the end of your stay.' },
  { id: 'cruiser', name: 'Alpine Cruiser 160', model: 'ski_cruiser', fallback: 'ski_rental', price: 300, speed: 1.015, grip: 1.05, desc: 'Easy-going beginner ski. Smooth and forgiving, a touch quicker than the rentals.' },
  { id: 'sport', name: 'Sport All-Mountain 170', model: 'ski_sport', price: 800, speed: 1.03, grip: 1.08, desc: 'Lively all-mountain ski. +3% glide speed, better edge hold.' },
  { id: 'park', name: 'Twin Tip Park 168', model: 'ski_park', fallback: 'ski_sport', price: 1000, speed: 1.02, grip: 1.1, desc: 'Twin-tip freestyle ski for the park. Pops off kickers, lands switch.' },
  { id: 'powder', name: 'Powder Hound 184', model: 'ski_powder', fallback: 'ski_sport', price: 1200, speed: 1.03, grip: 1.12, desc: 'Wide freeride ski. Floats off-piste and stays calm at speed.' },
  { id: 'touring', name: 'Summit Touring 176', model: 'ski_touring', fallback: 'ski_sport', price: 1600, speed: 1.04, grip: 1.1, desc: 'Light touring ski. Quick and nimble everywhere on the mountain.' },
  { id: 'carver', name: 'Slalom Carver SL', model: 'ski_carver', fallback: 'ski_pro', price: 2200, speed: 1.045, grip: 1.2, desc: 'Short-radius slalom ski. Bites hard on every turn.' },
  { id: 'pro', name: 'World Cup GS Pro', model: 'ski_pro', price: 3000, speed: 1.06, grip: 1.16, desc: 'Race-stock giant slalom ski. +6% speed, razor edges.' },
  { id: 'gs', name: 'Giant Slalom R30', model: 'ski_gs', fallback: 'ski_pro', price: 4000, speed: 1.07, grip: 1.18, desc: 'World Cup giant slalom ski. Fast and stable through long turns.' },
  { id: 'superg', name: 'Super-G Arrow', model: 'ski_superg', fallback: 'ski_elite', price: 5500, speed: 1.085, grip: 1.2, desc: 'Long super-G race ski built for pure speed.' },
  { id: 'elite', name: 'Legacy Elite Downhill', model: 'ski_elite', fallback: 'ski_pro', price: 8000, speed: 1.1, grip: 1.22, desc: 'Hand-built downhill weapon. +10% speed, unmatched stability.' },
  { id: 'legend', name: 'Legacy Gold Edition', model: 'ski_legend', fallback: 'ski_elite', price: 12000, speed: 1.12, grip: 1.25, desc: 'The ultimate ski. +12% speed and perfect edge grip.' },
];

export const GEAR_YOU_OWN = ['Helmet', 'Goggles', 'Ski jacket', 'Ski pants', 'Gloves', 'Ski boots'];

// The economy (Oct 29 rebalance, see the table in jobs/catalog.js): a good hour of jobs pays ~$9,000, of races
// ~$15,000+; a lift ride is a few seconds of that, a day pass (one game day = 16 min) about a minute.
export const PRICES = { gondola: 50, chair: 20, dayPass: 150, hotChocolate: 8 };

const KEY = 'ski-legacy-save-v1';

export const save = {
  money: 500, // a new save: basic skis and a day pass, then jobs and races
  skis: null, // equipped ski id
  owned: [],
  character: 'skier_blue', // the player character: 'skier_red' (man) or 'skier_blue' (woman), see characters.js
  dayPass: -1, // day number the pass is valid for
  tickets: 0, // single gondola tickets bought from the seller
  day: 1,
  hour: 9.5,
  stats: { races: 0, wins: 0, topSpeed: 0, distance: 0, earned: 0 },
  raceBest: {},
  records: {}, // World Racing / race mode: courseId -> { best, medal, bestRace }
  quality: null, // graphics preset (engine/quality.js); null = detect from the GPU on first launch
  sensitivity: 1,
  tutorial: true,
  outfits: { owned: [], equipped: {} }, // outfit shop: bought item ids + what the man / the woman wears ({ [charId]: { jacket, trousers, helmet, lens } })
};

// a damaged or old save never breaks the outfit shop: keep only well-formed entries
function cleanOutfits(o) {
  const out = { owned: [], equipped: {} };
  if (!o || typeof o !== 'object') return out;
  if (Array.isArray(o.owned)) out.owned = o.owned.filter((id, i, a) => typeof id === 'string' && a.indexOf(id) === i);
  if (o.equipped && typeof o.equipped === 'object') {
    for (const [c, e] of Object.entries(o.equipped)) {
      if (!e || typeof e !== 'object') continue;
      out.equipped[c] = {};
      for (const k of ['jacket', 'trousers', 'helmet', 'lens']) out.equipped[c][k] = typeof e[k] === 'string' ? e[k] : null;
    }
  }
  return out;
}

export function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) Object.assign(save, s, { stats: { ...save.stats, ...s.stats }, records: { ...(s.records || {}) }, outfits: cleanOutfits(s.outfits) });
  } catch { /* fresh save */ }
  // the six named skiers became one man and one woman: old picks map by body, their looks move along
  migrateCharacter(save);
  // layout v2 moved five races to the gondola stops: their old best times no longer fit the courses
  if ((save.layoutVersion || 1) < 2) {
    for (const seed of [13, 21, 22, 23, 25]) delete save.raceBest?.[seed];
    save.layoutVersion = 2;
  }
  return save;
}

let resetting = false; // (a reset in progress: nothing writes the old save back, e.g. the unload handlers in main.js)
// this machine's settings, not progress: kept in the single-player save even while multiplayer has swapped `save`
// (a graphics change in multiplayer reloads the page, and was lost; net/session.js restoreSave keeps them too)
export const DEVICE_PREFS = ['quality', 'qualitySet', 'sensitivity', 'volume'];
export function writeSave() {
  if (resetting) return;
  // multiplayer: `save` holds the server profile, never written over the single-player save; the session pushes
  // the parts the player owns (net/session.js MP.onSave). Only the device settings go into the stored save
  if (MP.active) {
    MP.onSave?.();
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && DEVICE_PREFS.some((k) => save[k] !== undefined && s[k] !== save[k])) {
        for (const k of DEVICE_PREFS) if (save[k] !== undefined) s[k] = save[k];
        localStorage.setItem(KEY, JSON.stringify(s));
      }
    } catch { /* storage unavailable */ }
    return;
  }
  try { localStorage.setItem(KEY, JSON.stringify(save)); } catch { /* storage unavailable */ }
}

export function resetSave() {
  if (MP.active) return; // (the multiplayer save lives on the server)
  resetting = true;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  location.reload();
}

export function skiById(id) { return SKIS.find((s) => s.id === id); }
