// Wire routing for the structure board (board.ts), where cards can sit anywhere.
//
// Two regimes:
//  - Both cards still keep their auto-layout arrangement relative to each other (untouched, or moved
//    together, e.g. a drilled-in group): the map's own router applies unchanged (`route` in scenes.ts),
//    so the default board is wire-for-wire the structure map, and no wire runs behind a card that
//    isn't one of its ends.
//  - Otherwise, free routing between the two boxes: elbow out of the source's right side when the
//    target is clearly to the right (turning in the gap right after the source, so a fan-out still
//    shares one trunk), mirrored when it is clearly to the left, else a vertical elbow.
// Cards folded into the drill rail are joined by a bracket along the rail's outer edge.
import { Path, wire, roundCorners, pathCrossings, type P } from '../engine';
import { route, COL_GAP } from './scenes';

export interface Rect { x: number; y: number; w: number; h: number }
/** A card's slot (scenes.ts `CardSlot`): `right` is its column's right edge, where a forward wire turns. */
export interface Slot { x: number; y: number; layer: number; right?: number }

const CLEAR = 24;   // px between boxes before a wire runs sideways
const R = 10;       // corner radius

const elbowH = (pa: P, pb: P, xTurn: number) =>
  Math.abs(pb.y - pa.y) < 2 ? wire(pa, { x: pb.x, y: pa.y }, { kind: 'straight' }) : new Path(roundCorners([pa, { x: xTurn, y: pa.y }, { x: xTurn, y: pb.y }, pb], R));
const elbowV = (pa: P, pb: P, yTurn: number) =>
  Math.abs(pb.x - pa.x) < 2 ? wire(pa, { x: pa.x, y: pb.y }, { kind: 'straight' }) : new Path(roundCorners([pa, { x: pa.x, y: yTurn }, { x: pb.x, y: yTurn }, pb], R));

/** A wire from box A (caller) to box B (callee). `floor`: how low a wire may run (the top of a legend under the cards);
 *  with `grid`, `obstacles` are what a back edge kept above it runs under. Pass `grid` (both cards' auto-layout slots, shifted
 *  by their shared offset) when the two cards keep their auto arrangement: the map's router is used.
 *  Pass `obstacles` (the other cards' boxes) for free routing that keeps out from behind cards: of the
 *  candidate routes, the one running behind the fewest cards wins, then the shortest. */
export function boardRoute(A: Rect, B: Rect, grid?: { a: Slot; b: Slot }, obstacles?: Rect[], floor?: number): Path {
  if (grid) {
    const fwd = grid.b.layer > grid.a.layer;
    const pa = fwd ? { x: A.x + A.w + 3, y: A.y + A.h / 2 } : { x: A.x + A.w / 2, y: A.y + A.h + 3 };
    const pb = fwd ? { x: B.x - 3, y: B.y + B.h / 2 } : { x: B.x + B.w / 2, y: B.y + B.h + 3 };
    // a back edge loops underneath (the map's curve). Where that curve would dip below `floor` (into the legend), it
    // runs as a bracket instead: down, along under the cards between its ends (`obstacles`), and up, above the floor
    if (!fwd && floor !== undefined) {
      const d = Math.hypot(pb.x - pa.x, pb.y - pa.y), low = Math.max(pa.y, pb.y);
      // (the curve's control points sit 0.8 d below its ends, so it dips 0.75 of that below the lower one)
      if (low + 0.75 * 0.8 * d > floor) {
        const lo = Math.min(pa.x, pb.x) - R, hi = Math.max(pa.x, pb.x) + R;
        const under = (obstacles ?? []).filter((r) => r.x < hi && r.x + r.w > lo && r.y + r.h > low - 3).map((r) => r.y + r.h);
        const y = Math.min(floor, Math.max(low, ...under) + 12);
        return new Path(roundCorners([pa, { x: pa.x, y }, { x: pb.x, y }, pb], R));
      }
    }
    return route(grid.a, grid.b, pa, pb);
  }
  const cands = freeCandidates(A, B, obstacles, floor);
  if (!obstacles?.length || cands.length === 1) return cands[0]!.p;
  let best = cands[0]!.p, bestS = Infinity;
  cands.forEach(({ p, extra }, i) => {
    const s = pathCrossings(p, obstacles) * 1e5 + p.length + extra + i * 12;
    if (s < bestS) { best = p; bestS = s; }
  });
  return best;
}

/** Horizontal lanes free of obstacles between x0 and x1, cheapest first (nearest to `ys`, see `extra`). */
function lanes(obstacles: Rect[], x0: number, x1: number, ys: number[], skip: Rect[], floor = Infinity): { y: number; extra: number }[] {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  const rs = obstacles.filter((r) => !skip.includes(r) && r.x < hi && r.x + r.w > lo).map((r) => [r.y - 5, r.y + r.h + 5] as const).sort((a, b) => a[0] - b[0]);
  // a lane between rows of cards; squeezed ones (a wire there reads as touching them) and the ones outside
  // everything (they run along band labels and back edges) cost extra, so a gap between bands wins
  const out: { y: number; extra: number }[] = [];
  let top = -Infinity;
  for (const [a, b] of rs) { if (a > top && Number.isFinite(top)) out.push({ y: Math.round((top + a) / 2), extra: a - top < 20 ? 600 : 0 }); top = Math.max(top, b); }
  if (rs.length) out.push({ y: Math.round(rs[0]![0] - 8), extra: 400 }, { y: Math.round(top + 8), extra: 400 });
  const cost = (l: { y: number; extra: number }) => ys.reduce((s, v) => s + Math.abs(l.y - v), 0) + l.extra;
  return out.filter((l, i) => l.y <= floor && out.findIndex((m) => m.y === l.y) === i).sort((a, b) => cost(a) - cost(b)).slice(0, 4);
}

/** Candidate routes between two free boxes, the plain one first (the route when nothing is in the way). */
function freeCandidates(A: Rect, B: Rect, obstacles?: Rect[], floor?: number): { p: Path; extra: number }[] {
  const turn = COL_GAP / 2 - 3;
  const out: { p: Path; extra: number }[] = [];
  const push = (p: Path, extra = 0) => out.push({ p, extra });
  const skip = obstacles?.filter((r) => same(r, A) || same(r, B)) ?? [];
  const lanePaths = (pa: P, pb: P, x1: number, x2: number) => {
    if (!obstacles?.length) return;
    for (const { y, extra } of lanes(obstacles, x1, x2, [pa.y, pb.y], skip, floor)) push(new Path(roundCorners([pa, { x: x1, y: pa.y }, { x: x1, y }, { x: x2, y }, { x: x2, y: pb.y }, pb], R)), extra);
  };
  if (B.x >= A.x + A.w + CLEAR) {
    const pa = { x: A.x + A.w + 3, y: A.y + A.h / 2 }, pb = { x: B.x - 3, y: B.y + B.h / 2 };
    const d = Math.min(turn, (pb.x - pa.x) / 2);
    push(elbowH(pa, pb, pa.x + d));
    if (obstacles?.length) { push(elbowH(pa, pb, pb.x - d)); lanePaths(pa, pb, pa.x + d, pb.x - d); }
    return out;
  }
  if (B.x + B.w <= A.x - CLEAR) {
    const pa = { x: A.x - 3, y: A.y + A.h / 2 }, pb = { x: B.x + B.w + 3, y: B.y + B.h / 2 };
    const d = Math.min(turn, (pa.x - pb.x) / 2);
    push(elbowH(pa, pb, pa.x - d));
    if (obstacles?.length) { push(elbowH(pa, pb, pb.x + d)); lanePaths(pa, pb, pa.x - d, pb.x + d); }
    return out;
  }
  if (B.y >= A.y + A.h + CLEAR) {
    const pa = { x: A.x + A.w / 2, y: A.y + A.h + 3 }, pb = { x: B.x + B.w / 2, y: B.y - 3 };
    push(elbowV(pa, pb, (pa.y + pb.y) / 2));
  } else if (B.y + B.h <= A.y - CLEAR) {
    const pa = { x: A.x + A.w / 2, y: A.y - 3 }, pb = { x: B.x + B.w / 2, y: B.y + B.h + 3 };
    push(elbowV(pa, pb, (pa.y + pb.y) / 2));
  } else {
    // overlapping boxes: loop underneath, like the map's back edges
    push(wire({ x: A.x + A.w / 2, y: A.y + A.h + 3 }, { x: B.x + B.w / 2, y: B.y + B.h + 3 }, { kind: 'curve', from: 'bottom', to: 'bottom', tension: 0.8 }));
  }
  if (obstacles?.length) {
    // out of a side, along a free lane, into the other side (when the boxes are stacked)
    const right = B.x + B.w / 2 >= A.x + A.w / 2;
    const pa = right ? { x: A.x + A.w + 3, y: A.y + A.h / 2 } : { x: A.x - 3, y: A.y + A.h / 2 };
    const pb = right ? { x: B.x + B.w + 3, y: B.y + B.h / 2 } : { x: B.x - 3, y: B.y + B.h / 2 };
    const x = right ? Math.max(pa.x, pb.x) + turn : Math.min(pa.x, pb.x) - turn;
    push(new Path(roundCorners([pa, { x, y: pa.y }, { x, y: pb.y }, pb], R)));
  }
  return out;
}
const same = (r: Rect, s: Rect) => Math.abs(r.x - s.x) < 0.5 && Math.abs(r.y - s.y) < 0.5 && Math.abs(r.w - s.w) < 0.5 && Math.abs(r.h - s.h) < 0.5;

/** Between two heads stacked in the rail: a bracket along the rail's left edge (never through the
 *  heads in between). `lane` (0, 1, 2 …) staggers brackets so parallel ones stay apart. */
export function railRoute(A: Rect, B: Rect, lane: number): Path {
  const pa = { x: A.x - 3, y: A.y + A.h / 2 }, pb = { x: B.x - 3, y: B.y + B.h / 2 };
  const x = Math.min(pa.x, pb.x) - 9 - (lane % 4) * 5;
  return new Path(roundCorners([pa, { x, y: pa.y }, { x, y: pb.y }, pb], 6));
}
