// The secrets of the resort (ids + names only: the menu's STATS screen counts them without loading the meshes).
// secrets.js defines the places themselves; keep both in step. `off: true` switches one off everywhere (its
// terrain shaping, meshes, discovery and the counts) without deleting it.
const ALL = [
  { id: 'knappenstollen', name: 'Knappenstollen', off: true },
  { id: 'schattenkar', name: 'Schattenkar', off: true },
  { id: 'teufelsrinne', name: 'Teufelsrinne', off: true },
  { id: 'eisfall', name: 'Eisfall-Grotte', off: true }, // (new: not yet checked in the game)
  { id: 'silbergrotte', name: 'Silbergrotte', off: true },
  // (Oct 30, the user: "delete all secrets except for Adlerhorn Försterweg": only the Adlertor arch on the Adlerhorn
  // and the Försterweg are left; the rest are off everywhere, their terrain shaping, meshes, finds and counts)
  { id: 'adlertor', name: 'Adlertor' },
  { id: 'foersterweg', name: 'Försterweg' },
  // (Oct 29: five more)
  { id: 'kristallgrotte', name: 'Kristallgrotte', off: true },
  { id: 'schmugglerstollen', name: 'Schmugglerstollen', off: true },
  { id: 'pulverkessel', name: 'Pulverkessel', off: true },
  { id: 'schmugglerhuette', name: 'Schmugglerhütte', off: true },
  { id: 'wolkenkanzel', name: 'Wolkenkanzel', off: true },
];
export const SECRET_LIST = ALL.filter((s) => !s.off);
export const secretEnabled = (id) => SECRET_LIST.some((s) => s.id === id);
