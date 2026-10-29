// The secrets of the resort (ids + names only: the menu's STATS screen counts them without loading the meshes).
// secrets.js defines the places themselves; keep both in step. `off: true` switches one off everywhere (its
// terrain shaping, meshes, discovery and the counts) without deleting it.
const ALL = [
  { id: 'knappenstollen', name: 'Knappenstollen' },
  { id: 'schattenkar', name: 'Schattenkar' },
  { id: 'teufelsrinne', name: 'Teufelsrinne' },
  { id: 'eisfall', name: 'Eisfall-Grotte', off: true }, // (new: not yet checked in the game)
  { id: 'silbergrotte', name: 'Silbergrotte' },
  { id: 'adlertor', name: 'Adlertor' },
  { id: 'foersterweg', name: 'Försterweg' },
  // (Oct 29: five more)
  { id: 'kristallgrotte', name: 'Kristallgrotte' },
  { id: 'schmugglerstollen', name: 'Schmugglerstollen' },
  { id: 'pulverkessel', name: 'Pulverkessel' },
  { id: 'schmugglerhuette', name: 'Schmugglerhütte' },
  { id: 'wolkenkanzel', name: 'Wolkenkanzel' },
];
export const SECRET_LIST = ALL.filter((s) => !s.off);
export const secretEnabled = (id) => SECRET_LIST.some((s) => s.id === id);
