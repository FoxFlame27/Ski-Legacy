// Time slicing and shared materials for the secrets' builders.
//  - the builders are generators; the runtime opens a slice before stepping one (slice.until = now + budget) and
//    a builder's loops check late() every few items and yield once the frame's budget is spent, so no step runs
//    long however heavy its items are (the runtime and the tools step them; outside a slice nothing is late)
//  - every material the builds use is shared (one per variant, made once): warmMaterials() hands them all to the
//    boot's shader compile, so building a secret later never stalls a frame compiling a program
export const slice = { until: Infinity };
export const late = () => performance.now() > slice.until;

const REG = new Map();
export function sharedMaterial(key, make) {
  let m = REG.get(key);
  if (!m) {
    m = make();
    m.userData.shared = true;
    REG.set(key, m);
  }
  return m;
}
export const sharedMaterials = () => [...REG.values()];
