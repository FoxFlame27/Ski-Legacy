// The guided start: 1) Rent a chalet -> 2) Furnish your chalet (optional) -> 3) Rent skis at the ski shop ->
// then main.js's existing objectives (the gondola, a race...). Returns the HUD objective line, or null to
// fall through to main.js's own chain.
import { chaletRented } from './chaletadapter.js';

export function startObjective(save, player, buildMode) {
  const inside = buildMode?.hudLine(); // inside your chalet: the build-mode hint / state
  if (inside) return inside;
  const fresh = !player.hasSkis && (save.stats?.races || 0) === 0;
  if (!fresh) return null;
  // (Oct 28, the user: chalets are bought for $50,000 now, earned with races and jobs: no chalet step at the start)
  // (Oct 28, the user: the furnishing hint "stays forever; it should only show when you're in the chalet": outside
  // it, the next step is the skis)
  return null; // -> 'Rent skis at the ski shop'
}
