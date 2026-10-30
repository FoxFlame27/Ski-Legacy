// Work that can wait for the menu (Oct 30 2026, the user: "why does loading actually take so long"): things nobody sees
// at once (the cars' far LODs: until one is ready the car simply shows its full model) run after the boot, one job per
// idle moment, instead of holding up the loading bar. main.js calls bootDone() when the menu is ready; without it (a
// page that never boots the game) the jobs start after 30 s anyway.
let open = false, chain = null;
const waiting = [];
export function bootDone() {
  if (open) return;
  open = true;
  for (const r of waiting.splice(0)) r();
}
const gate = () => (open ? Promise.resolve() : new Promise((r) => { waiting.push(r); setTimeout(bootDone, 30000); }));
const idle = () => new Promise((r) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r(), { timeout: 1000 }) : setTimeout(r, 30)));
/** Resolves after the boot, in an idle moment of its own: await it, then do the job (one job per call). */
export function afterBoot() {
  const p = (chain || gate()).then(idle);
  chain = p;
  return p;
}
