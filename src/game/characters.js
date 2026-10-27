// Who you play: a MAN or a WOMAN, one body each. Every look after that is bought and worn in the ski
// shop (OUTFITS corner, ui/outfitshop.js). Characters carry no stats at all: everyone skis exactly the
// same, only the skis (equipment, economy.js SKIS) differ.
// All six Meshy skiers stay in the game for the race field, the skiers on the pistes and the villagers,
// so other people still look different from you and from each other.

/** The six Meshy skier models (main.js loads them all) and the body each one has (this order picks the NPCs' looks). */
export const SKIER_MODELS = [
  { id: 'skier_blue', body: 'woman' },
  { id: 'skier_red', body: 'man' },
  { id: 'skier_green', body: 'man' },
  { id: 'skier_orange', body: 'man' },
  { id: 'skier_black', body: 'woman' },
  { id: 'skier_purple', body: 'man' },
];

/**
 * The two player characters. Picked from the six up close: both wear a classic jacket, trousers, helmet
 * and goggles, so every outfit slot (two-tone jacket, trousers, helmet, lens) works on both. The other
 * four have a tactical vest + backpack, a masked face, a one-piece race suit or no goggles.
 */
export const PLAYER_CHARACTERS = [
  { id: 'skier_red', body: 'man', label: 'MAN' },
  { id: 'skier_blue', body: 'woman', label: 'WOMAN' },
];

const BODY_OF = Object.fromEntries(SKIER_MODELS.map((m) => [m.id, m.body]));
const SLOTS = ['jacket', 'trousers', 'helmet', 'lens'];
const wears = (e) => !!e && typeof e === 'object' && SLOTS.some((s) => typeof e[s] === 'string');

/** 'man' | 'woman' for a model id (or a body name), null when unknown. */
export function bodyOf(id) {
  return BODY_OF[id] || (id === 'man' || id === 'woman' ? id : null);
}

/** The player character id ('skier_red' / 'skier_blue') for a model id or a body name. */
export function playerCharacter(idOrBody) {
  const body = bodyOf(idOrBody) || 'woman';
  return PLAYER_CHARACTERS.find((c) => c.body === body).id;
}

/**
 * Saves from before the man / woman choice picked one of six named skiers: map it to the player
 * character with the same body. The look that skier wore moves along to the new body (owned outfits
 * stay owned), and a body with no look of its own takes the one a same-body skier wore. The old
 * per-skier looks are dropped once moved. Safe to run on every load (a no-op once migrated).
 */
export function migrateCharacter(save) {
  const old = save.character;
  const id = playerCharacter(old);
  const eq = save.outfits?.equipped;
  if (eq && typeof eq === 'object') {
    if (old !== id && wears(eq[old])) eq[id] = { ...eq[old] };
    for (const pc of PLAYER_CHARACTERS) {
      if (wears(eq[pc.id])) continue;
      const src = SKIER_MODELS.find((m) => m.body === pc.body && wears(eq[m.id]));
      if (src) eq[pc.id] = { ...eq[src.id] };
    }
    for (const k of Object.keys(eq)) if (!PLAYER_CHARACTERS.some((pc) => pc.id === k)) delete eq[k];
  }
  save.character = id;
  return save;
}
