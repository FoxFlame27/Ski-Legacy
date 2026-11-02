// STEAM: achievements and rich presence (Nov 2 2026). Works only in the desktop app when it was started with a
// Steam App ID (electron/steam.cjs + electron/preload.cjs give the page `window.steam`); everywhere else (the browser,
// the GitHub builds, Steam not running) every call here is a silent no-op, so the game never depends on it.
//
// The ids below are the achievements' API names: enter exactly these in Steamworks (steam/achievements.md has the
// table with names and descriptions, steam/README.md how to publish them). An unlock that went through is not sent
// again this session (Steam itself keeps them per account; counters and finished courses are kept in this profile).
//
// Hooks: main.js calls steamTick(...) about once a second (state checks: money, cars, chalet, speed, places) and the
// event functions below where things happen (race results, taxi fares, police chases, jail).

export const ACHIEVEMENTS = [
  { id: 'FIRST_RUN', name: 'First Tracks', desc: 'Finish your first race.' },
  { id: 'FIRST_WIN', name: 'Top of the Podium', desc: 'Win a race.' },
  { id: 'WINS_10', name: 'Serial Winner', desc: 'Win 10 races.' },
  { id: 'ALL_COURSES', name: 'Course Collector', desc: 'Finish every World Racing course on the mountains.' },
  { id: 'SPEED_100', name: 'Ton Up', desc: 'Reach 100 km/h on skis.' },
  { id: 'SPEED_130', name: 'Downhill Demon', desc: 'Reach 130 km/h on skis.' },
  { id: 'DISTANCE_100K', name: 'Marathon Skier', desc: 'Ski a total of 100 km.' },
  { id: 'SKIS_LEGEND', name: 'Gold Edition', desc: 'Own the Legacy Gold Edition skis.' },
  { id: 'FIRST_CAR', name: 'Wheels', desc: 'Buy your first car at the Autohaus.' },
  { id: 'CARS_5', name: 'Car Collector', desc: 'Own 5 cars at once.' },
  { id: 'FIRST_CHALET', name: 'Home in the Alps', desc: 'Buy a chalet.' },
  { id: 'FURNISHED', name: 'Interior Designer', desc: 'Place 15 pieces of furniture in your chalet.' },
  { id: 'TAXI_FIRST', name: 'Meter Running', desc: 'Complete your first taxi fare.' },
  { id: 'TAXI_25', name: 'Legacy Cabbie', desc: 'Complete 25 taxi fares.' },
  { id: 'POLICE_ESCAPE', name: 'Gone in the Snow', desc: 'Escape a police chase.' },
  { id: 'ARRESTED', name: 'Behind Bars', desc: 'Get arrested and spend time in jail.' },
  { id: 'EXPRESS_RIDE', name: 'All Aboard', desc: 'Ride the Legacy Express.' },
  { id: 'LEGACY_PEAK', name: 'Roof of the Resort', desc: 'Stand on the summit of Legacy Peak (4,000 m).' },
  { id: 'HELI_PILOT', name: 'Pilot', desc: 'Fly a helicopter.' },
  { id: 'RESCUED', name: 'Air Rescue', desc: 'Get rescued after a bad crash.' },
  { id: 'SECRET_FIRST', name: 'Explorer', desc: 'Find a secret.' },
  { id: 'MONEY_100K', name: 'Six Figures', desc: 'Have $100,000.' },
  { id: 'MONEY_1M', name: 'Ski Tycoon', desc: 'Have $1,000,000.' },
];

const IDS = new Set(ACHIEVEMENTS.map((a) => a.id));
const KEY = 'ski-legacy-steam-v1';

function bridge() { try { return globalThis.window?.steam?.available ? window.steam : null; } catch { return null; } }
export function steamAvailable() { return !!bridge(); }
export function steamPlayerName() { return bridge()?.playerName || ''; }
export function steamOnDeck() { return !!bridge()?.onDeck; }

// local progress: counters, the courses finished (achievements sent: this session only)
const sent = new Set();
let store = null;
function data() {
  if (store) return store;
  try { store = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { store = null; }
  if (!store || typeof store !== 'object') store = {};
  if (!Array.isArray(store.courses)) store.courses = [];
  store.n = store.n && typeof store.n === 'object' ? store.n : {};
  return store;
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(data())); } catch { /* storage unavailable */ } }
function count(name, by = 1) { const d = data(); d.n[name] = (d.n[name] | 0) + by; persist(); return d.n[name]; }

/** Unlock one achievement (a no-op without Steam, or when it was already sent from this profile). */
export function unlock(id) {
  if (!IDS.has(id)) return;
  const s = bridge();
  if (!s) return;
  if (sent.has(id)) return;
  sent.add(id);
  Promise.resolve(s.unlock(id)).then((ok) => { if (!ok) setTimeout(() => sent.delete(id), 30000); }).catch(() => sent.delete(id)); // (failed: try again later)
}

/** An integer stat (define it in Steamworks first). */
export function setStat(name, value) { try { bridge()?.setStat(name, Math.round(value)); } catch { /* no Steam */ } }

// rich presence: the friends list shows "Ski Legacy - <where you are>" (steam/rich_presence_english.vdf has the token)
let rpLoc = null;
export function richLocation(loc) {
  const s = bridge();
  if (!s || !loc || loc === rpLoc) return;
  rpLoc = loc;
  try { s.richPresence('loc', String(loc).slice(0, 60)); s.richPresence('steam_display', '#Status_Location'); } catch { /* no Steam */ }
}

// ------------------------------------------------------------------ events (called where they happen)

/** A race finished (World Racing course on the mountain, or a bus race). courseId / allIds: the World Racing course
 *  and the ids of every course, for ALL_COURSES; wins: save.stats.wins after this result. */
export function steamRaceResult({ place, dnf, wins = 0, courseId = null, allIds = null }) {
  if (!bridge() || dnf) return;
  unlock('FIRST_RUN');
  if (place === 1) unlock('FIRST_WIN');
  if (wins >= 10) unlock('WINS_10');
  if (courseId != null && Array.isArray(allIds) && allIds.length) {
    const d = data();
    if (!d.courses.includes(courseId)) { d.courses.push(courseId); persist(); }
    if (allIds.every((id) => d.courses.includes(id))) unlock('ALL_COURSES');
  }
}
export function steamTaxiFare() {
  if (!bridge()) return;
  unlock('TAXI_FIRST');
  if (count('taxiFares') >= 25) unlock('TAXI_25');
}
export function steamPoliceEscaped() { unlock('POLICE_ESCAPE'); }
export function steamArrested() { unlock('ARRESTED'); }

// ------------------------------------------------------------------ state checks (about once a second)

const LEGACY_PEAK_TOP = 2755 - 45; // world units (m above the village): within ~45 m of the 4,000 m summit

/** g: { save, player, express, heli, loc } (any may be missing) */
export function steamTick(g) {
  if (!bridge() || !g) return;
  const { save, player, express, heli } = g;
  if (save) {
    const st = save.stats || {};
    const kmh = (st.topSpeed || 0) * 3.6;
    if (kmh >= 100) unlock('SPEED_100');
    if (kmh >= 130) unlock('SPEED_130');
    if ((st.distance || 0) >= 100000) unlock('DISTANCE_100K');
    if ((st.wins || 0) >= 1) unlock('FIRST_WIN');
    if ((st.wins || 0) >= 10) unlock('WINS_10');
    if ((save.money || 0) >= 100000) unlock('MONEY_100K');
    if ((save.money || 0) >= 1000000) unlock('MONEY_1M');
    if (Array.isArray(save.owned) && save.owned.includes('legend')) unlock('SKIS_LEGEND');
    const cars = Array.isArray(save.garage) ? save.garage.length : 0;
    if (cars >= 1) unlock('FIRST_CAR');
    if (cars >= 5) unlock('CARS_5');
    if (save.chalet?.owned) unlock('FIRST_CHALET');
    if (save.chalet?.owned && (save.chalet.furniture?.length || 0) >= 15) unlock('FURNISHED');
    if ((save.rescues | 0) >= 1) unlock('RESCUED');
    if ((save.jailVisits | 0) >= 1) unlock('ARRESTED');
    if (Array.isArray(save.secrets) && save.secrets.length >= 1) unlock('SECRET_FIRST');
  }
  if (express?.riding) unlock('EXPRESS_RIDE');
  if (heli?.active) unlock('HELI_PILOT');
  else if (player?.pos && player.pos.y >= LEGACY_PEAK_TOP) unlock('LEGACY_PEAK');
  richLocation(g.loc);
}
