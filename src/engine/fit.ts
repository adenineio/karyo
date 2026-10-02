// Fitting a plate to the space it has (docs/ENGINE.md "Theater: fitting the window"). The theater, `fill` and Jarvis
// draw the whole plate, scaled to fit both dimensions of the space; a plate whose content can be laid out more than one
// way (`Scene.fit`) offers its candidates and keeps the one drawn largest, which is the one leaving the least of the
// window empty.

export interface Space { w: number; h: number }

/** CSS px per stage px when a w×h plate is scaled to fit the space whole. */
export function fitScaleOf(space: Space, size: Space): number {
  return Math.min(space.w / Math.max(1, size.w), space.h / Math.max(1, size.h));
}
/** The share of the space a w×h plate leaves empty when fitted whole (0: it fills the space; the gutters beside or
 *  above it otherwise). */
export function fitWaste(space: Space, size: Space): number {
  const s = fitScaleOf(space, size);
  return Math.max(0, 1 - (size.w * s * size.h * s) / Math.max(1, space.w * space.h));
}
/** Of a plate's candidate layouts (each with the size it needs), the one drawn largest in the space. An earlier
 *  candidate wins unless a later one is drawn more than `slack` larger (default 3%), so the plate's own first choice
 *  (its default) holds when the shape of the space doesn't call for another. */
export function pickFit<T extends Space>(space: Space, candidates: readonly T[], o: { slack?: number } = {}): T {
  const slack = 1 + (o.slack ?? 0.03);
  let best = candidates[0]!, bs = fitScaleOf(space, best);
  for (const c of candidates.slice(1)) { const s = fitScaleOf(space, c); if (s > bs * slack) { best = c; bs = s; } }
  return best;
}
/** Room for the chrome floor's boost, settled (docs/ENGINE.md "Theater", room for the chrome). The Stage asks a plate to
 *  leave room for chrome drawn `k` times larger, `k` taken at the scale of its layout with no room; the layout with that
 *  room is drawn smaller, so the floor then boosts the chrome a little more than the room left for it. This lays the
 *  plate out again (`make(k)`) at the boost its last layout gets (`boost(scale)`: the Stage's `chrome.boostAt`) until
 *  the two agree, so chrome covers no content at fit. Rounds up; a few steps at most. */
export function settleChrome<T extends Space>(space: Space, k: number, make: (k: number) => T, boost: (scale: number) => number, steps = 6): T {
  let r = make(k);
  for (let i = 0; i < steps; i++) {
    const want = boost(fitScaleOf(space, r));
    if (!(want > k * 1.005)) break;
    k = Math.ceil(want * 100) / 100;
    r = make(k);
  }
  return r;
}
