// Separate lanes (docs/ENGINE.md "Group navigation", Lanes): every wire on its own track. The board's default routing
// lets wires share runs (a fan-out leaves its card on one trunk, wires skipping columns share the lane above a row),
// which keeps a picture quiet but makes one wire hard to follow by eye. Here no two wires share a run: each leaves and
// enters its cards at a port of its own, runs up or down a gutter between columns on a track of its own and across
// the columns on a track of its own, with parallel tracks spaced evenly and ordered to cross as little as they can.
//
// Pure and deterministic: the routes are a function of the boxes, the wires (taken in key order, whatever order they
// come in) and the bounds. Shape-neutral: boxes and wires are ids and rectangles, nothing more.
//
// How: the boxes fall into column blocks (boxes whose x ranges overlap or nearly do), with a gutter between two blocks
// and a margin gutter at each side; inside a block a wire runs only through its free horizontal gaps (between boxes,
// above them, below them down to the floor). A wire to a block on the right leaves its card's right side, turns in the
// gutter after it and, skipping blocks, crosses them along a gap and turns down or up in the gutter before its callee.
// A wire back to a block on the left (against the flow) loops under or over its cards, or round their sides when that
// is crowded, so it reads as a call back. A wire to a box in its own block crosses the gap between them, or goes round
// their right sides. Then the tracks: each gutter's runs, each set of horizontal runs that could meet, and each card
// side's ports get their own coordinates, evenly spaced, in the order that crosses least (a few rounds, as each
// depends on the others). Ports sit on a 4 px grid, right and bottom sides on even lines, left and top sides on odd
// ones, so the stubs of two cards facing each other across a gutter or a gap never lie on one line.
import { Path, roundCorners, type P } from '../engine';

export interface Rect { x: number; y: number; w: number; h: number }
export interface LaneWire { key: string; from: string; to: string }
export interface LaneOpts {
  /** Where wires may run: the stage less its edges, under the header (y0) and above the legend (y1, the floor). */
  bounds: { x0: number; x1: number; y0: number; y1: number };
  /** More boxes to keep clear of that no wire ends at (other cards, group labels). */
  obstacles?: Rect[];
  /** The widest gap between parallel tracks (px; default 14). Narrow gutters and gaps space them closer. */
  spacing?: number;
}
export interface LaneRoute {
  path: Path;
  /** The route's corners before rounding (axis-aligned runs): what tests check for shared runs. */
  corners: P[];
  /** How it goes back to a block on the left (a call against the flow): leaving its card's bottom (`under`), its top
   *  (`over`) or its left side (`side`); null for a wire that doesn't go back. */
  back: 'under' | 'over' | 'side' | null;
}

const MIN_GUTTER = 24;   // boxes closer than this sideways are one block (no room for a track between them)
const PAD = 10;          // a gutter track keeps this far from the gutter's edges (room for an arrowhead)
const GAP_PAD = 6;       // a gap track keeps this far from the cards above and below it
const MIN_TRACK = 6;     // tracks closer than this are crowded (a gap's capacity)
const PORT_MAX = 16;     // the widest gap between ports on one side of a card
const GRID = 4;          // ports sit on this grid: right and bottom sides on even lines, left and top on odd
const END = 3;           // a wire starts and ends this far off its card

type Side = 'left' | 'right' | 'top' | 'bottom';
type Iv = [number, number];
interface Block { i: number; x0: number; x1: number; gaps: Iv[] }
interface Gutter { x0: number; x1: number }
/** One run whose coordinate the tracks decide: vertical in a gutter (its x), or horizontal within `iv` (its y). */
type Leg = { dir: 'v'; gutter: number } | { dir: 'h'; iv: Iv };
interface Plan { w: LaneWire; back: LaneRoute['back']; out: Side; in: Side; legs: Leg[] }
type Run = { lo: number; hi: number; ends: { at: number; dir: -1 | 1 }[] };
type Ref = { plan: number; leg: number };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function separateLanes(boxes: Map<string, Rect>, wires: LaneWire[], o: LaneOpts): Map<string, LaneRoute> {
  const S = o.spacing ?? 14;
  const B = o.bounds;
  const ws = [...wires].filter((w) => boxes.has(w.from) && boxes.has(w.to) && w.from !== w.to).sort((a, b) => byKey(a.key, b.key));
  const out = new Map<string, LaneRoute>();
  if (!ws.length) return out;

  // ---- blocks, their gaps, and the gutters between them
  const all: Rect[] = [...[...boxes.entries()].sort((a, b) => byKey(a[0], b[0])).map(([, r]) => r), ...(o.obstacles ?? [])].filter((r) => r.w > 0 && r.h > 0);
  const xs = all.map((r) => [r.x, r.x + r.w] as Iv).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const blocks: Block[] = [];
  for (const [a, b] of xs) {
    const last = blocks[blocks.length - 1];
    if (last && a < last.x1 + MIN_GUTTER) last.x1 = Math.max(last.x1, b);
    else blocks.push({ i: blocks.length, x0: a, x1: b, gaps: [] });
  }
  const blockAt = (x: number) => { let k = 0; for (const b of blocks) if (x >= b.x0 - 0.5) k = b.i; return k; };
  const spans = blocks.map(() => [] as Iv[]);
  for (const r of all) spans[blockAt(r.x + r.w / 2)]!.push([r.y, r.y + r.h]);
  blocks.forEach((b, i) => {
    const sp = spans[i]!.sort((p, q) => p[0] - q[0]);
    let top = B.y0;
    for (const [s0, s1] of sp) { if (s0 > top) b.gaps.push([top, s0]); top = Math.max(top, s1); }
    if (B.y1 > top) b.gaps.push([top, B.y1]);
  });
  // gutter i is left of block i; gutter n (n = blocks) is right of the last
  const gutters: Gutter[] = [];
  for (let i = 0; i <= blocks.length; i++) {
    const x0 = i === 0 ? Math.max(B.x0, blocks[0]!.x0 - 48) : blocks[i - 1]!.x1;
    const x1 = i === blocks.length ? Math.min(B.x1, blocks[i - 1]!.x1 + 48) : blocks[i]!.x0;
    gutters.push({ x0, x1: Math.max(x1, x0) });
  }
  const blockOf = (id: string) => { const r = boxes.get(id)!; return blockAt(r.x + r.w / 2); };
  const gapBelow = (bi: number, r: Rect): Iv | null => blocks[bi]!.gaps.find((g) => Math.abs(g[0] - (r.y + r.h)) < 0.5) ?? null;
  const gapAbove = (bi: number, r: Rect): Iv | null => blocks[bi]!.gaps.find((g) => Math.abs(g[1] - r.y) < 0.5) ?? null;
  const cut = (p: Iv, q: Iv): Iv | null => { const lo = Math.max(p[0], q[0]), hi = Math.min(p[1], q[1]); return hi - lo >= 2 ? [lo, hi] : null; };
  /** The intervals free through every block in `bis`, within `I`. */
  const through = (I: Iv, bis: number[]): Iv[] => {
    let cur: Iv[] = [I];
    for (const bi of bis) {
      const next: Iv[] = [];
      for (const c of cur) for (const g of blocks[bi]!.gaps) { const k = cut(c, g); if (k) next.push(k); }
      cur = next;
      if (!cur.length) break;
    }
    return cur;
  };
  const range = (a: number, b: number) => { const r: number[] = []; for (let i = a; i <= b; i++) r.push(i); return r; };
  const cy = (r: Rect) => r.y + r.h / 2, cx = (r: Rect) => r.x + r.w / 2;
  const gx = (g: number) => (gutters[g]!.x0 + gutters[g]!.x1) / 2;

  // ---- each wire's plan: sides, gutters and gaps. Gaps fill up: a crowded one costs more for the wires after it.
  const used = new Map<string, number>();
  const ivKey = (I: Iv) => `${Math.round(I[0])}:${Math.round(I[1])}`;
  const crowd = (I: Iv) => { const n = used.get(ivKey(I)) ?? 0, cap = Math.max(1, Math.floor((I[1] - I[0] - 2 * GAP_PAD) / MIN_TRACK) + 1); return n >= cap ? 5000 : n * 4; };
  const take = (legs: Leg[]) => { for (const l of legs) if (l.dir === 'h') used.set(ivKey(l.iv), (used.get(ivKey(l.iv)) ?? 0) + 1); };
  const sidePt = (r: Rect, s: Side): P => (s === 'right' ? { x: r.x + r.w, y: cy(r) } : s === 'left' ? { x: r.x, y: cy(r) } : s === 'top' ? { x: cx(r), y: r.y } : { x: cx(r), y: r.y + r.h });
  /** A shape's rough cost: its length with its tracks at their channels' middles, its bends, how crowded its gaps are. */
  const cost = (A: Rect, Bx: Rect, outS: Side, inS: Side, legs: Leg[]) => {
    const a = sidePt(A, outS), b = sidePt(Bx, inS);
    let cur = a, extra = 0;
    const pts: P[] = [a];
    for (const l of legs) {
      if (l.dir === 'v') cur = { x: gx(l.gutter), y: cur.y };
      else {
        // a horizontal run sits as near its ends' middle height as its gap allows
        const y = l.iv[1] - l.iv[0] < 2 * GAP_PAD ? (l.iv[0] + l.iv[1]) / 2 : Math.min(Math.max((a.y + b.y) / 2, l.iv[0] + GAP_PAD), l.iv[1] - GAP_PAD);
        cur = { x: cur.x, y };
        extra += crowd(l.iv);
      }
      pts.push(cur);
    }
    const last = legs[legs.length - 1];
    if (last) pts.push(last.dir === 'v' ? { x: cur.x, y: b.y } : { x: b.x, y: cur.y });
    pts.push(b);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
    return len + 30 * legs.length + extra;
  };
  const plans: Plan[] = [];
  for (const w of ws) {
    const A = boxes.get(w.from)!, Bx = boxes.get(w.to)!;
    const a = blockOf(w.from), b = blockOf(w.to);
    const cands: { cost: number; plan: Plan }[] = [];
    const add = (back: LaneRoute['back'], outS: Side, inS: Side, legs: Leg[], bias = 0) => cands.push({ cost: cost(A, Bx, outS, inS, legs) + bias, plan: { w, back, out: outS, in: inS, legs } });
    if (a < b) {
      if (b === a + 1) add(null, 'right', 'left', [{ dir: 'v', gutter: a + 1 }]);
      else for (const I of through([B.y0, B.y1], range(a + 1, b - 1))) add(null, 'right', 'left', [{ dir: 'v', gutter: a + 1 }, { dir: 'h', iv: I }, { dir: 'v', gutter: b }]);
    } else if (a > b) {
      // back: leave the caller's bottom or top (or its left side), reach the callee's bottom, top or right side
      const mid = range(b + 1, a - 1);
      const exits: { s: Side; g: Iv | null; back: LaneRoute['back']; bias: number }[] = [
        { s: 'bottom', g: gapBelow(a, A), back: 'under', bias: 0 }, { s: 'top', g: gapAbove(a, A), back: 'over', bias: 40 }];
      const entries: { s: Side; g: Iv | null }[] = [{ s: 'bottom', g: gapBelow(b, Bx) }, { s: 'top', g: gapAbove(b, Bx) }];
      for (const ex of exits) {
        if (!ex.g) continue;
        for (const en of entries) {
          const I0 = en.g && cut(ex.g, en.g);
          if (I0) for (const I of through(I0, mid)) add(ex.back, ex.s, en.s, [{ dir: 'h', iv: I }], ex.bias);
        }
        for (const I of through(ex.g, mid)) add(ex.back, ex.s, 'right', [{ dir: 'h', iv: I }, { dir: 'v', gutter: b + 1 }], ex.bias + 20);
      }
      for (const en of entries) if (en.g) for (const I of through(en.g, mid)) add('side', 'left', en.s, [{ dir: 'v', gutter: a }, { dir: 'h', iv: I }], 120);
      if (a === b + 1) add('side', 'left', 'right', [{ dir: 'v', gutter: a }], 160);
      else for (const I of through([B.y0, B.y1], mid)) add('side', 'left', 'right', [{ dir: 'v', gutter: a }, { dir: 'h', iv: I }, { dir: 'v', gutter: b + 1 }], 160);
    } else {
      // the same block: across the gap between them when they are next to each other, else round their right sides
      const down = Bx.y >= A.y + A.h - 0.5, up = Bx.y + Bx.h <= A.y + 0.5;
      const g = down ? gapBelow(a, A) : up ? gapAbove(a, A) : null;
      if (g && (down ? Math.abs(g[1] - Bx.y) < 0.5 : Math.abs(g[0] - (Bx.y + Bx.h)) < 0.5)) add(null, down ? 'bottom' : 'top', down ? 'top' : 'bottom', [{ dir: 'h', iv: g }]);
      add(null, 'right', 'right', [{ dir: 'v', gutter: a + 1 }], 200);
    }
    if (!cands.length) add(a > b ? 'side' : null, 'right', a === b ? 'right' : 'left', [{ dir: 'v', gutter: Math.min(a, b) + 1 }]);
    // (stable: equal costs keep the order they were offered in)
    const best = cands.reduce((p, q) => (q.cost < p.cost - 1e-9 ? q : p)).plan;
    take(best.legs);
    plans.push(best);
  }

  // ---- coordinates: one per leg, one per port
  const legVal = plans.map((p) => p.legs.map((l) => (l.dir === 'v' ? gx(l.gutter) : (l.iv[0] + l.iv[1]) / 2)));
  const sideKey = (box: string, s: Side) => `${box}|${s}`;
  const sides = new Map<string, { plan: number; end: 'out' | 'in' }[]>();
  plans.forEach((p, pi) => {
    for (const [end, box, s] of [['out', p.w.from, p.out], ['in', p.w.to, p.in]] as const) {
      const k = sideKey(box, s);
      (sides.get(k) ?? sides.set(k, []).get(k)!).push({ plan: pi, end });
    }
  });
  const portAt = new Map<string, number>();   // `${plan}:${end}` → where along its side (y on a left or right side, x on a top or bottom)
  const portPt = (pi: number, end: 'out' | 'in'): P => {
    const p = plans[pi]!, s = end === 'out' ? p.out : p.in, r = boxes.get(end === 'out' ? p.w.from : p.w.to)!;
    const v = portAt.get(`${pi}:${end}`) ?? (s === 'left' || s === 'right' ? cy(r) : cx(r));
    if (s === 'right') return { x: r.x + r.w + END, y: v };
    if (s === 'left') return { x: r.x - END, y: v };
    if (s === 'bottom') return { x: v, y: r.y + r.h + END };
    return { x: v, y: r.y - END };
  };
  const cornersOf = (pi: number): P[] => {
    const p = plans[pi]!, a = portPt(pi, 'out'), b = portPt(pi, 'in');
    const pts: P[] = [a];
    let cur = a;
    p.legs.forEach((l, li) => { const v = legVal[pi]![li]!; cur = l.dir === 'v' ? { x: v, y: cur.y } : { x: cur.x, y: v }; pts.push(cur); });
    const last = p.legs[p.legs.length - 1];
    if (last) pts.push(last.dir === 'v' ? { x: cur.x, y: b.y } : { x: b.x, y: cur.y });
    pts.push(b);
    return pts;
  };
  const placePorts = () => {
    for (const [k, list] of sides) {
      const [box, s] = k.split('|') as [string, Side];
      const r = boxes.get(box)!, horiz = s === 'left' || s === 'right';
      const len = horiz ? r.h : r.w, c = horiz ? cy(r) : cx(r);
      // each end in the order of where it heads next, so that neighbours don't cross
      const next = (x: { plan: number; end: 'out' | 'in' }) => {
        const pts = cornersOf(x.plan), q = x.end === 'out' ? pts[2] ?? pts[pts.length - 1]! : pts[pts.length - 3] ?? pts[0]!;
        return horiz ? q.y : q.x;
      };
      const keyed = list.map((x) => ({ x, k: next(x) })).sort((p, q) => p.k - q.k || byKey(plans[p.x.plan]!.w.key, plans[q.x.plan]!.w.key) || byKey(p.x.end, q.x.end));
      const n = keyed.length, step = 2 * GRID * Math.max(1, Math.floor(Math.min(PORT_MAX, len / (n + 1)) / (2 * GRID)));
      // onto the grid: right and bottom sides on even lines, left and top on odd ones
      const odd = s === 'left' || s === 'top' ? GRID : 0, first = c - ((n - 1) / 2) * step;
      const at0 = Math.round((first - odd) / (2 * GRID)) * 2 * GRID + odd;
      keyed.forEach(({ x }, i) => portAt.set(`${x.plan}:${x.end}`, at0 + i * step));
    }
  };
  /** Leg `li` of plan `pi` as a run along its axis, with where its neighbours turn off it (and which way). */
  const runOf = (pi: number, li: number): Run => {
    const pts = cornersOf(pi), s = pts[li + 1]!, e = pts[li + 2]!, before = pts[li], after = pts[li + 3];
    const vert = plans[pi]!.legs[li]!.dir === 'v';
    const along = (q: P) => (vert ? q.y : q.x), across = (q: P) => (vert ? q.x : q.y);
    const ends: Run['ends'] = [];
    if (before) ends.push({ at: along(s), dir: across(before) - across(s) < 0 ? -1 : 1 });
    if (after) ends.push({ at: along(e), dir: across(after) - across(e) < 0 ? -1 : 1 });
    return { lo: Math.min(along(s), along(e)), hi: Math.max(along(s), along(e)), ends };
  };
  /** Crossings between runs i and j when i sits at the lower coordinate (left of, or above, j). */
  const pairCost = (ri: Run, rj: Run) => {
    let c = 0;
    for (const e of rj.ends) if (e.dir < 0 && e.at > ri.lo + 0.5 && e.at < ri.hi - 0.5) c++;
    for (const e of ri.ends) if (e.dir > 0 && e.at > rj.lo + 0.5 && e.at < rj.hi - 0.5) c++;
    // both turn toward each other at one place: they would overlap between the two tracks
    for (const e of ri.ends) for (const f of rj.ends) if (Math.abs(e.at - f.at) < 1.5 && e.dir > 0 && f.dir < 0) c += 100;
    return c;
  };
  const bestOrder = (n: number, pc: (i: number, j: number) => number, start: number[]) => {
    const total = (ord: number[]) => { let c = 0; for (let x = 0; x < ord.length; x++) for (let y = x + 1; y < ord.length; y++) c += pc(ord[x]!, ord[y]!); return c; };
    let ord = [...start], best = total(ord);
    for (let round = 0; round < 16 && best > 0 && n > 1; round++) {
      let improved = false;
      for (let i = 0; i < ord.length; i++) for (let j = 0; j < ord.length; j++) {
        if (i === j) continue;
        const t = [...ord]; const [x] = t.splice(i, 1); t.splice(j, 0, x!);
        const c = total(t);
        if (c < best) { ord = t; best = c; improved = true; }
      }
      if (!improved) break;
    }
    return ord;
  };
  /** Tracks in order, each within its own interval, as evenly spaced as they fit (at most S apart). */
  const place = (ivs: Iv[]): number[] => {
    const n = ivs.length;
    const lo = Math.max(...ivs.map((v) => v[0])), hi = Math.min(...ivs.map((v) => v[1]));
    if (hi >= lo && (n === 1 || (hi - lo) / (n + 1) >= MIN_TRACK * 0.75)) {
      const s = Math.min(S, (hi - lo) / (n + 1)), m = (lo + hi) / 2;
      return ivs.map((_, k) => m + (k - (n - 1) / 2) * s);
    }
    // intervals that differ (or a crowded one): each near its own middle, pushed apart in order, as far as they can be
    for (let s = S; s >= 2; s--) {
      const y = ivs.map((v) => (v[0] + v[1]) / 2);
      for (let k = 1; k < n; k++) y[k] = Math.max(y[k]!, y[k - 1]! + s);
      for (let k = n - 1; k >= 0; k--) { y[k] = Math.min(y[k]!, ivs[k]![1]); if (k < n - 1) y[k] = Math.min(y[k]!, y[k + 1]! - s); }
      if (y.every((v, k) => v >= ivs[k]![0] - 0.01)) return y;
    }
    return ivs.map((v, k) => (v[0] + v[1]) / 2 + k * 2);
  };
  // the channels: each gutter's vertical runs; horizontal runs whose gaps overlap and whose spans along x could meet
  const vGroups = new Map<number, Ref[]>();
  const hRefs: Ref[] = [];
  plans.forEach((p, pi) => p.legs.forEach((l, li) => {
    if (l.dir === 'v') (vGroups.get(l.gutter) ?? vGroups.set(l.gutter, []).get(l.gutter)!).push({ plan: pi, leg: li });
    else hRefs.push({ plan: pi, leg: li });
  }));
  const hIv = (r: Ref) => (plans[r.plan]!.legs[r.leg] as { iv: Iv }).iv;
  const padIv = (I: Iv): Iv => (I[1] - I[0] > 2 * GAP_PAD + 2 ? [I[0] + GAP_PAD, I[1] - GAP_PAD] : [(I[0] + I[1]) / 2, (I[0] + I[1]) / 2]);
  const gutterIv = (r: Ref): Iv => {
    const g = gutters[(plans[r.plan]!.legs[r.leg] as { gutter: number }).gutter]!;
    return g.x1 - g.x0 > 2 * PAD + 2 ? [g.x0 + PAD, g.x1 - PAD] : [(g.x0 + g.x1) / 2, (g.x0 + g.x1) / 2];
  };
  const hGroups = (): Ref[][] => {
    // (a run's span along x moves with the gutters' tracks, so the grouping is redone each round)
    const parent = hRefs.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i]!; return i; };
    const span = hRefs.map((r) => runOf(r.plan, r.leg));
    for (let i = 0; i < hRefs.length; i++) for (let j = i + 1; j < hRefs.length; j++) {
      const p = hIv(hRefs[i]!), q = hIv(hRefs[j]!);
      if (Math.min(p[1], q[1]) - Math.max(p[0], q[0]) <= 0) continue;
      if (Math.min(span[i]!.hi, span[j]!.hi) - Math.max(span[i]!.lo, span[j]!.lo) < -2 * S) continue;
      parent[find(i)] = find(j);
    }
    const by = new Map<number, Ref[]>();
    hRefs.forEach((r, i) => { const k = find(i); (by.get(k) ?? by.set(k, []).get(k)!).push(r); });
    return [...by.values()];
  };
  const assign = (members: Ref[], ivOf: (r: Ref) => Iv) => {
    if (!members.length) return;
    const runs = members.map((m) => runOf(m.plan, m.leg));
    const ivs = members.map(ivOf);
    const start = members.map((_, i) => i).sort((x, y) => {
      const a = members[x]!, b = members[y]!;
      return legVal[a.plan]![a.leg]! - legVal[b.plan]![b.leg]! || byKey(plans[a.plan]!.w.key, plans[b.plan]!.w.key) || a.leg - b.leg;
    });
    // an order with a track above (at a lower coordinate than) one whose interval lies lower or ends sooner may not
    // fit: it costs most
    const misfit = (i: number, j: number) => (ivs[i]![0] > ivs[j]![1] || (ivs[i]![1] > ivs[j]![1] + 1 && ivs[i]![0] >= ivs[j]![0] - 1) ? 1000 : 0);
    const ord = bestOrder(members.length, (i, j) => pairCost(runs[i]!, runs[j]!) + misfit(i, j), start);
    const vals = place(ord.map((i) => ivs[i]!));
    ord.forEach((mi, k) => { const m = members[mi]!; legVal[m.plan]![m.leg] = vals[k]!; });
  };
  const vOrder = [...vGroups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
  for (let round = 0; round < 4; round++) {
    placePorts();
    for (const g of vOrder) assign(g, gutterIv);
    for (const g of hGroups()) assign(g, (r) => padIv(hIv(r)));
  }
  placePorts();
  plans.forEach((p, pi) => {
    const c = cornersOf(pi).filter((q, i, a) => i === 0 || Math.abs(q.x - a[i - 1]!.x) > 0.01 || Math.abs(q.y - a[i - 1]!.y) > 0.01);
    out.set(p.w.key, { path: new Path(roundCorners(c, Math.min(8, S * 0.6))), corners: c, back: p.back });
  });
  return out;
}

type Seg = { key: string; vert: boolean; c: number; lo: number; hi: number };
const segsOf = (routes: Map<string, { corners: P[] }>): Seg[] => {
  const segs: Seg[] = [];
  for (const [key, r] of routes) {
    const pts = r.corners;
    for (let i = 1; i < pts.length; i++) {
      const s = pts[i - 1]!, e = pts[i]!;
      if (Math.abs(s.x - e.x) < 0.01) segs.push({ key, vert: true, c: s.x, lo: Math.min(s.y, e.y), hi: Math.max(s.y, e.y) });
      else if (Math.abs(s.y - e.y) < 0.01) segs.push({ key, vert: false, c: s.y, lo: Math.min(s.x, e.x), hi: Math.max(s.x, e.x) });
    }
  }
  return segs;
};

/** Runs two routes share: axis-aligned segments of different wires on parallel lines closer than `near` px that
 *  overlap by more than `tol` px along them. */
export function sharedRuns(routes: Map<string, { corners: P[] }>, tol = 1, near = 0.5): { a: string; b: string; at: P }[] {
  const segs = segsOf(routes);
  const out: { a: string; b: string; at: P }[] = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const p = segs[i]!, q = segs[j]!;
    if (p.key === q.key || p.vert !== q.vert || Math.abs(p.c - q.c) > near) continue;
    const ov = Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo);
    if (ov > tol) out.push({ a: p.key, b: q.key, at: p.vert ? { x: p.c, y: Math.max(p.lo, q.lo) } : { x: Math.max(p.lo, q.lo), y: p.c } });
  }
  return out;
}

/** How many times routes of different wires cross (proper crossings of their axis-aligned runs). */
export function crossingsOf(routes: Map<string, { corners: P[] }>): number {
  const segs = segsOf(routes);
  let n = 0;
  for (const v of segs) if (v.vert) for (const h of segs) if (!h.vert && h.key !== v.key && v.c > h.lo + 0.5 && v.c < h.hi - 0.5 && h.c > v.lo + 0.5 && h.c < v.hi - 0.5) n++;
  return n;
}

/** A path part way from `a` to `b` (k = 0 … 1): both resampled at the same fractions of their length, point by point.
 *  How a wire glides from its shared route to its own track and back (a pure function of the two routes and k). */
export function lerpPath(a: Path, b: Path, k: number, n = 72): Path {
  if (k <= 0) return a;
  if (k >= 1 || !a.pts.length) return b;
  if (!b.pts.length) return a;
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) { const p = a.at(i / n), q = b.at(i / n); pts.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k }); }
  return new Path(pts);
}
