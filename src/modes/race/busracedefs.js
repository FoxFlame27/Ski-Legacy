// The three FREE races the ski bus brings you to (Oct 30, the user: "it's very easy to get soft-locked by buying
// something and then not having enough money to go to a race to earn more, so add 3 races where the bus brings you
// directly to, because the bus is free"). Plain data, no imports: the game (modes/race/busraces.js builds the
// courses on the pistes), the server catalog (server/tools/gen-catalog.mjs -> server/lib/catalog.json) and the tests
// all read it.
//
// Each race runs down an existing piste from beside a ski-bus stop to the bottom near another stop: entry is ALWAYS
// free (even in debt), and every finisher is paid something, so you can always earn your way out of a hole:
//   podium (1st / 2nd / 3rd, with someone behind you)  reward x 100 % / 70 % / 50 %
//   any other finish                                    reward x 40 % under par, else 30 %
//   did not finish                                      nothing
// par: a generous time (seconds) for the course, 1.5x the race AI's ideal run on race skis (measured in Node: 59 s, 101 s and 66 s).
export const BUS_RACE_DEFS = [
  {
    id: 'bus_panorama', name: 'Panorama Sprint', piste: 'Legacy Valley Run', stop: 'Panoramastrasse', end: 'Sonnenkopf Gondola',
    from: 0, to: Infinity, reward: 1250, par: 89,
    tagline: 'A blue sprint down the Legacy Valley Run, from the Panoramastrasse bus stop to the valley floor.',
  },
  {
    id: 'bus_valley', name: 'Valley Classic Cup', piste: 'Valley Classic', stop: 'Sonnenkopf Gondola', end: 'Valley Gondola',
    from: 0, to: Infinity, reward: 1500, par: 152,
    tagline: 'The long blue Valley Classic, from the Sonnenkopf Gondola bus stop down to the Valley Gondola.',
  },
  {
    id: 'bus_hasen', name: 'Hasen Derby', piste: 'Hasenweg', stop: 'Passhöhe', end: 'Sonnenkopf Gondola',
    // (it ends above the Legacy Express's cutting, which the Hasenweg crosses at grade further down; the piste goes on
    // to the Sonnenkopf Gondola stop, BACK TO THE BUS STOP takes you up to Passhöhe again)
    from: 700, to: 2060, reward: 1000, par: 99,
    tagline: 'The easy upper Hasenweg below the Passhöhe bus stop: wide green turns down towards the Sonnenkopf valley.',
  },
];

export const BUS_PRIZE = { shares: [1, 0.7, 0.5], parShare: 0.4, rest: 0.3 };

/** Prize money for a bus race finish: place (1-based), time (s), dnf, field (racers in the race, you included). */
export function busRacePrize(def, { place, time, dnf, field = 15 }) {
  if (!def || dnf || !(time > 0)) return 0;
  const podium = place >= 1 && place <= BUS_PRIZE.shares.length && place < field; // (someone behind you)
  const share = podium ? BUS_PRIZE.shares[place - 1] : time <= def.par ? BUS_PRIZE.parShare : BUS_PRIZE.rest;
  return Math.round(def.reward * share);
}

/** The race that starts at bus stop `name` (or null). */
export const busRaceAtStop = (name) => BUS_RACE_DEFS.find((d) => d.stop === name) || null;
