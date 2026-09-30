// Aspect-aware arrangement of a laid-out model (scenes.ts `layout`) for the space a plate gets (the
// theater: docs/ENGINE.md "Theater"). The layout's group bands keep their inside (cards full size, in
// their columns and rows); what changes is where each band sits. The default stacks bands whose columns
// overlap, which makes a wide graph tall; for a wide window some bands move into shelves side by side.
//
// Pure: the arrangement is a function of (layout, wires, target space) only. Candidates are the band →
// shelf assignments; each is scored by how large it can be drawn in the space, then by how many wires
// would run behind a card (routed exactly as the board draws them, board-route.ts), and the default
// wins ties so a window shaped like the page keeps the page's picture.
import { pathCrossings, type Path } from '../engine';
import { boardRoute, type Rect, type Slot } from './board-route';
import { COL_GAP, BAND_GAP, TOP, SIDE, boxOf, type Layout } from './scenes';

export interface Arrangement {
  /** A stable name: `default`, or the shelves as band indices (`0,1,2|3`). */
  key: string;
  /** Where every card rests (x, y) and its layer (column in the layout: the map router's slot). */
  pos: Map<string, Slot>;
  /** Right and bottom edges of the content (band frames included). */
  right: number;
  bottom: number;
  /** Bands moved out of their default place. */
  moved: string[];
}

const FRAME = 14;              // a band frame reaches this far past its cards (22 above: its label)
const SHELF_GAP = COL_GAP + 2 * FRAME;

interface Band { id: string; lo: number; hi: number; h: number; cards: { id: string; layer: number; dy: number }[] }

function bandsOf(L: Layout): Band[] {
  const gOf = (id: string) => { const n = L.nodes.find((x) => x.id === id)!; return n.kind === 'actor' ? '·outside' : n.group ?? 'other'; };
  return L.groups.map((g) => {
    const cards = L.nodes.filter((n) => gOf(n.id) === g.id).map((n) => { const p = L.pos.get(n.id)!; return { id: n.id, layer: p.layer, dy: p.y - g.y }; });
    const ls = cards.map((c) => c.layer);
    return { id: g.id, lo: Math.min(...ls), hi: Math.max(...ls), h: g.h, cards };
  });
}

/** The default arrangement: the layout itself. */
export function defaultArrangement(L: Layout): Arrangement {
  const right = Math.max(0, ...L.groups.map((g) => g.x + g.w));
  const bottom = Math.max(TOP, ...L.groups.map((g) => g.y + g.h));
  return { key: 'default', pos: new Map(L.pos), right, bottom, moved: [] };
}

/** Place bands into shelves (left to right); inside a shelf, bands keep their columns and stack like the default. */
function place(L: Layout, bands: Band[], shelfOf: number[]): Arrangement {
  const pos = new Map<string, Slot>();
  const shelves = Math.max(...shelfOf) + 1;
  let shelfX = SIDE, right = 0, bottom = TOP;
  const moved: string[] = [];
  for (let s = 0; s < shelves; s++) {
    const members = bands.map((b, i) => [b, i] as const).filter(([, i]) => shelfOf[i] === s);
    if (!members.length) continue;
    const minLo = Math.min(...members.map(([b]) => b.lo));
    // the first shelf keeps the layout's own columns; later ones start right of what came before. Columns keep
    // their widths (a column is as wide as its widest card, scenes.ts), so a card's x is its column's offset.
    const x0 = s === 0 ? L.colX[minLo]! : shelfX;
    const colAt = (l: number) => x0 + L.colX[l]! - L.colX[minLo]!;
    const placed: { lo: number; hi: number; bottom: number }[] = [];
    let shelfRight = 0;
    for (const [b] of members) {
      const y = Math.max(TOP, ...placed.filter((p) => p.lo <= b.hi && b.lo <= p.hi).map((p) => p.bottom + BAND_GAP));
      for (const c of b.cards) pos.set(c.id, { x: colAt(c.layer), y: y + c.dy, layer: c.layer, right: colAt(c.layer) + L.colW[c.layer]! });
      placed.push({ lo: b.lo, hi: b.hi, bottom: y + b.h });
      shelfRight = Math.max(shelfRight, colAt(b.hi) + L.colW[b.hi]! + FRAME);
      bottom = Math.max(bottom, y + b.h);
      const g = L.groups.find((x) => x.id === b.id)!;
      if (Math.abs(colAt(b.lo) - FRAME - g.x) > 0.5 || Math.abs(y - g.y) > 0.5) moved.push(b.id);
    }
    right = Math.max(right, shelfRight);
    shelfX = shelfRight + SHELF_GAP - FRAME;
  }
  const key = Array.from({ length: shelves }, (_, s) => bands.map((_, i) => i).filter((i) => shelfOf[i] === s).join(',')).join('|');
  return { key, pos, right, bottom, moved };
}

/** Every band → shelf assignment worth trying: all of them for a handful of bands (shelves in first-use order),
 *  else the contiguous splits of the band order. At most three shelves. */
function assignments(n: number): number[][] {
  const out: number[][] = [];
  if (n <= 7) {
    const rec = (i: number, cur: number[], used: number) => {
      if (i === n) { out.push([...cur]); return; }
      for (let s = 0; s <= Math.min(used, 2); s++) { cur.push(s); rec(i + 1, cur, Math.max(used, s + 1)); cur.pop(); }
    };
    rec(0, [], 0);
  } else {
    for (let a = 1; a <= n; a++) for (let b = a; b <= n; b++) out.push(Array.from({ length: n }, (_, i) => (i < a ? 0 : i < b ? 1 : 2)));
  }
  return out;
}

export interface ArrangeOpts {
  /** The wires to route when scoring (one per pair, from → to). */
  wires: { from: string; to: string }[];
  /** The plate around the content: its size is (right + padRight) × (bottom + padBottom), at least min. */
  padRight: number;
  padBottom: number;
  minW: number;
  minH: number;
}

/** Wires that would run behind a card that isn't one of their ends, routed as the board draws them. */
export function crossings(L: Layout, a: Arrangement, wires: { from: string; to: string }[]): number {
  const rect = (id: string): Rect => { const p = a.pos.get(id)!, b = boxOf(L, id); return { x: p.x, y: p.y, w: b.w, h: b.h }; };
  const ids = [...a.pos.keys()];
  let n = 0;
  for (const w of wires) {
    const pa = a.pos.get(w.from), pb = a.pos.get(w.to);
    if (!pa || !pb) continue;
    const oa = L.pos.get(w.from)!, ob = L.pos.get(w.to)!;
    const together = Math.abs(pa.x - oa.x - (pb.x - ob.x)) < 0.5 && Math.abs(pa.y - oa.y - (pb.y - ob.y)) < 0.5;
    const others = ids.filter((id) => id !== w.from && id !== w.to).map(rect);
    const p: Path = together ? boardRoute(rect(w.from), rect(w.to), { a: pa, b: pb }) : boardRoute(rect(w.from), rect(w.to), undefined, others);
    n += pathCrossings(p, others.map((r) => ({ x: r.x + 2, y: r.y + 2, w: r.w - 4, h: r.h - 4 })));
  }
  return n;
}

/** The arrangement for a space (CSS px; null = the default, e.g. the page). Returns it with the plate size it needs. */
export function arrange(L: Layout, space: { w: number; h: number } | null, o: ArrangeOpts): { a: Arrangement; W: number; H: number } {
  const size = (a: Arrangement) => ({ W: Math.max(o.minW, Math.ceil(a.right + o.padRight)), H: Math.max(o.minH, Math.ceil(a.bottom + o.padBottom)) });
  const def = defaultArrangement(L);
  if (!space || L.groups.length < 2) return { a: def, ...size(def) };
  const bands = bandsOf(L);
  const scale = (a: Arrangement) => { const s = size(a); return Math.min(space.w / s.W, space.h / s.H); };
  // cheap pass: how large each arrangement can be drawn; then route the best few
  const all = assignments(bands.length).map((sh) => place(L, bands, sh)).filter((a) => a.key !== bands.map((_, i) => i).join(','));
  const top = all.map((a) => ({ a, s: scale(a) })).sort((x, y) => y.s - x.s || x.a.key.localeCompare(y.a.key)).slice(0, 10);
  // a larger picture is better, up to generous text; each wire behind a card costs 15%; the default wins a near tie
  const CAP = 1.6;
  const score = (a: Arrangement, s: number) => Math.min(s, CAP) * Math.pow(0.85, crossings(L, a, o.wires));
  let best = def, bestS = score(def, scale(def)) * 1.04;
  for (const { a, s } of top) {
    if (Math.min(s, CAP) <= bestS) continue;   // can't beat the best even with no crossings
    const v = score(a, s);
    if (v > bestS) { best = a; bestS = v; }
  }
  return { a: best, ...size(best) };
}
