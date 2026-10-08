// Tweens between chart frames: every number interpolates (values, domains, presence, highlight weights), so
// bars grow, lines morph point by point, arcs sweep and axes rescale as one motion. Keys on one side only are
// born or die: presence and weights from / to 0, bar and slice values from / to 0, line values hold still
// while their series reveals or fades. Structure (series, x keys, annotations, ticks) is the union, in the
// target's order, with leaving items kept beside their old neighbours until they are gone. Pure: the frame
// at k depends only on (from, to, k), and k = 1 is exactly the target.
import type { Annot, Frame, Item, XItem } from './data';

/** Merge two keyed lists: the target's order, with items only in `from` placed after their old predecessor. */
export function mergeKeyed<T extends { k: string }>(from: T[], to: T[]): T[] {
  const out = [...to], have = new Set(to.map((i) => i.k));
  from.forEach((it, i) => {
    if (have.has(it.k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const p = out.findIndex((o) => o.k === from[j]!.k); if (p >= 0) { at = p + 1; break; } }
    out.splice(at, 0, it); have.add(it.k);
  });
  return out;
}
const mergeNums = (a: number[], b: number[]) => [...new Set([...a, ...b])].sort((x, y) => x - y);

/** Where a key with no value on one side starts or ends. */
function edge(key: string, other: number, kind: Frame['o']['kind']): number {
  if (key.startsWith('v:')) return kind === 'bars' || kind === 'donut' ? 0 : other;
  if (key === 'y0' || key === 'y1' || key === 'x0' || key === 'x1' || key.startsWith('a0:') || key.startsWith('a1:') || key === 'stk' || key === 'ar') return other;
  return 0;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** The frame a fraction k (0..1) of the way from `a` to `b`. */
export function lerpFrame(a: Frame, b: Frame, k: number): Frame {
  if (k >= 1) return b;
  if (k <= 0) return a;
  const n: Record<string, number> = {};
  for (const key of new Set([...Object.keys(a.n), ...Object.keys(b.n)])) {
    const va = a.n[key], vb = b.n[key];
    const x = va === undefined ? edge(key, vb!, b.o.kind) : va, y = vb === undefined ? edge(key, va!, b.o.kind) : vb;
    n[key] = Number.isNaN(x) ? y : Number.isNaN(y) ? (k < 1 ? x : y) : lerp(x, y, k);
  }
  return {
    o: b.o,
    s: mergeKeyed<Item>(a.s, b.s), x: mergeKeyed<XItem>(a.x, b.x), a: mergeKeyed<Annot>(a.a, b.a),
    ty: mergeNums(a.ty, b.ty), tx: mergeNums(a.tx, b.tx), n,
  };
}

/** Where an arriving chart starts: nothing drawn yet. Bars and slices at 0, lines unrevealed, the donut's sweep
 *  at 0, annotations, ticks and highlights off; the axes' domains already in place. */
export function birthFrame(b: Frame): Frame {
  const n: Record<string, number> = {};
  const grow = b.o.kind === 'bars' || b.o.kind === 'donut';
  for (const [key, v] of Object.entries(b.n)) n[key] = grow && (key.startsWith('p:') || key.startsWith('q:')) ? v : edge(key, v, b.o.kind);
  return { ...b, n };
}
